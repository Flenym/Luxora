import { afterEach, describe, expect, it } from "vitest";
import type { LuxoraApp } from "./app.js";
import { buildApp } from "./app.js";
import { testConfig } from "./test-helpers.js";

describe("operations endpoints", () => {
  let app: LuxoraApp | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it("publishes readiness and canonical OpenAPI release metadata", async () => {
    app = await buildApp({ config: testConfig(), logger: false });
    const health = await app.inject({ method: "GET", url: "/health/ready" });
    expect(health.statusCode).toBe(200);
    expect(health.json()).toEqual({ status: "ready", release: "Beta-0.1" });

    const spec = await app.inject({ method: "GET", url: "/openapi.json" });
    expect(spec.statusCode).toBe(200);
    expect(spec.json().info).toMatchObject({
      title: "Luxora API",
      version: "Beta-0.1",
      contact: { name: "Flenym" }
    });
  });

  it("maps malformed and oversized request bodies to controlled client errors", async () => {
    app = await buildApp({ config: testConfig(), logger: false });
    const malformed = await app.inject({
      method: "POST",
      url: "/v1/auth/login",
      headers: { "content-type": "application/json" },
      payload: "{not-json"
    });
    expect(malformed.statusCode).toBe(400);
    expect(malformed.json().error.code).toBe("BAD_REQUEST");

    const oversized = await app.inject({
      method: "POST",
      url: "/v1/auth/login",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ username: "a".repeat(1_100_000) })
    });
    expect(oversized.statusCode).toBe(413);
    expect(oversized.json().error.message).toBe("Request payload is too large");
  });
});
