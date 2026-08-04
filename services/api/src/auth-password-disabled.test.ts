import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { AppError } from "./errors.js";
import { SqliteStore } from "./infrastructure/sqlite-store.js";
import { TokenSecurity } from "./security.js";
import { AuthService } from "./services/auth-service.js";
import {
  PASSKEY_DISABLED_PASSWORD_HASH_PATTERN,
  createPasskeyDisabledPasswordHash,
  hashPassword,
  verifyPassword
} from "./services/password-auth.js";
import { testConfig } from "./test-helpers.js";

const NOW = new Date("2027-01-15T12:00:00.000Z");
const DISABLED_ID = "11111111-1111-4111-8111-111111111111";
const ENABLED_ID = "22222222-2222-4222-8222-222222222222";
const CORRUPT_ID = "33333333-3333-4333-8333-333333333333";

const cleanup: Array<{ directory: string; store: SqliteStore }> = [];

afterEach(() => {
  for (const item of cleanup.splice(0)) {
    item.store.close();
    rmSync(item.directory, { recursive: true, force: true });
  }
});

describe("explicit password-auth state", () => {
  it("creates distinct valid Argon2id placeholders from discarded random secrets", async () => {
    const [first, second] = await Promise.all([
      createPasskeyDisabledPasswordHash(),
      createPasskeyDisabledPasswordHash()
    ]);
    expect(first).toMatch(PASSKEY_DISABLED_PASSWORD_HASH_PATTERN);
    expect(second).toMatch(PASSKEY_DISABLED_PASSWORD_HASH_PATTERN);
    expect(second).not.toBe(first);
    await expect(verifyPassword(first, "any-client-password")).resolves.toBe(false);
    await expect(verifyPassword(second, "any-client-password")).resolves.toBe(false);
  });

  it("does full Argon2 verification yet generically rejects disabled and corrupt accounts", async () => {
    const directory = mkdtempSync(join(tmpdir(), "luxora-password-disabled-"));
    const path = join(directory, "auth.sqlite");
    const store = new SqliteStore(path);
    cleanup.push({ directory, store });
    const knownPassword = "correct-but-disabled-password";
    const disabledHash = await hashPassword(knownPassword);
    expect(await verifyPassword(disabledHash, knownPassword)).toBe(true);
    store.createUser({
      id: DISABLED_ID,
      username: "DisabledPasskey",
      usernameNormalized: "disabledpasskey",
      displayName: "Disabled Passkey",
      passwordHash: disabledHash,
      createdAt: NOW.toISOString()
    });
    store.createUser({
      id: ENABLED_ID,
      username: "EnabledPassword",
      usernameNormalized: "enabledpassword",
      displayName: "Enabled Password",
      passwordHash: await hashPassword(knownPassword),
      createdAt: NOW.toISOString()
    });
    store.createUser({
      id: CORRUPT_ID,
      username: "CorruptLegacy",
      usernameNormalized: "corruptlegacy",
      displayName: "Corrupt Legacy",
      passwordHash: "not-an-argon2-hash",
      createdAt: NOW.toISOString()
    });
    const inspection = new Database(path);
    inspection.prepare(`
      UPDATE users SET password_auth_enabled = 0 WHERE id = ?
    `).run(DISABLED_ID);
    inspection.close();

    const config = testConfig();
    const auth = new AuthService(
      store,
      new TokenSecurity(config),
      config,
      undefined,
      () => new Date(NOW)
    );
    const rejected = async (username: string, password: string) => auth.login({
      username,
      password,
      deviceName: "Password boundary test"
    }).then(() => null, (error: unknown) => error);
    for (const [username, password] of [
      ["DisabledPasskey", knownPassword],
      ["DisabledPasskey", "wrong-password"],
      ["MissingAccount", knownPassword],
      ["CorruptLegacy", knownPassword]
    ] as const) {
      const error = await rejected(username, password);
      expect(error).toBeInstanceOf(AppError);
      expect(error).toMatchObject({
        statusCode: 401,
        code: "UNAUTHENTICATED",
        message: "Invalid username or password"
      });
    }
    const afterRejections = new Database(path, { readonly: true });
    expect((afterRejections.prepare(`
      SELECT COUNT(*) AS count FROM device_sessions
    `).get() as { count: number }).count).toBe(0);
    afterRejections.close();

    const enabled = await auth.login({
      username: "EnabledPassword",
      password: knownPassword,
      deviceName: "Enabled password test"
    });
    expect(enabled.user.id).toBe(ENABLED_ID);
    expect(store.findUserById(ENABLED_ID)?.passwordAuthEnabled).toBe(true);
    expect(store.findUserById(DISABLED_ID)?.passwordAuthEnabled).toBe(false);
  });
});
