import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { LuxoraApp } from "./app.js";
import { buildApp } from "./app.js";
import { AesGcmContentCipher } from "./infrastructure/content-cipher.js";
import { SearchHasher } from "./infrastructure/search-hasher.js";
import { SqliteStore } from "./infrastructure/sqlite-store.js";
import { ChatService } from "./services/chat-service.js";
import type { UserRecord } from "./domain/types.js";
import { testConfig } from "./test-helpers.js";

const DATA_KEY = Buffer.alloc(32, 63).toString("base64url");
const BASE_TIME = "2026-09-12T00:00:00.000Z";

function httpConfig() {
  return testConfig({
    dataEncryptionKeys: { test: DATA_KEY },
    activeDataEncryptionKeyId: "test"
  });
}

async function register(app: LuxoraApp, username: string): Promise<{ id: string; accessToken: string }> {
  const response = await app.inject({
    method: "POST",
    url: "/v1/auth/register",
    payload: { username, displayName: username, password: "correct horse battery staple" }
  });
  expect(response.statusCode, response.body).toBe(201);
  return {
    id: response.json().user.id as string,
    accessToken: response.json().tokens.accessToken as string
  };
}

describe("scheduled messages", () => {
  let app: LuxoraApp | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it("schedules text-only messages within bounded horizons, lists and cancels them", async () => {
    app = await buildApp({ config: httpConfig(), logger: false });
    const alice = await register(app, "sched_alice");
    const bob = await register(app, "sched_bob");
    const aliceHeaders = { authorization: `Bearer ${alice.accessToken}` };

    const chat = await app.inject({
      method: "POST",
      url: "/v1/chats",
      headers: aliceHeaders,
      payload: { kind: "direct", userId: bob.id }
    });
    expect(chat.statusCode, chat.body).toBe(201);
    const chatId = chat.json().chat.id as string;

    const past = await app.inject({
      method: "POST",
      url: `/v1/chats/${chatId}/scheduled`,
      headers: aliceHeaders,
      payload: {
        body: "Too late",
        clientNonce: randomUUID(),
        sendAt: new Date(Date.now() - 1_000).toISOString()
      }
    });
    expect(past.statusCode, past.body).toBe(400);

    const farFuture = await app.inject({
      method: "POST",
      url: `/v1/chats/${chatId}/scheduled`,
      headers: aliceHeaders,
      payload: {
        body: "Too far",
        clientNonce: randomUUID(),
        sendAt: new Date(Date.now() + 366 * 86_400_000).toISOString()
      }
    });
    expect(farFuture.statusCode, farFuture.body).toBe(400);

    const withAttachments = await app.inject({
      method: "POST",
      url: `/v1/chats/${chatId}/scheduled`,
      headers: aliceHeaders,
      payload: {
        body: "With media",
        clientNonce: randomUUID(),
        attachmentIds: [randomUUID()],
        sendAt: new Date(Date.now() + 3_600_000).toISOString()
      }
    });
    expect(withAttachments.statusCode, withAttachments.body).toBe(400);

    const first = await app.inject({
      method: "POST",
      url: `/v1/chats/${chatId}/scheduled`,
      headers: aliceHeaders,
      payload: {
        body: "Напомнить через час",
        clientNonce: randomUUID(),
        sendAt: new Date(Date.now() + 3_600_000).toISOString()
      }
    });
    expect(first.statusCode, first.body).toBe(201);
    expect(first.json().scheduled).toMatchObject({ chatId, state: "pending" });
    const firstId = first.json().scheduled.id as string;

    const listed = await app.inject({
      method: "GET",
      url: `/v1/chats/${chatId}/scheduled?limit=10`,
      headers: aliceHeaders
    });
    expect(listed.statusCode, listed.body).toBe(200);
    expect(listed.json().items.map((item: { id: string }) => item.id)).toEqual([firstId]);
    expect(listed.json().nextCursor).toBeNull();

    const foreign = await app.inject({
      method: "GET",
      url: `/v1/chats/${chatId}/scheduled?limit=10`,
      headers: { authorization: `Bearer ${bob.accessToken}` }
    });
    expect(foreign.statusCode).toBe(200);
    expect(foreign.json().items).toEqual([]);

    const cancelled = await app.inject({
      method: "DELETE",
      url: `/v1/scheduled/${firstId}`,
      headers: aliceHeaders
    });
    expect(cancelled.statusCode, cancelled.body).toBe(204);

    const afterCancel = await app.inject({
      method: "GET",
      url: `/v1/chats/${chatId}/scheduled?limit=10`,
      headers: aliceHeaders
    });
    expect(afterCancel.json().items).toEqual([]);

    const recancel = await app.inject({
      method: "DELETE",
      url: `/v1/scheduled/${firstId}`,
      headers: aliceHeaders
    });
    expect(recancel.statusCode).toBe(404);
  }, 30_000);

  it("dispatches due rows through live guards and records bounded failures", () => {
    const directory = mkdtempSync(join(tmpdir(), "luxora-scheduled-"));
    const store = new SqliteStore(
      join(directory, "luxora.sqlite"),
      new AesGcmContentCipher({ test: DATA_KEY }, "test")
    );
    try {
      const service = new ChatService(
        store,
        { publish() {}, publishEphemeral() {} },
        new SearchHasher({}, undefined)
      );
      const createUser = (username: string): UserRecord => store.createUser({
        id: randomUUID(),
        username,
        usernameNormalized: username,
        displayName: username,
        passwordHash: "test-only-password-hash",
        createdAt: BASE_TIME
      });
      const alice = createUser("dispatch_alice");
      const bob = createUser("dispatch_bob");
      const chatId = randomUUID();
      store.createChat({
        id: chatId,
        kind: "direct",
        title: null,
        directKey: [alice.id, bob.id].sort().join(":"),
        createdBy: alice.id,
        createdAt: BASE_TIME
      });
      store.addChatMember(chatId, alice.id, "member", BASE_TIME);
      store.addChatMember(chatId, bob.id, "member", BASE_TIME);

      const due = store.createScheduledMessage({
        id: randomUUID(),
        chatId,
        senderId: alice.id,
        body: "Отложенное",
        replyToMessageId: null,
        topicId: null,
        clientNonce: randomUUID(),
        sendAt: "2026-01-01T00:00:00.000Z",
        createdAt: "2025-01-01T00:00:00.000Z"
      });
      const future = store.createScheduledMessage({
        id: randomUUID(),
        chatId,
        senderId: alice.id,
        body: "Позже",
        replyToMessageId: null,
        topicId: null,
        clientNonce: randomUUID(),
        sendAt: "2999-01-01T00:00:00.000Z",
        createdAt: BASE_TIME
      });

      const dispatched = service.dispatchDueScheduledMessages(new Date("2026-06-01T00:00:00.000Z"));
      expect(dispatched).toEqual({ sent: 1, failed: 0 });
      const delivered = store.findMessageByNonce(alice.id, due.clientNonce);
      expect(delivered?.body).toBe("Отложенное");
      expect(store.listScheduledForChat(chatId, alice.id, 10).items.map((item) => item.id))
        .not.toContain(due.id);

      const redispatched = service.dispatchDueScheduledMessages(new Date("2026-06-01T00:00:00.000Z"));
      expect(redispatched).toEqual({ sent: 0, failed: 0 });

      const listed = store.listScheduledForChat(chatId, alice.id, 10);
      expect(listed.items.map((item) => item.id)).toEqual([future.id]);

      store.createBlock(bob.id, alice.id, {
        id: alice.id,
        username: alice.username,
        displayName: alice.displayName,
        bio: "",
        avatarUrl: null
      }, BASE_TIME);
      const blocked = store.createScheduledMessage({
        id: randomUUID(),
        chatId,
        senderId: alice.id,
        body: "Заблокировано",
        replyToMessageId: null,
        topicId: null,
        clientNonce: randomUUID(),
        sendAt: "2026-01-01T00:00:00.000Z",
        createdAt: "2025-01-01T00:00:00.000Z"
      });
      const blockedOutcome = service.dispatchDueScheduledMessages(new Date("2026-06-01T00:00:00.000Z"));
      expect(blockedOutcome).toEqual({ sent: 0, failed: 1 });
      expect(store.findMessageByNonce(alice.id, blocked.clientNonce)).toBeNull();
      const failedList = store.listScheduledForChat(chatId, alice.id, 10);
      const failedRow = failedList.items.find((item) => item.id === blocked.id);
      expect(failedRow?.state).toBe("failed");
      expect(failedRow?.failureCode).toBe("relationship_unavailable");
    } finally {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  }, 30_000);
});
