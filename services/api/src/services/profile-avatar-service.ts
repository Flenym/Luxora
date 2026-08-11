import { createHash, randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import type { User } from "@luxora/protocol";
import sharp from "sharp";
import type { Store } from "../domain/store.js";
import type { AttachmentRecord, UserRecord } from "../domain/types.js";
import { AppError, badRequest, notFound, serviceUnavailable } from "../errors.js";
import type { StorageProvider } from "../infrastructure/storage.js";
import type { EventPublisher } from "./event-publisher.js";
import { appendSyncInvalidations } from "./sync-invalidation.js";

const AVATAR_EDGE_PIXELS = 512;
const MAX_AVATAR_SOURCE_BYTES = 20 * 1_024 * 1_024;
const MAX_AVATAR_INPUT_PIXELS = 40_000_000;
const MAX_CONCURRENT_AVATAR_PROCESSORS = 2;

function publicUser(user: UserRecord): User {
  return {
    id: user.id,
    username: user.username,
    displayName: user.displayName,
    bio: user.bio,
    avatarUrl: user.avatarUrl,
    avatarPath: user.avatarPath ?? null,
    createdAt: user.createdAt,
    lastSeenAt: user.lastSeenAt
  };
}

function isDerivativeOf(attachment: AttachmentRecord | null, sourceSha256: string): boolean {
  return attachment !== null &&
    attachment.kind === "image" &&
    attachment.safetyStatus === "reencoded" &&
    attachment.metadataTrust === "server_verified" &&
    attachment.metadata["sourceSha256"] === sourceSha256;
}

async function readSource(
  storage: StorageProvider,
  attachment: AttachmentRecord
): Promise<Buffer> {
  if (attachment.sizeBytes > MAX_AVATAR_SOURCE_BYTES) {
    throw new AppError(413, "BAD_REQUEST", "Profile avatar source exceeds the 20 MiB limit");
  }
  const result = await storage.read(
    attachment.storageKey,
    attachment.sizeBytes,
    attachment.sha256
  );
  if (result.contentLength !== attachment.sizeBytes || result.totalSize !== attachment.sizeBytes) {
    result.stream.destroy();
    throw serviceUnavailable("Profile avatar source is temporarily unavailable");
  }
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of result.stream) {
    const bytes = Buffer.from(chunk);
    total += bytes.length;
    if (total > attachment.sizeBytes || total > MAX_AVATAR_SOURCE_BYTES) {
      result.stream.destroy();
      throw serviceUnavailable("Profile avatar source is inconsistent");
    }
    chunks.push(bytes);
  }
  if (total !== attachment.sizeBytes) {
    throw serviceUnavailable("Profile avatar source is incomplete");
  }
  return Buffer.concat(chunks, total);
}

async function processAvatar(source: Buffer): Promise<Buffer> {
  try {
    const { data, info } = await sharp(source, {
      failOn: "warning",
      limitInputPixels: MAX_AVATAR_INPUT_PIXELS,
      sequentialRead: true
    })
      .autoOrient()
      .resize(AVATAR_EDGE_PIXELS, AVATAR_EDGE_PIXELS, {
        fit: "cover",
        position: "centre"
      })
      .png({
        compressionLevel: 9,
        adaptiveFiltering: true,
        palette: false
      })
      .toBuffer({ resolveWithObject: true });
    if (
      info.format !== "png" ||
      info.width !== AVATAR_EDGE_PIXELS ||
      info.height !== AVATAR_EDGE_PIXELS ||
      data.length === 0
    ) {
      throw new Error("unexpected avatar processor output");
    }
    return data;
  } catch {
    throw badRequest("Image cannot be processed as a profile avatar");
  }
}

export class ProfileAvatarService {
  #processingInFlight = 0;

  constructor(
    private readonly store: Store,
    private readonly storage: StorageProvider,
    private readonly userStorageQuotaBytes: number,
    private readonly clock: () => Date = () => new Date(),
    private readonly publisher?: Pick<EventPublisher, "publish">,
    private readonly syncInvalidationEnabled = true
  ) {}

