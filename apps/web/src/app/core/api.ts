/**
 * Typed REST client for the Luxora Beta-0.1 HTTP API.
 *
 * Design rules (see API.md §2-3, §5-9 and docs/specs/REALTIME_SYNC.md):
 * - The access token lives in memory only. The refresh token may live in
 *   sessionStorage; it is never written to localStorage.
 * - Every failure is normalized to `LuxoraApiError` with the server `code`,
 *   `message` and `requestId`. English `message` is never trusted as markup.
 * - Exactly one refresh request is in flight at a time. A 401 retries the
 *   original request once after the refresh; a failed refresh clears the token
 *   family and notifies the owner (which signs the session out).
 * - Response envelopes are parsed strictly: `{error:{code,message,requestId,details}}`
 *   for failures, the documented JSON body for success, `204` => void.
 */
import {
  DEFAULT_API_BASE,
  LuxoraApiError,
  type Attachment,
  type AuthResult,
  type Call,
  type Capabilities,
  type Chat,
  type ChatMember,
  type MediaMode,
  type Message,
  type MessageReceipt,
  type MessageRequest,
  type PublicProfile,
  type ReactionSummary,
  type SignInInput,
  type SignUpInput,
  type TokenBundle,
  type UploadProgress,
  type User
} from "../contract";

const REFRESH_TOKEN_STORAGE_KEY = "luxora.session.refresh-token";
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const UPLOAD_CHUNK_REQUEST_TIMEOUT_MS = 120_000;

/** Minimal storage surface (sessionStorage-compatible) so tests stay DOM-free. */
export interface KeyValueStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface LuxoraApiOptions {
  /** Explicit API base URL; defaults to `DEFAULT_API_BASE` (same origin). */
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  storage?: KeyValueStorage | null;
  randomId?: () => string;
  /** Called once when the refresh family is dead and the session must sign out. */
  onAuthFailure?: (error: LuxoraApiError) => void;
  requestTimeoutMs?: number;
}

export type Page<T> = { items: T[]; nextCursor: string | null };

export type UploadSession = {
  id: string;
  status: "active" | "completing" | "completed" | "failed" | "expired";
  fileName: string;
  sizeBytes: number;
  chunkSizeBytes: number;
  receivedBytes: number;
  receivedChunkIndexes: number[];
  expiresAt: string;
  attachment: Attachment | null;
  failureCode: string | null;
};

export type CreateUploadInput = {
  kind: Attachment["kind"];
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  sha256: string;
  idempotencyKey: string;
  metadata?: Record<string, unknown>;
};

export type SendMessageBody = {
  body?: string | null;
  clientNonce: string;
  replyToMessageId?: string | null;
  topicId?: string | null;
  attachmentIds?: string[];
  transcriptionConsent?: boolean;
};

export type JoinGrant = {
  serverUrl: string;
  token: string;
  tokenExpiresAtMs: number;
  participantIdentity: string;
  turn: {
    urls: string[];
    username: string;
    credential: string;
    expiresAtMs: number;
  };
  call: { callId: string; revision: number; epoch: number };
};

export type CreateCallResult = {
  call: Call;
  replayed: boolean;
  unreachableMemberIds: string[];
};

/* ------------------------------------------------------------- utilities */

/** Session-storage that is safe on the server and in unit tests. */
export function browserSessionStorage(): KeyValueStorage | null {
  try {
    if (typeof window === "undefined") return null;
    return window.sessionStorage;
  } catch {
    return null;
  }
}

export function randomId(): string {
  const cryptoImpl = globalThis.crypto;
  if (cryptoImpl !== undefined && typeof cryptoImpl.randomUUID === "function") {
    return cryptoImpl.randomUUID();
  }
  // Deterministic fallback is only reachable in exotic non-browser hosts.
  let value = "";
  for (let index = 0; index < 32; index += 1) {
    value += Math.floor(Math.random() * 16).toString(16);
    if (index === 7 || index === 11 || index === 15 || index === 19) value += "-";
  }
  return value;
}

