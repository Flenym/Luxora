import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import {
  CHAT_DRAFT_IDEMPOTENCY_TTL_SECONDS,
  MAX_DRAFT_LENGTH,
  MAX_CHAT_DRAFT_ACTIVE_COMMAND_RECEIPTS
} from "@luxora/protocol";
import type { LuxoraApp } from "./app.js";
import { buildApp } from "./app.js";
import { establishAcceptedRelationship, testConfig } from "./test-helpers.js";

interface Identity {
  id: string;
  accessToken: string;
}

describe("account-scoped synchronized chat drafts", () => {
  let app: LuxoraApp | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  async function fixture(): Promise<void> {
    app = await buildApp({
      config: testConfig({
        dataEncryptionKeys: { draft_test: Buffer.alloc(32, 91).toString("base64url") },
        activeDataEncryptionKeyId: "draft_test"
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

  async function sendMessage(identity: Identity, chatId: string, body: string): Promise<string> {
    const response = await app!.inject({
      method: "POST",
      url: `/v1/chats/${chatId}/messages`,
      headers: headers(identity),
      payload: { body, clientNonce: randomUUID() }
    });
    expect(response.statusCode, response.body).toBe(201);
    return response.json().message.id as string;
  }

  it("rejects ill-formed UTF-16 without side effects and accepts a full emoji boundary", async () => {
    await fixture();
    const alice = await register("draft_unicode_alice");
    const chatId = await createSavedChat(alice);
    const boundary = app!.luxora.store.getLatestSequence();

    for (const malformedEscape of ["\\ud800", "\\udc00"]) {
      const clientNonce = randomUUID();
      const rejected = await app!.inject({
        method: "PUT",
        url: `/v1/chats/${chatId}/draft`,
        headers: { ...headers(alice), "content-type": "application/json" },
        payload: `{"text":"${malformedEscape}","expectedRevision":0,"clientNonce":"${clientNonce}"}`
      });
      expect(rejected.statusCode, rejected.body).toBe(400);
      expect(app!.luxora.store.findChatDraftCommandReceipt(
        alice.id,
        clientNonce,
        new Date().toISOString()
      )).toBeNull();
    }
    expect(app!.luxora.store.getChatDraft(alice.id, chatId)).toBeNull();
    expect(app!.luxora.store.getLatestSequence()).toBe(boundary);

    const validText = "💎".repeat(MAX_DRAFT_LENGTH);
    const accepted = await app!.inject({
      method: "PUT",
      url: `/v1/chats/${chatId}/draft`,
      headers: headers(alice),
      payload: {
        text: validText,
        expectedRevision: 0,
        clientNonce: randomUUID()
      }
    });
    expect(accepted.statusCode, accepted.body).toBe(200);
    expect(accepted.json()).toMatchObject({
      draft: { text: validText, revision: 1 },
      revision: 1,
      replayed: false
    });
    expect(app!.luxora.store.getLatestSequence()).toBe(boundary + 1);
  });

  it("uses monotonic CAS across put, no-op, delete, retry and recreation", async () => {
    await fixture();
    const alice = await register("draft_cas_alice");
    const bob = await register("draft_cas_bob");
    const chatId = await establishAcceptedRelationship(app!, alice, bob);
    const replyToMessageId = await sendMessage(alice, chatId, "reply target");

    const empty = await app!.inject({
      method: "GET",
      url: `/v1/chats/${chatId}/draft`,
      headers: headers(alice)
    });
    expect(empty.statusCode, empty.body).toBe(200);
    expect(empty.json()).toEqual({ draft: null, revision: 0 });

    const putNonce = randomUUID();
    const beforePut = app!.luxora.store.getLatestSequence();
    const created = await app!.inject({
      method: "PUT",
      url: `/v1/chats/${chatId}/draft`,
      headers: headers(alice),
      payload: {
        text: "Черновик 💎",
        replyToMessageId,
        expectedRevision: 0,
        clientNonce: putNonce
      }
    });
    expect(created.statusCode, created.body).toBe(200);
    expect(created.json()).toMatchObject({
      draft: {
        chatId,
        text: "Черновик 💎",
        replyToMessageId,
        revision: 1
      },
      revision: 1,
      replayed: false
    });
    const afterPut = app!.luxora.store.getLatestSequence();
    expect(afterPut).toBe(beforePut + 1);
    expect(app!.luxora.store.replayEvents(alice.id, beforePut, afterPut, 10)).toHaveLength(1);
    expect(app!.luxora.store.replayEvents(alice.id, beforePut, afterPut, 10)[0]?.event)
      .toMatchObject({
        type: "chat.draft.changed",
        audience: "account_sessions",
        accountId: alice.id,
        chatId,
        draft: { text: "Черновик 💎", revision: 1 },
        revision: 1
      });
    expect(app!.luxora.store.replayEvents(bob.id, beforePut, afterPut, 10)).toEqual([]);

    const exactReplay = await app!.inject({
      method: "PUT",
      url: `/v1/chats/${chatId}/draft`,
      headers: headers(alice),
      payload: {
        text: "Черновик 💎",
        replyToMessageId,
        expectedRevision: 0,
        clientNonce: putNonce
      }
    });
    expect(exactReplay.statusCode, exactReplay.body).toBe(200);
    expect(exactReplay.json()).toEqual({ ...created.json(), replayed: true });
    expect(app!.luxora.store.getLatestSequence()).toBe(afterPut);

    const nonceConflict = await app!.inject({
      method: "PUT",
      url: `/v1/chats/${chatId}/draft`,
      headers: headers(alice),
      payload: {
        text: "different command",
        expectedRevision: 1,
        clientNonce: putNonce
      }
    });
    expect(nonceConflict.statusCode).toBe(409);

    const stale = await app!.inject({
      method: "PUT",
      url: `/v1/chats/${chatId}/draft`,
      headers: headers(alice),
      payload: {
        text: "stale",
        expectedRevision: 0,
        clientNonce: randomUUID()
      }
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error.details).toEqual({ currentRevision: 1 });

    const noOp = await app!.inject({
      method: "PUT",
      url: `/v1/chats/${chatId}/draft`,
      headers: headers(alice),
      payload: {
        text: "Черновик 💎",
        replyToMessageId,
        expectedRevision: 1,
        clientNonce: randomUUID()
      }
    });
    expect(noOp.statusCode, noOp.body).toBe(200);
    expect(noOp.json()).toMatchObject({ revision: 1, replayed: false });
    expect(app!.luxora.store.getLatestSequence()).toBe(afterPut);

    const changed = await app!.inject({
      method: "PUT",
      url: `/v1/chats/${chatId}/draft`,
      headers: headers(alice),
      payload: {
        text: "Обновлённый черновик",
        expectedRevision: 1,
        clientNonce: randomUUID()
      }
    });
    expect(changed.statusCode, changed.body).toBe(200);
    expect(changed.json()).toMatchObject({
      draft: { text: "Обновлённый черновик", replyToMessageId: null, revision: 2 },
      revision: 2,
      replayed: false
    });

    const deleteNonce = randomUUID();
    const deleted = await app!.inject({
      method: "DELETE",
      url: `/v1/chats/${chatId}/draft`,
      headers: headers(alice),
      payload: { expectedRevision: 2, clientNonce: deleteNonce }
    });
    expect(deleted.statusCode, deleted.body).toBe(200);
    expect(deleted.json()).toEqual({ draft: null, revision: 3, replayed: false });

    const deleteReplay = await app!.inject({
      method: "DELETE",
      url: `/v1/chats/${chatId}/draft`,
      headers: headers(alice),
      payload: { expectedRevision: 2, clientNonce: deleteNonce }
    });
    expect(deleteReplay.statusCode, deleteReplay.body).toBe(200);
    expect(deleteReplay.json()).toEqual({ draft: null, revision: 3, replayed: true });

    const afterDelete = await app!.inject({
      method: "GET",
      url: `/v1/chats/${chatId}/draft`,
      headers: headers(alice)
    });
    expect(afterDelete.json()).toEqual({ draft: null, revision: 3 });

    const recreated = await app!.inject({
      method: "PUT",
      url: `/v1/chats/${chatId}/draft`,
      headers: headers(alice),
      payload: {
        text: "После удаления",
        expectedRevision: 3,
        clientNonce: randomUUID()
      }
    });
    expect(recreated.statusCode, recreated.body).toBe(200);
    expect(recreated.json()).toMatchObject({ draft: { revision: 4 }, revision: 4 });

    const peerState = await app!.inject({
      method: "GET",
      url: `/v1/chats/${chatId}/draft`,
      headers: headers(bob)
    });
    expect(peerState.statusCode, peerState.body).toBe(200);
    expect(peerState.json()).toEqual({ draft: null, revision: 0 });
  });

  it("validates reply targets without revealing messages from another chat", async () => {
    await fixture();
    const alice = await register("draft_reply_alice");
    const firstChatId = await createSavedChat(alice);
    const secondChat = await app!.inject({
      method: "POST",
      url: "/v1/chats",
      headers: headers(alice),
      payload: { kind: "group", title: "Other draft target", memberIds: [] }
    });
    expect(secondChat.statusCode, secondChat.body).toBe(201);
    const secondChatId = secondChat.json().chat.id as string;
    const foreignMessageId = await sendMessage(alice, secondChatId, "other chat");
    const deletedMessageId = await sendMessage(alice, firstChatId, "deleted target");
    app!.luxora.store.deleteMessage(
      deletedMessageId,
      new Date(Date.now() + 1_000).toISOString()
    );

    const targets = [foreignMessageId, deletedMessageId, randomUUID()];
    for (const replyToMessageId of targets) {
      const response = await app!.inject({
        method: "PUT",
        url: `/v1/chats/${firstChatId}/draft`,
        headers: headers(alice),
        payload: {
          text: "reply",
          replyToMessageId,
          expectedRevision: 0,
          clientNonce: randomUUID()
        }
      });
      expect(response.statusCode, response.body).toBe(400);
      expect(response.json().error).toMatchObject({
        code: "BAD_REQUEST",
        message: "Reply target is unavailable"
      });
    }
  });

  it("serializes simultaneous retries and rejects a competing stale writer", async () => {
    await fixture();
    const alice = await register("draft_race_alice");
    const exactRetryChatId = await createSavedChat(alice);
    const nonce = randomUUID();
    const boundary = app!.luxora.store.getLatestSequence();
    const exactPayload = {
      text: "same retry payload",
      expectedRevision: 0,
      clientNonce: nonce
    };
    const exact = await Promise.all([0, 1].map(() => app!.inject({
      method: "PUT",
      url: `/v1/chats/${exactRetryChatId}/draft`,
      headers: headers(alice),
      payload: exactPayload
    })));
    expect(exact.map((response) => response.statusCode)).toEqual([200, 200]);
    expect(exact.map((response) => response.json().replayed).sort()).toEqual([false, true]);
    expect(new Set(exact.map((response) => response.json().revision))).toEqual(new Set([1]));
    expect(app!.luxora.store.replayEvents(
      alice.id,
      boundary,
      app!.luxora.store.getLatestSequence(),
      10
    ).filter((event) => event.event.type === "chat.draft.changed")).toHaveLength(1);

    const competingChat = await app!.inject({
      method: "POST",
      url: "/v1/chats",
      headers: headers(alice),
      payload: { kind: "group", title: "Draft CAS race", memberIds: [] }
    });
    expect(competingChat.statusCode, competingChat.body).toBe(201);
    const competingChatId = competingChat.json().chat.id as string;
    const competing = await Promise.all(["writer A", "writer B"].map((text) => app!.inject({
      method: "PUT",
      url: `/v1/chats/${competingChatId}/draft`,
      headers: headers(alice),
      payload: { text, expectedRevision: 0, clientNonce: randomUUID() }
    })));
    expect(competing.map((response) => response.statusCode).sort()).toEqual([200, 409]);
    const state = await app!.inject({
      method: "GET",
      url: `/v1/chats/${competingChatId}/draft`,
      headers: headers(alice)
    });
    expect(state.statusCode, state.body).toBe(200);
    expect(state.json().revision).toBe(1);
    expect(["writer A", "writer B"]).toContain(state.json().draft.text);
  });

  it("uses the same not-found response for unknown and inaccessible chats", async () => {
    await fixture();
    const alice = await register("draft_oracle_alice");
    const outsider = await register("draft_oracle_outsider");
    const privateChatId = await createSavedChat(alice);

    const unauthenticated = await app!.inject({
      method: "GET",
      url: `/v1/chats/${privateChatId}/draft`
    });
    expect(unauthenticated.statusCode).toBe(401);

    const inaccessible = await app!.inject({
      method: "GET",
      url: `/v1/chats/${privateChatId}/draft`,
      headers: headers(outsider)
    });
    const unknown = await app!.inject({
      method: "GET",
      url: `/v1/chats/${randomUUID()}/draft`,
      headers: headers(outsider)
    });
    expect(inaccessible.statusCode).toBe(404);
    expect(unknown.statusCode).toBe(404);
    expect({
      code: inaccessible.json().error.code,
      message: inaccessible.json().error.message
    }).toEqual({
      code: unknown.json().error.code,
      message: unknown.json().error.message
    });
    expect(inaccessible.json().error.message).toBe("Chat not found");

    for (const method of ["PUT", "DELETE"] as const) {
      const payload = method === "PUT"
        ? { text: "private", expectedRevision: 0, clientNonce: randomUUID() }
        : { expectedRevision: 1, clientNonce: randomUUID() };
      const response = await app!.inject({
        method,
        url: `/v1/chats/${privateChatId}/draft`,
        headers: headers(outsider),
        payload
      });
      expect(response.statusCode, response.body).toBe(404);
      expect(response.json().error.message).toBe("Chat not found");
    }
  });

  it("bounds active retry receipts while admitting exact replay before capacity", async () => {
    await fixture();
    const alice = await register("draft_receipt_capacity");
    const chatId = await createSavedChat(alice);
    const replayNonce = randomUUID();
    const payload = {
      text: "capacity-bound-draft",
      expectedRevision: 0,
      clientNonce: replayNonce
    };
    const created = await app!.inject({
      method: "PUT",
      url: `/v1/chats/${chatId}/draft`,
      headers: headers(alice),
      payload
    });
    expect(created.statusCode, created.body).toBe(200);

    const createdAt = new Date().toISOString();
    const expiresAt = new Date(
      Date.parse(createdAt) + CHAT_DRAFT_IDEMPOTENCY_TTL_SECONDS * 1_000
    ).toISOString();
    for (let index = 1; index < MAX_CHAT_DRAFT_ACTIVE_COMMAND_RECEIPTS; index += 1) {
      app!.luxora.store.createChatDraftCommandReceipt({
        userId: alice.id,
        clientNonce: randomUUID(),
        operation: "put",
        chatId,
        fingerprint: index.toString(16).padStart(64, "0"),
        responseJson: JSON.stringify({ draft: null, revision: 0, replayed: false }),
        createdAt,
        expiresAt
      });
    }
    expect(app!.luxora.store.countActiveChatDraftCommandReceipts(alice.id, createdAt))
      .toBe(MAX_CHAT_DRAFT_ACTIVE_COMMAND_RECEIPTS);

    const replay = await app!.inject({
      method: "PUT",
      url: `/v1/chats/${chatId}/draft`,
      headers: headers(alice),
      payload
    });
    expect(replay.statusCode, replay.body).toBe(200);
    expect(replay.json()).toEqual({ ...created.json(), replayed: true });

    const overCapacity = await app!.inject({
      method: "PUT",
      url: `/v1/chats/${chatId}/draft`,
      headers: headers(alice),
      payload: {
        text: "new command above bounded window",
        expectedRevision: 1,
        clientNonce: randomUUID()
      }
    });
    expect(overCapacity.statusCode, overCapacity.body).toBe(429);
    expect(Number(overCapacity.headers["retry-after"]))
      .toBe(overCapacity.json().error.details.retryAfterSeconds);
    expect(overCapacity.json().error.details).toMatchObject({
      idempotencyTtlSeconds: CHAT_DRAFT_IDEMPOTENCY_TTL_SECONDS,
      maxActiveReceipts: MAX_CHAT_DRAFT_ACTIVE_COMMAND_RECEIPTS
    });
    expect(overCapacity.json().error.details.retryAfterSeconds).toBeGreaterThan(0);
  });

  it("treats an expired nonce as a new CAS command after purging its receipt", async () => {
    await fixture();
    const alice = await register("draft_receipt_expired");
    const chatId = await createSavedChat(alice);
    const clientNonce = randomUUID();
    const expiresAt = new Date(Date.now() - 1_000).toISOString();
    const createdAt = new Date(Date.parse(expiresAt) - 1_000).toISOString();
    app!.luxora.store.createChatDraftCommandReceipt({
      userId: alice.id,
      clientNonce,
      operation: "put",
      chatId,
      fingerprint: "f".repeat(64),
      responseJson: JSON.stringify({ draft: null, revision: 0, replayed: false }),
      createdAt,
      expiresAt
    });

    const response = await app!.inject({
      method: "PUT",
      url: `/v1/chats/${chatId}/draft`,
      headers: headers(alice),
      payload: {
        text: "fresh command after receipt expiry",
        expectedRevision: 0,
        clientNonce
      }
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toMatchObject({
      draft: { text: "fresh command after receipt expiry", revision: 1 },
      revision: 1,
      replayed: false
    });
  });

  it("tombstones a removed member's draft without exposing its text to the actor", async () => {
    await fixture();
    const owner = await register("draft_remove_owner");
    const member = await register("draft_remove_member");
    await establishAcceptedRelationship(app!, owner, member);
    const group = await app!.inject({
      method: "POST",
      url: "/v1/chats",
      headers: headers(owner),
      payload: { kind: "group", title: "Draft removal", memberIds: [member.id] }
    });
    expect(group.statusCode, group.body).toBe(201);
    const chatId = group.json().chat.id as string;

    const draftNonce = randomUUID();
    const created = await app!.inject({
      method: "PUT",
      url: `/v1/chats/${chatId}/draft`,
      headers: headers(member),
      payload: {
        text: "member-private-draft-canary",
        expectedRevision: 0,
        clientNonce: draftNonce
      }
    });
    expect(created.statusCode, created.body).toBe(200);
    const membership = app!.luxora.store.getChatMember(chatId, member.id);
    expect(membership).not.toBeNull();
    const boundary = app!.luxora.store.getLatestSequence();

    const removed = await app!.inject({
      method: "DELETE",
      url: `/v1/chats/${chatId}/members/${member.id}`,
      headers: headers(owner),
      payload: { expectedRevision: membership!.revision, clientNonce: randomUUID() }
    });
    expect(removed.statusCode, removed.body).toBe(200);
    const tombstone = app!.luxora.store.getChatDraft(member.id, chatId);
    expect(tombstone).toMatchObject({
      userId: member.id,
      chatId,
      text: null,
      replyToMessageId: null,
      revision: 2
    });
    expect(tombstone?.deletedAt).not.toBeNull();
    const events = app!.luxora.store.replayEvents(
      member.id,
      boundary,
      app!.luxora.store.getLatestSequence(),
      20
    );
    const draftEvent = events.find((event) => event.event.type === "chat.draft.changed");
    expect(draftEvent?.event).toMatchObject({
      type: "chat.draft.changed",
      accountId: member.id,
      chatId,
      draft: null,
      revision: 2
    });
    expect(JSON.stringify(events)).not.toContain("member-private-draft-canary");
    expect(app!.luxora.store.findChatDraftCommandReceipt(
      member.id,
      draftNonce,
      new Date().toISOString()
    )).toBeNull();

    const inaccessible = await app!.inject({
      method: "GET",
      url: `/v1/chats/${chatId}/draft`,
      headers: headers(member)
    });
    expect(inaccessible.statusCode).toBe(404);

    const readded = await app!.inject({
      method: "POST",
      url: `/v1/chats/${chatId}/members`,
      headers: headers(owner),
      payload: { userId: member.id, role: "member", clientNonce: randomUUID() }
    });
    expect(readded.statusCode, readded.body).toBe(201);

    const oldNonceAfterReadd = await app!.inject({
      method: "PUT",
      url: `/v1/chats/${chatId}/draft`,
      headers: headers(member),
      payload: {
        text: "member-private-draft-canary",
        expectedRevision: 0,
        clientNonce: draftNonce
      }
    });
    expect(oldNonceAfterReadd.statusCode, oldNonceAfterReadd.body).toBe(409);
    expect(oldNonceAfterReadd.json()).toMatchObject({
      error: { code: "CONFLICT", details: { currentRevision: 2 } }
    });
    expect(oldNonceAfterReadd.body).not.toContain("member-private-draft-canary");
  });
});
