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
import type {
  ChallengeSecretVault,
  PasskeyCeremonyStore,
  PersistCeremonyMutation
} from "@luxora/passkey-domain";
import type {
  AttachmentRecord,
  BlockRecord,
  ClaimedRealtimeOutboxEvent,
  ChatMemberRecord,
  ChatFolderCommandReceiptRecord,
  ChatDraftCommandReceiptRecord,
  ChatDraftRecord,
  ChatFolderRecord,
  ChatFolderRulesRecord,
  ChatFolderOverrideRecord,
  ChatMembershipCommandReceiptRecord,
  ChatRecord,
  IdentityAuditAction,
  MessageRecord,
  MessageRequestRecord,
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
  PhoneIdentityRecord,
  PrivacySettingsRecord,
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
} from "./types.js";

export interface NewUser {
  id: string;
  username: string;
  usernameNormalized: string;
  displayName: string;
  passwordHash: string;
  createdAt: string;
}

export interface NewSession {
  id: string;
  userId: string;
  deviceName: string;
  createdAt: string;
  expiresAt: string;
}

export interface NewRefreshToken {
  id: string;
  sessionId: string;
  tokenHash: string;
  createdAt: string;
  expiresAt: string;
}

export interface NewPhoneAuthChallenge {
  id: string;
  phoneDigest: string;
  e164: string;
  codeDigest: string;
  deliveryCode: string;
  deviceName: string;
  maxAttempts: number;
  beginClientNonce: string;
  beginFingerprint: string;
  maskedPhone: string;
  createdAt: string;
  expiresAt: string;
  retryAfterSeconds: number;
}

export interface PhoneAuthReceiptInput {
  scope: string;
  operation: "verify" | "register";
  fingerprint: string;
  challengeId: string;
  resultKind: PhoneAuthCommandReceiptRecord["resultKind"];
  responseJson: string | null;
  createdAt: string;
  expiresAt: string;
}

export interface PhoneAuthSessionInput {
  session: NewSession;
  refreshToken: NewRefreshToken;
}

export interface CommitPhoneAuthRejected {
  challengeId: string;
  expectedRevision: number;
  nextState: Extract<PhoneAuthChallengeState, "pending" | "locked" | "expired">;
  receipt: PhoneAuthReceiptInput;
}

export interface CommitPhoneAuthProfileRequired {
  challengeId: string;
  expectedRevision: number;
  registrationTokenHash: string;
  registrationExpiresAt: string;
  receipt: PhoneAuthReceiptInput;
}

export interface CommitPhoneAuthAuthenticated extends PhoneAuthSessionInput {
  challengeId: string;
  expectedRevision: number;
  userId: string;
  receipt: PhoneAuthReceiptInput;
}

export interface CommitPhoneAuthRegistration extends PhoneAuthSessionInput {
  challengeId: string;
  expectedRevision: number;
  registrationTokenHash: string;
  user: NewUser & { bio: string };
  receipt: PhoneAuthReceiptInput;
}

export interface PhoneAuthPasswordReceiptInput {
  scope: string;
  fingerprint: string;
  challengeId: string;
  resultKind: PhoneAuthPasswordReceiptRecord["resultKind"];
  responseJson: string | null;
  createdAt: string;
  expiresAt: string;
}

export interface CommitPhoneAuthPasswordRequired {
  challengeId: string;
  expectedRevision: number;
  userId: string;
  passwordTokenHash: string;
  passwordExpiresAt: string;
  receipt: PhoneAuthPasswordReceiptInput & { resultKind: "password_required" };
}

export interface CommitPhoneAuthPasswordRejected {
  challengeId: string;
  expectedRevision: number;
  userId: string;
  passwordTokenHash: string;
  maxAttempts: number;
  receipt: Omit<PhoneAuthPasswordReceiptInput, "resultKind" | "responseJson">;
}

export interface CommitPhoneAuthPasswordAuthenticated extends PhoneAuthSessionInput {
  challengeId: string;
  expectedRevision: number;
  userId: string;
  passwordTokenHash: string;
  receipt: PhoneAuthPasswordReceiptInput & { resultKind: "authenticated" };
}

export interface NewPasskeyLoginIntent {
  intentId: string;
  schemaVersion: 1;
  purpose: {
    type: "session.create";
    targetDigest: string;
  };
  policyVersion: 1;
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
  state: "pending";
  revision: 1;
  attemptsUsed: 0;
  createdAtMs: number;
  expiresAtMs: number;
  updatedAtMs: number;
  terminalAtMs: null;
  terminalReason: null;
}

