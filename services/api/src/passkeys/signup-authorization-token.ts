import { createHmac, hkdfSync, timingSafeEqual } from "node:crypto";
import { types as utilTypes } from "node:util";

import {
  IdSchema,
  PASSKEY_BOOTSTRAP_TOKEN_MAX_BYTES,
  PasskeyDeliveryNonceSchema
} from "@luxora/protocol";
import { compactVerify, SignJWT, jwtVerify } from "jose";

const ISSUER = "https://api.luxora.app";
const AUDIENCE = "luxora-passkey-signup-preaccount";
const TOKEN_USE = "passkey_signup_preaccount_authorization";
const TOKEN_TYPE = "luxora-passkey-signup-preaccount+jwt";
const ALGORITHM = "HS256";
const SUBJECT_PREFIX = "luxora:pre-account-signup:";

// These domains are deliberately unrelated to primary-login bootstrap keys.
const SIGNING_SALT = "luxora/passkey-signup-preaccount/v1/hs256/salt";
const SIGNING_INFO = "luxora/passkey-signup-preaccount/v1/hs256/signing-key";
const JTI_SALT = "luxora/passkey-signup-preaccount/v1/jti/salt";
const JTI_INFO = "luxora/passkey-signup-preaccount/v1/jti/key";
const JTI_DOMAIN = "luxora/passkey-signup-preaccount/v1/jti";

const KEY_BYTES = 32;
const MINIMUM_SECRET_BYTES = 32;
const MAX_DEVICE_NAME_LENGTH = 120;
const KEY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
const DIGEST_PATTERN = /^[a-f0-9]{64}$/u;
const BASE64URL_SEGMENT_PATTERN = /^[A-Za-z0-9_-]+$/u;
const STRICT_UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });

const HEADER_KEYS = ["alg", "typ"] as const;
const INPUT_KEYS = [
  "accessTokenTtlSeconds",
  "candidateDigest",
  "challengeDigest",
  "deliveryNonce",
  "deviceName",
  "expiresAt",
  "intentId",
  "issuedAt",
  "issuedRevision",
  "policyDigest",
  "recoveryDeadline",
  "refreshDerivationKeyId",
  "sessionTtlSeconds"
] as const;
const CLAIM_KEYS = [
  "access_ttl",
  "aud",
  "candidate_digest",
  "challenge_digest",
  "delivery_nonce",
  "device_name",
  "exp",
  "iat",
  "intent_id",
  "issued_revision",
  "iss",
  "jti",
  "policy_digest",
  "purpose",
  "recovery_deadline",
  "refresh_key_id",
  "session_ttl",
  "sub",
  "token_use"
] as const;

export const PASSKEY_SIGNUP_AUTHORIZATION_MAX_TTL_SECONDS = 300;
export const PASSKEY_SIGNUP_AUTHORIZATION_MAX_RECOVERY_SECONDS = 300;

export interface PasskeySignupAuthorizationIssueInput {
  readonly intentId: string;
  /** Revision at which this authorization was issued; signup begins at one. */
  readonly issuedRevision: 1;
  readonly candidateDigest: string;
  readonly challengeDigest: string;
  readonly policyDigest: string;
  readonly deliveryNonce: string;
  readonly deviceName: string;
  readonly refreshDerivationKeyId: string;
  readonly accessTokenTtlSeconds: number;
  readonly sessionTtlSeconds: number;
  readonly issuedAt: number;
  readonly expiresAt: number;
  readonly recoveryDeadline: number;
}

export type VerifiedPasskeySignupAuthorization = PasskeySignupAuthorizationIssueInput;

export class InvalidPasskeySignupAuthorizationError extends Error {
  constructor() {
    super("invalid or expired passkey signup authorization");
    this.name = "InvalidPasskeySignupAuthorizationError";
  }
}

export class InvalidPasskeySignupAuthorizationInputError extends Error {
  constructor() {
    super("invalid passkey signup authorization input");
    this.name = "InvalidPasskeySignupAuthorizationInputError";
  }
}

