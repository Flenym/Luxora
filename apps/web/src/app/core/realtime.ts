/**
 * WebSocket client for the Luxora `/v2/realtime` gateway.
 *
 * Contract highlights (API.md §9, docs/specs/REALTIME_SYNC.md):
 * - The access token is sent in an `authenticate` frame, never in the URL.
 * - The resumable position is the opaque `cursor`; it is persisted verbatim
 *   only after the corresponding state was applied. `sync.required` (or close
 *   code 4009) means the owner must rebuild state over HTTP, then reconnect
 *   without a cursor.
 * - Exactly one reconnect attempt is scheduled at a time with exponential
 *   backoff + jitter. 4001 means refresh-or-sign-out; 1008/1013 mean bounded
 *   backoff.
 * - The client is fully testable through an injected WebSocket factory and
 *   injected timers (node environment, no DOM).
 */
import { LuxoraApiError, type DurableRealtimeEvent, type ServerRealtimeFrame } from "../contract";

export type RealtimeConnectionStatus = "idle" | "connecting" | "online" | "reconnecting" | "offline";

/** The minimal WebSocket surface used by this client (browser WebSocket fits). */
export interface WebSocketLike {
  readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: ((event: { code?: number; reason?: string }) => void) | null;
  onerror: ((event: unknown) => void) | null;
}

export interface RealtimeTimers {
  setTimeout(handler: () => void, timeoutMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

export const defaultRealtimeTimers: RealtimeTimers = {
  setTimeout: (handler, timeoutMs) => globalThis.setTimeout(handler, timeoutMs),
  clearTimeout: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof globalThis.setTimeout>)
};

export interface RealtimeHandlers {
  /** Durable event, already authorized by the server. Apply idempotently. */
  onEvent(event: DurableRealtimeEvent): void;
  onTyping(event: { chatId: string; userId: string; isTyping: boolean; expiresAt: string }): void;
  onPresence(event: { userId: string; presence: "online" | "offline"; lastSeenAt: string | null }): void;
  onStatus(status: RealtimeConnectionStatus): void;
  /** Rebuild state over HTTP (chats/messages/requests), then the client reconnects. */
  onSyncRequired(reason: string): void | Promise<void>;
  onAuthFailure(error: LuxoraApiError): void;
  onError?(error: LuxoraApiError): void;
}

export interface CursorStorage {
  get(): string | null;
  set(value: string | null): void;
}

export interface RealtimeClientOptions {
  /** Absolute ws(s):// URL or same-origin path resolved by the caller. */
  url: string;
  getAccessToken(): string | null;
  /** Refresh the access token after close code 4001. Returns null on failure. */
  refreshAccessToken?: () => Promise<string | null>;
  cursorStorage?: CursorStorage | null;
  webSocketFactory?: (url: string) => WebSocketLike;
  timers?: RealtimeTimers;
  random?: () => number;
  now?: () => number;
  baseBackoffMs?: number;
  maxBackoffMs?: number;
  /** Fractional jitter, e.g. 0.25 => ±25% of the computed delay. */
  jitterRatio?: number;
  /** Default from `hello` when the server omits it. */
  heartbeatIntervalMs?: number;
  /** Stop reconnecting after this many consecutive failures; 0 disables the cap. */
  maxConsecutiveFailures?: number;
}

const AUTHENTICATE_TIMEOUT_MS = 6_000;
const HELLO_TIMEOUT_MS = 6_000;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 25_000;
const WATCHDOG_GRACE_MS = 15_000;
const SYNC_RECOVERY_RETRY_MS = 2_000;
// A hostile or broken gateway must not be able to schedule an unbounded timer
// from the `hello.heartbeatIntervalMs` frame. The interval is only a liveness
// hint, so clamp it to a safe range before it reaches `setTimeout`.
const MIN_HEARTBEAT_INTERVAL_MS = 1_000;
const MAX_HEARTBEAT_INTERVAL_MS = 120_000;

/** Clamp a server-provided heartbeat interval to a bounded, finite duration. */
export function clampHeartbeatIntervalMs(value: unknown, fallback: number): number {
  const safeFallback = Number.isFinite(fallback) && fallback > 0
    ? Math.min(MAX_HEARTBEAT_INTERVAL_MS, Math.max(MIN_HEARTBEAT_INTERVAL_MS, Math.floor(fallback)))
    : DEFAULT_HEARTBEAT_INTERVAL_MS;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return safeFallback;
  return Math.min(MAX_HEARTBEAT_INTERVAL_MS, Math.max(MIN_HEARTBEAT_INTERVAL_MS, Math.floor(value)));
}

/** Resolve the realtime URL from the API base (never leaks a token). */
export function resolveRealtimeUrl(apiBaseUrl: string, fallbackOrigin?: string): string {
  if (apiBaseUrl !== "") {
    const httpUrl = new URL(apiBaseUrl);
    httpUrl.protocol = httpUrl.protocol === "https:" ? "wss:" : "ws:";
    httpUrl.pathname = "/v2/realtime";
    httpUrl.search = "";
    httpUrl.hash = "";
    return httpUrl.toString();
  }
  if (fallbackOrigin !== undefined && fallbackOrigin.length > 0) {
    const origin = new URL(fallbackOrigin);
    origin.protocol = origin.protocol === "https:" ? "wss:" : "ws:";
    origin.pathname = "/v2/realtime";
    origin.search = "";
    origin.hash = "";
    return origin.toString();
  }
  if (typeof window !== "undefined" && window.location) {
    const scheme = window.location.protocol === "https:" ? "wss:" : "ws:";
    return `${scheme}//${window.location.host}/v2/realtime`;
  }
  return "ws://127.0.0.1:2222/v2/realtime";
}

function toLuxoraError(error: unknown, fallbackMessage: string): LuxoraApiError {
  if (error instanceof LuxoraApiError) return error;
  return new LuxoraApiError({
    code: "INTERNAL_ERROR",
    message: error instanceof Error && error.message.length > 0 ? error.message : fallbackMessage,
    status: 0
  });
}

export class RealtimeClient {
  #url: string;
  readonly #handlers: RealtimeHandlers;
  readonly #getAccessToken: () => string | null;
  readonly #refreshAccessToken?: () => Promise<string | null>;
  readonly #cursorStorage: CursorStorage | null;
  readonly #factory: (url: string) => WebSocketLike;
  readonly #timers: RealtimeTimers;
  readonly #random: () => number;
  readonly #now: () => number;
  readonly #baseBackoffMs: number;
  readonly #maxBackoffMs: number;
  readonly #jitterRatio: number;
  readonly #configuredHeartbeatMs: number;
  readonly #maxConsecutiveFailures: number;
  #socket: WebSocketLike | null = null;
  #status: RealtimeConnectionStatus = "idle";
  #stopped = true;
  #reconnectTimer: unknown = null;
  #authTimer: unknown = null;
  #watchdogTimer: unknown = null;
  #recoveryTimer: unknown = null;
  #heartbeatIntervalMs: number;
  #lastFrameAt = 0;
  #attempt = 0;
  #syncing = false;
  #refreshing = false;
  #readySeen = false;

