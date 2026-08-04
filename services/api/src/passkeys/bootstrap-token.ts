import { createHmac, hkdfSync, timingSafeEqual } from "node:crypto";
import { types as utilTypes } from "node:util";

import {
  IdSchema,
  PASSKEY_BOOTSTRAP_TOKEN_MAX_BYTES,
  PasskeyDeliveryNonceSchema
} from "@luxora/protocol";
import { compactVerify, SignJWT, jwtVerify } from "jose";

const BOOTSTRAP_ISSUER = "https://api.luxora.app";
const BOOTSTRAP_AUDIENCE = "luxora-passkey-bootstrap";
const BOOTSTRAP_TOKEN_USE = "passkey_bootstrap";
const BOOTSTRAP_TOKEN_TYPE = "luxora-passkey-bootstrap+jwt";
const BOOTSTRAP_ALGORITHM = "HS256";

// Never reuse the access-JWT bytes directly or any step-up derivation domain.
const SIGNING_KEY_SALT = "luxora/passkey-bootstrap-authorization/v1/hs256/salt";
const SIGNING_KEY_INFO = "luxora/passkey-bootstrap-authorization/v1/hs256/signing-key";
const JTI_KEY_SALT = "luxora/passkey-bootstrap-authorization/v1/jti/salt";
const JTI_KEY_INFO = "luxora/passkey-bootstrap-authorization/v1/jti/hmac-key";
const JTI_MESSAGE_DOMAIN = "luxora/passkey-bootstrap-authorization/v1/jti";

const DERIVED_KEY_BYTES = 32;
const MINIMUM_ACCESS_SECRET_BYTES = 32;
const STRICT_UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });
const DIGEST_PATTERN = /^[a-f0-9]{64}$/u;
const BASE64URL_SEGMENT_PATTERN = /^[A-Za-z0-9_-]+$/u;
const BASE64URL_256_PATTERN = /^[A-Za-z0-9_-]{43}$/u;

const EXPECTED_HEADER_KEYS = ["alg", "typ"] as const;
const EXPECTED_ISSUE_INPUT_KEYS = [
  "deliveryNonce",
  "expiresAt",
  "intentId",
  "issuedAt",
  "purpose",
  "targetDigest"
] as const;
const EXPECTED_COMMITTED_REPLAY_KEYS = [
  "issueInput",
  "recoveryDeadline",
  "state"
] as const;
const EXPECTED_CLAIM_KEYS = [
  "aud",
  "delivery_nonce",
  "exp",
  "iat",
  "intent_id",
  "iss",
  "jti",
  "purpose",
  "target_digest",
  "token_use"
] as const;

export const BOOTSTRAP_TOKEN_MAX_TTL_SECONDS = 300;
export const BOOTSTRAP_TOKEN_MAX_COMMITTED_REPLAY_GRACE_SECONDS = 300;

export type BootstrapTokenPurpose = "account.create" | "session.create";

export interface BootstrapTokenBinding {
  readonly intentId: string;
  readonly purpose: BootstrapTokenPurpose;
  readonly targetDigest: string;
  readonly deliveryNonce: string;
}

export interface BootstrapTokenIssueInput extends BootstrapTokenBinding {
  /** NumericDate captured in the durable intent outcome; issuance never samples a clock. */
  readonly issuedAt: number;
  /** NumericDate captured in the same outcome, at most five minutes after issuedAt. */
  readonly expiresAt: number;
}

/** Trusted projection of an already-committed idempotent response. */
export interface BootstrapTokenCommittedReplayInput {
  readonly state: "committed";
  readonly recoveryDeadline: number;
  readonly issueInput: BootstrapTokenIssueInput;
}

/** Authenticated internal binding. Keep the delivery nonce out of logs and HTTP bodies. */
export interface VerifiedBootstrapTokenBinding extends BootstrapTokenBinding {
  readonly issuedAt: number;
  readonly expiresAt: number;
}

export type BootstrapTokenReplayCandidate = VerifiedBootstrapTokenBinding;

