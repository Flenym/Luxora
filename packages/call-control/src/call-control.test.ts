import { createHmac } from "node:crypto";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  CallControlError,
  CallControlExecutor,
  MAX_SCHEDULE_AHEAD_MS,
  StoreDuplicateCommandError,
  StoreDuplicateCreationError,
  StoreRevisionConflictError,
  assertCallInvariants,
  assertCommand,
  issueJoinGrant,
  transitionCall,
  type CallActor,
  type CallAggregate,
  type CallCommand,
  type CallControlStore,
  type CallParticipant,
  type Clock,
  type CreateCallCommand,
  type IdGenerator,
  type PersistCallMutation
} from "./index.js";

const HOST = { kind: "participant", memberId: "member-alice", deviceId: "device-alice", sessionId: "session-alice" } as const;
const BOB = { kind: "participant", memberId: "member-bob", deviceId: "device-bob", sessionId: "session-bob" } as const;
const CAROL = { kind: "participant", memberId: "member-carol", deviceId: "device-carol", sessionId: "session-carol" } as const;
const MEDIA = { kind: "system", subject: "media-plane" } as const;
const MEMBERSHIP = { kind: "system", subject: "membership-service" } as const;
const OPERATIONS = { kind: "system", subject: "operations" } as const;

class SequenceIds implements IdGenerator {
  #value = 0;
  next(purpose: Parameters<IdGenerator["next"]>[0]): string {
    this.#value += 1;
    return `${purpose}-${this.#value}`;
  }
}

class MutableClock implements Clock {
  value = 1_800_000_000_000;
  nowMs(): number { return this.value; }
  tick(): number { this.value += 1_000; return this.value; }
}

function createCommand(
  idsuffix = "a",
  kind: "one_to_one" | "group" | "scheduled" = "one_to_one"
): CreateCallCommand {
  const invitees = kind === "one_to_one"
    ? [{ memberId: BOB.memberId, deviceId: BOB.deviceId }]
    : [
      { memberId: BOB.memberId, deviceId: BOB.deviceId },
      { memberId: CAROL.memberId, deviceId: CAROL.deviceId }
    ];
  return {
    schemaVersion: 1,
    type: "create_call",
    commandId: `create-${idsuffix}`,
    actor: HOST,
    expectedRevision: 0,
    clientNonce: `nonce-${idsuffix}`,
    conversationId: `conversation-${idsuffix}`,
    kind,
    mediaMode: "video",
    invitees,
    scheduledStartAtMs: kind === "scheduled" ? 1_800_000_060_000 : null,
    metadata: { origin: "chat" }
  };
}

function run(
  current: CallAggregate | null,
  command: CallCommand,
  ids: IdGenerator,
  nowMs = (current?.updatedAtMs ?? 1_800_000_000_000) + (current === null ? 0 : 1_000)
): CallAggregate {
  return transitionCall(current, command, { ids, nowMs }).snapshot;
}

function command(
  call: CallAggregate,
  type: Exclude<CallCommand["type"], "create_call">,
  actor: CallActor,
  fields: Record<string, unknown> = {},
  id = `${type}-${call.revision}`,
  expectedRevision = call.revision
): CallCommand {
  return {
    schemaVersion: 1,
    type,
    callId: call.callId,
    commandId: id,
    actor,
    expectedRevision,
    ...fields
  } as CallCommand;
}

function ringingCall(ids = new SequenceIds(), kind: "one_to_one" | "group" = "one_to_one"): CallAggregate {
  let call = run(null, createCommand(kind, kind), ids);
  call = run(call, command(call, "start_inviting", HOST), ids);
  call = run(call, command(call, "start_ringing", HOST), ids);
  return call;
}

function activeCall(ids = new SequenceIds(), kind: "one_to_one" | "group" = "one_to_one"): CallAggregate {
  let call = ringingCall(ids, kind);
  call = run(call, command(call, "accept", BOB), ids);
  const bob = call.participants.find((participant) => participant.memberId === BOB.memberId);
  if (bob === undefined) throw new Error("missing Bob fixture");
  call = run(call, command(call, "mark_active", MEDIA, { membershipId: bob.membershipId }), ids);
  return call;
}

function authorizationFor(call: CallAggregate, participant: CallParticipant) {
  return {
    subjectMembershipId: participant.membershipId,
    subjectMemberId: participant.memberId,
    subjectDeviceId: participant.deviceId,
    conversationMember: true,
    messageRequestAccepted: true,
    relationshipBlocked: false,
    deviceSessionAllowed: true,
    abusePolicyAllowed: true,
    callEpoch: call.epoch,
    membershipEpoch: participant.membershipEpoch
  } as const;
}

