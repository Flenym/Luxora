import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";

import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import type {
  AuthenticationVerificationExpectations,
  MaintainedWebAuthnVerifierAdapter,
  RegistrationVerificationExpectations
} from "@luxora/passkey-domain";

import type {
  PersistPasskeyAuthenticatorRename,
  PersistPasskeyAuthenticatorRevoke
} from "./domain/store.js";
import type { AuthenticatedPrincipal } from "./domain/types.js";
import { parsePasskeyResponseBody } from "./http/passkey-response-body.js";
import { AesGcmContentCipher } from "./infrastructure/content-cipher.js";
import { migrations } from "./infrastructure/migrations.js";
import { SqliteStore } from "./infrastructure/sqlite-store.js";
import {
  passkeyAuthenticatorRenameFingerprint,
  passkeyAuthenticatorRevokeFingerprint,
  passkeyAuthenticatorRevokeTargetDigest
} from "./passkeys/authenticator-management-binding.js";
import { StepUpTokenSecurity } from "./passkeys/step-up-token.js";
import { PasskeyAuthenticatorManagementService } from "./services/passkey-authenticator-management-service.js";
import type {
  AuthenticationOptionsInput,
  RegistrationOptionsInput,
  SimpleWebAuthnVerifierAdapter
} from "./passkeys/simplewebauthn-adapter.js";
import { PasskeyService } from "./services/passkey-service.js";
import { seedExistingPasskeyCredentialForTest } from "./test-support/passkey-service-fixture.js";

const NOW_MS = 1_800_000_000_000;
const ACCOUNT_ID = "11111111-1111-4111-8111-111111111111";
const PRIMARY_SESSION_ID = "22222222-2222-4222-8222-222222222222";
const FIRST_CREDENTIAL_ID = Buffer.from("first-management-credential", "utf8").toString("base64url");
const SECOND_CREDENTIAL_ID = Buffer.from("second-management-credential", "utf8").toString("base64url");
const FIRST_RECORD_ID = "33333333-3333-4333-8333-333333333333";
const SECOND_RECORD_ID = "44444444-4444-4444-8444-444444444444";
const USER_HANDLE_REF = "management-user-handle";
const USER_HANDLE = Buffer.alloc(32, 29).toString("base64url");
const DATA_KEY = Buffer.alloc(32, 41).toString("base64url");
const DATA_KEY_ID = "management.v1";
const STEP_UP_SECRET = "management-step-up-secret-with-at-least-32-bytes";
const CREATED_AT = new Date(NOW_MS).toISOString();
const EXPIRES_AT = new Date(NOW_MS + 86_400_000).toISOString();

interface Fixture {
  readonly directory: string;
  readonly path: string;
  readonly cipher: AesGcmContentCipher;
  readonly clock: { value: number };
  store: SqliteStore;
  service: PasskeyAuthenticatorManagementService;
  passkeyService: PasskeyService;
  readonly stepUpTokens: StepUpTokenSecurity;
  readonly principal: AuthenticatedPrincipal;
  readonly cleanupCalls: string[][];
  readonly cleanupFailures: unknown[];
}

/** The ceremony executor and SQLite CAS are real; only device crypto is a test seam. */
class ManagementWebAuthnAdapter implements MaintainedWebAuthnVerifierAdapter {
  readonly implementation = Object.freeze({
    kind: "maintained-webauthn-server-library" as const,
    libraryName: "@simplewebauthn/server",
    libraryVersion: "13.3.2",
    reviewReference: "management-service-executor-seam"
  });

  constructor(
    private readonly store: SqliteStore,
    private readonly forcedCredentialId: string | null = null
  ) {}

  createRegistrationOptions(
    _input: RegistrationOptionsInput
  ): ReturnType<SimpleWebAuthnVerifierAdapter["createRegistrationOptions"]> {
    throw new Error("registration is outside this management test seam");
  }

  async createAuthenticationOptions(
    input: AuthenticationOptionsInput
  ): ReturnType<SimpleWebAuthnVerifierAdapter["createAuthenticationOptions"]> {
    return {
      challenge: input.expectedChallenge,
      rpId: input.expectedRpId,
      timeout: input.timeoutMs,
      userVerification: "required" as const,
      allowCredentials: []
    };
  }

  async verifyRegistration(
    _response: unknown,
    _expectations: RegistrationVerificationExpectations
  ) {
    return { status: "rejected" as const, reason: "invalid_webauthn_response" as const };
  }

  async verifyAuthentication(
    _response: unknown,
    expectations: AuthenticationVerificationExpectations
  ) {
    const record = this.forcedCredentialId === null
      ? (await this.store.listPasskeyCredentialsByAccountId(expectations.expectedAccountId))[0]
      : await this.store.findPasskeyCredentialById(this.forcedCredentialId);
    if (record === undefined || record === null || record.accountId !== expectations.expectedAccountId) {
      return { status: "rejected" as const, reason: "invalid_webauthn_response" as const };
    }
    return {
      status: "verified" as const,
      kind: "authentication" as const,
      credential: {
        credentialRecordId: record.recordId,
        credentialRevision: record.revision,
        accountId: expectations.expectedAccountId,
        discoveryMode: "discoverable" as const,
        userHandleBindingVerified: true as const,
        previousSignCount: record.signCount,
        newSignCount: record.signCount + 1,
        previousBackupEligible: record.backupEligible,
        backupEligible: record.backupEligible,
        previousBackupState: record.backupState,
        backupState: record.backupState,
        userPresent: true as const,
        userVerified: true as const
      }
    };
  }
}

const fixtures: Fixture[] = [];
const workers: Worker[] = [];

type ManagementMutation = PersistPasskeyAuthenticatorRename | PersistPasskeyAuthenticatorRevoke;

