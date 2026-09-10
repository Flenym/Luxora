import { createHash, randomUUID } from "node:crypto";
import { closeSync, fsyncSync, openSync, renameSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { Readable } from "node:stream";
import { TextDecoder } from "node:util";
import { fileTypeFromBuffer } from "file-type";
import type { Attachment, CreateUploadRequest, UploadSession } from "@luxora/protocol";
import type { AppConfig } from "../config.js";
import type { Store } from "../domain/store.js";
import type { UploadChunkRecord, UploadSessionRecord } from "../domain/types.js";
import { AppError, badRequest, conflict, notFound, serviceUnavailable } from "../errors.js";
import { contentCipherFromConfig, type ContentCipher } from "../infrastructure/content-cipher.js";
import type { SearchHasher } from "../infrastructure/search-hasher.js";
import type { StorageProvider } from "../infrastructure/storage.js";
import type { EventPublisher } from "./event-publisher.js";

const ALLOWED_MIME_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
  "image/avif",
  "image/heic",
  "video/mp4",
  "video/webm",
  "video/quicktime",
  "audio/mpeg",
  "audio/ogg",
  "audio/wav",
  "audio/x-wav",
  "audio/mp4",
  "audio/webm",
  "audio/flac",
  "audio/aac",
  "application/pdf",
  "application/zip",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "text/plain"
]);
const BIDI_CONTROL_PATTERN = /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u;

interface ChunkInput {
  index: number;
  start: number;
  end: number;
  total: number;
  sha256: string;
  bytes: Buffer;
}

interface UploadInspection {
  digest: string;
  prefix: Buffer;
  validUtf8Text: boolean;
}

export interface UploadCleanupResult {
  expiredUploads: number;
  orphanAttachments: number;
  cleanupFailures: number;
}

function safeFileName(value: string): string {
  if (
    value !== basename(value) ||
    /[\u0000-\u001f\u007f\\/]/u.test(value) ||
    BIDI_CONTROL_PATTERN.test(value)
  ) {
    throw badRequest("fileName must not contain paths or unsafe control characters");
  }
  const normalized = value.normalize("NFC").trim();
  if (normalized.length === 0) throw badRequest("fileName cannot be empty");
  try {
    encodeURIComponent(normalized);
  } catch {
    throw badRequest("fileName must contain well-formed Unicode");
  }
  return normalized;
}

function expectedChunkCount(upload: UploadSessionRecord): number {
  return Math.ceil(upload.sizeBytes / upload.chunkSizeBytes);
}

function sessionMatches(upload: UploadSessionRecord, input: CreateUploadRequest, fileName: string): boolean {
  return upload.kind === input.kind &&
    upload.fileName === fileName &&
    upload.declaredMimeType === input.mimeType &&
    upload.sizeBytes === input.sizeBytes &&
    upload.sha256 === input.sha256 &&
    JSON.stringify(upload.metadata) === JSON.stringify(input.metadata);
}

function publishChunk(temporaryPath: string, finalPath: string, directory: string): void {
  renameSync(temporaryPath, finalPath);
  if (process.platform === "win32") return;
  const directoryHandle = openSync(directory, "r");
  try {
    fsyncSync(directoryHandle);
  } finally {
    closeSync(directoryHandle);
  }
}

export class UploadService {
  private cleanupInFlight: Promise<UploadCleanupResult> | undefined;

  private constructor(
    private readonly store: Store,
    private readonly storage: StorageProvider,
    private readonly search: SearchHasher,
    private readonly publisher: EventPublisher,
    private readonly config: AppConfig,
    private readonly stagingRoot: string,
    private readonly ephemeralStaging: boolean,
    private readonly stagingCipher: ContentCipher
  ) {}