export interface PasskeyAuthenticatorMutationBase {
  accountId: string;
  sessionId: string;
  credentialRecordId: string;
  commandScope: string;
  fingerprint: string;
  expectedRevision: number;
  occurredAtMs: number;
  eventId: string;
  outboxId: string;
}

export interface PersistPasskeyAuthenticatorRename extends PasskeyAuthenticatorMutationBase {
  operation: "rename";
  displayName: string;
}

export interface PersistPasskeyAuthenticatorRevoke extends PasskeyAuthenticatorMutationBase {
  operation: "revoke";
  authorization: PasskeyAuthenticatorRevokeClaimsProjection;
}

export interface PasskeyAuthenticatorMutationResult {
  authenticator: PasskeyAuthenticatorRecord;
  replayed: boolean;
  /** Internal transport-cleanup input; never part of the account-facing response. */
  revokedSessionIds: readonly string[];
}

export type PasskeyLoginEventType =
  | "passkey.login.started"
  | "passkey.login.verification_rejected"
  | "passkey.login.consumed"
  | "passkey.login.cancelled"
  | "passkey.login.expired"
  | "passkey.login.attempts_exhausted";

export interface PasskeyLoginMutationRecord {
  event: {
    eventId: string;
    intentId: string;
    revision: number;
    type: PasskeyLoginEventType;
    commandScope: string;
    occurredAtMs: number;
    state: PasskeyLoginIntentState;
  };
  outbox: {
    outboxId: string;
    topic: "luxora.passkey-login.v1";
    partitionKey: string;
    eventId: string;
    availableAtMs: number;
  };
  commandReceipt: PasskeyLoginReceiptRecord;
}

export interface PersistPasskeyLoginBegin extends PasskeyLoginMutationRecord {
  intent: NewPasskeyLoginIntent;
  creationReceipt: PasskeyLoginReceiptRecord;
}

export interface PersistPasskeyLoginRejectedAttempt extends PasskeyLoginMutationRecord {
  intentId: string;
  expectedRevision: number;
  updatedAtMs: number;
  nextState: "pending" | "rejected";
}

export interface PersistPasskeyLoginTerminal extends PasskeyLoginMutationRecord {
  intentId: string;
  expectedRevision: number;
  terminalAtMs: number;
  nextState: "cancelled" | "expired";
}

/** Verified adapter projection. The raw assertion and user handle never enter Store. */
export interface VerifiedPasskeyLoginCredentialProjection {
  accountId: string;
  userHandleRef: string;
  credentialRecordId: string;
  credentialRevision: number;
  algorithm: -7 | -257;
  discoveryMode: "discoverable";
  previousSignCount: number;
  newSignCount: number;
  previousBackupEligible: boolean;
  backupEligible: boolean;
  previousBackupState: boolean;
  backupState: boolean;
  userHandleBindingVerified: true;
  userPresent: true;
  userVerified: true;
}

/** Hash-only deterministic refresh projection; a raw bearer is never accepted here. */
export interface PasskeyLoginRefreshProjection extends NewRefreshToken {
  derivationKeyId: string;
  deliveryNonceDigest: string;
}

/** Durable claims needed to reproduce the exact initial access JWT after response loss. */
export interface PasskeyLoginAccessTokenProjection {
  tokenId: string;
  issuedAtSec: number;
  expiresAtSec: number;
}

export interface PersistVerifiedPasskeyLogin extends PasskeyLoginMutationRecord {
  intentId: string;
  expectedRevision: number;
  committedAtMs: number;
  credential: VerifiedPasskeyLoginCredentialProjection;
  session: NewSession;
  refreshToken: PasskeyLoginRefreshProjection;
  accessToken: PasskeyLoginAccessTokenProjection;
}

export interface NewPasskeySignupIntent {
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
  state: "pending";
  revision: 1;
  attemptsUsed: 0;
  createdAtMs: number;
  expiresAtMs: number;
  updatedAtMs: number;
  terminalAtMs: null;
  terminalReason: null;
  resolvedCredentialRecordId: null;
}

export type PasskeySignupEventType =
  | "passkey.signup.started"
  | "passkey.signup.verification_rejected"
  | "passkey.signup.consumed"
  | "passkey.signup.expired"
  | "passkey.signup.attempts_exhausted";

