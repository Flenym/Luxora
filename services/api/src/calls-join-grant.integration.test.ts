import { createHmac, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
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

interface GrantPayload {
  serverUrl: string;
  token: string;
  tokenExpiresAtMs: number;
  participantIdentity: string;
  turn: { urls: string[]; username: string; credential: string; expiresAtMs: number };
  call: { callId: string; revision: number; epoch: number };
}

function decodeJwtPayload(token: string): Record<string, unknown> {
  const [, payload] = token.split(".");
  return JSON.parse(Buffer.from(payload as string, "base64url").toString("utf8")) as Record<string, unknown>;
}

describe("calls join grants", () => {
  let app: LuxoraApp | undefined;
  const temporaryRoots: string[] = [];

  afterEach(async () => {
    await app?.close();
    app = undefined;
    await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  async function boot(withMediaPlane: boolean): Promise<void> {
    const storageRoot = await mkdtemp(join(tmpdir(), "luxora-grants-"));
    temporaryRoots.push(storageRoot);
    app = await buildApp({
      config: testConfig({
        dataEncryptionKeys: { test: DATA_KEY },
        activeDataEncryptionKeyId: "test",
        storageLocalPath: join(storageRoot, "blobs"),
        uploadStagingPath: join(storageRoot, "uploads"),
        ...(withMediaPlane
          ? {
              callsMediaPlane: {
                livekitUrl: "wss://calls.luxora.local",
                livekitApiKey: LIVEKIT_KEY,
                livekitApiSecret: LIVEKIT_SECRET,
                turnSharedSecret: TURN_SECRET,
                turnUrls: TURN_URLS
              }
            }
          : {})
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

  async function createRingAccept(alice: Identity, bob: Identity, chatId: string, mediaMode = "audio"): Promise<string> {
    const created = await app!.inject({
      method: "POST",
      url: "/v1/calls",
      headers: auth(alice),
      payload: { chatId, mediaMode, clientNonce: randomUUID() }
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
    return callId;
  }

  async function grant(identity: Identity, callId: string, requestedSources: string[]): Promise<{ status: number; body: unknown }> {
    const response = await app!.inject({
      method: "POST",
      url: `/v1/calls/${callId}/join-grant`,
      headers: auth(identity),
      payload: { requestedSources }
    });
    return { status: response.statusCode, body: response.json() as unknown };
  }

  it("issues a least-privilege SFU token and TURN credentials bound to epoch", async () => {
    await boot(true);
    const alice = await register("alice_grant");
    const bob = await register("bob_grant");
    const chatId = await createDirectChat(alice, bob);
    const callId = await createRingAccept(alice, bob, chatId);

    const result = await grant(bob, callId, ["microphone"]);
    expect(result.status, JSON.stringify(result.body)).toBe(200);
    const issued = result.body as GrantPayload;
    expect(issued.serverUrl).toBe("wss://calls.luxora.local");
    expect(issued.call.callId).toBe(callId);
    expect(issued.call.epoch).toBe(1);

    const claims = decodeJwtPayload(issued.token);
    expect(claims["iss"]).toBe(LIVEKIT_KEY);
    expect(typeof claims["sub"]).toBe("string");
    expect(claims["jti"]).toBeTruthy();
    expect((claims["exp"] as number) - (claims["iat"] as number)).toBe(120);
    const expirySkewMs = issued.tokenExpiresAtMs - (claims["exp"] as number) * 1000;
    expect(expirySkewMs).toBeGreaterThanOrEqual(0);
    expect(expirySkewMs).toBeLessThan(1000);
    const video = claims["video"] as Record<string, unknown>;
    expect(video["roomJoin"]).toBe(true);
    expect(video["roomCreate"]).toBe(false);
    expect(video["roomList"]).toBe(false);
    expect(video["roomAdmin"]).toBe(false);
    expect(video["roomRecord"]).toBe(false);
    expect(video["ingressAdmin"]).toBe(false);
    expect(video["canPublish"]).toBe(true);
    expect(video["canPublishData"]).toBe(false);
    expect(video["canSubscribe"]).toBe(true);
    expect(video["canUpdateOwnMetadata"]).toBe(false);
    expect(typeof video["room"]).toBe("string");
    const metadata = JSON.parse(claims["metadata"] as string) as { e: number; me: number };
    expect(metadata.e).toBe(1);

    expect(issued.participantIdentity).toBe(claims["sub"]);
    expect(issued.turn.urls).toEqual(TURN_URLS);
    const [expiry, rest] = issued.turn.username.split(":");
    expect(Number(expiry) * 1000).toBe(issued.turn.expiresAtMs);
    expect(rest).toBe(`${issued.participantIdentity}.${claims["jti"] as string}`);
    expect(issued.turn.credential).toBe(
      createHmac("sha1", TURN_SECRET).update(issued.turn.username, "utf8").digest("base64")
    );

    const raw = JSON.stringify(result.body);
    expect(raw.includes(LIVEKIT_SECRET)).toBe(false);
    expect(raw.includes(TURN_SECRET)).toBe(false);
  });

  it("rejects camera on audio calls but allows it on video calls", async () => {
    await boot(true);
    const alice = await register("alice_grant_src");
    const bob = await register("bob_grant_src");
    const chatId = await createDirectChat(alice, bob);
    const audioCallId = await createRingAccept(alice, bob, chatId, "audio");

    const denied = await grant(bob, audioCallId, ["camera"]);
    expect(denied.status).toBe(403);

    const videoCallId = await createRingAccept(alice, bob, chatId, "video");
    const allowed = await grant(bob, videoCallId, ["microphone", "camera", "screen_share"]);
    expect(allowed.status, JSON.stringify(allowed.body)).toBe(200);
    const video = decodeJwtPayload((allowed.body as GrantPayload).token)["video"] as Record<string, unknown>;
    expect(video["canPublishSources"]).toEqual(["microphone", "camera", "screen_share"]);
  });

  it("refuses grants to strangers, pre-accept states, ended calls and unconfigured planes", async () => {
    await boot(true);
    const alice = await register("alice_grant_neg");
    const bob = await register("bob_grant_neg");
    const stranger = await register("mallory_grant_neg");
    const chatId = await createDirectChat(alice, bob);

    const created = await app!.inject({
      method: "POST",
      url: "/v1/calls",
      headers: auth(alice),
      payload: { chatId, mediaMode: "audio", clientNonce: randomUUID() }
    });
    const callId = (created.json() as { call: { callId: string } }).call.callId;

    const strangerGrant = await grant(stranger, callId, ["microphone"]);
    expect(strangerGrant.status).toBe(404);

    const earlyGrant = await grant(bob, callId, ["microphone"]);
    expect(earlyGrant.status).toBe(403);

    const unknownGrant = await grant(alice, randomUUID(), ["microphone"]);
    expect(unknownGrant.status).toBe(404);

    const ring = await app!.inject({
      method: "POST",
      url: `/v1/calls/${callId}/ring`,
      headers: auth(alice),
      payload: { expectedRevision: 1 }
    });
    expect(ring.statusCode).toBe(200);
    const decline = await app!.inject({
      method: "POST",
      url: `/v1/calls/${callId}/decline`,
      headers: auth(bob),
      payload: { expectedRevision: 3, reason: "declined" }
    });
    expect(decline.statusCode).toBe(200);
    const endedGrant = await grant(bob, callId, ["microphone"]);
    expect(endedGrant.status).toBe(403);
  });

  it("answers 503 when the media plane is not configured", async () => {
    await boot(false);
    const alice = await register("alice_grant_nocfg");
    const bob = await register("bob_grant_nocfg");
    const chatId = await createDirectChat(alice, bob);
    const callId = await createRingAccept(alice, bob, chatId);
    const result = await grant(bob, callId, ["microphone"]);
    expect(result.status).toBe(503);
  });
});
