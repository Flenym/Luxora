import { describe, expect, it } from "vitest";
import { measureImageDimensions } from "./image-dimensions.js";

function png(width: number, height: number): Buffer {
  const buffer = Buffer.alloc(33, 0);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buffer, 0);
  buffer.writeUInt32BE(13, 8);
  buffer.write("IHDR", 12, "ascii");
  buffer.writeUInt32BE(width, 16);
  buffer.writeUInt32BE(height, 20);
  return buffer;
}

function gif(width: number, height: number, version = "89a"): Buffer {
  const buffer = Buffer.alloc(10, 0);
  buffer.write(`GIF${version}`, 0, "ascii");
  buffer.writeUInt16LE(width, 6);
  buffer.writeUInt16LE(height, 8);
  return buffer;
}

function webpVp8x(width: number, height: number): Buffer {
  const buffer = Buffer.alloc(30, 0);
  buffer.write("RIFF", 0, "ascii");
  buffer.writeUInt32LE(22, 4);
  buffer.write("WEBPVP8X", 8, "ascii");
  buffer.writeUInt32LE(10, 16);
  buffer.writeUIntLE(width - 1, 24, 3);
  buffer.writeUIntLE(height - 1, 24 + 3, 3);
  return buffer;
}

function webpVp8l(width: number, height: number): Buffer {
  const buffer = Buffer.alloc(25, 0);
  buffer.write("RIFF", 0, "ascii");
  buffer.write("WEBP", 8, "ascii");
  buffer.write("VP8L", 12, "ascii");
  buffer.writeUInt32LE(7, 16);
  buffer[20] = 0x2f;
  buffer.writeUInt32LE(((height - 1) << 14) | (width - 1), 21);
  return buffer;
}

function webpVp8(width: number, height: number): Buffer {
  const buffer = Buffer.alloc(30, 0);
  buffer.write("RIFF", 0, "ascii");
  buffer.write("WEBP", 8, "ascii");
  buffer.write("VP8 ", 12, "ascii");
  buffer.writeUInt32LE(14, 16);
  buffer.set([0x9d, 0x01, 0x2a], 23);
  buffer.writeUInt16LE(width, 26);
  buffer.writeUInt16LE(height, 28);
  return buffer;
}

function jpeg(width: number, height: number, progressive = false): Buffer {
  const buffer = Buffer.alloc(64, 0);
  let offset = 0;
  buffer[offset++] = 0xff;
  buffer[offset++] = 0xd8;
  buffer[offset++] = 0xff;
  buffer[offset++] = 0xe0;
  buffer.writeUInt16BE(16, offset);
  offset += 2;
  buffer.write("JFIF\0", offset, "ascii");
  offset += 14;
  const sof = progressive ? 0xc2 : 0xc0;
  buffer[offset++] = 0xff;
  buffer[offset++] = sof;
  buffer.writeUInt16BE(11, offset);
  offset += 2;
  buffer[offset++] = 8;
  buffer.writeUInt16BE(height, offset);
  offset += 2;
  buffer.writeUInt16BE(width, offset);
  return buffer.subarray(0, offset + 2);
}

describe("measureImageDimensions", () => {
  it("measures PNG from the IHDR chunk", () => {
    expect(measureImageDimensions(png(1, 1))).toEqual({ width: 1, height: 1 });
    expect(measureImageDimensions(png(640, 480))).toEqual({ width: 640, height: 480 });
  });

  it("measures GIF87a and GIF89a", () => {
    expect(measureImageDimensions(gif(320, 200, "87a"))).toEqual({ width: 320, height: 200 });
    expect(measureImageDimensions(gif(320, 200, "89a"))).toEqual({ width: 320, height: 200 });
  });

  it("measures every WebP container variant", () => {
    expect(measureImageDimensions(webpVp8x(550, 368))).toEqual({ width: 550, height: 368 });
    expect(measureImageDimensions(webpVp8l(129, 77))).toEqual({ width: 129, height: 77 });
    expect(measureImageDimensions(webpVp8(800, 600))).toEqual({ width: 800, height: 600 });
  });

  it("measures baseline and progressive JPEG after APP segments", () => {
    expect(measureImageDimensions(jpeg(1920, 1080))).toEqual({ width: 1920, height: 1080 });
    expect(measureImageDimensions(jpeg(1920, 1080, true))).toEqual({ width: 1920, height: 1080 });
  });

  it("returns null for truncated or non-image bytes", () => {
    expect(measureImageDimensions(Buffer.alloc(0))).toBeNull();
    expect(measureImageDimensions(Buffer.from([1, 2, 3, 4]))).toBeNull();
    expect(measureImageDimensions(png(4, 4).subarray(0, 20))).toBeNull();
    const truncatedJpeg = jpeg(100, 100).subarray(0, 10);
    expect(measureImageDimensions(truncatedJpeg)).toBeNull();
    const badSignature = png(4, 4);
    badSignature[0] = 0x00;
    expect(measureImageDimensions(badSignature)).toBeNull();
  });

  it("returns null for degenerate dimensions instead of trusting them", () => {
    expect(measureImageDimensions(png(0, 10))).toBeNull();
    expect(measureImageDimensions(gif(10, 0))).toBeNull();
  });
});
