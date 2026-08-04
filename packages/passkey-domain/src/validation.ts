import { Buffer } from "node:buffer";
import { reject } from "./errors.js";
import {
  PASSKEY_CHALLENGE_BYTES,
  PASSKEY_DEFAULT_TIMEOUT_MS,
  PASSKEY_DOMAIN_VERSION,
  PASSKEY_MAX_ATTEMPTS,
  PASSKEY_MAX_RESPONSE_BYTES,
  PASSKEY_MAX_TIMEOUT_MS,
  type AuthenticatedCeremonyActor,
  type BeginCeremonyCommand,
  type CeremonyAggregate,
  type CeremonyCommand,
  type CeremonyDomainEvent,
  type CeremonyEventType,
  type CeremonyPurpose,
  type CredentialBoundary,
  type MaintainedVerifierDescriptor,
  type PasskeyRelyingPartyPolicy,
  type PasskeyRiskSignal,
  type SecureRegistrationCredential,
  type VerifiedAuthenticationCredential
} from "./types.js";

const OPAQUE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const DIGEST_PATTERN = /^[a-f0-9]{64}$/;
const RP_ID_PATTERN = /^(?=.{1,253}$)(?!.*\.\.)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?))*$/;
const SEMVER_PATTERN = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;
const LUXORA_RP_ID_V1 = "auth.luxora.app";
const AUTHENTICATOR_TRANSPORTS = new Set([
  "ble",
  "cable",
  "hybrid",
  "internal",
  "nfc",
  "smart-card",
  "usb"
]);
const RISK_SIGNALS = new Set<PasskeyRiskSignal>([
  "signature_counter_not_supported",
  "signature_counter_anomaly",
  "backup_state_enabled",
  "backup_state_disabled",
  "single_device_credential",
  "backup_not_active"
]);
const CEREMONY_EVENT_TYPES = new Set<CeremonyEventType>([
  "passkey.ceremony.started",
  "passkey.ceremony.verification_rejected",
  "passkey.ceremony.consumed",
  "passkey.ceremony.cancelled",
  "passkey.ceremony.expired",
  "passkey.ceremony.attempts_exhausted"
]);

function assertExactKeys(name: string, value: object, expected: readonly string[]): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    reject("VALIDATION_FAILED", `${name} contains missing or unexpected fields`);
  }
}

function assertPurpose(purpose: CeremonyPurpose): void {
  if (purpose === null || typeof purpose !== "object" || Array.isArray(purpose)) {
    reject("VALIDATION_FAILED", "purpose must be an object");
  }
  assertExactKeys("purpose", purpose, ["type", "targetDigest"]);
  if (purpose.type !== "authenticator.add" && purpose.type !== "session.step_up") {
    reject("VALIDATION_FAILED", "ceremony purpose is invalid");
  }
  assertDigest("purpose.targetDigest", purpose.targetDigest);
}

export function assertInteger(name: string, value: number, minimum = 0, maximum = Number.MAX_SAFE_INTEGER): void {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    reject("VALIDATION_FAILED", `${name} must be a safe integer between ${minimum} and ${maximum}`);
  }
}

export function assertOpaqueId(name: string, value: string, maxLength = 128): void {
  if (typeof value !== "string" || value.length < 1 || value.length > maxLength || !OPAQUE_PATTERN.test(value)) {
    reject("VALIDATION_FAILED", `${name} must be a bounded opaque identifier`);
  }
}

export function assertDigest(name: string, value: string): void {
  if (typeof value !== "string" || !DIGEST_PATTERN.test(value)) {
    reject("VALIDATION_FAILED", `${name} must be a lower-case SHA-256 hex digest`);
  }
}

function assertActor(actor: AuthenticatedCeremonyActor): void {
  if (actor === null || typeof actor !== "object" || Array.isArray(actor)) {
    reject("VALIDATION_FAILED", "actor must be an authenticated account/session/device binding");
  }
  assertExactKeys("actor", actor, ["accountId", "sessionId", "deviceId"]);
  assertOpaqueId("actor.accountId", actor.accountId);
  assertOpaqueId("actor.sessionId", actor.sessionId);
  assertOpaqueId("actor.deviceId", actor.deviceId);
}

export function actorMatches(left: AuthenticatedCeremonyActor, right: AuthenticatedCeremonyActor): boolean {
  return left.accountId === right.accountId
    && left.sessionId === right.sessionId
    && left.deviceId === right.deviceId;
}

