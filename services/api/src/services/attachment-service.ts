import type { AttachmentRecord } from "../domain/types.js";
import type { Store } from "../domain/store.js";
import { readThumbnailInfo } from "../domain/attachment-thumbnail.js";
import { notFound, serviceUnavailable } from "../errors.js";
import type { ByteRange, StorageProvider, StorageReadResult } from "../infrastructure/storage.js";

export interface AttachmentDownload {
  attachment: AttachmentRecord;
  content: StorageReadResult;
}

export interface AttachmentThumbnail {
  attachment: AttachmentRecord;
  sha256: string;
  sizeBytes: number;
  content: StorageReadResult;
}

export class AttachmentService {
  constructor(
    private readonly store: Store,
    private readonly storage: StorageProvider
  ) {}

  authorize(userId: string, attachmentId: string): AttachmentRecord {
    const attachment = this.store.findAttachmentRecord(attachmentId);
    if (attachment === null) throw notFound("Attachment not found");
    if (!this.store.canUserAccessAttachment(userId, attachmentId)) throw notFound("Attachment not found");
    if (attachment.storageProvider !== this.storage.name) {
      throw serviceUnavailable("Attachment storage provider is unavailable");
    }
    return attachment;
  }

  async download(userId: string, attachmentId: string, range?: ByteRange): Promise<AttachmentDownload> {
    const attachment = this.authorize(userId, attachmentId);
    return {
      attachment,
      content: await this.storage.read(attachment.storageKey, attachment.sizeBytes, attachment.sha256, range)
    };
  }

  async thumbnail(userId: string, attachmentId: string): Promise<AttachmentThumbnail> {
    const attachment = this.authorize(userId, attachmentId);
    const info = readThumbnailInfo(attachment.id, attachment.metadata);
    if (info === null) throw notFound("Attachment thumbnail not found");
    return {
      attachment,
      sha256: info.sha256,
      sizeBytes: info.sizeBytes,
      content: await this.storage.read(info.storageKey, info.sizeBytes, info.sha256)
    };
  }
}
