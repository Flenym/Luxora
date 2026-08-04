import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { migrations } from "./infrastructure/migrations.js";

const NOW_MS = 1_800_000_000_000;
const TIMEOUT_MS = 300_000;
const ACCESS_TOKEN_TTL_SECONDS = 900;
const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;
const RECOVERY_GRACE_SECONDS = 300;

function testUuid(sequence: number): string {
  return `00000000-0000-4000-8000-${sequence.toString(16).padStart(12, "0")}`;
}

const ACCOUNT_ID = testUuid(1);
const SESSION_ID = testUuid(2);
const HANDLE_REF = "login-handle";
const CREDENTIAL_ID = testUuid(3);
const REGISTRATION_ID = testUuid(4);
const PRIVACY_INTENT_ID = testUuid(5);
const VALID_KEY_INTENT_ID = testUuid(6);
const NUL_DIGEST_INTENT_ID = testUuid(7);
const TRANSITION_INTENT_ID = testUuid(8);
const SUCCESS_INTENT_ID = testUuid(9);
const DUPLICATE_CLAIM_INTENT_ID = testUuid(10);
const STALE_INTENT_ID = testUuid(11);
const COLLISION_INTENT_ID = testUuid(12);
const EXCLUSIVE_INTENT_ID = testUuid(13);
const LOGIN_SESSION_ID = testUuid(14);
const LOGIN_REFRESH_ID = testUuid(15);
const DUPLICATE_SESSION_ID = testUuid(16);
const DUPLICATE_REFRESH_ID = testUuid(17);
const REVOKED_SESSION_ID = testUuid(18);
const REVOKED_REFRESH_ID = testUuid(19);
const DIGEST_A = "a".repeat(64);
const DIGEST_B = "b".repeat(64);
const DIGEST_C = "c".repeat(64);
const ACCESS_EXPIRES_AT_SEC = Math.floor((NOW_MS + 10) / 1_000)
  + ACCESS_TOKEN_TTL_SECONDS;

interface PendingIntentInput {
  intentId: string;
  challengeReference: string;
  targetDigest?: string;
  refreshKeyId?: string;
  accessTokenTtlSeconds?: number;
  sessionTtlSeconds?: number;
  recoveryGraceSeconds?: number;
  createdAtMs?: number;
}

function applyThrough(database: Database.Database, count: number): void {
  for (const migration of migrations.slice(0, count)) database.exec(migration.sql);
}

function seedCredentialPrerequisites(database: Database.Database): void {
  database.prepare(`
    INSERT INTO users (
      id, username, username_normalized, display_name, password_hash, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    ACCOUNT_ID,
    "login_account",
    "login_account",
    "Login Account",
    "test-only-password-hash",
    "2027-01-15T08:00:00.000Z",
    "2027-01-15T08:00:00.000Z"
  );
  database.prepare(`
    INSERT INTO device_sessions (
      id, user_id, device_name, created_at, last_seen_at, expires_at
    ) VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    SESSION_ID,
    ACCOUNT_ID,
    "Credential registration session",
    "2027-01-15T08:00:00.000Z",
    "2027-01-15T08:00:00.000Z",
    "2027-02-15T08:00:00.000Z"
  );
  database.prepare(`
    INSERT INTO passkey_user_handles (
      reference, account_id, handle_digest, handle_ciphertext, created_at_ms
    ) VALUES (?, ?, ?, ?, ?)
  `).run(HANDLE_REF, ACCOUNT_ID, DIGEST_A, "luxora:v1.encrypted-handle", NOW_MS - 10);
  database.prepare(`
    INSERT INTO passkey_ceremonies (
      ceremony_id, schema_version, kind, purpose_type, purpose_target_digest,
      account_id, session_id, device_id, user_handle_ref, challenge_reference,
      challenge_digest, state, revision, attempts_used, max_attempts,
      expires_at_ms, updated_at_ms, snapshot_json
    ) VALUES (?, 1, 'registration', 'authenticator.add', ?, ?, ?, ?, ?, ?, ?,
      'consumed', 2, 0, 3, ?, ?, '{}')
  `).run(
    REGISTRATION_ID,
    DIGEST_B,
    ACCOUNT_ID,
    SESSION_ID,
    SESSION_ID,
    HANDLE_REF,
    "registration-challenge",
    DIGEST_C,
    NOW_MS + TIMEOUT_MS,
    NOW_MS
  );
  database.prepare(`
    INSERT INTO passkey_credentials (
      record_id, credential_id_digest, credential_id_ciphertext, account_id,
      user_handle_ref, credential_material_ciphertext, algorithm, discovery_mode,
      credential_set_ref, revision, sign_count, backup_eligible, backup_state,
      registration_ceremony_id, created_at_ms, updated_at_ms
    ) VALUES (?, ?, ?, ?, ?, ?, -7, 'discoverable', NULL, 1, 0, 1, 0, ?, ?, ?)
  `).run(
    CREDENTIAL_ID,
    DIGEST_C,
    "luxora:v1.encrypted-credential-id",
    ACCOUNT_ID,
    HANDLE_REF,
    "luxora:v1.encrypted-credential-material",
    REGISTRATION_ID,
    NOW_MS,
    NOW_MS
  );
}

