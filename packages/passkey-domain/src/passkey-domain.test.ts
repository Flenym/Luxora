import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  PasskeyDomainError,
  StoreAuthorizationConflictError,
  StoreCredentialConflictError,
  StoreCredentialStateConflictError,
  StoreDuplicateCommandError,
  StoreDuplicateCreationError,
  StoreRevisionConflictError
} from "./errors.js";
import { PasskeyCeremonyExecutor } from "./executor.js";
import { createLuxoraPasskeyPolicy } from "./policy.js";
import { rejectVerificationAttempt, startCeremony, toSafeCeremonyLogFields } from "./state-machine.js";
import {
  PASSKEY_CHALLENGE_BYTES,
  PASSKEY_DOMAIN_VERSION,
  type AuthenticationVerificationExpectations,
  type BeginAuthenticationCommand,
  type BeginRegistrationCommand,
  type CeremonyAggregate,
  type ChallengeSecretVault,
  type Clock,
  type CommandReceipt,
  type CreationReceipt,
  type IdGenerator,
  type IssuedChallenge,
  type MaintainedWebAuthnVerifierAdapter,
  type PasskeyCeremonyStore,
  type PasskeyRiskSignal,
  type PersistCeremonyMutation,
  type RegistrationVerificationExpectations,
  type WebAuthnVerifierResult
} from "./types.js";
import { assertCeremonyInvariants, authenticationRiskSignals } from "./validation.js";

const actor = Object.freeze({ accountId: "account-1", sessionId: "session-1", deviceId: "device-1" });
const origin = "https://auth.luxora.app";
const targetDigest = "a".repeat(64);
const responseDigest = "c".repeat(64);
const publicKeyCanary = "PUBLIC_KEY_CANARY_DO_NOT_LOG";
const opaqueResponseCanary = "OPAQUE_WEBAUTHN_RESPONSE_DO_NOT_LOG";

class TestClock implements Clock {
  value = 1_000_000;
  nowMs(): number {
    return this.value;
  }
}

class TestIds implements IdGenerator {
  readonly counts = new Map<string, number>();
  next(purpose: "ceremony" | "event" | "outbox" | "credential-record"): string {
    const count = (this.counts.get(purpose) ?? 0) + 1;
    this.counts.set(purpose, count);
    return `${purpose}-${count}`;
  }
}

class TestChallengeVault implements ChallengeSecretVault {
  readonly secrets = new Map<string, string>();
  issueCount = 0;
  resolveCount = 0;
  discardCount = 0;
  resolveError: Error | null = null;

  async issue(input: { readonly byteLength: 32; readonly expiresAtMs: number }): Promise<IssuedChallenge> {
    expect(input.byteLength).toBe(PASSKEY_CHALLENGE_BYTES);
    expect(input.expiresAtMs).toBeGreaterThan(0);
    this.issueCount += 1;
    const reference = `challenge-ref-${this.issueCount}`;
    const bytes = Buffer.alloc(PASSKEY_CHALLENGE_BYTES, this.issueCount);
    const challenge = bytes.toString("base64url");
    this.secrets.set(reference, challenge);
    return { reference, challenge };
  }

  async resolve(reference: string): Promise<string | null> {
    this.resolveCount += 1;
    if (this.resolveError !== null) throw this.resolveError;
    return this.secrets.get(reference) ?? null;
  }

  async discard(reference: string): Promise<void> {
    this.discardCount += 1;
    this.secrets.delete(reference);
  }
}

class TestStore implements PasskeyCeremonyStore {
  readonly ceremonies = new Map<string, CeremonyAggregate>();
  readonly commands = new Map<string, CommandReceipt>();
  readonly creations = new Map<string, CreationReceipt>();
  readonly commits: PersistCeremonyMutation[] = [];
  commandReceiptFindCount = 0;
  creationReceiptFindCount = 0;
  readonly credentialIds = new Set<string>();
  readonly credentialStates = new Map<string, {
    accountId: string;
    revision: number;
    signCount: number;
    backupEligible: boolean;
    backupState: boolean;
  }>([["credential-record-existing", {
    accountId: actor.accountId,
    revision: 1,
    signCount: 9,
    backupEligible: true,
    backupState: false
  }]]);
  errorBeforeNextCommit: Error | null = null;
  errorAfterNextCommit: Error | null = null;
  throwAfterNextCommit = false;

  async loadCeremony(ceremonyId: string): Promise<CeremonyAggregate | null> {
    return this.ceremonies.get(ceremonyId) ?? null;
  }

  async findCommandReceipt(scope: string): Promise<CommandReceipt | null> {
    this.commandReceiptFindCount += 1;
    return this.commands.get(scope) ?? null;
  }

  async findCreationReceipt(scope: string): Promise<CreationReceipt | null> {
    this.creationReceiptFindCount += 1;
    return this.creations.get(scope) ?? null;
  }

  async commit(input: PersistCeremonyMutation): Promise<void> {
    if (this.errorBeforeNextCommit !== null) {
      const error = this.errorBeforeNextCommit;
      this.errorBeforeNextCommit = null;
      throw error;
    }
    if (this.commands.has(input.commandReceipt.scope)) throw new StoreDuplicateCommandError();
    if (input.creationReceipt !== null && this.creations.has(input.creationReceipt.scope)) {
      throw new StoreDuplicateCreationError();
    }
    const current = this.ceremonies.get(input.mutation.snapshot.ceremonyId);
    if (input.expectedRevision === null) {
      if (current !== undefined) throw new StoreRevisionConflictError();
    } else if (current === undefined || current.revision !== input.expectedRevision) {
      throw new StoreRevisionConflictError();
    }
    const effect = input.mutation.secureCredentialEffect;
    if (effect?.type === "store_registration_credential") {
      if (this.credentialIds.has(effect.credential.credentialId)) {
        throw new StoreCredentialConflictError();
      }
      this.credentialIds.add(effect.credential.credentialId);
    }
    if (effect?.type === "update_authentication_credential") {
      const prior = this.credentialStates.get(effect.credential.credentialRecordId);
      if (
        prior === undefined
        || prior.accountId !== effect.credential.accountId
        || prior.revision !== effect.credential.credentialRevision
        || prior.signCount !== effect.credential.previousSignCount
        || prior.backupEligible !== effect.credential.previousBackupEligible
        || prior.backupState !== effect.credential.previousBackupState
      ) {
        throw new StoreCredentialStateConflictError();
      }
      this.credentialStates.set(effect.credential.credentialRecordId, {
        accountId: prior.accountId,
        revision: prior.revision + 1,
        signCount: Math.max(prior.signCount, effect.credential.newSignCount),
        backupEligible: prior.backupEligible,
        backupState: prior.backupEligible ? effect.credential.backupState : false
      });
    }
    this.ceremonies.set(input.mutation.snapshot.ceremonyId, input.mutation.snapshot);
    this.commands.set(input.commandReceipt.scope, input.commandReceipt);
    if (input.creationReceipt !== null) this.creations.set(input.creationReceipt.scope, input.creationReceipt);
    this.commits.push(input);
    if (this.errorAfterNextCommit !== null) {
      const error = this.errorAfterNextCommit;
      this.errorAfterNextCommit = null;
      throw error;
    }
    if (this.throwAfterNextCommit) {
      this.throwAfterNextCommit = false;
      throw new Error("simulated ambiguous after-commit transport failure");
    }
  }
}

class TestVerifier implements MaintainedWebAuthnVerifierAdapter {
  readonly implementation = {
    kind: "maintained-webauthn-server-library" as const,
    libraryName: "test-maintained-verifier-double",
    libraryVersion: "1.0.0",
    reviewReference: "test-review-1"
  };
  readonly registrationCalls: Array<{ response: unknown; expectations: RegistrationVerificationExpectations }> = [];
  readonly authenticationCalls: Array<{ response: unknown; expectations: AuthenticationVerificationExpectations }> = [];
  registrationResult: WebAuthnVerifierResult = { status: "rejected", reason: "invalid_webauthn_response" };
  authenticationResult: WebAuthnVerifierResult = { status: "rejected", reason: "invalid_webauthn_response" };
  registrationGate: Promise<void> | null = null;
  registrationError: Error | null = null;

  async verifyRegistration(response: unknown, expectations: RegistrationVerificationExpectations) {
    this.registrationCalls.push({ response, expectations });
    if (this.registrationGate !== null) await this.registrationGate;
    if (this.registrationError !== null) throw this.registrationError;
    const result = this.registrationResult;
    if (result.status === "verified" && result.kind !== "registration") throw new Error("wrong test result kind");
    return result.status === "rejected" ? result : result;
  }

  async verifyAuthentication(response: unknown, expectations: AuthenticationVerificationExpectations) {
    this.authenticationCalls.push({ response, expectations });
    const result = this.authenticationResult;
    if (result.status === "verified" && result.kind !== "authentication") throw new Error("wrong test result kind");
    return result.status === "rejected" ? result : result;
  }
}

