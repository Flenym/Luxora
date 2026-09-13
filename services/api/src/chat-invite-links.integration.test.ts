import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import {
  ChatInviteLinkListResponseSchema,
  ChatMembershipMutationResponseSchema,
  CreateChatInviteLinkResponseSchema,
  RevokeChatInviteLinkResponseSchema
} from "@luxora/protocol";
import type { LuxoraApp } from "./app.js";
import { buildApp } from "./app.js";
import { establishAcceptedRelationship, testConfig } from "./test-helpers.js";

interface Identity {
  id: string;
  accessToken: string;
}

async function withFixedClock<T>(iso: string, operation: () => Promise<T>): Promise<T> {
  const NativeDate = globalThis.Date;
  const fixedMilliseconds = new NativeDate(iso).getTime();
  class FixedDate extends NativeDate {
    constructor(value?: string | number) {
      if (arguments.length === 0) super(fixedMilliseconds);
      else super(value as string | number);
    }

    static override now(): number {
      return fixedMilliseconds;
    }
  }
  globalThis.Date = FixedDate as DateConstructor;
  try {
    return await operation();
  } finally {
    globalThis.Date = NativeDate;
  }
}

describe("chat invite links", () => {
  let app: LuxoraApp | undefined;
  const temporaryDirectories: string[] = [];

  afterEach(async () => {
    await app?.close();
    app = undefined;
    for (const directory of temporaryDirectories.splice(0)) {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  async function fixture(): Promise<{ databasePath: string }> {
    const directory = mkdtempSync(join(tmpdir(), "luxora-invite-"));
    temporaryDirectories.push(directory);
    const databasePath = join(directory, "luxora.sqlite");
    app = await buildApp({ config: testConfig({ databasePath }), logger: false });
    return { databasePath };
  }

  async function register(username: string): Promise<Identity> {
    const response = await app!.inject({
      method: "POST",
      url: "/v1/auth/register",
      payload: {
        username,
        displayName: username,
        password: "correct horse battery staple"
      }
    });
    expect(response.statusCode).toBe(201);
    return {
      id: response.json().user.id as string,
      accessToken: response.json().tokens.accessToken as string
    };
  }

  function auth(identity: Identity): { authorization: string } {
    return { authorization: `Bearer ${identity.accessToken}` };
  }

  async function createGroup(owner: Identity, title = "Invite test group"): Promise<string> {
    const response = await app!.inject({
      method: "POST",
      url: "/v1/chats",
      headers: auth(owner),
      payload: { kind: "group", title, memberIds: [] }
    });
    expect(response.statusCode).toBe(201);
    return response.json().chat.id as string;
  }

  async function createLink(
    actor: Identity,
    chatId: string,
    payload: Record<string, unknown> = { clientNonce: randomUUID() }
  ) {
    return app!.inject({
      method: "POST",
      url: `/v1/chats/${chatId}/invite-links`,
      headers: auth(actor),
      payload
    });
  }

  it("creates links for owners/admins and never persists the raw bearer token", async () => {
    const { databasePath } = await fixture();
    const owner = await register("invite_owner");
    const chatId = await createGroup(owner);

    const created = await createLink(owner, chatId, { maxUses: 5, clientNonce: randomUUID() });
    expect(created.statusCode).toBe(201);
    const body = CreateChatInviteLinkResponseSchema.parse(created.json());
    expect(body.replayed).toBe(false);
    expect(body.invite.chatId).toBe(chatId);
    expect(body.invite.createdBy).toBe(owner.id);
    expect(body.invite.maxUses).toBe(5);
    expect(body.invite.useCount).toBe(0);
    expect(body.invite.revokedAt).toBeNull();
    expect(body.token).toMatch(/^[A-Za-z0-9_-]{43}$/u);

    const listed = await app!.inject({
      method: "GET",
      url: `/v1/chats/${chatId}/invite-links`,
      headers: auth(owner)
    });
    expect(listed.statusCode).toBe(200);
    const links = ChatInviteLinkListResponseSchema.parse(listed.json());
    expect(links.items).toHaveLength(1);
    expect(links.items[0]!.id).toBe(body.invite.id);
    expect(JSON.stringify(listed.json())).not.toContain(body.token);

    const database = new Database(databasePath, { readonly: true });
    const rows = database.prepare("SELECT token_digest FROM chat_invite_links").all() as Array<{
      token_digest: string;
    }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.token_digest).toMatch(/^[0-9a-f]{64}$/u);
    expect(rows[0]!.token_digest).not.toBe(body.token);
    database.close();

    await app!.close();
    app = undefined;
    expect(readFileSync(databasePath).includes(Buffer.from(body.token, "utf8"))).toBe(false);
  });

  it("restricts management to administrators and rejects direct chats", async () => {
    await fixture();
    const owner = await register("invite_admin_owner");
    const member = await register("invite_plain_member");
    const outsider = await register("invite_outsider");
    const chatId = await createGroup(owner);

    await establishAcceptedRelationship(app!, owner, member);
    const added = await app!.inject({
      method: "POST",
      url: `/v1/chats/${chatId}/members`,
      headers: auth(owner),
      payload: { userId: member.id, role: "admin", clientNonce: randomUUID() }
    });
    expect(added.statusCode).toBe(201);

    const byAdmin = await createLink(member, chatId);
    expect(byAdmin.statusCode).toBe(201);

    const demoted = await app!.inject({
      method: "PATCH",
      url: `/v1/chats/${chatId}/members/${member.id}`,
      headers: auth(owner),
      payload: { role: "member", expectedRevision: 1, clientNonce: randomUUID() }
    });
    expect(demoted.statusCode).toBe(200);

    expect((await createLink(member, chatId)).statusCode).toBe(403);
    expect((await app!.inject({
      method: "GET",
      url: `/v1/chats/${chatId}/invite-links`,
      headers: auth(member)
    })).statusCode).toBe(403);
    expect((await createLink(outsider, chatId)).statusCode).toBe(403);

    const direct = await app!.inject({
      method: "POST",
      url: "/v1/chats",
      headers: auth(owner),
      payload: { kind: "direct", userId: outsider.id }
    });
    expect(direct.statusCode).toBe(201);
    expect((await createLink(owner, direct.json().chat.id as string)).statusCode).toBe(409);
  });

  it("refuses to reshow a token for a reused creation nonce", async () => {
    await fixture();
    const owner = await register("invite_nonce_owner");
    const chatId = await createGroup(owner);
    const clientNonce = randomUUID();

    const first = await createLink(owner, chatId, { clientNonce });
    expect(first.statusCode).toBe(201);

    const second = await createLink(owner, chatId, { clientNonce });
    expect(second.statusCode).toBe(409);
    expect(second.json().error.details).toMatchObject({
      reason: "invite_token_shown_once",
      inviteId: first.json().invite.id as string
    });
  });

  it("admits holders as members with idempotent join and exact nonce replay", async () => {
    await fixture();
    const owner = await register("invite_join_owner");
    const guest = await register("invite_join_guest");
    const chatId = await createGroup(owner);

    const created = await createLink(owner, chatId);
    expect(created.statusCode).toBe(201);
    const token = created.json().token as string;

    const joinNonce = randomUUID();
    const joined = await app!.inject({
      method: "POST",
      url: "/v1/invite-links/join",
      headers: auth(guest),
      payload: { token, clientNonce: joinNonce }
    });
    expect(joined.statusCode).toBe(201);
    const membership = ChatMembershipMutationResponseSchema.parse(joined.json());
    expect(membership.replayed).toBe(false);
    expect(membership.membership).toMatchObject({ chatId, userId: guest.id, role: "member" });

    const members = await app!.inject({
      method: "GET",
      url: `/v1/chats/${chatId}/members`,
      headers: auth(owner)
    });
    expect(members.statusCode).toBe(200);
    expect((members.json().items as Array<{ membership: { userId: string } }>)
      .map(({ membership: item }) => item.userId).sort())
      .toEqual([guest.id, owner.id].sort());

    const chats = await app!.inject({
      method: "GET",
      url: "/v1/chats",
      headers: auth(guest)
    });
    expect(chats.statusCode).toBe(200);
    expect((chats.json().items as Array<{ id: string }>).map(({ id }) => id)).toContain(chatId);

    const rejoin = await app!.inject({
      method: "POST",
      url: "/v1/invite-links/join",
      headers: auth(guest),
      payload: { token, clientNonce: randomUUID() }
    });
    expect(rejoin.statusCode).toBe(201);
    expect(ChatMembershipMutationResponseSchema.parse(rejoin.json())).toMatchObject({ replayed: true });

    const replay = await app!.inject({
      method: "POST",
      url: "/v1/invite-links/join",
      headers: auth(guest),
      payload: { token, clientNonce: joinNonce }
    });
    expect(replay.statusCode).toBe(201);
    expect(ChatMembershipMutationResponseSchema.parse(replay.json())).toMatchObject({ replayed: true });
  });

  it("rejects nonce reuse across different links", async () => {
    await fixture();
    const owner = await register("invite_cross_owner");
    const guest = await register("invite_cross_guest");
    const chatId = await createGroup(owner);

    const first = await createLink(owner, chatId);
    const second = await createLink(owner, chatId);
    const sharedNonce = randomUUID();

    const joined = await app!.inject({
      method: "POST",
      url: "/v1/invite-links/join",
      headers: auth(guest),
      payload: { token: first.json().token as string, clientNonce: sharedNonce }
    });
    expect(joined.statusCode).toBe(201);

    const crossed = await app!.inject({
      method: "POST",
      url: "/v1/invite-links/join",
      headers: auth(guest),
      payload: { token: second.json().token as string, clientNonce: sharedNonce }
    });
    expect(crossed.statusCode).toBe(409);
  });

  it("fails closed on unknown, revoked, expired and exhausted links", async () => {
    await fixture();
    const owner = await register("invite_dead_owner");
    const guest = await register("invite_dead_guest");
    const chatId = await createGroup(owner);

    const unknown = await app!.inject({
      method: "POST",
      url: "/v1/invite-links/join",
      headers: auth(guest),
      payload: {
        token: `${randomUUID().replace(/-/gu, "").slice(0, 32)}AAAAAAAAAAA`,
        clientNonce: randomUUID()
      }
    });
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json().error.details).toMatchObject({ reason: "invite_link_invalid" });

    const malformed = await app!.inject({
      method: "POST",
      url: "/v1/invite-links/join",
      headers: auth(guest),
      payload: { token: "not-a-token", clientNonce: randomUUID() }
    });
    expect(malformed.statusCode).toBe(400);

    const created = await withFixedClock("2026-09-13T12:00:00.000Z", async () =>
      createLink(owner, chatId, { expiresInSeconds: 60, clientNonce: randomUUID() }));
    expect(created.statusCode).toBe(201);
    const expiringToken = created.json().token as string;
    const expiredJoin = await withFixedClock("2026-09-13T12:02:00.000Z", async () =>
      app!.inject({
        method: "POST",
        url: "/v1/invite-links/join",
        headers: auth(guest),
        payload: { token: expiringToken, clientNonce: randomUUID() }
      }));
    expect(expiredJoin.statusCode).toBe(404);
    expect(expiredJoin.json().error.details).toMatchObject({ reason: "invite_link_expired" });

    const single = await createLink(owner, chatId, { maxUses: 1, clientNonce: randomUUID() });
    expect(single.statusCode).toBe(201);
    const singleToken = single.json().token as string;
    expect((await app!.inject({
      method: "POST",
      url: "/v1/invite-links/join",
      headers: auth(guest),
      payload: { token: singleToken, clientNonce: randomUUID() }
    })).statusCode).toBe(201);

    const secondGuest = await register("invite_dead_second");
    const exhausted = await app!.inject({
      method: "POST",
      url: "/v1/invite-links/join",
      headers: auth(secondGuest),
      payload: { token: singleToken, clientNonce: randomUUID() }
    });
    expect(exhausted.statusCode).toBe(404);
    expect(exhausted.json().error.details).toMatchObject({ reason: "invite_link_exhausted" });

    const revokable = await createLink(owner, chatId);
    const revokableToken = revokable.json().token as string;
    const revoked = await app!.inject({
      method: "DELETE",
      url: `/v1/chats/${chatId}/invite-links/${revokable.json().invite.id as string}`,
      headers: auth(owner)
    });
    expect(revoked.statusCode).toBe(200);
    expect(RevokeChatInviteLinkResponseSchema.parse(revoked.json())).toMatchObject({ replayed: false });

    const revokedReplay = await app!.inject({
      method: "DELETE",
      url: `/v1/chats/${chatId}/invite-links/${revokable.json().invite.id as string}`,
      headers: auth(owner)
    });
    expect(revokedReplay.statusCode).toBe(200);
    expect(RevokeChatInviteLinkResponseSchema.parse(revokedReplay.json())).toMatchObject({ replayed: true });

    const revokedJoin = await app!.inject({
      method: "POST",
      url: "/v1/invite-links/join",
      headers: auth(secondGuest),
      payload: { token: revokableToken, clientNonce: randomUUID() }
    });
    expect(revokedJoin.statusCode).toBe(404);
    expect(revokedJoin.json().error.details).toMatchObject({ reason: "invite_link_revoked" });

    const foreignRevoke = await app!.inject({
      method: "DELETE",
      url: `/v1/chats/${chatId}/invite-links/${randomUUID()}`,
      headers: auth(owner)
    });
    expect(foreignRevoke.statusCode).toBe(404);
  });
});
