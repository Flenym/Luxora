import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ChatJoinRequestListResponseSchema,
  CreateChatInviteLinkResponseSchema,
  DecideChatJoinRequestResponseSchema,
  JoinChatByInviteResponseSchema
} from "@luxora/protocol";
import type { LuxoraApp } from "./app.js";
import { buildApp } from "./app.js";
import { establishAcceptedRelationship, testConfig } from "./test-helpers.js";

interface Identity {
  id: string;
  accessToken: string;
}

describe("chat join request approval", () => {
  let app: LuxoraApp | undefined;
  const temporaryDirectories: string[] = [];

  afterEach(async () => {
    await app?.close();
    app = undefined;
    for (const directory of temporaryDirectories.splice(0)) {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  async function fixture(): Promise<void> {
    const directory = mkdtempSync(join(tmpdir(), "luxora-join-req-"));
    temporaryDirectories.push(directory);
    app = await buildApp({
      config: testConfig({ databasePath: join(directory, "luxora.sqlite") }),
      logger: false
    });
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

  async function createGroup(owner: Identity): Promise<string> {
    const response = await app!.inject({
      method: "POST",
      url: "/v1/chats",
      headers: auth(owner),
      payload: { kind: "group", title: "Approval test group", memberIds: [] }
    });
    expect(response.statusCode).toBe(201);
    return response.json().chat.id as string;
  }

  async function createApprovalLink(owner: Identity, chatId: string): Promise<string> {
    const created = await app!.inject({
      method: "POST",
      url: `/v1/chats/${chatId}/invite-links`,
      headers: auth(owner),
      payload: { approvalRequired: true, clientNonce: randomUUID() }
    });
    expect(created.statusCode).toBe(201);
    const body = CreateChatInviteLinkResponseSchema.parse(created.json());
    expect(body.invite.approvalRequired).toBe(true);
    return body.token;
  }

  async function joinByLink(
    guest: Identity,
    token: string,
    clientNonce = randomUUID()
  ) {
    return app!.inject({
      method: "POST",
      url: "/v1/invite-links/join",
      headers: auth(guest),
      payload: { token, clientNonce }
    });
  }

  async function decide(
    actor: Identity,
    chatId: string,
    requestId: string,
    decision: "approve" | "deny"
  ) {
    return app!.inject({
      method: "POST",
      url: `/v1/chats/${chatId}/join-requests/${requestId}/${decision}`,
      headers: auth(actor)
    });
  }

  it("queues approval joins as pending without membership or use consumption", async () => {
    await fixture();
    const owner = await register("approval_owner");
    const guest = await register("approval_guest");
    const chatId = await createGroup(owner);
    const token = await createApprovalLink(owner, chatId);

    const response = await joinByLink(guest, token);
    expect(response.statusCode).toBe(201);
    const parsed = JoinChatByInviteResponseSchema.parse(response.json());
    expect(parsed.outcome).toBe("pending");
    if (parsed.outcome !== "pending") throw new Error("Expected a pending request");
    expect(parsed.replayed).toBe(false);
    expect(parsed.request).toMatchObject({
      chatId,
      userId: guest.id,
      state: "pending",
      decidedBy: null,
      decidedAt: null
    });

    const members = await app!.inject({
      method: "GET",
      url: `/v1/chats/${chatId}/members`,
      headers: auth(owner)
    });
    expect((members.json().items as Array<unknown>)).toHaveLength(1);

    const listed = await app!.inject({
      method: "GET",
      url: `/v1/chats/${chatId}/invite-links`,
      headers: auth(owner)
    });
    expect(listed.json().items[0].useCount).toBe(0);

    const queue = await app!.inject({
      method: "GET",
      url: `/v1/chats/${chatId}/join-requests`,
      headers: auth(owner)
    });
    expect(queue.statusCode).toBe(200);
    const requests = ChatJoinRequestListResponseSchema.parse(queue.json());
    expect(requests.items).toHaveLength(1);
    expect(requests.items[0]!.id).toBe(parsed.request.id);

    const guestQueue = await app!.inject({
      method: "GET",
      url: `/v1/chats/${chatId}/join-requests`,
      headers: auth(guest)
    });
    expect(guestQueue.statusCode).toBe(403);
  });

  it("replays duplicate requests and rejects nonce reuse across links", async () => {
    await fixture();
    const owner = await register("approval_dup_owner");
    const guest = await register("approval_dup_guest");
    const chatId = await createGroup(owner);
    const firstToken = await createApprovalLink(owner, chatId);
    const secondToken = await createApprovalLink(owner, chatId);
    const clientNonce = randomUUID();

    const first = JoinChatByInviteResponseSchema.parse((await joinByLink(guest, firstToken, clientNonce)).json());
    const replay = JoinChatByInviteResponseSchema.parse((await joinByLink(guest, firstToken, clientNonce)).json());
    expect(replay).toMatchObject({ outcome: "pending", replayed: true });
    if (first.outcome !== "pending" || replay.outcome !== "pending") {
      throw new Error("Expected pending requests");
    }
    expect(replay.request.id).toBe(first.request.id);

    const crossed = await joinByLink(guest, secondToken, clientNonce);
    expect(crossed.statusCode).toBe(409);
  });

  it("approves with membership, use consumption and idempotent replay", async () => {
    await fixture();
    const owner = await register("approval_ok_owner");
    const admin = await register("approval_ok_admin");
    const guest = await register("approval_ok_guest");
    const chatId = await createGroup(owner);
    await establishAcceptedRelationship(app!, owner, admin);
    expect((await app!.inject({
      method: "POST",
      url: `/v1/chats/${chatId}/members`,
      headers: auth(owner),
      payload: { userId: admin.id, role: "admin", clientNonce: randomUUID() }
    })).statusCode).toBe(201);

    const token = await createApprovalLink(owner, chatId);
    const pending = JoinChatByInviteResponseSchema.parse((await joinByLink(guest, token)).json());
    if (pending.outcome !== "pending") throw new Error("Expected a pending request");

    const approved = await decide(admin, chatId, pending.request.id, "approve");
    expect(approved.statusCode).toBe(200);
    const decision = DecideChatJoinRequestResponseSchema.parse(approved.json());
    expect(decision.replayed).toBe(false);
    expect(decision.request).toMatchObject({
      state: "approved",
      decidedBy: admin.id
    });
    expect(decision.request.decidedAt).not.toBeNull();
    expect(decision.membership).toMatchObject({ chatId, userId: guest.id, role: "member" });

    const links = await app!.inject({
      method: "GET",
      url: `/v1/chats/${chatId}/invite-links`,
      headers: auth(owner)
    });
    expect(links.json().items[0].useCount).toBe(1);

    const members = await app!.inject({
      method: "GET",
      url: `/v1/chats/${chatId}/members`,
      headers: auth(owner)
    });
    expect((members.json().items as Array<{ membership: { userId: string } }>)
      .map(({ membership }) => membership.userId)).toContain(guest.id);

    const replay = DecideChatJoinRequestResponseSchema.parse(
      (await decide(owner, chatId, pending.request.id, "approve")).json()
    );
    expect(replay).toMatchObject({ replayed: true });
    expect(replay.request.state).toBe("approved");
    expect(replay.membership).toMatchObject({ userId: guest.id });
  });

  it("denies without membership and allows a fresh request afterwards", async () => {
    await fixture();
    const owner = await register("approval_deny_owner");
    const guest = await register("approval_deny_guest");
    const chatId = await createGroup(owner);
    const token = await createApprovalLink(owner, chatId);

    const pending = JoinChatByInviteResponseSchema.parse((await joinByLink(guest, token)).json());
    if (pending.outcome !== "pending") throw new Error("Expected a pending request");

    const denied = await decide(owner, chatId, pending.request.id, "deny");
    expect(denied.statusCode).toBe(200);
    const decision = DecideChatJoinRequestResponseSchema.parse(denied.json());
    expect(decision.request).toMatchObject({ state: "denied", decidedBy: owner.id });
    expect(decision.membership).toBeNull();

    const deniedReplay = DecideChatJoinRequestResponseSchema.parse(
      (await decide(owner, chatId, pending.request.id, "deny")).json()
    );
    expect(deniedReplay).toMatchObject({ replayed: true });

    const retry = JoinChatByInviteResponseSchema.parse((await joinByLink(guest, token)).json());
    expect(retry.outcome).toBe("pending");
    if (retry.outcome !== "pending") throw new Error("Expected a fresh pending request");
    expect(retry.replayed).toBe(false);
    expect(retry.request.id).not.toBe(pending.request.id);
  });

  it("restricts decisions to managers and keeps foreign requests invisible", async () => {
    await fixture();
    const owner = await register("approval_acl_owner");
    const stranger = await register("approval_acl_stranger");
    const otherOwner = await register("approval_acl_other");
    const chatId = await createGroup(owner);
    const otherChatId = await createGroup(otherOwner);
    const token = await createApprovalLink(owner, chatId);
    const guest = await register("approval_acl_guest");

    const pending = JoinChatByInviteResponseSchema.parse((await joinByLink(guest, token)).json());
    if (pending.outcome !== "pending") throw new Error("Expected a pending request");

    expect((await decide(stranger, chatId, pending.request.id, "approve")).statusCode).toBe(403);
    expect((await decide(otherOwner, otherChatId, pending.request.id, "approve")).statusCode).toBe(404);
    expect((await decide(owner, chatId, randomUUID(), "deny")).statusCode).toBe(404);

    const stillPending = await app!.inject({
      method: "GET",
      url: `/v1/chats/${chatId}/join-requests`,
      headers: auth(owner)
    });
    expect(stillPending.json().items[0].state).toBe("pending");
  });

  it("fails an approval when the link died while the request was pending", async () => {
    await fixture();
    const owner = await register("approval_dead_owner");
    const guest = await register("approval_dead_guest");
    const chatId = await createGroup(owner);
    const token = await createApprovalLink(owner, chatId);

    const pending = JoinChatByInviteResponseSchema.parse((await joinByLink(guest, token)).json());
    if (pending.outcome !== "pending") throw new Error("Expected a pending request");

    const links = await app!.inject({
      method: "GET",
      url: `/v1/chats/${chatId}/invite-links`,
      headers: auth(owner)
    });
    const revoke = await app!.inject({
      method: "DELETE",
      url: `/v1/chats/${chatId}/invite-links/${links.json().items[0].id as string}`,
      headers: auth(owner)
    });
    expect(revoke.statusCode).toBe(200);

    const approved = await decide(owner, chatId, pending.request.id, "approve");
    expect(approved.statusCode).toBe(404);
    expect(approved.json().error.details).toMatchObject({ reason: "invite_link_revoked" });

    const queue = await app!.inject({
      method: "GET",
      url: `/v1/chats/${chatId}/join-requests`,
      headers: auth(owner)
    });
    expect(queue.json().items[0].state).toBe("pending");
  });
});