function assertCredentialBoundary(boundary: CredentialBoundary): void {
  if (boundary === null || typeof boundary !== "object" || Array.isArray(boundary)) {
    reject("VALIDATION_FAILED", "credential boundary must be an object");
  }
  assertExactKeys("credential boundary", boundary, ["mode", "credentialSetRef"]);
  if (boundary.mode === "discoverable") {
    if (boundary.credentialSetRef !== null) {
      reject("VALIDATION_FAILED", "discoverable ceremonies cannot persist a credential-set reference");
    }
    return;
  }
  if (boundary.mode !== "non_discoverable") {
    reject("VALIDATION_FAILED", "credential discovery mode is invalid");
  }
  assertOpaqueId("credentialSetRef", boundary.credentialSetRef, 192);
}

function parseExactHttpsOrigin(origin: string): URL {
  if (typeof origin !== "string" || origin.length > 512 || origin.includes("*")) {
    reject("VALIDATION_FAILED", "origin must be one explicit bounded origin without wildcards");
  }
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    reject("VALIDATION_FAILED", "origin must be a valid URL origin");
  }
  if (
    parsed.protocol !== "https:"
    || parsed.origin !== origin
    || parsed.username !== ""
    || parsed.password !== ""
    || parsed.pathname !== "/"
    || parsed.search !== ""
    || parsed.hash !== ""
  ) {
    reject("VALIDATION_FAILED", "origin must be an exact HTTPS origin with no path, query, fragment or credentials");
  }
  return parsed;
}

function assertRpId(rpId: string): void {
  if (typeof rpId !== "string" || rpId !== rpId.toLowerCase() || rpId.includes("*") || !RP_ID_PATTERN.test(rpId)) {
    reject("VALIDATION_FAILED", "rpId must be one explicit lower-case DNS domain");
  }
}

export function assertPolicy(policy: PasskeyRelyingPartyPolicy): void {
  if (policy === null || typeof policy !== "object" || Array.isArray(policy)) {
    reject("VALIDATION_FAILED", "relying-party policy must be an object");
  }
  assertExactKeys("relying-party policy", policy, [
    "policyVersion",
    "rpId",
    "allowedOrigins",
    "timeoutMs",
    "maxAttempts",
    "maxResponseBytes",
    "userVerification",
    "userPresenceRequired",
    "crossOriginAllowed",
    "expectedTopOrigins",
    "attestation",
    "registrationResidentKey",
    "allowedAlgorithms"
  ]);
  if (policy.policyVersion !== PASSKEY_DOMAIN_VERSION) reject("VALIDATION_FAILED", "unsupported policy version");
  assertRpId(policy.rpId);
  if (policy.rpId !== LUXORA_RP_ID_V1) {
    reject("VALIDATION_FAILED", "policy v1 requires the Luxora production RP ID");
  }
  if (!Array.isArray(policy.allowedOrigins) || policy.allowedOrigins.length < 1 || policy.allowedOrigins.length > 8) {
    reject("VALIDATION_FAILED", "allowedOrigins must contain between one and eight exact origins");
  }
  if (new Set(policy.allowedOrigins).size !== policy.allowedOrigins.length) {
    reject("VALIDATION_FAILED", "allowedOrigins must be unique");
  }
  for (const origin of policy.allowedOrigins) {
    const parsed = parseExactHttpsOrigin(origin);
    if (parsed.hostname !== policy.rpId && !parsed.hostname.endsWith(`.${policy.rpId}`)) {
      reject("VALIDATION_FAILED", "every origin host must equal or be a subdomain of rpId");
    }
  }
  assertInteger("timeoutMs", policy.timeoutMs, PASSKEY_DEFAULT_TIMEOUT_MS, PASSKEY_MAX_TIMEOUT_MS);
  assertInteger("maxAttempts", policy.maxAttempts, 1, PASSKEY_MAX_ATTEMPTS);
  assertInteger("maxResponseBytes", policy.maxResponseBytes, 1, PASSKEY_MAX_RESPONSE_BYTES);
  if (
    policy.userVerification !== "required"
    || policy.userPresenceRequired !== true
    || policy.crossOriginAllowed !== false
    || policy.attestation !== "none"
    || policy.registrationResidentKey !== "required"
    || !Array.isArray(policy.expectedTopOrigins)
    || policy.expectedTopOrigins.length !== 0
  ) {
    reject("VALIDATION_FAILED", "policy must require UP/UV, deny cross-origin use and use none/required registration defaults");
  }
  if (
    !Array.isArray(policy.allowedAlgorithms)
    || policy.allowedAlgorithms.length !== 2
    || new Set(policy.allowedAlgorithms).size !== 2
    || !policy.allowedAlgorithms.includes(-7)
    || !policy.allowedAlgorithms.includes(-257)
  ) {
    reject("VALIDATION_FAILED", "policy v1 algorithm allowlist must be exactly ES256 and RS256");
  }
}