export function stripTrailingSlashes(value: string): string {
  return value.replace(/\/+$/u, "");
}

/**
 * Read the loopback API origin injected by the Electron shell. Only loopback
 * http(s) origins are honored so a compromised bridge cannot point the client
 * at an arbitrary remote host; invalid values fall back to same-origin.
 */
function desktopApiBaseUrl(): string {
  try {
    if (typeof window === "undefined") return "";
    const value = window.luxoraDesktop?.apiBaseUrl;
    if (typeof value !== "string" || value.trim().length === 0) return "";
    const url = new URL(value.trim());
    const loopback = url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]";
    if (!loopback || (url.protocol !== "http:" && url.protocol !== "https:")) return "";
    if (url.username !== "" || url.password !== "") return "";
    return stripTrailingSlashes(url.href);
  } catch {
    return "";
  }
}

/**
 * Resolve the API base: an explicit option wins, then `VITE_LUXORA_API`
 * (through contract `DEFAULT_API_BASE`), then an Electron bridge-provided
 * loopback origin, then same-origin `""` (browser/Vite proxy).
 */
export function resolveApiBaseUrl(explicit?: string): string {
  const candidate = explicit ?? DEFAULT_API_BASE ?? "";
  const resolved = stripTrailingSlashes(candidate.trim());
  if (resolved.length > 0) return resolved;
  return desktopApiBaseUrl();
}

export function isLuxoraApiError(error: unknown): error is LuxoraApiError {
  return error instanceof LuxoraApiError;
}

export function asLuxoraApiError(error: unknown, fallbackMessage = "Unexpected client error"): LuxoraApiError {
  if (isLuxoraApiError(error)) return error;
  if (error instanceof Error) {
    const networkish = error instanceof TypeError || error.name === "AbortError";
    return new LuxoraApiError({
      code: networkish ? "NETWORK_ERROR" : "INTERNAL_ERROR",
      message: error.message.length > 0 ? error.message : fallbackMessage,
      status: 0
    });
  }
  return new LuxoraApiError({ code: "INTERNAL_ERROR", message: fallbackMessage, status: 0 });
}

/** Async SHA-256 over raw bytes, lowercase hex (crypto.subtle, no deps). */
export async function sha256Hex(bytes: Uint8Array | ArrayBuffer): Promise<string> {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (globalThis.crypto?.subtle === undefined) {
    throw new LuxoraApiError({
      code: "INTERNAL_ERROR",
      message: "WebCrypto is unavailable; uploads require a secure context",
      status: 0
    });
  }
  // Typed-array generics in modern TS lib do not narrow SharedArrayBuffer out
  // of `Uint8Array`; WebCrypto only needs the view at runtime.
  const digest = await globalThis.crypto.subtle.digest("SHA-256", view as unknown as BufferSource);
  let hex = "";
  for (const byte of new Uint8Array(digest)) {
    hex += byte.toString(16).padStart(2, "0");
  }
  return hex;
}

/**
 * Classify an upload by MIME. `image`/`file` are the paths the web UI relies
 * on; audio/video kinds are still typed honestly for future composers.
 */
export function inferAttachmentKind(mimeType: string, fileName: string): Attachment["kind"] {
  const mime = mimeType.toLowerCase();
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("video/")) return "video";
  if (mime.startsWith("audio/")) return "audio";
  const lowerName = fileName.toLowerCase();
  if (/\.(png|jpe?g|gif|webp|avif|heic|heif|bmp)$/u.test(lowerName)) return "image";
  if (/\.(mp4|webm|mov|m4v)$/u.test(lowerName)) return "video";
  if (/\.(mp3|wav|ogg|m4a|aac|flac)$/u.test(lowerName)) return "audio";
  return "file";
}

