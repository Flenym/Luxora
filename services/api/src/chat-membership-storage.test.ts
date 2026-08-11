import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import type { UserRecord } from "./domain/types.js";
import { SqliteStore } from "./infrastructure/sqlite-store.js";

const AT = "2026-08-04T12:00:00.000Z";
const LATER = "2026-08-04T12:01:00.000Z";

describe("chat membership storage invariants", () => {
  const directories: string[] = [];

  afterEach(() => {
    for (const directory of directories.splice(0)) {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  function fixture() {
    const directory = mkdtempSync(join(tmpdir(), "luxora-membership-storage-"));
    directories.push(directory);
    const databasePath = join(directory, "luxora.sqlite");
    const store = new SqliteStore(databasePath);
    const createUser = (prefix: string): UserRecord => {
      const username = `${prefix}_${randomUUID().slice(0, 8)}`;
      return store.createUser({
        id: randomUUID(),
        username,
        usernameNormalized: username,
        displayName: prefix,
        passwordHash: "test-only-password-hash",
        createdAt: AT
      });
    };
    return { databasePath, store, createUser };
  }

  it("rejects direct SQL owner, direct-chat, revision and receipt tampering", () => {
    const { databasePath, store, createUser } = fixture();
    const owner = createUser("owner");
    const member = createUser("member");
    const secondOwner = createUser("second_owner");
    const directPeer = createUser("direct_peer");
    const groupId = randomUUID();
    const directId = randomUUID();
    store.createChat({
      id: groupId,
      kind: "group",
      title: "Guarded group",
      directKey: null,
      createdBy: owner.id,
      createdAt: AT
    });
    store.addChatMember(groupId, owner.id, "owner", AT);
    store.addChatMember(groupId, member.id, "member", AT);
    store.createChat({
      id: directId,
      kind: "direct",
      title: null,
      directKey: [owner.id, directPeer.id].sort().join(":"),
      createdBy: owner.id,
      createdAt: AT
    });
    store.addChatMember(directId, owner.id, "member", AT);
    store.addChatMember(directId, directPeer.id, "member", AT);
    const nonce = randomUUID();
    store.createChatMembershipCommandReceipt({
      actorUserId: owner.id,
      clientNonce: nonce,
      operation: "role_update",
      chatId: groupId,
      targetUserId: member.id,
      fingerprint: "immutable-membership-fingerprint",
      membership: {
        chatId: groupId,
        userId: member.id,
        role: "member",
        revision: 1,
        joinedAt: AT,
        updatedAt: AT
      },
      createdAt: AT
    });
    store.close();

    const database = new Database(databasePath);
    database.pragma("foreign_keys = ON");
    try {
      expect(() => database.prepare(`
        UPDATE chat_members
        SET role = 'member', membership_revision = 2, membership_updated_at = ?
        WHERE chat_id = ? AND user_id = ?
      `).run(LATER, groupId, owner.id)).toThrow(/ownership transfer|owner/u);
      expect(() => database.prepare(`
        DELETE FROM chat_members WHERE chat_id = ? AND user_id = ?
      `).run(groupId, owner.id)).toThrow(/owner cannot leave/u);
      expect(() => database.prepare(`
        INSERT INTO chat_members (
          chat_id, user_id, role, membership_revision, joined_at, membership_updated_at
        ) VALUES (?, ?, 'owner', 1, ?, ?)
      `).run(groupId, secondOwner.id, AT, AT)).toThrow(/insert invariant/u);
      expect(() => database.prepare(`
        UPDATE chat_members
        SET role = 'admin', membership_revision = 3, membership_updated_at = ?
        WHERE chat_id = ? AND user_id = ?
      `).run(LATER, groupId, member.id)).toThrow(/revision transition/u);
      expect(() => database.prepare(`
        DELETE FROM chat_members WHERE chat_id = ? AND user_id = ?
      `).run(directId, directPeer.id)).toThrow(/direct chat membership/u);
      expect(() => database.prepare(`
        UPDATE chat_membership_command_receipts SET fingerprint = 'tampered'
        WHERE actor_user_id = ? AND client_nonce = ?
      `).run(owner.id, nonce)).toThrow(/receipt is immutable/u);
      expect(() => database.prepare(`
        DELETE FROM chat_membership_command_receipts
        WHERE actor_user_id = ? AND client_nonce = ?
      `).run(owner.id, nonce)).toThrow(/receipt cannot be deleted/u);
      expect(database.pragma("integrity_check")).toEqual([{ integrity_check: "ok" }]);
      expect(database.pragma("foreign_key_check")).toEqual([]);
    } finally {
      database.close();
    }
  });

  it("enforces the 200-current-member bound inside SQLite", () => {
    const { store, createUser } = fixture();
    try {
      const owner = createUser("limit_owner");
      const chatId = randomUUID();
      store.createChat({
        id: chatId,
        kind: "channel",
        title: "Bounded channel",
        directKey: null,
        createdBy: owner.id,
        createdAt: AT
      });
      store.addChatMember(chatId, owner.id, "owner", AT);
      for (let index = 1; index < 200; index += 1) {
        store.addChatMember(chatId, createUser(`member_${index}`).id, "member", AT);
      }
      expect(store.countChatMembers(chatId)).toBe(200);
      const overflow = createUser("overflow");
      expect(() => store.addChatMember(chatId, overflow.id, "member", AT))
        .toThrow(/insert invariant/u);
      expect(store.countChatMembers(chatId)).toBe(200);
    } finally {
      store.close();
    }
  });

  it("keeps membership revisions and timestamps monotonic across remove and re-add", () => {
    const { databasePath, store, createUser } = fixture();
    const owner = createUser("ledger_owner");
    const member = createUser("ledger_member");
    const chatId = randomUUID();
    store.createChat({
      id: chatId,
      kind: "group",
      title: "Lifecycle ledger",
      directKey: null,
      createdBy: owner.id,
      createdAt: AT
    });
    store.addChatMember(chatId, owner.id, "owner", AT);
    store.addChatMember(chatId, member.id, "member", AT);

    const removed = store.removeChatMember(chatId, member.id, 1, LATER);
    expect(removed).toMatchObject({ revision: 2, role: "member" });
    expect(removed!.updatedAt > AT).toBe(true);

    // A rolled-back wall clock cannot reset either the lifecycle revision or
    // its causal timestamp.
    const readded = store.createChatMember(chatId, member.id, "member", AT);
    expect(readded).toMatchObject({ revision: 3, role: "member" });
    expect(readded!.joinedAt > removed!.updatedAt).toBe(true);
    expect(store.updateChatMemberRole(chatId, member.id, "admin", 1, LATER)).toBeNull();
    expect(store.removeChatMember(chatId, member.id, 1, LATER)).toBeNull();

    const removedAgain = store.removeChatMember(chatId, member.id, 3, AT);
    expect(removedAgain).toMatchObject({ revision: 4, role: "member" });
    expect(removedAgain!.updatedAt > readded!.updatedAt).toBe(true);
    const readdedAgain = store.createChatMember(chatId, member.id, "admin", AT);
    expect(readdedAgain).toMatchObject({ revision: 5, role: "admin" });
    expect(readdedAgain!.joinedAt > removedAgain!.updatedAt).toBe(true);
    store.close();

    const database = new Database(databasePath);
    database.pragma("foreign_keys = ON");
    try {
      expect(database.prepare(`
        SELECT last_revision, last_removed_at
        FROM chat_membership_revision_ledger
        WHERE chat_id = ? AND user_id = ?
      `).get(chatId, member.id)).toEqual({
        last_revision: 4,
        last_removed_at: removedAgain!.updatedAt
      });
      expect(database.prepare(`
        DELETE FROM chat_members WHERE chat_id = ? AND user_id = ?
      `).run(chatId, member.id).changes).toBe(1);
      const rawDeleteLedger = database.prepare(`
        SELECT last_revision, last_removed_at
        FROM chat_membership_revision_ledger
        WHERE chat_id = ? AND user_id = ?
      `).get(chatId, member.id) as { last_revision: number; last_removed_at: string };
      expect(rawDeleteLedger.last_revision).toBe(6);
      expect(rawDeleteLedger.last_removed_at > readdedAgain!.updatedAt).toBe(true);
      expect(() => database.prepare(`
        UPDATE chat_membership_revision_ledger
        SET last_revision = last_revision, last_removed_at = last_removed_at
        WHERE chat_id = ? AND user_id = ?
      `).run(chatId, member.id)).toThrow(/ledger must advance/u);
      expect(() => database.prepare(`
        INSERT INTO chat_members (
          chat_id, user_id, role, membership_revision, joined_at, membership_updated_at
        ) VALUES (?, ?, 'member', 1, ?, ?)
      `).run(chatId, member.id, AT, AT)).toThrow(/insert invariant/u);
      expect(database.pragma("integrity_check")).toEqual([{ integrity_check: "ok" }]);
      expect(database.pragma("foreign_key_check")).toEqual([]);
    } finally {
      database.close();
    }

    const reopened = new SqliteStore(databasePath);
    try {
      const afterRawDelete = reopened.createChatMember(chatId, member.id, "member", AT);
      expect(afterRawDelete?.revision).toBe(7);
      expect(afterRawDelete!.joinedAt > readdedAgain!.updatedAt).toBe(true);
    } finally {
      reopened.close();
    }
  });

  it("rolls the ledger back when a guarded owner deletion fails", () => {
    const { databasePath, store, createUser } = fixture();
    const owner = createUser("rollback_owner");
    const chatId = randomUUID();
    store.createChat({
      id: chatId,
      kind: "channel",
      title: "Owner guard",
      directKey: null,
      createdBy: owner.id,
      createdAt: AT
    });
    store.addChatMember(chatId, owner.id, "owner", AT);
    expect(() => store.removeChatMember(chatId, owner.id, 1, LATER))
      .toThrow(/owner cannot leave/u);
    expect(store.getChatMember(chatId, owner.id)?.revision).toBe(1);
    store.close();

    const database = new Database(databasePath, { readonly: true });
    try {
      expect(database.prepare(`
        SELECT count(*) AS count FROM chat_membership_revision_ledger
        WHERE chat_id = ? AND user_id = ?
      `).get(chatId, owner.id)).toEqual({ count: 0 });
    } finally {
      database.close();
    }
  });
});
