import { Buffer } from "node:buffer";
import { CallControlError } from "./errors.js";
import { CALL_CONTROL_VERSION, type CallAggregate, type CallParticipant, type Clock, type IdGenerator } from "./types.js";
import { assertCallInvariants, assertInteger, assertOpaqueId } from "./validation.js";

export const MAX_INITIAL_SFU_TTL_SECONDS = 120;
export const MAX_TURN_TTL_SECONDS = 300;

export type LiveKitTrackSource = "microphone" | "camera" | "screen_share" | "screen_share_audio";

export interface JoinAuthorizationSnapshot {
  /** Authenticated subject to which this authorization decision is bound. */
  readonly subjectMembershipId: string;
  readonly subjectMemberId: string;
  readonly subjectDeviceId: string;
  readonly conversationMember: boolean;
  readonly messageRequestAccepted: boolean;
  readonly relationshipBlocked: boolean;
  readonly deviceSessionAllowed: boolean;
  readonly abusePolicyAllowed: boolean;
  readonly callEpoch: number;
  readonly membershipEpoch: number;
}

export interface JoinGrantPolicy {
  readonly requestedSources: readonly LiveKitTrackSource[];
  readonly allowedSources: readonly LiveKitTrackSource[];
  readonly consentedSources: readonly LiveKitTrackSource[];
  readonly turnUrls: readonly string[];
  readonly sfuTtlSeconds?: number;
  readonly turnTtlSeconds?: number;
}

/** Exact decoded least-privilege claims for an official LiveKit SDK adapter. */
export interface LiveKitJoinTokenDescriptor {
  readonly tokenId: string;
  readonly participantIdentity: string;
  readonly participantMetadata: string;
  readonly issuedAtMs: number;
  /** Pass directly as the official server SDK's numeric TTL (seconds). */
  readonly ttlSeconds: number;
  readonly expiresAtMs: number;
  readonly videoGrant: {
    readonly room: string;
    readonly roomJoin: true;
    readonly roomCreate: false;
    readonly roomList: false;
    readonly roomAdmin: false;
    readonly roomRecord: false;
    readonly ingressAdmin: false;
    readonly canPublish: boolean;
    readonly canPublishData: false;
    readonly canPublishSources?: readonly LiveKitTrackSource[];
    readonly canSubscribe: true;
    readonly canUpdateOwnMetadata: false;
  };
}

export interface SfuTokenSigner {
  /** The signer owns API credentials; it must encode only this identity, metadata, TTL and video grant. */
  signJoinToken(descriptor: LiveKitJoinTokenDescriptor): Promise<string>;
}

export interface TurnCredentialSigner {
  /** Implement with base64(HMAC-SHA1(shared-secret, username)) for coturn REST auth. */
  signUsername(username: string): Promise<string>;
}

export interface IssuedJoinGrant {
  readonly schemaVersion: typeof CALL_CONTROL_VERSION;
  readonly callId: string;
  readonly revision: number;
  readonly epoch: number;
  readonly membershipEpoch: number;
  readonly sfu: {
    readonly token: string;
    readonly descriptor: LiveKitJoinTokenDescriptor;
  };
  readonly turn: {
    readonly urls: readonly string[];
    readonly username: string;
    readonly credential: string;
    readonly expiresAtMs: number;
  };
}

export interface JoinGrantDependencies {
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly sfuSigner: SfuTokenSigner;
  readonly turnSigner: TurnCredentialSigner;
}

function deny(message: string): never {
  throw new CallControlError("GRANT_DENIED", message);
}

function validateSources(values: readonly LiveKitTrackSource[], name: string): readonly LiveKitTrackSource[] {
  if (!Array.isArray(values) || values.length > 4 || new Set(values).size !== values.length) {
    deny(`${name} must contain at most four unique sources`);
  }
  for (const source of values) {
    if (!["microphone", "camera", "screen_share", "screen_share_audio"].includes(source)) {
      deny(`${name} contains an unknown source`);
    }
  }
  return Object.freeze([...values]);
}

function validateTtl(name: string, value: number, maximum: number): number {
  assertInteger(name, value, 10);
  if (value > maximum) deny(`${name} exceeds ${maximum} seconds`);
  return value;
}