function deriveKey(secret: Uint8Array, salt: string, info: string): Uint8Array {
  return new Uint8Array(hkdfSync(
    "sha256",
    secret,
    Buffer.from(salt, "utf8"),
    Buffer.from(info, "utf8"),
    KEY_BYTES
  ));
}

function canonicalUuid(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const parsed = IdSchema.safeParse(value);
  return parsed.success && parsed.data === value;
}

function digest(value: unknown): value is string {
  return typeof value === "string" && DIGEST_PATTERN.test(value);
}

function deliveryNonce(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const parsed = PasskeyDeliveryNonceSchema.safeParse(value);
  return parsed.success && parsed.data === value;
}

function numericDate(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function boundedInteger(value: unknown, minimum: number, maximum: number): value is number {
  return typeof value === "number"
    && Number.isSafeInteger(value)
    && value >= minimum
    && value <= maximum;
}

function exactKeys(value: object, expected: readonly string[]): boolean {
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key !== "string")) return false;
  const actual = (keys as string[]).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length
    && actual.every((key, index) => key === wanted[index]);
}

function strictRecord(
  value: unknown,
  expected: readonly string[]
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
    if (!exactKeys(value, expected)) return null;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    for (const key of expected) {
      const descriptor = descriptors[key];
      if (
        descriptor === undefined
        || descriptor.enumerable !== true
        || !("value" in descriptor)
      ) return null;
    }
    return Object.freeze(Object.fromEntries(
      expected.map((key) => [key, descriptors[key]?.value])
    ));
  } catch {
    return null;
  }
}

function canonicalJwt(value: string): boolean {
  const segments = value.split(".");
  if (segments.length !== 3) return false;
  return segments.every((segment) => {
    if (!BASE64URL_SEGMENT_PATTERN.test(segment)) return false;
    try {
      return Buffer.from(segment, "base64url").toString("base64url") === segment;
    } catch {
      return false;
    }
  });
}

function snapshotInput(value: unknown): PasskeySignupAuthorizationIssueInput {
  const record = strictRecord(value, INPUT_KEYS);
  if (record === null) throw new InvalidPasskeySignupAuthorizationInputError();
  const snapshot = Object.freeze({
    intentId: record["intentId"],
    issuedRevision: record["issuedRevision"],
    candidateDigest: record["candidateDigest"],
    challengeDigest: record["challengeDigest"],
    policyDigest: record["policyDigest"],
    deliveryNonce: record["deliveryNonce"],
    deviceName: record["deviceName"],
    refreshDerivationKeyId: record["refreshDerivationKeyId"],
    accessTokenTtlSeconds: record["accessTokenTtlSeconds"],
    sessionTtlSeconds: record["sessionTtlSeconds"],
    issuedAt: record["issuedAt"],
    expiresAt: record["expiresAt"],
    recoveryDeadline: record["recoveryDeadline"]
  }) as PasskeySignupAuthorizationIssueInput;
  validateInput(snapshot);
  return snapshot;
}

function validateInput(input: PasskeySignupAuthorizationIssueInput): void {
  if (
    !canonicalUuid(input.intentId)
    || input.issuedRevision !== 1
    || !digest(input.candidateDigest)
    || !digest(input.challengeDigest)
    || !digest(input.policyDigest)
    || !deliveryNonce(input.deliveryNonce)
    || typeof input.deviceName !== "string"
    || input.deviceName.length < 1
    || input.deviceName.length > MAX_DEVICE_NAME_LENGTH
    || input.deviceName.trim() !== input.deviceName
    || input.deviceName.normalize("NFC") !== input.deviceName
    || typeof input.refreshDerivationKeyId !== "string"
    || !KEY_ID_PATTERN.test(input.refreshDerivationKeyId)
    || !boundedInteger(input.accessTokenTtlSeconds, 60, 3_600)
    || !boundedInteger(input.sessionTtlSeconds, 86_400, 365 * 86_400)
    || !numericDate(input.issuedAt)
    || !numericDate(input.expiresAt)
    || input.expiresAt <= input.issuedAt
    || input.expiresAt - input.issuedAt > PASSKEY_SIGNUP_AUTHORIZATION_MAX_TTL_SECONDS
    || !numericDate(input.recoveryDeadline)
    || input.recoveryDeadline < input.expiresAt
    || input.recoveryDeadline - input.expiresAt
      > PASSKEY_SIGNUP_AUTHORIZATION_MAX_RECOVERY_SECONDS
  ) throw new InvalidPasskeySignupAuthorizationInputError();
}

function fixedEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, "utf8");
  const rightBytes = Buffer.from(right, "utf8");
  return leftBytes.byteLength === rightBytes.byteLength
    && timingSafeEqual(leftBytes, rightBytes);
}

/**
 * Signup-only authorization. Its issuer audience, subject, token-use and HKDF
 * domains cannot be confused with the identifier-free primary-login token.
 */
export class PasskeySignupAuthorizationSecurity {
  readonly #signingKey: Uint8Array;
  readonly #jtiKey: Uint8Array;

  constructor(
    masterSecret: string,
    private readonly clock: () => Date = () => new Date()
  ) {
    if (typeof masterSecret !== "string") {
      throw new Error("passkey signup authorization secret must be at least 32 bytes");
    }
    const secret = Buffer.from(masterSecret, "utf8");
    if (secret.byteLength < MINIMUM_SECRET_BYTES) {
      secret.fill(0);
      throw new Error("passkey signup authorization secret must be at least 32 bytes");
    }
    try {
      this.#signingKey = deriveKey(secret, SIGNING_SALT, SIGNING_INFO);
      this.#jtiKey = deriveKey(secret, JTI_SALT, JTI_INFO);
    } finally {
      secret.fill(0);
    }
  }

  async issue(input: PasskeySignupAuthorizationIssueInput): Promise<string> {
    return this.#sign(snapshotInput(input));
  }

