import type { Store } from "../domain/store.js";
import type { DataExportRecord } from "../domain/types.js";
import type { StorageProvider } from "../infrastructure/storage.js";

const DEFAULT_BATCH_SIZE = 100;
const MAX_BATCH_SIZE = 1_000;

export interface DataExportRetentionSweepResult {
  expired: number;
  deleted: number;
  failures: number;
  batches: number;
  busy: boolean;
}

export interface DataExportRetentionWorkerOptions {
  batchSize?: number;
}

export type DataExportRetentionStore = Pick<Store,
  | "listExpiredDataExports"
  | "expireDataExport"
  | "listDataExportsDueForObjectDeletion"
  | "markDataExportObjectDeleted"
>;

export type DataExportRetentionStorage = Pick<StorageProvider, "delete">;

function boundedPositiveInteger(value: number, maximum: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new Error(`${label} must be a positive safe integer no greater than ${maximum}`);
  }
  return value;
}

function validIsoTimestamp(value: string, label: string): string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    throw new Error(`${label} must be an ISO 8601 timestamp`);
  }
  return value;
}

/**
 * Implements spec §14.3 retention defaults for export artifacts: a ready
 * export expires seven days after `ready_at`; from then on the storage object
 * must be deleted within 24 hours. One sweep:
 *
 * 1. Expires `ready` records whose `expires_at` is already in the past
 *    (state -> `expired`, `deleted_at` set). This is idempotent thanks to a
 *    writer-time state guard.
 * 2. Deletes the storage object for `expired` records whose object was not
 *    deleted yet. The sweep runs every 10 minutes, so deletion lands well
 *    within the 24-hour budget. Deletion is idempotent: on failure the row
 *    keeps `object_deleted_at IS NULL` and is retried on the next sweep.
 */
export class DataExportRetentionWorker {
  readonly #store: DataExportRetentionStore;
  readonly #storage: DataExportRetentionStorage;
  readonly #batchSize: number;
  #sweeping = false;

  constructor(
    store: DataExportRetentionStore,
    storage: DataExportRetentionStorage,
    options: DataExportRetentionWorkerOptions = {}
  ) {
    this.#store = store;
    this.#storage = storage;
    this.#batchSize = boundedPositiveInteger(
      options.batchSize ?? DEFAULT_BATCH_SIZE,
      MAX_BATCH_SIZE,
      "Data export retention batch size"
    );
  }

  async sweep(now: Date): Promise<DataExportRetentionSweepResult> {
    if (this.#sweeping) {
      return { expired: 0, deleted: 0, failures: 0, batches: 0, busy: true };
    }
    this.#sweeping = true;
    try {
      const observed = validIsoTimestamp(now.toISOString(), "Data export retention clock");
      const result: DataExportRetentionSweepResult = {
        expired: 0,
        deleted: 0,
        failures: 0,
        batches: 0,
        busy: false
      };

      for (let batch = 0; batch < 2; batch += 1) {
        const expired: DataExportRecord[] = this.#store.listExpiredDataExports(observed, this.#batchSize);
        result.batches += 1;
        if (expired.length > this.#batchSize) {
          throw new Error("Data export retention Store exceeded the requested batch size");
        }
        for (const record of expired) {
          if (this.#store.expireDataExport(record.id, observed)) {
            result.expired += 1;
          }
        }
        if (expired.length < this.#batchSize) break;
      }

      for (let batch = 0; batch < 2; batch += 1) {
        const due: DataExportRecord[] = this.#store.listDataExportsDueForObjectDeletion(
          observed,
          this.#batchSize
        );
        result.batches += 1;
        if (due.length > this.#batchSize) {
          throw new Error("Data export retention Store exceeded the requested batch size");
        }
        for (const record of due) {
          try {
            await this.#storage.delete(record.objectKey);
            if (this.#store.markDataExportObjectDeleted(record.id, observed)) {
              result.deleted += 1;
            }
          } catch {
            result.failures += 1;
          }
        }
        if (due.length < this.#batchSize) break;
      }

      return result;
    } finally {
      this.#sweeping = false;
    }
  }
}