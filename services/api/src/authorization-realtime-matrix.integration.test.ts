import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  Chat,
  ChatRole,
  DurableRealtimeEvent,
  Message,
  MessagePin,
  PublicProfile,
  Topic
} from "@luxora/protocol";
import WebSocket from "ws";
import type { LuxoraApp } from "./app.js";
import { buildApp } from "./app.js";
import { Metrics } from "./metrics.js";
import { RealtimeCursorCodec } from "./realtime/cursor.js";
import type { RealtimeConnection } from "./realtime/hub.js";
import { RealtimeHub } from "./realtime/hub.js";
import { establishAcceptedRelationship, testConfig } from "./test-helpers.js";

const PASSWORD = "correct horse battery staple";
const CONTENT_CANARY = "REALTIME_MATRIX_PRIVATE_CONTENT_CANARY";
const PROFILE_CANARY = "REALTIME_MATRIX_PRIVATE_PROFILE_CANARY";
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64"
);

const REALTIME_PATHS = [
  { path: "/v1/realtime", protocolVersion: 1 },
  { path: "/v2/realtime", protocolVersion: 2 }
] as const;

const CLIENT_COMMANDS = [
  "authenticate",
  "heartbeat",
  "typing.start",
  "typing.stop",
  "receipt.delivered",
  "receipt.read"
] as const;

const DURABLE_EVENT_BOUNDARIES = [
  "chat.created",
  "message.created",
  "message.updated",
  "message.deleted",
  "attachment.stored",
  "message.pinned",
  "message.unpinned",
  "topic.created",
  "topic.updated",
  "receipt.delivered",
  "receipt.read",
  "reaction.updated",
  "chat.member.changed:member_account",
  "chat.member.changed:removed_account",
  "chat.preferences.updated:member_account",
  "chat.folders.updated:actor_account",
  "chat.draft.changed:account_sessions",
  "sync.invalidated:account_projection",
  "relationship.request.created:sender_account",
  "relationship.request.created:recipient_account",
  "relationship.request.removed:recipient_account",
  "relationship.request.accepted:participant_account",
  "relationship.request.expired:participant_account",
  "relationship.block.changed:actor_account",
  "safety.report.submitted:actor_account"
] as const;

interface Identity {
  id: string;
  username: string;
  accessToken: string;
  sessionId: string;
}

class MatrixRealtimeClient {
  readonly messages: any[] = [];
  readonly closed: Promise<{ code: number; reason: string }>;

