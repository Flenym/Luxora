import { Buffer } from "node:buffer";
import { reject } from "./errors.js";
import {
  CALL_CONTROL_VERSION,
  MAX_CALL_METADATA_BYTES,
  MAX_CALL_METADATA_ENTRIES,
  MAX_CALL_PARTICIPANTS,
  type BoundedMetadata,
  type CallActor,
  type CallAggregate,
  type CallCommand,
  type CallParticipant,
  type InviteeInput
} from "./types.js";

const OPAQUE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const METADATA_KEY_PATTERN = /^[A-Za-z][A-Za-z0-9_.-]*$/;
const TERMINAL_PARTICIPANT_STATES = new Set(["declined", "left", "kicked", "revoked"]);
const CALL_KINDS = new Set(["one_to_one", "group", "scheduled"]);
const CALL_MEDIA_MODES = new Set(["audio", "video"]);
const CALL_STATES = new Set(["created", "inviting", "ringing", "connecting", "active", "reconnecting", "ending", "ended"]);
const PARTICIPANT_ROLES = new Set(["host", "member"]);
const PARTICIPANT_STATES = new Set([
  "invited",
  "ringing",
  "accepted",
  "connecting",
  "active",
  "reconnecting",
  "declined",
  "left",
  "kicked",
  "revoked"
]);
const CALL_END_REASONS = new Set([
  "declined",
  "cancelled",
  "no-answer",
  "busy",
  "membership-revoked",
  "kicked",
  "network-timeout",
  "server-failure",
  "completed"
]);
const COMMAND_TYPES = new Set([
  "create_call",
  "start_inviting",
  "invite_participant",
  "start_ringing",
  "accept",
  "mark_active",
  "connection_lost",
  "rejoin",
  "decline",
  "cancel",
  "hangup",
  "kick",
  "membership_removed",
  "end_call",
  "finish_ending"
]);

export function assertOpaqueId(name: string, value: string, maxLength = 128): void {
  if (typeof value !== "string" || value.length < 1 || value.length > maxLength || !OPAQUE_PATTERN.test(value)) {
    reject("VALIDATION_FAILED", `${name} must be a bounded opaque identifier`);
  }
}

export function assertInteger(name: string, value: number, minimum = 0): void {
  if (!Number.isSafeInteger(value) || value < minimum) {
    reject("VALIDATION_FAILED", `${name} must be a safe integer greater than or equal to ${minimum}`);
  }
}

export function normalizeMetadata(metadata: BoundedMetadata): BoundedMetadata {
  if (metadata === null || typeof metadata !== "object" || Array.isArray(metadata)) {
    reject("VALIDATION_FAILED", "metadata must be a string-to-string object");
  }

  const entries = Object.entries(metadata);
  if (entries.length > MAX_CALL_METADATA_ENTRIES) {
    reject("VALIDATION_FAILED", `metadata may contain at most ${MAX_CALL_METADATA_ENTRIES} entries`);
  }

  const normalized: Record<string, string> = Object.create(null) as Record<string, string>;
  let byteCount = 0;
  for (const [key, value] of entries) {
    if (
      key.length < 1
      || key.length > 32
      || !METADATA_KEY_PATTERN.test(key)
      || key === "constructor"
      || key === "prototype"
      || key === "__proto__"
    ) {
      reject("VALIDATION_FAILED", "metadata contains an invalid key");
    }
    if (typeof value !== "string" || value.length > 256) {
      reject("VALIDATION_FAILED", "metadata values must be strings no longer than 256 characters");
    }
    byteCount += Buffer.byteLength(key, "utf8") + Buffer.byteLength(value, "utf8");
    normalized[key] = value;
  }

  if (byteCount > MAX_CALL_METADATA_BYTES) {
    reject("VALIDATION_FAILED", `metadata may contain at most ${MAX_CALL_METADATA_BYTES} UTF-8 bytes`);
  }

  return Object.freeze(normalized);
}

