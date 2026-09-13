import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import type { LuxoraApp } from "./app.js";
import { buildApp } from "./app.js";
import { RealtimeCursorCodec } from "./realtime/cursor.js";
import { testConfig } from "./test-helpers.js";

interface Identity {
  id: string;
  username: string;
  accessToken: string;
  sessionId: string;
}

const TEST_CURSOR_CODEC = new RealtimeCursorCodec(
  "test-only-secret-with-at-least-thirty-two-bytes"
);

class RealtimeClient {
  readonly messages: any[] = [];

  constructor(readonly socket: WebSocket) {
    socket.on("message", (raw) => this.messages.push(JSON.parse(raw.toString()) as unknown));
  }

  async waitFor(predicate: (message: any) => boolean, timeoutMs = 3_000): Promise<any> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const index = this.messages.findIndex(predicate);
      if (index >= 0) return this.messages.splice(index, 1)[0];
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`Timed out waiting for realtime message; received ${JSON.stringify(this.messages)}`);
  }

  async expectNoMatch(predicate: (message: any) => boolean, durationMs = 150): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, durationMs));
    expect(this.messages.some(predicate)).toBe(false);
  }

  send(message: unknown): void {
    this.socket.send(JSON.stringify(message));
  }
}

function auth(identity: Identity): { authorization: string } {
  return { authorization: `Bearer ${identity.accessToken}` };
}