function registrationCommand(overrides: Partial<BeginRegistrationCommand> = {}): BeginRegistrationCommand {
  return {
    schemaVersion: PASSKEY_DOMAIN_VERSION,
    type: "begin_registration",
    commandId: "command-begin-registration",
    clientNonce: "nonce-registration-1",
    actor,
    expectedRevision: 0,
    purpose: { type: "authenticator.add", targetDigest },
    expectedOrigin: origin,
    credentialBoundary: { mode: "discoverable", credentialSetRef: null },
    userHandleRef: "user-handle-ref-1",
    ...overrides
  };
}

function authenticationCommand(
  mode: "discoverable" | "non_discoverable" = "discoverable",
  overrides: Partial<BeginAuthenticationCommand> = {}
): BeginAuthenticationCommand {
  return {
    schemaVersion: PASSKEY_DOMAIN_VERSION,
    type: "begin_authentication",
    commandId: `command-begin-auth-${mode}`,
    clientNonce: `nonce-auth-${mode}`,
    actor,
    expectedRevision: 0,
    purpose: { type: "session.step_up", targetDigest },
    expectedOrigin: origin,
    credentialBoundary: mode === "discoverable"
      ? { mode, credentialSetRef: null }
      : { mode, credentialSetRef: "secure-credential-set-1" },
    ...overrides
  };
}

function makeRegistrationSuccess() {
  return {
    status: "verified" as const,
    kind: "registration" as const,
    credential: {
      credentialId: "Y3JlZGVudGlhbC0x",
      publicKey: new TextEncoder().encode(publicKeyCanary),
      algorithm: -7 as const,
      accountId: actor.accountId,
      userHandleRef: "user-handle-ref-1",
      discoveryMode: "discoverable" as const,
      signCount: 0,
      backupEligible: false,
      backupState: false,
      transports: ["internal", "cable"],
      userPresent: true as const,
      userVerified: true as const
    }
  };
}

function makeAuthenticationSuccess(mode: "discoverable" | "non_discoverable") {
  return {
    status: "verified" as const,
    kind: "authentication" as const,
    credential: {
      credentialRecordId: "credential-record-existing",
      credentialRevision: 1,
      accountId: actor.accountId,
      discoveryMode: mode,
      userHandleBindingVerified: true as const,
      previousSignCount: 9,
      newSignCount: 10,
      previousBackupEligible: true,
      backupEligible: true,
      previousBackupState: false,
      backupState: true,
      userPresent: true as const,
      userVerified: true as const
    }
  };
}

function harness(maxAttempts = 3) {
  const store = new TestStore();
  const clock = new TestClock();
  const ids = new TestIds();
  const vault = new TestChallengeVault();
  const verifier = new TestVerifier();
  const policy = createLuxoraPasskeyPolicy({ maxAttempts });
  const executor = new PasskeyCeremonyExecutor({ store, clock, ids, policy, challengeVault: vault, verifier });
  return { store, clock, ids, vault, verifier, policy, executor };
}

async function expectCode(promise: Promise<unknown>, code: PasskeyDomainError["code"]): Promise<void> {
  try {
    await promise;
    throw new Error(`expected ${code}`);
  } catch (error) {
    expect(error).toBeInstanceOf(PasskeyDomainError);
    expect((error as PasskeyDomainError).code).toBe(code);
  }
}

async function captureDomainError(promise: Promise<unknown>): Promise<PasskeyDomainError> {
  try {
    await promise;
    throw new Error("expected PasskeyDomainError");
  } catch (error) {
    expect(error).toBeInstanceOf(PasskeyDomainError);
    return error as PasskeyDomainError;
  }
}

describe("relying-party and binding policy", () => {
  it.each([
    ["wildcard", ["https://*.luxora.app"]],
    ["path", ["https://auth.luxora.app/login"]],
    ["unscoped host", ["https://evil.example"]],
    ["insecure", ["http://auth.luxora.app"]]
  ])("rejects %s origins", (_name, allowedOrigins) => {
    expect(() => createLuxoraPasskeyPolicy({ allowedOrigins })).toThrow(PasskeyDomainError);
  });

  it("binds an authenticated account/session/device and exact origin into the aggregate", async () => {
    const { executor, store, vault } = harness();
    const result = await executor.begin(registrationCommand());
    expect(result.clientRequirements).toMatchObject({
      kind: "registration",
      rpId: "auth.luxora.app",
      timeoutMs: 300_000,
      userVerification: "required",
      residentKey: "required",
      attestation: "none",
      allowedAlgorithms: [-7, -257]
    });
    expect(result.snapshot).toMatchObject({
      actor,
      expectedRpId: "auth.luxora.app",
      expectedOrigin: origin,
      crossOriginAllowed: false,
      expectedTopOrigins: [],
      state: "pending",
      attemptsUsed: 0,
      maxAttempts: 3
    });
    const rawChallenge = result.clientRequirements?.challenge;
    expect(rawChallenge).toBe(vault.secrets.get(result.snapshot.challenge.reference));
    expect(result.snapshot.challenge.digest).toBe(
      createHash("sha256").update(Buffer.from(rawChallenge ?? "", "base64url")).digest("hex")
    );
    const durable = JSON.stringify(store.commits[0]);
    expect(durable).not.toContain(rawChallenge);
    expect(durable).not.toContain("expectedChallenge");
    expect(store.commits).toHaveLength(1);
  });

  it("rejects a verifier that does not declare an exact maintained-library review", () => {
    const { store, clock, ids, vault, verifier, policy } = harness();
    const invalidVerifier: MaintainedWebAuthnVerifierAdapter = {
      implementation: {
        kind: "maintained-webauthn-server-library" as const,
        libraryName: "custom-parser",
        libraryVersion: "latest",
        reviewReference: "review"
      },
      verifyRegistration: verifier.verifyRegistration.bind(verifier),
      verifyAuthentication: verifier.verifyAuthentication.bind(verifier)
    };
    expect(() => new PasskeyCeremonyExecutor({
      store,
      clock,
      ids,
      policy,
      challengeVault: vault,
      verifier: invalidVerifier
    })).toThrow(PasskeyDomainError);
  });

  it("rejects a vault reference that embeds the raw 32-byte challenge", async () => {
    class LeakingVault extends TestChallengeVault {
      override async issue(input: { readonly byteLength: 32; readonly expiresAtMs: number }) {
        const issued = await super.issue(input);
        return { ...issued, reference: `reference-${issued.challenge}` };
      }
    }
    const { store, clock, ids, verifier, policy } = harness();
    const leakingVault = new LeakingVault();
    const executor = new PasskeyCeremonyExecutor({
      store,
      clock,
      ids,
      policy,
      challengeVault: leakingVault,
      verifier
    });
    await expectCode(executor.begin(registrationCommand()), "VALIDATION_FAILED");
    expect(store.commits).toHaveLength(0);
    expect(leakingVault.discardCount).toBe(1);
  });

  it("rejects a different authenticated device before challenge resolution or verifier work", async () => {
    const { executor, store, vault, verifier } = harness();
    const begun = await executor.begin(registrationCommand());
    const resolvesBefore = vault.resolveCount;
    const error = await captureDomainError(executor.verify({
      schemaVersion: PASSKEY_DOMAIN_VERSION,
      type: "verify",
      commandId: "verify-wrong-device",
      ceremonyId: begun.snapshot.ceremonyId,
      actor: { ...actor, deviceId: "device-attacker" },
      expectedRevision: 1,
      responseByteLength: 100,
      responseDigest
    }, { data: opaqueResponseCanary }));
    expect(error.code).toBe("NOT_FOUND");
    expect(error.currentState).toBeNull();
    const serializedError = JSON.stringify(error);
    expect(serializedError).not.toContain(actor.accountId);
    expect(serializedError).not.toContain(actor.sessionId);
    expect(serializedError).not.toContain(actor.deviceId);
    expect(serializedError).not.toContain(begun.snapshot.challenge.reference);
    expect(serializedError).not.toContain(begun.snapshot.challenge.digest);
    expect(vault.resolveCount).toBe(resolvesBefore);
    expect(verifier.registrationCalls).toHaveLength(0);
    expect(store.ceremonies.get(begun.snapshot.ceremonyId)?.attemptsUsed).toBe(0);
  });
});

