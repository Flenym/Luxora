import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
  AuthenticationVerificationExpectations,
  MaintainedWebAuthnVerifierAdapter,
  RegistrationVerificationExpectations
} from "@luxora/passkey-domain";
import type { AuthenticatorTransportFuture } from "@simplewebauthn/server";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import type { AuthenticatedPrincipal } from "../domain/types.js";
import { AppError } from "../errors.js";
import { parsePasskeyResponseBody, type ParsedPasskeyResponseBody } from "../http/passkey-response-body.js";
import { AesGcmContentCipher } from "../infrastructure/content-cipher.js";
import { SqliteStore } from "../infrastructure/sqlite-store.js";
import type {
  AuthenticationOptionsInput,
  RegistrationOptionsInput,
  SimpleWebAuthnVerifierAdapter
} from "../passkeys/simplewebauthn-adapter.js";
import { StepUpTokenSecurity } from "../passkeys/step-up-token.js";
import { seedExistingPasskeyCredentialForTest } from "../test-support/passkey-service-fixture.js";
import { PasskeyService } from "./passkey-service.js";

const ACCOUNT_ID = "632be030-bd16-465f-a568-99e26ef7bb3f";
const OTHER_ACCOUNT_ID = "7149e8fe-e242-4d9f-bf7e-e6a9fa44e704";
const SESSION_ID = "bb391de6-e4ca-4f40-a507-818d47f69841";
const OTHER_SESSION_ID = "271f17d0-03cd-4cb5-a8e9-f22f2061082a";
const TOKEN_ID = "d934ce25-f31c-4197-b065-03758a8b8927";
const START_MS = Date.parse("2026-08-04T00:00:00.000Z");
const TOKEN_SECRET = "passkey-service-step-up-token-test-secret-at-least-32-bytes";
const EXISTING_CREDENTIAL_ID = Buffer.from("existing-passkey-service-credential", "utf8").toString("base64url");
const NEW_CREDENTIAL_ID = Buffer.from("new-passkey-service-credential", "utf8").toString("base64url");
const EXISTING_RECORD_ID = "a8389020-b223-4720-8af7-042000573515";

interface MutableClock {
  value: number;
}

interface Harness {
  readonly directory: string;
  readonly databasePath: string;
  readonly cipher: AesGcmContentCipher;
  readonly clock: MutableClock;
  readonly principal: AuthenticatedPrincipal;
  tokens: StepUpTokenSecurity;
  store: SqliteStore;
  service: PasskeyService;
}

interface PasskeyCounts {
  readonly ceremonies: number;
  readonly registrationCeremonies: number;
  readonly grants: number;
  readonly credentials: number;
  readonly handles: number;
  readonly commands: number;
  readonly creations: number;
  readonly challenges: number;
}

interface CompletedStepUp {
  readonly ceremonyId: string;
  readonly verifyCommandId: string;
  readonly verifyResponse: ParsedPasskeyResponseBody;
  readonly token: string;
  readonly targetDigest: string;
  readonly expiresAt: string;
}

const directories: string[] = [];
const stores: SqliteStore[] = [];

