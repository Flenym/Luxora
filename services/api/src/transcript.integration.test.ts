import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { LuxoraApp } from "./app.js";
import { buildApp } from "./app.js";
import { testConfig } from "./test-helpers.js";

const DATA_KEY = Buffer.alloc(32, 61).toString("base64url");

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function wavBytes(): Buffer {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(4_096 + 36, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(8_000, 24);
  header.writeUInt32LE(8_000, 28);
  header.writeUInt16LE(1, 32);
  header.writeUInt16LE(8, 34);
  header.write("data", 36);
  header.writeUInt32LE(4_096, 40);
  return Buffer.concat([header, Buffer.alloc(4_096, 7)]);
}

describe("voice message transcription consent", () => {
  let app: LuxoraApp | undefined;
  const temporaryRoots: string[] = [];

  afterEach(async () => {
    await app?.close();
    app = undefined;
    await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  async function boot(): Promise<void> {
    const key = DATA_KEY;
    const storageRoot = await mkdtemp(join(tmpdir(), "luxora-transcript-test-"));
    temporaryRoots.push(storageRoot);
    app = await buildApp({
      config: testConfig({
        dataEncryptionKeys: { test: key },
        activeDataEncryptionKeyId: "test",
        storageLocalPath: join(storageRoot, "blobs"),
        uploadStagingPath: join(storageRoot, "uploads")
      }),
      logger: false
    });
  }

  async function register(username: string): Promise<{ id: string; accessToken: string }> {
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

  async function uploadVoice(
    identity: { accessToken: string },
    metadata: Record<string, unknown> = { durationMs: 5_000, waveform: [10, 200] }
  ): Promise<string> {
    const bytes = wavBytes();
    const created = await app!.inject({
      method: "POST",
      url: "/v1/uploads",
      headers: { authorization: `Bearer ${identity.accessToken}` },
      payload: {
        kind: "voice",
        fileName: "note.wav",
        mimeType: "audio/wav",
        sizeBytes: bytes.length,
        sha256: sha256(bytes),
        idempotencyKey: randomUUID(),
        metadata
      }
    });
    expect(created.statusCode, created.body).toBe(201);
    const id = created.json().upload.id as string;
    const chunk = await app!.inject({
      method: "PUT",
      url: `/v1/uploads/${id}/chunks/0`,
      headers: {
        authorization: `Bearer ${identity.accessToken}`,
        "content-type": "application/octet-stream",
        "content-length": String(bytes.length),
        "content-range": `bytes 0-${bytes.length - 1}/${bytes.length}`,
        "x-chunk-sha256": sha256(bytes)
      },
      payload: bytes
    });
    expect(chunk.statusCode, chunk.body).toBe(200);
    const completed = await app!.inject({
      method: "POST",
      url: `/v1/uploads/${id}/complete`,
      headers: { authorization: `Bearer ${identity.accessToken}` }
    });
    expect(completed.statusCode, completed.body).toBe(200);
    return completed.json().upload.attachment.id as string;
  }

  it("attaches a receiver transcript only to consenting voice messages, once", async () => {
    await boot();
    const alice = await register("transcript_alice");
    const bob = await register("transcript_bob");
    const aliceHeaders = { authorization: `Bearer ${alice.accessToken}` };
    const bobHeaders = { authorization: `Bearer ${bob.accessToken}` };

    const attachmentId = await uploadVoice(alice);

    const chat = await app!.inject({
      method: "POST",
      url: "/v1/chats",
      headers: aliceHeaders,
      payload: { kind: "direct", userId: bob.id }
    });
    expect(chat.statusCode, chat.body).toBe(201);
    const chatId = chat.json().chat.id as string;

    const sent = await app!.inject({
      method: "POST",
      url: `/v1/chats/${chatId}/messages`,
      headers: aliceHeaders,
      payload: {
        body: null,
        clientNonce: randomUUID(),
        replyToMessageId: null,
        topicId: null,
        attachmentIds: [attachmentId],
        transcriptionConsent: true
      }
    });
    expect(sent.statusCode, sent.body).toBe(201);
    expect(sent.json().message).toMatchObject({
      transcriptionAllowed: true,
      transcript: null
    });
    const messageId = sent.json().message.id as string;

    const transcriptPayload = {
      text: "Привет, это расшифровка голосового.",
      clientNonce: randomUUID()
    };
    const attached = await app!.inject({
      method: "PUT",
      url: `/v1/messages/${messageId}/transcript`,
      headers: bobHeaders,
      payload: transcriptPayload
    });
    expect(attached.statusCode, attached.body).toBe(200);
    expect(attached.json().message.transcript).toBe(transcriptPayload.text);

    const replayed = await app!.inject({
      method: "PUT",
      url: `/v1/messages/${messageId}/transcript`,
      headers: bobHeaders,
      payload: transcriptPayload
    });
    expect(replayed.statusCode, replayed.body).toBe(200);
    expect(replayed.json().message.transcript).toBe(transcriptPayload.text);

    const conflicting = await app!.inject({
      method: "PUT",
      url: `/v1/messages/${messageId}/transcript`,
      headers: bobHeaders,
      payload: { text: "Другой текст.", clientNonce: randomUUID() }
    });
    expect(conflicting.statusCode, conflicting.body).toBe(409);

    const nonceConflict = await app!.inject({
      method: "PUT",
      url: `/v1/messages/${messageId}/transcript`,
      headers: bobHeaders,
      payload: { text: "Третий текст.", clientNonce: transcriptPayload.clientNonce }
    });
    expect(nonceConflict.statusCode, nonceConflict.body).toBe(409);

    const listed = await app!.inject({
      method: "GET",
      url: `/v1/chats/${chatId}/messages?limit=10`,
      headers: aliceHeaders
    });
    expect(listed.json().items[0]).toMatchObject({ transcript: transcriptPayload.text });

    const plain = await app!.inject({
      method: "POST",
      url: `/v1/chats/${chatId}/messages`,
      headers: aliceHeaders,
      payload: {
        body: "Просто текст",
        clientNonce: randomUUID(),
        replyToMessageId: null,
        topicId: null,
        attachmentIds: []
      }
    });
    expect(plain.statusCode, plain.body).toBe(201);
    const denied = await app!.inject({
      method: "PUT",
      url: `/v1/messages/${plain.json().message.id as string}/transcript`,
      headers: bobHeaders,
      payload: { text: "Нельзя.", clientNonce: randomUUID() }
    });
    expect(denied.statusCode, denied.body).toBe(403);
    expect(denied.json().error.details).toEqual({ reason: "transcript_unavailable" });

    const oversized = await app!.inject({
      method: "PUT",
      url: `/v1/messages/${messageId}/transcript`,
      headers: aliceHeaders,
      payload: { text: "x".repeat(2_001), clientNonce: randomUUID() }
    });
    expect(oversized.statusCode, oversized.body).toBe(400);

    const consentWithoutAttachments = await app!.inject({
      method: "POST",
      url: `/v1/chats/${chatId}/messages`,
      headers: aliceHeaders,
      payload: {
        body: "Текст с согласием",
        clientNonce: randomUUID(),
        replyToMessageId: null,
        topicId: null,
        attachmentIds: [],
        transcriptionConsent: true
      }
    });
    expect(consentWithoutAttachments.statusCode, consentWithoutAttachments.body).toBe(400);
  }, 60_000);
});
