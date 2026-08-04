import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { migrations } from "./infrastructure/migrations.js";

const NOW_MS = 1_800_000_000_000;
const TIMEOUT_MS = 300_000;
const DIGEST_A = "a".repeat(64);
const DIGEST_B = "b".repeat(64);
const DIGEST_C = "c".repeat(64);
const DIGEST_D = "d".repeat(64);
const DIGEST_E = "e".repeat(64);

function uuid(sequence: number): string {
  return `00000000-0000-4000-8000-${sequence.toString(16).padStart(12, "0")}`;
}

function openDatabase(): Database.Database {
  const database = new Database(":memory:");
  database.pragma("foreign_keys = ON");
  for (const migration of migrations.slice(0, 12)) database.exec(migration.sql);
  return database;
}

interface PendingInput {
  intentId: string;
  accountId: string;
  handleRef: string;
  handleDigest: string;
  challengeRef: string;
  maxAttempts?: number;
  timeoutMs?: number;
}

function insertPending(database: Database.Database, input: PendingInput): void {
  const timeoutMs = input.timeoutMs ?? TIMEOUT_MS;
  database.prepare(`
    INSERT INTO passkey_challenge_secrets (
      reference, challenge_ciphertext, expires_at_ms, created_at_ms
    ) VALUES (?, ?, ?, ?)
  `).run(
    input.challengeRef,
    `luxora:v1.encrypted-${input.challengeRef}`,
    NOW_MS + timeoutMs,
    NOW_MS
  );
  database.prepare(`
    INSERT INTO passkey_signup_intents (
      intent_id, schema_version, purpose_type, purpose_target_digest,
      policy_version, rp_name, expected_rp_id, expected_origin,
      expected_top_origins_json, timeout_ms, max_response_bytes, max_attempts,
      allowed_algorithms_json, require_user_presence, user_verification,
      resident_key, attestation, cross_origin_allowed, exclude_credentials_json,
      candidate_account_id, candidate_username_ciphertext,
      candidate_username_normalized_ciphertext,
      candidate_display_name_ciphertext,
      candidate_user_handle_ref, candidate_user_handle_digest,
      candidate_user_handle_ciphertext, challenge_reference, challenge_digest,
      delivery_nonce_digest, state, revision, attempts_used, created_at_ms,
      expires_at_ms, updated_at_ms
    ) VALUES (
      @intentId, 1, 'account.create', @targetDigest,
      1, 'Luxora', 'auth.luxora.app', 'https://auth.luxora.app',
      '[]', @timeoutMs, 65536, @maxAttempts,
      '[-7,-257]', 1, 'required',
      'required', 'none', 0, '[]',
      @accountId, @usernameCiphertext,
      @usernameNormalizedCiphertext,
      @displayNameCiphertext,
      @handleRef, @handleDigest,
      @handleCiphertext, @challengeRef, @challengeDigest,
      @deliveryNonceDigest, 'pending', 1, 0, @nowMs,
      @expiresAtMs, @nowMs
    )
  `).run({
    intentId: input.intentId,
    targetDigest: DIGEST_A,
    timeoutMs,
    maxAttempts: input.maxAttempts ?? 3,
    accountId: input.accountId,
    usernameCiphertext: `luxora:v1.username-${input.intentId}`,
    usernameNormalizedCiphertext: `luxora:v1.username-normalized-${input.intentId}`,
    displayNameCiphertext: `luxora:v1.display-${input.intentId}`,
    handleRef: input.handleRef,
    handleDigest: input.handleDigest,
    handleCiphertext: `luxora:v1.handle-${input.intentId}`,
    challengeRef: input.challengeRef,
    challengeDigest: DIGEST_D,
    deliveryNonceDigest: DIGEST_E,
    nowMs: NOW_MS,
    expiresAtMs: NOW_MS + timeoutMs
  });
}

