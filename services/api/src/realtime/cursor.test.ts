import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { REALTIME_CURSOR_TTL_SECONDS } from "@luxora/protocol";
import { RealtimeCursorCodec } from "./cursor.js";

const USER_ID = "9ec9347c-9306-4108-aab4-e7762b73b201";
const SESSION_ID = "a0df9334-2ec0-422d-b5de-11c775a42344";
const OTHER_USER_ID = "b650e2ab-4185-493d-81a2-bd4f19b84f0c";
const OTHER_SESSION_ID = "c8d4c075-17f5-4c8d-a447-9216972c4864";
const ISSUED_AT = new Date("2026-08-03T12:00:00.000Z");
const SECRET = "test-only-secret-with-at-least-thirty-two-bytes";

function signedCursorWithClaims(userId: string, sessionId: string): string {
  const payload = Buffer.from(JSON.stringify([
    1,
    userId,
    sessionId,
    42,
    Math.floor(ISSUED_AT.getTime() / 1_000)
  ]), "utf8").toString("base64url");
  const signature = createHmac("sha256", SECRET)
    .update("luxora:realtime-cursor:v1\0", "utf8")
    .update(payload, "ascii")
    .digest("base64url");
  return `luxora-rt1.${payload}.${signature}`;
}

describe("RealtimeCursorCodec", () => {
  it("round-trips an authenticated account/session/sequence scope", () => {
    const codec = new RealtimeCursorCodec(SECRET);
    const issued = codec.issue(USER_ID, SESSION_ID, 42, ISSUED_AT);
    expect(codec.verify(issued.cursor, USER_ID, SESSION_ID, ISSUED_AT)).toEqual({
      ok: true,
      sequence: 42,
      issuedAt: ISSUED_AT,
      expiresAt: new Date((ISSUED_AT.getTime() / 1_000 + REALTIME_CURSOR_TTL_SECONDS) * 1_000)
    });
  });

  it("canonicalizes mixed-case issued, parsed, and expected scope without widening it", () => {
    const codec = new RealtimeCursorCodec(SECRET);
    const issued = codec.issue(USER_ID.toUpperCase(), SESSION_ID.toUpperCase(), 42, ISSUED_AT);
    const encodedClaims = issued.cursor.split(".")[1] as string;
    const claims = JSON.parse(Buffer.from(encodedClaims, "base64url").toString("utf8")) as unknown[];

    expect(claims[1]).toBe(USER_ID);
    expect(claims[2]).toBe(SESSION_ID);
    expect(codec.verify(
      issued.cursor,
      USER_ID.toUpperCase(),
      SESSION_ID.toUpperCase(),
      ISSUED_AT
    )).toMatchObject({ ok: true, sequence: 42 });

    const mixedClaimsCursor = signedCursorWithClaims(USER_ID.toUpperCase(), SESSION_ID.toUpperCase());
    expect(codec.verify(mixedClaimsCursor, USER_ID, SESSION_ID, ISSUED_AT)).toMatchObject({
      ok: true,
      sequence: 42
    });
    expect(codec.verify(
      mixedClaimsCursor,
      OTHER_USER_ID.toUpperCase(),
      SESSION_ID.toUpperCase(),
      ISSUED_AT
    )).toEqual({ ok: false, reason: "cursor_scope_mismatch" });
    expect(codec.verify(mixedClaimsCursor, "not-a-user-id", SESSION_ID, ISSUED_AT)).toEqual({
      ok: false,
      reason: "cursor_scope_mismatch"
    });
  });

  it("rejects tampering before interpreting claims and keeps foreign scope generic", () => {
    const codec = new RealtimeCursorCodec("test-only-secret-with-at-least-thirty-two-bytes");
    const issued = codec.issue(USER_ID, SESSION_ID, 42, ISSUED_AT);
    const replacement = issued.cursor.endsWith("a") ? "b" : "a";
    const tampered = `${issued.cursor.slice(0, -1)}${replacement}`;
    expect(codec.verify(tampered, USER_ID, SESSION_ID, ISSUED_AT)).toEqual({
      ok: false,
      reason: "cursor_invalid"
    });
    expect(codec.verify(issued.cursor, OTHER_USER_ID, OTHER_SESSION_ID, ISSUED_AT)).toEqual({
      ok: false,
      reason: "cursor_scope_mismatch"
    });
    expect(codec.verify(issued.cursor, USER_ID, OTHER_SESSION_ID, ISSUED_AT)).toEqual({
      ok: false,
      reason: "cursor_scope_mismatch"
    });
    expect(codec.verify(issued.cursor, OTHER_USER_ID, SESSION_ID, ISSUED_AT)).toEqual({
      ok: false,
      reason: "cursor_scope_mismatch"
    });
  });

  it("rejects non-canonical base64url signature aliases", () => {
    const codec = new RealtimeCursorCodec("test-only-secret-with-at-least-thirty-two-bytes");
    const issued = codec.issue(USER_ID, SESSION_ID, 42, ISSUED_AT);
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    const lastCharacter = issued.cursor.at(-1) as string;
    const lastIndex = alphabet.indexOf(lastCharacter);
    const aliasIndex = (lastIndex & 0b11_1100) | ((lastIndex + 1) & 0b00_0011);
    const aliasCharacter = alphabet[aliasIndex] as string;
    const aliased = `${issued.cursor.slice(0, -1)}${aliasCharacter}`;
    const originalSignature = issued.cursor.split(".")[2] as string;
    const aliasedSignature = aliased.split(".")[2] as string;

    expect(aliasCharacter).not.toBe(lastCharacter);
    expect(Buffer.from(aliasedSignature, "base64url")).toEqual(
      Buffer.from(originalSignature, "base64url")
    );
    expect(codec.verify(aliased, USER_ID, SESSION_ID, ISSUED_AT)).toEqual({
      ok: false,
      reason: "cursor_invalid"
    });
  });

  it("applies the seven-day logical retention boundary deterministically", () => {
    const codec = new RealtimeCursorCodec("test-only-secret-with-at-least-thirty-two-bytes");
    const issued = codec.issue(USER_ID, SESSION_ID, 42, ISSUED_AT);
    const justBeforeExpiry = new Date(
      ISSUED_AT.getTime() + REALTIME_CURSOR_TTL_SECONDS * 1_000 - 1
    );
    const exactExpiry = new Date(
      ISSUED_AT.getTime() + REALTIME_CURSOR_TTL_SECONDS * 1_000
    );
    const afterExpiry = new Date(
      ISSUED_AT.getTime() + (REALTIME_CURSOR_TTL_SECONDS + 1) * 1_000
    );
    expect(codec.verify(issued.cursor, USER_ID, SESSION_ID, justBeforeExpiry)).toMatchObject({
      ok: true,
      sequence: 42
    });
    expect(codec.verify(issued.cursor, USER_ID, SESSION_ID, exactExpiry)).toEqual({
      ok: false,
      reason: "cursor_expired"
    });
    expect(codec.verify(issued.cursor, USER_ID, SESSION_ID, afterExpiry)).toEqual({
      ok: false,
      reason: "cursor_expired"
    });
  });

  it("bounds future clock skew and refuses unsafe issue inputs", () => {
    const codec = new RealtimeCursorCodec("test-only-secret-with-at-least-thirty-two-bytes");
    const tolerated = codec.issue(
      USER_ID,
      SESSION_ID,
      42,
      new Date(ISSUED_AT.getTime() + 30_000)
    );
    const future = codec.issue(
      USER_ID,
      SESSION_ID,
      42,
      new Date(ISSUED_AT.getTime() + 31_000)
    );

    expect(codec.verify(tolerated.cursor, USER_ID, SESSION_ID, ISSUED_AT)).toMatchObject({
      ok: true,
      sequence: 42
    });
    expect(codec.verify(future.cursor, USER_ID, SESSION_ID, ISSUED_AT)).toEqual({
      ok: false,
      reason: "cursor_invalid"
    });
    expect(() => codec.issue(USER_ID, SESSION_ID, -1, ISSUED_AT)).toThrow();
    expect(() => codec.issue(
      USER_ID,
      SESSION_ID,
      Number.MAX_SAFE_INTEGER + 1,
      ISSUED_AT
    )).toThrow();
    expect(() => codec.issue(USER_ID, SESSION_ID, 0, new Date(Number.NaN))).toThrow();
    expect(codec.verify(tolerated.cursor, USER_ID, SESSION_ID, new Date(Number.NaN))).toEqual({
      ok: false,
      reason: "cursor_invalid"
    });
  });
});
