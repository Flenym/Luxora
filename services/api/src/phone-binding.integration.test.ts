import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import type { LuxoraApp } from "./app.js";
import { buildApp } from "./app.js";
import type { AppConfig } from "./config.js";
import { testConfig } from "./test-helpers.js";

const DATA_KEY = Buffer.alloc(32, 54).toString("base64url");
const PHONE_HMAC_SECRET = "phone-binding-independent-hmac-root-v1";
const DEVELOPMENT_CODE = "246813";
const PASSWORD = "binding legacy test password";

function bindingConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return testConfig({
    dataEncryptionKeys: { "phone-binding.v1": DATA_KEY },
    activeDataEncryptionKeyId: "phone-binding.v1",
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

async function registerLegacyAccount(app: LuxoraApp): Promise<{
  accessToken: string;
  userId: string;
  username: string;
}> {
  const username = `legacy_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  const registered = await app.inject({
    method: "POST",
    url: "/v1/auth/register",
    payload: { username, displayName: "Legacy", password: PASSWORD }
  });
  expect(registered.statusCode, registered.body).toBe(201);
  return {
    accessToken: registered.json().tokens.accessToken as string,
    userId: registered.json().user.id as string,
    username
  };
}

async function beginBinding(
  app: LuxoraApp,
  accessToken: string,
  nationalNumber = "9250001122",
  clientNonce = randomUUID()
) {
  const response = await app.inject({
    method: "POST",
    url: "/v1/me/phone/binding/challenges",
    headers: authorization(accessToken),
    payload: {
      countryCode: "7",
      nationalNumber,
      deviceName: "Binding iPhone",
      clientNonce
    }
  });
  return { response, clientNonce };
}

async function verifyBinding(
  app: LuxoraApp,
  challengeId: string,
  clientNonce = randomUUID()
) {
  return app.inject({
    method: "POST",
    url: `/v1/auth/phone/challenges/${challengeId}/verify`,
    payload: { code: DEVELOPMENT_CODE, deviceName: "Binding iPhone", clientNonce }
  });
}

describe("phone binding for legacy accounts", () => {
  let app: LuxoraApp | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it("binds a phone number to a legacy password account and enables phone login", async () => {
    app = await buildApp({ config: bindingConfig(), logger: false });
    const account = await registerLegacyAccount(app);

    const unauthenticated = await beginBinding(app, "invalid-token");
    expect(unauthenticated.response.statusCode).toBe(401);

    const initialStatus = await app.inject({
      method: "GET",
      url: "/v1/me/phone-password",
      headers: authorization(account.accessToken)
    });
    expect(initialStatus.json()).toEqual({ eligible: false, enabled: false });

    const begin = await beginBinding(app, account.accessToken);
    expect(begin.response.statusCode, begin.response.body).toBe(201);
    const challenge = begin.response.json() as {
      challengeId: string;
      maskedPhone: string;
    };
    expect(challenge.maskedPhone).toBe("+7 ••• ••• 11 22");

    const beginReplay = await beginBinding(
      app,
      account.accessToken,
      "9250001122",
      begin.clientNonce
    );
    expect(beginReplay.response.json()).toEqual(challenge);

    const wrongCode = await app.inject({
      method: "POST",
      url: `/v1/auth/phone/challenges/${challenge.challengeId}/verify`,
      payload: { code: "000000", deviceName: "Binding iPhone", clientNonce: randomUUID() }
    });
    expect(wrongCode.statusCode).toBe(401);
    expect(wrongCode.json().error.code).toBe("PHONE_AUTH_CODE_INVALID");

    const verified = await verifyBinding(app, challenge.challengeId);
    expect(verified.statusCode, verified.body).toBe(200);
    expect(verified.json()).toMatchObject({
      status: "binding_verified",
      maskedPhone: challenge.maskedPhone
    });

    const verifiedReplay = await verifyBinding(app, challenge.challengeId);
    expect(verifiedReplay.statusCode).toBe(401);
    expect(verifiedReplay.json().error.code).toBe("PHONE_AUTH_BINDING_CHALLENGE_INVALID");

    const foreignToken = await app.inject({
      method: "POST",
      url: "/v1/me/phone/binding/complete",
      headers: authorization(account.accessToken),
      payload: { bindingToken: `luxbt_${"C".repeat(43)}`, clientNonce: randomUUID() }
    });
    expect(foreignToken.statusCode).toBe(401);

    const completed = await app.inject({
      method: "POST",
      url: "/v1/me/phone/binding/complete",
      headers: authorization(account.accessToken),
      payload: {
        bindingToken: verified.json().bindingToken as string,
        clientNonce: randomUUID()
      }
    });
    expect(completed.statusCode, completed.body).toBe(200);
    expect(completed.json()).toEqual({
      phonePassword: { eligible: true, enabled: false }
    });

    const status = await app.inject({
      method: "GET",
      url: "/v1/me/phone-password",
      headers: authorization(account.accessToken)
    });
    expect(status.json()).toEqual({ eligible: true, enabled: false });

    const phoneLogin = await app.inject({
      method: "POST",
      url: "/v1/auth/phone/challenges",
      payload: {
        countryCode: "7",
        nationalNumber: "9250001122",
        deviceName: "New iPhone",
        clientNonce: randomUUID()
      }
    });
    expect(phoneLogin.statusCode, phoneLogin.body).toBe(201);
    const phoneVerified = await app.inject({
      method: "POST",
      url: `/v1/auth/phone/challenges/${phoneLogin.json().challengeId as string}/verify`,
      payload: { code: DEVELOPMENT_CODE, deviceName: "New iPhone", clientNonce: randomUUID() }
    });
    expect(phoneVerified.json()).toMatchObject({
      status: "authenticated",
      user: { id: account.userId }
    });
  }, 60_000);

  it("rejects binding a phone that is already owned by another account and never rebinds", async () => {
    app = await buildApp({ config: bindingConfig(), logger: false });
    const owner = await registerLegacyAccount(app);
    const begin = await beginBinding(app, owner.accessToken, "9257778899");
    expect(begin.response.statusCode, begin.response.body).toBe(201);
    const verified = await verifyBinding(
      app,
      begin.response.json().challengeId as string
    );
    expect(verified.statusCode, verified.body).toBe(200);
    const completed = await app.inject({
      method: "POST",
      url: "/v1/me/phone/binding/complete",
      headers: authorization(owner.accessToken),
      payload: {
        bindingToken: verified.json().bindingToken as string,
        clientNonce: randomUUID()
      }
    });
    expect(completed.statusCode, completed.body).toBe(200);

    const attacker = await registerLegacyAccount(app);
    const stillBound = await app.inject({
      method: "GET",
      url: "/v1/me/phone-password",
      headers: authorization(attacker.accessToken)
    });
    expect(stillBound.json()).toEqual({ eligible: false, enabled: false });

    const attackerBegin = await beginBinding(app, attacker.accessToken, "9257778899");
    expect(attackerBegin.response.statusCode, attackerBegin.response.body).toBe(201);
    const attackerVerified = await verifyBinding(
      app,
      attackerBegin.response.json().challengeId as string
    );
    expect(attackerVerified.statusCode, attackerVerified.body).toBe(200);
    const attackerComplete = await app.inject({
      method: "POST",
      url: "/v1/me/phone/binding/complete",
      headers: authorization(attacker.accessToken),
      payload: {
        bindingToken: attackerVerified.json().bindingToken as string,
        clientNonce: randomUUID()
      }
    });
    expect(attackerComplete.statusCode, attackerComplete.body).toBe(409);

    const attackerStatus = await app.inject({
      method: "GET",
      url: "/v1/me/phone-password",
      headers: authorization(attacker.accessToken)
    });
    expect(attackerStatus.json()).toEqual({ eligible: false, enabled: false });
  }, 60_000);

  it("rejects a second binding attempt for an account that already owns a phone", async () => {
    app = await buildApp({ config: bindingConfig(), logger: false });
    const account = await registerLegacyAccount(app);
    const first = await beginBinding(app, account.accessToken, "9253334455");
    expect(first.response.statusCode, first.response.body).toBe(201);
    const verified = await verifyBinding(
      app,
      first.response.json().challengeId as string
    );
    expect(verified.statusCode, verified.body).toBe(200);
    const completed = await app.inject({
      method: "POST",
      url: "/v1/me/phone/binding/complete",
      headers: authorization(account.accessToken),
      payload: {
        bindingToken: verified.json().bindingToken as string,
        clientNonce: randomUUID()
      }
    });
    expect(completed.statusCode, completed.body).toBe(200);

    const second = await beginBinding(app, account.accessToken, "9256667788");
    expect(second.response.statusCode, second.response.body).toBe(409);
  }, 60_000);

  it("exhausts binding verification attempts and locks the challenge", async () => {
    const config = bindingConfig({ phoneAuthMaxAttempts: 3 });
    app = await buildApp({ config, logger: false });
    const account = await registerLegacyAccount(app);
    const begin = await beginBinding(app, account.accessToken, "9259990011");
    expect(begin.response.statusCode, begin.response.body).toBe(201);
    const challengeId = begin.response.json().challengeId as string;

    for (let index = 0; index < config.phoneAuthMaxAttempts; index += 1) {
      const rejected = await app.inject({
        method: "POST",
        url: `/v1/auth/phone/challenges/${challengeId}/verify`,
        payload: {
          code: `00000${index}`,
          deviceName: "Binding iPhone",
          clientNonce: randomUUID()
        }
      });
      expect(rejected.statusCode).toBe(401);
      expect(rejected.json().error.code).toBe(
        index + 1 === config.phoneAuthMaxAttempts
          ? "PHONE_AUTH_ATTEMPTS_EXHAUSTED"
          : "PHONE_AUTH_CODE_INVALID"
      );
    }

    const afterLock = await app.inject({
      method: "POST",
      url: `/v1/auth/phone/challenges/${challengeId}/verify`,
      payload: { code: DEVELOPMENT_CODE, deviceName: "Binding iPhone", clientNonce: randomUUID() }
    });
    expect(afterLock.statusCode).toBe(401);
    expect(afterLock.json().error.code).toBe("PHONE_AUTH_ATTEMPTS_EXHAUSTED");
  }, 60_000);
});
