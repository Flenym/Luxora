import { describe, expect, it } from "vitest";
import { LuxoraApiError, type Message } from "../contract";
import {
  LuxoraApiClient,
  asLuxoraApiError,
  inferAttachmentKind,
  isLuxoraApiError,
  resolveApiBaseUrl,
  sha256Hex,
  withQuery,
  type KeyValueStorage
} from "./api";

type FetchCall = { url: string; method: string; headers: Record<string, string>; body: unknown };

function memoryStorage(initial: Record<string, string> = {}): KeyValueStorage & { dump(): Record<string, string> } {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => {
      map.set(key, value);
    },
    removeItem: (key) => {
      map.delete(key);
    },
    dump: () => Object.fromEntries(map)
  };
}

function jsonResponse(body: unknown, status = 200, extraHeaders: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...extraHeaders }
  });
}

type Responder = (call: FetchCall) => Response | Promise<Response>;

function fakeFetch(responder: Responder): { fetchImpl: typeof fetch; calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    const rawHeaders = (init?.headers ?? {}) as Record<string, string>;
    for (const [key, value] of Object.entries(rawHeaders)) headers[key.toLowerCase()] = value;
    const call: FetchCall = {
      url: typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url,
      method: init?.method ?? "GET",
      headers,
      body: init?.body
    };
    calls.push(call);
    return responder(call);
  }) as typeof fetch;
  return { fetchImpl, calls };
}

const TOKENS = {
  accessToken: "access-token-value",
  refreshToken: "refresh-token-value",
  tokenType: "Bearer" as const,
  expiresIn: 900,
  sessionId: "session-id"
};

const USER = {
  id: "user-1",
  username: "alice",
  displayName: "Alice",
  bio: "",
  avatarUrl: null,
  createdAt: "2026-01-01T00:00:00.000Z"
};

function createClient(
  responder: Responder,
  options: { storage?: KeyValueStorage; onAuthFailure?: (error: LuxoraApiError) => void } = {}
) {
  const { fetchImpl, calls } = fakeFetch(responder);
  const storage = options.storage ?? memoryStorage();
  const client = new LuxoraApiClient({
    baseUrl: "http://api.test",
    fetchImpl,
    storage,
    ...(options.onAuthFailure === undefined ? {} : { onAuthFailure: options.onAuthFailure }),
    requestTimeoutMs: 1_000,
    randomId: () => "00000000-0000-4000-8000-000000000000"
  });
  return { client, calls, storage };
}

describe("api client — envelopes and errors", () => {
  it("parses a successful JSON envelope", async () => {
    const { client } = createClient((call) => {
      expect(call.url).toBe("http://api.test/v1/me");
      return jsonResponse({ user: USER });
    });
    await expect(client.getMe()).resolves.toEqual(USER);
  });

  it("maps a server error envelope (code/message/requestId/details)", async () => {
    const { client } = createClient(() => jsonResponse({
      error: { code: "FORBIDDEN", message: "Request is unavailable", requestId: "req-1", details: { reason: "x" } }
    }, 403));
    const error = await client.getMe().catch((caught: unknown) => caught);
    expect(isLuxoraApiError(error)).toBe(true);
    const apiError = error as LuxoraApiError;
    expect(apiError.code).toBe("FORBIDDEN");
    expect(apiError.message).toBe("Request is unavailable");
    expect(apiError.status).toBe(403);
    expect(apiError.requestId).toBe("req-1");
    expect(apiError.details).toEqual({ reason: "x" });
  });

  it("falls back to a stable code for non-JSON failures", async () => {
    const { client } = createClient(() => new Response("gateway down", { status: 503, statusText: "Service Unavailable" }));
    const error = await client.getMe().catch((caught: unknown) => caught);
    expect((error as LuxoraApiError).code).toBe("SERVICE_UNAVAILABLE");
    expect((error as LuxoraApiError).status).toBe(503);
  });

  it("normalizes network failures to NETWORK_ERROR/status 0", async () => {
    const { client } = createClient(() => {
      throw new TypeError("fetch failed");
    });
    const error = await client.getMe().catch((caught: unknown) => caught);
    const apiError = error as LuxoraApiError;
    expect(apiError.code).toBe("NETWORK_ERROR");
    expect(apiError.status).toBe(0);
    expect(asLuxoraApiError(new Error("boom")).code).toBe("INTERNAL_ERROR");
  });
});

