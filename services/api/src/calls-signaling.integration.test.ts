import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { LuxoraApp } from "./app.js";
import { buildApp } from "./app.js";
import { establishAcceptedRelationship, testConfig } from "./test-helpers.js";

const DATA_KEY = Buffer.alloc(32, 62).toString("base64url");

interface Identity {
  id: string;
  accessToken: string;
}

interface CallPayload {
  callId: string;
  chatId: string;
  kind: string;
  mediaMode: string;
  state: string;
  revision: number;
  epoch: number;
  creatorMemberId: string;
  participants: Array<{
    membershipId: string;
    memberId: string;
    role: string;
    status: string;
  }>;
  endReason: string | null;
}

describe("calls signaling first slice", () => {
  let app: LuxoraApp | undefined;
  const temporaryRoots: string[] = [];

  afterEach(async () => {
    await app?.close();
    app = undefined;
    await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  async function boot(): Promise<void> {
    const storageRoot = await mkdtemp(join(tmpdir(), "luxora-calls-"));
    temporaryRoots.push(storageRoot);
    app = await buildApp({
      config: testConfig({
        dataEncryptionKeys: { test: DATA_KEY },
        activeDataEncryptionKeyId: "test",
        storageLocalPath: join(storageRoot, "blobs"),
        uploadStagingPath: join(storageRoot, "uploads")
      }),
      logger: false
    });
  }

  async function register(username: string): Promise<Identity> {
    const response = await app!.inject({
      method: "POST",
      url: "/v1/auth/register",
      payload: { username, displayName: username, password: "correct horse battery staple" }
    });
    expect(response.statusCode, response.body).toBe(201);
    return {
      id: response.json().user.id as string,
      accessToken: response.json().tokens.accessToken as string
    };
  }

  function auth(identity: Identity): { authorization: string } {
    return { authorization: `Bearer ${identity.accessToken}` };
  }

  async function createDirectChat(left: Identity, right: Identity): Promise<string> {
    await establishAcceptedRelationship(app!, left, right);
    const response = await app!.inject({
      method: "POST",
      url: "/v1/chats",
      headers: auth(left),
      payload: { kind: "direct", userId: right.id }
    });
    expect(response.statusCode, response.body).toBe(201);
    return response.json().chat.id as string;
  }

  async function createCall(identity: Identity, chatId: string, clientNonce = randomUUID()): Promise<{ status: number; body: unknown }> {
    const response = await app!.inject({
      method: "POST",
      url: "/v1/calls",
      headers: auth(identity),
      payload: { chatId, mediaMode: "audio", clientNonce }
    });
    return { status: response.statusCode, body: response.json() as unknown };
  }

  it("creates, reads and cancels a 1:1 call with idempotent retry and no internal identifiers", async () => {
    await boot();
    const alice = await register("alice_call");
    const bob = await register("bob_call");
    const chatId = await createDirectChat(alice, bob);
    const clientNonce = randomUUID();

    const first = await createCall(alice, chatId, clientNonce);
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    const created = (first.body as { call: CallPayload; replayed: boolean }).call;
    expect((first.body as { replayed: boolean }).replayed).toBe(false);
    expect((first.body as { unreachableMemberIds: string[] }).unreachableMemberIds).toEqual([]);
    expect(created.kind).toBe("one_to_one");
    expect(created.state).toBe("created");
    expect(created.revision).toBe(1);
    expect(created.creatorMemberId).toBe(alice.id);
    expect(created.endReason).toBeNull();
    expect(created.participants.map((p) => p.memberId).sort()).toEqual([alice.id, bob.id].sort());
    const host = created.participants.find((p) => p.memberId === alice.id)!;
    const invitee = created.participants.find((p) => p.memberId === bob.id)!;
    expect(host.role).toBe("host");
    expect(host.status).toBe("accepted");
    expect(invitee.role).toBe("member");
    expect(invitee.status).toBe("invited");
    const raw = JSON.stringify(created);
    expect(raw.includes("roomName")).toBe(false);
    expect(raw.includes("deviceId")).toBe(false);
    expect(raw.includes("participantIdentity")).toBe(false);
    expect(raw.includes("sessionId")).toBe(false);

    const retry = await createCall(alice, chatId, clientNonce);
    expect(retry.status).toBe(201);
    expect((retry.body as { call: CallPayload; replayed: boolean }).call.callId).toBe(created.callId);
    expect((retry.body as { replayed: boolean }).replayed).toBe(true);

    const peerRead = await app!.inject({
      method: "GET",
      url: `/v1/calls/${created.callId}`,
      headers: auth(bob)
    });
    expect(peerRead.statusCode).toBe(200);
    expect((peerRead.json() as { call: CallPayload }).call.callId).toBe(created.callId);

    const cancel = await app!.inject({
      method: "POST",
      url: `/v1/calls/${created.callId}/cancel`,
      headers: auth(alice),
      payload: { expectedRevision: 1 }
    });
    expect(cancel.statusCode, cancel.body).toBe(200);
    const cancelled = (cancel.json() as { call: CallPayload }).call;
    expect(cancelled.state).toBe("ended");
    expect(cancelled.endReason).toBe("cancelled");
    expect(cancelled.revision).toBeGreaterThan(1);

    const cancelAgain = await app!.inject({
      method: "POST",
      url: `/v1/calls/${created.callId}/cancel`,
      headers: auth(alice),
      payload: { expectedRevision: cancelled.revision }
    });
    expect(cancelAgain.statusCode).toBe(409);
  });

  it("lets the invitee hang up for a completed end and hides calls from strangers", async () => {
    await boot();
    const alice = await register("alice_hangup");
    const bob = await register("bob_hangup");
    const stranger = await register("mallory_hangup");
    const chatId = await createDirectChat(alice, bob);

    const created = await createCall(alice, chatId);
    expect(created.status).toBe(201);
    const call = (created.body as { call: CallPayload }).call;

    const strangerRead = await app!.inject({
      method: "GET",
      url: `/v1/calls/${call.callId}`,
      headers: auth(stranger)
    });
    expect(strangerRead.statusCode).toBe(404);

    const strangerCancel = await app!.inject({
      method: "POST",
      url: `/v1/calls/${call.callId}/cancel`,
      headers: auth(stranger),
      payload: { expectedRevision: 1 }
    });
    expect(strangerCancel.statusCode).toBe(404);

    const inviteeCancel = await app!.inject({
      method: "POST",
      url: `/v1/calls/${call.callId}/cancel`,
      headers: auth(bob),
      payload: { expectedRevision: 1 }
    });
    expect(inviteeCancel.statusCode).toBe(403);

    const hangup = await app!.inject({
      method: "POST",
      url: `/v1/calls/${call.callId}/hangup`,
      headers: auth(bob),
      payload: { expectedRevision: 1, scope: "self" }
    });
    expect(hangup.statusCode, hangup.body).toBe(200);
    const hungUp = (hangup.json() as { call: CallPayload }).call;
    expect(hungUp.state).toBe("ended");
    expect(hungUp.endReason).toBe("completed");

    const stale = await app!.inject({
      method: "POST",
      url: `/v1/calls/${call.callId}/hangup`,
      headers: auth(alice),
      payload: { expectedRevision: 1, scope: "self" }
    });
    expect(stale.statusCode).toBe(409);
    expect((stale.json() as { error: { details: { call: CallPayload } } }).error.details.call.revision)
      .toBe(hungUp.revision);
  });

  it("rejects unknown chats, foreign members, blocked peers and unreachable peers", async () => {
    await boot();
    const alice = await register("alice_call_limits");
    const bob = await register("bob_call_limits");
    const stranger = await register("mallory_call_limits");
    const chatId = await createDirectChat(alice, bob);

    const unknown = await createCall(alice, randomUUID());
    expect(unknown.status).toBe(404);

    const foreign = await createCall(stranger, chatId);
    expect(foreign.status).toBe(403);

    const block = await app!.inject({
      method: "PUT",
      url: `/v1/blocks/${bob.id}`,
      headers: auth(alice)
    });
    expect(block.statusCode, block.body).toBe(200);
    const blocked = await createCall(alice, chatId);
    expect(blocked.status).toBe(403);

    const carol = await register("carol_call_offline");
    const dave = await register("dave_call_offline");
    const offlineChatId = await createDirectChat(carol, dave);
    const sessions = await app!.inject({
      method: "GET",
      url: "/v1/auth/sessions",
      headers: auth(dave)
    });
    expect(sessions.statusCode).toBe(200);
    for (const session of sessions.json().items as Array<{ id: string }>) {
      const revoked = await app!.inject({
        method: "DELETE",
        url: `/v1/auth/sessions/${session.id}`,
        headers: auth(dave)
      });
      expect(revoked.statusCode).toBe(204);
    }
    const unreachable = await createCall(carol, offlineChatId);
    expect(unreachable.status).toBe(409);
  });

  it("rings a 1:1 call to ringing and converges accept and decline", async () => {
    await boot();
    const alice = await register("alice_ring");
    const bob = await register("bob_ring");
    const chatId = await createDirectChat(alice, bob);

    const created = await createCall(alice, chatId);
    expect(created.status).toBe(201);
    const call = (created.body as { call: CallPayload }).call;

    const nonHostRing = await app!.inject({
      method: "POST",
      url: `/v1/calls/${call.callId}/ring`,
      headers: auth(bob),
      payload: { expectedRevision: 1 }
    });
    expect(nonHostRing.statusCode).toBe(403);

    const staleRing = await app!.inject({
      method: "POST",
      url: `/v1/calls/${call.callId}/ring`,
      headers: auth(alice),
      payload: { expectedRevision: 0 }
    });
    expect(staleRing.statusCode).toBe(409);
    expect((staleRing.json() as { error: { details: { call: CallPayload } } }).error.details.call.revision).toBe(1);

    const ring = await app!.inject({
      method: "POST",
      url: `/v1/calls/${call.callId}/ring`,
      headers: auth(alice),
      payload: { expectedRevision: 1 }
    });
    expect(ring.statusCode, ring.body).toBe(200);
    const ringing = (ring.json() as { call: CallPayload }).call;
    expect(ringing.state).toBe("ringing");
    expect(ringing.revision).toBe(3);
    expect(ringing.participants.find((p) => p.memberId === bob.id)?.status).toBe("ringing");

    const ringAgain = await app!.inject({
      method: "POST",
      url: `/v1/calls/${call.callId}/ring`,
      headers: auth(alice),
      payload: { expectedRevision: 3 }
    });
    expect(ringAgain.statusCode).toBe(200);
    expect((ringAgain.json() as { call: CallPayload }).call.revision).toBe(3);

    const accept = await app!.inject({
      method: "POST",
      url: `/v1/calls/${call.callId}/accept`,
      headers: auth(bob),
      payload: { expectedRevision: 3 }
    });
    expect(accept.statusCode, accept.body).toBe(200);
    const accepted = (accept.json() as { call: CallPayload }).call;
    expect(accepted.state).toBe("connecting");
    expect(accepted.participants.find((p) => p.memberId === bob.id)?.status).toBe("connecting");

    const acceptAgain = await app!.inject({
      method: "POST",
      url: `/v1/calls/${call.callId}/accept`,
      headers: auth(bob),
      payload: { expectedRevision: accepted.revision }
    });
    expect(acceptAgain.statusCode).toBe(409);
  });

  it("ends a 1:1 call on decline and keeps group calls ringing for the rest", async () => {
    await boot();
    const alice = await register("alice_decline");
    const bob = await register("bob_decline");
    const chatId = await createDirectChat(alice, bob);

    const created = await createCall(alice, chatId);
    const call = (created.body as { call: CallPayload }).call;
    await app!.inject({
      method: "POST",
      url: `/v1/calls/${call.callId}/ring`,
      headers: auth(alice),
      payload: { expectedRevision: 1 }
    });

    const decline = await app!.inject({
      method: "POST",
      url: `/v1/calls/${call.callId}/decline`,
      headers: auth(bob),
      payload: { expectedRevision: 3, reason: "declined" }
    });
    expect(decline.statusCode, decline.body).toBe(200);
    const declined = (decline.json() as { call: CallPayload }).call;
    expect(declined.state).toBe("ended");
    expect(declined.endReason).toBe("declined");

    const host = await register("alice_group_ring");
    const member = await register("bob_group_ring");
    const offline = await register("carol_group_ring");
    await establishAcceptedRelationship(app!, host, member);
    await establishAcceptedRelationship(app!, host, offline);
    const group = await app!.inject({
      method: "POST",
      url: "/v1/chats",
      headers: auth(host),
      payload: { kind: "group", title: "Group ring", memberIds: [member.id, offline.id] }
    });
    expect(group.statusCode, group.body).toBe(201);
    const groupChatId = group.json().chat.id as string;

    const offlineSessions = await app!.inject({
      method: "GET",
      url: "/v1/auth/sessions",
      headers: auth(offline)
    });
    expect(offlineSessions.statusCode).toBe(200);
    for (const session of offlineSessions.json().items as Array<{ id: string }>) {
      const revoked = await app!.inject({
        method: "DELETE",
        url: `/v1/auth/sessions/${session.id}`,
        headers: auth(offline)
      });
      expect(revoked.statusCode).toBe(204);
    }

    const groupCreated = await app!.inject({
      method: "POST",
      url: "/v1/calls",
      headers: auth(host),
      payload: { chatId: groupChatId, mediaMode: "video", clientNonce: randomUUID() }
    });
    expect(groupCreated.statusCode, groupCreated.body).toBe(201);
    const groupCall = (groupCreated.json() as { call: CallPayload }).call;
    expect(groupCall.kind).toBe("group");
    expect(groupCall.mediaMode).toBe("video");
    expect((groupCreated.json() as { unreachableMemberIds: string[] }).unreachableMemberIds).toEqual([offline.id]);
    expect(groupCall.participants.map((p) => p.memberId).sort()).toEqual([host.id, member.id].sort());

    const groupRing = await app!.inject({
      method: "POST",
      url: `/v1/calls/${groupCall.callId}/ring`,
      headers: auth(host),
      payload: { expectedRevision: 1 }
    });
    expect(groupRing.statusCode, groupRing.body).toBe(200);
    expect((groupRing.json() as { call: CallPayload }).call.state).toBe("ringing");

    const groupDecline = await app!.inject({
      method: "POST",
      url: `/v1/calls/${groupCall.callId}/decline`,
      headers: auth(member),
      payload: { expectedRevision: 3, reason: "busy" }
    });
    expect(groupDecline.statusCode, groupDecline.body).toBe(200);
    const afterDecline = (groupDecline.json() as { call: CallPayload }).call;
    expect(afterDecline.state).toBe("ringing");
    expect(afterDecline.endReason).toBeNull();
    expect(afterDecline.participants.find((p) => p.memberId === member.id)?.status).toBe("declined");
  });

  it("invites chat members mid-call with host-only, reachability and fixed-1:1 guards", async () => {
    await boot();
    const host = await register("alice_invite");
    const member = await register("bob_invite");
    const latecomer = await register("carol_invite");
    const stranger = await register("mallory_invite");
    await establishAcceptedRelationship(app!, host, member);
    await establishAcceptedRelationship(app!, host, latecomer);
    const group = await app!.inject({
      method: "POST",
      url: "/v1/chats",
      headers: auth(host),
      payload: { kind: "group", title: "Invite flow", memberIds: [member.id] }
    });
    expect(group.statusCode, group.body).toBe(201);
    const groupChatId = group.json().chat.id as string;

    const created = await app!.inject({
      method: "POST",
      url: "/v1/calls",
      headers: auth(host),
      payload: { chatId: groupChatId, mediaMode: "audio", clientNonce: randomUUID() }
    });
    expect(created.statusCode, created.body).toBe(201);
    const callId = (created.json() as { call: CallPayload }).call.callId;

    const added = await app!.inject({
      method: "POST",
      url: `/v1/chats/${groupChatId}/members`,
      headers: auth(host),
      payload: { userId: latecomer.id, clientNonce: randomUUID() }
    });
    expect(added.statusCode, added.body).toBe(201);

    const ring = await app!.inject({
      method: "POST",
      url: `/v1/calls/${callId}/ring`,
      headers: auth(host),
      payload: { expectedRevision: 1 }
    });
    expect(ring.statusCode, ring.body).toBe(200);

    const invite = await app!.inject({
      method: "POST",
      url: `/v1/calls/${callId}/invite`,
      headers: auth(host),
      payload: { expectedRevision: 3, inviteeMemberId: latecomer.id }
    });
    expect(invite.statusCode, invite.body).toBe(201);
    const invited = (invite.json() as { call: CallPayload }).call;
    expect(invited.revision).toBe(4);
    expect(invited.participants.find((p) => p.memberId === latecomer.id)?.status).toBe("invited");

    const duplicate = await app!.inject({
      method: "POST",
      url: `/v1/calls/${callId}/invite`,
      headers: auth(host),
      payload: { expectedRevision: 4, inviteeMemberId: latecomer.id }
    });
    expect(duplicate.statusCode).toBe(409);

    const nonHostInvite = await app!.inject({
      method: "POST",
      url: `/v1/calls/${callId}/invite`,
      headers: auth(member),
      payload: { expectedRevision: 4, inviteeMemberId: latecomer.id }
    });
    expect(nonHostInvite.statusCode).toBe(403);

    const foreignInvite = await app!.inject({
      method: "POST",
      url: `/v1/calls/${callId}/invite`,
      headers: auth(host),
      payload: { expectedRevision: 4, inviteeMemberId: stranger.id }
    });
    expect(foreignInvite.statusCode).toBe(404);

    const strangerInvite = await app!.inject({
      method: "POST",
      url: `/v1/calls/${callId}/invite`,
      headers: auth(stranger),
      payload: { expectedRevision: 4, inviteeMemberId: latecomer.id }
    });
    expect(strangerInvite.statusCode).toBe(404);

    const offline = await register("dave_invite_offline");
    await establishAcceptedRelationship(app!, host, offline);
    const addedOffline = await app!.inject({
      method: "POST",
      url: `/v1/chats/${groupChatId}/members`,
      headers: auth(host),
      payload: { userId: offline.id, clientNonce: randomUUID() }
    });
    expect(addedOffline.statusCode, addedOffline.body).toBe(201);
    const offlineSessions = await app!.inject({
      method: "GET",
      url: "/v1/auth/sessions",
      headers: auth(offline)
    });
    expect(offlineSessions.statusCode).toBe(200);
    for (const session of offlineSessions.json().items as Array<{ id: string }>) {
      const revoked = await app!.inject({
        method: "DELETE",
        url: `/v1/auth/sessions/${session.id}`,
        headers: auth(offline)
      });
      expect(revoked.statusCode).toBe(204);
    }
    const offlineInvite = await app!.inject({
      method: "POST",
      url: `/v1/calls/${callId}/invite`,
      headers: auth(host),
      payload: { expectedRevision: 4, inviteeMemberId: offline.id }
    });
    expect(offlineInvite.statusCode).toBe(409);
  });

  it("rejects invites on fixed 1:1 membership and offline invitees", async () => {
    await boot();
    const alice = await register("alice_invite_121");
    const bob = await register("bob_invite_121");
    const chatId = await createDirectChat(alice, bob);

    const created = await createCall(alice, chatId);
    expect(created.status).toBe(201);
    const call = (created.body as { call: CallPayload }).call;

    const fixed = await app!.inject({
      method: "POST",
      url: `/v1/calls/${call.callId}/invite`,
      headers: auth(alice),
      payload: { expectedRevision: 1, inviteeMemberId: bob.id }
    });
    expect(fixed.statusCode).toBe(409);
  });
});
