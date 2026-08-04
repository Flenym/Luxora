import { reject } from "./errors.js";
import {
  PASSKEY_DOMAIN_VERSION,
  type AuthenticationVerifierSuccess,
  type BeginCeremonyCommand,
  type CeremonyAggregate,
  type CeremonyDomainEvent,
  type CeremonyEventType,
  type CeremonyMutation,
  type CeremonyOutboxRecord,
  type ChallengeDescriptor,
  type IdGenerator,
  type PasskeyRelyingPartyPolicy,
  type RegistrationVerifierSuccess,
  type SafeCeremonyLogFields,
  type SecureCredentialEffect,
  type WebAuthnVerifierResult
} from "./types.js";
import {
  actorMatches,
  assertBeginCommand,
  assertCeremonyEventInvariants,
  assertCeremonyInvariants,
  assertInteger,
  assertOpaqueId,
  authenticationRiskSignals,
  normalizeAuthenticationCredential,
  normalizeCeremonySnapshot,
  normalizeRegistrationCredential,
  registrationRiskSignals
} from "./validation.js";

export interface CeremonyTransitionContext {
  readonly nowMs: number;
  readonly ids: IdGenerator;
}

function makeMutation(
  snapshot: CeremonyAggregate,
  type: CeremonyEventType,
  commandId: string,
  context: CeremonyTransitionContext,
  secureCredentialEffect: SecureCredentialEffect | null
): CeremonyMutation {
  const eventId = context.ids.next("event");
  const outboxId = context.ids.next("outbox");
  assertOpaqueId("generated eventId", eventId);
  assertOpaqueId("generated outboxId", outboxId);
  const normalizedSnapshot = normalizeCeremonySnapshot(snapshot);

  const event: CeremonyDomainEvent = Object.freeze({
    schemaVersion: PASSKEY_DOMAIN_VERSION,
    eventId,
    type,
    ceremonyId: normalizedSnapshot.ceremonyId,
    revision: normalizedSnapshot.revision,
    occurredAtMs: context.nowMs,
    commandId,
    snapshot: normalizedSnapshot
  });
  assertCeremonyEventInvariants(event);
  const outboxPayload = Object.freeze({
    schemaVersion: PASSKEY_DOMAIN_VERSION,
    type,
    ceremonyId: normalizedSnapshot.ceremonyId,
    kind: normalizedSnapshot.kind,
    purpose: normalizedSnapshot.purpose.type,
    state: normalizedSnapshot.state,
    revision: normalizedSnapshot.revision,
    attemptsUsed: normalizedSnapshot.attemptsUsed,
    riskSignals: normalizedSnapshot.riskSignals,
    occurredAtMs: context.nowMs
  });
  const outbox: CeremonyOutboxRecord = Object.freeze({
    schemaVersion: PASSKEY_DOMAIN_VERSION,
    outboxId,
    topic: "luxora.passkey-ceremony.v1",
    partitionKey: normalizedSnapshot.ceremonyId,
    eventId,
    payload: outboxPayload,
    availableAtMs: context.nowMs
  });
  return Object.freeze({ snapshot: normalizedSnapshot, event, outbox, secureCredentialEffect });
}