interface RaceOutcome {
  readonly ok: boolean;
  readonly name?: string;
  readonly replayed?: boolean;
  readonly revision?: number;
  readonly lifecycleState?: string;
}

interface RunningWorker {
  readonly ready: Promise<void>;
  readonly outcome: Promise<RaceOutcome>;
}

function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function createMigration13Database(
  path: string,
  cipher: AesGcmContentCipher,
  passwordAuthEnabled: boolean
): void {
  const database = new Database(path);
  database.pragma("foreign_keys = ON");
  try {
    database.exec(`
      CREATE TABLE schema_migrations (
        id TEXT PRIMARY KEY,
        applied_at TEXT NOT NULL
      ) STRICT;
    `);
    for (const migration of migrations.slice(0, 13)) {
      database.transaction(() => {
        database.exec(migration.sql);
        database.prepare("INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)")
          .run(migration.id, CREATED_AT);
      }).immediate();
    }
    database.prepare(`
      INSERT INTO users (
        id, username, username_normalized, display_name, password_hash,
        password_auth_enabled, created_at, updated_at
      ) VALUES (?, 'manager', 'manager', 'Менеджер', ?, ?, ?, ?)
    `).run(
      ACCOUNT_ID,
      "$argon2id$v=19$m=65536,t=3,p=1$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      passwordAuthEnabled ? 1 : 0,
      CREATED_AT,
      CREATED_AT
    );
    database.prepare(`
      INSERT INTO device_sessions (
        id, user_id, device_name, created_at, last_seen_at, expires_at
      ) VALUES (?, ?, 'Основной iPhone', ?, ?, ?)
    `).run(PRIMARY_SESSION_ID, ACCOUNT_ID, CREATED_AT, CREATED_AT, EXPIRES_AT);
    database.prepare(`
      INSERT INTO refresh_tokens (
        id, session_id, token_hash, created_at, expires_at
      ) VALUES (?, ?, ?, ?, ?)
    `).run(randomUUID(), PRIMARY_SESSION_ID, digest("primary-refresh"), CREATED_AT, EXPIRES_AT);
    database.prepare(`
      INSERT INTO passkey_user_handles (
        reference, account_id, handle_digest, handle_ciphertext, created_at_ms
      ) VALUES (?, ?, ?, ?, ?)
    `).run(
      USER_HANDLE_REF,
      ACCOUNT_ID,
      digest(USER_HANDLE),
      cipher.encrypt(USER_HANDLE, `passkey-user-handle:${USER_HANDLE_REF}:${ACCOUNT_ID}`),
      NOW_MS
    );
  } finally {
    database.close();
  }
}

function openFixture(options: {
  readonly credentials?: 1 | 2;
  readonly passwordAuthEnabled?: boolean;
  readonly cleanupFailure?: boolean;
  readonly forcedAuthenticationCredentialId?: string | null;
} = {}): Fixture {
  const directory = mkdtempSync(join(tmpdir(), "luxora-authenticator-management-"));
  const path = join(directory, "management.sqlite");
  const cipher = new AesGcmContentCipher({ [DATA_KEY_ID]: DATA_KEY }, DATA_KEY_ID);
  createMigration13Database(path, cipher, options.passwordAuthEnabled ?? true);
  seedExistingPasskeyCredentialForTest({
    databasePath: path,
    cipher,
    accountId: ACCOUNT_ID,
    sessionId: PRIMARY_SESSION_ID,
    userHandleRef: USER_HANDLE_REF,
    credentialId: FIRST_CREDENTIAL_ID,
    recordId: FIRST_RECORD_ID,
    nowMs: NOW_MS,
    targetDigest: digest("fixture-add:first")
  });
  if (options.credentials === 2) {
    seedExistingPasskeyCredentialForTest({
      databasePath: path,
      cipher,
      accountId: ACCOUNT_ID,
      sessionId: PRIMARY_SESSION_ID,
      userHandleRef: USER_HANDLE_REF,
      credentialId: SECOND_CREDENTIAL_ID,
      recordId: SECOND_RECORD_ID,
      nowMs: NOW_MS,
      targetDigest: digest("fixture-add:second")
    });
  }
  const clock = { value: NOW_MS + 1_000 };
  const store = new SqliteStore(path, cipher, () => clock.value);
  const cleanupCalls: string[][] = [];
  const cleanupFailures: unknown[] = [];
  const stepUpTokens = new StepUpTokenSecurity(STEP_UP_SECRET, () => new Date(clock.value));
  const service = new PasskeyAuthenticatorManagementService({
    store,
    stepUpTokens,
    clock: () => new Date(clock.value),
    onSessionsRevoked: async (sessionIds) => {
      cleanupCalls.push([...sessionIds]);
      if (options.cleanupFailure === true) throw new Error("transport cleanup failed");
    },
    onSessionRevocationCleanupFailure: (error) => {
      cleanupFailures.push(error);
    }
  });
  const passkeyService = new PasskeyService(store, {
    adapter: new ManagementWebAuthnAdapter(
      store,
      options.forcedAuthenticationCredentialId ?? null
    ),
    nowMs: () => clock.value,
    stepUpTokens
  });
  const fixture = {
    directory,
    path,
    cipher,
    clock,
    store,
    service,
    passkeyService,
    stepUpTokens,
    principal: {
      userId: ACCOUNT_ID,
      sessionId: PRIMARY_SESSION_ID,
      tokenId: "55555555-5555-4555-8555-555555555555"
    },
    cleanupCalls,
    cleanupFailures
  } satisfies Fixture;
  fixtures.push(fixture);
  return fixture;
}

