import { createHash, randomBytes, randomUUID } from "node:crypto";

import type {
  DiscoverableLoginVerificationExpectations,
  DiscoverableLoginVerifierSuccess,
  IssuedChallenge
} from "@luxora/passkey-domain";
import { PASSKEY_CHALLENGE_BYTES, StoreRevisionConflictError } from "@luxora/passkey-domain";
import { beforeEach, describe, expect, it } from "vitest";

import type {
  PersistPasskeyLoginBegin,
  PersistPasskeyLoginRejectedAttempt,
  PersistPasskeyLoginTerminal,
  PersistVerifiedPasskeyLogin
} from "../domain/store.js";
import type {
  PasskeyLoginIntentRecord,
  PasskeyLoginReceiptRecord,
  RefreshTokenRecord,
  SessionRecord,
  UserRecord
} from "../domain/types.js";
import { AppError } from "../errors.js";
import type { ParsedPasskeyResponseBody } from "../http/passkey-response-body.js";
import { PasskeyBootstrapRefreshTokenSecurity } from "../passkeys/bootstrap-refresh-token.js";
import { BootstrapTokenSecurity } from "../passkeys/bootstrap-token.js";
import type { DeterministicAccessTokenInput } from "../security.js";
import {
  PasskeyLoginService,
  type PasskeyLoginAccessTokenAuthority,
  type PasskeyLoginPolicyOptions,
  type PasskeyLoginServiceDependencies
} from "./passkey-login-service.js";

const NOW_MS = 1_800_000_000_123;
const ACCOUNT_ID = "11111111-1111-4111-8111-111111111111";
const CREDENTIAL_RECORD_ID = "22222222-2222-4222-8222-222222222222";
const USER_HANDLE_REF = "login-user-handle";
const COMMAND_ID = "33333333-3333-4333-8333-333333333333";
const OTHER_COMMAND_ID = "44444444-4444-4444-8444-444444444444";
const CLIENT_NONCE = "55555555-5555-4555-8555-555555555555";
const THIRD_COMMAND_ID = "66666666-6666-4666-8666-666666666666";
const DELIVERY_NONCE = randomBytes(32).toString("base64url");
const ACCESS_SECRET = "passkey-login-service-test-secret-that-is-long-enough";
const REFRESH_KEY = randomBytes(32).toString("base64url");

interface MutableClock {
  milliseconds: number;
}

function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function responseBody(): ParsedPasskeyResponseBody {
  const credential = Object.freeze({
    id: "credential",
    rawId: "credential",
    type: "public-key",
    response: Object.freeze({ assertion: "opaque" }),
    clientExtensionResults: Object.freeze({})
  });
  return Object.freeze({
    credential,
    byteLength: 211,
    digest: digest("exact-http-credential-bytes")
  });
}

function user(): UserRecord {
  const createdAt = new Date(NOW_MS - 10_000).toISOString();
  return {
    id: ACCOUNT_ID,
    username: "passkey_user",
    usernameNormalized: "passkey_user",
    displayName: "Passkey User",
    passwordHash: "unused-test-hash",
    passwordAuthEnabled: true,
    phonePasswordHash: null,
    phonePasswordEnabled: false,
    bio: "",
    avatarUrl: null,
    createdAt,
    lastSeenAt: null
  };
}

function verifiedCredential(): DiscoverableLoginVerifierSuccess {
  return Object.freeze({
    status: "verified",
    kind: "authentication",
    purpose: "session.create",
    credentialBoundary: "discoverable_any",
    account: Object.freeze({
      accountId: ACCOUNT_ID,
      userHandleRef: USER_HANDLE_REF,
      userHandleBindingVerified: true
    }),
    credential: Object.freeze({
      credentialRecordId: CREDENTIAL_RECORD_ID,
      credentialRevision: 7,
      algorithm: -7,
      discoveryMode: "discoverable",
      previousSignCount: 41,
      // A synced authenticator regression remains telemetry, never lockout.
      newSignCount: 0,
      previousBackupEligible: true,
      backupEligible: true,
      previousBackupState: false,
      backupState: true,
      userPresent: true,
      userVerified: true
    })
  });
}

