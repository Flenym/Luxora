import { describe, expect, it } from "vitest";
import { measureWavDuration } from "./wav-duration.js";

function wavBytes(options: {
  formatTag?: number;
  channels?: number;
  sampleRate?: number;
  bitsPerSample?: number;
  dataSize?: number;
  extraChunks?: Buffer[];
  subFormat?: number;
}): Buffer {
  const formatTag = options.formatTag ?? 0x0001;
  const channels = options.channels ?? 1;
  const sampleRate = options.sampleRate ?? 8000;
  const bitsPerSample = options.bitsPerSample ?? 16;
  const dataSize = options.dataSize ?? 16000;
  const blockAlign = Math.floor((channels * bitsPerSample) / 8);
  const byteRate = sampleRate * blockAlign;

  const fmtPayload = Buffer.alloc(formatTag === 0xfffe ? 40 : 16);
  fmtPayload.writeUInt16LE(formatTag, 0);
  fmtPayload.writeUInt16LE(channels, 2);
  fmtPayload.writeUInt32LE(sampleRate, 4);
  fmtPayload.writeUInt32LE(byteRate, 8);
  fmtPayload.writeUInt16LE(blockAlign, 12);
  fmtPayload.writeUInt16LE(bitsPerSample, 14);
  if (formatTag === 0xfffe) {
    fmtPayload.writeUInt16LE(22, 16);
    fmtPayload.writeUInt16LE(0x0016, 18);
    fmtPayload.writeUInt16LE(0x0000, 20);
    fmtPayload.writeUInt32LE(0x00000000, 22);
    fmtPayload.writeUInt16LE(options.subFormat ?? 0x0001, 24);
  }
  const fmtChunk = Buffer.concat([Buffer.from("fmt ", "ascii"), Buffer.alloc(4), fmtPayload]);
  fmtChunk.writeUInt32LE(fmtPayload.length, 4);

  const dataHeader = Buffer.alloc(8);
  Buffer.from("data", "ascii").copy(dataHeader, 0);
  dataHeader.writeUInt32LE(dataSize, 4);

  const head = Buffer.alloc(12);
  Buffer.from("RIFF", "ascii").copy(head, 0);
  Buffer.from("WAVE", "ascii").copy(head, 8);

  const body = Buffer.concat([
    ...(options.extraChunks ?? []),
    fmtChunk,
    dataHeader,
    Buffer.alloc(dataSize)
  ]);
  head.writeUInt32LE(4 + body.length, 4);
  return Buffer.concat([head, body]);
}

describe("measureWavDuration", () => {
  it("measures PCM mono 8kHz 16-bit duration exactly", () => {
    expect(measureWavDuration(wavBytes({ dataSize: 16000 }))).toEqual({ durationMs: 1000 });
    expect(measureWavDuration(wavBytes({ dataSize: 8000 }))).toEqual({ durationMs: 500 });
  });

  it("handles stereo, float and extensible subformats", () => {
    expect(measureWavDuration(wavBytes({ channels: 2, dataSize: 32000 }))).toEqual({ durationMs: 1000 });
    expect(measureWavDuration(wavBytes({ formatTag: 0x0003, bitsPerSample: 32, dataSize: 32000 }))).toEqual({ durationMs: 1000 });
    expect(measureWavDuration(wavBytes({ formatTag: 0xfffe, dataSize: 16000 }))).toEqual({ durationMs: 1000 });
  });

  it("skips leading chunks such as LIST", () => {
    const list = Buffer.concat([
      Buffer.from("LIST", "ascii"),
      Buffer.from([4, 0, 0, 0]),
      Buffer.from("INFO", "ascii")
    ]);
    expect(measureWavDuration(wavBytes({ dataSize: 16000, extraChunks: [list] }))).toEqual({ durationMs: 1000 });
  });

  it("returns null for compressed, empty, truncated or non-WAV bytes", () => {
    expect(measureWavDuration(wavBytes({ formatTag: 0x0002, dataSize: 16000 }))).toBeNull();
    expect(measureWavDuration(wavBytes({ formatTag: 0xfffe, subFormat: 0x0002, dataSize: 16000 }))).toBeNull();
    expect(measureWavDuration(wavBytes({ dataSize: 0 }))).toBeNull();
    expect(measureWavDuration(Buffer.alloc(0))).toBeNull();
    expect(measureWavDuration(Buffer.from("definitely not audio", "utf8"))).toBeNull();
    const truncated = wavBytes({ dataSize: 16000 }).subarray(0, 30);
    expect(measureWavDuration(truncated)).toBeNull();
    const lyingSize = wavBytes({ dataSize: 16000 });
    lyingSize.writeUInt32LE(0xffff_ffff, 44 - 4);
    expect(measureWavDuration(lyingSize)).toBeNull();
  });
});
