import {
  createHash,
  randomBytes as nodeRandomBytes,
  randomUUID,
  timingSafeEqual
} from "node:crypto";
import { types as utilTypes } from "node:util";

import {
  LUXORA_PASSKEY_PRODUCTION_ORIGIN,
  LUXORA_PASSKEY_RP_ID,
  PASSKEY_CHALLENGE_BYTES,
  StoreCredentialConflictError,
  StoreRevisionConflictError,
  type ChallengeSecretVault
} from "@luxora/passkey-domain";
import {
  IdSchema,
  MAX_DISPLAY_NAME_LENGTH,
  PASSKEY_BOOTSTRAP_TOKEN_MAX_BYTES,
  PASSKEY_DEFAULT_TIMEOUT_MS,
  PASSKEY_HTTP_CONTRACT_VERSION,
  PASSKEY_MAX_CREDENTIAL_ID_BYTES,
  PASSKEY_MAX_CREDENTIAL_RESPONSE_BYTES,
  PasskeyDeliveryNonceSchema,
  PasskeySignupBeginResponseSchema,
  PasskeySignupOptionsSchema,
  PasskeySignupVerifyResponseSchema,
  UsernameSchema,
  type PasskeySignupBeginResponse,
  type PasskeySignupOptions,
  type PasskeySignupVerifyResponse,
  type User
} from "@luxora/protocol";

import type {
  NewPasskeySignupIntent,
  PasskeySignupEventType,
  PersistPasskeySignupBegin,
  PersistPasskeySignupExpired,
  PersistPasskeySignupRejectedAttempt,
  PersistVerifiedPasskeySignup,
  Store
} from "../domain/store.js";
import type {
  PasskeySignupConsumptionRecord,
  PasskeySignupIntentRecord,
  PasskeySignupReceiptRecord,
  RefreshTokenRecord,
  SessionRecord,
  UserRecord
} from "../domain/types.js";
import { AppError, badRequest, conflict, serviceUnavailable, unauthenticated } from "../errors.js";
import type { ParsedPasskeyResponseBody } from "../http/passkey-response-body.js";
import type {
  PasskeySignupAuthorizationIssueInput,
  VerifiedPasskeySignupAuthorization
} from "../passkeys/signup-authorization-token.js";
import type {
  DerivedPasskeySignupRefreshToken,
  PasskeySignupRefreshInput
} from "../passkeys/signup-refresh-token.js";
import type {
  BootstrapRegistrationCeremony,
  BootstrapRegistrationVerifierResult,
  SimpleWebAuthnVerifierAdapter
} from "../passkeys/simplewebauthn-adapter.js";
import type { DeterministicAccessTokenInput } from "../security.js";
import {
  createPasskeyDisabledPasswordHash,
  PASSKEY_DISABLED_PASSWORD_HASH_PATTERN
} from "./password-auth.js";

const SIGNUP_PURPOSE = "account.create" as const;
const SIGNUP_TOPIC = "luxora.passkey-signup.v1" as const;
const SIGNUP_RP_NAME = "Luxora" as const;
const SIGNUP_TIMEOUT_MS = PASSKEY_DEFAULT_TIMEOUT_MS;
const SIGNUP_MAX_ATTEMPTS = 3;
const SIGNUP_ALLOWED_ALGORITHMS = Object.freeze([-7, -257] as const);
const MILLISECONDS_PER_SECOND = 1_000;
const MIN_ACCESS_TTL_SECONDS = 60;
const MAX_ACCESS_TTL_SECONDS = 3_600;
const MIN_SESSION_TTL_SECONDS = 86_400;
const MAX_SESSION_TTL_SECONDS = 365 * 86_400;
const MAX_RECOVERY_GRACE_SECONDS = 300;
const USER_HANDLE_BYTES = 32;
const MAX_PUBLIC_KEY_BYTES = PASSKEY_MAX_CREDENTIAL_RESPONSE_BYTES;
const DIGEST_PATTERN = /^[a-f0-9]{64}$/u;
const OPAQUE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/u;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/u;
const REFRESH_KEY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
const TRANSPORTS = Object.freeze([
  "ble", "cable", "hybrid", "internal", "nfc", "smart-card", "usb"
] as const);
const GENERIC_SIGNUP_FAILURE_MESSAGE = "Passkey signup failed";
const GENERIC_SIGNUP_CONFLICT_MESSAGE = "Passkey signup could not be completed";

type SignupStore = Pick<Store,
  | "commitPasskeySignupBegin"
  | "commitPasskeySignupExpired"
  | "commitPasskeySignupRejectedAttempt"
  | "commitVerifiedPasskeySignup"
  | "findPasskeySignupCommandReceipt"
  | "findPasskeySignupConsumption"
  | "findPasskeySignupCreationReceipt"
  | "findPasskeySignupIntent"
  | "findRefreshToken"
  | "findUserById"
  | "isSessionActive"
> & ChallengeSecretVault;

type SignupAdapter = Pick<SimpleWebAuthnVerifierAdapter,
  "createBootstrapRegistrationOptions" | "verifyBootstrapRegistration"
>;

export interface PasskeySignupAuthorizationAuthority {
  issue(input: PasskeySignupAuthorizationIssueInput): Promise<string>;
  verifyActive(token: string): Promise<VerifiedPasskeySignupAuthorization>;
  verifyReplayCandidate(token: string): Promise<VerifiedPasskeySignupAuthorization>;
  verifyCommittedReplay(
    token: string,
    input: PasskeySignupAuthorizationIssueInput
  ): Promise<void>;
}

export interface PasskeySignupRefreshTokenAuthority {
  readonly activeKeyId: string;
  deriveActive(input: PasskeySignupRefreshInput): DerivedPasskeySignupRefreshToken;
  rederive(
    input: PasskeySignupRefreshInput,
    keyId: string
  ): DerivedPasskeySignupRefreshToken;
}

export interface PasskeySignupAccessTokenAuthority {
  signDeterministicAccessToken(
    input: DeterministicAccessTokenInput
  ): Promise<{ readonly token: string; readonly tokenId: string }>;
}

export interface PasskeySignupPasswordAuthority {
  createDisabledHash(): Promise<string>;
}

export interface PasskeySignupPolicyOptions {
  readonly accessTokenTtlSeconds: number;
  readonly sessionTtlSeconds: number;
  readonly recoveryGraceSeconds: number;
}

export interface PasskeySignupServiceDependencies {
  readonly store: SignupStore;
  readonly adapter: SignupAdapter;
  readonly authorizations: PasskeySignupAuthorizationAuthority;
  readonly refreshTokens: PasskeySignupRefreshTokenAuthority;
  readonly accessTokens: PasskeySignupAccessTokenAuthority;
  readonly policy: PasskeySignupPolicyOptions;
  readonly passwords?: PasskeySignupPasswordAuthority;
  readonly clock?: () => Date;
  readonly nextId?: () => string;
  readonly randomBytes?: (byteLength: number) => Uint8Array;
}

export interface BeginPasskeySignupServiceInput {
  readonly commandId: string;
  readonly clientNonce: string;
  readonly deliveryNonce: string;
  readonly username: string;
  readonly displayName: string;
  readonly deviceName: string;
}

export interface VerifyPasskeySignupServiceInput {
  readonly commandId: string;
  readonly expectedRevision: number;
  readonly signupAuthorization: string;
  readonly response: ParsedPasskeyResponseBody;
}

interface SafeBeginInput extends BeginPasskeySignupServiceInput {
  readonly usernameNormalized: string;
  readonly deliveryNonceDigest: string;
}

interface SafeVerifyInput extends VerifyPasskeySignupServiceInput {
  readonly authorizationDigest: string;
  readonly response: ParsedPasskeyResponseBody;
}

interface BeginScopes {
  readonly commandScope: string;
  readonly commandFingerprint: string;
  readonly creationScope: string;
  readonly creationFingerprint: string;
}

interface VerifiedRegistrationSnapshot {
  readonly credentialId: string;
  readonly publicKey: Uint8Array;
  readonly algorithm: -7 | -257;
  readonly discoveryMode: "discoverable";
  readonly signCount: number;
  readonly backupEligible: boolean;
  readonly backupState: boolean;
  readonly transports: readonly (typeof TRANSPORTS)[number][];
  readonly userPresent: true;
  readonly userVerified: true;
}

