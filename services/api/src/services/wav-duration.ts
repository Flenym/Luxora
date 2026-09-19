/**
 * Zero-dependency measurement of WAV audio duration from file bytes.
 *
 * Used by the upload pipeline to replace client-declared `durationMs` with a
 * measured value before an attachment is marked `server_verified`. The parser
 * walks the RIFF chunk list to find `fmt ` (byte rate) and `data` (payload
 * size), so duration is exact: `dataSize / byteRate * 1000`. Anything
 * unreadable, non-PCM or out of bounds yields `null` and the attachment
 * honestly keeps `client_declared` trust instead of failing the upload.
 *
 * Supported: PCM (0x0001), IEEE float (0x0003) and Extensible (0xFFFE with a
 * PCM/float subformat). Compressed formats (ADPCM, MP3-in-WAV, …), MP3/OGG/
 * FLAC/AAC containers and truncated headers intentionally return `null` —
 * verification coverage is explicit, never assumed.
 */
export interface MeasuredWavDuration {
  durationMs: number;
}

/** Protocol-level bound mirrored from `@luxora/protocol` audio metadata. */
const MAX_DURATION_MS = 86_400_000;

function readAscii(bytes: Buffer, offset: number): string {
  return bytes.subarray(offset, offset + 4).toString("ascii");
}

function validDuration(durationMs: number): MeasuredWavDuration | null {
  if (!Number.isInteger(durationMs)) return null;
  if (durationMs < 1 || durationMs > MAX_DURATION_MS) return null;
  return { durationMs };
}

export function measureWavDuration(bytes: Buffer): MeasuredWavDuration | null {
  if (bytes.length < 44) return null;
  if (readAscii(bytes, 0) !== "RIFF" || readAscii(bytes, 8) !== "WAVE") return null;

  let offset = 12;
  let byteRate: number | null = null;
  let dataSize: number | null = null;

  while (offset + 8 <= bytes.length) {
    const chunkId = readAscii(bytes, offset);
    const chunkSize = bytes.readUInt32LE(offset + 4);
    if (!Number.isSafeInteger(chunkSize)) return null;
    const payloadStart = offset + 8;

    if (chunkId === "fmt ") {
      if (chunkSize < 16 || payloadStart + 16 > bytes.length) return null;
      const formatTag = bytes.readUInt16LE(payloadStart);
      const byteRateValue = bytes.readUInt32LE(payloadStart + 8);
      if (byteRateValue <= 0 || byteRateValue > Number.MAX_SAFE_INTEGER) return null;
      if (formatTag === 0x0001 || formatTag === 0x0003) {
        byteRate = byteRateValue;
      } else if (formatTag === 0xfffe) {
        if (chunkSize < 40 || payloadStart + 40 > bytes.length) return null;
        const subFormat = bytes.readUInt16LE(payloadStart + 24);
        if (subFormat !== 0x0001 && subFormat !== 0x0003) return null;
        byteRate = byteRateValue;
      } else {
        return null;
      }
    } else if (chunkId === "data") {
      dataSize = chunkSize;
    }

    if (byteRate !== null && dataSize !== null) break;
    if (chunkSize > bytes.length) return null;
    offset = payloadStart + chunkSize + (chunkSize % 2);
  }

  if (byteRate === null || dataSize === null) return null;
  if (dataSize > bytes.length) return null;
  return validDuration(Math.round((dataSize / byteRate) * 1000));
}
