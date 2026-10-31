#!/usr/bin/env node
/**
 * Luxora API live smoke harness (zero dependencies).
 *
 * Runs an end-to-end PASS/FAIL matrix against a *running* Luxora API instance
 * using only Node 22+ built-ins: global fetch, global WebSocket, node:crypto,
 * node:zlib.
 *
 * What it proves (one PASS/FAIL line per step):
 *   ops        health live/ready + canonical capabilities contract + cache policy
 *   auth       register/login/refresh rotation + refresh reuse revocation + sessions
 *   discovery  exact lookup, both privacy directions, message-request bootstrap
 *   chats      direct chat via accepted message request
 *   messages   send, nonce idempotency, nonce conflict, list paging, reply, edit
 *              CAS, reactions, pins, read/delivered receipts, delete tombstone
 *   realtime   /v2/realtime hello -> authenticate -> ready -> sync.checkpoint,
 *              durable message.created/receipt/reaction delivery to both users,
 *              typing + heartbeat ephemeral frames, cursor reconnect replay with
 *              loss/duplication checks, deterministic sync.required recovery
 *   sync       /v2/sync/snapshot boundary + reconciliation resources
 *   search     users (relationship scoped), chats (title substring), messages
 *   uploads    image create -> chunk(s) -> complete -> content/range/thumbnail
 *   media      media message delivery + attachment authorization
 *   calls      create/ring/accept/join-grant(503)/decline/hangup/list
 *   folders    create/list/patch/reorder/delete + stateRevision + nonce replay
 *   prefs      archive/mute partial updates
 *   exports    request -> poll -> download headers/hash/byte-range
 *   deletion   schedule -> idempotent re-schedule -> cancel (never executes)
 *   authz      anonymous 401, stranger 404/FORBIDDEN consistency, admin truth
 *   links      public device-link challenge lifecycle (linkSecret canary)
 *   secrets    optional server-log scan for JWT secret / admin token / OTP /
 *              refresh tokens / device-link linkSecret (values never printed)
 *
 * Usage (from the repository root on Windows PowerShell):
 *   node scripts/qa-api-smoke.mjs
 *   node scripts/qa-api-smoke.mjs --base-url http://127.0.0.1:2223 `
 *     --admin-token-file data/qa-backend/admin-token.txt `
 *     --server-log data/qa-backend/server.log `
 *     --server-env data/qa-backend/server.env
 *
 * Options:
 *   --base-url <url>            default http://127.0.0.1:2222 (env LUXORA_QA_BASE_URL)
 *   --admin-token-file <path>   default data/qa-web/admin-token.txt when present
 *   --expect-admin <mode>       auto | configured | unconfigured (default auto)
 *   --cors-origin <origin>      browser origin the target is expected to allow;
 *                               enables the CORS preflight step (env LUXORA_QA_CORS_ORIGIN)
 *   --server-log <path>         server stdout capture to scan for secret leaks
 *   --server-env <path>         KEY=VALUE secret file used by that server
 *   --timeout-ms <n>            per request/socket timeout (default 15000)
 *   --verbose                   print stack traces for failures
 *
 * Exit codes: 0 = every step passed (skips allowed only for optional steps),
 *             1 = at least one step failed, 2 = usage/setup failure.
 *
 * The harness never stops the target server, never deletes other accounts'
 * data and never lets a scheduled account deletion execute (it cancels inside
 * the seven-day grace window). All created data is randomized per run.
 */

import { createHash, randomBytes, randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { deflateSync } from "node:zlib";

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const argv = process.argv.slice(2);

function readFlag(name, envName, fallback) {
  const eq = argv.find((value) => value.startsWith(`--${name}=`));
  if (eq !== undefined) return eq.slice(name.length + 3);
  const index = argv.indexOf(`--${name}`);
  if (index >= 0) {
    const next = argv[index + 1];
    if (next === undefined || next.startsWith("--")) return "true";
    return next;
  }
  const fromEnv = process.env[envName];
  return fromEnv === undefined || fromEnv === "" ? fallback : fromEnv;
}

const options = {
  baseUrl: String(readFlag("base-url", "LUXORA_QA_BASE_URL", "http://127.0.0.1:2222")).replace(/\/+$/u, ""),
  adminTokenFile: readFlag("admin-token-file", "LUXORA_QA_ADMIN_TOKEN_FILE", null),
  expectAdmin: String(readFlag("expect-admin", "LUXORA_QA_EXPECT_ADMIN", "auto")),
  corsOrigin: readFlag("cors-origin", "LUXORA_QA_CORS_ORIGIN", null),
  serverLog: readFlag("server-log", "LUXORA_QA_SERVER_LOG", null),
  serverEnv: readFlag("server-env", "LUXORA_QA_SERVER_ENV", null),
  timeoutMs: Number(readFlag("timeout-ms", "LUXORA_QA_TIMEOUT_MS", "15000")),
  verbose: argv.includes("--verbose") || process.env.LUXORA_QA_VERBOSE === "1"
};

if (!["auto", "configured", "unconfigured"].includes(options.expectAdmin)) {
  console.error(`Invalid --expect-admin value '${options.expectAdmin}' (auto|configured|unconfigured)`);
  process.exit(2);
}
if (!Number.isFinite(options.timeoutMs) || options.timeoutMs < 1000) {
  console.error("Invalid --timeout-ms value (must be >= 1000)");
  process.exit(2);
}
if (typeof WebSocket !== "function") {
  console.error("This harness requires Node 22+ with the global WebSocket implementation.");
  process.exit(2);
}

const WS_URL = new URL(options.baseUrl);
WS_URL.protocol = WS_URL.protocol === "https:" ? "wss:" : "ws:";
WS_URL.pathname = "/v2/realtime";
WS_URL.search = "";

// Resolve optional local files. The default admin token path matches the
// Lead-owned qa-web instance; callers pass an explicit path for other targets.
if (options.adminTokenFile === null && existsSync(resolve("data/qa-web/admin-token.txt"))) {
  options.adminTokenFile = "data/qa-web/admin-token.txt";
}
const adminTokenFile = options.adminTokenFile === null ? null : resolve(options.adminTokenFile);
const serverLogPath = options.serverLog === null ? null : resolve(options.serverLog);
const serverEnvPath = options.serverEnv === null ? null : resolve(options.serverEnv);

// ---------------------------------------------------------------------------
// Output + assertions
// ---------------------------------------------------------------------------

const results = [];
const startedAt = Date.now();

class SkipStep extends Error {}

function need(value, label) {
  if (value === undefined || value === null) throw new SkipStep(`${label} is unavailable`);
  return value;
}

async function step(name, fn) {
  const stepStart = Date.now();
  try {
    const detail = await fn();
    const ms = Date.now() - stepStart;
    results.push({ name, status: "PASS", detail, ms });
    console.log(`PASS ${name}${detail ? ` — ${detail}` : ""} (${ms}ms)`);
  } catch (error) {
    const ms = Date.now() - stepStart;
    if (error instanceof SkipStep) {
      results.push({ name, status: "SKIP", detail: error.message, ms });
      console.log(`SKIP ${name} — ${error.message}`);
      return;
    }
    const message = error instanceof Error ? error.message : String(error);
    results.push({ name, status: "FAIL", detail: message, ms });
    console.log(`FAIL ${name} — ${message}`);
    if (options.verbose && error instanceof Error && error.stack) console.error(error.stack);
  }
}

function ok(value, message) {
  if (!value) throw new Error(`assertion failed: ${message}`);
}

function eq(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(
      `assertion failed: ${message} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`
    );
  }
}

function notEq(actual, unexpected, message) {
  if (actual === unexpected) {
    throw new Error(`assertion failed: ${message} (value must differ from ${JSON.stringify(unexpected)})`);
  }
}

function between(value, minimum, maximum, message) {
  ok(
    typeof value === "number" && Number.isFinite(value) && value >= minimum && value <= maximum,
    `${message} (expected ${minimum}..${maximum}, got ${JSON.stringify(value)})`
  );
}

function includesString(haystack, needle, message) {
  ok(
    typeof haystack === "string" && haystack.includes(needle),
    `assertion failed: ${message} (missing ${JSON.stringify(needle)})`
  );
}

function hasKeys(object, keys, label) {
  ok(object !== null && typeof object === "object", `${label} must be an object`);
  for (const key of keys) ok(key in object, `${label} must contain key '${key}'`);
}

function noKeys(object, keys, label) {
  ok(object !== null && typeof object === "object", `${label} must be an object`);
  for (const key of keys) ok(!(key in object), `${label} must not contain key '${key}'`);
}

function isUuid(value) {
  return typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value);
}

function isoNow(offsetMs = 0) {
  return new Date(Date.now() + offsetMs).toISOString();
}

function sleep(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

function randHex(bytes) {
  return randomBytes(bytes).toString("hex");
}

function sha256Hex(bufferOrText) {
  return createHash("sha256").update(bufferOrText).digest("hex");
}

// ---------------------------------------------------------------------------
// HTTP helper
// ---------------------------------------------------------------------------

async function api(method, path, init = {}) {
  const headers = { accept: "application/json", ...(init.headers ?? {}) };
  if (init.token !== undefined) headers.authorization = `Bearer ${init.token}`;
  const requestInit = {
    method,
    headers,
    signal: AbortSignal.timeout(init.timeoutMs ?? options.timeoutMs)
  };
  if (init.json !== undefined) {
    headers["content-type"] = "application/json";
    requestInit.body = JSON.stringify(init.json);
  }
  if (init.bytes !== undefined) requestInit.body = init.bytes;
  const response = await fetch(`${options.baseUrl}${path}`, requestInit);
  const contentType = (response.headers.get("content-type") ?? "").toLowerCase();
  let json = null;
  let bytes = null;
  if (contentType.includes("application/json")) {
    json = await response.json().catch(() => null);
  } else {
    bytes = Buffer.from(await response.arrayBuffer());
  }
  return { method, path, status: response.status, headers: response.headers, json, bytes };
}

function errorCode(response) {
  return response.json?.error?.code ?? null;
}

function errorMessage(response) {
  return response.json?.error?.message ?? "";
}

function describeResponse(response) {
  const code = errorCode(response);
  const body = response.status >= 400 && response.json !== null
    ? ` body=${JSON.stringify(response.json).slice(0, 400)}`
    : "";
  return `${response.method} ${response.path} -> ${response.status}${code ? ` ${code}` : ""}${body}`;
}

function expectStatus(response, status, label) {
  if (response.status !== status) {
    throw new Error(`${label}: expected HTTP ${status}, got ${describeResponse(response)}`);
  }
  return response;
}

function expectErrorCode(response, code, label) {
  eq(errorCode(response), code, `${label} error code`);
  return response;
}

function json(response, label) {
  ok(response.json !== null, `${label}: response body must be JSON`);
  return response.json;
}

/** Bounded retry for the few IP-bucket routes (register/login) so the harness
 * can be run twice in a row and still share a host with other QA agents. */
async function apiWithRateLimitRetry(method, path, init = {}, maxWaitMs = 90_000) {
  const deadline = Date.now() + maxWaitMs;
  for (;;) {
    const response = await api(method, path, init);
    if (response.status !== 429) return response;
    const retryAfterHeader = response.headers.get("retry-after");
    const retryAfterSeconds = Number(retryAfterHeader ?? "5");
    const waitMs = Math.min(Math.max(retryAfterSeconds * 1000, 1000), 30_000);
    if (Date.now() + waitMs > deadline) return response;
    console.log(`     (rate limited on ${method} ${path}; retrying after ${Math.round(waitMs / 1000)}s)`);
    await sleep(waitMs);
  }
}

// ---------------------------------------------------------------------------
// Realtime WebSocket helper (global WebSocket, no dependencies)
// ---------------------------------------------------------------------------

class RealtimeClient {
  constructor(socket, label) {
    this.socket = socket;
    this.label = label;
    this.frames = [];
    this.used = new Set();
    this.waiters = [];
    this.closeInfo = null;
    this.closeWaiters = [];
    socket.addEventListener("message", (event) => {
      let frame;
      try {
        const raw = typeof event.data === "string"
          ? event.data
          : Buffer.from(event.data).toString("utf8");
        frame = JSON.parse(raw);
      } catch {
        return;
      }
      this.frames.push(frame);
      this.#flush();
    });
    socket.addEventListener("close", (event) => {
      this.closeInfo = { code: event.code, reason: event.reason };
      for (const waiter of this.waiters.splice(0)) {
        clearTimeout(waiter.timer);
        waiter.reject(
          new Error(`${this.label}: socket closed (${event.code} ${event.reason}) before ${waiter.description}`)
        );
      }
      for (const resolveClose of this.closeWaiters.splice(0)) resolveClose(this.closeInfo);
    });
    socket.addEventListener("error", () => {
      /* close event carries the actionable state */
    });
  }

  static async connect(label) {
    const socket = await new Promise((resolveSocket, rejectSocket) => {
      const candidate = new WebSocket(WS_URL.href);
      const timer = setTimeout(() => {
        try { candidate.close(); } catch { /* ignore */ }
        rejectSocket(new Error(`${label}: WebSocket open timeout`));
      }, options.timeoutMs);
      candidate.addEventListener("open", () => {
        clearTimeout(timer);
        resolveSocket(candidate);
      }, { once: true });
      candidate.addEventListener("error", () => {
        clearTimeout(timer);
        rejectSocket(new Error(`${label}: WebSocket connection failed (is ${options.baseUrl} reachable?)`));
      }, { once: true });
    });
    const client = new RealtimeClient(socket, label);
    await client.waitFor((frame) => frame.type === "hello", options.timeoutMs, "hello");
    return client;
  }

  #take(predicate) {
    for (let index = 0; index < this.frames.length; index += 1) {
      if (!this.used.has(index) && predicate(this.frames[index])) {
        this.used.add(index);
        return this.frames[index];
      }
    }
    return null;
  }

  #flush() {
    for (const waiter of [...this.waiters]) {
      const value = this.#take(waiter.predicate);
      if (value === null) continue;
      clearTimeout(waiter.timer);
      this.waiters = this.waiters.filter((candidate) => candidate !== waiter);
      waiter.resolve(value);
    }
  }

  waitFor(predicate, timeoutMs = options.timeoutMs, description = "frame") {
    const found = this.#take(predicate);
    if (found !== null) return Promise.resolve(found);
    if (this.closeInfo !== null) {
      return Promise.reject(
        new Error(`${this.label}: socket already closed (${this.closeInfo.code}) before ${description}`)
      );
    }
    return new Promise((resolveFrame, rejectFrame) => {
      const waiter = {
        predicate,
        description,
        resolve: resolveFrame,
        reject: rejectFrame,
        timer: setTimeout(() => {
          this.waiters = this.waiters.filter((candidate) => candidate !== waiter);
          rejectFrame(new Error(`${this.label}: timeout waiting for ${description}`));
        }, timeoutMs)
      };
      this.waiters.push(waiter);
    });
  }

  waitClose(timeoutMs = options.timeoutMs) {
    if (this.closeInfo !== null) return Promise.resolve(this.closeInfo);
    return new Promise((resolveClose, rejectClose) => {
      const timer = setTimeout(
        () => rejectClose(new Error(`${this.label}: timeout waiting for socket close`)),
        timeoutMs
      );
      this.closeWaiters.push((info) => {
        clearTimeout(timer);
        resolveClose(info);
      });
    });
  }

  send(frame) {
    ok(this.socket.readyState === 1, `${this.label}: socket is not open`);
    this.socket.send(JSON.stringify(frame));
  }

  async close() {
    if (this.socket.readyState === 1) {
      try { this.socket.close(1000, "qa smoke done"); } catch { /* ignore */ }
    }
    await this.waitClose(5_000).catch(() => {});
  }
}

