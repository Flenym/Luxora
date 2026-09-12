import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Store } from "./domain/store.js";
import type { StoredEvent, UserRecord } from "./domain/types.js";
import { AppError } from "./errors.js";
import { SearchHasher } from "./infrastructure/search-hasher.js";
import { SqliteStore } from "./infrastructure/sqlite-store.js";
import { ChatService } from "./services/chat-service.js";
import type { EventPublisher } from "./services/event-publisher.js";

const NOW = "2026-08-03T12:00:00.000Z";
const EXPIRES_AT = "2026-09-02T12:00:00.000Z";

class CapturingPublisher implements EventPublisher {
  readonly events: StoredEvent[] = [];

  publish(events: StoredEvent[]): void {
    this.events.push(...events);
  }

  publishEphemeral(): void {}

  reset(): void {
    this.events.length = 0;
  }
}

function expectRelationshipUnavailable(operation: () => unknown): void {
  try {
    operation();
  } catch (error) {
    expect(error).toBeInstanceOf(AppError);
    expect(error).toMatchObject({
      statusCode: 403,
      code: "FORBIDDEN",
      details: { reason: "relationship_unavailable" }
    });
    return;
  }
  throw new Error("Expected relationship_unavailable");
}

describe("chat relationship and block boundary", () => {
  let store: Store;
  let publisher: CapturingPublisher;
  let service: ChatService;

  beforeEach(() => {
    store = new SqliteStore(":memory:");
    publisher = new CapturingPublisher();
    service = new ChatService(store, publisher, new SearchHasher({}, undefined));
  });

  afterEach(() => {
    store.close();
  });

  function createUser(username: string): UserRecord {
    return store.createUser({
      id: randomUUID(),
      username,
      usernameNormalized: username.toLowerCase(),
      displayName: username,
      passwordHash: "test-only-password-hash",
      createdAt: NOW
    });
  }

  function acceptRelationship(left: UserRecord, right: UserRecord): void {
    const [leftUserId, rightUserId] = [left.id, right.id].sort() as [string, string];
    const requestId = randomUUID();
    store.createMessageRequest({
      id: requestId,
      pairKey: `${leftUserId}:${rightUserId}`,
      senderId: left.id,
      recipientId: right.id,
      clientNonce: randomUUID(),
      body: "Hello",
      linkUrl: null,
      senderProfile: {
        id: left.id,
        username: left.username,
        displayName: left.displayName,
        bio: left.bio,
        avatarUrl: left.avatarUrl
      },
      recipientProfile: {
        id: right.id,
        username: right.username,
        displayName: right.displayName,
        bio: right.bio,
        avatarUrl: right.avatarUrl
      },
      createdAt: NOW,
      expiresAt: EXPIRES_AT
    });
    store.createAcceptedRelationship(
      `${leftUserId}:${rightUserId}`,
      leftUserId,
      rightUserId,
      requestId,
      NOW
    );
  }

  function block(blocker: UserRecord, blocked: UserRecord): void {
    store.createBlock(blocker.id, blocked.id, {
      id: blocked.id,
      username: blocked.username,
      displayName: blocked.displayName,
      bio: blocked.bio,
      avatarUrl: blocked.avatarUrl
    }, NOW);
  }

  function sendText(userId: string, chatId: string, body = "Hello") {
    return service.sendMessage(userId, chatId, {
      body,
      clientNonce: randomUUID(),
      replyToMessageId: null,
      topicId: null,
      attachmentIds: [],
      transcriptionConsent: false
    });
  }

  it("creates stranger direct chats by default while the nobody privacy gate blocks them", () => {
    const alice = createUser("alice");
    const bob = createUser("bob_user");

    // Default privacy ("everyone") mirrors Telegram: strangers open a direct
    // chat immediately instead of routing through message requests.
    const strangerChat = service.createChat(alice.id, { kind: "direct", userId: bob.id });
    expect(strangerChat.kind).toBe("direct");

    const selfChat = service.createChat(alice.id, { kind: "direct", userId: alice.id });
    expect(selfChat.kind).toBe("direct");

    // The recipient can still restrict stranger chats to accepted contacts.
    store.updatePrivacySettings(bob.id, { messageRequests: "nobody" }, NOW);
    const carol = createUser("carol_user");
    expectRelationshipUnavailable(() =>
      service.createChat(carol.id, { kind: "direct", userId: bob.id })
    );

    acceptRelationship(carol, bob);
    const accepted = service.createChat(carol.id, { kind: "direct", userId: bob.id });
    expect(accepted.kind).toBe("direct");
  });

  it("cuts off active direct-chat mutations after either-direction block but permits own deletion", () => {
    const alice = createUser("alice");
    const bob = createUser("bob_user");
    acceptRelationship(alice, bob);
    const direct = service.createChat(alice.id, { kind: "direct", userId: bob.id });
    const message = sendText(alice.id, direct.id);
    service.pinMessage(alice.id, direct.id, message.id);

    block(bob, alice);

    expectRelationshipUnavailable(() => sendText(alice.id, direct.id, "blocked"));
    expectRelationshipUnavailable(() =>
      service.editMessage(alice.id, message.id, { body: "blocked edit" })
    );
    expectRelationshipUnavailable(() => service.setReaction(alice.id, message.id, "👍", true));
    expectRelationshipUnavailable(() => service.pinMessage(alice.id, direct.id, message.id));
    expectRelationshipUnavailable(() => service.unpinMessage(alice.id, direct.id, message.id));
    expectRelationshipUnavailable(() => service.markRead(alice.id, direct.id, message.id));
    expectRelationshipUnavailable(() => service.markDelivered(alice.id, direct.id, message.id));
    expectRelationshipUnavailable(() =>
      service.forwardMessage(alice.id, message.id, {
        chatId: direct.id,
        clientNonce: randomUUID(),
        topicId: null
      })
    );

    expect(service.deleteMessage(alice.id, message.id).deletedAt).not.toBeNull();
  });

  it("rejects blocked group additions and hides receipt/reaction actors from blocked audiences", () => {
    const alice = createUser("alice");
    const bob = createUser("bob_user");
    const carol = createUser("carol_user");
    acceptRelationship(alice, bob);
    acceptRelationship(alice, carol);
    const group = service.createChat(alice.id, {
      kind: "group",
      title: "Safety test",
      memberIds: [bob.id, carol.id]
    });
    const message = sendText(carol.id, group.id, "Shared group content");

    block(alice, bob);
    expectRelationshipUnavailable(() =>
      service.createChat(alice.id, {
        kind: "group",
        title: "Blocked addition",
        memberIds: [bob.id]
      })
    );

    expect(() => sendText(alice.id, group.id, "Still shared")).not.toThrow();

    publisher.reset();
    const deliveredEvents = service.markDelivered(alice.id, group.id, message.id);
    expect(deliveredEvents.map(({ audienceUserId }) => audienceUserId).sort()).toEqual(
      [alice.id, carol.id].sort()
    );

    publisher.reset();
    const readEvents = service.markRead(alice.id, group.id, message.id);
    expect(readEvents.map(({ audienceUserId }) => audienceUserId).sort()).toEqual(
      [alice.id, carol.id].sort()
    );

    publisher.reset();
    service.setReaction(alice.id, message.id, "👍", true);
    expect(publisher.events.map(({ audienceUserId }) => audienceUserId).sort()).toEqual(
      [alice.id, carol.id].sort()
    );

    store.deleteBlock(alice.id, bob.id);
    block(bob, carol);
    expect(() =>
      service.createChat(alice.id, {
        kind: "channel",
        title: "No third-party block oracle",
        memberIds: [bob.id, carol.id]
      })
    ).not.toThrow();
  });
});
