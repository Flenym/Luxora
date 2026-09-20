import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { migrations, type Migration } from "./infrastructure/migrations.js";
import { SqliteStore } from "./infrastructure/sqlite-store.js";

const MIGRATION_IDS = [
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
  "030_privacy_visibility_policies",
  "031_notification_categories",
  "032_chat_invite_links",
  "033_chat_join_request_approval",
  "034_chat_ownership_transfer",
  "035_account_data_exports",
  "036_account_deletion_state_machine",
  "037_data_export_retention",
  "038_call_control_records",
  "039_call_room_index",
  "040_device_link_challenges",
  "041_device_link_approval"
] as const;
const BASE_TIME = "2026-08-03T12:00:00.000Z";
const LEGACY_FINGERPRINT = "legacy-encrypted-request-fingerprint";

type LegacyVersion = 5 | 6 | 7 | 8 | 9 | 10;

interface LegacyFixture {
  databasePath: string;
  version: LegacyVersion;
  leftUserId: string;
  rightUserId: string;
  chatId: string;
  sourceMessageId: string;
  forwardedMessageId: string;
  coreSnapshot: unknown;
  existingMigrationRows: Array<{ id: string; applied_at: string }>;
}

interface ColumnInfo {
  name: string;
  notnull: number;
  dflt_value: string | null;
}

type MigrationOpenOutcome =
  | { ok: true; ping: boolean; migrationCount: number }
  | { ok: false; message: string };

interface MigrationWorker {
  worker: Worker;
  ready: Promise<void>;
  outcome: Promise<MigrationOpenOutcome>;
}

type WalRetryOutcome =
  | { ok: true; userId: string }
  | { ok: false; message: string };

interface WalRetryWorker {
  worker: Worker;
  ready: Promise<void>;
  opened: Promise<void>;
  outcome: Promise<WalRetryOutcome>;
}

function startMigrationWorker(databasePath: string, gate: SharedArrayBuffer): MigrationWorker {
  const worker = new Worker(
    new URL("./test-support/migration-open-worker.ts", import.meta.url),
    { execArgv: ["--import", "tsx"], workerData: { databasePath, gate } }
  );
  let resolveReady: (() => void) | undefined;
  let rejectReady: ((error: Error) => void) | undefined;
  let resolveOutcome: ((outcome: MigrationOpenOutcome) => void) | undefined;
  let rejectOutcome: ((error: Error) => void) | undefined;
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  const outcome = new Promise<MigrationOpenOutcome>((resolve, reject) => {
    resolveOutcome = resolve;
    rejectOutcome = reject;
  });
  worker.on("message", (message: any) => {
    if (message.type === "ready") resolveReady?.();
    if (message.type === "result") resolveOutcome?.(message.outcome as MigrationOpenOutcome);
  });
  worker.on("error", (error) => {
    rejectReady?.(error);
    rejectOutcome?.(error);
  });
  worker.on("exit", (code) => {
    if (code !== 0) {
      const error = new Error(`Migration worker exited with code ${code}`);
      rejectReady?.(error);
      rejectOutcome?.(error);
    }
  });
  return { worker, ready, outcome };
}