describe("read-only exact begin receipt replay", () => {
  it("returns null without reading creation receipts or mutating state when no command receipt exists", async () => {
    const { executor, store, vault, ids } = harness();

    const result = await executor.replayBeginExact(registrationCommand());

    expect(result).toBeNull();
    expect(store.ceremonies.size).toBe(0);
    expect(store.commands.size).toBe(0);
    expect(store.creations.size).toBe(0);
    expect(store.commits).toHaveLength(0);
    expect(store.commandReceiptFindCount).toBe(1);
    expect(store.creationReceiptFindCount).toBe(0);
    expect(ids.counts.size).toBe(0);
    expect(vault.issueCount).toBe(0);
    expect(vault.resolveCount).toBe(0);
    expect(vault.discardCount).toBe(0);
    expect(vault.secrets.size).toBe(0);
  });

  it("validates the command before any receipt or vault access", async () => {
    const { executor, store, vault } = harness();
    const poisoned = {
      ...registrationCommand(),
      rawChallenge: "READ_ONLY_REPLAY_SECRET_CANARY"
    } as unknown as BeginRegistrationCommand;

    await expectCode(executor.replayBeginExact(poisoned), "VALIDATION_FAILED");

    expect(store.commandReceiptFindCount).toBe(0);
    expect(store.creationReceiptFindCount).toBe(0);
    expect(store.commits).toHaveLength(0);
    expect(vault.issueCount).toBe(0);
    expect(vault.resolveCount).toBe(0);
    expect(vault.discardCount).toBe(0);
  });

  it("copies the validated command before the first asynchronous receipt lookup", async () => {
    const { executor, store } = harness();
    const command = registrationCommand();
    const begun = await executor.begin(command);
    const mutableActor: { accountId: string; sessionId: string; deviceId: string } = { ...actor };
    const mutablePurpose: { type: "authenticator.add"; targetDigest: string } = {
      type: "authenticator.add",
      targetDigest
    };
    const pending = executor.replayBeginExact({
      ...command,
      actor: mutableActor,
      purpose: mutablePurpose
    });

    mutableActor.accountId = "mutated-account";
    mutablePurpose.targetDigest = "b".repeat(64);
    const replay = await pending;

    expect(replay).toMatchObject({ replayed: true, eventId: begun.eventId, snapshot: begun.snapshot });
    expect(store.commits).toHaveLength(1);
  });

  it("replays an exact command receipt without another durable mutation", async () => {
    const { executor, store, vault, ids } = harness();
    const command = registrationCommand();
    const begun = await executor.begin(command);
    const idCounts = new Map(ids.counts);
    const commandFindsBefore = store.commandReceiptFindCount;
    const creationFindsBefore = store.creationReceiptFindCount;

    const replay = await executor.replayBeginExact(command);

    expect(replay).toMatchObject({
      replayed: true,
      eventId: begun.eventId,
      outboxId: null,
      snapshot: begun.snapshot
    });
    expect(replay?.clientRequirements).toEqual(begun.clientRequirements);
    expect(store.commits).toHaveLength(1);
    expect(store.commands.size).toBe(1);
    expect(store.creations.size).toBe(1);
    expect(store.commandReceiptFindCount).toBe(commandFindsBefore + 1);
    expect(store.creationReceiptFindCount).toBe(creationFindsBefore);
    expect(ids.counts).toEqual(idCounts);
    expect(vault.issueCount).toBe(1);
    expect(vault.resolveCount).toBe(1);
    expect(vault.discardCount).toBe(0);
  });

  it("returns null for the same clientNonce under a different commandId without reading its creation receipt", async () => {
    const { executor, store, vault } = harness();
    const command = registrationCommand();
    await executor.begin(command);
    const commandFindsBefore = store.commandReceiptFindCount;
    const creationFindsBefore = store.creationReceiptFindCount;

    const replay = await executor.replayBeginExact({
      ...command,
      commandId: "command-begin-registration-retry"
    });

    expect(replay).toBeNull();
    expect(store.commits).toHaveLength(1);
    expect(store.commands.size).toBe(1);
    expect(store.creations.size).toBe(1);
    expect(store.commandReceiptFindCount).toBe(commandFindsBefore + 1);
    expect(store.creationReceiptFindCount).toBe(creationFindsBefore);
    expect(vault.issueCount).toBe(1);
    expect(vault.resolveCount).toBe(0);
    expect(vault.discardCount).toBe(0);
  });

  it("preserves exact command fingerprint conflicts without vault or creation-receipt access", async () => {
    const commandConflict = harness();
    const command = registrationCommand();
    await commandConflict.executor.begin(command);
    const creationFindsBefore = commandConflict.store.creationReceiptFindCount;
    await expectCode(commandConflict.executor.replayBeginExact({
      ...command,
      clientNonce: "nonce-registration-conflicting-command"
    }), "IDEMPOTENCY_KEY_REUSED");
    expect(commandConflict.store.commits).toHaveLength(1);
    expect(commandConflict.store.creationReceiptFindCount).toBe(creationFindsBefore);
    expect(commandConflict.vault.issueCount).toBe(1);
    expect(commandConflict.vault.resolveCount).toBe(0);
    expect(commandConflict.vault.discardCount).toBe(0);
  });

  it("rejects an expired pending receipt before challenge resolution and makes no mutation", async () => {
    const { executor, store, clock, vault } = harness();
    const command = registrationCommand();
    const begun = await executor.begin(command);
    clock.value = begun.snapshot.expiresAtMs;

    await expectCode(executor.replayBeginExact(command), "CHALLENGE_UNAVAILABLE");

    expect(store.commits).toHaveLength(1);
    expect(store.ceremonies.get(begun.snapshot.ceremonyId)).toEqual(begun.snapshot);
    expect(vault.issueCount).toBe(1);
    expect(vault.resolveCount).toBe(0);
    expect(vault.discardCount).toBe(0);
  });

  it("rejects a missing challenge using the same replay semantics and makes no mutation", async () => {
    const { executor, store, vault } = harness();
    const command = registrationCommand();
    const begun = await executor.begin(command);
    vault.secrets.delete(begun.snapshot.challenge.reference);

    await expectCode(executor.replayBeginExact(command), "CHALLENGE_UNAVAILABLE");

    expect(store.commits).toHaveLength(1);
    expect(store.ceremonies.get(begun.snapshot.ceremonyId)).toEqual(begun.snapshot);
    expect(vault.issueCount).toBe(1);
    expect(vault.resolveCount).toBe(1);
    expect(vault.discardCount).toBe(0);
  });

  it("isolates receipt lookup by the complete actor binding", async () => {
    const { executor, store, vault } = harness();
    const command = registrationCommand();
    await executor.begin(command);

    const replay = await executor.replayBeginExact({
      ...command,
      actor: { accountId: "attacker", sessionId: "attacker-session", deviceId: "attacker-device" }
    });

    expect(replay).toBeNull();
    expect(store.commits).toHaveLength(1);
    expect(store.commands.size).toBe(1);
    expect(store.creations.size).toBe(1);
    expect(vault.issueCount).toBe(1);
    expect(vault.resolveCount).toBe(0);
    expect(vault.discardCount).toBe(0);
  });

  it("fails closed when a command receipt is rebound to another actor", async () => {
    const { executor, store, vault } = harness();
    const command = registrationCommand();
    await executor.begin(command);
    const receipt = [...store.commands.values()][0];
    expect(receipt).toBeDefined();
    if (receipt === undefined) throw new Error("missing test receipt");
    store.commands.set(receipt.scope, {
      ...receipt,
      result: {
        ...receipt.result,
        snapshot: {
          ...receipt.result.snapshot,
          actor: { accountId: "other-account", sessionId: "other-session", deviceId: "other-device" }
        }
      }
    });

    await expectCode(executor.replayBeginExact(command), "STORAGE_INTEGRITY_FAILED");

    expect(store.commits).toHaveLength(1);
    expect(vault.resolveCount).toBe(0);
    expect(vault.discardCount).toBe(0);
  });

  it("does not replay a receipt whose aggregate is missing", async () => {
    const { executor, store, vault } = harness();
    const command = registrationCommand();
    const begun = await executor.begin(command);
    store.ceremonies.delete(begun.snapshot.ceremonyId);

    await expectCode(executor.replayBeginExact(command), "STORAGE_INTEGRITY_FAILED");

    expect(store.commits).toHaveLength(1);
    expect(vault.resolveCount).toBe(0);
    expect(vault.discardCount).toBe(0);
  });
});