function startManagementWorker(
  fixture: Fixture,
  gate: SharedArrayBuffer,
  input: ManagementMutation
): RunningWorker {
  const worker = new Worker(
    new URL("./test-support/passkey-authenticator-management-race-worker.ts", import.meta.url),
    {
      execArgv: ["--import", "tsx"],
      workerData: {
        databasePath: fixture.path,
        encodedKey: DATA_KEY,
        keyId: DATA_KEY_ID,
        gate,
        input,
        nowMs: fixture.clock.value
      }
    }
  );
  workers.push(worker);
  let resolveReady: (() => void) | undefined;
  let rejectReady: ((error: Error) => void) | undefined;
  let resolveOutcome: ((outcome: RaceOutcome) => void) | undefined;
  let rejectOutcome: ((error: Error) => void) | undefined;
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  const outcome = new Promise<RaceOutcome>((resolve, reject) => {
    resolveOutcome = resolve;
    rejectOutcome = reject;
  });
  worker.on("message", (message: unknown) => {
    if (message === null || typeof message !== "object") return;
    const record = message as { type?: unknown; outcome?: unknown };
    if (record.type === "ready") resolveReady?.();
    if (record.type === "result") resolveOutcome?.(record.outcome as RaceOutcome);
  });
  worker.on("error", (error) => {
    rejectReady?.(error);
    rejectOutcome?.(error);
  });
  worker.on("exit", (code) => {
    if (code === 0) return;
    const error = new Error(`Authenticator management race worker exited with code ${code}`);
    rejectReady?.(error);
    rejectOutcome?.(error);
  });
  return { ready, outcome };
}

function renameMutation(
  fixture: Fixture,
  displayName: string,
  options: {
    readonly commandScope?: string;
    readonly expectedRevision?: number;
  } = {}
): PersistPasskeyAuthenticatorRename {
  const expectedRevision = options.expectedRevision ?? 1;
  const commandScope = options.commandScope
    ?? `passkey-authenticator:${ACCOUNT_ID}:${randomUUID()}`;
  return {
    operation: "rename",
    accountId: ACCOUNT_ID,
    sessionId: PRIMARY_SESSION_ID,
    credentialRecordId: FIRST_RECORD_ID,
    commandScope,
    fingerprint: passkeyAuthenticatorRenameFingerprint({
      accountId: ACCOUNT_ID,
      sessionId: PRIMARY_SESSION_ID,
      credentialRecordId: FIRST_RECORD_ID,
      expectedRevision,
      displayName
    }),
    expectedRevision,
    displayName,
    occurredAtMs: fixture.clock.value,
    eventId: randomUUID(),
    outboxId: randomUUID()
  };
}

async function raceMutations(
  fixture: Fixture,
  leftInput: ManagementMutation,
  rightInput: ManagementMutation
): Promise<readonly [RaceOutcome, RaceOutcome]> {
  const gate = new SharedArrayBuffer(4);
  const left = startManagementWorker(fixture, gate, leftInput);
  const right = startManagementWorker(fixture, gate, rightInput);
  await Promise.all([left.ready, right.ready]);
  const view = new Int32Array(gate);
  Atomics.store(view, 0, 1);
  Atomics.notify(view, 0, 2);
  return Promise.all([left.outcome, right.outcome]);
}

async function beginRevoke(
  fixture: Fixture,
  credentialRecordId: string,
  expectedRevision: number,
  options: { readonly commandId?: string; readonly clientNonce?: string } = {}
) {
  return fixture.passkeyService.beginAuthenticatorRevokeStepUp(
    fixture.principal,
    {
      commandId: options.commandId ?? randomUUID(),
      clientNonce: options.clientNonce ?? randomUUID(),
      credentialRecordId,
      expectedRevision
    }
  );
}

function revokeAssertionResponse() {
  return parsePasskeyResponseBody(Buffer.from(JSON.stringify({
    fixture: "authenticator.revoke"
  }), "utf8"));
}

async function verifyRevoke(
  fixture: Fixture,
  ceremonyId: string,
  expectedRevision: number,
  options: {
    readonly commandId?: string;
    readonly principal?: AuthenticatedPrincipal;
  } = {}
) {
  fixture.clock.value += 1_000;
  return fixture.passkeyService.verify(options.principal ?? fixture.principal, {
    ceremonyId,
    commandId: options.commandId ?? randomUUID(),
    expectedRevision,
    response: revokeAssertionResponse()
  });
}

async function authorizeRevoke(
  fixture: Fixture,
  credentialRecordId: string,
  expectedRevision: number
) {
  const begun = await beginRevoke(fixture, credentialRecordId, expectedRevision);
  const verified = await verifyRevoke(
    fixture,
    begun.ceremony.id,
    begun.ceremony.revision
  );
  if (
    !("stepUpAuthorization" in verified)
    || verified.stepUpAuthorization.purpose !== "authenticator.revoke"
  ) throw new Error("revoke authorization missing from WebAuthn verification");
  return {
    authenticationCeremonyId: begun.ceremony.id,
    authorization: verified.stepUpAuthorization
  };
}