class FakeLoginStore {
  readonly intents = new Map<string, PasskeyLoginIntentRecord>();
  readonly commands = new Map<string, PasskeyLoginReceiptRecord>();
  readonly creations = new Map<string, PasskeyLoginReceiptRecord>();
  readonly challenges = new Map<string, string>();
  readonly refreshTokens = new Map<string, RefreshTokenRecord & { session: SessionRecord }>();
  readonly users = new Map<string, UserRecord>([[ACCOUNT_ID, user()]]);
  readonly beginMutations: PersistPasskeyLoginBegin[] = [];
  readonly rejectedMutations: PersistPasskeyLoginRejectedAttempt[] = [];
  readonly terminalMutations: PersistPasskeyLoginTerminal[] = [];
  readonly verifiedMutations: PersistVerifiedPasskeyLogin[] = [];
  intentLookups = 0;
  commandLookups = 0;
  creationLookups = 0;
  failCommandLookup = false;
  challengeSequence = 0;

  resetLookupCounts(): void {
    this.intentLookups = 0;
    this.commandLookups = 0;
    this.creationLookups = 0;
  }

  async issue(input: {
    readonly byteLength: typeof PASSKEY_CHALLENGE_BYTES;
    readonly expiresAtMs: number;
  }): Promise<IssuedChallenge> {
    expect(input.byteLength).toBe(PASSKEY_CHALLENGE_BYTES);
    expect(input.expiresAtMs).toBeGreaterThan(NOW_MS);
    this.challengeSequence += 1;
    const reference = `challenge:test:${this.challengeSequence}`;
    const challenge = Buffer.alloc(PASSKEY_CHALLENGE_BYTES, this.challengeSequence).toString("base64url");
    this.challenges.set(reference, challenge);
    return Object.freeze({ reference, challenge });
  }

  async resolve(reference: string): Promise<string | null> {
    return this.challenges.get(reference) ?? null;
  }

  async discard(reference: string): Promise<void> {
    this.challenges.delete(reference);
  }

  async findPasskeyLoginIntent(intentId: string): Promise<PasskeyLoginIntentRecord | null> {
    this.intentLookups += 1;
    return this.intents.get(intentId) ?? null;
  }

  async findPasskeyLoginCommandReceipt(scope: string): Promise<PasskeyLoginReceiptRecord | null> {
    this.commandLookups += 1;
    if (this.failCommandLookup) throw new Error("test receipt store unavailable");
    return this.commands.get(scope) ?? null;
  }

  async findPasskeyLoginCreationReceipt(scope: string): Promise<PasskeyLoginReceiptRecord | null> {
    this.creationLookups += 1;
    return this.creations.get(scope) ?? null;
  }

  async commitPasskeyLoginBegin(input: PersistPasskeyLoginBegin): Promise<void> {
    this.beginMutations.push(input);
    this.intents.set(input.intent.intentId, {
      ...input.intent,
      resolution: null
    });
    this.commands.set(input.commandReceipt.scope, input.commandReceipt);
    this.creations.set(input.creationReceipt.scope, input.creationReceipt);
  }

  async commitPasskeyLoginRejectedAttempt(input: PersistPasskeyLoginRejectedAttempt): Promise<void> {
    this.rejectedMutations.push(input);
    const current = this.intents.get(input.intentId);
    if (current === undefined) throw new Error("missing test intent");
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
  }

  async commitPasskeyLoginTerminal(input: PersistPasskeyLoginTerminal): Promise<void> {
    this.terminalMutations.push(input);
    const current = this.intents.get(input.intentId);
    if (current === undefined) throw new Error("missing test intent");
    this.intents.set(input.intentId, {
      ...current,
      state: input.nextState,
      revision: current.revision + 1,
      updatedAtMs: input.terminalAtMs,
      terminalAtMs: input.terminalAtMs,
      terminalReason: input.nextState
    });
    this.commands.set(input.commandReceipt.scope, input.commandReceipt);
    this.challenges.delete(current.challenge.reference);
  }

