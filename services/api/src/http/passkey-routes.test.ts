import { createHash } from "node:crypto";
import Fastify, {
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest
} from "fastify";
import {
  PASSKEY_MAX_CREDENTIAL_RESPONSE_BYTES,
  PasskeyCeremonyErrorSchema,
  type PasskeyCeremonyVerifyResponse,
  type PasskeyRegistrationBeginResponse,
  type PasskeyStepUpBeginResponse
} from "@luxora/protocol";
import { ZodError } from "zod";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AuthenticatedPrincipal } from "../domain/types.js";
import { AppError, unauthenticated } from "../errors.js";
import {
  registerPasskeyRoutes,
  type PasskeyRouteService
} from "./passkey-routes.js";

const ACCESS_AUTHORIZATION = "Bearer test-access-token";
const STEP_UP_TOKEN = "e30.e30.AAAA";
const CEREMONY_ID = "11111111-1111-4111-8111-111111111111";
const STEP_UP_CEREMONY_ID = "22222222-2222-4222-8222-222222222222";
const COMMAND_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const STEP_UP_COMMAND_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const VERIFY_COMMAND_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const CLIENT_NONCE = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const USER_HANDLE = "A".repeat(43);

const PRINCIPAL: AuthenticatedPrincipal = Object.freeze({
  userId: "99999999-9999-4999-8999-999999999999",
  sessionId: "88888888-8888-4888-8888-888888888888",
  tokenId: "77777777-7777-4777-8777-777777777777"
});