function assertActor(actor: CallActor): void {
  if (actor === null || typeof actor !== "object" || Array.isArray(actor)) {
    reject("VALIDATION_FAILED", "actor is invalid");
  }
  if (actor.kind === "participant") {
    assertOpaqueId("actor.memberId", actor.memberId);
    assertOpaqueId("actor.deviceId", actor.deviceId);
    assertOpaqueId("actor.sessionId", actor.sessionId);
    return;
  }

  if (actor.kind !== "system" || !["scheduler", "media-plane", "membership-service", "operations"].includes(actor.subject)) {
    reject("VALIDATION_FAILED", "actor is invalid");
  }
}

function assertInvitee(invitee: InviteeInput): void {
  if (invitee === null || typeof invitee !== "object" || Array.isArray(invitee)) {
    reject("VALIDATION_FAILED", "invitee is invalid");
  }
  assertOpaqueId("invitee.memberId", invitee.memberId);
  assertOpaqueId("invitee.deviceId", invitee.deviceId);
}

export function assertCommand(command: CallCommand): void {
  if (command === null || typeof command !== "object" || Array.isArray(command)) {
    reject("VALIDATION_FAILED", "command must be an object");
  }
  if (command.schemaVersion !== CALL_CONTROL_VERSION) {
    reject("VALIDATION_FAILED", `unsupported call-control version: ${String(command.schemaVersion)}`);
  }
  assertOpaqueId("commandId", command.commandId);
  assertInteger("expectedRevision", command.expectedRevision);
  assertActor(command.actor);
  if (!COMMAND_TYPES.has(command.type)) reject("VALIDATION_FAILED", "command type is invalid");

  if (command.type === "create_call") {
    if (command.expectedRevision !== 0) {
      reject("VALIDATION_FAILED", "create_call expectedRevision must be zero");
    }
    assertOpaqueId("clientNonce", command.clientNonce);
    assertOpaqueId("conversationId", command.conversationId);
    if (!["one_to_one", "group", "scheduled"].includes(command.kind)) {
      reject("VALIDATION_FAILED", "call kind is invalid");
    }
    if (command.mediaMode !== "audio" && command.mediaMode !== "video") {
      reject("VALIDATION_FAILED", "media mode is invalid");
    }
    if (!Array.isArray(command.invitees) || command.invitees.length < 1 || command.invitees.length >= MAX_CALL_PARTICIPANTS) {
      reject("VALIDATION_FAILED", `invitees must contain between 1 and ${MAX_CALL_PARTICIPANTS - 1} devices`);
    }
    command.invitees.forEach(assertInvitee);
    const inviteeKeys = command.invitees.map((item) => `${item.memberId}\u0000${item.deviceId}`);
    if (new Set(inviteeKeys).size !== inviteeKeys.length) {
      reject("VALIDATION_FAILED", "invitees must be unique by member and device");
    }
    if (inviteeKeys.includes(`${command.actor.memberId}\u0000${command.actor.deviceId}`)) {
      reject("VALIDATION_FAILED", "the creating device cannot also be an invitee");
    }
    if (command.kind === "one_to_one") {
      if (command.invitees.length !== 1 || command.invitees[0]?.memberId === command.actor.memberId) {
        reject("VALIDATION_FAILED", "one_to_one calls require exactly one other member");
      }
    }
    if (command.kind === "scheduled") {
      if (command.scheduledStartAtMs === null) {
        reject("VALIDATION_FAILED", "scheduled calls require scheduledStartAtMs");
      }
      assertInteger("scheduledStartAtMs", command.scheduledStartAtMs, 1);
    } else if (command.scheduledStartAtMs !== null) {
      reject("VALIDATION_FAILED", "only scheduled calls may set scheduledStartAtMs");
    }
    normalizeMetadata(command.metadata);
    return;
  }

  assertOpaqueId("callId", command.callId);
  switch (command.type) {
    case "invite_participant":
      assertInvitee(command.invitee);
      break;
    case "mark_active":
    case "connection_lost":
    case "kick":
    case "membership_removed":
      assertOpaqueId("membershipId", command.membershipId);
      break;
    case "decline":
      if (command.reason !== "declined" && command.reason !== "busy") {
        reject("VALIDATION_FAILED", "decline reason is invalid");
      }
      break;
    case "hangup":
      if (command.scope !== "self" && command.scope !== "everyone") {
        reject("VALIDATION_FAILED", "hangup scope is invalid");
      }
      break;
    case "end_call":
      if (![
        "declined",
        "cancelled",
        "no-answer",
        "busy",
        "membership-revoked",
        "kicked",
        "network-timeout",
        "server-failure",
        "completed"
      ].includes(command.reason)) {
        reject("VALIDATION_FAILED", "end reason is invalid");
      }
      break;
    case "start_inviting":
    case "start_ringing":
    case "accept":
    case "rejoin":
    case "cancel":
    case "finish_ending":
      break;
  }
}