  static async create(
    store: Store,
    storage: StorageProvider,
    search: SearchHasher,
    publisher: EventPublisher,
    config: AppConfig
  ): Promise<UploadService> {
    const ephemeral = config.uploadStagingPath === ":memory:";
    const root = ephemeral
      ? await mkdtemp(join(tmpdir(), "luxora-uploads-"))
      : resolve(config.uploadStagingPath);
    await mkdir(root, { recursive: true });
    return new UploadService(
      store,
      storage,
      search,
      publisher,
      config,
      root,
      ephemeral,
      contentCipherFromConfig(config.dataEncryptionKeys, config.activeDataEncryptionKeyId)
    );
  }

  createSession(userId: string, input: CreateUploadRequest): UploadSession {
    const fileName = safeFileName(input.fileName);
    if (input.sizeBytes > this.config.maxAttachmentBytes) {
      throw new AppError(413, "BAD_REQUEST", `Attachment exceeds the ${this.config.maxAttachmentBytes}-byte limit`);
    }
    const existing = this.store.findUploadByIdempotency(userId, input.idempotencyKey);
    if (existing !== null) {
      if (!sessionMatches(existing, input, fileName)) {
        throw conflict("idempotencyKey was already used for a different upload");
      }
      return this.store.toUploadSession(existing);
    }

    const now = new Date();
    const record = this.store.transaction(() => {
      const reserved = this.store.getReservedStorageBytes(userId, now.toISOString());
      if (reserved + input.sizeBytes > this.config.userStorageQuotaBytes) {
        throw new AppError(413, "BAD_REQUEST", "User storage quota would be exceeded");
      }
      return this.store.createUploadSession({
        id: randomUUID(),
        userId,
        idempotencyKey: input.idempotencyKey,
        kind: input.kind,
        fileName,
        declaredMimeType: input.mimeType,
        sizeBytes: input.sizeBytes,
        sha256: input.sha256,
        metadata: input.metadata,
        storageProvider: this.storage.name,
        chunkSizeBytes: this.config.uploadChunkSizeBytes,
        expiresAt: new Date(now.getTime() + this.config.uploadSessionTtlMinutes * 60_000).toISOString(),
        createdAt: now.toISOString()
      });
    });
    return this.store.toUploadSession(record);
  }

  getSession(userId: string, uploadId: string): UploadSession {
    let upload = this.store.findUploadSession(uploadId, userId);
    if (upload === null) throw notFound("Upload session not found");
    const now = new Date().toISOString();
    if (upload.status === "active" && upload.expiresAt <= now && this.store.expireUpload(upload.id, now)) {
      upload = this.store.findUploadSession(uploadId, userId) as UploadSessionRecord;
    }
    return this.store.toUploadSession(upload);
  }

