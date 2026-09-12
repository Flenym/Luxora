import type {
  Attachment,
  Chat,
  ChatKind,
  ChatRole,
  DurableRealtimeEvent,
  Message,
  MessagePin,
  MessageVersion,
  NotificationPreviewMode,
  PushEnvironment,
  PushPlatform,
  PushRegistration,
  PublicProfile,
  Session,
  Topic,
  UploadSession,
  User
} from "@luxora/protocol";
import type { CredentialDiscoveryMode } from "@luxora/passkey-domain";

export interface UserRecord extends User {
  usernameNormalized: string;
  avatarAttachmentId?: string | null;
  passwordHash: string;
  passwordAuthEnabled: boolean;
  phonePasswordHash: string | null;
  phonePasswordEnabled: boolean;
  lastSeenAt: string | null;
}

export interface SessionRecord {
  id: string;
  userId: string;
  deviceName: string;
  createdAt: string;
  lastSeenAt: string;
  expiresAt: string;
  revokedAt: string | null;
}

export interface RefreshTokenRecord {
  id: string;
  sessionId: string;
  tokenHash: string;
  createdAt: string;
  expiresAt: string;
  usedAt: string | null;
}

export type PhoneAuthChallengeState =
  | "pending_delivery"
  | "pending"
  | "verified"
  | "consumed"
  | "locked"
  | "expired";

/** Decrypted only inside the trusted API process; never serialized directly. */
export interface PhoneAuthChallengeRecord {
  id: string;
  phoneDigest: string;
  e164: string;
  codeDigest: string;
  deliveryCode: string | null;
  deviceName: string;
  state: PhoneAuthChallengeState;
  revision: number;
  attemptsUsed: number;
  maxAttempts: number;
  beginClientNonce: string;
  beginFingerprint: string;
  maskedPhone: string;
  createdAt: string;
  expiresAt: string;
  retryAfterSeconds: number;
  updatedAt: string;
  verifiedAt: string | null;
  consumedAt: string | null;
  registrationTokenHash: string | null;
  registrationExpiresAt: string | null;
  matchedUserId: string | null;
}

export interface PhoneIdentityRecord {
  phoneDigest: string;
  userId: string;
  verifiedAt: string;
}

/** Operator projection for the loopback admin console. No secret material. */
export interface AdminUserRecord {
  id: string;
  username: string;
  displayName: string;
  phoneBound: boolean;
  phonePasswordEnabled: boolean;
  passwordAuthEnabled: boolean;
  activeSessions: number;
  chatCount: number;
  createdAt: string;
  lastSeenAt: string | null;
}

export interface AdminChatRecord {
  id: string;
  kind: "direct" | "group" | "channel";
  title: string | null;
  memberCount: number;
  messageCount: number;
  createdAt: string;
}

export interface AdminStatusRecord {
  migrationId: string;
  users: number;
  activeSessions: number;
  chatsByKind: { direct: number; group: number; channel: number };
  messages: number;
  phoneIdentities: number;
  pendingOutbox: number;
  failedOutbox: number;
}

export interface PhoneAuthCommandReceiptRecord {
  scope: string;
  operation: "verify" | "register";
  fingerprint: string;
  challengeId: string;
  resultKind: "invalid_code" | "profile_required" | "authenticated" | "registered";
  responseJson: string | null;
  createdAt: string;
  expiresAt: string;
}

export interface PhoneAuthPasswordReceiptRecord {
  scope: string;
  fingerprint: string;
  challengeId: string;
  resultKind:
    | "password_required"
    | "password_invalid"
    | "attempts_exhausted"
    | "authenticated";
  responseJson: string | null;
  createdAt: string;
  expiresAt: string;
}

export interface PhoneRecoveryIntentRecord {
  id: string;
  challengeId: string;
  userId: string;
  phoneDigest: string;
  recoveryTokenHash: string;
  state: "pending" | "completed";
  createdAt: string;
  confirmAt: string;
  expiresAt: string;
  updatedAt: string;
  completedAt: string | null;
}