function assertParticipant(participant: CallParticipant, call: CallAggregate): void {
  if (participant === null || typeof participant !== "object" || Array.isArray(participant)) {
    reject("VALIDATION_FAILED", "participant must be an object");
  }
  if (!PARTICIPANT_ROLES.has(participant.role) || !PARTICIPANT_STATES.has(participant.status)) {
    reject("VALIDATION_FAILED", "participant role or status is invalid");
  }
  assertOpaqueId("participant.membershipId", participant.membershipId);
  assertOpaqueId("participant.memberId", participant.memberId);
  assertOpaqueId("participant.deviceId", participant.deviceId);
  assertOpaqueId("participant.participantIdentity", participant.participantIdentity);
  assertInteger("participant.membershipEpoch", participant.membershipEpoch, 1);
  if (participant.membershipEpoch > call.epoch) {
    reject("VALIDATION_FAILED", "participant membershipEpoch cannot exceed call epoch");
  }
  assertInteger("participant.invitedAtMs", participant.invitedAtMs);
  if (participant.acceptedAtMs !== null) assertInteger("participant.acceptedAtMs", participant.acceptedAtMs);
  if (participant.activeAtMs !== null) assertInteger("participant.activeAtMs", participant.activeAtMs);
  if (participant.removedAtMs !== null) assertInteger("participant.removedAtMs", participant.removedAtMs);

  if (participant.invitedAtMs < call.createdAtMs || participant.invitedAtMs > call.updatedAtMs) {
    reject("VALIDATION_FAILED", "participant invitedAtMs is outside the call timeline");
  }
  if (participant.acceptedAtMs !== null
    && (participant.acceptedAtMs < participant.invitedAtMs || participant.acceptedAtMs > call.updatedAtMs)) {
    reject("VALIDATION_FAILED", "participant acceptedAtMs is outside the membership timeline");
  }
  if (participant.activeAtMs !== null
    && (participant.acceptedAtMs === null
      || participant.activeAtMs < participant.acceptedAtMs
      || participant.activeAtMs > call.updatedAtMs)) {
    reject("VALIDATION_FAILED", "participant activeAtMs is outside the membership timeline");
  }
  if (participant.removedAtMs !== null
    && (participant.removedAtMs < participant.invitedAtMs
      || (participant.acceptedAtMs !== null && participant.removedAtMs < participant.acceptedAtMs)
      || (participant.activeAtMs !== null && participant.removedAtMs < participant.activeAtMs)
      || participant.removedAtMs > call.updatedAtMs)) {
    reject("VALIDATION_FAILED", "participant removedAtMs is outside the membership timeline");
  }

  const terminal = TERMINAL_PARTICIPANT_STATES.has(participant.status);
  if (terminal !== (participant.removedAtMs !== null)) {
    reject("VALIDATION_FAILED", "participant removal time must match terminal membership state");
  }
  if (["accepted", "connecting", "active", "reconnecting"].includes(participant.status)
    && participant.acceptedAtMs === null) {
    reject("VALIDATION_FAILED", `${participant.status} participant requires acceptedAtMs`);
  }
  if (["active", "reconnecting"].includes(participant.status) && participant.activeAtMs === null) {
    reject("VALIDATION_FAILED", `${participant.status} participant requires activeAtMs`);
  }
}