function validateTurnUrls(urls: readonly string[]): readonly string[] {
  if (!Array.isArray(urls) || urls.length < 1 || urls.length > 4 || new Set(urls).size !== urls.length) {
    deny("turnUrls must contain between one and four unique URLs");
  }
  for (const url of urls) {
    if (typeof url !== "string" || url.length > 256) {
      deny("turnUrls may contain only bounded turn: or turns: URLs");
    }
    const match = /^(turns?):(\[[0-9A-Fa-f:.]+\]|[A-Za-z0-9.-]+)(?::([0-9]{1,5}))?(?:\?transport=(udp|tcp))?$/i.exec(url);
    if (match === null) deny("turnUrls may not contain credentials, fragments or unsupported parameters");
    const host = match[2];
    const port = match[3];
    if (host === undefined || host.length > 253) deny("turnUrls contain an invalid host");
    if (!host.startsWith("[") && host.split(".").some((label) => (
      label.length < 1
      || label.length > 63
      || !/^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/.test(label)
    ))) {
      deny("turnUrls contain an invalid host");
    }
    if (port !== undefined && (Number(port) < 1 || Number(port) > 65_535)) {
      deny("turnUrls contain an invalid port");
    }
  }
  return Object.freeze([...urls]);
}

function sameParticipant(left: CallParticipant, right: CallParticipant): boolean {
  return left.membershipId === right.membershipId
    && left.memberId === right.memberId
    && left.deviceId === right.deviceId
    && left.participantIdentity === right.participantIdentity
    && left.role === right.role
    && left.status === right.status
    && left.membershipEpoch === right.membershipEpoch
    && left.invitedAtMs === right.invitedAtMs
    && left.acceptedAtMs === right.acceptedAtMs
    && left.activeAtMs === right.activeAtMs
    && left.removedAtMs === right.removedAtMs;
}

function assertGrantEligible(
  call: CallAggregate,
  participant: CallParticipant,
  authorization: JoinAuthorizationSnapshot
): CallParticipant {
  assertCallInvariants(call);
  const canonicalParticipant = call.participants.find((candidate) => candidate.membershipId === participant.membershipId);
  if (canonicalParticipant === undefined) deny("participant does not belong to this call snapshot");
  if (!sameParticipant(participant, canonicalParticipant)) {
    deny("participant input does not match the canonical call membership");
  }
  if (authorization.subjectMembershipId !== canonicalParticipant.membershipId
    || authorization.subjectMemberId !== canonicalParticipant.memberId
    || authorization.subjectDeviceId !== canonicalParticipant.deviceId) {
    deny("authorization subject does not match the call membership");
  }
  if (!["connecting", "active", "reconnecting"].includes(call.state)) deny(`call state ${call.state} cannot issue a join grant`);
  if (!["accepted", "connecting", "active", "reconnecting"].includes(canonicalParticipant.status)) {
    deny(`participant state ${canonicalParticipant.status} cannot receive a join grant`);
  }
  if (!authorization.conversationMember
    || !authorization.messageRequestAccepted
    || authorization.relationshipBlocked
    || !authorization.deviceSessionAllowed
    || !authorization.abusePolicyAllowed) {
    deny("current authorization policy rejected the join");
  }
  if (authorization.callEpoch !== call.epoch || authorization.membershipEpoch !== canonicalParticipant.membershipEpoch) {
    deny("authorization epoch is stale");
  }
  return canonicalParticipant;
}

/**
 * Issues transport credentials only. No media-encryption key exists in this
 * model, and neither signer secret can be represented in the returned bundle.
 */