export function startCeremony(
  command: BeginCeremonyCommand,
  challenge: ChallengeDescriptor,
  policy: PasskeyRelyingPartyPolicy,
  context: CeremonyTransitionContext
): CeremonyMutation {
  assertBeginCommand(command, policy);
  assertInteger("nowMs", context.nowMs);
  if (context.nowMs > Number.MAX_SAFE_INTEGER - policy.timeoutMs) {
    reject("VALIDATION_FAILED", "ceremony expiry would exceed the safe integer range");
  }
  const ceremonyId = context.ids.next("ceremony");
  assertOpaqueId("generated ceremonyId", ceremonyId);
  const registration = command.type === "begin_registration";
  const snapshot: CeremonyAggregate = {
    schemaVersion: PASSKEY_DOMAIN_VERSION,
    ceremonyId,
    kind: registration ? "registration" : "authentication",
    purpose: Object.freeze({ ...command.purpose }),
    actor: Object.freeze({ ...command.actor }),
    policyVersion: policy.policyVersion,
    expectedRpId: policy.rpId,
    expectedOrigin: command.expectedOrigin,
    timeoutMs: policy.timeoutMs,
    maxResponseBytes: policy.maxResponseBytes,
    userVerification: "required",
    crossOriginAllowed: false,
    expectedTopOrigins: [],
    attestation: "none",
    registrationResidentKey: "required",
    allowedAlgorithms: [...policy.allowedAlgorithms],
    credentialBoundary: command.credentialBoundary.mode === "discoverable"
      ? Object.freeze({ mode: "discoverable" as const, credentialSetRef: null })
      : Object.freeze({
          mode: "non_discoverable" as const,
          credentialSetRef: command.credentialBoundary.credentialSetRef
        }),
    userHandleRef: registration ? command.userHandleRef : null,
    challenge,
    state: "pending",
    revision: 1,
    attemptsUsed: 0,
    maxAttempts: policy.maxAttempts,
    createdAtMs: context.nowMs,
    expiresAtMs: context.nowMs + policy.timeoutMs,
    updatedAtMs: context.nowMs,
    terminalAtMs: null,
    terminalReason: null,
    riskSignals: []
  };
  return makeMutation(snapshot, "passkey.ceremony.started", command.commandId, context, null);
}

function assertPending(ceremony: CeremonyAggregate): void {
  assertCeremonyInvariants(ceremony);
  if (ceremony.state !== "pending") {
    reject("TERMINAL_CEREMONY", `ceremony is already ${ceremony.state}`, ceremony);
  }
}

function nextSnapshot(
  ceremony: CeremonyAggregate,
  context: CeremonyTransitionContext,
  changes: Partial<Omit<CeremonyAggregate, "schemaVersion" | "ceremonyId" | "revision" | "createdAtMs" | "updatedAtMs">>
): CeremonyAggregate {
  if (context.nowMs < ceremony.updatedAtMs) {
    reject("VALIDATION_FAILED", "ceremony clock moved backwards", ceremony);
  }
  return {
    ...ceremony,
    ...changes,
    revision: ceremony.revision + 1,
    updatedAtMs: context.nowMs
  };
}

function expiredSnapshot(ceremony: CeremonyAggregate, context: CeremonyTransitionContext): CeremonyAggregate {
  return nextSnapshot(ceremony, context, {
    state: "expired",
    terminalAtMs: context.nowMs,
    terminalReason: "expired"
  });
}

export function expireCeremony(
  ceremony: CeremonyAggregate,
  commandId: string,
  expectedRevision: number,
  context: CeremonyTransitionContext
): CeremonyMutation {
  assertPending(ceremony);
  if (expectedRevision !== ceremony.revision) {
    reject("REVISION_CONFLICT", "expectedRevision is stale", ceremony);
  }
  if (context.nowMs < ceremony.expiresAtMs) {
    reject("COMMAND_NOT_ALLOWED", "ceremony cannot expire before expiresAtMs", ceremony);
  }
  return makeMutation(
    expiredSnapshot(ceremony, context),
    "passkey.ceremony.expired",
    commandId,
    context,
    null
  );
}

export function cancelCeremony(
  ceremony: CeremonyAggregate,
  commandId: string,
  actor: CeremonyAggregate["actor"],
  expectedRevision: number,
  context: CeremonyTransitionContext
): CeremonyMutation {
  assertPending(ceremony);
  if (expectedRevision !== ceremony.revision) {
    reject("REVISION_CONFLICT", "expectedRevision is stale", ceremony);
  }
  if (!actorMatches(ceremony.actor, actor)) {
    reject("FORBIDDEN", "ceremony account/session/device binding does not match", ceremony);
  }
  if (context.nowMs >= ceremony.expiresAtMs) {
    return makeMutation(
      expiredSnapshot(ceremony, context),
      "passkey.ceremony.expired",
      commandId,
      context,
      null
    );
  }
  const snapshot = nextSnapshot(ceremony, context, {
    state: "cancelled",
    terminalAtMs: context.nowMs,
    terminalReason: "cancelled"
  });
  return makeMutation(snapshot, "passkey.ceremony.cancelled", commandId, context, null);
}

