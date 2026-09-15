/**
 * Zero-dependency measurement of image dimensions from leading file bytes.
 *
 * Used by the upload pipeline to verify client-declared `width`/`height`
 * before an attachment is marked `server_verified`. Only the inspected
 * prefix (bounded to 8 KiB by the caller) is read, so every parser below is
 * truncation-safe: anything unreadable yields `null` and the attachment
 * honestly keeps `client_declared` trust instead of failing the upload.
 *
 * Supported: PNG, GIF, WebP (VP8/VP8L/VP8X), JPEG (SOF markers). AVIF/HEIC
 * and exotic variants intentionally return `null` — verification coverage
 * is explicit, never assumed.
 */
export interface MeasuredImageDimensions {
  width: number;
  height: number;
}

/** Protocol-level bound mirrored from `@luxora/protocol` image metadata. */
const MAX_DIMENSION = 32_768;

function validDimensions(width: number, height: number): MeasuredImageDimensions | null {
  if (!Number.isInteger(width) || !Number.isInteger(height)) return null;
  if (width < 1 || height < 1 || width > MAX_DIMENSION || height > MAX_DIMENSION) return null;
  return { width, height };
}

function measurePng(prefix: Buffer): MeasuredImageDimensions | null {
  if (prefix.length < 24) return null;
  if (
    prefix[0] !== 0x89 || prefix[1] !== 0x50 || prefix[2] !== 0x4e || prefix[3] !== 0x47 ||
    prefix[4] !== 0x0d || prefix[5] !== 0x0a || prefix[6] !== 0x1a || prefix[7] !== 0x0a
  ) return null;
  if (prefix.toString("ascii", 12, 16) !== "IHDR") return null;
  return validDimensions(prefix.readUInt32BE(16), prefix.readUInt32BE(20));
}

function measureGif(prefix: Buffer): MeasuredImageDimensions | null {
  if (prefix.length < 10) return null;
  const signature = prefix.toString("ascii", 0, 6);
  if (signature !== "GIF87a" && signature !== "GIF89a") return null;
  return validDimensions(prefix.readUInt16LE(6), prefix.readUInt16LE(8));
}

function measureWebp(prefix: Buffer): MeasuredImageDimensions | null {
  if (prefix.length < 12) return null;
  if (prefix.toString("ascii", 0, 4) !== "RIFF" || prefix.toString("ascii", 8, 12) !== "WEBP") {
    return null;
  }
  let offset = 12;
  for (let chunks = 0; chunks < 8 && offset + 8 <= prefix.length; chunks += 1) {
    const fourCC = prefix.toString("ascii", offset, offset + 4);
    const size = prefix.readUInt32LE(offset + 4);
    const data = offset + 8;
    if (fourCC === "VP8X") {
      if (data + 10 > prefix.length) return null;
      const widthMinusOne = prefix.readUIntLE(data + 4, 3);
      const heightMinusOne = prefix.readUIntLE(data + 7, 3);
      return validDimensions(widthMinusOne + 1, heightMinusOne + 1);
    }
    if (fourCC === "VP8L") {
      if (data + 5 > prefix.length) return null;
      if (prefix.readUInt8(data) !== 0x2f) return null;
      const packed = prefix.readUInt32LE(data + 1);
      return validDimensions((packed & 0x3fff) + 1, ((packed >> 14) & 0x3fff) + 1);
    }
    if (fourCC === "VP8 ") {
      if (data + 10 > prefix.length) return null;
      if (prefix[data + 3] !== 0x9d || prefix[data + 4] !== 0x01 || prefix[data + 5] !== 0x2a) {
        return null;
      }
      const width = prefix.readUInt16LE(data + 6) & 0x3fff;
      const height = prefix.readUInt16LE(data + 8) & 0x3fff;
      return validDimensions(width, height);
    }
    const padded = size + (size % 2);
    if (padded > 16_777_216) return null;
    offset = data + padded;
  }
  return null;
}

function isStartOfFrame(marker: number): boolean {
  return (
    (marker >= 0xc0 && marker <= 0xc3) ||
    (marker >= 0xc5 && marker <= 0xc7) ||
    (marker >= 0xc9 && marker <= 0xcb) ||
    (marker >= 0xcd && marker <= 0xcf)
  );
}

function measureJpeg(prefix: Buffer): MeasuredImageDimensions | null {
  if (prefix.length < 4) return null;
  if (prefix[0] !== 0xff || prefix[1] !== 0xd8) return null;
  let offset = 2;
  for (let segments = 0; segments < 64 && offset + 1 < prefix.length; segments += 1) {
    if (prefix.readUInt8(offset) !== 0xff) return null;
    let marker = prefix.readUInt8(offset + 1);
    let cursor = offset + 2;
    while (marker === 0xff) {
      if (cursor >= prefix.length) return null;
      marker = prefix.readUInt8(cursor);
      cursor += 1;
    }
    const header = cursor - 2;
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
      offset = cursor;
      continue;
    }
    if (marker === 0xd9 || marker === 0xda) return null;
    if (isStartOfFrame(marker)) {
      if (header + 9 > prefix.length) return null;
      return validDimensions(prefix.readUInt16BE(header + 7), prefix.readUInt16BE(header + 5));
    }
    if (header + 4 > prefix.length) return null;
    const length = prefix.readUInt16BE(header + 2);
    if (length < 2) return null;
    offset = header + length + 2;
  }
  return null;
}

export function measureImageDimensions(prefix: Buffer): MeasuredImageDimensions | null {
  return measurePng(prefix) ?? measureGif(prefix) ?? measureWebp(prefix) ?? measureJpeg(prefix);
}
