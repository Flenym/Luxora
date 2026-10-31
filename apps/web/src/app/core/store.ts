/**
 * Pure state store for the Luxora web messenger.
 *
 * All helpers are framework-free and return a new `MessengerState` only when
 * something actually changed, so React re-renders stay predictable. The store
 * is the single place that encodes the project truth rules:
 * - durable events are merged idempotently by id / revision / clientNonce and
 *   ordered by the canonical server timestamps (never by local device time);
 * - optimistic sends are pending rows keyed by `clientNonce`; they become the
 *   canonical row on ack and stay as `_failed` rows for an explicit retry;
 * - unread counters, presence and receipts only follow server facts.
 */
import type {
  Call,
  Chat,
  ChatMember,
  ChatPageState,
  DurableRealtimeEvent,
  Id,
  Message,
  MessageReceipt,
  MessageReceiptState,
  MessageRequest,
  MessengerState,
  ReactionSummary,
  TypingEntry,
  UiMessage
} from "../contract";

/* --------------------------------------------------------------- initial */

export function createInitialState(serverUrl = ""): MessengerState {
  return {
    phase: "booting",
    fatalError: null,
    user: null,
    capabilities: null,
    serverUrl,
    connection: "idle",
    chats: [],
    chatsLoading: false,
    chatsError: null,
    activeChatId: null,
    activeChat: null,
    members: {},
    messages: {},
    pages: {},
    reactions: {},
    receipts: {},
    drafts: {},
    typing: {},
    presence: {},
    outbox: {},
    requests: { incoming: [], outgoing: [], loading: false, error: null },
    call: { active: null, incoming: null, media: "unavailable", mediaError: null },
    error: null,
    notice: null
  };
}

export const EMPTY_PAGE: ChatPageState = {
  nextCursor: null,
  loaded: false,
  loading: false,
  error: null
};

/* --------------------------------------------------------------- ordering */

export function compareMessages(
  left: Pick<Message, "createdAt" | "id">,
  right: Pick<Message, "createdAt" | "id">
): number {
  const leftTime = Date.parse(left.createdAt);
  const rightTime = Date.parse(right.createdAt);
  if (Number.isFinite(leftTime) && Number.isFinite(rightTime) && leftTime !== rightTime) {
    return leftTime - rightTime;
  }
  if (left.id === right.id) return 0;
  return left.id < right.id ? -1 : 1;
}

export function sortChats(chats: readonly Chat[]): Chat[] {
  return [...chats].sort((left, right) => {
    const leftActivity = Date.parse(left.lastActivityAt);
    const rightActivity = Date.parse(right.lastActivityAt);
    if (Number.isFinite(leftActivity) && Number.isFinite(rightActivity) && leftActivity !== rightActivity) {
      return rightActivity - leftActivity;
    }
    if (left.id === right.id) return 0;
    return left.id < right.id ? -1 : 1;
  });
}

/* ----------------------------------------------------------------- chats */

export function replaceChat(chats: readonly Chat[], chat: Chat): Chat[] {
  return sortChats([...chats.filter((entry) => entry.id !== chat.id), chat]);
}

/** Replace the whole list (initial load) or merge server rows into it. */
export function mergeChats(
  state: MessengerState,
  incoming: readonly Chat[],
  mode: "replace" | "merge" = "merge"
): MessengerState {
  if (mode === "replace") {
    return { ...state, chats: sortChats(incoming) };
  }
  let chats = state.chats;
  for (const chat of incoming) chats = replaceChat(chats, chat);
  return { ...state, chats };
}

export function upsertChat(state: MessengerState, chat: Chat): MessengerState {
  const activeChat = state.activeChatId === chat.id
    ? { ...(state.activeChat ?? chat), ...chat }
    : state.activeChat;
  return { ...state, chats: replaceChat(state.chats, chat), activeChat };
}

export function setChatsLoading(state: MessengerState, loading: boolean): MessengerState {
  return { ...state, chatsLoading: loading, chatsError: loading ? null : state.chatsError };
}

export function setChatsError(state: MessengerState, message: string | null): MessengerState {
  return { ...state, chatsLoading: false, chatsError: message };
}

function withChatUpdate(state: MessengerState, chatId: Id, updater: (chat: Chat) => Chat): MessengerState {
  const existing = state.chats.find((chat) => chat.id === chatId);
  if (existing === undefined) return state;
  return {
    ...state,
    chats: replaceChat(state.chats, updater(existing)),
    activeChat: state.activeChat?.id === chatId ? updater(state.activeChat) : state.activeChat
  };
}