function sha256Text(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function sha256Base64urlBytes(value: string): string {
  return createHash("sha256").update(Buffer.from(value, "base64url")).digest("hex");
}

function sha256Bytes(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function digestTuple(domain: string, values: readonly unknown[]): string {
  return sha256Text(JSON.stringify([domain, ...values]));
}

function safeEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, "utf8");
  const rightBytes = Buffer.from(right, "utf8");
  return leftBytes.byteLength === rightBytes.byteLength
    && timingSafeEqual(leftBytes, rightBytes);
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

function safeInteger(
  value: unknown,
  minimum = 0,
  maximum = Number.MAX_SAFE_INTEGER
): value is number {
  return typeof value === "number"
    && Number.isSafeInteger(value)
    && value >= minimum
    && value <= maximum;
}

function strictRecord(
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
    const ownKeys = Reflect.ownKeys(value);
    if (
      ownKeys.length !== expectedKeys.length
      || ownKeys.some((key) => typeof key !== "string" || !expectedKeys.includes(key))
    ) return null;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const snapshot: Record<string, unknown> = {};
    for (const key of expectedKeys) {
      const descriptor = descriptors[key];
      if (
        descriptor === undefined
        || descriptor.enumerable !== true
        || !("value" in descriptor)
      ) return null;
      snapshot[key] = descriptor.value;
    }
    return Object.freeze(snapshot);
  } catch {
    return null;
  }
}

interface JsonSnapshotBudget { remaining: number }

function snapshotJsonData(
  value: unknown,
  depth: number,
  budget: JsonSnapshotBudget
): unknown {
  if (budget.remaining < 1 || depth > 64) throw new Error("JSON snapshot limit");
  budget.remaining -= 1;
  if (
    value === null
    || typeof value === "string"
    || typeof value === "boolean"
  ) return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("non-JSON number");
    return value;
  }
  if (typeof value !== "object" || utilTypes.isProxy(value)) {
    throw new Error("non-JSON value");
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.some((key) => typeof key !== "string")) throw new Error("symbol key");
  if (Array.isArray(value)) {
    const lengthDescriptor = descriptors["length"];
    if (
      lengthDescriptor === undefined
      || !("value" in lengthDescriptor)
      || !safeInteger(lengthDescriptor.value, 0, 20_000)
      || ownKeys.length !== lengthDescriptor.value + 1
    ) throw new Error("invalid JSON array");
    const result: unknown[] = [];
    for (let index = 0; index < lengthDescriptor.value; index += 1) {
      const descriptor = descriptors[String(index)];
      if (
        descriptor === undefined
        || descriptor.enumerable !== true
        || !("value" in descriptor)
      ) throw new Error("sparse or accessor array");
      result.push(snapshotJsonData(descriptor.value, depth + 1, budget));
    }
    return Object.freeze(result);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error("invalid JSON prototype");
  }
  const result = Object.create(null) as Record<string, unknown>;
  for (const key of ownKeys as string[]) {
    const descriptor = descriptors[key];
    if (
      descriptor === undefined
      || descriptor.enumerable !== true
      || !("value" in descriptor)
    ) throw new Error("accessor JSON property");
    result[key] = snapshotJsonData(descriptor.value, depth + 1, budget);
  }
  return Object.freeze(result);
}

function canonicalBase64url(value: unknown, maximumBytes: number): value is string {
  if (typeof value !== "string" || value.length < 1 || !BASE64URL_PATTERN.test(value)) return false;
  try {
    const bytes = Buffer.from(value, "base64url");
    return bytes.byteLength >= 1
      && bytes.byteLength <= maximumBytes
      && bytes.toString("base64url") === value;
  } catch {
    return false;
  }
}

function exactBytes(value: unknown, byteLength: number): value is Uint8Array {
  try {
    return value instanceof Uint8Array
      && !utilTypes.isProxy(value)
      && value.byteLength === byteLength;
  } catch {
    return false;
  }
}

function canonicalOpaqueId(value: unknown): value is string {
  return typeof value === "string" && OPAQUE_ID_PATTERN.test(value);
}

function canonicalDisplayName(value: unknown): value is string {
  return typeof value === "string"
    && value.length >= 1
    && value.length <= MAX_DISPLAY_NAME_LENGTH
    && value.trim() === value
    && value.normalize("NFC") === value;
}

function canonicalDeviceName(value: unknown): value is string {
  return typeof value === "string"
    && value.length >= 1
    && value.length <= 120
    && value.trim() === value
    && value.normalize("NFC") === value;
}

function snapshotBeginInput(input: BeginPasskeySignupServiceInput): SafeBeginInput {
  const record = strictRecord(input, [
    "commandId", "clientNonce", "deliveryNonce", "username", "displayName", "deviceName"
  ]);
  const username = record?.["username"];
  const parsedUsername = UsernameSchema.safeParse(username);
  if (
    record === null
    || !canonicalUuid(record["commandId"])
    || !canonicalUuid(record["clientNonce"])
    || !canonicalDeliveryNonce(record["deliveryNonce"])
    || !parsedUsername.success
    || parsedUsername.data !== username
    || !canonicalDisplayName(record["displayName"])
    || !canonicalDeviceName(record["deviceName"])
  ) throw badRequest("Invalid passkey signup request");
  return Object.freeze({
    commandId: record["commandId"],
    clientNonce: record["clientNonce"],
    deliveryNonce: record["deliveryNonce"],
    username,
    usernameNormalized: username.toLowerCase(),
    displayName: record["displayName"],
    deviceName: record["deviceName"],
    deliveryNonceDigest: sha256Base64urlBytes(record["deliveryNonce"])
  });
}

function snapshotResponse(value: unknown): ParsedPasskeyResponseBody | null {
  const record = strictRecord(value, ["credential", "byteLength", "digest"]);
  const credential = record?.["credential"];
  if (
    record === null
    || credential === null
    || typeof credential !== "object"
    || Array.isArray(credential)
    || utilTypes.isProxy(credential)
    || !safeInteger(record["byteLength"], 1, PASSKEY_MAX_CREDENTIAL_RESPONSE_BYTES)
    || typeof record["digest"] !== "string"
    || !DIGEST_PATTERN.test(record["digest"])
  ) return null;
  try {
    const snapshot = snapshotJsonData(credential, 0, { remaining: 20_000 });
    if (snapshot === null || typeof snapshot !== "object" || Array.isArray(snapshot)) return null;
    return Object.freeze({
      credential: snapshot as Record<string, unknown>,
      byteLength: record["byteLength"],
      digest: record["digest"]
    });
  } catch {
    return null;
  }
}

function snapshotVerifyInput(input: VerifyPasskeySignupServiceInput): SafeVerifyInput {
  const record = strictRecord(input, [
    "commandId", "expectedRevision", "signupAuthorization", "response"
  ]);
  const response = record === null ? null : snapshotResponse(record["response"]);
  if (
    record === null
    || !canonicalUuid(record["commandId"])
    || !safeInteger(record["expectedRevision"], 1)
    || typeof record["signupAuthorization"] !== "string"
    || record["signupAuthorization"].length < 1
    || Buffer.byteLength(record["signupAuthorization"], "utf8")
      > PASSKEY_BOOTSTRAP_TOKEN_MAX_BYTES
    || response === null
  ) throw badRequest("Invalid passkey signup verification request");
  return Object.freeze({
    commandId: record["commandId"],
    expectedRevision: record["expectedRevision"],
    signupAuthorization: record["signupAuthorization"],
    authorizationDigest: sha256Text(record["signupAuthorization"]),
    response
  });
}

function validatePolicy(policy: PasskeySignupPolicyOptions): PasskeySignupPolicyOptions {
  const record = strictRecord(policy, [
    "accessTokenTtlSeconds", "sessionTtlSeconds", "recoveryGraceSeconds"
  ]);
  if (
    record === null
    || !safeInteger(record["accessTokenTtlSeconds"], MIN_ACCESS_TTL_SECONDS, MAX_ACCESS_TTL_SECONDS)
    || !safeInteger(record["sessionTtlSeconds"], MIN_SESSION_TTL_SECONDS, MAX_SESSION_TTL_SECONDS)
    || !safeInteger(record["recoveryGraceSeconds"], 0, MAX_RECOVERY_GRACE_SECONDS)
    || record["accessTokenTtlSeconds"] < Math.ceil(SIGNUP_TIMEOUT_MS / 1_000)
      + 1 + record["recoveryGraceSeconds"]
  ) throw new Error("invalid passkey signup policy");
  return Object.freeze({
    accessTokenTtlSeconds: record["accessTokenTtlSeconds"],
    sessionTtlSeconds: record["sessionTtlSeconds"],
    recoveryGraceSeconds: record["recoveryGraceSeconds"]
  });
}

