import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { types as utilTypes } from "node:util";

import {
  LUXORA_PASSKEY_PRODUCTION_ORIGIN,
  LUXORA_PASSKEY_RP_ID,
  PASSKEY_CHALLENGE_BYTES,
  StoreCredentialStateConflictError,
  StoreRevisionConflictError,
  type ChallengeSecretVault,
  type DiscoverableLoginVerificationExpectations,
  type MaintainedDiscoverableLoginVerifierAdapter
} from "@luxora/passkey-domain";
import {
  IdSchema,
  PASSKEY_BOOTSTRAP_TOKEN_MAX_BYTES,
  PASSKEY_DEFAULT_TIMEOUT_MS,
  PASSKEY_HTTP_CONTRACT_VERSION,
  PASSKEY_MAX_CREDENTIAL_RESPONSE_BYTES,
  PASSKEY_PRIMARY_AUTHENTICATION_REJECTION_MESSAGE,
  PasskeyDeliveryNonceSchema,
  PasskeyLoginBeginResponseSchema,
  PasskeyLoginVerifyResponseSchema,
  type PasskeyLoginBeginResponse,
  type PasskeyLoginVerifyResponse,
  type User
} from "@luxora/protocol";

import type {
  NewPasskeyLoginIntent,
  PasskeyLoginEventType,
  PersistPasskeyLoginBegin,
  PersistPasskeyLoginRejectedAttempt,
  PersistPasskeyLoginTerminal,
  PersistVerifiedPasskeyLogin,
  Store
} from "../domain/store.js";
import type {
  PasskeyLoginIntentRecord,
  PasskeyLoginReceiptRecord,
  RefreshTokenRecord,
  SessionRecord,
  UserRecord
} from "../domain/types.js";
import { AppError, badRequest, conflict, serviceUnavailable, unauthenticated } from "../errors.js";
import type { ParsedPasskeyResponseBody } from "../http/passkey-response-body.js";
import type {
  BootstrapTokenCommittedReplayInput,
  BootstrapTokenIssueInput,
  BootstrapTokenReplayCandidate,
  VerifiedBootstrapTokenBinding
} from "../passkeys/bootstrap-token.js";
import type {
  DerivedPasskeyBootstrapRefreshToken,
  PasskeyBootstrapRefreshInput
} from "../passkeys/bootstrap-refresh-token.js";
import type {
  DiscoverableLoginOptionsInput,
  SimpleWebAuthnVerifierAdapter
} from "../passkeys/simplewebauthn-adapter.js";
import type { DeterministicAccessTokenInput } from "../security.js";

const LOGIN_PURPOSE = "session.create" as const;
const LOGIN_TOPIC = "luxora.passkey-login.v1" as const;
const LOGIN_TIMEOUT_MS = PASSKEY_DEFAULT_TIMEOUT_MS;
const LOGIN_MAX_ATTEMPTS = 3;
const LOGIN_ALLOWED_ALGORITHMS = Object.freeze([-7, -257] as const);
const LOGIN_DEVICE_NAME = "Passkey login";
const MILLISECONDS_PER_SECOND = 1_000;
const MAX_SESSION_TTL_SECONDS = 365 * 86_400;
const MIN_SESSION_TTL_SECONDS = 86_400;
const MAX_RECOVERY_GRACE_SECONDS = 300;
const MAX_ACCESS_TTL_SECONDS = 3_600;
const MIN_ACCESS_TTL_SECONDS = 60;
const DIGEST_PATTERN = /^[a-f0-9]{64}$/u;
const OPAQUE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/u;
const BASE64URL_32_PATTERN = /^[A-Za-z0-9_-]{43}$/u;

/** The target is intentionally identifier-free and stable across deployments. */
const LOGIN_TARGET_DIGEST = sha256Text(JSON.stringify({
  operation: LOGIN_PURPOSE,
  protocol: "luxora-passkey-login",
  version: 1
}));

type LoginStore = Pick<Store,
  | "commitPasskeyLoginBegin"
  | "commitPasskeyLoginRejectedAttempt"
  | "commitPasskeyLoginTerminal"
  | "commitVerifiedPasskeyLogin"
  | "findPasskeyLoginCommandReceipt"
  | "findPasskeyLoginCreationReceipt"
  | "findPasskeyLoginIntent"
  | "findRefreshToken"
  | "findUserById"
  | "isSessionActive"
> & ChallengeSecretVault;

type LoginOptionsAdapter = MaintainedDiscoverableLoginVerifierAdapter & {
  createDiscoverableLoginOptions(
    input: DiscoverableLoginOptionsInput
  ): ReturnType<SimpleWebAuthnVerifierAdapter["createDiscoverableLoginOptions"]>;
};

export interface PasskeyLoginBootstrapTokenAuthority {
  issue(input: BootstrapTokenIssueInput): Promise<string>;
  verify(token: string, expectedPurpose: typeof LOGIN_PURPOSE): Promise<VerifiedBootstrapTokenBinding>;
  verifyReplayCandidate(
    token: string,
    expectedPurpose: typeof LOGIN_PURPOSE
  ): Promise<BootstrapTokenReplayCandidate>;
  verifyCommittedReplay(
    token: string,
    expectedPurpose: typeof LOGIN_PURPOSE,
    input: BootstrapTokenCommittedReplayInput
  ): Promise<void>;
}

export interface PasskeyLoginRefreshTokenAuthority {
  readonly activeKeyId: string;
  deriveActive(input: PasskeyBootstrapRefreshInput): DerivedPasskeyBootstrapRefreshToken;
  rederive(
    input: PasskeyBootstrapRefreshInput,
    keyId: string
  ): DerivedPasskeyBootstrapRefreshToken;
}

export interface PasskeyLoginAccessTokenAuthority {
  signDeterministicAccessToken(
    input: DeterministicAccessTokenInput
  ): Promise<{ readonly token: string; readonly tokenId: string }>;
}

export interface PasskeyLoginPolicyOptions {
  readonly accessTokenTtlSeconds: number;
  readonly sessionTtlSeconds: number;
  readonly recoveryGraceSeconds: number;
}

export interface PasskeyLoginServiceDependencies {
  readonly store: LoginStore;
  readonly adapter: LoginOptionsAdapter;
  readonly bootstrapTokens: PasskeyLoginBootstrapTokenAuthority;
  readonly refreshTokens: PasskeyLoginRefreshTokenAuthority;
  readonly accessTokens: PasskeyLoginAccessTokenAuthority;
  readonly policy: PasskeyLoginPolicyOptions;
  readonly clock?: () => Date;
  readonly nextId?: () => string;
}

export interface BeginPasskeyLoginServiceInput {
  readonly commandId: string;
  readonly clientNonce: string;
  readonly deliveryNonce: string;
}

export interface VerifyPasskeyLoginServiceInput {
  readonly commandId: string;
  readonly expectedRevision: number;
  readonly bootstrapToken: string;
  readonly response: ParsedPasskeyResponseBody;
}

interface SafeBeginInput {
  readonly commandId: string;
  readonly clientNonce: string;
  readonly deliveryNonce: string;
  readonly deliveryNonceDigest: string;
}

interface SafeVerifyInput {
  readonly commandId: string;
  readonly expectedRevision: number;
  readonly bootstrapToken: string;
  readonly bootstrapTokenDigest: string;
  readonly response: ParsedPasskeyResponseBody;
}

interface BeginScopes {
  readonly commandScope: string;
  readonly commandFingerprint: string;
  readonly creationScope: string;
  readonly creationFingerprint: string;
}