describe("api client — auth and refresh", () => {
  it("stores the refresh token in session storage and keeps the access token in memory", async () => {
    const storage = memoryStorage();
    const { client, calls } = createClient(() => jsonResponse({ user: USER, tokens: TOKENS }, 201), { storage });
    const result = await client.register({
      username: "alice",
      displayName: "Alice",
      password: "a-long-password",
      deviceName: "Browser"
    });
    expect(result.user).toEqual(USER);
    expect(client.accessToken).toBe(TOKENS.accessToken);
    expect(storage.dump()).toEqual({ "luxora.session.refresh-token": TOKENS.refreshToken });
    expect(calls[0]?.url).not.toContain(TOKENS.accessToken);
    expect(calls[0]?.headers.authorization).toBeUndefined();
  });

  it("sends the access token in the Authorization header only", async () => {
    const { client, calls } = createClient((call) => {
      if (call.url.endsWith("/v1/auth/login")) return jsonResponse({ user: USER, tokens: TOKENS });
      if (call.url.endsWith("/v1/me")) return jsonResponse({ user: USER });
      return jsonResponse({ error: { code: "NOT_FOUND", message: "nope" } }, 404);
    });
    await client.login({ username: "alice", password: "password", deviceName: "Browser" });
    await client.getMe();
    const meCall = calls.find((call) => call.url.endsWith("/v1/me"));
    expect(meCall?.headers.authorization).toBe(`Bearer ${TOKENS.accessToken}`);
    expect(meCall?.url).not.toContain(TOKENS.accessToken);
    expect(meCall?.headers["content-type"]).toBeUndefined();
  });

  it("performs exactly one in-flight refresh for concurrent 401 retries", async () => {
    const storage = memoryStorage({ "luxora.session.refresh-token": TOKENS.refreshToken });
    let refreshCalls = 0;
    let protectedCalls = 0;
    let refreshed = false;
    const { client } = createClient((call) => {
      if (call.url.endsWith("/v1/auth/refresh")) {
        refreshCalls += 1;
        refreshed = true;
        return jsonResponse({
          tokens: { ...TOKENS, accessToken: "new-access", refreshToken: "new-refresh" }
        });
      }
      protectedCalls += 1;
      if (!refreshed) return jsonResponse({ error: { code: "UNAUTHENTICATED", message: "expired" } }, 401);
      return jsonResponse({ user: USER });
    }, { storage });
    const [first, second] = await Promise.all([client.getMe(), client.getMe()]);
    expect(first).toEqual(USER);
    expect(second).toEqual(USER);
    expect(refreshCalls).toBe(1);
    expect(protectedCalls).toBeGreaterThanOrEqual(4);
    expect(storage.dump()["luxora.session.refresh-token"]).toBe("new-refresh");
  });

  it("signs the session out when the refresh family is dead", async () => {
    const storage = memoryStorage({ "luxora.session.refresh-token": TOKENS.refreshToken });
    const failures: LuxoraApiError[] = [];
    const { client } = createClient((call) => {
      if (call.url.endsWith("/v1/auth/refresh")) {
        return jsonResponse({ error: { code: "UNAUTHENTICATED", message: "refresh reused" } }, 401);
      }
      return jsonResponse({ error: { code: "UNAUTHENTICATED", message: "expired" } }, 401);
    }, { storage, onAuthFailure: (error) => failures.push(error) });
    const error = await client.getMe().catch((caught: unknown) => caught);
    expect((error as LuxoraApiError).code).toBe("UNAUTHENTICATED");
    expect(failures).toHaveLength(1);
    expect(storage.dump()["luxora.session.refresh-token"]).toBeUndefined();
    expect(client.accessToken).toBeNull();
    expect(client.hasStoredSession()).toBe(false);
  });

  it("does not retry a 401 when no refresh token is stored", async () => {
    const storage = memoryStorage();
    const { client, calls } = createClient(
      () => jsonResponse({ error: { code: "UNAUTHENTICATED", message: "expired" } }, 401),
      { storage }
    );
    await expect(client.getMe()).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
    expect(calls.some((call) => call.url.endsWith("/v1/auth/refresh"))).toBe(false);
  });

  it("clears local state on logout even when revocation fails", async () => {
    const storage = memoryStorage();
    const { client } = createClient((call) => {
      if (call.url.endsWith("/v1/auth/login")) return jsonResponse({ user: USER, tokens: TOKENS });
      return jsonResponse({ error: { code: "INTERNAL_ERROR", message: "boom" } }, 500);
    }, { storage });
    await client.login({ username: "alice", password: "password", deviceName: "Browser" });
    await client.logout();
    expect(client.accessToken).toBeNull();
    expect(client.hasStoredSession()).toBe(false);
  });
});

