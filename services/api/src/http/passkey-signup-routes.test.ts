import { createHash } from "node:crypto";

import Fastify, { type FastifyInstance } from "fastify";
import {
  PASSKEY_INTERNAL_SIGNUP_OPTIONS_PATH,
  PASSKEY_INTERNAL_SIGNUP_VERIFY_PATH,
  type PasskeySignupBeginResponse,
  type PasskeySignupVerifyResponse
} from "@luxora/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AppError } from "../errors.js";
import { registerPasskeyLoginRoutes } from "./passkey-login-routes.js";
import {
  registerPasskeySignupRoutes,
  type PasskeySignupRouteService
} from "./passkey-signup-routes.js";

const INTENT_ID = "11111111-1111-4111-8111-111111111111";
const COMMAND_ID = "22222222-2222-4222-8222-222222222222";
const CLIENT_NONCE = "33333333-3333-4333-8333-333333333333";
const USER_ID = "44444444-4444-4444-8444-444444444444";
const SESSION_ID = "55555555-5555-4555-8555-555555555555";
const DELIVERY_NONCE = "E".repeat(43);
const USER_HANDLE = "A".repeat(43);
const BOOTSTRAP_TOKEN = "e30.e30.AAAA";
const EXPIRES_AT = "2026-08-04T10:05:00.000Z";

const BEGIN_RESPONSE: PasskeySignupBeginResponse = {
  schemaVersion: 1,
  replayed: false,
  ceremony: {
    id: INTENT_ID,
    kind: "registration",
    purpose: "account.create",
    state: "pending",
    revision: 1,
    expiresAt: EXPIRES_AT
  },
  bootstrapAuthorization: {
    scheme: "Bearer",
    token: BOOTSTRAP_TOKEN,
    purpose: "account.create",
    expiresAt: EXPIRES_AT
  },
  options: {
    challenge: "A".repeat(43),
    rp: { id: "auth.luxora.app", name: "Luxora" },
    user: { id: USER_HANDLE, name: "alice", displayName: "Alice" },
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
  }
};

const VERIFY_RESPONSE: PasskeySignupVerifyResponse = {
  schemaVersion: 1,
  verified: true,
  replayed: false,
  ceremony: {
    id: INTENT_ID,
    kind: "registration",
    purpose: "account.create",
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

interface Harness {
  readonly app: FastifyInstance;
  readonly begin: ReturnType<typeof vi.fn<PasskeySignupRouteService["begin"]>>;
  readonly verify: ReturnType<typeof vi.fn<PasskeySignupRouteService["verify"]>>;
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
    const statusCode = typeof error === "object"
      && error !== null
      && "statusCode" in error
      && typeof error.statusCode === "number"
      ? error.statusCode
      : 500;
    return reply.code(statusCode).send({
      error: { code: statusCode === 500 ? "INTERNAL_ERROR" : "BAD_REQUEST", requestId: request.id }
    });
  });
  const begin = vi.fn<PasskeySignupRouteService["begin"]>(async () => BEGIN_RESPONSE);
  const verify = vi.fn<PasskeySignupRouteService["verify"]>(async () => VERIFY_RESPONSE);
  registerPasskeySignupRoutes(app, { service: { begin, verify } });
  await app.ready();
  return { app, begin, verify };
}

function verifyHeaders() {
  return {
    "content-type": "application/webauthn+json",
    "idempotency-key": COMMAND_ID,
    "if-match": "\"1\"",
    "bootstrap-authorization": `Bearer ${BOOTSTRAP_TOKEN}`
  };
}

