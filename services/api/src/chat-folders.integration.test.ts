import { randomUUID } from "node:crypto";
import { MAX_CHAT_FOLDER_ACTIVE_COMMAND_RECEIPTS } from "@luxora/protocol";
import { afterEach, describe, expect, it } from "vitest";
import type { LuxoraApp } from "./app.js";
import { buildApp } from "./app.js";
import { establishAcceptedRelationship, testConfig } from "./test-helpers.js";

interface Identity {
  id: string;
  accessToken: string;
}

const DEFAULT_RULES = {
  includeKinds: ["direct", "group", "channel"],
  unreadOnly: false,
  excludeMuted: true,
  includeArchived: false
} as const;

describe("account-scoped synchronized chat folders", () => {
  let app: LuxoraApp | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  async function fixture(): Promise<void> {
    app = await buildApp({
      config: testConfig({
        dataEncryptionKeys: { folder_test: Buffer.alloc(32, 7).toString("base64url") },
        activeDataEncryptionKeyId: "folder_test"
      }),
      logger: false
    });
  }

  async function register(username: string): Promise<Identity> {
    const response = await app!.inject({
      method: "POST",
      url: "/v1/auth/register",
      payload: {
        username,
        displayName: username,
        password: "correct horse battery staple",
        deviceName: `${username} iPhone`
      }
    });
    expect(response.statusCode, response.body).toBe(201);
    return {
      id: response.json().user.id as string,
      accessToken: response.json().tokens.accessToken as string
    };
  }

  function headers(identity: Identity): { authorization: string } {
    return { authorization: `Bearer ${identity.accessToken}` };
  }

  async function createSavedChat(identity: Identity): Promise<string> {
    const response = await app!.inject({
      method: "POST",
      url: "/v1/chats",
      headers: headers(identity),
      payload: { kind: "direct", userId: identity.id }
    });
    expect(response.statusCode, response.body).toBe(201);
    return response.json().chat.id as string;
  }

  it("creates, exactly replays, patches, reorders and deletes with one private state event per change", async () => {
    await fixture();
    const alice = await register("folder_alice");
    const bob = await register("folder_bob");
    const firstChatId = await createSavedChat(alice);
    const secondChatId = await establishAcceptedRelationship(app!, alice, bob);

    const empty = await app!.inject({
      method: "GET",
      url: "/v1/chat-folders",
      headers: headers(alice)
    });
    expect(empty.statusCode, empty.body).toBe(200);
    expect(empty.json()).toEqual({ items: [], stateRevision: 0 });

    const firstNonce = randomUUID();
    const beforeCreate = app!.luxora.store.getLatestSequence();
    const created = await app!.inject({
      method: "POST",
      url: "/v1/chat-folders",
      headers: headers(alice),
      payload: {
        title: "Личное",
        rules: DEFAULT_RULES,
        overrides: [
          { chatId: firstChatId, mode: "include", pinnedPosition: 0 },
          { chatId: secondChatId, mode: "exclude", pinnedPosition: null }
        ],
        clientNonce: firstNonce
      }
    });
    expect(created.statusCode, created.body).toBe(201);
    expect(created.json()).toMatchObject({
      folder: {
        title: "Личное",
        position: 0,
        revision: 1,
        rules: DEFAULT_RULES,
        overrides: [
          { chatId: firstChatId, mode: "include", pinnedPosition: 0 },
          { chatId: secondChatId, mode: "exclude", pinnedPosition: null }
        ]
      },
      stateRevision: 1,
      replayed: false
    });
    const firstFolderId = created.json().folder.id as string;
    const afterCreate = app!.luxora.store.getLatestSequence();
    expect(afterCreate).toBe(beforeCreate + 1);
    expect(app!.luxora.store.replayEvents(alice.id, beforeCreate, afterCreate, 10)[0]?.event)
      .toMatchObject({
        type: "chat.folders.updated",
        audience: "actor_account",
        accountId: alice.id,
        stateRevision: 1
      });
    expect(app!.luxora.store.replayEvents(bob.id, beforeCreate, afterCreate, 10)).toEqual([]);

    const exactReplay = await app!.inject({
      method: "POST",
      url: "/v1/chat-folders",
      headers: headers(alice),
      payload: {
        title: "Личное",
        rules: { ...DEFAULT_RULES, includeKinds: ["channel", "direct", "group"] },
        overrides: [
          { chatId: secondChatId, mode: "exclude", pinnedPosition: null },
          { chatId: firstChatId, mode: "include", pinnedPosition: 0 }
        ],
        clientNonce: firstNonce
      }
    });
    expect(exactReplay.statusCode, exactReplay.body).toBe(201);
    expect(exactReplay.json()).toEqual({ ...created.json(), replayed: true });
    expect(app!.luxora.store.getLatestSequence()).toBe(afterCreate);

    const nonceConflict = await app!.inject({
      method: "POST",
      url: "/v1/chat-folders",
      headers: headers(alice),
      payload: {
        title: "Другое",
        rules: DEFAULT_RULES,
        overrides: [],
        clientNonce: firstNonce
      }
    });
    expect(nonceConflict.statusCode).toBe(409);

    const updated = await app!.inject({
      method: "PATCH",
      url: `/v1/chat-folders/${firstFolderId}`,
      headers: headers(alice),
      payload: {
        title: "Избранное",
        expectedRevision: 1,
        clientNonce: randomUUID()
      }
    });
    expect(updated.statusCode, updated.body).toBe(200);
    expect(updated.json()).toMatchObject({
      folder: { id: firstFolderId, title: "Избранное", revision: 2 },
      stateRevision: 2,
      replayed: false
    });
    const afterUpdate = app!.luxora.store.getLatestSequence();

    const noOp = await app!.inject({
      method: "PATCH",
      url: `/v1/chat-folders/${firstFolderId}`,
      headers: headers(alice),
      payload: {
        title: "Избранное",
        expectedRevision: 2,
        clientNonce: randomUUID()
      }
    });
    expect(noOp.statusCode, noOp.body).toBe(200);
    expect(noOp.json()).toMatchObject({ folder: { revision: 2 }, stateRevision: 2, replayed: false });
    expect(app!.luxora.store.getLatestSequence()).toBe(afterUpdate);

    const second = await app!.inject({
      method: "POST",
      url: "/v1/chat-folders",
      headers: headers(alice),
      payload: {
        title: "Непрочитанные",
        rules: { ...DEFAULT_RULES, unreadOnly: true },
        overrides: [{ chatId: secondChatId, mode: "exclude", pinnedPosition: null }],
        clientNonce: randomUUID()
      }
    });
    expect(second.statusCode, second.body).toBe(201);
    const secondFolderId = second.json().folder.id as string;
    expect(second.json().stateRevision).toBe(3);

    const reordered = await app!.inject({
      method: "PUT",
      url: "/v1/chat-folders/order",
      headers: headers(alice),
      payload: {
        folderIds: [secondFolderId, firstFolderId],
        expectedStateRevision: 3,
        clientNonce: randomUUID()
      }
    });
    expect(reordered.statusCode, reordered.body).toBe(200);
    expect(reordered.json()).toMatchObject({ stateRevision: 4, replayed: false });
    expect(reordered.json().items.map((folder: { id: string; position: number }) => [folder.id, folder.position]))
      .toEqual([[secondFolderId, 0], [firstFolderId, 1]]);

    const stalePatch = await app!.inject({
      method: "PATCH",
      url: `/v1/chat-folders/${firstFolderId}`,
      headers: headers(alice),
      payload: { title: "Устарело", expectedRevision: 2, clientNonce: randomUUID() }
    });
    expect(stalePatch.statusCode).toBe(409);

    const listed = await app!.inject({
      method: "GET",
      url: "/v1/chat-folders",
      headers: headers(alice)
    });
    expect(listed.json().stateRevision).toBe(4);
    const firstAfterReorder = listed.json().items.find((folder: { id: string }) => folder.id === firstFolderId);
    const deleteNonce = randomUUID();
    const deleted = await app!.inject({
      method: "DELETE",
      url: `/v1/chat-folders/${firstFolderId}`,
      headers: headers(alice),
      payload: { expectedRevision: firstAfterReorder.revision, clientNonce: deleteNonce }
    });
    expect(deleted.statusCode, deleted.body).toBe(200);
    expect(deleted.json()).toEqual({ folderId: firstFolderId, stateRevision: 5, replayed: false });

    const deleteReplay = await app!.inject({
      method: "DELETE",
      url: `/v1/chat-folders/${firstFolderId}`,
      headers: headers(alice),
      payload: { expectedRevision: firstAfterReorder.revision, clientNonce: deleteNonce }
    });
    expect(deleteReplay.statusCode, deleteReplay.body).toBe(200);
    expect(deleteReplay.json()).toEqual({ ...deleted.json(), replayed: true });

    const finalList = await app!.inject({
      method: "GET",
      url: "/v1/chat-folders",
      headers: headers(alice)
    });
    expect(finalList.json()).toMatchObject({
      items: [{ id: secondFolderId, position: 0 }],
      stateRevision: 5
    });
  });

  it("keeps folders private and rejects overrides for chats unavailable to the account", async () => {
    await fixture();
    const alice = await register("folder_private_alice");
    const bob = await register("folder_private_bob");
    const aliceChatId = await createSavedChat(alice);

    const foreignOverride = await app!.inject({
      method: "POST",
      url: "/v1/chat-folders",
      headers: headers(bob),
      payload: {
        title: "Чужое",
        rules: DEFAULT_RULES,
        overrides: [{ chatId: aliceChatId, mode: "include", pinnedPosition: null }],
        clientNonce: randomUUID()
      }
    });
    expect(foreignOverride.statusCode).toBe(400);
    expect(foreignOverride.json().error.message).toBe("Chat folder contains an unavailable chat");

    const created = await app!.inject({
      method: "POST",
      url: "/v1/chat-folders",
      headers: headers(alice),
      payload: {
        title: "Alice only",
        rules: DEFAULT_RULES,
        overrides: [],
        clientNonce: randomUUID()
      }
    });
    expect(created.statusCode, created.body).toBe(201);
    const bobList = await app!.inject({
      method: "GET",
      url: "/v1/chat-folders",
      headers: headers(bob)
    });
    expect(bobList.json()).toEqual({ items: [], stateRevision: 0 });

    const foreignPatch = await app!.inject({
      method: "PATCH",
      url: `/v1/chat-folders/${created.json().folder.id as string}`,
      headers: headers(bob),
      payload: { title: "Украдено", expectedRevision: 1, clientNonce: randomUUID() }
    });
    expect(foreignPatch.statusCode).toBe(404);
  });

  it("removes a departed chat override and advances the removed account folder state", async () => {
    await fixture();
    const alice = await register("folder_departure_alice");
    const bob = await register("folder_departure_bob");
    await establishAcceptedRelationship(app!, alice, bob);
    const group = await app!.inject({
      method: "POST",
      url: "/v1/chats",
      headers: headers(alice),
      payload: { kind: "group", title: "Departure", memberIds: [bob.id] }
    });
    expect(group.statusCode, group.body).toBe(201);
    const chatId = group.json().chat.id as string;

    const folder = await app!.inject({
      method: "POST",
      url: "/v1/chat-folders",
      headers: headers(bob),
      payload: {
        title: "Моя группа",
        rules: DEFAULT_RULES,
        overrides: [{ chatId, mode: "include", pinnedPosition: 0 }],
        clientNonce: randomUUID()
      }
    });
    expect(folder.statusCode, folder.body).toBe(201);
    expect(folder.json()).toMatchObject({ folder: { revision: 1 }, stateRevision: 1 });
    const beforeRemoval = app!.luxora.store.getLatestSequence();

    const removed = await app!.inject({
      method: "DELETE",
      url: `/v1/chats/${chatId}/members/${bob.id}`,
      headers: headers(alice),
      payload: { expectedRevision: 1, clientNonce: randomUUID() }
    });
    expect(removed.statusCode, removed.body).toBe(200);

    const afterRemoval = app!.luxora.store.getLatestSequence();
    const bobEvents = app!.luxora.store.replayEvents(bob.id, beforeRemoval, afterRemoval, 20)
      .map((entry) => entry.event);
    expect(bobEvents).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: "chat.member.changed",
        audience: "removed_account",
        change: "removed"
      }),
      expect.objectContaining({
        type: "chat.folders.updated",
        audience: "actor_account",
        accountId: bob.id,
        stateRevision: 2
      })
    ]));

    const reconciled = await app!.inject({
      method: "GET",
      url: "/v1/chat-folders",
      headers: headers(bob)
    });
    expect(reconciled.statusCode, reconciled.body).toBe(200);
    expect(reconciled.json()).toMatchObject({
      items: [{
        id: folder.json().folder.id,
        revision: 2,
        overrides: []
      }],
      stateRevision: 2
    });
  });

  it("bounds active idempotency storage and returns an actionable retry horizon", async () => {
    await fixture();
    const alice = await register("folder_receipt_quota");
    const createdAt = new Date().toISOString();
    const expiresAt = new Date(Date.parse(createdAt) + 24 * 60 * 60 * 1_000).toISOString();
    for (let index = 0; index < MAX_CHAT_FOLDER_ACTIVE_COMMAND_RECEIPTS; index += 1) {
      app!.luxora.store.createChatFolderCommandReceipt({
        userId: alice.id,
        clientNonce: randomUUID(),
        operation: "delete",
        fingerprint: String(index).padStart(64, "0"),
        responseJson: "{}",
        createdAt,
        expiresAt
      });
    }

    const beforeSequence = app!.luxora.store.getLatestSequence();
    const rejected = await app!.inject({
      method: "POST",
      url: "/v1/chat-folders",
      headers: headers(alice),
      payload: {
        title: "Не должна создаться",
        rules: DEFAULT_RULES,
        overrides: [],
        clientNonce: randomUUID()
      }
    });
    expect(rejected.statusCode, rejected.body).toBe(429);
    expect(Number(rejected.headers["retry-after"])).toBeGreaterThan(0);
    expect(rejected.json()).toMatchObject({
      error: {
        code: "RATE_LIMITED",
        details: {
          idempotencyTtlSeconds: 86_400,
          maxActiveReceipts: MAX_CHAT_FOLDER_ACTIVE_COMMAND_RECEIPTS
        }
      }
    });
    expect(app!.luxora.store.getChatFolderSnapshot(alice.id)).toEqual({
      items: [],
      stateRevision: 0
    });
    expect(app!.luxora.store.getLatestSequence()).toBe(beforeSequence);
  });

  it("reuses an expired nonce even behind more than one global purge batch", async () => {
    await fixture();
    const alice = await register("folder_expired_nonce");
    const targetNonce = randomUUID();
    for (let index = 0; index < 256; index += 1) {
      app!.luxora.store.createChatFolderCommandReceipt({
        userId: alice.id,
        clientNonce: randomUUID(),
        operation: "delete",
        fingerprint: String(index).padStart(64, "0"),
        responseJson: "{}",
        createdAt: "2020-01-01T00:00:00.000Z",
        expiresAt: "2020-01-02T00:00:00.000Z"
      });
    }
    app!.luxora.store.createChatFolderCommandReceipt({
      userId: alice.id,
      clientNonce: targetNonce,
      operation: "create",
      fingerprint: "f".repeat(64),
      responseJson: "{}",
      createdAt: "2020-01-02T00:00:00.000Z",
      expiresAt: "2020-01-03T00:00:00.000Z"
    });

    const created = await app!.inject({
      method: "POST",
      url: "/v1/chat-folders",
      headers: headers(alice),
      payload: {
        title: "Новый срок nonce",
        rules: DEFAULT_RULES,
        overrides: [],
        clientNonce: targetNonce
      }
    });
    expect(created.statusCode, created.body).toBe(201);
    expect(created.json()).toMatchObject({
      folder: { title: "Новый срок nonce" },
      stateRevision: 1,
      replayed: false
    });
    expect(app!.luxora.store.countActiveChatFolderCommandReceipts(
      alice.id,
      new Date().toISOString()
    )).toBe(1);
  });

  it("requires authentication and rejects non-strict or inconsistent commands", async () => {
    await fixture();
    const alice = await register("folder_validation");
    const chatId = await createSavedChat(alice);

    for (const request of [
      { method: "GET" as const, url: "/v1/chat-folders" },
      {
        method: "POST" as const,
        url: "/v1/chat-folders",
        payload: { title: "A", rules: DEFAULT_RULES, overrides: [], clientNonce: randomUUID() }
      },
      {
        method: "PUT" as const,
        url: "/v1/chat-folders/order",
        payload: {
          folderIds: [randomUUID()],
          expectedStateRevision: 0,
          clientNonce: randomUUID()
        }
      },
      {
        method: "PATCH" as const,
        url: `/v1/chat-folders/${randomUUID()}`,
        payload: { title: "A", expectedRevision: 1, clientNonce: randomUUID() }
      },
      {
        method: "DELETE" as const,
        url: `/v1/chat-folders/${randomUUID()}`,
        payload: { expectedRevision: 1, clientNonce: randomUUID() }
      }
    ]) {
      const response = await app!.inject(request);
      expect(response.statusCode, `${request.method} ${request.url}: ${response.body}`).toBe(401);
    }

    for (const payload of [
      {
        title: "Invalid extra",
        rules: DEFAULT_RULES,
        overrides: [],
        clientNonce: randomUUID(),
        userId: alice.id
      },
      {
        title: "Invalid duplicate",
        rules: DEFAULT_RULES,
        overrides: [
          { chatId, mode: "include", pinnedPosition: null },
          { chatId, mode: "exclude", pinnedPosition: null }
        ],
        clientNonce: randomUUID()
      },
      {
        title: "Invalid pin",
        rules: DEFAULT_RULES,
        overrides: [{ chatId, mode: "exclude", pinnedPosition: 0 }],
        clientNonce: randomUUID()
      }
    ]) {
      const response = await app!.inject({
        method: "POST",
        url: "/v1/chat-folders",
        headers: headers(alice),
        payload
      });
      expect(response.statusCode, response.body).toBe(400);
      expect(response.json().error.code).toBe("VALIDATION_FAILED");
    }
  });
});