export function rejectVerificationAttempt(
  ceremony: CeremonyAggregate,
  commandId: string,
  expectedRevision: number,
  context: CeremonyTransitionContext
): CeremonyMutation {
  assertPending(ceremony);
  if (expectedRevision !== ceremony.revision) {
    reject("REVISION_CONFLICT", "expectedRevision is stale", ceremony);
  }
  if (context.nowMs >= ceremony.expiresAtMs) {
    return makeMutation(
      expiredSnapshot(ceremony, context),
      "passkey.ceremony.expired",
      commandId,
      context,
      null
    );
  }
  const attemptsUsed = ceremony.attemptsUsed + 1;
  const exhausted = attemptsUsed >= ceremony.maxAttempts;
  const snapshot = nextSnapshot(ceremony, context, exhausted
    ? {
        attemptsUsed,
        state: "rejected",
        terminalAtMs: context.nowMs,
        terminalReason: "attempts_exhausted"
      }
    : { attemptsUsed });
  return makeMutation(
    snapshot,
    exhausted ? "passkey.ceremony.attempts_exhausted" : "passkey.ceremony.verification_rejected",
    commandId,
    context,
    null
  );
}

function registrationEffect(
  ceremony: CeremonyAggregate,
  result: RegistrationVerifierSuccess,
  context: CeremonyTransitionContext
): { readonly effect: SecureCredentialEffect; readonly riskSignals: CeremonyAggregate["riskSignals"] } {
  const credential = normalizeRegistrationCredential(result.credential, ceremony);
  const credentialRecordId = context.ids.next("credential-record");
  assertOpaqueId("generated credentialRecordId", credentialRecordId, 192);
  return {
    effect: Object.freeze({
      type: "store_registration_credential",
      credentialRecordId,
      ceremonyId: ceremony.ceremonyId,
      credential
    }),
    riskSignals: registrationRiskSignals(credential)
  };
}

function authenticationEffect(
  ceremony: CeremonyAggregate,
  result: AuthenticationVerifierSuccess
): { readonly effect: SecureCredentialEffect; readonly riskSignals: CeremonyAggregate["riskSignals"] } {
  const credential = normalizeAuthenticationCredential(result.credential, ceremony);
  const riskSignals = authenticationRiskSignals(credential);
  return {
    effect: Object.freeze({
      type: "update_authentication_credential",
      ceremonyId: ceremony.ceremonyId,
      credential,
      riskSignals
    }),
    riskSignals
  };
}

export function consumeVerifiedCeremony(
  ceremony: CeremonyAggregate,
  commandId: string,
  expectedRevision: number,
  result: Exclude<WebAuthnVerifierResult, { readonly status: "rejected" }>,
  context: CeremonyTransitionContext
): CeremonyMutation {
  assertPending(ceremony);
  if (expectedRevision !== ceremony.revision) {
    reject("REVISION_CONFLICT", "expectedRevision is stale", ceremony);
  }
  if (context.nowMs >= ceremony.expiresAtMs) {
    return makeMutation(
      expiredSnapshot(ceremony, context),
      "passkey.ceremony.expired",
      commandId,
      context,
      null
    );
  }
  if (result.kind !== ceremony.kind) {
    reject("VERIFIER_UNAVAILABLE", "verifier returned a result for the wrong ceremony kind", ceremony);
  }
  const secured = result.kind === "registration"
    ? registrationEffect(ceremony, result, context)
    : authenticationEffect(ceremony, result);
  const snapshot = nextSnapshot(ceremony, context, {
    state: "consumed",
    terminalAtMs: context.nowMs,
    terminalReason: "verified",
    riskSignals: secured.riskSignals
  });
  return makeMutation(
    snapshot,
    "passkey.ceremony.consumed",
    commandId,
    context,
    secured.effect
  );
}

export function toSafeCeremonyLogFields(event: CeremonyDomainEvent): SafeCeremonyLogFields {
  assertCeremonyEventInvariants(event);
  return {
    component: "passkey-domain",
    schemaVersion: PASSKEY_DOMAIN_VERSION,
    eventType: event.type,
    ceremonyKind: event.snapshot.kind,
    purpose: event.snapshot.purpose.type,
    state: event.snapshot.state,
    revision: event.snapshot.revision,
    attemptsUsed: event.snapshot.attemptsUsed,
    riskSignals: Object.freeze([...event.snapshot.riskSignals])
  };
}
