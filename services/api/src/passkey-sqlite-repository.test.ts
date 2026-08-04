import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import {
  PASSKEY_CHALLENGE_BYTES,
  PASSKEY_DOMAIN_VERSION,
  StoreAuthorizationConflictError,
  StoreCredentialConflictError,
  StoreCredentialStateConflictError,
  StoreDuplicateCommandError,
  StoreRevisionConflictError,
  createLuxoraPasskeyPolicy,
  type AuthenticatedCeremonyActor,
  type CeremonyAggregate,
  type CeremonyEventType,
  type CeremonyMutation,
  type IdGenerator,
  type PersistCeremonyMutation,
  type SecureCredentialEffect,
  type SecureRegistrationCredential,
  type VerifiedAuthenticationCredential
} from "@luxora/passkey-domain";
import { AesGcmContentCipher } from "./infrastructure/content-cipher.js";
import { SqliteStore } from "./infrastructure/sqlite-store.js";
import type {
  PasskeyStepUpClaimsProjection,
  PasskeyStepUpGrantRecord,
  PasskeyUserHandleBinding
} from "./domain/types.js";

const NOW_MS = 1_800_000_000_000;
const ORIGIN = "https://auth.luxora.app";
const TARGET_DIGEST = "a".repeat(64);
const POLICY = createLuxoraPasskeyPolicy();
const PUBLIC_KEY_CANARY = "PASSKEY_PUBLIC_KEY_MATERIAL_CANARY";

interface MutableClock {
  value: number;
}

interface AccountFixture {
  accountId: string;
  sessionId: string;
  deviceId: string;
  userHandleRef: string;
  userHandle: string;
  userHandleCreatedAtMs: number;
}

type AccountSessionFixture = Pick<AccountFixture, "accountId" | "sessionId" | "deviceId">;

type CommitRaceOutcome = { ok: true } | { ok: false; name: string };

interface CommitWorker {
  worker: Worker;
  ready: Promise<void>;
  outcome: Promise<CommitRaceOutcome>;
}

class SequenceIds implements IdGenerator {
  readonly #counts = new Map<string, number>();

  constructor(private readonly prefix: string) {}

