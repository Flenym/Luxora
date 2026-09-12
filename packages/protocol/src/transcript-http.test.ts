import { describe, expect, it } from "vitest";
import {
  MessageSchema,
  PutMessageTranscriptSchema,
  SendMessageRequestSchema
} from "./index.js";

const NONCE = "0198a32a-8b8b-7a12-9123-5da81cf8cfb0";
const MESSAGE_ID = "2298a32a-8b8b-7a12-9123-5da81cf8cfb0";

describe("voice transcription consent contract", () => {
  it("requires attachments for transcription consent", () => {
    expect(SendMessageRequestSchema.parse({
      body: null,
      clientNonce: NONCE,
      attachmentIds: [MESSAGE_ID],
      transcriptionConsent: true
    }).transcriptionConsent).toBe(true);
    expect(SendMessageRequestSchema.parse({
      body: "Текст",
      clientNonce: NONCE
    }).transcriptionConsent).toBe(false);
    expect(SendMessageRequestSchema.safeParse({
      body: null,
      clientNonce: NONCE,
      attachmentIds: [],
      transcriptionConsent: true
    }).success).toBe(false);
  });

  it("bounds transcript text to 2 000 code points", () => {
    expect(PutMessageTranscriptSchema.parse({
      text: "Расшифровка",
      clientNonce: NONCE
    }).text).toBe("Расшифровка");
    expect(PutMessageTranscriptSchema.safeParse({
      text: "   ",
      clientNonce: NONCE
    }).success).toBe(false);
    expect(PutMessageTranscriptSchema.safeParse({
      text: "x".repeat(2_001),
      clientNonce: NONCE
    }).success).toBe(false);
    expect(PutMessageTranscriptSchema.safeParse({
      text: "ok",
      clientNonce: NONCE,
      extra: true
    }).success).toBe(false);
  });

  it("carries consent and transcript on message projections", () => {
    const parsed = MessageSchema.parse({
      id: MESSAGE_ID,
      chatId: MESSAGE_ID,
      sender: {
        id: MESSAGE_ID,
        username: "voice_sender",
        displayName: "Voice Sender",
        bio: "",
        avatarUrl: null,
        createdAt: "2026-09-12T00:00:00.000Z",
        lastSeenAt: null
      },
      kind: "media",
      body: null,
      replyToMessageId: null,
      topicId: null,
      forwardedFrom: null,
      attachments: [],
      transcriptionAllowed: true,
      transcript: null,
      isPinned: false,
      clientNonce: NONCE,
      revision: 0,
      createdAt: "2026-09-12T00:00:00.000Z",
      updatedAt: "2026-09-12T00:00:00.000Z",
      editedAt: null,
      deletedAt: null
    });
    expect(parsed.transcriptionAllowed).toBe(true);
    expect(parsed.transcript).toBeNull();
  });
});
