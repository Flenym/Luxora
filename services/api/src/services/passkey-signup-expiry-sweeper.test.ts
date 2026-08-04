import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  PASSKEY_CHALLENGE_BYTES,
  StoreDuplicateCommandError,
  StoreRevisionConflictError
} from "@luxora/passkey-domain";
import { afterEach, describe, expect, it } from "vitest";

import type {
  PersistPasskeySignupBegin,
  PersistPasskeySignupExpired
} from "../domain/store.js";
import type {
  PasskeySignupIntentRecord,
  PasskeySignupReceiptRecord
} from "../domain/types.js";
import { AesGcmContentCipher } from "../infrastructure/content-cipher.js";
import { SqliteStore } from "../infrastructure/sqlite-store.js";
import {
  PasskeySignupExpirySweeper,
  type PasskeySignupExpirySweeperOptions
} from "./passkey-signup-expiry-sweeper.js";

const NOW_MS = 1_800_000_300_000;
const TIMEOUT_MS = 300_000;
const INTENT_A = "11111111-1111-4111-8111-111111111111";
const INTENT_B = "22222222-2222-4222-8222-222222222222";
const INTENT_C = "33333333-3333-4333-8333-333333333333";
const INTENT_D = "44444444-4444-4444-8444-444444444444";
const INTENT_E = "55555555-5555-4555-8555-555555555555";

function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function candidate(
  intentId: string,
  expiresAtMs = NOW_MS - 1,
  revision = 1
): PasskeySignupIntentRecord {
  const attemptsUsed = revision - 1;
  return Object.freeze({
    intentId,
    schemaVersion: 1,
    purpose: Object.freeze({
      type: "account.create" as const,
      targetDigest: digest(`policy-${intentId}`)
    }),
    policyVersion: 1,
    rpName: "Luxora" as const,
    expectedRpId: "auth.luxora.app",
    expectedOrigin: "https://auth.luxora.app",
    expectedTopOrigins: Object.freeze([]) as readonly [],
    timeoutMs: TIMEOUT_MS,
    maxResponseBytes: 65_536,
    maxAttempts: 3,
    allowedAlgorithms: Object.freeze([-7, -257] as const),
    requireUserPresence: true as const,
    userVerification: "required" as const,
    residentKey: "required" as const,
    attestation: "none" as const,
    crossOriginAllowed: false as const,
    excludeCredentials: Object.freeze([]) as readonly [],
    candidate: Object.freeze({
      accountId: randomUUID(),
      username: `Expiry${intentId.slice(0, 4)}`,
      usernameNormalized: `expiry${intentId.slice(0, 4)}`,
      displayName: `SECRET-DISPLAY-${intentId}`,
      userHandleRef: `SECRET-HANDLE-REF-${intentId}`,
      userHandle: new Uint8Array(32).fill(revision)
    }),
    challenge: Object.freeze({
      reference: `SECRET-CHALLENGE-REF-${intentId}`,
      digest: digest(`SECRET-CHALLENGE-${intentId}`)
    }),
    deliveryNonceDigest: digest(`SECRET-DELIVERY-${intentId}`),
    state: "pending" as const,
    revision,
    attemptsUsed,
    createdAtMs: expiresAtMs - TIMEOUT_MS,
    expiresAtMs,
    updatedAtMs: expiresAtMs - 1,
    terminalAtMs: null,
    terminalReason: null,
    resolvedCredentialRecordId: null
  });
}

function uuidFactory(prefix = "0"): () => string {
  let sequence = 0;
  return () => {
    sequence += 1;
    return `${prefix.repeat(8)}-0000-4000-8000-${String(sequence).padStart(12, "0")}`;
  };
}

function proof(
  kind: "command-scope" | "fingerprint",
  value: Pick<PasskeySignupIntentRecord, "intentId" | "revision" | "expiresAtMs">
): string {
  return digest([
    "luxora.passkey-signup.expiry-sweeper.v1",
    kind,
    value.intentId,
    String(value.revision),
    String(value.expiresAtMs)
  ].join("\n"));
}

function sqliteBusy(code = "SQLITE_BUSY"): Error & { code: string } {
  return Object.assign(new Error("synthetic SQLite contention"), { code });
}

