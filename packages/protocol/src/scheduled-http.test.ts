import { describe, expect, it } from "vitest";
import {
  ScheduledMessageListResponseSchema,
  ScheduledMessageSchema,
  ScheduleMessageRequestSchema
} from "./index.js";

const NONCE = "0198a32a-8b8b-7a12-9123-5da81cf8cfb0";
const CHAT_ID = "2298a32a-8b8b-7a12-9123-5da81cf8cfb0";

describe("scheduled message contract", () => {
  it("accepts a text-only future send and rejects media payloads", () => {
    expect(ScheduleMessageRequestSchema.parse({
      body: "Напомнить завтра",
      clientNonce: NONCE,
      sendAt: "2026-09-13T00:00:00.000Z"
    }).sendAt).toBe("2026-09-13T00:00:00.000Z");
    expect(ScheduleMessageRequestSchema.safeParse({
      body: "",
      clientNonce: NONCE,
      sendAt: "2026-09-13T00:00:00.000Z"
    }).success).toBe(false);
  });

  it("projects scheduled rows with a bounded state machine", () => {
    expect(ScheduledMessageSchema.parse({
      id: NONCE,
      chatId: CHAT_ID,
      body: "Напомнить завтра",
      replyToMessageId: null,
      topicId: null,
      sendAt: "2026-09-13T00:00:00.000Z",
      state: "pending",
      failureCode: null,
      createdAt: "2026-09-12T00:00:00.000Z"
    }).state).toBe("pending");
    expect(ScheduledMessageListResponseSchema.parse({
      items: [],
      nextCursor: null
    }).items).toEqual([]);
    expect(ScheduledMessageSchema.safeParse({
      id: NONCE,
      chatId: CHAT_ID,
      body: "x",
      replyToMessageId: null,
      topicId: null,
      sendAt: "not-a-date",
      state: "pending",
      failureCode: null,
      createdAt: "2026-09-12T00:00:00.000Z"
    }).success).toBe(false);
  });
});
