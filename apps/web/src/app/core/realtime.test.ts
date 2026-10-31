import { describe, expect, it } from "vitest";
import { LuxoraApiError, type DurableRealtimeEvent, type Message } from "../contract";
import {
  RealtimeClient,
  resolveRealtimeUrl,
  type CursorStorage,
  type RealtimeClientOptions,
  type RealtimeConnectionStatus,
  type RealtimeHandlers,
  type RealtimeTimers,
  type WebSocketLike
} from "./realtime";

class FakeSocket implements WebSocketLike {
  readyState = 0;
  readonly sent: string[] = [];
  onopen: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event: { code?: number; reason?: string }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;

  constructor(readonly url: string) {}

  send(data: string): void {
    this.sent.push(data);
  }

  close(code?: number, reason?: string): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.onclose?.({ code: code ?? 1000, reason: reason ?? "" });
  }

  open(): void {
    this.readyState = 1;
    this.onopen?.({});
  }

  receive(frame: unknown): void {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }

  serverClose(code: number, reason = ""): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.onclose?.({ code, reason });
  }

  frames(): Array<Record<string, unknown>> {
    return this.sent.map((raw) => JSON.parse(raw) as Record<string, unknown>);
  }
}

function createFakeTimers(): { timers: RealtimeTimers; advance(ms: number): void; pending(): number } {
  let time = 0;
  let nextId = 1;
  const jobs = new Map<number, { at: number; fn: () => void }>();
  return {
    timers: {
      setTimeout: (fn, ms) => {
        const id = nextId;
        nextId += 1;
        jobs.set(id, { at: time + Math.max(0, ms), fn });
        return id;
      },
      clearTimeout: (handle) => {
        jobs.delete(handle as number);
      }
    },
    advance(ms: number) {
      time += ms;
      let ran = true;
      while (ran) {
        ran = false;
        const due = [...jobs.entries()]
          .filter(([, job]) => job.at <= time)
          .sort((left, right) => left[1].at - right[1].at);
        for (const [id, job] of due) {
          if (!jobs.has(id)) continue;
          jobs.delete(id);
          job.fn();
          ran = true;
        }
      }
    },
    pending() {
      return jobs.size;
    }
  };
}

function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

const MESSAGE: Message = {
  id: "message-1",
  chatId: "chat-1",
  sender: {
    id: "user-2",
    username: "bob",
    displayName: "Bob",
    bio: "",
    avatarUrl: null,
    createdAt: "2026-01-01T00:00:00.000Z"
  },
  kind: "text",
  body: "hello",
  replyToMessageId: null,
  topicId: null,
  forwardedFrom: null,
  attachments: [],
  transcriptionAllowed: false,
  transcript: null,
  isPinned: false,
  clientNonce: "nonce-1",
  revision: 0,
  createdAt: "2026-01-01T00:00:01.000Z",
  updatedAt: "2026-01-01T00:00:01.000Z",
  editedAt: null,
  deletedAt: null
};

function createHarness(
  options: Partial<RealtimeClientOptions> = {},
  handlerOverrides: Partial<RealtimeHandlers> = {}
) {
  const sockets: FakeSocket[] = [];
  const clock = createFakeTimers();
  const statuses: RealtimeConnectionStatus[] = [];
  const events: DurableRealtimeEvent[] = [];
  const typing: Array<{ chatId: string; userId: string; isTyping: boolean; expiresAt: string }> = [];
  const presence: Array<{ userId: string; presence: "online" | "offline"; lastSeenAt: string | null }> = [];
  const syncReasons: string[] = [];
  const authFailures: LuxoraApiError[] = [];
  const errors: LuxoraApiError[] = [];
  let currentToken = "access-token";
  const cursorState: { value: string | null } = { value: (options.cursorStorage as CursorStorage | null)?.get() ?? null };
  const cursorStorage: CursorStorage = {
    get: () => cursorState.value,
    set: (value) => {
      cursorState.value = value;
    }
  };
  const handlers: RealtimeHandlers = {
    onEvent: (event) => events.push(event),
    onTyping: (event) => typing.push(event),
    onPresence: (event) => presence.push(event),
    onStatus: (status) => statuses.push(status),
    onSyncRequired: async (reason) => {
      syncReasons.push(reason);
    },
    onAuthFailure: (error) => authFailures.push(error),
    onError: (error) => errors.push(error),
    ...handlerOverrides
  };
  const client = new RealtimeClient(
    {
      url: "ws://api.test/v2/realtime",
      getAccessToken: () => currentToken,
      refreshAccessToken: async () => {
        currentToken = "refreshed-access-token";
        return currentToken;
      },
      cursorStorage,
      webSocketFactory: (url) => {
        const socket = new FakeSocket(url);
        sockets.push(socket);
        return socket;
      },
      timers: clock.timers,
      random: () => 0.5,
      jitterRatio: 0,
      heartbeatIntervalMs: 25_000,
      baseBackoffMs: 500,
      ...options
    },
    handlers
  );
  return {
    client,
    sockets,
    clock,
    statuses,
    events,
    typing,
    presence,
    syncReasons,
    authFailures,
    errors,
    cursorStorage,
    cursorState,
    setToken: (token: string) => {
      currentToken = token;
    }
  };
}

