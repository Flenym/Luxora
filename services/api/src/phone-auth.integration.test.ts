import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import type { LuxoraApp } from "./app.js";
import { buildApp } from "./app.js";
import type { AppConfig } from "./config.js";
import { contentCipherFromConfig } from "./infrastructure/content-cipher.js";
import { SqliteStore } from "./infrastructure/sqlite-store.js";
import { testConfig } from "./test-helpers.js";

const DATA_KEY = Buffer.alloc(32, 41).toString("base64url");
const PHONE_HMAC_SECRET = "independent-phone-authentication-hmac-root-v1";
const DEVELOPMENT_CODE = "482913";

function phoneConfig(overrides: Partial<AppConfig> = {}) {
  return testConfig({
    dataEncryptionKeys: { "phone-data.v1": DATA_KEY },
    activeDataEncryptionKeyId: "phone-data.v1",
    phoneAuthEnabled: true,
    phoneAuthProvider: "development",
    phoneAuthHmacSecret: PHONE_HMAC_SECRET,
    phoneAuthDevelopmentCode: DEVELOPMENT_CODE,
    ...overrides
  });
}

function beginPayload(clientNonce = randomUUID()) {
  return {
    countryCode: "7",
    nationalNumber: "9991234567",
    deviceName: "Egor’s iPhone",
    clientNonce
  };
}