export interface PasskeySignupMutationRecord {
  event: {
    eventId: string;
    intentId: string;
    revision: number;
    type: PasskeySignupEventType;
    commandScope: string;
    occurredAtMs: number;
    state: PasskeySignupIntentState;
  };
  outbox: {
    outboxId: string;
    topic: "luxora.passkey-signup.v1";
    partitionKey: string;
    eventId: string;
    availableAtMs: number;
  };
  commandReceipt: PasskeySignupReceiptRecord;
}

export interface PersistPasskeySignupBegin extends PasskeySignupMutationRecord {
  intent: NewPasskeySignupIntent;
  creationReceipt: PasskeySignupReceiptRecord;
}

export interface PersistPasskeySignupRejectedAttempt extends PasskeySignupMutationRecord {
  intentId: string;
  expectedRevision: number;
  updatedAtMs: number;
  nextState: "pending" | "rejected";
}

/** Expiry-only terminal mutation; verified consumption uses its strict projection below. */
export interface PersistPasskeySignupExpired extends PasskeySignupMutationRecord {
  intentId: string;
  expectedRevision: number;
  terminalAtMs: number;
  nextState: "expired";
}

/** Strict post-verifier projection. Raw WebAuthn JSON and raw bearers are forbidden. */
export interface PersistVerifiedPasskeySignup extends PasskeySignupMutationRecord {
  intentId: string;
  expectedRevision: number;
  committedAtMs: number;
  candidate: {
    accountId: string;
    username: string;
    usernameNormalized: string;
    displayName: string;
    userHandleRef: string;
    userHandle: Uint8Array;
  };
  credential: {
    credentialRecordId: string;
    credentialId: string;
    publicKey: Uint8Array;
    algorithm: -7 | -257;
    discoveryMode: "discoverable";
    signCount: number;
    backupEligible: boolean;
    backupState: boolean;
    transports: readonly ("ble" | "cable" | "hybrid" | "internal" | "nfc" | "smart-card" | "usb")[];
    userPresent: true;
    userVerified: true;
  };
  passwordAuth: {
    enabled: false;
    disabledHash: string;
  };
  session: NewSession;
  refreshToken: PasskeyLoginRefreshProjection;
  accessToken: PasskeyLoginAccessTokenProjection;
}

export interface NewMessageRequest {
  id: string;
  pairKey: string;
  senderId: string;
  recipientId: string;
  clientNonce: string;
  body: string;
  linkUrl: string | null;
  senderProfile: PublicProfile;
  recipientProfile: PublicProfile;
  createdAt: string;
  expiresAt: string;
}

export interface NewSafetyReport {
  id: string;
  reporterUserId: string;
  subjectUserId: string;
  category: SafetyReportRecord["category"];
  evidence: SafetyEvidenceSnapshot[];
  comment: string | null;
  clientNonce: string;
  alsoBlocked: boolean;
  createdAt: string;
}

export interface NewChat {
  id: string;
  kind: ChatKind;
  title: string | null;
  directKey: string | null;
  createdBy: string;
  createdAt: string;
}

export interface NewMessage {
  id: string;
  chatId: string;
  senderId: string;
  body: string | null;
  replyToMessageId: string | null;
  topicId: string | null;
  forwardedFromMessageId: string | null;
  forwardedFromChatId: string | null;
  forwardedFromSenderId: string | null;
  forwardedFromSenderName: string | null;
  forwardedFromCreatedAt: string | null;
  forwardSourceMessageId?: string | null;
  requestFingerprint?: string | null;
  clientNonce: string;
  createdAt: string;
}

export interface NewAttachment {
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
  safetyStatus?: "unscanned" | "reencoded";
  metadataTrust?: "client_declared" | "server_verified";
  createdAt: string;
}

export interface NewUploadSession {
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
  expiresAt: string;
  createdAt: string;
}

export interface ClaimedOrphanAttachments {
  attachments: AttachmentRecord[];
  invalidations: StoredEvent[];
}

export interface Store extends PasskeyCeremonyStore, ChallengeSecretVault {
  close(): void;
  ping(): boolean;
  transaction<T>(operation: () => T): T;
  immediateTransaction<T>(operation: () => T): T;

  createUser(user: NewUser): UserRecord;
  findUserById(id: string): UserRecord | null;
  updateUserProfile(
    userId: string,
    update: { displayName?: string | undefined; bio?: string | undefined },
    at: string
  ): UserRecord | null;
  setUserAvatarAttachment(userId: string, attachmentId: string | null, at: string): UserRecord | null;
  listProfileProjectionAudienceUserIds(userId: string): string[];
  findUserByUsername(normalizedUsername: string): UserRecord | null;
  findDiscoverableUserByUsername(viewerUserId: string, normalizedUsername: string): UserRecord | null;
  searchKnownUsers(viewerUserId: string, query: string, limit: number, cursor?: string): { items: User[]; nextCursor: string | null };
  setUserLastSeen(userId: string, at: string): void;

