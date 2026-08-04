import type { CeremonyAggregate, CeremonyState } from "./types.js";

export type PasskeyDomainErrorCode =
  | "VALIDATION_FAILED"
  | "NOT_FOUND"
  | "FORBIDDEN"
  | "REVISION_CONFLICT"
  | "IDEMPOTENCY_KEY_REUSED"
  | "CREATION_NONCE_REUSED"
  | "COMMAND_NOT_ALLOWED"
  | "TERMINAL_CEREMONY"
  | "CHALLENGE_UNAVAILABLE"
  | "CHALLENGE_INTEGRITY_FAILED"
  | "VERIFIER_UNAVAILABLE"
  | "CREDENTIAL_CONFLICT"
  | "CREDENTIAL_STATE_CONFLICT"
  | "STORAGE_UNAVAILABLE"
  | "STORAGE_INTEGRITY_FAILED";

/**
 * The only ceremony state that may cross an error boundary. Full aggregates
 * contain actor identifiers, challenge metadata and secure-store references,
 * so attaching one to an Error makes ordinary structured logging unsafe.
 */
export interface SafeCeremonyErrorState {
  readonly state: CeremonyState;
  readonly revision: number;
}

export class PasskeyDomainError extends Error {
  readonly code: PasskeyDomainErrorCode;
  readonly currentState: SafeCeremonyErrorState | null;

  constructor(
    code: PasskeyDomainErrorCode,
    message: string,
    internalSnapshot: CeremonyAggregate | null = null
  ) {
    super(message);
    this.name = "PasskeyDomainError";
    this.code = code;
    this.currentState = internalSnapshot === null
      ? null
      : Object.freeze({ state: internalSnapshot.state, revision: internalSnapshot.revision });
  }
}

export class StoreRevisionConflictError extends Error {
  constructor() {
    super("Passkey ceremony revision changed before commit");
    this.name = "StoreRevisionConflictError";
  }
}

export class StoreDuplicateCommandError extends Error {
  constructor() {
    super("Passkey ceremony command receipt already exists");
    this.name = "StoreDuplicateCommandError";
  }
}

export class StoreDuplicateCreationError extends Error {
  constructor() {
    super("Passkey ceremony creation receipt already exists");
    this.name = "StoreDuplicateCreationError";
  }
}

/** Store atomically rejected the authorization/precondition for an initial ceremony commit. */
export class StoreAuthorizationConflictError extends Error {
  constructor() {
    super("Passkey ceremony authorization precondition failed");
    this.name = "StoreAuthorizationConflictError";
  }
}

/** Store rejected a globally duplicate registration credential ID. */
export class StoreCredentialConflictError extends Error {
  constructor() {
    super("WebAuthn credential ID already exists");
    this.name = "StoreCredentialConflictError";
  }
}

/** Store rejected a stale authentication credential-row revision. */
export class StoreCredentialStateConflictError extends Error {
  constructor() {
    super("WebAuthn credential state changed before commit");
    this.name = "StoreCredentialStateConflictError";
  }
}

export function reject(
  code: PasskeyDomainErrorCode,
  message: string,
  snapshot: CeremonyAggregate | null = null
): never {
  throw new PasskeyDomainError(code, message, snapshot);
}
