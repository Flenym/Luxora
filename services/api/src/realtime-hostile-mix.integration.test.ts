import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import type { LuxoraApp } from "./app.js";
import { buildApp } from "./app.js";
import type { StoredEvent } from "./domain/types.js";
import type { RealtimeConnection } from "./realtime/hub.js";
import {
  compactTypingThrottleEntries,
  MAX_TRACKED_TYPING_CHATS,
  shouldPublishTyping,
  TYPING_THROTTLE_MS,
  TYPING_TTL_MS
} from "./realtime/typing-throttle.js";
import { TokenSecurity } from "./security.js";
import { testConfig } from "./test-helpers.js";

const PASSWORD = "correct horse battery staple";
const MAX_FRAMES_PER_TEN_SECONDS = 120;
const MAX_TYPING_FRAMES_PER_FIVE_SECONDS = 8;
const MAX_PENDING_EVENTS = 1_000;
const MAX_BUFFERED_BYTES = 1_000_000;
const MAX_CONNECTIONS_PER_SESSION = 4;
const MAX_AUTH_ATTEMPTS_PER_IP_PER_MINUTE = 60;
const MAX_PENDING_CONNECTIONS_PER_IP = 16;

interface Identity {
  id: string;
  username: string;
  accessToken: string;
  sessionId: string;
}

interface CloseResult {
  code: number;
  reason: string;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function within<T>(promise: Promise<T>, timeoutMs = 3_000): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error(`Timed out after ${timeoutMs} ms`)), timeoutMs);
      })
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

class HostileRealtimeClient {
  readonly messages: any[] = [];
  readonly closed: Promise<CloseResult>;

  constructor(readonly socket: WebSocket) {
    socket.on("message", (raw) => this.messages.push(JSON.parse(raw.toString()) as unknown));
    socket.on("error", () => undefined);
    this.closed = new Promise((resolve) => {
      socket.once("close", (code, reason) => resolve({ code, reason: reason.toString("utf8") }));
    });
  }

  send(message: unknown): void {
    this.socket.send(JSON.stringify(message));
  }

  async waitFor(predicate: (message: any) => boolean, timeoutMs = 3_000): Promise<any> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const index = this.messages.findIndex(predicate);
      if (index >= 0) return this.messages.splice(index, 1)[0];
      await delay(5);
    }
    throw new Error(`Timed out waiting for realtime message; received ${JSON.stringify(this.messages)}`);
  }
}

class ControlledSocket {
  readyState: number = WebSocket.OPEN;
  bufferedAmount = 0;
  readonly sent: string[] = [];
  readonly closes: CloseResult[] = [];

  send(data: string): void {
    this.sent.push(data);
  }

  close(code = 1000, reason = ""): void {
    this.closes.push({ code, reason });
    this.readyState = WebSocket.CLOSING;
  }
}

