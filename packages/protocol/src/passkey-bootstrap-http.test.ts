import { describe, expect, it } from "vitest";
import {
  BeginPasskeyLoginRequestSchema,
  BeginPasskeySignupRequestSchema,
  CapabilitiesRuntimeStateSchema,
  PASSKEY_BOOTSTRAP_AUTHORIZATION_HEADER,
  PASSKEY_BOOTSTRAP_AUTHORIZATION_SCHEME,
  PASSKEY_BOOTSTRAP_TOKEN_MAX_BYTES,
  PASSKEY_DELIVERY_NONCE_BYTES,
  PASSKEY_INTERNAL_LOGIN_OPTIONS_PATH,
  PASSKEY_INTERNAL_LOGIN_VERIFY_PATH,
  PASSKEY_INTERNAL_SIGNUP_OPTIONS_PATH,
  PASSKEY_INTERNAL_SIGNUP_VERIFY_PATH,
  PASSKEY_MAX_CREDENTIAL_RESPONSE_BYTES,
  PASSKEY_PRIMARY_AUTHENTICATION_REJECTION_MESSAGE,
  PasskeyBootstrapAuthorizationHeaderSchema,
  PasskeyBootstrapVerifyResponseSchema,
  PasskeyCeremonyRevisionETagSchema,
  PasskeyCredentialContentTypeSchema,
  PasskeyDeliveryNonceSchema,
  PasskeyIdempotencyKeySchema,
  PasskeyLoginBeginResponseSchema,
  PasskeyLoginVerifyResponseSchema,
  PasskeyPrimaryAuthenticationRejectionSchema,
  PasskeyPrimaryLoginOptionsSchema,
  PasskeySignupBeginResponseSchema,
  PasskeySignupOptionsSchema,
  PasskeySignupVerifyResponseSchema,
  VerifyPasskeyLoginRequestSchema,
  VerifyPasskeySignupRequestSchema,
  createCapabilitiesResponseV1
} from "./index.js";

const SIGNUP_CEREMONY_ID = "11111111-1111-4111-8111-111111111111";
const LOGIN_CEREMONY_ID = "22222222-2222-4222-8222-222222222222";
const COMMAND_ID = "33333333-3333-4333-8333-333333333333";
const CLIENT_NONCE = "44444444-4444-4444-8444-444444444444";
const SESSION_ID = "55555555-5555-4555-8555-555555555555";
const USER_ID = "66666666-6666-4666-8666-666666666666";
const CHALLENGE = "A".repeat(43);
const DELIVERY_NONCE = "E".repeat(43);
const USER_HANDLE = "A".repeat(43);
const BOOTSTRAP_TOKEN = "e30.e30.AAAA";
const EXPIRES_AT = "2026-08-04T00:05:00.000Z";

function registrationCredential() {
  return {
    id: "AQIDBA",
    rawId: "AQIDBA",
    response: {
      clientDataJSON: "e30",
      attestationObject: "oA",
      transports: ["internal", "hybrid"],
      publicKeyAlgorithm: -7,
      publicKey: "AQID",
      authenticatorData: "AQID"
    },
    authenticatorAttachment: "platform",
    clientExtensionResults: { credProps: { rk: true } },
    type: "public-key"
  };
}

function authenticationCredential() {
  return {
    id: "AQIDBA",
    rawId: "AQIDBA",
    response: {
      clientDataJSON: "e30",
      authenticatorData: "AQID",
      signature: "AQID",
      userHandle: USER_HANDLE
    },
    authenticatorAttachment: "platform",
    clientExtensionResults: {},
    type: "public-key"
  };
}

function signupOptions() {
  return {
    challenge: CHALLENGE,
    rp: { id: "auth.luxora.app", name: "Luxora" },
    user: {
      id: USER_HANDLE,
      name: "alice",
      displayName: "Alice"
    },
    pubKeyCredParams: [
      { type: "public-key", alg: -7 },
      { type: "public-key", alg: -257 }
    ],
    excludeCredentials: [],
    timeout: 300_000,
    attestation: "none",
    authenticatorSelection: {
      residentKey: "required",
      requireResidentKey: true,
      userVerification: "required"
    }
  };
}