/** Apply a canonical message to the UX chat row (last message / unread count). */
function applyMessageToChat(
  state: MessengerState,
  message: Message,
  selfUserId: Id | null,
  options: { countUnread: boolean }
): MessengerState {
  return withChatUpdate(state, message.chatId, (chat) => {
    const latest = chat.lastMessage;
    const shouldReplaceLast =
      latest === null ||
      latest.id === message.id ||
      compareMessages(latest, message) <= 0;
    const previousActivity = Date.parse(chat.lastActivityAt);
    const messageActivity = Date.parse(message.createdAt);
    const nextActivity =
      shouldReplaceLast && Number.isFinite(messageActivity) &&
      (!Number.isFinite(previousActivity) || messageActivity >= previousActivity)
        ? message.createdAt
        : chat.lastActivityAt;
    const isOwn = selfUserId !== null && message.sender.id === selfUserId;
    const viewing = state.activeChatId === message.chatId;
    const unreadCount = isOwn || viewing || !options.countUnread
      ? chat.unreadCount
      : Math.max(0, chat.unreadCount) + 1;
    return {
      ...chat,
      lastMessage: shouldReplaceLast ? message : chat.lastMessage,
      lastActivityAt: nextActivity,
      unreadCount: viewing ? 0 : unreadCount
    };
  });
}

/* -------------------------------------------------------------- messages */

/**
 * Merge canonical server messages into the local chronological (oldest first)
 * list. Dedupe precedence: server id first, then `clientNonce` for optimistic
 * rows, then the higher `revision`; equal revisions prefer the server row.
 */
export function mergeMessages(existing: readonly UiMessage[], incoming: readonly Message[]): UiMessage[] {
  if (incoming.length === 0) return existing as UiMessage[];
  const rowsById = new Map<string, UiMessage>();
  for (const row of existing) rowsById.set(row.id, row);
  const optimisticIdByNonce = new Map<string, string>();
  for (const row of existing) {
    if (row._pending === true || row._failed === true) optimisticIdByNonce.set(row.clientNonce, row.id);
  }

  for (const message of incoming) {
    const sameId = rowsById.get(message.id);
    const optimisticId = optimisticIdByNonce.get(message.clientNonce);
    if (sameId !== undefined) {
      if (message.revision >= sameId.revision) rowsById.set(message.id, { ...message });
      if (optimisticId !== undefined && optimisticId !== message.id) rowsById.delete(optimisticId);
      continue;
    }
    if (optimisticId !== undefined) {
      rowsById.delete(optimisticId);
      optimisticIdByNonce.delete(message.clientNonce);
    }
    rowsById.set(message.id, { ...message });
  }
  return [...rowsById.values()].sort(compareMessages);
}

export function messagesForChat(state: MessengerState, chatId: Id): UiMessage[] {
  return state.messages[chatId] ?? [];
}

/** Replace a freshly fetched page (newest-first from the server) for a chat. */
export function setMessagePage(
  state: MessengerState,
  chatId: Id,
  serverPageNewestFirst: readonly Message[],
  nextCursor: string | null,
  options: { preserveOptimistic?: boolean } = {}
): MessengerState {
  const pendingRows = (state.messages[chatId] ?? []).filter(
    (row) => row._pending === true || row._failed === true
  );
  const chronological = [...serverPageNewestFirst].reverse();
  const merged = mergeMessages(options.preserveOptimistic === false ? [] : pendingRows, chronological);
  return {
    ...state,
    messages: { ...state.messages, [chatId]: merged },
    pages: {
      ...state.pages,
      [chatId]: { nextCursor, loaded: true, loading: false, error: null }
    }
  };
}

/** Prepend an older page (newest-first from the server) before loaded rows. */
export function prependMessagePage(
  state: MessengerState,
  chatId: Id,
  serverPageNewestFirst: readonly Message[],
  nextCursor: string | null
): MessengerState {
  const existing = state.messages[chatId] ?? [];
  const older = [...serverPageNewestFirst].reverse();
  const merged = mergeMessages(older, existing);
  return {
    ...state,
    messages: { ...state.messages, [chatId]: merged },
    pages: {
      ...state.pages,
      [chatId]: { nextCursor, loaded: true, loading: false, error: null }
    }
  };
}

export function patchPage(state: MessengerState, chatId: Id, patch: Partial<ChatPageState>): MessengerState {
  const current = state.pages[chatId] ?? EMPTY_PAGE;
  return {
    ...state,
    pages: { ...state.pages, [chatId]: { ...current, ...patch } }
  };
}

