import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ChatOwnershipTransferResponseSchema
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

describe("chat ownership transfer ceremony", () => {
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
    const directory = mkdtempSync(join(tmpdir(), "luxora-ownership-"));
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

  async function login(username: string): Promise<Identity> {
    const response = await app!.inject({
      method: "POST",
      url: "/v1/auth/login",
      payload: {
        username,
        password: "correct horse battery staple",
        deviceName: `${username} relogin`
      }
    });
    expect(response.statusCode).toBe(200);
    return {
      id: response.json().user.id as string,
      accessToken: response.json().tokens.accessToken as string
    };
  }

  async function createGroup(owner: Identity, memberIds: string[] = []): Promise<string> {
    const response = await app!.inject({
      method: "POST",
      url: "/v1/chats",
      headers: auth(owner),
      payload: { kind: "group", title: "Ownership test group", memberIds }
    });
    expect(response.statusCode).toBe(201);
    return response.json().chat.id as string;
  }

  async function initiate(owner: Identity, chatId: string, targetUserId: string, clientNonce = randomUUID()) {
    return app!.inject({
      method: "POST",
      url: `/v1/chats/${chatId}/ownership-transfers`,
      headers: auth(owner),
      payload: { targetUserId, clientNonce }
    });
  }

  async function members(actor: Identity, chatId: string) {
    const response = await app!.inject({
      method: "GET",
      url: `/v1/chats/${chatId}/members`,
      headers: auth(actor)
    });
    expect(response.statusCode).toBe(200);
    return response.json().items as Array<{
      membership: { userId: string; role: string; revision: number };
    }>;
  }

  it("swaps owner and admin roles atomically on accept with exact replay", async () => {
    await fixture();
    const owner = await register("transfer_owner");
    const successor = await register("transfer_successor");
    await establishAcceptedRelationship(app!, owner, successor);
    const chatId = await createGroup(owner, [successor.id]);

    const nonce = randomUUID();
    const created = await initiate(owner, chatId, successor.id, nonce);
    expect(created.statusCode).toBe(201);
    const body = ChatOwnershipTransferResponseSchema.parse(created.json());
    expect(body.replayed).toBe(false);
    expect(body.transfer).toMatchObject({
      chatId,
      fromUserId: owner.id,
      toUserId: successor.id,
      state: "pending",
      decidedAt: null,
      decidedBy: null
    });

    const replay = ChatOwnershipTransferResponseSchema.parse(
      (await initiate(owner, chatId, successor.id, nonce)).json()
    );
    expect(replay).toMatchObject({ replayed: true });
    expect(replay.transfer.id).toBe(body.transfer.id);

    const accepted = await app!.inject({
      method: "POST",
      url: `/v1/chats/${chatId}/ownership-transfers/${body.transfer.id}/accept`,
      headers: auth(successor)
    });
    expect(accepted.statusCode).toBe(200);
    const decision = ChatOwnershipTransferResponseSchema.parse(accepted.json());
    expect(decision.replayed).toBe(false);
    expect(decision.transfer).toMatchObject({ state: "accepted", decidedBy: successor.id });
    expect(decision.transfer.decidedAt).not.toBeNull();

    const roles = new Map((await members(successor, chatId)).map(({ membership }) => [membership.userId, membership]));
    expect(roles.get(successor.id)).toMatchObject({ role: "owner", revision: 2 });
    expect(roles.get(owner.id)).toMatchObject({ role: "admin", revision: 2 });

    // The previous owner is an ordinary admin now: removable, and the new
    // owner holds the sole-owner invariant alone.
    const removed = await app!.inject({
      method: "DELETE",
      url: `/v1/chats/${chatId}/members/${owner.id}`,
      headers: auth(successor),
      payload: { expectedRevision: 2, clientNonce: randomUUID() }
    });
    expect(removed.statusCode).toBe(200);

    const acceptReplay = ChatOwnershipTransferResponseSchema.parse(
      (await app!.inject({
        method: "POST",
        url: `/v1/chats/${chatId}/ownership-transfers/${body.transfer.id}/accept`,
        headers: auth(successor)
      })).json()
    );
    expect(acceptReplay).toMatchObject({ replayed: true });
    expect(acceptReplay.transfer.state).toBe("accepted");
  });

  it("restricts initiation to the owner and members-only successors", async () => {
    await fixture();
    const owner = await register("transfer_acl_owner");
    const admin = await register("transfer_acl_admin");
    const stranger = await register("transfer_acl_stranger");
    await establishAcceptedRelationship(app!, owner, admin);
    const chatId = await createGroup(owner, [admin.id]);

    expect((await initiate(admin, chatId, owner.id)).statusCode).toBe(403);
    expect((await initiate(stranger, chatId, owner.id)).statusCode).toBe(403);
    expect((await initiate(owner, chatId, stranger.id)).statusCode).toBe(404);
    expect((await initiate(owner, chatId, owner.id)).statusCode).toBe(409);

    const direct = await app!.inject({
      method: "POST",
      url: "/v1/chats",
      headers: auth(owner),
      payload: { kind: "direct", userId: stranger.id }
    });
    expect(direct.statusCode).toBe(201);
    expect((await initiate(owner, direct.json().chat.id as string, stranger.id)).statusCode).toBe(409);
  });

  it("keeps a single pending transfer, replays nonces and expires lazily", async () => {
    await fixture();
    await register("transfer_single_owner");
    await register("transfer_single_first");
    await register("transfer_single_second");
    const owner = await login("transfer_single_owner");
    const first = await login("transfer_single_first");
    const second = await login("transfer_single_second");
    await establishAcceptedRelationship(app!, owner, first);
    await establishAcceptedRelationship(app!, owner, second);
    const chatId = await createGroup(owner, [first.id, second.id]);

    const firstNonce = randomUUID();
    const created = await initiate(owner, chatId, first.id, firstNonce);
    expect(created.statusCode).toBe(201);

    const duplicate = await initiate(owner, chatId, second.id);
    expect(duplicate.statusCode).toBe(409);
    expect(duplicate.json().error.details).toMatchObject({ reason: "transfer_pending" });

    const crossed = await initiate(owner, chatId, second.id, firstNonce);
    expect(crossed.statusCode).toBe(409);

    // Access tokens live 15 minutes, so the far-future expiry probes
    // re-authenticate inside the fixed clock for fresh bearer tokens.
    // The probe clock is derived from the real now (transfer TTL is 24 h),
    // never hardcoded: a fixed calendar date turns into a time bomb once
    // wall-clock time passes it.
    const transferId = (created.json().transfer as { id: string }).id;
    const expiredIso = new Date(Date.now() + 25 * 3_600_000).toISOString();
    const expiredAccept = await withFixedClock(expiredIso, async () => {
      const futureFirst = await login("transfer_single_first");
      return app!.inject({
        method: "POST",
        url: `/v1/chats/${chatId}/ownership-transfers/${transferId}/accept`,
        headers: auth(futureFirst)
      });
    });
    expect(expiredAccept.statusCode).toBe(404);
    expect(expiredAccept.json().error.details).toMatchObject({ reason: "transfer_expired" });

    // The expired ceremony no longer blocks a fresh one.
    const freshIso = new Date(Date.parse(expiredIso) + 1_000).toISOString();
    const fresh = await withFixedClock(freshIso, async () => {
      const futureOwner = await login("transfer_single_owner");
      return initiate(futureOwner, chatId, second.id);
    });
    expect(fresh.statusCode).toBe(201);
  });

  it("cancels by the initiator with idempotent replay and successor visibility", async () => {
    await fixture();
    const owner = await register("transfer_cancel_owner");
    const successor = await register("transfer_cancel_successor");
    const outsider = await register("transfer_cancel_outsider");
    await establishAcceptedRelationship(app!, owner, successor);
    const chatId = await createGroup(owner, [successor.id]);

    const created = await initiate(owner, chatId, successor.id);
    const transferId = (created.json().transfer as { id: string }).id;

    expect((await app!.inject({
      method: "POST",
      url: `/v1/chats/${chatId}/ownership-transfers/${transferId}/cancel`,
      headers: auth(successor)
    })).statusCode).toBe(403);

    const cancelled = await app!.inject({
      method: "POST",
      url: `/v1/chats/${chatId}/ownership-transfers/${transferId}/cancel`,
      headers: auth(owner)
    });
    expect(cancelled.statusCode).toBe(200);
    expect(ChatOwnershipTransferResponseSchema.parse(cancelled.json())).toMatchObject({
      replayed: false
    });
    expect((cancelled.json().transfer as { state: string }).state).toBe("cancelled");

    const replay = await app!.inject({
      method: "POST",
      url: `/v1/chats/${chatId}/ownership-transfers/${transferId}/cancel`,
      headers: auth(owner)
    });
    expect(ChatOwnershipTransferResponseSchema.parse(replay.json())).toMatchObject({ replayed: true });

    const successorView = await app!.inject({
      method: "GET",
      url: `/v1/chats/${chatId}/ownership-transfers`,
      headers: auth(successor)
    });
    expect(successorView.statusCode).toBe(200);
    expect(successorView.json()).toEqual({ transfer: null });

    expect((await app!.inject({
      method: "GET",
      url: `/v1/chats/${chatId}/ownership-transfers`,
      headers: auth(outsider)
    })).statusCode).toBe(403);

    const roles = new Map((await members(owner, chatId)).map(({ membership }) => [membership.userId, membership.role]));
    expect(roles.get(owner.id)).toBe("owner");
    expect(roles.get(successor.id)).toBe("member");
  });

  it("refuses accept from anyone but the designated successor", async () => {
    await fixture();
    const owner = await register("transfer_accept_owner");
    const successor = await register("transfer_accept_successor");
    const intruder = await register("transfer_accept_intruder");
    await establishAcceptedRelationship(app!, owner, successor);
    await establishAcceptedRelationship(app!, owner, intruder);
    const chatId = await createGroup(owner, [successor.id, intruder.id]);

    const created = await initiate(owner, chatId, successor.id);
    const transferId = (created.json().transfer as { id: string }).id;

    expect((await app!.inject({
      method: "POST",
      url: `/v1/chats/${chatId}/ownership-transfers/${transferId}/accept`,
      headers: auth(intruder)
    })).statusCode).toBe(403);
    expect((await app!.inject({
      method: "POST",
      url: `/v1/chats/${chatId}/ownership-transfers/${transferId}/accept`,
      headers: auth(owner)
    })).statusCode).toBe(403);
  });
});
