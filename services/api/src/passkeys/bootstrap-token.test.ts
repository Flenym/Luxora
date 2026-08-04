import { createHmac, hkdfSync } from "node:crypto";

import { CompactSign, decodeJwt, decodeProtectedHeader } from "jose";
import type { CompactJWSHeaderParameters } from "jose";
import { describe, expect, it, vi } from "vitest";

import {
  BOOTSTRAP_TOKEN_MAX_COMMITTED_REPLAY_GRACE_SECONDS,
  BOOTSTRAP_TOKEN_MAX_TTL_SECONDS,
  BootstrapTokenSecurity,
  InvalidBootstrapTokenError,
  InvalidBootstrapTokenInputError,
  type BootstrapTokenCommittedReplayInput,
  type BootstrapTokenIssueInput,
  type BootstrapTokenPurpose
} from "./bootstrap-token.js";

const SECRET = "bootstrap-test-access-secret-with-at-least-32-bytes";
const OTHER_SECRET = "other-bootstrap-access-secret-with-at-least-32-bytes";
const INTENT_ID = "1aa11111-1111-4111-8111-111111111111";
const OTHER_INTENT_ID = "2bb22222-2222-4222-8222-222222222222";
const TARGET_DIGEST = "a".repeat(64);
const DELIVERY_NONCE = "A".repeat(43);
const OTHER_DELIVERY_NONCE = "E".repeat(43);
const ISSUED_AT = 1_800_000_000;
const EXPIRES_AT = ISSUED_AT + BOOTSTRAP_TOKEN_MAX_TTL_SECONDS;
const RECOVERY_DEADLINE = EXPIRES_AT + BOOTSTRAP_TOKEN_MAX_COMMITTED_REPLAY_GRACE_SECONDS;
const NOW = ISSUED_AT + 100;

const FIXED_V1_TOKEN =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6Imx1eG9yYS1wYXNza2V5LWJvb3RzdHJhcCtqd3QifQ."
  + "eyJpc3MiOiJodHRwczovL2FwaS5sdXhvcmEuYXBwIiwiYXVkIjoibHV4b3JhLXBhc3NrZXktYm9vdHN0cmFwIiwiaW50ZW50X2lkIjoiMWFhMTExMTEtMTExMS00MTExLTgxMTEtMTExMTExMTExMTExIiwicHVycG9zZSI6ImFjY291bnQuY3JlYXRlIiwidGFyZ2V0X2RpZ2VzdCI6ImFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWEiLCJkZWxpdmVyeV9ub25jZSI6IkFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUEiLCJqdGkiOiJQOFJPMXZmZkhjZnp5ZDlXdlNkZXNsLXZJdGVwa1hQd3JtcmNweTJKc3BVIiwiaWF0IjoxODAwMDAwMDAwLCJleHAiOjE4MDAwMDAzMDAsInRva2VuX3VzZSI6InBhc3NrZXlfYm9vdHN0cmFwIn0."
  + "jqYeqUINUR8ip_tp2DYAMPVST6AdcpjXDJTpNGgXTvg";

const HEADER = Object.freeze({ alg: "HS256", typ: "luxora-passkey-bootstrap+jwt" });

function issueInput(
  overrides: Partial<BootstrapTokenIssueInput> = {}
): BootstrapTokenIssueInput {
  return {
    intentId: INTENT_ID,
    purpose: "account.create",
    targetDigest: TARGET_DIGEST,
    deliveryNonce: DELIVERY_NONCE,
    issuedAt: ISSUED_AT,
    expiresAt: EXPIRES_AT,
    ...overrides
  };
}

function committedReplayInput(
  issueOverrides: Partial<BootstrapTokenIssueInput> = {},
  envelopeOverrides: Partial<Omit<BootstrapTokenCommittedReplayInput, "issueInput">> = {}
): BootstrapTokenCommittedReplayInput {
  return {
    state: "committed",
    recoveryDeadline: RECOVERY_DEADLINE,
    issueInput: issueInput(issueOverrides),
    ...envelopeOverrides
  };
}

function verifiedBinding(
  purpose: BootstrapTokenPurpose = "account.create"
): Record<string, unknown> {
  return {
    intentId: INTENT_ID,
    purpose,
    targetDigest: TARGET_DIGEST,
    deliveryNonce: DELIVERY_NONCE,
    issuedAt: ISSUED_AT,
    expiresAt: EXPIRES_AT
  };
}

function verifier(now = NOW, secret = SECRET): BootstrapTokenSecurity {
  return new BootstrapTokenSecurity(secret, () => new Date(now * 1_000));
}

