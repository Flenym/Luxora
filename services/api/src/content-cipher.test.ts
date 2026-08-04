import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";
import { AesGcmContentCipher } from "./infrastructure/content-cipher.js";

describe("content encryption", () => {
  it("encrypts with the active key and decrypts after key rotation", () => {
    const oldKey = randomBytes(32).toString("base64url");
    const newKey = randomBytes(32).toString("base64url");
    const oldCipher = new AesGcmContentCipher({ old: oldKey }, "old");
    const envelope = oldCipher.encrypt("private message");

    expect(envelope).not.toContain("private message");
    const rotatedCipher = new AesGcmContentCipher({ old: oldKey, current: newKey }, "current");
    expect(rotatedCipher.decrypt(envelope)).toBe("private message");
    expect(rotatedCipher.encrypt("new message")).not.toBe(rotatedCipher.encrypt("new message"));
    expect(() => rotatedCipher.decrypt(envelope, "different-record")).toThrow();
  });

  it("rejects tampered ciphertext", () => {
    const cipher = new AesGcmContentCipher({ current: randomBytes(32).toString("base64url") }, "current");
    const envelope = cipher.encrypt("private message");
    const tampered = `${envelope.slice(0, -1)}${envelope.endsWith("A") ? "B" : "A"}`;
    expect(() => cipher.decrypt(tampered)).toThrow();
  });

  it("requires an encryption keyring in production", () => {
    expect(() => loadConfig({
      NODE_ENV: "production",
      JWT_SECRET: "production-secret-with-at-least-thirty-two-bytes"
    })).toThrow(/Production requires DATA_ENCRYPTION_KEYS/);
  });
});
