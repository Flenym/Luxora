import { createGzip } from "node:zlib";
import type { Readable } from "node:stream";

const BLOCK_SIZE = 512;
const NAME_SIZE = 100;
const PREFIX_SIZE = 155;

export interface TarEntryInput {
  path: string;
  bytes: Buffer;
  mode?: number;
}

function octal(value: number, length: number): Buffer {
  const text = value.toString(8).padStart(length - 1, "0");
  const bytes = Buffer.alloc(length, 0x20);
  Buffer.from(text, "ascii").copy(bytes, 0);
  bytes[length - 1] = 0;
  return bytes;
}

function splitName(path: string): { prefix: string | null; name: string } {
  if (Buffer.byteLength(path, "utf8") <= NAME_SIZE) return { prefix: null, name: path };
  const segments = path.split("/");
  for (let index = 1; index < segments.length; index += 1) {
    const prefix = segments.slice(0, index).join("/");
    const name = segments.slice(index).join("/");
    if (Buffer.byteLength(prefix, "utf8") <= PREFIX_SIZE && Buffer.byteLength(name, "utf8") <= NAME_SIZE) {
      return { prefix, name };
    }
  }
  throw new Error(`Export archive path is too long: ${path}`);
}

function ustarHeader(entry: TarEntryInput): Buffer {
  const header = Buffer.alloc(BLOCK_SIZE);
  const { prefix, name } = splitName(entry.path);
  Buffer.from(name, "utf8").copy(header, 0, 0, NAME_SIZE);
  header.write("0000644", 100, 7, "ascii");
  header.write("0000000", 108, 7, "ascii");
  header.write("0000000", 116, 7, "ascii");
  octal(entry.bytes.length, 12).copy(header, 124);
  octal(Math.floor(Date.now() / 1000), 12).copy(header, 136);
  header.fill(0x20, 148, 156);
  header.write("0", 156, 1, "ascii");
  header.write("ustar", 257, 5, "ascii");
  header.write("00", 263, 2, "ascii");
  if (prefix !== null) Buffer.from(prefix, "utf8").copy(header, 345, 0, PREFIX_SIZE);
  writeChecksum(header);
  return header;
}

function writeChecksum(header: Buffer): void {
  header.fill(0x20, 148, 156);
  let checksum = 0;
  for (const byte of header) checksum += byte;
  header.write(checksum.toString(8).padStart(6, "0"), 148, 6, "ascii");
  header[154] = 0;
  header[155] = 0x20;
}

/**
 * Builds a gzip-compressed POSIX ustar archive from the given in-memory
 * entries. Paths are normalized to forward slashes without leading `./` so
 * extraction tools see stable relative paths. The final zero blocks are two
 * 512-byte records as required by the format.
 */
export async function buildTarGzip(entries: TarEntryInput[]): Promise<Buffer> {
  const normalized = entries.map((entry) => ({
    ...entry,
    path: entry.path.replace(/\\/g, "/").replace(/^\.\//u, "").replace(/\/{2,}/g, "/")
  }));
  normalized.sort((left, right) => left.path.localeCompare(right.path));

  const payload: Buffer[] = [];
  for (const entry of normalized) {
    if (entry.path === "" || entry.path === "." || entry.path.endsWith("/")) {
      throw new Error("Export archive entries must be regular files");
    }
    const header = ustarHeader(entry);
    payload.push(header);
    if (entry.bytes.length > 0) {
      const padded = Math.ceil(entry.bytes.length / BLOCK_SIZE) * BLOCK_SIZE;
      const body = Buffer.alloc(padded);
      entry.bytes.copy(body);
      payload.push(body);
    }
  }
  payload.push(Buffer.alloc(BLOCK_SIZE * 2));

  return new Promise((resolve, reject) => {
    const gzip = createGzip({ level: 9 });
    const chunks: Buffer[] = [];
    gzip.on("data", (chunk: Buffer) => chunks.push(chunk));
    gzip.on("end", () => resolve(Buffer.concat(chunks)));
    gzip.on("error", reject);
    for (const part of payload) gzip.write(part);
    gzip.end();
  });
}

export function buildManifest(options: {
  schemaVersion: number;
  accountId: string;
  createdAt: string;
  includedCategories: string[];
  omittedCategories: string[];
  files: Array<{ path: string; sha256: string; mimeType: string; sizeBytes: number }>;
}): Buffer {
  return Buffer.from(JSON.stringify(options, null, 2), "utf8");
}

export function readableToBuffer(stream: Readable): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    stream.on("data", (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
    stream.on("end", () => resolve(Buffer.concat(chunks)));
    stream.on("error", reject);
  });
}