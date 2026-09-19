import { createHash, randomUUID } from "node:crypto";
import {
  CALL_CONTROL_VERSION,
  CallControlError,
  CallControlExecutor,
  issueJoinGrant,
  type CallAggregate,
  type CallControlStore,
  type LiveKitTrackSource
} from "@luxora/call-control";
import {
  CallResponseSchema,
  JoinGrantResponseSchema,
  type CallResponse as ProtocolCallResponse,
  type HangupCallRequest,
  type DeclineCallRequest,
  type InviteCallParticipantRequest,
  type JoinGrantRequest,
  type JoinGrantResponse,
  type CreateCallRequest
} from "@luxora/protocol";
import type { Store } from "../domain/store.js";
import { badRequest, conflict, forbidden, notFound, serviceUnavailable, unauthenticated } from "../errors.js";
import { createSfuSigner, createTurnSigner } from "./call-grant-signers.js";
import { verifyLivekitWebhook } from "./call-webhook.js";

export interface CallMediaPlaneConfig {
  livekitUrl: string;
  livekitApiKey: string;
  livekitApiSecret: string;
  turnSharedSecret: string;
  turnUrls: string[];
}

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
  readonly #mediaPlane: CallMediaPlaneConfig | undefined;

  constructor(store: Store, mediaPlane?: CallMediaPlaneConfig) {
    this.#store = store;
    this.#mediaPlane = mediaPlane;
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

  /**
   * Host-driven mid-call invite. The invitee must be a current chat member
   * with a live session; one_to_one membership stays fixed by the domain.
   */
  async inviteParticipant(
    userId: string,
    sessionId: string,
    callId: string,
    input: InviteCallParticipantRequest
  ): Promise<ProtocolCallResponse> {
    const snapshot = this.#requireParticipantCall(userId, callId);
    if (this.#store.getChatMember(snapshot.conversationId, input.inviteeMemberId) === null) {
      throw notFound("Invitee is not a member of this chat");
    }
    if (this.#store.isBlockedBetween(userId, input.inviteeMemberId)) {
      throw forbidden("Invite is not allowed under the current block policy");
    }
    const deviceId = this.#store.listSessions(input.inviteeMemberId, "").at(0)?.id;
    if (deviceId === undefined) {
      throw conflict("Invitee has no active session to invite yet");
    }
    try {
      const executed = await this.#executor.execute({
        schemaVersion: CALL_CONTROL_VERSION,
        commandId: randomUUID(),
        actor: { kind: "participant", memberId: userId, deviceId: sessionId, sessionId },
        expectedRevision: input.expectedRevision,
        type: "invite_participant",
        invitee: { memberId: input.inviteeMemberId, deviceId },
        callId
      });
      return projectCall(executed.snapshot);
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

  /**
   * Crash-cleanup sweeper: calls stuck with a `reconnecting` participant and
   * no state change for longer than `timeoutMs` are ended with
   * `network-timeout` (system media-plane actor) and finalized. Bounded per
   * sweep; failures are counted for the caller to log. Runs on the shared
   * 10-minute cleanup timer.
   */
  async sweepStaleReconnecting(now: Date, timeoutMs: number, limit = 100): Promise<{ ended: number; failures: number }> {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 60_000) {
      throw new Error("Stale reconnecting timeout must be at least one minute");
    }
    const beforeIso = new Date(now.getTime() - timeoutMs).toISOString();
    let ended = 0;
    let failures = 0;
    for (const known of this.#store.listStaleReconnectingCalls(beforeIso, limit)) {
      try {
        const latest = this.#store.loadCallAggregate(known.callId);
        if (latest === null) continue;
        if (
          (latest.state !== "active" && latest.state !== "reconnecting") ||
          !latest.participants.some((participant) => participant.status === "reconnecting")
        ) {
          continue;
        }
        const ending = await this.#executor.execute({
          schemaVersion: CALL_CONTROL_VERSION,
          commandId: randomUUID(),
          actor: { kind: "system", subject: "media-plane" },
          expectedRevision: latest.revision,
          type: "end_call",
          reason: "network-timeout",
          callId: known.callId
        });
        await this.#finishEndingIfNeeded(ending.snapshot.callId, ending.snapshot);
        ended += 1;
      } catch (error) {
        if (error instanceof CallControlError) continue;
        failures += 1;
      }
    }
    return { ended, failures };
  }

  /**
   * Membership-service reconciliation (CALLS_PLATFORM §5 rule 4): after a
   * chat member is removed, every live call in that chat revokes the
   * member's call memberships (epoch bump, media participant out). Session
   * revokes need no hook: grant issuance rechecks session liveness, so only
   * future grants are affected and in-flight tokens expire within 120s.
   * Idempotent: already-terminal memberships are skipped; failures are
   * counted for the caller to log and retry on the next removal.
   */
  async reconcileMembership(chatId: string, memberId: string): Promise<{ revoked: number; failures: number }> {
    const terminal = new Set(["declined", "left", "kicked", "revoked"]);
    let revoked = 0;
    let failures = 0;
    for (const known of this.#store.listLiveCallsForChat(chatId)) {
      const targets = known.participants.filter(
        (participant) => participant.memberId === memberId && !terminal.has(participant.status)
      );
      for (const target of targets) {
        try {
          const latest = this.#store.loadCallAggregate(known.callId);
          if (latest === null) continue;
          const current = latest.participants.find((p) => p.membershipId === target.membershipId);
          if (current === undefined || terminal.has(current.status)) continue;
          const executed = await this.#executor.execute({
            schemaVersion: CALL_CONTROL_VERSION,
            commandId: randomUUID(),
            actor: { kind: "system", subject: "membership-service" },
            expectedRevision: latest.revision,
            type: "membership_removed",
            membershipId: target.membershipId,
            callId: known.callId
          });
          revoked += 1;
          await this.#finishEndingIfNeeded(executed.snapshot.callId, executed.snapshot);
        } catch (error) {
          if (
            error instanceof CallControlError &&
            (error.code === "MEMBERSHIP_REVOKED" ||
              error.code === "TERMINAL_CALL" ||
              error.code === "COMMAND_NOT_ALLOWED" ||
              error.code === "MEMBERSHIP_NOT_FOUND")
          ) {
            continue;
          }
          failures += 1;
        }
      }
    }
    return { revoked, failures };
  }

  /**
   * LiveKit webhook ingest (CALLS_PLATFORM §5 rule 5): authenticated by the
   * media-plane signature, deduplicated by webhook event id, and limited to
   * confirming media-plane facts — it can never grant Luxora authorization.
   * Unknown rooms/participants/events and inapplicable states are
   * acknowledged without effect so the SFU does not retry poison deliveries.
   * Always answers 200 with `{received: true}`: no oracle distinguishes
   * unknown rooms from handled events.
   */
  async handleLivekitWebhook(rawBody: Buffer, authHeader: string | string[] | undefined): Promise<{ received: true; callId: string | null }> {
    const mediaPlane = this.#mediaPlane;
    // Authentication first: without configured secrets no delivery can be
    // verified, so an unconfigured plane rejects everything with 401 rather
    // than attempting verification against empty key material.
    if (mediaPlane === undefined) throw unauthenticated("LiveKit webhook signature is invalid");
    const event = await verifyLivekitWebhook(rawBody, authHeader, {
      apiKey: mediaPlane.livekitApiKey,
      apiSecret: mediaPlane.livekitApiSecret
    });
    const callId = this.#store.findCallIdByRoomName(event.roomName);
    if (callId === null) return { received: true, callId: null };
    const snapshot = this.#store.loadCallAggregate(callId);
    if (snapshot === null) return { received: true, callId: null };

    const commandId = (command: string): string => {
      const raw = `livekit-webhook:${event.id}:${command}`;
      if (/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(raw)) return raw;
      return `livekit-webhook:${createHash("sha256").update(event.id, "utf8").digest("hex")}:${command}`;
    };
    const systemActor = { kind: "system", subject: "media-plane" } as const;
    const runOnce = async (command: Parameters<CallControlExecutor["execute"]>[0]): Promise<CallAggregate | null> => {
      try {
        const executed = await this.#executor.execute(command);
        return executed.snapshot;
      } catch (error) {
        if (!(error instanceof CallControlError)) throw error;
        if (error.code === "REVISION_CONFLICT") {
          const latest = this.#store.loadCallAggregate(callId);
          if (latest === null) return null;
          try {
            const retried = await this.#executor.execute({ ...command, expectedRevision: latest.revision } as typeof command);
            return retried.snapshot;
          } catch (retryError) {
            if (retryError instanceof CallControlError) return latest;
            throw retryError;
          }
        }
        return this.#store.loadCallAggregate(callId);
      }
    };

    switch (event.event) {
      case "participant_joined": {
        if (event.participantIdentity === null) return { received: true, callId };
        const membership = snapshot.participants.find(
          (participant) => participant.participantIdentity === event.participantIdentity
        );
        if (membership === undefined) return { received: true, callId };
        if (membership.status === "active" && snapshot.state === "active") {
          return { received: true, callId };
        }
        await runOnce({
          schemaVersion: CALL_CONTROL_VERSION,
          commandId: commandId("mark_active"),
          actor: systemActor,
          expectedRevision: snapshot.revision,
          type: "mark_active",
          membershipId: membership.membershipId,
          callId
        });
        return { received: true, callId };
      }
      case "participant_left":
      case "participant_connection_aborted": {
        if (event.participantIdentity === null) return { received: true, callId };
        const membership = snapshot.participants.find(
          (participant) => participant.participantIdentity === event.participantIdentity
        );
        if (membership === undefined) return { received: true, callId };
        if (membership.status !== "active" || (snapshot.state !== "active" && snapshot.state !== "reconnecting")) {
          return { received: true, callId };
        }
        await runOnce({
          schemaVersion: CALL_CONTROL_VERSION,
          commandId: commandId("connection_lost"),
          actor: systemActor,
          expectedRevision: snapshot.revision,
          type: "connection_lost",
          membershipId: membership.membershipId,
          callId
        });
        return { received: true, callId };
      }
      case "room_finished": {
        if (snapshot.state === "ended") return { received: true, callId };
        if (snapshot.state !== "ending") {
          const ending = await runOnce({
            schemaVersion: CALL_CONTROL_VERSION,
            commandId: commandId("end_call"),
            actor: systemActor,
            expectedRevision: snapshot.revision,
            type: "end_call",
            reason: "completed",
            callId
          });
          if (ending === null || ending.state !== "ending") return { received: true, callId };
          await runOnce({
            schemaVersion: CALL_CONTROL_VERSION,
            commandId: commandId("finish_ending"),
            actor: systemActor,
            expectedRevision: ending.revision,
            type: "finish_ending",
            callId
          });
          return { received: true, callId };
        }
        const latest = this.#store.loadCallAggregate(callId);
        if (latest !== null && latest.state === "ending") {
          await runOnce({
            schemaVersion: CALL_CONTROL_VERSION,
            commandId: commandId("finish_ending"),
            actor: systemActor,
            expectedRevision: latest.revision,
            type: "finish_ending",
            callId
          });
        }
        return { received: true, callId };
      }
      default:
        return { received: true, callId };
    }
  }

  /**
   * Issues SFU + TURN transport credentials (CALLS_PLATFORM §6). The grant is
   * bound to the current call/participant epoch and the caller's live
   * session; membership, relationship, block and media-mode policy are
   * rechecked on every issuance. Per-request rate limiting is the bounded
   * abuse control in this slice. Answers 503 until the media plane is
   * configured; the capabilities `calls` flag stays `false`.
   */
  async issueJoinGrant(
    userId: string,
    sessionId: string,
    callId: string,
    input: JoinGrantRequest
  ): Promise<JoinGrantResponse> {
    const mediaPlane = this.#mediaPlane;
    if (mediaPlane === undefined) throw serviceUnavailable("Call media plane is not configured");
    const snapshot = this.#requireParticipantCall(userId, callId);
    const membership = snapshot.participants.find(
      (participant) => participant.memberId === userId && participant.deviceId === sessionId
    );
    if (membership === undefined) throw notFound("Call membership was not found for this session");

    const chat = this.#store.findChatRecord(snapshot.conversationId);
    const conversationMember = chat !== null && this.#store.getChatMember(chat.id, userId) !== null;
    let messageRequestAccepted: boolean;
    let relationshipBlocked: boolean;
    if (chat !== null && chat.kind === "direct") {
      const peerId = snapshot.participants.map((p) => p.memberId).find((memberId) => memberId !== userId);
      messageRequestAccepted = peerId !== undefined && this.#store.hasAcceptedRelationship(userId, peerId);
      relationshipBlocked = peerId !== undefined && this.#store.isBlockedBetween(userId, peerId);
    } else {
      messageRequestAccepted = conversationMember;
      relationshipBlocked = snapshot.participants.some(
        (participant) => participant.memberId !== userId && this.#store.isBlockedBetween(userId, participant.memberId)
      );
    }
    const deviceSessionAllowed = this.#store.isSessionActive(sessionId, userId, new Date().toISOString());
    const requestedSources = input.requestedSources as LiveKitTrackSource[];

    try {
      const granted = await issueJoinGrant(
        snapshot,
        membership,
        {
          subjectMembershipId: membership.membershipId,
          subjectMemberId: userId,
          subjectDeviceId: sessionId,
          conversationMember,
          messageRequestAccepted,
          relationshipBlocked,
          deviceSessionAllowed,
          abusePolicyAllowed: true,
          callEpoch: snapshot.epoch,
          membershipEpoch: membership.membershipEpoch
        },
        {
          requestedSources,
          allowedSources: snapshot.mediaMode === "video"
            ? ["microphone", "camera", "screen_share", "screen_share_audio"]
            : ["microphone"],
          consentedSources: requestedSources,
          turnUrls: mediaPlane.turnUrls
        },
        {
          clock: { nowMs: () => Date.now() },
          ids: { next: () => randomUUID() },
          sfuSigner: createSfuSigner(mediaPlane.livekitApiKey, mediaPlane.livekitApiSecret),
          turnSigner: createTurnSigner(mediaPlane.turnSharedSecret)
        }
      );
      return JoinGrantResponseSchema.parse({
        serverUrl: mediaPlane.livekitUrl,
        token: granted.sfu.token,
        tokenExpiresAtMs: granted.sfu.descriptor.expiresAtMs,
        participantIdentity: granted.sfu.descriptor.participantIdentity,
        turn: {
          urls: [...granted.turn.urls],
          username: granted.turn.username,
          credential: granted.turn.credential,
          expiresAtMs: granted.turn.expiresAtMs
        },
        call: { callId: granted.callId, revision: granted.revision, epoch: granted.epoch }
      });
    } catch (error) {
      throw this.#mapError(error, callId);
    }
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
