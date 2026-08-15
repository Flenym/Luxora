import { randomUUID } from "node:crypto";
import type { ServerRealtimeMessage } from "@luxora/protocol";
import type { Store } from "../domain/store.js";
import type { StoredEvent } from "../domain/types.js";
import type { EventPublisher } from "./event-publisher.js";

const DEFAULT_BATCH_SIZE = 100;
const DEFAULT_MAX_BATCHES_PER_DRAIN = 10;
const DEFAULT_MAX_ATTEMPTS = 10;
const DEFAULT_LEASE_MS = 30_000;
const DEFAULT_POLL_INTERVAL_MS = 1_000;
const DEFAULT_RETRY_BASE_MS = 500;
const DEFAULT_RETRY_MAX_MS = 30_000;

export type RealtimeOutboxFailureStage =
  | "claim"
  | "decode"
  | "publish"
  | "ack"
  | "release"
  | "dead_letter";

export interface RealtimeOutboxFailure {
  stage: RealtimeOutboxFailureStage;
  eventSequence?: number;
  error: unknown;
}

export interface RealtimeOutboxDrainResult {
  claimed: number;
  published: number;
  retried: number;
  failed: number;
}

export interface RealtimeOutboxPublisherOptions {
  batchSize?: number;
  maxBatchesPerDrain?: number;
  maxAttempts?: number;
  leaseMs?: number;
  pollIntervalMs?: number;
  retryBaseMs?: number;
  retryMaxMs?: number;
  workerId?: string;
  clock?: () => Date;
  shouldPublish?: (event: StoredEvent) => boolean;
  onFailure?: (failure: RealtimeOutboxFailure) => void;
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${label} must be a positive safe integer`);
  }
  return value;
}

/**
 * Drains the SQLite realtime outbox into one process-local publisher.
 *
 * Publication is deliberately at-least-once: a crash after the delegate
 * accepts an event but before the SQLite acknowledgement leaves the lease to
 * expire and the same sequence can be published again. Realtime clients must
 * therefore deduplicate durable dispatches by sequence, which is already the
 * resume contract. This class is not a cross-process fan-out broker.
 */
export class RealtimeOutboxPublisher implements EventPublisher {
  readonly #batchSize: number;
  readonly #maxBatchesPerDrain: number;
  readonly #maxAttempts: number;
  readonly #leaseMs: number;
  readonly #pollIntervalMs: number;
  readonly #retryBaseMs: number;
  readonly #retryMaxMs: number;
  readonly #workerId: string;
  readonly #clock: () => Date;
  readonly #shouldPublish: (event: StoredEvent) => boolean;
  readonly #onFailure: ((failure: RealtimeOutboxFailure) => void) | undefined;
  #timer: NodeJS.Timeout | undefined;
  #draining = false;
  #closed = false;

  constructor(
    private readonly store: Store,
    private readonly delegate: EventPublisher,
    options: RealtimeOutboxPublisherOptions = {}
  ) {
    this.#batchSize = positiveInteger(options.batchSize ?? DEFAULT_BATCH_SIZE, "Outbox batch size");
    if (this.#batchSize > 500) throw new Error("Outbox batch size cannot exceed 500");
    this.#maxBatchesPerDrain = positiveInteger(
      options.maxBatchesPerDrain ?? DEFAULT_MAX_BATCHES_PER_DRAIN,
      "Outbox maximum batches per drain"
    );
    this.#maxAttempts = positiveInteger(options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS, "Outbox maximum attempts");
    if (this.#maxAttempts > 2_147_483_647) {
      throw new Error("Outbox maximum attempts cannot exceed the durable counter limit");
    }
    this.#leaseMs = positiveInteger(options.leaseMs ?? DEFAULT_LEASE_MS, "Outbox lease");
    this.#pollIntervalMs = positiveInteger(
      options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
      "Outbox poll interval"
    );
    this.#retryBaseMs = positiveInteger(options.retryBaseMs ?? DEFAULT_RETRY_BASE_MS, "Outbox retry base");
    this.#retryMaxMs = positiveInteger(options.retryMaxMs ?? DEFAULT_RETRY_MAX_MS, "Outbox retry maximum");
    if (this.#retryMaxMs < this.#retryBaseMs) {
      throw new Error("Outbox retry maximum cannot be smaller than retry base");
    }
    this.#workerId = options.workerId ?? randomUUID();
    this.#clock = options.clock ?? (() => new Date());
    this.#shouldPublish = options.shouldPublish ?? (() => true);
    this.#onFailure = options.onFailure;
  }

  start(): void {
    if (this.#closed) throw new Error("Realtime outbox publisher is closed");
    if (this.#timer !== undefined) return;
    this.drainDue();
    this.#timer = setInterval(() => {
      this.drainDue();
    }, this.#pollIntervalMs);
    this.#timer.unref();
  }

  close(): void {
    this.#closed = true;
    if (this.#timer !== undefined) clearInterval(this.#timer);
    this.#timer = undefined;
  }

  publish(events: StoredEvent[]): void {
    // appendEvent() has already committed the matching durable outbox rows.
    // A synchronous drain preserves low-latency local delivery while failures
    // remain pending for the periodic/restart recovery path.
    if (events.length === 0) return;
    try {
      this.drainDue();
    } catch (error) {
      // This is a post-commit notification path. No observability callback,
      // clock failure, or unexpected worker bug may turn a committed command
      // into an ambiguous HTTP 500; the durable row remains recoverable.
      this.#failure({ stage: "claim", error });
    }
  }

  publishEphemeral(
    userIds: string[],
    message: ServerRealtimeMessage,
    excludeConnectionId?: string
  ): void {
    this.delegate.publishEphemeral(userIds, message, excludeConnectionId);
  }

  drainDue(): RealtimeOutboxDrainResult {
    const result: RealtimeOutboxDrainResult = { claimed: 0, published: 0, retried: 0, failed: 0 };
    if (this.#closed || this.#draining) return result;
    this.#draining = true;
    try {
      for (let batchIndex = 0; batchIndex < this.#maxBatchesPerDrain; batchIndex += 1) {
        const claimedAt = this.#validClockReading();
        const leaseUntil = new Date(claimedAt.getTime() + this.#leaseMs).toISOString();
        let claimed;
        try {
          claimed = this.store.claimRealtimeOutbox(
            this.#workerId,
            claimedAt.toISOString(),
            leaseUntil,
            this.#batchSize
          );
        } catch (error) {
          this.#failure({ stage: "claim", error });
          break;
        }
        if (claimed.length === 0) break;
        result.claimed += claimed.length;

        for (const item of claimed) {
          if (!item.ok) {
            this.#failure({
              stage: "decode",
              eventSequence: item.eventSequence,
              error: new Error("Durable realtime event could not be decoded or validated")
            });
            this.#retryOrFail(
              item.eventSequence,
              item.attemptCount,
              item.failureCode,
              result
            );
            continue;
          }
          try {
            if (this.#shouldPublish(item.event)) this.delegate.publish([item.event]);
          } catch (error) {
            this.#failure({ stage: "publish", eventSequence: item.event.sequence, error });
            this.#retryOrFail(
              item.event.sequence,
              item.attemptCount,
              "publish_failed",
              result
            );
            continue;
          }

          try {
            const acknowledged = this.store.markRealtimeOutboxPublished(
              item.event.sequence,
              this.#workerId,
              this.#validClockReading().toISOString()
            );
            if (!acknowledged) {
              this.#failure({
                stage: "ack",
                eventSequence: item.event.sequence,
                error: new Error("Realtime outbox lease was no longer owned at acknowledgement")
              });
              continue;
            }
            result.published += 1;
          } catch (error) {
            this.#failure({ stage: "ack", eventSequence: item.event.sequence, error });
            // Keep the claim intact. If the acknowledgement was not committed,
            // its lease expires and another at-least-once attempt recovers it.
          }
        }
        // A per-audience head may expose its successor only after this batch
        // is acknowledged. Continue the bounded loop even after a short claim;
        // an empty claim above remains the no-work/busy-loop stop condition.
      }
    } catch (error) {
      this.#failure({ stage: "claim", error });
    } finally {
      this.#draining = false;
    }
    return result;
  }

  #retryOrFail(
    sequence: number,
    attemptCount: number,
    failureCode: "event_unreadable" | "publish_failed",
    result: RealtimeOutboxDrainResult
  ): void {
    if (attemptCount >= this.#maxAttempts) {
      try {
        const failed = this.store.markRealtimeOutboxFailed(
          sequence,
          this.#workerId,
          this.#validClockReading().toISOString(),
          failureCode
        );
        if (failed) {
          result.failed += 1;
          return;
        }
        this.#failure({
          stage: "dead_letter",
          eventSequence: sequence,
          error: new Error("Realtime outbox lease was no longer owned at dead-letter transition")
        });
      } catch (error) {
        this.#failure({ stage: "dead_letter", eventSequence: sequence, error });
      }
      // If durable dead-lettering fails, retain the lease. Expiry permits a
      // later worker to retry the transition without deleting or acknowledging
      // the unreadable/unpublished event.
      return;
    }
    if (this.#scheduleRetry(sequence, attemptCount)) result.retried += 1;
  }

  #scheduleRetry(sequence: number, attemptCount: number): boolean {
    try {
      const exponent = Math.min(Math.max(attemptCount - 1, 0), 30);
      const delayMs = Math.min(this.#retryMaxMs, this.#retryBaseMs * (2 ** exponent));
      const availableAt = new Date(this.#validClockReading().getTime() + delayMs).toISOString();
      const released = this.store.releaseRealtimeOutbox(sequence, this.#workerId, availableAt);
      if (!released) {
        this.#failure({
          stage: "release",
          eventSequence: sequence,
          error: new Error("Realtime outbox lease was no longer owned at retry scheduling")
        });
        return false;
      }
      return true;
    } catch (error) {
      this.#failure({ stage: "release", eventSequence: sequence, error });
      // The existing lease is the recovery boundary when release itself fails.
      return false;
    }
  }

  #validClockReading(): Date {
    const value = this.#clock();
    const milliseconds = value.getTime();
    if (!Number.isSafeInteger(milliseconds) || milliseconds < 0) {
      throw new Error("Realtime outbox clock returned an invalid date");
    }
    return value;
  }

  #failure(failure: RealtimeOutboxFailure): void {
    try {
      this.#onFailure?.(failure);
    } catch {
      // Logging/metrics are best-effort and must never alter durable delivery.
    }
  }
}