class FakeExpiryStore {
  readonly candidates: PasskeySignupIntentRecord[];
  readonly receipts = new Map<string, PasskeySignupReceiptRecord>();
  readonly mutations: PersistPasskeySignupExpired[] = [];
  readonly requestedLimits: number[] = [];
  readonly observedTimes: number[] = [];
  readonly listFailures: Error[] = [];
  readonly commitFailures = new Map<string, Error[]>();
  readonly revisionWinners = new Set<string>();
  readonly duplicateWinners = new Set<string>();
  readonly ambiguousBusyWinners = new Set<string>();

  constructor(candidates: readonly PasskeySignupIntentRecord[]) {
    this.candidates = [...candidates];
  }

  async listExpiredPendingPasskeySignupIntents(
    observedAtMs: number,
    limit: number
  ): Promise<readonly PasskeySignupIntentRecord[]> {
    this.requestedLimits.push(limit);
    this.observedTimes.push(observedAtMs);
    const failure = this.listFailures.shift();
    if (failure !== undefined) throw failure;
    return this.candidates
      .filter((value) => value.state === "pending" && value.expiresAtMs <= observedAtMs)
      .sort((left, right) => left.expiresAtMs - right.expiresAtMs
        || left.intentId.localeCompare(right.intentId))
      .slice(0, limit);
  }

  async findPasskeySignupCommandReceipt(scope: string): Promise<PasskeySignupReceiptRecord | null> {
    return this.receipts.get(scope) ?? null;
  }

  async commitPasskeySignupExpired(input: PersistPasskeySignupExpired): Promise<void> {
    this.mutations.push(input);
    if (this.receipts.has(input.commandReceipt.scope)) throw new StoreDuplicateCommandError();
    const failures = this.commitFailures.get(input.intentId);
    const failure = failures?.shift();
    if (failure !== undefined) throw failure;
    if (this.revisionWinners.delete(input.intentId)) {
      this.#remove(input.intentId);
      throw new StoreRevisionConflictError();
    }
    if (this.duplicateWinners.delete(input.intentId)) {
      this.#apply(input);
      throw new StoreDuplicateCommandError();
    }
    if (this.ambiguousBusyWinners.delete(input.intentId)) {
      this.#apply(input);
      throw sqliteBusy();
    }
    this.#apply(input);
  }

  #apply(input: PersistPasskeySignupExpired): void {
    const index = this.candidates.findIndex((value) => value.intentId === input.intentId);
    if (index < 0) throw new StoreRevisionConflictError();
    this.candidates.splice(index, 1);
    this.receipts.set(input.commandReceipt.scope, input.commandReceipt);
  }

  #remove(intentId: string): void {
    const index = this.candidates.findIndex((value) => value.intentId === intentId);
    if (index >= 0) this.candidates.splice(index, 1);
  }
}

