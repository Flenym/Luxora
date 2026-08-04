import { randomUUID } from "node:crypto";
import { types as utilTypes } from "node:util";

import {
  StoreAuthorizationConflictError,
  StoreCredentialStateConflictError,
  StoreDuplicateCommandError,
  StoreRevisionConflictError
} from "@luxora/passkey-domain";
import {
  IdSchema,
  PasskeyAuthenticatorDisplayNameSchema,
  PasskeyAuthenticatorListResponseSchema,
  PasskeyAuthenticatorMutationResponseSchema,
  PasskeyAuthenticatorRevokeAuthorizationSchema,
  PasskeyStepUpTokenSchema,
  type PasskeyAuthenticatorListResponse,
  type PasskeyAuthenticatorMutationResponse,
  type PasskeyAuthenticatorPublic,
  type PasskeyAuthenticatorRevokeAuthorization
} from "@luxora/protocol";
import type { Store } from "../domain/store.js";
import type {
  AuthenticatedPrincipal,
  PasskeyAuthenticatorRecord,
  PasskeyAuthenticatorStepUpGrantRecord
} from "../domain/types.js";
import { AppError, badRequest, conflict, forbidden, serviceUnavailable } from "../errors.js";
import {
  PASSKEY_AUTHENTICATOR_REVOKE_PURPOSE,
  passkeyAuthenticatorRenameFingerprint,
  passkeyAuthenticatorRevokeFingerprint,
  passkeyAuthenticatorRevokeTargetDigest
} from "../passkeys/authenticator-management-binding.js";
import {
  InvalidStepUpTokenError,
  InvalidStepUpTokenInputError,
  type StepUpTokenBinding,
  type StepUpTokenIssueInput,
  type VerifiedStepUpTokenClaims
} from "../passkeys/step-up-token.js";

const INPUT_MAX_KEYS = 8;

export interface PasskeyAuthenticatorManagementTokenAuthority {
  issue(input: StepUpTokenIssueInput): Promise<string>;
  verify(token: string, expected: StepUpTokenBinding): Promise<VerifiedStepUpTokenClaims>;
  verifyCommittedReplay(token: string, durableIssueInput: StepUpTokenIssueInput): Promise<void>;
}

export interface PasskeyAuthenticatorManagementServiceOptions {
  readonly store: Store;
  readonly stepUpTokens: PasskeyAuthenticatorManagementTokenAuthority;
  readonly clock?: () => Date;
  readonly onSessionsRevoked?: (sessionIds: readonly string[]) => void | Promise<void>;
  readonly onSessionRevocationCleanupFailure?: (
    error: unknown,
    sessionIds: readonly string[]
  ) => void | Promise<void>;
}

function exactInput(value: unknown, keys: readonly string[]): Readonly<Record<string, unknown>> {
  try {
    if (
      value === null
      || typeof value !== "object"
      || Array.isArray(value)
      || utilTypes.isProxy(value)
      || keys.length > INPUT_MAX_KEYS
    ) throw new Error("invalid input");
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) throw new Error("invalid input");
    const ownKeys = Reflect.ownKeys(value);
    if (
      ownKeys.length !== keys.length
      || ownKeys.some((key) => typeof key !== "string" || !keys.includes(key))
    ) throw new Error("invalid input");
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const snapshot: Record<string, unknown> = {};
    for (const key of keys) {
      const descriptor = descriptors[key];
      if (descriptor === undefined || descriptor.enumerable !== true || !("value" in descriptor)) {
        throw new Error("invalid input");
      }
      snapshot[key] = descriptor.value;
    }
    return Object.freeze(snapshot);
  } catch {
    throw badRequest("Invalid authenticator management request");
  }
}

function commandScope(accountId: string, commandId: string): string {
  return `passkey-authenticator:${accountId}:${commandId}`;
}

function timestamp(nowMs: number): string {
  const value = new Date(nowMs);
  if (!Number.isSafeInteger(nowMs) || !Number.isFinite(value.getTime())) {
    throw new AppError(500, "INTERNAL_ERROR", "Authenticator management clock is inconsistent");
  }
  return value.toISOString();
}