  async verifyActive(token: string): Promise<VerifiedPasskeySignupAuthorization> {
    try {
      this.#assertToken(token);
      const { now, currentDate } = this.#sampleClock();
      const { payload, protectedHeader } = await jwtVerify(token, this.#signingKey, {
        algorithms: [ALGORITHM],
        issuer: ISSUER,
        audience: AUDIENCE,
        currentDate,
        clockTolerance: 0
      });
      const claims = this.#strictClaims(payload, protectedHeader);
      if (claims.issuedAt > now) throw new InvalidPasskeySignupAuthorizationError();
      return claims;
    } catch {
      throw new InvalidPasskeySignupAuthorizationError();
    }
  }

  /** Signature-authenticates before lookup, while allowing only bounded committed recovery. */
  async verifyReplayCandidate(token: string): Promise<VerifiedPasskeySignupAuthorization> {
    try {
      this.#assertToken(token);
      const { now } = this.#sampleClock();
      const { payload: encoded, protectedHeader } = await compactVerify(token, this.#signingKey, {
        algorithms: [ALGORITHM]
      });
      const claims = this.#strictClaims(
        JSON.parse(STRICT_UTF8_DECODER.decode(encoded)) as unknown,
        protectedHeader
      );
      if (claims.issuedAt > now || now >= claims.recoveryDeadline) {
        throw new InvalidPasskeySignupAuthorizationError();
      }
      return claims;
    } catch {
      throw new InvalidPasskeySignupAuthorizationError();
    }
  }

  /** Exact deterministic comparison is the final response-loss replay gate. */
  async verifyCommittedReplay(
    token: string,
    input: PasskeySignupAuthorizationIssueInput
  ): Promise<void> {
    try {
      this.#assertToken(token);
      const durable = snapshotInput(input);
      const { now } = this.#sampleClock();
      if (now >= durable.recoveryDeadline) throw new Error("outside recovery window");
      const expected = await this.#sign(durable);
      if (!fixedEqual(token, expected)) throw new Error("token mismatch");
    } catch {
      throw new InvalidPasskeySignupAuthorizationError();
    }
  }

  async #sign(input: PasskeySignupAuthorizationIssueInput): Promise<string> {
    const subject = `${SUBJECT_PREFIX}${input.intentId}`;
    const tuple = JSON.stringify(INPUT_KEYS.map((key) => input[key]));
    const jti = createHmac("sha256", this.#jtiKey)
      .update(JTI_DOMAIN, "utf8")
      .update("\0", "utf8")
      .update(tuple, "utf8")
      .digest("base64url");
    return new SignJWT({
      intent_id: input.intentId,
      issued_revision: input.issuedRevision,
      candidate_digest: input.candidateDigest,
      challenge_digest: input.challengeDigest,
      policy_digest: input.policyDigest,
      delivery_nonce: input.deliveryNonce,
      device_name: input.deviceName,
      refresh_key_id: input.refreshDerivationKeyId,
      access_ttl: input.accessTokenTtlSeconds,
      session_ttl: input.sessionTtlSeconds,
      purpose: "account.create",
      recovery_deadline: input.recoveryDeadline,
      token_use: TOKEN_USE,
      iss: ISSUER,
      aud: AUDIENCE,
      sub: subject,
      jti,
      iat: input.issuedAt,
      exp: input.expiresAt
    })
      .setProtectedHeader({ alg: ALGORITHM, typ: TOKEN_TYPE })
      .sign(this.#signingKey);
  }

  #assertToken(token: unknown): asserts token is string {
    if (
      typeof token !== "string"
      || token.length < 1
      || Buffer.byteLength(token, "utf8") > PASSKEY_BOOTSTRAP_TOKEN_MAX_BYTES
      || !canonicalJwt(token)
    ) throw new InvalidPasskeySignupAuthorizationError();
  }

  #strictClaims(
    payloadValue: unknown,
    headerValue: unknown
  ): VerifiedPasskeySignupAuthorization {
    const payload = strictRecord(payloadValue, CLAIM_KEYS);
    const header = strictRecord(headerValue, HEADER_KEYS);
    if (
      payload === null
      || header === null
      || header["alg"] !== ALGORITHM
      || header["typ"] !== TOKEN_TYPE
      || payload["iss"] !== ISSUER
      || payload["aud"] !== AUDIENCE
      || payload["purpose"] !== "account.create"
      || payload["token_use"] !== TOKEN_USE
      || !canonicalUuid(payload["intent_id"])
      || payload["sub"] !== `${SUBJECT_PREFIX}${payload["intent_id"]}`
      || typeof payload["jti"] !== "string"
    ) throw new InvalidPasskeySignupAuthorizationError();
    const input = snapshotInput({
      intentId: payload["intent_id"],
      issuedRevision: payload["issued_revision"],
      candidateDigest: payload["candidate_digest"],
      challengeDigest: payload["challenge_digest"],
      policyDigest: payload["policy_digest"],
      deliveryNonce: payload["delivery_nonce"],
      deviceName: payload["device_name"],
      refreshDerivationKeyId: payload["refresh_key_id"],
      accessTokenTtlSeconds: payload["access_ttl"],
      sessionTtlSeconds: payload["session_ttl"],
      issuedAt: payload["iat"],
      expiresAt: payload["exp"],
      recoveryDeadline: payload["recovery_deadline"]
    });
    const tuple = JSON.stringify(INPUT_KEYS.map((key) => input[key]));
    const expectedJti = createHmac("sha256", this.#jtiKey)
      .update(JTI_DOMAIN, "utf8")
      .update("\0", "utf8")
      .update(tuple, "utf8")
      .digest("base64url");
    if (!fixedEqual(payload["jti"], expectedJti)) {
      throw new InvalidPasskeySignupAuthorizationError();
    }
    return input;
  }

  #sampleClock(): Readonly<{ now: number; currentDate: Date }> {
    const date = this.clock();
    const milliseconds = Date.prototype.getTime.call(date);
    const now = Math.floor(milliseconds / 1_000);
    if (!numericDate(now)) throw new InvalidPasskeySignupAuthorizationError();
    return Object.freeze({ now, currentDate: new Date(now * 1_000) });
  }
}
