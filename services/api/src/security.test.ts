import { randomUUID } from "node:crypto";

import { decodeJwt, decodeProtectedHeader, SignJWT } from "jose";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  AccessTokenSigningError,
  InvalidDeterministicAccessTokenInputError,
  TokenSecurity,
  type DeterministicAccessTokenInput
} from "./security.js";
import { testConfig } from "./test-helpers.js";

const USER_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const SESSION_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const TOKEN_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const ISSUED_AT_SEC = 1_800_000_000;

function deterministicInput(
  overrides: Partial<DeterministicAccessTokenInput> = {}
): DeterministicAccessTokenInput {
  return {
    userId: USER_ID,
    sessionId: SESSION_ID,
    tokenId: TOKEN_ID,
    issuedAtSec: ISSUED_AT_SEC,
    expiresAtSec: ISSUED_AT_SEC + 900,
    ...overrides
  };
}

async function expectInvalid(input: DeterministicAccessTokenInput): Promise<void> {
  try {
    await new TokenSecurity(testConfig()).signDeterministicAccessToken(input);
    throw new Error("expected deterministic access input to fail");
  } catch (error) {
    expect(error).toBeInstanceOf(InvalidDeterministicAccessTokenInputError);
    expect(error).toMatchObject({
      name: "InvalidDeterministicAccessTokenInputError",
      message: "invalid deterministic access token input"
    });
    expect((error as Error & { cause?: unknown }).cause).toBeUndefined();
  }
}