export function normalizePolicy(policy: PasskeyRelyingPartyPolicy): PasskeyRelyingPartyPolicy {
  assertPolicy(policy);
  return Object.freeze({
    ...policy,
    allowedOrigins: Object.freeze([...policy.allowedOrigins]),
    expectedTopOrigins: Object.freeze([]) as readonly [],
    allowedAlgorithms: Object.freeze([...policy.allowedAlgorithms])
  });
}

function assertBaseCommand(command: CeremonyCommand): void {
  if (command === null || typeof command !== "object" || Array.isArray(command)) {
    reject("VALIDATION_FAILED", "command must be an object");
  }
  if (command.schemaVersion !== PASSKEY_DOMAIN_VERSION) reject("VALIDATION_FAILED", "unsupported command version");
  assertOpaqueId("commandId", command.commandId);
  assertInteger("expectedRevision", command.expectedRevision);
}

export function assertBeginCommand(command: BeginCeremonyCommand, policy: PasskeyRelyingPartyPolicy): void {
  assertBaseCommand(command);
  if (command.type === "begin_registration") {
    assertExactKeys("begin registration command", command, [
      "schemaVersion",
      "type",
      "commandId",
      "clientNonce",
      "actor",
      "expectedRevision",
      "purpose",
      "expectedOrigin",
      "credentialBoundary",
      "userHandleRef"
    ]);
  } else if (command.type === "begin_authentication") {
    assertExactKeys("begin authentication command", command, [
      "schemaVersion",
      "type",
      "commandId",
      "clientNonce",
      "actor",
      "expectedRevision",
      "purpose",
      "expectedOrigin",
      "credentialBoundary"
    ]);
  } else {
    reject("VALIDATION_FAILED", "begin command type is invalid");
  }
  if (command.expectedRevision !== 0) reject("VALIDATION_FAILED", "begin expectedRevision must be zero");
  assertActor(command.actor);
  assertOpaqueId("clientNonce", command.clientNonce);
  assertPurpose(command.purpose);
  parseExactHttpsOrigin(command.expectedOrigin);
  if (!policy.allowedOrigins.includes(command.expectedOrigin)) {
    reject("FORBIDDEN", "expected origin is not an exact configured relying-party origin");
  }
  assertCredentialBoundary(command.credentialBoundary);

  if (command.type === "begin_registration") {
    if (command.purpose.type !== "authenticator.add") {
      reject("VALIDATION_FAILED", "registration purpose must be authenticator.add");
    }
    if (command.credentialBoundary.mode !== "discoverable") {
      reject("VALIDATION_FAILED", "policy v1 registration must create a discoverable credential");
    }
    assertOpaqueId("userHandleRef", command.userHandleRef, 192);
    return;
  }
  if (command.type !== "begin_authentication" || command.purpose.type !== "session.step_up") {
    reject("VALIDATION_FAILED", "authentication purpose must be session.step_up");
  }
}

export function assertExistingCommand(command: CeremonyCommand, policy: PasskeyRelyingPartyPolicy): void {
  assertBaseCommand(command);
  if (command.type === "begin_registration" || command.type === "begin_authentication") {
    reject("VALIDATION_FAILED", "expected an existing-ceremony command");
  }
  assertOpaqueId("ceremonyId", command.ceremonyId);
  if (command.type === "expire") {
    assertExactKeys("expire command", command, [
      "schemaVersion",
      "type",
      "commandId",
      "actor",
      "expectedRevision",
      "ceremonyId"
    ]);
    if (command.actor === null || typeof command.actor !== "object" || Array.isArray(command.actor)) {
      reject("VALIDATION_FAILED", "expire actor must be the ceremony expirer");
    }
    assertExactKeys("expire actor", command.actor, ["kind", "subject"]);
    if (command.actor.kind !== "system" || command.actor.subject !== "ceremony-expirer") {
      reject("VALIDATION_FAILED", "expire requires the ceremony-expirer system actor");
    }
    return;
  }
  assertExactKeys(command.type === "verify" ? "verify command" : "cancel command", command,
    command.type === "verify"
      ? [
          "schemaVersion",
          "type",
          "commandId",
          "actor",
          "expectedRevision",
          "ceremonyId",
          "responseByteLength",
          "responseDigest"
        ]
      : ["schemaVersion", "type", "commandId", "actor", "expectedRevision", "ceremonyId"]);
  assertActor(command.actor);
  if (command.type === "verify") {
    assertInteger("responseByteLength", command.responseByteLength, 1, policy.maxResponseBytes);
    assertDigest("responseDigest", command.responseDigest);
  }
}

