import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import type {
  ChatFolderOverrideRecord,
  ChatFolderRecord,
  ChatFolderRulesRecord,
  UserRecord
} from "./domain/types.js";
import { AesGcmContentCipher } from "./infrastructure/content-cipher.js";
import { SqliteStore } from "./infrastructure/sqlite-store.js";

const CREATED_AT = "2026-08-11T09:00:00.000Z";
const UPDATED_AT = "2026-08-11T09:01:00.000Z";
const REORDERED_AT = "2026-08-11T09:02:00.000Z";
const LATEST_AT = "2026-08-11T09:03:00.000Z";
const EARLIER_AT = "2026-08-11T08:59:00.000Z";
const RECEIPT_EXPIRES_AT = "2026-08-12T09:00:00.000Z";
const SECOND_RECEIPT_EXPIRES_AT = "2026-08-12T09:01:00.000Z";
const DATA_KEY_ID = "chat-folders-storage.v1";
const DATA_KEY = Buffer.alloc(32, 73).toString("base64url");

const defaultRules = (): ChatFolderRulesRecord => ({
  includeKinds: ["direct", "group", "channel"],
  unreadOnly: false,
  excludeMuted: true,
  includeArchived: false
});

const folderRecord = (
  userId: string,
  position: number,
  overrides: ChatFolderOverrideRecord[] = []
): ChatFolderRecord => ({
  id: randomUUID(),
  userId,
  title: `Папка ${position + 1}`,
  position,
  revision: 1,
  rules: defaultRules(),
  overrides,
  createdAt: CREATED_AT,
  updatedAt: CREATED_AT
});

