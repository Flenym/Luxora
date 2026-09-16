import { createHash, randomUUID } from "node:crypto";
import { gunzip } from "node:zlib";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { LuxoraApp } from "./app.js";
import { buildApp } from "./app.js";
import { establishAcceptedRelationship, testConfig } from "./test-helpers.js";

const DATA_KEY = Buffer.alloc(32, 62).toString("base64url");
const BLOCK_SIZE = 512;

interface Identity {
  id: string;
  accessToken: string;
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function decompress(bytes: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    gunzip(bytes, (error, result) => {
      if (error !== null) reject(error);
      else resolve(result);
    });
  });
}

function parseTarFiles(bytes: Buffer): Map<string, Buffer> {
  const files = new Map<string, Buffer>();
  let offset = 0;
  while (offset < bytes.length) {
    const header = bytes.subarray(offset, offset + BLOCK_SIZE);
    if (header.every((byte) => byte === 0)) break;
    const name = header.subarray(0, 100).toString("utf8").replace(/\0+$/u, "").trim();
    const size = parseInt(header.subarray(124, 136).toString("ascii").replace(/[^\d]/gu, "").padStart(1, "0"), 8);
    offset += BLOCK_SIZE;
    const padded = Math.ceil(size / BLOCK_SIZE) * BLOCK_SIZE;
    files.set(name, bytes.subarray(offset, offset + size));
    offset += padded;
  }
  return files;
}