interface VerifiedCredentialSnapshot {
  readonly accountId: string;
  readonly userHandleRef: string;
  readonly credentialRecordId: string;
  readonly credentialRevision: number;
  readonly algorithm: -7 | -257;
  readonly discoveryMode: "discoverable";
  readonly previousSignCount: number;
  readonly newSignCount: number;
  readonly previousBackupEligible: boolean;
  readonly backupEligible: boolean;
  readonly previousBackupState: boolean;
  readonly backupState: boolean;
  readonly userHandleBindingVerified: true;
  readonly userPresent: true;
  readonly userVerified: true;
}

function sha256Text(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function sha256Bytes(value: string): string {
  return createHash("sha256").update(Buffer.from(value, "base64url")).digest("hex");
}

function digestTuple(domain: string, values: readonly (string | number | boolean | null)[]): string {
  return sha256Text(JSON.stringify([domain, ...values]));
}

function safeEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, "utf8");
  const rightBytes = Buffer.from(right, "utf8");
  return leftBytes.byteLength === rightBytes.byteLength && timingSafeEqual(leftBytes, rightBytes);
}

function canonicalUuid(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const parsed = IdSchema.safeParse(value);
  return parsed.success && parsed.data === value;
}

function canonicalDeliveryNonce(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const parsed = PasskeyDeliveryNonceSchema.safeParse(value);
  return parsed.success && parsed.data === value;
}

function isSafeInteger(value: unknown, minimum = 0, maximum = Number.MAX_SAFE_INTEGER): value is number {
  return typeof value === "number"
    && Number.isSafeInteger(value)
    && value >= minimum
    && value <= maximum;
}

function strictPlainDataRecord(
  value: unknown,
  expectedKeys: readonly string[]
): Readonly<Record<string, unknown>> | null {
  try {
    if (
      value === null
      || typeof value !== "object"
      || Array.isArray(value)
      || utilTypes.isProxy(value)
    ) return null;
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return null;
    const keys = Reflect.ownKeys(value);
    if (
      keys.length !== expectedKeys.length
      || keys.some((key) => typeof key !== "string" || !expectedKeys.includes(key))
    ) return null;
    const descriptors = Object.getOwnPropertyDescriptors(value) as Record<string, PropertyDescriptor>;
    for (const key of expectedKeys) {
      const descriptor = descriptors[key];
      if (
        descriptor === undefined
        || descriptor.enumerable !== true
        || !Object.hasOwn(descriptor, "value")
      ) return null;
    }
    return Object.freeze(Object.fromEntries(expectedKeys.map((key) => [key, descriptors[key]?.value])));
  } catch {
    return null;
  }
}

function validOpaqueId(value: unknown): value is string {
  return typeof value === "string" && OPAQUE_ID_PATTERN.test(value);
}

function canonical32ByteBase64url(value: unknown): value is string {
  if (typeof value !== "string" || !BASE64URL_32_PATTERN.test(value)) return false;
  try {
    const bytes = Buffer.from(value, "base64url");
    return bytes.byteLength === 32 && bytes.toString("base64url") === value;
  } catch {
    return false;
  }
}

function snapshotBeginInput(input: BeginPasskeyLoginServiceInput): SafeBeginInput {
  const record = strictPlainDataRecord(input, ["commandId", "clientNonce", "deliveryNonce"]);
  if (
    record === null
    || !canonicalUuid(record["commandId"])
    || !canonicalUuid(record["clientNonce"])
    || !canonicalDeliveryNonce(record["deliveryNonce"])
  ) throw badRequest("Invalid passkey login request");
  return Object.freeze({
    commandId: record["commandId"],
    clientNonce: record["clientNonce"],
    deliveryNonce: record["deliveryNonce"],
    deliveryNonceDigest: sha256Bytes(record["deliveryNonce"])
  });
}

function snapshotResponse(value: unknown): ParsedPasskeyResponseBody | null {
  const record = strictPlainDataRecord(value, ["credential", "byteLength", "digest"]);
  const credential = record?.["credential"];
  if (
    record === null
    || credential === null
    || typeof credential !== "object"
    || Array.isArray(credential)
    || utilTypes.isProxy(credential)
    || !isSafeInteger(record["byteLength"], 1, PASSKEY_MAX_CREDENTIAL_RESPONSE_BYTES)
    || typeof record["digest"] !== "string"
    || !DIGEST_PATTERN.test(record["digest"])
  ) return null;
  return Object.freeze({
    credential: credential as Record<string, unknown>,
    byteLength: record["byteLength"],
    digest: record["digest"]
  });
}

function snapshotVerifyInput(input: VerifyPasskeyLoginServiceInput): SafeVerifyInput {
  const record = strictPlainDataRecord(input, [
    "commandId",
    "expectedRevision",
    "bootstrapToken",
    "response"
  ]);
  const response = record === null ? null : snapshotResponse(record["response"]);
  if (
    record === null
    || !canonicalUuid(record["commandId"])
    || !isSafeInteger(record["expectedRevision"], 1)
    || typeof record["bootstrapToken"] !== "string"
    || record["bootstrapToken"].length < 1
    || Buffer.byteLength(record["bootstrapToken"], "utf8") > PASSKEY_BOOTSTRAP_TOKEN_MAX_BYTES
    || response === null
  ) throw badRequest("Invalid passkey login verification request");
  return Object.freeze({
    commandId: record["commandId"],
    expectedRevision: record["expectedRevision"],
    bootstrapToken: record["bootstrapToken"],
    bootstrapTokenDigest: sha256Text(record["bootstrapToken"]),
    response
  });
}

function validatePolicy(policy: PasskeyLoginPolicyOptions): PasskeyLoginPolicyOptions {
  const record = strictPlainDataRecord(policy, [
    "accessTokenTtlSeconds",
    "sessionTtlSeconds",
    "recoveryGraceSeconds"
  ]);
  if (
    record === null
    || !isSafeInteger(record["accessTokenTtlSeconds"], MIN_ACCESS_TTL_SECONDS, MAX_ACCESS_TTL_SECONDS)
    || !isSafeInteger(record["sessionTtlSeconds"], MIN_SESSION_TTL_SECONDS, MAX_SESSION_TTL_SECONDS)
    || !isSafeInteger(record["recoveryGraceSeconds"], 0, MAX_RECOVERY_GRACE_SECONDS)
    || record["accessTokenTtlSeconds"] < Math.ceil(LOGIN_TIMEOUT_MS / 1_000)
      + 1
      + record["recoveryGraceSeconds"]
  ) throw new Error("invalid passkey login policy");
  return Object.freeze({
    accessTokenTtlSeconds: record["accessTokenTtlSeconds"],
    sessionTtlSeconds: record["sessionTtlSeconds"],
    recoveryGraceSeconds: record["recoveryGraceSeconds"]
  });
}

function beginScopes(input: SafeBeginInput, policy: PasskeyLoginPolicyOptions): BeginScopes {
  const commandScope = digestTuple("luxora/passkey-login/v1/command-scope", ["begin", input.commandId]);
  const creationScope = digestTuple("luxora/passkey-login/v1/creation-scope", [input.clientNonce]);
  const shared = [
    input.clientNonce,
    input.deliveryNonceDigest,
    LOGIN_TARGET_DIGEST,
    policy.accessTokenTtlSeconds,
    policy.sessionTtlSeconds,
    policy.recoveryGraceSeconds,
    LOGIN_TIMEOUT_MS,
    PASSKEY_MAX_CREDENTIAL_RESPONSE_BYTES,
    LOGIN_MAX_ATTEMPTS
  ] as const;
  return Object.freeze({
    commandScope,
    commandFingerprint: digestTuple("luxora/passkey-login/v1/begin-command", [input.commandId, ...shared]),
    creationScope,
    creationFingerprint: digestTuple("luxora/passkey-login/v1/begin-creation", shared)
  });
}