function derivedBootstrapSigningKey(secret = SECRET): Uint8Array {
  return new Uint8Array(hkdfSync(
    "sha256",
    Buffer.from(secret, "utf8"),
    Buffer.from("luxora/passkey-bootstrap-authorization/v1/hs256/salt", "utf8"),
    Buffer.from("luxora/passkey-bootstrap-authorization/v1/hs256/signing-key", "utf8"),
    32
  ));
}

function derivedStepUpSigningKey(): Uint8Array {
  return new Uint8Array(hkdfSync(
    "sha256",
    Buffer.from(SECRET, "utf8"),
    Buffer.from("luxora/step-up-token/v1/hs256/salt", "utf8"),
    Buffer.from("luxora/step-up-token/v1/hs256/signing-key", "utf8"),
    32
  ));
}

function expectedJti(input: BootstrapTokenIssueInput): string {
  const key = new Uint8Array(hkdfSync(
    "sha256",
    Buffer.from(SECRET, "utf8"),
    Buffer.from("luxora/passkey-bootstrap-authorization/v1/jti/salt", "utf8"),
    Buffer.from("luxora/passkey-bootstrap-authorization/v1/jti/hmac-key", "utf8"),
    32
  ));
  return createHmac("sha256", key)
    .update("luxora/passkey-bootstrap-authorization/v1/jti", "utf8")
    .update("\0", "utf8")
    .update(JSON.stringify([
      input.intentId,
      input.purpose,
      input.targetDigest,
      input.deliveryNonce,
      input.issuedAt,
      input.expiresAt
    ]), "utf8")
    .digest("base64url");
}

async function forge(
  payload: Record<string, unknown>,
  header: CompactJWSHeaderParameters = HEADER,
  key: Uint8Array = derivedBootstrapSigningKey()
): Promise<string> {
  return new CompactSign(Buffer.from(JSON.stringify(payload), "utf8"))
    .setProtectedHeader(header)
    .sign(key);
}

async function validFixture(
  purpose: BootstrapTokenPurpose = "account.create"
): Promise<{
  readonly security: BootstrapTokenSecurity;
  readonly token: string;
  readonly payload: Record<string, unknown>;
}> {
  const security = verifier();
  const token = await security.issue(issueInput({ purpose }));
  return { security, token, payload: { ...decodeJwt(token) } };
}

async function expectInvalid(
  security: BootstrapTokenSecurity,
  token: string,
  expectedPurpose: BootstrapTokenPurpose = "account.create"
): Promise<void> {
  try {
    await security.verify(token, expectedPurpose);
    throw new Error("expected bootstrap token verification to fail");
  } catch (error) {
    expect(error).toBeInstanceOf(InvalidBootstrapTokenError);
    expect(error).toMatchObject({
      name: "InvalidBootstrapTokenError",
      message: "invalid or expired bootstrap authorization"
    });
    expect((error as Error & { cause?: unknown }).cause).toBeUndefined();
    if (token.length > 0) expect(String(error)).not.toContain(token);
  }
}

async function expectCommittedReplayInvalid(
  security: BootstrapTokenSecurity,
  token: string,
  durable: BootstrapTokenCommittedReplayInput = committedReplayInput(),
  expectedPurpose: BootstrapTokenPurpose = "account.create"
): Promise<void> {
  try {
    await security.verifyCommittedReplay(token, expectedPurpose, durable);
    throw new Error("expected committed bootstrap replay verification to fail");
  } catch (error) {
    expect(error).toBeInstanceOf(InvalidBootstrapTokenError);
    expect(error).toMatchObject({
      name: "InvalidBootstrapTokenError",
      message: "invalid or expired bootstrap authorization"
    });
    expect((error as Error & { cause?: unknown }).cause).toBeUndefined();
    if (token.length > 0) expect(String(error)).not.toContain(token);
  }
}

async function expectReplayCandidateInvalid(
  security: BootstrapTokenSecurity,
  token: string,
  expectedPurpose: BootstrapTokenPurpose = "account.create"
): Promise<void> {
  try {
    await security.verifyReplayCandidate(token, expectedPurpose);
    throw new Error("expected bootstrap replay candidate verification to fail");
  } catch (error) {
    expect(error).toBeInstanceOf(InvalidBootstrapTokenError);
    expect(error).toMatchObject({
      name: "InvalidBootstrapTokenError",
      message: "invalid or expired bootstrap authorization"
    });
    expect((error as Error & { cause?: unknown }).cause).toBeUndefined();
    if (token.length > 0) expect(String(error)).not.toContain(token);
  }
}

