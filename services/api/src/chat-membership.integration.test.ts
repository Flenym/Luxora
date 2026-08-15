import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import {
  ChatMemberListResponseSchema,
  ChatMembershipMutationResponseSchema
} from "@luxora/protocol";
import type { LuxoraApp } from "./app.js";
import { buildApp } from "./app.js";
import { establishAcceptedRelationship, testConfig } from "./test-helpers.js";

interface Identity {
  id: string;
  accessToken: string;
}

class RealtimeClient {
  readonly messages: any[] = [];

  constructor(readonly socket: WebSocket) {
    socket.on("message", (raw) => this.messages.push(JSON.parse(raw.toString()) as unknown));
  }

  send(message: unknown): void {
    this.socket.send(JSON.stringify(message));
  }

  async waitFor(predicate: (message: any) => boolean, timeoutMs = 3_000): Promise<any> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const index = this.messages.findIndex(predicate);
      if (index >= 0) return this.messages.splice(index, 1)[0];
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`Timed out waiting for realtime message; received ${JSON.stringify(this.messages)}`);
  }
}

async function withFixedClock<T>(iso: string, operation: () => Promise<T>): Promise<T> {
  const NativeDate = globalThis.Date;
  const fixedMilliseconds = new NativeDate(iso).getTime();
  class FixedDate extends NativeDate {
    constructor(value?: string | number) {
      if (arguments.length === 0) super(fixedMilliseconds);
      else super(value as string | number);
    }

    static override now(): number {
      return fixedMilliseconds;
    }
  }
  globalThis.Date = FixedDate as DateConstructor;
  try {
    return await operation();
  } finally {
    globalThis.Date = NativeDate;
  }
}

