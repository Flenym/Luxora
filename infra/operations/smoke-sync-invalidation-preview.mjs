#!/usr/bin/env node

import { randomBytes, randomInt, randomUUID } from "node:crypto";
import WebSocket from "ws";

const baseUrl = process.env.LUXORA_SMOKE_BASE_URL ?? "http://127.0.0.1:8080";
const verificationCode = process.env.PHONE_AUTH_DEVELOPMENT_CODE;
let stage = "configuration";
const sockets = [];

function assert(condition) {
  if (!condition) throw new Error("assertion failed");
}

async function request(path, { method = "GET", token, body, status = 200 } = {}) {
  const headers = { accept: "application/json" };
  if (body !== undefined) headers["content-type"] = "application/json";
  if (token !== undefined) headers.authorization = `Bearer ${token}`;
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
  assert(response.status === status);
  return {
    headers: response.headers,
    text: await response.text()
  };
}

function parseJson(response) {
  return JSON.parse(response.text);
}

function websocketUrl(path) {
  return `${baseUrl.replace(/^http/u, "ws")}${path}`;
}

async function openRealtime(path, accessToken, resumeCursor) {
  const socket = new WebSocket(websocketUrl(path));
  sockets.push(socket);
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
  assert(hello.protocolVersion === (path === "/v2/realtime" ? 2 : 1));
  socket.send(JSON.stringify({
    type: "authenticate",
    accessToken,
    ...(resumeCursor === undefined ? {} : { resumeCursor })
  }));
  const ready = await waitFor((message) => message.type === "ready");
  return { socket, messages, waitFor, ready };
}