describe("pre-account passkey signup HTTP routes", () => {
  it("forwards the strict canonical signup identity and emits a non-cacheable revision", async () => {
    const fixture = await harness();
    const response = await fixture.app.inject({
      method: "POST",
      url: PASSKEY_INTERNAL_SIGNUP_OPTIONS_PATH,
      headers: { "idempotency-key": COMMAND_ID.toUpperCase() },
      payload: {
        clientNonce: CLIENT_NONCE.toUpperCase(),
        deliveryNonce: DELIVERY_NONCE,
        username: " Alice_7 ",
        displayName: " A\u030Alice Example ",
        deviceName: " E\u0301gor’s iPhone "
      }
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.headers.pragma).toBe("no-cache");
    expect(response.headers.etag).toBe('"1"');
    expect(fixture.begin).toHaveBeenCalledWith({
      commandId: COMMAND_ID,
      clientNonce: CLIENT_NONCE,
      deliveryNonce: DELIVERY_NONCE,
      username: "alice_7",
      displayName: "Ålice Example",
      deviceName: "Égor’s iPhone"
    });
  });

  it("keeps the raw registration digest separate from authorization and revision headers", async () => {
    const fixture = await harness();
    const raw = JSON.stringify(registrationCredential());
    const response = await fixture.app.inject({
      method: "POST",
      url: PASSKEY_INTERNAL_SIGNUP_VERIFY_PATH,
      headers: verifyHeaders(),
      payload: raw
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.headers.etag).toBe('"2"');
    expect(fixture.verify).toHaveBeenCalledWith({
      commandId: COMMAND_ID,
      expectedRevision: 1,
      signupAuthorization: BOOTSTRAP_TOKEN,
      response: {
        credential: registrationCredential(),
        byteLength: Buffer.byteLength(raw),
        digest: createHash("sha256").update(raw).digest("hex")
      }
    });
  });

  it("rejects missing, duplicated, or body-decorated authorization before the service", async () => {
    const fixture = await harness();
    const headers = verifyHeaders();
    const {
      "bootstrap-authorization": _omittedAuthorization,
      ...withoutAuthorization
    } = headers;
    const raw = JSON.stringify(registrationCredential());
    const missing = await fixture.app.inject({
      method: "POST",
      url: PASSKEY_INTERNAL_SIGNUP_VERIFY_PATH,
      headers: withoutAuthorization,
      payload: raw
    });
    const duplicate = await fixture.app.inject({
      method: "POST",
      url: PASSKEY_INTERNAL_SIGNUP_VERIFY_PATH,
      headers: { ...headers, "x-test-duplicate-header": "Bootstrap-Authorization" },
      payload: raw
    });
    const decorated = await fixture.app.inject({
      method: "POST",
      url: PASSKEY_INTERNAL_SIGNUP_VERIFY_PATH,
      headers,
      payload: JSON.stringify({
        ...registrationCredential(),
        signupAuthorization: BOOTSTRAP_TOKEN
      })
    });

    expect([missing.statusCode, duplicate.statusCode, decorated.statusCode])
      .toEqual([400, 400, 400]);
    expect(fixture.verify).not.toHaveBeenCalled();
  });

  it("rejects query strings and duplicate begin metadata before either service command", async () => {
    const fixture = await harness();
    const begin = await fixture.app.inject({
      method: "POST",
      url: `${PASSKEY_INTERNAL_SIGNUP_OPTIONS_PATH}?accountId=${USER_ID}`,
      headers: { "idempotency-key": COMMAND_ID },
      payload: {
        clientNonce: CLIENT_NONCE,
        deliveryNonce: DELIVERY_NONCE,
        username: "alice",
        displayName: "Alice",
        deviceName: "iPhone"
      }
    });
    const duplicate = await fixture.app.inject({
      method: "POST",
      url: PASSKEY_INTERNAL_SIGNUP_OPTIONS_PATH,
      headers: {
        "idempotency-key": COMMAND_ID,
        "x-test-duplicate-header": "Idempotency-Key"
      },
      payload: {
        clientNonce: CLIENT_NONCE,
        deliveryNonce: DELIVERY_NONCE,
        username: "alice",
        displayName: "Alice",
        deviceName: "iPhone"
      }
    });
    const verify = await fixture.app.inject({
      method: "POST",
      url: `${PASSKEY_INTERNAL_SIGNUP_VERIFY_PATH}?token=${BOOTSTRAP_TOKEN}`,
      headers: verifyHeaders(),
      payload: JSON.stringify(registrationCredential())
    });

    expect([begin.statusCode, duplicate.statusCode, verify.statusCode]).toEqual([400, 400, 400]);
    expect(fixture.begin).not.toHaveBeenCalled();
    expect(fixture.verify).not.toHaveBeenCalled();
  });

  it("emits the authoritative revision ETag for a token-bound CAS conflict", async () => {
    const fixture = await harness();
    fixture.verify.mockRejectedValueOnce(new AppError(
      409,
      "CONFLICT",
      "Passkey signup revision does not match",
      { reason: "ceremony_conflict", state: "consumed", revision: 2 }
    ));
    const response = await fixture.app.inject({
      method: "POST",
      url: PASSKEY_INTERNAL_SIGNUP_VERIFY_PATH,
      headers: verifyHeaders(),
      payload: JSON.stringify(registrationCredential())
    });

    expect(response.statusCode).toBe(409);
    expect(response.headers.etag).toBe('"2"');
    expect(response.headers["cache-control"]).toBe("no-store");
  });

  it("rejects the wrong media type and malformed trusted output", async () => {
    const fixture = await harness();
    const wrongType = await fixture.app.inject({
      method: "POST",
      url: PASSKEY_INTERNAL_SIGNUP_VERIFY_PATH,
      headers: { ...verifyHeaders(), "content-type": "application/json" },
      payload: JSON.stringify(registrationCredential())
    });
    expect(wrongType.statusCode).toBe(415);
    const duplicateType = await fixture.app.inject({
      method: "POST",
      url: PASSKEY_INTERNAL_SIGNUP_VERIFY_PATH,
      headers: { ...verifyHeaders(), "x-test-duplicate-header": "Content-Type" },
      payload: JSON.stringify(registrationCredential())
    });
    expect(duplicateType.statusCode).toBe(415);
    expect(fixture.verify).not.toHaveBeenCalled();

    fixture.begin.mockResolvedValueOnce({ ...BEGIN_RESPONSE, accountId: USER_ID } as never);
    const invalidOutput = await fixture.app.inject({
      method: "POST",
      url: PASSKEY_INTERNAL_SIGNUP_OPTIONS_PATH,
      headers: { "idempotency-key": COMMAND_ID },
      payload: {
        clientNonce: CLIENT_NONCE,
        deliveryNonce: DELIVERY_NONCE,
        username: "alice",
        displayName: "Alice",
        deviceName: "iPhone"
      }
    });
    expect(invalidOutput.statusCode).toBe(500);
    expect(invalidOutput.headers["cache-control"]).toBe("no-store");
  });

  it("refuses duplicate route registration on one Fastify instance", async () => {
    const fixture = await harness();
    expect(() => registerPasskeySignupRoutes(fixture.app, {
      service: { begin: fixture.begin, verify: fixture.verify }
    })).toThrow("Passkey signup routes are already registered");
  });

  it("shares the one audited raw parser with primary login without route wiring side effects", async () => {
    const app = Fastify({ logger: false });
    openApps.push(app);
    const unavailable = async (): Promise<never> => {
      throw new Error("not called");
    };
    registerPasskeySignupRoutes(app, {
      service: { begin: unavailable, verify: unavailable }
    });
    registerPasskeyLoginRoutes(app, {
      service: { begin: unavailable, verify: unavailable }
    });
    await app.ready();

    expect(app.hasContentTypeParser("application/webauthn+json")).toBe(true);
    expect(app.hasRoute({
      method: "POST",
      url: PASSKEY_INTERNAL_SIGNUP_OPTIONS_PATH
    })).toBe(true);
  });
});
