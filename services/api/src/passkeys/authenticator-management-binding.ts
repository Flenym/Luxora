import { createHash } from "node:crypto";

export const PASSKEY_AUTHENTICATOR_REVOKE_PURPOSE = "authenticator.revoke" as const;

function digestTuple(value: readonly unknown[]): string {
  return createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
}

export function passkeyAuthenticatorRenameFingerprint(input: {
  readonly accountId: string;
  readonly sessionId: string;
  readonly credentialRecordId: string;
  readonly expectedRevision: number;
  readonly displayName: string;
}): string {
  return digestTuple([
    "rename",
    input.accountId,
    input.sessionId,
    input.credentialRecordId,
    input.expectedRevision,
    input.displayName
  ]);
}

export function passkeyAuthenticatorRevokeFingerprint(input: {
  readonly accountId: string;
  readonly sessionId: string;
  readonly credentialRecordId: string;
  readonly expectedRevision: number;
  readonly authenticationCeremonyId: string;
}): string {
  return digestTuple([
    "revoke",
    input.accountId,
    input.sessionId,
    input.credentialRecordId,
    input.expectedRevision,
    input.authenticationCeremonyId
  ]);
}

/**
 * Stable semantic binding shared by authorization issuance and consumption.
 * The opaque credential record ID is account-scoped; WebAuthn credential IDs
 * and verification material never enter this tuple.
 */
export function passkeyAuthenticatorRevokeTargetDigest(input: {
  readonly accountId: string;
  readonly sessionId: string;
  readonly credentialRecordId: string;
  readonly expectedRevision: number;
}): string {
  return digestTuple([
    "luxora/passkey-authenticator-management/v1/revoke",
    input.accountId,
    input.sessionId,
    input.credentialRecordId,
    input.expectedRevision
  ]);
}
