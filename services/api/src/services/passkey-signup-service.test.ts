import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  PASSKEY_CHALLENGE_BYTES,
  StoreCredentialConflictError,
  StoreRevisionConflictError,
  type IssuedChallenge
} from "@luxora/passkey-domain";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  PersistPasskeySignupBegin,
  PersistPasskeySignupExpired,
  PersistPasskeySignupRejectedAttempt,
  PersistVerifiedPasskeySignup
} from "../domain/store.js";
import type {
  PasskeySignupConsumptionRecord,
  PasskeySignupIntentRecord,
  PasskeySignupReceiptRecord,
  RefreshTokenRecord,
  SessionRecord,
  UserRecord
} from "../domain/types.js";
import { AppError } from "../errors.js";
import type { ParsedPasskeyResponseBody } from "../http/passkey-response-body.js";
import { AesGcmContentCipher } from "../infrastructure/content-cipher.js";
import { SqliteStore } from "../infrastructure/sqlite-store.js";
import { PasskeySignupAuthorizationSecurity } from "../passkeys/signup-authorization-token.js";
import { PasskeySignupRefreshTokenSecurity } from "../passkeys/signup-refresh-token.js";
import {
  SimpleWebAuthnVerifierAdapter,
  type BootstrapRegistrationCeremony,
  type BootstrapRegistrationVerifierResult,
  type PasskeyCredentialRepository,
  type StoredPasskeyCredential,
  type StoredPasskeyUserHandle
} from "../passkeys/simplewebauthn-adapter.js";
import type { DeterministicAccessTokenInput } from "../security.js";
import {
  PasskeySignupService,
  type BeginPasskeySignupServiceInput,
  type PasskeySignupAccessTokenAuthority,
  type PasskeySignupServiceDependencies,
  type VerifyPasskeySignupServiceInput
} from "./passkey-signup-service.js";

const NOW_MS = 1_800_000_000_123;
const AUTHORIZATION_SECRET = "passkey-signup-service-authorization-secret-long-enough";
const REFRESH_KEY = randomBytes(32).toString("base64url");
const DELIVERY_NONCE = randomBytes(32).toString("base64url");
const OTHER_DELIVERY_NONCE = randomBytes(32).toString("base64url");
const DISABLED_HASH = `$argon2id$v=19$m=65536,t=3,p=1$${"A".repeat(22)}$${"B".repeat(43)}`;
const CREDENTIAL_ID = Buffer.from("signup-service-credential").toString("base64url");

interface MutableClock { milliseconds: number }

function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function beginInput(
  overrides: Partial<BeginPasskeySignupServiceInput> = {}
): BeginPasskeySignupServiceInput {
  return {
    commandId: randomUUID(),
    clientNonce: randomUUID(),
    deliveryNonce: DELIVERY_NONCE,
    username: "FlenymSignup",
    displayName: "Flenym Signup",
    deviceName: "iPhone 17 Pro",
    ...overrides
  };
}

function responseBody(label = "exact-registration-body"): ParsedPasskeyResponseBody {
  return Object.freeze({
    credential: Object.freeze({
      id: CREDENTIAL_ID,
      rawId: CREDENTIAL_ID,
      type: "public-key",
      response: Object.freeze({ opaqueCanary: label }),
      clientExtensionResults: Object.freeze({})
    }),
    byteLength: 311,
    digest: digest(label)
  });
}

function concatBytes(...chunks: readonly Uint8Array[]): Uint8Array {
  const output = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.byteLength, 0));
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

function cborText(value: string): Uint8Array {
  const encoded = Buffer.from(value, "utf8");
  if (encoded.byteLength > 23) throw new Error("fixture text too long");
  return concatBytes(Uint8Array.of(0x60 + encoded.byteLength), encoded);
}

function cborBytes(value: Uint8Array): Uint8Array {
  if (value.byteLength <= 23) return concatBytes(Uint8Array.of(0x40 + value.byteLength), value);
  if (value.byteLength <= 0xff) {
    return concatBytes(Uint8Array.of(0x58, value.byteLength), value);
  }
  if (value.byteLength <= 0xffff) {
    return concatBytes(
      Uint8Array.of(0x59, (value.byteLength >> 8) & 0xff, value.byteLength & 0xff),
      value
    );
  }
  throw new Error("fixture bytes too long");
}

