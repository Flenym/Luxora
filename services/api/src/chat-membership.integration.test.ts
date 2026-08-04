import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
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
    const socket = new WebSocket(`${address.replace("http", "ws")}/v${version}/realtime`);
    sockets.push(socket);
    const client = new RealtimeClient(socket);
    await new Promise<void>((resolve, reject) => {
      socket.once("open", resolve);
      socket.once("error", reject);
    });
    await client.waitFor((message) => message.type === "hello");
    client.send({ type: "authenticate", accessToken: identity.accessToken });
    await client.waitFor((message) => message.type === "ready");
    return client;
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
});
