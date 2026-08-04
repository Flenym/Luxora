import Fastify, {
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest
} from "fastify";
import type {
  PasskeyAuthenticatorListResponse,
  PasskeyAuthenticatorMutationResponse,
  PasskeyAuthenticatorRevokeStepUpBeginResponse
} from "@luxora/protocol";
import { ZodError } from "zod";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { AuthenticatedPrincipal } from "../domain/types.js";
import { AppError, unauthenticated } from "../errors.js";
import {
  registerPasskeyAuthenticatorManagementRoutes,
  type PasskeyAuthenticatorCeremonyRouteService,
  type PasskeyAuthenticatorManagementRouteService
} from "./passkey-authenticator-management-routes.js";

const ACCOUNT_ID = "99999999-9999-4999-8999-999999999999";
const SESSION_ID = "88888888-8888-4888-8888-888888888888";
const AUTHENTICATOR_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_AUTHENTICATOR_ID = "22222222-2222-4222-8222-222222222222";
const CEREMONY_ID = "33333333-3333-4333-8333-333333333333";
const COMMAND_ID = "44444444-4444-4444-8444-444444444444";
const CLIENT_NONCE = "55555555-5555-4555-8555-555555555555";
const STEP_UP_TOKEN = "e30.e30.AAAA";
const TARGET_DIGEST = "a".repeat(64);

const PRINCIPAL: AuthenticatedPrincipal = Object.freeze({
  userId: ACCOUNT_ID,
  sessionId: SESSION_ID,
  tokenId: "66666666-6666-4666-8666-666666666666"
});

const ACTIVE_AUTHENTICATOR = Object.freeze({
  id: AUTHENTICATOR_ID,
  displayName: "Ключ от iPhone",
  state: "active" as const,
  revision: 1,
  etag: `"passkey-authenticator:${AUTHENTICATOR_ID}:rev:1"`,
  createdAt: "2026-08-04T00:00:00.000Z",
  updatedAt: "2026-08-04T00:00:00.000Z",
  revokedAt: null
});

const BEGIN_RESPONSE: PasskeyAuthenticatorRevokeStepUpBeginResponse = {
  schemaVersion: 1,
  ceremony: {
    id: CEREMONY_ID,
    kind: "authentication",
    purpose: "session.step_up",
    state: "pending",
    revision: 1,
    expiresAt: "2026-08-04T00:05:00.000Z"
  },
  replayed: false,
  operation: "authenticator.revoke",
  targetBinding: {
    accountId: ACCOUNT_ID,
    sessionId: SESSION_ID,
    credentialRecordId: AUTHENTICATOR_ID,
    expectedRevision: 1,
    targetDigest: TARGET_DIGEST
  },
  options: {
    challenge: "A".repeat(43),
    rpId: "auth.luxora.app",
    timeout: 300_000,
    userVerification: "required",
    allowCredentials: []
  }
};

const LIST_RESPONSE: PasskeyAuthenticatorListResponse = {
  schemaVersion: 1,
  authenticators: [ACTIVE_AUTHENTICATOR]
};

const RENAMED_RESPONSE: PasskeyAuthenticatorMutationResponse = {
  schemaVersion: 1,
  replayed: false,
  authenticator: {
    ...ACTIVE_AUTHENTICATOR,
    displayName: "Основной iPhone",
    revision: 2,
    etag: `"passkey-authenticator:${AUTHENTICATOR_ID}:rev:2"`,
    updatedAt: "2026-08-04T00:01:00.000Z"
  }
};

const REVOKED_RESPONSE: PasskeyAuthenticatorMutationResponse = {
  schemaVersion: 1,
  replayed: false,
  authenticator: {
    ...ACTIVE_AUTHENTICATOR,
    state: "revoked",
    revision: 2,
    etag: `"passkey-authenticator:${AUTHENTICATOR_ID}:rev:2"`,
    updatedAt: "2026-08-04T00:02:00.000Z",
    revokedAt: "2026-08-04T00:02:00.000Z"
  }
};

