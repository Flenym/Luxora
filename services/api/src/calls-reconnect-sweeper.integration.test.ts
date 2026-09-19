import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SignJWT } from "jose";
import Database from "better-sqlite3";
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
}

describe("calls stale reconnecting sweep", () => {
  let app: LuxoraApp | undefined;
  const temporaryRoots: string[] = [];
  let databasePath = "";

  afterEach(async () => {
    await app?.close();
    app = undefined;
    await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  async function boot(): Promise<void> {
    const storageRoot = await mkdtemp(join(tmpdir(), "luxora-reconnect-"));
    temporaryRoots.push(storageRoot);
    databasePath = join(storageRoot, "luxora.db");
    app = await buildApp({
      config: testConfig({
        dataEncryptionKeys: { test: DATA_KEY },
        activeDataEncryptionKeyId: "test",
        databasePath,
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

  async function backdateCall(callId: string, atIso: string): Promise<void> {
    const database = new Database(databasePath);
    try {
      database.prepare("UPDATE calls SET updated_at = ? WHERE call_id = ?").run(atIso, callId);
    } finally {
      database.close();
    }
  }

  async function deliverWebhook(roomName: string, identity: string | null, event: string, id: string): Promise<number> {
    const body: Record<string, unknown> = { event, id, room: { name: roomName } };
    if (identity !== null) body["participant"] = { identity };
    const raw = Buffer.from(JSON.stringify(body), "utf8");
    const token = await new SignJWT({ sha256: createHash("sha256").update(raw).digest("base64") })
      .setProtectedHeader({ alg: "HS256", typ: "JWT" })
      .setIssuer(LIVEKIT_KEY)
      .setIssuedAt()
      .setExpirationTime(Math.floor(Date.now() / 1000) + 300)
      .sign(new TextEncoder().encode(LIVEKIT_SECRET));
    const response = await app!.inject({
      method: "POST",
      url: "/v1/internal/calls/livekit-webhook",
      headers: { "content-type": "application/webhook+json", authorization: token },
      payload: raw
    });
    return response.statusCode;
  }

  async function disconnectBob(call: { callId: string; roomName: string; bobIdentity: string }, eventId: string): Promise<void> {
    expect(await deliverWebhook(call.roomName, call.bobIdentity, "participant_joined", `${eventId}_joined`)).toBe(200);
    expect(await deliverWebhook(call.roomName, call.bobIdentity, "participant_left", `${eventId}_left`)).toBe(200);
  }

  it("ends calls stuck reconnecting past the timeout and leaves fresh calls alone", async () => {
    await boot();
    const alice = await register("alice_sweep");
    const bob = await register("bob_sweep");
    await establishAcceptedRelationship(app!, alice, bob);
    const chat = await app!.inject({
      method: "POST",
      url: "/v1/chats",
      headers: auth(alice),
      payload: { kind: "direct", userId: bob.id }
    });
    const chatId = chat.json().chat.id as string;

    async function startCall(): Promise<{ callId: string; roomName: string; bobIdentity: string }> {
      const created = await app!.inject({
        method: "POST",
        url: "/v1/calls",
        headers: auth(alice),
        payload: { chatId, mediaMode: "audio", clientNonce: randomUUID() }
      });
      expect(created.statusCode, created.body).toBe(201);
      const callId = (created.json() as { call: { callId: string } }).call.callId;
      const ring = await app!.inject({
        method: "POST",
        url: `/v1/calls/${callId}/ring`,
        headers: auth(alice),
        payload: { expectedRevision: 1 }
      });
      expect(ring.statusCode, ring.body).toBe(200);
      const accept = await app!.inject({
        method: "POST",
        url: `/v1/calls/${callId}/accept`,
        headers: auth(bob),
        payload: { expectedRevision: 3 }
      });
      expect(accept.statusCode, accept.body).toBe(200);
      const aggregate = app!.luxora.store.loadCallAggregate(callId);
      const roomName = aggregate?.roomName;
      const bobIdentity = aggregate?.participants.find((p) => p.memberId === bob.id)?.participantIdentity;
      expect(typeof roomName).toBe("string");
      expect(typeof bobIdentity).toBe("string");
      return { callId, roomName: roomName as string, bobIdentity: bobIdentity as string };
    }

    const stuck = await startCall();
    await disconnectBob(stuck, "EV_sweep_left");
    await backdateCall(stuck.callId, new Date(Date.now() - 60 * 60_000).toISOString());

    const fresh = await startCall();
    await disconnectBob(fresh, "EV_sweep_left_fresh");

    const swept = await app!.luxora.calls.sweepStaleReconnecting(new Date(), 10 * 60_000);
    expect(swept).toEqual({ ended: 1, failures: 0 });

    const stuckStatus = await app!.inject({
      method: "GET",
      url: `/v1/calls/${stuck.callId}`,
      headers: auth(alice)
    });
    expect(stuckStatus.statusCode).toBe(200);
    const stuckCall = (stuckStatus.json() as { call: CallPayload }).call;
    expect(stuckCall.state).toBe("ended");
    expect(stuckCall.endReason).toBe("network-timeout");

    const freshStatus = await app!.inject({
      method: "GET",
      url: `/v1/calls/${fresh.callId}`,
      headers: auth(alice)
    });
    expect((freshStatus.json() as { call: CallPayload }).call.state).toBe("reconnecting");

    const resweep = await app!.luxora.calls.sweepStaleReconnecting(new Date(), 10 * 60_000);
    expect(resweep).toEqual({ ended: 0, failures: 0 });
  });
});