function openMigratedDatabase(): Database.Database {
  const database = new Database(":memory:");
  database.pragma("foreign_keys = ON");
  // Seed one structurally valid discoverable credential before migration 010
  // installs the runtime authorization trigger. Migration 011 must preserve
  // and safely reference credentials created by the existing 009 contract.
  applyThrough(database, 9);
  seedCredentialPrerequisites(database);
  database.exec(migrations[9]!.sql);
  database.exec(migrations[10]!.sql);
  return database;
}

function insertPendingIntent(database: Database.Database, input: PendingIntentInput): void {
  database.prepare(`
    INSERT INTO passkey_login_intents (
      intent_id, schema_version, purpose_type, purpose_target_digest,
      policy_version, access_token_ttl_seconds, session_ttl_seconds,
      recovery_grace_seconds, expected_rp_id, expected_origin, timeout_ms,
      max_response_bytes, max_attempts, allowed_algorithms_json,
      user_verification, cross_origin_allowed, credential_boundary,
      challenge_reference, challenge_digest, delivery_nonce_digest,
      refresh_derivation_key_id, state, revision, attempts_used,
      created_at_ms, expires_at_ms, updated_at_ms
    ) VALUES (
      @intentId, 1, 'session.create', @targetDigest,
      1, @accessTokenTtlSeconds, @sessionTtlSeconds, @recoveryGraceSeconds,
      'auth.luxora.app', 'https://auth.luxora.app', @timeoutMs,
      65536, 3, '[-7,-257]', 'required', 0, 'discoverable_any',
      @challengeReference, @challengeDigest, @deliveryNonceDigest,
      @refreshKeyId, 'pending', 1, 0,
      @nowMs, @expiresAtMs, @nowMs
    )
  `).run({
    intentId: input.intentId,
    targetDigest: input.targetDigest ?? DIGEST_A,
    timeoutMs: TIMEOUT_MS,
    accessTokenTtlSeconds: input.accessTokenTtlSeconds ?? ACCESS_TOKEN_TTL_SECONDS,
    sessionTtlSeconds: input.sessionTtlSeconds ?? SESSION_TTL_SECONDS,
    recoveryGraceSeconds: input.recoveryGraceSeconds ?? RECOVERY_GRACE_SECONDS,
    challengeReference: input.challengeReference,
    challengeDigest: DIGEST_B,
    deliveryNonceDigest: DIGEST_C,
    refreshKeyId: input.refreshKeyId ?? "passkey-login-refresh-v1",
    nowMs: input.createdAtMs ?? NOW_MS,
    expiresAtMs: (input.createdAtMs ?? NOW_MS) + TIMEOUT_MS
  });
}

