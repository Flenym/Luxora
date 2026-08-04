import { createHmac, hkdfSync, timingSafeEqual } from "node:crypto";

import { IdSchema } from "@luxora/protocol";
import { SignJWT, jwtVerify } from "jose";

const STEP_UP_ISSUER = "https://api.luxora.app";
const STEP_UP_AUDIENCE = "luxora-step-up";
const STEP_UP_TOKEN_USE = "step_up";
const STEP_UP_TOKEN_TYPE = "luxora-step-up+jwt";
const STEP_UP_ALGORITHM = "HS256";
const STEP_UP_PURPOSES = new Set<StepUpTokenPurpose>([
  "authenticator.add",
  "authenticator.revoke"
]);
const STEP_UP_AUTHENTICATION_METHOD = "webauthn";

const SIGNING_KEY_SALT = "luxora/step-up-token/v1/hs256/salt";
const SIGNING_KEY_INFO = "luxora/step-up-token/v1/hs256/signing-key";
const JTI_KEY_SALT = "luxora/step-up-token/v1/jti/salt";
const JTI_KEY_INFO = "luxora/step-up-token/v1/jti/hmac-key";
const JTI_MESSAGE_DOMAIN = "luxora/step-up-token/v1/jti";

const DERIVED_KEY_BYTES = 32;
const MINIMUM_ACCESS_SECRET_BYTES = 32;
const MAX_TOKEN_BYTES = 4_096;
const MAX_CEREMONY_ID_LENGTH = 128;
const DIGEST_PATTERN = /^[a-f0-9]{64}$/;
const OPAQUE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const BASE64URL_SEGMENT_PATTERN = /^[A-Za-z0-9_-]+$/;
const BASE64URL_256_PATTERN = /^[A-Za-z0-9_-]{43}$/;

const EXPECTED_HEADER_KEYS = ["alg", "typ"] as const;
const EXPECTED_CLAIM_KEYS = [
  "amr",
  "aud",
  "auth_time",
  "ceremony_id",
  "exp",
  "iat",
  "iss",
  "jti",
  "purpose",
  "sid",
  "sub",
  "target_digest",
  "token_use"
] as const;

export const STEP_UP_TOKEN_MAX_TTL_SECONDS = 300;

export type StepUpTokenPurpose = "authenticator.add" | "authenticator.revoke";

export interface StepUpTokenBinding {
  readonly accountId: string;
  readonly sessionId: string;
  readonly ceremonyId: string;
  readonly purpose: StepUpTokenPurpose;
  readonly targetDigest: string;
}

export interface StepUpTokenIssueInput extends StepUpTokenBinding {
  /** NumericDate captured by the durable ceremony outcome; never sampled by issuance. */
  readonly issuedAt: number;
  /** NumericDate captured by the durable ceremony outcome, at most five minutes after issuedAt. */
  readonly expiresAt: number;
}

export interface VerifiedStepUpTokenClaims {
  readonly iss: typeof STEP_UP_ISSUER;
  readonly aud: typeof STEP_UP_AUDIENCE;
  readonly sub: string;
  readonly sid: string;
  readonly ceremony_id: string;
  readonly jti: string;
  readonly purpose: StepUpTokenPurpose;
  readonly target_digest: string;
  readonly amr: readonly [typeof STEP_UP_AUTHENTICATION_METHOD];
  readonly auth_time: number;
  readonly iat: number;
  readonly exp: number;
  readonly token_use: typeof STEP_UP_TOKEN_USE;
}

/** Opaque by design: token material and verifier causes must never escape this boundary. */
export class InvalidStepUpTokenError extends Error {
  constructor() {
    super("invalid or expired step-up token");
    this.name = "InvalidStepUpTokenError";
  }
}