const REGISTRATION_RESPONSE: PasskeyRegistrationBeginResponse = {
  schemaVersion: 1,
  ceremony: {
    id: CEREMONY_ID,
    kind: "registration",
    purpose: "authenticator.add",
    state: "pending",
    revision: 1,
    expiresAt: "2026-08-04T00:05:00.000Z"
  },
  replayed: false,
  options: {
    challenge: "A".repeat(43),
    rp: { id: "auth.luxora.app", name: "Luxora" },
    user: {
      id: USER_HANDLE,
      name: "fixture_user",
      displayName: "Fixture User"
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
  }
};

const STEP_UP_RESPONSE: PasskeyStepUpBeginResponse = {
  schemaVersion: 1,
  ceremony: {
    id: STEP_UP_CEREMONY_ID,
    kind: "authentication",
    purpose: "session.step_up",
    state: "pending",
    revision: 1,
    expiresAt: "2026-08-04T00:05:00.000Z"
  },
  replayed: false,
  operation: "authenticator.add",
  options: {
    challenge: "A".repeat(43),
    rpId: "auth.luxora.app",
    timeout: 300_000,
    userVerification: "required",
    allowCredentials: []
  }
};

const VERIFY_RESPONSE: PasskeyCeremonyVerifyResponse = {
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

function registrationCredential() {
  return {
    id: "AQIDBA",
    rawId: "AQIDBA",
    response: {
      clientDataJSON: "e30",
      attestationObject: "oA",
      transports: ["internal", "hybrid"]
    },
    authenticatorAttachment: "platform",
    clientExtensionResults: { credProps: { rk: true } },
    type: "public-key"
  };
}

interface Harness {
  app: FastifyInstance;
  service: PasskeyRouteService;
  beginRegistration: ReturnType<typeof vi.fn<PasskeyRouteService["beginRegistration"]>>;
  beginStepUp: ReturnType<typeof vi.fn<PasskeyRouteService["beginStepUp"]>>;
  verify: ReturnType<typeof vi.fn<PasskeyRouteService["verify"]>>;
  authGuard: ReturnType<
    typeof vi.fn<(request: FastifyRequest, reply: FastifyReply) => Promise<void>>
  >;
}

const openApps: FastifyInstance[] = [];

afterEach(async () => {
  await Promise.all(openApps.splice(0).map(async (app) => app.close()));
});

function installTestErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler(async (error, request, reply) => {
    if (error instanceof ZodError) {
      return reply.code(400).send({
        error: {
          code: "VALIDATION_FAILED",
          message: "Request validation failed",
          requestId: request.id
        }
      });
    }
    if (error instanceof AppError) {
      return reply.code(error.statusCode).send({
        error: {
          code: error.code,
          message: error.message,
          requestId: request.id
        }
      });
    }
    const frameworkStatus = typeof error === "object"
      && error !== null
      && "statusCode" in error
      && typeof error.statusCode === "number"
      ? error.statusCode
      : undefined;
    const statusCode = frameworkStatus !== undefined
      && frameworkStatus >= 400
      && frameworkStatus < 500
      ? frameworkStatus
      : 500;
    return reply.code(statusCode).send({
      error: {
        code: statusCode === 500 ? "INTERNAL_ERROR" : "BAD_REQUEST",
        message: statusCode === 413
          ? "Request payload is too large"
          : statusCode === 415
            ? "Unsupported media type"
            : "Malformed request",
        requestId: request.id
      }
    });
  });
}

async function createHarness(logStream?: { write(message: string): void }): Promise<Harness> {
  const app = Fastify(logStream === undefined ? { logger: false } : {
    logger: { level: "info", stream: logStream }
  });
  openApps.push(app);

  // Fastify injection intentionally normalizes duplicate names. This hook
  // recreates the raw duplicate seen on a real IncomingMessage so the route's
  // single-header boundary remains covered without opening a network socket.
  app.addHook("onRequest", async (request) => {
    const duplicateName = request.headers["x-test-duplicate-header"];
    if (typeof duplicateName !== "string") return;
    const value = request.headers[duplicateName.toLowerCase()];
    if (typeof value === "string") request.raw.rawHeaders.push(duplicateName, value);
  });

  const beginRegistration = vi.fn<PasskeyRouteService["beginRegistration"]>(
    async () => REGISTRATION_RESPONSE
  );
  const beginStepUp = vi.fn<PasskeyRouteService["beginStepUp"]>(
    async () => STEP_UP_RESPONSE
  );
  const verify = vi.fn<PasskeyRouteService["verify"]>(async () => VERIFY_RESPONSE);
  const service: PasskeyRouteService = { beginRegistration, beginStepUp, verify };
  const authGuard = vi.fn<
    (request: FastifyRequest, reply: FastifyReply) => Promise<void>
  >(async (request) => {
    if (request.headers.authorization !== ACCESS_AUTHORIZATION) throw unauthenticated();
    request.auth = PRINCIPAL;
  });

  installTestErrorHandler(app);
  registerPasskeyRoutes(app, { service, authGuard });
  await app.ready();
  return { app, service, beginRegistration, beginStepUp, verify, authGuard };
}

function registrationHeaders() {
  return {
    authorization: ACCESS_AUTHORIZATION,
    "idempotency-key": COMMAND_ID.toUpperCase(),
    "step-up-authorization": `Bearer ${STEP_UP_TOKEN}`
  };
}

function verifyHeaders(contentType = "application/webauthn+json") {
  return {
    authorization: ACCESS_AUTHORIZATION,
    "idempotency-key": VERIFY_COMMAND_ID.toUpperCase(),
    "if-match": "\"1\"",
    "content-type": contentType
  };
}

describe("passkey HTTP routes", () => {
  it("forwards the authenticated actor and exact canonical registration input", async () => {
    const harness = await createHarness();
    const response = await harness.app.inject({
      method: "POST",
      url: "/v1/auth/passkey-ceremonies/registration",
      headers: registrationHeaders(),
      payload: {
        clientNonce: CLIENT_NONCE.toUpperCase(),
        stepUpCeremonyId: STEP_UP_CEREMONY_ID.toUpperCase()
      }
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers.etag).toBe("\"1\"");
    expect(response.json()).toEqual(REGISTRATION_RESPONSE);
    expect(harness.beginRegistration).toHaveBeenCalledTimes(1);
    const call = harness.beginRegistration.mock.calls[0];
    expect(call?.[0]).toBe(PRINCIPAL);
    expect(call?.[1]).toStrictEqual({
      commandId: COMMAND_ID,
      clientNonce: CLIENT_NONCE,
      stepUpCeremonyId: STEP_UP_CEREMONY_ID,
      stepUpToken: STEP_UP_TOKEN
    });
  });

  it("forwards only the bounded step-up command and strips additive service output", async () => {
    const harness = await createHarness();
    harness.beginStepUp.mockResolvedValueOnce({
      ...STEP_UP_RESPONSE,
      internalOnly: "must-not-cross-http"
    } as PasskeyStepUpBeginResponse);
    const response = await harness.app.inject({
      method: "POST",
      url: "/v1/auth/passkey-ceremonies/authentication",
      headers: {
        authorization: ACCESS_AUTHORIZATION,
        "idempotency-key": STEP_UP_COMMAND_ID.toUpperCase()
      },
      payload: {
        clientNonce: CLIENT_NONCE.toUpperCase(),
        operation: "authenticator.add"
      }
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers.etag).toBe("\"1\"");
    expect(response.json()).toEqual(STEP_UP_RESPONSE);
    const call = harness.beginStepUp.mock.calls[0];
    expect(call?.[0]).toBe(PRINCIPAL);
    expect(call?.[1]).toStrictEqual({
      commandId: STEP_UP_COMMAND_ID,
      clientNonce: CLIENT_NONCE,
      operation: "authenticator.add"
    });
  });

  it("maps malformed trusted service output to a schema-valid internal error", async () => {
    const harness = await createHarness();
    harness.beginStepUp.mockResolvedValueOnce({
      ...STEP_UP_RESPONSE,
      ceremony: { ...STEP_UP_RESPONSE.ceremony, revision: -1 }
    } as PasskeyStepUpBeginResponse);
    const response = await harness.app.inject({
      method: "POST",
      url: "/v1/auth/passkey-ceremonies/authentication",
      headers: {
        authorization: ACCESS_AUTHORIZATION,
        "idempotency-key": STEP_UP_COMMAND_ID
      },
      payload: { clientNonce: CLIENT_NONCE, operation: "authenticator.add" }
    });

    expect(response.statusCode).toBe(500);
    expect(PasskeyCeremonyErrorSchema.parse(response.json())).toMatchObject({
      error: { code: "INTERNAL_ERROR" }
    });
  });

  it("derives verify length and digest from exact bytes after strict credential parsing", async () => {
    const harness = await createHarness();
    const credential = registrationCredential();
    const rawBody = Buffer.from(JSON.stringify(credential, null, 2), "utf8");
    const response = await harness.app.inject({
      method: "POST",
      url: `/v1/auth/passkey-ceremonies/${CEREMONY_ID.toUpperCase()}/verify`,
      headers: verifyHeaders("Application/WebAuthn+JSON; charset=UTF-8"),
      payload: rawBody
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers.etag).toBe("\"2\"");
    expect(response.json()).toEqual(VERIFY_RESPONSE);
    const call = harness.verify.mock.calls[0];
    expect(call?.[0]).toBe(PRINCIPAL);
    expect(call?.[1]).toMatchObject({
      ceremonyId: CEREMONY_ID,
      commandId: VERIFY_COMMAND_ID,
      expectedRevision: 1
    });
    expect(call?.[1].response).toStrictEqual({
      credential,
      byteLength: rawBody.byteLength,
      digest: createHash("sha256").update(rawBody).digest("hex")
    });
    expect(Object.keys(call?.[1].response ?? {}).sort()).toEqual([
      "byteLength",
      "credential",
      "digest"
    ]);
  });

  it("runs authentication before parsing or invoking every ceremony service", async () => {
    const harness = await createHarness();
    const requests = [
      {
        url: "/v1/auth/passkey-ceremonies/registration",
        headers: {
          "idempotency-key": COMMAND_ID,
          "step-up-authorization": `Bearer ${STEP_UP_TOKEN}`
        },
        payload: { clientNonce: CLIENT_NONCE, stepUpCeremonyId: STEP_UP_CEREMONY_ID }
      },
      {
        url: "/v1/auth/passkey-ceremonies/authentication",
        headers: { "idempotency-key": STEP_UP_COMMAND_ID },
        payload: { clientNonce: CLIENT_NONCE, operation: "authenticator.add" }
      },
      {
        url: `/v1/auth/passkey-ceremonies/${CEREMONY_ID}/verify`,
        headers: {
          "idempotency-key": VERIFY_COMMAND_ID,
          "if-match": "\"1\"",
          "content-type": "application/webauthn+json"
        },
        payload: Buffer.alloc(PASSKEY_MAX_CREDENTIAL_RESPONSE_BYTES + 1, 0x20)
      }
    ];

    for (const request of requests) {
      const response = await harness.app.inject({ method: "POST", ...request });
      expect(response.statusCode).toBe(401);
    }
    expect(harness.authGuard).toHaveBeenCalledTimes(3);
    expect(harness.beginRegistration).not.toHaveBeenCalled();
    expect(harness.beginStepUp).not.toHaveBeenCalled();
    expect(harness.verify).not.toHaveBeenCalled();
  });

  it("rejects missing ceremony headers without invoking the service", async () => {
    const harness = await createHarness();
    const credentialBytes = Buffer.from(JSON.stringify(registrationCredential()), "utf8");
    const cases = [
      {
        url: "/v1/auth/passkey-ceremonies/registration",
        headers: {
          authorization: ACCESS_AUTHORIZATION,
          "step-up-authorization": `Bearer ${STEP_UP_TOKEN}`
        },
        payload: { clientNonce: CLIENT_NONCE, stepUpCeremonyId: STEP_UP_CEREMONY_ID },
        status: 400
      },
      {
        url: "/v1/auth/passkey-ceremonies/registration",
        headers: { authorization: ACCESS_AUTHORIZATION, "idempotency-key": COMMAND_ID },
        payload: { clientNonce: CLIENT_NONCE, stepUpCeremonyId: STEP_UP_CEREMONY_ID },
        status: 400
      },
      {
        url: "/v1/auth/passkey-ceremonies/authentication",
        headers: { authorization: ACCESS_AUTHORIZATION },
        payload: { clientNonce: CLIENT_NONCE, operation: "authenticator.add" },
        status: 400
      },
      {
        url: `/v1/auth/passkey-ceremonies/${CEREMONY_ID}/verify`,
        headers: {
          authorization: ACCESS_AUTHORIZATION,
          "if-match": "\"1\"",
          "content-type": "application/webauthn+json"
        },
        payload: credentialBytes,
        status: 400
      },
      {
        url: `/v1/auth/passkey-ceremonies/${CEREMONY_ID}/verify`,
        headers: {
          authorization: ACCESS_AUTHORIZATION,
          "idempotency-key": VERIFY_COMMAND_ID,
          "content-type": "application/webauthn+json"
        },
        payload: credentialBytes,
        status: 400
      },
      {
        url: `/v1/auth/passkey-ceremonies/${CEREMONY_ID}/verify`,
        headers: {
          authorization: ACCESS_AUTHORIZATION,
          "idempotency-key": VERIFY_COMMAND_ID,
          "if-match": "\"1\""
        },
        payload: credentialBytes,
        status: 415
      }
    ];

    for (const request of cases) {
      const response = await harness.app.inject({ method: "POST", ...request });
      expect(response.statusCode).toBe(request.status);
      expect(() => PasskeyCeremonyErrorSchema.parse(response.json())).not.toThrow();
    }
    expect(harness.beginRegistration).not.toHaveBeenCalled();
    expect(harness.beginStepUp).not.toHaveBeenCalled();
    expect(harness.verify).not.toHaveBeenCalled();
  });

  it("rejects duplicate and comma-folded security headers", async () => {
    const harness = await createHarness();
    const duplicateToken = await harness.app.inject({
      method: "POST",
      url: "/v1/auth/passkey-ceremonies/registration",
      headers: {
        ...registrationHeaders(),
        "x-test-duplicate-header": "Step-Up-Authorization"
      },
      payload: { clientNonce: CLIENT_NONCE, stepUpCeremonyId: STEP_UP_CEREMONY_ID }
    });
    expect(duplicateToken.statusCode).toBe(400);
    expect(duplicateToken.body).not.toContain(STEP_UP_TOKEN);

    const foldedCommand = await harness.app.inject({
      method: "POST",
      url: "/v1/auth/passkey-ceremonies/authentication",
      headers: {
        authorization: ACCESS_AUTHORIZATION,
        "idempotency-key": `${STEP_UP_COMMAND_ID},${COMMAND_ID}`
      },
      payload: { clientNonce: CLIENT_NONCE, operation: "authenticator.add" }
    });
    expect(foldedCommand.statusCode).toBe(400);

    const duplicateRevision = await harness.app.inject({
      method: "POST",
      url: `/v1/auth/passkey-ceremonies/${CEREMONY_ID}/verify`,
      headers: {
        ...verifyHeaders(),
        "x-test-duplicate-header": "If-Match"
      },
      payload: Buffer.from(JSON.stringify(registrationCredential()), "utf8")
    });
    expect(duplicateRevision.statusCode).toBe(400);

    expect(harness.beginRegistration).not.toHaveBeenCalled();
    expect(harness.beginStepUp).not.toHaveBeenCalled();
    expect(harness.verify).not.toHaveBeenCalled();
  });

  it("never reflects or logs a rejected step-up bearer value", async () => {
    let logs = "";
    const harness = await createHarness({ write(message) { logs += message; } });
    const tokenCanary = "e30.e30.Q0FOQVJZX1RPS0VO";
    const response = await harness.app.inject({
      method: "POST",
      url: "/v1/auth/passkey-ceremonies/registration",
      headers: {
        ...registrationHeaders(),
        "step-up-authorization": `bearer ${tokenCanary}`
      },
      payload: { clientNonce: CLIENT_NONCE, stepUpCeremonyId: STEP_UP_CEREMONY_ID }
    });
    await harness.app.close();
    openApps.splice(openApps.indexOf(harness.app), 1);

    expect(response.statusCode).toBe(400);
    expect(response.body).not.toContain(tokenCanary);
    expect(logs).not.toContain(tokenCanary);
    expect(harness.beginRegistration).not.toHaveBeenCalled();
  });

  it("rejects invalid UUID, revision, and bearer header forms", async () => {
    const harness = await createHarness();
    const registrationBody = { clientNonce: CLIENT_NONCE, stepUpCeremonyId: STEP_UP_CEREMONY_ID };
    for (const stepUpAuthorization of [
      `bearer ${STEP_UP_TOKEN}`,
      `Bearer  ${STEP_UP_TOKEN}`,
      `Bearer ${STEP_UP_TOKEN} `,
      "Bearer e30.e30.AA=="
    ]) {
      const response = await harness.app.inject({
        method: "POST",
        url: "/v1/auth/passkey-ceremonies/registration",
        headers: {
          authorization: ACCESS_AUTHORIZATION,
          "idempotency-key": COMMAND_ID,
          "step-up-authorization": stepUpAuthorization
        },
        payload: registrationBody
      });
      expect(response.statusCode).toBe(400);
      expect(response.body).not.toContain(stepUpAuthorization);
    }

    const invalidCommand = await harness.app.inject({
      method: "POST",
      url: "/v1/auth/passkey-ceremonies/authentication",
      headers: { authorization: ACCESS_AUTHORIZATION, "idempotency-key": "not-a-uuid" },
      payload: { clientNonce: CLIENT_NONCE, operation: "authenticator.add" }
    });
    expect(invalidCommand.statusCode).toBe(400);

    for (const invalidRevision of ["1", "W/\"1\"", "\"01\"", "*"]) {
      const response = await harness.app.inject({
        method: "POST",
        url: `/v1/auth/passkey-ceremonies/${CEREMONY_ID}/verify`,
        headers: { ...verifyHeaders(), "if-match": invalidRevision },
        payload: Buffer.from(JSON.stringify(registrationCredential()), "utf8")
      });
      expect(response.statusCode).toBe(400);
    }
    const invalidCeremony = await harness.app.inject({
      method: "POST",
      url: "/v1/auth/passkey-ceremonies/not-a-uuid/verify",
      headers: verifyHeaders(),
      payload: Buffer.from(JSON.stringify(registrationCredential()), "utf8")
    });
    expect(invalidCeremony.statusCode).toBe(400);
    expect(harness.beginRegistration).not.toHaveBeenCalled();
    expect(harness.beginStepUp).not.toHaveBeenCalled();
    expect(harness.verify).not.toHaveBeenCalled();
  });

  it("enforces strict begin JSON kinds, fields, and operation", async () => {
    const harness = await createHarness();
    const cases = [
      {
        url: "/v1/auth/passkey-ceremonies/registration",
        headers: registrationHeaders(),
        payload: []
      },
      {
        url: "/v1/auth/passkey-ceremonies/registration",
        headers: registrationHeaders(),
        payload: {
          clientNonce: CLIENT_NONCE,
          stepUpCeremonyId: STEP_UP_CEREMONY_ID,
          stepUpToken: STEP_UP_TOKEN
        }
      },
      {
        url: "/v1/auth/passkey-ceremonies/authentication",
        headers: { authorization: ACCESS_AUTHORIZATION, "idempotency-key": STEP_UP_COMMAND_ID },
        payload: { clientNonce: CLIENT_NONCE, operation: "account.delete" }
      },
      {
        url: "/v1/auth/passkey-ceremonies/authentication",
        headers: { authorization: ACCESS_AUTHORIZATION, "idempotency-key": STEP_UP_COMMAND_ID },
        payload: { clientNonce: CLIENT_NONCE, operation: "authenticator.add", accountId: PRINCIPAL.userId }
      }
    ];

    for (const request of cases) {
      const response = await harness.app.inject({ method: "POST", ...request });
      expect(response.statusCode).toBe(400);
      expect(() => PasskeyCeremonyErrorSchema.parse(response.json())).not.toThrow();
    }
    expect(harness.beginRegistration).not.toHaveBeenCalled();
    expect(harness.beginStepUp).not.toHaveBeenCalled();
  });

  it("accepts only the dedicated WebAuthn media type with optional UTF-8 charset", async () => {
    const harness = await createHarness();
    const body = Buffer.from(JSON.stringify(registrationCredential()), "utf8");
    for (const contentType of [
      "application/json",
      "text/plain",
      "application/webauthn+json; charset=iso-8859-1"
    ]) {
      const response = await harness.app.inject({
        method: "POST",
        url: `/v1/auth/passkey-ceremonies/${CEREMONY_ID}/verify`,
        headers: verifyHeaders(contentType),
        payload: body
      });
      expect(response.statusCode).toBe(415);
    }
    expect(harness.verify).not.toHaveBeenCalled();
  });

  it("rejects empty, oversized, invalid UTF-8, and invalid JSON verify bytes", async () => {
    const harness = await createHarness();
    const cases = [
      { payload: Buffer.alloc(0), status: 400 },
      {
        payload: Buffer.alloc(PASSKEY_MAX_CREDENTIAL_RESPONSE_BYTES + 1, 0x20),
        status: 413
      },
      { payload: Buffer.from([0xc3, 0x28]), status: 400 },
      { payload: Buffer.from("{", "utf8"), status: 400 }
    ];
    for (const testCase of cases) {
      const response = await harness.app.inject({
        method: "POST",
        url: `/v1/auth/passkey-ceremonies/${CEREMONY_ID}/verify`,
        headers: verifyHeaders(),
        payload: testCase.payload
      });
      expect(response.statusCode).toBe(testCase.status);
    }
    expect(harness.verify).not.toHaveBeenCalled();
  });

  it("rejects wrong verify JSON kinds, unknown fields, and forged transport metadata", async () => {
    const harness = await createHarness();
    const credential = registrationCredential();
    const cases: unknown[] = [
      [],
      "credential",
      { ...credential, accountId: PRINCIPAL.userId },
      { ...credential, byteLength: 1, digest: "0".repeat(64) },
      { credential, byteLength: 1, digest: "0".repeat(64) }
    ];
    for (const body of cases) {
      const response = await harness.app.inject({
        method: "POST",
        url: `/v1/auth/passkey-ceremonies/${CEREMONY_ID}/verify`,
        headers: verifyHeaders(),
        payload: Buffer.from(JSON.stringify(body), "utf8")
      });
      expect(response.statusCode).toBe(400);
    }
    expect(harness.verify).not.toHaveBeenCalled();
  });

  it("documents and enforces register-once parser ownership", async () => {
    const app = Fastify({ logger: false });
    openApps.push(app);
    const service = {
      beginRegistration: vi.fn<PasskeyRouteService["beginRegistration"]>(),
      beginStepUp: vi.fn<PasskeyRouteService["beginStepUp"]>(),
      verify: vi.fn<PasskeyRouteService["verify"]>()
    } satisfies PasskeyRouteService;
    const authGuard = vi.fn<
      (request: FastifyRequest, reply: FastifyReply) => Promise<void>
    >(async () => {});

    registerPasskeyRoutes(app, { service, authGuard });
    expect(() => registerPasskeyRoutes(app, { service, authGuard }))
      .toThrow("Passkey routes are already registered");
  });

  it("refuses to shadow a pre-existing WebAuthn parser", async () => {
    const app = Fastify({ logger: false });
    openApps.push(app);
    app.addContentTypeParser("application/webauthn+json", {
      parseAs: "buffer",
      bodyLimit: PASSKEY_MAX_CREDENTIAL_RESPONSE_BYTES
    }, (_request, body, done) => done(null, body));
    const service = {
      beginRegistration: vi.fn<PasskeyRouteService["beginRegistration"]>(),
      beginStepUp: vi.fn<PasskeyRouteService["beginStepUp"]>(),
      verify: vi.fn<PasskeyRouteService["verify"]>()
    } satisfies PasskeyRouteService;
    const authGuard = vi.fn<
      (request: FastifyRequest, reply: FastifyReply) => Promise<void>
    >(async () => {});

    expect(() => registerPasskeyRoutes(app, { service, authGuard }))
      .toThrow("content parser is already registered");
  });
});
