export const PASSKEY_DOMAIN_VERSION = 1 as const;
export const PASSKEY_DOMAIN_RELEASE = "Beta-0.1" as const;
export const PASSKEY_DOMAIN_OWNER = "Flenym" as const;
export const PASSKEY_CHALLENGE_BYTES = 32 as const;
export const PASSKEY_DEFAULT_TIMEOUT_MS = 300_000 as const;
export const PASSKEY_MAX_TIMEOUT_MS = 600_000 as const;
export const PASSKEY_MAX_RESPONSE_BYTES = 65_536 as const;
export const PASSKEY_MAX_ATTEMPTS = 5 as const;

export type CeremonyKind = "registration" | "authentication";
export type CeremonyState = "pending" | "consumed" | "cancelled" | "expired" | "rejected";
export type RegistrationPurposeType = "authenticator.add";
export type AuthenticationPurposeType = "session.step_up";
export type CeremonyPurposeType = RegistrationPurposeType | AuthenticationPurposeType;
export type CredentialDiscoveryMode = "discoverable" | "non_discoverable";

export interface AuthenticatedCeremonyActor {
  readonly accountId: string;
  readonly sessionId: string;
  readonly deviceId: string;
}

export interface RegistrationPurpose {
  readonly type: RegistrationPurposeType;
  /** SHA-256 of a server-canonicalized target; never a client-authored target. */
  readonly targetDigest: string;
}

export interface AuthenticationPurpose {
  readonly type: AuthenticationPurposeType;
  /** SHA-256 of a server-canonicalized target; never a client-authored target. */
  readonly targetDigest: string;
}

export type CeremonyPurpose = RegistrationPurpose | AuthenticationPurpose;

export interface DiscoverableCredentialBoundary {
  readonly mode: "discoverable";
  readonly credentialSetRef: null;
}

export interface NonDiscoverableCredentialBoundary {
  readonly mode: "non_discoverable";
  /** Opaque secure-store reference; credential IDs never enter the aggregate. */
  readonly credentialSetRef: string;
}

export type CredentialBoundary = DiscoverableCredentialBoundary | NonDiscoverableCredentialBoundary;

export interface PasskeyRelyingPartyPolicy {
  readonly policyVersion: typeof PASSKEY_DOMAIN_VERSION;
  readonly rpId: string;
  readonly allowedOrigins: readonly string[];
  readonly timeoutMs: number;
  readonly maxAttempts: number;
  readonly maxResponseBytes: number;
  readonly userVerification: "required";
  readonly userPresenceRequired: true;
  readonly crossOriginAllowed: false;
  readonly expectedTopOrigins: readonly [];
  readonly attestation: "none";
  readonly registrationResidentKey: "required";
  readonly allowedAlgorithms: readonly (-7 | -257)[];
}

export interface ChallengeDescriptor {
  readonly reference: string;
  /** Lower-case SHA-256 hex of decoded challenge bytes. */
  readonly digest: string;
  readonly byteLength: typeof PASSKEY_CHALLENGE_BYTES;
}

export interface CeremonyAggregate {
  readonly schemaVersion: typeof PASSKEY_DOMAIN_VERSION;
  readonly ceremonyId: string;
  readonly kind: CeremonyKind;
  readonly purpose: CeremonyPurpose;
  readonly actor: AuthenticatedCeremonyActor;
  readonly policyVersion: typeof PASSKEY_DOMAIN_VERSION;
  readonly expectedRpId: string;
  readonly expectedOrigin: string;
  readonly timeoutMs: number;
  readonly maxResponseBytes: number;
  readonly userVerification: "required";
  readonly crossOriginAllowed: false;
  readonly expectedTopOrigins: readonly [];
  readonly attestation: "none";
  readonly registrationResidentKey: "required";
  readonly allowedAlgorithms: readonly (-7 | -257)[];
  readonly credentialBoundary: CredentialBoundary;
  /** Registration-only PII-free user-handle secure-store reference. */
  readonly userHandleRef: string | null;
  readonly challenge: ChallengeDescriptor;
  readonly state: CeremonyState;
  readonly revision: number;
  readonly attemptsUsed: number;
  readonly maxAttempts: number;
  readonly createdAtMs: number;
  readonly expiresAtMs: number;
  readonly updatedAtMs: number;
  readonly terminalAtMs: number | null;
  readonly terminalReason: "verified" | "cancelled" | "expired" | "attempts_exhausted" | null;
  readonly riskSignals: readonly PasskeyRiskSignal[];
}

