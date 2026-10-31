/**
 * React provider + `useMessenger()` hook implementing the Lead-owned contract
 * in `./contract.ts`.
 *
 * Responsibilities:
 * - session boot/sign-in/sign-up/sign-out (access token memory-only, refresh
 *   token sessionStorage, realtime cursor sessionStorage);
 * - chat list + chat pages + optimistic outbox via the pure store;
 * - `/v2/realtime` lifecycle: apply durable events idempotently, typing and
 *   presence, full HTTP reload on `sync.required`, refresh-or-sign-out on 4001;
 * - uploads, drafts (debounced localStorage), typing throttle, receipt truth,
 *   message requests, and honest call signaling/media state.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode
} from "react";
import {
  LuxoraApiError,
  type Attachment,
  type Call,
  type Chat,
  type DurableRealtimeEvent,
  type Id,
  type MediaMode,
  type Message,
  type MessageRequest,
  type MessengerActions,
  type MessengerApi,
  type MessengerProviderProps,
  type MessengerState,
  type PublicProfile,
  type ReactionSummary,
  type SendMessageInput,
  type SignInInput,
  type SignUpInput,
  type UiMessage,
  type UploadProgress,
  type User
} from "./contract";
import {
  asLuxoraApiError,
  browserSessionStorage,
  createLuxoraApi,
  isLuxoraApiError,
  type LuxoraApiClient
} from "./core/api";
import { createCallMediaAdapter, type CallMediaConnection } from "./core/call-media";
import {
  createRealtimeClient,
  resolveRealtimeUrl,
  type CursorStorage,
  type RealtimeClient,
  type RealtimeConnectionStatus
} from "./core/realtime";
import {
  EMPTY_PAGE,
  addOptimisticMessage,
  applyCallSnapshot,
  applyDurableEvent,
  applyPresence,
  applyTyping,
  confirmOptimisticMessage,
  createInitialState,
  failOptimisticMessage,
  findMessageByNonce,
  markOptimisticSending,
  mergeChats,
  patchMembers,
  patchPage,
  patchReactions,
  pruneTyping,
  removeRequest,
  setChatsError,
  setChatsLoading,
  setConnection,
  setError,
  setMessagePage,
  setMessageReceipts,
  setNotice,
  setRequests,
  upsertChat
} from "./core/store";

/* --------------------------------------------------------------- constants */

const RETRIABLE_LOAD_PAGES = 5;
const DRAFT_STORAGE_PREFIX = "luxora.drafts.";
const REALTIME_CURSOR_KEY = "luxora.realtime.cursor";
const TYPING_THROTTLE_MS = 800;
const TYPING_IDLE_STOP_MS = 3_000;
const TYPING_PRUNE_INTERVAL_MS = 2_000;
const DRAFT_PERSIST_DEBOUNCE_MS = 300;
const RECEIPT_LOAD_LIMIT = 20;
const RECEIPT_LOAD_CONCURRENCY = 4;
const CALLS_NOT_CONNECTED_NOTICE = "Звонки не подключены в этой сборке Beta-0.1 — медиаплоскость не настроена";
const CALLS_MEDIA_UNAVAILABLE = "Медиаплоскость звонков не настроена на сервере";
const CALLS_MUTE_NOT_CONNECTED_NOTICE = "Микрофон станет доступен, когда медиа подключится";

type DraftMap = Record<Id, { text: string; replyToMessageId: Id | null }>;

const MessengerContext = createContext<MessengerApi | null>(null);

/* ---------------------------------------------------------------- helpers */

function describeError(error: unknown): string {
  const normalized = asLuxoraApiError(error);
  if (normalized.code === "NETWORK_ERROR") return "Не удалось связаться с сервером. Проверьте подключение.";
  return normalized.message.length > 0 ? normalized.message : normalized.code;
}

function isDocumentFocused(): boolean {
  try {
    if (typeof document === "undefined") return false;
    if (document.visibilityState === "hidden") return false;
    if (typeof document.hasFocus === "function") return document.hasFocus();
    return true;
  } catch {
    return false;
  }
}