async function connectHarness(harness: ReturnType<typeof createHarness>): Promise<FakeSocket> {
  harness.client.connect();
  const socket = harness.sockets[0];
  expect(socket).toBeDefined();
  socket.open();
  socket.receive({ type: "hello", protocolVersion: 2, connectionId: "connection-1", heartbeatIntervalMs: 25_000 });
  return socket;
}

function readyFrame(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: "ready",
    userId: "user-1",
    sessionId: "session-1",
    sequence: 1,
    headSequence: 1,
    cursor: "cursor-ready",
    resumed: false,
    resumeMode: "none",
    retention: { maxReplayEvents: 500, cursorTtlSeconds: 604_800 },
    ...overrides
  };
}

describe("realtime client — handshake and cursor", () => {
  it("authenticates through a frame and never leaks the token into the URL", async () => {
    const harness = createHarness();
    const socket = await connectHarness(harness);
    expect(socket.url).not.toContain("access-token");
    expect(socket.frames()[0]).toEqual({ type: "authenticate", accessToken: "access-token" });
    expect(harness.statuses.at(-1)).toBe("connecting");
  });

  it("sends the stored cursor on resume and persists applied dispatch positions", async () => {
    const harness = createHarness();
    harness.cursorState.value = "stored-cursor";
    const socket = await connectHarness(harness);
    expect(socket.frames()[0]).toEqual({
      type: "authenticate",
      accessToken: "access-token",
      resumeCursor: "stored-cursor"
    });
    socket.receive(readyFrame({ resumed: true, resumeMode: "scoped_cursor", sequence: 7, headSequence: 9 }));
    expect(harness.statuses.at(-1)).toBe("online");
    socket.receive({
      type: "dispatch",
      sequence: 8,
      cursor: "cursor-8",
      event: { type: "message.created", message: MESSAGE }
    });
    expect(harness.events).toHaveLength(1);
    expect(harness.events[0]?.type).toBe("message.created");
    expect(harness.cursorState.value).toBe("cursor-8");
    socket.receive({ type: "sync.checkpoint", sequence: 9, cursor: "cursor-9" });
    expect(harness.cursorState.value).toBe("cursor-9");
  });
});

describe("realtime client — reconnect, backoff and sync recovery", () => {
  it("reconnects after 1013 with bounded backoff and the last cursor", async () => {
    const harness = createHarness();
    const socket = await connectHarness(harness);
    socket.receive(readyFrame());
    socket.receive({ type: "sync.checkpoint", sequence: 2, cursor: "cursor-2" });
    expect(harness.statuses.at(-1)).toBe("online");
    socket.serverClose(1013, "backpressure");
    expect(harness.statuses.at(-1)).toBe("reconnecting");
    harness.clock.advance(499);
    expect(harness.sockets).toHaveLength(1);
    harness.clock.advance(1);
    expect(harness.sockets).toHaveLength(2);
    const resumed = harness.sockets[1];
    resumed.open();
    resumed.receive({ type: "hello", protocolVersion: 2, connectionId: "connection-2", heartbeatIntervalMs: 25_000 });
    expect(resumed.frames()[0]).toEqual({
      type: "authenticate",
      accessToken: "access-token",
      resumeCursor: "cursor-2"
    });
  });

  it("full HTTP reload first, then reconnects without a cursor on sync.required", async () => {
    const harness = createHarness();
    const socket = await connectHarness(harness);
    socket.receive(readyFrame());
    socket.receive({ type: "sync.checkpoint", sequence: 3, cursor: "cursor-3" });
    socket.receive({
      type: "sync.required",
      reason: "replay_window_exceeded",
      headSequence: 9,
      recovery: { type: "http_snapshot", path: "/v2/sync/snapshot" }
    });
    expect(harness.syncReasons).toEqual(["replay_window_exceeded"]);
    expect(harness.cursorState.value).toBeNull();
    await settle();
    harness.clock.advance(0);
    expect(harness.sockets).toHaveLength(2);
    const reconnected = harness.sockets[1];
    reconnected.open();
    reconnected.receive({ type: "hello", protocolVersion: 2, connectionId: "connection-2", heartbeatIntervalMs: 25_000 });
    expect(reconnected.frames()[0]).toEqual({ type: "authenticate", accessToken: "access-token" });
  });

  it("retries the authoritative reload when it fails instead of reconnecting stale state", async () => {
    let attempts = 0;
    const harness = createHarness({}, {
      onSyncRequired: async (reason) => {
        attempts += 1;
        if (attempts === 1) throw new Error("snapshot endpoint unreachable");
        void reason;
      }
    });
    const socket = await connectHarness(harness);
    socket.receive(readyFrame());
    socket.receive({
      type: "sync.required",
      reason: "cursor_expired",
      headSequence: 3,
      recovery: { type: "http_snapshot", path: "/v2/sync/snapshot" }
    });
    await settle();
    expect(attempts).toBe(1);
    expect(harness.sockets).toHaveLength(1);
    harness.clock.advance(2_000);
    await settle();
    expect(attempts).toBe(2);
    harness.clock.advance(0);
    expect(harness.sockets).toHaveLength(2);
  });

  it("refreshes once on close 4001, then reconnects with the new token", async () => {
    const harness = createHarness();
    const socket = await connectHarness(harness);
    socket.receive(readyFrame());
    socket.serverClose(4001, "Session revoked");
    await settle();
    expect(harness.authFailures).toHaveLength(0);
    expect(harness.statuses.at(-1)).toBe("reconnecting");
    harness.clock.advance(0);
    expect(harness.sockets).toHaveLength(2);
    const reconnected = harness.sockets[1];
    reconnected.open();
    reconnected.receive({ type: "hello", protocolVersion: 2, connectionId: "connection-2", heartbeatIntervalMs: 25_000 });
    // The fresh ready frame persisted its signed boundary cursor, so the retry
    // keyed on the same live session resumes from it.
    expect(reconnected.frames()[0]).toEqual({
      type: "authenticate",
      accessToken: "refreshed-access-token",
      resumeCursor: "cursor-ready"
    });
  });

  it("signs out when the 4001 refresh cannot produce a token", async () => {
    const harness = createHarness({
      refreshAccessToken: async () => {
        throw new LuxoraApiError({ code: "UNAUTHENTICATED", message: "refresh family dead", status: 401 });
      }
    });
    const socket = await connectHarness(harness);
    socket.receive(readyFrame());
    socket.serverClose(4001, "Session revoked");
    await settle();
    expect(harness.authFailures).toHaveLength(1);
    expect(harness.authFailures[0]?.code).toBe("UNAUTHENTICATED");
    harness.clock.advance(10_000);
    expect(harness.sockets).toHaveLength(1);
  });

  it("backs off on policy close 1008 without hot-looping", async () => {
    const harness = createHarness();
    const socket = await connectHarness(harness);
    socket.receive(readyFrame());
    socket.serverClose(1008, "Realtime frame rate exceeded");
    expect(harness.sockets).toHaveLength(1);
    harness.clock.advance(500);
    expect(harness.sockets).toHaveLength(2);
  });
});