function maintainedRegistrationResponse(challenge: string) {
  const credentialId = Buffer.from(CREDENTIAL_ID, "base64url");
  const coseKey = concatBytes(
    Uint8Array.of(0xa5, 0x01, 0x02, 0x03, 0x26, 0x20, 0x01, 0x21),
    cborBytes(new Uint8Array(32).fill(0x11)),
    Uint8Array.of(0x22),
    cborBytes(new Uint8Array(32).fill(0x22))
  );
  const authData = concatBytes(
    createHash("sha256").update("auth.luxora.app", "utf8").digest(),
    Uint8Array.of(0x45),
    Uint8Array.of(0, 0, 0, 0),
    new Uint8Array(16),
    Uint8Array.of((credentialId.byteLength >> 8) & 0xff, credentialId.byteLength & 0xff),
    credentialId,
    coseKey
  );
  const attestationObject = concatBytes(
    Uint8Array.of(0xa3),
    cborText("fmt"), cborText("none"),
    cborText("attStmt"), Uint8Array.of(0xa0),
    cborText("authData"), cborBytes(authData)
  );
  const credential = Object.freeze({
    id: CREDENTIAL_ID,
    rawId: CREDENTIAL_ID,
    response: Object.freeze({
      clientDataJSON: Buffer.from(JSON.stringify({
        type: "webauthn.create",
        challenge,
        origin: "https://auth.luxora.app"
      })).toString("base64url"),
      attestationObject: Buffer.from(attestationObject).toString("base64url"),
      transports: Object.freeze(["internal"] as const)
    }),
    clientExtensionResults: Object.freeze({}),
    type: "public-key" as const
  });
  const serialized = JSON.stringify(credential);
  return Object.freeze({
    credential,
    byteLength: Buffer.byteLength(serialized, "utf8"),
    digest: digest(serialized)
  }) satisfies ParsedPasskeyResponseBody;
}

function verifyInput(
  authorization: string,
  overrides: Partial<VerifyPasskeySignupServiceInput> = {}
): VerifyPasskeySignupServiceInput {
  return {
    commandId: randomUUID(),
    expectedRevision: 1,
    signupAuthorization: authorization,
    response: responseBody(),
    ...overrides
  };
}

function cloneIntent(input: PersistPasskeySignupBegin["intent"]): PasskeySignupIntentRecord {
  return {
    ...input,
    candidate: {
      ...input.candidate,
      userHandle: new Uint8Array(input.candidate.userHandle)
    }
  };
}

class FakeSignupStore {
  readonly intents = new Map<string, PasskeySignupIntentRecord>();
  readonly commands = new Map<string, PasskeySignupReceiptRecord>();
  readonly creations = new Map<string, PasskeySignupReceiptRecord>();
  readonly consumptions = new Map<string, PasskeySignupConsumptionRecord>();
  readonly challenges = new Map<string, string>();
  readonly users = new Map<string, UserRecord>();
  readonly refreshRows = new Map<string, RefreshTokenRecord & { session: SessionRecord }>();
  readonly beginMutations: PersistPasskeySignupBegin[] = [];
  readonly rejectedMutations: PersistPasskeySignupRejectedAttempt[] = [];
  readonly expiredMutations: PersistPasskeySignupExpired[] = [];
  readonly verifiedMutations: PersistVerifiedPasskeySignup[] = [];
  intentLookups = 0;
  userLookups = 0;
  commandLookups = 0;
  challengeSequence = 0;
  rejectUsernameCollision = false;
  rejectCredentialCollision = false;
  failVerifiedBeforeApply = false;
  failVerifiedAfterApply = false;
  failBeginAfterApply = false;

  async issue(input: {
    readonly byteLength: typeof PASSKEY_CHALLENGE_BYTES;
    readonly expiresAtMs: number;
  }): Promise<IssuedChallenge> {
    expect(input.byteLength).toBe(PASSKEY_CHALLENGE_BYTES);
    this.challengeSequence += 1;
    const reference = `signup-challenge:${this.challengeSequence}`;
    const challenge = Buffer.alloc(PASSKEY_CHALLENGE_BYTES, this.challengeSequence)
      .toString("base64url");
    this.challenges.set(reference, challenge);
    return Object.freeze({ reference, challenge });
  }

  async resolve(reference: string): Promise<string | null> {
    return this.challenges.get(reference) ?? null;
  }

  async discard(reference: string): Promise<void> {
    this.challenges.delete(reference);
  }

  async findPasskeySignupIntent(intentId: string): Promise<PasskeySignupIntentRecord | null> {
    this.intentLookups += 1;
    return this.intents.get(intentId) ?? null;
  }

  async findPasskeySignupConsumption(
    intentId: string
  ): Promise<PasskeySignupConsumptionRecord | null> {
    return this.consumptions.get(intentId) ?? null;
  }

  async findPasskeySignupCommandReceipt(
    scope: string
  ): Promise<PasskeySignupReceiptRecord | null> {
    this.commandLookups += 1;
    return this.commands.get(scope) ?? null;
  }

  async findPasskeySignupCreationReceipt(
    scope: string
  ): Promise<PasskeySignupReceiptRecord | null> {
    return this.creations.get(scope) ?? null;
  }

  async commitPasskeySignupBegin(input: PersistPasskeySignupBegin): Promise<void> {
    this.beginMutations.push(input);
    this.intents.set(input.intent.intentId, cloneIntent(input.intent));
    this.commands.set(input.commandReceipt.scope, input.commandReceipt);
    this.creations.set(input.creationReceipt.scope, input.creationReceipt);
    if (this.failBeginAfterApply) throw new Error("ambiguous begin response loss");
  }

