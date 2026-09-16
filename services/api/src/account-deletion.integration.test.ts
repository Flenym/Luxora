import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { LuxoraApp } from "./app.js";
import { buildApp } from "./app.js";
import { testConfig } from "./test-helpers.js";

const DATA_KEY = Buffer.alloc(32, 41).toString("base64url");

interface Identity {
  id: string;
  accessToken: string;
}

describe("account deletion", () => {
  let app: LuxoraApp | undefined;
  const temporaryRoots: string[] = [];

  afterEach(async () => {
    await app?.close();
    app = undefined;
    await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  async function boot(): Promise<void> {
    const storageRoot = await mkdtemp(join(tmpdir(), "luxora-deletion-"));
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

  it("schedules, shows status, and cancels", async () => {
    await boot();
    const alice = await register("alice_deletion");

    const noneStatus = await app!.inject({ method: "GET", url: "/v1/account/deletion", headers: auth(alice) });
    expect(noneStatus.statusCode).toBe(200);
    expect(noneStatus.json().deletion.state).toBe("none");

    const schedule = await app!.inject({
      method: "POST",
      url: "/v1/account/deletion",
      headers: auth(alice),
      payload: {}
    });
    expect(schedule.statusCode, schedule.body).toBe(201);
    const scheduled = schedule.json().deletion;
    expect(scheduled.state).toBe("scheduled");
    expect(scheduled.accountId).toBe(alice.id);
    expect(scheduled.scheduledAt).not.toBeNull();
    expect(scheduled.graceDeadlineAt).not.toBeNull();

    const status = await app!.inject({ method: "GET", url: "/v1/account/deletion", headers: auth(alice) });
    expect(status.statusCode).toBe(200);
    expect(status.json().deletion.state).toBe("scheduled");
    expect(status.json().deletion.accountId).toBe(alice.id);

    const cancel = await app!.inject({ method: "DELETE", url: "/v1/account/deletion", headers: auth(alice) });
    expect(cancel.statusCode).toBe(200);
    expect(cancel.json().deletion.state).toBe("none");
    expect(cancel.json().deletion.canceledAt).not.toBeNull();

    const afterCancel = await app!.inject({ method: "GET", url: "/v1/account/deletion", headers: auth(alice) });
    expect(afterCancel.json().deletion.state).toBe("none");
  });

  it("does not leak another account's deletion status", async () => {
    await boot();
    const alice = await register("deletion_owner");
    const bob = await register("deletion_stranger");

    await app!.inject({ method: "POST", url: "/v1/account/deletion", headers: auth(alice), payload: {} });

    const bobStatus = await app!.inject({ method: "GET", url: "/v1/account/deletion", headers: auth(bob) });
    expect(bobStatus.statusCode).toBe(200);
    expect(bobStatus.json().deletion.state).toBe("none");

    const bobCancel = await app!.inject({ method: "DELETE", url: "/v1/account/deletion", headers: auth(bob) });
    expect(bobCancel.statusCode).toBe(404);
  });

  it("requires authentication", async () => {
    await boot();
    for (const request of [
      { method: "POST", url: "/v1/account/deletion", payload: {} },
      { method: "GET", url: "/v1/account/deletion" },
      { method: "DELETE", url: "/v1/account/deletion" }
    ] as const) {
      const response = await app!.inject({ ...request, headers: {} });
      expect(response.statusCode, `${request.method} ${request.url}`).toBe(401);
    }
  });
});