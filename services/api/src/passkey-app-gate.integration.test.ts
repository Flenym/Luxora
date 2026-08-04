import { afterEach, describe, expect, it, vi } from "vitest";
import {
  PASSKEY_INTERNAL_LOGIN_OPTIONS_PATH,
  PASSKEY_INTERNAL_LOGIN_VERIFY_PATH,
  PASSKEY_INTERNAL_SIGNUP_OPTIONS_PATH,
  PASSKEY_INTERNAL_SIGNUP_VERIFY_PATH,
  PasskeyLoginBeginResponseSchema,
  PasskeySignupBeginResponseSchema
} from "@luxora/protocol";
import type { LuxoraApp } from "./app.js";
import { buildApp } from "./app.js";
import { SqliteStore } from "./infrastructure/sqlite-store.js";
import { testConfig } from "./test-helpers.js";

const REGISTRATION_ROUTE = "/v1/auth/passkey-ceremonies/registration";
const AUTHENTICATOR_MANAGEMENT_ROUTE = "/v1/auth/authenticators";
const AUTHENTICATOR_RENAME_ROUTE = `${AUTHENTICATOR_MANAGEMENT_ROUTE}/11111111-1111-4111-8111-111111111111`;
const AUTHENTICATOR_RESOURCE_OPENAPI_ROUTE = `${AUTHENTICATOR_MANAGEMENT_ROUTE}/{authenticatorId}`;
const AUTHENTICATOR_REVOKE_BEGIN_ROUTE = "/v1/auth/passkey-ceremonies/authenticator-revocation";
const CLIENT_NONCE = "11111111-1111-4111-8111-111111111111";
const STEP_UP_CEREMONY_ID = "22222222-2222-4222-8222-222222222222";
const COMMAND_ID = "33333333-3333-4333-8333-333333333333";
const DELIVERY_NONCE = Buffer.alloc(32, 7).toString("base64url");
const PASSKEY_REFRESH_KEY = Buffer.alloc(32, 11).toString("base64url");
const PASSKEY_SIGNUP_REFRESH_KEY = Buffer.alloc(32, 17).toString("base64url");
const PASSKEY_SIGNUP_AUTHORIZATION_SECRET = "independent-signup-authorization-secret-root";
const DATA_ENCRYPTION_KEY = Buffer.alloc(32, 13).toString("base64url");

function signupConfig() {
  return testConfig({
    passkeyInternalSignupRoutesEnabled: true,
    dataEncryptionKeys: { "data.v1": DATA_ENCRYPTION_KEY },
    activeDataEncryptionKeyId: "data.v1",
    passkeySignupAuthorizationSecret: PASSKEY_SIGNUP_AUTHORIZATION_SECRET,
    passkeySignupRefreshKeys: { "signup.v1": PASSKEY_SIGNUP_REFRESH_KEY },
    activePasskeySignupRefreshKeyId: "signup.v1"
  });
}