  async commitPasskeySignupRejectedAttempt(
    input: PersistPasskeySignupRejectedAttempt
  ): Promise<void> {
    this.rejectedMutations.push(input);
    const current = this.intents.get(input.intentId);
    if (current === undefined || current.revision !== input.expectedRevision) {
      throw new StoreRevisionConflictError();
    }
    this.intents.set(input.intentId, {
      ...current,
      state: input.nextState,
      revision: current.revision + 1,
      attemptsUsed: current.attemptsUsed + 1,
      updatedAtMs: input.updatedAtMs,
      terminalAtMs: input.nextState === "rejected" ? input.updatedAtMs : null,
      terminalReason: input.nextState === "rejected" ? "attempts_exhausted" : null
    });
    this.commands.set(input.commandReceipt.scope, input.commandReceipt);
    if (input.nextState === "rejected") this.challenges.delete(current.challenge.reference);
  }

  async commitPasskeySignupExpired(input: PersistPasskeySignupExpired): Promise<void> {
    this.expiredMutations.push(input);
    const current = this.intents.get(input.intentId);
    if (current === undefined || current.revision !== input.expectedRevision) {
      throw new StoreRevisionConflictError();
    }
    this.intents.set(input.intentId, {
      ...current,
      state: "expired",
      revision: current.revision + 1,
      updatedAtMs: input.terminalAtMs,
      terminalAtMs: input.terminalAtMs,
      terminalReason: "expired"
    });
    this.commands.set(input.commandReceipt.scope, input.commandReceipt);
    this.challenges.delete(current.challenge.reference);
  }

  async commitVerifiedPasskeySignup(input: PersistVerifiedPasskeySignup): Promise<void> {
    this.verifiedMutations.push(input);
    if (this.failVerifiedBeforeApply) throw new Error("writer unavailable");
    if (this.rejectCredentialCollision) throw new StoreCredentialConflictError();
    if (this.rejectUsernameCollision) throw new StoreRevisionConflictError();
    const current = this.intents.get(input.intentId);
    if (current === undefined || current.revision !== input.expectedRevision) {
      throw new StoreRevisionConflictError();
    }
    const consumed: PasskeySignupIntentRecord = {
      ...current,
      state: "consumed",
      revision: current.revision + 1,
      updatedAtMs: input.committedAtMs,
      terminalAtMs: input.committedAtMs,
      terminalReason: "verified",
      resolvedCredentialRecordId: input.credential.credentialRecordId
    };
    this.intents.set(input.intentId, consumed);
    const consumption: PasskeySignupConsumptionRecord = {
      intentId: input.intentId,
      resultRevision: consumed.revision,
      accountId: input.candidate.accountId,
      userHandleRef: input.candidate.userHandleRef,
      credentialRecordId: input.credential.credentialRecordId,
      sessionId: input.session.id,
      initialRefreshTokenId: input.refreshToken.id,
      initialAccessTokenExpiresAtSec: input.accessToken.expiresAtSec,
      refreshDerivationKeyId: input.refreshToken.derivationKeyId,
      committedAtMs: input.committedAtMs
    };
    this.consumptions.set(input.intentId, consumption);
    const user: UserRecord = {
      id: input.candidate.accountId,
      username: input.candidate.username,
      usernameNormalized: input.candidate.usernameNormalized,
      displayName: input.candidate.displayName,
      passwordHash: input.passwordAuth.disabledHash,
      passwordAuthEnabled: false,
      bio: "",
      avatarUrl: null,
      createdAt: input.session.createdAt,
      lastSeenAt: null
    };
    this.users.set(user.id, user);
    const session: SessionRecord = {
      ...input.session,
      lastSeenAt: input.session.createdAt,
      revokedAt: null
    };
    this.refreshRows.set(input.refreshToken.tokenHash, {
      id: input.refreshToken.id,
      sessionId: input.refreshToken.sessionId,
      tokenHash: input.refreshToken.tokenHash,
      createdAt: input.refreshToken.createdAt,
      expiresAt: input.refreshToken.expiresAt,
      usedAt: null,
      session
    });
    this.commands.set(input.commandReceipt.scope, input.commandReceipt);
    this.challenges.delete(current.challenge.reference);
    if (this.failVerifiedAfterApply) throw new Error("ambiguous verified response loss");
  }

  findUserById(id: string): UserRecord | null {
    this.userLookups += 1;
    return this.users.get(id) ?? null;
  }

  findRefreshToken(tokenHash: string): (RefreshTokenRecord & { session: SessionRecord }) | null {
    return this.refreshRows.get(tokenHash) ?? null;
  }

  isSessionActive(sessionId: string, userId: string, now: string): boolean {
    return [...this.refreshRows.values()].some((row) =>
      row.session.id === sessionId
      && row.session.userId === userId
      && row.session.revokedAt === null
      && row.session.expiresAt > now);
  }
}

class FakeSignupAdapter {
  mode: "verified" | "rejected" = "verified";
  credentialId = CREDENTIAL_ID;
  optionsCalls = 0;
  verifyCalls = 0;
  onVerify: (() => void) | null = null;
  lastVerificationResponse: unknown = null;