export function patchMembers(
  state: MessengerState,
  chatId: Id,
  members: ChatMember[]
): MessengerState {
  return { ...state, members: { ...state.members, [chatId]: members } };
}

export function patchReactions(
  state: MessengerState,
  messageId: Id,
  reactions: ReactionSummary[]
): MessengerState {
  return { ...state, reactions: { ...state.reactions, [messageId]: reactions } };
}

/* --------------------------------------------------------- optimistic send */

export function patchOutbox(
  state: MessengerState,
  clientNonce: Id,
  value: MessengerState["outbox"][string] | null
): MessengerState {
  const outbox = { ...state.outbox };
  if (value === null) delete outbox[clientNonce];
  else outbox[clientNonce] = value;
  return { ...state, outbox };
}

/** Insert an optimistic row (oldest-first order) plus its chat preview. */
export function addOptimisticMessage(state: MessengerState, message: UiMessage): MessengerState {
  const existing = state.messages[message.chatId] ?? [];
  const nextRows = mergeMessages(existing, [message as Message]);
  return {
    ...state,
    messages: { ...state.messages, [message.chatId]: nextRows },
    outbox: { ...state.outbox, [message.clientNonce]: "sending" },
    chats: sortChats(
      state.chats.map((chat) =>
        chat.id === message.chatId
          ? { ...chat, lastMessage: message as Message, lastActivityAt: message.createdAt }
          : chat
      )
    ),
    activeChat: state.activeChat?.id === message.chatId
      ? { ...state.activeChat, lastMessage: message as Message, lastActivityAt: message.createdAt }
      : state.activeChat
  };
}

/** Replace the optimistic row matching `clientNonce` with the canonical row. */
export function confirmOptimisticMessage(
  state: MessengerState,
  message: Message,
  selfUserId: Id | null
): MessengerState {
  const existing = state.messages[message.chatId] ?? [];
  const withoutOptimistic = existing.filter(
    (row) => row.id !== message.id &&
      !(row.clientNonce === message.clientNonce && (row._pending === true || row._failed === true))
  );
  const merged = mergeMessages(withoutOptimistic, [message]);
  const outbox = { ...state.outbox };
  delete outbox[message.clientNonce];
  return applyMessageToChat(
    { ...state, messages: { ...state.messages, [message.chatId]: merged }, outbox },
    message,
    selfUserId,
    { countUnread: false }
  );
}

export function failOptimisticMessage(
  state: MessengerState,
  chatId: Id,
  clientNonce: Id
): MessengerState {
  const existing = state.messages[chatId] ?? [];
  const next = existing.map((row) =>
    row.clientNonce === clientNonce && row._pending === true
      ? { ...row, _pending: false, _failed: true }
      : row
  );
  return {
    ...state,
    messages: { ...state.messages, [chatId]: next },
    outbox: state.outbox[clientNonce] === undefined
      ? state.outbox
      : { ...state.outbox, [clientNonce]: "failed" }
  };
}

export function markOptimisticSending(state: MessengerState, chatId: Id, clientNonce: Id): MessengerState {
  const existing = state.messages[chatId] ?? [];
  const next = existing.map((row) =>
    row.clientNonce === clientNonce ? { ...row, _pending: true, _failed: false } : row
  );
  return {
    ...state,
    messages: { ...state.messages, [chatId]: next },
    outbox: { ...state.outbox, [clientNonce]: "sending" }
  };
}

export function findMessageByNonce(
  state: MessengerState,
  chatId: Id,
  clientNonce: Id
): UiMessage | undefined {
  return (state.messages[chatId] ?? []).find((row) => row.clientNonce === clientNonce);
}

export function findMessageById(
  state: MessengerState,
  messageId: Id
): { chatId: Id; message: UiMessage } | null {
  for (const [chatId, rows] of Object.entries(state.messages)) {
    const message = rows.find((row) => row.id === messageId);
    if (message !== undefined) return { chatId, message };
  }
  return null;
}

/* --------------------------------------------------------------- receipts */

export function setMessageReceipts(
  state: MessengerState,
  messageId: Id,
  items: MessageReceipt[]
): MessengerState {
  return { ...state, receipts: { ...state.receipts, [messageId]: { items, complete: true } } };
}

/**
 * Realtime receipt merge. Never upgrades `complete`: only the authoritative
 * `GET /v1/messages/:id/receipts` read may do that (delivery truth rule).
 */