async function openAuthenticatedRealtime(label, token, resumeCursor) {
  const client = await RealtimeClient.connect(label);
  const hello = client.frames.find((frame) => frame.type === "hello");
  client.send({
    type: "authenticate",
    accessToken: token,
    ...(resumeCursor === undefined ? {} : { resumeCursor })
  });
  const ready = await client.waitFor((frame) => frame.type === "ready", options.timeoutMs, "ready");
  return { client, hello, ready };
}

function latestCursorFrame(client) {
  let latest = null;
  for (const frame of client.frames) {
    if (typeof frame.cursor === "string" && frame.cursor.startsWith("luxora-rt1.")) latest = frame;
  }
  return latest;
}

// ---------------------------------------------------------------------------
// Test data helpers
// ---------------------------------------------------------------------------

const runId = randHex(4);
const searchNeedle = `needle${runId}`;

const ctx = {
  users: {},
  tokens: {},
  passwords: {},
  ids: {},
  secrets: { refreshTokens: [], linkSecrets: [], accessTokens: [] },
  adminToken: null
};

function rememberTokens(tokens, label) {
  ctx.secrets.refreshTokens.push(tokens.refreshToken);
  ctx.secrets.accessTokens.push(tokens.accessToken);
  return tokens;
}

async function registerUser(key, label) {
  const username = `qa_${key}_${runId}${randHex(2)}`;
  const password = `QaSmoke-${randHex(10)}`;
  const response = await apiWithRateLimitRetry("POST", "/v1/auth/register", {
    json: {
      username,
      displayName: `QA ${label} ${runId}`,
      password,
      deviceName: `QA Smoke ${label}`
    }
  });
  expectStatus(response, 201, `register ${label}`);
  const body = json(response, `register ${label}`);
  hasKeys(body, ["user", "tokens"], `register ${label} response`);
  ok(isUuid(body.user.id), `register ${label}: user.id must be a UUID`);
  ctx.users[key] = body.user;
  ctx.tokens[key] = rememberTokens(body.tokens, label);
  ctx.passwords[key] = password;
  return body;
}

async function loginUser(key, deviceName) {
  const response = await apiWithRateLimitRetry("POST", "/v1/auth/login", {
    json: {
      username: ctx.users[key].username,
      password: ctx.passwords[key],
      deviceName
    }
  });
  expectStatus(response, 200, `login ${key} (${deviceName})`);
  return json(response, `login ${key}`).tokens;
}

async function sendMessage(token, chatId, body, extra = {}) {
  const payload = {
    body,
    clientNonce: extra.clientNonce ?? randomUUID(),
    ...(extra.replyToMessageId === undefined ? {} : { replyToMessageId: extra.replyToMessageId }),
    ...(extra.attachmentIds === undefined ? {} : { attachmentIds: extra.attachmentIds }),
    ...(extra.topicId === undefined ? {} : { topicId: extra.topicId })
  };
  const response = await api("POST", `/v1/chats/${chatId}/messages`, { token, json: payload });
  expectStatus(response, 201, "send message");
  return json(response, "send message").message;
}

/** Minimal dependency-free PNG encoder (RGB8, no filter) used for the media flow. */
function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc & 1) === 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeBytes = Buffer.from(type, "ascii");
  const crc = crc32(Buffer.concat([typeBytes, data]));
  const crcBytes = Buffer.alloc(4);
  crcBytes.writeUInt32BE(crc, 0);
  return Buffer.concat([length, typeBytes, data, crcBytes]);
}

function makePng(width, height) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: truecolour RGB
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace
  const rowBytes = 1 + width * 3;
  const raw = Buffer.alloc(height * rowBytes);
  for (let y = 0; y < height; y += 1) {
    const rowStart = y * rowBytes;
    raw[rowStart] = 0; // filter type none
    for (let x = 0; x < width; x += 1) {
      const offset = rowStart + 1 + x * 3;
      raw[offset] = Math.floor((x * 255) / width);
      raw[offset + 1] = Math.floor((y * 255) / height);
      raw[offset + 2] = Math.floor(((x + y) * 255) / (width + height));
    }
  }
  return Buffer.concat([
    signature,
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(raw, { level: 6 })),
    pngChunk("IEND", Buffer.alloc(0))
  ]);
}

function denialFingerprint(response) {
  return JSON.stringify({
    status: response.status,
    code: errorCode(response),
    message: errorMessage(response)
  });
}

// ---------------------------------------------------------------------------
// Smoke run
// ---------------------------------------------------------------------------

console.log(`Luxora API smoke — target ${options.baseUrl} (run ${runId})`);
console.log("");

// --- ops -------------------------------------------------------------------

await step("ops.health", async () => {
  const live = await api("GET", "/health/live");
  expectStatus(live, 200, "health/live");
  const liveBody = json(live, "health/live");
  eq(liveBody.status, "ok", "health/live status");
  ok(typeof liveBody.release === "string" && liveBody.release.length > 0, "health/live release label");

  const ready = await api("GET", "/health/ready");
  expectStatus(ready, 200, "health/ready");
  const readyBody = json(ready, "health/ready");
  eq(readyBody.status, "ready", "health/ready status");
  return `release ${liveBody.release}`;
});

await step("ops.capabilities", async () => {
  const response = await api("GET", "/v1/capabilities");
  expectStatus(response, 200, "capabilities");
  const body = json(response, "capabilities");
  eq(body.schemaVersion, 1, "capabilities schemaVersion");
  eq(body.versions.http[0], 1, "capabilities http version");
  ok(body.versions.realtime.supported.includes(2), "realtime v2 must be supported");
  eq(body.versions.realtime.preferred, 2, "realtime preferred version");
  eq(body.trust.endToEndEncryption, false, "cloud preview must not claim E2EE");
  eq(body.features.messaging, true, "features.messaging");
  eq(body.features.realtime, true, "features.realtime");
  eq(body.features.reconciliation, true, "features.reconciliation");
  eq(body.features.mediaUploads, true, "features.mediaUploads");
  eq(body.features.chatFolders, true, "features.chatFolders");
  eq(body.features.calls, false, "calls must be advertised false without a media plane");
  eq(typeof body.features.serverSearchConfigured, "boolean", "serverSearchConfigured boolean");
  hasKeys(body.limits, [
    "maxMessageCodePoints",
    "maxPageItems",
    "realtimeMaxReplayEvents",
    "uploadChunkSizeBytes",
    "maxAttachmentBytes"
  ], "capabilities limits");

  const cacheControl = (response.headers.get("cache-control") ?? "").toLowerCase();
  includesString(cacheControl, "no-store", "capabilities Cache-Control must be no-store");
  ok(!cacheControl.includes("private"), "capabilities must not be marked private");
  includesString((response.headers.get("pragma") ?? "").toLowerCase(), "no-cache", "capabilities Pragma");

  // An invalid bearer must be ignored by the account-free contract.
  const withBadBearer = await api("GET", "/v1/capabilities", { token: "not-a-real-token-value-at-all" });
  expectStatus(withBadBearer, 200, "capabilities with invalid bearer");
  eq(
    JSON.stringify(withBadBearer.json),
    JSON.stringify(body),
    "capabilities must ignore an invalid bearer"
  );
  return `schema v${body.schemaVersion}, realtime ${body.versions.realtime.supported.join("/")}, ` +
    `calls=${body.features.calls}, search=${body.features.serverSearchConfigured}`;
});

// --- browser transport (CORS) ---------------------------------------------

await step("ops.cors-preflight", async () => {
  const origin = need(options.corsOrigin, "CORS origin (pass --cors-origin <allowed origin>)");
  const requiredMethods = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"];

  for (const method of ["PATCH", "PUT", "DELETE"]) {
    const preflight = await api("OPTIONS", "/v1/me", {
      headers: {
        origin,
        "access-control-request-method": method,
        "access-control-request-headers": "authorization,content-type"
      }
    });
    expectStatus(preflight, 204, `CORS preflight ${method}`);
    eq(
      preflight.headers.get("access-control-allow-origin"),
      origin,
      `CORS preflight ${method} allow-origin`
    );
    const allowedMethods = (preflight.headers.get("access-control-allow-methods") ?? "")
      .split(",")
      .map((value) => value.trim());
    for (const required of requiredMethods) {
      ok(
        allowedMethods.includes(required),
        `CORS preflight for ${method} must allow ${required} (got ${allowedMethods.join(",")})`
      );
    }
  }

  // Actual responses must let browser JS read the download/retry headers.
  const actual = await api("GET", "/health/live", { headers: { origin } });
  expectStatus(actual, 200, "CORS actual response");
  eq(actual.headers.get("access-control-allow-origin"), origin, "CORS actual allow-origin");
  const exposed = (actual.headers.get("access-control-expose-headers") ?? "").toLowerCase();
  for (const header of ["etag", "content-range", "accept-ranges", "content-disposition", "retry-after"]) {
    includesString(exposed, header, `CORS must expose ${header} to browser JS`);
  }

  // Origin policy stays an explicit allowlist: an unknown origin gets no grant.
  const denied = await api("OPTIONS", "/v1/me", {
    headers: {
      origin: `http://qa-smoke.${runId}.invalid`,
      "access-control-request-method": "PATCH"
    }
  });
  eq(
    denied.headers.get("access-control-allow-origin"),
    null,
    "disallowed origin must not receive an allow-origin grant"
  );
  return `preflight allows ${requiredMethods.join(",")} for ${origin}`;
});

// --- auth ------------------------------------------------------------------

await step("auth.register", async () => {
  await registerUser("a", "Alpha");
  await registerUser("b", "Bravo");
  await registerUser("c", "Charlie");
  const a = ctx.users.a;
  ok(isUuid(a.id), "registered user must carry a UUID id");
  ok(a.username.startsWith("qa_a_"), "username echo");
  eq(a.bio, "", "new account bio must be empty");
  hasKeys(ctx.tokens.a, ["accessToken", "refreshToken", "tokenType", "expiresIn", "sessionId"], "tokens");
  eq(ctx.tokens.a.tokenType, "Bearer", "token type");
  eq(ctx.tokens.a.expiresIn, 900, "access token TTL");
  ok(isUuid(ctx.tokens.a.sessionId), "session id");
  return `users A=${a.username} B=${ctx.users.b.username} C=${ctx.users.c.username}`;
});

await step("auth.refresh-rotation", async () => {
  const a = need(ctx.users.a, "user A");
  const first = await loginUser("a", "QA rotate device");
  rememberTokens(first, "rotate");
  eq(first.sessionId !== ctx.tokens.a.sessionId, true, "second login must create a second session");

  const rotatedResponse = await api("POST", "/v1/auth/refresh", {
    json: { refreshToken: first.refreshToken }
  });
  expectStatus(rotatedResponse, 200, "auth/refresh");
  const rotated = json(rotatedResponse, "auth/refresh").tokens;
  rememberTokens(rotated, "rotated");
  eq(rotated.sessionId, first.sessionId, "refresh must keep the same device session");
  notEq(rotated.refreshToken, first.refreshToken, "refresh must rotate the refresh token");
  notEq(rotated.accessToken, first.accessToken, "refresh must issue a new access token");

  // Reusing the consumed refresh token revokes the token family/session.
  const reused = await api("POST", "/v1/auth/refresh", {
    json: { refreshToken: first.refreshToken }
  });
  expectStatus(reused, 401, "refresh reuse");
  expectErrorCode(reused, "UNAUTHENTICATED", "refresh reuse");

  const revokedSessionProbe = await api("GET", "/v1/me", { token: rotated.accessToken });
  expectStatus(revokedSessionProbe, 401, "access token after refresh reuse");
  expectErrorCode(revokedSessionProbe, "UNAUTHENTICATED", "revoked session");
  return "rotation + reuse revoked the family session";
});