function assertRiskSignals(signals: readonly PasskeyRiskSignal[]): void {
  if (!Array.isArray(signals) || new Set(signals).size !== signals.length) {
    reject("VALIDATION_FAILED", "risk signals must be a unique array");
  }
  for (const signal of signals) {
    if (!RISK_SIGNALS.has(signal)) reject("VALIDATION_FAILED", "risk signal is invalid");
  }
}

export function assertCeremonyInvariants(ceremony: CeremonyAggregate): void {
  if (ceremony === null || typeof ceremony !== "object" || Array.isArray(ceremony)) {
    reject("VALIDATION_FAILED", "ceremony snapshot must be an object");
  }
  assertExactKeys("ceremony snapshot", ceremony, [
    "schemaVersion",
    "ceremonyId",
    "kind",
    "purpose",
    "actor",
    "policyVersion",
    "expectedRpId",
    "expectedOrigin",
    "timeoutMs",
    "maxResponseBytes",
    "userVerification",
    "crossOriginAllowed",
    "expectedTopOrigins",
    "attestation",
    "registrationResidentKey",
    "allowedAlgorithms",
    "credentialBoundary",
    "userHandleRef",
    "challenge",
    "state",
    "revision",
    "attemptsUsed",
    "maxAttempts",
    "createdAtMs",
    "expiresAtMs",
    "updatedAtMs",
    "terminalAtMs",
    "terminalReason",
    "riskSignals"
  ]);
  if (ceremony.schemaVersion !== PASSKEY_DOMAIN_VERSION || ceremony.policyVersion !== PASSKEY_DOMAIN_VERSION) {
    reject("VALIDATION_FAILED", "ceremony version is unsupported");
  }
  assertOpaqueId("ceremonyId", ceremony.ceremonyId);
  assertActor(ceremony.actor);
  assertPurpose(ceremony.purpose);
  assertRpId(ceremony.expectedRpId);
  if (ceremony.expectedRpId !== LUXORA_RP_ID_V1) {
    reject("VALIDATION_FAILED", "ceremony RP ID is outside policy v1");
  }
  const origin = parseExactHttpsOrigin(ceremony.expectedOrigin);
  if (origin.hostname !== ceremony.expectedRpId && !origin.hostname.endsWith(`.${ceremony.expectedRpId}`)) {
    reject("VALIDATION_FAILED", "ceremony origin is outside rpId scope");
  }
  if (
    ceremony.userVerification !== "required"
    || ceremony.crossOriginAllowed !== false
    || !Array.isArray(ceremony.expectedTopOrigins)
    || ceremony.expectedTopOrigins.length !== 0
    || ceremony.attestation !== "none"
    || ceremony.registrationResidentKey !== "required"
  ) {
    reject("VALIDATION_FAILED", "ceremony security policy is invalid");
  }
  assertInteger("timeoutMs", ceremony.timeoutMs, PASSKEY_DEFAULT_TIMEOUT_MS, PASSKEY_MAX_TIMEOUT_MS);
  assertInteger("maxResponseBytes", ceremony.maxResponseBytes, 1, PASSKEY_MAX_RESPONSE_BYTES);
  if (
    !Array.isArray(ceremony.allowedAlgorithms)
    || ceremony.allowedAlgorithms.length !== 2
    || new Set(ceremony.allowedAlgorithms).size !== 2
    || !ceremony.allowedAlgorithms.includes(-7)
    || !ceremony.allowedAlgorithms.includes(-257)
  ) {
    reject("VALIDATION_FAILED", "ceremony algorithm allowlist is invalid");
  }
  assertCredentialBoundary(ceremony.credentialBoundary);
  if (ceremony.kind === "registration") {
    if (ceremony.purpose.type !== "authenticator.add" || ceremony.credentialBoundary.mode !== "discoverable") {
      reject("VALIDATION_FAILED", "registration binding is invalid");
    }
    if (ceremony.userHandleRef === null) reject("VALIDATION_FAILED", "registration requires userHandleRef");
    assertOpaqueId("userHandleRef", ceremony.userHandleRef, 192);
  } else if (ceremony.kind === "authentication") {
    if (ceremony.purpose.type !== "session.step_up" || ceremony.userHandleRef !== null) {
      reject("VALIDATION_FAILED", "authentication binding is invalid");
    }
  } else {
    reject("VALIDATION_FAILED", "ceremony kind is invalid");
  }
  if (ceremony.challenge === null || typeof ceremony.challenge !== "object" || Array.isArray(ceremony.challenge)) {
    reject("VALIDATION_FAILED", "challenge descriptor must be an object");
  }
  assertExactKeys("challenge descriptor", ceremony.challenge, ["reference", "digest", "byteLength"]);
  assertOpaqueId("challenge.reference", ceremony.challenge.reference, 192);
  assertDigest("challenge.digest", ceremony.challenge.digest);
  if (ceremony.challenge.byteLength !== PASSKEY_CHALLENGE_BYTES) {
    reject("VALIDATION_FAILED", "challenge byte length is invalid");
  }
  assertInteger("revision", ceremony.revision, 1);
  assertInteger("attemptsUsed", ceremony.attemptsUsed, 0, ceremony.maxAttempts);
  assertInteger("maxAttempts", ceremony.maxAttempts, 1, PASSKEY_MAX_ATTEMPTS);
  assertInteger("createdAtMs", ceremony.createdAtMs);
  assertInteger("expiresAtMs", ceremony.expiresAtMs);
  assertInteger("updatedAtMs", ceremony.updatedAtMs);
  if (
    ceremony.createdAtMs > Number.MAX_SAFE_INTEGER - ceremony.timeoutMs
    || ceremony.expiresAtMs !== ceremony.createdAtMs + ceremony.timeoutMs
    || ceremony.updatedAtMs < ceremony.createdAtMs
  ) {
    reject("VALIDATION_FAILED", "ceremony timeline is invalid");
  }
  if (
    ceremony.state === "pending"
    && ceremony.updatedAtMs >= ceremony.expiresAtMs
  ) {
    reject("VALIDATION_FAILED", "pending ceremony cannot be updated at or after expiry");
  }
  assertRiskSignals(ceremony.riskSignals);

  if (ceremony.state === "pending") {
    if (
      ceremony.terminalAtMs !== null
      || ceremony.terminalReason !== null
      || ceremony.attemptsUsed >= ceremony.maxAttempts
      || ceremony.riskSignals.length !== 0
      || ceremony.revision !== ceremony.attemptsUsed + 1
    ) {
      reject("VALIDATION_FAILED", "pending ceremony has terminal state");
    }
    return;
  }
  if (ceremony.terminalAtMs === null) {
    reject("VALIDATION_FAILED", "terminal ceremony requires a valid terminal timestamp");
  }
  assertInteger("terminalAtMs", ceremony.terminalAtMs);
  if (ceremony.terminalAtMs < ceremony.createdAtMs || ceremony.terminalAtMs !== ceremony.updatedAtMs) {
    reject("VALIDATION_FAILED", "terminal timestamp must equal the last transition time");
  }
  const expectedReason = ceremony.state === "consumed"
    ? "verified"
    : ceremony.state === "cancelled"
      ? "cancelled"
      : ceremony.state === "expired"
        ? "expired"
        : ceremony.state === "rejected"
          ? "attempts_exhausted"
          : null;
  if (expectedReason === null || ceremony.terminalReason !== expectedReason) {
    reject("VALIDATION_FAILED", "terminal state and reason do not match");
  }
  if (
    (ceremony.state === "expired" && ceremony.terminalAtMs < ceremony.expiresAtMs)
    || (ceremony.state !== "expired" && ceremony.terminalAtMs >= ceremony.expiresAtMs)
  ) {
    reject("VALIDATION_FAILED", "terminal transition violates the ceremony expiry boundary");
  }
  if (ceremony.state === "rejected" && ceremony.attemptsUsed !== ceremony.maxAttempts) {
    reject("VALIDATION_FAILED", "rejected ceremony must exhaust its attempts");
  }
  const expectedRevision = ceremony.state === "rejected"
    ? ceremony.attemptsUsed + 1
    : ceremony.attemptsUsed + 2;
  if (ceremony.revision !== expectedRevision) {
    reject("VALIDATION_FAILED", "ceremony revision does not match its transition history");
  }
  if (ceremony.state !== "consumed" && ceremony.riskSignals.length !== 0) {
    reject("VALIDATION_FAILED", "only consumed ceremonies may carry credential risk signals");
  }
  if (ceremony.state === "consumed") {
    const allowedForKind = ceremony.kind === "registration"
      ? new Set<PasskeyRiskSignal>([
          "signature_counter_not_supported",
          "single_device_credential",
          "backup_not_active"
        ])
      : new Set<PasskeyRiskSignal>([
          "signature_counter_not_supported",
          "signature_counter_anomaly",
          "backup_state_enabled",
          "backup_state_disabled"
        ]);
    if (
      ceremony.riskSignals.some((signal) => !allowedForKind.has(signal))
      || (ceremony.riskSignals.includes("signature_counter_not_supported")
        && ceremony.riskSignals.includes("signature_counter_anomaly"))
      || (ceremony.riskSignals.includes("single_device_credential")
        && ceremony.riskSignals.includes("backup_not_active"))
      || (ceremony.riskSignals.includes("backup_state_enabled")
        && ceremony.riskSignals.includes("backup_state_disabled"))
    ) {
      reject("VALIDATION_FAILED", "credential risk signals are inconsistent with the ceremony kind");
    }
  }
}