  /**
   * Creates one challenge while holding the SQLite writer reservation. Returns
   * null when the same phone digest is still inside its durable resend window.
   */
  createPhoneAuthChallenge(challenge: NewPhoneAuthChallenge): PhoneAuthChallengeRecord | null;
  findPhoneAuthChallengeById(id: string): PhoneAuthChallengeRecord | null;
  findPhoneAuthChallengeByBeginNonce(clientNonce: string): PhoneAuthChallengeRecord | null;
  findPhoneAuthChallengeByRegistrationTokenHash(tokenHash: string): PhoneAuthChallengeRecord | null;
  activatePhoneAuthChallenge(id: string, expectedRevision: number, at: string): boolean;
  failPhoneAuthChallengeDelivery(id: string, expectedRevision: number, at: string): boolean;
  findPhoneIdentityByDigest(phoneDigest: string): PhoneIdentityRecord | null;
  findPhoneIdentityByUserId(userId: string): PhoneIdentityRecord | null;
  findPhoneAuthCommandReceipt(scope: string): PhoneAuthCommandReceiptRecord | null;
  findPhoneAuthPasswordReceipt(scope: string): PhoneAuthPasswordReceiptRecord | null;
  commitPhoneAuthRejected(input: CommitPhoneAuthRejected): boolean;
  commitPhoneAuthProfileRequired(input: CommitPhoneAuthProfileRequired): boolean;
  commitPhoneAuthAuthenticated(input: CommitPhoneAuthAuthenticated): boolean;
  commitPhoneAuthRegistration(input: CommitPhoneAuthRegistration): boolean;
  commitPhoneAuthPasswordRequired(input: CommitPhoneAuthPasswordRequired): boolean;
  commitPhoneAuthPasswordRejected(
    input: CommitPhoneAuthPasswordRejected
  ): "password_invalid" | "attempts_exhausted" | null;
  commitPhoneAuthPasswordAuthenticated(input: CommitPhoneAuthPasswordAuthenticated): boolean;
  compareAndSetPhonePassword(input: {
    userId: string;
    expectedPhonePasswordHash: string | null;
    expectedEnabled: boolean;
    nextPhonePasswordHash: string;
    nextEnabled: boolean;
    at: string;
  }): boolean;

