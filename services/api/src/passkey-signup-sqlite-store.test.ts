import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";

import {
  PASSKEY_CHALLENGE_BYTES,
  StoreCredentialConflictError,
  StoreDuplicateCommandError,
  StoreRevisionConflictError
} from "@luxora/passkey-domain";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import type {
  PasskeySignupEventType,
  PersistPasskeySignupBegin,
  PersistPasskeySignupExpired,
  PersistPasskeySignupRejectedAttempt,
  PersistVerifiedPasskeySignup
} from "./domain/store.js";
import type { PasskeySignupIntentState } from "./domain/types.js";
import { AesGcmContentCipher } from "./infrastructure/content-cipher.js";
import { SqliteStore } from "./infrastructure/sqlite-store.js";
import { createPasskeyDisabledPasswordHash } from "./services/password-auth.js";

const NOW_MS = 1_800_000_000_000;
const TIMEOUT_MS = 300_000;
const INTENT_A = "11111111-1111-4111-8111-111111111111";
const INTENT_B = "22222222-2222-4222-8222-222222222222";
const INTENT_C = "33333333-3333-4333-8333-333333333333";
const ACCOUNT_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ACCOUNT_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const ACCOUNT_C = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const SESSION_A = "44444444-4444-4444-8444-444444444444";
const SESSION_B = "55555555-5555-4555-8555-555555555555";
const REFRESH_A = "66666666-6666-4666-8666-666666666666";
const REFRESH_B = "77777777-7777-4777-8777-777777777777";
const USERNAME = "FlenymSignup";
const USERNAME_NORMALIZED = "flenymsignup";
const DISPLAY_NAME = "Flenym Signup";

interface MutableClock { value: number }

interface Fixture {
  directory: string;
  path: string;
  encodedKey: string;
  cipher: AesGcmContentCipher;
  clock: MutableClock;
  store: SqliteStore;
}

const fixtures: Fixture[] = [];
const workers: Worker[] = [];

interface CommitRaceOutcome {
  ok: boolean;
  name?: string;
}

interface CommitWorker {
  worker: Worker;
  ready: Promise<void>;
  outcome: Promise<CommitRaceOutcome>;
}

