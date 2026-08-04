import { timingSafeEqual } from "node:crypto";

import type {
  AuthenticationVerificationExpectations,
  CredentialBoundary,
  DiscoverableAnyCredentialBoundary,
  DiscoverableLoginVerificationExpectations,
  DiscoverableLoginVerifierRejection,
  MaintainedDiscoverableLoginVerifierAdapter,
  MaintainedWebAuthnVerifierAdapter,
  RegistrationVerificationExpectations,
  VerifierRejection
} from "@luxora/passkey-domain";
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type GenerateAuthenticationOptionsOpts,
  type GenerateRegistrationOptionsOpts,
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
  type RegistrationResponseJSON,
  type VerifyAuthenticationResponseOpts,
  type VerifyRegistrationResponseOpts
} from "@simplewebauthn/server";
import { cose, decodeCredentialPublicKey } from "@simplewebauthn/server/helpers";
import { z } from "zod";

const SIMPLEWEBAUTHN_VERSION = "13.3.2";
const MAX_WEBAUTHN_FIELD_LENGTH = 90_000;
const MAX_CREDENTIAL_ID_BYTES = 1_023;
const MAX_PUBLIC_KEY_BYTES = 4_096;
const USER_HANDLE_BYTES = 32;
const MAX_ACCOUNT_CREDENTIALS = 20;
const TRANSPORTS = ["ble", "cable", "hybrid", "internal", "nfc", "smart-card", "usb"] as const;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;
const CANONICAL_RFC_UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const USERNAME_PATTERN = /^[A-Za-z][A-Za-z0-9_]{2,31}$/;

/**
 * SimpleWebAuthn 13.3.2 treats a non-advancing counter as a hard verification
 * failure when the persisted counter is supplied. WebAuthn counters are only a
 * risk signal for Luxora: synced authenticators can legitimately reset or reuse
 * them, and that must not lock an account out. Supplying the neutral baseline
 * disables only that library policy check. The observed counter remains inside
 * signed authenticatorData; this adapter exposes the verifier's returned value
 * only after `verified` is true, then the transactional risk/CAS layer compares
 * it with the separately retained persisted value.
 */
const MAINTAINED_VERIFIER_COUNTER_BASELINE = 0;

type AllowedAlgorithm = -7 | -257;
type AuthenticatorTransport = (typeof TRANSPORTS)[number];

const invalidResponse = (): VerifierRejection => Object.freeze({
  status: "rejected",
  reason: "invalid_webauthn_response"
});

const policyRejected = (): VerifierRejection => Object.freeze({
  status: "rejected",
  reason: "policy_rejected"
});

const discoverableLoginRejected = (): DiscoverableLoginVerifierRejection => Object.freeze({
  status: "rejected",
  reason: "invalid_webauthn_response"
});

/** Opaque on purpose: causes, responses, challenges and repository values never cross this error boundary. */
export class PasskeyVerifierUnavailableError extends Error {
  constructor() {
    super("passkey verifier unavailable");
    this.name = "PasskeyVerifierUnavailableError";
  }
}

export interface StoredPasskeyUserHandle {
  readonly userHandleRef: string;
  readonly accountId: string;
  /** Plaintext exists only at this adapter boundary; persistence must encrypt it at rest. */
  readonly userHandle: Uint8Array;
}

export interface StoredPasskeyCredential {
  readonly credentialRecordId: string;
  readonly credentialRevision: number;
  readonly credentialId: string;
  readonly publicKey: Uint8Array;
  readonly algorithm: AllowedAlgorithm;
  readonly accountId: string;
  readonly userHandleRef: string;
  readonly discoveryMode: "discoverable" | "non_discoverable";
  /** Null for discoverable Beta-0.1 credentials; an opaque secure record ref otherwise. */
  readonly credentialSetRef: string | null;
  readonly signCount: number;
  readonly backupEligible: boolean;
  readonly backupState: boolean;
  readonly transports: readonly AuthenticatorTransport[];
}

/**
 * Implement this as a narrow Store/cipher mapper. Lookups must be exact and must not log arguments,
 * return values, misses, or thrown causes.
 */
export interface PasskeyCredentialRepository {
  findPasskeyUserHandleByRef(userHandleRef: string): Promise<StoredPasskeyUserHandle | null>;
  findPasskeyCredentialById(credentialId: string): Promise<StoredPasskeyCredential | null>;
  findPasskeyCredentialByRecordId(credentialRecordId: string): Promise<StoredPasskeyCredential | null>;
  listPasskeyCredentialsByAccountId(accountId: string): Promise<readonly StoredPasskeyCredential[]>;
}

export interface RegistrationOptionsInput {
  readonly rpName: string;
  readonly userName: string;
  readonly userDisplayName: string;
  readonly expectedChallenge: string;
  readonly expectedRpId: string;
  readonly timeoutMs: number;
  readonly allowedAlgorithms: readonly AllowedAlgorithm[];
  readonly expectedAccountId: string;
  readonly expectedUserHandleRef: string;
}

export interface AuthenticationOptionsInput {
  readonly expectedChallenge: string;
  readonly expectedRpId: string;
  readonly timeoutMs: number;
  readonly allowedAlgorithms: readonly AllowedAlgorithm[];
  readonly expectedAccountId: string;
  readonly credentialBoundary: CredentialBoundary;
}

export interface DiscoverableLoginOptionsInput {
  readonly expectedChallenge: string;
  readonly expectedRpId: string;
  readonly timeoutMs: number;
  readonly credentialBoundary: DiscoverableAnyCredentialBoundary;
}

/**
 * Server-owned ceremony state for passkey-first account bootstrap. This port is
 * intentionally repository-free: neither the candidate account nor its user
 * handle exists durably until the Store transaction commits both together
 * with the verified first credential.
 */
export interface BootstrapRegistrationCeremony {
  readonly kind: "bootstrap_registration";
  readonly rpName: string;
  readonly userName: string;
  readonly userDisplayName: string;
  readonly expectedChallenge: string;
  readonly expectedRpId: string;
  readonly expectedOrigin: string;
  readonly expectedTopOrigins: readonly [];
  readonly crossOriginAllowed: false;
  readonly timeoutMs: number;
  readonly requireUserPresence: true;
  readonly requireUserVerification: true;
  readonly attestation: "none";
  readonly residentKey: "required";
  readonly allowedAlgorithms: readonly [-7, -257];
  readonly excludeCredentials: readonly [];
  readonly candidateAccountId: string;
  readonly userHandleRef: string;
  /** Exact server-generated 32-byte WebAuthn user ID; never sourced from the client response. */
  readonly expectedUserHandle: Uint8Array;
}

export interface BootstrapRegistrationVerifierSuccess {
  readonly status: "verified";
  readonly kind: "bootstrap_registration";
  readonly candidate: {
    readonly accountId: string;
    readonly userHandleRef: string;
    /** Server-owned ceremony value. WebAuthn registration responses do not echo a user handle. */
    readonly expectedUserHandle: Uint8Array;
    readonly userName: string;
    readonly userDisplayName: string;
  };
  readonly credential: {
    readonly credentialId: string;
    readonly publicKey: Uint8Array;
    readonly algorithm: AllowedAlgorithm;
    readonly discoveryMode: "discoverable";
    readonly signCount: number;
    readonly backupEligible: boolean;
    readonly backupState: boolean;
    readonly transports: readonly AuthenticatorTransport[];
    readonly userPresent: true;
    readonly userVerified: true;
  };
}

export type BootstrapRegistrationVerifierResult = BootstrapRegistrationVerifierSuccess | VerifierRejection;

