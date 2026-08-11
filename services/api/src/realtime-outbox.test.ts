import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ServerRealtimeMessage } from "@luxora/protocol";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import type { StoredEvent } from "./domain/types.js";
import { SqliteStore } from "./infrastructure/sqlite-store.js";
import type { EventPublisher } from "./services/event-publisher.js";
import {
  RealtimeOutboxPublisher,
  type RealtimeOutboxFailure
} from "./services/realtime-outbox-publisher.js";

const AT = "2026-08-03T12:00:00.000Z";

class RecordingPublisher implements EventPublisher {
  readonly events: StoredEvent[] = [];

  constructor(private failuresRemaining = 0) {}

  publish(events: StoredEvent[]): void {
    if (this.failuresRemaining > 0) {
      this.failuresRemaining -= 1;
      throw new Error("injected local publisher failure");
    }
    this.events.push(...events);
  }

  publishEphemeral(
    _userIds: string[],
    _message: ServerRealtimeMessage,
    _excludeConnectionId?: string
  ): void {}
}

function createUser(store: SqliteStore, id = randomUUID()): string {
  store.createUser({
    id,
    username: `user_${id.slice(0, 8)}`,
    usernameNormalized: `user_${id.slice(0, 8)}`,
    displayName: "Outbox Test",
    passwordHash: "test-hash",
    createdAt: AT
  });
  return id;
}

function appendTestEvent(store: SqliteStore, audienceUserId: string): StoredEvent {
  return store.appendEvent(audienceUserId, {
    type: "relationship.block.changed",
    audience: "actor_account",
    accountId: randomUUID(),
    blocked: true,
    changedAt: AT
  }, AT);
}

function appendInvalidation(store: SqliteStore, audienceUserId: string): StoredEvent {
  return store.appendEvent(audienceUserId, {
    type: "sync.invalidated",
    audience: "account_projection",
    accountId: audienceUserId,
    reason: "profile_updated",
    changedAt: AT
  }, AT);
}

function temporaryDatabase(): { path: string; remove(): void } {
  const directory = mkdtempSync(join(tmpdir(), "luxora-realtime-outbox-"));
  return {
    path: join(directory, "api.sqlite"),
    remove: () => rmSync(directory, { recursive: true, force: true })
  };
}

