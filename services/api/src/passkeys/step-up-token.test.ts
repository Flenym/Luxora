import { createHmac, hkdfSync } from "node:crypto";

import { CompactSign, decodeJwt, decodeProtectedHeader } from "jose";
import type { CompactJWSHeaderParameters } from "jose";
import { describe, expect, it, vi } from "vitest";

import {
  InvalidStepUpTokenError,
  InvalidStepUpTokenInputError,
  STEP_UP_TOKEN_MAX_TTL_SECONDS,
  StepUpTokenSecurity,
  type StepUpTokenBinding,
  type StepUpTokenIssueInput
} from "./step-up-token.js";

const SECRET = "step-up-test-access-secret-with-at-least-32-bytes";
const ACCOUNT_ID = "1aa11111-1111-4111-8111-111111111111";
const OTHER_ACCOUNT_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const SESSION_ID = "2bb22222-2222-4222-8222-222222222222";
const OTHER_SESSION_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const CEREMONY_ID = "ceremony-01.passkey:add";
const TARGET_DIGEST = "a".repeat(64);
const ISSUED_AT = 1_800_000_000;
const EXPIRES_AT = ISSUED_AT + STEP_UP_TOKEN_MAX_TTL_SECONDS;
const NOW = ISSUED_AT + 100;

const HEADER = Object.freeze({ alg: "HS256", typ: "luxora-step-up+jwt" });

function issueInput(overrides: Partial<StepUpTokenIssueInput> = {}): StepUpTokenIssueInput {
  return {
    accountId: ACCOUNT_ID,
    sessionId: SESSION_ID,
    ceremonyId: CEREMONY_ID,
    purpose: "authenticator.add",
    targetDigest: TARGET_DIGEST,
    issuedAt: ISSUED_AT,
    expiresAt: EXPIRES_AT,
    ...overrides
  };
}

function binding(overrides: Partial<StepUpTokenBinding> = {}): StepUpTokenBinding {
  const input = issueInput(overrides);
  return {
    accountId: input.accountId,
    sessionId: input.sessionId,
    ceremonyId: input.ceremonyId,
    purpose: input.purpose,
    targetDigest: input.targetDigest
  };
}

function verifier(now = NOW): StepUpTokenSecurity {
  return new StepUpTokenSecurity(SECRET, () => new Date(now * 1_000));
}

function derivedSigningKey(): Uint8Array {
  return new Uint8Array(hkdfSync(
    "sha256",
    Buffer.from(SECRET, "utf8"),
    Buffer.from("luxora/step-up-token/v1/hs256/salt", "utf8"),
    Buffer.from("luxora/step-up-token/v1/hs256/signing-key", "utf8"),
    32
  ));
}

function expectedJti(input: StepUpTokenBinding): string {
  const key = new Uint8Array(hkdfSync(
    "sha256",
    Buffer.from(SECRET, "utf8"),
    Buffer.from("luxora/step-up-token/v1/jti/salt", "utf8"),
    Buffer.from("luxora/step-up-token/v1/jti/hmac-key", "utf8"),
    32
  ));
  return createHmac("sha256", key)
    .update("luxora/step-up-token/v1/jti", "utf8")
    .update("\0", "utf8")
    .update(JSON.stringify([
      input.ceremonyId,
      input.accountId,
      input.sessionId,
      input.purpose,
      input.targetDigest
    ]), "utf8")
    .digest("base64url");
}

async function forge(
  payload: Record<string, unknown>,
  header: CompactJWSHeaderParameters = HEADER
): Promise<string> {
  return new CompactSign(Buffer.from(JSON.stringify(payload), "utf8"))
    .setProtectedHeader(header)
    .sign(derivedSigningKey());
}

async function validFixture(): Promise<{
  readonly security: StepUpTokenSecurity;
  readonly token: string;
  readonly payload: Record<string, unknown>;
}> {
  const security = verifier();
  const token = await security.issue(issueInput());
  return { security, token, payload: { ...decodeJwt(token) } };
}