describe("IA-1 identity and relationship boundary", () => {
  let app: LuxoraApp | undefined;
  const sockets: WebSocket[] = [];

  afterEach(async () => {
    for (const socket of sockets) socket.close();
    sockets.length = 0;
    await app?.close();
    app = undefined;
  });

  async function register(username: string): Promise<Identity> {
    const response = await app!.inject({
      method: "POST",
      url: "/v1/auth/register",
      payload: {
        username,
        displayName: `Display ${username}`,
        password: "correct horse battery staple"
      }
    });
    expect(response.statusCode).toBe(201);
    const body = response.json();
    return {
      id: body.user.id as string,
      username,
      accessToken: body.tokens.accessToken as string,
      sessionId: body.tokens.sessionId as string
    };
  }

  async function createRequest(
    sender: Identity,
    recipient: Identity,
    body = "Hello from a bounded request",
    clientNonce = randomUUID()
  ) {
    return app!.inject({
      method: "POST",
      url: "/v1/message-requests",
      headers: auth(sender),
      payload: { recipientUserId: recipient.id, body, clientNonce }
    });
  }

  async function connect(
    address: string,
    version: 1 | 2,
    identity: Identity,
    resumeFrom?: number
  ): Promise<RealtimeClient> {
    const socket = new WebSocket(`${address.replace("http", "ws")}/v${version}/realtime`);
    sockets.push(socket);
    const client = new RealtimeClient(socket);
    await new Promise<void>((resolve, reject) => {
      socket.once("open", resolve);
      socket.once("error", reject);
    });
    const hello = await client.waitFor((message) => message.type === "hello");
    expect(hello.protocolVersion).toBe(version);
    client.send({
      type: "authenticate",
      accessToken: identity.accessToken,
      ...(resumeFrom === undefined
        ? {}
        : version === 1
          ? { resumeFrom }
          : { resumeCursor: TEST_CURSOR_CODEC.issue(identity.id, identity.sessionId, resumeFrom).cursor })
    });
    await client.waitFor((message) => message.type === "ready");
    return client;
  }

  it("enforces exact discovery, privacy policy, IDOR protection, and atomic request acceptance", async () => {
    app = await buildApp({ config: testConfig(), logger: false });
    const alice = await register("ia_alice");
    const bob = await register("ia_bob");
    const carol = await register("ia_carol");

    const visible = await app.inject({
      method: "GET",
      url: `/v1/users/lookup?username=${bob.username.toUpperCase()}`,
      headers: auth(alice)
    });
    expect(visible.statusCode).toBe(200);
    expect(Object.keys(visible.json().profile).sort()).toEqual([
      "avatarPath", "avatarUrl", "bio", "displayName", "id", "lastSeenAt", "username"
    ]);

    const hidden = await app.inject({
      method: "PATCH",
      url: "/v1/privacy",
      headers: auth(bob),
      payload: { usernameDiscoverable: false, messageRequests: "nobody" }
    });
    expect(hidden.statusCode).toBe(200);
    expect(hidden.headers["cache-control"]).toContain("no-store");

    const hiddenLookup = await app.inject({
      method: "GET",
      url: `/v1/users/lookup?username=${bob.username}`,
      headers: auth(alice)
    });
    expect(hiddenLookup.statusCode).toBe(200);
    expect(hiddenLookup.json()).toEqual({ profile: null });

    const unavailable = await createRequest(alice, bob);
    const nonexistent = await app.inject({
      method: "POST",
      url: "/v1/message-requests",
      headers: auth(alice),
      payload: {
        recipientUserId: randomUUID(),
        body: "Same public failure",
        clientNonce: randomUUID()
      }
    });
    expect(unavailable.statusCode).toBe(403);
    expect(nonexistent.statusCode).toBe(403);
    expect(unavailable.json().error.code).toBe("FORBIDDEN");
    expect(nonexistent.json().error.code).toBe("FORBIDDEN");
    expect(unavailable.json().error.details).toEqual({ reason: "relationship_unavailable" });
    expect(nonexistent.json().error.details).toEqual({ reason: "relationship_unavailable" });

    await app.inject({
      method: "PATCH",
      url: "/v1/privacy",
      headers: auth(bob),
      payload: { usernameDiscoverable: true, messageRequests: "everyone" }
    });

    const nonce = randomUUID();
    const created = await createRequest(alice, bob, "One inert https://example.com/path request", nonce);
    expect(created.statusCode).toBe(201);
    const request = created.json().request;
    expect(request.direction).toBe("outgoing");
    expect(request.state).toBe("pending");
    expect(request.sender).toBeUndefined();
    expect(request.validatedLink).toBeUndefined();

    const retried = await createRequest(alice, bob, "One inert https://example.com/path request", nonce);
    expect(retried.statusCode).toBe(201);
    expect(retried.json().request.id).toBe(request.id);
    const nonceConflict = await createRequest(alice, bob, "Changed body", nonce);
    expect(nonceConflict.statusCode).toBe(409);

    const strangerDirect = await app.inject({
      method: "POST",
      url: "/v1/chats",
      headers: auth(alice),
      payload: { kind: "direct", userId: bob.id }
    });
    expect(strangerDirect.statusCode).toBe(201);
    expect(strangerDirect.json().chat.kind).toBe("direct");
    const groupBypass = await app.inject({
      method: "POST",
      url: "/v1/chats",
      headers: auth(alice),
      payload: { kind: "group", title: "Consent bypass", memberIds: [bob.id] }
    });
    expect(groupBypass.statusCode).toBe(403);

    for (const intruderAction of ["accept", "dismiss"] as const) {
      const response = await app.inject({
        method: intruderAction === "accept" ? "POST" : "DELETE",
        url: `/v1/message-requests/${request.id}${intruderAction === "accept" ? "/accept" : ""}`,
        headers: auth(carol)
      });
      expect(response.statusCode).toBe(404);
    }

    const [acceptedLeft, acceptedRight] = await Promise.all([
      app.inject({
        method: "POST",
        url: `/v1/message-requests/${request.id as string}/accept`,
        headers: auth(bob)
      }),
      app.inject({
        method: "POST",
        url: `/v1/message-requests/${request.id as string}/accept`,
        headers: auth(bob)
      })
    ]);
    expect(acceptedLeft.statusCode).toBe(200);
    expect(acceptedRight.statusCode).toBe(200);
    expect(acceptedLeft.json().chat.id).toBe(acceptedRight.json().chat.id);

    const chatId = acceptedLeft.json().chat.id as string;
    const messages = await app.inject({
      method: "GET",
      url: `/v1/chats/${chatId}/messages`,
      headers: auth(bob)
    });
    expect(messages.statusCode).toBe(200);
    expect(messages.json().items.filter((item: any) => item.body.includes("One inert")).length).toBe(1);

    const known = await app.inject({
      method: "GET",
      url: "/v1/users/search?q=ia_&limit=30",
      headers: auth(alice)
    });
    expect(known.statusCode).toBe(200);
    expect(known.json().items.map((item: any) => item.id)).toEqual([bob.id]);
    expect(known.json().items[0].presence).toBeUndefined();
    expect(known.json().items[0].lastSeenAt).toBeUndefined();
  });

  // This boundary intentionally performs two production-cost Argon2id
  // registrations plus four independently bounded realtime handshakes. Keep
  // the outer budget above their normal aggregate without weakening any of
  // the per-message 3 s deadlines in RealtimeClient.waitFor.
  it("keeps dismiss and block direction private across realtime versions", async () => {
    app = await buildApp({ config: testConfig(), logger: false });
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    const alice = await register("private_alice");
    const bob = await register("private_bob");
    const aliceV2 = await connect(address, 2, alice);
    const bobV1 = await connect(address, 1, bob);
    const bobV2 = await connect(address, 2, bob);

    const created = await createRequest(alice, bob, "Quiet request");
    expect(created.statusCode).toBe(201);
    const requestId = created.json().request.id as string;
    const incoming = await bobV2.waitFor((message) =>
      message.type === "dispatch" &&
      message.event.type === "relationship.request.created" &&
      message.event.audience === "recipient_account"
    );
    expect(incoming.event.request.sender.id).toBe(alice.id);
    await bobV1.expectNoMatch((message) =>
      message.type === "dispatch" && message.event.type.startsWith("relationship.")
    );

    const dismissed = await app.inject({
      method: "DELETE",
      url: `/v1/message-requests/${requestId}`,
      headers: auth(bob)
    });
    expect(dismissed.statusCode).toBe(204);
    const removed = await bobV2.waitFor((message) =>
      message.type === "dispatch" &&
      message.event.type === "relationship.request.removed" &&
      message.event.requestId === requestId
    );
    expect(removed.event.audience).toBe("recipient_account");
    await aliceV2.expectNoMatch((message) =>
      message.type === "dispatch" &&
      (message.event.type.includes("dismiss") || message.event.type === "relationship.request.removed")
    );

    const bobReplay = await connect(address, 2, bob, 0);
    await bobReplay.expectNoMatch((message) =>
      message.type === "dispatch" &&
      message.event.type === "relationship.request.created" &&
      message.event.request.id === requestId
    );

    const outgoing = await app.inject({
      method: "GET",
      url: "/v1/message-requests?direction=outgoing&limit=30",
      headers: auth(alice)
    });
    expect(outgoing.json().items.find((item: any) => item.id === requestId).state).toBe("pending");

    const blocked = await app.inject({
      method: "PUT",
      url: `/v1/blocks/${alice.id}`,
      headers: auth(bob)
    });
    expect(blocked.statusCode).toBe(200);
    const blockEvent = await bobV2.waitFor((message) =>
      message.type === "dispatch" &&
      message.event.type === "relationship.block.changed" &&
      message.event.blocked === true
    );
    expect(blockEvent.event.accountId).toBe(alice.id);
    await aliceV2.expectNoMatch((message) =>
      message.type === "dispatch" && message.event.type === "relationship.block.changed"
    );
    await bobV1.expectNoMatch((message) =>
      message.type === "dispatch" && message.event.type === "relationship.block.changed"
    );

    const blockedLookup = await app.inject({
      method: "GET",
      url: `/v1/users/lookup?username=${bob.username}`,
      headers: auth(alice)
    });
    expect(blockedLookup.json()).toEqual({ profile: null });

    const blocks = await app.inject({
      method: "GET",
      url: "/v1/blocks?limit=30",
      headers: auth(bob)
    });
    expect(blocks.statusCode).toBe(200);
    expect(blocks.json().items[0].profileSnapshot.id).toBe(alice.id);
    expect(blocks.json().items[0].profileSnapshot.lastSeenAt).toBeUndefined();

    const unblocked = await app.inject({
      method: "DELETE",
      url: `/v1/blocks/${alice.id}`,
      headers: auth(bob)
    });
    expect(unblocked.statusCode).toBe(200);
    expect(unblocked.json().blocked).toBe(false);
    await bobV2.waitFor((message) =>
      message.type === "dispatch" &&
      message.event.type === "relationship.block.changed" &&
      message.event.blocked === false
    );

    const cooldown = await createRequest(alice, bob, "Must not reveal dismissal");
    expect(cooldown.statusCode).toBe(403);
    expect(cooldown.json().error.details).toEqual({ reason: "relationship_unavailable" });
  }, 10_000);

  it("stores only selected authorized report evidence and makes optional block effective", async () => {
    app = await buildApp({ config: testConfig(), logger: false });
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    const alice = await register("report_alice");
    const bob = await register("report_bob");
    const carol = await register("report_carol");

    const request = await createRequest(alice, bob, "Initial accepted request");
    const accepted = await app.inject({
      method: "POST",
      url: `/v1/message-requests/${request.json().request.id as string}/accept`,
      headers: auth(bob)
    });
    expect(accepted.statusCode).toBe(200);
    const chatId = accepted.json().chat.id as string;

    const sent = await app.inject({
      method: "POST",
      url: `/v1/chats/${chatId}/messages`,
      headers: auth(bob),
      payload: { body: "Evidence chosen by the reporter", clientNonce: randomUUID() }
    });
    expect(sent.statusCode).toBe(201);
    const evidenceMessageId = sent.json().message.id as string;
    const reportNonce = randomUUID();
    const reportPayload = {
      subjectAccountId: bob.id,
      category: "harassment",
      evidence: [{ type: "message", messageId: evidenceMessageId }],
      comment: "Only this selected item",
      alsoBlock: true,
      clientNonce: reportNonce
    };

    const unauthorized = await app.inject({
      method: "POST",
      url: "/v1/safety/reports",
      headers: auth(carol),
      payload: { ...reportPayload, clientNonce: randomUUID(), alsoBlock: false }
    });
    expect(unauthorized.statusCode).toBe(404);

    const submitted = await app.inject({
      method: "POST",
      url: "/v1/safety/reports",
      headers: auth(alice),
      payload: reportPayload
    });
    expect(submitted.statusCode).toBe(201);
    expect(submitted.json().report).toMatchObject({
      subjectAccountId: bob.id,
      evidenceCount: 1,
      alsoBlocked: true,
      status: "submitted"
    });
    expect(submitted.json().report.evidence).toBeUndefined();
    expect(submitted.json().report.comment).toBeUndefined();

    const blockedReplay = await connect(address, 2, bob, 0);
    await blockedReplay.expectNoMatch((message) =>
      message.type === "dispatch" && (
        (message.event.type === "chat.created" && message.event.chat.id === chatId) ||
        (["message.created", "message.updated", "message.deleted"].includes(message.event.type) &&
          message.event.message.chatId === chatId) ||
        (message.event.type === "relationship.request.accepted" && message.event.chat.id === chatId)
      )
    );

    const duplicate = await app.inject({
      method: "POST",
      url: "/v1/safety/reports",
      headers: auth(alice),
      payload: reportPayload
    });
    expect(duplicate.statusCode).toBe(201);
    expect(duplicate.json().report.id).toBe(submitted.json().report.id);

    const reusedNonce = await app.inject({
      method: "POST",
      url: "/v1/safety/reports",
      headers: auth(alice),
      payload: { ...reportPayload, category: "spam" }
    });
    expect(reusedNonce.statusCode).toBe(409);

    for (const actor of [alice, bob]) {
      const deniedSend = await app.inject({
        method: "POST",
        url: `/v1/chats/${chatId}/messages`,
        headers: auth(actor),
        payload: { body: "Blocked direct transport", clientNonce: randomUUID() }
      });
      expect(deniedSend.statusCode).toBe(403);
      expect(deniedSend.json().error.details).toEqual({ reason: "relationship_unavailable" });
    }

    const deniedReceipt = await app.inject({
      method: "POST",
      url: `/v1/chats/${chatId}/read`,
      headers: auth(bob),
      payload: { messageId: evidenceMessageId }
    });
    expect(deniedReceipt.statusCode).toBe(403);

    const deniedReaction = await app.inject({
      method: "PUT",
      url: `/v1/messages/${evidenceMessageId}/reactions`,
      headers: auth(bob),
      payload: { emoji: "x" }
    });
    expect(deniedReaction.statusCode).toBe(403);

    const unblocked = await app.inject({
      method: "DELETE",
      url: `/v1/blocks/${bob.id}`,
      headers: auth(alice)
    });
    expect(unblocked.statusCode).toBe(200);
    // Telegram semantics: a block erases the accepted relationship, and after
    // the unblock the default everyone-privacy lets strangers deliver again
    // without a new request/acceptance round-trip.
    const afterUnblock = await app.inject({
      method: "POST",
      url: `/v1/chats/${chatId}/messages`,
      headers: auth(bob),
      payload: { body: "Delivered after unblock", clientNonce: randomUUID() }
    });
    expect(afterUnblock.statusCode).toBe(201);

    const newRequest = await createRequest(bob, alice, "Explicit consent after unblock");
    expect(newRequest.statusCode).toBe(201);
    const reaccepted = await app.inject({
      method: "POST",
      url: `/v1/message-requests/${newRequest.json().request.id as string}/accept`,
      headers: auth(alice)
    });
    expect(reaccepted.statusCode).toBe(200);
    expect(reaccepted.json().chat.id).toBe(chatId);
  });
});
