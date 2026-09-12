import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { migrations } from "./infrastructure/migrations.js";
import { SqliteStore } from "./infrastructure/sqlite-store.js";

describe("IA-1 append-only migration", () => {
  it("upgrades a phase-2 database and backfills privacy plus accepted Direct relationships", () => {
    expect(migrations.map(({ id }) => id)).toEqual([
      "001_initial",
      "002_realtime_event_entities",
      "003_delivery_receipts",
      "004_rich_messaging_media",
      "005_identity_access_safety",
      "006_realtime_transactional_outbox",
      "007_forward_request_identity",
      "008_message_request_fingerprint",
      "009_passkey_ceremony_repository",
      "010_passkey_step_up_grants",
      "011_passkey_login_intents",
      "012_passkey_signup_intents",
      "013_passkey_signup_consumption",
      "014_passkey_authenticator_management",
      "015_passkey_authenticator_revoke_intents",
      "016_passkey_authenticator_revoke_intent_delete_guard",
      "017_chat_membership_lifecycle",
      "018_phone_authentication",
      "019_phone_password_challenge",
      "020_processed_profile_avatar",
      "021_push_registration_preferences",
      "022_chat_folders",
      "023_chat_folder_receipt_retention",
      "024_chat_membership_revision_ledger",
      "025_synchronized_chat_drafts",
      "026_phone_recovery_and_binding",
      "027_message_transcription_consent",
      "028_message_transcript_commands",
      "029_scheduled_messages",
      "030_privacy_visibility_policies"
    ]);

    const directory = mkdtempSync(join(tmpdir(), "luxora-ia1-migration-"));
    const databasePath = join(directory, "legacy.sqlite");
    const leftUserId = randomUUID();
    const rightUserId = randomUUID();
    const [orderedLeft, orderedRight] = [leftUserId, rightUserId].sort() as [string, string];
    const chatId = randomUUID();
    const at = "2026-08-03T12:00:00.000Z";

    try {
      const legacy = new Database(databasePath);
      legacy.pragma("foreign_keys = ON");
      legacy.exec(`
        CREATE TABLE schema_migrations (
          id TEXT PRIMARY KEY,
          applied_at TEXT NOT NULL
        ) STRICT;
      `);
      for (const migration of migrations.slice(0, 4)) {
        legacy.transaction(() => {
          legacy.exec(migration.sql);
          legacy.prepare("INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)")
            .run(migration.id, at);
        })();
      }
      const insertUser = legacy.prepare(`
        INSERT INTO users (
          id, username, username_normalized, display_name, password_hash, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `);
      insertUser.run(leftUserId, "legacy_left", "legacy_left", "Legacy Left", "hash", at, at);
      insertUser.run(rightUserId, "legacy_right", "legacy_right", "Legacy Right", "hash", at, at);
      legacy.prepare(`
        INSERT INTO chats (
          id, kind, title, direct_key, created_by, created_at, updated_at
        ) VALUES (?, 'direct', NULL, ?, ?, ?, ?)
      `).run(chatId, `${orderedLeft}:${orderedRight}`, leftUserId, at, at);
      legacy.prepare(`
        INSERT INTO chat_members (chat_id, user_id, role, joined_at)
        VALUES (?, ?, 'member', ?), (?, ?, 'member', ?)
      `).run(chatId, leftUserId, at, chatId, rightUserId, at);
      legacy.close();

      const upgraded = new SqliteStore(databasePath);
      expect(upgraded.getPrivacySettings(leftUserId)).toMatchObject({
        usernameDiscoverable: true,
        messageRequests: "everyone"
      });
      expect(upgraded.getPrivacySettings(rightUserId)).toMatchObject({
        usernameDiscoverable: true,
        messageRequests: "everyone"
      });
      expect(upgraded.hasAcceptedRelationship(leftUserId, rightUserId)).toBe(true);
      expect(upgraded.findDirectChat(`${orderedLeft}:${orderedRight}`)?.id).toBe(chatId);
      upgraded.close();

      const inspection = new Database(databasePath, { readonly: true });
      expect((inspection.pragma("table_info(messages)") as Array<{ name: string }>)
        .map(({ name }) => name)).toContain("forward_source_message_id");
      expect((inspection.pragma("table_info(messages)") as Array<{ name: string }>)
        .map(({ name }) => name)).toContain("request_fingerprint_ciphertext");
      expect(inspection.pragma("foreign_key_list(messages)")).toEqual(expect.arrayContaining([
        expect.objectContaining({
          table: "messages",
          from: "forward_source_message_id",
          to: "id"
        })
      ]));
      inspection.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
