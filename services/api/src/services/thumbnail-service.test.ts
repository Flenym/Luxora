import { createHash } from "node:crypto";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { readThumbnailInfo, thumbnailObjectKey, thumbnailPathFor } from "../domain/attachment-thumbnail.js";
import {
  generateImageThumbnail,
  THUMBNAIL_MAX_EDGE_PIXELS
} from "./thumbnail-service.js";

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

const TINY_PNG = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
  0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
  0x89, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x44, 0x41,
  0x54, 0x08, 0x1d, 0x01, 0x1f, 0x00, 0xe0, 0xff,
  0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44,
  0xae, 0x42, 0x60, 0x82
]);

async function bigPng(): Promise<Buffer> {
  return sharp({
    create: { width: 640, height: 480, channels: 3, background: { r: 200, g: 30, b: 40 } }
  }).png().toBuffer();
}

describe("generateImageThumbnail", () => {
  it("skips sources already at or below thumbnail size", async () => {
    expect(await generateImageThumbnail(TINY_PNG, { width: 1, height: 1 })).toBeNull();
  });

  it("returns null for empty sources and undecodable bytes", async () => {
    expect(await generateImageThumbnail(Buffer.alloc(0), null)).toBeNull();
    expect(await generateImageThumbnail(Buffer.from("not an image at all", "utf8"), null)).toBeNull();
  });

  it("produces a bounded JPEG that preserves aspect ratio", async () => {
    const source = await bigPng();
    const thumbnail = await generateImageThumbnail(source, { width: 640, height: 480 });
    expect(thumbnail).not.toBeNull();
    expect(thumbnail!.bytes.subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]));
    expect(thumbnail!.width).toBe(THUMBNAIL_MAX_EDGE_PIXELS);
    expect(thumbnail!.height).toBe(240);
    expect(thumbnail!.width).toBeLessThanOrEqual(THUMBNAIL_MAX_EDGE_PIXELS);
    expect(thumbnail!.height).toBeLessThanOrEqual(THUMBNAIL_MAX_EDGE_PIXELS);
    expect(thumbnail!.sizeBytes).toBe(thumbnail!.bytes.length);
    expect(thumbnail!.sha256).toBe(sha256(thumbnail!.bytes));
    expect(thumbnail!.sizeBytes).toBeLessThan(source.length);
  });

  it("attempts generation when dimensions are unmeasured", async () => {
    const source = await bigPng();
    const thumbnail = await generateImageThumbnail(source, null);
    expect(thumbnail).not.toBeNull();
    expect(thumbnail!.width).toBeLessThanOrEqual(THUMBNAIL_MAX_EDGE_PIXELS);
  });
});

describe("readThumbnailInfo", () => {
  const attachmentId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

  it("reads a valid descriptor and derives the deterministic storage key", () => {
    const info = readThumbnailInfo(attachmentId, {
      width: 640,
      height: 480,
      thumbnail: { sha256: "a".repeat(64), sizeBytes: 1234, width: 320, height: 240 }
    });
    expect(info).toEqual({
      storageKey: `thumbnails/${attachmentId}.jpg`,
      sha256: "a".repeat(64),
      sizeBytes: 1234,
      width: 320,
      height: 240
    });
    expect(thumbnailObjectKey(attachmentId)).toBe(`thumbnails/${attachmentId}.jpg`);
    expect(thumbnailPathFor(attachmentId)).toBe(`/v1/attachments/${attachmentId}/thumbnail`);
  });

  it("fails closed on absent or malformed descriptors", () => {
    expect(readThumbnailInfo(attachmentId, {})).toBeNull();
    expect(readThumbnailInfo(attachmentId, null)).toBeNull();
    expect(readThumbnailInfo("", { thumbnail: { sha256: "a".repeat(64), sizeBytes: 1, width: 1, height: 1 } })).toBeNull();
    expect(readThumbnailInfo(attachmentId, { thumbnail: { sha256: "not-hex", sizeBytes: 1, width: 1, height: 1 } })).toBeNull();
    expect(readThumbnailInfo(attachmentId, { thumbnail: { sha256: "a".repeat(64), sizeBytes: 0, width: 1, height: 1 } })).toBeNull();
    expect(readThumbnailInfo(attachmentId, { thumbnail: { sha256: "a".repeat(64), sizeBytes: 1, width: 40_000, height: 1 } })).toBeNull();
    expect(readThumbnailInfo(attachmentId, { thumbnail: "forged" })).toBeNull();
  });
});
