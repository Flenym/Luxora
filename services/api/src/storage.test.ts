import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LocalStorageProvider } from "./infrastructure/storage.js";

async function consume(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const parts: Buffer[] = [];
  for await (const chunk of stream) parts.push(Buffer.from(chunk));
  return Buffer.concat(parts);
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

describe("local attachment storage", () => {
  const directories: string[] = [];

  afterEach(async () => {
    await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
  });

  it("encrypts blobs block-by-block and decrypts an exact cross-block range", async () => {
    const directory = await mkdtemp(join(tmpdir(), "luxora-storage-test-"));
    directories.push(directory);
    const source = join(directory, "source.bin");
    const plaintext = randomBytes(150_000);
    await writeFile(source, plaintext);
    const encodedKey = Buffer.alloc(32, 29).toString("base64url");
    const provider = new LocalStorageProvider(
      join(directory, "objects"),
      { test: encodedKey },
      "test"
    );

    await provider.put({
      objectKey: "attachments/user/object",
      sourcePath: source,
      sizeBytes: plaintext.length,
      mimeType: "application/octet-stream",
      sha256: sha256(plaintext)
    });

    const stored = await readFile(join(directory, "objects", "attachments", "user", "object"));
    expect(stored.subarray(0, 8).toString("ascii")).toBe("LUXBLB01");
    expect(stored.equals(plaintext)).toBe(false);

    const range = { start: 65_520, end: 65_620 };
    const result = await provider.read("attachments/user/object", plaintext.length, sha256(plaintext), range);
    expect(result.contentLength).toBe(range.end - range.start + 1);
    expect(await consume(result.stream)).toEqual(plaintext.subarray(range.start, range.end + 1));
  });

  it("supports plaintext local storage in development and byte ranges", async () => {
    const directory = await mkdtemp(join(tmpdir(), "luxora-storage-test-"));
    directories.push(directory);
    const source = join(directory, "source.txt");
    const plaintext = Buffer.from("0123456789", "utf8");
    await writeFile(source, plaintext);
    const provider = new LocalStorageProvider(join(directory, "objects"), {}, undefined);
    await provider.put({
      objectKey: "plain/object",
      sourcePath: source,
      sizeBytes: plaintext.length,
      mimeType: "text/plain",
      sha256: sha256(plaintext)
    });

    const result = await provider.read("plain/object", plaintext.length, sha256(plaintext), { start: 2, end: 5 });
    expect(await consume(result.stream)).toEqual(Buffer.from("2345"));
  });

  it("fails closed when an encrypted header or physical blob length is tampered", async () => {
    const directory = await mkdtemp(join(tmpdir(), "luxora-storage-test-"));
    directories.push(directory);
    const source = join(directory, "source.bin");
    const plaintext = randomBytes(90_000);
    await writeFile(source, plaintext);
    const provider = new LocalStorageProvider(
      join(directory, "objects"),
      { active: Buffer.alloc(32, 71).toString("base64url") },
      "active"
    );
    const objectKey = "attachments/user/tamper";
    const objectPath = join(directory, "objects", objectKey);
    await provider.put({
      objectKey,
      sourcePath: source,
      sizeBytes: plaintext.length,
      mimeType: "application/octet-stream",
      sha256: sha256(plaintext)
    });

    const encrypted = await readFile(objectPath);
    encrypted[0] = 0;
    await writeFile(objectPath, encrypted);
    await expect(provider.read(objectKey, plaintext.length, sha256(plaintext)))
      .rejects.toThrow("header is missing or invalid");

    encrypted[0] = "L".charCodeAt(0);
    encrypted[96 + 5] = (encrypted[96 + 5] as number) ^ 1;
    await writeFile(objectPath, encrypted);
    const authenticated = await provider.read(objectKey, plaintext.length, sha256(plaintext));
    await expect(consume(authenticated.stream)).rejects.toThrow();

    encrypted[96 + 5] = (encrypted[96 + 5] as number) ^ 1;
    await writeFile(objectPath, Buffer.concat([encrypted, Buffer.from([0])]));
    await expect(provider.read(objectKey, plaintext.length, sha256(plaintext)))
      .rejects.toThrow("physical size mismatch");
  });

  it("rejects invalid object paths, invalid direct ranges, and mismatched source hashes", async () => {
    const directory = await mkdtemp(join(tmpdir(), "luxora-storage-test-"));
    directories.push(directory);
    const source = join(directory, "source.txt");
    const plaintext = Buffer.from("range boundary", "utf8");
    await writeFile(source, plaintext);
    const provider = new LocalStorageProvider(join(directory, "objects"), {}, undefined);

    for (const objectKey of ["", "..", "../escape", "/tmp/escape", "safe/../../escape", "bad\0key"]) {
      await expect(provider.put({
        objectKey,
        sourcePath: source,
        sizeBytes: plaintext.length,
        mimeType: "text/plain",
        sha256: sha256(plaintext)
      })).rejects.toThrow(/object key/u);
    }

    const objectKey = "plain/boundary";
    await expect(provider.put({
      objectKey,
      sourcePath: source,
      sizeBytes: plaintext.length,
      mimeType: "text/plain",
      sha256: "0".repeat(64)
    })).rejects.toThrow("SHA-256 mismatch");
    await expect(readFile(join(directory, "objects", objectKey))).rejects.toThrow();

    await provider.put({
      objectKey,
      sourcePath: source,
      sizeBytes: plaintext.length,
      mimeType: "text/plain",
      sha256: sha256(plaintext)
    });
    for (const range of [
      { start: -1, end: 0 },
      { start: 2, end: 1 },
      { start: 0, end: plaintext.length },
      { start: Number.MAX_SAFE_INTEGER + 1, end: Number.MAX_SAFE_INTEGER + 1 }
    ]) {
      await expect(provider.read(objectKey, plaintext.length, sha256(plaintext), range))
        .rejects.toThrow("byte range is invalid");
    }
  });
});
