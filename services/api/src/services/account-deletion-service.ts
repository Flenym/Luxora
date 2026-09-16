import type { Store } from "../domain/store.js";
import { conflict, notFound } from "../errors.js";
import type { AccountDeletionRecord } from "../domain/types.js";

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
const SWEEP_BATCH = 20;

export interface DeletionStatusResult {
  record: AccountDeletionRecord;
  isNone: boolean;
}

export class AccountDeletionService {
  constructor(private readonly store: Store) {}

  scheduleAccountDeletion(accountId: string, sessionId: string, now: Date): AccountDeletionRecord {
    const existing = this.store.findAccountDeletion(accountId);
    if (existing !== null && existing.state !== "completed") {
      if (existing.state === "scheduled") return existing;
      throw conflict("Account deletion is already in progress");
    }

    const scheduledAt = now.toISOString();
    const graceDeadlineAt = new Date(now.getTime() + SEVEN_DAYS_MS).toISOString();
    return this.store.createAccountDeletion({
      accountId,
      state: "scheduled",
      scheduledAt,
      graceDeadlineAt,
      scheduledBySessionId: sessionId
    });
  }

  getStatus(accountId: string): DeletionStatusResult {
    const record = this.store.findAccountDeletion(accountId);
    if (record === null) {
      return {
        record: {
          accountId,
          state: "none",
          scheduledAt: null,
          graceDeadlineAt: null,
          scheduledBySessionId: null,
          canceledAt: null,
          executedAt: null,
          completedAt: null,
          failedAt: null,
          lastError: null
        },
        isNone: true
      };
    }
    return { record, isNone: false };
  }

  cancelAccountDeletion(accountId: string, now: Date): AccountDeletionRecord {
    const record = this.store.findAccountDeletion(accountId);
    if (record === null) throw notFound("No scheduled account deletion");
    if (record.state !== "scheduled") throw conflict("Account deletion cannot be cancelled in current state");

    this.store.deleteAccountDeletion(accountId);
    return {
      ...record,
      state: "none",
      canceledAt: now.toISOString()
    };
  }

  sweep(now: Date, limit: number = SWEEP_BATCH): {
    processed: number;
    completed: number;
    failed: number;
  } {
    const due = this.store.listDueAccountDeletions(now.toISOString(), limit);
    let processed = 0;
    let completed = 0;
    let failed = 0;

    for (const record of due) {
      processed++;
      try {
        this.#executeDeletion(record, now);
        completed++;
      } catch {
        this.store.markAccountDeletionFailed(record.accountId, "Execution failed", now.toISOString());
        failed++;
      }
    }

    return { processed, completed, failed };
  }

  #executeDeletion(record: AccountDeletionRecord, now: Date): void {
    const { accountId } = record;
    const nowISO = now.toISOString();

    if (record.state === "scheduled") {
      this.store.transitionAccountDeletionState(accountId, "scheduled", "deletion_pending", nowISO);
    }
    if (record.state === "deletion_pending" || this.store.findAccountDeletion(accountId)?.state === "deletion_pending") {
      this.store.transitionAccountDeletionState(accountId, "deletion_pending", "executing", nowISO);
    }

    this.store.revokeAllSessionsForAccount(accountId, nowISO);
    this.store.tombstoneAccountProfile(accountId, nowISO);
    this.store.deletePushRegistrationsForAccount(accountId, nowISO);
    this.store.markOwnedAttachmentsDeletedForAccount(accountId, nowISO);
    this.store.expireDataExportsForAccount(accountId, nowISO);

    const success = this.store.markAccountDeletionCompleted(accountId, nowISO);
    if (!success) throw new Error("Failed to mark account deletion completed");
  }
}