describe("PasskeySignupExpirySweeper", () => {
  it("bounds one run by ordered batch size and maximum batches", async () => {
    const store = new FakeExpiryStore([
      candidate(INTENT_E, NOW_MS - 1),
      candidate(INTENT_C, NOW_MS - 3),
      candidate(INTENT_A, NOW_MS - 5),
      candidate(INTENT_D, NOW_MS - 2),
      candidate(INTENT_B, NOW_MS - 4)
    ]);
    const sweeper = new PasskeySignupExpirySweeper(store, {
      batchSize: 2,
      maxBatchesPerSweep: 2,
      clock: () => NOW_MS,
      idFactory: uuidFactory()
    });

    await expect(sweeper.sweep()).resolves.toEqual({
      scanned: 4,
      expired: 4,
      reconciled: 0,
      skipped: 0,
      batches: 2,
      retries: 0,
      busy: false
    });
    expect(store.requestedLimits).toEqual([2, 2]);
    expect(store.mutations.map(({ intentId }) => intentId)).toEqual([
      INTENT_A, INTENT_B, INTENT_C, INTENT_D
    ]);
    expect(store.candidates.map(({ intentId }) => intentId)).toEqual([INTENT_E]);
  });

  it("builds deterministic restart proofs without identity or secret material", async () => {
    const firstStore = new FakeExpiryStore([candidate(INTENT_A)]);
    await new PasskeySignupExpirySweeper(firstStore, {
      clock: () => NOW_MS,
      idFactory: uuidFactory()
    }).sweep();
    const first = firstStore.mutations[0];
    expect(first).toBeDefined();
    expect(first).toMatchObject({
      intentId: INTENT_A,
      expectedRevision: 1,
      terminalAtMs: NOW_MS,
      nextState: "expired",
      event: { type: "passkey.signup.expired", state: "expired", revision: 2 },
      outbox: { topic: "luxora.passkey-signup.v1", partitionKey: INTENT_A },
      commandReceipt: { resultRevision: 2, resultState: "expired" }
    });
    expect(first?.event.commandScope).toBe(proof("command-scope", candidate(INTENT_A)));
    expect(first?.commandReceipt.fingerprint).toBe(proof("fingerprint", candidate(INTENT_A)));
    expect(JSON.stringify(first)).not.toMatch(/SECRET|Expiry1111|delivery|challenge|handle/i);

    const restartedStore = new FakeExpiryStore([candidate(INTENT_A)]);
    await new PasskeySignupExpirySweeper(restartedStore, {
      clock: () => NOW_MS + 999,
      idFactory: uuidFactory("1")
    }).sweep();
    expect(restartedStore.mutations[0]?.event.commandScope).toBe(first?.event.commandScope);
    expect(restartedStore.mutations[0]?.commandReceipt.fingerprint)
      .toBe(first?.commandReceipt.fingerprint);
  });

  it("reconciles exact duplicate ownership and skips a different CAS winner", async () => {
    const store = new FakeExpiryStore([
      candidate(INTENT_A), candidate(INTENT_B), candidate(INTENT_C)
    ]);
    store.revisionWinners.add(INTENT_A);
    store.duplicateWinners.add(INTENT_B);
    const result = await new PasskeySignupExpirySweeper(store, {
      batchSize: 3,
      maxBatchesPerSweep: 1,
      clock: () => NOW_MS,
      idFactory: uuidFactory()
    }).sweep();

    expect(result).toEqual({
      scanned: 3,
      expired: 1,
      reconciled: 1,
      skipped: 1,
      batches: 1,
      retries: 0,
      busy: false
    });
    expect(store.candidates).toHaveLength(0);
  });

  it("serializes overlapping calls and is empty-idempotent", async () => {
    let release: (() => void) | undefined;
    let enter: (() => void) | undefined;
    let shouldBlock = true;
    const entered = new Promise<void>((resolve) => { enter = resolve; });
    const store = new FakeExpiryStore([]);
    const original = store.listExpiredPendingPasskeySignupIntents.bind(store);
    store.listExpiredPendingPasskeySignupIntents = async (observedAtMs, limit) => {
      if (shouldBlock) {
        shouldBlock = false;
        await new Promise<void>((resolve) => {
          release = resolve;
          enter?.();
        });
      }
      return original(observedAtMs, limit);
    };
    const sweeper = new PasskeySignupExpirySweeper(store, {
      clock: () => NOW_MS,
      idFactory: uuidFactory()
    });
    const running = sweeper.sweep();
    await entered;
    await expect(sweeper.sweep()).resolves.toEqual({
      scanned: 0,
      expired: 0,
      reconciled: 0,
      skipped: 0,
      batches: 0,
      retries: 0,
      busy: true
    });
    release?.();
    await expect(running).resolves.toEqual({
      scanned: 0,
      expired: 0,
      reconciled: 0,
      skipped: 0,
      batches: 1,
      retries: 0,
      busy: false
    });
    await expect(sweeper.sweep()).resolves.toMatchObject({ scanned: 0, expired: 0 });
  });

  it("uses bounded deterministic BUSY/LOCKED backoff without resampling the clock", async () => {
    let clockCalls = 0;
    const waits: number[] = [];
    const store = new FakeExpiryStore([candidate(INTENT_A)]);
    store.listFailures.push(sqliteBusy(), sqliteBusy("SQLITE_LOCKED"));
    store.commitFailures.set(INTENT_A, [sqliteBusy()]);
    const result = await new PasskeySignupExpirySweeper(store, {
      clock: () => {
        clockCalls += 1;
        return NOW_MS;
      },
      idFactory: uuidFactory(),
      maxTransientRetries: 3,
      retryBaseMs: 10,
      retryMaxMs: 20,
      wait: async (delayMs) => { waits.push(delayMs); }
    }).sweep();

    expect(result).toMatchObject({ expired: 1, retries: 3 });
    expect(waits).toEqual([10, 20, 10]);
    expect(clockCalls).toBe(1);
    expect(new Set(store.observedTimes)).toEqual(new Set([NOW_MS]));
  });

  it("recovers commit-after-apply ambiguity through backoff and the exact receipt", async () => {
    const waits: number[] = [];
    const store = new FakeExpiryStore([candidate(INTENT_A)]);
    store.ambiguousBusyWinners.add(INTENT_A);
    const result = await new PasskeySignupExpirySweeper(store, {
      clock: () => NOW_MS,
      idFactory: uuidFactory(),
      retryBaseMs: 7,
      retryMaxMs: 7,
      wait: async (delayMs) => { waits.push(delayMs); }
    }).sweep();

    expect(result).toEqual({
      scanned: 1,
      expired: 0,
      reconciled: 1,
      skipped: 0,
      batches: 1,
      retries: 1,
      busy: false
    });
    expect(waits).toEqual([7]);
    expect(store.mutations).toHaveLength(2);
  });

  it("caps transient retries, propagates unknown failures and releases its guard", async () => {
    const waits: number[] = [];
    const store = new FakeExpiryStore([candidate(INTENT_A)]);
    store.listFailures.push(sqliteBusy(), sqliteBusy(), sqliteBusy());
    const sweeper = new PasskeySignupExpirySweeper(store, {
      clock: () => NOW_MS,
      idFactory: uuidFactory(),
      maxTransientRetries: 2,
      retryBaseMs: 5,
      retryMaxMs: 10,
      wait: async (delayMs) => { waits.push(delayMs); }
    });
    await expect(sweeper.sweep()).rejects.toMatchObject({ code: "SQLITE_BUSY" });
    expect(waits).toEqual([5, 10]);
    await expect(sweeper.sweep()).resolves.toMatchObject({ expired: 1, busy: false });

    const unknownStore = new FakeExpiryStore([candidate(INTENT_B)]);
    unknownStore.commitFailures.set(INTENT_B, [new Error("non-transient corruption")]);
    const unknownWaits: number[] = [];
    await expect(new PasskeySignupExpirySweeper(unknownStore, {
      clock: () => NOW_MS,
      idFactory: uuidFactory(),
      wait: async (delayMs) => { unknownWaits.push(delayMs); }
    }).sweep()).rejects.toThrow("non-transient corruption");
    expect(unknownWaits).toEqual([]);
  });

  it("fails closed on hostile options, clocks, candidates, batches, receipts and IDs", async () => {
    const store = new FakeExpiryStore([]);
    for (const options of [
      { batchSize: 0 },
      { batchSize: 1_001 },
      { batchSize: "2" },
      { maxBatchesPerSweep: 0 },
      { maxTransientRetries: -1 },
      { maxTransientRetries: 11 },
      { retryBaseMs: 0 },
      { retryMaxMs: 60_001 },
      { retryBaseMs: 20, retryMaxMs: 10 },
      { unknown: true }
    ]) expect(() => new PasskeySignupExpirySweeper(
      store,
      options as PasskeySignupExpirySweeperOptions
    )).toThrow();

    let optionReads = 0;
    const accessor = {} as PasskeySignupExpirySweeperOptions;
    Object.defineProperty(accessor, "batchSize", {
      enumerable: true,
      get() {
        optionReads += 1;
        throw new Error("CANARY");
      }
    });
    expect(() => new PasskeySignupExpirySweeper(store, accessor)).toThrow(/options/);
    expect(optionReads).toBe(0);

    await expect(new PasskeySignupExpirySweeper(store, {
      clock: () => Number.NaN
    }).sweep()).rejects.toThrow(/clock/);
    const badIdStore = new FakeExpiryStore([candidate(INTENT_A)]);
    await expect(new PasskeySignupExpirySweeper(badIdStore, {
      clock: () => NOW_MS,
      idFactory: () => "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA"
    }).sweep()).rejects.toThrow(/canonical UUID/);
    expect(badIdStore.mutations).toHaveLength(0);

    const hostileStore = new FakeExpiryStore([]);
    hostileStore.listExpiredPendingPasskeySignupIntents = async () => [
      new Proxy(candidate(INTENT_A), {})
    ];
    await expect(new PasskeySignupExpirySweeper(hostileStore, {
      clock: () => NOW_MS,
      idFactory: uuidFactory()
    }).sweep()).rejects.toThrow(/candidate is invalid/);

    const oversizedStore = new FakeExpiryStore([]);
    oversizedStore.listExpiredPendingPasskeySignupIntents = async () => [
      candidate(INTENT_A), candidate(INTENT_B)
    ];
    await expect(new PasskeySignupExpirySweeper(oversizedStore, {
      batchSize: 1,
      clock: () => NOW_MS,
      idFactory: uuidFactory()
    }).sweep()).rejects.toThrow(/invalid batch/);

    const receiptStore = new FakeExpiryStore([candidate(INTENT_C)]);
    receiptStore.duplicateWinners.add(INTENT_C);
    const scope = proof("command-scope", candidate(INTENT_C));
    const originalFind = receiptStore.findPasskeySignupCommandReceipt.bind(receiptStore);
    receiptStore.findPasskeySignupCommandReceipt = async (requested) => {
      const receipt = await originalFind(requested);
      return receipt === null ? null : { ...receipt, resultState: "consumed" };
    };
    await expect(new PasskeySignupExpirySweeper(receiptStore, {
      clock: () => NOW_MS,
      idFactory: uuidFactory()
    }).sweep()).rejects.toThrow(/receipt is inconsistent/);
    expect(scope).toMatch(/^[a-f0-9]{64}$/u);
  });
});

