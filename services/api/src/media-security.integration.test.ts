import { createHash, randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LuxoraApp } from "./app.js";
import { buildApp } from "./app.js";
import { establishAcceptedRelationship, testConfig } from "./test-helpers.js";

interface Identity {
  id: string;
  accessToken: string;
}

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64"
);

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

describe("media security and correctness boundaries", () => {
  let app: LuxoraApp | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  function auth(identity: Identity): { authorization: string } {
    return { authorization: `Bearer ${identity.accessToken}` };
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

  async function createUpload(
    identity: Identity,
    bytes: Buffer,
    overrides: Record<string, unknown> = {}
  ) {
    return app!.inject({
      method: "POST",
      url: "/v1/uploads",
      headers: auth(identity),
      payload: {
        kind: "image",
        fileName: "pixel.png",
        mimeType: "image/png",
        sizeBytes: bytes.length,
        sha256: sha256(bytes),
        idempotencyKey: randomUUID(),
        metadata: { width: 1, height: 1 },
        ...overrides
      }
    });
  }

  async function putChunk(identity: Identity, uploadId: string, bytes: Buffer) {
    return app!.inject({
      method: "PUT",
      url: `/v1/uploads/${uploadId}/chunks/0`,
      headers: {
        ...auth(identity),
        "content-type": "application/octet-stream",
        "content-length": String(bytes.length),
        "content-range": `bytes 0-${bytes.length - 1}/${bytes.length}`,
        "x-chunk-sha256": sha256(bytes)
      },
      payload: bytes
    });
  }

  async function uploadAttachment(identity: Identity, fileName: string): Promise<string> {
    const created = await createUpload(identity, PNG, { fileName });
    expect(created.statusCode).toBe(201);
    const uploadId = created.json().upload.id as string;
    expect((await putChunk(identity, uploadId, PNG)).statusCode).toBe(200);
    const completed = await app!.inject({
      method: "POST",
      url: `/v1/uploads/${uploadId}/complete`,
      headers: auth(identity)
    });
    expect(completed.statusCode).toBe(200);
    return completed.json().upload.attachment.id as string;
  }

  async function sendAttachment(
    identity: Identity,
    chatId: string,
    attachmentId: string | string[]
  ): Promise<string> {
    const attachmentIds = Array.isArray(attachmentId) ? attachmentId : [attachmentId];
    const response = await app!.inject({
      method: "POST",
      url: `/v1/chats/${chatId}/messages`,
      headers: auth(identity),
      payload: { body: null, attachmentIds, clientNonce: randomUUID() }
    });
    expect(response.statusCode).toBe(201);
    return response.json().message.id as string;
  }

  async function download(identity: Identity, attachmentId: string, range?: string) {
    return app!.inject({
      method: "GET",
      url: `/v1/attachments/${attachmentId}/content`,
      headers: { ...auth(identity), ...(range === undefined ? {} : { range }) }
    });
  }

  async function fileSearch(identity: Identity, query: string) {
    return app!.inject({
      method: "GET",
      url: `/v1/search/files?q=${encodeURIComponent(query)}`,
      headers: auth(identity)
    });
  }

  it("prevents upload/download/forward IDOR and handles filename and Range boundaries", async () => {
    const key = Buffer.alloc(32, 91).toString("base64url");
    app = await buildApp({
      config: testConfig({ dataEncryptionKeys: { active: key }, activeDataEncryptionKeyId: "active" }),
      logger: false
    });
    const alice = await register("media_sec_alice");
    const bob = await register("media_sec_bob");
    const eve = await register("media_sec_eve");

    for (const fileName of [
      "../secret.png",
      "dir\\secret.png",
      "evil\r\nX-Test: injected.png",
      "report\u202Egnp.exe",
      "\ud800.png"
    ]) {
      const rejected = await createUpload(alice, PNG, { fileName });
      expect(rejected.statusCode).toBe(400);
      expect(rejected.json().error.code).toBe("BAD_REQUEST");
    }

    const created = await createUpload(alice, PNG, { fileName: "idorboundary.png" });
    expect(created.statusCode).toBe(201);
    const uploadId = created.json().upload.id as string;
    expect((await app.inject({
      method: "GET",
      url: `/v1/uploads/${uploadId}`,
      headers: auth(eve)
    })).statusCode).toBe(404);
    expect((await putChunk(eve, uploadId, PNG)).statusCode).toBe(404);
    expect((await app.inject({
      method: "POST",
      url: `/v1/uploads/${uploadId}/complete`,
      headers: auth(eve)
    })).statusCode).toBe(404);

    expect((await putChunk(alice, uploadId, PNG)).statusCode).toBe(200);
    const completed = await app.inject({
      method: "POST",
      url: `/v1/uploads/${uploadId}/complete`,
      headers: auth(alice)
    });
    const attachmentId = completed.json().upload.attachment.id as string;

    const unauthenticated = await app.inject({
      method: "GET",
      url: `/v1/attachments/${attachmentId}/content`,
      headers: { range: "bytes=999-" }
    });
    expect(unauthenticated.statusCode).toBe(401);
    expect(unauthenticated.json().error.message).toBe("Authentication required");
    expect(unauthenticated.headers["cache-control"]).toBe("private, no-store");
    expect(unauthenticated.headers["content-range"]).toBeUndefined();

    const inaccessible = await download(eve, attachmentId, "bytes=999-");
    const absent = await download(eve, randomUUID(), "bytes=999-");
    expect(inaccessible.statusCode).toBe(404);
    expect(absent.statusCode).toBe(404);
    expect(inaccessible.json().error.message).toBe("Attachment not found");
    expect(absent.json().error.message).toBe("Attachment not found");
    expect(inaccessible.headers["content-range"]).toBeUndefined();
    expect(inaccessible.headers["cache-control"]).toBe("private, no-store");
    expect(absent.headers["cache-control"]).toBe("private, no-store");
    expect(inaccessible.headers["x-content-type-options"]).toBe("nosniff");
    expect((await fileSearch(eve, "idorboundary")).json().items).toHaveLength(0);

    const directChatId = await establishAcceptedRelationship(app, alice, bob);
    expect((await download(bob, attachmentId)).statusCode).toBe(404);
    const sourceMessageId = await sendAttachment(alice, directChatId, attachmentId);
    expect((await fileSearch(bob, "idorboundary")).json().items)
      .toEqual([expect.objectContaining({ id: attachmentId })]);

    const suffix = await download(bob, attachmentId, "bytes=-8");
    expect(suffix.statusCode).toBe(206);
    expect(suffix.rawPayload).toEqual(PNG.subarray(PNG.length - 8));
    expect(suffix.headers["content-range"]).toBe(`bytes ${PNG.length - 8}-${PNG.length - 1}/${PNG.length}`);
    for (const range of ["bytes=0-", "bytes=0-999999"]) {
      const response = await download(bob, attachmentId, range);
      expect(response.statusCode).toBe(206);
      expect(response.rawPayload).toEqual(PNG);
      expect(response.headers["content-range"]).toBe(`bytes 0-${PNG.length - 1}/${PNG.length}`);
    }
    for (const range of [
      "bytes=",
      "bytes=8-7",
      "bytes=999-",
      "bytes=0-1,3-4",
      "items=0-1",
      "bytes=9007199254740992-9007199254740993"
    ]) {
      const response = await download(bob, attachmentId, range);
      expect(response.statusCode).toBe(416);
      expect(response.headers["content-range"]).toBe(`bytes */${PNG.length}`);
      expect(response.headers["cache-control"]).toBe("private, no-store");
    }

    const nonOwnerReuse = await app.inject({
      method: "POST",
      url: `/v1/chats/${directChatId}/messages`,
      headers: auth(bob),
      payload: { body: null, attachmentIds: [attachmentId], clientNonce: randomUUID() }
    });
    expect(nonOwnerReuse.statusCode).toBe(403);
    const outsiderForward = await app.inject({
      method: "POST",
      url: `/v1/messages/${sourceMessageId}/forward`,
      headers: auth(eve),
      payload: { chatId: randomUUID(), clientNonce: randomUUID() }
    });
    // Eve cannot see the source message at all, so the existing foreign ID is
    // concealed behind the same generic not-found oracle as an absent UUID.
    expect(outsiderForward.statusCode).toBe(404);
  });

  it("revokes Direct-derived download and search grants in both block directions without breaking group grants", async () => {
    const key = Buffer.alloc(32, 92).toString("base64url");
    app = await buildApp({
      config: testConfig({ dataEncryptionKeys: { active: key }, activeDataEncryptionKeyId: "active" }),
      logger: false
    });
    const alice = await register("media_block_alice");
    const bob = await register("media_block_bob");
    const eve = await register("media_block_eve");
    const aliceBobDirect = await establishAcceptedRelationship(app, alice, bob);
    const aliceEveDirect = await establishAcceptedRelationship(app, alice, eve);
    const group = await app.inject({
      method: "POST",
      url: "/v1/chats",
      headers: auth(alice),
      payload: { kind: "group", title: "Media boundary", memberIds: [bob.id] }
    });
    expect(group.statusCode).toBe(201);
    const groupId = group.json().chat.id as string;
    const eveGroup = await app.inject({
      method: "POST",
      url: "/v1/chats",
      headers: auth(eve),
      payload: { kind: "group", title: "Eve forward target", memberIds: [] }
    });
    expect(eveGroup.statusCode).toBe(201);
    const eveGroupId = eveGroup.json().chat.id as string;

    const bobDirectAttachment = await uploadAttachment(alice, "directbob.png");
    const eveDirectAttachment = await uploadAttachment(alice, "directeve.png");
    const groupAttachment = await uploadAttachment(alice, "groupshared.png");
    const bobDirectMessageId = await sendAttachment(
      alice,
      aliceBobDirect,
      [bobDirectAttachment, groupAttachment]
    );
    const eveDirectMessageId = await sendAttachment(alice, aliceEveDirect, eveDirectAttachment);
    const groupMessageId = await sendAttachment(alice, groupId, groupAttachment);

    expect((await download(bob, bobDirectAttachment)).statusCode).toBe(200);
    expect((await download(eve, eveDirectAttachment)).statusCode).toBe(200);
    expect((await download(bob, groupAttachment)).statusCode).toBe(200);

    expect((await app.inject({
      method: "PUT",
      url: `/v1/blocks/${alice.id}`,
      headers: auth(bob)
    })).statusCode).toBe(200);
    expect((await download(bob, bobDirectAttachment)).statusCode).toBe(404);
    expect((await fileSearch(bob, "directbob")).json().items).toHaveLength(0);
    expect((await download(bob, groupAttachment)).statusCode).toBe(200);
    expect((await fileSearch(bob, "groupshared")).json().items)
      .toEqual([expect.objectContaining({ id: groupAttachment })]);

    const groupBeforeDeniedForward = await app.inject({
      method: "GET",
      url: `/v1/chats/${groupId}/messages`,
      headers: auth(bob)
    });
    const sequenceBeforeDeniedForward = app.luxora.store.getLatestSequence();
    const deniedMixedForward = await app.inject({
      method: "POST",
      url: `/v1/messages/${bobDirectMessageId}/forward`,
      headers: auth(bob),
      payload: { chatId: groupId, clientNonce: randomUUID() }
    });
    expect(deniedMixedForward.statusCode).toBe(404);
    expect(deniedMixedForward.json().error.message).toBe("Source message not found");
    expect(app.luxora.store.getLatestSequence()).toBe(sequenceBeforeDeniedForward);
    const groupAfterDeniedForward = await app.inject({
      method: "GET",
      url: `/v1/chats/${groupId}/messages`,
      headers: auth(bob)
    });
    expect(groupAfterDeniedForward.json().items.map((message: { id: string }) => message.id))
      .toEqual(groupBeforeDeniedForward.json().items.map((message: { id: string }) => message.id));

    expect((await download(alice, bobDirectAttachment)).statusCode).toBe(200);
    expect((await fileSearch(alice, "directbob")).json().items)
      .toEqual([expect.objectContaining({ id: bobDirectAttachment })]);

    expect((await app.inject({
      method: "DELETE",
      url: `/v1/blocks/${alice.id}`,
      headers: auth(bob)
    })).statusCode).toBe(200);
    expect((await download(bob, bobDirectAttachment)).statusCode).toBe(404);
    expect((await fileSearch(bob, "directbob")).json().items).toHaveLength(0);

    expect((await app.inject({
      method: "PUT",
      url: `/v1/blocks/${eve.id}`,
      headers: auth(alice)
    })).statusCode).toBe(200);
    expect((await download(eve, eveDirectAttachment)).statusCode).toBe(404);
    expect((await fileSearch(eve, "directeve")).json().items).toHaveLength(0);
    expect((await download(alice, eveDirectAttachment)).statusCode).toBe(200);

    const eveSequenceBefore = app.luxora.store.getLatestSequence();
    const eveDeniedForward = await app.inject({
      method: "POST",
      url: `/v1/messages/${eveDirectMessageId}/forward`,
      headers: auth(eve),
      payload: { chatId: eveGroupId, clientNonce: randomUUID() }
    });
    expect(eveDeniedForward.statusCode).toBe(404);
    expect(eveDeniedForward.json().error.message).toBe("Source message not found");
    expect(app.luxora.store.getLatestSequence()).toBe(eveSequenceBefore);
    expect((await app.inject({
      method: "GET",
      url: `/v1/chats/${eveGroupId}/messages`,
      headers: auth(eve)
    })).json().items).toHaveLength(0);

    const groupForward = await app.inject({
      method: "POST",
      url: `/v1/messages/${groupMessageId}/forward`,
      headers: auth(bob),
      payload: { chatId: groupId, clientNonce: randomUUID() }
    });
    expect(groupForward.statusCode).toBe(201);
    expect(groupForward.json().message.attachments[0].id).toBe(groupAttachment);

    const ownerForward = await app.inject({
      method: "POST",
      url: `/v1/messages/${bobDirectMessageId}/forward`,
      headers: auth(alice),
      payload: { chatId: groupId, clientNonce: randomUUID() }
    });
    expect(ownerForward.statusCode).toBe(201);
    expect(ownerForward.json().message.attachments.map((attachment: { id: string }) => attachment.id))
      .toEqual([bobDirectAttachment, groupAttachment]);
  });

  it("rejects late duplicate chunks during completion and leaves one canonical attachment", async () => {
    const key = Buffer.alloc(32, 93).toString("base64url");
    app = await buildApp({
      config: testConfig({ dataEncryptionKeys: { active: key }, activeDataEncryptionKeyId: "active" }),
      logger: false
    });
    const alice = await register("media_race_alice");
    const created = await createUpload(alice, PNG, { fileName: "completionrace.png" });
    const uploadId = created.json().upload.id as string;
    expect((await putChunk(alice, uploadId, PNG)).statusCode).toBe(200);

    const originalPut = app.luxora.storage.put.bind(app.luxora.storage);
    let markEntered!: () => void;
    let releasePut!: () => void;
    const entered = new Promise<void>((resolve) => { markEntered = resolve; });
    const release = new Promise<void>((resolve) => { releasePut = resolve; });
    app.luxora.storage.put = vi.fn(async (input) => {
      markEntered();
      await release;
      return originalPut(input);
    });

    const completing = app.inject({
      method: "POST",
      url: `/v1/uploads/${uploadId}/complete`,
      headers: auth(alice)
    });
    await entered;
    try {
      const lateDuplicate = await putChunk(alice, uploadId, PNG);
      expect(lateDuplicate.statusCode).toBe(409);
      expect(lateDuplicate.json().error.message).toContain("completing");
    } finally {
      releasePut();
    }
    const completed = await completing;
    expect(completed.statusCode).toBe(200);
    const attachmentId = completed.json().upload.attachment.id as string;
    expect((await putChunk(alice, uploadId, PNG)).statusCode).toBe(409);
    expect((await download(alice, attachmentId)).rawPayload).toEqual(PNG);
    expect((await app.inject({
      method: "POST",
      url: `/v1/uploads/${uploadId}/complete`,
      headers: auth(alice)
    })).json().upload.attachment.id).toBe(attachmentId);
  });

  it("rejects malformed chunk index, offset, total, digest, and range syntax without reserving bytes twice", async () => {
    app = await buildApp({ config: testConfig(), logger: false });
    const alice = await register("media_chunk_bounds");
    const created = await createUpload(alice, PNG, { fileName: "chunkbounds.png" });
    const uploadId = created.json().upload.id as string;
    const request = (
      index: string,
      contentRange: string,
      digest = sha256(PNG),
      contentType = "application/octet-stream"
    ) => app!.inject({
      method: "PUT",
      url: `/v1/uploads/${uploadId}/chunks/${index}`,
      headers: {
        ...auth(alice),
        "content-type": contentType,
        "content-length": String(PNG.length),
        "content-range": contentRange,
        "x-chunk-sha256": digest
      },
      payload: contentType === "application/octet-stream" ? PNG : { invalid: true }
    });
    const validRange = `bytes 0-${PNG.length - 1}/${PNG.length}`;
    const cases: Array<Promise<Awaited<ReturnType<typeof request>>>> = [
      request("1", validRange),
      request("0", `bytes 1-${PNG.length}/${PNG.length + 1}`),
      request("0", `bytes 0-${PNG.length - 2}/${PNG.length}`),
      request("0", `bytes 0-${PNG.length - 1}/${PNG.length + 1}`),
      request("0", `bytes 0-${PNG.length - 1}/*`),
      request("0", "bytes 0-9007199254740992/9007199254740993"),
      request("0", validRange, sha256(PNG).toUpperCase()),
      request("0", validRange, sha256(PNG), "application/json")
    ];
    for (const pending of cases) {
      const response = await pending;
      expect(response.statusCode).toBe(400);
    }
    const unchanged = await app.inject({
      method: "GET",
      url: `/v1/uploads/${uploadId}`,
      headers: auth(alice)
    });
    expect(unchanged.json().upload).toMatchObject({ receivedBytes: 0, receivedChunkIndexes: [] });
    expect((await putChunk(alice, uploadId, PNG)).statusCode).toBe(200);
    expect((await putChunk(alice, uploadId, PNG)).json().upload.receivedBytes).toBe(PNG.length);
  });

  it("releases quota after a deterministic MIME failure and accepts verified generic declarations", async () => {
    const invalidImage = Buffer.alloc(PNG.length, 65);
    app = await buildApp({
      config: testConfig({ userStorageQuotaBytes: invalidImage.length }),
      logger: false
    });
    const alice = await register("media_quota_release");
    const invalid = await createUpload(alice, invalidImage, { fileName: "invalid.png" });
    expect(invalid.statusCode).toBe(201);
    const invalidId = invalid.json().upload.id as string;
    const reserved = await createUpload(alice, PNG, {
      fileName: "blocked-by-reservation.png",
      mimeType: "application/octet-stream"
    });
    expect(reserved.statusCode).toBe(413);
    expect((await putChunk(alice, invalidId, invalidImage)).statusCode).toBe(200);
    const failed = await app.inject({
      method: "POST",
      url: `/v1/uploads/${invalidId}/complete`,
      headers: auth(alice)
    });
    expect(failed.statusCode).toBe(400);
    expect((await app.inject({
      method: "GET",
      url: `/v1/uploads/${invalidId}`,
      headers: auth(alice)
    })).json().upload.status).toBe("failed");

    const mismatch = await createUpload(alice, PNG, {
      fileName: "declared-jpeg.png",
      mimeType: "image/jpeg"
    });
    expect(mismatch.statusCode).toBe(201);
    const mismatchId = mismatch.json().upload.id as string;
    expect((await putChunk(alice, mismatchId, PNG)).statusCode).toBe(200);
    const mismatchComplete = await app.inject({
      method: "POST",
      url: `/v1/uploads/${mismatchId}/complete`,
      headers: auth(alice)
    });
    expect(mismatchComplete.statusCode).toBe(400);
    expect(mismatchComplete.json().error.message).toContain("does not match detected");

    const generic = await createUpload(alice, PNG, {
      fileName: "verified-generic.png",
      mimeType: "application/octet-stream"
    });
    expect(generic.statusCode).toBe(201);
    const genericId = generic.json().upload.id as string;
    expect((await putChunk(alice, genericId, PNG)).statusCode).toBe(200);
    const completed = await app.inject({
      method: "POST",
      url: `/v1/uploads/${genericId}/complete`,
      headers: auth(alice)
    });
    expect(completed.statusCode).toBe(200);
    expect(completed.json().upload.attachment).toMatchObject({
      mimeType: "image/png",
      safetyStatus: "unscanned",
      metadataTrust: "client_declared"
    });
  });
});