function standardGrantPolicy() {
  return {
    requestedSources: ["microphone"] as const,
    allowedSources: ["microphone", "camera"] as const,
    consentedSources: ["microphone", "camera"] as const,
    turnUrls: ["turns:relay.internal:5349?transport=tcp"]
  };
}

function validGrantDependencies(call: CallAggregate, ids: IdGenerator) {
  return {
    clock: { nowMs: () => call.updatedAtMs },
    ids,
    sfuSigner: { signJoinToken: async () => "header.payload.signature" },
    turnSigner: {
      signUsername: async (username: string) => (
        createHmac("sha1", "grant-test-secret").update(username).digest("base64")
      )
    }
  };
}

function expectCode(work: () => unknown, code: CallControlError["code"]): void {
  try {
    work();
    throw new Error(`expected ${code}`);
  } catch (error) {
    expect(error).toBeInstanceOf(CallControlError);
    expect((error as CallControlError).code).toBe(code);
  }
}

describe("call aggregate state table", () => {
  it("covers create, invite, ring, accept, connect, reconnect, hangup and immutable end", () => {
    const ids = new SequenceIds();
    let call = run(null, createCommand(), ids);
    expect(call.state).toBe("created");
    expect(call.revision).toBe(1);
    expect(call.roomName).not.toBe(call.conversationId);

    call = run(call, command(call, "start_inviting", HOST), ids);
    call = run(call, command(call, "start_ringing", HOST), ids);
    expect(call.state).toBe("ringing");
    expect(call.participants.find((participant) => participant.memberId === BOB.memberId)?.status).toBe("ringing");

    call = run(call, command(call, "accept", BOB), ids);
    expect(call.state).toBe("connecting");
    const bobMembership = call.participants.find((participant) => participant.memberId === BOB.memberId)?.membershipId;
    if (bobMembership === undefined) throw new Error("missing Bob");
    call = run(call, command(call, "mark_active", MEDIA, { membershipId: bobMembership }), ids);
    expect(call.state).toBe("active");

    call = run(call, command(call, "connection_lost", BOB, { membershipId: bobMembership }), ids);
    expect(call.state).toBe("reconnecting");
    call = run(call, command(call, "rejoin", BOB), ids);
    expect(call.participants.find((participant) => participant.membershipId === bobMembership)?.status).toBe("connecting");
    call = run(call, command(call, "mark_active", MEDIA, { membershipId: bobMembership }), ids);

    call = run(call, command(call, "hangup", BOB, { scope: "self" }), ids);
    expect(call.state).toBe("ending");
    expect(call.pendingEndReason).toBe("completed");
    call = run(call, command(call, "finish_ending", OPERATIONS), ids);
    expect(call.state).toBe("ended");
    expect(call.endReason).toBe("completed");
    expectCode(() => run(call, command(call, "end_call", OPERATIONS, { reason: "server-failure" }), ids), "TERMINAL_CALL");
  });

  it("enforces scheduled start time and fixed one-to-one membership", () => {
    const ids = new SequenceIds();
    let scheduled = run(null, createCommand("scheduled", "scheduled"), ids);
    scheduled = run(scheduled, command(scheduled, "start_inviting", HOST), ids);
    expectCode(
      () => run(scheduled, command(scheduled, "start_ringing", HOST), ids, 1_800_000_059_000),
      "COMMAND_NOT_ALLOWED"
    );
    scheduled = run(scheduled, command(scheduled, "start_ringing", HOST), ids, 1_800_000_060_000);
    expect(scheduled.state).toBe("ringing");

    const direct = ringingCall(new SequenceIds());
    expectCode(
      () => run(direct, command(direct, "invite_participant", HOST, {
        invitee: { memberId: CAROL.memberId, deviceId: CAROL.deviceId }
      }), ids),
      "COMMAND_NOT_ALLOWED"
    );
  });

  it("bounds scheduled-call creation and reserves generic end reasons for trusted systems", () => {
    const nowMs = 1_800_000_000_000;
    const boundary = {
      ...createCommand("schedule-boundary", "scheduled"),
      scheduledStartAtMs: nowMs + MAX_SCHEDULE_AHEAD_MS
    };
    const accepted = transitionCall(null, boundary, { ids: new SequenceIds(), nowMs });
    expect(accepted.snapshot.scheduledStartAtMs).toBe(nowMs + MAX_SCHEDULE_AHEAD_MS);
    expectCode(
      () => transitionCall(null, {
        ...boundary,
        commandId: "create-schedule-too-far",
        clientNonce: "nonce-schedule-too-far",
        scheduledStartAtMs: nowMs + MAX_SCHEDULE_AHEAD_MS + 1
      }, { ids: new SequenceIds(), nowMs }),
      "COMMAND_NOT_ALLOWED"
    );

    const call = ringingCall(new SequenceIds());
    expectCode(
      () => run(call, command(call, "end_call", HOST, { reason: "server-failure" }), new SequenceIds()),
      "FORBIDDEN"
    );
    expect(run(call, command(call, "end_call", OPERATIONS, { reason: "server-failure" }), new SequenceIds()).state)
      .toBe("ending");
  });

  it.each(["accept-first", "hangup-first"] as const)("resolves accept/hangup race by durable revision: %s", (order) => {
    const ids = new SequenceIds();
    const initial = ringingCall(ids);
    const accept = command(initial, "accept", BOB, {}, "race-accept", initial.revision);
    const hangup = command(initial, "hangup", BOB, { scope: "self" }, "race-hangup", initial.revision);

    if (order === "accept-first") {
      let winner = run(initial, accept, ids);
      expect(winner.state).toBe("connecting");
      expectCode(() => run(winner, hangup, ids), "REVISION_CONFLICT");
      winner = run(winner, { ...hangup, expectedRevision: winner.revision }, ids);
      expect(winner.state).toBe("ending");
    } else {
      const winner = run(initial, hangup, ids);
      expect(winner.state).toBe("ending");
      expectCode(() => run(winner, accept, ids), "REVISION_CONFLICT");
      expectCode(() => run(winner, { ...accept, expectedRevision: winner.revision }, ids), "COMMAND_NOT_ALLOWED");
    }
  });

  it.each(["rejoin-first", "kick-first"] as const)("makes kick authoritative in kick/rejoin race: %s", (order) => {
    const ids = new SequenceIds();
    let call = activeCall(ids, "group");
    const bob = call.participants.find((participant) => participant.memberId === BOB.memberId);
    if (bob === undefined) throw new Error("missing Bob");
    call = run(call, command(call, "connection_lost", BOB, { membershipId: bob.membershipId }), ids);
    const rejoin = command(call, "rejoin", BOB, {}, "race-rejoin", call.revision);
    const kick = command(call, "kick", HOST, { membershipId: bob.membershipId }, "race-kick", call.revision);

    if (order === "rejoin-first") {
      let winner = run(call, rejoin, ids);
      expectCode(() => run(winner, kick, ids), "REVISION_CONFLICT");
      winner = run(winner, { ...kick, expectedRevision: winner.revision }, ids);
      expect(winner.participants.find((participant) => participant.membershipId === bob.membershipId)?.status).toBe("kicked");
    } else {
      const winner = run(call, kick, ids);
      expect(winner.epoch).toBe(call.epoch + 1);
      expectCode(() => run(winner, rejoin, ids), "REVISION_CONFLICT");
      expectCode(() => run(winner, { ...rejoin, expectedRevision: winner.revision }, ids), "MEMBERSHIP_REVOKED");
    }
  });

  it("increments security epochs on membership removal", () => {
    const ids = new SequenceIds();
    const call = activeCall(ids, "group");
    const bob = call.participants.find((participant) => participant.memberId === BOB.memberId);
    if (bob === undefined) throw new Error("missing Bob");
    const removed = run(call, command(call, "membership_removed", MEMBERSHIP, { membershipId: bob.membershipId }), ids);
    const nextBob = removed.participants.find((participant) => participant.membershipId === bob.membershipId);
    expect(removed.epoch).toBe(call.epoch + 1);
    expect(nextBob?.membershipEpoch).toBe(removed.epoch);
    expect(nextBob?.status).toBe("revoked");
  });

  it("never routes removal or later outbox events to terminal memberships", () => {
    const ids = new SequenceIds();
    const call = activeCall(ids, "group");
    const bob = call.participants.find((participant) => participant.memberId === BOB.memberId);
    if (bob === undefined) throw new Error("missing Bob");

    const removal = transitionCall(
      call,
      command(call, "kick", HOST, { membershipId: bob.membershipId }, "kick-outbox"),
      { ids, nowMs: call.updatedAtMs + 1_000 }
    );
    expect(removal.outbox.payload.recipientMembershipIds).not.toContain(bob.membershipId);
    expect(removal.outbox.payload.recipientMembershipIds).toContain(
      call.participants.find((participant) => participant.role === "host")?.membershipId
    );

    const later = transitionCall(
      removal.snapshot,
      command(removal.snapshot, "end_call", OPERATIONS, { reason: "completed" }, "end-after-kick"),
      { ids, nowMs: removal.snapshot.updatedAtMs + 1_000 }
    );
    expect(later.outbox.payload.recipientMembershipIds).not.toContain(bob.membershipId);
  });

  it("rejects corrupt persisted enums and impossible participant timelines", () => {
    const ids = new SequenceIds();
    const call = activeCall(ids);
    const bobIndex = call.participants.findIndex((participant) => participant.memberId === BOB.memberId);
    if (bobIndex < 0) throw new Error("missing Bob");
    const malformedStatus = {
      ...call,
      participants: call.participants.map((participant, index) => (
        index === bobIndex ? { ...participant, status: "ghost" as CallParticipant["status"] } : participant
      ))
    };
    expectCode(() => assertCallInvariants(malformedStatus), "VALIDATION_FAILED");

    const malformedTimeline = {
      ...call,
      participants: call.participants.map((participant, index) => (
        index === bobIndex
          ? { ...participant, acceptedAtMs: participant.invitedAtMs - 1 }
          : participant
      ))
    };
    expectCode(() => assertCallInvariants(malformedTimeline), "VALIDATION_FAILED");
  });

  it("fails closed with domain errors for malformed runtime command shapes", () => {
    expectCode(
      () => assertCommand({ ...createCommand("null-actor"), actor: null } as unknown as CallCommand),
      "VALIDATION_FAILED"
    );
    expectCode(
      () => assertCommand({
        ...createCommand("null-invitee"),
        invitees: [null]
      } as unknown as CallCommand),
      "VALIDATION_FAILED"
    );
    expectCode(
      () => assertCommand({
        ...createCommand("unknown-command"),
        type: "escalate_to_room_admin"
      } as unknown as CallCommand),
      "VALIDATION_FAILED"
    );
  });
});

