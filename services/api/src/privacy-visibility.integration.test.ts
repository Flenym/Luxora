import { createHash, randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import type { LuxoraApp } from "./app.js";
import { buildApp } from "./app.js";
import { testConfig } from "./test-helpers.js";

const DATA_KEY = Buffer.alloc(32, 67).toString("base64url");

function httpConfig() {
  return testConfig({
    dataEncryptionKeys: { test: DATA_KEY },
    activeDataEncryptionKeyId: "test"
  });
}

async function register(app: LuxoraApp, username: string): Promise<{ id: string; accessToken: string }> {
  const response = await app.inject({
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

function auth(identity: { accessToken: string }): { authorization: string } {
  return { authorization: `Bearer ${identity.accessToken}` };
}

describe("privacy visibility policies", () => {
  let app: LuxoraApp | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it("stores every visibility policy and enforces photo, forward and voice gates", async () => {
    app = await buildApp({ config: httpConfig(), logger: false });
    const alice = await register(app, "policy_alice");
    const bob = await register(app, "policy_bob");

    const defaults = await app.inject({
      method: "GET",
      url: "/v1/privacy",
      headers: auth(alice)
    });
    expect(defaults.statusCode).toBe(200);
    expect(defaults.json().settings).toMatchObject({
      lastSeen: "everyone",
      profilePhoto: "everyone",
      forwards: "everyone",
      voiceMessages: "everyone",
      calls: "everyone"
    });

    const patched = await app.inject({
      method: "PATCH",
      url: "/v1/privacy",
      headers: auth(alice),
      payload: {
        lastSeen: "nobody",
        profilePhoto: "contacts",
        forwards: "nobody",
        voiceMessages: "contacts",
        calls: "contacts"
      }
    });
    expect(patched.statusCode, patched.body).toBe(200);
    expect(patched.json().settings).toMatchObject({
      lastSeen: "nobody",
      profilePhoto: "contacts",
      forwards: "nobody",
      voiceMessages: "contacts",
      calls: "contacts"
    });

    const invalid = await app.inject({
      method: "PATCH",
      url: "/v1/privacy",
      headers: auth(alice),
      payload: { lastSeen: "everyone-except" }
    });
    expect(invalid.statusCode).toBe(400);

    const empty = await app.inject({
      method: "PATCH",
      url: "/v1/privacy",
      headers: auth(alice),
      payload: {}
    });
    expect(empty.statusCode).toBe(400);

    // Strangers see no avatar and no last-seen timestamp.
    const lookup = await app.inject({
      method: "GET",
      url: "/v1/users/lookup?username=policy_alice",
      headers: auth(bob)
    });
    expect(lookup.statusCode).toBe(200);
    expect(lookup.json().profile.avatarUrl).toBeNull();
    expect(lookup.json().profile.lastSeenAt ?? null).toBeNull();

    // Direct delivery still works: strangers are allowed by default.
    const chat = await app.inject({
      method: "POST",
      url: "/v1/chats",
      headers: auth(bob),
      payload: { kind: "direct", userId: alice.id }
    });
    expect(chat.statusCode, chat.body).toBe(201);
    const chatId = chat.json().chat.id as string;

    const sent = await app.inject({
      method: "POST",
      url: `/v1/chats/${chatId}/messages`,
      headers: auth(alice),
      payload: { body: "Секрет Алисы", clientNonce: randomUUID(), replyToMessageId: null, topicId: null, attachmentIds: [] }
    });
    expect(sent.statusCode, sent.body).toBe(201);
    const messageId = sent.json().message.id as string;

    // Forwards of a strangers-excluded author's message arrive anonymously.
    const forwarded = await app.inject({
      method: "POST",
      url: `/v1/messages/${messageId}/forward`,
      headers: auth(bob),
      payload: { chatId, clientNonce: randomUUID(), topicId: null }
    });
    expect(forwarded.statusCode, forwarded.body).toBe(201);
    expect(forwarded.json().message.forwardedFrom).toBeNull();

    // A voice note to a contacts-only recipient is refused for strangers.
    const wavHeader = Buffer.alloc(44);
    wavHeader.write("RIFF", 0);
    wavHeader.writeUInt32LE(4_096 + 36, 4);
    wavHeader.write("WAVE", 8);
    wavHeader.write("fmt ", 12);
    wavHeader.writeUInt32LE(16, 16);
    wavHeader.writeUInt16LE(1, 20);
    wavHeader.writeUInt16LE(1, 22);
    wavHeader.writeUInt32LE(8_000, 24);
    wavHeader.writeUInt32LE(8_000, 28);
    wavHeader.writeUInt16LE(1, 32);
    wavHeader.writeUInt16LE(8, 34);
    wavHeader.write("data", 36);
    wavHeader.writeUInt32LE(4_096, 40);
    const voiceBytes = Buffer.concat([wavHeader, Buffer.alloc(4_096, 7)]);
    const voiceCreated = await app.inject({
      method: "POST",
      url: "/v1/uploads",
      headers: auth(bob),
      payload: {
        kind: "voice",
        fileName: "note.wav",
        mimeType: "audio/wav",
        sizeBytes: voiceBytes.length,
        sha256: createHash("sha256").update(voiceBytes).digest("hex"),
        idempotencyKey: randomUUID(),
        metadata: { durationMs: 1_000, waveform: [5] }
      }
    });
    expect(voiceCreated.statusCode, voiceCreated.body).toBe(201);
    const voiceUploadId = voiceCreated.json().upload.id as string;
    const voiceChunk = await app.inject({
      method: "PUT",
      url: `/v1/uploads/${voiceUploadId}/chunks/0`,
      headers: {
        authorization: `Bearer ${bob.accessToken}`,
        "content-type": "application/octet-stream",
        "content-length": String(voiceBytes.length),
        "content-range": `bytes 0-${voiceBytes.length - 1}/${voiceBytes.length}`,
        "x-chunk-sha256": createHash("sha256").update(voiceBytes).digest("hex")
      },
      payload: voiceBytes
    });
    expect(voiceChunk.statusCode, voiceChunk.body).toBe(200);
    const voiceCompleted = await app.inject({
      method: "POST",
      url: `/v1/uploads/${voiceUploadId}/complete`,
      headers: auth(bob)
    });
    expect(voiceCompleted.statusCode, voiceCompleted.body).toBe(200);
    const voiceAttachmentId = voiceCompleted.json().upload.attachment.id as string;

    const voiceDenied = await app.inject({
      method: "POST",
      url: `/v1/chats/${chatId}/messages`,
      headers: auth(bob),
      payload: {
        body: null,
        clientNonce: randomUUID(),
        replyToMessageId: null,
        topicId: null,
        attachmentIds: [voiceAttachmentId]
      }
    });
    expect(voiceDenied.statusCode, voiceDenied.body).toBe(403);
    expect(voiceDenied.json().error.details).toEqual({ reason: "voice_messages_unavailable" });
  }, 30_000);
});
