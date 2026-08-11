import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import type { LuxoraApp } from "./app.js";
import { buildApp } from "./app.js";
import { establishAcceptedRelationship, testConfig } from "./test-helpers.js";

interface TestIdentity {
  id: string;
  accessToken: string;
}

describe("chat and message authorization", () => {
  let app: LuxoraApp | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  async function register(username: string): Promise<TestIdentity> {
    const response = await app!.inject({
      method: "POST",
      url: "/v1/auth/register",
      payload: {
        username,
        displayName: username,
        password: "correct horse battery staple"
      }
    });
    const body = response.json();
    return { id: body.user.id as string, accessToken: body.tokens.accessToken as string };
  }

  it("enforces membership, idempotency, author edits, and optimistic revisions", async () => {
    const key = Buffer.alloc(32, 7).toString("base64url");
    app = await buildApp({
      config: testConfig({ dataEncryptionKeys: { test: key }, activeDataEncryptionKeyId: "test" }),
      logger: false
    });
    const alice = await register("alice");
    const bob = await register("bob_user");
    const eve = await register("eve_user");
    const aliceAuth = { authorization: `Bearer ${alice.accessToken}` };

    const savedMessages = await app.inject({
      method: "POST",
      url: "/v1/chats",
      headers: aliceAuth,
      payload: { kind: "direct", userId: alice.id }
    });
    expect(savedMessages.statusCode).toBe(201);
    expect(savedMessages.json().chat.title).toBe("Избранное");

    await establishAcceptedRelationship(app, alice, bob);

    const createdChat = await app.inject({
      method: "POST",
      url: "/v1/chats",
      headers: aliceAuth,
      payload: { kind: "direct", userId: bob.id }
    });
    expect(createdChat.statusCode).toBe(201);
    const chatId = createdChat.json().chat.id as string;

    const payload = { body: "Hello, Bob", clientNonce: randomUUID() };
    const firstSend = await app.inject({
      method: "POST",
      url: `/v1/chats/${chatId}/messages`,
      headers: aliceAuth,
      payload
    });
    expect(firstSend.statusCode).toBe(201);
    const messageId = firstSend.json().message.id as string;

    const duplicateSend = await app.inject({
      method: "POST",
      url: `/v1/chats/${chatId}/messages`,
      headers: aliceAuth,
      payload
    });
    expect(duplicateSend.json().message.id).toBe(messageId);

    const forbiddenList = await app.inject({
      method: "GET",
      url: `/v1/chats/${chatId}/messages`,
      headers: { authorization: `Bearer ${eve.accessToken}` }
    });
    expect(forbiddenList.statusCode).toBe(403);

    const forbiddenEdit = await app.inject({
      method: "PATCH",
      url: `/v1/messages/${messageId}`,
      headers: { authorization: `Bearer ${bob.accessToken}` },
      payload: { body: "tampered" }
    });
    expect(forbiddenEdit.statusCode).toBe(403);

    const edited = await app.inject({
      method: "PATCH",
      url: `/v1/messages/${messageId}`,
      headers: aliceAuth,
      payload: { body: "Hello again", expectedRevision: 0 }
    });
    expect(edited.statusCode).toBe(200);
    expect(edited.json().message.revision).toBe(1);

    const staleEdit = await app.inject({
      method: "PATCH",
      url: `/v1/messages/${messageId}`,
      headers: aliceAuth,
      payload: { body: "stale", expectedRevision: 0 }
    });
    expect(staleEdit.statusCode).toBe(409);

    const bobMessages = await app.inject({
      method: "GET",
      url: `/v1/chats/${chatId}/messages`,
      headers: { authorization: `Bearer ${bob.accessToken}` }
    });
    expect(bobMessages.statusCode).toBe(200);
    expect(bobMessages.json().items[0].body).toBe("Hello again");
  });

  it("maps uppercase UUID paths and nonce aliases to the same canonical resources", async () => {
    const key = Buffer.alloc(32, 8).toString("base64url");
    app = await buildApp({
      config: testConfig({ dataEncryptionKeys: { test: key }, activeDataEncryptionKeyId: "test" }),
      logger: false
    });
    const alice = await register("canonical_alice");
    const bob = await register("canonical_bob");
    const aliceAuth = { authorization: `Bearer ${alice.accessToken}` };

    const chatId = await establishAcceptedRelationship(app, alice, bob);
    const uppercasePath = await app.inject({
      method: "GET",
      url: `/v1/chats/${chatId.toUpperCase()}`,
      headers: aliceAuth
    });
    expect(uppercasePath.statusCode).toBe(200);
    expect(uppercasePath.json().chat.id).toBe(chatId);

    const clientNonce = randomUUID();
    const firstSend = await app.inject({
      method: "POST",
      url: `/v1/chats/${chatId}/messages`,
      headers: aliceAuth,
      payload: { body: "one logical operation", clientNonce }
    });
    expect(firstSend.statusCode).toBe(201);
    expect(firstSend.json().message.clientNonce).toBe(clientNonce);

    const casingAlias = await app.inject({
      method: "POST",
      url: `/v1/chats/${chatId.toUpperCase()}/messages`,
      headers: aliceAuth,
      payload: { body: "one logical operation", clientNonce: clientNonce.toUpperCase() }
    });
    expect(casingAlias.statusCode).toBe(201);
    expect(casingAlias.json().message.id).toBe(firstSend.json().message.id);
    expect(casingAlias.json().message.clientNonce).toBe(clientNonce);

    const conflictingAlias = await app.inject({
      method: "POST",
      url: `/v1/chats/${chatId}/messages`,
      headers: aliceAuth,
      payload: { body: "different operation", clientNonce: clientNonce.toUpperCase() }
    });
    expect(conflictingAlias.statusCode).toBe(409);
  });
});