function policyDigest(
  accessTokenTtlSeconds: number,
  sessionTtlSeconds: number,
  recoveryGraceSeconds: number,
  refreshDerivationKeyId: string
): string {
  return digestTuple("luxora/passkey-signup/v1/policy", [
    SIGNUP_PURPOSE,
    SIGNUP_RP_NAME,
    LUXORA_PASSKEY_RP_ID,
    LUXORA_PASSKEY_PRODUCTION_ORIGIN,
    SIGNUP_TIMEOUT_MS,
    PASSKEY_MAX_CREDENTIAL_RESPONSE_BYTES,
    SIGNUP_MAX_ATTEMPTS,
    -7,
    -257,
    true,
    "required",
    "required",
    "none",
    false,
    accessTokenTtlSeconds,
    sessionTtlSeconds,
    recoveryGraceSeconds,
    refreshDerivationKeyId
  ]);
}

function candidateDigest(intent: PasskeySignupIntentRecord | NewPasskeySignupIntent): string {
  return digestTuple("luxora/passkey-signup/v1/candidate", [
    intent.candidate.accountId,
    intent.candidate.username,
    intent.candidate.usernameNormalized,
    intent.candidate.displayName,
    intent.candidate.userHandleRef,
    sha256Bytes(intent.candidate.userHandle)
  ]);
}

function beginScopes(
  input: SafeBeginInput,
  targetDigest: string
): BeginScopes {
  const commandScope = digestTuple("luxora/passkey-signup/v1/command-scope", [
    "begin", input.commandId
  ]);
  const creationScope = digestTuple("luxora/passkey-signup/v1/creation-scope", [
    input.clientNonce
  ]);
  const shared = [
    input.clientNonce,
    input.deliveryNonceDigest,
    sha256Text(input.username),
    sha256Text(input.usernameNormalized),
    sha256Text(input.displayName),
    sha256Text(input.deviceName),
    targetDigest
  ] as const;
  return Object.freeze({
    commandScope,
    commandFingerprint: digestTuple("luxora/passkey-signup/v1/begin-command", [
      input.commandId,
      ...shared
    ]),
    creationScope,
    creationFingerprint: digestTuple("luxora/passkey-signup/v1/begin-creation", shared)
  });
}

function verifyCommandScope(commandId: string): string {
  return digestTuple("luxora/passkey-signup/v1/command-scope", ["verify", commandId]);
}

function verifyFingerprint(input: SafeVerifyInput, intentId: string): string {
  return digestTuple("luxora/passkey-signup/v1/verify-command", [
    input.commandId,
    intentId,
    input.expectedRevision,
    input.authorizationDigest,
    input.response.byteLength,
    input.response.digest
  ]);
}

function currentTimeMilliseconds(clock: () => Date): number {
  try {
    const milliseconds = Date.prototype.getTime.call(clock());
    if (!safeInteger(milliseconds)) throw new Error("invalid clock");
    return milliseconds;
  } catch {
    throw serviceUnavailable("Passkey signup is temporarily unavailable");
  }
}

function isoTimestamp(milliseconds: number): string {
  try {
    return new Date(milliseconds).toISOString();
  } catch {
    throw serviceUnavailable("Passkey signup is temporarily unavailable");
  }
}

function nextCanonicalId(nextId: () => string): string {
  try {
    const value = nextId();
    if (!canonicalUuid(value)) throw new Error("invalid UUID source");
    return value;
  } catch {
    throw serviceUnavailable("Passkey signup is temporarily unavailable");
  }
}

function nextUserHandle(source: (byteLength: number) => Uint8Array): Uint8Array {
  try {
    const value = source(USER_HANDLE_BYTES);
    if (!exactBytes(value, USER_HANDLE_BYTES)) throw new Error("invalid entropy source");
    return new Uint8Array(value);
  } catch {
    throw serviceUnavailable("Passkey signup is temporarily unavailable");
  }
}

function genericSignupFailure(): AppError {
  return unauthenticated(GENERIC_SIGNUP_FAILURE_MESSAGE);
}

function genericSignupConflict(): AppError {
  return conflict(GENERIC_SIGNUP_CONFLICT_MESSAGE);
}

function internalRecordFailure(): AppError {
  return new AppError(500, "INTERNAL_ERROR", "Passkey signup record is inconsistent");
}