  getOrCreatePasskeyUserHandleBinding(accountId: string): Promise<PasskeyUserHandleBinding>;
  /** Returns an existing binding or a non-persisted candidate for atomic registration commit. */
  preparePasskeyUserHandleBinding(accountId: string): Promise<PasskeyUserHandleBinding>;
  findPasskeyUserHandleByAccountId(accountId: string): Promise<PasskeyUserHandleBinding | null>;
  findPasskeyUserHandleByRef(reference: string): Promise<PasskeyUserHandleBinding | null>;
  findPasskeyCredentialById(credentialId: string): Promise<PasskeyCredentialRecord | null>;
  findPasskeyCredentialByRecordId(recordId: string): Promise<PasskeyCredentialRecord | null>;
  listPasskeyCredentialsByAccountId(accountId: string): Promise<readonly PasskeyCredentialRecord[]>;
  findPasskeyAuthenticatorByRecordId(
    accountId: string,
    credentialRecordId: string
  ): Promise<PasskeyAuthenticatorRecord | null>;
  listPasskeyAuthenticatorsByAccountId(
    accountId: string
  ): Promise<readonly PasskeyAuthenticatorRecord[]>;
  findPasskeyAuthenticatorCommandReceipt(
    scope: string
  ): Promise<PasskeyAuthenticatorCommandReceiptRecord | null>;
  findPasskeyAuthenticatorStepUpGrant(
    authenticationCeremonyId: string
  ): Promise<PasskeyAuthenticatorStepUpGrantRecord | null>;
  findPasskeyAuthenticatorRevokeIntent(
    authenticationCeremonyId: string
  ): Promise<PasskeyAuthenticatorRevokeIntentRecord | null>;
  commitPasskeyAuthenticatorRevokeBegin(
    input: PersistCeremonyMutation,
    intent: PasskeyAuthenticatorRevokeIntentRecord
  ): Promise<void>;
  commitPasskeyAuthenticatorRename(
    input: PersistPasskeyAuthenticatorRename
  ): Promise<PasskeyAuthenticatorMutationResult>;
  commitPasskeyAuthenticatorRevoke(
    input: PersistPasskeyAuthenticatorRevoke
  ): Promise<PasskeyAuthenticatorMutationResult>;
  purgeExpiredPasskeyChallengeSecrets(nowMs: number, limit: number): Promise<number>;
  findPasskeyStepUpGrant(authenticationCeremonyId: string): Promise<PasskeyStepUpGrantRecord | null>;
  commitInitialPasskeyRegistration(
    input: PersistCeremonyMutation,
    claims: PasskeyStepUpClaimsProjection,
    userHandleBinding: PasskeyUserHandleBinding
  ): Promise<void>;
  findPasskeyLoginIntent(intentId: string): Promise<PasskeyLoginIntentRecord | null>;
  listExpiredPendingPasskeyLoginIntents(
    observedAtMs: number,
    limit: number
  ): Promise<readonly PasskeyLoginIntentRecord[]>;
  findPasskeyLoginCommandReceipt(scope: string): Promise<PasskeyLoginReceiptRecord | null>;
  findPasskeyLoginCreationReceipt(scope: string): Promise<PasskeyLoginReceiptRecord | null>;
  commitPasskeyLoginBegin(input: PersistPasskeyLoginBegin): Promise<void>;
  commitPasskeyLoginRejectedAttempt(input: PersistPasskeyLoginRejectedAttempt): Promise<void>;
  commitPasskeyLoginTerminal(input: PersistPasskeyLoginTerminal): Promise<void>;
  commitVerifiedPasskeyLogin(input: PersistVerifiedPasskeyLogin): Promise<void>;
  findPasskeySignupIntent(intentId: string): Promise<PasskeySignupIntentRecord | null>;
  findPasskeySignupConsumption(intentId: string): Promise<PasskeySignupConsumptionRecord | null>;
  listExpiredPendingPasskeySignupIntents(
    observedAtMs: number,
    limit: number
  ): Promise<readonly PasskeySignupIntentRecord[]>;
  findPasskeySignupCommandReceipt(scope: string): Promise<PasskeySignupReceiptRecord | null>;
  findPasskeySignupCreationReceipt(scope: string): Promise<PasskeySignupReceiptRecord | null>;
  commitPasskeySignupBegin(input: PersistPasskeySignupBegin): Promise<void>;
  commitPasskeySignupRejectedAttempt(input: PersistPasskeySignupRejectedAttempt): Promise<void>;
  commitPasskeySignupExpired(input: PersistPasskeySignupExpired): Promise<void>;
  commitVerifiedPasskeySignup(input: PersistVerifiedPasskeySignup): Promise<void>;

  getPrivacySettings(userId: string): PrivacySettingsRecord;
  updatePrivacySettings(
    userId: string,
    update: Partial<Pick<PrivacySettingsRecord, "usernameDiscoverable" | "messageRequests">>,
    at: string
  ): PrivacySettingsRecord;

  findCurrentPushRegistration(userId: string, sessionId: string): PushRegistrationRecord | null;
  upsertPushRegistration(registration: NewPushRegistration): PushRegistrationRecord;
  revokeCurrentPushRegistration(userId: string, sessionId: string, at: string): boolean;
  getNotificationSettings(userId: string): NotificationSettingsRecord;
  updateNotificationSettings(
    userId: string,
    update: Partial<Pick<
      NotificationSettingsRecord,
      | "messageAlerts"
      | "messageRequestAlerts"
      | "mentionAlerts"
      | "sound"
      | "badge"
      | "previewMode"
    >>,
    at: string
  ): NotificationSettingsRecord;

  hasAcceptedRelationship(leftUserId: string, rightUserId: string): boolean;
  createAcceptedRelationship(
    pairKey: string,
    leftUserId: string,
    rightUserId: string,
    acceptedRequestId: string,
    at: string
  ): void;
  deleteAcceptedRelationship(leftUserId: string, rightUserId: string): boolean;
  isBlockedBetween(leftUserId: string, rightUserId: string): boolean;
  createBlock(
    blockerUserId: string,
    blockedUserId: string,
    profileSnapshot: PublicProfile,
    at: string
  ): { record: BlockRecord; created: boolean };
  deleteBlock(blockerUserId: string, blockedUserId: string): boolean;
  listBlocks(userId: string, limit: number, cursor?: string): { items: BlockRecord[]; nextCursor: string | null };
  listBlocksForReconciliation(
    userId: string,
    limit: number,
    cursor?: string
  ): { items: BlockRecord[]; nextCursor: string | null };

