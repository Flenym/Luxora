import { createHash } from "node:crypto";

import Fastify, { type FastifyInstance } from "fastify";
import {
  PASSKEY_INTERNAL_LOGIN_OPTIONS_PATH,
  PASSKEY_INTERNAL_LOGIN_VERIFY_PATH,
  type PasskeyLoginBeginResponse,
  type PasskeyLoginVerifyResponse
} from "@luxora/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AppError } from "../errors.js";
import {
  registerPasskeyLoginRoutes,
  type PasskeyLoginRouteService
} from "./passkey-login-routes.js";

const INTENT_ID = "11111111-1111-4111-8111-111111111111";
const COMMAND_ID = "22222222-2222-4222-8222-222222222222";
const CLIENT_NONCE = "33333333-3333-4333-8333-333333333333";
const USER_ID = "44444444-4444-4444-8444-444444444444";
const SESSION_ID = "55555555-5555-4555-8555-555555555555";
const DELIVERY_NONCE = "E".repeat(43);
const BOOTSTRAP_TOKEN = "e30.e30.AAAA";
const EXPIRES_AT = "2026-08-04T10:05:00.000Z";

const BEGIN_RESPONSE: PasskeyLoginBeginResponse = {
  schemaVersion: 1,
  replayed: false,
  ceremony: {
    id: INTENT_ID,
    kind: "authentication",
    purpose: "session.create",
    state: "pending",
    revision: 1,
    expiresAt: EXPIRES_AT
  },
  bootstrapAuthorization: {
    scheme: "Bearer",
    token: BOOTSTRAP_TOKEN,
    purpose: "session.create",
    expiresAt: EXPIRES_AT
  },
  options: {
    challenge: "A".repeat(43),
    rpId: "auth.luxora.app",
    timeout: 300_000,
    userVerification: "required"
  }
};

const VERIFY_RESPONSE: PasskeyLoginVerifyResponse = {
  schemaVersion: 1,
  verified: true,
  replayed: false,
  ceremony: {
    id: INTENT_ID,
    kind: "authentication",
    purpose: "session.create",
    state: "consumed",
    revision: 2,
    expiresAt: EXPIRES_AT
  },
  user: {
    id: USER_ID,
    username: "alice",
    displayName: "Alice",
    bio: "",
    avatarUrl: null,
    createdAt: "2026-08-04T09:00:00.000Z"
  },
  tokens: {
    accessToken: "access-token",
    refreshToken: "r".repeat(40),
    tokenType: "Bearer",
    expiresIn: 900,
    sessionId: SESSION_ID
  }
};

function authenticationCredential() {
  return {
    id: "AQIDBA",
    rawId: "AQIDBA",
    response: {
      clientDataJSON: "e30",
      authenticatorData: "AQID",
      signature: "AQID",
      userHandle: "A".repeat(43)
    },
    authenticatorAttachment: "platform",
    clientExtensionResults: {},
    type: "public-key"
  };
}

interface Harness {
  app: FastifyInstance;
  begin: ReturnType<typeof vi.fn<PasskeyLoginRouteService["begin"]>>;
  verify: ReturnType<typeof vi.fn<PasskeyLoginRouteService["verify"]>>;
}

const openApps: FastifyInstance[] = [];

afterEach(async () => {
  await Promise.all(openApps.splice(0).map(async (app) => app.close()));
});

