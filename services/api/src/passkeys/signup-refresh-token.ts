import { createHash, createHmac, hkdfSync } from "node:crypto";
import { types as utilTypes } from "node:util";

import { IdSchema, PasskeyDeliveryNonceSchema } from "@luxora/protocol";

const DERIVATION_SALT = "luxora/passkey-signup-refresh/v1/salt";
const DERIVATION_INFO_PREFIX = "luxora/passkey-signup-refresh/v1/key/";
const TOKEN_MESSAGE_DOMAIN = "luxora/passkey-signup-refresh/v1/token";
const DERIVED_KEY_BYTES = 32;
const KEY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
const INPUT_KEYS = ["intentId", "accountId", "sessionId", "deliveryNonce"] as const;

export interface PasskeySignupRefreshInput {
  readonly intentId: string;
  readonly accountId: string;
  readonly sessionId: string;
  readonly deliveryNonce: string;
}

export interface DerivedPasskeySignupRefreshToken {
  readonly raw: string;
  readonly hash: string;
  readonly keyId: string;
  readonly deliveryNonceDigest: string;
}

export class InvalidPasskeySignupRefreshConfigError extends Error {
  constructor() {
    super("invalid passkey signup refresh configuration");
    this.name = "InvalidPasskeySignupRefreshConfigError";
  }
}

export class InvalidPasskeySignupRefreshInputError extends Error {
  constructor() {
    super("invalid passkey signup refresh input");
    this.name = "InvalidPasskeySignupRefreshInputError";
  }
}

export class UnknownPasskeySignupRefreshKeyError extends Error {
  constructor() {
    super("passkey signup refresh key is unavailable");
    this.name = "UnknownPasskeySignupRefreshKeyError";
  }
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

function snapshotInput(input: PasskeySignupRefreshInput): PasskeySignupRefreshInput {
  try {
    if (
      input === null
      || typeof input !== "object"
      || Array.isArray(input)
      || utilTypes.isProxy(input)
      || (Object.getPrototypeOf(input) !== Object.prototype
        && Object.getPrototypeOf(input) !== null)
      || Reflect.ownKeys(input).length !== INPUT_KEYS.length
      || Reflect.ownKeys(input).some((key) => typeof key !== "string"
        || !INPUT_KEYS.includes(key as (typeof INPUT_KEYS)[number]))
    ) throw new Error("invalid input shape");
    const descriptors = Object.getOwnPropertyDescriptors(input);
    const values: Record<string, unknown> = {};
    for (const key of INPUT_KEYS) {
      const descriptor = descriptors[key];
      if (
        descriptor === undefined
        || descriptor.enumerable !== true
        || !("value" in descriptor)
      ) throw new Error("invalid input property");
      values[key] = descriptor.value;
    }
    const snapshot = Object.freeze({
      intentId: values["intentId"],
      accountId: values["accountId"],
      sessionId: values["sessionId"],
      deliveryNonce: values["deliveryNonce"]
    }) as PasskeySignupRefreshInput;
    if (
      !canonicalUuid(snapshot.intentId)
      || !canonicalUuid(snapshot.accountId)
      || !canonicalUuid(snapshot.sessionId)
      || !canonicalDeliveryNonce(snapshot.deliveryNonce)
    ) throw new Error("invalid input values");
    return snapshot;
  } catch {
    throw new InvalidPasskeySignupRefreshInputError();
  }
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

/** Signup refresh derivation has a domain separate from primary-login refreshes. */
export class PasskeySignupRefreshTokenSecurity {
  readonly #keys: ReadonlyMap<string, Uint8Array>;
  readonly #activeKeyId: string;

  constructor(encodedKeys: Readonly<Record<string, string>>, activeKeyId: string) {
    try {
      if (!plainKeyRing(encodedKeys) || !KEY_ID_PATTERN.test(activeKeyId)) {
        throw new Error("invalid key ring");
      }
      const keys = new Map<string, Uint8Array>();
      for (const [keyId, encoded] of Object.entries(encodedKeys)) {
        if (!KEY_ID_PATTERN.test(keyId) || typeof encoded !== "string") {
          throw new Error("invalid key entry");
        }
        const raw = Buffer.from(encoded, "base64url");
        if (raw.byteLength !== 32 || raw.toString("base64url") !== encoded) {
          raw.fill(0);
          throw new Error("invalid key bytes");
        }
        try {
          keys.set(keyId, deriveSubkey(raw, keyId));
        } finally {
          raw.fill(0);
        }
      }
      if (keys.size === 0 || !keys.has(activeKeyId)) throw new Error("active key missing");
      this.#keys = keys;
      this.#activeKeyId = activeKeyId;
    } catch {
      throw new InvalidPasskeySignupRefreshConfigError();
    }
  }

  get activeKeyId(): string {
    return this.#activeKeyId;
  }

  deriveActive(input: PasskeySignupRefreshInput): DerivedPasskeySignupRefreshToken {
    return this.#derive(input, this.#activeKeyId);
  }

  rederive(
    input: PasskeySignupRefreshInput,
    keyId: string
  ): DerivedPasskeySignupRefreshToken {
    if (typeof keyId !== "string" || !KEY_ID_PATTERN.test(keyId) || !this.#keys.has(keyId)) {
      throw new UnknownPasskeySignupRefreshKeyError();
    }
    return this.#derive(input, keyId);
  }

  #derive(
    input: PasskeySignupRefreshInput,
    keyId: string
  ): DerivedPasskeySignupRefreshToken {
    const safe = snapshotInput(input);
    const key = this.#keys.get(keyId);
    if (key === undefined) throw new UnknownPasskeySignupRefreshKeyError();
    const tuple = JSON.stringify([
      safe.intentId,
      safe.accountId,
      safe.sessionId,
      safe.deliveryNonce
    ]);
    const bytes = createHmac("sha256", key)
      .update(TOKEN_MESSAGE_DOMAIN, "utf8")
      .update("\0", "utf8")
      .update(tuple, "utf8")
      .digest();
    const raw = `luxr_${bytes.toString("base64url")}`;
    bytes.fill(0);
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