export function assertCallInvariants(call: CallAggregate): void {
  if (call === null || typeof call !== "object" || Array.isArray(call)) {
    reject("VALIDATION_FAILED", "call aggregate must be an object");
  }
  if (call.schemaVersion !== CALL_CONTROL_VERSION) reject("VALIDATION_FAILED", "call schemaVersion is invalid");
  assertOpaqueId("callId", call.callId);
  assertOpaqueId("conversationId", call.conversationId);
  assertOpaqueId("roomName", call.roomName);
  assertOpaqueId("creatorMemberId", call.creatorMemberId);
  if (!CALL_KINDS.has(call.kind) || !CALL_MEDIA_MODES.has(call.mediaMode) || !CALL_STATES.has(call.state)) {
    reject("VALIDATION_FAILED", "call kind, media mode or state is invalid");
  }
  if (call.roomName === call.conversationId) {
    reject("VALIDATION_FAILED", "media room name must not reuse the conversation identifier");
  }
  assertInteger("revision", call.revision, 1);
  assertInteger("epoch", call.epoch, 1);
  assertInteger("createdAtMs", call.createdAtMs);
  assertInteger("updatedAtMs", call.updatedAtMs);
  if (call.updatedAtMs < call.createdAtMs) reject("VALIDATION_FAILED", "updatedAtMs precedes createdAtMs");
  normalizeMetadata(call.metadata);

  if (!Array.isArray(call.participants)
    || call.participants.length < 2
    || call.participants.length > MAX_CALL_PARTICIPANTS) {
    reject("VALIDATION_FAILED", "call participant count is outside the bounded range");
  }
  if (call.kind === "one_to_one" && call.participants.length !== 2) {
    reject("VALIDATION_FAILED", "one_to_one calls must retain exactly two participant records");
  }
  if ((call.kind === "scheduled") !== (call.scheduledStartAtMs !== null)) {
    reject("VALIDATION_FAILED", "scheduled call timestamp does not match call kind");
  }
  if (call.scheduledStartAtMs !== null) {
    assertInteger("scheduledStartAtMs", call.scheduledStartAtMs, 1);
    if (call.scheduledStartAtMs <= call.createdAtMs) {
      reject("VALIDATION_FAILED", "scheduledStartAtMs must follow createdAtMs");
    }
  }

  const membershipIds = call.participants.map((participant) => participant.membershipId);
  const identities = call.participants.map((participant) => participant.participantIdentity);
  const memberDevices = call.participants.map((participant) => `${participant.memberId}\u0000${participant.deviceId}`);
  if (new Set(membershipIds).size !== membershipIds.length
    || new Set(identities).size !== identities.length
    || new Set(memberDevices).size !== memberDevices.length) {
    reject("VALIDATION_FAILED", "call participant identifiers must be unique");
  }
  call.participants.forEach((participant) => assertParticipant(participant, call));
  const hosts = call.participants.filter((participant) => participant.role === "host");
  if (hosts.length !== 1 || hosts[0]?.memberId !== call.creatorMemberId) {
    reject("VALIDATION_FAILED", "call must retain exactly one creator host");
  }

  if (call.state === "ending") {
    if (call.pendingEndReason === null || call.endReason !== null || call.endedAtMs !== null) {
      reject("VALIDATION_FAILED", "ending call must contain only pendingEndReason");
    }
  } else if (call.state === "ended") {
    if (call.pendingEndReason !== null || call.endReason === null || call.endedAtMs === null) {
      reject("VALIDATION_FAILED", "ended call must contain an end reason and endedAtMs");
    }
  } else if (call.pendingEndReason !== null || call.endReason !== null || call.endedAtMs !== null) {
    reject("VALIDATION_FAILED", "non-terminal call cannot contain terminal fields");
  }

  if (call.pendingEndReason !== null && !CALL_END_REASONS.has(call.pendingEndReason)) {
    reject("VALIDATION_FAILED", "pending call end reason is invalid");
  }
  if (call.endReason !== null && !CALL_END_REASONS.has(call.endReason)) {
    reject("VALIDATION_FAILED", "call end reason is invalid");
  }
  if (call.endedAtMs !== null
    && (call.endedAtMs < call.createdAtMs || call.endedAtMs > call.updatedAtMs)) {
    reject("VALIDATION_FAILED", "endedAtMs is outside the call timeline");
  }

  if (call.state === "active" && !call.participants.some((participant) => participant.status === "active")) {
    reject("VALIDATION_FAILED", "active call requires at least one active participant");
  }
}

export function assertNever(value: never): never {
  return reject("VALIDATION_FAILED", `unknown command: ${JSON.stringify(value)}`);
}
