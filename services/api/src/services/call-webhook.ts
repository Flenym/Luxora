import { createHash, timingSafeEqual } from "node:crypto";
import { jwtVerify } from "jose";
import { unauthenticated } from "../errors.js";

/** Minimal LiveKit WebhookEvent projection; unknown fields are ignored. */
export interface LivekitWebhookEvent {
  event: string;
  id: string;
  roomName: string;
  participantIdentity: string | null;
}

export interface LivekitWebhookSecrets {
  apiKey: string;
  apiSecret: string;
}

const CLOCK_TOLERANCE_SECONDS = 300;

function isBoundedString(value: unknown, maxLength: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maxLength;
}

function parseEvent(rawBody: Buffer): LivekitWebhookEvent {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody.toString("utf8")) as unknown;
  } catch {
    throw unauthenticated("LiveKit webhook payload is invalid");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw unauthenticated("LiveKit webhook payload is invalid");
  }
  const record = parsed as Record<string, unknown>;
  if (!isBoundedString(record["event"], 64) || !isBoundedString(record["id"], 128)) {
    throw unauthenticated("LiveKit webhook payload is invalid");
  }
  const room = record["room"];
  if (typeof room !== "object" || room === null || Array.isArray(room)) {
    throw unauthenticated("LiveKit webhook payload is invalid");
  }
  const roomName = (room as Record<string, unknown>)["name"];
  if (!isBoundedString(roomName, 128)) throw unauthenticated("LiveKit webhook payload is invalid");
  const participant = record["participant"];
  let participantIdentity: string | null = null;
  if (participant !== undefined && participant !== null) {
    if (typeof participant !== "object" || Array.isArray(participant)) {
      throw unauthenticated("LiveKit webhook payload is invalid");
    }
    const identity = (participant as Record<string, unknown>)["identity"];
    if (!isBoundedString(identity, 128)) throw unauthenticated("LiveKit webhook payload is invalid");
    participantIdentity = identity;
  }
  return { event: record["event"], id: record["id"], roomName, participantIdentity };
}

/**
 * Verifies a LiveKit webhook delivery (CALLS_PLATFORM §5 rule 5): the
 * Authorization header carries a short-lived HS256 JWT verified with the API
 * secret (issuer must equal the API key, expiry enforced with clock
 * tolerance), and its `sha256` claim must equal base64(sha256(raw body)).
 * The raw body is hashed before any JSON parsing. Failures are 401 without
 * secret material; the caller decides acknowledgment semantics.
 */
export async function verifyLivekitWebhook(
  rawBody: Buffer,
  authHeader: string | string[] | undefined,
  secrets: LivekitWebhookSecrets
): Promise<LivekitWebhookEvent> {
  if (typeof authHeader !== "string" || authHeader.length === 0 || authHeader.length > 8192) {
    throw unauthenticated("LiveKit webhook signature is missing");
  }
  let sha256Claim: unknown;
  try {
    const { payload } = await jwtVerify(authHeader, new TextEncoder().encode(secrets.apiSecret), {
      clockTolerance: CLOCK_TOLERANCE_SECONDS
    });
    if (payload["iss"] !== secrets.apiKey) throw new Error("issuer mismatch");
    sha256Claim = payload["sha256"];
  } catch {
    throw unauthenticated("LiveKit webhook signature is invalid");
  }
  if (typeof sha256Claim !== "string" || sha256Claim.length === 0 || sha256Claim.length > 128) {
    throw unauthenticated("LiveKit webhook signature is invalid");
  }
  let claimed: Buffer;
  try {
    claimed = Buffer.from(sha256Claim, "base64");
  } catch {
    throw unauthenticated("LiveKit webhook signature is invalid");
  }
  const actual = createHash("sha256").update(rawBody).digest();
  if (claimed.length !== actual.length || !timingSafeEqual(claimed, actual)) {
    throw unauthenticated("LiveKit webhook signature is invalid");
  }
  return parseEvent(rawBody);
}