  createMessageRequest(request: NewMessageRequest): MessageRequestRecord;
  findMessageRequestById(id: string): MessageRequestRecord | null;
  findMessageRequestByNonce(senderUserId: string, clientNonce: string): MessageRequestRecord | null;
  findPendingMessageRequestByPair(pairKey: string): MessageRequestRecord | null;
  findRecentDismissedMessageRequest(senderUserId: string, recipientUserId: string, since: string): MessageRequestRecord | null;
  listMessageRequests(
    userId: string,
    direction: "incoming" | "outgoing",
    limit: number,
    cursor?: string
  ): { items: MessageRequestRecord[]; nextCursor: string | null };
  acceptMessageRequest(id: string, recipientUserId: string, chatId: string, at: string): boolean;
  dismissMessageRequest(id: string, recipientUserId: string, at: string): boolean;
  expireMessageRequest(id: string, at: string): boolean;
  listExpiredMessageRequestsForUser(userId: string, at: string, limit: number): MessageRequestRecord[];
  closePendingMessageRequestsBetween(
    actorUserId: string,
    otherUserId: string,
    at: string
  ): MessageRequestRecord[];
  removeMessageRequestCreatedEvents(audienceUserId: string, requestId: string): void;

  createSafetyReport(report: NewSafetyReport): SafetyReportRecord;
  findSafetyReportByNonce(reporterUserId: string, clientNonce: string): SafetyReportRecord | null;
  listSafetyReports(
    reporterUserId: string,
    limit: number,
    cursor?: string
  ): { items: SafetyReportRecord[]; nextCursor: string | null };
  appendIdentityAudit(input: {
    id: string;
    accountUserId: string;
    actorUserId: string;
    action: IdentityAuditAction;
    targetUserId: string | null;
    resourceId: string | null;
    createdAt: string;
  }): void;

  createSession(session: NewSession, token: NewRefreshToken): SessionRecord;
  findRefreshToken(tokenHash: string): (RefreshTokenRecord & { session: SessionRecord }) | null;
  /** Atomically consumes the old token and inserts one session-bound replacement. */
  rotateRefreshToken(oldTokenId: string, replacement: NewRefreshToken, usedAt: string): boolean;
  revokeSession(sessionId: string, at: string): void;
  isSessionActive(sessionId: string, userId: string, now: string): boolean;
  touchSession(sessionId: string, at: string): void;
  listSessions(userId: string, currentSessionId: string): Session[];