function loadDraftsForUser(userId: Id): DraftMap {
  try {
    if (typeof window === "undefined") return {};
    const raw = window.localStorage.getItem(DRAFT_STORAGE_PREFIX + userId);
    if (raw === null) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (parsed === null || typeof parsed !== "object") return {};
    const drafts: DraftMap = {};
    for (const [chatId, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (value === null || typeof value !== "object") continue;
      const candidate = value as { text?: unknown; replyToMessageId?: unknown };
      if (typeof candidate.text !== "string" || candidate.text.length === 0) continue;
      drafts[chatId] = {
        text: candidate.text,
        replyToMessageId: typeof candidate.replyToMessageId === "string" ? candidate.replyToMessageId : null
      };
    }
    return drafts;
  } catch {
    return {};
  }
}

function persistDraftsForUser(userId: Id, drafts: DraftMap): void {
  try {
    if (typeof window === "undefined") return;
    if (Object.keys(drafts).length === 0) {
      window.localStorage.removeItem(DRAFT_STORAGE_PREFIX + userId);
      return;
    }
    window.localStorage.setItem(DRAFT_STORAGE_PREFIX + userId, JSON.stringify(drafts));
  } catch {
    // Draft persistence is a convenience; quota/privacy mode failures are fine.
  }
}

function removeRealtimeCursor(): void {
  try {
    browserSessionStorage()?.removeItem(REALTIME_CURSOR_KEY);
  } catch {
    // ignore
  }
}

function createSessionCursorStorage(): CursorStorage {
  const storage = browserSessionStorage();
  return {
    get: () => {
      try {
        return storage?.getItem(REALTIME_CURSOR_KEY) ?? null;
      } catch {
        return null;
      }
    },
    set: (value) => {
      try {
        if (value === null) storage?.removeItem(REALTIME_CURSOR_KEY);
        else storage?.setItem(REALTIME_CURSOR_KEY, value);
      } catch {
        // ignore quota/privacy-mode failures
      }
    }
  };
}

function codePointLength(value: string): number {
  return [...value].length;
}

/* ---------------------------------------------------------------- provider */

export function MessengerProvider({ children }: MessengerProviderProps): ReactNode {
  const [state, setState] = useState<MessengerState>(() => createInitialState(""));
  const stateRef = useRef<MessengerState>(state);
  const apiRef = useRef<LuxoraApiClient | null>(null);
  const realtimeRef = useRef<RealtimeClient | null>(null);
  const callMediaRef = useRef<CallMediaConnection | null>(null);
  const mediaConnectInFlightRef = useRef<Id | null>(null);
  const typingRef = useRef<Map<Id, { lastSentAt: number; stopTimer: ReturnType<typeof setTimeout> | null }>>(new Map());
  const outboxInputsRef = useRef<Map<Id, SendMessageInput>>(new Map());
  const uploadedAttachmentsRef = useRef<Map<Id, Attachment>>(new Map());
  const draftsRef = useRef<DraftMap>({});
  const handleSessionExpiredRef = useRef<(error: LuxoraApiError) => void>(() => undefined);
  const [bootAttempt, setBootAttempt] = useState(0);

  const apply = useCallback((updater: (previous: MessengerState) => MessengerState): void => {
    setState((previous) => {
      const next = updater(previous);
      stateRef.current = next;
      return next;
    });
  }, []);

  useEffect(() => {
    stateRef.current = state;
    draftsRef.current = state.drafts;
  }, [state]);

  /* ---------------------------------------------------------------- loaders */

  const loadChats = useCallback(async (): Promise<void> => {
    const api = apiRef.current;
    if (api === null) return;
    apply((previous) => setChatsLoading(previous, true));
    try {
      const items: Chat[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < RETRIABLE_LOAD_PAGES; page += 1) {
        const result = await api.listChats({ limit: 100, cursor });
        items.push(...result.items);
        if (result.nextCursor === null || result.nextCursor.length === 0) break;
        cursor = result.nextCursor;
      }
      apply((previous) => {
        const next = mergeChats(previous, items, "replace");
        return { ...next, chatsLoading: false, chatsError: null };
      });
    } catch (error) {
      apply((previous) => setChatsError(previous, describeError(error)));
    }
  }, [apply]);

  const loadRequests = useCallback(async (): Promise<void> => {
    const api = apiRef.current;
    if (api === null) return;
    apply((previous) => setRequests(previous, { loading: true, error: null }));
    try {
      const loadDirection = async (direction: "incoming" | "outgoing"): Promise<MessageRequest[]> => {
        const items: MessageRequest[] = [];
        let cursor: string | undefined;
        for (let page = 0; page < RETRIABLE_LOAD_PAGES; page += 1) {
          const result = await api.listMessageRequests(direction, { limit: 50, cursor });
          items.push(...result.items);
          if (result.nextCursor === null || result.nextCursor.length === 0) break;
          cursor = result.nextCursor;
        }
        return items;
      };
      const [incoming, outgoing] = await Promise.all([loadDirection("incoming"), loadDirection("outgoing")]);
      apply((previous) => setRequests(previous, {
        incoming,
        outgoing,
        loading: false,
        error: null
      }));
    } catch (error) {
      apply((previous) => setRequests(previous, { loading: false, error: describeError(error) }));
    }
  }, [apply]);

  const refreshMe = useCallback(async (): Promise<void> => {
    const api = apiRef.current;
    if (api === null) return;
    try {
      const user = await api.getMe();
      apply((previous) => ({ ...previous, user }));
    } catch (error) {
      if (!isLuxoraApiError(error) || error.code !== "UNAUTHENTICATED") {
        apply((previous) => setError(previous, describeError(error)));
      }
    }
  }, [apply]);

  /* -------------------------------------------------------------- receipts */

  const markReadInternal = useCallback(async (
    chatId: Id,
    messageId: Id,
    silent: boolean
  ): Promise<void> => {
    const api = apiRef.current;
    if (api === null) return;
    apply((previous) => ({
      ...previous,
      chats: previous.chats.map((chat) => (chat.id === chatId ? { ...chat, unreadCount: 0 } : chat)),
      activeChat: previous.activeChat?.id === chatId ? { ...previous.activeChat, unreadCount: 0 } : previous.activeChat
    }));
    try {
      await api.markRead(chatId, messageId);
    } catch (error) {
      if (!silent) apply((previous) => setError(previous, describeError(error)));
    }
  }, [apply]);

  const markDeliveredInternal = useCallback(async (
    chatId: Id,
    messageId: Id,
    silent: boolean
  ): Promise<void> => {
    const api = apiRef.current;
    if (api === null) return;
    try {
      await api.markDelivered(chatId, messageId);
    } catch (error) {
      if (!silent) apply((previous) => setError(previous, describeError(error)));
    }
  }, [apply]);

  /**
   * AUTHORITATIVE receipt projection only: up to 20 newest own non-deleted
   * messages, concurrency 4, silent failures. Realtime events never mark
   * `complete`, so ticks can never overclaim.
   */
  const loadReceiptsForChat = useCallback(async (chatId: Id): Promise<void> => {
    const api = apiRef.current;
    const selfId = stateRef.current.user?.id ?? null;
    if (api === null || selfId === null) return;
    const rows = (stateRef.current.messages[chatId] ?? [])
      .filter((message) => message.sender.id === selfId && message.deletedAt === null)
      .slice(-RECEIPT_LOAD_LIMIT)
      .reverse();
    if (rows.length === 0) return;
    let index = 0;
    const worker = async (): Promise<void> => {
      while (index < rows.length) {
        const message = rows[index];
        index += 1;
        try {
          const items = await api.getReceipts(message.id);
          apply((previous) => setMessageReceipts(previous, message.id, items));
        } catch {
          // Silent: without the authoritative read the UI keeps the sent tick.
        }
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(RECEIPT_LOAD_CONCURRENCY, rows.length) }, () => worker())
    );
  }, [apply]);

  /* -------------------------------------------------------------- calls */

  const disconnectCallMedia = useCallback((): void => {
    const connection = callMediaRef.current;
    callMediaRef.current = null;
    mediaConnectInFlightRef.current = null;
    if (connection !== null) void connection.disconnect().catch(() => undefined);
  }, []);

  const connectCallMedia = useCallback(async (call: Call): Promise<void> => {
    const api = apiRef.current;
    if (api === null) return;
    // Idempotent: the realtime state.changed stream and the local accept action
    // can both ask for media; only one connection is ever created per call.
    if (callMediaRef.current !== null || mediaConnectInFlightRef.current === call.callId) return;
    mediaConnectInFlightRef.current = call.callId;
    const capabilities = stateRef.current.capabilities;
    if (capabilities?.features.calls !== true) {
      // Honest: the server does not run a media plane, so it is never "connected".
      apply((previous) => ({
        ...previous,
        call: { ...previous.call, media: "unavailable", mediaError: CALLS_MEDIA_UNAVAILABLE }
      }));
      return;
    }
    apply((previous) => ({ ...previous, call: { ...previous.call, media: "connecting", mediaError: null } }));
    try {
      const grant = await api.issueJoinGrant(
        call.callId,
        call.mediaMode === "video" ? ["microphone", "camera"] : ["microphone"]
      );
      const adapter = createCallMediaAdapter(true);
      const connection = await adapter.connect({
        grant,
        mediaMode: call.mediaMode,
        onStateChange: (media, error) => {
          apply((previous) => ({
            ...previous,
            call: { ...previous.call, media, mediaError: error ?? null }
          }));
        }
      });
      callMediaRef.current = connection;
    } catch (error) {
      const normalized = asLuxoraApiError(error);
      apply((previous) => ({
        ...previous,
        call: {
          ...previous.call,
          media: "unavailable",
          mediaError: normalized.code === "SERVICE_UNAVAILABLE"
            ? CALLS_MEDIA_UNAVAILABLE
            : describeError(normalized)
        }
      }));
    } finally {
      if (mediaConnectInFlightRef.current === call.callId) mediaConnectInFlightRef.current = null;
    }
  }, [apply]);

  const handleCallStateChanged = useCallback(async (event: {
    callId: Id;
    chatId: Id;
    state: Call["state"];
    revision: number;
  }): Promise<void> => {
    const api = apiRef.current;
    if (api === null) return;
    try {
      const call = await api.getCall(event.callId);
      const selfId = stateRef.current.user?.id ?? null;
      const mine = call.participants.find((participant) => participant.memberId === selfId);
      const isCreator = call.creatorMemberId === selfId;
      const current = stateRef.current.call;
      const isEnded = call.state === "ended" || call.endedAtMs !== null;
      if (isEnded) {
        const wasMine = current.active?.callId === call.callId || current.incoming?.callId === call.callId;
        if (wasMine) {
          disconnectCallMedia();
          apply((previous) => ({
            ...previous,
            call: {
              ...previous.call,
              active: previous.call.active?.callId === call.callId ? null : previous.call.active,
              incoming: previous.call.incoming?.callId === call.callId ? null : previous.call.incoming,
              media: "unavailable",
              mediaError: null
            }
          }));
        }
        return;
      }
      const incoming =
        mine !== undefined &&
        !isCreator &&
        (mine.status === "invited" || mine.status === "ringing") &&
        current.active === null;
      if (incoming) {
        apply((previous) => ({
          ...previous,
          call: { ...previous.call, incoming: call, media: "unavailable", mediaError: null }
        }));
        return;
      }
      if (current.active?.callId === call.callId) {
        apply((previous) => ({ ...previous, call: { ...previous.call, active: call } }));
      } else if (current.incoming?.callId === call.callId) {
        apply((previous) => ({ ...previous, call: { ...previous.call, incoming: call } }));
      }
      // The creator must not request media while the call is still ringing: the
      // server only issues join grants once a participant accepted (403 before
      // that). Join media when the call reaches a joinable state, from either
      // participant, once.
      const joinable =
        stateRef.current.capabilities?.features.calls === true &&
        mine !== undefined &&
        callMediaRef.current === null &&
        (call.state === "connecting" || call.state === "active");
      if (joinable) void connectCallMedia(call);
    } catch {
      // The call projection is pollable; the next state.changed or user action retries.
    }
  }, [apply, connectCallMedia, disconnectCallMedia]);

  /* ------------------------------------------------------------ sync reload */

  const syncReload = useCallback(async (): Promise<void> => {
    const api = apiRef.current;
    if (api === null) return;
    await Promise.all([loadChats(), loadRequests()]);
    const activeChatId = stateRef.current.activeChatId;
    if (activeChatId === null) return;
    try {
      const limit = stateRef.current.capabilities?.limits.defaultPageItems ?? 30;
      const [chat, members, page] = await Promise.all([
        api.getChat(activeChatId),
        api.listMembers(activeChatId),
        api.listMessages(activeChatId, { limit })
      ]);
      apply((previous) => {
        let next = setMessagePage(previous, activeChatId, page.items, page.nextCursor);
        next = upsertChat(next, { ...chat, unreadCount: 0 });
        next = patchMembers(next, activeChatId, members);
        return { ...next, activeChat: { ...chat, unreadCount: 0 } };
      });
      void loadReceiptsForChat(activeChatId);
    } catch (error) {
      apply((previous) => setError(previous, describeError(error)));
    }
  }, [apply, loadChats, loadReceiptsForChat, loadRequests]);

  /* --------------------------------------------------------- session expiry */

  const handleSessionExpired = useCallback((error: LuxoraApiError): void => {
    realtimeRef.current?.disconnect();
    realtimeRef.current = null;
    disconnectCallMedia();
    removeRealtimeCursor();
    apply((previous) => ({
      ...createInitialState(previous.serverUrl),
      phase: "anonymous",
      capabilities: previous.capabilities,
      error: describeError(error)
    }));
  }, [apply, disconnectCallMedia]);

  useEffect(() => {
    handleSessionExpiredRef.current = handleSessionExpired;
  }, [handleSessionExpired]);

  /* --------------------------------------------------------- realtime events */

  const handleRealtimeEvent = useCallback((event: DurableRealtimeEvent): void => {
    const api = apiRef.current;
    if (api === null) return;
    const selfId = stateRef.current.user?.id ?? null;
    apply((previous) => applyDurableEvent(previous, event, selfId));
    const wireType = (event as { type?: string }).type;
    switch (wireType) {
      case "message.created": {
        const message = (event as { message: Message }).message;
        if (!stateRef.current.chats.some((chat) => chat.id === message.chatId)) {
          void loadChats();
        }
        if (
          selfId !== null &&
          message.sender.id !== selfId &&
          stateRef.current.activeChatId === message.chatId
        ) {
          void markDeliveredInternal(message.chatId, message.id, true);
          if (isDocumentFocused()) void markReadInternal(message.chatId, message.id, true);
        }
        return;
      }
      case "chat.created": {
        const chat = (event as Extract<DurableRealtimeEvent, { type: "chat.created" }>).chat;
        if (!stateRef.current.chats.some((entry) => entry.id === chat.id)) void loadChats();
        return;
      }
      case "chat.member.changed":
        void loadChats();
        return;
      case "sync.invalidated": {
        const reason = (event as { reason?: string }).reason;
        if (reason === "profile_updated" || reason === "avatar_updated") {
          void refreshMe();
          void loadChats();
        } else {
          void loadChats();
        }
        return;
      }
      case "call.state.changed":
        void handleCallStateChanged(event as Extract<DurableRealtimeEvent, { type: "call.state.changed" }>);
        return;
      case "relationship.request.created":
      case "relationship.request.removed":
      case "relationship.request.expired":
        void loadRequests();
        return;
      case "relationship.request.accepted":
        void loadRequests();
        void loadChats();
        return;
      default:
        return;
    }
  }, [
    apply,
    handleCallStateChanged,
    loadChats,
    loadRequests,
    markDeliveredInternal,
    markReadInternal,
    refreshMe
  ]);

  const handleTypingFrame = useCallback((event: {
    chatId: Id;
    userId: Id;
    isTyping: boolean;
    expiresAt: string;
  }): void => {
    apply((previous) => applyTyping(
      previous,
      event.chatId,
      event.userId,
      event.isTyping,
      Date.parse(event.expiresAt)
    ));
  }, [apply]);

  const handlePresenceFrame = useCallback((event: {
    userId: Id;
    presence: "online" | "offline";
  }): void => {
    apply((previous) => applyPresence(previous, event.userId, event.presence));
  }, [apply]);

  const attachRealtime = useCallback((user: User): void => {
    const api = apiRef.current;
    if (api === null || realtimeRef.current !== null) return;
    const realtime = createRealtimeClient(
      {
        url: resolveRealtimeUrl(api.baseUrl, api.serverUrl.length > 0 ? api.serverUrl : undefined),
        getAccessToken: () => api.accessToken,
        refreshAccessToken: async () => {
          try {
            const tokens = await api.refresh();
            return tokens.accessToken;
          } catch {
            return null;
          }
        },
        cursorStorage: createSessionCursorStorage()
      },
      {
        onEvent: handleRealtimeEvent,
        onTyping: handleTypingFrame,
        onPresence: handlePresenceFrame,
        onStatus: (status: RealtimeConnectionStatus) => {
          apply((previous) => setConnection(previous, status));
        },
        onSyncRequired: async () => {
          await syncReload();
        },
        onAuthFailure: (error) => {
          handleSessionExpiredRef.current(error);
        },
        onError: (error) => {
          // Realtime errors are advisory: the HTTP path remains authoritative.
          if (error.code === "RATE_LIMITED" || error.code === "INTERNAL_ERROR") {
            apply((previous) => setError(previous, describeError(error)));
          }
        }
      }
    );
    realtimeRef.current = realtime;
    void user;
    realtime.connect();
  }, [apply, handlePresenceFrame, handleRealtimeEvent, handleTypingFrame, syncReload]);

  /* ------------------------------------------------------------ sign-in flow */

  const finishSignIn = useCallback((user: User): void => {
    const api = apiRef.current;
    if (api === null) return;
    apply((previous) => ({
      ...previous,
      phase: "ready",
      fatalError: null,
      user,
      serverUrl: api.serverUrl,
      drafts: loadDraftsForUser(user.id),
      error: null
    }));
    attachRealtime(user);
    void loadChats();
    void loadRequests();
  }, [apply, attachRealtime, loadChats, loadRequests]);

  /* ---------------------------------------------------------------- booting */

  useEffect(() => {
    let cancelled = false;
    const api = apiRef.current ?? createLuxoraApi({
      onAuthFailure: (error) => handleSessionExpiredRef.current(error)
    });
    apiRef.current = api;
    apply((previous) => ({
      ...previous,
      serverUrl: api.serverUrl,
      phase: "booting",
      fatalError: null,
      error: null
    }));
    void (async () => {
      try {
        const capabilities = await api.getCapabilities();
        if (cancelled) return;
        apply((previous) => ({
          ...previous,
          capabilities,
          serverUrl: api.serverUrl
        }));
        if (!api.hasStoredSession()) {
          apply((previous) => ({ ...previous, phase: "anonymous" }));
          return;
        }
        await api.refresh();
        if (cancelled) return;
        const user = await api.getMe();
        if (cancelled) return;
        finishSignIn(user);
      } catch (error) {
        if (cancelled) return;
        const normalized = asLuxoraApiError(error);
        if (normalized.code === "UNAUTHENTICATED") {
          api.clearSession();
          apply((previous) => ({ ...previous, phase: "anonymous", fatalError: null }));
        } else {
          apply((previous) => ({ ...previous, phase: "fatal", fatalError: describeError(normalized) }));
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [apply, bootAttempt, finishSignIn]);

  /* ---------------------------------------------------------------- actions */

  const signIn = useCallback(async (input: SignInInput): Promise<void> => {
    const api = apiRef.current;
    if (api === null) return;
    try {
      apply((previous) => ({ ...previous, error: null }));
      if (stateRef.current.capabilities === null) {
        const capabilities = await api.getCapabilities();
        apply((previous) => ({ ...previous, capabilities }));
      }
      const result = await api.login(input);
      let user = result.user;
      try {
        user = await api.getMe();
      } catch {
        // The login payload is authoritative enough for the first render.
      }
      finishSignIn(user);
    } catch (error) {
      const normalized = asLuxoraApiError(error);
      apply((previous) => setError(previous, describeError(normalized)));
      throw normalized;
    }
  }, [apply, finishSignIn]);

  const signUp = useCallback(async (input: SignUpInput): Promise<void> => {
    const api = apiRef.current;
    if (api === null) return;
    try {
      apply((previous) => ({ ...previous, error: null }));
      if (stateRef.current.capabilities === null) {
        const capabilities = await api.getCapabilities();
        apply((previous) => ({ ...previous, capabilities }));
      }
      const result = await api.register(input);
      finishSignIn(result.user);
    } catch (error) {
      const normalized = asLuxoraApiError(error);
      apply((previous) => setError(previous, describeError(normalized)));
      throw normalized;
    }
  }, [apply, finishSignIn]);

  const signOut = useCallback(async (): Promise<void> => {
    const api = apiRef.current;
    const current = stateRef.current;
    if (current.user !== null) persistDraftsForUser(current.user.id, current.drafts);
    const realtime = realtimeRef.current;
    realtimeRef.current = null;
    realtime?.disconnect();
    disconnectCallMedia();
    for (const entry of typingRef.current.values()) {
      if (entry.stopTimer !== null) clearTimeout(entry.stopTimer);
    }
    typingRef.current.clear();
    outboxInputsRef.current.clear();
    uploadedAttachmentsRef.current.clear();
    removeRealtimeCursor();
    try {
      if (api !== null) await api.logout();
    } catch {
      // Local sign-out must never depend on the network.
    }
    apply((previous) => ({
      ...createInitialState(previous.serverUrl),
      phase: "anonymous",
      capabilities: previous.capabilities
    }));
  }, [apply, disconnectCallMedia]);

  const retryBoot = useCallback((): void => {
    setBootAttempt((attempt) => attempt + 1);
  }, []);

  const dismissNotice = useCallback((): void => {
    apply((previous) => setNotice(previous, null));
  }, [apply]);

  const clearError = useCallback((): void => {
    apply((previous) => setError(previous, null));
  }, [apply]);

  const openChat = useCallback(async (chatId: Id): Promise<void> => {
    const api = apiRef.current;
    if (api === null) return;
    apply((previous) => ({
      ...previous,
      activeChatId: chatId,
      activeChat: previous.chats.find((chat) => chat.id === chatId) ?? previous.activeChat,
      pages: {
        ...previous.pages,
        [chatId]: { ...(previous.pages[chatId] ?? EMPTY_PAGE), loading: true, error: null }
      }
    }));
    try {
      const limit = stateRef.current.capabilities?.limits.defaultPageItems ?? 30;
      const [chat, members, page] = await Promise.all([
        api.getChat(chatId),
        api.listMembers(chatId),
        api.listMessages(chatId, { limit })
      ]);
      const activeChat = { ...chat, unreadCount: 0 };
      apply((previous) => {
        let next = setMessagePage(previous, chatId, page.items, page.nextCursor);
        next = upsertChat(next, activeChat);
        next = patchMembers(next, chatId, members);
        return { ...next, activeChatId: chatId, activeChat };
      });
      const newestMessageId = page.items[0]?.id;
      const selfId = stateRef.current.user?.id ?? null;
      if (newestMessageId !== undefined) {
        const newest = page.items[0];
        if (newest.sender.id !== selfId) void markReadInternal(chatId, newestMessageId, true);
        else void markDeliveredInternal(chatId, newestMessageId, true);
      }
      void loadReceiptsForChat(chatId);
    } catch (error) {
      apply((previous) => patchPage(
        setError(previous, describeError(error)),
        chatId,
        { loading: false, error: describeError(error) }
      ));
    }
  }, [apply, loadReceiptsForChat, markDeliveredInternal, markReadInternal]);

  const closeChat = useCallback((): void => {
    apply((previous) => ({ ...previous, activeChatId: null, activeChat: null }));
  }, [apply]);

  const loadOlder = useCallback(async (chatId: Id): Promise<void> => {
    const api = apiRef.current;
    if (api === null) return;
    const page = stateRef.current.pages[chatId] ?? EMPTY_PAGE;
    if (page.loading || page.nextCursor === null || page.nextCursor.length === 0) return;
    apply((previous) => patchPage(previous, chatId, { loading: true, error: null }));
    try {
      const result = await api.listMessages(chatId, { limit: 30, cursor: page.nextCursor });
      apply((previous) => {
        const current = previous.messages[chatId] ?? [];
        const older = [...result.items].reverse();
        const merged = [...older, ...current]
          .filter((message, index, list) => list.findIndex((entry) => entry.id === message.id) === index)
          .sort((left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt));
        return {
          ...previous,
          messages: { ...previous.messages, [chatId]: merged },
          pages: {
            ...previous.pages,
            [chatId]: { ...(previous.pages[chatId] ?? EMPTY_PAGE), nextCursor: result.nextCursor, loading: false, error: null }
          }
        };
      });
    } catch (error) {
      apply((previous) => patchPage(
        setError(previous, describeError(error)),
        chatId,
        { loading: false, error: describeError(error) }
      ));
    }
  }, [apply]);

  const sendMessage = useCallback(async (input: SendMessageInput): Promise<void> => {
    const api = apiRef.current;
    const user = stateRef.current.user;
    if (api === null || user === null) return;
    const body = (input.body ?? "").trim();
    const attachmentIds = input.attachmentIds ?? [];
    if (body.length === 0 && attachmentIds.length === 0) {
      apply((previous) => setError(previous, "Сообщение не может быть пустым"));
      return;
    }
    const maxCodePoints = stateRef.current.capabilities?.limits.maxMessageCodePoints ?? 10_000;
    if (codePointLength(body) > maxCodePoints) {
      apply((previous) => setError(previous, `Сообщение длиннее ${maxCodePoints} символов`));
      return;
    }
    if (attachmentIds.length > (stateRef.current.capabilities?.limits.maxAttachmentsPerMessage ?? 10)) {
      apply((previous) => setError(previous, "Слишком много вложений в одном сообщении"));
      return;
    }
    const clientNonce = api.newId();
    outboxInputsRef.current.set(clientNonce, { ...input, body, attachmentIds });
    const attachments = attachmentIds
      .map((id) => uploadedAttachmentsRef.current.get(id))
      .filter((attachment): attachment is Attachment => attachment !== undefined);
    const now = new Date().toISOString();
    const optimistic: UiMessage = {
      id: clientNonce,
      chatId: input.chatId,
      sender: user,
      kind: attachmentIds.length > 0 ? "media" : "text",
      body: body.length > 0 ? body : null,
      replyToMessageId: input.replyToMessageId ?? null,
      topicId: null,
      forwardedFrom: null,
      attachments,
      transcriptionAllowed: input.transcriptionConsent === true,
      transcript: null,
      isPinned: false,
      clientNonce,
      revision: 0,
      createdAt: now,
      updatedAt: now,
      editedAt: null,
      deletedAt: null,
      _pending: true
    };
    apply((previous) => addOptimisticMessage(previous, optimistic));
    try {
      const message = await api.sendMessage(input.chatId, {
        body: body.length > 0 ? body : null,
        clientNonce,
        replyToMessageId: input.replyToMessageId ?? null,
        attachmentIds,
        transcriptionConsent: input.transcriptionConsent === true
      });
      apply((previous) => confirmOptimisticMessage(previous, message, user.id));
      outboxInputsRef.current.delete(clientNonce);
      apply((previous) => {
        const draft = previous.drafts[input.chatId];
        if (draft === undefined || draft.text !== (input.body ?? "")) return previous;
        return {
          ...previous,
          drafts: { ...previous.drafts, [input.chatId]: { text: "", replyToMessageId: null } }
        };
      });
    } catch (error) {
      apply((previous) => failOptimisticMessage(previous, input.chatId, clientNonce));
      apply((previous) => setError(previous, describeError(error)));
    }
  }, [apply]);

  const retrySend = useCallback(async (chatId: Id, clientNonce: Id): Promise<void> => {
    const api = apiRef.current;
    const user = stateRef.current.user;
    if (api === null || user === null) return;
    const input = outboxInputsRef.current.get(clientNonce);
    const row = findMessageByNonce(stateRef.current, chatId, clientNonce);
    if (input === undefined || row === undefined) return;
    apply((previous) => markOptimisticSending(previous, chatId, clientNonce));
    try {
      const message = await api.sendMessage(chatId, {
        body: (input.body ?? "").trim().length > 0 ? (input.body ?? "").trim() : null,
        clientNonce,
        replyToMessageId: input.replyToMessageId ?? null,
        attachmentIds: input.attachmentIds ?? [],
        transcriptionConsent: input.transcriptionConsent === true
      });
      apply((previous) => confirmOptimisticMessage(previous, message, user.id));
      outboxInputsRef.current.delete(clientNonce);
    } catch (error) {
      apply((previous) => failOptimisticMessage(previous, chatId, clientNonce));
      apply((previous) => setError(previous, describeError(error)));
    }
  }, [apply]);

  const editMessage = useCallback(async (
    messageId: Id,
    body: string,
    expectedRevision: number
  ): Promise<void> => {
    const api = apiRef.current;
    if (api === null) return;
    const trimmed = body.trim();
    if (trimmed.length === 0) {
      apply((previous) => setError(previous, "Текст сообщения не может быть пустым"));
      return;
    }
    try {
      const message = await api.editMessage(messageId, trimmed, expectedRevision);
      apply((previous) => applyDurableEvent(previous, { type: "message.updated", message }, previous.user?.id ?? null));
    } catch (error) {
      apply((previous) => setError(previous, describeError(error)));
    }
  }, [apply]);

  const deleteMessage = useCallback(async (messageId: Id): Promise<void> => {
    const api = apiRef.current;
    if (api === null) return;
    try {
      const message = await api.deleteMessage(messageId);
      apply((previous) => applyDurableEvent(previous, { type: "message.deleted", message }, previous.user?.id ?? null));
    } catch (error) {
      apply((previous) => setError(previous, describeError(error)));
    }
  }, [apply]);

  const toggleReaction = useCallback(async (messageId: Id, emoji: string): Promise<void> => {
    const api = apiRef.current;
    if (api === null) return;
    const existing = stateRef.current.reactions[messageId] ?? [];
    const mine = existing.find((reaction) => reaction.emoji === emoji)?.reactedByMe === true;
    try {
      const reactions = await api.setReaction(messageId, emoji, !mine);
      apply((previous) => patchReactions(previous, messageId, reactions));
    } catch (error) {
      apply((previous) => setError(previous, describeError(error)));
    }
  }, [apply]);

  const loadReactions = useCallback(async (messageId: Id): Promise<ReactionSummary[]> => {
    const api = apiRef.current;
    if (api === null) return [];
    try {
      const reactions = await api.getReactions(messageId);
      apply((previous) => patchReactions(previous, messageId, reactions));
      return reactions;
    } catch (error) {
      apply((previous) => setError(previous, describeError(error)));
      return [];
    }
  }, [apply]);

  const markRead = useCallback(async (chatId: Id, messageId: Id): Promise<void> => {
    await markReadInternal(chatId, messageId, false);
  }, [markReadInternal]);

  const markDelivered = useCallback(async (chatId: Id, messageId: Id): Promise<void> => {
    await markDeliveredInternal(chatId, messageId, false);
  }, [markDeliveredInternal]);

  const setDraft = useCallback((chatId: Id, text: string, replyToMessageId?: Id | null): void => {
    apply((previous) => {
      const nextReply = replyToMessageId ?? null;
      const current = previous.drafts[chatId];
      if (current !== undefined && current.text === text && current.replyToMessageId === nextReply) return previous;
      if (text.length === 0 && nextReply === null) {
        const drafts = { ...previous.drafts };
        delete drafts[chatId];
        return { ...previous, drafts };
      }
      return {
        ...previous,
        drafts: { ...previous.drafts, [chatId]: { text, replyToMessageId: nextReply } }
      };
    });
  }, [apply]);

  const setTyping = useCallback((chatId: Id, typing: boolean): void => {
    const realtime = realtimeRef.current;
    if (realtime === null) return;
    const now = Date.now();
    const entry = typingRef.current.get(chatId) ?? { lastSentAt: 0, stopTimer: null };
    if (entry.stopTimer !== null) {
      clearTimeout(entry.stopTimer);
      entry.stopTimer = null;
    }
    if (typing) {
      if (now - entry.lastSentAt >= TYPING_THROTTLE_MS) {
        realtime.sendTyping(chatId, true);
        entry.lastSentAt = now;
      }
      entry.stopTimer = setTimeout(() => {
        realtime.sendTyping(chatId, false);
        const tracked = typingRef.current.get(chatId);
        if (tracked !== undefined && tracked.stopTimer !== null) {
          tracked.stopTimer = null;
          tracked.lastSentAt = Date.now();
        }
      }, TYPING_IDLE_STOP_MS);
    } else {
      realtime.sendTyping(chatId, false);
      entry.lastSentAt = now;
    }
    typingRef.current.set(chatId, entry);
  }, []);

  const uploadFile = useCallback(async (
    file: File,
    progress?: UploadProgress
  ): Promise<Attachment> => {
    const api = apiRef.current;
    if (api === null) {
      throw new LuxoraApiError({ code: "INTERNAL_ERROR", message: "The messenger is not ready", status: 0 });
    }
    if (stateRef.current.capabilities?.features.mediaUploads === false) {
      throw new LuxoraApiError({
        code: "SERVICE_UNAVAILABLE",
        message: "Uploads are not available in this build",
        status: 503
      });
    }
    const maxBytes = stateRef.current.capabilities?.limits.maxAttachmentBytes ?? 100 * 1024 * 1024;
    if (file.size > maxBytes) {
      const error = new LuxoraApiError({
        code: "VALIDATION_FAILED",
        message: `File is larger than the ${maxBytes} byte limit`,
        status: 400
      });
      apply((previous) => setError(previous, describeError(error)));
      throw error;
    }
    try {
      const attachment = await api.uploadFile(file, progress);
      uploadedAttachmentsRef.current.set(attachment.id, attachment);
      return attachment;
    } catch (error) {
      const normalized = asLuxoraApiError(error);
      apply((previous) => setError(previous, describeError(normalized)));
      throw normalized;
    }
  }, [apply]);

  const authBlob = useCallback(async (path: string): Promise<Blob> => {
    const api = apiRef.current;
    if (api === null) {
      throw new LuxoraApiError({ code: "INTERNAL_ERROR", message: "The messenger is not ready", status: 0 });
    }
    return api.authBlob(path);
  }, []);

  const lookupUser = useCallback(async (username: string): Promise<PublicProfile | null> => {
    const api = apiRef.current;
    if (api === null) return null;
    try {
      return await api.lookupUser(username);
    } catch (error) {
      apply((previous) => setError(previous, describeError(error)));
      return null;
    }
  }, [apply]);

  const startDirectChat = useCallback(async (userId: Id): Promise<Chat> => {
    const api = apiRef.current;
    if (api === null) {
      throw new LuxoraApiError({ code: "INTERNAL_ERROR", message: "The messenger is not ready", status: 0 });
    }
    try {
      const chat = await api.createChat({ kind: "direct", userId });
      apply((previous) => upsertChat(previous, chat));
      void openChat(chat.id);
      return chat;
    } catch (error) {
      const normalized = asLuxoraApiError(error);
      apply((previous) => setError(previous, describeError(normalized)));
      throw normalized;
    }
  }, [apply, openChat]);

  const acceptRequest = useCallback(async (requestId: Id): Promise<void> => {
    const api = apiRef.current;
    if (api === null) return;
    try {
      const result = await api.acceptMessageRequest(requestId);
      apply((previous) => {
        const next = removeRequest(previous, requestId);
        return upsertChat(next, result.chat);
      });
      void openChat(result.chat.id);
    } catch (error) {
      apply((previous) => setError(previous, describeError(error)));
    }
  }, [apply, openChat]);

  const declineRequest = useCallback(async (requestId: Id): Promise<void> => {
    const api = apiRef.current;
    if (api === null) return;
    try {
      await api.dismissMessageRequest(requestId);
      apply((previous) => removeRequest(previous, requestId));
    } catch (error) {
      apply((previous) => setError(previous, describeError(error)));
    }
  }, [apply]);

  const sendMessageRequest = useCallback(async (targetUserId: Id, text: string): Promise<void> => {
    const api = apiRef.current;
    if (api === null) return;
    const max = stateRef.current.capabilities?.limits.maxMessageRequestCodePoints ?? 1_000;
    if (codePointLength(text.trim()) === 0 || codePointLength(text.trim()) > max) {
      const error = new LuxoraApiError({
        code: "VALIDATION_FAILED",
        message: `Message request text must be 1-${max} characters`,
        status: 400
      });
      apply((previous) => setError(previous, describeError(error)));
      throw error;
    }
    try {
      const request = await api.createMessageRequest(targetUserId, text.trim());
      apply((previous) => ({
        ...previous,
        requests: { ...previous.requests, outgoing: [request, ...previous.requests.outgoing] }
      }));
      apply((previous) => setNotice(previous, "Запрос отправлен"));
    } catch (error) {
      const normalized = asLuxoraApiError(error);
      apply((previous) => setError(previous, describeError(normalized)));
      throw normalized;
    }
  }, [apply]);

  const startCall = useCallback(async (chatId: Id, mediaMode: MediaMode): Promise<void> => {
    const api = apiRef.current;
    if (api === null) return;
    if (stateRef.current.call.active !== null || stateRef.current.call.incoming !== null) {
      apply((previous) => setNotice(previous, "Уже есть активный звонок"));
      return;
    }
    const mediaPlane = stateRef.current.capabilities?.features.calls === true;
    try {
      const result = await api.createCall(chatId, mediaMode);
      const selfId = stateRef.current.user?.id ?? null;
      const active = result.call;
      apply((previous) => ({
        ...previous,
        call: {
          ...previous.call,
          active,
          incoming: null,
          media: mediaPlane ? "connecting" : "unavailable",
          mediaError: mediaPlane ? null : CALLS_MEDIA_UNAVAILABLE,
          muted: false
        }
      }));
      if (!mediaPlane) {
        apply((previous) => setNotice(previous, CALLS_NOT_CONNECTED_NOTICE));
      }
      if (active.creatorMemberId === selfId) {
        try {
          const ringing = await api.ringCall(active.callId, active.revision);
          apply((previous) => applyCallSnapshot(previous, ringing));
        } catch (error) {
          apply((previous) => setError(previous, describeError(error)));
        }
      }
      // Media is joined from handleCallStateChanged once a participant accepts;
      // requesting a join grant while ringing is rejected by the server.
    } catch (error) {
      const normalized = asLuxoraApiError(error);
      apply((previous) => setError(previous, describeError(normalized)));
      if (normalized.code === "SERVICE_UNAVAILABLE") {
        apply((previous) => setNotice(previous, CALLS_NOT_CONNECTED_NOTICE));
      }
    }
  }, [apply]);

  const acceptCall = useCallback(async (): Promise<void> => {
    const api = apiRef.current;
    const incoming = stateRef.current.call.incoming;
    if (api === null || incoming === null) return;
    try {
      const accepted = await api.acceptCall(incoming.callId, incoming.revision);
      const mediaPlane = stateRef.current.capabilities?.features.calls === true;
      apply((previous) => ({
        ...previous,
        call: {
          ...previous.call,
          incoming: null,
          active: accepted,
          media: mediaPlane ? "connecting" : "unavailable",
          mediaError: mediaPlane ? null : CALLS_MEDIA_UNAVAILABLE,
          muted: false
        }
      }));
      await connectCallMedia(accepted);
    } catch (error) {
      apply((previous) => setError(previous, describeError(error)));
    }
  }, [apply, connectCallMedia]);

  const declineCall = useCallback(async (): Promise<void> => {
    const api = apiRef.current;
    const incoming = stateRef.current.call.incoming;
    if (api === null || incoming === null) return;
    try {
      await api.declineCall(incoming.callId, incoming.revision, "declined");
      apply((previous) => ({
        ...previous,
        call: { ...previous.call, incoming: null, media: "unavailable", mediaError: null, muted: false }
      }));
    } catch (error) {
      apply((previous) => setError(previous, describeError(error)));
    }
  }, [apply]);

  const hangupCall = useCallback(async (): Promise<void> => {
    const api = apiRef.current;
    const active = stateRef.current.call.active;
    if (api === null || active === null) return;
    const selfId = stateRef.current.user?.id ?? null;
    const scope: "self" | "everyone" = active.creatorMemberId === selfId ? "everyone" : "self";
    try {
      await api.hangupCall(active.callId, active.revision, scope);
    } catch (error) {
      apply((previous) => setError(previous, describeError(error)));
    } finally {
      disconnectCallMedia();
      apply((previous) => ({
        ...previous,
        call: { active: null, incoming: null, media: "unavailable", mediaError: null, muted: false }
      }));
    }
  }, [apply, disconnectCallMedia]);

  const toggleCallMute = useCallback(async (): Promise<void> => {
    const connection = callMediaRef.current;
    if (connection === null || stateRef.current.call.active === null) {
      apply((previous) => setNotice(previous, CALLS_MUTE_NOT_CONNECTED_NOTICE));
      return;
    }
    const nextMuted = !stateRef.current.call.muted;
    try {
      await connection.setMuted(nextMuted);
      apply((previous) => ({ ...previous, call: { ...previous.call, muted: nextMuted } }));
    } catch (error) {
      apply((previous) => setError(previous, describeError(asLuxoraApiError(error))));
    }
  }, [apply]);

  const dismissCall = useCallback((): void => {
    disconnectCallMedia();
    apply((previous) => ({
      ...previous,
      // An ended call is simply cleared; never mutate a live server record here.
      call: {
        ...previous.call,
        active: previous.call.active?.state === "ended" ? null : previous.call.active,
        incoming: previous.call.incoming?.state === "ended" ? null : previous.call.incoming,
        media: "unavailable",
        mediaError: null,
        muted: false
      }
    }));
  }, [apply, disconnectCallMedia]);

  const updateProfile = useCallback(async (patch: { displayName?: string; bio?: string }): Promise<void> => {
    const api = apiRef.current;
    if (api === null) return;
    try {
      const user = await api.updateMe(patch);
      apply((previous) => ({ ...previous, user }));
    } catch (error) {
      apply((previous) => setError(previous, describeError(error)));
    }
  }, [apply]);

  const searchChats = useCallback(async (query: string): Promise<Chat[]> => {
    const api = apiRef.current;
    if (api === null) return [];
    try {
      const result = await api.searchChats(query, { limit: 30 });
      apply((previous) => mergeChats(previous, result.items, "merge"));
      return result.items;
    } catch (error) {
      apply((previous) => setError(previous, describeError(error)));
      return [];
    }
  }, [apply]);

  /* --------------------------------------------------------------- effects */

  // Debounced per-account draft persistence (localStorage, never tokens).
  useEffect(() => {
    const userId = state.user?.id;
    if (userId === undefined) return;
    const timer = setTimeout(() => {
      persistDraftsForUser(userId, state.drafts);
    }, DRAFT_PERSIST_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [state.drafts, state.user?.id]);

  // Expire typing entries without waiting for another frame.
  useEffect(() => {
    const timer = setInterval(() => {
      apply((previous) => pruneTyping(previous, Date.now()));
    }, TYPING_PRUNE_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [apply]);

  // Network status + "read what is visible" behaviour.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const onOnline = (): void => {
      realtimeRef.current?.connect();
    };
    const onOffline = (): void => {
      apply((previous) => setConnection(previous, "offline"));
    };
    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOffline);
    return () => {
      window.removeEventListener("online", onOnline);
      window.removeEventListener("offline", onOffline);
    };
  }, [apply]);

  useEffect(() => {
    if (typeof document === "undefined") return;
    const markVisibleChatRead = (): void => {
      if (!isDocumentFocused()) return;
      const activeChatId = stateRef.current.activeChatId;
      if (activeChatId === null) return;
      const rows = stateRef.current.messages[activeChatId] ?? [];
      const newest = rows[rows.length - 1];
      if (newest === undefined || newest._pending === true) return;
      void markReadInternal(activeChatId, newest.id, true);
    };
    document.addEventListener("visibilitychange", markVisibleChatRead);
    window.addEventListener("focus", markVisibleChatRead);
    return () => {
      document.removeEventListener("visibilitychange", markVisibleChatRead);
      window.removeEventListener("focus", markVisibleChatRead);
    };
  }, [markReadInternal]);

  // Teardown: sockets, timers and a final synchronous draft flush.
  useEffect(() => {
    return () => {
      realtimeRef.current?.disconnect();
      realtimeRef.current = null;
      callMediaRef.current?.disconnect().catch(() => undefined);
      callMediaRef.current = null;
      for (const entry of typingRef.current.values()) {
        if (entry.stopTimer !== null) clearTimeout(entry.stopTimer);
      }
      typingRef.current.clear();
      const user = stateRef.current.user;
      if (user !== null) persistDraftsForUser(user.id, draftsRef.current);
    };
  }, []);

  /* ----------------------------------------------------------------- value */

  const actions = useMemo<MessengerActions>(() => ({
    signIn,
    signUp,
    signOut,
    retryBoot,
    dismissNotice,
    clearError,
    loadChats,
    openChat,
    closeChat,
    loadOlder,
    sendMessage,
    retrySend,
    editMessage,
    deleteMessage,
    toggleReaction,
    loadReactions,
    markRead,
    markDelivered,
    setDraft,
    setTyping,
    uploadFile,
    authBlob,
    lookupUser,
    startDirectChat,
    loadRequests,
    acceptRequest,
    declineRequest,
    sendMessageRequest,
    startCall,
    acceptCall,
    declineCall,
    hangupCall,
    dismissCall,
    toggleCallMute,
    updateProfile,
    searchChats
  }), [
    acceptCall,
    acceptRequest,
    authBlob,
    clearError,
    closeChat,
    declineCall,
    declineRequest,
    deleteMessage,
    dismissCall,
    dismissNotice,
    editMessage,
    hangupCall,
    loadChats,
    loadOlder,
    loadReactions,
    loadRequests,
    lookupUser,
    markDelivered,
    markRead,
    openChat,
    retryBoot,
    retrySend,
    searchChats,
    sendMessage,
    sendMessageRequest,
    setDraft,
    setTyping,
    signIn,
    signOut,
    signUp,
    startCall,
    startDirectChat,
    toggleCallMute,
    toggleReaction,
    updateProfile,
    uploadFile
  ]);

  const value = useMemo<MessengerApi>(() => ({ ...state, ...actions }), [state, actions]);

  return <MessengerContext.Provider value={value}>{children}</MessengerContext.Provider>;
}

/** Contract hook: every state field plus every action. */
export function useMessenger(): MessengerApi {
  const value = useContext(MessengerContext);
  if (value === null) {
    throw new Error("useMessenger must be used inside <MessengerProvider>");
  }
  return value;
}

/**
 * Convenience for the UI (additive export, not part of the contract): fetches an
 * authenticated binary path with the in-memory session token, exposes a blob
 * object URL, and revokes it on change/unmount. Never leaks a token into a URL.
 */
export function useAuthedObjectUrl(path: string | null | undefined): string | null {
  const messenger = useMessenger();
  const authBlobRef = useRef(messenger.authBlob);
  authBlobRef.current = messenger.authBlob;
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (path === null || path === undefined || path.length === 0) {
      setUrl(null);
      return;
    }
    let cancelled = false;
    let objectUrl: string | null = null;
    void (async () => {
      try {
        const blob = await authBlobRef.current(path);
        if (cancelled) return;
        if (typeof URL === "undefined" || typeof URL.createObjectURL !== "function") return;
        objectUrl = URL.createObjectURL(blob);
        setUrl(objectUrl);
      } catch {
        if (!cancelled) setUrl(null);
      }
    })();
    return () => {
      cancelled = true;
      if (objectUrl !== null) {
        try {
          URL.revokeObjectURL(objectUrl);
        } catch {
          // ignore
        }
      }
    };
  }, [path]);
  return url;
}

export default MessengerProvider;