/** Opaque by design: caller-controlled fields are not reflected into error messages. */
export class InvalidStepUpTokenInputError extends Error {
  constructor() {
    super("invalid step-up token input");
    this.name = "InvalidStepUpTokenInputError";
  }
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

function isOpaqueCeremonyId(value: unknown): value is string {
  return typeof value === "string"
    && value.length >= 1
    && value.length <= MAX_CEREMONY_ID_LENGTH
    && OPAQUE_ID_PATTERN.test(value);
}

function isDigest(value: unknown): value is string {
  return typeof value === "string" && DIGEST_PATTERN.test(value);
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
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function validateBinding(binding: StepUpTokenBinding): void {
  if (
    !isCanonicalUuid(binding.accountId)
    || !isCanonicalUuid(binding.sessionId)
    || !isOpaqueCeremonyId(binding.ceremonyId)
    || !STEP_UP_PURPOSES.has(binding.purpose)
    || !isDigest(binding.targetDigest)
  ) {
    throw new InvalidStepUpTokenInputError();
  }
}

function validateIssueInput(input: StepUpTokenIssueInput): void {
  validateBinding(input);
  if (
    !isNumericDate(input.issuedAt)
    || !isNumericDate(input.expiresAt)
    || input.expiresAt <= input.issuedAt
    || input.expiresAt - input.issuedAt > STEP_UP_TOKEN_MAX_TTL_SECONDS
  ) {
    throw new InvalidStepUpTokenInputError();
  }
}

function fixedLengthEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, "utf8");
  const rightBytes = Buffer.from(right, "utf8");
  return leftBytes.byteLength === rightBytes.byteLength && timingSafeEqual(leftBytes, rightBytes);
}

function frozenClaims(payload: Record<string, unknown>): VerifiedStepUpTokenClaims {
  return Object.freeze({
    iss: STEP_UP_ISSUER,
    aud: STEP_UP_AUDIENCE,
    sub: payload["sub"] as string,
    sid: payload["sid"] as string,
    ceremony_id: payload["ceremony_id"] as string,
    jti: payload["jti"] as string,
    purpose: payload["purpose"] as StepUpTokenPurpose,
    target_digest: payload["target_digest"] as string,
    amr: Object.freeze([STEP_UP_AUTHENTICATION_METHOD] as const),
    auth_time: payload["auth_time"] as number,
    iat: payload["iat"] as number,
    exp: payload["exp"] as number,
    token_use: STEP_UP_TOKEN_USE
  });
}

export class StepUpTokenSecurity {
  readonly #signingKey: Uint8Array;
  readonly #jtiKey: Uint8Array;

  constructor(
    accessJwtSecret: string,
    private readonly clock: () => Date = () => new Date()
  ) {
    if (typeof accessJwtSecret !== "string") {
      throw new Error("step-up token secret must be at least 32 bytes");
    }
    const secret = Buffer.from(accessJwtSecret, "utf8");
    if (secret.byteLength < MINIMUM_ACCESS_SECRET_BYTES) {
      secret.fill(0);
      throw new Error("step-up token secret must be at least 32 bytes");
    }
    try {
      this.#signingKey = deriveKey(secret, SIGNING_KEY_SALT, SIGNING_KEY_INFO);
      this.#jtiKey = deriveKey(secret, JTI_KEY_SALT, JTI_KEY_INFO);
    } finally {
      secret.fill(0);
    }
  }