async function main() {
  assert(typeof verificationCode === "string" && /^[0-9]{6}$/u.test(verificationCode));

  stage = "capabilities";
  const capabilities = parseJson(await request("/v1/capabilities"));
  assert(capabilities.features?.phoneAuthentication === true);
  assert(capabilities.features?.chatFolders === true);
  assert(capabilities.features?.reconciliation === true);
  assert(capabilities.features?.realtime === true);
  assert(capabilities.features?.syncInvalidation === true);
  assert(capabilities.versions?.realtime?.preferred === 2);
  assert(capabilities.limits?.maxChatFolders === 10);
  assert(capabilities.limits?.chatFolderIdempotencyTtlSeconds === 86_400);
  assert(capabilities.limits?.maxChatFolderActiveCommandReceipts === 64);

  const nationalNumber = `999${String(randomInt(0, 10_000_000)).padStart(7, "0")}`;
  const username = `rehearsal_${randomBytes(5).toString("hex")}`;
  const deviceName = "Luxora isolated restore rehearsal";

  stage = "phone challenge";
  const challengeRequest = {
    countryCode: "7",
    nationalNumber,
    deviceName,
    clientNonce: randomUUID()
  };
  const challengeResponse = await request("/v1/auth/phone/challenges", {
    method: "POST",
    body: challengeRequest,
    status: 201
  });
  assert(!challengeResponse.text.includes(nationalNumber));
  assert(!challengeResponse.text.includes(verificationCode));
  const challenge = parseJson(challengeResponse);
  assert(typeof challenge.challengeId === "string");

  stage = "phone verification";
  const verified = parseJson(await request(
    `/v1/auth/phone/challenges/${encodeURIComponent(challenge.challengeId)}/verify`,
    {
      method: "POST",
      body: {
        code: verificationCode,
        deviceName,
        clientNonce: randomUUID()
      }
    }
  ));
  assert(verified.status === "profile_required");
  assert(typeof verified.registrationToken === "string");

  stage = "phone registration";
  const registered = parseJson(await request("/v1/auth/phone/registrations", {
    method: "POST",
    body: {
      registrationToken: verified.registrationToken,
      displayName: "Restore Rehearsal",
      username,
      bio: "Isolated candidate verification",
      deviceName,
      clientNonce: randomUUID()
    },
    status: 201
  }));
  const accessToken = registered.tokens?.accessToken;
  const accountId = registered.user?.id;
  assert(typeof accessToken === "string" && typeof accountId === "string");

  stage = "authenticated identity";
  const me = parseJson(await request("/v1/me", { token: accessToken }));
  assert(me.user?.id === accountId);

  stage = "chat folder create";
  const initialFolders = parseJson(await request("/v1/chat-folders", { token: accessToken }));
  assert(initialFolders.stateRevision === 0 && initialFolders.items?.length === 0);
  const folderNonce = randomUUID();
  const folderRequest = {
    title: "Проверка",
    rules: {
      includeKinds: ["direct", "group", "channel"],
      unreadOnly: false,
      excludeMuted: true,
      includeArchived: false
    },
    overrides: [],
    clientNonce: folderNonce
  };
  const createdFolder = parseJson(await request("/v1/chat-folders", {
    method: "POST",
    token: accessToken,
    body: folderRequest,
    status: 201
  }));
  assert(createdFolder.stateRevision === 1);
  assert(createdFolder.folder?.revision === 1);
  assert(createdFolder.replayed === false);

  stage = "chat folder exact replay";
  const replayedFolder = parseJson(await request("/v1/chat-folders", {
    method: "POST",
    token: accessToken,
    body: {
      ...folderRequest,
      rules: { ...folderRequest.rules, includeKinds: ["channel", "direct", "group"] }
    },
    status: 201
  }));
  assert(replayedFolder.replayed === true);
  assert(replayedFolder.stateRevision === createdFolder.stateRevision);
  assert(replayedFolder.folder?.id === createdFolder.folder?.id);

  stage = "snapshot boundary";
  const snapshot = parseJson(await request("/v2/sync/snapshot", { token: accessToken }));
  assert(snapshot.reset?.collections?.length === 12);
  assert(new Set(snapshot.reset.collections).size === 12);
  assert(snapshot.reset.collections.includes("chat_folders"));
  assert(snapshot.resources?.chatFolders === "/v1/chat-folders");
  assert(typeof snapshot.boundary?.cursor === "string");

  stage = "realtime connect";
  const currentV2 = await openRealtime("/v2/realtime", accessToken);
  const currentV1 = await openRealtime("/v1/realtime", accessToken);

  stage = "profile invalidation";
  await request("/v1/me", {
    method: "PATCH",
    token: accessToken,
    body: { displayName: "Restore Rehearsal Updated" }
  });
  const invalidation = await currentV2.waitFor((message) =>
    message.type === "dispatch" && message.event?.type === "sync.invalidated"
  );
  assert(invalidation.event.audience === "account_projection");
  assert(invalidation.event.accountId === accountId);
  assert(invalidation.event.reason === "profile_updated");
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert(!currentV1.messages.some((message) =>
    message.type === "dispatch" && message.event?.type === "sync.invalidated"
  ));

  stage = "realtime scoped replay";
  const replayV2 = await openRealtime("/v2/realtime", accessToken, snapshot.boundary.cursor);
  assert(replayV2.ready.resumed === true);
  const replayedInvalidation = await replayV2.waitFor((message) =>
    message.type === "dispatch" && message.event?.type === "sync.invalidated"
  );
  assert(replayedInvalidation.event.accountId === accountId);
  assert(replayedInvalidation.event.reason === "profile_updated");
  const checkpoint = await replayV2.waitFor((message) => message.type === "sync.checkpoint");
  assert(checkpoint.sequence >= invalidation.sequence);

  stage = "snapshot advance";
  const advanced = parseJson(await request("/v2/sync/snapshot", { token: accessToken }));
  assert(advanced.boundary.sequence > snapshot.boundary.sequence);

  process.stdout.write(JSON.stringify({
    status: "PASS",
    phoneAuthentication: true,
    chatFolderExactReplay: true,
    snapshotCollections: 12,
    invalidation: "v2_live_and_replay_v1_absent"
  }) + "\n");
}

try {
  await main();
} catch {
  process.stderr.write(`Luxora isolated smoke failed at stage: ${stage}\n`);
  process.exitCode = 1;
} finally {
  for (const socket of sockets) socket.terminate();
}
