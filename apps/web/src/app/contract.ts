/**
 * Shared contract between the Luxora web messenger data layer and its UI.
 *
 * This file is the integration seam: `app/messenger.tsx` implements the state +
 * actions, `app/ui/**` only consumes them. Both sides must compile against this
 * single source of truth. Server shapes mirror `@luxora/protocol`; additive
 * response fields are tolerated by the server contract but typed here only when
 * the web client actually uses them.
 */
import type { FC, ReactNode } from "react";

export type Id = string;
export type IsoTimestamp = string;
export type Presence = "online" | "offline";
export type ChatKind = "direct" | "group" | "channel";
export type ChatRole = "owner" | "admin" | "member";
export type ConnectionStatus = "idle" | "connecting" | "online" | "reconnecting" | "offline";
export type MediaMode = "audio" | "video";

/* ------------------------------------------------------------------ models */

export type User = {
  id: Id;
  username: string;
  displayName: string;
  bio: string;
  avatarUrl: string | null;
  avatarPath?: string | null;
  createdAt: IsoTimestamp;
  presence?: Presence;
  lastSeenAt?: IsoTimestamp | null;
};

export type PublicProfile = {
  id: Id;
  username: string;
  displayName: string;
  bio: string;
  avatarUrl: string | null;
  avatarPath?: string | null;
  lastSeenAt?: IsoTimestamp | null;
};

export type AttachmentKind = "image" | "video" | "video_message" | "audio" | "voice" | "file";

export type Attachment = {
  id: Id;
  kind: AttachmentKind;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  sha256: string;
  downloadPath: string;
  thumbnailPath?: string;
  safetyStatus: "unscanned" | "reencoded";
  metadataTrust: "client_declared" | "server_verified";
  createdAt: IsoTimestamp;
  metadata: {
    width?: number;
    height?: number;
    durationMs?: number;
    waveform?: number[];
  };
};

export type Message = {
  id: Id;
  chatId: Id;
  sender: User;
  kind: "text" | "media";
  body: string | null;
  replyToMessageId: Id | null;
  topicId: Id | null;
  forwardedFrom: { senderDisplayName: string; originalCreatedAt: IsoTimestamp } | null;
  attachments: Attachment[];
  transcriptionAllowed: boolean;
  transcript: string | null;
  isPinned: boolean;
  clientNonce: Id;
  revision: number;
  createdAt: IsoTimestamp;
  updatedAt: IsoTimestamp;
  editedAt: IsoTimestamp | null;
  deletedAt: IsoTimestamp | null;
};

/** Message plus client-only delivery annotations. Optimistic rows carry `_pending`. */
export type UiMessage = Message & {
  _pending?: boolean;
  _failed?: boolean;
  _optimisticAttachments?: { localUrl: string; fileName: string; kind: AttachmentKind }[];
};

export type Chat = {
  id: Id;
  kind: ChatKind;
  title: string;
  avatarUrl: string | null;
  role: ChatRole;
  memberCount: number;
  lastMessage: Message | null;
  lastActivityAt: IsoTimestamp;
  createdAt: IsoTimestamp;
  unreadCount: number;
  archivedAt: IsoTimestamp | null;
  mutedUntil: IsoTimestamp | null;
};

export type ChatMembership = {
  chatId: Id;
  userId: Id;
  role: ChatRole;
  revision: number;
  joinedAt: IsoTimestamp;
  updatedAt: IsoTimestamp;
};

export type ChatMember = {
  membership: ChatMembership;
  user: User;
};

export type ReactionSummary = {
  emoji: string;
  count: number;
  reactedByMe: boolean;
};

/** Server receipt projection (`GET /v1/messages/:id/receipts`): one row per recipient. */
export type MessageReceipt = {
  userId: Id;
  deliveredAt: IsoTimestamp;
  readAt: IsoTimestamp | null;
};

/**
 * `complete` means the client has the full recipient set for the message
 * (authoritative GET), so the UI may render Delivered/Read ticks. While
 * incomplete, only the honest single "sent" tick is allowed; realtime updates
 * never upgrade an incomplete projection beyond what the server proved.
 */
export type MessageReceiptState = {
  items: MessageReceipt[];
  complete: boolean;
};

/** Server `MessageRequestProjectionSchema` (discriminated by direction). */
export type MessageRequest = {
  id: Id;
  body: string;
  createdAt: IsoTimestamp;
  expiresAt: IsoTimestamp;
  direction: "incoming" | "outgoing";
  state: "pending" | "accepted" | "expired" | "recipient_dismissed";
  /** Present when direction = "incoming". */
  sender?: PublicProfile;
  /** Present when direction = "outgoing". */
  recipient?: PublicProfile;
};

