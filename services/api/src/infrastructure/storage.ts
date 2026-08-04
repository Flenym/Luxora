import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  access,
  mkdir,
  mkdtemp,
  open,
  rename,
  rm,
  unlink
} from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { Readable } from "node:stream";
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  PutObjectCommand,
  S3Client
} from "@aws-sdk/client-s3";
import type { AppConfig } from "../config.js";

const BLOB_MAGIC = Buffer.from("LUXBLB01", "ascii");
const HEADER_BYTES = 96;
const BLOCK_BYTES = 65_536;
const AUTH_TAG_BYTES = 16;

export interface ByteRange {
  start: number;
  end: number;
}

export interface StorageObjectInput {
  objectKey: string;
  sourcePath?: string;
  sourceFactory?: () => Readable;
  sizeBytes: number;
  mimeType: string;
  sha256: string;
}

export interface StorageReadResult {
  stream: Readable;
  contentLength: number;
  totalSize: number;
  range: ByteRange | null;
}

export interface StorageProvider {
  readonly name: "local" | "s3";
  put(input: StorageObjectInput): Promise<void>;
  read(objectKey: string, totalSize: number, sha256: string, range?: ByteRange): Promise<StorageReadResult>;
  delete(objectKey: string): Promise<void>;
  ready(): Promise<boolean>;
  close(): Promise<void>;
}

function safeObjectPath(root: string, objectKey: string): string {
  if (objectKey.length === 0 || objectKey.includes("\0")) {
    throw new Error("Storage object key is empty or invalid");
  }
  const candidate = resolve(root, objectKey);
  if (candidate === root || !candidate.startsWith(`${root}${sep}`)) {
    throw new Error("Storage object key escaped its configured root");
  }
  return candidate;
}

function selectedRange(totalSize: number, range?: ByteRange): ByteRange {
  if (!Number.isSafeInteger(totalSize) || totalSize <= 0) {
    throw new Error("Storage object size is invalid");
  }
  const selected = range ?? { start: 0, end: totalSize - 1 };
  if (
    !Number.isSafeInteger(selected.start) ||
    !Number.isSafeInteger(selected.end) ||
    selected.start < 0 ||
    selected.end < selected.start ||
    selected.end >= totalSize
  ) {
    throw new Error("Storage byte range is invalid");
  }
  return selected;
}

function deriveBlobKey(master: Buffer, objectKey: string): Buffer {
  return Buffer.from(hkdfSync(
    "sha256",
    master,
    Buffer.from("luxora-blob-salt-v1", "utf8"),
    Buffer.from(`luxora-blob:${objectKey}`, "utf8"),
    32
  ));
}

function openSource(input: StorageObjectInput): Readable {
  if (input.sourceFactory !== undefined) return input.sourceFactory();
  if (input.sourcePath !== undefined) return createReadStream(input.sourcePath);
  throw new Error("Storage input has no source");
}

function disposeResponseBody(body: unknown): void {
  if (body instanceof Readable) {
    body.destroy();
    return;
  }
  if (typeof body !== "object" || body === null) return;
  if ("destroy" in body && typeof body.destroy === "function") {
    body.destroy();
    return;
  }
  if ("cancel" in body && typeof body.cancel === "function") {
    void Promise.resolve(body.cancel()).catch(() => undefined);
  }
}

async function writeAll(file: FileHandle, bytes: Buffer): Promise<void> {
  let offset = 0;
  while (offset < bytes.length) {
    const { bytesWritten } = await file.write(bytes.subarray(offset));
    if (bytesWritten <= 0) throw new Error("Storage write made no progress");
    offset += bytesWritten;
  }
}

async function readInto(file: FileHandle, bytes: Buffer, position: number): Promise<number> {
  let offset = 0;
  while (offset < bytes.length) {
    const { bytesRead } = await file.read(bytes, offset, bytes.length - offset, position + offset);
    if (bytesRead === 0) break;
    offset += bytesRead;
  }
  return offset;
}

