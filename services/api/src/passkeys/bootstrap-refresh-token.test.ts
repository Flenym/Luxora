import { createHash, randomUUID } from "node:crypto";

import { RefreshRequestSchema } from "@luxora/protocol";
import { describe, expect, it } from "vitest";

import { TokenSecurity } from "../security.js";
import { testConfig } from "../test-helpers.js";
import {
  InvalidPasskeyBootstrapRefreshConfigError,
  InvalidPasskeyBootstrapRefreshInputError,
  PasskeyBootstrapRefreshTokenSecurity,
  UnknownPasskeyBootstrapRefreshKeyError,
  type PasskeyBootstrapRefreshInput
} from "./bootstrap-refresh-token.js";

const ACTIVE_KEY = Buffer.alloc(32, 0x41).toString("base64url");
const OLD_KEY = Buffer.alloc(32, 0x24).toString("base64url");
const REPLACEMENT_KEY = Buffer.alloc(32, 0x52).toString("base64url");

const input = (overrides: Partial<PasskeyBootstrapRefreshInput> = {}): PasskeyBootstrapRefreshInput => ({
  intentId: "3a12c898-9864-4cba-83d4-e723cdd04f42",
  accountId: "b83d2e97-7fe8-4f95-9001-53cc0e8911e8",
  sessionId: "be9a8c91-3763-43f7-888d-0676edce1cc4",
  deliveryNonce: Buffer.alloc(32, 0x71).toString("base64url"),
  ...overrides
});

function security(activeKeyId = "active-v1") {
  return new PasskeyBootstrapRefreshTokenSecurity({
    "old-v0": OLD_KEY,
    "active-v1": ACTIVE_KEY
  }, activeKeyId);
}