export type Call = {
  callId: Id;
  chatId: Id;
  kind: "one_to_one" | "group" | "scheduled";
  mediaMode: MediaMode;
  state:
    | "created"
    | "inviting"
    | "ringing"
    | "connecting"
    | "active"
    | "reconnecting"
    | "ending"
    | "ended";
  revision: number;
  epoch: number;
  creatorMemberId: Id;
  participants: {
    membershipId: Id;
    memberId: Id;
    role: "host" | "member";
    status: string;
    membershipEpoch: number;
    invitedAtMs: number;
    acceptedAtMs: number | null;
    activeAtMs: number | null;
    removedAtMs: number | null;
  }[];
  createdAtMs: number;
  updatedAtMs: number;
  pendingEndReason: string | null;
  endReason: string | null;
  endedAtMs: number | null;
};

export type Capabilities = {
  schemaVersion: number;
  features: {
    passwordAuthentication: boolean;
    phoneAuthentication: boolean;
    deviceSessions: boolean;
    messaging: boolean;
    identityAccess: boolean;
    safetyReports: boolean;
    realtime: boolean;
    reconciliation: boolean;
    syncInvalidation: boolean;
    chatFolders: boolean;
    drafts: boolean;
    mediaUploads: boolean;
    serverSearchConfigured: boolean;
    calls: boolean;
    passkeys: boolean;
    push: boolean;
  };
  trust: {
    profile: string;
    contentReadableByServer: boolean;
    endToEndEncryption: boolean;
  };
  limits: {
    maxMessageCodePoints: number;
    maxPageItems: number;
    defaultPageItems: number;
    maxAttachmentBytes: number;
    userStorageQuotaBytes: number;
    uploadChunkSizeBytes: number;
    maxAttachmentsPerMessage: number;
    maxMessageRequestCodePoints: number;
  };
};

export type TokenBundle = {
  accessToken: string;
  refreshToken: string;
  tokenType: "Bearer";
  expiresIn: number;
  sessionId: Id;
};

export type AuthResult = { user: User; tokens: TokenBundle };

/* --------------------------------------------------------------- realtime */

export type DurableRealtimeEvent =
  | { type: "chat.created"; chat: Chat }
  | { type: "message.created" | "message.updated" | "message.deleted"; message: Message }
  | { type: "attachment.stored"; attachment: Attachment }
  | { type: "message.pinned"; pin: { chatId: Id; messageId: Id } }
  | { type: "message.unpinned"; chatId: Id; messageId: Id }
  | { type: "receipt.delivered" | "receipt.read"; chatId: Id; userId: Id; messageId: Id }
  | { type: "reaction.updated"; chatId: Id; messageId: Id; reactions: ReactionSummary[]; actorUserId: Id }
  | {
      type: "call.state.changed";
      callId: Id;
      chatId: Id;
      state: Call["state"];
      revision: number;
      occurredAt: IsoTimestamp;
    }
  | {
      type: "chat.member.changed";
      audience: "member_account" | "removed_account";
      change: "added" | "role_updated" | "removed";
      membership: ChatMembership;
      actorUserId: Id;
      changedAt: IsoTimestamp;
    }
  | { type: "sync.invalidated"; audience: "account_projection"; accountId: Id; reason: string; changedAt: IsoTimestamp }
  | { type: "typing.updated"; chatId: Id; userId: Id; isTyping: boolean; expiresAt: IsoTimestamp }
  | { type: "presence.updated"; userId: Id; presence: Presence; lastSeenAt: IsoTimestamp | null };

export type ServerRealtimeFrame =
  | { type: "hello"; protocolVersion: number; connectionId: Id; heartbeatIntervalMs: number }
  | {
      type: "ready";
      userId: Id;
      sessionId: Id;
      sequence: number;
      headSequence: number;
      cursor: string | null;
      resumed: boolean;
      resumeMode: "none" | "scoped_cursor";
      retention: { maxReplayEvents: number; cursorTtlSeconds: number };
    }
  | { type: "dispatch"; sequence: number; cursor: string; event: DurableRealtimeEvent }
  | { type: "sync.checkpoint"; sequence: number; cursor: string }
  | { type: "heartbeat"; timestamp: IsoTimestamp }
  | { type: "heartbeat.ack"; timestamp: IsoTimestamp }
  | { type: "sync.required"; reason: string; headSequence: number }
  | { type: "typing.updated"; chatId: Id; userId: Id; isTyping: boolean; expiresAt: IsoTimestamp }
  | { type: "presence.updated"; userId: Id; presence: Presence; lastSeenAt: IsoTimestamp | null }
  | { type: "error"; code: string; message: string };

/* ----------------------------------------------------------------- errors */

export class LuxoraApiError extends Error {
  readonly code: string;
  readonly status: number;
  readonly requestId?: string;
  readonly details?: unknown;

  constructor(options: { code: string; message: string; status: number; requestId?: string; details?: unknown }) {
    super(options.message);
    this.name = "LuxoraApiError";
    this.code = options.code;
    this.status = options.status;
    this.requestId = options.requestId;
    this.details = options.details;
  }
}