await step("auth.me-profile", async () => {
  const a = need(ctx.users.a, "user A");
  const me = await api("GET", "/v1/me", { token: ctx.tokens.a.accessToken });
  expectStatus(me, 200, "GET /v1/me");
  eq(me.json.user.id, a.id, "GET /v1/me user id");
  includesString(
    (me.headers.get("cache-control") ?? "").toLowerCase(),
    "private",
    "authenticated self projection must be private"
  );

  const displayName = `QA Alpha ${runId} renamed`;
  const patch = await api("PATCH", "/v1/me", {
    token: ctx.tokens.a.accessToken,
    json: { displayName, bio: `smoke bio ${runId}` }
  });
  expectStatus(patch, 200, "PATCH /v1/me");
  eq(patch.json.user.displayName, displayName, "profile display name update");
  eq(patch.json.user.bio, `smoke bio ${runId}`, "profile bio update");

  const fetched = await api("GET", "/v1/me", { token: ctx.tokens.a.accessToken });
  expectStatus(fetched, 200, "GET /v1/me after patch");
  eq(fetched.json.user.displayName, displayName, "profile update persisted");
  ctx.users.a = fetched.json.user;
  return `displayName=${JSON.stringify(displayName)}`;
});

await step("auth.sessions", async () => {
  const a = need(ctx.users.a, "user A");
  const extra = await loginUser("a", "QA revoke device");
  rememberTokens(extra, "revoke");

  const list = await api("GET", "/v1/auth/sessions", { token: ctx.tokens.a.accessToken });
  expectStatus(list, 200, "GET /v1/auth/sessions");
  const sessions = list.json.items;
  ok(Array.isArray(sessions), "sessions items");
  const current = sessions.find((session) => session.current === true);
  ok(current !== undefined, "sessions must contain the current session");
  eq(current.id, ctx.tokens.a.sessionId, "current session id");
  ok(sessions.some((session) => session.id === extra.sessionId), "second login appears in sessions");

  const revoke = await api("DELETE", `/v1/auth/sessions/${extra.sessionId}`, {
    token: ctx.tokens.a.accessToken
  });
  expectStatus(revoke, 204, "DELETE /v1/auth/sessions/:id");

  const afterRevoke = await api("GET", "/v1/me", { token: extra.accessToken });
  expectStatus(afterRevoke, 401, "revoked session access token");
  expectErrorCode(afterRevoke, "UNAUTHENTICATED", "revoked session access token");

  // A revoked device session cannot obtain a fresh reconciliation boundary.
  const revokedSnapshot = await api("GET", "/v2/sync/snapshot", { token: extra.accessToken });
  expectStatus(revokedSnapshot, 401, "revoked session snapshot");
  expectErrorCode(revokedSnapshot, "UNAUTHENTICATED", "revoked session snapshot");

  const foreignSession = await api("GET", "/v1/auth/sessions", { token: ctx.tokens.b.accessToken });
  expectStatus(foreignSession, 200, "user B sessions");
  ok(
    !foreignSession.json.items.some((session) => session.id === a.id),
    "session list is account scoped"
  );
  return `${sessions.length} sessions before revoke`;
});

// --- discovery / privacy ---------------------------------------------------

await step("discovery.lookup", async () => {
  const a = need(ctx.tokens.a, "user A");
  const b = need(ctx.users.b, "user B");

  const exact = await api(
    "GET",
    `/v1/users/lookup?username=${encodeURIComponent(b.username.toUpperCase())}`,
    { token: a.accessToken }
  );
  expectStatus(exact, 200, "exact username lookup");
  ok(exact.json.profile !== null, "exact lookup must resolve a discoverable profile");
  eq(exact.json.profile.id, b.id, "lookup profile id");
  eq(exact.json.profile.username, b.username, "lookup profile username");
  noKeys(exact.json.profile, ["presence", "sessionId", "accessToken", "phoneNumber"], "public profile");
  includesString(
    (exact.headers.get("cache-control") ?? "").toLowerCase(),
    "no-store",
    "lookup must be no-store"
  );

  const absent = await api(
    "GET",
    `/v1/users/lookup?username=${encodeURIComponent(`absent_${runId}`)}`,
    { token: a.accessToken }
  );
  expectStatus(absent, 200, "absent username lookup");
  eq(absent.json.profile, null, "absent account lookup must be null");

  const anonymous = await api(
    "GET",
    `/v1/users/lookup?username=${encodeURIComponent(b.username)}`
  );
  expectStatus(anonymous, 401, "anonymous lookup");
  expectErrorCode(anonymous, "UNAUTHENTICATED", "anonymous lookup");
  return "exact case-insensitive lookup, null for absent, 401 anonymous";
});

await step("discovery.privacy-directions", async () => {
  const a = need(ctx.tokens.a, "user A");
  const b = need(ctx.tokens.b, "user B");

  // Direction 1: B hides the username from discovery; A sees a null profile.
  const hideB = await api("PATCH", "/v1/privacy", {
    token: b.accessToken,
    json: { usernameDiscoverable: false }
  });
  expectStatus(hideB, 200, "B hides username discovery");
  eq(hideB.json.settings.usernameDiscoverable, false, "B privacy flag persisted");

  const hiddenLookup = await api(
    "GET",
    `/v1/users/lookup?username=${encodeURIComponent(ctx.users.b.username)}`,
    { token: a.accessToken }
  );
  expectStatus(hiddenLookup, 200, "hidden lookup");
  eq(hiddenLookup.json.profile, null, "hidden account must be indistinguishable from absent");

  const showB = await api("PATCH", "/v1/privacy", {
    token: b.accessToken,
    json: { usernameDiscoverable: true }
  });
  expectStatus(showB, 200, "B restores discovery");
  eq(showB.json.settings.usernameDiscoverable, true, "B privacy restored");

  // Direction 2: A refuses message requests; B cannot open a relationship.
  const nobody = await api("PATCH", "/v1/privacy", {
    token: a.accessToken,
    json: { messageRequests: "nobody" }
  });
  expectStatus(nobody, 200, "A messageRequests=nobody");
  eq(nobody.json.settings.messageRequests, "nobody", "A policy persisted");

  const blockedRequest = await api("POST", "/v1/message-requests", {
    token: b.accessToken,
    json: {
      recipientUserId: ctx.users.a.id,
      body: "should not be delivered",
      clientNonce: randomUUID()
    }
  });
  expectStatus(blockedRequest, 403, "message request against nobody policy");
  expectErrorCode(blockedRequest, "FORBIDDEN", "message request against nobody policy");
  eq(blockedRequest.json.error.details?.reason, "relationship_unavailable", "generic relationship reason");

  const everyone = await api("PATCH", "/v1/privacy", {
    token: a.accessToken,
    json: { messageRequests: "everyone", usernameDiscoverable: true }
  });
  expectStatus(everyone, 200, "A restores message requests");
  eq(everyone.json.settings.messageRequests, "everyone", "A policy restored");
  return "hidden profile + refused request in both directions";
});

await step("relationship.message-request", async () => {
  const a = need(ctx.tokens.a, "user A");
  const b = need(ctx.tokens.b, "user B");
  const requestNonce = randomUUID();
  const firstText = `Hello from the QA smoke request ${runId}`;

  const created = await api("POST", "/v1/message-requests", {
    token: a.accessToken,
    json: { recipientUserId: ctx.users.b.id, body: firstText, clientNonce: requestNonce }
  });
  expectStatus(created, 201, "create message request");
  const request = created.json.request;
  eq(request.direction, "outgoing", "sender projection direction");
  eq(request.state, "pending", "sender projection state");
  eq(request.recipient.id, ctx.users.b.id, "sender projection recipient");
  ok(isUuid(request.id), "message request id");

  // Exact nonce replay is idempotent and returns the canonical request.
  const replay = await api("POST", "/v1/message-requests", {
    token: a.accessToken,
    json: { recipientUserId: ctx.users.b.id, body: firstText, clientNonce: requestNonce }
  });
  expectStatus(replay, 201, "message request nonce replay");
  eq(replay.json.request.id, request.id, "nonce replay returns the same request");

  // Changed reuse under the same nonce conflicts.
  const changed = await api("POST", "/v1/message-requests", {
    token: a.accessToken,
    json: {
      recipientUserId: ctx.users.b.id,
      body: `${firstText} changed`,
      clientNonce: requestNonce
    }
  });
  expectStatus(changed, 409, "changed nonce reuse");
  expectErrorCode(changed, "CONFLICT", "changed nonce reuse");

  // Sender cannot accept its own request; sender-safe projection must not leak
  // recipient-private dismissal/subject state.
  const senderAccept = await api("POST", `/v1/message-requests/${request.id}/accept`, {
    token: a.accessToken
  });
  expectStatus(senderAccept, 404, "sender accept");
  expectErrorCode(senderAccept, "NOT_FOUND", "sender accept");

  const incoming = await api("GET", "/v1/message-requests?direction=incoming", {
    token: b.accessToken
  });
  expectStatus(incoming, 200, "incoming message requests");
  const incomingRequest = incoming.json.items.find((item) => item.id === request.id);
  ok(incomingRequest !== undefined, "recipient must see the incoming request");
  eq(incomingRequest.state, "pending", "recipient projection state");
  eq(incomingRequest.sender.id, ctx.users.a.id, "recipient projection sender");

  // No Direct exists before acceptance.
  const chatsBefore = await api("GET", "/v1/chats", { token: b.accessToken });
  expectStatus(chatsBefore, 200, "chats before acceptance");
  eq(chatsBefore.json.items.length, 0, "no direct chat may exist before acceptance");

  const accepted = await api("POST", `/v1/message-requests/${request.id}/accept`, {
    token: b.accessToken
  });
  expectStatus(accepted, 200, "accept message request");
  eq(accepted.json.request.state, "accepted", "accepted request state");
  const chat = accepted.json.chat;
  eq(chat.kind, "direct", "accepted request must create a direct chat");
  eq(chat.memberCount, 2, "direct chat member count");
  ctx.ids.directChatId = chat.id;
  ctx.ids.acceptedRequestId = request.id;

  const duplicateAccept = await api("POST", `/v1/message-requests/${request.id}/accept`, {
    token: b.accessToken
  });
  expectStatus(duplicateAccept, 200, "duplicate accept replays");
  eq(duplicateAccept.json.chat.id, chat.id, "duplicate accept returns the same direct chat");
  return `request ${request.id} -> chat ${chat.id}`;
});

await step("chats.list", async () => {
  const a = need(ctx.tokens.a, "user A");
  const b = need(ctx.tokens.b, "user B");
  const chatId = need(ctx.ids.directChatId, "direct chat");

  const listA = await api("GET", "/v1/chats", { token: a.accessToken });
  expectStatus(listA, 200, "A GET /v1/chats");
  const chatForA = listA.json.items.find((item) => item.id === chatId);
  ok(chatForA !== undefined, "A must list the direct chat");
  eq(chatForA.kind, "direct", "direct chat kind");
  eq(chatForA.role, "member", "direct chat role");
  eq(chatForA.memberCount, 2, "direct chat member count");
  ok(chatForA.lastMessage !== null, "acceptance first message must be projected");
  includesString(chatForA.lastMessage.body, runId, "acceptance first message body");

  const listB = await api("GET", "/v1/chats", { token: b.accessToken });
  expectStatus(listB, 200, "B GET /v1/chats");
  ok(listB.json.items.some((item) => item.id === chatId), "B must list the direct chat");

  const detail = await api("GET", `/v1/chats/${chatId}`, { token: a.accessToken });
  expectStatus(detail, 200, "GET /v1/chats/:id");
  eq(detail.json.chat.id, chatId, "chat detail id");
  return `${listA.json.items.length} chats for A`;
});

// --- messages --------------------------------------------------------------

await step("messages.send-idempotency", async () => {
  const a = need(ctx.tokens.a, "user A");
  const chatId = need(ctx.ids.directChatId, "direct chat");
  const nonce = randomUUID();
  const body = `First smoke message ${runId}`;

  const created = await sendMessage(a.accessToken, chatId, body, { clientNonce: nonce });
  eq(created.chatId, chatId, "message chat id");
  eq(created.kind, "text", "message kind");
  eq(created.body, body, "message body");
  eq(created.clientNonce, nonce, "message nonce echo");
  eq(created.revision, 0, "new message revision");
  eq(created.sender.id, ctx.users.a.id, "message sender");
  eq(created.replyToMessageId, null, "new message reply target");
  eq(created.deletedAt, null, "new message not deleted");
  eq(created.editedAt, null, "new message not edited");
  ctx.ids.message1 = created.id;

  const replay = await sendMessage(a.accessToken, chatId, body, { clientNonce: nonce });
  eq(replay.id, created.id, "nonce replay must return the same canonical message");

  const conflict = await api("POST", `/v1/chats/${chatId}/messages`, {
    token: a.accessToken,
    json: { body: `${body} mutated`, clientNonce: nonce }
  });
  expectStatus(conflict, 409, "changed nonce reuse");
  expectErrorCode(conflict, "CONFLICT", "changed nonce reuse");

  const page = await api("GET", `/v1/chats/${chatId}/messages?limit=1`, { token: a.accessToken });
  expectStatus(page, 200, "messages page");
  eq(page.json.items.length, 1, "limit=1 page size");
  eq(page.json.items[0].id, created.id, "most recent message first");
  ok(page.json.nextCursor !== null, "paged history must expose nextCursor");
  return `message ${created.id} revision ${created.revision}`;
});