async function revokeMutation(
  fixture: Fixture,
  credentialRecordId: string,
  expectedRevision = 1,
  commandScope = `passkey-authenticator:${ACCOUNT_ID}:${randomUUID()}`
): Promise<PersistPasskeyAuthenticatorRevoke> {
  const { authenticationCeremonyId, authorization } = await authorizeRevoke(
    fixture,
    credentialRecordId,
    expectedRevision
  );
  const targetDigest = passkeyAuthenticatorRevokeTargetDigest({
    accountId: ACCOUNT_ID,
    sessionId: PRIMARY_SESSION_ID,
    credentialRecordId,
    expectedRevision
  });
  const verified = await fixture.stepUpTokens.verify(authorization.token, {
    accountId: ACCOUNT_ID,
    sessionId: PRIMARY_SESSION_ID,
    ceremonyId: authenticationCeremonyId,
    purpose: "authenticator.revoke",
    targetDigest
  });
  return {
    operation: "revoke",
    accountId: ACCOUNT_ID,
    sessionId: PRIMARY_SESSION_ID,
    credentialRecordId,
    commandScope,
    fingerprint: passkeyAuthenticatorRevokeFingerprint({
      accountId: ACCOUNT_ID,
      sessionId: PRIMARY_SESSION_ID,
      credentialRecordId,
      expectedRevision,
      authenticationCeremonyId
    }),
    expectedRevision,
    occurredAtMs: fixture.clock.value,
    eventId: randomUUID(),
    outboxId: randomUUID(),
    authorization: {
      sub: verified.sub,
      sid: verified.sid,
      ceremony_id: verified.ceremony_id,
      jti: verified.jti,
      purpose: "authenticator.revoke",
      target_digest: verified.target_digest,
      auth_time: verified.auth_time,
      iat: verified.iat,
      exp: verified.exp
    }
  };
}

