import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { CHAT_DRAFT_IDEMPOTENCY_TTL_SECONDS } from "@luxora/protocol";
import type { ChatDraftCommandReceiptRecord, UserRecord } from "./domain/types.js";
import { AesGcmContentCipher } from "./infrastructure/content-cipher.js";
import { migrations } from "./infrastructure/migrations.js";
import { SqliteStore } from "./infrastructure/sqlite-store.js";

const BASE_AT = "2026-08-15T08:00:00.000Z";
const NEXT_AT = "2026-08-15T08:00:01.000Z";
const DELETE_AT = "2026-08-15T08:00:02.000Z";
const RECREATE_AT = "2026-08-15T08:00:03.000Z";
const DATA_KEY_ID = "chat-drafts-storage.v1";
const DATA_KEY = Buffer.alloc(32, 63).toString("base64url");

describe("chat draft migration 025 and SqliteStore invariants", () => {
  const stores: SqliteStore[] = [];
  const directories: string[] = [];

  afterEach(() => {
    for (const store of stores.splice(0)) {
      try {
        store.close();
      } catch {
        // Cleanup must not hide a failed invariant assertion.
      }
    }
    for (const directory of directories.splice(0)) {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  function fixture() {
    const directory = mkdtempSync(join(tmpdir(), "luxora-chat-drafts-storage-"));
    directories.push(directory);
    const databasePath = join(directory, "luxora.sqlite");
    const cipher = new AesGcmContentCipher({ [DATA_KEY_ID]: DATA_KEY }, DATA_KEY_ID);
    const store = new SqliteStore(databasePath, cipher);
    stores.push(store);

    const createUser = (prefix: string): UserRecord => {
      const username = `${prefix}_${randomUUID().replaceAll("-", "").slice(0, 8)}`;
      return store.createUser({
        id: randomUUID(),
        username,
        usernameNormalized: username,
        displayName: prefix,
        passwordHash: "test-only-password-hash",
        createdAt: BASE_AT
      });
    };
    const createChat = (ownerId: string): string => {
      const chatId = randomUUID();
      store.createChat({
        id: chatId,
        kind: "group",
        title: "Draft storage fixture",
        directKey: null,
        createdBy: ownerId,
        createdAt: BASE_AT
      });
      store.addChatMember(chatId, ownerId, "owner", BASE_AT);
      return chatId;
    };
    return { databasePath, store, createUser, createChat };
  }

  function openDatabase(databasePath: string, readonly = false): Database.Database {
    const database = readonly
      ? new Database(databasePath, { readonly: true })
      : new Database(databasePath);
    database.pragma("foreign_keys = ON");
    return database;
  }

  it("installs strict tables, scoped indexes, invariant triggers and foreign keys", () => {
    const { databasePath } = fixture();
    const database = openDatabase(databasePath, true);
    try {
      expect(database.prepare(`
        SELECT id FROM schema_migrations WHERE id = '025_synchronized_chat_drafts'
      `).get()).toEqual({ id: "025_synchronized_chat_drafts" });
      const tables = (database.pragma("table_list") as Array<{ name: string; strict: number }>)
        .filter((row) => row.name.startsWith("chat_draft"));
      expect(tables.map((row) => row.name).sort()).toEqual([
        "chat_draft_command_receipts",
        "chat_drafts"
      ]);
      expect(tables.every((row) => row.strict === 1)).toBe(true);
      const triggers = (database.prepare(`
        SELECT name FROM sqlite_master
        WHERE type = 'trigger' AND name LIKE 'trg_chat_draft%'
        ORDER BY name
      `).all() as Array<{ name: string }>).map((row) => row.name);
      expect(triggers).toEqual([
        "trg_chat_draft_receipts_immutable_delete",
        "trg_chat_draft_receipts_immutable_update",
        "trg_chat_drafts_insert_invariants",
        "trg_chat_drafts_update_invariants"
      ]);
      const draftForeignKeys = database.pragma("foreign_key_list(chat_drafts)") as Array<{
        table: string;
        from: string;
        on_delete: string;
      }>;
      expect(draftForeignKeys).toEqual(expect.arrayContaining([
        expect.objectContaining({ table: "users", from: "user_id", on_delete: "CASCADE" }),
        expect.objectContaining({ table: "chats", from: "chat_id", on_delete: "CASCADE" })
      ]));
      expect(draftForeignKeys.some((foreignKey) => foreignKey.table === "messages")).toBe(false);
      expect(database.pragma("integrity_check")).toEqual([{ integrity_check: "ok" }]);
      expect(database.pragma("foreign_key_check")).toEqual([]);
    } finally {
      database.close();
    }
  });

  it("keeps a validated reply ID as an opaque historical link without blocking hard retention", () => {
    const { databasePath, store, createUser, createChat } = fixture();
    const account = createUser("draft_hard_reply_retention");
    const chatId = createChat(account.id);
    const messageId = randomUUID();
    store.createMessage({
      id: messageId,
      chatId,
      senderId: account.id,
      body: "hard-retained reply target",
      replyToMessageId: null,
      topicId: null,
      forwardedFromMessageId: null,
      forwardedFromChatId: null,
      forwardedFromSenderId: null,
      forwardedFromSenderName: null,
      forwardedFromCreatedAt: null,
      clientNonce: randomUUID(),
      createdAt: BASE_AT
    });
    expect(store.putChatDraft(account.id, chatId, {
      text: "draft survives target retention",
      replyToMessageId: messageId,
      expectedRevision: 0,
      updatedAt: NEXT_AT
    })).toMatchObject({ replyToMessageId: messageId, revision: 1 });

    const database = openDatabase(databasePath);
    try {
      expect(database.prepare("DELETE FROM messages WHERE id = ?").run(messageId).changes)
        .toBe(1);
      expect(database.pragma("foreign_key_check")).toEqual([]);
    } finally {
      database.close();
    }
    expect(store.getChatDraft(account.id, chatId)).toMatchObject({
      text: "draft survives target retention",
      replyToMessageId: messageId,
      revision: 1,
      deletedAt: null
    });
  });

  it("encrypts active text and receipts while preserving monotonic tombstone CAS", () => {
    const { databasePath, store, createUser, createChat } = fixture();
    const account = createUser("draft_storage_account");
    const other = createUser("draft_storage_other");
    const chatId = createChat(account.id);
    const otherChatId = createChat(other.id);
    const replyId = randomUUID();
    store.createMessage({
      id: replyId,
      chatId,
      senderId: account.id,
      body: "reply body",
      replyToMessageId: null,
      topicId: null,
      forwardedFromMessageId: null,
      forwardedFromChatId: null,
      forwardedFromSenderId: null,
      forwardedFromSenderName: null,
      forwardedFromCreatedAt: null,
      clientNonce: randomUUID(),
      createdAt: BASE_AT
    });

    expect(store.getChatDraft(account.id, chatId)).toBeNull();
    const first = store.putChatDraft(account.id, chatId, {
      text: "DRAFT_STORAGE_PRIVATE_CANARY",
      replyToMessageId: replyId,
      expectedRevision: 0,
      updatedAt: BASE_AT
    });
    expect(first).toMatchObject({
      userId: account.id,
      chatId,
      text: "DRAFT_STORAGE_PRIVATE_CANARY",
      replyToMessageId: replyId,
      revision: 1,
      deletedAt: null
    });
    expect(store.putChatDraft(account.id, chatId, {
      text: "stale",
      replyToMessageId: null,
      expectedRevision: 0,
      updatedAt: NEXT_AT
    })).toBeNull();
    expect(() => store.putChatDraft(other.id, chatId, {
      text: "not a member",
      replyToMessageId: null,
      expectedRevision: 0,
      updatedAt: BASE_AT
    })).toThrow(/chat draft insert invariant failed/u);
    expect(() => store.putChatDraft(account.id, chatId, {
      text: "cross-chat reply",
      replyToMessageId: (() => {
        const messageId = randomUUID();
        store.createMessage({
          id: messageId,
          chatId: otherChatId,
          senderId: other.id,
          body: "other",
          replyToMessageId: null,
          topicId: null,
          forwardedFromMessageId: null,
          forwardedFromChatId: null,
          forwardedFromSenderId: null,
          forwardedFromSenderName: null,
          forwardedFromCreatedAt: null,
          clientNonce: randomUUID(),
          createdAt: BASE_AT
        });
        return messageId;
      })(),
      expectedRevision: 1,
      updatedAt: NEXT_AT
    })).toThrow(/chat draft (?:insert invariant failed|revision transition is invalid)/u);

    const second = store.putChatDraft(account.id, chatId, {
      text: "updated private canary",
      replyToMessageId: null,
      expectedRevision: 1,
      updatedAt: NEXT_AT
    });
    expect(second).toMatchObject({ revision: 2, text: "updated private canary" });
    const deleted = store.deleteChatDraft(account.id, chatId, 2, DELETE_AT);
    expect(deleted).toMatchObject({
      text: null,
      replyToMessageId: null,
      revision: 3,
      deletedAt: DELETE_AT
    });
    expect(store.deleteChatDraft(account.id, chatId, 2, RECREATE_AT)).toBeNull();
    const recreated = store.putChatDraft(account.id, chatId, {
      text: "recreated",
      replyToMessageId: null,
      expectedRevision: 3,
      updatedAt: RECREATE_AT
    });
    expect(recreated).toMatchObject({ revision: 4, text: "recreated", deletedAt: null });

    const receipt: ChatDraftCommandReceiptRecord = {
      userId: account.id,
      clientNonce: randomUUID(),
      operation: "put",
      chatId,
      fingerprint: "a".repeat(64),
      responseJson: JSON.stringify({ private: "DRAFT_RECEIPT_PRIVATE_CANARY" }),
      createdAt: new Date().toISOString(),
      expiresAt: new Date(
        Date.now() + CHAT_DRAFT_IDEMPOTENCY_TTL_SECONDS * 1_000
      ).toISOString()
    };
    store.createChatDraftCommandReceipt(receipt);
    expect(store.findChatDraftCommandReceipt(
      account.id,
      receipt.clientNonce,
      receipt.createdAt
    )).toEqual(receipt);

    const database = openDatabase(databasePath);
    try {
      const rawDraft = database.prepare(`
        SELECT text_ciphertext FROM chat_drafts WHERE user_id = ? AND chat_id = ?
      `).get(account.id, chatId) as { text_ciphertext: string };
      expect(rawDraft.text_ciphertext).toMatch(/^luxora:v1\./u);
      expect(rawDraft.text_ciphertext).not.toContain("recreated");
      const rawReceipt = database.prepare(`
        SELECT fingerprint_ciphertext, response_ciphertext FROM chat_draft_command_receipts
        WHERE user_id = ? AND client_nonce = ?
      `).get(account.id, receipt.clientNonce) as {
        fingerprint_ciphertext: string;
        response_ciphertext: string;
      };
      expect(rawReceipt.fingerprint_ciphertext).toMatch(/^luxora:v1\./u);
      expect(rawReceipt.fingerprint_ciphertext).not.toContain(receipt.fingerprint);
      expect(rawReceipt.response_ciphertext).toMatch(/^luxora:v1\./u);
      expect(rawReceipt.response_ciphertext).not.toContain("DRAFT_RECEIPT_PRIVATE_CANARY");
      expect(() => database.prepare(`
        UPDATE chat_drafts SET revision = revision + 2 WHERE user_id = ? AND chat_id = ?
      `).run(account.id, chatId)).toThrow(/chat draft revision transition is invalid/u);
      expect(() => database.prepare(`
        UPDATE chat_draft_command_receipts SET operation = 'delete'
        WHERE user_id = ? AND client_nonce = ?
      `).run(account.id, receipt.clientNonce)).toThrow(/immutable/u);
      expect(() => database.prepare(`
        DELETE FROM chat_draft_command_receipts WHERE user_id = ? AND client_nonce = ?
      `).run(account.id, receipt.clientNonce)).toThrow(/active .* cannot be deleted/u);
      expect(database.pragma("integrity_check")).toEqual([{ integrity_check: "ok" }]);
      expect(database.pragma("foreign_key_check")).toEqual([]);
    } finally {
      database.close();
    }
  });

  it("permits controlled expiry purge and account/chat cascades", () => {
    const { databasePath, store, createUser } = fixture();
    const chatCreator = createUser("draft_receipt_creator");
    const receiptOwner = createUser("draft_receipt_owner");
    const now = new Date();
    const activeCreatedAt = now.toISOString();
    const activeExpiresAt = new Date(
      now.getTime() + CHAT_DRAFT_IDEMPOTENCY_TTL_SECONDS * 1_000
    ).toISOString();
    const expiredCreatedAt = new Date(now.getTime() - 2 * 86_400_000).toISOString();
    const expiredAt = new Date(now.getTime() - 86_400_000).toISOString();

    const createReceipt = (
      userId: string,
      chatId: string,
      clientNonce: string,
      createdAt: string,
      expiresAt: string
    ): void => store.createChatDraftCommandReceipt({
      userId,
      clientNonce,
      operation: "put",
      chatId,
      fingerprint: "b".repeat(64),
      responseJson: JSON.stringify({ draft: null, revision: 0, replayed: false }),
      createdAt,
      expiresAt
    });

    const accountCascadeChatId = randomUUID();
    store.createChat({
      id: accountCascadeChatId,
      kind: "group",
      title: "Account cascade",
      directKey: null,
      createdBy: chatCreator.id,
      createdAt: BASE_AT
    });
    const accountCascadeNonce = randomUUID();
    createReceipt(
      receiptOwner.id,
      accountCascadeChatId,
      accountCascadeNonce,
      activeCreatedAt,
      activeExpiresAt
    );

    const chatCascadeId = randomUUID();
    store.createChat({
      id: chatCascadeId,
      kind: "group",
      title: "Chat cascade",
      directKey: null,
      createdBy: chatCreator.id,
      createdAt: BASE_AT
    });
    const chatCascadeNonce = randomUUID();
    createReceipt(
      chatCreator.id,
      chatCascadeId,
      chatCascadeNonce,
      activeCreatedAt,
      activeExpiresAt
    );

    const expiredNonce = randomUUID();
    createReceipt(
      chatCreator.id,
      accountCascadeChatId,
      expiredNonce,
      expiredCreatedAt,
      expiredAt
    );
    const justBeforeExpiry = new Date(Date.parse(expiredAt) - 1).toISOString();
    expect(store.findChatDraftCommandReceipt(
      chatCreator.id,
      expiredNonce,
      justBeforeExpiry
    )).not.toBeNull();
    expect(store.deleteExpiredChatDraftCommandReceipt(
      chatCreator.id,
      expiredNonce,
      justBeforeExpiry
    )).toBe(false);
    expect(store.findChatDraftCommandReceipt(
      chatCreator.id,
      expiredNonce,
      expiredAt
    )).toBeNull();
    expect(store.deleteExpiredChatDraftCommandReceipt(
      chatCreator.id,
      expiredNonce,
      expiredAt
    )).toBe(true);
    const batchExpiredNonce = randomUUID();
    createReceipt(
      chatCreator.id,
      accountCascadeChatId,
      batchExpiredNonce,
      expiredCreatedAt,
      expiredAt
    );
    expect(store.purgeExpiredChatDraftCommandReceipts(justBeforeExpiry, 1)).toBe(0);
    expect(store.purgeExpiredChatDraftCommandReceipts(expiredAt, 1)).toBe(1);
    expect(store.findChatDraftCommandReceipt(
      chatCreator.id,
      batchExpiredNonce,
      activeCreatedAt
    )).toBeNull();

    const database = openDatabase(databasePath);
    try {
      expect(database.prepare("DELETE FROM users WHERE id = ?").run(receiptOwner.id).changes)
        .toBe(1);
      expect(database.prepare(`
        SELECT count(*) AS count FROM chat_draft_command_receipts
        WHERE client_nonce = ?
      `).get(accountCascadeNonce)).toEqual({ count: 0 });

      expect(database.prepare("DELETE FROM chats WHERE id = ?").run(chatCascadeId).changes)
        .toBe(1);
      expect(database.prepare(`
        SELECT count(*) AS count FROM chat_draft_command_receipts
        WHERE client_nonce = ?
      `).get(chatCascadeNonce)).toEqual({ count: 0 });
      expect(database.pragma("foreign_key_check")).toEqual([]);
    } finally {
      database.close();
    }
  });

  it("purges exact-chat receipts only after membership removal", () => {
    const { databasePath, store, createUser, createChat } = fixture();
    const owner = createUser("draft_membership_purge_owner");
    const member = createUser("draft_membership_purge_member");
    const chatId = createChat(owner.id);
    store.addChatMember(chatId, member.id, "member", BASE_AT);
    const activeDraft = store.putChatDraft(member.id, chatId, {
      text: "MEMBERSHIP_PURGE_PRIVATE_CANARY",
      replyToMessageId: null,
      expectedRevision: 0,
      updatedAt: NEXT_AT
    });
    expect(activeDraft).toMatchObject({ revision: 1, deletedAt: null });
    if (activeDraft?.text === null || activeDraft === null) throw new Error("Expected active draft");
    const historicalDraftEvent = store.appendEvent(member.id, {
      type: "chat.draft.changed",
      audience: "account_sessions",
      accountId: member.id,
      chatId,
      draft: {
        chatId,
        text: activeDraft.text,
        replyToMessageId: activeDraft.replyToMessageId,
        revision: activeDraft.revision,
        updatedAt: activeDraft.updatedAt
      },
      revision: activeDraft.revision,
      changedAt: activeDraft.updatedAt
    }, activeDraft.updatedAt);
    const otherAudienceEvent = store.appendEvent(owner.id, {
      type: "chat.draft.changed",
      audience: "account_sessions",
      accountId: member.id,
      chatId,
      draft: {
        chatId,
        text: activeDraft.text,
        replyToMessageId: activeDraft.replyToMessageId,
        revision: activeDraft.revision,
        updatedAt: activeDraft.updatedAt
      },
      revision: activeDraft.revision,
      changedAt: activeDraft.updatedAt
    }, activeDraft.updatedAt);
    const memberRecord = store.getChatMember(chatId, member.id);
    if (memberRecord === null) throw new Error("Expected active membership");
    const otherTypeEvent = store.appendEvent(member.id, {
      type: "chat.member.changed",
      audience: "member_account",
      change: "added",
      membership: {
        chatId,
        userId: member.id,
        role: memberRecord.role,
        revision: memberRecord.revision,
        joinedAt: memberRecord.joinedAt,
        updatedAt: memberRecord.updatedAt
      },
      actorUserId: owner.id,
      changedAt: NEXT_AT
    }, NEXT_AT);
    const otherChatId = createChat(owner.id);
    store.addChatMember(otherChatId, member.id, "member", BASE_AT);
    const otherChatDraft = store.putChatDraft(member.id, otherChatId, {
      text: "ENTITY_ISOLATION_PRIVATE_CANARY",
      replyToMessageId: null,
      expectedRevision: 0,
      updatedAt: NEXT_AT
    });
    if (otherChatDraft?.text === null || otherChatDraft === null) {
      throw new Error("Expected other-chat active draft");
    }
    const otherEntityEvent = store.appendEvent(member.id, {
      type: "chat.draft.changed",
      audience: "account_sessions",
      accountId: member.id,
      chatId: otherChatId,
      draft: {
        chatId: otherChatId,
        text: otherChatDraft.text,
        replyToMessageId: otherChatDraft.replyToMessageId,
        revision: otherChatDraft.revision,
        updatedAt: otherChatDraft.updatedAt
      },
      revision: otherChatDraft.revision,
      changedAt: otherChatDraft.updatedAt
    }, otherChatDraft.updatedAt);
    const receipt: ChatDraftCommandReceiptRecord = {
      userId: member.id,
      clientNonce: randomUUID(),
      operation: "put",
      chatId,
      fingerprint: "c".repeat(64),
      responseJson: JSON.stringify({
        draft: { text: "MEMBERSHIP_PURGE_PRIVATE_CANARY" },
        revision: 1,
        replayed: false
      }),
      createdAt: new Date().toISOString(),
      expiresAt: new Date(
        Date.now() + CHAT_DRAFT_IDEMPOTENCY_TTL_SECONDS * 1_000
      ).toISOString()
    };
    store.createChatDraftCommandReceipt(receipt);

    const beforeRemoval = openDatabase(databasePath);
    try {
      expect(() => beforeRemoval.prepare(`
        DELETE FROM chat_draft_command_receipts
        WHERE user_id = ? AND client_nonce = ?
      `).run(member.id, receipt.clientNonce)).toThrow(/active .* cannot be deleted/u);
    } finally {
      beforeRemoval.close();
    }

    expect(store.removeChatMember(chatId, member.id, 1, DELETE_AT)).toMatchObject({
      userId: member.id,
      chatId,
      revision: 2
    });
    expect(store.getChatMember(chatId, member.id)).toBeNull();
    expect(store.getChatDraft(member.id, chatId)).toMatchObject({
      text: null,
      revision: 2,
      deletedAt: expect.any(String)
    });
    const afterRemoval = openDatabase(databasePath, true);
    try {
      expect(afterRemoval.prepare(`
        SELECT count(*) AS count FROM chat_draft_command_receipts
        WHERE user_id = ? AND chat_id = ?
      `).get(member.id, chatId)).toEqual({ count: 0 });
      expect(afterRemoval.prepare(`
        SELECT count(*) AS count FROM realtime_events WHERE sequence = ?
      `).get(historicalDraftEvent.sequence)).toEqual({ count: 0 });
      expect(afterRemoval.prepare(`
        SELECT count(*) AS count FROM realtime_outbox WHERE event_sequence = ?
      `).get(historicalDraftEvent.sequence)).toEqual({ count: 0 });
      const isolationSequences = [
        otherAudienceEvent.sequence,
        otherTypeEvent.sequence,
        otherEntityEvent.sequence
      ].sort((left, right) => left - right);
      expect((afterRemoval.prepare(`
        SELECT sequence FROM realtime_events
        WHERE sequence IN (?, ?, ?)
        ORDER BY sequence
      `).all(...isolationSequences) as Array<{ sequence: number }>).map(({ sequence }) => sequence))
        .toEqual(isolationSequences);
      expect((afterRemoval.prepare(`
        SELECT event_sequence FROM realtime_outbox
        WHERE event_sequence IN (?, ?, ?)
        ORDER BY event_sequence
      `).all(...isolationSequences) as Array<{ event_sequence: number }>)
        .map(({ event_sequence }) => event_sequence)).toEqual(isolationSequences);
      expect(afterRemoval.pragma("integrity_check")).toEqual([{ integrity_check: "ok" }]);
      expect(afterRemoval.pragma("foreign_key_check")).toEqual([]);
    } finally {
      afterRemoval.close();
    }
  });

  it("rolls back membership, tombstone, ledger, receipts and events when lifecycle purge aborts", () => {
    const { databasePath, store, createUser, createChat } = fixture();
    const owner = createUser("draft_purge_rollback_owner");
    const member = createUser("draft_purge_rollback_member");
    const chatId = createChat(owner.id);
    store.addChatMember(chatId, member.id, "member", BASE_AT);
    const activeDraft = store.putChatDraft(member.id, chatId, {
      text: "PURGE_ROLLBACK_PRIVATE_CANARY",
      replyToMessageId: null,
      expectedRevision: 0,
      updatedAt: NEXT_AT
    });
    expect(activeDraft).toMatchObject({ revision: 1, deletedAt: null });
    if (activeDraft?.text === null || activeDraft === null) throw new Error("Expected active draft");
    const historicalDraftEvent = store.appendEvent(member.id, {
      type: "chat.draft.changed",
      audience: "account_sessions",
      accountId: member.id,
      chatId,
      draft: {
        chatId,
        text: activeDraft.text,
        replyToMessageId: activeDraft.replyToMessageId,
        revision: activeDraft.revision,
        updatedAt: activeDraft.updatedAt
      },
      revision: activeDraft.revision,
      changedAt: activeDraft.updatedAt
    }, activeDraft.updatedAt);
    const receipt: ChatDraftCommandReceiptRecord = {
      userId: member.id,
      clientNonce: randomUUID(),
      operation: "put",
      chatId,
      fingerprint: "d".repeat(64),
      responseJson: JSON.stringify({
        draft: { text: "PURGE_ROLLBACK_PRIVATE_CANARY" },
        revision: 1,
        replayed: false
      }),
      createdAt: new Date().toISOString(),
      expiresAt: new Date(
        Date.now() + CHAT_DRAFT_IDEMPOTENCY_TTL_SECONDS * 1_000
      ).toISOString()
    };
    store.createChatDraftCommandReceipt(receipt);

    const injector = openDatabase(databasePath);
    try {
      injector.exec(`
        CREATE TRIGGER test_abort_chat_draft_membership_purge
        BEFORE DELETE ON realtime_events
        WHEN OLD.sequence = ${historicalDraftEvent.sequence}
        BEGIN
          SELECT RAISE(ABORT, 'forced chat draft event purge failure');
        END;
      `);
    } finally {
      injector.close();
    }

    try {
      expect(() => store.removeChatMember(chatId, member.id, 1, DELETE_AT))
        .toThrow(/forced chat draft event purge failure/u);
      expect(store.getChatMember(chatId, member.id)).toMatchObject({ revision: 1 });
      expect(store.getChatDraft(member.id, chatId)).toMatchObject({
        text: "PURGE_ROLLBACK_PRIVATE_CANARY",
        revision: 1,
        deletedAt: null
      });
      expect(store.findChatDraftCommandReceipt(
        member.id,
        receipt.clientNonce,
        receipt.createdAt
      )).toEqual(receipt);

      const inspection = openDatabase(databasePath, true);
      try {
        expect(inspection.prepare(`
          SELECT count(*) AS count FROM chat_membership_revision_ledger
          WHERE chat_id = ? AND user_id = ?
        `).get(chatId, member.id)).toEqual({ count: 0 });
        expect(inspection.prepare(`
          SELECT count(*) AS count FROM chat_draft_command_receipts
          WHERE user_id = ? AND chat_id = ?
        `).get(member.id, chatId)).toEqual({ count: 1 });
        expect(inspection.prepare(`
          SELECT count(*) AS count FROM realtime_events WHERE sequence = ?
        `).get(historicalDraftEvent.sequence)).toEqual({ count: 1 });
        expect(inspection.prepare(`
          SELECT count(*) AS count FROM realtime_outbox WHERE event_sequence = ?
        `).get(historicalDraftEvent.sequence)).toEqual({ count: 1 });
        expect(inspection.pragma("integrity_check")).toEqual([{ integrity_check: "ok" }]);
        expect(inspection.pragma("foreign_key_check")).toEqual([]);
      } finally {
        inspection.close();
      }
    } finally {
      const cleanup = openDatabase(databasePath);
      try {
        cleanup.exec("DROP TRIGGER IF EXISTS test_abort_chat_draft_membership_purge");
      } finally {
        cleanup.close();
      }
    }
  });

  it("upgrades an exact migration-024 database without rewriting existing core rows", () => {
    const directory = mkdtempSync(join(tmpdir(), "luxora-chat-drafts-m024-"));
    directories.push(directory);
    const databasePath = join(directory, "legacy.sqlite");
    const accountId = randomUUID();
    const chatId = randomUUID();
    const legacy = new Database(databasePath);
    legacy.pragma("foreign_keys = ON");
    legacy.exec(`
      CREATE TABLE schema_migrations (
        id TEXT PRIMARY KEY,
        applied_at TEXT NOT NULL
      ) STRICT;
    `);
    for (const migration of migrations.slice(0, 24)) {
      legacy.transaction(() => {
        legacy.exec(migration.sql);
        legacy.prepare("INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)")
          .run(migration.id, BASE_AT);
      })();
    }
    legacy.prepare(`
      INSERT INTO users (
        id, username, username_normalized, display_name,
        password_hash, created_at, updated_at
      ) VALUES (?, 'legacy_drafter', 'legacy_drafter', 'Legacy Drafter', 'hash', ?, ?)
    `).run(accountId, BASE_AT, BASE_AT);
    legacy.prepare(`
      INSERT INTO chats (id, kind, title, created_by, created_at, updated_at)
      VALUES (?, 'group', 'Legacy draft chat', ?, ?, ?)
    `).run(chatId, accountId, BASE_AT, BASE_AT);
    legacy.prepare(`
      INSERT INTO chat_members (
        chat_id, user_id, role, membership_revision, joined_at, membership_updated_at
      ) VALUES (?, ?, 'owner', 1, ?, ?)
    `).run(chatId, accountId, BASE_AT, BASE_AT);
    const before = legacy.prepare(`
      SELECT id, kind, title, created_by, created_at, updated_at FROM chats WHERE id = ?
    `).get(chatId);
    legacy.close();

    const cipher = new AesGcmContentCipher({ [DATA_KEY_ID]: DATA_KEY }, DATA_KEY_ID);
    const upgraded = new SqliteStore(databasePath, cipher);
    stores.push(upgraded);
    expect(upgraded.ping()).toBe(true);
    expect(upgraded.getChatDraft(accountId, chatId)).toBeNull();
    const inspection = openDatabase(databasePath, true);
    try {
      expect(inspection.prepare(`
        SELECT id, kind, title, created_by, created_at, updated_at FROM chats WHERE id = ?
      `).get(chatId)).toEqual(before);
      expect(inspection.prepare(`
        SELECT id FROM schema_migrations WHERE id = '025_synchronized_chat_drafts'
      `).get()).toEqual({ id: "025_synchronized_chat_drafts" });
      expect(inspection.pragma("integrity_check")).toEqual([{ integrity_check: "ok" }]);
      expect(inspection.pragma("foreign_key_check")).toEqual([]);
    } finally {
      inspection.close();
    }
  });
});
