import { createHash, randomUUID } from "node:crypto";
import { types as utilTypes } from "node:util";

import {
  StoreDuplicateCommandError,
  StoreRevisionConflictError
} from "@luxora/passkey-domain";
import { IdSchema } from "@luxora/protocol";

import type { PersistPasskeyLoginTerminal, Store } from "../domain/store.js";
import type { PasskeyLoginIntentRecord } from "../domain/types.js";

const DEFAULT_BATCH_SIZE = 100;
const DEFAULT_MAX_BATCHES_PER_SWEEP = 10;
const MAX_BATCH_SIZE = 1_000;
const MAX_BATCHES_PER_SWEEP = 1_000;

type ExpiryStore = Pick<Store,
  | "listExpiredPendingPasskeyLoginIntents"
  | "commitPasskeyLoginTerminal"
>;

export interface PasskeyLoginExpirySweepResult {
  scanned: number;
  expired: number;
  skipped: number;
  batches: number;
  busy: boolean;
}

export interface PasskeyLoginExpirySweeperOptions {
  batchSize?: number;
  maxBatchesPerSweep?: number;
  clock?: () => number;
  idFactory?: () => string;
}

function boundedPositiveInteger(value: number, maximum: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new Error(`${label} must be a positive safe integer no greater than ${maximum}`);
  }
  return value;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function canonicalUuid(value: unknown, label: string): string {
  if (typeof value !== "string") throw new Error(`${label} must be a canonical UUID`);
  const parsed = IdSchema.safeParse(value);
  if (!parsed.success || parsed.data !== value) {
    throw new Error(`${label} must be a canonical UUID`);
  }
  return value;
}