describe("BootstrapTokenSecurity", () => {
  it("derives keys in a domain separate from access JWT and step-up", async () => {
    expect(() => new BootstrapTokenSecurity("x".repeat(31))).toThrow("at least 32 bytes");
    expect(() => new BootstrapTokenSecurity("é".repeat(16))).not.toThrow();
    expect(derivedBootstrapSigningKey()).not.toEqual(Buffer.from(SECRET, "utf8"));
    expect(derivedBootstrapSigningKey()).not.toEqual(derivedStepUpSigningKey());

    const token = await verifier().issue(issueInput());
    const payloadBytes = Buffer.from(token.split(".")[1] as string, "base64url");
    const directKeyToken = await new CompactSign(payloadBytes)
      .setProtectedHeader(HEADER)
      .sign(Buffer.from(SECRET, "utf8"));
    const stepUpKeyToken = await new CompactSign(payloadBytes)
      .setProtectedHeader(HEADER)
      .sign(derivedStepUpSigningKey());

    await expectInvalid(verifier(), directKeyToken);
    await expectInvalid(verifier(), stepUpKeyToken);
  });

  it("issues deterministic exact bootstrap claims without consulting the clock", async () => {
    const clock = vi.fn<() => Date>(() => {
      throw new Error("issuance must not read the clock");
    });
    const firstSecurity = new BootstrapTokenSecurity(SECRET, clock);
    const restartedSecurity = new BootstrapTokenSecurity(SECRET, clock);

    const first = await firstSecurity.issue(issueInput());
    const replay = await firstSecurity.issue(issueInput());
    const afterRestart = await restartedSecurity.issue(issueInput());

    expect(first).toBe(FIXED_V1_TOKEN);
    expect(first).toBe(replay);
    expect(first).toBe(afterRestart);
    expect(clock).not.toHaveBeenCalled();
    expect(decodeProtectedHeader(first)).toEqual(HEADER);
    expect(decodeJwt(first)).toEqual({
      iss: "https://api.luxora.app",
      aud: "luxora-passkey-bootstrap",
      intent_id: INTENT_ID,
      purpose: "account.create",
      target_digest: TARGET_DIGEST,
      delivery_nonce: DELIVERY_NONCE,
      jti: expectedJti(issueInput()),
      iat: ISSUED_AT,
      exp: EXPIRES_AT,
      token_use: "passkey_bootstrap"
    });
    expect(Object.keys(decodeJwt(first)).sort()).toEqual([
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
    ]);
    expect(decodeJwt(first)).not.toHaveProperty("sub");
    expect(decodeJwt(first)).not.toHaveProperty("sid");
    expect(decodeJwt(first)).not.toHaveProperty("account_id");
  });

  it("pins the complete v1 compact JWT known-answer vector", async () => {
    const token = await verifier().issue(issueInput());

    expect(token).toBe(FIXED_V1_TOKEN);
    expect(decodeProtectedHeader(FIXED_V1_TOKEN)).toEqual(HEADER);
    expect(decodeJwt(FIXED_V1_TOKEN).jti).toBe(expectedJti(issueInput()));
  });

  it("changes the token and deterministic jti for every durable input", async () => {
    const security = verifier();
    const baseline = await security.issue(issueInput());
    const baselineJti = decodeJwt(baseline).jti;
    const changes: readonly Partial<BootstrapTokenIssueInput>[] = [
      { intentId: OTHER_INTENT_ID },
      { purpose: "session.create" },
      { targetDigest: "b".repeat(64) },
      { deliveryNonce: OTHER_DELIVERY_NONCE },
      { issuedAt: ISSUED_AT + 1 },
      { expiresAt: EXPIRES_AT - 1 }
    ];

    for (const change of changes) {
      const changed = await security.issue(issueInput(change));
      expect(changed).not.toBe(baseline);
      expect(decodeJwt(changed).jti).not.toBe(baselineJti);
    }
  });

  it("cryptographically verifies before returning the exact identifier-free binding", async () => {
    const { security, token } = await validFixture();
    const binding = await security.verify(token, "account.create");
    expect(binding).toEqual(verifiedBinding());
    expect(Object.keys(binding).sort()).toEqual([
      "deliveryNonce",
      "expiresAt",
      "intentId",
      "issuedAt",
      "purpose",
      "targetDigest"
    ]);
    expect(Object.isFrozen(binding)).toBe(true);
    expect(binding).not.toHaveProperty("sub");
    expect(binding).not.toHaveProperty("sid");
    expect(binding).not.toHaveProperty("accountId");
    expect(binding).not.toHaveProperty("sessionId");

    const segments = token.split(".") as [string, string, string];
    const alteredPayload = Buffer.from(JSON.stringify({
      ...decodeJwt(token),
      intent_id: OTHER_INTENT_ID
    }), "utf8").toString("base64url");
    await expectInvalid(
      security,
      `${segments[0]}.${alteredPayload}.${segments[2]}`
    );
  });

  it("rejects invalid issue fields, non-canonical delivery entropy, and unsafe lifetimes", async () => {
    const security = verifier();
    const invalidInputs: readonly BootstrapTokenIssueInput[] = [
      issueInput({ intentId: INTENT_ID.toUpperCase() }),
      issueInput({ purpose: "authenticator.add" as BootstrapTokenPurpose }),
      issueInput({ targetDigest: "A".repeat(64) }),
      issueInput({ deliveryNonce: "A".repeat(42) }),
      issueInput({ deliveryNonce: `${"A".repeat(42)}B` }),
      issueInput({ deliveryNonce: "AA==" }),
      issueInput({ issuedAt: ISSUED_AT + 0.5 }),
      issueInput({ expiresAt: ISSUED_AT }),
      issueInput({ expiresAt: ISSUED_AT + BOOTSTRAP_TOKEN_MAX_TTL_SECONDS + 1 }),
      null as unknown as BootstrapTokenIssueInput
    ];

    for (const input of invalidInputs) {
      await expect(security.issue(input)).rejects.toBeInstanceOf(InvalidBootstrapTokenInputError);
    }
  });

  it("requires an exact plain issue record and never invokes hostile accessors or proxy traps", async () => {
    const security = verifier();
    const extraIdentifierInputs = [
      { ...issueInput(), accountId: OTHER_INTENT_ID },
      { ...issueInput(), sessionId: OTHER_INTENT_ID },
      { ...issueInput(), sub: OTHER_INTENT_ID },
      { ...issueInput(), username: "alice" }
    ] as unknown as readonly BootstrapTokenIssueInput[];
    const inherited = Object.create(issueInput()) as BootstrapTokenIssueInput;
    const classLike = Object.assign(
      Object.create({ classMarker: true }),
      issueInput()
    ) as BootstrapTokenIssueInput;
    const arrayLike = Object.assign([], issueInput()) as unknown as BootstrapTokenIssueInput;
    const symbolExtra = { ...issueInput() } as BootstrapTokenIssueInput & Record<symbol, string>;
    symbolExtra[Symbol("accountId")] = OTHER_INTENT_ID;

    let getterReads = 0;
    const accessor = {
      ...issueInput(),
      get intentId(): string {
        getterReads += 1;
        throw new Error("RAW_BOOTSTRAP_ISSUE_GETTER_CANARY");
      }
    } as BootstrapTokenIssueInput;
    let proxyTraps = 0;
    const proxy = new Proxy(issueInput(), {
      ownKeys() {
        proxyTraps += 1;
        throw new Error("RAW_BOOTSTRAP_ISSUE_PROXY_CANARY");
      },
      get() {
        proxyTraps += 1;
        throw new Error("RAW_BOOTSTRAP_ISSUE_PROXY_CANARY");
      }
    });

    for (const input of [
      ...extraIdentifierInputs,
      inherited,
      classLike,
      arrayLike,
      symbolExtra,
      accessor,
      proxy
    ]) {
      try {
        await security.issue(input);
        throw new Error("expected strict issue input validation to fail");
      } catch (error) {
        expect(error).toBeInstanceOf(InvalidBootstrapTokenInputError);
        expect(String(error)).toBe(
          "InvalidBootstrapTokenInputError: invalid bootstrap token input"
        );
        expect((error as Error & { cause?: unknown }).cause).toBeUndefined();
        expect(String(error)).not.toContain("CANARY");
      }
    }
    expect(getterReads).toBe(0);
    expect(proxyTraps).toBe(0);

    const nullPrototype = Object.assign(
      Object.create(null),
      issueInput()
    ) as BootstrapTokenIssueInput;
    await expect(security.issue(nullPrototype)).resolves.toBe(FIXED_V1_TOKEN);
  });

  it("rejects signature tampering, wrong key material, and poisoned clock details opaquely", async () => {
    const { security, token } = await validFixture();
    const segments = token.split(".") as [string, string, string];
    const alteredSignature = `${segments[2].startsWith("A") ? "B" : "A"}${segments[2].slice(1)}`;
    await expectInvalid(security, `${segments[0]}.${segments[1]}.${alteredSignature}`);
    await expectInvalid(verifier(NOW, OTHER_SECRET), token);

    const clockCanary = "RAW_BOOTSTRAP_CLOCK_CANARY";
    const poisonedClock = new BootstrapTokenSecurity(SECRET, () => {
      throw new Error(clockCanary);
    });
    try {
      await poisonedClock.verify(token, "account.create");
      throw new Error("expected poisoned clock verification to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(InvalidBootstrapTokenError);
      expect(String(error)).not.toContain(clockCanary);
      expect(String(error)).not.toContain(token);
      expect((error as Error & { cause?: unknown }).cause).toBeUndefined();
    }
  });

  it("samples a genuine Date instant once and ignores a hostile getTime override", async () => {
    const token = await verifier().issue(issueInput());
    let hostileReads = 0;
    class HostileDate extends Date {
      override getTime(): number {
        hostileReads += 1;
        return (ISSUED_AT + 1) * 1_000;
      }
    }
    const clock = vi.fn<() => Date>(() => new HostileDate(EXPIRES_AT * 1_000));
    const security = new BootstrapTokenSecurity(SECRET, clock);

    await expectInvalid(security, token);
    expect(clock).toHaveBeenCalledOnce();
    expect(hostileReads).toBe(0);

    let proxyTraps = 0;
    const proxyDate = new Proxy(new Date(NOW * 1_000), {
      get() {
        proxyTraps += 1;
        throw new Error("RAW_BOOTSTRAP_CLOCK_PROXY_CANARY");
      }
    });
    await expectInvalid(new BootstrapTokenSecurity(SECRET, () => proxyDate), token);
    expect(proxyTraps).toBe(0);
  });

  it("rejects malformed, oversized, and non-canonical compact encodings", async () => {
    const { security, token } = await validFixture();
    const segments = token.split(".") as [string, string, string];
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    const lastIndex = alphabet.indexOf(segments[2].at(-1) as string);
    expect(lastIndex).toBeGreaterThanOrEqual(0);
    expect(lastIndex % 4).toBe(0);
    const unusedBitAlias =
      `${segments[0]}.${segments[1]}.${segments[2].slice(0, -1)}${alphabet[lastIndex + 1]}`;
    expect(Buffer.from(unusedBitAlias.split(".")[2] as string, "base64url"))
      .toEqual(Buffer.from(segments[2], "base64url"));

    for (const candidate of [
      "",
      "not-a-jwt",
      unusedBitAlias,
      `${token}=`,
      `${segments[0]}.${segments[1]}.${segments[2]}.extra`,
      `${segments[0]}..${segments[2]}`,
      "x".repeat(4_097)
    ]) {
      await expectInvalid(security, candidate);
    }
  });

  it("requires the exact protected header and rejects step-up token metadata", async () => {
    const { security, payload } = await validFixture();
    const candidates = await Promise.all([
      forge(payload, { alg: "HS256" }),
      forge(payload, { alg: "HS256", typ: "JWT" }),
      forge(payload, { alg: "HS256", typ: "luxora-step-up+jwt" }),
      forge(payload, { alg: "HS256", typ: "luxora-passkey-bootstrap+jwt", kid: "unexpected" }),
      forge(payload, { alg: "HS512", typ: "luxora-passkey-bootstrap+jwt" })
    ]);

    for (const candidate of candidates) await expectInvalid(security, candidate);
  });

  it("rejects wrong issuer, audience, token use, purpose, target, delivery nonce, and jti", async () => {
    const { security, payload } = await validFixture();
    const variants: readonly Record<string, unknown>[] = [
      { ...payload, iss: "https://api.evil.example" },
      { ...payload, aud: "luxora-step-up" },
      { ...payload, aud: ["luxora-passkey-bootstrap"] },
      { ...payload, token_use: "step_up" },
      { ...payload, purpose: "authenticator.add" },
      { ...payload, target_digest: "b".repeat(64) },
      { ...payload, delivery_nonce: OTHER_DELIVERY_NONCE },
      { ...payload, jti: "E".repeat(43) }
    ];

    for (const variant of variants) await expectInvalid(security, await forge(variant));
  });

  it("rejects a valid token at the other endpoint purpose", async () => {
    const accountToken = await verifier().issue(issueInput({ purpose: "account.create" }));
    const sessionToken = await verifier().issue(issueInput({ purpose: "session.create" }));

    await expectInvalid(verifier(), accountToken, "session.create");
    await expectInvalid(verifier(), sessionToken, "account.create");
    await expect(verifier().verify(sessionToken, "session.create"))
      .resolves.toEqual(verifiedBinding("session.create"));
    await expectInvalid(
      verifier(),
      accountToken,
      "authenticator.add" as BootstrapTokenPurpose
    );
  });

  it("rejects every missing claim and any extra subject, session, account, or role claim", async () => {
    const { security, payload } = await validFixture();
    for (const claim of Object.keys(payload)) {
      const missing = { ...payload };
      delete missing[claim];
      await expectInvalid(security, await forge(missing));
    }
    for (const extra of [
      { sub: INTENT_ID },
      { sid: OTHER_INTENT_ID },
      { account_id: INTENT_ID },
      { role: "admin" }
    ]) {
      await expectInvalid(security, await forge({ ...payload, ...extra }));
    }
  });

  it("rejects malformed claim types, identifiers, digests, nonces, and dates", async () => {
    const { security, payload } = await validFixture();
    const variants: readonly Record<string, unknown>[] = [
      { ...payload, intent_id: INTENT_ID.toUpperCase() },
      { ...payload, intent_id: 7 },
      { ...payload, purpose: null },
      { ...payload, target_digest: TARGET_DIGEST.toUpperCase() },
      { ...payload, target_digest: 7 },
      { ...payload, delivery_nonce: "A".repeat(42) },
      { ...payload, delivery_nonce: `${"A".repeat(42)}B` },
      { ...payload, delivery_nonce: 7 },
      { ...payload, jti: "A".repeat(42) },
      { ...payload, iat: String(ISSUED_AT) },
      { ...payload, exp: EXPIRES_AT + 0.5 }
    ];

    for (const variant of variants) await expectInvalid(security, await forge(variant));
  });

  it("rejects expired, future-issued, zero, and overlong token lifetimes", async () => {
    const expiredSecurity = verifier(EXPIRES_AT);
    const expired = await expiredSecurity.issue(issueInput());
    await expectInvalid(expiredSecurity, expired);

    const { security, payload } = await validFixture();
    const variants: readonly Record<string, unknown>[] = [
      { ...payload, iat: NOW + 1, exp: NOW + 2 },
      { ...payload, exp: ISSUED_AT },
      { ...payload, exp: ISSUED_AT + BOOTSTRAP_TOKEN_MAX_TTL_SECONDS + 1 },
      { ...payload, iat: -1 }
    ];
    for (const variant of variants) await expectInvalid(security, await forge(variant));
  });

  describe("authenticated replay lookup", () => {
    it("returns the exact frozen identifier-free binding for an expired token within grace", async () => {
      const token = await verifier().issue(issueInput());
      const clock = vi.fn<() => Date>(() => new Date((EXPIRES_AT + 100) * 1_000));
      const security = new BootstrapTokenSecurity(SECRET, clock);

      await expect(security.verify(token, "account.create"))
        .rejects.toBeInstanceOf(InvalidBootstrapTokenError);
      clock.mockClear();

      const candidate = await security.verifyReplayCandidate(token, "account.create");
      expect(candidate).toEqual(verifiedBinding());
      expect(Object.keys(candidate).sort()).toEqual([
        "deliveryNonce",
        "expiresAt",
        "intentId",
        "issuedAt",
        "purpose",
        "targetDigest"
      ]);
      expect(Object.isFrozen(candidate)).toBe(true);
      expect(candidate).not.toHaveProperty("sub");
      expect(candidate).not.toHaveProperty("sid");
      expect(candidate).not.toHaveProperty("accountId");
      expect(candidate).not.toHaveProperty("sessionId");
      expect(clock).toHaveBeenCalledOnce();
    });

    it("rejects tampering, the other endpoint purpose, another key, and future issuance", async () => {
      const token = await verifier().issue(issueInput());
      const segments = token.split(".") as [string, string, string];
      const alteredSignature = `${segments[2].startsWith("A") ? "B" : "A"}${segments[2].slice(1)}`;
      const future = await verifier().issue(issueInput({
        issuedAt: NOW + 1,
        expiresAt: NOW + 2
      }));

      await expectReplayCandidateInvalid(
        verifier(EXPIRES_AT + 1),
        `${segments[0]}.${segments[1]}.${alteredSignature}`
      );
      await expectReplayCandidateInvalid(verifier(EXPIRES_AT + 1), token, "session.create");
      await expectReplayCandidateInvalid(verifier(EXPIRES_AT + 1, OTHER_SECRET), token);
      await expectReplayCandidateInvalid(verifier(NOW), future);
    });

    it("accepts the final grace second and rejects at the exact recovery boundary", async () => {
      const token = await verifier().issue(issueInput());

      await expect(verifier(RECOVERY_DEADLINE - 1).verifyReplayCandidate(
        token,
        "account.create"
      )).resolves.toEqual(verifiedBinding());
      await expectReplayCandidateInvalid(verifier(RECOVERY_DEADLINE), token);
      await expectReplayCandidateInvalid(verifier(RECOVERY_DEADLINE + 1), token);
    });
  });

  describe("committed replay verification", () => {
    it("accepts only the exact committed token after a same-key restart within recovery grace", async () => {
      const token = await verifier().issue(issueInput());
      const expiredNow = EXPIRES_AT + 100;
      const clock = vi.fn<() => Date>(() => new Date(expiredNow * 1_000));
      const restarted = new BootstrapTokenSecurity(SECRET, clock);

      await expect(restarted.verify(token, "account.create"))
        .rejects.toBeInstanceOf(InvalidBootstrapTokenError);
      expect(clock).toHaveBeenCalledOnce();

      clock.mockClear();
      await expect(restarted.verifyCommittedReplay(
        token,
        "account.create",
        committedReplayInput()
      )).resolves.toBeUndefined();
      expect(clock).toHaveBeenCalledOnce();
    });

    it("rejects every durable binding and issuance-time mismatch", async () => {
      const security = verifier();
      const token = await security.issue(issueInput());
      const mismatches: readonly Partial<BootstrapTokenIssueInput>[] = [
        { intentId: OTHER_INTENT_ID },
        { purpose: "session.create" },
        { targetDigest: "b".repeat(64) },
        { deliveryNonce: OTHER_DELIVERY_NONCE },
        { issuedAt: ISSUED_AT + 1 },
        { expiresAt: EXPIRES_AT - 1 }
      ];
      for (const mismatch of mismatches) {
        const changedIssueInput = issueInput(mismatch);
        await expectCommittedReplayInvalid(security, token, {
          state: "committed",
          recoveryDeadline: changedIssueInput.expiresAt
            + BOOTSTRAP_TOKEN_MAX_COMMITTED_REPLAY_GRACE_SECONDS,
          issueInput: changedIssueInput
        });
      }
    });

    it("binds committed replay to the exact endpoint purpose", async () => {
      const expired = verifier(EXPIRES_AT + 1);
      const accountToken = await verifier().issue(issueInput({ purpose: "account.create" }));
      const sessionToken = await verifier().issue(issueInput({ purpose: "session.create" }));

      await expectCommittedReplayInvalid(
        expired,
        accountToken,
        committedReplayInput({ purpose: "account.create" }),
        "session.create"
      );
      await expectCommittedReplayInvalid(
        expired,
        sessionToken,
        committedReplayInput({ purpose: "session.create" }),
        "account.create"
      );
      await expect(expired.verifyCommittedReplay(
        sessionToken,
        "session.create",
        committedReplayInput({ purpose: "session.create" })
      )).resolves.toBeUndefined();
      await expectCommittedReplayInvalid(
        expired,
        accountToken,
        committedReplayInput(),
        "authenticator.add" as BootstrapTokenPurpose
      );
    });

    it("fails closed after key rotation or compact serializer drift", async () => {
      const security = verifier();
      const token = await security.issue(issueInput());
      const otherKeyToken = await verifier(NOW, OTHER_SECRET).issue(issueInput());
      await expectCommittedReplayInvalid(security, otherKeyToken);

      const payload = decodeJwt(token);
      const serializerDrift = await forge({
        token_use: payload["token_use"],
        exp: payload.exp,
        iat: payload.iat,
        jti: payload.jti,
        delivery_nonce: payload["delivery_nonce"],
        target_digest: payload["target_digest"],
        purpose: payload["purpose"],
        intent_id: payload["intent_id"],
        aud: payload.aud,
        iss: payload.iss
      }, { typ: "luxora-passkey-bootstrap+jwt", alg: "HS256" });
      expect(serializerDrift).not.toBe(token);
      expect(decodeJwt(serializerDrift)).toEqual(payload);
      await expect(security.verify(serializerDrift, "account.create"))
        .resolves.toEqual(verifiedBinding());
      await expectCommittedReplayInvalid(security, serializerDrift);
    });

    it("rejects malformed, oversized, non-canonical, or altered compact tokens", async () => {
      const security = verifier();
      const token = await security.issue(issueInput());

      const segments = token.split(".") as [string, string, string];
      const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
      const lastIndex = alphabet.indexOf(segments[2].at(-1) as string);
      const unusedBitAlias =
        `${segments[0]}.${segments[1]}.${segments[2].slice(0, -1)}${alphabet[lastIndex + 1]}`;
      const alteredPayload =
        `${segments[0]}.${segments[1].startsWith("A") ? "B" : "A"}${segments[1].slice(1)}.${segments[2]}`;

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

    it("collapses missing, uncommitted, invalid, and out-of-window outcomes opaquely", async () => {
      const security = verifier();
      const token = await security.issue(issueInput());
      const invalidInputs: readonly BootstrapTokenCommittedReplayInput[] = [
        committedReplayInput({ intentId: INTENT_ID.toUpperCase() }),
        committedReplayInput({ purpose: "authenticator.add" as BootstrapTokenPurpose }),
        committedReplayInput({ targetDigest: "A".repeat(64) }),
        committedReplayInput({ deliveryNonce: "A".repeat(42) }),
        committedReplayInput({ issuedAt: ISSUED_AT + 0.5 }),
        committedReplayInput({ expiresAt: ISSUED_AT }),
        committedReplayInput({}, { state: "pending" as "committed" }),
        committedReplayInput({}, {
          recoveryDeadline: EXPIRES_AT
            + BOOTSTRAP_TOKEN_MAX_COMMITTED_REPLAY_GRACE_SECONDS + 1
        }),
        null as unknown as BootstrapTokenCommittedReplayInput,
        {} as BootstrapTokenCommittedReplayInput
      ];
      for (const invalidInput of invalidInputs) {
        await expectCommittedReplayInvalid(security, token, invalidInput);
      }
      await expectCommittedReplayInvalid(verifier(RECOVERY_DEADLINE), token);
      await expectCommittedReplayInvalid(verifier(RECOVERY_DEADLINE + 1), token);
    });

    it("treats zero grace as replay only before the original token expiry", async () => {
      const token = await verifier().issue(issueInput());
      const noPostExpiryGrace = committedReplayInput({}, {
        recoveryDeadline: EXPIRES_AT
      });

      await expect(verifier(EXPIRES_AT - 1).verifyCommittedReplay(
        token,
        "account.create",
        noPostExpiryGrace
      )).resolves.toBeUndefined();
      await expectCommittedReplayInvalid(
        verifier(EXPIRES_AT),
        token,
        noPostExpiryGrace
      );
    });

    it("requires exact plain replay root and nested records without invoking hostile code", async () => {
      const security = verifier();
      const token = await security.issue(issueInput());
      const rootExtra = {
        ...committedReplayInput(),
        accountId: OTHER_INTENT_ID
      } as unknown as BootstrapTokenCommittedReplayInput;
      const nestedExtra = {
        ...committedReplayInput(),
        issueInput: { ...issueInput(), sub: OTHER_INTENT_ID }
      } as unknown as BootstrapTokenCommittedReplayInput;
      const classLikeRoot = Object.assign(
        Object.create({ classMarker: true }),
        committedReplayInput()
      ) as BootstrapTokenCommittedReplayInput;
      const arrayRoot = Object.assign(
        [],
        committedReplayInput()
      ) as unknown as BootstrapTokenCommittedReplayInput;
      let getterReads = 0;
      const accessorRoot = {
        ...committedReplayInput(),
        get state(): "committed" {
          getterReads += 1;
          throw new Error("RAW_BOOTSTRAP_DURABLE_GETTER_CANARY");
        }
      } as BootstrapTokenCommittedReplayInput;
      let proxyTraps = 0;
      const proxyRoot = new Proxy(committedReplayInput(), {
        ownKeys() {
          proxyTraps += 1;
          throw new Error("RAW_BOOTSTRAP_DURABLE_PROXY_CANARY");
        },
        get() {
          proxyTraps += 1;
          throw new Error("RAW_BOOTSTRAP_DURABLE_PROXY_CANARY");
        }
      });
      const proxyNested = {
        ...committedReplayInput(),
        issueInput: new Proxy(issueInput(), {
          ownKeys() {
            proxyTraps += 1;
            throw new Error("RAW_BOOTSTRAP_DURABLE_PROXY_CANARY");
          },
          get() {
            proxyTraps += 1;
            throw new Error("RAW_BOOTSTRAP_DURABLE_PROXY_CANARY");
          }
        })
      };

      for (const invalidInput of [
        rootExtra,
        nestedExtra,
        classLikeRoot,
        arrayRoot,
        accessorRoot,
        proxyRoot,
        proxyNested
      ]) {
        await expectCommittedReplayInvalid(security, token, invalidInput);
      }
      expect(getterReads).toBe(0);
      expect(proxyTraps).toBe(0);
    });

    it("never delegates exact replay comparison through the overridable public issuer", async () => {
      const security = verifier();
      const token = await security.issue(issueInput());
      const arbitraryCompactToken = "e30.e30.AA";
      const issueSpy = vi.spyOn(security, "issue").mockResolvedValue(arbitraryCompactToken);

      await expectCommittedReplayInvalid(security, arbitraryCompactToken);
      await expect(security.verifyCommittedReplay(
        token,
        "account.create",
        committedReplayInput()
      )).resolves.toBeUndefined();
      expect(issueSpy).not.toHaveBeenCalled();
    });

    it("accepts the final recovery second and rejects at the exact durable deadline", async () => {
      const token = await verifier().issue(issueInput());

      await expect(verifier(RECOVERY_DEADLINE - 1).verifyCommittedReplay(
        token,
        "account.create",
        committedReplayInput()
      )).resolves.toBeUndefined();
      await expectCommittedReplayInvalid(verifier(RECOVERY_DEADLINE), token);
    });
  });
});