function verifyCommandScope(commandId: string): string {
  return digestTuple("luxora/passkey-login/v1/command-scope", ["verify", commandId]);
}

function verifyFingerprint(
  input: SafeVerifyInput,
  intentId: string
): string {
  return digestTuple("luxora/passkey-login/v1/verify-command", [
    input.commandId,
    intentId,
    input.expectedRevision,
    input.bootstrapTokenDigest,
    input.response.byteLength,
    input.response.digest
  ]);
}

function publicUser(user: UserRecord): User {
  return Object.freeze({
    id: user.id,
    username: user.username,
    displayName: user.displayName,
    bio: user.bio,
    avatarUrl: user.avatarUrl,
    avatarPath: user.avatarPath ?? null,
    createdAt: user.createdAt,
    lastSeenAt: user.lastSeenAt
  });
}

function currentTimeMilliseconds(clock: () => Date): number {
  let date: Date;
  try {
    date = clock();
    const milliseconds = Date.prototype.getTime.call(date);
    if (!isSafeInteger(milliseconds)) throw new Error("invalid clock");
    return milliseconds;
  } catch {
    throw serviceUnavailable("Passkey login is temporarily unavailable");
  }
}

function isoTimestamp(milliseconds: number): string {
  try {
    return new Date(milliseconds).toISOString();
  } catch {
    throw serviceUnavailable("Passkey login is temporarily unavailable");
  }
}

function genericAuthenticationFailure(): AppError {
  return unauthenticated(PASSKEY_PRIMARY_AUTHENTICATION_REJECTION_MESSAGE);
}

function internalRecordFailure(): AppError {
  return new AppError(500, "INTERNAL_ERROR", "Passkey login record is inconsistent");
}

function currentRevisionConflict(
  state: PasskeyLoginIntentRecord["state"],
  revision: number
): AppError {
  if (
    !["pending", "consumed", "cancelled", "expired", "rejected"].includes(state)
    || !isSafeInteger(revision, 1)
  ) throw internalRecordFailure();
  return conflict("Passkey login revision does not match", {
    reason: "ceremony_conflict",
    state,
    revision
  });
}

function mutation(
  nextId: () => string,
  input: {
    readonly intentId: string;
    readonly revision: number;
    readonly state: PasskeyLoginIntentRecord["state"];
    readonly type: PasskeyLoginEventType;
    readonly commandScope: string;
    readonly fingerprint: string;
    readonly occurredAtMs: number;
  }
) {
  const eventId = nextCanonicalId(nextId);
  return Object.freeze({
    event: Object.freeze({
      eventId,
      intentId: input.intentId,
      revision: input.revision,
      type: input.type,
      commandScope: input.commandScope,
      occurredAtMs: input.occurredAtMs,
      state: input.state
    }),
    outbox: Object.freeze({
      outboxId: nextCanonicalId(nextId),
      topic: LOGIN_TOPIC,
      partitionKey: input.intentId,
      eventId,
      availableAtMs: input.occurredAtMs
    }),
    commandReceipt: Object.freeze({
      scope: input.commandScope,
      fingerprint: input.fingerprint,
      intentId: input.intentId,
      resultRevision: input.revision,
      resultState: input.state,
      eventId,
      createdAtMs: input.occurredAtMs
    })
  });
}

function nextCanonicalId(nextId: () => string): string {
  let value: unknown;
  try {
    value = nextId();
  } catch {
    throw serviceUnavailable("Passkey login is temporarily unavailable");
  }
  if (!canonicalUuid(value)) throw serviceUnavailable("Passkey login is temporarily unavailable");
  return value;
}

function validateReceipt(
  receipt: PasskeyLoginReceiptRecord,
  expectedScope: string
): PasskeyLoginReceiptRecord {
  if (
    receipt === null
    || typeof receipt !== "object"
    || receipt.scope !== expectedScope
    || !DIGEST_PATTERN.test(receipt.scope)
    || !DIGEST_PATTERN.test(receipt.fingerprint)
    || !canonicalUuid(receipt.intentId)
    || !isSafeInteger(receipt.resultRevision, 1)
    || !["pending", "consumed", "cancelled", "expired", "rejected"].includes(receipt.resultState)
    || !validOpaqueId(receipt.eventId)
    || !isSafeInteger(receipt.createdAtMs)
  ) throw internalRecordFailure();
  return receipt;
}

function validateIntentPolicy(intent: PasskeyLoginIntentRecord): void {
  if (
    !canonicalUuid(intent.intentId)
    || intent.schemaVersion !== 1
    || intent.purpose.type !== LOGIN_PURPOSE
    || intent.purpose.targetDigest !== LOGIN_TARGET_DIGEST
    || intent.policyVersion !== 1
    || !isSafeInteger(intent.accessTokenTtlSeconds, MIN_ACCESS_TTL_SECONDS, MAX_ACCESS_TTL_SECONDS)
    || !isSafeInteger(intent.sessionTtlSeconds, MIN_SESSION_TTL_SECONDS, MAX_SESSION_TTL_SECONDS)
    || !isSafeInteger(intent.recoveryGraceSeconds, 0, MAX_RECOVERY_GRACE_SECONDS)
    || intent.expectedRpId !== LUXORA_PASSKEY_RP_ID
    || intent.expectedOrigin !== LUXORA_PASSKEY_PRODUCTION_ORIGIN
    || intent.timeoutMs !== LOGIN_TIMEOUT_MS
    || intent.maxResponseBytes !== PASSKEY_MAX_CREDENTIAL_RESPONSE_BYTES
    || intent.maxAttempts !== LOGIN_MAX_ATTEMPTS
    || !Array.isArray(intent.allowedAlgorithms)
    || intent.allowedAlgorithms.length !== 2
    || intent.allowedAlgorithms[0] !== -7
    || intent.allowedAlgorithms[1] !== -257
    || intent.userVerification !== "required"
    || intent.crossOriginAllowed !== false
    || intent.credentialBoundary.mode !== "discoverable_any"
    || intent.credentialBoundary.credentialSetRef !== null
    || !validOpaqueId(intent.challenge.reference)
    || !DIGEST_PATTERN.test(intent.challenge.digest)
    || !DIGEST_PATTERN.test(intent.deliveryNonceDigest)
    || !validOpaqueId(intent.refreshDerivationKeyId)
    || !isSafeInteger(intent.revision, 1)
    || !isSafeInteger(intent.attemptsUsed, 0, intent.maxAttempts)
    || !isSafeInteger(intent.createdAtMs)
    || intent.expiresAtMs !== intent.createdAtMs + intent.timeoutMs
    || !isSafeInteger(intent.updatedAtMs, intent.createdAtMs)
    || intent.updatedAtMs > (intent.terminalAtMs ?? intent.expiresAtMs)
  ) throw internalRecordFailure();
}

