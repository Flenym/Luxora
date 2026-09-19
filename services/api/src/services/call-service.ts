import { randomUUID } from "node:crypto";
import {
  CALL_CONTROL_VERSION,
  CallControlError,
  CallControlExecutor,
  type CallAggregate,
  type CallControlStore
} from "@luxora/call-control";
import {
  CallResponseSchema,
  type CallResponse as ProtocolCallResponse,
  type HangupCallRequest,
  type DeclineCallRequest,
  type CreateCallRequest
} from "@luxora/protocol";
import type { Store } from "../domain/store.js";
import { badRequest, conflict, forbidden, notFound } from "../errors.js";

export interface CreateCallInput extends CreateCallRequest {}

export interface CallMutationResult {
  call: ProtocolCallResponse;
  replayed: boolean;
  unreachableMemberIds: string[];
}

function projectCall(snapshot: CallAggregate): ProtocolCallResponse {
  return CallResponseSchema.parse({
    callId: snapshot.callId,
    chatId: snapshot.conversationId,
    kind: snapshot.kind,
    mediaMode: snapshot.mediaMode,
    state: snapshot.state,
    revision: snapshot.revision,
    epoch: snapshot.epoch,
    creatorMemberId: snapshot.creatorMemberId,
    participants: snapshot.participants.map((participant) => ({
      membershipId: participant.membershipId,
      memberId: participant.memberId,
      role: participant.role,
      status: participant.status,
      membershipEpoch: participant.membershipEpoch,
      invitedAtMs: participant.invitedAtMs,
      acceptedAtMs: participant.acceptedAtMs,
      activeAtMs: participant.activeAtMs,
      removedAtMs: participant.removedAtMs
    })),
    createdAtMs: snapshot.createdAtMs,
    updatedAtMs: snapshot.updatedAtMs,
    pendingEndReason: snapshot.pendingEndReason,
    endReason: snapshot.endReason,
    endedAtMs: snapshot.endedAtMs
  });
}

/**
 * Call signaling first slice (CALLS_PLATFORM §7): lifecycle records for
 * direct chats — create/get/cancel/hangup — backed by the audited
 * `@luxora/call-control` executor. No invite/ring/push, no join-grants, no
 * webhooks yet; the capabilities `calls` flag stays `false`.
 *
 * Internal media identifiers (`roomName`) and device/session internals never
 * leave the server in this slice. A call that reaches `ending` is finalized
 * to `ended` by the server immediately; media-plane confirmation arrives
 * with the webhook slice.
 */
export class CallService {
  readonly #store: Store;
  readonly #executor: CallControlExecutor;

  constructor(store: Store) {
    this.#store = store;
    const adapter: CallControlStore = {
      loadCall: async (callId) => this.#store.loadCallAggregate(callId),
      findCommandReceipt: async (scope) => this.#store.findCallCommandReceipt(scope),
      findCreationReceipt: async (scope) => this.#store.findCallCreationReceipt(scope),
      commit: async (input) => this.#store.commitCallMutation(input)
    };
    this.#executor = new CallControlExecutor(adapter, { nowMs: () => Date.now() }, { next: () => randomUUID() });
  }