export interface PhoneBindingChallengeRecord {
  id: string;
  userId: string;
  phoneDigest: string;
  e164: string;
  codeDigest: string;
  deliveryCode: string | null;
  state: PhoneAuthChallengeState;
  revision: number;
  attemptsUsed: number;
  maxAttempts: number;
  beginClientNonce: string;
  beginFingerprint: string;
  maskedPhone: string;
  createdAt: string;
  expiresAt: string;
  retryAfterSeconds: number;
  updatedAt: string;
  verifiedAt: string | null;
  consumedAt: string | null;
  bindingTokenHash: string | null;
  bindingExpiresAt: string | null;
}

export interface PhoneBindingReceiptRecord {
  scope: string;
  fingerprint: string;
  challengeId: string;
  resultKind: "binding_verified" | "completed" | "phone_unavailable" | "invalid_code";
  responseJson: string | null;
  createdAt: string;
  expiresAt: string;
}

export interface PrivacySettingsRecord {
  userId: string;
  usernameDiscoverable: boolean;
  messageRequests: "everyone" | "nobody";
  updatedAt: string;
}

export interface PushRegistrationRecord extends PushRegistration {
  userId: string;
  sessionId: string;
  tokenDigest: string;
}

export interface NotificationSettingsRecord {
  userId: string;
  messageAlerts: boolean;
  messageRequestAlerts: boolean;
  mentionAlerts: boolean;
  sound: boolean;
  badge: boolean;
  previewMode: NotificationPreviewMode;
  updatedAt: string;
}

export interface NewPushRegistration {
  id: string;
  userId: string;
  sessionId: string;
  platform: PushPlatform;
  environment: PushEnvironment;
  topic: "app.luxora.mobile";
  token: string;
  tokenDigest: string;
  at: string;
}

export type MessageRequestState = "pending" | "accepted" | "recipient_dismissed" | "expired";

export interface MessageRequestRecord {
  id: string;
  pairKey: string;
  senderId: string;
  recipientId: string;
  clientNonce: string;
  body: string;
  linkUrl: string | null;
  senderProfile: PublicProfile;
  recipientProfile: PublicProfile;
  state: MessageRequestState;
  chatId: string | null;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
  acceptedAt: string | null;
  dismissedAt: string | null;
}

export interface BlockRecord {
  blockerUserId: string;
  blockedUserId: string;
  profileSnapshot: PublicProfile | null;
  createdAt: string;
}

export interface SafetyEvidenceSnapshot {
  type: "message";
  messageId: string;
  chatId: string;
  senderUserId: string;
  createdAt: string;
  body: string | null;
  attachmentIds: string[];
}

export interface SafetyReportRecord {
  id: string;
  reporterUserId: string;
  subjectUserId: string;
  category: "spam" | "scam" | "harassment" | "hate" | "sexual_content" | "violence" | "impersonation" | "self_harm" | "other";
  evidence: SafetyEvidenceSnapshot[];
  comment: string | null;
  clientNonce: string;
  state: "submitted";
  alsoBlocked: boolean;
  createdAt: string;
}

export type IdentityAuditAction =
  | "privacy.updated"
  | "message_request.created"
  | "message_request.accepted"
  | "message_request.dismissed"
  | "message_request.expired"
  | "block.created"
  | "block.removed"
  | "report.submitted";

export interface ChatRecord {
  id: string;
  kind: ChatKind;
  title: string | null;
  avatarUrl: string | null;
  directKey: string | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  lastMessageId: string | null;
}

export interface ChatMemberRecord {
  chatId: string;
  userId: string;
  role: ChatRole;
  revision: number;
  joinedAt: string;
  updatedAt: string;
}

export interface ChatMembershipCommandReceiptRecord {
  actorUserId: string;
  clientNonce: string;
  operation: "add" | "role_update" | "remove";
  chatId: string;
  targetUserId: string;
  fingerprint: string;
  membership: ChatMemberRecord;
  createdAt: string;
}

export interface ChatFolderRulesRecord {
  includeKinds: ChatKind[];
  unreadOnly: boolean;
  excludeMuted: boolean;
  includeArchived: boolean;
}

export interface ChatFolderOverrideRecord {
  chatId: string;
  mode: "include" | "exclude";
  pinnedPosition: number | null;
}

export interface ChatFolderRecord {
  id: string;
  userId: string;
  title: string;
  position: number;
  revision: number;
  rules: ChatFolderRulesRecord;
  overrides: ChatFolderOverrideRecord[];
  createdAt: string;
  updatedAt: string;
}

