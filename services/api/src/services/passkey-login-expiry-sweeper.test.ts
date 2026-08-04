import { createHash } from "node:crypto";

import {
  StoreDuplicateCommandError,
  StoreRevisionConflictError
} from "@luxora/passkey-domain";
import { describe, expect, it } from "vitest";

import type { PersistPasskeyLoginTerminal } from "../domain/store.js";
import type { PasskeyLoginIntentRecord } from "../domain/types.js";
import { PasskeyLoginExpirySweeper } from "./passkey-login-expiry-sweeper.js";

const NOW_MS = 1_800_000_300_000;
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
): PasskeyLoginIntentRecord {
  return Object.freeze({
    intentId,
    schemaVersion: 1,
    purpose: Object.freeze({
      type: "session.create" as const,
      targetDigest: digest("session.create")
    }),
    policyVersion: 1,
    accessTokenTtlSeconds: 900,
    sessionTtlSeconds: 2_592_000,
    recoveryGraceSeconds: 300,
    expectedRpId: "auth.luxora.app",
    expectedOrigin: "https://auth.luxora.app",
    timeoutMs: 300_000,
    maxResponseBytes: 65_536,
    maxAttempts: 3,
    allowedAlgorithms: Object.freeze([-7, -257] as const),
    userVerification: "required" as const,
    crossOriginAllowed: false as const,
    credentialBoundary: Object.freeze({
      mode: "discoverable_any" as const,
      credentialSetRef: null
    }),
    challenge: Object.freeze({
      reference: `challenge-${intentId}`,
      digest: digest(`challenge-${intentId}`)
    }),
    deliveryNonceDigest: digest(`delivery-${intentId}`),
    refreshDerivationKeyId: "v1.active",
    state: "pending" as const,
    revision,
    attemptsUsed: revision - 1,
    createdAtMs: expiresAtMs - 300_000,
    expiresAtMs,
    updatedAtMs: expiresAtMs - 1,
    terminalAtMs: null,
    terminalReason: null,
    resolution: null
  });
}

function uuidFactory(): () => string {
  let sequence = 0;
  return () => {
    sequence += 1;
    return `00000000-0000-4000-8000-${String(sequence).padStart(12, "0")}`;
  };
}

class FakeExpiryStore {
  readonly candidates: PasskeyLoginIntentRecord[];
  readonly mutations: PersistPasskeyLoginTerminal[] = [];
  readonly requestedLimits: number[] = [];
  commitFailure: ((mutation: PersistPasskeyLoginTerminal) => Error | null) | null = null;

  constructor(candidates: readonly PasskeyLoginIntentRecord[]) {
    this.candidates = [...candidates];
  }

  async listExpiredPendingPasskeyLoginIntents(
    observedAtMs: number,
    limit: number
  ): Promise<readonly PasskeyLoginIntentRecord[]> {
    this.requestedLimits.push(limit);
    return this.candidates
      .filter((value) => value.state === "pending" && value.expiresAtMs <= observedAtMs)
      .sort((left, right) => left.expiresAtMs - right.expiresAtMs
        || left.intentId.localeCompare(right.intentId))
      .slice(0, limit);
  }

  async commitPasskeyLoginTerminal(input: PersistPasskeyLoginTerminal): Promise<void> {
    this.mutations.push(input);
    const failure = this.commitFailure?.(input) ?? null;
    if (failure !== null) throw failure;
    const index = this.candidates.findIndex((value) => value.intentId === input.intentId);
    if (index < 0) throw new StoreRevisionConflictError();
    this.candidates.splice(index, 1);
  }
}