  async createCall(userId: string, sessionId: string, input: CreateCallInput): Promise<CallMutationResult> {
    const chat = this.#store.findChatRecord(input.chatId);
    if (chat === null) throw notFound("Chat not found");
    if (this.#store.getChatMember(input.chatId, userId) === null) {
      throw forbidden("You are not a member of this chat");
    }
    if (chat.kind !== "direct" && chat.kind !== "group") {
      throw badRequest("Calls are limited to direct and group chats in this slice");
    }
    const peerIds = this.#store.listChatMemberIds(input.chatId).filter((memberId) => memberId !== userId);
    if (chat.kind === "direct" && peerIds.length !== 1) {
      throw badRequest("Direct chat must have exactly one peer");
    }
    if (peerIds.length < 1) throw badRequest("Call requires at least one other member");
    for (const peerId of peerIds) {
      if (this.#store.isBlockedBetween(userId, peerId as string)) {
        throw forbidden("Call is not allowed under the current block policy");
      }
    }
    const invitees: Array<{ memberId: string; deviceId: string }> = [];
    const unreachableMemberIds: string[] = [];
    for (const peerId of peerIds) {
      const deviceId = this.#store.listSessions(peerId as string, "").at(0)?.id;
      if (deviceId === undefined) {
        unreachableMemberIds.push(peerId as string);
      } else {
        invitees.push({ memberId: peerId as string, deviceId });
      }
    }
    if (invitees.length < 1) {
      throw conflict("No reachable member to invite yet");
    }

    try {
      const executed = await this.#executor.execute({
        schemaVersion: CALL_CONTROL_VERSION,
        commandId: randomUUID(),
        actor: { kind: "participant", memberId: userId, deviceId: sessionId, sessionId },
        expectedRevision: 0,
        type: "create_call",
        clientNonce: input.clientNonce,
        conversationId: input.chatId,
        kind: chat.kind === "direct" ? "one_to_one" : "group",
        mediaMode: input.mediaMode,
        invitees,
        scheduledStartAtMs: null,
        metadata: {}
      });
      return { call: projectCall(executed.snapshot), replayed: executed.replayed, unreachableMemberIds };
    } catch (error) {
      throw this.#mapError(error, null);
    }
  }

  getCall(userId: string, callId: string): ProtocolCallResponse {
    return projectCall(this.#requireParticipantCall(userId, callId));
  }

  async cancelCall(userId: string, sessionId: string, callId: string, expectedRevision: number): Promise<ProtocolCallResponse> {
    this.#requireParticipantCall(userId, callId);
    try {
      const executed = await this.#executor.execute({
        schemaVersion: CALL_CONTROL_VERSION,
        commandId: randomUUID(),
        actor: { kind: "participant", memberId: userId, deviceId: sessionId, sessionId },
        expectedRevision,
        type: "cancel",
        callId
      });
      return await this.#finishEndingIfNeeded(executed.snapshot.callId, executed.snapshot);
    } catch (error) {
      throw this.#mapError(error, callId);
    }
  }

  async hangupCall(
    userId: string,
    sessionId: string,
    callId: string,
    input: HangupCallRequest
  ): Promise<ProtocolCallResponse> {
    this.#requireParticipantCall(userId, callId);
    try {
      const executed = await this.#executor.execute({
        schemaVersion: CALL_CONTROL_VERSION,
        commandId: randomUUID(),
        actor: { kind: "participant", memberId: userId, deviceId: sessionId, sessionId },
        expectedRevision: input.expectedRevision,
        type: "hangup",
        scope: input.scope,
        callId
      });
      return await this.#finishEndingIfNeeded(executed.snapshot.callId, executed.snapshot);
    } catch (error) {
      throw this.#mapError(error, callId);
    }
  }

  /**
   * Host-driven advance to `ringing`. State-aware: resumes from `inviting`
   * when a previous attempt committed only the first step.
   */
  async ringCall(
    userId: string,
    sessionId: string,
    callId: string,
    expectedRevision: number
  ): Promise<ProtocolCallResponse> {
    const current = this.#requireParticipantCall(userId, callId);
    const actor = { kind: "participant", memberId: userId, deviceId: sessionId, sessionId } as const;
    try {
      let snapshot = current;
      let revision = expectedRevision;
      if (snapshot.state === "created") {
        const inviting = await this.#executor.execute({
          schemaVersion: CALL_CONTROL_VERSION,
          commandId: randomUUID(),
          actor,
          expectedRevision: revision,
          type: "start_inviting",
          callId
        });
        snapshot = inviting.snapshot;
        revision = snapshot.revision;
      }
      if (snapshot.state === "inviting") {
        const ringing = await this.#executor.execute({
          schemaVersion: CALL_CONTROL_VERSION,
          commandId: randomUUID(),
          actor,
          expectedRevision: revision,
          type: "start_ringing",
          callId
        });
        snapshot = ringing.snapshot;
      }
      if (snapshot.state !== "ringing") {
        throw conflict("Call is not in a ringable state", { call: projectCall(snapshot) });
      }
      return projectCall(snapshot);
    } catch (error) {
      throw this.#mapError(error, callId);
    }
  }

  async acceptCall(
    userId: string,
    sessionId: string,
    callId: string,
    expectedRevision: number
  ): Promise<ProtocolCallResponse> {
    this.#requireParticipantCall(userId, callId);
    try {
      const executed = await this.#executor.execute({
        schemaVersion: CALL_CONTROL_VERSION,
        commandId: randomUUID(),
        actor: { kind: "participant", memberId: userId, deviceId: sessionId, sessionId },
        expectedRevision,
        type: "accept",
        callId
      });
      return projectCall(executed.snapshot);
    } catch (error) {
      throw this.#mapError(error, callId);
    }
  }

  async declineCall(
    userId: string,
    sessionId: string,
    callId: string,
    input: DeclineCallRequest
  ): Promise<ProtocolCallResponse> {
    this.#requireParticipantCall(userId, callId);
    try {
      const executed = await this.#executor.execute({
        schemaVersion: CALL_CONTROL_VERSION,
        commandId: randomUUID(),
        actor: { kind: "participant", memberId: userId, deviceId: sessionId, sessionId },
        expectedRevision: input.expectedRevision,
        type: "decline",
        reason: input.reason,
        callId
      });
      return await this.#finishEndingIfNeeded(executed.snapshot.callId, executed.snapshot);
    } catch (error) {
      throw this.#mapError(error, callId);
    }
  }

  #requireParticipantCall(userId: string, callId: string): CallAggregate {
    const snapshot = this.#store.loadCallAggregate(callId);
    if (snapshot === null) throw notFound("Call not found");
    if (!snapshot.participants.some((participant) => participant.memberId === userId)) {
      throw notFound("Call not found");
    }
    return snapshot;
  }

  async #finishEndingIfNeeded(callId: string, snapshot: CallAggregate): Promise<ProtocolCallResponse> {
    if (snapshot.state !== "ending") return projectCall(snapshot);
    try {
      const finished = await this.#executor.execute({
        schemaVersion: CALL_CONTROL_VERSION,
        commandId: randomUUID(),
        actor: { kind: "system", subject: "operations" },
        expectedRevision: snapshot.revision,
        type: "finish_ending",
        callId
      });
      return projectCall(finished.snapshot);
    } catch (error) {
      if (error instanceof CallControlError && error.code === "REVISION_CONFLICT") {
        const latest = this.#store.loadCallAggregate(callId);
        if (latest !== null) return projectCall(latest);
      }
      throw this.#mapError(error, callId);
    }
  }

  #mapError(error: unknown, callId: string | null): Error {
    if (!(error instanceof CallControlError)) throw error as Error;
    switch (error.code) {
      case "VALIDATION_FAILED":
        throw badRequest(error.message);
      case "NOT_FOUND":
      case "MEMBERSHIP_NOT_FOUND":
        throw notFound(error.message);
      case "FORBIDDEN":
      case "MEMBERSHIP_REVOKED":
      case "GRANT_DENIED":
        throw forbidden(error.message);
      case "REVISION_CONFLICT":
      case "IDEMPOTENCY_KEY_REUSED":
      case "CREATION_NONCE_REUSED":
      case "COMMAND_NOT_ALLOWED":
      case "TERMINAL_CALL": {
        const snapshot = error.currentSnapshot ??
          (callId !== null ? this.#store.loadCallAggregate(callId) : null);
        throw conflict(
          error.message,
          snapshot === null ? undefined : { call: projectCall(snapshot) }
        );
      }
    }
  }
}