  async putChunk(userId: string, uploadId: string, input: ChunkInput): Promise<UploadSession> {
    const upload = this.store.findUploadSession(uploadId, userId);
    if (upload === null) throw notFound("Upload session not found");
    const now = new Date().toISOString();
    if (upload.status !== "active") throw conflict(`Upload is ${upload.status}`);
    if (upload.storageProvider !== this.storage.name) {
      throw serviceUnavailable("The upload's storage provider is not active");
    }
    if (upload.expiresAt <= now) {
      if (this.store.expireUpload(upload.id, now)) await this.#removeTerminalStaging(upload.id);
      throw conflict("Upload session expired");
    }
    if (input.total !== upload.sizeBytes) throw badRequest("Content-Range total does not match the upload session");
    const count = expectedChunkCount(upload);
    if (input.index < 0 || input.index >= count) throw badRequest("Chunk index is outside the upload range");
    const expectedStart = input.index * upload.chunkSizeBytes;
    const expectedSize = Math.min(upload.chunkSizeBytes, upload.sizeBytes - expectedStart);
    if (
      input.start !== expectedStart ||
      input.end !== expectedStart + expectedSize - 1 ||
      input.bytes.length !== expectedSize
    ) {
      throw badRequest("Chunk length or Content-Range is inconsistent with the upload session");
    }
    const digest = createHash("sha256").update(input.bytes).digest("hex");
    if (digest !== input.sha256) throw badRequest("Chunk SHA-256 mismatch");

    const temporaryPath = await this.#writeChunkTemporary(upload.id, input.index, input.bytes);
    let resultingStatus: UploadSessionRecord["status"] | "missing";
    try {
      resultingStatus = this.store.transaction<UploadSessionRecord["status"] | "missing">(() => {
        this.store.addUploadChunk({
          uploadId: upload.id,
          chunkIndex: input.index,
          byteOffset: input.start,
          sizeBytes: input.bytes.length,
          sha256: digest,
          createdAt: now
        }, userId);
        const current = this.store.findUploadSession(upload.id, userId);
        if (current === null) return "missing";
        if (current.status !== "active") return current.status;
        if (current.expiresAt <= now) {
          this.store.expireUpload(current.id, now);
          return "expired";
        }
        const recorded = this.store.getUploadChunks(upload.id)
          .find((chunk) => chunk.chunkIndex === input.index);
        if (recorded?.sha256 !== digest || recorded.sizeBytes !== input.bytes.length) {
          throw conflict("Chunk index was already uploaded with different content");
        }
        publishChunk(
          temporaryPath,
          this.#chunkPath(upload.id, input.index),
          this.#uploadDirectory(upload.id)
        );
        return "active";
      });
    } finally {
      await rm(temporaryPath, { force: true });
    }
    if (resultingStatus !== "active") {
      if (["completed", "failed", "expired"].includes(resultingStatus)) {
        await this.#removeTerminalStaging(upload.id);
      }
      throw conflict(resultingStatus === "missing" ? "Upload session no longer exists" : `Upload is ${resultingStatus}`);
    }
    return this.getSession(userId, uploadId);
  }