interface SqliteFixture {
  readonly directory: string;
  readonly path: string;
  readonly key: string;
  readonly clock: { value: number };
  store: SqliteStore | null;
}

const sqliteFixtures: SqliteFixture[] = [];

afterEach(() => {
  for (const item of sqliteFixtures.splice(0)) {
    try { item.store?.close(); } catch { /* already closed */ }
    rmSync(item.directory, { recursive: true, force: true });
  }
});

function sqliteFixture(): SqliteFixture {
  const directory = mkdtempSync(join(tmpdir(), "luxora-signup-expiry-"));
  const path = join(directory, "signup.sqlite");
  const key = randomBytes(32).toString("base64url");
  const clock = { value: NOW_MS - TIMEOUT_MS };
  const store = new SqliteStore(
    path,
    new AesGcmContentCipher({ active: key }, "active"),
    () => clock.value
  );
  const item = { directory, path, key, clock, store };
  sqliteFixtures.push(item);
  return item;
}

async function persistPendingSignup(
  store: SqliteStore,
  createdAtMs: number,
  intentId = INTENT_A
): Promise<{ readonly challengeReference: string }> {
  const expiresAtMs = createdAtMs + TIMEOUT_MS;
  const issued = await store.issue({
    byteLength: PASSKEY_CHALLENGE_BYTES,
    expiresAtMs
  });
  const eventId = randomUUID();
  const commandScope = `signup-begin:${intentId}`;
  const commandFingerprint = digest(`signup-begin:${intentId}`);
  const persist: PersistPasskeySignupBegin = {
    intent: {
      intentId,
      schemaVersion: 1,
      purpose: { type: "account.create", targetDigest: digest(`policy:${intentId}`) },
      policyVersion: 1,
      rpName: "Luxora",
      expectedRpId: "auth.luxora.app",
      expectedOrigin: "https://auth.luxora.app",
      expectedTopOrigins: [],
      timeoutMs: TIMEOUT_MS,
      maxResponseBytes: 65_536,
      maxAttempts: 3,
      allowedAlgorithms: [-7, -257],
      requireUserPresence: true,
      userVerification: "required",
      residentKey: "required",
      attestation: "none",
      crossOriginAllowed: false,
      excludeCredentials: [],
      candidate: {
        accountId: randomUUID(),
        username: `Restart${intentId.slice(0, 4)}`,
        usernameNormalized: `restart${intentId.slice(0, 4)}`,
        displayName: "Restart Signup",
        userHandleRef: randomUUID(),
        userHandle: new Uint8Array(randomBytes(32))
      },
      challenge: {
        reference: issued.reference,
        digest: createHash("sha256")
          .update(Buffer.from(issued.challenge, "base64url"))
          .digest("hex")
      },
      deliveryNonceDigest: digest(`delivery:${intentId}`),
      state: "pending",
      revision: 1,
      attemptsUsed: 0,
      createdAtMs,
      expiresAtMs,
      updatedAtMs: createdAtMs,
      terminalAtMs: null,
      terminalReason: null,
      resolvedCredentialRecordId: null
    },
    event: {
      eventId,
      intentId,
      revision: 1,
      type: "passkey.signup.started",
      commandScope,
      occurredAtMs: createdAtMs,
      state: "pending"
    },
    outbox: {
      outboxId: randomUUID(),
      topic: "luxora.passkey-signup.v1",
      partitionKey: intentId,
      eventId,
      availableAtMs: createdAtMs
    },
    commandReceipt: {
      scope: commandScope,
      fingerprint: commandFingerprint,
      intentId,
      resultRevision: 1,
      resultState: "pending",
      eventId,
      createdAtMs
    },
    creationReceipt: {
      scope: `signup-creation:${intentId}`,
      fingerprint: digest(`signup-creation:${intentId}`),
      intentId,
      resultRevision: 1,
      resultState: "pending",
      eventId,
      createdAtMs
    }
  };
  await store.commitPasskeySignupBegin(persist);
  return { challengeReference: issued.reference };
}