await step("messages.list-reply-edit", async () => {
  const a = need(ctx.tokens.a, "user A");
  const b = need(ctx.tokens.b, "user B");
  const chatId = need(ctx.ids.directChatId, "direct chat");
  const message1 = need(ctx.ids.message1, "message 1");

  const reply = await sendMessage(b.accessToken, chatId, `Reply from B ${runId}`, {
    replyToMessageId: message1
  });
  eq(reply.replyToMessageId, message1, "reply target");
  eq(reply.sender.id, ctx.users.b.id, "reply sender");
  ctx.ids.message2 = reply.id;

  const edited = await api("PATCH", `/v1/messages/${message1}`, {
    token: a.accessToken,
    json: { body: `Edited smoke message ${runId}`, expectedRevision: 0 }
  });
  expectStatus(edited, 200, "edit message");
  eq(edited.json.message.revision, 1, "edit must bump the revision");
  eq(edited.json.message.body, `Edited smoke message ${runId}`, "edited body");
  ok(edited.json.message.editedAt !== null, "editedAt must be set");

  const stale = await api("PATCH", `/v1/messages/${message1}`, {
    token: a.accessToken,
    json: { body: "stale edit", expectedRevision: 0 }
  });
  expectStatus(stale, 409, "stale edit revision");
  expectErrorCode(stale, "CONFLICT", "stale edit revision");

  // A non-author member may not edit another member's message.
  const foreignEdit = await api("PATCH", `/v1/messages/${message1}`, {
    token: b.accessToken,
    json: { body: "hijacked", expectedRevision: 1 }
  });
  expectStatus(foreignEdit, 403, "non-author edit");
  expectErrorCode(foreignEdit, "FORBIDDEN", "non-author edit");

  const history = await api("GET", `/v1/messages/${message1}/history`, { token: a.accessToken });
  expectStatus(history, 200, "message history");
  eq(history.json.items.length, 1, "one previous revision after a single edit");
  eq(history.json.items[0].body, `First smoke message ${runId}`, "historical body preserved");

  const list = await api("GET", `/v1/chats/${chatId}/messages?limit=30`, { token: a.accessToken });
  expectStatus(list, 200, "message list");
  const ids = list.json.items.map((item) => item.id);
  ok(ids.includes(message1) && ids.includes(reply.id), "list must contain both messages");
  return "reply, edit CAS, stale conflict, non-author denial";
});

await step("messages.reactions-pins", async () => {
  const a = need(ctx.tokens.a, "user A");
  const b = need(ctx.tokens.b, "user B");
  const chatId = need(ctx.ids.directChatId, "direct chat");
  const message1 = need(ctx.ids.message1, "message 1");
  const emoji = "\u{1f49c}";

  const bAdds = await api("PUT", `/v1/messages/${message1}/reactions`, {
    token: b.accessToken,
    json: { emoji }
  });
  expectStatus(bAdds, 200, "B add reaction");
  eq(bAdds.json.items.length, 1, "one reaction aggregate");
  eq(bAdds.json.items[0].emoji, emoji, "reaction emoji");
  eq(bAdds.json.items[0].count, 1, "reaction count");
  eq(bAdds.json.items[0].reactedByMe, true, "B reactedByMe");

  const idempotent = await api("PUT", `/v1/messages/${message1}/reactions`, {
    token: b.accessToken,
    json: { emoji }
  });
  expectStatus(idempotent, 200, "B repeat reaction");
  eq(idempotent.json.items[0].count, 1, "reaction add is idempotent per actor");

  const aReads = await api("GET", `/v1/messages/${message1}/reactions`, { token: a.accessToken });
  expectStatus(aReads, 200, "A reads reactions");
  eq(aReads.json.items[0].count, 1, "aggregate count for A");
  eq(aReads.json.items[0].reactedByMe, false, "reactedByMe must be viewer scoped");
  includesString(
    (aReads.headers.get("cache-control") ?? "").toLowerCase(),
    "no-store",
    "reaction read must be no-store"
  );

  const aAdds = await api("PUT", `/v1/messages/${message1}/reactions`, {
    token: a.accessToken,
    json: { emoji }
  });
  expectStatus(aAdds, 200, "A add reaction");
  eq(aAdds.json.items[0].count, 2, "two actors count");
  eq(aAdds.json.items[0].reactedByMe, true, "A reactedByMe");

  const bRemoves = await api("DELETE", `/v1/messages/${message1}/reactions`, {
    token: b.accessToken,
    json: { emoji }
  });
  expectStatus(bRemoves, 200, "B remove reaction");
  eq(bRemoves.json.items[0].count, 1, "count after B removal");

  const pinned = await api("PUT", `/v1/chats/${chatId}/pins/${message1}`, {
    token: a.accessToken
  });
  expectStatus(pinned, 200, "pin message");
  eq(pinned.json.pin.messageId, message1, "pinned message id");
  eq(pinned.json.pin.chatId, chatId, "pin chat id");

  const pins = await api("GET", `/v1/chats/${chatId}/pins`, { token: b.accessToken });
  expectStatus(pins, 200, "list pins");
  ok(pins.json.items.some((pin) => pin.messageId === message1), "pin must be listed");

  const unpin = await api("DELETE", `/v1/chats/${chatId}/pins/${message1}`, {
    token: a.accessToken
  });
  expectStatus(unpin, 204, "unpin message");
  const pinsAfter = await api("GET", `/v1/chats/${chatId}/pins`, { token: a.accessToken });
  expectStatus(pinsAfter, 200, "list pins after unpin");
  ok(!pinsAfter.json.items.some((pin) => pin.messageId === message1), "pin must be removed");
  return "react add/repeat/read/remove + pin/unpin";
});

await step("messages.receipts", async () => {
  const a = need(ctx.tokens.a, "user A");
  const b = need(ctx.tokens.b, "user B");
  const chatId = need(ctx.ids.directChatId, "direct chat");
  const message1 = need(ctx.ids.message1, "message 1");

  const delivered = await api("POST", `/v1/chats/${chatId}/delivered`, {
    token: b.accessToken,
    json: { messageId: message1 }
  });
  expectStatus(delivered, 204, "B delivered receipt");
  const repeatDelivered = await api("POST", `/v1/chats/${chatId}/delivered`, {
    token: b.accessToken,
    json: { messageId: message1 }
  });
  expectStatus(repeatDelivered, 204, "B repeat delivered receipt is idempotent");

  const read = await api("POST", `/v1/chats/${chatId}/read`, {
    token: b.accessToken,
    json: { messageId: message1 }
  });
  expectStatus(read, 204, "B read receipt");

  const receipts = await api("GET", `/v1/messages/${message1}/receipts`, { token: a.accessToken });
  expectStatus(receipts, 200, "A reads receipts");
  const bReceipt = receipts.json.items.find((receipt) => receipt.userId === ctx.users.b.id);
  ok(bReceipt !== undefined, "B receipt must be visible to A");
  ok(bReceipt.deliveredAt !== null, "deliveredAt must be set");
  ok(bReceipt.readAt !== null, "readAt must be set");
  return `delivered+read receipts for ${message1}`;
});

await step("messages.delete-tombstone", async () => {
  const a = need(ctx.tokens.a, "user A");
  const chatId = need(ctx.ids.directChatId, "direct chat");
  const message1 = need(ctx.ids.message1, "message 1");

  const deleted = await api("DELETE", `/v1/messages/${message1}`, { token: a.accessToken });
  expectStatus(deleted, 200, "delete message");
  eq(deleted.json.message.id, message1, "tombstone id");
  eq(deleted.json.message.body, null, "tombstone body must be null");
  ok(deleted.json.message.deletedAt !== null, "tombstone deletedAt must be set");

  const list = await api("GET", `/v1/chats/${chatId}/messages?limit=30`, { token: a.accessToken });
  expectStatus(list, 200, "message list after delete");
  const tombstone = list.json.items.find((item) => item.id === message1);
  ok(tombstone !== undefined, "tombstone must stay in synchronized history");
  eq(tombstone.body, null, "synchronized tombstone body");

  const reactionsAfterDelete = await api("GET", `/v1/messages/${message1}/reactions`, {
    token: a.accessToken
  });
  expectStatus(reactionsAfterDelete, 200, "reactions on deleted message");
  eq(reactionsAfterDelete.json.items.length, 0, "deleted message exposes no reactions");
  return "body:null tombstone retained in history";
});

// --- realtime --------------------------------------------------------------

const realtime = { a: null, b: null };

await step("realtime.handshake", async () => {
  const a = need(ctx.tokens.a, "user A");
  const b = need(ctx.tokens.b, "user B");
  const first = await openAuthenticatedRealtime("A", a.accessToken);
  realtime.a = first.client;
  eq(first.hello.type, "hello", "hello frame");
  eq(first.hello.protocolVersion, 2, "v2 protocol version");
  ok(isUuid(first.hello.connectionId), "hello connection id");
  ok(first.hello.heartbeatIntervalMs > 0, "heartbeat interval");
  eq(first.ready.type, "ready", "ready frame");
  eq(first.ready.userId, a.userId ?? ctx.users.a.id, "ready user id");
  eq(first.ready.sessionId, a.sessionId, "ready session id");
  eq(first.ready.resumed, false, "fresh connection is not resumed");
  eq(first.ready.resumeMode, "none", "fresh resume mode");
  eq(first.ready.cursor === null ? null : typeof first.ready.cursor, "string", "fresh ready cursor");
  includesString(first.ready.cursor ?? "", "luxora-rt1.", "ready cursor prefix");
  eq(first.ready.retention.maxReplayEvents, 500, "advertised replay window");
  includesString(
    (first.ready.cursor ?? "").length > 0 ? "luxora-rt1" : "",
    "luxora-rt1",
    "cursor format"
  );
  const checkpoint = await first.client.waitFor(
    (frame) => frame.type === "sync.checkpoint",
    options.timeoutMs,
    "sync.checkpoint"
  );
  between(checkpoint.sequence, 0, Number.MAX_SAFE_INTEGER, "checkpoint sequence");
  includesString(checkpoint.cursor, "luxora-rt1.", "checkpoint cursor prefix");

  const second = await openAuthenticatedRealtime("B", b.accessToken);
  realtime.b = second.client;
  eq(second.ready.userId, ctx.users.b.id, "B ready user id");
  await second.client.waitFor(
    (frame) => frame.type === "sync.checkpoint",
    options.timeoutMs,
    "B sync.checkpoint"
  );
  return `A checkpoint seq ${checkpoint.sequence}`;
});

await step("realtime.durable-delivery", async () => {
  const a = need(ctx.tokens.a, "user A");
  const b = need(ctx.tokens.b, "user B");
  const chatId = need(ctx.ids.directChatId, "direct chat");
  const clientA = need(realtime.a, "A realtime socket");
  const clientB = need(realtime.b, "B realtime socket");

  const message = await sendMessage(a.accessToken, chatId, `Realtime message ${searchNeedle}`, {});
  ctx.ids.message3 = message.id;

  const createdForA = await clientA.waitFor(
    (frame) => frame.type === "dispatch" &&
      frame.event.type === "message.created" &&
      frame.event.message.id === message.id,
    options.timeoutMs,
    "A message.created"
  );
  const createdForB = await clientB.waitFor(
    (frame) => frame.type === "dispatch" &&
      frame.event.type === "message.created" &&
      frame.event.message.id === message.id,
    options.timeoutMs,
    "B message.created"
  );
  eq(createdForA.event.message.body, message.body, "A dispatch message body");
  // Sequence is a sparse global watermark and every audience gets its own
  // durable row, so the two members legitimately observe different numbers.
  eq(createdForB.event.message.body, message.body, "B dispatch message body");
  eq(createdForB.event.message.id, message.id, "both members observe the same message id");
  between(createdForA.sequence, 1, Number.MAX_SAFE_INTEGER, "A dispatch sequence");
  between(createdForB.sequence, 1, Number.MAX_SAFE_INTEGER, "B dispatch sequence");
  includesString(createdForA.cursor, "luxora-rt1.", "durable dispatch cursor");

  // Explicit recipient acknowledgement produces the durable receipt read event.
  const deliveredResponse = await api("POST", `/v1/chats/${chatId}/delivered`, {
    token: b.accessToken,
    json: { messageId: message.id }
  });
  expectStatus(deliveredResponse, 204, "B delivered receipt (realtime)");
  const deliveredForA = await clientA.waitFor(
    (frame, index) => frame.type === "dispatch" &&
      frame.event.type === "receipt.delivered" &&
      frame.event.messageId === message.id &&
      frame.event.userId === ctx.users.b.id,
    options.timeoutMs,
    "A receipt.delivered"
  );
  ok(deliveredForA !== undefined, "A must receive receipt.delivered");

  const readResponse = await api("POST", `/v1/chats/${chatId}/read`, {
    token: b.accessToken,
    json: { messageId: message.id }
  });
  expectStatus(readResponse, 204, "B read receipt (realtime)");
  await clientB.waitFor(
    (frame) => frame.type === "dispatch" &&
      frame.event.type === "receipt.read" &&
      frame.event.messageId === message.id &&
      frame.event.userId === ctx.users.b.id,
    options.timeoutMs,
    "B receipt.read echo"
  );
  await clientA.waitFor(
    (frame) => frame.type === "dispatch" &&
      frame.event.type === "receipt.read" &&
      frame.event.messageId === message.id &&
      frame.event.userId === ctx.users.b.id,
    options.timeoutMs,
    "A receipt.read"
  );

  // Reaction aggregation is reprojected per viewer at dispatch time.
  const reactionResponse = await api("PUT", `/v1/messages/${message.id}/reactions`, {
    token: b.accessToken,
    json: { emoji: "\u{1f680}" }
  });
  expectStatus(reactionResponse, 200, "B adds realtime reaction");
  const reactionForA = await clientA.waitFor(
    (frame) => frame.type === "dispatch" &&
      frame.event.type === "reaction.updated" &&
      frame.event.messageId === message.id,
    options.timeoutMs,
    "A reaction.updated"
  );
  eq(reactionForA.event.actorUserId, ctx.users.b.id, "reaction actor");
  eq(reactionForA.event.reactions[0].count, 1, "reaction aggregate count for A");
  eq(reactionForA.event.reactions[0].reactedByMe, false, "reaction aggregate viewer scoped");

  // v2-only account-scoped durable events must reach the owning account live and
  // must never fan out to another chat member.
  const profilePatch = await api("PATCH", "/v1/me", {
    token: ctx.tokens.a.accessToken,
    json: { bio: `realtime bio ${runId}` }
  });
  expectStatus(profilePatch, 200, "profile patch during realtime");
  const invalidated = await clientA.waitFor(
    (frame) => frame.type === "dispatch" &&
      frame.event.type === "sync.invalidated" &&
      frame.event.accountId === ctx.users.a.id,
    options.timeoutMs,
    "A sync.invalidated(profile_updated)"
  );
  eq(invalidated.event.reason, "profile_updated", "sync.invalidated reason");
  // Profile projection invalidations are fanned out to accounts that render the
  // profile (accepted chat peers); each audience row is still account-scoped, so
  // the peer must only ever see its own accountId, never another's.
  const peerInvalidations = clientB.frames.filter(
    (frame) => frame.type === "dispatch" && frame.event.type === "sync.invalidated"
  );
  eq(
    peerInvalidations.every((frame) => frame.event.accountId === ctx.users.b.id),
    true,
    "profile invalidation rows must be scoped to their own account audience"
  );

  const archivePatch = await api("PATCH", `/v1/chats/${chatId}/preferences`, {
    token: ctx.tokens.a.accessToken,
    json: { archived: true }
  });
  expectStatus(archivePatch, 200, "archive chat during realtime");
  const preferenceEvent = await clientA.waitFor(
    (frame) => frame.type === "dispatch" &&
      frame.event.type === "chat.preferences.updated" &&
      frame.event.accountId === ctx.users.a.id,
    options.timeoutMs,
    "A chat.preferences.updated"
  );
  eq(preferenceEvent.event.chatId, chatId, "preference event chat id");
  ok(preferenceEvent.event.preferences.archivedAt !== null, "preference event archive state");
  eq(
    clientB.frames.some(
      (frame) => frame.type === "dispatch" &&
        frame.event.type === "chat.preferences.updated"
    ),
    false,
    "private chat preference events must not reach another member"
  );
  const unarchive = await api("PATCH", `/v1/chats/${chatId}/preferences`, {
    token: ctx.tokens.a.accessToken,
    json: { archived: false }
  });
  expectStatus(unarchive, 200, "unarchive chat during realtime");

  const orderedSequences = clientA.frames
    .filter((frame) => frame.type === "dispatch")
    .map((frame) => frame.sequence);
  ok(
    orderedSequences.every((sequence, index) => index === 0 || sequence > orderedSequences[index - 1]),
    "live dispatch sequences must be strictly increasing"
  );
  return `message.created/receipt.delivered/receipt.read/reaction.updated + ` +
    `account-scoped sync.invalidated/chat.preferences.updated delivered`;
});