async function syncDirectory(path: string): Promise<void> {
  const directory = await open(path, "r");
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

async function* enforceStreamLength(source: Readable, expectedLength: number): AsyncGenerator<Buffer> {
  let received = 0;
  try {
    for await (const chunk of source) {
      const bytes = Buffer.from(chunk);
      received += bytes.length;
      if (received > expectedLength) throw new Error("Object store response exceeded its declared length");
      yield bytes;
    }
    if (received !== expectedLength) throw new Error("Object store response ended before its declared length");
  } finally {
    if (!source.destroyed) source.destroy();
  }
}

export class LocalStorageProvider implements StorageProvider {
  readonly name = "local" as const;
  readonly #keys = new Map<string, Buffer>();

  constructor(
    private readonly root: string,
    encodedKeys: Record<string, string>,
    private readonly activeKeyId: string | undefined,
    private readonly ephemeral = false
  ) {
    for (const [keyId, key] of Object.entries(encodedKeys)) {
      this.#keys.set(keyId, Buffer.from(key, "base64url"));
    }
  }

  async put(input: StorageObjectInput): Promise<void> {
    const destination = safeObjectPath(this.root, input.objectKey);
    await mkdir(dirname(destination), { recursive: true });
    const temporary = `${destination}.tmp-${randomUUID()}`;
    try {
      if (this.activeKeyId === undefined) {
        await this.#copySource(input, temporary);
      } else {
        await this.#encryptSource(input, temporary);
      }
      await rename(temporary, destination);
      await syncDirectory(dirname(destination));
    } catch (error) {
      await unlink(temporary).catch(() => undefined);
      throw error;
    }
  }

  async read(objectKey: string, totalSize: number, _sha256: string, range?: ByteRange): Promise<StorageReadResult> {
    const path = safeObjectPath(this.root, objectKey);
    const selected = selectedRange(totalSize, range);
    const header = Buffer.alloc(HEADER_BYTES);
    const headerFile = await open(path, "r");
    let headerBytes: number;
    let storedFileBytes: number;
    try {
      const stats = await headerFile.stat();
      if (!stats.isFile() || !Number.isSafeInteger(stats.size)) throw new Error("Storage object is not a regular file");
      storedFileBytes = stats.size;
      headerBytes = await readInto(headerFile, header, 0);
    } finally {
      await headerFile.close();
    }
    const encrypted = headerBytes >= BLOB_MAGIC.length &&
      header.subarray(0, BLOB_MAGIC.length).equals(BLOB_MAGIC);
    if (!encrypted) {
      if (this.activeKeyId !== undefined) {
        throw new Error("Encrypted blob header is missing or invalid");
      }
      if (storedFileBytes !== totalSize) throw new Error("Plaintext blob size metadata mismatch");
      return {
        stream: createReadStream(path, { start: selected.start, end: selected.end }),
        contentLength: selected.end - selected.start + 1,
        totalSize,
        range: range ?? null
      };
    }

    if (headerBytes !== HEADER_BYTES) throw new Error("Encrypted blob header is truncated");
    const storedSize = Number(header.readBigUInt64BE(12));
    if (header.readUInt32BE(8) !== BLOCK_BYTES) throw new Error("Encrypted blob block size is unsupported");
    if (storedSize !== totalSize) throw new Error("Encrypted blob size metadata mismatch");
    const keyIdLength = header.readUInt8(20);
    if (keyIdLength === 0 || keyIdLength > 64) throw new Error("Encrypted blob key id is invalid");
    const keyId = header.subarray(21, 21 + keyIdLength).toString("utf8");
    const master = this.#keys.get(keyId);
    if (master === undefined) throw new Error(`Blob encryption key '${keyId}' is unavailable`);
    const expectedFileBytes = HEADER_BYTES + totalSize + Math.ceil(totalSize / BLOCK_BYTES) * AUTH_TAG_BYTES;
    if (storedFileBytes !== expectedFileBytes) throw new Error("Encrypted blob physical size mismatch");
    const noncePrefix = header.subarray(85, 93);
    const key = deriveBlobKey(master, objectKey);
    const startBlock = Math.floor(selected.start / BLOCK_BYTES);
    const endBlock = Math.floor(selected.end / BLOCK_BYTES);
    const iterator = this.#decryptRange(
      path,
      objectKey,
      key,
      noncePrefix,
      totalSize,
      selected,
      startBlock,
      endBlock
    );
    return {
      stream: Readable.from(iterator),
      contentLength: selected.end - selected.start + 1,
      totalSize,
      range: range ?? null
    };
  }

  async delete(objectKey: string): Promise<void> {
    const path = safeObjectPath(this.root, objectKey);
    try {
      await unlink(path);
    } catch (error: unknown) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
    }
    await syncDirectory(dirname(path)).catch((error: unknown) => {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
    });
  }

  async ready(): Promise<boolean> {
    const probe = join(this.root, `.luxora-ready-${randomUUID()}`);
    try {
      await mkdir(this.root, { recursive: true });
      await access(this.root, constants.R_OK | constants.W_OK);
      const writer = await open(probe, "wx", 0o600);
      try {
        await writeAll(writer, Buffer.from([0x4c]));
        await writer.sync();
      } finally {
        await writer.close();
      }
      const reader = await open(probe, "r");
      try {
        const value = Buffer.alloc(1);
        if (await readInto(reader, value, 0) !== 1 || value[0] !== 0x4c) return false;
      } finally {
        await reader.close();
      }
      await unlink(probe);
      return true;
    } catch {
      await unlink(probe).catch(() => undefined);
      return false;
    }
  }

  async close(): Promise<void> {
    if (this.ephemeral) await rm(this.root, { recursive: true, force: true });
  }

  async #copySource(input: StorageObjectInput, destination: string): Promise<void> {
    const target = await open(destination, "wx", 0o600);
    let written = 0;
    const hash = createHash("sha256");
    try {
      for await (const chunk of openSource(input)) {
        const bytes = Buffer.from(chunk);
        written += bytes.length;
        hash.update(bytes);
        await writeAll(target, bytes);
      }
      if (written !== input.sizeBytes) throw new Error("Storage source size mismatch");
      if (hash.digest("hex") !== input.sha256) throw new Error("Storage source SHA-256 mismatch");
      await target.sync();
    } finally {
      await target.close();
    }
  }

  async #encryptSource(input: StorageObjectInput, destination: string): Promise<void> {
    const activeKeyId = this.activeKeyId as string;
    const master = this.#keys.get(activeKeyId);
    if (master === undefined) throw new Error("Active blob encryption key is unavailable");
    const keyIdBytes = Buffer.from(activeKeyId, "utf8");
    if (keyIdBytes.length > 64) throw new Error("Blob encryption key id exceeds 64 bytes");
    const noncePrefix = randomBytes(8);
    const header = Buffer.alloc(HEADER_BYTES);
    BLOB_MAGIC.copy(header, 0);
    header.writeUInt32BE(BLOCK_BYTES, 8);
    header.writeBigUInt64BE(BigInt(input.sizeBytes), 12);
    header.writeUInt8(keyIdBytes.length, 20);
    keyIdBytes.copy(header, 21);
    noncePrefix.copy(header, 85);

    const target = await open(destination, "wx", 0o600);
    const key = deriveBlobKey(master, input.objectKey);
    try {
      await writeAll(target, header);
      let received = 0;
      const hash = createHash("sha256");
      let blockIndex = 0;
      let pending = Buffer.alloc(0);
      const writeBlock = async (plaintext: Buffer): Promise<void> => {
        const nonce = Buffer.alloc(12);
        noncePrefix.copy(nonce, 0);
        nonce.writeUInt32BE(blockIndex, 8);
        const cipher = createCipheriv("aes-256-gcm", key, nonce);
        cipher.setAAD(Buffer.from(`${input.objectKey}:${blockIndex}:${input.sizeBytes}`, "utf8"));
        const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);
        await writeAll(target, encrypted);
        blockIndex += 1;
      };
      for await (const chunk of openSource(input)) {
        const bytes = Buffer.from(chunk);
        received += bytes.length;
        hash.update(bytes);
        pending = pending.length === 0 ? bytes : Buffer.concat([pending, bytes]);
        while (pending.length >= BLOCK_BYTES) {
          await writeBlock(pending.subarray(0, BLOCK_BYTES));
          pending = pending.subarray(BLOCK_BYTES);
        }
      }
      if (pending.length > 0) await writeBlock(pending);
      if (received !== input.sizeBytes) throw new Error("Storage source size mismatch");
      if (hash.digest("hex") !== input.sha256) throw new Error("Storage source SHA-256 mismatch");
      await target.sync();
    } finally {
      await target.close();
    }
  }

  async *#decryptRange(
    path: string,
    objectKey: string,
    key: Buffer,
    noncePrefix: Buffer,
    totalSize: number,
    selected: ByteRange,
    startBlock: number,
    endBlock: number
  ): AsyncGenerator<Buffer> {
    const file = await open(path, "r");
    try {
      for (let blockIndex = startBlock; blockIndex <= endBlock; blockIndex += 1) {
        const plainStart = blockIndex * BLOCK_BYTES;
        const plainLength = Math.min(BLOCK_BYTES, totalSize - plainStart);
        const encryptedLength = plainLength + AUTH_TAG_BYTES;
        const encryptedOffset = HEADER_BYTES + blockIndex * (BLOCK_BYTES + AUTH_TAG_BYTES);
        const encrypted = Buffer.allocUnsafe(encryptedLength);
        const bytesRead = await readInto(file, encrypted, encryptedOffset);
        if (bytesRead !== encryptedLength) throw new Error("Encrypted blob is truncated");
        const nonce = Buffer.alloc(12);
        noncePrefix.copy(nonce, 0);
        nonce.writeUInt32BE(blockIndex, 8);
        const decipher = createDecipheriv("aes-256-gcm", key, nonce);
        decipher.setAAD(Buffer.from(`${objectKey}:${blockIndex}:${totalSize}`, "utf8"));
        decipher.setAuthTag(encrypted.subarray(encryptedLength - AUTH_TAG_BYTES));
        const plaintext = Buffer.concat([
          decipher.update(encrypted.subarray(0, encryptedLength - AUTH_TAG_BYTES)),
          decipher.final()
        ]);
        const sliceStart = Math.max(selected.start - plainStart, 0);
        const sliceEnd = Math.min(selected.end - plainStart + 1, plainLength);
        yield plaintext.subarray(sliceStart, sliceEnd);
      }
    } finally {
      await file.close();
    }
  }
}