  constructor(readonly socket: WebSocket) {
    socket.on("message", (raw) => this.messages.push(JSON.parse(raw.toString()) as unknown));
    this.closed = new Promise((resolve) => socket.once("close", (code, reason) => resolve({
      code,
      reason: reason.toString("utf8")
    })));
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

function schemaBlock(source: string, start: string, end: string): string {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from + start.length);
  if (from < 0 || to < 0) throw new Error(`Could not locate schema block ${start}`);
  return source.slice(from, to);
}

function typeLiterals(source: string): string[] {
  return [...source.matchAll(/type:\s*z\.literal\("([^"]+)"\)/gu)].map((match) => match[1] as string);
}

describe("complete realtime authorization matrix", () => {
  let app: LuxoraApp | undefined;
  const sockets: WebSocket[] = [];

  afterEach(async () => {
    for (const socket of sockets) socket.close();
    sockets.length = 0;
    await app?.close();
    app = undefined;
  });

  async function register(username: string, displayName = username): Promise<Identity> {
    const response = await app!.inject({
      method: "POST",
      url: "/v1/auth/register",
      payload: { username, displayName, password: PASSWORD }
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

  function createRoleChat(
    kind: "group" | "channel",
    title: string,
    members: Array<{ identity: Identity; role: ChatRole }>
  ): string {
    const id = randomUUID();
    const now = new Date().toISOString();
    app!.luxora.store.createChat({
      id,
      kind,
      title,
      directKey: null,
      createdBy: members[0]!.identity.id,
      createdAt: now
    });
    for (const member of members) {
      app!.luxora.store.addChatMember(id, member.identity.id, member.role, now);
    }
    return id;
  }

  async function send(identity: Identity, chatId: string, body: string): Promise<Message> {
    const response = await app!.inject({
      method: "POST",
      url: `/v1/chats/${chatId}/messages`,
      headers: auth(identity),
      payload: { body, clientNonce: randomUUID() }
    });
    expect(response.statusCode).toBe(201);
    return response.json().message as Message;
  }

  async function open(address: string, path: "/v1/realtime" | "/v2/realtime"): Promise<MatrixRealtimeClient> {
    const socket = new WebSocket(`${address.replace("http", "ws")}${path}`);
    sockets.push(socket);
    const client = new MatrixRealtimeClient(socket);
    await new Promise<void>((resolve, reject) => {
      socket.once("open", resolve);
      socket.once("error", reject);
    });
    return client;
  }

  async function connect(
    address: string,
    path: "/v1/realtime" | "/v2/realtime",
    identity: Identity
  ): Promise<MatrixRealtimeClient> {
    const client = await open(address, path);
    const hello = await client.waitFor((message) => message.type === "hello");
    expect(hello.protocolVersion).toBe(path === "/v1/realtime" ? 1 : 2);
    client.send({ type: "authenticate", accessToken: identity.accessToken });
    await client.waitFor((message) => message.type === "ready");
    return client;
  }

  it("keeps both dynamic WS registrations, all client commands, and every durable event branch inventoried", () => {
    const routes = readFileSync(new URL("./realtime/routes.ts", import.meta.url), "utf8");
    const protocol = readFileSync(new URL("../../../packages/protocol/src/index.ts", import.meta.url), "utf8");
    const registeredPaths = [...routes.matchAll(/registerRealtimeRoute\(app,\s*"([^"]+)",\s*(\d)/gu)]
      .map((match) => ({ path: match[1], protocolVersion: Number(match[2]) }));
    const commandTypes = typeLiterals(schemaBlock(
      protocol,
      "export const ClientRealtimeMessageSchema",
      "export type ApiErrorCode"
    ));
    const realtimeEvents = typeLiterals(schemaBlock(
      protocol,
      "export const RealtimeEventSchema",
      "export const DurableRealtimeEventSchema"
    ));
    const identityEvents = typeLiterals(schemaBlock(
      protocol,
      "const RelationshipRequestCreatedForSenderEventSchema",
      "export const RealtimeEventSchema"
    ));

    expect(registeredPaths).toEqual(REALTIME_PATHS);
    expect([...new Set(commandTypes)]).toEqual(CLIENT_COMMANDS);
    expect([...new Set([...realtimeEvents, ...identityEvents])].sort()).toEqual([
      ...new Set(DURABLE_EVENT_BOUNDARIES.map((entry) => entry.split(":")[0]))
    ].sort());
    expect(DURABLE_EVENT_BOUNDARIES).toHaveLength(25);
  });

  it("rejects every pre-authentication client command and invalid authenticate frame on both protocols", async () => {
    app = await buildApp({ config: testConfig(), logger: false });
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    const sequenceBefore = app.luxora.store.getLatestSequence();
    const timestamp = new Date().toISOString();
    const unauthenticatedCommands = [
      { type: "heartbeat", timestamp },
      { type: "typing.start", chatId: randomUUID() },
      { type: "typing.stop", chatId: randomUUID() },
      { type: "receipt.delivered", chatId: randomUUID(), messageId: randomUUID() },
      { type: "receipt.read", chatId: randomUUID(), messageId: randomUUID() }
    ];

    for (const endpoint of REALTIME_PATHS) {
      for (const command of unauthenticatedCommands) {
        const client = await open(address, endpoint.path);
        await client.waitFor((message) => message.type === "hello");
        client.send(command);
        const error = await client.waitFor((message) => message.type === "error");
        expect(error).toMatchObject({ code: "UNAUTHENTICATED" });
        expect(JSON.stringify(error)).not.toContain(command.chatId ?? "never-present");
        expect(await client.closed).toMatchObject({ code: 4001 });
      }

      const invalid = await open(address, endpoint.path);
      await invalid.waitFor((message) => message.type === "hello");
      invalid.send({ type: "authenticate", accessToken: `invalid.${PROFILE_CANARY}.${CONTENT_CANARY}` });
      const error = await invalid.waitFor((message) => message.type === "error");
      expect(error).toMatchObject({ code: "UNAUTHENTICATED" });
      expect(JSON.stringify(error)).not.toContain(PROFILE_CANARY);
      expect(JSON.stringify(error)).not.toContain(CONTENT_CANARY);
      expect(invalid.messages.some((message) => message.type === "ready")).toBe(false);
      expect(await invalid.closed).toMatchObject({ code: 4001 });
    }
    expect(app.luxora.store.getLatestSequence()).toBe(sequenceBefore);
  });

  it("enforces membership, nested message scope, and current group/channel command policy", async () => {
    app = await buildApp({ config: testConfig(), logger: false });
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    const owner = await register("rt_matrix_owner");
    const admin = await register("rt_matrix_admin");
    const member = await register("rt_matrix_member");
    const outsider = await register("rt_matrix_outsider", PROFILE_CANARY);
    const roleMembers: Array<{ identity: Identity; role: ChatRole }> = [
      { identity: owner, role: "owner" },
      { identity: admin, role: "admin" },
      { identity: member, role: "member" }
    ];
    const groupId = createRoleChat("group", "Realtime group", roleMembers);
    const channelId = createRoleChat("channel", "Realtime channel", roleMembers);
    const foreignChatId = createRoleChat("group", "Foreign realtime chat", [
      { identity: outsider, role: "owner" }
    ]);
    const groupMessage = await send(owner, groupId, "group receipt target");
    const channelMessage = await send(owner, channelId, "channel receipt target");
    const foreignMessage = await send(outsider, foreignChatId, CONTENT_CANARY);
    const ownerClient = await connect(address, "/v2/realtime", owner);
    const memberClient = await connect(address, "/v2/realtime", member);
    const outsiderClient = await connect(address, "/v2/realtime", outsider);

    const denied: Array<{ name: string; command: Record<string, unknown>; code: string }> = [
      {
        name: "foreign typing start",
        command: { type: "typing.start", chatId: foreignChatId },
        code: "FORBIDDEN"
      },
      {
        name: "foreign typing stop",
        command: { type: "typing.stop", chatId: foreignChatId },
        code: "FORBIDDEN"
      },
      {
        name: "foreign delivered",
        command: { type: "receipt.delivered", chatId: foreignChatId, messageId: foreignMessage.id },
        code: "FORBIDDEN"
      },
      {
        name: "foreign read",
        command: { type: "receipt.read", chatId: foreignChatId, messageId: foreignMessage.id },
        code: "FORBIDDEN"
      },
      {
        name: "cross-chat delivered",
        command: { type: "receipt.delivered", chatId: groupId, messageId: channelMessage.id },
        code: "NOT_FOUND"
      },
      {
        name: "cross-chat read",
        command: { type: "receipt.read", chatId: groupId, messageId: channelMessage.id },
        code: "NOT_FOUND"
      }
    ];

    for (const probe of denied) {
      const sequenceBefore = app.luxora.store.getLatestSequence();
      memberClient.send(probe.command);
      const error = await memberClient.waitFor((message) => message.type === "error");
      expect(error.code, probe.name).toBe(probe.code);
      const serialized = JSON.stringify(error);
      expect(serialized, probe.name).not.toContain(CONTENT_CANARY);
      expect(serialized, probe.name).not.toContain(PROFILE_CANARY);
      expect(serialized, probe.name).not.toContain(foreignChatId);
      expect(serialized, probe.name).not.toContain(foreignMessage.id);
      expect(app.luxora.store.getLatestSequence(), probe.name).toBe(sequenceBefore);
    }

    outsiderClient.send({ type: "typing.start", chatId: groupId });
    const outsiderError = await outsiderClient.waitFor((message) => message.type === "error");
    expect(outsiderError.code).toBe("FORBIDDEN");
    await ownerClient.expectNoMatch((message) =>
      message.type === "typing.updated" && message.userId === outsider.id
    );

    memberClient.send({ type: "typing.start", chatId: channelId });
    const typingStart = await ownerClient.waitFor((message) =>
      message.type === "typing.updated" &&
      message.chatId === channelId &&
      message.userId === member.id &&
      message.isTyping === true
    );
    expect(typingStart.expiresAt).toBeTypeOf("string");
    await new Promise((resolve) => setTimeout(resolve, 850));
    memberClient.send({ type: "typing.stop", chatId: channelId });
    await ownerClient.waitFor((message) =>
      message.type === "typing.updated" &&
      message.chatId === channelId &&
      message.userId === member.id &&
      message.isTyping === false
    );

    memberClient.send({
      type: "receipt.delivered",
      chatId: groupId,
      messageId: groupMessage.id
    });
    const delivered = await ownerClient.waitFor((message) =>
      message.type === "dispatch" &&
      message.event.type === "receipt.delivered" &&
      message.event.messageId === groupMessage.id &&
      message.event.userId === member.id
    );
    expect(delivered.event.chatId).toBe(groupId);

    memberClient.send({
      type: "receipt.read",
      chatId: channelId,
      messageId: channelMessage.id
    });
    const read = await ownerClient.waitFor((message) =>
      message.type === "dispatch" &&
      message.event.type === "receipt.read" &&
      message.event.messageId === channelMessage.id &&
      message.event.userId === member.id
    );
    expect(read.event.chatId).toBe(channelId);
  });

  it("rejects Direct typing and receipt commands after either-direction block without side effects", async () => {
    app = await buildApp({ config: testConfig(), logger: false });
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    const alice = await register("rt_matrix_direct_alice");
    const bob = await register("rt_matrix_direct_bob", PROFILE_CANARY);
    const directId = await establishAcceptedRelationship(app, alice, bob);
    const message = await send(alice, directId, CONTENT_CANARY);
    const aliceClient = await connect(address, "/v2/realtime", alice);
    const bobClient = await connect(address, "/v2/realtime", bob);

    expect((await app.inject({
      method: "PUT",
      url: `/v1/blocks/${bob.id}`,
      headers: auth(alice)
    })).statusCode).toBe(200);
    const deniedCommands = [
      { type: "typing.start", chatId: directId },
      { type: "typing.stop", chatId: directId },
      { type: "receipt.delivered", chatId: directId, messageId: message.id },
      { type: "receipt.read", chatId: directId, messageId: message.id }
    ];

    for (const command of deniedCommands) {
      const sequenceBefore = app.luxora.store.getLatestSequence();
      aliceClient.send(command);
      const error = await aliceClient.waitFor((candidate) => candidate.type === "error");
      expect(error.code).toBe("FORBIDDEN");
      expect(JSON.stringify(error)).not.toContain(CONTENT_CANARY);
      expect(JSON.stringify(error)).not.toContain(PROFILE_CANARY);
      expect(app.luxora.store.getLatestSequence()).toBe(sequenceBefore);
      await bobClient.expectNoMatch((candidate) =>
        candidate.type === "typing.updated" ||
        (candidate.type === "dispatch" && ["receipt.delivered", "receipt.read"].includes(candidate.event.type))
      );
    }
  });

  it("filters every chat-scoped durable event for an outsider while preserving member delivery", async () => {
    app = await buildApp({ config: testConfig(), logger: false });
    const owner = await register("rt_event_owner");
    const member = await register("rt_event_member");
    const outsider = await register("rt_event_outsider", PROFILE_CANARY);
    const chatId = createRoleChat("group", "Event matrix", [
      { identity: owner, role: "owner" },
      { identity: member, role: "member" }
    ]);
    const message = await send(owner, chatId, CONTENT_CANARY);
    const chatResponse = await app.inject({ method: "GET", url: `/v1/chats/${chatId}`, headers: auth(member) });
    expect(chatResponse.statusCode).toBe(200);
    const chat = chatResponse.json().chat as Chat;
    const topicResponse = await app.inject({
      method: "POST",
      url: `/v1/chats/${chatId}/topics`,
      headers: auth(owner),
      payload: { title: "Event topic" }
    });
    expect(topicResponse.statusCode).toBe(201);
    const topic = topicResponse.json().topic as Topic;
    const pinResponse = await app.inject({
      method: "PUT",
      url: `/v1/chats/${chatId}/pins/${message.id}`,
      headers: auth(owner)
    });
    expect(pinResponse.statusCode).toBe(200);
    const pin = pinResponse.json().pin as MessagePin;
    const now = new Date().toISOString();
    const events: DurableRealtimeEvent[] = [
      { type: "chat.created", chat },
      { type: "message.created", message },
      { type: "message.updated", message },
      { type: "message.deleted", message },
      { type: "message.pinned", pin },
      { type: "message.unpinned", chatId, messageId: message.id },
      { type: "topic.created", topic },
      { type: "topic.updated", topic },
      { type: "receipt.delivered", chatId, userId: owner.id, messageId: message.id, deliveredAt: now },
      { type: "receipt.read", chatId, userId: owner.id, messageId: message.id, readAt: now },
      {
        type: "reaction.updated",
        chatId,
        messageId: message.id,
        reactions: [],
        actorUserId: owner.id
      }
    ];
    expect(events).toHaveLength(11);

    const makeSocket = () => {
      const sent: any[] = [];
      const socket = {
        readyState: WebSocket.OPEN,
        bufferedAmount: 0,
        send: vi.fn((raw: string) => sent.push(JSON.parse(raw) as unknown)),
        close: vi.fn()
      } as unknown as WebSocket;
      return { socket, sent };
    };
    const hub = new RealtimeHub(
      app.luxora.store,
      new Metrics(),
      new RealtimeCursorCodec(testConfig().jwtSecret)
    );
    const memberSocket = makeSocket();
    const ownerSocket = makeSocket();
    const outsiderSocket = makeSocket();
    const connection = (
      identity: Identity,
      socket: WebSocket
    ): RealtimeConnection => ({
      id: randomUUID(),
      userId: identity.id,
      sessionId: identity.sessionId,
      socket,
      protocolVersion: 2,
      active: true,
      queue: [],
      lastAliveAt: Date.now(),
      lastTypingAtByChat: new Map()
    });
    hub.registerPending(connection(member, memberSocket.socket));
    hub.registerPending(connection(owner, ownerSocket.socket));
    hub.registerPending(connection(outsider, outsiderSocket.socket));
    memberSocket.sent.length = 0;
    ownerSocket.sent.length = 0;
    outsiderSocket.sent.length = 0;

    for (const [index, event] of events.entries()) {
      memberSocket.sent.length = 0;
      outsiderSocket.sent.length = 0;
      hub.publish([{
        sequence: 10_000 + index,
        audienceUserId: member.id,
        event,
        createdAt: now
      }]);
      expect(memberSocket.sent.some((message) =>
        message.type === "dispatch" && message.event.type === event.type
      ), event.type).toBe(true);

      hub.publish([{
        sequence: 20_000 + index,
        audienceUserId: outsider.id,
        event,
        createdAt: now
      }]);
      expect(outsiderSocket.sent.some((message) => message.type === "dispatch"), event.type).toBe(false);
      expect(JSON.stringify(outsiderSocket.sent), event.type).not.toContain(CONTENT_CANARY);
      expect(JSON.stringify(outsiderSocket.sent), event.type).not.toContain(owner.id);
    }

    const preferenceEvent: DurableRealtimeEvent = {
      type: "chat.preferences.updated",
      audience: "member_account",
      accountId: member.id,
      chatId,
      preferences: { archivedAt: now, mutedUntil: null },
      changedAt: now
    };
    memberSocket.sent.length = 0;
    ownerSocket.sent.length = 0;
    hub.publish([{
      sequence: 30_000,
      audienceUserId: member.id,
      event: preferenceEvent,
      createdAt: now
    }]);
    expect(memberSocket.sent.some((message) =>
      message.type === "dispatch" && message.event.type === preferenceEvent.type
    )).toBe(true);
    hub.publish([{
      sequence: 30_001,
      audienceUserId: owner.id,
      event: preferenceEvent,
      createdAt: now
    }]);
    expect(ownerSocket.sent.some((message) => message.type === "dispatch")).toBe(false);

    const folderEvent: DurableRealtimeEvent = {
      type: "chat.folders.updated",
      audience: "actor_account",
      accountId: member.id,
      stateRevision: 7,
      changedAt: now
    };
    memberSocket.sent.length = 0;
    ownerSocket.sent.length = 0;
    outsiderSocket.sent.length = 0;
    hub.publish([{
      sequence: 31_000,
      audienceUserId: member.id,
      event: folderEvent,
      createdAt: now
    }]);
    expect(memberSocket.sent.find((message) =>
      message.type === "dispatch" && message.event.type === folderEvent.type
    )?.event).toEqual(folderEvent);
    hub.publish([{
      sequence: 31_001,
      audienceUserId: owner.id,
      event: folderEvent,
      createdAt: now
    }]);
    hub.publish([{
      sequence: 31_002,
      audienceUserId: outsider.id,
      event: folderEvent,
      createdAt: now
    }]);
    expect(ownerSocket.sent.some((message) => message.type === "dispatch")).toBe(false);
    expect(outsiderSocket.sent.some((message) => message.type === "dispatch")).toBe(false);
    hub.closeAll();
  });

  it("routes attachment and identity durable events only to their declared current account audiences", async () => {
    const key = Buffer.alloc(32, 113).toString("base64url");
    app = await buildApp({
      config: testConfig({ dataEncryptionKeys: { matrix: key }, activeDataEncryptionKeyId: "matrix" }),
      logger: false
    });
    const alice = await register("rt_actor_alice");
    const bob = await register("rt_actor_bob", PROFILE_CANARY);
    const eve = await register("rt_actor_eve");
    const mallory = await register("rt_actor_mallory");
    const preferencesChatId = createRoleChat("group", "Private preferences", [
      { identity: alice, role: "owner" },
      { identity: bob, role: "member" }
    ]);
    expect((await app.inject({
      method: "PATCH",
      url: `/v1/chats/${preferencesChatId}/preferences`,
      headers: auth(alice),
      payload: { archived: true }
    })).statusCode).toBe(200);

    const folderCreation = await app.inject({
      method: "POST",
      url: "/v1/chat-folders",
      headers: auth(alice),
      payload: {
        title: "Replay-only folder",
        rules: {
          includeKinds: ["group"],
          unreadOnly: false,
          excludeMuted: false,
          includeArchived: false
        },
        overrides: [],
        clientNonce: randomUUID()
      }
    });
    expect(folderCreation.statusCode).toBe(201);
    const folderStateRevision = folderCreation.json().stateRevision as number;

    const upload = await app.inject({
      method: "POST",
      url: "/v1/uploads",
      headers: auth(alice),
      payload: {
        kind: "image",
        fileName: "event-owner-only.png",
        mimeType: "image/png",
        sizeBytes: PNG.length,
        sha256: createHash("sha256").update(PNG).digest("hex"),
        idempotencyKey: randomUUID(),
        metadata: {}
      }
    });
    expect(upload.statusCode).toBe(201);
    const uploadId = upload.json().upload.id as string;
    const digest = createHash("sha256").update(PNG).digest("hex");
    expect((await app.inject({
      method: "PUT",
      url: `/v1/uploads/${uploadId}/chunks/0`,
      headers: {
        ...auth(alice),
        "content-type": "application/octet-stream",
        "content-range": `bytes 0-${PNG.length - 1}/${PNG.length}`,
        "content-length": String(PNG.length),
        "x-chunk-sha256": digest
      },
      payload: PNG
    })).statusCode).toBe(200);
    expect((await app.inject({
      method: "POST",
      url: `/v1/uploads/${uploadId}/complete`,
      headers: auth(alice)
    })).statusCode).toBe(200);

    const dismissedRequest = await app.inject({
      method: "POST",
      url: "/v1/message-requests",
      headers: auth(alice),
      payload: { recipientUserId: bob.id, body: CONTENT_CANARY, clientNonce: randomUUID() }
    });
    expect(dismissedRequest.statusCode).toBe(201);
    expect((await app.inject({
      method: "DELETE",
      url: `/v1/message-requests/${dismissedRequest.json().request.id as string}`,
      headers: auth(bob)
    })).statusCode).toBe(204);

    const acceptedRequest = await app.inject({
      method: "POST",
      url: "/v1/message-requests",
      headers: auth(alice),
      payload: { recipientUserId: eve.id, body: "accepted event", clientNonce: randomUUID() }
    });
    expect(acceptedRequest.statusCode).toBe(201);
    expect((await app.inject({
      method: "POST",
      url: `/v1/message-requests/${acceptedRequest.json().request.id as string}/accept`,
      headers: auth(eve)
    })).statusCode).toBe(200);

    const bobUser = app.luxora.store.findUserById(bob.id)!;
    const eveUser = app.luxora.store.findUserById(eve.id)!;
    const publicProfile = (user: typeof bobUser): PublicProfile => ({
      id: user.id,
      username: user.username,
      displayName: user.displayName,
      bio: user.bio,
      avatarUrl: user.avatarUrl
    });
    const expiredAt = new Date(Date.now() - 60_000).toISOString();
    app.luxora.store.createMessageRequest({
      id: randomUUID(),
      pairKey: [bob.id, eve.id].sort().join(":"),
      senderId: bob.id,
      recipientId: eve.id,
      clientNonce: randomUUID(),
      body: "expired event",
      linkUrl: null,
      senderProfile: publicProfile(bobUser),
      recipientProfile: publicProfile(eveUser),
      createdAt: expiredAt,
      expiresAt: expiredAt
    });
    expect((await app.inject({
      method: "GET",
      url: "/v1/message-requests?direction=outgoing",
      headers: auth(bob)
    })).statusCode).toBe(200);

    expect((await app.inject({
      method: "PUT",
      url: `/v1/blocks/${bob.id}`,
      headers: auth(alice)
    })).statusCode).toBe(200);
    expect((await app.inject({
      method: "POST",
      url: "/v1/safety/reports",
      headers: auth(alice),
      payload: {
        subjectAccountId: bob.id,
        category: "other",
        evidence: [],
        comment: CONTENT_CANARY,
        clientNonce: randomUUID(),
        alsoBlock: false
      }
    })).statusCode).toBe(201);

    const head = app.luxora.store.getLatestSequence();
    const eventsFor = (identity: Identity) => app!.luxora.store.replayEvents(identity.id, 0, head, 500);
    const aliceEvents = eventsFor(alice);
    const bobEvents = eventsFor(bob);
    const eveEvents = eventsFor(eve);
    const malloryEvents = eventsFor(mallory);
    const boundaryKey = (event: DurableRealtimeEvent): string => {
      if ("audience" in event) return `${event.type}:${event.audience}`;
      return event.type;
    };
    const observed = new Set([...aliceEvents, ...bobEvents, ...eveEvents].map(({ event }) => boundaryKey(event)));
    for (const expected of DURABLE_EVENT_BOUNDARIES.filter((entry) =>
      entry === "attachment.stored" || entry.startsWith("chat.preferences.") ||
      entry.startsWith("chat.folders.") ||
      entry.startsWith("relationship.") || entry.startsWith("safety.")
    )) {
      expect(observed.has(expected), expected).toBe(true);
    }
    const folderReplay = aliceEvents
      .map(({ event }) => event)
      .filter((event) => event.type === "chat.folders.updated");
    expect(folderReplay).toHaveLength(1);
    expect(folderReplay[0]).toMatchObject({
      type: "chat.folders.updated",
      audience: "actor_account",
      accountId: alice.id,
      stateRevision: folderStateRevision
    });
    expect([...bobEvents, ...eveEvents, ...malloryEvents].some(({ event }) =>
      event.type === "chat.folders.updated"
    )).toBe(false);
    expect(malloryEvents).toEqual([]);
    expect(JSON.stringify(malloryEvents)).not.toContain(CONTENT_CANARY);
    expect(JSON.stringify(malloryEvents)).not.toContain(PROFILE_CANARY);
    expect(bobEvents.some(({ event }) =>
      event.type === "chat.preferences.updated" || event.type === "chat.folders.updated" ||
      event.type === "relationship.block.changed" || event.type === "safety.report.submitted"
    )).toBe(false);
    expect(JSON.stringify(bobEvents.filter(({ event }) =>
      event.type === "chat.preferences.updated" || event.type === "chat.folders.updated" ||
      event.type === "relationship.block.changed" || event.type === "safety.report.submitted"
    ))).not.toContain(CONTENT_CANARY);
  });
});
