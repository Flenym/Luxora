/**
 * Server-generated image thumbnail descriptor.
 *
 * The thumbnail bytes live in object storage under a deterministic key
 * derived from the attachment id (`thumbnailObjectKey`); the key itself is
 * never stored nor exposed. Clients see only the public `thumbnailPath`
 * (never a storage key) via `AttachmentSchema`, plus dimensions for layout.
 * The descriptor is stored inside the encrypted attachment `metadata` JSON
 * under the `thumbnail` key and is always written by the server at upload
 * completion — client-supplied values are discarded.
 */
export interface AttachmentThumbnailInfo {
  storageKey: string;
  sha256: string;
  sizeBytes: number;
  width: number;
  height: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isHex64(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}

function isPositiveInt(value: unknown, max: number): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value <= max;
}

function isStorageKey(value: unknown): value is string {
  return typeof value === "string" &&
    value.length > 0 &&
    value.length <= 512 &&
    !value.includes("\0") &&
    !value.includes("..");
}

export function thumbnailObjectKey(attachmentId: string): string {
  return `thumbnails/${attachmentId}.jpg`;
}

/**
 * Reads a structurally valid thumbnail descriptor from attachment metadata.
 * Returns null when absent or malformed (forged/legacy rows fail closed).
 */
export function readThumbnailInfo(attachmentId: string, metadata: unknown): AttachmentThumbnailInfo | null {
  if (typeof attachmentId !== "string" || attachmentId.length === 0) return null;
  if (!isRecord(metadata)) return null;
  const raw = metadata["thumbnail"];
  if (!isRecord(raw)) return null;
  if (
    !isHex64(raw["sha256"]) ||
    !isPositiveInt(raw["sizeBytes"], Number.MAX_SAFE_INTEGER) ||
    !isPositiveInt(raw["width"], 32_768) ||
    !isPositiveInt(raw["height"], 32_768)
  ) {
    return null;
  }
  const storageKey = thumbnailObjectKey(attachmentId);
  if (!isStorageKey(storageKey)) return null;
  return {
    storageKey,
    sha256: raw["sha256"],
    sizeBytes: raw["sizeBytes"],
    width: raw["width"],
    height: raw["height"]
  };
}

export function thumbnailPathFor(attachmentId: string): string {
  return `/v1/attachments/${attachmentId}/thumbnail`;
}
