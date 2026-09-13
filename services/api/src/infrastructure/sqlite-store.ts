import { mkdirSync } from "node:fs";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { dirname, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { types as utilTypes } from "node:util";
import Database from "better-sqlite3";
import {
  PASSKEY_CHALLENGE_BYTES,
  StoreAuthorizationConflictError,
  StoreCredentialConflictError,
  StoreCredentialStateConflictError,
  StoreDuplicateCommandError,
  StoreDuplicateCreationError,
  StoreRevisionConflictError,
  assertAuthenticationCredential,
  assertCeremonyEventInvariants,
  assertCeremonyInvariants,
  assertRegistrationCredential,
  type CeremonyAggregate,
  type CommandReceipt,
  type CreationReceipt,
  type IssuedChallenge,
  type PersistCeremonyMutation
} from "@luxora/passkey-domain";
import type {
  Attachment,
  Chat,
  ChatKind,
  ChatPreferences,
  ChatRole,
  DurableRealtimeEvent,
  Message,
  MessagePin,
  MessageReceipt,
  MessageVersion,
  PublicProfile,
  RealtimeEvent,
  Session,
  Topic,
  UploadSession,
  User
} from "@luxora/protocol";
import {
  AttachmentSchema,
  CHAT_DRAFT_IDEMPOTENCY_TTL_SECONDS,
  CHAT_FOLDER_IDEMPOTENCY_TTL_SECONDS,
  DurableRealtimeEventSchema,
  IdSchema
} from "@luxora/protocol";
import { badRequest, conflict } from "../errors.js";
import type {
  AttachMessageTranscript,
  NewAttachment,
  NewChat,
  NewMessage,
  NewMessageRequest,
  NewPasskeyLoginIntent,
  NewPasskeySignupIntent,
  NewPhoneAuthChallenge,
  NewRefreshToken,
  NewSafetyReport,
  NewSession,
  NewUploadSession,
  NewUser,
  PasskeyLoginMutationRecord,
  PasskeyAuthenticatorMutationResult,
  PersistPasskeyAuthenticatorRename,
  PersistPasskeyAuthenticatorRevoke,
  PasskeySignupMutationRecord,
  CommitPhoneAuthAuthenticated,
  CommitPhoneAuthPasswordAuthenticated,
  CommitPhoneAuthPasswordRejected,
  CommitPhoneAuthPasswordRequired,
  CommitPhoneAuthProfileRequired,
  CommitPhoneAuthRegistration,
  CommitPhoneAuthRejected,
  CommitPhoneBindingCompleted,
  CommitPhoneBindingRejected,
  CommitPhoneBindingVerified,
  CommitPhoneRecoveryCompleted,
  NewPhoneBindingChallenge,
  NewPhoneRecoveryIntent,
  PhoneAuthReceiptInput,
  PhoneAuthPasswordReceiptInput,
  PhoneBindingReceiptInput,
  PhoneRecoveryReceiptInput,
  PersistPasskeyLoginBegin,
  PersistPasskeyLoginRejectedAttempt,
  PersistPasskeyLoginTerminal,
  PersistPasskeySignupBegin,
  PersistPasskeySignupExpired,
  PersistPasskeySignupRejectedAttempt,
  PersistVerifiedPasskeySignup,
  PersistVerifiedPasskeyLogin,
  Store
} from "../domain/store.js";
import type {
  AttachmentRecord,
  BlockRecord,
  ClaimedRealtimeOutboxEvent,
  ChatDraftCommandReceiptRecord,
  ChatDraftRecord,
  ChatFolderCommandReceiptRecord,
  ChatFolderOverrideRecord,
  ChatFolderRecord,
  ChatMemberRecord,
  ChatMembershipCommandReceiptRecord,
  ChatRecord,
  IdentityAuditAction,
  MessageRecord,
  MessageRequestRecord,
  MessageRequestState,
  NewPushRegistration,
  NotificationSettingsRecord,
  PasskeyAuthenticatorCommandReceiptRecord,
  PasskeyAuthenticatorRecord,
  PasskeyAuthenticatorRevokeClaimsProjection,
  PasskeyAuthenticatorRevokeIntentRecord,
  PasskeyAuthenticatorStepUpGrantRecord,
  PasskeyCredentialRecord,
  PasskeyLoginIntentRecord,
  PasskeyLoginIntentState,
  PasskeyLoginReceiptRecord,
  PasskeySignupIntentRecord,
  PasskeySignupIntentState,
  PasskeySignupConsumptionRecord,
  PasskeySignupReceiptRecord,
  PasskeyStepUpClaimsProjection,
  PasskeyStepUpGrantRecord,
  PasskeyUserHandleBinding,
  PhoneAuthChallengeRecord,
  PhoneAuthChallengeState,
  PhoneAuthCommandReceiptRecord,
  PhoneAuthPasswordReceiptRecord,
  PhoneBindingChallengeRecord,
  PhoneBindingReceiptRecord,
  PhoneIdentityRecord,
  PhoneRecoveryIntentRecord,
  AdminChatRecord,
  AdminStatusRecord,
  AdminUserRecord,
  ScheduledMessageRecord,
  ScheduledMessageState,
  PrivacySettingsRecord,
  PrivacyVisibility,
  PushRegistrationRecord,
  RefreshTokenRecord,
  RealtimeOutboxFailureCode,
  SafetyEvidenceSnapshot,
  SafetyReportRecord,
  SessionRecord,
  StoredEvent,
  TopicRecord,
  UploadChunkRecord,
  UploadSessionRecord,
  UserRecord
} from "../domain/types.js";
import type { ContentCipher } from "./content-cipher.js";
import { PlaintextContentCipher } from "./content-cipher.js";
import { migrations } from "./migrations.js";
import {
  passkeyAuthenticatorRenameFingerprint,
  passkeyAuthenticatorRevokeFingerprint,
  passkeyAuthenticatorRevokeTargetDigest
} from "../passkeys/authenticator-management-binding.js";

const INITIAL_OUTBOX_AVAILABLE_AT = "1970-01-01T00:00:00.000Z";
const PUSH_TOKEN_ENCRYPTED_ENVELOPE_PREFIX = "luxora:v1.";

interface UserRow {
  id: string;
  username: string;
  username_normalized: string;
  display_name: string;
  bio: string;
  avatar_url: string | null;
  avatar_attachment_id: string | null;
  password_hash: string;
  password_auth_enabled: number;
  phone_password_hash: string | null;
  phone_password_enabled: number;
  created_at: string;
  last_seen_at: string | null;
}

interface SessionRow {
  id: string;
  user_id: string;
  device_name: string;
  created_at: string;
  last_seen_at: string;
  expires_at: string;
  revoked_at: string | null;
}

interface RefreshRow {
  token_id: string;
  token_session_id: string;
  token_hash: string;
  token_created_at: string;
  token_expires_at: string;
  token_used_at: string | null;
  session_id: string;
  session_user_id: string;
  session_device_name: string;
  session_created_at: string;
  session_last_seen_at: string;
  session_expires_at: string;
  session_revoked_at: string | null;
}

interface PhoneAuthChallengeRow {
  id: string;
  phone_digest: string;
  phone_ciphertext: string;
  code_digest: string;
  delivery_code_ciphertext: string | null;
  device_name_ciphertext: string;
  state: PhoneAuthChallengeState;
  revision: number;
  attempts_used: number;
  max_attempts: number;
  begin_client_nonce: string;
  begin_fingerprint: string;
  masked_phone: string;
  created_at: string;
  expires_at: string;
  retry_after_seconds: number;
  updated_at: string;
  verified_at: string | null;
  consumed_at: string | null;
  registration_token_hash: string | null;
  registration_expires_at: string | null;
  matched_user_id: string | null;
}

interface PhoneAuthCommandReceiptRow {
  scope: string;
  operation: "verify" | "register";
  fingerprint: string;
  challenge_id: string;
  result_kind: PhoneAuthCommandReceiptRecord["resultKind"];
  response_ciphertext: string | null;
  created_at: string;
  expires_at: string;
}

interface PhoneAuthPasswordReceiptRow {
  scope: string;
  fingerprint: string;
  challenge_id: string;
  result_kind: PhoneAuthPasswordReceiptRecord["resultKind"];
  response_ciphertext: string | null;
  created_at: string;
  expires_at: string;
}

interface PhoneRecoveryIntentRow {
  id: string;
  challenge_id: string;
  user_id: string;
  phone_digest: string;
  recovery_token_hash: string;
  state: "pending" | "completed";
  created_at: string;
  confirm_at: string;
  expires_at: string;
  updated_at: string;
  completed_at: string | null;
}

interface PhoneRecoveryReceiptRow {
  scope: string;
  fingerprint: string;
  intent_id: string;
  result_kind: "started" | "completed";
  response_ciphertext: string;
  created_at: string;
  expires_at: string;
}

interface PhoneBindingChallengeRow {
  id: string;
  user_id: string;
  phone_digest: string;
  phone_ciphertext: string;
  code_digest: string;
  delivery_code_ciphertext: string | null;
  state: PhoneAuthChallengeState;
  revision: number;
  attempts_used: number;
  max_attempts: number;
  begin_client_nonce: string;
  begin_fingerprint: string;
  masked_phone: string;
  created_at: string;
  expires_at: string;
  retry_after_seconds: number;
  updated_at: string;
  verified_at: string | null;
  consumed_at: string | null;
  binding_token_hash: string | null;
  binding_expires_at: string | null;
}

interface PhoneBindingReceiptRow {
  scope: string;
  fingerprint: string;
  challenge_id: string;
  result_kind: PhoneBindingReceiptRecord["resultKind"];
  response_ciphertext: string | null;
  created_at: string;
  expires_at: string;
}

interface ScheduledMessageRow {
  id: string;
  chat_id: string;
  sender_id: string;
  body_ciphertext: string;
  reply_to_message_id: string | null;
  topic_id: string | null;
  client_nonce: string;
  send_at: string;
  state: ScheduledMessageState;
  failure_code: string | null;
  created_at: string;
  updated_at: string;
  sent_at: string | null;
}

interface PrivacySettingsRow {
  user_id: string;
  username_discoverable: number;
  message_requests: "everyone" | "nobody";
  last_seen_visibility: PrivacyVisibility;
  profile_photo_visibility: PrivacyVisibility;
  forwards_visibility: PrivacyVisibility;
  voice_messages_visibility: PrivacyVisibility;
  calls_visibility: PrivacyVisibility;
  updated_at: string;
}

interface PushRegistrationRow {
  id: string;
  user_id: string;
  session_id: string;
  platform: "apns";
  environment: "development" | "production";
  topic: "app.luxora.mobile";
  token_digest: string;
  token_ciphertext: string;
  created_at: string;
  updated_at: string;
  revoked_at: string | null;
}

interface NotificationSettingsRow {
  user_id: string;
  message_alerts: number;
  message_request_alerts: number;
  mention_alerts: number;
  group_message_alerts: number;
  channel_message_alerts: number;
  story_alerts: number;
  reaction_alerts: number;
  sound: number;
  badge: number;
  preview_mode: NotificationSettingsRecord["previewMode"];
  updated_at: string;
}

interface MessageRequestRow {
  id: string;
  pair_key: string;
  sender_id: string;
  recipient_id: string;
  client_nonce: string;
  body_ciphertext: string;
  link_url_ciphertext: string | null;
  sender_profile_snapshot_ciphertext: string;
  recipient_profile_snapshot_ciphertext: string;
  state: MessageRequestState;
  chat_id: string | null;
  created_at: string;
  updated_at: string;
  expires_at: string;
  accepted_at: string | null;
  dismissed_at: string | null;
}

interface BlockRow {
  blocker_user_id: string;
  blocked_user_id: string;
  profile_snapshot_ciphertext: string;
  created_at: string;
}

interface SafetyReportRow {
  id: string;
  reporter_user_id: string;
  subject_user_id: string;
  category: SafetyReportRecord["category"];
  evidence_ciphertext: string;
  comment_ciphertext: string | null;
  client_nonce: string;
  state: "submitted";
  also_blocked: number;
  created_at: string;
}

interface ChatRow {
  id: string;
  kind: ChatKind;
  title: string | null;
  avatar_url: string | null;
  direct_key: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
  last_message_id: string | null;
}

interface ChatMemberRow {
  chat_id: string;
  user_id: string;
  role: ChatRole;
  membership_revision: number;
  joined_at: string;
  membership_updated_at: string;
}

interface ChatMembershipRevisionLedgerRow {
  last_revision: number;
  last_removed_at: string;
}

interface ChatMembershipCommandReceiptRow {
  actor_user_id: string;
  client_nonce: string;
  operation: ChatMembershipCommandReceiptRecord["operation"];
  chat_id: string;
  target_user_id: string;
  fingerprint: string;
  result_role: Exclude<ChatRole, "owner">;
  result_revision: number;
  result_joined_at: string;
  result_updated_at: string;
  created_at: string;
}

interface ChatFolderRow {
  id: string;
  user_id: string;
  title: string;
  position: number;
  revision: number;
  include_direct: number;
  include_group: number;
  include_channel: number;
  unread_only: number;
  exclude_muted: number;
  include_archived: number;
  created_at: string;
  updated_at: string;
}

interface ChatFolderOverrideRow {
  chat_id: string;
  mode: ChatFolderOverrideRecord["mode"];
  pinned_position: number | null;
}

interface ChatFolderCommandReceiptRow {
  user_id: string;
  client_nonce: string;
  operation: ChatFolderCommandReceiptRecord["operation"];
  fingerprint: string;
  response_ciphertext: string;
  created_at: string;
  expires_at: string | null;
  effective_expires_at: string;
}

interface ChatDraftRow {
  user_id: string;
  chat_id: string;
  text_ciphertext: string | null;
  reply_to_message_id: string | null;
  revision: number;
  updated_at: string;
  deleted_at: string | null;
}

interface ChatDraftCommandReceiptRow {
  user_id: string;
  client_nonce: string;
  operation: ChatDraftCommandReceiptRecord["operation"];
  chat_id: string;
  fingerprint_ciphertext: string;
  response_ciphertext: string;
  created_at: string;
  expires_at: string;
}

interface MessageRow {
  id: string;
  chat_id: string;
  sender_id: string;
  kind: "text";
  body: string | null;
  reply_to_message_id: string | null;
  topic_id: string | null;
  forwarded_from_message_id: string | null;
  forwarded_from_chat_id: string | null;
  forwarded_from_sender_id: string | null;
  forwarded_from_sender_name_ciphertext: string | null;
  forwarded_from_created_at: string | null;
  forward_source_message_id: string | null;
  request_fingerprint_ciphertext: string | null;
  client_nonce: string;
  revision: number;
  created_at: string;
  updated_at: string;
  edited_at: string | null;
  deleted_at: string | null;
  transcription_consent: number;
  transcript_ciphertext: string | null;
}

interface AttachmentRow {
  id: string;
  owner_user_id: string;
  kind: Attachment["kind"];
  file_name_ciphertext: string;
  declared_mime_type: string;
  detected_mime_type: string;
  size_bytes: number;
  sha256: string;
  metadata_ciphertext: string;
  storage_provider: "local" | "s3";
  storage_key: string;
  safety_status: "unscanned" | "reencoded";
  metadata_trust: "client_declared" | "server_verified";
  created_at: string;
  linked_at: string | null;
  deleting_at: string | null;
  deleted_at: string | null;
}

interface UploadSessionRow {
  id: string;
  user_id: string;
  idempotency_key: string;
  kind: Attachment["kind"];
  file_name_ciphertext: string;
  declared_mime_type: string;
  size_bytes: number;
  sha256: string;
  metadata_ciphertext: string;
  storage_provider: "local" | "s3";
  chunk_size_bytes: number;
  received_bytes: number;
  status: UploadSession["status"];
  attachment_id: string | null;
  failure_code: string | null;
  expires_at: string;
  created_at: string;
  updated_at: string;
  staging_cleaned_at: string | null;
  object_cleaned_at: string | null;
}

interface UploadChunkRow {
  upload_id: string;
  chunk_index: number;
  byte_offset: number;
  size_bytes: number;
  sha256: string;
  created_at: string;
}

interface TopicRow {
  id: string;
  chat_id: string;
  title: string;
  created_by: string;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
}

interface EventRow {
  sequence: number;
  audience_user_id: string;
  event_json: string;
  created_at: string;
}

interface ClaimedOutboxRow extends EventRow {
  attempt_count: number;
}

interface PasskeyCeremonyRow {
  ceremony_id: string;
  schema_version: number;
  kind: CeremonyAggregate["kind"];
  purpose_type: CeremonyAggregate["purpose"]["type"];
  purpose_target_digest: string;
  account_id: string;
  session_id: string;
  device_id: string;
  user_handle_ref: string | null;
  challenge_reference: string;
  challenge_digest: string;
  state: CeremonyAggregate["state"];
  revision: number;
  attempts_used: number;
  max_attempts: number;
  expires_at_ms: number;
  updated_at_ms: number;
  snapshot_json: string;
}

interface PasskeyReceiptRow {
  scope: string;
  fingerprint: string;
  ceremony_id: string;
  result_revision: number;
  event_id: string;
  result_snapshot_json: string;
  created_at_ms: number;
  linked_event_id: string | null;
  linked_ceremony_id: string | null;
  linked_revision: number | null;
}

interface PasskeyChallengeRow {
  reference: string;
  challenge_ciphertext: string;
  expires_at_ms: number;
  created_at_ms: number;
}

interface PasskeyUserHandleRow {
  reference: string;
  account_id: string;
  handle_digest: string;
  handle_ciphertext: string;
  created_at_ms: number;
}

interface PasskeyCredentialRow {
  record_id: string;
  credential_id_digest: string;
  credential_id_ciphertext: string;
  account_id: string;
  user_handle_ref: string;
  handle_account_id: string | null;
  credential_material_ciphertext: string;
  algorithm: number;
  discovery_mode: string;
  credential_set_ref: string | null;
  revision: number;
  sign_count: number;
  backup_eligible: number;
  backup_state: number;
  registration_ceremony_id: string;
  created_at_ms: number;
  updated_at_ms: number;
}

interface PasskeyAuthenticatorMetadataRow {
  credential_record_id: string;
  account_id: string;
  display_name_ciphertext: string;
  lifecycle_state: string;
  revision: number;
  created_at_ms: number;
  updated_at_ms: number;
  revoked_at_ms: number | null;
}

interface PasskeyAuthenticatorReceiptRow {
  scope: string;
  fingerprint: string;
  credential_record_id: string;
  account_id: string;
  result_revision: number;
  event_id: string;
  result_snapshot_ciphertext: string;
  created_at_ms: number;
}

interface PasskeyAuthenticatorStepUpGrantRow {
  authentication_ceremony_id: string;
  account_id: string;
  session_id: string;
  device_id: string;
  credential_record_id: string;
  expected_authenticator_revision: number;
  purpose: string;
  target_digest: string;
  auth_time_sec: number;
  issued_at_sec: number;
  expires_at_sec: number;
  consumed_at_sec: number | null;
  management_command_scope: string | null;
}

interface PasskeyAuthenticatorRevokeIntentRow {
  authentication_ceremony_id: string;
  account_id: string;
  session_id: string;
  device_id: string;
  credential_record_id: string;
  expected_authenticator_revision: number;
  purpose: string;
  target_digest: string;
  created_at_ms: number;
}

interface PasskeyStepUpGrantRow {
  authentication_ceremony_id: string;
  account_id: string;
  session_id: string;
  device_id: string;
  purpose: string;
  target_digest: string;
  auth_time_sec: number;
  issued_at_sec: number;
  expires_at_sec: number;
  consumed_at_sec: number | null;
  registration_ceremony_id: string | null;
}

interface PasskeyLoginIntentRow {
  intent_id: string;
  schema_version: number;
  purpose_type: string;
  purpose_target_digest: string;
  policy_version: number;
  access_token_ttl_seconds: number;
  session_ttl_seconds: number;
  recovery_grace_seconds: number;
  expected_rp_id: string;
  expected_origin: string;
  timeout_ms: number;
  max_response_bytes: number;
  max_attempts: number;
  allowed_algorithms_json: string;
  user_verification: string;
  cross_origin_allowed: number;
  credential_boundary: string;
  challenge_reference: string;
  challenge_digest: string;
  delivery_nonce_digest: string;
  refresh_derivation_key_id: string;
  state: string;
  revision: number;
  attempts_used: number;
  created_at_ms: number;
  expires_at_ms: number;
  updated_at_ms: number;
  terminal_at_ms: number | null;
  terminal_reason: string | null;
  resolved_account_id: string | null;
  resolved_user_handle_ref: string | null;
  resolved_credential_record_id: string | null;
  resolved_credential_revision_before: number | null;
  resolved_credential_revision_after: number | null;
  resolved_sign_count_before: number | null;
  resolved_observed_sign_count: number | null;
  resolved_sign_count_after: number | null;
  resolved_backup_eligible: number | null;
  resolved_backup_state_before: number | null;
  resolved_backup_state_after: number | null;
  session_id: string | null;
  initial_refresh_token_id: string | null;
  initial_access_token_expires_at_sec: number | null;
}

interface PasskeyLoginReceiptRow {
  scope: string;
  fingerprint: string;
  intent_id: string;
  result_revision: number;
  result_state: string;
  event_id: string;
  result_json: string;
  created_at_ms: number;
  linked_event_id: string | null;
  linked_intent_id: string | null;
  linked_revision: number | null;
  linked_state: string | null;
  linked_command_scope: string | null;
  linked_occurred_at_ms: number | null;
}

interface PasskeySignupIntentRow {
  intent_id: string;
  schema_version: number;
  purpose_type: string;
  purpose_target_digest: string;
  policy_version: number;
  rp_name: string;
  expected_rp_id: string;
  expected_origin: string;
  expected_top_origins_json: string;
  timeout_ms: number;
  max_response_bytes: number;
  max_attempts: number;
  allowed_algorithms_json: string;
  require_user_presence: number;
  user_verification: string;
  resident_key: string;
  attestation: string;
  cross_origin_allowed: number;
  exclude_credentials_json: string;
  candidate_account_id: string;
  candidate_username_ciphertext: string;
  candidate_username_normalized_ciphertext: string;
  candidate_display_name_ciphertext: string;
  candidate_user_handle_ref: string;
  candidate_user_handle_digest: string;
  candidate_user_handle_ciphertext: string;
  challenge_reference: string;
  challenge_digest: string;
  delivery_nonce_digest: string;
  state: string;
  revision: number;
  attempts_used: number;
  created_at_ms: number;
  expires_at_ms: number;
  updated_at_ms: number;
  terminal_at_ms: number | null;
  terminal_reason: string | null;
  resolved_credential_record_id: string | null;
}

interface PasskeySignupReceiptRow {
  scope: string;
  fingerprint: string;
  intent_id: string;
  result_revision: number;
  result_state: string;
  event_id: string;
  result_json: string;
  created_at_ms: number;
  linked_event_id: string | null;
  linked_intent_id: string | null;
  linked_revision: number | null;
  linked_state: string | null;
  linked_command_scope: string | null;
  linked_occurred_at_ms: number | null;
}

interface PasskeySignupConsumptionRow {
  intent_id: string;
  result_revision: number;
  result_state: string;
  account_id: string;
  user_handle_ref: string;
  credential_record_id: string;
  session_id: string;
  initial_refresh_token_id: string;
  initial_access_token_expires_at_sec: number;
  refresh_derivation_key_id: string;
  committed_at_ms: number;
  linked_state: string | null;
  linked_revision: number | null;
  linked_account_id: string | null;
  linked_user_handle_ref: string | null;
  linked_credential_record_id: string | null;
  linked_updated_at_ms: number | null;
}

interface PageCursor {
  value: string;
  id: string;
}

function encodeCursor(cursor: PageCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function timestampAfterFloor(wallNow: string, floor: string): string {
  const wallNowMs = Date.parse(wallNow);
  const floorMs = Date.parse(floor);
  if (!Number.isFinite(wallNowMs) || !Number.isFinite(floorMs)) {
    throw new Error("A membership timestamp is invalid");
  }
  return wallNowMs > floorMs
    ? new Date(wallNowMs).toISOString()
    : new Date(floorMs + 1).toISOString();
}

function decodeCursor(cursor: string | undefined): PageCursor | null {
  if (cursor === undefined) return null;
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as unknown;
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      !("value" in parsed) ||
      !("id" in parsed) ||
      typeof parsed.value !== "string" ||
      typeof parsed.id !== "string"
    ) {
      throw new Error("invalid shape");
    }
    return { value: parsed.value, id: parsed.id };
  } catch {
    throw badRequest("Invalid pagination cursor");
  }
}

function mapUser(row: UserRow): UserRecord {
  return {
    id: row.id,
    username: row.username,
    usernameNormalized: row.username_normalized,
    displayName: row.display_name,
    bio: row.bio,
    avatarUrl: row.avatar_url,
    avatarPath: row.avatar_attachment_id === null
      ? null
      : `/v1/attachments/${row.avatar_attachment_id}/content`,
    avatarAttachmentId: row.avatar_attachment_id,
    passwordHash: row.password_hash,
    passwordAuthEnabled: row.password_auth_enabled === 1,
    phonePasswordHash: row.phone_password_hash,
    phonePasswordEnabled: row.phone_password_enabled === 1,
    createdAt: row.created_at,
    lastSeenAt: row.last_seen_at
  };
}

function publicUser(record: UserRecord): User {
  return {
    id: record.id,
    username: record.username,
    displayName: record.displayName,
    bio: record.bio,
    avatarUrl: record.avatarUrl,
    avatarPath: record.avatarPath ?? null,
    createdAt: record.createdAt
  };
}

function directoryUser(record: UserRecord): User {
  return {
    id: record.id,
    username: record.username,
    displayName: record.displayName,
    bio: record.bio,
    avatarUrl: record.avatarUrl,
    avatarPath: record.avatarPath ?? null,
    createdAt: record.createdAt
  };
}

function mapSession(row: SessionRow): SessionRecord {
  return {
    id: row.id,
    userId: row.user_id,
    deviceName: row.device_name,
    createdAt: row.created_at,
    lastSeenAt: row.last_seen_at,
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at
  };
}

function mapPrivacySettings(row: PrivacySettingsRow): PrivacySettingsRecord {
  return {
    userId: row.user_id,
    usernameDiscoverable: row.username_discoverable === 1,
    messageRequests: row.message_requests,
    lastSeen: row.last_seen_visibility,
    profilePhoto: row.profile_photo_visibility,
    forwards: row.forwards_visibility,
    voiceMessages: row.voice_messages_visibility,
    calls: row.calls_visibility,
    updatedAt: row.updated_at
  };
}

function mapPushRegistration(row: PushRegistrationRow): PushRegistrationRecord {
  return {
    id: row.id,
    userId: row.user_id,
    sessionId: row.session_id,
    platform: row.platform,
    environment: row.environment,
    topic: row.topic,
    tokenDigest: row.token_digest,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function mapNotificationSettings(row: NotificationSettingsRow): NotificationSettingsRecord {
  return {
    userId: row.user_id,
    messageAlerts: row.message_alerts === 1,
    messageRequestAlerts: row.message_request_alerts === 1,
    mentionAlerts: row.mention_alerts === 1,
    groupAlerts: row.group_message_alerts === 1,
    channelAlerts: row.channel_message_alerts === 1,
    storyAlerts: row.story_alerts === 1,
    reactionAlerts: row.reaction_alerts === 1,
    sound: row.sound === 1,
    badge: row.badge === 1,
    previewMode: row.preview_mode,
    updatedAt: row.updated_at
  };
}

function mapChat(row: ChatRow): ChatRecord {
  return {
    id: row.id,
    kind: row.kind,
    title: row.title,
    avatarUrl: row.avatar_url,
    directKey: row.direct_key,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastMessageId: row.last_message_id
  };
}

function mapChatMember(row: ChatMemberRow): ChatMemberRecord {
  return {
    chatId: row.chat_id,
    userId: row.user_id,
    role: row.role,
    revision: row.membership_revision,
    joinedAt: row.joined_at,
    updatedAt: row.membership_updated_at
  };
}

function mapMessage(row: MessageRow): MessageRecord & { transcriptCiphertext: string | null } {
  return {
    id: row.id,
    chatId: row.chat_id,
    senderId: row.sender_id,
    kind: row.kind,
    body: row.body,
    replyToMessageId: row.reply_to_message_id,
    topicId: row.topic_id,
    forwardedFromMessageId: row.forwarded_from_message_id,
    forwardedFromChatId: row.forwarded_from_chat_id,
    forwardedFromSenderId: row.forwarded_from_sender_id,
    forwardedFromSenderName: row.forwarded_from_sender_name_ciphertext,
    forwardedFromCreatedAt: row.forwarded_from_created_at,
    forwardSourceMessageId: row.forward_source_message_id,
    requestFingerprint: row.request_fingerprint_ciphertext,
    clientNonce: row.client_nonce,
    transcriptionConsent: row.transcription_consent === 1,
    transcript: null,
    transcriptCiphertext: row.transcript_ciphertext,
    revision: row.revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    editedAt: row.edited_at,
    deletedAt: row.deleted_at
  };
}

const PASSKEY_ENCRYPTED_ENVELOPE_PREFIX = "luxora:v1.";
const PASSKEY_DIGEST_PATTERN = /^[a-f0-9]{64}$/;
const PASSKEY_OPAQUE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const PASSKEY_TRANSPORTS = new Set(["ble", "cable", "hybrid", "internal", "nfc", "smart-card", "usb"]);
const PASSKEY_ACCOUNT_CREDENTIAL_LIMIT = 20;
const PASSKEY_AUTHENTICATOR_DEFAULT_DISPLAY_NAME = "Ключ доступа";
const PASSKEY_AUTHENTICATOR_MAX_DISPLAY_NAME_CHARACTERS = 80;
const PASSKEY_AUTHENTICATOR_MAX_DISPLAY_NAME_BYTES = 256;
const PASSKEY_STEP_UP_GRANT_TTL_SECONDS = 300;
const PASSKEY_STEP_UP_CLAIM_KEYS =
  "auth_time,ceremony_id,exp,iat,jti,purpose,sid,sub,target_digest";
const PASSKEY_USER_HANDLE_BINDING_KEYS = "accountId,createdAtMs,reference,userHandle";
const PASSKEY_CREDENTIAL_SELECT = `
  SELECT credentials.*, handles.account_id AS handle_account_id
  FROM passkey_credentials credentials
  LEFT JOIN passkey_user_handles handles
    ON handles.reference = credentials.user_handle_ref
`;
const PASSKEY_LOGIN_ALLOWED_ALGORITHMS_JSON = "[-7,-257]";
const PASSKEY_LOGIN_REFRESH_KEY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const PASSKEY_LOGIN_STATES = new Set<PasskeyLoginIntentState>([
  "pending",
  "consumed",
  "cancelled",
  "expired",
  "rejected"
]);
const PASSKEY_SIGNUP_ALLOWED_ALGORITHMS_JSON = "[-7,-257]";
const PASSKEY_SIGNUP_STATES = new Set<PasskeySignupIntentState>([
  "pending",
  "consumed",
  "expired",
  "rejected"
]);
const PASSKEY_SIGNUP_USERNAME_PATTERN = /^[A-Za-z][A-Za-z0-9_]{2,31}$/;
const PASSKEY_DISABLED_PASSWORD_HASH_PATTERN =
  /^\$argon2id\$v=19\$m=65536,t=3,p=1\$[A-Za-z0-9+/]{22}\$[A-Za-z0-9+/]{43}$/u;

class PasskeyRepositoryIntegrityError extends Error {
  constructor() {
    super("Passkey repository integrity check failed");
    this.name = "PasskeyRepositoryIntegrityError";
  }
}

function passkeyIntegrityFailure(): never {
  throw new PasskeyRepositoryIntegrityError();
}

function passkeyDigest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function passkeyBytesDigest(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function isPasskeySafeInteger(value: number, minimum = 0, maximum = Number.MAX_SAFE_INTEGER): boolean {
  return Number.isSafeInteger(value) && value >= minimum && value <= maximum;
}

function isPasskeyOpaqueId(value: unknown, maximum = 192): value is string {
  return typeof value === "string"
    && value.length >= 1
    && value.length <= maximum
    && PASSKEY_OPAQUE_ID_PATTERN.test(value);
}

function isPasskeyDigest(value: unknown): value is string {
  return typeof value === "string" && PASSKEY_DIGEST_PATTERN.test(value);
}

function isPasskeyAuthenticatorDisplayName(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && value === value.trim()
    && value === value.normalize("NFC")
    && value.length <= PASSKEY_AUTHENTICATOR_MAX_DISPLAY_NAME_CHARACTERS
    && Buffer.byteLength(value, "utf8") <= PASSKEY_AUTHENTICATOR_MAX_DISPLAY_NAME_BYTES
    && !/[\u0000-\u001f\u007f]/u.test(value)
    && !/[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u.test(value);
}

function isPasskeyLoginRefreshKeyId(value: unknown): value is string {
  return typeof value === "string" && PASSKEY_LOGIN_REFRESH_KEY_ID_PATTERN.test(value);
}

function isCanonicalPasskeyId(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const parsed = IdSchema.safeParse(value);
  return parsed.success && parsed.data === value;
}

function passkeyStepUpAuthorizationFailure(): never {
  throw new StoreAuthorizationConflictError();
}

function passkeyTimestampIso(nowMs: number): string {
  if (!isPasskeySafeInteger(nowMs)) passkeyIntegrityFailure();
  try {
    return new Date(nowMs).toISOString();
  } catch {
    passkeyIntegrityFailure();
  }
}

function isCanonicalBase64Url(
  value: unknown,
  exactBytes?: number,
  maximumBytes = 1_023
): value is string {
  if (typeof value !== "string") return false;
  if (value.length < 1 || value.length > 1_364 || !/^[A-Za-z0-9_-]+$/.test(value)) return false;
  const decoded = Buffer.from(value, "base64url");
  return decoded.byteLength >= 1
    && decoded.byteLength <= maximumBytes
    && (exactBytes === undefined || decoded.byteLength === exactBytes)
    && decoded.toString("base64url") === value;
}

function canonicalPasskeyJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalPasskeyJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => (
    `${JSON.stringify(key)}:${canonicalPasskeyJson(record[key])}`
  )).join(",")}}`;
}

function assertPasskeyStepUpClaimsProjection(
  claims: PasskeyStepUpClaimsProjection
): void {
  if (
    claims === null
    || typeof claims !== "object"
    || Array.isArray(claims)
    || Object.keys(claims).sort().join(",") !== PASSKEY_STEP_UP_CLAIM_KEYS
    || !isPasskeyOpaqueId(claims.sub)
    || !isPasskeyOpaqueId(claims.sid)
    || !isPasskeyOpaqueId(claims.ceremony_id)
    || !isCanonicalBase64Url(claims.jti, 32, 32)
    || claims.purpose !== "authenticator.add"
    || !isPasskeyDigest(claims.target_digest)
    || !isPasskeySafeInteger(claims.auth_time)
    || !isPasskeySafeInteger(claims.iat)
    || !isPasskeySafeInteger(claims.exp)
    || claims.auth_time !== claims.iat
    || claims.exp <= claims.iat
    || claims.exp - claims.iat > PASSKEY_STEP_UP_GRANT_TTL_SECONDS
  ) {
    passkeyStepUpAuthorizationFailure();
  }
}

function assertPasskeyAuthenticatorRevokeClaimsProjection(
  claims: PasskeyAuthenticatorRevokeClaimsProjection
): void {
  if (
    claims === null
    || typeof claims !== "object"
    || Array.isArray(claims)
    || Object.keys(claims).sort().join(",") !== PASSKEY_STEP_UP_CLAIM_KEYS
    || !isPasskeyOpaqueId(claims.sub)
    || !isPasskeyOpaqueId(claims.sid)
    || !isPasskeyOpaqueId(claims.ceremony_id)
    || !isCanonicalBase64Url(claims.jti, 32, 32)
    || claims.purpose !== "authenticator.revoke"
    || !isPasskeyDigest(claims.target_digest)
    || !isPasskeySafeInteger(claims.auth_time)
    || claims.auth_time !== claims.iat
    || !isPasskeySafeInteger(claims.exp, claims.iat + 1)
    || claims.exp - claims.iat > PASSKEY_STEP_UP_GRANT_TTL_SECONDS
  ) passkeyStepUpAuthorizationFailure();
}

function assertPasskeyUserHandleBindingShape(binding: PasskeyUserHandleBinding): void {
  if (
    binding === null
    || typeof binding !== "object"
    || Array.isArray(binding)
    || Object.keys(binding).sort().join(",") !== PASSKEY_USER_HANDLE_BINDING_KEYS
    || !isPasskeyOpaqueId(binding.reference)
    || !isPasskeyOpaqueId(binding.accountId)
    || !isCanonicalBase64Url(binding.userHandle, 32, 32)
    || !isPasskeySafeInteger(binding.createdAtMs)
  ) {
    passkeyIntegrityFailure();
  }
}

function mapPasskeyStepUpGrant(row: PasskeyStepUpGrantRow): PasskeyStepUpGrantRecord {
  if (
    !isPasskeyOpaqueId(row.authentication_ceremony_id)
    || !isPasskeyOpaqueId(row.account_id)
    || !isPasskeyOpaqueId(row.session_id)
    || !isPasskeyOpaqueId(row.device_id)
    || row.device_id !== row.session_id
    || row.purpose !== "authenticator.add"
    || !isPasskeyDigest(row.target_digest)
    || !isPasskeySafeInteger(row.auth_time_sec)
    || !isPasskeySafeInteger(row.issued_at_sec)
    || !isPasskeySafeInteger(row.expires_at_sec)
    || row.auth_time_sec !== row.issued_at_sec
    || row.expires_at_sec <= row.issued_at_sec
    || row.expires_at_sec - row.issued_at_sec > PASSKEY_STEP_UP_GRANT_TTL_SECONDS
    || ((row.consumed_at_sec === null) !== (row.registration_ceremony_id === null))
    || (row.consumed_at_sec !== null && (
      !isPasskeySafeInteger(row.consumed_at_sec, row.issued_at_sec, row.expires_at_sec - 1)
      || row.registration_ceremony_id === null
      || !isPasskeyOpaqueId(row.registration_ceremony_id)
    ))
  ) {
    passkeyIntegrityFailure();
  }
  return Object.freeze({
    authenticationCeremonyId: row.authentication_ceremony_id,
    accountId: row.account_id,
    sessionId: row.session_id,
    deviceId: row.device_id,
    purpose: "authenticator.add",
    targetDigest: row.target_digest,
    authTimeSec: row.auth_time_sec,
    issuedAtSec: row.issued_at_sec,
    expiresAtSec: row.expires_at_sec,
    consumedAtSec: row.consumed_at_sec,
    registrationCeremonyId: row.registration_ceremony_id
  });
}

function freezePasskeyAuthenticatorRecord(value: unknown): PasskeyAuthenticatorRecord {
  if (
    value === null
    || typeof value !== "object"
    || Array.isArray(value)
    || Object.keys(value).sort().join(",")
      !== "accountId,createdAtMs,credentialRecordId,displayName,lifecycleState,revision,revokedAtMs,updatedAtMs"
  ) passkeyIntegrityFailure();
  const record = value as Record<string, unknown>;
  if (
    !isPasskeyOpaqueId(record["credentialRecordId"])
    || !isPasskeyOpaqueId(record["accountId"])
    || !isPasskeyAuthenticatorDisplayName(record["displayName"])
    || (record["lifecycleState"] !== "active" && record["lifecycleState"] !== "revoked")
    || !isPasskeySafeInteger(record["revision"] as number, 1)
    || !isPasskeySafeInteger(record["createdAtMs"] as number)
    || !isPasskeySafeInteger(record["updatedAtMs"] as number, record["createdAtMs"] as number)
    || (record["lifecycleState"] === "active" && record["revokedAtMs"] !== null)
    || (record["lifecycleState"] === "revoked"
      && (!isPasskeySafeInteger(record["revokedAtMs"] as number, record["createdAtMs"] as number)
        || record["revokedAtMs"] !== record["updatedAtMs"]))
  ) passkeyIntegrityFailure();
  return Object.freeze({
    credentialRecordId: record["credentialRecordId"] as string,
    accountId: record["accountId"] as string,
    displayName: record["displayName"] as string,
    lifecycleState: record["lifecycleState"] as "active" | "revoked",
    revision: record["revision"] as number,
    createdAtMs: record["createdAtMs"] as number,
    updatedAtMs: record["updatedAtMs"] as number,
    revokedAtMs: record["revokedAtMs"] as number | null
  });
}

function mapPasskeyAuthenticatorStepUpGrant(
  row: PasskeyAuthenticatorStepUpGrantRow
): PasskeyAuthenticatorStepUpGrantRecord {
  if (
    !isPasskeyOpaqueId(row.authentication_ceremony_id)
    || !isPasskeyOpaqueId(row.account_id)
    || !isPasskeyOpaqueId(row.session_id)
    || row.device_id !== row.session_id
    || !isPasskeyOpaqueId(row.credential_record_id)
    || !isPasskeySafeInteger(row.expected_authenticator_revision, 1)
    || row.purpose !== "authenticator.revoke"
    || !isPasskeyDigest(row.target_digest)
    || !isPasskeySafeInteger(row.auth_time_sec)
    || row.auth_time_sec !== row.issued_at_sec
    || !isPasskeySafeInteger(row.expires_at_sec, row.issued_at_sec + 1)
    || row.expires_at_sec - row.issued_at_sec > PASSKEY_STEP_UP_GRANT_TTL_SECONDS
    || ((row.consumed_at_sec === null) !== (row.management_command_scope === null))
    || (row.consumed_at_sec !== null && (
      !isPasskeySafeInteger(row.consumed_at_sec, row.issued_at_sec, row.expires_at_sec - 1)
      || !isPasskeyOpaqueId(row.management_command_scope)
    ))
  ) passkeyIntegrityFailure();
  return Object.freeze({
    authenticationCeremonyId: row.authentication_ceremony_id,
    accountId: row.account_id,
    sessionId: row.session_id,
    deviceId: row.device_id,
    credentialRecordId: row.credential_record_id,
    expectedAuthenticatorRevision: row.expected_authenticator_revision,
    purpose: "authenticator.revoke",
    targetDigest: row.target_digest,
    authTimeSec: row.auth_time_sec,
    issuedAtSec: row.issued_at_sec,
    expiresAtSec: row.expires_at_sec,
    consumedAtSec: row.consumed_at_sec,
    managementCommandScope: row.management_command_scope
  });
}

function mapPasskeyAuthenticatorRevokeIntent(
  row: PasskeyAuthenticatorRevokeIntentRow
): PasskeyAuthenticatorRevokeIntentRecord {
  if (
    !isPasskeyOpaqueId(row.authentication_ceremony_id)
    || !isPasskeyOpaqueId(row.account_id)
    || !isPasskeyOpaqueId(row.session_id)
    || row.device_id !== row.session_id
    || !isPasskeyOpaqueId(row.credential_record_id)
    || !isPasskeySafeInteger(row.expected_authenticator_revision, 1)
    || row.purpose !== "authenticator.revoke"
    || !isPasskeyDigest(row.target_digest)
    || !isPasskeySafeInteger(row.created_at_ms)
  ) passkeyIntegrityFailure();
  return Object.freeze({
    authenticationCeremonyId: row.authentication_ceremony_id,
    accountId: row.account_id,
    sessionId: row.session_id,
    deviceId: row.device_id,
    credentialRecordId: row.credential_record_id,
    expectedAuthenticatorRevision: row.expected_authenticator_revision,
    purpose: "authenticator.revoke",
    targetDigest: row.target_digest,
    createdAtMs: row.created_at_ms
  });
}

function isPasskeyLoginState(value: unknown): value is PasskeyLoginIntentState {
  return typeof value === "string"
    && PASSKEY_LOGIN_STATES.has(value as PasskeyLoginIntentState);
}

function isPasskeyBooleanInteger(value: unknown): value is 0 | 1 {
  return value === 0 || value === 1;
}

function isPasskeyPlainRecord(value: unknown): value is Record<string, unknown> {
  if (
    value === null
    || typeof value !== "object"
    || Array.isArray(value)
    || utilTypes.isProxy(value)
  ) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasExactPasskeyKeys(value: unknown, expected: readonly string[]): value is Record<string, unknown> {
  if (!isPasskeyPlainRecord(value)) return false;
  const keys = Reflect.ownKeys(value);
  if (
    keys.length !== expected.length
    || keys.some((key) => typeof key !== "string" || !expected.includes(key))
  ) return false;
  const descriptors = Object.getOwnPropertyDescriptors(value) as unknown as Record<
    PropertyKey,
    PropertyDescriptor
  >;
  return expected.every((key) => {
    const descriptor = descriptors[key];
    return descriptor !== undefined
      && Object.hasOwn(descriptor, "value")
      && descriptor.enumerable === true;
  });
}

function isExactPasskeyAlgorithmTuple(value: unknown): value is readonly [-7, -257] {
  if (
    value === null
    || typeof value !== "object"
    || utilTypes.isProxy(value)
    || !Array.isArray(value)
    || Object.getPrototypeOf(value) !== Array.prototype
  ) return false;
  const keys = Reflect.ownKeys(value);
  if (
    keys.length !== 3
    || !keys.includes("0")
    || !keys.includes("1")
    || !keys.includes("length")
  ) return false;
  const descriptors = Object.getOwnPropertyDescriptors(value) as unknown as Record<
    PropertyKey,
    PropertyDescriptor
  >;
  const first = descriptors["0"];
  const second = descriptors["1"];
  const length = descriptors["length"];
  return first !== undefined
    && Object.hasOwn(first, "value")
    && first.enumerable === true
    && first.value === -7
    && second !== undefined
    && Object.hasOwn(second, "value")
    && second.enumerable === true
    && second.value === -257
    && length !== undefined
    && Object.hasOwn(length, "value")
    && length.enumerable === false
    && length.value === 2;
}

function isExactPasskeyEmptyTuple(value: unknown): value is readonly [] {
  if (
    value === null
    || typeof value !== "object"
    || utilTypes.isProxy(value)
    || !Array.isArray(value)
    || Object.getPrototypeOf(value) !== Array.prototype
  ) return false;
  const keys = Reflect.ownKeys(value);
  if (keys.length !== 1 || keys[0] !== "length") return false;
  const descriptor = Object.getOwnPropertyDescriptor(value, "length");
  return descriptor !== undefined
    && Object.hasOwn(descriptor, "value")
    && descriptor.enumerable === false
    && descriptor.value === 0;
}

function isExactPasskeyUserHandleBytes(value: unknown): value is Uint8Array<ArrayBuffer> {
  return value instanceof Uint8Array
    && !utilTypes.isProxy(value)
    && Object.getPrototypeOf(value) === Uint8Array.prototype
    && value.buffer instanceof ArrayBuffer
    && value.byteLength === 32;
}

function isExactPasskeyPublicKeyBytes(value: unknown): value is Uint8Array<ArrayBuffer> {
  return value instanceof Uint8Array
    && !utilTypes.isProxy(value)
    && Object.getPrototypeOf(value) === Uint8Array.prototype
    && value.buffer instanceof ArrayBuffer
    && value.byteLength >= 1
    && value.byteLength <= 4_096;
}

function isExactPasskeyTransports(
  value: unknown
): value is readonly ("ble" | "cable" | "hybrid" | "internal" | "nfc" | "smart-card" | "usb")[] {
  if (
    value === null
    || typeof value !== "object"
    || utilTypes.isProxy(value)
    || !Array.isArray(value)
    || Object.getPrototypeOf(value) !== Array.prototype
    || value.length > PASSKEY_TRANSPORTS.size
  ) return false;
  const keys = Reflect.ownKeys(value);
  if (keys.length !== value.length + 1 || !keys.includes("length")) return false;
  const descriptors = Object.getOwnPropertyDescriptors(value) as unknown as Record<
    PropertyKey,
    PropertyDescriptor
  >;
  const transports: string[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (
      descriptor === undefined
      || !Object.hasOwn(descriptor, "value")
      || descriptor.enumerable !== true
      || typeof descriptor.value !== "string"
      || !PASSKEY_TRANSPORTS.has(descriptor.value)
    ) return false;
    transports.push(descriptor.value);
  }
  const length = descriptors["length"];
  return length !== undefined
    && Object.hasOwn(length, "value")
    && length.enumerable === false
    && length.value === value.length
    && new Set(transports).size === transports.length;
}

function passkeyIsoTimestampMs(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const milliseconds = Date.parse(value);
  if (!isPasskeySafeInteger(milliseconds)) return null;
  try {
    return new Date(milliseconds).toISOString() === value ? milliseconds : null;
  } catch {
    return null;
  }
}

function mapPasskeyLoginIntent(row: PasskeyLoginIntentRow): PasskeyLoginIntentRecord {
  const state = row.state;
  const pendingShape = state === "pending"
    && row.attempts_used < row.max_attempts
    && row.revision === row.attempts_used + 1
    && row.terminal_at_ms === null
    && row.terminal_reason === null
    && row.updated_at_ms < row.expires_at_ms;
  const consumedShape = state === "consumed"
    && row.attempts_used < row.max_attempts
    && row.revision === row.attempts_used + 2
    && row.terminal_at_ms === row.updated_at_ms
    && row.terminal_reason === "verified"
    && row.updated_at_ms < row.expires_at_ms;
  const cancelledShape = state === "cancelled"
    && row.attempts_used < row.max_attempts
    && row.revision === row.attempts_used + 2
    && row.terminal_at_ms === row.updated_at_ms
    && row.terminal_reason === "cancelled"
    && row.updated_at_ms < row.expires_at_ms;
  const expiredShape = state === "expired"
    && row.attempts_used < row.max_attempts
    && row.revision === row.attempts_used + 2
    && row.terminal_at_ms === row.updated_at_ms
    && row.terminal_reason === "expired"
    && row.updated_at_ms >= row.expires_at_ms;
  const rejectedShape = state === "rejected"
    && row.attempts_used === row.max_attempts
    && row.revision === row.attempts_used + 1
    && row.terminal_at_ms === row.updated_at_ms
    && row.terminal_reason === "attempts_exhausted"
    && row.updated_at_ms < row.expires_at_ms;
  const resolutionValues = [
    row.resolved_account_id,
    row.resolved_user_handle_ref,
    row.resolved_credential_record_id,
    row.resolved_credential_revision_before,
    row.resolved_credential_revision_after,
    row.resolved_sign_count_before,
    row.resolved_observed_sign_count,
    row.resolved_sign_count_after,
    row.resolved_backup_eligible,
    row.resolved_backup_state_before,
    row.resolved_backup_state_after,
    row.session_id,
    row.initial_refresh_token_id,
    row.initial_access_token_expires_at_sec
  ];
  const hasResolution = resolutionValues.every((value) => value !== null);
  const hasNoResolution = resolutionValues.every((value) => value === null);
  if (
    !isCanonicalPasskeyId(row.intent_id)
    || row.schema_version !== 1
    || row.purpose_type !== "session.create"
    || !isPasskeyDigest(row.purpose_target_digest)
    || row.policy_version !== 1
    || !isPasskeySafeInteger(row.access_token_ttl_seconds, 60, 3_600)
    || !isPasskeySafeInteger(row.session_ttl_seconds, 86_400, 31_536_000)
    || !isPasskeySafeInteger(row.recovery_grace_seconds, 0, 300)
    || row.expected_rp_id !== "auth.luxora.app"
    || row.expected_origin !== "https://auth.luxora.app"
    || !isPasskeySafeInteger(row.timeout_ms, 300_000, 600_000)
    || !isPasskeySafeInteger(row.max_response_bytes, 1, 65_536)
    || !isPasskeySafeInteger(row.max_attempts, 1, 5)
    || row.allowed_algorithms_json !== PASSKEY_LOGIN_ALLOWED_ALGORITHMS_JSON
    || row.user_verification !== "required"
    || row.cross_origin_allowed !== 0
    || row.credential_boundary !== "discoverable_any"
    || !isPasskeyOpaqueId(row.challenge_reference)
    || !isPasskeyDigest(row.challenge_digest)
    || !isPasskeyDigest(row.delivery_nonce_digest)
    || !isPasskeyLoginRefreshKeyId(row.refresh_derivation_key_id)
    || !isPasskeyLoginState(state)
    || !isPasskeySafeInteger(row.revision, 1)
    || !isPasskeySafeInteger(row.attempts_used, 0, row.max_attempts)
    || !isPasskeySafeInteger(row.created_at_ms)
    || !isPasskeySafeInteger(row.expires_at_ms, row.created_at_ms + 1)
    || !isPasskeySafeInteger(row.updated_at_ms, row.created_at_ms)
    || row.created_at_ms > Number.MAX_SAFE_INTEGER - row.timeout_ms
    || row.expires_at_ms !== row.created_at_ms + row.timeout_ms
    || row.access_token_ttl_seconds < Math.ceil(row.expires_at_ms / 1_000)
      - Math.floor(row.created_at_ms / 1_000) + row.recovery_grace_seconds
    || !(pendingShape || consumedShape || cancelledShape || expiredShape || rejectedShape)
    || (state === "consumed" ? !hasResolution : !hasNoResolution)
  ) {
    passkeyIntegrityFailure();
  }

  let resolution: PasskeyLoginIntentRecord["resolution"] = null;
  if (state === "consumed") {
    const accountId = row.resolved_account_id as string;
    const userHandleRef = row.resolved_user_handle_ref as string;
    const credentialRecordId = row.resolved_credential_record_id as string;
    const revisionBefore = row.resolved_credential_revision_before as number;
    const revisionAfter = row.resolved_credential_revision_after as number;
    const signCountBefore = row.resolved_sign_count_before as number;
    const observedSignCount = row.resolved_observed_sign_count as number;
    const signCountAfter = row.resolved_sign_count_after as number;
    const backupEligible = row.resolved_backup_eligible;
    const backupStateBefore = row.resolved_backup_state_before;
    const backupStateAfter = row.resolved_backup_state_after;
    const sessionId = row.session_id as string;
    const refreshTokenId = row.initial_refresh_token_id as string;
    const accessTokenExpiresAtSec = row.initial_access_token_expires_at_sec as number;
    if (
      !isCanonicalPasskeyId(accountId)
      || !isPasskeyOpaqueId(userHandleRef)
      || !isPasskeyOpaqueId(credentialRecordId)
      || !isPasskeySafeInteger(revisionBefore, 1)
      || revisionAfter !== revisionBefore + 1
      || !isPasskeySafeInteger(signCountBefore, 0, 0xffff_ffff)
      || !isPasskeySafeInteger(observedSignCount, 0, 0xffff_ffff)
      || !isPasskeySafeInteger(signCountAfter, 0, 0xffff_ffff)
      || signCountAfter !== Math.max(signCountBefore, observedSignCount)
      || !isPasskeyBooleanInteger(backupEligible)
      || !isPasskeyBooleanInteger(backupStateBefore)
      || !isPasskeyBooleanInteger(backupStateAfter)
      || (backupEligible === 0 && (backupStateBefore !== 0 || backupStateAfter !== 0))
      || !isCanonicalPasskeyId(sessionId)
      || !isCanonicalPasskeyId(refreshTokenId)
      || !isPasskeySafeInteger(accessTokenExpiresAtSec)
      || accessTokenExpiresAtSec
        !== Math.floor(row.updated_at_ms / 1_000) + row.access_token_ttl_seconds
      || accessTokenExpiresAtSec
        < Math.ceil(row.expires_at_ms / 1_000) + row.recovery_grace_seconds
    ) {
      passkeyIntegrityFailure();
    }
    resolution = Object.freeze({
      accountId,
      userHandleRef,
      credentialRecordId,
      credentialRevisionBefore: revisionBefore,
      credentialRevisionAfter: revisionAfter,
      signCountBefore,
      observedSignCount,
      signCountAfter,
      backupEligible: backupEligible === 1,
      backupStateBefore: backupStateBefore === 1,
      backupStateAfter: backupStateAfter === 1,
      sessionId,
      initialRefreshTokenId: refreshTokenId,
      initialAccessTokenExpiresAtSec: accessTokenExpiresAtSec
    });
  }

  return Object.freeze({
    intentId: row.intent_id,
    schemaVersion: 1,
    purpose: Object.freeze({
      type: "session.create" as const,
      targetDigest: row.purpose_target_digest
    }),
    policyVersion: 1,
    accessTokenTtlSeconds: row.access_token_ttl_seconds,
    sessionTtlSeconds: row.session_ttl_seconds,
    recoveryGraceSeconds: row.recovery_grace_seconds,
    expectedRpId: row.expected_rp_id,
    expectedOrigin: row.expected_origin,
    timeoutMs: row.timeout_ms,
    maxResponseBytes: row.max_response_bytes,
    maxAttempts: row.max_attempts,
    allowedAlgorithms: Object.freeze([-7, -257] as const),
    userVerification: "required",
    crossOriginAllowed: false,
    credentialBoundary: Object.freeze({
      mode: "discoverable_any" as const,
      credentialSetRef: null
    }),
    challenge: Object.freeze({
      reference: row.challenge_reference,
      digest: row.challenge_digest
    }),
    deliveryNonceDigest: row.delivery_nonce_digest,
    refreshDerivationKeyId: row.refresh_derivation_key_id,
    state,
    revision: row.revision,
    attemptsUsed: row.attempts_used,
    createdAtMs: row.created_at_ms,
    expiresAtMs: row.expires_at_ms,
    updatedAtMs: row.updated_at_ms,
    terminalAtMs: row.terminal_at_ms,
    terminalReason: row.terminal_reason as PasskeyLoginIntentRecord["terminalReason"],
    resolution
  });
}

function mapPasskeyLoginReceipt(
  row: PasskeyLoginReceiptRow,
  expectedScope: string,
  requireCommandScope: boolean
): PasskeyLoginReceiptRecord {
  let result: unknown;
  try {
    result = JSON.parse(row.result_json) as unknown;
  } catch {
    passkeyIntegrityFailure();
  }
  if (
    !hasExactPasskeyKeys(result, ["intentId", "revision", "state"])
    || result["intentId"] !== row.intent_id
    || result["revision"] !== row.result_revision
    || result["state"] !== row.result_state
    || row.scope !== expectedScope
    || !isPasskeyOpaqueId(row.scope)
    || !isPasskeyDigest(row.fingerprint)
    || !isCanonicalPasskeyId(row.intent_id)
    || !isPasskeySafeInteger(row.result_revision, 1)
    || !isPasskeyLoginState(row.result_state)
    || !isPasskeyOpaqueId(row.event_id)
    || !isPasskeySafeInteger(row.created_at_ms)
    || row.linked_event_id !== row.event_id
    || row.linked_intent_id !== row.intent_id
    || row.linked_revision !== row.result_revision
    || row.linked_state !== row.result_state
    || row.linked_occurred_at_ms !== row.created_at_ms
    || (requireCommandScope && row.linked_command_scope !== row.scope)
  ) {
    passkeyIntegrityFailure();
  }
  return Object.freeze({
    scope: row.scope,
    fingerprint: row.fingerprint,
    intentId: row.intent_id,
    resultRevision: row.result_revision,
    resultState: row.result_state,
    eventId: row.event_id,
    createdAtMs: row.created_at_ms
  });
}

function isPasskeySignupState(value: unknown): value is PasskeySignupIntentState {
  return typeof value === "string"
    && PASSKEY_SIGNUP_STATES.has(value as PasskeySignupIntentState);
}

function mapPasskeySignupIntent(
  row: PasskeySignupIntentRow,
  contentCipher: ContentCipher
): PasskeySignupIntentRecord {
  let username: string;
  let usernameNormalized: string;
  let displayName: string;
  let userHandleEncoded: string;
  try {
    if (
      !row.candidate_username_ciphertext.startsWith(PASSKEY_ENCRYPTED_ENVELOPE_PREFIX)
      || !row.candidate_username_normalized_ciphertext.startsWith(PASSKEY_ENCRYPTED_ENVELOPE_PREFIX)
      || !row.candidate_display_name_ciphertext.startsWith(PASSKEY_ENCRYPTED_ENVELOPE_PREFIX)
      || !row.candidate_user_handle_ciphertext.startsWith(PASSKEY_ENCRYPTED_ENVELOPE_PREFIX)
    ) passkeyIntegrityFailure();
    username = contentCipher.decrypt(
      row.candidate_username_ciphertext,
      `passkey-signup:${row.intent_id}:username`
    );
    usernameNormalized = contentCipher.decrypt(
      row.candidate_username_normalized_ciphertext,
      `passkey-signup:${row.intent_id}:username-normalized`
    );
    displayName = contentCipher.decrypt(
      row.candidate_display_name_ciphertext,
      `passkey-signup:${row.intent_id}:display-name`
    );
    userHandleEncoded = contentCipher.decrypt(
      row.candidate_user_handle_ciphertext,
      `passkey-signup:${row.intent_id}:user-handle`
    );
  } catch {
    passkeyIntegrityFailure();
  }
  const userHandleBuffer = typeof userHandleEncoded === "string"
    ? Buffer.from(userHandleEncoded, "base64url")
    : Buffer.alloc(0);
  const userHandle = new Uint8Array(userHandleBuffer);
  const state = row.state;
  const pendingShape = state === "pending"
    && row.attempts_used < row.max_attempts
    && row.revision === row.attempts_used + 1
    && row.terminal_at_ms === null
    && row.terminal_reason === null
    && row.resolved_credential_record_id === null
    && row.updated_at_ms < row.expires_at_ms;
  const consumedShape = state === "consumed"
    && row.attempts_used < row.max_attempts
    && row.revision === row.attempts_used + 2
    && row.terminal_at_ms === row.updated_at_ms
    && row.terminal_reason === "verified"
    && isPasskeyOpaqueId(row.resolved_credential_record_id)
    && row.updated_at_ms < row.expires_at_ms;
  const expiredShape = state === "expired"
    && row.attempts_used < row.max_attempts
    && row.revision === row.attempts_used + 2
    && row.terminal_at_ms === row.updated_at_ms
    && row.terminal_reason === "expired"
    && row.resolved_credential_record_id === null
    && row.updated_at_ms >= row.expires_at_ms;
  const rejectedShape = state === "rejected"
    && row.attempts_used === row.max_attempts
    && row.revision === row.attempts_used + 1
    && row.terminal_at_ms === row.updated_at_ms
    && row.terminal_reason === "attempts_exhausted"
    && row.resolved_credential_record_id === null
    && row.updated_at_ms < row.expires_at_ms;
  if (
    !isCanonicalPasskeyId(row.intent_id)
    || row.schema_version !== 1
    || row.purpose_type !== "account.create"
    || !isPasskeyDigest(row.purpose_target_digest)
    || row.policy_version !== 1
    || row.rp_name !== "Luxora"
    || row.expected_rp_id !== "auth.luxora.app"
    || row.expected_origin !== "https://auth.luxora.app"
    || row.expected_top_origins_json !== "[]"
    || !isPasskeySafeInteger(row.timeout_ms, 300_000, 600_000)
    || !isPasskeySafeInteger(row.max_response_bytes, 1, 65_536)
    || !isPasskeySafeInteger(row.max_attempts, 1, 5)
    || row.allowed_algorithms_json !== PASSKEY_SIGNUP_ALLOWED_ALGORITHMS_JSON
    || row.require_user_presence !== 1
    || row.user_verification !== "required"
    || row.resident_key !== "required"
    || row.attestation !== "none"
    || row.cross_origin_allowed !== 0
    || row.exclude_credentials_json !== "[]"
    || !isCanonicalPasskeyId(row.candidate_account_id)
    || typeof username !== "string"
    || !PASSKEY_SIGNUP_USERNAME_PATTERN.test(username)
    || usernameNormalized !== username.toLowerCase()
    || !PASSKEY_SIGNUP_USERNAME_PATTERN.test(usernameNormalized)
    || displayName.length < 1
    || displayName.length > 80
    || displayName.trim() !== displayName
    || displayName.normalize("NFC") !== displayName
    || !isPasskeyOpaqueId(row.candidate_user_handle_ref)
    || !isCanonicalBase64Url(userHandleEncoded, 32, 32)
    || userHandle.byteLength !== 32
    || !isPasskeyDigest(row.candidate_user_handle_digest)
    || row.candidate_user_handle_digest !== passkeyBytesDigest(userHandle)
    || !isPasskeyOpaqueId(row.challenge_reference)
    || !isPasskeyDigest(row.challenge_digest)
    || !isPasskeyDigest(row.delivery_nonce_digest)
    || !isPasskeySignupState(state)
    || !isPasskeySafeInteger(row.revision, 1)
    || !isPasskeySafeInteger(row.attempts_used, 0, row.max_attempts)
    || !isPasskeySafeInteger(row.created_at_ms)
    || !isPasskeySafeInteger(row.expires_at_ms, row.created_at_ms + 1)
    || !isPasskeySafeInteger(row.updated_at_ms, row.created_at_ms)
    || row.created_at_ms > Number.MAX_SAFE_INTEGER - row.timeout_ms
    || row.expires_at_ms !== row.created_at_ms + row.timeout_ms
    || !(pendingShape || consumedShape || expiredShape || rejectedShape)
  ) passkeyIntegrityFailure();

  return Object.freeze({
    intentId: row.intent_id,
    schemaVersion: 1,
    purpose: Object.freeze({
      type: "account.create" as const,
      targetDigest: row.purpose_target_digest
    }),
    policyVersion: 1,
    rpName: "Luxora",
    expectedRpId: row.expected_rp_id,
    expectedOrigin: row.expected_origin,
    expectedTopOrigins: Object.freeze([]) as readonly [],
    timeoutMs: row.timeout_ms,
    maxResponseBytes: row.max_response_bytes,
    maxAttempts: row.max_attempts,
    allowedAlgorithms: Object.freeze([-7, -257] as const),
    requireUserPresence: true,
    userVerification: "required",
    residentKey: "required",
    attestation: "none",
    crossOriginAllowed: false,
    excludeCredentials: Object.freeze([]) as readonly [],
    candidate: Object.freeze({
      accountId: row.candidate_account_id,
      username,
      usernameNormalized,
      displayName,
      userHandleRef: row.candidate_user_handle_ref,
      userHandle: new Uint8Array(userHandle)
    }),
    challenge: Object.freeze({
      reference: row.challenge_reference,
      digest: row.challenge_digest
    }),
    deliveryNonceDigest: row.delivery_nonce_digest,
    state,
    revision: row.revision,
    attemptsUsed: row.attempts_used,
    createdAtMs: row.created_at_ms,
    expiresAtMs: row.expires_at_ms,
    updatedAtMs: row.updated_at_ms,
    terminalAtMs: row.terminal_at_ms,
    terminalReason: row.terminal_reason as PasskeySignupIntentRecord["terminalReason"],
    resolvedCredentialRecordId: row.resolved_credential_record_id
  });
}

function mapPasskeySignupConsumption(
  row: PasskeySignupConsumptionRow
): PasskeySignupConsumptionRecord {
  if (
    !isCanonicalPasskeyId(row.intent_id)
    || !isPasskeySafeInteger(row.result_revision, 2)
    || row.result_state !== "consumed"
    || !isCanonicalPasskeyId(row.account_id)
    || !isPasskeyOpaqueId(row.user_handle_ref)
    || !isPasskeyOpaqueId(row.credential_record_id)
    || !isCanonicalPasskeyId(row.session_id)
    || !isCanonicalPasskeyId(row.initial_refresh_token_id)
    || !isPasskeySafeInteger(row.initial_access_token_expires_at_sec)
    || !isPasskeyLoginRefreshKeyId(row.refresh_derivation_key_id)
    || !isPasskeySafeInteger(row.committed_at_ms)
    || row.initial_access_token_expires_at_sec <= Math.floor(row.committed_at_ms / 1_000)
    || row.linked_state !== "consumed"
    || row.linked_revision !== row.result_revision
    || row.linked_account_id !== row.account_id
    || row.linked_user_handle_ref !== row.user_handle_ref
    || row.linked_credential_record_id !== row.credential_record_id
    || row.linked_updated_at_ms !== row.committed_at_ms
  ) passkeyIntegrityFailure();
  return Object.freeze({
    intentId: row.intent_id,
    resultRevision: row.result_revision,
    accountId: row.account_id,
    userHandleRef: row.user_handle_ref,
    credentialRecordId: row.credential_record_id,
    sessionId: row.session_id,
    initialRefreshTokenId: row.initial_refresh_token_id,
    initialAccessTokenExpiresAtSec: row.initial_access_token_expires_at_sec,
    refreshDerivationKeyId: row.refresh_derivation_key_id,
    committedAtMs: row.committed_at_ms
  });
}

function mapPasskeySignupReceipt(
  row: PasskeySignupReceiptRow,
  expectedScope: string,
  requireCommandScope: boolean
): PasskeySignupReceiptRecord {
  let result: unknown;
  try {
    result = JSON.parse(row.result_json) as unknown;
  } catch {
    passkeyIntegrityFailure();
  }
  if (
    !hasExactPasskeyKeys(result, ["intentId", "revision", "state"])
    || result["intentId"] !== row.intent_id
    || result["revision"] !== row.result_revision
    || result["state"] !== row.result_state
    || row.scope !== expectedScope
    || !isPasskeyOpaqueId(row.scope)
    || !isPasskeyDigest(row.fingerprint)
    || !isCanonicalPasskeyId(row.intent_id)
    || !isPasskeySafeInteger(row.result_revision, 1)
    || !isPasskeySignupState(row.result_state)
    || !isPasskeyOpaqueId(row.event_id)
    || !isPasskeySafeInteger(row.created_at_ms)
    || row.linked_event_id !== row.event_id
    || row.linked_intent_id !== row.intent_id
    || row.linked_revision !== row.result_revision
    || row.linked_state !== row.result_state
    || row.linked_occurred_at_ms !== row.created_at_ms
    || (requireCommandScope && row.linked_command_scope !== row.scope)
  ) passkeyIntegrityFailure();
  return Object.freeze({
    scope: row.scope,
    fingerprint: row.fingerprint,
    intentId: row.intent_id,
    resultRevision: row.result_revision,
    resultState: row.result_state,
    eventId: row.event_id,
    createdAtMs: row.created_at_ms
  });
}

function parsePasskeySnapshot(serialized: string): CeremonyAggregate {
  let value: unknown;
  try {
    value = JSON.parse(serialized) as unknown;
    assertCeremonyInvariants(value as CeremonyAggregate);
  } catch {
    passkeyIntegrityFailure();
  }
  return value as CeremonyAggregate;
}

function mapPasskeyCeremony(row: PasskeyCeremonyRow): CeremonyAggregate {
  const snapshot = parsePasskeySnapshot(row.snapshot_json);
  if (
    row.ceremony_id !== snapshot.ceremonyId
    || row.schema_version !== snapshot.schemaVersion
    || row.kind !== snapshot.kind
    || row.purpose_type !== snapshot.purpose.type
    || row.purpose_target_digest !== snapshot.purpose.targetDigest
    || row.account_id !== snapshot.actor.accountId
    || row.session_id !== snapshot.actor.sessionId
    || row.device_id !== snapshot.actor.deviceId
    || row.user_handle_ref !== snapshot.userHandleRef
    || row.challenge_reference !== snapshot.challenge.reference
    || row.challenge_digest !== snapshot.challenge.digest
    || row.state !== snapshot.state
    || row.revision !== snapshot.revision
    || row.attempts_used !== snapshot.attemptsUsed
    || row.max_attempts !== snapshot.maxAttempts
    || row.expires_at_ms !== snapshot.expiresAtMs
    || row.updated_at_ms !== snapshot.updatedAtMs
  ) {
    passkeyIntegrityFailure();
  }
  return snapshot;
}

function mapPasskeyReceipt<T extends CommandReceipt | CreationReceipt>(
  row: PasskeyReceiptRow,
  expectedScope: string
): T {
  const snapshot = parsePasskeySnapshot(row.result_snapshot_json);
  if (
    row.scope !== expectedScope
    || !isPasskeyDigest(row.fingerprint)
    || row.ceremony_id !== snapshot.ceremonyId
    || row.result_revision !== snapshot.revision
    || row.created_at_ms !== snapshot.updatedAtMs
    || !isPasskeyOpaqueId(row.event_id)
    || row.linked_event_id !== row.event_id
    || row.linked_ceremony_id !== row.ceremony_id
    || row.linked_revision !== row.result_revision
  ) {
    passkeyIntegrityFailure();
  }
  return {
    scope: row.scope,
    fingerprint: row.fingerprint,
    result: {
      ceremonyId: row.ceremony_id,
      revision: row.result_revision,
      eventId: row.event_id,
      snapshot
    },
    createdAtMs: row.created_at_ms
  } as T;
}

function immutablePasskeyCeremonyFingerprint(snapshot: CeremonyAggregate): string {
  return canonicalPasskeyJson({
    schemaVersion: snapshot.schemaVersion,
    ceremonyId: snapshot.ceremonyId,
    kind: snapshot.kind,
    purpose: snapshot.purpose,
    actor: snapshot.actor,
    policyVersion: snapshot.policyVersion,
    expectedRpId: snapshot.expectedRpId,
    expectedOrigin: snapshot.expectedOrigin,
    timeoutMs: snapshot.timeoutMs,
    maxResponseBytes: snapshot.maxResponseBytes,
    userVerification: snapshot.userVerification,
    crossOriginAllowed: snapshot.crossOriginAllowed,
    expectedTopOrigins: snapshot.expectedTopOrigins,
    attestation: snapshot.attestation,
    registrationResidentKey: snapshot.registrationResidentKey,
    allowedAlgorithms: snapshot.allowedAlgorithms,
    credentialBoundary: snapshot.credentialBoundary,
    userHandleRef: snapshot.userHandleRef,
    challenge: snapshot.challenge,
    maxAttempts: snapshot.maxAttempts,
    createdAtMs: snapshot.createdAtMs,
    expiresAtMs: snapshot.expiresAtMs
  });
}

function assertPasskeyMutationShape(input: PersistCeremonyMutation): void {
  const { snapshot, event, outbox } = input.mutation;
  try {
    assertCeremonyInvariants(snapshot);
    assertCeremonyEventInvariants(event);
  } catch {
    passkeyIntegrityFailure();
  }
  const expectedPayload = {
    schemaVersion: snapshot.schemaVersion,
    type: event.type,
    ceremonyId: snapshot.ceremonyId,
    kind: snapshot.kind,
    purpose: snapshot.purpose.type,
    state: snapshot.state,
    revision: snapshot.revision,
    attemptsUsed: snapshot.attemptsUsed,
    riskSignals: snapshot.riskSignals,
    occurredAtMs: event.occurredAtMs
  };
  const expectedResult = {
    ceremonyId: snapshot.ceremonyId,
    revision: snapshot.revision,
    eventId: event.eventId,
    snapshot
  };
  if (
    canonicalPasskeyJson(event.snapshot) !== canonicalPasskeyJson(snapshot)
    || outbox.schemaVersion !== snapshot.schemaVersion
    || !isPasskeyOpaqueId(outbox.outboxId)
    || outbox.topic !== "luxora.passkey-ceremony.v1"
    || outbox.partitionKey !== snapshot.ceremonyId
    || outbox.eventId !== event.eventId
    || outbox.availableAtMs !== event.occurredAtMs
    || canonicalPasskeyJson(outbox.payload) !== canonicalPasskeyJson(expectedPayload)
    || !isPasskeyOpaqueId(input.commandReceipt.scope)
    || !isPasskeyDigest(input.commandReceipt.fingerprint)
    || input.commandReceipt.createdAtMs !== snapshot.updatedAtMs
    || canonicalPasskeyJson(input.commandReceipt.result) !== canonicalPasskeyJson(expectedResult)
  ) {
    passkeyIntegrityFailure();
  }
  if (input.creationReceipt !== null && (
    input.expectedRevision !== null
    || snapshot.revision !== 1
    || !isPasskeyOpaqueId(input.creationReceipt.scope)
    || !isPasskeyDigest(input.creationReceipt.fingerprint)
    || input.creationReceipt.createdAtMs !== snapshot.updatedAtMs
    || canonicalPasskeyJson(input.creationReceipt.result) !== canonicalPasskeyJson(expectedResult)
  )) {
    passkeyIntegrityFailure();
  }
  if ((input.expectedRevision === null) !== (input.creationReceipt !== null)) {
    passkeyIntegrityFailure();
  }
}

function assertPasskeyLoginReceiptShape(receipt: PasskeyLoginReceiptRecord): void {
  if (
    !hasExactPasskeyKeys(receipt, [
      "scope",
      "fingerprint",
      "intentId",
      "resultRevision",
      "resultState",
      "eventId",
      "createdAtMs"
    ])
    || !isPasskeyOpaqueId(receipt.scope)
    || !isPasskeyDigest(receipt.fingerprint)
    || !isCanonicalPasskeyId(receipt.intentId)
    || !isPasskeySafeInteger(receipt.resultRevision, 1)
    || !isPasskeyLoginState(receipt.resultState)
    || !isPasskeyOpaqueId(receipt.eventId)
    || !isPasskeySafeInteger(receipt.createdAtMs)
  ) {
    passkeyIntegrityFailure();
  }
}

function passkeyLoginEventMatchesState(
  type: PasskeyLoginMutationRecord["event"]["type"],
  state: PasskeyLoginIntentState
): boolean {
  if (type === "passkey.login.started") return state === "pending";
  if (type === "passkey.login.verification_rejected") return state === "pending";
  if (type === "passkey.login.consumed") return state === "consumed";
  if (type === "passkey.login.cancelled") return state === "cancelled";
  if (type === "passkey.login.expired") return state === "expired";
  return type === "passkey.login.attempts_exhausted" && state === "rejected";
}

function assertPasskeyLoginMutationShape(input: PasskeyLoginMutationRecord): void {
  const { event, outbox, commandReceipt } = input;
  assertPasskeyLoginReceiptShape(commandReceipt);
  if (
    !hasExactPasskeyKeys(event, [
      "eventId",
      "intentId",
      "revision",
      "type",
      "commandScope",
      "occurredAtMs",
      "state"
    ])
    || !hasExactPasskeyKeys(outbox, [
      "outboxId",
      "topic",
      "partitionKey",
      "eventId",
      "availableAtMs"
    ])
    || !isPasskeyOpaqueId(event.eventId)
    || !isCanonicalPasskeyId(event.intentId)
    || !isPasskeySafeInteger(event.revision, 1)
    || !isPasskeyOpaqueId(event.commandScope)
    || !isPasskeySafeInteger(event.occurredAtMs)
    || !isPasskeyLoginState(event.state)
    || !passkeyLoginEventMatchesState(event.type, event.state)
    || !isPasskeyOpaqueId(outbox.outboxId)
    || outbox.topic !== "luxora.passkey-login.v1"
    || outbox.partitionKey !== event.intentId
    || outbox.eventId !== event.eventId
    || outbox.availableAtMs !== event.occurredAtMs
    || commandReceipt.scope !== event.commandScope
    || commandReceipt.intentId !== event.intentId
    || commandReceipt.resultRevision !== event.revision
    || commandReceipt.resultState !== event.state
    || commandReceipt.eventId !== event.eventId
    || commandReceipt.createdAtMs !== event.occurredAtMs
  ) {
    passkeyIntegrityFailure();
  }
}

function assertNewPasskeyLoginIntentShape(intent: NewPasskeyLoginIntent): void {
  if (
    !hasExactPasskeyKeys(intent, [
      "intentId",
      "schemaVersion",
      "purpose",
      "policyVersion",
      "accessTokenTtlSeconds",
      "sessionTtlSeconds",
      "recoveryGraceSeconds",
      "expectedRpId",
      "expectedOrigin",
      "timeoutMs",
      "maxResponseBytes",
      "maxAttempts",
      "allowedAlgorithms",
      "userVerification",
      "crossOriginAllowed",
      "credentialBoundary",
      "challenge",
      "deliveryNonceDigest",
      "refreshDerivationKeyId",
      "state",
      "revision",
      "attemptsUsed",
      "createdAtMs",
      "expiresAtMs",
      "updatedAtMs",
      "terminalAtMs",
      "terminalReason"
    ])
    || !hasExactPasskeyKeys(intent.purpose, ["type", "targetDigest"])
    || !hasExactPasskeyKeys(intent.credentialBoundary, ["mode", "credentialSetRef"])
    || !hasExactPasskeyKeys(intent.challenge, ["reference", "digest"])
    || !isCanonicalPasskeyId(intent.intentId)
    || intent.schemaVersion !== 1
    || intent.purpose.type !== "session.create"
    || !isPasskeyDigest(intent.purpose.targetDigest)
    || intent.policyVersion !== 1
    || !isPasskeySafeInteger(intent.accessTokenTtlSeconds, 60, 3_600)
    || !isPasskeySafeInteger(intent.sessionTtlSeconds, 86_400, 31_536_000)
    || !isPasskeySafeInteger(intent.recoveryGraceSeconds, 0, 300)
    || intent.expectedRpId !== "auth.luxora.app"
    || intent.expectedOrigin !== "https://auth.luxora.app"
    || !isPasskeySafeInteger(intent.timeoutMs, 300_000, 600_000)
    || !isPasskeySafeInteger(intent.maxResponseBytes, 1, 65_536)
    || !isPasskeySafeInteger(intent.maxAttempts, 1, 5)
    || !isExactPasskeyAlgorithmTuple(intent.allowedAlgorithms)
    || intent.userVerification !== "required"
    || intent.crossOriginAllowed !== false
    || intent.credentialBoundary.mode !== "discoverable_any"
    || intent.credentialBoundary.credentialSetRef !== null
    || !isPasskeyOpaqueId(intent.challenge.reference)
    || !isPasskeyDigest(intent.challenge.digest)
    || !isPasskeyDigest(intent.deliveryNonceDigest)
    || !isPasskeyLoginRefreshKeyId(intent.refreshDerivationKeyId)
    || intent.state !== "pending"
    || intent.revision !== 1
    || intent.attemptsUsed !== 0
    || !isPasskeySafeInteger(intent.createdAtMs)
    || intent.updatedAtMs !== intent.createdAtMs
    || intent.createdAtMs > Number.MAX_SAFE_INTEGER - intent.timeoutMs
    || intent.expiresAtMs !== intent.createdAtMs + intent.timeoutMs
    || intent.accessTokenTtlSeconds < Math.ceil(intent.expiresAtMs / 1_000)
      - Math.floor(intent.createdAtMs / 1_000) + intent.recoveryGraceSeconds
    || intent.terminalAtMs !== null
    || intent.terminalReason !== null
  ) {
    passkeyIntegrityFailure();
  }
}

function assertPasskeyLoginBeginShape(input: PersistPasskeyLoginBegin): void {
  try {
    if (!hasExactPasskeyKeys(input, [
      "intent",
      "event",
      "outbox",
      "commandReceipt",
      "creationReceipt"
    ])) passkeyIntegrityFailure();
    assertNewPasskeyLoginIntentShape(input.intent);
    assertPasskeyLoginMutationShape(input);
    assertPasskeyLoginReceiptShape(input.creationReceipt);
    if (
      input.event.type !== "passkey.login.started"
      || input.event.intentId !== input.intent.intentId
      || input.event.revision !== 1
      || input.event.state !== "pending"
      || input.event.occurredAtMs !== input.intent.createdAtMs
      || input.creationReceipt.intentId !== input.intent.intentId
      || input.creationReceipt.resultRevision !== 1
      || input.creationReceipt.resultState !== "pending"
      || input.creationReceipt.eventId !== input.event.eventId
      || input.creationReceipt.createdAtMs !== input.intent.createdAtMs
    ) {
      passkeyIntegrityFailure();
    }
  } catch {
    passkeyIntegrityFailure();
  }
}

function assertPasskeyLoginRejectedShape(input: PersistPasskeyLoginRejectedAttempt): void {
  try {
    if (!hasExactPasskeyKeys(input, [
      "intentId",
      "expectedRevision",
      "updatedAtMs",
      "nextState",
      "event",
      "outbox",
      "commandReceipt"
    ])) passkeyIntegrityFailure();
    assertPasskeyLoginMutationShape(input);
    if (
      !isCanonicalPasskeyId(input.intentId)
      || !isPasskeySafeInteger(input.expectedRevision, 1)
      || !isPasskeySafeInteger(input.updatedAtMs)
      || (input.nextState !== "pending" && input.nextState !== "rejected")
      || input.event.intentId !== input.intentId
      || input.event.revision !== input.expectedRevision + 1
      || input.event.occurredAtMs !== input.updatedAtMs
      || input.event.state !== input.nextState
      || input.event.type !== (
        input.nextState === "pending"
          ? "passkey.login.verification_rejected"
          : "passkey.login.attempts_exhausted"
      )
    ) {
      passkeyIntegrityFailure();
    }
  } catch {
    passkeyIntegrityFailure();
  }
}

function assertPasskeyLoginTerminalShape(input: PersistPasskeyLoginTerminal): void {
  try {
    if (!hasExactPasskeyKeys(input, [
      "intentId",
      "expectedRevision",
      "terminalAtMs",
      "nextState",
      "event",
      "outbox",
      "commandReceipt"
    ])) passkeyIntegrityFailure();
    assertPasskeyLoginMutationShape(input);
    if (
      !isCanonicalPasskeyId(input.intentId)
      || !isPasskeySafeInteger(input.expectedRevision, 1)
      || !isPasskeySafeInteger(input.terminalAtMs)
      || (input.nextState !== "cancelled" && input.nextState !== "expired")
      || input.event.intentId !== input.intentId
      || input.event.revision !== input.expectedRevision + 1
      || input.event.occurredAtMs !== input.terminalAtMs
      || input.event.state !== input.nextState
      || input.event.type !== (input.nextState === "cancelled"
        ? "passkey.login.cancelled"
        : "passkey.login.expired")
    ) {
      passkeyIntegrityFailure();
    }
  } catch {
    passkeyIntegrityFailure();
  }
}

function assertVerifiedPasskeyLoginShape(input: PersistVerifiedPasskeyLogin): void {
  try {
    if (
      !hasExactPasskeyKeys(input, [
        "intentId",
        "expectedRevision",
        "committedAtMs",
        "credential",
        "session",
        "refreshToken",
        "accessToken",
        "event",
        "outbox",
        "commandReceipt"
      ])
      || !hasExactPasskeyKeys(input.credential, [
        "accountId",
        "userHandleRef",
        "credentialRecordId",
        "credentialRevision",
        "algorithm",
        "discoveryMode",
        "previousSignCount",
        "newSignCount",
        "previousBackupEligible",
        "backupEligible",
        "previousBackupState",
        "backupState",
        "userHandleBindingVerified",
        "userPresent",
        "userVerified"
      ])
      || !hasExactPasskeyKeys(input.session, [
        "id",
        "userId",
        "deviceName",
        "createdAt",
        "expiresAt"
      ])
      || !hasExactPasskeyKeys(input.refreshToken, [
        "id",
        "sessionId",
        "tokenHash",
        "createdAt",
        "expiresAt",
        "derivationKeyId",
        "deliveryNonceDigest"
      ])
      || !hasExactPasskeyKeys(input.accessToken, [
        "tokenId",
        "issuedAtSec",
        "expiresAtSec"
      ])
    ) {
      passkeyIntegrityFailure();
    }
    assertPasskeyLoginMutationShape(input);
    const credential = input.credential;
    const sessionCreatedAtMs = passkeyIsoTimestampMs(input.session.createdAt);
    const sessionExpiresAtMs = passkeyIsoTimestampMs(input.session.expiresAt);
    const refreshCreatedAtMs = passkeyIsoTimestampMs(input.refreshToken.createdAt);
    const refreshExpiresAtMs = passkeyIsoTimestampMs(input.refreshToken.expiresAt);
    if (
      !isCanonicalPasskeyId(input.intentId)
      || !isPasskeySafeInteger(input.expectedRevision, 1)
      || !isPasskeySafeInteger(input.committedAtMs)
      || input.event.intentId !== input.intentId
      || input.event.revision !== input.expectedRevision + 1
      || input.event.type !== "passkey.login.consumed"
      || input.event.state !== "consumed"
      || input.event.occurredAtMs !== input.committedAtMs
      || !isCanonicalPasskeyId(credential.accountId)
      || !isPasskeyOpaqueId(credential.userHandleRef)
      || !isPasskeyOpaqueId(credential.credentialRecordId)
      || !isPasskeySafeInteger(credential.credentialRevision, 1)
      || (credential.algorithm !== -7 && credential.algorithm !== -257)
      || credential.discoveryMode !== "discoverable"
      || !isPasskeySafeInteger(credential.previousSignCount, 0, 0xffff_ffff)
      || !isPasskeySafeInteger(credential.newSignCount, 0, 0xffff_ffff)
      || typeof credential.previousBackupEligible !== "boolean"
      || typeof credential.backupEligible !== "boolean"
      || typeof credential.previousBackupState !== "boolean"
      || typeof credential.backupState !== "boolean"
      || credential.previousBackupEligible !== credential.backupEligible
      || (!credential.backupEligible
        && (credential.previousBackupState || credential.backupState))
      || credential.userHandleBindingVerified !== true
      || credential.userPresent !== true
      || credential.userVerified !== true
      || !isCanonicalPasskeyId(input.session.id)
      || !isCanonicalPasskeyId(input.session.userId)
      || input.session.userId !== credential.accountId
      || typeof input.session.deviceName !== "string"
      || input.session.deviceName.length < 1
      || input.session.deviceName.length > 120
      || sessionCreatedAtMs !== input.committedAtMs
      || sessionExpiresAtMs === null
      || sessionExpiresAtMs - input.committedAtMs < 86_400_000
      || sessionExpiresAtMs - input.committedAtMs > 31_536_000_000
      || !isCanonicalPasskeyId(input.refreshToken.id)
      || !isCanonicalPasskeyId(input.refreshToken.sessionId)
      || input.refreshToken.sessionId !== input.session.id
      || !isCanonicalBase64Url(input.refreshToken.tokenHash, 32, 32)
      || refreshCreatedAtMs !== input.committedAtMs
      || refreshExpiresAtMs === null
      || refreshExpiresAtMs !== sessionExpiresAtMs
      || !isPasskeyLoginRefreshKeyId(input.refreshToken.derivationKeyId)
      || !isPasskeyDigest(input.refreshToken.deliveryNonceDigest)
      || !isCanonicalPasskeyId(input.accessToken.tokenId)
      || input.accessToken.tokenId !== input.intentId
      || input.accessToken.issuedAtSec !== Math.floor(input.committedAtMs / 1_000)
      || !isPasskeySafeInteger(input.accessToken.expiresAtSec)
      || input.accessToken.expiresAtSec <= input.accessToken.issuedAtSec
      || input.accessToken.expiresAtSec - input.accessToken.issuedAtSec < 60
      || input.accessToken.expiresAtSec - input.accessToken.issuedAtSec > 3_600
    ) {
      passkeyIntegrityFailure();
    }
  } catch {
    passkeyIntegrityFailure();
  }
}

function assertPasskeySignupReceiptShape(receipt: PasskeySignupReceiptRecord): void {
  if (
    !hasExactPasskeyKeys(receipt, [
      "scope", "fingerprint", "intentId", "resultRevision",
      "resultState", "eventId", "createdAtMs"
    ])
    || !isPasskeyOpaqueId(receipt.scope)
    || !isPasskeyDigest(receipt.fingerprint)
    || !isCanonicalPasskeyId(receipt.intentId)
    || !isPasskeySafeInteger(receipt.resultRevision, 1)
    || !isPasskeySignupState(receipt.resultState)
    || !isPasskeyOpaqueId(receipt.eventId)
    || !isPasskeySafeInteger(receipt.createdAtMs)
  ) passkeyIntegrityFailure();
}

function passkeySignupEventMatchesState(
  type: PasskeySignupMutationRecord["event"]["type"],
  state: PasskeySignupIntentState
): boolean {
  if (type === "passkey.signup.started") return state === "pending";
  if (type === "passkey.signup.verification_rejected") return state === "pending";
  if (type === "passkey.signup.consumed") return state === "consumed";
  if (type === "passkey.signup.expired") return state === "expired";
  return type === "passkey.signup.attempts_exhausted" && state === "rejected";
}

function assertPasskeySignupMutationShape(input: PasskeySignupMutationRecord): void {
  const { event, outbox, commandReceipt } = input;
  assertPasskeySignupReceiptShape(commandReceipt);
  if (
    !hasExactPasskeyKeys(event, [
      "eventId", "intentId", "revision", "type", "commandScope", "occurredAtMs", "state"
    ])
    || !hasExactPasskeyKeys(outbox, [
      "outboxId", "topic", "partitionKey", "eventId", "availableAtMs"
    ])
    || !isPasskeyOpaqueId(event.eventId)
    || !isCanonicalPasskeyId(event.intentId)
    || !isPasskeySafeInteger(event.revision, 1)
    || !isPasskeyOpaqueId(event.commandScope)
    || !isPasskeySafeInteger(event.occurredAtMs)
    || !isPasskeySignupState(event.state)
    || !passkeySignupEventMatchesState(event.type, event.state)
    || !isPasskeyOpaqueId(outbox.outboxId)
    || outbox.topic !== "luxora.passkey-signup.v1"
    || outbox.partitionKey !== event.intentId
    || outbox.eventId !== event.eventId
    || outbox.availableAtMs !== event.occurredAtMs
    || commandReceipt.scope !== event.commandScope
    || commandReceipt.intentId !== event.intentId
    || commandReceipt.resultRevision !== event.revision
    || commandReceipt.resultState !== event.state
    || commandReceipt.eventId !== event.eventId
    || commandReceipt.createdAtMs !== event.occurredAtMs
  ) passkeyIntegrityFailure();
}

function assertNewPasskeySignupIntentShape(intent: NewPasskeySignupIntent): void {
  if (
    !hasExactPasskeyKeys(intent, [
      "intentId", "schemaVersion", "purpose", "policyVersion", "rpName",
      "expectedRpId", "expectedOrigin", "expectedTopOrigins", "timeoutMs", "maxResponseBytes", "maxAttempts",
      "allowedAlgorithms", "requireUserPresence", "userVerification", "residentKey",
      "attestation", "crossOriginAllowed", "excludeCredentials", "candidate", "challenge",
      "deliveryNonceDigest",
      "state", "revision", "attemptsUsed", "createdAtMs", "expiresAtMs", "updatedAtMs",
      "terminalAtMs", "terminalReason", "resolvedCredentialRecordId"
    ])
    || !hasExactPasskeyKeys(intent.purpose, ["type", "targetDigest"])
    || !hasExactPasskeyKeys(intent.candidate, [
      "accountId", "username", "usernameNormalized", "displayName", "userHandleRef", "userHandle"
    ])
    || !hasExactPasskeyKeys(intent.challenge, ["reference", "digest"])
    || !isCanonicalPasskeyId(intent.intentId)
    || intent.schemaVersion !== 1
    || intent.purpose.type !== "account.create"
    || !isPasskeyDigest(intent.purpose.targetDigest)
    || intent.policyVersion !== 1
    || intent.rpName !== "Luxora"
    || intent.expectedRpId !== "auth.luxora.app"
    || intent.expectedOrigin !== "https://auth.luxora.app"
    || !isExactPasskeyEmptyTuple(intent.expectedTopOrigins)
    || !isPasskeySafeInteger(intent.timeoutMs, 300_000, 600_000)
    || !isPasskeySafeInteger(intent.maxResponseBytes, 1, 65_536)
    || !isPasskeySafeInteger(intent.maxAttempts, 1, 5)
    || !isExactPasskeyAlgorithmTuple(intent.allowedAlgorithms)
    || intent.requireUserPresence !== true
    || intent.userVerification !== "required"
    || intent.residentKey !== "required"
    || intent.attestation !== "none"
    || intent.crossOriginAllowed !== false
    || !isExactPasskeyEmptyTuple(intent.excludeCredentials)
    || !isCanonicalPasskeyId(intent.candidate.accountId)
    || typeof intent.candidate.username !== "string"
    || !PASSKEY_SIGNUP_USERNAME_PATTERN.test(intent.candidate.username)
    || intent.candidate.usernameNormalized !== intent.candidate.username.toLowerCase()
    || !PASSKEY_SIGNUP_USERNAME_PATTERN.test(intent.candidate.usernameNormalized)
    || typeof intent.candidate.displayName !== "string"
    || intent.candidate.displayName.length < 1
    || intent.candidate.displayName.length > 80
    || intent.candidate.displayName.trim() !== intent.candidate.displayName
    || intent.candidate.displayName.normalize("NFC") !== intent.candidate.displayName
    || !isPasskeyOpaqueId(intent.candidate.userHandleRef)
    || !isExactPasskeyUserHandleBytes(intent.candidate.userHandle)
    || !isPasskeyOpaqueId(intent.challenge.reference)
    || !isPasskeyDigest(intent.challenge.digest)
    || !isPasskeyDigest(intent.deliveryNonceDigest)
    || intent.state !== "pending"
    || intent.revision !== 1
    || intent.attemptsUsed !== 0
    || !isPasskeySafeInteger(intent.createdAtMs)
    || intent.updatedAtMs !== intent.createdAtMs
    || intent.createdAtMs > Number.MAX_SAFE_INTEGER - intent.timeoutMs
    || intent.expiresAtMs !== intent.createdAtMs + intent.timeoutMs
    || intent.terminalAtMs !== null
    || intent.terminalReason !== null
    || intent.resolvedCredentialRecordId !== null
  ) passkeyIntegrityFailure();
}

function assertPasskeySignupBeginShape(input: PersistPasskeySignupBegin): void {
  try {
    if (!hasExactPasskeyKeys(input, [
      "intent", "event", "outbox", "commandReceipt", "creationReceipt"
    ])) passkeyIntegrityFailure();
    assertNewPasskeySignupIntentShape(input.intent);
    assertPasskeySignupMutationShape(input);
    assertPasskeySignupReceiptShape(input.creationReceipt);
    if (
      input.event.type !== "passkey.signup.started"
      || input.event.intentId !== input.intent.intentId
      || input.event.revision !== 1
      || input.event.state !== "pending"
      || input.event.occurredAtMs !== input.intent.createdAtMs
      || input.creationReceipt.intentId !== input.intent.intentId
      || input.creationReceipt.resultRevision !== 1
      || input.creationReceipt.resultState !== "pending"
      || input.creationReceipt.eventId !== input.event.eventId
      || input.creationReceipt.createdAtMs !== input.intent.createdAtMs
    ) passkeyIntegrityFailure();
  } catch {
    passkeyIntegrityFailure();
  }
}

function assertPasskeySignupRejectedShape(input: PersistPasskeySignupRejectedAttempt): void {
  try {
    if (!hasExactPasskeyKeys(input, [
      "intentId", "expectedRevision", "updatedAtMs", "nextState",
      "event", "outbox", "commandReceipt"
    ])) passkeyIntegrityFailure();
    assertPasskeySignupMutationShape(input);
    if (
      !isCanonicalPasskeyId(input.intentId)
      || !isPasskeySafeInteger(input.expectedRevision, 1)
      || !isPasskeySafeInteger(input.updatedAtMs)
      || (input.nextState !== "pending" && input.nextState !== "rejected")
      || input.event.intentId !== input.intentId
      || input.event.revision !== input.expectedRevision + 1
      || input.event.occurredAtMs !== input.updatedAtMs
      || input.event.state !== input.nextState
      || input.event.type !== (input.nextState === "pending"
        ? "passkey.signup.verification_rejected"
        : "passkey.signup.attempts_exhausted")
    ) passkeyIntegrityFailure();
  } catch {
    passkeyIntegrityFailure();
  }
}

function assertPasskeySignupExpiredShape(input: PersistPasskeySignupExpired): void {
  try {
    if (!hasExactPasskeyKeys(input, [
      "intentId", "expectedRevision", "terminalAtMs", "nextState",
      "event", "outbox", "commandReceipt"
    ])) passkeyIntegrityFailure();
    assertPasskeySignupMutationShape(input);
    if (
      !isCanonicalPasskeyId(input.intentId)
      || !isPasskeySafeInteger(input.expectedRevision, 1)
      || !isPasskeySafeInteger(input.terminalAtMs)
      || input.nextState !== "expired"
      || input.event.intentId !== input.intentId
      || input.event.revision !== input.expectedRevision + 1
      || input.event.occurredAtMs !== input.terminalAtMs
      || input.event.state !== "expired"
      || input.event.type !== "passkey.signup.expired"
    ) passkeyIntegrityFailure();
  } catch {
    passkeyIntegrityFailure();
  }
}

function assertVerifiedPasskeySignupShape(input: PersistVerifiedPasskeySignup): void {
  try {
    if (
      !hasExactPasskeyKeys(input, [
        "intentId", "expectedRevision", "committedAtMs", "candidate", "credential",
        "passwordAuth", "session", "refreshToken", "accessToken",
        "event", "outbox", "commandReceipt"
      ])
      || !hasExactPasskeyKeys(input.candidate, [
        "accountId", "username", "usernameNormalized", "displayName",
        "userHandleRef", "userHandle"
      ])
      || !hasExactPasskeyKeys(input.credential, [
        "credentialRecordId", "credentialId", "publicKey", "algorithm", "discoveryMode",
        "signCount", "backupEligible", "backupState", "transports",
        "userPresent", "userVerified"
      ])
      || !hasExactPasskeyKeys(input.passwordAuth, ["enabled", "disabledHash"])
      || !hasExactPasskeyKeys(input.session, [
        "id", "userId", "deviceName", "createdAt", "expiresAt"
      ])
      || !hasExactPasskeyKeys(input.refreshToken, [
        "id", "sessionId", "tokenHash", "createdAt", "expiresAt",
        "derivationKeyId", "deliveryNonceDigest"
      ])
      || !hasExactPasskeyKeys(input.accessToken, [
        "tokenId", "issuedAtSec", "expiresAtSec"
      ])
    ) passkeyIntegrityFailure();
    assertPasskeySignupMutationShape(input);
    const candidate = input.candidate;
    const credential = input.credential;
    const sessionCreatedAtMs = passkeyIsoTimestampMs(input.session.createdAt);
    const sessionExpiresAtMs = passkeyIsoTimestampMs(input.session.expiresAt);
    const refreshCreatedAtMs = passkeyIsoTimestampMs(input.refreshToken.createdAt);
    const refreshExpiresAtMs = passkeyIsoTimestampMs(input.refreshToken.expiresAt);
    if (
      !isCanonicalPasskeyId(input.intentId)
      || !isPasskeySafeInteger(input.expectedRevision, 1)
      || !isPasskeySafeInteger(input.committedAtMs)
      || input.event.intentId !== input.intentId
      || input.event.revision !== input.expectedRevision + 1
      || input.event.type !== "passkey.signup.consumed"
      || input.event.state !== "consumed"
      || input.event.occurredAtMs !== input.committedAtMs
      || !isCanonicalPasskeyId(candidate.accountId)
      || typeof candidate.username !== "string"
      || !PASSKEY_SIGNUP_USERNAME_PATTERN.test(candidate.username)
      || candidate.usernameNormalized !== candidate.username.toLowerCase()
      || !PASSKEY_SIGNUP_USERNAME_PATTERN.test(candidate.usernameNormalized)
      || typeof candidate.displayName !== "string"
      || candidate.displayName.length < 1
      || candidate.displayName.length > 80
      || candidate.displayName.trim() !== candidate.displayName
      || candidate.displayName.normalize("NFC") !== candidate.displayName
      || !isPasskeyOpaqueId(candidate.userHandleRef)
      || !isExactPasskeyUserHandleBytes(candidate.userHandle)
      || !isPasskeyOpaqueId(credential.credentialRecordId)
      || !isCanonicalBase64Url(credential.credentialId)
      || !isExactPasskeyPublicKeyBytes(credential.publicKey)
      || (credential.algorithm !== -7 && credential.algorithm !== -257)
      || credential.discoveryMode !== "discoverable"
      || !isPasskeySafeInteger(credential.signCount, 0, 0xffff_ffff)
      || typeof credential.backupEligible !== "boolean"
      || typeof credential.backupState !== "boolean"
      || (!credential.backupEligible && credential.backupState)
      || !isExactPasskeyTransports(credential.transports)
      || credential.userPresent !== true
      || credential.userVerified !== true
      || input.passwordAuth.enabled !== false
      || typeof input.passwordAuth.disabledHash !== "string"
      || !PASSKEY_DISABLED_PASSWORD_HASH_PATTERN.test(input.passwordAuth.disabledHash)
      || !isCanonicalPasskeyId(input.session.id)
      || input.session.userId !== candidate.accountId
      || typeof input.session.deviceName !== "string"
      || input.session.deviceName.length < 1
      || input.session.deviceName.length > 120
      || sessionCreatedAtMs !== input.committedAtMs
      || sessionExpiresAtMs === null
      || sessionExpiresAtMs - input.committedAtMs < 86_400_000
      || sessionExpiresAtMs - input.committedAtMs > 31_536_000_000
      || !isCanonicalPasskeyId(input.refreshToken.id)
      || input.refreshToken.sessionId !== input.session.id
      || !isCanonicalBase64Url(input.refreshToken.tokenHash, 32, 32)
      || refreshCreatedAtMs !== input.committedAtMs
      || refreshExpiresAtMs !== sessionExpiresAtMs
      || !isPasskeyLoginRefreshKeyId(input.refreshToken.derivationKeyId)
      || !isPasskeyDigest(input.refreshToken.deliveryNonceDigest)
      || input.accessToken.tokenId !== input.intentId
      || input.accessToken.issuedAtSec !== Math.floor(input.committedAtMs / 1_000)
      || !isPasskeySafeInteger(input.accessToken.expiresAtSec)
      || input.accessToken.expiresAtSec <= input.accessToken.issuedAtSec
      || input.accessToken.expiresAtSec - input.accessToken.issuedAtSec < 60
      || input.accessToken.expiresAtSec - input.accessToken.issuedAtSec > 3_600
      || input.accessToken.expiresAtSec > Math.floor(sessionExpiresAtMs / 1_000)
    ) passkeyIntegrityFailure();
  } catch {
    passkeyIntegrityFailure();
  }
}

function latestTimestamp(first: string, ...rest: Array<string | null | undefined>): string {
  return rest.reduce<string>((latest, candidate) =>
    candidate !== null && candidate !== undefined && candidate > latest ? candidate : latest,
  first);
}

const WAL_BOOTSTRAP_RETRY_DELAY_MS = 10;
const WAL_BOOTSTRAP_RETRY_WINDOW_MS = 5_000;
const walBootstrapWait = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));

function enableWalWithBoundedBusyRetry(database: Database.Database, databasePath: string): void {
  const deadline = performance.now() + WAL_BOOTSTRAP_RETRY_WINDOW_MS;
  while (true) {
    try {
      const mode = database.pragma("journal_mode = WAL", { simple: true }) as string;
      if (databasePath !== ":memory:" && mode.toLowerCase() !== "wal") {
        throw new Error(`SQLite refused WAL mode and returned '${mode}'`);
      }
      return;
    } catch (error) {
      const busy = typeof error === "object" && error !== null && "code" in error && error.code === "SQLITE_BUSY";
      const remainingMs = deadline - performance.now();
      if (!busy || remainingMs <= 0) throw error;
      Atomics.wait(
        walBootstrapWait,
        0,
        0,
        Math.min(WAL_BOOTSTRAP_RETRY_DELAY_MS, remainingMs)
      );
    }
  }
}

export class SqliteStore implements Store {
  readonly #db: Database.Database;

  constructor(
    databasePath: string,
    private readonly contentCipher: ContentCipher = new PlaintextContentCipher(),
    private readonly passkeyNowMs: () => number = Date.now,
    private readonly syncInvalidationEnabled = true
  ) {
    if (databasePath !== ":memory:") {
      mkdirSync(dirname(resolve(databasePath)), { recursive: true });
    }
    this.#db = new Database(databasePath);
    try {
      // Keep each WAL bootstrap attempt shorter than the monotonic retry window;
      // the regular transaction wait policy is restored immediately afterwards.
      this.#db.pragma(`busy_timeout = ${WAL_BOOTSTRAP_RETRY_DELAY_MS}`);
      this.#db.pragma("foreign_keys = ON");
      enableWalWithBoundedBusyRetry(this.#db, databasePath);
      this.#db.pragma("busy_timeout = 5000");
      this.#db.pragma("synchronous = NORMAL");
      this.#migrate();
      this.#backfillPasskeyAuthenticatorMetadata();
    } catch (error) {
      this.#db.close();
      throw error;
    }
  }

  #migrate(): void {
    this.#db.transaction(() => {
      this.#db.exec(`
        CREATE TABLE IF NOT EXISTS schema_migrations (
          id TEXT PRIMARY KEY,
          applied_at TEXT NOT NULL
        ) STRICT;
      `);
    }).immediate();
    for (const migration of migrations) {
      this.#db.transaction(() => {
        const applied = this.#db.prepare(`
          SELECT 1 AS applied FROM schema_migrations WHERE id = ?
        `).get(migration.id) as { applied: number } | undefined;
        if (applied !== undefined) return;
        this.#db.exec(migration.sql);
        this.#db.prepare("INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)")
          .run(migration.id, new Date().toISOString());
      }).immediate();
    }
  }

  close(): void {
    this.#db.close();
  }

  ping(): boolean {
    const row = this.#db.prepare("SELECT 1 AS ok").get() as { ok: number };
    return row.ok === 1;
  }

  transaction<T>(operation: () => T): T {
    return this.#db.transaction(operation)();
  }

  immediateTransaction<T>(operation: () => T): T {
    return this.#db.transaction(operation).immediate();
  }

  #encryptPasskeyValue(plaintext: string, context: string): string {
    const ciphertext = this.contentCipher.encrypt(plaintext, context);
    if (!ciphertext.startsWith(PASSKEY_ENCRYPTED_ENVELOPE_PREFIX)) {
      throw new Error("Passkey repository requires authenticated encryption");
    }
    return ciphertext;
  }

  #mapPasskeyAuthenticatorMetadata(
    row: PasskeyAuthenticatorMetadataRow
  ): PasskeyAuthenticatorRecord {
    let displayName: string;
    try {
      if (!row.display_name_ciphertext.startsWith(PASSKEY_ENCRYPTED_ENVELOPE_PREFIX)) {
        passkeyIntegrityFailure();
      }
      displayName = this.contentCipher.decrypt(
        row.display_name_ciphertext,
        `passkey-authenticator-name:${row.credential_record_id}:${row.account_id}`
      );
    } catch {
      passkeyIntegrityFailure();
    }
    return freezePasskeyAuthenticatorRecord({
      credentialRecordId: row.credential_record_id,
      accountId: row.account_id,
      displayName,
      lifecycleState: row.lifecycle_state,
      revision: row.revision,
      createdAtMs: row.created_at_ms,
      updatedAtMs: row.updated_at_ms,
      revokedAtMs: row.revoked_at_ms
    });
  }

  #mapPasskeyAuthenticatorReceipt(
    row: PasskeyAuthenticatorReceiptRow
  ): PasskeyAuthenticatorCommandReceiptRecord {
    let result: PasskeyAuthenticatorRecord;
    try {
      if (!row.result_snapshot_ciphertext.startsWith(PASSKEY_ENCRYPTED_ENVELOPE_PREFIX)) {
        passkeyIntegrityFailure();
      }
      result = freezePasskeyAuthenticatorRecord(JSON.parse(this.contentCipher.decrypt(
        row.result_snapshot_ciphertext,
        `passkey-authenticator-receipt:${row.scope}`
      )) as unknown);
    } catch {
      passkeyIntegrityFailure();
    }
    if (
      !isPasskeyOpaqueId(row.scope)
      || !isPasskeyDigest(row.fingerprint)
      || !isPasskeyOpaqueId(row.credential_record_id)
      || !isPasskeyOpaqueId(row.account_id)
      || !isPasskeySafeInteger(row.result_revision, 2)
      || !isPasskeyOpaqueId(row.event_id)
      || !isPasskeySafeInteger(row.created_at_ms)
      || result.credentialRecordId !== row.credential_record_id
      || result.accountId !== row.account_id
      || result.revision !== row.result_revision
    ) passkeyIntegrityFailure();
    return Object.freeze({
      scope: row.scope,
      fingerprint: row.fingerprint,
      credentialRecordId: row.credential_record_id,
      accountId: row.account_id,
      resultRevision: row.result_revision,
      eventId: row.event_id,
      result,
      createdAtMs: row.created_at_ms
    });
  }

  #insertInitialPasskeyAuthenticatorMetadata(input: {
    readonly credentialRecordId: string;
    readonly accountId: string;
    readonly createdAtMs: number;
  }): void {
    if (
      !isPasskeyOpaqueId(input.credentialRecordId)
      || !isPasskeyOpaqueId(input.accountId)
      || !isPasskeySafeInteger(input.createdAtMs)
    ) passkeyIntegrityFailure();
    const bindingDigest = passkeyDigest(JSON.stringify([
      input.accountId,
      input.credentialRecordId,
      input.createdAtMs
    ]));
    const eventId = `authenticator-event:registered:${bindingDigest}`;
    const outboxId = `authenticator-outbox:registered:${bindingDigest}`;
    const commandScope = `system:authenticator-register:${bindingDigest}`;
    const fingerprint = passkeyDigest(JSON.stringify([
      "passkey.authenticator.registered",
      input.accountId,
      input.credentialRecordId,
      input.createdAtMs
    ]));
    const displayNameCiphertext = this.#encryptPasskeyValue(
      PASSKEY_AUTHENTICATOR_DEFAULT_DISPLAY_NAME,
      `passkey-authenticator-name:${input.credentialRecordId}:${input.accountId}`
    );
    this.#db.prepare(`
      INSERT INTO passkey_authenticator_metadata (
        credential_record_id, account_id, display_name_ciphertext, lifecycle_state,
        revision, created_at_ms, updated_at_ms, revoked_at_ms
      ) VALUES (?, ?, ?, 'active', 1, ?, ?, NULL)
    `).run(
      input.credentialRecordId,
      input.accountId,
      displayNameCiphertext,
      input.createdAtMs,
      input.createdAtMs
    );
    const event = {
      schemaVersion: 1,
      eventId,
      type: "passkey.authenticator.registered",
      accountId: input.accountId,
      authenticatorId: input.credentialRecordId,
      revision: 1,
      lifecycleState: "active",
      occurredAtMs: input.createdAtMs
    } as const;
    this.#db.prepare(`
      INSERT INTO passkey_authenticator_events (
        event_id, credential_record_id, account_id, revision, event_type,
        command_scope, fingerprint, occurred_at_ms, event_json
      ) VALUES (?, ?, ?, 1, 'passkey.authenticator.registered', ?, ?, ?, ?)
    `).run(
      eventId,
      input.credentialRecordId,
      input.accountId,
      commandScope,
      fingerprint,
      input.createdAtMs,
      JSON.stringify(event)
    );
    this.#db.prepare(`
      INSERT INTO passkey_authenticator_outbox (
        outbox_id, event_id, topic, partition_key, available_at_ms, payload_json
      ) VALUES (?, ?, 'luxora.passkey-authenticator.v1', ?, ?, ?)
    `).run(
      outboxId,
      eventId,
      input.accountId,
      input.createdAtMs,
      JSON.stringify(event)
    );
  }

  #backfillPasskeyAuthenticatorMetadata(): void {
    this.#db.transaction(() => {
      const rows = this.#db.prepare(`
        SELECT credentials.record_id, credentials.account_id, credentials.created_at_ms
        FROM passkey_credentials credentials
        LEFT JOIN passkey_authenticator_metadata metadata
          ON metadata.credential_record_id = credentials.record_id
        WHERE metadata.credential_record_id IS NULL
        ORDER BY credentials.created_at_ms ASC, credentials.record_id ASC
      `).all() as Array<{ record_id: string; account_id: string; created_at_ms: number }>;
      for (const row of rows) {
        this.#insertInitialPasskeyAuthenticatorMetadata({
          credentialRecordId: row.record_id,
          accountId: row.account_id,
          createdAtMs: row.created_at_ms
        });
      }
    }).immediate();
  }

  #mapPasskeyUserHandle(row: PasskeyUserHandleRow): PasskeyUserHandleBinding {
    let userHandle: string;
    try {
      if (!row.handle_ciphertext.startsWith(PASSKEY_ENCRYPTED_ENVELOPE_PREFIX)) {
        passkeyIntegrityFailure();
      }
      userHandle = this.contentCipher.decrypt(
        row.handle_ciphertext,
        `passkey-user-handle:${row.reference}:${row.account_id}`
      );
    } catch {
      passkeyIntegrityFailure();
    }
    if (
      !isPasskeyOpaqueId(row.reference)
      || !isPasskeyOpaqueId(row.account_id)
      || !isPasskeyDigest(row.handle_digest)
      || !isCanonicalBase64Url(userHandle, 32, 32)
      || passkeyDigest(userHandle) !== row.handle_digest
      || !isPasskeySafeInteger(row.created_at_ms)
    ) {
      passkeyIntegrityFailure();
    }
    return Object.freeze({
      reference: row.reference,
      accountId: row.account_id,
      userHandle,
      createdAtMs: row.created_at_ms
    });
  }

  #insertPasskeyUserHandleBinding(binding: PasskeyUserHandleBinding): void {
    assertPasskeyUserHandleBindingShape(binding);
    const handleCiphertext = this.#encryptPasskeyValue(
      binding.userHandle,
      `passkey-user-handle:${binding.reference}:${binding.accountId}`
    );
    this.#db.prepare(`
      INSERT INTO passkey_user_handles (
        reference, account_id, handle_digest, handle_ciphertext, created_at_ms
      ) VALUES (?, ?, ?, ?, ?)
    `).run(
      binding.reference,
      binding.accountId,
      passkeyDigest(binding.userHandle),
      handleCiphertext,
      binding.createdAtMs
    );
  }

  #mapPasskeyCredential(row: PasskeyCredentialRow): PasskeyCredentialRecord {
    let credentialId: string;
    let material: unknown;
    try {
      if (
        !row.credential_id_ciphertext.startsWith(PASSKEY_ENCRYPTED_ENVELOPE_PREFIX)
        || !row.credential_material_ciphertext.startsWith(PASSKEY_ENCRYPTED_ENVELOPE_PREFIX)
      ) {
        passkeyIntegrityFailure();
      }
      credentialId = this.contentCipher.decrypt(
        row.credential_id_ciphertext,
        `passkey-credential-id:${row.record_id}`
      );
      material = JSON.parse(this.contentCipher.decrypt(
        row.credential_material_ciphertext,
        `passkey-credential-material:${row.record_id}`
      )) as unknown;
    } catch {
      passkeyIntegrityFailure();
    }
    if (
      material === null
      || typeof material !== "object"
      || Array.isArray(material)
      || Object.keys(material).sort().join(",")
        !== "accountId,algorithm,credentialSetRef,discoveryMode,publicKey,transports,userHandleRef"
    ) {
      passkeyIntegrityFailure();
    }
    const publicKeyEncoded = (material as { publicKey?: unknown }).publicKey;
    const transports = (material as { transports?: unknown }).transports;
    const materialRecord = material as Record<string, unknown>;
    const publicKey = typeof publicKeyEncoded === "string"
      ? Buffer.from(publicKeyEncoded, "base64url")
      : Buffer.alloc(0);
    if (
      !isPasskeyOpaqueId(row.record_id)
      || !isPasskeyDigest(row.credential_id_digest)
      || !isCanonicalBase64Url(credentialId)
      || passkeyDigest(credentialId) !== row.credential_id_digest
      || !isPasskeyOpaqueId(row.account_id)
      || !isPasskeyOpaqueId(row.user_handle_ref)
      || row.handle_account_id !== row.account_id
      || materialRecord["accountId"] !== row.account_id
      || materialRecord["userHandleRef"] !== row.user_handle_ref
      || materialRecord["algorithm"] !== row.algorithm
      || materialRecord["discoveryMode"] !== row.discovery_mode
      || materialRecord["credentialSetRef"] !== row.credential_set_ref
      || typeof publicKeyEncoded !== "string"
      || publicKey.byteLength < 1
      || publicKey.byteLength > 4_096
      || publicKey.toString("base64url") !== publicKeyEncoded
      || (row.algorithm !== -7 && row.algorithm !== -257)
      || (row.discovery_mode !== "discoverable" && row.discovery_mode !== "non_discoverable")
      || (row.discovery_mode === "discoverable" && row.credential_set_ref !== null)
      || (row.discovery_mode === "non_discoverable"
        && (row.credential_set_ref === null || !isPasskeyOpaqueId(row.credential_set_ref)))
      || !isPasskeySafeInteger(row.revision, 1)
      || !isPasskeySafeInteger(row.sign_count, 0, 0xffff_ffff)
      || (row.backup_eligible !== 0 && row.backup_eligible !== 1)
      || (row.backup_state !== 0 && row.backup_state !== 1)
      || (row.backup_eligible === 0 && row.backup_state === 1)
      || !Array.isArray(transports)
      || transports.length > PASSKEY_TRANSPORTS.size
      || new Set(transports).size !== transports.length
      || transports.some((transport) => typeof transport !== "string" || !PASSKEY_TRANSPORTS.has(transport))
      || !isPasskeyOpaqueId(row.registration_ceremony_id)
      || !isPasskeySafeInteger(row.created_at_ms)
      || !isPasskeySafeInteger(row.updated_at_ms, row.created_at_ms)
    ) {
      passkeyIntegrityFailure();
    }
    return Object.freeze({
      recordId: row.record_id,
      credentialId,
      accountId: row.account_id,
      userHandleRef: row.user_handle_ref,
      publicKey: new Uint8Array(publicKey),
      algorithm: row.algorithm,
      discoveryMode: row.discovery_mode,
      credentialSetRef: row.credential_set_ref,
      revision: row.revision,
      signCount: row.sign_count,
      backupEligible: row.backup_eligible === 1,
      backupState: row.backup_state === 1,
      transports: Object.freeze([...transports] as string[]),
      registrationCeremonyId: row.registration_ceremony_id,
      createdAtMs: row.created_at_ms,
      updatedAtMs: row.updated_at_ms
    });
  }

  async issue(input: {
    readonly byteLength: typeof PASSKEY_CHALLENGE_BYTES;
    readonly expiresAtMs: number;
  }): Promise<IssuedChallenge> {
    const nowMs = this.passkeyNowMs();
    if (
      input.byteLength !== PASSKEY_CHALLENGE_BYTES
      || !isPasskeySafeInteger(nowMs)
      || !isPasskeySafeInteger(input.expiresAtMs, nowMs + 1)
    ) {
      throw new RangeError("Invalid passkey challenge lease");
    }
    const reference = `challenge:${randomBytes(24).toString("base64url")}`;
    const challenge = randomBytes(PASSKEY_CHALLENGE_BYTES).toString("base64url");
    const challengeCiphertext = this.#encryptPasskeyValue(
      challenge,
      `passkey-challenge:${reference}`
    );
    this.#db.prepare(`
      INSERT INTO passkey_challenge_secrets (
        reference, challenge_ciphertext, expires_at_ms, created_at_ms
      ) VALUES (?, ?, ?, ?)
    `).run(reference, challengeCiphertext, input.expiresAtMs, nowMs);
    return Object.freeze({ reference, challenge });
  }

  async resolve(reference: string): Promise<string | null> {
    if (!isPasskeyOpaqueId(reference)) return null;
    const row = this.#db.prepare(`
      SELECT * FROM passkey_challenge_secrets WHERE reference = ?
    `).get(reference) as PasskeyChallengeRow | undefined;
    if (row === undefined) return null;
    const nowMs = this.passkeyNowMs();
    if (
      row.reference !== reference
      || !isPasskeySafeInteger(nowMs)
      || !isPasskeySafeInteger(row.created_at_ms)
      || !isPasskeySafeInteger(row.expires_at_ms, row.created_at_ms + 1)
    ) {
      passkeyIntegrityFailure();
    }
    if (nowMs >= row.expires_at_ms) {
      this.#db.prepare(`
        DELETE FROM passkey_challenge_secrets
        WHERE reference = ? AND expires_at_ms <= ?
      `).run(reference, nowMs);
      return null;
    }
    let challenge: string;
    try {
      if (!row.challenge_ciphertext.startsWith(PASSKEY_ENCRYPTED_ENVELOPE_PREFIX)) {
        passkeyIntegrityFailure();
      }
      challenge = this.contentCipher.decrypt(
        row.challenge_ciphertext,
        `passkey-challenge:${reference}`
      );
    } catch {
      passkeyIntegrityFailure();
    }
    if (!isCanonicalBase64Url(challenge, PASSKEY_CHALLENGE_BYTES, PASSKEY_CHALLENGE_BYTES)) {
      passkeyIntegrityFailure();
    }
    return challenge;
  }

  async discard(reference: string): Promise<void> {
    if (!isPasskeyOpaqueId(reference)) return;
    this.#db.prepare("DELETE FROM passkey_challenge_secrets WHERE reference = ?").run(reference);
  }

  async purgeExpiredPasskeyChallengeSecrets(nowMs: number, limit: number): Promise<number> {
    if (!isPasskeySafeInteger(nowMs) || !isPasskeySafeInteger(limit, 1, 1_000)) {
      throw new RangeError("Invalid passkey challenge cleanup bound");
    }
    const deleted = this.#db.prepare(`
      DELETE FROM passkey_challenge_secrets
      WHERE reference IN (
        SELECT reference
        FROM passkey_challenge_secrets
        WHERE expires_at_ms <= ?
        ORDER BY expires_at_ms ASC, reference ASC
        LIMIT ?
      )
    `).run(nowMs, limit);
    return deleted.changes;
  }

  async getOrCreatePasskeyUserHandleBinding(accountId: string): Promise<PasskeyUserHandleBinding> {
    if (!isPasskeyOpaqueId(accountId)) throw new Error("Invalid passkey account binding");
    return this.#db.transaction(() => {
      const existing = this.#db.prepare(`
        SELECT * FROM passkey_user_handles WHERE account_id = ?
      `).get(accountId) as PasskeyUserHandleRow | undefined;
      if (existing !== undefined) return this.#mapPasskeyUserHandle(existing);

      const createdAtMs = this.passkeyNowMs();
      if (!isPasskeySafeInteger(createdAtMs)) throw new Error("Invalid passkey repository clock");
      const binding = Object.freeze({
        reference: `user-handle:${randomBytes(24).toString("base64url")}`,
        accountId,
        userHandle: randomBytes(32).toString("base64url"),
        createdAtMs
      });
      this.#insertPasskeyUserHandleBinding(binding);
      return binding;
    }).immediate();
  }

  async preparePasskeyUserHandleBinding(accountId: string): Promise<PasskeyUserHandleBinding> {
    if (!isPasskeyOpaqueId(accountId)) throw new Error("Invalid passkey account binding");
    const existing = await this.findPasskeyUserHandleByAccountId(accountId);
    if (existing !== null) return existing;
    const createdAtMs = this.passkeyNowMs();
    if (!isPasskeySafeInteger(createdAtMs)) throw new Error("Invalid passkey repository clock");
    return Object.freeze({
      reference: `user-handle:${randomBytes(24).toString("base64url")}`,
      accountId,
      userHandle: randomBytes(32).toString("base64url"),
      createdAtMs
    });
  }

  async findPasskeyUserHandleByAccountId(accountId: string): Promise<PasskeyUserHandleBinding | null> {
    if (!isPasskeyOpaqueId(accountId)) return null;
    const row = this.#db.prepare(`
      SELECT * FROM passkey_user_handles WHERE account_id = ?
    `).get(accountId) as PasskeyUserHandleRow | undefined;
    return row === undefined ? null : this.#mapPasskeyUserHandle(row);
  }

  async findPasskeyUserHandleByRef(reference: string): Promise<PasskeyUserHandleBinding | null> {
    if (!isPasskeyOpaqueId(reference)) return null;
    const row = this.#db.prepare(`
      SELECT * FROM passkey_user_handles WHERE reference = ?
    `).get(reference) as PasskeyUserHandleRow | undefined;
    return row === undefined ? null : this.#mapPasskeyUserHandle(row);
  }

  async findPasskeyCredentialById(credentialId: string): Promise<PasskeyCredentialRecord | null> {
    if (!isCanonicalBase64Url(credentialId)) return null;
    const row = this.#db.prepare(`
      ${PASSKEY_CREDENTIAL_SELECT}
      WHERE credentials.credential_id_digest = ?
        AND EXISTS (
          SELECT 1 FROM passkey_authenticator_metadata metadata
          WHERE metadata.credential_record_id = credentials.record_id
            AND metadata.account_id = credentials.account_id
            AND metadata.lifecycle_state = 'active'
        )
    `).get(passkeyDigest(credentialId)) as PasskeyCredentialRow | undefined;
    if (row === undefined) return null;
    const record = this.#mapPasskeyCredential(row);
    if (record.credentialId !== credentialId) passkeyIntegrityFailure();
    return record;
  }

  async findPasskeyCredentialByRecordId(recordId: string): Promise<PasskeyCredentialRecord | null> {
    if (!isPasskeyOpaqueId(recordId)) return null;
    const row = this.#db.prepare(`
      ${PASSKEY_CREDENTIAL_SELECT}
      WHERE credentials.record_id = ?
        AND EXISTS (
          SELECT 1 FROM passkey_authenticator_metadata metadata
          WHERE metadata.credential_record_id = credentials.record_id
            AND metadata.account_id = credentials.account_id
            AND metadata.lifecycle_state = 'active'
        )
    `).get(recordId) as PasskeyCredentialRow | undefined;
    return row === undefined ? null : this.#mapPasskeyCredential(row);
  }

  async listPasskeyCredentialsByAccountId(
    accountId: string
  ): Promise<readonly PasskeyCredentialRecord[]> {
    if (!isPasskeyOpaqueId(accountId)) return Object.freeze([]);
    const rows = this.#db.prepare(`
      ${PASSKEY_CREDENTIAL_SELECT}
      WHERE credentials.account_id = ?
        AND EXISTS (
          SELECT 1 FROM passkey_authenticator_metadata metadata
          WHERE metadata.credential_record_id = credentials.record_id
            AND metadata.account_id = credentials.account_id
            AND metadata.lifecycle_state = 'active'
        )
      ORDER BY credentials.created_at_ms ASC, credentials.record_id ASC
      LIMIT ?
    `).all(accountId, PASSKEY_ACCOUNT_CREDENTIAL_LIMIT + 1) as PasskeyCredentialRow[];
    if (rows.length > PASSKEY_ACCOUNT_CREDENTIAL_LIMIT) passkeyIntegrityFailure();
    return Object.freeze(rows.map((row) => this.#mapPasskeyCredential(row)));
  }

  async findPasskeyAuthenticatorByRecordId(
    accountId: string,
    credentialRecordId: string
  ): Promise<PasskeyAuthenticatorRecord | null> {
    if (!isPasskeyOpaqueId(accountId) || !isPasskeyOpaqueId(credentialRecordId)) return null;
    const row = this.#db.prepare(`
      SELECT * FROM passkey_authenticator_metadata
      WHERE account_id = ? AND credential_record_id = ?
    `).get(accountId, credentialRecordId) as PasskeyAuthenticatorMetadataRow | undefined;
    return row === undefined ? null : this.#mapPasskeyAuthenticatorMetadata(row);
  }

  async listPasskeyAuthenticatorsByAccountId(
    accountId: string
  ): Promise<readonly PasskeyAuthenticatorRecord[]> {
    if (!isPasskeyOpaqueId(accountId)) return Object.freeze([]);
    const rows = this.#db.prepare(`
      SELECT * FROM passkey_authenticator_metadata
      WHERE account_id = ? AND lifecycle_state = 'active'
      ORDER BY created_at_ms ASC, credential_record_id ASC
      LIMIT ?
    `).all(accountId, PASSKEY_ACCOUNT_CREDENTIAL_LIMIT + 1) as PasskeyAuthenticatorMetadataRow[];
    if (rows.length > PASSKEY_ACCOUNT_CREDENTIAL_LIMIT) passkeyIntegrityFailure();
    return Object.freeze(rows.map((row) => this.#mapPasskeyAuthenticatorMetadata(row)));
  }

  async findPasskeyAuthenticatorCommandReceipt(
    scope: string
  ): Promise<PasskeyAuthenticatorCommandReceiptRecord | null> {
    if (!isPasskeyOpaqueId(scope)) return null;
    const row = this.#db.prepare(`
      SELECT * FROM passkey_authenticator_command_receipts WHERE scope = ?
    `).get(scope) as PasskeyAuthenticatorReceiptRow | undefined;
    return row === undefined ? null : this.#mapPasskeyAuthenticatorReceipt(row);
  }

  async findPasskeyAuthenticatorStepUpGrant(
    authenticationCeremonyId: string
  ): Promise<PasskeyAuthenticatorStepUpGrantRecord | null> {
    if (!isPasskeyOpaqueId(authenticationCeremonyId)) return null;
    const row = this.#db.prepare(`
      SELECT * FROM passkey_authenticator_step_up_grants
      WHERE authentication_ceremony_id = ?
    `).get(authenticationCeremonyId) as PasskeyAuthenticatorStepUpGrantRow | undefined;
    return row === undefined ? null : mapPasskeyAuthenticatorStepUpGrant(row);
  }

  async findPasskeyAuthenticatorRevokeIntent(
    authenticationCeremonyId: string
  ): Promise<PasskeyAuthenticatorRevokeIntentRecord | null> {
    if (!isPasskeyOpaqueId(authenticationCeremonyId)) return null;
    const row = this.#db.prepare(`
      SELECT * FROM passkey_authenticator_revoke_intents
      WHERE authentication_ceremony_id = ?
    `).get(authenticationCeremonyId) as PasskeyAuthenticatorRevokeIntentRow | undefined;
    return row === undefined ? null : mapPasskeyAuthenticatorRevokeIntent(row);
  }

  #insertPasskeyAuthenticatorMutationEvent(
    input: PersistPasskeyAuthenticatorRename | PersistPasskeyAuthenticatorRevoke,
    eventType: "passkey.authenticator.renamed" | "passkey.authenticator.revoked",
    revision: number,
    lifecycleState: "active" | "revoked"
  ): string {
    const event = {
      schemaVersion: 1,
      eventId: input.eventId,
      type: eventType,
      accountId: input.accountId,
      authenticatorId: input.credentialRecordId,
      revision,
      lifecycleState,
      occurredAtMs: input.occurredAtMs
    } as const;
    const eventJson = JSON.stringify(event);
    this.#db.prepare(`
      INSERT INTO passkey_authenticator_events (
        event_id, credential_record_id, account_id, revision, event_type,
        command_scope, fingerprint, occurred_at_ms, event_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.eventId,
      input.credentialRecordId,
      input.accountId,
      revision,
      eventType,
      input.commandScope,
      input.fingerprint,
      input.occurredAtMs,
      eventJson
    );
    return eventJson;
  }

  #persistPasskeyAuthenticatorMutationResult(
    input: PersistPasskeyAuthenticatorRename | PersistPasskeyAuthenticatorRevoke,
    result: PasskeyAuthenticatorRecord,
    eventJson: string
  ): void {
    this.#db.prepare(`
      INSERT INTO passkey_authenticator_outbox (
        outbox_id, event_id, topic, partition_key, available_at_ms, payload_json
      ) VALUES (?, ?, 'luxora.passkey-authenticator.v1', ?, ?, ?)
    `).run(input.outboxId, input.eventId, input.accountId, input.occurredAtMs, eventJson);
    const resultCiphertext = this.#encryptPasskeyValue(
      JSON.stringify(result),
      `passkey-authenticator-receipt:${input.commandScope}`
    );
    this.#db.prepare(`
      INSERT INTO passkey_authenticator_command_receipts (
        scope, fingerprint, credential_record_id, account_id, result_revision,
        event_id, result_snapshot_ciphertext, created_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.commandScope,
      input.fingerprint,
      input.credentialRecordId,
      input.accountId,
      result.revision,
      input.eventId,
      resultCiphertext,
      input.occurredAtMs
    );
  }

  #validatePasskeyAuthenticatorMutationBase(
    input: PersistPasskeyAuthenticatorRename | PersistPasskeyAuthenticatorRevoke
  ): void {
    if (
      input === null
      || typeof input !== "object"
      || Array.isArray(input)
      || !isPasskeyOpaqueId(input.accountId)
      || !isPasskeyOpaqueId(input.sessionId)
      || !isPasskeyOpaqueId(input.credentialRecordId)
      || !isPasskeyOpaqueId(input.commandScope)
      || !isPasskeyDigest(input.fingerprint)
      || !isPasskeySafeInteger(input.expectedRevision, 1)
      || !isPasskeySafeInteger(input.occurredAtMs)
      || !isPasskeyOpaqueId(input.eventId)
      || !isPasskeyOpaqueId(input.outboxId)
    ) passkeyIntegrityFailure();
  }

  async commitPasskeyAuthenticatorRename(
    input: PersistPasskeyAuthenticatorRename
  ): Promise<PasskeyAuthenticatorMutationResult> {
    this.#validatePasskeyAuthenticatorMutationBase(input);
    if (
      Object.keys(input).sort().join(",")
        !== "accountId,commandScope,credentialRecordId,displayName,eventId,expectedRevision,fingerprint,occurredAtMs,operation,outboxId,sessionId"
      || input.operation !== "rename"
      || !isPasskeyAuthenticatorDisplayName(input.displayName)
      || input.fingerprint !== passkeyAuthenticatorRenameFingerprint({
        accountId: input.accountId,
        sessionId: input.sessionId,
        credentialRecordId: input.credentialRecordId,
        expectedRevision: input.expectedRevision,
        displayName: input.displayName
      })
    ) passkeyIntegrityFailure();

    return this.#db.transaction(() => {
      const duplicateRow = this.#db.prepare(`
        SELECT * FROM passkey_authenticator_command_receipts WHERE scope = ?
      `).get(input.commandScope) as PasskeyAuthenticatorReceiptRow | undefined;
      if (duplicateRow !== undefined) {
        const receipt = this.#mapPasskeyAuthenticatorReceipt(duplicateRow);
        if (
          receipt.fingerprint !== input.fingerprint
          || receipt.accountId !== input.accountId
          || receipt.credentialRecordId !== input.credentialRecordId
        ) throw new StoreDuplicateCommandError();
        return Object.freeze({
          authenticator: receipt.result,
          replayed: true,
          revokedSessionIds: Object.freeze([])
        });
      }
      const row = this.#db.prepare(`
        SELECT * FROM passkey_authenticator_metadata
        WHERE account_id = ? AND credential_record_id = ?
      `).get(input.accountId, input.credentialRecordId) as PasskeyAuthenticatorMetadataRow | undefined;
      if (row === undefined) throw new StoreCredentialStateConflictError();
      const current = this.#mapPasskeyAuthenticatorMetadata(row);
      const writerNowMs = this.passkeyNowMs();
      if (
        current.lifecycleState !== "active"
        || current.revision !== input.expectedRevision
        || input.occurredAtMs < current.updatedAtMs
        || !isPasskeySafeInteger(writerNowMs, input.occurredAtMs)
        || !this.#isActivePasskeySession(
          input.accountId,
          input.sessionId,
          input.sessionId,
          writerNowMs
        )
      ) throw new StoreCredentialStateConflictError();
      const nextRevision = current.revision + 1;
      const eventJson = this.#insertPasskeyAuthenticatorMutationEvent(
        input,
        "passkey.authenticator.renamed",
        nextRevision,
        "active"
      );
      const displayNameCiphertext = this.#encryptPasskeyValue(
        input.displayName,
        `passkey-authenticator-name:${input.credentialRecordId}:${input.accountId}`
      );
      const updated = this.#db.prepare(`
        UPDATE passkey_authenticator_metadata
        SET display_name_ciphertext = ?, revision = ?, updated_at_ms = ?
        WHERE credential_record_id = ? AND account_id = ?
          AND lifecycle_state = 'active' AND revision = ?
      `).run(
        displayNameCiphertext,
        nextRevision,
        input.occurredAtMs,
        input.credentialRecordId,
        input.accountId,
        input.expectedRevision
      );
      if (updated.changes !== 1) throw new StoreCredentialStateConflictError();
      const resultRow = this.#db.prepare(`
        SELECT * FROM passkey_authenticator_metadata
        WHERE account_id = ? AND credential_record_id = ?
      `).get(input.accountId, input.credentialRecordId) as PasskeyAuthenticatorMetadataRow;
      const result = this.#mapPasskeyAuthenticatorMetadata(resultRow);
      this.#persistPasskeyAuthenticatorMutationResult(input, result, eventJson);
      return Object.freeze({
        authenticator: result,
        replayed: false,
        revokedSessionIds: Object.freeze([])
      });
    }).immediate();
  }

  async commitPasskeyAuthenticatorRevoke(
    input: PersistPasskeyAuthenticatorRevoke
  ): Promise<PasskeyAuthenticatorMutationResult> {
    this.#validatePasskeyAuthenticatorMutationBase(input);
    if (
      Object.keys(input).sort().join(",")
        !== "accountId,authorization,commandScope,credentialRecordId,eventId,expectedRevision,fingerprint,occurredAtMs,operation,outboxId,sessionId"
      || input.operation !== "revoke"
    ) passkeyIntegrityFailure();
    assertPasskeyAuthenticatorRevokeClaimsProjection(input.authorization);
    if (input.fingerprint !== passkeyAuthenticatorRevokeFingerprint({
        accountId: input.accountId,
        sessionId: input.sessionId,
        credentialRecordId: input.credentialRecordId,
        expectedRevision: input.expectedRevision,
        authenticationCeremonyId: input.authorization.ceremony_id
      })) passkeyIntegrityFailure();

    return this.#db.transaction(() => {
      const duplicateRow = this.#db.prepare(`
        SELECT * FROM passkey_authenticator_command_receipts WHERE scope = ?
      `).get(input.commandScope) as PasskeyAuthenticatorReceiptRow | undefined;
      if (duplicateRow !== undefined) {
        const receipt = this.#mapPasskeyAuthenticatorReceipt(duplicateRow);
        if (
          receipt.fingerprint !== input.fingerprint
          || receipt.accountId !== input.accountId
          || receipt.credentialRecordId !== input.credentialRecordId
        ) throw new StoreDuplicateCommandError();
        return Object.freeze({
          authenticator: receipt.result,
          replayed: true,
          revokedSessionIds: Object.freeze([])
        });
      }

      const row = this.#db.prepare(`
        SELECT * FROM passkey_authenticator_metadata
        WHERE account_id = ? AND credential_record_id = ?
      `).get(input.accountId, input.credentialRecordId) as PasskeyAuthenticatorMetadataRow | undefined;
      const grantRow = this.#db.prepare(`
        SELECT * FROM passkey_authenticator_step_up_grants
        WHERE authentication_ceremony_id = ?
      `).get(input.authorization.ceremony_id) as PasskeyAuthenticatorStepUpGrantRow | undefined;
      const intentRow = this.#db.prepare(`
        SELECT * FROM passkey_authenticator_revoke_intents
        WHERE authentication_ceremony_id = ?
      `).get(input.authorization.ceremony_id) as PasskeyAuthenticatorRevokeIntentRow | undefined;
      if (row === undefined) throw new StoreCredentialStateConflictError();
      if (grantRow === undefined || intentRow === undefined) passkeyStepUpAuthorizationFailure();
      const current = this.#mapPasskeyAuthenticatorMetadata(row);
      const grant = mapPasskeyAuthenticatorStepUpGrant(grantRow);
      const intent = mapPasskeyAuthenticatorRevokeIntent(intentRow);
      const writerNowMs = this.passkeyNowMs();
      const writerNowSec = Math.floor(writerNowMs / 1_000);
      const expectedTargetDigest = passkeyAuthenticatorRevokeTargetDigest({
        accountId: input.accountId,
        sessionId: input.sessionId,
        credentialRecordId: input.credentialRecordId,
        expectedRevision: input.expectedRevision
      });
      if (
        current.lifecycleState !== "active"
        || current.revision !== input.expectedRevision
        || input.occurredAtMs < current.updatedAtMs
        || !isPasskeySafeInteger(writerNowMs, input.occurredAtMs)
      ) throw new StoreCredentialStateConflictError();
      if (
        grant.accountId !== input.accountId
        || grant.sessionId !== input.sessionId
        || grant.deviceId !== input.sessionId
        || grant.credentialRecordId !== input.credentialRecordId
        || grant.expectedAuthenticatorRevision !== input.expectedRevision
        || grant.purpose !== input.authorization.purpose
        || grant.targetDigest !== expectedTargetDigest
        || grant.targetDigest !== input.authorization.target_digest
        || grant.authenticationCeremonyId !== input.authorization.ceremony_id
        || grant.accountId !== input.authorization.sub
        || grant.sessionId !== input.authorization.sid
        || grant.authTimeSec !== input.authorization.auth_time
        || grant.issuedAtSec !== input.authorization.iat
        || grant.expiresAtSec !== input.authorization.exp
        || intent.authenticationCeremonyId !== grant.authenticationCeremonyId
        || intent.accountId !== grant.accountId
        || intent.sessionId !== grant.sessionId
        || intent.deviceId !== grant.deviceId
        || intent.credentialRecordId !== grant.credentialRecordId
        || intent.expectedAuthenticatorRevision !== grant.expectedAuthenticatorRevision
        || intent.purpose !== grant.purpose
        || intent.targetDigest !== grant.targetDigest
        || grant.consumedAtSec !== null
        || grant.managementCommandScope !== null
        || writerNowSec < grant.issuedAtSec
        || writerNowSec >= grant.expiresAtSec
        || Math.floor(input.occurredAtMs / 1_000) < grant.issuedAtSec
        || Math.floor(input.occurredAtMs / 1_000) >= grant.expiresAtSec
        || !this.#isActivePasskeySession(
          input.accountId,
          input.sessionId,
          input.sessionId,
          writerNowMs
        )
      ) passkeyStepUpAuthorizationFailure();

      const account = this.#db.prepare(`
        SELECT password_auth_enabled FROM users WHERE id = ?
      `).get(input.accountId) as { password_auth_enabled: number } | undefined;
      if (account === undefined) throw new StoreCredentialStateConflictError();
      if (account.password_auth_enabled === 0) {
        const active = this.#db.prepare(`
          SELECT COUNT(*) AS count FROM passkey_authenticator_metadata
          WHERE account_id = ? AND lifecycle_state = 'active'
        `).get(input.accountId) as { count: number };
        if (active.count <= 1) throw new StoreCredentialStateConflictError();
      } else if (account.password_auth_enabled !== 1) {
        passkeyIntegrityFailure();
      }

      const nextRevision = current.revision + 1;
      const eventJson = this.#insertPasskeyAuthenticatorMutationEvent(
        input,
        "passkey.authenticator.revoked",
        nextRevision,
        "revoked"
      );
      const consumed = this.#db.prepare(`
        UPDATE passkey_authenticator_step_up_grants
        SET consumed_at_sec = ?, management_command_scope = ?
        WHERE authentication_ceremony_id = ?
          AND account_id = ? AND session_id = ? AND device_id = ?
          AND credential_record_id = ? AND expected_authenticator_revision = ?
          AND purpose = 'authenticator.revoke' AND target_digest = ?
          AND auth_time_sec = ? AND issued_at_sec = ? AND expires_at_sec = ?
          AND consumed_at_sec IS NULL AND management_command_scope IS NULL
          AND issued_at_sec <= ? AND expires_at_sec > ?
      `).run(
        writerNowSec,
        input.commandScope,
        grant.authenticationCeremonyId,
        grant.accountId,
        grant.sessionId,
        grant.deviceId,
        grant.credentialRecordId,
        grant.expectedAuthenticatorRevision,
        grant.targetDigest,
        grant.authTimeSec,
        grant.issuedAtSec,
        grant.expiresAtSec,
        writerNowSec,
        writerNowSec
      );
      if (consumed.changes !== 1) passkeyStepUpAuthorizationFailure();

      const updated = this.#db.prepare(`
        UPDATE passkey_authenticator_metadata
        SET lifecycle_state = 'revoked', revision = ?, updated_at_ms = ?, revoked_at_ms = ?
        WHERE credential_record_id = ? AND account_id = ?
          AND lifecycle_state = 'active' AND revision = ?
      `).run(
        nextRevision,
        input.occurredAtMs,
        input.occurredAtMs,
        input.credentialRecordId,
        input.accountId,
        input.expectedRevision
      );
      if (updated.changes !== 1) throw new StoreCredentialStateConflictError();

      const activeSessionRows = this.#db.prepare(`
        SELECT sessions.id
        FROM passkey_session_credential_origins origins
        JOIN device_sessions sessions
          ON sessions.id = origins.session_id AND sessions.user_id = origins.account_id
        WHERE origins.account_id = ? AND origins.credential_record_id = ?
          AND sessions.revoked_at IS NULL
        ORDER BY sessions.id ASC
      `).all(input.accountId, input.credentialRecordId) as Array<{ id: string }>;
      const revokedAt = passkeyTimestampIso(input.occurredAtMs);
      this.#db.prepare(`
        UPDATE device_sessions
        SET revoked_at = COALESCE(revoked_at, ?)
        WHERE id IN (
          SELECT session_id FROM passkey_session_credential_origins
          WHERE account_id = ? AND credential_record_id = ?
        ) AND user_id = ?
      `).run(revokedAt, input.accountId, input.credentialRecordId, input.accountId);
      this.#db.prepare(`
        UPDATE refresh_tokens
        SET used_at = COALESCE(used_at, ?)
        WHERE session_id IN (
          SELECT session_id FROM passkey_session_credential_origins
          WHERE account_id = ? AND credential_record_id = ?
        )
      `).run(revokedAt, input.accountId, input.credentialRecordId);

      const resultRow = this.#db.prepare(`
        SELECT * FROM passkey_authenticator_metadata
        WHERE account_id = ? AND credential_record_id = ?
      `).get(input.accountId, input.credentialRecordId) as PasskeyAuthenticatorMetadataRow;
      const result = this.#mapPasskeyAuthenticatorMetadata(resultRow);
      this.#persistPasskeyAuthenticatorMutationResult(input, result, eventJson);
      return Object.freeze({
        authenticator: result,
        replayed: false,
        revokedSessionIds: Object.freeze(activeSessionRows.map(({ id }) => id))
      });
    }).immediate();
  }

  async findPasskeyStepUpGrant(
    authenticationCeremonyId: string
  ): Promise<PasskeyStepUpGrantRecord | null> {
    if (!isPasskeyOpaqueId(authenticationCeremonyId)) return null;
    const row = this.#db.prepare(`
      SELECT * FROM passkey_step_up_grants
      WHERE authentication_ceremony_id = ?
    `).get(authenticationCeremonyId) as PasskeyStepUpGrantRow | undefined;
    return row === undefined ? null : mapPasskeyStepUpGrant(row);
  }

  async findPasskeyLoginIntent(intentId: string): Promise<PasskeyLoginIntentRecord | null> {
    if (!isCanonicalPasskeyId(intentId)) return null;
    const row = this.#db.prepare(`
      SELECT * FROM passkey_login_intents WHERE intent_id = ?
    `).get(intentId) as PasskeyLoginIntentRow | undefined;
    return row === undefined ? null : mapPasskeyLoginIntent(row);
  }

  async listExpiredPendingPasskeyLoginIntents(
    observedAtMs: number,
    limit: number
  ): Promise<readonly PasskeyLoginIntentRecord[]> {
    if (
      !isPasskeySafeInteger(observedAtMs)
      || !isPasskeySafeInteger(limit, 1, 1_000)
    ) {
      passkeyIntegrityFailure();
    }
    const rows = this.#db.prepare(`
      SELECT *
      FROM passkey_login_intents
      WHERE state = 'pending' AND expires_at_ms <= @observedAtMs
      ORDER BY expires_at_ms ASC, intent_id ASC
      LIMIT @limit
    `).all({ observedAtMs, limit }) as PasskeyLoginIntentRow[];
    return Object.freeze(rows.map((row) => mapPasskeyLoginIntent(row)));
  }

  #findPasskeyLoginReceipt(
    table: "passkey_login_command_receipts" | "passkey_login_creation_receipts",
    scope: string,
    requireCommandScope: boolean
  ): PasskeyLoginReceiptRecord | null {
    if (!isPasskeyOpaqueId(scope)) return null;
    const row = this.#db.prepare(`
      SELECT receipts.*,
             events.event_id AS linked_event_id,
             events.intent_id AS linked_intent_id,
             events.revision AS linked_revision,
             json_extract(events.event_json, '$.state') AS linked_state,
             events.command_scope AS linked_command_scope,
             events.occurred_at_ms AS linked_occurred_at_ms
      FROM ${table} receipts
      LEFT JOIN passkey_login_events events ON events.event_id = receipts.event_id
      WHERE receipts.scope = ?
    `).get(scope) as PasskeyLoginReceiptRow | undefined;
    return row === undefined
      ? null
      : mapPasskeyLoginReceipt(row, scope, requireCommandScope);
  }

  async findPasskeyLoginCommandReceipt(scope: string): Promise<PasskeyLoginReceiptRecord | null> {
    return this.#findPasskeyLoginReceipt("passkey_login_command_receipts", scope, true);
  }

  async findPasskeyLoginCreationReceipt(scope: string): Promise<PasskeyLoginReceiptRecord | null> {
    return this.#findPasskeyLoginReceipt("passkey_login_creation_receipts", scope, false);
  }

  #assertNoPasskeyLoginReceiptDuplicates(
    commandReceipt: PasskeyLoginReceiptRecord,
    creationReceipt: PasskeyLoginReceiptRecord | null
  ): void {
    const duplicateCommand = this.#db.prepare(`
      SELECT 1 AS present FROM passkey_login_command_receipts WHERE scope = ?
    `).get(commandReceipt.scope) as { present: number } | undefined;
    if (duplicateCommand !== undefined) throw new StoreDuplicateCommandError();
    if (creationReceipt !== null) {
      const duplicateCreation = this.#db.prepare(`
        SELECT 1 AS present FROM passkey_login_creation_receipts WHERE scope = ?
      `).get(creationReceipt.scope) as { present: number } | undefined;
      if (duplicateCreation !== undefined) throw new StoreDuplicateCreationError();
    }
  }

  #assertPasskeyIntentChallengeLease(intent: {
    readonly challenge: { readonly reference: string; readonly digest: string };
    readonly createdAtMs: number;
    readonly expiresAtMs: number;
  }): void {
    const row = this.#db.prepare(`
      SELECT * FROM passkey_challenge_secrets WHERE reference = ?
    `).get(intent.challenge.reference) as PasskeyChallengeRow | undefined;
    const nowMs = this.passkeyNowMs();
    if (
      row === undefined
      || row.reference !== intent.challenge.reference
      || !isPasskeySafeInteger(nowMs, intent.createdAtMs)
      || nowMs >= intent.expiresAtMs
      || !isPasskeySafeInteger(row.created_at_ms)
      || row.created_at_ms < intent.createdAtMs
      || row.created_at_ms > nowMs
      || row.expires_at_ms !== intent.expiresAtMs
    ) {
      passkeyIntegrityFailure();
    }
    let challenge: string;
    try {
      if (!row.challenge_ciphertext.startsWith(PASSKEY_ENCRYPTED_ENVELOPE_PREFIX)) {
        passkeyIntegrityFailure();
      }
      challenge = this.contentCipher.decrypt(
        row.challenge_ciphertext,
        `passkey-challenge:${row.reference}`
      );
    } catch {
      passkeyIntegrityFailure();
    }
    if (
      !isCanonicalBase64Url(challenge, PASSKEY_CHALLENGE_BYTES, PASSKEY_CHALLENGE_BYTES)
      || createHash("sha256").update(Buffer.from(challenge, "base64url")).digest("hex")
        !== intent.challenge.digest
    ) {
      passkeyIntegrityFailure();
    }
  }

  #insertPasskeyLoginIntent(intent: NewPasskeyLoginIntent): void {
    this.#db.prepare(`
      INSERT INTO passkey_login_intents (
        intent_id, schema_version, purpose_type, purpose_target_digest,
        policy_version, access_token_ttl_seconds, session_ttl_seconds,
        recovery_grace_seconds, expected_rp_id, expected_origin, timeout_ms,
        max_response_bytes, max_attempts, allowed_algorithms_json,
        user_verification, cross_origin_allowed, credential_boundary,
        challenge_reference, challenge_digest, delivery_nonce_digest,
        refresh_derivation_key_id, state, revision, attempts_used,
        created_at_ms, expires_at_ms, updated_at_ms, terminal_at_ms,
        terminal_reason
      ) VALUES (
        @intentId, 1, 'session.create', @purposeTargetDigest,
        1, @accessTokenTtlSeconds, @sessionTtlSeconds,
        @recoveryGraceSeconds, @expectedRpId, @expectedOrigin, @timeoutMs,
        @maxResponseBytes, @maxAttempts, @allowedAlgorithmsJson,
        'required', 0, 'discoverable_any',
        @challengeReference, @challengeDigest, @deliveryNonceDigest,
        @refreshDerivationKeyId, 'pending', 1, 0,
        @createdAtMs, @expiresAtMs, @updatedAtMs, NULL, NULL
      )
    `).run({
      intentId: intent.intentId,
      purposeTargetDigest: intent.purpose.targetDigest,
      accessTokenTtlSeconds: intent.accessTokenTtlSeconds,
      sessionTtlSeconds: intent.sessionTtlSeconds,
      recoveryGraceSeconds: intent.recoveryGraceSeconds,
      expectedRpId: intent.expectedRpId,
      expectedOrigin: intent.expectedOrigin,
      timeoutMs: intent.timeoutMs,
      maxResponseBytes: intent.maxResponseBytes,
      maxAttempts: intent.maxAttempts,
      allowedAlgorithmsJson: PASSKEY_LOGIN_ALLOWED_ALGORITHMS_JSON,
      challengeReference: intent.challenge.reference,
      challengeDigest: intent.challenge.digest,
      deliveryNonceDigest: intent.deliveryNonceDigest,
      refreshDerivationKeyId: intent.refreshDerivationKeyId,
      createdAtMs: intent.createdAtMs,
      expiresAtMs: intent.expiresAtMs,
      updatedAtMs: intent.updatedAtMs
    });
  }

  #persistPasskeyLoginEventAndOutbox(input: PasskeyLoginMutationRecord): void {
    const payload = {
      type: input.event.type,
      intentId: input.event.intentId,
      revision: input.event.revision,
      state: input.event.state
    };
    this.#db.prepare(`
      INSERT INTO passkey_login_events (
        event_id, intent_id, revision, event_type, command_scope,
        occurred_at_ms, event_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.event.eventId,
      input.event.intentId,
      input.event.revision,
      input.event.type,
      input.event.commandScope,
      input.event.occurredAtMs,
      JSON.stringify(payload)
    );
    this.#db.prepare(`
      INSERT INTO passkey_login_outbox (
        outbox_id, event_id, topic, partition_key, available_at_ms, payload_json
      ) VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      input.outbox.outboxId,
      input.outbox.eventId,
      input.outbox.topic,
      input.outbox.partitionKey,
      input.outbox.availableAtMs,
      JSON.stringify(payload)
    );
  }

  #persistPasskeyLoginReceipt(
    table: "passkey_login_command_receipts" | "passkey_login_creation_receipts",
    receipt: PasskeyLoginReceiptRecord
  ): void {
    this.#db.prepare(`
      INSERT INTO ${table} (
        scope, fingerprint, intent_id, result_revision, result_state,
        event_id, result_json, created_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      receipt.scope,
      receipt.fingerprint,
      receipt.intentId,
      receipt.resultRevision,
      receipt.resultState,
      receipt.eventId,
      JSON.stringify({
        intentId: receipt.intentId,
        revision: receipt.resultRevision,
        state: receipt.resultState
      }),
      receipt.createdAtMs
    );
  }

  async commitPasskeyLoginBegin(input: PersistPasskeyLoginBegin): Promise<void> {
    assertPasskeyLoginBeginShape(input);
    this.#db.transaction(() => {
      this.#assertNoPasskeyLoginReceiptDuplicates(
        input.commandReceipt,
        input.creationReceipt
      );
      const existing = this.#db.prepare(`
        SELECT 1 AS present FROM passkey_login_intents WHERE intent_id = ?
      `).get(input.intent.intentId) as { present: number } | undefined;
      if (existing !== undefined) throw new StoreRevisionConflictError();
      this.#assertPasskeyIntentChallengeLease(input.intent);
      this.#insertPasskeyLoginIntent(input.intent);
      this.#persistPasskeyLoginEventAndOutbox(input);
      this.#persistPasskeyLoginReceipt(
        "passkey_login_command_receipts",
        input.commandReceipt
      );
      this.#persistPasskeyLoginReceipt(
        "passkey_login_creation_receipts",
        input.creationReceipt
      );
    }).immediate();
  }

  async commitPasskeyLoginRejectedAttempt(
    input: PersistPasskeyLoginRejectedAttempt
  ): Promise<void> {
    assertPasskeyLoginRejectedShape(input);
    this.#db.transaction(() => {
      this.#assertNoPasskeyLoginReceiptDuplicates(input.commandReceipt, null);
      const row = this.#db.prepare(`
        SELECT * FROM passkey_login_intents WHERE intent_id = ?
      `).get(input.intentId) as PasskeyLoginIntentRow | undefined;
      if (row === undefined || row.revision !== input.expectedRevision) {
        throw new StoreRevisionConflictError();
      }
      const current = mapPasskeyLoginIntent(row);
      const nowMs = this.passkeyNowMs();
      const attemptsUsed = current.attemptsUsed + 1;
      const expectedState = attemptsUsed === current.maxAttempts ? "rejected" : "pending";
      if (
        current.state !== "pending"
        || input.nextState !== expectedState
        || input.updatedAtMs < current.updatedAtMs
        || input.updatedAtMs >= current.expiresAtMs
        || !isPasskeySafeInteger(nowMs, input.updatedAtMs)
        || nowMs >= current.expiresAtMs
      ) {
        throw new StoreRevisionConflictError();
      }
      const updated = this.#db.prepare(`
        UPDATE passkey_login_intents
        SET state = @state,
            revision = @revision,
            attempts_used = @attemptsUsed,
            updated_at_ms = @updatedAtMs,
            terminal_at_ms = @terminalAtMs,
            terminal_reason = @terminalReason
        WHERE intent_id = @intentId
          AND state = 'pending'
          AND revision = @expectedRevision
          AND attempts_used = @previousAttemptsUsed
      `).run({
        intentId: current.intentId,
        expectedRevision: input.expectedRevision,
        previousAttemptsUsed: current.attemptsUsed,
        state: input.nextState,
        revision: input.expectedRevision + 1,
        attemptsUsed,
        updatedAtMs: input.updatedAtMs,
        terminalAtMs: input.nextState === "rejected" ? input.updatedAtMs : null,
        terminalReason: input.nextState === "rejected" ? "attempts_exhausted" : null
      });
      if (updated.changes !== 1) throw new StoreRevisionConflictError();
      this.#persistPasskeyLoginEventAndOutbox(input);
      this.#persistPasskeyLoginReceipt(
        "passkey_login_command_receipts",
        input.commandReceipt
      );
      if (input.nextState === "rejected") {
        this.#db.prepare(`
          DELETE FROM passkey_challenge_secrets WHERE reference = ?
        `).run(current.challenge.reference);
      }
    }).immediate();
  }

  async commitPasskeyLoginTerminal(input: PersistPasskeyLoginTerminal): Promise<void> {
    assertPasskeyLoginTerminalShape(input);
    this.#db.transaction(() => {
      this.#assertNoPasskeyLoginReceiptDuplicates(input.commandReceipt, null);
      const row = this.#db.prepare(`
        SELECT * FROM passkey_login_intents WHERE intent_id = ?
      `).get(input.intentId) as PasskeyLoginIntentRow | undefined;
      if (row === undefined || row.revision !== input.expectedRevision) {
        throw new StoreRevisionConflictError();
      }
      const current = mapPasskeyLoginIntent(row);
      const nowMs = this.passkeyNowMs();
      const timingMatchesState = input.nextState === "expired"
        ? input.terminalAtMs >= current.expiresAtMs && nowMs >= current.expiresAtMs
        : input.terminalAtMs < current.expiresAtMs && nowMs < current.expiresAtMs;
      if (
        current.state !== "pending"
        || input.terminalAtMs < current.updatedAtMs
        || !isPasskeySafeInteger(nowMs, input.terminalAtMs)
        || !timingMatchesState
      ) {
        throw new StoreRevisionConflictError();
      }
      const updated = this.#db.prepare(`
        UPDATE passkey_login_intents
        SET state = @state,
            revision = @revision,
            updated_at_ms = @terminalAtMs,
            terminal_at_ms = @terminalAtMs,
            terminal_reason = @terminalReason
        WHERE intent_id = @intentId
          AND state = 'pending'
          AND revision = @expectedRevision
          AND attempts_used = @attemptsUsed
      `).run({
        intentId: current.intentId,
        expectedRevision: input.expectedRevision,
        attemptsUsed: current.attemptsUsed,
        state: input.nextState,
        revision: input.expectedRevision + 1,
        terminalAtMs: input.terminalAtMs,
        terminalReason: input.nextState
      });
      if (updated.changes !== 1) throw new StoreRevisionConflictError();
      this.#persistPasskeyLoginEventAndOutbox(input);
      this.#persistPasskeyLoginReceipt(
        "passkey_login_command_receipts",
        input.commandReceipt
      );
      this.#db.prepare(`
        DELETE FROM passkey_challenge_secrets WHERE reference = ?
      `).run(current.challenge.reference);
    }).immediate();
  }

  async commitVerifiedPasskeyLogin(input: PersistVerifiedPasskeyLogin): Promise<void> {
    assertVerifiedPasskeyLoginShape(input);
    this.#db.transaction(() => {
      this.#assertNoPasskeyLoginReceiptDuplicates(input.commandReceipt, null);
      const intentRow = this.#db.prepare(`
        SELECT * FROM passkey_login_intents WHERE intent_id = ?
      `).get(input.intentId) as PasskeyLoginIntentRow | undefined;
      if (intentRow === undefined || intentRow.revision !== input.expectedRevision) {
        throw new StoreRevisionConflictError();
      }
      const current = mapPasskeyLoginIntent(intentRow);
      const nowMs = this.passkeyNowMs();
      const sessionExpiresAtMs = passkeyIsoTimestampMs(input.session.expiresAt);
      const refreshExpiresAtMs = passkeyIsoTimestampMs(input.refreshToken.expiresAt);
      const expectedSessionExpiresAtMs = input.committedAtMs
        + current.sessionTtlSeconds * 1_000;
      const requiredReplayExpirySec = Math.ceil(current.expiresAtMs / 1_000)
        + current.recoveryGraceSeconds;
      if (
        current.state !== "pending"
        || input.committedAtMs < current.updatedAtMs
        || input.committedAtMs >= current.expiresAtMs
        || !isPasskeySafeInteger(nowMs, input.committedAtMs)
        || nowMs >= current.expiresAtMs
        || Math.floor(nowMs / 1_000) >= input.accessToken.expiresAtSec
        || sessionExpiresAtMs === null
        || sessionExpiresAtMs !== expectedSessionExpiresAtMs
        || refreshExpiresAtMs === null
        || refreshExpiresAtMs !== expectedSessionExpiresAtMs
        || input.accessToken.expiresAtSec
          !== Math.floor(input.committedAtMs / 1_000) + current.accessTokenTtlSeconds
        || input.accessToken.expiresAtSec < requiredReplayExpirySec
        || input.accessToken.expiresAtSec > Math.floor(expectedSessionExpiresAtMs / 1_000)
        || input.refreshToken.derivationKeyId !== current.refreshDerivationKeyId
        || input.refreshToken.deliveryNonceDigest !== current.deliveryNonceDigest
      ) {
        throw new StoreRevisionConflictError();
      }

      const credentialRow = this.#db.prepare(`
        ${PASSKEY_CREDENTIAL_SELECT}
        WHERE credentials.record_id = ?
      `).get(input.credential.credentialRecordId) as PasskeyCredentialRow | undefined;
      if (credentialRow === undefined) throw new StoreCredentialStateConflictError();
      const credential = this.#mapPasskeyCredential(credentialRow);
      const handleRow = this.#db.prepare(`
        SELECT * FROM passkey_user_handles WHERE reference = ?
      `).get(input.credential.userHandleRef) as PasskeyUserHandleRow | undefined;
      if (handleRow === undefined) throw new StoreCredentialStateConflictError();
      const handle = this.#mapPasskeyUserHandle(handleRow);
      if (
        credential.recordId !== input.credential.credentialRecordId
        || credential.accountId !== input.credential.accountId
        || credential.accountId !== input.session.userId
        || credential.userHandleRef !== input.credential.userHandleRef
        || credential.userHandleRef !== handle.reference
        || credential.accountId !== handle.accountId
        || credential.algorithm !== input.credential.algorithm
        || credential.discoveryMode !== "discoverable"
        || credential.credentialSetRef !== null
        || credential.revision !== input.credential.credentialRevision
        || credential.signCount !== input.credential.previousSignCount
        || credential.backupEligible !== input.credential.previousBackupEligible
        || credential.backupEligible !== input.credential.backupEligible
        || credential.backupState !== input.credential.previousBackupState
        || credential.updatedAtMs > input.committedAtMs
      ) {
        throw new StoreCredentialStateConflictError();
      }

      const account = this.#db.prepare(`
        SELECT 1 AS present FROM users WHERE id = ?
      `).get(input.credential.accountId) as { present: number } | undefined;
      if (account === undefined) throw new StoreCredentialStateConflictError();

      // Counter values are advisory clone-risk telemetry. Keep the durable
      // credential counter monotonic without locking out synced authenticators
      // that legitimately report zero or an older value.
      const persistedSignCount = Math.max(
        input.credential.previousSignCount,
        input.credential.newSignCount
      );

      const credentialUpdate = this.#db.prepare(`
        UPDATE passkey_credentials
        SET revision = revision + 1,
            sign_count = @newSignCount,
            backup_state = @backupState,
            updated_at_ms = @updatedAtMs
        WHERE record_id = @recordId
          AND account_id = @accountId
          AND user_handle_ref = @userHandleRef
          AND algorithm = @algorithm
          AND discovery_mode = 'discoverable'
          AND credential_set_ref IS NULL
          AND revision = @credentialRevision
          AND sign_count = @previousSignCount
          AND backup_eligible = @backupEligible
          AND backup_state = @previousBackupState
          AND updated_at_ms <= @updatedAtMs
          AND EXISTS (
            SELECT 1 FROM passkey_authenticator_metadata metadata
            WHERE metadata.credential_record_id = passkey_credentials.record_id
              AND metadata.account_id = passkey_credentials.account_id
              AND metadata.lifecycle_state = 'active'
          )
      `).run({
        recordId: input.credential.credentialRecordId,
        accountId: input.credential.accountId,
        userHandleRef: input.credential.userHandleRef,
        algorithm: input.credential.algorithm,
        credentialRevision: input.credential.credentialRevision,
        previousSignCount: input.credential.previousSignCount,
        newSignCount: persistedSignCount,
        backupEligible: input.credential.backupEligible ? 1 : 0,
        previousBackupState: input.credential.previousBackupState ? 1 : 0,
        backupState: input.credential.backupState ? 1 : 0,
        updatedAtMs: input.committedAtMs
      });
      if (credentialUpdate.changes !== 1) throw new StoreCredentialStateConflictError();

      this.#db.prepare(`
        INSERT INTO device_sessions (
          id, user_id, device_name, created_at, last_seen_at, expires_at
        ) VALUES (@id, @userId, @deviceName, @createdAt, @createdAt, @expiresAt)
      `).run(input.session);
      this.#db.prepare(`
        INSERT INTO passkey_session_credential_origins (
          session_id, account_id, credential_record_id, created_at_ms
        ) VALUES (?, ?, ?, ?)
      `).run(
        input.session.id,
        input.session.userId,
        input.credential.credentialRecordId,
        input.committedAtMs
      );
      this.#db.prepare(`
        INSERT INTO refresh_tokens (id, session_id, token_hash, created_at, expires_at)
        VALUES (@id, @sessionId, @tokenHash, @createdAt, @expiresAt)
      `).run({
        id: input.refreshToken.id,
        sessionId: input.refreshToken.sessionId,
        tokenHash: input.refreshToken.tokenHash,
        createdAt: input.refreshToken.createdAt,
        expiresAt: input.refreshToken.expiresAt
      });

      const consumed = this.#db.prepare(`
        UPDATE passkey_login_intents
        SET state = 'consumed',
            revision = @revision,
            updated_at_ms = @updatedAtMs,
            terminal_at_ms = @updatedAtMs,
            terminal_reason = 'verified',
            resolved_account_id = @accountId,
            resolved_user_handle_ref = @userHandleRef,
            resolved_credential_record_id = @credentialRecordId,
            resolved_credential_revision_before = @credentialRevisionBefore,
            resolved_credential_revision_after = @credentialRevisionAfter,
            resolved_sign_count_before = @signCountBefore,
            resolved_observed_sign_count = @observedSignCount,
            resolved_sign_count_after = @signCountAfter,
            resolved_backup_eligible = @backupEligible,
            resolved_backup_state_before = @backupStateBefore,
            resolved_backup_state_after = @backupStateAfter,
            session_id = @sessionId,
            initial_refresh_token_id = @refreshTokenId,
            initial_access_token_expires_at_sec = @accessTokenExpiresAtSec
        WHERE intent_id = @intentId
          AND state = 'pending'
          AND revision = @expectedRevision
          AND attempts_used = @attemptsUsed
      `).run({
        intentId: current.intentId,
        expectedRevision: input.expectedRevision,
        attemptsUsed: current.attemptsUsed,
        revision: input.expectedRevision + 1,
        updatedAtMs: input.committedAtMs,
        accountId: input.credential.accountId,
        userHandleRef: input.credential.userHandleRef,
        credentialRecordId: input.credential.credentialRecordId,
        credentialRevisionBefore: input.credential.credentialRevision,
        credentialRevisionAfter: input.credential.credentialRevision + 1,
        signCountBefore: input.credential.previousSignCount,
        observedSignCount: input.credential.newSignCount,
        signCountAfter: persistedSignCount,
        backupEligible: input.credential.backupEligible ? 1 : 0,
        backupStateBefore: input.credential.previousBackupState ? 1 : 0,
        backupStateAfter: input.credential.backupState ? 1 : 0,
        sessionId: input.session.id,
        refreshTokenId: input.refreshToken.id,
        accessTokenExpiresAtSec: input.accessToken.expiresAtSec
      });
      if (consumed.changes !== 1) throw new StoreRevisionConflictError();

      this.#persistPasskeyLoginEventAndOutbox(input);
      this.#persistPasskeyLoginReceipt(
        "passkey_login_command_receipts",
        input.commandReceipt
      );
      this.#db.prepare(`
        DELETE FROM passkey_challenge_secrets WHERE reference = ?
      `).run(current.challenge.reference);
    }).immediate();
  }

  async findPasskeySignupIntent(intentId: string): Promise<PasskeySignupIntentRecord | null> {
    if (!isCanonicalPasskeyId(intentId)) return null;
    const row = this.#db.prepare(`
      SELECT * FROM passkey_signup_intents WHERE intent_id = ?
    `).get(intentId) as PasskeySignupIntentRow | undefined;
    if (row === undefined) return null;
    const intent = mapPasskeySignupIntent(row, this.contentCipher);
    if (intent.state === "consumed") {
      const consumption = this.#findPasskeySignupConsumption(intentId);
      if (
        consumption === null
        || consumption.resultRevision !== intent.revision
        || consumption.accountId !== intent.candidate.accountId
        || consumption.userHandleRef !== intent.candidate.userHandleRef
        || consumption.credentialRecordId !== intent.resolvedCredentialRecordId
        || consumption.committedAtMs !== intent.updatedAtMs
      ) passkeyIntegrityFailure();
    }
    return intent;
  }

  #findPasskeySignupConsumption(intentId: string): PasskeySignupConsumptionRecord | null {
    const row = this.#db.prepare(`
      SELECT consumption.*,
             intents.state AS linked_state,
             intents.revision AS linked_revision,
             intents.candidate_account_id AS linked_account_id,
             intents.candidate_user_handle_ref AS linked_user_handle_ref,
             intents.resolved_credential_record_id AS linked_credential_record_id,
             intents.updated_at_ms AS linked_updated_at_ms
      FROM passkey_signup_consumptions consumption
      LEFT JOIN passkey_signup_intents intents ON intents.intent_id = consumption.intent_id
      WHERE consumption.intent_id = ?
    `).get(intentId) as PasskeySignupConsumptionRow | undefined;
    return row === undefined ? null : mapPasskeySignupConsumption(row);
  }

  async findPasskeySignupConsumption(
    intentId: string
  ): Promise<PasskeySignupConsumptionRecord | null> {
    if (!isCanonicalPasskeyId(intentId)) return null;
    return this.#findPasskeySignupConsumption(intentId);
  }

  async listExpiredPendingPasskeySignupIntents(
    observedAtMs: number,
    limit: number
  ): Promise<readonly PasskeySignupIntentRecord[]> {
    if (
      !isPasskeySafeInteger(observedAtMs)
      || !isPasskeySafeInteger(limit, 1, 1_000)
    ) passkeyIntegrityFailure();
    const rows = this.#db.prepare(`
      SELECT * FROM passkey_signup_intents
      WHERE state = 'pending' AND expires_at_ms <= @observedAtMs
      ORDER BY expires_at_ms ASC, intent_id ASC
      LIMIT @limit
    `).all({ observedAtMs, limit }) as PasskeySignupIntentRow[];
    return Object.freeze(rows.map((row) => mapPasskeySignupIntent(row, this.contentCipher)));
  }

  #findPasskeySignupReceipt(
    table: "passkey_signup_command_receipts" | "passkey_signup_creation_receipts",
    scope: string,
    requireCommandScope: boolean
  ): PasskeySignupReceiptRecord | null {
    if (!isPasskeyOpaqueId(scope)) return null;
    const row = this.#db.prepare(`
      SELECT receipts.*,
             events.event_id AS linked_event_id,
             events.intent_id AS linked_intent_id,
             events.revision AS linked_revision,
             json_extract(events.event_json, '$.state') AS linked_state,
             events.command_scope AS linked_command_scope,
             events.occurred_at_ms AS linked_occurred_at_ms
      FROM ${table} receipts
      LEFT JOIN passkey_signup_events events ON events.event_id = receipts.event_id
      WHERE receipts.scope = ?
    `).get(scope) as PasskeySignupReceiptRow | undefined;
    return row === undefined
      ? null
      : mapPasskeySignupReceipt(row, scope, requireCommandScope);
  }

  async findPasskeySignupCommandReceipt(
    scope: string
  ): Promise<PasskeySignupReceiptRecord | null> {
    return this.#findPasskeySignupReceipt("passkey_signup_command_receipts", scope, true);
  }

  async findPasskeySignupCreationReceipt(
    scope: string
  ): Promise<PasskeySignupReceiptRecord | null> {
    return this.#findPasskeySignupReceipt("passkey_signup_creation_receipts", scope, false);
  }

  #assertNoPasskeySignupReceiptDuplicates(
    commandReceipt: PasskeySignupReceiptRecord,
    creationReceipt: PasskeySignupReceiptRecord | null
  ): void {
    const duplicateCommand = this.#db.prepare(`
      SELECT 1 AS present FROM passkey_signup_command_receipts WHERE scope = ?
    `).get(commandReceipt.scope) as { present: number } | undefined;
    if (duplicateCommand !== undefined) throw new StoreDuplicateCommandError();
    if (creationReceipt !== null) {
      const duplicateCreation = this.#db.prepare(`
        SELECT 1 AS present FROM passkey_signup_creation_receipts WHERE scope = ?
      `).get(creationReceipt.scope) as { present: number } | undefined;
      if (duplicateCreation !== undefined) throw new StoreDuplicateCreationError();
    }
  }

  #insertPasskeySignupIntent(intent: NewPasskeySignupIntent): void {
    const userHandle = new Uint8Array(intent.candidate.userHandle);
    const userHandleEncoded = Buffer.from(userHandle).toString("base64url");
    const usernameCiphertext = this.#encryptPasskeyValue(
      intent.candidate.username,
      `passkey-signup:${intent.intentId}:username`
    );
    const usernameNormalizedCiphertext = this.#encryptPasskeyValue(
      intent.candidate.usernameNormalized,
      `passkey-signup:${intent.intentId}:username-normalized`
    );
    const displayNameCiphertext = this.#encryptPasskeyValue(
      intent.candidate.displayName,
      `passkey-signup:${intent.intentId}:display-name`
    );
    const userHandleCiphertext = this.#encryptPasskeyValue(
      userHandleEncoded,
      `passkey-signup:${intent.intentId}:user-handle`
    );
    this.#db.prepare(`
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
        expires_at_ms, updated_at_ms, terminal_at_ms, terminal_reason,
        resolved_credential_record_id
      ) VALUES (
        @intentId, 1, 'account.create', @purposeTargetDigest,
        1, 'Luxora', @expectedRpId, @expectedOrigin,
        '[]', @timeoutMs, @maxResponseBytes, @maxAttempts,
        @allowedAlgorithmsJson, 1, 'required',
        'required', 'none', 0, '[]',
        @candidateAccountId, @candidateUsernameCiphertext,
        @candidateUsernameNormalizedCiphertext,
        @candidateDisplayNameCiphertext,
        @candidateUserHandleRef, @candidateUserHandleDigest,
        @candidateUserHandleCiphertext, @challengeReference, @challengeDigest,
        @deliveryNonceDigest, 'pending', 1, 0, @createdAtMs,
        @expiresAtMs, @updatedAtMs, NULL, NULL, NULL
      )
    `).run({
      intentId: intent.intentId,
      purposeTargetDigest: intent.purpose.targetDigest,
      expectedRpId: intent.expectedRpId,
      expectedOrigin: intent.expectedOrigin,
      timeoutMs: intent.timeoutMs,
      maxResponseBytes: intent.maxResponseBytes,
      maxAttempts: intent.maxAttempts,
      allowedAlgorithmsJson: PASSKEY_SIGNUP_ALLOWED_ALGORITHMS_JSON,
      candidateAccountId: intent.candidate.accountId,
      candidateUsernameCiphertext: usernameCiphertext,
      candidateUsernameNormalizedCiphertext: usernameNormalizedCiphertext,
      candidateDisplayNameCiphertext: displayNameCiphertext,
      candidateUserHandleRef: intent.candidate.userHandleRef,
      candidateUserHandleDigest: passkeyBytesDigest(userHandle),
      candidateUserHandleCiphertext: userHandleCiphertext,
      challengeReference: intent.challenge.reference,
      challengeDigest: intent.challenge.digest,
      deliveryNonceDigest: intent.deliveryNonceDigest,
      createdAtMs: intent.createdAtMs,
      expiresAtMs: intent.expiresAtMs,
      updatedAtMs: intent.updatedAtMs
    });
  }

  #persistPasskeySignupEventAndOutbox(input: PasskeySignupMutationRecord): void {
    const payload = {
      type: input.event.type,
      intentId: input.event.intentId,
      revision: input.event.revision,
      state: input.event.state
    };
    this.#db.prepare(`
      INSERT INTO passkey_signup_events (
        event_id, intent_id, revision, event_type, command_scope,
        occurred_at_ms, event_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.event.eventId,
      input.event.intentId,
      input.event.revision,
      input.event.type,
      input.event.commandScope,
      input.event.occurredAtMs,
      JSON.stringify(payload)
    );
    this.#db.prepare(`
      INSERT INTO passkey_signup_outbox (
        outbox_id, event_id, topic, partition_key, available_at_ms, payload_json
      ) VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      input.outbox.outboxId,
      input.outbox.eventId,
      input.outbox.topic,
      input.outbox.partitionKey,
      input.outbox.availableAtMs,
      JSON.stringify(payload)
    );
  }

  #persistPasskeySignupReceipt(
    table: "passkey_signup_command_receipts" | "passkey_signup_creation_receipts",
    receipt: PasskeySignupReceiptRecord
  ): void {
    this.#db.prepare(`
      INSERT INTO ${table} (
        scope, fingerprint, intent_id, result_revision, result_state,
        event_id, result_json, created_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      receipt.scope,
      receipt.fingerprint,
      receipt.intentId,
      receipt.resultRevision,
      receipt.resultState,
      receipt.eventId,
      JSON.stringify({
        intentId: receipt.intentId,
        revision: receipt.resultRevision,
        state: receipt.resultState
      }),
      receipt.createdAtMs
    );
  }

  async commitPasskeySignupBegin(input: PersistPasskeySignupBegin): Promise<void> {
    assertPasskeySignupBeginShape(input);
    this.#db.transaction(() => {
      this.#assertNoPasskeySignupReceiptDuplicates(input.commandReceipt, input.creationReceipt);
      const existing = this.#db.prepare(`
        SELECT 1 AS present FROM passkey_signup_intents WHERE intent_id = ?
      `).get(input.intent.intentId) as { present: number } | undefined;
      if (existing !== undefined) throw new StoreRevisionConflictError();
      this.#assertPasskeyIntentChallengeLease(input.intent);
      this.#insertPasskeySignupIntent(input.intent);
      this.#persistPasskeySignupEventAndOutbox(input);
      this.#persistPasskeySignupReceipt(
        "passkey_signup_command_receipts", input.commandReceipt
      );
      this.#persistPasskeySignupReceipt(
        "passkey_signup_creation_receipts", input.creationReceipt
      );
    }).immediate();
  }

  async commitPasskeySignupRejectedAttempt(
    input: PersistPasskeySignupRejectedAttempt
  ): Promise<void> {
    assertPasskeySignupRejectedShape(input);
    this.#db.transaction(() => {
      this.#assertNoPasskeySignupReceiptDuplicates(input.commandReceipt, null);
      const row = this.#db.prepare(`
        SELECT * FROM passkey_signup_intents WHERE intent_id = ?
      `).get(input.intentId) as PasskeySignupIntentRow | undefined;
      if (row === undefined || row.revision !== input.expectedRevision) {
        throw new StoreRevisionConflictError();
      }
      const current = mapPasskeySignupIntent(row, this.contentCipher);
      const writerNowMs = this.passkeyNowMs();
      const attemptsUsed = current.attemptsUsed + 1;
      const expectedState = attemptsUsed === current.maxAttempts ? "rejected" : "pending";
      if (
        current.state !== "pending"
        || input.nextState !== expectedState
        || input.updatedAtMs < current.updatedAtMs
        || input.updatedAtMs >= current.expiresAtMs
        || !isPasskeySafeInteger(writerNowMs, input.updatedAtMs)
        || writerNowMs >= current.expiresAtMs
      ) throw new StoreRevisionConflictError();
      const updated = this.#db.prepare(`
        UPDATE passkey_signup_intents
        SET state = @state,
            revision = @revision,
            attempts_used = @attemptsUsed,
            updated_at_ms = @updatedAtMs,
            terminal_at_ms = @terminalAtMs,
            terminal_reason = @terminalReason
        WHERE intent_id = @intentId
          AND state = 'pending'
          AND revision = @expectedRevision
          AND attempts_used = @previousAttemptsUsed
      `).run({
        intentId: current.intentId,
        expectedRevision: input.expectedRevision,
        previousAttemptsUsed: current.attemptsUsed,
        state: input.nextState,
        revision: input.expectedRevision + 1,
        attemptsUsed,
        updatedAtMs: input.updatedAtMs,
        terminalAtMs: input.nextState === "rejected" ? input.updatedAtMs : null,
        terminalReason: input.nextState === "rejected" ? "attempts_exhausted" : null
      });
      if (updated.changes !== 1) throw new StoreRevisionConflictError();
      this.#persistPasskeySignupEventAndOutbox(input);
      this.#persistPasskeySignupReceipt(
        "passkey_signup_command_receipts", input.commandReceipt
      );
      if (input.nextState === "rejected") {
        this.#db.prepare(`
          DELETE FROM passkey_challenge_secrets WHERE reference = ?
        `).run(current.challenge.reference);
      }
    }).immediate();
  }

  async commitPasskeySignupExpired(input: PersistPasskeySignupExpired): Promise<void> {
    assertPasskeySignupExpiredShape(input);
    this.#db.transaction(() => {
      this.#assertNoPasskeySignupReceiptDuplicates(input.commandReceipt, null);
      const row = this.#db.prepare(`
        SELECT * FROM passkey_signup_intents WHERE intent_id = ?
      `).get(input.intentId) as PasskeySignupIntentRow | undefined;
      if (row === undefined || row.revision !== input.expectedRevision) {
        throw new StoreRevisionConflictError();
      }
      const current = mapPasskeySignupIntent(row, this.contentCipher);
      const writerNowMs = this.passkeyNowMs();
      if (
        current.state !== "pending"
        || input.terminalAtMs < current.updatedAtMs
        || input.terminalAtMs < current.expiresAtMs
        || !isPasskeySafeInteger(writerNowMs, input.terminalAtMs)
      ) throw new StoreRevisionConflictError();
      const updated = this.#db.prepare(`
        UPDATE passkey_signup_intents
        SET state = 'expired',
            revision = @revision,
            updated_at_ms = @terminalAtMs,
            terminal_at_ms = @terminalAtMs,
            terminal_reason = 'expired'
        WHERE intent_id = @intentId
          AND state = 'pending'
          AND revision = @expectedRevision
          AND attempts_used = @attemptsUsed
      `).run({
        intentId: current.intentId,
        expectedRevision: input.expectedRevision,
        attemptsUsed: current.attemptsUsed,
        revision: input.expectedRevision + 1,
        terminalAtMs: input.terminalAtMs
      });
      if (updated.changes !== 1) throw new StoreRevisionConflictError();
      this.#persistPasskeySignupEventAndOutbox(input);
      this.#persistPasskeySignupReceipt(
        "passkey_signup_command_receipts", input.commandReceipt
      );
      this.#db.prepare(`
        DELETE FROM passkey_challenge_secrets WHERE reference = ?
      `).run(current.challenge.reference);
    }).immediate();
  }

  async commitVerifiedPasskeySignup(input: PersistVerifiedPasskeySignup): Promise<void> {
    assertVerifiedPasskeySignupShape(input);
    this.#db.transaction(() => {
      this.#assertNoPasskeySignupReceiptDuplicates(input.commandReceipt, null);
      const row = this.#db.prepare(`
        SELECT * FROM passkey_signup_intents WHERE intent_id = ?
      `).get(input.intentId) as PasskeySignupIntentRow | undefined;
      if (row === undefined || row.revision !== input.expectedRevision) {
        throw new StoreRevisionConflictError();
      }
      const current = mapPasskeySignupIntent(row, this.contentCipher);
      const writerNowMs = this.passkeyNowMs();
      const sessionExpiresAtMs = passkeyIsoTimestampMs(input.session.expiresAt);
      if (
        current.state !== "pending"
        || input.committedAtMs < current.updatedAtMs
        || input.committedAtMs >= current.expiresAtMs
        || !isPasskeySafeInteger(writerNowMs, input.committedAtMs)
        || writerNowMs >= current.expiresAtMs
        || Math.floor(writerNowMs / 1_000) >= input.accessToken.expiresAtSec
        || sessionExpiresAtMs === null
        || input.candidate.accountId !== current.candidate.accountId
        || input.candidate.username !== current.candidate.username
        || input.candidate.usernameNormalized !== current.candidate.usernameNormalized
        || input.candidate.displayName !== current.candidate.displayName
        || input.candidate.userHandleRef !== current.candidate.userHandleRef
        || !Buffer.from(input.candidate.userHandle).equals(
          Buffer.from(current.candidate.userHandle)
        )
        || input.refreshToken.deliveryNonceDigest !== current.deliveryNonceDigest
      ) throw new StoreRevisionConflictError();
      this.#assertPasskeyIntentChallengeLease(current);

      const userHandleEncoded = Buffer.from(input.candidate.userHandle).toString("base64url");
      const userHandleDigest = passkeyDigest(userHandleEncoded);
      const credentialIdDigest = passkeyDigest(input.credential.credentialId);
      const collision = this.#db.prepare(`
        SELECT
          EXISTS(SELECT 1 FROM users WHERE id = @accountId) AS account_id,
          EXISTS(SELECT 1 FROM users WHERE username_normalized = @usernameNormalized) AS username,
          EXISTS(SELECT 1 FROM passkey_user_handles
            WHERE reference = @userHandleRef OR account_id = @accountId
              OR handle_digest = @userHandleDigest) AS user_handle,
          EXISTS(SELECT 1 FROM passkey_credentials
            WHERE record_id = @credentialRecordId) AS credential_record,
          EXISTS(SELECT 1 FROM passkey_credentials
            WHERE credential_id_digest = @credentialIdDigest) AS credential_id,
          EXISTS(SELECT 1 FROM device_sessions WHERE id = @sessionId) AS session_id,
          EXISTS(SELECT 1 FROM refresh_tokens
            WHERE id = @refreshTokenId OR token_hash = @refreshTokenHash) AS refresh_token
      `).get({
        accountId: input.candidate.accountId,
        usernameNormalized: input.candidate.usernameNormalized,
        userHandleRef: input.candidate.userHandleRef,
        userHandleDigest,
        credentialRecordId: input.credential.credentialRecordId,
        credentialIdDigest,
        sessionId: input.session.id,
        refreshTokenId: input.refreshToken.id,
        refreshTokenHash: input.refreshToken.tokenHash
      }) as {
        account_id: number;
        username: number;
        user_handle: number;
        credential_record: number;
        credential_id: number;
        session_id: number;
        refresh_token: number;
      };
      if (collision.credential_id !== 0) throw new StoreCredentialConflictError();
      if (
        collision.account_id !== 0
        || collision.username !== 0
        || collision.user_handle !== 0
        || collision.credential_record !== 0
        || collision.session_id !== 0
        || collision.refresh_token !== 0
      ) throw new StoreRevisionConflictError();

      this.#db.prepare(`
        INSERT INTO users (
          id, username, username_normalized, display_name, password_hash,
          password_auth_enabled, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, 0, ?, ?)
      `).run(
        input.candidate.accountId,
        input.candidate.username,
        input.candidate.usernameNormalized,
        input.candidate.displayName,
        input.passwordAuth.disabledHash,
        input.session.createdAt,
        input.session.createdAt
      );
      this.#db.prepare(`
        INSERT INTO account_privacy_settings (user_id, updated_at) VALUES (?, ?)
      `).run(input.candidate.accountId, input.session.createdAt);
      this.#insertPasskeyUserHandleBinding({
        reference: input.candidate.userHandleRef,
        accountId: input.candidate.accountId,
        userHandle: userHandleEncoded,
        createdAtMs: current.createdAtMs
      });
      this.#db.prepare(`
        INSERT INTO device_sessions (
          id, user_id, device_name, created_at, last_seen_at, expires_at
        ) VALUES (@id, @userId, @deviceName, @createdAt, @createdAt, @expiresAt)
      `).run(input.session);
      this.#db.prepare(`
        INSERT INTO refresh_tokens (id, session_id, token_hash, created_at, expires_at)
        VALUES (@id, @sessionId, @tokenHash, @createdAt, @expiresAt)
      `).run({
        id: input.refreshToken.id,
        sessionId: input.refreshToken.sessionId,
        tokenHash: input.refreshToken.tokenHash,
        createdAt: input.refreshToken.createdAt,
        expiresAt: input.refreshToken.expiresAt
      });

      this.#db.prepare(`
        INSERT INTO passkey_signup_consumptions (
          intent_id, result_revision, result_state, account_id, user_handle_ref,
          credential_record_id, session_id, initial_refresh_token_id,
          initial_access_token_expires_at_sec, refresh_derivation_key_id,
          committed_at_ms
        ) VALUES (?, ?, 'consumed', ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        input.intentId,
        input.expectedRevision + 1,
        input.candidate.accountId,
        input.candidate.userHandleRef,
        input.credential.credentialRecordId,
        input.session.id,
        input.refreshToken.id,
        input.accessToken.expiresAtSec,
        input.refreshToken.derivationKeyId,
        input.committedAtMs
      );

      const credentialIdCiphertext = this.#encryptPasskeyValue(
        input.credential.credentialId,
        `passkey-credential-id:${input.credential.credentialRecordId}`
      );
      const credentialMaterialCiphertext = this.#encryptPasskeyValue(
        JSON.stringify({
          accountId: input.candidate.accountId,
          algorithm: input.credential.algorithm,
          credentialSetRef: null,
          discoveryMode: input.credential.discoveryMode,
          publicKey: Buffer.from(input.credential.publicKey).toString("base64url"),
          transports: [...input.credential.transports],
          userHandleRef: input.candidate.userHandleRef
        }),
        `passkey-credential-material:${input.credential.credentialRecordId}`
      );
      this.#db.prepare(`
        INSERT INTO passkey_credentials (
          record_id, credential_id_digest, credential_id_ciphertext, account_id,
          user_handle_ref, credential_material_ciphertext, algorithm, discovery_mode,
          credential_set_ref, revision, sign_count, backup_eligible, backup_state,
          registration_ceremony_id, created_at_ms, updated_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'discoverable', NULL, 1, ?, ?, ?, ?, ?, ?)
      `).run(
        input.credential.credentialRecordId,
        credentialIdDigest,
        credentialIdCiphertext,
        input.candidate.accountId,
        input.candidate.userHandleRef,
        credentialMaterialCiphertext,
        input.credential.algorithm,
        input.credential.signCount,
        input.credential.backupEligible ? 1 : 0,
        input.credential.backupState ? 1 : 0,
        input.intentId,
        input.committedAtMs,
        input.committedAtMs
      );
      this.#insertInitialPasskeyAuthenticatorMetadata({
        credentialRecordId: input.credential.credentialRecordId,
        accountId: input.candidate.accountId,
        createdAtMs: input.committedAtMs
      });
      this.#db.prepare(`
        INSERT INTO passkey_session_credential_origins (
          session_id, account_id, credential_record_id, created_at_ms
        ) VALUES (?, ?, ?, ?)
      `).run(
        input.session.id,
        input.candidate.accountId,
        input.credential.credentialRecordId,
        input.committedAtMs
      );

      const consumed = this.#db.prepare(`
        UPDATE passkey_signup_intents
        SET state = 'consumed',
            revision = @revision,
            updated_at_ms = @committedAtMs,
            terminal_at_ms = @committedAtMs,
            terminal_reason = 'verified',
            resolved_credential_record_id = @credentialRecordId
        WHERE intent_id = @intentId
          AND state = 'pending'
          AND revision = @expectedRevision
          AND attempts_used = @attemptsUsed
      `).run({
        intentId: current.intentId,
        expectedRevision: input.expectedRevision,
        attemptsUsed: current.attemptsUsed,
        revision: input.expectedRevision + 1,
        committedAtMs: input.committedAtMs,
        credentialRecordId: input.credential.credentialRecordId
      });
      if (consumed.changes !== 1) throw new StoreRevisionConflictError();

      this.#persistPasskeySignupEventAndOutbox(input);
      this.#persistPasskeySignupReceipt(
        "passkey_signup_command_receipts",
        input.commandReceipt
      );
      this.#db.prepare(`
        DELETE FROM passkey_challenge_secrets WHERE reference = ?
      `).run(current.challenge.reference);
    }).immediate();
  }

  async loadCeremony(ceremonyId: string): Promise<CeremonyAggregate | null> {
    if (!isPasskeyOpaqueId(ceremonyId)) return null;
    const row = this.#db.prepare(`
      SELECT * FROM passkey_ceremonies WHERE ceremony_id = ?
    `).get(ceremonyId) as PasskeyCeremonyRow | undefined;
    return row === undefined ? null : mapPasskeyCeremony(row);
  }

  async findCommandReceipt(scope: string): Promise<CommandReceipt | null> {
    if (!isPasskeyOpaqueId(scope)) return null;
    const row = this.#db.prepare(`
      SELECT receipts.*,
             events.event_id AS linked_event_id,
             events.ceremony_id AS linked_ceremony_id,
             events.revision AS linked_revision
      FROM passkey_command_receipts receipts
      LEFT JOIN passkey_ceremony_events events ON events.event_id = receipts.event_id
      WHERE receipts.scope = ?
    `).get(scope) as PasskeyReceiptRow | undefined;
    return row === undefined ? null : mapPasskeyReceipt<CommandReceipt>(row, scope);
  }

  async findCreationReceipt(scope: string): Promise<CreationReceipt | null> {
    if (!isPasskeyOpaqueId(scope)) return null;
    const row = this.#db.prepare(`
      SELECT receipts.*,
             events.event_id AS linked_event_id,
             events.ceremony_id AS linked_ceremony_id,
             events.revision AS linked_revision
      FROM passkey_creation_receipts receipts
      LEFT JOIN passkey_ceremony_events events ON events.event_id = receipts.event_id
      WHERE receipts.scope = ?
    `).get(scope) as PasskeyReceiptRow | undefined;
    return row === undefined ? null : mapPasskeyReceipt<CreationReceipt>(row, scope);
  }

  #isActivePasskeySession(
    accountId: string,
    sessionId: string,
    deviceId: string,
    operationTimeMs: number
  ): boolean {
    if (deviceId !== sessionId) return false;
    const operationTime = passkeyTimestampIso(operationTimeMs);
    const active = this.#db.prepare(`
      SELECT 1 AS active
      FROM device_sessions
      WHERE id = ?
        AND user_id = ?
        AND revoked_at IS NULL
        AND expires_at > ?
    `).get(sessionId, accountId, operationTime) as { active: number } | undefined;
    return active !== undefined;
  }

  #assertNoPasskeyReceiptDuplicates(input: PersistCeremonyMutation): void {
    const duplicateCommand = this.#db.prepare(`
      SELECT 1 AS present FROM passkey_command_receipts WHERE scope = ?
    `).get(input.commandReceipt.scope) as { present: number } | undefined;
    if (duplicateCommand !== undefined) throw new StoreDuplicateCommandError();
    if (input.creationReceipt !== null) {
      const duplicateCreation = this.#db.prepare(`
        SELECT 1 AS present FROM passkey_creation_receipts WHERE scope = ?
      `).get(input.creationReceipt.scope) as { present: number } | undefined;
      if (duplicateCreation !== undefined) throw new StoreDuplicateCreationError();
    }
  }

  #assertInitialPasskeyRegistrationShape(input: PersistCeremonyMutation): void {
    const { snapshot, event, secureCredentialEffect } = input.mutation;
    if (
      input.expectedRevision !== null
      || input.creationReceipt === null
      || snapshot.kind !== "registration"
      || snapshot.purpose.type !== "authenticator.add"
      || snapshot.state !== "pending"
      || snapshot.revision !== 1
      || snapshot.attemptsUsed !== 0
      || snapshot.createdAtMs !== snapshot.updatedAtMs
      || snapshot.terminalAtMs !== null
      || snapshot.terminalReason !== null
      || snapshot.riskSignals.length !== 0
      || event.type !== "passkey.ceremony.started"
      || secureCredentialEffect !== null
    ) {
      passkeyIntegrityFailure();
    }
  }

  #assertPasskeyAuthenticatorRevokeBeginShape(
    input: PersistCeremonyMutation,
    intent: PasskeyAuthenticatorRevokeIntentRecord
  ): void {
    const { snapshot, event, secureCredentialEffect } = input.mutation;
    if (
      intent === null
      || typeof intent !== "object"
      || Array.isArray(intent)
      || Object.keys(intent).sort().join(",")
        !== "accountId,authenticationCeremonyId,createdAtMs,credentialRecordId,deviceId,expectedAuthenticatorRevision,purpose,sessionId,targetDigest"
      || !isPasskeyOpaqueId(intent.authenticationCeremonyId)
      || !isPasskeyOpaqueId(intent.accountId)
      || !isPasskeyOpaqueId(intent.sessionId)
      || intent.deviceId !== intent.sessionId
      || !isPasskeyOpaqueId(intent.credentialRecordId)
      || !isPasskeySafeInteger(intent.expectedAuthenticatorRevision, 1)
      || intent.purpose !== "authenticator.revoke"
      || !isPasskeyDigest(intent.targetDigest)
      || !isPasskeySafeInteger(intent.createdAtMs)
      || intent.targetDigest !== passkeyAuthenticatorRevokeTargetDigest({
        accountId: intent.accountId,
        sessionId: intent.sessionId,
        credentialRecordId: intent.credentialRecordId,
        expectedRevision: intent.expectedAuthenticatorRevision
      })
      || input.expectedRevision !== null
      || input.creationReceipt === null
      || snapshot.kind !== "authentication"
      || snapshot.purpose.type !== "session.step_up"
      || snapshot.state !== "pending"
      || snapshot.revision !== 1
      || snapshot.attemptsUsed !== 0
      || snapshot.createdAtMs !== snapshot.updatedAtMs
      || snapshot.terminalAtMs !== null
      || snapshot.terminalReason !== null
      || snapshot.riskSignals.length !== 0
      || event.type !== "passkey.ceremony.started"
      || secureCredentialEffect !== null
      || snapshot.ceremonyId !== intent.authenticationCeremonyId
      || snapshot.actor.accountId !== intent.accountId
      || snapshot.actor.sessionId !== intent.sessionId
      || snapshot.actor.deviceId !== intent.deviceId
      || snapshot.purpose.targetDigest !== intent.targetDigest
      || snapshot.createdAtMs !== intent.createdAtMs
    ) {
      passkeyIntegrityFailure();
    }
  }

  #createPasskeyStepUpGrant(input: PersistCeremonyMutation): void {
    const { snapshot, event, secureCredentialEffect } = input.mutation;
    if (
      snapshot.kind !== "authentication"
      || snapshot.purpose.type !== "session.step_up"
      || snapshot.state !== "consumed"
      || snapshot.terminalReason !== "verified"
      || event.type !== "passkey.ceremony.consumed"
      || secureCredentialEffect?.type !== "update_authentication_credential"
      || secureCredentialEffect.ceremonyId !== snapshot.ceremonyId
    ) {
      passkeyIntegrityFailure();
    }
    const issuedAtSec = Math.floor(snapshot.updatedAtMs / 1_000);
    const expiresAtSec = issuedAtSec + PASSKEY_STEP_UP_GRANT_TTL_SECONDS;
    const commitNowMs = this.passkeyNowMs();
    if (
      !isPasskeySafeInteger(issuedAtSec)
      || !isPasskeySafeInteger(expiresAtSec)
      || !isPasskeySafeInteger(commitNowMs)
    ) {
      passkeyIntegrityFailure();
    }
    if (
      commitNowMs < snapshot.updatedAtMs
      || Math.floor(commitNowMs / 1_000) >= expiresAtSec
      || !this.#isActivePasskeySession(
        snapshot.actor.accountId,
        snapshot.actor.sessionId,
        snapshot.actor.deviceId,
        commitNowMs
      )
    ) {
      throw new StoreCredentialStateConflictError();
    }
    this.#db.prepare(`
      INSERT INTO passkey_step_up_grants (
        authentication_ceremony_id, account_id, session_id, device_id,
        purpose, target_digest, auth_time_sec, issued_at_sec, expires_at_sec,
        consumed_at_sec, registration_ceremony_id
      ) VALUES (?, ?, ?, ?, 'authenticator.add', ?, ?, ?, ?, NULL, NULL)
    `).run(
      snapshot.ceremonyId,
      snapshot.actor.accountId,
      snapshot.actor.sessionId,
      snapshot.actor.deviceId,
      snapshot.purpose.targetDigest,
      issuedAtSec,
      issuedAtSec,
      expiresAtSec
    );
  }

  #createPasskeyAuthenticatorRevokeGrant(
    input: PersistCeremonyMutation,
    intent: PasskeyAuthenticatorRevokeIntentRecord
  ): void {
    const { snapshot, event, secureCredentialEffect } = input.mutation;
    if (
      snapshot.kind !== "authentication"
      || snapshot.purpose.type !== "session.step_up"
      || snapshot.state !== "consumed"
      || snapshot.terminalReason !== "verified"
      || event.type !== "passkey.ceremony.consumed"
      || secureCredentialEffect?.type !== "update_authentication_credential"
      || secureCredentialEffect.ceremonyId !== snapshot.ceremonyId
      || intent.authenticationCeremonyId !== snapshot.ceremonyId
      || intent.accountId !== snapshot.actor.accountId
      || intent.sessionId !== snapshot.actor.sessionId
      || intent.deviceId !== snapshot.actor.deviceId
      || intent.targetDigest !== snapshot.purpose.targetDigest
      || intent.purpose !== "authenticator.revoke"
      || intent.createdAtMs !== snapshot.createdAtMs
      || intent.targetDigest !== passkeyAuthenticatorRevokeTargetDigest({
        accountId: intent.accountId,
        sessionId: intent.sessionId,
        credentialRecordId: intent.credentialRecordId,
        expectedRevision: intent.expectedAuthenticatorRevision
      })
    ) passkeyIntegrityFailure();

    const issuedAtSec = Math.floor(snapshot.updatedAtMs / 1_000);
    const expiresAtSec = issuedAtSec + PASSKEY_STEP_UP_GRANT_TTL_SECONDS;
    const commitNowMs = this.passkeyNowMs();
    if (
      !isPasskeySafeInteger(issuedAtSec)
      || !isPasskeySafeInteger(expiresAtSec)
      || !isPasskeySafeInteger(commitNowMs, snapshot.updatedAtMs)
      || Math.floor(commitNowMs / 1_000) >= expiresAtSec
      || !this.#isActivePasskeySession(
        snapshot.actor.accountId,
        snapshot.actor.sessionId,
        snapshot.actor.deviceId,
        commitNowMs
      )
    ) throw new StoreCredentialStateConflictError();

    const metadataRow = this.#db.prepare(`
      SELECT * FROM passkey_authenticator_metadata
      WHERE account_id = ? AND credential_record_id = ?
    `).get(intent.accountId, intent.credentialRecordId) as PasskeyAuthenticatorMetadataRow | undefined;
    if (metadataRow === undefined) throw new StoreCredentialStateConflictError();
    const authenticator = this.#mapPasskeyAuthenticatorMetadata(metadataRow);
    if (
      authenticator.lifecycleState !== "active"
      || authenticator.revision !== intent.expectedAuthenticatorRevision
    ) throw new StoreCredentialStateConflictError();

    this.#db.prepare(`
      INSERT INTO passkey_authenticator_step_up_grants (
        authentication_ceremony_id, account_id, session_id, device_id,
        credential_record_id, expected_authenticator_revision, purpose,
        target_digest, auth_time_sec, issued_at_sec, expires_at_sec,
        consumed_at_sec, management_command_scope
      ) VALUES (?, ?, ?, ?, ?, ?, 'authenticator.revoke', ?, ?, ?, ?, NULL, NULL)
    `).run(
      intent.authenticationCeremonyId,
      intent.accountId,
      intent.sessionId,
      intent.deviceId,
      intent.credentialRecordId,
      intent.expectedAuthenticatorRevision,
      intent.targetDigest,
      issuedAtSec,
      issuedAtSec,
      expiresAtSec
    );
  }

  #insertPasskeyAuthenticatorRevokeIntent(
    intent: PasskeyAuthenticatorRevokeIntentRecord
  ): void {
    this.#db.prepare(`
      INSERT INTO passkey_authenticator_revoke_intents (
        authentication_ceremony_id, account_id, session_id, device_id,
        credential_record_id, expected_authenticator_revision, purpose,
        target_digest, created_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, 'authenticator.revoke', ?, ?)
    `).run(
      intent.authenticationCeremonyId,
      intent.accountId,
      intent.sessionId,
      intent.deviceId,
      intent.credentialRecordId,
      intent.expectedAuthenticatorRevision,
      intent.targetDigest,
      intent.createdAtMs
    );
  }

  #insertPasskeyCeremony(snapshot: CeremonyAggregate): void {
    this.#db.prepare(`
      INSERT INTO passkey_ceremonies (
        ceremony_id, schema_version, kind, purpose_type, purpose_target_digest,
        account_id, session_id, device_id, user_handle_ref, challenge_reference, challenge_digest,
        state, revision, attempts_used, max_attempts, expires_at_ms, updated_at_ms,
        snapshot_json
      ) VALUES (
        @ceremonyId, @schemaVersion, @kind, @purposeType, @purposeTargetDigest,
        @accountId, @sessionId, @deviceId, @userHandleRef, @challengeReference, @challengeDigest,
        @state, @revision, @attemptsUsed, @maxAttempts, @expiresAtMs, @updatedAtMs,
        @snapshotJson
      )
    `).run({
      ceremonyId: snapshot.ceremonyId,
      schemaVersion: snapshot.schemaVersion,
      kind: snapshot.kind,
      purposeType: snapshot.purpose.type,
      purposeTargetDigest: snapshot.purpose.targetDigest,
      accountId: snapshot.actor.accountId,
      sessionId: snapshot.actor.sessionId,
      deviceId: snapshot.actor.deviceId,
      userHandleRef: snapshot.userHandleRef,
      challengeReference: snapshot.challenge.reference,
      challengeDigest: snapshot.challenge.digest,
      state: snapshot.state,
      revision: snapshot.revision,
      attemptsUsed: snapshot.attemptsUsed,
      maxAttempts: snapshot.maxAttempts,
      expiresAtMs: snapshot.expiresAtMs,
      updatedAtMs: snapshot.updatedAtMs,
      snapshotJson: JSON.stringify(snapshot)
    });
  }

  #updatePasskeyCeremony(snapshot: CeremonyAggregate, expectedRevision: number): void {
    const updated = this.#db.prepare(`
      UPDATE passkey_ceremonies
      SET state = @state,
          revision = @revision,
          attempts_used = @attemptsUsed,
          updated_at_ms = @updatedAtMs,
          snapshot_json = @snapshotJson
      WHERE ceremony_id = @ceremonyId AND revision = @expectedRevision
    `).run({
      ceremonyId: snapshot.ceremonyId,
      expectedRevision,
      state: snapshot.state,
      revision: snapshot.revision,
      attemptsUsed: snapshot.attemptsUsed,
      updatedAtMs: snapshot.updatedAtMs,
      snapshotJson: JSON.stringify(snapshot)
    });
    if (updated.changes !== 1) throw new StoreRevisionConflictError();
  }

  #persistPasskeyEventAndOutbox(input: PersistCeremonyMutation): void {
    const { event, outbox } = input.mutation;
    this.#db.prepare(`
      INSERT INTO passkey_ceremony_events (
        event_id, ceremony_id, revision, event_type, command_id, occurred_at_ms, event_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      event.eventId,
      event.ceremonyId,
      event.revision,
      event.type,
      event.commandId,
      event.occurredAtMs,
      JSON.stringify(event)
    );
    this.#db.prepare(`
      INSERT INTO passkey_ceremony_outbox (
        outbox_id, event_id, topic, partition_key, available_at_ms, payload_json
      ) VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      outbox.outboxId,
      outbox.eventId,
      outbox.topic,
      outbox.partitionKey,
      outbox.availableAtMs,
      JSON.stringify(outbox.payload)
    );
  }

  #applyPasskeyCredentialEffect(input: PersistCeremonyMutation): void {
    const effect = input.mutation.secureCredentialEffect;
    if (effect === null) return;
    const snapshot = input.mutation.snapshot;
    if (effect.ceremonyId !== snapshot.ceremonyId || snapshot.state !== "consumed") {
      passkeyIntegrityFailure();
    }
    if (effect.type === "store_registration_credential") {
      try {
        assertRegistrationCredential(effect.credential, snapshot);
      } catch {
        passkeyIntegrityFailure();
      }
      const commitNowMs = this.passkeyNowMs();
      if (!isPasskeySafeInteger(commitNowMs)) passkeyIntegrityFailure();
      if (
        commitNowMs < snapshot.updatedAtMs
        || !this.#isActivePasskeySession(
          snapshot.actor.accountId,
          snapshot.actor.sessionId,
          snapshot.actor.deviceId,
          commitNowMs
        )
      ) {
        throw new StoreCredentialStateConflictError();
      }
      const credential = effect.credential;
      const grantRow = this.#db.prepare(`
        SELECT * FROM passkey_step_up_grants
        WHERE registration_ceremony_id = ?
      `).get(snapshot.ceremonyId) as PasskeyStepUpGrantRow | undefined;
      if (grantRow === undefined) passkeyIntegrityFailure();
      const grant = mapPasskeyStepUpGrant(grantRow);
      if (
        grant.consumedAtSec === null
        || grant.registrationCeremonyId !== snapshot.ceremonyId
        || grant.accountId !== snapshot.actor.accountId
        || grant.accountId !== credential.accountId
        || grant.sessionId !== snapshot.actor.sessionId
        || grant.deviceId !== snapshot.actor.deviceId
        || grant.purpose !== snapshot.purpose.type
        || grant.targetDigest !== snapshot.purpose.targetDigest
      ) {
        passkeyIntegrityFailure();
      }
      const credentialIdDigest = passkeyDigest(credential.credentialId);
      const duplicateCredential = this.#db.prepare(`
        SELECT 1 AS present FROM passkey_credentials WHERE credential_id_digest = ?
      `).get(credentialIdDigest) as { present: number } | undefined;
      if (duplicateCredential !== undefined) throw new StoreCredentialConflictError();
      const accountCredentialCount = this.#db.prepare(`
        SELECT COUNT(*) AS count
        FROM passkey_authenticator_metadata
        WHERE account_id = ? AND lifecycle_state = 'active'
      `).get(credential.accountId) as { count: number };
      if (accountCredentialCount.count >= PASSKEY_ACCOUNT_CREDENTIAL_LIMIT) {
        throw new StoreCredentialConflictError();
      }
      const duplicateRecord = this.#db.prepare(`
        SELECT 1 AS present FROM passkey_credentials WHERE record_id = ?
      `).get(effect.credentialRecordId) as { present: number } | undefined;
      if (duplicateRecord !== undefined) passkeyIntegrityFailure();
      const handleRow = this.#db.prepare(`
        SELECT * FROM passkey_user_handles WHERE reference = ?
      `).get(credential.userHandleRef) as PasskeyUserHandleRow | undefined;
      if (
        handleRow === undefined
        || this.#mapPasskeyUserHandle(handleRow).accountId !== credential.accountId
      ) {
        passkeyIntegrityFailure();
      }
      const credentialIdCiphertext = this.#encryptPasskeyValue(
        credential.credentialId,
        `passkey-credential-id:${effect.credentialRecordId}`
      );
      const credentialMaterialCiphertext = this.#encryptPasskeyValue(
        JSON.stringify({
          accountId: credential.accountId,
          algorithm: credential.algorithm,
          credentialSetRef: null,
          discoveryMode: credential.discoveryMode,
          publicKey: Buffer.from(credential.publicKey).toString("base64url"),
          transports: [...credential.transports],
          userHandleRef: credential.userHandleRef
        }),
        `passkey-credential-material:${effect.credentialRecordId}`
      );
      this.#db.prepare(`
        INSERT INTO passkey_credentials (
          record_id, credential_id_digest, credential_id_ciphertext, account_id,
          user_handle_ref, credential_material_ciphertext, algorithm, discovery_mode,
          credential_set_ref, revision, sign_count, backup_eligible, backup_state,
          registration_ceremony_id, created_at_ms, updated_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, 1, ?, ?, ?, ?, ?, ?)
      `).run(
        effect.credentialRecordId,
        credentialIdDigest,
        credentialIdCiphertext,
        credential.accountId,
        credential.userHandleRef,
        credentialMaterialCiphertext,
        credential.algorithm,
        credential.discoveryMode,
        credential.signCount,
        credential.backupEligible ? 1 : 0,
        credential.backupState ? 1 : 0,
        effect.ceremonyId,
        snapshot.updatedAtMs,
        snapshot.updatedAtMs
      );
      this.#insertInitialPasskeyAuthenticatorMetadata({
        credentialRecordId: effect.credentialRecordId,
        accountId: credential.accountId,
        createdAtMs: snapshot.updatedAtMs
      });
      return;
    }

    try {
      assertAuthenticationCredential(effect.credential, snapshot);
    } catch {
      passkeyIntegrityFailure();
    }
    if (canonicalPasskeyJson(effect.riskSignals) !== canonicalPasskeyJson(snapshot.riskSignals)) {
      passkeyIntegrityFailure();
    }
    const credential = effect.credential;
    const updated = this.#db.prepare(`
      UPDATE passkey_credentials
      SET revision = revision + 1,
          sign_count = @newSignCount,
          backup_state = @backupState,
          updated_at_ms = @updatedAtMs
      WHERE record_id = @recordId
        AND account_id = @accountId
        AND discovery_mode = @discoveryMode
        AND revision = @credentialRevision
        AND sign_count = @previousSignCount
        AND backup_eligible = @previousBackupEligible
        AND backup_state = @previousBackupState
        AND updated_at_ms <= @updatedAtMs
        AND EXISTS (
          SELECT 1 FROM passkey_authenticator_metadata metadata
          WHERE metadata.credential_record_id = passkey_credentials.record_id
            AND metadata.account_id = passkey_credentials.account_id
            AND metadata.lifecycle_state = 'active'
        )
    `).run({
      recordId: credential.credentialRecordId,
      accountId: credential.accountId,
      discoveryMode: credential.discoveryMode,
      credentialRevision: credential.credentialRevision,
      previousSignCount: credential.previousSignCount,
      newSignCount: credential.newSignCount,
      previousBackupEligible: credential.previousBackupEligible ? 1 : 0,
      previousBackupState: credential.previousBackupState ? 1 : 0,
      backupState: credential.backupState ? 1 : 0,
      updatedAtMs: snapshot.updatedAtMs
    });
    if (updated.changes !== 1) throw new StoreCredentialStateConflictError();
  }

  #persistPasskeyReceipt(table: "passkey_command_receipts" | "passkey_creation_receipts", receipt: CommandReceipt | CreationReceipt): void {
    this.#db.prepare(`
      INSERT INTO ${table} (
        scope, fingerprint, ceremony_id, result_revision, event_id,
        result_snapshot_json, created_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      receipt.scope,
      receipt.fingerprint,
      receipt.result.ceremonyId,
      receipt.result.revision,
      receipt.result.eventId,
      JSON.stringify(receipt.result.snapshot),
      receipt.createdAtMs
    );
  }

  async commitPasskeyAuthenticatorRevokeBegin(
    input: PersistCeremonyMutation,
    intent: PasskeyAuthenticatorRevokeIntentRecord
  ): Promise<void> {
    assertPasskeyMutationShape(input);
    this.#assertPasskeyAuthenticatorRevokeBeginShape(input, intent);
    this.#db.transaction(() => {
      this.#assertNoPasskeyReceiptDuplicates(input);
      const snapshot = input.mutation.snapshot;
      const current = this.#db.prepare(`
        SELECT 1 AS present FROM passkey_ceremonies WHERE ceremony_id = ?
      `).get(snapshot.ceremonyId) as { present: number } | undefined;
      if (current !== undefined) throw new StoreRevisionConflictError();

      const nowMs = this.passkeyNowMs();
      const metadataRow = this.#db.prepare(`
        SELECT * FROM passkey_authenticator_metadata
        WHERE account_id = ? AND credential_record_id = ?
      `).get(intent.accountId, intent.credentialRecordId) as PasskeyAuthenticatorMetadataRow | undefined;
      if (
        !isPasskeySafeInteger(nowMs, snapshot.createdAtMs)
        || !this.#isActivePasskeySession(
          intent.accountId,
          intent.sessionId,
          intent.deviceId,
          nowMs
        )
        || metadataRow === undefined
      ) throw new StoreCredentialStateConflictError();
      const authenticator = this.#mapPasskeyAuthenticatorMetadata(metadataRow);
      if (
        authenticator.lifecycleState !== "active"
        || authenticator.revision !== intent.expectedAuthenticatorRevision
      ) throw new StoreCredentialStateConflictError();

      this.#insertPasskeyCeremony(snapshot);
      this.#persistPasskeyEventAndOutbox(input);
      this.#persistPasskeyReceipt("passkey_command_receipts", input.commandReceipt);
      this.#persistPasskeyReceipt(
        "passkey_creation_receipts",
        input.creationReceipt as CreationReceipt
      );
      this.#insertPasskeyAuthenticatorRevokeIntent(intent);
    }).immediate();
  }

  async commitInitialPasskeyRegistration(
    input: PersistCeremonyMutation,
    claims: PasskeyStepUpClaimsProjection,
    userHandleBinding: PasskeyUserHandleBinding
  ): Promise<void> {
    assertPasskeyMutationShape(input);
    this.#assertInitialPasskeyRegistrationShape(input);
    assertPasskeyStepUpClaimsProjection(claims);
    assertPasskeyUserHandleBindingShape(userHandleBinding);
    if (
      userHandleBinding.accountId !== input.mutation.snapshot.actor.accountId
      || userHandleBinding.reference !== input.mutation.snapshot.userHandleRef
    ) {
      passkeyIntegrityFailure();
    }
    this.#db.transaction(() => {
      // Exact receipt replay is reconciled by the domain before this method is
      // called. A concurrent winner is nevertheless detected before grant CAS.
      this.#assertNoPasskeyReceiptDuplicates(input);
      const snapshot = input.mutation.snapshot;
      const current = this.#db.prepare(`
        SELECT 1 AS present FROM passkey_ceremonies WHERE ceremony_id = ?
      `).get(snapshot.ceremonyId) as { present: number } | undefined;
      if (current !== undefined) throw new StoreRevisionConflictError();

      const grantRow = this.#db.prepare(`
        SELECT * FROM passkey_step_up_grants
        WHERE authentication_ceremony_id = ?
      `).get(claims.ceremony_id) as PasskeyStepUpGrantRow | undefined;
      if (grantRow === undefined) passkeyStepUpAuthorizationFailure();
      const grant = mapPasskeyStepUpGrant(grantRow);
      const nowMs = this.passkeyNowMs();
      if (!isPasskeySafeInteger(nowMs)) passkeyIntegrityFailure();
      const nowSec = Math.floor(nowMs / 1_000);
      const registrationCreatedAtSec = Math.floor(snapshot.createdAtMs / 1_000);
      if (
        grant.authenticationCeremonyId !== claims.ceremony_id
        || grant.authenticationCeremonyId === snapshot.ceremonyId
        || grant.accountId !== claims.sub
        || grant.accountId !== snapshot.actor.accountId
        || grant.sessionId !== claims.sid
        || grant.sessionId !== snapshot.actor.sessionId
        || grant.deviceId !== claims.sid
        || grant.deviceId !== snapshot.actor.deviceId
        || grant.purpose !== claims.purpose
        || grant.purpose !== snapshot.purpose.type
        || grant.targetDigest !== claims.target_digest
        || grant.targetDigest !== snapshot.purpose.targetDigest
        || grant.authTimeSec !== claims.auth_time
        || grant.issuedAtSec !== claims.iat
        || grant.expiresAtSec !== claims.exp
        || grant.consumedAtSec !== null
        || grant.registrationCeremonyId !== null
        || nowSec < grant.issuedAtSec
        || nowSec >= grant.expiresAtSec
        || snapshot.createdAtMs > nowMs
        || userHandleBinding.createdAtMs > snapshot.createdAtMs
        || registrationCreatedAtSec < grant.issuedAtSec
        || registrationCreatedAtSec >= grant.expiresAtSec
        || !this.#isActivePasskeySession(
          snapshot.actor.accountId,
          snapshot.actor.sessionId,
          snapshot.actor.deviceId,
          nowMs
        )
      ) {
        passkeyStepUpAuthorizationFailure();
      }
      const existingHandleRow = this.#db.prepare(`
        SELECT * FROM passkey_user_handles WHERE account_id = ?
      `).get(snapshot.actor.accountId) as PasskeyUserHandleRow | undefined;
      let insertUserHandle = false;
      if (existingHandleRow === undefined) {
        const referenceCollision = this.#db.prepare(`
          SELECT 1 AS present FROM passkey_user_handles WHERE reference = ?
        `).get(userHandleBinding.reference) as { present: number } | undefined;
        if (referenceCollision !== undefined) throw new StoreRevisionConflictError();
        insertUserHandle = true;
      } else {
        const existingHandle = this.#mapPasskeyUserHandle(existingHandleRow);
        if (
          existingHandle.reference !== userHandleBinding.reference
          || existingHandle.accountId !== userHandleBinding.accountId
          || existingHandle.userHandle !== userHandleBinding.userHandle
          || existingHandle.createdAtMs !== userHandleBinding.createdAtMs
        ) {
          // Another authorized registration installed a different candidate
          // while this caller was preparing. Leave this grant untouched so a
          // retry can bind to the durable winner.
          throw new StoreRevisionConflictError();
        }
      }
      const registrationAlreadyLinked = this.#db.prepare(`
        SELECT 1 AS present FROM passkey_step_up_grants
        WHERE registration_ceremony_id = ?
      `).get(snapshot.ceremonyId) as { present: number } | undefined;
      if (registrationAlreadyLinked !== undefined) passkeyStepUpAuthorizationFailure();

      const consumed = this.#db.prepare(`
        UPDATE passkey_step_up_grants
        SET consumed_at_sec = @nowSec,
            registration_ceremony_id = @registrationCeremonyId
        WHERE authentication_ceremony_id = @authenticationCeremonyId
          AND account_id = @accountId
          AND session_id = @sessionId
          AND device_id = @deviceId
          AND purpose = @purpose
          AND target_digest = @targetDigest
          AND auth_time_sec = @authTimeSec
          AND issued_at_sec = @issuedAtSec
          AND expires_at_sec = @expiresAtSec
          AND consumed_at_sec IS NULL
          AND registration_ceremony_id IS NULL
          AND issued_at_sec <= @nowSec
          AND expires_at_sec > @nowSec
      `).run({
        nowSec,
        registrationCeremonyId: snapshot.ceremonyId,
        authenticationCeremonyId: grant.authenticationCeremonyId,
        accountId: grant.accountId,
        sessionId: grant.sessionId,
        deviceId: grant.deviceId,
        purpose: grant.purpose,
        targetDigest: grant.targetDigest,
        authTimeSec: grant.authTimeSec,
        issuedAtSec: grant.issuedAtSec,
        expiresAtSec: grant.expiresAtSec
      });
      if (consumed.changes !== 1) passkeyStepUpAuthorizationFailure();

      if (insertUserHandle) this.#insertPasskeyUserHandleBinding(userHandleBinding);
      this.#insertPasskeyCeremony(snapshot);
      this.#persistPasskeyEventAndOutbox(input);
      this.#persistPasskeyReceipt("passkey_command_receipts", input.commandReceipt);
      this.#persistPasskeyReceipt("passkey_creation_receipts", input.creationReceipt as CreationReceipt);
    }).immediate();
  }

  async commit(input: PersistCeremonyMutation): Promise<void> {
    assertPasskeyMutationShape(input);
    if (
      input.expectedRevision === null
      && input.mutation.snapshot.kind === "registration"
    ) {
      passkeyStepUpAuthorizationFailure();
    }
    this.#db.transaction(() => {
      this.#assertNoPasskeyReceiptDuplicates(input);
      let createStepUpGrant = false;
      let revokeIntent: PasskeyAuthenticatorRevokeIntentRecord | null = null;

      const currentRow = this.#db.prepare(`
        SELECT * FROM passkey_ceremonies WHERE ceremony_id = ?
      `).get(input.mutation.snapshot.ceremonyId) as PasskeyCeremonyRow | undefined;
      if (input.expectedRevision === null) {
        if (currentRow !== undefined) throw new StoreRevisionConflictError();
        if (input.mutation.snapshot.revision !== 1) passkeyIntegrityFailure();
        this.#insertPasskeyCeremony(input.mutation.snapshot);
      } else {
        if (!isPasskeySafeInteger(input.expectedRevision, 1)) passkeyIntegrityFailure();
        if (currentRow === undefined || currentRow.revision !== input.expectedRevision) {
          throw new StoreRevisionConflictError();
        }
        const current = mapPasskeyCeremony(currentRow);
        const revokeIntentRow = this.#db.prepare(`
          SELECT * FROM passkey_authenticator_revoke_intents
          WHERE authentication_ceremony_id = ?
        `).get(current.ceremonyId) as PasskeyAuthenticatorRevokeIntentRow | undefined;
        revokeIntent = revokeIntentRow === undefined
          ? null
          : mapPasskeyAuthenticatorRevokeIntent(revokeIntentRow);
        if (
          current.state !== "pending"
          || input.mutation.snapshot.revision !== input.expectedRevision + 1
          || immutablePasskeyCeremonyFingerprint(current)
            !== immutablePasskeyCeremonyFingerprint(input.mutation.snapshot)
        ) {
          passkeyIntegrityFailure();
        }
        this.#updatePasskeyCeremony(input.mutation.snapshot, input.expectedRevision);
        createStepUpGrant = (
          input.mutation.snapshot.kind === "authentication"
          && input.mutation.snapshot.state === "consumed"
        );
      }

      this.#persistPasskeyEventAndOutbox(input);
      if (createStepUpGrant) {
        if (revokeIntent === null) this.#createPasskeyStepUpGrant(input);
        else this.#createPasskeyAuthenticatorRevokeGrant(input, revokeIntent);
      }
      this.#applyPasskeyCredentialEffect(input);
      this.#persistPasskeyReceipt("passkey_command_receipts", input.commandReceipt);
      if (input.creationReceipt !== null) {
        this.#persistPasskeyReceipt("passkey_creation_receipts", input.creationReceipt);
      }
    }).immediate();
  }

  #mapPhoneAuthChallenge(row: PhoneAuthChallengeRow): PhoneAuthChallengeRecord {
    return {
      id: row.id,
      phoneDigest: row.phone_digest,
      e164: this.contentCipher.decrypt(row.phone_ciphertext, `phone-auth:${row.id}:number`),
      codeDigest: row.code_digest,
      deliveryCode: row.delivery_code_ciphertext === null
        ? null
        : this.contentCipher.decrypt(
            row.delivery_code_ciphertext,
            `phone-auth:${row.id}:delivery-code`
          ),
      deviceName: this.contentCipher.decrypt(
        row.device_name_ciphertext,
        `phone-auth:${row.id}:device-name`
      ),
      state: row.state,
      revision: row.revision,
      attemptsUsed: row.attempts_used,
      maxAttempts: row.max_attempts,
      beginClientNonce: row.begin_client_nonce,
      beginFingerprint: row.begin_fingerprint,
      maskedPhone: this.contentCipher.decrypt(
        row.masked_phone,
        `phone-auth:${row.id}:masked-phone`
      ),
      createdAt: row.created_at,
      expiresAt: row.expires_at,
      retryAfterSeconds: row.retry_after_seconds,
      updatedAt: row.updated_at,
      verifiedAt: row.verified_at,
      consumedAt: row.consumed_at,
      registrationTokenHash: row.registration_token_hash,
      registrationExpiresAt: row.registration_expires_at,
      matchedUserId: row.matched_user_id
    };
  }

  #insertPhoneAuthEvent(input: {
    challengeId: string;
    revision: number;
    eventType:
      | "phone.challenge.created"
      | "phone.challenge.delivered"
      | "phone.challenge.delivery_failed"
      | "phone.challenge.verification_rejected"
      | "phone.challenge.profile_required"
      | "phone.challenge.authenticated"
      | "phone.registration.completed";
    commandScope: string;
    occurredAt: string;
  }): void {
    this.#db.prepare(`
      INSERT INTO phone_auth_events (
        event_id, challenge_id, revision, event_type, command_scope, occurred_at
      ) VALUES (@eventId, @challengeId, @revision, @eventType, @commandScope, @occurredAt)
    `).run({ ...input, eventId: randomUUID() });
  }

  #insertPhoneAuthReceipt(receipt: PhoneAuthReceiptInput): void {
    this.#db.prepare(`
      INSERT INTO phone_auth_command_receipts (
        scope, operation, fingerprint, challenge_id, result_kind,
        response_ciphertext, created_at, expires_at
      ) VALUES (
        @scope, @operation, @fingerprint, @challengeId, @resultKind,
        @responseCiphertext, @createdAt, @expiresAt
      )
    `).run({
      ...receipt,
      responseCiphertext: receipt.responseJson === null
        ? null
        : this.contentCipher.encrypt(
            receipt.responseJson,
            `phone-auth-receipt:${receipt.scope}`
          )
    });
  }

  #insertPhoneAuthPasswordReceipt(receipt: PhoneAuthPasswordReceiptInput): void {
    this.#db.prepare(`
      INSERT INTO phone_auth_password_receipts (
        scope, fingerprint, challenge_id, result_kind,
        response_ciphertext, created_at, expires_at
      ) VALUES (
        @scope, @fingerprint, @challengeId, @resultKind,
        @responseCiphertext, @createdAt, @expiresAt
      )
    `).run({
      ...receipt,
      responseCiphertext: receipt.responseJson === null
        ? null
        : this.contentCipher.encrypt(
            receipt.responseJson,
            `phone-auth-password-receipt:${receipt.scope}`
          )
    });
  }

  #insertPhoneAuthPasswordEvent(input: {
    challengeId: string;
    observedRevision: number;
    eventType:
      | "phone.challenge.password_required"
      | "phone.challenge.password_rejected"
      | "phone.challenge.password_locked"
      | "phone.challenge.password_authenticated";
    commandScope: string;
    occurredAt: string;
  }): void {
    this.#db.prepare(`
      INSERT INTO phone_auth_password_events (
        event_id, challenge_id, observed_revision, event_type, command_scope, occurred_at
      ) VALUES (@eventId, @challengeId, @observedRevision, @eventType, @commandScope, @occurredAt)
    `).run({ ...input, eventId: randomUUID() });
  }

  createPhoneAuthChallenge(challenge: NewPhoneAuthChallenge): PhoneAuthChallengeRecord | null {
    const created = this.#db.transaction(() => {
      const result = this.#db.prepare(`
        INSERT INTO phone_auth_challenges (
          id, phone_digest, phone_ciphertext, code_digest, delivery_code_ciphertext,
          device_name_ciphertext, state, revision, attempts_used, max_attempts,
          begin_client_nonce, begin_fingerprint, masked_phone, created_at, expires_at,
          retry_after_seconds, updated_at
        )
        SELECT
          @id, @phoneDigest, @phoneCiphertext, @codeDigest, @deliveryCodeCiphertext,
          @deviceNameCiphertext, 'pending_delivery', 1, 0, @maxAttempts,
          @beginClientNonce, @beginFingerprint, @maskedPhone, @createdAt, @expiresAt,
          @retryAfterSeconds, @createdAt
        WHERE NOT EXISTS (
          SELECT 1
          FROM phone_auth_challenges recent
          WHERE recent.phone_digest = @phoneDigest
            AND recent.state <> 'consumed'
            AND julianday(recent.created_at)
              + (recent.retry_after_seconds / 86400.0) > julianday(@createdAt)
        )
      `).run({
        ...challenge,
        phoneCiphertext: this.contentCipher.encrypt(
          challenge.e164,
          `phone-auth:${challenge.id}:number`
        ),
        deliveryCodeCiphertext: this.contentCipher.encrypt(
          challenge.deliveryCode,
          `phone-auth:${challenge.id}:delivery-code`
        ),
        deviceNameCiphertext: this.contentCipher.encrypt(
          challenge.deviceName,
          `phone-auth:${challenge.id}:device-name`
        ),
        maskedPhone: this.contentCipher.encrypt(
          challenge.maskedPhone,
          `phone-auth:${challenge.id}:masked-phone`
        )
      });
      if (result.changes !== 1) return false;
      this.#insertPhoneAuthEvent({
        challengeId: challenge.id,
        revision: 1,
        eventType: "phone.challenge.created",
        commandScope: `begin:${challenge.beginClientNonce}`,
        occurredAt: challenge.createdAt
      });
      return true;
    }).immediate();
    return created
      ? this.findPhoneAuthChallengeById(challenge.id) as PhoneAuthChallengeRecord
      : null;
  }

  findPhoneAuthChallengeById(id: string): PhoneAuthChallengeRecord | null {
    const row = this.#db.prepare("SELECT * FROM phone_auth_challenges WHERE id = ?")
      .get(id) as PhoneAuthChallengeRow | undefined;
    return row === undefined ? null : this.#mapPhoneAuthChallenge(row);
  }

  findPhoneAuthChallengeByBeginNonce(clientNonce: string): PhoneAuthChallengeRecord | null {
    const row = this.#db.prepare(
      "SELECT * FROM phone_auth_challenges WHERE begin_client_nonce = ?"
    ).get(clientNonce) as PhoneAuthChallengeRow | undefined;
    return row === undefined ? null : this.#mapPhoneAuthChallenge(row);
  }

  findPhoneAuthChallengeByRegistrationTokenHash(
    tokenHash: string
  ): PhoneAuthChallengeRecord | null {
    const row = this.#db.prepare(
      "SELECT * FROM phone_auth_challenges WHERE registration_token_hash = ?"
    ).get(tokenHash) as PhoneAuthChallengeRow | undefined;
    return row === undefined ? null : this.#mapPhoneAuthChallenge(row);
  }

  activatePhoneAuthChallenge(id: string, expectedRevision: number, at: string): boolean {
    return this.#db.transaction(() => {
      const result = this.#db.prepare(`
        UPDATE phone_auth_challenges
        SET state = 'pending', revision = revision + 1,
            delivery_code_ciphertext = NULL, updated_at = @at
        WHERE id = @id AND revision = @expectedRevision AND state = 'pending_delivery'
      `).run({ id, expectedRevision, at });
      if (result.changes !== 1) return false;
      const challenge = this.findPhoneAuthChallengeById(id) as PhoneAuthChallengeRecord;
      this.#insertPhoneAuthEvent({
        challengeId: id,
        revision: expectedRevision + 1,
        eventType: "phone.challenge.delivered",
        commandScope: `begin:${challenge.beginClientNonce}`,
        occurredAt: at
      });
      return true;
    }).immediate();
  }

  failPhoneAuthChallengeDelivery(id: string, expectedRevision: number, at: string): boolean {
    return this.#db.transaction(() => {
      const result = this.#db.prepare(`
        UPDATE phone_auth_challenges
        SET state = 'locked', revision = revision + 1,
            delivery_code_ciphertext = NULL, updated_at = @at
        WHERE id = @id AND revision = @expectedRevision AND state = 'pending_delivery'
      `).run({ id, expectedRevision, at });
      if (result.changes !== 1) return false;
      this.#insertPhoneAuthEvent({
        challengeId: id,
        revision: expectedRevision + 1,
        eventType: "phone.challenge.delivery_failed",
        commandScope: `delivery:${id}`,
        occurredAt: at
      });
      return true;
    }).immediate();
  }

  findPhoneIdentityByDigest(phoneDigest: string): PhoneIdentityRecord | null {
    const row = this.#db.prepare(`
      SELECT phone_digest, user_id, verified_at FROM phone_identities WHERE phone_digest = ?
    `).get(phoneDigest) as {
      phone_digest: string;
      user_id: string;
      verified_at: string;
    } | undefined;
    return row === undefined ? null : {
      phoneDigest: row.phone_digest,
      userId: row.user_id,
      verifiedAt: row.verified_at
    };
  }

  findPhoneIdentityByUserId(userId: string): PhoneIdentityRecord | null {
    const row = this.#db.prepare(`
      SELECT phone_digest, user_id, verified_at FROM phone_identities WHERE user_id = ?
    `).get(userId) as {
      phone_digest: string;
      user_id: string;
      verified_at: string;
    } | undefined;
    return row === undefined ? null : {
      phoneDigest: row.phone_digest,
      userId: row.user_id,
      verifiedAt: row.verified_at
    };
  }

  adminUserPage(limit: number, cursor?: { createdAt: string; id: string }): {
    items: AdminUserRecord[];
    nextCursor: { createdAt: string; id: string } | null;
  } {
    const now = new Date().toISOString();
    const rows = this.#db.prepare(`
      SELECT
        u.id, u.username, u.display_name,
        u.phone_password_enabled, u.password_auth_enabled,
        u.created_at, u.last_seen_at,
        CASE WHEN pi.user_id IS NULL THEN 0 ELSE 1 END AS phone_bound,
        (
          SELECT COUNT(*) FROM device_sessions s
          WHERE s.user_id = u.id AND s.revoked_at IS NULL AND s.expires_at > @now
        ) AS active_sessions,
        (
          SELECT COUNT(*) FROM chat_members m WHERE m.user_id = u.id
        ) AS chat_count
      FROM users u
      LEFT JOIN phone_identities pi ON pi.user_id = u.id
      WHERE @cursorCreatedAt IS NULL
        OR u.created_at < @cursorCreatedAt
        OR (u.created_at = @cursorCreatedAt AND u.id < @cursorId)
      ORDER BY u.created_at DESC, u.id DESC
      LIMIT @take
    `).all({
      now,
      cursorCreatedAt: cursor?.createdAt ?? null,
      cursorId: cursor?.id ?? null,
      take: limit + 1
    }) as {
      id: string;
      username: string;
      display_name: string;
      phone_password_enabled: number;
      password_auth_enabled: number;
      created_at: string;
      last_seen_at: string | null;
      phone_bound: number;
      active_sessions: number;
      chat_count: number;
    }[];
    const page = rows.slice(0, limit);
    const last = rows.length > limit ? page[page.length - 1] : undefined;
    return {
      items: page.map((row) => ({
        id: row.id,
        username: row.username,
        displayName: row.display_name,
        phoneBound: row.phone_bound === 1,
        phonePasswordEnabled: row.phone_password_enabled === 1,
        passwordAuthEnabled: row.password_auth_enabled === 1,
        activeSessions: row.active_sessions,
        chatCount: row.chat_count,
        createdAt: row.created_at,
        lastSeenAt: row.last_seen_at
      })),
      nextCursor: last === undefined
        ? null
        : { createdAt: last.created_at, id: last.id }
    };
  }

  adminChatPage(limit: number, cursor?: { createdAt: string; id: string }): {
    items: AdminChatRecord[];
    nextCursor: { createdAt: string; id: string } | null;
  } {
    const rows = this.#db.prepare(`
      SELECT
        c.id, c.kind, c.title, c.created_at,
        (
          SELECT COUNT(*) FROM chat_members m WHERE m.chat_id = c.id
        ) AS member_count,
        (
          SELECT COUNT(*) FROM messages msg WHERE msg.chat_id = c.id
        ) AS message_count
      FROM chats c
      WHERE @cursorCreatedAt IS NULL
        OR c.created_at < @cursorCreatedAt
        OR (c.created_at = @cursorCreatedAt AND c.id < @cursorId)
      ORDER BY c.created_at DESC, c.id DESC
      LIMIT @take
    `).all({
      cursorCreatedAt: cursor?.createdAt ?? null,
      cursorId: cursor?.id ?? null,
      take: limit + 1
    }) as {
      id: string;
      kind: "direct" | "group" | "channel";
      title: string | null;
      created_at: string;
      member_count: number;
      message_count: number;
    }[];
    const page = rows.slice(0, limit);
    const last = rows.length > limit ? page[page.length - 1] : undefined;
    return {
      items: page.map((row) => ({
        id: row.id,
        kind: row.kind,
        title: row.title,
        memberCount: row.member_count,
        messageCount: row.message_count,
        createdAt: row.created_at
      })),
      nextCursor: last === undefined
        ? null
        : { createdAt: last.created_at, id: last.id }
    };
  }

  adminStatus(): AdminStatusRecord {
    return this.#db.transaction(() => {
      const users = (this.#db.prepare("SELECT COUNT(*) AS count FROM users")
        .get() as { count: number }).count;
      const now = new Date().toISOString();
      const activeSessions = (this.#db.prepare(`
        SELECT COUNT(*) AS count FROM device_sessions
        WHERE revoked_at IS NULL AND expires_at > ?
      `).get(now) as { count: number }).count;
      const chatKinds = this.#db.prepare(`
        SELECT kind, COUNT(*) AS count FROM chats GROUP BY kind
      `).all() as { kind: string; count: number }[];
      const chatsByKind = { direct: 0, group: 0, channel: 0 };
      for (const row of chatKinds) {
        if (row.kind === "direct" || row.kind === "group" || row.kind === "channel") {
          chatsByKind[row.kind] = row.count;
        }
      }
      const messages = (this.#db.prepare("SELECT COUNT(*) AS count FROM messages")
        .get() as { count: number }).count;
      const phoneIdentities = (this.#db.prepare("SELECT COUNT(*) AS count FROM phone_identities")
        .get() as { count: number }).count;
      const pendingOutbox = (this.#db.prepare(`
        SELECT COUNT(*) AS count FROM realtime_outbox
        WHERE published_at IS NULL AND failed_at IS NULL
      `).get() as { count: number }).count;
      const failedOutbox = (this.#db.prepare(`
        SELECT COUNT(*) AS count FROM realtime_outbox WHERE failed_at IS NOT NULL
      `).get() as { count: number }).count;
      const migrationId = (this.#db.prepare(
        "SELECT id FROM schema_migrations ORDER BY id DESC LIMIT 1"
      ).get() as { id: string }).id;
      return {
        migrationId,
        users,
        activeSessions,
        chatsByKind,
        messages,
        phoneIdentities,
        pendingOutbox,
        failedOutbox
      };
    }).immediate();
  }

  findPhoneAuthCommandReceipt(scope: string): PhoneAuthCommandReceiptRecord | null {
    const row = this.#db.prepare(
      "SELECT * FROM phone_auth_command_receipts WHERE scope = ?"
    ).get(scope) as PhoneAuthCommandReceiptRow | undefined;
    if (row === undefined) return null;
    return {
      scope: row.scope,
      operation: row.operation,
      fingerprint: row.fingerprint,
      challengeId: row.challenge_id,
      resultKind: row.result_kind,
      responseJson: row.response_ciphertext === null
        ? null
        : this.contentCipher.decrypt(
            row.response_ciphertext,
            `phone-auth-receipt:${row.scope}`
          ),
      createdAt: row.created_at,
      expiresAt: row.expires_at
    };
  }

  findPhoneAuthPasswordReceipt(scope: string): PhoneAuthPasswordReceiptRecord | null {
    const row = this.#db.prepare(
      "SELECT * FROM phone_auth_password_receipts WHERE scope = ?"
    ).get(scope) as PhoneAuthPasswordReceiptRow | undefined;
    if (row === undefined) return null;
    return {
      scope: row.scope,
      fingerprint: row.fingerprint,
      challengeId: row.challenge_id,
      resultKind: row.result_kind,
      responseJson: row.response_ciphertext === null
        ? null
        : this.contentCipher.decrypt(
            row.response_ciphertext,
            `phone-auth-password-receipt:${row.scope}`
          ),
      createdAt: row.created_at,
      expiresAt: row.expires_at
    };
  }

  commitPhoneAuthRejected(input: CommitPhoneAuthRejected): boolean {
    return this.#db.transaction(() => {
      const incrementAttempt = input.nextState === "expired" ? 0 : 1;
      const result = this.#db.prepare(`
        UPDATE phone_auth_challenges
        SET state = @nextState, revision = revision + 1,
            attempts_used = attempts_used + @incrementAttempt, updated_at = @createdAt
        WHERE id = @challengeId
          AND revision = @expectedRevision
          AND state = 'pending'
          AND attempts_used + @incrementAttempt <= max_attempts
      `).run({
        ...input,
        ...input.receipt,
        incrementAttempt
      });
      if (result.changes !== 1) return false;
      this.#insertPhoneAuthReceipt(input.receipt);
      this.#insertPhoneAuthEvent({
        challengeId: input.challengeId,
        revision: input.expectedRevision + 1,
        eventType: "phone.challenge.verification_rejected",
        commandScope: input.receipt.scope,
        occurredAt: input.receipt.createdAt
      });
      return true;
    }).immediate();
  }

  commitPhoneAuthProfileRequired(input: CommitPhoneAuthProfileRequired): boolean {
    return this.#db.transaction(() => {
      const result = this.#db.prepare(`
        UPDATE phone_auth_challenges
        SET state = 'verified', revision = revision + 1,
            verified_at = @createdAt, updated_at = @createdAt,
            registration_token_hash = @registrationTokenHash,
            registration_expires_at = @registrationExpiresAt
        WHERE id = @challengeId
          AND revision = @expectedRevision
          AND state = 'pending'
          AND expires_at > @createdAt
          AND NOT EXISTS (
            SELECT 1 FROM phone_identities identities
            WHERE identities.phone_digest = phone_auth_challenges.phone_digest
          )
      `).run({ ...input, ...input.receipt });
      if (result.changes !== 1) return false;
      this.#insertPhoneAuthReceipt(input.receipt);
      this.#insertPhoneAuthEvent({
        challengeId: input.challengeId,
        revision: input.expectedRevision + 1,
        eventType: "phone.challenge.profile_required",
        commandScope: input.receipt.scope,
        occurredAt: input.receipt.createdAt
      });
      return true;
    }).immediate();
  }

  commitPhoneAuthAuthenticated(input: CommitPhoneAuthAuthenticated): boolean {
    return this.#db.transaction(() => {
      const result = this.#db.prepare(`
        UPDATE phone_auth_challenges
        SET state = 'consumed', revision = revision + 1,
            verified_at = @createdAt, consumed_at = @createdAt,
            matched_user_id = @userId, updated_at = @createdAt
        WHERE id = @challengeId
          AND revision = @expectedRevision
          AND state = 'pending'
          AND expires_at > @createdAt
          AND EXISTS (
            SELECT 1 FROM phone_identities identities
            WHERE identities.phone_digest = phone_auth_challenges.phone_digest
              AND identities.user_id = @userId
          )
      `).run({ ...input, ...input.receipt });
      if (result.changes !== 1) return false;
      this.createSession(input.session, input.refreshToken);
      this.#insertPhoneAuthReceipt(input.receipt);
      this.#insertPhoneAuthEvent({
        challengeId: input.challengeId,
        revision: input.expectedRevision + 1,
        eventType: "phone.challenge.authenticated",
        commandScope: input.receipt.scope,
        occurredAt: input.receipt.createdAt
      });
      return true;
    }).immediate();
  }

  commitPhoneAuthRegistration(input: CommitPhoneAuthRegistration): boolean {
    return this.#db.transaction(() => {
      const challenge = this.#db.prepare(`
        SELECT phone_digest, phone_ciphertext FROM phone_auth_challenges
        WHERE id = @challengeId
          AND revision = @expectedRevision
          AND state = 'verified'
          AND registration_token_hash = @registrationTokenHash
          AND registration_expires_at > @createdAt
      `).get({ ...input, ...input.receipt }) as {
        phone_digest: string;
        phone_ciphertext: string;
      } | undefined;
      if (challenge === undefined) return false;
      const identityExists = this.#db.prepare(
        "SELECT 1 AS found FROM phone_identities WHERE phone_digest = ?"
      ).get(challenge.phone_digest) as { found: number } | undefined;
      if (identityExists !== undefined) return false;
      const identityPhoneCiphertext = this.contentCipher.encrypt(
        this.contentCipher.decrypt(
          challenge.phone_ciphertext,
          `phone-auth:${input.challengeId}:number`
        ),
        `phone-identity:${input.user.id}:number`
      );

      this.#db.prepare(`
        INSERT INTO users (
          id, username, username_normalized, display_name, bio, password_hash,
          password_auth_enabled, created_at, updated_at
        ) VALUES (
          @id, @username, @usernameNormalized, @displayName, @bio, @passwordHash,
          0, @createdAt, @createdAt
        )
      `).run(input.user);
      this.#db.prepare(`
        INSERT INTO account_privacy_settings (user_id, updated_at) VALUES (?, ?)
      `).run(input.user.id, input.user.createdAt);
      this.#db.prepare(`
        INSERT INTO phone_identities (
          phone_digest, phone_ciphertext, user_id, verified_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?)
      `).run(
        challenge.phone_digest,
        identityPhoneCiphertext,
        input.user.id,
        input.receipt.createdAt,
        input.receipt.createdAt,
        input.receipt.createdAt
      );
      this.createSession(input.session, input.refreshToken);
      const updated = this.#db.prepare(`
        UPDATE phone_auth_challenges
        SET state = 'consumed', revision = revision + 1,
            consumed_at = @createdAt, matched_user_id = @userId, updated_at = @createdAt
        WHERE id = @challengeId
          AND revision = @expectedRevision
          AND state = 'verified'
          AND registration_token_hash = @registrationTokenHash
      `).run({
        ...input,
        ...input.receipt,
        userId: input.user.id
      });
      if (updated.changes !== 1) throw new Error("Phone registration challenge changed during commit");
      this.#insertPhoneAuthReceipt(input.receipt);
      this.#insertPhoneAuthEvent({
        challengeId: input.challengeId,
        revision: input.expectedRevision + 1,
        eventType: "phone.registration.completed",
        commandScope: input.receipt.scope,
        occurredAt: input.receipt.createdAt
      });
      return true;
    }).immediate();
  }

  commitPhoneAuthPasswordRequired(input: CommitPhoneAuthPasswordRequired): boolean {
    return this.#db.transaction(() => {
      const result = this.#db.prepare(`
        UPDATE phone_auth_challenges
        SET state = 'verified', revision = revision + 1,
            verified_at = @createdAt, updated_at = @createdAt,
            registration_token_hash = @passwordTokenHash,
            registration_expires_at = @passwordExpiresAt
        WHERE id = @challengeId
          AND revision = @expectedRevision
          AND state = 'pending'
          AND expires_at > @createdAt
          AND EXISTS (
            SELECT 1
            FROM phone_identities identities
            JOIN users accounts ON accounts.id = identities.user_id
            WHERE identities.phone_digest = phone_auth_challenges.phone_digest
              AND identities.user_id = @userId
              AND accounts.phone_password_enabled = 1
              AND accounts.phone_password_hash IS NOT NULL
          )
      `).run({ ...input, ...input.receipt });
      if (result.changes !== 1) return false;
      this.#insertPhoneAuthPasswordReceipt(input.receipt);
      this.#insertPhoneAuthPasswordEvent({
        challengeId: input.challengeId,
        observedRevision: input.expectedRevision + 1,
        eventType: "phone.challenge.password_required",
        commandScope: input.receipt.scope,
        occurredAt: input.receipt.createdAt
      });
      return true;
    }).immediate();
  }

  commitPhoneAuthPasswordRejected(
    input: CommitPhoneAuthPasswordRejected
  ): "password_invalid" | "attempts_exhausted" | null {
    return this.#db.transaction(() => {
      const replay = this.findPhoneAuthPasswordReceipt(input.receipt.scope);
      if (replay !== null) {
        if (replay.fingerprint !== input.receipt.fingerprint) {
          throw conflict("Idempotency key was already used with different input");
        }
        return replay.resultKind === "password_invalid"
          || replay.resultKind === "attempts_exhausted"
          ? replay.resultKind
          : null;
      }
      const eligible = this.#db.prepare(`
        SELECT 1 AS found
        FROM phone_auth_challenges challenges
        JOIN phone_identities identities ON identities.phone_digest = challenges.phone_digest
        JOIN users accounts ON accounts.id = identities.user_id
        WHERE challenges.id = @challengeId
          AND challenges.revision = @expectedRevision
          AND challenges.state = 'verified'
          AND challenges.registration_token_hash = @passwordTokenHash
          AND challenges.registration_expires_at > @createdAt
          AND identities.user_id = @userId
          AND accounts.phone_password_enabled = 1
          AND accounts.phone_password_hash IS NOT NULL
      `).get({ ...input, ...input.receipt }) as { found: number } | undefined;
      if (eligible === undefined) return null;
      const previous = this.#db.prepare(`
        SELECT COUNT(*) AS count
        FROM phone_auth_password_receipts
        WHERE challenge_id = ?
          AND result_kind IN ('password_invalid', 'attempts_exhausted')
      `).get(input.challengeId) as { count: number };
      const resultKind = previous.count + 1 >= input.maxAttempts
        ? "attempts_exhausted" as const
        : "password_invalid" as const;
      const receipt: PhoneAuthPasswordReceiptInput = {
        ...input.receipt,
        resultKind,
        responseJson: null
      };
      this.#insertPhoneAuthPasswordReceipt(receipt);

      let observedRevision = input.expectedRevision;
      if (resultKind === "attempts_exhausted") {
        const locked = this.#db.prepare(`
          UPDATE phone_auth_challenges
          SET state = 'expired', revision = revision + 1, updated_at = @createdAt
          WHERE id = @challengeId
            AND revision = @expectedRevision
            AND state = 'verified'
            AND registration_token_hash = @passwordTokenHash
        `).run({ ...input, ...input.receipt });
        if (locked.changes !== 1) throw new Error("Phone password challenge changed during lock");
        observedRevision += 1;
      }
      this.#insertPhoneAuthPasswordEvent({
        challengeId: input.challengeId,
        observedRevision,
        eventType: resultKind === "attempts_exhausted"
          ? "phone.challenge.password_locked"
          : "phone.challenge.password_rejected",
        commandScope: input.receipt.scope,
        occurredAt: input.receipt.createdAt
      });
      return resultKind;
    }).immediate();
  }

  commitPhoneAuthPasswordAuthenticated(input: CommitPhoneAuthPasswordAuthenticated): boolean {
    return this.#db.transaction(() => {
      const result = this.#db.prepare(`
        UPDATE phone_auth_challenges
        SET state = 'consumed', revision = revision + 1,
            consumed_at = @createdAt, matched_user_id = @userId, updated_at = @createdAt
        WHERE id = @challengeId
          AND revision = @expectedRevision
          AND state = 'verified'
          AND registration_token_hash = @passwordTokenHash
          AND registration_expires_at > @createdAt
          AND EXISTS (
            SELECT 1
            FROM phone_identities identities
            JOIN users accounts ON accounts.id = identities.user_id
            WHERE identities.phone_digest = phone_auth_challenges.phone_digest
              AND identities.user_id = @userId
              AND accounts.phone_password_enabled = 1
              AND accounts.phone_password_hash IS NOT NULL
          )
      `).run({ ...input, ...input.receipt });
      if (result.changes !== 1) return false;
      this.createSession(input.session, input.refreshToken);
      this.#insertPhoneAuthPasswordReceipt(input.receipt);
      this.#insertPhoneAuthPasswordEvent({
        challengeId: input.challengeId,
        observedRevision: input.expectedRevision + 1,
        eventType: "phone.challenge.password_authenticated",
        commandScope: input.receipt.scope,
        occurredAt: input.receipt.createdAt
      });
      return true;
    }).immediate();
  }

  #mapScheduledMessage(row: ScheduledMessageRow): ScheduledMessageRecord {
    return {
      id: row.id,
      chatId: row.chat_id,
      senderId: row.sender_id,
      clientNonce: row.client_nonce,
      body: this.contentCipher.decrypt(row.body_ciphertext, `scheduled:${row.id}`),
      replyToMessageId: row.reply_to_message_id,
      topicId: row.topic_id,
      sendAt: row.send_at,
      state: row.state,
      failureCode: row.failure_code,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    };
  }

  createScheduledMessage(input: {
    id: string;
    chatId: string;
    senderId: string;
    body: string;
    replyToMessageId: string | null;
    topicId: string | null;
    clientNonce: string;
    sendAt: string;
    createdAt: string;
  }): ScheduledMessageRecord {
    this.#db.prepare(`
      INSERT INTO scheduled_messages (
        id, chat_id, sender_id, body_ciphertext, reply_to_message_id, topic_id,
        client_nonce, send_at, state, created_at, updated_at
      ) VALUES (
        @id, @chatId, @senderId, @bodyCiphertext, @replyToMessageId, @topicId,
        @clientNonce, @sendAt, 'pending', @createdAt, @createdAt
      )
    `).run({
      ...input,
      bodyCiphertext: this.contentCipher.encrypt(input.body, `scheduled:${input.id}`)
    });
    const row = this.#db.prepare("SELECT * FROM scheduled_messages WHERE id = ?")
      .get(input.id) as ScheduledMessageRow;
    return this.#mapScheduledMessage(row);
  }

  listDueScheduledMessages(now: string, limit: number): ScheduledMessageRecord[] {
    const rows = this.#db.prepare(`
      SELECT * FROM scheduled_messages
      WHERE state = 'pending' AND send_at <= @now
      ORDER BY send_at ASC, id ASC
      LIMIT @limit
    `).all({ now, limit }) as ScheduledMessageRow[];
    return rows.map((row) => this.#mapScheduledMessage(row));
  }

  listScheduledForChat(
    chatId: string,
    senderId: string,
    limit: number,
    cursor?: { sendAt: string; id: string }
  ): { items: ScheduledMessageRecord[]; nextCursor: { sendAt: string; id: string } | null } {
    const rows = this.#db.prepare(`
      SELECT * FROM scheduled_messages
      WHERE chat_id = @chatId
        AND sender_id = @senderId
        AND state IN ('pending', 'failed')
        AND (
          @cursorSendAt IS NULL
          OR send_at > @cursorSendAt
          OR (send_at = @cursorSendAt AND id > @cursorId)
        )
      ORDER BY send_at ASC, id ASC
      LIMIT @take
    `).all({
      chatId,
      senderId,
      cursorSendAt: cursor?.sendAt ?? null,
      cursorId: cursor?.id ?? null,
      take: limit + 1
    }) as ScheduledMessageRow[];
    const page = rows.slice(0, limit);
    const last = rows.length > limit ? page[page.length - 1] : undefined;
    return {
      items: page.map((row) => this.#mapScheduledMessage(row)),
      nextCursor: last === undefined ? null : { sendAt: last.send_at, id: last.id }
    };
  }

  cancelScheduledMessage(id: string, senderId: string, at: string): boolean {
    const result = this.#db.prepare(`
      UPDATE scheduled_messages
      SET state = 'cancelled', updated_at = @at
      WHERE id = @id AND sender_id = @senderId AND state = 'pending'
    `).run({ id, senderId, at });
    return result.changes === 1;
  }

  markScheduledSent(id: string, at: string): void {
    this.#db.prepare(`
      UPDATE scheduled_messages
      SET state = 'sent', sent_at = @at, updated_at = @at
      WHERE id = @id AND state = 'pending'
    `).run({ id, at });
  }

  markScheduledFailed(id: string, failureCode: string, at: string): void {
    this.#db.prepare(`
      UPDATE scheduled_messages
      SET state = 'failed', failure_code = @failureCode, updated_at = @at
      WHERE id = @id AND state = 'pending'
    `).run({ id, failureCode, at });
  }

  #mapPhoneRecoveryIntent(row: PhoneRecoveryIntentRow): PhoneRecoveryIntentRecord {
    return {
      id: row.id,
      challengeId: row.challenge_id,
      userId: row.user_id,
      phoneDigest: row.phone_digest,
      recoveryTokenHash: row.recovery_token_hash,
      state: row.state,
      createdAt: row.created_at,
      confirmAt: row.confirm_at,
      expiresAt: row.expires_at,
      updatedAt: row.updated_at,
      completedAt: row.completed_at
    };
  }

  createPhoneRecoveryIntent(
    input: { intent: NewPhoneRecoveryIntent; receipt: PhoneRecoveryReceiptInput }
  ): boolean {
    return this.#db.transaction(() => {
      const result = this.#db.prepare(`
        INSERT INTO phone_recovery_intents (
          id, challenge_id, user_id, phone_digest, recovery_token_hash,
          state, created_at, confirm_at, expires_at, updated_at
        )
        SELECT
          @id, @challengeId, @userId, @phoneDigest, @recoveryTokenHash,
          'pending', @createdAt, @confirmAt, @expiresAt, @createdAt
        WHERE NOT EXISTS (
          SELECT 1 FROM phone_recovery_intents active
          WHERE active.user_id = @userId AND active.state = 'pending'
        )
      `).run(input.intent);
      if (result.changes !== 1) return false;
      this.#db.prepare(`
        INSERT INTO phone_recovery_receipts (
          scope, fingerprint, intent_id, result_kind,
          response_ciphertext, created_at, expires_at
        ) VALUES (
          @scope, @fingerprint, @intentId, @resultKind,
          @responseCiphertext, @createdAt, @expiresAt
        )
      `).run({
        ...input.receipt,
        responseCiphertext: this.contentCipher.encrypt(
          input.receipt.responseJson,
          `phone-recovery-receipt:${input.receipt.scope}`
        )
      });
      this.#db.prepare(`
        INSERT INTO phone_recovery_events (
          event_id, intent_id, event_type, command_scope, occurred_at
        ) VALUES (?, ?, 'phone.recovery.started', ?, ?)
      `).run(
        randomUUID(),
        input.intent.id,
        input.receipt.scope,
        input.intent.createdAt
      );
      return true;
    }).immediate();
  }

  findPhoneRecoveryIntentByTokenHash(tokenHash: string): PhoneRecoveryIntentRecord | null {
    const row = this.#db.prepare(
      "SELECT * FROM phone_recovery_intents WHERE recovery_token_hash = ?"
    ).get(tokenHash) as PhoneRecoveryIntentRow | undefined;
    return row === undefined ? null : this.#mapPhoneRecoveryIntent(row);
  }

  findPhoneRecoveryReceipt(scope: string): PhoneRecoveryReceiptInput | null {
    const row = this.#db.prepare(
      "SELECT * FROM phone_recovery_receipts WHERE scope = ?"
    ).get(scope) as PhoneRecoveryReceiptRow | undefined;
    if (row === undefined) return null;
    return {
      scope: row.scope,
      fingerprint: row.fingerprint,
      intentId: row.intent_id,
      resultKind: row.result_kind,
      responseJson: this.contentCipher.decrypt(
        row.response_ciphertext,
        `phone-recovery-receipt:${row.scope}`
      ),
      createdAt: row.created_at,
      expiresAt: row.expires_at
    };
  }

  commitPhoneRecoveryCompleted(input: CommitPhoneRecoveryCompleted): boolean {
    return this.#db.transaction(() => {
      const intent = this.#db.prepare(`
        SELECT * FROM phone_recovery_intents
        WHERE id = @intentId
          AND user_id = @userId
          AND state = 'pending'
          AND confirm_at <= @createdAt
          AND expires_at > @createdAt
      `).get({ ...input, ...input.receipt }) as PhoneRecoveryIntentRow | undefined;
      if (intent === undefined) return false;
      const disabled = this.#db.prepare(`
        UPDATE users
        SET phone_password_hash = @nextPhonePasswordHash,
            phone_password_enabled = 1,
            updated_at = @createdAt
        WHERE id = @userId
          AND phone_password_enabled = 1
          AND phone_password_hash IS NOT NULL
          AND EXISTS (
            SELECT 1 FROM phone_identities identities WHERE identities.user_id = users.id
          )
      `).run({ ...input, ...input.receipt });
      if (disabled.changes !== 1) return false;
      this.#db.prepare(`
        UPDATE device_sessions
        SET revoked_at = COALESCE(revoked_at, @createdAt)
        WHERE user_id = @userId AND revoked_at IS NULL
      `).run({ userId: input.userId, createdAt: input.receipt.createdAt });
      this.#db.prepare(`
        UPDATE push_registrations
        SET revoked_at = COALESCE(revoked_at, @createdAt)
        WHERE user_id = @userId AND revoked_at IS NULL
      `).run({ userId: input.userId, createdAt: input.receipt.createdAt });
      this.createSession(input.session, input.refreshToken);
      const completed = this.#db.prepare(`
        UPDATE phone_recovery_intents
        SET state = 'completed', completed_at = @createdAt, updated_at = @createdAt
        WHERE id = @intentId
          AND state = 'pending'
          AND confirm_at <= @createdAt
          AND expires_at > @createdAt
      `).run({ ...input, ...input.receipt });
      if (completed.changes !== 1) {
        throw new Error("Phone recovery intent changed during completion commit");
      }
      this.#db.prepare(`
        INSERT INTO phone_recovery_receipts (
          scope, fingerprint, intent_id, result_kind,
          response_ciphertext, created_at, expires_at
        ) VALUES (
          @scope, @fingerprint, @intentId, @resultKind,
          @responseCiphertext, @createdAt, @expiresAt
        )
      `).run({
        ...input.receipt,
        responseCiphertext: this.contentCipher.encrypt(
          input.receipt.responseJson,
          `phone-recovery-receipt:${input.receipt.scope}`
        )
      });
      this.#db.prepare(`
        INSERT INTO phone_recovery_events (
          event_id, intent_id, event_type, command_scope, occurred_at
        ) VALUES (?, ?, 'phone.recovery.completed', ?, ?)
      `).run(
        randomUUID(),
        input.intentId,
        input.receipt.scope,
        input.receipt.createdAt
      );
      return true;
    }).immediate();
  }

  commitPhoneBindingIdentityTaken(input: {
    challengeId: string;
    expectedRevision: number;
    bindingTokenHash: string;
    receipt: PhoneBindingReceiptInput & { resultKind: "phone_unavailable" };
  }): boolean {
    return this.#db.transaction(() => {
      const result = this.#db.prepare(`
        UPDATE phone_binding_challenges
        SET state = 'consumed', revision = revision + 1,
            consumed_at = @createdAt, updated_at = @createdAt
        WHERE id = @challengeId
          AND revision = @expectedRevision
          AND state = 'verified'
          AND binding_token_hash = @bindingTokenHash
      `).run({ ...input, ...input.receipt });
      if (result.changes !== 1) return false;
      this.#insertPhoneBindingReceipt(input.receipt);
      this.#insertPhoneBindingEvent({
        challengeId: input.challengeId,
        revision: input.expectedRevision + 1,
        eventType: "phone.binding.completed",
        commandScope: input.receipt.scope,
        occurredAt: input.receipt.createdAt
      });
      return true;
    }).immediate();
  }

  #mapPhoneBindingChallenge(row: PhoneBindingChallengeRow): PhoneBindingChallengeRecord {
    return {
      id: row.id,
      userId: row.user_id,
      phoneDigest: row.phone_digest,
      e164: this.contentCipher.decrypt(row.phone_ciphertext, `phone-binding:${row.id}:number`),
      codeDigest: row.code_digest,
      deliveryCode: row.delivery_code_ciphertext === null
        ? null
        : this.contentCipher.decrypt(
            row.delivery_code_ciphertext,
            `phone-binding:${row.id}:delivery-code`
          ),
      state: row.state,
      revision: row.revision,
      attemptsUsed: row.attempts_used,
      maxAttempts: row.max_attempts,
      beginClientNonce: row.begin_client_nonce,
      beginFingerprint: row.begin_fingerprint,
      maskedPhone: this.contentCipher.decrypt(
        row.masked_phone,
        `phone-binding:${row.id}:masked-phone`
      ),
      createdAt: row.created_at,
      expiresAt: row.expires_at,
      retryAfterSeconds: row.retry_after_seconds,
      updatedAt: row.updated_at,
      verifiedAt: row.verified_at,
      consumedAt: row.consumed_at,
      bindingTokenHash: row.binding_token_hash,
      bindingExpiresAt: row.binding_expires_at
    };
  }

  #insertPhoneBindingEvent(input: {
    challengeId: string;
    revision: number;
    eventType:
      | "phone.binding.created"
      | "phone.binding.delivered"
      | "phone.binding.delivery_failed"
      | "phone.binding.verification_rejected"
      | "phone.binding.verified"
      | "phone.binding.completed";
    commandScope: string;
    occurredAt: string;
  }): void {
    this.#db.prepare(`
      INSERT INTO phone_binding_events (
        event_id, challenge_id, revision, event_type, command_scope, occurred_at
      ) VALUES (@eventId, @challengeId, @revision, @eventType, @commandScope, @occurredAt)
    `).run({ ...input, eventId: randomUUID() });
  }

  createPhoneBindingChallenge(
    challenge: NewPhoneBindingChallenge
  ): PhoneBindingChallengeRecord | null {
    const created = this.#db.transaction(() => {
      const result = this.#db.prepare(`
        INSERT INTO phone_binding_challenges (
          id, user_id, phone_digest, phone_ciphertext, code_digest,
          delivery_code_ciphertext, state, revision, attempts_used, max_attempts,
          begin_client_nonce, begin_fingerprint, masked_phone, created_at, expires_at,
          retry_after_seconds, updated_at
        )
        SELECT
          @id, @userId, @phoneDigest, @phoneCiphertext, @codeDigest,
          @deliveryCodeCiphertext, 'pending_delivery', 1, 0, @maxAttempts,
          @beginClientNonce, @beginFingerprint, @maskedPhone, @createdAt, @expiresAt,
          @retryAfterSeconds, @createdAt
        WHERE NOT EXISTS (
          SELECT 1
          FROM phone_binding_challenges recent
          WHERE recent.user_id = @userId
            AND recent.phone_digest = @phoneDigest
            AND recent.state <> 'consumed'
            AND julianday(recent.created_at)
              + (recent.retry_after_seconds / 86400.0) > julianday(@createdAt)
        )
      `).run({
        ...challenge,
        phoneCiphertext: this.contentCipher.encrypt(
          challenge.e164,
          `phone-binding:${challenge.id}:number`
        ),
        deliveryCodeCiphertext: this.contentCipher.encrypt(
          challenge.deliveryCode,
          `phone-binding:${challenge.id}:delivery-code`
        ),
        maskedPhone: this.contentCipher.encrypt(
          challenge.maskedPhone,
          `phone-binding:${challenge.id}:masked-phone`
        )
      });
      if (result.changes !== 1) return false;
      this.#insertPhoneBindingEvent({
        challengeId: challenge.id,
        revision: 1,
        eventType: "phone.binding.created",
        commandScope: `binding-begin:${challenge.beginClientNonce}`,
        occurredAt: challenge.createdAt
      });
      return true;
    }).immediate();
    return created
      ? this.findPhoneBindingChallengeById(challenge.id) as PhoneBindingChallengeRecord
      : null;
  }

  findPhoneBindingChallengeById(id: string): PhoneBindingChallengeRecord | null {
    const row = this.#db.prepare("SELECT * FROM phone_binding_challenges WHERE id = ?")
      .get(id) as PhoneBindingChallengeRow | undefined;
    return row === undefined ? null : this.#mapPhoneBindingChallenge(row);
  }

  findPhoneBindingChallengeByBeginNonce(clientNonce: string): PhoneBindingChallengeRecord | null {
    const row = this.#db.prepare(
      "SELECT * FROM phone_binding_challenges WHERE begin_client_nonce = ?"
    ).get(clientNonce) as PhoneBindingChallengeRow | undefined;
    return row === undefined ? null : this.#mapPhoneBindingChallenge(row);
  }

  findPhoneBindingChallengeByTokenHash(tokenHash: string): PhoneBindingChallengeRecord | null {
    const row = this.#db.prepare(
      "SELECT * FROM phone_binding_challenges WHERE binding_token_hash = ?"
    ).get(tokenHash) as PhoneBindingChallengeRow | undefined;
    return row === undefined ? null : this.#mapPhoneBindingChallenge(row);
  }

  activatePhoneBindingChallenge(id: string, expectedRevision: number, at: string): boolean {
    return this.#db.transaction(() => {
      const result = this.#db.prepare(`
        UPDATE phone_binding_challenges
        SET state = 'pending', revision = revision + 1,
            delivery_code_ciphertext = NULL, updated_at = @at
        WHERE id = @id AND revision = @expectedRevision AND state = 'pending_delivery'
      `).run({ id, expectedRevision, at });
      if (result.changes !== 1) return false;
      this.#insertPhoneBindingEvent({
        challengeId: id,
        revision: expectedRevision + 1,
        eventType: "phone.binding.delivered",
        commandScope: `binding-delivered:${id}`,
        occurredAt: at
      });
      return true;
    }).immediate();
  }

  failPhoneBindingChallengeDelivery(id: string, expectedRevision: number, at: string): boolean {
    return this.#db.transaction(() => {
      const result = this.#db.prepare(`
        UPDATE phone_binding_challenges
        SET state = 'locked', revision = revision + 1,
            delivery_code_ciphertext = NULL, updated_at = @at
        WHERE id = @id AND revision = @expectedRevision AND state = 'pending_delivery'
      `).run({ id, expectedRevision, at });
      if (result.changes !== 1) return false;
      this.#insertPhoneBindingEvent({
        challengeId: id,
        revision: expectedRevision + 1,
        eventType: "phone.binding.delivery_failed",
        commandScope: `binding-delivery:${id}`,
        occurredAt: at
      });
      return true;
    }).immediate();
  }

  findPhoneBindingReceipt(scope: string): PhoneBindingReceiptRecord | null {
    const row = this.#db.prepare(
      "SELECT * FROM phone_binding_receipts WHERE scope = ?"
    ).get(scope) as PhoneBindingReceiptRow | undefined;
    if (row === undefined) return null;
    return {
      scope: row.scope,
      fingerprint: row.fingerprint,
      challengeId: row.challenge_id,
      resultKind: row.result_kind,
      responseJson: row.response_ciphertext === null
        ? null
        : this.contentCipher.decrypt(
            row.response_ciphertext,
            `phone-binding-receipt:${row.scope}`
          ),
      createdAt: row.created_at,
      expiresAt: row.expires_at
    };
  }

  #insertPhoneBindingReceipt(receipt: PhoneBindingReceiptInput): void {
    this.#db.prepare(`
      INSERT INTO phone_binding_receipts (
        scope, fingerprint, challenge_id, result_kind,
        response_ciphertext, created_at, expires_at
      ) VALUES (
        @scope, @fingerprint, @challengeId, @resultKind,
        @responseCiphertext, @createdAt, @expiresAt
      )
    `).run({
      ...receipt,
      responseCiphertext: receipt.responseJson === null
        ? null
        : this.contentCipher.encrypt(
            receipt.responseJson,
            `phone-binding-receipt:${receipt.scope}`
          )
    });
  }

  commitPhoneBindingRejected(input: CommitPhoneBindingRejected): boolean {
    return this.#db.transaction(() => {
      const incrementAttempt = input.nextState === "expired" ? 0 : 1;
      const result = this.#db.prepare(`
        UPDATE phone_binding_challenges
        SET state = @nextState, revision = revision + 1,
            attempts_used = attempts_used + @incrementAttempt, updated_at = @createdAt
        WHERE id = @challengeId
          AND revision = @expectedRevision
          AND state = 'pending'
          AND attempts_used + @incrementAttempt <= max_attempts
      `).run({
        ...input,
        ...input.receipt,
        incrementAttempt
      });
      if (result.changes !== 1) return false;
      this.#insertPhoneBindingReceipt(input.receipt);
      this.#insertPhoneBindingEvent({
        challengeId: input.challengeId,
        revision: input.expectedRevision + 1,
        eventType: "phone.binding.verification_rejected",
        commandScope: input.receipt.scope,
        occurredAt: input.receipt.createdAt
      });
      return true;
    }).immediate();
  }

  commitPhoneBindingVerified(input: CommitPhoneBindingVerified): boolean {
    return this.#db.transaction(() => {
      const result = this.#db.prepare(`
        UPDATE phone_binding_challenges
        SET state = 'verified', revision = revision + 1,
            verified_at = @createdAt, updated_at = @createdAt,
            binding_token_hash = @bindingTokenHash,
            binding_expires_at = @bindingExpiresAt
        WHERE id = @challengeId
          AND revision = @expectedRevision
          AND state = 'pending'
          AND expires_at > @createdAt
      `).run({ ...input, ...input.receipt });
      if (result.changes !== 1) return false;
      this.#insertPhoneBindingReceipt(input.receipt);
      this.#insertPhoneBindingEvent({
        challengeId: input.challengeId,
        revision: input.expectedRevision + 1,
        eventType: "phone.binding.verified",
        commandScope: input.receipt.scope,
        occurredAt: input.receipt.createdAt
      });
      return true;
    }).immediate();
  }

  commitPhoneBindingCompleted(input: CommitPhoneBindingCompleted): boolean {
    return this.#db.transaction(() => {
      const challenge = this.#db.prepare(`
        SELECT phone_digest, phone_ciphertext FROM phone_binding_challenges
        WHERE id = @challengeId
          AND user_id = @userId
          AND revision = @expectedRevision
          AND state = 'verified'
          AND binding_token_hash = @bindingTokenHash
          AND binding_expires_at > @createdAt
      `).get({ ...input, ...input.receipt }) as {
        phone_digest: string;
        phone_ciphertext: string;
      } | undefined;
      if (challenge === undefined) return false;
      const identityExists = this.#db.prepare(
        "SELECT 1 AS found FROM phone_identities WHERE phone_digest = ?"
      ).get(challenge.phone_digest) as { found: number } | undefined;
      if (identityExists !== undefined) return false;
      const identityPhoneCiphertext = this.contentCipher.encrypt(
        this.contentCipher.decrypt(
          challenge.phone_ciphertext,
          `phone-binding:${input.challengeId}:number`
        ),
        `phone-identity:${input.userId}:number`
      );
      this.#db.prepare(`
        INSERT INTO phone_identities (
          phone_digest, phone_ciphertext, user_id, verified_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?)
      `).run(
        challenge.phone_digest,
        identityPhoneCiphertext,
        input.userId,
        input.receipt.createdAt,
        input.receipt.createdAt,
        input.receipt.createdAt
      );
      const consumed = this.#db.prepare(`
        UPDATE phone_binding_challenges
        SET state = 'consumed', revision = revision + 1,
            consumed_at = @createdAt, updated_at = @createdAt
        WHERE id = @challengeId
          AND revision = @expectedRevision
          AND state = 'verified'
          AND binding_token_hash = @bindingTokenHash
      `).run({ ...input, ...input.receipt });
      if (consumed.changes !== 1) {
        throw new Error("Phone binding challenge changed during completion commit");
      }
      this.#insertPhoneBindingReceipt(input.receipt);
      this.#insertPhoneBindingEvent({
        challengeId: input.challengeId,
        revision: input.expectedRevision + 1,
        eventType: "phone.binding.completed",
        commandScope: input.receipt.scope,
        occurredAt: input.receipt.createdAt
      });
      return true;
    }).immediate();
  }

  compareAndSetPhonePassword(input: {
    userId: string;
    expectedPhonePasswordHash: string | null;
    expectedEnabled: boolean;
    nextPhonePasswordHash: string;
    nextEnabled: boolean;
    at: string;
  }): boolean {
    const result = this.#db.prepare(`
      UPDATE users
      SET phone_password_hash = @nextPhonePasswordHash,
          phone_password_enabled = @nextEnabled,
          updated_at = CASE WHEN updated_at > @at THEN updated_at ELSE @at END
      WHERE id = @userId
        AND phone_password_hash IS @expectedPhonePasswordHash
        AND phone_password_enabled = @expectedEnabled
        AND EXISTS (
          SELECT 1 FROM phone_identities identities WHERE identities.user_id = users.id
        )
    `).run({
      ...input,
      expectedEnabled: input.expectedEnabled ? 1 : 0,
      nextEnabled: input.nextEnabled ? 1 : 0
    });
    return result.changes === 1;
  }

  createUser(user: NewUser): UserRecord {
    this.#db.transaction(() => {
      this.#db.prepare(`
        INSERT INTO users (
          id, username, username_normalized, display_name, password_hash, created_at, updated_at
        ) VALUES (@id, @username, @usernameNormalized, @displayName, @passwordHash, @createdAt, @createdAt)
      `).run(user);
      this.#db.prepare(`
        INSERT INTO account_privacy_settings (user_id, updated_at) VALUES (?, ?)
      `).run(user.id, user.createdAt);
    })();
    return this.findUserById(user.id) as UserRecord;
  }

  findUserById(id: string): UserRecord | null {
    const row = this.#db.prepare("SELECT * FROM users WHERE id = ?").get(id) as UserRow | undefined;
    return row === undefined ? null : mapUser(row);
  }

  updateUserProfile(
    userId: string,
    update: { displayName?: string | undefined; bio?: string | undefined },
    at: string
  ): UserRecord | null {
    return this.#db.transaction(() => {
      const result = this.#db.prepare(`
        UPDATE users
        SET display_name = COALESCE(@displayName, display_name),
            bio = COALESCE(@bio, bio),
            updated_at = CASE WHEN updated_at > @at THEN updated_at ELSE @at END
        WHERE id = @userId
      `).run({
        userId,
        displayName: update.displayName ?? null,
        bio: update.bio ?? null,
        at
      });
      return result.changes === 1 ? this.findUserById(userId) : null;
    }).immediate();
  }

  setUserAvatarAttachment(userId: string, attachmentId: string | null, at: string): UserRecord | null {
    return this.#db.transaction(() => {
      const current = this.#db.prepare(`
        SELECT avatar_attachment_id FROM users WHERE id = ?
      `).get(userId) as { avatar_attachment_id: string | null } | undefined;
      if (current === undefined) return null;

      const updated = this.#db.prepare(`
        UPDATE users
        SET avatar_attachment_id = @attachmentId,
            avatar_url = NULL,
            updated_at = CASE WHEN updated_at > @at THEN updated_at ELSE @at END
        WHERE id = @userId
          AND (
            @attachmentId IS NULL OR EXISTS (
              SELECT 1 FROM attachments a
              WHERE a.id = @attachmentId
                AND a.owner_user_id = @userId
                AND a.kind = 'image'
                AND a.safety_status = 'reencoded'
                AND a.metadata_trust = 'server_verified'
                AND a.deleting_at IS NULL
                AND a.deleted_at IS NULL
            )
          )
      `).run({ userId, attachmentId, at });
      if (updated.changes !== 1) return null;

      if (attachmentId !== null) {
        this.#db.prepare(`
          UPDATE attachments SET linked_at = COALESCE(linked_at, @at)
          WHERE id = @attachmentId
        `).run({ attachmentId, at });
      }
      if (current.avatar_attachment_id !== null && current.avatar_attachment_id !== attachmentId) {
        this.#db.prepare(`
          UPDATE attachments SET linked_at = NULL
          WHERE id = @previousAttachmentId
            AND NOT EXISTS (
              SELECT 1 FROM message_attachments ma
              WHERE ma.attachment_id = @previousAttachmentId
            )
            AND NOT EXISTS (
              SELECT 1 FROM users u
              WHERE u.avatar_attachment_id = @previousAttachmentId
            )
        `).run({ previousAttachmentId: current.avatar_attachment_id });
      }
      return this.findUserById(userId);
    }).immediate();
  }

  listProfileProjectionAudienceUserIds(userId: string): string[] {
    const rows = this.#db.prepare(`
      WITH affected_accounts(account_id) AS (
        SELECT @userId
        UNION
        SELECT observers.user_id
        FROM chat_members subject_membership
        JOIN chat_members observers ON observers.chat_id = subject_membership.chat_id
        WHERE subject_membership.user_id = @userId
        UNION
        SELECT observers.user_id
        FROM messages authored_message
        JOIN chat_members observers ON observers.chat_id = authored_message.chat_id
        WHERE authored_message.sender_id = @userId
        UNION
        SELECT observers.user_id
        FROM chat_topics authored_topic
        JOIN chat_members observers ON observers.chat_id = authored_topic.chat_id
        WHERE authored_topic.created_by = @userId
        UNION
        SELECT observers.user_id
        FROM chat_pins authored_pin
        JOIN chat_members observers ON observers.chat_id = authored_pin.chat_id
        WHERE authored_pin.pinned_by = @userId
      )
      SELECT affected_accounts.account_id
      FROM affected_accounts
      JOIN users ON users.id = affected_accounts.account_id
      ORDER BY affected_accounts.account_id
    `).all({ userId }) as Array<{ account_id: string }>;
    return rows.map(({ account_id }) => account_id);
  }

  findUserByUsername(normalizedUsername: string): UserRecord | null {
    const row = this.#db.prepare("SELECT * FROM users WHERE username_normalized = ?")
      .get(normalizedUsername) as UserRow | undefined;
    return row === undefined ? null : mapUser(row);
  }

  findDiscoverableUserByUsername(viewerUserId: string, normalizedUsername: string): UserRecord | null {
    const row = this.#db.prepare(`
      SELECT u.*
      FROM users u
      JOIN account_privacy_settings privacy ON privacy.user_id = u.id
      WHERE u.username_normalized = @normalizedUsername
        AND (u.id = @viewerUserId OR privacy.username_discoverable = 1)
        AND NOT EXISTS (
          SELECT 1 FROM account_blocks blocks
          WHERE (blocks.blocker_user_id = @viewerUserId AND blocks.blocked_user_id = u.id)
             OR (blocks.blocker_user_id = u.id AND blocks.blocked_user_id = @viewerUserId)
        )
    `).get({ viewerUserId, normalizedUsername }) as UserRow | undefined;
    return row === undefined ? null : mapUser(row);
  }

  searchKnownUsers(
    viewerUserId: string,
    query: string,
    limit: number,
    cursor?: string
  ): { items: User[]; nextCursor: string | null } {
    const decoded = decodeCursor(cursor);
    const normalized = query.toLowerCase().replace(/[\\%_]/g, "\\$&");
    const rows = this.#db.prepare(`
      SELECT u.* FROM users u
      WHERE u.id <> @viewerUserId
        AND (u.username_normalized LIKE @pattern ESCAPE '\\' OR lower(u.display_name) LIKE @pattern ESCAPE '\\')
        AND EXISTS (
          SELECT 1 FROM account_relationships relationships
          WHERE (relationships.left_user_id = @viewerUserId AND relationships.right_user_id = u.id)
             OR (relationships.right_user_id = @viewerUserId AND relationships.left_user_id = u.id)
        )
        AND NOT EXISTS (
          SELECT 1 FROM account_blocks blocks
          WHERE (blocks.blocker_user_id = @viewerUserId AND blocks.blocked_user_id = u.id)
             OR (blocks.blocker_user_id = u.id AND blocks.blocked_user_id = @viewerUserId)
        )
        AND (@cursorValue IS NULL OR u.username_normalized > @cursorValue
          OR (u.username_normalized = @cursorValue AND u.id > @cursorId))
      ORDER BY u.username_normalized ASC, u.id ASC
      LIMIT @take
    `).all({
      viewerUserId,
      pattern: `%${normalized}%`,
      cursorValue: decoded?.value ?? null,
      cursorId: decoded?.id ?? null,
      take: limit + 1
    }) as UserRow[];
    const hasMore = rows.length > limit;
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    return {
      items: page.map((row) => {
        const user = directoryUser(mapUser(row));
        const photoPolicy = this.getPrivacySettings(row.id).profilePhoto;
        if (!this.privacyAllows(row.id, viewerUserId, photoPolicy)) {
          user.avatarUrl = null;
          user.avatarPath = null;
        }
        return user;
      }),
      nextCursor: hasMore && last !== undefined
        ? encodeCursor({ value: last.username_normalized, id: last.id })
        : null
    };
  }

  getPrivacySettings(userId: string): PrivacySettingsRecord {
    const row = this.#db.prepare("SELECT * FROM account_privacy_settings WHERE user_id = ?")
      .get(userId) as PrivacySettingsRow | undefined;
    if (row === undefined) throw new Error("Privacy settings are missing for the account");
    return mapPrivacySettings(row);
  }

  privacyAllows(targetUserId: string, viewerId: string, policy: PrivacyVisibility): boolean {
    if (targetUserId === viewerId) return true;
    if (policy === "everyone") return true;
    if (policy === "nobody") return false;
    return this.hasAcceptedRelationship(targetUserId, viewerId);
  }

  updatePrivacySettings(
    userId: string,
    update: Partial<Pick<
      PrivacySettingsRecord,
      | "usernameDiscoverable"
      | "messageRequests"
      | "lastSeen"
      | "profilePhoto"
      | "forwards"
      | "voiceMessages"
      | "calls"
    >>,
    at: string
  ): PrivacySettingsRecord {
    const current = this.getPrivacySettings(userId);
    this.#db.prepare(`
      UPDATE account_privacy_settings
      SET username_discoverable = @usernameDiscoverable,
          message_requests = @messageRequests,
          last_seen_visibility = @lastSeen,
          profile_photo_visibility = @profilePhoto,
          forwards_visibility = @forwards,
          voice_messages_visibility = @voiceMessages,
          calls_visibility = @calls,
          updated_at = @updatedAt
      WHERE user_id = @userId
    `).run({
      userId,
      usernameDiscoverable: (update.usernameDiscoverable ?? current.usernameDiscoverable) ? 1 : 0,
      messageRequests: update.messageRequests ?? current.messageRequests,
      lastSeen: update.lastSeen ?? current.lastSeen,
      profilePhoto: update.profilePhoto ?? current.profilePhoto,
      forwards: update.forwards ?? current.forwards,
      voiceMessages: update.voiceMessages ?? current.voiceMessages,
      calls: update.calls ?? current.calls,
      updatedAt: at
    });
    return this.getPrivacySettings(userId);
  }

  findCurrentPushRegistration(userId: string, sessionId: string): PushRegistrationRecord | null {
    const row = this.#db.prepare(`
      SELECT * FROM push_registrations
      WHERE user_id = ? AND session_id = ? AND revoked_at IS NULL
      ORDER BY updated_at DESC, id DESC
      LIMIT 1
    `).get(userId, sessionId) as PushRegistrationRow | undefined;
    return row === undefined ? null : mapPushRegistration(row);
  }

  upsertPushRegistration(input: NewPushRegistration): PushRegistrationRecord {
    const expectedDigest = createHash("sha256").update(input.token, "utf8").digest("hex");
    if (expectedDigest !== input.tokenDigest) {
      throw new Error("Push token digest mismatch");
    }
    return this.#db.transaction(() => {
      const existing = this.#db.prepare(`
        SELECT * FROM push_registrations
        WHERE platform = @platform
          AND environment = @environment
          AND topic = @topic
          AND token_digest = @tokenDigest
      `).get(input) as PushRegistrationRow | undefined;
      const id = existing?.id ?? input.id;
      const updatedAt = existing === undefined
        ? input.at
        : latestTimestamp(existing.updated_at, input.at);
      const ciphertext = this.contentCipher.encrypt(
        input.token,
        `push-token:${id}:${input.userId}:${input.sessionId}:${input.environment}:${input.topic}`
      );
      if (!ciphertext.startsWith(PUSH_TOKEN_ENCRYPTED_ENVELOPE_PREFIX)) {
        throw new Error("Push token storage requires authenticated encryption");
      }

      this.#db.prepare(`
        UPDATE push_registrations
        SET revoked_at = COALESCE(revoked_at, @updatedAt),
            updated_at = CASE WHEN updated_at < @updatedAt THEN @updatedAt ELSE updated_at END
        WHERE session_id = @sessionId
          AND platform = @platform
          AND topic = @topic
          AND revoked_at IS NULL
          AND id <> @id
      `).run({ ...input, id, updatedAt });

      if (existing === undefined) {
        this.#db.prepare(`
          INSERT INTO push_registrations (
            id, user_id, session_id, platform, environment, topic,
            token_digest, token_ciphertext, created_at, updated_at
          ) VALUES (
            @id, @userId, @sessionId, @platform, @environment, @topic,
            @tokenDigest, @ciphertext, @updatedAt, @updatedAt
          )
        `).run({ ...input, id, ciphertext, updatedAt });
      } else {
        this.#db.prepare(`
          UPDATE push_registrations
          SET user_id = @userId,
              session_id = @sessionId,
              token_ciphertext = @ciphertext,
              updated_at = @updatedAt,
              revoked_at = NULL
          WHERE id = @id
        `).run({ ...input, id, ciphertext, updatedAt });
      }

      const row = this.#db.prepare("SELECT * FROM push_registrations WHERE id = ?")
        .get(id) as PushRegistrationRow | undefined;
      if (row === undefined || row.revoked_at !== null) {
        throw new Error("Push registration commit was not readable");
      }
      return mapPushRegistration(row);
    }).immediate();
  }

  revokeCurrentPushRegistration(userId: string, sessionId: string, at: string): boolean {
    return this.#db.prepare(`
      UPDATE push_registrations
      SET revoked_at = COALESCE(revoked_at, @at),
          updated_at = CASE WHEN updated_at < @at THEN @at ELSE updated_at END
      WHERE user_id = @userId AND session_id = @sessionId AND revoked_at IS NULL
    `).run({ userId, sessionId, at }).changes > 0;
  }

  getNotificationSettings(userId: string): NotificationSettingsRecord {
    let row = this.#db.prepare("SELECT * FROM notification_settings WHERE user_id = ?")
      .get(userId) as NotificationSettingsRow | undefined;
    if (row === undefined) {
      const user = this.#db.prepare("SELECT created_at FROM users WHERE id = ?")
        .get(userId) as { created_at: string } | undefined;
      if (user === undefined) throw new Error("Notification account is missing");
      this.#db.prepare(`
        INSERT INTO notification_settings (user_id, updated_at)
        VALUES (?, ?)
        ON CONFLICT(user_id) DO NOTHING
      `).run(userId, user.created_at);
      row = this.#db.prepare("SELECT * FROM notification_settings WHERE user_id = ?")
        .get(userId) as NotificationSettingsRow | undefined;
    }
    if (row === undefined) throw new Error("Notification settings are missing for the account");
    return mapNotificationSettings(row);
  }

  updateNotificationSettings(
    userId: string,
    update: Partial<Pick<
      NotificationSettingsRecord,
      | "messageAlerts"
      | "messageRequestAlerts"
      | "mentionAlerts"
      | "groupAlerts"
      | "channelAlerts"
      | "storyAlerts"
      | "reactionAlerts"
      | "sound"
      | "badge"
      | "previewMode"
    >>,
    at: string
  ): NotificationSettingsRecord {
    // Materialize defaults first, then apply only the caller's fields in one
    // SQLite statement. A read/merge/write sequence can lose an unrelated
    // preference changed by another device between the read and the update.
    this.getNotificationSettings(userId);
    this.#db.prepare(`
      UPDATE notification_settings
      SET message_alerts = COALESCE(@messageAlerts, message_alerts),
          message_request_alerts = COALESCE(@messageRequestAlerts, message_request_alerts),
          mention_alerts = COALESCE(@mentionAlerts, mention_alerts),
          group_message_alerts = COALESCE(@groupAlerts, group_message_alerts),
          channel_message_alerts = COALESCE(@channelAlerts, channel_message_alerts),
          story_alerts = COALESCE(@storyAlerts, story_alerts),
          reaction_alerts = COALESCE(@reactionAlerts, reaction_alerts),
          sound = COALESCE(@sound, sound),
          badge = COALESCE(@badge, badge),
          preview_mode = COALESCE(@previewMode, preview_mode),
          updated_at = CASE WHEN updated_at > @at THEN updated_at ELSE @at END
      WHERE user_id = @userId
    `).run({
      userId,
      messageAlerts: update.messageAlerts === undefined ? null : update.messageAlerts ? 1 : 0,
      messageRequestAlerts: update.messageRequestAlerts === undefined
        ? null
        : update.messageRequestAlerts ? 1 : 0,
      mentionAlerts: update.mentionAlerts === undefined ? null : update.mentionAlerts ? 1 : 0,
      groupAlerts: update.groupAlerts === undefined ? null : update.groupAlerts ? 1 : 0,
      channelAlerts: update.channelAlerts === undefined ? null : update.channelAlerts ? 1 : 0,
      storyAlerts: update.storyAlerts === undefined ? null : update.storyAlerts ? 1 : 0,
      reactionAlerts: update.reactionAlerts === undefined ? null : update.reactionAlerts ? 1 : 0,
      sound: update.sound === undefined ? null : update.sound ? 1 : 0,
      badge: update.badge === undefined ? null : update.badge ? 1 : 0,
      previewMode: update.previewMode ?? null,
      at
    });
    return this.getNotificationSettings(userId);
  }

  hasAcceptedRelationship(leftUserId: string, rightUserId: string): boolean {
    if (leftUserId === rightUserId) return true;
    const pairKey = [leftUserId, rightUserId].sort().join(":");
    return this.#db.prepare("SELECT 1 AS present FROM account_relationships WHERE pair_key = ?")
      .get(pairKey) !== undefined;
  }

  createAcceptedRelationship(
    pairKey: string,
    leftUserId: string,
    rightUserId: string,
    acceptedRequestId: string,
    at: string
  ): void {
    this.#db.prepare(`
      INSERT INTO account_relationships (
        pair_key, left_user_id, right_user_id, accepted_request_id, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(pair_key) DO UPDATE SET
        accepted_request_id = excluded.accepted_request_id,
        updated_at = excluded.updated_at
    `).run(pairKey, leftUserId, rightUserId, acceptedRequestId, at, at);
  }

  deleteAcceptedRelationship(leftUserId: string, rightUserId: string): boolean {
    const pairKey = [leftUserId, rightUserId].sort().join(":");
    return this.#db.prepare("DELETE FROM account_relationships WHERE pair_key = ?")
      .run(pairKey).changes === 1;
  }

  isBlockedBetween(leftUserId: string, rightUserId: string): boolean {
    if (leftUserId === rightUserId) return false;
    return this.#db.prepare(`
      SELECT 1 AS blocked FROM account_blocks
      WHERE (blocker_user_id = ? AND blocked_user_id = ?)
         OR (blocker_user_id = ? AND blocked_user_id = ?)
      LIMIT 1
    `).get(leftUserId, rightUserId, rightUserId, leftUserId) !== undefined;
  }

  createBlock(
    blockerUserId: string,
    blockedUserId: string,
    profileSnapshot: PublicProfile,
    at: string
  ): { record: BlockRecord; created: boolean } {
    const result = this.#db.prepare(`
      INSERT OR IGNORE INTO account_blocks (
        blocker_user_id, blocked_user_id, profile_snapshot_ciphertext, created_at
      ) VALUES (?, ?, ?, ?)
    `).run(
      blockerUserId,
      blockedUserId,
      this.contentCipher.encrypt(
        JSON.stringify(profileSnapshot),
        `account-block:${blockerUserId}:${blockedUserId}:profile`
      ),
      at
    );
    const row = this.#db.prepare(`
      SELECT * FROM account_blocks WHERE blocker_user_id = ? AND blocked_user_id = ?
    `).get(blockerUserId, blockedUserId) as BlockRow;
    return { record: this.#mapBlock(row), created: result.changes === 1 };
  }

  deleteBlock(blockerUserId: string, blockedUserId: string): boolean {
    return this.#db.prepare(`
      DELETE FROM account_blocks WHERE blocker_user_id = ? AND blocked_user_id = ?
    `).run(blockerUserId, blockedUserId).changes === 1;
  }

  listBlocks(userId: string, limit: number, cursor?: string): { items: BlockRecord[]; nextCursor: string | null } {
    const decoded = decodeCursor(cursor);
    const rows = this.#db.prepare(`
      SELECT * FROM account_blocks
      WHERE blocker_user_id = @userId
        AND (@cursorValue IS NULL OR created_at < @cursorValue
          OR (created_at = @cursorValue AND blocked_user_id < @cursorId))
      ORDER BY created_at DESC, blocked_user_id DESC
      LIMIT @take
    `).all({
      userId,
      cursorValue: decoded?.value ?? null,
      cursorId: decoded?.id ?? null,
      take: limit + 1
    }) as BlockRow[];
    const hasMore = rows.length > limit;
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    return {
      items: page.map((row) => this.#mapBlock(row)),
      nextCursor: hasMore && last !== undefined
        ? encodeCursor({ value: last.created_at, id: last.blocked_user_id })
        : null
    };
  }

  listBlocksForReconciliation(
    userId: string,
    limit: number,
    cursor?: string
  ): { items: BlockRecord[]; nextCursor: string | null } {
    const decoded = decodeCursor(cursor);
    const rows = this.#db.prepare(`
      SELECT * FROM account_blocks
      WHERE blocker_user_id = @userId
        AND (@cursorId IS NULL OR blocked_user_id < @cursorId)
      ORDER BY blocked_user_id DESC
      LIMIT @take
    `).all({
      userId,
      cursorId: decoded?.id ?? null,
      take: limit + 1
    }) as BlockRow[];
    const hasMore = rows.length > limit;
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    return {
      items: page.map((row) => this.#mapBlock(row)),
      nextCursor: hasMore && last !== undefined
        ? encodeCursor({ value: last.created_at, id: last.blocked_user_id })
        : null
    };
  }

  createMessageRequest(request: NewMessageRequest): MessageRequestRecord {
    this.#db.prepare(`
      INSERT INTO message_requests (
        id, pair_key, sender_id, recipient_id, client_nonce, body_ciphertext,
        link_url_ciphertext, sender_profile_snapshot_ciphertext,
        recipient_profile_snapshot_ciphertext, state, created_at, updated_at, expires_at
      ) VALUES (
        @id, @pairKey, @senderId, @recipientId, @clientNonce, @bodyCiphertext,
        @linkUrlCiphertext, @senderProfileSnapshotCiphertext,
        @recipientProfileSnapshotCiphertext, 'pending', @createdAt, @createdAt, @expiresAt
      )
    `).run({
      ...request,
      bodyCiphertext: this.contentCipher.encrypt(request.body, `message-request:${request.id}:body`),
      linkUrlCiphertext: request.linkUrl === null
        ? null
        : this.contentCipher.encrypt(request.linkUrl, `message-request:${request.id}:link`),
      senderProfileSnapshotCiphertext: this.contentCipher.encrypt(
        JSON.stringify(request.senderProfile),
        `message-request:${request.id}:sender-profile`
      ),
      recipientProfileSnapshotCiphertext: this.contentCipher.encrypt(
        JSON.stringify(request.recipientProfile),
        `message-request:${request.id}:recipient-profile`
      )
    });
    return this.findMessageRequestById(request.id) as MessageRequestRecord;
  }

  findMessageRequestById(id: string): MessageRequestRecord | null {
    const row = this.#db.prepare("SELECT * FROM message_requests WHERE id = ?")
      .get(id) as MessageRequestRow | undefined;
    return row === undefined ? null : this.#mapMessageRequest(row);
  }

  findMessageRequestByNonce(senderUserId: string, clientNonce: string): MessageRequestRecord | null {
    const row = this.#db.prepare(`
      SELECT * FROM message_requests WHERE sender_id = ? AND client_nonce = ?
    `).get(senderUserId, clientNonce) as MessageRequestRow | undefined;
    return row === undefined ? null : this.#mapMessageRequest(row);
  }

  findPendingMessageRequestByPair(pairKey: string): MessageRequestRecord | null {
    const row = this.#db.prepare(`
      SELECT * FROM message_requests WHERE pair_key = ? AND state = 'pending'
    `).get(pairKey) as MessageRequestRow | undefined;
    return row === undefined ? null : this.#mapMessageRequest(row);
  }

  findRecentDismissedMessageRequest(
    senderUserId: string,
    recipientUserId: string,
    since: string
  ): MessageRequestRecord | null {
    const row = this.#db.prepare(`
      SELECT * FROM message_requests
      WHERE sender_id = ? AND recipient_id = ? AND state = 'recipient_dismissed'
        AND dismissed_at >= ?
      ORDER BY dismissed_at DESC, id DESC LIMIT 1
    `).get(senderUserId, recipientUserId, since) as MessageRequestRow | undefined;
    return row === undefined ? null : this.#mapMessageRequest(row);
  }

  listMessageRequests(
    userId: string,
    direction: "incoming" | "outgoing",
    limit: number,
    cursor?: string
  ): { items: MessageRequestRecord[]; nextCursor: string | null } {
    const decoded = decodeCursor(cursor);
    const rows = this.#db.prepare(`
      SELECT * FROM message_requests
      WHERE ${direction === "incoming" ? "recipient_id" : "sender_id"} = @userId
        ${direction === "incoming" ? "AND state = 'pending'" : ""}
        AND (@cursorValue IS NULL OR created_at < @cursorValue
          OR (created_at = @cursorValue AND id < @cursorId))
      ORDER BY created_at DESC, id DESC
      LIMIT @take
    `).all({
      userId,
      cursorValue: decoded?.value ?? null,
      cursorId: decoded?.id ?? null,
      take: limit + 1
    }) as MessageRequestRow[];
    const hasMore = rows.length > limit;
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    return {
      items: page.map((row) => this.#mapMessageRequest(row)),
      nextCursor: hasMore && last !== undefined
        ? encodeCursor({ value: last.created_at, id: last.id })
        : null
    };
  }

  acceptMessageRequest(id: string, recipientUserId: string, chatId: string, at: string): boolean {
    return this.#db.prepare(`
      UPDATE message_requests
      SET state = 'accepted', chat_id = ?, accepted_at = ?, updated_at = ?
      WHERE id = ? AND recipient_id = ? AND state = 'pending' AND expires_at > ?
    `).run(chatId, at, at, id, recipientUserId, at).changes === 1;
  }

  dismissMessageRequest(id: string, recipientUserId: string, at: string): boolean {
    return this.#db.prepare(`
      UPDATE message_requests
      SET state = 'recipient_dismissed', dismissed_at = ?, updated_at = ?
      WHERE id = ? AND recipient_id = ? AND state = 'pending'
    `).run(at, at, id, recipientUserId).changes === 1;
  }

  expireMessageRequest(id: string, at: string): boolean {
    return this.#db.prepare(`
      UPDATE message_requests SET state = 'expired', updated_at = ?
      WHERE id = ? AND state = 'pending' AND expires_at <= ?
    `).run(at, id, at).changes === 1;
  }

  listExpiredMessageRequestsForUser(userId: string, at: string, limit: number): MessageRequestRecord[] {
    const rows = this.#db.prepare(`
      SELECT * FROM message_requests
      WHERE state = 'pending' AND expires_at <= ? AND (sender_id = ? OR recipient_id = ?)
      ORDER BY expires_at ASC, id ASC LIMIT ?
    `).all(at, userId, userId, limit) as MessageRequestRow[];
    return rows.map((row) => this.#mapMessageRequest(row));
  }

  closePendingMessageRequestsBetween(
    actorUserId: string,
    otherUserId: string,
    at: string
  ): MessageRequestRecord[] {
    const rows = this.#db.prepare(`
      SELECT * FROM message_requests
      WHERE state = 'pending'
        AND ((sender_id = ? AND recipient_id = ?) OR (sender_id = ? AND recipient_id = ?))
    `).all(actorUserId, otherUserId, otherUserId, actorUserId) as MessageRequestRow[];
    for (const row of rows) {
      const state: MessageRequestState = row.recipient_id === actorUserId
        ? "recipient_dismissed"
        : "expired";
      this.#db.prepare(`
        UPDATE message_requests
        SET state = ?, dismissed_at = CASE WHEN ? = 'recipient_dismissed' THEN ? ELSE dismissed_at END,
            updated_at = ?
        WHERE id = ? AND state = 'pending'
      `).run(state, state, at, at, row.id);
    }
    return rows
      .map((row) => this.findMessageRequestById(row.id))
      .filter((request): request is MessageRequestRecord => request !== null);
  }

  removeMessageRequestCreatedEvents(audienceUserId: string, requestId: string): void {
    this.#db.prepare(`
      DELETE FROM realtime_events
      WHERE audience_user_id = ? AND entity_id = ?
        AND event_type = 'relationship.request.created'
    `).run(audienceUserId, requestId);
  }

  createSafetyReport(report: NewSafetyReport): SafetyReportRecord {
    this.#db.prepare(`
      INSERT INTO safety_reports (
        id, reporter_user_id, subject_user_id, category, evidence_ciphertext,
        comment_ciphertext, client_nonce, also_blocked, created_at
      ) VALUES (
        @id, @reporterUserId, @subjectUserId, @category, @evidenceCiphertext,
        @commentCiphertext, @clientNonce, @alsoBlocked, @createdAt
      )
    `).run({
      ...report,
      evidenceCiphertext: this.contentCipher.encrypt(
        JSON.stringify(report.evidence),
        `safety-report:${report.id}:evidence`
      ),
      commentCiphertext: report.comment === null
        ? null
        : this.contentCipher.encrypt(report.comment, `safety-report:${report.id}:comment`),
      alsoBlocked: report.alsoBlocked ? 1 : 0
    });
    return this.findSafetyReportByNonce(report.reporterUserId, report.clientNonce) as SafetyReportRecord;
  }

  findSafetyReportByNonce(reporterUserId: string, clientNonce: string): SafetyReportRecord | null {
    const row = this.#db.prepare(`
      SELECT * FROM safety_reports WHERE reporter_user_id = ? AND client_nonce = ?
    `).get(reporterUserId, clientNonce) as SafetyReportRow | undefined;
    return row === undefined ? null : this.#mapSafetyReport(row);
  }

  listSafetyReports(
    reporterUserId: string,
    limit: number,
    cursor?: string
  ): { items: SafetyReportRecord[]; nextCursor: string | null } {
    const decoded = decodeCursor(cursor);
    const rows = this.#db.prepare(`
      SELECT * FROM safety_reports
      WHERE reporter_user_id = @reporterUserId
        AND (@cursorValue IS NULL OR created_at < @cursorValue
          OR (created_at = @cursorValue AND id < @cursorId))
      ORDER BY created_at DESC, id DESC
      LIMIT @take
    `).all({
      reporterUserId,
      cursorValue: decoded?.value ?? null,
      cursorId: decoded?.id ?? null,
      take: limit + 1
    }) as SafetyReportRow[];
    const hasMore = rows.length > limit;
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    return {
      items: page.map((row) => this.#mapSafetyReport(row)),
      nextCursor: hasMore && last !== undefined
        ? encodeCursor({ value: last.created_at, id: last.id })
        : null
    };
  }

  appendIdentityAudit(input: {
    id: string;
    accountUserId: string;
    actorUserId: string;
    action: IdentityAuditAction;
    targetUserId: string | null;
    resourceId: string | null;
    createdAt: string;
  }): void {
    this.#db.prepare(`
      INSERT INTO identity_audit_events (
        id, account_user_id, actor_user_id, action, target_user_id,
        resource_id, outcome, created_at
      ) VALUES (
        @id, @accountUserId, @actorUserId, @action, @targetUserId,
        @resourceId, 'succeeded', @createdAt
      )
    `).run(input);
  }

  setUserLastSeen(userId: string, at: string): void {
    this.#db.prepare("UPDATE users SET last_seen_at = ?, updated_at = ? WHERE id = ?").run(at, at, userId);
  }

  createSession(session: NewSession, token: NewRefreshToken): SessionRecord {
    this.#db.prepare(`
      INSERT INTO device_sessions (
        id, user_id, device_name, created_at, last_seen_at, expires_at
      ) VALUES (@id, @userId, @deviceName, @createdAt, @createdAt, @expiresAt)
    `).run(session);
    this.#db.prepare(`
      INSERT INTO refresh_tokens (id, session_id, token_hash, created_at, expires_at)
      VALUES (@id, @sessionId, @tokenHash, @createdAt, @expiresAt)
    `).run(token);
    const row = this.#db.prepare("SELECT * FROM device_sessions WHERE id = ?").get(session.id) as SessionRow;
    return mapSession(row);
  }

  findRefreshToken(tokenHash: string): (RefreshTokenRecord & { session: SessionRecord }) | null {
    const row = this.#db.prepare(`
      SELECT
        rt.id AS token_id, rt.session_id AS token_session_id, rt.token_hash,
        rt.created_at AS token_created_at, rt.expires_at AS token_expires_at,
        rt.used_at AS token_used_at,
        ds.id AS session_id, ds.user_id AS session_user_id, ds.device_name AS session_device_name,
        ds.created_at AS session_created_at, ds.last_seen_at AS session_last_seen_at,
        ds.expires_at AS session_expires_at, ds.revoked_at AS session_revoked_at
      FROM refresh_tokens rt
      JOIN device_sessions ds ON ds.id = rt.session_id
      WHERE rt.token_hash = ?
    `).get(tokenHash) as RefreshRow | undefined;
    if (row === undefined) return null;
    return {
      id: row.token_id,
      sessionId: row.token_session_id,
      tokenHash: row.token_hash,
      createdAt: row.token_created_at,
      expiresAt: row.token_expires_at,
      usedAt: row.token_used_at,
      session: {
        id: row.session_id,
        userId: row.session_user_id,
        deviceName: row.session_device_name,
        createdAt: row.session_created_at,
        lastSeenAt: row.session_last_seen_at,
        expiresAt: row.session_expires_at,
        revokedAt: row.session_revoked_at
      }
    };
  }

  rotateRefreshToken(oldTokenId: string, replacement: NewRefreshToken, usedAt: string): boolean {
    if (replacement.createdAt !== usedAt || replacement.expiresAt <= usedAt) return false;
    // Keep the repository primitive atomic even if a future caller forgets an
    // outer service transaction. When nested under BEGIN IMMEDIATE,
    // better-sqlite3 uses a savepoint and retains the outer writer reservation.
    return this.#db.transaction(() => {
      const updated = this.#db.prepare(`
        UPDATE refresh_tokens
        SET used_at = @usedAt
        WHERE id = @oldTokenId
          AND session_id = @sessionId
          AND used_at IS NULL
          AND created_at <= @usedAt
          AND expires_at > @usedAt
          AND expires_at >= @replacementExpiresAt
          AND EXISTS (
            SELECT 1 FROM device_sessions ds
            WHERE ds.id = refresh_tokens.session_id
              AND ds.revoked_at IS NULL
              AND ds.expires_at > @usedAt
              AND ds.expires_at >= @replacementExpiresAt
          )
      `).run({
        oldTokenId,
        sessionId: replacement.sessionId,
        usedAt,
        replacementExpiresAt: replacement.expiresAt
      });
      if (updated.changes !== 1) return false;
      this.#db.prepare(`
        INSERT INTO refresh_tokens (id, session_id, token_hash, created_at, expires_at)
        VALUES (@id, @sessionId, @tokenHash, @createdAt, @expiresAt)
      `).run(replacement);
      return true;
    })();
  }

  revokeSession(sessionId: string, at: string): void {
    this.#db.transaction(() => {
      this.#db.prepare("UPDATE device_sessions SET revoked_at = COALESCE(revoked_at, ?) WHERE id = ?")
        .run(at, sessionId);
      this.#db.prepare(`
        UPDATE push_registrations
        SET revoked_at = COALESCE(revoked_at, @at),
            updated_at = CASE WHEN updated_at < @at THEN @at ELSE updated_at END
        WHERE session_id = @sessionId AND revoked_at IS NULL
      `).run({ sessionId, at });
    }).immediate();
  }

  isSessionActive(sessionId: string, userId: string, now: string): boolean {
    const row = this.#db.prepare(`
      SELECT 1 AS active FROM device_sessions
      WHERE id = ? AND user_id = ? AND revoked_at IS NULL AND expires_at > ?
    `).get(sessionId, userId, now) as { active: number } | undefined;
    return row !== undefined;
  }

  touchSession(sessionId: string, at: string): void {
    this.#db.prepare(`
      UPDATE device_sessions
      SET last_seen_at = CASE WHEN last_seen_at < ? THEN ? ELSE last_seen_at END
      WHERE id = ? AND revoked_at IS NULL
    `).run(at, at, sessionId);
  }

  listSessions(userId: string, currentSessionId: string): Session[] {
    const rows = this.#db.prepare(`
      SELECT * FROM device_sessions
      WHERE user_id = ? AND revoked_at IS NULL AND expires_at > ?
      ORDER BY last_seen_at DESC, id DESC
    `).all(userId, new Date().toISOString()) as SessionRow[];
    return rows.map((row) => ({
      id: row.id,
      deviceName: row.device_name,
      createdAt: row.created_at,
      lastSeenAt: row.last_seen_at,
      expiresAt: row.expires_at,
      current: row.id === currentSessionId
    }));
  }

  findChatRecord(id: string): ChatRecord | null {
    const row = this.#db.prepare("SELECT * FROM chats WHERE id = ?").get(id) as ChatRow | undefined;
    return row === undefined ? null : mapChat(row);
  }

  findDirectChat(directKey: string): ChatRecord | null {
    const row = this.#db.prepare("SELECT * FROM chats WHERE direct_key = ?").get(directKey) as ChatRow | undefined;
    return row === undefined ? null : mapChat(row);
  }

  createChat(chat: NewChat): ChatRecord {
    this.#db.prepare(`
      INSERT INTO chats (
        id, kind, title, direct_key, created_by, created_at, updated_at
      ) VALUES (@id, @kind, @title, @directKey, @createdBy, @createdAt, @createdAt)
    `).run(chat);
    return this.findChatRecord(chat.id) as ChatRecord;
  }

  addChatMember(chatId: string, userId: string, role: ChatRole, joinedAt: string): void {
    const ledger = this.#db.prepare(`
      SELECT last_revision, last_removed_at
      FROM chat_membership_revision_ledger
      WHERE chat_id = ? AND user_id = ?
    `).get(chatId, userId) as ChatMembershipRevisionLedgerRow | undefined;
    const effectiveJoinedAt = ledger === undefined
      ? joinedAt
      : timestampAfterFloor(joinedAt, ledger.last_removed_at);
    const revision = ledger === undefined ? 1 : ledger.last_revision + 1;
    this.#db.prepare(`
      INSERT OR IGNORE INTO chat_members (
        chat_id, user_id, role, membership_revision, joined_at, membership_updated_at
      ) VALUES (?, ?, ?, ?, ?, ?)
    `).run(chatId, userId, role, revision, effectiveJoinedAt, effectiveJoinedAt);
  }

  getChatMember(chatId: string, userId: string): ChatMemberRecord | null {
    const row = this.#db.prepare(`
      SELECT chat_id, user_id, role, membership_revision, joined_at,
             COALESCE(membership_updated_at, joined_at) AS membership_updated_at
      FROM chat_members WHERE chat_id = ? AND user_id = ?
    `).get(chatId, userId) as ChatMemberRow | undefined;
    return row === undefined ? null : mapChatMember(row);
  }

  listChatMembers(chatId: string): ChatMemberRecord[] {
    const rows = this.#db.prepare(`
      SELECT chat_id, user_id, role, membership_revision, joined_at,
             COALESCE(membership_updated_at, joined_at) AS membership_updated_at
      FROM chat_members
      WHERE chat_id = ?
      ORDER BY joined_at ASC, user_id ASC
    `).all(chatId) as ChatMemberRow[];
    return rows.map(mapChatMember);
  }

  listChatMemberIds(chatId: string): string[] {
    const rows = this.#db.prepare("SELECT user_id FROM chat_members WHERE chat_id = ?")
      .all(chatId) as Array<{ user_id: string }>;
    return rows.map(({ user_id }) => user_id);
  }

  countChatMembers(chatId: string): number {
    const row = this.#db.prepare(`
      SELECT count(*) AS count FROM chat_members WHERE chat_id = ?
    `).get(chatId) as { count: number };
    return row.count;
  }

  createChatMember(
    chatId: string,
    userId: string,
    role: Exclude<ChatRole, "owner">,
    at: string
  ): ChatMemberRecord | null {
    const ledger = this.#db.prepare(`
      SELECT last_revision, last_removed_at
      FROM chat_membership_revision_ledger
      WHERE chat_id = ? AND user_id = ?
    `).get(chatId, userId) as ChatMembershipRevisionLedgerRow | undefined;
    const effectiveAt = ledger === undefined
      ? at
      : timestampAfterFloor(at, ledger.last_removed_at);
    const revision = ledger === undefined ? 1 : ledger.last_revision + 1;
    const result = this.#db.prepare(`
      INSERT INTO chat_members (
        chat_id, user_id, role, membership_revision, joined_at, membership_updated_at
      ) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(chat_id, user_id) DO NOTHING
    `).run(chatId, userId, role, revision, effectiveAt, effectiveAt);
    return result.changes === 1 ? this.getChatMember(chatId, userId) : null;
  }

  updateChatMemberRole(
    chatId: string,
    userId: string,
    role: Exclude<ChatRole, "owner">,
    expectedRevision: number,
    at: string
  ): ChatMemberRecord | null {
    const result = this.#db.prepare(`
      UPDATE chat_members
      SET role = ?, membership_revision = membership_revision + 1, membership_updated_at = ?
      WHERE chat_id = ? AND user_id = ? AND membership_revision = ? AND role <> ?
    `).run(role, at, chatId, userId, expectedRevision, role);
    return result.changes === 1 ? this.getChatMember(chatId, userId) : null;
  }

  removeChatMember(
    chatId: string,
    userId: string,
    expectedRevision: number,
    at: string
  ): ChatMemberRecord | null {
    return this.#db.transaction(() => {
      const current = this.getChatMember(chatId, userId);
      if (current === null || current.revision !== expectedRevision) return null;
      const ledger = this.#db.prepare(`
        SELECT last_revision, last_removed_at
        FROM chat_membership_revision_ledger
        WHERE chat_id = ? AND user_id = ?
      `).get(chatId, userId) as ChatMembershipRevisionLedgerRow | undefined;
      const revision = current.revision + 1;
      if (ledger !== undefined && revision <= ledger.last_revision) return null;
      const removedAt = timestampAfterFloor(
        timestampAfterFloor(at, current.updatedAt),
        ledger?.last_removed_at ?? current.updatedAt
      );
      // A removed account must never recover an old private draft if it is
      // later re-added. Keep the tombstone revision so stale devices still
      // cannot overwrite a newer state after the membership lifecycle.
      this.tombstoneChatDraftForMembershipRemoval(userId, chatId, removedAt);
      const ledgerResult = this.#db.prepare(`
        INSERT INTO chat_membership_revision_ledger (
          chat_id, user_id, last_revision, last_removed_at
        ) VALUES (?, ?, ?, ?)
        ON CONFLICT(chat_id, user_id) DO UPDATE SET
          last_revision = excluded.last_revision,
          last_removed_at = excluded.last_removed_at
        WHERE excluded.last_revision > chat_membership_revision_ledger.last_revision
          AND julianday(excluded.last_removed_at) >
            julianday(chat_membership_revision_ledger.last_removed_at)
      `).run(chatId, userId, revision, removedAt);
      if (ledgerResult.changes !== 1) return null;
      const result = this.#db.prepare(`
        DELETE FROM chat_members
        WHERE chat_id = ? AND user_id = ? AND membership_revision = ?
      `).run(chatId, userId, expectedRevision);
      if (result.changes !== 1) return null;
      this.#db.prepare(`
        DELETE FROM chat_draft_command_receipts
        WHERE user_id = ? AND chat_id = ?
      `).run(userId, chatId);
      this.#db.prepare(`
        DELETE FROM realtime_events
        WHERE audience_user_id = ?
          AND event_type = 'chat.draft.changed'
          AND entity_id = ?
      `).run(userId, `${chatId}:${userId}`);
      return { ...current, revision, updatedAt: removedAt };
    }).immediate();
  }

  findChatMembershipCommandReceipt(
    actorUserId: string,
    clientNonce: string
  ): ChatMembershipCommandReceiptRecord | null {
    const row = this.#db.prepare(`
      SELECT * FROM chat_membership_command_receipts
      WHERE actor_user_id = ? AND client_nonce = ?
    `).get(actorUserId, clientNonce) as ChatMembershipCommandReceiptRow | undefined;
    if (row === undefined) return null;
    return {
      actorUserId: row.actor_user_id,
      clientNonce: row.client_nonce,
      operation: row.operation,
      chatId: row.chat_id,
      targetUserId: row.target_user_id,
      fingerprint: row.fingerprint,
      membership: {
        chatId: row.chat_id,
        userId: row.target_user_id,
        role: row.result_role,
        revision: row.result_revision,
        joinedAt: row.result_joined_at,
        updatedAt: row.result_updated_at
      },
      createdAt: row.created_at
    };
  }

  createChatMembershipCommandReceipt(receipt: ChatMembershipCommandReceiptRecord): void {
    this.#db.prepare(`
      INSERT INTO chat_membership_command_receipts (
        actor_user_id, client_nonce, operation, chat_id, target_user_id, fingerprint,
        result_role, result_revision, result_joined_at, result_updated_at, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      receipt.actorUserId,
      receipt.clientNonce,
      receipt.operation,
      receipt.chatId,
      receipt.targetUserId,
      receipt.fingerprint,
      receipt.membership.role,
      receipt.membership.revision,
      receipt.membership.joinedAt,
      receipt.membership.updatedAt,
      receipt.createdAt
    );
  }

  listPeerUserIds(userId: string): string[] {
    const rows = this.#db.prepare(`
      SELECT DISTINCT peers.user_id
      FROM chat_members own
      JOIN chat_members peers ON peers.chat_id = own.chat_id AND peers.user_id <> own.user_id
      WHERE own.user_id = ?
        AND EXISTS (
          SELECT 1 FROM account_relationships relationships
          WHERE (relationships.left_user_id = own.user_id AND relationships.right_user_id = peers.user_id)
             OR (relationships.right_user_id = own.user_id AND relationships.left_user_id = peers.user_id)
        )
        AND NOT EXISTS (
          SELECT 1 FROM account_blocks blocks
          WHERE (blocks.blocker_user_id = own.user_id AND blocks.blocked_user_id = peers.user_id)
             OR (blocks.blocker_user_id = peers.user_id AND blocks.blocked_user_id = own.user_id)
        )
    `).all(userId) as Array<{ user_id: string }>;
    return rows.map(({ user_id }) => user_id);
  }

  getChatForUser(chatId: string, userId: string): Chat | null {
    const row = this.#db.prepare(`
      SELECT c.*, cm.role, cm.archived_at, cm.muted_until,
        (SELECT count(*) FROM chat_members members WHERE members.chat_id = c.id) AS member_count
      FROM chats c
      JOIN chat_members cm ON cm.chat_id = c.id AND cm.user_id = ?
      WHERE c.id = ?
    `).get(userId, chatId) as (ChatRow & {
      role: ChatRole;
      member_count: number;
      archived_at: string | null;
      muted_until: string | null;
    }) | undefined;
    if (row === undefined) return null;

    let title = row.title ?? "";
    if (row.kind === "direct") {
      const other = this.#db.prepare(`
        SELECT u.display_name FROM chat_members cm
        JOIN users u ON u.id = cm.user_id
        WHERE cm.chat_id = ? AND cm.user_id <> ? LIMIT 1
      `).get(chatId, userId) as { display_name: string } | undefined;
      title = other?.display_name ?? "Избранное";
    }

    const unread = this.#db.prepare(`
      SELECT count(*) AS count
      FROM messages m
      LEFT JOIN chat_reads cr ON cr.chat_id = m.chat_id AND cr.user_id = @userId
      LEFT JOIN messages read_message ON read_message.id = cr.last_read_message_id
      WHERE m.chat_id = @chatId AND m.sender_id <> @userId
        AND m.deleted_at IS NULL
        AND (read_message.id IS NULL OR m.created_at > read_message.created_at
          OR (m.created_at = read_message.created_at AND m.id > read_message.id))
    `).get({ chatId, userId }) as { count: number };

    return {
      id: row.id,
      kind: row.kind,
      title,
      avatarUrl: row.avatar_url,
      role: row.role,
      memberCount: row.member_count,
      lastMessage: row.last_message_id === null ? null : this.getMessage(row.last_message_id),
      lastActivityAt: row.updated_at,
      createdAt: row.created_at,
      unreadCount: unread.count,
      archivedAt: row.archived_at,
      mutedUntil: row.muted_until
    };
  }

  getChatPreferences(chatId: string, userId: string): ChatPreferences | null {
    const row = this.#db.prepare(`
      SELECT archived_at, muted_until
      FROM chat_members
      WHERE chat_id = ? AND user_id = ?
    `).get(chatId, userId) as {
      archived_at: string | null;
      muted_until: string | null;
    } | undefined;
    return row === undefined ? null : {
      archivedAt: row.archived_at,
      mutedUntil: row.muted_until
    };
  }

  updateChatPreferences(
    chatId: string,
    userId: string,
    input: { archived?: boolean; mutedUntil?: string | null; changedAt: string }
  ): ChatPreferences | null {
    const result = this.#db.prepare(`
      UPDATE chat_members
      SET archived_at = CASE
            WHEN @writeArchived = 0 THEN archived_at
            WHEN @archived = 1 THEN COALESCE(archived_at, @changedAt)
            ELSE NULL
          END,
          muted_until = CASE
            WHEN @writeMutedUntil = 0 THEN muted_until
            ELSE @mutedUntil
          END
      WHERE chat_id = @chatId AND user_id = @userId
    `).run({
      chatId,
      userId,
      writeArchived: input.archived === undefined ? 0 : 1,
      archived: input.archived === true ? 1 : 0,
      changedAt: input.changedAt,
      writeMutedUntil: input.mutedUntil === undefined ? 0 : 1,
      mutedUntil: input.mutedUntil ?? null
    });
    return result.changes === 1 ? this.getChatPreferences(chatId, userId) : null;
  }

  getChatFolderStateRevision(userId: string): number {
    const row = this.#db.prepare(`
      SELECT revision FROM chat_folder_states WHERE user_id = ?
    `).get(userId) as { revision: number } | undefined;
    return row?.revision ?? 0;
  }

  advanceChatFolderStateRevision(userId: string, at: string): number {
    this.#db.prepare(`
      INSERT INTO chat_folder_states (user_id, revision, updated_at)
      VALUES (?, 0, ?)
      ON CONFLICT(user_id) DO NOTHING
    `).run(userId, at);
    const row = this.#db.prepare(`
      UPDATE chat_folder_states
      SET revision = revision + 1,
          updated_at = CASE WHEN updated_at > @at THEN updated_at ELSE @at END
      WHERE user_id = @userId
      RETURNING revision
    `).get({ userId, at }) as { revision: number } | undefined;
    if (row === undefined) throw new Error("Could not advance chat folder state revision");
    return row.revision;
  }

  countChatFolders(userId: string): number {
    return (this.#db.prepare(`
      SELECT count(*) AS count FROM chat_folders WHERE user_id = ?
    `).get(userId) as { count: number }).count;
  }

  listChatFolders(userId: string): ChatFolderRecord[] {
    const rows = this.#db.prepare(`
      SELECT * FROM chat_folders
      WHERE user_id = ?
      ORDER BY position, id
    `).all(userId) as ChatFolderRow[];
    return rows.map((row) => this.#mapChatFolder(row));
  }

  getChatFolderSnapshot(userId: string): {
    items: ChatFolderRecord[];
    stateRevision: number;
  } {
    return this.transaction(() => ({
      items: this.listChatFolders(userId),
      stateRevision: this.getChatFolderStateRevision(userId)
    }));
  }

  findChatFolder(userId: string, folderId: string): ChatFolderRecord | null {
    const row = this.#db.prepare(`
      SELECT * FROM chat_folders
      WHERE user_id = ? AND id = ?
    `).get(userId, folderId) as ChatFolderRow | undefined;
    return row === undefined ? null : this.#mapChatFolder(row);
  }

  createChatFolder(folder: ChatFolderRecord): ChatFolderRecord {
    this.#db.prepare(`
      INSERT INTO chat_folders (
        id, user_id, title, position, revision,
        include_direct, include_group, include_channel,
        unread_only, exclude_muted, include_archived,
        created_at, updated_at
      ) VALUES (
        @id, @userId, @title, @position, @revision,
        @includeDirect, @includeGroup, @includeChannel,
        @unreadOnly, @excludeMuted, @includeArchived,
        @createdAt, @updatedAt
      )
    `).run({
      id: folder.id,
      userId: folder.userId,
      title: folder.title,
      position: folder.position,
      revision: folder.revision,
      includeDirect: folder.rules.includeKinds.includes("direct") ? 1 : 0,
      includeGroup: folder.rules.includeKinds.includes("group") ? 1 : 0,
      includeChannel: folder.rules.includeKinds.includes("channel") ? 1 : 0,
      unreadOnly: folder.rules.unreadOnly ? 1 : 0,
      excludeMuted: folder.rules.excludeMuted ? 1 : 0,
      includeArchived: folder.rules.includeArchived ? 1 : 0,
      createdAt: folder.createdAt,
      updatedAt: folder.updatedAt
    });
    this.#replaceChatFolderOverrides(folder.id, folder.userId, folder.overrides, folder.createdAt);
    return this.findChatFolder(folder.userId, folder.id) as ChatFolderRecord;
  }

  updateChatFolder(
    userId: string,
    folderId: string,
    input: {
      title: string;
      rules: ChatFolderRecord["rules"];
      overrides: ChatFolderOverrideRecord[];
      expectedRevision: number;
      updatedAt: string;
    }
  ): ChatFolderRecord | null {
    const result = this.#db.prepare(`
      UPDATE chat_folders
      SET title = @title,
          revision = revision + 1,
          include_direct = @includeDirect,
          include_group = @includeGroup,
          include_channel = @includeChannel,
          unread_only = @unreadOnly,
          exclude_muted = @excludeMuted,
          include_archived = @includeArchived,
          updated_at = @updatedAt
      WHERE id = @folderId AND user_id = @userId AND revision = @expectedRevision
    `).run({
      userId,
      folderId,
      title: input.title,
      expectedRevision: input.expectedRevision,
      includeDirect: input.rules.includeKinds.includes("direct") ? 1 : 0,
      includeGroup: input.rules.includeKinds.includes("group") ? 1 : 0,
      includeChannel: input.rules.includeKinds.includes("channel") ? 1 : 0,
      unreadOnly: input.rules.unreadOnly ? 1 : 0,
      excludeMuted: input.rules.excludeMuted ? 1 : 0,
      includeArchived: input.rules.includeArchived ? 1 : 0,
      updatedAt: input.updatedAt
    });
    if (result.changes !== 1) return null;
    this.#replaceChatFolderOverrides(folderId, userId, input.overrides, input.updatedAt);
    return this.findChatFolder(userId, folderId);
  }

  deleteChatFolder(userId: string, folderId: string, expectedRevision: number): boolean {
    return this.#db.prepare(`
      DELETE FROM chat_folders
      WHERE id = ? AND user_id = ? AND revision = ?
    `).run(folderId, userId, expectedRevision).changes === 1;
  }

  reorderChatFolders(userId: string, orderedFolderIds: string[], at: string): ChatFolderRecord[] {
    const update = this.#db.prepare(`
      UPDATE chat_folders
      SET position = @position,
          revision = revision + 1,
          updated_at = @updatedAt
      WHERE id = @folderId AND user_id = @userId AND position <> @position
    `);
    for (const [position, folderId] of orderedFolderIds.entries()) {
      update.run({ position, folderId, userId, updatedAt: at });
    }
    return this.listChatFolders(userId);
  }

  findChatFolderCommandReceipt(
    userId: string,
    clientNonce: string,
    at: string
  ): ChatFolderCommandReceiptRecord | null {
    const row = this.#db.prepare(`
      SELECT *, COALESCE(
        expires_at,
        strftime('%Y-%m-%dT%H:%M:%fZ', created_at, '+1 day')
      ) AS effective_expires_at
      FROM chat_folder_command_receipts
      WHERE user_id = ? AND client_nonce = ?
        AND julianday(COALESCE(
          expires_at,
          strftime('%Y-%m-%dT%H:%M:%fZ', created_at, '+1 day')
        )) > julianday(?)
    `).get(userId, clientNonce, at) as ChatFolderCommandReceiptRow | undefined;
    if (row === undefined) return null;
    return {
      userId: row.user_id,
      clientNonce: row.client_nonce,
      operation: row.operation,
      fingerprint: row.fingerprint,
      responseJson: this.contentCipher.decrypt(
        row.response_ciphertext,
        `chat-folder-receipt:${row.user_id}:${row.client_nonce}`
      ),
      createdAt: row.created_at,
      expiresAt: row.effective_expires_at
    };
  }

  createChatFolderCommandReceipt(receipt: ChatFolderCommandReceiptRecord): void {
    this.#db.prepare(`
      INSERT INTO chat_folder_command_receipts (
        user_id, client_nonce, operation, fingerprint,
        response_ciphertext, created_at, expires_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      receipt.userId,
      receipt.clientNonce,
      receipt.operation,
      receipt.fingerprint,
      this.contentCipher.encrypt(
        receipt.responseJson,
        `chat-folder-receipt:${receipt.userId}:${receipt.clientNonce}`
      ),
      receipt.createdAt,
      receipt.expiresAt
    );
  }

  countActiveChatFolderCommandReceipts(userId: string, at: string): number {
    return (this.#db.prepare(`
      SELECT count(*) AS count
      FROM chat_folder_command_receipts
      WHERE user_id = ?
        AND julianday(COALESCE(
          expires_at,
          strftime('%Y-%m-%dT%H:%M:%fZ', created_at, '+1 day')
        )) > julianday(?)
    `).get(userId, at) as { count: number }).count;
  }

  getOldestChatFolderCommandReceiptExpiry(userId: string, at: string): string | null {
    const row = this.#db.prepare(`
      SELECT COALESCE(
        expires_at,
        strftime('%Y-%m-%dT%H:%M:%fZ', created_at, '+1 day')
      ) AS effective_expires_at
      FROM chat_folder_command_receipts
      WHERE user_id = ?
        AND julianday(COALESCE(
          expires_at,
          strftime('%Y-%m-%dT%H:%M:%fZ', created_at, '+1 day')
        )) > julianday(?)
      ORDER BY julianday(effective_expires_at), client_nonce
      LIMIT 1
    `).get(userId, at) as { effective_expires_at: string } | undefined;
    return row?.effective_expires_at ?? null;
  }

  deleteExpiredChatFolderCommandReceipt(
    userId: string,
    clientNonce: string,
    at: string
  ): boolean {
    return this.#db.prepare(`
      DELETE FROM chat_folder_command_receipts
      WHERE user_id = ? AND client_nonce = ?
        AND julianday(COALESCE(
          expires_at,
          strftime('%Y-%m-%dT%H:%M:%fZ', created_at, '+1 day')
        )) <= julianday(?)
    `).run(userId, clientNonce, at).changes === 1;
  }

  purgeExpiredChatFolderCommandReceipts(at: string, limit: number): number {
    const current = this.#db.prepare(`
      DELETE FROM chat_folder_command_receipts
      WHERE rowid IN (
        SELECT rowid
        FROM chat_folder_command_receipts INDEXED BY idx_chat_folder_receipts_expiry
        WHERE expires_at IS NOT NULL AND expires_at <= @at
        ORDER BY expires_at, user_id, client_nonce
        LIMIT @limit
      )
    `).run({ at, limit }).changes;
    const remaining = limit - current;
    if (remaining <= 0) return current;

    const legacyCutoff = new Date(
      Date.parse(at) - CHAT_FOLDER_IDEMPOTENCY_TTL_SECONDS * 1_000
    ).toISOString();
    const legacy = this.#db.prepare(`
      DELETE FROM chat_folder_command_receipts
      WHERE rowid IN (
        SELECT rowid
        FROM chat_folder_command_receipts INDEXED BY idx_chat_folder_receipts_legacy_expiry
        WHERE expires_at IS NULL AND created_at <= @legacyCutoff
        ORDER BY created_at, user_id, client_nonce
        LIMIT @limit
      )
    `).run({ legacyCutoff, limit: remaining }).changes;
    return current + legacy;
  }

  getChatDraft(userId: string, chatId: string): ChatDraftRecord | null {
    const row = this.#db.prepare(`
      SELECT * FROM chat_drafts WHERE user_id = ? AND chat_id = ?
    `).get(userId, chatId) as ChatDraftRow | undefined;
    return row === undefined ? null : this.#mapChatDraft(row);
  }

  putChatDraft(
    userId: string,
    chatId: string,
    input: {
      text: string;
      replyToMessageId: string | null;
      expectedRevision: number;
      updatedAt: string;
    }
  ): ChatDraftRecord | null {
    const encryptedText = this.contentCipher.encrypt(
      input.text,
      `chat-draft:${userId}:${chatId}:text`
    );
    const row = this.#db.prepare(`
      INSERT INTO chat_drafts (
        user_id, chat_id, text_ciphertext, reply_to_message_id,
        revision, updated_at, deleted_at
      ) SELECT
        @userId, @chatId, @textCiphertext, @replyToMessageId,
        1, @updatedAt, NULL
      WHERE @expectedRevision = 0 OR EXISTS (
        SELECT 1 FROM chat_drafts
        WHERE user_id = @userId AND chat_id = @chatId
          AND revision = @expectedRevision
      )
      ON CONFLICT(user_id, chat_id) DO UPDATE SET
        text_ciphertext = excluded.text_ciphertext,
        reply_to_message_id = excluded.reply_to_message_id,
        revision = chat_drafts.revision + 1,
        updated_at = excluded.updated_at,
        deleted_at = NULL
      WHERE chat_drafts.revision = @expectedRevision
      RETURNING *
    `).get({
      userId,
      chatId,
      textCiphertext: encryptedText,
      replyToMessageId: input.replyToMessageId,
      expectedRevision: input.expectedRevision,
      updatedAt: input.updatedAt
    }) as ChatDraftRow | undefined;
    if (row === undefined || (input.expectedRevision === 0 && row.revision !== 1)) return null;
    return this.#mapChatDraft(row);
  }

  deleteChatDraft(
    userId: string,
    chatId: string,
    expectedRevision: number,
    updatedAt: string
  ): ChatDraftRecord | null {
    const row = this.#db.prepare(`
      UPDATE chat_drafts
      SET text_ciphertext = NULL,
          reply_to_message_id = NULL,
          revision = revision + 1,
          updated_at = @updatedAt,
          deleted_at = @updatedAt
      WHERE user_id = @userId AND chat_id = @chatId
        AND revision = @expectedRevision AND deleted_at IS NULL
      RETURNING *
    `).get({ userId, chatId, expectedRevision, updatedAt }) as ChatDraftRow | undefined;
    return row === undefined ? null : this.#mapChatDraft(row);
  }

  tombstoneChatDraftForMembershipRemoval(
    userId: string,
    chatId: string,
    updatedAt: string
  ): ChatDraftRecord | null {
    const current = this.getChatDraft(userId, chatId);
    if (current === null || current.deletedAt !== null) return null;
    const effectiveAt = timestampAfterFloor(updatedAt, current.updatedAt);
    return this.deleteChatDraft(userId, chatId, current.revision, effectiveAt);
  }

  findChatDraftCommandReceipt(
    userId: string,
    clientNonce: string,
    at: string
  ): ChatDraftCommandReceiptRecord | null {
    const row = this.#db.prepare(`
      SELECT * FROM chat_draft_command_receipts
      WHERE user_id = ? AND client_nonce = ?
        AND expires_at > ?
    `).get(userId, clientNonce, at) as ChatDraftCommandReceiptRow | undefined;
    if (row === undefined) return null;
    return {
      userId: row.user_id,
      clientNonce: row.client_nonce,
      operation: row.operation,
      chatId: row.chat_id,
      fingerprint: this.contentCipher.decrypt(
        row.fingerprint_ciphertext,
        `chat-draft-receipt-fingerprint:${row.user_id}:${row.client_nonce}`
      ),
      responseJson: this.contentCipher.decrypt(
        row.response_ciphertext,
        `chat-draft-receipt:${row.user_id}:${row.client_nonce}`
      ),
      createdAt: row.created_at,
      expiresAt: row.expires_at
    };
  }

  createChatDraftCommandReceipt(receipt: ChatDraftCommandReceiptRecord): void {
    this.#db.prepare(`
      INSERT INTO chat_draft_command_receipts (
        user_id, client_nonce, operation, chat_id,
        fingerprint_ciphertext, response_ciphertext, created_at, expires_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      receipt.userId,
      receipt.clientNonce,
      receipt.operation,
      receipt.chatId,
      this.contentCipher.encrypt(
        receipt.fingerprint,
        `chat-draft-receipt-fingerprint:${receipt.userId}:${receipt.clientNonce}`
      ),
      this.contentCipher.encrypt(
        receipt.responseJson,
        `chat-draft-receipt:${receipt.userId}:${receipt.clientNonce}`
      ),
      receipt.createdAt,
      receipt.expiresAt
    );
  }

  countActiveChatDraftCommandReceipts(userId: string, at: string): number {
    return (this.#db.prepare(`
      SELECT count(*) AS count
      FROM chat_draft_command_receipts
      WHERE user_id = ? AND expires_at > ?
    `).get(userId, at) as { count: number }).count;
  }

  getOldestChatDraftCommandReceiptExpiry(userId: string, at: string): string | null {
    const row = this.#db.prepare(`
      SELECT expires_at
      FROM chat_draft_command_receipts
      WHERE user_id = ? AND expires_at > ?
      ORDER BY expires_at, client_nonce
      LIMIT 1
    `).get(userId, at) as { expires_at: string } | undefined;
    return row?.expires_at ?? null;
  }

  deleteExpiredChatDraftCommandReceipt(
    userId: string,
    clientNonce: string,
    at: string
  ): boolean {
    return this.#db.prepare(`
      DELETE FROM chat_draft_command_receipts
      WHERE user_id = ? AND client_nonce = ? AND expires_at <= ?
    `).run(userId, clientNonce, at).changes === 1;
  }

  purgeExpiredChatDraftCommandReceipts(at: string, limit: number): number {
    return this.#db.prepare(`
      DELETE FROM chat_draft_command_receipts
      WHERE rowid IN (
        SELECT rowid
        FROM chat_draft_command_receipts INDEXED BY idx_chat_draft_receipts_expiry
        WHERE expires_at <= @at
        ORDER BY expires_at, user_id, client_nonce
        LIMIT @limit
      )
    `).run({ at, limit }).changes;
  }

  listChats(userId: string, limit: number, cursor?: string): { items: Chat[]; nextCursor: string | null } {
    const decoded = decodeCursor(cursor);
    const rows = this.#db.prepare(`
      SELECT c.* FROM chats c
      JOIN chat_members cm ON cm.chat_id = c.id AND cm.user_id = @userId
      WHERE (@cursorValue IS NULL OR c.updated_at < @cursorValue
        OR (c.updated_at = @cursorValue AND c.id < @cursorId))
      ORDER BY c.updated_at DESC, c.id DESC
      LIMIT @take
    `).all({
      userId,
      cursorValue: decoded?.value ?? null,
      cursorId: decoded?.id ?? null,
      take: limit + 1
    }) as ChatRow[];
    const hasMore = rows.length > limit;
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    return {
      items: page.map((row) => this.getChatForUser(row.id, userId)).filter((chat): chat is Chat => chat !== null),
      nextCursor: hasMore && last !== undefined
        ? encodeCursor({ value: last.updated_at, id: last.id })
        : null
    };
  }

  listChatsForReconciliation(
    userId: string,
    limit: number,
    cursor?: string
  ): { items: Chat[]; nextCursor: string | null } {
    const decoded = decodeCursor(cursor);
    const rows = this.#db.prepare(`
      SELECT c.* FROM chats c
      JOIN chat_members cm ON cm.chat_id = c.id AND cm.user_id = @userId
      WHERE (@cursorValue IS NULL OR c.created_at < @cursorValue
        OR (c.created_at = @cursorValue AND c.id < @cursorId))
      ORDER BY c.created_at DESC, c.id DESC
      LIMIT @take
    `).all({
      userId,
      cursorValue: decoded?.value ?? null,
      cursorId: decoded?.id ?? null,
      take: limit + 1
    }) as ChatRow[];
    const hasMore = rows.length > limit;
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    return {
      items: page
        .map((row) => this.getChatForUser(row.id, userId))
        .filter((chat): chat is Chat => chat !== null),
      nextCursor: hasMore && last !== undefined
        ? encodeCursor({ value: last.created_at, id: last.id })
        : null
    };
  }

  findMessageRecord(id: string): MessageRecord | null {
    const row = this.#db.prepare("SELECT * FROM messages WHERE id = ?").get(id) as MessageRow | undefined;
    return row === undefined ? null : this.#mapMessage(row);
  }

  attachMessageTranscript(input: AttachMessageTranscript):
    | { status: "attached" | "replayed"; message: MessageRecord }
    | { status: "nonce_conflict" }
    | null {
    return this.#db.transaction(() => {
      const existing = this.#db.prepare(`
        SELECT client_nonce FROM message_transcript_commands WHERE message_id = ?
      `).get(input.messageId) as { client_nonce: string } | undefined;
      if (existing !== undefined) {
        if (existing.client_nonce !== input.clientNonce) return { status: "nonce_conflict" as const };
        const replayed = this.findMessageRecord(input.messageId);
        if (replayed === null) return null;
        if (replayed.transcript !== input.text) return { status: "nonce_conflict" as const };
        return { status: "replayed" as const, message: replayed };
      }
      const message = this.#db.prepare(`
        SELECT * FROM messages WHERE id = ?
      `).get(input.messageId) as MessageRow | undefined;
      if (
        message === undefined
        || message.deleted_at !== null
        || message.transcription_consent !== 1
      ) return null;
      const kinds = this.#db.prepare(`
        SELECT DISTINCT a.kind AS kind
        FROM message_attachments ma
        JOIN attachments a ON a.id = ma.attachment_id
        WHERE ma.message_id = ?
      `).all(input.messageId) as { kind: string }[];
      if (!kinds.some(({ kind }) => kind === "voice" || kind === "audio")) return null;
      try {
        this.#db.prepare(`
          INSERT INTO message_transcript_commands (message_id, author_user_id, client_nonce, created_at)
          VALUES (@messageId, @authorUserId, @clientNonce, @createdAt)
        `).run(input);
      } catch (error) {
        const unique = typeof error === "object" && error !== null && "code" in error
          && typeof error.code === "string" && error.code.startsWith("SQLITE_CONSTRAINT_UNIQUE");
        if (!unique) throw error;
        const raced = this.#db.prepare(`
          SELECT client_nonce FROM message_transcript_commands WHERE message_id = ?
        `).get(input.messageId) as { client_nonce: string } | undefined;
        if (raced === undefined || raced.client_nonce !== input.clientNonce) {
          return { status: "nonce_conflict" as const };
        }
        const replayed = this.findMessageRecord(input.messageId);
        if (replayed === null) return null;
        if (replayed.transcript !== input.text) return { status: "nonce_conflict" as const };
        return { status: "replayed" as const, message: replayed };
      }
      const updated = this.#db.prepare(`
        UPDATE messages
        SET transcript_ciphertext = @transcriptCiphertext, updated_at = @createdAt
        WHERE id = @messageId
          AND deleted_at IS NULL
          AND transcription_consent = 1
          AND transcript_ciphertext IS NULL
      `).run({
        messageId: input.messageId,
        transcriptCiphertext: this.contentCipher.encrypt(input.text, `message:${input.messageId}:transcript`),
        createdAt: input.createdAt
      });
      if (updated.changes !== 1) return null;
      const record = this.findMessageRecord(input.messageId);
      return record === null ? null : { status: "attached" as const, message: record };
    }).immediate() as
      | { status: "attached" | "replayed"; message: MessageRecord }
      | { status: "nonce_conflict" }
      | null;
  }

  findMessageByNonce(senderId: string, clientNonce: string): MessageRecord | null {
    const row = this.#db.prepare("SELECT * FROM messages WHERE sender_id = ? AND client_nonce = ?")
      .get(senderId, clientNonce) as MessageRow | undefined;
    return row === undefined ? null : this.#mapMessage(row);
  }

  createMessage(message: NewMessage): MessageRecord {
    this.#db.prepare(`
      INSERT INTO messages (
        id, chat_id, sender_id, kind, body, reply_to_message_id, topic_id,
        forwarded_from_message_id, forwarded_from_chat_id, forwarded_from_sender_id,
        forwarded_from_sender_name_ciphertext, forwarded_from_created_at, forward_source_message_id,
        request_fingerprint_ciphertext, client_nonce, transcription_consent, created_at, updated_at
      ) VALUES (@id, @chatId, @senderId, 'text', @body, @replyToMessageId, @topicId,
        @forwardedFromMessageId, @forwardedFromChatId, @forwardedFromSenderId,
        @forwardedFromSenderName, @forwardedFromCreatedAt, @forwardSourceMessageId,
        @requestFingerprint, @clientNonce, @transcriptionConsent, @createdAt, @createdAt)
    `).run({
      ...message,
      transcriptionConsent: message.transcriptionConsent ? 1 : 0,
      forwardSourceMessageId: message.forwardSourceMessageId ?? null,
      requestFingerprint: message.requestFingerprint === null || message.requestFingerprint === undefined
        ? null
        : this.contentCipher.encrypt(
            message.requestFingerprint,
            `message:${message.id}:request-fingerprint`
          ),
      body: message.body === null ? null : this.contentCipher.encrypt(message.body, `message:${message.id}`),
      forwardedFromSenderName: message.forwardedFromSenderName === null
        ? null
        : this.contentCipher.encrypt(
            message.forwardedFromSenderName,
            `message:${message.id}:forward-sender-name`
          )
    });
    this.#db.prepare("UPDATE chats SET last_message_id = ?, updated_at = ? WHERE id = ?")
      .run(message.id, message.createdAt, message.chatId);
    return this.findMessageRecord(message.id) as MessageRecord;
  }

  updateMessage(id: string, body: string | null, expectedRevision: number | undefined, at: string): MessageRecord | null {
    const encryptedBody = body === null ? null : this.contentCipher.encrypt(body, `message:${id}`);
    const result = expectedRevision === undefined
      ? this.#db.prepare(`
          UPDATE messages SET body = ?, revision = revision + 1, updated_at = ?, edited_at = ?
          WHERE id = ? AND deleted_at IS NULL
        `).run(encryptedBody, at, at, id)
      : this.#db.prepare(`
          UPDATE messages SET body = ?, revision = revision + 1, updated_at = ?, edited_at = ?
          WHERE id = ? AND deleted_at IS NULL AND revision = ?
        `).run(encryptedBody, at, at, id, expectedRevision);
    return result.changes === 1 ? this.findMessageRecord(id) : null;
  }

  deleteMessage(id: string, at: string): MessageRecord {
    this.#db.prepare(`
      UPDATE messages SET body = NULL, revision = revision + 1, updated_at = ?, deleted_at = ?
      WHERE id = ? AND deleted_at IS NULL
    `).run(at, at, id);
    return this.findMessageRecord(id) as MessageRecord;
  }

  getMessage(id: string): Message | null {
    const record = this.findMessageRecord(id);
    if (record === null) return null;
    const sender = this.findUserById(record.senderId);
    if (sender === null) return null;
    const tombstone = record.deletedAt !== null;
    return {
      id: record.id,
      chatId: record.chatId,
      sender: publicUser(sender),
      kind: tombstone ? "text" : this.listMessageAttachmentIds(record.id).length === 0 ? "text" : "media",
      body: tombstone ? null : record.body,
      replyToMessageId: tombstone ? null : record.replyToMessageId,
      topicId: record.topicId,
      forwardedFrom: tombstone ? null : this.#forwardProvenance(record),
      attachments: tombstone ? [] : this.#listMessageAttachments(record.id),
      transcriptionAllowed: !tombstone && record.transcriptionConsent,
      transcript: tombstone ? null : record.transcript,
      isPinned: !tombstone && this.#db.prepare("SELECT 1 AS pinned FROM chat_pins WHERE chat_id = ? AND message_id = ?")
        .get(record.chatId, record.id) !== undefined,
      clientNonce: record.clientNonce,
      revision: record.revision,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      editedAt: record.editedAt,
      deletedAt: record.deletedAt
    };
  }

  listMessages(chatId: string, limit: number, cursor?: string, topicId?: string): { items: Message[]; nextCursor: string | null } {
    const decoded = decodeCursor(cursor);
    const rows = this.#db.prepare(`
      SELECT * FROM messages
      WHERE chat_id = @chatId
        AND (@topicId IS NULL OR topic_id = @topicId)
        AND (@cursorValue IS NULL OR created_at < @cursorValue
          OR (created_at = @cursorValue AND id < @cursorId))
      ORDER BY created_at DESC, id DESC
      LIMIT @take
    `).all({
      chatId,
      topicId: topicId ?? null,
      cursorValue: decoded?.value ?? null,
      cursorId: decoded?.id ?? null,
      take: limit + 1
    }) as MessageRow[];
    const hasMore = rows.length > limit;
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    return {
      items: page.map((row) => this.getMessage(row.id)).filter((message): message is Message => message !== null),
      nextCursor: hasMore && last !== undefined
        ? encodeCursor({ value: last.created_at, id: last.id })
        : null
    };
  }

  addMessageAttachment(messageId: string, attachmentId: string, ordinal: number, linkedAt: string): void {
    const inserted = this.#db.prepare(`
      INSERT INTO message_attachments (message_id, attachment_id, ordinal)
      SELECT @messageId, id, @ordinal FROM attachments
      WHERE id = @attachmentId AND deleted_at IS NULL AND deleting_at IS NULL
    `).run({ messageId, attachmentId, ordinal });
    if (inserted.changes !== 1) throw conflict("Attachment is no longer available");
    this.#db.prepare("UPDATE attachments SET linked_at = COALESCE(linked_at, ?) WHERE id = ?")
      .run(linkedAt, attachmentId);
  }

  listMessageAttachmentIds(messageId: string): string[] {
    const rows = this.#db.prepare(`
      SELECT attachment_id FROM message_attachments WHERE message_id = ? ORDER BY ordinal ASC
    `).all(messageId) as Array<{ attachment_id: string }>;
    return rows.map((row) => row.attachment_id);
  }

  addMessageVersion(messageId: string, revision: number, body: string | null, editorUserId: string, at: string): void {
    const id = randomUUID();
    this.#db.prepare(`
      INSERT INTO message_versions (id, message_id, revision, body_ciphertext, editor_user_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      id,
      messageId,
      revision,
      body === null ? null : this.contentCipher.encrypt(body, `message-version:${id}`),
      editorUserId,
      at
    );
  }

  listMessageVersions(messageId: string): MessageVersion[] {
    const rows = this.#db.prepare(`
      SELECT id, message_id, revision, body_ciphertext, editor_user_id, created_at
      FROM message_versions WHERE message_id = ? ORDER BY revision DESC
    `).all(messageId) as Array<{
      id: string;
      message_id: string;
      revision: number;
      body_ciphertext: string | null;
      editor_user_id: string;
      created_at: string;
    }>;
    return rows.map((row) => {
      const editor = this.findUserById(row.editor_user_id);
      if (editor === null) throw new Error("Message version editor is missing");
      return {
        id: row.id,
        messageId: row.message_id,
        revision: row.revision,
        body: row.body_ciphertext === null
          ? null
          : this.contentCipher.decrypt(row.body_ciphertext, `message-version:${row.id}`),
        editor: publicUser(editor),
        createdAt: row.created_at
      };
    });
  }

  deleteMessageVersions(messageId: string): void {
    this.#db.prepare("DELETE FROM message_versions WHERE message_id = ?").run(messageId);
  }

  pinMessage(chatId: string, messageId: string, userId: string, at: string): MessagePin {
    this.#db.prepare(`
      INSERT INTO chat_pins (chat_id, message_id, pinned_by, pinned_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(chat_id, message_id) DO UPDATE SET pinned_by = excluded.pinned_by, pinned_at = excluded.pinned_at
    `).run(chatId, messageId, userId, at);
    const user = this.findUserById(userId);
    if (user === null) throw new Error("Pin actor is missing");
    return { chatId, messageId, pinnedBy: publicUser(user), pinnedAt: at };
  }

  unpinMessage(chatId: string, messageId: string): boolean {
    return this.#db.prepare("DELETE FROM chat_pins WHERE chat_id = ? AND message_id = ?")
      .run(chatId, messageId).changes === 1;
  }

  listPins(chatId: string): MessagePin[] {
    const rows = this.#db.prepare(`
      SELECT chat_id, message_id, pinned_by, pinned_at FROM chat_pins
      WHERE chat_id = ? ORDER BY pinned_at DESC
    `).all(chatId) as Array<{ chat_id: string; message_id: string; pinned_by: string; pinned_at: string }>;
    return rows.map((row) => {
      const user = this.findUserById(row.pinned_by);
      if (user === null) throw new Error("Pin actor is missing");
      return {
        chatId: row.chat_id,
        messageId: row.message_id,
        pinnedBy: publicUser(user),
        pinnedAt: row.pinned_at
      };
    });
  }

  createTopic(id: string, chatId: string, title: string, userId: string, at: string): TopicRecord {
    this.#db.prepare(`
      INSERT INTO chat_topics (id, chat_id, title, created_by, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(id, chatId, title, userId, at, at);
    return this.findTopicRecord(id) as TopicRecord;
  }

  findTopicRecord(id: string): TopicRecord | null {
    const row = this.#db.prepare("SELECT * FROM chat_topics WHERE id = ?").get(id) as TopicRow | undefined;
    return row === undefined ? null : this.#mapTopic(row);
  }

  getTopic(id: string): Topic | null {
    const record = this.findTopicRecord(id);
    if (record === null) return null;
    const creator = this.findUserById(record.createdBy);
    if (creator === null) throw new Error("Topic creator is missing");
    return {
      id: record.id,
      chatId: record.chatId,
      title: record.title,
      createdBy: publicUser(creator),
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      closedAt: record.closedAt
    };
  }

  listTopics(chatId: string): Topic[] {
    const rows = this.#db.prepare("SELECT id FROM chat_topics WHERE chat_id = ? ORDER BY created_at ASC, id ASC")
      .all(chatId) as Array<{ id: string }>;
    return rows.map((row) => this.getTopic(row.id)).filter((topic): topic is Topic => topic !== null);
  }

  updateTopic(id: string, title: string | undefined, closed: boolean | undefined, at: string): TopicRecord {
    const current = this.findTopicRecord(id);
    if (current === null) throw new Error("Topic is missing");
    this.#db.prepare(`
      UPDATE chat_topics SET title = ?, closed_at = ?, updated_at = ? WHERE id = ?
    `).run(
      title ?? current.title,
      closed === undefined ? current.closedAt : closed ? (current.closedAt ?? at) : null,
      at,
      id
    );
    return this.findTopicRecord(id) as TopicRecord;
  }

  createUploadSession(session: NewUploadSession): UploadSessionRecord {
    this.#db.prepare(`
      INSERT INTO upload_sessions (
        id, user_id, idempotency_key, kind, file_name_ciphertext, declared_mime_type,
        size_bytes, sha256, metadata_ciphertext, storage_provider, chunk_size_bytes, status,
        expires_at, created_at, updated_at
      ) VALUES (@id, @userId, @idempotencyKey, @kind, @fileName, @declaredMimeType,
        @sizeBytes, @sha256, @metadata, @storageProvider, @chunkSizeBytes, 'active',
        @expiresAt, @createdAt, @createdAt)
    `).run({
      ...session,
      fileName: this.contentCipher.encrypt(session.fileName, `upload:${session.id}:filename`),
      metadata: this.contentCipher.encrypt(JSON.stringify(session.metadata), `upload:${session.id}:metadata`)
    });
    return this.findUploadSession(session.id, session.userId) as UploadSessionRecord;
  }

  findUploadSession(id: string, userId: string): UploadSessionRecord | null {
    const row = this.#db.prepare("SELECT * FROM upload_sessions WHERE id = ? AND user_id = ?")
      .get(id, userId) as UploadSessionRow | undefined;
    return row === undefined ? null : this.#mapUpload(row);
  }

  findUploadByIdempotency(userId: string, idempotencyKey: string): UploadSessionRecord | null {
    const row = this.#db.prepare("SELECT * FROM upload_sessions WHERE user_id = ? AND idempotency_key = ?")
      .get(userId, idempotencyKey) as UploadSessionRow | undefined;
    return row === undefined ? null : this.#mapUpload(row);
  }

  getUploadChunks(uploadId: string): UploadChunkRecord[] {
    const rows = this.#db.prepare("SELECT * FROM upload_chunks WHERE upload_id = ? ORDER BY chunk_index ASC")
      .all(uploadId) as UploadChunkRow[];
    return rows.map((row) => ({
      uploadId: row.upload_id,
      chunkIndex: row.chunk_index,
      byteOffset: row.byte_offset,
      sizeBytes: row.size_bytes,
      sha256: row.sha256,
      createdAt: row.created_at
    }));
  }

  addUploadChunk(chunk: UploadChunkRecord, userId: string): boolean {
    const result = this.#db.prepare(`
      INSERT OR IGNORE INTO upload_chunks (
        upload_id, chunk_index, byte_offset, size_bytes, sha256, created_at
      ) SELECT @uploadId, @chunkIndex, @byteOffset, @sizeBytes, @sha256, @createdAt
      FROM upload_sessions
      WHERE id = @uploadId AND user_id = @userId AND status = 'active' AND expires_at > @createdAt
    `).run({ ...chunk, userId });
    if (result.changes === 1) {
      this.#db.prepare(`
        UPDATE upload_sessions SET received_bytes = received_bytes + ?, updated_at = ? WHERE id = ?
      `).run(chunk.sizeBytes, chunk.createdAt, chunk.uploadId);
    }
    return result.changes === 1;
  }

  acquireUploadCompletion(uploadId: string, userId: string, at: string, leaseUntil: string): boolean {
    return this.#db.prepare(`
      UPDATE upload_sessions SET status = 'completing', updated_at = ?,
        expires_at = CASE WHEN expires_at > ? THEN expires_at ELSE ? END
      WHERE id = ? AND user_id = ? AND status = 'active' AND expires_at > ?
    `).run(at, leaseUntil, leaseUntil, uploadId, userId, at).changes === 1;
  }

  releaseUploadCompletion(uploadId: string, at: string): void {
    this.#db.prepare(`
      UPDATE upload_sessions SET status = 'active', updated_at = ?
      WHERE id = ? AND status = 'completing' AND expires_at > ?
    `).run(at, uploadId, at);
  }

  completeUpload(uploadId: string, attachmentId: string, at: string): boolean {
    return this.#db.prepare(`
      UPDATE upload_sessions SET status = 'completed', attachment_id = ?, updated_at = ?
      WHERE id = ? AND status = 'completing'
    `).run(attachmentId, at, uploadId).changes === 1;
  }

  failUpload(uploadId: string, failureCode: string, at: string): void {
    this.#db.prepare(`
      UPDATE upload_sessions SET status = 'failed', failure_code = ?, updated_at = ?
      WHERE id = ? AND status IN ('active', 'completing')
    `).run(failureCode, at, uploadId);
  }

  expireUpload(uploadId: string, at: string, staleCompletionBefore?: string): boolean {
    return this.#db.prepare(`
      UPDATE upload_sessions SET status = 'expired', failure_code = 'UPLOAD_EXPIRED', updated_at = ?
      WHERE id = ? AND (
        status = 'active' OR (status = 'completing' AND ? IS NOT NULL AND updated_at <= ?)
      )
    `).run(at, uploadId, staleCompletionBefore ?? null, staleCompletionBefore ?? null).changes === 1;
  }

  listExpiredUploads(before: string, staleCompletionBefore: string, limit: number): UploadSessionRecord[] {
    const rows = this.#db.prepare(`
      SELECT * FROM upload_sessions
      WHERE (status = 'active' AND expires_at <= ?)
        OR (status = 'completing' AND updated_at <= ?)
      ORDER BY expires_at ASC LIMIT ?
    `).all(before, staleCompletionBefore, limit) as UploadSessionRow[];
    return rows.map((row) => this.#mapUpload(row));
  }

  listUploadsWithStagingToClean(before: string, limit: number): UploadSessionRecord[] {
    const rows = this.#db.prepare(`
      SELECT * FROM upload_sessions
      WHERE status IN ('completed', 'failed', 'expired')
        AND staging_cleaned_at IS NULL AND updated_at <= ?
      ORDER BY updated_at ASC LIMIT ?
    `).all(before, limit) as UploadSessionRow[];
    return rows.map((row) => this.#mapUpload(row));
  }

  markUploadStagingCleaned(uploadId: string, at: string): void {
    this.#db.prepare(`
      UPDATE upload_sessions SET staging_cleaned_at = ?
      WHERE id = ? AND status IN ('completed', 'failed', 'expired')
    `).run(at, uploadId);
  }

  listUploadsWithObjectsToClean(provider: "local" | "s3", before: string, limit: number): UploadSessionRecord[] {
    const rows = this.#db.prepare(`
      SELECT * FROM upload_sessions
      WHERE status IN ('failed', 'expired') AND attachment_id IS NULL
        AND storage_provider = ? AND object_cleaned_at IS NULL AND updated_at <= ?
      ORDER BY updated_at ASC LIMIT ?
    `).all(provider, before, limit) as UploadSessionRow[];
    return rows.map((row) => this.#mapUpload(row));
  }

  markUploadObjectCleaned(uploadId: string, at: string): void {
    this.#db.prepare(`
      UPDATE upload_sessions SET object_cleaned_at = ?
      WHERE id = ? AND status IN ('failed', 'expired') AND attachment_id IS NULL
    `).run(at, uploadId);
  }

  isUploadTerminal(uploadId: string): boolean {
    const row = this.#db.prepare(`
      SELECT 1 AS terminal FROM upload_sessions
      WHERE id = ? AND status IN ('completed', 'failed', 'expired')
    `).get(uploadId) as { terminal: number } | undefined;
    return row !== undefined;
  }

  getReservedStorageBytes(userId: string, now: string): number {
    const row = this.#db.prepare(`
      SELECT
        COALESCE((SELECT sum(size_bytes) FROM attachments
          WHERE owner_user_id = @userId AND deleted_at IS NULL), 0) +
        COALESCE((SELECT sum(size_bytes) FROM upload_sessions
          WHERE user_id = @userId AND status IN ('active', 'completing') AND expires_at > @now), 0) AS bytes
    `).get({ userId, now }) as { bytes: number };
    return row.bytes;
  }

  toUploadSession(record: UploadSessionRecord): UploadSession {
    const chunks = this.getUploadChunks(record.id);
    return {
      id: record.id,
      status: record.status,
      fileName: record.fileName,
      sizeBytes: record.sizeBytes,
      chunkSizeBytes: record.chunkSizeBytes,
      receivedBytes: record.receivedBytes,
      receivedChunkIndexes: chunks.map((chunk) => chunk.chunkIndex),
      expiresAt: record.expiresAt,
      attachment: record.attachmentId === null ? null : this.getAttachment(record.attachmentId),
      failureCode: record.failureCode
    };
  }

  createAttachment(attachment: NewAttachment): AttachmentRecord {
    this.#db.prepare(`
      INSERT INTO attachments (
        id, owner_user_id, kind, file_name_ciphertext, declared_mime_type,
        detected_mime_type, size_bytes, sha256, metadata_ciphertext,
        storage_provider, storage_key, safety_status, metadata_trust, created_at
      ) VALUES (@id, @ownerUserId, @kind, @fileName, @declaredMimeType,
        @detectedMimeType, @sizeBytes, @sha256, @metadata,
        @storageProvider, @storageKey, @safetyStatus, @metadataTrust, @createdAt)
    `).run({
      ...attachment,
      safetyStatus: attachment.safetyStatus ?? "unscanned",
      metadataTrust: attachment.metadataTrust ?? "client_declared",
      fileName: this.contentCipher.encrypt(attachment.fileName, `attachment:${attachment.id}:filename`),
      metadata: this.contentCipher.encrypt(JSON.stringify(attachment.metadata), `attachment:${attachment.id}:metadata`)
    });
    return this.findAttachmentRecord(attachment.id) as AttachmentRecord;
  }

  findAttachmentRecord(id: string): AttachmentRecord | null {
    const row = this.#db.prepare(`
      SELECT * FROM attachments WHERE id = ? AND deleted_at IS NULL AND deleting_at IS NULL
    `)
      .get(id) as AttachmentRow | undefined;
    return row === undefined ? null : this.#mapAttachment(row);
  }

  getAttachment(id: string): Attachment | null {
    const record = this.findAttachmentRecord(id);
    if (record === null) return null;
    return AttachmentSchema.parse({
      id: record.id,
      kind: record.kind,
      fileName: record.fileName,
      mimeType: record.detectedMimeType,
      sizeBytes: record.sizeBytes,
      sha256: record.sha256,
      metadata: record.metadata,
      downloadPath: `/v1/attachments/${record.id}/content`,
      safetyStatus: record.safetyStatus,
      metadataTrust: record.metadataTrust,
      createdAt: record.createdAt
    });
  }

  listOwnedAttachments(
    userId: string,
    limit: number,
    cursor?: string
  ): { items: Attachment[]; nextCursor: string | null } {
    const decoded = decodeCursor(cursor);
    const rows = this.#db.prepare(`
      SELECT id, created_at FROM attachments
      WHERE owner_user_id = @userId
        AND deleted_at IS NULL AND deleting_at IS NULL
        AND (@cursorValue IS NULL OR created_at < @cursorValue
          OR (created_at = @cursorValue AND id < @cursorId))
      ORDER BY created_at DESC, id DESC
      LIMIT @take
    `).all({
      userId,
      cursorValue: decoded?.value ?? null,
      cursorId: decoded?.id ?? null,
      take: limit + 1
    }) as Array<{ id: string; created_at: string }>;
    const hasMore = rows.length > limit;
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    return {
      items: page
        .map((row) => this.getAttachment(row.id))
        .filter((attachment): attachment is Attachment => attachment !== null),
      nextCursor: hasMore && last !== undefined
        ? encodeCursor({ value: last.created_at, id: last.id })
        : null
    };
  }

  listAttachmentsByIds(ids: string[]): AttachmentRecord[] {
    if (ids.length === 0) return [];
    const rows = this.#db.prepare(`
      SELECT * FROM attachments
      WHERE deleted_at IS NULL AND deleting_at IS NULL AND id IN (${ids.map(() => "?").join(",")})
    `).all(...ids) as AttachmentRow[];
    return rows.map((row) => this.#mapAttachment(row));
  }

  canUserAccessAttachment(userId: string, attachmentId: string): boolean {
    const row = this.#db.prepare(`
      SELECT 1 AS allowed FROM attachments a
      WHERE a.id = @attachmentId AND a.deleted_at IS NULL AND a.deleting_at IS NULL AND (
        a.owner_user_id = @userId OR EXISTS (
          SELECT 1 FROM message_attachments ma
          JOIN messages m ON m.id = ma.message_id AND m.deleted_at IS NULL
          JOIN chat_members cm ON cm.chat_id = m.chat_id AND cm.user_id = @userId
          JOIN chats c ON c.id = m.chat_id
          WHERE ma.attachment_id = a.id
            AND (
              c.kind <> 'direct' OR EXISTS (
                SELECT 1 FROM account_relationships ar
                JOIN chat_members peer ON peer.chat_id = c.id
                  AND peer.user_id = CASE
                    WHEN ar.left_user_id = @userId THEN ar.right_user_id
                    ELSE ar.left_user_id
                  END
                WHERE ar.pair_key = c.direct_key
                  AND (ar.left_user_id = @userId OR ar.right_user_id = @userId)
                  AND NOT EXISTS (
                    SELECT 1 FROM account_blocks b
                    WHERE (b.blocker_user_id = ar.left_user_id AND b.blocked_user_id = ar.right_user_id)
                       OR (b.blocker_user_id = ar.right_user_id AND b.blocked_user_id = ar.left_user_id)
                  )
              )
            )
        ) OR EXISTS (
          SELECT 1
          FROM users avatar_owner
          JOIN account_privacy_settings privacy ON privacy.user_id = avatar_owner.id
          WHERE avatar_owner.avatar_attachment_id = a.id
            AND NOT EXISTS (
              SELECT 1 FROM account_blocks blocks
              WHERE (blocks.blocker_user_id = @userId AND blocks.blocked_user_id = avatar_owner.id)
                 OR (blocks.blocker_user_id = avatar_owner.id AND blocks.blocked_user_id = @userId)
            )
            AND (
              privacy.username_discoverable = 1 OR EXISTS (
                SELECT 1
                FROM chat_members viewer_membership
                JOIN chat_members owner_membership
                  ON owner_membership.chat_id = viewer_membership.chat_id
                WHERE viewer_membership.user_id = @userId
                  AND owner_membership.user_id = avatar_owner.id
              )
            )
        )
      )
    `).get({ userId, attachmentId }) as { allowed: number } | undefined;
    return row !== undefined;
  }

  claimOrphanAttachments(
    provider: "local" | "s3",
    before: string,
    staleClaimBefore: string,
    at: string,
    limit: number
  ): { attachments: AttachmentRecord[]; invalidations: StoredEvent[] } {
    return this.immediateTransaction(() => {
      const candidates = this.#db.prepare(`
        SELECT a.id, a.deleting_at FROM attachments a
        WHERE a.deleted_at IS NULL AND a.linked_at IS NULL AND a.created_at <= @before
          AND a.storage_provider = @provider
          AND (a.deleting_at IS NULL OR a.deleting_at <= @staleClaimBefore)
          AND NOT EXISTS (SELECT 1 FROM message_attachments ma WHERE ma.attachment_id = a.id)
          AND NOT EXISTS (SELECT 1 FROM users u WHERE u.avatar_attachment_id = a.id)
        ORDER BY a.created_at ASC LIMIT @limit
      `).all({ provider, before, staleClaimBefore, limit }) as Array<{
        id: string;
        deleting_at: string | null;
      }>;
      if (candidates.length === 0) return { attachments: [], invalidations: [] };
      const ids = candidates.map((candidate) => candidate.id);
      const idBindings = Object.fromEntries(ids.map((id, index) => [`id${index}`, id]));
      const idPlaceholders = ids.map((_id, index) => `@id${index}`).join(",");
      this.#db.prepare(`
        UPDATE attachments SET deleting_at = @at
        WHERE id IN (${idPlaceholders})
          AND deleted_at IS NULL AND linked_at IS NULL
          AND (deleting_at IS NULL OR deleting_at <= @staleClaimBefore)
          AND NOT EXISTS (SELECT 1 FROM message_attachments ma WHERE ma.attachment_id = attachments.id)
          AND NOT EXISTS (SELECT 1 FROM users u WHERE u.avatar_attachment_id = attachments.id)
      `).run({ at, staleClaimBefore, ...idBindings });
      const rows = this.#db.prepare(`
        SELECT * FROM attachments WHERE deleting_at = @at AND id IN (${idPlaceholders})
      `).all({ at, ...idBindings }) as AttachmentRow[];
      const invalidations = this.syncInvalidationEnabled
        ? rows.map((row) => this.appendEvent(row.owner_user_id, {
          type: "sync.invalidated",
          audience: "account_projection",
          accountId: row.owner_user_id,
          reason: "attachment_removed",
          changedAt: at
        }, at))
        : [];
      return {
        attachments: rows.map((row) => this.#mapAttachment(row)),
        invalidations
      };
    });
  }

  deleteAttachmentRecord(id: string, at: string): StoredEvent[] {
    return this.immediateTransaction(() => {
      const current = this.#db.prepare(`
        SELECT * FROM attachments WHERE id = ? AND deleted_at IS NULL
      `).get(id) as AttachmentRow | undefined;
      if (current === undefined) return [];
      const wasVisible = current.deleting_at === null;
      const removed = this.#db.prepare(`
        UPDATE attachments SET deleted_at = ?, deleting_at = NULL WHERE id = ? AND deleted_at IS NULL
      `).run(at, id);
      if (removed.changes !== 1) return [];
      this.#db.prepare("DELETE FROM attachment_search_tokens WHERE attachment_id = ?").run(id);
      this.#db.prepare(`
        DELETE FROM realtime_events WHERE entity_id = ? AND event_type = 'attachment.stored'
      `).run(id);
      return wasVisible && this.syncInvalidationEnabled
        ? [this.appendEvent(current.owner_user_id, {
            type: "sync.invalidated",
            audience: "account_projection",
            accountId: current.owner_user_id,
            reason: "attachment_removed",
            changedAt: at
          }, at)]
        : [];
    });
  }

  replaceMessageSearchTokens(messageId: string, tokens: Array<{ keyId: string; hash: string }>): void {
    this.#db.prepare("DELETE FROM message_search_tokens WHERE message_id = ?").run(messageId);
    const insert = this.#db.prepare(`
      INSERT INTO message_search_tokens (message_id, key_id, token_hash) VALUES (?, ?, ?)
    `);
    for (const token of tokens) insert.run(messageId, token.keyId, token.hash);
  }

  replaceAttachmentSearchTokens(attachmentId: string, tokens: Array<{ keyId: string; hash: string }>): void {
    this.#db.prepare("DELETE FROM attachment_search_tokens WHERE attachment_id = ?").run(attachmentId);
    const insert = this.#db.prepare(`
      INSERT INTO attachment_search_tokens (attachment_id, key_id, token_hash) VALUES (?, ?, ?)
    `);
    for (const token of tokens) insert.run(attachmentId, token.keyId, token.hash);
  }

  searchMessages(userId: string, tokenHashes: string[], termCount: number, limit: number, cursor?: string, chatId?: string): { items: Message[]; nextCursor: string | null } {
    if (tokenHashes.length === 0 || termCount === 0) return { items: [], nextCursor: null };
    const decoded = decodeCursor(cursor);
    const rows = this.#db.prepare(`
      SELECT m.id, m.created_at FROM messages m
      JOIN chat_members cm ON cm.chat_id = m.chat_id AND cm.user_id = ?
      JOIN message_search_tokens st ON st.message_id = m.id
      WHERE m.deleted_at IS NULL
        AND (? IS NULL OR m.chat_id = ?)
        AND st.token_hash IN (${tokenHashes.map(() => "?").join(",")})
        AND (? IS NULL OR m.created_at < ? OR (m.created_at = ? AND m.id < ?))
      GROUP BY m.id
      HAVING count(DISTINCT st.token_hash) = ?
      ORDER BY m.created_at DESC, m.id DESC LIMIT ?
    `).all(
      userId,
      chatId ?? null,
      chatId ?? null,
      ...tokenHashes,
      decoded?.value ?? null,
      decoded?.value ?? null,
      decoded?.value ?? null,
      decoded?.id ?? null,
      termCount,
      limit + 1
    ) as Array<{ id: string; created_at: string }>;
    const hasMore = rows.length > limit;
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    return {
      items: page.map((row) => this.getMessage(row.id)).filter((message): message is Message => message !== null),
      nextCursor: hasMore && last !== undefined ? encodeCursor({ value: last.created_at, id: last.id }) : null
    };
  }

  searchAttachments(userId: string, tokenHashes: string[], termCount: number, limit: number, cursor?: string): { items: Attachment[]; nextCursor: string | null } {
    if (tokenHashes.length === 0 || termCount === 0) return { items: [], nextCursor: null };
    const decoded = decodeCursor(cursor);
    const hashBindings = Object.fromEntries(tokenHashes.map((hash, index) => [`hash${index}`, hash]));
    const hashPlaceholders = tokenHashes.map((_hash, index) => `@hash${index}`).join(",");
    const rows = this.#db.prepare(`
      SELECT a.id, a.created_at FROM attachments a
      JOIN attachment_search_tokens st ON st.attachment_id = a.id
      WHERE a.deleted_at IS NULL AND a.deleting_at IS NULL AND (
        a.owner_user_id = @userId OR EXISTS (
          SELECT 1 FROM message_attachments ma
          JOIN messages m ON m.id = ma.message_id AND m.deleted_at IS NULL
          JOIN chat_members cm ON cm.chat_id = m.chat_id AND cm.user_id = @userId
          JOIN chats c ON c.id = m.chat_id
          WHERE ma.attachment_id = a.id
            AND (
              c.kind <> 'direct' OR EXISTS (
                SELECT 1 FROM account_relationships ar
                JOIN chat_members peer ON peer.chat_id = c.id
                  AND peer.user_id = CASE
                    WHEN ar.left_user_id = @userId THEN ar.right_user_id
                    ELSE ar.left_user_id
                  END
                WHERE ar.pair_key = c.direct_key
                  AND (ar.left_user_id = @userId OR ar.right_user_id = @userId)
                  AND NOT EXISTS (
                    SELECT 1 FROM account_blocks b
                    WHERE (b.blocker_user_id = ar.left_user_id AND b.blocked_user_id = ar.right_user_id)
                       OR (b.blocker_user_id = ar.right_user_id AND b.blocked_user_id = ar.left_user_id)
                  )
              )
            )
        )
      )
        AND st.token_hash IN (${hashPlaceholders})
        AND (@cursorValue IS NULL OR a.created_at < @cursorValue
          OR (a.created_at = @cursorValue AND a.id < @cursorId))
      GROUP BY a.id
      HAVING count(DISTINCT st.token_hash) = @termCount
      ORDER BY a.created_at DESC, a.id DESC LIMIT @take
    `).all({
      userId,
      ...hashBindings,
      cursorValue: decoded?.value ?? null,
      cursorId: decoded?.id ?? null,
      termCount,
      take: limit + 1
    }) as Array<{ id: string; created_at: string }>;
    const hasMore = rows.length > limit;
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    return {
      items: page.map((row) => this.getAttachment(row.id)).filter((item): item is Attachment => item !== null),
      nextCursor: hasMore && last !== undefined ? encodeCursor({ value: last.created_at, id: last.id }) : null
    };
  }

  getSearchIndexKeyId(): string | null {
    const row = this.#db.prepare("SELECT active_key_id FROM search_index_state WHERE scope = 'all'")
      .get() as { active_key_id: string } | undefined;
    return row?.active_key_id ?? null;
  }

  setSearchIndexKeyId(keyId: string, at: string): void {
    this.#db.prepare(`
      INSERT INTO search_index_state (scope, active_key_id, completed_at) VALUES ('all', ?, ?)
      ON CONFLICT(scope) DO UPDATE SET active_key_id = excluded.active_key_id,
        completed_at = excluded.completed_at
    `).run(keyId, at);
  }

  listMessagesForSearchIndex(afterId: string | undefined, limit: number): Array<{ id: string; body: string | null }> {
    const rows = this.#db.prepare(`
      SELECT * FROM messages WHERE deleted_at IS NULL AND (? IS NULL OR id > ?) ORDER BY id ASC LIMIT ?
    `).all(afterId ?? null, afterId ?? null, limit) as MessageRow[];
    return rows.map((row) => {
      const message = this.#mapMessage(row);
      return { id: message.id, body: message.body };
    });
  }

  listAttachmentsForSearchIndex(afterId: string | undefined, limit: number): Array<{ id: string; fileName: string }> {
    const rows = this.#db.prepare(`
      SELECT * FROM attachments
      WHERE deleted_at IS NULL AND (? IS NULL OR id > ?) ORDER BY id ASC LIMIT ?
    `).all(afterId ?? null, afterId ?? null, limit) as AttachmentRow[];
    return rows.map((row) => {
      const attachment = this.#mapAttachment(row);
      return { id: attachment.id, fileName: attachment.fileName };
    });
  }

  markDelivered(messageId: string, userId: string, at: string): MessageReceipt | null {
    const message = this.#db.prepare("SELECT updated_at FROM messages WHERE id = ?")
      .get(messageId) as { updated_at: string } | undefined;
    if (message === undefined) throw badRequest("Delivery receipt message does not exist");
    const deliveredAt = latestTimestamp(at, message.updated_at);
    const result = this.#db.prepare(`
      INSERT INTO message_receipts (message_id, user_id, delivered_at)
      VALUES (?, ?, ?)
      ON CONFLICT(message_id, user_id) DO NOTHING
    `).run(messageId, userId, deliveredAt);
    return result.changes === 1
      ? { userId, deliveredAt, readAt: null }
      : null;
  }

  markRead(
    chatId: string,
    userId: string,
    messageId: string,
    at: string
  ): { advanced: boolean; readAt: string } {
    const current = this.#db.prepare(`
      SELECT m.created_at, m.id, cr.read_at FROM chat_reads cr
      JOIN messages m ON m.id = cr.last_read_message_id
      WHERE cr.chat_id = ? AND cr.user_id = ?
    `).get(chatId, userId) as { created_at: string; id: string; read_at: string } | undefined;
    const target = this.#db.prepare(`
      SELECT created_at, updated_at, id FROM messages WHERE id = ? AND chat_id = ?
    `).get(messageId, chatId) as { created_at: string; updated_at: string; id: string } | undefined;
    if (target === undefined) throw badRequest("Read receipt message does not belong to this chat");
    const existing = this.#db.prepare(`
      SELECT delivered_at, read_at FROM message_receipts WHERE message_id = ? AND user_id = ?
    `).get(messageId, userId) as { delivered_at: string; read_at: string | null } | undefined;
    const readAt = latestTimestamp(
      at,
      target.updated_at,
      current?.read_at,
      existing?.delivered_at,
      existing?.read_at
    );
    this.#db.prepare(`
      INSERT INTO message_receipts (message_id, user_id, delivered_at, read_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(message_id, user_id) DO UPDATE SET
        read_at = CASE
          WHEN message_receipts.read_at IS NULL OR message_receipts.read_at < excluded.read_at
            THEN excluded.read_at
          ELSE message_receipts.read_at
        END
    `).run(messageId, userId, readAt, readAt);
    const persisted = this.#db.prepare(`
      SELECT read_at FROM message_receipts WHERE message_id = ? AND user_id = ?
    `).get(messageId, userId) as { read_at: string };
    if (current !== undefined && (
      current.created_at > target.created_at ||
      (current.created_at === target.created_at && current.id >= target.id)
    )) return { advanced: false, readAt: persisted.read_at };
    this.#db.prepare(`
      INSERT INTO chat_reads (chat_id, user_id, last_read_message_id, read_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(chat_id, user_id) DO UPDATE SET
        last_read_message_id = excluded.last_read_message_id,
        read_at = CASE
          WHEN chat_reads.read_at < excluded.read_at THEN excluded.read_at
          ELSE chat_reads.read_at
        END
    `).run(chatId, userId, messageId, persisted.read_at);
    return { advanced: true, readAt: persisted.read_at };
  }

  setReaction(messageId: string, userId: string, emoji: string, active: boolean, at: string): void {
    if (active) {
      this.#db.prepare(`
        INSERT OR IGNORE INTO message_reactions (message_id, user_id, emoji, created_at)
        VALUES (?, ?, ?, ?)
      `).run(messageId, userId, emoji, at);
    } else {
      this.#db.prepare("DELETE FROM message_reactions WHERE message_id = ? AND user_id = ? AND emoji = ?")
        .run(messageId, userId, emoji);
    }
  }

  getReactionSummary(messageId: string, viewerId: string): Array<{ emoji: string; count: number; reactedByMe: boolean }> {
    const rows = this.#db.prepare(`
      SELECT emoji, count(*) AS count,
        max(CASE WHEN user_id = ? THEN 1 ELSE 0 END) AS reacted_by_me
      FROM message_reactions
      WHERE message_id = ? AND (
        user_id = ? OR NOT EXISTS (
          SELECT 1 FROM account_blocks block
          WHERE (block.blocker_user_id = ? AND block.blocked_user_id = message_reactions.user_id)
             OR (block.blocker_user_id = message_reactions.user_id AND block.blocked_user_id = ?)
        )
      )
      GROUP BY emoji ORDER BY count DESC, emoji ASC
    `).all(
      viewerId,
      messageId,
      viewerId,
      viewerId,
      viewerId
    ) as Array<{ emoji: string; count: number; reacted_by_me: number }>;
    return rows.map((row) => ({
      emoji: row.emoji,
      count: row.count,
      reactedByMe: row.reacted_by_me === 1
    }));
  }

  listMessageReceipts(messageId: string): MessageReceipt[] {
    const rows = this.#db.prepare(`
      SELECT user_id, delivered_at, read_at
      FROM message_receipts
      WHERE message_id = ?
      ORDER BY delivered_at ASC, user_id ASC
    `).all(messageId) as Array<{
      user_id: string;
      delivered_at: string;
      read_at: string | null;
    }>;
    return rows.map((row) => ({
      userId: row.user_id,
      deliveredAt: row.delivered_at,
      readAt: row.read_at
    }));
  }

  removePendingMessageContentEvents(messageId: string): void {
    this.#db.prepare(`
      DELETE FROM realtime_events
      WHERE entity_id = ? AND event_type IN ('message.created', 'message.updated')
    `).run(messageId);
  }

  appendEvent(audienceUserId: string, event: DurableRealtimeEvent, at: string): StoredEvent {
    const validated = DurableRealtimeEventSchema.parse(event);
    if (!this.syncInvalidationEnabled && validated.type === "sync.invalidated") {
      throw new Error("sync.invalidated emission is disabled by configuration");
    }
    const entityId = this.#eventEntityId(validated);
    const result = this.#db.transaction(() => {
      const inserted = this.#db.prepare(`
        INSERT INTO realtime_events (audience_user_id, event_json, created_at, event_type, entity_id)
        VALUES (?, ?, ?, ?, ?)
      `).run(
        audienceUserId,
        this.contentCipher.encrypt(JSON.stringify(validated), `event:${audienceUserId}`),
        at,
        validated.type,
        entityId
      );
      this.#db.prepare(`
        INSERT INTO realtime_outbox (event_sequence, available_at)
        VALUES (?, ?)
      `).run(inserted.lastInsertRowid, INITIAL_OUTBOX_AVAILABLE_AT);
      return inserted;
    })();
    return {
      sequence: Number(result.lastInsertRowid),
      audienceUserId,
      event: validated,
      createdAt: at
    };
  }

  appendChatEvent(chatId: string, event: RealtimeEvent, at: string): StoredEvent[] {
    return this.transaction(() => this.listChatMemberIds(chatId)
      .map((userId) => this.appendEvent(userId, event, at)));
  }

  getLatestSequence(): number {
    const row = this.#db.prepare(`
      SELECT COALESCE(
        (SELECT seq FROM sqlite_sequence WHERE name = 'realtime_events'),
        0
      ) AS sequence
    `)
      .get() as { sequence: number };
    return row.sequence;
  }

  replayEvents(
    userId: string,
    afterSequence: number,
    throughSequence: number,
    limit: number,
    includeSyncInvalidations = true
  ): StoredEvent[] {
    const rows = this.#db.prepare(`
      SELECT * FROM realtime_events
      WHERE audience_user_id = ? AND sequence > ? AND sequence <= ?
        AND (? = 1 OR COALESCE(event_type, '') <> 'sync.invalidated')
      ORDER BY sequence ASC LIMIT ?
    `).all(userId, afterSequence, throughSequence, includeSyncInvalidations ? 1 : 0, limit) as EventRow[];
    return rows.map((row) => this.#mapStoredEvent(row));
  }

  claimRealtimeOutbox(
    workerId: string,
    at: string,
    leaseUntil: string,
    limit: number
  ): ClaimedRealtimeOutboxEvent[] {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) {
      throw new Error("Realtime outbox claim limit must be between 1 and 500");
    }
    return this.immediateTransaction(() => {
      const candidates = this.#db.prepare(`
        SELECT candidate.event_sequence
        FROM realtime_outbox candidate
        JOIN realtime_events candidate_event
          ON candidate_event.sequence = candidate.event_sequence
        WHERE candidate.published_at IS NULL AND candidate.failed_at IS NULL
          AND candidate.available_at <= ?
          AND (candidate.claimed_by IS NULL OR candidate.claim_until <= ?)
          AND NOT EXISTS (
            SELECT 1
            FROM realtime_outbox prior
            JOIN realtime_events prior_event
              ON prior_event.sequence = prior.event_sequence
            WHERE prior_event.audience_user_id = candidate_event.audience_user_id
              AND prior.event_sequence < candidate.event_sequence
              AND prior.published_at IS NULL
              AND prior.failed_at IS NULL
          )
        ORDER BY candidate.event_sequence ASC
        LIMIT ?
      `).all(at, at, limit) as Array<{ event_sequence: number }>;
      if (candidates.length === 0) return [];

      const bindings = Object.fromEntries(
        candidates.map(({ event_sequence }, index) => [`sequence${index}`, event_sequence])
      );
      const placeholders = candidates.map((_candidate, index) => `@sequence${index}`).join(",");
      this.#db.prepare(`
        UPDATE realtime_outbox
        SET claimed_by = @workerId,
            claim_until = @leaseUntil,
            attempt_count = min(attempt_count + 1, 2147483647)
        WHERE event_sequence IN (${placeholders})
          AND published_at IS NULL
          AND failed_at IS NULL
          AND available_at <= @at
          AND (claimed_by IS NULL OR claim_until <= @at)
      `).run({ workerId, leaseUntil, at, ...bindings });

      const rows = this.#db.prepare(`
        SELECT events.sequence, events.audience_user_id, events.event_json,
               events.created_at, outbox.attempt_count
        FROM realtime_outbox outbox
        JOIN realtime_events events ON events.sequence = outbox.event_sequence
        WHERE outbox.event_sequence IN (${placeholders})
          AND outbox.claimed_by = @workerId
          AND outbox.claim_until = @leaseUntil
          AND outbox.published_at IS NULL
          AND outbox.failed_at IS NULL
        ORDER BY events.sequence ASC
      `).all({ workerId, leaseUntil, ...bindings }) as ClaimedOutboxRow[];
      return rows.map((row): ClaimedRealtimeOutboxEvent => {
        try {
          return {
            ok: true,
            event: this.#mapStoredEvent(row),
            attemptCount: row.attempt_count
          };
        } catch {
          return {
            ok: false,
            eventSequence: row.sequence,
            attemptCount: row.attempt_count,
            failureCode: "event_unreadable"
          };
        }
      });
    });
  }

  markRealtimeOutboxPublished(sequence: number, workerId: string, at: string): boolean {
    const result = this.#db.prepare(`
      UPDATE realtime_outbox
      SET published_at = ?, claimed_by = NULL, claim_until = NULL
      WHERE event_sequence = ? AND claimed_by = ?
        AND published_at IS NULL AND failed_at IS NULL
    `).run(at, sequence, workerId);
    return result.changes === 1;
  }

  releaseRealtimeOutbox(sequence: number, workerId: string, availableAt: string): boolean {
    const result = this.#db.prepare(`
      UPDATE realtime_outbox
      SET available_at = ?, claimed_by = NULL, claim_until = NULL
      WHERE event_sequence = ? AND claimed_by = ?
        AND published_at IS NULL AND failed_at IS NULL
    `).run(availableAt, sequence, workerId);
    return result.changes === 1;
  }

  markRealtimeOutboxFailed(
    sequence: number,
    workerId: string,
    at: string,
    failureCode: RealtimeOutboxFailureCode
  ): boolean {
    const result = this.#db.prepare(`
      UPDATE realtime_outbox
      SET failed_at = ?, failure_code = ?, claimed_by = NULL, claim_until = NULL
      WHERE event_sequence = ? AND claimed_by = ?
        AND published_at IS NULL AND failed_at IS NULL
    `).run(at, failureCode, sequence, workerId);
    return result.changes === 1;
  }

  #mapChatFolder(row: ChatFolderRow): ChatFolderRecord {
    const includeKinds: ChatKind[] = [];
    if (row.include_direct === 1) includeKinds.push("direct");
    if (row.include_group === 1) includeKinds.push("group");
    if (row.include_channel === 1) includeKinds.push("channel");
    const overrides = this.#db.prepare(`
      SELECT chat_id, mode, pinned_position
      FROM chat_folder_overrides
      WHERE folder_id = ? AND user_id = ?
      ORDER BY pinned_position IS NULL, pinned_position, chat_id
    `).all(row.id, row.user_id) as ChatFolderOverrideRow[];
    return {
      id: row.id,
      userId: row.user_id,
      title: row.title,
      position: row.position,
      revision: row.revision,
      rules: {
        includeKinds,
        unreadOnly: row.unread_only === 1,
        excludeMuted: row.exclude_muted === 1,
        includeArchived: row.include_archived === 1
      },
      overrides: overrides.map((override) => ({
        chatId: override.chat_id,
        mode: override.mode,
        pinnedPosition: override.pinned_position
      })),
      createdAt: row.created_at,
      updatedAt: row.updated_at
    };
  }

  #mapChatDraft(row: ChatDraftRow): ChatDraftRecord {
    return {
      userId: row.user_id,
      chatId: row.chat_id,
      text: row.text_ciphertext === null
        ? null
        : this.contentCipher.decrypt(
            row.text_ciphertext,
            `chat-draft:${row.user_id}:${row.chat_id}:text`
          ),
      replyToMessageId: row.reply_to_message_id,
      revision: row.revision,
      updatedAt: row.updated_at,
      deletedAt: row.deleted_at
    };
  }

  #replaceChatFolderOverrides(
    folderId: string,
    userId: string,
    overrides: ChatFolderOverrideRecord[],
    at: string
  ): void {
    this.#db.prepare(`
      DELETE FROM chat_folder_overrides
      WHERE folder_id = ? AND user_id = ?
    `).run(folderId, userId);
    const insert = this.#db.prepare(`
      INSERT INTO chat_folder_overrides (
        folder_id, user_id, chat_id, mode, pinned_position, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    for (const override of overrides) {
      insert.run(
        folderId,
        userId,
        override.chatId,
        override.mode,
        override.pinnedPosition,
        at,
        at
      );
    }
  }

  #mapStoredEvent(row: EventRow): StoredEvent {
    return {
      sequence: row.sequence,
      audienceUserId: row.audience_user_id,
      event: DurableRealtimeEventSchema.parse(JSON.parse(
        this.contentCipher.decrypt(row.event_json, `event:${row.audience_user_id}`)
      ) as unknown),
      createdAt: row.created_at
    };
  }

  #mapMessage(row: MessageRow): MessageRecord {
    const { transcriptCiphertext, ...record } = mapMessage(row);
    return {
      ...record,
      body: record.body === null ? null : this.contentCipher.decrypt(record.body, `message:${record.id}`),
      forwardedFromSenderName: record.forwardedFromSenderName === null
        ? null
        : this.contentCipher.decrypt(
            record.forwardedFromSenderName,
            `message:${record.id}:forward-sender-name`
          ),
      requestFingerprint: record.requestFingerprint === null
        ? null
        : this.contentCipher.decrypt(
            record.requestFingerprint,
            `message:${record.id}:request-fingerprint`
          ),
      transcript: transcriptCiphertext === null
        ? null
        : this.contentCipher.decrypt(
            transcriptCiphertext,
            `message:${record.id}:transcript`
          )
    };
  }

  #mapMessageRequest(row: MessageRequestRow): MessageRequestRecord {
    return {
      id: row.id,
      pairKey: row.pair_key,
      senderId: row.sender_id,
      recipientId: row.recipient_id,
      clientNonce: row.client_nonce,
      body: this.contentCipher.decrypt(row.body_ciphertext, `message-request:${row.id}:body`),
      linkUrl: row.link_url_ciphertext === null
        ? null
        : this.contentCipher.decrypt(row.link_url_ciphertext, `message-request:${row.id}:link`),
      senderProfile: JSON.parse(this.contentCipher.decrypt(
        row.sender_profile_snapshot_ciphertext,
        `message-request:${row.id}:sender-profile`
      )) as PublicProfile,
      recipientProfile: JSON.parse(this.contentCipher.decrypt(
        row.recipient_profile_snapshot_ciphertext,
        `message-request:${row.id}:recipient-profile`
      )) as PublicProfile,
      state: row.state,
      chatId: row.chat_id,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      expiresAt: row.expires_at,
      acceptedAt: row.accepted_at,
      dismissedAt: row.dismissed_at
    };
  }

  #mapBlock(row: BlockRow): BlockRecord {
    return {
      blockerUserId: row.blocker_user_id,
      blockedUserId: row.blocked_user_id,
      profileSnapshot: JSON.parse(this.contentCipher.decrypt(
        row.profile_snapshot_ciphertext,
        `account-block:${row.blocker_user_id}:${row.blocked_user_id}:profile`
      )) as PublicProfile,
      createdAt: row.created_at
    };
  }

  #mapSafetyReport(row: SafetyReportRow): SafetyReportRecord {
    return {
      id: row.id,
      reporterUserId: row.reporter_user_id,
      subjectUserId: row.subject_user_id,
      category: row.category,
      evidence: JSON.parse(this.contentCipher.decrypt(
        row.evidence_ciphertext,
        `safety-report:${row.id}:evidence`
      )) as SafetyEvidenceSnapshot[],
      comment: row.comment_ciphertext === null
        ? null
        : this.contentCipher.decrypt(row.comment_ciphertext, `safety-report:${row.id}:comment`),
      clientNonce: row.client_nonce,
      state: row.state,
      alsoBlocked: row.also_blocked === 1,
      createdAt: row.created_at
    };
  }

  #mapAttachment(row: AttachmentRow): AttachmentRecord {
    return {
      id: row.id,
      ownerUserId: row.owner_user_id,
      kind: row.kind,
      fileName: this.contentCipher.decrypt(row.file_name_ciphertext, `attachment:${row.id}:filename`),
      declaredMimeType: row.declared_mime_type,
      detectedMimeType: row.detected_mime_type,
      sizeBytes: row.size_bytes,
      sha256: row.sha256,
      metadata: JSON.parse(
        this.contentCipher.decrypt(row.metadata_ciphertext, `attachment:${row.id}:metadata`)
      ) as Record<string, unknown>,
      storageProvider: row.storage_provider,
      storageKey: row.storage_key,
      safetyStatus: row.safety_status,
      metadataTrust: row.metadata_trust,
      createdAt: row.created_at,
      linkedAt: row.linked_at,
      deletingAt: row.deleting_at,
      deletedAt: row.deleted_at
    };
  }

  #mapUpload(row: UploadSessionRow): UploadSessionRecord {
    return {
      id: row.id,
      userId: row.user_id,
      idempotencyKey: row.idempotency_key,
      kind: row.kind,
      fileName: this.contentCipher.decrypt(row.file_name_ciphertext, `upload:${row.id}:filename`),
      declaredMimeType: row.declared_mime_type,
      sizeBytes: row.size_bytes,
      sha256: row.sha256,
      metadata: JSON.parse(
        this.contentCipher.decrypt(row.metadata_ciphertext, `upload:${row.id}:metadata`)
      ) as Record<string, unknown>,
      storageProvider: row.storage_provider,
      chunkSizeBytes: row.chunk_size_bytes,
      receivedBytes: row.received_bytes,
      status: row.status,
      attachmentId: row.attachment_id,
      failureCode: row.failure_code,
      expiresAt: row.expires_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      stagingCleanedAt: row.staging_cleaned_at,
      objectCleanedAt: row.object_cleaned_at
    };
  }

  #mapTopic(row: TopicRow): TopicRecord {
    return {
      id: row.id,
      chatId: row.chat_id,
      title: row.title,
      createdBy: row.created_by,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      closedAt: row.closed_at
    };
  }

  #listMessageAttachments(messageId: string): Attachment[] {
    return this.listMessageAttachmentIds(messageId)
      .map((id) => this.getAttachment(id))
      .filter((attachment): attachment is Attachment => attachment !== null);
  }

  #forwardProvenance(record: MessageRecord): Message["forwardedFrom"] {
    if (
      record.forwardedFromMessageId === null ||
      record.forwardedFromChatId === null ||
      record.forwardedFromSenderName === null ||
      record.forwardedFromCreatedAt === null
    ) return null;
    return {
      senderDisplayName: record.forwardedFromSenderName,
      originalCreatedAt: record.forwardedFromCreatedAt
    };
  }

  #eventEntityId(event: DurableRealtimeEvent): string {
    switch (event.type) {
      case "chat.created": return event.chat.id;
      case "message.created":
      case "message.updated":
      case "message.deleted": return event.message.id;
      case "attachment.stored": return event.attachment.id;
      case "message.pinned": return event.pin.messageId;
      case "message.unpinned": return event.messageId;
      case "topic.created":
      case "topic.updated": return event.topic.id;
      case "receipt.read":
      case "receipt.delivered":
      case "reaction.updated": return event.messageId;
      case "relationship.request.created": return event.request.id;
      case "relationship.request.removed":
      case "relationship.request.accepted":
      case "relationship.request.expired": return event.requestId;
      case "relationship.block.changed": return event.accountId;
      case "safety.report.submitted": return event.report.id;
      case "chat.member.changed": return `${event.membership.chatId}:${event.membership.userId}`;
      case "chat.preferences.updated": return `${event.chatId}:${event.accountId}`;
      case "chat.folders.updated": return event.accountId;
      case "chat.draft.changed": return `${event.chatId}:${event.accountId}`;
      case "sync.invalidated": return event.accountId;
    }
  }
}
