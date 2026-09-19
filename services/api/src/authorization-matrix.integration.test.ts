import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import type { LuxoraApp } from "./app.js";
import { buildApp } from "./app.js";
import { CapabilitiesResponseV1Schema, type ChatKind, type ChatRole } from "@luxora/protocol";
import { establishAcceptedRelationship, testConfig } from "./test-helpers.js";

const PASSWORD = "correct horse battery staple";
const RESOURCE_ID_CANARY = "9ec9347c-9306-4108-aab4-e7762b73b201";
const SECOND_RESOURCE_ID = "a0df9334-2ec0-422d-b5de-11c775a42344";
const CONTENT_CANARY = "AUTHZ_MATRIX_PRIVATE_CONTENT_CANARY";
const PROFILE_CANARY = "AUTHZ_MATRIX_PRIVATE_PROFILE_CANARY";
const TOKEN_CANARY = "AUTHZ_MATRIX_PRIVATE_TOKEN_CANARY";
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64"
);

type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

interface HttpProbe {
  key: `${HttpMethod} ${string}`;
  method: HttpMethod;
  url: string;
  payload?: Record<string, unknown> | Buffer | string;
  headers?: Record<string, string>;
}

const PUBLIC_HTTP_POLICIES = [
  "GET /health/live",
  "GET /health/ready",
  "GET /metrics",
  "GET /v1/capabilities",
  "POST /v1/auth/register",
  "POST /v1/auth/login",
  "POST /v1/auth/refresh",
  "POST /v1/auth/phone/challenges",
  "POST /v1/auth/phone/challenges/:id/verify",
  "POST /v1/auth/phone/password",
  "POST /v1/auth/phone/recovery/start",
  "POST /v1/auth/phone/recovery/complete",
  "POST /v1/auth/phone/registrations",
  "POST /v1/auth/phone/usernames/check",
  "GET /openapi.json"
] as const;