describe("registration verification boundary", () => {
  it("passes exact expectations to the maintained verifier and atomically isolates credential material", async () => {
    const { executor, store, verifier, vault } = harness();
    verifier.registrationResult = makeRegistrationSuccess();
    const begun = await executor.begin(registrationCommand());
    const response = { opaque: opaqueResponseCanary };
    const verified = await executor.verify({
      schemaVersion: PASSKEY_DOMAIN_VERSION,
      type: "verify",
      commandId: "verify-registration-1",
      ceremonyId: begun.snapshot.ceremonyId,
      actor,
      expectedRevision: 1,
      responseByteLength: 512,
      responseDigest
    }, response);

    expect(verified.snapshot.state).toBe("consumed");
    expect(verified.snapshot.riskSignals).toEqual([
      "signature_counter_not_supported",
      "single_device_credential"
    ]);
    expect(verifier.registrationCalls).toHaveLength(1);
    const call = verifier.registrationCalls[0];
    expect(call?.response).toBe(response);
    expect(call?.expectations).toMatchObject({
      kind: "registration",
      expectedRpId: "auth.luxora.app",
      expectedOrigin: origin,
      expectedTopOrigins: [],
      crossOriginAllowed: false,
      requireUserPresence: true,
      requireUserVerification: true,
      attestation: "none",
      residentKey: "required",
      allowedAlgorithms: [-7, -257],
      expectedAccountId: actor.accountId,
      expectedUserHandleRef: "user-handle-ref-1",
      purpose: { type: "authenticator.add", targetDigest },
      maxResponseBytes: 65_536,
      responseByteLength: 512
    });
    expect(call?.expectations.expectedChallenge).toBe(
      begun.clientRequirements?.challenge
    );

    const commit = store.commits.at(-1);
    expect(commit?.mutation.secureCredentialEffect).toMatchObject({
      type: "store_registration_credential",
      credential: { credentialId: "Y3JlZGVudGlhbC0x" }
    });
    const eventJson = JSON.stringify(commit?.mutation.event);
    const outboxJson = JSON.stringify(commit?.mutation.outbox);
    const logJson = JSON.stringify(commit === undefined ? null : toSafeCeremonyLogFields(commit.mutation.event));
    for (const safePayload of [eventJson, outboxJson, logJson]) {
      expect(safePayload).not.toContain(opaqueResponseCanary);
      expect(safePayload).not.toContain(publicKeyCanary);
      expect(safePayload).not.toContain("publicKey");
      expect(safePayload).not.toContain("credentialId");
      expect(safePayload).not.toContain(begun.clientRequirements?.challenge);
    }
    expect(() => toSafeCeremonyLogFields({
      ...commit?.mutation.event,
      type: "SAFE_LOG_SECRET_CANARY"
    } as never)).toThrow(PasskeyDomainError);
    expect(outboxJson).not.toContain(actor.accountId);
    expect(outboxJson).not.toContain(actor.sessionId);
    expect(outboxJson).not.toContain(actor.deviceId);
    expect(vault.secrets.has(begun.snapshot.challenge.reference)).toBe(false);
  });

  it("replays an exact response-bound verify command without persisting its opaque response", async () => {
    const { executor, store, verifier } = harness();
    verifier.registrationResult = makeRegistrationSuccess();
    const begun = await executor.begin(registrationCommand());
    const command = {
      schemaVersion: PASSKEY_DOMAIN_VERSION,
      type: "verify" as const,
      commandId: "verify-replay-1",
      ceremonyId: begun.snapshot.ceremonyId,
      actor,
      expectedRevision: 1,
      responseByteLength: 200,
      responseDigest
    };
    const first = await executor.verify(command, { value: opaqueResponseCanary });
    const replay = await executor.verify(command, { value: opaqueResponseCanary });
    expect(first.replayed).toBe(false);
    expect(replay.replayed).toBe(true);
    expect(replay.snapshot).toEqual(first.snapshot);
    expect(verifier.registrationCalls).toHaveLength(1);
    expect(JSON.stringify([...store.commands.values()])).not.toContain(opaqueResponseCanary);
    expect(JSON.stringify([...store.commands.values()])).not.toContain(responseDigest);
    expect(store.commits.filter((entry) => entry.mutation.secureCredentialEffect !== null)).toHaveLength(1);
  });

  it("rejects same-length response reuse when the server-derived response digest differs", async () => {
    const { executor, verifier } = harness();
    verifier.registrationResult = makeRegistrationSuccess();
    const begun = await executor.begin(registrationCommand());
    const command = {
      schemaVersion: PASSKEY_DOMAIN_VERSION,
      type: "verify" as const,
      commandId: "verify-response-binding",
      ceremonyId: begun.snapshot.ceremonyId,
      actor,
      expectedRevision: 1,
      responseByteLength: 200,
      responseDigest
    };
    await executor.verify(command, { value: "first-response" });
    await expectCode(executor.verify({ ...command, responseDigest: "d".repeat(64) }, {
      value: "other-response"
    }), "IDEMPOTENCY_KEY_REUSED");
    expect(verifier.registrationCalls).toHaveLength(1);
  });
});

describe("attempt, expiry and cancellation state", () => {
  it("bounds invalid attempts, makes exact retries free, and terminates at the configured limit", async () => {
    const { executor, store, verifier } = harness(3);
    const begun = await executor.begin(registrationCommand());
    const verify = (number: number, revision: number) => executor.verify({
      schemaVersion: PASSKEY_DOMAIN_VERSION,
      type: "verify",
      commandId: `verify-invalid-${number}`,
      ceremonyId: begun.snapshot.ceremonyId,
      actor,
      expectedRevision: revision,
      responseByteLength: 100,
      responseDigest
    }, { invalid: true });

    const one = await verify(1, 1);
    const replay = await verify(1, 1);
    const two = await verify(2, 2);
    const three = await verify(3, 3);
    expect(one.snapshot).toMatchObject({ state: "pending", attemptsUsed: 1, revision: 2 });
    expect(replay.replayed).toBe(true);
    expect(two.snapshot).toMatchObject({ state: "pending", attemptsUsed: 2, revision: 3 });
    expect(three.snapshot).toMatchObject({
      state: "rejected",
      attemptsUsed: 3,
      revision: 4,
      terminalReason: "attempts_exhausted"
    });
    expect(verifier.registrationCalls).toHaveLength(3);
    expect(store.ceremonies.get(begun.snapshot.ceremonyId)?.state).toBe("rejected");
  });

  it("replays begin against the current pending revision instead of its stale creation snapshot", async () => {
    const { executor } = harness(3);
    const begin = registrationCommand();
    const begun = await executor.begin(begin);
    const rejected = await executor.verify({
      schemaVersion: PASSKEY_DOMAIN_VERSION,
      type: "verify",
      commandId: "verify-before-begin-retry",
      ceremonyId: begun.snapshot.ceremonyId,
      actor,
      expectedRevision: 1,
      responseByteLength: 100,
      responseDigest
    }, {});
    const replayedBegin = await executor.begin(begin);
    expect(rejected.snapshot.revision).toBe(2);
    expect(replayedBegin).toMatchObject({ replayed: true, snapshot: { revision: 2, attemptsUsed: 1 } });
    expect(replayedBegin.clientRequirements?.challenge).toBe(begun.clientRequirements?.challenge);
  });

  it("expires before invoking the verifier and refuses an early sweeper expiry", async () => {
    const { executor, clock, verifier } = harness();
    const begun = await executor.begin(registrationCommand());
    await expectCode(executor.expire({
      schemaVersion: PASSKEY_DOMAIN_VERSION,
      type: "expire",
      commandId: "expire-too-early",
      actor: { kind: "system", subject: "ceremony-expirer" },
      ceremonyId: begun.snapshot.ceremonyId,
      expectedRevision: 1
    }), "COMMAND_NOT_ALLOWED");
    clock.value = begun.snapshot.expiresAtMs;
    const expired = await executor.verify({
      schemaVersion: PASSKEY_DOMAIN_VERSION,
      type: "verify",
      commandId: "verify-after-expiry",
      ceremonyId: begun.snapshot.ceremonyId,
      actor,
      expectedRevision: 1,
      responseByteLength: 100,
      responseDigest
    }, { response: opaqueResponseCanary });
    expect(expired.snapshot).toMatchObject({ state: "expired", terminalReason: "expired" });
    expect(verifier.registrationCalls).toHaveLength(0);
  });

  it("never reissues raw client requirements for a logically expired pending begin", async () => {
    const { executor, clock, vault } = harness();
    const command = registrationCommand();
    const begun = await executor.begin(command);
    clock.value = begun.snapshot.expiresAtMs;
    const resolvesBefore = vault.resolveCount;
    await expectCode(executor.begin(command), "CHALLENGE_UNAVAILABLE");
    expect(vault.resolveCount).toBe(resolvesBefore);
  });

  it("fails before challenge resolution when the ceremony clock moves backwards", async () => {
    const { executor, clock, vault, verifier } = harness();
    const begun = await executor.begin(registrationCommand());
    clock.value = begun.snapshot.updatedAtMs - 1;
    const resolvesBefore = vault.resolveCount;
    await expectCode(executor.verify({
      schemaVersion: PASSKEY_DOMAIN_VERSION,
      type: "verify",
      commandId: "clock-rollback-verify",
      ceremonyId: begun.snapshot.ceremonyId,
      actor,
      expectedRevision: 1,
      responseByteLength: 100,
      responseDigest
    }, {}), "VALIDATION_FAILED");
    expect(vault.resolveCount).toBe(resolvesBefore);
    expect(verifier.registrationCalls).toHaveLength(0);
  });

  it("cancels only the bound actor and makes the terminal state immutable", async () => {
    const { executor } = harness();
    const begun = await executor.begin(registrationCommand());
    const cancelled = await executor.cancel({
      schemaVersion: PASSKEY_DOMAIN_VERSION,
      type: "cancel",
      commandId: "cancel-1",
      ceremonyId: begun.snapshot.ceremonyId,
      actor,
      expectedRevision: 1
    });
    expect(cancelled.snapshot.state).toBe("cancelled");
    await expectCode(executor.verify({
      schemaVersion: PASSKEY_DOMAIN_VERSION,
      type: "verify",
      commandId: "verify-after-cancel",
      ceremonyId: begun.snapshot.ceremonyId,
      actor,
      expectedRevision: 2,
      responseByteLength: 100,
      responseDigest
    }, {}), "TERMINAL_CEREMONY");
  });
});

