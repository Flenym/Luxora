import { createHash } from "node:crypto";
import {
  PasskeyDomainError,
  StoreAuthorizationConflictError,
  StoreCredentialConflictError,
  StoreCredentialStateConflictError,
  StoreDuplicateCommandError,
  StoreDuplicateCreationError,
  StoreRevisionConflictError,
  reject
} from "./errors.js";
import { assertChallengeMatchesDescriptor, describeIssuedChallenge } from "./challenge.js";
import {
  cancelCeremony,
  consumeVerifiedCeremony,
  expireCeremony,
  rejectVerificationAttempt,
  startCeremony
} from "./state-machine.js";
import {
  PASSKEY_CHALLENGE_BYTES,
  type AuthenticationClientRequirements,
  type AuthenticationVerifierSuccess,
  type AuthenticationVerificationExpectations,
  type BeginCeremonyCommand,
  type CancelCeremonyCommand,
  type CeremonyClientRequirements,
  type CeremonyCommand,
  type CeremonyMutation,
  type ChallengeSecretVault,
  type Clock,
  type CommandReceipt,
  type CreationReceipt,
  type ExecutedCeremonyCommand,
  type ExpireCeremonyCommand,
  type IdGenerator,
  type MaintainedWebAuthnVerifierAdapter,
  type PasskeyCeremonyStore,
  type PasskeyRelyingPartyPolicy,
  type PersistCeremonyMutation,
  type RegistrationClientRequirements,
  type RegistrationVerifierSuccess,
  type RegistrationVerificationExpectations,
  type StoredCommandResult,
  type VerifyCeremonyCommand,
  type WebAuthnVerifierResult
} from "./types.js";
import {
  actorMatches,
  assertBeginCommand,
  assertCeremonyMatchesPolicy,
  assertExistingCommand,
  assertInteger,
  assertMaintainedVerifierDescriptor,
  normalizeAuthenticationCredential,
  normalizeCeremonySnapshot,
  normalizePolicy,
  normalizeRegistrationCredential
} from "./validation.js";

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`).join(",")}}`;
}

function digest(value: unknown): string {
  return createHash("sha256").update(canonical(value), "utf8").digest("hex");
}

function storageIntegrityFailure(): never {
  reject("STORAGE_INTEGRITY_FAILED", "passkey ceremony storage returned inconsistent state");
}

function copyActor(actor: BeginCeremonyCommand["actor"]): BeginCeremonyCommand["actor"] {
  return Object.freeze({
    accountId: actor.accountId,
    sessionId: actor.sessionId,
    deviceId: actor.deviceId
  });
}

function copyBoundary(boundary: BeginCeremonyCommand["credentialBoundary"]) {
  return boundary.mode === "discoverable"
    ? Object.freeze({ mode: "discoverable" as const, credentialSetRef: null })
    : Object.freeze({
        mode: "non_discoverable" as const,
        credentialSetRef: boundary.credentialSetRef
      });
}

function copyBeginCommand(command: BeginCeremonyCommand): BeginCeremonyCommand {
  const common = {
    schemaVersion: command.schemaVersion,
    commandId: command.commandId,
    clientNonce: command.clientNonce,
    actor: copyActor(command.actor),
    expectedRevision: command.expectedRevision,
    expectedOrigin: command.expectedOrigin,
    credentialBoundary: copyBoundary(command.credentialBoundary)
  } as const;
  if (command.type === "begin_registration") {
    return Object.freeze({
      ...common,
      type: "begin_registration" as const,
      purpose: Object.freeze({ ...command.purpose }),
      credentialBoundary: Object.freeze({ mode: "discoverable" as const, credentialSetRef: null }),
      userHandleRef: command.userHandleRef
    });
  }
  return Object.freeze({
    ...common,
    type: "begin_authentication" as const,
    purpose: Object.freeze({ ...command.purpose })
  });
}

function copyExistingCommand<T extends VerifyCeremonyCommand | CancelCeremonyCommand | ExpireCeremonyCommand>(
  command: T
): T {
  if (command.type === "expire") {
    return Object.freeze({
      schemaVersion: command.schemaVersion,
      type: command.type,
      commandId: command.commandId,
      actor: Object.freeze({ kind: "system" as const, subject: "ceremony-expirer" as const }),
      expectedRevision: command.expectedRevision,
      ceremonyId: command.ceremonyId
    }) as T;
  }
  const common = {
    schemaVersion: command.schemaVersion,
    type: command.type,
    commandId: command.commandId,
    actor: copyActor(command.actor),
    expectedRevision: command.expectedRevision,
    ceremonyId: command.ceremonyId
  } as const;
  return Object.freeze(command.type === "verify"
    ? {
        ...common,
        responseByteLength: command.responseByteLength,
        responseDigest: command.responseDigest
      }
    : common) as T;
}

