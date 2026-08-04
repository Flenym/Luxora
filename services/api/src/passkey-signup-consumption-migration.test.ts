import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { migrations } from "./infrastructure/migrations.js";

const ACCOUNT_ID = "11111111-1111-4111-8111-111111111111";
const CREATED_AT = "2027-01-15T12:00:00.000Z";

describe("migration 013 atomic first-passkey consumption", () => {
  let database: Database.Database | undefined;

  afterEach(() => database?.close());

  it("backfills explicit password state and installs only durable safe authorization proof", () => {
    database = new Database(":memory:");
    database.pragma("foreign_keys = ON");
    for (const migration of migrations.slice(0, 12)) database.exec(migration.sql);
    database.prepare(`
      INSERT INTO users (
        id, username, username_normalized, display_name, password_hash,
        created_at, updated_at
      ) VALUES (?, 'LegacyUser', 'legacyuser', 'Legacy User', 'legacy-hash', ?, ?)
    `).run(ACCOUNT_ID, CREATED_AT, CREATED_AT);

    database.exec(migrations[12]!.sql);

    expect(database.prepare(`
      SELECT password_auth_enabled FROM users WHERE id = ?
    `).get(ACCOUNT_ID)).toEqual({ password_auth_enabled: 1 });
    const passwordColumn = (database.pragma("table_info(users)") as Array<{
      name: string;
      notnull: number;
      dflt_value: string | null;
    }>).find(({ name }) => name === "password_auth_enabled");
    expect(passwordColumn).toMatchObject({ notnull: 1, dflt_value: "1" });

    const consumptionColumns = (database.pragma(
      "table_info(passkey_signup_consumptions)"
    ) as Array<{ name: string }>).map(({ name }) => name);
    expect(consumptionColumns).toEqual(expect.arrayContaining([
      "intent_id",
      "result_revision",
      "account_id",
      "user_handle_ref",
      "credential_record_id",
      "session_id",
      "initial_refresh_token_id",
      "initial_access_token_expires_at_sec",
      "refresh_derivation_key_id",
      "committed_at_ms"
    ]));
    const schema = (database.prepare(`
      SELECT sql FROM sqlite_master WHERE name = 'passkey_signup_consumptions'
    `).get() as { sql: string }).sql;
    expect(schema).toMatch(/DEFERRABLE INITIALLY DEFERRED/u);
    expect(schema).not.toMatch(/username|display|password|challenge|raw_|token_hash/iu);

    const triggers = (database.prepare(`
      SELECT name, sql FROM sqlite_master WHERE type = 'trigger'
    `).all() as Array<{ name: string; sql: string }>);
    expect(triggers.map(({ name }) => name)).not.toContain(
      "trg_passkey_signup_intents_consumption_reserved"
    );
    expect(triggers.map(({ name }) => name)).toEqual(expect.arrayContaining([
      "trg_passkey_signup_intents_consumed_proof",
      "trg_passkey_signup_consumptions_bind_candidate",
      "trg_passkey_credentials_require_step_up_grant_insert"
    ]));
    const credentialAuthorization = triggers.find(
      ({ name }) => name === "trg_passkey_credentials_require_step_up_grant_insert"
    )?.sql ?? "";
    expect(credentialAuthorization).toMatch(/passkey_step_up_grants/u);
    expect(credentialAuthorization).toMatch(/passkey_signup_consumptions/u);
    expect(database.pragma("foreign_key_check")).toEqual([]);
  });
});