function etag(record: PasskeyAuthenticatorRecord): string {
  return `"passkey-authenticator:${record.credentialRecordId}:rev:${record.revision}"`;
}

function publicAuthenticator(record: PasskeyAuthenticatorRecord): PasskeyAuthenticatorPublic {
  return PasskeyAuthenticatorMutationResponseSchema.shape.authenticator.parse({
    id: record.credentialRecordId,
    displayName: record.displayName,
    state: record.lifecycleState,
    revision: record.revision,
    etag: etag(record),
    createdAt: timestamp(record.createdAtMs),
    updatedAt: timestamp(record.updatedAtMs),
    revokedAt: record.revokedAtMs === null ? null : timestamp(record.revokedAtMs)
  });
}

function targetBinding(
  principal: AuthenticatedPrincipal,
  credentialRecordId: string,
  expectedRevision: number
): StepUpTokenBinding {
  return Object.freeze({
    accountId: principal.userId,
    sessionId: principal.sessionId,
    ceremonyId: "pending",
    purpose: PASSKEY_AUTHENTICATOR_REVOKE_PURPOSE,
    targetDigest: passkeyAuthenticatorRevokeTargetDigest({
      accountId: principal.userId,
      sessionId: principal.sessionId,
      credentialRecordId,
      expectedRevision
    })
  });
}

function requirePrincipal(principal: AuthenticatedPrincipal): void {
  if (
    principal === null
    || typeof principal !== "object"
    || IdSchema.safeParse(principal.userId).success === false
    || IdSchema.safeParse(principal.sessionId).success === false
  ) throw forbidden("Authentication required");
}

function mapStoreMutationError(error: unknown): never {
  if (error instanceof StoreDuplicateCommandError) {
    throw conflict("Authenticator command id was reused");
  }
  if (
    error instanceof StoreCredentialStateConflictError
    || error instanceof StoreRevisionConflictError
  ) {
    throw conflict("Authenticator state changed");
  }
  if (error instanceof StoreAuthorizationConflictError) {
    throw forbidden("Fresh authenticator-bound step-up is required", { reason: "step_up_required" });
  }
  throw error;
}

function assertGrantBinding(
  grant: PasskeyAuthenticatorStepUpGrantRecord | null,
  principal: AuthenticatedPrincipal,
  ceremonyId: string,
  credentialRecordId: string,
  expectedRevision: number,
  targetDigest: string
): PasskeyAuthenticatorStepUpGrantRecord {
  if (
    grant === null
    || grant.authenticationCeremonyId !== ceremonyId
    || grant.accountId !== principal.userId
    || grant.sessionId !== principal.sessionId
    || grant.deviceId !== principal.sessionId
    || grant.credentialRecordId !== credentialRecordId
    || grant.expectedAuthenticatorRevision !== expectedRevision
    || grant.purpose !== PASSKEY_AUTHENTICATOR_REVOKE_PURPOSE
    || grant.targetDigest !== targetDigest
    || grant.authTimeSec !== grant.issuedAtSec
    || grant.expiresAtSec <= grant.issuedAtSec
    || grant.expiresAtSec - grant.issuedAtSec > 300
  ) throw forbidden("Fresh authenticator-bound step-up is required", { reason: "step_up_required" });
  return grant;
}

