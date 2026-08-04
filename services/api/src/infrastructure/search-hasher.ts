import { createHmac, hkdfSync } from "node:crypto";

const TOKEN_PATTERN = /[\p{L}\p{N}][\p{L}\p{N}_-]*/gu;
const MAX_INDEX_TOKENS = 512;
const MAX_QUERY_TERMS = 12;

function tokenize(value: string, limit: number): string[] {
  const normalized = value.normalize("NFKC").toLocaleLowerCase("und");
  const matches = normalized.match(TOKEN_PATTERN) ?? [];
  return [...new Set(matches.filter((token) => token.length <= 64))].slice(0, limit);
}

export class SearchHasher {
  readonly #keys = new Map<string, Buffer>();

  constructor(
    encodedKeys: Record<string, string>,
    private readonly activeKeyId: string | undefined
  ) {
    for (const [keyId, encoded] of Object.entries(encodedKeys)) {
      const master = Buffer.from(encoded, "base64url");
      const key = Buffer.from(hkdfSync(
        "sha256",
        master,
        Buffer.from("luxora-search-salt-v1", "utf8"),
        Buffer.from(`luxora-search:${keyId}`, "utf8"),
        32
      ));
      this.#keys.set(keyId, key);
    }
  }

  get available(): boolean {
    return this.activeKeyId !== undefined && this.#keys.has(this.activeKeyId);
  }

  get keyId(): string | undefined {
    return this.available ? this.activeKeyId : undefined;
  }

  index(value: string): Array<{ keyId: string; hash: string }> {
    if (!this.available || this.activeKeyId === undefined) return [];
    const key = this.#keys.get(this.activeKeyId) as Buffer;
    return tokenize(value, MAX_INDEX_TOKENS).map((token) => ({
      keyId: this.activeKeyId as string,
      hash: createHmac("sha256", key).update(token, "utf8").digest("base64url")
    }));
  }

  query(value: string): { hashes: string[]; termCount: number } {
    const terms = tokenize(value, MAX_QUERY_TERMS);
    const hashes: string[] = [];
    for (const term of terms) {
      for (const key of this.#keys.values()) {
        hashes.push(createHmac("sha256", key).update(term, "utf8").digest("base64url"));
      }
    }
    return { hashes, termCount: terms.length };
  }
}
