import { createHash, randomUUID } from "node:crypto";
import { types as utilTypes } from "node:util";

import {
  StoreDuplicateCommandError,
  StoreRevisionConflictError
} from "@luxora/passkey-domain";
import { IdSchema } from "@luxora/protocol";

import type { PersistPasskeySignupExpired, Store } from "../domain/store.js";
import type {
  PasskeySignupIntentRecord,
  PasskeySignupReceiptRecord
} from "../domain/types.js";

const DEFAULT_BATCH_SIZE = 100;
const DEFAULT_MAX_BATCHES_PER_SWEEP = 10;
const DEFAULT_MAX_TRANSIENT_RETRIES = 3;
const DEFAULT_RETRY_BASE_MS = 25;
const DEFAULT_RETRY_MAX_MS = 250;
const MAX_BATCH_SIZE = 1_000;
const MAX_BATCHES_PER_SWEEP = 1_000;
const MAX_TRANSIENT_RETRIES = 10;
const MAX_RETRY_DELAY_MS = 60_000;
const OPTION_KEYS = [
  "batchSize",
  "clock",
  "idFactory",
  "maxBatchesPerSweep",
  "maxTransientRetries",
  "retryBaseMs",
  "retryMaxMs",
  "wait"
] as const;
const TRANSIENT_SQLITE_CODES = new Set([
  "SQLITE_BUSY",
  "SQLITE_BUSY_RECOVERY",
  "SQLITE_BUSY_SNAPSHOT",
  "SQLITE_BUSY_TIMEOUT",
  "SQLITE_LOCKED",
  "SQLITE_LOCKED_SHAREDCACHE",
  "SQLITE_LOCKED_VTAB"
]);

type SignupExpiryStore = Pick<Store,
  | "commitPasskeySignupExpired"
  | "findPasskeySignupCommandReceipt"
  | "listExpiredPendingPasskeySignupIntents"
>;

export interface PasskeySignupExpirySweepResult {
  scanned: number;
  expired: number;
  reconciled: number;
  skipped: number;
  batches: number;
  retries: number;
  busy: boolean;
}

export interface PasskeySignupExpirySweeperOptions {
  readonly batchSize?: number;
  readonly maxBatchesPerSweep?: number;
  readonly maxTransientRetries?: number;
  readonly retryBaseMs?: number;
  readonly retryMaxMs?: number;
  readonly clock?: () => number;
  readonly idFactory?: () => string;
  readonly wait?: (delayMs: number) => Promise<void>;
}

interface SafeOptions {
  readonly batchSize: number;
  readonly maxBatchesPerSweep: number;
  readonly maxTransientRetries: number;
  readonly retryBaseMs: number;
  readonly retryMaxMs: number;
  readonly clock: () => number;
  readonly idFactory: () => string;
  readonly wait: (delayMs: number) => Promise<void>;
}

interface ExpiryCandidate {
  readonly intentId: string;
  readonly revision: number;
  readonly expiresAtMs: number;
}

