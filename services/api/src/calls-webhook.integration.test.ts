import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SignJWT } from "jose";
import type { LuxoraApp } from "./app.js";
import { buildApp } from "./app.js";
import { establishAcceptedRelationship, testConfig } from "./test-helpers.js";

const DATA_KEY = Buffer.alloc(32, 62).toString("base64url");
const LIVEKIT_KEY = "test-livekit-api-key";
const LIVEKIT_SECRET = "test-livekit-api-secret-with-32-bytes!!";
const TURN_SECRET = "test-turn-shared-secret-with-32-bytes!";
const TURN_URLS = ["turn:calls.luxora.local:3478?transport=udp"];

interface Identity {
  id: string;
  accessToken: string;
}

interface CallPayload {
  callId: string;
  state: string;
  revision: number;
  endReason: string | null;
  participants: Array<{ memberId: string; status: string; participantIdentity?: string }>;
}

describe("calls livekit webhook", () => {
  let app: LuxoraApp | undefined;
  const temporaryRoots: string[] = [];

  afterEach(async () => {
    await app?.close();
    app = undefined;
    await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  async function boot(): Promise<void> {
    const storageRoot = await mkdtemp(join(tmpdir(), "luxora-webhook-"));
    temporaryRoots.push(storageRoot);
    app = await buildApp({
      config: testConfig({
        dataEncryptionKeys: { test: DATA_KEY },
        activeDataEncryptionKeyId: "test",
        storageLocalPath: join(storageRoot, "blobs"),
        uploadStagingPath: join(storageRoot, "uploads"),
        callsMediaPlane: {
          livekitUrl: "wss://calls.luxora.local",
          livekitApiKey: LIVEKIT_KEY,
          livekitApiSecret: LIVEKIT_SECRET,
          turnSharedSecret: TURN_SECRET,
          turnUrls: TURN_URLS
        }
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

  async function signedEvent(body: Record<string, unknown>, secret = LIVEKIT_SECRET): Promise<{ raw: Buffer; authorization: string }> {
    const raw = Buffer.from(JSON.stringify(body), "utf8");
    const digest = createHash("sha256").update(raw).digest("base64");
    const token = await new SignJWT({ sha256: digest })
      .setProtectedHeader({ alg: "HS256", typ: "JWT" })
      .setIssuer(LIVEKIT_KEY)
      .setIssuedAt()
      .setExpirationTime(Math.floor(Date.now() / 1000) + 300)
      .sign(new TextEncoder().encode(secret));
    return { raw, authorization: token };
  }

  async function deliver(raw: Buffer, authorization?: string): Promise<{ status: number; body: unknown }> {
    const response = await app!.inject({
      method: "POST",
      url: "/v1/internal/calls/livekit-webhook",
      headers: {
        "content-type": "application/webhook+json",
        ...(authorization === undefined ? {} : { authorization })
      },
      payload: raw
    });
    return { status: response.statusCode, body: response.json() as unknown };
  }

  async function getCall(identity: Identity, callId: string): Promise<CallPayload> {
    const response = await app!.inject({
      method: "GET",
      url: `/v1/calls/${callId}`,
      headers: auth(identity)
    });
    expect(response.statusCode).toBe(200);
    return (response.json() as { call: CallPayload }).call;
  }

  it("confirms media facts from joined to finished without ever granting authorization", async () => {
    await boot();
    const alice = await register("alice_webhook");
    const bob = await register("bob_webhook");
    await establishAcceptedRelationship(app!, alice, bob);
    const chat = await app!.inject({
      method: "POST",
      url: "/v1/chats",
      headers: auth(alice),
      payload: { kind: "direct", userId: bob.id }
    });
    const chatId = chat.json().chat.id as string;

    const created = await app!.inject({
      method: "POST",
      url: "/v1/calls",
      headers: auth(alice),
      payload: { chatId, mediaMode: "audio", clientNonce: randomUUID() }
    });
    const callId = (created.json() as { call: CallPayload }).call.callId;
    await app!.inject({
      method: "POST",
      url: `/v1/calls/${callId}/ring`,
      headers: auth(alice),
      payload: { expectedRevision: 1 }
    });
    await app!.inject({
      method: "POST",
      url: `/v1/calls/${callId}/accept`,
      headers: auth(bob),
      payload: { expectedRevision: 3 }
    });

    const roomName = app!.luxora.store.loadCallAggregate(callId)?.roomName;
    expect(typeof roomName).toBe("string");
    const bobIdentity = (await getCall(bob, callId)).participants.find((p) => p.memberId === bob.id);
    expect(bobIdentity?.status).toBe("connecting");

    const joined = await signedEvent({
      event: "participant_joined",
      id: "EV_joined_1",
      room: { name: roomName },
      participant: { identity: "unknown-identity" }
    });
    const unknownParticipant = await deliver(joined.raw, joined.authorization);
    expect(unknownParticipant.status).toBe(200);
    expect((await getCall(bob, callId)).state).toBe("connecting");

    const bobJoined = await signedEvent({
      event: "participant_joined",
      id: "EV_joined_2",
      room: { name: roomName },
      participant: { identity: app!.luxora.store.loadCallAggregate(callId)?.participants.find((p) => p.memberId === bob.id)?.participantIdentity }
    });
    const joinedResult = await deliver(bobJoined.raw, bobJoined.authorization);
    expect(joinedResult.status).toBe(200);
    expect((joinedResult.body as { callId: string }).callId).toBe(callId);
    let call = await getCall(bob, callId);
    expect(call.state).toBe("active");
    expect(call.participants.find((p) => p.memberId === bob.id)?.status).toBe("active");

    const beforeDuplicate = (await getCall(bob, callId)).revision;
    const duplicate = await deliver(bobJoined.raw, bobJoined.authorization);
    expect(duplicate.status).toBe(200);
    expect((await getCall(bob, callId)).revision).toBe(beforeDuplicate);

    const left = await signedEvent({
      event: "participant_left",
      id: "EV_left_1",
      room: { name: roomName },
      participant: { identity: app!.luxora.store.loadCallAggregate(callId)?.participants.find((p) => p.memberId === bob.id)?.participantIdentity }
    });
    expect((await deliver(left.raw, left.authorization)).status).toBe(200);
    call = await getCall(bob, callId);
    expect(call.state).toBe("reconnecting");
    expect(call.participants.find((p) => p.memberId === bob.id)?.status).toBe("reconnecting");

    const finished = await signedEvent({
      event: "room_finished",
      id: "EV_finished_1",
      room: { name: roomName }
    });
    expect((await deliver(finished.raw, finished.authorization)).status).toBe(200);
    call = await getCall(bob, callId);
    expect(call.state).toBe("ended");
    expect(call.endReason).toBe("completed");
  });

  it("rejects forged deliveries and acknowledges unknown rooms without effect", async () => {
    await boot();
    const alice = await register("alice_webhook_neg");

    const missing = await deliver(Buffer.from("{}", "utf8"));
    expect(missing.status).toBe(401);

    const forged = await signedEvent(
      { event: "room_finished", id: "EV_x", room: { name: "nope" } },
      "wrong-secret-with-at-least-32-bytes!!!"
    );
    const forgedResult = await deliver(forged.raw, forged.authorization);
    expect(forgedResult.status).toBe(401);

    const unknown = await signedEvent({ event: "room_finished", id: "EV_y", room: { name: "no-such-room" } });
    const unknownResult = await deliver(unknown.raw, unknown.authorization);
    expect(unknownResult.status).toBe(200);
    expect(unknownResult.body).toEqual({ received: true, callId: null });

    const track = await signedEvent({
      event: "track_published",
      id: "EV_z",
      room: { name: "no-such-room-either" }
    });
    expect((await deliver(track.raw, track.authorization)).status).toBe(200);
  });
});
