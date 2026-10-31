import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import type { LuxoraApp } from "./app.js";
import { buildApp } from "./app.js";
import { testConfig } from "./test-helpers.js";

interface Identity {
  id: string;
  accessToken: string;
}

function auth(identity: Identity): { authorization: string } {
  return { authorization: `Bearer ${identity.accessToken}` };
}

describe("direct chat requires an accepted, unblocked relationship", () => {
  let app: LuxoraApp | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  async function register(username: string): Promise<Identity> {
    const response = await app!.inject({
      method: "POST",
      url: "/v1/auth/register",
      payload: {
        username,
        displayName: username,
        password: "correct horse battery staple",
        deviceName: "relationship test"
      }
    });
    expect(response.statusCode, response.body).toBe(201);
    return {
      id: response.json().user.id as string,
      accessToken: response.json().tokens.accessToken as string
    };
  }

  async function createDirect(actor: Identity, target: Identity) {
    return app!.inject({
      method: "POST",
      url: "/v1/chats",
      headers: auth(actor),
      payload: { kind: "direct", userId: target.id }
    });
  }

  it("denies a stranger Direct and creates no chat, member or relationship rows", async () => {
    app = await buildApp({ config: testConfig(), logger: false });
    const alice = await register("direct_guard_alice");
    const bob = await register("direct_guard_bob");

    // Discovery succeeds; the Direct guard is a separate relationship boundary.
    const lookup = await app.inject({
      method: "GET",
      url: `/v1/users/lookup?username=direct_guard_bob`,
      headers: auth(alice)
    });
    expect(lookup.statusCode).toBe(200);
    expect(lookup.json().profile.id).toBe(bob.id);

    const denied = await createDirect(alice, bob);
    expect(denied.statusCode, denied.body).toBe(403);
    expect(denied.json().error.code).toBe("FORBIDDEN");
    expect(denied.json().error.details).toEqual({ reason: "relationship_unavailable" });

    const chatsForAlice = await app.inject({
      method: "GET",
      url: "/v1/chats",
      headers: auth(alice)
    });
    expect(chatsForAlice.statusCode).toBe(200);
    expect(chatsForAlice.json().items).toHaveLength(0);
    const chatsForBob = await app.inject({
      method: "GET",
      url: "/v1/chats",
      headers: auth(bob)
    });
    expect(chatsForBob.statusCode).toBe(200);
    expect(chatsForBob.json().items).toHaveLength(0);
    expect(app.luxora.store.adminStatus().chatsByKind.direct).toBe(0);
    expect(app.luxora.store.hasAcceptedRelationship(alice.id, bob.id)).toBe(false);

    // The failed attempt must not consume or accept the message-request path.
    const created = await app.inject({
      method: "POST",
      url: "/v1/message-requests",
      headers: auth(alice),
      payload: {
        recipientUserId: bob.id,
        body: "Relationship boundary request",
        clientNonce: randomUUID()
      }
    });
    expect(created.statusCode, created.body).toBe(201);
    const requestId = created.json().request.id as string;
    const accepted = await app.inject({
      method: "POST",
      url: `/v1/message-requests/${requestId}/accept`,
      headers: auth(bob)
    });
    expect(accepted.statusCode, accepted.body).toBe(200);
    const chatId = accepted.json().chat.id as string;
    expect(accepted.json().chat.kind).toBe("direct");

    // Relationship + Direct now exist atomically, and recreating the Direct is
    // an idempotent read of the accepted chat.
    expect(app.luxora.store.hasAcceptedRelationship(alice.id, bob.id)).toBe(true);
    const recreated = await createDirect(alice, bob);
    expect(recreated.statusCode, recreated.body).toBe(201);
    expect(recreated.json().chat.id).toBe(chatId);
    const chatsAfterAcceptance = await app.inject({
      method: "GET",
      url: "/v1/chats",
      headers: auth(alice)
    });
    expect(chatsAfterAcceptance.json().items.map((chat: { id: string }) => chat.id)).toContain(chatId);

    // Messages in the accepted Direct pass the relationship gate.
    const sent = await app.inject({
      method: "POST",
      url: `/v1/chats/${chatId}/messages`,
      headers: auth(alice),
      payload: { body: "Accepted direct message", clientNonce: randomUUID() }
    });
    expect(sent.statusCode, sent.body).toBe(201);
  });

  it("denies Direct creation in both block directions and keeps self Direct allowed", async () => {
    app = await buildApp({ config: testConfig(), logger: false });
    const alice = await register("direct_block_alice");
    const bob = await register("direct_block_bob");

    // Establish the accepted relationship through the documented request path.
    const created = await app.inject({
      method: "POST",
      url: "/v1/message-requests",
      headers: auth(alice),
      payload: {
        recipientUserId: bob.id,
        body: "Block boundary request",
        clientNonce: randomUUID()
      }
    });
    expect(created.statusCode, created.body).toBe(201);
    const accepted = await app.inject({
      method: "POST",
      url: `/v1/message-requests/${created.json().request.id as string}/accept`,
      headers: auth(bob)
    });
    expect(accepted.statusCode, accepted.body).toBe(200);
    const directId = accepted.json().chat.id as string;

    await app.inject({ method: "PUT", url: `/v1/blocks/${alice.id}`, headers: auth(bob) });

    const blockedByTarget = await createDirect(alice, bob);
    expect(blockedByTarget.statusCode, blockedByTarget.body).toBe(403);
    expect(blockedByTarget.json().error.details).toEqual({ reason: "relationship_unavailable" });
    const blockedByActor = await createDirect(bob, alice);
    expect(blockedByActor.statusCode, blockedByActor.body).toBe(403);
    expect(blockedByActor.json().error.details).toEqual({ reason: "relationship_unavailable" });

    // Existing chat and relationship rows are untouched by the denied attempts.
    expect(app.luxora.store.adminStatus().chatsByKind.direct).toBe(1);
    const chats = await app.inject({ method: "GET", url: "/v1/chats", headers: auth(alice) });
    expect(chats.json().items.map((chat: { id: string }) => chat.id)).toEqual([directId]);

    // Self Direct (saved messages) remains available while blocked.
    const aliceMe = await app.inject({ method: "GET", url: "/v1/me", headers: auth(alice) });
    expect(aliceMe.statusCode).toBe(200);
    const selfDirect = await createDirect(
      { id: aliceMe.json().user.id as string, accessToken: alice.accessToken },
      { id: aliceMe.json().user.id as string, accessToken: alice.accessToken }
    );
    expect(selfDirect.statusCode, selfDirect.body).toBe(201);
    expect(selfDirect.json().chat.kind).toBe("direct");
  });
});
