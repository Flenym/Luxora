import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { LuxoraApp } from "./app.js";
import { buildApp } from "./app.js";
import { testConfig } from "./test-helpers.js";

const DATA_KEY = Buffer.alloc(32, 62).toString("base64url");

interface Identity {
  id: string;
  accessToken: string;
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function wavSeconds(seconds: number): Buffer {
  const sampleRate = 8000;
  const dataSize = sampleRate * seconds;
  const fmtPayload = Buffer.alloc(16);
  fmtPayload.writeUInt16LE(0x0001, 0);
  fmtPayload.writeUInt16LE(1, 2);
  fmtPayload.writeUInt32LE(sampleRate, 4);
  fmtPayload.writeUInt32LE(sampleRate, 8);
  fmtPayload.writeUInt16LE(1, 12);
  fmtPayload.writeUInt16LE(8, 14);
  const head = Buffer.alloc(12);
  Buffer.from("RIFF", "ascii").copy(head, 0);
  Buffer.from("WAVE", "ascii").copy(head, 8);
  const body = Buffer.concat([
    Buffer.from("fmt ", "ascii"),
    Buffer.from([16, 0, 0, 0]),
    fmtPayload,
    Buffer.from("data", "ascii"),
    Buffer.alloc(4),
    Buffer.alloc(dataSize)
  ]);
  body.writeUInt32LE(dataSize, 28);
  head.writeUInt32LE(4 + body.length, 4);
  return Buffer.concat([head, body]);
}

describe("wav duration verification", () => {
  let app: LuxoraApp | undefined;
  const temporaryRoots: string[] = [];

  afterEach(async () => {
    await app?.close();
    app = undefined;
    await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  async function boot(): Promise<void> {
    const storageRoot = await mkdtemp(join(tmpdir(), "luxora-wav-"));
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

  it("replaces a wrong client-declared duration with the measured WAV value", async () => {
    await boot();
    const alice = await register("alice_wav");
    const bytes = wavSeconds(1);
    const digest = sha256(bytes);

    const upload = await app!.inject({
      method: "POST",
      url: "/v1/uploads",
      headers: auth(alice),
      payload: {
        kind: "audio",
        fileName: "note.wav",
        mimeType: "audio/wav",
        sizeBytes: bytes.length,
        sha256: digest,
        idempotencyKey: randomUUID(),
        metadata: { durationMs: 5000, waveform: [10, 20, 30] }
      }
    });
    expect(upload.statusCode, upload.body).toBe(201);
    const uploadId = upload.json().upload.id as string;

    const chunk = await app!.inject({
      method: "PUT",
      url: `/v1/uploads/${uploadId}/chunks/0`,
      headers: {
        ...auth(alice),
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
      headers: auth(alice)
    });
    expect(complete.statusCode, complete.body).toBe(200);
    const attachment = complete.json().upload.attachment as Record<string, unknown>;
    expect(attachment["metadataTrust"]).toBe("server_verified");
    const metadata = attachment["metadata"] as Record<string, unknown>;
    expect(metadata["durationMs"]).toBe(1000);
    expect(metadata["waveform"]).toEqual([10, 20, 30]);
  });
});
