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
});