interface BaseCommand {
  readonly schemaVersion: typeof PASSKEY_DOMAIN_VERSION;
  readonly commandId: string;
  readonly actor: AuthenticatedCeremonyActor;
  readonly expectedRevision: number;
}

export interface BeginRegistrationCommand extends BaseCommand {
  readonly type: "begin_registration";
  readonly expectedRevision: 0;
  readonly clientNonce: string;
  readonly purpose: RegistrationPurpose;
  readonly expectedOrigin: string;
  readonly credentialBoundary: DiscoverableCredentialBoundary;
  readonly userHandleRef: string;
}

export interface BeginAuthenticationCommand extends BaseCommand {
  readonly type: "begin_authentication";
  readonly expectedRevision: 0;
  readonly clientNonce: string;
  readonly purpose: AuthenticationPurpose;
  readonly expectedOrigin: string;
  readonly credentialBoundary: CredentialBoundary;
}

export type BeginCeremonyCommand = BeginRegistrationCommand | BeginAuthenticationCommand;

interface ExistingCeremonyCommand extends BaseCommand {
  readonly ceremonyId: string;
}

export interface VerifyCeremonyCommand extends ExistingCeremonyCommand {
  readonly type: "verify";
  /** Measured by the size-bounded transport before opaque verifier handoff. */
  readonly responseByteLength: number;
  /**
   * SHA-256 of the exact accepted response bytes, computed by the bounded
   * server transport (never accepted as a client-authored field).
   */
  readonly responseDigest: string;
}

export interface CancelCeremonyCommand extends ExistingCeremonyCommand {
  readonly type: "cancel";
}

export interface ExpireCeremonyCommand {
  readonly schemaVersion: typeof PASSKEY_DOMAIN_VERSION;
  readonly type: "expire";
  readonly commandId: string;
  readonly actor: {
    readonly kind: "system";
    readonly subject: "ceremony-expirer";
  };
  readonly expectedRevision: number;
  readonly ceremonyId: string;
}

export type CeremonyCommand = BeginCeremonyCommand | VerifyCeremonyCommand | CancelCeremonyCommand | ExpireCeremonyCommand;
export type SafeCeremonyCommand = CeremonyCommand;

export type CeremonyEventType =
  | "passkey.ceremony.started"
  | "passkey.ceremony.verification_rejected"
  | "passkey.ceremony.consumed"
  | "passkey.ceremony.cancelled"
  | "passkey.ceremony.expired"
  | "passkey.ceremony.attempts_exhausted";

/** Internal durable event. It contains challenge reference/digest, never its raw bytes. */
export interface CeremonyDomainEvent {
  readonly schemaVersion: typeof PASSKEY_DOMAIN_VERSION;
  readonly eventId: string;
  readonly type: CeremonyEventType;
  readonly ceremonyId: string;
  readonly revision: number;
  readonly occurredAtMs: number;
  readonly commandId: string;
  readonly snapshot: CeremonyAggregate;
}

export interface CeremonyOutboxPayload {
  readonly schemaVersion: typeof PASSKEY_DOMAIN_VERSION;
  readonly type: CeremonyEventType;
  readonly ceremonyId: string;
  readonly kind: CeremonyKind;
  readonly purpose: CeremonyPurposeType;
  readonly state: CeremonyState;
  readonly revision: number;
  readonly attemptsUsed: number;
  readonly riskSignals: readonly PasskeyRiskSignal[];
  readonly occurredAtMs: number;
}

export interface CeremonyOutboxRecord {
  readonly schemaVersion: typeof PASSKEY_DOMAIN_VERSION;
  readonly outboxId: string;
  readonly topic: "luxora.passkey-ceremony.v1";
  readonly partitionKey: string;
  readonly eventId: string;
  readonly payload: CeremonyOutboxPayload;
  readonly availableAtMs: number;
}

