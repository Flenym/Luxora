import { describe, expect, it } from "vitest";
import {
  ChatPreferencesSchema,
  ChatPreferencesRealtimeEventSchema,
  ChatSchema,
  DurableRealtimeEventSchema,
  PatchChatPreferencesSchema
} from "./index.js";

const CHAT_ID = "550e8400-e29b-41d4-a716-446655440000";
const USER_ID = "0198a32a-8b8b-7a12-9123-5da81cf8cfb0";

describe("per-account chat preference HTTP contract", () => {
  it("requires a strict non-empty desired-state patch", () => {
    expect(PatchChatPreferencesSchema.safeParse({}).success).toBe(false);
    expect(PatchChatPreferencesSchema.safeParse({ archived: true, unknown: false }).success).toBe(false);
    expect(PatchChatPreferencesSchema.safeParse({ mutedUntil: "not-a-timestamp" }).success).toBe(false);
    expect(PatchChatPreferencesSchema.parse({ archived: false, mutedUntil: null })).toEqual({
      archived: false,
      mutedUntil: null
    });
  });

  it("projects archive and mute state without exposing membership internals", () => {
    const archivedAt = "2026-08-11T09:00:00.000Z";
    const mutedUntil = "2026-08-12T09:00:00.000Z";
    expect(ChatPreferencesSchema.parse({ archivedAt, mutedUntil })).toEqual({ archivedAt, mutedUntil });
    expect(ChatPreferencesSchema.safeParse({ archivedAt, mutedUntil, userId: USER_ID }).success).toBe(false);

    expect(ChatSchema.parse({
      id: CHAT_ID,
      kind: "direct",
      title: "Избранное",
      avatarUrl: null,
      role: "member",
      memberCount: 1,
      lastMessage: null,
      lastActivityAt: archivedAt,
      createdAt: archivedAt,
      unreadCount: 0,
      archivedAt,
      mutedUntil
    })).toMatchObject({ archivedAt, mutedUntil });
  });

  it("keeps the durable synchronization event strict and account-bound", () => {
    const changedAt = "2026-08-11T09:00:00.000Z";
    const event = {
      type: "chat.preferences.updated" as const,
      audience: "member_account" as const,
      accountId: USER_ID,
      chatId: CHAT_ID,
      preferences: { archivedAt: changedAt, mutedUntil: null },
      changedAt
    };

    expect(ChatPreferencesRealtimeEventSchema.parse(event)).toEqual(event);
    expect(DurableRealtimeEventSchema.safeParse(event).success).toBe(true);
    expect(ChatPreferencesRealtimeEventSchema.safeParse({
      ...event,
      audience: "all_members"
    }).success).toBe(false);
    expect(ChatPreferencesRealtimeEventSchema.safeParse({
      ...event,
      accountId: undefined
    }).success).toBe(false);
    expect(ChatPreferencesRealtimeEventSchema.safeParse({
      ...event,
      unexpected: true
    }).success).toBe(false);
  });
});
