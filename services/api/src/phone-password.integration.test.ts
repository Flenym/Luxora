import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import type { LuxoraApp } from "./app.js";
import { buildApp } from "./app.js";
import type { AppConfig } from "./config.js";
import { testConfig } from "./test-helpers.js";

const DATA_KEY = Buffer.alloc(32, 52).toString("base64url");
const PHONE_HMAC_SECRET = "phone-password-independent-hmac-root-v1";
const DEVELOPMENT_CODE = "482913";
const SECRET_PASSWORD = "correct horse battery staple";

function phoneConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return testConfig({
    dataEncryptionKeys: { "phone-password.v1": DATA_KEY },
    activeDataEncryptionKeyId: "phone-password.v1",
    phoneAuthEnabled: true,
    phoneAuthProvider: "development",
    phoneAuthHmacSecret: PHONE_HMAC_SECRET,
    phoneAuthDevelopmentCode: DEVELOPMENT_CODE,
    ...overrides
  });
}

function authorization(accessToken: string): { authorization: string } {
  return { authorization: `Bearer ${accessToken}` };
}

async function begin(app: LuxoraApp, deviceName: string) {
  const response = await app.inject({
    method: "POST",
    url: "/v1/auth/phone/challenges",
    payload: {
      countryCode: "7",
      nationalNumber: "9991234567",
      deviceName,
      clientNonce: randomUUID()
    }
  });
  expect(response.statusCode, response.body).toBe(201);
  return response.json() as { challengeId: string; maskedPhone: string };
}

async function verify(app: LuxoraApp, challengeId: string, deviceName: string) {
  const payload = {
    code: DEVELOPMENT_CODE,
    deviceName,
    clientNonce: randomUUID()
  };
  const response = await app.inject({
    method: "POST",
    url: `/v1/auth/phone/challenges/${challengeId}/verify`,
    payload
  });
  expect(response.statusCode, response.body).toBe(200);
  return { response, payload };
}

