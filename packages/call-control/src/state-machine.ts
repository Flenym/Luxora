import { reject } from "./errors.js";
import {
  CALL_CONTROL_VERSION,
  MAX_CALL_PARTICIPANTS,
  type CallActor,
  type CallAggregate,
  type CallCommand,
  type CallDomainEvent,
  type CallEndReason,
  type CallEventType,
  type CallMutation,
  type CallParticipant,
  type CommandExecutionContext,
  type CreateCallCommand,
  type ExistingCommand,
  type ParticipantActor,
  type ParticipantStatus,
  type SystemActor
} from "./types.js";
import {
  assertCallInvariants,
  assertCommand,
  assertInteger,
  assertNever,
  assertOpaqueId,
  normalizeMetadata
} from "./validation.js";

const TERMINAL_PARTICIPANT_STATES = new Set<ParticipantStatus>(["declined", "left", "kicked", "revoked"]);
export const MAX_SCHEDULE_AHEAD_MS = 366 * 24 * 60 * 60 * 1_000;

function participantKey(memberId: string, deviceId: string): string {
  return `${memberId}\u0000${deviceId}`;
}

function makeParticipant(
  memberId: string,
  deviceId: string,
  role: "host" | "member",
  status: "accepted" | "invited",
  epoch: number,
  context: CommandExecutionContext
): CallParticipant {
  return {
    membershipId: context.ids.next("membership"),
    memberId,
    deviceId,
    participantIdentity: context.ids.next("participant"),
    role,
    status,
    membershipEpoch: epoch,
    invitedAtMs: context.nowMs,
    acceptedAtMs: status === "accepted" ? context.nowMs : null,
    activeAtMs: null,
    removedAtMs: null
  };
}

function assertGeneratedIdentifiers(participant: CallParticipant): void {
  assertOpaqueId("generated membershipId", participant.membershipId);
  assertOpaqueId("generated participantIdentity", participant.participantIdentity);
}

function createAggregate(command: CreateCallCommand, context: CommandExecutionContext): CallAggregate {
  assertInteger("nowMs", context.nowMs);
  if (command.scheduledStartAtMs !== null && command.scheduledStartAtMs <= context.nowMs) {
    reject("COMMAND_NOT_ALLOWED", "scheduledStartAtMs must be in the future");
  }
  if (command.scheduledStartAtMs !== null
    && (context.nowMs > Number.MAX_SAFE_INTEGER - MAX_SCHEDULE_AHEAD_MS
      || command.scheduledStartAtMs > context.nowMs + MAX_SCHEDULE_AHEAD_MS)) {
    reject("COMMAND_NOT_ALLOWED", "scheduledStartAtMs exceeds the maximum scheduling horizon");
  }

  const callId = context.ids.next("call");
  const roomName = context.ids.next("room");
  assertOpaqueId("generated callId", callId);
  assertOpaqueId("generated roomName", roomName);

  const participants = [
    makeParticipant(command.actor.memberId, command.actor.deviceId, "host", "accepted", 1, context),
    ...command.invitees.map((invitee) => makeParticipant(
      invitee.memberId,
      invitee.deviceId,
      "member",
      "invited",
      1,
      context
    ))
  ];
  participants.forEach(assertGeneratedIdentifiers);

  const aggregate: CallAggregate = {
    schemaVersion: CALL_CONTROL_VERSION,
    callId,
    conversationId: command.conversationId,
    roomName,
    kind: command.kind,
    mediaMode: command.mediaMode,
    state: "created",
    revision: 1,
    epoch: 1,
    creatorMemberId: command.actor.memberId,
    scheduledStartAtMs: command.scheduledStartAtMs,
    metadata: normalizeMetadata(command.metadata),
    participants,
    createdAtMs: context.nowMs,
    updatedAtMs: context.nowMs,
    pendingEndReason: null,
    endReason: null,
    endedAtMs: null
  };
  assertCallInvariants(aggregate);
  return aggregate;
}

function findParticipant(call: CallAggregate, membershipId: string): CallParticipant {
  const participant = call.participants.find((candidate) => candidate.membershipId === membershipId);
  if (participant === undefined) reject("MEMBERSHIP_NOT_FOUND", "call membership was not found", call);
  return participant;
}