  async createBootstrapRegistrationOptions(input: BootstrapRegistrationCeremony) {
    this.optionsCalls += 1;
    return {
      challenge: input.expectedChallenge,
      rp: { id: input.expectedRpId, name: input.rpName },
      user: {
        id: Buffer.from(input.expectedUserHandle).toString("base64url"),
        name: input.userName,
        displayName: input.userDisplayName
      },
      pubKeyCredParams: [
        { type: "public-key" as const, alg: -7 as const },
        { type: "public-key" as const, alg: -257 as const }
      ],
      excludeCredentials: [],
      timeout: input.timeoutMs,
      attestation: "none" as const,
      authenticatorSelection: {
        residentKey: "required" as const,
        requireResidentKey: true,
        userVerification: "required" as const
      }
    };
  }

  async verifyBootstrapRegistration(
    _response: unknown,
    input: BootstrapRegistrationCeremony
  ): Promise<BootstrapRegistrationVerifierResult> {
    this.verifyCalls += 1;
    this.lastVerificationResponse = _response;
    this.onVerify?.();
    if (this.mode === "rejected") {
      return Object.freeze({ status: "rejected", reason: "invalid_webauthn_response" });
    }
    return Object.freeze({
      status: "verified" as const,
      kind: "bootstrap_registration" as const,
      candidate: Object.freeze({
        accountId: input.candidateAccountId,
        userHandleRef: input.userHandleRef,
        expectedUserHandle: new Uint8Array(input.expectedUserHandle),
        userName: input.userName,
        userDisplayName: input.userDisplayName
      }),
      credential: Object.freeze({
        credentialId: this.credentialId,
        publicKey: new Uint8Array([0xa5, 0x01, 0x02, 0x03]),
        algorithm: -7 as const,
        discoveryMode: "discoverable" as const,
        signCount: 0,
        backupEligible: true,
        backupState: true,
        transports: Object.freeze(["internal"] as const),
        userPresent: true as const,
        userVerified: true as const
      })
    });
  }
}

class FakeAccessTokens implements PasskeySignupAccessTokenAuthority {
  fail = false;
  onSign: (() => void) | null = null;
  readonly calls: DeterministicAccessTokenInput[] = [];

  async signDeterministicAccessToken(input: DeterministicAccessTokenInput) {
    this.calls.push(input);
    if (this.fail) throw new Error("access signing unavailable");
    this.onSign?.();
    return Object.freeze({
      token: `signup-access-${digest(JSON.stringify(input))}`,
      tokenId: input.tokenId
    });
  }
}

interface Fixture {
  readonly clock: MutableClock;
  readonly store: FakeSignupStore;
  readonly adapter: FakeSignupAdapter;
  readonly access: FakeAccessTokens;
  readonly service: PasskeySignupService;
}

function fixture(options: {
  readonly store?: FakeSignupStore;
  readonly adapter?: FakeSignupAdapter | SimpleWebAuthnVerifierAdapter;
} = {}): Fixture {
  const clock = { milliseconds: NOW_MS };
  const store = options.store ?? new FakeSignupStore();
  const fakeAdapter = options.adapter instanceof FakeSignupAdapter
    ? options.adapter
    : new FakeSignupAdapter();
  const access = new FakeAccessTokens();
  const dependencies: PasskeySignupServiceDependencies = {
    store,
    adapter: options.adapter ?? fakeAdapter,
    authorizations: new PasskeySignupAuthorizationSecurity(
      AUTHORIZATION_SECRET,
      () => new Date(clock.milliseconds)
    ),
    refreshTokens: new PasskeySignupRefreshTokenSecurity({ signup: REFRESH_KEY }, "signup"),
    accessTokens: access,
    passwords: { async createDisabledHash() { return DISABLED_HASH; } },
    policy: {
      accessTokenTtlSeconds: 900,
      sessionTtlSeconds: 86_400,
      recoveryGraceSeconds: 120
    },
    clock: () => new Date(clock.milliseconds)
  };
  return {
    clock,
    store,
    adapter: fakeAdapter,
    access,
    service: new PasskeySignupService(dependencies)
  };
}

async function begun(item: Fixture, input = beginInput()) {
  const response = await item.service.begin(input);
  return { input, response };
}

function expectAppError(error: unknown, status: number, message: string): void {
  expect(error).toBeInstanceOf(AppError);
  expect(error).toMatchObject({ statusCode: status, message });
}

beforeEach(() => {
  vi.restoreAllMocks();
});

const sqliteFixtures: Array<{ readonly directory: string; readonly store: SqliteStore }> = [];

afterEach(() => {
  for (const item of sqliteFixtures.splice(0)) {
    try { item.store.close(); } catch { /* already closed */ }
    rmSync(item.directory, { recursive: true, force: true });
  }
});