// Every explicitly registered protected HTTP route must appear here. The
// source-inventory assertion below fails when a route is added without a
// corresponding executable unauthenticated probe and matrix documentation.
const PROTECTED_HTTP_MATRIX: HttpProbe[] = [
  { key: "GET /v1/auth/sessions", method: "GET", url: "/v1/auth/sessions" },
  { key: "DELETE /v1/auth/sessions/current", method: "DELETE", url: "/v1/auth/sessions/current" },
  { key: "DELETE /v1/auth/sessions/:id", method: "DELETE", url: `/v1/auth/sessions/${RESOURCE_ID_CANARY}` },
  { key: "GET /v1/me", method: "GET", url: "/v1/me" },
  {
    key: "PATCH /v1/me",
    method: "PATCH",
    url: "/v1/me",
    payload: { displayName: PROFILE_CANARY }
  },
  {
    key: "PUT /v1/me/avatar",
    method: "PUT",
    url: "/v1/me/avatar",
    payload: { attachmentId: RESOURCE_ID_CANARY }
  },
  { key: "DELETE /v1/me/avatar", method: "DELETE", url: "/v1/me/avatar" },
  { key: "GET /v1/me/phone-password", method: "GET", url: "/v1/me/phone-password" },
  {
    key: "PUT /v1/me/phone-password",
    method: "PUT",
    url: "/v1/me/phone-password",
    payload: { password: PASSWORD }
  },
  {
    key: "DELETE /v1/me/phone-password",
    method: "DELETE",
    url: "/v1/me/phone-password",
    payload: { currentPassword: PASSWORD }
  },
  {
    key: "POST /v1/me/phone/binding/challenges",
    method: "POST",
    url: "/v1/me/phone/binding/challenges",
    payload: { countryCode: "7", nationalNumber: "9991234567", clientNonce: SECOND_RESOURCE_ID }
  },
  {
    key: "POST /v1/me/phone/binding/complete",
    method: "POST",
    url: "/v1/me/phone/binding/complete",
    payload: {
      bindingToken: `luxbt_${"A".repeat(43)}`,
      clientNonce: SECOND_RESOURCE_ID
    }
  },
  { key: "GET /v1/admin/status", method: "GET", url: "/v1/admin/status" },
  { key: "GET /v1/admin/users", method: "GET", url: "/v1/admin/users?limit=5" },
  { key: "GET /v1/admin/chats", method: "GET", url: "/v1/admin/chats?limit=5" },
  {
    key: "PUT /v1/messages/:messageId/transcript",
    method: "PUT",
    url: `/v1/messages/${RESOURCE_ID_CANARY}/transcript`,
    payload: { text: "Transcription probe", clientNonce: SECOND_RESOURCE_ID }
  },
  {
    key: "POST /v1/chats/:id/scheduled",
    method: "POST",
    url: `/v1/chats/${RESOURCE_ID_CANARY}/scheduled`,
    payload: { body: "Scheduled probe", clientNonce: SECOND_RESOURCE_ID, sendAt: "2026-09-12T00:00:00.000Z" }
  },
  {
    key: "GET /v1/chats/:id/scheduled",
    method: "GET",
    url: `/v1/chats/${RESOURCE_ID_CANARY}/scheduled?limit=5`
  },
  {
    key: "DELETE /v1/scheduled/:id",
    method: "DELETE",
    url: `/v1/scheduled/${RESOURCE_ID_CANARY}`
  },
  {
    key: "GET /v1/push/registrations/current",
    method: "GET",
    url: "/v1/push/registrations/current"
  },
  {
    key: "PUT /v1/push/registrations/current",
    method: "PUT",
    url: "/v1/push/registrations/current",
    payload: { platform: "apns", environment: "development", token: "ab".repeat(32) }
  },
  {
    key: "DELETE /v1/push/registrations/current",
    method: "DELETE",
    url: "/v1/push/registrations/current"
  },
  {
    key: "GET /v1/notifications/settings",
    method: "GET",
    url: "/v1/notifications/settings"
  },
  {
    key: "PATCH /v1/notifications/settings",
    method: "PATCH",
    url: "/v1/notifications/settings",
    payload: { previewMode: "hidden" }
  },
  { key: "GET /v1/users/search", method: "GET", url: `/v1/users/search?q=${PROFILE_CANARY}` },
  { key: "GET /v1/users/lookup", method: "GET", url: "/v1/users/lookup?username=profile_canary" },
  { key: "GET /v1/privacy", method: "GET", url: "/v1/privacy" },
  {
    key: "PATCH /v1/privacy",
    method: "PATCH",
    url: "/v1/privacy",
    payload: { usernameDiscoverable: false }
  },
  {
    key: "POST /v1/message-requests",
    method: "POST",
    url: "/v1/message-requests",
    payload: { recipientUserId: RESOURCE_ID_CANARY, body: CONTENT_CANARY, clientNonce: SECOND_RESOURCE_ID }
  },
  {
    key: "GET /v1/message-requests",
    method: "GET",
    url: "/v1/message-requests?direction=incoming"
  },
  {
    key: "POST /v1/message-requests/:id/accept",
    method: "POST",
    url: `/v1/message-requests/${RESOURCE_ID_CANARY}/accept`
  },
  {
    key: "DELETE /v1/message-requests/:id",
    method: "DELETE",
    url: `/v1/message-requests/${RESOURCE_ID_CANARY}`
  },
  { key: "PUT /v1/blocks/:accountId", method: "PUT", url: `/v1/blocks/${RESOURCE_ID_CANARY}` },
  { key: "DELETE /v1/blocks/:accountId", method: "DELETE", url: `/v1/blocks/${RESOURCE_ID_CANARY}` },
  { key: "GET /v1/blocks", method: "GET", url: "/v1/blocks" },
  {
    key: "POST /v1/safety/reports",
    method: "POST",
    url: "/v1/safety/reports",
    payload: {
      subjectAccountId: RESOURCE_ID_CANARY,
      category: "other",
      evidence: [],
      comment: CONTENT_CANARY,
      clientNonce: SECOND_RESOURCE_ID,
      alsoBlock: false
    }
  },
  { key: "GET /v1/chat-folders", method: "GET", url: "/v1/chat-folders" },
  {
    key: "POST /v1/chat-folders",
    method: "POST",
    url: "/v1/chat-folders",
    payload: {
      title: CONTENT_CANARY,
      rules: {
        includeKinds: ["direct"],
        unreadOnly: false,
        excludeMuted: false,
        includeArchived: false
      },
      overrides: [],
      clientNonce: SECOND_RESOURCE_ID
    }
  },
  {
    key: "PUT /v1/chat-folders/order",
    method: "PUT",
    url: "/v1/chat-folders/order",
    payload: {
      folderIds: [RESOURCE_ID_CANARY],
      expectedStateRevision: 0,
      clientNonce: SECOND_RESOURCE_ID
    }
  },
  {
    key: "PATCH /v1/chat-folders/:id",
    method: "PATCH",
    url: `/v1/chat-folders/${RESOURCE_ID_CANARY}`,
    payload: { title: CONTENT_CANARY, expectedRevision: 1, clientNonce: SECOND_RESOURCE_ID }
  },
  {
    key: "DELETE /v1/chat-folders/:id",
    method: "DELETE",
    url: `/v1/chat-folders/${RESOURCE_ID_CANARY}`,
    payload: { expectedRevision: 1, clientNonce: SECOND_RESOURCE_ID }
  },
  { key: "GET /v1/chats", method: "GET", url: "/v1/chats" },
  {
    key: "POST /v1/chats",
    method: "POST",
    url: "/v1/chats",
    payload: { kind: "direct", userId: RESOURCE_ID_CANARY }
  },
  { key: "GET /v1/chats/:id", method: "GET", url: `/v1/chats/${RESOURCE_ID_CANARY}` },
  {
    key: "GET /v1/chats/:id/preferences",
    method: "GET",
    url: `/v1/chats/${RESOURCE_ID_CANARY}/preferences`
  },
  {
    key: "PATCH /v1/chats/:id/preferences",
    method: "PATCH",
    url: `/v1/chats/${RESOURCE_ID_CANARY}/preferences`,
    payload: { archived: true }
  },
  {
    key: "GET /v1/chats/:id/draft",
    method: "GET",
    url: `/v1/chats/${RESOURCE_ID_CANARY}/draft`
  },
  {
    key: "PUT /v1/chats/:id/draft",
    method: "PUT",
    url: `/v1/chats/${RESOURCE_ID_CANARY}/draft`,
    payload: {
      text: CONTENT_CANARY,
      expectedRevision: 0,
      clientNonce: SECOND_RESOURCE_ID
    }
  },
  {
    key: "DELETE /v1/chats/:id/draft",
    method: "DELETE",
    url: `/v1/chats/${RESOURCE_ID_CANARY}/draft`,
    payload: { expectedRevision: 1, clientNonce: SECOND_RESOURCE_ID }
  },
  {
    key: "GET /v1/chats/:id/members",
    method: "GET",
    url: `/v1/chats/${RESOURCE_ID_CANARY}/members`
  },
  {
    key: "POST /v1/chats/:id/members",
    method: "POST",
    url: `/v1/chats/${RESOURCE_ID_CANARY}/members`,
    payload: { userId: SECOND_RESOURCE_ID, role: "member", clientNonce: RESOURCE_ID_CANARY }
  },
  {
    key: "PATCH /v1/chats/:id/members/:userId",
    method: "PATCH",
    url: `/v1/chats/${RESOURCE_ID_CANARY}/members/${SECOND_RESOURCE_ID}`,
    payload: { role: "admin", expectedRevision: 1, clientNonce: RESOURCE_ID_CANARY }
  },
  {
    key: "DELETE /v1/chats/:id/members/:userId",
    method: "DELETE",
    url: `/v1/chats/${RESOURCE_ID_CANARY}/members/${SECOND_RESOURCE_ID}`,
    payload: { expectedRevision: 1, clientNonce: RESOURCE_ID_CANARY }
  },
  {
    key: "POST /v1/chats/:id/invite-links",
    method: "POST",
    url: `/v1/chats/${RESOURCE_ID_CANARY}/invite-links`,
    payload: { maxUses: 5, clientNonce: RESOURCE_ID_CANARY }
  },
  {
    key: "GET /v1/chats/:id/invite-links",
    method: "GET",
    url: `/v1/chats/${RESOURCE_ID_CANARY}/invite-links`
  },
  {
    key: "DELETE /v1/chats/:id/invite-links/:linkId",
    method: "DELETE",
    url: `/v1/chats/${RESOURCE_ID_CANARY}/invite-links/${SECOND_RESOURCE_ID}`
  },
  {
    key: "POST /v1/invite-links/join",
    method: "POST",
    url: "/v1/invite-links/join",
    payload: { token: "A".repeat(43), clientNonce: RESOURCE_ID_CANARY }
  },
  {
    key: "GET /v1/chats/:id/join-requests",
    method: "GET",
    url: `/v1/chats/${RESOURCE_ID_CANARY}/join-requests`
  },
  {
    key: "POST /v1/chats/:id/join-requests/:requestId/approve",
    method: "POST",
    url: `/v1/chats/${RESOURCE_ID_CANARY}/join-requests/${SECOND_RESOURCE_ID}/approve`
  },
  {
    key: "POST /v1/chats/:id/join-requests/:requestId/deny",
    method: "POST",
    url: `/v1/chats/${RESOURCE_ID_CANARY}/join-requests/${SECOND_RESOURCE_ID}/deny`
  },
  {
    key: "POST /v1/chats/:id/ownership-transfers",
    method: "POST",
    url: `/v1/chats/${RESOURCE_ID_CANARY}/ownership-transfers`,
    payload: { targetUserId: SECOND_RESOURCE_ID, clientNonce: RESOURCE_ID_CANARY }
  },
  {
    key: "GET /v1/chats/:id/ownership-transfers",
    method: "GET",
    url: `/v1/chats/${RESOURCE_ID_CANARY}/ownership-transfers`
  },
  {
    key: "POST /v1/chats/:id/ownership-transfers/:transferId/accept",
    method: "POST",
    url: `/v1/chats/${RESOURCE_ID_CANARY}/ownership-transfers/${SECOND_RESOURCE_ID}/accept`
  },
  {
    key: "POST /v1/chats/:id/ownership-transfers/:transferId/cancel",
    method: "POST",
    url: `/v1/chats/${RESOURCE_ID_CANARY}/ownership-transfers/${SECOND_RESOURCE_ID}/cancel`
  },
  {
    key: "GET /v1/chats/:id/messages",
    method: "GET",
    url: `/v1/chats/${RESOURCE_ID_CANARY}/messages`
  },
  {
    key: "POST /v1/chats/:id/messages",
    method: "POST",
    url: `/v1/chats/${RESOURCE_ID_CANARY}/messages`,
    payload: { body: CONTENT_CANARY, clientNonce: SECOND_RESOURCE_ID }
  },
  {
    key: "PATCH /v1/messages/:messageId",
    method: "PATCH",
    url: `/v1/messages/${RESOURCE_ID_CANARY}`,
    payload: { body: CONTENT_CANARY }
  },
  { key: "DELETE /v1/messages/:messageId", method: "DELETE", url: `/v1/messages/${RESOURCE_ID_CANARY}` },
  {
    key: "GET /v1/messages/:messageId/history",
    method: "GET",
    url: `/v1/messages/${RESOURCE_ID_CANARY}/history`
  },
  {
    key: "POST /v1/messages/:messageId/forward",
    method: "POST",
    url: `/v1/messages/${RESOURCE_ID_CANARY}/forward`,
    payload: { chatId: SECOND_RESOURCE_ID, clientNonce: RESOURCE_ID_CANARY }
  },
  { key: "GET /v1/chats/:id/pins", method: "GET", url: `/v1/chats/${RESOURCE_ID_CANARY}/pins` },
  {
    key: "PUT /v1/chats/:id/pins/:messageId",
    method: "PUT",
    url: `/v1/chats/${RESOURCE_ID_CANARY}/pins/${SECOND_RESOURCE_ID}`
  },
  {
    key: "DELETE /v1/chats/:id/pins/:messageId",
    method: "DELETE",
    url: `/v1/chats/${RESOURCE_ID_CANARY}/pins/${SECOND_RESOURCE_ID}`
  },
  { key: "GET /v1/chats/:id/topics", method: "GET", url: `/v1/chats/${RESOURCE_ID_CANARY}/topics` },
  {
    key: "POST /v1/chats/:id/topics",
    method: "POST",
    url: `/v1/chats/${RESOURCE_ID_CANARY}/topics`,
    payload: { title: CONTENT_CANARY }
  },
  {
    key: "PATCH /v1/topics/:id",
    method: "PATCH",
    url: `/v1/topics/${RESOURCE_ID_CANARY}`,
    payload: { title: CONTENT_CANARY }
  },
  {
    key: "POST /v1/uploads",
    method: "POST",
    url: "/v1/uploads",
    payload: {
      kind: "image",
      fileName: "matrix.png",
      mimeType: "image/png",
      sizeBytes: PNG.length,
      sha256: createHash("sha256").update(PNG).digest("hex"),
      idempotencyKey: RESOURCE_ID_CANARY,
      metadata: {}
    }
  },
  { key: "GET /v1/uploads/:id", method: "GET", url: `/v1/uploads/${RESOURCE_ID_CANARY}` },
  {
    key: "PUT /v1/uploads/:id/chunks/:index",
    method: "PUT",
    url: `/v1/uploads/${RESOURCE_ID_CANARY}/chunks/0`,
    payload: PNG,
    headers: {
      "content-type": "application/octet-stream",
      "content-range": `bytes 0-${PNG.length - 1}/${PNG.length}`,
      "content-length": String(PNG.length),
      "x-chunk-sha256": createHash("sha256").update(PNG).digest("hex")
    }
  },
  {
    key: "POST /v1/uploads/:id/complete",
    method: "POST",
    url: `/v1/uploads/${RESOURCE_ID_CANARY}/complete`
  },
  {
    key: "GET /v1/attachments/:id/content",
    method: "GET",
    url: `/v1/attachments/${RESOURCE_ID_CANARY}/content`
  },
  {
    key: "GET /v1/attachments/:id/thumbnail",
    method: "GET",
    url: `/v1/attachments/${RESOURCE_ID_CANARY}/thumbnail`
  },
  {
    key: "POST /v1/calls",
    method: "POST",
    url: "/v1/calls",
    payload: { chatId: RESOURCE_ID_CANARY, mediaMode: "audio", clientNonce: SECOND_RESOURCE_ID }
  },
  {
    key: "GET /v1/calls/:id",
    method: "GET",
    url: `/v1/calls/${RESOURCE_ID_CANARY}`
  },
  {
    key: "POST /v1/calls/:id/cancel",
    method: "POST",
    url: `/v1/calls/${RESOURCE_ID_CANARY}/cancel`,
    payload: { expectedRevision: 1 }
  },
  {
    key: "POST /v1/calls/:id/hangup",
    method: "POST",
    url: `/v1/calls/${RESOURCE_ID_CANARY}/hangup`,
    payload: { expectedRevision: 1, scope: "self" }
  },
  {
    key: "POST /v1/calls/:id/ring",
    method: "POST",
    url: `/v1/calls/${RESOURCE_ID_CANARY}/ring`,
    payload: { expectedRevision: 1 }
  },
  {
    key: "POST /v1/calls/:id/accept",
    method: "POST",
    url: `/v1/calls/${RESOURCE_ID_CANARY}/accept`,
    payload: { expectedRevision: 1 }
  },
  {
    key: "POST /v1/calls/:id/decline",
    method: "POST",
    url: `/v1/calls/${RESOURCE_ID_CANARY}/decline`,
    payload: { expectedRevision: 1, reason: "declined" }
  },
  {
    key: "POST /v1/calls/:id/invite",
    method: "POST",
    url: `/v1/calls/${RESOURCE_ID_CANARY}/invite`,
    payload: { expectedRevision: 1, inviteeMemberId: SECOND_RESOURCE_ID }
  },
  {
    key: "POST /v1/calls/:id/join-grant",
    method: "POST",
    url: `/v1/calls/${RESOURCE_ID_CANARY}/join-grant`,
    payload: { requestedSources: ["microphone"] }
  },
  {
    key: "POST /v1/internal/calls/livekit-webhook",
    method: "POST",
    url: "/v1/internal/calls/livekit-webhook",
    payload: { event: "room_finished" },
    headers: { "content-type": "application/webhook+json" }
  },
  {
    key: "GET /v1/search/messages",
    method: "GET",
    url: `/v1/search/messages?q=${CONTENT_CANARY}`
  },
  { key: "GET /v1/search/files", method: "GET", url: `/v1/search/files?q=${CONTENT_CANARY}` },
  {
    key: "POST /v1/chats/:id/read",
    method: "POST",
    url: `/v1/chats/${RESOURCE_ID_CANARY}/read`,
    payload: { messageId: SECOND_RESOURCE_ID }
  },
  {
    key: "POST /v1/chats/:id/delivered",
    method: "POST",
    url: `/v1/chats/${RESOURCE_ID_CANARY}/delivered`,
    payload: { messageId: SECOND_RESOURCE_ID }
  },
  {
    key: "PUT /v1/messages/:messageId/reactions",
    method: "PUT",
    url: `/v1/messages/${RESOURCE_ID_CANARY}/reactions`,
    payload: { emoji: "🔒" }
  },
  {
    key: "DELETE /v1/messages/:messageId/reactions",
    method: "DELETE",
    url: `/v1/messages/${RESOURCE_ID_CANARY}/reactions`,
    payload: { emoji: "🔒" }
  },
  {
    key: "GET /v1/messages/:messageId/reactions",
    method: "GET",
    url: `/v1/messages/${RESOURCE_ID_CANARY}/reactions`
  },
  {
    key: "GET /v1/messages/:messageId/receipts",
    method: "GET",
    url: `/v1/messages/${RESOURCE_ID_CANARY}/receipts`
  },
  { key: "GET /v1/attachments", method: "GET", url: "/v1/attachments" },
  { key: "GET /v1/safety/reports", method: "GET", url: "/v1/safety/reports" },
  { key: "GET /v2/sync/chats", method: "GET", url: "/v2/sync/chats" },
  { key: "GET /v2/sync/blocks", method: "GET", url: "/v2/sync/blocks" },
  { key: "GET /v2/sync/snapshot", method: "GET", url: "/v2/sync/snapshot" },
  { key: "POST /v1/data-exports", method: "POST", url: "/v1/data-exports", payload: {} },
  { key: "GET /v1/data-exports/:id", method: "GET", url: `/v1/data-exports/${RESOURCE_ID_CANARY}` },
  { key: "GET /v1/data-exports/:id/download", method: "GET", url: `/v1/data-exports/${RESOURCE_ID_CANARY}/download` },
  { key: "POST /v1/account/deletion", method: "POST", url: "/v1/account/deletion", payload: {} },
  { key: "GET /v1/account/deletion", method: "GET", url: "/v1/account/deletion" },
  { key: "DELETE /v1/account/deletion", method: "DELETE", url: "/v1/account/deletion" }
];