describe("phone-first authentication", () => {
  let app: LuxoraApp | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it("is unadvertised and fails closed when delivery is not configured", async () => {
    app = await buildApp({ config: testConfig(), logger: false });
    const capabilities = await app.inject({ method: "GET", url: "/v1/capabilities" });
    expect(capabilities.statusCode).toBe(200);
    expect(capabilities.json().features.phoneAuthentication).toBe(false);

    const unavailable = await app.inject({
      method: "POST",
      url: "/v1/auth/phone/challenges",
      payload: beginPayload()
    });
    expect(unavailable.statusCode).toBe(503);
    expect(unavailable.json()).toMatchObject({
      error: { code: "SERVICE_UNAVAILABLE" }
    });
  });

  it("reasserts phone secret isolation for callers that inject parsed configuration", async () => {
    await expect(buildApp({
      config: phoneConfig({
        passkeyBootstrapRefreshKeys: {
          shared: PHONE_HMAC_SECRET
        },
        activePasskeyBootstrapRefreshKeyId: "shared"
      }),
      logger: false
    })).rejects.toThrow("independent HMAC key material");
    await expect(buildApp({
      config: phoneConfig({ phoneAuthHmacSecret: "too-short" }),
      logger: false
    })).rejects.toThrow("at least 32 bytes");
    await expect(buildApp({
      config: phoneConfig({ phoneAuthDevelopmentCode: "12345x" }),
      logger: false
    })).rejects.toThrow("exactly six digits");
  });

  it("registers a new phone, checks username alternatives, replays exact tokens, and logs in", async () => {
    app = await buildApp({ config: phoneConfig(), logger: false });
    const capabilities = await app.inject({ method: "GET", url: "/v1/capabilities" });
    expect(capabilities.json().features.phoneAuthentication).toBe(true);

    const begin = beginPayload();
    const challenge = await app.inject({
      method: "POST",
      url: "/v1/auth/phone/challenges",
      payload: begin
    });
    expect(challenge.statusCode, challenge.body).toBe(201);
    expect(challenge.body).not.toContain(DEVELOPMENT_CODE);
    expect(challenge.body).not.toContain(begin.nationalNumber);
    const challengeBody = challenge.json();

    const beginReplay = await app.inject({
      method: "POST",
      url: "/v1/auth/phone/challenges",
      payload: begin
    });
    expect(beginReplay.statusCode).toBe(201);
    expect(beginReplay.json()).toEqual(challengeBody);
    const changedNonceReuse = await app.inject({
      method: "POST",
      url: "/v1/auth/phone/challenges",
      payload: { ...begin, nationalNumber: "9997654321" }
    });
    expect(changedNonceReuse.statusCode).toBe(409);

    const wrongNonce = randomUUID();
    const wrong = {
      method: "POST" as const,
      url: `/v1/auth/phone/challenges/${challengeBody.challengeId as string}/verify`,
      payload: { code: "000000", deviceName: begin.deviceName, clientNonce: wrongNonce }
    };
    expect((await app.inject(wrong)).statusCode).toBe(401);
    expect((await app.inject(wrong)).statusCode).toBe(401);
    expect(app.luxora.store.findPhoneAuthChallengeById(challengeBody.challengeId)?.attemptsUsed)
      .toBe(1);

    const verified = await app.inject({
      method: "POST",
      url: `/v1/auth/phone/challenges/${challengeBody.challengeId as string}/verify`,
      payload: {
        code: DEVELOPMENT_CODE,
        deviceName: begin.deviceName,
        clientNonce: randomUUID()
      }
    });
    expect(verified.statusCode, verified.body).toBe(200);
    expect(verified.json()).toMatchObject({
      status: "profile_required",
      maskedPhone: challengeBody.maskedPhone
    });
    const registrationToken = verified.json().registrationToken as string;

    const occupied = await app.inject({
      method: "POST",
      url: "/v1/auth/register",
      payload: {
        username: "egor_name",
        displayName: "Occupied",
        password: "correct horse battery staple"
      }
    });
    expect(occupied.statusCode).toBe(201);
    const usernameCheck = await app.inject({
      method: "POST",
      url: "/v1/auth/phone/usernames/check",
      payload: { registrationToken, username: "egor_name" }
    });
    expect(usernameCheck.statusCode, usernameCheck.body).toBe(200);
    expect(usernameCheck.json()).toMatchObject({
      username: "egor_name",
      available: false
    });
    expect(usernameCheck.json().suggestions).toEqual([
      "egor_name_1",
      "egor_name_2",
      "egor_name_3",
      "egor_name_4",
      "egor_name_5"
    ]);

    const occupiedNumbered = await app.inject({
      method: "POST",
      url: "/v1/auth/register",
      payload: {
        username: "egor_numbered_1",
        displayName: "Occupied numbered",
        password: "correct horse battery staple"
      }
    });
    expect(occupiedNumbered.statusCode).toBe(201);
    const incrementedCheck = await app.inject({
      method: "POST",
      url: "/v1/auth/phone/usernames/check",
      payload: { registrationToken, username: "egor_numbered_1" }
    });
    expect(incrementedCheck.statusCode, incrementedCheck.body).toBe(200);
    expect(incrementedCheck.json().suggestions.slice(0, 2)).toEqual([
      "egor_numbered_2",
      "egor_numbered_3"
    ]);

    const registrationNonce = randomUUID();
    const registrationPayload = {
      registrationToken,
      displayName: "Егор",
      username: "egor_name_1",
      bio: "Первый профиль Luxora",
      deviceName: begin.deviceName,
      clientNonce: registrationNonce
    };
    const registration = await app.inject({
      method: "POST",
      url: "/v1/auth/phone/registrations",
      payload: registrationPayload
    });
    expect(registration.statusCode, registration.body).toBe(201);
    expect(registration.json()).toMatchObject({
      user: {
        username: "egor_name_1",
        displayName: "Егор",
        bio: "Первый профиль Luxora"
      },
      tokens: { tokenType: "Bearer" }
    });

    const registrationReplay = await app.inject({
      method: "POST",
      url: "/v1/auth/phone/registrations",
      payload: registrationPayload
    });
    expect(registrationReplay.statusCode).toBe(201);
    expect(registrationReplay.json()).toEqual(registration.json());

    const me = await app.inject({
      method: "GET",
      url: "/v1/me",
      headers: {
        authorization: `Bearer ${registration.json().tokens.accessToken as string}`
      }
    });
    expect(me.statusCode).toBe(200);
    expect(me.json().user.id).toBe(registration.json().user.id);

    const passwordFallback = await app.inject({
      method: "POST",
      url: "/v1/auth/login",
      payload: {
        username: "egor_name_1",
        password: "correct horse battery staple",
        deviceName: "Password attempt"
      }
    });
    expect(passwordFallback.statusCode).toBe(401);

    const loginChallenge = await app.inject({
      method: "POST",
      url: "/v1/auth/phone/challenges",
      payload: beginPayload()
    });
    const login = await app.inject({
      method: "POST",
      url: `/v1/auth/phone/challenges/${loginChallenge.json().challengeId as string}/verify`,
      payload: {
        code: DEVELOPMENT_CODE,
        deviceName: "Replacement iPhone",
        clientNonce: randomUUID()
      }
    });
    expect(login.statusCode, login.body).toBe(200);
    expect(login.json()).toMatchObject({
      status: "authenticated",
      user: { id: registration.json().user.id, username: "egor_name_1" },
      tokens: { tokenType: "Bearer" }
    });
  });

  it("enforces the advertised resend window per normalized phone without breaking exact replay", async () => {
    app = await buildApp({ config: phoneConfig(), logger: false });
    const original = beginPayload();
    const first = await app.inject({
      method: "POST",
      url: "/v1/auth/phone/challenges",
      payload: original
    });
    expect(first.statusCode, first.body).toBe(201);

    const samePhoneNewCommand = await app.inject({
      method: "POST",
      url: "/v1/auth/phone/challenges",
      payload: beginPayload()
    });
    expect(samePhoneNewCommand.statusCode).toBe(429);
    expect(samePhoneNewCommand.json()).toMatchObject({
      error: { code: "RATE_LIMITED" }
    });

    const exactReplay = await app.inject({
      method: "POST",
      url: "/v1/auth/phone/challenges",
      payload: original
    });
    expect(exactReplay.statusCode).toBe(201);
    expect(exactReplay.json()).toEqual(first.json());

    const otherPhone = await app.inject({
      method: "POST",
      url: "/v1/auth/phone/challenges",
      payload: {
        ...beginPayload(),
        nationalNumber: "9997654321"
      }
    });
    expect(otherPhone.statusCode, otherPhone.body).toBe(201);
  });

  it("recovers an ambiguous provider failure with the same durable provider idempotency key", async () => {
    const deliveredChallengeIds: string[] = [];
    const provider = {
      sendVerificationCode: async (delivery: { challengeId: string }) => {
        deliveredChallengeIds.push(delivery.challengeId);
        if (deliveredChallengeIds.length === 1) {
          throw new Error("synthetic ambiguous delivery outage");
        }
      }
    };
    app = await buildApp({
      config: phoneConfig(),
      logger: false,
      phoneDeliveryProvider: provider
    });
    const payload = beginPayload();
    const failed = await app.inject({
      method: "POST",
      url: "/v1/auth/phone/challenges",
      payload
    });
    expect(failed.statusCode).toBe(503);

    const replay = await app.inject({
      method: "POST",
      url: "/v1/auth/phone/challenges",
      payload
    });
    expect(replay.statusCode, replay.body).toBe(201);
    expect(deliveredChallengeIds).toEqual([
      replay.json().challengeId,
      replay.json().challengeId
    ]);
  });

  it("returns one exact durable outcome for concurrent verification and registration retries", async () => {
    app = await buildApp({ config: phoneConfig(), logger: false });
    const challenge = await app.inject({
      method: "POST",
      url: "/v1/auth/phone/challenges",
      payload: beginPayload()
    });
    expect(challenge.statusCode, challenge.body).toBe(201);
    const challengeId = challenge.json().challengeId as string;
    const verificationPayload = {
      code: DEVELOPMENT_CODE,
      deviceName: "Concurrent iPhone",
      clientNonce: randomUUID()
    };
    const [firstVerification, secondVerification] = await Promise.all([
      app.inject({
        method: "POST",
        url: `/v1/auth/phone/challenges/${challengeId}/verify`,
        payload: verificationPayload
      }),
      app.inject({
        method: "POST",
        url: `/v1/auth/phone/challenges/${challengeId}/verify`,
        payload: verificationPayload
      })
    ]);
    expect(firstVerification.statusCode, firstVerification.body).toBe(200);
    expect(secondVerification.statusCode, secondVerification.body).toBe(200);
    expect(secondVerification.json()).toEqual(firstVerification.json());

    const registrationPayload = {
      registrationToken: firstVerification.json().registrationToken as string,
      displayName: "Гонка",
      username: `race_${randomUUID().replaceAll("-", "").slice(0, 12)}`,
      bio: "",
      deviceName: "Concurrent iPhone",
      clientNonce: randomUUID()
    };
    const [firstRegistration, secondRegistration] = await Promise.all([
      app.inject({
        method: "POST",
        url: "/v1/auth/phone/registrations",
        payload: registrationPayload
      }),
      app.inject({
        method: "POST",
        url: "/v1/auth/phone/registrations",
        payload: registrationPayload
      })
    ]);
    expect(firstRegistration.statusCode, firstRegistration.body).toBe(201);
    expect(secondRegistration.statusCode, secondRegistration.body).toBe(201);
    expect(secondRegistration.json()).toEqual(firstRegistration.json());
    expect(app.luxora.store.findPhoneAuthChallengeById(challengeId)).toMatchObject({
      state: "consumed",
      revision: 4
    });
  });

  it("does not look up account existence before a correct code and locks bounded attempts", async () => {
    const config = phoneConfig();
    const store = new SqliteStore(
      ":memory:",
      contentCipherFromConfig(config.dataEncryptionKeys, config.activeDataEncryptionKeyId)
    );
    let identityLookups = 0;
    const originalLookup = store.findPhoneIdentityByDigest.bind(store);
    store.findPhoneIdentityByDigest = (digest) => {
      identityLookups += 1;
      return originalLookup(digest);
    };
    app = await buildApp({ config, store, logger: false });

    const challenge = await app.inject({
      method: "POST",
      url: "/v1/auth/phone/challenges",
      payload: beginPayload()
    });
    const challengeId = challenge.json().challengeId as string;
    for (let attempt = 0; attempt < config.phoneAuthMaxAttempts; attempt += 1) {
      const rejected = await app.inject({
        method: "POST",
        url: `/v1/auth/phone/challenges/${challengeId}/verify`,
        payload: {
          code: "000000",
          deviceName: "Hostile probe",
          clientNonce: randomUUID()
        }
      });
      expect(rejected.statusCode).toBe(401);
    }
    expect(identityLookups).toBe(0);
    expect(store.findPhoneAuthChallengeById(challengeId)).toMatchObject({
      state: "locked",
      attemptsUsed: config.phoneAuthMaxAttempts
    });
    const correctAfterLock = await app.inject({
      method: "POST",
      url: `/v1/auth/phone/challenges/${challengeId}/verify`,
      payload: {
        code: DEVELOPMENT_CODE,
        deviceName: "Hostile probe",
        clientNonce: randomUUID()
      }
    });
    expect(correctAfterLock.statusCode).toBe(401);
    expect(identityLookups).toBe(0);
  });
});