async function registerPhoneAccount(app: LuxoraApp): Promise<{
  accessToken: string;
  userId: string;
  username: string;
}> {
  const challenge = await begin(app, "Initial iPhone");
  const { response: verified } = await verify(
    app,
    challenge.challengeId,
    "Initial iPhone"
  );
  expect(verified.json().status).toBe("profile_required");
  const username = `password_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  const registration = await app.inject({
    method: "POST",
    url: "/v1/auth/phone/registrations",
    payload: {
      registrationToken: verified.json().registrationToken,
      displayName: "Егор",
      username,
      bio: "",
      deviceName: "Initial iPhone",
      clientNonce: randomUUID()
    }
  });
  expect(registration.statusCode, registration.body).toBe(201);
  return {
    accessToken: registration.json().tokens.accessToken as string,
    userId: registration.json().user.id as string,
    username
  };
}

describe("phone OTP optional secret password", () => {
  let app: LuxoraApp | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it("requires the configured password after a correct OTP and can disable it safely", async () => {
    app = await buildApp({ config: phoneConfig(), logger: false });
    const account = await registerPhoneAccount(app);

    const unauthenticatedStatus = await app.inject({
      method: "GET",
      url: "/v1/me/phone-password"
    });
    expect(unauthenticatedStatus.statusCode).toBe(401);

    const initialStatus = await app.inject({
      method: "GET",
      url: "/v1/me/phone-password",
      headers: authorization(account.accessToken)
    });
    expect(initialStatus.json()).toEqual({ eligible: true, enabled: false });

    const enabled = await app.inject({
      method: "PUT",
      url: "/v1/me/phone-password",
      headers: authorization(account.accessToken),
      payload: { password: SECRET_PASSWORD }
    });
    expect(enabled.statusCode, enabled.body).toBe(200);
    expect(enabled.json()).toEqual({ eligible: true, enabled: true });
    expect(enabled.body).not.toContain(SECRET_PASSWORD);

    const otpBypassAttempt = await app.inject({
      method: "POST",
      url: "/v1/auth/login",
      payload: {
        username: account.username,
        password: SECRET_PASSWORD,
        deviceName: "OTP bypass attempt"
      }
    });
    expect(otpBypassAttempt.statusCode).toBe(401);

    const missingCurrentPassword = await app.inject({
      method: "PUT",
      url: "/v1/me/phone-password",
      headers: authorization(account.accessToken),
      payload: { password: "another correct battery phrase" }
    });
    expect(missingCurrentPassword.statusCode).toBe(401);

    const challenge = await begin(app, "Replacement iPhone");
    const verificationPayload = {
      code: DEVELOPMENT_CODE,
      deviceName: "Replacement iPhone",
      clientNonce: randomUUID()
    };
    const passwordRequired = await app.inject({
      method: "POST",
      url: `/v1/auth/phone/challenges/${challenge.challengeId}/verify`,
      payload: verificationPayload
    });
    expect(passwordRequired.statusCode, passwordRequired.body).toBe(200);
    expect(passwordRequired.json()).toMatchObject({
      status: "password_required",
      maskedPhone: challenge.maskedPhone
    });
    expect(passwordRequired.json()).not.toHaveProperty("tokens");
    expect(passwordRequired.json()).not.toHaveProperty("user");
    const passwordToken = passwordRequired.json().passwordToken as string;

    const verificationReplay = await app.inject({
      method: "POST",
      url: `/v1/auth/phone/challenges/${challenge.challengeId}/verify`,
      payload: verificationPayload
    });
    expect(verificationReplay.json()).toEqual(passwordRequired.json());

    const wrongPasswordPayload = {
      passwordToken,
      password: "wrong password",
      deviceName: "Replacement iPhone",
      clientNonce: randomUUID()
    };
    const wrongPassword = await app.inject({
      method: "POST",
      url: "/v1/auth/phone/password",
      payload: wrongPasswordPayload
    });
    const wrongPasswordReplay = await app.inject({
      method: "POST",
      url: "/v1/auth/phone/password",
      payload: wrongPasswordPayload
    });
    expect(wrongPassword.statusCode).toBe(401);
    expect(wrongPassword.json()).toMatchObject({
      error: { code: "PHONE_AUTH_PASSWORD_INVALID" }
    });
    expect(wrongPasswordReplay.json().error.code).toBe("PHONE_AUTH_PASSWORD_INVALID");

    const completionPayload = {
      passwordToken,
      password: SECRET_PASSWORD,
      deviceName: "Replacement iPhone",
      clientNonce: randomUUID()
    };
    const authenticated = await app.inject({
      method: "POST",
      url: "/v1/auth/phone/password",
      payload: completionPayload
    });
    const authenticatedReplay = await app.inject({
      method: "POST",
      url: "/v1/auth/phone/password",
      payload: completionPayload
    });
    expect(authenticated.statusCode, authenticated.body).toBe(200);
    expect(authenticated.json()).toMatchObject({
      status: "authenticated",
      user: { id: account.userId },
      tokens: { tokenType: "Bearer" }
    });
    expect(authenticatedReplay.json()).toEqual(authenticated.json());
    expect(authenticated.body).not.toContain(SECRET_PASSWORD);

    const wrongDisable = await app.inject({
      method: "DELETE",
      url: "/v1/me/phone-password",
      headers: authorization(authenticated.json().tokens.accessToken as string),
      payload: { currentPassword: "wrong password" }
    });
    expect(wrongDisable.statusCode).toBe(401);

    const disabled = await app.inject({
      method: "DELETE",
      url: "/v1/me/phone-password",
      headers: authorization(authenticated.json().tokens.accessToken as string),
      payload: { currentPassword: SECRET_PASSWORD }
    });
    expect(disabled.statusCode, disabled.body).toBe(200);
    expect(disabled.json()).toEqual({ eligible: true, enabled: false });

    const directChallenge = await begin(app, "Third iPhone");
    const { response: directAuthentication } = await verify(
      app,
      directChallenge.challengeId,
      "Third iPhone"
    );
    expect(directAuthentication.json()).toMatchObject({
      status: "authenticated",
      user: { id: account.userId }
    });
  }, 30_000);

  it("locks the continuation grant after bounded distinct password failures", async () => {
    const config = phoneConfig({ phoneAuthMaxAttempts: 3 });
    app = await buildApp({ config, logger: false });
    const account = await registerPhoneAccount(app);
    const enabled = await app.inject({
      method: "PUT",
      url: "/v1/me/phone-password",
      headers: authorization(account.accessToken),
      payload: { password: SECRET_PASSWORD }
    });
    expect(enabled.statusCode, enabled.body).toBe(200);

    const challenge = await begin(app, "Locked iPhone");
    const { response: passwordRequired } = await verify(
      app,
      challenge.challengeId,
      "Locked iPhone"
    );
    const passwordToken = passwordRequired.json().passwordToken as string;
    let finalPayload: Record<string, string> | undefined;
    for (let index = 0; index < config.phoneAuthMaxAttempts; index += 1) {
      const payload = {
        passwordToken,
        password: `wrong password ${index}`,
        deviceName: "Locked iPhone",
        clientNonce: randomUUID()
      };
      const rejected = await app.inject({
        method: "POST",
        url: "/v1/auth/phone/password",
        payload
      });
      expect(rejected.statusCode).toBe(401);
      expect(rejected.json().error.code).toBe(
        index + 1 === config.phoneAuthMaxAttempts
          ? "PHONE_AUTH_PASSWORD_ATTEMPTS_EXHAUSTED"
          : "PHONE_AUTH_PASSWORD_INVALID"
      );
      if (index + 1 === config.phoneAuthMaxAttempts) finalPayload = payload;
    }

    if (finalPayload === undefined) throw new Error("Expected a terminal password attempt");
    const exhaustedReplay = await app.inject({
      method: "POST",
      url: "/v1/auth/phone/password",
      payload: finalPayload
    });
    expect(exhaustedReplay.json().error.code).toBe(
      "PHONE_AUTH_PASSWORD_ATTEMPTS_EXHAUSTED"
    );
    const afterLock = await app.inject({
      method: "POST",
      url: "/v1/auth/phone/password",
      payload: {
        passwordToken,
        password: SECRET_PASSWORD,
        deviceName: "Locked iPhone",
        clientNonce: randomUUID()
      }
    });
    expect(afterLock.statusCode).toBe(401);
    expect(afterLock.json().error.code).toBe("PHONE_AUTH_PASSWORD_TOKEN_INVALID");
  }, 30_000);
});
