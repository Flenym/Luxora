import { createHash } from "node:crypto";
import {
  CallControlError,
  StoreDuplicateCommandError,
  StoreDuplicateCreationError,
  StoreRevisionConflictError
} from "./errors.js";
import { transitionCall } from "./state-machine.js";
import type {
  CallActor,
  CallCommand,
  CallControlStore,
  Clock,
  CommandReceipt,
  CreateCallCommand,
  CreationReceipt,
  ExecutedCallCommand,
  IdGenerator,
  StoredCommandResult
} from "./types.js";
import { assertCommand } from "./validation.js";

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`).join(",")}}`;
}

function digest(value: unknown): string {
  return createHash("sha256").update(canonical(value), "utf8").digest("hex");
}

function actorScope(actor: CallActor): unknown {
  return actor.kind === "participant"
    ? {
        kind: actor.kind,
        memberId: actor.memberId,
        deviceId: actor.deviceId,
        sessionId: actor.sessionId
      }
    : actor;
}

function commandScope(command: CallCommand): string {
  return `command:${digest({ actor: actorScope(command.actor), commandId: command.commandId })}`;
}

function creationScope(command: CreateCallCommand): string {
  return `create:${digest({ actor: actorScope(command.actor), clientNonce: command.clientNonce })}`;
}

function creationFingerprint(command: CreateCallCommand): string {
  return digest({
    actor: actorScope(command.actor),
    conversationId: command.conversationId,
    kind: command.kind,
    mediaMode: command.mediaMode,
    invitees: command.invitees,
    scheduledStartAtMs: command.scheduledStartAtMs,
    metadata: command.metadata
  });
}

function replay(receipt: CommandReceipt | CreationReceipt): ExecutedCallCommand {
  return {
    snapshot: receipt.result.snapshot,
    eventId: receipt.result.eventId,
    outboxId: null,
    replayed: true
  };
}

export class CallControlExecutor {
  readonly #store: CallControlStore;
  readonly #clock: Clock;
  readonly #ids: IdGenerator;

  constructor(store: CallControlStore, clock: Clock, ids: IdGenerator) {
    this.#store = store;
    this.#clock = clock;
    this.#ids = ids;
  }

  async execute(command: CallCommand): Promise<ExecutedCallCommand> {
    assertCommand(command);
    const scope = commandScope(command);
    const fingerprint = digest(command);
    const priorCommand = await this.#store.findCommandReceipt(scope);
    if (priorCommand !== null) {
      if (priorCommand.fingerprint !== fingerprint) {
        throw new CallControlError("IDEMPOTENCY_KEY_REUSED", "commandId was reused with a different command");
      }
      return replay(priorCommand);
    }

    let createReceiptScope: string | null = null;
    let createFingerprint: string | null = null;
    if (command.type === "create_call") {
      createReceiptScope = creationScope(command);
      createFingerprint = creationFingerprint(command);
      const priorCreation = await this.#store.findCreationReceipt(createReceiptScope);
      if (priorCreation !== null) {
        if (priorCreation.fingerprint !== createFingerprint) {
          throw new CallControlError("CREATION_NONCE_REUSED", "clientNonce was reused for different call creation input");
        }
        return replay(priorCreation);
      }
    }

    const current = command.type === "create_call" ? null : await this.#store.loadCall(command.callId);
    const nowMs = this.#clock.nowMs();
    const mutation = transitionCall(current, command, { nowMs, ids: this.#ids });
    const result: StoredCommandResult = {
      callId: mutation.snapshot.callId,
      revision: mutation.snapshot.revision,
      eventId: mutation.event.eventId,
      snapshot: mutation.snapshot
    };
    const commandReceipt: CommandReceipt = { scope, fingerprint, result, createdAtMs: nowMs };
    const creationReceipt: CreationReceipt | null = createReceiptScope === null || createFingerprint === null
      ? null
      : { scope: createReceiptScope, fingerprint: createFingerprint, result, createdAtMs: nowMs };

    try {
      await this.#store.commit({
        expectedRevision: command.type === "create_call" ? null : command.expectedRevision,
        mutation,
        commandReceipt,
        creationReceipt
      });
    } catch (error) {
      if (error instanceof StoreDuplicateCommandError) {
        const winner = await this.#store.findCommandReceipt(scope);
        if (winner !== null && winner.fingerprint === fingerprint) return replay(winner);
        throw new CallControlError("IDEMPOTENCY_KEY_REUSED", "concurrent commandId reuse did not match");
      }
      if (error instanceof StoreDuplicateCreationError && createReceiptScope !== null && createFingerprint !== null) {
        const winner = await this.#store.findCreationReceipt(createReceiptScope);
        if (winner !== null && winner.fingerprint === createFingerprint) return replay(winner);
        throw new CallControlError("CREATION_NONCE_REUSED", "concurrent clientNonce reuse did not match");
      }
      if (error instanceof StoreRevisionConflictError) {
        // A correct transactional store may check CAS before unique receipt
        // constraints. Re-read receipts so concurrent identical retries still
        // converge regardless of that implementation-specific check order.
        const commandWinner = await this.#store.findCommandReceipt(scope);
        if (commandWinner !== null) {
          if (commandWinner.fingerprint === fingerprint) return replay(commandWinner);
          throw new CallControlError("IDEMPOTENCY_KEY_REUSED", "concurrent commandId reuse did not match");
        }
        if (createReceiptScope !== null && createFingerprint !== null) {
          const creationWinner = await this.#store.findCreationReceipt(createReceiptScope);
          if (creationWinner !== null) {
            if (creationWinner.fingerprint === createFingerprint) return replay(creationWinner);
            throw new CallControlError("CREATION_NONCE_REUSED", "concurrent clientNonce reuse did not match");
          }
        }
        const winner = await this.#store.loadCall(mutation.snapshot.callId);
        throw new CallControlError("REVISION_CONFLICT", "another command committed first", winner);
      }
      throw error;
    }

    return {
      snapshot: mutation.snapshot,
      eventId: mutation.event.eventId,
      outboxId: mutation.outbox.outboxId,
      replayed: false
    };
  }
}

export const commandFingerprintForTesting = digest;