function currentRevisionConflict(
  state: PasskeySignupIntentRecord["state"],
  revision: number
): AppError {
  if (
    !["pending", "consumed", "expired", "rejected"].includes(state)
    || !safeInteger(revision, 1)
  ) throw internalRecordFailure();
  return conflict("Passkey signup revision does not match", {
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
    readonly state: PasskeySignupIntentRecord["state"];
    readonly type: PasskeySignupEventType;
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
      topic: SIGNUP_TOPIC,
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

function validateReceipt(
  receipt: PasskeySignupReceiptRecord,
  expectedScope: string
): PasskeySignupReceiptRecord {
  if (
    receipt === null
    || typeof receipt !== "object"
    || receipt.scope !== expectedScope
    || !DIGEST_PATTERN.test(receipt.scope)
    || !DIGEST_PATTERN.test(receipt.fingerprint)
    || !canonicalUuid(receipt.intentId)
    || !safeInteger(receipt.resultRevision, 1)
    || !["pending", "consumed", "expired", "rejected"].includes(receipt.resultState)
    || !canonicalOpaqueId(receipt.eventId)
    || !safeInteger(receipt.createdAtMs)
  ) throw internalRecordFailure();
  return receipt;
}

function validateIntent(intent: PasskeySignupIntentRecord): void {
  const candidate = intent.candidate;
  if (
    !canonicalUuid(intent.intentId)
    || intent.schemaVersion !== 1
    || intent.purpose.type !== SIGNUP_PURPOSE
    || !DIGEST_PATTERN.test(intent.purpose.targetDigest)
    || intent.policyVersion !== 1
    || intent.rpName !== SIGNUP_RP_NAME
    || intent.expectedRpId !== LUXORA_PASSKEY_RP_ID
    || intent.expectedOrigin !== LUXORA_PASSKEY_PRODUCTION_ORIGIN
    || !Array.isArray(intent.expectedTopOrigins)
    || intent.expectedTopOrigins.length !== 0
    || intent.timeoutMs !== SIGNUP_TIMEOUT_MS
    || intent.maxResponseBytes !== PASSKEY_MAX_CREDENTIAL_RESPONSE_BYTES
    || intent.maxAttempts !== SIGNUP_MAX_ATTEMPTS
    || !Array.isArray(intent.allowedAlgorithms)
    || intent.allowedAlgorithms.length !== 2
    || intent.allowedAlgorithms[0] !== -7
    || intent.allowedAlgorithms[1] !== -257
    || intent.requireUserPresence !== true
    || intent.userVerification !== "required"
    || intent.residentKey !== "required"
    || intent.attestation !== "none"
    || intent.crossOriginAllowed !== false
    || !Array.isArray(intent.excludeCredentials)
    || intent.excludeCredentials.length !== 0
    || !canonicalUuid(candidate.accountId)
    || !UsernameSchema.safeParse(candidate.username).success
    || candidate.username.trim() !== candidate.username
    || candidate.usernameNormalized !== candidate.username.toLowerCase()
    || !canonicalDisplayName(candidate.displayName)
    || !canonicalOpaqueId(candidate.userHandleRef)
    || !exactBytes(candidate.userHandle, USER_HANDLE_BYTES)
    || !canonicalOpaqueId(intent.challenge.reference)
    || !DIGEST_PATTERN.test(intent.challenge.digest)
    || !DIGEST_PATTERN.test(intent.deliveryNonceDigest)
    || !["pending", "consumed", "expired", "rejected"].includes(intent.state)
    || !safeInteger(intent.revision, 1)
    || !safeInteger(intent.attemptsUsed, 0, intent.maxAttempts)
    || !safeInteger(intent.createdAtMs)
    || intent.expiresAtMs !== intent.createdAtMs + intent.timeoutMs
    || !safeInteger(intent.updatedAtMs, intent.createdAtMs)
    || (intent.state === "pending" && (
      intent.revision !== intent.attemptsUsed + 1
      || intent.terminalAtMs !== null
      || intent.terminalReason !== null
      || intent.resolvedCredentialRecordId !== null
    ))
    || (intent.state === "rejected" && (
      intent.attemptsUsed !== intent.maxAttempts
      || intent.revision !== intent.attemptsUsed + 1
      || intent.terminalAtMs === null
      || intent.terminalReason !== "attempts_exhausted"
      || intent.resolvedCredentialRecordId !== null
    ))
    || (intent.state === "expired" && (
      intent.revision !== intent.attemptsUsed + 2
      || intent.terminalAtMs === null
      || intent.terminalReason !== "expired"
      || intent.resolvedCredentialRecordId !== null
    ))
    || (intent.state === "consumed" && (
      intent.revision !== intent.attemptsUsed + 2
      || intent.terminalAtMs === null
      || intent.terminalReason !== "verified"
      || !canonicalOpaqueId(intent.resolvedCredentialRecordId)
    ))
  ) throw internalRecordFailure();
}

function authorizationIssueInput(
  intent: PasskeySignupIntentRecord | NewPasskeySignupIntent,
  input: {
    readonly deliveryNonce: string;
    readonly deviceName: string;
    readonly refreshDerivationKeyId: string;
    readonly accessTokenTtlSeconds: number;
    readonly sessionTtlSeconds: number;
    readonly recoveryGraceSeconds: number;
  }
): PasskeySignupAuthorizationIssueInput {
  const issuedAt = Math.floor(intent.createdAtMs / MILLISECONDS_PER_SECOND);
  const expiresAt = Math.floor(intent.expiresAtMs / MILLISECONDS_PER_SECOND);
  return Object.freeze({
    intentId: intent.intentId,
    issuedRevision: 1 as const,
    candidateDigest: candidateDigest(intent),
    challengeDigest: intent.challenge.digest,
    policyDigest: intent.purpose.targetDigest,
    deliveryNonce: input.deliveryNonce,
    deviceName: input.deviceName,
    refreshDerivationKeyId: input.refreshDerivationKeyId,
    accessTokenTtlSeconds: input.accessTokenTtlSeconds,
    sessionTtlSeconds: input.sessionTtlSeconds,
    issuedAt,
    expiresAt,
    recoveryDeadline: expiresAt + input.recoveryGraceSeconds
  });
}

function validateAuthorizationBinding(
  authorization: VerifiedPasskeySignupAuthorization,
  intent: PasskeySignupIntentRecord
): void {
  const recoveryGraceSeconds = authorization.recoveryDeadline - authorization.expiresAt;
  if (
    authorization.intentId !== intent.intentId
    || authorization.issuedRevision !== 1
    || !safeEqual(authorization.candidateDigest, candidateDigest(intent))
    || !safeEqual(authorization.challengeDigest, intent.challenge.digest)
    || !safeEqual(authorization.policyDigest, intent.purpose.targetDigest)
    || !safeEqual(
      policyDigest(
        authorization.accessTokenTtlSeconds,
        authorization.sessionTtlSeconds,
        recoveryGraceSeconds,
        authorization.refreshDerivationKeyId
      ),
      intent.purpose.targetDigest
    )
    || !safeEqual(
      sha256Base64urlBytes(authorization.deliveryNonce),
      intent.deliveryNonceDigest
    )
    || authorization.issuedAt !== Math.floor(intent.createdAtMs / MILLISECONDS_PER_SECOND)
    || authorization.expiresAt !== Math.floor(intent.expiresAtMs / MILLISECONDS_PER_SECOND)
    || !safeInteger(recoveryGraceSeconds, 0, MAX_RECOVERY_GRACE_SECONDS)
    || !canonicalDeviceName(authorization.deviceName)
    || !REFRESH_KEY_ID_PATTERN.test(authorization.refreshDerivationKeyId)
  ) throw genericSignupFailure();
}

function ceremony(
  intent: PasskeySignupIntentRecord | NewPasskeySignupIntent,
  challenge: string
): BootstrapRegistrationCeremony {
  return Object.freeze({
    kind: "bootstrap_registration" as const,
    rpName: intent.rpName,
    userName: intent.candidate.username,
    userDisplayName: intent.candidate.displayName,
    expectedChallenge: challenge,
    expectedRpId: intent.expectedRpId,
    expectedOrigin: intent.expectedOrigin,
    expectedTopOrigins: Object.freeze([]) as readonly [],
    crossOriginAllowed: false as const,
    timeoutMs: intent.timeoutMs,
    requireUserPresence: true as const,
    requireUserVerification: true as const,
    attestation: "none" as const,
    residentKey: "required" as const,
    allowedAlgorithms: Object.freeze([-7, -257]) as readonly [-7, -257],
    excludeCredentials: Object.freeze([]) as readonly [],
    candidateAccountId: intent.candidate.accountId,
    userHandleRef: intent.candidate.userHandleRef,
    expectedUserHandle: new Uint8Array(intent.candidate.userHandle)
  });
}

function validChallenge(challenge: unknown, expectedDigest: string): challenge is string {
  return canonicalBase64url(challenge, PASSKEY_CHALLENGE_BYTES)
    && Buffer.from(challenge, "base64url").byteLength === PASSKEY_CHALLENGE_BYTES
    && safeEqual(sha256Base64urlBytes(challenge), expectedDigest);
}

function exactVerifierRejection(value: unknown): boolean {
  const record = strictRecord(value, ["status", "reason"]);
  return record !== null
    && record["status"] === "rejected"
    && (record["reason"] === "invalid_webauthn_response"
      || record["reason"] === "policy_rejected");
}

function snapshotVerifiedRegistration(
  value: BootstrapRegistrationVerifierResult,
  intent: PasskeySignupIntentRecord
): VerifiedRegistrationSnapshot {
  const top = strictRecord(value, ["status", "kind", "candidate", "credential"]);
  const candidate = strictRecord(top?.["candidate"], [
    "accountId", "userHandleRef", "expectedUserHandle", "userName", "userDisplayName"
  ]);
  const credential = strictRecord(top?.["credential"], [
    "credentialId", "publicKey", "algorithm", "discoveryMode", "signCount",
    "backupEligible", "backupState", "transports", "userPresent", "userVerified"
  ]);
  const expectedHandle = candidate?.["expectedUserHandle"];
  const publicKey = credential?.["publicKey"];
  const transports = credential?.["transports"];
  if (
    top === null
    || top["status"] !== "verified"
    || top["kind"] !== "bootstrap_registration"
    || candidate === null
    || credential === null
    || candidate["accountId"] !== intent.candidate.accountId
    || candidate["userHandleRef"] !== intent.candidate.userHandleRef
    || candidate["userName"] !== intent.candidate.username
    || candidate["userDisplayName"] !== intent.candidate.displayName
    || !exactBytes(expectedHandle, USER_HANDLE_BYTES)
    || !Buffer.from(expectedHandle).equals(Buffer.from(intent.candidate.userHandle))
    || !canonicalBase64url(credential["credentialId"], PASSKEY_MAX_CREDENTIAL_ID_BYTES)
    || !(publicKey instanceof Uint8Array)
    || utilTypes.isProxy(publicKey)
    || publicKey.byteLength < 1
    || publicKey.byteLength > MAX_PUBLIC_KEY_BYTES
    || (credential["algorithm"] !== -7 && credential["algorithm"] !== -257)
    || credential["discoveryMode"] !== "discoverable"
    || !safeInteger(credential["signCount"], 0, 0xffff_ffff)
    || typeof credential["backupEligible"] !== "boolean"
    || typeof credential["backupState"] !== "boolean"
    || (credential["backupEligible"] === false && credential["backupState"] === true)
    || !Array.isArray(transports)
    || transports.some((item) => typeof item !== "string"
      || !TRANSPORTS.includes(item as (typeof TRANSPORTS)[number]))
    || new Set(transports).size !== transports.length
    || credential["userPresent"] !== true
    || credential["userVerified"] !== true
  ) throw serviceUnavailable("Passkey verification is temporarily unavailable");
  return Object.freeze({
    credentialId: credential["credentialId"],
    publicKey: new Uint8Array(publicKey),
    algorithm: credential["algorithm"],
    discoveryMode: "discoverable",
    signCount: credential["signCount"],
    backupEligible: credential["backupEligible"],
    backupState: credential["backupState"],
    transports: Object.freeze([...(transports as (typeof TRANSPORTS)[number][])]),
    userPresent: true,
    userVerified: true
  });
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

function publicSignupOptions(
  options: Awaited<ReturnType<SignupAdapter["createBootstrapRegistrationOptions"]>>
): PasskeySignupOptions {
  try {
    if (
      !Array.isArray(options.excludeCredentials)
      || options.excludeCredentials.length !== 0
      || !Array.isArray(options.pubKeyCredParams)
      || options.pubKeyCredParams.length !== 2
      || options.pubKeyCredParams[0]?.type !== "public-key"
      || options.pubKeyCredParams[0].alg !== -7
      || options.pubKeyCredParams[1]?.type !== "public-key"
      || options.pubKeyCredParams[1].alg !== -257
      || (options.hints !== undefined && options.hints.length !== 0)
      || options.attestationFormats !== undefined
      || (options.extensions !== undefined && (
        Reflect.ownKeys(options.extensions).length !== 1
        || options.extensions.credProps !== true
      ))
    ) throw new Error("unsafe registration options");
    // The maintained generator may emit the requested credProps extension.
    // The public v1 protocol intentionally does not expose extensions, so this
    // is an explicit allowlisted projection rather than a permissive parse.
    return PasskeySignupOptionsSchema.parse({
      challenge: options.challenge,
      rp: { id: options.rp.id, name: options.rp.name },
      user: {
        id: options.user.id,
        name: options.user.name,
        displayName: options.user.displayName
      },
      pubKeyCredParams: [
        { type: "public-key", alg: -7 },
        { type: "public-key", alg: -257 }
      ],
      excludeCredentials: [],
      timeout: options.timeout,
      attestation: options.attestation,
      authenticatorSelection: {
        residentKey: options.authenticatorSelection?.residentKey,
        requireResidentKey: options.authenticatorSelection?.requireResidentKey,
        userVerification: options.authenticatorSelection?.userVerification
      }
    });
  } catch {
    throw internalRecordFailure();
  }
}

function beginResponse(
  intent: PasskeySignupIntentRecord | NewPasskeySignupIntent,
  authorization: string,
  options: Awaited<ReturnType<SignupAdapter["createBootstrapRegistrationOptions"]>>,
  replayed: boolean
): PasskeySignupBeginResponse {
  try {
    return PasskeySignupBeginResponseSchema.parse({
      schemaVersion: PASSKEY_HTTP_CONTRACT_VERSION,
      replayed,
      ceremony: {
        id: intent.intentId,
        kind: "registration",
        purpose: SIGNUP_PURPOSE,
        state: "pending",
        revision: intent.revision,
        expiresAt: isoTimestamp(intent.expiresAtMs)
      },
      bootstrapAuthorization: {
        scheme: "Bearer",
        token: authorization,
        purpose: SIGNUP_PURPOSE,
        expiresAt: isoTimestamp(intent.expiresAtMs)
      },
      options: publicSignupOptions(options)
    });
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw internalRecordFailure();
  }
}

function verifyResponse(
  intent: PasskeySignupIntentRecord,
  user: UserRecord,
  consumption: PasskeySignupConsumptionRecord,
  accessToken: string,
  refreshToken: string,
  expiresIn: number,
  replayed: boolean
): PasskeySignupVerifyResponse {
  try {
    return PasskeySignupVerifyResponseSchema.parse({
      schemaVersion: PASSKEY_HTTP_CONTRACT_VERSION,
      verified: true,
      replayed,
      ceremony: {
        id: intent.intentId,
        kind: "registration",
        purpose: SIGNUP_PURPOSE,
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
        sessionId: consumption.sessionId
      }
    });
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw internalRecordFailure();
  }
}

/**
 * Internal, pre-account passkey signup orchestration. App composition is
 * independently gated outside production; begin has no user/credential read port.
 */
export class PasskeySignupService {
  readonly #store: SignupStore;
  readonly #adapter: SignupAdapter;
  readonly #authorizations: PasskeySignupAuthorizationAuthority;
  readonly #refreshTokens: PasskeySignupRefreshTokenAuthority;
  readonly #accessTokens: PasskeySignupAccessTokenAuthority;
  readonly #passwords: PasskeySignupPasswordAuthority;
  readonly #policy: PasskeySignupPolicyOptions;
  readonly #clock: () => Date;
  readonly #nextId: () => string;
  readonly #randomBytes: (byteLength: number) => Uint8Array;

  constructor(dependencies: PasskeySignupServiceDependencies) {
    this.#store = dependencies.store;
    this.#adapter = dependencies.adapter;
    this.#authorizations = dependencies.authorizations;
    this.#refreshTokens = dependencies.refreshTokens;
    this.#accessTokens = dependencies.accessTokens;
    this.#passwords = dependencies.passwords ?? Object.freeze({
      createDisabledHash: createPasskeyDisabledPasswordHash
    });
    this.#policy = validatePolicy(dependencies.policy);
    this.#clock = dependencies.clock ?? (() => new Date());
    this.#nextId = dependencies.nextId ?? randomUUID;
    this.#randomBytes = dependencies.randomBytes ?? nodeRandomBytes;
    if (!REFRESH_KEY_ID_PATTERN.test(this.#refreshTokens.activeKeyId)) {
      throw new Error("invalid passkey signup refresh key ID");
    }
  }

  async begin(input: BeginPasskeySignupServiceInput): Promise<PasskeySignupBeginResponse> {
    const safe = snapshotBeginInput(input);
    const targetDigest = policyDigest(
      this.#policy.accessTokenTtlSeconds,
      this.#policy.sessionTtlSeconds,
      this.#policy.recoveryGraceSeconds,
      this.#refreshTokens.activeKeyId
    );
    const scopes = beginScopes(safe, targetDigest);

    let priorCommand: PasskeySignupReceiptRecord | null;
    try {
      priorCommand = await this.#store.findPasskeySignupCommandReceipt(scopes.commandScope);
    } catch {
      throw serviceUnavailable("Passkey signup is temporarily unavailable");
    }
    if (priorCommand !== null) {
      const receipt = validateReceipt(priorCommand, scopes.commandScope);
      if (!safeEqual(receipt.fingerprint, scopes.commandFingerprint)) {
        throw conflict("Passkey signup command was already used");
      }
      return this.#replayBegin(receipt, safe);
    }

    let priorCreation: PasskeySignupReceiptRecord | null;
    try {
      priorCreation = await this.#store.findPasskeySignupCreationReceipt(scopes.creationScope);
    } catch {
      throw serviceUnavailable("Passkey signup is temporarily unavailable");
    }
    if (priorCreation !== null) {
      const receipt = validateReceipt(priorCreation, scopes.creationScope);
      if (!safeEqual(receipt.fingerprint, scopes.creationFingerprint)) {
        throw conflict("Passkey signup client nonce was already used");
      }
      return this.#replayBegin(receipt, safe);
    }

    const createdAtMs = currentTimeMilliseconds(this.#clock);
    if (createdAtMs > Number.MAX_SAFE_INTEGER - SIGNUP_TIMEOUT_MS) {
      throw serviceUnavailable("Passkey signup is temporarily unavailable");
    }
    const expiresAtMs = createdAtMs + SIGNUP_TIMEOUT_MS;
    let issued: Awaited<ReturnType<ChallengeSecretVault["issue"]>>;
    try {
      issued = await this.#store.issue({
        byteLength: PASSKEY_CHALLENGE_BYTES,
        expiresAtMs
      });
    } catch {
      throw serviceUnavailable("Passkey signup is temporarily unavailable");
    }

    if (
      !canonicalOpaqueId(issued.reference)
      || typeof issued.challenge !== "string"
      || issued.reference.includes(issued.challenge)
      || !validChallenge(issued.challenge, sha256Base64urlBytes(issued.challenge))
    ) {
      await this.#discardBestEffort(issued.reference);
      throw serviceUnavailable("Passkey signup is temporarily unavailable");
    }

    let intent: NewPasskeySignupIntent;
    try {
      intent = Object.freeze({
        intentId: nextCanonicalId(this.#nextId),
        schemaVersion: 1 as const,
        purpose: Object.freeze({ type: SIGNUP_PURPOSE, targetDigest }),
        policyVersion: 1 as const,
        rpName: SIGNUP_RP_NAME,
        expectedRpId: LUXORA_PASSKEY_RP_ID,
        expectedOrigin: LUXORA_PASSKEY_PRODUCTION_ORIGIN,
        expectedTopOrigins: Object.freeze([]) as readonly [],
        timeoutMs: SIGNUP_TIMEOUT_MS,
        maxResponseBytes: PASSKEY_MAX_CREDENTIAL_RESPONSE_BYTES,
        maxAttempts: SIGNUP_MAX_ATTEMPTS,
        allowedAlgorithms: SIGNUP_ALLOWED_ALGORITHMS,
        requireUserPresence: true as const,
        userVerification: "required" as const,
        residentKey: "required" as const,
        attestation: "none" as const,
        crossOriginAllowed: false as const,
        excludeCredentials: Object.freeze([]) as readonly [],
        candidate: Object.freeze({
          accountId: nextCanonicalId(this.#nextId),
          username: safe.username,
          usernameNormalized: safe.usernameNormalized,
          displayName: safe.displayName,
          userHandleRef: nextCanonicalId(this.#nextId),
          userHandle: nextUserHandle(this.#randomBytes)
        }),
        challenge: Object.freeze({
          reference: issued.reference,
          digest: sha256Base64urlBytes(issued.challenge)
        }),
        deliveryNonceDigest: safe.deliveryNonceDigest,
        state: "pending" as const,
        revision: 1 as const,
        attemptsUsed: 0 as const,
        createdAtMs,
        expiresAtMs,
        updatedAtMs: createdAtMs,
        terminalAtMs: null,
        terminalReason: null,
        resolvedCredentialRecordId: null
      }) satisfies NewPasskeySignupIntent;
    } catch {
      await this.#discardBestEffort(issued.reference);
      throw serviceUnavailable("Passkey signup is temporarily unavailable");
    }

    let options: Awaited<ReturnType<SignupAdapter["createBootstrapRegistrationOptions"]>>;
    let authorization: string;
    try {
      [options, authorization] = await Promise.all([
        this.#adapter.createBootstrapRegistrationOptions(ceremony(intent, issued.challenge)),
        this.#authorizations.issue(authorizationIssueInput(intent, {
          deliveryNonce: safe.deliveryNonce,
          deviceName: safe.deviceName,
          refreshDerivationKeyId: this.#refreshTokens.activeKeyId,
          ...this.#policy
        }))
      ]);
    } catch {
      await this.#discardBestEffort(intent.challenge.reference);
      throw serviceUnavailable("Passkey signup is temporarily unavailable");
    }

    let persist: PersistPasskeySignupBegin;
    try {
      const started = mutation(this.#nextId, {
        intentId: intent.intentId,
        revision: 1,
        state: "pending",
        type: "passkey.signup.started",
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
      }) satisfies PersistPasskeySignupBegin;
    } catch {
      await this.#discardBestEffort(intent.challenge.reference);
      throw serviceUnavailable("Passkey signup is temporarily unavailable");
    }

    try {
      await this.#store.commitPasskeySignupBegin(persist);
    } catch {
      const reconciled = await this.#reconcileBeginCommit(
        scopes,
        intent.challenge.reference,
        safe
      );
      if (reconciled !== null) return reconciled;
      throw serviceUnavailable("Passkey signup is temporarily unavailable");
    }
    return beginResponse(intent, authorization, options, false);
  }

  async verify(input: VerifyPasskeySignupServiceInput): Promise<PasskeySignupVerifyResponse> {
    const safe = snapshotVerifyInput(input);

    // No durable identifier supplied by the token can be used until its full
    // compact signature and strict signup-only namespace have authenticated.
    let candidate: VerifiedPasskeySignupAuthorization;
    try {
      candidate = await this.#authorizations.verifyReplayCandidate(safe.signupAuthorization);
    } catch {
      throw genericSignupFailure();
    }

    const commandScope = verifyCommandScope(safe.commandId);
    let priorReceipt: PasskeySignupReceiptRecord | null;
    try {
      priorReceipt = await this.#store.findPasskeySignupCommandReceipt(commandScope);
    } catch {
      throw serviceUnavailable("Passkey signup is temporarily unavailable");
    }
    if (priorReceipt !== null) {
      const receipt = validateReceipt(priorReceipt, commandScope);
      if (receipt.intentId !== candidate.intentId) throw genericSignupFailure();
      const fingerprint = verifyFingerprint(safe, receipt.intentId);
      if (!safeEqual(receipt.fingerprint, fingerprint)) {
        throw conflict("Passkey signup command was already used");
      }
      if (receipt.resultRevision !== safe.expectedRevision + 1) {
        const current = await this.#loadIntent(receipt.intentId);
        validateAuthorizationBinding(candidate, current);
        throw currentRevisionConflict(current.state, current.revision);
      }
      if (receipt.resultState !== "consumed") throw genericSignupFailure();
      const committed = await this.#loadIntent(receipt.intentId);
      return this.#replayCommitted(safe, candidate, receipt, committed);
    }

    const intent = await this.#loadIntent(candidate.intentId, true);
    validateAuthorizationBinding(candidate, intent);
    if (intent.state !== "pending") throw currentRevisionConflict(intent.state, intent.revision);
    if (safe.expectedRevision !== intent.revision) {
      throw currentRevisionConflict(intent.state, intent.revision);
    }
    if (intent.attemptsUsed >= intent.maxAttempts) throw genericSignupFailure();

    const fingerprint = verifyFingerprint(safe, intent.intentId);
    const beforeChallengeMs = currentTimeMilliseconds(this.#clock);
    if (beforeChallengeMs >= intent.expiresAtMs) {
      await this.#commitExpired(intent, commandScope, fingerprint, beforeChallengeMs);
      throw genericSignupFailure();
    }
    if (beforeChallengeMs < intent.updatedAtMs) throw genericSignupFailure();
    try {
      const active = await this.#authorizations.verifyActive(safe.signupAuthorization);
      validateAuthorizationBinding(active, intent);
    } catch {
      throw genericSignupFailure();
    }

    let challenge: string | null;
    try {
      challenge = await this.#store.resolve(intent.challenge.reference);
    } catch {
      throw serviceUnavailable("Passkey signup is temporarily unavailable");
    }
    if (!validChallenge(challenge, intent.challenge.digest)) throw genericSignupFailure();

    let verification: BootstrapRegistrationVerifierResult;
    try {
      verification = await this.#adapter.verifyBootstrapRegistration(
        safe.response.credential,
        ceremony(intent, challenge)
      );
    } catch {
      throw serviceUnavailable("Passkey verification is temporarily unavailable");
    }
    const verifiedAtMs = currentTimeMilliseconds(this.#clock);
    if (verifiedAtMs >= intent.expiresAtMs) {
      await this.#commitExpired(intent, commandScope, fingerprint, verifiedAtMs);
      throw genericSignupFailure();
    }
    if (exactVerifierRejection(verification)) {
      await this.#commitRejectedAttempt(intent, commandScope, fingerprint, verifiedAtMs);
      throw genericSignupFailure();
    }
    const credential = snapshotVerifiedRegistration(verification, intent);

    let disabledHash: string;
    try {
      disabledHash = await this.#passwords.createDisabledHash();
    } catch {
      throw serviceUnavailable("Passkey signup is temporarily unavailable");
    }
    if (!PASSKEY_DISABLED_PASSWORD_HASH_PATTERN.test(disabledHash)) {
      throw serviceUnavailable("Passkey signup is temporarily unavailable");
    }

    const committedAtMs = currentTimeMilliseconds(this.#clock);
    if (committedAtMs >= intent.expiresAtMs) {
      await this.#commitExpired(intent, commandScope, fingerprint, committedAtMs);
      throw genericSignupFailure();
    }
    if (committedAtMs < intent.updatedAtMs) throw genericSignupFailure();

    const credentialRecordId = nextCanonicalId(this.#nextId);
    const sessionId = nextCanonicalId(this.#nextId);
    const refreshTokenId = nextCanonicalId(this.#nextId);
    const createdAt = isoTimestamp(committedAtMs);
    const sessionExpiresAtMs = committedAtMs
      + candidate.sessionTtlSeconds * MILLISECONDS_PER_SECOND;
    if (!safeInteger(sessionExpiresAtMs, committedAtMs + 1)) {
      throw serviceUnavailable("Passkey signup is temporarily unavailable");
    }
    const expiresAt = isoTimestamp(sessionExpiresAtMs);
    const issuedAtSec = Math.floor(committedAtMs / MILLISECONDS_PER_SECOND);
    const expiresAtSec = issuedAtSec + candidate.accessTokenTtlSeconds;
    const refreshInput = Object.freeze({
      intentId: intent.intentId,
      accountId: intent.candidate.accountId,
      sessionId,
      deliveryNonce: candidate.deliveryNonce
    });
    let refresh: DerivedPasskeySignupRefreshToken;
    let access: { readonly token: string; readonly tokenId: string };
    try {
      refresh = this.#refreshTokens.rederive(
        refreshInput,
        candidate.refreshDerivationKeyId
      );
      access = await this.#accessTokens.signDeterministicAccessToken({
        userId: intent.candidate.accountId,
        sessionId,
        tokenId: intent.intentId,
        issuedAtSec,
        expiresAtSec
      });
    } catch {
      throw serviceUnavailable("Passkey signup is temporarily unavailable");
    }
    if (
      access.tokenId !== intent.intentId
      || refresh.keyId !== candidate.refreshDerivationKeyId
      || !safeEqual(refresh.deliveryNonceDigest, intent.deliveryNonceDigest)
    ) throw serviceUnavailable("Passkey signup is temporarily unavailable");
    const readyToCommitAtMs = currentTimeMilliseconds(this.#clock);
    if (readyToCommitAtMs >= intent.expiresAtMs) {
      await this.#commitExpired(intent, commandScope, fingerprint, readyToCommitAtMs);
      throw genericSignupFailure();
    }
    if (
      readyToCommitAtMs < committedAtMs
      || Math.floor(readyToCommitAtMs / MILLISECONDS_PER_SECOND) >= expiresAtSec
    ) throw genericSignupFailure();

    const consumed = mutation(this.#nextId, {
      intentId: intent.intentId,
      revision: intent.revision + 1,
      state: "consumed",
      type: "passkey.signup.consumed",
      commandScope,
      fingerprint,
      occurredAtMs: committedAtMs
    });
    const persist = Object.freeze({
      intentId: intent.intentId,
      expectedRevision: intent.revision,
      committedAtMs,
      candidate: Object.freeze({
        ...intent.candidate,
        userHandle: new Uint8Array(intent.candidate.userHandle)
      }),
      credential: Object.freeze({
        credentialRecordId,
        ...credential
      }),
      passwordAuth: Object.freeze({ enabled: false as const, disabledHash }),
      session: Object.freeze({
        id: sessionId,
        userId: intent.candidate.accountId,
        deviceName: candidate.deviceName,
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
      accessToken: Object.freeze({ tokenId: intent.intentId, issuedAtSec, expiresAtSec }),
      ...consumed
    }) satisfies PersistVerifiedPasskeySignup;

    try {
      await this.#store.commitVerifiedPasskeySignup(persist);
    } catch (error) {
      const reconciled = await this.#reconcileVerifiedCommit(
        safe,
        candidate,
        commandScope,
        fingerprint,
        intent
      );
      if (reconciled !== null) return reconciled;
      if (error instanceof StoreCredentialConflictError) throw genericSignupConflict();
      if (error instanceof StoreRevisionConflictError) {
        let current: PasskeySignupIntentRecord;
        try {
          current = await this.#loadIntent(intent.intentId);
        } catch {
          throw serviceUnavailable("Passkey signup is temporarily unavailable");
        }
        validateAuthorizationBinding(candidate, current);
        const conflictObservedAtMs = currentTimeMilliseconds(this.#clock);
        if (
          current.state === "pending"
          && conflictObservedAtMs >= current.expiresAtMs
        ) {
          await this.#commitExpired(current, commandScope, fingerprint, conflictObservedAtMs);
          throw genericSignupFailure();
        }
        if (current.state === "pending" && current.revision === intent.revision) {
          // The Store coarsens candidate-account, username, handle and generated
          // identifier collisions into the same result.
          throw genericSignupConflict();
        }
        throw currentRevisionConflict(current.state, current.revision);
      }
      throw serviceUnavailable("Passkey signup is temporarily unavailable");
    }

    const committed = await this.#loadIntent(intent.intentId);
    let consumption: PasskeySignupConsumptionRecord | null;
    let user: UserRecord | null;
    try {
      [consumption, user] = await Promise.all([
        this.#store.findPasskeySignupConsumption(intent.intentId),
        Promise.resolve(this.#store.findUserById(intent.candidate.accountId))
      ]);
    } catch {
      throw serviceUnavailable("Passkey signup is temporarily unavailable");
    }
    if (
      committed.state !== "consumed"
      || consumption === null
      || user === null
      || user.passwordAuthEnabled !== false
    ) throw internalRecordFailure();
    return verifyResponse(
      committed,
      user,
      consumption,
      access.token,
      refresh.raw,
      candidate.accessTokenTtlSeconds,
      false
    );
  }

  async #loadIntent(intentId: string, missingIsPublicFailure = false): Promise<PasskeySignupIntentRecord> {
    let intent: PasskeySignupIntentRecord | null;
    try {
      intent = await this.#store.findPasskeySignupIntent(intentId);
    } catch {
      throw serviceUnavailable("Passkey signup is temporarily unavailable");
    }
    if (intent === null) {
      if (missingIsPublicFailure) throw genericSignupFailure();
      throw internalRecordFailure();
    }
    validateIntent(intent);
    return intent;
  }

  async #replayBegin(
    receipt: PasskeySignupReceiptRecord,
    input: SafeBeginInput
  ): Promise<PasskeySignupBeginResponse> {
    if (receipt.resultState !== "pending" || receipt.resultRevision !== 1) {
      throw conflict("Passkey signup is no longer pending");
    }
    const intent = await this.#loadIntent(receipt.intentId);
    if (
      intent.state !== "pending"
      || intent.revision !== 1
      || !safeEqual(input.deliveryNonceDigest, intent.deliveryNonceDigest)
      || currentTimeMilliseconds(this.#clock) >= intent.expiresAtMs
    ) throw conflict("Passkey signup is no longer pending");
    let challenge: string | null;
    try {
      challenge = await this.#store.resolve(intent.challenge.reference);
    } catch {
      throw serviceUnavailable("Passkey signup is temporarily unavailable");
    }
    if (!validChallenge(challenge, intent.challenge.digest)) {
      throw serviceUnavailable("Passkey signup is temporarily unavailable");
    }
    try {
      const [options, authorization] = await Promise.all([
        this.#adapter.createBootstrapRegistrationOptions(ceremony(intent, challenge)),
        this.#authorizations.issue(authorizationIssueInput(intent, {
          deliveryNonce: input.deliveryNonce,
          deviceName: input.deviceName,
          refreshDerivationKeyId: this.#refreshTokens.activeKeyId,
          ...this.#policy
        }))
      ]);
      return beginResponse(intent, authorization, options, true);
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw serviceUnavailable("Passkey signup is temporarily unavailable");
    }
  }

  async #reconcileBeginCommit(
    scopes: BeginScopes,
    issuedChallengeReference: string,
    input: SafeBeginInput
  ): Promise<PasskeySignupBeginResponse | null> {
    let command: PasskeySignupReceiptRecord | null;
    let creation: PasskeySignupReceiptRecord | null;
    try {
      [command, creation] = await Promise.all([
        this.#store.findPasskeySignupCommandReceipt(scopes.commandScope),
        this.#store.findPasskeySignupCreationReceipt(scopes.creationScope)
      ]);
    } catch {
      return null;
    }
    const winner = command ?? creation;
    if (winner === null) {
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
      throw conflict("Passkey signup idempotency key was already used");
    }
    const committed = await this.#loadIntent(receipt.intentId);
    if (committed.challenge.reference !== issuedChallengeReference) {
      await this.#discardBestEffort(issuedChallengeReference);
    }
    return this.#replayBegin(receipt, input);
  }

  async #commitRejectedAttempt(
    intent: PasskeySignupIntentRecord,
    commandScope: string,
    fingerprint: string,
    observedAtMs: number
  ): Promise<void> {
    const updatedAtMs = Math.max(observedAtMs, currentTimeMilliseconds(this.#clock));
    if (updatedAtMs >= intent.expiresAtMs) {
      await this.#commitExpired(intent, commandScope, fingerprint, updatedAtMs);
      return;
    }
    const nextState = intent.attemptsUsed + 1 >= intent.maxAttempts ? "rejected" : "pending";
    const rejected = mutation(this.#nextId, {
      intentId: intent.intentId,
      revision: intent.revision + 1,
      state: nextState,
      type: nextState === "rejected"
        ? "passkey.signup.attempts_exhausted"
        : "passkey.signup.verification_rejected",
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
    }) satisfies PersistPasskeySignupRejectedAttempt;
    try {
      await this.#store.commitPasskeySignupRejectedAttempt(persist);
    } catch {
      try {
        const receipt = await this.#store.findPasskeySignupCommandReceipt(commandScope);
        if (receipt !== null) {
          const authoritative = validateReceipt(receipt, commandScope);
          if (safeEqual(authoritative.fingerprint, fingerprint)) return;
        }
      } catch {
        // The public result is deliberately the same generic rejection.
      }
    }
  }

  async #commitExpired(
    intent: PasskeySignupIntentRecord,
    commandScope: string,
    fingerprint: string,
    observedAtMs: number
  ): Promise<void> {
    if (intent.state !== "pending" || observedAtMs < intent.expiresAtMs) return;
    const expired = mutation(this.#nextId, {
      intentId: intent.intentId,
      revision: intent.revision + 1,
      state: "expired",
      type: "passkey.signup.expired",
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
    }) satisfies PersistPasskeySignupExpired;
    try {
      await this.#store.commitPasskeySignupExpired(persist);
    } catch {
      try {
        const receipt = await this.#store.findPasskeySignupCommandReceipt(commandScope);
        if (receipt !== null) {
          const authoritative = validateReceipt(receipt, commandScope);
          if (
            authoritative.intentId === intent.intentId
            && authoritative.resultState === "expired"
            && safeEqual(authoritative.fingerprint, fingerprint)
          ) return;
        }
      } catch {
        // The public result remains the same generic rejection.
      }
    }
  }

  async #reconcileVerifiedCommit(
    input: SafeVerifyInput,
    candidate: VerifiedPasskeySignupAuthorization,
    commandScope: string,
    fingerprint: string,
    originalIntent: PasskeySignupIntentRecord
  ): Promise<PasskeySignupVerifyResponse | null> {
    let receipt: PasskeySignupReceiptRecord | null;
    try {
      receipt = await this.#store.findPasskeySignupCommandReceipt(commandScope);
    } catch {
      return null;
    }
    if (receipt === null) return null;
    const authoritative = validateReceipt(receipt, commandScope);
    if (
      authoritative.intentId !== originalIntent.intentId
      || authoritative.resultState !== "consumed"
      || !safeEqual(authoritative.fingerprint, fingerprint)
    ) return null;
    const committed = await this.#loadIntent(originalIntent.intentId);
    return this.#replayCommitted(input, candidate, authoritative, committed);
  }

  async #replayCommitted(
    input: SafeVerifyInput,
    candidate: VerifiedPasskeySignupAuthorization,
    receipt: PasskeySignupReceiptRecord,
    intent: PasskeySignupIntentRecord
  ): Promise<PasskeySignupVerifyResponse> {
    validateIntent(intent);
    validateAuthorizationBinding(candidate, intent);
    if (
      intent.state !== "consumed"
      || intent.terminalReason !== "verified"
      || intent.terminalAtMs === null
      || receipt.resultState !== "consumed"
      || receipt.resultRevision !== intent.revision
      || receipt.resultRevision !== input.expectedRevision + 1
    ) throw genericSignupFailure();
    const expectedFingerprint = verifyFingerprint(input, intent.intentId);
    if (!safeEqual(receipt.fingerprint, expectedFingerprint)) {
      throw conflict("Passkey signup command was already used");
    }
    try {
      await this.#authorizations.verifyCommittedReplay(
        input.signupAuthorization,
        authorizationIssueInput(intent, {
          deliveryNonce: candidate.deliveryNonce,
          deviceName: candidate.deviceName,
          refreshDerivationKeyId: candidate.refreshDerivationKeyId,
          accessTokenTtlSeconds: candidate.accessTokenTtlSeconds,
          sessionTtlSeconds: candidate.sessionTtlSeconds,
          recoveryGraceSeconds: candidate.recoveryDeadline - candidate.expiresAt
        })
      );
    } catch {
      throw genericSignupFailure();
    }

    let consumption: PasskeySignupConsumptionRecord | null;
    try {
      consumption = await this.#store.findPasskeySignupConsumption(intent.intentId);
    } catch {
      throw serviceUnavailable("Passkey signup is temporarily unavailable");
    }
    if (
      consumption === null
      || consumption.intentId !== intent.intentId
      || consumption.resultRevision !== intent.revision
      || consumption.accountId !== intent.candidate.accountId
      || consumption.userHandleRef !== intent.candidate.userHandleRef
      || consumption.credentialRecordId !== intent.resolvedCredentialRecordId
      || consumption.committedAtMs !== intent.terminalAtMs
      || consumption.refreshDerivationKeyId !== candidate.refreshDerivationKeyId
      || !canonicalUuid(consumption.sessionId)
      || !canonicalUuid(consumption.initialRefreshTokenId)
    ) throw genericSignupFailure();

    const nowMs = currentTimeMilliseconds(this.#clock);
    const nowSec = Math.floor(nowMs / MILLISECONDS_PER_SECOND);
    const issuedAtSec = Math.floor(consumption.committedAtMs / MILLISECONDS_PER_SECOND);
    if (
      consumption.initialAccessTokenExpiresAtSec
        !== issuedAtSec + candidate.accessTokenTtlSeconds
      || nowSec >= consumption.initialAccessTokenExpiresAtSec
    ) throw genericSignupFailure();

    let refresh: DerivedPasskeySignupRefreshToken;
    try {
      refresh = this.#refreshTokens.rederive({
        intentId: intent.intentId,
        accountId: consumption.accountId,
        sessionId: consumption.sessionId,
        deliveryNonce: candidate.deliveryNonce
      }, consumption.refreshDerivationKeyId);
    } catch {
      throw genericSignupFailure();
    }
    if (
      refresh.keyId !== consumption.refreshDerivationKeyId
      || !safeEqual(refresh.deliveryNonceDigest, intent.deliveryNonceDigest)
    ) throw genericSignupFailure();

    let refreshRow: (RefreshTokenRecord & { session: SessionRecord }) | null;
    let user: UserRecord | null;
    let sessionActive: boolean;
    const expectedCreatedAt = isoTimestamp(consumption.committedAtMs);
    const expectedExpiresAt = isoTimestamp(
      consumption.committedAtMs + candidate.sessionTtlSeconds * MILLISECONDS_PER_SECOND
    );
    try {
      refreshRow = this.#store.findRefreshToken(refresh.hash);
      user = this.#store.findUserById(consumption.accountId);
      sessionActive = this.#store.isSessionActive(
        consumption.sessionId,
        consumption.accountId,
        isoTimestamp(nowMs)
      );
    } catch {
      throw serviceUnavailable("Passkey signup is temporarily unavailable");
    }
    if (
      refreshRow === null
      || refreshRow.id !== consumption.initialRefreshTokenId
      || refreshRow.sessionId !== consumption.sessionId
      || !safeEqual(refreshRow.tokenHash, refresh.hash)
      || refreshRow.createdAt !== expectedCreatedAt
      || refreshRow.expiresAt !== expectedExpiresAt
      || refreshRow.expiresAt <= isoTimestamp(nowMs)
      || refreshRow.usedAt !== null
      || refreshRow.session.id !== consumption.sessionId
      || refreshRow.session.userId !== consumption.accountId
      || refreshRow.session.deviceName !== candidate.deviceName
      || refreshRow.session.createdAt !== expectedCreatedAt
      || refreshRow.session.expiresAt !== expectedExpiresAt
      || refreshRow.session.revokedAt !== null
      || !sessionActive
      || user === null
      || user.id !== intent.candidate.accountId
      || user.username !== intent.candidate.username
      || user.usernameNormalized !== intent.candidate.usernameNormalized
      || user.displayName !== intent.candidate.displayName
      || user.passwordAuthEnabled !== false
    ) throw genericSignupFailure();

    let access: { readonly token: string; readonly tokenId: string };
    try {
      access = await this.#accessTokens.signDeterministicAccessToken({
        userId: consumption.accountId,
        sessionId: consumption.sessionId,
        tokenId: intent.intentId,
        issuedAtSec,
        expiresAtSec: consumption.initialAccessTokenExpiresAtSec
      });
    } catch {
      throw serviceUnavailable("Passkey signup is temporarily unavailable");
    }
    if (access.tokenId !== intent.intentId) {
      throw serviceUnavailable("Passkey signup is temporarily unavailable");
    }
    return verifyResponse(
      intent,
      user,
      consumption,
      access.token,
      refresh.raw,
      consumption.initialAccessTokenExpiresAtSec - nowSec,
      true
    );
  }

  async #discardBestEffort(reference: string): Promise<void> {
    try {
      await this.#store.discard(reference);
    } catch {
      // Leases are TTL bounded; cleanup failure never changes the operation result.
    }
  }
}