export function applyReceiptEvent(
  state: MessengerState,
  messageId: Id,
  userId: Id,
  kind: "delivered" | "read",
  at: string
): MessengerState {
  const current = state.receipts[messageId];
  const items: MessageReceipt[] = [...(current?.items ?? [])];
  const index = items.findIndex((item) => item.userId === userId);
  if (index >= 0) {
    const previous = items[index];
    items[index] = kind === "read"
      ? { ...previous, readAt: at, deliveredAt: previous.deliveredAt ?? at }
      : { ...previous, deliveredAt: previous.deliveredAt ?? at };
  } else {
    items.push({ userId, deliveredAt: at, readAt: kind === "read" ? at : null });
  }
  const next: MessageReceiptState = { items, complete: current?.complete ?? false };
  return { ...state, receipts: { ...state.receipts, [messageId]: next } };
}

/* ----------------------------------------------------------------- typing */

export function resolveDisplayName(state: MessengerState, chatId: Id, userId: Id): string {
  if (state.user?.id === userId) return state.user.displayName;
  const members = state.members[chatId] ?? [];
  const member = members.find((entry) => entry.user.id === userId);
  if (member !== undefined) return member.user.displayName;
  return userId.slice(0, 8);
}

export function applyTyping(
  state: MessengerState,
  chatId: Id,
  userId: Id,
  isTyping: boolean,
  expiresAtMs: number,
  displayName?: string
): MessengerState {
  const entries = state.typing[chatId] ?? [];
  const existing = entries.find((entry) => entry.userId === userId);
  let nextEntries: TypingEntry[];
  if (isTyping) {
    const entry: TypingEntry = {
      userId,
      displayName: displayName ?? existing?.displayName ?? resolveDisplayName(state, chatId, userId),
      expiresAt: expiresAtMs
    };
    nextEntries = existing === undefined
      ? [...entries, entry]
      : entries.map((item) => (item.userId === userId ? entry : item));
  } else {
    if (existing === undefined) return state;
    nextEntries = entries.filter((entry) => entry.userId !== userId);
  }
  return { ...state, typing: { ...state.typing, [chatId]: nextEntries } };
}

export function pruneTyping(state: MessengerState, nowMs: number): MessengerState {
  let changed = false;
  const typing: MessengerState["typing"] = {};
  for (const [chatId, entries] of Object.entries(state.typing)) {
    const alive = entries.filter((entry) => entry.expiresAt > nowMs);
    if (alive.length !== entries.length) changed = true;
    if (alive.length > 0) typing[chatId] = alive;
  }
  return changed ? { ...state, typing } : state;
}

export function applyPresence(
  state: MessengerState,
  userId: Id,
  presence: "online" | "offline"
): MessengerState {
  if (state.presence[userId] === presence) return state;
  return { ...state, presence: { ...state.presence, [userId]: presence } };
}

/* -------------------------------------------------------------- requests */

export function setRequests(
  state: MessengerState,
  patch: Partial<MessengerState["requests"]>
): MessengerState {
  return { ...state, requests: { ...state.requests, ...patch } };
}

export function replaceRequestList(
  state: MessengerState,
  direction: "incoming" | "outgoing",
  items: MessageRequest[]
): MessengerState {
  return setRequests(state, direction === "incoming" ? { incoming: items } : { outgoing: items });
}

export function removeRequest(state: MessengerState, requestId: Id): MessengerState {
  return {
    ...state,
    requests: {
      ...state.requests,
      incoming: state.requests.incoming.filter((request) => request.id !== requestId),
      outgoing: state.requests.outgoing.filter((request) => request.id !== requestId)
    }
  };
}

/* ------------------------------------------------------------------ calls */

export function setCall(state: MessengerState, patch: Partial<MessengerState["call"]>): MessengerState {
  return { ...state, call: { ...state.call, ...patch } };
}

export function applyCallSnapshot(state: MessengerState, call: Call): MessengerState {
  const isEnded = call.state === "ended" || call.endedAtMs !== null;
  const next = {
    ...state.call,
    active: state.call.active?.callId === call.callId ? (isEnded ? null : call) : state.call.active,
    incoming: state.call.incoming?.callId === call.callId ? (isEnded ? null : call) : state.call.incoming
  };
  return { ...state, call: next };
}

/* ------------------------------------------------------------ event apply */

/**
 * Apply one durable realtime event idempotently. `selfUserId` is used to avoid
 * self-unread increments and to remove state for account-removal events.
 */