function digestText(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function digestBase64urlBytes(value: string): string {
  return createHash("sha256").update(Buffer.from(value, "base64url")).digest("hex");
}

function fixture(): Fixture {
  const directory = mkdtempSync(join(tmpdir(), "luxora-passkey-signup-store-"));
  const path = join(directory, "signup.sqlite");
  const key = randomBytes(32).toString("base64url");
  const cipher = new AesGcmContentCipher({ active: key }, "active");
  const clock = { value: NOW_MS };
  const store = new SqliteStore(path, cipher, () => clock.value);
  const created = { directory, path, encodedKey: key, cipher, clock, store };
  fixtures.push(created);
  return created;
}

afterEach(async () => {
  await Promise.allSettled(workers.splice(0).map(async (worker) => worker.terminate()));
  for (const item of fixtures.splice(0)) {
    try { item.store.close(); } catch { /* already closed */ }
    rmSync(item.directory, { recursive: true, force: true });
  }
});

function startRejectedAttemptWorker(
  item: Fixture,
  gate: SharedArrayBuffer,
  input: PersistPasskeySignupRejectedAttempt
): CommitWorker {
  const worker = new Worker(
    new URL("./test-support/passkey-signup-commit-race-worker.ts", import.meta.url),
    {
      execArgv: ["--import", "tsx"],
      workerData: {
        operation: "rejected",
        databasePath: item.path,
        encodedKey: item.encodedKey,
        gate,
        input,
        nowMs: item.clock.value
      }
    }
  );
  workers.push(worker);
  let resolveReady: (() => void) | undefined;
  let rejectReady: ((error: Error) => void) | undefined;
  let resolveOutcome: ((outcome: CommitRaceOutcome) => void) | undefined;
  let rejectOutcome: ((error: Error) => void) | undefined;
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  const outcome = new Promise<CommitRaceOutcome>((resolve, reject) => {
    resolveOutcome = resolve;
    rejectOutcome = reject;
  });
  worker.on("message", (message: unknown) => {
    if (message === null || typeof message !== "object") return;
    const record = message as { type?: unknown; outcome?: unknown };
    if (record.type === "ready") resolveReady?.();
    if (record.type === "result") resolveOutcome?.(record.outcome as CommitRaceOutcome);
  });
  worker.on("error", (error) => {
    rejectReady?.(error);
    rejectOutcome?.(error);
  });
  worker.on("exit", (code) => {
    if (code === 0) return;
    const error = new Error(`Passkey signup commit worker exited with code ${code}`);
    rejectReady?.(error);
    rejectOutcome?.(error);
  });
  return { worker, ready, outcome };
}

function startVerifiedSignupWorker(
  item: Fixture,
  gate: SharedArrayBuffer,
  input: PersistVerifiedPasskeySignup
): CommitWorker {
  const worker = new Worker(
    new URL("./test-support/passkey-signup-commit-race-worker.ts", import.meta.url),
    {
      execArgv: ["--import", "tsx"],
      workerData: {
        operation: "verified",
        databasePath: item.path,
        encodedKey: item.encodedKey,
        gate,
        input,
        nowMs: item.clock.value
      }
    }
  );
  workers.push(worker);
  let resolveReady: (() => void) | undefined;
  let rejectReady: ((error: Error) => void) | undefined;
  let resolveOutcome: ((outcome: CommitRaceOutcome) => void) | undefined;
  let rejectOutcome: ((error: Error) => void) | undefined;
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  const outcome = new Promise<CommitRaceOutcome>((resolve, reject) => {
    resolveOutcome = resolve;
    rejectOutcome = reject;
  });
  worker.on("message", (message: unknown) => {
    if (message === null || typeof message !== "object") return;
    const record = message as { type?: unknown; outcome?: unknown };
    if (record.type === "ready") resolveReady?.();
    if (record.type === "result") resolveOutcome?.(record.outcome as CommitRaceOutcome);
  });
  worker.on("error", (error) => {
    rejectReady?.(error);
    rejectOutcome?.(error);
  });
  worker.on("exit", (code) => {
    if (code === 0) return;
    const error = new Error(`Passkey signup commit worker exited with code ${code}`);
    rejectReady?.(error);
    rejectOutcome?.(error);
  });
  return { worker, ready, outcome };
}

function mutation(
  intentId: string,
  revision: number,
  state: PasskeySignupIntentState,
  type: PasskeySignupEventType,
  atMs: number,
  label: string
) {
  const eventId = `signup-event:${label}`;
  const commandScope = `signup-command:${label}`;
  return {
    event: {
      eventId,
      intentId,
      revision,
      type,
      commandScope,
      occurredAtMs: atMs,
      state
    },
    outbox: {
      outboxId: `signup-outbox:${label}`,
      topic: "luxora.passkey-signup.v1" as const,
      partitionKey: intentId,
      eventId,
      availableAtMs: atMs
    },
    commandReceipt: {
      scope: commandScope,
      fingerprint: digestText(`command-fingerprint:${label}`),
      intentId,
      resultRevision: revision,
      resultState: state,
      eventId,
      createdAtMs: atMs
    }
  };
}

async function begun(
  item: Fixture,
  options: {
    intentId?: string;
    accountId?: string;
    userHandleRef?: string;
    userHandle?: Uint8Array;
    username?: string;
    usernameNormalized?: string;
    displayName?: string;
    timeoutMs?: number;
    maxAttempts?: number;
    label?: string;
  } = {}
): Promise<{ input: PersistPasskeySignupBegin; challenge: string }> {
  const intentId = options.intentId ?? INTENT_A;
  const timeoutMs = options.timeoutMs ?? TIMEOUT_MS;
  const createdAtMs = item.clock.value;
  const issued = await item.store.issue({
    byteLength: PASSKEY_CHALLENGE_BYTES,
    expiresAtMs: createdAtMs + timeoutMs
  });
  const deliveryNonce = randomBytes(32).toString("base64url");
  const label = options.label ?? intentId.slice(0, 8);
  const start = mutation(
    intentId,
    1,
    "pending",
    "passkey.signup.started",
    createdAtMs,
    `start:${label}`
  );
  const input: PersistPasskeySignupBegin = {
    intent: {
      intentId,
      schemaVersion: 1,
      purpose: { type: "account.create", targetDigest: digestText(`target:${label}`) },
      policyVersion: 1,
      rpName: "Luxora",
      expectedRpId: "auth.luxora.app",
      expectedOrigin: "https://auth.luxora.app",
      expectedTopOrigins: [],
      timeoutMs,
      maxResponseBytes: 65_536,
      maxAttempts: options.maxAttempts ?? 3,
      allowedAlgorithms: [-7, -257],
      requireUserPresence: true,
      userVerification: "required",
      residentKey: "required",
      attestation: "none",
      crossOriginAllowed: false,
      excludeCredentials: [],
      candidate: {
        accountId: options.accountId ?? ACCOUNT_A,
        username: options.username ?? USERNAME,
        usernameNormalized: options.usernameNormalized ?? USERNAME_NORMALIZED,
        displayName: options.displayName ?? DISPLAY_NAME,
        userHandleRef: options.userHandleRef ?? `signup-handle:${label}`,
        userHandle: options.userHandle ?? new Uint8Array(randomBytes(32))
      },
      challenge: {
        reference: issued.reference,
        digest: digestBase64urlBytes(issued.challenge)
      },
      deliveryNonceDigest: digestBase64urlBytes(deliveryNonce),
      state: "pending",
      revision: 1,
      attemptsUsed: 0,
      createdAtMs,
      expiresAtMs: createdAtMs + timeoutMs,
      updatedAtMs: createdAtMs,
      terminalAtMs: null,
      terminalReason: null,
      resolvedCredentialRecordId: null
    },
    ...start,
    creationReceipt: {
      scope: `signup-creation:${label}`,
      fingerprint: digestText(`creation-fingerprint:${label}`),
      intentId,
      resultRevision: 1,
      resultState: "pending",
      eventId: start.event.eventId,
      createdAtMs
    }
  };
  return { input, challenge: issued.challenge };
}

function rejected(
  input: PersistPasskeySignupBegin,
  expectedRevision: number,
  atMs: number,
  label: string,
  exhausted: boolean
): PersistPasskeySignupRejectedAttempt {
  return {
    intentId: input.intent.intentId,
    expectedRevision,
    updatedAtMs: atMs,
    nextState: exhausted ? "rejected" : "pending",
    ...mutation(
      input.intent.intentId,
      expectedRevision + 1,
      exhausted ? "rejected" : "pending",
      exhausted
        ? "passkey.signup.attempts_exhausted"
        : "passkey.signup.verification_rejected",
      atMs,
      label
    )
  };
}

function expired(
  input: PersistPasskeySignupBegin,
  expectedRevision: number,
  atMs: number,
  label: string
): PersistPasskeySignupExpired {
  return {
    intentId: input.intent.intentId,
    expectedRevision,
    terminalAtMs: atMs,
    nextState: "expired",
    ...mutation(
      input.intent.intentId,
      expectedRevision + 1,
      "expired",
      "passkey.signup.expired",
      atMs,
      label
    )
  };
}

async function verified(
  start: PersistPasskeySignupBegin,
  atMs: number,
  label: string,
  options: {
    sessionId?: string;
    refreshId?: string;
    credentialId?: string;
    credentialRecordId?: string;
    passwordHash?: string;
  } = {}
): Promise<PersistVerifiedPasskeySignup> {
  const sessionId = options.sessionId ?? SESSION_A;
  const refreshId = options.refreshId ?? REFRESH_A;
  const expiresAtMs = atMs + 30 * 86_400_000;
  const consumed = mutation(
    start.intent.intentId,
    start.intent.revision + 1,
    "consumed",
    "passkey.signup.consumed",
    atMs,
    label
  );
  return {
    intentId: start.intent.intentId,
    expectedRevision: start.intent.revision,
    committedAtMs: atMs,
    candidate: {
      accountId: start.intent.candidate.accountId,
      username: start.intent.candidate.username,
      usernameNormalized: start.intent.candidate.usernameNormalized,
      displayName: start.intent.candidate.displayName,
      userHandleRef: start.intent.candidate.userHandleRef,
      userHandle: new Uint8Array(start.intent.candidate.userHandle)
    },
    credential: {
      credentialRecordId: options.credentialRecordId ?? `signup-credential:${label}`,
      credentialId: options.credentialId ?? randomBytes(32).toString("base64url"),
      publicKey: new Uint8Array([0xa5, 0x01, 0x02, 0x03]),
      algorithm: -7,
      discoveryMode: "discoverable",
      signCount: 0,
      backupEligible: false,
      backupState: false,
      transports: ["internal"],
      userPresent: true,
      userVerified: true
    },
    passwordAuth: {
      enabled: false,
      disabledHash: options.passwordHash ?? await createPasskeyDisabledPasswordHash()
    },
    session: {
      id: sessionId,
      userId: start.intent.candidate.accountId,
      deviceName: "First iPhone",
      createdAt: new Date(atMs).toISOString(),
      expiresAt: new Date(expiresAtMs).toISOString()
    },
    refreshToken: {
      id: refreshId,
      sessionId,
      tokenHash: randomBytes(32).toString("base64url"),
      createdAt: new Date(atMs).toISOString(),
      expiresAt: new Date(expiresAtMs).toISOString(),
      derivationKeyId: "signup-v1",
      deliveryNonceDigest: start.intent.deliveryNonceDigest
    },
    accessToken: {
      tokenId: start.intent.intentId,
      issuedAtSec: Math.floor(atMs / 1_000),
      expiresAtSec: Math.floor(atMs / 1_000) + 900
    },
    ...consumed
  };
}

describe("SqliteStore pre-account passkey signup intents", () => {
  it("atomically consumes verified first-passkey material into a password-disabled account", async () => {
    const item = fixture();
    const start = await begun(item, { label: "consume" });
    await item.store.commitPasskeySignupBegin(start.input);
    item.clock.value += 10;
    const commit = await verified(start.input, item.clock.value, "consume");

    await item.store.commitVerifiedPasskeySignup(commit);

    expect(await item.store.findPasskeySignupIntent(INTENT_A)).toMatchObject({
      state: "consumed",
      revision: 2,
      terminalReason: "verified",
      resolvedCredentialRecordId: commit.credential.credentialRecordId
    });
    expect(await item.store.findPasskeySignupConsumption(INTENT_A)).toEqual({
      intentId: INTENT_A,
      resultRevision: 2,
      accountId: ACCOUNT_A,
      userHandleRef: start.input.intent.candidate.userHandleRef,
      credentialRecordId: commit.credential.credentialRecordId,
      sessionId: SESSION_A,
      initialRefreshTokenId: REFRESH_A,
      initialAccessTokenExpiresAtSec: commit.accessToken.expiresAtSec,
      refreshDerivationKeyId: "signup-v1",
      committedAtMs: item.clock.value
    });
    expect(item.store.findUserById(ACCOUNT_A)).toMatchObject({
      username: USERNAME,
      usernameNormalized: USERNAME_NORMALIZED,
      passwordAuthEnabled: false,
      passwordHash: commit.passwordAuth.disabledHash
    });
    expect(await item.store.findPasskeyUserHandleByRef(
      start.input.intent.candidate.userHandleRef
    )).toMatchObject({ accountId: ACCOUNT_A });
    expect(await item.store.findPasskeyCredentialByRecordId(
      commit.credential.credentialRecordId
    )).toMatchObject({
      credentialId: commit.credential.credentialId,
      accountId: ACCOUNT_A,
      revision: 1,
      registrationCeremonyId: INTENT_A
    });
    expect(item.store.findRefreshToken(commit.refreshToken.tokenHash)).toMatchObject({
      id: REFRESH_A,
      sessionId: SESSION_A,
      session: { userId: ACCOUNT_A }
    });
    expect(await item.store.resolve(start.input.intent.challenge.reference)).toBeNull();
    expect(await item.store.findPasskeySignupCommandReceipt(commit.commandReceipt.scope))
      .toEqual(commit.commandReceipt);

    await expect(item.store.commitVerifiedPasskeySignup(commit))
      .rejects.toBeInstanceOf(StoreDuplicateCommandError);
    expect(await item.store.findPasskeySignupConsumption(INTENT_A)).toMatchObject({
      credentialRecordId: commit.credential.credentialRecordId,
      sessionId: SESSION_A,
      initialRefreshTokenId: REFRESH_A
    });

    const safeInspection = new Database(item.path, { readonly: true });
    expect(safeInspection.prepare(`
      SELECT session_id, account_id, credential_record_id, created_at_ms
      FROM passkey_session_credential_origins WHERE session_id = ?
    `).get(SESSION_A)).toEqual({
      session_id: SESSION_A,
      account_id: ACCOUNT_A,
      credential_record_id: commit.credential.credentialRecordId,
      created_at_ms: item.clock.value
    });
    const safeRows = safeInspection.prepare(`
      SELECT events.event_json, outbox.payload_json, receipts.result_json
      FROM passkey_signup_events events
      JOIN passkey_signup_outbox outbox ON outbox.event_id = events.event_id
      JOIN passkey_signup_command_receipts receipts ON receipts.event_id = events.event_id
      WHERE events.event_id = ?
    `).get(commit.event.eventId) as Record<string, unknown>;
    expect(JSON.stringify(safeRows)).not.toMatch(
      /Flenym|aaaaaaaa|credential|session|refresh|password|challenge|token/iu
    );
    safeInspection.close();
  });

  it("retains the account while allowing terminal signup audit retention cleanup", async () => {
    const item = fixture();
    const start = await begun(item, { label: "retention" });
    await item.store.commitPasskeySignupBegin(start.input);
    item.clock.value += 10;
    const commit = await verified(start.input, item.clock.value, "retention");
    await item.store.commitVerifiedPasskeySignup(commit);
    const inspection = new Database(item.path);
    inspection.pragma("foreign_keys = ON");
    inspection.prepare("DELETE FROM passkey_signup_intents WHERE intent_id = ?").run(INTENT_A);
    expect((inspection.prepare(`
      SELECT COUNT(*) AS count FROM passkey_signup_consumptions WHERE intent_id = ?
    `).get(INTENT_A) as { count: number }).count).toBe(0);
    inspection.close();
    expect(item.store.findUserById(ACCOUNT_A)).not.toBeNull();
    expect(await item.store.findPasskeyCredentialByRecordId(
      commit.credential.credentialRecordId
    )).not.toBeNull();
  });

  it("rolls back every account side effect on hostile, drift, fault and expiry boundaries", async () => {
    const item = fixture();
    const start = await begun(item, { label: "consume-fault" });
    await item.store.commitPasskeySignupBegin(start.input);
    item.clock.value += 10;
    const commit = await verified(start.input, item.clock.value, "consume-fault");

    await expect(item.store.commitVerifiedPasskeySignup({
      ...commit,
      rawWebAuthnResponse: { clientDataJSON: "forbidden" }
    } as unknown as PersistVerifiedPasskeySignup)).rejects.toThrow(
      "Passkey repository integrity check failed"
    );
    await expect(item.store.commitVerifiedPasskeySignup({
      ...commit,
      candidate: {
        ...commit.candidate,
        username: "DifferentSignup",
        usernameNormalized: "differentsignup"
      }
    })).rejects.toBeInstanceOf(StoreRevisionConflictError);

    const collidingEventId = start.input.event.eventId;
    const fault = {
      ...commit,
      event: { ...commit.event, eventId: collidingEventId },
      outbox: { ...commit.outbox, eventId: collidingEventId },
      commandReceipt: { ...commit.commandReceipt, eventId: collidingEventId }
    };
    await expect(item.store.commitVerifiedPasskeySignup(fault)).rejects.toThrow();

    item.clock.value = start.input.intent.expiresAtMs;
    await expect(item.store.commitVerifiedPasskeySignup(commit))
      .rejects.toBeInstanceOf(StoreRevisionConflictError);

    expect(item.store.findUserById(ACCOUNT_A)).toBeNull();
    expect(await item.store.findPasskeyCredentialByRecordId(
      commit.credential.credentialRecordId
    )).toBeNull();
    expect(item.store.findRefreshToken(commit.refreshToken.tokenHash)).toBeNull();
    expect(await item.store.findPasskeySignupConsumption(INTENT_A)).toBeNull();
    expect(await item.store.findPasskeySignupIntent(INTENT_A)).toMatchObject({
      state: "pending",
      revision: 1,
      resolvedCredentialRecordId: null
    });
    const inspection = new Database(item.path, { readonly: true });
    for (const table of [
      "users", "passkey_user_handles", "passkey_credentials",
      "device_sessions", "refresh_tokens", "passkey_signup_consumptions"
    ]) {
      expect((inspection.prepare(`SELECT COUNT(*) AS count FROM ${table}`)
        .get() as { count: number }).count).toBe(0);
    }
    expect((inspection.prepare(`
      SELECT COUNT(*) AS count FROM passkey_challenge_secrets WHERE reference = ?
    `).get(start.input.intent.challenge.reference) as { count: number }).count).toBe(1);
    inspection.close();
  });

  it("serializes same-username verified signups across independent SQLite writers", async () => {
    const item = fixture();
    const first = await begun(item, {
      intentId: INTENT_A,
      accountId: ACCOUNT_A,
      label: "verified-race-a"
    });
    const second = await begun(item, {
      intentId: INTENT_B,
      accountId: ACCOUNT_B,
      userHandleRef: "signup-handle:verified-race-b",
      label: "verified-race-b"
    });
    await item.store.commitPasskeySignupBegin(first.input);
    await item.store.commitPasskeySignupBegin(second.input);
    item.clock.value += 10;
    const left = await verified(first.input, item.clock.value, "verified-race-a", {
      sessionId: SESSION_A,
      refreshId: REFRESH_A
    });
    const right = await verified(second.input, item.clock.value, "verified-race-b", {
      sessionId: SESSION_B,
      refreshId: REFRESH_B
    });
    const gate = new SharedArrayBuffer(4);
    const leftWorker = startVerifiedSignupWorker(item, gate, left);
    const rightWorker = startVerifiedSignupWorker(item, gate, right);
    await Promise.all([leftWorker.ready, rightWorker.ready]);
    const gateView = new Int32Array(gate);
    Atomics.store(gateView, 0, 1);
    Atomics.notify(gateView, 0, 2);
    const outcomes = await Promise.all([leftWorker.outcome, rightWorker.outcome]);

    expect(outcomes.filter(({ ok }) => ok)).toHaveLength(1);
    expect(outcomes.find(({ ok }) => !ok)).toEqual({
      ok: false,
      name: "StoreRevisionConflictError"
    });
    const leftWon = outcomes[0]?.ok === true;
    const winner = leftWon ? left : right;
    const loser = leftWon ? right : left;
    expect(await item.store.findPasskeySignupIntent(winner.intentId)).toMatchObject({
      state: "consumed",
      resolvedCredentialRecordId: winner.credential.credentialRecordId
    });
    expect(await item.store.findPasskeySignupIntent(loser.intentId)).toMatchObject({
      state: "pending",
      revision: 1,
      resolvedCredentialRecordId: null
    });
    expect(item.store.findUserById(loser.candidate.accountId)).toBeNull();
    expect(await item.store.findPasskeyCredentialByRecordId(
      loser.credential.credentialRecordId
    )).toBeNull();
    expect(item.store.findRefreshToken(loser.refreshToken.tokenHash)).toBeNull();
    expect(await item.store.findPasskeySignupConsumption(loser.intentId)).toBeNull();
    const inspection = new Database(item.path, { readonly: true });
    for (const table of [
      "users", "passkey_user_handles", "passkey_credentials",
      "device_sessions", "refresh_tokens", "passkey_signup_consumptions"
    ]) {
      expect((inspection.prepare(`SELECT COUNT(*) AS count FROM ${table}`)
        .get() as { count: number }).count).toBe(1);
    }
    inspection.close();
  });

  it("rejects credential-ID reuse without leaving a second account ghost", async () => {
    const item = fixture();
    const first = await begun(item, { intentId: INTENT_A, accountId: ACCOUNT_A, label: "credential-a" });
    await item.store.commitPasskeySignupBegin(first.input);
    item.clock.value += 10;
    const winner = await verified(first.input, item.clock.value, "credential-a");
    await item.store.commitVerifiedPasskeySignup(winner);

    const second = await begun(item, {
      intentId: INTENT_B,
      accountId: ACCOUNT_B,
      userHandleRef: "signup-handle:credential-b",
      username: "SecondSignup",
      usernameNormalized: "secondsignup",
      displayName: "Second Signup",
      label: "credential-b"
    });
    await item.store.commitPasskeySignupBegin(second.input);
    item.clock.value += 1;
    const duplicate = await verified(second.input, item.clock.value, "credential-b", {
      sessionId: SESSION_B,
      refreshId: REFRESH_B,
      credentialId: winner.credential.credentialId
    });
    await expect(item.store.commitVerifiedPasskeySignup(duplicate))
      .rejects.toBeInstanceOf(StoreCredentialConflictError);
    expect(item.store.findUserById(ACCOUNT_B)).toBeNull();
    expect(await item.store.findPasskeySignupConsumption(INTENT_B)).toBeNull();
    expect(await item.store.findPasskeySignupIntent(INTENT_B)).toMatchObject({ state: "pending" });
  });

  it("rejects candidate-account and existing-handle collisions before creating any ghost", async () => {
    const accountCollision = fixture();
    const first = await begun(accountCollision, { label: "account-collision" });
    await accountCollision.store.commitPasskeySignupBegin(first.input);
    accountCollision.store.createUser({
      id: ACCOUNT_A,
      username: "LegacyOwner",
      usernameNormalized: "legacyowner",
      displayName: "Legacy Owner",
      passwordHash: "legacy-test-hash",
      createdAt: new Date(accountCollision.clock.value).toISOString()
    });
    accountCollision.clock.value += 10;
    const accountCommit = await verified(first.input, accountCollision.clock.value, "account-collision");
    await expect(accountCollision.store.commitVerifiedPasskeySignup(accountCommit))
      .rejects.toBeInstanceOf(StoreRevisionConflictError);
    expect(await accountCollision.store.findPasskeySignupConsumption(INTENT_A)).toBeNull();
    expect(await accountCollision.store.findPasskeyCredentialByRecordId(
      accountCommit.credential.credentialRecordId
    )).toBeNull();

    const handleCollision = fixture();
    handleCollision.store.createUser({
      id: ACCOUNT_C,
      username: "HandleOwner",
      usernameNormalized: "handleowner",
      displayName: "Handle Owner",
      passwordHash: "legacy-test-hash",
      createdAt: new Date(handleCollision.clock.value).toISOString()
    });
    const existingHandle = await handleCollision.store.getOrCreatePasskeyUserHandleBinding(ACCOUNT_C);
    const second = await begun(handleCollision, {
      userHandleRef: existingHandle.reference,
      userHandle: new Uint8Array(Buffer.from(existingHandle.userHandle, "base64url")),
      label: "handle-collision"
    });
    await handleCollision.store.commitPasskeySignupBegin(second.input);
    handleCollision.clock.value += 10;
    const handleCommit = await verified(second.input, handleCollision.clock.value, "handle-collision");
    await expect(handleCollision.store.commitVerifiedPasskeySignup(handleCommit))
      .rejects.toBeInstanceOf(StoreRevisionConflictError);
    expect(handleCollision.store.findUserById(ACCOUNT_A)).toBeNull();
    expect(await handleCollision.store.findPasskeySignupConsumption(INTENT_A)).toBeNull();
  });
  it("atomically begins and round-trips encrypted candidate state with public-safe receipts", async () => {
    const item = fixture();
    const start = await begun(item);
    const expectedHandle = new Uint8Array(start.input.intent.candidate.userHandle);

    await item.store.commitPasskeySignupBegin(start.input);

    expect(await item.store.findPasskeySignupIntent(INTENT_A)).toEqual({
      ...start.input.intent,
      purpose: { ...start.input.intent.purpose },
      expectedTopOrigins: [],
      allowedAlgorithms: [-7, -257],
      excludeCredentials: [],
      candidate: { ...start.input.intent.candidate, userHandle: expectedHandle },
      challenge: { ...start.input.intent.challenge }
    });
    expect(await item.store.findPasskeySignupCommandReceipt(
      start.input.commandReceipt.scope
    )).toEqual(start.input.commandReceipt);
    expect(await item.store.findPasskeySignupCreationReceipt(
      start.input.creationReceipt.scope
    )).toEqual(start.input.creationReceipt);

    const inspection = new Database(item.path, { readonly: true });
    const row = inspection.prepare(`SELECT * FROM passkey_signup_intents WHERE intent_id = ?`)
      .get(INTENT_A) as Record<string, unknown>;
    const challenge = inspection.prepare(`
      SELECT challenge_ciphertext FROM passkey_challenge_secrets WHERE reference = ?
    `).get(start.input.intent.challenge.reference) as { challenge_ciphertext: string };
    expect(row["candidate_username_ciphertext"]).toMatch(/^luxora:v1\./u);
    expect(row["candidate_username_normalized_ciphertext"]).toMatch(/^luxora:v1\./u);
    expect(row["candidate_display_name_ciphertext"]).toMatch(/^luxora:v1\./u);
    expect(row["candidate_user_handle_ciphertext"]).toMatch(/^luxora:v1\./u);
    expect(JSON.stringify(row)).not.toContain(USERNAME);
    expect(JSON.stringify(row)).not.toContain(USERNAME_NORMALIZED);
    expect(JSON.stringify(row)).not.toContain(DISPLAY_NAME);
    expect(JSON.stringify(row)).not.toContain(Buffer.from(expectedHandle).toString("base64url"));
    expect(challenge.challenge_ciphertext).toMatch(/^luxora:v1\./u);
    expect(challenge.challenge_ciphertext).not.toContain(start.challenge);
    expect(() => item.cipher.decrypt(
      row["candidate_username_ciphertext"] as string,
      `passkey-signup:${INTENT_A}:display-name`
    )).toThrow();
    expect(() => item.cipher.decrypt(
      row["candidate_user_handle_ciphertext"] as string,
      `passkey-signup:${INTENT_B}:user-handle`
    )).toThrow();
    expect((inspection.prepare("SELECT COUNT(*) AS count FROM users").get() as { count: number }).count)
      .toBe(0);
    expect((inspection.prepare("SELECT COUNT(*) AS count FROM device_sessions").get() as { count: number }).count)
      .toBe(0);
    inspection.close();
  });

  it("allows parallel same-username candidates without reserving or probing users", async () => {
    const item = fixture();
    const first = await begun(item, { intentId: INTENT_A, accountId: ACCOUNT_A, label: "parallel-a" });
    const second = await begun(item, {
      intentId: INTENT_B,
      accountId: ACCOUNT_B,
      userHandleRef: "signup-handle:parallel-b",
      label: "parallel-b"
    });

    await item.store.commitPasskeySignupBegin(first.input);
    await item.store.commitPasskeySignupBegin(second.input);

    expect((await item.store.findPasskeySignupIntent(INTENT_A))?.candidate.usernameNormalized)
      .toBe(USERNAME_NORMALIZED);
    expect((await item.store.findPasskeySignupIntent(INTENT_B))?.candidate.usernameNormalized)
      .toBe(USERNAME_NORMALIZED);
    const inspection = new Database(item.path, { readonly: true });
    expect((inspection.prepare(`
      SELECT COUNT(*) AS count FROM passkey_signup_intents
    `).get() as { count: number }).count).toBe(2);
    expect((inspection.prepare("SELECT COUNT(*) AS count FROM users").get() as { count: number }).count)
      .toBe(0);
    inspection.close();
  });

  it("applies bounded attempts and atomically cleans the challenge on rejection", async () => {
    const item = fixture();
    const start = await begun(item, { maxAttempts: 2 });
    await item.store.commitPasskeySignupBegin(start.input);
    item.clock.value += 10;
    await item.store.commitPasskeySignupRejectedAttempt(
      rejected(start.input, 1, item.clock.value, "reject-one", false)
    );
    item.clock.value += 10;
    await item.store.commitPasskeySignupRejectedAttempt(
      rejected(start.input, 2, item.clock.value, "reject-two", true)
    );

    expect(await item.store.findPasskeySignupIntent(INTENT_A)).toMatchObject({
      state: "rejected",
      revision: 3,
      attemptsUsed: 2,
      terminalReason: "attempts_exhausted"
    });
    await expect(item.store.resolve(start.input.intent.challenge.reference)).resolves.toBeNull();
    await expect(item.store.commitPasskeySignupRejectedAttempt(
      rejected(start.input, 2, item.clock.value, "stale", true)
    )).rejects.toBeInstanceOf(StoreRevisionConflictError);
  });

  it("uses writer time for expiry, lists deterministically with a hard bound, and cleans secrets", async () => {
    const item = fixture();
    const starts = [
      await begun(item, { intentId: INTENT_C, accountId: ACCOUNT_C, timeoutMs: TIMEOUT_MS + 2, label: "expiry-c" }),
      await begun(item, { intentId: INTENT_A, accountId: ACCOUNT_A, timeoutMs: TIMEOUT_MS, label: "expiry-a" }),
      await begun(item, { intentId: INTENT_B, accountId: ACCOUNT_B, timeoutMs: TIMEOUT_MS, label: "expiry-b" })
    ];
    for (const start of starts) await item.store.commitPasskeySignupBegin(start.input);

    item.clock.value = NOW_MS + TIMEOUT_MS - 1;
    await expect(item.store.commitPasskeySignupExpired(
      expired(starts[1]!.input, 1, NOW_MS + TIMEOUT_MS, "too-early")
    )).rejects.toBeInstanceOf(StoreRevisionConflictError);
    item.clock.value = NOW_MS + TIMEOUT_MS;
    expect((await item.store.listExpiredPendingPasskeySignupIntents(item.clock.value, 2))
      .map(({ intentId }) => intentId)).toEqual([INTENT_A, INTENT_B]);
    await item.store.commitPasskeySignupExpired(
      expired(starts[1]!.input, 1, item.clock.value, "expired-a")
    );
    expect(await item.store.resolve(starts[1]!.input.intent.challenge.reference)).toBeNull();
    await expect(item.store.listExpiredPendingPasskeySignupIntents(item.clock.value, 0))
      .rejects.toThrow();
    await expect(item.store.listExpiredPendingPasskeySignupIntents(item.clock.value, 1_001))
      .rejects.toThrow();
  });

  it("rechecks writer time at commit and rolls back a rejection that crosses expiry", async () => {
    const item = fixture();
    const start = await begun(item, { maxAttempts: 2, label: "expiry-toctou" });
    await item.store.commitPasskeySignupBegin(start.input);
    const attemptedAtMs = start.input.intent.expiresAtMs - 1;
    const attempt = rejected(start.input, 1, attemptedAtMs, "expiry-toctou-reject", false);

    item.clock.value = start.input.intent.expiresAtMs;
    await expect(item.store.commitPasskeySignupRejectedAttempt(attempt))
      .rejects.toBeInstanceOf(StoreRevisionConflictError);

    expect(await item.store.findPasskeySignupIntent(INTENT_A)).toMatchObject({
      state: "pending",
      revision: 1,
      attemptsUsed: 0
    });
    expect(await item.store.findPasskeySignupCommandReceipt(attempt.commandReceipt.scope))
      .toBeNull();
    const inspection = new Database(item.path, { readonly: true });
    expect((inspection.prepare(`
      SELECT COUNT(*) AS count FROM passkey_signup_events WHERE intent_id = ?
    `).get(INTENT_A) as { count: number }).count).toBe(1);
    expect((inspection.prepare(`
      SELECT COUNT(*) AS count FROM passkey_challenge_secrets WHERE reference = ?
    `).get(start.input.intent.challenge.reference) as { count: number }).count).toBe(1);
    inspection.close();
  });

  it("lets only one SQLite CAS writer advance an intent revision", async () => {
    const item = fixture();
    const start = await begun(item);
    await item.store.commitPasskeySignupBegin(start.input);
    item.clock.value += 10;
    const gate = new SharedArrayBuffer(4);
    const first = startRejectedAttemptWorker(
      item,
      gate,
      rejected(start.input, 1, item.clock.value, "race-a", false)
    );
    const second = startRejectedAttemptWorker(
      item,
      gate,
      rejected(start.input, 1, item.clock.value, "race-b", false)
    );
    await Promise.all([first.ready, second.ready]);
    const gateView = new Int32Array(gate);
    Atomics.store(gateView, 0, 1);
    Atomics.notify(gateView, 0, 2);
    const outcomes = await Promise.all([first.outcome, second.outcome]);

    expect(outcomes.filter(({ ok }) => ok)).toHaveLength(1);
    expect(outcomes.find(({ ok }) => !ok)).toEqual({
      ok: false,
      name: "StoreRevisionConflictError"
    });
    expect(await item.store.findPasskeySignupIntent(INTENT_A)).toMatchObject({
      state: "pending",
      revision: 2,
      attemptsUsed: 1
    });
  });

  it("rejects coercion, accessors, proxies, shared bytes and extra keys before any write", async () => {
    const item = fixture();
    const cases: unknown[] = [];
    {
      const start = await begun(item, { label: "hostile-extra" });
      cases.push({ ...start.input, rawResponse: "never-store" });
    }
    {
      const start = await begun(item, { label: "hostile-string" });
      cases.push({
        ...start.input,
        intent: { ...start.input.intent, timeoutMs: String(TIMEOUT_MS) }
      });
    }
    {
      const start = await begun(item, { label: "hostile-accessor" });
      const candidate = { ...start.input.intent.candidate } as Record<string, unknown>;
      Object.defineProperty(candidate, "username", {
        enumerable: true,
        get() { throw new Error("signup-accessor-CANARY"); }
      });
      cases.push({ ...start.input, intent: { ...start.input.intent, candidate } });
    }
    {
      const start = await begun(item, { label: "hostile-proxy" });
      cases.push(new Proxy(start.input, {
        ownKeys() { throw new Error("signup-proxy-CANARY"); }
      }));
    }
    {
      const start = await begun(item, { label: "hostile-shared" });
      const shared = new Uint8Array(new SharedArrayBuffer(32));
      cases.push({
        ...start.input,
        intent: {
          ...start.input.intent,
          candidate: { ...start.input.intent.candidate, userHandle: shared }
        }
      });
    }

    for (const hostile of cases) {
      const thrown = await item.store.commitPasskeySignupBegin(
        hostile as PersistPasskeySignupBegin
      ).then(() => null, (error: unknown) => error);
      expect(String(thrown)).toBe("PasskeyRepositoryIntegrityError: Passkey repository integrity check failed");
      expect(String(thrown)).not.toContain("CANARY");
    }
    const inspection = new Database(item.path, { readonly: true });
    expect((inspection.prepare("SELECT COUNT(*) AS count FROM passkey_signup_intents")
      .get() as { count: number }).count).toBe(0);
    expect((inspection.prepare("SELECT COUNT(*) AS count FROM passkey_signup_events")
      .get() as { count: number }).count).toBe(0);
    inspection.close();
  });
});
