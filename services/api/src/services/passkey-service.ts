import { createHash, randomUUID } from "node:crypto";
import {
  createLuxoraPasskeyPolicy,
  LUXORA_PASSKEY_PRODUCTION_ORIGIN,
  PASSKEY_DOMAIN_VERSION,
  PasskeyCeremonyExecutor,
  PasskeyDomainError,
  type BeginRegistrationCommand,
  type PasskeyCeremonyStore,
  type ExecutedCeremonyCommand,
  type IdGenerator,
  type MaintainedWebAuthnVerifierAdapter,
  type PersistCeremonyMutation
} from "@luxora/passkey-domain";
import {
  BeginPasskeyAuthenticatorRevokeStepUpRequestSchema,
  PasskeyCeremonyVerifyResponseSchema,
  PasskeyAuthenticatorRevokeStepUpBeginResponseSchema,
  PasskeyIdempotencyKeySchema,
  PasskeyRegistrationBeginResponseSchema,
  PasskeyStepUpBeginResponseSchema,
  PasskeyStepUpTokenSchema,
  type PasskeyCeremonyVerifyResponse,
  type PasskeyAuthenticatorRevokeStepUpBeginResponse,
  type PasskeyRegistrationBeginResponse,
  type PasskeyStepUpBeginResponse
} from "@luxora/protocol";
import type { Store } from "../domain/store.js";
import type {
  AuthenticatedPrincipal,
  PasskeyAuthenticatorRevokeIntentRecord,
  PasskeyStepUpGrantRecord,
  PasskeyStepUpClaimsProjection,
  PasskeyUserHandleBinding
} from "../domain/types.js";
import {
  AppError,
  badRequest,
  conflict,
  forbidden,
  notFound,
  serviceUnavailable
} from "../errors.js";
import {
  PasskeyVerifierUnavailableError,
  SimpleWebAuthnVerifierAdapter,
  type AuthenticationOptionsInput,
  type RegistrationOptionsInput
} from "../passkeys/simplewebauthn-adapter.js";
import { StorePasskeyCredentialRepository } from "../passkeys/store-passkey-repository.js";
import {
  PASSKEY_AUTHENTICATOR_REVOKE_PURPOSE,
  passkeyAuthenticatorRevokeTargetDigest
} from "../passkeys/authenticator-management-binding.js";
import {
  InvalidStepUpTokenInputError,
  InvalidStepUpTokenError,
  STEP_UP_TOKEN_MAX_TTL_SECONDS,
  type StepUpTokenBinding,
  type StepUpTokenIssueInput,
  type VerifiedStepUpTokenClaims
} from "../passkeys/step-up-token.js";
import type { ParsedPasskeyResponseBody } from "../http/passkey-response-body.js";

const PASSKEY_RP_NAME = "Luxora" as const;
const AUTHENTICATOR_ADD_OPERATION = "authenticator.add" as const;

type PasskeyOptionsAdapter = MaintainedWebAuthnVerifierAdapter & {
  createRegistrationOptions(input: RegistrationOptionsInput): ReturnType<SimpleWebAuthnVerifierAdapter["createRegistrationOptions"]>;
  createAuthenticationOptions(input: AuthenticationOptionsInput): ReturnType<SimpleWebAuthnVerifierAdapter["createAuthenticationOptions"]>;
};

type ConsumedPasskeyStepUpGrant = PasskeyStepUpGrantRecord & {
  readonly consumedAtSec: number;
  readonly registrationCeremonyId: string;
};

export interface PasskeyStepUpTokenAuthority {
  issue(input: StepUpTokenIssueInput): Promise<string>;
  verify(token: string, expected: StepUpTokenBinding): Promise<VerifiedStepUpTokenClaims>;
  verifyCommittedReplay(token: string, durableIssueInput: StepUpTokenIssueInput): Promise<void>;
}