interface Harness {
  readonly app: FastifyInstance;
  readonly begin: ReturnType<typeof vi.fn<PasskeyAuthenticatorCeremonyRouteService["beginAuthenticatorRevokeStepUp"]>>;
  readonly list: ReturnType<typeof vi.fn<PasskeyAuthenticatorManagementRouteService["list"]>>;
  readonly rename: ReturnType<typeof vi.fn<PasskeyAuthenticatorManagementRouteService["rename"]>>;
  readonly revoke: ReturnType<typeof vi.fn<PasskeyAuthenticatorManagementRouteService["revoke"]>>;
}

const openApps: FastifyInstance[] = [];

afterEach(async () => {
  await Promise.all(openApps.splice(0).map(async (app) => app.close()));
});

function installErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler(async (error, request, reply) => {
    if (error instanceof ZodError) {
      return reply.code(500).send({
        error: { code: "INTERNAL_ERROR", message: "Invalid response", requestId: request.id }
      });
    }
    if (error instanceof AppError) {
      return reply.code(error.statusCode).send({
        error: { code: error.code, message: error.message, requestId: request.id }
      });
    }
    return reply.code(500).send({
      error: { code: "INTERNAL_ERROR", message: "Unexpected error", requestId: request.id }
    });
  });
}

function createHarness(): Harness {
  const app = Fastify({ logger: false });
  openApps.push(app);
  installErrorHandler(app);
  const begin = vi.fn<PasskeyAuthenticatorCeremonyRouteService["beginAuthenticatorRevokeStepUp"]>()
    .mockResolvedValue(BEGIN_RESPONSE);
  const list = vi.fn<PasskeyAuthenticatorManagementRouteService["list"]>()
    .mockResolvedValue(LIST_RESPONSE);
  const rename = vi.fn<PasskeyAuthenticatorManagementRouteService["rename"]>()
    .mockResolvedValue(RENAMED_RESPONSE);
  const revoke = vi.fn<PasskeyAuthenticatorManagementRouteService["revoke"]>()
    .mockResolvedValue(REVOKED_RESPONSE);
  const authGuard = vi.fn(async (request: FastifyRequest, _reply: FastifyReply) => {
    if (request.headers.authorization !== "Bearer access-token") {
      throw unauthenticated("Authentication required");
    }
    request.auth = PRINCIPAL;
  });
  registerPasskeyAuthenticatorManagementRoutes(app, {
    ceremonies: { beginAuthenticatorRevokeStepUp: begin },
    management: { list, rename, revoke },
    authGuard
  });
  return { app, begin, list, rename, revoke };
}

