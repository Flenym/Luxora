import { randomBytes } from "node:crypto";

import { describe, expect, it } from "vitest";

import { PasskeyBootstrapRefreshTokenSecurity } from "./bootstrap-refresh-token.js";
import {
  InvalidPasskeySignupRefreshInputError,
  PasskeySignupRefreshTokenSecurity,
  UnknownPasskeySignupRefreshKeyError
} from "./signup-refresh-token.js";

const KEY = randomBytes(32).toString("base64url");
const DELIVERY = randomBytes(32).toString("base64url");
const INPUT = Object.freeze({
  intentId: "11111111-1111-4111-8111-111111111111",
  accountId: "22222222-2222-4222-8222-222222222222",
  sessionId: "33333333-3333-4333-8333-333333333333",
  deliveryNonce: DELIVERY
});

describe("PasskeySignupRefreshTokenSecurity", () => {
  it("rederives an exact hash-only durable projection", () => {
    const security = new PasskeySignupRefreshTokenSecurity({ active: KEY }, "active");
    expect(security.deriveActive(INPUT)).toEqual(security.rederive(INPUT, "active"));
    expect(security.deriveActive(INPUT)).toMatchObject({
      keyId: "active",
      hash: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/u),
      deliveryNonceDigest: expect.stringMatching(/^[a-f0-9]{64}$/u)
    });
  });

  it("has a token derivation namespace distinct from primary login", () => {
    const signup = new PasskeySignupRefreshTokenSecurity({ active: KEY }, "active");
    const login = new PasskeyBootstrapRefreshTokenSecurity({ active: KEY }, "active");
    expect(signup.deriveActive(INPUT).raw).not.toBe(login.deriveActive(INPUT).raw);
  });

  it("binds every tuple component and key ID", () => {
    const security = new PasskeySignupRefreshTokenSecurity({ active: KEY }, "active");
    const original = security.deriveActive(INPUT).raw;
    for (const changed of [
      { ...INPUT, intentId: "44444444-4444-4444-8444-444444444444" },
      { ...INPUT, accountId: "44444444-4444-4444-8444-444444444444" },
      { ...INPUT, sessionId: "44444444-4444-4444-8444-444444444444" },
      { ...INPUT, deliveryNonce: randomBytes(32).toString("base64url") }
    ]) expect(security.deriveActive(changed).raw).not.toBe(original);
    expect(() => security.rederive(INPUT, "missing"))
      .toThrow(UnknownPasskeySignupRefreshKeyError);
  });

  it("rejects proxy and coercion inputs", () => {
    const security = new PasskeySignupRefreshTokenSecurity({ active: KEY }, "active");
    let reads = 0;
    const accessor = { ...INPUT } as Record<string, unknown>;
    Object.defineProperty(accessor, "sessionId", {
      enumerable: true,
      get() {
        reads += 1;
        throw new Error("CANARY");
      }
    });
    expect(() => security.deriveActive(new Proxy(INPUT, {})))
      .toThrow(InvalidPasskeySignupRefreshInputError);
    expect(() => security.deriveActive(accessor as unknown as typeof INPUT))
      .toThrow(InvalidPasskeySignupRefreshInputError);
    expect(() => security.deriveActive({
      ...INPUT,
      sessionId: 3 as unknown as string
    })).toThrow(InvalidPasskeySignupRefreshInputError);
    expect(reads).toBe(0);
  });
});