export type PasskeyRiskSignal =
  | "signature_counter_not_supported"
  | "signature_counter_anomaly"
  | "backup_state_enabled"
  | "backup_state_disabled"
  | "single_device_credential"
  | "backup_not_active";

export interface SecureRegistrationCredential {
  readonly credentialId: string;
  readonly publicKey: Uint8Array;
  readonly algorithm: -7 | -257;
  readonly accountId: string;
  readonly userHandleRef: string;
  readonly discoveryMode: CredentialDiscoveryMode;
  readonly signCount: number;
  readonly backupEligible: boolean;
  readonly backupState: boolean;
  readonly transports: readonly string[];
  readonly userPresent: true;
  readonly userVerified: true;
}

export interface VerifiedAuthenticationCredential {
  readonly credentialRecordId: string;
  /** Exact secure credential-row revision read for this verification. */
  readonly credentialRevision: number;
  readonly accountId: string;
  readonly discoveryMode: CredentialDiscoveryMode;
  readonly userHandleBindingVerified: true;
  readonly previousSignCount: number;
  /** Verifier-observed assertion counter; it may be zero or non-monotonic. */
  readonly newSignCount: number;
  readonly previousBackupEligible: boolean;
  readonly backupEligible: boolean;
  readonly previousBackupState: boolean;
  readonly backupState: boolean;
  readonly userPresent: true;
  readonly userVerified: true;
}

export interface RegistrationVerifierSuccess {
  readonly status: "verified";
  readonly kind: "registration";
  readonly credential: SecureRegistrationCredential;
}

export interface AuthenticationVerifierSuccess {
  readonly status: "verified";
  readonly kind: "authentication";
  readonly credential: VerifiedAuthenticationCredential;
}

export interface VerifierRejection {
  readonly status: "rejected";
  /** Intentionally coarse; adapter details must not enter durable state. */
  readonly reason: "invalid_webauthn_response" | "policy_rejected";
}

export type WebAuthnVerifierResult = RegistrationVerifierSuccess | AuthenticationVerifierSuccess | VerifierRejection;

export interface MaintainedVerifierDescriptor {
  readonly kind: "maintained-webauthn-server-library";
  readonly libraryName: string;
  readonly libraryVersion: string;
  readonly reviewReference: string;
}

export interface RegistrationVerificationExpectations {
  readonly kind: "registration";
  readonly expectedChallenge: string;
  readonly expectedRpId: string;
  readonly expectedOrigin: string;
  readonly expectedTopOrigins: readonly [];
  readonly crossOriginAllowed: false;
  readonly requireUserPresence: true;
  readonly requireUserVerification: true;
  readonly attestation: "none";
  readonly residentKey: "required";
  readonly allowedAlgorithms: readonly (-7 | -257)[];
  readonly expectedAccountId: string;
  readonly expectedUserHandleRef: string;
  readonly purpose: RegistrationPurpose;
  readonly maxResponseBytes: number;
  readonly responseByteLength: number;
}

export interface AuthenticationVerificationExpectations {
  readonly kind: "authentication";
  readonly expectedChallenge: string;
  readonly expectedRpId: string;
  readonly expectedOrigin: string;
  readonly expectedTopOrigins: readonly [];
  readonly crossOriginAllowed: false;
  readonly requireUserPresence: true;
  readonly requireUserVerification: true;
  readonly allowedAlgorithms: readonly (-7 | -257)[];
  readonly expectedAccountId: string;
  readonly credentialBoundary: CredentialBoundary;
  readonly purpose: AuthenticationPurpose;
  readonly maxResponseBytes: number;
  readonly responseByteLength: number;
}

/**
 * Identifier-free passkey login is deliberately separate from the
 * account-bound ceremony aggregate. It must never be accepted where a
 * `CredentialBoundary` proves access to an already authenticated account.
 */
export interface DiscoverableAnyCredentialBoundary {
  readonly mode: "discoverable_any";
  readonly credentialSetRef: null;
}

export interface SessionCreatePurpose {
  readonly type: "session.create";
  /** SHA-256 of the server-canonicalized session bootstrap target. */
  readonly targetDigest: string;
}

