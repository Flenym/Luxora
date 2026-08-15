import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import type { LuxoraApp } from "./app.js";
import { buildApp } from "./app.js";
import { establishAcceptedRelationship, testConfig } from "./test-helpers.js";

interface Identity {
  id: string;
  username: string;
  accessToken: string;
}

class RealtimeClient {
  readonly messages: any[] = [];

  constructor(readonly socket: WebSocket) {
    socket.on("message", (raw) => this.messages.push(JSON.parse(raw.toString()) as unknown));
  }

  send(message: unknown): void {
    this.socket.send(JSON.stringify(message));
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

  async expectNoMatch(predicate: (message: any) => boolean, durationMs = 200): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, durationMs));
    expect(this.messages.some(predicate)).toBe(false);
  }
}

describe("chat draft realtime account/session projection", () => {
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
        displayName: username,
        password: "correct horse battery staple",
        deviceName: `${username} primary`
      }
    });
    expect(response.statusCode, response.body).toBe(201);
    return {
      id: response.json().user.id as string,
      username,
      accessToken: response.json().tokens.accessToken as string
    };
  }

  async function login(identity: Identity, deviceName: string): Promise<Identity> {
    const response = await app!.inject({
      method: "POST",
      url: "/v1/auth/login",
      payload: {
        username: identity.username,
        password: "correct horse battery staple",
        deviceName
      }
    });
    expect(response.statusCode, response.body).toBe(200);
    return { ...identity, accessToken: response.json().tokens.accessToken as string };
  }

  async function connect(
    address: string,
    identity: Identity,
    version: 1 | 2
  ): Promise<RealtimeClient> {
    const socket = new WebSocket(`${address.replace("http", "ws")}/v${version}/realtime`);
    sockets.push(socket);
    const client = new RealtimeClient(socket);
    await new Promise<void>((resolve, reject) => {
      socket.once("open", resolve);
      socket.once("error", reject);
    });
    await client.waitFor((message) => message.type === "hello");
    client.send({ type: "authenticate", accessToken: identity.accessToken });
    await client.waitFor((message) => message.type === "ready");
    if (version === 2) await client.waitFor((message) => message.type === "sync.checkpoint");
    return client;
  }

  it("dispatches through the durable outbox to every v2 session of only the owning account", async () => {
    app = await buildApp({
      config: testConfig({
        dataEncryptionKeys: { draft_rt: Buffer.alloc(32, 37).toString("base64url") },
        activeDataEncryptionKeyId: "draft_rt"
      }),
      logger: false
    });
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    const alicePrimary = await register("draft_rt_alice");
    const aliceSecondary = await login(alicePrimary, "Alice iPad");
    const bob = await register("draft_rt_bob");
    const chatId = await establishAcceptedRelationship(app, alicePrimary, bob);

    const aliceV2Primary = await connect(address, alicePrimary, 2);
    const aliceV2Secondary = await connect(address, aliceSecondary, 2);
    const aliceV1 = await connect(address, alicePrimary, 1);
    const bobV2 = await connect(address, bob, 2);

    const put = await app.inject({
      method: "PUT",
      url: `/v1/chats/${chatId}/draft`,
      headers: { authorization: `Bearer ${alicePrimary.accessToken}` },
      payload: {
        text: "same-account-sessions-only-canary",
        expectedRevision: 0,
        clientNonce: randomUUID()
      }
    });
    expect(put.statusCode, put.body).toBe(200);

    for (const client of [aliceV2Primary, aliceV2Secondary]) {
      const dispatch = await client.waitFor((message) =>
        message.type === "dispatch" && message.event.type === "chat.draft.changed"
      );
      expect(dispatch.event).toMatchObject({
        audience: "account_sessions",
        accountId: alicePrimary.id,
        chatId,
        draft: { text: "same-account-sessions-only-canary", revision: 1 },
        revision: 1
      });
      expect(dispatch.cursor).toMatch(/^luxora-rt1\./u);
    }
    await bobV2.expectNoMatch((message) => message.event?.type === "chat.draft.changed");
    await aliceV1.expectNoMatch((message) => message.event?.type === "chat.draft.changed");

    const deleted = await app.inject({
      method: "DELETE",
      url: `/v1/chats/${chatId}/draft`,
      headers: { authorization: `Bearer ${alicePrimary.accessToken}` },
      payload: { expectedRevision: 1, clientNonce: randomUUID() }
    });
    expect(deleted.statusCode, deleted.body).toBe(200);
    for (const client of [aliceV2Primary, aliceV2Secondary]) {
      const dispatch = await client.waitFor((message) =>
        message.type === "dispatch" &&
        message.event.type === "chat.draft.changed" &&
        message.event.revision === 2
      );
      expect(dispatch.event).toMatchObject({ draft: null, revision: 2 });
      expect(JSON.stringify(dispatch)).not.toContain("same-account-sessions-only-canary");
    }
    await bobV2.expectNoMatch((message) => message.event?.type === "chat.draft.changed");
    await aliceV1.expectNoMatch((message) => message.event?.type === "chat.draft.changed");

    // A synchronously drained outbox has no due claim left, while the durable
    // event log remains replayable for cursor recovery.
    expect(app.luxora.store.claimRealtimeOutbox(
      randomUUID(),
      new Date().toISOString(),
      new Date(Date.now() + 30_000).toISOString(),
      100
    )).toEqual([]);
  });
});