afterEach(async () => {
  await Promise.allSettled(workers.splice(0).map(async (worker) => worker.terminate()));
  for (const fixture of fixtures.splice(0)) {
    try { fixture.store.close(); } catch { /* already closed */ }
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

describe("durable passkey authenticator management", () => {
  it("requires an observable failure path for live session cleanup", () => {
    const fixture = openFixture();
    expect(() => new PasskeyAuthenticatorManagementService({
      store: fixture.store,
      stepUpTokens: fixture.stepUpTokens,
      clock: () => new Date(fixture.clock.value),
      onSessionsRevoked: async () => undefined
    })).toThrow("requires an explicit failure reporter");
  });

  it("upgrades a migration-013 credential into encrypted metadata without disabling it", async () => {
    const fixture = openFixture();
    expect(await fixture.store.findPasskeyCredentialById(FIRST_CREDENTIAL_ID)).not.toBeNull();
    const listed = await fixture.service.list(fixture.principal);
    expect(listed.authenticators).toEqual([
      expect.objectContaining({
        id: FIRST_RECORD_ID,
        displayName: "Ключ доступа",
        state: "active",
        revision: 1
      })
    ]);
    expect(JSON.stringify(listed)).not.toMatch(/credentialId|publicKey|userHandle|signCount/u);

    const database = new Database(fixture.path, { readonly: true });
    const metadata = database.prepare(`
      SELECT display_name_ciphertext FROM passkey_authenticator_metadata
      WHERE credential_record_id = ?
    `).get(FIRST_RECORD_ID) as { display_name_ciphertext: string };
    expect(metadata.display_name_ciphertext).toMatch(/^luxora:v1\./u);
    expect(metadata.display_name_ciphertext).not.toContain("Ключ доступа");
    expect(database.prepare(`
      SELECT id FROM schema_migrations ORDER BY id DESC LIMIT 1
    `).get()).toEqual({ id: "040_device_link_challenges" });
    database.close();

    const { authenticationCeremonyId, authorization } = await authorizeRevoke(
      fixture,
      FIRST_RECORD_ID,
      1
    );
    expect(await fixture.service.issueRevokeAuthorization(fixture.principal, {
      authenticationCeremonyId,
      credentialRecordId: FIRST_RECORD_ID,
      expectedRevision: 1
    })).toEqual(authorization);
    const revoked = await fixture.service.revoke(fixture.principal, {
      authenticationCeremonyId,
      commandId: randomUUID(),
      credentialRecordId: FIRST_RECORD_ID,
      expectedRevision: 1,
      stepUpToken: authorization.token
    });
    expect(revoked.authenticator).toMatchObject({ state: "revoked", revision: 2 });
    expect(await fixture.store.findPasskeyCredentialById(FIRST_CREDENTIAL_ID)).toBeNull();
    expect(await fixture.store.findPasskeyCredentialByRecordId(FIRST_RECORD_ID)).toBeNull();
    await expect(fixture.service.issueRevokeAuthorization(fixture.principal, {
      authenticationCeremonyId,
      credentialRecordId: FIRST_RECORD_ID,
      expectedRevision: 1
    })).rejects.toMatchObject({ statusCode: 403, code: "FORBIDDEN" });
    expect((await fixture.service.list(fixture.principal)).authenticators).toEqual([]);
  });

  it("does not reissue an expired unconsumed revoke grant", async () => {
    const fixture = openFixture();
    const { authenticationCeremonyId, authorization } = await authorizeRevoke(
      fixture,
      FIRST_RECORD_ID,
      1
    );
    fixture.clock.value = Date.parse(authorization.expiresAt);
    await expect(fixture.service.issueRevokeAuthorization(fixture.principal, {
      authenticationCeremonyId,
      credentialRecordId: FIRST_RECORD_ID,
      expectedRevision: 1
    })).rejects.toMatchObject({ statusCode: 403, code: "FORBIDDEN" });
  });

  it("replays the exact target-bound begin and verification after process restarts", async () => {
    const fixture = openFixture({ credentials: 2 });
    const beginCommandId = randomUUID();
    const clientNonce = randomUUID();
    const begun = await beginRevoke(fixture, FIRST_RECORD_ID, 1, {
      commandId: beginCommandId,
      clientNonce
    });
    expect(begun).toMatchObject({
      replayed: false,
      operation: "authenticator.revoke",
      targetBinding: {
        accountId: ACCOUNT_ID,
        sessionId: PRIMARY_SESSION_ID,
        credentialRecordId: FIRST_RECORD_ID,
        expectedRevision: 1
      }
    });
    expect(await beginRevoke(fixture, FIRST_RECORD_ID, 1, {
      commandId: beginCommandId,
      clientNonce
    })).toEqual({ ...begun, replayed: true });
    await expect(beginRevoke(fixture, SECOND_RECORD_ID, 1, {
      commandId: beginCommandId,
      clientNonce
    })).rejects.toMatchObject({ statusCode: 409, code: "CONFLICT" });
    await expect(beginRevoke(fixture, FIRST_RECORD_ID, 1, {
      commandId: beginCommandId,
      clientNonce: randomUUID()
    })).rejects.toMatchObject({ statusCode: 409, code: "CONFLICT" });

    fixture.store.close();
    fixture.store = new SqliteStore(fixture.path, fixture.cipher, () => fixture.clock.value);
    const restarted = new PasskeyService(fixture.store, {
      adapter: new ManagementWebAuthnAdapter(fixture.store),
      nowMs: () => fixture.clock.value,
      stepUpTokens: fixture.stepUpTokens
    });
    expect(await restarted.beginAuthenticatorRevokeStepUp(fixture.principal, {
      commandId: beginCommandId,
      clientNonce,
      credentialRecordId: FIRST_RECORD_ID,
      expectedRevision: 1
    })).toEqual({ ...begun, replayed: true });

    fixture.clock.value += 1_000;
    const verifyCommandId = randomUUID();
    const verificationInput = {
      ceremonyId: begun.ceremony.id,
      commandId: verifyCommandId,
      expectedRevision: begun.ceremony.revision,
      response: revokeAssertionResponse()
    };
    const verified = await restarted.verify(fixture.principal, verificationInput);
    expect(verified).toMatchObject({
      replayed: false,
      verified: true,
      stepUpAuthorization: { purpose: "authenticator.revoke" }
    });

    fixture.store.close();
    fixture.store = new SqliteStore(fixture.path, fixture.cipher, () => fixture.clock.value);
    const responseRecovery = new PasskeyService(fixture.store, {
      adapter: new ManagementWebAuthnAdapter(fixture.store),
      nowMs: () => fixture.clock.value,
      stepUpTokens: fixture.stepUpTokens
    });
    expect(await responseRecovery.verify(fixture.principal, verificationInput))
      .toEqual({ ...verified, replayed: true });
  });

  it("keeps the durable revoke intent immutable until its ceremony is removed", async () => {
    const fixture = openFixture({ credentials: 2 });
    const begun = await beginRevoke(fixture, FIRST_RECORD_ID, 1);
    const database = new Database(fixture.path);
    database.pragma("foreign_keys = ON");
    expect(() => database.prepare(`
      UPDATE passkey_authenticator_revoke_intents
      SET target_digest = ?
      WHERE authentication_ceremony_id = ?
    `).run("b".repeat(64), begun.ceremony.id)).toThrow("intent is immutable");
    expect(() => database.prepare(`
      DELETE FROM passkey_authenticator_revoke_intents
      WHERE authentication_ceremony_id = ?
    `).run(begun.ceremony.id)).toThrow("intent cannot be deleted");
    expect(database.prepare(`
      SELECT credential_record_id, expected_authenticator_revision
      FROM passkey_authenticator_revoke_intents
      WHERE authentication_ceremony_id = ?
    `).get(begun.ceremony.id)).toEqual({
      credential_record_id: FIRST_RECORD_ID,
      expected_authenticator_revision: 1
    });
    database.close();
  });

  it("rolls back verification when the target revision or authorizing session changes", async () => {
    const revisionFixture = openFixture({ credentials: 2 });
    const revisionBegin = await beginRevoke(revisionFixture, FIRST_RECORD_ID, 1);
    await revisionFixture.service.rename(revisionFixture.principal, {
      commandId: randomUUID(),
      credentialRecordId: FIRST_RECORD_ID,
      displayName: "Ключ с новой ревизией",
      expectedRevision: 1
    });
    await expect(verifyRevoke(
      revisionFixture,
      revisionBegin.ceremony.id,
      revisionBegin.ceremony.revision
    )).rejects.toMatchObject({ statusCode: 409, code: "CONFLICT" });
    expect(await revisionFixture.store.loadCeremony(revisionBegin.ceremony.id)).toMatchObject({
      state: "pending",
      revision: 1
    });
    expect(await revisionFixture.store.findPasskeyAuthenticatorStepUpGrant(
      revisionBegin.ceremony.id
    )).toBeNull();

    const sessionFixture = openFixture({ credentials: 2 });
    const sessionBegin = await beginRevoke(sessionFixture, FIRST_RECORD_ID, 1);
    sessionFixture.store.revokeSession(
      PRIMARY_SESSION_ID,
      new Date(sessionFixture.clock.value).toISOString()
    );
    await expect(verifyRevoke(
      sessionFixture,
      sessionBegin.ceremony.id,
      sessionBegin.ceremony.revision
    )).rejects.toMatchObject({ statusCode: 409, code: "CONFLICT" });
    expect(await sessionFixture.store.loadCeremony(sessionBegin.ceremony.id)).toMatchObject({
      state: "pending",
      revision: 1
    });
    expect(await sessionFixture.store.findPasskeyAuthenticatorStepUpGrant(
      sessionBegin.ceremony.id
    )).toBeNull();
  });

  it("lets an independent active key authorize the target and rejects the revoked key later", async () => {
    const fixture = openFixture({
      credentials: 2,
      forcedAuthenticationCredentialId: SECOND_CREDENTIAL_ID
    });
    const grant = await authorizeRevoke(fixture, FIRST_RECORD_ID, 1);
    await fixture.service.revoke(fixture.principal, {
      authenticationCeremonyId: grant.authenticationCeremonyId,
      commandId: randomUUID(),
      credentialRecordId: FIRST_RECORD_ID,
      expectedRevision: 1,
      stepUpToken: grant.authorization.token
    });
    expect(await fixture.store.findPasskeyCredentialById(FIRST_CREDENTIAL_ID)).toBeNull();
    expect(await fixture.store.findPasskeyCredentialById(SECOND_CREDENTIAL_ID)).not.toBeNull();

    const revokedCredentialVerifier = new PasskeyService(fixture.store, {
      adapter: new ManagementWebAuthnAdapter(fixture.store, FIRST_CREDENTIAL_ID),
      nowMs: () => fixture.clock.value,
      stepUpTokens: fixture.stepUpTokens
    });
    const stepUp = await revokedCredentialVerifier.beginStepUp(fixture.principal, {
      commandId: randomUUID(),
      clientNonce: randomUUID(),
      operation: "authenticator.add"
    });
    fixture.clock.value += 1_000;
    await expect(revokedCredentialVerifier.verify(fixture.principal, {
      ceremonyId: stepUp.ceremony.id,
      commandId: randomUUID(),
      expectedRevision: stepUp.ceremony.revision,
      response: revokeAssertionResponse()
    })).rejects.toMatchObject({ statusCode: 401, code: "UNAUTHENTICATED" });
    expect(await fixture.store.findPasskeyStepUpGrant(stepUp.ceremony.id)).toBeNull();
  });

  it("expires the target-bound ceremony exactly at its server deadline", async () => {
    const fixture = openFixture();
    const begun = await beginRevoke(fixture, FIRST_RECORD_ID, 1);
    fixture.clock.value = Date.parse(begun.ceremony.expiresAt);
    await expect(fixture.passkeyService.verify(fixture.principal, {
      ceremonyId: begun.ceremony.id,
      commandId: randomUUID(),
      expectedRevision: begun.ceremony.revision,
      response: revokeAssertionResponse()
    })).rejects.toMatchObject({ statusCode: 401, code: "UNAUTHENTICATED" });
    expect(await fixture.store.findPasskeyAuthenticatorStepUpGrant(begun.ceremony.id)).toBeNull();
  });

  it("renames with Russian metadata, exact replay and secret-free append-only evidence", async () => {
    const fixture = openFixture();
    const commandId = randomUUID();
    const input = {
      commandId,
      credentialRecordId: FIRST_RECORD_ID,
      displayName: "  Ключ от iPhone Егора  ",
      expectedRevision: 1
    };
    const renamed = await fixture.service.rename(fixture.principal, input);
    expect(renamed).toMatchObject({
      replayed: false,
      authenticator: {
        id: FIRST_RECORD_ID,
        displayName: "Ключ от iPhone Егора",
        state: "active",
        revision: 2
      }
    });
    expect(renamed.authenticator.etag)
      .toBe(`"passkey-authenticator:${FIRST_RECORD_ID}:rev:2"`);
    expect(await fixture.service.rename(fixture.principal, input)).toMatchObject({
      replayed: true,
      authenticator: renamed.authenticator
    });
    await expect(fixture.service.rename(fixture.principal, {
      ...input,
      displayName: "Другой ключ"
    })).rejects.toMatchObject({ statusCode: 409, code: "CONFLICT" });

    const database = new Database(fixture.path);
    database.pragma("foreign_keys = ON");
    const event = database.prepare(`
      SELECT * FROM passkey_authenticator_events
      WHERE credential_record_id = ? AND revision = 2
    `).get(FIRST_RECORD_ID) as Record<string, unknown>;
    const outbox = database.prepare(`
      SELECT * FROM passkey_authenticator_outbox WHERE event_id = ?
    `).get(event["event_id"]) as Record<string, unknown>;
    const receipt = database.prepare(`
      SELECT * FROM passkey_authenticator_command_receipts WHERE event_id = ?
    `).get(event["event_id"]) as Record<string, unknown>;
    for (const durable of [event, outbox, receipt]) {
      const serialized = JSON.stringify(durable);
      expect(serialized).not.toContain("Ключ от iPhone Егора");
      expect(serialized).not.toMatch(/credentialId|publicKey|userHandle|signCount/u);
    }
    expect(() => database.prepare(`
      UPDATE passkey_authenticator_events SET occurred_at_ms = occurred_at_ms + 1
      WHERE event_id = ?
    `).run(event["event_id"])).toThrow("append-only");
    const futureEventId = randomUUID();
    const futureScope = `passkey-authenticator:${ACCOUNT_ID}:${randomUUID()}`;
    const futureFingerprint = digest("future-authenticator-mutation");
    const futureOccurredAtMs = fixture.clock.value + 1;
    const futureEvent = JSON.stringify({
      schemaVersion: 1,
      eventId: futureEventId,
      type: "passkey.authenticator.renamed",
      accountId: ACCOUNT_ID,
      authenticatorId: FIRST_RECORD_ID,
      revision: 3,
      lifecycleState: "active",
      occurredAtMs: futureOccurredAtMs
    });
    const insertFutureEvent = database.prepare(`
      INSERT INTO passkey_authenticator_events (
        event_id, credential_record_id, account_id, revision, event_type,
        command_scope, fingerprint, occurred_at_ms, event_json
      ) VALUES (?, ?, ?, 3, 'passkey.authenticator.renamed', ?, ?, ?, ?)
    `);
    database.exec("BEGIN IMMEDIATE");
    try {
      expect(() => insertFutureEvent.run(
        futureEventId,
        FIRST_RECORD_ID,
        ACCOUNT_ID,
        futureScope,
        futureFingerprint,
        futureOccurredAtMs,
        JSON.stringify({ ...JSON.parse(futureEvent), credentialId: "secret-canary" })
      )).toThrow("event binding is inconsistent");
      insertFutureEvent.run(
        futureEventId,
        FIRST_RECORD_ID,
        ACCOUNT_ID,
        futureScope,
        futureFingerprint,
        futureOccurredAtMs,
        futureEvent
      );
      expect(() => database.prepare(`
        INSERT INTO passkey_authenticator_outbox (
          outbox_id, event_id, topic, partition_key, available_at_ms, payload_json
        ) VALUES (?, ?, 'luxora.passkey-authenticator.v1', ?, ?, ?)
      `).run(
        randomUUID(),
        futureEventId,
        "99999999-9999-4999-8999-999999999999",
        futureOccurredAtMs,
        futureEvent
      )).toThrow("outbox binding is inconsistent");
      expect(() => database.prepare(`
        INSERT INTO passkey_authenticator_command_receipts (
          scope, fingerprint, credential_record_id, account_id, result_revision,
          event_id, result_snapshot_ciphertext, created_at_ms
        ) VALUES (?, ?, ?, ?, 3, ?, ?, ?)
      `).run(
        futureScope,
        digest("wrong-fingerprint"),
        FIRST_RECORD_ID,
        ACCOUNT_ID,
        futureEventId,
        fixture.cipher.encrypt(JSON.stringify(renamed.authenticator), `test:${futureScope}`),
        futureOccurredAtMs
      )).toThrow("receipt binding is inconsistent");
    } finally {
      if (database.inTransaction) database.exec("ROLLBACK");
    }
    expect(() => database.prepare(`
      UPDATE passkey_authenticator_metadata SET revision = revision + 1
      WHERE credential_record_id = ?
    `).run(FIRST_RECORD_ID)).toThrow("requires an audit event");
    database.close();

    fixture.store.close();
    fixture.store = new SqliteStore(fixture.path, fixture.cipher, () => fixture.clock.value);
    fixture.service = new PasskeyAuthenticatorManagementService({
      store: fixture.store,
      stepUpTokens: fixture.stepUpTokens,
      clock: () => new Date(fixture.clock.value)
    });
    expect((await fixture.service.list(fixture.principal)).authenticators).toEqual([
      renamed.authenticator
    ]);
  });

  it("revokes attributed sessions, reports cleanup failure, replays exactly and preserves the last key", async () => {
    const fixture = openFixture({
      credentials: 2,
      passwordAuthEnabled: false,
      cleanupFailure: true
    });
    const attributedSessionId = "66666666-6666-4666-8666-666666666666";
    fixture.store.createSession({
      id: attributedSessionId,
      userId: ACCOUNT_ID,
      deviceName: "Сессия первого ключа",
      createdAt: CREATED_AT,
      expiresAt: EXPIRES_AT
    }, {
      id: randomUUID(),
      sessionId: attributedSessionId,
      tokenHash: digest("attributed-refresh"),
      createdAt: CREATED_AT,
      expiresAt: EXPIRES_AT
    });
    const database = new Database(fixture.path);
    database.pragma("foreign_keys = ON");
    database.prepare(`
      INSERT INTO passkey_session_credential_origins (
        session_id, account_id, credential_record_id, created_at_ms
      ) VALUES (?, ?, ?, ?)
    `).run(attributedSessionId, ACCOUNT_ID, FIRST_RECORD_ID, NOW_MS);
    database.close();

    const grant = await authorizeRevoke(fixture, FIRST_RECORD_ID, 1);
    const commandId = randomUUID();
    const input = {
      authenticationCeremonyId: grant.authenticationCeremonyId,
      commandId,
      credentialRecordId: FIRST_RECORD_ID,
      expectedRevision: 1,
      stepUpToken: grant.authorization.token
    };
    await expect(fixture.service.revoke(fixture.principal, {
      ...input,
      commandId: randomUUID(),
      credentialRecordId: SECOND_RECORD_ID
    })).rejects.toMatchObject({ statusCode: 403, code: "FORBIDDEN" });
    expect(await fixture.store.findPasskeyCredentialById(FIRST_CREDENTIAL_ID)).not.toBeNull();
    const revoked = await fixture.service.revoke(fixture.principal, input);
    expect(revoked).toMatchObject({ replayed: false, authenticator: { state: "revoked" } });
    expect(fixture.store.isSessionActive(
      attributedSessionId,
      ACCOUNT_ID,
      new Date(fixture.clock.value).toISOString()
    )).toBe(false);
    const revokeInspection = new Database(fixture.path, { readonly: true });
    expect(revokeInspection.prepare(`
      SELECT used_at FROM refresh_tokens WHERE session_id = ?
    `).get(attributedSessionId)).toEqual({
      used_at: new Date(fixture.clock.value).toISOString()
    });
    expect(revokeInspection.prepare(`
      SELECT consumed_at_sec, management_command_scope
      FROM passkey_authenticator_step_up_grants
      WHERE authentication_ceremony_id = ?
    `).get(grant.authenticationCeremonyId)).toEqual({
      consumed_at_sec: Math.floor(fixture.clock.value / 1_000),
      management_command_scope: `passkey-authenticator:${ACCOUNT_ID}:${commandId}`
    });
    revokeInspection.close();
    expect(fixture.cleanupCalls).toEqual([[attributedSessionId]]);
    expect(fixture.cleanupFailures).toHaveLength(1);
    expect(await fixture.service.revoke(fixture.principal, input)).toMatchObject({
      replayed: true,
      authenticator: revoked.authenticator
    });
    const segments = input.stepUpToken.split(".") as [string, string, string];
    const alteredToken = `${segments[0]}.${segments[1]}.${segments[2].startsWith("A") ? "B" : "A"}${segments[2].slice(1)}`;
    await expect(fixture.service.revoke(fixture.principal, {
      ...input,
      stepUpToken: alteredToken
    })).rejects.toMatchObject({ statusCode: 403, code: "FORBIDDEN" });
    expect((await fixture.service.list(fixture.principal)).authenticators.map(({ id }) => id))
      .toEqual([SECOND_RECORD_ID]);

    const lastGrant = await authorizeRevoke(fixture, SECOND_RECORD_ID, 1);
    await expect(fixture.service.revoke(fixture.principal, {
      authenticationCeremonyId: lastGrant.authenticationCeremonyId,
      commandId: randomUUID(),
      credentialRecordId: SECOND_RECORD_ID,
      expectedRevision: 1,
      stepUpToken: lastGrant.authorization.token
    })).rejects.toMatchObject({ statusCode: 409, code: "CONFLICT" });
    expect(await fixture.store.findPasskeyCredentialById(SECOND_CREDENTIAL_ID)).not.toBeNull();

    fixture.store.revokeSession(PRIMARY_SESSION_ID, new Date(fixture.clock.value).toISOString());
    await expect(fixture.service.list(fixture.principal))
      .rejects.toMatchObject({ statusCode: 403, code: "FORBIDDEN" });
  });

  it("serializes independent rename writers and replays only an exact shared command", async () => {
    const exactFixture = openFixture();
    const exactScope = `passkey-authenticator:${ACCOUNT_ID}:${randomUUID()}`;
    const exactLeft = renameMutation(exactFixture, "Точный общий ключ", {
      commandScope: exactScope
    });
    const exactRight = renameMutation(exactFixture, "Точный общий ключ", {
      commandScope: exactScope
    });
    const exactOutcomes = await raceMutations(exactFixture, exactLeft, exactRight);
    expect(exactOutcomes).toEqual(expect.arrayContaining([
      expect.objectContaining({ ok: true, replayed: false, revision: 2 }),
      expect.objectContaining({ ok: true, replayed: true, revision: 2 })
    ]));
    expect((await exactFixture.store.findPasskeyAuthenticatorCommandReceipt(exactScope))?.result)
      .toMatchObject({ displayName: "Точный общий ключ", revision: 2 });

    const differentFixture = openFixture();
    const differentOutcomes = await raceMutations(
      differentFixture,
      renameMutation(differentFixture, "Первый независимый ключ"),
      renameMutation(differentFixture, "Второй независимый ключ")
    );
    expect(differentOutcomes.filter(({ ok }) => ok)).toHaveLength(1);
    expect(differentOutcomes.filter(({ name }) => name === "StoreCredentialStateConflictError"))
      .toHaveLength(1);
    expect((await differentFixture.store.listPasskeyAuthenticatorsByAccountId(ACCOUNT_ID))[0])
      .toMatchObject({ revision: 2, lifecycleState: "active" });

    const reusedFixture = openFixture();
    const reusedScope = `passkey-authenticator:${ACCOUNT_ID}:${randomUUID()}`;
    const reusedOutcomes = await raceMutations(
      reusedFixture,
      renameMutation(reusedFixture, "Левая команда", { commandScope: reusedScope }),
      renameMutation(reusedFixture, "Правая команда", { commandScope: reusedScope })
    );
    expect(reusedOutcomes.filter(({ ok }) => ok)).toHaveLength(1);
    expect(reusedOutcomes.filter(({ name }) => name === "StoreDuplicateCommandError"))
      .toHaveLength(1);
  });

  it("serializes revoke writers for one target and preserves one recovery key across targets", async () => {
    const sameTargetFixture = openFixture();
    const sameTargetLeft = await revokeMutation(sameTargetFixture, FIRST_RECORD_ID);
    const sameTargetRight = await revokeMutation(sameTargetFixture, FIRST_RECORD_ID);
    const sameTargetOutcomes = await raceMutations(
      sameTargetFixture,
      sameTargetLeft,
      sameTargetRight
    );
    expect(sameTargetOutcomes.filter(({ ok }) => ok)).toHaveLength(1);
    expect(sameTargetOutcomes.filter(
      ({ name }) => name === "StoreCredentialStateConflictError"
    )).toHaveLength(1);
    expect(await sameTargetFixture.store.findPasskeyCredentialById(FIRST_CREDENTIAL_ID))
      .toBeNull();

    const lastTwoFixture = openFixture({ credentials: 2, passwordAuthEnabled: false });
    const firstTarget = await revokeMutation(lastTwoFixture, FIRST_RECORD_ID);
    const secondTarget = await revokeMutation(lastTwoFixture, SECOND_RECORD_ID);
    const lastTwoOutcomes = await raceMutations(lastTwoFixture, firstTarget, secondTarget);
    expect(lastTwoOutcomes.filter(({ ok }) => ok)).toHaveLength(1);
    expect(lastTwoOutcomes.filter(
      ({ name }) => name === "StoreCredentialStateConflictError"
    )).toHaveLength(1);
    const survivors = await lastTwoFixture.store.listPasskeyAuthenticatorsByAccountId(ACCOUNT_ID);
    expect(survivors).toHaveLength(1);
    expect(survivors[0]).toMatchObject({ lifecycleState: "active", revision: 1 });
    const database = new Database(lastTwoFixture.path, { readonly: true });
    expect(database.prepare(`
      SELECT COUNT(*) AS count FROM passkey_authenticator_events
      WHERE event_type = 'passkey.authenticator.revoked'
    `).get()).toEqual({ count: 1 });
    database.close();
  });
});
