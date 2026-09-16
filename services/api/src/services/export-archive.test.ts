import { gunzip } from "node:zlib";
import { describe, expect, it } from "vitest";
import { buildManifest, buildTarGzip } from "./export-archive.js";

const BLOCK_SIZE = 512;

function parseTarHeader(bytes: Buffer): {
  name: string;
  prefix: string;
  size: number;
  type: string;
  magic: string;
} {
  return {
    name: bytes.subarray(0, 100).toString("utf8").replace(/\0+$/u, "").trim(),
    prefix: bytes.subarray(345, 500).toString("utf8").replace(/\0+$/u, "").trim(),
    size: parseInt(bytes.subarray(124, 136).toString("ascii").replace(/[^\d]/gu, "").padStart(1, "0"), 8),
    type: String.fromCharCode(bytes[156] ?? 0),
    magic: bytes.subarray(257, 262).toString("ascii")
  };
}

function parseEntries(bytes: Buffer): Array<{ path: string; content: Buffer }> {
  const entries: Array<{ path: string; content: Buffer }> = [];
  let offset = 0;
  while (offset < bytes.length) {
    const header = bytes.subarray(offset, offset + BLOCK_SIZE);
    if (header.every((byte) => byte === 0)) break;
    const parsed = parseTarHeader(header);
    if (parsed.magic !== "ustar") throw new Error("Not a ustar archive");
    offset += BLOCK_SIZE;
    const padded = Math.ceil(parsed.size / BLOCK_SIZE) * BLOCK_SIZE;
    const content = bytes.subarray(offset, offset + parsed.size);
    const fullPath = parsed.prefix === "" ? parsed.name : `${parsed.prefix}/${parsed.name}`;
    entries.push({ path: fullPath, content: Buffer.from(content) });
    offset += padded;
  }
  return entries;
}

function decompress(bytes: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    gunzip(bytes, (error, result) => {
      if (error !== null) reject(error);
      else resolve(result);
    });
  });
}

describe("export archive writer", () => {
  it("produces a gunzippable ustar archive with stable relative paths", async () => {
    const archive = await buildTarGzip([
      { path: "./manifest.json", bytes: buildManifest({
        schemaVersion: 1,
        accountId: "account-id",
        createdAt: "2026-09-15T00:00:00.000Z",
        includedCategories: ["profile"],
        omittedCategories: ["tokens"],
        files: []
      }) },
      { path: "messages.jsonl", bytes: Buffer.from("line one\nline two\n") },
      { path: "media/photo.jpg", bytes: Buffer.from("jpegbytes") }
    ]);
    const plain = await decompress(archive);
    const entries = parseEntries(plain);
    expect(entries.map((entry) => entry.path)).toEqual([
      "manifest.json",
      "media/photo.jpg",
      "messages.jsonl"
    ]);
    expect(entries[0]!.content.toString("utf8")).toContain("\"accountId\": \"account-id\"");
    expect(entries[1]!.content.toString("utf8")).toBe("jpegbytes");
    expect(entries[2]!.content.toString("utf8")).toBe("line one\nline two\n");
  });

  it("sorts entries deterministically and normalizes separators", async () => {
    const archive = await buildTarGzip([
      { path: "z.json", bytes: Buffer.from("z") },
      { path: "a\\b.json", bytes: Buffer.from("ab") }
    ]);
    const plain = await decompress(archive);
    const entries = parseEntries(plain);
    expect(entries.map((entry) => entry.path)).toEqual(["a/b.json", "z.json"]);
  });

  it("rejects directory-looking paths and empty names", async () => {
    await expect(buildTarGzip([{ path: "", bytes: Buffer.from("x") }])).rejects.toThrow("regular files");
    await expect(buildTarGzip([{ path: "folder/", bytes: Buffer.from("x") }])).rejects.toThrow("regular files");
    await expect(buildTarGzip([{ path: ".", bytes: Buffer.from("x") }])).rejects.toThrow("regular files");
  });

  it("handles multibyte names with a prefix split", async () => {
    const longName = `deep/${"segment/".repeat(20)}файл.json`;
    const archive = await buildTarGzip([{ path: longName, bytes: Buffer.from("data") }]);
    const plain = await decompress(archive);
    const entries = parseEntries(plain);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.path).toBe(longName);
    expect(entries[0]!.content.toString("utf8")).toBe("data");
  });
});