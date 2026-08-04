export const CALL_CONTROL_VERSION = 1 as const;
export const CALL_CONTROL_RELEASE = "Beta-0.1" as const;
export const CALL_CONTROL_OWNER = "Flenym" as const;

export const MAX_CALL_PARTICIPANTS = 256;
export const MAX_CALL_METADATA_ENTRIES = 8;
export const MAX_CALL_METADATA_BYTES = 1_024;

export type CallKind = "one_to_one" | "group" | "scheduled";
export type CallMediaMode = "audio" | "video";
export type CallState =
  | "created"
  | "inviting"
  | "ringing"
  | "connecting"
  | "active"
  | "reconnecting"
  | "ending"
  | "ended";

export type CallEndReason =
  | "declined"
  | "cancelled"
  | "no-answer"
  | "busy"
  | "membership-revoked"
  | "kicked"
  | "network-timeout"
  | "server-failure"
  | "completed";

export type ParticipantStatus =
  | "invited"
  | "ringing"
  | "accepted"
  | "connecting"
  | "active"
  | "reconnecting"
  | "declined"
  | "left"
  | "kicked"
  | "revoked";

export type ParticipantRole = "host" | "member";

export type BoundedMetadata = Readonly<Record<string, string>>;

export interface CallParticipant {
  readonly membershipId: string;
  readonly memberId: string;
  readonly deviceId: string;
  readonly participantIdentity: string;
  readonly role: ParticipantRole;
  readonly status: ParticipantStatus;
  readonly membershipEpoch: number;
  readonly invitedAtMs: number;
  readonly acceptedAtMs: number | null;
  readonly activeAtMs: number | null;
  readonly removedAtMs: number | null;
}

export interface CallAggregate {
  readonly schemaVersion: typeof CALL_CONTROL_VERSION;
  readonly callId: string;
  readonly conversationId: string;
  readonly roomName: string;
  readonly kind: CallKind;
  readonly mediaMode: CallMediaMode;
  readonly state: CallState;
  readonly revision: number;
  readonly epoch: number;
  readonly creatorMemberId: string;
  readonly scheduledStartAtMs: number | null;
  readonly metadata: BoundedMetadata;
  readonly participants: readonly CallParticipant[];
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
  readonly pendingEndReason: CallEndReason | null;
  readonly endReason: CallEndReason | null;
  readonly endedAtMs: number | null;
}

export interface ParticipantActor {
  readonly kind: "participant";
  readonly memberId: string;
  readonly deviceId: string;
  readonly sessionId: string;
}

export interface SystemActor {
  readonly kind: "system";
  readonly subject: "scheduler" | "media-plane" | "membership-service" | "operations";
}

export type CallActor = ParticipantActor | SystemActor;

interface CommandEnvelope {
  readonly schemaVersion: typeof CALL_CONTROL_VERSION;
  readonly commandId: string;
  readonly actor: CallActor;
  readonly expectedRevision: number;
}

interface ExistingCallCommand extends CommandEnvelope {
  readonly callId: string;
}

export interface InviteeInput {
  readonly memberId: string;
  readonly deviceId: string;
}

export interface CreateCallCommand extends CommandEnvelope {
  readonly type: "create_call";
  readonly actor: ParticipantActor;
  readonly clientNonce: string;
  readonly conversationId: string;
  readonly kind: CallKind;
  readonly mediaMode: CallMediaMode;
  readonly invitees: readonly InviteeInput[];
  readonly scheduledStartAtMs: number | null;
  readonly metadata: BoundedMetadata;
}

export interface StartInvitingCommand extends ExistingCallCommand {
  readonly type: "start_inviting";
}

export interface InviteParticipantCommand extends ExistingCallCommand {
  readonly type: "invite_participant";
  readonly invitee: InviteeInput;
}

export interface StartRingingCommand extends ExistingCallCommand {
  readonly type: "start_ringing";
}

export interface AcceptCallCommand extends ExistingCallCommand {
  readonly type: "accept";
}

export interface MarkActiveCommand extends ExistingCallCommand {
  readonly type: "mark_active";
  readonly membershipId: string;
}

export interface ConnectionLostCommand extends ExistingCallCommand {
  readonly type: "connection_lost";
  readonly membershipId: string;
}

export interface RejoinCallCommand extends ExistingCallCommand {
  readonly type: "rejoin";
}

export interface DeclineCallCommand extends ExistingCallCommand {
  readonly type: "decline";
  readonly reason: "declined" | "busy";
}

export interface CancelCallCommand extends ExistingCallCommand {
  readonly type: "cancel";
}

export interface HangupCallCommand extends ExistingCallCommand {
  readonly type: "hangup";
  readonly scope: "self" | "everyone";
}