function sqliteFixture(
  adapter: FakeSignupAdapter | SimpleWebAuthnVerifierAdapter = new FakeSignupAdapter()
) {
  const directory = mkdtempSync(join(tmpdir(), "luxora-signup-service-"));
  const clock = { milliseconds: NOW_MS };
  const cipherKey = randomBytes(32).toString("base64url");
  const store = new SqliteStore(
    join(directory, "signup.sqlite"),
    new AesGcmContentCipher({ active: cipherKey }, "active"),
    () => clock.milliseconds
  );
  sqliteFixtures.push({ directory, store });
  const access = new FakeAccessTokens();
  const service = new PasskeySignupService({
    store,
    adapter,
    authorizations: new PasskeySignupAuthorizationSecurity(
      AUTHORIZATION_SECRET,
      () => new Date(clock.milliseconds)
    ),
    refreshTokens: new PasskeySignupRefreshTokenSecurity({ signup: REFRESH_KEY }, "signup"),
    accessTokens: access,
    passwords: { async createDisabledHash() { return DISABLED_HASH; } },
    policy: {
      accessTokenTtlSeconds: 900,
      sessionTtlSeconds: 86_400,
      recoveryGraceSeconds: 120
    },
    clock: () => new Date(clock.milliseconds)
  });
  return { directory, clock, store, adapter, access, service };
}

