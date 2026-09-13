import { describe, expect, it } from "vitest";
import {
  ChatOwnershipTransferResponseSchema,
  ChatOwnershipTransferSchema,
  InitiateOwnershipTransferRequestSchema
} from "./index.js";

const TRANSFER = {
  id: "550e8400-e29b-41d4-a716-446655440010",
  chatId: "550e8400-e29b-41d4-a716-446655440011",
  fromUserId: "550e8400-e29b-41d4-a716-446655440012",
  toUserId: "550e8400-e29b-41d4-a716-446655440013",
  state: "pending",
  expiresAt: "2026-09-14T12:00:00.000Z",
  createdAt: "2026-09-13T12:00:00.000Z",
  decidedAt: null,
  decidedBy: null
};

describe("chat ownership transfer HTTP contract", () => {
  it("bounds initiation input and refines transfer states", () => {
    expect(InitiateOwnershipTransferRequestSchema.parse({
      targetUserId: "550e8400-e29b-41d4-a716-446655440013",
      clientNonce: "550e8400-e29b-41d4-a716-446655440014"
    })).toMatchObject({ targetUserId: "550e8400-e29b-41d4-a716-446655440013" });
    expect(InitiateOwnershipTransferRequestSchema.safeParse({
      targetUserId: "550e8400-e29b-41d4-a716-446655440013"
    }).success).toBe(false);

    const parsed = ChatOwnershipTransferSchema.parse(TRANSFER);
    expect(Object.keys(parsed).sort()).toEqual([
      "chatId",
      "createdAt",
      "decidedAt",
      "decidedBy",
      "expiresAt",
      "fromUserId",
      "id",
      "state",
      "toUserId"
    ]);

    // Self-transfers and decision-less decided states are unrepresentable.
    expect(ChatOwnershipTransferSchema.safeParse({
      ...TRANSFER,
      toUserId: TRANSFER.fromUserId
    }).success).toBe(false);
    expect(ChatOwnershipTransferSchema.safeParse({
      ...TRANSFER,
      state: "accepted",
      decidedAt: null,
      decidedBy: null
    }).success).toBe(false);
    expect(ChatOwnershipTransferSchema.safeParse({
      ...TRANSFER,
      decidedAt: "2026-09-13T12:01:00.000Z",
      decidedBy: TRANSFER.toUserId
    }).success).toBe(false);

    const accepted = ChatOwnershipTransferResponseSchema.parse({
      transfer: {
        ...TRANSFER,
        state: "accepted",
        decidedAt: "2026-09-13T12:01:00.000Z",
        decidedBy: TRANSFER.toUserId
      },
      replayed: false
    });
    expect(accepted.transfer.state).toBe("accepted");
  });
});
