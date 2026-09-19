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

  it("rejects group chats, unknown chats, blocked peers and unreachable peers", async () => {
    await boot();
    const alice = await register("alice_call_limits");
    const bob = await register("bob_call_limits");
    const stranger = await register("mallory_call_limits");
    const chatId = await createDirectChat(alice, bob);

    const group = await app!.inject({
      method: "POST",
      url: "/v1/chats",
      headers: auth(alice),
      payload: { kind: "group", title: "No calls yet", memberIds: [bob.id] }
    });
    expect(group.statusCode, group.body).toBe(201);
    const groupCall = await createCall(alice, group.json().chat.id as string);
    expect(groupCall.status).toBe(400);

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
});