class MemoryStore implements CallControlStore {
  readonly calls = new Map<string, CallAggregate>();
  readonly commands = new Map<string, PersistCallMutation["commandReceipt"]>();
  readonly creations = new Map<string, NonNullable<PersistCallMutation["creationReceipt"]>>();
  readonly events: PersistCallMutation["mutation"]["event"][] = [];
  readonly outbox: PersistCallMutation["mutation"]["outbox"][] = [];

  constructor(readonly revisionCheckFirst = false) {}

  async loadCall(callId: string): Promise<CallAggregate | null> { return this.calls.get(callId) ?? null; }
  async findCommandReceipt(scope: string) { return this.commands.get(scope) ?? null; }
  async findCreationReceipt(scope: string) { return this.creations.get(scope) ?? null; }
  async commit(input: PersistCallMutation): Promise<void> {
    const current = this.calls.get(input.mutation.snapshot.callId);
    const revisionConflict = input.expectedRevision === null
      ? current !== undefined
      : current?.revision !== input.expectedRevision;
    if (this.revisionCheckFirst && revisionConflict) throw new StoreRevisionConflictError();
    if (this.commands.has(input.commandReceipt.scope)) throw new StoreDuplicateCommandError();
    if (input.creationReceipt !== null && this.creations.has(input.creationReceipt.scope)) {
      throw new StoreDuplicateCreationError();
    }
    if (revisionConflict) throw new StoreRevisionConflictError();
    this.calls.set(input.mutation.snapshot.callId, input.mutation.snapshot);
    this.commands.set(input.commandReceipt.scope, input.commandReceipt);
    if (input.creationReceipt !== null) this.creations.set(input.creationReceipt.scope, input.creationReceipt);
    this.events.push(input.mutation.event);
    this.outbox.push(input.mutation.outbox);
  }
}