export async function issueJoinGrant(
  call: CallAggregate,
  participant: CallParticipant,
  authorization: JoinAuthorizationSnapshot,
  policy: JoinGrantPolicy,
  dependencies: JoinGrantDependencies
): Promise<IssuedJoinGrant> {
  const canonicalParticipant = assertGrantEligible(call, participant, authorization);
  const callId = call.callId;
  const revision = call.revision;
  const epoch = call.epoch;
  const roomName = call.roomName;
  const mediaMode = call.mediaMode;
  const membershipEpoch = canonicalParticipant.membershipEpoch;
  const participantIdentity = canonicalParticipant.participantIdentity;
  if (participantIdentity.includes(":")) {
    deny("participant identity may not contain the configured TURN REST separator");
  }
  const requested = validateSources(policy.requestedSources, "requestedSources");
  const allowed = new Set(validateSources(policy.allowedSources, "allowedSources"));
  const consented = new Set(validateSources(policy.consentedSources, "consentedSources"));
  if (requested.some((source) => !allowed.has(source) || !consented.has(source))) {
    deny("requested publish source is not both authorized and consented");
  }
  if (mediaMode === "audio" && requested.some((source) => source !== "microphone")) {
    deny("audio calls may publish only microphone tracks");
  }

  const sfuTtlSeconds = validateTtl("sfuTtlSeconds", policy.sfuTtlSeconds ?? 120, MAX_INITIAL_SFU_TTL_SECONDS);
  const turnTtlSeconds = validateTtl("turnTtlSeconds", policy.turnTtlSeconds ?? 300, MAX_TURN_TTL_SECONDS);
  const turnUrls = validateTurnUrls(policy.turnUrls);
  const nowMs = dependencies.clock.nowMs();
  assertInteger("nowMs", nowMs);
  if (nowMs < call.updatedAtMs) deny("grant clock precedes the authorized call snapshot");
  if (nowMs > Number.MAX_SAFE_INTEGER - Math.max(sfuTtlSeconds, turnTtlSeconds) * 1_000) {
    deny("grant expiry exceeds the safe timestamp range");
  }
  const tokenId = dependencies.ids.next("grant");
  assertOpaqueId("grant tokenId", tokenId);
  if (tokenId.includes(":")) deny("grant tokenId may not contain the configured TURN REST separator");

  const participantMetadata = JSON.stringify({
    v: CALL_CONTROL_VERSION,
    e: epoch,
    me: membershipEpoch,
    g: tokenId
  });
  if (Buffer.byteLength(participantMetadata, "utf8") > 256) deny("participant metadata exceeds its bound");

  const canPublish = requested.length > 0;

  const videoGrant: LiveKitJoinTokenDescriptor["videoGrant"] = Object.freeze({
    room: roomName,
    roomJoin: true,
    roomCreate: false,
    roomList: false,
    roomAdmin: false,
    roomRecord: false,
    ingressAdmin: false,
    canPublish,
    canPublishData: false,
    ...(canPublish ? { canPublishSources: Object.freeze([...requested]) } : {}),
    canSubscribe: true,
    canUpdateOwnMetadata: false
  });
  const descriptor: LiveKitJoinTokenDescriptor = Object.freeze({
    tokenId,
    participantIdentity,
    participantMetadata,
    issuedAtMs: nowMs,
    ttlSeconds: sfuTtlSeconds,
    expiresAtMs: nowMs + sfuTtlSeconds * 1_000,
    videoGrant
  });

  const turnExpiresAtSeconds = Math.floor(nowMs / 1_000) + turnTtlSeconds;
  const turnUsername = `${turnExpiresAtSeconds}:${participantIdentity}.${tokenId}`;
  if (turnUsername.length > 512) deny("TURN username exceeds coturn's bound");

  let token: string;
  let credential: string;
  try {
    [token, credential] = await Promise.all([
      dependencies.sfuSigner.signJoinToken(descriptor),
      dependencies.turnSigner.signUsername(turnUsername)
    ]);
  } catch {
    // Signer implementations own API/shared secrets. Never propagate their
    // error text or cause into an API/logging boundary.
    deny("credential signer failed");
  }
  if (typeof token !== "string"
    || token.length > 8_192
    || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token)) {
    deny("SFU signer returned an invalid compact JWT");
  }
  if (typeof credential !== "string" || !/^[A-Za-z0-9+/]{27}=$/.test(credential)) {
    deny("TURN signer returned an invalid credential");
  }

  return {
    schemaVersion: CALL_CONTROL_VERSION,
    callId,
    revision,
    epoch,
    membershipEpoch,
    sfu: { token, descriptor },
    turn: {
      urls: turnUrls,
      username: turnUsername,
      credential,
      expiresAtMs: turnExpiresAtSeconds * 1_000
    }
  };
}
