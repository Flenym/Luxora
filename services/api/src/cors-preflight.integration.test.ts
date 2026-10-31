import { afterEach, describe, expect, it } from "vitest";
import type { LuxoraApp } from "./app.js";
import { buildApp } from "./app.js";
import { testConfig } from "./test-helpers.js";

// testConfig().corsOrigins is ["http://localhost:3000"].
const ALLOWED_ORIGIN = "http://localhost:3000";
const DISALLOWED_ORIGIN = "http://evil.example";

const MUTATION_METHODS = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"];

function headerValue(value: string | string[] | undefined): string {
  if (value === undefined) return "";
  return Array.isArray(value) ? value.join(",") : value;
}

describe("browser CORS contract", () => {
  let app: LuxoraApp | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it("advertises every implemented mutation method for an allowed origin", async () => {
    app = await buildApp({ config: testConfig(), logger: false });

    for (const method of ["PATCH", "PUT", "DELETE"] as const) {
      const preflight = await app.inject({
        method: "OPTIONS",
        url: "/v1/me",
        headers: {
          origin: ALLOWED_ORIGIN,
          "access-control-request-method": method,
          "access-control-request-headers": "authorization,content-type"
        }
      });
      expect(preflight.statusCode).toBe(204);
      expect(headerValue(preflight.headers["access-control-allow-origin"])).toBe(ALLOWED_ORIGIN);
      const allowedMethods = headerValue(preflight.headers["access-control-allow-methods"])
        .split(",")
        .map((value) => value.trim());
      expect(allowedMethods).toEqual(MUTATION_METHODS);
      expect(headerValue(preflight.headers["access-control-allow-headers"])).toContain("authorization");
      expect(headerValue(preflight.headers["access-control-max-age"])).toBe("86400");
    }
  });

  it("keeps the configured origin allowlist without wildcards", async () => {
    app = await buildApp({ config: testConfig(), logger: false });

    const deniedPreflight = await app.inject({
      method: "OPTIONS",
      url: "/v1/me",
      headers: {
        origin: DISALLOWED_ORIGIN,
        "access-control-request-method": "PATCH",
        "access-control-request-headers": "authorization"
      }
    });
    expect(deniedPreflight.headers["access-control-allow-origin"]).toBeUndefined();
    expect(deniedPreflight.headers["access-control-allow-methods"]).toBeUndefined();

    const allowedResponse = await app.inject({
      method: "GET",
      url: "/health/live",
      headers: { origin: ALLOWED_ORIGIN }
    });
    expect(allowedResponse.statusCode).toBe(200);
    const allowOrigin = headerValue(allowedResponse.headers["access-control-allow-origin"]);
    expect(allowOrigin).toBe(ALLOWED_ORIGIN);
    expect(allowOrigin).not.toBe("*");

    const disallowedResponse = await app.inject({
      method: "GET",
      url: "/health/live",
      headers: { origin: DISALLOWED_ORIGIN }
    });
    expect(disallowedResponse.statusCode).toBe(200);
    expect(disallowedResponse.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("exposes range, entity and retry response headers to browser clients", async () => {
    app = await buildApp({ config: testConfig(), logger: false });

    const response = await app.inject({
      method: "GET",
      url: "/health/live",
      headers: { origin: ALLOWED_ORIGIN }
    });
    expect(response.statusCode).toBe(200);
    const exposedHeaders = headerValue(response.headers["access-control-expose-headers"]).toLowerCase();
    for (const header of [
      "etag",
      "content-range",
      "accept-ranges",
      "content-disposition",
      "retry-after",
      "x-content-type-options"
    ]) {
      expect(exposedHeaders).toContain(header);
    }
  });
});