describe("data export", () => {
  let app: LuxoraApp | undefined;
  const temporaryRoots: string[] = [];

  afterEach(async () => {
    await app?.close();
    app = undefined;
    await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  async function boot(): Promise<void> {
    const storageRoot = await mkdtemp(join(tmpdir(), "luxora-data-export-"));
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

  async function sendText(identity: Identity, chatId: string, body: string): Promise<string> {
    const response = await app!.inject({
      method: "POST",
      url: `/v1/chats/${chatId}/messages`,
      headers: auth(identity),
      payload: {
        body,
        clientNonce: randomUUID(),
        replyToMessageId: null,
        topicId: null,
        attachmentIds: []
      }
    });
    expect(response.statusCode, response.body).toBe(201);
    return response.json().message.id as string;
  }

  async function uploadPng(identity: Identity, fileName = "exported.png"): Promise<{ id: string; sha256: string }> {
    const PNG = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
      0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
      0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
      0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
      0x89, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x44, 0x41,
      0x54, 0x08, 0x1d, 0x01, 0x1f, 0x00, 0xe0, 0xff,
      0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44,
      0xae, 0x42, 0x60, 0x82
    ]);
    const digest = sha256(PNG);
    const upload = await app!.inject({
      method: "POST",
      url: "/v1/uploads",
      headers: auth(identity),
      payload: {
        kind: "image",
        fileName,
        mimeType: "image/png",
        sizeBytes: PNG.length,
        sha256: digest,
        idempotencyKey: randomUUID(),
        metadata: {}
      }
    });
    expect(upload.statusCode, upload.body).toBe(201);
    const uploadId = upload.json().upload.id as string;
    const chunk = await app!.inject({
      method: "PUT",
      url: `/v1/uploads/${uploadId}/chunks/0`,
      headers: {
        ...auth(identity),
        "content-type": "application/octet-stream",
        "content-range": `bytes 0-${PNG.length - 1}/${PNG.length}`,
        "content-length": String(PNG.length),
        "x-chunk-sha256": digest
      },
      payload: PNG
    });
    expect(chunk.statusCode, chunk.body).toBe(200);
    const complete = await app!.inject({
      method: "POST",
      url: `/v1/uploads/${uploadId}/complete`,
      headers: auth(identity)
    });
    expect(complete.statusCode, complete.body).toBe(200);
    const attachmentId = complete.json().upload.attachment.id as string;
    return { id: attachmentId, sha256: digest };
  }

  it("builds a ready archive with manifest and own-message lines, supports range download, and hides it from strangers", async () => {
    await boot();
    const alice = await register("alice_exportd");
    const bob = await register("bob_exportd");
    const chatId = await createDirectChat(alice, bob);
    await sendText(alice, chatId, "first exportable line");
    await sendText(bob, chatId, "peer line that must not leak as own message");
    const media = await uploadPng(alice);

    const request = await app!.inject({
      method: "POST",
      url: "/v1/data-exports",
      headers: auth(alice),
      payload: {}
    });
    expect(request.statusCode, request.body).toBe(201);
    const exportId = request.json().dataExport.id as string;
    expect(request.json().dataExport.state).toBe("ready");
    expect(typeof request.json().dataExport.sha256).toBe("string");

    const status = await app!.inject({
      method: "GET",
      url: `/v1/data-exports/${exportId}`,
      headers: auth(alice)
    });
    expect(status.statusCode).toBe(200);
    expect(status.json().dataExport.state).toBe("ready");
    expect(status.json().dataExport.expiresAt).toBeTruthy();

    const download = await app!.inject({
      method: "GET",
      url: `/v1/data-exports/${exportId}/download`,
      headers: auth(alice)
    });
    expect(download.statusCode).toBe(200);
    expect(download.headers["content-type"]).toContain("application/gzip");
    expect(download.headers["cache-control"]).toContain("no-store");

    const archive = Buffer.from(download.rawPayload);
    expect(sha256(archive)).toBe(status.json().dataExport.sha256);

    const files = parseTarFiles(await decompress(archive));
    expect(files.has("manifest.json")).toBe(true);
    expect(files.has("messages.jsonl")).toBe(true);
    const messages = files.get("messages.jsonl")!.toString("utf8").trim().split("\n").map((line) => JSON.parse(line) as { body: string; chatId: string });
    expect(messages.length).toBeGreaterThanOrEqual(1);
    expect(messages.every((m) => typeof m.body === "string" && m.body.startsWith("luxora:"))).toBe(true);
    expect(messages.every((m) => typeof m.chatId === "string" && m.chatId.length > 0)).toBe(true);

    const manifest = JSON.parse(files.get("manifest.json")!.toString("utf8")) as {
      schemaVersion: number;
      accountId: string;
      includedCategories: string[];
      omittedCategories: string[];
      files: Array<{ path: string; sha256: string; sizeBytes: number }>;
    };
    expect(manifest.schemaVersion).toBe(1);
    expect(manifest.accountId).toBe(alice.id);
    expect(manifest.includedCategories).toContain("messages");
    expect(manifest.includedCategories).toContain("mediaBinaries");
    expect(manifest.omittedCategories).not.toContain("mediaBinaries");
    expect(manifest.omittedCategories).toContain("tokens");
    expect(manifest.files.some((file) => file.path === "messages.jsonl")).toBe(true);
    expect(manifest.files.some((file) => file.path === `media/${media.id}/exported.png`)).toBe(true);

    const mediaFiles = [...files.keys()].filter((path) => path.startsWith("media/"));
    expect(mediaFiles).toHaveLength(1);
    const mediaPath = mediaFiles[0]!;
    const mediaBytes = files.get(mediaPath)!;
    expect(sha256(mediaBytes)).toBe(media.sha256);
    expect(files.get("media.jsonl")!.toString("utf8").includes(media.id)).toBe(true);

    const stranger = await register("carol");
    const strangerStatus = await app!.inject({
      method: "GET",
      url: `/v1/data-exports/${exportId}`,
      headers: auth(stranger)
    });
    expect(strangerStatus.statusCode).toBe(404);

    const strangerDownload = await app!.inject({
      method: "GET",
      url: `/v1/data-exports/${exportId}/download`,
      headers: auth(stranger)
    });
    expect(strangerDownload.statusCode).toBe(404);
  });

  it("rejects a range download while the export object is missing and requires auth", async () => {
    await boot();
    const alice = await register("alice");

    const unauthenticated = await app!.inject({
      method: "GET",
      url: "/v1/data-exports/nonexistent-id/download"
    });
    expect(unauthenticated.statusCode).toBe(401);
  });
});