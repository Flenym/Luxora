import { afterEach, describe, expect, it } from "vitest";
import type { LuxoraApp } from "./app.js";
import { buildApp } from "./app.js";
import { testConfig } from "./test-helpers.js";

describe("authentication", () => {
  let app: LuxoraApp | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it("registers, authenticates, rotates refresh tokens, and detects reuse", async () => {
    app = await buildApp({ config: testConfig(), logger: false });
    const registration = await app.inject({
      method: "POST",
      url: "/v1/auth/register",
      payload: {
        username: "aurora",
        displayName: "Aurora",
        password: "correct horse battery staple",
        deviceName: "Integration test"
      }
    });
    expect(registration.statusCode).toBe(201);
    const registered = registration.json();

    const me = await app.inject({
      method: "GET",
      url: "/v1/me",
      headers: { authorization: `Bearer ${registered.tokens.accessToken as string}` }
    });
    expect(me.statusCode).toBe(200);
    expect(me.json().user.username).toBe("aurora");

    const refresh = await app.inject({
      method: "POST",
      url: "/v1/auth/refresh",
      payload: { refreshToken: registered.tokens.refreshToken }
    });
    expect(refresh.statusCode).toBe(200);
    const refreshed = refresh.json();
    expect(refreshed.tokens.refreshToken).not.toBe(registered.tokens.refreshToken);

    const replay = await app.inject({
      method: "POST",
      url: "/v1/auth/refresh",
      payload: { refreshToken: registered.tokens.refreshToken }
    });
    expect(replay.statusCode).toBe(401);
    expect(replay.json().error.message).toContain("reuse detected");

    const revokedAccess = await app.inject({
      method: "GET",
      url: "/v1/me",
      headers: { authorization: `Bearer ${refreshed.tokens.accessToken as string}` }
    });
    expect(revokedAccess.statusCode).toBe(401);
  });

  it("does not allow duplicate usernames with different casing", async () => {
    app = await buildApp({ config: testConfig(), logger: false });
    const base = {
      displayName: "Aurora",
      password: "correct horse battery staple"
    };
    expect((await app.inject({ method: "POST", url: "/v1/auth/register", payload: { ...base, username: "Aurora" } })).statusCode)
      .toBe(201);
    const duplicate = await app.inject({
      method: "POST",
      url: "/v1/auth/register",
      payload: { ...base, username: "AURORA" }
    });
    expect(duplicate.statusCode).toBe(409);
  });

  it.each(["имя", "name with spaces"])("maps invalid username '%s' to canonical validation errors", async (username) => {
    app = await buildApp({ config: testConfig(), logger: false });
    for (const [url, payload] of [
      ["/v1/auth/register", { username, displayName: "Invalid", password: "correct horse battery staple" }],
      ["/v1/auth/login", { username, password: "correct horse battery staple" }]
    ] as const) {
      const response = await app.inject({ method: "POST", url, payload });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({
        error: {
          code: "VALIDATION_FAILED",
          message: "Request validation failed"
        }
      });
      expect(response.json().error.requestId).toEqual(expect.any(String));
    }
  });
});