function loginOptions() {
  return {
    challenge: CHALLENGE,
    rpId: "auth.luxora.app",
    timeout: 300_000,
    userVerification: "required"
  };
}

function bootstrapAuthorization(purpose: "account.create" | "session.create") {
  return {
    scheme: "Bearer",
    token: BOOTSTRAP_TOKEN,
    purpose,
    expiresAt: EXPIRES_AT
  };
}

function authProjection() {
  return {
    user: {
      id: USER_ID,
      username: "alice",
      displayName: "Alice",
      bio: "",
      avatarUrl: null,
      createdAt: "2026-08-04T00:00:00.000Z"
    },
    tokens: {
      accessToken: "access-token",
      refreshToken: "r".repeat(40),
      tokenType: "Bearer",
      expiresIn: 900,
      sessionId: SESSION_ID
    }
  };
}

function signupBeginResponse() {
  return {
    schemaVersion: 1,
    ceremony: {
      id: SIGNUP_CEREMONY_ID,
      kind: "registration",
      purpose: "account.create",
      state: "pending",
      revision: 1,
      expiresAt: EXPIRES_AT
    },
    replayed: false,
    bootstrapAuthorization: bootstrapAuthorization("account.create"),
    options: signupOptions()
  };
}

function loginBeginResponse() {
  return {
    schemaVersion: 1,
    ceremony: {
      id: LOGIN_CEREMONY_ID,
      kind: "authentication",
      purpose: "session.create",
      state: "pending",
      revision: 1,
      expiresAt: EXPIRES_AT
    },
    replayed: false,
    bootstrapAuthorization: bootstrapAuthorization("session.create"),
    options: loginOptions()
  };
}

function signupVerifyResponse() {
  return {
    schemaVersion: 1,
    ceremony: {
      id: SIGNUP_CEREMONY_ID,
      kind: "registration",
      purpose: "account.create",
      state: "consumed",
      revision: 2,
      expiresAt: EXPIRES_AT
    },
    verified: true,
    replayed: false,
    ...authProjection()
  };
}

function loginVerifyResponse() {
  return {
    schemaVersion: 1,
    ceremony: {
      id: LOGIN_CEREMONY_ID,
      kind: "authentication",
      purpose: "session.create",
      state: "consumed",
      revision: 2,
      expiresAt: EXPIRES_AT
    },
    verified: true,
    replayed: false,
    ...authProjection()
  };
}

function allKeys(value: unknown): string[] {
  if (value === null || typeof value !== "object") return [];
  if (Array.isArray(value)) return value.flatMap(allKeys);
  return Object.entries(value as Record<string, unknown>)
    .flatMap(([key, item]) => [key, ...allKeys(item)]);
}

