import { createHmac, timingSafeEqual } from "node:crypto";
import {
  IdSchema,
  REALTIME_CURSOR_TTL_SECONDS,
  RealtimeCursorSchema,
  type RealtimeCursor,
  type RealtimeSyncRequiredReason
} from "@luxora/protocol";

const CURSOR_PREFIX = "luxora-rt1";
const CURSOR_VERSION = 1;
const MAX_FUTURE_CLOCK_SKEW_SECONDS = 30;

type CursorFailureReason = Exclude<RealtimeSyncRequiredReason, "backpressure" | "replay_window_exceeded">;

interface CursorClaims {
  version: number;
  userId: string;
  sessionId: string;
  sequence: number;
  issuedAtSeconds: number;
}

export type RealtimeCursorVerification =
  | { ok: true; sequence: number; issuedAt: Date; expiresAt: Date }
  | { ok: false; reason: CursorFailureReason };

export interface IssuedRealtimeCursor {
  cursor: RealtimeCursor;
  expiresAt: Date;
}

/**
 * Authenticated, domain-separated cursor codec for the v2 account stream.
 *
 * The global numeric sequence remains an implementation watermark and is not
 * accepted as proof of stream scope. The signed claims bind a cursor to the
 * authenticated account and device session. Cursor expiry is a logical replay
 * boundary; old encrypted rows may remain until a separate storage-retention
 * job is implemented.
 */
export class RealtimeCursorCodec {
  readonly #secret: string;
  readonly #clock: () => Date;

  constructor(secret: string, clock: () => Date = () => new Date()) {
    this.#secret = secret;
    this.#clock = clock;
  }

  issue(userId: string, sessionId: string, sequence: number, issuedAt = this.#clock()): IssuedRealtimeCursor {
    const validUserId = IdSchema.parse(userId);
    const validSessionId = IdSchema.parse(sessionId);
    if (!Number.isSafeInteger(sequence) || sequence < 0) {
      throw new Error("Realtime cursor sequence must be a non-negative safe integer");
    }
    const issuedAtSeconds = Math.floor(issuedAt.getTime() / 1_000);
    if (!Number.isSafeInteger(issuedAtSeconds) || issuedAtSeconds < 0) {
      throw new Error("Realtime cursor issue time must be a valid post-epoch timestamp");
    }
    const expiresAt = new Date((issuedAtSeconds + REALTIME_CURSOR_TTL_SECONDS) * 1_000);
    if (Number.isNaN(expiresAt.getTime())) {
      throw new Error("Realtime cursor expiry is outside the supported timestamp range");
    }
    const payload = Buffer.from(JSON.stringify([
      CURSOR_VERSION,
      validUserId,
      validSessionId,
      sequence,
      issuedAtSeconds
    ]), "utf8").toString("base64url");
    const signature = this.#signature(payload);
    const cursor = RealtimeCursorSchema.parse(`${CURSOR_PREFIX}.${payload}.${signature}`);
    return {
      cursor,
      expiresAt
    };
  }

  verify(
    cursor: string,
    expectedUserId: string,
    expectedSessionId: string,
    now = this.#clock()
  ): RealtimeCursorVerification {
    if (!RealtimeCursorSchema.safeParse(cursor).success) {
      return { ok: false, reason: "cursor_invalid" };
    }
    const parts = cursor.split(".");
    const payload = parts[1];
    const encodedSignature = parts[2];
    if (payload === undefined || encodedSignature === undefined) {
      return { ok: false, reason: "cursor_invalid" };
    }
    // Compare the encoded form, not only decoded bytes. Base64url's final
    // character can otherwise carry non-zero unused bits and create several
    // textual aliases for one valid MAC.
    const actual = Buffer.from(encodedSignature, "ascii");
    const expected = Buffer.from(this.#signature(payload), "ascii");
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
      return { ok: false, reason: "cursor_invalid" };
    }

    const claims = this.#parseClaims(payload);
    if (claims === null) return { ok: false, reason: "cursor_invalid" };
    const validExpectedUserId = IdSchema.safeParse(expectedUserId);
    const validExpectedSessionId = IdSchema.safeParse(expectedSessionId);
    if (
      !validExpectedUserId.success ||
      !validExpectedSessionId.success ||
      claims.userId !== validExpectedUserId.data ||
      claims.sessionId !== validExpectedSessionId.data
    ) {
      return { ok: false, reason: "cursor_scope_mismatch" };
    }

    const nowSeconds = Math.floor(now.getTime() / 1_000);
    if (!Number.isSafeInteger(nowSeconds) || nowSeconds < 0) {
      return { ok: false, reason: "cursor_invalid" };
    }
    if (claims.issuedAtSeconds > nowSeconds + MAX_FUTURE_CLOCK_SKEW_SECONDS) {
      return { ok: false, reason: "cursor_invalid" };
    }
    const expiresAtSeconds = claims.issuedAtSeconds + REALTIME_CURSOR_TTL_SECONDS;
    if (nowSeconds >= expiresAtSeconds) {
      return { ok: false, reason: "cursor_expired" };
    }
    return {
      ok: true,
      sequence: claims.sequence,
      issuedAt: new Date(claims.issuedAtSeconds * 1_000),
      expiresAt: new Date(expiresAtSeconds * 1_000)
    };
  }

  #signature(payload: string): string {
    return createHmac("sha256", this.#secret)
      .update("luxora:realtime-cursor:v1\0", "utf8")
      .update(payload, "ascii")
      .digest("base64url");
  }

  #parseClaims(payload: string): CursorClaims | null {
    try {
      const decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as unknown;
      if (!Array.isArray(decoded) || decoded.length !== 5) return null;
      const [version, userId, sessionId, sequence, issuedAtSeconds] = decoded;
      const validUserId = IdSchema.safeParse(userId);
      const validSessionId = IdSchema.safeParse(sessionId);
      if (
        version !== CURSOR_VERSION ||
        !validUserId.success ||
        !validSessionId.success ||
        !Number.isSafeInteger(sequence) ||
        (sequence as number) < 0 ||
        !Number.isSafeInteger(issuedAtSeconds) ||
        (issuedAtSeconds as number) < 0
      ) return null;
      return {
        version,
        userId: validUserId.data,
        sessionId: validSessionId.data,
        sequence: sequence as number,
        issuedAtSeconds: issuedAtSeconds as number
      };
    } catch {
      return null;
    }
  }
}
