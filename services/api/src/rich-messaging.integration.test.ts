import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { LuxoraApp } from "./app.js";
import { buildApp } from "./app.js";
import { establishAcceptedRelationship, testConfig } from "./test-helpers.js";

interface Identity {
  id: string;
  accessToken: string;
}

describe("rich messaging resources", () => {
  let app: LuxoraApp | undefined;
  const temporaryRoots: string[] = [];

  afterEach(async () => {
    await app?.close();
    app = undefined;
    await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  async function register(username: string): Promise<Identity> {
    const response = await app!.inject({
      method: "POST",
      url: "/v1/auth/register",
      payload: { username, displayName: username, password: "correct horse battery staple" }
    });
    const body = response.json();
    return { id: body.user.id as string, accessToken: body.tokens.accessToken as string };
  }

  it("keeps edit history, reindexes search, controls pins, and enforces topic lifecycle", async () => {
    const key = Buffer.alloc(32, 53).toString("base64url");
    app = await buildApp({
      config: testConfig({ dataEncryptionKeys: { active: key }, activeDataEncryptionKeyId: "active" }),
      logger: false
    });
    const alice = await register("rich_alice");
    const bob = await register("rich_bob");
    const eve = await register("rich_eve");
    const auth = (identity: Identity) => ({ authorization: `Bearer ${identity.accessToken}` });

    await establishAcceptedRelationship(app, alice, bob);

    const group = await app.inject({
      method: "POST",
      url: "/v1/chats",
      headers: auth(alice),
      payload: { kind: "group", title: "Engineering", memberIds: [bob.id] }
    });
    expect(group.statusCode).toBe(201);
    const chatId = group.json().chat.id as string;

    const topicResponse = await app.inject({
      method: "POST",
      url: `/v1/chats/${chatId}/topics`,
      headers: auth(bob),
      payload: { title: "Launch" }
    });
    expect(topicResponse.statusCode).toBe(201);
    const topicId = topicResponse.json().topic.id as string;

    const topicMessage = await app.inject({
      method: "POST",
      url: `/v1/chats/${chatId}/messages`,
      headers: auth(alice),
      payload: { body: "topic scoped", topicId, clientNonce: randomUUID() }
    });
    expect(topicMessage.statusCode).toBe(201);
    const filtered = await app.inject({
      method: "GET",
      url: `/v1/chats/${chatId}/messages?topicId=${topicId}`,
      headers: auth(bob)
    });
    expect(filtered.statusCode).toBe(200);
    expect(filtered.json().items).toHaveLength(1);
    expect(filtered.json().items[0].topicId).toBe(topicId);

    const memberCannotClose = await app.inject({
      method: "PATCH",
      url: `/v1/topics/${topicId}`,
      headers: auth(bob),
      payload: { closed: true }
    });
    expect(memberCannotClose.statusCode).toBe(403);
    const closeTopic = await app.inject({
      method: "PATCH",
      url: `/v1/topics/${topicId}`,
      headers: auth(alice),
      payload: { closed: true }
    });
    expect(closeTopic.statusCode).toBe(200);
    expect(closeTopic.json().topic.closedAt).not.toBeNull();
    const closedSend = await app.inject({
      method: "POST",
      url: `/v1/chats/${chatId}/messages`,
      headers: auth(alice),
      payload: { body: "too late", topicId, clientNonce: randomUUID() }
    });
    expect(closedSend.statusCode).toBe(409);

    const sent = await app.inject({
      method: "POST",
      url: `/v1/chats/${chatId}/messages`,
      headers: auth(alice),
      payload: { body: "original searchable phrase", clientNonce: randomUUID() }
    });
    const messageId = sent.json().message.id as string;
    const edited = await app.inject({
      method: "PATCH",
      url: `/v1/messages/${messageId}`,
      headers: auth(alice),
      payload: { body: "updated searchable phrase", expectedRevision: 0 }
    });
    expect(edited.statusCode).toBe(200);

    const history = await app.inject({
      method: "GET",
      url: `/v1/messages/${messageId}/history`,
      headers: auth(bob)
    });
    expect(history.statusCode).toBe(200);
    expect(history.json().items).toHaveLength(1);
    expect(history.json().items[0]).toMatchObject({ revision: 0, body: "original searchable phrase" });

    const oldSearch = await app.inject({
      method: "GET",
      url: "/v1/search/messages?q=original",
      headers: auth(alice)
    });
    expect(oldSearch.json().items).toHaveLength(0);
    const newSearch = await app.inject({
      method: "GET",
      url: `/v1/search/messages?q=updated&chatId=${chatId}`,
      headers: auth(alice)
    });
    expect(newSearch.statusCode).toBe(200);
    expect(newSearch.json().items.map((item: { id: string }) => item.id)).toContain(messageId);
    const outsiderSearch = await app.inject({
      method: "GET",
      url: "/v1/search/messages?q=updated",
      headers: auth(eve)
    });
    expect(outsiderSearch.json().items).toHaveLength(0);

    const memberPin = await app.inject({
      method: "PUT",
      url: `/v1/chats/${chatId}/pins/${messageId}`,
      headers: auth(bob)
    });
    expect(memberPin.statusCode).toBe(403);
    const pin = await app.inject({
      method: "PUT",
      url: `/v1/chats/${chatId}/pins/${messageId}`,
      headers: auth(alice)
    });
    expect(pin.statusCode).toBe(200);
    const pins = await app.inject({
      method: "GET",
      url: `/v1/chats/${chatId}/pins`,
      headers: auth(bob)
    });
    expect(pins.json().items[0]).toMatchObject({ messageId, pinnedBy: { id: alice.id } });
    const messageList = await app.inject({
      method: "GET",
      url: `/v1/chats/${chatId}/messages`,
      headers: auth(bob)
    });
    expect(messageList.json().items.find((item: { id: string }) => item.id === messageId).isPinned).toBe(true);
    expect((await app.inject({
      method: "DELETE",
      url: `/v1/chats/${chatId}/pins/${messageId}`,
      headers: auth(alice)
    })).statusCode).toBe(204);

    await establishAcceptedRelationship(app, alice, eve);

    const direct = await app.inject({
      method: "POST",
      url: "/v1/chats",
      headers: auth(alice),
      payload: { kind: "direct", userId: eve.id }
    });
    const directId = direct.json().chat.id as string;
    const forwarded = await app.inject({
      method: "POST",
      url: `/v1/messages/${messageId}/forward`,
      headers: auth(alice),
      payload: { chatId: directId, clientNonce: randomUUID() }
    });
    expect(forwarded.statusCode).toBe(201);
    expect(forwarded.json().message.forwardedFrom).toMatchObject({
      senderDisplayName: "rich_alice"
    });
    expect(forwarded.json().message.forwardedFrom).not.toHaveProperty("messageId");

    const deleted = await app.inject({
      method: "DELETE",
      url: `/v1/messages/${messageId}`,
      headers: auth(alice)
    });
    expect(deleted.statusCode).toBe(200);
    expect((await app.inject({
      method: "GET",
      url: `/v1/messages/${messageId}/history`,
      headers: auth(bob)
    })).statusCode).toBe(404);
    const searchAfterDelete = await app.inject({
      method: "GET",
      url: "/v1/search/messages?q=updated",
      headers: auth(alice)
    });
    expect(searchAfterDelete.json().items.map((item: { id: string }) => item.id)).not.toContain(messageId);
  });

  it("backfills blind search indexes when a data key is introduced", async () => {
    const root = await mkdtemp(join(tmpdir(), "luxora-search-backfill-"));
    temporaryRoots.push(root);
    const paths = {
      databasePath: join(root, "luxora.db"),
      storageLocalPath: join(root, "blobs"),
      uploadStagingPath: join(root, "uploads")
    };
    app = await buildApp({ config: testConfig(paths), logger: false });
    const alice = await register("backfill_alice");
    const direct = await app.inject({
      method: "POST",
      url: "/v1/chats",
      headers: { authorization: `Bearer ${alice.accessToken}` },
      payload: { kind: "direct", userId: alice.id }
    });
    const message = await app.inject({
      method: "POST",
      url: `/v1/chats/${direct.json().chat.id as string}/messages`,
      headers: { authorization: `Bearer ${alice.accessToken}` },
      payload: { body: "preexisting nebula", clientNonce: randomUUID() }
    });
    const messageId = message.json().message.id as string;
    await app.close();
    app = undefined;

    const key = Buffer.alloc(32, 67).toString("base64url");
    app = await buildApp({
      config: testConfig({
        ...paths,
        dataEncryptionKeys: { rotated: key },
        activeDataEncryptionKeyId: "rotated"
      }),
      logger: false
    });
    const login = await app.inject({
      method: "POST",
      url: "/v1/auth/login",
      payload: {
        username: "backfill_alice",
        password: "correct horse battery staple",
        deviceName: "backfill test"
      }
    });
    const search = await app.inject({
      method: "GET",
      url: "/v1/search/messages?q=nebula",
      headers: { authorization: `Bearer ${login.json().tokens.accessToken as string}` }
    });
    expect(search.statusCode).toBe(200);
    expect(search.json().items.map((item: { id: string }) => item.id)).toContain(messageId);
  });
});