async function harness(): Promise<Harness> {
  const app = Fastify({ logger: false });
  openApps.push(app);
  app.addHook("onRequest", async (request) => {
    const duplicateName = request.headers["x-test-duplicate-header"];
    if (typeof duplicateName !== "string") return;
    const value = request.headers[duplicateName.toLowerCase()];
    if (typeof value === "string") request.raw.rawHeaders.push(duplicateName, value);
  });
  app.setErrorHandler(async (error, request, reply) => {
    if (error instanceof AppError) {
      return reply.code(error.statusCode).send({
        error: { code: error.code, message: error.message, requestId: request.id }
      });
    }
    const status = typeof error === "object"
      && error !== null
      && "statusCode" in error
      && typeof error.statusCode === "number"
      ? error.statusCode
      : 500;
    return reply.code(status).send({
      error: { code: status === 500 ? "INTERNAL_ERROR" : "BAD_REQUEST", requestId: request.id }
    });
  });
  const begin = vi.fn<PasskeyLoginRouteService["begin"]>(async () => BEGIN_RESPONSE);
  const verify = vi.fn<PasskeyLoginRouteService["verify"]>(async () => VERIFY_RESPONSE);
  registerPasskeyLoginRoutes(app, { service: { begin, verify } });
  await app.ready();
  return { app, begin, verify };
}