/** Injectable only so contract tests can prove the wrapper's fail-closed behavior. */
export interface SimpleWebAuthnPrimitives {
  generateRegistrationOptions(options: GenerateRegistrationOptionsOpts): Promise<unknown>;
  generateAuthenticationOptions(options: GenerateAuthenticationOptionsOpts): Promise<unknown>;
  verifyRegistrationResponse(options: VerifyRegistrationResponseOpts): Promise<unknown>;
  verifyAuthenticationResponse(options: VerifyAuthenticationResponseOpts): Promise<unknown>;
  decodeCredentialPublicKey(publicKey: Uint8Array<ArrayBuffer>): unknown;
}

const maintainedPrimitives: SimpleWebAuthnPrimitives = Object.freeze({
  generateRegistrationOptions,
  generateAuthenticationOptions,
  verifyRegistrationResponse,
  verifyAuthenticationResponse,
  decodeCredentialPublicKey
});

const base64urlSchema = z.string().min(1).max(MAX_WEBAUTHN_FIELD_LENGTH).regex(BASE64URL_PATTERN);
const transportSchema = z.enum(TRANSPORTS);
const descriptorSchema = z.object({
  id: base64urlSchema,
  type: z.literal("public-key"),
  transports: z.array(transportSchema).max(TRANSPORTS.length).optional()
}).strict();

const registrationResponseSchema = z.object({
  id: base64urlSchema,
  rawId: base64urlSchema,
  response: z.object({
    clientDataJSON: base64urlSchema,
    attestationObject: base64urlSchema,
    authenticatorData: base64urlSchema.optional(),
    transports: z.array(transportSchema).max(TRANSPORTS.length).optional(),
    publicKeyAlgorithm: z.number().int().optional(),
    publicKey: base64urlSchema.optional()
  }).strict(),
  authenticatorAttachment: z.enum(["cross-platform", "platform"]).optional(),
  clientExtensionResults: z.record(z.unknown()),
  type: z.string().min(1).max(64)
}).strict();

const authenticationResponseSchema = z.object({
  id: base64urlSchema,
  rawId: base64urlSchema,
  response: z.object({
    clientDataJSON: base64urlSchema,
    authenticatorData: base64urlSchema,
    signature: base64urlSchema,
    userHandle: base64urlSchema.optional()
  }).strict(),
  authenticatorAttachment: z.enum(["cross-platform", "platform"]).optional(),
  clientExtensionResults: z.record(z.unknown()),
  type: z.string().min(1).max(64)
}).strict();

const creationOptionsSchema = z.object({
  rp: z.object({ id: z.string(), name: z.string() }).strict(),
  user: z.object({ id: base64urlSchema, name: z.string(), displayName: z.string() }).strict(),
  challenge: base64urlSchema,
  pubKeyCredParams: z.array(z.object({ alg: z.number().int(), type: z.literal("public-key") }).strict()),
  timeout: z.number().int().positive().optional(),
  excludeCredentials: z.array(descriptorSchema).optional(),
  authenticatorSelection: z.object({
    authenticatorAttachment: z.enum(["cross-platform", "platform"]).optional(),
    residentKey: z.enum(["discouraged", "preferred", "required"]).optional(),
    requireResidentKey: z.boolean().optional(),
    userVerification: z.enum(["discouraged", "preferred", "required"]).optional()
  }).strict().optional(),
  hints: z.array(z.enum(["hybrid", "security-key", "client-device"])).optional(),
  attestation: z.enum(["direct", "enterprise", "indirect", "none"]).optional(),
  attestationFormats: z.array(z.string()).optional(),
  extensions: z.record(z.unknown()).optional()
}).strict();

const requestOptionsSchema = z.object({
  challenge: base64urlSchema,
  timeout: z.number().int().positive().optional(),
  rpId: z.string().optional(),
  allowCredentials: z.array(descriptorSchema).optional(),
  userVerification: z.enum(["discouraged", "preferred", "required"]).optional(),
  hints: z.array(z.enum(["hybrid", "security-key", "client-device"])).optional(),
  extensions: z.record(z.unknown()).optional()
}).strict();

function unavailable(): never {
  throw new PasskeyVerifierUnavailableError();
}

