import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import type { Store } from "../domain/store.js";
import type { StorageProvider, ByteRange, StorageReadResult } from "../infrastructure/storage.js";
import { notFound, conflict, serviceUnavailable } from "../errors.js";
import { buildManifest, buildTarGzip, readableToBuffer } from "./export-archive.js";
import { readThumbnailInfo } from "../domain/attachment-thumbnail.js";
import type { DataExportRecord } from "../domain/types.js";

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

export interface ExportDownload {
  record: DataExportRecord;
  content: StorageReadResult;
}

export class DataExportService {
  constructor(
    private readonly store: Store,
    private readonly storage: StorageProvider
  ) {}

  async requestExport(userId: string): Promise<DataExportRecord> {
    const existing = this.store.findLatestReadyExport(userId);
    if (existing !== null && existing.expiresAt !== null && Date.parse(existing.expiresAt) > Date.now()) {
      return existing;
    }
    const expiresAt = new Date(Date.now() + SEVEN_DAYS_MS).toISOString();
    const now = new Date().toISOString();
    const id = randomUUID();
    const objectKey = `export/${userId}/${id}.tar.gz`;
    const record = this.store.createDataExport({ id, accountId: userId, objectKey, createdAt: now });

    try {
      await this.#buildAndStore(record, userId, expiresAt);
      return this.store.findDataExport(userId, id)!;
    } catch {
      throw serviceUnavailable("Failed to build data export");
    }
  }

  getStatus(userId: string, exportId: string): DataExportRecord {
    const record = this.store.findDataExport(userId, exportId);
    if (record === null) throw notFound("Data export not found");
    return record;
  }

  async download(userId: string, exportId: string, range?: ByteRange): Promise<ExportDownload> {
    const record = this.getStatus(userId, exportId);
    if (record.state !== "ready") throw conflict("Data export is not ready");
    if (record.objectKey === "") throw serviceUnavailable("Export storage unavailable");
    return {
      record,
      content: await this.storage.read(record.objectKey, record.sizeBytes ?? 0, record.sha256 ?? "", range)
    };
  }