describe("idempotent executor and atomic persistence contract", () => {
  it("replays a command without a second event/outbox and rejects commandId mutation", async () => {
    const store = new MemoryStore();
    const clock = new MutableClock();
    const executor = new CallControlExecutor(store, clock, new SequenceIds());
    const create = createCommand("executor");
    const first = await executor.execute(create);
    const replayed = await executor.execute(create);
    expect(replayed.replayed).toBe(true);
    expect(replayed.eventId).toBe(first.eventId);
    expect(replayed.outboxId).toBeNull();
    expect(store.events).toHaveLength(1);
    expect(store.outbox).toHaveLength(1);

    await expect(executor.execute({ ...create, mediaMode: "audio" })).rejects.toMatchObject({
      code: "IDEMPOTENCY_KEY_REUSED"
    });
  });

  it("uses authenticated caller plus clientNonce for idempotent creation", async () => {
    const store = new MemoryStore();
    const clock = new MutableClock();
    const executor = new CallControlExecutor(store, clock, new SequenceIds());
    const first = createCommand("nonce");
    const created = await executor.execute(first);
    const retry = await executor.execute({ ...first, commandId: "create-new-command" });
    expect(retry.replayed).toBe(true);
    expect(retry.snapshot.callId).toBe(created.snapshot.callId);
    expect(store.events).toHaveLength(1);
    await expect(executor.execute({
      ...first,
      commandId: "create-conflict-command",
      metadata: { origin: "different" }
    })).rejects.toMatchObject({ code: "CREATION_NONCE_REUSED" });
  });

  it("scopes command and creation idempotency to the authenticated device session", async () => {
    const store = new MemoryStore();
    const executor = new CallControlExecutor(store, new MutableClock(), new SequenceIds());
    const first = createCommand("session-scope");
    const firstResult = await executor.execute(first);
    const otherSession = {
      ...first,
      actor: { ...first.actor, sessionId: "session-alice-reauthenticated" }
    };
    const secondResult = await executor.execute(otherSession);
    expect(secondResult.replayed).toBe(false);
    expect(secondResult.snapshot.callId).not.toBe(firstResult.snapshot.callId);
    expect(store.events).toHaveLength(2);
  });

  it("replays a concurrent identical command even when a store checks CAS before receipt uniqueness", async () => {
    const store = new MemoryStore(true);
    const clock = new MutableClock();
    const executor = new CallControlExecutor(store, clock, new SequenceIds());
    let call = (await executor.execute(createCommand("revision-first"))).snapshot;
    call = (await executor.execute(command(call, "start_inviting", HOST, {}, "revision-first-invite"))).snapshot;
    call = (await executor.execute(command(call, "start_ringing", HOST, {}, "revision-first-ring"))).snapshot;
    const accept = command(call, "accept", BOB, {}, "revision-first-accept");

    const results = await Promise.all([executor.execute(accept), executor.execute(accept)]);
    expect(results.filter((result) => result.replayed)).toHaveLength(1);
    expect(results[0]?.eventId).toBe(results[1]?.eventId);
    expect(store.events).toHaveLength(4);
    expect(store.outbox).toHaveLength(4);
  });

  it("commits exactly one winner for concurrent accept/hangup commands", async () => {
    const store = new MemoryStore(true);
    const executor = new CallControlExecutor(store, new MutableClock(), new SequenceIds());
    let call = (await executor.execute(createCommand("executor-race"))).snapshot;
    call = (await executor.execute(command(call, "start_inviting", HOST, {}, "executor-race-invite"))).snapshot;
    call = (await executor.execute(command(call, "start_ringing", HOST, {}, "executor-race-ring"))).snapshot;
    const beforeEvents = store.events.length;
    const results = await Promise.allSettled([
      executor.execute(command(call, "accept", BOB, {}, "executor-race-accept")),
      executor.execute(command(call, "hangup", BOB, { scope: "self" }, "executor-race-hangup"))
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const loser = results.find((result) => result.status === "rejected");
    expect(loser).toMatchObject({ status: "rejected", reason: { code: "REVISION_CONFLICT" } });
    expect(store.events).toHaveLength(beforeEvents + 1);
    expect(store.outbox).toHaveLength(beforeEvents + 1);
  });
});

describe("scoped SFU and TURN grant", () => {
  it("binds a short-lived grant to room, sources and current epochs without stable identity metadata", async () => {
    const ids = new SequenceIds();
    const call = activeCall(ids);
    const bob = call.participants.find((participant) => participant.memberId === BOB.memberId);
    if (bob === undefined) throw new Error("missing Bob");
    let capturedUsername = "";
    const grantNowMs = call.updatedAtMs + 999;
    const grant = await issueJoinGrant(
      call,
      bob,
      {
        subjectMembershipId: bob.membershipId,
        subjectMemberId: bob.memberId,
        subjectDeviceId: bob.deviceId,
        conversationMember: true,
        messageRequestAccepted: true,
        relationshipBlocked: false,
        deviceSessionAllowed: true,
        abusePolicyAllowed: true,
        callEpoch: call.epoch,
        membershipEpoch: bob.membershipEpoch
      },
      {
        requestedSources: ["microphone", "camera"],
        allowedSources: ["microphone", "camera"],
        consentedSources: ["microphone", "camera"],
        turnUrls: ["turn:relay.internal:3478?transport=udp"]
      },
      {
        clock: { nowMs: () => grantNowMs },
        ids,
        sfuSigner: {
          signJoinToken: async (descriptor) => {
            expect(Object.isFrozen(descriptor)).toBe(true);
            expect(Object.isFrozen(descriptor.videoGrant)).toBe(true);
            expect(Object.isFrozen(descriptor.videoGrant.canPublishSources)).toBe(true);
            return `signed.${Buffer.from(JSON.stringify(descriptor)).toString("base64url")}.signature`;
          }
        },
        turnSigner: {
          signUsername: async (username) => {
            capturedUsername = username;
            return createHmac("sha1", "test-secret-never-returned").update(username).digest("base64");
          }
        }
      }
    );

    expect(grant.sfu.descriptor.expiresAtMs - grant.sfu.descriptor.issuedAtMs).toBe(120_000);
    expect(grant.sfu.descriptor.ttlSeconds).toBe(120);
    expect(grant.sfu.descriptor.videoGrant).toMatchObject({
      room: call.roomName,
      roomJoin: true,
      roomAdmin: false,
      roomRecord: false,
      ingressAdmin: false,
      canPublishSources: ["microphone", "camera"],
      canPublishData: false,
      canSubscribe: true
    });
    expect(grant.turn.expiresAtMs).toBe((Math.floor(grantNowMs / 1_000) + 300) * 1_000);
    expect(grant.turn.username).toBe(capturedUsername);
    expect(grant.turn.credential).toBe(
      createHmac("sha1", "test-secret-never-returned").update(grant.turn.username).digest("base64")
    );
    const mediaMetadata = JSON.stringify(grant.sfu.descriptor);
    expect(mediaMetadata).not.toContain(call.conversationId);
    expect(mediaMetadata).not.toContain(BOB.memberId);
    expect(mediaMetadata).not.toContain(BOB.deviceId);
    expect(mediaMetadata).not.toContain("test-secret-never-returned");
    expect(grant).not.toHaveProperty("mediaKey");
  });

  it("rejects stale epoch, blocked relationships, unconsented sources and excessive TTL", async () => {
    const ids = new SequenceIds();
    const call = activeCall(ids);
    const bob = call.participants.find((participant) => participant.memberId === BOB.memberId);
    if (bob === undefined) throw new Error("missing Bob");
    const authorization = {
      subjectMembershipId: bob.membershipId,
      subjectMemberId: bob.memberId,
      subjectDeviceId: bob.deviceId,
      conversationMember: true,
      messageRequestAccepted: true,
      relationshipBlocked: false,
      deviceSessionAllowed: true,
      abusePolicyAllowed: true,
      callEpoch: call.epoch,
      membershipEpoch: bob.membershipEpoch
    };
    const policy = {
      requestedSources: ["microphone"] as const,
      allowedSources: ["microphone"] as const,
      consentedSources: ["microphone"] as const,
      turnUrls: ["turns:relay.internal:5349"]
    };
    const dependencies = {
      clock: { nowMs: () => call.updatedAtMs },
      ids,
      sfuSigner: { signJoinToken: async () => "header.payload.signature" },
      turnSigner: {
        signUsername: async (username: string) => (
          createHmac("sha1", "grant-test-secret").update(username).digest("base64")
        )
      }
    };
    await expect(issueJoinGrant(call, bob, { ...authorization, callEpoch: call.epoch - 1 }, policy, dependencies))
      .rejects.toMatchObject({ code: "GRANT_DENIED" });
    await expect(issueJoinGrant(call, bob, { ...authorization, relationshipBlocked: true }, policy, dependencies))
      .rejects.toMatchObject({ code: "GRANT_DENIED" });
    await expect(issueJoinGrant(call, bob, authorization, {
      ...policy,
      requestedSources: ["camera"]
    }, dependencies)).rejects.toMatchObject({ code: "GRANT_DENIED" });
    await expect(issueJoinGrant(call, bob, authorization, {
      ...policy,
      sfuTtlSeconds: 121
    }, dependencies)).rejects.toMatchObject({ code: "GRANT_DENIED" });
  });

  it("rejects forged or stale participant objects before either secret-owning signer runs", async () => {
    const ids = new SequenceIds();
    const call = activeCall(ids);
    const bob = call.participants.find((participant) => participant.memberId === BOB.memberId);
    if (bob === undefined) throw new Error("missing Bob");
    let signerCalls = 0;
    const dependencies = {
      ...validGrantDependencies(call, ids),
      sfuSigner: {
        signJoinToken: async () => {
          signerCalls += 1;
          return "header.payload.signature";
        }
      },
      turnSigner: {
        signUsername: async (username: string) => {
          signerCalls += 1;
          return createHmac("sha1", "grant-test-secret").update(username).digest("base64");
        }
      }
    };

    for (const forged of [
      { ...bob, participantIdentity: "participant-attacker" },
      { ...bob, status: "connecting" as const },
      { ...bob, membershipEpoch: bob.membershipEpoch + 1 }
    ]) {
      await expect(issueJoinGrant(
        call,
        forged,
        authorizationFor(call, bob),
        standardGrantPolicy(),
        dependencies
      )).rejects.toMatchObject({ code: "GRANT_DENIED" });
    }

    await expect(issueJoinGrant(
      call,
      bob,
      { ...authorizationFor(call, bob), subjectDeviceId: "device-attacker" },
      standardGrantPolicy(),
      dependencies
    )).rejects.toMatchObject({ code: "GRANT_DENIED" });
    expect(signerCalls).toBe(0);
  });

  it("rejects a previously valid participant snapshot after its canonical state changes", async () => {
    const ids = new SequenceIds();
    const call = activeCall(ids);
    const bob = call.participants.find((participant) => participant.memberId === BOB.memberId);
    if (bob === undefined) throw new Error("missing Bob");
    const lost = run(
      call,
      command(call, "connection_lost", MEDIA, { membershipId: bob.membershipId }, "grant-stale-participant"),
      ids
    );
    const currentBob = lost.participants.find((participant) => participant.membershipId === bob.membershipId);
    if (currentBob === undefined) throw new Error("missing current Bob");
    await expect(issueJoinGrant(
      lost,
      bob,
      authorizationFor(lost, currentBob),
      standardGrantPolicy(),
      validGrantDependencies(lost, ids)
    )).rejects.toMatchObject({ code: "GRANT_DENIED" });
  });

  it("omits publish-source claims for subscribe-only tokens and enforces media mode", async () => {
    const ids = new SequenceIds();
    const call = activeCall(ids);
    const bob = call.participants.find((participant) => participant.memberId === BOB.memberId);
    if (bob === undefined) throw new Error("missing Bob");
    const subscribeOnly = await issueJoinGrant(
      call,
      bob,
      authorizationFor(call, bob),
      {
        requestedSources: [],
        allowedSources: ["microphone"],
        consentedSources: ["microphone"],
        turnUrls: ["turn:relay.internal:3478?transport=udp"]
      },
      validGrantDependencies(call, ids)
    );
    expect(subscribeOnly.sfu.descriptor.videoGrant.canPublish).toBe(false);
    expect(subscribeOnly.sfu.descriptor.videoGrant).not.toHaveProperty("canPublishSources");

    const audioIds = new SequenceIds();
    let audioCall = run(null, { ...createCommand("audio-call"), mediaMode: "audio" }, audioIds);
    audioCall = run(audioCall, command(audioCall, "start_inviting", HOST), audioIds);
    audioCall = run(audioCall, command(audioCall, "start_ringing", HOST), audioIds);
    audioCall = run(audioCall, command(audioCall, "accept", BOB), audioIds);
    const audioBob = audioCall.participants.find((participant) => participant.memberId === BOB.memberId);
    if (audioBob === undefined) throw new Error("missing audio Bob");
    audioCall = run(audioCall, command(audioCall, "mark_active", MEDIA, {
      membershipId: audioBob.membershipId
    }), audioIds);
    const activeAudioBob = audioCall.participants.find((participant) => participant.membershipId === audioBob.membershipId);
    if (activeAudioBob === undefined) throw new Error("missing active audio Bob");
    await expect(issueJoinGrant(
      audioCall,
      activeAudioBob,
      authorizationFor(audioCall, activeAudioBob),
      {
        requestedSources: ["camera"],
        allowedSources: ["camera"],
        consentedSources: ["camera"],
        turnUrls: ["turns:relay.internal:5349"]
      },
      validGrantDependencies(audioCall, audioIds)
    )).rejects.toMatchObject({ code: "GRANT_DENIED" });
  });

  it("rejects credential-bearing TURN URLs, malformed signer output and a clock behind the snapshot", async () => {
    const ids = new SequenceIds();
    const call = activeCall(ids);
    const bob = call.participants.find((participant) => participant.memberId === BOB.memberId);
    if (bob === undefined) throw new Error("missing Bob");
    const authorization = authorizationFor(call, bob);
    const policy = standardGrantPolicy();

    await expect(issueJoinGrant(call, bob, authorization, {
      ...policy,
      turnUrls: ["turn:embedded-secret@relay.internal:3478"]
    }, validGrantDependencies(call, ids))).rejects.toMatchObject({ code: "GRANT_DENIED" });

    await expect(issueJoinGrant(call, bob, authorization, policy, {
      ...validGrantDependencies(call, ids),
      sfuSigner: { signJoinToken: async () => "not-a-jwt" }
    })).rejects.toMatchObject({ code: "GRANT_DENIED" });

    await expect(issueJoinGrant(call, bob, authorization, policy, {
      ...validGrantDependencies(call, ids),
      turnSigner: { signUsername: async () => "not-coturn-base64" }
    })).rejects.toMatchObject({ code: "GRANT_DENIED" });

    await expect(issueJoinGrant(call, bob, authorization, policy, {
      ...validGrantDependencies(call, ids),
      clock: { nowMs: () => call.updatedAtMs - 1 }
    })).rejects.toMatchObject({ code: "GRANT_DENIED" });

    const leakedSecret = "livekit-api-secret-must-not-escape";
    try {
      await issueJoinGrant(call, bob, authorization, policy, {
        ...validGrantDependencies(call, ids),
        sfuSigner: { signJoinToken: async () => { throw new Error(leakedSecret); } }
      });
      throw new Error("expected signer failure");
    } catch (error) {
      expect(error).toBeInstanceOf(CallControlError);
      expect((error as Error).message).toBe("credential signer failed");
      expect(String(error)).not.toContain(leakedSecret);
    }
  });
});

describe("state-machine properties", () => {
  it("never regresses revision/epoch and preserves invariants under reorder and stale commands", () => {
    fc.assert(fc.property(
      fc.array(fc.record({
        action: fc.constantFrom("accept", "active", "loss", "rejoin", "kick", "end", "finish"),
        staleBy: fc.integer({ min: 0, max: 2 })
      }), { minLength: 1, maxLength: 80 }),
      (steps) => {
        const ids = new SequenceIds();
        let call = ringingCall(ids, "group");
        const bobMembership = call.participants.find((participant) => participant.memberId === BOB.memberId)?.membershipId;
        if (bobMembership === undefined) return false;

        steps.forEach((step, index) => {
          const before = call;
          const expectedRevision = Math.max(0, call.revision - step.staleBy);
          let nextCommand: CallCommand;
          switch (step.action) {
            case "accept": nextCommand = command(call, "accept", BOB, {}, `p-accept-${index}`, expectedRevision); break;
            case "active": nextCommand = command(call, "mark_active", MEDIA, { membershipId: bobMembership }, `p-active-${index}`, expectedRevision); break;
            case "loss": nextCommand = command(call, "connection_lost", MEDIA, { membershipId: bobMembership }, `p-loss-${index}`, expectedRevision); break;
            case "rejoin": nextCommand = command(call, "rejoin", BOB, {}, `p-rejoin-${index}`, expectedRevision); break;
            case "kick": nextCommand = command(call, "kick", HOST, { membershipId: bobMembership }, `p-kick-${index}`, expectedRevision); break;
            case "end": nextCommand = command(call, "end_call", OPERATIONS, { reason: "completed" }, `p-end-${index}`, expectedRevision); break;
            case "finish": nextCommand = command(call, "finish_ending", OPERATIONS, {}, `p-finish-${index}`, expectedRevision); break;
          }
          try {
            const mutation = transitionCall(call, nextCommand, {
              ids,
              nowMs: call.updatedAtMs + 1_000
            });
            call = mutation.snapshot;
            expect(call.revision).toBe(before.revision + 1);
            expect(call.epoch).toBeGreaterThanOrEqual(before.epoch);
            expect(call.updatedAtMs).toBeGreaterThanOrEqual(before.updatedAtMs);
            expect(mutation.outbox.payload.recipientMembershipIds).toEqual(
              call.participants
                .filter((participant) => !["declined", "left", "kicked", "revoked"].includes(participant.status))
                .map((participant) => participant.membershipId)
            );
            assertCallInvariants(call);
          } catch (error) {
            expect(error).toBeInstanceOf(CallControlError);
            expect(call).toBe(before);
          }
        });
        return true;
      }
    ), { numRuns: 150 });
  });
});