describe("PasskeySignupExpirySweeper with SqliteStore", () => {
  it("reconciles a pre-crash intent after restart, removes its challenge and stays idempotent", async () => {
    const item = sqliteFixture();
    const firstStore = item.store;
    if (firstStore === null) throw new Error("missing fixture store");
    const { challengeReference } = await persistPendingSignup(
      firstStore,
      item.clock.value
    );
    expect(await firstStore.resolve(challengeReference)).not.toBeNull();
    firstStore.close();
    item.store = null;

    item.clock.value = NOW_MS;
    const restarted = new SqliteStore(
      item.path,
      new AesGcmContentCipher({ active: item.key }, "active"),
      () => item.clock.value
    );
    item.store = restarted;
    const firstSweep = await new PasskeySignupExpirySweeper(restarted, {
      clock: () => item.clock.value,
      idFactory: uuidFactory()
    }).sweep();
    expect(firstSweep).toMatchObject({ expired: 1, reconciled: 0, skipped: 0 });
    expect(await restarted.findPasskeySignupIntent(INTENT_A)).toMatchObject({
      state: "expired",
      revision: 2,
      terminalReason: "expired",
      terminalAtMs: NOW_MS
    });
    expect(await restarted.resolve(challengeReference)).toBeNull();
    expect(await restarted.findPasskeySignupCommandReceipt(
      proof("command-scope", candidate(INTENT_A, NOW_MS))
    )).toMatchObject({ resultState: "expired", resultRevision: 2 });

    const afterRestart = await new PasskeySignupExpirySweeper(restarted, {
      clock: () => item.clock.value,
      idFactory: uuidFactory("1")
    }).sweep();
    expect(afterRestart).toMatchObject({ scanned: 0, expired: 0, reconciled: 0 });
  });

  it("lets one of two SQLite owners win while the other reconciles the same proof", async () => {
    const item = sqliteFixture();
    const first = item.store;
    if (first === null) throw new Error("missing fixture store");
    const { challengeReference } = await persistPendingSignup(first, item.clock.value);
    item.clock.value = NOW_MS;
    const second = new SqliteStore(
      item.path,
      new AesGcmContentCipher({ active: item.key }, "active"),
      () => item.clock.value
    );
    try {
      const [left, right] = await Promise.all([
        new PasskeySignupExpirySweeper(first, {
          clock: () => item.clock.value,
          idFactory: uuidFactory("2")
        }).sweep(),
        new PasskeySignupExpirySweeper(second, {
          clock: () => item.clock.value,
          idFactory: uuidFactory("3")
        }).sweep()
      ]);
      expect(left.expired + right.expired).toBe(1);
      expect(left.reconciled + right.reconciled + left.skipped + right.skipped).toBe(1);
      expect(await first.findPasskeySignupIntent(INTENT_A)).toMatchObject({ state: "expired" });
      expect(await second.resolve(challengeReference)).toBeNull();
      expect(await first.listExpiredPendingPasskeySignupIntents(NOW_MS, 10)).toEqual([]);
    } finally {
      second.close();
    }
  });
});