export function applyDurableEvent(
  state: MessengerState,
  event: DurableRealtimeEvent,
  selfUserId: Id | null
): MessengerState {
  switch (event.type) {
    case "chat.created":
      return upsertChat(state, event.chat);
    case "message.created":
    case "message.updated":
    case "message.deleted": {
      const message = event.message;
      const existing = state.messages[message.chatId] ?? [];
      const nextRows = mergeMessages(existing, [message]);
      const knownChat = state.chats.some((chat) => chat.id === message.chatId);
      const withRows: MessengerState = {
        ...state,
        messages: { ...state.messages, [message.chatId]: nextRows }
      };
      if (!knownChat) return withRows;
      // A tombstone never raises unread; only fresh messages do.
      return applyMessageToChat(withRows, message, selfUserId, {
        countUnread: event.type === "message.created"
      });
    }
    case "attachment.stored": {
      // Update metadata transitions (e.g. server-verified sizes) in place.
      let changed = false;
      const messages: MessengerState["messages"] = {};
      for (const [chatId, rows] of Object.entries(state.messages)) {
        messages[chatId] = rows.map((row) => {
          if (!row.attachments.some((attachment) => attachment.id === event.attachment.id)) return row;
          changed = true;
          return {
            ...row,
            attachments: row.attachments.map((attachment) =>
              attachment.id === event.attachment.id ? event.attachment : attachment
            )
          };
        });
      }
      return changed ? { ...state, messages } : state;
    }
    case "message.pinned": {
      const rows = state.messages[event.pin.chatId];
      if (rows === undefined) return state;
      return {
        ...state,
        messages: {
          ...state.messages,
          [event.pin.chatId]: rows.map((row) =>
            row.id === event.pin.messageId ? { ...row, isPinned: true } : row
          )
        }
      };
    }
    case "message.unpinned": {
      const rows = state.messages[event.chatId];
      if (rows === undefined) return state;
      return {
        ...state,
        messages: {
          ...state.messages,
          [event.chatId]: rows.map((row) =>
            row.id === event.messageId ? { ...row, isPinned: false } : row
          )
        }
      };
    }
    case "reaction.updated":
      return patchReactions(state, event.messageId, event.reactions);
    case "receipt.delivered":
      return applyReceiptEvent(state, event.messageId, event.userId, "delivered", new Date().toISOString());
    case "receipt.read":
      return applyReceiptEvent(state, event.messageId, event.userId, "read", new Date().toISOString());
    case "chat.member.changed": {
      const chatId = event.membership.chatId;
      const userId = event.membership.userId;
      if (
        event.audience === "removed_account" &&
        event.change === "removed" &&
        selfUserId !== null &&
        userId === selfUserId
      ) {
        const messages = { ...state.messages };
        delete messages[chatId];
        const pages = { ...state.pages };
        delete pages[chatId];
        const typing = { ...state.typing };
        delete typing[chatId];
        return {
          ...state,
          chats: state.chats.filter((chat) => chat.id !== chatId),
          activeChatId: state.activeChatId === chatId ? null : state.activeChatId,
          activeChat: state.activeChat?.id === chatId ? null : state.activeChat,
          messages,
          pages,
          typing
        };
      }
      const existing = state.members[chatId];
      if (existing === undefined) return state;
      if (event.change === "removed") {
        return patchMembers(state, chatId, existing.filter((member) => member.user.id !== userId));
      }
      return patchMembers(
        state,
        chatId,
        existing.map((member) =>
          member.user.id === userId ? { ...member, membership: event.membership } : member
        )
      );
    }
    case "call.state.changed": {
      const current = state.call.active?.callId === event.callId
        ? state.call.active
        : state.call.incoming?.callId === event.callId
          ? state.call.incoming
          : null;
      if (current === null) return state;
      return applyCallSnapshot(state, { ...current, state: event.state, revision: event.revision });
    }
    case "sync.invalidated":
      return state;
    case "typing.updated":
      return applyTyping(
        state,
        event.chatId,
        event.userId,
        event.isTyping,
        Date.parse(event.expiresAt)
      );
    case "presence.updated":
      return applyPresence(state, event.userId, event.presence);
    default:
      return state;
  }
}

/* --------------------------------------------------------------- notices */

export function setError(state: MessengerState, message: string | null): MessengerState {
  return { ...state, error: message };
}

export function setNotice(state: MessengerState, message: string | null): MessengerState {
  return { ...state, notice: message };
}

export function setConnection(
  state: MessengerState,
  connection: MessengerState["connection"]
): MessengerState {
  return state.connection === connection ? state : { ...state, connection };
}