describe("chat membership lifecycle", () => {
  let app: LuxoraApp | undefined;
  const sockets: WebSocket[] = [];

  afterEach(async () => {
    for (const socket of sockets) socket.close();
    sockets.length = 0;
    await app?.close();
    app = undefined;
  });

  async function register(username: string): Promise<Identity> {
    const response = await app!.inject({
      method: "POST",
      url: "/v1/auth/register",
      payload: {
        username,
        displayName: username,
        password: "correct horse battery staple"
      }
    });
    expect(response.statusCode).toBe(201);
    return {
      id: response.json().user.id as string,
      accessToken: response.json().tokens.accessToken as string
    };
  }

  function auth(identity: Identity): { authorization: string } {
    return { authorization: `Bearer ${identity.accessToken}` };
  }

  async function createGroup(owner: Identity, memberIds: string[] = []): Promise<string> {
    const response = await app!.inject({
      method: "POST",
      url: "/v1/chats",
      headers: auth(owner),
      payload: { kind: "group", title: "Membership test", memberIds }
    });
    expect(response.statusCode).toBe(201);
    return response.json().chat.id as string;
  }

  async function connect(address: string, identity: Identity, version: 1 | 2): Promise<RealtimeClient> {
    return (await connectWithReady(address, identity, version)).client;
  }

  async function connectWithReady(
    address: string,
    identity: Identity,
    version: 1 | 2,
    resume: { resumeCursor?: string } = {}
  ): Promise<{ client: RealtimeClient; ready: any }> {
    const socket = new WebSocket(`${address.replace("http", "ws")}/v${version}/realtime`);
    sockets.push(socket);
    const client = new RealtimeClient(socket);
    await new Promise<void>((resolve, reject) => {
      socket.once("open", resolve);
      socket.once("error", reject);
    });
    await client.waitFor((message) => message.type === "hello");
    client.send({ type: "authenticate", accessToken: identity.accessToken, ...resume });
    const ready = await client.waitFor((message) => message.type === "ready");
    return { client, ready };
  }

  it("adds, lists, promotes and removes members with exact idempotent receipts", async () => {
    app = await buildApp({ config: testConfig(), logger: false });
    const owner = await register("membership_owner");
    const existing = await register("membership_existing");
    const invited = await register("membership_invited");
    await establishAcceptedRelationship(app, owner, existing);
    await establishAcceptedRelationship(app, owner, invited);
    const chatId = await createGroup(owner, [existing.id]);

    const addNonce = randomUUID();
    const add = await app.inject({
      method: "POST",
      url: `/v1/chats/${chatId}/members`,
      headers: auth(owner),
      payload: { userId: invited.id, role: "member", clientNonce: addNonce }
    });
    expect(add.statusCode).toBe(201);
    const added = ChatMembershipMutationResponseSchema.parse(add.json());
    expect(added).toMatchObject({
      membership: { chatId, userId: invited.id, role: "member", revision: 1 },
      replayed: false
    });

    const sequenceAfterAdd = app.luxora.store.getLatestSequence();
    const replay = await app.inject({
      method: "POST",
      url: `/v1/chats/${chatId}/members`,
      headers: auth(owner),
      payload: { userId: invited.id, role: "member", clientNonce: addNonce }
    });
    expect(replay.statusCode).toBe(201);
    expect(ChatMembershipMutationResponseSchema.parse(replay.json())).toEqual({
      membership: added.membership,
      replayed: true
    });
    expect(app.luxora.store.getLatestSequence()).toBe(sequenceAfterAdd);

    const changedNoncePayload = await app.inject({
      method: "POST",
      url: `/v1/chats/${chatId}/members`,
      headers: auth(owner),
      payload: { userId: existing.id, role: "member", clientNonce: addNonce }
    });
    expect(changedNoncePayload.statusCode).toBe(409);

    const listed = await app.inject({
      method: "GET",
      url: `/v1/chats/${chatId}/members`,
      headers: auth(invited)
    });
    expect(listed.statusCode).toBe(200);
    const members = ChatMemberListResponseSchema.parse(listed.json());
    expect(members.items.map(({ membership }) => membership.userId).sort()).toEqual(
      [owner.id, existing.id, invited.id].sort()
    );

    const promote = await app.inject({
      method: "PATCH",
      url: `/v1/chats/${chatId}/members/${invited.id}`,
      headers: auth(owner),
      payload: { role: "admin", expectedRevision: 1, clientNonce: randomUUID() }
    });
    expect(promote.statusCode).toBe(200);
    const promoted = ChatMembershipMutationResponseSchema.parse(promote.json());
    expect(promoted.membership).toMatchObject({ role: "admin", revision: 2 });

    const staleRemoval = await app.inject({
      method: "DELETE",
      url: `/v1/chats/${chatId}/members/${invited.id}`,
      headers: auth(owner),
      payload: { expectedRevision: 1, clientNonce: randomUUID() }
    });
    expect(staleRemoval.statusCode).toBe(409);

    const removeNonce = randomUUID();
    const removedResponse = await app.inject({
      method: "DELETE",
      url: `/v1/chats/${chatId}/members/${invited.id}`,
      headers: auth(owner),
      payload: { expectedRevision: 2, clientNonce: removeNonce }
    });
    expect(removedResponse.statusCode).toBe(200);
    const removed = ChatMembershipMutationResponseSchema.parse(removedResponse.json());
    expect(removed).toMatchObject({
      membership: { userId: invited.id, role: "admin", revision: 3 },
      replayed: false
    });
    expect(removed.membership.updatedAt).not.toBe(promoted.membership.updatedAt);

    const deniedAfterRemoval = await app.inject({
      method: "GET",
      url: `/v1/chats/${chatId}/members`,
      headers: auth(invited)
    });
    expect(deniedAfterRemoval.statusCode).toBe(403);
    expect(app.luxora.store.getChatMember(chatId, invited.id)).toBeNull();
  });

  it("enforces the owner/admin/member permission matrix and preserves the sole owner", async () => {
    app = await buildApp({ config: testConfig(), logger: false });
    const owner = await register("roles_owner");
    const admin = await register("roles_admin");
    const member = await register("roles_member");
    const candidate = await register("roles_candidate");
    for (const identity of [admin, member, candidate]) {
      await establishAcceptedRelationship(app, owner, identity);
    }
    await establishAcceptedRelationship(app, admin, candidate);
    const chatId = await createGroup(owner, [admin.id, member.id]);

    const promoteAdmin = await app.inject({
      method: "PATCH",
      url: `/v1/chats/${chatId}/members/${admin.id}`,
      headers: auth(owner),
      payload: { role: "admin", expectedRevision: 1, clientNonce: randomUUID() }
    });
    expect(promoteAdmin.statusCode).toBe(200);

    const adminPromote = await app.inject({
      method: "PATCH",
      url: `/v1/chats/${chatId}/members/${member.id}`,
      headers: auth(admin),
      payload: { role: "admin", expectedRevision: 1, clientNonce: randomUUID() }
    });
    expect(adminPromote.statusCode).toBe(403);

    const adminAddsAdmin = await app.inject({
      method: "POST",
      url: `/v1/chats/${chatId}/members`,
      headers: auth(admin),
      payload: { userId: candidate.id, role: "admin", clientNonce: randomUUID() }
    });
    expect(adminAddsAdmin.statusCode).toBe(403);

    const adminRemovesPeerAdmin = await app.inject({
      method: "DELETE",
      url: `/v1/chats/${chatId}/members/${admin.id}`,
      headers: auth(member),
      payload: { expectedRevision: 2, clientNonce: randomUUID() }
    });
    expect(adminRemovesPeerAdmin.statusCode).toBe(403);

    const ownerLeave = await app.inject({
      method: "DELETE",
      url: `/v1/chats/${chatId}/members/${owner.id}`,
      headers: auth(owner),
      payload: { expectedRevision: 1, clientNonce: randomUUID() }
    });
    expect(ownerLeave.statusCode).toBe(409);
    expect(app.luxora.store.getChatMember(chatId, owner.id)?.role).toBe("owner");

    const memberSelfLeaveNonce = randomUUID();
    const memberLeaves = await app.inject({
      method: "DELETE",
      url: `/v1/chats/${chatId}/members/${member.id}`,
      headers: auth(member),
      payload: { expectedRevision: 1, clientNonce: memberSelfLeaveNonce }
    });
    expect(memberLeaves.statusCode).toBe(200);
    const selfLeaveResult = ChatMembershipMutationResponseSchema.parse(memberLeaves.json());

    const replayAfterAccessWasRemoved = await app.inject({
      method: "DELETE",
      url: `/v1/chats/${chatId}/members/${member.id}`,
      headers: auth(member),
      payload: { expectedRevision: 1, clientNonce: memberSelfLeaveNonce }
    });
    expect(replayAfterAccessWasRemoved.statusCode).toBe(200);
    expect(ChatMembershipMutationResponseSchema.parse(replayAfterAccessWasRemoved.json())).toEqual({
      membership: selfLeaveResult.membership,
      replayed: true
    });
  });

  it("keeps direct-chat membership immutable and relationship-gates additions", async () => {
    app = await buildApp({ config: testConfig(), logger: false });
    const alice = await register("immutable_alice");
    const bob = await register("immutable_bob");
    const stranger = await register("immutable_stranger");
    const directId = await establishAcceptedRelationship(app, alice, bob);

    const directAdd = await app.inject({
      method: "POST",
      url: `/v1/chats/${directId}/members`,
      headers: auth(alice),
      payload: { userId: stranger.id, role: "member", clientNonce: randomUUID() }
    });
    expect(directAdd.statusCode).toBe(409);

    const groupId = await createGroup(alice);
    const relationshipDenied = await app.inject({
      method: "POST",
      url: `/v1/chats/${groupId}/members`,
      headers: auth(alice),
      payload: { userId: stranger.id, role: "member", clientNonce: randomUUID() }
    });
    expect(relationshipDenied.statusCode).toBe(403);
    expect(relationshipDenied.json().error.details).toEqual({ reason: "relationship_unavailable" });
  });

  it("delivers membership events only to v2 and immediately revokes removed-chat access", async () => {
    app = await buildApp({ config: testConfig(), logger: false });
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    const owner = await register("realtime_membership_owner");
    const member = await register("realtime_membership_member");
    const invited = await register("realtime_membership_invited");
    await establishAcceptedRelationship(app, owner, member);
    await establishAcceptedRelationship(app, owner, invited);
    const chatId = await createGroup(owner, [member.id]);
    const ownerV2 = await connect(address, owner, 2);
    const memberV1 = await connect(address, member, 1);
    const invitedV2 = await connect(address, invited, 2);

    const add = await app.inject({
      method: "POST",
      url: `/v1/chats/${chatId}/members`,
      headers: auth(owner),
      payload: { userId: invited.id, role: "member", clientNonce: randomUUID() }
    });
    expect(add.statusCode).toBe(201);
    await ownerV2.waitFor((message) =>
      message.type === "dispatch" &&
      message.event.type === "chat.member.changed" &&
      message.event.change === "added" &&
      message.event.membership.userId === invited.id
    );
    await invitedV2.waitFor((message) =>
      message.type === "dispatch" &&
      message.event.type === "chat.created" &&
      message.event.chat.id === chatId
    );
    await invitedV2.waitFor((message) =>
      message.type === "dispatch" &&
      message.event.type === "chat.member.changed" &&
      message.event.change === "added"
    );

    const remove = await app.inject({
      method: "DELETE",
      url: `/v1/chats/${chatId}/members/${invited.id}`,
      headers: auth(owner),
      payload: { expectedRevision: 1, clientNonce: randomUUID() }
    });
    expect(remove.statusCode).toBe(200);
    const removedEvent = await invitedV2.waitFor((message) =>
      message.type === "dispatch" &&
      message.event.type === "chat.member.changed" &&
      message.event.audience === "removed_account" &&
      message.event.change === "removed"
    );
    expect(removedEvent.event.membership.revision).toBe(2);

    const denied = await app.inject({
      method: "GET",
      url: `/v1/chats/${chatId}`,
      headers: auth(invited)
    });
    expect(denied.statusCode).toBe(404);

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(memberV1.messages.some((message) =>
      message.type === "dispatch" && message.event?.type === "chat.member.changed"
    )).toBe(false);
  });

  it("replays removal across re-add without reviving an old-lifecycle active draft", async () => {
    app = await buildApp({
      config: testConfig({
        dataEncryptionKeys: {
          membership_replay: Buffer.alloc(32, 82).toString("base64url")
        },
        activeDataEncryptionKeyId: "membership_replay"
      }),
      logger: false
    });
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    const owner = await register("membership_replay_owner");
    const member = await register("membership_replay_member");
    const outsider = await register("membership_replay_outsider");
    await establishAcceptedRelationship(app, owner, member);
    const chatId = await createGroup(owner, [member.id]);

    const memberAtBoundary = await connectWithReady(address, member, 2);
    const outsiderAtBoundary = await connectWithReady(address, outsider, 2);
    expect(memberAtBoundary.ready.cursor).toEqual(expect.any(String));
    expect(outsiderAtBoundary.ready.cursor).toEqual(expect.any(String));
    for (const { client } of [memberAtBoundary, outsiderAtBoundary]) {
      const closed = new Promise<void>((resolve) => client.socket.once("close", () => resolve()));
      client.socket.close();
      await closed;
    }

    const oldDraftText = "OLD_LIFECYCLE_DIRTY_DRAFT_CANARY";
    const futureDraftClock = new Date(Date.now() + 60_000).toISOString();
    const putDraft = await withFixedClock(futureDraftClock, () => app!.inject({
      method: "PUT",
      url: `/v1/chats/${chatId}/draft`,
      headers: auth(member),
      payload: {
        text: oldDraftText,
        expectedRevision: 0,
        clientNonce: randomUUID()
      }
    }));
    expect(putDraft.statusCode, putDraft.body).toBe(200);
    const oldDraftChangedAt = putDraft.json().draft.updatedAt as string;

    const remove = await app.inject({
      method: "DELETE",
      url: `/v1/chats/${chatId}/members/${member.id}`,
      headers: auth(owner),
      payload: { expectedRevision: 1, clientNonce: randomUUID() }
    });
    expect(remove.statusCode, remove.body).toBe(200);
    const removedMembership = ChatMembershipMutationResponseSchema.parse(remove.json()).membership;
    const removedStoredEvent = app.luxora.store.replayEvents(
      member.id,
      memberAtBoundary.ready.sequence as number,
      app.luxora.store.getLatestSequence(),
      20
    ).find(({ event }) =>
      event.type === "chat.member.changed" && event.audience === "removed_account"
    );
    expect(removedStoredEvent).toBeDefined();

    // A deliberately misaddressed durable row proves replay authorization
    // remains bound to the removed account instead of trusting the row target.
    app.luxora.store.appendEvent(
      outsider.id,
      removedStoredEvent!.event,
      removedStoredEvent!.createdAt
    );

    const readd = await app.inject({
      method: "POST",
      url: `/v1/chats/${chatId}/members`,
      headers: auth(owner),
      payload: {
        userId: member.id,
        role: "member",
        clientNonce: randomUUID()
      }
    });
    expect(readd.statusCode, readd.body).toBe(201);
    const readdedMembership = ChatMembershipMutationResponseSchema.parse(readd.json()).membership;
    expect(Date.parse(removedMembership.updatedAt)).toBeLessThan(
      Date.parse(readdedMembership.joinedAt)
    );
    expect(Date.parse(oldDraftChangedAt)).toBeGreaterThan(
      Date.parse(readdedMembership.joinedAt)
    );

    const postReaddDraftText = "POST_READD_ROLLBACK_DRAFT_CANARY";
    const postReaddDraft = await withFixedClock("2001-01-01T00:00:00.000Z", () => app!.inject({
      method: "PUT",
      url: `/v1/chats/${chatId}/draft`,
      headers: auth(member),
      payload: {
        text: postReaddDraftText,
        expectedRevision: 2,
        clientNonce: randomUUID()
      }
    }));
    expect(postReaddDraft.statusCode, postReaddDraft.body).toBe(200);
    const postReaddChangedAt = postReaddDraft.json().draft.updatedAt as string;
    expect(Date.parse(postReaddChangedAt)).toBeGreaterThan(
      Date.parse(readdedMembership.joinedAt)
    );

    const resumedMember = await connectWithReady(address, member, 2, {
      resumeCursor: memberAtBoundary.ready.cursor as string
    });
    expect(resumedMember.ready).toMatchObject({ resumed: true, resumeMode: "scoped_cursor" });
    await resumedMember.client.waitFor((message) => message.type === "sync.checkpoint");
    const memberDispatches = resumedMember.client.messages.filter((message) =>
      message.type === "dispatch"
    );
    expect(JSON.stringify(memberDispatches)).not.toContain(oldDraftText);
    const activeDraftEvents = memberDispatches.filter((message) =>
      message.event.type === "chat.draft.changed" && message.event.draft !== null
    );
    expect(activeDraftEvents).toHaveLength(1);
    expect(activeDraftEvents[0]).toMatchObject({
      event: {
        accountId: member.id,
        chatId,
        draft: { text: postReaddDraftText, updatedAt: postReaddChangedAt },
        changedAt: postReaddChangedAt
      }
    });

    const removedEvent = memberDispatches.find((message) =>
      message.event.type === "chat.member.changed" &&
      message.event.audience === "removed_account" &&
      message.event.change === "removed"
    );
    const tombstoneEvent = memberDispatches.find((message) =>
      message.event.type === "chat.draft.changed" && message.event.draft === null
    );
    const addedEvent = memberDispatches.find((message) =>
      message.event.type === "chat.member.changed" &&
      message.event.audience === "member_account" &&
      message.event.change === "added" &&
      message.event.membership.revision === readdedMembership.revision
    );
    expect(removedEvent).toMatchObject({
      event: {
        membership: { userId: member.id, revision: removedMembership.revision },
        changedAt: removedMembership.updatedAt
      }
    });
    expect(tombstoneEvent).toMatchObject({
      event: { accountId: member.id, chatId, draft: null }
    });
    expect(addedEvent).toMatchObject({
      event: {
        membership: {
          userId: member.id,
          revision: readdedMembership.revision,
          joinedAt: readdedMembership.joinedAt
        }
      }
    });
    expect(removedEvent.sequence).toBeLessThan(tombstoneEvent.sequence);
    expect(tombstoneEvent.sequence).toBeLessThan(addedEvent.sequence);
    expect(addedEvent.sequence).toBeLessThan(activeDraftEvents[0].sequence);

    const resumedOutsider = await connectWithReady(address, outsider, 2, {
      resumeCursor: outsiderAtBoundary.ready.cursor as string
    });
    expect(resumedOutsider.ready).toMatchObject({ resumed: true, resumeMode: "scoped_cursor" });
    await resumedOutsider.client.waitFor((message) => message.type === "sync.checkpoint");
    const outsiderFrames = JSON.stringify(resumedOutsider.client.messages);
    expect(outsiderFrames).not.toContain(chatId);
    expect(outsiderFrames).not.toContain(oldDraftText);
    expect(outsiderFrames).not.toContain(postReaddDraftText);
    expect(resumedOutsider.client.messages.some((message) =>
      message.type === "dispatch" && message.event?.type === "chat.member.changed"
    )).toBe(false);

    const activeSequence = activeDraftEvents[0].sequence as number;
    const latestActiveStoredEvent = app.luxora.store.replayEvents(
      member.id,
      activeSequence - 1,
      activeSequence,
      1
    )[0];
    expect(latestActiveStoredEvent?.sequence).toBe(activeSequence);
    resumedMember.client.messages.length = 0;
    const authorizationFailureClosed = new Promise<number>((resolve) =>
      resumedMember.client.socket.once("close", resolve)
    );
    const currentDraftRead = vi.spyOn(app.luxora.store, "getChatDraft")
      .mockImplementation(() => { throw new Error("synthetic current draft read outage"); });
    try {
      expect(() => app!.luxora.hub.publish([latestActiveStoredEvent!])).not.toThrow();
    } finally {
      currentDraftRead.mockRestore();
    }
    expect(await authorizationFailureClosed).toBe(1011);
    expect(resumedMember.client.messages.some((message) =>
      message.type === "dispatch" || message.type === "sync.checkpoint"
    )).toBe(false);
  });
});