describe("chat folder migrations 022-023 and SqliteStore invariants", () => {
  const stores: SqliteStore[] = [];
  const directories: string[] = [];

  afterEach(() => {
    for (const store of stores.splice(0)) {
      try {
        store.close();
      } catch {
        // A failed assertion must not hide the original failure during cleanup.
      }
    }
    for (const directory of directories.splice(0)) {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  function fixture() {
    const directory = mkdtempSync(join(tmpdir(), "luxora-chat-folders-storage-"));
    directories.push(directory);
    const databasePath = join(directory, "luxora.sqlite");
    const cipher = new AesGcmContentCipher({ [DATA_KEY_ID]: DATA_KEY }, DATA_KEY_ID);
    const store = new SqliteStore(databasePath, cipher);
    stores.push(store);

    const createUser = (prefix: string): UserRecord => {
      const suffix = randomUUID().replaceAll("-", "").slice(0, 10);
      const username = `${prefix}_${suffix}`;
      return store.createUser({
        id: randomUUID(),
        username,
        usernameNormalized: username,
        displayName: prefix,
        passwordHash: "test-only-password-hash",
        createdAt: CREATED_AT
      });
    };

    const createOwnedChat = (ownerId: string, members: string[] = []): string => {
      const chatId = randomUUID();
      store.createChat({
        id: chatId,
        kind: "group",
        title: "Folder storage fixture",
        directKey: null,
        createdBy: ownerId,
        createdAt: CREATED_AT
      });
      store.addChatMember(chatId, ownerId, "owner", CREATED_AT);
      for (const memberId of members) {
        if (memberId !== ownerId) store.addChatMember(chatId, memberId, "member", CREATED_AT);
      }
      return chatId;
    };

    return { databasePath, store, createUser, createOwnedChat };
  }

  function openDatabase(databasePath: string, readonly = false): Database.Database {
    const database = readonly
      ? new Database(databasePath, { readonly: true })
      : new Database(databasePath);
    database.pragma("foreign_keys = ON");
    return database;
  }

  it("installs the complete strict migration 022 surface", () => {
    const { databasePath } = fixture();
    const database = openDatabase(databasePath, true);
    try {
      expect(database.prepare(`
        SELECT id FROM schema_migrations WHERE id = '022_chat_folders'
      `).get()).toEqual({ id: "022_chat_folders" });
      expect(database.prepare(`
        SELECT id FROM schema_migrations WHERE id = '023_chat_folder_receipt_retention'
      `).get()).toEqual({ id: "023_chat_folder_receipt_retention" });

      const strictTables = (database.pragma("table_list") as Array<{
        name: string;
        strict: number;
      }>).filter((row) => row.name.startsWith("chat_folder"));
      expect(strictTables.map((row) => row.name).sort()).toEqual([
        "chat_folder_command_receipts",
        "chat_folder_overrides",
        "chat_folder_states",
        "chat_folders"
      ]);
      expect(strictTables.every((row) => row.strict === 1)).toBe(true);

      const triggers = (database.prepare(`
        SELECT name FROM sqlite_master
        WHERE type = 'trigger' AND name LIKE 'trg_chat_folder%'
        ORDER BY name
      `).all() as Array<{ name: string }>).map((row) => row.name);
      expect(triggers).toEqual(expect.arrayContaining([
        "trg_chat_folder_limit",
        "trg_chat_folder_override_limit",
        "trg_chat_folder_receipts_immutable",
        "trg_chat_folder_receipts_require_expiry",
        "trg_chat_folder_revision_monotonic",
        "trg_chat_folder_state_monotonic"
      ]));
      expect(triggers).not.toContain("trg_chat_folder_receipts_no_delete");

      const indexes = (database.prepare(`
        SELECT name FROM sqlite_master
        WHERE type = 'index' AND name LIKE 'idx_chat_folder%'
        ORDER BY name
      `).all() as Array<{ name: string }>).map((row) => row.name);
      expect(indexes).toEqual(expect.arrayContaining([
        "idx_chat_folder_overrides_account_chat",
        "idx_chat_folder_pinned_position",
        "idx_chat_folder_receipts_expiry",
        "idx_chat_folder_receipts_legacy_expiry",
        "idx_chat_folders_account_order"
      ]));
      const currentExpiryPlan = database.prepare(`
        EXPLAIN QUERY PLAN
        SELECT rowid FROM chat_folder_command_receipts
          INDEXED BY idx_chat_folder_receipts_expiry
        WHERE expires_at IS NOT NULL AND expires_at <= ?
        ORDER BY expires_at, user_id, client_nonce LIMIT ?
      `).all(RECEIPT_EXPIRES_AT, 100) as Array<{ detail: string }>;
      expect(currentExpiryPlan.map(({ detail }) => detail).join(" "))
        .toContain("idx_chat_folder_receipts_expiry");
      expect(currentExpiryPlan.map(({ detail }) => detail).join(" "))
        .not.toContain("TEMP B-TREE");
      const legacyExpiryPlan = database.prepare(`
        EXPLAIN QUERY PLAN
        SELECT rowid FROM chat_folder_command_receipts
          INDEXED BY idx_chat_folder_receipts_legacy_expiry
        WHERE expires_at IS NULL AND created_at <= ?
        ORDER BY created_at, user_id, client_nonce LIMIT ?
      `).all(CREATED_AT, 100) as Array<{ detail: string }>;
      expect(legacyExpiryPlan.map(({ detail }) => detail).join(" "))
        .toContain("idx_chat_folder_receipts_legacy_expiry");
      expect(legacyExpiryPlan.map(({ detail }) => detail).join(" "))
        .not.toContain("TEMP B-TREE");
      expect(database.pragma("integrity_check")).toEqual([{ integrity_check: "ok" }]);
      expect(database.pragma("foreign_key_check")).toEqual([]);
    } finally {
      database.close();
    }
  });

  it("persists create, update, reorder and delete while isolating accounts", () => {
    const { databasePath, store, createUser, createOwnedChat } = fixture();
    const firstAccount = createUser("first_account");
    const secondAccount = createUser("second_account");
    const firstChat = createOwnedChat(firstAccount.id);
    const secondChat = createOwnedChat(firstAccount.id);
    const isolatedChat = createOwnedChat(secondAccount.id);

    const firstFolder = store.createChatFolder(folderRecord(firstAccount.id, 0, [{
      chatId: firstChat,
      mode: "include",
      pinnedPosition: 0
    }]));
    const secondFolder = store.createChatFolder(folderRecord(firstAccount.id, 1));
    const isolatedFolder = store.createChatFolder(folderRecord(secondAccount.id, 0, [{
      chatId: isolatedChat,
      mode: "exclude",
      pinnedPosition: null
    }]));

    expect(store.countChatFolders(firstAccount.id)).toBe(2);
    expect(store.countChatFolders(secondAccount.id)).toBe(1);
    expect(store.listChatFolders(firstAccount.id).map((folder) => folder.id)).toEqual([
      firstFolder.id,
      secondFolder.id
    ]);
    expect(store.findChatFolder(secondAccount.id, firstFolder.id)).toBeNull();
    expect(store.updateChatFolder(secondAccount.id, firstFolder.id, {
      title: "Cross-account update",
      rules: defaultRules(),
      overrides: [],
      expectedRevision: 1,
      updatedAt: UPDATED_AT
    })).toBeNull();
    expect(store.deleteChatFolder(secondAccount.id, firstFolder.id, 1)).toBe(false);

    const updated = store.updateChatFolder(firstAccount.id, firstFolder.id, {
      title: "Непрочитанные",
      rules: {
        includeKinds: ["direct", "group"],
        unreadOnly: true,
        excludeMuted: false,
        includeArchived: true
      },
      overrides: [{ chatId: secondChat, mode: "exclude", pinnedPosition: null }],
      expectedRevision: 1,
      updatedAt: UPDATED_AT
    });
    expect(updated).toMatchObject({
      title: "Непрочитанные",
      revision: 2,
      position: 0,
      updatedAt: UPDATED_AT,
      overrides: [{ chatId: secondChat, mode: "exclude", pinnedPosition: null }]
    });
    expect(store.updateChatFolder(firstAccount.id, firstFolder.id, {
      title: "Stale update",
      rules: defaultRules(),
      overrides: [],
      expectedRevision: 1,
      updatedAt: REORDERED_AT
    })).toBeNull();

    const reordered = store.reorderChatFolders(
      firstAccount.id,
      [secondFolder.id, firstFolder.id],
      REORDERED_AT
    );
    expect(reordered.map((folder) => ({
      id: folder.id,
      position: folder.position,
      revision: folder.revision
    }))).toEqual([
      { id: secondFolder.id, position: 0, revision: 2 },
      { id: firstFolder.id, position: 1, revision: 3 }
    ]);
    expect(store.findChatFolder(secondAccount.id, isolatedFolder.id)).toMatchObject({
      position: 0,
      revision: 1
    });

    expect(store.deleteChatFolder(firstAccount.id, firstFolder.id, 2)).toBe(false);
    expect(store.deleteChatFolder(firstAccount.id, firstFolder.id, 3)).toBe(true);
    expect(store.findChatFolder(firstAccount.id, firstFolder.id)).toBeNull();
    expect(store.findChatFolder(secondAccount.id, isolatedFolder.id)).not.toBeNull();

    const database = openDatabase(databasePath, true);
    try {
      expect(database.prepare(`
        SELECT count(*) AS count FROM chat_folder_overrides WHERE folder_id = ?
      `).get(firstFolder.id)).toEqual({ count: 0 });
      expect(database.pragma("foreign_key_check")).toEqual([]);
      expect(database.pragma("integrity_check")).toEqual([{ integrity_check: "ok" }]);
    } finally {
      database.close();
    }
  });

  it("enforces the ten-folder and one-hundred-override limits in SQLite", () => {
    const { databasePath, store, createUser, createOwnedChat } = fixture();
    const account = createUser("limit_account");
    const folders = Array.from({ length: 10 }, (_, position) =>
      store.createChatFolder(folderRecord(account.id, position))
    );
    expect(store.countChatFolders(account.id)).toBe(10);
    expect(() => store.createChatFolder(folderRecord(account.id, 10)))
      .toThrow(/at most 10 custom chat folders/u);
    expect(store.countChatFolders(account.id)).toBe(10);

    const chats = Array.from({ length: 101 }, () => createOwnedChat(account.id));
    const maximumOverrides = chats.slice(0, 100).map((chatId, pinnedPosition) => ({
      chatId,
      mode: "include" as const,
      pinnedPosition
    }));
    const updated = store.transaction(() => store.updateChatFolder(account.id, folders[0]!.id, {
      title: folders[0]!.title,
      rules: folders[0]!.rules,
      overrides: maximumOverrides,
      expectedRevision: 1,
      updatedAt: UPDATED_AT
    }));
    expect(updated).toMatchObject({ revision: 2 });
    expect(updated?.overrides).toHaveLength(100);

    expect(() => store.transaction(() => store.updateChatFolder(account.id, folders[0]!.id, {
      title: folders[0]!.title,
      rules: folders[0]!.rules,
      overrides: [
        ...maximumOverrides,
        { chatId: chats[100]!, mode: "include", pinnedPosition: null }
      ],
      expectedRevision: 2,
      updatedAt: REORDERED_AT
    }))).toThrow(/at most 100 overrides/u);
    expect(store.findChatFolder(account.id, folders[0]!.id)).toMatchObject({ revision: 2 });
    expect(store.findChatFolder(account.id, folders[0]!.id)?.overrides).toHaveLength(100);

    const database = openDatabase(databasePath, true);
    try {
      expect(database.prepare(`
        SELECT count(*) AS count FROM chat_folder_overrides WHERE folder_id = ?
      `).get(folders[0]!.id)).toEqual({ count: 100 });
      expect(database.pragma("integrity_check")).toEqual([{ integrity_check: "ok" }]);
      expect(database.pragma("foreign_key_check")).toEqual([]);
    } finally {
      database.close();
    }
  });

  it("rejects duplicate overrides, duplicate pins, invalid pins and non-member chat references atomically", () => {
    const { store, createUser, createOwnedChat } = fixture();
    const account = createUser("override_account");
    const otherAccount = createUser("other_account");
    const firstChat = createOwnedChat(account.id);
    const secondChat = createOwnedChat(account.id);
    const otherChat = createOwnedChat(otherAccount.id);
    const original = store.createChatFolder(folderRecord(account.id, 0, [{
      chatId: firstChat,
      mode: "include",
      pinnedPosition: 0
    }]));

    const expectRejected = (overrides: ChatFolderOverrideRecord[], pattern: RegExp) => {
      expect(() => store.transaction(() => store.updateChatFolder(account.id, original.id, {
        title: "Invalid replacement",
        rules: defaultRules(),
        overrides,
        expectedRevision: 1,
        updatedAt: UPDATED_AT
      }))).toThrow(pattern);
      expect(store.findChatFolder(account.id, original.id)).toEqual(original);
    };

    expectRejected([
      { chatId: firstChat, mode: "include", pinnedPosition: null },
      { chatId: firstChat, mode: "exclude", pinnedPosition: null }
    ], /UNIQUE constraint failed: chat_folder_overrides\.folder_id, chat_folder_overrides\.chat_id/u);
    expectRejected([
      { chatId: firstChat, mode: "include", pinnedPosition: 7 },
      { chatId: secondChat, mode: "include", pinnedPosition: 7 }
    ], /UNIQUE constraint failed: chat_folder_overrides\.folder_id, chat_folder_overrides\.pinned_position/u);
    expectRejected([
      { chatId: secondChat, mode: "exclude", pinnedPosition: 1 }
    ], /CHECK constraint failed/u);
    expectRejected([
      { chatId: otherChat, mode: "include", pinnedPosition: null }
    ], /FOREIGN KEY constraint failed/u);
  });

  it("enforces folder row bounds, chronology and foreign-key ownership", () => {
    const { databasePath, store, createUser } = fixture();
    const account = createUser("row_guard_account");
    const valid = folderRecord(account.id, 9_999);
    valid.title = "😀".repeat(48);
    expect(store.createChatFolder(valid)).toMatchObject({
      title: valid.title,
      position: 9_999,
      revision: 1
    });

    const invalidFolders: Array<{ folder: ChatFolderRecord; pattern: RegExp }> = [
      { folder: { ...folderRecord(account.id, 0), title: "" }, pattern: /CHECK constraint failed/u },
      {
        folder: { ...folderRecord(account.id, 0), title: "😀".repeat(49) },
        pattern: /CHECK constraint failed/u
      },
      { folder: { ...folderRecord(account.id, 10_000) }, pattern: /CHECK constraint failed/u },
      { folder: { ...folderRecord(account.id, 0), revision: 0 }, pattern: /CHECK constraint failed/u },
      {
        folder: {
          ...folderRecord(account.id, 0),
          createdAt: UPDATED_AT,
          updatedAt: CREATED_AT
        },
        pattern: /CHECK constraint failed/u
      },
      {
        folder: { ...folderRecord(randomUUID(), 0) },
        pattern: /FOREIGN KEY constraint failed/u
      }
    ];
    for (const { folder, pattern } of invalidFolders) {
      expect(() => store.createChatFolder(folder)).toThrow(pattern);
    }

    const database = openDatabase(databasePath, true);
    try {
      expect(database.pragma("foreign_key_check")).toEqual([]);
      expect(database.pragma("integrity_check")).toEqual([{ integrity_check: "ok" }]);
    } finally {
      database.close();
    }
  });

  it("keeps folder and account state revisions exactly monotonic", () => {
    const { databasePath, store, createUser } = fixture();
    const account = createUser("revision_account");
    const isolatedAccount = createUser("isolated_revision_account");
    const folder = store.createChatFolder(folderRecord(account.id, 0));

    expect(store.getChatFolderStateRevision(account.id)).toBe(0);
    expect(store.getChatFolderStateRevision(isolatedAccount.id)).toBe(0);
    expect(store.advanceChatFolderStateRevision(account.id, UPDATED_AT)).toBe(1);
    expect(store.advanceChatFolderStateRevision(account.id, REORDERED_AT)).toBe(2);
    expect(store.advanceChatFolderStateRevision(account.id, CREATED_AT)).toBe(3);
    expect(store.getChatFolderStateRevision(isolatedAccount.id)).toBe(0);

    const updated = store.updateChatFolder(account.id, folder.id, {
      title: "Revision two",
      rules: defaultRules(),
      overrides: [],
      expectedRevision: 1,
      updatedAt: UPDATED_AT
    });
    expect(updated).toMatchObject({ revision: 2, updatedAt: UPDATED_AT });

    const database = openDatabase(databasePath);
    try {
      expect(database.prepare(`
        SELECT revision, updated_at FROM chat_folder_states WHERE user_id = ?
      `).get(account.id)).toEqual({ revision: 3, updated_at: REORDERED_AT });
      expect(() => database.prepare(`
        UPDATE chat_folder_states
        SET revision = revision + 2, updated_at = ?
        WHERE user_id = ?
      `).run(LATEST_AT, account.id)).toThrow(/state revision must advance exactly once/u);
      expect(() => database.prepare(`
        UPDATE chat_folder_states
        SET revision = revision + 1, updated_at = ?
        WHERE user_id = ?
      `).run(EARLIER_AT, account.id)).toThrow(/state revision must advance exactly once/u);
      expect(() => database.prepare(`
        UPDATE chat_folders
        SET revision = revision + 2, updated_at = ?
        WHERE id = ? AND user_id = ?
      `).run(REORDERED_AT, folder.id, account.id)).toThrow(/folder revision must advance exactly once/u);
      expect(() => database.prepare(`
        UPDATE chat_folders
        SET revision = revision + 1, updated_at = ?
        WHERE id = ? AND user_id = ?
      `).run(EARLIER_AT, folder.id, account.id)).toThrow(/folder revision must advance exactly once/u);
      expect(store.findChatFolder(account.id, folder.id)).toMatchObject({
        revision: 2,
        updatedAt: UPDATED_AT
      });
      expect(store.getChatFolderStateRevision(account.id)).toBe(3);
      expect(database.pragma("integrity_check")).toEqual([{ integrity_check: "ok" }]);
    } finally {
      database.close();
    }
  });

  it("encrypts, account-scopes and makes idempotency receipts immutable", () => {
    const { databasePath, store, createUser } = fixture();
    const firstAccount = createUser("receipt_account");
    const secondAccount = createUser("second_receipt_account");
    const clientNonce = randomUUID();
    const secretMarker = `CHAT_FOLDER_RECEIPT_SECRET_${randomUUID()}`;
    const secondSecretMarker = `SECOND_CHAT_FOLDER_RECEIPT_SECRET_${randomUUID()}`;
    const responseJson = JSON.stringify({ stateRevision: 8, marker: secretMarker });
    const secondResponseJson = JSON.stringify({ stateRevision: 2, marker: secondSecretMarker });
    const fingerprint = createHash("sha256").update("create-folder-command").digest("hex");

    store.createChatFolderCommandReceipt({
      userId: firstAccount.id,
      clientNonce,
      operation: "create",
      fingerprint,
      responseJson,
      createdAt: CREATED_AT,
      expiresAt: RECEIPT_EXPIRES_AT
    });
    store.createChatFolderCommandReceipt({
      userId: secondAccount.id,
      clientNonce,
      operation: "reorder",
      fingerprint: createHash("sha256").update("reorder-folder-command").digest("hex"),
      responseJson: secondResponseJson,
      createdAt: UPDATED_AT,
      expiresAt: SECOND_RECEIPT_EXPIRES_AT
    });

    expect(store.findChatFolderCommandReceipt(firstAccount.id, clientNonce, CREATED_AT)).toEqual({
      userId: firstAccount.id,
      clientNonce,
      operation: "create",
      fingerprint,
      responseJson,
      createdAt: CREATED_AT,
      expiresAt: RECEIPT_EXPIRES_AT
    });
    expect(store.findChatFolderCommandReceipt(secondAccount.id, clientNonce, CREATED_AT)).toMatchObject({
      operation: "reorder",
      responseJson: secondResponseJson
    });
    expect(store.findChatFolderCommandReceipt(randomUUID(), clientNonce, CREATED_AT)).toBeNull();
    expect(() => store.createChatFolderCommandReceipt({
      userId: firstAccount.id,
      clientNonce,
      operation: "create",
      fingerprint,
      responseJson,
      createdAt: CREATED_AT,
      expiresAt: RECEIPT_EXPIRES_AT
    })).toThrow(/UNIQUE constraint failed/u);

    const database = openDatabase(databasePath);
    try {
      const rows = database.prepare(`
        SELECT user_id, response_ciphertext
        FROM chat_folder_command_receipts
        WHERE client_nonce = ?
        ORDER BY user_id
      `).all(clientNonce) as Array<{ user_id: string; response_ciphertext: string }>;
      expect(rows).toHaveLength(2);
      expect(rows.every((row) => row.response_ciphertext.startsWith("luxora:v1."))).toBe(true);
      expect(rows.every((row) => !row.response_ciphertext.includes(secretMarker))).toBe(true);
      expect(rows.every((row) => !row.response_ciphertext.includes(secondSecretMarker))).toBe(true);
      expect(new Set(rows.map((row) => row.response_ciphertext)).size).toBe(2);

      expect(() => database.prepare(`
        UPDATE chat_folder_command_receipts SET fingerprint = 'tampered'
        WHERE user_id = ? AND client_nonce = ?
      `).run(firstAccount.id, clientNonce)).toThrow(/receipt is immutable/u);
      expect(() => database.prepare(`
        INSERT INTO chat_folder_command_receipts (
          user_id, client_nonce, operation, fingerprint,
          response_ciphertext, created_at, expires_at
        ) VALUES (?, ?, 'delete', ?, ?, ?, ?)
      `).run(
        firstAccount.id,
        randomUUID(),
        "f".repeat(64),
        '{"marker":"REJECT_PLAINTEXT_RECEIPT"}',
        CREATED_AT,
        RECEIPT_EXPIRES_AT
      )).toThrow(/CHECK constraint failed/u);
      expect(database.pragma("foreign_key_check")).toEqual([]);
      expect(database.pragma("integrity_check")).toEqual([{ integrity_check: "ok" }]);
    } finally {
      database.close();
    }

    for (const file of [databasePath, `${databasePath}-wal`].filter(existsSync)) {
      const bytes = readFileSync(file);
      expect(bytes.includes(Buffer.from(secretMarker, "utf8"))).toBe(false);
      expect(bytes.includes(Buffer.from(secondSecretMarker, "utf8"))).toBe(false);
    }
    expect(store.findChatFolderCommandReceipt(firstAccount.id, clientNonce, CREATED_AT)?.responseJson)
      .toBe(responseJson);
    expect(store.findChatFolderCommandReceipt(
      firstAccount.id,
      clientNonce,
      RECEIPT_EXPIRES_AT
    )).toBeNull();
    expect(store.countActiveChatFolderCommandReceipts(firstAccount.id, CREATED_AT)).toBe(1);
    expect(store.countActiveChatFolderCommandReceipts(firstAccount.id, RECEIPT_EXPIRES_AT)).toBe(0);
    expect(store.purgeExpiredChatFolderCommandReceipts(RECEIPT_EXPIRES_AT, 100)).toBe(1);
  });
});
