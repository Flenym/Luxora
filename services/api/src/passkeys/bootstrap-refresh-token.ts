import { createHash, createHmac, hkdfSync } from "node:crypto";
import { types as utilTypes } from "node:util";

import { IdSchema } from "@luxora/protocol";

const DERIVATION_SALT = "luxora/passkey-bootstrap-refresh/v1/salt";
const DERIVATION_INFO_PREFIX = "luxora/passkey-bootstrap-refresh/v1/key/";
const TOKEN_MESSAGE_DOMAIN = "luxora/passkey-bootstrap-refresh/v1/token";
const DERIVED_KEY_BYTES = 32;
const DELIVERY_NONCE_BYTES = 32;
const KEY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;

export interface PasskeyBootstrapRefreshInput {
  readonly intentId: string;
  readonly accountId: string;
  readonly sessionId: string;
  readonly deliveryNonce: string;
}

export interface DerivedPasskeyBootstrapRefreshToken {
  readonly raw: string;
  readonly hash: string;
  readonly keyId: string;
  readonly deliveryNonceDigest: string;
}

export class InvalidPasskeyBootstrapRefreshConfigError extends Error {
  constructor() {
    super("invalid passkey bootstrap refresh configuration");
    this.name = "InvalidPasskeyBootstrapRefreshConfigError";
  }
}

export class InvalidPasskeyBootstrapRefreshInputError extends Error {
  constructor() {
    super("invalid passkey bootstrap refresh input");
    this.name = "InvalidPasskeyBootstrapRefreshInputError";
  }
}

export class UnknownPasskeyBootstrapRefreshKeyError extends Error {
  constructor() {
    super("passkey bootstrap refresh key is unavailable");
    this.name = "UnknownPasskeyBootstrapRefreshKeyError";
  }
}

function canonicalUuid(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const parsed = IdSchema.safeParse(value);
  return parsed.success && parsed.data === value;
}

function canonicalDeliveryNonce(value: unknown): value is string {
  if (typeof value !== "string" || value.length !== 43 || !BASE64URL_PATTERN.test(value)) return false;
  try {
    const decoded = Buffer.from(value, "base64url");
    return decoded.byteLength === DELIVERY_NONCE_BYTES && decoded.toString("base64url") === value;
  } catch {
    return false;
  }
}

function plainKeyRing(value: unknown): value is Readonly<Record<string, string>> {
  if (
    value === null
    || typeof value !== "object"
    || Array.isArray(value)
    || utilTypes.isProxy(value)
  ) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function snapshotInput(untrusted: PasskeyBootstrapRefreshInput): PasskeyBootstrapRefreshInput {
  let snapshot: PasskeyBootstrapRefreshInput;
  try {
    snapshot = Object.freeze({
      intentId: untrusted.intentId,
      accountId: untrusted.accountId,
      sessionId: untrusted.sessionId,
      deliveryNonce: untrusted.deliveryNonce
    });
  } catch {
    throw new InvalidPasskeyBootstrapRefreshInputError();
  }
  if (
    !canonicalUuid(snapshot.intentId)
    || !canonicalUuid(snapshot.accountId)
    || !canonicalUuid(snapshot.sessionId)
    || !canonicalDeliveryNonce(snapshot.deliveryNonce)
  ) {
    throw new InvalidPasskeyBootstrapRefreshInputError();
  }
  return snapshot;
}

function deriveSubkey(key: Uint8Array, keyId: string): Uint8Array {
  return new Uint8Array(hkdfSync(
    "sha256",
    key,
    Buffer.from(DERIVATION_SALT, "utf8"),
    Buffer.from(`${DERIVATION_INFO_PREFIX}${keyId}`, "utf8"),
    DERIVED_KEY_BYTES
  ));
}

/**
 * Deterministically derives the initial passkey-login refresh token so an
 * exact committed retry can recover a lost HTTP response. Persistence stores
 * only `hash`, `deliveryNonceDigest`, and `keyId`; raw token and nonce are never
 * accepted by the Store boundary.
 */
export class PasskeyBootstrapRefreshTokenSecurity {
  readonly #keys: ReadonlyMap<string, Uint8Array>;
  readonly #activeKeyId: string;

  constructor(encodedKeys: Readonly<Record<string, string>>, activeKeyId: string) {
    try {
      if (!plainKeyRing(encodedKeys)) throw new Error("invalid key ring");
      if (typeof activeKeyId !== "string" || !KEY_ID_PATTERN.test(activeKeyId)) {
        throw new Error("invalid active key");
      }
      const derived = new Map<string, Uint8Array>();
      for (const [keyId, encoded] of Object.entries(encodedKeys)) {
        if (!KEY_ID_PATTERN.test(keyId) || typeof encoded !== "string") throw new Error("invalid key entry");
        const raw = Buffer.from(encoded, "base64url");
        if (raw.byteLength !== 32 || raw.toString("base64url") !== encoded) {
          raw.fill(0);
          throw new Error("invalid key bytes");
        }
        try {
          derived.set(keyId, deriveSubkey(raw, keyId));
        } finally {
          raw.fill(0);
        }
      }
      if (derived.size === 0 || !derived.has(activeKeyId)) throw new Error("active key missing");
      this.#keys = derived;
      this.#activeKeyId = activeKeyId;
    } catch {
      throw new InvalidPasskeyBootstrapRefreshConfigError();
    }
  }

  /** Safe durable metadata captured before an anonymous credential resolves an account. */
  get activeKeyId(): string {
    return this.#activeKeyId;
  }

  deriveActive(input: PasskeyBootstrapRefreshInput): DerivedPasskeyBootstrapRefreshToken {
    return this.#derive(input, this.#activeKeyId);
  }

  rederive(input: PasskeyBootstrapRefreshInput, keyId: string): DerivedPasskeyBootstrapRefreshToken {
    if (typeof keyId !== "string" || !KEY_ID_PATTERN.test(keyId) || !this.#keys.has(keyId)) {
      throw new UnknownPasskeyBootstrapRefreshKeyError();
    }
    return this.#derive(input, keyId);
  }

  #derive(input: PasskeyBootstrapRefreshInput, keyId: string): DerivedPasskeyBootstrapRefreshToken {
    const safe = snapshotInput(input);
    const key = this.#keys.get(keyId);
    if (key === undefined) throw new UnknownPasskeyBootstrapRefreshKeyError();
    const tuple = JSON.stringify([
      safe.intentId,
      safe.accountId,
      safe.sessionId,
      safe.deliveryNonce
    ]);
    const tokenBytes = createHmac("sha256", key)
      .update(TOKEN_MESSAGE_DOMAIN, "utf8")
      .update("\0", "utf8")
      .update(tuple, "utf8")
      .digest();
    const raw = `luxr_${tokenBytes.toString("base64url")}`;
    tokenBytes.fill(0);
    return Object.freeze({
      raw,
      hash: createHash("sha256").update(raw, "utf8").digest("base64url"),
      keyId,
      deliveryNonceDigest: createHash("sha256")
        .update(Buffer.from(safe.deliveryNonce, "base64url"))
        .digest("hex")
    });
  }
}