describe("TokenSecurity deterministic access signing", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("signs only the explicit durable access claims", async () => {
    const security = new TokenSecurity(testConfig());
    const result = await security.signDeterministicAccessToken(deterministicInput());

    expect(Object.isFrozen(result)).toBe(true);
    expect(result.tokenId).toBe(TOKEN_ID);
    expect(decodeProtectedHeader(result.token)).toEqual({ alg: "HS256", typ: "JWT" });
    const claims = decodeJwt(result.token);
    expect(claims).toEqual({
      sid: SESSION_ID,
      token_use: "access",
      iss: "https://api.luxora.app",
      aud: "luxora-clients",
      sub: USER_ID,
      jti: TOKEN_ID,
      iat: ISSUED_AT_SEC,
      exp: ISSUED_AT_SEC + 900
    });
  });

  it("reproduces the exact compact JWT after restart without consulting a clock or RNG", async () => {
    const config = testConfig();
    const first = await new TokenSecurity(config)
      .signDeterministicAccessToken(deterministicInput());
    const restarted = await new TokenSecurity({ ...config })
      .signDeterministicAccessToken(deterministicInput());

    expect(restarted).toEqual(first);
    expect(restarted.token).toBe(first.token);
  });

  it("keeps deterministic issuance separate from ordinary random access issuance", async () => {
    const security = new TokenSecurity(testConfig());
    const deterministic = await security.signDeterministicAccessToken(deterministicInput());
    const firstRandom = await security.signAccessToken(USER_ID, SESSION_ID);
    const secondRandom = await security.signAccessToken(USER_ID, SESSION_ID);

    expect(firstRandom.tokenId).not.toBe(TOKEN_ID);
    expect(secondRandom.tokenId).not.toBe(TOKEN_ID);
    expect(secondRandom.tokenId).not.toBe(firstRandom.tokenId);
    expect(firstRandom.token).not.toBe(deterministic.token);
    expect(secondRandom.token).not.toBe(deterministic.token);
    expect(decodeJwt(firstRandom.token)).toMatchObject({
      sid: SESSION_ID,
      sub: USER_ID,
      token_use: "access",
      jti: firstRandom.tokenId
    });
    expect(decodeJwt(deterministic.token)).not.toHaveProperty("purpose");
  });

  it("binds every explicit durable input and accepts only the supported lifetime range", async () => {
    const security = new TokenSecurity(testConfig());
    const baseline = await security.signDeterministicAccessToken(deterministicInput());
    const variants = await Promise.all([
      security.signDeterministicAccessToken(deterministicInput({ userId: randomUUID() })),
      security.signDeterministicAccessToken(deterministicInput({ sessionId: randomUUID() })),
      security.signDeterministicAccessToken(deterministicInput({ tokenId: randomUUID() })),
      security.signDeterministicAccessToken(deterministicInput({
        issuedAtSec: ISSUED_AT_SEC + 1,
        expiresAtSec: ISSUED_AT_SEC + 901
      })),
      security.signDeterministicAccessToken(deterministicInput({
        expiresAtSec: ISSUED_AT_SEC + 60
      })),
      security.signDeterministicAccessToken(deterministicInput({
        expiresAtSec: ISSUED_AT_SEC + 3_600
      }))
    ]);

    expect(new Set([baseline.token, ...variants.map(({ token }) => token)]).size)
      .toBe(variants.length + 1);
  });

  it("rejects malformed, non-canonical, non-exact, and policy-bypassing inputs opaquely", async () => {
    const { tokenId: _tokenId, ...missingTokenId } = deterministicInput();
    const inherited = Object.assign(Object.create({ inherited: true }), deterministicInput());
    const nonEnumerable = { ...deterministicInput() };
    Object.defineProperty(nonEnumerable, "expiresAtSec", {
      configurable: true,
      enumerable: false,
      value: ISSUED_AT_SEC + 900,
      writable: true
    });
    const invalidInputs: readonly DeterministicAccessTokenInput[] = [
      deterministicInput({ userId: USER_ID.toUpperCase() }),
      deterministicInput({ sessionId: "not-a-uuid" }),
      deterministicInput({ tokenId: `${TOKEN_ID}!` }),
      deterministicInput({ issuedAtSec: -1 }),
      deterministicInput({ issuedAtSec: ISSUED_AT_SEC + 0.5 }),
      deterministicInput({ expiresAtSec: ISSUED_AT_SEC + 59 }),
      deterministicInput({ expiresAtSec: ISSUED_AT_SEC + 3_601 }),
      deterministicInput({ expiresAtSec: Number.NaN }),
      { ...deterministicInput(), purpose: "session.create" } as DeterministicAccessTokenInput,
      { ...deterministicInput(), token_use: "step_up" } as DeterministicAccessTokenInput,
      missingTokenId as DeterministicAccessTokenInput,
      inherited as DeterministicAccessTokenInput,
      nonEnumerable,
      null as unknown as DeterministicAccessTokenInput
    ];
    const symbolExtra = deterministicInput() as DeterministicAccessTokenInput & Record<symbol, string>;
    symbolExtra[Symbol("extra")] = "forbidden";

    for (const input of [...invalidInputs, symbolExtra]) await expectInvalid(input);
  });

  it("contains proxy, accessor, and signer failure canaries without attaching causes", async () => {
    const proxyCanary = "DETERMINISTIC_ACCESS_PROXY_CANARY";
    const poisonedProxy = new Proxy(deterministicInput(), {
      get() {
        throw new Error(proxyCanary);
      },
      ownKeys() {
        throw new Error(proxyCanary);
      }
    });
    try {
      await new TokenSecurity(testConfig()).signDeterministicAccessToken(poisonedProxy);
      throw new Error("expected proxy input to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(InvalidDeterministicAccessTokenInputError);
      expect(String(error)).not.toContain(proxyCanary);
      expect((error as Error & { cause?: unknown }).cause).toBeUndefined();
    }

    const getterCanary = "DETERMINISTIC_ACCESS_GETTER_CANARY";
    const accessor = { ...deterministicInput() } as Record<string, unknown>;
    Object.defineProperty(accessor, "userId", {
      enumerable: true,
      get() {
        throw new Error(getterCanary);
      }
    });
    try {
      await new TokenSecurity(testConfig()).signDeterministicAccessToken(
        accessor as unknown as DeterministicAccessTokenInput
      );
      throw new Error("expected accessor input to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(InvalidDeterministicAccessTokenInputError);
      expect(String(error)).not.toContain(getterCanary);
      expect((error as Error & { cause?: unknown }).cause).toBeUndefined();
    }

    const signingCanary = "DETERMINISTIC_ACCESS_SIGNING_CANARY";
    vi.spyOn(SignJWT.prototype, "sign").mockRejectedValueOnce(new Error(signingCanary));
    try {
      await new TokenSecurity(testConfig()).signDeterministicAccessToken(deterministicInput());
      throw new Error("expected signer failure");
    } catch (error) {
      expect(error).toBeInstanceOf(AccessTokenSigningError);
      expect(error).toMatchObject({
        name: "AccessTokenSigningError",
        message: "access token could not be signed"
      });
      expect(String(error)).not.toContain(signingCanary);
      expect(String(error)).not.toContain(USER_ID);
      expect(String(error)).not.toContain(SESSION_ID);
      expect(String(error)).not.toContain(TOKEN_ID);
      expect((error as Error & { cause?: unknown }).cause).toBeUndefined();
    }
  });
});