describe("passkey authenticator management HTTP routes", () => {
  it("maps the complete target-bound lifecycle without exposing secrets", async () => {
    const harness = createHarness();
    const authorization = { authorization: "Bearer access-token" };
    const begun = await harness.app.inject({
      method: "POST",
      url: "/v1/auth/passkey-ceremonies/authenticator-revocation",
      headers: { ...authorization, "idempotency-key": COMMAND_ID },
      payload: {
        clientNonce: CLIENT_NONCE,
        credentialRecordId: AUTHENTICATOR_ID,
        expectedRevision: 1
      }
    });
    expect(begun.statusCode, begun.body).toBe(200);
    expect(begun.headers.etag).toBe('"1"');
    expect(begun.headers["cache-control"]).toBe("private, no-store");
    expect(harness.begin).toHaveBeenCalledWith(PRINCIPAL, {
      commandId: COMMAND_ID,
      clientNonce: CLIENT_NONCE,
      credentialRecordId: AUTHENTICATOR_ID,
      expectedRevision: 1
    });

    const listed = await harness.app.inject({
      method: "GET",
      url: "/v1/auth/authenticators",
      headers: authorization
    });
    expect(listed.statusCode, listed.body).toBe(200);
    expect(listed.json()).toEqual(LIST_RESPONSE);
    expect(listed.body).not.toMatch(/credentialId|publicKey|userHandle|signCount/u);

    const renamed = await harness.app.inject({
      method: "PATCH",
      url: `/v1/auth/authenticators/${AUTHENTICATOR_ID}`,
      headers: {
        ...authorization,
        "idempotency-key": COMMAND_ID,
        "if-match": ACTIVE_AUTHENTICATOR.etag
      },
      payload: { displayName: "Основной iPhone" }
    });
    expect(renamed.statusCode, renamed.body).toBe(200);
    expect(renamed.headers.etag).toBe(RENAMED_RESPONSE.authenticator.etag);
    expect(harness.rename).toHaveBeenCalledWith(PRINCIPAL, {
      commandId: COMMAND_ID,
      credentialRecordId: AUTHENTICATOR_ID,
      displayName: "Основной iPhone",
      expectedRevision: 1
    });

    const revoked = await harness.app.inject({
      method: "DELETE",
      url: `/v1/auth/authenticators/${AUTHENTICATOR_ID}`,
      headers: {
        ...authorization,
        "idempotency-key": COMMAND_ID,
        "if-match": ACTIVE_AUTHENTICATOR.etag,
        "step-up-authorization": `Bearer ${STEP_UP_TOKEN}`
      },
      payload: { authenticationCeremonyId: CEREMONY_ID }
    });
    expect(revoked.statusCode, revoked.body).toBe(200);
    expect(revoked.headers.etag).toBe(REVOKED_RESPONSE.authenticator.etag);
    expect(harness.revoke).toHaveBeenCalledWith(PRINCIPAL, {
      authenticationCeremonyId: CEREMONY_ID,
      commandId: COMMAND_ID,
      credentialRecordId: AUTHENTICATOR_ID,
      expectedRevision: 1,
      stepUpToken: STEP_UP_TOKEN
    });
  });

  it("rejects unauthenticated, non-canonical and target-substituted requests before services", async () => {
    const harness = createHarness();
    expect((await harness.app.inject({
      method: "GET",
      url: "/v1/auth/authenticators"
    })).statusCode).toBe(401);

    const extraField = await harness.app.inject({
      method: "POST",
      url: "/v1/auth/passkey-ceremonies/authenticator-revocation",
      headers: {
        authorization: "Bearer access-token",
        "idempotency-key": COMMAND_ID
      },
      payload: {
        clientNonce: CLIENT_NONCE,
        credentialRecordId: AUTHENTICATOR_ID,
        expectedRevision: 1,
        accountId: ACCOUNT_ID
      }
    });
    expect(extraField.statusCode).toBe(400);

    const substitutedEtag = await harness.app.inject({
      method: "PATCH",
      url: `/v1/auth/authenticators/${AUTHENTICATOR_ID}`,
      headers: {
        authorization: "Bearer access-token",
        "idempotency-key": COMMAND_ID,
        "if-match": `"passkey-authenticator:${OTHER_AUTHENTICATOR_ID}:rev:1"`
      },
      payload: { displayName: "Новый ключ" }
    });
    expect(substitutedEtag.statusCode).toBe(400);
    expect(harness.begin).not.toHaveBeenCalled();
    expect(harness.rename).not.toHaveBeenCalled();
    expect(harness.revoke).not.toHaveBeenCalled();
  });

  it("turns malformed trusted service output into a secret-free server error", async () => {
    const harness = createHarness();
    harness.list.mockResolvedValueOnce({
      schemaVersion: 1,
      authenticators: [{ ...ACTIVE_AUTHENTICATOR, credentialId: "secret-canary" }]
    } as unknown as PasskeyAuthenticatorListResponse);
    const response = await harness.app.inject({
      method: "GET",
      url: "/v1/auth/authenticators",
      headers: { authorization: "Bearer access-token" }
    });
    expect(response.statusCode).toBe(500);
    expect(response.body).not.toContain("secret-canary");
    expect(response.headers["cache-control"]).toBe("private, no-store");
  });

  it("refuses duplicate registration on one Fastify instance", () => {
    const harness = createHarness();
    expect(() => registerPasskeyAuthenticatorManagementRoutes(harness.app, {
      ceremonies: { beginAuthenticatorRevokeStepUp: harness.begin },
      management: {
        list: harness.list,
        rename: harness.rename,
        revoke: harness.revoke
      },
      authGuard: async () => undefined
    })).toThrow("already registered");
  });
});