function defaultWait(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

function boundedPositiveInteger(value: unknown, maximum: number, label: string): number {
  if (
    typeof value !== "number"
    || !Number.isSafeInteger(value)
    || value < 1
    || value > maximum
  ) throw new Error(`${label} must be a positive safe integer no greater than ${maximum}`);
  return value;
}

function boundedNonNegativeInteger(value: unknown, maximum: number, label: string): number {
  if (
    typeof value !== "number"
    || !Number.isSafeInteger(value)
    || value < 0
    || value > maximum
  ) throw new Error(`${label} must be a non-negative safe integer no greater than ${maximum}`);
  return value;
}

function snapshotOptions(value: PasskeySignupExpirySweeperOptions): SafeOptions {
  if (
    value === null
    || typeof value !== "object"
    || Array.isArray(value)
    || utilTypes.isProxy(value)
    || (Object.getPrototypeOf(value) !== Object.prototype
      && Object.getPrototypeOf(value) !== null)
  ) throw new Error("Passkey signup expiry options are invalid");
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key !== "string"
    || !OPTION_KEYS.includes(key as (typeof OPTION_KEYS)[number]))) {
    throw new Error("Passkey signup expiry options are invalid");
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const values: Record<string, unknown> = {};
  for (const key of keys as string[]) {
    const descriptor = descriptors[key];
    if (
      descriptor === undefined
      || descriptor.enumerable !== true
      || !("value" in descriptor)
    ) throw new Error("Passkey signup expiry options are invalid");
    values[key] = descriptor.value;
  }
  const batchSize = boundedPositiveInteger(
    values["batchSize"] ?? DEFAULT_BATCH_SIZE,
    MAX_BATCH_SIZE,
    "Passkey signup expiry batch size"
  );
  const maxBatchesPerSweep = boundedPositiveInteger(
    values["maxBatchesPerSweep"] ?? DEFAULT_MAX_BATCHES_PER_SWEEP,
    MAX_BATCHES_PER_SWEEP,
    "Passkey signup expiry maximum batches"
  );
  const maxTransientRetries = boundedNonNegativeInteger(
    values["maxTransientRetries"] ?? DEFAULT_MAX_TRANSIENT_RETRIES,
    MAX_TRANSIENT_RETRIES,
    "Passkey signup expiry transient retries"
  );
  const retryBaseMs = boundedPositiveInteger(
    values["retryBaseMs"] ?? DEFAULT_RETRY_BASE_MS,
    MAX_RETRY_DELAY_MS,
    "Passkey signup expiry retry base"
  );
  const retryMaxMs = boundedPositiveInteger(
    values["retryMaxMs"] ?? DEFAULT_RETRY_MAX_MS,
    MAX_RETRY_DELAY_MS,
    "Passkey signup expiry retry maximum"
  );
  if (retryMaxMs < retryBaseMs) {
    throw new Error("Passkey signup expiry retry maximum cannot be smaller than retry base");
  }
  const clock = values["clock"] ?? Date.now;
  const idFactory = values["idFactory"] ?? randomUUID;
  const wait = values["wait"] ?? defaultWait;
  if (typeof clock !== "function" || typeof idFactory !== "function" || typeof wait !== "function") {
    throw new Error("Passkey signup expiry options are invalid");
  }
  return Object.freeze({
    batchSize,
    maxBatchesPerSweep,
    maxTransientRetries,
    retryBaseMs,
    retryMaxMs,
    clock: clock as () => number,
    idFactory: idFactory as () => string,
    wait: wait as (delayMs: number) => Promise<void>
  });
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

function dataValue(
  descriptors: PropertyDescriptorMap,
  key: string
): unknown {
  const descriptor = descriptors[key];
  if (
    descriptor === undefined
    || descriptor.enumerable !== true
    || !("value" in descriptor)
  ) throw new Error("Passkey signup expiry candidate is invalid");
  return descriptor.value;
}

function safeCandidate(
  value: PasskeySignupIntentRecord,
  observedAtMs: number
): ExpiryCandidate {
  if (
    value === null
    || typeof value !== "object"
    || utilTypes.isProxy(value)
    || (Object.getPrototypeOf(value) !== Object.prototype
      && Object.getPrototypeOf(value) !== null)
  ) throw new Error("Passkey signup expiry candidate is invalid");
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const intentId = canonicalUuid(
    dataValue(descriptors, "intentId"),
    "Passkey signup intent ID"
  );
  const revision = dataValue(descriptors, "revision");
  const state = dataValue(descriptors, "state");
  const attemptsUsed = dataValue(descriptors, "attemptsUsed");
  const maxAttempts = dataValue(descriptors, "maxAttempts");
  const createdAtMs = dataValue(descriptors, "createdAtMs");
  const expiresAtMs = dataValue(descriptors, "expiresAtMs");
  const updatedAtMs = dataValue(descriptors, "updatedAtMs");
  const timeoutMs = dataValue(descriptors, "timeoutMs");
  if (
    typeof revision !== "number"
    || !Number.isSafeInteger(revision)
    || revision < 1
    || revision >= Number.MAX_SAFE_INTEGER
    || state !== "pending"
    || typeof attemptsUsed !== "number"
    || !Number.isSafeInteger(attemptsUsed)
    || attemptsUsed < 0
    || typeof maxAttempts !== "number"
    || !Number.isSafeInteger(maxAttempts)
    || maxAttempts < 1
    || maxAttempts > 5
    || attemptsUsed >= maxAttempts
    || revision !== attemptsUsed + 1
    || typeof createdAtMs !== "number"
    || !Number.isSafeInteger(createdAtMs)
    || createdAtMs < 0
    || typeof timeoutMs !== "number"
    || !Number.isSafeInteger(timeoutMs)
    || timeoutMs < 1
    || createdAtMs > Number.MAX_SAFE_INTEGER - timeoutMs
    || typeof expiresAtMs !== "number"
    || !Number.isSafeInteger(expiresAtMs)
    || expiresAtMs !== createdAtMs + timeoutMs
    || expiresAtMs > observedAtMs
    || typeof updatedAtMs !== "number"
    || !Number.isSafeInteger(updatedAtMs)
    || updatedAtMs < createdAtMs
    || updatedAtMs >= expiresAtMs
  ) throw new Error("Passkey signup expiry candidate is invalid");
  return Object.freeze({ intentId, revision, expiresAtMs });
}

function safeBatch(
  value: readonly PasskeySignupIntentRecord[],
  observedAtMs: number,
  limit: number
): readonly ExpiryCandidate[] {
  if (!Array.isArray(value) || utilTypes.isProxy(value) || value.length > limit) {
    throw new Error("Passkey signup expiry Store returned an invalid batch");
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.length !== value.length + 1) {
    throw new Error("Passkey signup expiry Store returned an invalid batch");
  }
  const candidates: ExpiryCandidate[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (
      descriptor === undefined
      || descriptor.enumerable !== true
      || !("value" in descriptor)
    ) throw new Error("Passkey signup expiry Store returned an invalid batch");
    candidates.push(safeCandidate(
      descriptor.value as PasskeySignupIntentRecord,
      observedAtMs
    ));
  }
  return Object.freeze(candidates);
}

function deterministicProof(
  kind: "command-scope" | "fingerprint",
  candidate: ExpiryCandidate
): string {
  return sha256([
    "luxora.passkey-signup.expiry-sweeper.v1",
    kind,
    candidate.intentId,
    String(candidate.revision),
    String(candidate.expiresAtMs)
  ].join("\n"));
}

function transientSqliteError(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 4; depth += 1) {
    if (
      current === null
      || typeof current !== "object"
      || utilTypes.isProxy(current)
    ) return false;
    const descriptors = Object.getOwnPropertyDescriptors(current);
    const codeDescriptor = descriptors["code"];
    if (
      codeDescriptor !== undefined
      && "value" in codeDescriptor
      && typeof codeDescriptor.value === "string"
      && TRANSIENT_SQLITE_CODES.has(codeDescriptor.value)
    ) return true;
    const causeDescriptor = descriptors["cause"];
    if (causeDescriptor === undefined || !("value" in causeDescriptor)) return false;
    current = causeDescriptor.value;
  }
  return false;
}