/* ------------------------------------------------------------------ state */

export type OutboxState = "sending" | "failed";

export type ChatPageState = {
  nextCursor: string | null;
  loaded: boolean;
  loading: boolean;
  error: string | null;
};

export type TypingEntry = { userId: Id; displayName: string; expiresAt: number };

export type CallMediaState = "unavailable" | "connecting" | "connected" | "failed";

export type CallState = {
  active: Call | null;
  incoming: Call | null;
  media: CallMediaState;
  mediaError: string | null;
};

export type RequestsState = {
  incoming: MessageRequest[];
  outgoing: MessageRequest[];
  loading: boolean;
  error: string | null;
};

export type MessengerState = {
  /** booting: reading the stored session; anonymous: signed out; ready: signed in. */
  phase: "booting" | "anonymous" | "submitting" | "ready" | "fatal";
  fatalError: string | null;
  user: User | null;
  capabilities: Capabilities | null;
  serverUrl: string;
  connection: ConnectionStatus;
  chats: Chat[];
  chatsLoading: boolean;
  chatsError: string | null;
  activeChatId: Id | null;
  activeChat: Chat | null;
  members: Record<Id, ChatMember[]>;
  messages: Record<Id, UiMessage[]>;
  pages: Record<Id, ChatPageState>;
  reactions: Record<Id, ReactionSummary[]>;
  receipts: Record<Id, MessageReceiptState>;
  drafts: Record<Id, { text: string; replyToMessageId: Id | null }>;
  typing: Record<Id, TypingEntry[]>;
  presence: Record<Id, Presence>;
  outbox: Record<Id, OutboxState>;
  requests: RequestsState;
  call: CallState;
  error: string | null;
  notice: string | null;
};

/* ---------------------------------------------------------------- actions */

export type SignInInput = { username: string; password: string; deviceName: string };
export type SignUpInput = SignInInput & { displayName: string };

export type SendMessageInput = {
  chatId: Id;
  body: string;
  replyToMessageId?: Id | null;
  attachmentIds?: Id[];
  transcriptionConsent?: boolean;
};

export type UploadProgress = (fraction: number) => void;

export type MessengerActions = {
  signIn(input: SignInInput): Promise<void>;
  signUp(input: SignUpInput): Promise<void>;
  signOut(): Promise<void>;
  retryBoot(): void;
  dismissNotice(): void;
  clearError(): void;

  loadChats(): Promise<void>;
  openChat(chatId: Id): Promise<void>;
  closeChat(): void;
  loadOlder(chatId: Id): Promise<void>;

  sendMessage(input: SendMessageInput): Promise<void>;
  retrySend(chatId: Id, clientNonce: Id): Promise<void>;
  editMessage(messageId: Id, body: string, expectedRevision: number): Promise<void>;
  deleteMessage(messageId: Id): Promise<void>;
  toggleReaction(messageId: Id, emoji: string): Promise<void>;
  loadReactions(messageId: Id): Promise<ReactionSummary[]>;
  markRead(chatId: Id, messageId: Id): Promise<void>;
  markDelivered(chatId: Id, messageId: Id): Promise<void>;
  setDraft(chatId: Id, text: string, replyToMessageId?: Id | null): void;
  setTyping(chatId: Id, typing: boolean): void;

  uploadFile(file: File, progress?: UploadProgress): Promise<Attachment>;

  /**
   * Authenticated binary GET for `/v1/attachments/:id/content` and
   * `/v1/attachments/:id/thumbnail` paths (also avatar `avatarPath`). The
   * caller owns the resulting object URL and must revoke it.
   */
  authBlob(path: string): Promise<Blob>;

  lookupUser(username: string): Promise<PublicProfile | null>;
  startDirectChat(userId: Id): Promise<Chat>;
  loadRequests(): Promise<void>;
  acceptRequest(requestId: Id): Promise<void>;
  declineRequest(requestId: Id): Promise<void>;
  sendMessageRequest(targetUserId: Id, text: string): Promise<void>;

  startCall(chatId: Id, mediaMode: MediaMode): Promise<void>;
  acceptCall(): Promise<void>;
  declineCall(): Promise<void>;
  hangupCall(): Promise<void>;
  dismissCall(): void;

  updateProfile(patch: { displayName?: string; bio?: string }): Promise<void>;
  searchChats(query: string): Promise<Chat[]>;
};

export type MessengerApi = MessengerState & MessengerActions;

/* -------------------------------------------------------------- provider */

export type MessengerProviderProps = { children: ReactNode };

/** Implemented by `app/messenger.tsx`. */
export type MessengerProviderComponent = FC<MessengerProviderProps>;

/** Server API base URL; the messenger is the same origin unless VITE_LUXORA_API is set. */
export const DEFAULT_API_BASE = import.meta.env.VITE_LUXORA_API ?? "";