function findActorParticipant(call: CallAggregate, actor: ParticipantActor): CallParticipant {
  const key = participantKey(actor.memberId, actor.deviceId);
  const participant = call.participants.find((candidate) => participantKey(candidate.memberId, candidate.deviceId) === key);
  if (participant === undefined) reject("MEMBERSHIP_NOT_FOUND", "actor device is not a call participant", call);
  if (TERMINAL_PARTICIPANT_STATES.has(participant.status)) {
    reject("MEMBERSHIP_REVOKED", `actor membership is ${participant.status}`, call);
  }
  return participant;
}

function requireParticipantActor(call: CallAggregate, actor: CallActor): CallParticipant {
  if (actor.kind !== "participant") reject("FORBIDDEN", "this command requires a participant actor", call);
  return findActorParticipant(call, actor);
}

function requireHostOrSystem(
  call: CallAggregate,
  actor: CallActor,
  allowedSystems: readonly SystemActor["subject"][]
): CallParticipant | null {
  if (actor.kind === "system") {
    if (!allowedSystems.includes(actor.subject)) {
      reject("FORBIDDEN", "system actor is not authorized for this command", call);
    }
    return null;
  }
  const participant = findActorParticipant(call, actor);
  if (participant.role !== "host") reject("FORBIDDEN", "this command requires the call host", call);
  return participant;
}

function requireSystem(
  call: CallAggregate,
  actor: CallActor,
  allowed: readonly SystemActor["subject"][]
): SystemActor {
  if (actor.kind !== "system" || !allowed.includes(actor.subject)) {
    reject("FORBIDDEN", "this command requires an authorized system actor", call);
  }
  return actor;
}

function updateParticipant(
  participants: readonly CallParticipant[],
  membershipId: string,
  update: (participant: CallParticipant) => CallParticipant
): readonly CallParticipant[] {
  let changed = false;
  const next = participants.map((participant) => {
    if (participant.membershipId !== membershipId) return participant;
    changed = true;
    return update(participant);
  });
  if (!changed) reject("MEMBERSHIP_NOT_FOUND", "call membership was not found");
  return next;
}

function withRevision(
  call: CallAggregate,
  nowMs: number,
  updates: Partial<Omit<CallAggregate, "schemaVersion" | "callId" | "revision" | "createdAtMs" | "updatedAtMs">>
): CallAggregate {
  return {
    ...call,
    ...updates,
    revision: call.revision + 1,
    updatedAtMs: nowMs
  };
}

function ending(call: CallAggregate, nowMs: number, reason: CallEndReason, epoch = call.epoch): CallAggregate {
  return withRevision(call, nowMs, {
    state: "ending",
    epoch,
    pendingEndReason: reason,
    endReason: null,
    endedAtMs: null
  });
}

function settleAfterRemoval(
  call: CallAggregate,
  participants: readonly CallParticipant[],
  nowMs: number,
  epoch: number,
  terminalReason: CallEndReason
): CallAggregate {
  if (call.kind === "one_to_one") {
    return ending({ ...call, participants }, nowMs, terminalReason, epoch);
  }
  if (call.state === "active" && !participants.some((participant) => participant.status === "active")) {
    return withRevision(call, nowMs, {
      participants,
      epoch,
      state: "reconnecting"
    });
  }
  return withRevision(call, nowMs, { participants, epoch });
}

function assertState(call: CallAggregate, allowed: readonly CallAggregate["state"][], command: string): void {
  if (!allowed.includes(call.state)) {
    reject("COMMAND_NOT_ALLOWED", `${command} is not allowed while call is ${call.state}`, call);
  }
}

