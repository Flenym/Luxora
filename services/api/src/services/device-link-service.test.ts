import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { deriveSasWords } from "./device-link-service.js";
import { DEVICE_LINK_SAS_WORDS } from "./device-link-wordlist.js";

describe("device link SAS wordlist", () => {
  it("contains exactly 256 unique short lowercase words", () => {
    expect(DEVICE_LINK_SAS_WORDS).toHaveLength(256);
    expect(new Set(DEVICE_LINK_SAS_WORDS).size).toBe(256);
    for (const word of DEVICE_LINK_SAS_WORDS) {
      expect(word).toMatch(/^[a-z]{1,16}$/u);
    }
  });
});

describe("deriveSasWords", () => {
  const secretHash = createHash("sha256").update("secret", "utf8").digest("hex");

  it("is deterministic and bound to secret and approver", () => {
    const first = deriveSasWords(secretHash, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
    expect(first).toHaveLength(4);
    for (const word of first) expect(DEVICE_LINK_SAS_WORDS).toContain(word);
    expect(deriveSasWords(secretHash, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")).toEqual(first);
    expect(deriveSasWords(secretHash, "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb")).not.toEqual(first);
    expect(deriveSasWords(createHash("sha256").update("other", "utf8").digest("hex"), "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"))
      .not.toEqual(first);
  });
});