function exactObjectKeys(value: object, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function normalizeReceipt<T extends CommandReceipt | CreationReceipt>(receipt: T, expectedScope: string): T {
  if (
    receipt === null
    || typeof receipt !== "object"
    || Array.isArray(receipt)
    || !exactObjectKeys(receipt, ["scope", "fingerprint", "result", "createdAtMs"])
    || receipt.scope !== expectedScope
    || !/^[a-f0-9]{64}$/.test(receipt.fingerprint)
    || !Number.isSafeInteger(receipt.createdAtMs)
    || receipt.createdAtMs < 0
  ) {
    storageIntegrityFailure();
  }
  const result = receipt.result;
  if (
    result === null
    || typeof result !== "object"
    || Array.isArray(result)
    || !exactObjectKeys(result, ["ceremonyId", "revision", "eventId", "snapshot"])
    || typeof result.eventId !== "string"
    || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(result.eventId)
  ) {
    storageIntegrityFailure();
  }
  let snapshot: CeremonyMutation["snapshot"];
  try {
    snapshot = normalizeCeremonySnapshot(result.snapshot);
  } catch {
    storageIntegrityFailure();
  }
  if (
    result.ceremonyId !== snapshot.ceremonyId
    || result.revision !== snapshot.revision
    || receipt.createdAtMs !== snapshot.updatedAtMs
  ) {
    storageIntegrityFailure();
  }
  return Object.freeze({
    scope: receipt.scope,
    fingerprint: receipt.fingerprint,
    result: Object.freeze({
      ceremonyId: snapshot.ceremonyId,
      revision: snapshot.revision,
      eventId: result.eventId,
      snapshot
    }),
    createdAtMs: receipt.createdAtMs
  }) as T;
}

function immutableCeremonyFingerprint(snapshot: CeremonyMutation["snapshot"]): string {
  return digest({
    schemaVersion: snapshot.schemaVersion,
    ceremonyId: snapshot.ceremonyId,
    kind: snapshot.kind,
    purpose: snapshot.purpose,
    actor: snapshot.actor,
    policyVersion: snapshot.policyVersion,
    expectedRpId: snapshot.expectedRpId,
    expectedOrigin: snapshot.expectedOrigin,
    timeoutMs: snapshot.timeoutMs,
    maxResponseBytes: snapshot.maxResponseBytes,
    userVerification: snapshot.userVerification,
    crossOriginAllowed: snapshot.crossOriginAllowed,
    expectedTopOrigins: snapshot.expectedTopOrigins,
    attestation: snapshot.attestation,
    registrationResidentKey: snapshot.registrationResidentKey,
    allowedAlgorithms: snapshot.allowedAlgorithms,
    credentialBoundary: snapshot.credentialBoundary,
    userHandleRef: snapshot.userHandleRef,
    challenge: snapshot.challenge,
    maxAttempts: snapshot.maxAttempts,
    createdAtMs: snapshot.createdAtMs,
    expiresAtMs: snapshot.expiresAtMs
  });
}

function assertBeginReceiptBinding(
  snapshot: CeremonyMutation["snapshot"],
  command: BeginCeremonyCommand
): void {
  const expectedKind = command.type === "begin_registration" ? "registration" : "authentication";
  if (
    snapshot.kind !== expectedKind
    || !actorMatches(snapshot.actor, command.actor)
    || canonical(snapshot.purpose) !== canonical(command.purpose)
    || snapshot.expectedOrigin !== command.expectedOrigin
    || canonical(snapshot.credentialBoundary) !== canonical(command.credentialBoundary)
    || snapshot.userHandleRef !== (command.type === "begin_registration" ? command.userHandleRef : null)
    || snapshot.revision !== 1
    || snapshot.state !== "pending"
    || snapshot.attemptsUsed !== 0
  ) {
    storageIntegrityFailure();
  }
}

function assertExistingReceiptBinding(
  snapshot: CeremonyMutation["snapshot"],
  command: VerifyCeremonyCommand | CancelCeremonyCommand | ExpireCeremonyCommand
): void {
  if (
    snapshot.ceremonyId !== command.ceremonyId
    || snapshot.revision !== command.expectedRevision + 1
    || (command.type !== "expire" && !actorMatches(snapshot.actor, command.actor))
    || (command.type === "verify"
      && !["pending", "consumed", "expired", "rejected"].includes(snapshot.state))
    || (command.type === "cancel" && snapshot.state !== "cancelled" && snapshot.state !== "expired")
    || (command.type === "expire" && snapshot.state !== "expired")
  ) {
    storageIntegrityFailure();
  }
}

function normalizeVerifierResult(
  value: unknown,
  ceremony: CeremonyMutation["snapshot"]
): WebAuthnVerifierResult {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    reject("VALIDATION_FAILED", "verifier result must be an object");
  }
  const result = value as Record<string, unknown>;
  if (result["status"] === "rejected") {
    if (
      !exactObjectKeys(result, ["status", "reason"])
      || (result["reason"] !== "invalid_webauthn_response" && result["reason"] !== "policy_rejected")
    ) {
      reject("VALIDATION_FAILED", "verifier rejection is malformed");
    }
    return Object.freeze({ status: "rejected", reason: result["reason"] });
  }
  if (result["status"] !== "verified" || !exactObjectKeys(result, ["status", "kind", "credential"])) {
    reject("VALIDATION_FAILED", "verifier success is malformed");
  }
  if (result["kind"] === "registration" && ceremony.kind === "registration") {
    const credential = normalizeRegistrationCredential(
      result["credential"] as RegistrationVerifierSuccess["credential"],
      ceremony
    );
    return Object.freeze({ status: "verified", kind: "registration", credential });
  }
  if (result["kind"] === "authentication" && ceremony.kind === "authentication") {
    const credential = normalizeAuthenticationCredential(
      result["credential"] as AuthenticationVerifierSuccess["credential"],
      ceremony
    );
    return Object.freeze({ status: "verified", kind: "authentication", credential });
  }
  reject("VALIDATION_FAILED", "verifier result kind does not match the ceremony");
}