describe("migration 012 pre-account passkey signup foundation", () => {
  let database: Database.Database | undefined;

  afterEach(() => database?.close());

  it("creates encrypted candidate columns, retention indexes and no users FK", () => {
    database = openDatabase();
    const columns = (database.pragma("table_info(passkey_signup_intents)") as Array<{ name: string }>)
      .map(({ name }) => name);
    expect(columns).toEqual(expect.arrayContaining([
      "candidate_account_id",
      "candidate_username_ciphertext",
      "candidate_username_normalized_ciphertext",
      "candidate_display_name_ciphertext",
      "candidate_user_handle_ciphertext",
      "candidate_user_handle_digest",
      "challenge_reference",
      "challenge_digest",
      "delivery_nonce_digest",
      "created_at_ms",
      "terminal_at_ms"
    ]));
    expect(columns).not.toEqual(expect.arrayContaining([
      "candidate_username",
      "candidate_username_normalized",
      "candidate_display_name",
      "candidate_user_handle",
      "candidate_username_digest",
      "candidate_username_normalized_digest",
      "candidate_display_name_digest",
      "raw_challenge",
      "raw_response"
    ]));
    const foreignKeys = database.pragma("foreign_key_list(passkey_signup_intents)") as Array<{
      from: string;
      table: string;
    }>;
    expect(foreignKeys).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ from: "candidate_account_id", table: "users" })
    ]));
    const indexes = (database.prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'index' AND tbl_name = 'passkey_signup_intents'
    `).all() as Array<{ name: string }>).map(({ name }) => name);
    expect(indexes).toEqual(expect.arrayContaining([
      "idx_passkey_signup_intents_expiry",
      "idx_passkey_signup_intents_retention",
      "idx_passkey_signup_intents_created",
      "idx_passkey_signup_intents_credential_claim"
    ]));
  });

  it("allows parallel encrypted same-name candidates without a name tag or reservation", () => {
    database = openDatabase();
    insertPending(database, {
      intentId: uuid(1),
      accountId: uuid(101),
      handleRef: "signup-handle-a",
      handleDigest: DIGEST_A,
      challengeRef: "signup-challenge-a"
    });
    insertPending(database, {
      intentId: uuid(2),
      accountId: uuid(102),
      handleRef: "signup-handle-b",
      handleDigest: DIGEST_C,
      challengeRef: "signup-challenge-b"
    });
    expect((database.prepare(`
      SELECT COUNT(*) AS count FROM passkey_signup_intents
    `).get() as { count: number }).count).toBe(2);
    expect(() => insertPending(database!, {
      intentId: uuid(3),
      accountId: uuid(101),
      handleRef: "signup-handle-c",
      handleDigest: DIGEST_D,
      challengeRef: "signup-challenge-c"
    })).toThrow();
  });

  it("enforces terminal lifecycle and reserves consumption for the atomic account slice", () => {
    database = openDatabase();
    insertPending(database, {
      intentId: uuid(10),
      accountId: uuid(110),
      handleRef: "signup-handle-expired",
      handleDigest: DIGEST_A,
      challengeRef: "signup-challenge-expired"
    });
    expect(() => database!.prepare(`
      DELETE FROM passkey_signup_intents WHERE intent_id = ?
    `).run(uuid(10))).toThrow(/pending passkey signup intent/u);
    database.prepare(`
      UPDATE passkey_signup_intents
      SET state = 'expired', revision = 2, updated_at_ms = expires_at_ms,
          terminal_at_ms = expires_at_ms, terminal_reason = 'expired'
      WHERE intent_id = ?
    `).run(uuid(10));
    expect((database.prepare(`
      SELECT state, terminal_reason FROM passkey_signup_intents WHERE intent_id = ?
    `).get(uuid(10)) as { state: string; terminal_reason: string })).toEqual({
      state: "expired",
      terminal_reason: "expired"
    });

    insertPending(database, {
      intentId: uuid(11),
      accountId: uuid(111),
      handleRef: "signup-handle-consumed-a",
      handleDigest: DIGEST_C,
      challengeRef: "signup-challenge-consumed-a"
    });
    expect(() => database!.prepare(`
      UPDATE passkey_signup_intents
      SET state = 'consumed', revision = 2, updated_at_ms = updated_at_ms + 1,
          terminal_at_ms = updated_at_ms + 1, terminal_reason = 'verified',
          resolved_credential_record_id = 'future-credential-claim'
      WHERE intent_id = ?
    `).run(uuid(11))).toThrow(/requires atomic account creation/u);
    expect(() => database!.prepare(`
      UPDATE passkey_signup_intents
      SET resolved_credential_record_id = 'uncommitted-credential'
      WHERE intent_id = ?
    `).run(uuid(11))).toThrow();
  });

  it("accepts only public-safe event, outbox and receipt payloads", () => {
    database = openDatabase();
    const intentId = uuid(20);
    insertPending(database, {
      intentId,
      accountId: uuid(120),
      handleRef: "signup-handle-events",
      handleDigest: DIGEST_A,
      challengeRef: "signup-challenge-events"
    });
    const eventId = "signup-event-started";
    const commandScope = "signup-command-started";
    const eventJson = JSON.stringify({
      type: "passkey.signup.started",
      intentId,
      revision: 1,
      state: "pending"
    });
    database.prepare(`
      INSERT INTO passkey_signup_events (
        event_id, intent_id, revision, event_type, command_scope, occurred_at_ms, event_json
      ) VALUES (?, ?, 1, 'passkey.signup.started', ?, ?, ?)
    `).run(eventId, intentId, commandScope, NOW_MS, eventJson);
    database.prepare(`
      INSERT INTO passkey_signup_outbox (
        outbox_id, event_id, topic, partition_key, available_at_ms, payload_json
      ) VALUES (?, ?, 'luxora.passkey-signup.v1', ?, ?, ?)
    `).run("signup-outbox-started", eventId, intentId, NOW_MS, eventJson);
    database.prepare(`
      INSERT INTO passkey_signup_command_receipts (
        scope, fingerprint, intent_id, result_revision, result_state,
        event_id, result_json, created_at_ms
      ) VALUES (?, ?, ?, 1, 'pending', ?, ?, ?)
    `).run(
      commandScope,
      DIGEST_A,
      intentId,
      eventId,
      JSON.stringify({ intentId, revision: 1, state: "pending" }),
      NOW_MS
    );
    const leakyIntentId = uuid(21);
    insertPending(database, {
      intentId: leakyIntentId,
      accountId: uuid(121),
      handleRef: "signup-handle-leaky-event",
      handleDigest: DIGEST_C,
      challengeRef: "signup-challenge-leaky-event"
    });
    expect(() => database!.prepare(`
      INSERT INTO passkey_signup_events (
        event_id, intent_id, revision, event_type, command_scope, occurred_at_ms, event_json
      ) VALUES (?, ?, 1, 'passkey.signup.started', ?, ?, ?)
    `).run(
      "signup-event-leaky",
      leakyIntentId,
      "signup-command-leaky",
      NOW_MS,
      JSON.stringify({
        type: "passkey.signup.started",
        intentId: leakyIntentId,
        revision: 1,
        state: "pending",
        username: "leak"
      })
    )).toThrow();
    expect(JSON.stringify(database.prepare(`
      SELECT event_json FROM passkey_signup_events WHERE event_id = ?
    `).get(eventId))).not.toMatch(/username|display|challenge|handle/iu);
  });
});
