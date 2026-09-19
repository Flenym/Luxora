import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { LuxoraApp } from "./app.js";
import { buildApp } from "./app.js";
import { establishAcceptedRelationship, testConfig } from "./test-helpers.js";

const DATA_KEY = Buffer.alloc(32, 62).toString("base64url");

interface Identity {
  id: string;
  accessToken: string;
}

interface ChatItem {
  id: string;
  title: string | null;
  kind: string;
}

describe("conversation search", () => {
  let app: LuxoraApp | undefined;
  const temporaryRoots: string[] = [];

  afterEach(async () => {
    await app?.close();
    app = undefined;
    await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  async function boot(): Promise<void> {
    const storageRoot = await mkdtemp(join(tmpdir(), "luxora-search-chats-"));
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

  async function createGroup(identity: Identity, title: string, memberIds: string[] = []): Promise<string> {
    const response = await app!.inject({
      method: "POST",
      url: "/v1/chats",
      headers: auth(identity),
      payload: { kind: "group", title, memberIds }
    });
    expect(response.statusCode, response.body).toBe(201);
    return response.json().chat.id as string;
  }

  async function search(identity: Identity, query: Record<string, string>): Promise<{ status: number; body: unknown }> {
    const params = new URLSearchParams(query).toString();
    const response = await app!.inject({
      method: "GET",
      url: `/v1/search/chats?${params}`,
      headers: auth(identity)
    });
    return { status: response.statusCode, body: response.json() as unknown };
  }

  it("finds member groups by title substring and pages them", async () => {
    await boot();
    const alice = await register("alice_chatsearch");
    const bob = await register("bob_chatsearch");
    await establishAcceptedRelationship(app!, alice, bob);

    const hiking = await createGroup(alice, "Weekend Hiking Club", [bob.id]);
    const cooking = await createGroup(alice, "hiking recipes");
    const other = await createGroup(bob, "Bob Hiking Solo");
    void other;

    const first = await search(alice, { q: "hiking", limit: "1" });
    expect(first.status).toBe(200);
    const firstBody = first.body as { items: ChatItem[]; nextCursor: string | null };
    expect(firstBody.items).toHaveLength(1);
    expect(typeof firstBody.nextCursor).toBe("string");

    const second = await search(alice, { q: "HIKING", limit: "1", cursor: firstBody.nextCursor as string });
    expect(second.status).toBe(200);
    const secondBody = second.body as { items: ChatItem[]; nextCursor: string | null };
    expect(secondBody.items).toHaveLength(1);
    expect(secondBody.nextCursor).toBeNull();
    const foundIds = [firstBody.items[0]!.id, secondBody.items[0]!.id].sort();
    expect(foundIds).toEqual([hiking, cooking].sort());

    const titles = [firstBody.items[0]!.title, secondBody.items[0]!.title].sort();
    expect(titles).toEqual(["Weekend Hiking Club", "hiking recipes"].sort());
  });

  it("treats LIKE wildcards literally and scopes to membership", async () => {
    await boot();
    const alice = await register("alice_chatwild");
    const bob = await register("bob_chatwild");
    const stranger = await register("mallory_chatwild");
    await establishAcceptedRelationship(app!, alice, bob);

    const percent = await createGroup(alice, "100% legit group");
    void percent;
    const underscore = await createGroup(alice, "under_score club");
    void underscore;

    const percentSearch = await search(alice, { q: "100%" });
    expect(percentSearch.status).toBe(200);
    expect((percentSearch.body as { items: ChatItem[] }).items.map((c) => c.title)).toEqual(["100% legit group"]);

    const underscoreSearch = await search(alice, { q: "under_score" });
    expect(underscoreSearch.status).toBe(200);
    expect((underscoreSearch.body as { items: ChatItem[] }).items.map((c) => c.title)).toEqual(["under_score club"]);

    const empty = await search(alice, { q: "no such chat title anywhere" });
    expect(empty.status).toBe(200);
    expect((empty.body as { items: ChatItem[] }).items).toEqual([]);

    await establishAcceptedRelationship(app!, alice, stranger);
    const direct = await app!.inject({
      method: "POST",
      url: "/v1/chats",
      headers: auth(alice),
      payload: { kind: "direct", userId: stranger.id }
    });
    expect(direct.statusCode).toBe(201);

    const strangerSearch = await search(stranger, { q: "legit" });
    expect(strangerSearch.status).toBe(200);
    expect((strangerSearch.body as { items: ChatItem[] }).items).toEqual([]);

    const badCursor = await search(alice, { q: "legit", cursor: "not-a-cursor" });
    expect(badCursor.status).toBe(400);

    const unauthenticated = await app!.inject({ method: "GET", url: "/v1/search/chats?q=legit" });
    expect(unauthenticated.statusCode).toBe(401);
  });
});
