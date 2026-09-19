import { describe, expect, it } from "vitest";
import type { DataExportRecord } from "../domain/types.js";
import { DataExportRetentionWorker } from "./data-export-retention-worker.js";

const EXPORT_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const EXPORT_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const EXPORT_C = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

class FakeExpiryStore {
  readonly expiredCalls: string[] = [];
  readonly markedDeletedCalls: string[] = [];
  readonly deletedObjects: string[] = [];
  constructor(
    readonly expiredCandidates: DataExportRecord[],
    readonly dueCandidates: DataExportRecord[],
    readonly failExpireIds: ReadonlySet<string> = new Set(),
    readonly storageFailKeys: ReadonlySet<string> = new Set()
  ) {}

  listExpiredDataExports(_before: string, _limit: number): DataExportRecord[] {
    return this.expiredCandidates;
  }

  expireDataExport(id: string, _at: string): boolean {
    this.expiredCalls.push(id);
    return !this.failExpireIds.has(id);
  }

  listDataExportsDueForObjectDeletion(_before: string, _limit: number): DataExportRecord[] {
    return this.dueCandidates;
  }

  markDataExportObjectDeleted(id: string, _at: string): boolean {
    this.markedDeletedCalls.push(id);
    return true;
  }
}

class FakeStorage {
  constructor(readonly failKeys: ReadonlySet<string> = new Set(), readonly delayMs = 0) {}

  async delete(objectKey: string): Promise<void> {
    if (this.delayMs > 0) await new Promise((resolve) => setTimeout(resolve, this.delayMs));
    if (this.failKeys.has(objectKey)) throw new Error(`delete failed: ${objectKey}`);
  }
}

function record(overrides: Partial<DataExportRecord> & Pick<DataExportRecord, "id">): DataExportRecord {
  return {
    accountId: "user",
    state: "ready",
    objectKey: `export/${overrides.id}.tar.gz`,
    sizeBytes: 100,
    sha256: "sha",
    createdAt: "2026-09-10T00:00:00.000Z",
    readyAt: null,
    expiresAt: null,
    deletedAt: null,
    objectDeletedAt: null,
    ...overrides
  };
}

const now = new Date("2026-09-16T12:00:00.000Z");

describe("DataExportRetentionWorker", () => {
  it("expires ready exports past their expires-at, then deletes stale objects", async () => {
    const a = record({ id: EXPORT_A, expiresAt: "2026-09-16T11:00:00.000Z", readyAt: "2026-09-09T11:00:00.000Z" });
    const b = record({ id: EXPORT_B, expiresAt: "2026-09-16T11:00:00.000Z", deletedAt: "2026-09-16T11:00:00.000Z" });
    const store = new FakeExpiryStore([a], [b]);
    const storage = new FakeStorage();
    const worker = new DataExportRetentionWorker(store, storage);

    const result = await worker.sweep(now);

    expect(result).toEqual({ expired: 1, deleted: 1, failures: 0, batches: 2, busy: false });
    expect(store.expiredCalls).toEqual([EXPORT_A]);
    expect(store.markedDeletedCalls).toEqual([EXPORT_B]);
  });

  it("skips rows already expired by another writer and counts storage failures for retry", async () => {
    const a = record({ id: EXPORT_A, expiresAt: "2026-09-16T11:00:00.000Z" });
    const b = record({ id: EXPORT_B, expiresAt: "2026-09-16T11:00:00.000Z", deletedAt: "2026-09-16T11:00:00.000Z" });
    const store = new FakeExpiryStore([a], [b], new Set([EXPORT_A]), new Set([`export/${EXPORT_B}.tar.gz`]));
    const storage = new FakeStorage(new Set([`export/${EXPORT_B}.tar.gz`]));
    const worker = new DataExportRetentionWorker(store, storage);

    const result = await worker.sweep(now);

    expect(result).toEqual({ expired: 0, deleted: 0, failures: 1, batches: 2, busy: false });
    expect(store.markedDeletedCalls).toEqual([]);
  });

  it("leaves active exports untouched and reports busy while a sweep is in flight", async () => {
    const a = record({ id: EXPORT_A, expiresAt: "2026-09-16T13:00:00.000Z" });
    const b = record({ id: EXPORT_B, expiresAt: "2026-09-16T11:00:00.000Z", deletedAt: "2026-09-16T11:00:00.000Z" });
    const store = new FakeExpiryStore([a], [b]);
    const storage = new FakeStorage(new Set(), 50);
    const worker = new DataExportRetentionWorker(store, storage);

    const first = worker.sweep(now);
    const second = await worker.sweep(new Date("2026-09-16T12:05:00.000Z"));
    expect(second.busy).toBe(true);
    await first;
    expect(store.expiredCalls).toEqual([EXPORT_A]);
  });

  it("rejects an oversized batch size and a non-positive one", () => {
    const store = new FakeExpiryStore([], []);
    const storage = new FakeStorage();
    expect(() => new DataExportRetentionWorker(store, storage, { batchSize: 0 })).toThrow();
    expect(() => new DataExportRetentionWorker(store, storage, { batchSize: 1001 })).toThrow(/no greater than 1000/);
  });
});