import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { LuxoraApp } from "./app.js";
import { buildApp } from "./app.js";
import { establishAcceptedRelationship, testConfig } from "./test-helpers.js";

const DATA_KEY = Buffer.alloc(32, 62).toString("base64url");

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64"
);

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

interface Identity {
  id: string;
  accessToken: string;
}

describe("search pagination convergence", () => {
  let app: LuxoraApp | undefined;
  const temporaryRoots: string[] = [];

  afterEach(async () => {
    await app?.close();
    app = undefined;
    await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  async function boot(): Promise<void> {
    const storageRoot = await mkdtemp(join(tmpdir(), "luxora-search-page-"));
    temporaryRoots.push(storageRoot);
    app = await buildApp({
      config: testConfig({
        dataEncryptionKeys: { test: DATA_KEY },
        activeDataEncryptionKeyId: "test",
        storageLocalPath: join(storageRoot, "blobs"),
        uploadStagingPath: join(storageRoot, "uploads")
      }),
      logger: false
    });
  }

  async function register(username: string): Promise<Identity> {
    const response = await app!.inject({
      method: "POST",
      url: "/v1/auth/register",
      payload: { username, displayName: username, password: "correct horse battery staple" }
    });
    expect(response.statusCode, response.body).toBe(201);
    return {
      id: response.json().user.id as string,
      accessToken: response.json().tokens.accessToken as string
    };
  }

  function auth(identity: Identity): { authorization: string } {
    return { authorization: `Bearer ${identity.accessToken}` };
  }

  async function sendText(identity: Identity, chatId: string, body: string): Promise<string> {
    const response = await app!.inject({
      method: "POST",
      url: `/v1/chats/${chatId}/messages`,
      headers: auth(identity),
      payload: {
        body,
        clientNonce: randomUUID(),
        replyToMessageId: null,
        topicId: null,
        attachmentIds: []
      }
    });
    expect(response.statusCode, response.body).toBe(201);
    return response.json().message.id as string;
  }

  async function collectIds(
    baseUrl: string,
    headers: { authorization: string }
  ): Promise<{ ids: string[]; pages: number[] }> {
    const ids: string[] = [];
    const pages: number[] = [];
    let cursor: string | undefined;
    for (let round = 0; round < 10; round += 1) {
      const url = cursor === undefined ? baseUrl : `${baseUrl}&cursor=${encodeURIComponent(cursor)}`;
      const response = await app!.inject({ method: "GET", url, headers });
      expect(response.statusCode, response.body).toBe(200);
      const body = response.json() as { items: Array<{ id: string }>; nextCursor: string | null };
      pages.push(body.items.length);
      ids.push(...body.items.map((item) => item.id));
      if (body.nextCursor === null) return { ids, pages };
      cursor = body.nextCursor;
    }
    throw new Error("search pagination did not terminate");
  }

  it("pages global and chat-scoped message search without loss or duplication", async () => {
    await boot();
    const alice = await register("searchpage_alice");
    const bob = await register("searchpage_bob");
    await establishAcceptedRelationship(app!, alice, bob);
    const chat = await app!.inject({
      method: "POST",
      url: "/v1/chats",
      headers: auth(alice),
      payload: { kind: "group", title: "Search page group", memberIds: [bob.id] }
    });
    expect(chat.statusCode, chat.body).toBe(201);
    const chatId = chat.json().chat.id as string;

    const sent: string[] = [];
    for (let index = 1; index <= 5; index += 1) {
      sent.push(await sendText(alice, chatId, `pageprobe note number ${index}`));
    }

    const global = await collectIds("/v1/search/messages?q=pageprobe&limit=2", auth(bob));
    expect(global.pages).toEqual([2, 2, 1]);
    expect([...global.ids].sort()).toEqual([...sent].sort());

    const scoped = await collectIds(
      `/v1/search/messages?q=pageprobe&limit=2&chatId=${chatId}`,
      auth(alice)
    );
    expect(scoped.pages).toEqual([2, 2, 1]);
    expect([...scoped.ids].sort()).toEqual([...sent].sort());

    const garbage = await app!.inject({
      method: "GET",
      url: "/v1/search/messages?q=pageprobe&cursor=not-a-cursor",
      headers: auth(alice)
    });
    expect(garbage.statusCode).toBe(400);
  }, 60_000);

  it("pages known-user search across relationships", async () => {
    await boot();
    const alice = await register("searchpeople_alice");
    const peers: Identity[] = [];
    for (let index = 1; index <= 3; index += 1) {
      const peer = await register(`pagepeer${index}`);
      await establishAcceptedRelationship(app!, alice, peer);
      peers.push(peer);
    }

    const collected = await collectIds("/v1/users/search?q=pagepeer&limit=2", auth(alice));
    expect(collected.pages).toEqual([2, 1]);
    expect([...collected.ids].sort()).toEqual(peers.map((peer) => peer.id).sort());
  }, 60_000);

  it("pages file search over owned uploads", async () => {
    await boot();
    const alice = await register("searchfiles_alice");
    const headers = auth(alice);
    const attachmentIds: string[] = [];
    for (let index = 1; index <= 3; index += 1) {
      const created = await app!.inject({
        method: "POST",
        url: "/v1/uploads",
        headers,
        payload: {
          kind: "image",
          fileName: `pageprobe.${index}.png`,
          mimeType: "image/png",
          sizeBytes: PNG.length,
          sha256: sha256(PNG),
          idempotencyKey: randomUUID(),
          metadata: { width: 1, height: 1 }
        }
      });
      expect(created.statusCode, created.body).toBe(201);
      const uploadId = created.json().upload.id as string;
      const chunk = await app!.inject({
        method: "PUT",
        url: `/v1/uploads/${uploadId}/chunks/0`,
        headers: {
          ...headers,
          "content-type": "application/octet-stream",
          "content-length": String(PNG.length),
          "content-range": `bytes 0-${PNG.length - 1}/${PNG.length}`,
          "x-chunk-sha256": sha256(PNG)
        },
        payload: PNG
      });
      expect(chunk.statusCode, chunk.body).toBe(200);
      const completed = await app!.inject({
        method: "POST",
        url: `/v1/uploads/${uploadId}/complete`,
        headers
      });
      expect(completed.statusCode, completed.body).toBe(200);
      attachmentIds.push(completed.json().upload.attachment.id as string);
    }

    const collected = await collectIds("/v1/search/files?q=pageprobe&limit=1", headers);
    expect(collected.pages).toEqual([1, 1, 1]);
    expect([...collected.ids].sort()).toEqual([...attachmentIds].sort());
  }, 60_000);
});