function canonicalTargetDigest(value: Record<string, string>): string {
  const canonical = Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${JSON.stringify(value[key])}`).join(",");
  return createHash("sha256").update(`{${canonical}}`, "utf8").digest("hex");
}

function actor(principal: AuthenticatedPrincipal) {
  return Object.freeze({
    accountId: principal.userId,
    sessionId: principal.sessionId,
    // CURRENT device_sessions are endpoint sessions, not proof of one physical
    // device. Keep this binding session-scoped until a separate device endpoint
    // identity and proof key exist; never present it as hardware provenance.
    deviceId: principal.sessionId
  });
}

function publicCeremony(executed: ExecutedCeremonyCommand) {
  return {
    id: executed.snapshot.ceremonyId,
    kind: executed.snapshot.kind,
    purpose: executed.snapshot.purpose.type,
    state: executed.snapshot.state,
    revision: executed.snapshot.revision,
    expiresAt: new Date(executed.snapshot.expiresAtMs).toISOString()
  };
}

function parseTrustedPasskeyResponse<T>(parse: () => T): T {
  try {
    return parse();
  } catch {
    throw new AppError(500, "INTERNAL_ERROR", "Passkey response could not be encoded");
  }
}

function mapDomainError(error: PasskeyDomainError): AppError {
  const safeState = error.currentState === null ? {} : {
    state: error.currentState.state,
    revision: error.currentState.revision
  };
  switch (error.code) {
    case "VALIDATION_FAILED":
      return badRequest("Invalid passkey ceremony command");
    case "NOT_FOUND":
      return notFound("Passkey ceremony not found");
    case "FORBIDDEN":
      return forbidden("Step-up authentication required", { reason: "step_up_required" });
    case "REVISION_CONFLICT":
    case "IDEMPOTENCY_KEY_REUSED":
    case "CREATION_NONCE_REUSED":
    case "COMMAND_NOT_ALLOWED":
    case "TERMINAL_CEREMONY":
    case "CREDENTIAL_CONFLICT":
    case "CREDENTIAL_STATE_CONFLICT":
      return conflict("Passkey ceremony conflict", { reason: "ceremony_conflict", ...safeState });
    case "CHALLENGE_UNAVAILABLE":
    case "CHALLENGE_INTEGRITY_FAILED":
      return conflict("Passkey challenge is unavailable", { reason: "challenge_expired", ...safeState });
    case "VERIFIER_UNAVAILABLE":
    case "STORAGE_UNAVAILABLE":
      return serviceUnavailable("Passkey verification is temporarily unavailable");
    case "STORAGE_INTEGRITY_FAILED":
      return new AppError(500, "INTERNAL_ERROR", "Passkey storage integrity check failed");
  }
}

export interface PasskeyServiceOptions {
  readonly expectedOrigin?: string;
  readonly adapter?: PasskeyOptionsAdapter;
  readonly ids?: IdGenerator;
  readonly nowMs?: () => number;
  /** Omit to keep registration and step-up token issuance fail-closed. */
  readonly stepUpTokens?: PasskeyStepUpTokenAuthority;
}

/**
 * Server-only passkey ceremony integration. Merely constructing this service
 * does not enable the public capability or register routes. Registration is
 * fail-closed until a short-lived token authority and the Store's atomic,
 * one-time, target-bound grant consumption are both supplied.
 */
export class PasskeyService {
  readonly #store: Store;
  readonly #adapter: PasskeyOptionsAdapter;
  readonly #executor: PasskeyCeremonyExecutor;
  readonly #policy: ReturnType<typeof createLuxoraPasskeyPolicy>;
  readonly #expectedOrigin: string;
  readonly #stepUpTokens: PasskeyStepUpTokenAuthority | null;
  readonly #clock: { readonly nowMs: () => number };
  readonly #ids: IdGenerator;

  constructor(store: Store, options: PasskeyServiceOptions = {}) {
    this.#store = store;
    this.#expectedOrigin = options.expectedOrigin ?? LUXORA_PASSKEY_PRODUCTION_ORIGIN;
    this.#policy = createLuxoraPasskeyPolicy({ allowedOrigins: [this.#expectedOrigin] });
    const repository = new StorePasskeyCredentialRepository(store);
    this.#adapter = options.adapter ?? new SimpleWebAuthnVerifierAdapter(repository);
    this.#clock = { nowMs: options.nowMs ?? Date.now };
    this.#ids = options.ids ?? { next: () => randomUUID() };
    this.#executor = this.#createExecutor(store);
    this.#stepUpTokens = options.stepUpTokens ?? null;
  }

  #createExecutor(store: PasskeyCeremonyStore): PasskeyCeremonyExecutor {
    return new PasskeyCeremonyExecutor({
      store,
      challengeVault: this.#store,
      verifier: this.#adapter,
      policy: this.#policy,
      clock: this.#clock,
      ids: this.#ids
    });
  }

  #authorizedRegistrationStore(
    claims: PasskeyStepUpClaimsProjection,
    userHandleBinding: PasskeyUserHandleBinding
  ): PasskeyCeremonyStore {
    return Object.freeze({
      loadCeremony: (ceremonyId: string) => this.#store.loadCeremony(ceremonyId),
      findCommandReceipt: (scope: string) => this.#store.findCommandReceipt(scope),
      findCreationReceipt: (scope: string) => this.#store.findCreationReceipt(scope),
      commit: (input: PersistCeremonyMutation) => this.#store.commitInitialPasskeyRegistration(
        input,
        claims,
        userHandleBinding
      )
    });
  }

  #authenticatorRevokeStore(input: {
    readonly accountId: string;
    readonly sessionId: string;
    readonly credentialRecordId: string;
    readonly expectedRevision: number;
    readonly targetDigest: string;
  }): PasskeyCeremonyStore {
    return Object.freeze({
      loadCeremony: (ceremonyId: string) => this.#store.loadCeremony(ceremonyId),
      findCommandReceipt: (scope: string) => this.#store.findCommandReceipt(scope),
      findCreationReceipt: (scope: string) => this.#store.findCreationReceipt(scope),
      commit: (mutation: PersistCeremonyMutation) =>
        this.#store.commitPasskeyAuthenticatorRevokeBegin(mutation, Object.freeze({
          authenticationCeremonyId: mutation.mutation.snapshot.ceremonyId,
          accountId: input.accountId,
          sessionId: input.sessionId,
          deviceId: input.sessionId,
          credentialRecordId: input.credentialRecordId,
          expectedAuthenticatorRevision: input.expectedRevision,
          purpose: PASSKEY_AUTHENTICATOR_REVOKE_PURPOSE,
          targetDigest: input.targetDigest,
          createdAtMs: mutation.mutation.snapshot.createdAtMs
        }))
    });
  }

  #assertRevokeIntent(
    intent: PasskeyAuthenticatorRevokeIntentRecord | null,
    expected: {
      readonly ceremonyId: string;
      readonly accountId: string;
      readonly sessionId: string;
      readonly credentialRecordId: string;
      readonly expectedRevision: number;
      readonly targetDigest: string;
    }
  ): PasskeyAuthenticatorRevokeIntentRecord {
    if (
      intent === null
      || intent.authenticationCeremonyId !== expected.ceremonyId
      || intent.accountId !== expected.accountId
      || intent.sessionId !== expected.sessionId
      || intent.deviceId !== expected.sessionId
      || intent.credentialRecordId !== expected.credentialRecordId
      || intent.expectedAuthenticatorRevision !== expected.expectedRevision
      || intent.purpose !== PASSKEY_AUTHENTICATOR_REVOKE_PURPOSE
      || intent.targetDigest !== expected.targetDigest
    ) throw new AppError(500, "INTERNAL_ERROR", "Authenticator revoke intent is inconsistent");
    return intent;
  }

  #registrationCommand(
    principal: AuthenticatedPrincipal,
    input: {
      readonly commandId: string;
      readonly clientNonce: string;
    },
    targetDigest: string,
    userHandleRef: string
  ): BeginRegistrationCommand {
    return Object.freeze({
      schemaVersion: PASSKEY_DOMAIN_VERSION,
      type: "begin_registration",
      commandId: input.commandId,
      clientNonce: input.clientNonce,
      actor: actor(principal),
      expectedRevision: 0,
      purpose: { type: AUTHENTICATOR_ADD_OPERATION, targetDigest },
      expectedOrigin: this.#expectedOrigin,
      credentialBoundary: { mode: "discoverable" as const, credentialSetRef: null },
      userHandleRef
    });
  }

  #currentTimeIso(): string {
    const nowMs = this.#clock.nowMs();
    const now = new Date(nowMs);
    if (!Number.isSafeInteger(nowMs) || !Number.isFinite(now.getTime())) {
      throw new AppError(500, "INTERNAL_ERROR", "Passkey service clock is inconsistent");
    }
    return now.toISOString();
  }

  async #authorizeCommittedGrantReplay(
    principal: AuthenticatedPrincipal,
    input: {
      readonly stepUpCeremonyId: string;
      readonly stepUpToken: string;
    },
    targetDigest: string
  ): Promise<ConsumedPasskeyStepUpGrant> {
    const authority = this.#stepUpTokens;
    if (authority === null) {
      throw forbidden("Step-up authentication required", { reason: "step_up_required" });
    }
    const grant = await this.#store.findPasskeyStepUpGrant(input.stepUpCeremonyId);
    if (
      grant === null
      || grant.authenticationCeremonyId !== input.stepUpCeremonyId
      || grant.accountId !== principal.userId
      || grant.sessionId !== principal.sessionId
      || grant.deviceId !== principal.sessionId
      || grant.purpose !== AUTHENTICATOR_ADD_OPERATION
      || grant.targetDigest !== targetDigest
      || !Number.isSafeInteger(grant.authTimeSec)
      || !Number.isSafeInteger(grant.issuedAtSec)
      || !Number.isSafeInteger(grant.expiresAtSec)
      || grant.consumedAtSec === null
      || grant.registrationCeremonyId === null
      || !Number.isSafeInteger(grant.consumedAtSec)
      || grant.authTimeSec !== grant.issuedAtSec
      || grant.expiresAtSec <= grant.issuedAtSec
      || grant.expiresAtSec - grant.issuedAtSec > STEP_UP_TOKEN_MAX_TTL_SECONDS
      || grant.consumedAtSec < grant.issuedAtSec
      || grant.consumedAtSec >= grant.expiresAtSec
      || !this.#store.isSessionActive(
        principal.sessionId,
        principal.userId,
        this.#currentTimeIso()
      )
    ) {
      throw forbidden("Step-up authentication required", { reason: "step_up_required" });
    }

    try {
      await authority.verifyCommittedReplay(input.stepUpToken, {
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
        throw forbidden("Step-up authentication required", { reason: "step_up_required" });
      }
      if (error instanceof InvalidStepUpTokenInputError) {
        throw new AppError(500, "INTERNAL_ERROR", "Step-up authorization record is inconsistent");
      }
      throw serviceUnavailable("Step-up authorization is temporarily unavailable");
    }
    return Object.freeze({
      ...grant,
      consumedAtSec: grant.consumedAtSec,
      registrationCeremonyId: grant.registrationCeremonyId
    });
  }

  async #authorizeCommittedRegistrationReplay(
    principal: AuthenticatedPrincipal,
    input: {
      readonly stepUpCeremonyId: string;
      readonly stepUpToken: string;
    },
    targetDigest: string,
    executed: ExecutedCeremonyCommand
  ): Promise<void> {
    const grant = await this.#authorizeCommittedGrantReplay(principal, input, targetDigest);
    const snapshot = executed.snapshot;
    const registrationCreatedAtSec = Math.floor(snapshot.createdAtMs / 1_000);
    if (
      !executed.replayed
      || snapshot.kind !== "registration"
      || snapshot.actor.accountId !== principal.userId
      || snapshot.actor.sessionId !== principal.sessionId
      || snapshot.actor.deviceId !== principal.sessionId
      || snapshot.purpose.type !== AUTHENTICATOR_ADD_OPERATION
      || snapshot.purpose.targetDigest !== targetDigest
      || grant.accountId !== snapshot.actor.accountId
      || grant.sessionId !== snapshot.actor.sessionId
      || grant.deviceId !== snapshot.actor.deviceId
      || grant.purpose !== snapshot.purpose.type
      || grant.targetDigest !== snapshot.purpose.targetDigest
      || !Number.isSafeInteger(registrationCreatedAtSec)
      || grant.consumedAtSec < registrationCreatedAtSec
      || registrationCreatedAtSec < grant.issuedAtSec
      || registrationCreatedAtSec >= grant.expiresAtSec
      || grant.registrationCeremonyId !== snapshot.ceremonyId
    ) {
      throw forbidden("Step-up authentication required", { reason: "step_up_required" });
    }
  }

  async beginRegistration(
    principal: AuthenticatedPrincipal,
    input: {
      readonly commandId: string;
      readonly clientNonce: string;
      readonly stepUpCeremonyId: string;
      readonly stepUpToken: string;
    }
  ): Promise<PasskeyRegistrationBeginResponse> {
    const targetDigest = canonicalTargetDigest({
      accountId: principal.userId,
      operation: AUTHENTICATOR_ADD_OPERATION,
      sessionId: principal.sessionId
    });
    const authority = this.#stepUpTokens;
    if (authority === null) {
      throw forbidden("Step-up authentication required", { reason: "step_up_required" });
    }
    const user = this.#store.findUserById(principal.userId);
    if (user === null) throw notFound("Account not found");

    // An expired token is useful only as the exact byte representation of an
    // already-committed begin. This read-only preflight deliberately requires
    // both the durable handle and the actor-scoped command receipt; it never
    // consults the broader clientNonce creation receipt.
    const durableHandle = await this.#store.findPasskeyUserHandleByAccountId(principal.userId);
    const durableGrant = await this.#store.findPasskeyStepUpGrant(input.stepUpCeremonyId);
    let executed: ExecutedCeremonyCommand | null = null;
    if (
      durableHandle !== null
      && durableGrant !== null
      && durableGrant.consumedAtSec !== null
      && durableGrant.registrationCeremonyId !== null
    ) {
      // Authenticate the exact durable token/grant before command or ceremony
      // state can influence the externally visible result.
      await this.#authorizeCommittedGrantReplay(principal, input, targetDigest);
      try {
        executed = await this.#executor.replayBeginExact(this.#registrationCommand(
          principal,
          input,
          targetDigest,
          durableHandle.reference
        ));
      } catch (error) {
        // Recheck after the domain read so a concurrent session revocation or
        // grant cascade cannot turn a domain error into a state oracle.
        await this.#authorizeCommittedGrantReplay(principal, input, targetDigest);
        if (error instanceof PasskeyDomainError) throw mapDomainError(error);
        throw error;
      }
      if (executed !== null) {
        await this.#authorizeCommittedRegistrationReplay(principal, input, targetDigest, executed);
      }
    }

    if (executed === null) {
      let verifiedClaims: VerifiedStepUpTokenClaims;
      try {
        verifiedClaims = await authority.verify(input.stepUpToken, {
          accountId: principal.userId,
          sessionId: principal.sessionId,
          ceremonyId: input.stepUpCeremonyId,
          purpose: AUTHENTICATOR_ADD_OPERATION,
          targetDigest
        });
      } catch (error) {
        if (error instanceof InvalidStepUpTokenError) {
          throw forbidden("Step-up authentication required", { reason: "step_up_required" });
        }
        throw serviceUnavailable("Step-up authorization is temporarily unavailable");
      }
      // Pass only the exact repository projection. The raw token and public JWT
      // metadata never cross the durable-store boundary.
      const claims: PasskeyStepUpClaimsProjection = Object.freeze({
        sub: verifiedClaims.sub,
        sid: verifiedClaims.sid,
        ceremony_id: verifiedClaims.ceremony_id,
        jti: verifiedClaims.jti,
        purpose: AUTHENTICATOR_ADD_OPERATION,
        target_digest: verifiedClaims.target_digest,
        auth_time: verifiedClaims.auth_time,
        iat: verifiedClaims.iat,
        exp: verifiedClaims.exp
      });

      const preparedHandle = await this.#store.preparePasskeyUserHandleBinding(principal.userId);
      try {
        executed = await this.#createExecutor(
          this.#authorizedRegistrationStore(claims, preparedHandle)
        ).begin(this.#registrationCommand(
          principal,
          input,
          targetDigest,
          preparedHandle.reference
        ));
      } catch (error) {
        if (error instanceof PasskeyDomainError) throw mapDomainError(error);
        throw error;
      }
      if (executed.replayed) {
        // A concurrent winner may be reconciled by the executor after our
        // preflight miss. Prove that this request's exact grant/token authorized
        // that same durable ceremony before returning its client challenge.
        await this.#authorizeCommittedRegistrationReplay(principal, input, targetDigest, executed);
      }
    }
    const durableUserHandleRef = executed.snapshot.userHandleRef;
    if (durableUserHandleRef === null) {
      throw new AppError(500, "INTERNAL_ERROR", "Passkey user handle binding is inconsistent");
    }
    const handle = await this.#store.findPasskeyUserHandleByRef(durableUserHandleRef);
    if (handle === null || handle.accountId !== principal.userId) {
      throw new AppError(500, "INTERNAL_ERROR", "Passkey user handle binding is inconsistent");
    }
    const requirements = executed.clientRequirements;
    if (requirements?.kind !== "registration") {
      throw conflict("Passkey ceremony is no longer pending", {
        reason: "ceremony_conflict",
        state: executed.snapshot.state,
        revision: executed.snapshot.revision
      });
    }

    try {
      const options = await this.#adapter.createRegistrationOptions({
        rpName: PASSKEY_RP_NAME,
        userName: user.username,
        userDisplayName: user.displayName,
        expectedChallenge: requirements.challenge,
        expectedRpId: requirements.rpId,
        timeoutMs: requirements.timeoutMs,
        allowedAlgorithms: requirements.allowedAlgorithms,
        expectedAccountId: principal.userId,
        expectedUserHandleRef: handle.reference
      });
      return parseTrustedPasskeyResponse(() => PasskeyRegistrationBeginResponseSchema.parse({
        schemaVersion: 1,
        ceremony: publicCeremony(executed),
        replayed: executed.replayed,
        options
      }));
    } catch (error) {
      if (error instanceof PasskeyVerifierUnavailableError) {
        throw serviceUnavailable("Passkey options are temporarily unavailable");
      }
      throw error;
    }
  }

  async beginStepUp(
    principal: AuthenticatedPrincipal,
    input: {
      readonly commandId: string;
      readonly clientNonce: string;
      readonly operation: typeof AUTHENTICATOR_ADD_OPERATION;
    }
  ): Promise<PasskeyStepUpBeginResponse> {
    const credentials = await this.#store.listPasskeyCredentialsByAccountId(principal.userId);
    if (credentials.length === 0) {
      throw conflict("No phishing-resistant authenticator is available", { reason: "assurance_insufficient" });
    }
    const targetDigest = canonicalTargetDigest({
      accountId: principal.userId,
      operation: input.operation,
      sessionId: principal.sessionId
    });
    let executed: ExecutedCeremonyCommand;
    try {
      executed = await this.#executor.begin({
        schemaVersion: PASSKEY_DOMAIN_VERSION,
        type: "begin_authentication",
        commandId: input.commandId,
        clientNonce: input.clientNonce,
        actor: actor(principal),
        expectedRevision: 0,
        purpose: { type: "session.step_up", targetDigest },
        expectedOrigin: this.#expectedOrigin,
        credentialBoundary: { mode: "discoverable", credentialSetRef: null }
      });
    } catch (error) {
      if (error instanceof PasskeyDomainError) throw mapDomainError(error);
      throw error;
    }
    const requirements = executed.clientRequirements;
    if (requirements?.kind !== "authentication") {
      throw conflict("Passkey ceremony is no longer pending", {
        reason: "ceremony_conflict",
        state: executed.snapshot.state,
        revision: executed.snapshot.revision
      });
    }

    try {
      const options = await this.#adapter.createAuthenticationOptions({
        expectedChallenge: requirements.challenge,
        expectedRpId: requirements.rpId,
        timeoutMs: requirements.timeoutMs,
        allowedAlgorithms: this.#policy.allowedAlgorithms,
        expectedAccountId: principal.userId,
        credentialBoundary: { mode: "discoverable", credentialSetRef: null }
      });
      return parseTrustedPasskeyResponse(() => PasskeyStepUpBeginResponseSchema.parse({
        schemaVersion: 1,
        ceremony: publicCeremony(executed),
        replayed: executed.replayed,
        operation: input.operation,
        options: {
          ...options,
          allowCredentials: options.allowCredentials ?? []
        }
      }));
    } catch (error) {
      if (error instanceof PasskeyVerifierUnavailableError) {
        throw serviceUnavailable("Passkey options are temporarily unavailable");
      }
      throw error;
    }
  }

  async beginAuthenticatorRevokeStepUp(
    principal: AuthenticatedPrincipal,
    input: {
      readonly commandId: string;
      readonly clientNonce: string;
      readonly credentialRecordId: string;
      readonly expectedRevision: number;
    }
  ): Promise<PasskeyAuthenticatorRevokeStepUpBeginResponse> {
    const commandId = PasskeyIdempotencyKeySchema.safeParse(input.commandId);
    const request = BeginPasskeyAuthenticatorRevokeStepUpRequestSchema.safeParse({
      clientNonce: input.clientNonce,
      credentialRecordId: input.credentialRecordId,
      expectedRevision: input.expectedRevision
    });
    if (!commandId.success || !request.success) {
      throw badRequest("Invalid authenticator revoke step-up request");
    }
    if (!this.#store.isSessionActive(
      principal.sessionId,
      principal.userId,
      this.#currentTimeIso()
    )) throw forbidden("Authentication required");

    const target = await this.#store.findPasskeyAuthenticatorByRecordId(
      principal.userId,
      request.data.credentialRecordId
    );
    if (
      target === null
      || target.lifecycleState !== "active"
      || target.revision !== request.data.expectedRevision
    ) throw conflict("Authenticator state changed", { reason: "ceremony_conflict" });
    const credentials = await this.#store.listPasskeyCredentialsByAccountId(principal.userId);
    if (credentials.length === 0) {
      throw conflict("No phishing-resistant authenticator is available", {
        reason: "assurance_insufficient"
      });
    }

    const targetDigest = passkeyAuthenticatorRevokeTargetDigest({
      accountId: principal.userId,
      sessionId: principal.sessionId,
      credentialRecordId: request.data.credentialRecordId,
      expectedRevision: request.data.expectedRevision
    });
    const targetBinding = Object.freeze({
      accountId: principal.userId,
      sessionId: principal.sessionId,
      credentialRecordId: request.data.credentialRecordId,
      expectedRevision: request.data.expectedRevision,
      targetDigest
    });
    let executed: ExecutedCeremonyCommand;
    try {
      executed = await this.#createExecutor(this.#authenticatorRevokeStore(targetBinding)).begin({
        schemaVersion: PASSKEY_DOMAIN_VERSION,
        type: "begin_authentication",
        commandId: commandId.data,
        clientNonce: request.data.clientNonce,
        actor: actor(principal),
        expectedRevision: 0,
        purpose: { type: "session.step_up", targetDigest },
        expectedOrigin: this.#expectedOrigin,
        credentialBoundary: { mode: "discoverable", credentialSetRef: null }
      });
    } catch (error) {
      if (error instanceof PasskeyDomainError) throw mapDomainError(error);
      throw error;
    }
    this.#assertRevokeIntent(
      await this.#store.findPasskeyAuthenticatorRevokeIntent(executed.snapshot.ceremonyId),
      { ceremonyId: executed.snapshot.ceremonyId, ...targetBinding }
    );
    const requirements = executed.clientRequirements;
    if (requirements?.kind !== "authentication") {
      throw conflict("Passkey ceremony is no longer pending", {
        reason: "ceremony_conflict",
        state: executed.snapshot.state,
        revision: executed.snapshot.revision
      });
    }

    try {
      const options = await this.#adapter.createAuthenticationOptions({
        expectedChallenge: requirements.challenge,
        expectedRpId: requirements.rpId,
        timeoutMs: requirements.timeoutMs,
        allowedAlgorithms: this.#policy.allowedAlgorithms,
        expectedAccountId: principal.userId,
        credentialBoundary: { mode: "discoverable", credentialSetRef: null }
      });
      return parseTrustedPasskeyResponse(() =>
        PasskeyAuthenticatorRevokeStepUpBeginResponseSchema.parse({
          schemaVersion: 1,
          ceremony: publicCeremony(executed),
          replayed: executed.replayed,
          operation: PASSKEY_AUTHENTICATOR_REVOKE_PURPOSE,
          targetBinding,
          options: {
            ...options,
            allowCredentials: options.allowCredentials ?? []
          }
        })
      );
    } catch (error) {
      if (error instanceof PasskeyVerifierUnavailableError) {
        throw serviceUnavailable("Passkey options are temporarily unavailable");
      }
      throw error;
    }
  }

  async verify(
    principal: AuthenticatedPrincipal,
    input: {
      readonly ceremonyId: string;
      readonly commandId: string;
      readonly expectedRevision: number;
      readonly response: ParsedPasskeyResponseBody;
    }
  ): Promise<PasskeyCeremonyVerifyResponse> {
    let executed: ExecutedCeremonyCommand;
    try {
      executed = await this.#executor.verify({
        schemaVersion: PASSKEY_DOMAIN_VERSION,
        type: "verify",
        commandId: input.commandId,
        actor: actor(principal),
        expectedRevision: input.expectedRevision,
        ceremonyId: input.ceremonyId,
        responseByteLength: input.response.byteLength,
        responseDigest: input.response.digest
      }, input.response.credential);
    } catch (error) {
      if (error instanceof PasskeyDomainError) throw mapDomainError(error);
      throw error;
    }

    if (executed.snapshot.state !== "consumed") {
      const reason = executed.snapshot.state === "expired" ? "challenge_expired" : "verification_failed";
      throw new AppError(401, "UNAUTHENTICATED", "Passkey verification failed", {
        reason,
        state: executed.snapshot.state,
        revision: executed.snapshot.revision
      });
    }
    if (executed.snapshot.kind === "authentication") {
      if (this.#stepUpTokens === null) {
        throw serviceUnavailable("Step-up authorization is temporarily unavailable");
      }
      const revokeIntent = await this.#store.findPasskeyAuthenticatorRevokeIntent(
        executed.snapshot.ceremonyId
      );
      if (revokeIntent !== null) {
        this.#assertRevokeIntent(revokeIntent, {
          ceremonyId: executed.snapshot.ceremonyId,
          accountId: executed.snapshot.actor.accountId,
          sessionId: executed.snapshot.actor.sessionId,
          credentialRecordId: revokeIntent.credentialRecordId,
          expectedRevision: revokeIntent.expectedAuthenticatorRevision,
          targetDigest: executed.snapshot.purpose.targetDigest
        });
        const grant = await this.#store.findPasskeyAuthenticatorStepUpGrant(
          executed.snapshot.ceremonyId
        );
        if (
          grant === null
          || grant.authenticationCeremonyId !== revokeIntent.authenticationCeremonyId
          || grant.accountId !== principal.userId
          || grant.accountId !== revokeIntent.accountId
          || grant.sessionId !== principal.sessionId
          || grant.sessionId !== revokeIntent.sessionId
          || grant.deviceId !== principal.sessionId
          || grant.deviceId !== revokeIntent.deviceId
          || grant.credentialRecordId !== revokeIntent.credentialRecordId
          || grant.expectedAuthenticatorRevision !== revokeIntent.expectedAuthenticatorRevision
          || grant.purpose !== PASSKEY_AUTHENTICATOR_REVOKE_PURPOSE
          || grant.targetDigest !== revokeIntent.targetDigest
          || grant.authTimeSec !== grant.issuedAtSec
          || grant.expiresAtSec <= grant.issuedAtSec
          || grant.expiresAtSec - grant.issuedAtSec > STEP_UP_TOKEN_MAX_TTL_SECONDS
        ) {
          throw new AppError(500, "INTERNAL_ERROR", "Authenticator authorization record is inconsistent");
        }
        let token: string;
        try {
          token = PasskeyStepUpTokenSchema.parse(await this.#stepUpTokens.issue({
            accountId: grant.accountId,
            sessionId: grant.sessionId,
            ceremonyId: grant.authenticationCeremonyId,
            purpose: grant.purpose,
            targetDigest: grant.targetDigest,
            issuedAt: grant.issuedAtSec,
            expiresAt: grant.expiresAtSec
          }));
        } catch {
          throw new AppError(500, "INTERNAL_ERROR", "Authenticator authorization could not be issued");
        }
        const expiresAtMs = grant.expiresAtSec * 1_000;
        const expiresAt = new Date(expiresAtMs);
        if (!Number.isSafeInteger(expiresAtMs) || !Number.isFinite(expiresAt.getTime())) {
          throw new AppError(500, "INTERNAL_ERROR", "Authenticator authorization record is inconsistent");
        }
        return parseTrustedPasskeyResponse(() => PasskeyCeremonyVerifyResponseSchema.parse({
          schemaVersion: 1,
          ceremony: publicCeremony(executed),
          verified: true,
          replayed: executed.replayed,
          stepUpAuthorization: {
            scheme: "Bearer",
            token,
            purpose: PASSKEY_AUTHENTICATOR_REVOKE_PURPOSE,
            expiresAt: expiresAt.toISOString()
          }
        }));
      }
      const grant = await this.#store.findPasskeyStepUpGrant(executed.snapshot.ceremonyId);
      if (
        grant === null
        || grant.authenticationCeremonyId !== executed.snapshot.ceremonyId
        || grant.accountId !== principal.userId
        || grant.accountId !== executed.snapshot.actor.accountId
        || grant.sessionId !== principal.sessionId
        || grant.sessionId !== executed.snapshot.actor.sessionId
        || grant.deviceId !== principal.sessionId
        || grant.deviceId !== executed.snapshot.actor.deviceId
        || grant.purpose !== AUTHENTICATOR_ADD_OPERATION
        || grant.targetDigest !== executed.snapshot.purpose.targetDigest
        || grant.authTimeSec !== grant.issuedAtSec
        || grant.expiresAtSec <= grant.issuedAtSec
        || grant.expiresAtSec - grant.issuedAtSec > STEP_UP_TOKEN_MAX_TTL_SECONDS
      ) {
        throw new AppError(500, "INTERNAL_ERROR", "Step-up authorization record is inconsistent");
      }
      let token: string;
      try {
        token = PasskeyStepUpTokenSchema.parse(await this.#stepUpTokens.issue({
          accountId: grant.accountId,
          sessionId: grant.sessionId,
          ceremonyId: grant.authenticationCeremonyId,
          purpose: grant.purpose,
          targetDigest: grant.targetDigest,
          issuedAt: grant.issuedAtSec,
          expiresAt: grant.expiresAtSec
        }));
      } catch {
        throw new AppError(500, "INTERNAL_ERROR", "Step-up authorization could not be issued");
      }
      const expiresAtMs = grant.expiresAtSec * 1_000;
      const expiresAt = new Date(expiresAtMs);
      if (!Number.isSafeInteger(expiresAtMs) || !Number.isFinite(expiresAt.getTime())) {
        throw new AppError(500, "INTERNAL_ERROR", "Step-up authorization record is inconsistent");
      }
      return parseTrustedPasskeyResponse(() => PasskeyCeremonyVerifyResponseSchema.parse({
        schemaVersion: 1,
        ceremony: publicCeremony(executed),
        verified: true,
        replayed: executed.replayed,
        stepUpAuthorization: {
          scheme: "Bearer",
          token,
          purpose: AUTHENTICATOR_ADD_OPERATION,
          expiresAt: expiresAt.toISOString()
        }
      }));
    }
    return parseTrustedPasskeyResponse(() => PasskeyCeremonyVerifyResponseSchema.parse({
      schemaVersion: 1,
      ceremony: publicCeremony(executed),
      verified: true,
      replayed: executed.replayed
    }));
  }
}