describe("transactional realtime outbox", () => {
  it("suppresses invalidation emission at the store boundary without affecting domain events", () => {
    const database = temporaryDatabase();
    const store = new SqliteStore(database.path, undefined, Date.now, false);
    try {
      const userId = createUser(store);
      const ordinary = appendTestEvent(store, userId);
      expect(store.getLatestSequence()).toBe(ordinary.sequence);
      expect(() => appendInvalidation(store, userId)).toThrow(
        "sync.invalidated emission is disabled"
      );
      expect(store.getLatestSequence()).toBe(ordinary.sequence);

      const visibleAttachmentId = randomUUID();
      store.createAttachment({
        id: visibleAttachmentId,
        ownerUserId: userId,
        kind: "file",
        fileName: "direct-delete.bin",
        declaredMimeType: "application/octet-stream",
        detectedMimeType: "application/octet-stream",
        sizeBytes: 1,
        sha256: "c".repeat(64),
        metadata: {},
        storageProvider: "local",
        storageKey: `attachments/${visibleAttachmentId}`,
        safetyStatus: "unscanned",
        metadataTrust: "client_declared",
        createdAt: AT
      });
      expect(store.deleteAttachmentRecord(
        visibleAttachmentId,
        "2026-08-03T12:01:00.000Z"
      )).toEqual([]);
      expect(store.findAttachmentRecord(visibleAttachmentId)).toBeNull();
      expect(store.getLatestSequence()).toBe(ordinary.sequence);

      const orphanId = randomUUID();
      store.createAttachment({
        id: orphanId,
        ownerUserId: userId,
        kind: "file",
        fileName: "orphan.bin",
        declaredMimeType: "application/octet-stream",
        detectedMimeType: "application/octet-stream",
        sizeBytes: 1,
        sha256: "d".repeat(64),
        metadata: {},
        storageProvider: "local",
        storageKey: `attachments/${orphanId}`,
        safetyStatus: "unscanned",
        metadataTrust: "client_declared",
        createdAt: "2026-08-03T10:00:00.000Z"
      });
      const claimed = store.claimOrphanAttachments(
        "local",
        "2026-08-03T11:00:00.000Z",
        "2026-08-03T11:00:00.000Z",
        "2026-08-03T12:02:00.000Z",
        100
      );
      expect(claimed.attachments.map(({ id }) => id)).toEqual([orphanId]);
      expect(claimed.invalidations).toEqual([]);
      expect(store.getLatestSequence()).toBe(ordinary.sequence);
    } finally {
      store.close();
      database.remove();
    }
  });

  it("acknowledges suppressed historical invalidations while publishing and replaying ordinary events", () => {
    const database = temporaryDatabase();
    const store = new SqliteStore(database.path);
    try {
      const userId = createUser(store);
      const invalidation = appendInvalidation(store, userId);
      const ordinary = appendTestEvent(store, userId);
      const delegate = new RecordingPublisher();
      const publisher = new RealtimeOutboxPublisher(store, delegate, {
        workerId: "sync-invalidation-disabled-worker",
        clock: () => new Date(AT),
        shouldPublish: (event) => event.event.type !== "sync.invalidated"
      });

      expect(publisher.drainDue()).toEqual({
        claimed: 2,
        published: 2,
        retried: 0,
        failed: 0
      });
      expect(delegate.events.map(({ sequence }) => sequence)).toEqual([ordinary.sequence]);
      expect(store.claimRealtimeOutbox(
        "second-worker",
        AT,
        "2026-08-03T12:00:30.000Z",
        10
      )).toEqual([]);
      expect(store.replayEvents(
        userId,
        0,
        ordinary.sequence,
        10,
        false
      )).toEqual([ordinary]);
      expect(store.replayEvents(
        userId,
        0,
        ordinary.sequence,
        10,
        true
      ).map(({ sequence }) => sequence)).toEqual([
        invalidation.sequence,
        ordinary.sequence
      ]);
      publisher.close();
    } finally {
      store.close();
      database.remove();
    }
  });

  it("commits and rolls back domain state, event log, and outbox as one SQLite transaction", () => {
    const database = temporaryDatabase();
    const store = new SqliteStore(database.path);
    const rolledBackUserId = randomUUID();
    try {
      expect(() => store.transaction(() => {
        createUser(store, rolledBackUserId);
        appendTestEvent(store, rolledBackUserId);
        throw new Error("abort outer domain transaction");
      })).toThrow("abort outer domain transaction");

      expect(store.findUserById(rolledBackUserId)).toBeNull();
      expect(store.getLatestSequence()).toBe(0);
      expect(store.claimRealtimeOutbox("worker-a", AT, "2026-08-03T12:00:30.000Z", 10)).toEqual([]);

      const committedUserId = createUser(store);
      const committed = store.transaction(() => appendTestEvent(store, committedUserId));
      const claimed = store.claimRealtimeOutbox(
        "worker-a",
        AT,
        "2026-08-03T12:00:30.000Z",
        10
      );
      expect(claimed).toEqual([{ ok: true, event: committed, attemptCount: 1 }]);
      expect(store.markRealtimeOutboxPublished(committed.sequence, "worker-a", AT)).toBe(true);
      expect(store.markRealtimeOutboxPublished(committed.sequence, "worker-a", AT)).toBe(false);
    } finally {
      store.close();
      database.remove();
    }
  });

  it("enqueues every appendChatEvent audience inside one outer transaction", () => {
    const database = temporaryDatabase();
    const store = new SqliteStore(database.path);
    try {
      const ownerId = createUser(store);
      const memberId = createUser(store);
      const chatId = randomUUID();
      store.createChat({
        id: chatId,
        kind: "group",
        title: "Atomic audience batch",
        directKey: null,
        createdBy: ownerId,
        createdAt: AT
      });
      store.addChatMember(chatId, ownerId, "owner", AT);
      store.addChatMember(chatId, memberId, "member", AT);
      const chat = store.getChatForUser(chatId, ownerId);
      if (chat === null) throw new Error("Expected the test chat projection");

      expect(() => store.transaction(() => {
        expect(store.appendChatEvent(chatId, { type: "chat.created", chat }, AT)).toHaveLength(2);
        throw new Error("abort audience batch");
      })).toThrow("abort audience batch");
      expect(store.getLatestSequence()).toBe(0);
      expect(store.claimRealtimeOutbox("worker-a", AT, "2026-08-03T12:00:30.000Z", 10)).toEqual([]);

      const committed = store.appendChatEvent(chatId, { type: "chat.created", chat }, AT);
      expect(committed).toHaveLength(2);
      expect(store.claimRealtimeOutbox(
        "worker-a",
        AT,
        "2026-08-03T12:00:30.000Z",
        10
      )).toEqual(committed.map((event) => ({ ok: true, event, attemptCount: 1 })));
    } finally {
      store.close();
      database.remove();
    }
  });

  it("keeps the committed sequence high-water monotonic when the newest event row is deleted", () => {
    const database = temporaryDatabase();
    const store = new SqliteStore(database.path);
    try {
      const userId = createUser(store);
      const first = appendTestEvent(store, userId);
      const newest = appendTestEvent(store, userId);
      expect(store.getLatestSequence()).toBe(newest.sequence);

      const inspection = new Database(database.path);
      inspection.pragma("foreign_keys = ON");
      inspection.prepare("DELETE FROM realtime_events WHERE sequence = ?").run(newest.sequence);
      inspection.close();

      expect(store.getLatestSequence()).toBe(newest.sequence);
      expect(store.replayEvents(userId, first.sequence, newest.sequence, 100)).toEqual([]);
      const next = appendTestEvent(store, userId);
      expect(next.sequence).toBeGreaterThan(newest.sequence);
      expect(store.getLatestSequence()).toBe(next.sequence);
    } finally {
      store.close();
      database.remove();
    }
  });

  it("atomically invalidates a directly removed visible attachment without moving the head backward", () => {
    const database = temporaryDatabase();
    const store = new SqliteStore(database.path);
    try {
      const userId = createUser(store);
      const attachmentId = randomUUID();
      store.createAttachment({
        id: attachmentId,
        ownerUserId: userId,
        kind: "image",
        fileName: "orphan.png",
        declaredMimeType: "image/png",
        detectedMimeType: "image/png",
        sizeBytes: 68,
        sha256: "a".repeat(64),
        metadata: { width: 1, height: 1 },
        storageProvider: "local",
        storageKey: `attachments/${attachmentId}`,
        safetyStatus: "unscanned",
        metadataTrust: "client_declared",
        createdAt: AT
      });
      const attachment = store.getAttachment(attachmentId);
      if (attachment === null) throw new Error("Expected visible attachment");
      const stored = store.appendEvent(userId, {
        type: "attachment.stored",
        attachment
      }, AT);

      expect(() => store.transaction(() => {
        expect(store.deleteAttachmentRecord(
          attachmentId,
          "2026-08-03T12:01:00.000Z"
        )).toHaveLength(1);
        throw new Error("abort attachment removal");
      })).toThrow("abort attachment removal");
      expect(store.findAttachmentRecord(attachmentId)).not.toBeNull();
      expect(store.getLatestSequence()).toBe(stored.sequence);

      const invalidations = store.deleteAttachmentRecord(
        attachmentId,
        "2026-08-03T12:02:00.000Z"
      );
      expect(invalidations).toHaveLength(1);
      expect(invalidations[0]).toMatchObject({
        audienceUserId: userId,
        event: {
          type: "sync.invalidated",
          audience: "account_projection",
          accountId: userId,
          reason: "attachment_removed"
        }
      });
      expect(invalidations[0]!.sequence).toBeGreaterThan(stored.sequence);
      expect(store.getLatestSequence()).toBe(invalidations[0]!.sequence);
      expect(store.findAttachmentRecord(attachmentId)).toBeNull();
      expect(store.deleteAttachmentRecord(
        attachmentId,
        "2026-08-03T12:03:00.000Z"
      )).toEqual([]);
      expect(store.getLatestSequence()).toBe(invalidations[0]!.sequence);
    } finally {
      store.close();
      database.remove();
    }
  });

  it("invalidates both first and stale orphan claims for restart-safe reconciliation", () => {
    const database = temporaryDatabase();
    const store = new SqliteStore(database.path);
    try {
      const userId = createUser(store);
      const attachmentId = randomUUID();
      store.createAttachment({
        id: attachmentId,
        ownerUserId: userId,
        kind: "file",
        fileName: "stale-orphan.bin",
        declaredMimeType: "application/octet-stream",
        detectedMimeType: "application/octet-stream",
        sizeBytes: 1,
        sha256: "b".repeat(64),
        metadata: {},
        storageProvider: "local",
        storageKey: `attachments/${attachmentId}`,
        safetyStatus: "unscanned",
        metadataTrust: "client_declared",
        createdAt: "2026-08-03T10:00:00.000Z"
      });

      const first = store.claimOrphanAttachments(
        "local",
        "2026-08-03T11:00:00.000Z",
        "2026-08-03T11:00:00.000Z",
        "2026-08-03T12:00:00.000Z",
        100
      );
      expect(first.attachments.map(({ id }) => id)).toEqual([attachmentId]);
      expect(first.invalidations.map(({ event }) => event)).toEqual([
        expect.objectContaining({
          type: "sync.invalidated",
          accountId: userId,
          reason: "attachment_removed"
        })
      ]);
      const firstHead = store.getLatestSequence();
      expect(store.claimOrphanAttachments(
        "local",
        "2026-08-03T13:00:00.000Z",
        "2026-08-03T11:30:00.000Z",
        "2026-08-03T12:01:00.000Z",
        100
      )).toEqual({ attachments: [], invalidations: [] });
      expect(store.getLatestSequence()).toBe(firstHead);

      const stale = store.claimOrphanAttachments(
        "local",
        "2026-08-03T13:00:00.000Z",
        "2026-08-03T12:00:00.000Z",
        "2026-08-03T13:01:00.000Z",
        100
      );
      expect(stale.attachments.map(({ id }) => id)).toEqual([attachmentId]);
      expect(stale.invalidations.map(({ event }) => event)).toEqual([
        expect.objectContaining({
          type: "sync.invalidated",
          accountId: userId,
          reason: "attachment_removed"
        })
      ]);
      expect(store.getLatestSequence()).toBeGreaterThan(firstHead);
      expect(store.findAttachmentRecord(attachmentId)).toBeNull();
    } finally {
      store.close();
      database.remove();
    }
  });

  it("makes a newly committed event immediately claimable despite a producer clock one day ahead", () => {
    const database = temporaryDatabase();
    const store = new SqliteStore(database.path);
    try {
      const userId = createUser(store);
      const producerTime = "2026-08-04T12:00:00.000Z";
      const committed = store.appendEvent(userId, {
        type: "relationship.block.changed",
        audience: "actor_account",
        accountId: randomUUID(),
        blocked: true,
        changedAt: producerTime
      }, producerTime);
      expect(store.claimRealtimeOutbox(
        "base-time-worker",
        AT,
        "2026-08-03T12:00:30.000Z",
        1
      )).toEqual([{ ok: true, event: committed, attemptCount: 1 }]);
    } finally {
      store.close();
      database.remove();
    }
  });

  it("drains a pre-crash committed event on startup and keeps it available for cursor replay", () => {
    const database = temporaryDatabase();
    let firstStore: SqliteStore | undefined;
    let restartedStore: SqliteStore | undefined;
    try {
      firstStore = new SqliteStore(database.path);
      const userId = createUser(firstStore);
      const committed = firstStore.transaction(() => appendTestEvent(firstStore as SqliteStore, userId));
      firstStore.close();
      firstStore = undefined;

      restartedStore = new SqliteStore(database.path);
      const delegate = new RecordingPublisher();
      const publisher = new RealtimeOutboxPublisher(restartedStore, delegate, {
        workerId: "restarted-worker",
        clock: () => new Date(AT),
        pollIntervalMs: 60_000
      });
      publisher.start();
      expect(delegate.events.map(({ sequence }) => sequence)).toEqual([committed.sequence]);
      expect(publisher.drainDue()).toEqual({ claimed: 0, published: 0, retried: 0, failed: 0 });
      expect(restartedStore.replayEvents(userId, 0, committed.sequence, 10)).toEqual([committed]);
      publisher.close();
    } finally {
      firstStore?.close();
      restartedStore?.close();
      database.remove();
    }
  });

  it("does not acknowledge a failed publication and honors durable bounded backoff across restart", () => {
    const database = temporaryDatabase();
    let store: SqliteStore | undefined;
    try {
      let nowMs = Date.parse(AT);
      store = new SqliteStore(database.path);
      const userId = createUser(store);
      const committed = appendTestEvent(store, userId);
      const failures: RealtimeOutboxFailure[] = [];
      const failingDelegate = new RecordingPublisher(1);
      const firstWorker = new RealtimeOutboxPublisher(store, failingDelegate, {
        workerId: "first-worker",
        clock: () => new Date(nowMs),
        retryBaseMs: 1_000,
        retryMaxMs: 2_000,
        onFailure: (failure) => failures.push(failure)
      });

      expect(firstWorker.drainDue()).toEqual({ claimed: 1, published: 0, retried: 1, failed: 0 });
      expect(failures.map(({ stage }) => stage)).toEqual(["publish"]);
      expect(firstWorker.drainDue()).toEqual({ claimed: 0, published: 0, retried: 0, failed: 0 });
      firstWorker.close();
      store.close();
      store = undefined;

      nowMs += 999;
      store = new SqliteStore(database.path);
      const recoveredDelegate = new RecordingPublisher();
      const recoveredWorker = new RealtimeOutboxPublisher(store, recoveredDelegate, {
        workerId: "recovered-worker",
        clock: () => new Date(nowMs),
        retryBaseMs: 1_000,
        retryMaxMs: 2_000
      });
      expect(recoveredWorker.drainDue()).toEqual({ claimed: 0, published: 0, retried: 0, failed: 0 });

      nowMs += 1;
      expect(recoveredWorker.drainDue()).toEqual({ claimed: 1, published: 1, retried: 0, failed: 0 });
      expect(recoveredDelegate.events.map(({ sequence }) => sequence)).toEqual([committed.sequence]);
      expect(recoveredWorker.drainDue()).toEqual({ claimed: 0, published: 0, retried: 0, failed: 0 });
      recoveredWorker.close();
    } finally {
      store?.close();
      database.remove();
    }
  });

  it("recovers an expired claim and permits an at-least-once duplicate after publish-before-ack crash", () => {
    const database = temporaryDatabase();
    let store: SqliteStore | undefined;
    try {
      store = new SqliteStore(database.path);
      const userId = createUser(store);
      const committed = appendTestEvent(store, userId);
      const firstClaim = store.claimRealtimeOutbox(
        "crashed-worker",
        AT,
        "2026-08-03T12:00:01.000Z",
        1
      );
      expect(firstClaim).toEqual([{ ok: true, event: committed, attemptCount: 1 }]);

      const delegate = new RecordingPublisher();
      const firstItem = firstClaim[0];
      if (firstItem?.ok !== true) throw new Error("Expected a readable first claim");
      delegate.publish([firstItem.event]);
      // Simulate a process crash after publication and before SQLite ack.
      store.close();
      store = new SqliteStore(database.path);

      expect(store.claimRealtimeOutbox(
        "recovery-worker",
        "2026-08-03T12:00:00.999Z",
        "2026-08-03T12:00:30.999Z",
        1
      )).toEqual([]);
      const recovered = store.claimRealtimeOutbox(
        "recovery-worker",
        "2026-08-03T12:00:01.000Z",
        "2026-08-03T12:00:31.000Z",
        1
      );
      expect(recovered).toEqual([{ ok: true, event: committed, attemptCount: 2 }]);
      expect(store.markRealtimeOutboxPublished(committed.sequence, "crashed-worker", AT)).toBe(false);
      const recoveredItem = recovered[0];
      if (recoveredItem?.ok !== true) throw new Error("Expected a readable recovered claim");
      delegate.publish([recoveredItem.event]);
      expect(store.markRealtimeOutboxPublished(
        committed.sequence,
        "recovery-worker",
        "2026-08-03T12:00:01.001Z"
      )).toBe(true);
      expect(delegate.events.map(({ sequence }) => sequence)).toEqual([
        committed.sequence,
        committed.sequence
      ]);
    } finally {
      store?.close();
      database.remove();
    }
  });

  it("backs off then dead-letters an unreadable event without blocking later rows", () => {
    const database = temporaryDatabase();
    let store: SqliteStore | undefined;
    try {
      store = new SqliteStore(database.path);
      const userId = createUser(store);
      const unreadable = appendTestEvent(store, userId);
      const readable = appendTestEvent(store, userId);
      store.close();
      store = undefined;

      const raw = new Database(database.path);
      raw.prepare("UPDATE realtime_events SET event_json = ? WHERE sequence = ?")
        .run("{definitely-not-json", unreadable.sequence);
      raw.close();

      let nowMs = Date.parse(AT);
      const observedFailures: RealtimeOutboxFailure[] = [];
      store = new SqliteStore(database.path);
      const delegate = new RecordingPublisher();
      const publisher = new RealtimeOutboxPublisher(store, delegate, {
        workerId: "poison-safe-worker",
        clock: () => new Date(nowMs),
        maxAttempts: 2,
        retryBaseMs: 1_000,
        retryMaxMs: 1_000,
        onFailure: (failure) => {
          observedFailures.push(failure);
          throw new Error("injected logging failure");
        }
      });

      expect(publisher.drainDue()).toEqual({ claimed: 2, published: 1, retried: 1, failed: 0 });
      expect(delegate.events.map(({ sequence }) => sequence)).toEqual([readable.sequence]);
      expect(observedFailures.map(({ stage }) => stage)).toEqual(["decode"]);

      nowMs += 1_000;
      expect(publisher.drainDue()).toEqual({ claimed: 1, published: 0, retried: 0, failed: 1 });
      expect(observedFailures.map(({ stage }) => stage)).toEqual(["decode", "decode"]);
      expect(publisher.drainDue()).toEqual({ claimed: 0, published: 0, retried: 0, failed: 0 });
      publisher.close();
      store.close();
      store = undefined;

      const inspection = new Database(database.path, { readonly: true });
      const rows = inspection.prepare(`
        SELECT event_sequence, published_at, failed_at, failure_code
        FROM realtime_outbox ORDER BY event_sequence
      `).all() as Array<{
        event_sequence: number;
        published_at: string | null;
        failed_at: string | null;
        failure_code: string | null;
      }>;
      expect(rows).toEqual([
        {
          event_sequence: unreadable.sequence,
          published_at: null,
          failed_at: new Date(nowMs).toISOString(),
          failure_code: "event_unreadable"
        },
        {
          event_sequence: readable.sequence,
          published_at: AT,
          failed_at: null,
          failure_code: null
        }
      ]);
      expect((inspection.prepare("SELECT event_json FROM realtime_events WHERE sequence = ?")
        .get(unreadable.sequence) as { event_json: string }).event_json).toBe("{definitely-not-json");
      inspection.close();
    } finally {
      store?.close();
      database.remove();
    }
  });

  it("keeps post-commit publish non-throwing when its clock and failure observer throw", () => {
    const database = temporaryDatabase();
    const store = new SqliteStore(database.path);
    try {
      const userId = createUser(store);
      const committed = appendTestEvent(store, userId);
      let clockIsValid = false;
      const delegate = new RecordingPublisher();
      const publisher = new RealtimeOutboxPublisher(store, delegate, {
        workerId: "non-throwing-worker",
        clock: () => clockIsValid ? new Date(AT) : new Date(Number.NaN),
        onFailure: () => {
          throw new Error("injected observer failure");
        }
      });

      expect(() => publisher.publish([committed])).not.toThrow();
      expect(delegate.events).toEqual([]);
      clockIsValid = true;
      expect(publisher.drainDue()).toEqual({ claimed: 1, published: 1, retried: 0, failed: 0 });
      expect(delegate.events).toEqual([committed]);
      publisher.close();
    } finally {
      store.close();
      database.remove();
    }
  });

  it("caps attempt_count instead of overflowing a long-lived durable failure", () => {
    const database = temporaryDatabase();
    let store: SqliteStore | undefined;
    try {
      store = new SqliteStore(database.path);
      const userId = createUser(store);
      const committed = appendTestEvent(store, userId);
      store.close();
      store = undefined;

      const raw = new Database(database.path);
      raw.prepare("UPDATE realtime_outbox SET attempt_count = 2147483647 WHERE event_sequence = ?")
        .run(committed.sequence);
      expect(() => raw.prepare(
        "UPDATE realtime_outbox SET attempt_count = 2147483648 WHERE event_sequence = ?"
      ).run(committed.sequence)).toThrow();
      raw.close();

      store = new SqliteStore(database.path);
      expect(store.claimRealtimeOutbox(
        "overflow-safe-worker",
        AT,
        "2026-08-03T12:00:30.000Z",
        1
      )).toEqual([{ ok: true, event: committed, attemptCount: 2_147_483_647 }]);
    } finally {
      store?.close();
      database.remove();
    }
  });
});
