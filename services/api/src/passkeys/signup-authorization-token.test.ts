import { randomBytes } from "node:crypto";

import { describe, expect, it } from "vitest";

import { BootstrapTokenSecurity } from "./bootstrap-token.js";
import {
  InvalidPasskeySignupAuthorizationError,
  InvalidPasskeySignupAuthorizationInputError,
  PasskeySignupAuthorizationSecurity,
  type PasskeySignupAuthorizationIssueInput
} from "./signup-authorization-token.js";

const NOW_SECONDS = 1_800_000_000;
const SECRET = "signup-authorization-test-secret-at-least-thirty-two-bytes";
const INTENT_ID = "11111111-1111-4111-8111-111111111111";
const DELIVERY_NONCE = randomBytes(32).toString("base64url");
const DIGEST_A = "a".repeat(64);
const DIGEST_B = "b".repeat(64);
const DIGEST_C = "c".repeat(64);

function input(
  overrides: Partial<PasskeySignupAuthorizationIssueInput> = {}
): PasskeySignupAuthorizationIssueInput {
  return {
    intentId: INTENT_ID,
    issuedRevision: 1,
    candidateDigest: DIGEST_A,
    challengeDigest: DIGEST_B,
    policyDigest: DIGEST_C,
    deliveryNonce: DELIVERY_NONCE,
    deviceName: "iPhone 17 Pro",
    refreshDerivationKeyId: "signup-active",
    accessTokenTtlSeconds: 900,
    sessionTtlSeconds: 86_400,
    issuedAt: NOW_SECONDS,
    expiresAt: NOW_SECONDS + 300,
    recoveryDeadline: NOW_SECONDS + 420,
    ...overrides
  };
}

describe("PasskeySignupAuthorizationSecurity", () => {
  it("issues deterministic strict signup-only claims and authenticates them", async () => {
    const security = new PasskeySignupAuthorizationSecurity(
      SECRET,
      () => new Date((NOW_SECONDS + 1) * 1_000)
    );
    const first = await security.issue(input());
    const second = await security.issue(input());

    expect(first).toBe(second);
    await expect(security.verifyActive(first)).resolves.toEqual(input());
    await expect(security.verifyReplayCandidate(first)).resolves.toEqual(input());
  });

  it("uses a signing namespace incompatible with primary-login bootstrap", async () => {
    const now = () => new Date((NOW_SECONDS + 1) * 1_000);
    const signup = new PasskeySignupAuthorizationSecurity(SECRET, now);
    const login = new BootstrapTokenSecurity(SECRET, now);
    const signupToken = await signup.issue(input());
    const loginToken = await login.issue({
      intentId: INTENT_ID,
      purpose: "account.create",
      targetDigest: DIGEST_C,
      deliveryNonce: DELIVERY_NONCE,
      issuedAt: NOW_SECONDS,
      expiresAt: NOW_SECONDS + 300
    });

    await expect(login.verify(signupToken, "account.create")).rejects
      .toBeInstanceOf(Error);
    await expect(signup.verifyReplayCandidate(loginToken)).rejects
      .toBeInstanceOf(InvalidPasskeySignupAuthorizationError);
  });

  it("permits only bounded signature-authenticated response recovery", async () => {
    let now = NOW_SECONDS + 301;
    const security = new PasskeySignupAuthorizationSecurity(
      SECRET,
      () => new Date(now * 1_000)
    );
    const token = await security.issue(input());

    await expect(security.verifyActive(token)).rejects
      .toBeInstanceOf(InvalidPasskeySignupAuthorizationError);
    await expect(security.verifyReplayCandidate(token)).resolves.toEqual(input());
    await expect(security.verifyCommittedReplay(token, input())).resolves.toBeUndefined();

    now = NOW_SECONDS + 420;
    await expect(security.verifyReplayCandidate(token)).rejects
      .toBeInstanceOf(InvalidPasskeySignupAuthorizationError);
    await expect(security.verifyCommittedReplay(token, input())).rejects
      .toBeInstanceOf(InvalidPasskeySignupAuthorizationError);
  });

  it.each([
    ["intent", { intentId: "11111111-1111-4111-8111-111111111111" }, { intentId: "22222222-2222-4222-8222-222222222222" }],
    ["revision", { issuedRevision: 1 as const }, { issuedRevision: 2 as unknown as 1 }],
    ["candidate", { candidateDigest: DIGEST_A }, { candidateDigest: "d".repeat(64) }],
    ["challenge", { challengeDigest: DIGEST_B }, { challengeDigest: "d".repeat(64) }],
    ["policy", { policyDigest: DIGEST_C }, { policyDigest: "d".repeat(64) }],
    ["delivery", { deliveryNonce: DELIVERY_NONCE }, { deliveryNonce: randomBytes(32).toString("base64url") }],
    ["device", { deviceName: "iPhone 17 Pro" }, { deviceName: "Other iPhone" }],
    ["refresh key", { refreshDerivationKeyId: "signup-active" }, { refreshDerivationKeyId: "rotated" }]
  ] as const)("rejects committed replay after %s substitution", async (_label, original, changed) => {
    const security = new PasskeySignupAuthorizationSecurity(
      SECRET,
      () => new Date((NOW_SECONDS + 1) * 1_000)
    );
    const token = await security.issue(input(original));
    await expect(security.verifyCommittedReplay(token, input(changed)))
      .rejects.toBeInstanceOf(InvalidPasskeySignupAuthorizationError);
  });

  it("rejects accessor/proxy/coercion input without evaluating canaries", async () => {
    const security = new PasskeySignupAuthorizationSecurity(SECRET);
    let reads = 0;
    const accessor = { ...input() } as Record<string, unknown>;
    Object.defineProperty(accessor, "intentId", {
      enumerable: true,
      get() {
        reads += 1;
        throw new Error("CANARY");
      }
    });
    const proxy = new Proxy(input(), {
      getPrototypeOf() { throw new Error("CANARY"); }
    });

    await expect(security.issue(accessor as unknown as PasskeySignupAuthorizationIssueInput))
      .rejects.toBeInstanceOf(InvalidPasskeySignupAuthorizationInputError);
    await expect(security.issue(proxy)).rejects
      .toBeInstanceOf(InvalidPasskeySignupAuthorizationInputError);
    await expect(security.issue(input({ accessTokenTtlSeconds: "900" as unknown as number })))
      .rejects.toBeInstanceOf(InvalidPasskeySignupAuthorizationInputError);
    expect(reads).toBe(0);
  });

  it("fails closed on malformed compact tokens and claim tampering", async () => {
    const security = new PasskeySignupAuthorizationSecurity(
      SECRET,
      () => new Date((NOW_SECONDS + 1) * 1_000)
    );
    const token = await security.issue(input());
    const [header, payload, signature] = token.split(".") as [string, string, string];
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Record<string, unknown>;
    claims["device_name"] = "Tampered";
    const tampered = `${header}.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.${signature}`;

    for (const value of ["", "e30.e30.AA==", `${token}.extra`, tampered]) {
      await expect(security.verifyReplayCandidate(value)).rejects
        .toBeInstanceOf(InvalidPasskeySignupAuthorizationError);
    }
  });
});