  async set(userId: string, sourceAttachmentId: string): Promise<User> {
    const source = this.store.findAttachmentRecord(sourceAttachmentId);
    if (source === null || source.ownerUserId !== userId) {
      throw notFound("Attachment not found");
    }
    if (source.kind !== "image" || !source.detectedMimeType.startsWith("image/")) {
      throw badRequest("Profile avatar source must be an image");
    }
    if (source.storageProvider !== this.storage.name) {
      throw serviceUnavailable("Profile avatar storage provider is unavailable");
    }
    const initialUser = this.store.findUserById(userId);
    if (initialUser === null) throw notFound("User not found");
    if (
      initialUser.avatarAttachmentId !== null &&
      initialUser.avatarAttachmentId !== undefined &&
      isDerivativeOf(
        this.store.findAttachmentRecord(initialUser.avatarAttachmentId),
        source.sha256
      )
    ) {
      return publicUser(initialUser);
    }

    if (this.#processingInFlight >= MAX_CONCURRENT_AVATAR_PROCESSORS) {
      throw serviceUnavailable("Profile avatar processor is busy; retry later");
    }
    this.#processingInFlight += 1;
    let processed: Buffer;
    try {
      processed = await processAvatar(await readSource(this.storage, source));
    } finally {
      this.#processingInFlight -= 1;
    }
    const avatarId = randomUUID();
    const sha256 = createHash("sha256").update(processed).digest("hex");
    const objectKey = `profile-avatars/${userId}/${avatarId}.png`;
    const now = this.clock().toISOString();
    let stored = false;
    try {
      await this.storage.put({
        objectKey,
        sourceFactory: () => Readable.from(processed),
        sizeBytes: processed.length,
        mimeType: "image/png",
        sha256
      });
      stored = true;
      const outcome = this.store.immediateTransaction(() => {
        const currentUser = this.store.findUserById(userId);
        if (currentUser === null) throw notFound("User not found");
        if (
          currentUser.avatarAttachmentId !== null &&
          currentUser.avatarAttachmentId !== undefined &&
          isDerivativeOf(
            this.store.findAttachmentRecord(currentUser.avatarAttachmentId),
            source.sha256
          )
        ) {
          return { user: currentUser, committed: false, events: [] } as const;
        }
        const reservedBytes = this.store.getReservedStorageBytes(userId, now);
        if (reservedBytes + processed.length > this.userStorageQuotaBytes) {
          throw new AppError(413, "BAD_REQUEST", "User storage quota would be exceeded");
        }
        this.store.createAttachment({
          id: avatarId,
          ownerUserId: userId,
          kind: "image",
          fileName: "profile-avatar.png",
          declaredMimeType: "image/png",
          detectedMimeType: "image/png",
          sizeBytes: processed.length,
          sha256,
          metadata: {
            width: AVATAR_EDGE_PIXELS,
            height: AVATAR_EDGE_PIXELS,
            sourceSha256: source.sha256
          },
          storageProvider: this.storage.name,
          storageKey: objectKey,
          safetyStatus: "reencoded",
          metadataTrust: "server_verified",
          createdAt: now
        });
        const bound = this.store.setUserAvatarAttachment(userId, avatarId, now);
        if (bound === null) throw notFound("User not found");
        const events = appendSyncInvalidations(
          this.store,
          this.store.listProfileProjectionAudienceUserIds(userId),
          "avatar_updated",
          now,
          this.syncInvalidationEnabled
        );
        return { user: bound, committed: true, events } as const;
      });
      if (!outcome.committed) {
        await this.storage.delete(objectKey).catch(() => undefined);
        stored = false;
        return publicUser(outcome.user);
      }
      stored = false;
      this.publisher?.publish(outcome.events);
      return publicUser(outcome.user);
    } finally {
      if (stored) await this.storage.delete(objectKey).catch(() => undefined);
    }
  }

  clear(userId: string): User {
    const changedAt = this.clock().toISOString();
    const outcome = this.store.immediateTransaction(() => {
      const current = this.store.findUserById(userId);
      if (current === null) throw notFound("User not found");
      if ((current.avatarAttachmentId ?? null) === null && current.avatarUrl === null) {
        return { user: current, events: [] };
      }
      const user = this.store.setUserAvatarAttachment(userId, null, changedAt);
      if (user === null) throw notFound("User not found");
      return {
        user,
        events: appendSyncInvalidations(
          this.store,
          this.store.listProfileProjectionAudienceUserIds(userId),
          "avatar_updated",
          changedAt,
          this.syncInvalidationEnabled
        )
      };
    });
    this.publisher?.publish(outcome.events);
    return publicUser(outcome.user);
  }
}