function validateReceipt(
  receipt: PasskeySignupReceiptRecord,
  candidate: ExpiryCandidate,
  commandScope: string,
  fingerprint: string
): void {
  if (
    receipt === null
    || typeof receipt !== "object"
    || utilTypes.isProxy(receipt)
    || (Object.getPrototypeOf(receipt) !== Object.prototype
      && Object.getPrototypeOf(receipt) !== null)
  ) throw new Error("Passkey signup expiry receipt is inconsistent");
  const descriptors = Object.getOwnPropertyDescriptors(receipt);
  const scope = dataValue(descriptors, "scope");
  const storedFingerprint = dataValue(descriptors, "fingerprint");
  const intentId = dataValue(descriptors, "intentId");
  const resultRevision = dataValue(descriptors, "resultRevision");
  const resultState = dataValue(descriptors, "resultState");
  const eventId = dataValue(descriptors, "eventId");
  const createdAtMs = dataValue(descriptors, "createdAtMs");
  if (
    scope !== commandScope
    || storedFingerprint !== fingerprint
    || intentId !== candidate.intentId
    || resultRevision !== candidate.revision + 1
    || resultState !== "expired"
    || typeof eventId !== "string"
    || eventId.length < 1
    || eventId.length > 192
    || typeof createdAtMs !== "number"
    || !Number.isSafeInteger(createdAtMs)
    || createdAtMs < candidate.expiresAtMs
  ) throw new Error("Passkey signup expiry receipt is inconsistent");
}

/**
 * Bounded restart reconciler for abandoned pre-account signup intents.
 *
 * It reads no candidate identity/handle fields, samples one clock per sweep,
 * uses deterministic secret-free command proofs across workers/restarts and
 * delegates ownership to the Store's immediate writer-time/revision CAS. Only
 * explicit SQLite BUSY/LOCKED errors receive bounded deterministic backoff.
 */