  async complete(userId: string, uploadId: string): Promise<UploadSession> {
    const initial = this.store.findUploadSession(uploadId, userId);
    if (initial === null) throw notFound("Upload session not found");
    if (initial.status === "completed") return this.store.toUploadSession(initial);
    const now = new Date().toISOString();
    if (initial.status === "active" && initial.expiresAt <= now) {
      if (this.store.expireUpload(uploadId, now)) await this.#removeTerminalStaging(uploadId);
      throw conflict("Upload session expired");
    }
    const leaseUntil = new Date(
      Date.parse(now) + this.config.uploadSessionTtlMinutes * 60_000
    ).toISOString();
    if (!this.store.acquireUploadCompletion(uploadId, userId, now, leaseUntil)) {
      throw conflict(`Upload cannot be completed from status ${initial.status}`);
    }
    const upload = this.store.findUploadSession(uploadId, userId) as UploadSessionRecord;
    if (upload.storageProvider !== this.storage.name) {
      this.store.releaseUploadCompletion(uploadId, new Date().toISOString());
      throw serviceUnavailable("The upload's storage provider is not active");
    }
    const chunks = this.store.getUploadChunks(uploadId);
    if (
      chunks.length !== expectedChunkCount(upload) ||
      chunks.some((chunk, index) => chunk.chunkIndex !== index) ||
      chunks.reduce((sum, chunk) => sum + chunk.sizeBytes, 0) !== upload.sizeBytes
    ) {
      this.store.releaseUploadCompletion(uploadId, now);
      throw conflict("Upload is incomplete");
    }

    let objectKey: string | null = null;
    try {
      let inspection: UploadInspection;
      try {
        inspection = await this.#inspectUpload(upload, chunks);
      } catch {
        this.store.failUpload(upload.id, "STAGING_INTEGRITY_FAILED", new Date().toISOString());
        throw conflict("Upload staging failed integrity validation");
      }
      const digest = inspection.digest;
      if (digest !== upload.sha256) {
        this.store.failUpload(upload.id, "FILE_HASH_MISMATCH", new Date().toISOString());
        throw badRequest("Completed file SHA-256 mismatch");
      }
      let detectedMimeType: string;
      try {
        detectedMimeType = await this.#validateMime(
          inspection.prefix,
          upload.declaredMimeType,
          upload.kind,
          inspection.validUtf8Text
        );
      } catch (error) {
        this.store.failUpload(upload.id, "MIME_VALIDATION_FAILED", new Date().toISOString());
        throw error;
      }
      const attachmentId = randomUUID();
      objectKey = this.#objectKey(upload);
      await this.storage.put({
        objectKey,
        sourceFactory: () => Readable.from(this.#plainChunks(upload, chunks)),
        sizeBytes: upload.sizeBytes,
        mimeType: detectedMimeType,
        sha256: upload.sha256
      });

      const completedAt = new Date().toISOString();
      const result = this.store.transaction(() => {
        this.store.createAttachment({
          id: attachmentId,
          ownerUserId: userId,
          kind: upload.kind,
          fileName: upload.fileName,
          declaredMimeType: upload.declaredMimeType,
          detectedMimeType,
          sizeBytes: upload.sizeBytes,
          sha256: upload.sha256,
          metadata: upload.metadata,
          storageProvider: upload.storageProvider,
          storageKey: objectKey as string,
          createdAt: completedAt
        });
        this.store.replaceAttachmentSearchTokens(attachmentId, this.search.index(upload.fileName));
        if (!this.store.completeUpload(upload.id, attachmentId, completedAt)) {
          throw conflict("Upload completion lease is no longer valid");
        }
        const attachment = this.store.getAttachment(attachmentId) as Attachment;
        const event = this.store.appendEvent(userId, { type: "attachment.stored", attachment }, completedAt);
        return { attachment, event };
      });
      objectKey = null;
      this.publisher.publish([result.event]);
      await this.#removeTerminalStaging(upload.id);
      return this.store.toUploadSession(this.store.findUploadSession(upload.id, userId) as UploadSessionRecord);
    } catch (error) {
      if (objectKey !== null) await this.storage.delete(objectKey).catch(() => undefined);
      const current = this.store.findUploadSession(upload.id, userId);
      if (current?.status === "completing") this.store.releaseUploadCompletion(upload.id, new Date().toISOString());
      if (current?.status === "failed") await this.#removeTerminalStaging(upload.id);
      throw error;
    }
  }

