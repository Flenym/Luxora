import { createHash, randomBytes, randomUUID } from "node:crypto";
import { types as utilTypes } from "node:util";
import { IdSchema } from "@luxora/protocol";
import { SignJWT, jwtVerify } from "jose";
import type { AppConfig } from "./config.js";
import { unauthenticated } from "./errors.js";
import type { AuthenticatedPrincipal } from "./domain/types.js";

const ISSUER = "https://api.luxora.app";
const AUDIENCE = "luxora-clients";
const ACCESS_TOKEN_MIN_TTL_SECONDS = 60;
const ACCESS_TOKEN_MAX_TTL_SECONDS = 3_600;
const DETERMINISTIC_ACCESS_TOKEN_INPUT_KEYS = [
  "userId",
  "sessionId",
  "tokenId",
  "issuedAtSec",
  "expiresAtSec"
] as const;

export interface DeterministicAccessTokenInput {
  readonly userId: string;
  readonly sessionId: string;
  readonly tokenId: string;
  readonly issuedAtSec: number;
  readonly expiresAtSec: number;
}

export class InvalidDeterministicAccessTokenInputError extends Error {
  constructor() {
    super("invalid deterministic access token input");
    this.name = "InvalidDeterministicAccessTokenInputError";
  }
}

export class AccessTokenSigningError extends Error {
  constructor() {
    super("access token could not be signed");
    this.name = "AccessTokenSigningError";
  }
}

function isCanonicalUuid(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const parsed = IdSchema.safeParse(value);
  return parsed.success && parsed.data === value;
}

function isNumericDate(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function snapshotDeterministicAccessTokenInput(
  untrusted: DeterministicAccessTokenInput
): DeterministicAccessTokenInput {
  let snapshot: DeterministicAccessTokenInput;
  try {
    if (
      untrusted === null
      || typeof untrusted !== "object"
      || Array.isArray(untrusted)
      || utilTypes.isProxy(untrusted)
    ) {
      throw new Error("invalid input object");
    }
    const prototype = Object.getPrototypeOf(untrusted);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new Error("invalid input prototype");
    }
    const ownKeys = Reflect.ownKeys(untrusted);
    if (
      ownKeys.length !== DETERMINISTIC_ACCESS_TOKEN_INPUT_KEYS.length
      || ownKeys.some((key) => typeof key !== "string"
        || !DETERMINISTIC_ACCESS_TOKEN_INPUT_KEYS.includes(
          key as (typeof DETERMINISTIC_ACCESS_TOKEN_INPUT_KEYS)[number]
        ))
    ) {
      throw new Error("invalid input keys");
    }
    const descriptors = Object.getOwnPropertyDescriptors(untrusted);
    const values: Record<string, unknown> = {};
    for (const key of DETERMINISTIC_ACCESS_TOKEN_INPUT_KEYS) {
      const descriptor = descriptors[key];
      if (
        descriptor === undefined
        || descriptor.enumerable !== true
        || !("value" in descriptor)
      ) {
        throw new Error("invalid input property");
      }
      values[key] = descriptor.value;
    }
    snapshot = Object.freeze({
      userId: values["userId"],
      sessionId: values["sessionId"],
      tokenId: values["tokenId"],
      issuedAtSec: values["issuedAtSec"],
      expiresAtSec: values["expiresAtSec"]
    }) as DeterministicAccessTokenInput;
  } catch {
    throw new InvalidDeterministicAccessTokenInputError();
  }
  if (
    !isCanonicalUuid(snapshot.userId)
    || !isCanonicalUuid(snapshot.sessionId)
    || !isCanonicalUuid(snapshot.tokenId)
    || !isNumericDate(snapshot.issuedAtSec)
    || !isNumericDate(snapshot.expiresAtSec)
  ) {
    throw new InvalidDeterministicAccessTokenInputError();
  }
  const lifetime = snapshot.expiresAtSec - snapshot.issuedAtSec;
  if (
    lifetime < ACCESS_TOKEN_MIN_TTL_SECONDS
    || lifetime > ACCESS_TOKEN_MAX_TTL_SECONDS
  ) throw new InvalidDeterministicAccessTokenInputError();
  return snapshot;
}

export class TokenSecurity {
  readonly #secret: Uint8Array;

  constructor(private readonly config: AppConfig) {
    this.#secret = new TextEncoder().encode(config.jwtSecret);
  }

  async signAccessToken(userId: string, sessionId: string): Promise<{ token: string; tokenId: string }> {
    const tokenId = randomUUID();
    const token = await new SignJWT({ sid: sessionId, token_use: "access" })
      .setProtectedHeader({ alg: "HS256", typ: "JWT" })
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setSubject(userId)
      .setJti(tokenId)
      .setIssuedAt()
      .setExpirationTime(`${this.config.accessTokenTtlSeconds}s`)
      .sign(this.#secret);
    return { token, tokenId };
  }

  /** Identical explicit durable claims and signing key produce the exact same compact JWT. */
  async signDeterministicAccessToken(
    input: DeterministicAccessTokenInput
  ): Promise<{ token: string; tokenId: string }> {
    const durable = snapshotDeterministicAccessTokenInput(input);
    try {
      const token = await new SignJWT({ sid: durable.sessionId, token_use: "access" })
        .setProtectedHeader({ alg: "HS256", typ: "JWT" })
        .setIssuer(ISSUER)
        .setAudience(AUDIENCE)
        .setSubject(durable.userId)
        .setJti(durable.tokenId)
        .setIssuedAt(durable.issuedAtSec)
        .setExpirationTime(durable.expiresAtSec)
        .sign(this.#secret);
      return Object.freeze({ token, tokenId: durable.tokenId });
    } catch {
      throw new AccessTokenSigningError();
    }
  }

  async verifyAccessToken(token: string): Promise<AuthenticatedPrincipal> {
    try {
      const { payload, protectedHeader } = await jwtVerify(token, this.#secret, {
        algorithms: ["HS256"],
        issuer: ISSUER,
        audience: AUDIENCE,
        clockTolerance: 5
      });
      const userId = IdSchema.safeParse(payload.sub);
      const sessionId = IdSchema.safeParse(payload["sid"]);
      const tokenId = IdSchema.safeParse(payload.jti);
      if (
        protectedHeader.typ !== "JWT" ||
        payload["token_use"] !== "access" ||
        !userId.success ||
        !sessionId.success ||
        !tokenId.success
      ) {
        throw new Error("Invalid token claims");
      }
      return { userId: userId.data, sessionId: sessionId.data, tokenId: tokenId.data };
    } catch {
      throw unauthenticated("Invalid or expired access token");
    }
  }

  newRefreshToken(): { raw: string; hash: string } {
    const raw = `luxr_${randomBytes(32).toString("base64url")}`;
    return { raw, hash: this.hashRefreshToken(raw) };
  }

  hashRefreshToken(raw: string): string {
    return createHash("sha256").update(raw, "utf8").digest("base64url");
  }
}
