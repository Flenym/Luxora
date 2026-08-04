import { describe, expect, it } from "vitest";

import {
  BeginPasskeyAuthenticatorRevokeStepUpRequestSchema,
  PasskeyAuthenticatorParamsSchema,
  PasskeyAuthenticatorListResponseSchema,
  PasskeyAuthenticatorMutationResponseSchema,
  PasskeyAuthenticatorPublicSchema,
  PasskeyAuthenticatorRenameRequestSchema,
  PasskeyAuthenticatorRevokeRequestSchema,
  PasskeyAuthenticatorRevokeStepUpBeginResponseSchema,
  PasskeyAuthenticatorRevokeStepUpVerifyResponseSchema
} from "./index.js";

const AUTHENTICATOR_ID = "11111111-1111-4111-8111-111111111111";
const CREATED_AT = "2026-08-04T10:00:00.000Z";
const UPDATED_AT = "2026-08-04T10:01:00.000Z";

function authenticator(overrides: Record<string, unknown> = {}) {
  return {
    id: AUTHENTICATOR_ID,
    displayName: "Ключ от телефона Егора",
    state: "active",
    revision: 2,
    etag: `"passkey-authenticator:${AUTHENTICATOR_ID}:rev:2"`,
    createdAt: CREATED_AT,
    updatedAt: UPDATED_AT,
    revokedAt: null,
    ...overrides
  };
}

describe("passkey authenticator management projection", () => {
  it("accepts Russian-capable names without credential verification material", () => {
    const parsed = PasskeyAuthenticatorListResponseSchema.parse({
      schemaVersion: 1,
      authenticators: [authenticator()]
    });
    expect(parsed.authenticators[0]?.displayName).toBe("Ключ от телефона Егора");
    expect(JSON.stringify(parsed)).not.toMatch(/credentialId|publicKey|userHandle|signCount/u);
    expect(PasskeyAuthenticatorPublicSchema.safeParse(authenticator({
      displayName: "Семейный ключ 👨‍👩‍👧‍👦"
    })).success).toBe(true);
    for (const bidiControl of ["\u202e", "\u2067", "\u200f"]) {
      expect(PasskeyAuthenticatorPublicSchema.safeParse(authenticator({
        displayName: `Ключ${bidiControl}admin`
      })).success).toBe(false);
    }
  });

  it("binds the strong ETag to the exact resource and revision", () => {
    expect(PasskeyAuthenticatorPublicSchema.safeParse(authenticator({
      etag: `"passkey-authenticator:${AUTHENTICATOR_ID}:rev:3"`
    })).success).toBe(false);
    expect(PasskeyAuthenticatorPublicSchema.safeParse(authenticator({
      etag: "\"passkey-authenticator:22222222-2222-4222-8222-222222222222:rev:2\""
    })).success).toBe(false);
  });

  it("enforces lifecycle timestamps and monotonic resource time", () => {
    expect(PasskeyAuthenticatorPublicSchema.safeParse(authenticator({
      state: "active",
      revokedAt: UPDATED_AT
    })).success).toBe(false);
    expect(PasskeyAuthenticatorPublicSchema.safeParse(authenticator({
      state: "revoked",
      revokedAt: CREATED_AT
    })).success).toBe(false);
    expect(PasskeyAuthenticatorPublicSchema.safeParse(authenticator({
      createdAt: UPDATED_AT,
      updatedAt: CREATED_AT
    })).success).toBe(false);
    expect(PasskeyAuthenticatorPublicSchema.safeParse(authenticator({
      state: "revoked",
      revokedAt: UPDATED_AT
    })).success).toBe(true);
    expect(PasskeyAuthenticatorPublicSchema.safeParse(authenticator({
      createdAt: "2026-08-04T12:00:00.000+02:00",
      updatedAt: "2026-08-04T10:01:00.000Z"
    })).success).toBe(true);
    expect(PasskeyAuthenticatorPublicSchema.safeParse(authenticator({
      createdAt: "2026-08-04T09:30:00.000-01:00",
      updatedAt: "2026-08-04T10:01:00.000Z"
    })).success).toBe(false);
    expect(PasskeyAuthenticatorPublicSchema.safeParse(authenticator({
      state: "revoked",
      updatedAt: "2026-08-04T10:01:00.000Z",
      revokedAt: "2026-08-04T12:01:00.000+02:00"
    })).success).toBe(true);
  });

  it("rejects secret-bearing additive fields from trusted service responses", () => {
    for (const forbidden of ["credentialId", "publicKey", "userHandle", "signCount"]) {
      expect(PasskeyAuthenticatorMutationResponseSchema.safeParse({
        schemaVersion: 1,
        authenticator: authenticator({ [forbidden]: "canary" }),
        replayed: false
      }).success).toBe(false);
    }
  });

  it("keeps the routed revoke ceremony and management inputs strict and target-bound", () => {
    const clientNonce = "22222222-2222-4222-8222-222222222222";
    const ceremonyId = "33333333-3333-4333-8333-333333333333";
    const request = {
      clientNonce,
      credentialRecordId: AUTHENTICATOR_ID,
      expectedRevision: 2
    };
    expect(BeginPasskeyAuthenticatorRevokeStepUpRequestSchema.parse(request)).toEqual(request);
    expect(BeginPasskeyAuthenticatorRevokeStepUpRequestSchema.safeParse({
      ...request,
      expectedRevision: 0
    }).success).toBe(false);
    expect(BeginPasskeyAuthenticatorRevokeStepUpRequestSchema.safeParse({
      ...request,
      accountId: "99999999-9999-4999-8999-999999999999"
    }).success).toBe(false);
    expect(PasskeyAuthenticatorParamsSchema.safeParse({
      authenticatorId: AUTHENTICATOR_ID,
      userId: "99999999-9999-4999-8999-999999999999"
    }).success).toBe(false);
    expect(PasskeyAuthenticatorRenameRequestSchema.safeParse({
      displayName: " Новый ключ "
    }).success).toBe(false);
    expect(PasskeyAuthenticatorRevokeRequestSchema.safeParse({
      authenticationCeremonyId: ceremonyId
    }).success).toBe(true);

    const begin = PasskeyAuthenticatorRevokeStepUpBeginResponseSchema.parse({
      schemaVersion: 1,
      ceremony: {
        id: ceremonyId,
        kind: "authentication",
        purpose: "session.step_up",
        state: "pending",
        revision: 1,
        expiresAt: "2026-08-04T10:05:00.000Z"
      },
      replayed: false,
      operation: "authenticator.revoke",
      targetBinding: {
        accountId: "99999999-9999-4999-8999-999999999999",
        sessionId: "88888888-8888-4888-8888-888888888888",
        credentialRecordId: AUTHENTICATOR_ID,
        expectedRevision: 2,
        targetDigest: "a".repeat(64)
      },
      options: {
        challenge: "A".repeat(43),
        rpId: "auth.luxora.app",
        timeout: 300_000,
        userVerification: "required",
        allowCredentials: []
      }
    });
    expect(begin.targetBinding.credentialRecordId).toBe(AUTHENTICATOR_ID);
    expect(PasskeyAuthenticatorRevokeStepUpVerifyResponseSchema.safeParse({
      schemaVersion: 1,
      ceremony: { ...begin.ceremony, state: "consumed", revision: 2 },
      verified: true,
      replayed: false,
      stepUpAuthorization: {
        scheme: "Bearer",
        token: "e30.e30.AAAA",
        purpose: "authenticator.add",
        expiresAt: "2026-08-04T10:05:00.000Z"
      }
    }).success).toBe(false);
  });
});
