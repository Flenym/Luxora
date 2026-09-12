import { describe, expect, it } from "vitest";
import {
  AdminChatListResponseSchema,
  AdminStatusResponseSchema,
  AdminUserListResponseSchema
} from "./index.js";

const ADMIN_USER = {
  id: "0198a32a-8b8b-7a12-9123-5da81cf8cfb0",
  username: "operator_probe",
  displayName: "Operator Probe",
  phoneBound: true,
  phonePasswordEnabled: true,
  passwordAuthEnabled: false,
  activeSessions: 2,
  chatCount: 3,
  createdAt: "2026-09-11T12:00:00.000Z",
  lastSeenAt: null
};

describe("operator administration read contract", () => {
  it("accepts a secret-free user page and rejects unknown or secret fields", () => {
    expect(AdminUserListResponseSchema.parse({
      items: [ADMIN_USER],
      nextCursor: null
    }).items).toHaveLength(1);
    expect(AdminUserListResponseSchema.safeParse({
      items: [{ ...ADMIN_USER, password_hash: "must-never-appear" }],
      nextCursor: null
    }).success).toBe(false);
    expect(AdminUserListResponseSchema.safeParse({
      items: [{ ...ADMIN_USER, phoneDigest: "must-never-appear" }],
      nextCursor: null
    }).success).toBe(false);
  });

  it("accepts a chat page within the shared page bound", () => {
    expect(AdminChatListResponseSchema.parse({
      items: [{
        id: "2298a32a-8b8b-7a12-9123-5da81cf8cfb0",
        kind: "direct",
        title: null,
        memberCount: 2,
        messageCount: 7,
        createdAt: "2026-09-11T12:00:00.000Z"
      }],
      nextCursor: null
    }).items).toHaveLength(1);
    expect(AdminChatListResponseSchema.safeParse({
      items: new Array(101).fill({
        id: "2298a32a-8b8b-7a12-9123-5da81cf8cfb0",
        kind: "group",
        title: "Overflow",
        memberCount: 1,
        messageCount: 0,
        createdAt: "2026-09-11T12:00:00.000Z"
      }),
      nextCursor: null
    }).success).toBe(false);
  });

  it("accepts a consistent operator status snapshot", () => {
    expect(AdminStatusResponseSchema.parse({
      migrationId: "026_phone_recovery_and_binding",
      users: 3,
      activeSessions: 4,
      chatsByKind: { direct: 2, group: 0, channel: 1 },
      messages: 9,
      phoneIdentities: 2,
      pendingOutbox: 0,
      failedOutbox: 0
    }).users).toBe(3);
    expect(AdminStatusResponseSchema.safeParse({
      migrationId: "026_phone_recovery_and_binding",
      users: 3,
      activeSessions: 4,
      chatsByKind: { direct: 2 },
      messages: 9,
      phoneIdentities: 2,
      pendingOutbox: 0,
      failedOutbox: 0
    }).success).toBe(false);
  });
});
