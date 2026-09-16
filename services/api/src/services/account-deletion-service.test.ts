import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { SqliteStore } from "../infrastructure/sqlite-store.js";
import { AccountDeletionService } from "./account-deletion-service.js";

const T0 = "2026-09-16T12:00:00.000Z";
const DEADLINE = "2026-09-23T12:00:00.000Z";

describe("AccountDeletionService", () => {
  const stores: SqliteStore[] = [];

  afterEach(() => {
    for (const store of stores.splice(0)) store.close();
  });

  function openStore(): SqliteStore {
    const store = new SqliteStore(":memory:");
    stores.push(store);
    return store;
  }

  function seed(
    store: SqliteStore,
    username = "deletion_account"
  ): { userId: string; sessionId: string } {
    const userId = randomUUID();
    const sessionId = randomUUID();
    store.createUser({
      id: userId,
      username,
      usernameNormalized: username,
      displayName: "Deletion Account",
      passwordHash: "test-only-password-hash",
      createdAt: T0
    });
    store.createSession({
      id: sessionId,
      userId,
      deviceName: "Seed device",
      createdAt: T0,
      expiresAt: "2026-10-16T12:00:00.000Z"
    }, {
      id: randomUUID(),
      sessionId,
      tokenHash: "test-only-token-hash",
      createdAt: T0,
      expiresAt: "2026-10-16T12:00:00.000Z"
    });
    return { userId, sessionId };
  }

  it("schedules, reads status, and cancels deletion", () => {
    const store = openStore();
    const service = new AccountDeletionService(store);
    const { userId, sessionId } = seed(store);

    expect(service.getStatus(userId).isNone).toBe(true);
    expect(service.getStatus(userId).record.state).toBe("none");

    const scheduled = service.scheduleAccountDeletion(userId, sessionId, new Date(T0));
    expect(scheduled.state).toBe("scheduled");
    expect(scheduled.scheduledAt).toBe(T0);
    expect(scheduled.graceDeadlineAt).toBe(DEADLINE);
    expect(scheduled.scheduledBySessionId).toBe(sessionId);

    expect(service.getStatus(userId).isNone).toBe(false);
    expect(service.getStatus(userId).record.state).toBe("scheduled");

    const cancelled = service.cancelAccountDeletion(userId, new Date(T0));
    expect(cancelled.state).toBe("none");
    expect(cancelled.canceledAt).toBe(T0);
    expect(service.getStatus(userId).isNone).toBe(true);
  });

  it("is idempotent when re-scheduled during grace", () => {
    const store = openStore();
    const service = new AccountDeletionService(store);
    const { userId, sessionId } = seed(store);

    const first = service.scheduleAccountDeletion(userId, sessionId, new Date(T0));
    const second = service.scheduleAccountDeletion(userId, sessionId, new Date(T0));
    expect(second).toEqual(first);
  });

  it("rejects scheduling while a terminal deletion is in progress", () => {
    const store = openStore();
    const service = new AccountDeletionService(store);
    const { userId, sessionId } = seed(store);

    service.scheduleAccountDeletion(userId, sessionId, new Date(T0));
    store.transitionAccountDeletionState(userId, "scheduled", "deletion_pending", T0);

    expect(() => service.scheduleAccountDeletion(userId, sessionId, new Date(T0))).toThrow();
  });

  it("only cancels from scheduled state", () => {
    const store = openStore();
    const service = new AccountDeletionService(store);
    const { userId, sessionId } = seed(store);

    expect(() => service.cancelAccountDeletion(userId, new Date(T0))).toThrow();

    service.scheduleAccountDeletion(userId, sessionId, new Date(T0));
    store.transitionAccountDeletionState(userId, "scheduled", "deletion_pending", T0);
    expect(() => service.cancelAccountDeletion(userId, new Date(T0))).toThrow();
  });

  it("sweeps due deletions to completed, revoking sessions and tombstoning the profile", () => {
    const store = openStore();
    const service = new AccountDeletionService(store);
    const { userId, sessionId } = seed(store);

    service.scheduleAccountDeletion(userId, sessionId, new Date(T0));
    const sweepTime = new Date("2026-09-24T00:00:00.000Z");
    const result = service.sweep(sweepTime);

    expect(result.processed).toBe(1);
    expect(result.completed).toBe(1);
    expect(result.failed).toBe(0);

    const record = store.findAccountDeletion(userId);
    expect(record?.state).toBe("completed");
    expect(record?.executedAt).toBe(sweepTime.toISOString());
    expect(record?.completedAt).toBe(sweepTime.toISOString());

    expect(store.isSessionActive(sessionId, userId, sweepTime.toISOString())).toBe(false);
    const user = store.findUserById(userId);
    expect(user?.usernameNormalized).toBe(`deleted:${userId}`);
    expect(store.findUserByUsername(`deleted:${userId}`)).toBeNull();
    expect(store.findUserById(userId)?.createdAt).toBe(T0);
  });

  it("does not process records before their deadline", () => {
    const store = openStore();
    const service = new AccountDeletionService(store);
    const { userId, sessionId } = seed(store);

    service.scheduleAccountDeletion(userId, sessionId, new Date(T0));
    const result = service.sweep(new Date("2026-09-20T00:00:00.000Z"));
    expect(result.processed).toBe(0);
    expect(store.findAccountDeletion(userId)?.state).toBe("scheduled");
  });

  it("marks execution as failed_retryable when a task throws", () => {
    const store = openStore();
    const service = new AccountDeletionService(store);
    const { userId, sessionId } = seed(store);

    service.scheduleAccountDeletion(userId, sessionId, new Date(T0));
    const originalMark = store.markAccountDeletionCompleted.bind(store);
    store.markAccountDeletionCompleted = () => {
      throw new Error("simulated task failure");
    };

    const sweepTime = new Date("2026-09-24T00:00:00.000Z");
    const result = service.sweep(sweepTime);
    expect(result.processed).toBe(1);
    expect(result.failed).toBe(1);
    expect(store.findAccountDeletion(userId)?.state).toBe("failed_retryable");
    expect(store.findAccountDeletion(userId)?.lastError).toBe("Execution failed");

    store.markAccountDeletionCompleted = originalMark;
  });
});