describe("hostile realtime limits", () => {
  let app: LuxoraApp | undefined;
  const sockets: WebSocket[] = [];

  afterEach(async () => {
    for (const socket of sockets) {
      if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
        socket.terminate();
      }
    }
    sockets.length = 0;
    vi.restoreAllMocks();
    await app?.close();
    app = undefined;
  });

  async function register(username: string): Promise<Identity> {
    const response = await app!.inject({
      method: "POST",
      url: "/v1/auth/register",
      payload: { username, displayName: username, password: PASSWORD }
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

  async function login(identity: Identity, deviceName: string): Promise<Identity> {
    const response = await app!.inject({
      method: "POST",
      url: "/v1/auth/login",
      payload: { username: identity.username, password: PASSWORD, deviceName }
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    return {
      id: body.user.id as string,
      username: identity.username,
      accessToken: body.tokens.accessToken as string,
      sessionId: body.tokens.sessionId as string
    };
  }

  async function open(
    address: string,
    path = "/v2/realtime",
    forwardedFor?: string
  ): Promise<HostileRealtimeClient> {
    const socket = new WebSocket(
      `${address.replace("http", "ws")}${path}`,
      forwardedFor === undefined ? undefined : { headers: { "x-forwarded-for": forwardedFor } }
    );
    sockets.push(socket);
    const client = new HostileRealtimeClient(socket);
    await within(new Promise<void>((resolve, reject) => {
      socket.once("open", resolve);
      socket.once("error", reject);
    }));
    return client;
  }

  async function connect(address: string, identity: Identity): Promise<HostileRealtimeClient> {
    const client = await open(address);
    await client.waitFor((message) => message.type === "hello");
    client.send({ type: "authenticate", accessToken: identity.accessToken });
    await client.waitFor((message) => message.type === "ready");
    return client;
  }

  function addSelfGroup(identity: Identity, index: number): string {
    const id = randomUUID();
    const createdAt = new Date().toISOString();
    app!.luxora.store.createChat({
      id,
      kind: "group",
      title: `Typing bucket ${index}`,
      directKey: null,
      createdBy: identity.id,
      createdAt
    });
    app!.luxora.store.addChatMember(id, identity.id, "owner", createdAt);
    return id;
  }

  it("bounds inbound frame floods before their promise chain can grow without limit", async () => {
    app = await buildApp({ config: testConfig(), logger: false });
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    const identity = await register("hostile_frame_rate");
    const client = await connect(address, identity);

    for (let index = 0; index <= MAX_FRAMES_PER_TEN_SECONDS; index += 1) {
      client.send({ type: "heartbeat", timestamp: new Date(index).toISOString() });
    }

    const limited = await client.waitFor((message) =>
      message.type === "error" && message.code === "RATE_LIMITED"
    );
    expect(limited.message).toBe("Too many realtime frames");
    expect(await within(client.closed)).toMatchObject({ code: 1008 });
    expect(client.messages.filter((message) => message.type === "heartbeat.ack").length)
      .toBeLessThanOrEqual(MAX_FRAMES_PER_TEN_SECONDS - 1);
    expect(app.luxora.metrics.render()).toContain(
      'luxora_realtime_guard_total{reason="frame_rate"} 1'
    );
  });

  it("does not register a ghost connection when verification finishes after socket close", async () => {
    app = await buildApp({ config: testConfig(), logger: false });
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    const identity = await register("hostile_delayed_verifier");
    const originalVerify = TokenSecurity.prototype.verifyAccessToken;
    let releaseVerification: (() => void) | undefined;
    let markVerificationStarted: (() => void) | undefined;
    const verificationGate = new Promise<void>((resolve) => {
      releaseVerification = resolve;
    });
    const verificationStarted = new Promise<void>((resolve) => {
      markVerificationStarted = resolve;
    });
    vi.spyOn(TokenSecurity.prototype, "verifyAccessToken").mockImplementation(async function (
      this: TokenSecurity,
      token: string
    ) {
      markVerificationStarted?.();
      await verificationGate;
      return originalVerify.call(this, token);
    });
    const sessionChecks = vi.spyOn(app.luxora.store, "isSessionActive");
    const client = await open(address);
    await client.waitFor((message) => message.type === "hello");
    client.send({ type: "authenticate", accessToken: identity.accessToken });
    await within(verificationStarted);
    for (let index = 0; index < 20; index += 1) {
      client.send({ type: "heartbeat", timestamp: new Date(index).toISOString() });
    }

    client.socket.close();
    await within(client.closed);
    releaseVerification?.();
    await delay(75);

    expect(sessionChecks).not.toHaveBeenCalled();
    expect(app.luxora.hub.isUserOnline(identity.id)).toBe(false);
    expect(client.messages.some((message) => message.type === "ready")).toBe(false);
    expect(app.luxora.metrics.render()).toContain("luxora_websocket_connections 0");
  });

  it("prevents rotating-chat typing floods while retaining a usable authenticated connection", async () => {
    app = await buildApp({ config: testConfig(), logger: false });
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    const actor = await register("hostile_typing_rate");
    const observer = await login(actor, "observer");
    const actorClient = await connect(address, actor);
    const observerClient = await connect(address, observer);
    const chatIds = Array.from(
      { length: MAX_TYPING_FRAMES_PER_FIVE_SECONDS + 1 },
      (_unused, index) => addSelfGroup(actor, index)
    );

    for (const chatId of chatIds) actorClient.send({ type: "typing.start", chatId });

    await actorClient.waitFor((message) =>
      message.type === "error" && message.code === "RATE_LIMITED"
    );
    for (let index = 0; index < MAX_TYPING_FRAMES_PER_FIVE_SECONDS; index += 1) {
      await observerClient.waitFor((message) => message.type === "typing.updated");
    }
    await delay(75);
    expect(observerClient.messages.filter((message) => message.type === "typing.updated")).toHaveLength(0);

    const heartbeatAt = new Date().toISOString();
    actorClient.send({ type: "heartbeat", timestamp: heartbeatAt });
    expect(await actorClient.waitFor((message) => message.type === "heartbeat.ack"))
      .toMatchObject({ timestamp: heartbeatAt });
    expect(app.luxora.metrics.render()).toContain(
      'luxora_realtime_guard_total{reason="typing_rate"} 1'
    );
  });

  it("prunes and deterministically caps per-chat typing throttle state", () => {
    const now = 50_000;
    const entries = new Map<string, number>();
    for (let index = 0; index < 100; index += 1) {
      entries.set(`chat-${String(index).padStart(3, "0")}`, now - (100 - index));
    }
    entries.set("expired", now - TYPING_TTL_MS);
    entries.set("future-clock", now + 1);

    compactTypingThrottleEntries(entries, now);

    expect(entries.size).toBe(MAX_TRACKED_TYPING_CHATS);
    expect([...entries.keys()].sort()).toEqual([
      "chat-092",
      "chat-093",
      "chat-094",
      "chat-095",
      "chat-096",
      "chat-097",
      "chat-098",
      "chat-099"
    ]);
    expect(shouldPublishTyping(entries, "chat-new", now)).toBe(true);
    expect(entries.size).toBe(MAX_TRACKED_TYPING_CHATS);
    expect(entries.has("chat-new")).toBe(true);
    expect(shouldPublishTyping(entries, "chat-new", now + TYPING_THROTTLE_MS - 1)).toBe(false);
    expect(shouldPublishTyping(entries, "chat-new", now + TYPING_THROTTLE_MS)).toBe(true);
  });

  it("evicts bounded pending queues and projected socket-buffer overflow with close 1013", async () => {
    app = await buildApp({ config: testConfig(), logger: false });
    const identity = await register("hostile_backpressure");
    const now = new Date().toISOString();
    const pendingSocket = new ControlledSocket();
    const pending: RealtimeConnection = {
      id: randomUUID(),
      userId: identity.id,
      sessionId: identity.sessionId,
      socket: pendingSocket as unknown as WebSocket,
      protocolVersion: 2,
      active: false,
      queue: [],
      lastAliveAt: Date.now(),
      lastTypingAtByChat: new Map()
    };
    app.luxora.hub.registerPending(pending);
    const queued: StoredEvent[] = Array.from({ length: MAX_PENDING_EVENTS + 1 }, (_unused, index) => ({
      sequence: index + 1,
      audienceUserId: identity.id,
      createdAt: now,
      event: {
        type: "relationship.block.changed",
        audience: "actor_account",
        accountId: randomUUID(),
        blocked: true,
        changedAt: now
      }
    }));

    app.luxora.hub.publish(queued);

    expect(pendingSocket.closes).toEqual([
      { code: 1013, reason: "Reconnect and synchronize" }
    ]);
    expect(pending.active).toBe(false);
    expect(pending.queue).toHaveLength(0);
    expect(pendingSocket.sent.map((item) => JSON.parse(item) as any)).toContainEqual(
      expect.objectContaining({ type: "sync.required", reason: "backpressure" })
    );
    app.luxora.hub.remove(pending);

    const unavailableStoreSocket = new ControlledSocket();
    const unavailableStore: RealtimeConnection = {
      ...pending,
      id: randomUUID(),
      socket: unavailableStoreSocket as unknown as WebSocket,
      queue: []
    };
    app.luxora.hub.registerPending(unavailableStore);
    const latestSequence = vi.spyOn(app.luxora.store, "getLatestSequence")
      .mockImplementationOnce(() => {
        throw new Error("synthetic sequence-store failure");
      });
    app.luxora.hub.publish(queued);
    latestSequence.mockRestore();
    expect(unavailableStoreSocket.sent).toHaveLength(0);
    expect(unavailableStoreSocket.closes).toEqual([
      { code: 1013, reason: "Reconnect and synchronize" }
    ]);
    expect(unavailableStore.queue).toHaveLength(0);
    app.luxora.hub.remove(unavailableStore);

    const slowSocket = new ControlledSocket();
    slowSocket.bufferedAmount = MAX_BUFFERED_BYTES - 8;
    const slow: RealtimeConnection = {
      id: randomUUID(),
      userId: identity.id,
      sessionId: identity.sessionId,
      socket: slowSocket as unknown as WebSocket,
      protocolVersion: 2,
      active: true,
      queue: [],
      lastAliveAt: Date.now(),
      lastTypingAtByChat: new Map()
    };
    app.luxora.hub.registerPending(slow);
    app.luxora.hub.publishEphemeral([identity.id], {
      type: "presence.updated",
      userId: identity.id,
      presence: "online",
      lastSeenAt: null
    });

    expect(slowSocket.closes).toEqual([
      { code: 1013, reason: "Client is too slow; reconnect and synchronize" }
    ]);
    expect(slow.active).toBe(false);
    expect(slow.queue).toHaveLength(0);
    expect(app.luxora.metrics.render()).toContain(
      'luxora_realtime_guard_total{reason="backpressure"} 3'
    );
  });

  it("caps concurrent sockets per device session and releases the slot on close", async () => {
    app = await buildApp({ config: testConfig(), logger: false });
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    const identity = await register("hostile_session_connections");
    const accepted: HostileRealtimeClient[] = [];
    for (let index = 0; index < MAX_CONNECTIONS_PER_SESSION; index += 1) {
      accepted.push(await connect(address, identity));
    }

    const rejected = await open(address);
    await rejected.waitFor((message) => message.type === "hello");
    rejected.send({ type: "authenticate", accessToken: identity.accessToken });
    await rejected.waitFor((message) => message.type === "error" && message.code === "RATE_LIMITED");
    expect(await within(rejected.closed)).toMatchObject({ code: 1013 });

    accepted[0]!.socket.close();
    await within(accepted[0]!.closed);
    await delay(25);
    const replacement = await connect(address, identity);
    expect(replacement.socket.readyState).toBe(WebSocket.OPEN);
    expect(app.luxora.metrics.render()).toContain(
      'luxora_realtime_guard_total{reason="session_connections"} 1'
    );
  });

  it("bounds per-IP authentication storms across reconnects without leaking pending slots", async () => {
    app = await buildApp({ config: testConfig(), logger: false });
    const address = await app.listen({ host: "127.0.0.1", port: 0 });

    for (let index = 0; index < MAX_AUTH_ATTEMPTS_PER_IP_PER_MINUTE; index += 1) {
      const client = await open(address, index % 2 === 0 ? "/v1/realtime" : "/v2/realtime");
      await client.waitFor((message) => message.type === "hello");
      client.send({ type: "authenticate", accessToken: `invalid-token-material-${index}` });
      expect(await within(client.closed)).toMatchObject({ code: 4001 });
    }

    const limited = await open(address);
    await limited.waitFor((message) => message.type === "hello");
    limited.send({ type: "authenticate", accessToken: "invalid-token-material-over-limit" });
    await limited.waitFor((message) => message.type === "error" && message.code === "RATE_LIMITED");
    expect(await within(limited.closed)).toMatchObject({ code: 1013 });

    // Failed reconnects released their concurrent pending slots: a fresh
    // connection can still complete the transport handshake. Only another
    // authentication attempt is temporarily rate-limited.
    const pending: HostileRealtimeClient[] = [];
    for (let index = 0; index < MAX_PENDING_CONNECTIONS_PER_IP; index += 1) {
      const client = await open(address, index % 2 === 0 ? "/v1/realtime" : "/v2/realtime");
      await client.waitFor((message) => message.type === "hello");
      pending.push(client);
    }
    const overflow = await open(address, "/v1/realtime");
    await overflow.waitFor((message) => message.type === "error" && message.code === "RATE_LIMITED");
    expect(await within(overflow.closed)).toMatchObject({ code: 1013 });
    expect(app.luxora.metrics.render()).toContain(
      'luxora_realtime_guard_total{reason="auth_rate"} 1'
    );
    expect(app.luxora.metrics.render()).toContain(
      'luxora_realtime_guard_total{reason="pending_connections"} 1'
    );
  });

  it("shares one canonical trusted-proxy authentication bucket across realtime V1 and V2", async () => {
    app = await buildApp({
      config: testConfig({ trustedProxyCidrs: ["127.0.0.1/32"] }),
      logger: false
    });
    const address = await app.listen({ host: "127.0.0.1", port: 0 });

    for (let index = 0; index < MAX_AUTH_ATTEMPTS_PER_IP_PER_MINUTE; index += 1) {
      const path = index % 2 === 0 ? "/v1/realtime" : "/v2/realtime";
      const canonicalClient = index % 2 === 0
        ? "2001:0DB8:0:0:0:0:0:44"
        : "2001:db8::44";
      const prependedSpoof = `192.0.2.${index + 1}`;
      const client = await open(address, path, `${prependedSpoof}, ${canonicalClient}`);
      await client.waitFor((message) => message.type === "hello");
      client.send({ type: "authenticate", accessToken: `invalid-proxied-token-${index}` });
      expect(await within(client.closed)).toMatchObject({ code: 4001 });
    }

    const limited = await open(
      address,
      "/v2/realtime",
      "203.0.113.200, 2001:db8::44"
    );
    await limited.waitFor((message) => message.type === "hello");
    limited.send({ type: "authenticate", accessToken: "invalid-proxied-token-over-limit" });
    await limited.waitFor((message) => message.type === "error" && message.code === "RATE_LIMITED");
    expect(await within(limited.closed)).toMatchObject({ code: 1013 });
    expect(app.luxora.metrics.render()).toContain(
      'luxora_realtime_guard_total{reason="auth_rate"} 1'
    );
  });
});
