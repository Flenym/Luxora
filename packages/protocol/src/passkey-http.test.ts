import { describe, expect, it } from "vitest";
import {
  BeginPasskeyRegistrationRequestSchema,
  BeginPasskeyStepUpRequestSchema,
  CapabilitiesRuntimeStateSchema,
  PASSKEY_MAX_CREDENTIAL_ID_BASE64URL_LENGTH,
  PASSKEY_MAX_CREDENTIAL_RESPONSE_BYTES,
  PASSKEY_STEP_UP_AUTHORIZATION_HEADER,
  PASSKEY_STEP_UP_AUTHORIZATION_SCHEME,
  PASSKEY_STEP_UP_TOKEN_MAX_BYTES,
  PasskeyAuthenticationCredentialJSONSchema,
  PasskeyBase64UrlSchema,
  PasskeyCeremonyErrorSchema,
  PasskeyCeremonyParamsSchema,
  PasskeyCeremonyRevisionETagSchema,
  PasskeyCeremonyVerifyRequestSchema,
  PasskeyCeremonyVerifyResponseSchema,
  PasskeyChallengeSchema,
  PasskeyClientExtensionResultsSchema,
  PasskeyCredentialContentTypeSchema,
  PasskeyCredentialIdSchema,
  PasskeyIdempotencyKeySchema,
  PasskeyRegistrationCredentialJSONSchema,
  PasskeyRegistrationVerifyResponseSchema,
  PasskeyStepUpAuthorizationHeaderSchema,
  PasskeyStepUpOptionsSchema,
  PasskeyStepUpTokenSchema,
  PasskeyStepUpVerifyResponseSchema,
  createCapabilitiesResponseV1
} from "./index.js";

const CEREMONY_ID = "11111111-1111-4111-8111-111111111111";
const STEP_UP_CEREMONY_ID = "22222222-2222-4222-8222-222222222222";
const COMMAND_ID = "33333333-3333-4333-8333-333333333333";
const CLIENT_NONCE = "44444444-4444-4444-8444-444444444444";
const CHALLENGE = "A".repeat(43);
const USER_HANDLE = "A".repeat(43);
const STEP_UP_TOKEN = "e30.e30.AAAA";

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

function verifyResponse() {
  return {
    schemaVersion: 1,
    ceremony: {
      id: CEREMONY_ID,
      kind: "registration",
      purpose: "authenticator.add",
      state: "consumed",
      revision: 2,
      expiresAt: "2026-08-04T00:05:00.000Z"
    },
    verified: true,
    replayed: false
  };
}

function stepUpVerifyResponse() {
  return {
    schemaVersion: 1,
    ceremony: {
      id: STEP_UP_CEREMONY_ID,
      kind: "authentication",
      purpose: "session.step_up",
      state: "consumed",
      revision: 2,
      expiresAt: "2026-08-04T00:05:00.000Z"
    },
    verified: true,
    replayed: false,
    stepUpAuthorization: {
      scheme: "Bearer",
      token: STEP_UP_TOKEN,
      purpose: "authenticator.add",
      expiresAt: "2026-08-04T00:10:00.000Z"
    }
  };
}

function allKeys(value: unknown): string[] {
  if (value === null || typeof value !== "object") return [];
  if (Array.isArray(value)) return value.flatMap(allKeys);
  return Object.entries(value as Record<string, unknown>)
    .flatMap(([key, item]) => [key, ...allKeys(item)]);
}