interface Identity {
  id: string;
  username: string;
  accessToken: string;
  sessionId: string;
}

function auth(identity: Identity): { authorization: string } {
  return { authorization: `Bearer ${identity.accessToken}` };
}

function explicitRouteKeys(source: string): string[] {
  return [...source.matchAll(/\bapp\.(get|post|put|patch|delete)\("([^"]+)"/gu)]
    .map((match) => `${(match[1] as string).toUpperCase()} ${match[2] as string}`);
}

describe("complete HTTP authorization matrix", () => {
  let app: LuxoraApp | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  async function register(username: string, displayName = username): Promise<Identity> {
    const response = await app!.inject({
      method: "POST",
      url: "/v1/auth/register",
      payload: { username, displayName, password: PASSWORD }
    });
    expect(response.statusCode).toBe(201);
    const body = response.json();
    return {
      id: body.user.id as string,
      username,
      accessToken: body.tokens.accessToken as string,
      sessionId: body.tokens.sessionId as string
    };
  }

  async function login(identity: Identity, deviceName: string): Promise<Identity> {
    const response = await app!.inject({
      method: "POST",
      url: "/v1/auth/login",
      payload: { username: identity.username, password: PASSWORD, deviceName }
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    return {
      id: body.user.id as string,
      username: identity.username,
      accessToken: body.tokens.accessToken as string,
      sessionId: body.tokens.sessionId as string
    };
  }

  function createRoleChat(
    kind: Exclude<ChatKind, "direct">,
    title: string,
    members: Array<{ identity: Identity; role: ChatRole }>
  ): string {
    const id = randomUUID();
    const now = new Date().toISOString();
    app!.luxora.store.createChat({
      id,
      kind,
      title,
      directKey: null,
      createdBy: members[0]!.identity.id,
      createdAt: now
    });
    for (const member of members) {
      app!.luxora.store.addChatMember(id, member.identity.id, member.role, now);
    }
    return id;
  }

  async function send(identity: Identity, chatId: string, body: string): Promise<string> {
    const response = await app!.inject({
      method: "POST",
      url: `/v1/chats/${chatId}/messages`,
      headers: auth(identity),
      payload: { body, clientNonce: randomUUID() }
    });
    expect(response.statusCode).toBe(201);
    return response.json().message.id as string;
  }

  async function createUpload(identity: Identity, fileName: string): Promise<string> {
    const response = await app!.inject({
      method: "POST",
      url: "/v1/uploads",
      headers: auth(identity),
      payload: {
        kind: "image",
        fileName,
        mimeType: "image/png",
        sizeBytes: PNG.length,
        sha256: createHash("sha256").update(PNG).digest("hex"),
        idempotencyKey: randomUUID(),
        metadata: {}
      }
    });
    expect(response.statusCode).toBe(201);
    return response.json().upload.id as string;
  }

  async function completeUpload(identity: Identity, uploadId: string): Promise<string> {
    const digest = createHash("sha256").update(PNG).digest("hex");
    const chunk = await app!.inject({
      method: "PUT",
      url: `/v1/uploads/${uploadId}/chunks/0`,
      headers: {
        ...auth(identity),
        "content-type": "application/octet-stream",
        "content-range": `bytes 0-${PNG.length - 1}/${PNG.length}`,
        "content-length": String(PNG.length),
        "x-chunk-sha256": digest
      },
      payload: PNG
    });
    expect(chunk.statusCode).toBe(200);
    const complete = await app!.inject({
      method: "POST",
      url: `/v1/uploads/${uploadId}/complete`,
      headers: auth(identity)
    });
    expect(complete.statusCode).toBe(200);
    return complete.json().upload.attachment.id as string;
  }

  it("keeps the explicit route inventory exhaustive and classifies public policy separately", () => {
    const source = [
      readFileSync(new URL("./http/routes.ts", import.meta.url), "utf8"),
      readFileSync(new URL("./realtime/routes.ts", import.meta.url), "utf8"),
      readFileSync(new URL("./app.ts", import.meta.url), "utf8")
    ].join("\n");
    const actual = explicitRouteKeys(source).sort();
    const expected = [
      ...PUBLIC_HTTP_POLICIES,
      ...PROTECTED_HTTP_MATRIX.map((probe) => probe.key)
    ].sort();

    expect(new Set(expected).size).toBe(expected.length);
    expect(actual).toEqual(expected);
    expect(PROTECTED_HTTP_MATRIX).toHaveLength(111);
  });

  it("rejects an invalid principal on every protected HTTP route without leaks or side effects", async () => {
    app = await buildApp({ config: testConfig(), logger: false });
    const sequenceBefore = app.luxora.store.getLatestSequence();

    for (const probe of PROTECTED_HTTP_MATRIX) {
      const response = await app.inject({
        method: probe.method,
        url: probe.url,
        headers: {
          ...probe.headers,
          authorization: `Bearer ${TOKEN_CANARY}`
        },
        ...(probe.payload === undefined ? {} : { payload: probe.payload })
      });
      expect(response.statusCode, probe.key).toBe(401);
      expect(response.json().error.code, probe.key).toBe("UNAUTHENTICATED");
      expect(response.headers["cache-control"], probe.key).toBe("private, no-store");
      for (const canary of [RESOURCE_ID_CANARY, SECOND_RESOURCE_ID, CONTENT_CANARY, PROFILE_CANARY, TOKEN_CANARY]) {
        expect(response.body, `${probe.key} leaked ${canary}`).not.toContain(canary);
      }
    }

    expect(app.luxora.store.getLatestSequence()).toBe(sequenceBefore);
  });

  it("keeps genuinely public operations public while auth responses remain non-cacheable", async () => {
    const config = testConfig();
    app = await buildApp({ config, logger: false });
    for (const url of ["/health/live", "/health/ready", "/metrics", "/openapi.json"]) {
      const response = await app.inject({ method: "GET", url });
      expect(response.statusCode, url).toBe(200);
      expect(response.headers["cache-control"], url).not.toBe("private, no-store");
    }

    const anonymousCapabilitiesResponse = await app.inject({
      method: "GET",
      url: "/v1/capabilities"
    });
    const invalidBearerCapabilitiesResponse = await app.inject({
      method: "GET",
      url: "/v1/capabilities",
      headers: { authorization: `Bearer ${TOKEN_CANARY}` }
    });
    expect(anonymousCapabilitiesResponse.statusCode).toBe(200);
    expect(invalidBearerCapabilitiesResponse.statusCode).toBe(200);
    expect(invalidBearerCapabilitiesResponse.json()).toEqual(anonymousCapabilitiesResponse.json());
    expect(anonymousCapabilitiesResponse.headers["cache-control"]).toBe("no-store");
    expect(anonymousCapabilitiesResponse.headers.pragma).toBe("no-cache");
    expect(anonymousCapabilitiesResponse.headers["cache-control"]).not.toContain("private");

    const capabilities = CapabilitiesResponseV1Schema.parse(anonymousCapabilitiesResponse.json());
    expect(capabilities.limits).toMatchObject({
      maxAttachmentBytes: config.maxAttachmentBytes,
      userStorageQuotaBytes: config.userStorageQuotaBytes,
      uploadChunkSizeBytes: config.uploadChunkSizeBytes,
      uploadSessionTtlSeconds: config.uploadSessionTtlMinutes * 60
    });
    expect(capabilities.features.serverSearchConfigured).toBe(false);

    const openApi = (await app.inject({ method: "GET", url: "/openapi.json" })).json();
    expect(openApi.paths["/v1/capabilities"].get).toBeDefined();

    const registered = await app.inject({
      method: "POST",
      url: "/v1/auth/register",
      payload: { username: "matrix_public_auth", displayName: "Matrix", password: PASSWORD }
    });
    expect(registered.statusCode).toBe(201);
    expect(registered.headers["cache-control"]).toBe("private, no-store");

    await app.close();
    const configuredSearch = testConfig({
      metricsToken: TOKEN_CANARY,
      dataEncryptionKeys: { matrix: Buffer.alloc(32, 77).toString("base64url") },
      activeDataEncryptionKeyId: "matrix",
      maxAttachmentBytes: 8_388_608,
      userStorageQuotaBytes: 33_554_432,
      uploadChunkSizeBytes: 524_288,
      uploadSessionTtlMinutes: 17
    });
    app = await buildApp({ config: configuredSearch, logger: false });
    const configuredCapabilities = CapabilitiesResponseV1Schema.parse((await app.inject({
      method: "GET",
      url: "/v1/capabilities"
    })).json());
    expect(configuredCapabilities.features.serverSearchConfigured).toBe(true);
    expect(configuredCapabilities.limits).toMatchObject({
      maxAttachmentBytes: configuredSearch.maxAttachmentBytes,
      userStorageQuotaBytes: configuredSearch.userStorageQuotaBytes,
      uploadChunkSizeBytes: configuredSearch.uploadChunkSizeBytes,
      uploadSessionTtlSeconds: configuredSearch.uploadSessionTtlMinutes * 60
    });

    const missingMetricsToken = await app.inject({ method: "GET", url: "/metrics" });
    const invalidMetricsToken = await app.inject({
      method: "GET",
      url: "/metrics",
      headers: { authorization: "Bearer wrong-token" }
    });
    const validMetricsToken = await app.inject({
      method: "GET",
      url: "/metrics",
      headers: { authorization: `Bearer ${TOKEN_CANARY}` }
    });
    expect(missingMetricsToken.statusCode).toBe(401);
    expect(invalidMetricsToken.statusCode).toBe(401);
    expect(invalidMetricsToken.body).not.toContain(TOKEN_CANARY);
    expect(validMetricsToken.statusCode).toBe(200);
  });

  it("keeps account-scoped collections free of an unrelated account's private canaries", async () => {
    const key = Buffer.alloc(32, 111).toString("base64url");
    app = await buildApp({
      config: testConfig({ dataEncryptionKeys: { matrix: key }, activeDataEncryptionKeyId: "matrix" }),
      logger: false
    });
    const owner = await register("matrix_scope_owner", PROFILE_CANARY);
    const subject = await register("matrix_scope_subject");
    const outsider = await register("matrix_scope_outsider");
    const privateChatId = createRoleChat("group", "Private matrix chat", [
      { identity: owner, role: "owner" }
    ]);
    await send(owner, privateChatId, CONTENT_CANARY);
    const uploadId = await createUpload(owner, "matrix-private-file-canary.png");
    await completeUpload(owner, uploadId);

    expect((await app.inject({
      method: "POST",
      url: "/v1/chat-folders",
      headers: auth(owner),
      payload: {
        title: CONTENT_CANARY,
        rules: {
          includeKinds: ["group"],
          unreadOnly: false,
          excludeMuted: false,
          includeArchived: false
        },
        overrides: [],
        clientNonce: randomUUID()
      }
    })).statusCode).toBe(201);

    expect((await app.inject({
      method: "POST",
      url: "/v1/safety/reports",
      headers: auth(owner),
      payload: {
        subjectAccountId: subject.id,
        category: "other",
        evidence: [],
        comment: CONTENT_CANARY,
        clientNonce: randomUUID(),
        alsoBlock: false
      }
    })).statusCode).toBe(201);
    expect((await app.inject({
      method: "POST",
      url: "/v1/message-requests",
      headers: auth(owner),
      payload: { recipientUserId: subject.id, body: CONTENT_CANARY, clientNonce: randomUUID() }
    })).statusCode).toBe(201);

    const sequenceBeforeReads = app.luxora.store.getLatestSequence();
    const probes: Array<{ name: string; url: string }> = [
      { name: "sessions", url: "/v1/auth/sessions" },
      { name: "self", url: "/v1/me" },
      { name: "phone password", url: "/v1/me/phone-password" },
      { name: "privacy", url: "/v1/privacy" },
      { name: "incoming requests", url: "/v1/message-requests?direction=incoming" },
      { name: "outgoing requests", url: "/v1/message-requests?direction=outgoing" },
      { name: "blocks", url: "/v1/blocks" },
      { name: "chat folders", url: "/v1/chat-folders" },
      { name: "chats", url: "/v1/chats" },
      { name: "message search", url: `/v1/search/messages?q=${CONTENT_CANARY}` },
      { name: "file search", url: "/v1/search/files?q=matrix-private-file-canary" },
      { name: "owned attachments", url: "/v1/attachments" },
      { name: "own reports", url: "/v1/safety/reports" },
      { name: "sync chats", url: "/v2/sync/chats" },
      { name: "sync blocks", url: "/v2/sync/blocks" },
      { name: "sync snapshot", url: "/v2/sync/snapshot" }
    ];

    for (const probe of probes) {
      const response = await app.inject({ method: "GET", url: probe.url, headers: auth(outsider) });
      expect(response.statusCode, probe.name).toBe(200);
      expect(response.headers["cache-control"], probe.name).toBe("private, no-store");
      for (const canary of [owner.id, owner.sessionId, owner.accessToken, PROFILE_CANARY, CONTENT_CANARY, "matrix-private-file-canary"]) {
        expect(response.body, `${probe.name} leaked ${canary}`).not.toContain(canary);
      }
    }
    expect(app.luxora.store.getLatestSequence()).toBe(sequenceBeforeReads);
  });

  it("collapses private existing-foreign and random resource IDs to the same public oracle", async () => {
    const key = Buffer.alloc(32, 112).toString("base64url");
    app = await buildApp({
      config: testConfig({ dataEncryptionKeys: { matrix: key }, activeDataEncryptionKeyId: "matrix" }),
      logger: false
    });
    const owner = await register("matrix_oracle_owner", PROFILE_CANARY);
    const recipient = await register("matrix_oracle_recipient");
    const outsider = await register("matrix_oracle_outsider");
    const ownerSecondSession = await login(owner, "Foreign matrix session");
    const privateChatId = createRoleChat("group", "Foreign private chat", [
      { identity: owner, role: "owner" }
    ]);
    const outsiderTargetId = createRoleChat("group", "Outsider target", [
      { identity: outsider, role: "owner" }
    ]);
    const messageId = await send(owner, privateChatId, CONTENT_CANARY);
    const topicResponse = await app.inject({
      method: "POST",
      url: `/v1/chats/${privateChatId}/topics`,
      headers: auth(owner),
      payload: { title: "Private topic" }
    });
    expect(topicResponse.statusCode).toBe(201);
    const topicId = topicResponse.json().topic.id as string;
    const requestResponse = await app.inject({
      method: "POST",
      url: "/v1/message-requests",
      headers: auth(owner),
      payload: { recipientUserId: recipient.id, body: CONTENT_CANARY, clientNonce: randomUUID() }
    });
    expect(requestResponse.statusCode).toBe(201);
    const requestId = requestResponse.json().request.id as string;
    const activeUploadId = await createUpload(owner, "oracle-active.png");
    const completedUploadId = await createUpload(owner, "oracle-complete.png");
    const attachmentId = await completeUpload(owner, completedUploadId);

    interface OraclePair {
      name: string;
      existing: Omit<HttpProbe, "key">;
      absent: Omit<HttpProbe, "key">;
    }
    const randomId = randomUUID();
    const chunkHeaders = {
      "content-type": "application/octet-stream",
      "content-range": `bytes 0-${PNG.length - 1}/${PNG.length}`,
      "content-length": String(PNG.length),
      "x-chunk-sha256": createHash("sha256").update(PNG).digest("hex")
    };
    const pairs: OraclePair[] = [
      {
        name: "foreign session revoke",
        existing: { method: "DELETE", url: `/v1/auth/sessions/${ownerSecondSession.sessionId}` },
        absent: { method: "DELETE", url: `/v1/auth/sessions/${randomId}` }
      },
      {
        name: "foreign message-request accept",
        existing: { method: "POST", url: `/v1/message-requests/${requestId}/accept` },
        absent: { method: "POST", url: `/v1/message-requests/${randomId}/accept` }
      },
      {
        name: "foreign message-request dismiss",
        existing: { method: "DELETE", url: `/v1/message-requests/${requestId}` },
        absent: { method: "DELETE", url: `/v1/message-requests/${randomId}` }
      },
      {
        name: "foreign chat",
        existing: { method: "GET", url: `/v1/chats/${privateChatId}` },
        absent: { method: "GET", url: `/v1/chats/${randomId}` }
      },
      {
        name: "foreign message edit",
        existing: { method: "PATCH", url: `/v1/messages/${messageId}`, payload: { body: "denied edit" } },
        absent: { method: "PATCH", url: `/v1/messages/${randomId}`, payload: { body: "denied edit" } }
      },
      {
        name: "foreign message delete",
        existing: { method: "DELETE", url: `/v1/messages/${messageId}` },
        absent: { method: "DELETE", url: `/v1/messages/${randomId}` }
      },
      {
        name: "foreign message history",
        existing: { method: "GET", url: `/v1/messages/${messageId}/history` },
        absent: { method: "GET", url: `/v1/messages/${randomId}/history` }
      },
      {
        name: "foreign message forward",
        existing: {
          method: "POST",
          url: `/v1/messages/${messageId}/forward`,
          payload: { chatId: outsiderTargetId, clientNonce: randomUUID() }
        },
        absent: {
          method: "POST",
          url: `/v1/messages/${randomId}/forward`,
          payload: { chatId: outsiderTargetId, clientNonce: randomUUID() }
        }
      },
      {
        name: "foreign reaction create",
        existing: { method: "PUT", url: `/v1/messages/${messageId}/reactions`, payload: { emoji: "🔒" } },
        absent: { method: "PUT", url: `/v1/messages/${randomId}/reactions`, payload: { emoji: "🔒" } }
      },
      {
        name: "foreign reaction delete",
        existing: { method: "DELETE", url: `/v1/messages/${messageId}/reactions`, payload: { emoji: "🔒" } },
        absent: { method: "DELETE", url: `/v1/messages/${randomId}/reactions`, payload: { emoji: "🔒" } }
      },
      {
        name: "foreign reaction list",
        existing: { method: "GET", url: `/v1/messages/${messageId}/reactions` },
        absent: { method: "GET", url: `/v1/messages/${randomId}/reactions` }
      },
      {
        name: "foreign receipt list",
        existing: { method: "GET", url: `/v1/messages/${messageId}/receipts` },
        absent: { method: "GET", url: `/v1/messages/${randomId}/receipts` }
      },
      {
        name: "foreign topic update",
        existing: { method: "PATCH", url: `/v1/topics/${topicId}`, payload: { title: "denied topic" } },
        absent: { method: "PATCH", url: `/v1/topics/${randomId}`, payload: { title: "denied topic" } }
      },
      {
        name: "foreign upload read",
        existing: { method: "GET", url: `/v1/uploads/${activeUploadId}` },
        absent: { method: "GET", url: `/v1/uploads/${randomId}` }
      },
      {
        name: "foreign upload chunk",
        existing: {
          method: "PUT",
          url: `/v1/uploads/${activeUploadId}/chunks/0`,
          headers: chunkHeaders,
          payload: PNG
        },
        absent: {
          method: "PUT",
          url: `/v1/uploads/${randomId}/chunks/0`,
          headers: chunkHeaders,
          payload: PNG
        }
      },
      {
        name: "foreign upload complete",
        existing: { method: "POST", url: `/v1/uploads/${activeUploadId}/complete` },
        absent: { method: "POST", url: `/v1/uploads/${randomId}/complete` }
      },
      {
        name: "foreign attachment download",
        existing: { method: "GET", url: `/v1/attachments/${attachmentId}/content` },
        absent: { method: "GET", url: `/v1/attachments/${randomId}/content` }
      }
    ];

    for (const pair of pairs) {
      const sequenceBefore = app.luxora.store.getLatestSequence();
      const request = async (probe: Omit<HttpProbe, "key">) => app!.inject({
        method: probe.method,
        url: probe.url,
        headers: { ...probe.headers, ...auth(outsider) },
        ...(probe.payload === undefined ? {} : { payload: probe.payload })
      });
      const existing = await request(pair.existing);
      const absent = await request(pair.absent);
      expect(existing.statusCode, pair.name).toBe(404);
      expect(absent.statusCode, pair.name).toBe(404);
      expect(existing.json().error.code, pair.name).toBe(absent.json().error.code);
      expect(existing.json().error.message, pair.name).toBe(absent.json().error.message);
      for (const response of [existing, absent]) {
        expect(response.headers["cache-control"], pair.name).toBe("private, no-store");
        for (const canary of [
          owner.id,
          owner.sessionId,
          owner.accessToken,
          PROFILE_CANARY,
          CONTENT_CANARY,
          privateChatId,
          messageId,
          topicId,
          requestId,
          activeUploadId,
          attachmentId
        ]) {
          expect(response.body, `${pair.name} leaked ${canary}`).not.toContain(canary);
        }
      }
      expect(app.luxora.store.getLatestSequence(), pair.name).toBe(sequenceBefore);
    }

    expect(app.luxora.store.isSessionActive(
      ownerSecondSession.sessionId,
      owner.id,
      new Date().toISOString()
    )).toBe(true);
    expect(app.luxora.store.findMessageRecord(messageId)?.body).toBe(CONTENT_CANARY);
    expect(app.luxora.store.findTopicRecord(topicId)?.title).toBe("Private topic");
  });

  it("rejects cross-chat nested IDs before mutation or durable-event creation", async () => {
    app = await buildApp({ config: testConfig(), logger: false });
    const owner = await register("matrix_nested_owner");
    const member = await register("matrix_nested_member");
    const groupId = createRoleChat("group", "Nested group", [
      { identity: owner, role: "owner" },
      { identity: member, role: "member" }
    ]);
    const channelId = createRoleChat("channel", "Nested channel", [
      { identity: owner, role: "owner" },
      { identity: member, role: "member" }
    ]);
    const groupMessageId = await send(owner, groupId, "group baseline");
    const channelMessageId = await send(owner, channelId, CONTENT_CANARY);
    const topic = await app.inject({
      method: "POST",
      url: `/v1/chats/${channelId}/topics`,
      headers: auth(owner),
      payload: { title: "Channel-private topic" }
    });
    expect(topic.statusCode).toBe(201);
    const channelTopicId = topic.json().topic.id as string;

    const probes: Array<{ name: string; method: HttpMethod; url: string; payload?: HttpProbe["payload"] }> = [
      {
        name: "topic-filter confusion",
        method: "GET",
        url: `/v1/chats/${groupId}/messages?topicId=${channelTopicId}`
      },
      {
        name: "reply confusion",
        method: "POST",
        url: `/v1/chats/${groupId}/messages`,
        payload: { body: "denied reply", replyToMessageId: channelMessageId, clientNonce: randomUUID() }
      },
      {
        name: "topic-send confusion",
        method: "POST",
        url: `/v1/chats/${groupId}/messages`,
        payload: { body: "denied topic", topicId: channelTopicId, clientNonce: randomUUID() }
      },
      {
        name: "pin confusion",
        method: "PUT",
        url: `/v1/chats/${groupId}/pins/${channelMessageId}`
      },
      {
        name: "unpin confusion",
        method: "DELETE",
        url: `/v1/chats/${groupId}/pins/${channelMessageId}`
      },
      {
        name: "read confusion",
        method: "POST",
        url: `/v1/chats/${groupId}/read`,
        payload: { messageId: channelMessageId }
      },
      {
        name: "delivered confusion",
        method: "POST",
        url: `/v1/chats/${groupId}/delivered`,
        payload: { messageId: channelMessageId }
      }
    ];

    for (const probe of probes) {
      const sequenceBefore = app.luxora.store.getLatestSequence();
      const response = await app.inject({
        method: probe.method,
        url: probe.url,
        headers: auth(owner),
        ...(probe.payload === undefined ? {} : { payload: probe.payload })
      });
      expect(response.statusCode, probe.name).toBe(404);
      expect(response.json().error.code, probe.name).toBe("NOT_FOUND");
      expect(response.body, probe.name).not.toContain(CONTENT_CANARY);
      expect(response.body, probe.name).not.toContain(channelId);
      expect(response.body, probe.name).not.toContain(channelMessageId);
      expect(response.body, probe.name).not.toContain(channelTopicId);
      expect(app.luxora.store.getLatestSequence(), probe.name).toBe(sequenceBefore);
      expect(app.luxora.store.findMessageRecord(groupMessageId)).not.toBeNull();
    }
  });

  it("enforces group/channel roles and author-vs-nonauthor rules at the HTTP boundary", async () => {
    app = await buildApp({ config: testConfig(), logger: false });
    const owner = await register("matrix_roles_owner");
    const admin = await register("matrix_roles_admin");
    const member = await register("matrix_roles_member");
    const outsider = await register("matrix_roles_outsider", PROFILE_CANARY);
    const roleMembers: Array<{ identity: Identity; role: ChatRole }> = [
      { identity: owner, role: "owner" },
      { identity: admin, role: "admin" },
      { identity: member, role: "member" }
    ];
    const groupId = createRoleChat("group", "Role group", roleMembers);
    const channelId = createRoleChat("channel", "Role channel", roleMembers);

    for (const actor of [owner, admin, member]) {
      const response = await app.inject({
        method: "POST",
        url: `/v1/chats/${groupId}/messages`,
        headers: auth(actor),
        payload: { body: `group allowed ${actor.username}`, clientNonce: randomUUID() }
      });
      expect(response.statusCode, actor.username).toBe(201);
    }
    for (const actor of [owner, admin]) {
      const response = await app.inject({
        method: "POST",
        url: `/v1/chats/${channelId}/messages`,
        headers: auth(actor),
        payload: { body: `channel allowed ${actor.username}`, clientNonce: randomUUID() }
      });
      expect(response.statusCode, actor.username).toBe(201);
    }

    const deniedPosts = [
      { name: "channel member publish", actor: member, chatId: channelId },
      { name: "group outsider publish", actor: outsider, chatId: groupId },
      { name: "channel outsider publish", actor: outsider, chatId: channelId }
    ];
    for (const denied of deniedPosts) {
      const sequenceBefore = app.luxora.store.getLatestSequence();
      const response = await app.inject({
        method: "POST",
        url: `/v1/chats/${denied.chatId}/messages`,
        headers: auth(denied.actor),
        payload: { body: CONTENT_CANARY, clientNonce: randomUUID() }
      });
      expect(response.statusCode, denied.name).toBe(403);
      expect(response.body, denied.name).not.toContain(CONTENT_CANARY);
      expect(app.luxora.store.getLatestSequence(), denied.name).toBe(sequenceBefore);
    }

    const groupOwnerMessage = await send(owner, groupId, "group owner authority");
    const groupMemberMessage = await send(member, groupId, "group member authority");
    const channelOwnerMessage = await send(owner, channelId, "channel owner authority");

    const memberPinDeniedSequence = app.luxora.store.getLatestSequence();
    const memberPinDenied = await app.inject({
      method: "PUT",
      url: `/v1/chats/${groupId}/pins/${groupOwnerMessage}`,
      headers: auth(member)
    });
    expect(memberPinDenied.statusCode).toBe(403);
    expect(app.luxora.store.getLatestSequence()).toBe(memberPinDeniedSequence);

    expect((await app.inject({
      method: "PUT",
      url: `/v1/chats/${groupId}/pins/${groupOwnerMessage}`,
      headers: auth(admin)
    })).statusCode).toBe(200);
    expect((await app.inject({
      method: "DELETE",
      url: `/v1/chats/${groupId}/pins/${groupOwnerMessage}`,
      headers: auth(owner)
    })).statusCode).toBe(204);
    expect((await app.inject({
      method: "PUT",
      url: `/v1/chats/${channelId}/pins/${channelOwnerMessage}`,
      headers: auth(admin)
    })).statusCode).toBe(200);

    const groupTopic = await app.inject({
      method: "POST",
      url: `/v1/chats/${groupId}/topics`,
      headers: auth(member),
      payload: { title: "Member may create a group topic" }
    });
    expect(groupTopic.statusCode).toBe(201);
    const groupTopicId = groupTopic.json().topic.id as string;
    const channelTopic = await app.inject({
      method: "POST",
      url: `/v1/chats/${channelId}/topics`,
      headers: auth(admin),
      payload: { title: "Admin channel topic" }
    });
    expect(channelTopic.statusCode).toBe(201);

    for (const denied of [
      {
        name: "channel member topic create",
        method: "POST" as const,
        url: `/v1/chats/${channelId}/topics`,
        payload: { title: CONTENT_CANARY }
      },
      {
        name: "group member topic update",
        method: "PATCH" as const,
        url: `/v1/topics/${groupTopicId}`,
        payload: { title: CONTENT_CANARY }
      }
    ]) {
      const sequenceBefore = app.luxora.store.getLatestSequence();
      const response = await app.inject({
        method: denied.method,
        url: denied.url,
        headers: auth(member),
        payload: denied.payload
      });
      expect(response.statusCode, denied.name).toBe(403);
      expect(response.body, denied.name).not.toContain(CONTENT_CANARY);
      expect(app.luxora.store.getLatestSequence(), denied.name).toBe(sequenceBefore);
    }
    expect((await app.inject({
      method: "PATCH",
      url: `/v1/topics/${groupTopicId}`,
      headers: auth(owner),
      payload: { title: "Owner update" }
    })).statusCode).toBe(200);

    const nonAuthorEditSequence = app.luxora.store.getLatestSequence();
    const nonAuthorEdit = await app.inject({
      method: "PATCH",
      url: `/v1/messages/${groupMemberMessage}`,
      headers: auth(admin),
      payload: { body: CONTENT_CANARY }
    });
    expect(nonAuthorEdit.statusCode).toBe(403);
    expect(app.luxora.store.getLatestSequence()).toBe(nonAuthorEditSequence);
    expect(app.luxora.store.findMessageRecord(groupMemberMessage)?.body).toBe("group member authority");

    const memberDeleteSequence = app.luxora.store.getLatestSequence();
    const memberDelete = await app.inject({
      method: "DELETE",
      url: `/v1/messages/${groupOwnerMessage}`,
      headers: auth(member)
    });
    expect(memberDelete.statusCode).toBe(403);
    expect(app.luxora.store.getLatestSequence()).toBe(memberDeleteSequence);
    expect((await app.inject({
      method: "DELETE",
      url: `/v1/messages/${groupMemberMessage}`,
      headers: auth(admin)
    })).statusCode).toBe(200);

    const authorMessage = await send(member, groupId, "author-owned mutation");
    expect((await app.inject({
      method: "PATCH",
      url: `/v1/messages/${authorMessage}`,
      headers: auth(member),
      payload: { body: "author edit allowed" }
    })).statusCode).toBe(200);
    expect((await app.inject({
      method: "DELETE",
      url: `/v1/messages/${authorMessage}`,
      headers: auth(member)
    })).statusCode).toBe(200);
  });

  it("cuts off active Direct mutations after a block while preserving explicit history and own-delete policy", async () => {
    app = await buildApp({ config: testConfig(), logger: false });
    const alice = await register("matrix_direct_alice");
    const bob = await register("matrix_direct_bob", PROFILE_CANARY);
    const directId = await establishAcceptedRelationship(app, alice, bob);
    const messageId = await send(alice, directId, CONTENT_CANARY);
    const sourceGroupId = createRoleChat("group", "Forward source", [
      { identity: alice, role: "owner" }
    ]);
    const sourceMessageId = await send(alice, sourceGroupId, "forward source");
    expect((await app.inject({
      method: "PUT",
      url: `/v1/chats/${directId}/pins/${messageId}`,
      headers: auth(alice)
    })).statusCode).toBe(200);
    expect((await app.inject({
      method: "PUT",
      url: `/v1/blocks/${bob.id}`,
      headers: auth(alice)
    })).statusCode).toBe(200);

    const deniedMutations: Array<{ name: string; method: HttpMethod; url: string; payload?: HttpProbe["payload"] }> = [
      {
        name: "recreate blocked Direct",
        method: "POST",
        url: "/v1/chats",
        payload: { kind: "direct", userId: bob.id }
      },
      {
        name: "send after block",
        method: "POST",
        url: `/v1/chats/${directId}/messages`,
        payload: { body: "denied", clientNonce: randomUUID() }
      },
      {
        name: "edit after block",
        method: "PATCH",
        url: `/v1/messages/${messageId}`,
        payload: { body: "denied" }
      },
      {
        name: "forward into blocked Direct",
        method: "POST",
        url: `/v1/messages/${sourceMessageId}/forward`,
        payload: { chatId: directId, clientNonce: randomUUID() }
      },
      { name: "pin after block", method: "PUT", url: `/v1/chats/${directId}/pins/${messageId}` },
      { name: "unpin after block", method: "DELETE", url: `/v1/chats/${directId}/pins/${messageId}` },
      {
        name: "read after block",
        method: "POST",
        url: `/v1/chats/${directId}/read`,
        payload: { messageId }
      },
      {
        name: "delivered after block",
        method: "POST",
        url: `/v1/chats/${directId}/delivered`,
        payload: { messageId }
      },
      {
        name: "react after block",
        method: "PUT",
        url: `/v1/messages/${messageId}/reactions`,
        payload: { emoji: "🔒" }
      },
      {
        name: "remove reaction after block",
        method: "DELETE",
        url: `/v1/messages/${messageId}/reactions`,
        payload: { emoji: "🔒" }
      }
    ];

    for (const probe of deniedMutations) {
      const sequenceBefore = app.luxora.store.getLatestSequence();
      const response = await app.inject({
        method: probe.method,
        url: probe.url,
        headers: auth(alice),
        ...(probe.payload === undefined ? {} : { payload: probe.payload })
      });
      expect(response.statusCode, probe.name).toBe(403);
      expect(response.json().error.code, probe.name).toBe("FORBIDDEN");
      expect(response.body, probe.name).not.toContain(PROFILE_CANARY);
      expect(app.luxora.store.getLatestSequence(), probe.name).toBe(sequenceBefore);
    }

    for (const read of [
      `/v1/chats/${directId}`,
      `/v1/chats/${directId}/messages`,
      `/v1/messages/${messageId}/history`,
      `/v1/chats/${directId}/pins`
    ]) {
      const response = await app.inject({ method: "GET", url: read, headers: auth(alice) });
      expect(response.statusCode, read).toBe(200);
    }
    expect((await app.inject({
      method: "DELETE",
      url: `/v1/messages/${messageId}`,
      headers: auth(alice)
    })).statusCode).toBe(200);
  });
});
