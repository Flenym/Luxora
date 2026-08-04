import { createHash } from "node:crypto";
import { PASSKEY_MAX_RESPONSE_BYTES } from "@luxora/passkey-domain";
import { describe, expect, it } from "vitest";
import { AppError } from "../errors.js";
import { parsePasskeyResponseBody } from "./passkey-response-body.js";

describe("WebAuthn response transport boundary", () => {
  it("derives length and digest from the exact accepted bytes before parsing", () => {
    const compact = Buffer.from('{"id":"credential","type":"public-key"}', "utf8");
    const spaced = Buffer.from('{ "id": "credential", "type": "public-key" }', "utf8");

    const first = parsePasskeyResponseBody(compact);
    const second = parsePasskeyResponseBody(spaced);

    expect(first.credential).toEqual(second.credential);
    expect(first.byteLength).toBe(compact.byteLength);
    expect(first.digest).toBe(createHash("sha256").update(compact).digest("hex"));
    expect(first.digest).not.toBe(second.digest);
  });

  it.each([
    ["non-buffer", { id: "credential" }],
    ["empty", Buffer.alloc(0)],
    ["oversized", Buffer.alloc(PASSKEY_MAX_RESPONSE_BYTES + 1, 0x20)],
    ["invalid UTF-8", Buffer.from([0xc3, 0x28])],
    ["invalid JSON", Buffer.from("{", "utf8")],
    ["JSON array", Buffer.from("[]", "utf8")],
    ["JSON scalar", Buffer.from('"credential"', "utf8")]
  ])("rejects %s input with one content-free error", (_label, body) => {
    let thrown: unknown;
    try {
      parsePasskeyResponseBody(body);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(AppError);
    expect(thrown).toMatchObject({ statusCode: 400, code: "BAD_REQUEST", message: "Malformed WebAuthn response" });
    expect(JSON.stringify(thrown)).not.toContain("credential");
  });
});