describe("PasskeySignupService", () => {
  it("begins without user/credential enumeration and persists before returning", async () => {
    const item = fixture();
    const existingId = randomUUID();
    item.store.users.set(existingId, {
      id: existingId,
      username: "FlenymSignup",
      usernameNormalized: "flenymsignup",
      displayName: "Existing",
      passwordHash: "opaque",
      passwordAuthEnabled: true,
      bio: "",
      avatarUrl: null,
      createdAt: new Date(NOW_MS - 1_000).toISOString(),
      lastSeenAt: null
    });

    const { response } = await begun(item);

    expect(response.replayed).toBe(false);
    expect(response.options.excludeCredentials).toEqual([]);
    expect(response.options.user.id).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(item.store.beginMutations).toHaveLength(1);
    expect(item.store.intents.has(response.ceremony.id)).toBe(true);
    expect(item.store.userLookups).toBe(0);
    expect(item.adapter.optionsCalls).toBe(1);
    const mutationJson = JSON.stringify(item.store.beginMutations[0]);
    expect(mutationJson).not.toContain(DELIVERY_NONCE);
    expect(mutationJson).not.toContain(response.bootstrapAuthorization.token);
    expect(mutationJson).not.toContain("Existing");
  });

  it("recovers exact begin response loss from receipts and the challenge lease", async () => {
    const item = fixture();
    item.store.failBeginAfterApply = true;
    const input = beginInput();
    const first = await item.service.begin(input);
    item.store.failBeginAfterApply = false;
    const replay = await item.service.begin(input);

    expect(first.replayed).toBe(true);
    expect(replay.replayed).toBe(true);
    expect(replay.ceremony.id).toBe(first.ceremony.id);
    expect(replay.bootstrapAuthorization.token).toBe(first.bootstrapAuthorization.token);
    expect(replay.options).toEqual(first.options);
  });

  it("creates account, disabled password auth, credential and tokens in one commit", async () => {
    const item = fixture();
    const { response: started } = await begun(item);
    const verified = await item.service.verify(verifyInput(started.bootstrapAuthorization.token));

    expect(verified).toMatchObject({
      verified: true,
      replayed: false,
      user: { username: "FlenymSignup", displayName: "Flenym Signup" },
      tokens: { tokenType: "Bearer", expiresIn: 900 }
    });
    expect(item.store.verifiedMutations).toHaveLength(1);
    expect(item.store.verifiedMutations[0]?.passwordAuth.enabled).toBe(false);
    expect(item.store.users.get(verified.user.id)?.passwordAuthEnabled).toBe(false);
    const persisted = JSON.stringify(item.store.verifiedMutations[0]);
    expect(persisted).not.toContain(started.bootstrapAuthorization.token);
    expect(persisted).not.toContain("exact-registration-body");
    expect(persisted).not.toContain(verified.tokens.refreshToken);
    expect(persisted).not.toContain(verified.tokens.accessToken);
  });

  it("authenticates authorization before any durable lookup or verifier call", async () => {
    const item = fixture();
    item.store.intentLookups = 0;
    item.store.commandLookups = 0;
    const error = await item.service.verify(verifyInput("e30.e30.AA"))
      .then(() => null, (caught: unknown) => caught);

    expectAppError(error, 401, "Passkey signup failed");
    expect(item.store.intentLookups).toBe(0);
    expect(item.store.commandLookups).toBe(0);
    expect(item.adapter.verifyCalls).toBe(0);
  });

  it("rejects malformed, accessor, proxy and coercion inputs before effects", async () => {
    const item = fixture();
    let reads = 0;
    const accessor = { ...beginInput() } as Record<string, unknown>;
    Object.defineProperty(accessor, "username", {
      enumerable: true,
      get() {
        reads += 1;
        throw new Error("CANARY");
      }
    });
    const cases = [
      accessor,
      new Proxy(beginInput(), {}),
      { ...beginInput(), commandId: beginInput().commandId.toUpperCase() },
      { ...beginInput(), displayName: " Flenym Signup" },
      { ...beginInput(), deviceName: 17 }
    ];
    for (const hostile of cases) {
      const error = await item.service.begin(hostile as BeginPasskeySignupServiceInput)
        .then(() => null, (caught: unknown) => caught);
      expectAppError(error, 400, "Invalid passkey signup request");
    }
    expect(reads).toBe(0);
    expect(item.store.beginMutations).toHaveLength(0);
  });

  it("snapshots credential JSON before awaits and rejects nested accessors", async () => {
    const item = fixture();
    const { response: started } = await begun(item);
    const mutableCredential = {
      id: CREDENTIAL_ID,
      rawId: CREDENTIAL_ID,
      type: "public-key",
      response: { opaqueCanary: "before-await" },
      clientExtensionResults: {}
    };
    const pending = item.service.verify(verifyInput(started.bootstrapAuthorization.token, {
      response: {
        credential: mutableCredential,
        byteLength: 311,
        digest: digest("stable-raw-bytes")
      }
    }));
    mutableCredential.response.opaqueCanary = "mutated-after-call";
    await pending;
    const captured = item.adapter.lastVerificationResponse as {
      readonly response: { readonly opaqueCanary: string };
    };
    expect(captured.response.opaqueCanary).toBe("before-await");

    const hostileItem = fixture();
    const hostileStarted = await begun(hostileItem);
    let reads = 0;
    const nested = { safe: true } as Record<string, unknown>;
    Object.defineProperty(nested, "canary", {
      enumerable: true,
      get() {
        reads += 1;
        throw new Error("CANARY");
      }
    });
    const error = await hostileItem.service.verify(verifyInput(
      hostileStarted.response.bootstrapAuthorization.token,
      {
        response: {
          credential: { response: nested },
          byteLength: 100,
          digest: digest("hostile")
        }
      }
    )).then(() => null, (caught: unknown) => caught);
    expectAppError(error, 400, "Invalid passkey signup verification request");
    expect(reads).toBe(0);
    expect(hostileItem.store.intentLookups).toBe(0);
  });

  it("bounds verifier rejection to exactly three attempts", async () => {
    const item = fixture();
    item.adapter.mode = "rejected";
    const { response: started } = await begun(item);
    for (let revision = 1; revision <= 3; revision += 1) {
      const error = await item.service.verify(verifyInput(
        started.bootstrapAuthorization.token,
        { expectedRevision: revision, commandId: randomUUID() }
      )).then(() => null, (caught: unknown) => caught);
      expectAppError(error, 401, "Passkey signup failed");
    }
    const intent = item.store.intents.get(started.ceremony.id);
    expect(intent).toMatchObject({ state: "rejected", revision: 4, attemptsUsed: 3 });
    expect(item.store.challenges).toHaveLength(0);
    expect(item.adapter.verifyCalls).toBe(3);

    const fourth = await item.service.verify(verifyInput(
      started.bootstrapAuthorization.token,
      { expectedRevision: 4, commandId: randomUUID() }
    )).then(() => null, (caught: unknown) => caught);
    expect(fourth).toMatchObject({ statusCode: 409 });
    expect(item.adapter.verifyCalls).toBe(3);
  });

  it("expires before verification and closes the challenge lease", async () => {
    const item = fixture();
    const { response: started } = await begun(item);
    item.clock.milliseconds = NOW_MS + 300_000;
    const error = await item.service.verify(verifyInput(started.bootstrapAuthorization.token))
      .then(() => null, (caught: unknown) => caught);

    expectAppError(error, 401, "Passkey signup failed");
    expect(item.store.intents.get(started.ceremony.id)).toMatchObject({
      state: "expired",
      revision: 2,
      terminalReason: "expired"
    });
    expect(item.adapter.verifyCalls).toBe(0);
    expect(item.store.challenges).toHaveLength(0);
  });

  it("closes a verifier TOCTOU that crosses expiry", async () => {
    const item = fixture();
    const { response: started } = await begun(item);
    item.adapter.onVerify = () => {
      item.clock.milliseconds = NOW_MS + 300_000;
    };
    const error = await item.service.verify(verifyInput(started.bootstrapAuthorization.token))
      .then(() => null, (caught: unknown) => caught);

    expectAppError(error, 401, "Passkey signup failed");
    expect(item.store.intents.get(started.ceremony.id)?.state).toBe("expired");
    expect(item.store.users).toHaveLength(0);
    expect(item.store.verifiedMutations).toHaveLength(0);
  });

  it("rejects token/intent and delivery-nonce substitution generically", async () => {
    const item = fixture();
    const first = await begun(item, beginInput({ deliveryNonce: DELIVERY_NONCE }));
    const second = await begun(item, beginInput({ deliveryNonce: OTHER_DELIVERY_NONCE }));
    item.adapter.mode = "rejected";
    const reusedCommandId = randomUUID();
    const firstFailure = await item.service.verify(verifyInput(
      first.response.bootstrapAuthorization.token,
      { commandId: reusedCommandId }
    )).then(() => null, (caught: unknown) => caught);
    expectAppError(firstFailure, 401, "Passkey signup failed");

    const substituted = await item.service.verify(verifyInput(
      second.response.bootstrapAuthorization.token,
      { commandId: reusedCommandId }
    )).then(() => null, (caught: unknown) => caught);
    expectAppError(substituted, 401, "Passkey signup failed");

    const retry = await item.service.begin({
      ...first.input,
      commandId: randomUUID(),
      deliveryNonce: OTHER_DELIVERY_NONCE
    }).then(() => null, (caught: unknown) => caught);
    expect(retry).toMatchObject({ statusCode: 409 });
  });

  it.each([
    ["username", "rejectUsernameCollision"],
    ["credential", "rejectCredentialCollision"]
  ] as const)("coarsens atomic %s race without ghost account", async (_label, flag) => {
    const item = fixture();
    item.store[flag] = true;
    const { response: started } = await begun(item);
    const error = await item.service.verify(verifyInput(started.bootstrapAuthorization.token))
      .then(() => null, (caught: unknown) => caught);

    expectAppError(error, 409, "Passkey signup could not be completed");
    expect(item.store.users).toHaveLength(0);
    expect(item.store.consumptions).toHaveLength(0);
    expect(item.store.refreshRows).toHaveLength(0);
    expect(item.store.intents.get(started.ceremony.id)?.state).toBe("pending");
  });

  it("leaves no ghost account when access signing fails", async () => {
    const item = fixture();
    item.access.fail = true;
    const { response: started } = await begun(item);
    const error = await item.service.verify(verifyInput(started.bootstrapAuthorization.token))
      .then(() => null, (caught: unknown) => caught);

    expectAppError(error, 503, "Passkey signup is temporarily unavailable");
    expect(item.store.verifiedMutations).toHaveLength(0);
    expect(item.store.users).toHaveLength(0);
    expect(item.store.intents.get(started.ceremony.id)?.state).toBe("pending");
  });

  it("rechecks ceremony expiry after access signing and leaves no ghost", async () => {
    const item = fixture();
    item.access.onSign = () => {
      item.clock.milliseconds = NOW_MS + 300_000;
    };
    const { response: started } = await begun(item);
    const error = await item.service.verify(verifyInput(started.bootstrapAuthorization.token))
      .then(() => null, (caught: unknown) => caught);

    expectAppError(error, 401, "Passkey signup failed");
    expect(item.store.verifiedMutations).toHaveLength(0);
    expect(item.store.users).toHaveLength(0);
    expect(item.store.intents.get(started.ceremony.id)).toMatchObject({
      state: "expired",
      terminalReason: "expired"
    });
  });

  it("recovers an ambiguous committed success and exact later replay", async () => {
    const item = fixture();
    item.store.failVerifiedAfterApply = true;
    const { response: started } = await begun(item);
    const input = verifyInput(started.bootstrapAuthorization.token);
    const recovered = await item.service.verify(input);
    item.store.failVerifiedAfterApply = false;
    const replay = await item.service.verify(input);

    expect(recovered.replayed).toBe(true);
    expect(replay.replayed).toBe(true);
    expect(replay.user).toEqual(recovered.user);
    expect(replay.tokens.refreshToken).toBe(recovered.tokens.refreshToken);
    expect(replay.tokens.accessToken).toBe(recovered.tokens.accessToken);
    expect(item.store.users).toHaveLength(1);
    expect(item.store.verifiedMutations).toHaveLength(1);
  });

  it("rejects committed body/revision/authorization substitutions", async () => {
    const item = fixture();
    const { response: started } = await begun(item);
    const original = verifyInput(started.bootstrapAuthorization.token);
    await item.service.verify(original);

    for (const changed of [
      { ...original, response: responseBody("different-body") },
      { ...original, expectedRevision: 2 },
      {
        ...original,
        signupAuthorization: `${original.signupAuthorization.slice(0, -1)}${
          original.signupAuthorization.endsWith("A") ? "B" : "A"
        }`
      }
    ]) {
      const error = await item.service.verify(changed)
        .then(() => null, (caught: unknown) => caught);
      expect(error).toBeInstanceOf(AppError);
      expect((error as AppError).statusCode).toBeGreaterThanOrEqual(401);
    }
  });

  it("uses the maintained generator without repository lookup", async () => {
    const repository: PasskeyCredentialRepository = {
      async findPasskeyUserHandleByRef(): Promise<StoredPasskeyUserHandle | null> {
        throw new Error("unexpected repository lookup");
      },
      async findPasskeyCredentialById(): Promise<StoredPasskeyCredential | null> {
        throw new Error("unexpected repository lookup");
      },
      async findPasskeyCredentialByRecordId(): Promise<StoredPasskeyCredential | null> {
        throw new Error("unexpected repository lookup");
      },
      async listPasskeyCredentialsByAccountId(): Promise<readonly StoredPasskeyCredential[]> {
        throw new Error("unexpected repository lookup");
      }
    };
    const maintained = new SimpleWebAuthnVerifierAdapter(repository);
    const item = fixture({ adapter: maintained });
    const response = await item.service.begin(beginInput());

    expect(response.options).toMatchObject({
      rp: { id: "auth.luxora.app", name: "Luxora" },
      pubKeyCredParams: [{ alg: -7 }, { alg: -257 }],
      excludeCredentials: [],
      authenticatorSelection: {
        residentKey: "required",
        requireResidentKey: true,
        userVerification: "required"
      }
    });
  });
});