  async commitVerifiedPasskeyLogin(input: PersistVerifiedPasskeyLogin): Promise<void> {
    const current = this.intents.get(input.intentId);
    if (current === undefined) throw new Error("missing test intent");
    if (current.state !== "pending" || current.revision !== input.expectedRevision) {
      throw new StoreRevisionConflictError();
    }
    this.verifiedMutations.push(input);
    const session: SessionRecord = {
      id: input.session.id,
      userId: input.session.userId,
      deviceName: input.session.deviceName,
      createdAt: input.session.createdAt,
      lastSeenAt: input.session.createdAt,
      expiresAt: input.session.expiresAt,
      revokedAt: null
    };
    this.refreshTokens.set(input.refreshToken.tokenHash, {
      id: input.refreshToken.id,
      sessionId: input.refreshToken.sessionId,
      tokenHash: input.refreshToken.tokenHash,
      createdAt: input.refreshToken.createdAt,
      expiresAt: input.refreshToken.expiresAt,
      usedAt: null,
      session
    });
    this.intents.set(input.intentId, {
      ...current,
      state: "consumed",
      revision: current.revision + 1,
      updatedAtMs: input.committedAtMs,
      terminalAtMs: input.committedAtMs,
      terminalReason: "verified",
      resolution: {
        accountId: input.credential.accountId,
        userHandleRef: input.credential.userHandleRef,
        credentialRecordId: input.credential.credentialRecordId,
        credentialRevisionBefore: input.credential.credentialRevision,
        credentialRevisionAfter: input.credential.credentialRevision + 1,
        signCountBefore: input.credential.previousSignCount,
        observedSignCount: input.credential.newSignCount,
        signCountAfter: Math.max(input.credential.previousSignCount, input.credential.newSignCount),
        backupEligible: input.credential.backupEligible,
        backupStateBefore: input.credential.previousBackupState,
        backupStateAfter: input.credential.backupState,
        sessionId: input.session.id,
        initialRefreshTokenId: input.refreshToken.id,
        initialAccessTokenExpiresAtSec: input.accessToken.expiresAtSec
      }
    });
    this.commands.set(input.commandReceipt.scope, input.commandReceipt);
    this.challenges.delete(current.challenge.reference);
  }

  findUserById(id: string): UserRecord | null {
    return this.users.get(id) ?? null;
  }

  findRefreshToken(tokenHash: string): (RefreshTokenRecord & { session: SessionRecord }) | null {
    return this.refreshTokens.get(tokenHash) ?? null;
  }

  isSessionActive(sessionId: string, accountId: string, now: string): boolean {
    for (const refresh of this.refreshTokens.values()) {
      if (
        refresh.session.id === sessionId
        && refresh.session.userId === accountId
        && refresh.session.revokedAt === null
        && refresh.session.expiresAt > now
      ) return true;
    }
    return false;
  }
}

class FakeAdapter {
  readonly implementation = Object.freeze({
    kind: "maintained-webauthn-server-library" as const,
    libraryName: "@simplewebauthn/server",
    libraryVersion: "13.3.2",
    reviewReference: "focused-service-test"
  });
  outcome: "verified" | "rejected" = "verified";
  verificationCalls = 0;

  async createDiscoverableLoginOptions(input: {
    readonly expectedChallenge: string;
    readonly expectedRpId: string;
    readonly timeoutMs: number;
    readonly credentialBoundary: { readonly mode: "discoverable_any"; readonly credentialSetRef: null };
  }) {
    return Object.freeze({
      challenge: input.expectedChallenge,
      rpId: input.expectedRpId,
      timeout: input.timeoutMs,
      userVerification: "required" as const
    });
  }

  async verifyDiscoverableLogin(
    _response: unknown,
    expectations: DiscoverableLoginVerificationExpectations
  ) {
    this.verificationCalls += 1;
    expect(expectations.expectedRpId).toBe("auth.luxora.app");
    expect(expectations.expectedOrigin).toBe("https://auth.luxora.app");
    if (this.outcome === "rejected") {
      return Object.freeze({
        status: "rejected" as const,
        reason: "invalid_webauthn_response" as const
      });
    }
    return verifiedCredential();
  }
}

class FakeAccessTokens implements PasskeyLoginAccessTokenAuthority {
  fail = false;
  calls: DeterministicAccessTokenInput[] = [];