export function assertCeremonyMatchesPolicy(
  ceremony: CeremonyAggregate,
  policy: PasskeyRelyingPartyPolicy
): void {
  assertCeremonyInvariants(ceremony);
  assertPolicy(policy);
  if (
    ceremony.policyVersion !== policy.policyVersion
    || ceremony.expectedRpId !== policy.rpId
    || !policy.allowedOrigins.includes(ceremony.expectedOrigin)
    || ceremony.timeoutMs !== policy.timeoutMs
    || ceremony.maxAttempts !== policy.maxAttempts
    || ceremony.maxResponseBytes !== policy.maxResponseBytes
    || ceremony.userVerification !== policy.userVerification
    || ceremony.crossOriginAllowed !== policy.crossOriginAllowed
    || ceremony.attestation !== policy.attestation
    || ceremony.registrationResidentKey !== policy.registrationResidentKey
    || ceremony.allowedAlgorithms.length !== policy.allowedAlgorithms.length
    || ceremony.allowedAlgorithms.some((algorithm, index) => algorithm !== policy.allowedAlgorithms[index])
  ) {
    reject("VALIDATION_FAILED", "ceremony does not match the active relying-party policy");
  }
}

export function normalizeCeremonySnapshot(ceremony: CeremonyAggregate): CeremonyAggregate {
  assertCeremonyInvariants(ceremony);
  const actor = Object.freeze({ ...ceremony.actor });
  const purpose = Object.freeze({ ...ceremony.purpose });
  const credentialBoundary = ceremony.credentialBoundary.mode === "discoverable"
    ? Object.freeze({ mode: "discoverable" as const, credentialSetRef: null })
    : Object.freeze({
        mode: "non_discoverable" as const,
        credentialSetRef: ceremony.credentialBoundary.credentialSetRef
      });
  return Object.freeze({
    ...ceremony,
    actor,
    purpose,
    expectedTopOrigins: Object.freeze([]) as readonly [],
    allowedAlgorithms: Object.freeze([...ceremony.allowedAlgorithms]),
    credentialBoundary,
    challenge: Object.freeze({ ...ceremony.challenge }),
    riskSignals: Object.freeze([...ceremony.riskSignals])
  });
}