function mutateExisting(call: CallAggregate, command: ExistingCommand, context: CommandExecutionContext): CallAggregate {
  if (command.callId !== call.callId) reject("NOT_FOUND", "command callId does not match loaded call", call);
  if (command.expectedRevision !== call.revision) {
    reject("REVISION_CONFLICT", "expectedRevision is stale", call);
  }
  if (call.state === "ended") reject("TERMINAL_CALL", "ended calls are immutable", call);

  switch (command.type) {
    case "start_inviting": {
      assertState(call, ["created"], command.type);
      requireHostOrSystem(call, command.actor, ["scheduler", "operations"]);
      return withRevision(call, context.nowMs, { state: "inviting" });
    }
    case "invite_participant": {
      assertState(call, ["inviting", "ringing", "connecting", "active", "reconnecting"], command.type);
      requireHostOrSystem(call, command.actor, ["membership-service", "operations"]);
      if (call.kind === "one_to_one") reject("COMMAND_NOT_ALLOWED", "one_to_one membership is fixed", call);
      if (call.participants.length >= MAX_CALL_PARTICIPANTS) {
        reject("COMMAND_NOT_ALLOWED", "call participant limit reached", call);
      }
      const key = participantKey(command.invitee.memberId, command.invitee.deviceId);
      if (call.participants.some((participant) => participantKey(participant.memberId, participant.deviceId) === key)) {
        reject("COMMAND_NOT_ALLOWED", "member device already has a call membership", call);
      }
      const participant = makeParticipant(
        command.invitee.memberId,
        command.invitee.deviceId,
        "member",
        "invited",
        call.epoch,
        context
      );
      assertGeneratedIdentifiers(participant);
      return withRevision(call, context.nowMs, { participants: [...call.participants, participant] });
    }
    case "start_ringing": {
      assertState(call, ["inviting"], command.type);
      requireHostOrSystem(call, command.actor, ["scheduler", "operations"]);
      if (call.scheduledStartAtMs !== null && context.nowMs < call.scheduledStartAtMs) {
        reject("COMMAND_NOT_ALLOWED", "scheduled call cannot ring before its scheduled time", call);
      }
      const participants = call.participants.map((participant): CallParticipant => (
        participant.status === "invited" ? { ...participant, status: "ringing" } : participant
      ));
      return withRevision(call, context.nowMs, { state: "ringing", participants });
    }
    case "accept": {
      assertState(call, ["ringing", "connecting", "active", "reconnecting"], command.type);
      const actor = requireParticipantActor(call, command.actor);
      if (actor.status !== "invited" && actor.status !== "ringing") {
        reject("COMMAND_NOT_ALLOWED", `membership cannot accept from ${actor.status}`, call);
      }
      const participants = updateParticipant(call.participants, actor.membershipId, (participant) => ({
        ...participant,
        status: "connecting",
        acceptedAtMs: context.nowMs
      }));
      const state = call.state === "ringing" ? "connecting" : call.state;
      return withRevision(call, context.nowMs, { participants, state });
    }
    case "mark_active": {
      assertState(call, ["connecting", "active", "reconnecting"], command.type);
      requireSystem(call, command.actor, ["media-plane", "operations"]);
      const target = findParticipant(call, command.membershipId);
      if (!["accepted", "connecting", "reconnecting"].includes(target.status)) {
        reject("COMMAND_NOT_ALLOWED", `membership cannot become active from ${target.status}`, call);
      }
      const participants = updateParticipant(call.participants, target.membershipId, (participant) => ({
        ...participant,
        status: "active",
        activeAtMs: context.nowMs
      }));
      return withRevision(call, context.nowMs, { participants, state: "active" });
    }
    case "connection_lost": {
      assertState(call, ["active", "reconnecting"], command.type);
      const target = findParticipant(call, command.membershipId);
      if (command.actor.kind === "participant") {
        const actor = findActorParticipant(call, command.actor);
        if (actor.membershipId !== target.membershipId) reject("FORBIDDEN", "participant can report only its own loss", call);
      } else {
        requireSystem(call, command.actor, ["media-plane", "operations"]);
      }
      if (target.status !== "active") {
        reject("COMMAND_NOT_ALLOWED", `membership cannot lose connection from ${target.status}`, call);
      }
      const participants = updateParticipant(call.participants, target.membershipId, (participant) => ({
        ...participant,
        status: "reconnecting"
      }));
      const state = participants.some((participant) => participant.status === "active") ? "active" : "reconnecting";
      return withRevision(call, context.nowMs, { participants, state });
    }
    case "rejoin": {
      assertState(call, ["active", "reconnecting"], command.type);
      const actor = requireParticipantActor(call, command.actor);
      if (actor.status !== "reconnecting") {
        reject("COMMAND_NOT_ALLOWED", `membership cannot rejoin from ${actor.status}`, call);
      }
      const participants = updateParticipant(call.participants, actor.membershipId, (participant) => ({
        ...participant,
        status: "connecting"
      }));
      return withRevision(call, context.nowMs, { participants });
    }
    case "decline": {
      assertState(call, ["inviting", "ringing", "connecting"], command.type);
      const actor = requireParticipantActor(call, command.actor);
      if (actor.role === "host" || (actor.status !== "invited" && actor.status !== "ringing")) {
        reject("COMMAND_NOT_ALLOWED", `membership cannot decline from ${actor.status}`, call);
      }
      const epoch = call.epoch + 1;
      const participants = updateParticipant(call.participants, actor.membershipId, (participant) => ({
        ...participant,
        status: "declined",
        membershipEpoch: epoch,
        removedAtMs: context.nowMs
      }));
      if (call.kind === "one_to_one") {
        return ending({ ...call, participants }, context.nowMs, command.reason, epoch);
      }
      return withRevision(call, context.nowMs, { participants, epoch });
    }
    case "cancel": {
      assertState(call, ["created", "inviting", "ringing", "connecting"], command.type);
      requireHostOrSystem(call, command.actor, ["scheduler", "operations"]);
      return ending(call, context.nowMs, "cancelled", call.epoch + 1);
    }
    case "hangup": {
      assertState(call, ["created", "inviting", "ringing", "connecting", "active", "reconnecting"], command.type);
      const actor = requireParticipantActor(call, command.actor);
      if (command.scope === "everyone" && actor.role !== "host") {
        reject("FORBIDDEN", "only the host can hang up for everyone", call);
      }
      if (command.scope === "self" && actor.role === "host" && call.kind !== "one_to_one") {
        reject("COMMAND_NOT_ALLOWED", "group host transfer is required before host self-leave", call);
      }
      const epoch = call.epoch + 1;
      const participants = updateParticipant(call.participants, actor.membershipId, (participant) => ({
        ...participant,
        status: "left",
        membershipEpoch: epoch,
        removedAtMs: context.nowMs
      }));
      if (call.kind === "one_to_one" || command.scope === "everyone") {
        return ending({ ...call, participants }, context.nowMs, "completed", epoch);
      }
      return settleAfterRemoval(call, participants, context.nowMs, epoch, "completed");
    }
    case "kick": {
      assertState(call, ["inviting", "ringing", "connecting", "active", "reconnecting"], command.type);
      requireHostOrSystem(call, command.actor, ["membership-service", "operations"]);
      const target = findParticipant(call, command.membershipId);
      if (target.role === "host") reject("FORBIDDEN", "host cannot be kicked", call);
      if (TERMINAL_PARTICIPANT_STATES.has(target.status)) {
        reject("MEMBERSHIP_REVOKED", `target membership is ${target.status}`, call);
      }
      const epoch = call.epoch + 1;
      const participants = updateParticipant(call.participants, target.membershipId, (participant) => ({
        ...participant,
        status: "kicked",
        membershipEpoch: epoch,
        removedAtMs: context.nowMs
      }));
      return settleAfterRemoval(call, participants, context.nowMs, epoch, "kicked");
    }
    case "membership_removed": {
      assertState(call, ["created", "inviting", "ringing", "connecting", "active", "reconnecting"], command.type);
      requireSystem(call, command.actor, ["membership-service"]);
      const target = findParticipant(call, command.membershipId);
      if (TERMINAL_PARTICIPANT_STATES.has(target.status)) {
        reject("MEMBERSHIP_REVOKED", `target membership is ${target.status}`, call);
      }
      const epoch = call.epoch + 1;
      const participants = updateParticipant(call.participants, target.membershipId, (participant) => ({
        ...participant,
        status: "revoked",
        membershipEpoch: epoch,
        removedAtMs: context.nowMs
      }));
      if (target.role === "host") {
        return ending({ ...call, participants }, context.nowMs, "membership-revoked", epoch);
      }
      return settleAfterRemoval(call, participants, context.nowMs, epoch, "membership-revoked");
    }
    case "end_call": {
      assertState(call, ["created", "inviting", "ringing", "connecting", "active", "reconnecting"], command.type);
      requireSystem(call, command.actor, ["scheduler", "media-plane", "operations"]);
      return ending(call, context.nowMs, command.reason, call.epoch + 1);
    }
    case "finish_ending": {
      assertState(call, ["ending"], command.type);
      requireSystem(call, command.actor, ["scheduler", "media-plane", "operations"]);
      if (call.pendingEndReason === null) reject("COMMAND_NOT_ALLOWED", "ending call has no terminal reason", call);
      return withRevision(call, context.nowMs, {
        state: "ended",
        pendingEndReason: null,
        endReason: call.pendingEndReason,
        endedAtMs: context.nowMs
      });
    }
    default:
      return assertNever(command);
  }
}

