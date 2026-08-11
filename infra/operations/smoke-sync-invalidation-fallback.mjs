#!/usr/bin/env node

import { randomBytes, randomUUID } from "node:crypto";
import WebSocket from "ws";

const baseUrl = process.env.LUXORA_SMOKE_BASE_URL ?? "http://127.0.0.1:8080";
let stage = "configuration";
let socket;

function assert(condition) {
  if (!condition) throw new Error("assertion failed");
}

async function request(path, { method = "GET", token, body, status = 200 } = {}) {
  const headers = { accept: "application/json" };
  if (token !== undefined) headers.authorization = `Bearer ${token}`;
  if (body !== undefined) headers["content-type"] = "application/json";
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
  assert(response.status === status);
  return response.status === 204 ? undefined : JSON.parse(await response.text());
}

async function openRealtime(accessToken) {
  socket = new WebSocket(`${baseUrl.replace(/^http/u, "ws")}/v2/realtime`);
  const messages = [];
  socket.on("message", (raw) => messages.push(JSON.parse(raw.toString())));
  await new Promise((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  const waitFor = async (predicate, timeoutMs = 5_000) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const index = messages.findIndex(predicate);
      if (index >= 0) return messages.splice(index, 1)[0];
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error("realtime timeout");
  };
  const hello = await waitFor((message) => message.type === "hello");
  assert(hello.protocolVersion === 2);
  socket.send(JSON.stringify({ type: "authenticate", accessToken }));
  await waitFor((message) => message.type === "ready");
  return { messages, waitFor };
}

async function register(suffix) {
  const username = `fallback_${suffix}_${randomBytes(5).toString("hex")}`;
  const response = await request("/v1/auth/register", {
    method: "POST",
    status: 201,
    body: {
      username,
      displayName: `Fallback ${suffix}`,
      password: "correct horse battery staple",
      deviceName: "Luxora fallback rehearsal"
    }
  });
  assert(typeof response.user?.id === "string");
  assert(typeof response.tokens?.accessToken === "string");
  return { id: response.user.id, accessToken: response.tokens.accessToken };
}

async function main() {
  stage = "capabilities";
  const capabilities = await request("/v1/capabilities");
  assert(capabilities.features?.syncInvalidation === false);
  assert(capabilities.features?.realtime === true);
  assert(capabilities.features?.chatFolders === true);

  stage = "authentication";
  const owner = await register("owner");
  const member = await register("member");
  const ownerProfile = await request("/v1/me", { token: owner.accessToken });
  const memberProfile = await request("/v1/me", { token: member.accessToken });
  assert(ownerProfile.user?.id === owner.id);
  assert(memberProfile.user?.id === member.id);

  stage = "fallback realtime";
  const realtime = await openRealtime(owner.accessToken);
  const beforeProfile = await request("/v2/sync/snapshot", { token: owner.accessToken });

  stage = "profile suppression";
  const updatedProfile = await request("/v1/me", {
    method: "PATCH",
    token: owner.accessToken,
    body: { displayName: "Fallback Owner Updated" }
  });
  assert(updatedProfile.user?.displayName === "Fallback Owner Updated");
  const afterProfile = await request("/v2/sync/snapshot", { token: owner.accessToken });
  assert(afterProfile.boundary?.sequence === beforeProfile.boundary?.sequence);
  await new Promise((resolve) => setTimeout(resolve, 350));
  assert(!realtime.messages.some((message) =>
    message.type === "dispatch" && message.event?.type === "sync.invalidated"
  ));

  stage = "ordinary folder event";
  const folder = await request("/v1/chat-folders", {
    method: "POST",
    token: owner.accessToken,
    status: 201,
    body: {
      title: "Аварийный режим",
      rules: {
        includeKinds: ["direct", "group", "channel"],
        unreadOnly: false,
        excludeMuted: true,
        includeArchived: false
      },
      overrides: [],
      clientNonce: randomUUID()
    }
  });
  const folderEvent = await realtime.waitFor((message) =>
    message.type === "dispatch" && message.event?.type === "chat.folders.updated"
  );
  assert(folderEvent.event?.accountId === owner.id);
  const folders = await request("/v1/chat-folders", { token: owner.accessToken });
  assert(folders.items?.some((item) => item.id === folder.folder?.id));
  const afterFolder = await request("/v2/sync/snapshot", { token: owner.accessToken });
  assert(afterFolder.boundary?.sequence > afterProfile.boundary?.sequence);

  stage = "accepted relationship";
  const relationshipRequest = await request("/v1/message-requests", {
    method: "POST",
    token: owner.accessToken,
    status: 201,
    body: {
      recipientUserId: member.id,
      body: "Fallback rehearsal",
      clientNonce: randomUUID()
    }
  });
  await request(`/v1/message-requests/${encodeURIComponent(relationshipRequest.request.id)}/accept`, {
    method: "POST",
    token: member.accessToken
  });

  stage = "membership revision ledger";
  const group = await request("/v1/chats", {
    method: "POST",
    token: owner.accessToken,
    status: 201,
    body: { kind: "group", title: "Fallback membership", memberIds: [] }
  });
  const chatId = group.chat?.id;
  assert(typeof chatId === "string");
  const added = await request(`/v1/chats/${encodeURIComponent(chatId)}/members`, {
    method: "POST",
    token: owner.accessToken,
    status: 201,
    body: { userId: member.id, role: "member", clientNonce: randomUUID() }
  });
  const removed = await request(
    `/v1/chats/${encodeURIComponent(chatId)}/members/${encodeURIComponent(member.id)}`,
    {
      method: "DELETE",
      token: owner.accessToken,
      body: {
        expectedRevision: added.membership?.revision,
        clientNonce: randomUUID()
      }
    }
  );
  const readded = await request(`/v1/chats/${encodeURIComponent(chatId)}/members`, {
    method: "POST",
    token: owner.accessToken,
    status: 201,
    body: { userId: member.id, role: "member", clientNonce: randomUUID() }
  });
  const revisions = [
    added.membership?.revision,
    removed.membership?.revision,
    readded.membership?.revision
  ];
  assert(revisions[0] >= 1);
  assert(revisions[1] === revisions[0] + 1);
  assert(revisions[2] === revisions[1] + 1);
  const members = await request(`/v1/chats/${encodeURIComponent(chatId)}/members`, {
    token: member.accessToken
  });
  assert(members.items?.some((item) => item.membership?.userId === member.id
    && item.membership?.revision === revisions[2]));

  stage = "final suppression check";
  await new Promise((resolve) => setTimeout(resolve, 350));
  assert(!realtime.messages.some((message) =>
    message.type === "dispatch" && message.event?.type === "sync.invalidated"
  ));
  const finalCapabilities = await request("/v1/capabilities");
  assert(finalCapabilities.features?.syncInvalidation === false);

  process.stdout.write(JSON.stringify({
    status: "PASS",
    capabilitySyncInvalidation: false,
    authentication: true,
    folderDomainEvent: true,
    profileHeadStable: true,
    membershipRevisions: revisions,
    invalidationDelivered: false
  }) + "\n");
}

try {
  await main();
} catch {
  process.stderr.write(`Luxora fallback rehearsal failed at stage: ${stage}\n`);
  process.exitCode = 1;
} finally {
  socket?.terminate();
}