await step("realtime.typing-heartbeat", async () => {
  const chatId = need(ctx.ids.directChatId, "direct chat");
  const clientA = need(realtime.a, "A realtime socket");
  const clientB = need(realtime.b, "B realtime socket");

  const heartbeatTimestamp = isoNow();
  clientA.send({ type: "heartbeat", timestamp: heartbeatTimestamp });
  const ack = await clientA.waitFor(
    (frame) => frame.type === "heartbeat.ack" && frame.timestamp === heartbeatTimestamp,
    options.timeoutMs,
    "heartbeat.ack"
  );
  eq(ack.timestamp, heartbeatTimestamp, "heartbeat ack echoes the timestamp");

  clientA.send({ type: "typing.start", chatId });
  const typingStart = await clientB.waitFor(
    (frame) => frame.type === "typing.updated" && frame.chatId === chatId && frame.isTyping === true,
    options.timeoutMs,
    "B typing.updated start"
  );
  eq(typingStart.userId, ctx.users.a.id, "typing actor");
  ok(Date.parse(typingStart.expiresAt) > Date.now(), "typing expiry must be in the future");

  // The per-connection/per-chat typing throttle is 800ms.
  await sleep(900);
  clientA.send({ type: "typing.stop", chatId });
  const typingStop = await clientB.waitFor(
    (frame) => frame.type === "typing.updated" && frame.chatId === chatId && frame.isTyping === false,
    options.timeoutMs,
    "B typing.updated stop"
  );
  eq(typingStop.userId, ctx.users.a.id, "typing stop actor");

  const aTypingEcho = realtime.a.frames.some(
    (frame) => frame.type === "typing.updated" && frame.chatId === chatId
  );
  eq(aTypingEcho, false, "typing must not echo to the originating connection");
  return "heartbeat.ack + typing.start/stop broadcast";
});

await step("realtime.reconnect-cursor", async () => {
  const a = need(ctx.tokens.a, "user A");
  const b = need(ctx.tokens.b, "user B");
  const chatId = need(ctx.ids.directChatId, "direct chat");
  const clientB = need(realtime.b, "B realtime socket");

  const cursorFrame = latestCursorFrame(clientB);
  ok(cursorFrame !== null, "B must have received at least one cursor frame");
  const appliedSequence = cursorFrame.sequence;
  const resumeCursor = cursorFrame.cursor;
  await clientB.close();
  realtime.b = null;

  // Offline durable event: the reconnecting client must recover it by replay.
  const offlineMessage = await sendMessage(
    a.accessToken,
    chatId,
    `Offline replay message ${searchNeedle}`,
    {}
  );
  ctx.ids.offlineMessageId = offlineMessage.id;

  const reconnected = await openAuthenticatedRealtime("B-reconnect", b.accessToken, resumeCursor);
  realtime.b = reconnected.client;
  eq(reconnected.ready.resumed, true, "scoped cursor resume flag");
  eq(reconnected.ready.resumeMode, "scoped_cursor", "scoped cursor resume mode");
  eq(reconnected.ready.sequence, appliedSequence, "ready.sequence must be the applied cursor sequence");
  between(
    reconnected.ready.headSequence,
    appliedSequence,
    Number.MAX_SAFE_INTEGER,
    "ready.headSequence replay target"
  );

  const checkpoint = await reconnected.client.waitFor(
    (frame) => frame.type === "sync.checkpoint",
    options.timeoutMs,
    "reconnect sync.checkpoint"
  );
  between(checkpoint.sequence, appliedSequence, Number.MAX_SAFE_INTEGER, "checkpoint sequence");

  const replayDispatches = reconnected.client.frames.filter((frame) => frame.type === "dispatch");
  const replayedMessageFrames = replayDispatches.filter(
    (frame) => frame.event.type === "message.created" &&
      frame.event.message.id === offlineMessage.id
  );
  eq(replayedMessageFrames.length, 1, "offline message must be replayed exactly once (no loss/duplication)");
  ok(
    replayDispatches.every((frame) => frame.sequence > appliedSequence),
    "replay must start strictly after the applied cursor"
  );
  const replaySequences = replayDispatches.map((frame) => frame.sequence);
  ok(
    replaySequences.every((sequence, index) => index === 0 || sequence > replaySequences[index - 1]),
    "replayed dispatch sequences must be strictly increasing and unique"
  );
  eq(replayedMessageFrames[0].event.message.body, offlineMessage.body, "replayed message body");
  includesString(replayedMessageFrames[0].cursor, "luxora-rt1.", "replayed dispatch cursor");

  // Live delivery continues after replay.
  const liveMessage = await sendMessage(a.accessToken, chatId, `Post-replay live ${searchNeedle}`, {});
  await reconnected.client.waitFor(
    (frame) => frame.type === "dispatch" &&
      frame.event.type === "message.created" &&
      frame.event.message.id === liveMessage.id,
    options.timeoutMs,
    "post-reconnect live message.created"
  );
  return `replayed ${replayDispatches.length} event(s) after seq ${appliedSequence}, live delivery resumed`;
});

await step("realtime.sync-required", async () => {
  const a = need(ctx.tokens.a, "user A");
  const client = await RealtimeClient.connect("A-tampered-cursor");
  const tampered = "luxora-rt1." + "A".repeat(60) + "." + "B".repeat(60);
  client.send({ type: "authenticate", accessToken: a.accessToken, resumeCursor: tampered });
  const ready = await client.waitFor((frame) => frame.type === "ready", options.timeoutMs, "ready");
  eq(ready.cursor, null, "unusable cursor ready must carry cursor=null");
  eq(ready.resumed, false, "unusable cursor must not claim resume");
  const required = await client.waitFor(
    (frame) => frame.type === "sync.required",
    options.timeoutMs,
    "sync.required"
  );
  eq(required.reason, "cursor_invalid", "deterministic recovery reason");
  eq(required.recovery.path, "/v2/sync/snapshot", "recovery snapshot path");
  const close = await client.waitClose(options.timeoutMs);
  eq(close.code, 4009, "sync.required close code");
  return "cursor_invalid -> sync.required -> close 4009";

  // Unreachable: the client is closed above.
});

await step("realtime.auth-failure", async () => {
  const client = await RealtimeClient.connect("bad-token");
  client.send({ type: "authenticate", accessToken: "invalid-token-value-that-is-long-enough" });
  const error = await client.waitFor((frame) => frame.type === "error", options.timeoutMs, "error frame");
  eq(error.code, "UNAUTHENTICATED", "realtime auth error code");
  const close = await client.waitClose(options.timeoutMs);
  eq(close.code, 4001, "realtime auth failure close code");
  return "invalid token -> error UNAUTHENTICATED -> close 4001";
});

await step("sync.snapshot", async () => {
  const a = need(ctx.tokens.a, "user A");
  const response = await api("GET", "/v2/sync/snapshot", { token: a.accessToken });
  expectStatus(response, 200, "GET /v2/sync/snapshot");
  const snapshot = json(response, "sync snapshot");
  eq(snapshot.contractVersion, 1, "snapshot contract version");
  eq(snapshot.scope, "account_session", "snapshot scope");
  includesString(snapshot.boundary.cursor, "luxora-rt1.", "boundary cursor prefix");
  eq(snapshot.reset.required, true, "reset required");
  ok(Array.isArray(snapshot.reset.collections) && snapshot.reset.collections.includes("messages"),
    "reset collections must include messages");
  eq(snapshot.resume.websocketPath, "/v2/realtime", "resume websocket path");
  eq(snapshot.resume.sequenceAdjacencyRequired, false, "sequence adjacency must not be required");
  includesString(
    (response.headers.get("cache-control") ?? "").toLowerCase(),
    "no-store",
    "snapshot must be no-store"
  );

  const chats = await api("GET", "/v2/sync/chats", { token: a.accessToken });
  expectStatus(chats, 200, "GET /v2/sync/chats");
  eq(chats.json.items.some((chat) => chat.id === ctx.ids.directChatId), true, "sync chat page");

  const blocks = await api("GET", "/v2/sync/blocks", { token: a.accessToken });
  expectStatus(blocks, 200, "GET /v2/sync/blocks");
  ok(Array.isArray(blocks.json.items), "sync block page");
  return `boundary seq ${snapshot.boundary.sequence}`;
});

// Close realtime sockets: the remaining steps are HTTP-only.
if (realtime.a !== null) await realtime.a.close();
if (realtime.b !== null) await realtime.b.close();

// --- search ----------------------------------------------------------------

await step("search.users", async () => {
  const a = need(ctx.tokens.a, "user A");
  const b = need(ctx.users.b, "user B");

  const known = await api("GET", `/v1/users/search?q=${encodeURIComponent(b.username)}`, {
    token: a.accessToken
  });
  expectStatus(known, 200, "GET /v1/users/search known");
  ok(known.json.items.some((user) => user.id === b.id), "accepted relationship must be searchable");

  const stranger = await api(
    "GET",
    `/v1/users/search?q=${encodeURIComponent(ctx.users.c.username)}`,
    { token: a.accessToken }
  );
  expectStatus(stranger, 200, "GET /v1/users/search stranger");
  eq(
    stranger.json.items.some((user) => user.id === ctx.users.c.id),
    false,
    "person search must be relationship scoped, not a global directory"
  );
  return "relationship-scoped person search";
});

await step("search.chats", async () => {
  const a = need(ctx.tokens.a, "user A");
  const b = need(ctx.users.b, "user B");
  const title = `QA Smoke Group ${runId}`;
  ctx.ids.groupTitle = title;

  const created = await api("POST", "/v1/chats", {
    token: a.accessToken,
    json: { kind: "group", title, memberIds: [b.id] }
  });
  expectStatus(created, 201, "create group chat");
  const group = created.json.chat;
  eq(group.kind, "group", "group kind");
  eq(group.title, title, "group title");
  eq(group.memberCount, 2, "group member count");
  eq(group.role, "owner", "creator is owner");
  ctx.ids.groupChatId = group.id;

  const found = await api("GET", `/v1/search/chats?q=${encodeURIComponent(`smoke group ${runId}`)}`, {
    token: a.accessToken
  });
  expectStatus(found, 200, "GET /v1/search/chats");
  ok(found.json.items.some((chat) => chat.id === group.id), "group title substring search");
  eq(found.json.items.every((chat) => chat.kind !== "direct"), true, "chat search must exclude DMs");

  const wildcard = await api("GET", "/v1/search/chats?q=%25", { token: a.accessToken });
  expectStatus(wildcard, 200, "LIKE wildcard literal search");
  eq(wildcard.json.items.length, 0, "LIKE wildcards must be escaped");
  return `group ${group.id} found by title substring`;
});

await step("search.messages", async () => {
  const a = need(ctx.tokens.a, "user A");
  const b = need(ctx.tokens.b, "user B");
  const directChatId = need(ctx.ids.directChatId, "direct chat");

  const found = await api("GET", `/v1/search/messages?q=${encodeURIComponent(searchNeedle)}`, {
    token: a.accessToken
  });
  expectStatus(found, 200, "GET /v1/search/messages");
  ok(
    found.json.items.some((message) => message.id === ctx.ids.message3),
    "server-side message search must find the indexed needle"
  );

  const filtered = await api(
    "GET",
    `/v1/search/messages?q=${encodeURIComponent(searchNeedle)}&chatId=${directChatId}`,
    { token: a.accessToken }
  );
  expectStatus(filtered, 200, "GET /v1/search/messages?chatId=");
  eq(filtered.json.items.every((message) => message.chatId === directChatId), true, "chat filter");

  // The group chat has no matching message, so B (a member there but not in the
  // DM page query) still only sees chats it belongs to through the DM.
  const bFound = await api("GET", `/v1/search/messages?q=${encodeURIComponent(searchNeedle)}`, {
    token: b.accessToken
  });
  expectStatus(bFound, 200, "B GET /v1/search/messages");
  ok(bFound.json.items.length > 0, "B must find messages in its own memberships");
  return `${found.json.items.length} matches for ${searchNeedle}`;
});

