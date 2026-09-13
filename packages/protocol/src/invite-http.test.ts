import { describe, expect, it } from "vitest";
import {
  ChatInviteLinkListResponseSchema,
  ChatInviteLinkSchema,
  CreateChatInviteLinkRequestSchema,
  CreateChatInviteLinkResponseSchema,
  JoinChatByInviteRequestSchema,
  RevokeChatInviteLinkResponseSchema
} from "./index.js";

const INVITE = {
  id: "550e8400-e29b-41d4-a716-446655440000",
  chatId: "550e8400-e29b-41d4-a716-446655440001",
  createdBy: "550e8400-e29b-41d4-a716-446655440002",
  expiresAt: null,
  maxUses: null,
  useCount: 0,
  revokedAt: null,
  createdAt: "2026-09-13T12:00:00.000Z"
};

const TOKEN = "A".repeat(43);

describe("chat invite link HTTP contract", () => {
  it("bounds creation input and keeps token material out of stored projections", () => {
    expect(CreateChatInviteLinkRequestSchema.parse({
      clientNonce: "550e8400-e29b-41d4-a716-446655440003"
    })).toEqual({ clientNonce: "550e8400-e29b-41d4-a716-446655440003" });
    expect(CreateChatInviteLinkRequestSchema.parse({
      expiresInSeconds: 3_600,
      maxUses: 10,
      clientNonce: "550e8400-e29b-41d4-a716-446655440003"
    })).toMatchObject({ expiresInSeconds: 3_600, maxUses: 10 });

    expect(CreateChatInviteLinkRequestSchema.safeParse({
      expiresInSeconds: 0,
      clientNonce: "550e8400-e29b-41d4-a716-446655440003"
    }).success).toBe(false);
    expect(CreateChatInviteLinkRequestSchema.safeParse({
      expiresInSeconds: 91 * 24 * 3_600,
      clientNonce: "550e8400-e29b-41d4-a716-446655440003"
    }).success).toBe(false);
    expect(CreateChatInviteLinkRequestSchema.safeParse({
      maxUses: 10_001,
      clientNonce: "550e8400-e29b-41d4-a716-446655440003"
    }).success).toBe(false);
    expect(CreateChatInviteLinkRequestSchema.safeParse({
      maxUses: 1,
      clientNonce: "550e8400-e29b-41d4-a716-446655440003",
      token: TOKEN
    }).success).toBe(false);
  });

  it("accepts only exact 43-char bearer tokens on join", () => {
    expect(JoinChatByInviteRequestSchema.parse({
      token: TOKEN,
      clientNonce: "550e8400-e29b-41d4-a716-446655440003"
    }).token).toBe(TOKEN);
    expect(JoinChatByInviteRequestSchema.safeParse({
      token: "short",
      clientNonce: "550e8400-e29b-41d4-a716-446655440003"
    }).success).toBe(false);
    expect(JoinChatByInviteRequestSchema.safeParse({
      token: `${TOKEN}.extra`,
      clientNonce: "550e8400-e29b-41d4-a716-446655440003"
    }).success).toBe(false);
    expect(JoinChatByInviteRequestSchema.safeParse({
      token: TOKEN
    }).success).toBe(false);
  });

  it("exposes metadata-only list/revoke projections with the token shown once", () => {
    const parsed = ChatInviteLinkSchema.parse(INVITE);
    expect(Object.keys(parsed).sort()).toEqual([
      "chatId",
      "createdAt",
      "createdBy",
      "expiresAt",
      "id",
      "maxUses",
      "revokedAt",
      "useCount"
    ]);

    const created = CreateChatInviteLinkResponseSchema.parse({
      invite: INVITE,
      token: TOKEN,
      replayed: false
    });
    expect(created.token).toBe(TOKEN);

    expect(ChatInviteLinkListResponseSchema.parse({ items: [INVITE] }).items).toHaveLength(1);
    expect(RevokeChatInviteLinkResponseSchema.parse({
      invite: { ...INVITE, revokedAt: "2026-09-13T12:05:00.000Z" },
      replayed: false
    }).replayed).toBe(false);
  });
});
