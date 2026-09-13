export interface Migration {
  id: string;
  sql: string;
}

export const migrations: Migration[] = [
  {
    id: "001_initial",
    sql: `
      CREATE TABLE users (
        id TEXT PRIMARY KEY,
        username TEXT NOT NULL,
        username_normalized TEXT NOT NULL UNIQUE,
        display_name TEXT NOT NULL,
        bio TEXT NOT NULL DEFAULT '',
        avatar_url TEXT,
        password_hash TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        last_seen_at TEXT
      ) STRICT;

      CREATE TABLE device_sessions (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        device_name TEXT NOT NULL,
        created_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        revoked_at TEXT
      ) STRICT;
      CREATE INDEX idx_device_sessions_user ON device_sessions(user_id, created_at DESC);

      CREATE TABLE refresh_tokens (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES device_sessions(id) ON DELETE CASCADE,
        token_hash TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        used_at TEXT
      ) STRICT;
      CREATE INDEX idx_refresh_tokens_session ON refresh_tokens(session_id, created_at DESC);

      CREATE TABLE chats (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL CHECK (kind IN ('direct', 'group', 'channel')),
        title TEXT,
        avatar_url TEXT,
        direct_key TEXT UNIQUE,
        created_by TEXT NOT NULL REFERENCES users(id),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        last_message_id TEXT
      ) STRICT;

      CREATE TABLE chat_members (
        chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        role TEXT NOT NULL CHECK (role IN ('owner', 'admin', 'member')),
        joined_at TEXT NOT NULL,
        archived_at TEXT,
        muted_until TEXT,
        PRIMARY KEY (chat_id, user_id)
      ) STRICT;
      CREATE INDEX idx_chat_members_user ON chat_members(user_id, chat_id);

      CREATE TABLE messages (
        id TEXT PRIMARY KEY,
        chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
        sender_id TEXT NOT NULL REFERENCES users(id),
        kind TEXT NOT NULL CHECK (kind = 'text'),
        body TEXT,
        reply_to_message_id TEXT REFERENCES messages(id),
        client_nonce TEXT NOT NULL,
        revision INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        edited_at TEXT,
        deleted_at TEXT,
        UNIQUE (sender_id, client_nonce)
      ) STRICT;
      CREATE INDEX idx_messages_chat_order ON messages(chat_id, created_at DESC, id DESC);

      CREATE TABLE chat_reads (
        chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        last_read_message_id TEXT NOT NULL REFERENCES messages(id),
        read_at TEXT NOT NULL,
        PRIMARY KEY (chat_id, user_id)
      ) STRICT;

      CREATE TABLE message_reactions (
        message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        emoji TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (message_id, user_id, emoji)
      ) STRICT;
      CREATE INDEX idx_message_reactions_message ON message_reactions(message_id, emoji);

      CREATE TABLE realtime_events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        audience_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        event_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      ) STRICT;
      CREATE INDEX idx_realtime_events_audience_sequence
        ON realtime_events(audience_user_id, sequence);
    `
  },
  {
    id: "002_realtime_event_entities",
    sql: `
      ALTER TABLE realtime_events ADD COLUMN event_type TEXT;
      ALTER TABLE realtime_events ADD COLUMN entity_id TEXT;
      CREATE INDEX idx_realtime_events_entity ON realtime_events(entity_id, event_type);
    `
  },
  {
    id: "003_delivery_receipts",
    sql: `
      CREATE TABLE message_receipts (
        message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        delivered_at TEXT NOT NULL,
        read_at TEXT,
        PRIMARY KEY (message_id, user_id)
      ) STRICT;
      CREATE INDEX idx_message_receipts_user ON message_receipts(user_id, delivered_at DESC);
    `
  },
  {
    id: "004_rich_messaging_media",
    sql: `
      CREATE TABLE chat_topics (
        id TEXT PRIMARY KEY,
        chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
        title TEXT NOT NULL,
        created_by TEXT NOT NULL REFERENCES users(id),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        closed_at TEXT
      ) STRICT;
      CREATE INDEX idx_chat_topics_chat ON chat_topics(chat_id, created_at ASC, id ASC);

      ALTER TABLE messages ADD COLUMN topic_id TEXT REFERENCES chat_topics(id);
      ALTER TABLE messages ADD COLUMN forwarded_from_message_id TEXT REFERENCES messages(id);
      ALTER TABLE messages ADD COLUMN forwarded_from_chat_id TEXT REFERENCES chats(id);
      ALTER TABLE messages ADD COLUMN forwarded_from_sender_id TEXT REFERENCES users(id);
      ALTER TABLE messages ADD COLUMN forwarded_from_sender_name_ciphertext TEXT;
      ALTER TABLE messages ADD COLUMN forwarded_from_created_at TEXT;

      CREATE TABLE attachments (
        id TEXT PRIMARY KEY,
        owner_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        kind TEXT NOT NULL CHECK (kind IN ('image', 'video', 'video_message', 'audio', 'voice', 'file')),
        file_name_ciphertext TEXT NOT NULL,
        declared_mime_type TEXT NOT NULL,
        detected_mime_type TEXT NOT NULL,
        size_bytes INTEGER NOT NULL CHECK (size_bytes > 0),
        sha256 TEXT NOT NULL CHECK (length(sha256) = 64),
        metadata_ciphertext TEXT NOT NULL,
        storage_provider TEXT NOT NULL CHECK (storage_provider IN ('local', 's3')),
        storage_key TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL,
        linked_at TEXT,
        deleting_at TEXT,
        deleted_at TEXT
      ) STRICT;
      CREATE INDEX idx_attachments_owner_created ON attachments(owner_user_id, created_at DESC);
      CREATE INDEX idx_attachments_orphan ON attachments(linked_at, created_at) WHERE deleted_at IS NULL;

      CREATE TABLE upload_sessions (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        idempotency_key TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('image', 'video', 'video_message', 'audio', 'voice', 'file')),
        file_name_ciphertext TEXT NOT NULL,
        declared_mime_type TEXT NOT NULL,
        size_bytes INTEGER NOT NULL CHECK (size_bytes > 0),
        sha256 TEXT NOT NULL CHECK (length(sha256) = 64),
        metadata_ciphertext TEXT NOT NULL,
        storage_provider TEXT NOT NULL CHECK (storage_provider IN ('local', 's3')),
        chunk_size_bytes INTEGER NOT NULL CHECK (chunk_size_bytes > 0),
        received_bytes INTEGER NOT NULL DEFAULT 0 CHECK (received_bytes >= 0),
        status TEXT NOT NULL CHECK (status IN ('active', 'completing', 'completed', 'failed', 'expired')),
        attachment_id TEXT REFERENCES attachments(id),
        failure_code TEXT,
        expires_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        staging_cleaned_at TEXT,
        object_cleaned_at TEXT,
        UNIQUE (user_id, idempotency_key)
      ) STRICT;
      CREATE INDEX idx_upload_sessions_expiry ON upload_sessions(status, expires_at);

      CREATE TABLE upload_chunks (
        upload_id TEXT NOT NULL REFERENCES upload_sessions(id) ON DELETE CASCADE,
        chunk_index INTEGER NOT NULL CHECK (chunk_index >= 0),
        byte_offset INTEGER NOT NULL CHECK (byte_offset >= 0),
        size_bytes INTEGER NOT NULL CHECK (size_bytes > 0),
        sha256 TEXT NOT NULL CHECK (length(sha256) = 64),
        created_at TEXT NOT NULL,
        PRIMARY KEY (upload_id, chunk_index)
      ) STRICT;

      CREATE TABLE message_attachments (
        message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
        attachment_id TEXT NOT NULL REFERENCES attachments(id),
        ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
        PRIMARY KEY (message_id, attachment_id),
        UNIQUE (message_id, ordinal)
      ) STRICT;
      CREATE INDEX idx_message_attachments_attachment ON message_attachments(attachment_id, message_id);

      CREATE TABLE message_versions (
        id TEXT PRIMARY KEY,
        message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
        revision INTEGER NOT NULL CHECK (revision >= 0),
        body_ciphertext TEXT,
        editor_user_id TEXT NOT NULL REFERENCES users(id),
        created_at TEXT NOT NULL,
        UNIQUE (message_id, revision)
      ) STRICT;
      CREATE INDEX idx_message_versions_message ON message_versions(message_id, revision DESC);

      CREATE TABLE chat_pins (
        chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
        message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
        pinned_by TEXT NOT NULL REFERENCES users(id),
        pinned_at TEXT NOT NULL,
        PRIMARY KEY (chat_id, message_id)
      ) STRICT;
      CREATE INDEX idx_chat_pins_order ON chat_pins(chat_id, pinned_at DESC);

      CREATE TABLE message_search_tokens (
        message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
        key_id TEXT NOT NULL,
        token_hash TEXT NOT NULL,
        PRIMARY KEY (message_id, key_id, token_hash)
      ) STRICT;
      CREATE INDEX idx_message_search_token ON message_search_tokens(key_id, token_hash, message_id);
      CREATE INDEX idx_message_search_hash ON message_search_tokens(token_hash, message_id);

      CREATE TABLE attachment_search_tokens (
        attachment_id TEXT NOT NULL REFERENCES attachments(id) ON DELETE CASCADE,
        key_id TEXT NOT NULL,
        token_hash TEXT NOT NULL,
        PRIMARY KEY (attachment_id, key_id, token_hash)
      ) STRICT;
      CREATE INDEX idx_attachment_search_token ON attachment_search_tokens(key_id, token_hash, attachment_id);
      CREATE INDEX idx_attachment_search_hash ON attachment_search_tokens(token_hash, attachment_id);

      CREATE TABLE search_index_state (
        scope TEXT PRIMARY KEY CHECK (scope = 'all'),
        active_key_id TEXT NOT NULL,
        completed_at TEXT NOT NULL
      ) STRICT;
    `
  },
  {
    id: "005_identity_access_safety",
    sql: `
      CREATE TABLE account_privacy_settings (
        user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        username_discoverable INTEGER NOT NULL DEFAULT 1 CHECK (username_discoverable IN (0, 1)),
        message_requests TEXT NOT NULL DEFAULT 'everyone'
          CHECK (message_requests IN ('everyone', 'nobody')),
        updated_at TEXT NOT NULL
      ) STRICT;

      INSERT INTO account_privacy_settings (user_id, updated_at)
      SELECT id, created_at FROM users;

      CREATE TABLE message_requests (
        id TEXT PRIMARY KEY,
        pair_key TEXT NOT NULL,
        sender_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        recipient_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        client_nonce TEXT NOT NULL,
        body_ciphertext TEXT NOT NULL,
        link_url_ciphertext TEXT,
        sender_profile_snapshot_ciphertext TEXT NOT NULL,
        recipient_profile_snapshot_ciphertext TEXT NOT NULL,
        state TEXT NOT NULL CHECK (
          state IN ('pending', 'accepted', 'recipient_dismissed', 'expired')
        ),
        chat_id TEXT REFERENCES chats(id) ON DELETE SET NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        accepted_at TEXT,
        dismissed_at TEXT,
        UNIQUE (sender_id, client_nonce),
        CHECK (sender_id <> recipient_id)
      ) STRICT;
      CREATE UNIQUE INDEX idx_message_requests_pending_pair
        ON message_requests(pair_key) WHERE state = 'pending';
      CREATE INDEX idx_message_requests_recipient_state
        ON message_requests(recipient_id, state, created_at DESC, id DESC);
      CREATE INDEX idx_message_requests_sender_state
        ON message_requests(sender_id, state, created_at DESC, id DESC);
      CREATE INDEX idx_message_requests_expiry
        ON message_requests(state, expires_at);

      CREATE TABLE account_relationships (
        pair_key TEXT PRIMARY KEY,
        left_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        right_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        accepted_request_id TEXT REFERENCES message_requests(id) ON DELETE SET NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        CHECK (left_user_id < right_user_id),
        UNIQUE (left_user_id, right_user_id)
      ) STRICT;
      CREATE INDEX idx_account_relationships_right
        ON account_relationships(right_user_id, left_user_id);

      INSERT OR IGNORE INTO account_relationships (
        pair_key, left_user_id, right_user_id, accepted_request_id, created_at, updated_at
      )
      SELECT
        left_member.user_id || ':' || right_member.user_id,
        left_member.user_id,
        right_member.user_id,
        NULL,
        chats.created_at,
        chats.updated_at
      FROM chats
      JOIN chat_members left_member ON left_member.chat_id = chats.id
      JOIN chat_members right_member
        ON right_member.chat_id = chats.id AND left_member.user_id < right_member.user_id
      WHERE chats.kind = 'direct';

      CREATE TABLE account_blocks (
        blocker_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        blocked_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        profile_snapshot_ciphertext TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (blocker_user_id, blocked_user_id),
        CHECK (blocker_user_id <> blocked_user_id)
      ) STRICT;
      CREATE INDEX idx_account_blocks_blocked
        ON account_blocks(blocked_user_id, blocker_user_id);

      CREATE TABLE safety_reports (
        id TEXT PRIMARY KEY,
        reporter_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        subject_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        category TEXT NOT NULL CHECK (
          category IN (
            'spam', 'scam', 'harassment', 'hate', 'sexual_content',
            'violence', 'impersonation', 'self_harm', 'other'
          )
        ),
        evidence_ciphertext TEXT NOT NULL,
        comment_ciphertext TEXT,
        client_nonce TEXT NOT NULL,
        state TEXT NOT NULL DEFAULT 'submitted' CHECK (state IN ('submitted')),
        also_blocked INTEGER NOT NULL CHECK (also_blocked IN (0, 1)),
        created_at TEXT NOT NULL,
        UNIQUE (reporter_user_id, client_nonce),
        CHECK (reporter_user_id <> subject_user_id)
      ) STRICT;
      CREATE INDEX idx_safety_reports_subject_created
        ON safety_reports(subject_user_id, created_at DESC);

      CREATE TABLE identity_audit_events (
        id TEXT PRIMARY KEY,
        account_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        actor_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        action TEXT NOT NULL CHECK (action IN (
          'privacy.updated',
          'message_request.created',
          'message_request.accepted',
          'message_request.dismissed',
          'message_request.expired',
          'block.created',
          'block.removed',
          'report.submitted'
        )),
        target_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
        resource_id TEXT,
        outcome TEXT NOT NULL CHECK (outcome IN ('succeeded')),
        created_at TEXT NOT NULL
      ) STRICT;
      CREATE INDEX idx_identity_audit_account_created
        ON identity_audit_events(account_user_id, created_at DESC, id DESC);

      CREATE TRIGGER identity_audit_events_no_update
      BEFORE UPDATE ON identity_audit_events
      BEGIN
        SELECT RAISE(ABORT, 'identity audit events are append-only');
      END;

      CREATE TRIGGER identity_audit_events_no_delete
      BEFORE DELETE ON identity_audit_events
      BEGIN
        SELECT RAISE(ABORT, 'identity audit events are append-only');
      END;
    `
  },
  {
    id: "006_realtime_transactional_outbox",
    sql: `
      CREATE TABLE realtime_outbox (
        event_sequence INTEGER PRIMARY KEY
          REFERENCES realtime_events(sequence) ON DELETE CASCADE,
        available_at TEXT NOT NULL,
        attempt_count INTEGER NOT NULL DEFAULT 0
          CHECK (attempt_count >= 0 AND attempt_count <= 2147483647),
        claimed_by TEXT,
        claim_until TEXT,
        published_at TEXT,
        failed_at TEXT,
        failure_code TEXT CHECK (failure_code IN ('event_unreadable', 'publish_failed')),
        CHECK (
          (claimed_by IS NULL AND claim_until IS NULL) OR
          (claimed_by IS NOT NULL AND claim_until IS NOT NULL)
        ),
        CHECK (published_at IS NULL OR claimed_by IS NULL),
        CHECK ((failed_at IS NULL) = (failure_code IS NULL)),
        CHECK (NOT (published_at IS NOT NULL AND failed_at IS NOT NULL)),
        CHECK (failed_at IS NULL OR claimed_by IS NULL)
      ) STRICT;

      CREATE INDEX idx_realtime_outbox_due
        ON realtime_outbox(available_at, event_sequence)
        WHERE published_at IS NULL AND failed_at IS NULL;
    `
  },
  {
    id: "007_forward_request_identity",
    sql: `
      ALTER TABLE messages ADD COLUMN forward_source_message_id TEXT REFERENCES messages(id);
    `
  },
  {
    id: "008_message_request_fingerprint",
    sql: `
      ALTER TABLE messages ADD COLUMN request_fingerprint_ciphertext TEXT;
    `
  },
  {
    id: "009_passkey_ceremony_repository",
    sql: `
      CREATE UNIQUE INDEX idx_device_sessions_id_user
        ON device_sessions(id, user_id);

      CREATE TABLE passkey_challenge_secrets (
        reference TEXT PRIMARY KEY CHECK (length(reference) BETWEEN 1 AND 192),
        challenge_ciphertext TEXT NOT NULL
          CHECK (challenge_ciphertext GLOB 'luxora:v1.*'),
        expires_at_ms INTEGER NOT NULL
          CHECK (expires_at_ms BETWEEN 0 AND 9007199254740991),
        created_at_ms INTEGER NOT NULL
          CHECK (created_at_ms BETWEEN 0 AND 9007199254740991),
        CHECK (created_at_ms < expires_at_ms)
      ) STRICT;
      CREATE INDEX idx_passkey_challenge_secrets_expiry
        ON passkey_challenge_secrets(expires_at_ms, reference);

      CREATE TABLE passkey_user_handles (
        reference TEXT PRIMARY KEY CHECK (length(reference) BETWEEN 1 AND 192),
        account_id TEXT NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
        handle_digest TEXT NOT NULL UNIQUE CHECK (
          length(handle_digest) = 64
          AND handle_digest NOT GLOB '*[^0-9a-f]*'
        ),
        handle_ciphertext TEXT NOT NULL
          CHECK (handle_ciphertext GLOB 'luxora:v1.*'),
        created_at_ms INTEGER NOT NULL
          CHECK (created_at_ms BETWEEN 0 AND 9007199254740991),
        UNIQUE (reference, account_id)
      ) STRICT;

      CREATE TABLE passkey_ceremonies (
        ceremony_id TEXT PRIMARY KEY CHECK (length(ceremony_id) BETWEEN 1 AND 192),
        schema_version INTEGER NOT NULL CHECK (schema_version = 1),
        kind TEXT NOT NULL CHECK (kind IN ('registration', 'authentication')),
        purpose_type TEXT NOT NULL
          CHECK (purpose_type IN ('authenticator.add', 'session.step_up')),
        purpose_target_digest TEXT NOT NULL CHECK (
          length(purpose_target_digest) = 64
          AND purpose_target_digest NOT GLOB '*[^0-9a-f]*'
        ),
        account_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        session_id TEXT NOT NULL,
        device_id TEXT NOT NULL CHECK (length(device_id) BETWEEN 1 AND 192),
        user_handle_ref TEXT,
        challenge_reference TEXT NOT NULL UNIQUE
          CHECK (length(challenge_reference) BETWEEN 1 AND 192),
        challenge_digest TEXT NOT NULL CHECK (
          length(challenge_digest) = 64
          AND challenge_digest NOT GLOB '*[^0-9a-f]*'
        ),
        state TEXT NOT NULL
          CHECK (state IN ('pending', 'consumed', 'cancelled', 'expired', 'rejected')),
        revision INTEGER NOT NULL CHECK (revision >= 1),
        attempts_used INTEGER NOT NULL CHECK (attempts_used BETWEEN 0 AND 5),
        max_attempts INTEGER NOT NULL CHECK (max_attempts BETWEEN 1 AND 5),
        expires_at_ms INTEGER NOT NULL
          CHECK (expires_at_ms BETWEEN 0 AND 9007199254740991),
        updated_at_ms INTEGER NOT NULL
          CHECK (updated_at_ms BETWEEN 0 AND 9007199254740991),
        snapshot_json TEXT NOT NULL CHECK (json_valid(snapshot_json)),
        CHECK (attempts_used <= max_attempts),
        CHECK (
          (kind = 'registration' AND purpose_type = 'authenticator.add')
          OR (kind = 'authentication' AND purpose_type = 'session.step_up')
        ),
        CHECK (
          (kind = 'registration' AND user_handle_ref IS NOT NULL)
          OR (kind = 'authentication' AND user_handle_ref IS NULL)
        ),
        FOREIGN KEY (session_id, account_id)
          REFERENCES device_sessions(id, user_id) ON DELETE CASCADE,
        FOREIGN KEY (user_handle_ref, account_id)
          REFERENCES passkey_user_handles(reference, account_id)
      ) STRICT;
      CREATE INDEX idx_passkey_ceremonies_actor
        ON passkey_ceremonies(account_id, session_id, device_id, updated_at_ms);
      CREATE INDEX idx_passkey_ceremonies_expiry
        ON passkey_ceremonies(state, expires_at_ms, ceremony_id);

      CREATE TABLE passkey_ceremony_events (
        event_id TEXT PRIMARY KEY CHECK (length(event_id) BETWEEN 1 AND 192),
        ceremony_id TEXT NOT NULL REFERENCES passkey_ceremonies(ceremony_id) ON DELETE CASCADE,
        revision INTEGER NOT NULL CHECK (revision >= 1),
        event_type TEXT NOT NULL CHECK (event_type IN (
          'passkey.ceremony.started',
          'passkey.ceremony.verification_rejected',
          'passkey.ceremony.consumed',
          'passkey.ceremony.cancelled',
          'passkey.ceremony.expired',
          'passkey.ceremony.attempts_exhausted'
        )),
        command_id TEXT NOT NULL CHECK (length(command_id) BETWEEN 1 AND 192),
        occurred_at_ms INTEGER NOT NULL
          CHECK (occurred_at_ms BETWEEN 0 AND 9007199254740991),
        event_json TEXT NOT NULL CHECK (json_valid(event_json)),
        UNIQUE (ceremony_id, revision)
      ) STRICT;

      CREATE TABLE passkey_ceremony_outbox (
        outbox_id TEXT PRIMARY KEY CHECK (length(outbox_id) BETWEEN 1 AND 192),
        event_id TEXT NOT NULL UNIQUE
          REFERENCES passkey_ceremony_events(event_id) ON DELETE CASCADE,
        topic TEXT NOT NULL CHECK (topic = 'luxora.passkey-ceremony.v1'),
        partition_key TEXT NOT NULL CHECK (length(partition_key) BETWEEN 1 AND 192),
        available_at_ms INTEGER NOT NULL
          CHECK (available_at_ms BETWEEN 0 AND 9007199254740991),
        payload_json TEXT NOT NULL CHECK (json_valid(payload_json))
      ) STRICT;
      CREATE INDEX idx_passkey_ceremony_outbox_available
        ON passkey_ceremony_outbox(available_at_ms, outbox_id);

      CREATE TABLE passkey_command_receipts (
        scope TEXT PRIMARY KEY CHECK (length(scope) BETWEEN 1 AND 192),
        fingerprint TEXT NOT NULL CHECK (
          length(fingerprint) = 64
          AND fingerprint NOT GLOB '*[^0-9a-f]*'
        ),
        ceremony_id TEXT NOT NULL REFERENCES passkey_ceremonies(ceremony_id) ON DELETE CASCADE,
        result_revision INTEGER NOT NULL CHECK (result_revision >= 1),
        event_id TEXT NOT NULL REFERENCES passkey_ceremony_events(event_id) ON DELETE CASCADE,
        result_snapshot_json TEXT NOT NULL CHECK (json_valid(result_snapshot_json)),
        created_at_ms INTEGER NOT NULL
          CHECK (created_at_ms BETWEEN 0 AND 9007199254740991)
      ) STRICT;
      CREATE INDEX idx_passkey_command_receipts_ceremony
        ON passkey_command_receipts(ceremony_id, result_revision);

      CREATE TABLE passkey_creation_receipts (
        scope TEXT PRIMARY KEY CHECK (length(scope) BETWEEN 1 AND 192),
        fingerprint TEXT NOT NULL CHECK (
          length(fingerprint) = 64
          AND fingerprint NOT GLOB '*[^0-9a-f]*'
        ),
        ceremony_id TEXT NOT NULL REFERENCES passkey_ceremonies(ceremony_id) ON DELETE CASCADE,
        result_revision INTEGER NOT NULL CHECK (result_revision = 1),
        event_id TEXT NOT NULL REFERENCES passkey_ceremony_events(event_id) ON DELETE CASCADE,
        result_snapshot_json TEXT NOT NULL CHECK (json_valid(result_snapshot_json)),
        created_at_ms INTEGER NOT NULL
          CHECK (created_at_ms BETWEEN 0 AND 9007199254740991)
      ) STRICT;
      CREATE INDEX idx_passkey_creation_receipts_ceremony
        ON passkey_creation_receipts(ceremony_id);

      CREATE TABLE passkey_credentials (
        record_id TEXT PRIMARY KEY CHECK (length(record_id) BETWEEN 1 AND 192),
        credential_id_digest TEXT NOT NULL UNIQUE CHECK (
          length(credential_id_digest) = 64
          AND credential_id_digest NOT GLOB '*[^0-9a-f]*'
        ),
        credential_id_ciphertext TEXT NOT NULL
          CHECK (credential_id_ciphertext GLOB 'luxora:v1.*'),
        account_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        user_handle_ref TEXT NOT NULL,
        credential_material_ciphertext TEXT NOT NULL
          CHECK (credential_material_ciphertext GLOB 'luxora:v1.*'),
        algorithm INTEGER NOT NULL CHECK (algorithm IN (-7, -257)),
        discovery_mode TEXT NOT NULL CHECK (discovery_mode IN ('discoverable', 'non_discoverable')),
        credential_set_ref TEXT,
        revision INTEGER NOT NULL CHECK (revision >= 1),
        sign_count INTEGER NOT NULL CHECK (sign_count BETWEEN 0 AND 4294967295),
        backup_eligible INTEGER NOT NULL CHECK (backup_eligible IN (0, 1)),
        backup_state INTEGER NOT NULL CHECK (backup_state IN (0, 1)),
        registration_ceremony_id TEXT NOT NULL UNIQUE
          CHECK (length(registration_ceremony_id) BETWEEN 1 AND 192),
        created_at_ms INTEGER NOT NULL
          CHECK (created_at_ms BETWEEN 0 AND 9007199254740991),
        updated_at_ms INTEGER NOT NULL
          CHECK (updated_at_ms BETWEEN 0 AND 9007199254740991),
        CHECK (backup_eligible = 1 OR backup_state = 0),
        CHECK (
          (discovery_mode = 'discoverable' AND credential_set_ref IS NULL)
          OR (discovery_mode = 'non_discoverable' AND credential_set_ref IS NOT NULL)
        ),
        FOREIGN KEY (user_handle_ref, account_id)
          REFERENCES passkey_user_handles(reference, account_id)
      ) STRICT;
      CREATE INDEX idx_passkey_credentials_account
        ON passkey_credentials(account_id, created_at_ms, record_id);
    `
  },
  {
    id: "010_passkey_step_up_grants",
    sql: `
      CREATE TABLE passkey_step_up_grants (
        authentication_ceremony_id TEXT PRIMARY KEY
          CHECK (length(authentication_ceremony_id) BETWEEN 1 AND 192),
        account_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        session_id TEXT NOT NULL,
        device_id TEXT NOT NULL CHECK (length(device_id) BETWEEN 1 AND 192),
        purpose TEXT NOT NULL CHECK (purpose = 'authenticator.add'),
        target_digest TEXT NOT NULL CHECK (
          length(target_digest) = 64
          AND target_digest NOT GLOB '*[^0-9a-f]*'
        ),
        auth_time_sec INTEGER NOT NULL
          CHECK (auth_time_sec BETWEEN 0 AND 9007199254740991),
        issued_at_sec INTEGER NOT NULL
          CHECK (issued_at_sec BETWEEN 0 AND 9007199254740991),
        expires_at_sec INTEGER NOT NULL
          CHECK (expires_at_sec BETWEEN 0 AND 9007199254740991),
        consumed_at_sec INTEGER
          CHECK (consumed_at_sec BETWEEN 0 AND 9007199254740991),
        registration_ceremony_id TEXT UNIQUE
          CHECK (registration_ceremony_id IS NULL
            OR length(registration_ceremony_id) BETWEEN 1 AND 192),
        CHECK (device_id = session_id),
        CHECK (auth_time_sec = issued_at_sec),
        CHECK (issued_at_sec < expires_at_sec),
        CHECK (expires_at_sec - issued_at_sec <= 300),
        CHECK (
          (consumed_at_sec IS NULL AND registration_ceremony_id IS NULL)
          OR (consumed_at_sec IS NOT NULL AND registration_ceremony_id IS NOT NULL)
        ),
        CHECK (
          consumed_at_sec IS NULL
          OR (consumed_at_sec >= issued_at_sec AND consumed_at_sec < expires_at_sec)
        ),
        FOREIGN KEY (session_id, account_id)
          REFERENCES device_sessions(id, user_id) ON DELETE CASCADE,
        FOREIGN KEY (registration_ceremony_id)
          REFERENCES passkey_ceremonies(ceremony_id) ON DELETE CASCADE
          DEFERRABLE INITIALLY DEFERRED
      ) STRICT;
      CREATE INDEX idx_passkey_step_up_grants_available
        ON passkey_step_up_grants(consumed_at_sec, expires_at_sec, authentication_ceremony_id);
      CREATE INDEX idx_passkey_step_up_grants_actor
        ON passkey_step_up_grants(account_id, session_id, device_id, issued_at_sec);

      CREATE TRIGGER trg_passkey_step_up_grants_require_authentication
      BEFORE INSERT ON passkey_step_up_grants
      WHEN NEW.consumed_at_sec IS NOT NULL
        OR NEW.registration_ceremony_id IS NOT NULL
        OR NOT EXISTS (
        SELECT 1
        FROM passkey_ceremonies authentication
        JOIN passkey_ceremony_events outcome
          ON outcome.ceremony_id = authentication.ceremony_id
          AND outcome.revision = authentication.revision
        WHERE authentication.ceremony_id = NEW.authentication_ceremony_id
          AND authentication.kind = 'authentication'
          AND authentication.purpose_type = 'session.step_up'
          AND authentication.state = 'consumed'
          AND authentication.account_id = NEW.account_id
          AND authentication.session_id = NEW.session_id
          AND authentication.device_id = NEW.device_id
          AND authentication.purpose_target_digest = NEW.target_digest
          AND CAST(authentication.updated_at_ms / 1000 AS INTEGER) = NEW.auth_time_sec
          AND NEW.auth_time_sec = NEW.issued_at_sec
          AND json_extract(authentication.snapshot_json, '$.terminalReason') = 'verified'
          AND json_extract(authentication.snapshot_json, '$.terminalAtMs')
            = authentication.updated_at_ms
          AND outcome.event_type = 'passkey.ceremony.consumed'
          AND outcome.occurred_at_ms = authentication.updated_at_ms
        )
      BEGIN
        SELECT RAISE(ABORT, 'passkey step-up grant requires a consumed authentication');
      END;

      CREATE TRIGGER trg_passkey_step_up_grants_immutable
      BEFORE UPDATE OF authentication_ceremony_id, account_id, session_id, device_id,
        purpose, target_digest, auth_time_sec, issued_at_sec, expires_at_sec
      ON passkey_step_up_grants
      BEGIN
        SELECT RAISE(ABORT, 'passkey step-up grant binding is immutable');
      END;

      CREATE TRIGGER trg_passkey_step_up_grants_consume_once
      BEFORE UPDATE OF consumed_at_sec, registration_ceremony_id
      ON passkey_step_up_grants
      WHEN OLD.consumed_at_sec IS NOT NULL OR OLD.registration_ceremony_id IS NOT NULL
      BEGIN
        SELECT RAISE(ABORT, 'passkey step-up grant is already consumed');
      END;

      CREATE TRIGGER trg_passkey_step_up_grants_no_direct_delete
      BEFORE DELETE ON passkey_step_up_grants
      WHEN EXISTS (
        SELECT 1 FROM users WHERE id = OLD.account_id
      ) AND EXISTS (
        SELECT 1 FROM device_sessions
        WHERE id = OLD.session_id AND user_id = OLD.account_id
      )
      BEGIN
        SELECT RAISE(ABORT, 'passkey step-up grant cannot be deleted while its session exists');
      END;

      CREATE TRIGGER trg_passkey_credentials_require_step_up_grant_insert
      BEFORE INSERT ON passkey_credentials
      WHEN NOT EXISTS (
        SELECT 1
        FROM passkey_step_up_grants grants
        JOIN passkey_ceremonies registration
          ON registration.ceremony_id = grants.registration_ceremony_id
        WHERE grants.registration_ceremony_id = NEW.registration_ceremony_id
          AND grants.account_id = NEW.account_id
          AND grants.consumed_at_sec IS NOT NULL
          AND registration.kind = 'registration'
          AND registration.purpose_type = 'authenticator.add'
          AND registration.state = 'consumed'
          AND registration.account_id = grants.account_id
          AND registration.session_id = grants.session_id
          AND registration.device_id = grants.device_id
          AND registration.purpose_target_digest = grants.target_digest
      )
      BEGIN
        SELECT RAISE(ABORT, 'passkey registration requires a consumed step-up grant');
      END;

      CREATE TRIGGER trg_passkey_credentials_require_step_up_grant_update
      BEFORE UPDATE OF registration_ceremony_id, account_id ON passkey_credentials
      WHEN NOT EXISTS (
        SELECT 1
        FROM passkey_step_up_grants grants
        JOIN passkey_ceremonies registration
          ON registration.ceremony_id = grants.registration_ceremony_id
        WHERE grants.registration_ceremony_id = NEW.registration_ceremony_id
          AND grants.account_id = NEW.account_id
          AND grants.consumed_at_sec IS NOT NULL
          AND registration.kind = 'registration'
          AND registration.purpose_type = 'authenticator.add'
          AND registration.state = 'consumed'
          AND registration.account_id = grants.account_id
          AND registration.session_id = grants.session_id
          AND registration.device_id = grants.device_id
          AND registration.purpose_target_digest = grants.target_digest
      )
      BEGIN
        SELECT RAISE(ABORT, 'passkey registration requires a consumed step-up grant');
      END;

      CREATE TRIGGER trg_passkey_credentials_immutable_binding
      BEFORE UPDATE OF
        record_id, credential_id_digest, credential_id_ciphertext, account_id,
        user_handle_ref, credential_material_ciphertext, algorithm, discovery_mode,
        credential_set_ref, backup_eligible, registration_ceremony_id, created_at_ms
      ON passkey_credentials
      WHEN NEW.record_id IS NOT OLD.record_id
        OR NEW.credential_id_digest IS NOT OLD.credential_id_digest
        OR NEW.credential_id_ciphertext IS NOT OLD.credential_id_ciphertext
        OR NEW.account_id IS NOT OLD.account_id
        OR NEW.user_handle_ref IS NOT OLD.user_handle_ref
        OR NEW.credential_material_ciphertext IS NOT OLD.credential_material_ciphertext
        OR NEW.algorithm IS NOT OLD.algorithm
        OR NEW.discovery_mode IS NOT OLD.discovery_mode
        OR NEW.credential_set_ref IS NOT OLD.credential_set_ref
        OR NEW.backup_eligible IS NOT OLD.backup_eligible
        OR NEW.registration_ceremony_id IS NOT OLD.registration_ceremony_id
        OR NEW.created_at_ms IS NOT OLD.created_at_ms
      BEGIN
        SELECT RAISE(ABORT, 'passkey credential binding is immutable');
      END;
    `
  },
  {
    id: "011_passkey_login_intents",
    sql: `
      CREATE UNIQUE INDEX idx_passkey_credentials_record_account_handle
        ON passkey_credentials(record_id, account_id, user_handle_ref);
      CREATE UNIQUE INDEX idx_refresh_tokens_id_session
        ON refresh_tokens(id, session_id);

      CREATE TABLE passkey_login_intents (
        intent_id TEXT PRIMARY KEY CHECK (
          length(CAST(intent_id AS BLOB)) = 36
          AND instr(intent_id, char(0)) = 0
          AND substr(intent_id, 9, 1) = '-'
          AND substr(intent_id, 14, 1) = '-'
          AND substr(intent_id, 19, 1) = '-'
          AND substr(intent_id, 24, 1) = '-'
          AND substr(intent_id, 15, 1) GLOB '[1-8]'
          AND substr(intent_id, 20, 1) GLOB '[89ab]'
          AND substr(intent_id, 1, 8) NOT GLOB '*[^0-9a-f]*'
          AND substr(intent_id, 10, 4) NOT GLOB '*[^0-9a-f]*'
          AND substr(intent_id, 15, 4) NOT GLOB '*[^0-9a-f]*'
          AND substr(intent_id, 20, 4) NOT GLOB '*[^0-9a-f]*'
          AND substr(intent_id, 25, 12) NOT GLOB '*[^0-9a-f]*'
        ),
        schema_version INTEGER NOT NULL CHECK (schema_version = 1),
        purpose_type TEXT NOT NULL CHECK (purpose_type = 'session.create'),
        purpose_target_digest TEXT NOT NULL CHECK (
          length(CAST(purpose_target_digest AS BLOB)) = 64
          AND instr(purpose_target_digest, char(0)) = 0
          AND purpose_target_digest NOT GLOB '*[^0-9a-f]*'
        ),
        policy_version INTEGER NOT NULL CHECK (policy_version = 1),
        access_token_ttl_seconds INTEGER NOT NULL
          CHECK (access_token_ttl_seconds BETWEEN 60 AND 3600),
        session_ttl_seconds INTEGER NOT NULL
          CHECK (session_ttl_seconds BETWEEN 86400 AND 31536000),
        recovery_grace_seconds INTEGER NOT NULL
          CHECK (recovery_grace_seconds BETWEEN 0 AND 300),
        expected_rp_id TEXT NOT NULL CHECK (expected_rp_id = 'auth.luxora.app'),
        expected_origin TEXT NOT NULL
          CHECK (expected_origin = 'https://auth.luxora.app'),
        timeout_ms INTEGER NOT NULL CHECK (timeout_ms BETWEEN 300000 AND 600000),
        max_response_bytes INTEGER NOT NULL CHECK (max_response_bytes BETWEEN 1 AND 65536),
        max_attempts INTEGER NOT NULL CHECK (max_attempts BETWEEN 1 AND 5),
        allowed_algorithms_json TEXT NOT NULL CHECK (allowed_algorithms_json = '[-7,-257]'),
        user_verification TEXT NOT NULL CHECK (user_verification = 'required'),
        cross_origin_allowed INTEGER NOT NULL CHECK (cross_origin_allowed = 0),
        credential_boundary TEXT NOT NULL CHECK (credential_boundary = 'discoverable_any'),
        challenge_reference TEXT NOT NULL UNIQUE
          CHECK (
            length(CAST(challenge_reference AS BLOB)) BETWEEN 1 AND 192
            AND instr(challenge_reference, char(0)) = 0
          ),
        challenge_digest TEXT NOT NULL CHECK (
          length(CAST(challenge_digest AS BLOB)) = 64
          AND instr(challenge_digest, char(0)) = 0
          AND challenge_digest NOT GLOB '*[^0-9a-f]*'
        ),
        delivery_nonce_digest TEXT NOT NULL CHECK (
          length(CAST(delivery_nonce_digest AS BLOB)) = 64
          AND instr(delivery_nonce_digest, char(0)) = 0
          AND delivery_nonce_digest NOT GLOB '*[^0-9a-f]*'
        ),
        refresh_derivation_key_id TEXT NOT NULL
          CHECK (
            length(CAST(refresh_derivation_key_id AS BLOB)) BETWEEN 1 AND 64
            AND instr(refresh_derivation_key_id, char(0)) = 0
            AND substr(refresh_derivation_key_id, 1, 1) GLOB '[A-Za-z0-9]'
            AND refresh_derivation_key_id NOT GLOB '*[^A-Za-z0-9._-]*'
          ),
        state TEXT NOT NULL
          CHECK (state IN ('pending', 'consumed', 'cancelled', 'expired', 'rejected')),
        revision INTEGER NOT NULL CHECK (revision >= 1),
        attempts_used INTEGER NOT NULL CHECK (attempts_used BETWEEN 0 AND 5),
        created_at_ms INTEGER NOT NULL
          CHECK (created_at_ms BETWEEN 0 AND 9007199254740991),
        expires_at_ms INTEGER NOT NULL
          CHECK (expires_at_ms BETWEEN 0 AND 9007199254740991),
        updated_at_ms INTEGER NOT NULL
          CHECK (updated_at_ms BETWEEN 0 AND 9007199254740991),
        terminal_at_ms INTEGER
          CHECK (terminal_at_ms BETWEEN 0 AND 9007199254740991),
        terminal_reason TEXT CHECK (terminal_reason IN (
          'verified', 'cancelled', 'expired', 'attempts_exhausted'
        )),
        resolved_account_id TEXT CHECK (
          resolved_account_id IS NULL OR (
            length(CAST(resolved_account_id AS BLOB)) = 36
            AND instr(resolved_account_id, char(0)) = 0
            AND substr(resolved_account_id, 9, 1) = '-'
            AND substr(resolved_account_id, 14, 1) = '-'
            AND substr(resolved_account_id, 19, 1) = '-'
            AND substr(resolved_account_id, 24, 1) = '-'
            AND substr(resolved_account_id, 15, 1) GLOB '[1-8]'
            AND substr(resolved_account_id, 20, 1) GLOB '[89ab]'
            AND substr(resolved_account_id, 1, 8) NOT GLOB '*[^0-9a-f]*'
            AND substr(resolved_account_id, 10, 4) NOT GLOB '*[^0-9a-f]*'
            AND substr(resolved_account_id, 15, 4) NOT GLOB '*[^0-9a-f]*'
            AND substr(resolved_account_id, 20, 4) NOT GLOB '*[^0-9a-f]*'
            AND substr(resolved_account_id, 25, 12) NOT GLOB '*[^0-9a-f]*'
          )
        ) REFERENCES users(id) ON DELETE CASCADE,
        resolved_user_handle_ref TEXT,
        resolved_credential_record_id TEXT,
        resolved_credential_revision_before INTEGER CHECK (
          resolved_credential_revision_before >= 1
        ),
        resolved_credential_revision_after INTEGER CHECK (
          resolved_credential_revision_after >= 2
        ),
        resolved_sign_count_before INTEGER CHECK (
          resolved_sign_count_before BETWEEN 0 AND 4294967295
        ),
        resolved_observed_sign_count INTEGER CHECK (
          resolved_observed_sign_count BETWEEN 0 AND 4294967295
        ),
        resolved_sign_count_after INTEGER CHECK (
          resolved_sign_count_after BETWEEN 0 AND 4294967295
        ),
        resolved_backup_eligible INTEGER CHECK (resolved_backup_eligible IN (0, 1)),
        resolved_backup_state_before INTEGER CHECK (resolved_backup_state_before IN (0, 1)),
        resolved_backup_state_after INTEGER CHECK (resolved_backup_state_after IN (0, 1)),
        session_id TEXT UNIQUE CHECK (
          session_id IS NULL OR (
            length(CAST(session_id AS BLOB)) = 36
            AND instr(session_id, char(0)) = 0
            AND substr(session_id, 9, 1) = '-'
            AND substr(session_id, 14, 1) = '-'
            AND substr(session_id, 19, 1) = '-'
            AND substr(session_id, 24, 1) = '-'
            AND substr(session_id, 15, 1) GLOB '[1-8]'
            AND substr(session_id, 20, 1) GLOB '[89ab]'
            AND substr(session_id, 1, 8) NOT GLOB '*[^0-9a-f]*'
            AND substr(session_id, 10, 4) NOT GLOB '*[^0-9a-f]*'
            AND substr(session_id, 15, 4) NOT GLOB '*[^0-9a-f]*'
            AND substr(session_id, 20, 4) NOT GLOB '*[^0-9a-f]*'
            AND substr(session_id, 25, 12) NOT GLOB '*[^0-9a-f]*'
          )
        ),
        initial_refresh_token_id TEXT UNIQUE CHECK (
          initial_refresh_token_id IS NULL OR (
            length(CAST(initial_refresh_token_id AS BLOB)) = 36
            AND instr(initial_refresh_token_id, char(0)) = 0
            AND substr(initial_refresh_token_id, 9, 1) = '-'
            AND substr(initial_refresh_token_id, 14, 1) = '-'
            AND substr(initial_refresh_token_id, 19, 1) = '-'
            AND substr(initial_refresh_token_id, 24, 1) = '-'
            AND substr(initial_refresh_token_id, 15, 1) GLOB '[1-8]'
            AND substr(initial_refresh_token_id, 20, 1) GLOB '[89ab]'
            AND substr(initial_refresh_token_id, 1, 8) NOT GLOB '*[^0-9a-f]*'
            AND substr(initial_refresh_token_id, 10, 4) NOT GLOB '*[^0-9a-f]*'
            AND substr(initial_refresh_token_id, 15, 4) NOT GLOB '*[^0-9a-f]*'
            AND substr(initial_refresh_token_id, 20, 4) NOT GLOB '*[^0-9a-f]*'
            AND substr(initial_refresh_token_id, 25, 12) NOT GLOB '*[^0-9a-f]*'
          )
        ),
        initial_access_token_expires_at_sec INTEGER CHECK (
          initial_access_token_expires_at_sec BETWEEN 0 AND 9007199254740991
        ),
        CHECK (created_at_ms <= updated_at_ms),
        CHECK (created_at_ms <= 9007199254740991 - timeout_ms),
        CHECK (expires_at_ms = created_at_ms + timeout_ms),
        CHECK (
          access_token_ttl_seconds
            >= CAST((expires_at_ms + 999) / 1000 AS INTEGER)
              - CAST(created_at_ms / 1000 AS INTEGER)
              + recovery_grace_seconds
        ),
        CHECK (attempts_used <= max_attempts),
        CHECK (
          (state = 'pending'
            AND attempts_used < max_attempts
            AND revision = attempts_used + 1
            AND terminal_at_ms IS NULL
            AND terminal_reason IS NULL
            AND updated_at_ms < expires_at_ms)
          OR (state = 'consumed'
            AND attempts_used < max_attempts
            AND revision = attempts_used + 2
            AND terminal_at_ms = updated_at_ms
            AND terminal_reason = 'verified'
            AND updated_at_ms < expires_at_ms)
          OR (state = 'cancelled'
            AND attempts_used < max_attempts
            AND revision = attempts_used + 2
            AND terminal_at_ms = updated_at_ms
            AND terminal_reason = 'cancelled'
            AND updated_at_ms < expires_at_ms)
          OR (state = 'expired'
            AND attempts_used < max_attempts
            AND revision = attempts_used + 2
            AND terminal_at_ms = updated_at_ms
            AND terminal_reason = 'expired'
            AND updated_at_ms >= expires_at_ms)
          OR (state = 'rejected'
            AND attempts_used = max_attempts
            AND revision = attempts_used + 1
            AND terminal_at_ms = updated_at_ms
            AND terminal_reason = 'attempts_exhausted'
            AND updated_at_ms < expires_at_ms)
        ),
        CHECK (
          (state = 'consumed'
            AND resolved_account_id IS NOT NULL
            AND resolved_user_handle_ref IS NOT NULL
            AND resolved_credential_record_id IS NOT NULL
            AND resolved_credential_revision_before IS NOT NULL
            AND resolved_credential_revision_after
              = resolved_credential_revision_before + 1
            AND resolved_sign_count_before IS NOT NULL
            AND resolved_observed_sign_count IS NOT NULL
            AND resolved_sign_count_after IS NOT NULL
            AND resolved_backup_eligible IS NOT NULL
            AND resolved_backup_state_before IS NOT NULL
            AND resolved_backup_state_after IS NOT NULL
            AND (resolved_backup_eligible = 1 OR (
              resolved_backup_state_before = 0 AND resolved_backup_state_after = 0
            ))
            AND resolved_sign_count_after
              = max(resolved_sign_count_before, resolved_observed_sign_count)
            AND session_id IS NOT NULL
            AND initial_refresh_token_id IS NOT NULL
            AND initial_access_token_expires_at_sec IS NOT NULL
            AND initial_access_token_expires_at_sec
              = CAST(updated_at_ms / 1000 AS INTEGER) + access_token_ttl_seconds
            AND initial_access_token_expires_at_sec
              >= CAST((expires_at_ms + 999) / 1000 AS INTEGER)
                + recovery_grace_seconds)
          OR (state <> 'consumed'
            AND resolved_account_id IS NULL
            AND resolved_user_handle_ref IS NULL
            AND resolved_credential_record_id IS NULL
            AND resolved_credential_revision_before IS NULL
            AND resolved_credential_revision_after IS NULL
            AND resolved_sign_count_before IS NULL
            AND resolved_observed_sign_count IS NULL
            AND resolved_sign_count_after IS NULL
            AND resolved_backup_eligible IS NULL
            AND resolved_backup_state_before IS NULL
            AND resolved_backup_state_after IS NULL
            AND session_id IS NULL
            AND initial_refresh_token_id IS NULL
            AND initial_access_token_expires_at_sec IS NULL)
        )
      ) STRICT;
      CREATE INDEX idx_passkey_login_intents_expiry
        ON passkey_login_intents(state, expires_at_ms, intent_id);
      CREATE INDEX idx_passkey_login_intents_account
        ON passkey_login_intents(resolved_account_id, created_at_ms, intent_id)
        WHERE resolved_account_id IS NOT NULL;
      CREATE UNIQUE INDEX idx_passkey_login_intents_credential_revision_claim
        ON passkey_login_intents(
          resolved_credential_record_id, resolved_credential_revision_after
        )
        WHERE state = 'consumed';

      CREATE TABLE passkey_login_events (
        event_id TEXT PRIMARY KEY CHECK (
          length(CAST(event_id AS BLOB)) BETWEEN 1 AND 192
          AND instr(event_id, char(0)) = 0
        ),
        intent_id TEXT NOT NULL
          REFERENCES passkey_login_intents(intent_id) ON DELETE CASCADE,
        revision INTEGER NOT NULL CHECK (revision >= 1),
        event_type TEXT NOT NULL CHECK (event_type IN (
          'passkey.login.started',
          'passkey.login.verification_rejected',
          'passkey.login.consumed',
          'passkey.login.cancelled',
          'passkey.login.expired',
          'passkey.login.attempts_exhausted'
        )),
        command_scope TEXT NOT NULL CHECK (
          length(CAST(command_scope AS BLOB)) BETWEEN 1 AND 192
          AND instr(command_scope, char(0)) = 0
        ),
        occurred_at_ms INTEGER NOT NULL
          CHECK (occurred_at_ms BETWEEN 0 AND 9007199254740991),
        event_json TEXT NOT NULL CHECK (json_valid(event_json)),
        UNIQUE (intent_id, revision),
        UNIQUE (event_id, intent_id, revision)
      ) STRICT;

      CREATE TABLE passkey_login_outbox (
        outbox_id TEXT PRIMARY KEY CHECK (
          length(CAST(outbox_id AS BLOB)) BETWEEN 1 AND 192
          AND instr(outbox_id, char(0)) = 0
        ),
        event_id TEXT NOT NULL UNIQUE
          REFERENCES passkey_login_events(event_id) ON DELETE CASCADE,
        topic TEXT NOT NULL CHECK (topic = 'luxora.passkey-login.v1'),
        partition_key TEXT NOT NULL CHECK (
          length(CAST(partition_key AS BLOB)) BETWEEN 1 AND 192
          AND instr(partition_key, char(0)) = 0
        ),
        available_at_ms INTEGER NOT NULL
          CHECK (available_at_ms BETWEEN 0 AND 9007199254740991),
        payload_json TEXT NOT NULL CHECK (json_valid(payload_json))
      ) STRICT;
      CREATE INDEX idx_passkey_login_outbox_available
        ON passkey_login_outbox(available_at_ms, outbox_id);

      CREATE TABLE passkey_login_command_receipts (
        scope TEXT PRIMARY KEY CHECK (
          length(CAST(scope AS BLOB)) BETWEEN 1 AND 192
          AND instr(scope, char(0)) = 0
        ),
        fingerprint TEXT NOT NULL CHECK (
          length(CAST(fingerprint AS BLOB)) = 64
          AND instr(fingerprint, char(0)) = 0
          AND fingerprint NOT GLOB '*[^0-9a-f]*'
        ),
        intent_id TEXT NOT NULL
          REFERENCES passkey_login_intents(intent_id) ON DELETE CASCADE,
        result_revision INTEGER NOT NULL CHECK (result_revision >= 1),
        result_state TEXT NOT NULL
          CHECK (result_state IN ('pending', 'consumed', 'cancelled', 'expired', 'rejected')),
        event_id TEXT NOT NULL,
        result_json TEXT NOT NULL CHECK (json_valid(result_json)),
        created_at_ms INTEGER NOT NULL
          CHECK (created_at_ms BETWEEN 0 AND 9007199254740991),
        FOREIGN KEY (event_id, intent_id, result_revision)
          REFERENCES passkey_login_events(event_id, intent_id, revision) ON DELETE CASCADE
      ) STRICT;
      CREATE INDEX idx_passkey_login_command_receipts_intent
        ON passkey_login_command_receipts(intent_id, result_revision);

      CREATE TABLE passkey_login_creation_receipts (
        scope TEXT PRIMARY KEY CHECK (
          length(CAST(scope AS BLOB)) BETWEEN 1 AND 192
          AND instr(scope, char(0)) = 0
        ),
        fingerprint TEXT NOT NULL CHECK (
          length(CAST(fingerprint AS BLOB)) = 64
          AND instr(fingerprint, char(0)) = 0
          AND fingerprint NOT GLOB '*[^0-9a-f]*'
        ),
        intent_id TEXT NOT NULL
          REFERENCES passkey_login_intents(intent_id) ON DELETE CASCADE,
        result_revision INTEGER NOT NULL CHECK (result_revision = 1),
        result_state TEXT NOT NULL CHECK (result_state = 'pending'),
        event_id TEXT NOT NULL,
        result_json TEXT NOT NULL CHECK (json_valid(result_json)),
        created_at_ms INTEGER NOT NULL
          CHECK (created_at_ms BETWEEN 0 AND 9007199254740991),
        FOREIGN KEY (event_id, intent_id, result_revision)
          REFERENCES passkey_login_events(event_id, intent_id, revision) ON DELETE CASCADE
      ) STRICT;
      CREATE INDEX idx_passkey_login_creation_receipts_intent
        ON passkey_login_creation_receipts(intent_id);

      CREATE TRIGGER trg_passkey_login_intents_initial_state
      BEFORE INSERT ON passkey_login_intents
      WHEN NEW.state <> 'pending'
        OR NEW.revision <> 1
        OR NEW.attempts_used <> 0
        OR NEW.updated_at_ms <> NEW.created_at_ms
      BEGIN
        SELECT RAISE(ABORT, 'passkey login intent must begin pending');
      END;

      CREATE TRIGGER trg_passkey_login_intents_challenge_exclusive
      BEFORE INSERT ON passkey_login_intents
      WHEN EXISTS (
        SELECT 1 FROM passkey_ceremonies
        WHERE challenge_reference = NEW.challenge_reference
      )
      BEGIN
        SELECT RAISE(ABORT, 'passkey challenge already belongs to a ceremony');
      END;

      CREATE TRIGGER trg_passkey_ceremonies_login_challenge_exclusive_insert
      BEFORE INSERT ON passkey_ceremonies
      WHEN EXISTS (
        SELECT 1 FROM passkey_login_intents
        WHERE challenge_reference = NEW.challenge_reference
      )
      BEGIN
        SELECT RAISE(ABORT, 'passkey challenge already belongs to a login intent');
      END;

      CREATE TRIGGER trg_passkey_ceremonies_login_challenge_exclusive_update
      BEFORE UPDATE OF challenge_reference ON passkey_ceremonies
      WHEN NEW.challenge_reference IS NOT OLD.challenge_reference
        AND EXISTS (
          SELECT 1 FROM passkey_login_intents
          WHERE challenge_reference = NEW.challenge_reference
        )
      BEGIN
        SELECT RAISE(ABORT, 'passkey challenge already belongs to a login intent');
      END;

      CREATE TRIGGER trg_passkey_login_intents_immutable_binding
      BEFORE UPDATE OF
        intent_id, schema_version, purpose_type, purpose_target_digest,
        policy_version, access_token_ttl_seconds, session_ttl_seconds,
        recovery_grace_seconds, expected_rp_id, expected_origin, timeout_ms,
        max_response_bytes, max_attempts, allowed_algorithms_json,
        user_verification, cross_origin_allowed, credential_boundary,
        challenge_reference, challenge_digest, delivery_nonce_digest,
        refresh_derivation_key_id, created_at_ms, expires_at_ms
      ON passkey_login_intents
      WHEN NEW.intent_id IS NOT OLD.intent_id
        OR NEW.schema_version IS NOT OLD.schema_version
        OR NEW.purpose_type IS NOT OLD.purpose_type
        OR NEW.purpose_target_digest IS NOT OLD.purpose_target_digest
        OR NEW.policy_version IS NOT OLD.policy_version
        OR NEW.access_token_ttl_seconds IS NOT OLD.access_token_ttl_seconds
        OR NEW.session_ttl_seconds IS NOT OLD.session_ttl_seconds
        OR NEW.recovery_grace_seconds IS NOT OLD.recovery_grace_seconds
        OR NEW.expected_rp_id IS NOT OLD.expected_rp_id
        OR NEW.expected_origin IS NOT OLD.expected_origin
        OR NEW.timeout_ms IS NOT OLD.timeout_ms
        OR NEW.max_response_bytes IS NOT OLD.max_response_bytes
        OR NEW.max_attempts IS NOT OLD.max_attempts
        OR NEW.allowed_algorithms_json IS NOT OLD.allowed_algorithms_json
        OR NEW.user_verification IS NOT OLD.user_verification
        OR NEW.cross_origin_allowed IS NOT OLD.cross_origin_allowed
        OR NEW.credential_boundary IS NOT OLD.credential_boundary
        OR NEW.challenge_reference IS NOT OLD.challenge_reference
        OR NEW.challenge_digest IS NOT OLD.challenge_digest
        OR NEW.delivery_nonce_digest IS NOT OLD.delivery_nonce_digest
        OR NEW.refresh_derivation_key_id IS NOT OLD.refresh_derivation_key_id
        OR NEW.created_at_ms IS NOT OLD.created_at_ms
        OR NEW.expires_at_ms IS NOT OLD.expires_at_ms
      BEGIN
        SELECT RAISE(ABORT, 'passkey login intent binding is immutable');
      END;

      CREATE TRIGGER trg_passkey_login_intents_state_transition
      BEFORE UPDATE ON passkey_login_intents
      WHEN OLD.state <> 'pending'
        OR NEW.revision <> OLD.revision + 1
        OR NEW.updated_at_ms < OLD.updated_at_ms
        OR NOT (
          (NEW.state = 'pending'
            AND NEW.attempts_used = OLD.attempts_used + 1
            AND NEW.attempts_used < NEW.max_attempts)
          OR (NEW.state = 'rejected'
            AND NEW.attempts_used = OLD.attempts_used + 1
            AND NEW.attempts_used = NEW.max_attempts)
          OR (NEW.state IN ('consumed', 'cancelled', 'expired')
            AND NEW.attempts_used = OLD.attempts_used)
        )
      BEGIN
        SELECT RAISE(ABORT, 'invalid passkey login intent transition');
      END;

      CREATE TRIGGER trg_passkey_login_intents_consumed_proof
      BEFORE UPDATE ON passkey_login_intents
      WHEN NEW.state = 'consumed'
        AND NOT EXISTS (
          SELECT 1
          FROM users accounts
          JOIN passkey_user_handles handles
            ON handles.account_id = accounts.id
          JOIN passkey_credentials credentials
            ON credentials.account_id = accounts.id
            AND credentials.user_handle_ref = handles.reference
          JOIN device_sessions sessions
            ON sessions.user_id = accounts.id
          JOIN refresh_tokens refresh
            ON refresh.session_id = sessions.id
          WHERE accounts.id = NEW.resolved_account_id
            AND handles.reference = NEW.resolved_user_handle_ref
            AND credentials.record_id = NEW.resolved_credential_record_id
            AND credentials.discovery_mode = 'discoverable'
            AND credentials.credential_set_ref IS NULL
            AND credentials.revision = NEW.resolved_credential_revision_after
            AND credentials.sign_count = NEW.resolved_sign_count_after
            AND credentials.backup_eligible = NEW.resolved_backup_eligible
            AND credentials.backup_state = NEW.resolved_backup_state_after
            AND credentials.updated_at_ms = NEW.updated_at_ms
            AND sessions.id = NEW.session_id
            AND sessions.revoked_at IS NULL
            AND sessions.created_at <= sessions.last_seen_at
            AND sessions.created_at < sessions.expires_at
            AND CAST(strftime('%s', sessions.created_at) AS INTEGER)
              = CAST(NEW.updated_at_ms / 1000 AS INTEGER)
            AND CAST(strftime('%s', sessions.expires_at) AS INTEGER)
              = CAST(NEW.updated_at_ms / 1000 AS INTEGER) + NEW.session_ttl_seconds
            AND NEW.initial_access_token_expires_at_sec
              <= CAST(strftime('%s', sessions.expires_at) AS INTEGER)
            AND refresh.id = NEW.initial_refresh_token_id
            AND refresh.used_at IS NULL
            AND length(CAST(refresh.token_hash AS BLOB)) = 43
            AND instr(refresh.token_hash, char(0)) = 0
            AND refresh.token_hash NOT GLOB '*[^A-Za-z0-9_-]*'
            AND refresh.created_at = sessions.created_at
            AND refresh.created_at < refresh.expires_at
            AND refresh.expires_at = sessions.expires_at
        )
      BEGIN
        SELECT RAISE(ABORT, 'passkey login consumed proof is inconsistent');
      END;

      CREATE TRIGGER trg_passkey_login_events_match_intent
      BEFORE INSERT ON passkey_login_events
      WHEN NOT EXISTS (
        SELECT 1 FROM passkey_login_intents intents
        WHERE intents.intent_id = NEW.intent_id
          AND intents.revision = NEW.revision
          AND intents.updated_at_ms = NEW.occurred_at_ms
          AND (
            (NEW.event_type = 'passkey.login.started'
              AND intents.state = 'pending' AND intents.revision = 1)
            OR (NEW.event_type = 'passkey.login.verification_rejected'
              AND intents.state = 'pending' AND intents.revision > 1)
            OR (NEW.event_type = 'passkey.login.consumed'
              AND intents.state = 'consumed')
            OR (NEW.event_type = 'passkey.login.cancelled'
              AND intents.state = 'cancelled')
            OR (NEW.event_type = 'passkey.login.expired'
              AND intents.state = 'expired')
            OR (NEW.event_type = 'passkey.login.attempts_exhausted'
              AND intents.state = 'rejected')
          )
      )
      BEGIN
        SELECT RAISE(ABORT, 'passkey login event does not match intent');
      END;

      CREATE TRIGGER trg_passkey_login_events_safe_payload
      BEFORE INSERT ON passkey_login_events
      WHEN json_type(NEW.event_json) IS NOT 'object'
        OR (SELECT COUNT(*) FROM json_each(NEW.event_json)) <> 4
        OR json_extract(NEW.event_json, '$.type') IS NOT NEW.event_type
        OR json_extract(NEW.event_json, '$.intentId') IS NOT NEW.intent_id
        OR json_extract(NEW.event_json, '$.revision') IS NOT NEW.revision
        OR json_extract(NEW.event_json, '$.state') IS NOT (
          SELECT state FROM passkey_login_intents WHERE intent_id = NEW.intent_id
        )
      BEGIN
        SELECT RAISE(ABORT, 'passkey login event payload is not public-safe');
      END;

      CREATE TRIGGER trg_passkey_login_outbox_matches_event
      BEFORE INSERT ON passkey_login_outbox
      WHEN NOT EXISTS (
        SELECT 1 FROM passkey_login_events events
        WHERE events.event_id = NEW.event_id
          AND events.intent_id = NEW.partition_key
          AND events.occurred_at_ms = NEW.available_at_ms
      )
      BEGIN
        SELECT RAISE(ABORT, 'passkey login outbox does not match event');
      END;

      CREATE TRIGGER trg_passkey_login_outbox_safe_payload
      BEFORE INSERT ON passkey_login_outbox
      WHEN json_type(NEW.payload_json) IS NOT 'object'
        OR (SELECT COUNT(*) FROM json_each(NEW.payload_json)) <> 4
        OR NOT EXISTS (
          SELECT 1 FROM passkey_login_events events
          WHERE events.event_id = NEW.event_id
            AND json_extract(NEW.payload_json, '$.type') IS events.event_type
            AND json_extract(NEW.payload_json, '$.intentId') IS events.intent_id
            AND json_extract(NEW.payload_json, '$.revision') IS events.revision
            AND json_extract(NEW.payload_json, '$.state')
              IS json_extract(events.event_json, '$.state')
        )
      BEGIN
        SELECT RAISE(ABORT, 'passkey login outbox payload is not public-safe');
      END;

      CREATE TRIGGER trg_passkey_login_command_receipts_match_event
      BEFORE INSERT ON passkey_login_command_receipts
      WHEN NOT EXISTS (
        SELECT 1 FROM passkey_login_events events
        WHERE events.event_id = NEW.event_id
          AND events.intent_id = NEW.intent_id
          AND events.revision = NEW.result_revision
          AND events.command_scope = NEW.scope
          AND events.occurred_at_ms = NEW.created_at_ms
          AND (
            (NEW.result_state = 'pending'
              AND events.event_type IN (
                'passkey.login.started', 'passkey.login.verification_rejected'
              ))
            OR (NEW.result_state = 'consumed'
              AND events.event_type = 'passkey.login.consumed')
            OR (NEW.result_state = 'cancelled'
              AND events.event_type = 'passkey.login.cancelled')
            OR (NEW.result_state = 'expired'
              AND events.event_type = 'passkey.login.expired')
            OR (NEW.result_state = 'rejected'
              AND events.event_type = 'passkey.login.attempts_exhausted')
          )
      )
      BEGIN
        SELECT RAISE(ABORT, 'passkey login command receipt does not match event');
      END;

      CREATE TRIGGER trg_passkey_login_command_receipts_safe_result
      BEFORE INSERT ON passkey_login_command_receipts
      WHEN json_type(NEW.result_json) IS NOT 'object'
        OR (SELECT COUNT(*) FROM json_each(NEW.result_json)) <> 3
        OR json_extract(NEW.result_json, '$.intentId') IS NOT NEW.intent_id
        OR json_extract(NEW.result_json, '$.revision') IS NOT NEW.result_revision
        OR json_extract(NEW.result_json, '$.state') IS NOT NEW.result_state
      BEGIN
        SELECT RAISE(ABORT, 'passkey login command result is not public-safe');
      END;

      CREATE TRIGGER trg_passkey_login_creation_receipts_match_event
      BEFORE INSERT ON passkey_login_creation_receipts
      WHEN NOT EXISTS (
        SELECT 1 FROM passkey_login_events events
        WHERE events.event_id = NEW.event_id
          AND events.intent_id = NEW.intent_id
          AND events.revision = 1
          AND events.event_type = 'passkey.login.started'
          AND events.occurred_at_ms = NEW.created_at_ms
      )
      BEGIN
        SELECT RAISE(ABORT, 'passkey login creation receipt does not match event');
      END;

      CREATE TRIGGER trg_passkey_login_creation_receipts_safe_result
      BEFORE INSERT ON passkey_login_creation_receipts
      WHEN json_type(NEW.result_json) IS NOT 'object'
        OR (SELECT COUNT(*) FROM json_each(NEW.result_json)) <> 3
        OR json_extract(NEW.result_json, '$.intentId') IS NOT NEW.intent_id
        OR json_extract(NEW.result_json, '$.revision') IS NOT 1
        OR json_extract(NEW.result_json, '$.state') IS NOT 'pending'
      BEGIN
        SELECT RAISE(ABORT, 'passkey login creation result is not public-safe');
      END;

      CREATE TRIGGER trg_passkey_login_events_no_update
      BEFORE UPDATE ON passkey_login_events
      BEGIN
        SELECT RAISE(ABORT, 'passkey login events are append-only');
      END;

      CREATE TRIGGER trg_passkey_login_events_no_direct_delete
      BEFORE DELETE ON passkey_login_events
      WHEN EXISTS (
        SELECT 1 FROM passkey_login_intents WHERE intent_id = OLD.intent_id
      )
      BEGIN
        SELECT RAISE(ABORT, 'passkey login events are append-only');
      END;

      CREATE TRIGGER trg_passkey_login_outbox_no_update
      BEFORE UPDATE ON passkey_login_outbox
      BEGIN
        SELECT RAISE(ABORT, 'passkey login outbox is append-only');
      END;

      CREATE TRIGGER trg_passkey_login_outbox_no_direct_delete
      BEFORE DELETE ON passkey_login_outbox
      WHEN EXISTS (
        SELECT 1 FROM passkey_login_events WHERE event_id = OLD.event_id
      )
      BEGIN
        SELECT RAISE(ABORT, 'passkey login outbox is append-only');
      END;

      CREATE TRIGGER trg_passkey_login_command_receipts_no_update
      BEFORE UPDATE ON passkey_login_command_receipts
      BEGIN
        SELECT RAISE(ABORT, 'passkey login command receipts are append-only');
      END;

      CREATE TRIGGER trg_passkey_login_command_receipts_no_direct_delete
      BEFORE DELETE ON passkey_login_command_receipts
      WHEN EXISTS (
        SELECT 1 FROM passkey_login_intents WHERE intent_id = OLD.intent_id
      )
      BEGIN
        SELECT RAISE(ABORT, 'passkey login command receipts are append-only');
      END;

      CREATE TRIGGER trg_passkey_login_creation_receipts_no_update
      BEFORE UPDATE ON passkey_login_creation_receipts
      BEGIN
        SELECT RAISE(ABORT, 'passkey login creation receipts are append-only');
      END;

      CREATE TRIGGER trg_passkey_login_creation_receipts_no_direct_delete
      BEFORE DELETE ON passkey_login_creation_receipts
      WHEN EXISTS (
        SELECT 1 FROM passkey_login_intents WHERE intent_id = OLD.intent_id
      )
      BEGIN
        SELECT RAISE(ABORT, 'passkey login creation receipts are append-only');
      END;
    `
  },
  {
    id: "012_passkey_signup_intents",
    sql: `
      CREATE TABLE passkey_signup_intents (
        intent_id TEXT PRIMARY KEY CHECK (
          length(CAST(intent_id AS BLOB)) = 36
          AND instr(intent_id, char(0)) = 0
          AND substr(intent_id, 9, 1) = '-'
          AND substr(intent_id, 14, 1) = '-'
          AND substr(intent_id, 19, 1) = '-'
          AND substr(intent_id, 24, 1) = '-'
          AND substr(intent_id, 15, 1) GLOB '[1-8]'
          AND substr(intent_id, 20, 1) GLOB '[89ab]'
          AND substr(intent_id, 1, 8) NOT GLOB '*[^0-9a-f]*'
          AND substr(intent_id, 10, 4) NOT GLOB '*[^0-9a-f]*'
          AND substr(intent_id, 15, 4) NOT GLOB '*[^0-9a-f]*'
          AND substr(intent_id, 20, 4) NOT GLOB '*[^0-9a-f]*'
          AND substr(intent_id, 25, 12) NOT GLOB '*[^0-9a-f]*'
        ),
        schema_version INTEGER NOT NULL CHECK (schema_version = 1),
        purpose_type TEXT NOT NULL CHECK (purpose_type = 'account.create'),
        purpose_target_digest TEXT NOT NULL CHECK (
          length(CAST(purpose_target_digest AS BLOB)) = 64
          AND instr(purpose_target_digest, char(0)) = 0
          AND purpose_target_digest NOT GLOB '*[^0-9a-f]*'
        ),
        policy_version INTEGER NOT NULL CHECK (policy_version = 1),
        rp_name TEXT NOT NULL CHECK (rp_name = 'Luxora'),
        expected_rp_id TEXT NOT NULL CHECK (expected_rp_id = 'auth.luxora.app'),
        expected_origin TEXT NOT NULL CHECK (expected_origin = 'https://auth.luxora.app'),
        expected_top_origins_json TEXT NOT NULL CHECK (expected_top_origins_json = '[]'),
        timeout_ms INTEGER NOT NULL CHECK (timeout_ms BETWEEN 300000 AND 600000),
        max_response_bytes INTEGER NOT NULL CHECK (max_response_bytes BETWEEN 1 AND 65536),
        max_attempts INTEGER NOT NULL CHECK (max_attempts BETWEEN 1 AND 5),
        allowed_algorithms_json TEXT NOT NULL CHECK (allowed_algorithms_json = '[-7,-257]'),
        require_user_presence INTEGER NOT NULL CHECK (require_user_presence = 1),
        user_verification TEXT NOT NULL CHECK (user_verification = 'required'),
        resident_key TEXT NOT NULL CHECK (resident_key = 'required'),
        attestation TEXT NOT NULL CHECK (attestation = 'none'),
        cross_origin_allowed INTEGER NOT NULL CHECK (cross_origin_allowed = 0),
        exclude_credentials_json TEXT NOT NULL CHECK (exclude_credentials_json = '[]'),
        candidate_account_id TEXT NOT NULL UNIQUE CHECK (
          length(CAST(candidate_account_id AS BLOB)) = 36
          AND instr(candidate_account_id, char(0)) = 0
          AND substr(candidate_account_id, 9, 1) = '-'
          AND substr(candidate_account_id, 14, 1) = '-'
          AND substr(candidate_account_id, 19, 1) = '-'
          AND substr(candidate_account_id, 24, 1) = '-'
          AND substr(candidate_account_id, 15, 1) GLOB '[1-8]'
          AND substr(candidate_account_id, 20, 1) GLOB '[89ab]'
          AND substr(candidate_account_id, 1, 8) NOT GLOB '*[^0-9a-f]*'
          AND substr(candidate_account_id, 10, 4) NOT GLOB '*[^0-9a-f]*'
          AND substr(candidate_account_id, 15, 4) NOT GLOB '*[^0-9a-f]*'
          AND substr(candidate_account_id, 20, 4) NOT GLOB '*[^0-9a-f]*'
          AND substr(candidate_account_id, 25, 12) NOT GLOB '*[^0-9a-f]*'
        ),
        candidate_username_ciphertext TEXT NOT NULL
          CHECK (candidate_username_ciphertext GLOB 'luxora:v1.*'),
        candidate_username_normalized_ciphertext TEXT NOT NULL
          CHECK (candidate_username_normalized_ciphertext GLOB 'luxora:v1.*'),
        candidate_display_name_ciphertext TEXT NOT NULL
          CHECK (candidate_display_name_ciphertext GLOB 'luxora:v1.*'),
        candidate_user_handle_ref TEXT NOT NULL UNIQUE CHECK (
          length(CAST(candidate_user_handle_ref AS BLOB)) BETWEEN 1 AND 192
          AND instr(candidate_user_handle_ref, char(0)) = 0
        ),
        candidate_user_handle_digest TEXT NOT NULL UNIQUE CHECK (
          length(CAST(candidate_user_handle_digest AS BLOB)) = 64
          AND instr(candidate_user_handle_digest, char(0)) = 0
          AND candidate_user_handle_digest NOT GLOB '*[^0-9a-f]*'
        ),
        candidate_user_handle_ciphertext TEXT NOT NULL
          CHECK (candidate_user_handle_ciphertext GLOB 'luxora:v1.*'),
        challenge_reference TEXT NOT NULL UNIQUE CHECK (
          length(CAST(challenge_reference AS BLOB)) BETWEEN 1 AND 192
          AND instr(challenge_reference, char(0)) = 0
        ),
        challenge_digest TEXT NOT NULL CHECK (
          length(CAST(challenge_digest AS BLOB)) = 64
          AND instr(challenge_digest, char(0)) = 0
          AND challenge_digest NOT GLOB '*[^0-9a-f]*'
        ),
        delivery_nonce_digest TEXT NOT NULL CHECK (
          length(CAST(delivery_nonce_digest AS BLOB)) = 64
          AND instr(delivery_nonce_digest, char(0)) = 0
          AND delivery_nonce_digest NOT GLOB '*[^0-9a-f]*'
        ),
        state TEXT NOT NULL CHECK (state IN ('pending', 'consumed', 'expired', 'rejected')),
        revision INTEGER NOT NULL CHECK (revision >= 1),
        attempts_used INTEGER NOT NULL CHECK (attempts_used BETWEEN 0 AND 5),
        created_at_ms INTEGER NOT NULL CHECK (created_at_ms BETWEEN 0 AND 9007199254740991),
        expires_at_ms INTEGER NOT NULL CHECK (expires_at_ms BETWEEN 0 AND 9007199254740991),
        updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms BETWEEN 0 AND 9007199254740991),
        terminal_at_ms INTEGER CHECK (terminal_at_ms BETWEEN 0 AND 9007199254740991),
        terminal_reason TEXT CHECK (terminal_reason IN ('verified', 'expired', 'attempts_exhausted')),
        resolved_credential_record_id TEXT CHECK (
          resolved_credential_record_id IS NULL OR (
            length(CAST(resolved_credential_record_id AS BLOB)) BETWEEN 1 AND 192
            AND instr(resolved_credential_record_id, char(0)) = 0
          )
        ),
        CHECK (created_at_ms <= updated_at_ms),
        CHECK (created_at_ms <= 9007199254740991 - timeout_ms),
        CHECK (expires_at_ms = created_at_ms + timeout_ms),
        CHECK (attempts_used <= max_attempts),
        CHECK (
          (state = 'pending'
            AND attempts_used < max_attempts
            AND revision = attempts_used + 1
            AND terminal_at_ms IS NULL
            AND terminal_reason IS NULL
            AND resolved_credential_record_id IS NULL
            AND updated_at_ms < expires_at_ms)
          OR (state = 'consumed'
            AND attempts_used < max_attempts
            AND revision = attempts_used + 2
            AND terminal_at_ms = updated_at_ms
            AND terminal_reason = 'verified'
            AND resolved_credential_record_id IS NOT NULL
            AND updated_at_ms < expires_at_ms)
          OR (state = 'expired'
            AND attempts_used < max_attempts
            AND revision = attempts_used + 2
            AND terminal_at_ms = updated_at_ms
            AND terminal_reason = 'expired'
            AND resolved_credential_record_id IS NULL
            AND updated_at_ms >= expires_at_ms)
          OR (state = 'rejected'
            AND attempts_used = max_attempts
            AND revision = attempts_used + 1
            AND terminal_at_ms = updated_at_ms
            AND terminal_reason = 'attempts_exhausted'
            AND resolved_credential_record_id IS NULL
            AND updated_at_ms < expires_at_ms)
        )
      ) STRICT;
      CREATE INDEX idx_passkey_signup_intents_expiry
        ON passkey_signup_intents(state, expires_at_ms, intent_id);
      CREATE INDEX idx_passkey_signup_intents_retention
        ON passkey_signup_intents(terminal_at_ms, intent_id)
        WHERE terminal_at_ms IS NOT NULL;
      CREATE INDEX idx_passkey_signup_intents_created
        ON passkey_signup_intents(created_at_ms, intent_id);
      CREATE UNIQUE INDEX idx_passkey_signup_intents_credential_claim
        ON passkey_signup_intents(resolved_credential_record_id)
        WHERE state = 'consumed';
      CREATE TABLE passkey_signup_events (
        event_id TEXT PRIMARY KEY CHECK (
          length(CAST(event_id AS BLOB)) BETWEEN 1 AND 192
          AND instr(event_id, char(0)) = 0
        ),
        intent_id TEXT NOT NULL REFERENCES passkey_signup_intents(intent_id) ON DELETE CASCADE,
        revision INTEGER NOT NULL CHECK (revision >= 1),
        event_type TEXT NOT NULL CHECK (event_type IN (
          'passkey.signup.started',
          'passkey.signup.verification_rejected',
          'passkey.signup.consumed',
          'passkey.signup.expired',
          'passkey.signup.attempts_exhausted'
        )),
        command_scope TEXT NOT NULL CHECK (
          length(CAST(command_scope AS BLOB)) BETWEEN 1 AND 192
          AND instr(command_scope, char(0)) = 0
        ),
        occurred_at_ms INTEGER NOT NULL CHECK (occurred_at_ms BETWEEN 0 AND 9007199254740991),
        event_json TEXT NOT NULL CHECK (json_valid(event_json)),
        UNIQUE (intent_id, revision),
        UNIQUE (event_id, intent_id, revision)
      ) STRICT;
      CREATE INDEX idx_passkey_signup_events_created
        ON passkey_signup_events(occurred_at_ms, event_id);

      CREATE TABLE passkey_signup_outbox (
        outbox_id TEXT PRIMARY KEY CHECK (
          length(CAST(outbox_id AS BLOB)) BETWEEN 1 AND 192
          AND instr(outbox_id, char(0)) = 0
        ),
        event_id TEXT NOT NULL UNIQUE REFERENCES passkey_signup_events(event_id) ON DELETE CASCADE,
        topic TEXT NOT NULL CHECK (topic = 'luxora.passkey-signup.v1'),
        partition_key TEXT NOT NULL CHECK (
          length(CAST(partition_key AS BLOB)) BETWEEN 1 AND 192
          AND instr(partition_key, char(0)) = 0
        ),
        available_at_ms INTEGER NOT NULL CHECK (available_at_ms BETWEEN 0 AND 9007199254740991),
        payload_json TEXT NOT NULL CHECK (json_valid(payload_json))
      ) STRICT;
      CREATE INDEX idx_passkey_signup_outbox_available
        ON passkey_signup_outbox(available_at_ms, outbox_id);

      CREATE TABLE passkey_signup_command_receipts (
        scope TEXT PRIMARY KEY CHECK (
          length(CAST(scope AS BLOB)) BETWEEN 1 AND 192
          AND instr(scope, char(0)) = 0
        ),
        fingerprint TEXT NOT NULL CHECK (
          length(CAST(fingerprint AS BLOB)) = 64
          AND instr(fingerprint, char(0)) = 0
          AND fingerprint NOT GLOB '*[^0-9a-f]*'
        ),
        intent_id TEXT NOT NULL REFERENCES passkey_signup_intents(intent_id) ON DELETE CASCADE,
        result_revision INTEGER NOT NULL CHECK (result_revision >= 1),
        result_state TEXT NOT NULL CHECK (result_state IN ('pending', 'consumed', 'expired', 'rejected')),
        event_id TEXT NOT NULL,
        result_json TEXT NOT NULL CHECK (json_valid(result_json)),
        created_at_ms INTEGER NOT NULL CHECK (created_at_ms BETWEEN 0 AND 9007199254740991),
        FOREIGN KEY (event_id, intent_id, result_revision)
          REFERENCES passkey_signup_events(event_id, intent_id, revision) ON DELETE CASCADE
      ) STRICT;
      CREATE INDEX idx_passkey_signup_command_receipts_intent
        ON passkey_signup_command_receipts(intent_id, result_revision);
      CREATE INDEX idx_passkey_signup_command_receipts_created
        ON passkey_signup_command_receipts(created_at_ms, scope);

      CREATE TABLE passkey_signup_creation_receipts (
        scope TEXT PRIMARY KEY CHECK (
          length(CAST(scope AS BLOB)) BETWEEN 1 AND 192
          AND instr(scope, char(0)) = 0
        ),
        fingerprint TEXT NOT NULL CHECK (
          length(CAST(fingerprint AS BLOB)) = 64
          AND instr(fingerprint, char(0)) = 0
          AND fingerprint NOT GLOB '*[^0-9a-f]*'
        ),
        intent_id TEXT NOT NULL REFERENCES passkey_signup_intents(intent_id) ON DELETE CASCADE,
        result_revision INTEGER NOT NULL CHECK (result_revision = 1),
        result_state TEXT NOT NULL CHECK (result_state = 'pending'),
        event_id TEXT NOT NULL,
        result_json TEXT NOT NULL CHECK (json_valid(result_json)),
        created_at_ms INTEGER NOT NULL CHECK (created_at_ms BETWEEN 0 AND 9007199254740991),
        FOREIGN KEY (event_id, intent_id, result_revision)
          REFERENCES passkey_signup_events(event_id, intent_id, revision) ON DELETE CASCADE
      ) STRICT;
      CREATE INDEX idx_passkey_signup_creation_receipts_intent
        ON passkey_signup_creation_receipts(intent_id);
      CREATE INDEX idx_passkey_signup_creation_receipts_created
        ON passkey_signup_creation_receipts(created_at_ms, scope);

      CREATE TRIGGER trg_passkey_signup_intents_initial_state
      BEFORE INSERT ON passkey_signup_intents
      WHEN NEW.state <> 'pending'
        OR NEW.revision <> 1
        OR NEW.attempts_used <> 0
        OR NEW.updated_at_ms <> NEW.created_at_ms
      BEGIN
        SELECT RAISE(ABORT, 'passkey signup intent must begin pending');
      END;

      CREATE TRIGGER trg_passkey_signup_intents_challenge_exclusive
      BEFORE INSERT ON passkey_signup_intents
      WHEN EXISTS (
        SELECT 1 FROM passkey_ceremonies WHERE challenge_reference = NEW.challenge_reference
      ) OR EXISTS (
        SELECT 1 FROM passkey_login_intents WHERE challenge_reference = NEW.challenge_reference
      )
      BEGIN
        SELECT RAISE(ABORT, 'passkey challenge already belongs to another subject');
      END;

      CREATE TRIGGER trg_passkey_ceremonies_signup_challenge_exclusive_insert
      BEFORE INSERT ON passkey_ceremonies
      WHEN EXISTS (
        SELECT 1 FROM passkey_signup_intents WHERE challenge_reference = NEW.challenge_reference
      )
      BEGIN
        SELECT RAISE(ABORT, 'passkey challenge already belongs to a signup intent');
      END;

      CREATE TRIGGER trg_passkey_ceremonies_signup_challenge_exclusive_update
      BEFORE UPDATE OF challenge_reference ON passkey_ceremonies
      WHEN NEW.challenge_reference IS NOT OLD.challenge_reference
        AND EXISTS (
          SELECT 1 FROM passkey_signup_intents WHERE challenge_reference = NEW.challenge_reference
        )
      BEGIN
        SELECT RAISE(ABORT, 'passkey challenge already belongs to a signup intent');
      END;

      CREATE TRIGGER trg_passkey_login_signup_challenge_exclusive_insert
      BEFORE INSERT ON passkey_login_intents
      WHEN EXISTS (
        SELECT 1 FROM passkey_signup_intents WHERE challenge_reference = NEW.challenge_reference
      )
      BEGIN
        SELECT RAISE(ABORT, 'passkey challenge already belongs to a signup intent');
      END;

      CREATE TRIGGER trg_passkey_signup_intents_immutable_binding
      BEFORE UPDATE OF
        intent_id, schema_version, purpose_type, purpose_target_digest, policy_version,
        rp_name, expected_rp_id, expected_origin, expected_top_origins_json,
        timeout_ms, max_response_bytes,
        max_attempts, allowed_algorithms_json, require_user_presence, user_verification,
        resident_key, attestation, cross_origin_allowed, exclude_credentials_json,
        candidate_account_id, candidate_username_ciphertext,
        candidate_username_normalized_ciphertext,
        candidate_display_name_ciphertext,
        candidate_user_handle_ref, candidate_user_handle_digest,
        candidate_user_handle_ciphertext, challenge_reference, challenge_digest,
        delivery_nonce_digest,
        created_at_ms, expires_at_ms
      ON passkey_signup_intents
      WHEN NEW.intent_id IS NOT OLD.intent_id
        OR NEW.schema_version IS NOT OLD.schema_version
        OR NEW.purpose_type IS NOT OLD.purpose_type
        OR NEW.purpose_target_digest IS NOT OLD.purpose_target_digest
        OR NEW.policy_version IS NOT OLD.policy_version
        OR NEW.rp_name IS NOT OLD.rp_name
        OR NEW.expected_rp_id IS NOT OLD.expected_rp_id
        OR NEW.expected_origin IS NOT OLD.expected_origin
        OR NEW.expected_top_origins_json IS NOT OLD.expected_top_origins_json
        OR NEW.timeout_ms IS NOT OLD.timeout_ms
        OR NEW.max_response_bytes IS NOT OLD.max_response_bytes
        OR NEW.max_attempts IS NOT OLD.max_attempts
        OR NEW.allowed_algorithms_json IS NOT OLD.allowed_algorithms_json
        OR NEW.require_user_presence IS NOT OLD.require_user_presence
        OR NEW.user_verification IS NOT OLD.user_verification
        OR NEW.resident_key IS NOT OLD.resident_key
        OR NEW.attestation IS NOT OLD.attestation
        OR NEW.cross_origin_allowed IS NOT OLD.cross_origin_allowed
        OR NEW.exclude_credentials_json IS NOT OLD.exclude_credentials_json
        OR NEW.candidate_account_id IS NOT OLD.candidate_account_id
        OR NEW.candidate_username_ciphertext IS NOT OLD.candidate_username_ciphertext
        OR NEW.candidate_username_normalized_ciphertext IS NOT OLD.candidate_username_normalized_ciphertext
        OR NEW.candidate_display_name_ciphertext IS NOT OLD.candidate_display_name_ciphertext
        OR NEW.candidate_user_handle_ref IS NOT OLD.candidate_user_handle_ref
        OR NEW.candidate_user_handle_digest IS NOT OLD.candidate_user_handle_digest
        OR NEW.candidate_user_handle_ciphertext IS NOT OLD.candidate_user_handle_ciphertext
        OR NEW.challenge_reference IS NOT OLD.challenge_reference
        OR NEW.challenge_digest IS NOT OLD.challenge_digest
        OR NEW.delivery_nonce_digest IS NOT OLD.delivery_nonce_digest
        OR NEW.created_at_ms IS NOT OLD.created_at_ms
        OR NEW.expires_at_ms IS NOT OLD.expires_at_ms
      BEGIN
        SELECT RAISE(ABORT, 'passkey signup intent binding is immutable');
      END;

      CREATE TRIGGER trg_passkey_signup_intents_consumption_reserved
      BEFORE UPDATE OF state ON passkey_signup_intents
      WHEN NEW.state = 'consumed'
      BEGIN
        SELECT RAISE(ABORT, 'passkey signup consumption requires atomic account creation');
      END;

      CREATE TRIGGER trg_passkey_signup_intents_state_transition
      BEFORE UPDATE ON passkey_signup_intents
      WHEN OLD.state <> 'pending'
        OR NEW.revision <> OLD.revision + 1
        OR NEW.updated_at_ms < OLD.updated_at_ms
        OR NOT (
          (NEW.state = 'pending'
            AND NEW.attempts_used = OLD.attempts_used + 1
            AND NEW.attempts_used < NEW.max_attempts)
          OR (NEW.state = 'rejected'
            AND NEW.attempts_used = OLD.attempts_used + 1
            AND NEW.attempts_used = NEW.max_attempts)
          OR (NEW.state IN ('consumed', 'expired')
            AND NEW.attempts_used = OLD.attempts_used)
        )
      BEGIN
        SELECT RAISE(ABORT, 'invalid passkey signup intent transition');
      END;

      CREATE TRIGGER trg_passkey_signup_intents_no_pending_delete
      BEFORE DELETE ON passkey_signup_intents
      WHEN OLD.state = 'pending'
      BEGIN
        SELECT RAISE(ABORT, 'pending passkey signup intent cannot be deleted');
      END;

      CREATE TRIGGER trg_passkey_signup_events_match_intent
      BEFORE INSERT ON passkey_signup_events
      WHEN NOT EXISTS (
        SELECT 1 FROM passkey_signup_intents intents
        WHERE intents.intent_id = NEW.intent_id
          AND intents.revision = NEW.revision
          AND intents.updated_at_ms = NEW.occurred_at_ms
          AND (
            (NEW.event_type = 'passkey.signup.started'
              AND intents.state = 'pending' AND intents.revision = 1)
            OR (NEW.event_type = 'passkey.signup.verification_rejected'
              AND intents.state = 'pending' AND intents.revision > 1)
            OR (NEW.event_type = 'passkey.signup.consumed'
              AND intents.state = 'consumed')
            OR (NEW.event_type = 'passkey.signup.expired'
              AND intents.state = 'expired')
            OR (NEW.event_type = 'passkey.signup.attempts_exhausted'
              AND intents.state = 'rejected')
          )
      )
      BEGIN
        SELECT RAISE(ABORT, 'passkey signup event does not match intent');
      END;

      CREATE TRIGGER trg_passkey_signup_events_safe_payload
      BEFORE INSERT ON passkey_signup_events
      WHEN json_type(NEW.event_json) IS NOT 'object'
        OR (SELECT COUNT(*) FROM json_each(NEW.event_json)) <> 4
        OR json_extract(NEW.event_json, '$.type') IS NOT NEW.event_type
        OR json_extract(NEW.event_json, '$.intentId') IS NOT NEW.intent_id
        OR json_extract(NEW.event_json, '$.revision') IS NOT NEW.revision
        OR json_extract(NEW.event_json, '$.state') IS NOT (
          SELECT state FROM passkey_signup_intents WHERE intent_id = NEW.intent_id
        )
      BEGIN
        SELECT RAISE(ABORT, 'passkey signup event payload is not public-safe');
      END;

      CREATE TRIGGER trg_passkey_signup_outbox_matches_event
      BEFORE INSERT ON passkey_signup_outbox
      WHEN NOT EXISTS (
        SELECT 1 FROM passkey_signup_events events
        WHERE events.event_id = NEW.event_id
          AND events.intent_id = NEW.partition_key
          AND events.occurred_at_ms = NEW.available_at_ms
      )
      BEGIN
        SELECT RAISE(ABORT, 'passkey signup outbox does not match event');
      END;

      CREATE TRIGGER trg_passkey_signup_outbox_safe_payload
      BEFORE INSERT ON passkey_signup_outbox
      WHEN json_type(NEW.payload_json) IS NOT 'object'
        OR (SELECT COUNT(*) FROM json_each(NEW.payload_json)) <> 4
        OR NOT EXISTS (
          SELECT 1 FROM passkey_signup_events events
          WHERE events.event_id = NEW.event_id
            AND json_extract(NEW.payload_json, '$.type') IS events.event_type
            AND json_extract(NEW.payload_json, '$.intentId') IS events.intent_id
            AND json_extract(NEW.payload_json, '$.revision') IS events.revision
            AND json_extract(NEW.payload_json, '$.state')
              IS json_extract(events.event_json, '$.state')
        )
      BEGIN
        SELECT RAISE(ABORT, 'passkey signup outbox payload is not public-safe');
      END;

      CREATE TRIGGER trg_passkey_signup_command_receipts_match_event
      BEFORE INSERT ON passkey_signup_command_receipts
      WHEN NOT EXISTS (
        SELECT 1 FROM passkey_signup_events events
        WHERE events.event_id = NEW.event_id
          AND events.intent_id = NEW.intent_id
          AND events.revision = NEW.result_revision
          AND events.command_scope = NEW.scope
          AND events.occurred_at_ms = NEW.created_at_ms
          AND (
            (NEW.result_state = 'pending'
              AND events.event_type IN (
                'passkey.signup.started', 'passkey.signup.verification_rejected'
              ))
            OR (NEW.result_state = 'consumed'
              AND events.event_type = 'passkey.signup.consumed')
            OR (NEW.result_state = 'expired'
              AND events.event_type = 'passkey.signup.expired')
            OR (NEW.result_state = 'rejected'
              AND events.event_type = 'passkey.signup.attempts_exhausted')
          )
      )
      BEGIN
        SELECT RAISE(ABORT, 'passkey signup command receipt does not match event');
      END;

      CREATE TRIGGER trg_passkey_signup_command_receipts_safe_result
      BEFORE INSERT ON passkey_signup_command_receipts
      WHEN json_type(NEW.result_json) IS NOT 'object'
        OR (SELECT COUNT(*) FROM json_each(NEW.result_json)) <> 3
        OR json_extract(NEW.result_json, '$.intentId') IS NOT NEW.intent_id
        OR json_extract(NEW.result_json, '$.revision') IS NOT NEW.result_revision
        OR json_extract(NEW.result_json, '$.state') IS NOT NEW.result_state
      BEGIN
        SELECT RAISE(ABORT, 'passkey signup command result is not public-safe');
      END;

      CREATE TRIGGER trg_passkey_signup_creation_receipts_match_event
      BEFORE INSERT ON passkey_signup_creation_receipts
      WHEN NOT EXISTS (
        SELECT 1 FROM passkey_signup_events events
        WHERE events.event_id = NEW.event_id
          AND events.intent_id = NEW.intent_id
          AND events.revision = 1
          AND events.event_type = 'passkey.signup.started'
          AND events.occurred_at_ms = NEW.created_at_ms
      )
      BEGIN
        SELECT RAISE(ABORT, 'passkey signup creation receipt does not match event');
      END;

      CREATE TRIGGER trg_passkey_signup_creation_receipts_safe_result
      BEFORE INSERT ON passkey_signup_creation_receipts
      WHEN json_type(NEW.result_json) IS NOT 'object'
        OR (SELECT COUNT(*) FROM json_each(NEW.result_json)) <> 3
        OR json_extract(NEW.result_json, '$.intentId') IS NOT NEW.intent_id
        OR json_extract(NEW.result_json, '$.revision') IS NOT 1
        OR json_extract(NEW.result_json, '$.state') IS NOT 'pending'
      BEGIN
        SELECT RAISE(ABORT, 'passkey signup creation result is not public-safe');
      END;

      CREATE TRIGGER trg_passkey_signup_events_no_update
      BEFORE UPDATE ON passkey_signup_events
      BEGIN
        SELECT RAISE(ABORT, 'passkey signup events are append-only');
      END;
      CREATE TRIGGER trg_passkey_signup_events_no_direct_delete
      BEFORE DELETE ON passkey_signup_events
      WHEN EXISTS (SELECT 1 FROM passkey_signup_intents WHERE intent_id = OLD.intent_id)
      BEGIN
        SELECT RAISE(ABORT, 'passkey signup events are append-only');
      END;
      CREATE TRIGGER trg_passkey_signup_outbox_no_update
      BEFORE UPDATE ON passkey_signup_outbox
      BEGIN
        SELECT RAISE(ABORT, 'passkey signup outbox is append-only');
      END;
      CREATE TRIGGER trg_passkey_signup_outbox_no_direct_delete
      BEFORE DELETE ON passkey_signup_outbox
      WHEN EXISTS (SELECT 1 FROM passkey_signup_events WHERE event_id = OLD.event_id)
      BEGIN
        SELECT RAISE(ABORT, 'passkey signup outbox is append-only');
      END;
      CREATE TRIGGER trg_passkey_signup_command_receipts_no_update
      BEFORE UPDATE ON passkey_signup_command_receipts
      BEGIN
        SELECT RAISE(ABORT, 'passkey signup command receipts are append-only');
      END;
      CREATE TRIGGER trg_passkey_signup_command_receipts_no_direct_delete
      BEFORE DELETE ON passkey_signup_command_receipts
      WHEN EXISTS (SELECT 1 FROM passkey_signup_intents WHERE intent_id = OLD.intent_id)
      BEGIN
        SELECT RAISE(ABORT, 'passkey signup command receipts are append-only');
      END;
      CREATE TRIGGER trg_passkey_signup_creation_receipts_no_update
      BEFORE UPDATE ON passkey_signup_creation_receipts
      BEGIN
        SELECT RAISE(ABORT, 'passkey signup creation receipts are append-only');
      END;
      CREATE TRIGGER trg_passkey_signup_creation_receipts_no_direct_delete
      BEFORE DELETE ON passkey_signup_creation_receipts
      WHEN EXISTS (SELECT 1 FROM passkey_signup_intents WHERE intent_id = OLD.intent_id)
      BEGIN
        SELECT RAISE(ABORT, 'passkey signup creation receipts are append-only');
      END;
    `
  },
  {
    id: "013_passkey_signup_consumption",
    sql: `
      ALTER TABLE users ADD COLUMN password_auth_enabled INTEGER NOT NULL DEFAULT 1
        CHECK (password_auth_enabled IN (0, 1));

      DROP TRIGGER trg_passkey_signup_intents_consumption_reserved;

      CREATE UNIQUE INDEX idx_passkey_signup_intents_consumption_parent
        ON passkey_signup_intents(
          intent_id, resolved_credential_record_id, state, revision
        );

      CREATE TABLE passkey_signup_consumptions (
        intent_id TEXT PRIMARY KEY,
        result_revision INTEGER NOT NULL CHECK (result_revision >= 2),
        result_state TEXT NOT NULL CHECK (result_state = 'consumed'),
        account_id TEXT NOT NULL UNIQUE,
        user_handle_ref TEXT NOT NULL UNIQUE CHECK (
          length(CAST(user_handle_ref AS BLOB)) BETWEEN 1 AND 192
          AND instr(user_handle_ref, char(0)) = 0
        ),
        credential_record_id TEXT NOT NULL UNIQUE CHECK (
          length(CAST(credential_record_id AS BLOB)) BETWEEN 1 AND 192
          AND instr(credential_record_id, char(0)) = 0
        ),
        session_id TEXT NOT NULL UNIQUE,
        initial_refresh_token_id TEXT NOT NULL UNIQUE,
        initial_access_token_expires_at_sec INTEGER NOT NULL CHECK (
          initial_access_token_expires_at_sec BETWEEN 0 AND 9007199254740991
        ),
        refresh_derivation_key_id TEXT NOT NULL CHECK (
          length(CAST(refresh_derivation_key_id AS BLOB)) BETWEEN 1 AND 64
          AND instr(refresh_derivation_key_id, char(0)) = 0
          AND substr(refresh_derivation_key_id, 1, 1) GLOB '[A-Za-z0-9]'
          AND refresh_derivation_key_id NOT GLOB '*[^A-Za-z0-9._-]*'
        ),
        committed_at_ms INTEGER NOT NULL CHECK (
          committed_at_ms BETWEEN 0 AND 9007199254740991
        ),
        FOREIGN KEY (
          intent_id, credential_record_id, result_state, result_revision
        ) REFERENCES passkey_signup_intents(
          intent_id, resolved_credential_record_id, state, revision
        ) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED
      ) STRICT;
      CREATE INDEX idx_passkey_signup_consumptions_committed
        ON passkey_signup_consumptions(committed_at_ms, intent_id);

      CREATE TRIGGER trg_passkey_signup_consumptions_bind_candidate
      BEFORE INSERT ON passkey_signup_consumptions
      WHEN NOT EXISTS (
        SELECT 1
        FROM passkey_signup_intents intents
        JOIN users accounts ON accounts.id = intents.candidate_account_id
        JOIN passkey_user_handles handles
          ON handles.account_id = accounts.id
          AND handles.reference = intents.candidate_user_handle_ref
        JOIN device_sessions sessions
          ON sessions.user_id = accounts.id
          AND sessions.id = NEW.session_id
        JOIN refresh_tokens refresh
          ON refresh.session_id = sessions.id
          AND refresh.id = NEW.initial_refresh_token_id
        WHERE intents.intent_id = NEW.intent_id
          AND intents.state = 'pending'
          AND intents.revision + 1 = NEW.result_revision
          AND NEW.result_state = 'consumed'
          AND intents.candidate_account_id = NEW.account_id
          AND intents.candidate_user_handle_ref = NEW.user_handle_ref
          AND accounts.password_auth_enabled = 0
          AND sessions.revoked_at IS NULL
          AND sessions.created_at = sessions.last_seen_at
          AND sessions.created_at < sessions.expires_at
          AND refresh.used_at IS NULL
          AND refresh.created_at = sessions.created_at
          AND refresh.expires_at = sessions.expires_at
          AND length(CAST(refresh.token_hash AS BLOB)) = 43
          AND instr(refresh.token_hash, char(0)) = 0
          AND refresh.token_hash NOT GLOB '*[^A-Za-z0-9_-]*'
          AND NEW.committed_at_ms >= intents.updated_at_ms
          AND NEW.committed_at_ms < intents.expires_at_ms
          AND NEW.initial_access_token_expires_at_sec
            > CAST(NEW.committed_at_ms / 1000 AS INTEGER)
          AND NEW.initial_access_token_expires_at_sec
            <= CAST(strftime('%s', sessions.expires_at) AS INTEGER)
      )
      BEGIN
        SELECT RAISE(ABORT, 'passkey signup consumption binding is inconsistent');
      END;

      CREATE TRIGGER trg_passkey_signup_consumptions_immutable
      BEFORE UPDATE ON passkey_signup_consumptions
      BEGIN
        SELECT RAISE(ABORT, 'passkey signup consumption is immutable');
      END;

      CREATE TRIGGER trg_passkey_signup_consumptions_no_direct_delete
      BEFORE DELETE ON passkey_signup_consumptions
      WHEN EXISTS (
        SELECT 1 FROM passkey_signup_intents WHERE intent_id = OLD.intent_id
      )
      BEGIN
        SELECT RAISE(ABORT, 'passkey signup consumption cannot be deleted while intent exists');
      END;

      CREATE TRIGGER trg_passkey_signup_intents_consumed_proof
      BEFORE UPDATE ON passkey_signup_intents
      WHEN NEW.state = 'consumed'
        AND NOT EXISTS (
          SELECT 1
          FROM passkey_signup_consumptions consumption
          JOIN users accounts ON accounts.id = consumption.account_id
          JOIN passkey_user_handles handles
            ON handles.account_id = accounts.id
            AND handles.reference = consumption.user_handle_ref
          JOIN passkey_credentials credentials
            ON credentials.account_id = accounts.id
            AND credentials.user_handle_ref = handles.reference
            AND credentials.record_id = consumption.credential_record_id
          JOIN device_sessions sessions
            ON sessions.user_id = accounts.id
            AND sessions.id = consumption.session_id
          JOIN refresh_tokens refresh
            ON refresh.session_id = sessions.id
            AND refresh.id = consumption.initial_refresh_token_id
          WHERE consumption.intent_id = NEW.intent_id
            AND consumption.result_revision = NEW.revision
            AND consumption.result_state = NEW.state
            AND consumption.account_id = NEW.candidate_account_id
            AND consumption.user_handle_ref = NEW.candidate_user_handle_ref
            AND consumption.credential_record_id = NEW.resolved_credential_record_id
            AND consumption.committed_at_ms = NEW.updated_at_ms
            AND accounts.password_auth_enabled = 0
            AND credentials.discovery_mode = 'discoverable'
            AND credentials.credential_set_ref IS NULL
            AND credentials.revision = 1
            AND credentials.created_at_ms = NEW.updated_at_ms
            AND credentials.updated_at_ms = NEW.updated_at_ms
            AND sessions.revoked_at IS NULL
            AND CAST(strftime('%s', sessions.created_at) AS INTEGER)
              = CAST(NEW.updated_at_ms / 1000 AS INTEGER)
            AND refresh.used_at IS NULL
            AND refresh.created_at = sessions.created_at
            AND refresh.expires_at = sessions.expires_at
            AND consumption.initial_access_token_expires_at_sec
              <= CAST(strftime('%s', sessions.expires_at) AS INTEGER)
        )
      BEGIN
        SELECT RAISE(ABORT, 'passkey signup consumed proof is inconsistent');
      END;

      DROP TRIGGER trg_passkey_credentials_require_step_up_grant_insert;
      CREATE TRIGGER trg_passkey_credentials_require_step_up_grant_insert
      BEFORE INSERT ON passkey_credentials
      WHEN NOT EXISTS (
        SELECT 1
        FROM passkey_step_up_grants grants
        JOIN passkey_ceremonies registration
          ON registration.ceremony_id = grants.registration_ceremony_id
        WHERE grants.registration_ceremony_id = NEW.registration_ceremony_id
          AND grants.account_id = NEW.account_id
          AND grants.consumed_at_sec IS NOT NULL
          AND registration.kind = 'registration'
          AND registration.purpose_type = 'authenticator.add'
          AND registration.state = 'consumed'
          AND registration.account_id = grants.account_id
          AND registration.session_id = grants.session_id
          AND registration.device_id = grants.device_id
          AND registration.purpose_target_digest = grants.target_digest
      ) AND NOT EXISTS (
        SELECT 1
        FROM passkey_signup_consumptions consumption
        JOIN passkey_signup_intents signup
          ON signup.intent_id = consumption.intent_id
        WHERE consumption.intent_id = NEW.registration_ceremony_id
          AND consumption.credential_record_id = NEW.record_id
          AND consumption.account_id = NEW.account_id
          AND consumption.user_handle_ref = NEW.user_handle_ref
          AND consumption.result_state = 'consumed'
          AND consumption.result_revision = signup.revision + 1
          AND signup.state = 'pending'
          AND signup.candidate_account_id = NEW.account_id
          AND signup.candidate_user_handle_ref = NEW.user_handle_ref
          AND signup.resolved_credential_record_id IS NULL
          AND NEW.discovery_mode = 'discoverable'
          AND NEW.credential_set_ref IS NULL
          AND NEW.revision = 1
          AND NEW.created_at_ms = consumption.committed_at_ms
          AND NEW.updated_at_ms = consumption.committed_at_ms
      )
      BEGIN
        SELECT RAISE(ABORT, 'passkey registration requires a consumed step-up grant');
      END;
    `
  },
  {
    id: "014_passkey_authenticator_management",
    sql: `
      CREATE UNIQUE INDEX idx_passkey_credentials_record_account
        ON passkey_credentials(record_id, account_id);

      CREATE TABLE passkey_authenticator_metadata (
        credential_record_id TEXT PRIMARY KEY,
        account_id TEXT NOT NULL,
        display_name_ciphertext TEXT NOT NULL
          CHECK (display_name_ciphertext GLOB 'luxora:v1.*'),
        lifecycle_state TEXT NOT NULL CHECK (lifecycle_state IN ('active', 'revoked')),
        revision INTEGER NOT NULL CHECK (revision >= 1),
        created_at_ms INTEGER NOT NULL
          CHECK (created_at_ms BETWEEN 0 AND 9007199254740991),
        updated_at_ms INTEGER NOT NULL
          CHECK (updated_at_ms BETWEEN 0 AND 9007199254740991),
        revoked_at_ms INTEGER
          CHECK (revoked_at_ms BETWEEN 0 AND 9007199254740991),
        CHECK (updated_at_ms >= created_at_ms),
        CHECK (
          (lifecycle_state = 'active' AND revoked_at_ms IS NULL)
          OR (lifecycle_state = 'revoked' AND revoked_at_ms = updated_at_ms)
        ),
        UNIQUE (credential_record_id, account_id),
        FOREIGN KEY (credential_record_id, account_id)
          REFERENCES passkey_credentials(record_id, account_id) ON DELETE CASCADE
      ) STRICT;
      CREATE INDEX idx_passkey_authenticator_metadata_account
        ON passkey_authenticator_metadata(account_id, lifecycle_state, created_at_ms, credential_record_id);

      CREATE TABLE passkey_authenticator_events (
        event_id TEXT PRIMARY KEY CHECK (length(event_id) BETWEEN 1 AND 192),
        credential_record_id TEXT NOT NULL,
        account_id TEXT NOT NULL,
        revision INTEGER NOT NULL CHECK (revision >= 1),
        event_type TEXT NOT NULL CHECK (event_type IN (
          'passkey.authenticator.registered',
          'passkey.authenticator.renamed',
          'passkey.authenticator.revoked'
        )),
        command_scope TEXT NOT NULL CHECK (length(command_scope) BETWEEN 1 AND 192),
        fingerprint TEXT NOT NULL CHECK (
          length(fingerprint) = 64 AND fingerprint NOT GLOB '*[^0-9a-f]*'
        ),
        occurred_at_ms INTEGER NOT NULL
          CHECK (occurred_at_ms BETWEEN 0 AND 9007199254740991),
        event_json TEXT NOT NULL CHECK (json_valid(event_json)),
        UNIQUE (credential_record_id, revision),
        FOREIGN KEY (credential_record_id, account_id)
          REFERENCES passkey_authenticator_metadata(credential_record_id, account_id)
          ON DELETE CASCADE
      ) STRICT;
      CREATE INDEX idx_passkey_authenticator_events_account
        ON passkey_authenticator_events(account_id, occurred_at_ms, event_id);

      CREATE TABLE passkey_authenticator_outbox (
        outbox_id TEXT PRIMARY KEY CHECK (length(outbox_id) BETWEEN 1 AND 192),
        event_id TEXT NOT NULL UNIQUE
          REFERENCES passkey_authenticator_events(event_id) ON DELETE CASCADE,
        topic TEXT NOT NULL CHECK (topic = 'luxora.passkey-authenticator.v1'),
        partition_key TEXT NOT NULL CHECK (length(partition_key) BETWEEN 1 AND 192),
        available_at_ms INTEGER NOT NULL
          CHECK (available_at_ms BETWEEN 0 AND 9007199254740991),
        payload_json TEXT NOT NULL CHECK (json_valid(payload_json))
      ) STRICT;
      CREATE INDEX idx_passkey_authenticator_outbox_available
        ON passkey_authenticator_outbox(available_at_ms, outbox_id);

      CREATE TABLE passkey_authenticator_command_receipts (
        scope TEXT PRIMARY KEY CHECK (length(scope) BETWEEN 1 AND 192),
        fingerprint TEXT NOT NULL CHECK (
          length(fingerprint) = 64 AND fingerprint NOT GLOB '*[^0-9a-f]*'
        ),
        credential_record_id TEXT NOT NULL,
        account_id TEXT NOT NULL,
        result_revision INTEGER NOT NULL CHECK (result_revision >= 2),
        event_id TEXT NOT NULL UNIQUE
          REFERENCES passkey_authenticator_events(event_id) ON DELETE CASCADE,
        result_snapshot_ciphertext TEXT NOT NULL
          CHECK (result_snapshot_ciphertext GLOB 'luxora:v1.*'),
        created_at_ms INTEGER NOT NULL
          CHECK (created_at_ms BETWEEN 0 AND 9007199254740991),
        FOREIGN KEY (credential_record_id, account_id)
          REFERENCES passkey_authenticator_metadata(credential_record_id, account_id)
          ON DELETE CASCADE
      ) STRICT;

      CREATE TABLE passkey_authenticator_step_up_grants (
        authentication_ceremony_id TEXT PRIMARY KEY
          REFERENCES passkey_ceremonies(ceremony_id) ON DELETE CASCADE,
        account_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        device_id TEXT NOT NULL CHECK (device_id = session_id),
        credential_record_id TEXT NOT NULL,
        expected_authenticator_revision INTEGER NOT NULL
          CHECK (expected_authenticator_revision >= 1),
        purpose TEXT NOT NULL CHECK (purpose = 'authenticator.revoke'),
        target_digest TEXT NOT NULL CHECK (
          length(target_digest) = 64 AND target_digest NOT GLOB '*[^0-9a-f]*'
        ),
        auth_time_sec INTEGER NOT NULL
          CHECK (auth_time_sec BETWEEN 0 AND 9007199254740991),
        issued_at_sec INTEGER NOT NULL
          CHECK (issued_at_sec BETWEEN 0 AND 9007199254740991),
        expires_at_sec INTEGER NOT NULL
          CHECK (expires_at_sec BETWEEN 0 AND 9007199254740991),
        consumed_at_sec INTEGER
          CHECK (consumed_at_sec BETWEEN 0 AND 9007199254740991),
        management_command_scope TEXT UNIQUE
          CHECK (management_command_scope IS NULL OR length(management_command_scope) BETWEEN 1 AND 192),
        CHECK (auth_time_sec = issued_at_sec),
        CHECK (issued_at_sec < expires_at_sec),
        CHECK (expires_at_sec - issued_at_sec <= 300),
        CHECK (
          (consumed_at_sec IS NULL AND management_command_scope IS NULL)
          OR (consumed_at_sec IS NOT NULL AND management_command_scope IS NOT NULL)
        ),
        CHECK (
          consumed_at_sec IS NULL
          OR (consumed_at_sec >= issued_at_sec AND consumed_at_sec < expires_at_sec)
        ),
        FOREIGN KEY (session_id, account_id)
          REFERENCES device_sessions(id, user_id) ON DELETE CASCADE,
        FOREIGN KEY (credential_record_id, account_id)
          REFERENCES passkey_authenticator_metadata(credential_record_id, account_id)
          ON DELETE CASCADE
      ) STRICT;
      CREATE INDEX idx_passkey_authenticator_step_up_available
        ON passkey_authenticator_step_up_grants(consumed_at_sec, expires_at_sec, authentication_ceremony_id);

      CREATE TABLE passkey_session_credential_origins (
        session_id TEXT PRIMARY KEY,
        account_id TEXT NOT NULL,
        credential_record_id TEXT NOT NULL,
        created_at_ms INTEGER NOT NULL
          CHECK (created_at_ms BETWEEN 0 AND 9007199254740991),
        FOREIGN KEY (session_id, account_id)
          REFERENCES device_sessions(id, user_id) ON DELETE CASCADE,
        FOREIGN KEY (credential_record_id, account_id)
          REFERENCES passkey_authenticator_metadata(credential_record_id, account_id)
          ON DELETE CASCADE
      ) STRICT;
      CREATE INDEX idx_passkey_session_credential_origins_credential
        ON passkey_session_credential_origins(account_id, credential_record_id, session_id);

      CREATE TRIGGER trg_passkey_authenticator_metadata_event_guard
      BEFORE UPDATE OF display_name_ciphertext, lifecycle_state, revision, updated_at_ms, revoked_at_ms
      ON passkey_authenticator_metadata
      WHEN NEW.revision != OLD.revision + 1
        OR NEW.updated_at_ms < OLD.updated_at_ms
        OR NOT EXISTS (
        SELECT 1 FROM passkey_authenticator_events events
        WHERE events.credential_record_id = NEW.credential_record_id
          AND events.account_id = NEW.account_id
          AND events.revision = NEW.revision
          AND events.occurred_at_ms = NEW.updated_at_ms
          AND (
            (events.event_type = 'passkey.authenticator.renamed'
              AND OLD.lifecycle_state = 'active'
              AND NEW.lifecycle_state = 'active'
              AND NEW.display_name_ciphertext IS NOT OLD.display_name_ciphertext
              AND NEW.revoked_at_ms IS NULL)
            OR
            (events.event_type = 'passkey.authenticator.revoked'
              AND OLD.lifecycle_state = 'active'
              AND NEW.lifecycle_state = 'revoked'
              AND NEW.display_name_ciphertext = OLD.display_name_ciphertext
              AND NEW.revoked_at_ms = NEW.updated_at_ms)
          )
      )
      BEGIN
        SELECT RAISE(ABORT, 'passkey authenticator mutation requires an audit event');
      END;

      CREATE TRIGGER trg_passkey_authenticator_events_exact_binding
      BEFORE INSERT ON passkey_authenticator_events
      WHEN json_type(NEW.event_json) != 'object'
        OR (SELECT COUNT(*) FROM json_each(NEW.event_json)) != 8
        OR json_extract(NEW.event_json, '$.schemaVersion') != 1
        OR json_extract(NEW.event_json, '$.eventId') IS NOT NEW.event_id
        OR json_extract(NEW.event_json, '$.type') IS NOT NEW.event_type
        OR json_extract(NEW.event_json, '$.accountId') IS NOT NEW.account_id
        OR json_extract(NEW.event_json, '$.authenticatorId') IS NOT NEW.credential_record_id
        OR json_extract(NEW.event_json, '$.revision') IS NOT NEW.revision
        OR json_extract(NEW.event_json, '$.occurredAtMs') IS NOT NEW.occurred_at_ms
        OR json_extract(NEW.event_json, '$.lifecycleState') IS NOT CASE
          WHEN NEW.event_type = 'passkey.authenticator.revoked' THEN 'revoked'
          ELSE 'active'
        END
        OR NOT EXISTS (
          SELECT 1 FROM passkey_authenticator_metadata metadata
          WHERE metadata.credential_record_id = NEW.credential_record_id
            AND metadata.account_id = NEW.account_id
            AND (
              (NEW.event_type = 'passkey.authenticator.registered'
                AND NEW.revision = 1
                AND metadata.revision = 1
                AND metadata.lifecycle_state = 'active'
                AND metadata.created_at_ms = NEW.occurred_at_ms)
              OR
              (NEW.event_type IN (
                  'passkey.authenticator.renamed',
                  'passkey.authenticator.revoked'
                )
                AND NEW.revision = metadata.revision + 1
                AND metadata.lifecycle_state = 'active'
                AND metadata.updated_at_ms <= NEW.occurred_at_ms)
            )
        )
      BEGIN
        SELECT RAISE(ABORT, 'passkey authenticator event binding is inconsistent');
      END;

      CREATE TRIGGER trg_passkey_authenticator_outbox_exact_binding
      BEFORE INSERT ON passkey_authenticator_outbox
      WHEN NOT EXISTS (
        SELECT 1 FROM passkey_authenticator_events events
        WHERE events.event_id = NEW.event_id
          AND events.account_id = NEW.partition_key
          AND events.occurred_at_ms = NEW.available_at_ms
          AND events.event_json = NEW.payload_json
      )
      BEGIN
        SELECT RAISE(ABORT, 'passkey authenticator outbox binding is inconsistent');
      END;

      CREATE TRIGGER trg_passkey_authenticator_receipts_exact_binding
      BEFORE INSERT ON passkey_authenticator_command_receipts
      WHEN NOT EXISTS (
        SELECT 1 FROM passkey_authenticator_events events
        WHERE events.event_id = NEW.event_id
          AND events.credential_record_id = NEW.credential_record_id
          AND events.account_id = NEW.account_id
          AND events.revision = NEW.result_revision
          AND events.command_scope = NEW.scope
          AND events.fingerprint = NEW.fingerprint
          AND events.occurred_at_ms = NEW.created_at_ms
          AND events.event_type IN (
            'passkey.authenticator.renamed',
            'passkey.authenticator.revoked'
          )
      )
      BEGIN
        SELECT RAISE(ABORT, 'passkey authenticator receipt binding is inconsistent');
      END;

      CREATE TRIGGER trg_passkey_authenticator_metadata_terminal
      BEFORE UPDATE ON passkey_authenticator_metadata
      WHEN OLD.lifecycle_state = 'revoked'
      BEGIN
        SELECT RAISE(ABORT, 'revoked passkey authenticator is terminal');
      END;

      CREATE TRIGGER trg_passkey_authenticator_metadata_immutable_binding
      BEFORE UPDATE OF credential_record_id, account_id, created_at_ms
      ON passkey_authenticator_metadata
      BEGIN
        SELECT RAISE(ABORT, 'passkey authenticator binding is immutable');
      END;

      CREATE TRIGGER trg_passkey_authenticator_events_append_only_update
      BEFORE UPDATE ON passkey_authenticator_events
      BEGIN
        SELECT RAISE(ABORT, 'passkey authenticator audit is append-only');
      END;
      CREATE TRIGGER trg_passkey_authenticator_events_append_only_delete
      BEFORE DELETE ON passkey_authenticator_events
      WHEN EXISTS (SELECT 1 FROM users WHERE id = OLD.account_id)
      BEGIN
        SELECT RAISE(ABORT, 'passkey authenticator audit is append-only');
      END;
      CREATE TRIGGER trg_passkey_authenticator_outbox_append_only_update
      BEFORE UPDATE ON passkey_authenticator_outbox
      BEGIN
        SELECT RAISE(ABORT, 'passkey authenticator outbox is append-only');
      END;
      CREATE TRIGGER trg_passkey_authenticator_outbox_append_only_delete
      BEFORE DELETE ON passkey_authenticator_outbox
      WHEN EXISTS (
        SELECT 1 FROM passkey_authenticator_events events
        WHERE events.event_id = OLD.event_id
      )
      BEGIN
        SELECT RAISE(ABORT, 'passkey authenticator outbox is append-only');
      END;
      CREATE TRIGGER trg_passkey_authenticator_receipts_append_only_update
      BEFORE UPDATE ON passkey_authenticator_command_receipts
      BEGIN
        SELECT RAISE(ABORT, 'passkey authenticator receipt is append-only');
      END;
      CREATE TRIGGER trg_passkey_authenticator_receipts_append_only_delete
      BEFORE DELETE ON passkey_authenticator_command_receipts
      WHEN EXISTS (SELECT 1 FROM users WHERE id = OLD.account_id)
      BEGIN
        SELECT RAISE(ABORT, 'passkey authenticator receipt is append-only');
      END;

      CREATE TRIGGER trg_passkey_authenticator_step_up_requires_authentication
      BEFORE INSERT ON passkey_authenticator_step_up_grants
      WHEN NOT EXISTS (
        SELECT 1
        FROM passkey_ceremonies authentication
        JOIN passkey_ceremony_events outcome
          ON outcome.ceremony_id = authentication.ceremony_id
          AND outcome.revision = authentication.revision
        JOIN passkey_authenticator_metadata authenticator
          ON authenticator.credential_record_id = NEW.credential_record_id
          AND authenticator.account_id = NEW.account_id
        WHERE authentication.ceremony_id = NEW.authentication_ceremony_id
          AND authentication.kind = 'authentication'
          AND authentication.purpose_type = 'session.step_up'
          AND authentication.state = 'consumed'
          AND authentication.account_id = NEW.account_id
          AND authentication.session_id = NEW.session_id
          AND authentication.device_id = NEW.device_id
          AND authentication.purpose_target_digest = NEW.target_digest
          AND CAST(authentication.updated_at_ms / 1000 AS INTEGER) = NEW.auth_time_sec
          AND NEW.auth_time_sec = NEW.issued_at_sec
          AND json_extract(authentication.snapshot_json, '$.terminalReason') = 'verified'
          AND outcome.event_type = 'passkey.ceremony.consumed'
          AND outcome.occurred_at_ms = authentication.updated_at_ms
          AND authenticator.lifecycle_state = 'active'
          AND authenticator.revision = NEW.expected_authenticator_revision
      )
      BEGIN
        SELECT RAISE(ABORT, 'passkey authenticator grant requires target-bound authentication');
      END;

      CREATE TRIGGER trg_passkey_authenticator_step_up_immutable
      BEFORE UPDATE OF authentication_ceremony_id, account_id, session_id, device_id,
        credential_record_id, expected_authenticator_revision, purpose, target_digest,
        auth_time_sec, issued_at_sec, expires_at_sec
      ON passkey_authenticator_step_up_grants
      BEGIN
        SELECT RAISE(ABORT, 'passkey authenticator grant binding is immutable');
      END;
      CREATE TRIGGER trg_passkey_authenticator_step_up_consume_once
      BEFORE UPDATE OF consumed_at_sec, management_command_scope
      ON passkey_authenticator_step_up_grants
      WHEN OLD.consumed_at_sec IS NOT NULL OR OLD.management_command_scope IS NOT NULL
      BEGIN
        SELECT RAISE(ABORT, 'passkey authenticator grant is already consumed');
      END;
      CREATE TRIGGER trg_passkey_authenticator_step_up_no_direct_delete
      BEFORE DELETE ON passkey_authenticator_step_up_grants
      WHEN EXISTS (
        SELECT 1 FROM passkey_ceremonies
        WHERE ceremony_id = OLD.authentication_ceremony_id
      )
      BEGIN
        SELECT RAISE(ABORT, 'passkey authenticator grant cannot be deleted');
      END;
    `
  },
  {
    id: "015_passkey_authenticator_revoke_intents",
    sql: `
      CREATE TABLE passkey_authenticator_revoke_intents (
        authentication_ceremony_id TEXT PRIMARY KEY
          REFERENCES passkey_ceremonies(ceremony_id) ON DELETE CASCADE,
        account_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        device_id TEXT NOT NULL CHECK (device_id = session_id),
        credential_record_id TEXT NOT NULL,
        expected_authenticator_revision INTEGER NOT NULL
          CHECK (expected_authenticator_revision >= 1),
        purpose TEXT NOT NULL CHECK (purpose = 'authenticator.revoke'),
        target_digest TEXT NOT NULL CHECK (
          length(target_digest) = 64 AND target_digest NOT GLOB '*[^0-9a-f]*'
        ),
        created_at_ms INTEGER NOT NULL
          CHECK (created_at_ms BETWEEN 0 AND 9007199254740991),
        FOREIGN KEY (session_id, account_id)
          REFERENCES device_sessions(id, user_id) ON DELETE CASCADE,
        FOREIGN KEY (credential_record_id, account_id)
          REFERENCES passkey_authenticator_metadata(credential_record_id, account_id)
          ON DELETE CASCADE
      ) STRICT;
      CREATE INDEX idx_passkey_authenticator_revoke_intents_target
        ON passkey_authenticator_revoke_intents(
          account_id, credential_record_id, expected_authenticator_revision,
          authentication_ceremony_id
        );

      CREATE TRIGGER trg_passkey_authenticator_revoke_intents_exact_begin
      BEFORE INSERT ON passkey_authenticator_revoke_intents
      WHEN NOT EXISTS (
        SELECT 1
        FROM passkey_ceremonies authentication
        JOIN passkey_authenticator_metadata authenticator
          ON authenticator.credential_record_id = NEW.credential_record_id
          AND authenticator.account_id = NEW.account_id
        JOIN device_sessions sessions
          ON sessions.id = NEW.session_id
          AND sessions.user_id = NEW.account_id
        WHERE authentication.ceremony_id = NEW.authentication_ceremony_id
          AND authentication.kind = 'authentication'
          AND authentication.purpose_type = 'session.step_up'
          AND authentication.purpose_target_digest = NEW.target_digest
          AND authentication.account_id = NEW.account_id
          AND authentication.session_id = NEW.session_id
          AND authentication.device_id = NEW.device_id
          AND authentication.user_handle_ref IS NULL
          AND authentication.state = 'pending'
          AND authentication.revision = 1
          AND authentication.attempts_used = 0
          AND authentication.updated_at_ms = NEW.created_at_ms
          AND authentication.expires_at_ms > NEW.created_at_ms
          AND authenticator.lifecycle_state = 'active'
          AND authenticator.revision = NEW.expected_authenticator_revision
          AND sessions.revoked_at IS NULL
          AND CAST(strftime('%s', sessions.created_at) AS INTEGER)
            <= CAST(NEW.created_at_ms / 1000 AS INTEGER)
          AND CAST(strftime('%s', sessions.expires_at) AS INTEGER)
            > CAST(NEW.created_at_ms / 1000 AS INTEGER)
      )
      BEGIN
        SELECT RAISE(ABORT, 'passkey authenticator revoke intent binding is inconsistent');
      END;

      CREATE TRIGGER trg_passkey_authenticator_revoke_intents_immutable
      BEFORE UPDATE ON passkey_authenticator_revoke_intents
      BEGIN
        SELECT RAISE(ABORT, 'passkey authenticator revoke intent is immutable');
      END;

      DROP TRIGGER trg_passkey_authenticator_step_up_requires_authentication;
      CREATE TRIGGER trg_passkey_authenticator_step_up_requires_authentication
      BEFORE INSERT ON passkey_authenticator_step_up_grants
      WHEN NOT EXISTS (
        SELECT 1
        FROM passkey_ceremonies authentication
        JOIN passkey_ceremony_events outcome
          ON outcome.ceremony_id = authentication.ceremony_id
          AND outcome.revision = authentication.revision
        JOIN passkey_authenticator_revoke_intents intent
          ON intent.authentication_ceremony_id = authentication.ceremony_id
        JOIN passkey_authenticator_metadata authenticator
          ON authenticator.credential_record_id = NEW.credential_record_id
          AND authenticator.account_id = NEW.account_id
        WHERE authentication.ceremony_id = NEW.authentication_ceremony_id
          AND authentication.kind = 'authentication'
          AND authentication.purpose_type = 'session.step_up'
          AND authentication.state = 'consumed'
          AND authentication.account_id = NEW.account_id
          AND authentication.session_id = NEW.session_id
          AND authentication.device_id = NEW.device_id
          AND authentication.purpose_target_digest = NEW.target_digest
          AND CAST(authentication.updated_at_ms / 1000 AS INTEGER) = NEW.auth_time_sec
          AND NEW.auth_time_sec = NEW.issued_at_sec
          AND json_extract(authentication.snapshot_json, '$.terminalReason') = 'verified'
          AND outcome.event_type = 'passkey.ceremony.consumed'
          AND outcome.occurred_at_ms = authentication.updated_at_ms
          AND intent.account_id = NEW.account_id
          AND intent.session_id = NEW.session_id
          AND intent.device_id = NEW.device_id
          AND intent.credential_record_id = NEW.credential_record_id
          AND intent.expected_authenticator_revision = NEW.expected_authenticator_revision
          AND intent.purpose = NEW.purpose
          AND intent.target_digest = NEW.target_digest
          AND authenticator.lifecycle_state = 'active'
          AND authenticator.revision = NEW.expected_authenticator_revision
      )
      BEGIN
        SELECT RAISE(ABORT, 'passkey authenticator grant requires a durable target-bound intent');
      END;
    `
  },
  {
    id: "016_passkey_authenticator_revoke_intent_delete_guard",
    sql: `
      CREATE TRIGGER trg_passkey_authenticator_revoke_intents_no_direct_delete
      BEFORE DELETE ON passkey_authenticator_revoke_intents
      WHEN EXISTS (
        SELECT 1 FROM passkey_ceremonies
        WHERE ceremony_id = OLD.authentication_ceremony_id
      )
      BEGIN
        SELECT RAISE(ABORT, 'passkey authenticator revoke intent cannot be deleted');
      END;
    `
  },
  {
    id: "017_chat_membership_lifecycle",
    sql: `
      ALTER TABLE chat_members ADD COLUMN membership_revision INTEGER NOT NULL DEFAULT 1
        CHECK (membership_revision >= 1);
      ALTER TABLE chat_members ADD COLUMN membership_updated_at TEXT;

      CREATE TRIGGER trg_chat_members_insert_invariants
      BEFORE INSERT ON chat_members
      WHEN NEW.membership_revision <> 1
        OR NEW.membership_updated_at IS NULL
        OR julianday(NEW.joined_at) IS NULL
        OR julianday(NEW.membership_updated_at) IS NULL
        OR julianday(NEW.membership_updated_at) < julianday(NEW.joined_at)
        OR (
          (SELECT kind FROM chats WHERE id = NEW.chat_id) = 'direct'
          AND NEW.role <> 'member'
        )
        OR (
          NEW.role = 'owner'
          AND EXISTS (
            SELECT 1 FROM chat_members
            WHERE chat_id = NEW.chat_id AND role = 'owner'
          )
        )
        OR (
          SELECT count(*) FROM chat_members WHERE chat_id = NEW.chat_id
        ) >= 200
      BEGIN
        SELECT RAISE(ABORT, 'chat membership insert invariant failed');
      END;

      CREATE TRIGGER trg_chat_members_identity_immutable
      BEFORE UPDATE ON chat_members
      WHEN NEW.chat_id <> OLD.chat_id
        OR NEW.user_id <> OLD.user_id
        OR NEW.joined_at <> OLD.joined_at
      BEGIN
        SELECT RAISE(ABORT, 'chat membership identity is immutable');
      END;

      CREATE TRIGGER trg_chat_members_role_revision
      BEFORE UPDATE ON chat_members
      WHEN (
          NEW.role <> OLD.role
          AND (
            NEW.membership_revision <> OLD.membership_revision + 1
            OR NEW.membership_updated_at IS NULL
            OR julianday(NEW.membership_updated_at) IS NULL
            OR julianday(NEW.membership_updated_at) <= julianday(
              COALESCE(OLD.membership_updated_at, OLD.joined_at)
            )
          )
        )
        OR (
          NEW.role = OLD.role
          AND (
            NEW.membership_revision <> OLD.membership_revision
            OR NEW.membership_updated_at <> OLD.membership_updated_at
          )
        )
      BEGIN
        SELECT RAISE(ABORT, 'chat membership revision transition is invalid');
      END;

      CREATE TRIGGER trg_chat_members_owner_immutable
      BEFORE UPDATE OF role ON chat_members
      WHEN OLD.role = 'owner' OR NEW.role = 'owner'
      BEGIN
        SELECT RAISE(ABORT, 'chat owner transfer requires a dedicated ceremony');
      END;

      CREATE TRIGGER trg_chat_members_direct_role
      BEFORE UPDATE OF role ON chat_members
      WHEN (SELECT kind FROM chats WHERE id = OLD.chat_id) = 'direct'
        AND NEW.role <> 'member'
      BEGIN
        SELECT RAISE(ABORT, 'direct chat roles are immutable');
      END;

      CREATE TRIGGER trg_chat_members_owner_no_delete
      BEFORE DELETE ON chat_members
      WHEN OLD.role = 'owner'
      BEGIN
        SELECT RAISE(ABORT, 'chat owner cannot leave without ownership transfer');
      END;

      CREATE TRIGGER trg_chat_members_direct_no_delete
      BEFORE DELETE ON chat_members
      WHEN (SELECT kind FROM chats WHERE id = OLD.chat_id) = 'direct'
      BEGIN
        SELECT RAISE(ABORT, 'direct chat membership is immutable');
      END;

      CREATE TABLE chat_membership_command_receipts (
        actor_user_id TEXT NOT NULL REFERENCES users(id),
        client_nonce TEXT NOT NULL,
        operation TEXT NOT NULL CHECK (operation IN ('add', 'role_update', 'remove')),
        chat_id TEXT NOT NULL REFERENCES chats(id),
        target_user_id TEXT NOT NULL REFERENCES users(id),
        fingerprint TEXT NOT NULL,
        result_role TEXT NOT NULL CHECK (result_role IN ('admin', 'member')),
        result_revision INTEGER NOT NULL CHECK (result_revision >= 1),
        result_joined_at TEXT NOT NULL,
        result_updated_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (actor_user_id, client_nonce),
        CHECK (julianday(result_joined_at) IS NOT NULL),
        CHECK (julianday(result_updated_at) IS NOT NULL),
        CHECK (julianday(created_at) IS NOT NULL),
        CHECK (julianday(result_updated_at) >= julianday(result_joined_at))
      ) STRICT;
      CREATE INDEX idx_chat_membership_receipts_target
        ON chat_membership_command_receipts(chat_id, target_user_id, created_at);

      CREATE TRIGGER trg_chat_membership_receipts_immutable
      BEFORE UPDATE ON chat_membership_command_receipts
      BEGIN
        SELECT RAISE(ABORT, 'chat membership command receipt is immutable');
      END;

      CREATE TRIGGER trg_chat_membership_receipts_no_delete
      BEFORE DELETE ON chat_membership_command_receipts
      BEGIN
        SELECT RAISE(ABORT, 'chat membership command receipt cannot be deleted');
      END;
    `
  },
  {
    id: "018_phone_authentication",
    sql: `
      CREATE TABLE phone_identities (
        phone_digest TEXT PRIMARY KEY CHECK (
          length(phone_digest) = 64 AND phone_digest NOT GLOB '*[^0-9a-f]*'
        ),
        phone_ciphertext TEXT NOT NULL,
        user_id TEXT NOT NULL UNIQUE REFERENCES users(id),
        verified_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        CHECK (julianday(verified_at) IS NOT NULL),
        CHECK (julianday(created_at) IS NOT NULL),
        CHECK (julianday(updated_at) IS NOT NULL),
        CHECK (julianday(updated_at) >= julianday(created_at))
      ) STRICT;

      CREATE TABLE phone_auth_challenges (
        id TEXT PRIMARY KEY,
        phone_digest TEXT NOT NULL CHECK (
          length(phone_digest) = 64 AND phone_digest NOT GLOB '*[^0-9a-f]*'
        ),
        phone_ciphertext TEXT NOT NULL,
        code_digest TEXT NOT NULL CHECK (
          length(code_digest) = 64 AND code_digest NOT GLOB '*[^0-9a-f]*'
        ),
        delivery_code_ciphertext TEXT,
        device_name_ciphertext TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN (
          'pending_delivery', 'pending', 'verified', 'consumed', 'locked', 'expired'
        )),
        revision INTEGER NOT NULL CHECK (revision >= 1),
        attempts_used INTEGER NOT NULL CHECK (attempts_used >= 0),
        max_attempts INTEGER NOT NULL CHECK (max_attempts BETWEEN 3 AND 10),
        begin_client_nonce TEXT NOT NULL UNIQUE,
        begin_fingerprint TEXT NOT NULL CHECK (
          length(begin_fingerprint) = 64 AND begin_fingerprint NOT GLOB '*[^0-9a-f]*'
        ),
        masked_phone TEXT NOT NULL,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        retry_after_seconds INTEGER NOT NULL CHECK (retry_after_seconds BETWEEN 30 AND 300),
        updated_at TEXT NOT NULL,
        verified_at TEXT,
        consumed_at TEXT,
        registration_token_hash TEXT UNIQUE CHECK (
          registration_token_hash IS NULL OR (
            length(registration_token_hash) = 64
            AND registration_token_hash NOT GLOB '*[^0-9a-f]*'
          )
        ),
        registration_expires_at TEXT,
        matched_user_id TEXT REFERENCES users(id),
        CHECK (attempts_used <= max_attempts),
        CHECK (julianday(created_at) IS NOT NULL),
        CHECK (julianday(expires_at) IS NOT NULL),
        CHECK (julianday(updated_at) IS NOT NULL),
        CHECK (julianday(expires_at) > julianday(created_at)),
        CHECK (julianday(updated_at) >= julianday(created_at)),
        CHECK (
          (state = 'pending_delivery' AND delivery_code_ciphertext IS NOT NULL)
          OR (state <> 'pending_delivery' AND delivery_code_ciphertext IS NULL)
        ),
        CHECK (
          (state = 'verified'
            AND verified_at IS NOT NULL
            AND consumed_at IS NULL
            AND registration_token_hash IS NOT NULL
            AND registration_expires_at IS NOT NULL
            AND matched_user_id IS NULL)
          OR (state <> 'verified')
        ),
        CHECK (
          registration_token_hash IS NULL
          OR julianday(registration_expires_at) > julianday(verified_at)
        ),
        CHECK (
          consumed_at IS NULL OR state = 'consumed'
        )
      ) STRICT;
      CREATE INDEX idx_phone_auth_challenges_phone
        ON phone_auth_challenges(phone_digest, created_at);
      CREATE INDEX idx_phone_auth_challenges_registration
        ON phone_auth_challenges(registration_token_hash, state, registration_expires_at);
      CREATE INDEX idx_phone_auth_challenges_expiry
        ON phone_auth_challenges(state, expires_at);

      CREATE TABLE phone_auth_command_receipts (
        scope TEXT PRIMARY KEY CHECK (length(scope) BETWEEN 1 AND 192),
        operation TEXT NOT NULL CHECK (operation IN ('verify', 'register')),
        fingerprint TEXT NOT NULL CHECK (
          length(fingerprint) = 64 AND fingerprint NOT GLOB '*[^0-9a-f]*'
        ),
        challenge_id TEXT NOT NULL REFERENCES phone_auth_challenges(id),
        result_kind TEXT NOT NULL CHECK (result_kind IN (
          'invalid_code', 'profile_required', 'authenticated', 'registered'
        )),
        response_ciphertext TEXT,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        CHECK (julianday(created_at) IS NOT NULL),
        CHECK (julianday(expires_at) IS NOT NULL),
        CHECK (julianday(expires_at) > julianday(created_at)),
        CHECK (
          (result_kind = 'invalid_code' AND response_ciphertext IS NULL)
          OR (result_kind <> 'invalid_code' AND response_ciphertext IS NOT NULL)
        )
      ) STRICT;
      CREATE INDEX idx_phone_auth_receipts_challenge
        ON phone_auth_command_receipts(challenge_id, created_at);

      CREATE TABLE phone_auth_events (
        event_id TEXT PRIMARY KEY,
        challenge_id TEXT NOT NULL REFERENCES phone_auth_challenges(id),
        revision INTEGER NOT NULL CHECK (revision >= 1),
        event_type TEXT NOT NULL CHECK (event_type IN (
          'phone.challenge.created',
          'phone.challenge.delivered',
          'phone.challenge.delivery_failed',
          'phone.challenge.verification_rejected',
          'phone.challenge.profile_required',
          'phone.challenge.authenticated',
          'phone.registration.completed'
        )),
        command_scope TEXT NOT NULL CHECK (length(command_scope) BETWEEN 1 AND 192),
        occurred_at TEXT NOT NULL,
        UNIQUE (challenge_id, revision),
        CHECK (julianday(occurred_at) IS NOT NULL)
      ) STRICT;

      CREATE TRIGGER trg_phone_identities_immutable
      BEFORE UPDATE ON phone_identities
      BEGIN
        SELECT RAISE(ABORT, 'phone identity binding is immutable');
      END;
      CREATE TRIGGER trg_phone_identities_no_delete
      BEFORE DELETE ON phone_identities
      BEGIN
        SELECT RAISE(ABORT, 'phone identity binding cannot be deleted directly');
      END;

      CREATE TRIGGER trg_phone_challenges_binding_immutable
      BEFORE UPDATE OF id, phone_digest, phone_ciphertext, code_digest,
        device_name_ciphertext, max_attempts, begin_client_nonce, begin_fingerprint,
        masked_phone, created_at, expires_at, retry_after_seconds
      ON phone_auth_challenges
      BEGIN
        SELECT RAISE(ABORT, 'phone challenge binding is immutable');
      END;

      CREATE TRIGGER trg_phone_challenges_transition
      BEFORE UPDATE ON phone_auth_challenges
      WHEN NEW.revision <> OLD.revision + 1
        OR NEW.updated_at < OLD.updated_at
        OR NEW.attempts_used < OLD.attempts_used
        OR NEW.attempts_used > OLD.attempts_used + 1
        OR (OLD.state = 'pending_delivery' AND NEW.state NOT IN ('pending', 'locked'))
        OR (OLD.state = 'pending' AND NEW.state NOT IN (
          'pending', 'verified', 'consumed', 'locked', 'expired'
        ))
        OR (OLD.state = 'verified' AND NEW.state NOT IN ('consumed', 'expired'))
        OR OLD.state IN ('consumed', 'locked', 'expired')
      BEGIN
        SELECT RAISE(ABORT, 'phone challenge transition is invalid');
      END;

      CREATE TRIGGER trg_phone_challenges_no_delete
      BEFORE DELETE ON phone_auth_challenges
      BEGIN
        SELECT RAISE(ABORT, 'phone challenge cannot be deleted directly');
      END;

      CREATE TRIGGER trg_phone_receipts_immutable
      BEFORE UPDATE ON phone_auth_command_receipts
      BEGIN
        SELECT RAISE(ABORT, 'phone authentication receipt is immutable');
      END;
      CREATE TRIGGER trg_phone_receipts_no_delete
      BEFORE DELETE ON phone_auth_command_receipts
      BEGIN
        SELECT RAISE(ABORT, 'phone authentication receipt cannot be deleted');
      END;
      CREATE TRIGGER trg_phone_events_append_only_update
      BEFORE UPDATE ON phone_auth_events
      BEGIN
        SELECT RAISE(ABORT, 'phone authentication audit is append-only');
      END;
      CREATE TRIGGER trg_phone_events_append_only_delete
      BEFORE DELETE ON phone_auth_events
      BEGIN
        SELECT RAISE(ABORT, 'phone authentication audit cannot be deleted');
      END;
    `
  },
  {
    id: "019_phone_password_challenge",
    sql: `
      ALTER TABLE users ADD COLUMN phone_password_hash TEXT;
      ALTER TABLE users ADD COLUMN phone_password_enabled INTEGER NOT NULL DEFAULT 0
        CHECK (phone_password_enabled IN (0, 1));

      CREATE TRIGGER trg_users_phone_password_insert_valid
      BEFORE INSERT ON users
      WHEN NEW.phone_password_enabled = 1 AND NEW.phone_password_hash IS NULL
      BEGIN
        SELECT RAISE(ABORT, 'enabled phone password requires a hash');
      END;
      CREATE TRIGGER trg_users_phone_password_update_valid
      BEFORE UPDATE OF phone_password_hash, phone_password_enabled ON users
      WHEN NEW.phone_password_enabled = 1 AND NEW.phone_password_hash IS NULL
      BEGIN
        SELECT RAISE(ABORT, 'enabled phone password requires a hash');
      END;

      CREATE TABLE phone_auth_password_receipts (
        scope TEXT PRIMARY KEY CHECK (length(scope) BETWEEN 1 AND 192),
        fingerprint TEXT NOT NULL CHECK (
          length(fingerprint) = 64 AND fingerprint NOT GLOB '*[^0-9a-f]*'
        ),
        challenge_id TEXT NOT NULL REFERENCES phone_auth_challenges(id),
        result_kind TEXT NOT NULL CHECK (result_kind IN (
          'password_required', 'password_invalid', 'attempts_exhausted', 'authenticated'
        )),
        response_ciphertext TEXT,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        CHECK (julianday(created_at) IS NOT NULL),
        CHECK (julianday(expires_at) IS NOT NULL),
        CHECK (julianday(expires_at) > julianday(created_at)),
        CHECK (
          (result_kind IN ('password_invalid', 'attempts_exhausted')
            AND response_ciphertext IS NULL)
          OR (result_kind IN ('password_required', 'authenticated')
            AND response_ciphertext IS NOT NULL)
        )
      ) STRICT;
      CREATE INDEX idx_phone_auth_password_receipts_challenge
        ON phone_auth_password_receipts(challenge_id, created_at);

      CREATE TABLE phone_auth_password_events (
        event_id TEXT PRIMARY KEY,
        challenge_id TEXT NOT NULL REFERENCES phone_auth_challenges(id),
        observed_revision INTEGER NOT NULL CHECK (observed_revision >= 1),
        event_type TEXT NOT NULL CHECK (event_type IN (
          'phone.challenge.password_required',
          'phone.challenge.password_rejected',
          'phone.challenge.password_locked',
          'phone.challenge.password_authenticated'
        )),
        command_scope TEXT NOT NULL UNIQUE CHECK (length(command_scope) BETWEEN 1 AND 192),
        occurred_at TEXT NOT NULL,
        CHECK (julianday(occurred_at) IS NOT NULL)
      ) STRICT;
      CREATE INDEX idx_phone_auth_password_events_challenge
        ON phone_auth_password_events(challenge_id, occurred_at);

      CREATE TRIGGER trg_phone_password_receipts_immutable
      BEFORE UPDATE ON phone_auth_password_receipts
      BEGIN
        SELECT RAISE(ABORT, 'phone password receipt is immutable');
      END;
      CREATE TRIGGER trg_phone_password_receipts_no_delete
      BEFORE DELETE ON phone_auth_password_receipts
      BEGIN
        SELECT RAISE(ABORT, 'phone password receipt cannot be deleted');
      END;
      CREATE TRIGGER trg_phone_password_events_append_only_update
      BEFORE UPDATE ON phone_auth_password_events
      BEGIN
        SELECT RAISE(ABORT, 'phone password audit is append-only');
      END;
      CREATE TRIGGER trg_phone_password_events_append_only_delete
      BEFORE DELETE ON phone_auth_password_events
      BEGIN
        SELECT RAISE(ABORT, 'phone password audit cannot be deleted');
      END;
    `
  },
  {
    id: "020_processed_profile_avatar",
    sql: `
      ALTER TABLE users ADD COLUMN avatar_attachment_id TEXT
        REFERENCES attachments(id) ON DELETE SET NULL;
      CREATE INDEX idx_users_avatar_attachment
        ON users(avatar_attachment_id) WHERE avatar_attachment_id IS NOT NULL;

      ALTER TABLE attachments ADD COLUMN safety_status TEXT NOT NULL DEFAULT 'unscanned'
        CHECK (safety_status IN ('unscanned', 'reencoded'));
      ALTER TABLE attachments ADD COLUMN metadata_trust TEXT NOT NULL DEFAULT 'client_declared'
        CHECK (metadata_trust IN ('client_declared', 'server_verified'));

      CREATE TRIGGER trg_user_avatar_owned_verified_insert
      BEFORE INSERT ON users
      WHEN NEW.avatar_attachment_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM attachments a
        WHERE a.id = NEW.avatar_attachment_id
          AND a.owner_user_id = NEW.id
          AND a.kind = 'image'
          AND a.safety_status = 'reencoded'
          AND a.metadata_trust = 'server_verified'
          AND a.deleting_at IS NULL
          AND a.deleted_at IS NULL
      )
      BEGIN
        SELECT RAISE(ABORT, 'profile avatar must be an owned verified image');
      END;

      CREATE TRIGGER trg_user_avatar_owned_verified_update
      BEFORE UPDATE OF avatar_attachment_id ON users
      WHEN NEW.avatar_attachment_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM attachments a
        WHERE a.id = NEW.avatar_attachment_id
          AND a.owner_user_id = NEW.id
          AND a.kind = 'image'
          AND a.safety_status = 'reencoded'
          AND a.metadata_trust = 'server_verified'
          AND a.deleting_at IS NULL
          AND a.deleted_at IS NULL
      )
      BEGIN
        SELECT RAISE(ABORT, 'profile avatar must be an owned verified image');
      END;
    `
  },
  {
    id: "021_push_registration_preferences",
    sql: `
      CREATE TABLE push_registrations (
        id TEXT PRIMARY KEY CHECK (length(id) = 36),
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        session_id TEXT NOT NULL REFERENCES device_sessions(id) ON DELETE CASCADE,
        platform TEXT NOT NULL CHECK (platform = 'apns'),
        environment TEXT NOT NULL CHECK (environment IN ('development', 'production')),
        topic TEXT NOT NULL CHECK (topic = 'app.luxora.mobile'),
        token_digest TEXT NOT NULL CHECK (
          length(token_digest) = 64 AND token_digest NOT GLOB '*[^0-9a-f]*'
        ),
        token_ciphertext TEXT NOT NULL CHECK (token_ciphertext GLOB 'luxora:v1.*'),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        revoked_at TEXT,
        UNIQUE (platform, environment, topic, token_digest),
        CHECK (julianday(created_at) IS NOT NULL),
        CHECK (julianday(updated_at) IS NOT NULL),
        CHECK (updated_at >= created_at),
        CHECK (revoked_at IS NULL OR revoked_at >= created_at)
      ) STRICT;
      CREATE UNIQUE INDEX idx_push_registration_active_session
        ON push_registrations(session_id, platform, topic)
        WHERE revoked_at IS NULL;
      CREATE INDEX idx_push_registration_active_user
        ON push_registrations(user_id, updated_at)
        WHERE revoked_at IS NULL;

      CREATE TABLE notification_settings (
        user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        message_alerts INTEGER NOT NULL DEFAULT 1 CHECK (message_alerts IN (0, 1)),
        message_request_alerts INTEGER NOT NULL DEFAULT 1
          CHECK (message_request_alerts IN (0, 1)),
        mention_alerts INTEGER NOT NULL DEFAULT 1 CHECK (mention_alerts IN (0, 1)),
        sound INTEGER NOT NULL DEFAULT 1 CHECK (sound IN (0, 1)),
        badge INTEGER NOT NULL DEFAULT 1 CHECK (badge IN (0, 1)),
        preview_mode TEXT NOT NULL DEFAULT 'hidden'
          CHECK (preview_mode IN ('hidden', 'sender', 'full')),
        updated_at TEXT NOT NULL CHECK (julianday(updated_at) IS NOT NULL)
      ) STRICT;

      CREATE TRIGGER trg_push_registration_session_binding_insert
      BEFORE INSERT ON push_registrations
      WHEN NOT EXISTS (
        SELECT 1 FROM device_sessions s
        WHERE s.id = NEW.session_id
          AND s.user_id = NEW.user_id
          AND s.revoked_at IS NULL
          AND s.expires_at > NEW.updated_at
      )
      BEGIN
        SELECT RAISE(ABORT, 'push registration requires an active owned session');
      END;

      CREATE TRIGGER trg_push_registration_session_binding_update
      BEFORE UPDATE OF user_id, session_id, revoked_at, updated_at ON push_registrations
      WHEN NEW.revoked_at IS NULL AND NOT EXISTS (
        SELECT 1 FROM device_sessions s
        WHERE s.id = NEW.session_id
          AND s.user_id = NEW.user_id
          AND s.revoked_at IS NULL
          AND s.expires_at > NEW.updated_at
      )
      BEGIN
        SELECT RAISE(ABORT, 'push registration requires an active owned session');
      END;

      CREATE TRIGGER trg_push_registration_identity_immutable
      BEFORE UPDATE OF id, platform, environment, topic, token_digest, created_at
      ON push_registrations
      BEGIN
        SELECT RAISE(ABORT, 'push registration identity is immutable');
      END;
    `
  },
  {
    id: "022_chat_folders",
    sql: `
      CREATE TABLE chat_folder_states (
        user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
        updated_at TEXT NOT NULL CHECK (julianday(updated_at) IS NOT NULL)
      ) STRICT;

      CREATE TABLE chat_folders (
        id TEXT PRIMARY KEY CHECK (length(id) = 36),
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 48),
        position INTEGER NOT NULL CHECK (position BETWEEN 0 AND 9999),
        revision INTEGER NOT NULL CHECK (revision >= 1),
        include_direct INTEGER NOT NULL CHECK (include_direct IN (0, 1)),
        include_group INTEGER NOT NULL CHECK (include_group IN (0, 1)),
        include_channel INTEGER NOT NULL CHECK (include_channel IN (0, 1)),
        unread_only INTEGER NOT NULL CHECK (unread_only IN (0, 1)),
        exclude_muted INTEGER NOT NULL CHECK (exclude_muted IN (0, 1)),
        include_archived INTEGER NOT NULL CHECK (include_archived IN (0, 1)),
        created_at TEXT NOT NULL CHECK (julianday(created_at) IS NOT NULL),
        updated_at TEXT NOT NULL CHECK (julianday(updated_at) IS NOT NULL),
        UNIQUE (id, user_id),
        CHECK (updated_at >= created_at)
      ) STRICT;
      CREATE INDEX idx_chat_folders_account_order
        ON chat_folders(user_id, position, id);

      CREATE TABLE chat_folder_overrides (
        folder_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        chat_id TEXT NOT NULL,
        mode TEXT NOT NULL CHECK (mode IN ('include', 'exclude')),
        pinned_position INTEGER CHECK (pinned_position BETWEEN 0 AND 99),
        created_at TEXT NOT NULL CHECK (julianday(created_at) IS NOT NULL),
        updated_at TEXT NOT NULL CHECK (julianday(updated_at) IS NOT NULL),
        PRIMARY KEY (folder_id, chat_id),
        FOREIGN KEY (folder_id, user_id)
          REFERENCES chat_folders(id, user_id) ON DELETE CASCADE,
        FOREIGN KEY (chat_id, user_id)
          REFERENCES chat_members(chat_id, user_id) ON DELETE CASCADE,
        CHECK (updated_at >= created_at),
        CHECK (mode = 'include' OR pinned_position IS NULL)
      ) STRICT;
      CREATE INDEX idx_chat_folder_overrides_account_chat
        ON chat_folder_overrides(user_id, chat_id, folder_id);
      CREATE UNIQUE INDEX idx_chat_folder_pinned_position
        ON chat_folder_overrides(folder_id, pinned_position)
        WHERE pinned_position IS NOT NULL;

      CREATE TABLE chat_folder_command_receipts (
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        client_nonce TEXT NOT NULL CHECK (length(client_nonce) = 36),
        operation TEXT NOT NULL CHECK (operation IN ('create', 'update', 'delete', 'reorder')),
        fingerprint TEXT NOT NULL CHECK (length(fingerprint) BETWEEN 1 AND 8192),
        response_ciphertext TEXT NOT NULL CHECK (response_ciphertext GLOB 'luxora:v1.*'),
        created_at TEXT NOT NULL CHECK (julianday(created_at) IS NOT NULL),
        PRIMARY KEY (user_id, client_nonce)
      ) STRICT;

      CREATE TRIGGER trg_chat_folder_limit
      BEFORE INSERT ON chat_folders
      WHEN (SELECT count(*) FROM chat_folders WHERE user_id = NEW.user_id) >= 10
      BEGIN
        SELECT RAISE(ABORT, 'an account can contain at most 10 custom chat folders');
      END;

      CREATE TRIGGER trg_chat_folder_override_limit
      BEFORE INSERT ON chat_folder_overrides
      WHEN (SELECT count(*) FROM chat_folder_overrides WHERE folder_id = NEW.folder_id) >= 100
      BEGIN
        SELECT RAISE(ABORT, 'a chat folder can contain at most 100 overrides');
      END;

      CREATE TRIGGER trg_chat_folder_state_monotonic
      BEFORE UPDATE ON chat_folder_states
      WHEN NEW.user_id <> OLD.user_id
        OR NEW.revision <> OLD.revision + 1
        OR julianday(NEW.updated_at) < julianday(OLD.updated_at)
      BEGIN
        SELECT RAISE(ABORT, 'chat folder state revision must advance exactly once');
      END;

      CREATE TRIGGER trg_chat_folder_revision_monotonic
      BEFORE UPDATE ON chat_folders
      WHEN NEW.id <> OLD.id
        OR NEW.user_id <> OLD.user_id
        OR NEW.created_at <> OLD.created_at
        OR NEW.revision <> OLD.revision + 1
        OR julianday(NEW.updated_at) < julianday(OLD.updated_at)
      BEGIN
        SELECT RAISE(ABORT, 'chat folder revision must advance exactly once');
      END;

      CREATE TRIGGER trg_chat_folder_receipts_immutable
      BEFORE UPDATE ON chat_folder_command_receipts
      BEGIN
        SELECT RAISE(ABORT, 'chat folder command receipt is immutable');
      END;

      CREATE TRIGGER trg_chat_folder_receipts_no_delete
      BEFORE DELETE ON chat_folder_command_receipts
      BEGIN
        SELECT RAISE(ABORT, 'chat folder command receipt cannot be deleted');
      END;
    `
  },
  {
    id: "023_chat_folder_receipt_retention",
    sql: `
      DROP TRIGGER trg_chat_folder_receipts_no_delete;
      ALTER TABLE chat_folder_command_receipts ADD COLUMN expires_at TEXT
        CHECK (
          expires_at IS NULL OR (
            julianday(expires_at) IS NOT NULL
            AND julianday(expires_at) > julianday(created_at)
          )
        );
      CREATE INDEX idx_chat_folder_receipts_expiry
        ON chat_folder_command_receipts(expires_at, user_id, client_nonce);
      CREATE INDEX idx_chat_folder_receipts_legacy_expiry
        ON chat_folder_command_receipts(created_at, user_id, client_nonce)
        WHERE expires_at IS NULL;

      CREATE TRIGGER trg_chat_folder_receipts_require_expiry
      BEFORE INSERT ON chat_folder_command_receipts
      WHEN NEW.expires_at IS NULL
      BEGIN
        SELECT RAISE(ABORT, 'chat folder command receipt requires an expiry');
      END;
    `
  },
  {
    id: "024_chat_membership_revision_ledger",
    sql: `
      CREATE TABLE chat_membership_revision_ledger (
        chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        last_revision INTEGER NOT NULL CHECK (last_revision >= 2),
        last_removed_at TEXT NOT NULL CHECK (julianday(last_removed_at) IS NOT NULL),
        PRIMARY KEY (chat_id, user_id)
      ) STRICT;

      INSERT INTO chat_membership_revision_ledger (
        chat_id, user_id, last_revision, last_removed_at
      )
      SELECT
        chat_id,
        target_user_id,
        max(result_revision),
        max(result_updated_at)
      FROM chat_membership_command_receipts
      WHERE operation = 'remove'
      GROUP BY chat_id, target_user_id;

      DROP TRIGGER trg_chat_members_insert_invariants;
      DROP TRIGGER trg_chat_members_identity_immutable;
      DROP TRIGGER trg_chat_members_role_revision;

      UPDATE chat_members
      SET
        membership_revision = (
          SELECT ledger.last_revision + 1
          FROM chat_membership_revision_ledger AS ledger
          WHERE ledger.chat_id = chat_members.chat_id
            AND ledger.user_id = chat_members.user_id
        ),
        joined_at = strftime(
          '%Y-%m-%dT%H:%M:%fZ',
          max(
            julianday(joined_at),
            julianday(COALESCE(membership_updated_at, joined_at)),
            (SELECT julianday(ledger.last_removed_at)
             FROM chat_membership_revision_ledger AS ledger
             WHERE ledger.chat_id = chat_members.chat_id
               AND ledger.user_id = chat_members.user_id)
          ) + (1.0 / 86400000.0)
        ),
        membership_updated_at = strftime(
          '%Y-%m-%dT%H:%M:%fZ',
          max(
            julianday(joined_at),
            julianday(COALESCE(membership_updated_at, joined_at)),
            (SELECT julianday(ledger.last_removed_at)
             FROM chat_membership_revision_ledger AS ledger
             WHERE ledger.chat_id = chat_members.chat_id
               AND ledger.user_id = chat_members.user_id)
          ) + (1.0 / 86400000.0)
        )
      WHERE EXISTS (
        SELECT 1
        FROM chat_membership_revision_ledger AS ledger
        WHERE ledger.chat_id = chat_members.chat_id
          AND ledger.user_id = chat_members.user_id
          AND chat_members.membership_revision <= ledger.last_revision
      );

      CREATE TRIGGER trg_chat_members_identity_immutable
      BEFORE UPDATE ON chat_members
      WHEN NEW.chat_id <> OLD.chat_id
        OR NEW.user_id <> OLD.user_id
        OR NEW.joined_at <> OLD.joined_at
      BEGIN
        SELECT RAISE(ABORT, 'chat membership identity is immutable');
      END;

      CREATE TRIGGER trg_chat_members_insert_invariants
      BEFORE INSERT ON chat_members
      WHEN NEW.membership_revision <> COALESCE((
          SELECT ledger.last_revision + 1
          FROM chat_membership_revision_ledger AS ledger
          WHERE ledger.chat_id = NEW.chat_id
            AND ledger.user_id = NEW.user_id
        ), 1)
        OR NEW.membership_updated_at IS NULL
        OR julianday(NEW.joined_at) IS NULL
        OR julianday(NEW.membership_updated_at) IS NULL
        OR julianday(NEW.membership_updated_at) < julianday(NEW.joined_at)
        OR EXISTS (
          SELECT 1
          FROM chat_membership_revision_ledger AS ledger
          WHERE ledger.chat_id = NEW.chat_id
            AND ledger.user_id = NEW.user_id
            AND julianday(NEW.joined_at) <= julianday(ledger.last_removed_at)
        )
        OR (
          (SELECT kind FROM chats WHERE id = NEW.chat_id) = 'direct'
          AND NEW.role <> 'member'
        )
        OR (
          NEW.role = 'owner'
          AND EXISTS (
            SELECT 1 FROM chat_members
            WHERE chat_id = NEW.chat_id AND role = 'owner'
          )
        )
        OR (
          SELECT count(*) FROM chat_members WHERE chat_id = NEW.chat_id
        ) >= 200
      BEGIN
        SELECT RAISE(ABORT, 'chat membership insert invariant failed');
      END;

      CREATE TRIGGER trg_chat_members_role_revision
      BEFORE UPDATE ON chat_members
      WHEN (
          NEW.role <> OLD.role
          AND (
            NEW.membership_revision <> OLD.membership_revision + 1
            OR NEW.membership_updated_at IS NULL
            OR julianday(NEW.membership_updated_at) IS NULL
            OR julianday(NEW.membership_updated_at) <= julianday(
              COALESCE(OLD.membership_updated_at, OLD.joined_at)
            )
          )
        )
        OR (
          NEW.role = OLD.role
          AND (
            NEW.membership_revision <> OLD.membership_revision
            OR NEW.membership_updated_at <> OLD.membership_updated_at
          )
        )
      BEGIN
        SELECT RAISE(ABORT, 'chat membership revision transition is invalid');
      END;

      CREATE TRIGGER trg_chat_membership_revision_ledger_monotonic
      BEFORE UPDATE ON chat_membership_revision_ledger
      WHEN NEW.chat_id <> OLD.chat_id
        OR NEW.user_id <> OLD.user_id
        OR NEW.last_revision <= OLD.last_revision
        OR julianday(NEW.last_removed_at) <= julianday(OLD.last_removed_at)
      BEGIN
        SELECT RAISE(ABORT, 'chat membership revision ledger must advance');
      END;

      CREATE TRIGGER trg_chat_members_delete_revision_ledger
      BEFORE DELETE ON chat_members
      BEGIN
        INSERT INTO chat_membership_revision_ledger (
          chat_id, user_id, last_revision, last_removed_at
        ) VALUES (
          OLD.chat_id,
          OLD.user_id,
          OLD.membership_revision + 1,
          strftime(
            '%Y-%m-%dT%H:%M:%fZ',
            max(
              julianday(COALESCE(OLD.membership_updated_at, OLD.joined_at)),
              COALESCE((
                SELECT julianday(ledger.last_removed_at)
                FROM chat_membership_revision_ledger AS ledger
                WHERE ledger.chat_id = OLD.chat_id
                  AND ledger.user_id = OLD.user_id
              ), julianday(COALESCE(OLD.membership_updated_at, OLD.joined_at)))
            ) + (1.0 / 86400000.0)
          )
        )
        ON CONFLICT(chat_id, user_id) DO UPDATE SET
          last_revision = excluded.last_revision,
          last_removed_at = excluded.last_removed_at
        WHERE excluded.last_revision > chat_membership_revision_ledger.last_revision;
      END;
    `
  },
  {
    id: "025_synchronized_chat_drafts",
    sql: `
      CREATE TABLE chat_drafts (
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
        text_ciphertext TEXT,
        reply_to_message_id TEXT,
        revision INTEGER NOT NULL CHECK (revision >= 1),
        updated_at TEXT NOT NULL CHECK (julianday(updated_at) IS NOT NULL),
        deleted_at TEXT CHECK (
          deleted_at IS NULL OR julianday(deleted_at) IS NOT NULL
        ),
        PRIMARY KEY (user_id, chat_id),
        CHECK (
          (deleted_at IS NULL AND text_ciphertext IS NOT NULL)
          OR
          (deleted_at IS NOT NULL AND text_ciphertext IS NULL AND reply_to_message_id IS NULL)
        )
      ) STRICT;
      CREATE INDEX idx_chat_drafts_account_active
        ON chat_drafts(user_id, updated_at DESC, chat_id)
        WHERE deleted_at IS NULL;

      CREATE TABLE chat_draft_command_receipts (
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        client_nonce TEXT NOT NULL CHECK (length(client_nonce) = 36),
        operation TEXT NOT NULL CHECK (operation IN ('put', 'delete')),
        chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
        fingerprint_ciphertext TEXT NOT NULL CHECK (
          fingerprint_ciphertext GLOB 'luxora:v1.*'
          AND length(CAST(fingerprint_ciphertext AS BLOB)) BETWEEN 1 AND 1000
        ),
        response_ciphertext TEXT NOT NULL CHECK (
          length(CAST(response_ciphertext AS BLOB)) BETWEEN 1 AND 100000
        ),
        created_at TEXT NOT NULL CHECK (julianday(created_at) IS NOT NULL),
        expires_at TEXT NOT NULL CHECK (
          julianday(expires_at) IS NOT NULL
          AND julianday(expires_at) > julianday(created_at)
        ),
        PRIMARY KEY (user_id, client_nonce)
      ) STRICT;
      CREATE INDEX idx_chat_draft_receipts_account_chat
        ON chat_draft_command_receipts(user_id, chat_id, created_at DESC);
      CREATE INDEX idx_chat_draft_receipts_expiry
        ON chat_draft_command_receipts(expires_at, user_id, client_nonce);
      CREATE INDEX idx_chat_draft_receipts_account_expiry
        ON chat_draft_command_receipts(user_id, expires_at, client_nonce);

      CREATE TRIGGER trg_chat_drafts_insert_invariants
      BEFORE INSERT ON chat_drafts
      WHEN NEW.revision <> 1
        OR (
          NEW.deleted_at IS NULL
          AND NOT EXISTS (
            SELECT 1 FROM chat_members
            WHERE chat_id = NEW.chat_id AND user_id = NEW.user_id
          )
        )
        OR (
          NEW.reply_to_message_id IS NOT NULL
          AND NOT EXISTS (
            SELECT 1 FROM messages
            WHERE id = NEW.reply_to_message_id
              AND chat_id = NEW.chat_id
              AND deleted_at IS NULL
          )
        )
      BEGIN
        SELECT RAISE(ABORT, 'chat draft insert invariant failed');
      END;

      CREATE TRIGGER trg_chat_drafts_update_invariants
      BEFORE UPDATE ON chat_drafts
      WHEN NEW.user_id <> OLD.user_id
        OR NEW.chat_id <> OLD.chat_id
        OR NEW.revision <> OLD.revision + 1
        OR julianday(NEW.updated_at) <= julianday(OLD.updated_at)
        OR (
          NEW.deleted_at IS NULL
          AND NOT EXISTS (
            SELECT 1 FROM chat_members
            WHERE chat_id = NEW.chat_id AND user_id = NEW.user_id
          )
        )
        OR (
          NEW.reply_to_message_id IS NOT NULL
          AND NOT EXISTS (
            SELECT 1 FROM messages
            WHERE id = NEW.reply_to_message_id
              AND chat_id = NEW.chat_id
              AND deleted_at IS NULL
          )
        )
      BEGIN
        SELECT RAISE(ABORT, 'chat draft revision transition is invalid');
      END;

      CREATE TRIGGER trg_chat_draft_receipts_immutable_update
      BEFORE UPDATE ON chat_draft_command_receipts
      BEGIN
        SELECT RAISE(ABORT, 'chat draft command receipt is immutable');
      END;

      CREATE TRIGGER trg_chat_draft_receipts_immutable_delete
      BEFORE DELETE ON chat_draft_command_receipts
      WHEN julianday(OLD.expires_at) > julianday('now')
        AND EXISTS (SELECT 1 FROM users WHERE id = OLD.user_id)
        AND EXISTS (SELECT 1 FROM chats WHERE id = OLD.chat_id)
        AND EXISTS (
          SELECT 1 FROM chat_members
          WHERE user_id = OLD.user_id AND chat_id = OLD.chat_id
        )
      BEGIN
        SELECT RAISE(ABORT, 'active chat draft command receipt cannot be deleted');
      END;
    `
  },
  {
    id: "026_phone_recovery_and_binding",
    sql: `
      CREATE TABLE phone_recovery_intents (
        id TEXT PRIMARY KEY,
        challenge_id TEXT NOT NULL REFERENCES phone_auth_challenges(id),
        user_id TEXT NOT NULL REFERENCES users(id),
        phone_digest TEXT NOT NULL CHECK (
          length(phone_digest) = 64 AND phone_digest NOT GLOB '*[^0-9a-f]*'
        ),
        recovery_token_hash TEXT NOT NULL UNIQUE CHECK (
          length(recovery_token_hash) = 64 AND recovery_token_hash NOT GLOB '*[^0-9a-f]*'
        ),
        state TEXT NOT NULL CHECK (state IN ('pending', 'completed')),
        created_at TEXT NOT NULL,
        confirm_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        completed_at TEXT,
        CHECK (julianday(created_at) IS NOT NULL),
        CHECK (julianday(confirm_at) >= julianday(created_at)),
        CHECK (julianday(expires_at) > julianday(confirm_at)),
        CHECK (julianday(updated_at) >= julianday(created_at)),
        CHECK (
          (state = 'pending' AND completed_at IS NULL)
          OR (state = 'completed' AND completed_at IS NOT NULL)
        )
      ) STRICT;
      CREATE INDEX idx_phone_recovery_intents_user
        ON phone_recovery_intents(user_id, state, expires_at);
      CREATE INDEX idx_phone_recovery_intents_challenge
        ON phone_recovery_intents(challenge_id, state);

      CREATE TABLE phone_recovery_receipts (
        scope TEXT PRIMARY KEY CHECK (length(scope) BETWEEN 1 AND 192),
        fingerprint TEXT NOT NULL CHECK (
          length(fingerprint) = 64 AND fingerprint NOT GLOB '*[^0-9a-f]*'
        ),
        intent_id TEXT NOT NULL REFERENCES phone_recovery_intents(id),
        result_kind TEXT NOT NULL CHECK (result_kind IN ('started', 'completed')),
        response_ciphertext TEXT NOT NULL CHECK (
          length(CAST(response_ciphertext AS BLOB)) BETWEEN 1 AND 20000
        ),
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        CHECK (julianday(created_at) IS NOT NULL),
        CHECK (julianday(expires_at) IS NOT NULL),
        CHECK (julianday(expires_at) > julianday(created_at))
      ) STRICT;
      CREATE INDEX idx_phone_recovery_receipts_intent
        ON phone_recovery_receipts(intent_id, created_at);

      CREATE TABLE phone_recovery_events (
        event_id TEXT PRIMARY KEY,
        intent_id TEXT NOT NULL REFERENCES phone_recovery_intents(id),
        event_type TEXT NOT NULL CHECK (event_type IN (
          'phone.recovery.started',
          'phone.recovery.completed'
        )),
        command_scope TEXT NOT NULL UNIQUE CHECK (length(command_scope) BETWEEN 1 AND 192),
        occurred_at TEXT NOT NULL,
        CHECK (julianday(occurred_at) IS NOT NULL)
      ) STRICT;
      CREATE INDEX idx_phone_recovery_events_intent
        ON phone_recovery_events(intent_id, occurred_at);

      CREATE TABLE phone_binding_challenges (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id),
        phone_digest TEXT NOT NULL CHECK (
          length(phone_digest) = 64 AND phone_digest NOT GLOB '*[^0-9a-f]*'
        ),
        phone_ciphertext TEXT NOT NULL,
        code_digest TEXT NOT NULL CHECK (
          length(code_digest) = 64 AND code_digest NOT GLOB '*[^0-9a-f]*'
        ),
        delivery_code_ciphertext TEXT,
        state TEXT NOT NULL CHECK (state IN (
          'pending_delivery', 'pending', 'verified', 'consumed', 'locked', 'expired'
        )),
        revision INTEGER NOT NULL CHECK (revision >= 1),
        attempts_used INTEGER NOT NULL CHECK (attempts_used >= 0),
        max_attempts INTEGER NOT NULL CHECK (max_attempts BETWEEN 3 AND 10),
        begin_client_nonce TEXT NOT NULL UNIQUE,
        begin_fingerprint TEXT NOT NULL CHECK (
          length(begin_fingerprint) = 64 AND begin_fingerprint NOT GLOB '*[^0-9a-f]*'
        ),
        masked_phone TEXT NOT NULL,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        retry_after_seconds INTEGER NOT NULL CHECK (retry_after_seconds BETWEEN 30 AND 300),
        updated_at TEXT NOT NULL,
        verified_at TEXT,
        consumed_at TEXT,
        binding_token_hash TEXT UNIQUE CHECK (
          binding_token_hash IS NULL OR (
            length(binding_token_hash) = 64
            AND binding_token_hash NOT GLOB '*[^0-9a-f]*'
          )
        ),
        binding_expires_at TEXT,
        CHECK (attempts_used <= max_attempts),
        CHECK (julianday(created_at) IS NOT NULL),
        CHECK (julianday(expires_at) IS NOT NULL),
        CHECK (julianday(updated_at) IS NOT NULL),
        CHECK (julianday(expires_at) > julianday(created_at)),
        CHECK (julianday(updated_at) >= julianday(created_at)),
        CHECK (
          (state = 'pending_delivery' AND delivery_code_ciphertext IS NOT NULL)
          OR (state <> 'pending_delivery' AND delivery_code_ciphertext IS NULL)
        ),
        CHECK (
          (state = 'verified'
            AND verified_at IS NOT NULL
            AND consumed_at IS NULL
            AND binding_token_hash IS NOT NULL
            AND binding_expires_at IS NOT NULL)
          OR (state <> 'verified')
        ),
        CHECK (
          binding_token_hash IS NULL
          OR julianday(binding_expires_at) > julianday(verified_at)
        ),
        CHECK (
          consumed_at IS NULL OR state = 'consumed'
        )
      ) STRICT;
      CREATE INDEX idx_phone_binding_challenges_user
        ON phone_binding_challenges(user_id, created_at);
      CREATE INDEX idx_phone_binding_challenges_phone
        ON phone_binding_challenges(phone_digest, created_at);
      CREATE INDEX idx_phone_binding_challenges_binding
        ON phone_binding_challenges(binding_token_hash, state, binding_expires_at);
      CREATE INDEX idx_phone_binding_challenges_expiry
        ON phone_binding_challenges(state, expires_at);

      CREATE TABLE phone_binding_receipts (
        scope TEXT PRIMARY KEY CHECK (length(scope) BETWEEN 1 AND 192),
        fingerprint TEXT NOT NULL CHECK (
          length(fingerprint) = 64 AND fingerprint NOT GLOB '*[^0-9a-f]*'
        ),
        challenge_id TEXT NOT NULL REFERENCES phone_binding_challenges(id),
        result_kind TEXT NOT NULL CHECK (result_kind IN (
          'binding_verified', 'completed', 'phone_unavailable', 'invalid_code'
        )),
        response_ciphertext TEXT,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        CHECK (julianday(created_at) IS NOT NULL),
        CHECK (julianday(expires_at) IS NOT NULL),
        CHECK (julianday(expires_at) > julianday(created_at)),
        CHECK (
          (result_kind IN ('binding_verified', 'completed') AND response_ciphertext IS NOT NULL)
          OR (result_kind IN ('phone_unavailable', 'invalid_code') AND response_ciphertext IS NULL)
        )
      ) STRICT;
      CREATE INDEX idx_phone_binding_receipts_challenge
        ON phone_binding_receipts(challenge_id, created_at);

      CREATE TABLE phone_binding_events (
        event_id TEXT PRIMARY KEY,
        challenge_id TEXT NOT NULL REFERENCES phone_binding_challenges(id),
        revision INTEGER NOT NULL CHECK (revision >= 1),
        event_type TEXT NOT NULL CHECK (event_type IN (
          'phone.binding.created',
          'phone.binding.delivered',
          'phone.binding.delivery_failed',
          'phone.binding.verification_rejected',
          'phone.binding.verified',
          'phone.binding.completed'
        )),
        command_scope TEXT NOT NULL UNIQUE CHECK (length(command_scope) BETWEEN 1 AND 192),
        occurred_at TEXT NOT NULL,
        CHECK (julianday(occurred_at) IS NOT NULL)
      ) STRICT;
      CREATE INDEX idx_phone_binding_events_challenge
        ON phone_binding_events(challenge_id, occurred_at);

      CREATE TRIGGER trg_phone_recovery_intents_state_transition
      BEFORE UPDATE ON phone_recovery_intents
      WHEN NEW.id <> OLD.id
        OR NEW.challenge_id <> OLD.challenge_id
        OR NEW.user_id <> OLD.user_id
        OR NEW.phone_digest <> OLD.phone_digest
        OR NEW.recovery_token_hash <> OLD.recovery_token_hash
        OR NEW.created_at <> OLD.created_at
        OR NEW.confirm_at <> OLD.confirm_at
        OR NEW.expires_at <> OLD.expires_at
        OR (OLD.state = 'completed')
        OR (NEW.state = 'completed' AND (NEW.completed_at IS NULL OR NEW.completed_at < OLD.confirm_at))
      BEGIN
        SELECT RAISE(ABORT, 'phone recovery intent transition is invalid');
      END;
      CREATE TRIGGER trg_phone_recovery_receipts_no_update
      BEFORE UPDATE ON phone_recovery_receipts
      BEGIN
        SELECT RAISE(ABORT, 'phone recovery receipt is immutable');
      END;
      CREATE TRIGGER trg_phone_recovery_receipts_no_delete
      BEFORE DELETE ON phone_recovery_receipts
      BEGIN
        SELECT RAISE(ABORT, 'phone recovery receipt cannot be deleted');
      END;
      CREATE TRIGGER trg_phone_recovery_events_no_update
      BEFORE UPDATE ON phone_recovery_events
      BEGIN
        SELECT RAISE(ABORT, 'phone recovery audit is append-only');
      END;
      CREATE TRIGGER trg_phone_recovery_events_no_delete
      BEFORE DELETE ON phone_recovery_events
      BEGIN
        SELECT RAISE(ABORT, 'phone recovery audit cannot be deleted');
      END;
      CREATE TRIGGER trg_phone_binding_challenges_transition
      BEFORE UPDATE ON phone_binding_challenges
      WHEN NEW.id <> OLD.id
        OR NEW.user_id <> OLD.user_id
        OR NEW.phone_digest <> OLD.phone_digest
        OR NEW.begin_client_nonce <> OLD.begin_client_nonce
        OR NEW.begin_fingerprint <> OLD.begin_fingerprint
        OR NEW.created_at <> OLD.created_at
        OR NEW.revision < OLD.revision
        OR NEW.attempts_used < OLD.attempts_used
        OR NEW.attempts_used > NEW.max_attempts
        OR (OLD.state IN ('consumed', 'expired', 'locked'))
      BEGIN
        SELECT RAISE(ABORT, 'phone binding challenge transition is invalid');
      END;
      CREATE TRIGGER trg_phone_binding_receipts_no_update
      BEFORE UPDATE ON phone_binding_receipts
      BEGIN
        SELECT RAISE(ABORT, 'phone binding receipt is immutable');
      END;
      CREATE TRIGGER trg_phone_binding_receipts_no_delete
      BEFORE DELETE ON phone_binding_receipts
      BEGIN
        SELECT RAISE(ABORT, 'phone binding receipt cannot be deleted');
      END;
      CREATE TRIGGER trg_phone_binding_events_no_update
      BEFORE UPDATE ON phone_binding_events
      BEGIN
        SELECT RAISE(ABORT, 'phone binding audit is append-only');
      END;
      CREATE TRIGGER trg_phone_binding_events_no_delete
      BEFORE DELETE ON phone_binding_events
      BEGIN
        SELECT RAISE(ABORT, 'phone binding audit cannot be deleted');
      END;
    `
  },
  {
    id: "027_message_transcription_consent",
    sql: `
      ALTER TABLE messages ADD COLUMN transcription_consent INTEGER NOT NULL DEFAULT 0
        CHECK (transcription_consent IN (0, 1));
      ALTER TABLE messages ADD COLUMN transcript_ciphertext TEXT;

      CREATE TRIGGER trg_messages_transcript_consent_insert
      BEFORE INSERT ON messages
      WHEN NEW.transcript_ciphertext IS NOT NULL AND NEW.transcription_consent <> 1
      BEGIN
        SELECT RAISE(ABORT, 'message transcript requires sender transcription consent');
      END;
      CREATE TRIGGER trg_messages_transcript_consent_update
      BEFORE UPDATE OF transcript_ciphertext, transcription_consent ON messages
      WHEN NEW.transcript_ciphertext IS NOT NULL AND NEW.transcription_consent <> 1
      BEGIN
        SELECT RAISE(ABORT, 'message transcript requires sender transcription consent');
      END;
      CREATE TRIGGER trg_messages_transcription_consent_no_revoke
      BEFORE UPDATE OF transcription_consent ON messages
      WHEN OLD.transcription_consent = 1 AND NEW.transcription_consent = 0
        AND NEW.transcript_ciphertext IS NOT NULL
      BEGIN
        SELECT RAISE(ABORT, 'transcription consent cannot be revoked while a transcript exists');
      END;
    `
  },
  {
    id: "028_message_transcript_commands",
    sql: `
      CREATE TABLE message_transcript_commands (
        message_id TEXT PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
        author_user_id TEXT NOT NULL REFERENCES users(id),
        client_nonce TEXT NOT NULL CHECK (length(client_nonce) = 36),
        created_at TEXT NOT NULL,
        CHECK (julianday(created_at) IS NOT NULL)
      ) STRICT;

      CREATE TRIGGER trg_message_transcript_commands_no_update
      BEFORE UPDATE ON message_transcript_commands
      BEGIN
        SELECT RAISE(ABORT, 'message transcript command is immutable');
      END;
      CREATE TRIGGER trg_message_transcript_commands_no_delete
      BEFORE DELETE ON message_transcript_commands
      BEGIN
        SELECT RAISE(ABORT, 'message transcript command cannot be deleted');
      END;
    `
  },
  {
    id: "029_scheduled_messages",
    sql: `
      CREATE TABLE scheduled_messages (
        id TEXT PRIMARY KEY,
        chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
        sender_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        body_ciphertext TEXT NOT NULL,
        reply_to_message_id TEXT REFERENCES messages(id) ON DELETE SET NULL,
        topic_id TEXT,
        client_nonce TEXT NOT NULL CHECK (length(client_nonce) = 36),
        send_at TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('pending', 'sent', 'cancelled', 'failed')),
        failure_code TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        sent_at TEXT,
        CHECK (julianday(send_at) IS NOT NULL),
        CHECK (julianday(created_at) IS NOT NULL),
        CHECK (julianday(updated_at) IS NOT NULL),
        CHECK (julianday(send_at) > julianday(created_at)),
        CHECK (
          (state IN ('pending', 'cancelled') AND sent_at IS NULL)
          OR (state IN ('sent', 'failed'))
        ),
        CHECK (
          (state <> 'failed' AND failure_code IS NULL)
          OR (state = 'failed' AND failure_code IS NOT NULL)
        ),
        UNIQUE (sender_id, client_nonce)
      ) STRICT;
      CREATE INDEX idx_scheduled_messages_due
        ON scheduled_messages(state, send_at, id);
      CREATE INDEX idx_scheduled_messages_chat
        ON scheduled_messages(chat_id, sender_id, send_at, id);
    `
  },
  {
    id: "030_privacy_visibility_policies",
    sql: `
      ALTER TABLE account_privacy_settings ADD COLUMN last_seen_visibility TEXT NOT NULL DEFAULT 'everyone'
        CHECK (last_seen_visibility IN ('everyone', 'contacts', 'nobody'));
      ALTER TABLE account_privacy_settings ADD COLUMN profile_photo_visibility TEXT NOT NULL DEFAULT 'everyone'
        CHECK (profile_photo_visibility IN ('everyone', 'contacts', 'nobody'));
      ALTER TABLE account_privacy_settings ADD COLUMN forwards_visibility TEXT NOT NULL DEFAULT 'everyone'
        CHECK (forwards_visibility IN ('everyone', 'contacts', 'nobody'));
      ALTER TABLE account_privacy_settings ADD COLUMN voice_messages_visibility TEXT NOT NULL DEFAULT 'everyone'
        CHECK (voice_messages_visibility IN ('everyone', 'contacts', 'nobody'));
      ALTER TABLE account_privacy_settings ADD COLUMN calls_visibility TEXT NOT NULL DEFAULT 'everyone'
        CHECK (calls_visibility IN ('everyone', 'contacts', 'nobody'));
    `
  },
  {
    id: "031_notification_categories",
    sql: `
      ALTER TABLE notification_settings ADD COLUMN group_message_alerts INTEGER NOT NULL DEFAULT 1
        CHECK (group_message_alerts IN (0, 1));
      ALTER TABLE notification_settings ADD COLUMN channel_message_alerts INTEGER NOT NULL DEFAULT 1
        CHECK (channel_message_alerts IN (0, 1));
      ALTER TABLE notification_settings ADD COLUMN story_alerts INTEGER NOT NULL DEFAULT 1
        CHECK (story_alerts IN (0, 1));
      ALTER TABLE notification_settings ADD COLUMN reaction_alerts INTEGER NOT NULL DEFAULT 1
        CHECK (reaction_alerts IN (0, 1));
    ` 
  }];