function insertStartedRecords(database: Database.Database, intentId: string): void {
  const eventId = `${intentId}-started-event`;
  const commandScope = `${intentId}-begin-command`;
  database.prepare(`
    INSERT INTO passkey_login_events (
      event_id, intent_id, revision, event_type, command_scope,
      occurred_at_ms, event_json
    ) VALUES (?, ?, 1, 'passkey.login.started', ?, ?, ?)
  `).run(eventId, intentId, commandScope, NOW_MS, JSON.stringify({
    type: "passkey.login.started",
    intentId,
    revision: 1,
    state: "pending"
  }));
  database.prepare(`
    INSERT INTO passkey_login_outbox (
      outbox_id, event_id, topic, partition_key, available_at_ms, payload_json
    ) VALUES (?, ?, 'luxora.passkey-login.v1', ?, ?, ?)
  `).run(`${intentId}-started-outbox`, eventId, intentId, NOW_MS, JSON.stringify({
    type: "passkey.login.started",
    intentId,
    revision: 1,
    state: "pending"
  }));
  database.prepare(`
    INSERT INTO passkey_login_command_receipts (
      scope, fingerprint, intent_id, result_revision, result_state,
      event_id, result_json, created_at_ms
    ) VALUES (?, ?, ?, 1, 'pending', ?, ?, ?)
  `).run(commandScope, DIGEST_A, intentId, eventId, JSON.stringify({
    intentId,
    revision: 1,
    state: "pending"
  }), NOW_MS);
  database.prepare(`
    INSERT INTO passkey_login_creation_receipts (
      scope, fingerprint, intent_id, result_revision, result_state,
      event_id, result_json, created_at_ms
    ) VALUES (?, ?, ?, 1, 'pending', ?, ?, ?)
  `).run(`${intentId}-creation`, DIGEST_B, intentId, eventId, JSON.stringify({
    intentId,
    revision: 1,
    state: "pending"
  }), NOW_MS);
}