function actorScope(command: CeremonyCommand): unknown {
  return command.type === "expire"
    ? command.actor
    : {
        accountId: command.actor.accountId,
        sessionId: command.actor.sessionId,
        deviceId: command.actor.deviceId
      };
}

function commandScope(command: CeremonyCommand): string {
  return `command:${digest({ actor: actorScope(command), commandId: command.commandId })}`;
}

function commandFingerprint(command: CeremonyCommand): string {
  // VerifyCeremonyCommand deliberately has no WebAuthn response. Its receipt
  // makes the first committed outcome authoritative for all exact retries.
  const base = {
    schemaVersion: command.schemaVersion,
    type: command.type,
    commandId: command.commandId,
    actor: actorScope(command),
    expectedRevision: command.expectedRevision
  };
  switch (command.type) {
    case "begin_registration":
      return digest({
        ...base,
        clientNonce: command.clientNonce,
        purpose: command.purpose,
        expectedOrigin: command.expectedOrigin,
        credentialBoundary: command.credentialBoundary,
        userHandleRef: command.userHandleRef
      });
    case "begin_authentication":
      return digest({
        ...base,
        clientNonce: command.clientNonce,
        purpose: command.purpose,
        expectedOrigin: command.expectedOrigin,
        credentialBoundary: command.credentialBoundary
      });
    case "verify":
      return digest({
        ...base,
        ceremonyId: command.ceremonyId,
        responseByteLength: command.responseByteLength,
        responseDigest: command.responseDigest
      });
    case "cancel":
    case "expire":
      return digest({ ...base, ceremonyId: command.ceremonyId });
  }
}

function creationScope(command: BeginCeremonyCommand): string {
  return `create:${digest({ actor: actorScope(command), clientNonce: command.clientNonce })}`;
}

function creationFingerprint(command: BeginCeremonyCommand): string {
  return digest({
    actor: actorScope(command),
    type: command.type,
    purpose: command.purpose,
    expectedOrigin: command.expectedOrigin,
    credentialBoundary: command.credentialBoundary,
    userHandleRef: command.type === "begin_registration" ? command.userHandleRef : null
  });
}

function storedResult(mutation: CeremonyMutation): StoredCommandResult {
  return {
    ceremonyId: mutation.snapshot.ceremonyId,
    revision: mutation.snapshot.revision,
    eventId: mutation.event.eventId,
    snapshot: mutation.snapshot
  };
}

function replayReceipt(receipt: CommandReceipt | CreationReceipt): ExecutedCeremonyCommand {
  return {
    snapshot: receipt.result.snapshot,
    eventId: receipt.result.eventId,
    outboxId: null,
    replayed: true,
    clientRequirements: null
  };
}

