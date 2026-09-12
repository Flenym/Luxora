import { afterEach, describe, expect, it } from "vitest";
import {
  AdminChatListResponseSchema,
  AdminStatusResponseSchema,
  AdminUserListResponseSchema
} from "@luxora/protocol";
import type { LuxoraApp } from "./app.js";
import { buildApp } from "./app.js";
import type { AppConfig } from "./config.js";
import { testConfig } from "./test-helpers.js";

const ADMIN_TOKEN = "test-only-admin-token-with-at-least-32-bytes";

function adminHeaders(token = ADMIN_TOKEN): { authorization: string } {
  return { authorization: `Bearer ${token}` };
}

function configWithoutAdmin(): AppConfig {
  return testConfig({ adminToken: undefined as never });
}

async function register(app: LuxoraApp, username: string): Promise<{ id: string; accessToken: string }> {
  const response = await app.inject({
    method: "POST",
    url: "/v1/auth/register",
    payload: { username, displayName: username, password: "admin preview test phrase" }
  });
  expect(response.statusCode, response.body).toBe(201);
  return {
    id: response.json().user.id as string,
    accessToken: response.json().tokens.accessToken as string
  };
}

describe("operator administration surface", () => {
  let app: LuxoraApp | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it("is unavailable without an admin token and rejects forged tokens", async () => {
    app = await buildApp({ config: configWithoutAdmin(), logger: false });

    for (const url of ["/v1/admin/status", "/v1/admin/users?limit=5", "/v1/admin/chats?limit=5"]) {
      const disabled = await app.inject({ method: "GET", url, headers: adminHeaders() });
      expect(disabled.statusCode, url).toBe(503);
      expect(disabled.json().error.code, url).toBe("SERVICE_UNAVAILABLE");
    }

    app = await buildApp({ config: testConfig(), logger: false });
    for (const url of ["/v1/admin/status", "/v1/admin/users?limit=5", "/v1/admin/chats?limit=5"]) {
      const anonymous = await app.inject({ method: "GET", url });
      expect(anonymous.statusCode, url).toBe(401);

      const forged = await app.inject({
        method: "GET",
        url,
        headers: adminHeaders("wrong-token-with-at-least-32-bytes!!")
      });
      expect(forged.statusCode, url).toBe(401);
      expect(forged.json().error.code, url).toBe("UNAUTHENTICATED");
      expect(forged.headers["cache-control"], url).toBe("private, no-store");
    }
  });

  it("reports operator status without secret material", async () => {
    app = await buildApp({ config: testConfig(), logger: false });
    const alice = await register(app, "admin_alice");
    const bob = await register(app, "admin_bob");
    const direct = await app.inject({
      method: "POST",
      url: "/v1/chats",
      headers: { authorization: `Bearer ${alice.accessToken}` },
      payload: { kind: "direct", userId: bob.id }
    });
    expect(direct.statusCode, direct.body).toBe(201);

    const status = await app.inject({
      method: "GET",
      url: "/v1/admin/status",
      headers: adminHeaders()
    });
    expect(status.statusCode, status.body).toBe(200);
    const parsed = AdminStatusResponseSchema.parse(status.json());

    const migration = await app.inject({
      method: "GET",
      url: "/v1/admin/status",
      headers: adminHeaders(ADMIN_TOKEN)
    });
    expect(migration.json().migrationId).toBe("026_phone_recovery_and_binding");
    expect(parsed.users).toBe(2);
    expect(parsed.activeSessions).toBe(2);
    expect(parsed.chatsByKind.direct).toBe(1);
    expect(parsed.messages).toBe(0);
    expect(status.headers["cache-control"]).toBe("private, no-store");

    for (const secret of [
      "password_hash",
      "passwordHash",
      "phone_ciphertext",
      "token_hash",
      "refresh",
      "digest",
      "ciphertext"
    ]) {
      expect(status.body.toLowerCase(), secret).not.toContain(secret);
    }
  });

  it("paginates users and chats with opaque cursors", async () => {
    app = await buildApp({ config: testConfig(), logger: false });
    const names = ["page_one", "page_two", "page_three"];
    for (const name of names) {
      await register(app, name);
    }

    const first = await app.inject({
      method: "GET",
      url: "/v1/admin/users?limit=2",
      headers: adminHeaders()
    });
    expect(first.statusCode, first.body).toBe(200);
    const firstPage = AdminUserListResponseSchema.parse(first.json());
    expect(firstPage.items).toHaveLength(2);
    expect(firstPage.nextCursor).not.toBeNull();

    const second = await app.inject({
      method: "GET",
      url: `/v1/admin/users?limit=2&cursor=${encodeURIComponent(firstPage.nextCursor as string)}`,
      headers: adminHeaders()
    });
    expect(second.statusCode, second.body).toBe(200);
    const secondPage = AdminUserListResponseSchema.parse(second.json());
    expect(secondPage.items).toHaveLength(1);
    expect(secondPage.nextCursor).toBeNull();

    const seen = new Set([...firstPage.items, ...secondPage.items].map((item) => item.username));
    expect(seen).toEqual(new Set(names));

    const tampered = await app.inject({
      method: "GET",
      url: "/v1/admin/users?limit=2&cursor=not-a-cursor",
      headers: adminHeaders()
    });
    expect(tampered.statusCode, tampered.body).toBe(200);

    const chats = await app.inject({
      method: "GET",
      url: "/v1/admin/chats?limit=50",
      headers: adminHeaders()
    });
    expect(chats.statusCode, chats.body).toBe(200);
    const chatPage = AdminChatListResponseSchema.parse(chats.json());
    expect(chatPage.items).toEqual([]);
    expect(chatPage.nextCursor).toBeNull();

    for (const forbidden of ["password_hash", "passwordHash", "phone_ciphertext", "token_hash", "ciphertext", "refreshToken", "accessToken"]) {
      expect(first.body.toLowerCase(), forbidden).not.toContain(forbidden);
    }
  });
});
