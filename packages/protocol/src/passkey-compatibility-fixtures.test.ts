import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  BeginPasskeyRegistrationRequestSchema,
  BeginPasskeyStepUpRequestSchema,
  PASSKEY_HTTP_CONTRACT_VERSION,
  PasskeyAuthenticationCredentialJSONSchema,
  PasskeyCeremonyRevisionETagSchema,
  PasskeyCeremonyVerifyResponseSchema,
  PasskeyCredentialContentTypeSchema,
  PasskeyIdempotencyKeySchema,
  PasskeyRegistrationBeginResponseSchema,
  PasskeyRegistrationCredentialJSONSchema,
  PasskeyStepUpAuthorizationHeaderSchema,
  PasskeyStepUpBeginResponseSchema,
  PasskeyStepUpVerifyResponseSchema
} from "./index.js";

function readFixture(name: string): unknown {
  return JSON.parse(
    readFileSync(new URL(`../fixtures/passkeys/v1/${name}.json`, import.meta.url), "utf8")
  ) as unknown;
}

const BeginRouteFixtureSchema = z.object({
  method: z.literal("POST"),
  path: z.string(),
  idempotencyKey: z.string(),
  request: z.unknown(),
  response: z.unknown()
}).strict();

const VerifyRouteFixtureSchema = BeginRouteFixtureSchema.extend({
  ifMatch: z.string(),
  contentType: z.string()
}).strict();

const CurrentFixtureSchema = z.object({
  fixtureVersion: z.literal(1),
  role: z.literal("current"),
  contractVersion: z.literal(PASSKEY_HTTP_CONTRACT_VERSION),
  routes: z.object({
    registrationBegin: BeginRouteFixtureSchema.extend({
      path: z.literal("/v1/auth/passkey-ceremonies/registration"),
      stepUpAuthorization: z.string()
    }).strict(),
    stepUpBegin: BeginRouteFixtureSchema.extend({
      path: z.literal("/v1/auth/passkey-ceremonies/authentication")
    }).strict(),
    registrationVerify: VerifyRouteFixtureSchema,
    stepUpVerify: VerifyRouteFixtureSchema
  }).strict()
}).strict();

const CompatibilityFixtureSchema = z.object({
  fixtureVersion: z.literal(1),
  role: z.enum(["one_version_back", "additive_response"]),
  contractVersion: z.literal(PASSKEY_HTTP_CONTRACT_VERSION),
  endpoint: z.literal("/v1/auth/passkey-ceremonies/registration"),
  response: z.unknown()
}).strict();