describe("PasskeyBootstrapRefreshTokenSecurity", () => {
  it("exposes only the active durable key identifier", () => {
    const configured = security();
    expect(configured.activeKeyId).toBe("active-v1");
    expect(Object.keys(configured)).toEqual([]);
  });

  it("derives an exact restart-stable refresh token while exposing only persistable metadata", () => {
    const first = security().deriveActive(input());
    const restarted = security().rederive(input(), first.keyId);

    expect(restarted).toEqual(first);
    expect(first.raw).toMatch(/^luxr_[A-Za-z0-9_-]{43}$/);
    expect(first.hash).toBe(createHash("sha256").update(first.raw, "utf8").digest("base64url"));
    expect(first.deliveryNonceDigest).toBe(createHash("sha256")
      .update(Buffer.from(input().deliveryNonce, "base64url"))
      .digest("hex"));
    expect(JSON.stringify({
      hash: first.hash,
      keyId: first.keyId,
      deliveryNonceDigest: first.deliveryNonceDigest
    })).not.toContain(first.raw);
  });

  it("matches the existing refresh-token wire format and hash function", () => {
    const derived = security().deriveActive(input());
    const existing = new TokenSecurity(testConfig());

    expect(RefreshRequestSchema.parse({ refreshToken: derived.raw }))
      .toEqual({ refreshToken: derived.raw });
    expect(existing.hashRefreshToken(derived.raw)).toBe(derived.hash);
  });

  it("matches the fixed v1 derivation vector", () => {
    expect(security().deriveActive(input())).toEqual({
      raw: "luxr_oRL1CyBwpLaNhBWrApIk-TDmc4Fb3xW-Qsyr0pcm90s",
      hash: "7-J_bO-ToCxVN6hcuJEa-iXcuIJymXYdXOrBOL5xTs0",
      keyId: "active-v1",
      deliveryNonceDigest: "3e441393404b2085e7a3090a47d377abb7a6db6ad6bbd006a2f92cc7f469e651"
    });
  });

  it("binds output independently to root key material and key ID", () => {
    const baseline = security().deriveActive(input());
    const changedRoot = new PasskeyBootstrapRefreshTokenSecurity({
      "active-v1": REPLACEMENT_KEY
    }, "active-v1").deriveActive(input());
    const aliasedRoot = new PasskeyBootstrapRefreshTokenSecurity({
      "alias-a": ACTIVE_KEY,
      "alias-b": ACTIVE_KEY
    }, "alias-a");
    const aliasA = aliasedRoot.deriveActive(input());
    const aliasB = aliasedRoot.rederive(input(), "alias-b");

    expect(changedRoot.raw).not.toBe(baseline.raw);
    expect(changedRoot.hash).not.toBe(baseline.hash);
    expect(aliasB.raw).not.toBe(aliasA.raw);
    expect(aliasB.hash).not.toBe(aliasA.hash);
  });

  it("domain-binds intent, account, session, delivery nonce and key version", () => {
    const baseline = security().deriveActive(input());
    const variants = [
      security().deriveActive(input({ intentId: randomUUID() })),
      security().deriveActive(input({ accountId: randomUUID() })),
      security().deriveActive(input({ sessionId: randomUUID() })),
      security().deriveActive(input({ deliveryNonce: Buffer.alloc(32, 0x72).toString("base64url") })),
      security("old-v0").deriveActive(input())
    ];

    expect(new Set([baseline.raw, ...variants.map(({ raw }) => raw)])).toHaveLength(variants.length + 1);
    expect(new Set([baseline.hash, ...variants.map(({ hash }) => hash)])).toHaveLength(variants.length + 1);
  });

  it("retains old keys for exact response recovery after active-key rotation", () => {
    const old = security("old-v0").deriveActive(input());
    const rotated = security("active-v1");

    expect(rotated.rederive(input(), "old-v0")).toEqual(old);
    expect(rotated.deriveActive(input()).keyId).toBe("active-v1");
    expect(rotated.deriveActive(input()).raw).not.toBe(old.raw);
  });

  it("fails closed when an old key is removed or its key ID is reused with new material", () => {
    const committed = security("old-v0").deriveActive(input());
    const withoutOld = new PasskeyBootstrapRefreshTokenSecurity({
      "active-v1": ACTIVE_KEY
    }, "active-v1");
    const reusedOldId = new PasskeyBootstrapRefreshTokenSecurity({
      "old-v0": REPLACEMENT_KEY,
      "active-v1": ACTIVE_KEY
    }, "active-v1");

    expect(() => withoutOld.rederive(input(), committed.keyId))
      .toThrow(UnknownPasskeyBootstrapRefreshKeyError);

    const wrongCandidate = reusedOldId.rederive(input(), committed.keyId);
    expect(wrongCandidate.hash).not.toBe(committed.hash);
    expect(reusedOldId.deriveActive(input()).hash).not.toBe(committed.hash);
  });

  it.each([
    ["intent", input({ intentId: "not-a-uuid" })],
    ["account", input({ accountId: "B83D2E97-7FE8-4F95-9001-53CC0E8911E8" })],
    ["session", input({ sessionId: "be9a8c91-3763-43f7-888d-0676edce1cc5!" })],
    ["short nonce", input({ deliveryNonce: Buffer.alloc(31, 0x71).toString("base64url") })],
    ["long nonce", input({ deliveryNonce: Buffer.alloc(33, 0x71).toString("base64url") })],
    ["padded nonce", input({ deliveryNonce: `${Buffer.alloc(32, 0x71).toString("base64url") }=` })]
  ])("rejects invalid %s without reflecting input", (_label, invalid) => {
    expect(() => security().deriveActive(invalid)).toThrow(InvalidPasskeyBootstrapRefreshInputError);
    try {
      security().deriveActive(invalid);
    } catch (error) {
      expect(String(error)).toBe("InvalidPasskeyBootstrapRefreshInputError: invalid passkey bootstrap refresh input");
      expect(String(error)).not.toContain(JSON.stringify(invalid));
    }
  });

  it("rejects malformed key rings and unavailable durable key IDs opaquely", () => {
    expect(() => new PasskeyBootstrapRefreshTokenSecurity({}, "active-v1"))
      .toThrow(InvalidPasskeyBootstrapRefreshConfigError);
    expect(() => new PasskeyBootstrapRefreshTokenSecurity({ "bad key": ACTIVE_KEY }, "bad key"))
      .toThrow(InvalidPasskeyBootstrapRefreshConfigError);
    expect(() => new PasskeyBootstrapRefreshTokenSecurity({ "active-v1": "AA" }, "active-v1"))
      .toThrow(InvalidPasskeyBootstrapRefreshConfigError);
    expect(() => new PasskeyBootstrapRefreshTokenSecurity(
      [ACTIVE_KEY] as unknown as Readonly<Record<string, string>>,
      "0"
    )).toThrow(InvalidPasskeyBootstrapRefreshConfigError);
    class KeyRing {
      readonly "active-v1" = ACTIVE_KEY;
    }
    expect(() => new PasskeyBootstrapRefreshTokenSecurity(
      new KeyRing() as unknown as Readonly<Record<string, string>>,
      "active-v1"
    )).toThrow(InvalidPasskeyBootstrapRefreshConfigError);
    expect(() => new PasskeyBootstrapRefreshTokenSecurity(
      new Proxy({ "active-v1": ACTIVE_KEY }, {}) as Readonly<Record<string, string>>,
      "active-v1"
    )).toThrow(InvalidPasskeyBootstrapRefreshConfigError);
    expect(() => security().rederive(input(), "missing-v2"))
      .toThrow(UnknownPasskeyBootstrapRefreshKeyError);
  });

  it("contains hostile getter and proxy error canaries", () => {
    const poisoned = new Proxy({} as PasskeyBootstrapRefreshInput, {
      get(_target, property) {
        throw new Error(`refresh-input-${String(property)}-CANARY`);
      }
    });
    let thrown: unknown;
    try {
      security().deriveActive(poisoned);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(InvalidPasskeyBootstrapRefreshInputError);
    expect(String(thrown)).not.toContain("CANARY");

    const poisonedKeyRing = new Proxy({ "active-v1": ACTIVE_KEY }, {
      ownKeys() {
        throw new Error("refresh-key-ring-CANARY");
      }
    });
    let configThrown: unknown;
    try {
      new PasskeyBootstrapRefreshTokenSecurity(poisonedKeyRing, "active-v1");
    } catch (error) {
      configThrown = error;
    }
    expect(configThrown).toBeInstanceOf(InvalidPasskeyBootstrapRefreshConfigError);
    expect(String(configThrown)).toBe(
      "InvalidPasskeyBootstrapRefreshConfigError: invalid passkey bootstrap refresh configuration"
    );
    expect(String(configThrown)).not.toContain("CANARY");
  });
});