  findChatRecord(id: string): ChatRecord | null;
  findDirectChat(directKey: string): ChatRecord | null;
  createChat(chat: NewChat): ChatRecord;
  addChatMember(chatId: string, userId: string, role: ChatRole, joinedAt: string): void;
  getChatMember(chatId: string, userId: string): ChatMemberRecord | null;
  listChatMembers(chatId: string): ChatMemberRecord[];
  listChatMemberIds(chatId: string): string[];
  countChatMembers(chatId: string): number;
  createChatMember(chatId: string, userId: string, role: Exclude<ChatRole, "owner">, at: string): ChatMemberRecord | null;
  updateChatMemberRole(
    chatId: string,
    userId: string,
    role: Exclude<ChatRole, "owner">,
    expectedRevision: number,
    at: string
  ): ChatMemberRecord | null;
  removeChatMember(
    chatId: string,
    userId: string,
    expectedRevision: number,
    at: string
  ): ChatMemberRecord | null;
  findChatMembershipCommandReceipt(
    actorUserId: string,
    clientNonce: string
  ): ChatMembershipCommandReceiptRecord | null;
  createChatMembershipCommandReceipt(receipt: ChatMembershipCommandReceiptRecord): void;
  listPeerUserIds(userId: string): string[];
  getChatForUser(chatId: string, userId: string): Chat | null;
  getChatPreferences(chatId: string, userId: string): ChatPreferences | null;
  updateChatPreferences(
    chatId: string,
    userId: string,
    input: { archived?: boolean; mutedUntil?: string | null; changedAt: string }
  ): ChatPreferences | null;
  getChatFolderStateRevision(userId: string): number;
  advanceChatFolderStateRevision(userId: string, at: string): number;
  countChatFolders(userId: string): number;
  listChatFolders(userId: string): ChatFolderRecord[];
  getChatFolderSnapshot(userId: string): {
    items: ChatFolderRecord[];
    stateRevision: number;
  };
  findChatFolder(userId: string, folderId: string): ChatFolderRecord | null;
  createChatFolder(folder: ChatFolderRecord): ChatFolderRecord;
  updateChatFolder(
    userId: string,
    folderId: string,
    input: {
      title: string;
      rules: ChatFolderRulesRecord;
      overrides: ChatFolderOverrideRecord[];
      expectedRevision: number;
      updatedAt: string;
    }
  ): ChatFolderRecord | null;
  deleteChatFolder(userId: string, folderId: string, expectedRevision: number): boolean;
  reorderChatFolders(userId: string, orderedFolderIds: string[], at: string): ChatFolderRecord[];
  findChatFolderCommandReceipt(
    userId: string,
    clientNonce: string,
    at: string
  ): ChatFolderCommandReceiptRecord | null;
  createChatFolderCommandReceipt(receipt: ChatFolderCommandReceiptRecord): void;
  countActiveChatFolderCommandReceipts(userId: string, at: string): number;
  getOldestChatFolderCommandReceiptExpiry(userId: string, at: string): string | null;
  deleteExpiredChatFolderCommandReceipt(userId: string, clientNonce: string, at: string): boolean;
  purgeExpiredChatFolderCommandReceipts(at: string, limit: number): number;
  getChatDraft(userId: string, chatId: string): ChatDraftRecord | null;
  putChatDraft(
    userId: string,
    chatId: string,
    input: {
      text: string;
      replyToMessageId: string | null;
      expectedRevision: number;
      updatedAt: string;
    }
  ): ChatDraftRecord | null;
  deleteChatDraft(
    userId: string,
    chatId: string,
    expectedRevision: number,
    updatedAt: string
  ): ChatDraftRecord | null;
  tombstoneChatDraftForMembershipRemoval(
    userId: string,
    chatId: string,
    updatedAt: string
  ): ChatDraftRecord | null;
  findChatDraftCommandReceipt(
    userId: string,
    clientNonce: string,
    at: string
  ): ChatDraftCommandReceiptRecord | null;
  createChatDraftCommandReceipt(receipt: ChatDraftCommandReceiptRecord): void;
  countActiveChatDraftCommandReceipts(userId: string, at: string): number;
  getOldestChatDraftCommandReceiptExpiry(userId: string, at: string): string | null;
  deleteExpiredChatDraftCommandReceipt(userId: string, clientNonce: string, at: string): boolean;
  purgeExpiredChatDraftCommandReceipts(at: string, limit: number): number;
  listChats(userId: string, limit: number, cursor?: string): { items: Chat[]; nextCursor: string | null };
  listChatsForReconciliation(
    userId: string,
    limit: number,
    cursor?: string
  ): { items: Chat[]; nextCursor: string | null };

  findMessageRecord(id: string): MessageRecord | null;
  findMessageByNonce(senderId: string, clientNonce: string): MessageRecord | null;
  createMessage(message: NewMessage): MessageRecord;
  updateMessage(id: string, body: string | null, expectedRevision: number | undefined, at: string): MessageRecord | null;
  deleteMessage(id: string, at: string): MessageRecord;
  getMessage(id: string): Message | null;
  listMessages(chatId: string, limit: number, cursor?: string, topicId?: string): { items: Message[]; nextCursor: string | null };
  addMessageAttachment(messageId: string, attachmentId: string, ordinal: number, linkedAt: string): void;
  listMessageAttachmentIds(messageId: string): string[];
  addMessageVersion(messageId: string, revision: number, body: string | null, editorUserId: string, at: string): void;
  listMessageVersions(messageId: string): MessageVersion[];
  deleteMessageVersions(messageId: string): void;
  pinMessage(chatId: string, messageId: string, userId: string, at: string): MessagePin;
  unpinMessage(chatId: string, messageId: string): boolean;
  listPins(chatId: string): MessagePin[];
  markDelivered(messageId: string, userId: string, at: string): MessageReceipt | null;
  markRead(
    chatId: string,
    userId: string,
    messageId: string,
    at: string
  ): { advanced: boolean; readAt: string };
  setReaction(messageId: string, userId: string, emoji: string, active: boolean, at: string): void;
  getReactionSummary(messageId: string, viewerId: string): Array<{ emoji: string; count: number; reactedByMe: boolean }>;
  listMessageReceipts(messageId: string): MessageReceipt[];
  removePendingMessageContentEvents(messageId: string): void;