async function expectInvalid(
  security: StepUpTokenSecurity,
  token: string,
  expected = binding()
): Promise<void> {
  try {
    await security.verify(token, expected);
    throw new Error("expected verification to fail");
  } catch (error) {
    expect(error).toBeInstanceOf(InvalidStepUpTokenError);
    expect(error).toMatchObject({
      name: "InvalidStepUpTokenError",
      message: "invalid or expired step-up token"
    });
    expect((error as Error & { cause?: unknown }).cause).toBeUndefined();
    expect(String(error)).not.toContain(token);
  }
}

async function expectCommittedReplayInvalid(
  security: StepUpTokenSecurity,
  token: string,
  durable = issueInput()
): Promise<void> {
  try {
    await security.verifyCommittedReplay(token, durable);
    throw new Error("expected committed replay verification to fail");
  } catch (error) {
    expect(error).toBeInstanceOf(InvalidStepUpTokenError);
    expect(error).toMatchObject({
      name: "InvalidStepUpTokenError",
      message: "invalid or expired step-up token"
    });
    expect((error as Error & { cause?: unknown }).cause).toBeUndefined();
    if (token.length > 0) expect(String(error)).not.toContain(token);
  }
}

describe("StepUpTokenSecurity", () => {
  it("derives a separate key from a secret of at least 32 UTF-8 bytes", async () => {
    expect(() => new StepUpTokenSecurity("x".repeat(31))).toThrow("at least 32 bytes");
    expect(() => new StepUpTokenSecurity("é".repeat(16))).not.toThrow();

    const token = await verifier().issue(issueInput());
    const [encodedHeader, encodedPayload, signature] = token.split(".");
    expect(encodedHeader).toBeDefined();
    expect(encodedPayload).toBeDefined();
    expect(signature).toBeDefined();

    // Access JWTs use the configured secret directly. A direct-key signature must not verify here.
    const directKeyToken = await new CompactSign(Buffer.from(encodedPayload as string, "base64url"))
      .setProtectedHeader(HEADER)
      .sign(Buffer.from(SECRET, "utf8"));
    await expectInvalid(verifier(), directKeyToken);
  });

  it("issues exact deterministic headers and claims without consulting the clock", async () => {
    const clock = vi.fn<() => Date>(() => {
      throw new Error("issuance must not read the clock");
    });
    const firstSecurity = new StepUpTokenSecurity(SECRET, clock);
    const secondSecurity = new StepUpTokenSecurity(SECRET, clock);

    const first = await firstSecurity.issue(issueInput());
    const replay = await firstSecurity.issue(issueInput());
    const afterRestart = await secondSecurity.issue(issueInput());

    expect(first).toBe(replay);
    expect(first).toBe(afterRestart);
    expect(clock).not.toHaveBeenCalled();
    expect(decodeProtectedHeader(first)).toEqual(HEADER);
    expect(decodeJwt(first)).toEqual({
      iss: "https://api.luxora.app",
      aud: "luxora-step-up",
      sub: ACCOUNT_ID,
      sid: SESSION_ID,
      ceremony_id: CEREMONY_ID,
      jti: expectedJti(binding()),
      purpose: "authenticator.add",
      target_digest: TARGET_DIGEST,
      amr: ["webauthn"],
      auth_time: ISSUED_AT,
      iat: ISSUED_AT,
      exp: EXPIRES_AT,
      token_use: "step_up"
    });
  });

  it("diverges for every changed durable input while jti follows only its specified binding tuple", async () => {
    const security = verifier();
    const baseline = await security.issue(issueInput());
    const baselineJti = decodeJwt(baseline).jti;
    const bindingChanges: readonly Partial<StepUpTokenIssueInput>[] = [
      { accountId: OTHER_ACCOUNT_ID },
      { sessionId: OTHER_SESSION_ID },
      { ceremonyId: "ceremony-02.passkey:add" },
      { purpose: "authenticator.revoke" },
      { targetDigest: "b".repeat(64) }
    ];

    for (const change of bindingChanges) {
      const changed = await security.issue(issueInput(change));
      expect(changed).not.toBe(baseline);
      expect(decodeJwt(changed).jti).not.toBe(baselineJti);
    }

    const changedTime = await security.issue(issueInput({
      issuedAt: ISSUED_AT + 1,
      expiresAt: EXPIRES_AT + 1
    }));
    expect(changedTime).not.toBe(baseline);
    expect(decodeJwt(changedTime).jti).toBe(baselineJti);
  });

  it("verifies and returns only a deeply frozen safe claims object", async () => {
    const security = verifier();
    const claims = await security.verify(await security.issue(issueInput()), binding());

    expect(claims).toEqual({
      iss: "https://api.luxora.app",
      aud: "luxora-step-up",
      sub: ACCOUNT_ID,
      sid: SESSION_ID,
      ceremony_id: CEREMONY_ID,
      jti: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
      purpose: "authenticator.add",
      target_digest: TARGET_DIGEST,
      amr: ["webauthn"],
      auth_time: ISSUED_AT,
      iat: ISSUED_AT,
      exp: EXPIRES_AT,
      token_use: "step_up"
    });
    expect(Object.isFrozen(claims)).toBe(true);
    expect(Object.isFrozen(claims.amr)).toBe(true);
  });

  it("domain-separates authenticator revoke from authenticator add", async () => {
    const security = verifier();
    const revokeInput = issueInput({
      ceremonyId: "ceremony-03.passkey:revoke",
      purpose: "authenticator.revoke",
      targetDigest: "c".repeat(64)
    });
    const revokeBinding = binding(revokeInput);
    const token = await security.issue(revokeInput);
    expect(await security.verify(token, revokeBinding)).toMatchObject({
      purpose: "authenticator.revoke",
      ceremony_id: revokeInput.ceremonyId,
      target_digest: revokeInput.targetDigest
    });
    await expectInvalid(security, token, {
      ...revokeBinding,
      purpose: "authenticator.add"
    });
    await expect(security.verifyCommittedReplay(token, revokeInput)).resolves.toBeUndefined();
    await expectCommittedReplayInvalid(security, token, {
      ...revokeInput,
      purpose: "authenticator.add"
    });
  });

  it("rejects non-canonical issue bindings and invalid lifetimes", async () => {
    const security = verifier();
    const invalidInputs: readonly StepUpTokenIssueInput[] = [
      issueInput({ accountId: ACCOUNT_ID.toUpperCase() }),
      issueInput({ sessionId: SESSION_ID.toUpperCase() }),
      issueInput({ ceremonyId: "contains whitespace" }),
      issueInput({ ceremonyId: "c".repeat(129) }),
      issueInput({ purpose: "session.step_up" as "authenticator.add" }),
      issueInput({ targetDigest: "A".repeat(64) }),
      issueInput({ issuedAt: ISSUED_AT + 0.5 }),
      issueInput({ expiresAt: ISSUED_AT }),
      issueInput({ expiresAt: ISSUED_AT + STEP_UP_TOKEN_MAX_TTL_SECONDS + 1 })
    ];

    for (const input of invalidInputs) {
      await expect(security.issue(input)).rejects.toBeInstanceOf(InvalidStepUpTokenInputError);
    }
  });

  it("rejects an altered signature and never reflects raw token material or a verifier cause", async () => {
    const { security, token } = await validFixture();
    const segments = token.split(".");
    const signature = segments[2] as string;
    const altered = `${segments[0]}.${segments[1]}.${signature.startsWith("A") ? "B" : "A"}${signature.slice(1)}`;
    await expectInvalid(security, altered);

    const canaryToken = "RAW_STEP_UP_TOKEN_CANARY";
    const poisonedClock = new StepUpTokenSecurity(SECRET, () => {
      throw new Error(canaryToken);
    });
    try {
      await poisonedClock.verify(token, binding());
      throw new Error("expected verification to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(InvalidStepUpTokenError);
      expect(String(error)).not.toContain(canaryToken);
      expect((error as Error & { cause?: unknown }).cause).toBeUndefined();
    }
  });

  it("rejects non-canonical compact encodings before JOSE verification", async () => {
    const { security, token } = await validFixture();
    const segments = token.split(".") as [string, string, string];
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    const lastIndex = alphabet.indexOf(segments[2].at(-1) as string);
    expect(lastIndex).toBeGreaterThanOrEqual(0);
    expect(lastIndex % 4).toBe(0);
    const unusedBitAlias = `${segments[0]}.${segments[1]}.${segments[2].slice(0, -1)}${alphabet[lastIndex + 1]}`;

    // The alias decodes to exactly the same 32 signature bytes. Only an exact
    // decode/re-encode gate distinguishes it from the issued representation.
    expect(Buffer.from(unusedBitAlias.split(".")[2] as string, "base64url"))
      .toEqual(Buffer.from(segments[2], "base64url"));

    for (const candidate of [
      unusedBitAlias,
      `${token}=`,
      `${segments[0]}.${segments[1]}.${segments[2]}.extra`,
      `${segments[0]}..${segments[2]}`
    ]) {
      await expectInvalid(security, candidate);
    }
  });

  it("rejects wrong, missing, or extended protected headers and the wrong algorithm", async () => {
    const { security, payload } = await validFixture();
    const candidates = await Promise.all([
      forge(payload, { alg: "HS256" }),
      forge(payload, { alg: "HS256", typ: "JWT" }),
      forge(payload, { alg: "HS256", typ: "luxora-step-up+jwt", kid: "unexpected" }),
      forge(payload, { alg: "HS512", typ: "luxora-step-up+jwt" })
    ]);

    for (const candidate of candidates) await expectInvalid(security, candidate);
  });

  it("rejects wrong issuer, audience, token use, purpose, authentication method, and jti", async () => {
    const { security, payload } = await validFixture();
    const variants: readonly Record<string, unknown>[] = [
      { ...payload, iss: "https://api.evil.example" },
      { ...payload, aud: "luxora-clients" },
      { ...payload, aud: ["luxora-step-up"] },
      { ...payload, token_use: "access" },
      { ...payload, purpose: "session.step_up" },
      { ...payload, amr: ["pwd"] },
      { ...payload, amr: ["webauthn", "pwd"] },
      { ...payload, jti: "z".repeat(43) }
    ];

    for (const variant of variants) await expectInvalid(security, await forge(variant));
  });

  it("rejects valid tokens bound to another account, session, ceremony, or target", async () => {
    const security = verifier();
    const otherBindings: readonly Partial<StepUpTokenIssueInput>[] = [
      { accountId: OTHER_ACCOUNT_ID },
      { sessionId: OTHER_SESSION_ID },
      { ceremonyId: "other-ceremony" },
      { targetDigest: "b".repeat(64) }
    ];

    for (const other of otherBindings) {
      await expectInvalid(security, await security.issue(issueInput(other)));
    }
  });

  it("rejects every missing claim and every extra claim", async () => {
    const { security, payload } = await validFixture();
    for (const claim of Object.keys(payload)) {
      const missing = { ...payload };
      delete missing[claim];
      await expectInvalid(security, await forge(missing));
    }
    await expectInvalid(security, await forge({ ...payload, role: "admin" }));
  });

  it("rejects malformed claim types and non-canonical identifiers and digests", async () => {
    const { security, payload } = await validFixture();
    const variants: readonly Record<string, unknown>[] = [
      { ...payload, sub: ACCOUNT_ID.toUpperCase() },
      { ...payload, sid: SESSION_ID.toUpperCase() },
      { ...payload, sid: 7 },
      { ...payload, ceremony_id: "bad ceremony" },
      { ...payload, target_digest: TARGET_DIGEST.toUpperCase() },
      { ...payload, target_digest: 7 },
      { ...payload, iat: String(ISSUED_AT) },
      { ...payload, exp: EXPIRES_AT + 0.5 },
      { ...payload, auth_time: null },
      { ...payload, amr: "webauthn" }
    ];

    for (const variant of variants) await expectInvalid(security, await forge(variant));
  });

  it("rejects expired, future, mismatched-auth-time, and overlong lifetime tokens", async () => {
    const expiredSecurity = verifier(EXPIRES_AT);
    const expired = await expiredSecurity.issue(issueInput());
    await expectInvalid(expiredSecurity, expired);

    const { security, payload } = await validFixture();
    const timeVariants: readonly Record<string, unknown>[] = [
      {
        ...payload,
        iat: NOW + 1,
        auth_time: NOW + 1,
        exp: NOW + STEP_UP_TOKEN_MAX_TTL_SECONDS
      },
      { ...payload, auth_time: ISSUED_AT - 1 },
      { ...payload, exp: ISSUED_AT + STEP_UP_TOKEN_MAX_TTL_SECONDS + 1 },
      { ...payload, exp: ISSUED_AT }
    ];
    for (const variant of timeVariants) await expectInvalid(security, await forge(variant));
  });

  it("rejects an invalid expected binding and oversized input with the same opaque error", async () => {
    const { security, token } = await validFixture();
    await expectInvalid(security, token, binding({ ceremonyId: "not valid" }));
    await expectInvalid(security, "x".repeat(4_097));
  });

  describe("committed replay verification", () => {
    it("accepts an expired exact token and reproduces it after a same-key restart without reading the clock", async () => {
      const token = await verifier().issue(issueInput());
      const expiredNow = EXPIRES_AT + 100;
      const clock = vi.fn<() => Date>(() => new Date(expiredNow * 1_000));
      const restartedSecurity = new StepUpTokenSecurity(SECRET, clock);

      expect(EXPIRES_AT).toBeLessThan(expiredNow);
      await expect(restartedSecurity.verify(token, binding())).rejects.toBeInstanceOf(InvalidStepUpTokenError);
      expect(clock).toHaveBeenCalledOnce();

      clock.mockClear();
      await expect(restartedSecurity.verifyCommittedReplay(token, issueInput())).resolves.toBeUndefined();
      expect(clock).not.toHaveBeenCalled();
    });

    it("rejects a deterministic token produced by a different derived key", async () => {
      const otherSecret = "different-step-up-secret-with-at-least-32-bytes";
      const otherKeyToken = await new StepUpTokenSecurity(otherSecret).issue(issueInput());

      await expectCommittedReplayInvalid(verifier(), otherKeyToken);
    });

    it("rejects every valid binding and durable-time mismatch", async () => {
      const security = verifier();
      const token = await security.issue(issueInput());
      const mismatches: readonly Partial<StepUpTokenIssueInput>[] = [
        { accountId: OTHER_ACCOUNT_ID },
        { sessionId: OTHER_SESSION_ID },
        { ceremonyId: "ceremony-02.passkey:add" },
        { purpose: "authenticator.revoke" },
        { targetDigest: "b".repeat(64) },
        { issuedAt: ISSUED_AT + 1 },
        { expiresAt: EXPIRES_AT - 1 }
      ];

      for (const mismatch of mismatches) {
        await expectCommittedReplayInvalid(security, token, issueInput(mismatch));
      }
    });

    it("rejects malformed, non-canonical, oversized, and one-byte-altered compact tokens", async () => {
      const security = verifier();
      const token = await security.issue(issueInput());
      const segments = token.split(".") as [string, string, string];
      const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
      const lastIndex = alphabet.indexOf(segments[2].at(-1) as string);
      expect(lastIndex).toBeGreaterThanOrEqual(0);
      expect(lastIndex % 4).toBe(0);
      const unusedBitAlias = `${segments[0]}.${segments[1]}.${segments[2].slice(0, -1)}${alphabet[lastIndex + 1]}`;
      const alteredPayload = `${segments[0]}.${segments[1].startsWith("A") ? "B" : "A"}${segments[1].slice(1)}.${segments[2]}`;

      expect(Buffer.from(unusedBitAlias.split(".")[2] as string, "base64url"))
        .toEqual(Buffer.from(segments[2], "base64url"));

      for (const candidate of [
        "",
        "not-a-jwt",
        unusedBitAlias,
        alteredPayload,
        `${token}=`,
        `${segments[0]}.${segments[1]}.${segments[2]}.extra`,
        "x".repeat(4_097)
      ]) {
        await expectCommittedReplayInvalid(security, candidate);
      }
    });

    it("preserves an opaque durable-input error instead of treating database inconsistency as a token failure", async () => {
      const security = verifier();
      const token = await security.issue(issueInput());
      const invalidInputs: readonly StepUpTokenIssueInput[] = [
        issueInput({ accountId: ACCOUNT_ID.toUpperCase() }),
        issueInput({ sessionId: SESSION_ID.toUpperCase() }),
        issueInput({ ceremonyId: "contains whitespace" }),
        issueInput({ purpose: "session.step_up" as "authenticator.add" }),
        issueInput({ targetDigest: "A".repeat(64) }),
        issueInput({ issuedAt: ISSUED_AT + 0.5 }),
        issueInput({ expiresAt: ISSUED_AT }),
        issueInput({ expiresAt: ISSUED_AT + STEP_UP_TOKEN_MAX_TTL_SECONDS + 1 }),
        null as unknown as StepUpTokenIssueInput
      ];

      for (const invalidInput of invalidInputs) {
        try {
          await security.verifyCommittedReplay(token, invalidInput);
          throw new Error("expected durable input validation to fail");
        } catch (error) {
          expect(error).toBeInstanceOf(InvalidStepUpTokenInputError);
          expect(error).toMatchObject({
            name: "InvalidStepUpTokenInputError",
            message: "invalid step-up token input"
          });
          expect((error as Error & { cause?: unknown }).cause).toBeUndefined();
          expect(String(error)).not.toContain(token);
        }
      }
    });

    it("never leaks malformed token material, durable getter details, or an internal signing cause", async () => {
      const tokenCanary = "RAW_COMMITTED_REPLAY_TOKEN_CANARY";
      await expectCommittedReplayInvalid(verifier(), tokenCanary);

      const inputCanary = "RAW_DURABLE_INPUT_CANARY";
      const poisoned = {
        get accountId(): string {
          throw new Error(inputCanary);
        }
      } as unknown as StepUpTokenIssueInput;
      try {
        await verifier().verifyCommittedReplay(await verifier().issue(issueInput()), poisoned);
        throw new Error("expected durable input snapshot to fail");
      } catch (error) {
        expect(error).toBeInstanceOf(InvalidStepUpTokenInputError);
        expect(String(error)).not.toContain(inputCanary);
        expect((error as Error & { cause?: unknown }).cause).toBeUndefined();
      }

      const signingCanary = "RAW_INTERNAL_SIGNING_CAUSE_CANARY";
      const security = verifier();
      const exactToken = await security.issue(issueInput());
      vi.spyOn(security, "issue").mockRejectedValueOnce(new Error(signingCanary));
      try {
        await security.verifyCommittedReplay(exactToken, issueInput());
        throw new Error("expected deterministic re-issuance to fail");
      } catch (error) {
        expect(error).toBeInstanceOf(InvalidStepUpTokenError);
        expect(String(error)).not.toContain(signingCanary);
        expect(String(error)).not.toContain(exactToken);
        expect((error as Error & { cause?: unknown }).cause).toBeUndefined();
      }
    });
  });
});