describe("PasskeySignupService with SqliteStore", () => {
  it("completes signup through the maintained real registration verifier", async () => {
    const repository: PasskeyCredentialRepository = {
      async findPasskeyUserHandleByRef(): Promise<StoredPasskeyUserHandle | null> {
        throw new Error("unexpected repository lookup");
      },
      async findPasskeyCredentialById(): Promise<StoredPasskeyCredential | null> {
        throw new Error("unexpected repository lookup");
      },
      async findPasskeyCredentialByRecordId(): Promise<StoredPasskeyCredential | null> {
        throw new Error("unexpected repository lookup");
      },
      async listPasskeyCredentialsByAccountId(): Promise<readonly StoredPasskeyCredential[]> {
        throw new Error("unexpected repository lookup");
      }
    };
    const item = sqliteFixture(new SimpleWebAuthnVerifierAdapter(repository));
    const started = await item.service.begin(beginInput({ username: "MaintainedSignup" }));
    const response = maintainedRegistrationResponse(started.options.challenge);
    const verified = await item.service.verify(verifyInput(
      started.bootstrapAuthorization.token,
      { response }
    ));

    expect(verified).toMatchObject({
      verified: true,
      replayed: false,
      user: { username: "MaintainedSignup" }
    });
    expect(item.store.findUserById(verified.user.id)?.passwordAuthEnabled).toBe(false);
    expect(await item.store.findPasskeyCredentialById(CREDENTIAL_ID)).toMatchObject({
      accountId: verified.user.id,
      algorithm: -7,
      discoveryMode: "discoverable"
    });
  });

  it("commits and recovers an exact response using only durable safe projections", async () => {
    const item = sqliteFixture();
    const started = await item.service.begin(beginInput());
    const input = verifyInput(started.bootstrapAuthorization.token);
    const verified = await item.service.verify(input);
    const replay = await item.service.verify(input);

    expect(verified.replayed).toBe(false);
    expect(replay.replayed).toBe(true);
    expect(replay.user).toEqual(verified.user);
    expect(replay.tokens).toEqual(verified.tokens);
    expect(item.store.findUserByUsername("flenymsignup")).toMatchObject({
      id: verified.user.id,
      passwordAuthEnabled: false
    });
    expect(await item.store.findPasskeySignupConsumption(started.ceremony.id))
      .toMatchObject({ accountId: verified.user.id });
  });

  it("creates an intent even for an existing username and coarsens the writer race", async () => {
    const item = sqliteFixture();
    const first = await item.service.begin(beginInput({
      username: "FlenymSignup",
      clientNonce: randomUUID(),
      commandId: randomUUID()
    }));
    await item.service.verify(verifyInput(first.bootstrapAuthorization.token));
    const usernameLookup = vi.spyOn(item.store, "findUserByUsername");

    const second = await item.service.begin(beginInput({
      username: "FlenymSignup",
      deliveryNonce: OTHER_DELIVERY_NONCE,
      clientNonce: randomUUID(),
      commandId: randomUUID()
    }));
    expect(second.options.excludeCredentials).toEqual([]);
    expect(usernameLookup).not.toHaveBeenCalled();
    const secondIntent = await item.store.findPasskeySignupIntent(second.ceremony.id);
    const error = await item.service.verify(verifyInput(second.bootstrapAuthorization.token))
      .then(() => null, (caught: unknown) => caught);

    expectAppError(error, 409, "Passkey signup could not be completed");
    expect(secondIntent).not.toBeNull();
    expect(item.store.findUserById(secondIntent?.candidate.accountId ?? "")).toBeNull();
    expect(await item.store.findPasskeySignupConsumption(second.ceremony.id)).toBeNull();
  });

  it("coarsens a globally duplicate credential without creating the second account", async () => {
    const item = sqliteFixture();
    const first = await item.service.begin(beginInput({ username: "FirstSignup" }));
    await item.service.verify(verifyInput(first.bootstrapAuthorization.token));

    const second = await item.service.begin(beginInput({
      username: "SecondSignup",
      displayName: "Second Signup",
      clientNonce: randomUUID(),
      commandId: randomUUID(),
      deliveryNonce: OTHER_DELIVERY_NONCE
    }));
    const secondIntent = await item.store.findPasskeySignupIntent(second.ceremony.id);
    const error = await item.service.verify(verifyInput(second.bootstrapAuthorization.token))
      .then(() => null, (caught: unknown) => caught);

    expectAppError(error, 409, "Passkey signup could not be completed");
    expect(item.store.findUserByUsername("secondsignup")).toBeNull();
    expect(item.store.findUserById(secondIntent?.candidate.accountId ?? "")).toBeNull();
  });
});
