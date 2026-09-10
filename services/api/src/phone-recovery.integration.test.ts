import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import type { LuxoraApp } from "./app.js";
import { buildApp } from "./app.js";
import type { AppConfig } from "./config.js";
import { testConfig } from "./test-helpers.js";

const DATA_KEY = Buffer.alloc(32, 53).toString("base64url");
const PHONE_HMAC_SECRET = "phone-recovery-independent-hmac-root-v1";
const DEVELOPMENT_CODE = "571948";
const SECRET_PASSWORD = "steady river climbs the hill";
const REPLACEMENT_PASSWORD = "quiet meadow keeps the rain";

function phoneConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return testConfig({
    dataEncryptionKeys: { "phone-recovery.v1": DATA_KEY },
    activeDataEncryptionKeyId: "phone-recovery.v1",
    phoneAuthEnabled: true,
    phoneAuthProvider: "development",
    phoneAuthHmacSecret: PHONE_HMAC_SECRET,
    phoneAuthDevelopmentCode: DEVELOPMENT_CODE,
    phoneAuthRecoveryDelaySeconds: 0,
    phoneAuthRecoveryTtlSeconds: 600,
    phoneAuthRetryAfterSeconds: 30,
    ...overrides
  });
}

function authorization(accessToken: string): { authorization: string } {
  return { authorization: `Bearer ${accessToken}` };
}

async function registerPhoneAccount(app: LuxoraApp): Promise<{
  accessToken: string;
  userId: string;
}> {
  const begin = await app.inject({
    method: "POST",
    url: "/v1/auth/phone/challenges",
    payload: {
      countryCode: "7",
      nationalNumber: "9118675309",
      deviceName: "Recovery iPhone",
      clientNonce: randomUUID()
    }
  });
  expect(begin.statusCode, begin.body).toBe(201);
  const verified = await app.inject({
    method: "POST",
    url: `/v1/auth/phone/challenges/${begin.json().challengeId as string}/verify`,
    payload: { code: DEVELOPMENT_CODE, deviceName: "Recovery iPhone", clientNonce: randomUUID() }
  });
  expect(verified.statusCode, verified.body).toBe(200);
  expect(verified.json().status).toBe("profile_required");
  const registered = await app.inject({
    method: "POST",
    url: "/v1/auth/phone/registrations",
    payload: {
      registrationToken: verified.json().registrationToken as string,
      displayName: "Восстановление",
      username: `recovery_${randomUUID().replaceAll("-", "").slice(0, 12)}`,
      bio: "",
      deviceName: "Recovery iPhone",
      clientNonce: randomUUID()
    }
  });
  expect(registered.statusCode, registered.body).toBe(201);
  return {
    accessToken: registered.json().tokens.accessToken as string,
    userId: registered.json().user.id as string
  };
}

async function passwordChallenge(app: LuxoraApp): Promise<string> {
  const begin = await app.inject({
    method: "POST",
    url: "/v1/auth/phone/challenges",
    payload: {
      countryCode: "7",
      nationalNumber: "9118675309",
      deviceName: "Lost iPhone",
      clientNonce: randomUUID()
    }
  });
  expect(begin.statusCode, begin.body).toBe(201);
  const verified = await app.inject({
    method: "POST",
    url: `/v1/auth/phone/challenges/${begin.json().challengeId as string}/verify`,
    payload: { code: DEVELOPMENT_CODE, deviceName: "Lost iPhone", clientNonce: randomUUID() }
  });
  expect(verified.json().status).toBe("password_required");
  return verified.json().passwordToken as string;
}

