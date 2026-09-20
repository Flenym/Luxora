import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { createPublicKey, generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { StepUpTokenSecurity } from "./passkeys/step-up-token.js";
import { canonicalTargetDigest } from "./services/passkey-service.js";
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
      payload: { linkSecret: created.body.linkSecret, password: "correct horse battery staple" }
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
      payload: { linkSecret: created.body.linkSecret, password: "correct horse battery staple" }
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
      payload: { linkSecret: "c".repeat(64), password: "correct horse battery staple" }
    });
    expect(wrongSecret.statusCode).toBe(401);

    const missingPassword = await app!.inject({
      method: "POST",
      url: `/v1/device-links/challenges/${created.body.linkId}/approve`,
      headers: { authorization: `Bearer ${approverToken}` },
      payload: { linkSecret: created.body.linkSecret }
    });
    expect(missingPassword.statusCode).toBe(400);

    const wrongPassword = await app!.inject({
      method: "POST",
      url: `/v1/device-links/challenges/${created.body.linkId}/approve`,
      headers: { authorization: `Bearer ${approverToken}` },
      payload: { linkSecret: created.body.linkSecret, password: "wrong password phrase here" }
    });
    expect(wrongPassword.statusCode).toBe(403);

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
      payload: { linkSecret: created.body.linkSecret, password: "correct horse battery staple" }
    });
    expect(expiredApprove.statusCode).toBe(409);
  });

  it("redeems an approved challenge with proof-key possession into a working session", async () => {
    await boot();
    const registerResponse = await app!.inject({
      method: "POST",
      url: "/v1/auth/register",
      payload: { username: "redeemer", displayName: "redeemer", password: "correct horse battery staple" }
    });
    expect(registerResponse.statusCode).toBe(201);
    const approverToken = registerResponse.json().tokens.accessToken as string;
    const approverId = registerResponse.json().user.id as string;

    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const publicJwk = publicKey.export({ format: "jwk" }) as { kty: string; crv: string; x: string };

    const created = await app!.inject({
      method: "POST",
      url: "/v1/device-links/challenges",
      payload: { targetLabel: "new phone", proofPublicKey: publicJwk }
    });
    expect(created.statusCode, created.body).toBe(201);
    const linkId = created.json().linkId as string;
    const linkSecret = created.json().linkSecret as string;

    const approve = await app!.inject({
      method: "POST",
      url: `/v1/device-links/challenges/${linkId}/approve`,
      headers: { authorization: `Bearer ${approverToken}` },
      payload: { linkSecret, password: "correct horse battery staple" }
    });
    expect(approve.statusCode, approve.body).toBe(200);

    const message = Buffer.from(`luxora-device-link-redeem-v1:${linkId}`, "utf8");
    const signature = sign(null, message, privateKey).toString("base64url");
    const redeem = await app!.inject({
      method: "POST",
      url: `/v1/device-links/challenges/${linkId}/redeem`,
      payload: { linkSecret, proofSignature: signature }
    });
    expect(redeem.statusCode, redeem.body).toBe(201);
    const tokens = redeem.json().tokens as { accessToken: string; refreshToken: string; sessionId: string };
    expect(typeof tokens.accessToken).toBe("string");
    expect(typeof tokens.refreshToken).toBe("string");

    const me = await app!.inject({
      method: "GET",
      url: "/v1/me",
      headers: { authorization: `Bearer ${tokens.accessToken}` }
    });
    expect(me.statusCode).toBe(200);
    expect(me.json().user.id).toBe(approverId);

    const stored = app!.luxora.store.findDeviceLinkChallenge(linkId);
    expect(stored?.status).toBe("consumed");
    expect(stored?.redeemedSessionId).toBe(tokens.sessionId);

    const replay = await app!.inject({
      method: "POST",
      url: `/v1/device-links/challenges/${linkId}/redeem`,
      payload: { linkSecret, proofSignature: signature }
    });
    expect(replay.statusCode).toBe(409);

    const otherKeys = generateKeyPairSync("ed25519");
    const forged = sign(null, message, otherKeys.privateKey).toString("base64url");
    const second = await app!.inject({
      method: "POST",
      url: "/v1/device-links/challenges",
      payload: { proofPublicKey: publicJwk }
    });
    const secondLinkId = second.json().linkId as string;
    const secondSecret = second.json().linkSecret as string;
    const secondApprove = await app!.inject({
      method: "POST",
      url: `/v1/device-links/challenges/${secondLinkId}/approve`,
      headers: { authorization: `Bearer ${approverToken}` },
      payload: { linkSecret: secondSecret, password: "correct horse battery staple" }
    });
    expect(secondApprove.statusCode).toBe(200);
    const secondMessage = Buffer.from(`luxora-device-link-redeem-v1:${secondLinkId}`, "utf8");
    const forgedSecond = sign(null, secondMessage, otherKeys.privateKey).toString("base64url");
    const forgedRedeem = await app!.inject({
      method: "POST",
      url: `/v1/device-links/challenges/${secondLinkId}/redeem`,
      payload: { linkSecret: secondSecret, proofSignature: forgedSecond }
    });
    expect(forgedRedeem.statusCode).toBe(403);
    expect(forged).toBeTruthy();
    expect(createPublicKey({ key: publicJwk, format: "jwk" }).asymmetricKeyType).toBe("ed25519");
  });

  it("rejects redemption without keys, with wrong secret, and before approval", async () => {
    await boot();
    const registerResponse = await app!.inject({
      method: "POST",
      url: "/v1/auth/register",
      payload: { username: "redeemer2", displayName: "redeemer2", password: "correct horse battery staple" }
    });
    const approverToken = registerResponse.json().tokens.accessToken as string;

    const legacy = await create();
    expect(legacy.status).toBe(201);
    const legacyApprove = await app!.inject({
      method: "POST",
      url: `/v1/device-links/challenges/${legacy.body.linkId}/approve`,
      headers: { authorization: `Bearer ${approverToken}` },
      payload: { linkSecret: legacy.body.linkSecret, password: "correct horse battery staple" }
    });
    expect(legacyApprove.statusCode).toBe(200);
    const { privateKey } = generateKeyPairSync("ed25519");
    const legacyRedeem = await app!.inject({
      method: "POST",
      url: `/v1/device-links/challenges/${legacy.body.linkId}/redeem`,
      payload: {
        linkSecret: legacy.body.linkSecret,
        proofSignature: sign(null, Buffer.from(`luxora-device-link-redeem-v1:${legacy.body.linkId}`, "utf8"), privateKey).toString("base64url")
      }
    });
    expect(legacyRedeem.statusCode).toBe(409);

    const pending = await create();
    const pendingRedeem = await app!.inject({
      method: "POST",
      url: `/v1/device-links/challenges/${pending.body.linkId}/redeem`,
      payload: { linkSecret: pending.body.linkSecret, proofSignature: "A".repeat(86) }
    });
    expect(pendingRedeem.statusCode).toBe(409);

    const wrongSecret = await app!.inject({
      method: "POST",
      url: `/v1/device-links/challenges/${pending.body.linkId}/redeem`,
      payload: { linkSecret: "d".repeat(64), proofSignature: "A".repeat(86) }
    });
    expect(wrongSecret.statusCode).toBe(401);

    const missingProof = await app!.inject({
      method: "POST",
      url: `/v1/device-links/challenges/${pending.body.linkId}/redeem`,
      payload: { linkSecret: pending.body.linkSecret }
    });
    expect(missingProof.statusCode).toBe(409);
  });

  it("approves with a ceremony-bound step-up token instead of a password", async () => {
    await boot();
    const registerResponse = await app!.inject({
      method: "POST",
      url: "/v1/auth/register",
      payload: { username: "ceremony_approver", displayName: "ceremony_approver", password: "correct horse battery staple" }
    });
    expect(registerResponse.statusCode).toBe(201);
    const approverId = registerResponse.json().user.id as string;
    const approverToken = registerResponse.json().tokens.accessToken as string;
    const sessions = await app!.inject({
      method: "GET",
      url: "/v1/auth/sessions",
      headers: { authorization: `Bearer ${approverToken}` }
    });
    const approverSessionId = (sessions.json().items as Array<{ id: string }>)[0]!.id;

    const created = await create();
    expect(created.status).toBe(201);

    // White-box seam: the ceremony→grant linkage is proven by
    // device-link-stepup.test.ts; here a directly-minted token exercises the
    // consumption contract (signature, binding, grant row, single-use CAS).
    const authority = new StepUpTokenSecurity("test-only-secret-with-at-least-thirty-two-bytes");
    const ceremonyId = randomUUID();
    const targetDigest = canonicalTargetDigest({
      accountId: approverId,
      operation: "device-link.approve",
      sessionId: approverSessionId,
      linkId: created.body.linkId
    });
    const issuedAt = Math.floor(Date.now() / 1000);
    app!.luxora.store.createDeviceLinkStepUpIntent({
      ceremonyId,
      linkId: created.body.linkId,
      accountId: approverId,
      sessionId: approverSessionId,
      targetDigest,
      createdAt: new Date().toISOString()
    });
    app!.luxora.store.createDeviceLinkStepUpGrant({
      ceremonyId,
      linkId: created.body.linkId,
      accountId: approverId,
      sessionId: approverSessionId,
      deviceId: approverSessionId,
      targetDigest,
      authTimeSec: issuedAt,
      issuedAtSec: issuedAt,
      expiresAtSec: issuedAt + 300
    });
    const stepUpToken = await authority.issue({
      accountId: approverId,
      sessionId: approverSessionId,
      ceremonyId,
      purpose: "device-link.approve",
      targetDigest,
      issuedAt,
      expiresAt: issuedAt + 300
    });

    const approve = await app!.inject({
      method: "POST",
      url: `/v1/device-links/challenges/${created.body.linkId}/approve`,
      headers: { authorization: `Bearer ${approverToken}` },
      payload: { linkSecret: created.body.linkSecret, stepUpCeremonyId: ceremonyId, stepUpToken }
    });
    expect(approve.statusCode, approve.body).toBe(200);
    expect((approve.json() as { challenge: ChallengeBody }).challenge.state).toBe("approved");

    const replay = await app!.inject({
      method: "POST",
      url: `/v1/device-links/challenges/${created.body.linkId}/approve`,
      headers: { authorization: `Bearer ${approverToken}` },
      payload: { linkSecret: created.body.linkSecret, stepUpCeremonyId: ceremonyId, stepUpToken }
    });
    expect(replay.statusCode).toBe(409);

    const second = await create();
    const wrongPurposeToken = await authority.issue({
      accountId: approverId,
      sessionId: approverSessionId,
      ceremonyId: randomUUID(),
      purpose: "authenticator.add",
      targetDigest,
      issuedAt,
      expiresAt: issuedAt + 300
    });
    const wrongPurpose = await app!.inject({
      method: "POST",
      url: `/v1/device-links/challenges/${second.body.linkId}/approve`,
      headers: { authorization: `Bearer ${approverToken}` },
      payload: { linkSecret: second.body.linkSecret, stepUpCeremonyId: randomUUID(), stepUpToken: wrongPurposeToken }
    });
    expect(wrongPurpose.statusCode).toBe(403);

    const noGrant = await app!.inject({
      method: "POST",
      url: `/v1/device-links/challenges/${second.body.linkId}/approve`,
      headers: { authorization: `Bearer ${approverToken}` },
      payload: {
        linkSecret: second.body.linkSecret,
        stepUpCeremonyId: randomUUID(),
        stepUpToken: await authority.issue({
          accountId: approverId,
          sessionId: approverSessionId,
          ceremonyId: randomUUID(),
          purpose: "device-link.approve",
          targetDigest,
          issuedAt,
          expiresAt: issuedAt + 300
        })
      }
    });
    expect(noGrant.statusCode).toBe(403);
  });
});