describe("primary passkey login HTTP routes", () => {
  it("forwards a strict identifier-free begin and emits a non-cacheable revision", async () => {
    const fixture = await harness();
    const response = await fixture.app.inject({
      method: "POST",
      url: PASSKEY_INTERNAL_LOGIN_OPTIONS_PATH,
      headers: { "idempotency-key": COMMAND_ID.toUpperCase() },
      payload: { clientNonce: CLIENT_NONCE.toUpperCase(), deliveryNonce: DELIVERY_NONCE }
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.headers["pragma"]).toBe("no-cache");
    expect(response.headers.etag).toBe('"1"');
    expect(fixture.begin).toHaveBeenCalledWith({
      commandId: COMMAND_ID,
      clientNonce: CLIENT_NONCE,
      deliveryNonce: DELIVERY_NONCE
    });
  });

  it("keeps the assertion raw-body digest separate from bootstrap and revision headers", async () => {
    const fixture = await harness();
    const raw = JSON.stringify(authenticationCredential());
    const response = await fixture.app.inject({
      method: "POST",
      url: PASSKEY_INTERNAL_LOGIN_VERIFY_PATH,
      headers: {
        "content-type": "application/webauthn+json",
        "idempotency-key": COMMAND_ID,
        "if-match": '"1"',
        "bootstrap-authorization": `Bearer ${BOOTSTRAP_TOKEN}`
      },
      payload: raw
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.headers.etag).toBe('"2"');
    expect(fixture.verify).toHaveBeenCalledOnce();
    expect(fixture.verify.mock.calls[0]?.[0]).toEqual({
      commandId: COMMAND_ID,
      expectedRevision: 1,
      bootstrapToken: BOOTSTRAP_TOKEN,
      response: {
        credential: authenticationCredential(),
        byteLength: Buffer.byteLength(raw),
        digest: createHash("sha256").update(raw).digest("hex")
      }
    });
  });

  it("rejects missing, duplicated, or misplaced bearer metadata before the service", async () => {
    const fixture = await harness();
    const raw = JSON.stringify(authenticationCredential());
    const baseHeaders = {
      "content-type": "application/webauthn+json",
      "idempotency-key": COMMAND_ID,
      "if-match": '"1"',
      "bootstrap-authorization": `Bearer ${BOOTSTRAP_TOKEN}`
    };
    const {
      "bootstrap-authorization": _omittedBootstrapAuthorization,
      ...headersWithoutBootstrapAuthorization
    } = baseHeaders;
    const missing = await fixture.app.inject({
      method: "POST",
      url: PASSKEY_INTERNAL_LOGIN_VERIFY_PATH,
      headers: headersWithoutBootstrapAuthorization,
      payload: raw
    });
    const duplicate = await fixture.app.inject({
      method: "POST",
      url: PASSKEY_INTERNAL_LOGIN_VERIFY_PATH,
      headers: {
        ...baseHeaders,
        "x-test-duplicate-header": "Bootstrap-Authorization"
      },
      payload: raw
    });
    const decoratedBody = await fixture.app.inject({
      method: "POST",
      url: PASSKEY_INTERNAL_LOGIN_VERIFY_PATH,
      headers: baseHeaders,
      payload: JSON.stringify({ ...authenticationCredential(), deliveryNonce: DELIVERY_NONCE })
    });

    expect([missing.statusCode, duplicate.statusCode, decoratedBody.statusCode])
      .toEqual([400, 400, 400]);
    expect(fixture.verify).not.toHaveBeenCalled();
  });

  it("rejects every query string before either identifier-free service command", async () => {
    const fixture = await harness();
    const beginQueries = [
      "?username=alice",
      `?accountId=${USER_ID}`,
      `?bootstrapAuthorization=${encodeURIComponent(BOOTSTRAP_TOKEN)}`
    ];
    for (const query of beginQueries) {
      const response = await fixture.app.inject({
        method: "POST",
        url: `${PASSKEY_INTERNAL_LOGIN_OPTIONS_PATH}${query}`,
        headers: { "idempotency-key": COMMAND_ID },
        payload: { clientNonce: CLIENT_NONCE, deliveryNonce: DELIVERY_NONCE }
      });
      expect(response.statusCode).toBe(400);
      expect(response.headers["cache-control"]).toBe("no-store");
    }

    const raw = JSON.stringify(authenticationCredential());
    const verify = await fixture.app.inject({
      method: "POST",
      url: `${PASSKEY_INTERNAL_LOGIN_VERIFY_PATH}?token=${encodeURIComponent(BOOTSTRAP_TOKEN)}`,
      headers: {
        "content-type": "application/webauthn+json",
        "idempotency-key": COMMAND_ID,
        "if-match": '"1"',
        "bootstrap-authorization": `Bearer ${BOOTSTRAP_TOKEN}`
      },
      payload: raw
    });
    expect(verify.statusCode).toBe(400);
    expect(verify.headers["cache-control"]).toBe("no-store");
    expect(fixture.begin).not.toHaveBeenCalled();
    expect(fixture.verify).not.toHaveBeenCalled();
  });

  it("emits the authoritative revision ETag for a token-bound CAS conflict", async () => {
    const fixture = await harness();
    fixture.verify.mockRejectedValueOnce(new AppError(
      409,
      "CONFLICT",
      "Passkey login revision does not match",
      { reason: "ceremony_conflict", state: "consumed", revision: 2 }
    ));
    const response = await fixture.app.inject({
      method: "POST",
      url: PASSKEY_INTERNAL_LOGIN_VERIFY_PATH,
      headers: {
        "content-type": "application/webauthn+json",
        "idempotency-key": COMMAND_ID,
        "if-match": '"1"',
        "bootstrap-authorization": `Bearer ${BOOTSTRAP_TOKEN}`
      },
      payload: JSON.stringify(authenticationCredential())
    });

    expect(response.statusCode).toBe(409);
    expect(response.headers.etag).toBe('"2"');
    expect(response.headers["cache-control"]).toBe("no-store");
  });

  it("rejects the wrong credential media type and a malformed trusted response", async () => {
    const fixture = await harness();
    const raw = JSON.stringify(authenticationCredential());
    const wrongType = await fixture.app.inject({
      method: "POST",
      url: PASSKEY_INTERNAL_LOGIN_VERIFY_PATH,
      headers: {
        "content-type": "application/json",
        "idempotency-key": COMMAND_ID,
        "if-match": '"1"',
        "bootstrap-authorization": `Bearer ${BOOTSTRAP_TOKEN}`
      },
      payload: raw
    });
    expect(wrongType.statusCode).toBe(415);
    expect(fixture.verify).not.toHaveBeenCalled();

    fixture.begin.mockResolvedValueOnce({ ...BEGIN_RESPONSE, accountId: USER_ID } as never);
    const invalidResponse = await fixture.app.inject({
      method: "POST",
      url: PASSKEY_INTERNAL_LOGIN_OPTIONS_PATH,
      headers: { "idempotency-key": COMMAND_ID },
      payload: { clientNonce: CLIENT_NONCE, deliveryNonce: DELIVERY_NONCE }
    });
    expect(invalidResponse.statusCode).toBe(500);
    expect(invalidResponse.headers["cache-control"]).toBe("no-store");
  });
});
