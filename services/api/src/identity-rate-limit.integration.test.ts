import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import type { LuxoraApp } from "./app.js";
import { buildApp } from "./app.js";
import { testConfig } from "./test-helpers.js";

describe("IA-1 authenticated abuse-sensitive rate limits", () => {
  let app: LuxoraApp | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it("combines per-device-session and cross-session account buckets with generic 429 responses", async () => {
    app = await buildApp({ config: testConfig(), logger: false });
    const password = "correct horse battery staple";
    const register = async (username: string, deviceName: string) => {
      const response = await app!.inject({
        method: "POST",
        url: "/v1/auth/register",
        remoteAddress: username === "limit_alice" ? "192.0.2.1" : "192.0.2.2",
        payload: { username, displayName: username, password, deviceName }
      });
      expect(response.statusCode).toBe(201);
      return response.json();
    };

    const aliceFirst = await register("limit_alice", "Alice phone");
    const bob = await register("limit_bob", "Bob phone");
    const secondLogin = await app.inject({
      method: "POST",
      url: "/v1/auth/login",
      remoteAddress: "192.0.2.3",
      payload: {
        username: "limit_alice",
        password,
        deviceName: "Alice tablet"
      }
    });
    expect(secondLogin.statusCode).toBe(200);

    const lookup = (accessToken: string, index: number) => app!.inject({
      method: "GET",
      url: `/v1/users/lookup?username=${bob.user.username as string}`,
      headers: { authorization: `Bearer ${accessToken}` },
      // A changing network address proves the authenticated buckets remain in
      // force independently of the route's existing IP/network bucket.
      remoteAddress: `198.51.100.${index}`
    });

    for (let index = 1; index <= 20; index += 1) {
      const response = await lookup(aliceFirst.tokens.accessToken as string, index);
      expect(response.statusCode).toBe(200);
    }
    const deviceLimited = await lookup(aliceFirst.tokens.accessToken as string, 21);
    expect(deviceLimited.statusCode).toBe(429);

    for (let index = 22; index <= 31; index += 1) {
      const response = await lookup(secondLogin.json().tokens.accessToken as string, index);
      expect(response.statusCode).toBe(200);
    }
    const accountLimited = await lookup(secondLogin.json().tokens.accessToken as string, 32);
    expect(accountLimited.statusCode).toBe(429);

    for (const response of [deviceLimited, accountLimited]) {
      expect(response.json()).toMatchObject({
        error: { code: "RATE_LIMITED", message: "Too many requests" }
      });
      expect(Object.keys(response.json().error).sort()).toEqual(["code", "message", "requestId"]);
      expect(response.headers["cache-control"]).toContain("no-store");
    }
  });

  it("aggregates draft PUT and DELETE by session/account without coupling accounts behind one IP", async () => {
    app = await buildApp({
      config: testConfig({
        dataEncryptionKeys: {
          draft_rate_limit: Buffer.alloc(32, 73).toString("base64url")
        },
        activeDataEncryptionKeyId: "draft_rate_limit"
      }),
      logger: false
    });
    const password = "correct horse battery staple";
    const remoteAddress = "203.0.113.80";

    const register = async (username: string, deviceName: string) => {
      const response = await app!.inject({
        method: "POST",
        url: "/v1/auth/register",
        remoteAddress,
        payload: { username, displayName: username, password, deviceName }
      });
      expect(response.statusCode, response.body).toBe(201);
      return response.json();
    };
    const login = async (username: string, deviceName: string) => {
      const response = await app!.inject({
        method: "POST",
        url: "/v1/auth/login",
        remoteAddress,
        payload: { username, password, deviceName }
      });
      expect(response.statusCode, response.body).toBe(200);
      return response.json();
    };
    const authorization = (token: string) => ({ authorization: `Bearer ${token}` });

    const aliceFirst = await register("draft_limit_alice", "Alice phone");
    const aliceSecond = await login("draft_limit_alice", "Alice tablet");
    const aliceThird = await login("draft_limit_alice", "Alice desktop");
    const bob = await register("draft_limit_bob", "Bob phone");

    const createSavedChat = async (identity: { user: { id: string }; tokens: { accessToken: string } }) => {
      const response = await app!.inject({
        method: "POST",
        url: "/v1/chats",
        remoteAddress,
        headers: authorization(identity.tokens.accessToken),
        payload: { kind: "direct", userId: identity.user.id }
      });
      expect(response.statusCode, response.body).toBe(201);
      return response.json().chat.id as string;
    };

    const aliceChat = await createSavedChat(aliceFirst);
    const aliceNonce = randomUUID();
    const putAlice = (token: string) => app!.inject({
      method: "PUT",
      url: `/v1/chats/${aliceChat}/draft`,
      remoteAddress,
      headers: authorization(token),
      payload: {
        text: "coalesced autosave",
        expectedRevision: 0,
        clientNonce: aliceNonce
      }
    });

    for (let index = 0; index < 120; index += 1) {
      const response = await putAlice(aliceFirst.tokens.accessToken as string);
      expect(response.statusCode, `request ${index + 1}: ${response.body}`).toBe(200);
    }
    const deviceLimitedAcrossDelete = await app.inject({
      method: "DELETE",
      url: `/v1/chats/${aliceChat}/draft`,
      remoteAddress,
      headers: authorization(aliceFirst.tokens.accessToken as string),
      payload: { expectedRevision: 1, clientNonce: randomUUID() }
    });
    expect(deviceLimitedAcrossDelete.statusCode, deviceLimitedAcrossDelete.body).toBe(429);

    for (let index = 0; index < 120; index += 1) {
      const response = await putAlice(aliceSecond.tokens.accessToken as string);
      expect(response.statusCode, response.body).toBe(200);
    }
    for (let index = 0; index < 60; index += 1) {
      const response = await putAlice(aliceThird.tokens.accessToken as string);
      expect(response.statusCode, response.body).toBe(200);
    }
    const accountLimited = await putAlice(aliceThird.tokens.accessToken as string);
    expect(accountLimited.statusCode, accountLimited.body).toBe(429);

    for (const response of [deviceLimitedAcrossDelete, accountLimited]) {
      const body = response.json();
      expect(body).toMatchObject({
        error: {
          code: "RATE_LIMITED",
          message: "Too many requests",
          details: { retryAfterSeconds: expect.any(Number) }
        }
      });
      expect(body.error.details.retryAfterSeconds).toBeGreaterThanOrEqual(1);
      expect(body.error.details.retryAfterSeconds).toBeLessThanOrEqual(60);
      expect(Number.isInteger(body.error.details.retryAfterSeconds)).toBe(true);
      expect(Number(response.headers["retry-after"]))
        .toBe(body.error.details.retryAfterSeconds);
      expect(response.headers["cache-control"]).toContain("no-store");
      for (const privateCanary of [
        password,
        "coalesced autosave",
        aliceNonce,
        aliceChat,
        aliceFirst.user.id,
        aliceFirst.tokens.accessToken,
        aliceFirst.tokens.refreshToken,
        aliceFirst.tokens.sessionId,
        aliceSecond.tokens.accessToken,
        aliceSecond.tokens.refreshToken,
        aliceSecond.tokens.sessionId,
        aliceThird.tokens.accessToken,
        aliceThird.tokens.refreshToken,
        aliceThird.tokens.sessionId
      ]) {
        expect(response.body).not.toContain(privateCanary as string);
      }
    }

    // More than the old 120/IP ceiling has already been consumed from this
    // address. A different authenticated account must still have room under
    // its own identity buckets while the outer 600/IP abuse ceiling remains.
    const bobChat = await createSavedChat(bob);
    const bobPut = await app.inject({
      method: "PUT",
      url: `/v1/chats/${bobChat}/draft`,
      remoteAddress,
      headers: authorization(bob.tokens.accessToken as string),
      payload: {
        text: "bob-private-draft",
        expectedRevision: 0,
        clientNonce: randomUUID()
      }
    });
    expect(bobPut.statusCode, bobPut.body).toBe(200);
  });
});
