import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import type { LuxoraApp } from "./app.js";
import { buildApp } from "./app.js";
import { testConfig } from "./test-helpers.js";

const DATA_KEY = Buffer.alloc(32, 62).toString("base64url");

interface ChallengeBody {
  linkId: string;
  linkSecret?: string;
  state?: string;
  expiresAt: string;
  retryAfterMs?: number;
  pollIntervalMs?: number;
  sasWords?: string[] | null;
}

describe("device link challenges", () => {
  let app: LuxoraApp | undefined;
  const temporaryRoots: string[] = [];
  let databasePath = "";

  afterEach(async () => {
    await app?.close();
    app = undefined;
    await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  async function boot(): Promise<void> {
    const storageRoot = await mkdtemp(join(tmpdir(), "luxora-devicelink-"));
    temporaryRoots.push(storageRoot);
    databasePath = join(storageRoot, "luxora.db");
    app = await buildApp({
      config: testConfig({
        dataEncryptionKeys: { test: DATA_KEY },
        activeDataEncryptionKeyId: "test",
        databasePath,
        storageLocalPath: join(storageRoot, "blobs"),
        uploadStagingPath: join(storageRoot, "uploads")
      }),
      logger: false
    });
  }

  async function create(targetLabel?: string): Promise<{ status: number; body: ChallengeBody }> {
    const response = await app!.inject({
      method: "POST",
      url: "/v1/device-links/challenges",
      payload: targetLabel === undefined ? {} : { targetLabel }
    });
    return { status: response.statusCode, body: response.json() as ChallengeBody };
  }

  async function poll(linkId: string, linkSecret?: string): Promise<{ status: number; body: unknown; retryAfter: string | undefined }> {
    const response = await app!.inject({
      method: "POST",
      url: `/v1/device-links/challenges/${linkId}/poll`,
      payload: linkSecret === undefined ? {} : { linkSecret }
    });
    return {
      status: response.statusCode,
      body: response.json() as unknown,
      retryAfter: response.headers["retry-after"] as string | undefined
    };
  }

  it("creates, polls, throttles and closes a challenge without leaking the secret", async () => {
    await boot();
    const created = await create("field laptop");
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(created.body.linkId).toMatch(/^[0-9a-f-]{36}$/u);
    expect(created.body.linkSecret).toMatch(/^[a-f0-9]{64}$/u);
    expect(created.body.pollIntervalMs).toBe(2000);
    expect(Date.parse(created.body.expiresAt) - Date.now()).toBeGreaterThan(100_000);

    const first = await poll(created.body.linkId, created.body.linkSecret);
    expect(first.status).toBe(200);
    expect((first.body as { challenge: ChallengeBody }).challenge.state).toBe("pending");

    const fast = await poll(created.body.linkId, created.body.linkSecret);
    expect(fast.status).toBe(429);
    expect(fast.retryAfter).toBeTruthy();

    const closed = await app!.inject({
      method: "POST",
      url: `/v1/device-links/challenges/${created.body.linkId}/close`,
      payload: { linkSecret: created.body.linkSecret }
    });
    expect(closed.statusCode, closed.body).toBe(200);
    expect((closed.json() as { challenge: ChallengeBody }).challenge.state).toBe("closed");

    const afterClose = await poll(created.body.linkId, created.body.linkSecret);
    expect(afterClose.status).toBe(200);
    expect((afterClose.body as { challenge: ChallengeBody }).challenge.state).toBe("closed");

    const closedAgain = await app!.inject({
      method: "POST",
      url: `/v1/device-links/challenges/${created.body.linkId}/close`,
      payload: { linkSecret: created.body.linkSecret }
    });
    expect(closedAgain.statusCode).toBe(200);

    const stored = app!.luxora.store.findDeviceLinkChallenge(created.body.linkId);
    expect(stored?.linkSecretHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(stored?.linkSecretHash).not.toBe(created.body.linkSecret);
  });

  it("rejects unknown ids and wrong secrets identically and validates input", async () => {
    await boot();
    const created = await create();
    expect(created.status).toBe(201);

    const unknown = await poll("00000000-0000-4000-8000-000000000000");
    expect(unknown.status).toBe(401);

    const wrongSecret = await poll(created.body.linkId, "b".repeat(64));
    expect(wrongSecret.status).toBe(401);

    const missingSecret = await poll(created.body.linkId);
    expect(missingSecret.status).toBe(401);

    const malformedSecret = await app!.inject({
      method: "POST",
      url: `/v1/device-links/challenges/${created.body.linkId}/poll`,
      payload: { linkSecret: "not-hex" }
    });
    expect(malformedSecret.statusCode).toBe(400);

    const badLabel = await create("");
    expect(badLabel.status).toBe(400);

    const unauthenticated = await app!.inject({
      method: "POST",
      url: `/v1/device-links/challenges/${created.body.linkId}/close`
    });
    expect(unauthenticated.statusCode).toBe(401);
  });

  it("expires lazily on poll and purges terminal rows on sweep", async () => {    await boot();
    const created = await create();
    expect(created.status).toBe(201);

    const database = new Database(databasePath);
    try {
      database.prepare("UPDATE device_link_challenges SET expires_at = ? WHERE link_id = ?")
        .run(new Date(Date.now() - 1_000).toISOString(), created.body.linkId);
    } finally {
      database.close();
    }

    const polled = await poll(created.body.linkId, created.body.linkSecret);
    expect(polled.status).toBe(200);
    expect((polled.body as { challenge: ChallengeBody }).challenge.state).toBe("expired");

    const swept = app!.luxora.store.expireDeviceLinkChallenges(new Date().toISOString(), 100);
    expect(swept).toBe(0);

    const purged = app!.luxora.store.purgeDeviceLinkChallenges(new Date().toISOString(), 100);
    expect(purged).toBe(1);
    expect(app!.luxora.store.findDeviceLinkChallenge(created.body.linkId)).toBeNull();
  });

  it("approves with matching SAS on both endpoints and denies explicitly", async () => {
    await boot();
    const registerResponse = await app!.inject({
      method: "POST",
      url: "/v1/auth/register",
      payload: { username: "approver", displayName: "approver", password: "correct horse battery staple" }
    });
    expect(registerResponse.statusCode).toBe(201);
    const approver = {
      id: registerResponse.json().user.id as string,
      accessToken: registerResponse.json().tokens.accessToken as string
    };

    const created = await create("approver laptop");
    expect(created.status).toBe(201);

    const approve = await app!.inject({
      method: "POST",
      url: `/v1/device-links/challenges/${created.body.linkId}/approve`,
      headers: { authorization: `Bearer ${approver.accessToken}` },
      payload: { linkSecret: created.body.linkSecret }
    });
    expect(approve.statusCode, approve.body).toBe(200);
    const approved = (approve.json() as { challenge: ChallengeBody }).challenge;
    expect(approved.state).toBe("approved");
    expect(approved.sasWords).toHaveLength(4);

    const targetPoll = await poll(created.body.linkId, created.body.linkSecret);
    expect(targetPoll.status).toBe(200);
    const polled = (targetPoll.body as { challenge: ChallengeBody }).challenge;
    expect(polled.state).toBe("approved");
    expect(polled.sasWords).toEqual(approved.sasWords);

    const stored = app!.luxora.store.findDeviceLinkChallenge(created.body.linkId);
    expect(stored?.approvedByAccountId).toBe(approver.id);

    const again = await app!.inject({
      method: "POST",
      url: `/v1/device-links/challenges/${created.body.linkId}/approve`,
      headers: { authorization: `Bearer ${approver.accessToken}` },
      payload: { linkSecret: created.body.linkSecret }
    });
    expect(again.statusCode).toBe(409);

    const second = await create();
    expect(second.status).toBe(201);
    const deny = await app!.inject({
      method: "POST",
      url: `/v1/device-links/challenges/${second.body.linkId}/deny`,
      headers: { authorization: `Bearer ${approver.accessToken}` },
      payload: { linkSecret: second.body.linkSecret }
    });
    expect(deny.statusCode, deny.body).toBe(200);
    expect((deny.json() as { challenge: ChallengeBody }).challenge.state).toBe("denied");

    const deniedPoll = await poll(second.body.linkId, second.body.linkSecret);
    expect(deniedPoll.status).toBe(200);
    expect((deniedPoll.body as { challenge: ChallengeBody }).challenge.state).toBe("denied");
  });

  it("rejects approval without bearer, with wrong secret, and after expiry", async () => {
    await boot();
    const registerResponse = await app!.inject({
      method: "POST",
      url: "/v1/auth/register",
      payload: { username: "approver2", displayName: "approver2", password: "correct horse battery staple" }
    });
    const approverToken = registerResponse.json().tokens.accessToken as string;

    const created = await create();
    expect(created.status).toBe(201);

    const noBearer = await app!.inject({
      method: "POST",
      url: `/v1/device-links/challenges/${created.body.linkId}/approve`,
      payload: { linkSecret: created.body.linkSecret }
    });
    expect(noBearer.statusCode).toBe(401);

    const wrongSecret = await app!.inject({
      method: "POST",
      url: `/v1/device-links/challenges/${created.body.linkId}/approve`,
      headers: { authorization: `Bearer ${approverToken}` },
      payload: { linkSecret: "c".repeat(64) }
    });
    expect(wrongSecret.statusCode).toBe(401);

    const unknown = await app!.inject({
      method: "POST",
      url: "/v1/device-links/challenges/00000000-0000-4000-8000-000000000000/deny",
      headers: { authorization: `Bearer ${approverToken}` },
      payload: { linkSecret: created.body.linkSecret }
    });
    expect(unknown.statusCode).toBe(401);

    const database = new Database(databasePath);
    try {
      database.prepare("UPDATE device_link_challenges SET expires_at = ? WHERE link_id = ?")
        .run(new Date(Date.now() - 1_000).toISOString(), created.body.linkId);
    } finally {
      database.close();
    }
    const expiredApprove = await app!.inject({
      method: "POST",
      url: `/v1/device-links/challenges/${created.body.linkId}/approve`,
      headers: { authorization: `Bearer ${approverToken}` },
      payload: { linkSecret: created.body.linkSecret }
    });
    expect(expiredApprove.statusCode).toBe(409);
  });
});