export interface ChatFolderCommandReceiptRecord {
  userId: string;
  clientNonce: string;
  operation: "create" | "update" | "delete" | "reorder";
  fingerprint: string;
  responseJson: string;
  createdAt: string;
  expiresAt: string;
}

export interface ChatDraftRecord {
  userId: string;
  chatId: string;
  text: string | null;
  replyToMessageId: string | null;
  revision: number;
  updatedAt: string;
  deletedAt: string | null;
}

export interface ChatDraftCommandReceiptRecord {
  userId: string;
  clientNonce: string;
  operation: "put" | "delete";
  chatId: string;
  fingerprint: string;
  responseJson: string;
  createdAt: string;
  expiresAt: string;
}

export interface MessageRecord {
  id: string;
  chatId: string;
  senderId: string;
  kind: "text";
  body: string | null;
  replyToMessageId: string | null;
  topicId: string | null;
  forwardedFromMessageId: string | null;
  forwardedFromChatId: string | null;
  forwardedFromSenderId: string | null;
  forwardedFromSenderName: string | null;
  forwardedFromCreatedAt: string | null;
  forwardSourceMessageId: string | null;
  requestFingerprint: string | null;
  clientNonce: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
  editedAt: string | null;
  deletedAt: string | null;
  transcriptionConsent: boolean;
  transcript: string | null;
}

export interface AttachmentRecord {
  id: string;
  ownerUserId: string;
  kind: Attachment["kind"];
  fileName: string;
  declaredMimeType: string;
  detectedMimeType: string;
  sizeBytes: number;
  sha256: string;
  metadata: Record<string, unknown>;
  storageProvider: "local" | "s3";
  storageKey: string;
  safetyStatus: "unscanned" | "reencoded";
  metadataTrust: "client_declared" | "server_verified";
  createdAt: string;
  linkedAt: string | null;
  deletingAt: string | null;
  deletedAt: string | null;
}

export interface UploadSessionRecord {
  id: string;
  userId: string;
  idempotencyKey: string;
  kind: Attachment["kind"];
  fileName: string;
  declaredMimeType: string;
  sizeBytes: number;
  sha256: string;
  metadata: Record<string, unknown>;
  storageProvider: "local" | "s3";
  chunkSizeBytes: number;
  receivedBytes: number;
  status: UploadSession["status"];
  attachmentId: string | null;
  failureCode: string | null;
  expiresAt: string;
  createdAt: string;
  updatedAt: string;
  stagingCleanedAt: string | null;
  objectCleanedAt: string | null;
}

export interface UploadChunkRecord {
  uploadId: string;
  chunkIndex: number;
  byteOffset: number;
  sizeBytes: number;
  sha256: string;
  createdAt: string;
}

export interface TopicRecord {
  id: string;
  chatId: string;
  title: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
}

export interface StoredEvent {
  sequence: number;
  audienceUserId: string;
  event: DurableRealtimeEvent;
  createdAt: string;
}

export type RealtimeOutboxFailureCode = "event_unreadable" | "publish_failed";

export type ClaimedRealtimeOutboxEvent =
  | {
      ok: true;
      event: StoredEvent;
      attemptCount: number;
    }
  | {
      ok: false;
      eventSequence: number;
      attemptCount: number;
      failureCode: "event_unreadable";
    };

export interface AuthenticatedPrincipal {
  userId: string;
  sessionId: string;
  tokenId: string;
}

export interface CreatedAuthSession {
  session: SessionRecord;
  refreshToken: string;
}

/** Raw userHandle is decrypted only for WebAuthn option/verification work. */
export interface PasskeyUserHandleBinding {
  reference: string;
  accountId: string;
  userHandle: string;
  createdAtMs: number;
}

/** Secure repository projection; credential IDs are encrypted at rest and digest-indexed. */
export interface PasskeyCredentialRecord {
  recordId: string;
  credentialId: string;
  accountId: string;
  userHandleRef: string;
  publicKey: Uint8Array;
  algorithm: -7 | -257;
  discoveryMode: CredentialDiscoveryMode;
  credentialSetRef: string | null;
  revision: number;
  signCount: number;
  backupEligible: boolean;
  backupState: boolean;
  transports: readonly string[];
  registrationCeremonyId: string;
  createdAtMs: number;
  updatedAtMs: number;
}