// --- uploads / media -------------------------------------------------------

await step("uploads.create-chunk-complete", async () => {
  const a = need(ctx.tokens.a, "user A");
  const width = 400;
  const height = 300;
  const png = makePng(width, height);
  const digest = sha256Hex(png);
  ctx.ids.pngBytes = png;
  ctx.ids.pngSha256 = digest;

  const created = await api("POST", "/v1/uploads", {
    token: a.accessToken,
    json: {
      kind: "image",
      fileName: `qa-smoke-${runId}.png`,
      mimeType: "image/png",
      sizeBytes: png.length,
      sha256: digest,
      idempotencyKey: randomUUID(),
      metadata: {}
    }
  });
  expectStatus(created, 201, "create upload session");
  const upload = created.json.upload;
  eq(upload.status, "active", "upload status");
  eq(upload.sizeBytes, png.length, "upload size echo");
  ok(upload.chunkSizeBytes > 0, "upload chunk size");
  ok(upload.receivedBytes === 0, "fresh upload has no bytes");
  ctx.ids.uploadId = upload.id;

  const chunkCount = Math.ceil(png.length / upload.chunkSizeBytes);
  for (let index = 0; index < chunkCount; index += 1) {
    const start = index * upload.chunkSizeBytes;
    const end = Math.min(start + upload.chunkSizeBytes, png.length) - 1;
    const chunk = png.subarray(start, end + 1);
    const chunkResponse = await api("PUT", `/v1/uploads/${upload.id}/chunks/${index}`, {
      token: a.accessToken,
      bytes: chunk,
      headers: {
        "content-type": "application/octet-stream",
        "content-range": `bytes ${start}-${end}/${png.length}`,
        "x-chunk-sha256": sha256Hex(chunk)
      }
    });
    expectStatus(chunkResponse, 200, `upload chunk ${index}`);
    eq(chunkResponse.json.upload.receivedBytes, end + 1, `received bytes after chunk ${index}`);
  }

  const complete = await api("POST", `/v1/uploads/${upload.id}/complete`, {
    token: a.accessToken,
    json: {}
  });
  expectStatus(complete, 200, "complete upload");
  const completed = complete.json.upload;
  eq(completed.status, "completed", "completed upload status");
  ok(completed.attachment !== null, "completed upload must expose an attachment");
  const attachment = completed.attachment;
  eq(attachment.kind, "image", "attachment kind");
  eq(attachment.sha256, digest, "attachment sha256");
  eq(attachment.sizeBytes, png.length, "attachment size");
  eq(attachment.metadata.width, width, "server measured image width");
  eq(attachment.metadata.height, height, "server measured image height");
  eq(attachment.metadataTrust, "server_verified", "image metadata trust");
  ok(attachment.thumbnailPath !== undefined, "image larger than 320px must get a thumbnail path");
  ctx.ids.attachmentId = attachment.id;
  ctx.ids.attachment = attachment;
  return `upload ${upload.id} -> attachment ${attachment.id} (${png.length} bytes)`;
});

await step("uploads.content-range-thumbnail", async () => {
  const a = need(ctx.tokens.a, "user A");
  const b = need(ctx.tokens.b, "user B");
  const c = need(ctx.tokens.c, "user C");
  const attachmentId = need(ctx.ids.attachmentId, "attachment");
  const png = need(ctx.ids.pngBytes, "generated png");

  const content = await api("GET", `/v1/attachments/${attachmentId}/content`, {
    token: a.accessToken
  });
  expectStatus(content, 200, "owner attachment content");
  ok(content.bytes !== null, "attachment content must be binary");
  eq(content.bytes.length, png.length, "attachment content length");
  eq(sha256Hex(content.bytes), ctx.ids.pngSha256, "attachment content digest");
  eq(content.headers.get("etag"), `"${ctx.ids.pngSha256}"`, "attachment ETag");
  eq(content.headers.get("accept-ranges"), "bytes", "attachment accept-ranges");
  includesString(
    (content.headers.get("cache-control") ?? "").toLowerCase(),
    "private",
    "attachment content cache policy"
  );
  eq(content.headers.get("x-content-type-options"), "nosniff", "attachment sniffing protection");

  const range = await api("GET", `/v1/attachments/${attachmentId}/content`, {
    token: a.accessToken,
    headers: { range: "bytes=0-9" }
  });
  expectStatus(range, 206, "attachment byte range");
  eq(range.bytes.length, 10, "range response length");
  eq(range.headers.get("content-range"), `bytes 0-9/${png.length}`, "content-range header");
  eq(range.bytes.equals(png.subarray(0, 10)), true, "range bytes must match the source");

  const thumbnail = await api("GET", `/v1/attachments/${attachmentId}/thumbnail`, {
    token: a.accessToken
  });
  expectStatus(thumbnail, 200, "attachment thumbnail");
  eq(thumbnail.headers.get("content-type"), "image/jpeg", "thumbnail content type");
  ok(thumbnail.bytes.length > 0, "thumbnail must not be empty");
  ok(thumbnail.bytes[0] === 0xff && thumbnail.bytes[1] === 0xd8, "thumbnail must be JPEG");
  includesString(
    (thumbnail.headers.get("cache-control") ?? "").toLowerCase(),
    "no-store",
    "thumbnail cache policy"
  );

  const strangerContent = await api("GET", `/v1/attachments/${attachmentId}/content`, {
    token: c.accessToken
  });
  expectStatus(strangerContent, 404, "stranger attachment content");
  expectErrorCode(strangerContent, "NOT_FOUND", "stranger attachment content");

  const anonymousContent = await api("GET", `/v1/attachments/${attachmentId}/content`);
  expectStatus(anonymousContent, 401, "anonymous attachment content");
  expectErrorCode(anonymousContent, "UNAUTHENTICATED", "anonymous attachment content");
  return "content + 206 range + JPEG thumbnail + stranger/anonymous denial";
});

await step("media.message", async () => {
  const a = need(ctx.tokens.a, "user A");
  const b = need(ctx.tokens.b, "user B");
  const chatId = need(ctx.ids.directChatId, "direct chat");
  const attachmentId = need(ctx.ids.attachmentId, "attachment");

  const message = await sendMessage(a.accessToken, chatId, null, { attachmentIds: [attachmentId] });
  eq(message.kind, "media", "media message kind");
  eq(message.attachments.length, 1, "media message attachment count");
  eq(message.attachments[0].id, attachmentId, "media message attachment id");
  ctx.ids.mediaMessageId = message.id;

  // A current chat member receives a message-derived download grant.
  const memberContent = await api("GET", `/v1/attachments/${attachmentId}/content`, {
    token: b.accessToken
  });
  expectStatus(memberContent, 200, "member attachment content grant");
  eq(sha256Hex(memberContent.bytes), ctx.ids.pngSha256, "granted content digest");

  const memberThumbnail = await api("GET", `/v1/attachments/${attachmentId}/thumbnail`, {
    token: b.accessToken
  });
  expectStatus(memberThumbnail, 200, "member thumbnail grant");

  // Search tokens are whole hyphenated words, so query the full file-name token.
  const files = await api("GET", `/v1/search/files?q=${encodeURIComponent(`qa-smoke-${runId}`)}`, {
    token: a.accessToken
  });
  expectStatus(files, 200, "attachment file search");
  const fileIds = files.json.items.map((item) => item.id);
  ok(
    fileIds.includes(attachmentId),
    `owned attachment file search must include ${attachmentId} (got ${JSON.stringify(fileIds)})`
  );
  return `media message ${message.id} delivered with attachment grant`;
});

// --- calls -----------------------------------------------------------------

await step("calls.signaling", async () => {
  const a = need(ctx.tokens.a, "user A");
  const b = need(ctx.tokens.b, "user B");
  const c = need(ctx.tokens.c, "user C");
  const chatId = need(ctx.ids.directChatId, "direct chat");

  const createNonce = randomUUID();
  const created = await api("POST", "/v1/calls", {
    token: a.accessToken,
    json: { chatId, mediaMode: "audio", clientNonce: createNonce }
  });
  expectStatus(created, 201, "create call");
  const call = created.json.call;
  eq(call.chatId, chatId, "call chat id");
  eq(call.kind, "one_to_one", "direct call kind");
  eq(call.mediaMode, "audio", "call media mode");
  eq(call.state, "created", "call initial state");
  eq(created.json.replayed, false, "call not replayed");
  eq(created.json.unreachableMemberIds.length, 0, "B has a live session");
  ok(Array.isArray(call.participants), "call participants must be an array");
  noKeys(call, ["roomName", "deviceId", "sessionId", "livekitToken"], "call projection");
  ctx.ids.callId = call.callId;

  const replay = await api("POST", "/v1/calls", {
    token: a.accessToken,
    json: { chatId, mediaMode: "audio", clientNonce: createNonce }
  });
  expectStatus(replay, 201, "call create nonce replay");
  eq(replay.json.call.callId, call.callId, "call nonce replay returns the same call");
  eq(replay.json.replayed, true, "call replay flag");

  const ring = await api("POST", `/v1/calls/${call.callId}/ring`, {
    token: a.accessToken,
    json: { expectedRevision: call.revision }
  });
  expectStatus(ring, 200, "ring call");
  eq(ring.json.call.state, "ringing", "ring state");
  const ringingRevision = ring.json.call.revision;

  const accept = await api("POST", `/v1/calls/${call.callId}/accept`, {
    token: b.accessToken,
    json: { expectedRevision: ringingRevision }
  });
  expectStatus(accept, 200, "B accepts call");
  eq(accept.json.call.state, "connecting", "accept state");
  const connectingRevision = accept.json.call.revision;

  const joinGrant = await api("POST", `/v1/calls/${call.callId}/join-grant`, {
    token: a.accessToken,
    json: { requestedSources: ["microphone"] }
  });
  expectStatus(joinGrant, 503, "join-grant without media plane");
  expectErrorCode(joinGrant, "SERVICE_UNAVAILABLE", "join-grant without media plane");

  const strangerCall = await api("GET", `/v1/calls/${call.callId}`, { token: c.accessToken });
  expectStatus(strangerCall, 404, "stranger call read");
  expectErrorCode(strangerCall, "NOT_FOUND", "stranger call read");

  const hangup = await api("POST", `/v1/calls/${call.callId}/hangup`, {
    token: a.accessToken,
    json: { expectedRevision: connectingRevision, scope: "everyone" }
  });
  expectStatus(hangup, 200, "hangup call");
  eq(hangup.json.call.state, "ended", "hangup ends the call");

  // Decline path on a fresh call.
  const second = await api("POST", "/v1/calls", {
    token: a.accessToken,
    json: { chatId, mediaMode: "video", clientNonce: randomUUID() }
  });
  expectStatus(second, 201, "create second call");
  const secondCall = second.json.call;
  const secondRing = await api("POST", `/v1/calls/${secondCall.callId}/ring`, {
    token: a.accessToken,
    json: { expectedRevision: secondCall.revision }
  });
  expectStatus(secondRing, 200, "ring second call");
  const decline = await api("POST", `/v1/calls/${secondCall.callId}/decline`, {
    token: b.accessToken,
    json: { expectedRevision: secondRing.json.call.revision, reason: "declined" }
  });
  expectStatus(decline, 200, "B declines call");
  eq(decline.json.call.state, "ended", "decline ends a 1:1 call");
  eq(decline.json.call.endReason, "declined", "decline end reason");

  const listing = await api("GET", `/v1/calls?chatId=${chatId}`, { token: b.accessToken });
  expectStatus(listing, 200, "GET /v1/calls?chatId=");
  ok(listing.json.calls.length >= 2, "call history must list both calls");
  const listed = listing.json.calls.find((entry) => entry.callId === call.callId);
  ok(listed !== undefined, "first call must be in history");
  eq(listed.state, "ended", "ended call retained for missed-call history");

  const missingChat = await api("GET", "/v1/calls", { token: a.accessToken });
  expectStatus(missingChat, 400, "calls list without chatId");
  return `call ${call.callId} create/ring/accept/503/hangup + decline + list`;
});

// --- folders ---------------------------------------------------------------

