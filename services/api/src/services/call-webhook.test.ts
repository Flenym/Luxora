import { createHash } from "node:crypto";
import { SignJWT } from "jose";
import { describe, expect, it } from "vitest";
import { verifyLivekitWebhook } from "./call-webhook.js";

const API_KEY = "test-livekit-api-key";
const API_SECRET = "test-livekit-api-secret-with-32-bytes!!";

function body(): Buffer {
  return Buffer.from(JSON.stringify({
    event: "participant_joined",
    id: "EV_test123",
    room: { name: "room-abc" },
    participant: { identity: "participant-xyz", sid: "PA_123" },
    extraUnknownField: { nested: [1, 2, 3] }
  }), "utf8");
}

async function signedToken(raw: Buffer, overrides: { key?: string; secret?: string; sha?: string; expired?: boolean } = {}): Promise<string> {
  const digest = overrides.sha ?? createHash("sha256").update(raw).digest("base64");
  const builder = new SignJWT({ sha256: digest })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setIssuer(overrides.key ?? API_KEY)
    .setIssuedAt();
  if (overrides.expired === true) {
    builder.setExpirationTime(Math.floor(Date.now() / 1000) - 3_600);
  } else {
    builder.setExpirationTime(Math.floor(Date.now() / 1000) + 300);
  }
  return builder.sign(new TextEncoder().encode(overrides.secret ?? API_SECRET));
}

const secrets = { apiKey: API_KEY, apiSecret: API_SECRET };

describe("verifyLivekitWebhook", () => {
  it("accepts a properly signed delivery and parses the event", async () => {
    const raw = body();
    const event = await verifyLivekitWebhook(raw, await signedToken(raw), secrets);
    expect(event).toEqual({
      event: "participant_joined",
      id: "EV_test123",
      roomName: "room-abc",
      participantIdentity: "participant-xyz"
    });
  });

  it("accepts events without a participant block", async () => {
    const raw = Buffer.from(JSON.stringify({ event: "room_finished", id: "EV_1", room: { name: "r" } }), "utf8");
    const event = await verifyLivekitWebhook(raw, await signedToken(raw), secrets);
    expect(event.participantIdentity).toBeNull();
  });

  it("rejects missing, forged, expired and mismatched signatures", async () => {
    const raw = body();
    await expect(verifyLivekitWebhook(raw, undefined, secrets)).rejects.toMatchObject({ statusCode: 401 });
    await expect(verifyLivekitWebhook(raw, "", secrets)).rejects.toMatchObject({ statusCode: 401 });
    await expect(verifyLivekitWebhook(raw, "Bearer not-a-jwt", secrets)).rejects.toMatchObject({ statusCode: 401 });
    await expect(verifyLivekitWebhook(raw, await signedToken(raw, { secret: "wrong-secret-with-32-bytes!!!!!!" }), secrets))
      .rejects.toMatchObject({ statusCode: 401 });
    await expect(verifyLivekitWebhook(raw, await signedToken(raw, { key: "other-key" }), secrets))
      .rejects.toMatchObject({ statusCode: 401 });
    await expect(verifyLivekitWebhook(raw, await signedToken(raw, { expired: true }), secrets))
      .rejects.toMatchObject({ statusCode: 401 });
    await expect(verifyLivekitWebhook(raw, await signedToken(Buffer.from("other", "utf8")), secrets))
      .rejects.toMatchObject({ statusCode: 401 });
  });

  it("rejects malformed payloads even with a valid signature", async () => {
    const raw = Buffer.from("not json", "utf8");
    await expect(verifyLivekitWebhook(raw, await signedToken(raw), secrets)).rejects.toMatchObject({ statusCode: 401 });
    const noRoom = Buffer.from(JSON.stringify({ event: "room_finished", id: "EV_1" }), "utf8");
    await expect(verifyLivekitWebhook(noRoom, await signedToken(noRoom), secrets)).rejects.toMatchObject({ statusCode: 401 });
  });
});
