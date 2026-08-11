import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LuxoraApp } from "./app.js";
import { buildApp } from "./app.js";
import { establishAcceptedRelationship, testConfig } from "./test-helpers.js";

interface Identity {
  id: string;
  accessToken: string;
}

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64"
);

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

describe("resumable media uploads", () => {
  let app: LuxoraApp | undefined;
  const temporaryRoots: string[] = [];

  afterEach(async () => {
    await app?.close();
    app = undefined;
    await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  async function register(username: string): Promise<Identity> {
    const response = await app!.inject({
      method: "POST",
      url: "/v1/auth/register",
      payload: { username, displayName: username, password: "correct horse battery staple" }
    });
    const body = response.json();
    return { id: body.user.id as string, accessToken: body.tokens.accessToken as string };
  }

  async function createUpload(identity: Identity, bytes: Buffer, overrides: Record<string, unknown> = {}) {
    const idempotencyKey = randomUUID();
    const payload = {
      kind: "image",
      fileName: "pixel.png",
      mimeType: "image/png",
      sizeBytes: bytes.length,
      sha256: sha256(bytes),
      idempotencyKey,
      metadata: { width: 1, height: 1 },
      ...overrides
    };
    const response = await app!.inject({
      method: "POST",
      url: "/v1/uploads",
      headers: { authorization: `Bearer ${identity.accessToken}` },
      payload
    });
    return { response, payload, idempotencyKey };
  }

  async function putChunk(identity: Identity, uploadId: string, bytes: Buffer, digest = sha256(bytes)) {
    return app!.inject({
      method: "PUT",
      url: `/v1/uploads/${uploadId}/chunks/0`,
      headers: {
        authorization: `Bearer ${identity.accessToken}`,
        "content-type": "application/octet-stream",
        "content-length": String(bytes.length),
        "content-range": `bytes 0-${bytes.length - 1}/${bytes.length}`,
        "x-chunk-sha256": digest
      },
      payload: bytes
    });
  }

  it("validates chunks and MIME, publishes media, authorizes Range downloads, and preserves forward provenance", async () => {
    const key = Buffer.alloc(32, 41).toString("base64url");
    const storageRoot = await mkdtemp(join(tmpdir(), "luxora-media-test-"));
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
    const alice = await register("media_alice");
    const bob = await register("media_bob");
    const eve = await register("media_eve");
    const aliceHeaders = { authorization: `Bearer ${alice.accessToken}` };

    const created = await createUpload(alice, PNG);
    expect(created.response.statusCode).toBe(201);
    const uploadId = created.response.json().upload.id as string;

    const retriedCreate = await app.inject({
      method: "POST",
      url: "/v1/uploads",
      headers: aliceHeaders,
      payload: created.payload
    });
    expect(retriedCreate.statusCode).toBe(201);
    expect(retriedCreate.json().upload.id).toBe(uploadId);

    const conflictingCreate = await app.inject({
      method: "POST",
      url: "/v1/uploads",
      headers: aliceHeaders,
      payload: { ...created.payload, fileName: "different.png" }
    });
    expect(conflictingCreate.statusCode).toBe(409);

    const rejectedChunk = await putChunk(alice, uploadId, PNG, "0".repeat(64));
    expect(rejectedChunk.statusCode).toBe(400);
    expect(rejectedChunk.json().error.message).toContain("SHA-256");

    const acceptedChunk = await putChunk(alice, uploadId, PNG);
    expect(acceptedChunk.statusCode).toBe(200);
    expect(acceptedChunk.json().upload.receivedBytes).toBe(PNG.length);
    const duplicateChunk = await putChunk(alice, uploadId, PNG);
    expect(duplicateChunk.statusCode).toBe(200);
    expect(duplicateChunk.json().upload.receivedBytes).toBe(PNG.length);
    const stagedChunk = await readFile(join(storageRoot, "uploads", uploadId, "0.part"));
    expect(stagedChunk.includes(PNG)).toBe(false);
    expect(stagedChunk.toString("utf8").startsWith("luxora:v1.")).toBe(true);

    const completed = await app.inject({
      method: "POST",
      url: `/v1/uploads/${uploadId}/complete`,
      headers: aliceHeaders
    });
    expect(completed.statusCode).toBe(200);
    const attachment = completed.json().upload.attachment;
    expect(attachment).toMatchObject({
      kind: "image",
      mimeType: "image/png",
      safetyStatus: "unscanned",
      metadataTrust: "client_declared"
    });
    const attachmentId = attachment.id as string;

    const fileSearch = await app.inject({
      method: "GET",
      url: "/v1/search/files?q=pixel",
      headers: aliceHeaders
    });
    expect(fileSearch.statusCode).toBe(200);
    expect(fileSearch.json().items.map((item: { id: string }) => item.id)).toContain(attachmentId);

    const forbiddenBeforeShare = await app.inject({
      method: "GET",
      url: `/v1/attachments/${attachmentId}/content`,
      headers: { authorization: `Bearer ${eve.accessToken}`, range: "bytes=999-" }
    });
    expect(forbiddenBeforeShare.statusCode).toBe(404);
    expect(forbiddenBeforeShare.headers["content-range"]).toBeUndefined();
    expect(forbiddenBeforeShare.headers["cache-control"]).toBe("private, no-store");

    await establishAcceptedRelationship(app, alice, bob);

    const direct = await app.inject({
      method: "POST",
      url: "/v1/chats",
      headers: aliceHeaders,
      payload: { kind: "direct", userId: bob.id }
    });
    const chatId = direct.json().chat.id as string;
    const sent = await app.inject({
      method: "POST",
      url: `/v1/chats/${chatId}/messages`,
      headers: aliceHeaders,
      payload: { body: null, attachmentIds: [attachmentId], clientNonce: randomUUID() }
    });
    expect(sent.statusCode).toBe(201);
    expect(sent.json().message.kind).toBe("media");
    expect(sent.json().message.attachments[0].id).toBe(attachmentId);
    const sourceMessageId = sent.json().message.id as string;

    const range = await app.inject({
      method: "GET",
      url: `/v1/attachments/${attachmentId}/content`,
      headers: {
        authorization: `Bearer ${bob.accessToken}`,
        range: "bytes=0-7"
      }
    });
    expect(range.statusCode).toBe(206);
    expect(range.headers["content-range"]).toBe(`bytes 0-7/${PNG.length}`);
    expect(range.headers["x-content-safety-status"]).toBe("unscanned");
    expect(range.headers["content-disposition"]).toMatch(/^attachment;/u);
    expect(range.headers["cache-control"]).toBe("private, no-store");
    expect(range.rawPayload).toEqual(PNG.subarray(0, 8));
    const invalidRange = await app.inject({
      method: "GET",
      url: `/v1/attachments/${attachmentId}/content`,
      headers: { authorization: `Bearer ${bob.accessToken}`, range: "bytes=999-" }
    });
    expect(invalidRange.statusCode).toBe(416);
    expect(invalidRange.headers["content-range"]).toBe(`bytes */${PNG.length}`);

    await establishAcceptedRelationship(app, bob, eve);

    const bobToEve = await app.inject({
      method: "POST",
      url: "/v1/chats",
      headers: { authorization: `Bearer ${bob.accessToken}` },
      payload: { kind: "direct", userId: eve.id }
    });
    const targetChatId = bobToEve.json().chat.id as string;
    const forwarded = await app.inject({
      method: "POST",
      url: `/v1/messages/${sourceMessageId}/forward`,
      headers: { authorization: `Bearer ${bob.accessToken}` },
      payload: { chatId: targetChatId, clientNonce: randomUUID() }
    });
    expect(forwarded.statusCode).toBe(201);
    expect(forwarded.json().message.forwardedFrom).toMatchObject({
      senderDisplayName: "media_alice"
    });
    expect(forwarded.json().message.forwardedFrom).not.toHaveProperty("chatId");
    expect(forwarded.json().message.attachments[0].id).toBe(attachmentId);

    const eveDownload = await app.inject({
      method: "GET",
      url: `/v1/attachments/${attachmentId}/content`,
      headers: { authorization: `Bearer ${eve.accessToken}` }
    });
    expect(eveDownload.statusCode).toBe(200);
    expect(eveDownload.rawPayload).toEqual(PNG);

    const deletedSource = await app.inject({
      method: "DELETE",
      url: `/v1/messages/${sourceMessageId}`,
      headers: aliceHeaders
    });
    expect(deletedSource.statusCode).toBe(200);
    expect(deletedSource.json().message).toMatchObject({
      body: null,
      attachments: [],
      forwardedFrom: null,
      isPinned: false
    });
    expect((await app.inject({
      method: "DELETE",
      url: "/v1/auth/sessions/current",
      headers: { authorization: `Bearer ${bob.accessToken}` }
    })).statusCode).toBe(204);
    expect((await app.inject({
      method: "GET",
      url: `/v1/attachments/${attachmentId}/content`,
      headers: { authorization: `Bearer ${bob.accessToken}` }
    })).statusCode).toBe(401);

    const invalidBytes = Buffer.from("this is not an image", "utf8");
    const invalid = await createUpload(alice, invalidBytes, { fileName: "fake.png" });
    const invalidId = invalid.response.json().upload.id as string;
    expect((await putChunk(alice, invalidId, invalidBytes)).statusCode).toBe(200);
    const invalidComplete = await app.inject({
      method: "POST",
      url: `/v1/uploads/${invalidId}/complete`,
      headers: aliceHeaders
    });
    expect(invalidComplete.statusCode).toBe(400);
    const failedSession = await app.inject({
      method: "GET",
      url: `/v1/uploads/${invalidId}`,
      headers: aliceHeaders
    });
    expect(failedSession.json().upload).toMatchObject({
      status: "failed",
      failureCode: "MIME_VALIDATION_FAILED"
    });
  });

  it("reserves declared bytes so concurrent sessions cannot exceed the user quota", async () => {
    app = await buildApp({
      config: testConfig({ userStorageQuotaBytes: 10_485_760 }),
      logger: false
    });
    const alice = await register("quota_alice");
    const headers = { authorization: `Bearer ${alice.accessToken}` };
    const payload = {
      kind: "file",
      fileName: "large.zip",
      mimeType: "application/zip",
      sizeBytes: 6 * 1024 * 1024,
      sha256: "a".repeat(64),
      idempotencyKey: randomUUID(),
      metadata: {}
    };
    const first = await app.inject({ method: "POST", url: "/v1/uploads", headers, payload });
    expect(first.statusCode).toBe(201);
    const second = await app.inject({
      method: "POST",
      url: "/v1/uploads",
      headers,
      payload: { ...payload, idempotencyKey: randomUUID() }
    });
    expect(second.statusCode).toBe(413);
    expect(second.json().error.message).toContain("quota");
  });

  it("rejects chunk requests before Fastify buffers an unauthenticated oversized body", async () => {
    app = await buildApp({ config: testConfig(), logger: false });
    const oversized = Buffer.alloc(262_145, 1);
    const response = await app.inject({
      method: "PUT",
      url: `/v1/uploads/${randomUUID()}/chunks/0`,
      headers: {
        "content-type": "application/octet-stream",
        "content-length": String(oversized.length),
        "content-range": `bytes 0-${oversized.length - 1}/${oversized.length}`,
        "x-chunk-sha256": sha256(oversized)
      },
      payload: oversized
    });
    expect(response.statusCode).toBe(401);
  });

  it("resumes an out-of-order multi-chunk upload after restart", async () => {
    const root = await mkdtemp(join(tmpdir(), "luxora-upload-restart-"));
    temporaryRoots.push(root);
    const key = Buffer.alloc(32, 79).toString("base64url");
    const config = testConfig({
      databasePath: join(root, "luxora.db"),
      storageLocalPath: join(root, "blobs"),
      uploadStagingPath: join(root, "uploads"),
      dataEncryptionKeys: { active: key },
      activeDataEncryptionKeyId: "active",
      uploadChunkSizeBytes: 262_144
    });
    app = await buildApp({ config, logger: false });
    const alice = await register("restart_alice");
    let headers = { authorization: `Bearer ${alice.accessToken}` };
    const bytes = Buffer.alloc(262_144 + 137, 0);
    PNG.copy(bytes, 0);
    const created = await app.inject({
      method: "POST",
      url: "/v1/uploads",
      headers,
      payload: {
        kind: "image",
        fileName: "large-pixel.png",
        mimeType: "image/png",
        sizeBytes: bytes.length,
        sha256: sha256(bytes),
        idempotencyKey: randomUUID(),
        metadata: { width: 1, height: 1 }
      }
    });
    const uploadId = created.json().upload.id as string;
    const uploadChunk = async (index: number, chunk: Buffer, start: number) => app!.inject({
      method: "PUT",
      url: `/v1/uploads/${uploadId}/chunks/${index}`,
      headers: {
        ...headers,
        "content-type": "application/octet-stream",
        "content-length": String(chunk.length),
        "content-range": `bytes ${start}-${start + chunk.length - 1}/${bytes.length}`,
        "x-chunk-sha256": sha256(chunk)
      },
      payload: chunk
    });
    const tail = bytes.subarray(262_144);
    expect((await uploadChunk(1, tail, 262_144)).statusCode).toBe(200);
    await writeFile(join(root, "uploads", uploadId, "1.part"), "truncated");
    await app.close();
    app = undefined;

    app = await buildApp({ config, logger: false });
    const login = await app.inject({
      method: "POST",
      url: "/v1/auth/login",
      payload: {
        username: "restart_alice",
        password: "correct horse battery staple",
        deviceName: "restart test"
      }
    });
    headers = { authorization: `Bearer ${login.json().tokens.accessToken as string}` };
    const resumed = await app.inject({ method: "GET", url: `/v1/uploads/${uploadId}`, headers });
    expect(resumed.json().upload).toMatchObject({
      receivedBytes: tail.length,
      receivedChunkIndexes: [1]
    });
    expect((await uploadChunk(1, tail, 262_144)).statusCode).toBe(200);
    expect((await uploadChunk(0, bytes.subarray(0, 262_144), 0)).statusCode).toBe(200);
    const completed = await app.inject({ method: "POST", url: `/v1/uploads/${uploadId}/complete`, headers });
    expect(completed.statusCode).toBe(200);
    const attachmentId = completed.json().upload.attachment.id as string;
    const range = await app.inject({
      method: "GET",
      url: `/v1/attachments/${attachmentId}/content`,
      headers: { ...headers, range: "bytes=262140-262150" }
    });
    expect(range.statusCode).toBe(206);
    expect(range.rawPayload).toEqual(bytes.subarray(262_140, 262_151));
    await expect(readFile(join(root, "uploads", uploadId, "1.part"))).rejects.toThrow();
  });

  it("sweeps late terminal staging and never reactivates an ambiguously deleted orphan", async () => {
    const root = await mkdtemp(join(tmpdir(), "luxora-cleanup-race-"));
    temporaryRoots.push(root);
    const databasePath = join(root, "luxora.db");
    const key = Buffer.alloc(32, 83).toString("base64url");
    const config = testConfig({
      databasePath,
      storageLocalPath: join(root, "blobs"),
      uploadStagingPath: join(root, "uploads"),
      dataEncryptionKeys: { active: key },
      activeDataEncryptionKeyId: "active",
      orphanAttachmentTtlHours: 1
    });
    app = await buildApp({
      config,
      logger: false
    });
    const alice = await register("cleanup_alice");
    const headers = { authorization: `Bearer ${alice.accessToken}` };
    const created = await createUpload(alice, PNG, { fileName: "orphan.png" });
    const uploadId = created.response.json().upload.id as string;
    expect((await putChunk(alice, uploadId, PNG)).statusCode).toBe(200);
    const completed = await app.inject({ method: "POST", url: `/v1/uploads/${uploadId}/complete`, headers });
    expect(completed.statusCode, completed.body).toBe(200);
    const attachmentId = completed.json().upload.attachment.id as string;

    const lateDirectory = join(root, "uploads", uploadId);
    const lateFile = join(lateDirectory, ".late.tmp");
    await mkdir(lateDirectory, { recursive: true });
    await writeFile(lateFile, "late duplicate residue");
    await app.luxora.uploads.cleanup();
    await expect(readFile(lateFile)).rejects.toThrow();

    const database = new Database(databasePath);
    expect(database.prepare("UPDATE attachments SET created_at = ? WHERE id = ?")
      .run("2000-01-01T00:00:00.000Z", attachmentId).changes).toBe(1);
    expect(database.prepare(`
      SELECT storage_provider, linked_at, deleting_at, deleted_at, created_at
      FROM attachments WHERE id = ?
    `).get(attachmentId)).toEqual({
      storage_provider: "local",
      linked_at: null,
      deleting_at: null,
      deleted_at: null,
      created_at: "2000-01-01T00:00:00.000Z"
    });
    database.close();
    const storage = app.luxora.storage;
    const originalDelete = storage.delete.bind(storage);
    storage.delete = vi.fn().mockRejectedValue(new Error("ambiguous network failure"));
    const beforeFirstClaim = app.luxora.store.getLatestSequence();
    expect(await app.luxora.uploads.cleanup()).toMatchObject({
      orphanAttachments: 0,
      cleanupFailures: 1
    });
    const afterFirstClaim = app.luxora.store.getLatestSequence();
    expect(afterFirstClaim).toBeGreaterThan(beforeFirstClaim);
    expect(app.luxora.store.replayEvents(
      alice.id,
      beforeFirstClaim,
      afterFirstClaim,
      100
    ).map(({ event }) => event)).toEqual([
      expect.objectContaining({
        type: "sync.invalidated",
        audience: "account_projection",
        accountId: alice.id,
        reason: "attachment_removed"
      })
    ]);
    expect(app.luxora.store.listOwnedAttachments(alice.id, 100).items
      .some(({ id }) => id === attachmentId)).toBe(false);
    const hidden = await app.inject({
      method: "GET",
      url: `/v1/attachments/${attachmentId}/content`,
      headers
    });
    expect(hidden.statusCode).toBe(404);

    storage.delete = originalDelete;
    const beforeStaleRetry = app.luxora.store.getLatestSequence();
    await app.close();
    app = undefined;
    const retryDatabase = new Database(databasePath);
    expect(retryDatabase.prepare(`
      SELECT deleted_at, deleting_at FROM attachments WHERE id = ?
    `).get(attachmentId)).toMatchObject({ deleted_at: null });
    expect(retryDatabase.prepare("UPDATE attachments SET deleting_at = ? WHERE id = ?")
      .run("2000-01-01T00:00:00.000Z", attachmentId).changes).toBe(1);
    expect(retryDatabase.prepare(`
      SELECT storage_provider, linked_at, deleting_at, deleted_at, created_at
      FROM attachments WHERE id = ?
    `).get(attachmentId)).toEqual({
      storage_provider: "local",
      linked_at: null,
      deleting_at: "2000-01-01T00:00:00.000Z",
      deleted_at: null,
      created_at: "2000-01-01T00:00:00.000Z"
    });
    retryDatabase.close();
    app = await buildApp({ config, logger: false });
    const afterStaleRetry = app.luxora.store.getLatestSequence();
    expect(afterStaleRetry).toBeGreaterThan(beforeStaleRetry);
    expect(app.luxora.store.replayEvents(
      alice.id,
      beforeStaleRetry,
      afterStaleRetry,
      100
    ).map(({ event }) => event)).toEqual([
      expect.objectContaining({
        type: "sync.invalidated",
        accountId: alice.id,
        reason: "attachment_removed"
      })
    ]);
    expect((await app.inject({
      method: "GET",
      url: `/v1/attachments/${attachmentId}/content`,
      headers
    })).statusCode).toBe(404);
    expect(app.luxora.store.findAttachmentRecord(attachmentId)).toBeNull();
  });
});