await step("folders.crud", async () => {
  const a = need(ctx.tokens.a, "user A");
  const groupChatId = need(ctx.ids.groupChatId, "group chat");

  const initial = await api("GET", "/v1/chat-folders", { token: a.accessToken });
  expectStatus(initial, 200, "GET /v1/chat-folders");
  eq(initial.json.items.length, 0, "fresh account has no folders");
  eq(initial.json.stateRevision, 0, "fresh folder state revision");

  const rules = { includeKinds: ["direct", "group"], unreadOnly: false, excludeMuted: false, includeArchived: false };
  const folderNonce = randomUUID();
  const create1 = await api("POST", "/v1/chat-folders", {
    token: a.accessToken,
    json: { title: `Priority ${runId}`, rules, overrides: [], clientNonce: folderNonce }
  });
  expectStatus(create1, 201, "create folder 1");
  const folder1 = create1.json.folder;
  eq(folder1.position, 0, "first folder position");
  eq(folder1.revision, 1, "created folder revision");
  eq(create1.json.stateRevision, 1, "state revision after first create");
  eq(create1.json.replayed, false, "create not replayed");

  const replay = await api("POST", "/v1/chat-folders", {
    token: a.accessToken,
    json: { title: `Priority ${runId}`, rules, overrides: [], clientNonce: folderNonce }
  });
  expectStatus(replay, 201, "folder create nonce replay");
  eq(replay.json.replayed, true, "replayed folder flag");
  eq(replay.json.folder.id, folder1.id, "replayed folder id");
  eq(replay.json.stateRevision, 1, "replay must not advance state revision");

  const create2 = await api("POST", "/v1/chat-folders", {
    token: a.accessToken,
    json: {
      title: `Group focus ${runId}`,
      rules,
      overrides: [{ chatId: groupChatId, mode: "include", pinnedPosition: 0 }],
      clientNonce: randomUUID()
    }
  });
  expectStatus(create2, 201, "create folder 2");
  const folder2 = create2.json.folder;
  eq(folder2.position, 1, "second folder position");
  eq(create2.json.stateRevision, 2, "state revision after second create");
  eq(folder2.overrides.length, 1, "folder override persisted");

  const patch = await api("PATCH", `/v1/chat-folders/${folder1.id}`, {
    token: a.accessToken,
    json: { title: `Priority renamed ${runId}`, expectedRevision: folder1.revision, clientNonce: randomUUID() }
  });
  expectStatus(patch, 200, "patch folder 1");
  eq(patch.json.folder.revision, 2, "patch bumps folder revision");
  eq(patch.json.folder.title, `Priority renamed ${runId}`, "patched title");
  eq(patch.json.stateRevision, 3, "state revision after patch");

  const stalePatch = await api("PATCH", `/v1/chat-folders/${folder1.id}`, {
    token: a.accessToken,
    json: { title: "stale", expectedRevision: 1, clientNonce: randomUUID() }
  });
  expectStatus(stalePatch, 409, "stale folder revision");
  expectErrorCode(stalePatch, "CONFLICT", "stale folder revision");

  const badOverride = await api("PATCH", `/v1/chat-folders/${folder2.id}`, {
    token: a.accessToken,
    json: {
      overrides: [{ chatId: randomUUID(), mode: "include", pinnedPosition: null }],
      expectedRevision: folder2.revision,
      clientNonce: randomUUID()
    }
  });
  expectStatus(badOverride, 400, "override with foreign chat");
  expectErrorCode(badOverride, "BAD_REQUEST", "override with foreign chat");

  ctx.ids.folder1Id = folder1.id;
  ctx.ids.folder2Id = folder2.id;
  return `folders ${folder1.id}, ${folder2.id}, stateRevision 3`;
});

await step("folders.reorder-delete", async () => {
  const a = need(ctx.tokens.a, "user A");
  const folder1Id = need(ctx.ids.folder1Id, "folder 1");
  const folder2Id = need(ctx.ids.folder2Id, "folder 2");

  const list = await api("GET", "/v1/chat-folders", { token: a.accessToken });
  expectStatus(list, 200, "GET folders before reorder");
  const currentRevision = list.json.stateRevision;
  const folder1 = list.json.items.find((folder) => folder.id === folder1Id);
  const folder2 = list.json.items.find((folder) => folder.id === folder2Id);
  ok(folder1 !== undefined && folder2 !== undefined, "both folders must be listed");

  const reorder = await api("PUT", "/v1/chat-folders/order", {
    token: a.accessToken,
    json: {
      folderIds: [folder2Id, folder1Id],
      expectedStateRevision: currentRevision,
      clientNonce: randomUUID()
    }
  });
  expectStatus(reorder, 200, "reorder folders");
  eq(reorder.json.items[0].id, folder2Id, "reorder first folder");
  eq(reorder.json.items[0].position, 0, "reorder position 0");
  eq(reorder.json.items[1].id, folder1Id, "reorder second folder");
  eq(reorder.json.stateRevision, currentRevision + 1, "state revision after reorder");

  const staleReorder = await api("PUT", "/v1/chat-folders/order", {
    token: a.accessToken,
    json: {
      folderIds: [folder2Id, folder1Id],
      expectedStateRevision: currentRevision,
      clientNonce: randomUUID()
    }
  });
  expectStatus(staleReorder, 409, "stale reorder state revision");
  expectErrorCode(staleReorder, "CONFLICT", "stale reorder state revision");

  const currentFolder1 = reorder.json.items.find((folder) => folder.id === folder1Id);
  const remove = await api("DELETE", `/v1/chat-folders/${folder1Id}`, {
    token: a.accessToken,
    json: { expectedRevision: currentFolder1.revision, clientNonce: randomUUID() }
  });
  expectStatus(remove, 200, "delete folder 1");
  eq(remove.json.folderId, folder1Id, "deleted folder id");
  eq(remove.json.stateRevision, reorder.json.stateRevision + 1, "state revision after delete");

  const finalList = await api("GET", "/v1/chat-folders", { token: a.accessToken });
  expectStatus(finalList, 200, "GET folders after delete");
  eq(finalList.json.items.length, 1, "one folder remains");
  eq(finalList.json.items[0].id, folder2Id, "remaining folder id");
  eq(finalList.json.items[0].position, 0, "remaining folder position compacted");
  eq(finalList.json.stateRevision, remove.json.stateRevision, "final state revision");

  const foreign = await api("PATCH", `/v1/chat-folders/${randomUUID()}`, {
    token: a.accessToken,
    json: { title: "ghost", expectedRevision: 1, clientNonce: randomUUID() }
  });
  expectStatus(foreign, 404, "patch missing folder");
  expectErrorCode(foreign, "NOT_FOUND", "patch missing folder");
  return `reorder -> delete -> stateRevision ${finalList.json.stateRevision}`;
});

// --- preferences -----------------------------------------------------------

await step("preferences.archive-mute", async () => {
  const a = need(ctx.tokens.a, "user A");
  const b = need(ctx.tokens.b, "user B");
  const chatId = need(ctx.ids.directChatId, "direct chat");

  const initial = await api("GET", `/v1/chats/${chatId}/preferences`, { token: a.accessToken });
  expectStatus(initial, 200, "GET chat preferences");
  eq(initial.json.preferences.archivedAt, null, "initial archivedAt");
  eq(initial.json.preferences.mutedUntil, null, "initial mutedUntil");

  const archived = await api("PATCH", `/v1/chats/${chatId}/preferences`, {
    token: a.accessToken,
    json: { archived: true }
  });
  expectStatus(archived, 200, "archive chat");
  ok(archived.json.preferences.archivedAt !== null, "archivedAt set");
  const archivedAt = archived.json.preferences.archivedAt;

  const mutedUntil = isoNow(60 * 60 * 1000);
  const muted = await api("PATCH", `/v1/chats/${chatId}/preferences`, {
    token: a.accessToken,
    json: { mutedUntil }
  });
  expectStatus(muted, 200, "mute chat");
  eq(muted.json.preferences.mutedUntil, mutedUntil, "mutedUntil set");
  eq(muted.json.preferences.archivedAt, archivedAt, "mute must not reset archive");

  const otherMember = await api("GET", `/v1/chats/${chatId}/preferences`, { token: b.accessToken });
  expectStatus(otherMember, 200, "B chat preferences");
  eq(otherMember.json.preferences.archivedAt, null, "preferences are per account");

  const cleared = await api("PATCH", `/v1/chats/${chatId}/preferences`, {
    token: a.accessToken,
    json: { archived: false, mutedUntil: null }
  });
  expectStatus(cleared, 200, "clear chat preferences");
  eq(cleared.json.preferences.archivedAt, null, "archivedAt cleared");
  eq(cleared.json.preferences.mutedUntil, null, "mutedUntil cleared");
  return "archive/mute partial updates are independent and account scoped";
});

// --- data export -----------------------------------------------------------

await step("exports.data-export", async () => {
  const a = need(ctx.tokens.a, "user A");
  const c = need(ctx.tokens.c, "user C");

  const requested = await api("POST", "/v1/data-exports", {
    token: a.accessToken,
    json: {}
  });
  expectStatus(requested, 201, "request data export");
  let record = requested.json.dataExport;
  ok(isUuid(record.id), "export record id");

  // Asynchronous queue (or synchronous build): poll until it leaves pending.
  const pollDeadline = Date.now() + 60_000;
  while (record.state === "pending") {
    if (Date.now() > pollDeadline) throw new Error("data export did not become ready within 60s");
    await sleep(250);
    const status = await api("GET", `/v1/data-exports/${record.id}`, { token: a.accessToken });
    expectStatus(status, 200, "poll data export");
    record = status.json.dataExport;
  }
  eq(record.state, "ready", "data export state");
  ok(record.sizeBytes > 0, "data export size");
  eq(typeof record.sha256, "string", "data export sha256");
  eq(record.sha256.length, 64, "data export sha256 length");
  ok(record.expiresAt !== null && Date.parse(record.expiresAt) > Date.now(), "data export expiry");
  ctx.ids.exportId = record.id;

  // Idempotent repeat request reuses the ready export.
  const repeated = await api("POST", "/v1/data-exports", { token: a.accessToken, json: {} });
  expectStatus(repeated, 201, "repeat data export request");
  eq(repeated.json.dataExport.id, record.id, "ready export is reused");

  const download = await api("GET", `/v1/data-exports/${record.id}/download`, {
    token: a.accessToken
  });
  expectStatus(download, 200, "download data export");
  eq(download.headers.get("content-type"), "application/gzip", "export content type");
  eq(download.headers.get("etag"), `"${record.sha256}"`, "export ETag equals sha256");
  eq(download.headers.get("accept-ranges"), "bytes", "export accept-ranges");
  includesString(
    (download.headers.get("cache-control") ?? "").toLowerCase(),
    "private",
    "export cache policy"
  );
  eq(download.bytes.length, record.sizeBytes, "export size matches record");
  eq(sha256Hex(download.bytes), record.sha256, "export bytes match record sha256");
  eq(download.bytes[0], 0x1f, "export gzip magic byte 0");
  eq(download.bytes[1], 0x8b, "export gzip magic byte 1");

  const range = await api("GET", `/v1/data-exports/${record.id}/download`, {
    token: a.accessToken,
    headers: { range: "bytes=0-15" }
  });
  expectStatus(range, 206, "export byte range");
  eq(range.bytes.length, 16, "export range length");
  eq(range.headers.get("content-range"), `bytes 0-15/${record.sizeBytes}`, "export content-range");
  eq(range.bytes.equals(download.bytes.subarray(0, 16)), true, "export range bytes match full body");

  const stranger = await api("GET", `/v1/data-exports/${record.id}`, { token: c.accessToken });
  expectStatus(stranger, 404, "stranger export status");
  expectErrorCode(stranger, "NOT_FOUND", "stranger export status");
  const strangerDownload = await api("GET", `/v1/data-exports/${record.id}/download`, {
    token: c.accessToken
  });
  expectStatus(strangerDownload, 404, "stranger export download");
  return `export ${record.id} ready (${record.sizeBytes} bytes, sha256 ${record.sha256.slice(0, 12)}…)`;
});

// --- account deletion ------------------------------------------------------

await step("deletion.schedule-cancel", async () => {
  const a = need(ctx.tokens.a, "user A");
  const c = need(ctx.tokens.c, "user C");

  const scheduled = await api("POST", "/v1/account/deletion", { token: c.accessToken, json: {} });
  expectStatus(scheduled, 201, "schedule account deletion");
  const record = scheduled.json.deletion;
  eq(record.accountId, ctx.users.c.id, "deletion account id");
  eq(record.state, "scheduled", "deletion state");
  ok(record.scheduledAt !== null, "scheduledAt set");
  ok(record.graceDeadlineAt !== null, "graceDeadlineAt set");
  const graceMs = Date.parse(record.graceDeadlineAt) - Date.now();
  ok(graceMs > 6 * 24 * 60 * 60 * 1000, "grace period must be about seven days");

  const rescheduled = await api("POST", "/v1/account/deletion", { token: c.accessToken, json: {} });
  expectStatus(rescheduled, 201, "re-schedule account deletion");
  eq(rescheduled.json.deletion.state, "scheduled", "re-schedule state");
  eq(rescheduled.json.deletion.scheduledAt, record.scheduledAt, "re-schedule is idempotent");

  const status = await api("GET", "/v1/account/deletion", { token: c.accessToken });
  expectStatus(status, 200, "GET account deletion");
  eq(status.json.deletion.state, "scheduled", "status reflects scheduled deletion");

  const canceled = await api("DELETE", "/v1/account/deletion", { token: c.accessToken });
  expectStatus(canceled, 200, "cancel account deletion");
  eq(canceled.json.deletion.state, "none", "cancel returns account to active");
  ok(canceled.json.deletion.canceledAt !== null, "canceledAt set");

  const afterCancel = await api("GET", "/v1/account/deletion", { token: c.accessToken });
  expectStatus(afterCancel, 200, "GET deletion after cancel");
  eq(afterCancel.json.deletion.state, "none", "deletion canceled");
  // The canceled record is deleted so the active account reports the synthetic
  // "none" projection; only the DELETE response itself carries canceledAt.

  const nothingToCancel = await api("DELETE", "/v1/account/deletion", { token: a.accessToken });
  expectStatus(nothingToCancel, 404, "cancel without schedule");
  expectErrorCode(nothingToCancel, "NOT_FOUND", "cancel without schedule");

  // The account must remain usable after canceling (deletion never executed).
  const me = await api("GET", "/v1/me", { token: c.accessToken });
  expectStatus(me, 200, "canceled account remains active");
  return "scheduled -> idempotent re-schedule -> canceled (never executed)";
});

// --- authorization spot checks --------------------------------------------

await step("authz.anonymous", async () => {
  const chatId = need(ctx.ids.directChatId, "direct chat");
  const messageId = need(ctx.ids.message3, "message 3");

  const cases = [
    ["GET", "/v1/me"],
    ["GET", "/v1/chats"],
    [`GET`, `/v1/chats/${chatId}/messages`],
    ["GET", "/v1/chat-folders"],
    ["GET", "/v1/notifications/settings"],
    ["GET", "/v2/sync/snapshot"],
    ["POST", `/v1/chats/${chatId}/messages`],
    ["PATCH", `/v1/messages/${messageId}`],
    ["GET", `/v1/messages/${messageId}/reactions`]
  ];
  for (const [method, path] of cases) {
    const response = await api(method, path);
    expectStatus(response, 401, `anonymous ${method} ${path}`);
    expectErrorCode(response, "UNAUTHENTICATED", `anonymous ${method} ${path}`);
    includesString(
      (response.headers.get("cache-control") ?? "").toLowerCase(),
      "private",
      `anonymous ${path} cache policy`
    );
    const serialized = JSON.stringify(response.json);
    ok(!serialized.includes(options.baseUrl), `anonymous denial must not echo the base URL (${path})`);
    ok(!serialized.includes(ctx.users.a.username), `anonymous denial must not leak usernames (${path})`);
  }

  const garbage = await api("GET", "/v1/me", { token: "garbage.access.token" });
  expectStatus(garbage, 401, "invalid bearer token");
  expectErrorCode(garbage, "UNAUTHENTICATED", "invalid bearer token");
  return `${cases.length} protected routes reject anonymous callers`;
});

