import { describe, expect, it } from "vitest";
import type { Chat, Call, Message, MessengerState, UiMessage, User } from "../contract";
import {
  addOptimisticMessage,
  applyCallSnapshot,
  applyDurableEvent,
  applyPresence,
  applyReceiptEvent,
  applyTyping,
  compareMessages,
  confirmOptimisticMessage,
  createInitialState,
  failOptimisticMessage,
  findMessageByNonce,
  markOptimisticSending,
  mergeMessages,
  prependMessagePage,
  pruneTyping,
  setMessagePage,
  setMessageReceipts,
  sortChats
} from "./store";

const SELF: User = {
  id: "user-self",
  username: "self",
  displayName: "Self",
  bio: "",
  avatarUrl: null,
  createdAt: "2026-01-01T00:00:00.000Z"
};

const OTHER: User = {
  id: "user-other",
  username: "bob",
  displayName: "Bob",
  bio: "",
  avatarUrl: null,
  createdAt: "2026-01-01T00:00:00.000Z"
};

function makeMessage(overrides: Partial<Message> = {}): Message {
  return {
    id: "message-1",
    chatId: "chat-1",
    sender: OTHER,
    kind: "text",
    body: "hello",
    replyToMessageId: null,
    topicId: null,
    forwardedFrom: null,
    attachments: [],
    transcriptionAllowed: false,
    transcript: null,
    isPinned: false,
    clientNonce: "nonce-1",
    revision: 0,
    createdAt: "2026-01-01T00:00:01.000Z",
    updatedAt: "2026-01-01T00:00:01.000Z",
    editedAt: null,
    deletedAt: null,
    ...overrides
  };
}

function makeChat(overrides: Partial<Chat> = {}): Chat {
  return {
    id: "chat-1",
    kind: "direct",
    title: "Bob",
    avatarUrl: null,
    role: "member",
    memberCount: 2,
    lastMessage: null,
    lastActivityAt: "2026-01-01T00:00:00.000Z",
    createdAt: "2026-01-01T00:00:00.000Z",
    unreadCount: 0,
    archivedAt: null,
    mutedUntil: null,
    ...overrides
  };
}

function baseState(overrides: Partial<MessengerState> = {}): MessengerState {
  return {
    ...createInitialState("http://api.test"),
    phase: "ready",
    user: SELF,
    chats: [makeChat()],
    members: {
      "chat-1": [
        {
          membership: {
            chatId: "chat-1",
            userId: SELF.id,
            role: "member",
            revision: 1,
            joinedAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z"
          },
          user: SELF
        },
        {
          membership: {
            chatId: "chat-1",
            userId: OTHER.id,
            role: "member",
            revision: 1,
            joinedAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z"
          },
          user: OTHER
        }
      ]
    },
    pages: {
      "chat-1": { nextCursor: null, loaded: true, loading: false, error: null }
    },
    ...overrides
  };
}

function optimisticMessage(overrides: Partial<UiMessage> = {}): UiMessage {
  return {
    ...makeMessage({
      id: "client-nonce-1",
      clientNonce: "client-nonce-1",
      sender: SELF,
      body: "optimistic",
      createdAt: "2026-01-01T00:00:05.000Z",
      updatedAt: "2026-01-01T00:00:05.000Z"
    }),
    _pending: true,
    ...overrides
  };
}

describe("store — message merge ordering and idempotency", () => {
  it("orders canonically by server createdAt then id", () => {
    const older = makeMessage({ id: "b", createdAt: "2026-01-01T00:00:01.000Z" });
    const newer = makeMessage({ id: "a", createdAt: "2026-01-01T00:00:05.000Z" });
    const merged = mergeMessages([], [newer, older]);
    expect(merged.map((message) => message.id)).toEqual(["b", "a"]);
  });

  it("is idempotent for duplicated dispatch rows", () => {
    const message = makeMessage({ id: "a" });
    const once = mergeMessages([], [message]);
    const twice = mergeMessages(once, [message, message]);
    expect(twice).toHaveLength(1);
    expect(twice[0]?.id).toBe("a");
  });

  it("keeps the higher revision on updates and ignores stale revisions", () => {
    const current = mergeMessages([], [makeMessage({ revision: 2, body: "latest" })]);
    const stale = mergeMessages(current, [makeMessage({ revision: 1, body: "older" })]);
    expect(stale[0]?.body).toBe("latest");
    const fresh = mergeMessages(stale, [makeMessage({ revision: 3, body: "newest" })]);
    expect(fresh[0]?.body).toBe("newest");
  });

  it("compares equal timestamps by id deterministically", () => {
    const stamp = "2026-01-01T00:00:01.000Z";
    expect(compareMessages({ id: "a", createdAt: stamp }, { id: "b", createdAt: stamp })).toBeLessThan(0);
    expect(compareMessages({ id: "z", createdAt: stamp }, { id: "z", createdAt: stamp })).toBe(0);
  });
});