function clientRequirements(snapshot: CeremonyMutation["snapshot"], challenge: string): CeremonyClientRequirements {
  if (snapshot.kind === "registration") {
    const requirements: RegistrationClientRequirements = {
      kind: "registration",
      challenge,
      rpId: snapshot.expectedRpId,
      timeoutMs: snapshot.timeoutMs,
      userVerification: "required",
      residentKey: "required",
      attestation: "none",
      allowedAlgorithms: snapshot.allowedAlgorithms
    };
    return requirements;
  }
  const requirements: AuthenticationClientRequirements = {
    kind: "authentication",
    challenge,
    rpId: snapshot.expectedRpId,
    timeoutMs: snapshot.timeoutMs,
    userVerification: "required",
    credentialMode: snapshot.credentialBoundary.mode
  };
  return requirements;
}

export class PasskeyCeremonyExecutor {
  readonly #store: PasskeyCeremonyStore;
  readonly #clock: Clock;
  readonly #ids: IdGenerator;
  readonly #policy: PasskeyRelyingPartyPolicy;
  readonly #challengeVault: ChallengeSecretVault;
  readonly #verifier: MaintainedWebAuthnVerifierAdapter;

  constructor(input: {
    readonly store: PasskeyCeremonyStore;
    readonly clock: Clock;
    readonly ids: IdGenerator;
    readonly policy: PasskeyRelyingPartyPolicy;
    readonly challengeVault: ChallengeSecretVault;
    readonly verifier: MaintainedWebAuthnVerifierAdapter;
  }) {
    assertMaintainedVerifierDescriptor(input.verifier.implementation);
    this.#store = input.store;
    this.#clock = input.clock;
    this.#ids = input.ids;
    this.#policy = normalizePolicy(input.policy);
    this.#challengeVault = input.challengeVault;
    this.#verifier = input.verifier;
  }