describe("realtime client — frames and lifecycle", () => {
  it("answers heartbeat frames and dispatches typing/presence to handlers", async () => {
    const harness = createHarness();
    const socket = await connectHarness(harness);
    socket.receive(readyFrame());
    socket.receive({ type: "heartbeat", timestamp: "2026-01-01T00:00:10.000Z" });
    expect(socket.frames()).toContainEqual({ type: "heartbeat", timestamp: "2026-01-01T00:00:10.000Z" });
    socket.receive({
      type: "typing.updated",
      chatId: "chat-1",
      userId: "user-2",
      isTyping: true,
      expiresAt: "2026-01-01T00:00:15.000Z"
    });
    expect(harness.typing).toEqual([{
      chatId: "chat-1",
      userId: "user-2",
      isTyping: true,
      expiresAt: "2026-01-01T00:00:15.000Z"
    }]);
    socket.receive({
      type: "presence.updated",
      userId: "user-2",
      presence: "online",
      lastSeenAt: null
    });
    expect(harness.presence).toEqual([{ userId: "user-2", presence: "online", lastSeenAt: null }]);
  });

  it("sends typing commands and stops reconnecting after disconnect()", async () => {
    const harness = createHarness();
    const socket = await connectHarness(harness);
    socket.receive(readyFrame());
    harness.client.sendTyping("chat-1", true);
    harness.client.sendTyping("chat-1", false);
    expect(socket.frames()).toContainEqual({ type: "typing.start", chatId: "chat-1" });
    expect(socket.frames()).toContainEqual({ type: "typing.stop", chatId: "chat-1" });
    harness.client.disconnect();
    expect(harness.statuses.at(-1)).toBe("idle");
    harness.clock.advance(60_000);
    expect(harness.sockets).toHaveLength(1);
  });

  it("ignores malformed frames and resumes after a network close", async () => {
    const harness = createHarness();
    const socket = await connectHarness(harness);
    socket.receive(readyFrame());
    socket.onmessage?.({ data: "not-json" });
    socket.onmessage?.({ data: JSON.stringify({ type: 42 }) });
    expect(harness.events).toHaveLength(0);
    // 1006 = abnormal network close
    socket.serverClose(1006, "network lost");
    harness.clock.advance(500);
    expect(harness.sockets).toHaveLength(2);
  });
});

describe("realtime URL", () => {
  it("derives ws(s) URLs without tokens", () => {
    expect(resolveRealtimeUrl("https://api.luxora.app", undefined)).toBe("wss://api.luxora.app/v2/realtime");
    expect(resolveRealtimeUrl("http://127.0.0.1:2222/", undefined)).toBe("ws://127.0.0.1:2222/v2/realtime");
    expect(resolveRealtimeUrl("", "http://localhost:4173")).toBe("ws://localhost:4173/v2/realtime");
  });
});
