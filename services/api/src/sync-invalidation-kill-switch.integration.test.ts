import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import type { LuxoraApp } from "./app.js";
import { buildApp } from "./app.js";
import { contentCipherFromConfig } from "./infrastructure/content-cipher.js";
import { SqliteStore } from "./infrastructure/sqlite-store.js";
import { testConfig } from "./test-helpers.js";

class RealtimeProbe {
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
    throw new Error("Timed out waiting for realtime message");
  }
}

describe("sync invalidation emergency kill switch", () => {
  let app: LuxoraApp | undefined;
  const sockets: WebSocket[] = [];

  afterEach(async () => {
    for (const socket of sockets) socket.terminate();
    sockets.length = 0;
    await app?.close();
    app = undefined;
  });

  it("truthfully advertises degradation, suppresses profile invalidation, and preserves domain events", async () => {
    app = await buildApp({
      config: testConfig({
        dataEncryptionKeys: {
          sync_fallback_live: Buffer.alloc(32, 120).toString("base64url")
        },
        activeDataEncryptionKeyId: "sync_fallback_live",
        syncInvalidationEnabled: false
      }),
      logger: false
    });
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    const capabilities = await app.inject({ method: "GET", url: "/v1/capabilities" });
    expect(capabilities.statusCode).toBe(200);
    expect(capabilities.json().features).toMatchObject({
      realtime: true,
      reconciliation: true,
      syncInvalidation: false,
      chatFolders: true
    });

    const registration = await app.inject({
      method: "POST",
      url: "/v1/auth/register",
      payload: {
        username: "fallback_profile",
        displayName: "Fallback Profile",
        password: "correct horse battery staple",
        deviceName: "Fallback Test"
      }
    });
    expect(registration.statusCode, registration.body).toBe(201);
    const accessToken = registration.json().tokens.accessToken as string;
    const accountId = registration.json().user.id as string;

    const socket = new WebSocket(`${address.replace("http", "ws")}/v2/realtime`);
    sockets.push(socket);
    const realtime = new RealtimeProbe(socket);
    await new Promise<void>((resolve, reject) => {
      socket.once("open", resolve);
      socket.once("error", reject);
    });
    await realtime.waitFor((message) => message.type === "hello");
    socket.send(JSON.stringify({ type: "authenticate", accessToken }));
    await realtime.waitFor((message) => message.type === "ready");

    const beforeProfile = app.luxora.store.getLatestSequence();
    const changed = await app.inject({
      method: "PATCH",
      url: "/v1/me",
      headers: { authorization: `Bearer ${accessToken}` },
      payload: { displayName: "Fallback Profile Updated" }
    });
    expect(changed.statusCode, changed.body).toBe(200);
    expect(changed.json().user.displayName).toBe("Fallback Profile Updated");
    expect(app.luxora.store.getLatestSequence()).toBe(beforeProfile);
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(realtime.messages.some((message) =>
      message.type === "dispatch" && message.event?.type === "sync.invalidated"
    )).toBe(false);

    app.luxora.hub.publish([{
      sequence: Math.max(1, beforeProfile + 1),
      audienceUserId: accountId,
      event: {
        type: "sync.invalidated",
        audience: "account_projection",
        accountId,
        reason: "profile_updated",
        changedAt: "2026-08-11T14:00:00.000Z"
      },
      createdAt: "2026-08-11T14:00:00.000Z"
    }]);
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(realtime.messages.some((message) =>
      message.type === "dispatch" && message.event?.type === "sync.invalidated"
    )).toBe(false);

    const noOp = await app.inject({
      method: "PATCH",
      url: "/v1/me",
      headers: { authorization: `Bearer ${accessToken}` },
      payload: { displayName: "Fallback Profile Updated" }
    });
    expect(noOp.statusCode).toBe(200);
    expect(app.luxora.store.getLatestSequence()).toBe(beforeProfile);

    const folder = await app.inject({
      method: "POST",
      url: "/v1/chat-folders",
      headers: { authorization: `Bearer ${accessToken}` },
      payload: {
        title: "Fallback domain event",
        rules: {
          includeKinds: ["direct", "group", "channel"],
          unreadOnly: false,
          excludeMuted: true,
          includeArchived: false
        },
        overrides: [],
        clientNonce: randomUUID()
      }
    });
    expect(folder.statusCode, folder.body).toBe(201);
    const delivered = await realtime.waitFor((message) =>
      message.type === "dispatch" && message.event?.type === "chat.folders.updated"
    );
    expect(delivered.event).toMatchObject({
      type: "chat.folders.updated",
      stateRevision: 1
    });
    expect(app.luxora.store.getLatestSequence()).toBeGreaterThan(beforeProfile);
  });

  it("filters more than one replay window of historical invalidations without hiding later domain events", async () => {
    const root = await mkdtemp(join(tmpdir(), "luxora-sync-fallback-replay-"));
    const key = Buffer.alloc(32, 119).toString("base64url");
    const common = {
      databasePath: join(root, "luxora.db"),
      dataEncryptionKeys: { sync_fallback: key },
      activeDataEncryptionKeyId: "sync_fallback",
      storageLocalPath: join(root, "blobs"),
      uploadStagingPath: join(root, "uploads")
    } as const;
    try {
      app = await buildApp({
        config: testConfig({ ...common, syncInvalidationEnabled: true }),
        logger: false
      });
      const registration = await app.inject({
        method: "POST",
        url: "/v1/auth/register",
        payload: {
          username: "fallback_replay",
          displayName: "Fallback Replay",
          password: "correct horse battery staple",
          deviceName: "Fallback Replay Test"
        }
      });
      expect(registration.statusCode, registration.body).toBe(201);
      const userId = registration.json().user.id as string;
      const accessToken = registration.json().tokens.accessToken as string;
      const snapshotResponse = await app.inject({
        method: "GET",
        url: "/v2/sync/snapshot",
        headers: { authorization: `Bearer ${accessToken}` }
      });
      expect(snapshotResponse.statusCode, snapshotResponse.body).toBe(200);
      const snapshot = snapshotResponse.json();
      await app.close();
      app = undefined;

      const store = new SqliteStore(
        common.databasePath,
        contentCipherFromConfig(common.dataEncryptionKeys, common.activeDataEncryptionKeyId)
      );
      const changedAt = "2026-08-11T14:00:00.000Z";
      for (let index = 0; index < 501; index += 1) {
        store.appendEvent(userId, {
          type: "sync.invalidated",
          audience: "account_projection",
          accountId: userId,
          reason: "profile_updated",
          changedAt
        }, changedAt);
      }
      const chatId = randomUUID();
      store.createChat({
        id: chatId,
        kind: "group",
        title: "Fallback replay domain event",
        directKey: null,
        createdBy: userId,
        createdAt: changedAt
      });
      store.addChatMember(chatId, userId, "owner", changedAt);
      const chat = store.getChatForUser(chatId, userId);
      if (chat === null) throw new Error("Expected fallback replay chat projection");
      const ordinary = store.appendEvent(userId, {
        type: "chat.created",
        chat
      }, changedAt);
      store.close();

      app = await buildApp({
        config: testConfig({ ...common, syncInvalidationEnabled: false }),
        logger: false
      });
      const address = await app.listen({ host: "127.0.0.1", port: 0 });

      const v2Socket = new WebSocket(`${address.replace("http", "ws")}/v2/realtime`);
      sockets.push(v2Socket);
      const v2 = new RealtimeProbe(v2Socket);
      await new Promise<void>((resolve, reject) => {
        v2Socket.once("open", resolve);
        v2Socket.once("error", reject);
      });
      await v2.waitFor((message) => message.type === "hello");
      v2Socket.send(JSON.stringify({
        type: "authenticate",
        accessToken,
        resumeCursor: snapshot.boundary.cursor
      }));
      const v2Ready = await v2.waitFor((message) => message.type === "ready");
      expect(v2Ready.resumed).toBe(true);
      const v2Dispatch = await v2.waitFor((message) => message.type === "dispatch");
      expect(v2Dispatch).toMatchObject({
        sequence: ordinary.sequence,
        event: { type: "chat.created", chat: { id: chatId } }
      });
      const checkpoint = await v2.waitFor((message) => message.type === "sync.checkpoint");
      expect(checkpoint.sequence).toBe(ordinary.sequence);
      expect(v2.messages.some((message) =>
        message.type === "dispatch" && message.event?.type === "sync.invalidated"
      )).toBe(false);

      const v1Socket = new WebSocket(`${address.replace("http", "ws")}/v1/realtime`);
      sockets.push(v1Socket);
      const v1 = new RealtimeProbe(v1Socket);
      await new Promise<void>((resolve, reject) => {
        v1Socket.once("open", resolve);
        v1Socket.once("error", reject);
      });
      await v1.waitFor((message) => message.type === "hello");
      v1Socket.send(JSON.stringify({
        type: "authenticate",
        accessToken,
        resumeFrom: snapshot.boundary.sequence
      }));
      await v1.waitFor((message) => message.type === "ready");
      const v1Dispatch = await v1.waitFor((message) => message.type === "dispatch");
      expect(v1Dispatch).toMatchObject({
        sequence: ordinary.sequence,
        event: { type: "chat.created", chat: { id: chatId } }
      });
      expect(v1.messages.some((message) =>
        message.type === "dispatch" && message.event?.type === "sync.invalidated"
      )).toBe(false);
    } finally {
      await app?.close();
      app = undefined;
      await rm(root, { recursive: true, force: true });
    }
  });
});