describe("PasskeyLoginExpirySweeper", () => {
  it("bounds each run by batch size and maximum batches", async () => {
    const store = new FakeExpiryStore([
      candidate(INTENT_E, NOW_MS - 1),
      candidate(INTENT_C, NOW_MS - 3),
      candidate(INTENT_A, NOW_MS - 5),
      candidate(INTENT_D, NOW_MS - 2),
      candidate(INTENT_B, NOW_MS - 4)
    ]);
    const sweeper = new PasskeyLoginExpirySweeper(store, {
      batchSize: 2,
      maxBatchesPerSweep: 2,
      clock: () => NOW_MS,
      idFactory: uuidFactory()
    });

    await expect(sweeper.sweep()).resolves.toEqual({
      scanned: 4,
      expired: 4,
      skipped: 0,
      batches: 2,
      busy: false
    });
    expect(store.requestedLimits).toEqual([2, 2]);
    expect(store.mutations.map((value) => value.intentId)).toEqual([
      INTENT_A,
      INTENT_B,
      INTENT_C,
      INTENT_D
    ]);
    expect(store.candidates.map((value) => value.intentId)).toEqual([INTENT_E]);
  });

  it("builds a secret-free deterministic system proof and canonical mutation IDs", async () => {
    const firstStore = new FakeExpiryStore([candidate(INTENT_A)]);
    const first = new PasskeyLoginExpirySweeper(firstStore, {
      clock: () => NOW_MS,
      idFactory: uuidFactory()
    });
    await first.sweep();
    const mutation = firstStore.mutations[0];
    expect(mutation).toBeDefined();
    expect(mutation).toMatchObject({
      intentId: INTENT_A,
      expectedRevision: 1,
      terminalAtMs: NOW_MS,
      nextState: "expired",
      event: {
        revision: 2,
        type: "passkey.login.expired",
        state: "expired",
        occurredAtMs: NOW_MS
      },
      outbox: {
        topic: "luxora.passkey-login.v1",
        partitionKey: INTENT_A,
        availableAtMs: NOW_MS
      },
      commandReceipt: {
        resultRevision: 2,
        resultState: "expired",
        createdAtMs: NOW_MS
      }
    });
    expect(mutation!.event.eventId).toMatch(/^[0-9a-f-]{36}$/);
    expect(mutation!.outbox.outboxId).toMatch(/^[0-9a-f-]{36}$/);
    expect(mutation!.event.commandScope).toMatch(/^[0-9a-f]{64}$/);
    expect(mutation!.commandReceipt.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(mutation!.event.commandScope).not.toContain("challenge");
    expect(mutation!.commandReceipt.fingerprint).not.toContain("delivery");

    const replayStore = new FakeExpiryStore([candidate(INTENT_A)]);
    await new PasskeyLoginExpirySweeper(replayStore, {
      clock: () => NOW_MS + 999,
      idFactory: uuidFactory()
    }).sweep();
    expect(replayStore.mutations[0]!.event.commandScope)
      .toBe(mutation!.event.commandScope);
    expect(replayStore.mutations[0]!.commandReceipt.fingerprint)
      .toBe(mutation!.commandReceipt.fingerprint);
  });

  it("skips concurrent CAS and already-receipted winners, then continues", async () => {
    const store = new FakeExpiryStore([
      candidate(INTENT_A),
      candidate(INTENT_B),
      candidate(INTENT_C)
    ]);
    store.commitFailure = (mutation) => {
      if (mutation.intentId === INTENT_A || mutation.intentId === INTENT_B) {
        const index = store.candidates.findIndex((value) => value.intentId === mutation.intentId);
        if (index >= 0) store.candidates.splice(index, 1);
      }
      if (mutation.intentId === INTENT_A) return new StoreRevisionConflictError();
      if (mutation.intentId === INTENT_B) return new StoreDuplicateCommandError();
      return null;
    };
    const sweeper = new PasskeyLoginExpirySweeper(store, {
      batchSize: 3,
      maxBatchesPerSweep: 1,
      clock: () => NOW_MS,
      idFactory: uuidFactory()
    });

    await expect(sweeper.sweep()).resolves.toEqual({
      scanned: 3,
      expired: 1,
      skipped: 2,
      batches: 1,
      busy: false
    });
    expect(store.mutations).toHaveLength(3);
  });

  it("is empty-idempotent and rejects overlapping work without a second Store read", async () => {
    let release: (() => void) | undefined;
    const store = new FakeExpiryStore([]);
    const original = store.listExpiredPendingPasskeyLoginIntents.bind(store);
    store.listExpiredPendingPasskeyLoginIntents = async (observedAtMs, limit) => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return original(observedAtMs, limit);
    };
    const sweeper = new PasskeyLoginExpirySweeper(store, {
      clock: () => NOW_MS,
      idFactory: uuidFactory()
    });
    const running = sweeper.sweep();
    await Promise.resolve();
    await expect(sweeper.sweep()).resolves.toEqual({
      scanned: 0,
      expired: 0,
      skipped: 0,
      batches: 0,
      busy: true
    });
    release?.();
    await expect(running).resolves.toEqual({
      scanned: 0,
      expired: 0,
      skipped: 0,
      batches: 1,
      busy: false
    });
    expect(store.requestedLimits).toEqual([100]);
  });

  it("fails closed on coercive options, clocks, candidates, and generated IDs", async () => {
    const store = new FakeExpiryStore([]);
    for (const options of [
      { batchSize: 0 },
      { batchSize: 1_001 },
      { batchSize: "2" },
      { maxBatchesPerSweep: 0 },
      { maxBatchesPerSweep: 1_001 },
      { maxBatchesPerSweep: "2" }
    ]) {
      expect(() => new PasskeyLoginExpirySweeper(
        store,
        options as never
      )).toThrow(/positive safe integer/);
    }

    await expect(new PasskeyLoginExpirySweeper(store, {
      clock: () => Number.NaN
    }).sweep()).rejects.toThrow(/clock/);

    const invalidIdStore = new FakeExpiryStore([candidate(INTENT_A)]);
    await expect(new PasskeyLoginExpirySweeper(invalidIdStore, {
      clock: () => NOW_MS,
      idFactory: () => "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA"
    }).sweep()).rejects.toThrow(/canonical UUID/);
    expect(invalidIdStore.mutations).toHaveLength(0);

    const proxy = new Proxy(candidate(INTENT_A), {});
    const hostileStore = new FakeExpiryStore([]);
    hostileStore.listExpiredPendingPasskeyLoginIntents = async () => [proxy];
    await expect(new PasskeyLoginExpirySweeper(hostileStore, {
      clock: () => NOW_MS,
      idFactory: uuidFactory()
    }).sweep()).rejects.toThrow(/candidate is invalid/);
    expect(hostileStore.mutations).toHaveLength(0);
  });
});