  /**
   * Signs only explicit durable inputs. Identical inputs always produce the exact same compact JWT,
   * including after an ambiguous response or process restart.
   */
  async issue(input: StepUpTokenIssueInput): Promise<string> {
    validateIssueInput(input);
    const jti = this.#deriveJti(input);
    return new SignJWT({
      iss: STEP_UP_ISSUER,
      aud: STEP_UP_AUDIENCE,
      sub: input.accountId,
      sid: input.sessionId,
      ceremony_id: input.ceremonyId,
      jti,
      purpose: input.purpose,
      target_digest: input.targetDigest,
      amr: [STEP_UP_AUTHENTICATION_METHOD],
      auth_time: input.issuedAt,
      iat: input.issuedAt,
      exp: input.expiresAt,
      token_use: STEP_UP_TOKEN_USE
    })
      .setProtectedHeader({ alg: STEP_UP_ALGORITHM, typ: STEP_UP_TOKEN_TYPE })
      .sign(this.#signingKey);
  }

  async verify(token: string, expected: StepUpTokenBinding): Promise<VerifiedStepUpTokenClaims> {
    try {
      validateBinding(expected);
      if (
        typeof token !== "string"
        || token.length < 1
        || Buffer.byteLength(token, "utf8") > MAX_TOKEN_BYTES
        || !isCanonicalCompactJwt(token)
      ) {
        throw new InvalidStepUpTokenError();
      }
      const currentDate = this.clock();
      const now = Math.floor(currentDate.getTime() / 1_000);
      if (!isNumericDate(now)) throw new InvalidStepUpTokenError();

      const { payload, protectedHeader } = await jwtVerify(token, this.#signingKey, {
        algorithms: [STEP_UP_ALGORITHM],
        issuer: STEP_UP_ISSUER,
        audience: STEP_UP_AUDIENCE,
        currentDate,
        clockTolerance: 0
      });
      if (
        !hasExactKeys(protectedHeader, EXPECTED_HEADER_KEYS)
        || protectedHeader.alg !== STEP_UP_ALGORITHM
        || protectedHeader.typ !== STEP_UP_TOKEN_TYPE
        || !hasExactKeys(payload, EXPECTED_CLAIM_KEYS)
        || payload.iss !== STEP_UP_ISSUER
        || payload.aud !== STEP_UP_AUDIENCE
        || payload["token_use"] !== STEP_UP_TOKEN_USE
        || typeof payload["purpose"] !== "string"
        || !STEP_UP_PURPOSES.has(payload["purpose"] as StepUpTokenPurpose)
        || !isCanonicalUuid(payload.sub)
        || !isCanonicalUuid(payload["sid"])
        || !isOpaqueCeremonyId(payload["ceremony_id"])
        || !isDigest(payload["target_digest"])
        || typeof payload.jti !== "string"
        || !BASE64URL_256_PATTERN.test(payload.jti)
        || !Array.isArray(payload["amr"])
        || payload["amr"].length !== 1
        || payload["amr"][0] !== STEP_UP_AUTHENTICATION_METHOD
        || !isNumericDate(payload["auth_time"])
        || !isNumericDate(payload.iat)
        || !isNumericDate(payload.exp)
        || payload.iat !== payload["auth_time"]
        || payload.exp <= payload.iat
        || payload.exp - payload.iat > STEP_UP_TOKEN_MAX_TTL_SECONDS
        || payload.iat > now
        || payload.sub !== expected.accountId
        || payload["sid"] !== expected.sessionId
        || payload["ceremony_id"] !== expected.ceremonyId
        || payload["purpose"] !== expected.purpose
        || payload["target_digest"] !== expected.targetDigest
      ) {
        throw new InvalidStepUpTokenError();
      }

      const expectedJti = this.#deriveJti({
        accountId: payload.sub,
        sessionId: payload["sid"],
        ceremonyId: payload["ceremony_id"],
        purpose: payload["purpose"],
        targetDigest: payload["target_digest"]
      });
      if (!fixedLengthEqual(payload.jti, expectedJti)) throw new InvalidStepUpTokenError();
      return frozenClaims(payload);
    } catch {
      // Deliberately discard JOSE errors and caller data. In particular, never attach the raw token as a cause.
      throw new InvalidStepUpTokenError();
    }
  }

  /**
   * Verifies the exact token returned by an already-committed durable outcome.
   *
   * This deliberately does not perform a time-relaxed JOSE verification. Instead, the trusted
   * durable inputs are validated and deterministically re-issued, then the complete compact JWT is
   * compared byte-for-byte. Consequently an expired token is accepted only when it is the exact
   * representation this key would have issued for the recorded outcome.
   */
  async verifyCommittedReplay(token: string, durableIssueInput: StepUpTokenIssueInput): Promise<void> {
    let durable: StepUpTokenIssueInput;
    try {
      durable = Object.freeze({
        accountId: durableIssueInput.accountId,
        sessionId: durableIssueInput.sessionId,
        ceremonyId: durableIssueInput.ceremonyId,
        purpose: durableIssueInput.purpose,
        targetDigest: durableIssueInput.targetDigest,
        issuedAt: durableIssueInput.issuedAt,
        expiresAt: durableIssueInput.expiresAt
      });
    } catch {
      throw new InvalidStepUpTokenInputError();
    }
    validateIssueInput(durable);

    try {
      if (
        typeof token !== "string"
        || token.length < 1
        || Buffer.byteLength(token, "utf8") > MAX_TOKEN_BYTES
        || !isCanonicalCompactJwt(token)
      ) {
        throw new InvalidStepUpTokenError();
      }

      const expectedToken = await this.issue(durable);
      if (!fixedLengthEqual(token, expectedToken)) throw new InvalidStepUpTokenError();
    } catch {
      // Deliberately discard signing and caller-token details. The durable input was validated
      // outside this boundary so database inconsistencies retain their distinct input error.
      throw new InvalidStepUpTokenError();
    }
  }

  #deriveJti(binding: StepUpTokenBinding): string {
    const canonicalTuple = JSON.stringify([
      binding.ceremonyId,
      binding.accountId,
      binding.sessionId,
      binding.purpose,
      binding.targetDigest
    ]);
    return createHmac("sha256", this.#jtiKey)
      .update(JTI_MESSAGE_DOMAIN, "utf8")
      .update("\0", "utf8")
      .update(canonicalTuple, "utf8")
      .digest("base64url");
  }
}