/** Opaque by design: token bytes and JOSE/verifier causes never cross this boundary. */
export class InvalidBootstrapTokenError extends Error {
  constructor() {
    super("invalid or expired bootstrap authorization");
    this.name = "InvalidBootstrapTokenError";
  }
}

/** Opaque durable/configuration input error; no caller value is reflected. */
export class InvalidBootstrapTokenInputError extends Error {
  constructor() {
    super("invalid bootstrap token input");
    this.name = "InvalidBootstrapTokenInputError";
  }
}

interface StrictBootstrapClaims {
  readonly iss: typeof BOOTSTRAP_ISSUER;
  readonly aud: typeof BOOTSTRAP_AUDIENCE;
  readonly intent_id: string;
  readonly purpose: BootstrapTokenPurpose;
  readonly target_digest: string;
  readonly delivery_nonce: string;
  readonly jti: string;
  readonly iat: number;
  readonly exp: number;
  readonly token_use: typeof BOOTSTRAP_TOKEN_USE;
}

function deriveKey(secret: Uint8Array, salt: string, info: string): Uint8Array {
  return new Uint8Array(hkdfSync(
    "sha256",
    secret,
    Buffer.from(salt, "utf8"),
    Buffer.from(info, "utf8"),
    DERIVED_KEY_BYTES
  ));
}

function isCanonicalUuid(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const parsed = IdSchema.safeParse(value);
  return parsed.success && parsed.data === value;
}

function isPurpose(value: unknown): value is BootstrapTokenPurpose {
  return value === "account.create" || value === "session.create";
}

function isDigest(value: unknown): value is string {
  return typeof value === "string" && DIGEST_PATTERN.test(value);
}

function isDeliveryNonce(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const parsed = PasskeyDeliveryNonceSchema.safeParse(value);
  return parsed.success && parsed.data === value;
}

function isNumericDate(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isCanonicalBase64urlSegment(value: string): boolean {
  if (!BASE64URL_SEGMENT_PATTERN.test(value)) return false;
  try {
    return Buffer.from(value, "base64url").toString("base64url") === value;
  } catch {
    return false;
  }
}

function isCanonicalCompactJwt(value: string): boolean {
  const segments = value.split(".");
  return segments.length === 3 && segments.every(isCanonicalBase64urlSegment);
}

function hasExactKeys(value: object, expected: readonly string[]): boolean {
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.some((key) => typeof key !== "string")) return false;
  const actual = (ownKeys as string[]).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
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
    if (!hasExactKeys(value, expectedKeys)) return null;

    const descriptors = Object.getOwnPropertyDescriptors(value);
    for (const key of expectedKeys) {
      const descriptor = descriptors[key];
      if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) return null;
    }
    return value as Readonly<Record<string, unknown>>;
  } catch {
    return null;
  }
}

function fixedLengthEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, "utf8");
  const rightBytes = Buffer.from(right, "utf8");
  return leftBytes.byteLength === rightBytes.byteLength && timingSafeEqual(leftBytes, rightBytes);
}

function validateBinding(binding: BootstrapTokenBinding): void {
  if (
    !isCanonicalUuid(binding.intentId)
    || !isPurpose(binding.purpose)
    || !isDigest(binding.targetDigest)
    || !isDeliveryNonce(binding.deliveryNonce)
  ) {
    throw new InvalidBootstrapTokenInputError();
  }
}

function validateIssueInput(input: BootstrapTokenIssueInput): void {
  validateBinding(input);
  if (
    !isNumericDate(input.issuedAt)
    || !isNumericDate(input.expiresAt)
    || input.expiresAt <= input.issuedAt
    || input.expiresAt - input.issuedAt > BOOTSTRAP_TOKEN_MAX_TTL_SECONDS
  ) {
    throw new InvalidBootstrapTokenInputError();
  }
}