describe("store — optimistic outbox", () => {
  it("moves pending -> confirmed and clears the outbox", () => {
    const state = baseState();
    const optimistic = optimisticMessage();
    let next = addOptimisticMessage(state, optimistic);
    expect(next.messages["chat-1"]).toHaveLength(1);
    expect(next.messages["chat-1"]?.[0]?._pending).toBe(true);
    expect(next.outbox["client-nonce-1"]).toBe("sending");
    expect(next.chats[0]?.lastMessage?.body).toBe("optimistic");

    const canonical = makeMessage({
      id: "server-1",
      clientNonce: "client-nonce-1",
      sender: SELF,
      body: "optimistic",
      createdAt: "2026-01-01T00:00:05.010Z"
    });
    next = confirmOptimisticMessage(next, canonical, SELF.id);
    expect(next.messages["chat-1"]).toHaveLength(1);
    expect(next.messages["chat-1"]?.[0]?.id).toBe("server-1");
    expect(next.messages["chat-1"]?.[0]?._pending).toBeUndefined();
    expect(next.outbox["client-nonce-1"]).toBeUndefined();
  });

  it("marks a failed send and retries the same clientNonce", () => {
    let next = addOptimisticMessage(baseState(), optimisticMessage());
    next = failOptimisticMessage(next, "chat-1", "client-nonce-1");
    const failed = findMessageByNonce(next, "chat-1", "client-nonce-1");
    expect(failed?._failed).toBe(true);
    expect(failed?._pending).toBe(false);
    expect(next.outbox["client-nonce-1"]).toBe("failed");

    next = markOptimisticSending(next, "chat-1", "client-nonce-1");
    const retried = findMessageByNonce(next, "chat-1", "client-nonce-1");
    expect(retried?._pending).toBe(true);
    expect(retried?._failed).toBe(false);
    expect(next.outbox["client-nonce-1"]).toBe("sending");
  });

  it("dedupes the realtime echo that arrives before the HTTP ack", () => {
    let next = addOptimisticMessage(baseState(), optimisticMessage());
    const echo = makeMessage({
      id: "server-1",
      clientNonce: "client-nonce-1",
      sender: SELF,
      body: "optimistic",
      createdAt: "2026-01-01T00:00:05.050Z"
    });
    next = applyDurableEvent(next, { type: "message.created", message: echo }, SELF.id);
    expect(next.messages["chat-1"]).toHaveLength(1);
    expect(next.messages["chat-1"]?.[0]?.id).toBe("server-1");
    next = confirmOptimisticMessage(next, echo, SELF.id);
    expect(next.messages["chat-1"]).toHaveLength(1);
    expect(next.outbox["client-nonce-1"]).toBeUndefined();
  });

  it("preserves pending rows when a fresh first page replaces loaded rows", () => {
    const state = baseState();
    const withOptimistic = addOptimisticMessage(state, optimisticMessage());
    const pageNewestFirst = [
      makeMessage({ id: "server-2", createdAt: "2026-01-01T00:00:04.000Z" }),
      makeMessage({ id: "server-1", createdAt: "2026-01-01T00:00:03.000Z" })
    ];
    const next = setMessagePage(withOptimistic, "chat-1", pageNewestFirst, "cursor-older");
    const rows = next.messages["chat-1"] ?? [];
    expect(rows.map((row) => row.id)).toEqual(["server-1", "server-2", "client-nonce-1"]);
    expect(next.pages["chat-1"]).toEqual({
      nextCursor: "cursor-older",
      loaded: true,
      loading: false,
      error: null
    });
  });
});