describe("credential metadata boundaries and policy signals", () => {
  it.each(["discoverable", "non_discoverable"] as const)(
    "keeps %s authentication lookup metadata behind an opaque boundary",
    async (mode) => {
      const { executor, verifier, store } = harness();
      verifier.authenticationResult = makeAuthenticationSuccess(mode);
      const begun = await executor.begin(authenticationCommand(mode));
      const verified = await executor.verify({
        schemaVersion: PASSKEY_DOMAIN_VERSION,
        type: "verify",
        commandId: `verify-auth-${mode}`,
        ceremonyId: begun.snapshot.ceremonyId,
        actor,
        expectedRevision: 1,
        responseByteLength: 600,
        responseDigest
      }, { response: opaqueResponseCanary });
      expect(verified.snapshot.state).toBe("consumed");
      expect(verified.snapshot.riskSignals).toEqual([
        "backup_state_enabled"
      ]);
      expect(verifier.authenticationCalls[0]?.expectations.credentialBoundary).toEqual(
        begun.snapshot.credentialBoundary
      );
      expect(begun.clientRequirements).toMatchObject({ kind: "authentication", credentialMode: mode });
      const outbox = JSON.stringify(store.commits.at(-1)?.mutation.outbox);
      expect(outbox).not.toContain("secure-credential-set-1");
      expect(outbox).not.toContain("credential-record-existing");
    }
  );

  it.each([
    [0, 0, false, false, false, false, ["signature_counter_not_supported"]],
    [7, 0, true, true, false, false, ["signature_counter_anomaly"]],
    [7, 7, true, true, false, false, ["signature_counter_anomaly"]],
    [7, 6, true, true, false, false, ["signature_counter_anomaly"]],
    [3, 4, true, true, false, false, []],
    [4, 5, true, true, true, false, ["backup_state_disabled"]],
    [0, 1, true, true, false, true, ["backup_state_enabled"]]
  ] as const)(
    "classifies accepted counter %s→%s and backup policy transitions without a clone verdict",
    (previousSignCount, newSignCount, previousBackupEligible, backupEligible, previousBackupState, backupState, expected) => {
      const signals = authenticationRiskSignals({
        credentialRecordId: "credential-record-1",
        credentialRevision: 1,
        accountId: actor.accountId,
        discoveryMode: "discoverable",
        userHandleBindingVerified: true,
        previousSignCount,
        newSignCount,
        previousBackupEligible,
        backupEligible,
        previousBackupState,
        backupState,
        userPresent: true,
        userVerified: true
      });
      expect(signals).toEqual(expected);
      expect(signals).not.toContain("credential_cloned");
    }
  );

  it.each([
    [7, 0],
    [7, 7],
    [7, 6]
  ] as const)(
    "accepts verified counter anomaly %s→%s while preserving the observed value and row CAS",
    async (previousSignCount, newSignCount) => {
      const { executor, verifier, store } = harness();
      store.credentialStates.set("credential-record-existing", {
        accountId: actor.accountId,
        revision: 1,
        signCount: previousSignCount,
        backupEligible: true,
        backupState: false
      });
      const result = makeAuthenticationSuccess("discoverable");
      result.credential.previousSignCount = previousSignCount;
      result.credential.newSignCount = newSignCount;
      result.credential.backupState = false;
      verifier.authenticationResult = result;
      const begun = await executor.begin(authenticationCommand());
      const verified = await executor.verify({
        schemaVersion: PASSKEY_DOMAIN_VERSION,
        type: "verify",
        commandId: `counter-policy-${previousSignCount}-${newSignCount}`,
        ceremonyId: begun.snapshot.ceremonyId,
        actor,
        expectedRevision: 1,
        responseByteLength: 100,
        responseDigest
      }, { response: opaqueResponseCanary });

      expect(verified.snapshot).toMatchObject({
        state: "consumed",
        revision: 2,
        riskSignals: ["signature_counter_anomaly"]
      });
      const effect = store.commits.at(-1)?.mutation.secureCredentialEffect;
      expect(effect).toMatchObject({
        type: "update_authentication_credential",
        credential: {
          credentialRevision: 1,
          previousSignCount,
          newSignCount
        },
        riskSignals: ["signature_counter_anomaly"]
      });
      expect(store.credentialStates.get("credential-record-existing")).toMatchObject({
        revision: 2,
        signCount: previousSignCount
      });
    }
  );

  it("still fails closed on a malformed observed counter shape", async () => {
    const { executor, verifier, store } = harness();
    const result = makeAuthenticationSuccess("discoverable");
    (result.credential as unknown as { newSignCount: unknown }).newSignCount = "6";
    verifier.authenticationResult = result;
    const begun = await executor.begin(authenticationCommand());
    await expectCode(executor.verify({
      schemaVersion: PASSKEY_DOMAIN_VERSION,
      type: "verify",
      commandId: "malformed-counter-shape",
      ceremonyId: begun.snapshot.ceremonyId,
      actor,
      expectedRevision: 1,
      responseByteLength: 100,
      responseDigest
    }, {}), "VERIFIER_UNAVAILABLE");
    expect(store.ceremonies.get(begun.snapshot.ceremonyId))
      .toMatchObject({ state: "pending", revision: 1 });
    expect(store.commits.filter((entry) => entry.mutation.secureCredentialEffect !== null))
      .toHaveLength(0);
  });

  it("allows the anomaly signal only for authentication and rejects contradictory counter signals", async () => {
    const registrationHarness = harness();
    registrationHarness.verifier.registrationResult = makeRegistrationSuccess();
    const registration = await registrationHarness.executor.begin(registrationCommand());
    const registered = await registrationHarness.executor.verify({
      schemaVersion: PASSKEY_DOMAIN_VERSION,
      type: "verify",
      commandId: "registration-risk-vocabulary",
      ceremonyId: registration.snapshot.ceremonyId,
      actor,
      expectedRevision: 1,
      responseByteLength: 100,
      responseDigest
    }, {});
    expect(() => assertCeremonyInvariants({
      ...registered.snapshot,
      riskSignals: ["signature_counter_anomaly"]
    })).toThrow(PasskeyDomainError);

    const authenticationHarness = harness();
    authenticationHarness.verifier.authenticationResult = makeAuthenticationSuccess("discoverable");
    const authentication = await authenticationHarness.executor.begin(authenticationCommand());
    const authenticated = await authenticationHarness.executor.verify({
      schemaVersion: PASSKEY_DOMAIN_VERSION,
      type: "verify",
      commandId: "authentication-risk-vocabulary",
      ceremonyId: authentication.snapshot.ceremonyId,
      actor,
      expectedRevision: 1,
      responseByteLength: 100,
      responseDigest
    }, {});
    expect(() => assertCeremonyInvariants({
      ...authenticated.snapshot,
      riskSignals: ["signature_counter_not_supported", "signature_counter_anomaly"]
    })).toThrow(PasskeyDomainError);
  });

  it("fails closed when verifier output changes immutable backup eligibility", async () => {
    const { executor, verifier, store } = harness();
    const result = makeAuthenticationSuccess("discoverable");
    result.credential.backupEligible = false;
    result.credential.backupState = false;
    verifier.authenticationResult = result;
    const begun = await executor.begin(authenticationCommand());
    await expectCode(executor.verify({
      schemaVersion: PASSKEY_DOMAIN_VERSION,
      type: "verify",
      commandId: "immutable-be-verify",
      ceremonyId: begun.snapshot.ceremonyId,
      actor,
      expectedRevision: 1,
      responseByteLength: 100,
      responseDigest
    }, {}), "VERIFIER_UNAVAILABLE");
    expect(store.ceremonies.get(begun.snapshot.ceremonyId)).toMatchObject({ state: "pending", revision: 1 });
    expect(store.commits.filter((entry) => entry.mutation.secureCredentialEffect !== null)).toHaveLength(0);
  });
});