  async #discardBestEffort(reference: string): Promise<void> {
    try {
      await this.#challengeVault.discard(reference);
    } catch {
      // The durable terminal ceremony remains authoritative. The production
      // vault is independently TTL-bounded and must alert on cleanup failures.
    }
  }

  #assertActivePolicy(snapshot: CeremonyMutation["snapshot"]): CeremonyMutation["snapshot"] {
    try {
      assertCeremonyMatchesPolicy(snapshot, this.#policy);
      return normalizeCeremonySnapshot(snapshot);
    } catch {
      storageIntegrityFailure();
    }
  }

  async #loadCeremony(ceremonyId: string): Promise<CeremonyMutation["snapshot"] | null> {
    let loaded: CeremonyMutation["snapshot"] | null;
    try {
      loaded = await this.#store.loadCeremony(ceremonyId);
    } catch {
      reject("STORAGE_UNAVAILABLE", "passkey ceremony storage is unavailable");
    }
    return loaded === null ? null : this.#assertActivePolicy(loaded);
  }

  async #findCommandReceipt(scope: string): Promise<CommandReceipt | null> {
    let receipt: CommandReceipt | null;
    try {
      receipt = await this.#store.findCommandReceipt(scope);
    } catch {
      reject("STORAGE_UNAVAILABLE", "passkey ceremony storage is unavailable");
    }
    if (receipt === null) return null;
    try {
      const normalized = normalizeReceipt(receipt, scope);
      const snapshot = this.#assertActivePolicy(normalized.result.snapshot);
      return Object.freeze({
        ...normalized,
        result: Object.freeze({ ...normalized.result, snapshot })
      });
    } catch {
      storageIntegrityFailure();
    }
  }

  async #findCreationReceipt(scope: string): Promise<CreationReceipt | null> {
    let receipt: CreationReceipt | null;
    try {
      receipt = await this.#store.findCreationReceipt(scope);
    } catch {
      reject("STORAGE_UNAVAILABLE", "passkey ceremony storage is unavailable");
    }
    if (receipt === null) return null;
    try {
      const normalized = normalizeReceipt(receipt, scope);
      const snapshot = this.#assertActivePolicy(normalized.result.snapshot);
      return Object.freeze({
        ...normalized,
        result: Object.freeze({ ...normalized.result, snapshot })
      });
    } catch {
      storageIntegrityFailure();
    }
  }

  async #assertReceiptHasCurrentAggregate(receipt: CommandReceipt): Promise<void> {
    const recorded = receipt.result.snapshot;
    const current = await this.#loadCeremony(recorded.ceremonyId);
    if (
      current === null
      || current.revision < recorded.revision
      || immutableCeremonyFingerprint(current) !== immutableCeremonyFingerprint(recorded)
    ) {
      storageIntegrityFailure();
    }
  }

  async #resolveChallenge(reference: string, snapshot: CeremonyMutation["snapshot"]): Promise<string> {
    let challenge: string | null;
    try {
      challenge = await this.#challengeVault.resolve(reference);
    } catch {
      reject("CHALLENGE_UNAVAILABLE", "challenge secret is unavailable", snapshot);
    }
    if (challenge === null) {
      reject("CHALLENGE_UNAVAILABLE", "challenge secret is unavailable", snapshot);
    }
    try {
      assertChallengeMatchesDescriptor(challenge, snapshot.challenge);
    } catch (error) {
      if (error instanceof PasskeyDomainError) throw error;
      reject("CHALLENGE_UNAVAILABLE", "challenge secret is unavailable", snapshot);
    }
    return challenge;
  }

  async #replayBegin(
    receipt: CommandReceipt | CreationReceipt,
    command: BeginCeremonyCommand
  ): Promise<ExecutedCeremonyCommand> {
    const recorded = receipt.result.snapshot;
    assertBeginReceiptBinding(recorded, command);
    const current = await this.#loadCeremony(recorded.ceremonyId);
    if (current === null) storageIntegrityFailure();
    if (
      current.revision < recorded.revision
      || immutableCeremonyFingerprint(current) !== immutableCeremonyFingerprint(recorded)
    ) {
      storageIntegrityFailure();
    }
    const snapshot = current;
    if (snapshot.state !== "pending") {
      return {
        snapshot,
        eventId: receipt.result.eventId,
        outboxId: null,
        replayed: true,
        clientRequirements: null
      };
    }
    const replayNowMs = this.#clock.nowMs();
    assertInteger("nowMs", replayNowMs);
    if (replayNowMs < snapshot.updatedAtMs) {
      reject("VALIDATION_FAILED", "ceremony clock moved backwards", snapshot);
    }
    if (replayNowMs >= snapshot.expiresAtMs) {
      reject("CHALLENGE_UNAVAILABLE", "ceremony challenge has expired", snapshot);
    }
    let raw: string | null;
    try {
      raw = await this.#challengeVault.resolve(snapshot.challenge.reference);
    } catch {
      reject("CHALLENGE_UNAVAILABLE", "challenge secret is unavailable", snapshot);
    }
    if (raw !== null) {
      try {
        assertChallengeMatchesDescriptor(raw, snapshot.challenge);
      } catch (error) {
        if (error instanceof PasskeyDomainError) throw error;
        reject("CHALLENGE_UNAVAILABLE", "challenge secret is unavailable", snapshot);
      }
      return {
        snapshot,
        eventId: receipt.result.eventId,
        outboxId: null,
        replayed: true,
        clientRequirements: clientRequirements(snapshot, raw)
      };
    }
    reject("CHALLENGE_UNAVAILABLE", "challenge secret is unavailable", snapshot);
  }

  /**
   * Replays an already-committed begin only when its exact command receipt
   * exists, without creating any new ceremony state or consulting the broader
   * clientNonce creation receipt.
   *
   * A null result means that the actor-scoped command receipt does not exist.
   * Receipt conflicts and corrupt durable state remain errors so callers cannot
   * mistake unsafe commandId reuse for a cache miss.
   */
  async replayBeginExact(command: BeginCeremonyCommand): Promise<ExecutedCeremonyCommand | null> {
    assertBeginCommand(command, this.#policy);
    command = copyBeginCommand(command);

    const scope = commandScope(command);
    const fingerprint = commandFingerprint(command);
    const priorCommand = await this.#findCommandReceipt(scope);
    if (priorCommand !== null) {
      if (priorCommand.fingerprint !== fingerprint) {
        throw new PasskeyDomainError("IDEMPOTENCY_KEY_REUSED", "commandId was reused with a different safe command");
      }
      return this.#replayBegin(priorCommand, command);
    }
    return null;
  }

  async begin(command: BeginCeremonyCommand): Promise<ExecutedCeremonyCommand> {
    assertBeginCommand(command, this.#policy);
    command = copyBeginCommand(command);
    const scope = commandScope(command);
    const fingerprint = commandFingerprint(command);
    const priorCommand = await this.#findCommandReceipt(scope);
    if (priorCommand !== null) {
      if (priorCommand.fingerprint !== fingerprint) {
        throw new PasskeyDomainError("IDEMPOTENCY_KEY_REUSED", "commandId was reused with a different safe command");
      }
      return this.#replayBegin(priorCommand, command);
    }

    const createScope = creationScope(command);
    const createFingerprint = creationFingerprint(command);
    const priorCreation = await this.#findCreationReceipt(createScope);
    if (priorCreation !== null) {
      if (priorCreation.fingerprint !== createFingerprint) {
        throw new PasskeyDomainError("CREATION_NONCE_REUSED", "clientNonce was reused for different ceremony input");
      }
      return this.#replayBegin(priorCreation, command);
    }

    const nowMs = this.#clock.nowMs();
    assertInteger("nowMs", nowMs);
    if (nowMs > Number.MAX_SAFE_INTEGER - this.#policy.timeoutMs) {
      reject("VALIDATION_FAILED", "ceremony expiry would exceed the safe integer range");
    }
    let issued: Awaited<ReturnType<ChallengeSecretVault["issue"]>>;
    try {
      issued = await this.#challengeVault.issue({
        byteLength: PASSKEY_CHALLENGE_BYTES,
        expiresAtMs: nowMs + this.#policy.timeoutMs
      });
    } catch {
      reject("CHALLENGE_UNAVAILABLE", "challenge secret could not be issued");
    }
    let descriptor: ReturnType<typeof describeIssuedChallenge>;
    try {
      descriptor = describeIssuedChallenge(issued);
    } catch (error) {
      try {
        await this.#discardBestEffort(issued.reference);
      } catch {
        // The issued secret remains TTL-bounded even for a malformed result.
      }
      if (error instanceof PasskeyDomainError) throw error;
      reject("CHALLENGE_UNAVAILABLE", "challenge vault returned an invalid secret descriptor");
    }
    let mutation: CeremonyMutation;
    try {
      mutation = startCeremony(command, descriptor, this.#policy, { nowMs, ids: this.#ids });
    } catch (error) {
      await this.#discardBestEffort(descriptor.reference);
      if (error instanceof PasskeyDomainError) throw error;
      reject("VALIDATION_FAILED", "ceremony identifiers could not be generated safely");
    }
    const result = storedResult(mutation);
    const commandReceipt: CommandReceipt = { scope, fingerprint, result, createdAtMs: nowMs };
    const creationReceipt: CreationReceipt = {
      scope: createScope,
      fingerprint: createFingerprint,
      result,
      createdAtMs: nowMs
    };

    try {
      await this.#store.commit({
        expectedRevision: null,
        mutation,
        commandReceipt,
        creationReceipt
      });
    } catch (error) {
      // Reconcile even an ambiguous store error. If our transaction committed,
      // deleting its challenge here would strand a live ceremony.
      const commandWinner = await this.#findCommandReceipt(scope);
      if (commandWinner !== null) {
        if (commandWinner.fingerprint !== fingerprint) {
          await this.#discardBestEffort(descriptor.reference);
          throw new PasskeyDomainError("IDEMPOTENCY_KEY_REUSED", "concurrent commandId reuse did not match");
        }
        if (commandWinner.result.snapshot.challenge.reference !== descriptor.reference) {
          await this.#discardBestEffort(descriptor.reference);
        }
        return this.#replayBegin(commandWinner, command);
      }
      const creationWinner = await this.#findCreationReceipt(createScope);
      if (creationWinner !== null) {
        if (creationWinner.fingerprint !== createFingerprint) {
          await this.#discardBestEffort(descriptor.reference);
          throw new PasskeyDomainError("CREATION_NONCE_REUSED", "concurrent clientNonce reuse did not match");
        }
        if (creationWinner.result.snapshot.challenge.reference !== descriptor.reference) {
          await this.#discardBestEffort(descriptor.reference);
        }
        return this.#replayBegin(creationWinner, command);
      }
      if (error instanceof StoreAuthorizationConflictError) {
        await this.#discardBestEffort(descriptor.reference);
        throw new PasskeyDomainError("FORBIDDEN", "passkey ceremony authorization precondition failed");
      }
      if (
        error instanceof StoreDuplicateCommandError
        || error instanceof StoreDuplicateCreationError
        || error instanceof StoreRevisionConflictError
      ) {
        await this.#discardBestEffort(descriptor.reference);
      }
      reject("STORAGE_UNAVAILABLE", "passkey ceremony storage did not confirm the commit");
    }

    return {
      snapshot: mutation.snapshot,
      eventId: mutation.event.eventId,
      outboxId: mutation.outbox.outboxId,
      replayed: false,
      clientRequirements: clientRequirements(mutation.snapshot, issued.challenge)
    };
  }

  async #loadPending(command: VerifyCeremonyCommand | CancelCeremonyCommand | ExpireCeremonyCommand) {
    const current = await this.#loadCeremony(command.ceremonyId);
    if (current === null) reject("NOT_FOUND", "passkey ceremony was not found");
    if (command.type !== "expire" && !actorMatches(current.actor, command.actor)) {
      // Conceal both ceremony existence and every actor/challenge/store binding.
      reject("NOT_FOUND", "passkey ceremony was not found for this actor");
    }
    if (current.state !== "pending") {
      reject("TERMINAL_CEREMONY", `ceremony is already ${current.state}`, current);
    }
    if (command.expectedRevision !== current.revision) {
      reject("REVISION_CONFLICT", "expectedRevision is stale", current);
    }
    return current;
  }

  async #commitExisting(
    command: VerifyCeremonyCommand | CancelCeremonyCommand | ExpireCeremonyCommand,
    mutation: CeremonyMutation,
    scope: string,
    fingerprint: string,
    nowMs: number
  ): Promise<ExecutedCeremonyCommand> {
    const result = storedResult(mutation);
    const receipt: CommandReceipt = { scope, fingerprint, result, createdAtMs: nowMs };
    const input: PersistCeremonyMutation = {
      expectedRevision: command.expectedRevision,
      mutation,
      commandReceipt: receipt,
      creationReceipt: null
    };
    try {
      await this.#store.commit(input);
    } catch (error) {
      // A receipt also resolves an ambiguous after-commit transport failure.
      const winnerReceipt = await this.#findCommandReceipt(scope);
      if (winnerReceipt !== null) {
        if (winnerReceipt.fingerprint !== fingerprint) {
          throw new PasskeyDomainError("IDEMPOTENCY_KEY_REUSED", "concurrent commandId reuse did not match");
        }
        assertExistingReceiptBinding(winnerReceipt.result.snapshot, command);
        await this.#assertReceiptHasCurrentAggregate(winnerReceipt);
        return replayReceipt(winnerReceipt);
      }
      if (error instanceof StoreRevisionConflictError) {
        const winner = await this.#loadCeremony(command.ceremonyId);
        if (winner !== null && command.type !== "expire" && !actorMatches(winner.actor, command.actor)) {
          storageIntegrityFailure();
        }
        throw new PasskeyDomainError("REVISION_CONFLICT", "another ceremony command committed first", winner);
      }
      if (error instanceof StoreCredentialConflictError) {
        throw new PasskeyDomainError("CREDENTIAL_CONFLICT", "credential is already registered");
      }
      if (error instanceof StoreCredentialStateConflictError) {
        throw new PasskeyDomainError(
          "CREDENTIAL_STATE_CONFLICT",
          "credential state changed before authentication could commit"
        );
      }
      reject("STORAGE_UNAVAILABLE", "passkey ceremony storage did not confirm the commit");
    }
    return {
      snapshot: mutation.snapshot,
      eventId: mutation.event.eventId,
      outboxId: mutation.outbox.outboxId,
      replayed: false,
      clientRequirements: null
    };
  }

  async #priorExisting(command: VerifyCeremonyCommand | CancelCeremonyCommand | ExpireCeremonyCommand) {
    const scope = commandScope(command);
    const fingerprint = commandFingerprint(command);
    const receipt = await this.#findCommandReceipt(scope);
    if (receipt !== null) {
      if (receipt.fingerprint !== fingerprint) {
        throw new PasskeyDomainError("IDEMPOTENCY_KEY_REUSED", "commandId was reused with a different safe command");
      }
      assertExistingReceiptBinding(receipt.result.snapshot, command);
      await this.#assertReceiptHasCurrentAggregate(receipt);
      return { scope, fingerprint, replay: replayReceipt(receipt) };
    }
    return { scope, fingerprint, replay: null };
  }

  async verify(command: VerifyCeremonyCommand, opaqueResponse: unknown): Promise<ExecutedCeremonyCommand> {
    if (command.type !== "verify") reject("VALIDATION_FAILED", "verify() requires a verify command");
    assertExistingCommand(command, this.#policy);
    command = copyExistingCommand(command);
    const prior = await this.#priorExisting(command);
    if (prior.replay !== null) return prior.replay;
    const current = await this.#loadPending(command);
    if (command.responseByteLength > current.maxResponseBytes) {
      reject("VALIDATION_FAILED", "response exceeds the ceremony's bound", current);
    }
    let nowMs = this.#clock.nowMs();
    assertInteger("nowMs", nowMs);
    if (nowMs < current.updatedAtMs) {
      reject("VALIDATION_FAILED", "ceremony clock moved backwards", current);
    }
    let mutation: CeremonyMutation;
    if (nowMs >= current.expiresAtMs) {
      mutation = expireCeremony(current, command.commandId, command.expectedRevision, { nowMs, ids: this.#ids });
    } else {
      const challenge = await this.#resolveChallenge(current.challenge.reference, current);
      nowMs = this.#clock.nowMs();
      assertInteger("nowMs", nowMs);
      if (nowMs < current.updatedAtMs) {
        reject("VALIDATION_FAILED", "ceremony clock moved backwards", current);
      }
      if (nowMs >= current.expiresAtMs) {
        mutation = expireCeremony(current, command.commandId, command.expectedRevision, { nowMs, ids: this.#ids });
      } else {
        let verifierResult: WebAuthnVerifierResult;
        try {
          const untrustedResult = current.kind === "registration"
            ? await this.#verifier.verifyRegistration(opaqueResponse, {
                kind: "registration",
                expectedChallenge: challenge,
                expectedRpId: current.expectedRpId,
                expectedOrigin: current.expectedOrigin,
                expectedTopOrigins: [],
                crossOriginAllowed: false,
                requireUserPresence: true,
                requireUserVerification: true,
                attestation: "none",
                residentKey: "required",
                allowedAlgorithms: current.allowedAlgorithms,
                expectedAccountId: current.actor.accountId,
                expectedUserHandleRef: current.userHandleRef as string,
                purpose: current.purpose as RegistrationVerificationExpectations["purpose"],
                maxResponseBytes: current.maxResponseBytes,
                responseByteLength: command.responseByteLength
              })
            : await this.#verifier.verifyAuthentication(opaqueResponse, {
                kind: "authentication",
                expectedChallenge: challenge,
                expectedRpId: current.expectedRpId,
                expectedOrigin: current.expectedOrigin,
                expectedTopOrigins: [],
                crossOriginAllowed: false,
                requireUserPresence: true,
                requireUserVerification: true,
                allowedAlgorithms: current.allowedAlgorithms,
                expectedAccountId: current.actor.accountId,
                credentialBoundary: current.credentialBoundary,
                purpose: current.purpose as AuthenticationVerificationExpectations["purpose"],
                maxResponseBytes: current.maxResponseBytes,
                responseByteLength: command.responseByteLength
              });
          verifierResult = normalizeVerifierResult(untrustedResult, current);
        } catch {
          throw new PasskeyDomainError(
            "VERIFIER_UNAVAILABLE",
            "maintained WebAuthn verifier did not produce a valid result",
            current
          );
        }

        // A verifier may cross the expiry boundary. Its result cannot consume
        // a ceremony merely because verification began before expiry.
        nowMs = this.#clock.nowMs();
        assertInteger("nowMs", nowMs);
        mutation = nowMs >= current.expiresAtMs
          ? expireCeremony(current, command.commandId, command.expectedRevision, { nowMs, ids: this.#ids })
          : verifierResult.status === "rejected"
            ? rejectVerificationAttempt(current, command.commandId, command.expectedRevision, { nowMs, ids: this.#ids })
            : consumeVerifiedCeremony(
                current,
                command.commandId,
                command.expectedRevision,
                verifierResult,
                { nowMs, ids: this.#ids }
              );
      }
    }

    const executed = await this.#commitExisting(command, mutation, prior.scope, prior.fingerprint, nowMs);
    if (executed.snapshot.state !== "pending") {
      await this.#discardBestEffort(current.challenge.reference);
    }
    return executed;
  }

  async cancel(command: CancelCeremonyCommand): Promise<ExecutedCeremonyCommand> {
    if (command.type !== "cancel") reject("VALIDATION_FAILED", "cancel() requires a cancel command");
    assertExistingCommand(command, this.#policy);
    command = copyExistingCommand(command);
    const prior = await this.#priorExisting(command);
    if (prior.replay !== null) return prior.replay;
    const current = await this.#loadPending(command);
    const nowMs = this.#clock.nowMs();
    const mutation = cancelCeremony(
      current,
      command.commandId,
      command.actor,
      command.expectedRevision,
      { nowMs, ids: this.#ids }
    );
    const executed = await this.#commitExisting(command, mutation, prior.scope, prior.fingerprint, nowMs);
    if (executed.snapshot.state !== "pending") {
      await this.#discardBestEffort(current.challenge.reference);
    }
    return executed;
  }

  async expire(command: ExpireCeremonyCommand): Promise<ExecutedCeremonyCommand> {
    if (command.type !== "expire") reject("VALIDATION_FAILED", "expire() requires an expire command");
    assertExistingCommand(command, this.#policy);
    command = copyExistingCommand(command);
    const prior = await this.#priorExisting(command);
    if (prior.replay !== null) return prior.replay;
    const current = await this.#loadPending(command);
    const nowMs = this.#clock.nowMs();
    const mutation = expireCeremony(
      current,
      command.commandId,
      command.expectedRevision,
      { nowMs, ids: this.#ids }
    );
    const executed = await this.#commitExisting(command, mutation, prior.scope, prior.fingerprint, nowMs);
    await this.#discardBestEffort(current.challenge.reference);
    return executed;
  }
}

/** Exposed only for deterministic receipt/store contract tests. */
export const safeCommandFingerprintForTesting = commandFingerprint;