describe("store — unread counts and receipts", () => {
  it("increments unread only for messages from others outside the open chat", () => {
    const state = baseState();
    const incoming = makeMessage({ id: "m1", createdAt: "2026-01-01T00:00:02.000Z" });
    let next = applyDurableEvent(state, { type: "message.created", message: incoming }, SELF.id);
    expect(next.chats[0]?.unreadCount).toBe(1);
    expect(next.chats[0]?.lastMessage?.id).toBe("m1");

    next = applyDurableEvent({ ...next, activeChatId: "chat-1" }, {
      type: "message.created",
      message: makeMessage({ id: "m2", clientNonce: "nonce-2", createdAt: "2026-01-01T00:00:03.000Z" })
    }, SELF.id);
    expect(next.chats[0]?.unreadCount).toBe(0);

    const own = makeMessage({ id: "m3", clientNonce: "nonce-3", sender: SELF, createdAt: "2026-01-01T00:00:04.000Z" });
    next = applyDurableEvent(next, { type: "message.created", message: own }, SELF.id);
    expect(next.chats[0]?.unreadCount).toBe(0);
  });

  it("applies a deletion tombstone without raising unread", () => {
    const state = baseState();
    const deleted = makeMessage({
      id: "m1",
      body: null,
      deletedAt: "2026-01-01T00:00:02.000Z",
      revision: 1,
      createdAt: "2026-01-01T00:00:01.000Z"
    });
    const next = applyDurableEvent(state, { type: "message.deleted", message: deleted }, SELF.id);
    expect(next.chats[0]?.unreadCount).toBe(0);
    expect(next.chats[0]?.lastMessage?.body).toBeNull();
    expect(next.chats[0]?.lastMessage?.deletedAt).toBe("2026-01-01T00:00:02.000Z");
    expect(next.messages["chat-1"]?.[0]?.deletedAt).not.toBeNull();
  });

  it("never upgrades receipts to complete from realtime events", () => {
    let next = applyReceiptEvent(baseState(), "message-1", OTHER.id, "delivered", "2026-01-01T00:00:02.000Z");
    expect(next.receipts["message-1"]).toEqual({
      items: [{ userId: OTHER.id, deliveredAt: "2026-01-01T00:00:02.000Z", readAt: null }],
      complete: false
    });
    next = applyReceiptEvent(next, "message-1", OTHER.id, "read", "2026-01-01T00:00:03.000Z");
    expect(next.receipts["message-1"]?.items).toHaveLength(1);
    expect(next.receipts["message-1"]?.items[0]?.readAt).toBe("2026-01-01T00:00:03.000Z");
    expect(next.receipts["message-1"]?.complete).toBe(false);

    const authoritative = setMessageReceipts(next, "message-1", [
      { userId: OTHER.id, deliveredAt: "2026-01-01T00:00:02.000Z", readAt: "2026-01-01T00:00:03.000Z" }
    ]);
    expect(authoritative.receipts["message-1"]?.complete).toBe(true);
  });

  it("updates reactions from the durable event", () => {
    const next = applyDurableEvent(baseState(), {
      type: "reaction.updated",
      chatId: "chat-1",
      messageId: "message-1",
      reactions: [{ emoji: "💜", count: 1, reactedByMe: true }],
      actorUserId: SELF.id
    }, SELF.id);
    expect(next.reactions["message-1"]).toEqual([{ emoji: "💜", count: 1, reactedByMe: true }]);
  });
});