function fallbackCodeForStatus(status: number): string {
  switch (status) {
    case 400:
      return "BAD_REQUEST";
    case 401:
      return "UNAUTHENTICATED";
    case 403:
      return "FORBIDDEN";
    case 404:
      return "NOT_FOUND";
    case 409:
      return "CONFLICT";
    case 429:
      return "RATE_LIMITED";
    case 503:
      return "SERVICE_UNAVAILABLE";
    default:
      return status >= 500 ? "INTERNAL_ERROR" : "BAD_REQUEST";
  }
}

function unauthenticatedError(message = "Session is no longer active"): LuxoraApiError {
  return new LuxoraApiError({ code: "UNAUTHENTICATED", message, status: 401 });
}

/* ---------------------------------------------------------------- client */

export class LuxoraApiClient {
  readonly baseUrl: string;
  readonly #fetchImpl: typeof fetch;
  readonly #storage: KeyValueStorage | null;
  readonly #randomId: () => string;
  readonly #onAuthFailure?: (error: LuxoraApiError) => void;
  readonly #requestTimeoutMs: number;
  #accessToken: string | null = null;
  #refreshPromise: Promise<TokenBundle> | null = null;
  #authFailureNotified = false;

  constructor(options: LuxoraApiOptions = {}) {
    this.baseUrl = resolveApiBaseUrl(options.baseUrl);
    const globalFetch = globalThis.fetch;
    this.#fetchImpl = options.fetchImpl ?? (globalFetch === undefined ? undefined as never : globalFetch.bind(globalThis));
    if (options.fetchImpl === undefined && globalFetch === undefined) {
      throw new LuxoraApiError({
        code: "INTERNAL_ERROR",
        message: "fetch is unavailable in this runtime",
        status: 0
      });
    }
    this.#storage = options.storage === undefined ? browserSessionStorage() : options.storage;
    this.#randomId = options.randomId ?? randomId;
    this.#onAuthFailure = options.onAuthFailure;
    this.#requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  }

  /** Absolute server URL for display; same-origin resolves to the page origin. */
  get serverUrl(): string {
    if (this.baseUrl !== "") return this.baseUrl;
    if (typeof window !== "undefined" && window.location) return window.location.origin;
    return "";
  }

  get accessToken(): string | null {
    return this.#accessToken;
  }

  newId(): string {
    return this.#randomId();
  }

  hasStoredSession(): boolean {
    return (this.#storage?.getItem(REFRESH_TOKEN_STORAGE_KEY) ?? null) !== null;
  }

  /** Clear the in-memory access token and the stored refresh token. */
  clearSession(): void {
    this.#accessToken = null;
    this.#refreshPromise = null;
    this.#storage?.removeItem(REFRESH_TOKEN_STORAGE_KEY);
  }

  #setTokens(tokens: TokenBundle): void {
    this.#accessToken = tokens.accessToken;
    this.#storage?.setItem(REFRESH_TOKEN_STORAGE_KEY, tokens.refreshToken);
    this.#authFailureNotified = false;
  }

  #handleAuthFailure(error: LuxoraApiError): void {
    this.clearSession();
    if (this.#authFailureNotified) return;
    this.#authFailureNotified = true;
    this.#onAuthFailure?.(error);
  }

  /* -------------------------------------------------------------- transport */

  #url(path: string): string {
    if (/^https?:\/\//u.test(path)) return path;
    const suffix = path.startsWith("/") ? path : `/${path}`;
    return `${this.baseUrl}${suffix}`;
  }

  async #fetchRaw(
    method: string,
    path: string,
    options: {
      body?: BodyInit | null;
      headers?: Record<string, string>;
      auth?: boolean;
      accept?: string;
      timeoutMs?: number;
    } = {}
  ): Promise<Response> {
    const headers: Record<string, string> = { ...(options.headers ?? {}) };
    if (options.auth !== false && this.#accessToken !== null) {
      headers.authorization = `Bearer ${this.#accessToken}`;
    }
    if (options.accept !== undefined) headers.accept = options.accept;
    const controller = typeof AbortController === "function" ? new AbortController() : null;
    const timeoutMs = options.timeoutMs ?? this.#requestTimeoutMs;
    const timer = controller === null ? null : setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await this.#fetchImpl(this.#url(path), {
        method,
        headers,
        body: options.body,
        signal: controller?.signal,
        cache: "no-store",
        credentials: "omit",
        redirect: "follow"
      });
    } catch (error) {
      throw new LuxoraApiError({
        code: "NETWORK_ERROR",
        message: error instanceof Error && error.name === "AbortError"
          ? "The server did not answer in time"
          : "Could not reach the Luxora server",
        status: 0
      });
    } finally {
      if (timer !== null) clearTimeout(timer);
    }
  }

  async #parseError(response: Response): Promise<LuxoraApiError> {
    const status = response.status;
    let payload: unknown = null;
    try {
      const text = await response.text();
      payload = text.length === 0 ? null : JSON.parse(text) as unknown;
    } catch {
      payload = null;
    }
    const candidate = payload as { error?: Record<string, unknown> } | null;
    const envelope = candidate?.error;
    if (envelope !== undefined && envelope !== null && typeof envelope === "object") {
      const code = typeof envelope.code === "string" ? envelope.code : fallbackCodeForStatus(status);
      const message = typeof envelope.message === "string" ? envelope.message : response.statusText;
      const requestId = typeof envelope.requestId === "string" ? envelope.requestId : undefined;
      return new LuxoraApiError({
        code,
        message: message.length > 0 ? message : fallbackCodeForStatus(status),
        status,
        ...(requestId === undefined ? {} : { requestId }),
        ...(envelope.details === undefined ? {} : { details: envelope.details })
      });
    }
    return new LuxoraApiError({
      code: fallbackCodeForStatus(status),
      message: response.statusText.length > 0 ? response.statusText : `HTTP ${status}`,
      status
    });
  }

  async #send<T>(
    method: string,
    path: string,
    options: {
      body?: unknown;
      rawBody?: BodyInit;
      headers?: Record<string, string>;
      auth?: boolean;
      allowRefresh?: boolean;
      timeoutMs?: number;
      parse?: "json" | "none";
    } = {}
  ): Promise<T> {
    const headers: Record<string, string> = { ...(options.headers ?? {}) };
    let body: BodyInit | undefined;
    if (options.rawBody !== undefined) {
      body = options.rawBody;
    } else if (options.body !== undefined) {
      headers["content-type"] = "application/json";
      body = JSON.stringify(options.body);
    }
    const response = await this.#fetchRaw(method, path, {
      body,
      headers,
      auth: options.auth,
      accept: "application/json",
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs })
    });

    if (response.status === 401 && options.auth !== false && options.allowRefresh !== false) {
      const refreshed = await this.#refreshForRetry();
      if (refreshed) {
        return this.#send<T>(method, path, { ...options, allowRefresh: false });
      }
      throw unauthenticatedError();
    }
    if (!response.ok) {
      const error = await this.#parseError(response);
      if (response.status === 401 && options.auth !== false) {
        this.#handleAuthFailure(error);
      }
      throw error;
    }
    if (options.parse === "none" || response.status === 204) return undefined as T;
    const contentType = response.headers.get("content-type") ?? "";
    if (!contentType.includes("json")) return undefined as T;
    return await response.json() as T;
  }

  /** One in-flight refresh shared by concurrent 401 retries. */
  async #refreshForRetry(): Promise<boolean> {
    try {
      await this.refresh();
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Exchange the stored refresh token for a new token bundle. Concurrent
   * callers share the same in-flight request. On failure the token family is
   * cleared and `onAuthFailure` fires (sign-out), then the error is rethrown.
   */
  async refresh(): Promise<TokenBundle> {
    if (this.#refreshPromise === null) {
      this.#refreshPromise = (async () => {
        const refreshToken = this.#storage?.getItem(REFRESH_TOKEN_STORAGE_KEY) ?? null;
        if (refreshToken === null || refreshToken.length === 0) {
          throw unauthenticatedError("No refresh token is stored");
        }
        const response = await this.#send<{ tokens: TokenBundle }>("POST", "/v1/auth/refresh", {
          body: { refreshToken },
          auth: false,
          allowRefresh: false
        });
        if (response?.tokens === undefined) {
          throw unauthenticatedError("The server did not return a token bundle");
        }
        this.#setTokens(response.tokens);
        return response.tokens;
      })().finally(() => {
        this.#refreshPromise = null;
      });
    }
    try {
      return await this.#refreshPromise;
    } catch (error) {
      const normalized = asLuxoraApiError(error);
      this.#handleAuthFailure(normalized);
      throw normalized;
    }
  }

  /* ------------------------------------------------------------------- auth */

  async register(input: SignUpInput): Promise<AuthResult> {
    const body = {
      username: input.username,
      displayName: input.displayName,
      password: input.password,
      deviceName: input.deviceName
    };
    const result = await this.#send<AuthResult>("POST", "/v1/auth/register", {
      body,
      auth: false,
      allowRefresh: false
    });
    this.#setTokens(result.tokens);
    return result;
  }

  async login(input: SignInInput): Promise<AuthResult> {
    const body = {
      username: input.username,
      password: input.password,
      deviceName: input.deviceName
    };
    const result = await this.#send<AuthResult>("POST", "/v1/auth/login", {
      body,
      auth: false,
      allowRefresh: false
    });
    this.#setTokens(result.tokens);
    return result;
  }

  /**
   * Best-effort current-session revoke. Local tokens are cleared in every case
   * because the user asked to sign out.
   */
  async logout(): Promise<void> {
    if (this.#accessToken !== null || this.hasStoredSession()) {
      try {
        await this.#send<void>("DELETE", "/v1/auth/sessions/current", { parse: "none" });
      } catch {
        // Revocation is best-effort: never block local sign-out on the network.
      }
    }
    this.clearSession();
  }

  /* -------------------------------------------------------------- discovery */

  /** Account-free capability discovery; always safe to call before auth. */
  async getCapabilities(): Promise<Capabilities> {
    return this.#send<Capabilities>("GET", "/v1/capabilities", { auth: false, allowRefresh: false });
  }

  async getMe(): Promise<User> {
    const result = await this.#send<{ user: User }>("GET", "/v1/me");
    return result.user;
  }

  async updateMe(patch: { displayName?: string; bio?: string }): Promise<User> {
    const result = await this.#send<{ user: User }>("PATCH", "/v1/me", { body: patch });
    return result.user;
  }

  /* ------------------------------------------------------------------ chats */

  async listChats(params: { limit?: number; cursor?: string } = {}): Promise<Page<Chat>> {
    return this.#send<Page<Chat>>("GET", withQuery("/v1/chats", {
      limit: params.limit,
      cursor: params.cursor
    }));
  }

  async getChat(chatId: string): Promise<Chat> {
    const result = await this.#send<{ chat: Chat }>("GET", `/v1/chats/${encodeURIComponent(chatId)}`);
    return result.chat;
  }

  async createChat(input: { kind: "direct"; userId: string } | { kind: "group" | "channel"; title: string; memberIds?: string[] }): Promise<Chat> {
    const result = await this.#send<{ chat: Chat }>("POST", "/v1/chats", { body: input });
    return result.chat;
  }

  async listMembers(chatId: string): Promise<ChatMember[]> {
    const result = await this.#send<{ items: ChatMember[] }>("GET", `/v1/chats/${encodeURIComponent(chatId)}/members`);
    return result.items;
  }

  async searchChats(query: string, params: { limit?: number; cursor?: string } = {}): Promise<Page<Chat>> {
    return this.#send<Page<Chat>>("GET", withQuery("/v1/search/chats", {
      q: query,
      limit: params.limit,
      cursor: params.cursor
    }));
  }

  /* --------------------------------------------------------------- messages */

  async listMessages(
    chatId: string,
    params: { limit?: number; cursor?: string; topicId?: string } = {}
  ): Promise<Page<Message>> {
    return this.#send<Page<Message>>("GET", withQuery(`/v1/chats/${encodeURIComponent(chatId)}/messages`, {
      limit: params.limit,
      cursor: params.cursor,
      topicId: params.topicId
    }));
  }

  async sendMessage(chatId: string, input: SendMessageBody): Promise<Message> {
    const body: Record<string, unknown> = {
      clientNonce: input.clientNonce,
      body: input.body ?? null,
      replyToMessageId: input.replyToMessageId ?? null,
      attachmentIds: input.attachmentIds ?? []
    };
    if (input.topicId !== undefined && input.topicId !== null) body.topicId = input.topicId;
    if (input.transcriptionConsent === true) body.transcriptionConsent = true;
    const result = await this.#send<{ message: Message }>("POST", `/v1/chats/${encodeURIComponent(chatId)}/messages`, { body });
    return result.message;
  }

  async editMessage(messageId: string, body: string, expectedRevision?: number): Promise<Message> {
    const payload: Record<string, unknown> = { body };
    if (expectedRevision !== undefined) payload.expectedRevision = expectedRevision;
    const result = await this.#send<{ message: Message }>("PATCH", `/v1/messages/${encodeURIComponent(messageId)}`, {
      body: payload
    });
    return result.message;
  }

  async deleteMessage(messageId: string): Promise<Message> {
    const result = await this.#send<{ message: Message }>("DELETE", `/v1/messages/${encodeURIComponent(messageId)}`);
    return result.message;
  }

  async markRead(chatId: string, messageId: string): Promise<void> {
    await this.#send<void>("POST", `/v1/chats/${encodeURIComponent(chatId)}/read`, {
      body: { messageId },
      parse: "none"
    });
  }

  async markDelivered(chatId: string, messageId: string): Promise<void> {
    await this.#send<void>("POST", `/v1/chats/${encodeURIComponent(chatId)}/delivered`, {
      body: { messageId },
      parse: "none"
    });
  }

  async setReaction(messageId: string, emoji: string, add: boolean): Promise<ReactionSummary[]> {
    const path = `/v1/messages/${encodeURIComponent(messageId)}/reactions`;
    const result = await this.#send<{ items: ReactionSummary[] }>(add ? "PUT" : "DELETE", path, { body: { emoji } });
    return result.items;
  }

  async getReactions(messageId: string): Promise<ReactionSummary[]> {
    const result = await this.#send<{ items: ReactionSummary[] }>(
      "GET",
      `/v1/messages/${encodeURIComponent(messageId)}/reactions`
    );
    return result.items;
  }

  async getReceipts(messageId: string): Promise<MessageReceipt[]> {
    const result = await this.#send<{ items: MessageReceipt[] }>(
      "GET",
      `/v1/messages/${encodeURIComponent(messageId)}/receipts`
    );
    return result.items;
  }

  /* ------------------------------------------------------- message requests */

  async createMessageRequest(recipientUserId: string, body: string): Promise<MessageRequest> {
    const result = await this.#send<{ request: MessageRequest }>("POST", "/v1/message-requests", {
      body: { recipientUserId, body, clientNonce: this.#randomId() }
    });
    return result.request;
  }

  async listMessageRequests(
    direction: "incoming" | "outgoing",
    params: { limit?: number; cursor?: string } = {}
  ): Promise<Page<MessageRequest>> {
    return this.#send<Page<MessageRequest>>("GET", withQuery("/v1/message-requests", {
      direction,
      limit: params.limit,
      cursor: params.cursor
    }));
  }

  async acceptMessageRequest(requestId: string): Promise<{ request: MessageRequest; chat: Chat }> {
    return this.#send<{ request: MessageRequest; chat: Chat }>(
      "POST",
      `/v1/message-requests/${encodeURIComponent(requestId)}/accept`
    );
  }

  async dismissMessageRequest(requestId: string): Promise<void> {
    await this.#send<void>("DELETE", `/v1/message-requests/${encodeURIComponent(requestId)}`, { parse: "none" });
  }

  /* ------------------------------------------------------------------ users */

  async lookupUser(username: string): Promise<PublicProfile | null> {
    const result = await this.#send<{ profile: PublicProfile | null }>(
      "GET",
      withQuery("/v1/users/lookup", { username })
    );
    return result.profile;
  }

  async searchUsers(query: string, params: { limit?: number; cursor?: string } = {}): Promise<Page<User>> {
    return this.#send<Page<User>>("GET", withQuery("/v1/users/search", {
      q: query,
      limit: params.limit,
      cursor: params.cursor
    }));
  }

  /* ---------------------------------------------------------------- uploads */

  async createUpload(input: CreateUploadInput): Promise<UploadSession> {
    const result = await this.#send<{ upload: UploadSession }>("POST", "/v1/uploads", {
      body: {
        kind: input.kind,
        fileName: input.fileName,
        mimeType: input.mimeType,
        sizeBytes: input.sizeBytes,
        sha256: input.sha256,
        idempotencyKey: input.idempotencyKey,
        metadata: input.metadata ?? {}
      }
    });
    return result.upload;
  }

  async putUploadChunk(
    uploadId: string,
    index: number,
    bytes: Uint8Array,
    range: { start: number; end: number; total: number; sha256: string }
  ): Promise<UploadSession> {
    const result = await this.#send<{ upload: UploadSession }>(
      "PUT",
      `/v1/uploads/${encodeURIComponent(uploadId)}/chunks/${index}`,
      {
        rawBody: bytes as unknown as BodyInit,
        headers: {
          "content-type": "application/octet-stream",
          "content-range": `bytes ${range.start}-${range.end}/${range.total}`,
          "x-chunk-sha256": range.sha256
        },
        timeoutMs: UPLOAD_CHUNK_REQUEST_TIMEOUT_MS
      }
    );
    return result.upload;
  }

  async completeUpload(uploadId: string): Promise<UploadSession> {
    const result = await this.#send<{ upload: UploadSession }>(
      "POST",
      `/v1/uploads/${encodeURIComponent(uploadId)}/complete`,
      { timeoutMs: UPLOAD_CHUNK_REQUEST_TIMEOUT_MS }
    );
    return result.upload;
  }

  async listAttachments(params: { limit?: number; cursor?: string } = {}): Promise<Page<Attachment>> {
    return this.#send<Page<Attachment>>("GET", withQuery("/v1/attachments", {
      limit: params.limit,
      cursor: params.cursor
    }));
  }

  /**
   * Full upload pipeline: sha256, idempotent session create, sequential chunk
   * PUTs with per-chunk digest + Content-Range, complete, return attachment.
   */
  async uploadFile(file: File, progress?: UploadProgress): Promise<Attachment> {
    if (typeof file.arrayBuffer !== "function" || file.size <= 0) {
      throw new LuxoraApiError({
        code: "VALIDATION_FAILED",
        message: "An empty or unreadable file cannot be uploaded",
        status: 400
      });
    }
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (bytes.length !== file.size) {
      throw new LuxoraApiError({
        code: "VALIDATION_FAILED",
        message: "The file changed while it was being read",
        status: 400
      });
    }
    const fileSha256 = await sha256Hex(bytes);
    const kind = inferAttachmentKind(file.type, file.name);
    const session = await this.createUpload({
      kind,
      fileName: file.name.length > 0 ? file.name : "attachment",
      mimeType: (file.type.length > 0 ? file.type : "application/octet-stream").toLowerCase(),
      sizeBytes: bytes.length,
      sha256: fileSha256,
      idempotencyKey: this.#randomId(),
      metadata: {}
    });
    const chunkSize = session.chunkSizeBytes > 0 ? session.chunkSizeBytes : bytes.length;
    const totalBytes = session.sizeBytes > 0 ? session.sizeBytes : bytes.length;
    const chunkCount = Math.max(1, Math.ceil(totalBytes / chunkSize));
    progress?.(0);
    for (let index = 0; index < chunkCount; index += 1) {
      const start = index * chunkSize;
      const end = Math.min(totalBytes, start + chunkSize);
      const chunk = bytes.subarray(start, end);
      const chunkSha256 = await sha256Hex(chunk);
      await this.putUploadChunk(session.id, index, chunk, {
        start,
        end: end - 1,
        total: totalBytes,
        sha256: chunkSha256
      });
      progress?.(end / totalBytes);
    }
    const completed = await this.completeUpload(session.id);
    if (completed.attachment === null) {
      throw new LuxoraApiError({
        code: "SERVICE_UNAVAILABLE",
        message: "The server finished the upload without an attachment projection",
        status: 503
      });
    }
    progress?.(1);
    return completed.attachment;
  }

  /**
   * Authenticated binary GET for `/v1/attachments/:id/content|thumbnail` and
   * avatar projections. Tokens never appear in the URL.
   */
  async authBlob(path: string): Promise<Blob> {
    const response = await this.#fetchRaw("GET", path, {
      accept: "*/*",
      timeoutMs: UPLOAD_CHUNK_REQUEST_TIMEOUT_MS
    });
    if (response.status === 401) {
      const refreshed = await this.#refreshForRetry();
      if (refreshed) return this.authBlob(path);
      throw unauthenticatedError();
    }
    if (!response.ok) throw await this.#parseError(response);
    return await response.blob();
  }

  /* ------------------------------------------------------------------ calls */

  async createCall(chatId: string, mediaMode: MediaMode): Promise<CreateCallResult> {
    return this.#send<CreateCallResult>("POST", "/v1/calls", {
      body: { chatId, mediaMode, clientNonce: this.#randomId() }
    });
  }

  async getCall(callId: string): Promise<Call> {
    const result = await this.#send<{ call: Call }>("GET", `/v1/calls/${encodeURIComponent(callId)}`);
    return result.call;
  }

  async listCalls(chatId: string): Promise<Call[]> {
    const result = await this.#send<{ calls: Call[] }>("GET", withQuery("/v1/calls", { chatId }));
    return result.calls;
  }

  async ringCall(callId: string, expectedRevision: number): Promise<Call> {
    const result = await this.#send<{ call: Call }>("POST", `/v1/calls/${encodeURIComponent(callId)}/ring`, {
      body: { expectedRevision }
    });
    return result.call;
  }

  async acceptCall(callId: string, expectedRevision: number): Promise<Call> {
    const result = await this.#send<{ call: Call }>("POST", `/v1/calls/${encodeURIComponent(callId)}/accept`, {
      body: { expectedRevision }
    });
    return result.call;
  }

  async declineCall(callId: string, expectedRevision: number, reason: "declined" | "busy" = "declined"): Promise<Call> {
    const result = await this.#send<{ call: Call }>("POST", `/v1/calls/${encodeURIComponent(callId)}/decline`, {
      body: { expectedRevision, reason }
    });
    return result.call;
  }

  async hangupCall(callId: string, expectedRevision: number, scope: "self" | "everyone"): Promise<Call> {
    const result = await this.#send<{ call: Call }>("POST", `/v1/calls/${encodeURIComponent(callId)}/hangup`, {
      body: { expectedRevision, scope }
    });
    return result.call;
  }

  async issueJoinGrant(callId: string, requestedSources: Array<"microphone" | "camera">): Promise<JoinGrant> {
    return this.#send<JoinGrant>("POST", `/v1/calls/${encodeURIComponent(callId)}/join-grant`, {
      body: { requestedSources }
    });
  }
}

/* ------------------------------------------------------------- helpers */

type QueryValue = string | number | boolean | null | undefined;

export function withQuery(path: string, query: Record<string, QueryValue>): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === "") continue;
    parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`);
  }
  if (parts.length === 0) return path;
  return `${path}?${parts.join("&")}`;
}

/** Factory used by `messenger.tsx` (and tests). */
export function createLuxoraApi(options: LuxoraApiOptions = {}): LuxoraApiClient {
  return new LuxoraApiClient(options);
}
