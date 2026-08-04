import { Readable } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";

const send = vi.hoisted(() => vi.fn());
const destroyClient = vi.hoisted(() => vi.fn());

vi.mock("@aws-sdk/client-s3", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@aws-sdk/client-s3")>();
  return {
    ...actual,
    S3Client: class {
      send = send;
      destroy = destroyClient;
    }
  };
});

import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  PutObjectCommand
} from "@aws-sdk/client-s3";
import { S3StorageProvider } from "./infrastructure/storage.js";

const KMS_ARN = "arn:aws:kms:eu-central-1:123456789012:key/00000000-0000-0000-0000-000000000000";
const SHA = "a".repeat(64);

function provider(encryption: "AES256" | "aws:kms" = "AES256"): S3StorageProvider {
  return new S3StorageProvider({
    bucket: "luxora-test",
    region: "eu-central-1",
    forcePathStyle: false,
    serverSideEncryption: encryption,
    ...(encryption === "aws:kms" ? { kmsKeyId: KMS_ARN } : {})
  });
}

describe("S3-compatible attachment storage", () => {
  beforeEach(() => {
    send.mockReset();
    destroyClient.mockReset();
  });

  it("requires the configured canonical KMS key and deletes a mismatched PUT", async () => {
    const body = new Readable({ read() {} });
    const destroy = vi.spyOn(body, "destroy");
    send.mockImplementation(async (command: unknown) => {
      if (command instanceof PutObjectCommand) {
        return {
          ServerSideEncryption: "aws:kms",
          SSEKMSKeyId: "arn:aws:kms:eu-central-1:123456789012:key/different"
        };
      }
      if (command instanceof DeleteObjectCommand) return {};
      throw new Error("unexpected command");
    });

    await expect(provider("aws:kms").put({
      objectKey: "attachments/object",
      sourceFactory: () => body,
      sizeBytes: 4,
      mimeType: "application/octet-stream",
      sha256: SHA
    })).rejects.toThrow("server-side encryption");
    const put = send.mock.calls.find(([command]) => command instanceof PutObjectCommand)?.[0] as PutObjectCommand;
    expect(put.input.ChecksumSHA256).toBe(Buffer.from(SHA, "hex").toString("base64"));
    expect(send.mock.calls.some(([command]) => command instanceof DeleteObjectCommand)).toBe(true);
    expect(destroy).toHaveBeenCalled();
  });

  it("destroys an S3 body when range or encryption validation fails", async () => {
    const body = new Readable({ read() {} });
    const destroy = vi.spyOn(body, "destroy");
    send.mockResolvedValue({
      Body: body,
      ContentLength: 99,
      ContentRange: "bytes 0-98/100",
      Metadata: { sha256: SHA },
      ServerSideEncryption: "AES256"
    });

    await expect(provider().read("attachments/object", 100, SHA, { start: 2, end: 4 }))
      .rejects.toThrow("content length");
    expect(destroy).toHaveBeenCalled();
  });

  it("validates a canonical KMS Range response before exposing its stream", async () => {
    send.mockResolvedValue({
      Body: Readable.from([Buffer.from("234")]),
      ContentLength: 3,
      ContentRange: "bytes 2-4/10",
      Metadata: { sha256: SHA },
      ServerSideEncryption: "aws:kms",
      SSEKMSKeyId: KMS_ARN
    });
    const result = await provider("aws:kms").read(
      "attachments/object",
      10,
      SHA,
      { start: 2, end: 4 }
    );
    const parts: Buffer[] = [];
    for await (const chunk of result.stream) parts.push(Buffer.from(chunk));
    expect(Buffer.concat(parts).toString("utf8")).toBe("234");
  });

  it("rejects invalid ranges before I/O and detects truncated or oversized response streams", async () => {
    const storage = provider();
    await expect(storage.read("attachments/object", 10, SHA, { start: -1, end: 2 }))
      .rejects.toThrow("byte range is invalid");
    expect(send).not.toHaveBeenCalled();

    send.mockResolvedValueOnce({
      Body: Readable.from([Buffer.from("12")]),
      ContentLength: 3,
      ContentRange: "bytes 2-4/10",
      Metadata: { sha256: SHA },
      ServerSideEncryption: "AES256"
    });
    const short = await storage.read("attachments/object", 10, SHA, { start: 2, end: 4 });
    await expect((async () => {
      for await (const _chunk of short.stream) {
        // Consume to force the post-header byte-count invariant.
      }
    })()).rejects.toThrow("ended before");

    send.mockResolvedValueOnce({
      Body: Readable.from([Buffer.from("1234")]),
      ContentLength: 3,
      ContentRange: "bytes 2-4/10",
      Metadata: { sha256: SHA },
      ServerSideEncryption: "AES256"
    });
    const long = await storage.read("attachments/object", 10, SHA, { start: 2, end: 4 });
    await expect((async () => {
      for await (const _chunk of long.stream) {
        // Consume to force the streamed overrun invariant.
      }
    })()).rejects.toThrow("exceeded");
  });

  it("rejects an unexpected partial response to a full-object GET and disposes its body", async () => {
    const body = new Readable({ read() {} });
    const destroy = vi.spyOn(body, "destroy");
    send.mockResolvedValue({
      Body: body,
      ContentLength: 10,
      ContentRange: "bytes 0-9/10",
      Metadata: { sha256: SHA },
      ServerSideEncryption: "AES256"
    });

    await expect(provider().read("attachments/object", 10, SHA))
      .rejects.toThrow("partial response");
    expect(destroy).toHaveBeenCalled();
  });

  it("uses the deterministic canary and attempts cleanup after an ambiguous PUT failure", async () => {
    send.mockImplementation(async (command: unknown) => {
      if (command instanceof HeadBucketCommand) return {};
      if (command instanceof PutObjectCommand) throw new Error("timeout after remote commit");
      if (command instanceof DeleteObjectCommand) return {};
      throw new Error("unexpected command");
    });
    const storage = provider();
    expect(await storage.ready()).toBe(false);
    const put = send.mock.calls.find(([command]) => command instanceof PutObjectCommand)?.[0] as PutObjectCommand;
    const deletion = send.mock.calls.find(([command]) => command instanceof DeleteObjectCommand)?.[0] as DeleteObjectCommand;
    expect(put.input.Key).toBe("attachments/.health/luxora-readiness-canary");
    expect(deletion.input.Key).toBe(put.input.Key);
    const commandCount = send.mock.calls.length;
    expect(await storage.ready()).toBe(false);
    expect(send).toHaveBeenCalledTimes(commandCount);
  });

  it("retries a transient failed canary after the bounded 10-second negative TTL", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(1_000);
    let available = false;
    send.mockImplementation(async (command: unknown) => {
      if (command instanceof DeleteObjectCommand) return {};
      if (command instanceof HeadBucketCommand) {
        if (!available) throw new Error("temporary outage");
        return {};
      }
      if (command instanceof PutObjectCommand) return { ServerSideEncryption: "AES256" };
      if (command instanceof GetObjectCommand) {
        return {
          Body: Readable.from([Buffer.from("L")]),
          ContentLength: 1,
          Metadata: {
            sha256: "72dfcfb0c470ac255cde83fb8fe38de8a128188e03ea5ba5b2a93adbea1062fa"
          },
          ServerSideEncryption: "AES256"
        };
      }
      throw new Error("unexpected command");
    });
    const storage = provider();
    expect(await storage.ready()).toBe(false);
    const failedProbeCalls = send.mock.calls.length;
    available = true;
    now.mockReturnValue(10_999);
    expect(await storage.ready()).toBe(false);
    expect(send).toHaveBeenCalledTimes(failedProbeCalls);
    now.mockReturnValue(11_001);
    expect(await storage.ready()).toBe(true);
    expect(send.mock.calls.length).toBeGreaterThan(failedProbeCalls);
    now.mockRestore();
  });

  it("re-probes a successful canary after the 30-second success TTL", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(1_000);
    send.mockImplementation(async (command: unknown) => {
      if (command instanceof HeadBucketCommand || command instanceof DeleteObjectCommand) return {};
      if (command instanceof PutObjectCommand) return { ServerSideEncryption: "AES256" };
      if (command instanceof GetObjectCommand) {
        return {
          Body: Readable.from([Buffer.from("L")]),
          ContentLength: 1,
          Metadata: {
            sha256: "72dfcfb0c470ac255cde83fb8fe38de8a128188e03ea5ba5b2a93adbea1062fa"
          },
          ServerSideEncryption: "AES256"
        };
      }
      throw new Error("unexpected command");
    });
    const storage = provider();
    expect(await storage.ready()).toBe(true);
    expect(send).toHaveBeenCalledTimes(4);
    now.mockReturnValue(30_999);
    expect(await storage.ready()).toBe(true);
    expect(send).toHaveBeenCalledTimes(4);
    now.mockReturnValue(31_001);
    expect(await storage.ready()).toBe(true);
    expect(send).toHaveBeenCalledTimes(8);
    now.mockRestore();
  });
});
