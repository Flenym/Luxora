import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import type { LuxoraApp } from "./app.js";
import { buildApp } from "./app.js";
import { establishAcceptedRelationship, testConfig } from "./test-helpers.js";

interface Identity {
  id: string;
  accessToken: string;
}

interface PageBody {
  items?: Array<{ id?: string; callId?: string; revision?: number }>;
  calls?: Array<{ callId: string }>;
  nextCursor?: string | null;
}

function auth(identity: Identity): { authorization: string } {
  return { authorization: `Bearer ${identity.accessToken}` };
}

describe("additive cursor pagination for previously unpaginated lists", () => {
  let app: LuxoraApp | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  async function register(username: string): Promise<Identity & { password: string }> {
    const password = "correct horse battery staple";
    const response = await app!.inject({
      method: "POST",
      url: "/v1/auth/register",
      payload: { username, displayName: username, password, deviceName: "pagination test" }
    });
    expect(response.statusCode, response.body).toBe(201);
    return {
      id: response.json().user.id as string,
      accessToken: response.json().tokens.accessToken as string,
      password
    };
  }

  async function registerNamed(username: string) {
    const identity = await register(username);
    return { ...identity, username };
  }

  async function createGroup(owner: Identity, title: string, memberIds: string[] = []) {
    const response = await app!.inject({
      method: "POST",
      url: "/v1/chats",
      headers: auth(owner),
      payload: { kind: "group", title, memberIds }
    });
    expect(response.statusCode, response.body).toBe(201);
    return response.json().chat.id as string;
  }

  async function createDirect(left: Identity, right: Identity) {
    return establishAcceptedRelationship(app!, left, right);
  }

  /** Follows `nextCursor` until exhausted and asserts one, consistent terminal page. */
  async function collectPages(
    url: string,
    identity: Identity,
    field: "items" | "calls" = "items",
    maxPages = 25
  ): Promise<Array<{ id: string; revision?: number }>> {
    const collected: Array<{ id: string; revision?: number }> = [];
    const seenCursors = new Set<string>();
    let cursor: string | null = null;
    for (let page = 0; page < maxPages; page += 1) {
      const separator = url.includes("?") ? "&" : "?";
      const requestUrl = cursor === null ? url : `${url}${separator}cursor=${encodeURIComponent(cursor)}`;
      const response = await app!.inject({ method: "GET", url: requestUrl, headers: auth(identity) });
      expect(response.statusCode, `${requestUrl} ${response.body}`).toBe(200);
      const body = response.json() as PageBody;
      const rows = (field === "calls" ? body.calls : body.items) ?? [];
      for (const row of rows) {
        if (field === "calls") {
          collected.push({ id: (row as { callId: string }).callId });
        } else {
          const item = row as { id?: string; messageId?: string; revision?: number; membership?: { userId: string } };
          const id = item.id ?? item.messageId ?? item.membership?.userId;
          expect(id, `page row must expose an id: ${response.body}`).toBeTruthy();
          collected.push({ id: id as string, ...(item.revision === undefined ? {} : { revision: item.revision }) });
        }
      }
      if (body.nextCursor === null || body.nextCursor === undefined) return collected;
      expect(seenCursors.has(body.nextCursor), "cursor must not repeat").toBe(false);
      seenCursors.add(body.nextCursor);
      cursor = body.nextCursor;
    }
    throw new Error(`pagination did not terminate within ${maxPages} pages for ${url}`);
  }

  function expectNoDuplicates(collected: Array<{ id: string }>): void {
    expect(new Set(collected.map(({ id }) => id)).size).toBe(collected.length);
  }

  async function expectGarbageCursor400(url: string, identity: Identity): Promise<void> {
    const separator = url.includes("?") ? "&" : "?";
    const response = await app!.inject({
      method: "GET",
      url: `${url}${separator}cursor=${encodeURIComponent("not-a-real-cursor")}`,
      headers: auth(identity)
    });
    expect(response.statusCode, response.body).toBe(400);
    expect(response.json().error.code).toBe("BAD_REQUEST");
  }

  it("handles empty, exact-limit and limit+1 page boundaries", async () => {
    app = await buildApp({ config: testConfig(), logger: false });
    const owner = await register("page_boundary_owner");
    const bob = await register("page_boundary_bob");
    const carol = await register("page_boundary_carol");
    await establishAcceptedRelationship(app, owner, { id: bob.id, accessToken: bob.accessToken });
    await establishAcceptedRelationship(app, owner, { id: carol.id, accessToken: carol.accessToken });
    const groupId = await createGroup(owner, "Boundary page", [bob.id]);

    // Empty collection: one empty page with a null terminal cursor.
    const emptyTopics = await app.inject({
      method: "GET",
      url: `/v1/chats/${groupId}/topics?limit=2`,
      headers: auth(owner)
    });
    expect(emptyTopics.statusCode, emptyTopics.body).toBe(200);
    expect(emptyTopics.json().items).toEqual([]);
    expect(emptyTopics.json().nextCursor).toBeNull();

    // Exactly `limit` members: no phantom continuation.
    const exact = await app.inject({
      method: "GET",
      url: `/v1/chats/${groupId}/members?limit=2`,
      headers: auth(owner)
    });
    expect(exact.statusCode, exact.body).toBe(200);
    expect(exact.json().items).toHaveLength(2);
    expect(exact.json().nextCursor).toBeNull();

    // limit+1 rows: first page is bounded and the cursor continues the rest.
    const added = await app.inject({
      method: "POST",
      url: `/v1/chats/${groupId}/members`,
      headers: auth(owner),
      payload: { userId: carol.id, role: "member", clientNonce: randomUUID() }
    });
    expect(added.statusCode, added.body).toBe(201);
    const firstPage = await app.inject({
      method: "GET",
      url: `/v1/chats/${groupId}/members?limit=2`,
      headers: auth(owner)
    });
    expect(firstPage.statusCode, firstPage.body).toBe(200);
    expect(firstPage.json().items).toHaveLength(2);
    expect(typeof firstPage.json().nextCursor).toBe("string");
    const secondPage = await app.inject({
      method: "GET",
      url: `/v1/chats/${groupId}/members?limit=2&cursor=${encodeURIComponent(firstPage.json().nextCursor)}`,
      headers: auth(owner)
    });
    expect(secondPage.statusCode, secondPage.body).toBe(200);
    expect(secondPage.json().items).toHaveLength(1);
    expect(secondPage.json().nextCursor).toBeNull();
  });

  it("paginates group members in stable join order without duplicates or gaps", async () => {
    app = await buildApp({ config: testConfig(), logger: false });
    const owner = await register("page_members_owner");
    const bob = await register("page_members_bob");
    const carol = await register("page_members_carol");
    await establishAcceptedRelationship(app, owner, { id: bob.id, accessToken: bob.accessToken });
    const groupId = await createGroup(owner, "Members page", [bob.id]);
    await establishAcceptedRelationship(app, owner, { id: carol.id, accessToken: carol.accessToken });
    const added = await app.inject({
      method: "POST",
      url: `/v1/chats/${groupId}/members`,
      headers: auth(owner),
      payload: { userId: carol.id, role: "member", clientNonce: randomUUID() }
    });
    expect(added.statusCode, added.body).toBe(201);

    const full = await app.inject({
      method: "GET",
      url: `/v1/chats/${groupId}/members?limit=100`,
      headers: auth(owner)
    });
    expect(full.statusCode, full.body).toBe(200);
    const fullIds = full.json().items.map((member: { membership: { userId: string } }) => member.membership.userId);
    expect(full.json().nextCursor).toBeNull();

    const paged = await collectPages(`/v1/chats/${groupId}/members?limit=1`, owner);
    expectNoDuplicates(paged);
    expect(paged.map(({ id }) => id)).toEqual(fullIds);
    expect(paged).toHaveLength(3);
    await expectGarbageCursor400(`/v1/chats/${groupId}/members`, owner);
  });

  it("paginates topics in stable creation order", async () => {
    app = await buildApp({ config: testConfig(), logger: false });
    const owner = await register("page_topics_owner");
    const groupId = await createGroup(owner, "Topics page");
    for (const title of ["one", "two", "three"]) {
      const created = await app.inject({
        method: "POST",
        url: `/v1/chats/${groupId}/topics`,
        headers: auth(owner),
        payload: { title: `Topic ${title}` }
      });
      expect(created.statusCode, created.body).toBe(201);
    }

    const full = await app!.inject({
      method: "GET",
      url: `/v1/chats/${groupId}/topics?limit=100`,
      headers: auth(owner)
    });
    expect(full.statusCode, full.body).toBe(200);
    const fullIds = full.json().items.map((topic: { id: string }) => topic.id);

    const paged = await collectPages(`/v1/chats/${groupId}/topics?limit=2`, owner);
    expectNoDuplicates(paged);
    expect(paged.map(({ id }) => id)).toEqual(fullIds);
    await expectGarbageCursor400(`/v1/chats/${groupId}/topics`, owner);
  });

  it("paginates invite links instead of silently truncating them", async () => {
    app = await buildApp({ config: testConfig(), logger: false });
    const owner = await register("page_links_owner");
    const groupId = await createGroup(owner, "Links page");
    const linkIds: string[] = [];
    for (let index = 0; index < 3; index += 1) {
      const created = await app.inject({
        method: "POST",
        url: `/v1/chats/${groupId}/invite-links`,
        headers: auth(owner),
        payload: { clientNonce: randomUUID() }
      });
      expect(created.statusCode, created.body).toBe(201);
      linkIds.push(created.json().invite.id as string);
    }

    const full = await app!.inject({
      method: "GET",
      url: `/v1/chats/${groupId}/invite-links?limit=100`,
      headers: auth(owner)
    });
    expect(full.statusCode, full.body).toBe(200);
    const fullIds = full.json().items.map((link: { id: string }) => link.id);
    expect(new Set(fullIds)).toEqual(new Set(linkIds));

    const paged = await collectPages(`/v1/chats/${groupId}/invite-links?limit=1`, owner);
    expectNoDuplicates(paged);
    expect(paged.map(({ id }) => id)).toEqual(fullIds);
    await expectGarbageCursor400(`/v1/chats/${groupId}/invite-links`, owner);
  });

  it("paginates approval join requests", async () => {
    app = await buildApp({ config: testConfig(), logger: false });
    const owner = await register("page_join_owner");
    const guestOne = await register("page_join_guest_one");
    const guestTwo = await register("page_join_guest_two");
    const groupId = await createGroup(owner, "Join queue page");

    const link = await app.inject({
      method: "POST",
      url: `/v1/chats/${groupId}/invite-links`,
      headers: auth(owner),
      payload: { approvalRequired: true, clientNonce: randomUUID() }
    });
    expect(link.statusCode, link.body).toBe(201);
    const token = link.json().token as string;
    for (const guest of [guestOne, guestTwo]) {
      const joined = await app.inject({
        method: "POST",
        url: "/v1/invite-links/join",
        headers: auth(guest),
        payload: { token, clientNonce: randomUUID() }
      });
      expect(joined.statusCode, joined.body).toBe(201);
      expect(joined.json().outcome).toBe("pending");
    }

    const full = await app.inject({
      method: "GET",
      url: `/v1/chats/${groupId}/join-requests?limit=100`,
      headers: auth(owner)
    });
    expect(full.statusCode, full.body).toBe(200);
    const fullIds = full.json().items.map((request: { id: string }) => request.id);

    const paged = await collectPages(`/v1/chats/${groupId}/join-requests?limit=1`, owner);
    expectNoDuplicates(paged);
    expect(paged.map(({ id }) => id)).toEqual(fullIds);
    expect(paged).toHaveLength(2);
    await expectGarbageCursor400(`/v1/chats/${groupId}/join-requests`, owner);
  });

  it("paginates message revision history newest first", async () => {
    app = await buildApp({ config: testConfig(), logger: false });
    const alice = await register("page_history_alice");
    const bob = await register("page_history_bob");
    const chatId = await createDirect(alice, bob);
    const sent = await app.inject({
      method: "POST",
      url: `/v1/chats/${chatId}/messages`,
      headers: auth(alice),
      payload: { body: "version 0", clientNonce: randomUUID() }
    });
    expect(sent.statusCode, sent.body).toBe(201);
    const messageId = sent.json().message.id as string;
    let revision = 0;
    for (let index = 1; index <= 3; index += 1) {
      const edited = await app.inject({
        method: "PATCH",
        url: `/v1/messages/${messageId}`,
        headers: auth(alice),
        payload: { body: `version ${index}`, expectedRevision: revision }
      });
      expect(edited.statusCode, edited.body).toBe(200);
      revision = edited.json().message.revision as number;
    }
    expect(revision).toBe(3);

    const paged = await collectPages(`/v1/messages/${messageId}/history?limit=2`, alice);
    expect(paged.map(({ revision: value }) => value)).toEqual([2, 1, 0]);
    expectNoDuplicates(paged);
    await expectGarbageCursor400(`/v1/messages/${messageId}/history`, alice);
  });

  it("paginates call history beyond the previous hard cap", async () => {
    app = await buildApp({ config: testConfig(), logger: false });
    const alice = await register("page_calls_alice");
    const bob = await register("page_calls_bob");
    const chatId = await createDirect(alice, bob);
    const callIds: string[] = [];
    for (let index = 0; index < 3; index += 1) {
      const created = await app.inject({
        method: "POST",
        url: "/v1/calls",
        headers: auth(alice),
        payload: { chatId, mediaMode: "audio", clientNonce: randomUUID() }
      });
      expect(created.statusCode, created.body).toBe(201);
      const callId = created.json().call.callId as string;
      callIds.push(callId);
      const ring = await app.inject({
        method: "POST",
        url: `/v1/calls/${callId}/ring`,
        headers: auth(alice),
        payload: { expectedRevision: created.json().call.revision }
      });
      expect(ring.statusCode, ring.body).toBe(200);
      const declined = await app.inject({
        method: "POST",
        url: `/v1/calls/${callId}/decline`,
        headers: auth(bob),
        payload: { expectedRevision: ring.json().call.revision, reason: "declined" }
      });
      expect(declined.statusCode, declined.body).toBe(200);
    }

    const paged = await collectPages(`/v1/calls?chatId=${chatId}&limit=2`, bob, "calls");
    expectNoDuplicates(paged);
    expect(new Set(paged.map(({ id }) => id))).toEqual(new Set(callIds));

    const tooLarge = await app.inject({
      method: "GET",
      url: `/v1/calls?chatId=${chatId}&limit=51`,
      headers: auth(alice)
    });
    expect(tooLarge.statusCode).toBe(400);
    expect(tooLarge.json().error.code).toBe("VALIDATION_FAILED");
    await expectGarbageCursor400(`/v1/calls?chatId=${chatId}`, alice);
  });

  it("paginates device sessions and keeps the current flag on its page", async () => {
    app = await buildApp({ config: testConfig(), logger: false });
    const alice = await registerNamed("page_sessions_alice");
    for (let index = 0; index < 3; index += 1) {
      const response = await app.inject({
        method: "POST",
        url: "/v1/auth/login",
        payload: { username: alice.username, password: alice.password, deviceName: `device ${index}` }
      });
      expect(response.statusCode, response.body).toBe(200);
    }

    const full = await app.inject({
      method: "GET",
      url: "/v1/auth/sessions?limit=100",
      headers: auth(alice)
    });
    expect(full.statusCode, full.body).toBe(200);
    const fullIds = full.json().items.map((session: { id: string }) => session.id);
    expect(fullIds).toHaveLength(4);

    const paged: string[] = [];
    const currentSessionIds: string[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 10; page += 1) {
      const suffix: string = cursor === null ? "" : `&cursor=${encodeURIComponent(cursor)}`;
      const response = await app.inject({
        method: "GET",
        url: `/v1/auth/sessions?limit=2${suffix}`,
        headers: auth(alice)
      });
      expect(response.statusCode, response.body).toBe(200);
      const body = response.json() as {
        items: Array<{ id: string; current: boolean }>;
        nextCursor: string | null;
      };
      paged.push(...body.items.map((session) => session.id));
      currentSessionIds.push(
        ...body.items.filter((session) => session.current).map((session) => session.id)
      );
      cursor = body.nextCursor;
      if (cursor === null) break;
    }
    expect(new Set(paged).size).toBe(paged.length);
    expect(new Set(paged)).toEqual(new Set(fullIds));
    expect(currentSessionIds).toHaveLength(1);
    expect(currentSessionIds[0]).toBe(
      full.json().items.find((session: { current: boolean }) => session.current).id
    );
    await expectGarbageCursor400("/v1/auth/sessions", alice);
  });

  it("keeps authorization denials consistent on every page", async () => {
    app = await buildApp({ config: testConfig(), logger: false });
    const owner = await register("page_authz_owner");
    const member = await register("page_authz_member");
    const outsider = await register("page_authz_outsider");
    await establishAcceptedRelationship(app, owner, { id: member.id, accessToken: member.accessToken });
    const groupId = await createGroup(owner, "Authz page", [member.id]);

    const firstPage = await app.inject({
      method: "GET",
      url: `/v1/chats/${groupId}/members?limit=1`,
      headers: auth(owner)
    });
    expect(firstPage.statusCode, firstPage.body).toBe(200);
    const nextCursor = firstPage.json().nextCursor as string;
    expect(typeof nextCursor).toBe("string");

    for (const url of [
      `/v1/chats/${groupId}/members?limit=1&cursor=${encodeURIComponent(nextCursor)}`,
      `/v1/chats/${randomUUID()}/members?limit=1&cursor=${encodeURIComponent(nextCursor)}`
    ]) {
      const denied = await app.inject({ method: "GET", url, headers: auth(outsider) });
      expect(denied.statusCode, url).toBe(403);
      expect(denied.json().error.code).toBe("FORBIDDEN");
      expect(JSON.stringify(denied.json())).not.toContain("Authz page");
    }
  });

  it("keeps message pages complete when several messages share one timestamp", async () => {
    app = await buildApp({ config: testConfig(), logger: false });
    const alice = await register("page_same_ts_alice");
    const bob = await register("page_same_ts_bob");
    const chatId = await createDirect(alice, bob);
    const sharedTimestamp = "2026-10-31T12:00:00.000Z";
    for (let index = 0; index < 4; index += 1) {
      app.luxora.store.createMessage({
        id: randomUUID(),
        chatId,
        senderId: alice.id,
        body: `same timestamp ${index}`,
        replyToMessageId: null,
        topicId: null,
        forwardedFromMessageId: null,
        forwardedFromChatId: null,
        forwardedFromSenderId: null,
        forwardedFromSenderName: null,
        forwardedFromCreatedAt: null,
        forwardSourceMessageId: null,
        clientNonce: randomUUID(),
        createdAt: sharedTimestamp,
        transcriptionConsent: false
      });
    }
    const full = await app.inject({
      method: "GET",
      url: `/v1/chats/${chatId}/messages?limit=100`,
      headers: auth(alice)
    });
    expect(full.statusCode, full.body).toBe(200);
    const fullIds = full.json().items.map((message: { id: string }) => message.id);

    const paged = await collectPages(`/v1/chats/${chatId}/messages?limit=1`, alice);
    expectNoDuplicates(paged);
    expect(paged.map(({ id }) => id)).toEqual(fullIds);
  });
});