export class PasskeyAuthenticatorManagementService {
  readonly #store: Store;
  readonly #tokens: PasskeyAuthenticatorManagementTokenAuthority;
  readonly #clock: () => Date;
  readonly #onSessionsRevoked: ((sessionIds: readonly string[]) => void | Promise<void>) | null;
  readonly #onSessionRevocationCleanupFailure: ((
    error: unknown,
    sessionIds: readonly string[]
  ) => void | Promise<void>) | null;

  constructor(options: PasskeyAuthenticatorManagementServiceOptions) {
    this.#store = options.store;
    this.#tokens = options.stepUpTokens;
    this.#clock = options.clock ?? (() => new Date());
    if (
      options.onSessionsRevoked !== undefined
      && options.onSessionRevocationCleanupFailure === undefined
    ) {
      throw new Error("Session revocation cleanup requires an explicit failure reporter");
    }
    this.#onSessionsRevoked = options.onSessionsRevoked ?? null;
    this.#onSessionRevocationCleanupFailure = options.onSessionRevocationCleanupFailure ?? null;
  }

  #assertActivePrincipalSession(principal: AuthenticatedPrincipal): void {
    const nowMs = this.#clock().getTime();
    const now = timestamp(nowMs);
    if (!this.#store.isSessionActive(principal.sessionId, principal.userId, now)) {
      throw forbidden("Authentication required");
    }
  }

  async list(principal: AuthenticatedPrincipal): Promise<PasskeyAuthenticatorListResponse> {
    requirePrincipal(principal);
    this.#assertActivePrincipalSession(principal);
    const records = await this.#store.listPasskeyAuthenticatorsByAccountId(principal.userId);
    return PasskeyAuthenticatorListResponseSchema.parse({
      schemaVersion: 1,
      authenticators: records.map(publicAuthenticator)
    });
  }

  async rename(
    principal: AuthenticatedPrincipal,
    untrusted: unknown
  ): Promise<PasskeyAuthenticatorMutationResponse> {
    requirePrincipal(principal);
    this.#assertActivePrincipalSession(principal);
    const input = exactInput(untrusted, [
      "commandId",
      "credentialRecordId",
      "displayName",
      "expectedRevision"
    ]);
    const commandId = IdSchema.safeParse(input["commandId"]);
    const credentialRecordId = IdSchema.safeParse(input["credentialRecordId"]);
    const displayName = typeof input["displayName"] === "string"
      ? input["displayName"].trim().normalize("NFC")
      : input["displayName"];
    const parsedDisplayName = PasskeyAuthenticatorDisplayNameSchema.safeParse(displayName);
    const expectedRevision = input["expectedRevision"];
    if (
      !commandId.success
      || !credentialRecordId.success
      || !parsedDisplayName.success
      || !Number.isSafeInteger(expectedRevision)
      || (expectedRevision as number) < 1
    ) throw badRequest("Invalid authenticator management request");
    const scope = commandScope(principal.userId, commandId.data);
    const fingerprint = passkeyAuthenticatorRenameFingerprint({
      accountId: principal.userId,
      sessionId: principal.sessionId,
      credentialRecordId: credentialRecordId.data,
      expectedRevision: expectedRevision as number,
      displayName: parsedDisplayName.data
    });
    const occurredAtMs = this.#clock().getTime();
    timestamp(occurredAtMs);
    try {
      const result = await this.#store.commitPasskeyAuthenticatorRename({
        operation: "rename",
        accountId: principal.userId,
        sessionId: principal.sessionId,
        credentialRecordId: credentialRecordId.data,
        commandScope: scope,
        fingerprint,
        expectedRevision: expectedRevision as number,
        displayName: parsedDisplayName.data,
        occurredAtMs,
        eventId: randomUUID(),
        outboxId: randomUUID()
      });
      return PasskeyAuthenticatorMutationResponseSchema.parse({
        schemaVersion: 1,
        authenticator: publicAuthenticator(result.authenticator),
        replayed: result.replayed
      });
    } catch (error) {
      mapStoreMutationError(error);
    }
  }

  /**
   * Reconstructs the deterministic authorization returned by a previously
   * verified, durable target-bound WebAuthn ceremony while its grant is fresh.
   */
  async issueRevokeAuthorization(
    principal: AuthenticatedPrincipal,
    untrusted: unknown
  ): Promise<PasskeyAuthenticatorRevokeAuthorization> {
    requirePrincipal(principal);
    this.#assertActivePrincipalSession(principal);
    const input = exactInput(untrusted, [
      "authenticationCeremonyId",
      "credentialRecordId",
      "expectedRevision"
    ]);
    const ceremonyId = IdSchema.safeParse(input["authenticationCeremonyId"]);
    const credentialRecordId = IdSchema.safeParse(input["credentialRecordId"]);
    const expectedRevision = input["expectedRevision"];
    if (
      !ceremonyId.success
      || !credentialRecordId.success
      || !Number.isSafeInteger(expectedRevision)
      || (expectedRevision as number) < 1
    ) throw badRequest("Invalid authenticator management request");
    const binding = targetBinding(
      principal,
      credentialRecordId.data,
      expectedRevision as number
    );
    const grant = assertGrantBinding(
      await this.#store.findPasskeyAuthenticatorStepUpGrant(ceremonyId.data),
      principal,
      ceremonyId.data,
      credentialRecordId.data,
      expectedRevision as number,
      binding.targetDigest
    );
    const intent = await this.#store.findPasskeyAuthenticatorRevokeIntent(ceremonyId.data);
    const authenticator = await this.#store.findPasskeyAuthenticatorByRecordId(
      principal.userId,
      credentialRecordId.data
    );
    const nowMs = this.#clock().getTime();
    timestamp(nowMs);
    const nowSec = Math.floor(nowMs / 1_000);
    if (
      intent === null
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
      || nowSec < grant.issuedAtSec
      || nowSec >= grant.expiresAtSec
      || authenticator === null
      || authenticator.lifecycleState !== "active"
      || authenticator.revision !== grant.expectedAuthenticatorRevision
    ) throw forbidden("Fresh authenticator-bound step-up is required", {
      reason: "step_up_required"
    });
    let token: string;
    try {
      token = PasskeyStepUpTokenSchema.parse(await this.#tokens.issue({
        accountId: grant.accountId,
        sessionId: grant.sessionId,
        ceremonyId: grant.authenticationCeremonyId,
        purpose: grant.purpose,
        targetDigest: grant.targetDigest,
        issuedAt: grant.issuedAtSec,
        expiresAt: grant.expiresAtSec
      }));
    } catch {
      throw serviceUnavailable("Authenticator authorization is temporarily unavailable");
    }
    return PasskeyAuthenticatorRevokeAuthorizationSchema.parse({
      scheme: "Bearer",
      token,
      purpose: PASSKEY_AUTHENTICATOR_REVOKE_PURPOSE,
      expiresAt: timestamp(grant.expiresAtSec * 1_000)
    });
  }

  async revoke(
    principal: AuthenticatedPrincipal,
    untrusted: unknown
  ): Promise<PasskeyAuthenticatorMutationResponse> {
    requirePrincipal(principal);
    this.#assertActivePrincipalSession(principal);
    const input = exactInput(untrusted, [
      "authenticationCeremonyId",
      "commandId",
      "credentialRecordId",
      "expectedRevision",
      "stepUpToken"
    ]);
    const ceremonyId = IdSchema.safeParse(input["authenticationCeremonyId"]);
    const commandId = IdSchema.safeParse(input["commandId"]);
    const credentialRecordId = IdSchema.safeParse(input["credentialRecordId"]);
    const token = PasskeyStepUpTokenSchema.safeParse(input["stepUpToken"]);
    const expectedRevision = input["expectedRevision"];
    if (
      !ceremonyId.success
      || !commandId.success
      || !credentialRecordId.success
      || !token.success
      || !Number.isSafeInteger(expectedRevision)
      || (expectedRevision as number) < 1
    ) throw forbidden("Fresh authenticator-bound step-up is required", { reason: "step_up_required" });

    const scope = commandScope(principal.userId, commandId.data);
    const targetDigest = passkeyAuthenticatorRevokeTargetDigest({
      accountId: principal.userId,
      sessionId: principal.sessionId,
      credentialRecordId: credentialRecordId.data,
      expectedRevision: expectedRevision as number
    });
    const fingerprint = passkeyAuthenticatorRevokeFingerprint({
      accountId: principal.userId,
      sessionId: principal.sessionId,
      credentialRecordId: credentialRecordId.data,
      expectedRevision: expectedRevision as number,
      authenticationCeremonyId: ceremonyId.data
    });

    const receipt = await this.#store.findPasskeyAuthenticatorCommandReceipt(scope);
    if (receipt !== null) {
      if (
        receipt.fingerprint !== fingerprint
        || receipt.accountId !== principal.userId
        || receipt.credentialRecordId !== credentialRecordId.data
      ) throw conflict("Authenticator command id was reused");
      const grant = assertGrantBinding(
        await this.#store.findPasskeyAuthenticatorStepUpGrant(ceremonyId.data),
        principal,
        ceremonyId.data,
        credentialRecordId.data,
        expectedRevision as number,
        targetDigest
      );
      if (
        grant.consumedAtSec === null
        || grant.managementCommandScope !== scope
      ) throw forbidden("Fresh authenticator-bound step-up is required", { reason: "step_up_required" });
      try {
        await this.#tokens.verifyCommittedReplay(token.data, {
          accountId: grant.accountId,
          sessionId: grant.sessionId,
          ceremonyId: grant.authenticationCeremonyId,
          purpose: grant.purpose,
          targetDigest: grant.targetDigest,
          issuedAt: grant.issuedAtSec,
          expiresAt: grant.expiresAtSec
        });
      } catch (error) {
        if (error instanceof InvalidStepUpTokenError) {
          throw forbidden("Fresh authenticator-bound step-up is required", {
            reason: "step_up_required"
          });
        }
        if (error instanceof InvalidStepUpTokenInputError) {
          throw new AppError(500, "INTERNAL_ERROR", "Authenticator authorization is inconsistent");
        }
        throw serviceUnavailable("Authenticator authorization is temporarily unavailable");
      }
      return PasskeyAuthenticatorMutationResponseSchema.parse({
        schemaVersion: 1,
        authenticator: publicAuthenticator(receipt.result),
        replayed: true
      });
    }

    const grant = assertGrantBinding(
      await this.#store.findPasskeyAuthenticatorStepUpGrant(ceremonyId.data),
      principal,
      ceremonyId.data,
      credentialRecordId.data,
      expectedRevision as number,
      targetDigest
    );
    let verified: VerifiedStepUpTokenClaims;
    try {
      verified = await this.#tokens.verify(token.data, {
        accountId: principal.userId,
        sessionId: principal.sessionId,
        ceremonyId: ceremonyId.data,
        purpose: PASSKEY_AUTHENTICATOR_REVOKE_PURPOSE,
        targetDigest
      });
    } catch (error) {
      if (error instanceof InvalidStepUpTokenError) {
        throw forbidden("Fresh authenticator-bound step-up is required", {
          reason: "step_up_required"
        });
      }
      if (error instanceof InvalidStepUpTokenInputError) {
        throw new AppError(500, "INTERNAL_ERROR", "Authenticator authorization is inconsistent");
      }
      throw serviceUnavailable("Authenticator authorization is temporarily unavailable");
    }
    if (verified.purpose !== PASSKEY_AUTHENTICATOR_REVOKE_PURPOSE) {
      throw forbidden("Fresh authenticator-bound step-up is required", { reason: "step_up_required" });
    }

    const occurredAtMs = this.#clock().getTime();
    timestamp(occurredAtMs);
    try {
      const result = await this.#store.commitPasskeyAuthenticatorRevoke({
        operation: "revoke",
        accountId: principal.userId,
        sessionId: principal.sessionId,
        credentialRecordId: credentialRecordId.data,
        commandScope: scope,
        fingerprint,
        expectedRevision: expectedRevision as number,
        occurredAtMs,
        eventId: randomUUID(),
        outboxId: randomUUID(),
        authorization: {
          sub: verified.sub,
          sid: verified.sid,
          ceremony_id: verified.ceremony_id,
          jti: verified.jti,
          purpose: PASSKEY_AUTHENTICATOR_REVOKE_PURPOSE,
          target_digest: verified.target_digest,
          auth_time: verified.auth_time,
          iat: verified.iat,
          exp: verified.exp
        }
      });
      if (
        !result.replayed
        && result.revokedSessionIds.length > 0
        && this.#onSessionsRevoked !== null
      ) {
        try {
          await this.#onSessionsRevoked(result.revokedSessionIds);
        } catch (cleanupError) {
          // The durable revoke and its outbox record stay authoritative. The
          // reporter is mandatory whenever a live cleanup hook is configured,
          // so transport failure is observable without rewriting success.
          try {
            await this.#onSessionRevocationCleanupFailure?.(
              cleanupError,
              result.revokedSessionIds
            );
          } catch {
            // The append-only management outbox remains the retry evidence.
          }
        }
      }
      return PasskeyAuthenticatorMutationResponseSchema.parse({
        schemaVersion: 1,
        authenticator: publicAuthenticator(result.authenticator),
        replayed: result.replayed
      });
    } catch (error) {
      mapStoreMutationError(error);
    }
  }
}