  async signDeterministicAccessToken(input: DeterministicAccessTokenInput) {
    this.calls.push(input);
    if (this.fail) throw new Error("test signer unavailable");
    return Object.freeze({
      token: `access.${Buffer.from(JSON.stringify(input)).toString("base64url")}`,
      tokenId: input.tokenId
    });
  }
}

interface Fixture {
  clock: MutableClock;
  store: FakeLoginStore;
  adapter: FakeAdapter;
  access: FakeAccessTokens;
  service: PasskeyLoginService;
}

function fixture(
  nextId: () => string = randomUUID,
  policyOverrides: Partial<PasskeyLoginPolicyOptions> = {}
): Fixture {
  const clock = { milliseconds: NOW_MS };
  const store = new FakeLoginStore();
  const adapter = new FakeAdapter();
  const access = new FakeAccessTokens();
  const bootstrapTokens = new BootstrapTokenSecurity(
    ACCESS_SECRET,
    () => new Date(clock.milliseconds)
  );
  const refreshTokens = new PasskeyBootstrapRefreshTokenSecurity(
    { "login.v1": REFRESH_KEY },
    "login.v1"
  );
  const dependencies: PasskeyLoginServiceDependencies = {
    store: store as unknown as PasskeyLoginServiceDependencies["store"],
    adapter,
    bootstrapTokens,
    refreshTokens,
    accessTokens: access,
    policy: {
      accessTokenTtlSeconds: 900,
      sessionTtlSeconds: 30 * 86_400,
      recoveryGraceSeconds: 300,
      ...policyOverrides
    },
    clock: () => new Date(clock.milliseconds),
    nextId
  };
  return {
    clock,
    store,
    adapter,
    access,
    service: new PasskeyLoginService(dependencies)
  };
}

function beginInput(commandId = COMMAND_ID) {
  return Object.freeze({
    commandId,
    clientNonce: CLIENT_NONCE,
    deliveryNonce: DELIVERY_NONCE
  });
}

async function expectGenericAuthenticationFailure(operation: Promise<unknown>): Promise<void> {
  const thrown = await operation.catch((error: unknown) => error);
  expect(thrown).toBeInstanceOf(AppError);
  expect(thrown).toMatchObject({
    statusCode: 401,
    code: "UNAUTHENTICATED",
    message: "Passkey authentication failed"
  });
}

