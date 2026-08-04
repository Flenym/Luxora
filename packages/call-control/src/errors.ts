import type { CallAggregate } from "./types.js";

export type CallControlErrorCode =
  | "VALIDATION_FAILED"
  | "NOT_FOUND"
  | "REVISION_CONFLICT"
  | "IDEMPOTENCY_KEY_REUSED"
  | "CREATION_NONCE_REUSED"
  | "COMMAND_NOT_ALLOWED"
  | "FORBIDDEN"
  | "TERMINAL_CALL"
  | "MEMBERSHIP_NOT_FOUND"
  | "MEMBERSHIP_REVOKED"
  | "GRANT_DENIED";

export class CallControlError extends Error {
  readonly code: CallControlErrorCode;
  readonly currentSnapshot: CallAggregate | null;

  constructor(code: CallControlErrorCode, message: string, currentSnapshot: CallAggregate | null = null) {
    super(message);
    this.name = "CallControlError";
    this.code = code;
    this.currentSnapshot = currentSnapshot;
  }
}

/** Store compare-and-swap failed because another command committed first. */
export class StoreRevisionConflictError extends Error {
  constructor() {
    super("Call aggregate revision changed before commit");
    this.name = "StoreRevisionConflictError";
  }
}

/** Store unique command scope was won by another concurrent request. */
export class StoreDuplicateCommandError extends Error {
  constructor() {
    super("Command receipt already exists");
    this.name = "StoreDuplicateCommandError";
  }
}

/** Store unique create-nonce scope was won by another concurrent request. */
export class StoreDuplicateCreationError extends Error {
  constructor() {
    super("Creation receipt already exists");
    this.name = "StoreDuplicateCreationError";
  }
}

export function reject(
  code: CallControlErrorCode,
  message: string,
  snapshot: CallAggregate | null = null
): never {
  throw new CallControlError(code, message, snapshot);
}