export type PasskeyAuthenticatorLifecycleState = "active" | "revoked";

/** Account-facing projection. WebAuthn identifiers and verification material never enter it. */
export interface PasskeyAuthenticatorRecord {
  credentialRecordId: string;
  accountId: string;
  displayName: string;
  lifecycleState: PasskeyAuthenticatorLifecycleState;
  revision: number;
  createdAtMs: number;
  updatedAtMs: number;
  revokedAtMs: number | null;
}

/** Durable receipt for exact management-command replay; its snapshot is encrypted at rest. */
export interface PasskeyAuthenticatorCommandReceiptRecord {
  scope: string;
  fingerprint: string;
  credentialRecordId: string;
  accountId: string;
  resultRevision: number;
  eventId: string;
  result: PasskeyAuthenticatorRecord;
  createdAtMs: number;
}

/** Separate target-bound one-time grant; authenticator.add grants keep their original shape. */
export interface PasskeyAuthenticatorStepUpGrantRecord {
  authenticationCeremonyId: string;
  accountId: string;
  sessionId: string;
  deviceId: string;
  credentialRecordId: string;
  expectedAuthenticatorRevision: number;
  purpose: "authenticator.revoke";
  targetDigest: string;
  authTimeSec: number;
  issuedAtSec: number;
  expiresAtSec: number;
  consumedAtSec: number | null;
  managementCommandScope: string | null;
}

/**
 * Immutable semantic binding created atomically with an authenticator-revoke
 * authentication ceremony. The generic passkey domain intentionally knows
 * only `session.step_up`; this record proves which exact account resource and
 * revision that proof was requested for.
 */
export interface PasskeyAuthenticatorRevokeIntentRecord {
  authenticationCeremonyId: string;
  accountId: string;
  sessionId: string;
  deviceId: string;
  credentialRecordId: string;
  expectedAuthenticatorRevision: number;
  purpose: "authenticator.revoke";
  targetDigest: string;
  createdAtMs: number;
}

/** Verified JWT claims projected into Store without the raw bearer. */
export interface PasskeyAuthenticatorRevokeClaimsProjection {
  sub: string;
  sid: string;
  ceremony_id: string;
  jti: string;
  purpose: "authenticator.revoke";
  target_digest: string;
  auth_time: number;
  iat: number;
  exp: number;
}

/** Durable, one-time authorization minted by a successful step-up ceremony. */
export interface PasskeyStepUpGrantRecord {
  authenticationCeremonyId: string;
  accountId: string;
  sessionId: string;
  deviceId: string;
  purpose: "authenticator.add";
  targetDigest: string;
  authTimeSec: number;
  issuedAtSec: number;
  expiresAtSec: number;
  consumedAtSec: number | null;
  registrationCeremonyId: string | null;
}

/** Verified JWT claims projected into the repository; the raw JWT is never stored. */
export interface PasskeyStepUpClaimsProjection {
  sub: string;
  sid: string;
  ceremony_id: string;
  jti: string;
  purpose: "authenticator.add";
  target_digest: string;
  auth_time: number;
  iat: number;
  exp: number;
}

export type PasskeyLoginIntentState =
  | "pending"
  | "consumed"
  | "cancelled"
  | "expired"
  | "rejected";

export type PasskeyLoginTerminalReason =
  | "verified"
  | "cancelled"
  | "expired"
  | "attempts_exhausted";

/**
 * Anonymous, identifier-free passkey login aggregate. Account and credential
 * data are deliberately absent until a discoverable assertion has verified.
 */
