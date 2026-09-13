import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import type { LuxoraApp } from "./app.js";
import { buildApp } from "./app.js";
import { testConfig } from "./test-helpers.js";

const PASSWORD = "correct horse battery staple";

interface Identity {
  id: string;
  username: string;
  accessToken: string;
  sessionId: string;
}

describe("session-bound encrypted APNs registrations and notification preferences", () => {
  let app: LuxoraApp | undefined;
  const temporaryDirectories: string[] = [];

  afterEach(async () => {
    await app?.close();
    app = undefined;
    for (const directory of temporaryDirectories.splice(0)) {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  async function fixture(): Promise<{ databasePath: string }> {
    const directory = mkdtempSync(join(tmpdir(), "luxora-push-"));
    temporaryDirectories.push(directory);
    const databasePath = join(directory, "luxora.sqlite");
    app = await buildApp({
      config: testConfig({
        databasePath,
        dataEncryptionKeys: { push: randomBytes(32).toString("base64url") },
        activeDataEncryptionKeyId: "push"
      }),
      logger: false
    });
    return { databasePath };
  }

  async function register(username: string, deviceName = `${username} iPhone`): Promise<Identity> {
    const response = await app!.inject({
      method: "POST",
      url: "/v1/auth/register",
      payload: { username, displayName: username, password: PASSWORD, deviceName }
    });
    expect(response.statusCode, response.body).toBe(201);
    const body = response.json();
    return {
      id: body.user.id as string,
      username,
      accessToken: body.tokens.accessToken as string,
      sessionId: body.tokens.sessionId as string
    };
  }

  async function login(identity: Identity, deviceName: string): Promise<Identity> {
    const response = await app!.inject({
      method: "POST",
      url: "/v1/auth/login",
      payload: { username: identity.username, password: PASSWORD, deviceName }
    });
    expect(response.statusCode, response.body).toBe(200);
    const body = response.json();
    return {
      id: identity.id,
      username: identity.username,
      accessToken: body.tokens.accessToken as string,
      sessionId: body.tokens.sessionId as string
    };
  }

  function headers(identity: Identity): { authorization: string } {
    return { authorization: `Bearer ${identity.accessToken}` };
  }

  async function putToken(identity: Identity, token: string, environment = "development") {
    return app!.inject({
      method: "PUT",
      url: "/v1/push/registrations/current",
      headers: headers(identity),
      payload: { platform: "apns", environment, token }
    });
  }

  it("stores no raw token, returns no token, replays exactly and rotates the current session", async () => {
    const { databasePath } = await fixture();
    const alice = await register("push_alice");
    const firstToken = "AB".repeat(32);
    const secondToken = "cd".repeat(48);

    const absent = await app!.inject({
      method: "GET",
      url: "/v1/push/registrations/current",
      headers: headers(alice)
    });
    expect(absent.statusCode).toBe(200);
    expect(absent.json()).toEqual({ registration: null });

    const first = await putToken(alice, firstToken);
    expect(first.statusCode, first.body).toBe(200);
    expect(first.body).not.toContain(firstToken);
    expect(first.json().registration).toMatchObject({
      platform: "apns",
      environment: "development",
      topic: "app.luxora.mobile"
    });
    expect(Object.keys(first.json().registration).sort()).toEqual([
      "createdAt",
      "environment",
      "id",
      "platform",
      "topic",
      "updatedAt"
    ]);

    const replay = await putToken(alice, firstToken.toLowerCase());
    expect(replay.statusCode).toBe(200);
    expect(replay.json().registration.id).toBe(first.json().registration.id);

    const rotated = await putToken(alice, secondToken);
    expect(rotated.statusCode).toBe(200);
    expect(rotated.json().registration.id).not.toBe(first.json().registration.id);

    const database = new Database(databasePath, { readonly: true });
    const rows = database.prepare(`
      SELECT id, token_digest, token_ciphertext, revoked_at
      FROM push_registrations ORDER BY created_at, id
    `).all() as Array<{
      id: string;
      token_digest: string;
      token_ciphertext: string;
      revoked_at: string | null;
    }>;
    expect(rows).toHaveLength(2);
    expect(rows.filter(({ revoked_at }) => revoked_at === null)).toHaveLength(1);
    expect(rows.every(({ token_digest }) => /^[0-9a-f]{64}$/u.test(token_digest))).toBe(true);
    expect(rows.every(({ token_ciphertext }) => token_ciphertext.startsWith("luxora:v1."))).toBe(true);
    expect(JSON.stringify(rows)).not.toContain(firstToken.toLowerCase());
    expect(JSON.stringify(rows)).not.toContain(secondToken);
    database.close();

    await app!.close();
    app = undefined;
    expect(readFileSync(databasePath).includes(Buffer.from(firstToken.toLowerCase(), "utf8"))).toBe(false);
    expect(readFileSync(databasePath).includes(Buffer.from(secondToken, "utf8"))).toBe(false);
  });

  it("atomically transfers an APNs token to the newly authenticated account without an oracle", async () => {
    await fixture();
    const alice = await register("push_transfer_alice");
    const bob = await register("push_transfer_bob");
    const token = "ef".repeat(32);

    const aliceRegistered = await putToken(alice, token);
    expect(aliceRegistered.statusCode).toBe(200);
    const bobRegistered = await putToken(bob, token);
    expect(bobRegistered.statusCode).toBe(200);
    expect(bobRegistered.json().registration.id).toBe(aliceRegistered.json().registration.id);

    const aliceCurrent = await app!.inject({
      method: "GET",
      url: "/v1/push/registrations/current",
      headers: headers(alice)
    });
    const bobCurrent = await app!.inject({
      method: "GET",
      url: "/v1/push/registrations/current",
      headers: headers(bob)
    });
    expect(aliceCurrent.json()).toEqual({ registration: null });
    expect(bobCurrent.json().registration.id).toBe(bobRegistered.json().registration.id);
    expect(JSON.stringify(bobCurrent.json())).not.toContain(token);
  });

  it("revokes a registration in the same commit as remote device-session revocation", async () => {
    const { databasePath } = await fixture();
    const primary = await register("push_devices", "Primary iPhone");
    const secondary = await login(primary, "Secondary iPhone");
    expect((await putToken(primary, "11".repeat(32))).statusCode).toBe(200);
    expect((await putToken(secondary, "22".repeat(32))).statusCode).toBe(200);

    const revoked = await app!.inject({
      method: "DELETE",
      url: `/v1/auth/sessions/${secondary.sessionId}`,
      headers: headers(primary)
    });
    expect(revoked.statusCode).toBe(204);

    const database = new Database(databasePath, { readonly: true });
    const active = database.prepare(`
      SELECT session_id FROM push_registrations WHERE revoked_at IS NULL
    `).all() as Array<{ session_id: string }>;
    expect(active).toEqual([{ session_id: primary.sessionId }]);
    const secondarySession = database.prepare(`
      SELECT revoked_at FROM device_sessions WHERE id = ?
    `).get(secondary.sessionId) as { revoked_at: string | null };
    expect(secondarySession.revoked_at).not.toBeNull();
    database.close();
  });

  it("keeps privacy-minimized notification defaults account-scoped and patches strictly", async () => {
    await fixture();
    const alice = await register("notify_alice");
    const bob = await register("notify_bob");

    const defaults = await app!.inject({
      method: "GET",
      url: "/v1/notifications/settings",
      headers: headers(alice)
    });
    expect(defaults.statusCode).toBe(200);
    expect(defaults.json().settings).toMatchObject({
      messageAlerts: true,
      messageRequestAlerts: true,
      mentionAlerts: true,
      groupAlerts: true,
      channelAlerts: true,
      storyAlerts: true,
      reactionAlerts: true,
      sound: true,
      badge: true,
      previewMode: "hidden"
    });

    const empty = await app!.inject({
      method: "PATCH",
      url: "/v1/notifications/settings",
      headers: headers(alice),
      payload: {}
    });
    expect(empty.statusCode).toBe(400);
    const unknown = await app!.inject({
      method: "PATCH",
      url: "/v1/notifications/settings",
      headers: headers(alice),
      payload: { previewMode: "full", token: randomUUID() }
    });
    expect(unknown.statusCode).toBe(400);

    const updated = await app!.inject({
      method: "PATCH",
      url: "/v1/notifications/settings",
      headers: headers(alice),
      payload: { sound: false, previewMode: "sender" }
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json().settings).toMatchObject({ sound: false, previewMode: "sender" });

    const independentPatch = await app!.inject({
      method: "PATCH",
      url: "/v1/notifications/settings",
      headers: headers(alice),
      payload: { mentionAlerts: false, groupAlerts: false, reactionAlerts: false }
    });
    expect(independentPatch.statusCode).toBe(200);
    expect(independentPatch.json().settings).toMatchObject({
      mentionAlerts: false,
      groupAlerts: false,
      reactionAlerts: false,
      channelAlerts: true,
      storyAlerts: true,
      sound: false,
      previewMode: "sender"
    });

    const bobDefaults = await app!.inject({
      method: "GET",
      url: "/v1/notifications/settings",
      headers: headers(bob)
    });
    expect(bobDefaults.json().settings).toMatchObject({ sound: true, previewMode: "hidden" });
  });
});