function snapshotIssueInput(input: unknown): BootstrapTokenIssueInput {
  const record = strictPlainDataRecord(input, EXPECTED_ISSUE_INPUT_KEYS);
  if (record === null) throw new InvalidBootstrapTokenInputError();
  return Object.freeze({
    intentId: record["intentId"],
    purpose: record["purpose"],
    targetDigest: record["targetDigest"],
    deliveryNonce: record["deliveryNonce"],
    issuedAt: record["issuedAt"],
    expiresAt: record["expiresAt"]
  }) as BootstrapTokenIssueInput;
}

function snapshotCommittedReplayInput(input: unknown): BootstrapTokenCommittedReplayInput {
  const record = strictPlainDataRecord(input, EXPECTED_COMMITTED_REPLAY_KEYS);
  if (record === null) throw new InvalidBootstrapTokenInputError();
  const issueInput = snapshotIssueInput(record["issueInput"]);
  return Object.freeze({
    state: record["state"],
    recoveryDeadline: record["recoveryDeadline"],
    issueInput
  }) as BootstrapTokenCommittedReplayInput;
}

function validateCommittedReplayInput(input: BootstrapTokenCommittedReplayInput): void {
  validateIssueInput(input.issueInput);
  if (
    input.state !== "committed"
    || !isNumericDate(input.recoveryDeadline)
    || input.recoveryDeadline < input.issueInput.expiresAt
    || input.recoveryDeadline - input.issueInput.expiresAt
      > BOOTSTRAP_TOKEN_MAX_COMMITTED_REPLAY_GRACE_SECONDS
  ) {
    throw new InvalidBootstrapTokenInputError();
  }
}

/**
 * Purpose-bound authorization for an anonymous passkey bootstrap intent.
 *
 * It intentionally contains no account, subject, session, or device claim.
 * Possession alone is not an account/session grant: the embedding service must
 * still load the returned intent ID and verify the exact durable intent plus
 * the raw WebAuthn response before committing an account or session.
 */
export class BootstrapTokenSecurity {
  readonly #signingKey: Uint8Array;
  readonly #jtiKey: Uint8Array;

  constructor(
    accessJwtSecret: string,
    private readonly clock: () => Date = () => new Date()
  ) {
    if (typeof accessJwtSecret !== "string") {
      throw new Error("bootstrap token secret must be at least 32 bytes");
    }
    const secret = Buffer.from(accessJwtSecret, "utf8");
    if (secret.byteLength < MINIMUM_ACCESS_SECRET_BYTES) {
      secret.fill(0);
      throw new Error("bootstrap token secret must be at least 32 bytes");
    }
    try {
      this.#signingKey = deriveKey(secret, SIGNING_KEY_SALT, SIGNING_KEY_INFO);
      this.#jtiKey = deriveKey(secret, JTI_KEY_SALT, JTI_KEY_INFO);
    } finally {
      secret.fill(0);
    }
  }

  /** Identical durable inputs produce the exact same compact JWT after restart. */
  async issue(input: BootstrapTokenIssueInput): Promise<string> {
    const durable = snapshotIssueInput(input);
    validateIssueInput(durable);
    return this.#sign(durable);
  }

  async #sign(durable: BootstrapTokenIssueInput): Promise<string> {
    const jti = this.#deriveJti(durable);
    return new SignJWT({
      iss: BOOTSTRAP_ISSUER,
      aud: BOOTSTRAP_AUDIENCE,
      intent_id: durable.intentId,
      purpose: durable.purpose,
      target_digest: durable.targetDigest,
      delivery_nonce: durable.deliveryNonce,
      jti,
      iat: durable.issuedAt,
      exp: durable.expiresAt,
      token_use: BOOTSTRAP_TOKEN_USE
    })
      .setProtectedHeader({ alg: BOOTSTRAP_ALGORITHM, typ: BOOTSTRAP_TOKEN_TYPE })
      .sign(this.#signingKey);
  }

