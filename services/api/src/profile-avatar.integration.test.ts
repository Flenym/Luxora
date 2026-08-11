import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { LuxoraApp } from "./app.js";
import { buildApp } from "./app.js";
import { testConfig } from "./test-helpers.js";

interface Identity {
  id: string;
  username: string;
  accessToken: string;
}

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64"
);

function digest(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

describe("owned processed profile avatars", () => {
  let app: LuxoraApp | undefined;
  const temporaryRoots: string[] = [];

  afterEach(async () => {
    await app?.close();
    app = undefined;
    await Promise.all(temporaryRoots.splice(0).map((root) =>
      rm(root, { recursive: true, force: true })
    ));
  });

  function authorization(identity: Identity): { authorization: string } {
    return { authorization: `Bearer ${identity.accessToken}` };
  }

  async function register(username: string): Promise<Identity> {
    const response = await app!.inject({
      method: "POST",
      url: "/v1/auth/register",
      payload: {
        username,
        displayName: username,
        password: "correct horse battery staple",
        deviceName: "Avatar integration"
      }
    });
    expect(response.statusCode, response.body).toBe(201);
    return {
      id: response.json().user.id as string,
      username,
      accessToken: response.json().tokens.accessToken as string
    };
  }

  async function uploadImage(identity: Identity): Promise<string> {
    const created = await app!.inject({
      method: "POST",
      url: "/v1/uploads",
      headers: authorization(identity),
      payload: {
        kind: "image",
        fileName: "selected-avatar.png",
        mimeType: "image/png",
        sizeBytes: PNG.length,
        sha256: digest(PNG),
        idempotencyKey: randomUUID(),
        metadata: { width: 1, height: 1 }
      }
    });
    expect(created.statusCode, created.body).toBe(201);
    const uploadId = created.json().upload.id as string;
    const chunk = await app!.inject({
      method: "PUT",
      url: `/v1/uploads/${uploadId}/chunks/0`,
      headers: {
        ...authorization(identity),
        "content-type": "application/octet-stream",
        "content-length": String(PNG.length),
        "content-range": `bytes 0-${PNG.length - 1}/${PNG.length}`,
        "x-chunk-sha256": digest(PNG)
      },
      payload: PNG
    });
    expect(chunk.statusCode, chunk.body).toBe(200);
    const completed = await app!.inject({
      method: "POST",
      url: `/v1/uploads/${uploadId}/complete`,
      headers: authorization(identity)
    });
    expect(completed.statusCode, completed.body).toBe(200);
    return completed.json().upload.attachment.id as string;
  }

  it("re-encodes an owned image, strips client metadata trust, binds it, and enforces visibility", async () => {
    const storageRoot = await mkdtemp(join(tmpdir(), "luxora-profile-avatar-"));
    temporaryRoots.push(storageRoot);
    const key = Buffer.alloc(32, 117).toString("base64url");
    app = await buildApp({
      config: testConfig({
        dataEncryptionKeys: { avatar: key },
        activeDataEncryptionKeyId: "avatar",
        storageLocalPath: join(storageRoot, "blobs"),
        uploadStagingPath: join(storageRoot, "uploads")
      }),
      logger: false
    });
    const alice = await register("avatar_alice");
    const bob = await register("avatar_bob");
    const outsider = await register("avatar_outsider");
    const sourceAttachmentId = await uploadImage(alice);
    const chatId = randomUUID();
    const chatCreatedAt = new Date().toISOString();
    app.luxora.store.createChat({
      id: chatId,
      kind: "group",
      title: "Avatar projection audience",
      directKey: null,
      createdBy: alice.id,
      createdAt: chatCreatedAt
    });
    app.luxora.store.addChatMember(chatId, alice.id, "owner", chatCreatedAt);
    app.luxora.store.addChatMember(chatId, bob.id, "member", chatCreatedAt);

    const unauthenticated = await app.inject({
      method: "PUT",
      url: "/v1/me/avatar",
      payload: { attachmentId: sourceAttachmentId }
    });
    expect(unauthenticated.statusCode).toBe(401);

    const idor = await app.inject({
      method: "PUT",
      url: "/v1/me/avatar",
      headers: authorization(bob),
      payload: { attachmentId: sourceAttachmentId }
    });
    expect(idor.statusCode).toBe(404);
    expect(idor.json().error.message).toBe("Attachment not found");

    const beforeBound = app.luxora.store.getLatestSequence();
    const bound = await app.inject({
      method: "PUT",
      url: "/v1/me/avatar",
      headers: authorization(alice),
      payload: { attachmentId: sourceAttachmentId }
    });
    expect(bound.statusCode, bound.body).toBe(200);
    expect(bound.json().user).toMatchObject({
      id: alice.id,
      avatarUrl: null
    });
    const avatarPath = bound.json().user.avatarPath as string;
    expect(avatarPath).toMatch(/^\/v1\/attachments\/[0-9a-f-]+\/content$/u);
    const avatarAttachmentId = avatarPath.split("/")[3] as string;
    expect(avatarAttachmentId).not.toBe(sourceAttachmentId);

    const derivative = app.luxora.store.findAttachmentRecord(avatarAttachmentId);
    expect(derivative).toMatchObject({
      ownerUserId: alice.id,
      kind: "image",
      declaredMimeType: "image/png",
      detectedMimeType: "image/png",
      metadata: { width: 512, height: 512, sourceSha256: digest(PNG) },
      safetyStatus: "reencoded",
      metadataTrust: "server_verified"
    });
    expect(derivative?.linkedAt).not.toBeNull();
    expect(derivative?.sha256).not.toBe(digest(PNG));
    const afterBound = app.luxora.store.getLatestSequence();
    for (const identity of [alice, bob]) {
      expect(app.luxora.store.replayEvents(identity.id, beforeBound, afterBound, 100)
        .map(({ event }) => event)).toEqual([
          expect.objectContaining({
            type: "sync.invalidated",
            audience: "account_projection",
            accountId: identity.id,
            reason: "avatar_updated"
          })
        ]);
    }
    expect(app.luxora.store.replayEvents(outsider.id, beforeBound, afterBound, 100)).toEqual([]);

    const ownerDownload = await app.inject({
      method: "GET",
      url: avatarPath,
      headers: authorization(alice)
    });
    expect(ownerDownload.statusCode).toBe(200);
    expect(ownerDownload.headers["content-type"]).toBe("image/png");
    expect(ownerDownload.rawPayload.subarray(0, 8)).toEqual(
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
    );
    expect(ownerDownload.rawPayload.length).toBe(derivative?.sizeBytes);

    const replay = await app.inject({
      method: "PUT",
      url: "/v1/me/avatar",
      headers: authorization(alice),
      payload: { attachmentId: sourceAttachmentId }
    });
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toEqual(bound.json());
    expect(app.luxora.store.getLatestSequence()).toBe(afterBound);
    expect(app.luxora.store.listOwnedAttachments(alice.id, 10).items).toHaveLength(2);

    const lookup = await app.inject({
      method: "GET",
      url: `/v1/users/lookup?username=${alice.username}`,
      headers: authorization(bob)
    });
    expect(lookup.statusCode).toBe(200);
    expect(lookup.json().profile.avatarPath).toBe(avatarPath);
    const discoverableDownload = await app.inject({
      method: "GET",
      url: avatarPath,
      headers: authorization(bob)
    });
    expect(discoverableDownload.statusCode).toBe(200);

    const blocked = await app.inject({
      method: "PUT",
      url: `/v1/blocks/${bob.id}`,
      headers: authorization(alice)
    });
    expect(blocked.statusCode).toBe(200);
    const blockedDownload = await app.inject({
      method: "GET",
      url: avatarPath,
      headers: authorization(bob)
    });
    expect(blockedDownload.statusCode).toBe(404);

    const beforeClear = app.luxora.store.getLatestSequence();
    const cleared = await app.inject({
      method: "DELETE",
      url: "/v1/me/avatar",
      headers: authorization(alice)
    });
    expect(cleared.statusCode).toBe(200);
    expect(cleared.json().user.avatarPath).toBeNull();
    expect(app.luxora.store.findAttachmentRecord(avatarAttachmentId)?.linkedAt).toBeNull();
    const afterClearSequence = app.luxora.store.getLatestSequence();
    for (const identity of [alice, bob]) {
      expect(app.luxora.store.replayEvents(identity.id, beforeClear, afterClearSequence, 100)
        .map(({ event }) => event)).toEqual([
          expect.objectContaining({
            type: "sync.invalidated",
            accountId: identity.id,
            reason: "avatar_updated"
          })
        ]);
    }
    expect(app.luxora.store.replayEvents(
      outsider.id,
      beforeClear,
      afterClearSequence,
      100
    )).toEqual([]);
    const afterClear = await app.inject({
      method: "GET",
      url: avatarPath,
      headers: authorization(bob)
    });
    expect(afterClear.statusCode).toBe(404);
    expect((await app.inject({
      method: "DELETE",
      url: "/v1/me/avatar",
      headers: authorization(alice)
    })).statusCode).toBe(200);
    expect(app.luxora.store.getLatestSequence()).toBe(afterClearSequence);
  });

  it("rejects invalid and expansive avatar mutations", async () => {
    app = await buildApp({ config: testConfig(), logger: false });
    const owner = await register("avatar_validation");
    for (const payload of [
      {},
      { attachmentId: "not-a-uuid" },
      { attachmentId: randomUUID(), avatarUrl: "https://example.test/injected.png" }
    ]) {
      const response = await app.inject({
        method: "PUT",
        url: "/v1/me/avatar",
        headers: authorization(owner),
        payload
      });
      expect(response.statusCode).toBe(400);
      expect(response.json().error.code).toBe("VALIDATION_FAILED");
    }
  });

  it("keeps avatar mutations functional without advancing realtime head when invalidation is disabled", async () => {
    const storageRoot = await mkdtemp(join(tmpdir(), "luxora-profile-avatar-fallback-"));
    temporaryRoots.push(storageRoot);
    const key = Buffer.alloc(32, 118).toString("base64url");
    app = await buildApp({
      config: testConfig({
        dataEncryptionKeys: { avatar_fallback: key },
        activeDataEncryptionKeyId: "avatar_fallback",
        storageLocalPath: join(storageRoot, "blobs"),
        uploadStagingPath: join(storageRoot, "uploads"),
        syncInvalidationEnabled: false
      }),
      logger: false
    });
    const owner = await register("avatar_fallback");
    const sourceAttachmentId = await uploadImage(owner);
    const beforeSet = app.luxora.store.getLatestSequence();

    const bound = await app.inject({
      method: "PUT",
      url: "/v1/me/avatar",
      headers: authorization(owner),
      payload: { attachmentId: sourceAttachmentId }
    });
    expect(bound.statusCode, bound.body).toBe(200);
    expect(bound.json().user.avatarPath).toMatch(/^\/v1\/attachments\//u);
    expect(app.luxora.store.getLatestSequence()).toBe(beforeSet);

    const cleared = await app.inject({
      method: "DELETE",
      url: "/v1/me/avatar",
      headers: authorization(owner)
    });
    expect(cleared.statusCode, cleared.body).toBe(200);
    expect(cleared.json().user.avatarPath).toBeNull();
    expect(app.luxora.store.getLatestSequence()).toBe(beforeSet);
  });

  it("rechecks storage quota under the avatar writer lock and leaves no derivative record", async () => {
    const storageRoot = await mkdtemp(join(tmpdir(), "luxora-profile-avatar-quota-"));
    temporaryRoots.push(storageRoot);
    app = await buildApp({
      config: testConfig({
        userStorageQuotaBytes: 1_000,
        storageLocalPath: join(storageRoot, "blobs"),
        uploadStagingPath: join(storageRoot, "uploads")
      }),
      logger: false
    });
    const owner = await register("avatar_quota");
    const sourceAttachmentId = await uploadImage(owner);
    const response = await app.inject({
      method: "PUT",
      url: "/v1/me/avatar",
      headers: authorization(owner),
      payload: { attachmentId: sourceAttachmentId }
    });
    expect(response.statusCode).toBe(413);
    expect(response.json().error).toMatchObject({
      code: "BAD_REQUEST",
      message: "User storage quota would be exceeded"
    });
    expect(app.luxora.store.findUserById(owner.id)).toMatchObject({
      avatarAttachmentId: null,
      avatarPath: null
    });
    expect(app.luxora.store.listOwnedAttachments(owner.id, 10).items.map(({ id }) => id))
      .toEqual([sourceAttachmentId]);
  });
});