  next(purpose: "ceremony" | "event" | "outbox" | "credential-record"): string {
    const count = (this.#counts.get(purpose) ?? 0) + 1;
    this.#counts.set(purpose, count);
    return `${this.prefix}-${purpose}-${count}`;
  }
}

function digestText(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function challengeDigest(challenge: string): string {
  return createHash("sha256").update(Buffer.from(challenge, "base64url")).digest("hex");
}

function credentialId(label: string): string {
  return Buffer.from(`credential:${label}`, "utf8").toString("base64url");
}

function persistInput(
  mutation: CeremonyMutation,
  expectedRevision: number | null,
  label: string
): PersistCeremonyMutation {
  const result = {
    ceremonyId: mutation.snapshot.ceremonyId,
    revision: mutation.snapshot.revision,
    eventId: mutation.event.eventId,
    snapshot: mutation.snapshot
  };
  return {
    expectedRevision,
    mutation,
    commandReceipt: {
      scope: `command:${digestText(`command:${label}`)}`,
      fingerprint: digestText(`fingerprint:${label}`),
      result,
      createdAtMs: mutation.snapshot.updatedAtMs
    },
    creationReceipt: expectedRevision === null
      ? {
          scope: `create:${digestText(`create:${label}`)}`,
          fingerprint: digestText(`creation-fingerprint:${label}`),
          result,
          createdAtMs: mutation.snapshot.updatedAtMs
        }
      : null
  };
}

function actorBinding(actor: AccountFixture): AuthenticatedCeremonyActor {
  return {
    accountId: actor.accountId,
    sessionId: actor.sessionId,
    deviceId: actor.deviceId
  };
}

function ceremonyMutation(
  snapshot: CeremonyAggregate,
  eventType: CeremonyEventType,
  commandId: string,
  ids: SequenceIds,
  secureCredentialEffect: SecureCredentialEffect | null
): CeremonyMutation {
  const eventId = ids.next("event");
  const event = {
    schemaVersion: PASSKEY_DOMAIN_VERSION,
    eventId,
    type: eventType,
    ceremonyId: snapshot.ceremonyId,
    revision: snapshot.revision,
    occurredAtMs: snapshot.updatedAtMs,
    commandId,
    snapshot
  } as const;
  return {
    snapshot,
    event,
    outbox: {
      schemaVersion: PASSKEY_DOMAIN_VERSION,
      outboxId: ids.next("outbox"),
      topic: "luxora.passkey-ceremony.v1",
      partitionKey: snapshot.ceremonyId,
      eventId,
      payload: {
        schemaVersion: PASSKEY_DOMAIN_VERSION,
        type: eventType,
        ceremonyId: snapshot.ceremonyId,
        kind: snapshot.kind,
        purpose: snapshot.purpose.type,
        state: snapshot.state,
        revision: snapshot.revision,
        attemptsUsed: snapshot.attemptsUsed,
        riskSignals: snapshot.riskSignals,
        occurredAtMs: snapshot.updatedAtMs
      },
      availableAtMs: snapshot.updatedAtMs
    },
    secureCredentialEffect
  };
}

function cancelledMutation(
  current: CeremonyAggregate,
  commandId: string,
  nowMs: number,
  ids: SequenceIds
): CeremonyMutation {
  const snapshot: CeremonyAggregate = {
    ...current,
    state: "cancelled",
    revision: current.revision + 1,
    updatedAtMs: nowMs,
    terminalAtMs: nowMs,
    terminalReason: "cancelled"
  };
  return ceremonyMutation(snapshot, "passkey.ceremony.cancelled", commandId, ids, null);
}

function rejectedAttemptMutation(
  current: CeremonyAggregate,
  commandId: string,
  nowMs: number,
  ids: SequenceIds
): CeremonyMutation {
  const attemptsUsed = current.attemptsUsed + 1;
  const exhausted = attemptsUsed === current.maxAttempts;
  const snapshot: CeremonyAggregate = {
    ...current,
    state: exhausted ? "rejected" : "pending",
    revision: current.revision + 1,
    attemptsUsed,
    updatedAtMs: nowMs,
    terminalAtMs: exhausted ? nowMs : null,
    terminalReason: exhausted ? "attempts_exhausted" : null
  };
  return ceremonyMutation(
    snapshot,
    exhausted ? "passkey.ceremony.attempts_exhausted" : "passkey.ceremony.verification_rejected",
    commandId,
    ids,
    null
  );
}

function startCommitWorker(
  databasePath: string,
  encodedKey: string,
  gate: SharedArrayBuffer,
  mutation: PersistCeremonyMutation,
  nowMs: number,
  stepUpClaims?: PasskeyStepUpClaimsProjection,
  userHandleBinding?: PasskeyUserHandleBinding
): CommitWorker {
  const worker = new Worker(
    new URL("./test-support/passkey-commit-race-worker.ts", import.meta.url),
    {
      execArgv: ["--import", "tsx"],
      workerData: {
        databasePath,
        encodedKey,
        gate,
        mutation,
        nowMs,
        stepUpClaims,
        userHandleBinding
      }
    }
  );
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
  worker.on("message", (message: any) => {
    if (message.type === "ready") resolveReady?.();
    if (message.type === "result") resolveOutcome?.(message.outcome as CommitRaceOutcome);
  });
  worker.on("error", (error) => {
    rejectReady?.(error);
    rejectOutcome?.(error);
  });
  worker.on("exit", (code) => {
    if (code !== 0) {
      const error = new Error(`Passkey commit worker exited with code ${code}`);
      rejectReady?.(error);
      rejectOutcome?.(error);
    }
  });
  return { worker, ready, outcome };
}

describe("SQLite passkey ceremony repository", () => {
  const directories: string[] = [];
  const stores: SqliteStore[] = [];
  const workers: Worker[] = [];
  const storePaths = new WeakMap<SqliteStore, string>();

  afterEach(async () => {
    await Promise.all(workers.splice(0).map(async (worker) => {
      if (worker.threadId !== -1) await worker.terminate();
    }));
    for (const store of stores.splice(0)) {
      try {
        store.close();
      } catch {
        // A test may intentionally close before reopening.
      }
    }
    for (const directory of directories.splice(0)) {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  function pathFor(label: string): string {
    const directory = mkdtempSync(join(tmpdir(), `luxora-passkey-${label}-`));
    directories.push(directory);
    return join(directory, "luxora.sqlite");
  }

  function openStore(path: string, encodedKey: string, clock: MutableClock): SqliteStore {
    const store = new SqliteStore(
      path,
      new AesGcmContentCipher({ passkey: encodedKey }, "passkey"),
      () => clock.value
    );
    stores.push(store);
    storePaths.set(store, path);
    return store;
  }

  function closeStore(store: SqliteStore): void {
    const index = stores.indexOf(store);
    if (index >= 0) stores.splice(index, 1);
    store.close();
  }

  function provisionAccountSession(store: SqliteStore, label: string): AccountSessionFixture {
    const accountId = `account-${label}`;
    const sessionId = `session-${label}`;
    // Beta-0.1 derives the WebAuthn actor device binding from the session ID.
    const deviceId = sessionId;
    const createdAt = new Date(NOW_MS).toISOString();
    const expiresAt = new Date(NOW_MS + 86_400_000).toISOString();
    store.createUser({
      id: accountId,
      username: `passkey_${label}`,
      usernameNormalized: `passkey_${label}`,
      displayName: `Passkey ${label}`,
      passwordHash: `password-hash-${label}`,
      createdAt
    });
    store.createSession({
      id: sessionId,
      userId: accountId,
      deviceName: `Device ${label}`,
      createdAt,
      expiresAt
    }, {
      id: `refresh-${label}`,
      sessionId,
      tokenHash: digestText(`refresh:${label}`),
      createdAt,
      expiresAt
    });
    return { accountId, sessionId, deviceId };
  }

  async function provisionAccount(store: SqliteStore, label: string): Promise<AccountFixture> {
    const account = provisionAccountSession(store, label);
    const { accountId, sessionId, deviceId } = account;
    const binding = await store.getOrCreatePasskeyUserHandleBinding(accountId);
    return {
      accountId,
      sessionId,
      deviceId,
      userHandleRef: binding.reference,
      userHandle: binding.userHandle,
      userHandleCreatedAtMs: binding.createdAtMs
    };
  }

  function actorWithUserHandle(
    account: AccountSessionFixture,
    binding: PasskeyUserHandleBinding
  ): AccountFixture {
    return {
      ...account,
      userHandleRef: binding.reference,
      userHandle: binding.userHandle,
      userHandleCreatedAtMs: binding.createdAtMs
    };
  }

  function userHandleBinding(actor: AccountFixture): PasskeyUserHandleBinding {
    return Object.freeze({
      reference: actor.userHandleRef,
      accountId: actor.accountId,
      userHandle: actor.userHandle,
      createdAtMs: actor.userHandleCreatedAtMs
    });
  }

  async function registrationBegin(
    store: SqliteStore,
    actor: AccountFixture,
    clock: MutableClock,
    label: string
  ): Promise<{ input: PersistCeremonyMutation; ids: SequenceIds }> {
    const issued = await store.issue({
      byteLength: PASSKEY_CHALLENGE_BYTES,
      expiresAtMs: clock.value + POLICY.timeoutMs
    });
    const ids = new SequenceIds(label);
    const snapshot: CeremonyAggregate = {
      schemaVersion: PASSKEY_DOMAIN_VERSION,
      ceremonyId: ids.next("ceremony"),
      kind: "registration",
      purpose: { type: "authenticator.add", targetDigest: TARGET_DIGEST },
      actor: actorBinding(actor),
      policyVersion: PASSKEY_DOMAIN_VERSION,
      expectedRpId: POLICY.rpId,
      expectedOrigin: ORIGIN,
      timeoutMs: POLICY.timeoutMs,
      maxResponseBytes: POLICY.maxResponseBytes,
      userVerification: "required",
      crossOriginAllowed: false,
      expectedTopOrigins: [],
      attestation: "none",
      registrationResidentKey: "required",
      allowedAlgorithms: [-7, -257],
      credentialBoundary: { mode: "discoverable", credentialSetRef: null },
      userHandleRef: actor.userHandleRef,
      challenge: {
        reference: issued.reference,
        digest: challengeDigest(issued.challenge),
        byteLength: PASSKEY_CHALLENGE_BYTES
      },
      state: "pending",
      revision: 1,
      attemptsUsed: 0,
      maxAttempts: POLICY.maxAttempts,
      createdAtMs: clock.value,
      expiresAtMs: clock.value + POLICY.timeoutMs,
      updatedAtMs: clock.value,
      terminalAtMs: null,
      terminalReason: null,
      riskSignals: []
    };
    const mutation = ceremonyMutation(snapshot, "passkey.ceremony.started", `begin-${label}`, ids, null);
    return { input: persistInput(mutation, null, `begin-${label}`), ids };
  }

  function seedStepUpGrant(
    store: SqliteStore,
    actor: AccountFixture,
    clock: MutableClock,
    label: string,
    targetDigest = TARGET_DIGEST
  ): { claims: PasskeyStepUpClaimsProjection; authenticationCeremonyId: string } {
    const path = storePaths.get(store);
    if (path === undefined) throw new Error("missing SQLite fixture path");
    const authenticationCeremonyId = `step-up-source-${digestText(label).slice(0, 32)}`;
    const eventId = `step-up-event-${digestText(label).slice(0, 32)}`;
    const issuedAtSec = Math.floor(clock.value / 1_000);
    const expiresAtSec = issuedAtSec + 300;
    const inspection = new Database(path);
    inspection.pragma("foreign_keys = ON");
    inspection.transaction(() => {
      inspection.prepare(`
        INSERT INTO passkey_ceremonies (
          ceremony_id, schema_version, kind, purpose_type, purpose_target_digest,
          account_id, session_id, device_id, user_handle_ref, challenge_reference,
          challenge_digest, state, revision, attempts_used, max_attempts,
          expires_at_ms, updated_at_ms, snapshot_json
        ) VALUES (
          @ceremonyId, 1, 'authentication', 'session.step_up', @targetDigest,
          @accountId, @sessionId, @deviceId, NULL, @challengeReference,
          @challengeDigest, 'consumed', 2, 0, 3,
          @ceremonyExpiresAtMs, @updatedAtMs, @snapshotJson
        )
      `).run({
        ceremonyId: authenticationCeremonyId,
        targetDigest,
        accountId: actor.accountId,
        sessionId: actor.sessionId,
        deviceId: actor.deviceId,
        challengeReference: `step-up-challenge-${digestText(label).slice(0, 32)}`,
        challengeDigest: digestText(`step-up-challenge:${label}`),
        ceremonyExpiresAtMs: clock.value + POLICY.timeoutMs,
        updatedAtMs: clock.value,
        snapshotJson: JSON.stringify({ terminalAtMs: clock.value, terminalReason: "verified" })
      });
      inspection.prepare(`
        INSERT INTO passkey_ceremony_events (
          event_id, ceremony_id, revision, event_type, command_id, occurred_at_ms, event_json
        ) VALUES (?, ?, 2, 'passkey.ceremony.consumed', ?, ?, '{}')
      `).run(eventId, authenticationCeremonyId, `step-up-command-${label}`, clock.value);
      inspection.prepare(`
        INSERT INTO passkey_step_up_grants (
          authentication_ceremony_id, account_id, session_id, device_id,
          purpose, target_digest, auth_time_sec, issued_at_sec, expires_at_sec,
          consumed_at_sec, registration_ceremony_id
        ) VALUES (?, ?, ?, ?, 'authenticator.add', ?, ?, ?, ?, NULL, NULL)
      `).run(
        authenticationCeremonyId,
        actor.accountId,
        actor.sessionId,
        actor.deviceId,
        targetDigest,
        issuedAtSec,
        issuedAtSec,
        expiresAtSec
      );
    }).immediate();
    inspection.close();
    return {
      authenticationCeremonyId,
      claims: {
        sub: actor.accountId,
        sid: actor.sessionId,
        ceremony_id: authenticationCeremonyId,
        jti: Buffer.from(digestText(`step-up-jti:${label}`), "hex").toString("base64url"),
        purpose: "authenticator.add",
        target_digest: targetDigest,
        auth_time: issuedAtSec,
        iat: issuedAtSec,
        exp: expiresAtSec
      }
    };
  }

  function deleteSyntheticStepUpSource(store: SqliteStore, authenticationCeremonyId: string): void {
    const path = storePaths.get(store);
    if (path === undefined) throw new Error("missing SQLite fixture path");
    const inspection = new Database(path);
    inspection.pragma("foreign_keys = ON");
    inspection.prepare("DELETE FROM passkey_ceremonies WHERE ceremony_id = ?")
      .run(authenticationCeremonyId);
    inspection.close();
  }

  async function commitRegistrationBegin(
    store: SqliteStore,
    actor: AccountFixture,
    clock: MutableClock,
    label: string,
    input: PersistCeremonyMutation
  ): Promise<PasskeyStepUpClaimsProjection> {
    const seeded = seedStepUpGrant(store, actor, clock, label, input.mutation.snapshot.purpose.targetDigest);
    await store.commitInitialPasskeyRegistration(input, seeded.claims, userHandleBinding(actor));
    // The durable grant intentionally has no authentication-ceremony FK: a
    // transient authentication cleanup must not strand pending registration.
    deleteSyntheticStepUpSource(store, seeded.authenticationCeremonyId);
    return seeded.claims;
  }

  function claimsForGrant(
    grant: PasskeyStepUpGrantRecord,
    label: string
  ): PasskeyStepUpClaimsProjection {
    return {
      sub: grant.accountId,
      sid: grant.sessionId,
      ceremony_id: grant.authenticationCeremonyId,
      jti: Buffer.from(digestText(`step-up-jti:${label}`), "hex").toString("base64url"),
      purpose: grant.purpose,
      target_digest: grant.targetDigest,
      auth_time: grant.authTimeSec,
      iat: grant.issuedAtSec,
      exp: grant.expiresAtSec
    };
  }

  async function createRealStepUpGrant(
    store: SqliteStore,
    actor: AccountFixture,
    clock: MutableClock,
    label: string,
    credentialRecordId: string
  ): Promise<{
    begin: PersistCeremonyMutation;
    consume: PersistCeremonyMutation;
    grant: PasskeyStepUpGrantRecord;
    claims: PasskeyStepUpClaimsProjection;
  }> {
    const begun = await authenticationBegin(store, actor, clock, `${label}-authentication`);
    await store.commit(begun.input);
    clock.value += 1;
    const consume = authenticationConsume(
      begun.input,
      begun.ids,
      actor,
      clock,
      `${label}-authentication`,
      credentialRecordId
    );
    await store.commit(consume);
    const grant = await store.findPasskeyStepUpGrant(consume.mutation.snapshot.ceremonyId);
    if (grant === null) throw new Error("missing durable step-up grant");
    return {
      begin: begun.input,
      consume,
      grant,
      claims: claimsForGrant(grant, label)
    };
  }

  function registrationConsume(
    begin: PersistCeremonyMutation,
    ids: SequenceIds,
    actor: AccountFixture,
    clock: MutableClock,
    label: string,
    exactCredentialId = credentialId(label)
  ): PersistCeremonyMutation {
    const credential: SecureRegistrationCredential = {
      credentialId: exactCredentialId,
      publicKey: new TextEncoder().encode(`${PUBLIC_KEY_CANARY}:${label}`),
      algorithm: -7,
      accountId: actor.accountId,
      userHandleRef: actor.userHandleRef,
      discoveryMode: "discoverable",
      signCount: 9,
      backupEligible: true,
      backupState: false,
      transports: ["internal", "cable"],
      userPresent: true,
      userVerified: true
    };
    const snapshot: CeremonyAggregate = {
      ...begin.mutation.snapshot,
      state: "consumed",
      revision: 2,
      updatedAtMs: clock.value,
      terminalAtMs: clock.value,
      terminalReason: "verified",
      riskSignals: ["backup_not_active"]
    };
    const mutation = ceremonyMutation(
      snapshot,
      "passkey.ceremony.consumed",
      `verify-${label}`,
      ids,
      {
        type: "store_registration_credential",
        credentialRecordId: ids.next("credential-record"),
        ceremonyId: snapshot.ceremonyId,
        credential
      }
    );
    return persistInput(mutation, 1, `verify-${label}`);
  }

  async function registerCredential(
    store: SqliteStore,
    actor: AccountFixture,
    clock: MutableClock,
    label: string,
    exactCredentialId = credentialId(label)
  ): Promise<{ begin: PersistCeremonyMutation; consume: PersistCeremonyMutation; recordId: string }> {
    const started = await registrationBegin(store, actor, clock, label);
    await commitRegistrationBegin(store, actor, clock, `grant-${label}`, started.input);
    clock.value += 1;
    const consume = registrationConsume(started.input, started.ids, actor, clock, label, exactCredentialId);
    await store.commit(consume);
    const effect = consume.mutation.secureCredentialEffect;
    if (effect?.type !== "store_registration_credential") throw new Error("missing registration effect");
    return { begin: started.input, consume, recordId: effect.credentialRecordId };
  }

  async function authenticationBegin(
    store: SqliteStore,
    actor: AccountFixture,
    clock: MutableClock,
    label: string
  ): Promise<{ input: PersistCeremonyMutation; ids: SequenceIds }> {
    const issued = await store.issue({
      byteLength: PASSKEY_CHALLENGE_BYTES,
      expiresAtMs: clock.value + POLICY.timeoutMs
    });
    const ids = new SequenceIds(label);
    const snapshot: CeremonyAggregate = {
      schemaVersion: PASSKEY_DOMAIN_VERSION,
      ceremonyId: ids.next("ceremony"),
      kind: "authentication",
      purpose: { type: "session.step_up", targetDigest: TARGET_DIGEST },
      actor: actorBinding(actor),
      policyVersion: PASSKEY_DOMAIN_VERSION,
      expectedRpId: POLICY.rpId,
      expectedOrigin: ORIGIN,
      timeoutMs: POLICY.timeoutMs,
      maxResponseBytes: POLICY.maxResponseBytes,
      userVerification: "required",
      crossOriginAllowed: false,
      expectedTopOrigins: [],
      attestation: "none",
      registrationResidentKey: "required",
      allowedAlgorithms: [-7, -257],
      credentialBoundary: { mode: "discoverable", credentialSetRef: null },
      userHandleRef: null,
      challenge: {
        reference: issued.reference,
        digest: challengeDigest(issued.challenge),
        byteLength: PASSKEY_CHALLENGE_BYTES
      },
      state: "pending",
      revision: 1,
      attemptsUsed: 0,
      maxAttempts: POLICY.maxAttempts,
      createdAtMs: clock.value,
      expiresAtMs: clock.value + POLICY.timeoutMs,
      updatedAtMs: clock.value,
      terminalAtMs: null,
      terminalReason: null,
      riskSignals: []
    };
    const mutation = ceremonyMutation(snapshot, "passkey.ceremony.started", `begin-${label}`, ids, null);
    return { input: persistInput(mutation, null, `begin-${label}`), ids };
  }

  function authenticationConsume(
    begin: PersistCeremonyMutation,
    ids: SequenceIds,
    actor: AccountFixture,
    clock: MutableClock,
    label: string,
    recordId: string
  ): PersistCeremonyMutation {
    const credential: VerifiedAuthenticationCredential = {
      credentialRecordId: recordId,
      credentialRevision: 1,
      accountId: actor.accountId,
      discoveryMode: "discoverable",
      userHandleBindingVerified: true,
      previousSignCount: 9,
      newSignCount: 10,
      previousBackupEligible: true,
      backupEligible: true,
      previousBackupState: false,
      backupState: true,
      userPresent: true,
      userVerified: true
    };
    const snapshot: CeremonyAggregate = {
      ...begin.mutation.snapshot,
      state: "consumed",
      revision: 2,
      updatedAtMs: clock.value,
      terminalAtMs: clock.value,
      terminalReason: "verified",
      riskSignals: ["backup_state_enabled"]
    };
    const mutation = ceremonyMutation(
      snapshot,
      "passkey.ceremony.consumed",
      `verify-${label}`,
      ids,
      {
        type: "update_authentication_credential",
        ceremonyId: snapshot.ceremonyId,
        credential,
        riskSignals: ["backup_state_enabled"]
      }
    );
    return persistInput(mutation, 1, `verify-${label}`);
  }

  it("keeps challenge secrets encrypted with reference-bound AAD, TTL, discard and bounded purge", async () => {
    const path = pathFor("vault");
    const encodedKey = randomBytes(32).toString("base64url");
    const clock = { value: NOW_MS };
    const store = openStore(path, encodedKey, clock);
    const expiredSoon = await store.issue({ byteLength: 32, expiresAtMs: NOW_MS + 10 });
    const live = await store.issue({ byteLength: 32, expiresAtMs: NOW_MS + 100 });

    const inspection = new Database(path);
    const rows = inspection.prepare(`
      SELECT reference, challenge_ciphertext FROM passkey_challenge_secrets ORDER BY reference
    `).all() as Array<{ reference: string; challenge_ciphertext: string }>;
    expect(rows).toHaveLength(2);
    expect(rows.every(({ challenge_ciphertext }) => challenge_ciphertext.startsWith("luxora:v1."))).toBe(true);
    expect(JSON.stringify(rows)).not.toContain(expiredSoon.challenge);
    expect(JSON.stringify(rows)).not.toContain(live.challenge);

    expect(await store.purgeExpiredPasskeyChallengeSecrets(NOW_MS + 50, 1)).toBe(1);
    expect(await store.resolve(expiredSoon.reference)).toBeNull();
    expect(await store.resolve(live.reference)).toBe(live.challenge);
    expect(await store.purgeExpiredPasskeyChallengeSecrets(NOW_MS + 50, 10)).toBe(0);

    const source = rows.find(({ reference }) => reference === live.reference);
    expect(source).toBeDefined();
    inspection.prepare(`
      INSERT INTO passkey_challenge_secrets (
        reference, challenge_ciphertext, expires_at_ms, created_at_ms
      ) VALUES ('challenge:copied-aad', ?, ?, ?)
    `).run(source!.challenge_ciphertext, NOW_MS + 100, NOW_MS);
    await expect(store.resolve("challenge:copied-aad"))
      .rejects.toThrow("Passkey repository integrity check failed");

    await store.discard(live.reference);
    expect(await store.resolve(live.reference)).toBeNull();
    expect(inspection.pragma("integrity_check")).toEqual([{ integrity_check: "ok" }]);
    expect(inspection.pragma("foreign_key_check")).toEqual([]);
    inspection.close();
  });

  it("refuses plaintext vault/user-handle persistence", async () => {
    const path = pathFor("plaintext-refusal");
    const clock = { value: NOW_MS };
    const store = new SqliteStore(path, undefined, () => clock.value);
    stores.push(store);
    await expect(store.issue({ byteLength: 32, expiresAtMs: NOW_MS + 100 }))
      .rejects.toThrow("requires authenticated encryption");
    const account = `account-plaintext`;
    store.createUser({
      id: account,
      username: "plaintext",
      usernameNormalized: "plaintext",
      displayName: "Plaintext",
      passwordHash: "hash",
      createdAt: new Date(NOW_MS).toISOString()
    });
    await expect(store.getOrCreatePasskeyUserHandleBinding(account))
      .rejects.toThrow("requires authenticated encryption");
    const inspection = new Database(path, { readonly: true });
    expect((inspection.prepare("SELECT COUNT(*) AS count FROM passkey_challenge_secrets").get() as { count: number }).count).toBe(0);
    expect((inspection.prepare("SELECT COUNT(*) AS count FROM passkey_user_handles").get() as { count: number }).count).toBe(0);
    inspection.close();
  });

  it("creates one stable encrypted userHandle binding across independent connections and reopen", async () => {
    const path = pathFor("user-handle");
    const encodedKey = randomBytes(32).toString("base64url");
    const clock = { value: NOW_MS };
    const first = openStore(path, encodedKey, clock);
    const actor = await provisionAccount(first, "handle");
    const second = openStore(path, encodedKey, clock);
    const [left, right] = await Promise.all([
      first.getOrCreatePasskeyUserHandleBinding(actor.accountId),
      second.getOrCreatePasskeyUserHandleBinding(actor.accountId)
    ]);
    expect(left).toEqual(right);
    expect(left.userHandle).toBe(actor.userHandle);

    const inspection = new Database(path);
    const row = inspection.prepare(`
      SELECT reference, handle_digest, handle_ciphertext FROM passkey_user_handles
    `).get() as { reference: string; handle_digest: string; handle_ciphertext: string };
    expect(row.reference).toBe(actor.userHandleRef);
    expect(row.handle_digest).toBe(digestText(actor.userHandle));
    expect(row.handle_ciphertext).toMatch(/^luxora:v1\./u);
    expect(row.handle_ciphertext).not.toContain(actor.userHandle);
    inspection.close();

    closeStore(first);
    closeStore(second);
    const reopened = openStore(path, encodedKey, clock);
    expect(await reopened.findPasskeyUserHandleByAccountId(actor.accountId)).toEqual(left);
    expect(await reopened.findPasskeyUserHandleByRef(actor.userHandleRef)).toEqual(left);
    expect(await reopened.findPasskeyUserHandleByRef("not valid")).toBeNull();

    const other = await provisionAccount(reopened, "handle-other");
    const tamper = new Database(path);
    tamper.pragma("foreign_keys = ON");
    tamper.prepare("DELETE FROM passkey_user_handles WHERE reference = ?").run(other.userHandleRef);
    tamper.prepare("UPDATE passkey_user_handles SET account_id = ? WHERE reference = ?")
      .run(other.accountId, actor.userHandleRef);
    tamper.close();
    await expect(reopened.findPasskeyUserHandleByRef(actor.userHandleRef))
      .rejects.toThrow("Passkey repository integrity check failed");
  });

  it("keeps a prepared userHandle in memory when the durable step-up grant is missing", async () => {
    const path = pathFor("prepared-handle-no-grant");
    const encodedKey = randomBytes(32).toString("base64url");
    const clock = { value: NOW_MS };
    const store = openStore(path, encodedKey, clock);
    const account = provisionAccountSession(store, "prepared-handle-no-grant");
    const candidate = await store.preparePasskeyUserHandleBinding(account.accountId);
    const actor = actorWithUserHandle(account, candidate);
    const registration = await registrationBegin(store, actor, clock, "prepared-handle-no-grant");
    const nowSec = Math.floor(clock.value / 1_000);
    const claims: PasskeyStepUpClaimsProjection = {
      sub: account.accountId,
      sid: account.sessionId,
      ceremony_id: `missing-step-up-${digestText("prepared-handle-no-grant").slice(0, 32)}`,
      jti: Buffer.from(digestText("prepared-handle-no-grant-jti"), "hex").toString("base64url"),
      purpose: "authenticator.add",
      target_digest: TARGET_DIGEST,
      auth_time: nowSec,
      iat: nowSec,
      exp: nowSec + 300
    };

    expect(await store.findPasskeyUserHandleByAccountId(account.accountId)).toBeNull();
    await expect(store.commitInitialPasskeyRegistration(
      registration.input,
      claims,
      candidate
    )).rejects.toBeInstanceOf(StoreAuthorizationConflictError);
    expect(await store.findPasskeyUserHandleByAccountId(account.accountId)).toBeNull();
    expect(await store.findPasskeyUserHandleByRef(candidate.reference)).toBeNull();
    expect(await store.loadCeremony(registration.input.mutation.snapshot.ceremonyId)).toBeNull();
    expect(await store.findCommandReceipt(registration.input.commandReceipt.scope)).toBeNull();
    expect(await store.findCreationReceipt(registration.input.creationReceipt!.scope)).toBeNull();
  });

  it("serializes different prepared handles so the losing grant stays reusable", async () => {
    const path = pathFor("prepared-handle-race");
    const encodedKey = randomBytes(32).toString("base64url");
    const clock = { value: NOW_MS };
    const store = openStore(path, encodedKey, clock);
    const account = provisionAccountSession(store, "prepared-handle-race");
    const leftBinding = await store.preparePasskeyUserHandleBinding(account.accountId);
    const rightBinding = await store.preparePasskeyUserHandleBinding(account.accountId);
    expect(leftBinding.reference).not.toBe(rightBinding.reference);
    const leftActor = actorWithUserHandle(account, leftBinding);
    const rightActor = actorWithUserHandle(account, rightBinding);
    const left = await registrationBegin(store, leftActor, clock, "prepared-handle-race-left");
    const right = await registrationBegin(store, rightActor, clock, "prepared-handle-race-right");
    const leftGrant = seedStepUpGrant(store, leftActor, clock, "prepared-handle-race-left");
    const rightGrant = seedStepUpGrant(store, rightActor, clock, "prepared-handle-race-right");
    const gate = new SharedArrayBuffer(4);
    const first = startCommitWorker(
      path,
      encodedKey,
      gate,
      left.input,
      clock.value,
      leftGrant.claims,
      leftBinding
    );
    const second = startCommitWorker(
      path,
      encodedKey,
      gate,
      right.input,
      clock.value,
      rightGrant.claims,
      rightBinding
    );
    workers.push(first.worker, second.worker);
    await Promise.all([first.ready, second.ready]);
    Atomics.store(new Int32Array(gate), 0, 1);
    Atomics.notify(new Int32Array(gate), 0, 2);
    const outcomes = await Promise.all([first.outcome, second.outcome]);
    expect(outcomes.filter(({ ok }) => ok)).toHaveLength(1);
    expect(outcomes.find(({ ok }) => !ok)).toEqual({
      ok: false,
      name: "StoreRevisionConflictError"
    });

    const leftWon = outcomes[0]?.ok === true;
    const winner = leftWon
      ? { registration: left, binding: leftBinding, grant: leftGrant }
      : { registration: right, binding: rightBinding, grant: rightGrant };
    const loser = leftWon
      ? { registration: right, binding: rightBinding, grant: rightGrant }
      : { registration: left, binding: leftBinding, grant: leftGrant };
    expect(await store.findPasskeyUserHandleByAccountId(account.accountId)).toEqual(winner.binding);
    expect(await store.findPasskeyUserHandleByRef(loser.binding.reference)).toBeNull();
    expect(await store.loadCeremony(winner.registration.input.mutation.snapshot.ceremonyId))
      .toMatchObject({ state: "pending", revision: 1, userHandleRef: winner.binding.reference });
    expect(await store.loadCeremony(loser.registration.input.mutation.snapshot.ceremonyId)).toBeNull();
    expect(await store.findPasskeyStepUpGrant(winner.grant.authenticationCeremonyId))
      .toMatchObject({ registrationCeremonyId: winner.registration.input.mutation.snapshot.ceremonyId });
    expect(await store.findPasskeyStepUpGrant(loser.grant.authenticationCeremonyId))
      .toMatchObject({ consumedAtSec: null, registrationCeremonyId: null });
  });

  it("atomically persists binding, snapshot, event, minimized outbox, receipts and encrypted credential material", async () => {
    const path = pathFor("atomic-registration");
    const encodedKey = randomBytes(32).toString("base64url");
    const clock = { value: NOW_MS };
    const store = openStore(path, encodedKey, clock);
    const actor = await provisionAccount(store, "atomic");
    const exactCredentialId = credentialId("atomic-canary");
    const registered = await registerCredential(store, actor, clock, "atomic", exactCredentialId);

    const credential = await store.findPasskeyCredentialById(exactCredentialId);
    expect(credential).toMatchObject({
      recordId: registered.recordId,
      credentialId: exactCredentialId,
      accountId: actor.accountId,
      userHandleRef: actor.userHandleRef,
      algorithm: -7,
      discoveryMode: "discoverable",
      credentialSetRef: null,
      revision: 1,
      signCount: 9,
      backupEligible: true,
      backupState: false,
      transports: ["internal", "cable"]
    });
    expect(new TextDecoder().decode(credential?.publicKey)).toBe(`${PUBLIC_KEY_CANARY}:atomic`);
    expect(await store.findPasskeyCredentialByRecordId(registered.recordId)).toEqual(credential);
    expect(await store.findPasskeyCredentialById("not+canonical")).toBeNull();
    expect(await store.findPasskeyCredentialById(credentialId("missing"))).toBeNull();
    expect(await store.listPasskeyCredentialsByAccountId(actor.accountId)).toEqual([credential]);

    const inspection = new Database(path);
    const ceremonyRow = inspection.prepare(`
      SELECT account_id, session_id, device_id, purpose_type, purpose_target_digest,
             user_handle_ref, state, revision, attempts_used
      FROM passkey_ceremonies WHERE ceremony_id = ?
    `).get(registered.consume.mutation.snapshot.ceremonyId) as Record<string, unknown>;
    expect(ceremonyRow).toMatchObject({
      account_id: actor.accountId,
      session_id: actor.sessionId,
      device_id: actor.deviceId,
      purpose_type: "authenticator.add",
      purpose_target_digest: TARGET_DIGEST,
      user_handle_ref: actor.userHandleRef,
      state: "consumed",
      revision: 2,
      attempts_used: 0
    });
    const secureRow = inspection.prepare(`
      SELECT credential_id_digest, credential_id_ciphertext, credential_material_ciphertext
      FROM passkey_credentials WHERE record_id = ?
    `).get(registered.recordId) as Record<string, string>;
    expect(secureRow["credential_id_digest"]).toBe(digestText(exactCredentialId));
    expect(secureRow["credential_id_ciphertext"]).toMatch(/^luxora:v1\./u);
    expect(secureRow["credential_material_ciphertext"]).toMatch(/^luxora:v1\./u);
    expect(JSON.stringify(secureRow)).not.toContain(exactCredentialId);
    expect(JSON.stringify(secureRow)).not.toContain(PUBLIC_KEY_CANARY);
    expect(JSON.stringify(secureRow)).not.toContain("internal");

    const counts = Object.fromEntries([
      "passkey_ceremonies",
      "passkey_ceremony_events",
      "passkey_ceremony_outbox",
      "passkey_command_receipts",
      "passkey_creation_receipts",
      "passkey_credentials",
      "passkey_step_up_grants"
    ].map((table) => [table, (inspection.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count]));
    expect(counts).toEqual({
      passkey_ceremonies: 1,
      passkey_ceremony_events: 2,
      passkey_ceremony_outbox: 2,
      passkey_command_receipts: 2,
      passkey_creation_receipts: 1,
      passkey_credentials: 1,
      passkey_step_up_grants: 1
    });
    const outboxPayloads = inspection.prepare("SELECT payload_json FROM passkey_ceremony_outbox")
      .all() as Array<{ payload_json: string }>;
    expect(JSON.stringify(outboxPayloads)).not.toContain(actor.accountId);
    expect(JSON.stringify(outboxPayloads)).not.toContain(actor.sessionId);
    expect(JSON.stringify(outboxPayloads)).not.toContain("challenge:");
    expect(JSON.stringify(outboxPayloads)).not.toContain(exactCredentialId);
    expect(inspection.pragma("integrity_check")).toEqual([{ integrity_check: "ok" }]);
    expect(inspection.pragma("foreign_key_check")).toEqual([]);
    inspection.close();
  });

  it("reopens durable aggregate/receipts/credential without raw challenge or credential material", async () => {
    const path = pathFor("reopen");
    const encodedKey = randomBytes(32).toString("base64url");
    const clock = { value: NOW_MS };
    const first = openStore(path, encodedKey, clock);
    const actor = await provisionAccount(first, "reopen");
    const registered = await registerCredential(first, actor, clock, "reopen");
    const expectedSnapshot = registered.consume.mutation.snapshot;
    closeStore(first);

    const reopened = openStore(path, encodedKey, clock);
    expect(await reopened.loadCeremony(expectedSnapshot.ceremonyId)).toEqual(expectedSnapshot);
    expect(await reopened.findCommandReceipt(registered.consume.commandReceipt.scope))
      .toEqual(registered.consume.commandReceipt);
    expect(await reopened.findCreationReceipt(registered.begin.creationReceipt!.scope))
      .toEqual(registered.begin.creationReceipt);
    expect(await reopened.findPasskeyCredentialByRecordId(registered.recordId))
      .toMatchObject({ credentialId: credentialId("reopen"), revision: 1 });
  });

  it("enforces command idempotency and ceremony CAS without partial event/outbox writes", async () => {
    const path = pathFor("ceremony-cas");
    const encodedKey = randomBytes(32).toString("base64url");
    const clock = { value: NOW_MS };
    const store = openStore(path, encodedKey, clock);
    const actor = await provisionAccount(store, "cas");
    const started = await registrationBegin(store, actor, clock, "cas");
    const claims = await commitRegistrationBegin(store, actor, clock, "grant-cas", started.input);
    await expect(store.commitInitialPasskeyRegistration(started.input, claims, userHandleBinding(actor)))
      .rejects.toBeInstanceOf(StoreDuplicateCommandError);

    clock.value += 1;
    const cancelled = persistInput(cancelledMutation(
      started.input.mutation.snapshot,
      "cancel-cas",
      clock.value,
      started.ids
    ), 1, "cancel-cas");
    const rejected = persistInput(rejectedAttemptMutation(
      started.input.mutation.snapshot,
      "reject-cas",
      clock.value,
      started.ids
    ), 1, "reject-cas");
    await store.commit(cancelled);
    await expect(store.commit(rejected)).rejects.toBeInstanceOf(StoreRevisionConflictError);
    expect(await store.loadCeremony(started.input.mutation.snapshot.ceremonyId))
      .toMatchObject({ state: "cancelled", revision: 2, attemptsUsed: 0 });

    const inspection = new Database(path, { readonly: true });
    expect((inspection.prepare("SELECT COUNT(*) AS count FROM passkey_ceremony_events").get() as { count: number }).count).toBe(2);
    expect((inspection.prepare("SELECT COUNT(*) AS count FROM passkey_ceremony_outbox").get() as { count: number }).count).toBe(2);
    expect((inspection.prepare("SELECT COUNT(*) AS count FROM passkey_command_receipts").get() as { count: number }).count).toBe(2);
    inspection.close();
  });

  it("persists expiry/attempt state and rejects cross-account session/userHandle bindings atomically", async () => {
    const path = pathFor("binding-attempts");
    const encodedKey = randomBytes(32).toString("base64url");
    const clock = { value: NOW_MS };
    const store = openStore(path, encodedKey, clock);
    const left = await provisionAccount(store, "binding-left");
    const right = await provisionAccount(store, "binding-right");
    const started = await registrationBegin(store, left, clock, "attempt");
    await commitRegistrationBegin(store, left, clock, "grant-attempt", started.input);
    clock.value += 1;
    const rejected = persistInput(rejectedAttemptMutation(
      started.input.mutation.snapshot,
      "attempt-one",
      clock.value,
      started.ids
    ), 1, "attempt-one");
    await store.commit(rejected);
    expect(await store.loadCeremony(started.input.mutation.snapshot.ceremonyId))
      .toMatchObject({ state: "pending", revision: 2, attemptsUsed: 1, maxAttempts: 3 });

    const malformedActor: AccountFixture = {
      ...left,
      sessionId: right.sessionId
    };
    const mismatched = await registrationBegin(store, malformedActor, clock, "mismatched-session");
    const mismatchedGrant = seedStepUpGrant(store, left, clock, "mismatched-session-grant");
    await expect(store.commitInitialPasskeyRegistration(
      mismatched.input,
      mismatchedGrant.claims,
      userHandleBinding(malformedActor)
    ))
      .rejects.toBeInstanceOf(StoreAuthorizationConflictError);
    const mismatchedHandle: AccountFixture = {
      ...left,
      userHandleRef: right.userHandleRef,
      userHandle: right.userHandle
    };
    const wrongHandle = await registrationBegin(store, mismatchedHandle, clock, "mismatched-handle");
    const wrongHandleGrant = seedStepUpGrant(store, left, clock, "mismatched-handle-grant");
    await expect(store.commitInitialPasskeyRegistration(
      wrongHandle.input,
      wrongHandleGrant.claims,
      userHandleBinding(mismatchedHandle)
    )).rejects.toBeInstanceOf(StoreRevisionConflictError);
    expect(await store.findPasskeyStepUpGrant(wrongHandleGrant.authenticationCeremonyId))
      .toMatchObject({ consumedAtSec: null, registrationCeremonyId: null });

    const inspection = new Database(path, { readonly: true });
    expect((inspection.prepare(`
      SELECT COUNT(*) AS count FROM passkey_ceremonies
      WHERE ceremony_id IN (?, ?)
    `).get(mismatched.input.mutation.snapshot.ceremonyId, wrongHandle.input.mutation.snapshot.ceremonyId) as { count: number }).count).toBe(0);
    expect(inspection.pragma("foreign_key_check")).toEqual([]);
    inspection.close();
  });

  it("rolls back ceremony consumption when secure credential binding fails", async () => {
    const path = pathFor("effect-rollback");
    const encodedKey = randomBytes(32).toString("base64url");
    const clock = { value: NOW_MS };
    const store = openStore(path, encodedKey, clock);
    const actor = await provisionAccount(store, "rollback");
    const seed = await registerCredential(store, actor, clock, "rollback-seed");
    clock.value += 2;
    const started = await registrationBegin(store, actor, clock, "rollback-target");
    await commitRegistrationBegin(store, actor, clock, "grant-rollback-target", started.input);
    clock.value += 1;
    const consume = registrationConsume(started.input, started.ids, actor, clock, "rollback-target");
    const effect = consume.mutation.secureCredentialEffect;
    if (effect?.type !== "store_registration_credential") throw new Error("missing registration effect");
    const conflictingRecord: PersistCeremonyMutation = {
      ...consume,
      mutation: {
        ...consume.mutation,
        secureCredentialEffect: {
          ...effect,
          credentialRecordId: seed.recordId
        }
      }
    };
    await expect(store.commit(conflictingRecord))
      .rejects.toThrow("Passkey repository integrity check failed");
    expect(await store.loadCeremony(started.input.mutation.snapshot.ceremonyId))
      .toMatchObject({ state: "pending", revision: 1 });
    const readonly = new Database(path, { readonly: true });
    expect((readonly.prepare("SELECT COUNT(*) AS count FROM passkey_ceremony_events").get() as { count: number }).count).toBe(3);
    expect((readonly.prepare("SELECT COUNT(*) AS count FROM passkey_credentials").get() as { count: number }).count).toBe(1);
    expect(readonly.pragma("foreign_key_check")).toEqual([]);
    readonly.close();
  });

  it("rechecks session state and monotonic time at registration credential commit", async () => {
    const path = pathFor("registration-credential-session-races");
    const encodedKey = randomBytes(32).toString("base64url");
    const clock = { value: NOW_MS };
    const store = openStore(path, encodedKey, clock);
    for (const mode of ["revoked", "expired", "clock-rollback"] as const) {
      const actor = await provisionAccount(store, `registration-effect-${mode}`);
      const started = await registrationBegin(store, actor, clock, `registration-effect-${mode}`);
      await commitRegistrationBegin(
        store,
        actor,
        clock,
        `grant-registration-effect-${mode}`,
        started.input
      );
      clock.value += 1;
      const consume = registrationConsume(
        started.input,
        started.ids,
        actor,
        clock,
        `registration-effect-${mode}`
      );
      if (mode === "revoked") {
        store.revokeSession(actor.sessionId, new Date(clock.value).toISOString());
      } else if (mode === "expired") {
        const inspection = new Database(path);
        inspection.prepare("UPDATE device_sessions SET expires_at = ? WHERE id = ?")
          .run(new Date(clock.value).toISOString(), actor.sessionId);
        inspection.close();
      } else {
        clock.value -= 1;
      }

      await expect(store.commit(consume)).rejects
        .toBeInstanceOf(StoreCredentialStateConflictError);
      expect(await store.loadCeremony(started.input.mutation.snapshot.ceremonyId))
        .toMatchObject({ state: "pending", revision: 1 });
      const effect = consume.mutation.secureCredentialEffect;
      if (effect?.type !== "store_registration_credential") throw new Error("missing registration effect");
      expect(await store.findPasskeyCredentialByRecordId(effect.credentialRecordId)).toBeNull();
      expect(await store.findCommandReceipt(consume.commandReceipt.scope)).toBeNull();

      const inspection = new Database(path, { readonly: true });
      expect((inspection.prepare(`
        SELECT COUNT(*) AS count FROM passkey_ceremony_events WHERE ceremony_id = ?
      `).get(started.input.mutation.snapshot.ceremonyId) as { count: number }).count).toBe(1);
      expect((inspection.prepare(`
        SELECT COUNT(*) AS count FROM passkey_ceremony_outbox
        WHERE partition_key = ?
      `).get(started.input.mutation.snapshot.ceremonyId) as { count: number }).count).toBe(1);
      inspection.close();
    }
  });

  it("enforces globally unique digest-indexed credential IDs across two accounts", async () => {
    const path = pathFor("credential-unique-race");
    const encodedKey = randomBytes(32).toString("base64url");
    const clock = { value: NOW_MS };
    const store = openStore(path, encodedKey, clock);
    const left = await provisionAccount(store, "unique-left");
    const right = await provisionAccount(store, "unique-right");
    const leftBegin = await registrationBegin(store, left, clock, "unique-left");
    const rightBegin = await registrationBegin(store, right, clock, "unique-right");
    await commitRegistrationBegin(store, left, clock, "grant-unique-left", leftBegin.input);
    await commitRegistrationBegin(store, right, clock, "grant-unique-right", rightBegin.input);
    clock.value += 1;
    const sharedCredentialId = credentialId("globally-shared");
    const leftConsume = registrationConsume(leftBegin.input, leftBegin.ids, left, clock, "unique-left", sharedCredentialId);
    const rightConsume = registrationConsume(rightBegin.input, rightBegin.ids, right, clock, "unique-right", sharedCredentialId);

    const gate = new SharedArrayBuffer(4);
    const first = startCommitWorker(path, encodedKey, gate, leftConsume, clock.value);
    const second = startCommitWorker(path, encodedKey, gate, rightConsume, clock.value);
    workers.push(first.worker, second.worker);
    await Promise.all([first.ready, second.ready]);
    Atomics.store(new Int32Array(gate), 0, 1);
    Atomics.notify(new Int32Array(gate), 0, 2);
    const outcomes = await Promise.all([first.outcome, second.outcome]);
    expect(outcomes.filter(({ ok }) => ok)).toHaveLength(1);
    expect(outcomes.find(({ ok }) => !ok)).toEqual({ ok: false, name: "StoreCredentialConflictError" });

    const credential = await store.findPasskeyCredentialById(sharedCredentialId);
    expect(credential).not.toBeNull();
    const states = await Promise.all([
      store.loadCeremony(leftBegin.input.mutation.snapshot.ceremonyId),
      store.loadCeremony(rightBegin.input.mutation.snapshot.ceremonyId)
    ]);
    expect(states.map((state) => state?.state).sort()).toEqual(["consumed", "pending"]);
  });

  it("CASes one credential row across two ceremonies and independent SQLite writers", async () => {
    const path = pathFor("credential-cas-race");
    const encodedKey = randomBytes(32).toString("base64url");
    const clock = { value: NOW_MS };
    const store = openStore(path, encodedKey, clock);
    const actor = await provisionAccount(store, "credential-cas");
    const registered = await registerCredential(store, actor, clock, "credential-cas");
    clock.value += 1;
    const leftBegin = await authenticationBegin(store, actor, clock, "auth-left");
    const rightBegin = await authenticationBegin(store, actor, clock, "auth-right");
    await store.commit(leftBegin.input);
    await store.commit(rightBegin.input);
    clock.value += 1;
    const leftConsume = authenticationConsume(leftBegin.input, leftBegin.ids, actor, clock, "auth-left", registered.recordId);
    const rightConsume = authenticationConsume(rightBegin.input, rightBegin.ids, actor, clock, "auth-right", registered.recordId);

    const gate = new SharedArrayBuffer(4);
    const first = startCommitWorker(path, encodedKey, gate, leftConsume, clock.value);
    const second = startCommitWorker(path, encodedKey, gate, rightConsume, clock.value);
    workers.push(first.worker, second.worker);
    await Promise.all([first.ready, second.ready]);
    Atomics.store(new Int32Array(gate), 0, 1);
    Atomics.notify(new Int32Array(gate), 0, 2);
    const outcomes = await Promise.all([first.outcome, second.outcome]);
    expect(outcomes.filter(({ ok }) => ok)).toHaveLength(1);
    expect(outcomes.find(({ ok }) => !ok)).toEqual({ ok: false, name: "StoreCredentialStateConflictError" });

    expect(await store.findPasskeyCredentialByRecordId(registered.recordId)).toMatchObject({
      revision: 2,
      signCount: 10,
      backupEligible: true,
      backupState: true
    });
    const states = await Promise.all([
      store.loadCeremony(leftBegin.input.mutation.snapshot.ceremonyId),
      store.loadCeremony(rightBegin.input.mutation.snapshot.ceremonyId)
    ]);
    expect(states.map((state) => state?.state).sort()).toEqual(["consumed", "pending"]);
    const grants = await Promise.all([
      store.findPasskeyStepUpGrant(leftBegin.input.mutation.snapshot.ceremonyId),
      store.findPasskeyStepUpGrant(rightBegin.input.mutation.snapshot.ceremonyId)
    ]);
    expect(grants.filter((grant) => grant !== null)).toHaveLength(1);
  });

  it("serializes the 20-credential account limit across two SQLite writers", async () => {
    const path = pathFor("credential-limit-race");
    const encodedKey = randomBytes(32).toString("base64url");
    const clock = { value: NOW_MS };
    const store = openStore(path, encodedKey, clock);
    const actor = await provisionAccount(store, "limit");
    for (let index = 0; index < 19; index += 1) {
      clock.value += 2;
      await registerCredential(store, actor, clock, `limit-seed-${index}`);
    }
    const leftBegin = await registrationBegin(store, actor, clock, "limit-left");
    const rightBegin = await registrationBegin(store, actor, clock, "limit-right");
    await commitRegistrationBegin(store, actor, clock, "grant-limit-left", leftBegin.input);
    await commitRegistrationBegin(store, actor, clock, "grant-limit-right", rightBegin.input);
    clock.value += 1;
    const leftConsume = registrationConsume(leftBegin.input, leftBegin.ids, actor, clock, "limit-left");
    const rightConsume = registrationConsume(rightBegin.input, rightBegin.ids, actor, clock, "limit-right");

    const gate = new SharedArrayBuffer(4);
    const first = startCommitWorker(path, encodedKey, gate, leftConsume, clock.value);
    const second = startCommitWorker(path, encodedKey, gate, rightConsume, clock.value);
    workers.push(first.worker, second.worker);
    await Promise.all([first.ready, second.ready]);
    Atomics.store(new Int32Array(gate), 0, 1);
    Atomics.notify(new Int32Array(gate), 0, 2);
    const outcomes = await Promise.all([first.outcome, second.outcome]);
    expect(outcomes.filter(({ ok }) => ok)).toHaveLength(1);
    expect(outcomes.find(({ ok }) => !ok)).toEqual({ ok: false, name: "StoreCredentialConflictError" });
    expect(await store.listPasskeyCredentialsByAccountId(actor.accountId)).toHaveLength(20);
  });

  it("keeps credential lifecycle independent from transient ceremony/session retention", async () => {
    const path = pathFor("credential-retention");
    const encodedKey = randomBytes(32).toString("base64url");
    const clock = { value: NOW_MS };
    const store = openStore(path, encodedKey, clock);
    const actor = await provisionAccount(store, "retention");
    const registered = await registerCredential(store, actor, clock, "retention");
    const before = await store.findPasskeyCredentialByRecordId(registered.recordId);

    const inspection = new Database(path);
    inspection.pragma("foreign_keys = ON");
    inspection.prepare("DELETE FROM device_sessions WHERE id = ?").run(actor.sessionId);
    expect((inspection.prepare("SELECT COUNT(*) AS count FROM passkey_ceremonies").get() as { count: number }).count).toBe(0);
    expect((inspection.prepare("SELECT COUNT(*) AS count FROM passkey_credentials").get() as { count: number }).count).toBe(1);
    expect(inspection.pragma("foreign_key_check")).toEqual([]);
    inspection.close();
    expect(await store.findPasskeyCredentialByRecordId(registered.recordId)).toEqual(before);

    const accountDeletion = new Database(path);
    accountDeletion.pragma("foreign_keys = ON");
    accountDeletion.prepare("DELETE FROM users WHERE id = ?").run(actor.accountId);
    expect((accountDeletion.prepare("SELECT COUNT(*) AS count FROM passkey_credentials").get() as { count: number }).count).toBe(0);
    expect((accountDeletion.prepare("SELECT COUNT(*) AS count FROM passkey_user_handles").get() as { count: number }).count).toBe(0);
    expect(accountDeletion.pragma("foreign_key_check")).toEqual([]);
    accountDeletion.close();
    expect(await store.findPasskeyCredentialByRecordId(registered.recordId)).toBeNull();
  });

  it("fails closed on snapshot, receipt, credential material and AAD corruption", async () => {
    const path = pathFor("corruption");
    const encodedKey = randomBytes(32).toString("base64url");
    const clock = { value: NOW_MS };
    const store = openStore(path, encodedKey, clock);
    const actor = await provisionAccount(store, "corruption");
    const first = await registerCredential(store, actor, clock, "corruption-first");
    clock.value += 2;
    const second = await registerCredential(store, actor, clock, "corruption-second");

    const inspection = new Database(path);
    const firstMaterial = (inspection.prepare(`
      SELECT credential_material_ciphertext AS value
      FROM passkey_credentials WHERE record_id = ?
    `).get(first.recordId) as { value: string }).value;
    // Simulate storage corruption below the SQL defense layer. Ordinary SQL
    // mutation of this envelope is covered separately by the immutable trigger.
    inspection.exec("DROP TRIGGER trg_passkey_credentials_immutable_binding");
    inspection.prepare(`
      UPDATE passkey_credentials SET credential_material_ciphertext = ? WHERE record_id = ?
    `).run(firstMaterial, second.recordId);
    await expect(store.findPasskeyCredentialByRecordId(second.recordId))
      .rejects.toThrow("Passkey repository integrity check failed");

    const snapshot = first.consume.mutation.snapshot;
    inspection.prepare(`
      UPDATE passkey_ceremonies SET snapshot_json = ? WHERE ceremony_id = ?
    `).run(JSON.stringify({ ...snapshot, unexpected: "corruption" }), snapshot.ceremonyId);
    await expect(store.loadCeremony(snapshot.ceremonyId))
      .rejects.toThrow("Passkey repository integrity check failed");

    inspection.prepare(`
      UPDATE passkey_command_receipts SET result_snapshot_json = ? WHERE scope = ?
    `).run(JSON.stringify({ ...snapshot, unexpected: "receipt-corruption" }), first.consume.commandReceipt.scope);
    await expect(store.findCommandReceipt(first.consume.commandReceipt.scope))
      .rejects.toThrow("Passkey repository integrity check failed");
    expect(inspection.pragma("integrity_check")).toEqual([{ integrity_check: "ok" }]);
    expect(inspection.pragma("foreign_key_check")).toEqual([]);
    inspection.close();
  });

  it("returns one coarse conflict when registration exceeds the account limit", async () => {
    const path = pathFor("credential-limit");
    const encodedKey = randomBytes(32).toString("base64url");
    const clock = { value: NOW_MS };
    const store = openStore(path, encodedKey, clock);
    const actor = await provisionAccount(store, "limit-single");
    for (let index = 0; index < 20; index += 1) {
      clock.value += 2;
      await registerCredential(store, actor, clock, `limit-single-${index}`);
    }
    const started = await registrationBegin(store, actor, clock, "limit-overflow");
    await commitRegistrationBegin(store, actor, clock, "grant-limit-overflow", started.input);
    clock.value += 1;
    const overflow = registrationConsume(started.input, started.ids, actor, clock, "limit-overflow");
    await expect(store.commit(overflow)).rejects.toBeInstanceOf(StoreCredentialConflictError);
    expect(await store.loadCeremony(started.input.mutation.snapshot.ceremonyId))
      .toMatchObject({ state: "pending", revision: 1 });
    expect(await store.listPasskeyCredentialsByAccountId(actor.accountId)).toHaveLength(20);
  });

  it("creates an exact durable grant in the authentication commit and consumes it for one registration", async () => {
    const path = pathFor("real-step-up-grant");
    const encodedKey = randomBytes(32).toString("base64url");
    const clock = { value: NOW_MS };
    const store = openStore(path, encodedKey, clock);
    const actor = await provisionAccount(store, "real-step-up-grant");
    const registered = await registerCredential(store, actor, clock, "real-step-up-seed");
    clock.value += 1_000;

    const authorized = await createRealStepUpGrant(
      store,
      actor,
      clock,
      "real-step-up",
      registered.recordId
    );
    expect(authorized.grant).toEqual({
      authenticationCeremonyId: authorized.consume.mutation.snapshot.ceremonyId,
      accountId: actor.accountId,
      sessionId: actor.sessionId,
      deviceId: actor.deviceId,
      purpose: "authenticator.add",
      targetDigest: TARGET_DIGEST,
      authTimeSec: Math.floor(authorized.consume.mutation.snapshot.updatedAtMs / 1_000),
      issuedAtSec: Math.floor(authorized.consume.mutation.snapshot.updatedAtMs / 1_000),
      expiresAtSec: Math.floor(authorized.consume.mutation.snapshot.updatedAtMs / 1_000) + 300,
      consumedAtSec: null,
      registrationCeremonyId: null
    });

    clock.value += 1;
    const registration = await registrationBegin(store, actor, clock, "real-step-up-target");
    await store.commitInitialPasskeyRegistration(
      registration.input,
      authorized.claims,
      userHandleBinding(actor)
    );
    expect(await store.findPasskeyStepUpGrant(authorized.grant.authenticationCeremonyId))
      .toMatchObject({
        consumedAtSec: Math.floor(clock.value / 1_000),
        registrationCeremonyId: registration.input.mutation.snapshot.ceremonyId
      });

    const authCleanup = new Database(path);
    authCleanup.pragma("foreign_keys = ON");
    authCleanup.prepare("DELETE FROM passkey_ceremonies WHERE ceremony_id = ?")
      .run(authorized.grant.authenticationCeremonyId);
    authCleanup.close();
    expect(await store.loadCeremony(authorized.grant.authenticationCeremonyId)).toBeNull();
    expect(await store.findPasskeyStepUpGrant(authorized.grant.authenticationCeremonyId))
      .toMatchObject({ registrationCeremonyId: registration.input.mutation.snapshot.ceremonyId });
    clock.value += 1;
    await store.commit(registrationConsume(
      registration.input,
      registration.ids,
      actor,
      clock,
      "real-step-up-target"
    ));

    const inspection = new Database(path, { readonly: true });
    const grantColumns = (inspection.pragma("table_info(passkey_step_up_grants)") as Array<{ name: string }>)
      .map(({ name }) => name);
    expect(grantColumns).not.toContain("jti");
    expect(grantColumns.some((name) => /jwt|token/u.test(name))).toBe(false);
    expect(JSON.stringify(inspection.prepare("SELECT * FROM passkey_step_up_grants").all()))
      .not.toContain(authorized.claims.jti);
    inspection.close();
  });

  it("fails ordinary registration closed and rolls every binding mismatch back before grant consumption", async () => {
    const path = pathFor("grant-mismatch-matrix");
    const encodedKey = randomBytes(32).toString("base64url");
    const clock = { value: NOW_MS };
    const store = openStore(path, encodedKey, clock);
    const actor = await provisionAccount(store, "grant-matrix");
    const other = await provisionAccount(store, "grant-matrix-other");
    const registration = await registrationBegin(store, actor, clock, "grant-matrix-target");
    const seeded = seedStepUpGrant(store, actor, clock, "grant-matrix-source");

    await expect(store.commit(registration.input)).rejects
      .toBeInstanceOf(StoreAuthorizationConflictError);
    const invalidClaims: PasskeyStepUpClaimsProjection[] = [
      { ...seeded.claims, sub: other.accountId },
      { ...seeded.claims, sid: other.sessionId },
      { ...seeded.claims, ceremony_id: "another-authentication-ceremony" },
      { ...seeded.claims, jti: "not-canonical" },
      { ...seeded.claims, target_digest: "b".repeat(64) },
      {
        ...seeded.claims,
        auth_time: seeded.claims.auth_time + 1,
        iat: seeded.claims.iat + 1,
        exp: seeded.claims.exp + 1
      },
      { ...seeded.claims, exp: seeded.claims.exp - 1 },
      { ...seeded.claims, purpose: "session.step_up" as "authenticator.add" }
    ];
    for (const claims of invalidClaims) {
      await expect(store.commitInitialPasskeyRegistration(
        registration.input,
        claims,
        userHandleBinding(actor)
      ))
        .rejects.toBeInstanceOf(StoreAuthorizationConflictError);
      expect(await store.findPasskeyStepUpGrant(seeded.authenticationCeremonyId))
        .toMatchObject({ consumedAtSec: null, registrationCeremonyId: null });
      expect(await store.loadCeremony(registration.input.mutation.snapshot.ceremonyId)).toBeNull();
    }

    const otherRegistration = await registrationBegin(store, other, clock, "grant-matrix-other-target");
    await expect(store.commitInitialPasskeyRegistration(
      otherRegistration.input,
      seeded.claims,
      userHandleBinding(other)
    ))
      .rejects.toBeInstanceOf(StoreAuthorizationConflictError);
    await store.commitInitialPasskeyRegistration(
      registration.input,
      seeded.claims,
      userHandleBinding(actor)
    );

    const reused = await registrationBegin(store, actor, clock, "grant-matrix-reused-target");
    await expect(store.commitInitialPasskeyRegistration(
      reused.input,
      seeded.claims,
      userHandleBinding(actor)
    ))
      .rejects.toBeInstanceOf(StoreAuthorizationConflictError);
    expect(await store.loadCeremony(reused.input.mutation.snapshot.ceremonyId)).toBeNull();
    expect(await store.findPasskeyStepUpGrant(seeded.authenticationCeremonyId))
      .toMatchObject({ registrationCeremonyId: registration.input.mutation.snapshot.ceremonyId });
  });

  it("enforces grant not-before and exact expiry boundary with the store clock", async () => {
    const path = pathFor("grant-time-boundaries");
    const encodedKey = randomBytes(32).toString("base64url");
    const clock = { value: NOW_MS };
    const store = openStore(path, encodedKey, clock);
    const actor = await provisionAccount(store, "grant-time");

    clock.value = NOW_MS + 10_000;
    const future = seedStepUpGrant(store, actor, clock, "grant-not-yet-valid");
    clock.value = (future.claims.iat * 1_000) - 1;
    const earlyRegistration = await registrationBegin(store, actor, clock, "grant-early-target");
    await expect(store.commitInitialPasskeyRegistration(
      earlyRegistration.input,
      future.claims,
      userHandleBinding(actor)
    ))
      .rejects.toBeInstanceOf(StoreAuthorizationConflictError);
    expect(await store.findPasskeyStepUpGrant(future.authenticationCeremonyId))
      .toMatchObject({ consumedAtSec: null });

    clock.value = NOW_MS + 20_000;
    const expired = seedStepUpGrant(store, actor, clock, "grant-expiry-boundary");
    clock.value = expired.claims.exp * 1_000;
    const expiredRegistration = await registrationBegin(store, actor, clock, "grant-expired-target");
    await expect(store.commitInitialPasskeyRegistration(
      expiredRegistration.input,
      expired.claims,
      userHandleBinding(actor)
    ))
      .rejects.toBeInstanceOf(StoreAuthorizationConflictError);
    expect(await store.findPasskeyStepUpGrant(expired.authenticationCeremonyId))
      .toMatchObject({ consumedAtSec: null });

    clock.value = NOW_MS + 30_000;
    const live = seedStepUpGrant(store, actor, clock, "grant-last-live-millisecond");
    clock.value = (live.claims.exp * 1_000) - 1;
    const liveRegistration = await registrationBegin(store, actor, clock, "grant-live-target");
    await store.commitInitialPasskeyRegistration(
      liveRegistration.input,
      live.claims,
      userHandleBinding(actor)
    );
    expect(await store.findPasskeyStepUpGrant(live.authenticationCeremonyId))
      .toMatchObject({ registrationCeremonyId: liveRegistration.input.mutation.snapshot.ceremonyId });
  });

  it("rechecks revoked and expired sessions when consuming a grant and rolls the whole begin back", async () => {
    const path = pathFor("grant-session-consume-races");
    const encodedKey = randomBytes(32).toString("base64url");
    const clock = { value: NOW_MS };
    const store = openStore(path, encodedKey, clock);
    for (const mode of ["revoked", "expired"] as const) {
      const actor = await provisionAccount(store, `grant-consume-${mode}`);
      const seeded = seedStepUpGrant(store, actor, clock, `grant-consume-${mode}`);
      const registration = await registrationBegin(store, actor, clock, `grant-consume-${mode}-target`);
      if (mode === "revoked") {
        store.revokeSession(actor.sessionId, new Date(clock.value).toISOString());
      } else {
        const inspection = new Database(path);
        inspection.prepare("UPDATE device_sessions SET expires_at = ? WHERE id = ?")
          .run(new Date(clock.value).toISOString(), actor.sessionId);
        inspection.close();
      }
      await expect(store.commitInitialPasskeyRegistration(
        registration.input,
        seeded.claims,
        userHandleBinding(actor)
      ))
        .rejects.toBeInstanceOf(StoreAuthorizationConflictError);
      expect(await store.findPasskeyStepUpGrant(seeded.authenticationCeremonyId))
        .toMatchObject({ consumedAtSec: null, registrationCeremonyId: null });
      expect(await store.loadCeremony(registration.input.mutation.snapshot.ceremonyId)).toBeNull();
      expect(await store.findCommandReceipt(registration.input.commandReceipt.scope)).toBeNull();
    }
  });

  it("rolls authentication outcome, credential CAS, event and grant back on commit-time session races", async () => {
    const path = pathFor("grant-session-create-races");
    const encodedKey = randomBytes(32).toString("base64url");
    const clock = { value: NOW_MS };
    const store = openStore(path, encodedKey, clock);
    for (const mode of ["revoked", "expired"] as const) {
      const actor = await provisionAccount(store, `grant-create-${mode}`);
      const registered = await registerCredential(store, actor, clock, `grant-create-${mode}-seed`);
      clock.value += 1;
      const begun = await authenticationBegin(store, actor, clock, `grant-create-${mode}-auth`);
      await store.commit(begun.input);
      clock.value += 1;
      const consume = authenticationConsume(
        begun.input,
        begun.ids,
        actor,
        clock,
        `grant-create-${mode}-auth`,
        registered.recordId
      );
      // The proof timestamp is fixed in the mutation; the repository samples
      // its own later commit clock while holding BEGIN IMMEDIATE.
      clock.value += 1;
      if (mode === "revoked") {
        store.revokeSession(actor.sessionId, new Date(clock.value).toISOString());
      } else {
        const inspection = new Database(path);
        inspection.prepare("UPDATE device_sessions SET expires_at = ? WHERE id = ?")
          .run(new Date(clock.value).toISOString(), actor.sessionId);
        inspection.close();
      }
      await expect(store.commit(consume)).rejects
        .toBeInstanceOf(StoreCredentialStateConflictError);
      expect(await store.loadCeremony(begun.input.mutation.snapshot.ceremonyId))
        .toMatchObject({ state: "pending", revision: 1 });
      expect(await store.findPasskeyCredentialByRecordId(registered.recordId))
        .toMatchObject({ revision: 1, signCount: 9, backupState: false });
      expect(await store.findPasskeyStepUpGrant(begun.input.mutation.snapshot.ceremonyId)).toBeNull();
      expect(await store.findCommandReceipt(consume.commandReceipt.scope)).toBeNull();
    }
  });

  it("serializes two distinct registration begins so one durable grant has exactly one winner", async () => {
    const path = pathFor("grant-consume-race");
    const encodedKey = randomBytes(32).toString("base64url");
    const clock = { value: NOW_MS };
    const store = openStore(path, encodedKey, clock);
    const actor = await provisionAccount(store, "grant-race");
    const registered = await registerCredential(store, actor, clock, "grant-race-seed");
    clock.value += 1;
    const authorized = await createRealStepUpGrant(
      store,
      actor,
      clock,
      "grant-race",
      registered.recordId
    );
    clock.value += 1;
    const left = await registrationBegin(store, actor, clock, "grant-race-left");
    const right = await registrationBegin(store, actor, clock, "grant-race-right");
    const gate = new SharedArrayBuffer(4);
    const first = startCommitWorker(
      path,
      encodedKey,
      gate,
      left.input,
      clock.value,
      authorized.claims,
      userHandleBinding(actor)
    );
    const second = startCommitWorker(
      path,
      encodedKey,
      gate,
      right.input,
      clock.value,
      authorized.claims,
      userHandleBinding(actor)
    );
    workers.push(first.worker, second.worker);
    await Promise.all([first.ready, second.ready]);
    Atomics.store(new Int32Array(gate), 0, 1);
    Atomics.notify(new Int32Array(gate), 0, 2);
    const outcomes = await Promise.all([first.outcome, second.outcome]);
    expect(outcomes.filter(({ ok }) => ok)).toHaveLength(1);
    expect(outcomes.find(({ ok }) => !ok)).toEqual({
      ok: false,
      name: "StoreAuthorizationConflictError"
    });
    const grant = await store.findPasskeyStepUpGrant(authorized.grant.authenticationCeremonyId);
    expect([
      left.input.mutation.snapshot.ceremonyId,
      right.input.mutation.snapshot.ceremonyId
    ]).toContain(grant?.registrationCeremonyId);
    const ceremonies = await Promise.all([
      store.loadCeremony(left.input.mutation.snapshot.ceremonyId),
      store.loadCeremony(right.input.mutation.snapshot.ceremonyId)
    ]);
    expect(ceremonies.filter((ceremony) => ceremony !== null)).toHaveLength(1);
  });

  it("blocks grant reset and unlinked or immutable credential writes in direct SQL paths", async () => {
    const path = pathFor("grant-direct-sql-guards");
    const encodedKey = randomBytes(32).toString("base64url");
    const clock = { value: NOW_MS };
    const store = openStore(path, encodedKey, clock);
    const actor = await provisionAccount(store, "grant-direct-sql");
    const inspection = new Database(path);
    inspection.pragma("foreign_keys = ON");
    const insertGrant = inspection.prepare(`
      INSERT INTO passkey_step_up_grants (
        authentication_ceremony_id, account_id, session_id, device_id,
        purpose, target_digest, auth_time_sec, issued_at_sec, expires_at_sec,
        consumed_at_sec, registration_ceremony_id
      ) VALUES (?, ?, ?, ?, 'authenticator.add', ?, ?, ?, ?, NULL, NULL)
    `);
    const nowSec = Math.floor(clock.value / 1_000);
    expect(() => insertGrant.run(
      "orphan-authentication",
      actor.accountId,
      actor.sessionId,
      actor.deviceId,
      TARGET_DIGEST,
      nowSec,
      nowSec,
      nowSec + 300
    )).toThrow("passkey step-up grant requires a consumed authentication");

    const source = seedStepUpGrant(store, actor, clock, "grant-direct-sql-source");
    const registration = await registrationBegin(store, actor, clock, "grant-direct-sql-registration");
    await store.commitInitialPasskeyRegistration(
      registration.input,
      source.claims,
      userHandleBinding(actor)
    );
    const grantBeforeDelete = inspection.prepare(`
      SELECT * FROM passkey_step_up_grants WHERE authentication_ceremony_id = ?
    `).get(source.authenticationCeremonyId);
    expect(() => inspection.prepare(`
      DELETE FROM passkey_step_up_grants WHERE authentication_ceremony_id = ?
    `).run(source.authenticationCeremonyId))
      .toThrow("passkey step-up grant cannot be deleted while its session exists");
    expect(inspection.prepare(`
      SELECT * FROM passkey_step_up_grants WHERE authentication_ceremony_id = ?
    `).get(source.authenticationCeremonyId)).toEqual(grantBeforeDelete);

    expect(() => inspection.prepare(`
      INSERT INTO passkey_credentials (
        record_id, credential_id_digest, credential_id_ciphertext, account_id,
        user_handle_ref, credential_material_ciphertext, algorithm, discovery_mode,
        credential_set_ref, revision, sign_count, backup_eligible, backup_state,
        registration_ceremony_id, created_at_ms, updated_at_ms
      ) VALUES (?, ?, 'luxora:v1.fake', ?, ?, 'luxora:v1.fake', -7, 'discoverable',
        NULL, 1, 0, 0, 0, ?, ?, ?)
    `).run(
      "unlinked-record",
      digestText("unlinked-credential"),
      actor.accountId,
      actor.userHandleRef,
      "unlinked-registration",
      clock.value,
      clock.value
    )).toThrow("passkey registration requires a consumed step-up grant");

    clock.value += 1;
    const consume = registrationConsume(
      registration.input,
      registration.ids,
      actor,
      clock,
      "grant-direct-sql-registration"
    );
    await store.commit(consume);
    const effect = consume.mutation.secureCredentialEffect;
    if (effect?.type !== "store_registration_credential") throw new Error("missing registration effect");
    for (const statement of [
      "UPDATE passkey_credentials SET algorithm = -257 WHERE record_id = ?",
      "UPDATE passkey_credentials SET credential_id_digest = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' WHERE record_id = ?",
      "UPDATE passkey_credentials SET backup_eligible = 0 WHERE record_id = ?",
      "UPDATE passkey_credentials SET credential_material_ciphertext = 'luxora:v1.rebound' WHERE record_id = ?"
    ]) {
      expect(() => inspection.prepare(statement).run(effect.credentialRecordId))
        .toThrow("passkey credential binding is immutable");
    }
    inspection.close();
  });
});