describe("passkey application integration gate", () => {
  let app: LuxoraApp | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
    vi.restoreAllMocks();
  });

  it("reasserts the production gate for programmatically supplied config", async () => {
    await expect(buildApp({
      config: testConfig({
        nodeEnv: "production",
        passkeyInternalRoutesEnabled: true
      }),
      logger: false
    })).rejects.toThrow("cannot be enabled in production");
    await expect(buildApp({
      config: testConfig({
        nodeEnv: "production",
        passkeyInternalSignupRoutesEnabled: true
      }),
      logger: false
    })).rejects.toThrow("cannot be enabled in production");
  });

  it("keeps the route family physically absent and unadvertised by default", async () => {
    app = await buildApp({ config: testConfig(), logger: false });
    const missing = await app.inject({ method: "POST", url: REGISTRATION_ROUTE });
    expect(missing.statusCode).toBe(404);
    const missingLogin = await app.inject({
      method: "POST",
      url: PASSKEY_INTERNAL_LOGIN_OPTIONS_PATH
    });
    expect(missingLogin.statusCode).toBe(404);
    const missingSignup = await app.inject({
      method: "POST",
      url: PASSKEY_INTERNAL_SIGNUP_OPTIONS_PATH
    });
    expect(missingSignup.statusCode).toBe(404);
    expect(missingSignup.headers["cache-control"]).toBe("private, no-store");
    const missingSignupVerify = await app.inject({
      method: "POST",
      url: PASSKEY_INTERNAL_SIGNUP_VERIFY_PATH
    });
    expect(missingSignupVerify.statusCode).toBe(404);
    for (const request of [
      { method: "GET" as const, url: AUTHENTICATOR_MANAGEMENT_ROUTE },
      { method: "PATCH" as const, url: AUTHENTICATOR_RENAME_ROUTE },
      { method: "POST" as const, url: AUTHENTICATOR_REVOKE_BEGIN_ROUTE },
      { method: "DELETE" as const, url: AUTHENTICATOR_RENAME_ROUTE }
    ]) {
      const response = await app.inject(request);
      expect(response.statusCode).toBe(404);
      expect(response.headers["cache-control"]).toBe("private, no-store");
    }

    const openapi = await app.inject({ method: "GET", url: "/openapi.json" });
    expect(openapi.statusCode).toBe(200);
    expect(openapi.json().paths).not.toHaveProperty(PASSKEY_INTERNAL_SIGNUP_OPTIONS_PATH);
    expect(openapi.json().paths).not.toHaveProperty(PASSKEY_INTERNAL_SIGNUP_VERIFY_PATH);
    expect(openapi.json().paths).not.toHaveProperty(AUTHENTICATOR_MANAGEMENT_ROUTE);
    expect(openapi.json().paths).not.toHaveProperty(AUTHENTICATOR_RESOURCE_OPENAPI_ROUTE);
    expect(openapi.json().paths).not.toHaveProperty(AUTHENTICATOR_REVOKE_BEGIN_ROUTE);

    const capabilities = await app.inject({ method: "GET", url: "/v1/capabilities" });
    expect(capabilities.statusCode).toBe(200);
    expect(capabilities.headers["cache-control"]).toBe("no-store");
    expect(capabilities.json().features.passkeys).toBe(false);
  });

  it("composes only the separately gated signup pair with a complete key set", async () => {
    app = await buildApp({ config: signupConfig(), logger: false });
    const response = await app.inject({
      method: "POST",
      url: PASSKEY_INTERNAL_SIGNUP_OPTIONS_PATH,
      headers: { "idempotency-key": COMMAND_ID },
      payload: {
        clientNonce: CLIENT_NONCE,
        deliveryNonce: DELIVERY_NONCE,
        username: "Signup_E2E",
        displayName: "Signup E2E",
        deviceName: "Egor’s iPhone"
      }
    });
    expect(response.statusCode, response.body).toBe(200);
    const body = PasskeySignupBeginResponseSchema.parse(response.json());
    expect(body.ceremony).toMatchObject({
      kind: "registration",
      purpose: "account.create",
      state: "pending",
      revision: 1
    });
    expect(body.options.user).toMatchObject({
      name: "signup_e2e",
      displayName: "Signup E2E"
    });
    expect(response.headers["cache-control"]).toContain("no-store");

    const authenticatedAdd = await app.inject({ method: "POST", url: REGISTRATION_ROUTE });
    const login = await app.inject({ method: "POST", url: PASSKEY_INTERNAL_LOGIN_OPTIONS_PATH });
    expect([authenticatedAdd.statusCode, login.statusCode]).toEqual([404, 404]);

    const openapi = await app.inject({ method: "GET", url: "/openapi.json" });
    expect(openapi.json().paths).toHaveProperty(PASSKEY_INTERNAL_SIGNUP_OPTIONS_PATH);
    expect(openapi.json().paths).toHaveProperty(PASSKEY_INTERNAL_SIGNUP_VERIFY_PATH);
    const capabilities = await app.inject({ method: "GET", url: "/v1/capabilities" });
    expect(capabilities.headers["cache-control"]).toBe("no-store");
    expect(capabilities.json().features.passkeys).toBe(false);
  });

  it("rejects injected partial or unencrypted signup composition", async () => {
    await expect(buildApp({
      config: testConfig({
        passkeyInternalSignupRoutesEnabled: true,
        passkeySignupAuthorizationSecret: PASSKEY_SIGNUP_AUTHORIZATION_SECRET
      }),
      logger: false
    })).rejects.toThrow("must be configured together");
    await expect(buildApp({
      config: testConfig({
        passkeyInternalSignupRoutesEnabled: true,
        passkeySignupAuthorizationSecret: PASSKEY_SIGNUP_AUTHORIZATION_SECRET,
        passkeySignupRefreshKeys: { "signup.v1": PASSKEY_SIGNUP_REFRESH_KEY },
        activePasskeySignupRefreshKeyId: "signup.v1"
      }),
      logger: false
    })).rejects.toThrow("requires an active data-encryption key");
    await expect(buildApp({
      config: testConfig({
        ...signupConfig(),
        accessTokenTtlSeconds: 600
      }),
      logger: false
    })).rejects.toThrow("must be at least 601 seconds");
    await expect(buildApp({
      config: testConfig({
        ...signupConfig(),
        passkeySignupAuthorizationSecret: "too-short"
      }),
      logger: false
    })).rejects.toThrow("must be at least 32 bytes");
    await expect(buildApp({
      config: testConfig({
        ...signupConfig(),
        activePasskeySignupRefreshKeyId: "signup.missing"
      }),
      logger: false
    })).rejects.toThrow("invalid passkey signup refresh configuration");
  });

  it("rejects injected signup key reuse and duplicate rotation roots", async () => {
    await expect(buildApp({
      config: testConfig({
        ...signupConfig(),
        passkeySignupAuthorizationSecret: PASSKEY_SIGNUP_REFRESH_KEY
      }),
      logger: false
    })).rejects.toThrow("independent key material");
    await expect(buildApp({
      config: testConfig({
        ...signupConfig(),
        passkeyBootstrapRefreshKeys: { "login.v1": PASSKEY_REFRESH_KEY },
        activePasskeyBootstrapRefreshKeyId: "login.v1",
        passkeySignupAuthorizationSecret: PASSKEY_REFRESH_KEY
      }),
      logger: false
    })).rejects.toThrow("independent key material");
    await expect(buildApp({
      config: testConfig({
        ...signupConfig(),
        passkeySignupAuthorizationSecret: DATA_ENCRYPTION_KEY
      }),
      logger: false
    })).rejects.toThrow("independent key material");
    await expect(buildApp({
      config: testConfig({
        ...signupConfig(),
        passkeySignupRefreshKeys: {
          "signup.old": PASSKEY_SIGNUP_REFRESH_KEY,
          "signup.active": PASSKEY_SIGNUP_REFRESH_KEY
        },
        activePasskeySignupRefreshKeyId: "signup.active"
      }),
      logger: false
    })).rejects.toThrow("independent key material");
    const jwtSecret = testConfig().jwtSecret;
    await expect(buildApp({
      config: testConfig({
        ...signupConfig(),
        passkeySignupRefreshKeys: { "signup.v1": jwtSecret }
      }),
      logger: false
    })).rejects.toThrow("independent key material");
  });

  it("runs signup expiry at startup and periodically, then clears the timer on close", async () => {
    const listExpired = vi.spyOn(
      SqliteStore.prototype,
      "listExpiredPendingPasskeySignupIntents"
    );
    const intervals = vi.spyOn(globalThis, "setInterval");
    const cleared = vi.spyOn(globalThis, "clearInterval");
    app = await buildApp({ config: testConfig(), logger: false });
    expect(listExpired).toHaveBeenCalledTimes(1);

    const cleanupIndex = intervals.mock.calls.findIndex((call) => call[1] === 10 * 60_000);
    expect(cleanupIndex).toBeGreaterThanOrEqual(0);
    const cleanupCall = intervals.mock.calls[cleanupIndex];
    const cleanupHandle = intervals.mock.results[cleanupIndex]?.value;
    if (cleanupCall === undefined || cleanupHandle === undefined) {
      throw new Error("missing cleanup interval evidence");
    }
    const cleanup = cleanupCall[0] as () => void;
    cleanup();
    await new Promise<void>((resolve) => { setImmediate(resolve); });
    expect(listExpired).toHaveBeenCalledTimes(2);

    await app.close();
    app = undefined;
    expect(cleared).toHaveBeenCalledWith(cleanupHandle);
  });

  it("registers the internal route family before ready without advertising it", async () => {
    app = await buildApp({
      config: testConfig({ passkeyInternalRoutesEnabled: true }),
      logger: false
    });
    const unauthenticated = await app.inject({
      method: "POST",
      url: REGISTRATION_ROUTE,
      headers: {
        "idempotency-key": COMMAND_ID,
        "step-up-authorization": "Bearer e30.e30.AAAA"
      },
      payload: {
        clientNonce: CLIENT_NONCE,
        stepUpCeremonyId: STEP_UP_CEREMONY_ID
      }
    });
    expect(unauthenticated.statusCode).toBe(401);
    expect(unauthenticated.headers["cache-control"]).toBe("private, no-store");
    const missingLogin = await app.inject({
      method: "POST",
      url: PASSKEY_INTERNAL_LOGIN_OPTIONS_PATH
    });
    expect(missingLogin.statusCode).toBe(404);
    const missingManagement = await app.inject({
      method: "GET",
      url: AUTHENTICATOR_MANAGEMENT_ROUTE
    });
    expect(missingManagement.statusCode).toBe(401);
    const unauthenticatedRevokeBegin = await app.inject({
      method: "POST",
      url: AUTHENTICATOR_REVOKE_BEGIN_ROUTE
    });
    expect(unauthenticatedRevokeBegin.statusCode).toBe(401);

    const registered = await app.inject({
      method: "POST",
      url: "/v1/auth/register",
      payload: {
        username: "management_gate_user",
        displayName: "Management gate user",
        password: "correct horse battery staple",
        deviceName: "Management gate iPhone"
      }
    });
    expect(registered.statusCode, registered.body).toBe(201);
    const management = await app.inject({
      method: "GET",
      url: AUTHENTICATOR_MANAGEMENT_ROUTE,
      headers: {
        authorization: `Bearer ${registered.json().tokens.accessToken as string}`
      }
    });
    expect(management.statusCode, management.body).toBe(200);
    expect(management.json()).toEqual({ schemaVersion: 1, authenticators: [] });
    expect(management.headers["cache-control"]).toBe("private, no-store");

    const openapi = await app.inject({ method: "GET", url: "/openapi.json" });
    expect(openapi.json().paths).toHaveProperty(AUTHENTICATOR_MANAGEMENT_ROUTE);
    expect(openapi.json().paths).toHaveProperty(AUTHENTICATOR_RESOURCE_OPENAPI_ROUTE);
    expect(openapi.json().paths).toHaveProperty(AUTHENTICATOR_REVOKE_BEGIN_ROUTE);

    const capabilities = await app.inject({ method: "GET", url: "/v1/capabilities" });
    expect(capabilities.json().features.passkeys).toBe(false);
  });

  it("registers identifier-free login only with its dedicated refresh keyring", async () => {
    app = await buildApp({
      config: testConfig({
        passkeyInternalRoutesEnabled: true,
        dataEncryptionKeys: { "data.v1": DATA_ENCRYPTION_KEY },
        activeDataEncryptionKeyId: "data.v1",
        passkeyBootstrapRefreshKeys: { "login.v1": PASSKEY_REFRESH_KEY },
        activePasskeyBootstrapRefreshKeyId: "login.v1"
      }),
      logger: false
    });
    const response = await app.inject({
      method: "POST",
      url: PASSKEY_INTERNAL_LOGIN_OPTIONS_PATH,
      headers: { "idempotency-key": COMMAND_ID },
      payload: {
        clientNonce: CLIENT_NONCE,
        deliveryNonce: DELIVERY_NONCE
      }
    });

    expect(response.statusCode, response.body).toBe(200);
    const body = PasskeyLoginBeginResponseSchema.parse(response.json());
    expect(body.options).not.toHaveProperty("allowCredentials");
    expect(body.bootstrapAuthorization.purpose).toBe("session.create");
    expect(response.headers["cache-control"]).toBe("private, no-store");
    const capabilities = await app.inject({ method: "GET", url: "/v1/capabilities" });
    expect(capabilities.json().features.passkeys).toBe(false);
  });

  it("shares anonymous login admission across one IPv6 /64 without merging another /64", async () => {
    app = await buildApp({
      config: testConfig({
        passkeyInternalRoutesEnabled: true,
        dataEncryptionKeys: { "data.v1": DATA_ENCRYPTION_KEY },
        activeDataEncryptionKeyId: "data.v1",
        passkeyBootstrapRefreshKeys: { "login.v1": PASSKEY_REFRESH_KEY },
        activePasskeyBootstrapRefreshKeyId: "login.v1"
      }),
      logger: false
    });
    for (let suffix = 1; suffix <= 10; suffix += 1) {
      const response = await app.inject({
        method: "POST",
        url: PASSKEY_INTERNAL_LOGIN_OPTIONS_PATH,
        remoteAddress: `2001:db8:abcd:12::${suffix.toString(16)}`,
        payload: {}
      });
      expect(response.statusCode).toBe(400);
    }
    const limited = await app.inject({
      method: "POST",
      url: PASSKEY_INTERNAL_LOGIN_OPTIONS_PATH,
      remoteAddress: "2001:db8:abcd:12:ffff::1",
      payload: {}
    });
    expect(limited.statusCode).toBe(429);

    const otherNetwork = await app.inject({
      method: "POST",
      url: PASSKEY_INTERNAL_LOGIN_OPTIONS_PATH,
      remoteAddress: "2001:db8:abcd:13::1",
      payload: {}
    });
    expect(otherNetwork.statusCode).toBe(400);
  });

  it("rejects an injected half-configured login refresh keyring", async () => {
    await expect(buildApp({
      config: testConfig({
        passkeyInternalRoutesEnabled: true,
        passkeyBootstrapRefreshKeys: { "login.v1": PASSKEY_REFRESH_KEY }
      }),
      logger: false
    })).rejects.toThrow("must be configured together");
  });

  it("fails startup when internal primary login cannot encrypt its challenge", async () => {
    await expect(buildApp({
      config: testConfig({
        passkeyInternalRoutesEnabled: true,
        passkeyBootstrapRefreshKeys: { "login.v1": PASSKEY_REFRESH_KEY },
        activePasskeyBootstrapRefreshKeyId: "login.v1"
      }),
      logger: false
    })).rejects.toThrow("requires an active data-encryption key");
  });

  it("fails startup when access TTL cannot cover login plus recovery", async () => {
    await expect(buildApp({
      config: testConfig({
        passkeyInternalRoutesEnabled: true,
        accessTokenTtlSeconds: 600,
        dataEncryptionKeys: { "data.v1": DATA_ENCRYPTION_KEY },
        activeDataEncryptionKeyId: "data.v1",
        passkeyBootstrapRefreshKeys: { "login.v1": PASSKEY_REFRESH_KEY },
        activePasskeyBootstrapRefreshKeyId: "login.v1"
      }),
      logger: false
    })).rejects.toThrow("must be at least 601 seconds");
  });

  it("does not reflect or log a rejected internal step-up token", async () => {
    let output = "";
    app = await buildApp({
      config: testConfig({ passkeyInternalRoutesEnabled: true }),
      logger: true,
      logStream: { write(message) { output += message; } }
    });
    const registered = await app.inject({
      method: "POST",
      url: "/v1/auth/register",
      payload: {
        username: "passkey_gate_user",
        displayName: "Passkey gate user",
        password: "correct horse battery staple",
        deviceName: "Passkey gate test"
      }
    });
    expect(registered.statusCode).toBe(201);
    const accessToken = registered.json().tokens.accessToken as string;
    const tokenCanary = "e30.e30.Q0FOQVJZX1NURVBfVVBfSEVBREVS";
    const rejected = await app.inject({
      method: "POST",
      url: REGISTRATION_ROUTE,
      headers: {
        authorization: `Bearer ${accessToken}`,
        "idempotency-key": COMMAND_ID,
        "step-up-authorization": `Bearer ${tokenCanary}`
      },
      payload: {
        clientNonce: CLIENT_NONCE,
        stepUpCeremonyId: STEP_UP_CEREMONY_ID
      }
    });
    expect(rejected.statusCode).toBe(403);
    expect(rejected.headers["cache-control"]).toBe("private, no-store");
    expect(rejected.body).not.toContain(tokenCanary);

    await app.close();
    app = undefined;
    expect(output).not.toContain(tokenCanary);
  });

  it("does not reflect or log a rejected bootstrap authorization", async () => {
    let output = "";
    app = await buildApp({
      config: testConfig({
        passkeyInternalRoutesEnabled: true,
        dataEncryptionKeys: { "data.v1": DATA_ENCRYPTION_KEY },
        activeDataEncryptionKeyId: "data.v1",
        passkeyBootstrapRefreshKeys: { "login.v1": PASSKEY_REFRESH_KEY },
        activePasskeyBootstrapRefreshKeyId: "login.v1"
      }),
      logger: true,
      logStream: { write(message) { output += message; } }
    });
    const tokenCanary = "e30.e30.Q0FOQVJZX0JPT1RTVFJBUF9IRUFERVI";
    const rejected = await app.inject({
      method: "POST",
      url: PASSKEY_INTERNAL_LOGIN_VERIFY_PATH,
      headers: {
        "content-type": "application/webauthn+json",
        "idempotency-key": COMMAND_ID,
        "if-match": '"1"',
        "bootstrap-authorization": `Bearer ${tokenCanary}`
      },
      payload: JSON.stringify({
        id: "AQIDBA",
        rawId: "AQIDBA",
        response: {
          clientDataJSON: "e30",
          authenticatorData: "AQID",
          signature: "AQID",
          userHandle: DELIVERY_NONCE
        },
        authenticatorAttachment: "platform",
        clientExtensionResults: {},
        type: "public-key"
      })
    });
    expect(rejected.statusCode).toBe(401);
    expect(rejected.body).not.toContain(tokenCanary);

    await app.close();
    app = undefined;
    expect(output).not.toContain(tokenCanary);
  });
});