export function assertCeremonyEventInvariants(event: CeremonyDomainEvent): void {
  if (event === null || typeof event !== "object" || Array.isArray(event)) {
    reject("VALIDATION_FAILED", "ceremony event must be an object");
  }
  assertExactKeys("ceremony event", event, [
    "schemaVersion",
    "eventId",
    "type",
    "ceremonyId",
    "revision",
    "occurredAtMs",
    "commandId",
    "snapshot"
  ]);
  if (event.schemaVersion !== PASSKEY_DOMAIN_VERSION || !CEREMONY_EVENT_TYPES.has(event.type)) {
    reject("VALIDATION_FAILED", "ceremony event version or type is invalid");
  }
  assertOpaqueId("eventId", event.eventId);
  assertOpaqueId("event.commandId", event.commandId);
  assertInteger("event.occurredAtMs", event.occurredAtMs);
  assertCeremonyInvariants(event.snapshot);
  if (
    event.ceremonyId !== event.snapshot.ceremonyId
    || event.revision !== event.snapshot.revision
    || event.occurredAtMs !== event.snapshot.updatedAtMs
  ) {
    reject("VALIDATION_FAILED", "ceremony event does not match its snapshot");
  }
  const expectedState = event.type === "passkey.ceremony.started"
    || event.type === "passkey.ceremony.verification_rejected"
    ? "pending"
    : event.type === "passkey.ceremony.consumed"
      ? "consumed"
      : event.type === "passkey.ceremony.cancelled"
        ? "cancelled"
        : event.type === "passkey.ceremony.expired"
          ? "expired"
          : "rejected";
  if (
    event.snapshot.state !== expectedState
    || (event.type === "passkey.ceremony.started" && event.snapshot.revision !== 1)
    || (event.type === "passkey.ceremony.verification_rejected" && event.snapshot.attemptsUsed < 1)
  ) {
    reject("VALIDATION_FAILED", "ceremony event type does not match its transition");
  }
}

