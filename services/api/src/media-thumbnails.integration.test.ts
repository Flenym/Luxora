import { createHash, randomUUID } from "node:crypto";
import { gunzip } from "node:zlib";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import sharp from "sharp";
import type { LuxoraApp } from "./app.js";
import { buildApp } from "./app.js";
import { testConfig } from "./test-helpers.js";

const DATA_KEY = Buffer.alloc(32, 62).toString("base64url");
const BLOCK_SIZE = 512;

interface Identity {
  id: string;
  accessToken: string;
}

const TINY_PNG = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
  0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
  0x89, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x44, 0x41,
  0x54, 0x08, 0x1d, 0x01, 0x1f, 0x00, 0xe0, 0xff,
  0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44,
  0xae, 0x42, 0x60, 0x82
]);

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

async function bigPng(): Promise<Buffer> {
  return sharp({
    create: { width: 640, height: 480, channels: 3, background: { r: 200, g: 30, b: 40 } }
  }).png().toBuffer();
}

describe("media thumbnails", () => {
  let app: LuxoraApp | undefined;
  const temporaryRoots: string[] = [];

  afterEach(async () => {
    await app?.close();
    app = undefined;
    await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  async function boot(): Promise<void> {
    const storageRoot = await mkdtemp(join(tmpdir(), "luxora-thumbnails-"));
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

  async function uploadBytes(
    identity: Identity,
    kind: string,
    fileName: string,
    mimeType: string,
    bytes: Buffer
  ): Promise<{ attachmentId: string; attachment: Record<string, unknown> }> {
    const digest = sha256(bytes);
    const upload = await app!.inject({
      method: "POST",
      url: "/v1/uploads",
      headers: auth(identity),
      payload: {
        kind,
        fileName,
        mimeType,
        sizeBytes: bytes.length,
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
        "content-range": `bytes 0-${bytes.length - 1}/${bytes.length}`,
        "content-length": String(bytes.length),
        "x-chunk-sha256": digest
      },
      payload: bytes
    });
    expect(chunk.statusCode, chunk.body).toBe(200);
    const complete = await app!.inject({
      method: "POST",
      url: `/v1/uploads/${uploadId}/complete`,
      headers: auth(identity)
    });
    expect(complete.statusCode, complete.body).toBe(200);
    const attachment = complete.json().upload.attachment as Record<string, unknown>;
    return { attachmentId: attachment["id"] as string, attachment };
  }

  it("generates a bounded JPEG thumbnail for large images and serves it to authorized users", async () => {
    await boot();
    const alice = await register("alice_thumb");
    const stranger = await register("mallory_thumb");
    const source = await bigPng();
    const { attachmentId, attachment } = await uploadBytes(alice, "image", "photo.png", "image/png", source);

    expect(attachment["thumbnailPath"]).toBe(`/v1/attachments/${attachmentId}/thumbnail`);
    const metadata = attachment["metadata"] as Record<string, unknown>;
    expect(metadata["width"]).toBe(640);
    expect(metadata["height"]).toBe(480);
    const thumbnailMeta = metadata["thumbnail"] as Record<string, unknown>;
    expect(thumbnailMeta["width"]).toBe(320);
    expect(thumbnailMeta["height"]).toBe(240);

    const served = await app!.inject({
      method: "GET",
      url: `/v1/attachments/${attachmentId}/thumbnail`,
      headers: auth(alice)
    });
    expect(served.statusCode, served.body).toBe(200);
    expect(served.headers["content-type"]).toContain("image/jpeg");
    expect(served.headers["cache-control"]).toContain("no-store");
    const body = Buffer.from(served.rawPayload);
    expect(body.subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]));
    expect(sha256(body)).toBe(thumbnailMeta["sha256"] as string);
    expect(body.length).toBeLessThan(source.length);
    expect(served.headers["etag"]).toBe(`"${thumbnailMeta["sha256"] as string}"`);

    const strangerGet = await app!.inject({
      method: "GET",
      url: `/v1/attachments/${attachmentId}/thumbnail`,
      headers: auth(stranger)
    });
    expect(strangerGet.statusCode).toBe(404);

    const unauthenticated = await app!.inject({
      method: "GET",
      url: `/v1/attachments/${attachmentId}/thumbnail`
    });
    expect(unauthenticated.statusCode).toBe(401);
  });

  it("skips thumbnails for tiny images and non-image uploads", async () => {
    await boot();
    const alice = await register("alice_thumb_small");

    const tiny = await uploadBytes(alice, "image", "tiny.png", "image/png", TINY_PNG);
    expect(tiny.attachment["thumbnailPath"]).toBeUndefined();
    expect((await app!.inject({
      method: "GET",
      url: `/v1/attachments/${tiny.attachmentId}/thumbnail`,
      headers: auth(alice)
    })).statusCode).toBe(404);

    const text = Buffer.from("hello thumbnail-less world", "utf8");
    const file = await uploadBytes(alice, "file", "note.txt", "text/plain", text);
    expect(file.attachment["thumbnailPath"]).toBeUndefined();
    expect((await app!.inject({
      method: "GET",
      url: `/v1/attachments/${file.attachmentId}/thumbnail`,
      headers: auth(alice)
    })).statusCode).toBe(404);
  });

  it("includes the thumbnail binary in the data export archive", async () => {
    await boot();
    const alice = await register("alice_thumb_export");
    const source = await bigPng();
    const { attachmentId } = await uploadBytes(alice, "image", "exported.png", "image/png", source);

    const request = await app!.inject({
      method: "POST",
      url: "/v1/data-exports",
      headers: auth(alice),
      payload: {}
    });
    expect(request.statusCode, request.body).toBe(201);
    const exportId = request.json().dataExport.id as string;

    const download = await app!.inject({
      method: "GET",
      url: `/v1/data-exports/${exportId}/download`,
      headers: auth(alice)
    });
    expect(download.statusCode).toBe(200);
    const files = parseTarFiles(await decompress(Buffer.from(download.rawPayload)));

    const thumbnailPath = `media/${attachmentId}/thumbnail.jpg`;
    expect(files.has(thumbnailPath)).toBe(true);
    const thumbnailBytes = files.get(thumbnailPath)!;
    expect(thumbnailBytes.subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]));

    const mediaRow = files.get("media.jsonl")!.toString("utf8").trim().split("\n")
      .map((line) => JSON.parse(line) as { id: string; thumbnail: { sha256: string } | null })
      .find((row) => row.id === attachmentId);
    expect(mediaRow?.thumbnail?.sha256).toBe(sha256(thumbnailBytes));

    const manifest = JSON.parse(files.get("manifest.json")!.toString("utf8")) as {
      files: Array<{ path: string; sha256: string }>;
    };
    expect(manifest.files.some((file) => file.path === thumbnailPath && file.sha256 === sha256(thumbnailBytes))).toBe(true);
  });
});