export interface PasskeyLoginIntentRecord {
  intentId: string;
  schemaVersion: 1;
  purpose: {
    type: "session.create";
    targetDigest: string;
  };
  policyVersion: 1;
  /** Immutable issuance policy captured when the anonymous intent is created. */
  accessTokenTtlSeconds: number;
  sessionTtlSeconds: number;
  recoveryGraceSeconds: number;
  expectedRpId: string;
  expectedOrigin: string;
  timeoutMs: number;
  maxResponseBytes: number;
  maxAttempts: number;
  allowedAlgorithms: readonly [-7, -257];
  userVerification: "required";
  crossOriginAllowed: false;
  credentialBoundary: {
    mode: "discoverable_any";
    credentialSetRef: null;
  };
  challenge: {
    reference: string;
    digest: string;
  };
  deliveryNonceDigest: string;
  refreshDerivationKeyId: string;
  state: PasskeyLoginIntentState;
  revision: number;
  attemptsUsed: number;
  createdAtMs: number;
  expiresAtMs: number;
  updatedAtMs: number;
  terminalAtMs: number | null;
  terminalReason: PasskeyLoginTerminalReason | null;
  resolution: PasskeyLoginResolutionRecord | null;
}

/** Populated atomically only after the assertion, credential CAS and session commit. */
export interface PasskeyLoginResolutionRecord {
  accountId: string;
  userHandleRef: string;
  credentialRecordId: string;
  credentialRevisionBefore: number;
  credentialRevisionAfter: number;
  signCountBefore: number;
  /** Counter signed by the authenticator; may regress or be zero after sync. */
  observedSignCount: number;
  /** Monotonic value retained in the credential row after risk classification. */
  signCountAfter: number;
  backupEligible: boolean;
  backupStateBefore: boolean;
  backupStateAfter: boolean;
  sessionId: string;
  initialRefreshTokenId: string;
  initialAccessTokenExpiresAtSec: number;
}

/** Public-safe receipt projection. It never contains account or credential data. */
export interface PasskeyLoginReceiptRecord {
  scope: string;
  fingerprint: string;
  intentId: string;
  resultRevision: number;
  resultState: PasskeyLoginIntentState;
  eventId: string;
  createdAtMs: number;
}

export type PasskeySignupIntentState =
  | "pending"
  | "consumed"
  | "expired"
  | "rejected";

export type PasskeySignupTerminalReason =
  | "verified"
  | "expired"
  | "attempts_exhausted";

/**
 * Durable pre-account registration aggregate. `candidate.accountId` is a
 * server-generated subject and deliberately has no users-table foreign key
 * until the verified atomic account-creation commit.
 */
export interface PasskeySignupIntentRecord {
  intentId: string;
  schemaVersion: 1;
  purpose: {
    type: "account.create";
    targetDigest: string;
  };
  policyVersion: 1;
  rpName: "Luxora";
  expectedRpId: string;
  expectedOrigin: string;
  expectedTopOrigins: readonly [];
  timeoutMs: number;
  maxResponseBytes: number;
  maxAttempts: number;
  allowedAlgorithms: readonly [-7, -257];
  requireUserPresence: true;
  userVerification: "required";
  residentKey: "required";
  attestation: "none";
  crossOriginAllowed: false;
  excludeCredentials: readonly [];
  candidate: {
    accountId: string;
    username: string;
    usernameNormalized: string;
    displayName: string;
    userHandleRef: string;
    userHandle: Uint8Array;
  };
  challenge: {
    reference: string;
    digest: string;
  };
  deliveryNonceDigest: string;
  state: PasskeySignupIntentState;
  revision: number;
  attemptsUsed: number;
  createdAtMs: number;
  expiresAtMs: number;
  updatedAtMs: number;
  terminalAtMs: number | null;
  terminalReason: PasskeySignupTerminalReason | null;
  resolvedCredentialRecordId: string | null;
}

/** Durable internal replay projection. It excludes identity text and bearer material. */
export interface PasskeySignupConsumptionRecord {
  intentId: string;
  resultRevision: number;
  accountId: string;
  userHandleRef: string;
  credentialRecordId: string;
  sessionId: string;
  initialRefreshTokenId: string;
  initialAccessTokenExpiresAtSec: number;
  refreshDerivationKeyId: string;
  committedAtMs: number;
}

/** Public-safe receipt; candidate identity and ceremony secrets are excluded. */
export interface PasskeySignupReceiptRecord {
  scope: string;
  fingerprint: string;
  intentId: string;
  resultRevision: number;
  resultState: PasskeySignupIntentState;
  eventId: string;
  createdAtMs: number;
}

export type { Attachment, Chat, Message, MessagePin, MessageVersion, Session, Topic, UploadSession, User };