export class PasskeySignupExpirySweeper {
  readonly #store: SignupExpiryStore;
  readonly #options: SafeOptions;
  #sweeping = false;

  constructor(
    store: SignupExpiryStore,
    options: PasskeySignupExpirySweeperOptions = {}
  ) {
    this.#store = store;
    this.#options = snapshotOptions(options);
  }

  async sweep(): Promise<PasskeySignupExpirySweepResult> {
    if (this.#sweeping) {
      return {
        scanned: 0,
        expired: 0,
        reconciled: 0,
        skipped: 0,
        batches: 0,
        retries: 0,
        busy: true
      };
    }
    this.#sweeping = true;
    const result: PasskeySignupExpirySweepResult = {
      scanned: 0,
      expired: 0,
      reconciled: 0,
      skipped: 0,
      batches: 0,
      retries: 0,
      busy: false
    };
    try {
      const observedAtMs = this.#options.clock();
      if (!Number.isSafeInteger(observedAtMs) || observedAtMs < 0) {
        throw new Error("Passkey signup expiry clock must return a non-negative safe integer");
      }
      for (let batch = 0; batch < this.#options.maxBatchesPerSweep; batch += 1) {
        const raw = await this.#retryTransient(
          () => this.#store.listExpiredPendingPasskeySignupIntents(
            observedAtMs,
            this.#options.batchSize
          ),
          result
        );
        result.batches += 1;
        const candidates = safeBatch(raw, observedAtMs, this.#options.batchSize);
        if (candidates.length === 0) break;
        for (const candidate of candidates) {
          result.scanned += 1;
          await this.#expire(candidate, observedAtMs, result);
        }
        if (candidates.length < this.#options.batchSize) break;
      }
      return result;
    } finally {
      this.#sweeping = false;
    }
  }

  async #expire(
    candidate: ExpiryCandidate,
    observedAtMs: number,
    result: PasskeySignupExpirySweepResult
  ): Promise<void> {
    const commandScope = deterministicProof("command-scope", candidate);
    const fingerprint = deterministicProof("fingerprint", candidate);
    const eventId = canonicalUuid(
      this.#options.idFactory(),
      "Passkey signup expiry event ID"
    );
    const outboxId = canonicalUuid(
      this.#options.idFactory(),
      "Passkey signup expiry outbox ID"
    );
    const persist: PersistPasskeySignupExpired = {
      intentId: candidate.intentId,
      expectedRevision: candidate.revision,
      terminalAtMs: observedAtMs,
      nextState: "expired",
      event: {
        eventId,
        intentId: candidate.intentId,
        revision: candidate.revision + 1,
        type: "passkey.signup.expired",
        commandScope,
        occurredAtMs: observedAtMs,
        state: "expired"
      },
      outbox: {
        outboxId,
        topic: "luxora.passkey-signup.v1",
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
      await this.#retryTransient(
        () => this.#store.commitPasskeySignupExpired(persist),
        result
      );
      result.expired += 1;
    } catch (error) {
      if (
        !(error instanceof StoreRevisionConflictError)
        && !(error instanceof StoreDuplicateCommandError)
      ) throw error;
      const receipt = await this.#retryTransient(
        () => this.#store.findPasskeySignupCommandReceipt(commandScope),
        result
      );
      if (receipt === null) {
        if (error instanceof StoreDuplicateCommandError) {
          throw new Error("Passkey signup expiry receipt is missing");
        }
        result.skipped += 1;
        return;
      }
      validateReceipt(receipt, candidate, commandScope, fingerprint);
      result.reconciled += 1;
    }
  }

  async #retryTransient<T>(
    operation: () => Promise<T>,
    result: PasskeySignupExpirySweepResult
  ): Promise<T> {
    let retries = 0;
    while (true) {
      try {
        return await operation();
      } catch (error) {
        if (
          !transientSqliteError(error)
          || retries >= this.#options.maxTransientRetries
        ) throw error;
        const exponent = Math.min(retries, 30);
        const delayMs = Math.min(
          this.#options.retryMaxMs,
          this.#options.retryBaseMs * (2 ** exponent)
        );
        result.retries += 1;
        retries += 1;
        await this.#options.wait(delayMs);
      }
    }
  }
}