function startWalRetryWorker(
  databasePath: string,
  startupGate: SharedArrayBuffer,
  writeGate: SharedArrayBuffer
): WalRetryWorker {
  const worker = new Worker(
    new URL("./test-support/wal-bootstrap-retry-worker.ts", import.meta.url),
    { execArgv: ["--import", "tsx"], workerData: { databasePath, startupGate, writeGate } }
  );
  let resolveReady: (() => void) | undefined;
  let rejectReady: ((error: Error) => void) | undefined;
  let resolveOpened: (() => void) | undefined;
  let rejectOpened: ((error: Error) => void) | undefined;
  let resolveOutcome: ((outcome: WalRetryOutcome) => void) | undefined;
  let rejectOutcome: ((error: Error) => void) | undefined;
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  const opened = new Promise<void>((resolve, reject) => {
    resolveOpened = resolve;
    rejectOpened = reject;
  });
  const outcome = new Promise<WalRetryOutcome>((resolve, reject) => {
    resolveOutcome = resolve;
    rejectOutcome = reject;
  });
  let openedSettled = false;
  worker.on("message", (message: any) => {
    if (message.type === "ready") resolveReady?.();
    if (message.type === "opened") {
      openedSettled = true;
      resolveOpened?.();
    }
    if (message.type === "result") {
      const result = message.outcome as WalRetryOutcome;
      if (!openedSettled && !result.ok) {
        openedSettled = true;
        rejectOpened?.(new Error(result.message));
      }
      resolveOutcome?.(result);
    }
  });
  worker.on("error", (error) => {
    rejectReady?.(error);
    rejectOpened?.(error);
    rejectOutcome?.(error);
  });
  worker.on("exit", (code) => {
    if (code !== 0) {
      const error = new Error(`WAL retry worker exited with code ${code}`);
      rejectReady?.(error);
      rejectOpened?.(error);
      rejectOutcome?.(error);
    }
  });
  return { worker, ready, opened, outcome };
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function createMigrationTable(database: Database.Database): void {
  database.exec(`
    CREATE TABLE schema_migrations (
      id TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL
    ) STRICT;
  `);
}

function apply(database: Database.Database, migration: Migration, index: number): void {
  database.transaction(() => {
    database.exec(migration.sql);
    database.prepare("INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)")
      .run(migration.id, `2026-08-03T12:00:${String(index).padStart(2, "0")}.000Z`);
  })();
}

function migrationRows(database: Database.Database): Array<{ id: string; applied_at: string }> {
  return database.prepare("SELECT id, applied_at FROM schema_migrations ORDER BY id")
    .all() as Array<{ id: string; applied_at: string }>;
}

function coreSnapshot(database: Database.Database): unknown {
  return {
    users: database.prepare(`
      SELECT id, username, username_normalized, display_name, password_hash, created_at, updated_at
      FROM users ORDER BY id
    `).all(),
    chats: database.prepare(`
      SELECT id, kind, direct_key, created_by, created_at, updated_at
      FROM chats ORDER BY id
    `).all(),
    members: database.prepare(`
      SELECT chat_id, user_id, role, joined_at FROM chat_members ORDER BY chat_id, user_id
    `).all(),
    messages: database.prepare(`
      SELECT id, chat_id, sender_id, kind, body, client_nonce, revision,
             created_at, updated_at, edited_at, deleted_at
      FROM messages ORDER BY id
    `).all(),
    events: database.prepare(`
      SELECT sequence, audience_user_id, event_json, event_type, entity_id, created_at
      FROM realtime_events ORDER BY sequence
    `).all()
  };
}

function createLegacyFixture(databasePath: string, version: LegacyVersion): LegacyFixture {
  const database = new Database(databasePath);
  database.pragma("foreign_keys = ON");
  database.pragma("journal_mode = WAL");
  createMigrationTable(database);
  for (let index = 0; index < 4; index += 1) apply(database, migrations[index]!, index + 1);

  const leftUserId = randomUUID();
  const rightUserId = randomUUID();
  const [orderedLeft, orderedRight] = [leftUserId, rightUserId].sort() as [string, string];
  const chatId = randomUUID();
  const sourceMessageId = randomUUID();
  const forwardedMessageId = randomUUID();
  const insertUser = database.prepare(`
    INSERT INTO users (
      id, username, username_normalized, display_name, password_hash, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  insertUser.run(leftUserId, "migration_left", "migration_left", "Migration Left", "hash-left", BASE_TIME, BASE_TIME);
  insertUser.run(rightUserId, "migration_right", "migration_right", "Migration Right", "hash-right", BASE_TIME, BASE_TIME);
  database.prepare(`
    INSERT INTO chats (id, kind, direct_key, created_by, created_at, updated_at)
    VALUES (?, 'direct', ?, ?, ?, ?)
  `).run(chatId, `${orderedLeft}:${orderedRight}`, leftUserId, BASE_TIME, BASE_TIME);
  database.prepare(`
    INSERT INTO chat_members (chat_id, user_id, role, joined_at)
    VALUES (?, ?, 'member', ?), (?, ?, 'member', ?)
  `).run(chatId, leftUserId, BASE_TIME, chatId, rightUserId, BASE_TIME);
  const insertMessage = database.prepare(`
    INSERT INTO messages (
      id, chat_id, sender_id, kind, body, client_nonce, created_at, updated_at
    ) VALUES (?, ?, ?, 'text', ?, ?, ?, ?)
  `);
  insertMessage.run(
    sourceMessageId,
    chatId,
    leftUserId,
    "legacy-source-body",
    randomUUID(),
    BASE_TIME,
    BASE_TIME
  );
  insertMessage.run(
    forwardedMessageId,
    chatId,
    rightUserId,
    "legacy-forward-body",
    randomUUID(),
    BASE_TIME,
    BASE_TIME
  );
  database.prepare(`
    INSERT INTO realtime_events (
      audience_user_id, event_json, event_type, entity_id, created_at
    ) VALUES (?, ?, 'message.created', ?, ?)
  `).run(leftUserId, '{"legacy":"event-canary"}', sourceMessageId, BASE_TIME);

  for (let index = 4; index < version; index += 1) apply(database, migrations[index]!, index + 1);
  if (version >= 6) {
    database.prepare(`
      INSERT INTO realtime_outbox (event_sequence, available_at)
      VALUES (1, ?)
    `).run(BASE_TIME);
  }
  if (version >= 7) {
    database.prepare(`
      UPDATE messages SET forward_source_message_id = ? WHERE id = ?
    `).run(sourceMessageId, forwardedMessageId);
  }
  if (version >= 8) {
    database.prepare(`
      UPDATE messages SET request_fingerprint_ciphertext = ? WHERE id = ?
    `).run(LEGACY_FINGERPRINT, forwardedMessageId);
  }

  const fixture: LegacyFixture = {
    databasePath,
    version,
    leftUserId,
    rightUserId,
    chatId,
    sourceMessageId,
    forwardedMessageId,
    coreSnapshot: coreSnapshot(database),
    existingMigrationRows: migrationRows(database)
  };
  expect(database.pragma("foreign_key_check")).toEqual([]);
  database.close();
  return fixture;
}

function declaredNames(pattern: RegExp): string[] {
  return migrations.flatMap(({ sql }) => [...sql.matchAll(pattern)].map((match) => match[1] as string))
    .sort();
}

function finalDeclaredTriggerNames(): string[] {
  const names = new Set<string>();
  const triggerOperation = /\b(CREATE|DROP) TRIGGER\s+(\w+)/gu;
  for (const { sql } of migrations) {
    for (const match of sql.matchAll(triggerOperation)) {
      const name = match[2];
      if (name === undefined) continue;
      if (match[1] === "CREATE") names.add(name);
      else names.delete(name);
    }
  }
  return [...names].sort();
}

describe("SQLite migration chain 001-034", () => {
  const temporaryDirectories: string[] = [];
  const workers: Worker[] = [];

  afterEach(async () => {
    await Promise.all(workers.splice(0).map(async (worker) => {
      if (worker.threadId !== -1) await worker.terminate();
    }));
    for (const directory of temporaryDirectories.splice(0)) {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  function databasePath(name: string): string {
    const directory = mkdtempSync(join(tmpdir(), `luxora-migration-${name}-`));
    temporaryDirectories.push(directory);
    return join(directory, "luxora.sqlite");
  }

  it("keeps an append-only, non-destructive and uniquely ordered migration inventory", () => {
    expect(migrations.map(({ id }) => id)).toEqual(MIGRATION_IDS);
    expect(new Set(migrations.map(({ id }) => id)).size).toBe(migrations.length);
    for (const [index, migration] of migrations.entries()) {
      expect(migration.id).toMatch(new RegExp(`^${String(index + 1).padStart(3, "0")}_`));
      const withoutSchemaTriggerReplacement = migration.sql.replace(
        /\bDROP TRIGGER\s+\w+\s*;/gu,
        ""
      );
      const withoutApprovedMembershipBackfill = migration.id ===
        "024_chat_membership_revision_ledger"
        ? withoutSchemaTriggerReplacement.replace(
            /\bUPDATE chat_members[\s\S]*?(?=\n\n      CREATE TRIGGER trg_chat_members_identity_immutable)/u,
            ""
          )
        : withoutSchemaTriggerReplacement;
      expect(withoutApprovedMembershipBackfill).not.toMatch(
        /\b(?:DROP|TRUNCATE)\b|\bDELETE\s+FROM\b|\bUPDATE\s+\w+\s+SET\b/iu
      );
    }
    expect(migrations[6]!.sql).toMatch(
      /ADD COLUMN forward_source_message_id TEXT REFERENCES messages\(id\)/u
    );
    expect(migrations[7]!.sql).toMatch(
      /ADD COLUMN request_fingerprint_ciphertext TEXT/u
    );
    expect(migrations[7]!.sql).not.toMatch(/\bINDEX\b/iu);
    expect(migrations[8]!.sql).toMatch(/CREATE TABLE passkey_ceremonies/u);
    expect(migrations[8]!.sql).toMatch(/CREATE TABLE passkey_credentials/u);
    expect(migrations[8]!.sql).not.toMatch(/credential_id TEXT/u);
    expect(migrations[9]!.sql).toMatch(/CREATE TABLE passkey_step_up_grants/u);
    expect(migrations[9]!.sql).toMatch(/CREATE TRIGGER trg_passkey_step_up_grants_require_authentication/u);
    expect(migrations[9]!.sql).toMatch(/CREATE TRIGGER trg_passkey_step_up_grants_no_direct_delete/u);
    expect(migrations[9]!.sql).toMatch(/CREATE TRIGGER trg_passkey_credentials_require_step_up_grant_insert/u);
    expect(migrations[9]!.sql).toMatch(/CREATE TRIGGER trg_passkey_credentials_immutable_binding/u);
    expect(migrations[9]!.sql).not.toMatch(/\bjti\b|raw_jwt|step_up_token/iu);
    expect(migrations[10]!.sql).toMatch(/CREATE TABLE passkey_login_intents/u);
    expect(migrations[10]!.sql).toMatch(/access_token_ttl_seconds INTEGER NOT NULL/u);
    expect(migrations[10]!.sql).toMatch(/session_ttl_seconds INTEGER NOT NULL/u);
    expect(migrations[10]!.sql).toMatch(/recovery_grace_seconds INTEGER NOT NULL/u);
    expect(migrations[10]!.sql).toMatch(/CREATE TABLE passkey_login_command_receipts/u);
    expect(migrations[10]!.sql).toMatch(/CREATE TRIGGER trg_passkey_login_intents_consumed_proof/u);
    expect(migrations[10]!.sql).toMatch(/CREATE TRIGGER trg_passkey_login_intents_state_transition/u);
    expect(migrations[10]!.sql).not.toMatch(
      /raw_(?:nonce|token|challenge)|refresh_token\s+TEXT|credential_id\s+TEXT/iu
    );
    expect(migrations[11]!.sql).toMatch(/CREATE TABLE passkey_signup_intents/u);
    expect(migrations[11]!.sql).toMatch(/candidate_account_id TEXT NOT NULL UNIQUE/u);
    expect(migrations[11]!.sql).toMatch(/candidate_username_ciphertext TEXT NOT NULL/u);
    expect(migrations[11]!.sql).toMatch(/candidate_user_handle_ciphertext TEXT NOT NULL/u);
    expect(migrations[11]!.sql).toMatch(/CREATE TABLE passkey_signup_creation_receipts/u);
    expect(migrations[11]!.sql).toMatch(/idx_passkey_signup_intents_retention/u);
    expect(migrations[11]!.sql).toMatch(/trg_passkey_signup_intents_consumption_reserved/u);
    expect(migrations[11]!.sql).not.toMatch(/REFERENCES users\(id\).*candidate_account_id/iu);
    expect(migrations[11]!.sql).not.toMatch(
      /candidate_username\s+TEXT|candidate_display_name\s+TEXT|candidate_(?:username|username_normalized|display_name)_digest|raw_(?:challenge|response|user_handle)/iu
    );
    expect(migrations[12]!.sql).toMatch(/password_auth_enabled INTEGER NOT NULL DEFAULT 1/u);
    expect(migrations[12]!.sql).toMatch(/CREATE TABLE passkey_signup_consumptions/u);
    expect(migrations[12]!.sql).toMatch(/DEFERRABLE INITIALLY DEFERRED/u);
    expect(migrations[12]!.sql).toMatch(/DROP TRIGGER trg_passkey_credentials_require_step_up_grant_insert/u);
    expect(migrations[12]!.sql).toMatch(/CREATE TRIGGER trg_passkey_credentials_require_step_up_grant_insert/u);
    expect(migrations[12]!.sql).not.toMatch(/raw_(?:challenge|response|user_handle|token|password)/iu);
    expect(migrations[16]!.sql).toMatch(/ADD COLUMN membership_revision INTEGER NOT NULL DEFAULT 1/u);
    expect(migrations[16]!.sql).toMatch(/CREATE TABLE chat_membership_command_receipts/u);
    expect(migrations[16]!.sql).toMatch(/CREATE TRIGGER trg_chat_members_owner_no_delete/u);
    expect(migrations[16]!.sql).not.toMatch(/\bDELETE\s+FROM\b|\bUPDATE\s+\w+\s+SET\b/iu);
    expect(migrations[17]!.sql).toMatch(/CREATE TABLE phone_identities/u);
    expect(migrations[17]!.sql).toMatch(/CREATE TABLE phone_auth_challenges/u);
    expect(migrations[17]!.sql).toMatch(/CREATE TABLE phone_auth_command_receipts/u);
    expect(migrations[17]!.sql).toMatch(/CREATE TABLE phone_auth_events/u);
    expect(migrations[17]!.sql).toMatch(/trg_phone_challenges_transition/u);
    expect(migrations[17]!.sql).toMatch(/trg_phone_receipts_no_delete/u);
    expect(migrations[17]!.sql).not.toMatch(
      /phone_number\s+TEXT|verification_code\s+TEXT|raw_(?:code|token)|access_token\s+TEXT|refresh_token\s+TEXT/iu
    );
    expect(migrations[18]!.sql).toMatch(/CREATE TABLE phone_auth_password_receipts/u);
    expect(migrations[18]!.sql).toMatch(/CREATE TABLE phone_auth_password_events/u);
    expect(migrations[18]!.sql).toMatch(/ADD COLUMN phone_password_hash TEXT/u);
    expect(migrations[18]!.sql).toMatch(/ADD COLUMN phone_password_enabled INTEGER NOT NULL DEFAULT 0/u);
    expect(migrations[18]!.sql).toMatch(/trg_users_phone_password_update_valid/u);
    expect(migrations[18]!.sql).toMatch(/trg_phone_password_receipts_no_delete/u);
    expect(migrations[18]!.sql).toMatch(/trg_phone_password_events_append_only_delete/u);
    expect(migrations[18]!.sql).not.toMatch(
      /raw_(?:password|token)|access_token\s+TEXT|refresh_token\s+TEXT/iu
    );
    expect(migrations[19]!.sql).toMatch(/ADD COLUMN avatar_attachment_id TEXT/u);
    expect(migrations[19]!.sql).toMatch(/ADD COLUMN safety_status TEXT NOT NULL DEFAULT 'unscanned'/u);
    expect(migrations[19]!.sql).toMatch(/ADD COLUMN metadata_trust TEXT NOT NULL DEFAULT 'client_declared'/u);
    expect(migrations[19]!.sql).toMatch(/trg_user_avatar_owned_verified_update/u);
    expect(migrations[19]!.sql).not.toMatch(/avatar_url\s*=|https?:\/\//iu);
    expect(migrations[20]!.sql).toMatch(/CREATE TABLE push_registrations/u);
    expect(migrations[20]!.sql).toMatch(/token_ciphertext TEXT NOT NULL/u);
    expect(migrations[20]!.sql).toMatch(/CREATE TABLE notification_settings/u);
    expect(migrations[20]!.sql).toMatch(/preview_mode TEXT NOT NULL DEFAULT 'hidden'/u);
    expect(migrations[20]!.sql).toMatch(/trg_push_registration_session_binding_insert/u);
    expect(migrations[20]!.sql).not.toMatch(/device_token\s+TEXT|token\s+TEXT/iu);
    expect(migrations[21]!.sql).toMatch(/CREATE TABLE chat_folders/u);
    expect(migrations[21]!.sql).toMatch(/trg_chat_folder_receipts_no_delete/u);
    expect(migrations[22]!.sql).toMatch(/ADD COLUMN expires_at TEXT/u);
    expect(migrations[22]!.sql).toMatch(/idx_chat_folder_receipts_expiry/u);
    expect(migrations[22]!.sql).toMatch(/DROP TRIGGER trg_chat_folder_receipts_no_delete/u);
    expect(migrations[23]!.sql).toMatch(/CREATE TABLE chat_membership_revision_ledger/u);
    expect(migrations[23]!.sql).toMatch(/max\(result_revision\)/u);
    expect(migrations[23]!.sql).toMatch(/trg_chat_membership_revision_ledger_monotonic/u);
    expect(migrations[23]!.sql).toMatch(/DROP TRIGGER trg_chat_members_insert_invariants/u);
    expect(migrations[23]!.sql).toMatch(/DROP TRIGGER trg_chat_members_identity_immutable/u);
    expect(migrations[24]!.sql).toMatch(/CREATE TABLE chat_drafts/u);
    expect(migrations[24]!.sql).toMatch(/CREATE TABLE chat_draft_command_receipts/u);
    expect(migrations[24]!.sql).toMatch(/trg_chat_drafts_update_invariants/u);
    expect(migrations[24]!.sql).toMatch(
      /trg_chat_draft_receipts_immutable_delete[\s\S]*EXISTS \(\s*SELECT 1 FROM chat_members\s*WHERE user_id = OLD\.user_id AND chat_id = OLD\.chat_id/u
    );
    expect(migrations[24]!.sql).not.toMatch(/\bDROP\b|\bDELETE\s+FROM\b|\bUPDATE\s+\w+\s+SET\b/iu);
    expect(migrations[25]!.sql).toMatch(/CREATE TABLE phone_recovery_intents/u);
    expect(migrations[25]!.sql).toMatch(/CREATE TABLE phone_recovery_receipts/u);
    expect(migrations[25]!.sql).toMatch(/CREATE TABLE phone_recovery_events/u);
    expect(migrations[25]!.sql).toMatch(/CREATE TABLE phone_binding_challenges/u);
    expect(migrations[25]!.sql).toMatch(/CREATE TABLE phone_binding_receipts/u);
    expect(migrations[25]!.sql).toMatch(/CREATE TABLE phone_binding_events/u);
    expect(migrations[25]!.sql).toMatch(/trg_phone_recovery_intents_state_transition/u);
    expect(migrations[25]!.sql).toMatch(/trg_phone_binding_challenges_transition/u);
    expect(migrations[25]!.sql).toMatch(/idx_phone_recovery_intents_user/u);
    expect(migrations[25]!.sql).toMatch(/idx_phone_binding_challenges_binding/u);
    expect(migrations[25]!.sql).not.toMatch(
      /raw_(?:password|token|code)|access_token\s+TEXT|refresh_token\s+TEXT|verification_code\s+TEXT|phone_number\s+TEXT/iu
    );
    expect(migrations[25]!.sql).not.toMatch(/\bDROP\b|\bDELETE\s+FROM\b|\bUPDATE\s+\w+\s+SET\b/iu);
    expect(migrations[26]!.sql).toMatch(/ADD COLUMN transcription_consent INTEGER NOT NULL DEFAULT 0/u);
    expect(migrations[26]!.sql).toMatch(/ADD COLUMN transcript_ciphertext TEXT/u);
    expect(migrations[26]!.sql).toMatch(/trg_messages_transcript_consent_insert/u);
    expect(migrations[26]!.sql).toMatch(/trg_messages_transcription_consent_no_revoke/u);
    expect(migrations[26]!.sql).not.toMatch(/\bDROP\b|\bDELETE\s+FROM\b|\bUPDATE\s+\w+\s+SET\b/iu);
    expect(migrations[27]!.sql).toMatch(/CREATE TABLE message_transcript_commands/u);
    expect(migrations[27]!.sql).toMatch(/trg_message_transcript_commands_no_update/u);
    expect(migrations[27]!.sql).toMatch(/trg_message_transcript_commands_no_delete/u);
    expect(migrations[27]!.sql).not.toMatch(/transcript_ciphertext\s+TEXT\s+NOT\s+NULL/iu);
    expect(migrations[27]!.sql).not.toMatch(/\bDROP\b|\bDELETE\s+FROM\b|\bUPDATE\s+\w+\s+SET\b/iu);
    expect(migrations[28]!.sql).toMatch(/CREATE TABLE scheduled_messages/u);
    expect(migrations[28]!.sql).toMatch(/idx_scheduled_messages_due/u);
    expect(migrations[28]!.sql).toMatch(/idx_scheduled_messages_chat/u);
    expect(migrations[28]!.sql).toMatch(/UNIQUE \(sender_id, client_nonce\)/u);
    expect(migrations[28]!.sql).not.toMatch(/ADD COLUMN transcription_consent/u);
    expect(migrations[28]!.sql).not.toMatch(/\bDROP\b|\bDELETE\s+FROM\b|\bUPDATE\s+\w+\s+SET\b/iu);
    expect(migrations[29]!.sql).toMatch(/ADD COLUMN last_seen_visibility TEXT NOT NULL DEFAULT 'everyone'/u);
    expect(migrations[29]!.sql).toMatch(/ADD COLUMN profile_photo_visibility TEXT NOT NULL DEFAULT 'everyone'/u);
    expect(migrations[29]!.sql).toMatch(/ADD COLUMN forwards_visibility TEXT NOT NULL DEFAULT 'everyone'/u);
    expect(migrations[29]!.sql).toMatch(/ADD COLUMN voice_messages_visibility TEXT NOT NULL DEFAULT 'everyone'/u);
    expect(migrations[29]!.sql).toMatch(/ADD COLUMN calls_visibility TEXT NOT NULL DEFAULT 'everyone'/u);
    expect(migrations[29]!.sql).not.toMatch(/CREATE TABLE/iu);
    expect(migrations[29]!.sql).not.toMatch(/\bDROP\b|\bDELETE\s+FROM\b|\bUPDATE\s+\w+\s+SET\b/iu);
    expect(migrations[30]!.id).toBe("031_notification_categories");
    expect(migrations[30]!.sql).toMatch(/ADD COLUMN group_message_alerts INTEGER NOT NULL DEFAULT 1/u);
    expect(migrations[30]!.sql).toMatch(/ADD COLUMN channel_message_alerts INTEGER NOT NULL DEFAULT 1/u);
    expect(migrations[30]!.sql).toMatch(/ADD COLUMN story_alerts INTEGER NOT NULL DEFAULT 1/u);
    expect(migrations[30]!.sql).toMatch(/ADD COLUMN reaction_alerts INTEGER NOT NULL DEFAULT 1/u);
    expect(migrations[30]!.sql).not.toMatch(/CREATE TABLE/iu);
    expect(migrations[30]!.sql).not.toMatch(/\bDROP\b|\bDELETE\s+FROM\b|\bUPDATE\s+\w+\s+SET\b/iu);
    expect(migrations[31]!.id).toBe("032_chat_invite_links");
    expect(migrations[31]!.sql).toMatch(/CREATE TABLE chat_invite_links/u);
    expect(migrations[31]!.sql).toMatch(/token_digest TEXT NOT NULL UNIQUE/u);
    expect(migrations[31]!.sql).toMatch(/UNIQUE \(created_by, client_nonce\)/u);
    expect(migrations[31]!.sql).toMatch(/idx_chat_invite_links_chat/u);
    expect(migrations[31]!.sql).not.toMatch(/token TEXT/u);
    expect(migrations[31]!.sql).not.toMatch(/\bDROP\b|\bDELETE\s+FROM\b|\bUPDATE\s+\w+\s+SET\b/iu);
    expect(migrations[32]!.id).toBe("033_chat_join_request_approval");
    expect(migrations[32]!.sql).toMatch(/ADD COLUMN approval_required INTEGER NOT NULL DEFAULT 0/u);
    expect(migrations[32]!.sql).toMatch(/CREATE TABLE chat_join_requests/u);
    expect(migrations[32]!.sql).toMatch(/UNIQUE \(user_id, client_nonce\)/u);
    expect(migrations[32]!.sql).toMatch(/idx_chat_join_requests_pending/u);
    expect(migrations[32]!.sql).toMatch(/idx_chat_join_requests_chat/u);
    expect(migrations[32]!.sql).not.toMatch(/\bDROP\b|\bDELETE\s+FROM\b|\bUPDATE\s+\w+\s+SET\b/iu);
    expect(migrations[33]!.id).toBe("034_chat_ownership_transfer");
    expect(migrations[33]!.sql).toMatch(/CREATE TABLE chat_ownership_transfers/u);
    expect(migrations[33]!.sql).toMatch(/UNIQUE \(from_user_id, client_nonce\)/u);
    expect(migrations[33]!.sql).toMatch(/idx_chat_ownership_transfers_pending/u);
    expect(migrations[33]!.sql).toMatch(/DROP TRIGGER trg_chat_members_owner_immutable/u);
    expect(migrations[33]!.sql).toMatch(/chat_ownership_transfers/u);
    expect(migrations[33]!.sql).toMatch(/dedicated ceremony/u);
    expect(migrations[33]!.sql).not.toMatch(/\bDELETE\s+FROM\b/iu);
  });

  it("creates the complete clean schema once with declared tables, indexes, triggers and foreign keys", () => {
    const path = databasePath("clean");
    const first = new SqliteStore(path);
    expect(first.ping()).toBe(true);
    first.close();

    const inspection = new Database(path);
    inspection.pragma("foreign_keys = ON");
    const firstMigrationRows = migrationRows(inspection);
    expect(firstMigrationRows.map(({ id }) => id)).toEqual(MIGRATION_IDS);
    expect(inspection.pragma("journal_mode", { simple: true })).toBe("wal");
    expect(inspection.pragma("integrity_check")).toEqual([{ integrity_check: "ok" }]);
    expect(inspection.pragma("foreign_key_check")).toEqual([]);

    const declaredTables = [
      "schema_migrations",
      ...declaredNames(/CREATE TABLE\s+(\w+)/gu)
    ].sort();
    const actualTables = (inspection.prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
      ORDER BY name
    `).all() as Array<{ name: string }>).map(({ name }) => name);
    expect(actualTables).toEqual(declaredTables);

    const declaredIndexes = declaredNames(/CREATE(?: UNIQUE)? INDEX\s+(\w+)/gu);
    const actualIndexes = (inspection.prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'index' AND name NOT LIKE 'sqlite_autoindex_%'
      ORDER BY name
    `).all() as Array<{ name: string }>).map(({ name }) => name);
    expect(actualIndexes).toEqual(declaredIndexes);

    const declaredTriggers = finalDeclaredTriggerNames();
    const actualTriggers = (inspection.prepare(`
      SELECT name FROM sqlite_master WHERE type = 'trigger' ORDER BY name
    `).all() as Array<{ name: string }>).map(({ name }) => name);
    expect(actualTriggers).toEqual(declaredTriggers);

    const messageColumns = inspection.pragma("table_info(messages)") as ColumnInfo[];
    expect(messageColumns).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "forward_source_message_id", notnull: 0, dflt_value: null }),
      expect.objectContaining({ name: "request_fingerprint_ciphertext", notnull: 0, dflt_value: null })
    ]));
    expect(inspection.pragma("foreign_key_list(messages)")).toEqual(expect.arrayContaining([
      expect.objectContaining({ table: "messages", from: "forward_source_message_id", to: "id" })
    ]));
    expect(inspection.pragma("foreign_key_list(realtime_outbox)")).toEqual(expect.arrayContaining([
      expect.objectContaining({ table: "realtime_events", from: "event_sequence", to: "sequence", on_delete: "CASCADE" })
    ]));
    expect(inspection.pragma("table_info(chat_members)")).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "membership_revision", notnull: 1, dflt_value: "1" }),
      expect.objectContaining({ name: "membership_updated_at", notnull: 0, dflt_value: null })
    ]));
    expect(inspection.pragma("table_info(users)")).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "avatar_attachment_id", notnull: 0, dflt_value: null })
    ]));
    expect(inspection.pragma("foreign_key_list(users)")).toEqual(expect.arrayContaining([
      expect.objectContaining({ table: "attachments", from: "avatar_attachment_id", to: "id", on_delete: "SET NULL" })
    ]));
    expect(inspection.pragma("table_info(attachments)")).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "safety_status", notnull: 1, dflt_value: "'unscanned'" }),
      expect.objectContaining({ name: "metadata_trust", notnull: 1, dflt_value: "'client_declared'" })
    ]));
    expect(inspection.pragma("foreign_key_list(chat_membership_command_receipts)")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ table: "users", from: "actor_user_id", to: "id" }),
        expect.objectContaining({ table: "users", from: "target_user_id", to: "id" }),
        expect.objectContaining({ table: "chats", from: "chat_id", to: "id" })
      ])
    );
    expect(inspection.pragma("foreign_key_list(passkey_ceremonies)")).toEqual(expect.arrayContaining([
      expect.objectContaining({ table: "device_sessions", from: "session_id", to: "id", on_delete: "CASCADE" }),
      expect.objectContaining({ table: "device_sessions", from: "account_id", to: "user_id", on_delete: "CASCADE" })
    ]));
    expect(inspection.pragma("foreign_key_list(passkey_credentials)")).toEqual(expect.arrayContaining([
      expect.objectContaining({ table: "passkey_user_handles", from: "user_handle_ref", to: "reference" }),
      expect.objectContaining({ table: "passkey_user_handles", from: "account_id", to: "account_id" })
    ]));
    const grantForeignKeys = inspection.pragma("foreign_key_list(passkey_step_up_grants)") as Array<{
      table: string;
      from: string;
      to: string;
      on_delete: string;
    }>;
    expect(grantForeignKeys).toEqual(expect.arrayContaining([
      expect.objectContaining({ table: "device_sessions", from: "session_id", to: "id", on_delete: "CASCADE" }),
      expect.objectContaining({ table: "device_sessions", from: "account_id", to: "user_id", on_delete: "CASCADE" }),
      expect.objectContaining({
        table: "passkey_ceremonies",
        from: "registration_ceremony_id",
        to: "ceremony_id",
        on_delete: "CASCADE"
      })
    ]));
    expect(grantForeignKeys).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ from: "authentication_ceremony_id" })
    ]));
    const grantColumnNames = (inspection.pragma("table_info(passkey_step_up_grants)") as ColumnInfo[])
      .map(({ name }) => name);
    expect(grantColumnNames).toEqual([
      "authentication_ceremony_id",
      "account_id",
      "session_id",
      "device_id",
      "purpose",
      "target_digest",
      "auth_time_sec",
      "issued_at_sec",
      "expires_at_sec",
      "consumed_at_sec",
      "registration_ceremony_id"
    ]);
    expect(grantColumnNames.some((name) => /jti|jwt|token/u.test(name))).toBe(false);
    const credentialColumnNames = (inspection.pragma("table_info(passkey_credentials)") as ColumnInfo[])
      .map(({ name }) => name);
    expect(credentialColumnNames).toEqual(expect.arrayContaining([
      "credential_id_digest",
      "credential_id_ciphertext",
      "credential_material_ciphertext",
      "algorithm",
      "revision",
      "sign_count",
      "backup_eligible",
      "backup_state"
    ]));
    expect(credentialColumnNames).not.toEqual(expect.arrayContaining([
      "credential_id",
      "public_key",
      "transports_json"
    ]));
    const messageIndexes = inspection.prepare(`
      SELECT sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'messages' AND sql IS NOT NULL
    `).all() as Array<{ sql: string }>;
    expect(messageIndexes.every(({ sql }) => !sql.includes("request_fingerprint_ciphertext"))).toBe(true);
    inspection.close();

    const reopened = new SqliteStore(path);
    expect(reopened.ping()).toBe(true);
    reopened.close();
    const repeatedInspection = new Database(path, { readonly: true });
    expect(migrationRows(repeatedInspection)).toEqual(firstMigrationRows);
    repeatedInspection.close();
  });

  it("upgrades an already-applied 022 database to bounded receipt retention without losing rows", () => {
    const path = databasePath("upgrade-022-receipts");
    const accountId = randomUUID();
    const clientNonce = randomUUID();
    const createdAt = "2026-08-11T09:00:00.000Z";
    const legacy = new Database(path);
    legacy.pragma("foreign_keys = ON");
    createMigrationTable(legacy);
    for (let index = 0; index < 22; index += 1) apply(legacy, migrations[index]!, index + 1);
    legacy.prepare(`
      INSERT INTO users (
        id, username, username_normalized, display_name,
        password_hash, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      accountId,
      "folder_migration_user",
      "folder_migration_user",
      "Folder migration user",
      "test-only-password-hash",
      createdAt,
      createdAt
    );
    legacy.prepare(`
      INSERT INTO chat_folder_command_receipts (
        user_id, client_nonce, operation, fingerprint,
        response_ciphertext, created_at
      ) VALUES (?, ?, 'create', ?, ?, ?)
    `).run(accountId, clientNonce, "f".repeat(64), "luxora:v1.legacy", createdAt);
    expect(() => legacy.prepare(`
      DELETE FROM chat_folder_command_receipts
      WHERE user_id = ? AND client_nonce = ?
    `).run(accountId, clientNonce)).toThrow(/cannot be deleted/u);
    legacy.close();

    const upgraded = new SqliteStore(path);
    expect(upgraded.ping()).toBe(true);
    expect(upgraded.purgeExpiredChatFolderCommandReceipts(
      "2026-08-12T09:00:00.000Z",
      100
    )).toBe(1);
    upgraded.close();

    const inspection = new Database(path);
    inspection.pragma("foreign_keys = ON");
    expect(migrationRows(inspection).map(({ id }) => id)).toEqual(MIGRATION_IDS);
    expect((inspection.prepare(`
      SELECT count(*) AS count FROM chat_folder_command_receipts
      WHERE user_id = ?
    `).get(accountId) as { count: number }).count).toBe(0);
    const triggerNames = (inspection.prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'trigger' AND name LIKE 'trg_chat_folder_receipts_%'
      ORDER BY name
    `).all() as Array<{ name: string }>).map(({ name }) => name);
    expect(triggerNames).toEqual([
      "trg_chat_folder_receipts_immutable",
      "trg_chat_folder_receipts_require_expiry"
    ]);
    expect(inspection.pragma("integrity_check")).toEqual([{ integrity_check: "ok" }]);
    expect(inspection.pragma("foreign_key_check")).toEqual([]);
    inspection.close();
  });

  it("upgrades a 023 remove-readd lifecycle without an ABA revision reset", () => {
    const path = databasePath("upgrade-023-membership-ledger");
    const ownerId = randomUUID();
    const memberId = randomUUID();
    const chatId = randomUUID();
    const removedAt = "2026-08-11T10:00:00.000Z";
    const rolledBackWallTime = "2026-08-11T09:00:00.000Z";
    const legacy = new Database(path);
    legacy.pragma("foreign_keys = ON");
    createMigrationTable(legacy);
    for (let index = 0; index < 23; index += 1) apply(legacy, migrations[index]!, index + 1);
    for (const [id, username] of [
      [ownerId, "membership_ledger_owner"],
      [memberId, "membership_ledger_member"]
    ] as const) {
      legacy.prepare(`
        INSERT INTO users (
          id, username, username_normalized, display_name,
          password_hash, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        id,
        username,
        username,
        username,
        "test-only-password-hash",
        rolledBackWallTime,
        rolledBackWallTime
      );
    }
    legacy.prepare(`
      INSERT INTO chats (
        id, kind, title, created_by, created_at, updated_at
      ) VALUES (?, 'group', 'Membership ledger migration', ?, ?, ?)
    `).run(chatId, ownerId, rolledBackWallTime, rolledBackWallTime);
    legacy.prepare(`
      INSERT INTO chat_members (
        chat_id, user_id, role, membership_revision, joined_at, membership_updated_at
      ) VALUES (?, ?, 'owner', 1, ?, ?)
    `).run(chatId, ownerId, rolledBackWallTime, rolledBackWallTime);
    legacy.prepare(`
      INSERT INTO chat_members (
        chat_id, user_id, role, membership_revision, joined_at, membership_updated_at
      ) VALUES (?, ?, 'member', 1, ?, ?)
    `).run(chatId, memberId, rolledBackWallTime, rolledBackWallTime);
    legacy.prepare(`
      DELETE FROM chat_members WHERE chat_id = ? AND user_id = ?
    `).run(chatId, memberId);
    legacy.prepare(`
      INSERT INTO chat_membership_command_receipts (
        actor_user_id, client_nonce, operation, chat_id, target_user_id,
        fingerprint, result_role, result_revision, result_joined_at,
        result_updated_at, created_at
      ) VALUES (?, ?, 'remove', ?, ?, ?, 'member', 2, ?, ?, ?)
    `).run(
      ownerId,
      randomUUID(),
      chatId,
      memberId,
      "legacy-remove-fingerprint",
      rolledBackWallTime,
      removedAt,
      removedAt
    );
    // Before migration 024, the physical row can be re-created at revision 1
    // even when its wall clock moved behind the removal receipt.
    legacy.prepare(`
      INSERT INTO chat_members (
        chat_id, user_id, role, membership_revision, joined_at, membership_updated_at
      ) VALUES (?, ?, 'member', 1, ?, ?)
    `).run(chatId, memberId, rolledBackWallTime, rolledBackWallTime);
    legacy.close();

    const upgraded = new SqliteStore(path);
    const migratedMembership = upgraded.getChatMember(chatId, memberId);
    expect(migratedMembership?.revision).toBe(3);
    expect(migratedMembership!.joinedAt > removedAt).toBe(true);
    expect(migratedMembership!.updatedAt).toBe(migratedMembership!.joinedAt);
    const removed = upgraded.removeChatMember(chatId, memberId, 3, rolledBackWallTime);
    expect(removed?.revision).toBe(4);
    expect(removed!.updatedAt > removedAt).toBe(true);
    const readded = upgraded.createChatMember(chatId, memberId, "admin", rolledBackWallTime);
    expect(readded).toMatchObject({ revision: 5, role: "admin" });
    expect(readded!.joinedAt > removed!.updatedAt).toBe(true);
    upgraded.close();

    const inspection = new Database(path, { readonly: true });
    expect(migrationRows(inspection).map(({ id }) => id)).toEqual(MIGRATION_IDS);
    expect(inspection.prepare(`
      SELECT last_revision, last_removed_at
      FROM chat_membership_revision_ledger
      WHERE chat_id = ? AND user_id = ?
    `).get(chatId, memberId)).toEqual({
      last_revision: 4,
      last_removed_at: removed!.updatedAt
    });
    expect(inspection.pragma("integrity_check")).toEqual([{ integrity_check: "ok" }]);
    expect(inspection.pragma("foreign_key_check")).toEqual([]);
    inspection.close();
  });

  it.each([5, 6, 7, 8, 9, 10] as const)(
    "upgrades a schema through migration %s without rewriting legacy domain/event/outbox data",
    (version) => {
      const fixture = createLegacyFixture(databasePath(`upgrade-${version}`), version);
      const upgraded = new SqliteStore(fixture.databasePath);
      expect(upgraded.ping()).toBe(true);
      upgraded.close();

      const inspection = new Database(fixture.databasePath);
      inspection.pragma("foreign_keys = ON");
      expect(migrationRows(inspection).map(({ id }) => id)).toEqual(MIGRATION_IDS);
      expect(migrationRows(inspection).slice(0, version)).toEqual(fixture.existingMigrationRows);
      expect(coreSnapshot(inspection)).toEqual(fixture.coreSnapshot);
      expect(inspection.pragma("integrity_check")).toEqual([{ integrity_check: "ok" }]);
      expect(inspection.pragma("foreign_key_check")).toEqual([]);
      expect((inspection.prepare(`
        SELECT COUNT(*) AS count FROM account_privacy_settings
        WHERE user_id IN (?, ?)
      `).get(fixture.leftUserId, fixture.rightUserId) as { count: number }).count).toBe(2);
      expect((inspection.prepare(`
        SELECT COUNT(*) AS count FROM account_relationships
        WHERE pair_key = ?
      `).get([fixture.leftUserId, fixture.rightUserId].sort().join(":")) as { count: number }).count).toBe(1);
      expect((inspection.prepare(`
        SELECT COUNT(*) AS count FROM realtime_outbox
      `).get() as { count: number }).count).toBe(version >= 6 ? 1 : 0);
      const upgradedMessage = inspection.prepare(`
        SELECT forward_source_message_id, request_fingerprint_ciphertext
        FROM messages WHERE id = ?
      `).get(fixture.forwardedMessageId) as {
        forward_source_message_id: string | null;
        request_fingerprint_ciphertext: string | null;
      };
      expect(upgradedMessage.forward_source_message_id).toBe(
        version >= 7 ? fixture.sourceMessageId : null
      );
      expect(upgradedMessage.request_fingerprint_ciphertext).toBe(
        version >= 8 ? LEGACY_FINGERPRINT : null
      );
      const onceRows = migrationRows(inspection);
      inspection.close();

      const repeated = new SqliteStore(fixture.databasePath);
      expect(repeated.ping()).toBe(true);
      repeated.close();
      const finalInspection = new Database(fixture.databasePath, { readonly: true });
      expect(migrationRows(finalInspection)).toEqual(onceRows);
      expect(coreSnapshot(finalInspection)).toEqual(fixture.coreSnapshot);
      finalInspection.close();
    }
  );

  it("keeps two independent live connections on the upgraded schema with enforced FKs", () => {
    const fixture = createLegacyFixture(databasePath("two-connections"), 7);
    const firstStore = new SqliteStore(fixture.databasePath);
    const secondStore = new SqliteStore(fixture.databasePath);
    try {
      expect(firstStore.ping()).toBe(true);
      expect(secondStore.ping()).toBe(true);
      const first = new Database(fixture.databasePath);
      const second = new Database(fixture.databasePath);
      try {
        first.pragma("foreign_keys = ON");
        second.pragma("foreign_keys = ON");
        first.pragma("busy_timeout = 5000");
        second.pragma("busy_timeout = 5000");
        first.prepare(`
          UPDATE messages SET request_fingerprint_ciphertext = ? WHERE id = ?
        `).run("connection-a-fingerprint", fixture.forwardedMessageId);
        expect((second.prepare(`
          SELECT request_fingerprint_ciphertext AS fingerprint FROM messages WHERE id = ?
        `).get(fixture.forwardedMessageId) as { fingerprint: string }).fingerprint)
          .toBe("connection-a-fingerprint");

        expect(() => second.prepare(`
          UPDATE messages SET forward_source_message_id = ? WHERE id = ?
        `).run(randomUUID(), fixture.forwardedMessageId)).toThrow(/FOREIGN KEY constraint failed/u);
        expect((first.prepare(`
          SELECT forward_source_message_id AS source FROM messages WHERE id = ?
        `).get(fixture.forwardedMessageId) as { source: string }).source)
          .toBe(fixture.sourceMessageId);
        expect(() => second.prepare(`
          INSERT INTO realtime_outbox (event_sequence, available_at) VALUES (?, ?)
        `).run(9_999_999, BASE_TIME)).toThrow(/FOREIGN KEY constraint failed/u);
        expect(first.pragma("foreign_key_check")).toEqual([]);
        expect(second.pragma("foreign_key_check")).toEqual([]);
        expect(migrationRows(first).map(({ id }) => id)).toEqual(MIGRATION_IDS);
        expect(migrationRows(second).map(({ id }) => id)).toEqual(MIGRATION_IDS);
      } finally {
        first.close();
        second.close();
      }
    } finally {
      firstStore.close();
      secondStore.close();
    }
  });

  it("serializes two cold-start upgrades and rechecks migration 011 under the writer lock", async () => {
    const fixture = createLegacyFixture(databasePath("cold-start-race"), 10);
    const gate = new SharedArrayBuffer(4);
    const first = startMigrationWorker(fixture.databasePath, gate);
    const second = startMigrationWorker(fixture.databasePath, gate);
    workers.push(first.worker, second.worker);
    await Promise.all([first.ready, second.ready]);
    Atomics.store(new Int32Array(gate), 0, 1);
    Atomics.notify(new Int32Array(gate), 0, 2);

    expect(await Promise.all([first.outcome, second.outcome])).toEqual([
      { ok: true, ping: true, migrationCount: MIGRATION_IDS.length },
      { ok: true, ping: true, migrationCount: MIGRATION_IDS.length }
    ]);
    const inspection = new Database(fixture.databasePath, { readonly: true });
    expect(migrationRows(inspection).map(({ id }) => id)).toEqual(MIGRATION_IDS);
    expect(coreSnapshot(inspection)).toEqual(fixture.coreSnapshot);
    expect(inspection.pragma("integrity_check")).toEqual([{ integrity_check: "ok" }]);
    expect(inspection.pragma("foreign_key_check")).toEqual([]);
    inspection.close();
  });

  it("does not mask an inconsistent pre-008 schema as an idempotent migration", () => {
    const fixture = createLegacyFixture(databasePath("inconsistent-008"), 7);
    const tampered = new Database(fixture.databasePath);
    tampered.exec("ALTER TABLE messages ADD COLUMN request_fingerprint_ciphertext TEXT");
    tampered.close();

    expect(() => new SqliteStore(fixture.databasePath)).toThrow(
      /duplicate column name: request_fingerprint_ciphertext/u
    );
    const inspection = new Database(fixture.databasePath, { readonly: true });
    expect(migrationRows(inspection)).toEqual(fixture.existingMigrationRows);
    expect(coreSnapshot(inspection)).toEqual(fixture.coreSnapshot);
    expect(inspection.pragma("integrity_check")).toEqual([{ integrity_check: "ok" }]);
    expect(inspection.pragma("foreign_key_check")).toEqual([]);
    inspection.close();
  });

  it("serializes two simultaneous constructors on a clean database before WAL/schema setup", async () => {
    const path = databasePath("clean-cold-start-race");
    const gate = new SharedArrayBuffer(4);
    const first = startMigrationWorker(path, gate);
    const second = startMigrationWorker(path, gate);
    workers.push(first.worker, second.worker);
    await Promise.all([first.ready, second.ready]);
    Atomics.store(new Int32Array(gate), 0, 1);
    Atomics.notify(new Int32Array(gate), 0, 2);

    expect(await Promise.all([first.outcome, second.outcome])).toEqual([
      { ok: true, ping: true, migrationCount: MIGRATION_IDS.length },
      { ok: true, ping: true, migrationCount: MIGRATION_IDS.length }
    ]);
    const inspection = new Database(path);
    inspection.pragma("foreign_keys = ON");
    expect(inspection.pragma("journal_mode", { simple: true })).toBe("wal");
    expect(migrationRows(inspection).map(({ id }) => id)).toEqual(MIGRATION_IDS);
    expect(inspection.pragma("integrity_check")).toEqual([{ integrity_check: "ok" }]);
    expect(inspection.pragma("foreign_key_check")).toEqual([]);
    inspection.close();
  });

  it("retries WAL bootstrap behind a short DELETE-mode lock and restores the 5s write wait", async () => {
    const path = databasePath("wal-bootstrap-retry");
    let blocker = new Database(path);
    let blockerTransactionOpen = false;
    try {
      blocker.pragma("journal_mode = DELETE");
      blocker.exec("CREATE TABLE bootstrap_lock (id INTEGER PRIMARY KEY) STRICT");
      blocker.exec("BEGIN EXCLUSIVE");
      blockerTransactionOpen = true;

      const startupGate = new SharedArrayBuffer(4);
      const writeGate = new SharedArrayBuffer(4);
      const candidate = startWalRetryWorker(path, startupGate, writeGate);
      workers.push(candidate.worker);
      await candidate.ready;
      Atomics.store(new Int32Array(startupGate), 0, 1);
      Atomics.notify(new Int32Array(startupGate), 0, 1);
      await delay(100);
      blocker.exec("COMMIT");
      blockerTransactionOpen = false;

      await candidate.opened;
      blocker.close();
      blocker = new Database(path);
      const observedJournalMode = blocker.pragma("journal_mode", { simple: true });
      blocker.exec("BEGIN IMMEDIATE");
      blockerTransactionOpen = true;
      Atomics.store(new Int32Array(writeGate), 0, 1);
      Atomics.notify(new Int32Array(writeGate), 0, 1);
      await delay(100);
      blocker.exec("COMMIT");
      blockerTransactionOpen = false;

      const outcome = await candidate.outcome;
      expect(observedJournalMode).toBe("wal");
      expect(outcome).toMatchObject({ ok: true });
      if (!outcome.ok) throw new Error(outcome.message);
      const inspection = new Database(path, { readonly: true });
      expect((inspection.prepare("SELECT COUNT(*) AS count FROM users WHERE id = ?")
        .get(outcome.userId) as { count: number }).count).toBe(1);
      expect(inspection.pragma("integrity_check")).toEqual([{ integrity_check: "ok" }]);
      expect(inspection.pragma("foreign_key_check")).toEqual([]);
      inspection.close();
    } finally {
      if (blockerTransactionOpen) blocker.exec("ROLLBACK");
      blocker.close();
    }
  });
});