afterEach(() => {
  for (const store of stores.splice(0)) {
    try {
      store.close();
    } catch {
      // A restart test may already have closed this connection.
    }
  }
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function canonicalTargetDigest(accountId = ACCOUNT_ID, sessionId = SESSION_ID): string {
  const value = { accountId, operation: "authenticator.add", sessionId };
  const canonical = Object.keys(value).sort()
    .map((key) => `${JSON.stringify(key)}:${JSON.stringify(value[key as keyof typeof value])}`)
    .join(",");
  return createHash("sha256").update(`{${canonical}}`, "utf8").digest("hex");
}

function response(label: "authentication" | "registration"): ParsedPasskeyResponseBody {
  return parsePasskeyResponseBody(Buffer.from(JSON.stringify({ fixture: label }), "utf8"));
}

function trackStore(store: SqliteStore): SqliteStore {
  stores.push(store);
  return store;
}

function closeTrackedStore(store: SqliteStore): void {
  const index = stores.indexOf(store);
  if (index >= 0) stores.splice(index, 1);
  store.close();
}

function openEncryptedStore(
  databasePath: string,
  cipher: AesGcmContentCipher,
  clock: MutableClock
): SqliteStore {
  return trackStore(new SqliteStore(databasePath, cipher, () => clock.value));
}

function inspectCounts(databasePath: string): PasskeyCounts {
  const database = new Database(databasePath, { readonly: true });
  try {
    const count = (table: string, where = ""): number => {
      const row = database.prepare(`SELECT COUNT(*) AS count FROM ${table} ${where}`).get() as { count: number };
      return row.count;
    };
    return {
      ceremonies: count("passkey_ceremonies"),
      registrationCeremonies: count("passkey_ceremonies", "WHERE kind = 'registration'"),
      grants: count("passkey_step_up_grants"),
      credentials: count("passkey_credentials"),
      handles: count("passkey_user_handles"),
      commands: count("passkey_command_receipts"),
      creations: count("passkey_creation_receipts"),
      challenges: count("passkey_challenge_secrets")
    };
  } finally {
    database.close();
  }
}

function expectTokenAbsentFromDatabaseFiles(databasePath: string, token: string): void {
  const tokenBytes = Buffer.from(token, "utf8");
  for (const candidate of [databasePath, `${databasePath}-wal`, `${databasePath}-shm`]) {
    if (existsSync(candidate)) expect(readFileSync(candidate).includes(tokenBytes)).toBe(false);
  }
}

async function expectStepUpRequired(
  operation: Promise<unknown>,
  rawToken?: string
): Promise<AppError> {
  let thrown: unknown;
  try {
    await operation;
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(AppError);
  expect(thrown).toMatchObject({
    statusCode: 403,
    code: "FORBIDDEN",
    details: { reason: "step_up_required" }
  });
  if (rawToken !== undefined) {
    expect(String(thrown)).not.toContain(rawToken);
    expect(JSON.stringify(thrown)).not.toContain(rawToken);
  }
  return thrown as AppError;
}

/**
 * Service seam only: domain orchestration and encrypted persistence are real;
 * WebAuthn cryptography remains covered by the maintained-adapter suite.
 */
class ServiceSeamFakeWebAuthnAdapter implements MaintainedWebAuthnVerifierAdapter {
  readonly implementation = Object.freeze({
    kind: "maintained-webauthn-server-library" as const,
    libraryName: "@simplewebauthn/server",
    libraryVersion: "13.3.2",
    reviewReference: "service-seam-fake-not-cryptography"
  });

  constructor(private readonly store: SqliteStore) {}

  async createRegistrationOptions(
    input: RegistrationOptionsInput
  ): ReturnType<SimpleWebAuthnVerifierAdapter["createRegistrationOptions"]> {
    const handle = await this.store.findPasskeyUserHandleByRef(input.expectedUserHandleRef);
    if (handle === null) throw new Error("service test fixture handle is missing");
    const credentials = await this.store.listPasskeyCredentialsByAccountId(input.expectedAccountId);
    return {
      challenge: input.expectedChallenge,
      rp: { id: input.expectedRpId, name: input.rpName },
      user: {
        id: handle.userHandle,
        name: input.userName,
        displayName: input.userDisplayName
      },
      pubKeyCredParams: input.allowedAlgorithms.map((alg) => ({ type: "public-key" as const, alg })),
      timeout: input.timeoutMs,
      excludeCredentials: credentials.map((credential) => ({
        id: credential.credentialId,
        type: "public-key" as const,
        transports: [...credential.transports] as AuthenticatorTransportFuture[]
      })),
      attestation: "none" as const,
      authenticatorSelection: {
        residentKey: "required" as const,
        requireResidentKey: true,
        userVerification: "required" as const
      }
    };
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

  async verifyRegistration(_response: unknown, expectations: RegistrationVerificationExpectations) {
    return {
      status: "verified" as const,
      kind: "registration" as const,
      credential: {
        credentialId: NEW_CREDENTIAL_ID,
        publicKey: new Uint8Array([0xa5, 0x11, 0x22, 0x33]),
        algorithm: -7 as const,
        accountId: expectations.expectedAccountId,
        userHandleRef: expectations.expectedUserHandleRef,
        discoveryMode: "discoverable" as const,
        signCount: 0,
        backupEligible: true,
        backupState: true,
        transports: ["internal", "cable"],
        userPresent: true as const,
        userVerified: true as const
      }
    };
  }

  async verifyAuthentication(_response: unknown, expectations: AuthenticationVerificationExpectations) {
    const record = await this.store.findPasskeyCredentialById(EXISTING_CREDENTIAL_ID);
    if (record === null || record.accountId !== expectations.expectedAccountId) {
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

function createService(
  store: SqliteStore,
  clock: MutableClock,
  tokens?: StepUpTokenSecurity
): PasskeyService {
  return new PasskeyService(store, {
    adapter: new ServiceSeamFakeWebAuthnAdapter(store),
    nowMs: () => clock.value,
    ...(tokens === undefined ? {} : { stepUpTokens: tokens })
  });
}

async function createHarness(input: {
  readonly seedExistingCredential?: boolean;
  readonly sessionTtlMs?: number;
  readonly includeTokenAuthority?: boolean;
} = {}): Promise<Harness> {
  const directory = mkdtempSync(join(tmpdir(), "luxora-passkey-service-"));
  directories.push(directory);
  const databasePath = join(directory, "luxora.sqlite");
  const clock = { value: START_MS };
  const key = Buffer.alloc(32, 0x42).toString("base64url");
  const cipher = new AesGcmContentCipher({ service: key }, "service");
  const store = openEncryptedStore(databasePath, cipher, clock);
  const createdAt = new Date(clock.value).toISOString();
  const sessionExpiresAt = new Date(clock.value + (input.sessionTtlMs ?? 86_400_000)).toISOString();
  store.createUser({
    id: ACCOUNT_ID,
    username: "LuxoraTester",
    usernameNormalized: "luxoratester",
    displayName: "Luxora Tester",
    passwordHash: "not-used-by-passkey-service-test",
    createdAt
  });
  store.createSession({
    id: SESSION_ID,
    userId: ACCOUNT_ID,
    deviceName: "Test endpoint",
    createdAt,
    expiresAt: sessionExpiresAt
  }, {
    id: randomUUID(),
    sessionId: SESSION_ID,
    tokenHash: createHash("sha256").update("passkey-service-refresh", "utf8").digest("hex"),
    createdAt,
    expiresAt: sessionExpiresAt
  });

  if (input.seedExistingCredential === true) {
    const handle = await store.getOrCreatePasskeyUserHandleBinding(ACCOUNT_ID);
    seedExistingPasskeyCredentialForTest({
      databasePath,
      cipher,
      accountId: ACCOUNT_ID,
      sessionId: SESSION_ID,
      userHandleRef: handle.reference,
      credentialId: EXISTING_CREDENTIAL_ID,
      recordId: EXISTING_RECORD_ID,
      nowMs: clock.value,
      targetDigest: canonicalTargetDigest()
    });
  }

  const tokens = new StepUpTokenSecurity(TOKEN_SECRET, () => new Date(clock.value));
  const service = createService(
    store,
    clock,
    input.includeTokenAuthority === false ? undefined : tokens
  );
  return {
    directory,
    databasePath,
    cipher,
    clock,
    principal: { userId: ACCOUNT_ID, sessionId: SESSION_ID, tokenId: TOKEN_ID },
    tokens,
    store,
    service
  };
}

async function completeStepUp(harness: Harness): Promise<CompletedStepUp> {
  const begun = await harness.service.beginStepUp(harness.principal, {
    commandId: randomUUID(),
    clientNonce: randomUUID(),
    operation: "authenticator.add"
  });
  const verifyCommandId = randomUUID();
  const verifyResponse = response("authentication");
  harness.clock.value += 1_000;
  const verified = await harness.service.verify(harness.principal, {
    ceremonyId: begun.ceremony.id,
    commandId: verifyCommandId,
    expectedRevision: begun.ceremony.revision,
    response: verifyResponse
  });
  if (!("stepUpAuthorization" in verified)) throw new Error("step-up authorization missing from fixture response");
  return {
    ceremonyId: begun.ceremony.id,
    verifyCommandId,
    verifyResponse,
    token: verified.stepUpAuthorization.token,
    targetDigest: canonicalTargetDigest(),
    expiresAt: verified.stepUpAuthorization.expiresAt
  };
}

describe("Passkey service with real token and encrypted SQLite seams", () => {
  it("maps malformed trusted adapter output to a generic internal error", async () => {
    const harness = await createHarness({ seedExistingCredential: true });
    const adapter = new ServiceSeamFakeWebAuthnAdapter(harness.store);
    adapter.createAuthenticationOptions = async () => ({ challenge: null } as never);
    const service = new PasskeyService(harness.store, {
      adapter,
      nowMs: () => harness.clock.value,
      stepUpTokens: harness.tokens
    });

    let thrown: unknown;
    try {
      await service.beginStepUp(harness.principal, {
        commandId: randomUUID(),
        clientNonce: randomUUID(),
        operation: "authenticator.add"
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(AppError);
    expect(thrown).toMatchObject({
      statusCode: 500,
      code: "INTERNAL_ERROR",
      message: "Passkey response could not be encoded"
    });
    expect((thrown as AppError).details).toBeUndefined();
    expect(JSON.stringify(thrown)).not.toContain("issues");
  });

  it("labels passkey idempotency conflicts with the protocol-safe reason", async () => {
    const harness = await createHarness({ seedExistingCredential: true });
    const commandId = randomUUID();
    await harness.service.beginStepUp(harness.principal, {
      commandId,
      clientNonce: randomUUID(),
      operation: "authenticator.add"
    });

    await expect(harness.service.beginStepUp(harness.principal, {
      commandId,
      clientNonce: randomUUID(),
      operation: "authenticator.add"
    })).rejects.toMatchObject({
      statusCode: 409,
      code: "CONFLICT",
      details: { reason: "ceremony_conflict" }
    });
  });

  it("fails closed without authority and for every invalid token binding before creating passkey state", async () => {
    const noAuthority = await createHarness({ includeTokenAuthority: false });
    await expectStepUpRequired(noAuthority.service.beginRegistration(noAuthority.principal, {
      commandId: randomUUID(),
      clientNonce: randomUUID(),
      stepUpCeremonyId: randomUUID(),
      stepUpToken: "not-a-token"
    }), "not-a-token");
    expect(inspectCounts(noAuthority.databasePath)).toMatchObject({
      ceremonies: 0,
      grants: 0,
      credentials: 0,
      handles: 0,
      commands: 0,
      creations: 0,
      challenges: 0
    });

    const harness = await createHarness();
    const ceremonyId = randomUUID();
    const nowSec = Math.floor(harness.clock.value / 1_000);
    const validInput = {
      accountId: ACCOUNT_ID,
      sessionId: SESSION_ID,
      ceremonyId,
      purpose: "authenticator.add" as const,
      targetDigest: canonicalTargetDigest(),
      issuedAt: nowSec,
      expiresAt: nowSec + 300
    };
    const candidates = [
      "malformed-token",
      await harness.tokens.issue({ ...validInput, accountId: OTHER_ACCOUNT_ID }),
      await harness.tokens.issue({ ...validInput, sessionId: OTHER_SESSION_ID }),
      await harness.tokens.issue({ ...validInput, ceremonyId: randomUUID() }),
      await harness.tokens.issue({ ...validInput, targetDigest: "b".repeat(64) }),
      await harness.tokens.issue({ ...validInput, issuedAt: nowSec - 300, expiresAt: nowSec })
    ];
    for (const stepUpToken of candidates) {
      await expectStepUpRequired(harness.service.beginRegistration(harness.principal, {
        commandId: randomUUID(),
        clientNonce: randomUUID(),
        stepUpCeremonyId: ceremonyId,
        stepUpToken
      }), stepUpToken);
    }
    expect(inspectCounts(harness.databasePath)).toMatchObject({
      ceremonies: 0,
      grants: 0,
      credentials: 0,
      handles: 0,
      commands: 0,
      creations: 0,
      challenges: 0
    });
  });

  it("does not persist a prepared userHandle for a valid token without its durable grant", async () => {
    const harness = await createHarness();
    const ceremonyId = randomUUID();
    const nowSec = Math.floor(harness.clock.value / 1_000);
    const token = await harness.tokens.issue({
      accountId: ACCOUNT_ID,
      sessionId: SESSION_ID,
      ceremonyId,
      purpose: "authenticator.add",
      targetDigest: canonicalTargetDigest(),
      issuedAt: nowSec,
      expiresAt: nowSec + 300
    });

    await expectStepUpRequired(harness.service.beginRegistration(harness.principal, {
      commandId: randomUUID(),
      clientNonce: randomUUID(),
      stepUpCeremonyId: ceremonyId,
      stepUpToken: token
    }), token);
    expect(await harness.store.findPasskeyUserHandleByAccountId(ACCOUNT_ID)).toBeNull();
    expect(inspectCounts(harness.databasePath)).toMatchObject({
      registrationCeremonies: 0,
      grants: 0,
      credentials: 0,
      handles: 0,
      commands: 0,
      creations: 0,
      challenges: 0
    });
  });

  it("mints a durable grant and replays an identical token after store and security restart", async () => {
    const harness = await createHarness({ seedExistingCredential: true });
    const completed = await completeStepUp(harness);
    const grant = await harness.store.findPasskeyStepUpGrant(completed.ceremonyId);
    expect(grant).toMatchObject({
      authenticationCeremonyId: completed.ceremonyId,
      accountId: ACCOUNT_ID,
      sessionId: SESSION_ID,
      deviceId: SESSION_ID,
      purpose: "authenticator.add",
      targetDigest: completed.targetDigest,
      consumedAtSec: null,
      registrationCeremonyId: null
    });
    if (grant === null) throw new Error("durable grant missing");

    const claims = await harness.tokens.verify(completed.token, {
      accountId: ACCOUNT_ID,
      sessionId: SESSION_ID,
      ceremonyId: completed.ceremonyId,
      purpose: "authenticator.add",
      targetDigest: completed.targetDigest
    });
    expect(claims).toEqual({
      iss: "https://api.luxora.app",
      aud: "luxora-step-up",
      sub: ACCOUNT_ID,
      sid: SESSION_ID,
      ceremony_id: completed.ceremonyId,
      jti: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
      purpose: "authenticator.add",
      target_digest: completed.targetDigest,
      amr: ["webauthn"],
      auth_time: grant.authTimeSec,
      iat: grant.issuedAtSec,
      exp: grant.expiresAtSec,
      token_use: "step_up"
    });
    expect(completed.expiresAt).toBe(new Date(grant.expiresAtSec * 1_000).toISOString());
    expectTokenAbsentFromDatabaseFiles(harness.databasePath, completed.token);

    closeTrackedStore(harness.store);
    harness.store = openEncryptedStore(harness.databasePath, harness.cipher, harness.clock);
    harness.tokens = new StepUpTokenSecurity(TOKEN_SECRET, () => new Date(harness.clock.value));
    harness.service = createService(harness.store, harness.clock, harness.tokens);
    const replay = await harness.service.verify(harness.principal, {
      ceremonyId: completed.ceremonyId,
      commandId: completed.verifyCommandId,
      expectedRevision: 1,
      response: completed.verifyResponse
    });
    expect(replay).toMatchObject({ replayed: true, ceremony: { state: "consumed", revision: 2 } });
    if (!("stepUpAuthorization" in replay)) throw new Error("replayed step-up authorization missing");
    expect(replay.stepUpAuthorization.token).toBe(completed.token);
    expectTokenAbsentFromDatabaseFiles(harness.databasePath, completed.token);
    await expect(harness.store.findPasskeyCredentialById(EXISTING_CREDENTIAL_ID)).resolves.toMatchObject({
      revision: 2,
      signCount: 1
    });
  });

  it("consumes a valid grant once, replays the same begin, and stores the new credential", async () => {
    const harness = await createHarness({ seedExistingCredential: true });
    const completed = await completeStepUp(harness);
    const commandId = randomUUID();
    const clientNonce = randomUUID();
    const registrationInput = {
      commandId,
      clientNonce,
      stepUpCeremonyId: completed.ceremonyId,
      stepUpToken: completed.token
    };
    const begun = await harness.service.beginRegistration(harness.principal, registrationInput);
    expect(begun).toMatchObject({
      replayed: false,
      ceremony: { kind: "registration", purpose: "authenticator.add", state: "pending", revision: 1 },
      options: { rp: { id: "auth.luxora.app" } }
    });
    expect(begun.options.excludeCredentials.map(({ id }) => id)).toEqual([EXISTING_CREDENTIAL_ID]);
    const consumedOnce = await harness.store.findPasskeyStepUpGrant(completed.ceremonyId);

    const exactReplay = await harness.service.beginRegistration(harness.principal, registrationInput);
    expect(exactReplay).toEqual({ ...begun, replayed: true });
    const grant = await harness.store.findPasskeyStepUpGrant(completed.ceremonyId);
    expect(grant).toEqual(consumedOnce);
    expect(grant).toMatchObject({
      consumedAtSec: Math.floor(harness.clock.value / 1_000),
      registrationCeremonyId: begun.ceremony.id
    });

    harness.clock.value += 1_000;
    const verified = await harness.service.verify(harness.principal, {
      ceremonyId: begun.ceremony.id,
      commandId: randomUUID(),
      expectedRevision: begun.ceremony.revision,
      response: response("registration")
    });
    expect(verified).toMatchObject({
      verified: true,
      replayed: false,
      ceremony: { kind: "registration", state: "consumed", revision: 2 }
    });
    expect("stepUpAuthorization" in verified).toBe(false);
    await expect(harness.store.findPasskeyCredentialById(NEW_CREDENTIAL_ID)).resolves.toMatchObject({
      accountId: ACCOUNT_ID,
      registrationCeremonyId: begun.ceremony.id,
      revision: 1,
      signCount: 0,
      transports: ["internal", "cable"]
    });
    await expect(harness.service.beginRegistration(harness.principal, registrationInput))
      .rejects.toMatchObject({
        statusCode: 409,
        code: "CONFLICT",
        details: { reason: "ceremony_conflict", state: "consumed", revision: 2 }
      });
    expectTokenAbsentFromDatabaseFiles(harness.databasePath, completed.token);
  });

  it("recovers only the exact committed begin after token expiry while its challenge is live", async () => {
    const harness = await createHarness({ seedExistingCredential: true });
    const completed = await completeStepUp(harness);
    // Start the registration one second after the authentication outcome so
    // its five-minute challenge remains live at the token's exact exp boundary.
    harness.clock.value += 1_000;
    const registrationInput = {
      commandId: randomUUID(),
      clientNonce: randomUUID(),
      stepUpCeremonyId: completed.ceremonyId,
      stepUpToken: completed.token
    };
    const begun = await harness.service.beginRegistration(harness.principal, registrationInput);
    const consumedGrant = await harness.store.findPasskeyStepUpGrant(completed.ceremonyId);
    if (consumedGrant === null) throw new Error("consumed grant missing");
    const counts = inspectCounts(harness.databasePath);

    harness.clock.value = consumedGrant.expiresAtSec * 1_000;
    expect(harness.clock.value).toBeLessThan(Date.parse(begun.ceremony.expiresAt));
    await expect(harness.tokens.verify(completed.token, {
      accountId: ACCOUNT_ID,
      sessionId: SESSION_ID,
      ceremonyId: completed.ceremonyId,
      purpose: "authenticator.add",
      targetDigest: completed.targetDigest
    })).rejects.toBeInstanceOf(Error);

    const replay = await harness.service.beginRegistration(harness.principal, registrationInput);
    expect(replay).toEqual({ ...begun, replayed: true });
    expect(inspectCounts(harness.databasePath)).toEqual(counts);

    await expectStepUpRequired(harness.service.beginRegistration(harness.principal, {
      ...registrationInput,
      commandId: randomUUID()
    }), completed.token);
    expect(inspectCounts(harness.databasePath)).toEqual(counts);
    expectTokenAbsentFromDatabaseFiles(harness.databasePath, completed.token);
  });

  it("authenticates the committed token before exposing terminal ceremony state", async () => {
    const harness = await createHarness({ seedExistingCredential: true });
    const completed = await completeStepUp(harness);
    const registrationInput = {
      commandId: randomUUID(),
      clientNonce: randomUUID(),
      stepUpCeremonyId: completed.ceremonyId,
      stepUpToken: completed.token
    };
    const begun = await harness.service.beginRegistration(harness.principal, registrationInput);
    await harness.service.verify(harness.principal, {
      ceremonyId: begun.ceremony.id,
      commandId: randomUUID(),
      expectedRevision: begun.ceremony.revision,
      response: response("registration")
    });
    const before = inspectCounts(harness.databasePath);
    const invalidToken = `x${completed.token.slice(1)}`;

    await expectStepUpRequired(harness.service.beginRegistration(harness.principal, {
      ...registrationInput,
      stepUpToken: invalidToken
    }), invalidToken);
    expect(inspectCounts(harness.databasePath)).toEqual(before);
    expectTokenAbsentFromDatabaseFiles(harness.databasePath, invalidToken);
  });

  it("does not let a second valid grant replay the ceremony authorized by the first grant", async () => {
    const harness = await createHarness({ seedExistingCredential: true });
    const firstGrant = await completeStepUp(harness);
    const registrationInput = {
      commandId: randomUUID(),
      clientNonce: randomUUID(),
      stepUpCeremonyId: firstGrant.ceremonyId,
      stepUpToken: firstGrant.token
    };
    const begun = await harness.service.beginRegistration(harness.principal, registrationInput);

    const secondGrant = await completeStepUp(harness);
    const before = inspectCounts(harness.databasePath);
    await expectStepUpRequired(harness.service.beginRegistration(harness.principal, {
      ...registrationInput,
      stepUpCeremonyId: secondGrant.ceremonyId,
      stepUpToken: secondGrant.token
    }), secondGrant.token);

    await expect(harness.store.findPasskeyStepUpGrant(firstGrant.ceremonyId)).resolves.toMatchObject({
      registrationCeremonyId: begun.ceremony.id,
      consumedAtSec: expect.any(Number)
    });
    await expect(harness.store.findPasskeyStepUpGrant(secondGrant.ceremonyId)).resolves.toMatchObject({
      registrationCeremonyId: null,
      consumedAtSec: null
    });
    expect(inspectCounts(harness.databasePath)).toEqual(before);
  });

  it("does not replay an already-authorized registration after its session is revoked", async () => {
    const harness = await createHarness({ seedExistingCredential: true });
    const completed = await completeStepUp(harness);
    const registrationInput = {
      commandId: randomUUID(),
      clientNonce: randomUUID(),
      stepUpCeremonyId: completed.ceremonyId,
      stepUpToken: completed.token
    };
    await harness.service.beginRegistration(harness.principal, registrationInput);
    const before = inspectCounts(harness.databasePath);
    harness.store.revokeSession(SESSION_ID, new Date(harness.clock.value).toISOString());

    await expectStepUpRequired(
      harness.service.beginRegistration(harness.principal, registrationInput),
      completed.token
    );
    expect(inspectCounts(harness.databasePath)).toEqual(before);
  });

  it("allows exactly one of two distinct registration begins to consume the same grant", async () => {
    const harness = await createHarness({ seedExistingCredential: true });
    const completed = await completeStepUp(harness);
    const before = inspectCounts(harness.databasePath);
    const attempts = ["left", "right"].map(() => harness.service.beginRegistration(harness.principal, {
      commandId: randomUUID(),
      clientNonce: randomUUID(),
      stepUpCeremonyId: completed.ceremonyId,
      stepUpToken: completed.token
    }));
    const outcomes = await Promise.allSettled(attempts);
    const successes = outcomes.filter((outcome) => outcome.status === "fulfilled");
    const failures = outcomes.filter((outcome) => outcome.status === "rejected");
    expect(successes).toHaveLength(1);
    expect(failures).toHaveLength(1);
    expect((failures[0] as PromiseRejectedResult).reason).toMatchObject({
      statusCode: 403,
      code: "FORBIDDEN",
      details: { reason: "step_up_required" }
    });
    expect(JSON.stringify((failures[0] as PromiseRejectedResult).reason)).not.toContain(completed.token);

    const winner = (successes[0] as PromiseFulfilledResult<Awaited<ReturnType<PasskeyService["beginRegistration"]>>>).value;
    const grant = await harness.store.findPasskeyStepUpGrant(completed.ceremonyId);
    expect(grant?.registrationCeremonyId).toBe(winner.ceremony.id);
    const after = inspectCounts(harness.databasePath);
    expect(after.registrationCeremonies - before.registrationCeremonies).toBe(1);
    expect(after.commands - before.commands).toBe(1);
    expect(after.creations - before.creations).toBe(1);
    expect(after.challenges - before.challenges).toBe(1);
  });

  it("rejects a revoked session without consuming the grant or leaving a registration orphan", async () => {
    const harness = await createHarness({ seedExistingCredential: true });
    const completed = await completeStepUp(harness);
    const before = inspectCounts(harness.databasePath);
    harness.store.revokeSession(SESSION_ID, new Date(harness.clock.value).toISOString());
    await expectStepUpRequired(harness.service.beginRegistration(harness.principal, {
      commandId: randomUUID(),
      clientNonce: randomUUID(),
      stepUpCeremonyId: completed.ceremonyId,
      stepUpToken: completed.token
    }), completed.token);
    expect(await harness.store.findPasskeyStepUpGrant(completed.ceremonyId)).toMatchObject({
      consumedAtSec: null,
      registrationCeremonyId: null
    });
    const after = inspectCounts(harness.databasePath);
    expect(after.registrationCeremonies).toBe(before.registrationCeremonies);
    expect(after.commands).toBe(before.commands);
    expect(after.creations).toBe(before.creations);
    expect(after.challenges).toBe(before.challenges);
  });

  it("rejects an expired session while its step-up token is still cryptographically live", async () => {
    const harness = await createHarness({ seedExistingCredential: true, sessionTtlMs: 120_000 });
    const completed = await completeStepUp(harness);
    const before = inspectCounts(harness.databasePath);
    harness.clock.value = START_MS + 120_000;
    await harness.tokens.verify(completed.token, {
      accountId: ACCOUNT_ID,
      sessionId: SESSION_ID,
      ceremonyId: completed.ceremonyId,
      purpose: "authenticator.add",
      targetDigest: completed.targetDigest
    });
    await expectStepUpRequired(harness.service.beginRegistration(harness.principal, {
      commandId: randomUUID(),
      clientNonce: randomUUID(),
      stepUpCeremonyId: completed.ceremonyId,
      stepUpToken: completed.token
    }), completed.token);
    expect(await harness.store.findPasskeyStepUpGrant(completed.ceremonyId)).toMatchObject({
      consumedAtSec: null,
      registrationCeremonyId: null
    });
    const after = inspectCounts(harness.databasePath);
    expect(after.registrationCeremonies).toBe(before.registrationCeremonies);
    expect(after.challenges).toBe(before.challenges);
  });

  it("rejects an expired grant/token before creating a registration handle or ceremony", async () => {
    const harness = await createHarness({ seedExistingCredential: true });
    const completed = await completeStepUp(harness);
    const grant = await harness.store.findPasskeyStepUpGrant(completed.ceremonyId);
    if (grant === null) throw new Error("durable grant missing");
    const before = inspectCounts(harness.databasePath);
    harness.clock.value = grant.expiresAtSec * 1_000;
    await expectStepUpRequired(harness.service.beginRegistration(harness.principal, {
      commandId: randomUUID(),
      clientNonce: randomUUID(),
      stepUpCeremonyId: completed.ceremonyId,
      stepUpToken: completed.token
    }), completed.token);
    expect(await harness.store.findPasskeyStepUpGrant(completed.ceremonyId)).toMatchObject({
      consumedAtSec: null,
      registrationCeremonyId: null
    });
    expect(inspectCounts(harness.databasePath)).toEqual(before);
  });
});