describe("phone password recovery", () => {
  let app: LuxoraApp | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it("recovers a lost secret password after the confirmation window and revokes old sessions", async () => {
    app = await buildApp({ config: phoneConfig(), logger: false });
    const account = await registerPhoneAccount(app);
    const enabled = await app.inject({
      method: "PUT",
      url: "/v1/me/phone-password",
      headers: authorization(account.accessToken),
      payload: { password: SECRET_PASSWORD }
    });
    expect(enabled.statusCode, enabled.body).toBe(200);

    const invalidToken = await app.inject({
      method: "POST",
      url: "/v1/auth/phone/recovery/start",
      payload: { passwordToken: `luxpw_${"A".repeat(43)}`, clientNonce: randomUUID() }
    });
    expect(invalidToken.statusCode).toBe(401);
    expect(invalidToken.json().error.code).toBe("PHONE_AUTH_PASSWORD_TOKEN_INVALID");

    const passwordToken = await passwordChallenge(app);
    const startPayload = { passwordToken, clientNonce: randomUUID() };
    const started = await app.inject({
      method: "POST",
      url: "/v1/auth/phone/recovery/start",
      payload: startPayload
    });
    expect(started.statusCode, started.body).toBe(201);
    expect(started.json()).toMatchObject({ maskedPhone: "+7 ••• ••• 53 09" });
    expect(started.body).not.toContain(SECRET_PASSWORD);

    const startedReplay = await app.inject({
      method: "POST",
      url: "/v1/auth/phone/recovery/start",
      payload: startPayload
    });
    expect(startedReplay.json()).toEqual(started.json());

    const conflictingNonce = await app.inject({
      method: "POST",
      url: "/v1/auth/phone/recovery/start",
      payload: { passwordToken, clientNonce: startPayload.clientNonce }
    });
    expect(conflictingNonce.statusCode).toBe(201);
    expect(conflictingNonce.json()).toEqual(started.json());

    const secondStart = await app.inject({
      method: "POST",
      url: "/v1/auth/phone/recovery/start",
      payload: { passwordToken, clientNonce: randomUUID() }
    });
    expect(secondStart.statusCode, secondStart.body).toBe(409);

    const completePayload = {
      recoveryToken: started.json().recoveryToken as string,
      password: REPLACEMENT_PASSWORD,
      deviceName: "Recovered iPhone",
      clientNonce: randomUUID()
    };
    const completed = await app.inject({
      method: "POST",
      url: "/v1/auth/phone/recovery/complete",
      payload: completePayload
    });
    expect(completed.statusCode, completed.body).toBe(200);
    expect(completed.json()).toMatchObject({
      status: "authenticated",
      user: { id: account.userId }
    });

    const completedReplay = await app.inject({
      method: "POST",
      url: "/v1/auth/phone/recovery/complete",
      payload: completePayload
    });
    expect(completedReplay.json()).toEqual(completed.json());

    const changedInput = await app.inject({
      method: "POST",
      url: "/v1/auth/phone/recovery/complete",
      payload: { ...completePayload, password: "another quiet meadow value" }
    });
    expect(changedInput.statusCode).toBe(409);

    const consumedToken = await app.inject({
      method: "POST",
      url: "/v1/auth/phone/recovery/complete",
      payload: {
        recoveryToken: completePayload.recoveryToken,
        password: REPLACEMENT_PASSWORD,
        deviceName: "Recovered iPhone",
        clientNonce: randomUUID()
      }
    });
    expect(consumedToken.statusCode).toBe(401);
    expect(consumedToken.json().error.code).toBe("PHONE_AUTH_RECOVERY_TOKEN_INVALID");

    const oldSession = await app.inject({
      method: "GET",
      url: "/v1/me",
      headers: authorization(account.accessToken)
    });
    expect(oldSession.statusCode).toBe(401);

    const newPasswordSession = await app.inject({
      method: "GET",
      url: "/v1/me",
      headers: authorization(completed.json().tokens.accessToken as string)
    });
    expect(newPasswordSession.statusCode, newPasswordSession.body).toBe(200);

    // The original login challenge stays verified after recovery, so the new
    // password is proven through the same continuation grant without a second
    // begin (which would hit the per-phone resend window).
    const oldPassword = await app.inject({
      method: "POST",
      url: "/v1/auth/phone/password",
      payload: {
        passwordToken,
        password: SECRET_PASSWORD,
        deviceName: "Recovered iPhone",
        clientNonce: randomUUID()
      }
    });
    expect(oldPassword.statusCode).toBe(401);
    expect(oldPassword.json().error.code).toBe("PHONE_AUTH_PASSWORD_INVALID");

    const newPassword = await app.inject({
      method: "POST",
      url: "/v1/auth/phone/password",
      payload: {
        passwordToken,
        password: REPLACEMENT_PASSWORD,
        deviceName: "Recovered iPhone",
        clientNonce: randomUUID()
      }
    });
    expect(newPassword.statusCode, newPassword.body).toBe(200);
    expect(newPassword.json()).toMatchObject({
      status: "authenticated",
      user: { id: account.userId }
    });
  }, 60_000);

  it("rejects completion before confirmAt with a bounded retry hint", async () => {
    app = await buildApp({
      config: phoneConfig({ phoneAuthRecoveryDelaySeconds: 60 }),
      logger: false
    });
    const account = await registerPhoneAccount(app);
    const enabled = await app.inject({
      method: "PUT",
      url: "/v1/me/phone-password",
      headers: authorization(account.accessToken),
      payload: { password: SECRET_PASSWORD }
    });
    expect(enabled.statusCode, enabled.body).toBe(200);
    const passwordToken = await passwordChallenge(app);
    const started = await app.inject({
      method: "POST",
      url: "/v1/auth/phone/recovery/start",
      payload: { passwordToken, clientNonce: randomUUID() }
    });
    expect(started.statusCode, started.body).toBe(201);
    const confirmAt = Date.parse(started.json().confirmAt as string);
    const expiresAt = Date.parse(started.json().expiresAt as string);
    expect(expiresAt - confirmAt).toBe(600_000);

    const early = await app.inject({
      method: "POST",
      url: "/v1/auth/phone/recovery/complete",
      payload: {
        recoveryToken: started.json().recoveryToken as string,
        password: REPLACEMENT_PASSWORD,
        deviceName: "Early iPhone",
        clientNonce: randomUUID()
      }
    });
    expect(early.statusCode, early.body).toBe(403);
    expect(early.json().error.code).toBe("PHONE_AUTH_RECOVERY_NOT_CONFIRMABLE");
    expect(early.json().error.details.retryAfterSeconds).toBeGreaterThan(0);
    expect(early.body).not.toContain(SECRET_PASSWORD);

    const earlyReplay = await app.inject({
      method: "POST",
      url: "/v1/auth/phone/recovery/complete",
      payload: {
        recoveryToken: started.json().recoveryToken as string,
        password: REPLACEMENT_PASSWORD,
        deviceName: "Early iPhone",
        clientNonce: randomUUID()
      }
    });
    expect(earlyReplay.statusCode).toBe(403);

    const invalidToken = await app.inject({
      method: "POST",
      url: "/v1/auth/phone/recovery/complete",
      payload: {
        recoveryToken: `luxrc_${"B".repeat(43)}`,
        password: REPLACEMENT_PASSWORD,
        deviceName: "Early iPhone",
        clientNonce: randomUUID()
      }
    });
    expect(invalidToken.statusCode).toBe(401);
    expect(invalidToken.json().error.code).toBe("PHONE_AUTH_RECOVERY_TOKEN_INVALID");

    const status = await app.inject({
      method: "GET",
      url: "/v1/me/phone-password",
      headers: authorization(account.accessToken)
    });
    expect(status.statusCode).toBe(200);
    expect(status.json()).toEqual({ eligible: true, enabled: true });
  }, 60_000);
});