describe("store — typing, presence and pagination", () => {
  it("tracks typing with expiry and prunes expired entries", () => {
    const now = 1_000_000;
    let next = applyTyping(baseState(), "chat-1", OTHER.id, true, now + 5_000);
    expect(next.typing["chat-1"]).toEqual([{ userId: OTHER.id, displayName: "Bob", expiresAt: now + 5_000 }]);
    expect(pruneTyping(next, now)).toBe(next);
    next = pruneTyping(next, now + 5_001);
    expect(next.typing["chat-1"]).toBeUndefined();
    next = applyTyping(next, "chat-1", OTHER.id, false, now);
    expect(next.typing["chat-1"]).toBeUndefined();
  });

  it("tracks presence idempotently", () => {
    const state = baseState();
    const online = applyPresence(state, OTHER.id, "online");
    expect(online.presence[OTHER.id]).toBe("online");
    expect(applyPresence(online, OTHER.id, "online")).toBe(online);
  });

  it("prepends older pages in canonical order", () => {
    const state = baseState({
      messages: {
        "chat-1": [makeMessage({ id: "m3", createdAt: "2026-01-01T00:00:03.000Z" })]
      }
    });
    const olderNewestFirst = [
      makeMessage({ id: "m2", createdAt: "2026-01-01T00:00:02.000Z" }),
      makeMessage({ id: "m1", createdAt: "2026-01-01T00:00:01.000Z" })
    ];
    const next = prependMessagePage(state, "chat-1", olderNewestFirst, null);
    expect(next.messages["chat-1"]?.map((message) => message.id)).toEqual(["m1", "m2", "m3"]);
    expect(next.pages["chat-1"]?.nextCursor).toBeNull();
  });

  it("sorts the chat list by last activity descending", () => {
    const chats = [
      makeChat({ id: "a", lastActivityAt: "2026-01-01T00:00:01.000Z" }),
      makeChat({ id: "b", lastActivityAt: "2026-01-01T00:00:09.000Z" }),
      makeChat({ id: "c", lastActivityAt: "2026-01-01T00:00:05.000Z" })
    ];
    expect(sortChats(chats).map((chat) => chat.id)).toEqual(["b", "c", "a"]);
  });
});

describe("store — membership and calls", () => {
  it("removes a chat when this account was removed from it", () => {
    const state = baseState({
      activeChatId: "chat-1",
      activeChat: makeChat(),
      messages: { "chat-1": [makeMessage()] }
    });
    const next = applyDurableEvent(state, {
      type: "chat.member.changed",
      audience: "removed_account",
      change: "removed",
      membership: {
        chatId: "chat-1",
        userId: SELF.id,
        role: "member",
        revision: 2,
        joinedAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:10.000Z"
      },
      actorUserId: "user-admin",
      changedAt: "2026-01-01T00:00:10.000Z"
    }, SELF.id);
    expect(next.chats).toHaveLength(0);
    expect(next.activeChatId).toBeNull();
    expect(next.activeChat).toBeNull();
    expect(next.messages["chat-1"]).toBeUndefined();
  });

  it("patches an active call snapshot and clears it on end", () => {
    const call: Call = {
      callId: "call-1",
      chatId: "chat-1",
      kind: "one_to_one",
      mediaMode: "audio",
      state: "ringing",
      revision: 2,
      epoch: 1,
      creatorMemberId: SELF.id,
      participants: [],
      createdAtMs: 1,
      updatedAtMs: 2,
      pendingEndReason: null,
      endReason: null,
      endedAtMs: null
    };
    const state = baseState({
      call: { active: call, incoming: null, media: "unavailable", mediaError: null, muted: false }
    });
    const updated = applyDurableEvent(state, {
      type: "call.state.changed",
      callId: "call-1",
      chatId: "chat-1",
      state: "connecting",
      revision: 3,
      occurredAt: "2026-01-01T00:00:05.000Z"
    }, SELF.id);
    expect(updated.call.active?.state).toBe("connecting");
    expect(updated.call.active?.revision).toBe(3);

    const ended = applyCallSnapshot(updated, { ...call, state: "ended", revision: 4, endedAtMs: 9 });
    expect(ended.call.active).toBeNull();
  });

  it("ignores sync.invalidated at the pure store layer (messenger reloads)", () => {
    const state = baseState();
    const next = applyDurableEvent(state, {
      type: "sync.invalidated",
      audience: "account_projection",
      accountId: SELF.id,
      reason: "profile_updated",
      changedAt: "2026-01-01T00:00:10.000Z"
    }, SELF.id);
    expect(next).toBe(state);
  });
});