function validateTokenBinding(
  binding: BootstrapTokenReplayCandidate,
  intent: PasskeyLoginIntentRecord
): void {
  const issuedAt = Math.floor(intent.createdAtMs / MILLISECONDS_PER_SECOND);
  const expiresAt = Math.floor(intent.expiresAtMs / MILLISECONDS_PER_SECOND);
  if (
    binding.intentId !== intent.intentId
    || binding.purpose !== LOGIN_PURPOSE
    || binding.targetDigest !== intent.purpose.targetDigest
    || !canonicalDeliveryNonce(binding.deliveryNonce)
    || !safeEqual(sha256Bytes(binding.deliveryNonce), intent.deliveryNonceDigest)
    || binding.issuedAt !== issuedAt
    || binding.expiresAt !== expiresAt
  ) throw genericAuthenticationFailure();
}

function validateChallenge(challenge: unknown, expectedDigest: string): challenge is string {
  return canonical32ByteBase64url(challenge)
    && safeEqual(sha256Bytes(challenge), expectedDigest);
}

function isExactVerifierRejection(value: unknown): boolean {
  const record = strictPlainDataRecord(value, ["status", "reason"]);
  return record !== null
    && record["status"] === "rejected"
    && record["reason"] === "invalid_webauthn_response";
}

function snapshotVerifiedCredential(result: unknown): VerifiedCredentialSnapshot {
  const top = strictPlainDataRecord(result, [
    "status",
    "kind",
    "purpose",
    "credentialBoundary",
    "account",
    "credential"
  ]);
  const account = strictPlainDataRecord(top?.["account"], [
    "accountId",
    "userHandleRef",
    "userHandleBindingVerified"
  ]);
  const credential = strictPlainDataRecord(top?.["credential"], [
    "credentialRecordId",
    "credentialRevision",
    "algorithm",
    "discoveryMode",
    "previousSignCount",
    "newSignCount",
    "previousBackupEligible",
    "backupEligible",
    "previousBackupState",
    "backupState",
    "userPresent",
    "userVerified"
  ]);
  if (
    top === null
    || top["status"] !== "verified"
    || top["kind"] !== "authentication"
    || top["purpose"] !== LOGIN_PURPOSE
    || top["credentialBoundary"] !== "discoverable_any"
    || account === null
    || credential === null
    || !canonicalUuid(account["accountId"])
    || !validOpaqueId(account["userHandleRef"])
    || account["userHandleBindingVerified"] !== true
    || !validOpaqueId(credential["credentialRecordId"])
    || !isSafeInteger(credential["credentialRevision"], 1)
    || (credential["algorithm"] !== -7 && credential["algorithm"] !== -257)
    || credential["discoveryMode"] !== "discoverable"
    || !isSafeInteger(credential["previousSignCount"], 0, 0xffff_ffff)
    || !isSafeInteger(credential["newSignCount"], 0, 0xffff_ffff)
    || typeof credential["previousBackupEligible"] !== "boolean"
    || typeof credential["backupEligible"] !== "boolean"
    || credential["previousBackupEligible"] !== credential["backupEligible"]
    || typeof credential["previousBackupState"] !== "boolean"
    || typeof credential["backupState"] !== "boolean"
    || (credential["backupEligible"] === false
      && (credential["previousBackupState"] || credential["backupState"]))
    || credential["userPresent"] !== true
    || credential["userVerified"] !== true
  ) throw serviceUnavailable("Passkey verification is temporarily unavailable");
  return Object.freeze({
    accountId: account["accountId"],
    userHandleRef: account["userHandleRef"],
    credentialRecordId: credential["credentialRecordId"],
    credentialRevision: credential["credentialRevision"],
    algorithm: credential["algorithm"],
    discoveryMode: "discoverable",
    previousSignCount: credential["previousSignCount"],
    newSignCount: credential["newSignCount"],
    previousBackupEligible: credential["previousBackupEligible"],
    backupEligible: credential["backupEligible"],
    previousBackupState: credential["previousBackupState"],
    backupState: credential["backupState"],
    userHandleBindingVerified: true,
    userPresent: true,
    userVerified: true
  });
}

function beginResponse(
  intent: PasskeyLoginIntentRecord | NewPasskeyLoginIntent,
  bootstrapToken: string,
  options: Awaited<ReturnType<LoginOptionsAdapter["createDiscoverableLoginOptions"]>>,
  replayed: boolean
): PasskeyLoginBeginResponse {
  try {
    return PasskeyLoginBeginResponseSchema.parse({
      schemaVersion: PASSKEY_HTTP_CONTRACT_VERSION,
      replayed,
      ceremony: {
        id: intent.intentId,
        kind: "authentication",
        purpose: LOGIN_PURPOSE,
        state: "pending",
        revision: intent.revision,
        expiresAt: isoTimestamp(intent.expiresAtMs)
      },
      bootstrapAuthorization: {
        scheme: "Bearer",
        token: bootstrapToken,
        purpose: LOGIN_PURPOSE,
        expiresAt: isoTimestamp(intent.expiresAtMs)
      },
      options
    });
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw internalRecordFailure();
  }
}

function verifyResponse(
  intent: PasskeyLoginIntentRecord,
  user: UserRecord,
  accessToken: string,
  refreshToken: string,
  expiresIn: number,
  replayed: boolean
): PasskeyLoginVerifyResponse {
  const resolution = intent.resolution;
  if (resolution === null) throw internalRecordFailure();
  try {
    return PasskeyLoginVerifyResponseSchema.parse({
      schemaVersion: PASSKEY_HTTP_CONTRACT_VERSION,
      verified: true,
      replayed,
      ceremony: {
        id: intent.intentId,
        kind: "authentication",
        purpose: LOGIN_PURPOSE,
        state: "consumed",
        revision: intent.revision,
        expiresAt: isoTimestamp(intent.expiresAtMs)
      },
      user: publicUser(user),
      tokens: {
        accessToken,
        refreshToken,
        tokenType: "Bearer",
        expiresIn,
        sessionId: resolution.sessionId
      }
    });
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw internalRecordFailure();
  }
}

/**
 * Username-free passkey session bootstrap. Raw delivery nonces, assertions and
 * bearer tokens remain in this orchestration boundary and are never projected
 * into Store mutations or receipts.
 */
export class PasskeyLoginService {
  readonly #store: LoginStore;
  readonly #adapter: LoginOptionsAdapter;
  readonly #bootstrapTokens: PasskeyLoginBootstrapTokenAuthority;
  readonly #refreshTokens: PasskeyLoginRefreshTokenAuthority;
  readonly #accessTokens: PasskeyLoginAccessTokenAuthority;
  readonly #policy: PasskeyLoginPolicyOptions;
  readonly #clock: () => Date;
  readonly #nextId: () => string;

  constructor(dependencies: PasskeyLoginServiceDependencies) {
    this.#store = dependencies.store;
    this.#adapter = dependencies.adapter;
    this.#bootstrapTokens = dependencies.bootstrapTokens;
    this.#refreshTokens = dependencies.refreshTokens;
    this.#accessTokens = dependencies.accessTokens;
    this.#policy = validatePolicy(dependencies.policy);
    this.#clock = dependencies.clock ?? (() => new Date());
    this.#nextId = dependencies.nextId ?? randomUUID;
  }

