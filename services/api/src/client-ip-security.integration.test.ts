import { afterEach, describe, expect, it } from "vitest";
import type { LuxoraApp } from "./app.js";
import { buildApp } from "./app.js";
import {
  anonymousPasskeyIpBucketKey,
  clientIpBucketKey,
  parseTrustedProxyCidrs
} from "./client-ip.js";
import { loadConfig } from "./config.js";
import { testConfig } from "./test-helpers.js";

const TEST_ENV: NodeJS.ProcessEnv = {
  NODE_ENV: "test",
  JWT_SECRET: "test-only-secret-with-at-least-thirty-two-bytes"
};

function remaining(response: { readonly headers: Record<string, string | string[] | number | undefined> }): number {
  const raw = response.headers["x-ratelimit-remaining"];
  expect(typeof raw).toBe("string");
  return Number(raw);
}

describe("canonical client IP abuse boundary", () => {
  const apps: LuxoraApp[] = [];

  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
  });

  it.each([
    ["192.0.2.9", "ipv4:192.0.2.9"],
    ["::ffff:192.0.2.9", "ipv4:192.0.2.9"],
    ["0:0:0:0:0:ffff:c000:0209", "ipv4:192.0.2.9"],
    ["2001:0DB8:0:0:0:0:0:1", "ipv6:2001:db8::1"],
    ["fe80:0:0:0:0:0:0:1%en0", "ipv6:fe80::1"]
  ])("normalizes %s to %s", (input, expected) => {
    expect(clientIpBucketKey(input)).toBe(expected);
  });

  it("collapses invalid forwarding values without retaining attacker text", () => {
    const first = clientIpBucketKey("ATTACKER_IP_CANARY_A");
    const second = clientIpBucketKey("ATTACKER_IP_CANARY_B");
    expect(first).toBe(second);
    expect(first).toBe("ip:unresolved");
    expect(first).not.toContain("ATTACKER_IP_CANARY");
  });

  it.each([
    ["2001:db8:abcd:12::1", "passkey-login:v1:ipv6-64:2001:0db8:abcd:0012"],
    ["2001:0DB8:ABCD:0012:ffff::dead", "passkey-login:v1:ipv6-64:2001:0db8:abcd:0012"],
    ["2001:db8:abcd:13::1", "passkey-login:v1:ipv6-64:2001:0db8:abcd:0013"],
    ["192.0.2.9", "passkey-login:v1:ipv4:192.0.2.9"],
    ["::ffff:192.0.2.9", "passkey-login:v1:ipv4:192.0.2.9"]
  ])("derives anonymous passkey network bucket for %s", (input, expected) => {
    expect(anonymousPasskeyIpBucketKey(input)).toBe(expected);
  });

  it("collapses hostile anonymous passkey addresses into one domain-separated key", () => {
    const first = anonymousPasskeyIpBucketKey("PASSKEY_IP_CANARY_A");
    const second = anonymousPasskeyIpBucketKey(new Proxy({}, {}));
    expect(first).toBe("passkey-login:v1:ip:unresolved");
    expect(second).toBe(first);
    expect(first).not.toContain("CANARY");
    expect(first).not.toBe(clientIpBucketKey("PASSKEY_IP_CANARY_A"));
  });

  it("defaults to direct mode and preserves only an explicit CIDR allowlist", () => {
    expect(loadConfig(TEST_ENV).trustedProxyCidrs).toEqual([]);
    expect(loadConfig({ ...TEST_ENV, TRUST_PROXY: "false" }).trustedProxyCidrs).toEqual([]);
    expect(loadConfig({
      ...TEST_ENV,
      TRUSTED_PROXY_CIDRS: "127.0.0.1/32, 2001:0DB8:0:0:0:0:0:1/128"
    }).trustedProxyCidrs).toEqual(["127.0.0.1/32", "2001:db8::1/128"]);
  });

  it.each([
    ["legacy trust-all", { TRUST_PROXY: "true" }],
    ["numeric trust-all", { TRUST_PROXY: "1" }],
    ["IPv4 catch-all", { TRUSTED_PROXY_CIDRS: "0.0.0.0/0" }],
    ["IPv6 catch-all", { TRUSTED_PROXY_CIDRS: "::/0" }],
    ["implicit host prefix", { TRUSTED_PROXY_CIDRS: "127.0.0.1" }],
    ["out-of-range prefix", { TRUSTED_PROXY_CIDRS: "127.0.0.1/33" }],
    ["scoped IPv6", { TRUSTED_PROXY_CIDRS: "fe80::1%en0/128" }],
    ["mapped IPv6 proxy", { TRUSTED_PROXY_CIDRS: "::ffff:127.0.0.1/128" }],
    ["canonical duplicate", { TRUSTED_PROXY_CIDRS: "2001:db8::1/128,2001:0DB8:0:0:0:0:0:1/128" }]
  ])("rejects unsafe or ambiguous proxy configuration: %s", (_name, overrides) => {
    expect(() => loadConfig({ ...TEST_ENV, ...overrides })).toThrow();
  });

  it.each([
    [
      "entry count",
      [...Array.from({ length: 32 }, (_unused, index) => `10.0.0.${index + 1}/32`), "TRUST_PROXY_BOUND_CANARY"].join(","),
      "contains too many entries"
    ],
    [
      "UTF-8 byte length",
      `TRUST_PROXY_BOUND_CANARY_${"x".repeat(4_096)}`,
      "exceeds its configuration bound"
    ]
  ])("bounds proxy configuration by %s without reflecting raw input", (_name, value, expectedMessage) => {
    let failure: unknown;
    try {
      loadConfig({ ...TEST_ENV, TRUSTED_PROXY_CIDRS: value });
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain(expectedMessage);
    expect((failure as Error).message).not.toContain("TRUST_PROXY_BOUND_CANARY");
  });

  it("ignores X-Forwarded-For in direct mode and merges IPv4-mapped socket aliases", async () => {
    const app = await buildApp({ config: testConfig(), logger: false });
    apps.push(app);
    const first = await app.inject({
      method: "GET",
      url: "/health/live",
      remoteAddress: "192.0.2.44",
      headers: { "x-forwarded-for": "198.51.100.10" }
    });
    const second = await app.inject({
      method: "GET",
      url: "/health/live",
      remoteAddress: "::ffff:192.0.2.44",
      headers: { "x-forwarded-for": "203.0.113.10" }
    });
    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect([remaining(first), remaining(second)]).toEqual([299, 298]);
  });

  it("uses the first untrusted address after an explicit trusted proxy chain", async () => {
    const app = await buildApp({
      config: testConfig({ trustedProxyCidrs: ["127.0.0.1/32", "10.0.0.0/8"] }),
      logger: false
    });
    apps.push(app);
    const inject = (forwardedFor: string) => app.inject({
      method: "GET",
      url: "/health/live",
      remoteAddress: "127.0.0.1",
      headers: { "x-forwarded-for": forwardedFor }
    });
    const first = await inject("192.0.2.200, 198.51.100.44, 10.2.0.5");
    const prependedSpoof = await inject("2001:db8::bad, 198.51.100.44, 10.2.0.5");
    const otherClient = await inject("198.51.100.45, 10.2.0.5");
    expect([first.statusCode, prependedSpoof.statusCode, otherClient.statusCode]).toEqual([200, 200, 200]);
    expect([remaining(first), remaining(prependedSpoof), remaining(otherClient)]).toEqual([299, 298, 299]);

    for (let index = 0; index < 298; index += 1) {
      const accepted = await inject(`192.0.2.${(index % 250) + 1}, 198.51.100.44, 10.2.0.5`);
      expect(accepted.statusCode).toBe(200);
    }
    const overflow = await inject("203.0.113.250, 198.51.100.44, 10.2.0.5");
    expect(overflow.statusCode).toBe(429);
    expect(overflow.json()).toMatchObject({ error: { code: "RATE_LIMITED" } });
  });

  it("ignores forwarding headers from a direct peer outside the trusted proxy allowlist", async () => {
    const app = await buildApp({
      config: testConfig({ trustedProxyCidrs: ["10.0.0.0/8"] }),
      logger: false
    });
    apps.push(app);
    const first = await app.inject({
      method: "GET",
      url: "/health/live",
      remoteAddress: "203.0.113.90",
      headers: { "x-forwarded-for": "198.51.100.1" }
    });
    const second = await app.inject({
      method: "GET",
      url: "/health/live",
      remoteAddress: "203.0.113.90",
      headers: { "x-forwarded-for": "198.51.100.2" }
    });
    expect([remaining(first), remaining(second)]).toEqual([299, 298]);
  });

  it("shares HTTP buckets across canonical IPv6 and IPv4-mapped representations", async () => {
    const app = await buildApp({
      config: testConfig({ trustedProxyCidrs: ["127.0.0.1/32"] }),
      logger: false
    });
    apps.push(app);
    const inject = (forwardedFor: string) => app.inject({
      method: "GET",
      url: "/health/live",
      remoteAddress: "127.0.0.1",
      headers: { "x-forwarded-for": forwardedFor }
    });
    const expanded = await inject("2001:0DB8:0:0:0:0:0:1");
    const compressed = await inject("2001:db8::1");
    const mapped = await inject("::ffff:192.0.2.77");
    const ipv4 = await inject("192.0.2.77");
    expect([remaining(expanded), remaining(compressed), remaining(mapped), remaining(ipv4)])
      .toEqual([299, 298, 299, 298]);
  });

  it("puts distinct malformed trusted-proxy values into one fail-closed HTTP bucket", async () => {
    const app = await buildApp({
      config: testConfig({ trustedProxyCidrs: ["127.0.0.1/32"] }),
      logger: false
    });
    apps.push(app);
    const first = await app.inject({
      method: "GET",
      url: "/health/live",
      remoteAddress: "127.0.0.1",
      headers: { "x-forwarded-for": "ATTACKER_INVALID_A" }
    });
    const second = await app.inject({
      method: "GET",
      url: "/health/live",
      remoteAddress: "127.0.0.1",
      headers: { "x-forwarded-for": "ATTACKER_INVALID_B" }
    });
    expect([first.statusCode, second.statusCode]).toEqual([200, 200]);
    expect([remaining(first), remaining(second)]).toEqual([299, 298]);
  });
});