describe("passkey HTTP ceremony contract", () => {
  it("keeps begin commands strict, UUID-idempotent and operation bounded", () => {
    expect(BeginPasskeyRegistrationRequestSchema.parse({
      clientNonce: CLIENT_NONCE.toUpperCase(),
      stepUpCeremonyId: STEP_UP_CEREMONY_ID.toUpperCase()
    })).toEqual({ clientNonce: CLIENT_NONCE, stepUpCeremonyId: STEP_UP_CEREMONY_ID });
    expect(BeginPasskeyStepUpRequestSchema.parse({
      clientNonce: CLIENT_NONCE,
      operation: "authenticator.add"
    })).toEqual({ clientNonce: CLIENT_NONCE, operation: "authenticator.add" });
    expect(BeginPasskeyRegistrationRequestSchema.safeParse({
      clientNonce: CLIENT_NONCE,
      stepUpCeremonyId: STEP_UP_CEREMONY_ID,
      commandId: COMMAND_ID
    }).success).toBe(false);
    expect(BeginPasskeyRegistrationRequestSchema.safeParse({
      clientNonce: CLIENT_NONCE
    }).success).toBe(false);
    expect(BeginPasskeyStepUpRequestSchema.safeParse({
      clientNonce: CLIENT_NONCE,
      operation: "account.delete"
    }).success).toBe(false);
  });

  it("accepts only the exact bounded Step-Up-Authorization bearer transport", () => {
    expect(PASSKEY_STEP_UP_AUTHORIZATION_HEADER).toBe("Step-Up-Authorization");
    expect(PASSKEY_STEP_UP_AUTHORIZATION_SCHEME).toBe("Bearer");
    expect(PasskeyStepUpTokenSchema.parse(STEP_UP_TOKEN)).toBe(STEP_UP_TOKEN);
    expect(PasskeyStepUpAuthorizationHeaderSchema.parse(`Bearer ${STEP_UP_TOKEN}`))
      .toBe(STEP_UP_TOKEN);

    const maximumToken = `e30.e30.${"A".repeat(PASSKEY_STEP_UP_TOKEN_MAX_BYTES - 8)}`;
    expect(maximumToken).toHaveLength(PASSKEY_STEP_UP_TOKEN_MAX_BYTES);
    expect(PasskeyStepUpAuthorizationHeaderSchema.safeParse(`Bearer ${maximumToken}`).success)
      .toBe(true);

    for (const invalid of [
      `bearer ${STEP_UP_TOKEN}`,
      `BEARER ${STEP_UP_TOKEN}`,
      `Bearer  ${STEP_UP_TOKEN}`,
      `Bearer\t${STEP_UP_TOKEN}`,
      ` Bearer ${STEP_UP_TOKEN}`,
      `Bearer ${STEP_UP_TOKEN} `,
      `Bearer e30.e30.AA==`,
      `Bearer e30.e30.AB`,
      `Bearer e30.e30.AAAA.extra`,
      `Bearer e30.e30`,
      `Bearer e30..AAAA`,
      `Bearer e30.e30.${"A".repeat(PASSKEY_STEP_UP_TOKEN_MAX_BYTES - 7)}`
    ]) {
      expect(PasskeyStepUpAuthorizationHeaderSchema.safeParse(invalid).success).toBe(false);
    }
  });

  it("normalizes only the reviewed path/header transport contract", () => {
    expect(PasskeyCeremonyParamsSchema.parse({
      ceremonyId: CEREMONY_ID.toUpperCase()
    })).toEqual({ ceremonyId: CEREMONY_ID });
    expect(PasskeyCeremonyParamsSchema.safeParse({
      ceremonyId: CEREMONY_ID,
      accountId: COMMAND_ID
    }).success).toBe(false);
    expect(PasskeyIdempotencyKeySchema.parse(COMMAND_ID.toUpperCase())).toBe(COMMAND_ID);
    expect(PasskeyCeremonyRevisionETagSchema.parse('"0"')).toBe(0);
    expect(PasskeyCeremonyRevisionETagSchema.parse('"42"')).toBe(42);
    for (const invalid of ["0", "W/\"0\"", '"00"', '"9007199254740992"', "*"]) {
      expect(PasskeyCeremonyRevisionETagSchema.safeParse(invalid).success).toBe(false);
    }
    expect(PasskeyCredentialContentTypeSchema.parse(
      "Application/WebAuthn+JSON; charset=UTF-8"
    )).toBe("application/webauthn+json");
    expect(PasskeyCredentialContentTypeSchema.safeParse("application/json").success).toBe(false);
  });

  it("accepts every canonical 32-byte challenge tail and rejects unused-bit aliases", () => {
    for (const last of "AEIMQUYcgkosw048") {
      expect(PasskeyChallengeSchema.safeParse(`${"A".repeat(42)}${last}`).success).toBe(true);
    }
    expect(PasskeyChallengeSchema.safeParse(`${"A".repeat(42)}B`).success).toBe(false);
    expect(PasskeyBase64UrlSchema.safeParse("AA").success).toBe(true);
    expect(PasskeyBase64UrlSchema.safeParse("AB").success).toBe(false);
    expect(PasskeyBase64UrlSchema.safeParse("AAA").success).toBe(true);
    expect(PasskeyBase64UrlSchema.safeParse("AAB").success).toBe(false);
    expect(PasskeyBase64UrlSchema.safeParse("AA==").success).toBe(false);
  });

  it("matches the domain credential-ID bound at 1364 encoded / 1023 decoded bytes", () => {
    const maximum = "A".repeat(PASSKEY_MAX_CREDENTIAL_ID_BASE64URL_LENGTH);
    expect(PasskeyCredentialIdSchema.safeParse(maximum).success).toBe(true);
    expect(PasskeyCredentialIdSchema.safeParse(`${maximum}A`).success).toBe(false);
  });

  it("accepts strict maintained-verifier registration and discoverable-authentication JSON", () => {
    expect(PasskeyRegistrationCredentialJSONSchema.parse(registrationCredential()))
      .toEqual(registrationCredential());
    expect(PasskeyAuthenticationCredentialJSONSchema.parse(authenticationCredential()))
      .toEqual(authenticationCredential());
    expect(PasskeyCeremonyVerifyRequestSchema.safeParse(registrationCredential()).success).toBe(true);
    expect(PasskeyCeremonyVerifyRequestSchema.safeParse(authenticationCredential()).success).toBe(true);
  });

  it("rejects raw credential aliases, decorated fields and unsupported transport shapes", () => {
    expect(PasskeyRegistrationCredentialJSONSchema.safeParse({
      ...registrationCredential(),
      rawId: "AQIDBQ"
    }).success).toBe(false);
    expect(PasskeyRegistrationCredentialJSONSchema.safeParse({
      ...registrationCredential(),
      accountId: COMMAND_ID
    }).success).toBe(false);
    expect(PasskeyRegistrationCredentialJSONSchema.safeParse({
      ...registrationCredential(),
      response: { ...registrationCredential().response, challenge: CHALLENGE }
    }).success).toBe(false);
    expect(PasskeyRegistrationCredentialJSONSchema.safeParse({
      ...registrationCredential(),
      response: { ...registrationCredential().response, transports: ["internal", "internal"] }
    }).success).toBe(false);
    expect(PasskeyRegistrationCredentialJSONSchema.safeParse({
      ...registrationCredential(),
      response: { ...registrationCredential().response, transports: ["telepathy"] }
    }).success).toBe(false);
    const { userHandle: _userHandle, ...withoutUserHandle } = authenticationCredential().response;
    expect(PasskeyAuthenticationCredentialJSONSchema.safeParse({
      ...authenticationCredential(),
      response: withoutUserHandle
    }).success).toBe(false);
  });

  it("bounds every opaque field in addition to the exact 65536-byte raw-body gate", () => {
    expect(PASSKEY_MAX_CREDENTIAL_RESPONSE_BYTES).toBe(65_536);
    expect(PasskeyRegistrationCredentialJSONSchema.safeParse({
      ...registrationCredential(),
      response: {
        ...registrationCredential().response,
        clientDataJSON: "A".repeat(PASSKEY_MAX_CREDENTIAL_RESPONSE_BYTES + 1)
      }
    }).success).toBe(false);
  });

  it("preserves bounded registered extension data but rejects hostile extension trees", () => {
    expect(PasskeyClientExtensionResultsSchema.parse({
      futureExtension: {
        enabled: true,
        values: [1, "AQID", null]
      }
    })).toEqual({
      futureExtension: {
        enabled: true,
        values: [1, "AQID", null]
      }
    });
    expect(PasskeyClientExtensionResultsSchema.safeParse({
      first: { second: { third: { fourth: { fifth: true } } } }
    }).success).toBe(false);
    expect(PasskeyClientExtensionResultsSchema.safeParse({
      unicode: "💎".repeat(2_049)
    }).success).toBe(false);
    expect(PasskeyClientExtensionResultsSchema.safeParse(
      JSON.parse('{"__proto__":{"polluted":true}}') as unknown
    ).success).toBe(false);
    expect(PasskeyClientExtensionResultsSchema.safeParse({ constructor: true }).success).toBe(false);
    expect(PasskeyClientExtensionResultsSchema.safeParse({ invalid: () => true }).success).toBe(false);
    expect(PasskeyClientExtensionResultsSchema.safeParse(new Date()).success).toBe(false);
  });

  it("forces discoverable step-up options and never exposes a credential allowlist", () => {
    expect(PasskeyStepUpOptionsSchema.parse({
      challenge: CHALLENGE,
      rpId: "auth.luxora.app",
      timeout: 300_000,
      userVerification: "required",
      allowCredentials: []
    }).allowCredentials).toEqual([]);
    expect(PasskeyStepUpOptionsSchema.safeParse({
      challenge: CHALLENGE,
      rpId: "auth.luxora.app",
      timeout: 300_000,
      userVerification: "required",
      allowCredentials: [{ id: "AQIDBA", type: "public-key" }]
    }).success).toBe(false);
  });

  it("keeps success and generic error projections free of verifier and credential material", () => {
    const success = PasskeyCeremonyVerifyResponseSchema.parse({
      ...verifyResponse(),
      publicKey: "private-projection-canary",
      ceremony: {
        ...verifyResponse().ceremony,
        challenge: CHALLENGE,
        digest: "a".repeat(64),
        userHandle: USER_HANDLE,
        signCount: 41
      }
    });
    const error = PasskeyCeremonyErrorSchema.parse({
      error: {
        code: "CONFLICT",
        message: "Passkey ceremony conflict",
        requestId: "request-id",
        details: {
          reason: "ceremony_conflict",
          state: "pending",
          revision: 1,
          credentialId: "projection-canary",
          assertion: "projection-canary"
        },
        challenge: CHALLENGE
      }
    });
    const forbidden = new Set([
      "assertion",
      "attestationObject",
      "authenticatorData",
      "challenge",
      "credentialId",
      "digest",
      "publicKey",
      "rawId",
      "signCount",
      "signature",
      "userHandle"
    ]);
    expect(allKeys(success).filter((key) => forbidden.has(key))).toEqual([]);
    expect(allKeys(error).filter((key) => forbidden.has(key))).toEqual([]);
  });

  it("requires authorization on authentication success and strips it from registration success", () => {
    const stepUp = PasskeyStepUpVerifyResponseSchema.parse(stepUpVerifyResponse());
    expect(stepUp.stepUpAuthorization).toEqual(stepUpVerifyResponse().stepUpAuthorization);
    expect(PasskeyCeremonyVerifyResponseSchema.parse(stepUpVerifyResponse())).toEqual(stepUp);

    const { stepUpAuthorization: _missing, ...authenticationWithoutAuthorization } = stepUpVerifyResponse();
    expect(PasskeyStepUpVerifyResponseSchema.safeParse(authenticationWithoutAuthorization).success)
      .toBe(false);
    expect(PasskeyCeremonyVerifyResponseSchema.safeParse(authenticationWithoutAuthorization).success)
      .toBe(false);

    const registrationWithAuthorization = {
      ...verifyResponse(),
      stepUpAuthorization: stepUpVerifyResponse().stepUpAuthorization
    };
    const registration = PasskeyRegistrationVerifyResponseSchema.parse(registrationWithAuthorization);
    expect(registration).toEqual(verifyResponse());
    expect("stepUpAuthorization" in registration).toBe(false);
    const unionRegistration = PasskeyCeremonyVerifyResponseSchema.parse(registrationWithAuthorization);
    expect(unionRegistration.ceremony.kind).toBe("registration");
    expect("stepUpAuthorization" in unionRegistration).toBe(false);
  });

  it("rejects invalid step-up response scheme, token, purpose, and expiry", () => {
    const variants = [
      { scheme: "bearer" },
      { scheme: "Token" },
      { token: "e30.e30.AB" },
      { purpose: "account.delete" },
      { expiresAt: "2026-08-04T00:10:00" },
      { expiresAt: "not-a-timestamp" },
      { expiresAt: 1_800_000_000 }
    ];
    for (const override of variants) {
      expect(PasskeyStepUpVerifyResponseSchema.safeParse({
        ...stepUpVerifyResponse(),
        stepUpAuthorization: {
          ...stepUpVerifyResponse().stepUpAuthorization,
          ...override
        }
      }).success).toBe(false);
    }
  });

  it("uses the binding/service error vocabulary instead of protocol-only synonyms", () => {
    for (const reason of [
      "step_up_required",
      "assurance_insufficient",
      "challenge_expired",
      "ceremony_unavailable",
      "ceremony_conflict",
      "verification_failed",
      "temporarily_unavailable"
    ]) {
      expect(PasskeyCeremonyErrorSchema.safeParse({
        error: {
          code: "FORBIDDEN",
          message: "Passkey request failed",
          requestId: "request-id",
          details: { reason }
        }
      }).success).toBe(true);
    }

    for (const retiredReason of ["authorization_required", "ceremony_expired"]) {
      expect(PasskeyCeremonyErrorSchema.safeParse({
        error: {
          code: "FORBIDDEN",
          message: "Passkey request failed",
          requestId: "request-id",
          details: { reason: retiredReason }
        }
      }).success).toBe(false);
    }
  });

  it("represents raw-parser BAD_REQUEST and secret-free generic INTERNAL_ERROR boundaries", () => {
    for (const [code, message] of [
      ["BAD_REQUEST", "Invalid passkey request body"],
      ["INTERNAL_ERROR", "Internal server error"]
    ] as const) {
      expect(PasskeyCeremonyErrorSchema.parse({
        error: { code, message, requestId: "request-id" }
      })).toEqual({
        error: { code, message, requestId: "request-id" }
      });
    }
  });

  it("keeps the public capability disabled despite the contract foundation", () => {
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
});