  async begin(input: BeginPasskeyLoginServiceInput): Promise<PasskeyLoginBeginResponse> {
    const safe = snapshotBeginInput(input);
    const scopes = beginScopes(safe, this.#policy);

    let priorCommand: PasskeyLoginReceiptRecord | null;
    try {
      priorCommand = await this.#store.findPasskeyLoginCommandReceipt(scopes.commandScope);
    } catch {
      throw serviceUnavailable("Passkey login is temporarily unavailable");
    }
    if (priorCommand !== null) {
      const receipt = validateReceipt(priorCommand, scopes.commandScope);
      if (!safeEqual(receipt.fingerprint, scopes.commandFingerprint)) {
        throw conflict("Passkey login command was already used");
      }
      return this.#replayBegin(receipt, safe.deliveryNonce);
    }

    let priorCreation: PasskeyLoginReceiptRecord | null;
    try {
      priorCreation = await this.#store.findPasskeyLoginCreationReceipt(scopes.creationScope);
    } catch {
      throw serviceUnavailable("Passkey login is temporarily unavailable");
    }
    if (priorCreation !== null) {
      const receipt = validateReceipt(priorCreation, scopes.creationScope);
      if (!safeEqual(receipt.fingerprint, scopes.creationFingerprint)) {
        throw conflict("Passkey login client nonce was already used");
      }
      return this.#replayBegin(receipt, safe.deliveryNonce);
    }

    const createdAtMs = currentTimeMilliseconds(this.#clock);
    if (createdAtMs > Number.MAX_SAFE_INTEGER - LOGIN_TIMEOUT_MS) {
      throw serviceUnavailable("Passkey login is temporarily unavailable");
    }
    const expiresAtMs = createdAtMs + LOGIN_TIMEOUT_MS;
    let issued: Awaited<ReturnType<ChallengeSecretVault["issue"]>>;
    try {
      issued = await this.#store.issue({
        byteLength: PASSKEY_CHALLENGE_BYTES,
        expiresAtMs
      });
    } catch {
      throw serviceUnavailable("Passkey login is temporarily unavailable");
    }

    let challengeDigest: string;
    try {
      if (
        !validOpaqueId(issued.reference)
        || issued.reference.includes(issued.challenge)
        || !canonical32ByteBase64url(issued.challenge)
      ) throw new Error("invalid challenge lease");
      challengeDigest = sha256Bytes(issued.challenge);
    } catch {
      await this.#discardBestEffort(issued.reference);
      throw serviceUnavailable("Passkey login is temporarily unavailable");
    }

    let intent: NewPasskeyLoginIntent;
    try {
      const intentId = nextCanonicalId(this.#nextId);
      intent = Object.freeze({
        intentId,
        schemaVersion: 1 as const,
        purpose: Object.freeze({ type: LOGIN_PURPOSE, targetDigest: LOGIN_TARGET_DIGEST }),
        policyVersion: 1 as const,
        accessTokenTtlSeconds: this.#policy.accessTokenTtlSeconds,
        sessionTtlSeconds: this.#policy.sessionTtlSeconds,
        recoveryGraceSeconds: this.#policy.recoveryGraceSeconds,
        expectedRpId: LUXORA_PASSKEY_RP_ID,
        expectedOrigin: LUXORA_PASSKEY_PRODUCTION_ORIGIN,
        timeoutMs: LOGIN_TIMEOUT_MS,
        maxResponseBytes: PASSKEY_MAX_CREDENTIAL_RESPONSE_BYTES,
        maxAttempts: LOGIN_MAX_ATTEMPTS,
        allowedAlgorithms: LOGIN_ALLOWED_ALGORITHMS,
        userVerification: "required" as const,
        crossOriginAllowed: false as const,
        credentialBoundary: Object.freeze({ mode: "discoverable_any" as const, credentialSetRef: null }),
        challenge: Object.freeze({ reference: issued.reference, digest: challengeDigest }),
        deliveryNonceDigest: safe.deliveryNonceDigest,
        refreshDerivationKeyId: this.#refreshTokens.activeKeyId,
        state: "pending" as const,
        revision: 1 as const,
        attemptsUsed: 0 as const,
        createdAtMs,
        expiresAtMs,
        updatedAtMs: createdAtMs,
        terminalAtMs: null,
        terminalReason: null
      }) satisfies NewPasskeyLoginIntent;
    } catch {
      await this.#discardBestEffort(issued.reference);
      throw serviceUnavailable("Passkey login is temporarily unavailable");
    }

    let options: Awaited<ReturnType<LoginOptionsAdapter["createDiscoverableLoginOptions"]>>;
    let bootstrapToken: string;
    try {
      [options, bootstrapToken] = await Promise.all([
        this.#adapter.createDiscoverableLoginOptions({
          expectedChallenge: issued.challenge,
          expectedRpId: intent.expectedRpId,
          timeoutMs: intent.timeoutMs,
          credentialBoundary: intent.credentialBoundary
        }),
        this.#bootstrapTokens.issue(this.#bootstrapIssueInput(intent, safe.deliveryNonce))
      ]);
    } catch {
      await this.#discardBestEffort(intent.challenge.reference);
      throw serviceUnavailable("Passkey login is temporarily unavailable");
    }