export interface DiscoverableLoginVerificationExpectations {
  readonly kind: "authentication";
  readonly expectedChallenge: string;
  readonly expectedRpId: string;
  readonly expectedOrigin: string;
  readonly expectedTopOrigins: readonly [];
  readonly crossOriginAllowed: false;
  readonly requireUserPresence: true;
  readonly requireUserVerification: true;
  readonly allowedAlgorithms: readonly (-7 | -257)[];
  readonly credentialBoundary: DiscoverableAnyCredentialBoundary;
  readonly purpose: SessionCreatePurpose;
  readonly maxResponseBytes: number;
  readonly responseByteLength: number;
}

export interface DiscoverableLoginVerifierSuccess {
  readonly status: "verified";
  readonly kind: "authentication";
  readonly purpose: "session.create";
  readonly credentialBoundary: "discoverable_any";
  readonly account: {
    readonly accountId: string;
    readonly userHandleRef: string;
    readonly userHandleBindingVerified: true;
  };
  readonly credential: {
    readonly credentialRecordId: string;
    readonly credentialRevision: number;
    readonly algorithm: -7 | -257;
    readonly discoveryMode: "discoverable";
    readonly previousSignCount: number;
    readonly newSignCount: number;
    readonly previousBackupEligible: boolean;
    readonly backupEligible: boolean;
    readonly previousBackupState: boolean;
    readonly backupState: boolean;
    readonly userPresent: true;
    readonly userVerified: true;
  };
}

export interface DiscoverableLoginVerifierRejection {
  readonly status: "rejected";
  readonly reason: "invalid_webauthn_response";
}

/**
 * Additive verifier port for username-free login. It returns an account only
 * after the assertion, discoverable credential, and server-owned user handle
 * have all been bound and verified.
 */
export interface MaintainedDiscoverableLoginVerifierAdapter {
  readonly implementation: MaintainedVerifierDescriptor;
  verifyDiscoverableLogin(
    response: unknown,
    expectations: DiscoverableLoginVerificationExpectations
  ): Promise<DiscoverableLoginVerifierSuccess | DiscoverableLoginVerifierRejection>;
}

/**
 * Production adapters must delegate every WebAuthn parse, signature,
 * attestation/assertion, type, challenge, origin, RP ID hash, UP/UV and
 * algorithm check to the named maintained server library. The domain never
 * parses a WebAuthn response or implements those cryptographic operations.
 */
export interface MaintainedWebAuthnVerifierAdapter {
  readonly implementation: MaintainedVerifierDescriptor;
  verifyRegistration(
    response: unknown,
    expectations: RegistrationVerificationExpectations
  ): Promise<RegistrationVerifierSuccess | VerifierRejection>;
  verifyAuthentication(
    response: unknown,
    expectations: AuthenticationVerificationExpectations
  ): Promise<AuthenticationVerifierSuccess | VerifierRejection>;
}

export interface IssuedChallenge {
  readonly reference: string;
  /** Unpadded base64url of exactly 32 cryptographically random bytes. */
  readonly challenge: string;
}

/**
 * Production implementations must generate server-side CSPRNG bytes, retain
 * the raw value only in a secret TTL store, and never log method arguments or
 * results. Ceremony CAS state, not this vault, is the one-time-use authority.
 */
export interface ChallengeSecretVault {
  issue(input: {
    readonly byteLength: typeof PASSKEY_CHALLENGE_BYTES;
    readonly expiresAtMs: number;
  }): Promise<IssuedChallenge>;
  resolve(reference: string): Promise<string | null>;
  discard(reference: string): Promise<void>;
}

export type IdPurpose = "ceremony" | "event" | "outbox" | "credential-record";

export interface Clock {
  nowMs(): number;
}

export interface IdGenerator {
  next(purpose: IdPurpose): string;
}

export interface StoreRegistrationCredentialEffect {
  readonly type: "store_registration_credential";
  readonly credentialRecordId: string;
  readonly ceremonyId: string;
  readonly credential: SecureRegistrationCredential;
}