  createTopic(id: string, chatId: string, title: string, userId: string, at: string): TopicRecord;
  findTopicRecord(id: string): TopicRecord | null;
  getTopic(id: string): Topic | null;
  listTopics(chatId: string): Topic[];
  updateTopic(id: string, title: string | undefined, closed: boolean | undefined, at: string): TopicRecord;

  createUploadSession(session: NewUploadSession): UploadSessionRecord;
  findUploadSession(id: string, userId: string): UploadSessionRecord | null;
  findUploadByIdempotency(userId: string, idempotencyKey: string): UploadSessionRecord | null;
  getUploadChunks(uploadId: string): UploadChunkRecord[];
  addUploadChunk(chunk: UploadChunkRecord, userId: string): boolean;
  acquireUploadCompletion(uploadId: string, userId: string, at: string, leaseUntil: string): boolean;
  releaseUploadCompletion(uploadId: string, at: string): void;
  completeUpload(uploadId: string, attachmentId: string, at: string): boolean;
  failUpload(uploadId: string, failureCode: string, at: string): void;
  expireUpload(uploadId: string, at: string, staleCompletionBefore?: string): boolean;
  listExpiredUploads(before: string, staleCompletionBefore: string, limit: number): UploadSessionRecord[];
  listUploadsWithStagingToClean(before: string, limit: number): UploadSessionRecord[];
  markUploadStagingCleaned(uploadId: string, at: string): void;
  listUploadsWithObjectsToClean(provider: "local" | "s3", before: string, limit: number): UploadSessionRecord[];
  markUploadObjectCleaned(uploadId: string, at: string): void;
  isUploadTerminal(uploadId: string): boolean;
  getReservedStorageBytes(userId: string, now: string): number;
  toUploadSession(record: UploadSessionRecord): UploadSession;

  createAttachment(attachment: NewAttachment): AttachmentRecord;
  findAttachmentRecord(id: string): AttachmentRecord | null;
  getAttachment(id: string): Attachment | null;
  listOwnedAttachments(userId: string, limit: number, cursor?: string): { items: Attachment[]; nextCursor: string | null };
  listAttachmentsByIds(ids: string[]): AttachmentRecord[];
  canUserAccessAttachment(userId: string, attachmentId: string): boolean;
  claimOrphanAttachments(
    provider: "local" | "s3",
    before: string,
    staleClaimBefore: string,
    at: string,
    limit: number
  ): ClaimedOrphanAttachments;
  deleteAttachmentRecord(id: string, at: string): StoredEvent[];

  replaceMessageSearchTokens(messageId: string, tokens: Array<{ keyId: string; hash: string }>): void;
  replaceAttachmentSearchTokens(attachmentId: string, tokens: Array<{ keyId: string; hash: string }>): void;
  searchMessages(userId: string, tokenHashes: string[], termCount: number, limit: number, cursor?: string, chatId?: string): { items: Message[]; nextCursor: string | null };
  searchAttachments(userId: string, tokenHashes: string[], termCount: number, limit: number, cursor?: string): { items: Attachment[]; nextCursor: string | null };
  getSearchIndexKeyId(): string | null;
  setSearchIndexKeyId(keyId: string, at: string): void;
  listMessagesForSearchIndex(afterId: string | undefined, limit: number): Array<{ id: string; body: string | null }>;
  listAttachmentsForSearchIndex(afterId: string | undefined, limit: number): Array<{ id: string; fileName: string }>;

  appendEvent(audienceUserId: string, event: DurableRealtimeEvent, at: string): StoredEvent;
  appendChatEvent(chatId: string, event: RealtimeEvent, at: string): StoredEvent[];
  getLatestSequence(): number;
  replayEvents(
    userId: string,
    afterSequence: number,
    throughSequence: number,
    limit: number,
    includeSyncInvalidations?: boolean
  ): StoredEvent[];
  claimRealtimeOutbox(
    workerId: string,
    at: string,
    leaseUntil: string,
    limit: number
  ): ClaimedRealtimeOutboxEvent[];
  markRealtimeOutboxPublished(sequence: number, workerId: string, at: string): boolean;
  releaseRealtimeOutbox(sequence: number, workerId: string, availableAt: string): boolean;
  markRealtimeOutboxFailed(
    sequence: number,
    workerId: string,
    at: string,
    failureCode: RealtimeOutboxFailureCode
  ): boolean;
}
