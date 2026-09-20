import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { LuxoraApp } from "./app.js";
import { buildApp } from "./app.js";
import { testConfig } from "./test-helpers.js";

const DATA_KEY = Buffer.alloc(32, 62).toString("base64url");
const PASSWORD = "correct horse battery staple";

interface Identity {
  id: string;
  accessToken: string;
}

describe("security containment", () => {
  let app: LuxoraApp | undefined;
  const temporaryRoots: string[] = [];

  afterEach(async () => {
    await app?.close();
    app = undefined;
    await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  async function boot(): Promise<void> {
    const storageRoot = await mkdtemp(join(tmpdir(), "luxora-containment-"));
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
      payload: { username, displayName: username, password: PASSWORD }
    });
    expect(response.statusCode, response.body).toBe(201);
    return {
      id: response.json().user.id as string,
      accessToken: response.json().tokens.accessToken as string
    };
  }

  async function login(username: string, deviceName: string): Promise<Identity> {
    const response = await app!.inject({
      method: "POST",
      url: "/v1/auth/login",
      payload: { username, password: PASSWORD, deviceName }
    });
    expect(response.statusCode, response.body).toBe(200);
    return {
      id: response.json().user.id as string,
      accessToken: response.json().tokens.accessToken as string
    };
  }

  function auth(identity: Identity): { authorization: string } {
    return { authorization: `Bearer ${identity.accessToken}` };
  }

  async function sessionIds(identity: Identity): Promise<string[]> {
    const response = await app!.inject({ method: "GET", url: "/v1/auth/sessions", headers: auth(identity) });
    expect(response.statusCode).toBe(200);
    return (response.json().items as Array<{ id: string }>).map((session) => session.id);
  }

  async function otherSessionIds(identity: Identity): Promise<string[]> {
    const response = await app!.inject({ method: "GET", url: "/v1/auth/sessions", headers: auth(identity) });
    expect(response.statusCode).toBe(200);
    return (response.json().items as Array<{ id: string; current: boolean }>)
      .filter((session) => !session.current)
      .map((session) => session.id);
  }

  it("revokes a selected session and rejects foreign or missing targets", async () => {
    await boot();
    const alice = await register("alice_contain");
    const second = await login("alice_contain", "Second device");
    const stranger = await register("mallory_contain");

    const before = await sessionIds(alice);
    expect(before).toHaveLength(2);
    const others = await otherSessionIds(alice);
    expect(others).toHaveLength(1);
    const target = others[0] as string;
    void second;

    const contained = await app!.inject({
      method: "POST",
      url: "/v1/security/containment",
      headers: auth(alice),
      payload: { scope: "session", sessionId: target }
    });
    expect(contained.statusCode, contained.body).toBe(200);
    expect(contained.json()).toEqual({ scope: "session", revokedSessionIds: [target] });

    const after = await sessionIds(alice);
    expect(after).toHaveLength(1);
    expect(after).not.toContain(target);

    const foreign = await app!.inject({
      method: "POST",
      url: "/v1/security/containment",
      headers: auth(stranger),
      payload: { scope: "session", sessionId: target }
    });
    expect(foreign.statusCode).toBe(404);

    const missing = await app!.inject({
      method: "POST",
      url: "/v1/security/containment",
      headers: auth(alice),
      payload: { scope: "session" }
    });
    expect(missing.statusCode).toBe(400);

    const misplaced = await app!.inject({
      method: "POST",
      url: "/v1/security/containment",
      headers: auth(alice),
      payload: { scope: "account", sessionId: target }
    });
    expect(misplaced.statusCode).toBe(400);

    const unauthenticated = await app!.inject({
      method: "POST",
      url: "/v1/security/containment",
      payload: { scope: "all_other_sessions" }
    });
    expect(unauthenticated.statusCode).toBe(401);
  });

  it("revokes all other sessions but keeps the current one", async () => {
    await boot();
    const alice = await register("alice_contain_others");
    await login("alice_contain_others", "Second device");
    await login("alice_contain_others", "Third device");

    const contained = await app!.inject({
      method: "POST",
      url: "/v1/security/containment",
      headers: auth(alice),
      payload: { scope: "all_other_sessions" }
    });
    expect(contained.statusCode, contained.body).toBe(200);
    expect((contained.json() as { scope: string }).scope).toBe("all_other_sessions");
    expect((contained.json() as { revokedSessionIds: string[] }).revokedSessionIds).toHaveLength(2);

    const remaining = await sessionIds(alice);
    expect(remaining).toHaveLength(1);
  });

  it("revokes every session including current and expires export artifacts", async () => {
    await boot();
    const alice = await register("alice_contain_account");
    await login("alice_contain_account", "Second device");

    const exported = await app!.inject({
      method: "POST",
      url: "/v1/data-exports",
      headers: auth(alice),
      payload: {}
    });
    expect(exported.statusCode, exported.body).toBe(201);
    const exportId = exported.json().dataExport.id as string;

    const contained = await app!.inject({
      method: "POST",
      url: "/v1/security/containment",
      headers: auth(alice),
      payload: { scope: "account" }
    });
    expect(contained.statusCode, contained.body).toBe(200);
    expect((contained.json() as { revokedSessionIds: string[] }).revokedSessionIds).toHaveLength(2);

    const dead = await app!.inject({
      method: "GET",
      url: "/v1/me",
      headers: auth(alice)
    });
    expect(dead.statusCode).toBe(401);

    const fresh = await login("alice_contain_account", "Post-containment device");
    const status = await app!.inject({
      method: "GET",
      url: `/v1/data-exports/${exportId}`,
      headers: auth(fresh)
    });
    expect(status.statusCode).toBe(200);
    expect(status.json().dataExport.state).toBe("expired");
  });
});
