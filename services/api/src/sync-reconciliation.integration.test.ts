import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ChatFolderListResponseSchema,
  REALTIME_CURSOR_TTL_SECONDS,
  REALTIME_MAX_REPLAY_EVENTS,
  RealtimeSnapshotResponseSchema
} from "@luxora/protocol";
import WebSocket from "ws";
import type { LuxoraApp } from "./app.js";
import { buildApp } from "./app.js";
import { RealtimeCursorCodec } from "./realtime/cursor.js";
import { establishAcceptedRelationship, testConfig } from "./test-helpers.js";

const PASSWORD = "correct horse battery staple";

interface Identity {
  id: string;
  username: string;
  accessToken: string;
  sessionId: string;
}

class RealtimeClient {
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

describe("v2 realtime reconciliation", () => {
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
    path: "/v1/realtime" | "/v2/realtime" = "/v2/realtime"
  ): Promise<RealtimeClient> {
    const socket = new WebSocket(`${address.replace("http", "ws")}${path}`);
    sockets.push(socket);
    const client = new RealtimeClient(socket);
    await new Promise<void>((resolve, reject) => {
      socket.once("open", resolve);
      socket.once("error", reject);
    });
    const hello = await client.waitFor((message) => message.type === "hello");
    expect(hello.protocolVersion).toBe(path === "/v1/realtime" ? 1 : 2);
    return client;
  }

  async function connect(
    address: string,
    identity: Identity,
    resume: { resumeCursor?: string; resumeFrom?: number } = {}
  ): Promise<{ client: RealtimeClient; ready: any }> {
    const client = await open(address);
    client.send({ type: "authenticate", accessToken: identity.accessToken, ...resume });
    const ready = await client.waitFor((message) => message.type === "ready");
    return { client, ready };
  }

  async function expectSyncRequired(
    address: string,
    identity: Identity,
    resumeCursor: string,
    reason: string
  ): Promise<RealtimeClient> {
    const { client, ready } = await connect(address, identity, { resumeCursor });
    expect(ready).toMatchObject({ resumed: false, cursor: null });
    const required = await client.waitFor((message) => message.type === "sync.required");
    expect(required).toMatchObject({
      reason,
      recovery: { type: "http_snapshot", path: "/v2/sync/snapshot" }
    });
    expect(await client.closed).toMatchObject({ code: 4009 });
    expect(client.messages.some((message) => message.type === "dispatch")).toBe(false);
    return client;
  }

  async function snapshot(identity: Identity): Promise<any> {
    const response = await app!.inject({
      method: "GET",
      url: "/v2/sync/snapshot",
      headers: auth(identity)
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("private, no-store");
    expect(response.headers.pragma).toBe("no-cache");
    return RealtimeSnapshotResponseSchema.parse(response.json());
  }

  it("returns an idempotent authoritative boundary and resumes without sequence adjacency", async () => {
    app = await buildApp({ config: testConfig(), logger: false });
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    const alice = await register("sync_boundary_alice");

    const unauthenticated = await app.inject({ method: "GET", url: "/v2/sync/snapshot" });
    expect(unauthenticated.statusCode).toBe(401);
    expect(unauthenticated.headers["cache-control"]).toBe("private, no-store");

    const first = await snapshot(alice);
    const second = await snapshot(alice);
    expect(second.boundary.sequence).toBe(first.boundary.sequence);
    expect(second.reset).toEqual(first.reset);
    expect(second.resources).toEqual(first.resources);
    expect(second.reset.collections).toHaveLength(12);
    expect(new Set(second.reset.collections).size).toBe(12);
    expect(second.reset.collections).toContain("chat_folders");
    expect(second.resources.chatFolders).toBe("/v1/chat-folders");
    expect(second.resume.sequenceAdjacencyRequired).toBe(false);
    expect(JSON.stringify(second)).not.toContain("messageSnippet");

    const { client, ready } = await connect(address, alice, {
      resumeCursor: second.boundary.cursor
    });
    expect(ready).toMatchObject({
      resumed: true,
      resumeMode: "scoped_cursor",
      sequence: second.boundary.sequence,
      headSequence: second.boundary.sequence
    });
    const checkpoint = await client.waitFor((message) => message.type === "sync.checkpoint");
    expect(checkpoint.sequence).toBe(second.boundary.sequence);
    await client.expectNoMatch((message) => message.type === "dispatch");

    client.socket.close();
    await client.closed;
    const repeated = await connect(address, alice, { resumeCursor: checkpoint.cursor as string });
    await repeated.client.waitFor((message) => message.type === "sync.checkpoint");
    await repeated.client.expectNoMatch((message) => message.type === "dispatch");
  });

  it("replays profile projection invalidation only to exact v2 accounts and skips v1", async () => {
    app = await buildApp({ config: testConfig(), logger: false });
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    const subject = await register("sync_profile_subject");
    const observer = await register("sync_profile_observer");
    const outsider = await register("sync_profile_outsider");

    const chatId = randomUUID();
    const createdAt = new Date().toISOString();
    app.luxora.store.createChat({
      id: chatId,
      kind: "group",
      title: "Historical author projection",
      directKey: null,
      createdBy: observer.id,
      createdAt
    });
    app.luxora.store.addChatMember(chatId, observer.id, "owner", createdAt);
    app.luxora.store.addChatMember(chatId, subject.id, "member", createdAt);
    const authored = await app.inject({
      method: "POST",
      url: `/v1/chats/${chatId}/messages`,
      headers: auth(subject),
      payload: { body: "historical profile projection", clientNonce: randomUUID() }
    });
    expect(authored.statusCode, authored.body).toBe(201);
    const subjectMembership = app.luxora.store.getChatMember(chatId, subject.id);
    expect(subjectMembership).not.toBeNull();
    expect(app.luxora.store.removeChatMember(
      chatId,
      subject.id,
      subjectMembership!.revision,
      new Date(Date.now() + 1_000).toISOString()
    )).not.toBeNull();
    expect(app.luxora.store.getChatMember(chatId, subject.id)).toBeNull();

    const observerBoundary = await snapshot(observer);
    const boundarySequence = observerBoundary.boundary.sequence as number;
    const subjectLive = await connect(address, subject);
    await subjectLive.client.waitFor((message) => message.type === "sync.checkpoint");
    const legacyObserver = await open(address, "/v1/realtime");
    legacyObserver.send({ type: "authenticate", accessToken: observer.accessToken });
    await legacyObserver.waitFor((message) => message.type === "ready");

    const update = await app.inject({
      method: "PATCH",
      url: "/v1/me",
      headers: auth(subject),
      payload: { displayName: "Renamed Historical Author" }
    });
    expect(update.statusCode, update.body).toBe(200);
    const liveInvalidation = await subjectLive.client.waitFor((message) =>
      message.type === "dispatch" && message.event.type === "sync.invalidated"
    );
    expect(liveInvalidation.event).toMatchObject({
      type: "sync.invalidated",
      audience: "account_projection",
      accountId: subject.id,
      reason: "profile_updated"
    });
    await legacyObserver.expectNoMatch((message) =>
      message.type === "dispatch" && message.event?.type === "sync.invalidated"
    );

    const serviceHead = app.luxora.store.getLatestSequence();
    const observerEvents = app.luxora.store.replayEvents(
      observer.id,
      boundarySequence,
      serviceHead,
      100
    );
    expect(observerEvents.map(({ event }) => event)).toEqual([
      expect.objectContaining({
        type: "sync.invalidated",
        audience: "account_projection",
        accountId: observer.id,
        reason: "profile_updated"
      })
    ]);
    expect(app.luxora.store.replayEvents(
      outsider.id,
      boundarySequence,
      serviceHead,
      100
    )).toEqual([]);

    const offlineReplay = await connect(address, observer, {
      resumeCursor: observerBoundary.boundary.cursor as string
    });
    const replayedInvalidation = await offlineReplay.client.waitFor((message) =>
      message.type === "dispatch" && message.event.type === "sync.invalidated"
    );
    expect(replayedInvalidation).toMatchObject({
      event: { accountId: observer.id, reason: "profile_updated" }
    });
    await offlineReplay.client.waitFor((message) => message.type === "sync.checkpoint");

    const messages = await app.inject({
      method: "GET",
      url: `/v1/chats/${chatId}/messages`,
      headers: auth(observer)
    });
    expect(messages.statusCode, messages.body).toBe(200);
    expect(messages.json().items[0].sender.displayName).toBe("Renamed Historical Author");

    const beforeNoop = app.luxora.store.getLatestSequence();
    const noop = await app.inject({
      method: "PATCH",
      url: "/v1/me",
      headers: auth(subject),
      payload: { displayName: "Renamed Historical Author" }
    });
    expect(noop.statusCode).toBe(200);
    expect(app.luxora.store.getLatestSequence()).toBe(beforeNoop);

    const mismatchAt = new Date().toISOString();
    const mismatched = app.luxora.store.appendEvent(subject.id, {
      type: "sync.invalidated",
      audience: "account_projection",
      accountId: observer.id,
      reason: "profile_updated",
      changedAt: mismatchAt
    }, mismatchAt);
    app.luxora.hub.publish([mismatched]);
    await subjectLive.client.expectNoMatch((message) =>
      message.type === "dispatch" && message.sequence === mismatched.sequence
    );
  });

  it("rebuilds chat folders only for the authenticated account and active session", async () => {
    app = await buildApp({
      config: testConfig({
        dataEncryptionKeys: {
          reconciliation_folders: Buffer.alloc(32, 17).toString("base64url")
        },
        activeDataEncryptionKeyId: "reconciliation_folders"
      }),
      logger: false
    });
    const alice = await register("sync_folders_alice");
    const bob = await register("sync_folders_bob");
    const aliceCanary = "ALICE_PRIVATE_SYNC_FOLDER";
    const bobCanary = "BOB_PRIVATE_SYNC_FOLDER";
    const rules = {
      includeKinds: ["direct", "group", "channel"],
      unreadOnly: false,
      excludeMuted: true,
      includeArchived: false
    };

    const aliceCreated = await app.inject({
      method: "POST",
      url: "/v1/chat-folders",
      headers: auth(alice),
      payload: { title: aliceCanary, rules, overrides: [], clientNonce: randomUUID() }
    });
    const bobCreated = await app.inject({
      method: "POST",
      url: "/v1/chat-folders",
      headers: auth(bob),
      payload: { title: bobCanary, rules, overrides: [], clientNonce: randomUUID() }
    });
    expect(aliceCreated.statusCode, aliceCreated.body).toBe(201);
    expect(bobCreated.statusCode, bobCreated.body).toBe(201);

    const unauthenticated = await app.inject({ method: "GET", url: "/v1/chat-folders" });
    expect(unauthenticated.statusCode).toBe(401);
    expect(unauthenticated.headers["cache-control"]).toBe("private, no-store");
    expect(unauthenticated.headers.pragma).toBe("no-cache");
    expect(unauthenticated.body).not.toContain(aliceCanary);
    expect(unauthenticated.body).not.toContain(bobCanary);

    const aliceFolders = await app.inject({
      method: "GET",
      url: "/v1/chat-folders",
      headers: auth(alice)
    });
    expect(aliceFolders.statusCode, aliceFolders.body).toBe(200);
    expect(aliceFolders.headers["cache-control"]).toBe("private, no-store");
    expect(aliceFolders.headers.pragma).toBe("no-cache");
    expect(ChatFolderListResponseSchema.parse(aliceFolders.json()).items).toEqual([
      expect.objectContaining({ title: aliceCanary })
    ]);
    expect(aliceFolders.body).not.toContain(bobCanary);
    expect(aliceFolders.body).not.toContain(bobCreated.json().folder.id as string);

    const boundary = await snapshot(alice);
    expect(boundary.reset.collections).toHaveLength(12);
    expect(new Set(boundary.reset.collections).size).toBe(12);
    expect(boundary.reset.collections).toContain("chat_folders");
    expect(boundary.resources.chatFolders).toBe("/v1/chat-folders");

    app.luxora.store.revokeSession(alice.sessionId, new Date().toISOString());
    const revoked = await app.inject({
      method: "GET",
      url: boundary.resources.chatFolders,
      headers: auth(alice)
    });
    expect(revoked.statusCode).toBe(401);
    expect(revoked.headers["cache-control"]).toBe("private, no-store");
    expect(revoked.headers.pragma).toBe("no-cache");
    expect(revoked.body).not.toContain(aliceCanary);
    expect(revoked.body).not.toContain(bobCanary);
  });

  it("uses deterministic failures for invalid, expired, future, and foreign-session cursors", async () => {
    const config = testConfig();
    app = await buildApp({ config, logger: false });
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    const alice = await register("sync_cursor_alice");
    const bob = await register("sync_cursor_bob");
    const aliceBoundary = await snapshot(alice);
    const bobBoundary = await snapshot(bob);
    const codec = new RealtimeCursorCodec(config.jwtSecret);

    const replacement = aliceBoundary.boundary.cursor.endsWith("a") ? "b" : "a";
    await expectSyncRequired(
      address,
      alice,
      `${aliceBoundary.boundary.cursor.slice(0, -1)}${replacement}`,
      "cursor_invalid"
    );

    const expired = codec.issue(
      alice.id,
      alice.sessionId,
      aliceBoundary.boundary.sequence,
      new Date(Date.now() - (REALTIME_CURSOR_TTL_SECONDS + 1) * 1_000)
    );
    await expectSyncRequired(address, alice, expired.cursor, "cursor_expired");

    const future = codec.issue(
      alice.id,
      alice.sessionId,
      aliceBoundary.boundary.sequence + 100
    );
    await expectSyncRequired(address, alice, future.cursor, "cursor_ahead");
    await expectSyncRequired(
      address,
      alice,
      bobBoundary.boundary.cursor,
      "cursor_scope_mismatch"
    );

    const numericOnly = await connect(address, alice, { resumeFrom: 0 });
    const numericRequired = await numericOnly.client.waitFor(
      (message) => message.type === "sync.required"
    );
    expect(numericRequired.reason).toBe("cursor_invalid");
    expect(await numericOnly.client.closed).toMatchObject({ code: 4009 });

    const malformed = await connect(address, alice, { resumeCursor: "corrupted" });
    const malformedRequired = await malformed.client.waitFor(
      (message) => message.type === "sync.required"
    );
    expect(malformedRequired.reason).toBe("cursor_invalid");
    expect(await malformed.client.closed).toMatchObject({ code: 4009 });

    const noDowngrade = await open(address);
    noDowngrade.send({
      type: "authenticate",
      accessToken: alice.accessToken,
      resumeFrom: 0,
      resumeCursor: bobBoundary.boundary.cursor
    });
    const noDowngradeReady = await noDowngrade.waitFor((message) => message.type === "ready");
    expect(noDowngradeReady).toMatchObject({ resumed: false, cursor: null });
    const noDowngradeRequired = await noDowngrade.waitFor(
      (message) => message.type === "sync.required"
    );
    expect(noDowngradeRequired.reason).toBe("cursor_invalid");
    expect(await noDowngrade.closed).toMatchObject({ code: 4009 });
    expect(noDowngrade.messages.some((message) => message.type === "dispatch")).toBe(false);
  });

  it("forces a snapshot after the bounded replay window overflows", async () => {
    app = await buildApp({ config: testConfig(), logger: false });
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    const alice = await register("sync_overflow_alice");
    const boundary = await snapshot(alice);
    const at = new Date().toISOString();

    for (let index = 0; index <= REALTIME_MAX_REPLAY_EVENTS; index += 1) {
      app.luxora.store.appendEvent(alice.id, {
        type: "relationship.block.changed",
        audience: "actor_account",
        accountId: randomUUID(),
        blocked: index % 2 === 0,
        changedAt: at
      }, at);
    }

    await expectSyncRequired(
      address,
      alice,
      boundary.boundary.cursor,
      "replay_window_exceeded"
    );
  });

  it("rechecks IA authorization during replay and never leaks inaccessible content", async () => {
    app = await buildApp({ config: testConfig(), logger: false });
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    const alice = await register("sync_filter_alice");
    const bob = await register("sync_filter_bob");
    const carol = await register("sync_filter_carol");
    const beforeRelationship = await snapshot(bob);
    const chatId = await establishAcceptedRelationship(app, alice, bob);
    const privateSnippet = "PRIVATE_SYNC_SNIPPET_MUST_NOT_ESCAPE";

    const sent = await app.inject({
      method: "POST",
      url: `/v1/chats/${chatId}/messages`,
      headers: auth(alice),
      payload: { body: privateSnippet, clientNonce: randomUUID() }
    });
    expect(sent.statusCode).toBe(201);
    const blocked = await app.inject({
      method: "PUT",
      url: `/v1/blocks/${alice.id}`,
      headers: auth(bob)
    });
    expect(blocked.statusCode).toBe(200);

    const replay = await connect(address, bob, {
      resumeCursor: beforeRelationship.boundary.cursor
    });
    await replay.client.waitFor((message) => message.type === "sync.checkpoint");
    const replayFrames = JSON.stringify(replay.client.messages);
    expect(replayFrames).not.toContain(privateSnippet);
    expect(replay.client.messages.some((message) =>
      message.type === "dispatch" &&
      (["chat.created", "message.created", "message.updated", "message.deleted"] as string[])
        .includes(message.event.type)
    )).toBe(false);

    const foreign = await expectSyncRequired(
      address,
      carol,
      beforeRelationship.boundary.cursor,
      "cursor_scope_mismatch"
    );
    expect(JSON.stringify(foreign.messages)).not.toContain(privateSnippet);
    expect(JSON.stringify(foreign.messages)).not.toContain(chatId);
  });

  it("reprojects group reaction state and filters blocked receipt actors during replay", async () => {
    app = await buildApp({ config: testConfig(), logger: false });
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    const alice = await register("sync_group_filter_alice");
    const bob = await register("sync_group_filter_bob");
    const carol = await register("sync_group_filter_carol");
    await establishAcceptedRelationship(app, alice, bob);
    await establishAcceptedRelationship(app, alice, carol);
    const group = await app.inject({
      method: "POST",
      url: "/v1/chats",
      headers: auth(alice),
      payload: { kind: "group", title: "Replay actor boundary", memberIds: [bob.id, carol.id] }
    });
    expect(group.statusCode).toBe(201);
    const chatId = group.json().chat.id as string;
    const sent = await app.inject({
      method: "POST",
      url: `/v1/chats/${chatId}/messages`,
      headers: auth(alice),
      payload: { body: "group replay target", clientNonce: randomUUID() }
    });
    expect(sent.statusCode).toBe(201);
    const messageId = sent.json().message.id as string;
    const boundary = await snapshot(alice);

    for (const actor of [bob, carol]) {
      expect((await app.inject({
        method: "POST",
        url: `/v1/chats/${chatId}/delivered`,
        headers: auth(actor),
        payload: { messageId }
      })).statusCode).toBe(204);
    }
    expect((await app.inject({
      method: "PUT",
      url: `/v1/messages/${messageId}/reactions`,
      headers: auth(bob),
      payload: { emoji: "BLOCKED_REACTION_CANARY" }
    })).statusCode).toBe(200);
    expect((await app.inject({
      method: "PUT",
      url: `/v1/messages/${messageId}/reactions`,
      headers: auth(carol),
      payload: { emoji: "VISIBLE_REACTION" }
    })).statusCode).toBe(200);
    expect((await app.inject({
      method: "PUT",
      url: `/v1/blocks/${bob.id}`,
      headers: auth(alice)
    })).statusCode).toBe(200);

    const replay = await connect(address, alice, { resumeCursor: boundary.boundary.cursor });
    await replay.client.waitFor((message) => message.type === "sync.checkpoint");
    const actorEvents = replay.client.messages.filter((message) => message.type === "dispatch");
    expect(actorEvents.some((message) =>
      (message.event.type === "reaction.updated" && message.event.actorUserId === bob.id) ||
      (message.event.type === "receipt.delivered" && message.event.userId === bob.id)
    )).toBe(false);
    const visibleReaction = actorEvents.find((message) =>
      message.event.type === "reaction.updated" && message.event.actorUserId === carol.id
    );
    expect(visibleReaction).toBeDefined();
    expect(visibleReaction.event.reactions).toEqual([
      { emoji: "VISIBLE_REACTION", count: 1, reactedByMe: false }
    ]);
    expect(JSON.stringify(visibleReaction)).not.toContain("BLOCKED_REACTION_CANARY");
    expect(actorEvents.some((message) =>
      message.event.type === "receipt.delivered" && message.event.userId === carol.id
    )).toBe(true);
  });

  it("exposes viewer-authorized canonical reaction and receipt state for snapshot rebuild", async () => {
    app = await buildApp({ config: testConfig(), logger: false });
    const alice = await register("sync_state_alice");
    const bob = await register("sync_state_bob");
    const carol = await register("sync_state_carol");
    const attachmentCreatedAt = new Date().toISOString();
    const aliceAttachmentId = randomUUID();
    app.luxora.store.createAttachment({
      id: aliceAttachmentId,
      ownerUserId: alice.id,
      kind: "file",
      fileName: "alice-owned.txt",
      declaredMimeType: "text/plain",
      detectedMimeType: "text/plain",
      sizeBytes: 12,
      sha256: "a".repeat(64),
      metadata: {},
      storageProvider: "local",
      storageKey: `test/${aliceAttachmentId}`,
      createdAt: attachmentCreatedAt
    });
    const bobAttachmentId = randomUUID();
    app.luxora.store.createAttachment({
      id: bobAttachmentId,
      ownerUserId: bob.id,
      kind: "file",
      fileName: "BOB_PRIVATE_ATTACHMENT.txt",
      declaredMimeType: "text/plain",
      detectedMimeType: "text/plain",
      sizeBytes: 12,
      sha256: "b".repeat(64),
      metadata: {},
      storageProvider: "local",
      storageKey: `test/${bobAttachmentId}`,
      createdAt: attachmentCreatedAt
    });
    const ownedAttachments = await app.inject({
      method: "GET",
      url: "/v1/attachments?limit=100",
      headers: auth(alice)
    });
    expect(ownedAttachments.statusCode).toBe(200);
    expect(ownedAttachments.json().items.map((item: any) => item.id)).toEqual([
      aliceAttachmentId
    ]);
    expect(ownedAttachments.body).not.toContain("BOB_PRIVATE_ATTACHMENT");
    expect(ownedAttachments.body).not.toContain(bobAttachmentId);
    const chatId = await establishAcceptedRelationship(app, alice, bob);
    const sent = await app.inject({
      method: "POST",
      url: `/v1/chats/${chatId}/messages`,
      headers: auth(alice),
      payload: { body: "canonical state target", clientNonce: randomUUID() }
    });
    expect(sent.statusCode).toBe(201);
    const messageId = sent.json().message.id as string;

    for (const url of [
      `/v1/chats/${chatId}/messages`,
      `/v1/chats/${chatId}/pins`,
      `/v1/chats/${chatId}/topics`
    ]) {
      const canonical = await app.inject({ method: "GET", url, headers: auth(alice) });
      expect(canonical.statusCode).toBe(200);
      expect(canonical.headers["cache-control"]).toBe("private, no-store");
      const denied = await app.inject({ method: "GET", url, headers: auth(carol) });
      expect(denied.statusCode).toBe(403);
      expect(denied.headers["cache-control"]).toBe("private, no-store");
      expect(denied.body).not.toContain(messageId);
    }

    expect((await app.inject({
      method: "POST",
      url: `/v1/chats/${chatId}/delivered`,
      headers: auth(bob),
      payload: { messageId }
    })).statusCode).toBe(204);
    expect((await app.inject({
      method: "POST",
      url: `/v1/chats/${chatId}/read`,
      headers: auth(bob),
      payload: { messageId }
    })).statusCode).toBe(204);
    expect((await app.inject({
      method: "PUT",
      url: `/v1/messages/${messageId}/reactions`,
      headers: auth(bob),
      payload: { emoji: "💎" }
    })).statusCode).toBe(200);

    const reactions = await app.inject({
      method: "GET",
      url: `/v1/messages/${messageId}/reactions`,
      headers: auth(alice)
    });
    const receipts = await app.inject({
      method: "GET",
      url: `/v1/messages/${messageId}/receipts`,
      headers: auth(alice)
    });
    expect(reactions.statusCode).toBe(200);
    expect(reactions.headers["cache-control"]).toBe("private, no-store");
    expect(reactions.json()).toEqual({
      items: [{ emoji: "💎", count: 1, reactedByMe: false }]
    });
    expect(receipts.statusCode).toBe(200);
    expect(receipts.json().items).toEqual([
      expect.objectContaining({ userId: bob.id, readAt: expect.any(String) })
    ]);

    for (const resource of ["reactions", "receipts"] as const) {
      const outsider = await app.inject({
        method: "GET",
        url: `/v1/messages/${messageId}/${resource}`,
        headers: auth(carol)
      });
      const absent = await app.inject({
        method: "GET",
        url: `/v1/messages/${randomUUID()}/${resource}`,
        headers: auth(carol)
      });
      expect(outsider.statusCode).toBe(404);
      expect(absent.statusCode).toBe(404);
      expect({ code: outsider.json().error.code, message: outsider.json().error.message }).toEqual({
        code: absent.json().error.code,
        message: absent.json().error.message
      });
      expect(outsider.headers["cache-control"]).toBe("private, no-store");
      expect(absent.headers["cache-control"]).toBe("private, no-store");
      expect(outsider.body).not.toContain("canonical state target");
      expect(outsider.body).not.toContain(bob.id);
    }

    expect((await app.inject({
      method: "PUT",
      url: `/v1/blocks/${bob.id}`,
      headers: auth(alice)
    })).statusCode).toBe(200);
    const hiddenReactions = await app.inject({
      method: "GET",
      url: `/v1/messages/${messageId}/reactions`,
      headers: auth(alice)
    });
    const hiddenReceipts = await app.inject({
      method: "GET",
      url: `/v1/messages/${messageId}/receipts`,
      headers: auth(alice)
    });
    expect(hiddenReactions.json()).toEqual({ items: [] });
    expect(hiddenReceipts.json()).toEqual({ items: [] });
  });

  it("rebuilds only reporter-owned safety summaries without report content or IDOR", async () => {
    app = await buildApp({ config: testConfig(), logger: false });
    const alice = await register("sync_reports_alice");
    const bob = await register("sync_reports_bob");
    const carol = await register("sync_reports_carol");
    const outsider = await register("sync_reports_outsider");
    const commentCanary = "PRIVATE_REPORT_COMMENT_CANARY";
    const firstNonce = randomUUID();
    const secondNonce = randomUUID();

    const first = await app.inject({
      method: "POST",
      url: "/v1/safety/reports",
      headers: auth(alice),
      payload: {
        subjectAccountId: bob.id,
        category: "impersonation",
        evidence: [],
        comment: commentCanary,
        alsoBlock: true,
        clientNonce: firstNonce
      }
    });
    const second = await app.inject({
      method: "POST",
      url: "/v1/safety/reports",
      headers: auth(alice),
      payload: {
        subjectAccountId: carol.id,
        category: "other",
        evidence: [],
        comment: `${commentCanary}_SECOND`,
        alsoBlock: false,
        clientNonce: secondNonce
      }
    });
    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(201);
    expect(`${first.body}${second.body}`).not.toContain(commentCanary);
    expect(`${first.body}${second.body}`).not.toContain(firstNonce);
    expect(`${first.body}${second.body}`).not.toContain(secondNonce);
    expect((await app.inject({
      method: "DELETE",
      url: `/v1/blocks/${bob.id}`,
      headers: auth(alice)
    })).statusCode).toBe(200);

    const firstPage = await app.inject({
      method: "GET",
      url: "/v1/safety/reports?limit=1",
      headers: auth(alice)
    });
    const retriedFirstPage = await app.inject({
      method: "GET",
      url: "/v1/safety/reports?limit=1",
      headers: auth(alice)
    });
    expect(firstPage.statusCode).toBe(200);
    expect(firstPage.headers["cache-control"]).toContain("no-store");
    expect(retriedFirstPage.body).toBe(firstPage.body);
    const firstPageBody = firstPage.json();
    expect(firstPageBody.items).toHaveLength(1);
    expect(firstPageBody.nextCursor).toEqual(expect.any(String));
    const secondPage = await app.inject({
      method: "GET",
      url: `/v1/safety/reports?limit=1&cursor=${encodeURIComponent(firstPageBody.nextCursor)}`,
      headers: auth(alice)
    });
    expect(secondPage.statusCode).toBe(200);
    const summaries = [...firstPageBody.items, ...secondPage.json().items];
    expect(new Set(summaries.map((item: any) => item.id))).toEqual(new Set([
      first.json().report.id,
      second.json().report.id
    ]));
    expect(summaries.find((item: any) => item.subjectAccountId === bob.id)).toMatchObject({
      alsoBlocked: true,
      status: "submitted",
      evidenceCount: 0
    });
    const listedText = `${firstPage.body}${secondPage.body}`;
    expect(listedText).not.toContain(commentCanary);
    expect(listedText).not.toContain(firstNonce);
    expect(listedText).not.toContain(secondNonce);
    expect(listedText).not.toContain("clientNonce");

    const outsiderList = await app.inject({
      method: "GET",
      url: "/v1/safety/reports?limit=100",
      headers: auth(outsider)
    });
    expect(outsiderList.statusCode).toBe(200);
    expect(outsiderList.json()).toEqual({ items: [], nextCursor: null });
    const idorAttempt = await app.inject({
      method: "GET",
      url: `/v1/safety/reports?reporterUserId=${alice.id}`,
      headers: auth(outsider)
    });
    expect(idorAttempt.statusCode).toBe(400);
    expect(idorAttempt.body).not.toContain(first.json().report.id as string);
    expect(idorAttempt.body).not.toContain(bob.id);

    const boundary = await snapshot(alice);
    const boundaryText = JSON.stringify(boundary);
    expect(boundary.resources.safetyReports).toBe("/v1/safety/reports");
    expect(boundaryText).not.toContain(commentCanary);
    expect(boundaryText).not.toContain(firstNonce);
    expect(boundaryText).not.toContain(secondNonce);
  });

  it("keeps reconciliation pagination stable while chat activity and block timestamps change", async () => {
    app = await buildApp({ config: testConfig(), logger: false });
    const alice = await register("sync_pages_alice");
    const bob = await register("sync_pages_bob");
    const carol = await register("sync_pages_carol");
    const dave = await register("sync_pages_dave");
    const chatIds: string[] = [];
    for (const title of ["Stable one", "Stable two", "Stable three"]) {
      const response = await app.inject({
        method: "POST",
        url: "/v1/chats",
        headers: auth(alice),
        payload: { kind: "group", title, memberIds: [] }
      });
      expect(response.statusCode).toBe(201);
      chatIds.push(response.json().chat.id as string);
    }

    const chatFirstPage = await app.inject({
      method: "GET",
      url: "/v2/sync/chats?limit=1",
      headers: auth(alice)
    });
    const allChatsBefore = await app.inject({
      method: "GET",
      url: "/v2/sync/chats?limit=100",
      headers: auth(alice)
    });
    expect(chatFirstPage.statusCode).toBe(200);
    expect(chatFirstPage.json().nextCursor).toEqual(expect.any(String));
    const firstChatId = chatFirstPage.json().items[0].id as string;
    const movedChatId = (allChatsBefore.json().items as any[])
      .map((chat) => chat.id as string)
      .find((id) => id !== firstChatId) as string;
    expect((await app.inject({
      method: "POST",
      url: `/v1/chats/${movedChatId}/messages`,
      headers: auth(alice),
      payload: { body: "moves UX order only", clientNonce: randomUUID() }
    })).statusCode).toBe(201);

    const pagedChatIds = [firstChatId];
    let chatCursor: string | null = chatFirstPage.json().nextCursor as string;
    while (chatCursor !== null) {
      const page = await app.inject({
        method: "GET",
        url: `/v2/sync/chats?limit=1&cursor=${encodeURIComponent(chatCursor)}`,
        headers: auth(alice)
      });
      expect(page.statusCode).toBe(200);
      pagedChatIds.push(...page.json().items.map((chat: any) => chat.id as string));
      chatCursor = page.json().nextCursor as string | null;
    }
    expect(new Set(pagedChatIds)).toEqual(new Set(chatIds));

    for (const account of [bob, carol, dave]) {
      expect((await app.inject({
        method: "PUT",
        url: `/v1/blocks/${account.id}`,
        headers: auth(alice)
      })).statusCode).toBe(200);
    }
    const blockFirstPage = await app.inject({
      method: "GET",
      url: "/v2/sync/blocks?limit=1",
      headers: auth(alice)
    });
    const allBlocksBefore = await app.inject({
      method: "GET",
      url: "/v2/sync/blocks?limit=100",
      headers: auth(alice)
    });
    expect(blockFirstPage.statusCode).toBe(200);
    const firstBlockedId = blockFirstPage.json().items[0].accountId as string;
    const recreatedBlockId = (allBlocksBefore.json().items as any[])
      .map((block) => block.accountId as string)
      .find((id) => id !== firstBlockedId) as string;
    expect((await app.inject({
      method: "DELETE",
      url: `/v1/blocks/${recreatedBlockId}`,
      headers: auth(alice)
    })).statusCode).toBe(200);
    expect((await app.inject({
      method: "PUT",
      url: `/v1/blocks/${recreatedBlockId}`,
      headers: auth(alice)
    })).statusCode).toBe(200);

    const pagedBlockIds = [firstBlockedId];
    let blockCursor: string | null = blockFirstPage.json().nextCursor as string;
    while (blockCursor !== null) {
      const page = await app.inject({
        method: "GET",
        url: `/v2/sync/blocks?limit=1&cursor=${encodeURIComponent(blockCursor)}`,
        headers: auth(alice)
      });
      expect(page.statusCode).toBe(200);
      pagedBlockIds.push(...page.json().items.map((block: any) => block.accountId as string));
      blockCursor = page.json().nextCursor as string | null;
    }
    expect(new Set(pagedBlockIds)).toEqual(new Set([bob.id, carol.id, dave.id]));

    const outsiderBlocks = await app.inject({
      method: "GET",
      url: `/v2/sync/blocks?userId=${alice.id}`,
      headers: auth(bob)
    });
    expect(outsiderBlocks.statusCode).toBe(400);
    expect(outsiderBlocks.body).not.toContain(carol.id);
    expect(outsiderBlocks.body).not.toContain(dave.id);
  });

  it("rejects revoked sessions and will not reuse their cursor from a replacement session", async () => {
    app = await buildApp({ config: testConfig(), logger: false });
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    const firstSession = await register("sync_revoke_alice");
    const oldBoundary = await snapshot(firstSession);
    const replacementSession = await login(firstSession, "Replacement device");

    const revoked = await app.inject({
      method: "DELETE",
      url: `/v1/auth/sessions/${firstSession.sessionId}`,
      headers: auth(replacementSession)
    });
    expect(revoked.statusCode).toBe(204);
    const deniedSnapshot = await app.inject({
      method: "GET",
      url: "/v2/sync/snapshot",
      headers: auth(firstSession)
    });
    expect(deniedSnapshot.statusCode).toBe(401);
    expect(deniedSnapshot.headers["cache-control"]).toBe("private, no-store");

    const revokedSocket = await open(address);
    revokedSocket.send({ type: "authenticate", accessToken: firstSession.accessToken });
    const error = await revokedSocket.waitFor((message) => message.type === "error");
    expect(error.code).toBe("UNAUTHENTICATED");
    expect(await revokedSocket.closed).toMatchObject({ code: 4001 });
    expect(revokedSocket.messages.some((message) => message.type === "ready")).toBe(false);

    await expectSyncRequired(
      address,
      replacementSession,
      oldBoundary.boundary.cursor,
      "cursor_scope_mismatch"
    );
  });

  it("rechecks externally revoked sessions before commands and live dispatch", async () => {
    app = await buildApp({ config: testConfig(), logger: false });
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    const alice = await register("sync_external_revoke_alice");

    const live = await connect(address, alice);
    await live.client.waitFor((message) => message.type === "sync.checkpoint");
    app.luxora.store.revokeSession(alice.sessionId, new Date().toISOString());
    const event = app.luxora.store.appendEvent(alice.id, {
      type: "relationship.block.changed",
      audience: "actor_account",
      accountId: randomUUID(),
      blocked: true,
      changedAt: new Date().toISOString()
    }, new Date().toISOString());
    app.luxora.hub.publish([event]);
    expect(await live.client.closed).toMatchObject({ code: 4001 });
    expect(live.client.messages.some((message) =>
      message.type === "dispatch" && message.sequence === event.sequence
    )).toBe(false);

    const commandSession = await login(alice, "Externally revoked command device");
    const command = await connect(address, commandSession);
    await command.client.waitFor((message) => message.type === "sync.checkpoint");
    app.luxora.store.revokeSession(commandSession.sessionId, new Date().toISOString());
    const heartbeatTimestamp = new Date().toISOString();
    command.client.send({ type: "heartbeat", timestamp: heartbeatTimestamp });
    const error = await command.client.waitFor((message) => message.type === "error");
    expect(error.code).toBe("UNAUTHENTICATED");
    expect(await command.client.closed).toMatchObject({ code: 4001 });
    expect(command.client.messages.some((message) =>
      message.type === "heartbeat.ack" && message.timestamp === heartbeatTimestamp
    )).toBe(false);
  });

  it("fails closed without throwing after a committed event when session status is unavailable", async () => {
    app = await buildApp({ config: testConfig(), logger: false });
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    const alice = await register("sync_session_store_failure_alice");
    const live = await connect(address, alice);
    await live.client.waitFor((message) => message.type === "sync.checkpoint");
    const at = new Date().toISOString();
    const event = app.luxora.store.appendEvent(alice.id, {
      type: "relationship.block.changed",
      audience: "actor_account",
      accountId: randomUUID(),
      blocked: true,
      changedAt: at
    }, at);
    const sessionStatus = vi.spyOn(app.luxora.store, "isSessionActive")
      .mockImplementation(() => { throw new Error("synthetic session store outage"); });

    expect(() => app!.luxora.hub.publish([event])).not.toThrow();
    sessionStatus.mockRestore();
    expect(await live.client.closed).toMatchObject({ code: 1011 });
    expect(live.client.messages.some((message) =>
      message.type === "dispatch" && message.sequence === event.sequence
    )).toBe(false);
  });

  it("preserves numeric replay on the legacy v1 endpoint only", async () => {
    app = await buildApp({ config: testConfig(), logger: false });
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    const alice = await register("sync_legacy_alice");
    const chat = await app.inject({
      method: "POST",
      url: "/v1/chats",
      headers: auth(alice),
      payload: { kind: "direct", userId: alice.id }
    });
    expect(chat.statusCode).toBe(201);
    const chatId = chat.json().chat.id as string;
    const resumeFrom = app.luxora.store.getLatestSequence();
    const sent = await app.inject({
      method: "POST",
      url: `/v1/chats/${chatId}/messages`,
      headers: auth(alice),
      payload: { body: "legacy-v1-replay", clientNonce: randomUUID() }
    });
    expect(sent.statusCode).toBe(201);

    const socket = new WebSocket(`${address.replace("http", "ws")}/v1/realtime`);
    sockets.push(socket);
    const client = new RealtimeClient(socket);
    await new Promise<void>((resolve, reject) => {
      socket.once("open", resolve);
      socket.once("error", reject);
    });
    await client.waitFor((message) => message.type === "hello" && message.protocolVersion === 1);
    client.send({ type: "authenticate", accessToken: alice.accessToken, resumeFrom });
    const ready = await client.waitFor((message) => message.type === "ready");
    expect(ready.resumed).toBe(true);
    const dispatch = await client.waitFor((message) =>
      message.type === "dispatch" &&
      message.event.type === "message.created" &&
      message.event.message.body === "legacy-v1-replay"
    );
    expect(dispatch.cursor).toBeUndefined();
  });
});