describe("migration 011 anonymous passkey login invariants", () => {
  const databases: Database.Database[] = [];

  afterEach(() => {
    for (const database of databases.splice(0)) database.close();
  });

  function open(): Database.Database {
    const database = openMigratedDatabase();
    databases.push(database);
    return database;
  }

  it("stores only challenge/delivery digests and a derivation key identifier before authentication", () => {
    const database = open();
    insertPendingIntent(database, {
      intentId: PRIVACY_INTENT_ID,
      challengeReference: "privacy-login-challenge"
    });

    const columns = (database.pragma("table_info(passkey_login_intents)") as Array<{ name: string }>)
      .map(({ name }) => name);
    expect(columns).toEqual(expect.arrayContaining([
      "challenge_reference",
      "challenge_digest",
      "delivery_nonce_digest",
      "refresh_derivation_key_id",
      "access_token_ttl_seconds",
      "session_ttl_seconds",
      "recovery_grace_seconds"
    ]));
    expect(columns).not.toEqual(expect.arrayContaining([
      "challenge",
      "delivery_nonce",
      "raw_nonce",
      "refresh_token",
      "raw_refresh_token",
      "credential_id",
      "user_handle"
    ]));
    expect(database.prepare(`
      SELECT state, resolved_account_id, resolved_credential_record_id,
             session_id, initial_refresh_token_id,
             initial_access_token_expires_at_sec
      FROM passkey_login_intents WHERE intent_id = ?
    `).get(PRIVACY_INTENT_ID)).toEqual({
      state: "pending",
      resolved_account_id: null,
      resolved_credential_record_id: null,
      session_id: null,
      initial_refresh_token_id: null,
      initial_access_token_expires_at_sec: null
    });
  });

  it("pins canonical UUIDs and a feasible immutable policy-v1 lifetime envelope", () => {
    const database = open();
    expect(() => insertPendingIntent(database, {
      intentId: "AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA",
      challengeReference: "uppercase-uuid-challenge"
    })).toThrow();
    expect(() => insertPendingIntent(database, {
      intentId: "not-a-uuid",
      challengeReference: "malformed-uuid-challenge"
    })).toThrow();
    expect(() => insertPendingIntent(database, {
      intentId: "00000000-0000-0000-0000-000000000000",
      challengeReference: "nil-uuid-challenge"
    })).toThrow();
    expect(() => insertPendingIntent(database, {
      intentId: "00000000-0000-4000-7000-000000000001",
      challengeReference: "wrong-variant-uuid-challenge"
    })).toThrow();
    expect(() => insertPendingIntent(database, {
      intentId: testUuid(200),
      challengeReference: "short-session-policy-challenge",
      sessionTtlSeconds: 86_399
    })).toThrow();
    expect(() => insertPendingIntent(database, {
      intentId: testUuid(201),
      challengeReference: "long-recovery-policy-challenge",
      recoveryGraceSeconds: 301
    })).toThrow();
    expect(() => insertPendingIntent(database, {
      intentId: testUuid(202),
      challengeReference: "fractional-infeasible-policy-challenge",
      createdAtMs: NOW_MS + 1,
      accessTokenTtlSeconds: 600
    })).toThrow();

    insertPendingIntent(database, {
      intentId: testUuid(203),
      challengeReference: "fractional-feasible-policy-challenge",
      createdAtMs: NOW_MS + 1,
      accessTokenTtlSeconds: 601
    });
    expect(database.prepare(`
      SELECT access_token_ttl_seconds, session_ttl_seconds, recovery_grace_seconds
      FROM passkey_login_intents WHERE intent_id = ?
    `).get(testUuid(203))).toEqual({
      access_token_ttl_seconds: 601,
      session_ttl_seconds: SESSION_TTL_SECONDS,
      recovery_grace_seconds: RECOVERY_GRACE_SECONDS
    });
    expect(() => database.prepare(`
      UPDATE passkey_login_intents SET recovery_grace_seconds = 299 WHERE intent_id = ?
    `).run(testUuid(203))).toThrow();
    expect((database.prepare(`
      SELECT recovery_grace_seconds FROM passkey_login_intents WHERE intent_id = ?
    `).get(testUuid(203)) as { recovery_grace_seconds: number }).recovery_grace_seconds)
      .toBe(RECOVERY_GRACE_SECONDS);
  });

  it("pins refresh derivation key IDs to the crypto module's recoverable format", () => {
    const database = open();
    for (const [index, refreshKeyId] of [
      ".leading-dot",
      "-leading-dash",
      "colon:key",
      "space key",
      `v1${String.fromCharCode(0)}:hidden`
    ].entries()) {
      expect(() => insertPendingIntent(database, {
        intentId: testUuid(100 + index),
        challengeReference: `invalid-key-challenge-${index}`,
        refreshKeyId
      })).toThrow();
    }
    insertPendingIntent(database, {
      intentId: VALID_KEY_INTENT_ID,
      challengeReference: "valid-key-challenge",
      refreshKeyId: "v1.active_key-01"
    });
    expect(() => insertPendingIntent(database, {
      intentId: NUL_DIGEST_INTENT_ID,
      challengeReference: "nul-digest-challenge",
      targetDigest: `${DIGEST_A}${String.fromCharCode(0)}hidden`
    })).toThrow();
  });

  it("enforces initial state, immutable binding and monotonic rejected-attempt transitions", () => {
    const database = open();
    insertPendingIntent(database, {
      intentId: TRANSITION_INTENT_ID,
      challengeReference: "transition-login-challenge"
    });

    expect(() => database.prepare(`
      UPDATE passkey_login_intents
      SET purpose_target_digest = ?
      WHERE intent_id = ?
    `).run(DIGEST_B, TRANSITION_INTENT_ID)).toThrow();
    expect((database.prepare(`
      SELECT purpose_target_digest FROM passkey_login_intents WHERE intent_id = ?
    `).get(TRANSITION_INTENT_ID) as { purpose_target_digest: string }).purpose_target_digest)
      .toBe(DIGEST_A);
    expect(() => database.prepare(`
      UPDATE passkey_login_intents
      SET revision = 3, attempts_used = 1, updated_at_ms = ?
      WHERE intent_id = ?
    `).run(NOW_MS + 1, TRANSITION_INTENT_ID))
      .toThrow(/invalid passkey login intent transition/u);

    database.prepare(`
      UPDATE passkey_login_intents
      SET revision = 2, attempts_used = 1, updated_at_ms = ?
      WHERE intent_id = ?
    `).run(NOW_MS + 1, TRANSITION_INTENT_ID);
    expect(database.prepare(`
      SELECT state, revision, attempts_used, terminal_at_ms
      FROM passkey_login_intents WHERE intent_id = ?
    `).get(TRANSITION_INTENT_ID)).toEqual({
      state: "pending",
      revision: 2,
      attempts_used: 1,
      terminal_at_ms: null
    });

    expect(() => database.prepare(`
      UPDATE passkey_login_intents
      SET state = 'rejected', revision = 3, attempts_used = 3,
          updated_at_ms = ?, terminal_at_ms = ?, terminal_reason = 'attempts_exhausted'
      WHERE intent_id = ?
    `).run(NOW_MS + 2, NOW_MS + 2, TRANSITION_INTENT_ID))
      .toThrow(/invalid passkey login intent transition/u);

    database.prepare(`
      UPDATE passkey_login_intents
      SET revision = 3, attempts_used = 2, updated_at_ms = ?
      WHERE intent_id = ?
    `).run(NOW_MS + 2, TRANSITION_INTENT_ID);
    database.prepare(`
      UPDATE passkey_login_intents
      SET state = 'rejected', revision = 4, attempts_used = 3,
          updated_at_ms = ?, terminal_at_ms = ?, terminal_reason = 'attempts_exhausted'
      WHERE intent_id = ?
    `).run(NOW_MS + 3, NOW_MS + 3, TRANSITION_INTENT_ID);
    expect(database.prepare(`
      SELECT state, revision, attempts_used, terminal_reason
      FROM passkey_login_intents WHERE intent_id = ?
    `).get(TRANSITION_INTENT_ID)).toEqual({
      state: "rejected",
      revision: 4,
      attempts_used: 3,
      terminal_reason: "attempts_exhausted"
    });
    expect(() => database.prepare(`
      UPDATE passkey_login_intents SET revision = 5 WHERE intent_id = ?
    `).run(TRANSITION_INTENT_ID)).toThrow(/invalid passkey login intent transition/u);
  });

  it("requires a matching discoverable credential CAS, account, session and unused initial refresh", () => {
    const database = open();
    insertPendingIntent(database, {
      intentId: SUCCESS_INTENT_ID,
      challengeReference: "success-login-challenge"
    });
    insertStartedRecords(database, SUCCESS_INTENT_ID);

    const loginSessionId = LOGIN_SESSION_ID;
    const refreshTokenId = LOGIN_REFRESH_ID;
    const committedAtMs = NOW_MS + 10;
    const sessionCreatedAt = new Date(committedAtMs).toISOString();
    const sessionExpiresAt = new Date(
      committedAtMs + SESSION_TTL_SECONDS * 1_000
    ).toISOString();
    database.transaction(() => {
      database.prepare(`
        UPDATE passkey_credentials
        SET revision = revision + 1, sign_count = 0, backup_state = 0,
            updated_at_ms = ?
        WHERE record_id = ? AND revision = 1 AND sign_count = 0
      `).run(committedAtMs, CREDENTIAL_ID);
      database.prepare(`
        INSERT INTO device_sessions (
          id, user_id, device_name, created_at, last_seen_at, expires_at
        ) VALUES (?, ?, ?, ?, ?, ?)
      `).run(
        loginSessionId,
        ACCOUNT_ID,
        "Passkey login device",
        sessionCreatedAt,
        sessionCreatedAt,
        sessionExpiresAt
      );
      database.prepare(`
        INSERT INTO refresh_tokens (
          id, session_id, token_hash, created_at, expires_at
        ) VALUES (?, ?, ?, ?, ?)
      `).run(
        refreshTokenId,
        loginSessionId,
        "A".repeat(43),
        sessionCreatedAt,
        sessionExpiresAt
      );
      database.prepare(`
        UPDATE passkey_login_intents
        SET state = 'consumed', revision = 2, updated_at_ms = ?,
            terminal_at_ms = ?, terminal_reason = 'verified',
            resolved_account_id = ?, resolved_user_handle_ref = ?,
            resolved_credential_record_id = ?,
            resolved_credential_revision_before = 1,
            resolved_credential_revision_after = 2,
            resolved_sign_count_before = 0, resolved_observed_sign_count = 0,
            resolved_sign_count_after = 0,
            resolved_backup_eligible = 1,
            resolved_backup_state_before = 0, resolved_backup_state_after = 0,
            session_id = ?, initial_refresh_token_id = ?,
            initial_access_token_expires_at_sec = ?
        WHERE intent_id = ?
      `).run(
        committedAtMs,
        committedAtMs,
        ACCOUNT_ID,
        HANDLE_REF,
        CREDENTIAL_ID,
        loginSessionId,
        refreshTokenId,
        ACCESS_EXPIRES_AT_SEC,
        SUCCESS_INTENT_ID
      );
      database.prepare(`
        INSERT INTO passkey_login_events (
          event_id, intent_id, revision, event_type, command_scope,
          occurred_at_ms, event_json
        ) VALUES (?, ?, 2, 'passkey.login.consumed', ?, ?, ?)
      `).run(
        `${SUCCESS_INTENT_ID}-consumed-event`,
        SUCCESS_INTENT_ID,
        `${SUCCESS_INTENT_ID}-verify-command`,
        committedAtMs,
        JSON.stringify({
          type: "passkey.login.consumed",
          intentId: SUCCESS_INTENT_ID,
          revision: 2,
          state: "consumed"
        })
      );
      database.prepare(`
        INSERT INTO passkey_login_command_receipts (
          scope, fingerprint, intent_id, result_revision, result_state,
          event_id, result_json, created_at_ms
        ) VALUES (?, ?, ?, 2, 'consumed', ?, ?, ?)
      `).run(
        `${SUCCESS_INTENT_ID}-verify-command`,
        DIGEST_C,
        SUCCESS_INTENT_ID,
        `${SUCCESS_INTENT_ID}-consumed-event`,
        JSON.stringify({ intentId: SUCCESS_INTENT_ID, revision: 2, state: "consumed" }),
        committedAtMs
      );
    })();

    expect(database.prepare(`
      SELECT state, revision, resolved_credential_revision_before,
             resolved_credential_revision_after, resolved_sign_count_before,
             resolved_observed_sign_count, resolved_sign_count_after,
             session_id, initial_refresh_token_id,
             initial_access_token_expires_at_sec
      FROM passkey_login_intents WHERE intent_id = ?
    `).get(SUCCESS_INTENT_ID)).toEqual({
      state: "consumed",
      revision: 2,
      resolved_credential_revision_before: 1,
      resolved_credential_revision_after: 2,
      resolved_sign_count_before: 0,
      resolved_observed_sign_count: 0,
      resolved_sign_count_after: 0,
      session_id: loginSessionId,
      initial_refresh_token_id: refreshTokenId,
      initial_access_token_expires_at_sec: ACCESS_EXPIRES_AT_SEC
    });
    expect(database.prepare(`
      SELECT revision, sign_count FROM passkey_credentials WHERE record_id = ?
    `).get(CREDENTIAL_ID)).toEqual({ revision: 2, sign_count: 0 });

    insertPendingIntent(database, {
      intentId: DUPLICATE_CLAIM_INTENT_ID,
      challengeReference: "duplicate-revision-claim-challenge"
    });
    database.prepare(`
      INSERT INTO device_sessions (
        id, user_id, device_name, created_at, last_seen_at, expires_at
      ) VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      DUPLICATE_SESSION_ID,
      ACCOUNT_ID,
      "Duplicate claim device",
      sessionCreatedAt,
      sessionCreatedAt,
      sessionExpiresAt
    );
    database.prepare(`
      INSERT INTO refresh_tokens (
        id, session_id, token_hash, created_at, expires_at
      ) VALUES (?, ?, ?, ?, ?)
    `).run(
      DUPLICATE_REFRESH_ID,
      DUPLICATE_SESSION_ID,
      "D".repeat(43),
      sessionCreatedAt,
      sessionExpiresAt
    );
    expect(() => database.prepare(`
      UPDATE passkey_login_intents
      SET state = 'consumed', revision = 2, updated_at_ms = ?,
          terminal_at_ms = ?, terminal_reason = 'verified',
          resolved_account_id = ?, resolved_user_handle_ref = ?,
          resolved_credential_record_id = ?,
          resolved_credential_revision_before = 1,
          resolved_credential_revision_after = 2,
          resolved_sign_count_before = 0, resolved_observed_sign_count = 0,
          resolved_sign_count_after = 0,
          resolved_backup_eligible = 1,
          resolved_backup_state_before = 0, resolved_backup_state_after = 0,
          session_id = ?, initial_refresh_token_id = ?,
          initial_access_token_expires_at_sec = ?
      WHERE intent_id = ?
    `).run(
      committedAtMs,
      committedAtMs,
      ACCOUNT_ID,
      HANDLE_REF,
      CREDENTIAL_ID,
      DUPLICATE_SESSION_ID,
      DUPLICATE_REFRESH_ID,
      ACCESS_EXPIRES_AT_SEC,
      DUPLICATE_CLAIM_INTENT_ID
    )).toThrow(/UNIQUE constraint failed/u);
    expect(() => database.prepare(`
      UPDATE passkey_login_intents SET revision = 3 WHERE intent_id = ?
    `).run(SUCCESS_INTENT_ID)).toThrow(/invalid passkey login intent transition/u);

    database.prepare("DELETE FROM refresh_tokens WHERE id = ?").run(LOGIN_REFRESH_ID);
    database.prepare("DELETE FROM device_sessions WHERE id = ?").run(LOGIN_SESSION_ID);
    database.prepare("DELETE FROM passkey_credentials WHERE record_id = ?").run(CREDENTIAL_ID);
    expect(database.prepare(`
      SELECT state, session_id, initial_refresh_token_id
      FROM passkey_login_intents WHERE intent_id = ?
    `).get(SUCCESS_INTENT_ID)).toEqual({
      state: "consumed",
      session_id: LOGIN_SESSION_ID,
      initial_refresh_token_id: LOGIN_REFRESH_ID
    });
    expect((database.prepare(`
      SELECT COUNT(*) AS count FROM passkey_login_events WHERE intent_id = ?
    `).get(SUCCESS_INTENT_ID) as { count: number }).count).toBe(2);
    expect((database.prepare(`
      SELECT COUNT(*) AS count FROM passkey_login_command_receipts WHERE intent_id = ?
    `).get(SUCCESS_INTENT_ID) as { count: number }).count).toBe(2);
    expect((database.prepare(`
      SELECT COUNT(*) AS count FROM passkey_login_creation_receipts WHERE intent_id = ?
    `).get(SUCCESS_INTENT_ID) as { count: number }).count).toBe(1);
    expect((database.prepare(`
      SELECT COUNT(*) AS count
      FROM passkey_login_outbox outbox
      JOIN passkey_login_events events ON events.event_id = outbox.event_id
      WHERE events.intent_id = ?
    `).get(SUCCESS_INTENT_ID) as { count: number }).count).toBe(1);

    database.prepare("DELETE FROM users WHERE id = ?").run(ACCOUNT_ID);
    expect((database.prepare(`
      SELECT COUNT(*) AS count FROM passkey_login_intents WHERE intent_id = ?
    `).get(SUCCESS_INTENT_ID) as { count: number }).count).toBe(0);
    expect(database.pragma("foreign_key_check")).toEqual([]);
  });

  it("rejects consumed links when the credential revision or session eligibility is stale", () => {
    const database = open();
    insertPendingIntent(database, {
      intentId: STALE_INTENT_ID,
      challengeReference: "stale-login-challenge"
    });
    const loginSessionId = REVOKED_SESSION_ID;
    const refreshTokenId = REVOKED_REFRESH_ID;
    const createdAt = "2027-01-15T08:00:02.000Z";
    database.prepare(`
      INSERT INTO device_sessions (
        id, user_id, device_name, created_at, last_seen_at, expires_at, revoked_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      loginSessionId,
      ACCOUNT_ID,
      "Revoked device",
      createdAt,
      createdAt,
      "2027-02-15T08:00:02.000Z",
      "2027-01-15T08:00:03.000Z"
    );
    database.prepare(`
      INSERT INTO refresh_tokens (id, session_id, token_hash, created_at, expires_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(
      refreshTokenId,
      loginSessionId,
      "B".repeat(43),
      createdAt,
      "2027-02-15T08:00:02.000Z"
    );

    expect(() => database.prepare(`
      UPDATE passkey_login_intents
      SET state = 'consumed', revision = 2, updated_at_ms = ?,
          terminal_at_ms = ?, terminal_reason = 'verified',
          resolved_account_id = ?, resolved_user_handle_ref = ?,
          resolved_credential_record_id = ?,
          resolved_credential_revision_before = 1,
          resolved_credential_revision_after = 2,
          resolved_sign_count_before = 0, resolved_observed_sign_count = 0,
          resolved_sign_count_after = 0,
          resolved_backup_eligible = 1,
          resolved_backup_state_before = 0, resolved_backup_state_after = 0,
          session_id = ?, initial_refresh_token_id = ?,
          initial_access_token_expires_at_sec = ?
      WHERE intent_id = ?
    `).run(
      NOW_MS + 10,
      NOW_MS + 10,
      ACCOUNT_ID,
      HANDLE_REF,
      CREDENTIAL_ID,
      loginSessionId,
      refreshTokenId,
      ACCESS_EXPIRES_AT_SEC,
      STALE_INTENT_ID
    )).toThrow(/consumed proof is inconsistent/u);
    expect(database.prepare(`
      SELECT state, revision, session_id FROM passkey_login_intents WHERE intent_id = ?
    `).get(STALE_INTENT_ID)).toEqual({ state: "pending", revision: 1, session_id: null });
  });

  it("keeps challenge ownership exclusive and event/receipt rows append-only", () => {
    const database = open();
    expect(() => insertPendingIntent(database, {
      intentId: COLLISION_INTENT_ID,
      challengeReference: "registration-challenge"
    })).toThrow(/challenge already belongs to a ceremony/u);

    insertPendingIntent(database, {
      intentId: EXCLUSIVE_INTENT_ID,
      challengeReference: "exclusive-login-challenge"
    });
    insertStartedRecords(database, EXCLUSIVE_INTENT_ID);
    expect(() => database.prepare(`
      INSERT INTO passkey_login_command_receipts (
        scope, fingerprint, intent_id, result_revision, result_state,
        event_id, result_json, created_at_ms
      ) VALUES (?, ?, ?, 1, 'pending', ?, ?, ?)
    `).run(
      "different-command-scope",
      DIGEST_C,
      EXCLUSIVE_INTENT_ID,
      `${EXCLUSIVE_INTENT_ID}-started-event`,
      JSON.stringify({ intentId: EXCLUSIVE_INTENT_ID, revision: 1, state: "pending" }),
      NOW_MS
    )).toThrow(/command receipt does not match event/u);
    expect(() => database.prepare(`
      INSERT INTO passkey_login_creation_receipts (
        scope, fingerprint, intent_id, result_revision, result_state,
        event_id, result_json, created_at_ms
      ) VALUES (?, ?, ?, 1, 'pending', ?, ?, ?)
    `).run(
      "unsafe-creation-scope",
      DIGEST_C,
      EXCLUSIVE_INTENT_ID,
      `${EXCLUSIVE_INTENT_ID}-started-event`,
      JSON.stringify({
        intentId: EXCLUSIVE_INTENT_ID,
        revision: 1,
        state: "pending",
        accountId: "leak"
      }),
      NOW_MS
    )).toThrow(/creation result is not public-safe/u);
    expect(() => database.prepare(`
      UPDATE passkey_ceremonies SET challenge_reference = ? WHERE ceremony_id = ?
    `).run("exclusive-login-challenge", REGISTRATION_ID))
      .toThrow(/challenge already belongs to a login intent/u);

    expect(() => database.prepare(`
      UPDATE passkey_login_events SET event_json = '{}' WHERE event_id = ?
    `).run(`${EXCLUSIVE_INTENT_ID}-started-event`)).toThrow(/append-only/u);
    expect(() => database.prepare(`
      DELETE FROM passkey_login_command_receipts WHERE intent_id = ?
    `).run(EXCLUSIVE_INTENT_ID)).toThrow(/append-only/u);
    expect(() => database.prepare(`
      DELETE FROM passkey_login_creation_receipts WHERE intent_id = ?
    `).run(EXCLUSIVE_INTENT_ID)).toThrow(/append-only/u);
    expect(() => database.prepare(`
      DELETE FROM passkey_login_outbox WHERE event_id = ?
    `).run(`${EXCLUSIVE_INTENT_ID}-started-event`)).toThrow(/append-only/u);
    expect(() => database.prepare(`
      DELETE FROM passkey_login_events WHERE intent_id = ?
    `).run(EXCLUSIVE_INTENT_ID)).toThrow(/append-only/u);
  });
});