describe("idempotency and compare-and-swap races", () => {
  it("maps an atomic initial authorization conflict to coarse FORBIDDEN and discards only its challenge", async () => {
    const { executor, store, vault } = harness();
    const canary = "GRANT_TOKEN_STORE_CAUSE_CANARY";
    const storeError = new StoreAuthorizationConflictError();
    storeError.message = `authorization failed: ${canary}`;
    Object.defineProperty(storeError, "cause", { value: new Error(canary), enumerable: true });
    store.errorBeforeNextCommit = storeError;
    vault.secrets.set("unrelated-challenge-ref", Buffer.alloc(PASSKEY_CHALLENGE_BYTES, 0x7f).toString("base64url"));

    const error = await captureDomainError(executor.begin(registrationCommand()));

    expect(error).toMatchObject({ code: "FORBIDDEN", currentState: null });
    expect(String(error)).toBe("PasskeyDomainError: passkey ceremony authorization precondition failed");
    expect(error.stack).not.toContain(canary);
    expect(JSON.stringify(error)).not.toContain(canary);
    expect(Object.hasOwn(error, "cause")).toBe(false);
    expect(store.ceremonies.size).toBe(0);
    expect(store.commands.size).toBe(0);
    expect(store.creations.size).toBe(0);
    expect(store.commits).toHaveLength(0);
    expect(vault.issueCount).toBe(1);
    expect(vault.discardCount).toBe(1);
    expect(vault.secrets.has("challenge-ref-1")).toBe(false);
    expect(vault.secrets.has("unrelated-challenge-ref")).toBe(true);
  });

  it("replays an ambiguous committed begin even when the store surfaced authorization conflict", async () => {
    const { executor, store, vault } = harness();
    store.errorAfterNextCommit = new StoreAuthorizationConflictError();

    const result = await executor.begin(registrationCommand());

    expect(result).toMatchObject({ replayed: true, snapshot: { state: "pending" } });
    expect(store.commits).toHaveLength(1);
    expect(store.commands.size).toBe(1);
    expect(store.creations.size).toBe(1);
    expect(vault.discardCount).toBe(0);
    expect(result.clientRequirements?.challenge).toBe(vault.secrets.get(result.snapshot.challenge.reference));
  });

  it("keeps unrelated initial store failures coarse as STORAGE_UNAVAILABLE", async () => {
    const { executor, store } = harness();
    const canary = "UNRELATED_STORE_FAILURE_CANARY";
    store.errorBeforeNextCommit = new Error(canary);

    const error = await captureDomainError(executor.begin(registrationCommand()));

    expect(error).toMatchObject({ code: "STORAGE_UNAVAILABLE", currentState: null });
    expect(String(error)).not.toContain(canary);
    expect(JSON.stringify(error)).not.toContain(canary);
    expect(store.ceremonies.size).toBe(0);
    expect(store.commands.size).toBe(0);
    expect(store.creations.size).toBe(0);
    expect(store.commits).toHaveLength(0);
  });

  it("reconciles an ambiguous begin commit without deleting the winning raw challenge", async () => {
    const { executor, store, vault } = harness();
    store.throwAfterNextCommit = true;
    const result = await executor.begin(registrationCommand());
    expect(result).toMatchObject({ replayed: true, snapshot: { state: "pending" } });
    expect(store.commits).toHaveLength(1);
    expect(result.clientRequirements?.challenge).toBe(
      vault.secrets.get(result.snapshot.challenge.reference)
    );
  });

  it("reconciles an ambiguous verified commit into one consumed effect", async () => {
    const { executor, verifier, store } = harness();
    verifier.registrationResult = makeRegistrationSuccess();
    const begun = await executor.begin(registrationCommand());
    store.throwAfterNextCommit = true;
    const result = await executor.verify({
      schemaVersion: PASSKEY_DOMAIN_VERSION,
      type: "verify",
      commandId: "verify-ambiguous-commit",
      ceremonyId: begun.snapshot.ceremonyId,
      actor,
      expectedRevision: 1,
      responseByteLength: 100,
      responseDigest
    }, {});
    expect(result).toMatchObject({ replayed: true, snapshot: { state: "consumed" } });
    expect(store.commits.filter((entry) => entry.mutation.secureCredentialEffect !== null)).toHaveLength(1);
  });

  it("converges concurrent begin retries on one durable ceremony and one returned challenge", async () => {
    const { executor, store } = harness();
    const command = registrationCommand();
    const [left, right] = await Promise.all([executor.begin(command), executor.begin(command)]);
    expect(store.commits).toHaveLength(1);
    expect(left.snapshot.ceremonyId).toBe(right.snapshot.ceremonyId);
    expect(left.clientRequirements?.challenge).toBe(right.clientRequirements?.challenge);
    expect([left.replayed, right.replayed].sort()).toEqual([false, true]);
  });

  it("commits one secure effect for concurrent identical verification retries", async () => {
    const { executor, verifier, store } = harness();
    verifier.registrationResult = makeRegistrationSuccess();
    const begun = await executor.begin(registrationCommand());
    const command = {
      schemaVersion: PASSKEY_DOMAIN_VERSION,
      type: "verify" as const,
      commandId: "verify-concurrent-same",
      ceremonyId: begun.snapshot.ceremonyId,
      actor,
      expectedRevision: 1,
      responseByteLength: 100,
      responseDigest
    };
    const [left, right] = await Promise.all([
      executor.verify(command, { response: "left" }),
      executor.verify(command, { response: "right" })
    ]);
    expect([left.replayed, right.replayed].sort()).toEqual([false, true]);
    expect(store.commits.filter((entry) => entry.mutation.secureCredentialEffect !== null)).toHaveLength(1);
  });

  it("lets exactly one different verification command win the same expected revision", async () => {
    const { executor, verifier, store } = harness();
    verifier.registrationResult = makeRegistrationSuccess();
    const begun = await executor.begin(registrationCommand());
    const command = (id: string) => ({
      schemaVersion: PASSKEY_DOMAIN_VERSION,
      type: "verify" as const,
      commandId: id,
      ceremonyId: begun.snapshot.ceremonyId,
      actor,
      expectedRevision: 1,
      responseByteLength: 100,
      responseDigest
    });
    const results = await Promise.allSettled([
      executor.verify(command("verify-race-left"), {}),
      executor.verify(command("verify-race-right"), {})
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejection = results.find((result) => result.status === "rejected");
    expect(rejection?.status).toBe("rejected");
    expect((rejection as PromiseRejectedResult).reason).toMatchObject({ code: "REVISION_CONFLICT" });
    expect(store.commits.filter((entry) => entry.mutation.secureCredentialEffect !== null)).toHaveLength(1);
  });

  it("allows cancel to win a verifier-in-flight race without persisting credential material", async () => {
    const { executor, verifier, store } = harness();
    verifier.registrationResult = makeRegistrationSuccess();
    const begun = await executor.begin(registrationCommand());
    let release = (): void => undefined;
    verifier.registrationGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const verifying = executor.verify({
      schemaVersion: PASSKEY_DOMAIN_VERSION,
      type: "verify",
      commandId: "verify-loses-to-cancel",
      ceremonyId: begun.snapshot.ceremonyId,
      actor,
      expectedRevision: 1,
      responseByteLength: 100,
      responseDigest
    }, {});
    while (verifier.registrationCalls.length === 0) await Promise.resolve();
    const cancelled = await executor.cancel({
      schemaVersion: PASSKEY_DOMAIN_VERSION,
      type: "cancel",
      commandId: "cancel-wins-race",
      ceremonyId: begun.snapshot.ceremonyId,
      actor,
      expectedRevision: 1
    });
    release();
    await expectCode(verifying, "REVISION_CONFLICT");
    expect(cancelled.snapshot.state).toBe("cancelled");
    expect(store.commits.filter((entry) => entry.mutation.secureCredentialEffect !== null)).toHaveLength(0);
  });
});

describe("independent security audit regressions", () => {
  it("conceals a terminal ceremony and revision from a different actor", async () => {
    const { executor } = harness();
    const begun = await executor.begin(registrationCommand());
    await executor.cancel({
      schemaVersion: PASSKEY_DOMAIN_VERSION,
      type: "cancel",
      commandId: "cancel-before-privacy-probe",
      ceremonyId: begun.snapshot.ceremonyId,
      actor,
      expectedRevision: 1
    });

    const error = await captureDomainError(executor.verify({
      schemaVersion: PASSKEY_DOMAIN_VERSION,
      type: "verify",
      commandId: "terminal-privacy-probe",
      ceremonyId: begun.snapshot.ceremonyId,
      actor: { accountId: "attacker", sessionId: "attacker-session", deviceId: "attacker-device" },
      expectedRevision: 99,
      responseByteLength: 100,
      responseDigest
    }, {}));
    expect(error).toMatchObject({ code: "NOT_FOUND", currentState: null });
    const serialized = JSON.stringify(error);
    expect(serialized).not.toContain("cancelled");
    expect(serialized).not.toContain(actor.accountId);
    expect(serialized).not.toContain(begun.snapshot.challenge.reference);
  });

  it("exposes only state and revision for an authorized revision conflict", async () => {
    const { executor } = harness();
    const begun = await executor.begin(registrationCommand());
    await executor.verify({
      schemaVersion: PASSKEY_DOMAIN_VERSION,
      type: "verify",
      commandId: "safe-error-first-attempt",
      ceremonyId: begun.snapshot.ceremonyId,
      actor,
      expectedRevision: 1,
      responseByteLength: 100,
      responseDigest
    }, {});
    const error = await captureDomainError(executor.verify({
      schemaVersion: PASSKEY_DOMAIN_VERSION,
      type: "verify",
      commandId: "safe-error-stale-attempt",
      ceremonyId: begun.snapshot.ceremonyId,
      actor,
      expectedRevision: 1,
      responseByteLength: 100,
      responseDigest
    }, {}));
    expect(error).toMatchObject({ code: "REVISION_CONFLICT", currentState: { state: "pending", revision: 2 } });
    const serialized = JSON.stringify(error);
    for (const secret of [
      actor.accountId,
      actor.sessionId,
      actor.deviceId,
      begun.snapshot.challenge.reference,
      begun.snapshot.challenge.digest,
      "user-handle-ref-1"
    ]) {
      expect(serialized).not.toContain(secret);
    }
  });

  it("rejects injected command fields and snapshots input before the first await", async () => {
    const poisoned = {
      ...registrationCommand({ commandId: "poisoned-command", clientNonce: "poisoned-nonce" }),
      rawChallenge: "COMMAND_SECRET_CANARY"
    } as unknown as BeginRegistrationCommand;
    const first = harness();
    await expectCode(first.executor.begin(poisoned), "VALIDATION_FAILED");
    expect(first.vault.issueCount).toBe(0);
    expect(JSON.stringify(first.store.commits)).not.toContain("COMMAND_SECRET_CANARY");

    const mutableActor: { accountId: string; sessionId: string; deviceId: string } = { ...actor };
    const mutablePurpose = { type: "authenticator.add" as const, targetDigest };
    const second = harness();
    const pending = second.executor.begin(registrationCommand({
      commandId: "mutable-command",
      clientNonce: "mutable-nonce",
      actor: mutableActor,
      purpose: mutablePurpose
    }));
    mutableActor.accountId = "mutated-account";
    mutablePurpose.targetDigest = "b".repeat(64);
    const begun = await pending;
    expect(begun.snapshot.actor.accountId).toBe(actor.accountId);
    expect(begun.snapshot.purpose.targetDigest).toBe(targetDigest);
  });

  it("copies the validated RP policy so later caller mutation cannot widen origins", async () => {
    const base = createLuxoraPasskeyPolicy();
    const mutableOrigins = [...base.allowedOrigins];
    const mutablePolicy = {
      ...base,
      allowedOrigins: mutableOrigins,
      expectedTopOrigins: [] as const,
      allowedAlgorithms: [-7, -257] as const
    };
    const { store, clock, ids, vault, verifier } = harness();
    const executor = new PasskeyCeremonyExecutor({
      store,
      clock,
      ids,
      policy: mutablePolicy,
      challengeVault: vault,
      verifier
    });
    mutableOrigins[0] = "https://preview.auth.luxora.app";
    await expectCode(executor.begin(registrationCommand({
      commandId: "mutated-policy-command",
      clientNonce: "mutated-policy-nonce",
      expectedOrigin: mutableOrigins[0]
    })), "FORBIDDEN");
    expect(vault.issueCount).toBe(0);
  });

  it("fails closed on a rehydrated origin outside the active allowlist", async () => {
    const { executor, store, vault, verifier } = harness();
    const begun = await executor.begin(registrationCommand());
    store.ceremonies.set(begun.snapshot.ceremonyId, {
      ...begun.snapshot,
      expectedOrigin: "https://preview.auth.luxora.app"
    });
    const resolvesBefore = vault.resolveCount;
    await expectCode(executor.verify({
      schemaVersion: PASSKEY_DOMAIN_VERSION,
      type: "verify",
      commandId: "tampered-origin-verify",
      ceremonyId: begun.snapshot.ceremonyId,
      actor,
      expectedRevision: 1,
      responseByteLength: 100,
      responseDigest
    }, {}), "STORAGE_INTEGRITY_FAILED");
    expect(vault.resolveCount).toBe(resolvesBefore);
    expect(verifier.registrationCalls).toHaveLength(0);
  });

  it.each([
    ["unknown secret field", (snapshot: CeremonyAggregate) => ({
      ...snapshot,
      rawChallenge: "REHYDRATION_SECRET_CANARY"
    })],
    ["impossible revision history", (snapshot: CeremonyAggregate) => ({
      ...snapshot,
      revision: 7
    })],
    ["risk signal on pending state", (snapshot: CeremonyAggregate) => ({
      ...snapshot,
      riskSignals: ["signature_counter_not_supported"]
    })]
  ])("rejects rehydrated %s before secret or verifier access", async (_name, tamper) => {
    const { executor, store, vault, verifier } = harness();
    const begun = await executor.begin(registrationCommand());
    store.ceremonies.set(
      begun.snapshot.ceremonyId,
      tamper(begun.snapshot) as CeremonyAggregate
    );
    const resolvesBefore = vault.resolveCount;
    const error = await captureDomainError(executor.verify({
      schemaVersion: PASSKEY_DOMAIN_VERSION,
      type: "verify",
      commandId: `rehydration-${_name.replaceAll(" ", "-")}`,
      ceremonyId: begun.snapshot.ceremonyId,
      actor,
      expectedRevision: 1,
      responseByteLength: 100,
      responseDigest
    }, {}));
    expect(error.code).toBe("STORAGE_INTEGRITY_FAILED");
    expect(`${error.message}${JSON.stringify(error)}`).not.toContain("REHYDRATION_SECRET_CANARY");
    expect(vault.resolveCount).toBe(resolvesBefore);
    expect(verifier.registrationCalls).toHaveLength(0);
  });

  it("rejects a receipt whose snapshot is rebound to another actor", async () => {
    const { executor, store, vault } = harness();
    const command = registrationCommand();
    await executor.begin(command);
    const receipt = [...store.commands.values()][0];
    expect(receipt).toBeDefined();
    if (receipt === undefined) throw new Error("missing test receipt");
    store.commands.set(receipt.scope, {
      ...receipt,
      result: {
        ...receipt.result,
        snapshot: {
          ...receipt.result.snapshot,
          actor: { accountId: "other-account", sessionId: "other-session", deviceId: "other-device" }
        }
      }
    });
    const resolvesBefore = vault.resolveCount;
    await expectCode(executor.begin(command), "STORAGE_INTEGRITY_FAILED");
    expect(vault.resolveCount).toBe(resolvesBefore);
  });

  it("does not resurrect a ceremony from a receipt when its aggregate is missing", async () => {
    const { executor, store } = harness();
    const command = registrationCommand();
    const begun = await executor.begin(command);
    store.ceremonies.delete(begun.snapshot.ceremonyId);
    await expectCode(executor.begin(command), "STORAGE_INTEGRITY_FAILED");
  });

  it("normalizes vault and verifier failures without propagating secret-bearing errors", async () => {
    const vaultHarness = harness();
    const vaultBegun = await vaultHarness.executor.begin(registrationCommand());
    const rawChallenge = vaultBegun.clientRequirements?.challenge ?? "";
    vaultHarness.vault.resolveError = new Error(`vault failed with ${rawChallenge}`);
    const vaultError = await captureDomainError(vaultHarness.executor.verify({
      schemaVersion: PASSKEY_DOMAIN_VERSION,
      type: "verify",
      commandId: "vault-error-verify",
      ceremonyId: vaultBegun.snapshot.ceremonyId,
      actor,
      expectedRevision: 1,
      responseByteLength: 100,
      responseDigest
    }, {}));
    expect(vaultError.code).toBe("CHALLENGE_UNAVAILABLE");
    expect(`${vaultError.message}${JSON.stringify(vaultError)}`).not.toContain(rawChallenge);

    const verifierHarness = harness();
    const verifierBegun = await verifierHarness.executor.begin(registrationCommand({
      commandId: "verifier-error-begin",
      clientNonce: "verifier-error-nonce"
    }));
    verifierHarness.verifier.registrationError = new PasskeyDomainError(
      "VALIDATION_FAILED",
      "VERIFIER_SECRET_CANARY"
    );
    const verifierError = await captureDomainError(verifierHarness.executor.verify({
      schemaVersion: PASSKEY_DOMAIN_VERSION,
      type: "verify",
      commandId: "verifier-error-verify",
      ceremonyId: verifierBegun.snapshot.ceremonyId,
      actor,
      expectedRevision: 1,
      responseByteLength: 100,
      responseDigest
    }, {}));
    expect(verifierError.code).toBe("VERIFIER_UNAVAILABLE");
    expect(`${verifierError.message}${JSON.stringify(verifierError)}`).not.toContain("VERIFIER_SECRET_CANARY");
  });

  it("rejects malformed or secret-decorated verifier output before persistence", async () => {
    const { executor, verifier, store } = harness();
    const result = makeRegistrationSuccess() as ReturnType<typeof makeRegistrationSuccess> & {
      credential: ReturnType<typeof makeRegistrationSuccess>["credential"] & { rawChallenge: string };
    };
    (result.credential as typeof result.credential).rawChallenge = "VERIFIER_OUTPUT_SECRET_CANARY";
    verifier.registrationResult = result;
    const begun = await executor.begin(registrationCommand());
    const error = await captureDomainError(executor.verify({
      schemaVersion: PASSKEY_DOMAIN_VERSION,
      type: "verify",
      commandId: "malformed-verifier-output",
      ceremonyId: begun.snapshot.ceremonyId,
      actor,
      expectedRevision: 1,
      responseByteLength: 100,
      responseDigest
    }, {}));
    expect(error.code).toBe("VERIFIER_UNAVAILABLE");
    expect(store.commits).toHaveLength(1);
    expect(JSON.stringify(store.commits)).not.toContain("VERIFIER_OUTPUT_SECRET_CANARY");
  });

  it("copies verified credential bytes before handing a secure effect to storage", async () => {
    const { executor, verifier, store } = harness();
    const success = makeRegistrationSuccess();
    verifier.registrationResult = success;
    const begun = await executor.begin(registrationCommand());
    await executor.verify({
      schemaVersion: PASSKEY_DOMAIN_VERSION,
      type: "verify",
      commandId: "credential-copy-verify",
      ceremonyId: begun.snapshot.ceremonyId,
      actor,
      expectedRevision: 1,
      responseByteLength: 100,
      responseDigest
    }, {});
    success.credential.publicKey.fill(0);
    success.credential.transports.push("usb");
    const effect = store.commits.at(-1)?.mutation.secureCredentialEffect;
    expect(effect?.type).toBe("store_registration_credential");
    if (effect?.type === "store_registration_credential") {
      expect(new TextDecoder().decode(effect.credential.publicKey)).toBe(publicKeyCanary);
      expect(effect.credential.transports).toEqual(["internal", "cable"]);
    }
  });

  it("expires a ceremony when verification finishes at the deadline", async () => {
    const { executor, verifier, store, clock } = harness();
    verifier.registrationResult = makeRegistrationSuccess();
    const begun = await executor.begin(registrationCommand());
    let release = (): void => undefined;
    verifier.registrationGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const verifying = executor.verify({
      schemaVersion: PASSKEY_DOMAIN_VERSION,
      type: "verify",
      commandId: "verify-crosses-expiry",
      ceremonyId: begun.snapshot.ceremonyId,
      actor,
      expectedRevision: 1,
      responseByteLength: 100,
      responseDigest
    }, {});
    while (verifier.registrationCalls.length === 0) await Promise.resolve();
    clock.value = begun.snapshot.expiresAtMs;
    release();
    const result = await verifying;
    expect(result.snapshot.state).toBe("expired");
    expect(store.commits.filter((entry) => entry.mutation.secureCredentialEffect !== null)).toHaveLength(0);
  });

  it("enforces global credential ID uniqueness across accounts without consuming the loser", async () => {
    const { executor, verifier, store } = harness();
    verifier.registrationResult = makeRegistrationSuccess();
    const first = await executor.begin(registrationCommand());
    await executor.verify({
      schemaVersion: PASSKEY_DOMAIN_VERSION,
      type: "verify",
      commandId: "unique-credential-first-verify",
      ceremonyId: first.snapshot.ceremonyId,
      actor,
      expectedRevision: 1,
      responseByteLength: 100,
      responseDigest
    }, {});

    const secondActor = { accountId: "account-2", sessionId: "session-2", deviceId: "device-2" };
    verifier.registrationResult = {
      ...makeRegistrationSuccess(),
      credential: {
        ...makeRegistrationSuccess().credential,
        accountId: secondActor.accountId,
        userHandleRef: "user-handle-ref-2"
      }
    };
    const second = await executor.begin(registrationCommand({
      commandId: "unique-credential-second-begin",
      clientNonce: "unique-credential-second-nonce",
      actor: secondActor,
      userHandleRef: "user-handle-ref-2"
    }));
    await expectCode(executor.verify({
      schemaVersion: PASSKEY_DOMAIN_VERSION,
      type: "verify",
      commandId: "unique-credential-second-verify",
      ceremonyId: second.snapshot.ceremonyId,
      actor: secondActor,
      expectedRevision: 1,
      responseByteLength: 100,
      responseDigest
    }, {}), "CREDENTIAL_CONFLICT");
    expect(store.ceremonies.get(second.snapshot.ceremonyId)).toMatchObject({ state: "pending", revision: 1 });
    expect(store.commits.filter((entry) => entry.mutation.secureCredentialEffect?.type === "store_registration_credential"))
      .toHaveLength(1);
  });

  it("CASes credential-row revision so concurrent signCount updates cannot both commit", async () => {
    const { executor, verifier, store } = harness();
    verifier.authenticationResult = {
      status: "verified",
      kind: "authentication",
      credential: {
        credentialRecordId: "credential-record-existing",
        credentialRevision: 1,
        accountId: actor.accountId,
        discoveryMode: "discoverable",
        userHandleBindingVerified: true,
        previousSignCount: 9,
        newSignCount: 10,
        previousBackupEligible: true,
        backupEligible: true,
        previousBackupState: false,
        backupState: false,
        userPresent: true,
        userVerified: true
      }
    };
    const left = await executor.begin(authenticationCommand("discoverable", {
      commandId: "credential-cas-left-begin",
      clientNonce: "credential-cas-left-nonce"
    }));
    const right = await executor.begin(authenticationCommand("discoverable", {
      commandId: "credential-cas-right-begin",
      clientNonce: "credential-cas-right-nonce"
    }));
    const verify = (ceremonyId: string, commandId: string) => executor.verify({
      schemaVersion: PASSKEY_DOMAIN_VERSION,
      type: "verify",
      commandId,
      ceremonyId,
      actor,
      expectedRevision: 1,
      responseByteLength: 100,
      responseDigest
    }, {});
    const results = await Promise.allSettled([
      verify(left.snapshot.ceremonyId, "credential-cas-left-verify"),
      verify(right.snapshot.ceremonyId, "credential-cas-right-verify")
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((result) => result.status === "rejected") as PromiseRejectedResult;
    expect(rejected.reason).toMatchObject({ code: "CREDENTIAL_STATE_CONFLICT" });
    expect(store.credentialStates.get("credential-record-existing")).toMatchObject({ revision: 2, signCount: 10 });
    const states = [left.snapshot.ceremonyId, right.snapshot.ceremonyId]
      .map((ceremonyId) => store.ceremonies.get(ceremonyId)?.state)
      .sort();
    expect(states).toEqual(["consumed", "pending"]);
  });
});

describe("properties", () => {
  it("never exceeds the attempt limit and reaches one immutable terminal boundary", () => {
    fc.assert(fc.property(
      fc.integer({ min: 1, max: 5 }),
      fc.integer({ min: 0, max: 12 }),
      (maxAttempts, requestedAttempts) => {
        const ids = new TestIds();
        const policy = createLuxoraPasskeyPolicy({ maxAttempts });
        const descriptor = {
          reference: "challenge-ref-property",
          digest: "b".repeat(64),
          byteLength: PASSKEY_CHALLENGE_BYTES
        } as const;
        let ceremony = startCeremony(
          registrationCommand({ commandId: "property-begin", clientNonce: "property-nonce" }),
          descriptor,
          policy,
          { nowMs: 1_000, ids }
        ).snapshot;
        const applied = Math.min(requestedAttempts, maxAttempts);
        for (let index = 0; index < applied; index += 1) {
          ceremony = rejectVerificationAttempt(
            ceremony,
            `property-attempt-${index}`,
            ceremony.revision,
            { nowMs: 1_001 + index, ids }
          ).snapshot;
        }
        expect(ceremony.attemptsUsed).toBe(applied);
        expect(ceremony.attemptsUsed).toBeLessThanOrEqual(maxAttempts);
        expect(ceremony.revision).toBe(1 + applied);
        expect(ceremony.state).toBe(applied === maxAttempts ? "rejected" : "pending");
      }
    ));
  });

  it("emits only the finite, duplicate-free counter/backup signal vocabulary", () => {
    const allowed = new Set<PasskeyRiskSignal>([
      "signature_counter_not_supported",
      "signature_counter_anomaly",
      "backup_state_enabled",
      "backup_state_disabled",
      "single_device_credential",
      "backup_not_active"
    ]);
    fc.assert(fc.property(
      fc.integer({ min: 0, max: 0xffff_ffff }),
      fc.integer({ min: 0, max: 0xffff_ffff }),
      fc.boolean(),
      fc.boolean(),
      fc.boolean(),
      (previous, next, eligible, previousStateInput, stateInput) => {
        const previousState = eligible && previousStateInput;
        const state = eligible && stateInput;
        const credential = {
          credentialRecordId: "credential-record-property",
          credentialRevision: 1,
          accountId: actor.accountId,
          discoveryMode: "discoverable",
          userHandleBindingVerified: true,
          previousSignCount: previous,
          newSignCount: next,
          previousBackupEligible: eligible,
          backupEligible: eligible,
          previousBackupState: previousState,
          backupState: state,
          userPresent: true,
          userVerified: true
        } as const;
        const signals = authenticationRiskSignals(credential);
        expect(new Set(signals).size).toBe(signals.length);
        expect(signals.every((signal) => allowed.has(signal))).toBe(true);
        expect(signals.includes("signature_counter_not_supported"))
          .toBe(previous === 0 && next === 0);
        expect(signals.includes("signature_counter_anomaly"))
          .toBe(previous > 0 && next <= previous);
      }
    ));
  });
});
