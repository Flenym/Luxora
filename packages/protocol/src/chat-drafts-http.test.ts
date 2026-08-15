import { describe, expect, it } from "vitest";
import {
  ChatDraftMutationResponseSchema,
  ChatDraftRealtimeEventSchema,
  ChatDraftStateResponseSchema,
  CHAT_DRAFT_IDEMPOTENCY_TTL_SECONDS,
  DeleteChatDraftRequestSchema,
  DurableRealtimeEventSchema,
  MAX_DRAFT_LENGTH,
  MAX_CHAT_DRAFT_ACTIVE_COMMAND_RECEIPTS,
  PutChatDraftRequestSchema,
  RealtimeEventSchema,
  createCapabilitiesResponseV1
} from "./index.js";

const CHAT_ID = "9ec9347c-9306-4108-aab4-e7762b73b201";
const MESSAGE_ID = "a0df9334-2ec0-422d-b5de-11c775a42344";
const ACCOUNT_ID = "b650e2ab-4185-493d-81a2-bd4f19b84f0c";
const NONCE = "9e7a3010-8291-4e0f-8557-aadd419ffbc4";
const UPDATED_AT = "2026-08-15T12:00:00.000Z";

describe("synchronized chat draft contracts", () => {
  it("requires well-formed Unicode, bounds code points and requires content or a reply target", () => {
    for (const malformed of ["\uD800", "\uDC00"]) {
      expect(PutChatDraftRequestSchema.safeParse({
        text: malformed,
        expectedRevision: 0,
        clientNonce: NONCE
      }).success).toBe(false);
      expect(ChatDraftStateResponseSchema.safeParse({
        draft: {
          chatId: CHAT_ID,
          text: malformed,
          replyToMessageId: null,
          revision: 1,
          updatedAt: UPDATED_AT
        },
        revision: 1
      }).success).toBe(false);
    }
    expect(PutChatDraftRequestSchema.safeParse({
      text: "💎".repeat(MAX_DRAFT_LENGTH),
      expectedRevision: 0,
      clientNonce: NONCE
    }).success).toBe(true);
    expect(PutChatDraftRequestSchema.safeParse({
      text: "💎".repeat(MAX_DRAFT_LENGTH + 1),
      expectedRevision: 0,
      clientNonce: NONCE
    }).success).toBe(false);
    expect(PutChatDraftRequestSchema.safeParse({
      text: "",
      expectedRevision: 0,
      clientNonce: NONCE
    }).success).toBe(false);
    expect(PutChatDraftRequestSchema.parse({
      text: "",
      replyToMessageId: MESSAGE_ID,
      expectedRevision: 0,
      clientNonce: NONCE
    }).replyToMessageId).toBe(MESSAGE_ID);
  });

  it("keeps CAS and mutation envelopes strict", () => {
    expect(DeleteChatDraftRequestSchema.safeParse({
      expectedRevision: 0,
      clientNonce: NONCE
    }).success).toBe(false);
    expect(PutChatDraftRequestSchema.safeParse({
      text: "draft",
      expectedRevision: 0,
      clientNonce: NONCE,
      overwrite: true
    }).success).toBe(false);
    expect(ChatDraftStateResponseSchema.safeParse({ draft: null, revision: 0 }).success).toBe(true);
    expect(ChatDraftMutationResponseSchema.safeParse({
      draft: {
        chatId: CHAT_ID,
        text: "draft",
        replyToMessageId: null,
        revision: 2,
        updatedAt: UPDATED_AT
      },
      revision: 1,
      replayed: false
    }).success).toBe(false);
  });

  it("advertises the implemented server capability and exact limit", () => {
    const capabilities = createCapabilitiesResponseV1({
      maxAttachmentBytes: 104_857_600,
      userStorageQuotaBytes: 1_073_741_824,
      uploadChunkSizeBytes: 1_048_576,
      uploadSessionTtlSeconds: 3_600,
      serverSearchConfigured: false,
      phoneAuthenticationAvailable: false
    });
    expect(capabilities.features.drafts).toBe(true);
    expect(capabilities.limits.maxDraftCodePoints).toBe(MAX_DRAFT_LENGTH);
    expect(capabilities.limits.chatDraftIdempotencyTtlSeconds)
      .toBe(CHAT_DRAFT_IDEMPOTENCY_TTL_SECONDS);
    expect(capabilities.limits.maxChatDraftActiveCommandReceipts)
      .toBe(MAX_CHAT_DRAFT_ACTIVE_COMMAND_RECEIPTS);
  });

  it("keeps private draft changes in durable realtime v2 only", () => {
    const event = {
      type: "chat.draft.changed",
      audience: "account_sessions",
      accountId: ACCOUNT_ID,
      chatId: CHAT_ID,
      draft: {
        chatId: CHAT_ID,
        text: "private text",
        replyToMessageId: MESSAGE_ID,
        revision: 1,
        updatedAt: UPDATED_AT
      },
      revision: 1,
      changedAt: UPDATED_AT
    };
    expect(ChatDraftRealtimeEventSchema.safeParse(event).success).toBe(true);
    expect(DurableRealtimeEventSchema.safeParse(event).success).toBe(true);
    expect(RealtimeEventSchema.safeParse(event).success).toBe(false);
    expect(ChatDraftRealtimeEventSchema.safeParse({
      ...event,
      accountId: CHAT_ID,
      draft: { ...event.draft, chatId: ACCOUNT_ID }
    }).success).toBe(false);
    expect(ChatDraftRealtimeEventSchema.safeParse({
      ...event,
      draft: { ...event.draft, text: "\uD800" }
    }).success).toBe(false);
  });
});