describe("PasskeyLoginService", () => {
  let current: Fixture;

  beforeEach(() => {
    current = fixture();
  });

  it("commits one identifier-free begin and exactly replays command and clientNonce", async () => {
    const first = await current.service.begin(beginInput());
    const commandReplay = await current.service.begin(beginInput());
    const creationReplay = await current.service.begin(beginInput(OTHER_COMMAND_ID));

    expect(first.replayed).toBe(false);
    expect(commandReplay.replayed).toBe(true);
    expect(creationReplay.replayed).toBe(true);
    expect(commandReplay.ceremony.id).toBe(first.ceremony.id);
    expect(creationReplay.ceremony.id).toBe(first.ceremony.id);
    expect(commandReplay.options).toEqual(first.options);
    expect(commandReplay.bootstrapAuthorization.token)
      .toBe(first.bootstrapAuthorization.token);
    expect(current.store.beginMutations).toHaveLength(1);

    const durable = JSON.stringify(current.store.beginMutations[0]);
    expect(durable).not.toContain(DELIVERY_NONCE);
    expect(durable).not.toContain(first.options.challenge);
    expect(durable).not.toContain(first.bootstrapAuthorization.token);
    expect(current.store.beginMutations[0]?.intent.purpose.type).toBe("session.create");
    expect(current.store.beginMutations[0]?.intent).not.toHaveProperty("accountId");
  });

  it("coarsens verifier rejection and replays the rejection without another verification", async () => {
    current.adapter.outcome = "rejected";
    const begun = await current.service.begin(beginInput());
    const input = Object.freeze({
      commandId: OTHER_COMMAND_ID,
      expectedRevision: begun.ceremony.revision,
      bootstrapToken: begun.bootstrapAuthorization.token,
      response: responseBody()
    });

    await expectGenericAuthenticationFailure(current.service.verify(input));
    await expectGenericAuthenticationFailure(current.service.verify(input));

    expect(current.adapter.verificationCalls).toBe(1);
    expect(current.store.rejectedMutations).toHaveLength(1);
    expect(current.store.verifiedMutations).toHaveLength(0);
    const durable = JSON.stringify(current.store.rejectedMutations[0]);
    expect(durable).not.toContain(begun.bootstrapAuthorization.token);
    expect(durable).not.toContain("exact-http-credential-bytes");
    expect(durable).not.toContain(DELIVERY_NONCE);
  });

  it("atomically commits deterministic bearer state and exactly recovers a lost response", async () => {
    const begun = await current.service.begin(beginInput());
    const input = Object.freeze({
      commandId: OTHER_COMMAND_ID,
      expectedRevision: begun.ceremony.revision,
      bootstrapToken: begun.bootstrapAuthorization.token,
      response: responseBody()
    });
    const first = await current.service.verify(input);
    current.clock.milliseconds += 5_000;
    const replay = await current.service.verify(input);

    expect(first.replayed).toBe(false);
    expect(replay.replayed).toBe(true);
    expect(replay.user.id).toBe(ACCOUNT_ID);
    expect(replay.tokens.accessToken).toBe(first.tokens.accessToken);
    expect(replay.tokens.refreshToken).toBe(first.tokens.refreshToken);
    expect(replay.tokens.sessionId).toBe(first.tokens.sessionId);
    expect(replay.tokens.expiresIn).toBe(first.tokens.expiresIn - 5);
    expect(current.adapter.verificationCalls).toBe(1);
    expect(current.store.verifiedMutations).toHaveLength(1);
    expect(current.store.rejectedMutations).toHaveLength(0);
    expect(current.access.calls).toHaveLength(2);
    expect(current.access.calls[1]).toEqual(current.access.calls[0]);

    const durable = JSON.stringify(current.store.verifiedMutations[0]);
    expect(durable).not.toContain(first.tokens.refreshToken);
    expect(durable).not.toContain(first.tokens.accessToken);
    expect(durable).not.toContain(DELIVERY_NONCE);
    expect(current.store.verifiedMutations[0]?.credential.newSignCount).toBe(0);
  });

  it("returns the authoritative revision when a different verify command loses the CAS", async () => {
    const begun = await current.service.begin(beginInput());
    const originalCommit = current.store.commitVerifiedPasskeyLogin.bind(current.store);
    let arrivals = 0;
    let release!: () => void;
    const commitGate = new Promise<void>((resolve) => { release = resolve; });
    current.store.commitVerifiedPasskeyLogin = async (input) => {
      arrivals += 1;
      if (arrivals === 2) release();
      await commitGate;
      await originalCommit(input);
    };

    const first = current.service.verify(Object.freeze({
      commandId: OTHER_COMMAND_ID,
      expectedRevision: begun.ceremony.revision,
      bootstrapToken: begun.bootstrapAuthorization.token,
      response: responseBody()
    }));
    const second = current.service.verify(Object.freeze({
      commandId: THIRD_COMMAND_ID,
      expectedRevision: begun.ceremony.revision,
      bootstrapToken: begun.bootstrapAuthorization.token,
      response: responseBody()
    }));
    const results = await Promise.allSettled([first, second]);
    const fulfilled = results.filter((result) => result.status === "fulfilled");
    const rejected = results.filter((result) => result.status === "rejected");

    expect(arrivals).toBe(2);
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]).toMatchObject({
      reason: {
        statusCode: 409,
        code: "CONFLICT",
        details: { reason: "ceremony_conflict", state: "consumed", revision: 2 }
      }
    });
    expect(current.store.verifiedMutations).toHaveLength(1);
  });

  it("replays an immediately lost response when post-expiry recovery grace is zero", async () => {
    current = fixture(randomUUID, { recoveryGraceSeconds: 0 });
    const begun = await current.service.begin(beginInput());
    const input = Object.freeze({
      commandId: OTHER_COMMAND_ID,
      expectedRevision: begun.ceremony.revision,
      bootstrapToken: begun.bootstrapAuthorization.token,
      response: responseBody()
    });

    const first = await current.service.verify(input);
    const replay = await current.service.verify(input);

    expect(replay.replayed).toBe(true);
    expect(replay.tokens).toEqual(first.tokens);
    expect(current.adapter.verificationCalls).toBe(1);
    expect(current.store.verifiedMutations).toHaveLength(1);
  });

  it("does not commit a session when deterministic access signing fails", async () => {
    const begun = await current.service.begin(beginInput());
    current.access.fail = true;

    const thrown = await current.service.verify(Object.freeze({
      commandId: OTHER_COMMAND_ID,
      expectedRevision: begun.ceremony.revision,
      bootstrapToken: begun.bootstrapAuthorization.token,
      response: responseBody()
    })).catch((error: unknown) => error);

    expect(thrown).toBeInstanceOf(AppError);
    expect(thrown).toMatchObject({ statusCode: 503, code: "SERVICE_UNAVAILABLE" });
    expect(current.store.verifiedMutations).toHaveLength(0);
    expect(current.store.rejectedMutations).toHaveLength(0);
    expect([...current.store.intents.values()][0]?.state).toBe("pending");
  });

  it("discards a proven-uncommitted challenge when ID generation fails after issue", async () => {
    let calls = 0;
    current = fixture(() => {
      calls += 1;
      if (calls === 2) throw new Error("test ID generator failure");
      return randomUUID();
    });

    const thrown = await current.service.begin(beginInput())
      .catch((error: unknown) => error);

    expect(thrown).toBeInstanceOf(AppError);
    expect(thrown).toMatchObject({ statusCode: 503, code: "SERVICE_UNAVAILABLE" });
    expect(calls).toBe(2);
    expect(current.store.challenges.size).toBe(0);
    expect(current.store.beginMutations).toHaveLength(0);
  });

  it("maps an initial receipt-store failure without issuing a challenge", async () => {
    current.store.failCommandLookup = true;

    const thrown = await current.service.begin(beginInput())
      .catch((error: unknown) => error);

    expect(thrown).toBeInstanceOf(AppError);
    expect(thrown).toMatchObject({ statusCode: 503, code: "SERVICE_UNAVAILABLE" });
    expect(current.store.challenges.size).toBe(0);
    expect(current.store.beginMutations).toHaveLength(0);
  });

  it("atomically expires an authenticated pending intent before WebAuthn verification", async () => {
    const begun = await current.service.begin(beginInput());
    current.clock.milliseconds = Date.parse(begun.ceremony.expiresAt) + 123;
    const input = Object.freeze({
      commandId: OTHER_COMMAND_ID,
      expectedRevision: begun.ceremony.revision,
      bootstrapToken: begun.bootstrapAuthorization.token,
      response: responseBody()
    });

    await expectGenericAuthenticationFailure(current.service.verify(input));
    await expectGenericAuthenticationFailure(current.service.verify(input));

    expect(current.store.terminalMutations).toHaveLength(1);
    expect(current.store.terminalMutations[0]).toMatchObject({
      nextState: "expired",
      expectedRevision: begun.ceremony.revision,
      event: { type: "passkey.login.expired", state: "expired" }
    });
    expect(current.adapter.verificationCalls).toBe(0);
    expect(current.store.challenges.size).toBe(0);
  });

  it("rejects a tampered bootstrap token before any receipt or intent lookup", async () => {
    const begun = await current.service.begin(beginInput());
    const token = begun.bootstrapAuthorization.token;
    const final = token.at(-1);
    const tampered = `${token.slice(0, -1)}${final === "A" ? "B" : "A"}`;
    current.store.resetLookupCounts();

    await expectGenericAuthenticationFailure(current.service.verify(Object.freeze({
      commandId: OTHER_COMMAND_ID,
      expectedRevision: begun.ceremony.revision,
      bootstrapToken: tampered,
      response: responseBody()
    })));

    expect(current.store.commandLookups).toBe(0);
    expect(current.store.creationLookups).toBe(0);
    expect(current.store.intentLookups).toBe(0);
    expect(current.adapter.verificationCalls).toBe(0);
  });
});