describe("passkey HTTP compatibility fixtures", () => {
  it("validates the exact current endpoint/request/response matrix", () => {
    const fixture = CurrentFixtureSchema.parse(readFixture("current"));
    const { registrationBegin, stepUpBegin, registrationVerify, stepUpVerify } = fixture.routes;

    expect(PasskeyIdempotencyKeySchema.safeParse(registrationBegin.idempotencyKey).success).toBe(true);
    // The fixture uses a minimal canonical compact value, not a signed credential.
    // Signature semantics belong to the service tests; this suite covers transport compatibility.
    const registrationAuthorization = PasskeyStepUpAuthorizationHeaderSchema.parse(
      registrationBegin.stepUpAuthorization
    );
    expect(BeginPasskeyRegistrationRequestSchema.parse(registrationBegin.request)).toEqual(
      registrationBegin.request
    );
    const registration = PasskeyRegistrationBeginResponseSchema.parse(registrationBegin.response);
    expect(registration.ceremony.revision).toBe(1);
    expect(registration.options.excludeCredentials).toHaveLength(1);

    expect(PasskeyIdempotencyKeySchema.safeParse(stepUpBegin.idempotencyKey).success).toBe(true);
    expect(BeginPasskeyStepUpRequestSchema.parse(stepUpBegin.request)).toEqual(stepUpBegin.request);
    const stepUp = PasskeyStepUpBeginResponseSchema.parse(stepUpBegin.response);
    expect(stepUp).toEqual(stepUpBegin.response);
    expect(stepUp.ceremony.revision).toBe(1);

    expect(registrationVerify.path).toBe(
      `/v1/auth/passkey-ceremonies/${registration.ceremony.id}/verify`
    );
    expect(PasskeyIdempotencyKeySchema.safeParse(registrationVerify.idempotencyKey).success).toBe(true);
    expect(PasskeyCeremonyRevisionETagSchema.parse(registrationVerify.ifMatch))
      .toBe(registration.ceremony.revision);
    expect(PasskeyCredentialContentTypeSchema.parse(registrationVerify.contentType))
      .toBe("application/webauthn+json");
    expect(PasskeyRegistrationCredentialJSONSchema.parse(registrationVerify.request))
      .toEqual(registrationVerify.request);
    const registrationVerified = PasskeyCeremonyVerifyResponseSchema.parse(
      registrationVerify.response
    );
    expect(registrationVerified).toEqual(registrationVerify.response);
    expect(registrationVerified.ceremony.revision)
      .toBe(registration.ceremony.revision + 1);

    expect(stepUpVerify.path).toBe(
      `/v1/auth/passkey-ceremonies/${stepUp.ceremony.id}/verify`
    );
    expect(PasskeyIdempotencyKeySchema.safeParse(stepUpVerify.idempotencyKey).success).toBe(true);
    expect(PasskeyCeremonyRevisionETagSchema.parse(stepUpVerify.ifMatch))
      .toBe(stepUp.ceremony.revision);
    expect(PasskeyCredentialContentTypeSchema.parse(stepUpVerify.contentType))
      .toBe("application/webauthn+json");
    expect(PasskeyAuthenticationCredentialJSONSchema.parse(stepUpVerify.request))
      .toEqual(stepUpVerify.request);
    const stepUpVerified = PasskeyCeremonyVerifyResponseSchema.parse(stepUpVerify.response);
    expect(stepUpVerified).toEqual(stepUpVerify.response);
    expect(stepUpVerified.ceremony.revision).toBe(stepUp.ceremony.revision + 1);
    expect("stepUpAuthorization" in stepUpVerified).toBe(true);
    if ("stepUpAuthorization" in stepUpVerified) {
      expect(stepUpVerified.stepUpAuthorization.token).toBe(registrationAuthorization);
    }
  });

  it("accepts the one-generation-back v1 response and an empty exclusion list", () => {
    const fixture = CompatibilityFixtureSchema.parse(readFixture("one-version-back"));
    const parsed = PasskeyRegistrationBeginResponseSchema.parse(fixture.response);
    expect(parsed.ceremony.revision).toBe(1);
    expect(parsed.replayed).toBeUndefined();
    expect(parsed.options.excludeCredentials).toEqual([]);
  });

  it("lets an older response reader ignore current and future additive fields", () => {
    const current = CurrentFixtureSchema.parse(readFixture("current"));
    const additive = CompatibilityFixtureSchema.parse(readFixture("additive-response"));
    const currentResponse = PasskeyRegistrationBeginResponseSchema.parse(
      current.routes.registrationBegin.response
    );
    const additiveResponse = PasskeyRegistrationBeginResponseSchema.parse(additive.response);
    expect(additiveResponse).toEqual(currentResponse);
    expect(additiveResponse.ceremony.revision).toBe(1);

    const OneGenerationBackReaderSchema = PasskeyRegistrationBeginResponseSchema.omit({
      replayed: true
    });
    const { replayed: _replayed, ...expectedOlderProjection } = currentResponse;
    expect(OneGenerationBackReaderSchema.parse(current.routes.registrationBegin.response))
      .toEqual(expectedOlderProjection);
    expect(OneGenerationBackReaderSchema.parse(additive.response)).toEqual(expectedOlderProjection);

    const stepUpResponse = CurrentFixtureSchema.parse(readFixture("current")).routes.stepUpVerify.response;
    const currentStepUp = PasskeyStepUpVerifyResponseSchema.parse(stepUpResponse);
    expect(PasskeyStepUpVerifyResponseSchema.parse({
      ...(stepUpResponse as Record<string, unknown>),
      futureEnvelope: true,
      ceremony: {
        ...(currentStepUp.ceremony as Record<string, unknown>),
        futureCeremonyHint: "ignored"
      },
      stepUpAuthorization: {
        ...currentStepUp.stepUpAuthorization,
        futureGrantHint: "ignored"
      }
    })).toEqual(currentStepUp);
  });
});