export class S3StorageProvider implements StorageProvider {
  readonly name = "s3" as const;
  readonly #client: S3Client;
  #readyCache: { value: boolean; until: number } | undefined;
  #readyInFlight: Promise<boolean> | undefined;

  constructor(private readonly config: NonNullable<AppConfig["s3"]>) {
    this.#client = new S3Client({
      region: config.region,
      ...(config.endpoint === undefined ? {} : { endpoint: config.endpoint }),
      forcePathStyle: config.forcePathStyle
    });
  }

  async put(input: StorageObjectInput): Promise<void> {
    const body = openSource(input);
    try {
      const response = await this.#client.send(new PutObjectCommand({
        Bucket: this.config.bucket,
        Key: input.objectKey,
        Body: body,
        ContentLength: input.sizeBytes,
        ContentType: input.mimeType,
        ChecksumSHA256: Buffer.from(input.sha256, "hex").toString("base64"),
        Metadata: { sha256: input.sha256 },
        ServerSideEncryption: this.config.serverSideEncryption,
        ...(this.config.kmsKeyId === undefined ? {} : {
          SSEKMSKeyId: this.config.kmsKeyId,
          BucketKeyEnabled: true
        })
      }));
      if (
        response.ServerSideEncryption !== this.config.serverSideEncryption ||
        (this.config.kmsKeyId !== undefined && response.SSEKMSKeyId !== this.config.kmsKeyId)
      ) {
        throw new Error("Object store did not confirm required server-side encryption");
      }
    } catch (error) {
      await this.delete(input.objectKey).catch(() => undefined);
      throw error;
    } finally {
      disposeResponseBody(body);
    }
  }

  async read(objectKey: string, totalSize: number, sha256: string, range?: ByteRange): Promise<StorageReadResult> {
    const selected = selectedRange(totalSize, range);
    const response = await this.#client.send(new GetObjectCommand({
      Bucket: this.config.bucket,
      Key: objectKey,
      ...(range === undefined ? {} : { Range: `bytes=${range.start}-${range.end}` })
    }));
    if (response.Body === undefined) throw new Error("Object store returned an empty body");
    let stream: Readable;
    const expectedLength = selected.end - selected.start + 1;
    try {
      if (response.ContentLength !== expectedLength) {
        throw new Error("Object store returned an unexpected content length");
      }
      if (
        range !== undefined &&
        response.ContentRange !== `bytes ${selected.start}-${selected.end}/${totalSize}`
      ) {
        throw new Error("Object store did not honor the requested byte range");
      }
      if (range === undefined && response.ContentRange !== undefined) {
        throw new Error("Object store unexpectedly returned a partial response");
      }
      if (response.Metadata?.["sha256"] !== sha256) {
        throw new Error("Object store checksum metadata does not match the attachment record");
      }
      if (
        response.ServerSideEncryption !== this.config.serverSideEncryption ||
        (this.config.kmsKeyId !== undefined && response.SSEKMSKeyId !== this.config.kmsKeyId)
      ) {
        throw new Error("Object store did not confirm required server-side encryption on read");
      }
      const candidate = response.Body as unknown as {
        transformToWebStream?: () => ReadableStream<Uint8Array>;
      };
      stream = response.Body instanceof Readable
        ? response.Body
        : candidate.transformToWebStream === undefined
          ? Readable.from(response.Body as AsyncIterable<Uint8Array>)
          : Readable.fromWeb(candidate.transformToWebStream());
    } catch (error) {
      disposeResponseBody(response.Body);
      throw error;
    }
    return {
      stream: Readable.from(enforceStreamLength(stream, expectedLength)),
      contentLength: expectedLength,
      totalSize,
      range: range ?? null
    };
  }

  async delete(objectKey: string): Promise<void> {
    await this.#client.send(new DeleteObjectCommand({ Bucket: this.config.bucket, Key: objectKey }));
  }

  async ready(): Promise<boolean> {
    if (this.#readyCache !== undefined && this.#readyCache.until > Date.now()) {
      return this.#readyCache.value;
    }
    if (this.#readyInFlight !== undefined) return this.#readyInFlight;
    this.#readyInFlight = this.#probeReady().then((value) => {
      this.#readyCache = { value, until: Date.now() + (value ? 30_000 : 10_000) };
      return value;
    }).finally(() => {
      this.#readyInFlight = undefined;
    });
    return this.#readyInFlight;
  }

  async #probeReady(): Promise<boolean> {
    // Single-node Beta canary: a fixed reserved key bounds residue when DeleteObject
    // is unavailable. Multi-replica rollout must move to per-instance keys with
    // version cleanup; the bucket lifecycle remains the final safety net.
    const objectKey = "attachments/.health/luxora-readiness-canary";
    const bytes = Buffer.from("L", "ascii");
    const digest = "72dfcfb0c470ac255cde83fb8fe38de8a128188e03ea5ba5b2a93adbea1062fa";
    let deleteVerified = false;
    try {
      await this.#client.send(new HeadBucketCommand({ Bucket: this.config.bucket }));
      await this.put({
        objectKey,
        sourceFactory: () => Readable.from([bytes]),
        sizeBytes: bytes.length,
        mimeType: "application/octet-stream",
        sha256: digest
      });
      const read = await this.read(objectKey, bytes.length, digest);
      const chunks: Buffer[] = [];
      for await (const chunk of read.stream) chunks.push(Buffer.from(chunk));
      if (!Buffer.concat(chunks).equals(bytes)) return false;
      await this.delete(objectKey);
      deleteVerified = true;
      return true;
    } catch {
      return false;
    } finally {
      if (!deleteVerified) await this.delete(objectKey).catch(() => undefined);
    }
  }

  async close(): Promise<void> {
    this.#client.destroy();
  }
}

export async function createStorageProvider(config: AppConfig): Promise<StorageProvider> {
  if (config.storageDriver === "s3") return new S3StorageProvider(config.s3 as NonNullable<AppConfig["s3"]>);
  if (config.storageLocalPath === ":memory:") {
    const root = await mkdtemp(join(tmpdir(), "luxora-blobs-"));
    return new LocalStorageProvider(root, config.dataEncryptionKeys, config.activeDataEncryptionKeyId, true);
  }
  return new LocalStorageProvider(
    resolve(config.storageLocalPath),
    config.dataEncryptionKeys,
    config.activeDataEncryptionKeyId
  );
}