export interface KickParticipantCommand extends ExistingCallCommand {
  readonly type: "kick";
  readonly membershipId: string;
}

export interface MembershipRemovedCommand extends ExistingCallCommand {
  readonly type: "membership_removed";
  readonly membershipId: string;
}

export interface EndCallCommand extends ExistingCallCommand {
  readonly type: "end_call";
  readonly reason: CallEndReason;
}

export interface FinishEndingCommand extends ExistingCallCommand {
  readonly type: "finish_ending";
}

export type CallCommand =
  | CreateCallCommand
  | StartInvitingCommand
  | InviteParticipantCommand
  | StartRingingCommand
  | AcceptCallCommand
  | MarkActiveCommand
  | ConnectionLostCommand
  | RejoinCallCommand
  | DeclineCallCommand
  | CancelCallCommand
  | HangupCallCommand
  | KickParticipantCommand
  | MembershipRemovedCommand
  | EndCallCommand
  | FinishEndingCommand;

export type ExistingCommand = Exclude<CallCommand, CreateCallCommand>;

export type CallEventType =
  | "call.created"
  | "call.inviting_started"
  | "call.participant_invited"
  | "call.ringing_started"
  | "call.accepted"
  | "call.participant_active"
  | "call.connection_lost"
  | "call.rejoin_started"
  | "call.declined"
  | "call.cancelled"
  | "call.hung_up"
  | "call.participant_kicked"
  | "call.membership_removed"
  | "call.ending_started"
  | "call.ended";

/**
 * Internal durable event. It deliberately contains control state only: never
 * media, SDP, ICE credentials, access tokens, TURN secrets or media keys.
 */
export interface CallDomainEvent {
  readonly schemaVersion: typeof CALL_CONTROL_VERSION;
  readonly eventId: string;
  readonly type: CallEventType;
  readonly callId: string;
  readonly revision: number;
  readonly epoch: number;
  readonly occurredAtMs: number;
  readonly commandId: string;
  readonly snapshot: CallAggregate;
}

export interface CallControlOutboxPayload {
  readonly schemaVersion: typeof CALL_CONTROL_VERSION;
  readonly type: CallEventType;
  readonly callId: string;
  readonly revision: number;
  readonly epoch: number;
  readonly state: CallState;
  /** Current non-terminal routing audience; historical removals are excluded. */
  readonly recipientMembershipIds: readonly string[];
  readonly occurredAtMs: number;
}

export interface CallOutboxRecord {
  readonly schemaVersion: typeof CALL_CONTROL_VERSION;
  readonly outboxId: string;
  readonly topic: "luxora.call-control.v1";
  readonly partitionKey: string;
  readonly eventId: string;
  readonly payload: CallControlOutboxPayload;
  readonly availableAtMs: number;
}

export interface CallMutation {
  readonly snapshot: CallAggregate;
  readonly event: CallDomainEvent;
  readonly outbox: CallOutboxRecord;
}

export type IdPurpose = "call" | "room" | "membership" | "participant" | "event" | "outbox" | "grant";

export interface Clock {
  nowMs(): number;
}

export interface IdGenerator {
  next(purpose: IdPurpose): string;
}

export interface CommandExecutionContext {
  readonly nowMs: number;
  readonly ids: IdGenerator;
}

export interface StoredCommandResult {
  readonly callId: string;
  readonly revision: number;
  readonly eventId: string;
  readonly snapshot: CallAggregate;
}

export interface CommandReceipt {
  readonly scope: string;
  readonly fingerprint: string;
  readonly result: StoredCommandResult;
  readonly createdAtMs: number;
}

export interface CreationReceipt {
  readonly scope: string;
  readonly fingerprint: string;
  readonly result: StoredCommandResult;
  readonly createdAtMs: number;
}

export interface PersistCallMutation {
  readonly expectedRevision: number | null;
  readonly mutation: CallMutation;
  readonly commandReceipt: CommandReceipt;
  readonly creationReceipt: CreationReceipt | null;
}

/**
 * Implementations must atomically write snapshot, event, outbox and receipts.
 * Command/creation scopes are unique keys and expectedRevision is a compare-
 * and-swap guard. No partial write is permitted. A conflict may be reported
 * before or after checking unique receipts; the executor reconciles either
 * ordering by re-reading the committed receipt.
 */
export interface CallControlStore {
  loadCall(callId: string): Promise<CallAggregate | null>;
  findCommandReceipt(scope: string): Promise<CommandReceipt | null>;
  findCreationReceipt(scope: string): Promise<CreationReceipt | null>;
  commit(input: PersistCallMutation): Promise<void>;
}

export interface ExecutedCallCommand {
  readonly snapshot: CallAggregate;
  readonly eventId: string;
  readonly outboxId: string | null;
  readonly replayed: boolean;
}