describe("internal passkey signup and primary-login protocol", () => {
  it("pins four contract-only endpoints without changing public capability", () => {
    expect(PASSKEY_INTERNAL_SIGNUP_OPTIONS_PATH).toBe("/v1/auth/register/passkey/options");
    expect(PASSKEY_INTERNAL_SIGNUP_VERIFY_PATH).toBe("/v1/auth/register/passkey/verify");
    expect(PASSKEY_INTERNAL_LOGIN_OPTIONS_PATH)
      .toBe("/v1/auth/passkeys/authentication/options");
    expect(PASSKEY_INTERNAL_LOGIN_VERIFY_PATH)
      .toBe("/v1/auth/passkeys/authentication/verify");

    const runtime = CapabilitiesRuntimeStateSchema.parse({
      maxAttachmentBytes: 104_857_600,
      userStorageQuotaBytes: 1_073_741_824,
      uploadChunkSizeBytes: 1_048_576,
      uploadSessionTtlSeconds: 3_600,
      serverSearchConfigured: false,
      phoneAuthenticationAvailable: false
    });
    expect(createCapabilitiesResponseV1(runtime).features.passkeys).toBe(false);
  });

  it("canonicalizes the strict signup identity command", () => {
    expect(BeginPasskeySignupRequestSchema.parse({
      clientNonce: CLIENT_NONCE.toUpperCase(),
      deliveryNonce: DELIVERY_NONCE,
      username: " Alice_7 ",
      displayName: "  A\u030Alice Example  ",
      deviceName: "  E\u0301gor’s iPhone  "
    })).toEqual({
      clientNonce: CLIENT_NONCE,
      deliveryNonce: DELIVERY_NONCE,
      username: "alice_7",
      displayName: "Ålice Example",
      deviceName: "Égor’s iPhone"
    });

    for (const invalid of [
      { clientNonce: CLIENT_NONCE, deliveryNonce: DELIVERY_NONCE, username: "alice", displayName: "Alice", deviceName: "iPhone", password: "secret" },
      { clientNonce: CLIENT_NONCE, deliveryNonce: DELIVERY_NONCE, username: "alice", displayName: "Alice", deviceName: "iPhone", accountId: USER_ID },
      { clientNonce: CLIENT_NONCE, deliveryNonce: DELIVERY_NONCE, username: "alice", displayName: "Alice", deviceName: "iPhone", commandId: COMMAND_ID },
      { clientNonce: CLIENT_NONCE, deliveryNonce: DELIVERY_NONCE, username: "1alice", displayName: "Alice", deviceName: "iPhone" },
      { clientNonce: CLIENT_NONCE, deliveryNonce: DELIVERY_NONCE, username: "alice", displayName: "   ", deviceName: "iPhone" },
      { clientNonce: CLIENT_NONCE, deliveryNonce: DELIVERY_NONCE, username: "alice", displayName: "Alice", deviceName: "   " },
      { clientNonce: CLIENT_NONCE, deliveryNonce: DELIVERY_NONCE, username: "alice", displayName: "Alice" },
      { clientNonce: CLIENT_NONCE, username: "alice", displayName: "Alice", deviceName: "iPhone" }
    ]) {
      expect(BeginPasskeySignupRequestSchema.safeParse(invalid).success).toBe(false);
    }
  });

  it("keeps login begin identifier-free and strict", () => {
    expect(BeginPasskeyLoginRequestSchema.parse({
      clientNonce: CLIENT_NONCE.toUpperCase(),
      deliveryNonce: DELIVERY_NONCE
    })).toEqual({ clientNonce: CLIENT_NONCE, deliveryNonce: DELIVERY_NONCE });

    for (const forbidden of [
      { username: "alice" },
      { account: "alice" },
      { accountId: USER_ID },
      { userHandle: USER_HANDLE },
      { allowCredentials: [] },
      { deviceName: "Alice's iPhone" }
    ]) {
      expect(BeginPasskeyLoginRequestSchema.safeParse({
        clientNonce: CLIENT_NONCE,
        deliveryNonce: DELIVERY_NONCE,
        ...forbidden
      }).success).toBe(false);
    }
    expect(BeginPasskeyLoginRequestSchema.safeParse({ clientNonce: CLIENT_NONCE }).success)
      .toBe(false);
  });

  it("requires independent canonical 32-byte delivery entropy on both begin commands", () => {
    expect(PASSKEY_DELIVERY_NONCE_BYTES).toBe(32);
    expect(PasskeyDeliveryNonceSchema.parse(DELIVERY_NONCE)).toBe(DELIVERY_NONCE);

    for (const invalidDeliveryNonce of [
      "A".repeat(42),
      "A".repeat(44),
      `${"A".repeat(42)}B`,
      "AA==",
      CLIENT_NONCE
    ]) {
      expect(BeginPasskeySignupRequestSchema.safeParse({
        clientNonce: CLIENT_NONCE,
        deliveryNonce: invalidDeliveryNonce,
        username: "alice",
        displayName: "Alice",
        deviceName: "Alice’s iPhone"
      }).success).toBe(false);
      expect(BeginPasskeyLoginRequestSchema.safeParse({
        clientNonce: CLIENT_NONCE,
        deliveryNonce: invalidDeliveryNonce
      }).success).toBe(false);
    }
  });

  it("accepts only the exact bounded Bootstrap-Authorization bearer transport", () => {
    expect(PASSKEY_BOOTSTRAP_AUTHORIZATION_HEADER).toBe("Bootstrap-Authorization");
    expect(PASSKEY_BOOTSTRAP_AUTHORIZATION_SCHEME).toBe("Bearer");
    expect(PasskeyBootstrapAuthorizationHeaderSchema.parse(`Bearer ${BOOTSTRAP_TOKEN}`))
      .toBe(BOOTSTRAP_TOKEN);

    const maximumToken = `e30.e30.${"A".repeat(PASSKEY_BOOTSTRAP_TOKEN_MAX_BYTES - 8)}`;
    expect(maximumToken).toHaveLength(PASSKEY_BOOTSTRAP_TOKEN_MAX_BYTES);
    expect(PasskeyBootstrapAuthorizationHeaderSchema.safeParse(`Bearer ${maximumToken}`).success)
      .toBe(true);

    for (const invalid of [
      `bearer ${BOOTSTRAP_TOKEN}`,
      `Bearer  ${BOOTSTRAP_TOKEN}`,
      ` Bearer ${BOOTSTRAP_TOKEN}`,
      `Bearer ${BOOTSTRAP_TOKEN} `,
      "Bearer e30.e30.AB",
      "Bearer e30.e30.AA==",
      `Bearer e30.e30.${"A".repeat(PASSKEY_BOOTSTRAP_TOKEN_MAX_BYTES - 7)}`
    ]) {
      expect(PasskeyBootstrapAuthorizationHeaderSchema.safeParse(invalid).success).toBe(false);
    }
  });

  it("requires a resident, verified first credential without an account-derived exclusion set", () => {
    expect(PasskeySignupOptionsSchema.parse(signupOptions())).toEqual(signupOptions());
    for (const invalid of [
      {
        ...signupOptions(),
        authenticatorSelection: {
          ...signupOptions().authenticatorSelection,
          residentKey: "preferred"
        }
      },
      {
        ...signupOptions(),
        excludeCredentials: [{ id: "AQIDBA", type: "public-key" }]
      },
      { ...signupOptions(), accountId: USER_ID },
      { ...signupOptions(), rp: { ...signupOptions().rp, origin: "https://auth.luxora.app" } }
    ]) {
      expect(PasskeySignupOptionsSchema.safeParse(invalid).success).toBe(false);
    }
  });

  it("omits allowCredentials entirely from identifier-free login options", () => {
    expect(PasskeyPrimaryLoginOptionsSchema.parse(loginOptions())).toEqual(loginOptions());
    for (const forbidden of [
      { allowCredentials: [] },
      { allowCredentials: [{ id: "AQIDBA", type: "public-key" }] },
      { username: "alice" },
      { accountId: USER_ID }
    ]) {
      expect(PasskeyPrimaryLoginOptionsSchema.safeParse({
        ...loginOptions(),
        ...forbidden
      }).success).toBe(false);
    }
  });

  it("keeps separate verify schemas on the raw 64 KiB credential transport", () => {
    expect(PASSKEY_MAX_CREDENTIAL_RESPONSE_BYTES).toBe(65_536);
    expect(VerifyPasskeySignupRequestSchema.parse(registrationCredential()))
      .toEqual(registrationCredential());
    expect(VerifyPasskeyLoginRequestSchema.parse(authenticationCredential()))
      .toEqual(authenticationCredential());
    expect(VerifyPasskeySignupRequestSchema.safeParse(authenticationCredential()).success)
      .toBe(false);
    expect(VerifyPasskeyLoginRequestSchema.safeParse(registrationCredential()).success)
      .toBe(false);
    expect(VerifyPasskeySignupRequestSchema.safeParse({
      ceremonyId: SIGNUP_CEREMONY_ID,
      credential: registrationCredential()
    }).success).toBe(false);
    expect(VerifyPasskeyLoginRequestSchema.safeParse({
      ...authenticationCredential(),
      accountId: USER_ID
    }).success).toBe(false);
    expect(VerifyPasskeyLoginRequestSchema.safeParse({
      ...authenticationCredential(),
      deliveryNonce: DELIVERY_NONCE
    }).success).toBe(false);
    expect(VerifyPasskeyLoginRequestSchema.safeParse({
      ...authenticationCredential(),
      response: {
        ...authenticationCredential().response,
        clientDataJSON: "A".repeat(PASSKEY_MAX_CREDENTIAL_RESPONSE_BYTES + 1)
      }
    }).success).toBe(false);
  });

  it("uses the existing idempotency, revision, and WebAuthn content-type headers", () => {
    expect(PasskeyIdempotencyKeySchema.parse(COMMAND_ID.toUpperCase())).toBe(COMMAND_ID);
    expect(PasskeyCeremonyRevisionETagSchema.parse('"1"')).toBe(1);
    expect(PasskeyCredentialContentTypeSchema.parse("application/webauthn+json; charset=UTF-8"))
      .toBe("application/webauthn+json");
    expect(PasskeyIdempotencyKeySchema.safeParse("not-a-command-id").success).toBe(false);
    expect(PasskeyCeremonyRevisionETagSchema.safeParse("1").success).toBe(false);
    expect(PasskeyCredentialContentTypeSchema.safeParse("application/json").success).toBe(false);
  });

  it("binds begin responses to distinct bootstrap purposes and strict option shapes", () => {
    expect(PasskeySignupBeginResponseSchema.parse(signupBeginResponse()))
      .toEqual(signupBeginResponse());
    expect(PasskeyLoginBeginResponseSchema.parse(loginBeginResponse()))
      .toEqual(loginBeginResponse());

    expect(PasskeySignupBeginResponseSchema.safeParse({
      ...signupBeginResponse(),
      bootstrapAuthorization: bootstrapAuthorization("session.create")
    }).success).toBe(false);
    expect(PasskeyLoginBeginResponseSchema.safeParse({
      ...loginBeginResponse(),
      ceremony: { ...loginBeginResponse().ceremony, purpose: "account.create" }
    }).success).toBe(false);
    expect(PasskeyLoginBeginResponseSchema.safeParse({
      ...loginBeginResponse(),
      options: { ...loginOptions(), allowCredentials: [] }
    }).success).toBe(false);
    expect(PasskeySignupBeginResponseSchema.safeParse({
      ...signupBeginResponse(),
      accountId: USER_ID
    }).success).toBe(false);
  });

  it("returns only a safe auth projection after signup or login verification", () => {
    expect(PasskeySignupVerifyResponseSchema.parse(signupVerifyResponse()))
      .toEqual(signupVerifyResponse());
    expect(PasskeyLoginVerifyResponseSchema.parse(loginVerifyResponse()))
      .toEqual(loginVerifyResponse());
    expect(PasskeyBootstrapVerifyResponseSchema.parse(signupVerifyResponse()))
      .toEqual(signupVerifyResponse());
    expect(PasskeyBootstrapVerifyResponseSchema.parse(loginVerifyResponse()))
      .toEqual(loginVerifyResponse());

    const forbidden = new Set([
      "assertion",
      "attestationObject",
      "authenticatorData",
      "challenge",
      "credentialId",
      "publicKey",
      "rawId",
      "signCount",
      "signature",
      "userHandle"
    ]);
    expect(allKeys(PasskeySignupVerifyResponseSchema.parse(signupVerifyResponse()))
      .filter((key) => forbidden.has(key))).toEqual([]);
    expect(PasskeyLoginVerifyResponseSchema.safeParse({
      ...loginVerifyResponse(),
      credentialId: "AQIDBA"
    }).success).toBe(false);
    expect(PasskeyLoginVerifyResponseSchema.safeParse({
      ...loginVerifyResponse(),
      user: { ...loginVerifyResponse().user, accountEpoch: 7 }
    }).success).toBe(false);
    expect(PasskeyLoginVerifyResponseSchema.safeParse({
      ...loginVerifyResponse(),
      tokens: { ...loginVerifyResponse().tokens, credentialId: "AQIDBA" }
    }).success).toBe(false);
  });

  it("collapses every primary-auth rejection to one strict oracle-safe shape", () => {
    const rejection = {
      error: {
        code: "UNAUTHENTICATED",
        message: PASSKEY_PRIMARY_AUTHENTICATION_REJECTION_MESSAGE,
        requestId: "request-id"
      }
    };
    expect(PasskeyPrimaryAuthenticationRejectionSchema.parse(rejection)).toEqual(rejection);
    for (const invalid of [
      { error: { ...rejection.error, code: "NOT_FOUND" } },
      { error: { ...rejection.error, message: "Unknown credential" } },
      { error: { ...rejection.error, details: { reason: "credential_not_found" } } },
      { ...rejection, accountId: USER_ID }
    ]) {
      expect(PasskeyPrimaryAuthenticationRejectionSchema.safeParse(invalid).success).toBe(false);
    }
  });
});