function safeCandidate(value: PasskeyLoginIntentRecord, observedAtMs: number): {
  intentId: string;
  revision: number;
  expiresAtMs: number;
} {
  if (
    value === null
    || typeof value !== "object"
    || utilTypes.isProxy(value)
    || (Object.getPrototypeOf(value) !== Object.prototype
      && Object.getPrototypeOf(value) !== null)
  ) {
    throw new Error("Passkey login expiry candidate is invalid");
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const intentId = descriptors["intentId"];
  const revision = descriptors["revision"];
  const state = descriptors["state"];
  const expiresAtMs = descriptors["expiresAtMs"];
  const updatedAtMs = descriptors["updatedAtMs"];
  if (
    intentId === undefined
    || !Object.hasOwn(intentId, "value")
    || revision === undefined
    || !Object.hasOwn(revision, "value")
    || state === undefined
    || !Object.hasOwn(state, "value")
    || expiresAtMs === undefined
    || !Object.hasOwn(expiresAtMs, "value")
    || updatedAtMs === undefined
    || !Object.hasOwn(updatedAtMs, "value")
  ) {
    throw new Error("Passkey login expiry candidate is invalid");
  }
  const intentIdValue: unknown = intentId.value;
  const revisionValue: unknown = revision.value;
  const stateValue: unknown = state.value;
  const expiresAtMsValue: unknown = expiresAtMs.value;
  const updatedAtMsValue: unknown = updatedAtMs.value;
  const safeIntentId = canonicalUuid(intentIdValue, "Passkey login intent ID");
  if (
    typeof revisionValue !== "number"
    || !Number.isSafeInteger(revisionValue)
    || revisionValue < 1
    || revisionValue >= Number.MAX_SAFE_INTEGER
    || stateValue !== "pending"
    || typeof expiresAtMsValue !== "number"
    || !Number.isSafeInteger(expiresAtMsValue)
    || expiresAtMsValue < 0
    || expiresAtMsValue > observedAtMs
    || typeof updatedAtMsValue !== "number"
    || !Number.isSafeInteger(updatedAtMsValue)
    || updatedAtMsValue < 0
    || updatedAtMsValue >= expiresAtMsValue
  ) {
    throw new Error("Passkey login expiry candidate is invalid");
  }
  return {
    intentId: safeIntentId,
    revision: revisionValue,
    expiresAtMs: expiresAtMsValue
  };
}

function deterministicProof(
  kind: "command-scope" | "fingerprint",
  candidate: { intentId: string; revision: number; expiresAtMs: number }
): string {
  return sha256([
    "luxora.passkey-login.expiry-sweeper.v1",
    kind,
    candidate.intentId,
    String(candidate.revision),
    String(candidate.expiresAtMs)
  ].join("\n"));
}

/**
 * Bounded reconciler for anonymous login intents abandoned by their clients.
 *
 * One sweep observes a single timestamp, processes at most
 * `batchSize * maxBatchesPerSweep` rows, and relies on the Store's writer-time
 * expiry check and revision CAS. Concurrent winners are expected and skipped.
 */
export class PasskeyLoginExpirySweeper {
  readonly #store: ExpiryStore;
  readonly #batchSize: number;
  readonly #maxBatchesPerSweep: number;
  readonly #clock: () => number;
  readonly #idFactory: () => string;
  #sweeping = false;

  constructor(store: ExpiryStore, options: PasskeyLoginExpirySweeperOptions = {}) {
    this.#store = store;
    this.#batchSize = boundedPositiveInteger(
      options.batchSize ?? DEFAULT_BATCH_SIZE,
      MAX_BATCH_SIZE,
      "Passkey login expiry batch size"
    );
    this.#maxBatchesPerSweep = boundedPositiveInteger(
      options.maxBatchesPerSweep ?? DEFAULT_MAX_BATCHES_PER_SWEEP,
      MAX_BATCHES_PER_SWEEP,
      "Passkey login expiry maximum batches"
    );
    this.#clock = options.clock ?? Date.now;
    this.#idFactory = options.idFactory ?? randomUUID;
  }

  async sweep(): Promise<PasskeyLoginExpirySweepResult> {
    if (this.#sweeping) {
      return { scanned: 0, expired: 0, skipped: 0, batches: 0, busy: true };
    }
    this.#sweeping = true;
    try {
      const observedAtMs = this.#clock();
      if (!Number.isSafeInteger(observedAtMs) || observedAtMs < 0) {
        throw new Error("Passkey login expiry clock must return a non-negative safe integer");
      }
      const result: PasskeyLoginExpirySweepResult = {
        scanned: 0,
        expired: 0,
        skipped: 0,
        batches: 0,
        busy: false
      };
      for (let batch = 0; batch < this.#maxBatchesPerSweep; batch += 1) {
        const candidates = await this.#store.listExpiredPendingPasskeyLoginIntents(
          observedAtMs,
          this.#batchSize
        );
        result.batches += 1;
        if (candidates.length === 0) break;
        if (candidates.length > this.#batchSize) {
          throw new Error("Passkey login expiry Store exceeded the requested batch size");
        }
        for (const value of candidates) {
          result.scanned += 1;
          const candidate = safeCandidate(value, observedAtMs);
          const commandScope = deterministicProof("command-scope", candidate);
          const fingerprint = deterministicProof("fingerprint", candidate);
          const eventId = canonicalUuid(this.#idFactory(), "Passkey login expiry event ID");
          const outboxId = canonicalUuid(this.#idFactory(), "Passkey login expiry outbox ID");
          const persist: PersistPasskeyLoginTerminal = {
            intentId: candidate.intentId,
            expectedRevision: candidate.revision,
            terminalAtMs: observedAtMs,
            nextState: "expired",
            event: {
              eventId,
              intentId: candidate.intentId,
              revision: candidate.revision + 1,
              type: "passkey.login.expired",
              commandScope,
              occurredAtMs: observedAtMs,
              state: "expired"
            },
            outbox: {
              outboxId,
              topic: "luxora.passkey-login.v1",
              partitionKey: candidate.intentId,
              eventId,
              availableAtMs: observedAtMs
            },
            commandReceipt: {
              scope: commandScope,
              fingerprint,
              intentId: candidate.intentId,
              resultRevision: candidate.revision + 1,
              resultState: "expired",
              eventId,
              createdAtMs: observedAtMs
            }
          };
          try {
            await this.#store.commitPasskeyLoginTerminal(persist);
            result.expired += 1;
          } catch (error) {
            if (
              error instanceof StoreRevisionConflictError
              || error instanceof StoreDuplicateCommandError
            ) {
              result.skipped += 1;
              continue;
            }
            throw error;
          }
        }
        if (candidates.length < this.#batchSize) break;
      }
      return result;
    } finally {
      this.#sweeping = false;
    }
  }
}
