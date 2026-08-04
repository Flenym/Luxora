import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import type { LuxoraApp } from "./app.js";
import { buildApp } from "./app.js";
import { establishAcceptedRelationship, testConfig } from "./test-helpers.js";

interface Identity {
  id: string;
  accessToken: string;
}

class RealtimeClient {
  readonly messages: unknown[] = [];

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

  send(message: unknown): void {
    this.socket.send(JSON.stringify(message));
  }
}

describe("realtime delivery", () => {
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
      payload: { username, displayName: username, password: "correct horse battery staple" }
    });
    const body = response.json();
    return { id: body.user.id as string, accessToken: body.tokens.accessToken as string };
  }

  async function connect(url: string, identity: Identity, resumeFrom?: number): Promise<RealtimeClient> {
    const socket = new WebSocket(url);
    sockets.push(socket);
    const client = new RealtimeClient(socket);
    await new Promise<void>((resolve, reject) => {
      socket.once("open", resolve);
      socket.once("error", reject);
    });
    await client.waitFor((message) => message.type === "hello");
    client.send({
      type: "authenticate",
      accessToken: identity.accessToken,
      ...(resumeFrom === undefined ? {} : { resumeFrom })
    });
    await client.waitFor((message) => message.type === "ready");
    return client;
  }

  it("delivers durable events and resumes missed messages by sequence", async () => {
    app = await buildApp({ config: testConfig(), logger: false });
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    const wsUrl = `${address.replace("http", "ws")}/v1/realtime`;
    const alice = await register("realtime_alice");
    const bob = await register("realtime_bob");
    const bobClient = await connect(wsUrl, bob);

    await establishAcceptedRelationship(app, alice, bob);

    const chatResponse = await app.inject({
      method: "POST",
      url: "/v1/chats",
      headers: { authorization: `Bearer ${alice.accessToken}` },
      payload: { kind: "direct", userId: bob.id }
    });
    const chatId = chatResponse.json().chat.id as string;
    const chatEvent = await bobClient.waitFor((message) => message.type === "dispatch" && message.event.type === "chat.created");

    await app.inject({
      method: "POST",
      url: `/v1/chats/${chatId}/messages`,
      headers: { authorization: `Bearer ${alice.accessToken}` },
      payload: { body: "first", clientNonce: randomUUID() }
    });
    const firstEvent = await bobClient.waitFor((message) =>
      message.type === "dispatch" &&
      message.event.type === "message.created" &&
      message.event.message.body === "first"
    );
    expect(firstEvent.sequence).toBeGreaterThan(chatEvent.sequence);
    const aliceClient = await connect(wsUrl, alice);
    bobClient.send({
      type: "receipt.delivered",
      chatId,
      messageId: firstEvent.event.message.id
    });
    const delivered = await aliceClient.waitFor((message) =>
      message.type === "dispatch" &&
      message.event.type === "receipt.delivered" &&
      message.event.messageId === firstEvent.event.message.id
    );
    expect(delivered.event.userId).toBe(bob.id);

    bobClient.socket.close();
    await new Promise<void>((resolve) => bobClient.socket.once("close", () => resolve()));

    await app.inject({
      method: "POST",
      url: `/v1/chats/${chatId}/messages`,
      headers: { authorization: `Bearer ${alice.accessToken}` },
      payload: { body: "missed while offline", clientNonce: randomUUID() }
    });

    const resumed = await connect(wsUrl, bob, firstEvent.sequence as number);
    const replayed = await resumed.waitFor((message) =>
      message.type === "dispatch" && message.event.type === "message.created" && message.event.message.body === "missed while offline"
    );
    expect(replayed.sequence).toBeGreaterThan(firstEvent.sequence);

    resumed.socket.close();
    await new Promise<void>((resolve) => resumed.socket.once("close", () => resolve()));
    const transient = await app.inject({
      method: "POST",
      url: `/v1/chats/${chatId}/messages`,
      headers: { authorization: `Bearer ${alice.accessToken}` },
      payload: { body: "must not survive deletion", clientNonce: randomUUID() }
    });
    const transientId = transient.json().message.id as string;
    await app.inject({
      method: "DELETE",
      url: `/v1/messages/${transientId}`,
      headers: { authorization: `Bearer ${alice.accessToken}` }
    });

    const afterDeletion = await connect(wsUrl, bob, replayed.sequence as number);
    await afterDeletion.waitFor((message) =>
      message.type === "dispatch" &&
      message.event.type === "message.deleted" &&
      message.event.message.id === transientId
    );
    expect(afterDeletion.messages.some((message: any) =>
      message.type === "dispatch" &&
      message.event.type === "message.created" &&
      message.event.message.id === transientId
    )).toBe(false);
  });

  it("rejects browser WebSocket upgrades from untrusted origins", async () => {
    app = await buildApp({ config: testConfig(), logger: false });
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    const socket = new WebSocket(`${address.replace("http", "ws")}/v1/realtime`, {
      headers: { Origin: "https://attacker.example" }
    });
    sockets.push(socket);
    const closeCode = await new Promise<number>((resolve, reject) => {
      socket.once("close", resolve);
      socket.once("error", reject);
    });
    expect(closeCode).toBe(1008);
  });

  it("immediately disconnects realtime when the device session is revoked", async () => {
    app = await buildApp({ config: testConfig(), logger: false });
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    const identity = await register("revoked_realtime_user");
    const client = await connect(`${address.replace("http", "ws")}/v1/realtime`, identity);
    const closed = new Promise<number>((resolve) => client.socket.once("close", resolve));

    const logout = await app.inject({
      method: "DELETE",
      url: "/v1/auth/sessions/current",
      headers: { authorization: `Bearer ${identity.accessToken}` }
    });
    expect(logout.statusCode).toBe(204);
    expect(await closed).toBe(4001);
  });
});