  constructor(options: RealtimeClientOptions, handlers: RealtimeHandlers) {
    this.#url = options.url;
    this.#handlers = handlers;
    this.#getAccessToken = options.getAccessToken;
    this.#refreshAccessToken = options.refreshAccessToken;
    this.#cursorStorage = options.cursorStorage ?? null;
    this.#timers = options.timers ?? defaultRealtimeTimers;
    this.#random = options.random ?? Math.random;
    this.#now = options.now ?? Date.now;
    this.#baseBackoffMs = options.baseBackoffMs ?? 500;
    this.#maxBackoffMs = options.maxBackoffMs ?? 30_000;
    this.#jitterRatio = options.jitterRatio ?? 0.25;
    this.#configuredHeartbeatMs = clampHeartbeatIntervalMs(
      options.heartbeatIntervalMs,
      DEFAULT_HEARTBEAT_INTERVAL_MS
    );
    this.#maxConsecutiveFailures = options.maxConsecutiveFailures ?? 0;
    const factory = options.webSocketFactory;
    if (factory !== undefined) {
      this.#factory = factory;
    } else {
      this.#factory = (url: string) => {
        if (typeof WebSocket === "undefined") {
          throw new LuxoraApiError({
            code: "INTERNAL_ERROR",
            message: "WebSocket is unavailable in this runtime",
            status: 0
          });
        }
        return new WebSocket(url) as unknown as WebSocketLike;
      };
    }
    this.#heartbeatIntervalMs = this.#configuredHeartbeatMs;
  }

  get status(): RealtimeConnectionStatus {
    return this.#status;
  }

  get url(): string {
    return this.#url;
  }

  /** Update the endpoint (e.g. after config reload) for the next connect. */
  setUrl(url: string): void {
    this.#url = url;
  }

  connect(): void {
    if (!this.#stopped) return;
    this.#stopped = false;
    this.#attempt = 0;
    this.#openSocket();
  }

  disconnect(): void {
    this.#stopped = true;
    this.#clearReconnectTimer();
    this.#clearRecoveryTimer();
    this.#clearAuthTimer();
    this.#disarmWatchdog();
    const socket = this.#socket;
    this.#socket = null;
    if (socket !== null) {
      try {
        socket.close(1000, "client_disconnect");
      } catch {
        // ignore socket teardown races
      }
    }
    this.#setStatus("idle");
  }

  /** Send typing.start / typing.stop; silently ignored while offline. */
  sendTyping(chatId: string, isTyping: boolean): void {
    this.#send({ type: isTyping ? "typing.start" : "typing.stop", chatId });
  }

  /** Optional explicit heartbeat (the watchdog also keeps the socket fresh). */
  sendHeartbeat(): void {
    this.#send({ type: "heartbeat", timestamp: new Date(this.#now()).toISOString() });
  }

  /* -------------------------------------------------------------- internals */

  #setStatus(status: RealtimeConnectionStatus): void {
    if (this.#status === status) return;
    this.#status = status;
    this.#handlers.onStatus(status);
  }

  #clearReconnectTimer(): void {
    if (this.#reconnectTimer !== null) {
      this.#timers.clearTimeout(this.#reconnectTimer);
      this.#reconnectTimer = null;
    }
  }

  #clearRecoveryTimer(): void {
    if (this.#recoveryTimer !== null) {
      this.#timers.clearTimeout(this.#recoveryTimer);
      this.#recoveryTimer = null;
    }
  }

  #clearAuthTimer(): void {
    if (this.#authTimer !== null) {
      this.#timers.clearTimeout(this.#authTimer);
      this.#authTimer = null;
    }
  }

  #disarmWatchdog(): void {
    if (this.#watchdogTimer !== null) {
      this.#timers.clearTimeout(this.#watchdogTimer);
      this.#watchdogTimer = null;
    }
  }

  #armWatchdog(): void {
    this.#disarmWatchdog();
    // Re-clamp at the scheduling site so the timeout passed to the runtime is
    // provably bounded even if a future path bypasses the constructor clamp.
    const heartbeatMs = Math.min(
      MAX_HEARTBEAT_INTERVAL_MS,
      Math.max(MIN_HEARTBEAT_INTERVAL_MS, this.#heartbeatIntervalMs)
    );
    const timeoutMs = heartbeatMs + WATCHDOG_GRACE_MS;
    this.#watchdogTimer = this.#timers.setTimeout(() => {
      this.#watchdogTimer = null;
      if (this.#status !== "online") return;
      // No frames for more than heartbeat + grace: the link is dead.
      this.#teardownSocketAndReconnect();
    }, timeoutMs);
  }

  #openSocket(): void {
    this.#readySeen = false;
    this.#setStatus(this.#attempt === 0 ? "connecting" : "reconnecting");
    let socket: WebSocketLike;
    try {
      socket = this.#factory(this.#url);
    } catch (error) {
      this.#handlers.onError?.(toLuxoraError(error, "Could not open the realtime socket"));
      this.#scheduleReconnect();
      return;
    }
    this.#socket = socket;
    socket.onopen = () => this.#onOpen();
    socket.onmessage = (event) => this.#onMessage(event.data);
    socket.onerror = () => {
      // The close handler owns retry/sign-out behavior.
    };
    socket.onclose = (event) => this.#onClose(typeof event.code === "number" ? event.code : 1006, event.reason ?? "");
    this.#clearAuthTimer();
    this.#authTimer = this.#timers.setTimeout(() => {
      this.#authTimer = null;
      if (this.#readySeen || this.#socket !== socket) return;
      this.#teardownSocketAndReconnect();
    }, HELLO_TIMEOUT_MS);
  }

  #onOpen(): void {
    // The server sends `hello` immediately; authentication happens from there.
  }

  #send(frame: Record<string, unknown>): boolean {
    const socket = this.#socket;
    if (socket === null || socket.readyState !== 1) return false;
    try {
      socket.send(JSON.stringify(frame));
      return true;
    } catch {
      return false;
    }
  }

  #onMessage(data: unknown): void {
    if (typeof data !== "string") return;
    let frame: ServerRealtimeFrame;
    try {
      frame = JSON.parse(data) as ServerRealtimeFrame;
    } catch {
      return;
    }
    if (frame === null || typeof frame !== "object" || typeof (frame as { type?: unknown }).type !== "string") {
      return;
    }
    this.#lastFrameAt = this.#now();
    if (this.#status === "online") this.#armWatchdog();

    switch (frame.type) {
      case "hello":
        this.#clearAuthTimer();
        this.#heartbeatIntervalMs = clampHeartbeatIntervalMs(
          frame.heartbeatIntervalMs,
          this.#configuredHeartbeatMs
        );
        this.#authenticate();
        return;
      case "ready":
        this.#onReady(frame);
        return;
      case "dispatch": {
        try {
          this.#handlers.onEvent(frame.event);
        } catch (error) {
          this.#handlers.onError?.(toLuxoraError(error, "Realtime event handler failed"));
        } finally {
          // Applied idempotently by the store: persist the position even when a
          // single handler row failed so a replay does not stall forever.
          if (typeof frame.cursor === "string") this.#cursorStorage?.set(frame.cursor);
        }
        return;
      }
      case "sync.checkpoint":
        if (typeof frame.cursor === "string") this.#cursorStorage?.set(frame.cursor);
        return;
      case "sync.required":
        this.#handleSyncRequired(frame.reason ?? "cursor_invalid");
        return;
      case "heartbeat":
        this.#send({ type: "heartbeat", timestamp: frame.timestamp });
        return;
      case "heartbeat.ack":
        return;
      case "typing.updated":
        this.#handlers.onTyping({
          chatId: frame.chatId,
          userId: frame.userId,
          isTyping: frame.isTyping,
          expiresAt: frame.expiresAt
        });
        return;
      case "presence.updated":
        this.#handlers.onPresence({
          userId: frame.userId,
          presence: frame.presence,
          lastSeenAt: frame.lastSeenAt
        });
        return;
      case "error": {
        const error = new LuxoraApiError({
          code: frame.code,
          message: frame.message,
          status: frame.code === "UNAUTHENTICATED" ? 401 : frame.code === "RATE_LIMITED" ? 429 : 400
        });
        this.#handlers.onError?.(error);
        if (frame.code === "UNAUTHENTICATED") {
          this.#handleUnauthorizedClose();
        }
        return;
      }
      default:
        return;
    }
  }

  #authenticate(): void {
    const accessToken = this.#getAccessToken();
    if (accessToken === null || accessToken.length === 0) {
      this.#handleUnauthorizedClose();
      return;
    }
    const cursor = this.#cursorStorage?.get() ?? null;
    const frame: Record<string, unknown> = { type: "authenticate", accessToken };
    if (cursor !== null && cursor.length > 0) frame.resumeCursor = cursor;
    if (!this.#send(frame)) {
      this.#teardownSocketAndReconnect();
    }
  }

  #onReady(frame: Extract<ServerRealtimeFrame, { type: "ready" }>): void {
    this.#clearAuthTimer();
    this.#readySeen = true;
    this.#attempt = 0;
    this.#setStatus("online");
    this.#armWatchdog();
    // A fresh (non-resumed) v2 start receives a signed boundary at the head;
    // it is safe to persist because only queue frames newer than it follow.
    if (!frame.resumed && frame.resumeMode === "none" && typeof frame.cursor === "string") {
      this.#cursorStorage?.set(frame.cursor);
    }
  }

  #handleSyncRequired(reason: string): void {
    if (this.#syncing) return;
    this.#syncing = true;
    this.#clearReconnectTimer();
    this.#disarmWatchdog();
    // The position is unusable: drop it before the HTTP reload so the next
    // connection never inherits an unproven cursor.
    this.#cursorStorage?.set(null);
    this.#setStatus("reconnecting");
    const socket = this.#socket;
    this.#socket = null;
    if (socket !== null) {
      try {
        socket.close(4009, "client_sync");
      } catch {
        // ignore
      }
    }
    void this.#runSyncRecovery(reason);
  }

  async #runSyncRecovery(reason: string): Promise<void> {
    try {
      await this.#handlers.onSyncRequired(reason);
      this.#syncing = false;
      this.#scheduleReconnect(0);
    } catch (error) {
      this.#handlers.onError?.(toLuxoraError(error, "HTTP reconciliation failed"));
      // Keep retrying the authoritative reload with bounded backoff instead of
      // reconnecting with a state we could not reset.
      this.#clearRecoveryTimer();
      this.#recoveryTimer = this.#timers.setTimeout(() => {
        this.#recoveryTimer = null;
        void this.#runSyncRecovery(reason);
      }, SYNC_RECOVERY_RETRY_MS);
    }
  }

  #handleUnauthorizedClose(): void {
    if (this.#stopped) return;
    if (this.#refreshing) return;
    this.#refreshing = true;
    this.#clearReconnectTimer();
    this.#setStatus("reconnecting");
    const refresh = this.#refreshAccessToken;
    if (refresh === undefined) {
      this.#refreshing = false;
      this.#handlers.onAuthFailure(new LuxoraApiError({
        code: "UNAUTHENTICATED",
        message: "The realtime session is no longer authorized",
        status: 401
      }));
      return;
    }
    void (async () => {
      try {
        const token = await refresh();
        this.#refreshing = false;
        if (token !== null && token.length > 0) {
          this.#attempt = 0;
          this.#scheduleReconnect(0);
          return;
        }
        this.#handlers.onAuthFailure(new LuxoraApiError({
          code: "UNAUTHENTICATED",
          message: "The session could not be refreshed",
          status: 401
        }));
      } catch (error) {
        this.#refreshing = false;
        this.#handlers.onAuthFailure(toLuxoraError(error, "The session could not be refreshed"));
      }
    })();
  }

  #onClose(code: number, reason: string): void {
    this.#socket = null;
    this.#clearAuthTimer();
    this.#disarmWatchdog();
    if (this.#stopped) {
      this.#setStatus("idle");
      return;
    }
    if (this.#syncing) {
      // #runSyncRecovery owns the next connection attempt.
      return;
    }
    if (code === 4001) {
      this.#handleUnauthorizedClose();
      return;
    }
    if (code === 4009) {
      // The recovery frame normally already started; guard the rare case where
      // the socket closed before the frame was processed.
      this.#handleSyncRequired("connection_requires_sync");
      return;
    }
    if (code === 1000 && reason === "client_disconnect") {
      this.#setStatus("idle");
      return;
    }
    this.#scheduleReconnect();
  }

  #teardownSocketAndReconnect(): void {
    const socket = this.#socket;
    this.#socket = null;
    this.#clearAuthTimer();
    this.#disarmWatchdog();
    if (socket !== null) {
      try {
        socket.close(4000, "client_reconnect");
      } catch {
        // ignore
      }
    }
    if (this.#stopped || this.#syncing) return;
    this.#scheduleReconnect();
  }

  #backoffDelay(): number {
    const capped = Math.min(this.#maxBackoffMs, this.#baseBackoffMs * 2 ** Math.min(this.#attempt, 6));
    const jitter = capped * this.#jitterRatio * (this.#random() * 2 - 1);
    return Math.max(50, Math.round(capped + jitter));
  }

  #scheduleReconnect(delayOverride?: number): void {
    if (this.#stopped) return;
    if (this.#reconnectTimer !== null) return;
    if (this.#maxConsecutiveFailures > 0 && this.#attempt >= this.#maxConsecutiveFailures) {
      this.#setStatus("offline");
      return;
    }
    const delay = delayOverride ?? this.#backoffDelay();
    this.#attempt += 1;
    this.#setStatus("reconnecting");
    this.#reconnectTimer = this.#timers.setTimeout(() => {
      this.#reconnectTimer = null;
      if (this.#stopped) return;
      this.#openSocket();
    }, delay);
  }
}

export function createRealtimeClient(options: RealtimeClientOptions, handlers: RealtimeHandlers): RealtimeClient {
  return new RealtimeClient(options, handlers);
}
