import { createHash } from "node:crypto";

import Database from "better-sqlite3";

import type { ContentCipher } from "../infrastructure/content-cipher.js";

export interface ExistingPasskeyCredentialFixtureInput {
  readonly databasePath: string;
  readonly cipher: ContentCipher;
  readonly accountId: string;
  readonly sessionId: string;
  readonly userHandleRef: string;
  readonly credentialId: string;
  readonly recordId: string;
  readonly nowMs: number;
  readonly targetDigest: string;
}

export interface ExistingPasskeyCredentialFixtureResult {
  readonly authenticationCeremonyId: string;
  readonly registrationCeremonyId: string;
}

function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/**
 * Migration/bootstrap fixture only. It creates the one pre-existing passkey
 * needed to exercise the real service step-up flow while satisfying every
 * migration-010 source, grant, registration and encryption trigger. When the
 * migration-014 tables already exist it also creates the encrypted active
 * lifecycle row and its exact registered event/outbox in the same transaction.
 * Product
 * code must never import this helper or treat it as an authenticator bootstrap.
 */
export function seedExistingPasskeyCredentialForTest(
  input: ExistingPasskeyCredentialFixtureInput
): ExistingPasskeyCredentialFixtureResult {
  const authenticationCeremonyId = `fixture-authentication-${input.recordId}`;
  const registrationCeremonyId = `fixture-registration-${input.recordId}`;
  const authenticationEventId = `fixture-auth-event-${input.recordId}`;
  const registrationEventId = `fixture-registration-event-${input.recordId}`;
  const issuedAtSec = Math.floor(input.nowMs / 1_000);
  const expiresAtSec = issuedAtSec + 300;
  const credentialIdCiphertext = input.cipher.encrypt(
    input.credentialId,
    `passkey-credential-id:${input.recordId}`
  );
  const credentialMaterialCiphertext = input.cipher.encrypt(JSON.stringify({
    accountId: input.accountId,
    algorithm: -7,
    credentialSetRef: null,
    discoveryMode: "discoverable",
    publicKey: Buffer.from([0xa5, 0x01, 0x02, 0x03]).toString("base64url"),
    transports: ["internal"],
    userHandleRef: input.userHandleRef
  }), `passkey-credential-material:${input.recordId}`);

  const database = new Database(input.databasePath);
  database.pragma("foreign_keys = ON");
  try {
    database.transaction(() => {
      database.prepare(`
        INSERT INTO passkey_ceremonies (
          ceremony_id, schema_version, kind, purpose_type, purpose_target_digest,
          account_id, session_id, device_id, user_handle_ref, challenge_reference,
          challenge_digest, state, revision, attempts_used, max_attempts,
          expires_at_ms, updated_at_ms, snapshot_json
        ) VALUES (
          @ceremonyId, 1, @kind, @purpose, @targetDigest,
          @accountId, @sessionId, @sessionId, @userHandleRef, @challengeReference,
          @challengeDigest, 'consumed', 2, 0, 3,
          @expiresAtMs, @nowMs, @snapshotJson
        )
      `).run({
        ceremonyId: authenticationCeremonyId,
        kind: "authentication",
        purpose: "session.step_up",
        targetDigest: input.targetDigest,
        accountId: input.accountId,
        sessionId: input.sessionId,
        userHandleRef: null,
        challengeReference: `fixture-auth-challenge-${input.recordId}`,
        challengeDigest: digest(`fixture-auth-challenge:${input.recordId}`),
        expiresAtMs: input.nowMs + 300_000,
        nowMs: input.nowMs,
        snapshotJson: JSON.stringify({ terminalReason: "verified", terminalAtMs: input.nowMs })
      });
      database.prepare(`
        INSERT INTO passkey_ceremony_events (
          event_id, ceremony_id, revision, event_type, command_id, occurred_at_ms, event_json
        ) VALUES (?, ?, 2, 'passkey.ceremony.consumed', ?, ?, '{}')
      `).run(
        authenticationEventId,
        authenticationCeremonyId,
        `fixture-auth-command-${input.recordId}`,
        input.nowMs
      );

      database.prepare(`
        INSERT INTO passkey_step_up_grants (
          authentication_ceremony_id, account_id, session_id, device_id,
          purpose, target_digest, auth_time_sec, issued_at_sec, expires_at_sec,
          consumed_at_sec, registration_ceremony_id
        ) VALUES (?, ?, ?, ?, 'authenticator.add', ?, ?, ?, ?, NULL, NULL)
      `).run(
        authenticationCeremonyId,
        input.accountId,
        input.sessionId,
        input.sessionId,
        input.targetDigest,
        issuedAtSec,
        issuedAtSec,
        expiresAtSec
      );

      database.prepare(`
        INSERT INTO passkey_ceremonies (
          ceremony_id, schema_version, kind, purpose_type, purpose_target_digest,
          account_id, session_id, device_id, user_handle_ref, challenge_reference,
          challenge_digest, state, revision, attempts_used, max_attempts,
          expires_at_ms, updated_at_ms, snapshot_json
        ) VALUES (
          @ceremonyId, 1, 'registration', 'authenticator.add', @targetDigest,
          @accountId, @sessionId, @sessionId, @userHandleRef, @challengeReference,
          @challengeDigest, 'consumed', 2, 0, 3,
          @expiresAtMs, @nowMs, @snapshotJson
        )
      `).run({
        ceremonyId: registrationCeremonyId,
        targetDigest: input.targetDigest,
        accountId: input.accountId,
        sessionId: input.sessionId,
        userHandleRef: input.userHandleRef,
        challengeReference: `fixture-registration-challenge-${input.recordId}`,
        challengeDigest: digest(`fixture-registration-challenge:${input.recordId}`),
        expiresAtMs: input.nowMs + 300_000,
        nowMs: input.nowMs,
        snapshotJson: JSON.stringify({ terminalReason: "verified", terminalAtMs: input.nowMs })
      });
      database.prepare(`
        INSERT INTO passkey_ceremony_events (
          event_id, ceremony_id, revision, event_type, command_id, occurred_at_ms, event_json
        ) VALUES (?, ?, 2, 'passkey.ceremony.consumed', ?, ?, '{}')
      `).run(
        registrationEventId,
        registrationCeremonyId,
        `fixture-registration-command-${input.recordId}`,
        input.nowMs
      );

      const consumed = database.prepare(`
        UPDATE passkey_step_up_grants
        SET consumed_at_sec = ?, registration_ceremony_id = ?
        WHERE authentication_ceremony_id = ?
          AND consumed_at_sec IS NULL
          AND registration_ceremony_id IS NULL
      `).run(issuedAtSec, registrationCeremonyId, authenticationCeremonyId);
      if (consumed.changes !== 1) throw new Error("test fixture could not consume its synthetic grant");

      database.prepare(`
        INSERT INTO passkey_credentials (
          record_id, credential_id_digest, credential_id_ciphertext, account_id,
          user_handle_ref, credential_material_ciphertext, algorithm, discovery_mode,
          credential_set_ref, revision, sign_count, backup_eligible, backup_state,
          registration_ceremony_id, created_at_ms, updated_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?, -7, 'discoverable', NULL, 1, 0, 1, 0, ?, ?, ?)
      `).run(
        input.recordId,
        digest(input.credentialId),
        credentialIdCiphertext,
        input.accountId,
        input.userHandleRef,
        credentialMaterialCiphertext,
        registrationCeremonyId,
        input.nowMs,
        input.nowMs
      );

      const hasAuthenticatorManagement = database.prepare(`
        SELECT 1 AS present FROM sqlite_master
        WHERE type = 'table' AND name = 'passkey_authenticator_metadata'
      `).get() as { present: number } | undefined;
      if (hasAuthenticatorManagement !== undefined) {
        const bindingDigest = digest(JSON.stringify([
          input.accountId,
          input.recordId,
          input.nowMs
        ]));
        const authenticatorEventId = `authenticator-event:registered:${bindingDigest}`;
        const commandScope = `system:authenticator-register:${bindingDigest}`;
        const fingerprint = digest(JSON.stringify([
          "passkey.authenticator.registered",
          input.accountId,
          input.recordId,
          input.nowMs
        ]));
        const displayNameCiphertext = input.cipher.encrypt(
          "Ключ доступа",
          `passkey-authenticator-name:${input.recordId}:${input.accountId}`
        );
        database.prepare(`
          INSERT INTO passkey_authenticator_metadata (
            credential_record_id, account_id, display_name_ciphertext,
            lifecycle_state, revision, created_at_ms, updated_at_ms, revoked_at_ms
          ) VALUES (?, ?, ?, 'active', 1, ?, ?, NULL)
        `).run(
          input.recordId,
          input.accountId,
          displayNameCiphertext,
          input.nowMs,
          input.nowMs
        );
        const eventJson = JSON.stringify({
          schemaVersion: 1,
          eventId: authenticatorEventId,
          type: "passkey.authenticator.registered",
          accountId: input.accountId,
          authenticatorId: input.recordId,
          revision: 1,
          lifecycleState: "active",
          occurredAtMs: input.nowMs
        });
        database.prepare(`
          INSERT INTO passkey_authenticator_events (
            event_id, credential_record_id, account_id, revision, event_type,
            command_scope, fingerprint, occurred_at_ms, event_json
          ) VALUES (?, ?, ?, 1, 'passkey.authenticator.registered', ?, ?, ?, ?)
        `).run(
          authenticatorEventId,
          input.recordId,
          input.accountId,
          commandScope,
          fingerprint,
          input.nowMs,
          eventJson
        );
        database.prepare(`
          INSERT INTO passkey_authenticator_outbox (
            outbox_id, event_id, topic, partition_key, available_at_ms, payload_json
          ) VALUES (?, ?, 'luxora.passkey-authenticator.v1', ?, ?, ?)
        `).run(
          `authenticator-outbox:registered:${bindingDigest}`,
          authenticatorEventId,
          input.accountId,
          input.nowMs,
          eventJson
        );
      }
    }).immediate();
  } finally {
    database.close();
  }

  return Object.freeze({ authenticationCeremonyId, registrationCeremonyId });
}