async function opaqueAdapterBoundary<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch {
    unavailable();
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasExactKeys(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): boolean {
  const keys = Object.keys(value);
  const allowed = new Set([...required, ...optional]);
  return required.every((key) => Object.hasOwn(value, key)) && keys.every((key) => allowed.has(key));
}

function hasExactDataKeys(
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = []
): value is Record<string, unknown> {
  if (!isPlainObject(value)) return false;
  const allowed = new Set([...required, ...optional]);
  const keys = Reflect.ownKeys(value);
  if (
    keys.some((key) => typeof key !== "string" || !allowed.has(key))
    || required.some((key) => !keys.includes(key))
  ) return false;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  return keys.every((key) => {
    if (typeof key !== "string") return false;
    const descriptor = descriptors[key];
    return descriptor !== undefined && "value" in descriptor && descriptor.enumerable === true;
  });
}

function assertExactObjectKeys(value: unknown, required: readonly string[]): void {
  if (!isPlainObject(value) || !hasExactKeys(value, required)) unavailable();
}

function assertExactDataObjectKeys(value: unknown, required: readonly string[]): asserts value is Record<string, unknown> {
  if (!hasExactDataKeys(value, required)) unavailable();
}

function isBoundedOpaque(value: unknown): value is string {
  return typeof value === "string" && value.length >= 1 && value.length <= 192;
}

function isUint32(value: unknown): value is number {
  return Number.isInteger(value) && typeof value === "number" && value >= 0 && value <= 0xffff_ffff;
}

function arrayBufferCopy(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  const copy = new Uint8Array(new ArrayBuffer(bytes.byteLength));
  copy.set(bytes);
  return copy;
}

function decodeCanonicalBase64url(value: string, maxBytes: number): Uint8Array<ArrayBuffer> | null {
  if (!BASE64URL_PATTERN.test(value)) return null;
  const decoded = Buffer.from(value, "base64url");
  if (decoded.byteLength < 1 || decoded.byteLength > maxBytes || decoded.toString("base64url") !== value) return null;
  return arrayBufferCopy(decoded);
}

function assertCanonicalChallenge(value: unknown): asserts value is string {
  if (typeof value !== "string" || decodeCanonicalBase64url(value, USER_HANDLE_BYTES)?.byteLength !== USER_HANDLE_BYTES) unavailable();
}

function assertRpId(value: unknown): asserts value is string {
  if (
    typeof value !== "string"
    || value.length < 1
    || value.length > 253
    || value !== value.toLowerCase()
    || value.includes(":")
    || !/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(value)
  ) unavailable();
}

function assertOrigin(value: unknown, expectedRpId: string): asserts value is string {
  if (typeof value !== "string") unavailable();
  try {
    const parsed = new URL(value);
    if (
      parsed.protocol !== "https:"
      || parsed.origin !== value
      || (parsed.hostname !== expectedRpId && !parsed.hostname.endsWith(`.${expectedRpId}`))
    ) unavailable();
  } catch {
    unavailable();
  }
}

function assertAlgorithms(value: readonly AllowedAlgorithm[]): void {
  if (
    !Array.isArray(value)
    || value.length !== 2
    || new Set(value).size !== value.length
    || !value.includes(-7)
    || !value.includes(-257)
  ) unavailable();
}

function isExactEmptyArray(value: unknown): value is readonly [] {
  return Array.isArray(value)
    && Object.getPrototypeOf(value) === Array.prototype
    && Reflect.ownKeys(value).length === 1
    && Reflect.ownKeys(value)[0] === "length"
    && value.length === 0;
}

function isExactBootstrapAlgorithmTuple(value: unknown): value is readonly [-7, -257] {
  if (
    !Array.isArray(value)
    || Object.getPrototypeOf(value) !== Array.prototype
    || value.length !== 2
    || Reflect.ownKeys(value).some((key) => key !== "0" && key !== "1" && key !== "length")
  ) return false;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const first = descriptors["0"];
  const second = descriptors["1"];
  return first !== undefined
    && "value" in first
    && first.enumerable === true
    && first.value === -7
    && second !== undefined
    && "value" in second
    && second.enumerable === true
    && second.value === -257;
}

function assertPurpose(value: unknown, expectedType: "authenticator.add" | "session.step_up" | "session.create"): void {
  if (
    !isPlainObject(value)
    || !hasExactKeys(value, ["type", "targetDigest"])
    || value["type"] !== expectedType
    || typeof value["targetDigest"] !== "string"
    || !/^[0-9a-f]{64}$/.test(value["targetDigest"])
  ) unavailable();
}

function assertRequestOptionsInput(input: {
  readonly expectedChallenge: string;
  readonly expectedRpId: string;
  readonly timeoutMs: number;
}): void {
  assertCanonicalChallenge(input.expectedChallenge);
  assertRpId(input.expectedRpId);
  if (!Number.isInteger(input.timeoutMs) || input.timeoutMs < 1 || input.timeoutMs > 600_000) unavailable();
}

function assertCommonOptionsInput(input: {
  readonly expectedChallenge: string;
  readonly expectedRpId: string;
  readonly timeoutMs: number;
  readonly allowedAlgorithms: readonly AllowedAlgorithm[];
  readonly expectedAccountId: string;
}): void {
  assertRequestOptionsInput(input);
  assertAlgorithms(input.allowedAlgorithms);
  if (!isBoundedOpaque(input.expectedAccountId)) unavailable();
}

function assertBootstrapRegistrationCeremony(input: BootstrapRegistrationCeremony): void {
  assertExactDataObjectKeys(input, [
    "kind", "rpName", "userName", "userDisplayName", "expectedChallenge", "expectedRpId",
    "expectedOrigin", "expectedTopOrigins", "crossOriginAllowed", "timeoutMs", "requireUserPresence",
    "requireUserVerification", "attestation", "residentKey", "allowedAlgorithms", "excludeCredentials",
    "candidateAccountId", "userHandleRef", "expectedUserHandle"
  ]);
  assertCanonicalChallenge(input.expectedChallenge);
  assertRpId(input.expectedRpId);
  assertOrigin(input.expectedOrigin, input.expectedRpId);
  if (
    input.kind !== "bootstrap_registration"
    || typeof input.rpName !== "string"
    || input.rpName.length < 1
    || input.rpName.length > 64
    || typeof input.userName !== "string"
    || !USERNAME_PATTERN.test(input.userName)
    || typeof input.userDisplayName !== "string"
    || input.userDisplayName.length < 1
    || input.userDisplayName.length > 80
    || input.userDisplayName.trim() !== input.userDisplayName
    || !isExactEmptyArray(input.expectedTopOrigins)
    || input.crossOriginAllowed !== false
    || !Number.isInteger(input.timeoutMs)
    || input.timeoutMs < 1
    || input.timeoutMs > 600_000
    || input.requireUserPresence !== true
    || input.requireUserVerification !== true
    || input.attestation !== "none"
    || input.residentKey !== "required"
    || !isExactBootstrapAlgorithmTuple(input.allowedAlgorithms)
    || !isExactEmptyArray(input.excludeCredentials)
    || typeof input.candidateAccountId !== "string"
    || !CANONICAL_RFC_UUID_PATTERN.test(input.candidateAccountId)
    || !isBoundedOpaque(input.userHandleRef)
    || !(input.expectedUserHandle instanceof Uint8Array)
    || Object.getPrototypeOf(input.expectedUserHandle) !== Uint8Array.prototype
    || input.expectedUserHandle.byteLength !== USER_HANDLE_BYTES
  ) unavailable();
}

function snapshotBootstrapRegistrationCeremony(input: BootstrapRegistrationCeremony): BootstrapRegistrationCeremony {
  assertBootstrapRegistrationCeremony(input);
  return Object.freeze({
    kind: input.kind,
    rpName: input.rpName,
    userName: input.userName,
    userDisplayName: input.userDisplayName,
    expectedChallenge: input.expectedChallenge,
    expectedRpId: input.expectedRpId,
    expectedOrigin: input.expectedOrigin,
    expectedTopOrigins: Object.freeze([]) as readonly [],
    crossOriginAllowed: input.crossOriginAllowed,
    timeoutMs: input.timeoutMs,
    requireUserPresence: input.requireUserPresence,
    requireUserVerification: input.requireUserVerification,
    attestation: input.attestation,
    residentKey: input.residentKey,
    allowedAlgorithms: Object.freeze([-7, -257]) as readonly [-7, -257],
    excludeCredentials: Object.freeze([]) as readonly [],
    candidateAccountId: input.candidateAccountId,
    userHandleRef: input.userHandleRef,
    expectedUserHandle: arrayBufferCopy(input.expectedUserHandle)
  });
}

function assertRegistrationExpectations(expectations: RegistrationVerificationExpectations): void {
  assertExactObjectKeys(expectations, [
    "kind", "expectedChallenge", "expectedRpId", "expectedOrigin", "expectedTopOrigins",
    "crossOriginAllowed", "requireUserPresence", "requireUserVerification", "attestation",
    "residentKey", "allowedAlgorithms", "expectedAccountId", "expectedUserHandleRef", "purpose",
    "maxResponseBytes", "responseByteLength"
  ]);
  assertCanonicalChallenge(expectations.expectedChallenge);
  assertRpId(expectations.expectedRpId);
  assertOrigin(expectations.expectedOrigin, expectations.expectedRpId);
  assertAlgorithms(expectations.allowedAlgorithms);
  if (
    expectations.kind !== "registration"
    || expectations.crossOriginAllowed !== false
    || !Array.isArray(expectations.expectedTopOrigins)
    || expectations.expectedTopOrigins.length !== 0
    || expectations.requireUserPresence !== true
    || expectations.requireUserVerification !== true
    || expectations.attestation !== "none"
    || expectations.residentKey !== "required"
    || !isBoundedOpaque(expectations.expectedAccountId)
    || !isBoundedOpaque(expectations.expectedUserHandleRef)
    || !Number.isInteger(expectations.maxResponseBytes)
    || expectations.maxResponseBytes < 1
    || expectations.maxResponseBytes > 65_536
    || !Number.isInteger(expectations.responseByteLength)
    || expectations.responseByteLength < 1
    || expectations.responseByteLength > expectations.maxResponseBytes
  ) unavailable();
  assertPurpose(expectations.purpose, "authenticator.add");
}

function assertAuthenticationExpectations(expectations: AuthenticationVerificationExpectations): void {
  assertExactObjectKeys(expectations, [
    "kind", "expectedChallenge", "expectedRpId", "expectedOrigin", "expectedTopOrigins",
    "crossOriginAllowed", "requireUserPresence", "requireUserVerification", "allowedAlgorithms",
    "expectedAccountId", "credentialBoundary", "purpose", "maxResponseBytes", "responseByteLength"
  ]);
  assertCanonicalChallenge(expectations.expectedChallenge);
  assertRpId(expectations.expectedRpId);
  assertOrigin(expectations.expectedOrigin, expectations.expectedRpId);
  assertAlgorithms(expectations.allowedAlgorithms);
  if (
    expectations.kind !== "authentication"
    || expectations.crossOriginAllowed !== false
    || !Array.isArray(expectations.expectedTopOrigins)
    || expectations.expectedTopOrigins.length !== 0
    || expectations.requireUserPresence !== true
    || expectations.requireUserVerification !== true
    || !isBoundedOpaque(expectations.expectedAccountId)
    || !Number.isInteger(expectations.maxResponseBytes)
    || expectations.maxResponseBytes < 1
    || expectations.maxResponseBytes > 65_536
    || !Number.isInteger(expectations.responseByteLength)
    || expectations.responseByteLength < 1
    || expectations.responseByteLength > expectations.maxResponseBytes
  ) unavailable();
  assertCredentialBoundary(expectations.credentialBoundary);
  assertPurpose(expectations.purpose, "session.step_up");
}

function assertDiscoverableAnyBoundary(boundary: DiscoverableAnyCredentialBoundary): void {
  if (
    !isPlainObject(boundary)
    || !hasExactKeys(boundary, ["mode", "credentialSetRef"])
    || boundary.mode !== "discoverable_any"
    || boundary.credentialSetRef !== null
  ) unavailable();
}

function assertDiscoverableLoginExpectations(expectations: DiscoverableLoginVerificationExpectations): void {
  assertExactObjectKeys(expectations, [
    "kind", "expectedChallenge", "expectedRpId", "expectedOrigin", "expectedTopOrigins",
    "crossOriginAllowed", "requireUserPresence", "requireUserVerification", "allowedAlgorithms",
    "credentialBoundary", "purpose", "maxResponseBytes", "responseByteLength"
  ]);
  assertCanonicalChallenge(expectations.expectedChallenge);
  assertRpId(expectations.expectedRpId);
  assertOrigin(expectations.expectedOrigin, expectations.expectedRpId);
  assertAlgorithms(expectations.allowedAlgorithms);
  if (
    expectations.kind !== "authentication"
    || expectations.crossOriginAllowed !== false
    || !Array.isArray(expectations.expectedTopOrigins)
    || expectations.expectedTopOrigins.length !== 0
    || expectations.requireUserPresence !== true
    || expectations.requireUserVerification !== true
    || !Number.isInteger(expectations.maxResponseBytes)
    || expectations.maxResponseBytes < 1
    || expectations.maxResponseBytes > 65_536
    || !Number.isInteger(expectations.responseByteLength)
    || expectations.responseByteLength < 1
    || expectations.responseByteLength > expectations.maxResponseBytes
  ) unavailable();
  assertDiscoverableAnyBoundary(expectations.credentialBoundary);
  assertPurpose(expectations.purpose, "session.create");
}

function assertCredentialBoundary(boundary: CredentialBoundary): void {
  if (!isPlainObject(boundary)) unavailable();
  if (boundary.mode === "discoverable") {
    if (!hasExactKeys(boundary, ["mode", "credentialSetRef"]) || boundary.credentialSetRef !== null) unavailable();
    return;
  }
  if (
    boundary.mode !== "non_discoverable"
    || !hasExactKeys(boundary, ["mode", "credentialSetRef"])
    || !isBoundedOpaque(boundary.credentialSetRef)
  ) unavailable();
}

function validateClientData(clientDataJSON: string): boolean {
  const bytes = decodeCanonicalBase64url(clientDataJSON, 16_384);
  if (bytes === null) return false;
  try {
    const decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    const clientData: unknown = JSON.parse(decoded);
    if (!isPlainObject(clientData)) return false;
    if (Object.hasOwn(clientData, "crossOrigin") && clientData["crossOrigin"] !== false) return false;
    if (Object.hasOwn(clientData, "topOrigin")) return false;
    return true;
  } catch {
    return false;
  }
}

function parseRegistrationResponse(response: unknown): RegistrationResponseJSON | null {
  const parsed = registrationResponseSchema.safeParse(response);
  if (!parsed.success) return null;
  if (parsed.data.id !== parsed.data.rawId || parsed.data.type !== "public-key") return null;
  if (decodeCanonicalBase64url(parsed.data.id, MAX_CREDENTIAL_ID_BYTES) === null) return null;
  if (!validateClientData(parsed.data.response.clientDataJSON)) return null;
  if (decodeCanonicalBase64url(parsed.data.response.attestationObject, 65_536) === null) return null;
  if (parsed.data.response.transports !== undefined && new Set(parsed.data.response.transports).size !== parsed.data.response.transports.length) return null;
  return parsed.data as RegistrationResponseJSON;
}

function parseAuthenticationResponse(response: unknown): AuthenticationResponseJSON | null {
  const parsed = authenticationResponseSchema.safeParse(response);
  if (!parsed.success) return null;
  if (parsed.data.id !== parsed.data.rawId || parsed.data.type !== "public-key") return null;
  if (decodeCanonicalBase64url(parsed.data.id, MAX_CREDENTIAL_ID_BYTES) === null) return null;
  if (!validateClientData(parsed.data.response.clientDataJSON)) return null;
  if (decodeCanonicalBase64url(parsed.data.response.authenticatorData, 65_536) === null) return null;
  if (decodeCanonicalBase64url(parsed.data.response.signature, 65_536) === null) return null;
  if (parsed.data.response.userHandle !== undefined && decodeCanonicalBase64url(parsed.data.response.userHandle, 64) === null) return null;
  return parsed.data as AuthenticationResponseJSON;
}

function validateUserHandle(value: unknown): StoredPasskeyUserHandle {
  if (
    !isPlainObject(value)
    || !hasExactKeys(value, ["userHandleRef", "accountId", "userHandle"])
    || !isBoundedOpaque(value["userHandleRef"])
    || !isBoundedOpaque(value["accountId"])
    || !(value["userHandle"] instanceof Uint8Array)
    || value["userHandle"].byteLength !== USER_HANDLE_BYTES
  ) unavailable();
  return {
    userHandleRef: value["userHandleRef"],
    accountId: value["accountId"],
    userHandle: arrayBufferCopy(value["userHandle"])
  };
}

function validateStoredCredential(value: unknown): StoredPasskeyCredential {
  const required = [
    "credentialRecordId", "credentialRevision", "credentialId", "publicKey", "algorithm", "accountId",
    "userHandleRef", "discoveryMode", "credentialSetRef", "signCount", "backupEligible", "backupState", "transports"
  ];
  if (!isPlainObject(value) || !hasExactKeys(value, required)) unavailable();
  const credentialId = value["credentialId"];
  const publicKey = value["publicKey"];
  const transports = value["transports"];
  if (
    !isBoundedOpaque(value["credentialRecordId"])
    || !Number.isSafeInteger(value["credentialRevision"])
    || typeof value["credentialRevision"] !== "number"
    || value["credentialRevision"] < 1
    || typeof credentialId !== "string"
    || decodeCanonicalBase64url(credentialId, MAX_CREDENTIAL_ID_BYTES) === null
    || !(publicKey instanceof Uint8Array)
    || publicKey.byteLength < 1
    || publicKey.byteLength > MAX_PUBLIC_KEY_BYTES
    || (value["algorithm"] !== -7 && value["algorithm"] !== -257)
    || !isBoundedOpaque(value["accountId"])
    || !isBoundedOpaque(value["userHandleRef"])
    || (value["discoveryMode"] !== "discoverable" && value["discoveryMode"] !== "non_discoverable")
    || (value["discoveryMode"] === "discoverable" ? value["credentialSetRef"] !== null : !isBoundedOpaque(value["credentialSetRef"]))
    || !isUint32(value["signCount"])
    || typeof value["backupEligible"] !== "boolean"
    || typeof value["backupState"] !== "boolean"
    || (value["backupEligible"] === false && value["backupState"] === true)
    || !Array.isArray(transports)
    || new Set(transports).size !== transports.length
    || transports.some((transport) => typeof transport !== "string" || !TRANSPORTS.includes(transport as AuthenticatorTransport))
  ) unavailable();
  return {
    credentialRecordId: value["credentialRecordId"],
    credentialRevision: value["credentialRevision"],
    credentialId,
    publicKey: arrayBufferCopy(publicKey),
    algorithm: value["algorithm"],
    accountId: value["accountId"],
    userHandleRef: value["userHandleRef"],
    discoveryMode: value["discoveryMode"],
    credentialSetRef: value["credentialSetRef"] as string | null,
    signCount: value["signCount"],
    backupEligible: value["backupEligible"],
    backupState: value["backupState"],
    transports: Object.freeze([...transports]) as readonly AuthenticatorTransport[]
  };
}

function readCoseAlgorithm(primitives: SimpleWebAuthnPrimitives, publicKey: Uint8Array): number {
  let decoded: unknown;
  try {
    decoded = primitives.decodeCredentialPublicKey(arrayBufferCopy(publicKey));
  } catch {
    unavailable();
  }
  if (!isPlainObject(decoded) && !(decoded instanceof Map)) unavailable();
  const get = Reflect.get(decoded, "get");
  if (typeof get !== "function") unavailable();
  let algorithm: unknown;
  try {
    algorithm = Reflect.apply(get, decoded, [cose.COSEKEYS.alg]);
  } catch {
    unavailable();
  }
  if (!Number.isInteger(algorithm) || typeof algorithm !== "number") unavailable();
  return algorithm;
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength && timingSafeEqual(left, right);
}

function equalTransports(left: readonly string[] | undefined, right: readonly string[]): boolean {
  const normalizedLeft = left ?? [];
  return normalizedLeft.length === right.length
    && normalizedLeft.every((transport, index) => transport === right[index]);
}

function assertCredentialMatchesBoundary(
  credential: StoredPasskeyCredential,
  accountId: string,
  boundary: CredentialBoundary
): boolean {
  if (credential.accountId !== accountId || credential.discoveryMode !== boundary.mode) return false;
  return boundary.mode === "discoverable"
    ? credential.credentialSetRef === null
    : credential.credentialRecordId === boundary.credentialSetRef
      && credential.credentialSetRef === boundary.credentialSetRef;
}

function parseRegistrationVerificationOutput(value: unknown):
  | { readonly verified: false }
  | {
      readonly verified: true;
      readonly fmt: string;
      readonly credentialId: string;
      readonly publicKey: Uint8Array;
      readonly counter: number;
      readonly transports: readonly AuthenticatorTransport[];
      readonly userVerified: boolean;
      readonly backupEligible: boolean;
      readonly backupState: boolean;
      readonly origin: string;
      readonly rpId: string | undefined;
    } {
  if (!hasExactDataKeys(value, ["verified"], ["registrationInfo"])) unavailable();
  if (value["verified"] === false) {
    if (Object.hasOwn(value, "registrationInfo")) unavailable();
    return { verified: false };
  }
  if (value["verified"] !== true || !isPlainObject(value["registrationInfo"])) unavailable();
  const info = value["registrationInfo"];
  if (!hasExactDataKeys(info, [
    "fmt", "aaguid", "credential", "credentialType", "attestationObject", "userVerified",
    "credentialDeviceType", "credentialBackedUp", "origin"
  ], ["rpID", "authenticatorExtensionResults"])) unavailable();
  const credential = info["credential"];
  if (!hasExactDataKeys(credential, ["id", "publicKey", "counter"], ["transports"])) unavailable();
  const transports = credential["transports"] ?? [];
  if (
    typeof info["fmt"] !== "string"
    || typeof credential["id"] !== "string"
    || decodeCanonicalBase64url(credential["id"], MAX_CREDENTIAL_ID_BYTES) === null
    || !(credential["publicKey"] instanceof Uint8Array)
    || credential["publicKey"].byteLength < 1
    || credential["publicKey"].byteLength > MAX_PUBLIC_KEY_BYTES
    || !isUint32(credential["counter"])
    || !Array.isArray(transports)
    || new Set(transports).size !== transports.length
    || transports.some((transport) => typeof transport !== "string" || !TRANSPORTS.includes(transport as AuthenticatorTransport))
    || info["credentialType"] !== "public-key"
    || !(info["attestationObject"] instanceof Uint8Array)
    || typeof info["userVerified"] !== "boolean"
    || (info["credentialDeviceType"] !== "singleDevice" && info["credentialDeviceType"] !== "multiDevice")
    || typeof info["credentialBackedUp"] !== "boolean"
    || (info["credentialDeviceType"] === "singleDevice" && info["credentialBackedUp"] === true)
    || typeof info["origin"] !== "string"
    || (Object.hasOwn(info, "rpID") && typeof info["rpID"] !== "string")
  ) unavailable();
  return {
    verified: true,
    fmt: info["fmt"],
    credentialId: credential["id"],
    publicKey: arrayBufferCopy(credential["publicKey"]),
    counter: credential["counter"],
    transports: Object.freeze([...transports]) as readonly AuthenticatorTransport[],
    userVerified: info["userVerified"],
    backupEligible: info["credentialDeviceType"] === "multiDevice",
    backupState: info["credentialBackedUp"],
    origin: info["origin"],
    rpId: info["rpID"] as string | undefined
  };
}

function parseAuthenticationVerificationOutput(value: unknown): {
  readonly verified: boolean;
  readonly credentialId: string;
  readonly newCounter: number;
  readonly userVerified: boolean;
  readonly backupEligible: boolean;
  readonly backupState: boolean;
  readonly origin: string;
  readonly rpId: string;
} {
  if (!isPlainObject(value) || !hasExactKeys(value, ["verified", "authenticationInfo"]) || typeof value["verified"] !== "boolean") unavailable();
  const info = value["authenticationInfo"];
  if (!isPlainObject(info) || !hasExactKeys(info, [
    "credentialID", "newCounter", "userVerified", "credentialDeviceType", "credentialBackedUp", "origin", "rpID"
  ], ["authenticatorExtensionResults"])) unavailable();
  if (
    typeof info["credentialID"] !== "string"
    || decodeCanonicalBase64url(info["credentialID"], MAX_CREDENTIAL_ID_BYTES) === null
    || !isUint32(info["newCounter"])
    || typeof info["userVerified"] !== "boolean"
    || (info["credentialDeviceType"] !== "singleDevice" && info["credentialDeviceType"] !== "multiDevice")
    || typeof info["credentialBackedUp"] !== "boolean"
    || (info["credentialDeviceType"] === "singleDevice" && info["credentialBackedUp"] === true)
    || typeof info["origin"] !== "string"
    || typeof info["rpID"] !== "string"
  ) unavailable();
  return {
    verified: value["verified"],
    credentialId: info["credentialID"],
    newCounter: info["newCounter"],
    userVerified: info["userVerified"],
    backupEligible: info["credentialDeviceType"] === "multiDevice",
    backupState: info["credentialBackedUp"],
    origin: info["origin"],
    rpId: info["rpID"]
  };
}

export class SimpleWebAuthnVerifierAdapter implements MaintainedWebAuthnVerifierAdapter, MaintainedDiscoverableLoginVerifierAdapter {
  readonly implementation = Object.freeze({
    kind: "maintained-webauthn-server-library" as const,
    libraryName: "@simplewebauthn/server",
    libraryVersion: SIMPLEWEBAUTHN_VERSION,
    reviewReference: "simplewebauthn-server-13.3.2-803d1da"
  });

  readonly #repository: PasskeyCredentialRepository;
  readonly #primitives: SimpleWebAuthnPrimitives;

  constructor(repository: PasskeyCredentialRepository, primitives: SimpleWebAuthnPrimitives = maintainedPrimitives) {
    this.#repository = repository;
    this.#primitives = primitives;
  }

  async createBootstrapRegistrationOptions(
    input: BootstrapRegistrationCeremony
  ): Promise<PublicKeyCredentialCreationOptionsJSON> {
    return opaqueAdapterBoundary(async () => {
      const ceremony = snapshotBootstrapRegistrationCeremony(input);
      const userHandle = arrayBufferCopy(ceremony.expectedUserHandle);

      let rawOptions: unknown;
      try {
        rawOptions = await this.#primitives.generateRegistrationOptions({
          rpName: ceremony.rpName,
          rpID: ceremony.expectedRpId,
          userName: ceremony.userName,
          userDisplayName: ceremony.userDisplayName,
          userID: userHandle,
          challenge: decodeCanonicalBase64url(ceremony.expectedChallenge, USER_HANDLE_BYTES) as Uint8Array<ArrayBuffer>,
          timeout: ceremony.timeoutMs,
          attestationType: "none",
          excludeCredentials: [],
          authenticatorSelection: {
            residentKey: "required",
            requireResidentKey: true,
            userVerification: "required"
          },
          supportedAlgorithmIDs: [-7, -257]
        });
      } catch {
        unavailable();
      }

      const parsed = creationOptionsSchema.safeParse(rawOptions);
      if (!parsed.success) unavailable();
      const options = parsed.data;
      const expectedUserId = Buffer.from(userHandle).toString("base64url");
      if (
        options.rp.id !== ceremony.expectedRpId
        || options.rp.name !== ceremony.rpName
        || options.user.id !== expectedUserId
        || options.user.name !== ceremony.userName
        || options.user.displayName !== ceremony.userDisplayName
        || options.challenge !== ceremony.expectedChallenge
        || options.timeout !== ceremony.timeoutMs
        || options.attestation !== "none"
        || options.authenticatorSelection?.residentKey !== "required"
        || options.authenticatorSelection.requireResidentKey !== true
        || options.authenticatorSelection.userVerification !== "required"
        || options.pubKeyCredParams.length !== 2
        || options.pubKeyCredParams[0]?.alg !== -7
        || options.pubKeyCredParams[1]?.alg !== -257
        || options.excludeCredentials === undefined
        || options.excludeCredentials.length !== 0
        || (options.hints !== undefined && options.hints.length !== 0)
        || options.attestationFormats !== undefined
        || (options.extensions !== undefined && (
          !hasExactKeys(options.extensions, ["credProps"])
          || options.extensions["credProps"] !== true
        ))
      ) unavailable();
      return options as PublicKeyCredentialCreationOptionsJSON;
    });
  }

  async verifyBootstrapRegistration(
    response: unknown,
    expectations: BootstrapRegistrationCeremony
  ): Promise<BootstrapRegistrationVerifierResult> {
    return opaqueAdapterBoundary(async () => {
      const ceremony = snapshotBootstrapRegistrationCeremony(expectations);
      const parsedResponse = parseRegistrationResponse(response);
      if (parsedResponse === null) return invalidResponse();

      let rawVerification: unknown;
      try {
        rawVerification = await this.#primitives.verifyRegistrationResponse({
          response: parsedResponse,
          expectedChallenge: ceremony.expectedChallenge,
          expectedOrigin: ceremony.expectedOrigin,
          expectedRPID: ceremony.expectedRpId,
          expectedType: "webauthn.create",
          requireUserPresence: true,
          requireUserVerification: true,
          supportedAlgorithmIDs: [-7, -257]
        });
      } catch {
        return invalidResponse();
      }
      const verification = parseRegistrationVerificationOutput(rawVerification);
      if (!verification.verified) return invalidResponse();
      if (
        verification.origin !== ceremony.expectedOrigin
        || verification.rpId !== ceremony.expectedRpId
        || verification.credentialId !== parsedResponse.id
      ) unavailable();
      if (
        verification.fmt !== "none"
        || verification.userVerified !== true
        || (!verification.backupEligible && verification.backupState)
      ) return policyRejected();
      const algorithm = readCoseAlgorithm(this.#primitives, verification.publicKey);
      if ((algorithm !== -7 && algorithm !== -257) || !ceremony.allowedAlgorithms.includes(algorithm)) {
        return policyRejected();
      }

      return Object.freeze({
        status: "verified" as const,
        kind: "bootstrap_registration" as const,
        candidate: Object.freeze({
          accountId: ceremony.candidateAccountId,
          userHandleRef: ceremony.userHandleRef,
          expectedUserHandle: arrayBufferCopy(ceremony.expectedUserHandle),
          userName: ceremony.userName,
          userDisplayName: ceremony.userDisplayName
        }),
        credential: Object.freeze({
          credentialId: verification.credentialId,
          publicKey: arrayBufferCopy(verification.publicKey),
          algorithm,
          discoveryMode: "discoverable" as const,
          signCount: verification.counter,
          backupEligible: verification.backupEligible,
          backupState: verification.backupState,
          transports: Object.freeze([...verification.transports]),
          userPresent: true as const,
          userVerified: true as const
        })
      });
    });
  }

  async createRegistrationOptions(input: RegistrationOptionsInput): Promise<PublicKeyCredentialCreationOptionsJSON> {
    return opaqueAdapterBoundary(async () => {
    assertExactObjectKeys(input, [
      "rpName", "userName", "userDisplayName", "expectedChallenge", "expectedRpId", "timeoutMs",
      "allowedAlgorithms", "expectedAccountId", "expectedUserHandleRef"
    ]);
    assertCommonOptionsInput(input);
    if (
      !isBoundedOpaque(input.expectedUserHandleRef)
      || typeof input.rpName !== "string" || input.rpName.length < 1 || input.rpName.length > 64
      || typeof input.userName !== "string" || input.userName.length < 1 || input.userName.length > 128
      || typeof input.userDisplayName !== "string" || input.userDisplayName.length < 1 || input.userDisplayName.length > 128
    ) unavailable();

    let rawHandle: StoredPasskeyUserHandle | null;
    let rawCredentials: readonly StoredPasskeyCredential[];
    try {
      [rawHandle, rawCredentials] = await Promise.all([
        this.#repository.findPasskeyUserHandleByRef(input.expectedUserHandleRef),
        this.#repository.listPasskeyCredentialsByAccountId(input.expectedAccountId)
      ]);
    } catch {
      unavailable();
    }
    if (rawHandle === null || !Array.isArray(rawCredentials) || rawCredentials.length > MAX_ACCOUNT_CREDENTIALS) unavailable();
    const handle = validateUserHandle(rawHandle);
    if (handle.userHandleRef !== input.expectedUserHandleRef || handle.accountId !== input.expectedAccountId) unavailable();
    const credentials = rawCredentials.map(validateStoredCredential);
    if (credentials.some((credential) => credential.accountId !== input.expectedAccountId)) unavailable();
    if (new Set(credentials.map((credential) => credential.credentialId)).size !== credentials.length) unavailable();

    let rawOptions: unknown;
    try {
      rawOptions = await this.#primitives.generateRegistrationOptions({
        rpName: input.rpName,
        rpID: input.expectedRpId,
        userName: input.userName,
        userDisplayName: input.userDisplayName,
        userID: arrayBufferCopy(handle.userHandle),
        challenge: decodeCanonicalBase64url(input.expectedChallenge, USER_HANDLE_BYTES) as Uint8Array<ArrayBuffer>,
        timeout: input.timeoutMs,
        attestationType: "none",
        excludeCredentials: credentials.map((credential) => ({
          id: credential.credentialId,
          transports: [...credential.transports]
        })),
        authenticatorSelection: {
          residentKey: "required",
          requireResidentKey: true,
          userVerification: "required"
        },
        supportedAlgorithmIDs: [...input.allowedAlgorithms]
      });
    } catch {
      unavailable();
    }
    const parsed = creationOptionsSchema.safeParse(rawOptions);
    if (!parsed.success) unavailable();
    const options = parsed.data;
    const expectedUserId = Buffer.from(handle.userHandle).toString("base64url");
    if (
      options.rp.id !== input.expectedRpId
      || options.rp.name !== input.rpName
      || options.user.id !== expectedUserId
      || options.user.name !== input.userName
      || options.user.displayName !== input.userDisplayName
      || options.challenge !== input.expectedChallenge
      || options.timeout !== input.timeoutMs
      || options.attestation !== "none"
      || options.authenticatorSelection?.residentKey !== "required"
      || options.authenticatorSelection.requireResidentKey !== true
      || options.authenticatorSelection.userVerification !== "required"
      || (options.hints !== undefined && options.hints.length !== 0)
      || options.attestationFormats !== undefined
      || (options.extensions !== undefined && (
        !hasExactKeys(options.extensions, ["credProps"])
        || options.extensions["credProps"] !== true
      ))
      || options.pubKeyCredParams.length !== input.allowedAlgorithms.length
      || options.pubKeyCredParams.some((parameter, index) => parameter.alg !== input.allowedAlgorithms[index])
      || (options.excludeCredentials?.length ?? 0) !== credentials.length
      || options.excludeCredentials?.some((descriptor, index) => {
        const credential = credentials[index];
        return credential === undefined
          || descriptor.id !== credential.credentialId
          || !equalTransports(descriptor.transports, credential.transports);
      }) === true
    ) unavailable();
    return options as PublicKeyCredentialCreationOptionsJSON;
    });
  }

  async createAuthenticationOptions(input: AuthenticationOptionsInput): Promise<PublicKeyCredentialRequestOptionsJSON> {
    return opaqueAdapterBoundary(async () => {
    assertExactObjectKeys(input, [
      "expectedChallenge", "expectedRpId", "timeoutMs", "allowedAlgorithms", "expectedAccountId",
      "credentialBoundary"
    ]);
    assertCommonOptionsInput(input);
    assertCredentialBoundary(input.credentialBoundary);
    let allowCredentials: StoredPasskeyCredential[] | undefined;
    if (input.credentialBoundary.mode === "non_discoverable") {
      let rawCredential: StoredPasskeyCredential | null;
      try {
        rawCredential = await this.#repository.findPasskeyCredentialByRecordId(input.credentialBoundary.credentialSetRef);
      } catch {
        unavailable();
      }
      if (rawCredential === null) unavailable();
      const credential = validateStoredCredential(rawCredential);
      if (!assertCredentialMatchesBoundary(credential, input.expectedAccountId, input.credentialBoundary)) unavailable();
      if (!input.allowedAlgorithms.includes(credential.algorithm)) unavailable();
      if (readCoseAlgorithm(this.#primitives, credential.publicKey) !== credential.algorithm) unavailable();
      allowCredentials = [credential];
    }

    let rawOptions: unknown;
    try {
      const primitiveInput: GenerateAuthenticationOptionsOpts = {
        rpID: input.expectedRpId,
        challenge: decodeCanonicalBase64url(input.expectedChallenge, USER_HANDLE_BYTES) as Uint8Array<ArrayBuffer>,
        timeout: input.timeoutMs,
        userVerification: "required",
        ...(allowCredentials === undefined ? {} : {
          allowCredentials: allowCredentials.map((credential) => ({
            id: credential.credentialId,
            transports: [...credential.transports]
          }))
        })
      };
      rawOptions = await this.#primitives.generateAuthenticationOptions(primitiveInput);
    } catch {
      unavailable();
    }
    const parsed = requestOptionsSchema.safeParse(rawOptions);
    if (!parsed.success) unavailable();
    const options = parsed.data;
    const expectedAllowCredential = allowCredentials?.[0];
    if (
      options.rpId !== input.expectedRpId
      || options.challenge !== input.expectedChallenge
      || options.timeout !== input.timeoutMs
      || options.userVerification !== "required"
      || options.hints !== undefined
      || options.extensions !== undefined
      || (allowCredentials === undefined
        ? options.allowCredentials !== undefined && options.allowCredentials.length !== 0
        : expectedAllowCredential === undefined
          || options.allowCredentials?.length !== 1
          || options.allowCredentials[0]?.id !== expectedAllowCredential.credentialId
          || !equalTransports(options.allowCredentials[0]?.transports, expectedAllowCredential.transports))
    ) unavailable();
    return options as PublicKeyCredentialRequestOptionsJSON;
    });
  }

  async createDiscoverableLoginOptions(input: DiscoverableLoginOptionsInput): Promise<PublicKeyCredentialRequestOptionsJSON> {
    return opaqueAdapterBoundary(async () => {
    assertExactObjectKeys(input, ["expectedChallenge", "expectedRpId", "timeoutMs", "credentialBoundary"]);
    assertRequestOptionsInput(input);
    assertDiscoverableAnyBoundary(input.credentialBoundary);

    let rawOptions: unknown;
    try {
      rawOptions = await this.#primitives.generateAuthenticationOptions({
        rpID: input.expectedRpId,
        challenge: decodeCanonicalBase64url(input.expectedChallenge, USER_HANDLE_BYTES) as Uint8Array<ArrayBuffer>,
        timeout: input.timeoutMs,
        userVerification: "required"
      });
    } catch {
      unavailable();
    }
    const parsed = requestOptionsSchema.safeParse(rawOptions);
    if (!parsed.success) unavailable();
    const options = parsed.data;
    if (
      options.rpId !== input.expectedRpId
      || options.challenge !== input.expectedChallenge
      || options.timeout !== input.timeoutMs
      || options.userVerification !== "required"
      || (options.allowCredentials !== undefined && options.allowCredentials.length !== 0)
      || options.hints !== undefined
      || options.extensions !== undefined
    ) unavailable();
    return Object.freeze({
      challenge: options.challenge,
      rpId: options.rpId,
      timeout: options.timeout,
      userVerification: options.userVerification
    }) as PublicKeyCredentialRequestOptionsJSON;
    });
  }

  async verifyRegistration(response: unknown, expectations: RegistrationVerificationExpectations) {
    return opaqueAdapterBoundary(async () => {
    assertRegistrationExpectations(expectations);
    const parsedResponse = parseRegistrationResponse(response);
    if (parsedResponse === null) return invalidResponse();

    let rawHandle: StoredPasskeyUserHandle | null;
    try {
      rawHandle = await this.#repository.findPasskeyUserHandleByRef(expectations.expectedUserHandleRef);
    } catch {
      unavailable();
    }
    if (rawHandle === null) unavailable();
    const handle = validateUserHandle(rawHandle);
    if (handle.userHandleRef !== expectations.expectedUserHandleRef || handle.accountId !== expectations.expectedAccountId) unavailable();

    let rawVerification: unknown;
    try {
      rawVerification = await this.#primitives.verifyRegistrationResponse({
        response: parsedResponse,
        expectedChallenge: expectations.expectedChallenge,
        expectedOrigin: expectations.expectedOrigin,
        expectedRPID: expectations.expectedRpId,
        expectedType: "webauthn.create",
        requireUserPresence: true,
        requireUserVerification: true,
        supportedAlgorithmIDs: [...expectations.allowedAlgorithms]
      });
    } catch {
      return invalidResponse();
    }
    const verification = parseRegistrationVerificationOutput(rawVerification);
    if (!verification.verified) return invalidResponse();
    if (
      verification.origin !== expectations.expectedOrigin
      || verification.rpId !== expectations.expectedRpId
      || verification.credentialId !== parsedResponse.id
    ) unavailable();
    if (
      verification.fmt !== "none"
      || verification.userVerified !== true
      || (!verification.backupEligible && verification.backupState)
    ) return policyRejected();
    const algorithm = readCoseAlgorithm(this.#primitives, verification.publicKey);
    if ((algorithm !== -7 && algorithm !== -257) || !expectations.allowedAlgorithms.includes(algorithm)) return policyRejected();

    return Object.freeze({
      status: "verified" as const,
      kind: "registration" as const,
      credential: Object.freeze({
        credentialId: verification.credentialId,
        publicKey: arrayBufferCopy(verification.publicKey),
        algorithm,
        accountId: expectations.expectedAccountId,
        userHandleRef: expectations.expectedUserHandleRef,
        discoveryMode: "discoverable" as const,
        signCount: verification.counter,
        backupEligible: verification.backupEligible,
        backupState: verification.backupState,
        transports: Object.freeze([...verification.transports]),
        userPresent: true as const,
        userVerified: true as const
      })
    });
    });
  }

  async verifyAuthentication(response: unknown, expectations: AuthenticationVerificationExpectations) {
    return opaqueAdapterBoundary(async () => {
    assertAuthenticationExpectations(expectations);
    const parsedResponse = parseAuthenticationResponse(response);
    if (parsedResponse === null) return invalidResponse();

    let rawCredential: StoredPasskeyCredential | null;
    try {
      rawCredential = await this.#repository.findPasskeyCredentialById(parsedResponse.id);
    } catch {
      unavailable();
    }
    if (rawCredential === null) return invalidResponse();
    const credential = validateStoredCredential(rawCredential);
    if (credential.credentialId !== parsedResponse.id) unavailable();
    if (!assertCredentialMatchesBoundary(credential, expectations.expectedAccountId, expectations.credentialBoundary)) return policyRejected();
    if (!expectations.allowedAlgorithms.includes(credential.algorithm)) return policyRejected();
    if (readCoseAlgorithm(this.#primitives, credential.publicKey) !== credential.algorithm) unavailable();

    let rawHandle: StoredPasskeyUserHandle | null;
    try {
      rawHandle = await this.#repository.findPasskeyUserHandleByRef(credential.userHandleRef);
    } catch {
      unavailable();
    }
    if (rawHandle === null) unavailable();
    const handle = validateUserHandle(rawHandle);
    if (handle.accountId !== credential.accountId || handle.userHandleRef !== credential.userHandleRef) unavailable();
    const presentedHandle = parsedResponse.response.userHandle === undefined
      ? null
      : decodeCanonicalBase64url(parsedResponse.response.userHandle, 64);
    if (expectations.credentialBoundary.mode === "discoverable" && presentedHandle === null) return invalidResponse();
    if (presentedHandle !== null && !equalBytes(presentedHandle, handle.userHandle)) return invalidResponse();

    let rawVerification: unknown;
    try {
      rawVerification = await this.#primitives.verifyAuthenticationResponse({
        response: parsedResponse,
        expectedChallenge: expectations.expectedChallenge,
        expectedOrigin: expectations.expectedOrigin,
        expectedRPID: expectations.expectedRpId,
        expectedType: "webauthn.get",
        requireUserVerification: true,
        advancedFIDOConfig: { userVerification: "required" },
        credential: {
          id: credential.credentialId,
          publicKey: arrayBufferCopy(credential.publicKey),
          counter: MAINTAINED_VERIFIER_COUNTER_BASELINE,
          transports: [...credential.transports]
        }
      });
    } catch {
      return invalidResponse();
    }
    const verification = parseAuthenticationVerificationOutput(rawVerification);
    if (!verification.verified) return invalidResponse();
    if (
      verification.credentialId !== credential.credentialId
      || verification.origin !== expectations.expectedOrigin
      || verification.rpId !== expectations.expectedRpId
    ) unavailable();
    if (
      verification.userVerified !== true
      || verification.backupEligible !== credential.backupEligible
      || (!verification.backupEligible && verification.backupState)
    ) return policyRejected();

    return Object.freeze({
      status: "verified" as const,
      kind: "authentication" as const,
      credential: Object.freeze({
        credentialRecordId: credential.credentialRecordId,
        credentialRevision: credential.credentialRevision,
        accountId: credential.accountId,
        discoveryMode: credential.discoveryMode,
        userHandleBindingVerified: true as const,
        previousSignCount: credential.signCount,
        newSignCount: verification.newCounter,
        previousBackupEligible: credential.backupEligible,
        backupEligible: verification.backupEligible,
        previousBackupState: credential.backupState,
        backupState: verification.backupState,
        userPresent: true as const,
        userVerified: true as const
      })
    });
    });
  }

  async verifyDiscoverableLogin(
    response: unknown,
    expectations: DiscoverableLoginVerificationExpectations
  ) {
    return opaqueAdapterBoundary(async () => {
    assertDiscoverableLoginExpectations(expectations);
    const parsedResponse = parseAuthenticationResponse(response);
    if (parsedResponse === null) return discoverableLoginRejected();
    const presentedHandle = parsedResponse.response.userHandle === undefined
      ? null
      : decodeCanonicalBase64url(parsedResponse.response.userHandle, USER_HANDLE_BYTES);
    if (presentedHandle === null || presentedHandle.byteLength !== USER_HANDLE_BYTES) {
      return discoverableLoginRejected();
    }

    let rawCredential: StoredPasskeyCredential | null;
    try {
      rawCredential = await this.#repository.findPasskeyCredentialById(parsedResponse.id);
    } catch {
      unavailable();
    }
    if (rawCredential === null) return discoverableLoginRejected();
    const credential = validateStoredCredential(rawCredential);
    if (
      credential.credentialId !== parsedResponse.id
      || credential.discoveryMode !== "discoverable"
      || credential.credentialSetRef !== null
      || !expectations.allowedAlgorithms.includes(credential.algorithm)
    ) return discoverableLoginRejected();
    if (readCoseAlgorithm(this.#primitives, credential.publicKey) !== credential.algorithm) {
      return discoverableLoginRejected();
    }

    let rawVerification: unknown;
    try {
      rawVerification = await this.#primitives.verifyAuthenticationResponse({
        response: parsedResponse,
        expectedChallenge: expectations.expectedChallenge,
        expectedOrigin: expectations.expectedOrigin,
        expectedRPID: expectations.expectedRpId,
        expectedType: "webauthn.get",
        requireUserVerification: true,
        credential: {
          id: credential.credentialId,
          publicKey: arrayBufferCopy(credential.publicKey),
          counter: MAINTAINED_VERIFIER_COUNTER_BASELINE,
          transports: [...credential.transports]
        }
      });
    } catch {
      return discoverableLoginRejected();
    }
    const verification = parseAuthenticationVerificationOutput(rawVerification);
    if (!verification.verified) return discoverableLoginRejected();
    if (
      verification.credentialId !== credential.credentialId
      || verification.origin !== expectations.expectedOrigin
      || verification.rpId !== expectations.expectedRpId
    ) unavailable();
    if (
      verification.userVerified !== true
      || verification.backupEligible !== credential.backupEligible
      || (!verification.backupEligible && verification.backupState)
    ) return discoverableLoginRejected();

    // The assertion signature is intentionally verified before resolving or
    // comparing the server-owned user handle. Otherwise an attacker who knows
    // a credential ID could use invalid signatures to probe candidate handles
    // through timing differences.
    let rawHandle: StoredPasskeyUserHandle | null;
    try {
      rawHandle = await this.#repository.findPasskeyUserHandleByRef(credential.userHandleRef);
    } catch {
      unavailable();
    }
    if (rawHandle === null) return discoverableLoginRejected();
    const handle = validateUserHandle(rawHandle);
    if (
      handle.userHandleRef !== credential.userHandleRef
      || handle.accountId !== credential.accountId
      || !equalBytes(presentedHandle, handle.userHandle)
    ) return discoverableLoginRejected();

    return Object.freeze({
      status: "verified" as const,
      kind: "authentication" as const,
      purpose: "session.create" as const,
      credentialBoundary: "discoverable_any" as const,
      account: Object.freeze({
        accountId: credential.accountId,
        userHandleRef: credential.userHandleRef,
        userHandleBindingVerified: true as const
      }),
      credential: Object.freeze({
        credentialRecordId: credential.credentialRecordId,
        credentialRevision: credential.credentialRevision,
        algorithm: credential.algorithm,
        discoveryMode: "discoverable" as const,
        previousSignCount: credential.signCount,
        newSignCount: verification.newCounter,
        previousBackupEligible: credential.backupEligible,
        backupEligible: verification.backupEligible,
        previousBackupState: credential.backupState,
        backupState: verification.backupState,
        userPresent: true as const,
        userVerified: true as const
      })
    });
    });
  }
}