await step("authz.stranger-concealment", async () => {
  const c = need(ctx.tokens.c, "user C");
  const chatId = need(ctx.ids.directChatId, "direct chat");
  const groupChatId = need(ctx.ids.groupChatId, "group chat");
  const messageId = need(ctx.ids.message3, "message 3");
  const attachmentId = need(ctx.ids.attachmentId, "attachment");
  const uploadId = need(ctx.ids.uploadId, "upload");
  const exportId = need(ctx.ids.exportId, "data export");
  const callId = need(ctx.ids.callId, "call");
  const chatCanary = ctx.users.b.displayName;

  // Standalone private objects: existing-foreign and random UUID must be
  // indistinguishable (status + public code + message).
  const pairs = [
    ["GET", `/v1/chats/${chatId}`, "GET chat"],
    ["GET", `/v1/messages/${messageId}/reactions`, "GET reactions"],
    ["GET", `/v1/messages/${messageId}/receipts`, "GET receipts"],
    ["GET", `/v1/uploads/${uploadId}`, "GET upload"],
    ["GET", `/v1/attachments/${attachmentId}/content`, "GET attachment"],
    ["GET", `/v1/data-exports/${exportId}`, "GET export"],
    ["GET", `/v1/calls/${callId}`, "GET call"],
    ["PATCH", `/v1/messages/${messageId}`, "PATCH message"],
    ["DELETE", `/v1/messages/${messageId}`, "DELETE message"]
  ];
  for (const [method, path, label] of pairs) {
    const existingPath = path;
    const randomPath = path
      .replace(chatId, randomUUID())
      .replace(groupChatId, randomUUID())
      .replace(messageId, randomUUID())
      .replace(attachmentId, randomUUID())
      .replace(uploadId, randomUUID())
      .replace(exportId, randomUUID())
      .replace(callId, randomUUID());
    const init = method === "PATCH" ? { json: { body: "intrusion" } } : {};
    const foreign = await api(method, existingPath, { token: c.accessToken, ...init });
    const random = await api(method, randomPath, { token: c.accessToken, ...init });
    ok(foreign.status >= 400, `${label}: stranger must be denied`);
    eq(
      denialFingerprint(foreign),
      denialFingerprint(random),
      `${label}: existing-foreign and random UUID must be indistinguishable`
    );
    const serialized = JSON.stringify(foreign.json);
    ok(!serialized.includes(chatCanary), `${label}: denial must not leak the peer display name`);
    ok(!serialized.includes(searchNeedle), `${label}: denial must not leak message content`);
  }

  // Outer-chat membership denials are uniform 403 for collection/nested routes.
  const foreignMessages = await api("GET", `/v1/chats/${chatId}/messages`, { token: c.accessToken });
  expectStatus(foreignMessages, 403, "stranger chat messages");
  expectErrorCode(foreignMessages, "FORBIDDEN", "stranger chat messages");
  const randomMessages = await api("GET", `/v1/chats/${randomUUID()}/messages`, { token: c.accessToken });
  expectStatus(randomMessages, 403, "random chat messages");
  eq(
    denialFingerprint(foreignMessages),
    denialFingerprint(randomMessages),
    "foreign and random outer chat ids must share one denial"
  );

  const strangerSend = await api("POST", `/v1/chats/${chatId}/messages`, {
    token: c.accessToken,
    json: { body: "intrusion", clientNonce: randomUUID() }
  });
  expectStatus(strangerSend, 403, "stranger send message");
  expectErrorCode(strangerSend, "FORBIDDEN", "stranger send message");

  // Blocked/missing nested message ids must not mutate chat state.
  const readForeign = await api("POST", `/v1/chats/${chatId}/read`, {
    token: c.accessToken,
    json: { messageId }
  });
  expectStatus(readForeign, 403, "stranger read receipt");

  const messagesAfter = await api("GET", `/v1/chats/${chatId}/messages?limit=50`, {
    token: ctx.tokens.a.accessToken
  });
  expectStatus(messagesAfter, 200, "owner message list after intrusions");
  ok(
    !messagesAfter.json.items.some((message) => message.body === "intrusion"),
    "denied mutations must not create messages"
  );
  return `${pairs.length} foreign/random denial pairs are indistinguishable`;
});

await step("authz.blocks", async () => {
  const a = need(ctx.tokens.a, "user A");
  const c = need(ctx.tokens.c, "user C");

  const block = await api("PUT", `/v1/blocks/${ctx.users.a.id}`, { token: c.accessToken });
  expectStatus(block, 200, "C blocks A");
  eq(block.json.accountId, ctx.users.a.id, "blocked account id");
  eq(block.json.blocked, true, "block flag");

  const blocks = await api("GET", "/v1/blocks", { token: c.accessToken });
  expectStatus(blocks, 200, "C block list");
  ok(blocks.json.items.some((item) => item.accountId === ctx.users.a.id), "block list entry");

  // Either-direction block hides exact lookup from the target.
  const lookupBlocked = await api(
    "GET",
    `/v1/users/lookup?username=${encodeURIComponent(ctx.users.c.username)}`,
    { token: a.accessToken }
  );
  expectStatus(lookupBlocked, 200, "lookup while blocked");
  eq(lookupBlocked.json.profile, null, "blocked target must not be discoverable");

  const unblock = await api("DELETE", `/v1/blocks/${ctx.users.a.id}`, { token: c.accessToken });
  expectStatus(unblock, 200, "C unblocks A");
  eq(unblock.json.blocked, false, "unblock flag");
  const cleared = await api("GET", "/v1/blocks", { token: c.accessToken });
  expectStatus(cleared, 200, "C block list after unblock");
  eq(cleared.json.items.length, 0, "block list cleared");
  return "directed block hides lookup, unblock restores";
});

await step("authz.admin", async () => {
  const noToken = await api("GET", "/v1/admin/status");
  if (noToken.status === 503) {
    expectErrorCode(noToken, "SERVICE_UNAVAILABLE", "admin unconfigured");
    if (options.expectAdmin === "configured") {
      throw new Error("admin surface is disabled but --expect-admin=configured was requested");
    }
    return "admin surface disabled: 503 SERVICE_UNAVAILABLE without a token";
  }
  if (options.expectAdmin === "unconfigured") {
    throw new Error("admin surface is configured but --expect-admin=unconfigured was requested");
  }
  expectStatus(noToken, 401, "admin without token");
  expectErrorCode(noToken, "UNAUTHENTICATED", "admin without token");

  const wrongToken = await api("GET", "/v1/admin/status", { token: "x".repeat(64) });
  expectStatus(wrongToken, 401, "admin with wrong token");
  expectErrorCode(wrongToken, "UNAUTHENTICATED", "admin with wrong token");

  const tokenFile = need(adminTokenFile, "admin token file");
  ok(existsSync(tokenFile), `admin token file must exist: ${tokenFile}`);
  const adminToken = readFileSync(tokenFile, "utf8").trim();
  ok(adminToken.length >= 32, "admin token must be at least 32 characters");
  ctx.adminToken = adminToken;

  const status = await api("GET", "/v1/admin/status", { token: adminToken });
  expectStatus(status, 200, "admin status");
  const statusBody = json(status, "admin status");
  hasKeys(
    statusBody,
    [
      "migrationId",
      "users",
      "activeSessions",
      "chatsByKind",
      "messages",
      "phoneIdentities",
      "pendingOutbox",
      "failedOutbox"
    ],
    "admin status"
  );
  ok(statusBody.users >= 3, "admin status must count the smoke users");
  eq(statusBody.failedOutbox, 0, "admin status must report no failed outbox rows");
  includesString(
    (status.headers.get("cache-control") ?? "").toLowerCase(),
    "private",
    "admin status cache policy"
  );
  const statusSerialized = JSON.stringify(statusBody);
  ok(!statusSerialized.includes(adminToken), "admin status must not echo the admin token");

  const users = await api("GET", "/v1/admin/users?limit=100", { token: adminToken });
  expectStatus(users, 200, "admin users");
  const smokeUserRows = users.json.items.filter((item) => item.username.startsWith("qa_"));
  ok(smokeUserRows.length >= 3, "admin users page must include the smoke accounts");
  for (const row of smokeUserRows) {
    noKeys(
      row,
      ["phoneNumber", "phone", "passwordHash", "passwordDigest", "refreshToken", "accessToken", "linkSecret"],
      "admin user row"
    );
  }
  const serializedUsers = JSON.stringify(users.json);
  ok(!serializedUsers.includes(adminToken), "admin users must not echo the admin token");

  const chats = await api("GET", "/v1/admin/chats?limit=100", { token: adminToken });
  expectStatus(chats, 200, "admin chats");
  ok(
    chats.json.items.some((chat) => chat.id === ctx.ids.directChatId),
    "admin chats page must include the smoke direct chat"
  );
  return `admin configured: ${statusBody.users} users, ${statusBody.messages} messages, ` +
    `${statusBody.failedOutbox} failed outbox`;
});

// --- device links ----------------------------------------------------------

await step("device-links.lifecycle", async () => {
  const created = await api("POST", "/v1/device-links/challenges", {
    json: { targetLabel: "QA smoke link" }
  });
  expectStatus(created, 201, "create device link challenge");
  const challenge = created.json;
  ok(isUuid(challenge.linkId), "device link id");
  ok(/^[0-9a-f]{64}$/u.test(challenge.linkSecret), "device link secret shape");
  ctx.secrets.linkSecrets.push(challenge.linkSecret);
  eq(challenge.pollIntervalMs, 2000, "device link poll interval");

  const poll = await api("POST", `/v1/device-links/challenges/${challenge.linkId}/poll`, {
    json: { linkSecret: challenge.linkSecret }
  });
  expectStatus(poll, 200, "poll device link");
  eq(poll.json.challenge.state, "pending", "pending link state");
  eq(poll.json.challenge.sasWords, null, "unapproved link has no SAS words");

  const secretless = await api("POST", `/v1/device-links/challenges/${challenge.linkId}/poll`, {
    json: {}
  });
  expectStatus(secretless, 401, "secretless device link poll");
  expectErrorCode(secretless, "UNAUTHENTICATED", "secretless device link poll");

  const closed = await api("POST", `/v1/device-links/challenges/${challenge.linkId}/close`, {
    json: { linkSecret: challenge.linkSecret }
  });
  expectStatus(closed, 200, "close device link");
  eq(closed.json.challenge.state, "closed", "closed link state");
  return `link ${challenge.linkId} pending -> closed, secret never echoed`;
});

// --- secret leak scan ------------------------------------------------------

await step("secrets.server-log", async () => {
  const logPath = need(serverLogPath, "server log file (pass --server-log)");
  ok(existsSync(logPath), `server log file must exist: ${logPath}`);
  const logText = readFileSync(logPath, "utf8");
  ok(logText.length > 0, "captured server log must not be empty");

  const canaries = [];
  const addCanary = (label, value) => {
    if (typeof value === "string" && value.length >= 6) canaries.push({ label, value });
  };

  if (serverEnvPath !== null && existsSync(serverEnvPath)) {
    for (const line of readFileSync(serverEnvPath, "utf8").split(/\r?\n/u)) {
      const match = /^([A-Z0-9_]+)=(.*)$/u.exec(line.trim());
      if (match === null) continue;
      addCanary(`env:${match[1]}`, match[2]);
    }
  }
  addCanary("admin-token", ctx.adminToken);
  for (const token of ctx.secrets.refreshTokens) addCanary("refresh-token", token);
  for (const secret of ctx.secrets.linkSecrets) addCanary("device-link-secret", secret);

  const leaked = canaries.filter((canary) => logText.includes(canary.value));
  ok(
    leaked.length === 0,
    `server log leaked secret material: ${leaked.map((canary) => canary.label).join(", ")}`
  );
  // Bearer authorization headers must be redacted if request logging is on.
  ok(!/Bearer\s+eyJ[A-Za-z0-9_-]{10,}/u.test(logText), "server log must not contain raw bearer tokens");
  return `${canaries.length} secret canaries absent from ${logPath} (${logText.length} bytes scanned)`;
});

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

const failed = results.filter((result) => result.status === "FAIL");
const passed = results.filter((result) => result.status === "PASS");
const skipped = results.filter((result) => result.status === "SKIP");
const durationMs = Date.now() - startedAt;

console.log("");
console.log("==================== QA SMOKE SUMMARY ====================");
console.log(`Target:    ${options.baseUrl}`);
console.log(`Run id:    ${runId}`);
console.log(`PASS:      ${passed.length}`);
console.log(`FAIL:      ${failed.length}`);
console.log(`SKIP:      ${skipped.length}`);
console.log(`Duration:  ${(durationMs / 1000).toFixed(2)}s`);
if (failed.length > 0) {
  console.log("Failures:");
  for (const failure of failed) console.log(`  - ${failure.name}: ${failure.detail}`);
}
if (skipped.length > 0) {
  console.log("Skipped:");
  for (const skip of skipped) console.log(`  - ${skip.name}: ${skip.detail}`);
}
console.log(`SMOKE_RESULT target=${options.baseUrl} pass=${passed.length} fail=${failed.length} ` +
  `skip=${skipped.length} exit=${failed.length === 0 ? 0 : 1}`);
process.exitCode = failed.length === 0 ? 0 : 1;