function eventTypeFor(command: CallCommand): CallEventType {
  switch (command.type) {
    case "create_call": return "call.created";
    case "start_inviting": return "call.inviting_started";
    case "invite_participant": return "call.participant_invited";
    case "start_ringing": return "call.ringing_started";
    case "accept": return "call.accepted";
    case "mark_active": return "call.participant_active";
    case "connection_lost": return "call.connection_lost";
    case "rejoin": return "call.rejoin_started";
    case "decline": return "call.declined";
    case "cancel": return "call.cancelled";
    case "hangup": return "call.hung_up";
    case "kick": return "call.participant_kicked";
    case "membership_removed": return "call.membership_removed";
    case "end_call": return "call.ending_started";
    case "finish_ending": return "call.ended";
    default: return assertNever(command);
  }
}

function makeMutation(
  snapshot: CallAggregate,
  command: CallCommand,
  context: CommandExecutionContext
): CallMutation {
  const eventId = context.ids.next("event");
  const outboxId = context.ids.next("outbox");
  assertOpaqueId("generated eventId", eventId);
  assertOpaqueId("generated outboxId", outboxId);
  const type = eventTypeFor(command);
  const event: CallDomainEvent = {
    schemaVersion: CALL_CONTROL_VERSION,
    eventId,
    type,
    callId: snapshot.callId,
    revision: snapshot.revision,
    epoch: snapshot.epoch,
    occurredAtMs: context.nowMs,
    commandId: command.commandId,
    snapshot
  };
  return {
    snapshot,
    event,
    outbox: {
      schemaVersion: CALL_CONTROL_VERSION,
      outboxId,
      topic: "luxora.call-control.v1",
      partitionKey: snapshot.callId,
      eventId,
      payload: {
        schemaVersion: CALL_CONTROL_VERSION,
        type,
        callId: snapshot.callId,
        revision: snapshot.revision,
        epoch: snapshot.epoch,
        state: snapshot.state,
        // Terminal memberships are retained in the aggregate for audit, but
        // must never remain routable recipients after decline/leave/kick/revoke.
        recipientMembershipIds: snapshot.participants
          .filter((participant) => !TERMINAL_PARTICIPANT_STATES.has(participant.status))
          .map((participant) => participant.membershipId),
        occurredAtMs: context.nowMs
      },
      availableAtMs: context.nowMs
    }
  };
}

/**
 * Pure deterministic reducer. Persistence, authorization against conversation
 * membership/block/session state, and media-plane side effects stay outside.
 */
export function transitionCall(
  current: CallAggregate | null,
  command: CallCommand,
  context: CommandExecutionContext
): CallMutation {
  assertCommand(command);
  assertInteger("nowMs", context.nowMs);

  let next: CallAggregate;
  if (command.type === "create_call") {
    if (current !== null) reject("COMMAND_NOT_ALLOWED", "create_call cannot mutate an existing aggregate", current);
    next = createAggregate(command, context);
  } else {
    if (current === null) reject("NOT_FOUND", "call was not found");
    assertCallInvariants(current);
    if (context.nowMs < current.updatedAtMs) {
      reject("VALIDATION_FAILED", "trusted clock moved backwards", current);
    }
    next = mutateExisting(current, command, context);
  }

  assertCallInvariants(next);
  return makeMutation(next, command, context);
}