export interface UpdateAuthenticationCredentialEffect {
  readonly type: "update_authentication_credential";
  readonly ceremonyId: string;
  /**
   * The verifier and domain must already have validated the observed counter
   * shape and rejected any mismatch with the immutable registration-time BE
   * value. A zero or non-advancing observed counter is risk telemetry, not an
   * authentication failure. The effect deliberately retains the exact
   * observed `newSignCount`; the store must compare and increment
   * `credential.credentialRevision`, compare prior counter/BE/BS, and persist a
   * non-regressing counter such as max(previous, observed) in one transaction.
   * This row CAS remains required even when authenticators always report zero.
   */
  readonly credential: VerifiedAuthenticationCredential;
  readonly riskSignals: readonly PasskeyRiskSignal[];
}

export type SecureCredentialEffect = StoreRegistrationCredentialEffect | UpdateAuthenticationCredentialEffect;

export interface CeremonyMutation {
  readonly snapshot: CeremonyAggregate;
  readonly event: CeremonyDomainEvent;
  readonly outbox: CeremonyOutboxRecord;
  /** Sensitive write; atomic with consume, but excluded from event/outbox/log projections. */
  readonly secureCredentialEffect: SecureCredentialEffect | null;
}

export interface StoredCommandResult {
  readonly ceremonyId: string;
  readonly revision: number;
  readonly eventId: string;
  readonly snapshot: CeremonyAggregate;
}

export interface CommandReceipt {
  readonly scope: string;
  /** Fingerprint covers only the safe command envelope, never a WebAuthn response. */
  readonly fingerprint: string;
  readonly result: StoredCommandResult;
  readonly createdAtMs: number;
}

export interface CreationReceipt {
  readonly scope: string;
  readonly fingerprint: string;
  readonly result: StoredCommandResult;
  readonly createdAtMs: number;
}

export interface PersistCeremonyMutation {
  readonly expectedRevision: number | null;
  readonly mutation: CeremonyMutation;
  readonly commandReceipt: CommandReceipt;
  readonly creationReceipt: CreationReceipt | null;
}

/**
 * commit() must atomically compare revision and write snapshot, event, outbox,
 * receipt and secure credential effect. Registration credential ID has a
 * separate global unique constraint. Authentication effects additionally CAS
 * the secure credential row revision, account binding and prior counter/BE/BS
 * values. No partial commit is permitted. For an initial commit
 * (`expectedRevision === null`), implementations may atomically validate an
 * authorization/grant precondition and throw StoreAuthorizationConflictError
 * before writing anything. The error must carry no grant, token or actor
 * detail; receipt lookup remains authoritative for ambiguous committed writes.
 */
export interface PasskeyCeremonyStore {
  loadCeremony(ceremonyId: string): Promise<CeremonyAggregate | null>;
  findCommandReceipt(scope: string): Promise<CommandReceipt | null>;
  findCreationReceipt(scope: string): Promise<CreationReceipt | null>;
  commit(input: PersistCeremonyMutation): Promise<void>;
}

export interface RegistrationClientRequirements {
  readonly kind: "registration";
  readonly challenge: string;
  readonly rpId: string;
  readonly timeoutMs: number;
  readonly userVerification: "required";
  readonly residentKey: "required";
  readonly attestation: "none";
  readonly allowedAlgorithms: readonly (-7 | -257)[];
}

export interface AuthenticationClientRequirements {
  readonly kind: "authentication";
  readonly challenge: string;
  readonly rpId: string;
  readonly timeoutMs: number;
  readonly userVerification: "required";
  readonly credentialMode: CredentialDiscoveryMode;
}

export type CeremonyClientRequirements = RegistrationClientRequirements | AuthenticationClientRequirements;

export interface ExecutedCeremonyCommand {
  readonly snapshot: CeremonyAggregate;
  readonly eventId: string;
  readonly outboxId: string | null;
  readonly replayed: boolean;
  /** Present only for begin/replay-begin; raw challenge is never durable. */
  readonly clientRequirements: CeremonyClientRequirements | null;
}

export interface SafeCeremonyLogFields {
  readonly component: "passkey-domain";
  readonly schemaVersion: typeof PASSKEY_DOMAIN_VERSION;
  readonly eventType: CeremonyEventType;
  readonly ceremonyKind: CeremonyKind;
  readonly purpose: CeremonyPurposeType;
  readonly state: CeremonyState;
  readonly revision: number;
  readonly attemptsUsed: number;
  readonly riskSignals: readonly PasskeyRiskSignal[];
}