export function assertMaintainedVerifierDescriptor(descriptor: MaintainedVerifierDescriptor): void {
  if (descriptor === null || typeof descriptor !== "object" || Array.isArray(descriptor)) {
    reject("VALIDATION_FAILED", "verifier descriptor must be an object");
  }
  assertExactKeys("verifier descriptor", descriptor, [
    "kind",
    "libraryName",
    "libraryVersion",
    "reviewReference"
  ]);
  if (descriptor.kind !== "maintained-webauthn-server-library") {
    reject("VALIDATION_FAILED", "custom WebAuthn verifier implementations are forbidden");
  }
  if (
    typeof descriptor.libraryName !== "string"
    || descriptor.libraryName.length < 2
    || descriptor.libraryName.length > 128
    || descriptor.libraryName.toLowerCase().includes("custom")
  ) {
    reject("VALIDATION_FAILED", "verifier library name is invalid");
  }
  if (typeof descriptor.libraryVersion !== "string" || !SEMVER_PATTERN.test(descriptor.libraryVersion)) {
    reject("VALIDATION_FAILED", "verifier library version must be an exact semantic version");
  }
  assertOpaqueId("verifier reviewReference", descriptor.reviewReference, 192);
}

function assertUint32(name: string, value: number): void {
  assertInteger(name, value, 0, 0xffff_ffff);
}

export function assertRegistrationCredential(
  credential: SecureRegistrationCredential,
  ceremony: CeremonyAggregate
): void {
  if (credential === null || typeof credential !== "object" || Array.isArray(credential)) {
    reject("VALIDATION_FAILED", "verified registration credential is invalid");
  }
  assertExactKeys("registration credential", credential, [
    "credentialId",
    "publicKey",
    "algorithm",
    "accountId",
    "userHandleRef",
    "discoveryMode",
    "signCount",
    "backupEligible",
    "backupState",
    "transports",
    "userPresent",
    "userVerified"
  ]);
  if (
    typeof credential.credentialId !== "string"
    || credential.credentialId.length < 1
    || credential.credentialId.length > 1_364
    || !BASE64URL_PATTERN.test(credential.credentialId)
  ) {
    reject("VALIDATION_FAILED", "credentialId must be bounded base64url");
  }
  const decodedCredentialId = Buffer.from(credential.credentialId, "base64url");
  if (
    decodedCredentialId.byteLength < 1
    || decodedCredentialId.byteLength > 1_023
    || decodedCredentialId.toString("base64url") !== credential.credentialId
  ) {
    reject("VALIDATION_FAILED", "credentialId must canonically encode at most 1023 bytes");
  }
  if (!(credential.publicKey instanceof Uint8Array) || credential.publicKey.byteLength < 1 || credential.publicKey.byteLength > 4_096) {
    reject("VALIDATION_FAILED", "credential public key bytes are invalid");
  }
  if (!ceremony.allowedAlgorithms.includes(credential.algorithm)) {
    reject("VALIDATION_FAILED", "credential algorithm is outside the ceremony allowlist");
  }
  if (
    credential.accountId !== ceremony.actor.accountId
    || credential.userHandleRef !== ceremony.userHandleRef
    || credential.discoveryMode !== "discoverable"
    || credential.userPresent !== true
    || credential.userVerified !== true
  ) {
    reject("VALIDATION_FAILED", "verified credential does not match ceremony account, handle, mode or UP/UV policy");
  }
  assertUint32("credential.signCount", credential.signCount);
  if (typeof credential.backupEligible !== "boolean" || typeof credential.backupState !== "boolean") {
    reject("VALIDATION_FAILED", "credential backup flags must be booleans");
  }
  if (!credential.backupEligible && credential.backupState) {
    reject("VALIDATION_FAILED", "backup state cannot be true when backup eligibility is false");
  }
  if (
    !Array.isArray(credential.transports)
    || credential.transports.length > AUTHENTICATOR_TRANSPORTS.size
    || new Set(credential.transports).size !== credential.transports.length
  ) {
    reject("VALIDATION_FAILED", "credential transports are invalid");
  }
  for (const transport of credential.transports) {
    if (typeof transport !== "string" || !AUTHENTICATOR_TRANSPORTS.has(transport)) {
      reject("VALIDATION_FAILED", "credential transport is invalid");
    }
  }
}

