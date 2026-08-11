import { afterEach, describe, expect, it } from "vitest";
import type { LuxoraApp } from "./app.js";
import { buildApp } from "./app.js";
import { establishAcceptedRelationship, testConfig } from "./test-helpers.js";

interface Identity {
  id: string;
  accessToken: string;
}

describe("account-scoped chat archive and mute preferences", () => {
  let app: LuxoraApp | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  async function fixture(): Promise<void> {
    app = await buildApp({ config: testConfig(), logger: false });
  }

  async function register(username: string): Promise<Identity> {
    const response = await app!.inject({
      method: "POST",
      url: "/v1/auth/register",
      payload: {
        username,
        displayName: username,
        password: "correct horse battery staple",
        deviceName: `${username} iPhone`
      }
    });
    expect(response.statusCode, response.body).toBe(201);
    return {
      id: response.json().user.id as string,
      accessToken: response.json().tokens.accessToken as string
    };
  }

  function headers(identity: Identity): { authorization: string } {
    return { authorization: `Bearer ${identity.accessToken}` };
  }

  async function createSavedChat(identity: Identity): Promise<string> {
    const response = await app!.inject({
      method: "POST",
      url: "/v1/chats",
      headers: headers(identity),
      payload: { kind: "direct", userId: identity.id }
    });
    expect(response.statusCode, response.body).toBe(201);
    return response.json().chat.id as string;
  }

  it("keeps independent partial updates account-scoped and visible in chat projections", async () => {
    await fixture();
    const alice = await register("chat_preferences_alice");
    const bob = await register("chat_preferences_bob");
    const chatId = await createSavedChat(alice);

    const defaults = await app!.inject({
      method: "GET",
      url: `/v1/chats/${chatId}/preferences`,
      headers: headers(alice)
    });
    expect(defaults.statusCode).toBe(200);
    expect(defaults.json()).toEqual({ preferences: { archivedAt: null, mutedUntil: null } });

    const archived = await app!.inject({
      method: "PATCH",
      url: `/v1/chats/${chatId}/preferences`,
      headers: headers(alice),
      payload: { archived: true }
    });
    expect(archived.statusCode, archived.body).toBe(200);
    expect(Date.parse(archived.json().preferences.archivedAt)).not.toBeNaN();
    expect(archived.json().preferences.mutedUntil).toBeNull();
    const firstArchivedAt = archived.json().preferences.archivedAt as string;

    const replayedDesiredState = await app!.inject({
      method: "PATCH",
      url: `/v1/chats/${chatId}/preferences`,
      headers: headers(alice),
      payload: { archived: true }
    });
    expect(replayedDesiredState.json().preferences.archivedAt).toBe(firstArchivedAt);

    const mutedUntil = "2027-08-11T09:00:00.000Z";
    const muted = await app!.inject({
      method: "PATCH",
      url: `/v1/chats/${chatId}/preferences`,
      headers: headers(alice),
      payload: { mutedUntil }
    });
    expect(muted.statusCode, muted.body).toBe(200);
    expect(muted.json()).toEqual({ preferences: { archivedAt: firstArchivedAt, mutedUntil } });

    const projected = await app!.inject({
      method: "GET",
      url: `/v1/chats/${chatId}`,
      headers: headers(alice)
    });
    expect(projected.json().chat).toMatchObject({ archivedAt: firstArchivedAt, mutedUntil });
    const listed = await app!.inject({
      method: "GET",
      url: "/v1/chats",
      headers: headers(alice)
    });
    expect(listed.json().items[0]).toMatchObject({ id: chatId, archivedAt: firstArchivedAt, mutedUntil });

    const [unarchive, changeMute] = await Promise.all([
      app!.inject({
        method: "PATCH",
        url: `/v1/chats/${chatId}/preferences`,
        headers: headers(alice),
        payload: { archived: false }
      }),
      app!.inject({
        method: "PATCH",
        url: `/v1/chats/${chatId}/preferences`,
        headers: headers(alice),
        payload: { mutedUntil: "2027-08-12T09:00:00.000Z" }
      })
    ]);
    expect(unarchive.statusCode).toBe(200);
    expect(changeMute.statusCode).toBe(200);
    const afterIndependentWrites = await app!.inject({
      method: "GET",
      url: `/v1/chats/${chatId}/preferences`,
      headers: headers(alice)
    });
    expect(afterIndependentWrites.json()).toEqual({
      preferences: { archivedAt: null, mutedUntil: "2027-08-12T09:00:00.000Z" }
    });

    const cleared = await app!.inject({
      method: "PATCH",
      url: `/v1/chats/${chatId}/preferences`,
      headers: headers(alice),
      payload: { mutedUntil: null }
    });
    expect(cleared.json()).toEqual({ preferences: { archivedAt: null, mutedUntil: null } });

    for (const request of [
      { method: "GET" as const, payload: undefined },
      { method: "PATCH" as const, payload: { archived: true } }
    ]) {
      const denied = await app!.inject({
        method: request.method,
        url: `/v1/chats/${chatId}/preferences`,
        headers: headers(bob),
        ...(request.payload === undefined ? {} : { payload: request.payload })
      });
      expect(denied.statusCode).toBe(403);
    }
  });

  it("rejects unauthenticated, empty, malformed and expansive patches", async () => {
    await fixture();
    const alice = await register("chat_preferences_validation");
    const chatId = await createSavedChat(alice);

    const unauthenticated = await app!.inject({
      method: "GET",
      url: `/v1/chats/${chatId}/preferences`
    });
    expect(unauthenticated.statusCode).toBe(401);

    for (const payload of [
      {},
      { mutedUntil: "tomorrow" },
      { archived: true, userId: alice.id }
    ]) {
      const response = await app!.inject({
        method: "PATCH",
        url: `/v1/chats/${chatId}/preferences`,
        headers: headers(alice),
        payload
      });
      expect(response.statusCode).toBe(400);
      expect(response.json().error.code).toBe("VALIDATION_FAILED");
    }
  });

  it("emits one private durable event only when the confirmed state changes", async () => {
    await fixture();
    const alice = await register("chat_preferences_event_alice");
    const bob = await register("chat_preferences_event_bob");
    await establishAcceptedRelationship(app!, alice, bob);
    const created = await app!.inject({
      method: "POST",
      url: "/v1/chats",
      headers: headers(alice),
      payload: { kind: "group", title: "Private preferences event", memberIds: [bob.id] }
    });
    expect(created.statusCode, created.body).toBe(201);
    const chatId = created.json().chat.id as string;
    const before = app!.luxora.store.getLatestSequence();

    const archived = await app!.inject({
      method: "PATCH",
      url: `/v1/chats/${chatId}/preferences`,
      headers: headers(alice),
      payload: { archived: true }
    });
    expect(archived.statusCode, archived.body).toBe(200);
    const afterChange = app!.luxora.store.getLatestSequence();
    expect(afterChange).toBe(before + 1);

    const aliceEvents = app!.luxora.store.replayEvents(alice.id, before, afterChange, 10);
    expect(aliceEvents).toHaveLength(1);
    expect(aliceEvents[0]?.event).toEqual({
      type: "chat.preferences.updated",
      audience: "member_account",
      accountId: alice.id,
      chatId,
      preferences: archived.json().preferences,
      changedAt: expect.any(String)
    });
    expect(app!.luxora.store.replayEvents(bob.id, before, afterChange, 10)).toEqual([]);

    const replayed = await app!.inject({
      method: "PATCH",
      url: `/v1/chats/${chatId}/preferences`,
      headers: headers(alice),
      payload: { archived: true }
    });
    expect(replayed.statusCode, replayed.body).toBe(200);
    expect(replayed.json()).toEqual(archived.json());
    expect(app!.luxora.store.getLatestSequence()).toBe(afterChange);

    const bobMutedUntil = "2027-08-13T09:00:00.000Z";
    const bobChange = await app!.inject({
      method: "PATCH",
      url: `/v1/chats/${chatId}/preferences`,
      headers: headers(bob),
      payload: { mutedUntil: bobMutedUntil }
    });
    expect(bobChange.statusCode, bobChange.body).toBe(200);
    const afterBobChange = app!.luxora.store.getLatestSequence();
    expect(app!.luxora.store.replayEvents(alice.id, afterChange, afterBobChange, 10)).toEqual([]);
    expect(app!.luxora.store.replayEvents(bob.id, afterChange, afterBobChange, 10)[0]?.event)
      .toMatchObject({
        type: "chat.preferences.updated",
        audience: "member_account",
        accountId: bob.id,
        chatId,
        preferences: { archivedAt: null, mutedUntil: bobMutedUntil }
      });
  });
});