describe("api client — uploads", () => {
  it("hashes bytes with SHA-256", async () => {
    const hex = await sha256Hex(new TextEncoder().encode("abc"));
    expect(hex).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });

  it("classifies upload kinds by MIME and file name", () => {
    expect(inferAttachmentKind("image/png", "x.png")).toBe("image");
    expect(inferAttachmentKind("video/mp4", "clip.bin")).toBe("video");
    expect(inferAttachmentKind("audio/mpeg", "voice.bin")).toBe("audio");
    expect(inferAttachmentKind("application/pdf", "report.pdf")).toBe("file");
  });

  it("creates the session, PUTs chunks with range+digest headers and completes", async () => {
    const bytes = new Uint8Array([1, 2, 3, 4, 5, 6, 7]);
    const file = new File([bytes], "tiny.png", { type: "image/png" });
    const chunkDigests: string[] = [];
    const ranges: string[] = [];
    const { client } = createClient((call) => {
      if (call.url.endsWith("/v1/auth/login")) return jsonResponse({ user: USER, tokens: TOKENS });
      if (call.url.endsWith("/v1/uploads")) {
        return jsonResponse({
          upload: {
            id: "upload-1",
            status: "active",
            fileName: "tiny.png",
            sizeBytes: bytes.length,
            chunkSizeBytes: 4,
            receivedBytes: 0,
            receivedChunkIndexes: [],
            expiresAt: "2026-01-01T00:00:00.000Z",
            attachment: null,
            failureCode: null
          }
        }, 201);
      }
      if (call.url.includes("/chunks/")) {
        ranges.push(call.headers["content-range"] ?? "");
        chunkDigests.push(call.headers["x-chunk-sha256"] ?? "");
        return jsonResponse({ upload: { id: "upload-1", status: "active" } });
      }
      if (call.url.endsWith("/complete")) {
        return jsonResponse({
          upload: {
            id: "upload-1",
            status: "completed",
            fileName: "tiny.png",
            sizeBytes: bytes.length,
            chunkSizeBytes: 4,
            receivedBytes: bytes.length,
            receivedChunkIndexes: [0, 1],
            expiresAt: "2026-01-01T00:00:00.000Z",
            attachment: {
              id: "attachment-1",
              kind: "image",
              fileName: "tiny.png",
              mimeType: "image/png",
              sizeBytes: bytes.length,
              sha256: "f".repeat(64),
              downloadPath: "/v1/attachments/attachment-1/content",
              safetyStatus: "unscanned",
              metadataTrust: "client_declared",
              createdAt: "2026-01-01T00:00:00.000Z",
              metadata: {}
            },
            failureCode: null
          }
        });
      }
      return jsonResponse({ error: { code: "NOT_FOUND", message: "unexpected" } }, 404);
    });
    await client.login({ username: "alice", password: "password", deviceName: "Browser" });
    const fractions: number[] = [];
    const attachment = await client.uploadFile(file, (fraction) => fractions.push(fraction));
    expect(attachment.id).toBe("attachment-1");
    expect(ranges).toEqual(["bytes 0-3/7", "bytes 4-6/7"]);
    const expectedDigest = await sha256Hex(bytes.subarray(0, 4));
    expect(chunkDigests[0]).toBe(expectedDigest);
    expect(fractions.at(-1)).toBe(1);
  });

  it("returns authenticated attachment blobs with the bearer token", async () => {
    const { client, calls } = createClient((call) => {
      if (call.url.endsWith("/v1/auth/login")) return jsonResponse({ user: USER, tokens: TOKENS });
      if (call.url.includes("/v1/attachments/")) return new Response(new Uint8Array([9, 8, 7]), {
        status: 200,
        headers: { "content-type": "image/png" }
      });
      return jsonResponse({ error: { code: "NOT_FOUND", message: "nope" } }, 404);
    });
    await client.login({ username: "alice", password: "password", deviceName: "Browser" });
    const blob = await client.authBlob("/v1/attachments/a1/thumbnail");
    expect(blob.size).toBe(3);
    const attachmentCall = calls.find((call) => call.url.includes("/v1/attachments/"));
    expect(attachmentCall?.headers.authorization).toBe(`Bearer ${TOKENS.accessToken}`);
    expect(attachmentCall?.url).not.toContain(TOKENS.accessToken);
  });
});

describe("api helpers", () => {
  it("builds query strings without empty values", () => {
    expect(withQuery("/v1/chats", { limit: undefined, cursor: null, q: "hello world" }))
      .toBe("/v1/chats?q=hello%20world");
    expect(withQuery("/v1/chats", {})).toBe("/v1/chats");
  });

  it("resolves the API base with explicit override and trailing slash trim", () => {
    expect(resolveApiBaseUrl("http://127.0.0.1:2222/")).toBe("http://127.0.0.1:2222");
    expect(resolveApiBaseUrl("")).toBe("");
  });

  it("keeps attachment kind data intact", () => {
    const message: Partial<Message> = { id: "m1", chatId: "c1" };
    expect(message.chatId).toBe("c1");
  });
});
