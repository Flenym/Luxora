import { createHash } from "node:crypto";
import sharp from "sharp";

/** Long edge of the generated thumbnail; landscape/portrait ratio is preserved. */
export const THUMBNAIL_MAX_EDGE_PIXELS = 320;
export const THUMBNAIL_JPEG_QUALITY = 80;
/** Sources above this size skip thumbnail generation (original stays authoritative). */
export const MAX_THUMBNAIL_SOURCE_BYTES = 20 * 1_024 * 1_024;
const MAX_THUMBNAIL_INPUT_PIXELS = 40_000_000;
const MAX_CONCURRENT_THUMBNAIL_PROCESSORS = 2;

export interface GeneratedThumbnail {
  bytes: Buffer;
  sha256: string;
  sizeBytes: number;
  width: number;
  height: number;
}

export interface MeasuredDimensions {
  width: number;
  height: number;
}

let processingInFlight = 0;
const processingQueue: Array<() => void> = [];

async function acquireSlot(): Promise<void> {
  if (processingInFlight < MAX_CONCURRENT_THUMBNAIL_PROCESSORS) {
    processingInFlight += 1;
    return;
  }
  await new Promise<void>((resolve) => processingQueue.push(resolve));
}

function releaseSlot(): void {
  const next = processingQueue.shift();
  if (next !== undefined) {
    next();
    return;
  }
  processingInFlight = Math.max(0, processingInFlight - 1);
}

/**
 * Best-effort server-side thumbnail for an image upload.
 *
 * Returns null (upload still succeeds, no thumbnail) when the source is too
 * large, already at/below thumbnail size, or undecodable by this build
 * (e.g. HEIC). Never throws for content reasons: the original bytes remain
 * the authoritative artifact.
 */
export async function generateImageThumbnail(
  source: Buffer,
  measured: MeasuredDimensions | null
): Promise<GeneratedThumbnail | null> {
  if (source.length === 0 || source.length > MAX_THUMBNAIL_SOURCE_BYTES) return null;
  if (
    measured !== null &&
    measured.width <= THUMBNAIL_MAX_EDGE_PIXELS &&
    measured.height <= THUMBNAIL_MAX_EDGE_PIXELS
  ) {
    return null;
  }
  await acquireSlot();
  try {
    const { data, info } = await sharp(source, {
      failOn: "warning",
      limitInputPixels: MAX_THUMBNAIL_INPUT_PIXELS,
      pages: 1,
      sequentialRead: true
    })
      .autoOrient()
      .resize(THUMBNAIL_MAX_EDGE_PIXELS, THUMBNAIL_MAX_EDGE_PIXELS, {
        fit: "inside",
        withoutEnlargement: true
      })
      .jpeg({ quality: THUMBNAIL_JPEG_QUALITY })
      .toBuffer({ resolveWithObject: true });
    if (
      info.format !== "jpeg" ||
      info.width <= 0 ||
      info.height <= 0 ||
      info.width > THUMBNAIL_MAX_EDGE_PIXELS ||
      info.height > THUMBNAIL_MAX_EDGE_PIXELS ||
      data.length === 0
    ) {
      return null;
    }
    return {
      bytes: data,
      sha256: createHash("sha256").update(data).digest("hex"),
      sizeBytes: data.length,
      width: info.width,
      height: info.height
    };
  } catch {
    return null;
  } finally {
    releaseSlot();
  }
}