  async #buildAndStore(record: DataExportRecord, userId: string, expiresAt: string): Promise<void> {
    const tmpDir = await mkdtemp(join(tmpdir(), "lux-export-"));
    try {
      const profile = this.store.findUserById(userId);
      const privacy = this.store.getPrivacySettings(userId);
      const notifications = this.store.getNotificationSettings(userId);
      const sessions = this.store.listSessions(userId, "");
      const relationships = this.store.listExportRelationships(userId);
      const blocks = this.store.listExportBlocks(userId);
      const messages = this.store.listExportMessages(userId);
      const chats = this.store.listExportChats(userId);
      const attachments = this.store.listAllOwnedAttachments(userId);

      const manifestFiles: Array<{ path: string; sha256: string; mimeType: string; sizeBytes: number }> = [];
      const addEntry = async (name: string, data: Buffer, mimeType: string): Promise<void> => {
        const sha = createHash("sha256").update(data).digest("hex");
        const filePath = join(tmpDir, name);
        await mkdir(dirname(filePath), { recursive: true });
        await writeFile(filePath, data);
        manifestFiles.push({ path: name, sha256: sha, mimeType, sizeBytes: data.length });
      };

      const toNdjson = (items: unknown[]): Buffer => Buffer.from(items.map((i) => JSON.stringify(i)).join("\n") + (items.length > 0 ? "\n" : ""), "utf8");

      await addEntry("profile.jsonl", toNdjson([{
        id: profile?.id ?? userId,
        username: profile?.username ?? "",
        displayName: profile?.displayName ?? "",
        bio: profile?.bio ?? "",
        avatarUrl: profile?.avatarUrl ?? null,
        createdAt: profile?.createdAt ?? ""
      }]), "application/x-ndjson");

      await addEntry("settings.jsonl", toNdjson([{
        type: "settings",
        privacy: { ...privacy, userId: undefined },
        notifications: { ...notifications, userId: undefined }
      }]), "application/x-ndjson");

      await addEntry("sessions.jsonl", toNdjson(sessions.map((s) => ({
        id: s.id, deviceName: s.deviceName, createdAt: s.createdAt, lastSeenAt: s.lastSeenAt
      }))), "application/x-ndjson");

      await addEntry("relationships.jsonl", toNdjson(relationships.map((r) => ({
        peerUserId: r.peerUserId, createdAt: r.createdAt
      }))), "application/x-ndjson");

      await addEntry("blocks.jsonl", toNdjson(blocks.map((b) => ({
        blockedUserId: b.blockedUserId, createdAt: b.createdAt
      }))), "application/x-ndjson");

      await addEntry("chats.jsonl", toNdjson(chats.map((c) => ({
        chatId: c.chatId, kind: c.kind, title: c.title, memberSince: c.memberSince
      }))), "application/x-ndjson");

      await addEntry("messages.jsonl", toNdjson(messages.map((m) => ({
        id: m.id, chatId: m.chatId, body: m.body, createdAt: m.createdAt, updatedAt: m.updatedAt, deletedAt: m.deletedAt
      }))), "application/x-ndjson");

      await addEntry("media.jsonl", toNdjson(attachments.map((a) => {
        const thumbnail = readThumbnailInfo(a.id, a.metadata);
        return {
          id: a.id, kind: a.kind, fileName: a.fileName, detectedMimeType: a.detectedMimeType, sizeBytes: a.sizeBytes, sha256: a.sha256, createdAt: a.createdAt, deletedAt: a.deletedAt,
          thumbnail: thumbnail === null
            ? null
            : { sha256: thumbnail.sha256, sizeBytes: thumbnail.sizeBytes, width: thumbnail.width, height: thumbnail.height }
        };
      })), "application/x-ndjson");

      for (const attachment of attachments) {
        const read = await this.storage.read(attachment.storageKey, attachment.sizeBytes, attachment.sha256);
        const bytes = await readableToBuffer(read.stream);
        if (bytes.length !== attachment.sizeBytes) {
          throw serviceUnavailable(`Media binary size mismatch for attachment ${attachment.id}`);
        }
        await addEntry(
          `media/${attachment.id}/${attachment.fileName}`,
          bytes,
          attachment.detectedMimeType
        );
        const thumbnail = readThumbnailInfo(attachment.id, attachment.metadata);
        if (thumbnail !== null) {
          const thumbnailRead = await this.storage.read(thumbnail.storageKey, thumbnail.sizeBytes, thumbnail.sha256);
          const thumbnailBytes = await readableToBuffer(thumbnailRead.stream);
          if (thumbnailBytes.length !== thumbnail.sizeBytes) {
            throw serviceUnavailable(`Thumbnail size mismatch for attachment ${attachment.id}`);
          }
          await addEntry(
            `media/${attachment.id}/thumbnail.jpg`,
            thumbnailBytes,
            "image/jpeg"
          );
        }
      }

      const includedCategories = ["profile", "settings", "sessions", "relationships", "blocks", "chats", "messages", "mediaMetadata", "mediaBinaries"];
      const omittedCategories = ["tokens"];
      const manifestData = buildManifest({
        schemaVersion: 1,
        accountId: userId,
        createdAt: new Date().toISOString(),
        includedCategories,
        omittedCategories,
        files: manifestFiles.map(({ path: f, ...rest }) => ({ path: f, ...rest }))
      });

      await addEntry("manifest.json", manifestData, "application/json");

      const archiveEntries = await Promise.all(
        manifestFiles.map(async (file) => ({
          path: file.path,
          bytes: await readFile(join(tmpDir, file.path)),
        }))
      );
      const archive = await buildTarGzip(archiveEntries);
      const archiveSha = createHash("sha256").update(archive).digest("hex");

      await this.storage.put({
        objectKey: record.objectKey,
        sizeBytes: archive.length,
        mimeType: "application/gzip",
        sha256: archiveSha,
        sourceFactory: () => Readable.from(archive),
      });

      const now = new Date().toISOString();
      this.store.markDataExportReady(record.id, archive.length, archiveSha, now, expiresAt);
    } finally {
      await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
  }
}