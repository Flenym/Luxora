import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  CapabilitiesResponseV1Schema,
  IA1ServerRealtimeMessageSchema,
  RealtimeCompatibilityDecisionSchema,
  RealtimeVersionPolicySchema,
  SendMessageRequestSchema,
  ServerRealtimeMessageSchema,
  createCapabilitiesResponseV1,
  negotiateRealtimeVersion
} from "./index.js";

function readFixture(relativePath: string): unknown {
  return JSON.parse(readFileSync(new URL(`../fixtures/${relativePath}`, import.meta.url), "utf8")) as unknown;
}

const RealtimeFixtureSchema = z.object({
  fixtureVersion: z.literal(1),
  role: z.enum(["current", "one_version_back"]),
  endpoint: z.enum(["/v1/realtime", "/v2/realtime"]),
  protocolVersion: z.union([z.literal(1), z.literal(2)]),
  messages: z.array(z.unknown()).min(1)
}).strict();

const RequiredUpgradeFixtureSchema = z.object({
  fixtureVersion: z.literal(1),
  scenario: z.literal("security_minimum_exceeds_one_version_back_client"),
  serverPolicy: RealtimeVersionPolicySchema,
  clientSupported: z.array(z.number().int().positive()).min(1),
  expected: RealtimeCompatibilityDecisionSchema
}).strict();

const defaultRuntimeState = {
  maxAttachmentBytes: 104_857_600,
  userStorageQuotaBytes: 1_073_741_824,
  uploadChunkSizeBytes: 1_048_576,
  uploadSessionTtlSeconds: 3_600,
  serverSearchConfigured: false,
  phoneAuthenticationAvailable: false
};

describe("versioned capability and realtime golden fixtures", () => {
  it("matches capability schema v1 and ignores unknown additive response fields", () => {
    const current = CapabilitiesResponseV1Schema.parse(
      readFixture("capabilities/v1/current.json")
    );
    const oneVersionBack = CapabilitiesResponseV1Schema.parse(
      readFixture("capabilities/v1/one-version-back-before-sync-invalidation.json")
    );
    expect(createCapabilitiesResponseV1(defaultRuntimeState)).toEqual(current);
    expect(oneVersionBack.features.syncInvalidation).toBe(false);
    expect({
      ...oneVersionBack,
      features: { ...oneVersionBack.features, syncInvalidation: true, drafts: true }
    }).toEqual(current);
    expect(oneVersionBack.features.drafts).toBe(false);

    const additive = readFixture("capabilities/v1/additive-response.json");
    expect(CapabilitiesResponseV1Schema.parse(additive)).toEqual(current);

    expect(createCapabilitiesResponseV1({
      ...defaultRuntimeState,
      serverSearchConfigured: true
    }).features.serverSearchConfigured).toBe(true);
    expect(createCapabilitiesResponseV1({
      ...defaultRuntimeState,
      phoneAuthenticationAvailable: true
    }).features.phoneAuthentication).toBe(true);
    expect(createCapabilitiesResponseV1(defaultRuntimeState, false)
      .features.syncInvalidation).toBe(false);
    expect(createCapabilitiesResponseV1(defaultRuntimeState)
      .features.syncInvalidation).toBe(true);
    expect(current.features.serverSearchConfigured).toBe(false);

    expect(SendMessageRequestSchema.safeParse({
      clientNonce: "9ec9347c-9306-4108-aab4-e7762b73b201",
      body: "Mutations remain strict",
      futureAdditiveMutationField: true
    }).success).toBe(false);
  });

  it("keeps current realtime v2 preferred and one-version-back v1 usable", () => {
    const currentCapabilities = CapabilitiesResponseV1Schema.parse(
      readFixture("capabilities/v1/current.json")
    );
    const policy = RealtimeVersionPolicySchema.parse(currentCapabilities.versions.realtime);
    expect(negotiateRealtimeVersion(policy, [2])).toEqual({
      status: "compatible",
      realtimeVersion: 2
    });
    expect(negotiateRealtimeVersion(policy, [1])).toEqual({
      status: "compatible",
      realtimeVersion: 1
    });

    const oneVersionBack = RealtimeFixtureSchema.parse(
      readFixture("realtime/v1/one-version-back.json")
    );
    expect(oneVersionBack).toMatchObject({
      role: "one_version_back",
      endpoint: "/v1/realtime",
      protocolVersion: 1
    });
    for (const message of oneVersionBack.messages) {
      expect(ServerRealtimeMessageSchema.safeParse(message).success).toBe(true);
      expect(IA1ServerRealtimeMessageSchema.safeParse(message).success).toBe(false);
    }

    const current = RealtimeFixtureSchema.parse(
      readFixture("realtime/v2/current.json")
    );
    expect(current).toMatchObject({
      role: "current",
      endpoint: "/v2/realtime",
      protocolVersion: 2
    });
    for (const message of current.messages) {
      expect(IA1ServerRealtimeMessageSchema.safeParse(message).success).toBe(true);
    }
  });

  it("requires upgrade when a security minimum excludes the old client and never downgrades", () => {
    const fixture = RequiredUpgradeFixtureSchema.parse(
      readFixture("compatibility/v1/security-required-upgrade.json")
    );
    const decision = negotiateRealtimeVersion(fixture.serverPolicy, fixture.clientSupported);
    expect(decision).toEqual(fixture.expected);
    expect(decision).toEqual({
      status: "required_upgrade",
      reason: "security_minimum_not_supported",
      minimumRealtimeVersion: 2,
      downgradeAllowed: false
    });
  });
});