    let persist: PersistPasskeyLoginBegin;
    try {
      const started = mutation(this.#nextId, {
        intentId: intent.intentId,
        revision: 1,
        state: "pending",
        type: "passkey.login.started",
        commandScope: scopes.commandScope,
        fingerprint: scopes.commandFingerprint,
        occurredAtMs: createdAtMs
      });
      persist = Object.freeze({
        intent,
        ...started,
        creationReceipt: Object.freeze({
          scope: scopes.creationScope,
          fingerprint: scopes.creationFingerprint,
          intentId: intent.intentId,
          resultRevision: 1,
          resultState: "pending" as const,
          eventId: started.event.eventId,
          createdAtMs
        })
      }) satisfies PersistPasskeyLoginBegin;
    } catch {
      await this.#discardBestEffort(intent.challenge.reference);
      throw serviceUnavailable("Passkey login is temporarily unavailable");
    }

    try {
      await this.#store.commitPasskeyLoginBegin(persist);
    } catch {
      const reconciled = await this.#reconcileBeginCommit(
        scopes,
        intent.challenge.reference,
        safe.deliveryNonce
      );
      if (reconciled !== null) return reconciled;
      // Reconciliation itself discards only after authoritative receipt reads
      // prove no commit. An error class alone is not proof after an ambiguous
      // driver/network failure, so the TTL-bounded lease remains otherwise.
      throw serviceUnavailable("Passkey login is temporarily unavailable");
    }
    return beginResponse(intent, bootstrapToken, options, false);
  }

  async verify(input: VerifyPasskeyLoginServiceInput): Promise<PasskeyLoginVerifyResponse> {
    const safe = snapshotVerifyInput(input);

    // No receipt, intent, credential or account lookup is permitted before the
    // complete compact token has cryptographically authenticated.
    let candidate: BootstrapTokenReplayCandidate;
    try {
      candidate = await this.#bootstrapTokens.verifyReplayCandidate(
        safe.bootstrapToken,
        LOGIN_PURPOSE
      );
    } catch {
      throw genericAuthenticationFailure();
    }

    const commandScope = verifyCommandScope(safe.commandId);
    let priorReceipt: PasskeyLoginReceiptRecord | null;
    try {
      priorReceipt = await this.#store.findPasskeyLoginCommandReceipt(commandScope);
    } catch {
      throw serviceUnavailable("Passkey login is temporarily unavailable");
    }
    if (priorReceipt !== null) {
      const receipt = validateReceipt(priorReceipt, commandScope);
      if (receipt.intentId !== candidate.intentId) throw genericAuthenticationFailure();
      if (receipt.resultRevision !== safe.expectedRevision + 1) {
        let current: PasskeyLoginIntentRecord | null;
        try {
          current = await this.#store.findPasskeyLoginIntent(receipt.intentId);
        } catch {
          throw serviceUnavailable("Passkey login is temporarily unavailable");
        }
        if (current === null) throw genericAuthenticationFailure();
        validateIntentPolicy(current);
        validateTokenBinding(candidate, current);
        throw currentRevisionConflict(current.state, current.revision);
      }
      const fingerprint = verifyFingerprint(safe, receipt.intentId);
      if (!safeEqual(receipt.fingerprint, fingerprint)) {
        throw conflict("Passkey login command was already used");
      }
      if (receipt.resultState !== "consumed") throw genericAuthenticationFailure();
      let committed: PasskeyLoginIntentRecord | null;
      try {
        committed = await this.#store.findPasskeyLoginIntent(receipt.intentId);
      } catch {
        throw serviceUnavailable("Passkey login is temporarily unavailable");
      }
      if (committed === null) throw genericAuthenticationFailure();
      return this.#replayCommitted(safe, candidate, receipt, committed);
    }

    let intent: PasskeyLoginIntentRecord | null;
    try {
      intent = await this.#store.findPasskeyLoginIntent(candidate.intentId);
    } catch {
      throw serviceUnavailable("Passkey login is temporarily unavailable");
    }
    if (intent === null) throw genericAuthenticationFailure();
    validateIntentPolicy(intent);
    validateTokenBinding(candidate, intent);
    if (intent.state !== "pending") {
      throw currentRevisionConflict(intent.state, intent.revision);
    }
    if (safe.expectedRevision !== intent.revision) {
      throw currentRevisionConflict(intent.state, intent.revision);
    }

    const fingerprint = verifyFingerprint(safe, intent.intentId);
    const nowBeforeChallenge = currentTimeMilliseconds(this.#clock);
    if (nowBeforeChallenge >= intent.expiresAtMs) {
      await this.#commitExpired(intent, commandScope, fingerprint, nowBeforeChallenge);
      throw genericAuthenticationFailure();
    }
    if (nowBeforeChallenge < intent.updatedAtMs) throw genericAuthenticationFailure();
    try {
      const activeBinding = await this.#bootstrapTokens.verify(
        safe.bootstrapToken,
        LOGIN_PURPOSE
      );
      validateTokenBinding(activeBinding, intent);
    } catch {
      throw genericAuthenticationFailure();
    }
    let challenge: string | null;
    try {
      challenge = await this.#store.resolve(intent.challenge.reference);
    } catch {
      throw serviceUnavailable("Passkey login is temporarily unavailable");
    }
    if (!validateChallenge(challenge, intent.challenge.digest)) {
      throw genericAuthenticationFailure();
    }

    let verification: Awaited<ReturnType<MaintainedDiscoverableLoginVerifierAdapter["verifyDiscoverableLogin"]>>;
    try {
      const expectations: DiscoverableLoginVerificationExpectations = Object.freeze({
        kind: "authentication",
        expectedChallenge: challenge,
        expectedRpId: intent.expectedRpId,
        expectedOrigin: intent.expectedOrigin,
        expectedTopOrigins: Object.freeze([] as const),
        crossOriginAllowed: false,
        requireUserPresence: true,
        requireUserVerification: true,
        allowedAlgorithms: Object.freeze([...intent.allowedAlgorithms]),
        credentialBoundary: Object.freeze({ mode: "discoverable_any", credentialSetRef: null }),
        purpose: Object.freeze({ type: LOGIN_PURPOSE, targetDigest: intent.purpose.targetDigest }),
        maxResponseBytes: intent.maxResponseBytes,
        responseByteLength: safe.response.byteLength
      });
      verification = await this.#adapter.verifyDiscoverableLogin(
        safe.response.credential,
        expectations
      );
    } catch {
      throw serviceUnavailable("Passkey verification is temporarily unavailable");
    }

    const verifiedAtMs = currentTimeMilliseconds(this.#clock);
    if (verifiedAtMs >= intent.expiresAtMs) {
      await this.#commitExpired(intent, commandScope, fingerprint, verifiedAtMs);
      throw genericAuthenticationFailure();
    }

    if (isExactVerifierRejection(verification)) {
      await this.#commitRejectedAttempt(intent, commandScope, fingerprint, verifiedAtMs);
      throw genericAuthenticationFailure();
    }

    const credential = snapshotVerifiedCredential(verification);
    let user: UserRecord | null;
    try {
      user = this.#store.findUserById(credential.accountId);
    } catch {
      throw serviceUnavailable("Passkey login is temporarily unavailable");
    }
    if (user === null) {
      await this.#commitRejectedAttempt(intent, commandScope, fingerprint, verifiedAtMs);
      throw genericAuthenticationFailure();
    }

    const committedAtMs = currentTimeMilliseconds(this.#clock);
    if (committedAtMs >= intent.expiresAtMs) {
      await this.#commitExpired(intent, commandScope, fingerprint, committedAtMs);
      throw genericAuthenticationFailure();
    }
    if (committedAtMs < intent.updatedAtMs) throw genericAuthenticationFailure();
    const sessionId = nextCanonicalId(this.#nextId);
    const refreshTokenId = nextCanonicalId(this.#nextId);
    const createdAt = isoTimestamp(committedAtMs);
    const sessionExpiresAtMs = committedAtMs + intent.sessionTtlSeconds * MILLISECONDS_PER_SECOND;
    if (!isSafeInteger(sessionExpiresAtMs, committedAtMs + 1)) {
      throw serviceUnavailable("Passkey login is temporarily unavailable");
    }
    const expiresAt = isoTimestamp(sessionExpiresAtMs);
    const issuedAtSec = Math.floor(committedAtMs / MILLISECONDS_PER_SECOND);
    const expiresAtSec = issuedAtSec + intent.accessTokenTtlSeconds;
    const refreshInput = Object.freeze({
      intentId: intent.intentId,
      accountId: credential.accountId,
      sessionId,
      deliveryNonce: candidate.deliveryNonce
    });
    let refresh: DerivedPasskeyBootstrapRefreshToken;
    let access: { readonly token: string; readonly tokenId: string };
    try {
      refresh = this.#refreshTokens.deriveActive(refreshInput);
      access = await this.#accessTokens.signDeterministicAccessToken({
        userId: credential.accountId,
        sessionId,
        tokenId: intent.intentId,
        issuedAtSec,
        expiresAtSec
      });
    } catch {
      throw serviceUnavailable("Passkey login is temporarily unavailable");
    }
    if (
      access.tokenId !== intent.intentId
      || refresh.keyId !== intent.refreshDerivationKeyId
      || !safeEqual(refresh.deliveryNonceDigest, intent.deliveryNonceDigest)
    ) throw serviceUnavailable("Passkey login is temporarily unavailable");

    const consumed = mutation(this.#nextId, {
      intentId: intent.intentId,
      revision: intent.revision + 1,
      state: "consumed",
      type: "passkey.login.consumed",
      commandScope,
      fingerprint,
      occurredAtMs: committedAtMs
    });
    const persist = Object.freeze({
      intentId: intent.intentId,
      expectedRevision: intent.revision,
      committedAtMs,
      credential,
      session: Object.freeze({
        id: sessionId,
        userId: credential.accountId,
        deviceName: LOGIN_DEVICE_NAME,
        createdAt,
        expiresAt
      }),
      refreshToken: Object.freeze({
        id: refreshTokenId,
        sessionId,
        tokenHash: refresh.hash,
        createdAt,
        expiresAt,
        derivationKeyId: refresh.keyId,
        deliveryNonceDigest: refresh.deliveryNonceDigest
      }),
      accessToken: Object.freeze({
        tokenId: intent.intentId,
        issuedAtSec,
        expiresAtSec
      }),
      ...consumed
    }) satisfies PersistVerifiedPasskeyLogin;

    try {
      await this.#store.commitVerifiedPasskeyLogin(persist);
    } catch (error) {
      let receipt: PasskeyLoginReceiptRecord | null;
      try {
        receipt = await this.#store.findPasskeyLoginCommandReceipt(commandScope);
      } catch {
        throw serviceUnavailable("Passkey login is temporarily unavailable");
      }
      if (receipt !== null) {
        const authoritative = validateReceipt(receipt, commandScope);
        if (
          authoritative.intentId === intent.intentId
          && authoritative.resultState === "consumed"
          && safeEqual(authoritative.fingerprint, fingerprint)
        ) {
          let committed: PasskeyLoginIntentRecord | null;
          try {
            committed = await this.#store.findPasskeyLoginIntent(intent.intentId);
          } catch {
            throw serviceUnavailable("Passkey login is temporarily unavailable");
          }
          if (committed !== null) {
            return this.#replayCommitted(safe, candidate, authoritative, committed);
          }
        }
      }
      if (error instanceof StoreCredentialStateConflictError || error instanceof StoreRevisionConflictError) {
        let current: PasskeyLoginIntentRecord | null;
        try {
          current = await this.#store.findPasskeyLoginIntent(intent.intentId);
        } catch {
          throw serviceUnavailable("Passkey login is temporarily unavailable");
        }
        if (current === null) throw genericAuthenticationFailure();
        validateIntentPolicy(current);
        validateTokenBinding(candidate, current);
        throw currentRevisionConflict(current.state, current.revision);
      }
      throw serviceUnavailable("Passkey login is temporarily unavailable");
    }

    let committed: PasskeyLoginIntentRecord | null;
    try {
      committed = await this.#store.findPasskeyLoginIntent(intent.intentId);
    } catch {
      throw serviceUnavailable("Passkey login is temporarily unavailable");
    }
    if (committed === null || committed.state !== "consumed") throw internalRecordFailure();
    validateIntentPolicy(committed);
    return verifyResponse(
      committed,
      user,
      access.token,
      refresh.raw,
      intent.accessTokenTtlSeconds,
      false
    );
  }

  #bootstrapIssueInput(
    intent: PasskeyLoginIntentRecord | NewPasskeyLoginIntent,
    deliveryNonce: string
  ): BootstrapTokenIssueInput {
    return Object.freeze({
      intentId: intent.intentId,
      purpose: LOGIN_PURPOSE,
      targetDigest: intent.purpose.targetDigest,
      deliveryNonce,
      issuedAt: Math.floor(intent.createdAtMs / MILLISECONDS_PER_SECOND),
      expiresAt: Math.floor(intent.expiresAtMs / MILLISECONDS_PER_SECOND)
    });
  }

  async #replayBegin(
    receipt: PasskeyLoginReceiptRecord,
    deliveryNonce: string
  ): Promise<PasskeyLoginBeginResponse> {
    if (receipt.resultState !== "pending" || receipt.resultRevision !== 1) {
      throw conflict("Passkey login is no longer pending");
    }
    let intent: PasskeyLoginIntentRecord | null;
    try {
      intent = await this.#store.findPasskeyLoginIntent(receipt.intentId);
    } catch {
      throw serviceUnavailable("Passkey login is temporarily unavailable");
    }
    if (intent === null) throw internalRecordFailure();
    validateIntentPolicy(intent);
    if (
      intent.state !== "pending"
      || intent.revision !== receipt.resultRevision
      || !safeEqual(sha256Bytes(deliveryNonce), intent.deliveryNonceDigest)
      || currentTimeMilliseconds(this.#clock) >= intent.expiresAtMs
    ) throw conflict("Passkey login is no longer pending");
    let challenge: string | null;
    try {
      challenge = await this.#store.resolve(intent.challenge.reference);
    } catch {
      throw serviceUnavailable("Passkey login is temporarily unavailable");
    }
    if (!validateChallenge(challenge, intent.challenge.digest)) {
      throw serviceUnavailable("Passkey login is temporarily unavailable");
    }
    try {
      const [options, bootstrapToken] = await Promise.all([
        this.#adapter.createDiscoverableLoginOptions({
          expectedChallenge: challenge,
          expectedRpId: intent.expectedRpId,
          timeoutMs: intent.timeoutMs,
          credentialBoundary: intent.credentialBoundary
        }),
        this.#bootstrapTokens.issue(this.#bootstrapIssueInput(intent, deliveryNonce))
      ]);
      return beginResponse(intent, bootstrapToken, options, true);
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw serviceUnavailable("Passkey login is temporarily unavailable");
    }
  }

  async #reconcileBeginCommit(
    scopes: BeginScopes,
    issuedChallengeReference: string,
    deliveryNonce: string
  ): Promise<PasskeyLoginBeginResponse | null> {
    let command: PasskeyLoginReceiptRecord | null;
    let creation: PasskeyLoginReceiptRecord | null;
    try {
      [command, creation] = await Promise.all([
        this.#store.findPasskeyLoginCommandReceipt(scopes.commandScope),
        this.#store.findPasskeyLoginCreationReceipt(scopes.creationScope)
      ]);
    } catch {
      // The outcome is not authoritative, so the TTL-bound secret must remain.
      return null;
    }
    const winner = command === null ? creation : command;
    if (winner === null) {
      // Both authoritative reads proved that this challenge did not commit.
      await this.#discardBestEffort(issuedChallengeReference);
      return null;
    }
    const expectedScope = command === null ? scopes.creationScope : scopes.commandScope;
    const expectedFingerprint = command === null
      ? scopes.creationFingerprint
      : scopes.commandFingerprint;
    const receipt = validateReceipt(winner, expectedScope);
    if (!safeEqual(receipt.fingerprint, expectedFingerprint)) {
      await this.#discardBestEffort(issuedChallengeReference);
      throw conflict("Passkey login idempotency key was already used");
    }
    const committedIntent = await this.#store.findPasskeyLoginIntent(receipt.intentId);
    if (committedIntent === null) throw internalRecordFailure();
    if (committedIntent.challenge.reference !== issuedChallengeReference) {
      await this.#discardBestEffort(issuedChallengeReference);
    }
    return this.#replayBegin(receipt, deliveryNonce);
  }

  async #commitRejectedAttempt(
    intent: PasskeyLoginIntentRecord,
    commandScope: string,
    fingerprint: string,
    observedAtMs: number
  ): Promise<void> {
    const updatedAtMs = Math.max(observedAtMs, currentTimeMilliseconds(this.#clock));
    if (updatedAtMs >= intent.expiresAtMs) {
      await this.#commitExpired(intent, commandScope, fingerprint, updatedAtMs);
      return;
    }
    if (updatedAtMs < intent.updatedAtMs || updatedAtMs >= intent.expiresAtMs) return;
    const nextState = intent.attemptsUsed + 1 >= intent.maxAttempts ? "rejected" : "pending";
    const rejected = mutation(this.#nextId, {
      intentId: intent.intentId,
      revision: intent.revision + 1,
      state: nextState,
      type: nextState === "rejected"
        ? "passkey.login.attempts_exhausted"
        : "passkey.login.verification_rejected",
      commandScope,
      fingerprint,
      occurredAtMs: updatedAtMs
    });
    const persist = Object.freeze({
      intentId: intent.intentId,
      expectedRevision: intent.revision,
      updatedAtMs,
      nextState,
      ...rejected
    }) satisfies PersistPasskeyLoginRejectedAttempt;
    try {
      await this.#store.commitPasskeyLoginRejectedAttempt(persist);
    } catch {
      // Reconcile only to avoid retrying a command whose rejection committed;
      // every externally visible outcome remains the same generic 401.
      try {
        const receipt = await this.#store.findPasskeyLoginCommandReceipt(commandScope);
        if (receipt !== null) {
          const authoritative = validateReceipt(receipt, commandScope);
          if (safeEqual(authoritative.fingerprint, fingerprint)) return;
        }
      } catch {
        // Deliberately coarsened below.
      }
    }
  }

  async #commitExpired(
    intent: PasskeyLoginIntentRecord,
    commandScope: string,
    fingerprint: string,
    observedAtMs: number
  ): Promise<void> {
    if (intent.state !== "pending" || observedAtMs < intent.expiresAtMs) return;
    const expired = mutation(this.#nextId, {
      intentId: intent.intentId,
      revision: intent.revision + 1,
      state: "expired",
      type: "passkey.login.expired",
      commandScope,
      fingerprint,
      occurredAtMs: observedAtMs
    });
    const persist = Object.freeze({
      intentId: intent.intentId,
      expectedRevision: intent.revision,
      terminalAtMs: observedAtMs,
      nextState: "expired" as const,
      ...expired
    }) satisfies PersistPasskeyLoginTerminal;
    try {
      await this.#store.commitPasskeyLoginTerminal(persist);
    } catch {
      try {
        const receipt = await this.#store.findPasskeyLoginCommandReceipt(commandScope);
        if (receipt !== null) {
          const authoritative = validateReceipt(receipt, commandScope);
          if (
            authoritative.intentId === intent.intentId
            && authoritative.resultState === "expired"
            && safeEqual(authoritative.fingerprint, fingerprint)
          ) return;
        }
      } catch {
        // The externally visible result remains the same generic rejection.
      }
    }
  }

  async #replayCommitted(
    input: SafeVerifyInput,
    candidate: BootstrapTokenReplayCandidate,
    receipt: PasskeyLoginReceiptRecord,
    intent: PasskeyLoginIntentRecord
  ): Promise<PasskeyLoginVerifyResponse> {
    validateIntentPolicy(intent);
    validateTokenBinding(candidate, intent);
    const resolution = intent.resolution;
    if (
      intent.state !== "consumed"
      || intent.terminalReason !== "verified"
      || intent.terminalAtMs === null
      || resolution === null
      || intent.revision !== receipt.resultRevision
      || receipt.resultState !== "consumed"
    ) throw genericAuthenticationFailure();

    if (receipt.resultRevision !== input.expectedRevision + 1) {
      throw currentRevisionConflict(intent.state, intent.revision);
    }
    const expectedFingerprint = verifyFingerprint(input, intent.intentId);
    if (!safeEqual(receipt.fingerprint, expectedFingerprint)) {
      throw conflict("Passkey login command was already used");
    }
    try {
      await this.#bootstrapTokens.verifyCommittedReplay(
        input.bootstrapToken,
        LOGIN_PURPOSE,
        {
          state: "committed",
          recoveryDeadline: candidate.expiresAt + intent.recoveryGraceSeconds,
          issueInput: this.#bootstrapIssueInput(intent, candidate.deliveryNonce)
        }
      );
    } catch {
      throw genericAuthenticationFailure();
    }

    const nowMs = currentTimeMilliseconds(this.#clock);
    const nowSec = Math.floor(nowMs / MILLISECONDS_PER_SECOND);
    const accessIssuedAtSec = Math.floor(intent.terminalAtMs / MILLISECONDS_PER_SECOND);
    if (
      !canonicalUuid(resolution.accountId)
      || !canonicalUuid(resolution.sessionId)
      || !canonicalUuid(resolution.initialRefreshTokenId)
      || resolution.initialAccessTokenExpiresAtSec !== accessIssuedAtSec + intent.accessTokenTtlSeconds
      || nowSec >= resolution.initialAccessTokenExpiresAtSec
    ) throw genericAuthenticationFailure();

    let refresh: DerivedPasskeyBootstrapRefreshToken;
    try {
      refresh = this.#refreshTokens.rederive({
        intentId: intent.intentId,
        accountId: resolution.accountId,
        sessionId: resolution.sessionId,
        deliveryNonce: candidate.deliveryNonce
      }, intent.refreshDerivationKeyId);
    } catch {
      throw genericAuthenticationFailure();
    }
    if (
      refresh.keyId !== intent.refreshDerivationKeyId
      || !safeEqual(refresh.deliveryNonceDigest, intent.deliveryNonceDigest)
    ) throw genericAuthenticationFailure();

    let refreshRow: (RefreshTokenRecord & { session: SessionRecord }) | null;
    try {
      refreshRow = this.#store.findRefreshToken(refresh.hash);
    } catch {
      throw serviceUnavailable("Passkey login is temporarily unavailable");
    }
    const expectedCreatedAt = isoTimestamp(intent.terminalAtMs);
    const expectedExpiresAt = isoTimestamp(
      intent.terminalAtMs + intent.sessionTtlSeconds * MILLISECONDS_PER_SECOND
    );
    let sessionActive: boolean;
    try {
      sessionActive = this.#store.isSessionActive(
        resolution.sessionId,
        resolution.accountId,
        isoTimestamp(nowMs)
      );
    } catch {
      throw serviceUnavailable("Passkey login is temporarily unavailable");
    }
    if (
      refreshRow === null
      || refreshRow.id !== resolution.initialRefreshTokenId
      || refreshRow.sessionId !== resolution.sessionId
      || !safeEqual(refreshRow.tokenHash, refresh.hash)
      || refreshRow.createdAt !== expectedCreatedAt
      || refreshRow.expiresAt !== expectedExpiresAt
      || refreshRow.expiresAt <= isoTimestamp(nowMs)
      || refreshRow.usedAt !== null
      || refreshRow.session.id !== resolution.sessionId
      || refreshRow.session.userId !== resolution.accountId
      || refreshRow.session.createdAt !== expectedCreatedAt
      || refreshRow.session.expiresAt !== expectedExpiresAt
      || refreshRow.session.revokedAt !== null
      || !sessionActive
    ) throw genericAuthenticationFailure();

    let user: UserRecord | null;
    try {
      user = this.#store.findUserById(resolution.accountId);
    } catch {
      throw serviceUnavailable("Passkey login is temporarily unavailable");
    }
    if (user === null) throw genericAuthenticationFailure();
    let access: { readonly token: string; readonly tokenId: string };
    try {
      access = await this.#accessTokens.signDeterministicAccessToken({
        userId: resolution.accountId,
        sessionId: resolution.sessionId,
        tokenId: intent.intentId,
        issuedAtSec: accessIssuedAtSec,
        expiresAtSec: resolution.initialAccessTokenExpiresAtSec
      });
    } catch {
      throw serviceUnavailable("Passkey login is temporarily unavailable");
    }
    if (access.tokenId !== intent.intentId) {
      throw serviceUnavailable("Passkey login is temporarily unavailable");
    }
    return verifyResponse(
      intent,
      user,
      access.token,
      refresh.raw,
      resolution.initialAccessTokenExpiresAtSec - nowSec,
      true
    );
  }

  async #discardBestEffort(reference: string): Promise<void> {
    try {
      await this.#store.discard(reference);
    } catch {
      // Challenge leases are TTL-bounded. Never replace the authoritative
      // operation outcome with cleanup failure.
    }
  }
}