  /**
   * Cryptographically authenticates the complete token before returning its
   * identifier-free durable binding. No unverified claim crosses this boundary.
   */
  async verify(
    token: string,
    expectedPurpose: BootstrapTokenPurpose
  ): Promise<VerifiedBootstrapTokenBinding> {
    try {
      if (
        !isPurpose(expectedPurpose)
        || typeof token !== "string"
        || token.length < 1
        || Buffer.byteLength(token, "utf8") > PASSKEY_BOOTSTRAP_TOKEN_MAX_BYTES
        || !isCanonicalCompactJwt(token)
      ) {
        throw new InvalidBootstrapTokenError();
      }

      const { currentDate, now } = this.#sampleClock();

      const { payload, protectedHeader } = await jwtVerify(token, this.#signingKey, {
        algorithms: [BOOTSTRAP_ALGORITHM],
        issuer: BOOTSTRAP_ISSUER,
        audience: BOOTSTRAP_AUDIENCE,
        currentDate,
        clockTolerance: 0
      });

      const claims = this.#strictClaims(payload, protectedHeader, expectedPurpose);
      if (claims.iat > now) throw new InvalidBootstrapTokenError();

      return this.#verifiedBinding(claims);
    } catch {
      throw new InvalidBootstrapTokenError();
    }
  }

  /**
   * Authenticates an expired token before its binding is used for a durable
   * lookup. Success is lookup-only and remains bounded to the replay grace.
   */
  async verifyReplayCandidate(
    token: string,
    expectedPurpose: BootstrapTokenPurpose
  ): Promise<BootstrapTokenReplayCandidate> {
    try {
      if (
        !isPurpose(expectedPurpose)
        || typeof token !== "string"
        || token.length < 1
        || Buffer.byteLength(token, "utf8") > PASSKEY_BOOTSTRAP_TOKEN_MAX_BYTES
        || !isCanonicalCompactJwt(token)
      ) {
        throw new InvalidBootstrapTokenError();
      }

      const { now } = this.#sampleClock();
      const { payload: encodedPayload, protectedHeader } = await compactVerify(
        token,
        this.#signingKey,
        { algorithms: [BOOTSTRAP_ALGORITHM] }
      );
      const payload = JSON.parse(STRICT_UTF8_DECODER.decode(encodedPayload)) as unknown;
      const claims = this.#strictClaims(payload, protectedHeader, expectedPurpose);
      if (
        claims.iat > now
        || (now >= claims.exp
          && now - claims.exp >= BOOTSTRAP_TOKEN_MAX_COMMITTED_REPLAY_GRACE_SECONDS)
      ) {
        throw new InvalidBootstrapTokenError();
      }
      return this.#verifiedBinding(claims);
    } catch {
      throw new InvalidBootstrapTokenError();
    }
  }

  /**
   * Allows bounded response-loss recovery for only an exact, purpose-matched
   * token and an explicit committed outcome. All failures remain opaque.
   */
  async verifyCommittedReplay(
    token: string,
    expectedPurpose: BootstrapTokenPurpose,
    committedReplayInput: BootstrapTokenCommittedReplayInput
  ): Promise<void> {
    try {
      if (
        !isPurpose(expectedPurpose)
        || typeof token !== "string"
        || token.length < 1
        || Buffer.byteLength(token, "utf8") > PASSKEY_BOOTSTRAP_TOKEN_MAX_BYTES
        || !isCanonicalCompactJwt(token)
      ) {
        throw new InvalidBootstrapTokenError();
      }

      const durable = snapshotCommittedReplayInput(committedReplayInput);
      validateCommittedReplayInput(durable);
      const { now } = this.#sampleClock();
      if (
        durable.issueInput.purpose !== expectedPurpose
        || durable.issueInput.issuedAt > now
        || now >= durable.recoveryDeadline
      ) {
        throw new InvalidBootstrapTokenError();
      }

      const expectedToken = await this.#sign(durable.issueInput);
      if (!fixedLengthEqual(token, expectedToken)) throw new InvalidBootstrapTokenError();
    } catch {
      throw new InvalidBootstrapTokenError();
    }
  }

  #sampleClock(): Readonly<{ currentDate: Date; now: number }> {
    const sampledDate = this.clock();
    const sampledMilliseconds = Date.prototype.getTime.call(sampledDate);
    const now = Math.floor(sampledMilliseconds / 1_000);
    if (!isNumericDate(now)) throw new InvalidBootstrapTokenError();
    return Object.freeze({ currentDate: new Date(now * 1_000), now });
  }

  #strictClaims(
    payloadValue: unknown,
    protectedHeaderValue: unknown,
    expectedPurpose: BootstrapTokenPurpose
  ): StrictBootstrapClaims {
    if (
      payloadValue === null
      || typeof payloadValue !== "object"
      || Array.isArray(payloadValue)
      || protectedHeaderValue === null
      || typeof protectedHeaderValue !== "object"
      || Array.isArray(protectedHeaderValue)
    ) {
      throw new InvalidBootstrapTokenError();
    }
    const payload = payloadValue as Readonly<Record<string, unknown>>;
    const protectedHeader = protectedHeaderValue as Readonly<Record<string, unknown>>;
    if (
      !hasExactKeys(protectedHeader, EXPECTED_HEADER_KEYS)
      || protectedHeader["alg"] !== BOOTSTRAP_ALGORITHM
      || protectedHeader["typ"] !== BOOTSTRAP_TOKEN_TYPE
      || !hasExactKeys(payload, EXPECTED_CLAIM_KEYS)
      || payload["iss"] !== BOOTSTRAP_ISSUER
      || payload["aud"] !== BOOTSTRAP_AUDIENCE
      || payload["token_use"] !== BOOTSTRAP_TOKEN_USE
      || !isCanonicalUuid(payload["intent_id"])
      || !isPurpose(payload["purpose"])
      || payload["purpose"] !== expectedPurpose
      || !isDigest(payload["target_digest"])
      || !isDeliveryNonce(payload["delivery_nonce"])
      || typeof payload["jti"] !== "string"
      || !BASE64URL_256_PATTERN.test(payload["jti"])
      || !isCanonicalBase64urlSegment(payload["jti"])
      || !isNumericDate(payload["iat"])
      || !isNumericDate(payload["exp"])
      || payload["exp"] <= payload["iat"]
      || payload["exp"] - payload["iat"] > BOOTSTRAP_TOKEN_MAX_TTL_SECONDS
    ) {
      throw new InvalidBootstrapTokenError();
    }

    const claims: StrictBootstrapClaims = Object.freeze({
      iss: BOOTSTRAP_ISSUER,
      aud: BOOTSTRAP_AUDIENCE,
      intent_id: payload["intent_id"],
      purpose: payload["purpose"],
      target_digest: payload["target_digest"],
      delivery_nonce: payload["delivery_nonce"],
      jti: payload["jti"],
      iat: payload["iat"],
      exp: payload["exp"],
      token_use: BOOTSTRAP_TOKEN_USE
    });
    const expectedJti = this.#deriveJti({
      intentId: claims.intent_id,
      purpose: claims.purpose,
      targetDigest: claims.target_digest,
      deliveryNonce: claims.delivery_nonce,
      issuedAt: claims.iat,
      expiresAt: claims.exp
    });
    if (!fixedLengthEqual(claims.jti, expectedJti)) throw new InvalidBootstrapTokenError();
    return claims;
  }

  #verifiedBinding(claims: StrictBootstrapClaims): VerifiedBootstrapTokenBinding {
    return Object.freeze({
      intentId: claims.intent_id,
      purpose: claims.purpose,
      targetDigest: claims.target_digest,
      deliveryNonce: claims.delivery_nonce,
      issuedAt: claims.iat,
      expiresAt: claims.exp
    });
  }

  #deriveJti(input: BootstrapTokenIssueInput): string {
    const canonicalTuple = JSON.stringify([
      input.intentId,
      input.purpose,
      input.targetDigest,
      input.deliveryNonce,
      input.issuedAt,
      input.expiresAt
    ]);
    return createHmac("sha256", this.#jtiKey)
      .update(JTI_MESSAGE_DOMAIN, "utf8")
      .update("\0", "utf8")
      .update(canonicalTuple, "utf8")
      .digest("base64url");
  }
}
