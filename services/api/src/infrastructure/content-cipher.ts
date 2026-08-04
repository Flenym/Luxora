import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const PREFIX = "luxora:v1";
const AAD_PREFIX = "luxora-content:v1:";

export interface ContentCipher {
  encrypt(plaintext: string, context?: string): string;
  decrypt(stored: string, context?: string): string;
}

export class PlaintextContentCipher implements ContentCipher {
  encrypt(plaintext: string, _context = "generic"): string {
    return plaintext;
  }

  decrypt(stored: string, _context = "generic"): string {
    return stored;
  }
}

export class AesGcmContentCipher implements ContentCipher {
  readonly #keys = new Map<string, Buffer>();

  constructor(
    encodedKeys: Record<string, string>,
    private readonly activeKeyId: string
  ) {
    for (const [keyId, encoded] of Object.entries(encodedKeys)) {
      const key = Buffer.from(encoded, "base64url");
      if (key.length !== 32) throw new Error(`Encryption key '${keyId}' must be 32 bytes`);
      this.#keys.set(keyId, key);
    }
    if (!this.#keys.has(activeKeyId)) throw new Error("Active encryption key is missing from the keyring");
  }

  encrypt(plaintext: string, context = "generic"): string {
    const key = this.#keys.get(this.activeKeyId) as Buffer;
    const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, nonce);
    cipher.setAAD(Buffer.from(`${AAD_PREFIX}${this.activeKeyId}:${context}`, "utf8"));
    const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    return [
      PREFIX,
      Buffer.from(this.activeKeyId, "utf8").toString("base64url"),
      nonce.toString("base64url"),
      tag.toString("base64url"),
      ciphertext.toString("base64url")
    ].join(".");
  }

  decrypt(stored: string, context = "generic"): string {
    if (!stored.startsWith(`${PREFIX}.`)) return stored;
    const parts = stored.split(".");
    if (parts.length !== 5 || parts[0] !== PREFIX) throw new Error("Encrypted content has an invalid envelope");
    const encodedKeyId = parts[1];
    const encodedNonce = parts[2];
    const encodedTag = parts[3];
    const encodedCiphertext = parts[4];
    if (
      encodedKeyId === undefined ||
      encodedNonce === undefined ||
      encodedTag === undefined ||
      encodedCiphertext === undefined
    ) throw new Error("Encrypted content has an invalid envelope");
    const keyId = Buffer.from(encodedKeyId, "base64url").toString("utf8");
    const key = this.#keys.get(keyId);
    if (key === undefined) throw new Error(`Encryption key '${keyId}' is unavailable`);
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(encodedNonce, "base64url"));
    decipher.setAAD(Buffer.from(`${AAD_PREFIX}${keyId}:${context}`, "utf8"));
    decipher.setAuthTag(Buffer.from(encodedTag, "base64url"));
    return Buffer.concat([
      decipher.update(Buffer.from(encodedCiphertext, "base64url")),
      decipher.final()
    ]).toString("utf8");
  }
}

export function contentCipherFromConfig(
  keys: Record<string, string>,
  activeKeyId: string | undefined
): ContentCipher {
  return activeKeyId === undefined
    ? new PlaintextContentCipher()
    : new AesGcmContentCipher(keys, activeKeyId);
}