export function assertAuthenticationCredential(
  credential: VerifiedAuthenticationCredential,
  ceremony: CeremonyAggregate
): void {
  if (credential === null || typeof credential !== "object" || Array.isArray(credential)) {
    reject("VALIDATION_FAILED", "verified authentication credential is invalid");
  }
  assertExactKeys("authentication credential", credential, [
    "credentialRecordId",
    "credentialRevision",
    "accountId",
    "discoveryMode",
    "userHandleBindingVerified",
    "previousSignCount",
    "newSignCount",
    "previousBackupEligible",
    "backupEligible",
    "previousBackupState",
    "backupState",
    "userPresent",
    "userVerified"
  ]);
  assertOpaqueId("credentialRecordId", credential.credentialRecordId, 192);
  assertInteger("credential.credentialRevision", credential.credentialRevision, 1);
  if (
    credential.accountId !== ceremony.actor.accountId
    || credential.discoveryMode !== ceremony.credentialBoundary.mode
    || credential.userHandleBindingVerified !== true
    || credential.userPresent !== true
    || credential.userVerified !== true
  ) {
    reject("VALIDATION_FAILED", "verified assertion does not match ceremony account, mode or UP/UV policy");
  }
  assertUint32("credential.previousSignCount", credential.previousSignCount);
  assertUint32("credential.newSignCount", credential.newSignCount);
  if (
    typeof credential.previousBackupEligible !== "boolean"
    || typeof credential.backupEligible !== "boolean"
    || typeof credential.previousBackupState !== "boolean"
    || typeof credential.backupState !== "boolean"
  ) {
    reject("VALIDATION_FAILED", "authentication backup flags must be booleans");
  }
  if ((!credential.previousBackupEligible && credential.previousBackupState)
    || (!credential.backupEligible && credential.backupState)) {
    reject("VALIDATION_FAILED", "authentication contains an invalid backup eligibility/state combination");
  }
  if (credential.backupEligible !== credential.previousBackupEligible) {
    reject("VALIDATION_FAILED", "backup eligibility must match its immutable registration value");
  }
}

export function normalizeRegistrationCredential(
  credential: SecureRegistrationCredential,
  ceremony: CeremonyAggregate
): SecureRegistrationCredential {
  assertRegistrationCredential(credential, ceremony);
  return Object.freeze({
    credentialId: credential.credentialId,
    publicKey: new Uint8Array(credential.publicKey),
    algorithm: credential.algorithm,
    accountId: credential.accountId,
    userHandleRef: credential.userHandleRef,
    discoveryMode: credential.discoveryMode,
    signCount: credential.signCount,
    backupEligible: credential.backupEligible,
    backupState: credential.backupState,
    transports: Object.freeze([...credential.transports]),
    userPresent: credential.userPresent,
    userVerified: credential.userVerified
  });
}

export function normalizeAuthenticationCredential(
  credential: VerifiedAuthenticationCredential,
  ceremony: CeremonyAggregate
): VerifiedAuthenticationCredential {
  assertAuthenticationCredential(credential, ceremony);
  return Object.freeze({
    credentialRecordId: credential.credentialRecordId,
    credentialRevision: credential.credentialRevision,
    accountId: credential.accountId,
    discoveryMode: credential.discoveryMode,
    userHandleBindingVerified: credential.userHandleBindingVerified,
    previousSignCount: credential.previousSignCount,
    newSignCount: credential.newSignCount,
    previousBackupEligible: credential.previousBackupEligible,
    backupEligible: credential.backupEligible,
    previousBackupState: credential.previousBackupState,
    backupState: credential.backupState,
    userPresent: credential.userPresent,
    userVerified: credential.userVerified
  });
}

export function registrationRiskSignals(credential: SecureRegistrationCredential): readonly PasskeyRiskSignal[] {
  const signals: PasskeyRiskSignal[] = [];
  if (credential.signCount === 0) signals.push("signature_counter_not_supported");
  if (!credential.backupEligible) signals.push("single_device_credential");
  else if (!credential.backupState) signals.push("backup_not_active");
  return Object.freeze(signals);
}

export function authenticationRiskSignals(
  credential: VerifiedAuthenticationCredential
): readonly PasskeyRiskSignal[] {
  assertUint32("credential.previousSignCount", credential.previousSignCount);
  assertUint32("credential.newSignCount", credential.newSignCount);
  const signals: PasskeyRiskSignal[] = [];
  if (credential.previousSignCount === 0 && credential.newSignCount === 0) {
    signals.push("signature_counter_not_supported");
  } else if (
    credential.previousSignCount > 0
    && credential.newSignCount <= credential.previousSignCount
  ) {
    signals.push("signature_counter_anomaly");
  }
  if (credential.backupState !== credential.previousBackupState) {
    signals.push(credential.backupState ? "backup_state_enabled" : "backup_state_disabled");
  }
  return Object.freeze(signals);
}
