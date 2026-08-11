import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import type { LuxoraApp } from "./app.js";
import { buildApp } from "./app.js";
import { SqliteStore } from "./infrastructure/sqlite-store.js";
import { testConfig } from "./test-helpers.js";

describe("current-user profile update", () => {
  let app: LuxoraApp | undefined;
  const directories: string[] = [];

  afterEach(async () => {
    await app?.close();
    app = undefined;
    for (const directory of directories.splice(0)) {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  async function register() {
    app = await buildApp({ config: testConfig(), logger: false });
    const response = await app.inject({
      method: "POST",
      url: "/v1/auth/register",
      payload: {
        username: "profile_owner",
        displayName: "Before",
        password: "correct horse battery staple",
        deviceName: "Profile integration"
      }
    });
    expect(response.statusCode).toBe(201);
    return response.json().tokens.accessToken as string;
  }

  it("updates display name and bio and persists the current-user projection", async () => {
    const accessToken = await register();
    const authorization = { authorization: `Bearer ${accessToken}` };

    const update = await app!.inject({
      method: "PATCH",
      url: "/v1/me",
      headers: authorization,
      payload: { displayName: "  Егор Flenym  ", bio: "  Создаёт Luxora Beta-0.1  " }
    });
    expect(update.statusCode).toBe(200);
    expect(update.json().user).toMatchObject({
      username: "profile_owner",
      displayName: "Егор Flenym",
      bio: "Создаёт Luxora Beta-0.1",
      avatarUrl: null
    });

    const me = await app!.inject({ method: "GET", url: "/v1/me", headers: authorization });
    expect(me.statusCode).toBe(200);
    expect(me.json().user).toMatchObject({
      displayName: "Егор Flenym",
      bio: "Создаёт Luxora Beta-0.1"
    });

    const clearBio = await app!.inject({
      method: "PATCH",
      url: "/v1/me",
      headers: authorization,
      payload: { bio: "   " }
    });
    expect(clearBio.statusCode).toBe(200);
    expect(clearBio.json().user.bio).toBe("");
    expect(clearBio.json().user.displayName).toBe("Егор Flenym");
  });

  it("requires authentication and rejects invalid or expansive mutations", async () => {
    const unauthenticated = await (app = await buildApp({ config: testConfig(), logger: false })).inject({
      method: "PATCH",
      url: "/v1/me",
      payload: { displayName: "No token" }
    });
    expect(unauthenticated.statusCode).toBe(401);
    await app.close();
    app = undefined;

    const accessToken = await register();
    const authorization = { authorization: `Bearer ${accessToken}` };
    for (const payload of [
      {},
      { displayName: "   " },
      { displayName: "Valid", avatarUrl: "https://example.test/unowned.png" }
    ]) {
      const response = await app!.inject({
        method: "PATCH",
        url: "/v1/me",
        headers: authorization,
        payload
      });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({ error: { code: "VALIDATION_FAILED" } });
    }
  });

  it("keeps profile writer timestamps monotonic across independent SQLite connections", () => {
    const directory = mkdtempSync(join(tmpdir(), "luxora-profile-writers-"));
    directories.push(directory);
    const databasePath = join(directory, "profile.sqlite");
    const first = new SqliteStore(databasePath);
    const second = new SqliteStore(databasePath);
    const userId = randomUUID();
    first.createUser({
      id: userId,
      username: "profile_writer",
      usernameNormalized: "profile_writer",
      displayName: "Initial",
      passwordHash: "test-password-hash",
      createdAt: "2026-08-04T12:00:00.000Z"
    });

    expect(first.updateUserProfile(
      userId,
      { displayName: "Later timestamp" },
      "2026-08-04T12:05:00.000Z"
    )).toMatchObject({ displayName: "Later timestamp", bio: "" });
    expect(second.updateUserProfile(
      userId,
      { bio: "Earlier timestamp" },
      "2026-08-04T12:01:00.000Z"
    )).toMatchObject({ displayName: "Later timestamp", bio: "Earlier timestamp" });

    first.close();
    second.close();
    const inspection = new Database(databasePath, { readonly: true });
    expect(inspection.prepare(`
      SELECT display_name, bio, updated_at FROM users WHERE id = ?
    `).get(userId)).toEqual({
      display_name: "Later timestamp",
      bio: "Earlier timestamp",
      updated_at: "2026-08-04T12:05:00.000Z"
    });
    inspection.close();
  });
});