  cleanup(): Promise<UploadCleanupResult> {
    if (this.cleanupInFlight !== undefined) return this.cleanupInFlight;
    this.cleanupInFlight = this.#cleanupOnce().finally(() => {
      this.cleanupInFlight = undefined;
    });
    return this.cleanupInFlight;
  }

  async #cleanupOnce(): Promise<UploadCleanupResult> {
    const now = new Date();
    let cleanupFailures = 0;
    const staleLease = new Date(
      now.getTime() - this.config.uploadSessionTtlMinutes * 60_000
    ).toISOString();
    const expired = this.store.listExpiredUploads(now.toISOString(), staleLease, 100);
    let expiredCount = 0;
    for (const upload of expired) {
      if (!this.store.expireUpload(upload.id, now.toISOString(), staleLease)) continue;
      expiredCount += 1;
      await this.#removeTerminalStaging(upload.id).catch(() => {
        cleanupFailures += 1;
      });
    }
    const terminal = this.store.listUploadsWithStagingToClean(now.toISOString(), 100);
    for (const upload of terminal) {
      await this.#removeTerminalStaging(upload.id).catch(() => {
        cleanupFailures += 1;
      });
    }
    await this.#sweepTerminalStaging().catch(() => {
      cleanupFailures += 1;
    });
    const objects = this.store.listUploadsWithObjectsToClean(this.storage.name, now.toISOString(), 100);
    for (const upload of objects) {
      try {
        await this.storage.delete(this.#objectKey(upload));
        this.store.markUploadObjectCleaned(upload.id, new Date().toISOString());
      } catch {
        // Persisted cleanup state intentionally remains pending for the next sweep.
        cleanupFailures += 1;
      }
    }
    const orphanBefore = new Date(now.getTime() - this.config.orphanAttachmentTtlHours * 3_600_000).toISOString();
    const staleOrphanClaim = new Date(now.getTime() - 60 * 60_000).toISOString();
    const orphanClaim = this.store.claimOrphanAttachments(
      this.storage.name,
      orphanBefore,
      staleOrphanClaim,
      now.toISOString(),
      100
    );
    this.publisher.publish(orphanClaim.invalidations);
    let deletedOrphans = 0;
    for (const attachment of orphanClaim.attachments) {
      try {
        await this.storage.delete(attachment.storageKey);
        this.publisher.publish(this.store.deleteAttachmentRecord(attachment.id, now.toISOString()));
        deletedOrphans += 1;
      } catch {
        // The delete is intentionally irreversible: remote failures are ambiguous,
        // so the claim remains hidden and is retried idempotently after its lease.
        cleanupFailures += 1;
      }
    }
    return { expiredUploads: expiredCount, orphanAttachments: deletedOrphans, cleanupFailures };
  }

  async close(): Promise<void> {
    await this.cleanupInFlight?.catch(() => undefined);
    if (this.ephemeralStaging) await rm(this.stagingRoot, { recursive: true, force: true });
  }

  async ready(): Promise<boolean> {
    const probe = join(this.stagingRoot, `.luxora-ready-${randomUUID()}`);
    try {
      await mkdir(this.stagingRoot, { recursive: true });
      const file = await open(probe, "wx", 0o600);
      try {
        await file.writeFile(Buffer.from([0x4c]));
        await file.sync();
      } finally {
        await file.close();
      }
      const stored = await readFile(probe);
      await rm(probe, { force: true });
      return stored.length === 1 && stored[0] === 0x4c;
    } catch {
      await rm(probe, { force: true }).catch(() => undefined);
      return false;
    }
  }

  async #inspectUpload(upload: UploadSessionRecord, chunks: UploadChunkRecord[]): Promise<UploadInspection> {
    const hash = createHash("sha256");
    const prefixParts: Buffer[] = [];
    let prefixBytes = 0;
    let validUtf8Text = true;
    let decoder: TextDecoder | undefined = new TextDecoder("utf-8", { fatal: true });
    for (const chunk of chunks) {
      const bytes = await this.#readValidatedChunk(upload, chunk);
      hash.update(bytes);
      if (prefixBytes < 8_192) {
        const slice = bytes.subarray(0, 8_192 - prefixBytes);
        prefixParts.push(slice);
        prefixBytes += slice.length;
      }
      if (decoder !== undefined) {
        try {
          if (bytes.includes(0)) throw new Error("NUL byte");
          decoder.decode(bytes, { stream: true });
        } catch {
          validUtf8Text = false;
          decoder = undefined;
        }
      }
    }
    if (decoder !== undefined) {
      try {
        decoder.decode();
      } catch {
        validUtf8Text = false;
      }
    }
    return { digest: hash.digest("hex"), prefix: Buffer.concat(prefixParts), validUtf8Text };
  }

  async #validateMime(
    prefix: Buffer,
    declared: string,
    kind: Attachment["kind"],
    validUtf8Text: boolean
  ): Promise<string> {
    const normalizedDeclared = declared.split(";", 1)[0]?.trim().toLowerCase() ?? "";
    const detected = await fileTypeFromBuffer(prefix);
    let effective = detected?.mime.toLowerCase();
    if (effective === undefined && normalizedDeclared === "text/plain") {
      if (!validUtf8Text) throw badRequest("text/plain upload is not valid UTF-8 text");
      effective = "text/plain";
    }
    if (effective === undefined || !ALLOWED_MIME_TYPES.has(effective)) {
      throw badRequest("File type is unsupported or cannot be verified from its content");
    }
    const genericDeclared = normalizedDeclared === "application/octet-stream";
    const wavAlias = normalizedDeclared === "audio/x-wav" && effective === "audio/wav";
    if (!genericDeclared && normalizedDeclared !== effective && !wavAlias) {
      throw badRequest(`Declared MIME type '${normalizedDeclared}' does not match detected '${effective}'`);
    }
    const exposed = effective;
    if (kind === "image" && !exposed.startsWith("image/")) throw badRequest("Image upload does not contain an image");
    if ((kind === "video" || kind === "video_message") && !exposed.startsWith("video/")) {
      throw badRequest("Video upload does not contain video media");
    }
    if ((kind === "audio" || kind === "voice") && !exposed.startsWith("audio/")) {
      throw badRequest("Audio upload does not contain audio media");
    }
    return exposed;
  }

  #uploadDirectory(uploadId: string): string {
    return join(this.stagingRoot, uploadId);
  }

  #chunkPath(uploadId: string, index: number): string {
    return join(this.#uploadDirectory(uploadId), `${index}.part`);
  }

  async #removeStaging(uploadId: string): Promise<void> {
    await rm(this.#uploadDirectory(uploadId), { recursive: true, force: true });
    if (process.platform === "win32") return;
    const root = await open(this.stagingRoot, "r");
    try {
      await root.sync();
    } finally {
      await root.close();
    }
  }

  async #removeTerminalStaging(uploadId: string): Promise<void> {
    await this.#removeStaging(uploadId);
    this.store.markUploadStagingCleaned(uploadId, new Date().toISOString());
  }

  async #writeChunkTemporary(uploadId: string, index: number, bytes: Buffer): Promise<string> {
    const directory = this.#uploadDirectory(uploadId);
    await mkdir(directory, { recursive: true });
    const context = `upload-chunk:${uploadId}:${index}`;
    const encoded = Buffer.from(
      this.stagingCipher.encrypt(bytes.toString("base64url"), context),
      "utf8"
    );
    const temporaryPath = join(directory, `.${index}.${randomUUID()}.tmp`);
    const file = await open(temporaryPath, "wx", 0o600);
    try {
      await file.writeFile(encoded);
      await file.sync();
      await file.close();
      return temporaryPath;
    } catch (error) {
      await file.close().catch(() => undefined);
      await rm(temporaryPath, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  async #sweepTerminalStaging(): Promise<void> {
    const entries = await readdir(this.stagingRoot, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory() || !/^[a-f0-9-]{36}$/iu.test(entry.name)) continue;
      if (this.store.isUploadTerminal(entry.name)) await this.#removeTerminalStaging(entry.name);
    }
  }

  async #readChunkFile(uploadId: string, index: number): Promise<Buffer> {
    const stored = await readFile(this.#chunkPath(uploadId, index), "utf8");
    const decoded = this.stagingCipher.decrypt(stored, `upload-chunk:${uploadId}:${index}`);
    return Buffer.from(decoded, "base64url");
  }

  async #readValidatedChunk(upload: UploadSessionRecord, chunk: UploadChunkRecord): Promise<Buffer> {
    const bytes = await this.#readChunkFile(upload.id, chunk.chunkIndex);
    if (
      bytes.length !== chunk.sizeBytes ||
      createHash("sha256").update(bytes).digest("hex") !== chunk.sha256
    ) {
      throw conflict("Upload staging chunk failed integrity validation");
    }
    return bytes;
  }

  async *#plainChunks(upload: UploadSessionRecord, chunks: UploadChunkRecord[]): AsyncGenerator<Buffer> {
    for (const chunk of chunks) yield await this.#readValidatedChunk(upload, chunk);
  }

  #objectKey(upload: Pick<UploadSessionRecord, "id" | "userId">): string {
    return `attachments/${upload.userId.slice(0, 2)}/${upload.userId}/${upload.id}`;
  }
}
