import {
  REALTIME_CURSOR_TTL_SECONDS,
  REALTIME_MAX_REPLAY_EVENTS,
  RealtimeEventSchema
} from "@luxora/protocol";
import type {
  DurableRealtimeEvent,
  RealtimeSyncRequiredReason,
  ServerRealtimeMessage,
  ServerRealtimeMessageV2
} from "@luxora/protocol";
import type WebSocket from "ws";
import type { Store } from "../domain/store.js";
import type { StoredEvent } from "../domain/types.js";
import type { Metrics, RealtimeGuardReason } from "../metrics.js";
import type { EventPublisher } from "../services/event-publisher.js";
import { RealtimeCursorCodec } from "./cursor.js";

const MAX_BUFFERED_BYTES = 1_000_000;
const MAX_PENDING_EVENTS = 1_000;

export interface RealtimeResumeRequest {
  resumeFrom?: number;
  resumeCursor?: string;
}

type ResumeMode = "none" | "scoped_cursor";

type ResumeResolution =
  | { ok: true; afterSequence: number; mode: ResumeMode; requested: boolean }
  | { ok: false; reason: Exclude<RealtimeSyncRequiredReason, "backpressure"> };

export interface RealtimeConnection {
  id: string;
  userId: string;
  sessionId: string;
  socket: WebSocket;
  protocolVersion: 1 | 2;
  active: boolean;
  queue: StoredEvent[];
  lastAliveAt: number;
  lastTypingAtByChat: Map<string, number>;
}

export class RealtimeHub implements EventPublisher {
  readonly #connectionsByUser = new Map<string, Map<string, RealtimeConnection>>();
  readonly #backpressuredConnectionIds = new Set<string>();
  #closing = false;

  constructor(
    private readonly store: Store,
    private readonly metrics: Metrics,
    private readonly cursors: RealtimeCursorCodec,
    private readonly syncInvalidationEnabled = true
  ) {}

  registerPending(connection: RealtimeConnection): void {
    this.#backpressuredConnectionIds.delete(connection.id);
    const userConnections = this.#connectionsByUser.get(connection.userId) ?? new Map();
    const wasOffline = userConnections.size === 0;
    userConnections.set(connection.id, connection);
    this.#connectionsByUser.set(connection.userId, userConnections);
    this.metrics.websocketOpened();
    if (wasOffline) {
      this.#broadcastPresence(connection.userId, "online", null);
    }
  }

  activate(connection: RealtimeConnection, resume: RealtimeResumeRequest = {}): void {
    if (!this.#ensureSessionActive(connection)) return;
    const watermark = this.store.getLatestSequence();
    const resolution = this.#resolveResume(connection, resume, watermark);
    if (!resolution.ok) {
      this.#requireReconciliation(connection, resolution.reason, watermark);
      return;
    }
    const after = resolution.afterSequence;
    const replay = this.store.replayEvents(
      connection.userId,
      after,
      watermark,
      REALTIME_MAX_REPLAY_EVENTS + 1,
      this.syncInvalidationEnabled
    );
    const replayOverflow = replay.length > REALTIME_MAX_REPLAY_EVENTS;

    if (replayOverflow) {
      this.#requireReconciliation(connection, "replay_window_exceeded", watermark);
      return;
    }

    if (connection.protocolVersion === 1) {
      this.#send(connection, {
        type: "ready",
        userId: connection.userId,
        sessionId: connection.sessionId,
        sequence: watermark,
        resumed: resolution.requested
      });
    } else {
      this.#send(connection, {
        type: "ready",
        userId: connection.userId,
        sessionId: connection.sessionId,
        sequence: after,
        headSequence: watermark,
        cursor: this.cursors.issue(connection.userId, connection.sessionId, after).cursor,
        resumed: resolution.requested,
        resumeMode: resolution.mode,
        retention: {
          maxReplayEvents: REALTIME_MAX_REPLAY_EVENTS,
          cursorTtlSeconds: REALTIME_CURSOR_TTL_SECONDS
        }
      });
    }
    if (this.#cannotContinueActivation(connection)) return;
    for (const event of replay) {
      this.#sendDispatch(connection, event);
      if (this.#cannotContinueActivation(connection)) return;
    }
    if (connection.protocolVersion === 2) this.#sendCheckpoint(connection, watermark);
    if (this.#cannotContinueActivation(connection)) return;

    connection.active = true;
    const queued = connection.queue
      .filter((event) => event.sequence > watermark)
      .sort((left, right) => left.sequence - right.sequence);
    connection.queue.length = 0;
    for (const event of queued) {
      this.#sendDispatch(connection, event);
      if (this.#cannotContinueActivation(connection)) return;
    }
  }

  remove(connection: RealtimeConnection): void {
    this.#backpressuredConnectionIds.delete(connection.id);
    const userConnections = this.#connectionsByUser.get(connection.userId);
    if (userConnections?.delete(connection.id) !== true) return;
    this.metrics.websocketClosed();
    if (userConnections.size === 0) {
      this.#connectionsByUser.delete(connection.userId);
      if (this.#closing) return;
      const now = new Date().toISOString();
      this.store.setUserLastSeen(connection.userId, now);
      this.#broadcastPresence(connection.userId, "offline", now);
    }
  }

  publish(events: StoredEvent[]): void {
    if (this.#closing) return;
    for (const event of events) {
      if (!this.syncInvalidationEnabled && event.event.type === "sync.invalidated") continue;
      const connections = this.#connectionsByUser.get(event.audienceUserId);
      if (connections === undefined) continue;
      for (const connection of connections.values()) {
        if (this.#backpressuredConnectionIds.has(connection.id)) continue;
        if (!this.#ensureSessionActive(connection)) continue;
        if (connection.active) {
          this.#sendDispatch(connection, event);
        } else {
          connection.queue.push(event);
          if (connection.queue.length > MAX_PENDING_EVENTS) {
            this.#disconnectForBackpressure(connection, "Reconnect and synchronize", true);
          }
        }
      }
    }
  }

  publishEphemeral(
    userIds: string[],
    message: ServerRealtimeMessage | ServerRealtimeMessageV2,
    excludeConnectionId?: string
  ): void {
    for (const userId of new Set(userIds)) {
      const connections = this.#connectionsByUser.get(userId);
      if (connections === undefined) continue;
      for (const connection of connections.values()) {
        if (
          !this.#backpressuredConnectionIds.has(connection.id) &&
          connection.id !== excludeConnectionId &&
          this.#ensureSessionActive(connection) &&
          connection.active
        ) this.#send(connection, message);
      }
    }
  }

  markAlive(connection: RealtimeConnection): void {
    connection.lastAliveAt = Date.now();
  }

  recordGuard(reason: RealtimeGuardReason): void {
    this.metrics.recordRealtimeGuard(reason);
  }

  isUserOnline(userId: string): boolean {
    return (this.#connectionsByUser.get(userId)?.size ?? 0) > 0;
  }

  terminateSession(sessionId: string): void {
    for (const connections of this.#connectionsByUser.values()) {
      for (const connection of connections.values()) {
        if (connection.sessionId === sessionId) {
          connection.socket.close(4001, "Session revoked");
        }
      }
    }
  }

  closeAll(): void {
    this.#closing = true;
    for (const connections of this.#connectionsByUser.values()) {
      for (const connection of connections.values()) {
        connection.socket.close(1001, "Server shutting down");
      }
    }
  }

  #sendDispatch(connection: RealtimeConnection, event: StoredEvent): void {
    if (!this.syncInvalidationEnabled && event.event.type === "sync.invalidated") return;
    let authorizedEvent: DurableRealtimeEvent;
    try {
      if (!this.#isDispatchAuthorized(connection.userId, event.event)) return;
      authorizedEvent = event.event.type === "reaction.updated"
        ? {
            ...event.event,
            reactions: this.store.getReactionSummary(event.event.messageId, connection.userId)
          }
        : event.event;
    } catch {
      connection.active = false;
      connection.queue.length = 0;
      connection.socket.close(1011, "Authorization state unavailable");
      return;
    }
    if (connection.protocolVersion === 1) {
      const compatible = RealtimeEventSchema.safeParse(authorizedEvent);
      if (!compatible.success) return;
      this.#send(connection, { type: "dispatch", sequence: event.sequence, event: compatible.data });
    } else {
      this.#send(connection, {
        type: "dispatch",
        sequence: event.sequence,
        cursor: this.cursors.issue(connection.userId, connection.sessionId, event.sequence).cursor,
        event: authorizedEvent
      });
    }
  }

  #sendCheckpoint(connection: RealtimeConnection, sequence: number): void {
    this.#send(connection, {
      type: "sync.checkpoint",
      sequence,
      cursor: this.cursors.issue(connection.userId, connection.sessionId, sequence).cursor
    });
  }

  #resolveResume(
    connection: RealtimeConnection,
    resume: RealtimeResumeRequest,
    watermark: number
  ): ResumeResolution {
    if (resume.resumeCursor !== undefined && resume.resumeFrom !== undefined) {
      return { ok: false, reason: "cursor_invalid" };
    }
    if (resume.resumeCursor !== undefined) {
      if (connection.protocolVersion !== 2) return { ok: false, reason: "cursor_invalid" };
      const verified = this.cursors.verify(
        resume.resumeCursor,
        connection.userId,
        connection.sessionId
      );
      if (!verified.ok) return verified;
      if (verified.sequence > watermark) return { ok: false, reason: "cursor_ahead" };
      return {
        ok: true,
        afterSequence: verified.sequence,
        mode: "scoped_cursor",
        requested: true
      };
    }
    if (resume.resumeFrom !== undefined) {
      if (connection.protocolVersion === 2) return { ok: false, reason: "cursor_invalid" };
      if (resume.resumeFrom > watermark) return { ok: false, reason: "cursor_ahead" };
      return {
        ok: true,
        afterSequence: resume.resumeFrom,
        mode: "none",
        requested: true
      };
    }
    return { ok: true, afterSequence: watermark, mode: "none", requested: false };
  }

  #requireReconciliation(
    connection: RealtimeConnection,
    reason: Exclude<RealtimeSyncRequiredReason, "backpressure">,
    watermark: number
  ): void {
    if (connection.protocolVersion === 1) {
      this.#send(connection, {
        type: "ready",
        userId: connection.userId,
        sessionId: connection.sessionId,
        sequence: watermark,
        resumed: false
      });
      this.#send(connection, { type: "sync.required", reason: "resume_window_exceeded" });
    } else {
      this.#send(connection, {
        type: "ready",
        userId: connection.userId,
        sessionId: connection.sessionId,
        sequence: 0,
        headSequence: watermark,
        cursor: null,
        resumed: false,
        resumeMode: "none",
        retention: {
          maxReplayEvents: REALTIME_MAX_REPLAY_EVENTS,
          cursorTtlSeconds: REALTIME_CURSOR_TTL_SECONDS
        }
      });
      this.#send(connection, {
        type: "sync.required",
        reason,
        headSequence: watermark,
        recovery: { type: "http_snapshot", path: "/v2/sync/snapshot" }
      });
    }
    connection.socket.close(4009, "Authoritative synchronization required");
  }

  #isDispatchAuthorized(audienceUserId: string, event: DurableRealtimeEvent): boolean {
    switch (event.type) {
      case "relationship.request.created": {
        const request = this.store.findMessageRequestById(event.request.id);
        if (request === null) return false;
        if (event.audience === "sender_account") return request.senderId === audienceUserId;
        return request.recipientId === audienceUserId &&
          request.state === "pending" &&
          !this.store.isBlockedBetween(request.senderId, request.recipientId);
      }
      case "relationship.request.removed": {
        const request = this.store.findMessageRequestById(event.requestId);
        return request !== null && request.recipientId === audienceUserId;
      }
      case "relationship.request.accepted": {
        const request = this.store.findMessageRequestById(event.requestId);
        return request !== null &&
          request.state === "accepted" &&
          request.chatId === event.chat.id &&
          (request.senderId === audienceUserId || request.recipientId === audienceUserId) &&
          this.store.hasAcceptedRelationship(request.senderId, request.recipientId) &&
          !this.store.isBlockedBetween(request.senderId, request.recipientId);
      }
      case "relationship.request.expired": {
        const request = this.store.findMessageRequestById(event.requestId);
        return request !== null &&
          request.state === "expired" &&
          (request.senderId === audienceUserId || request.recipientId === audienceUserId) &&
          !this.store.isBlockedBetween(request.senderId, request.recipientId);
      }
      case "relationship.block.changed":
      case "safety.report.submitted":
        return true;
      case "chat.member.changed": {
        if (event.audience === "removed_account") {
          return event.change === "removed" &&
            event.membership.userId === audienceUserId;
        }
        return this.store.getChatMember(event.membership.chatId, audienceUserId) !== null;
      }
      case "chat.preferences.updated":
        return event.accountId === audienceUserId &&
          this.store.getChatMember(event.chatId, audienceUserId) !== null;
      case "chat.folders.updated":
        return event.accountId === audienceUserId;
      case "chat.draft.changed": {
        if (event.accountId !== audienceUserId) return false;
        if (event.draft === null) return true;
        if (this.store.getChatMember(event.chatId, audienceUserId) === null) return false;
        const currentDraft = this.store.getChatDraft(audienceUserId, event.chatId);
        return currentDraft !== null &&
          currentDraft.deletedAt === null &&
          currentDraft.revision === event.revision &&
          currentDraft.updatedAt === event.changedAt &&
          currentDraft.text === event.draft.text &&
          currentDraft.replyToMessageId === event.draft.replyToMessageId;
      }
      case "sync.invalidated":
        return event.accountId === audienceUserId;
    }

    const chatId = this.#eventChatId(event);
    if (chatId === null) return true;
    if (this.store.getChatMember(chatId, audienceUserId) === null) return false;
    const chat = this.store.findChatRecord(chatId);
    if (chat === null) return false;
    if (chat.kind === "direct") {
      const peerIds = this.store.listChatMemberIds(chatId)
        .filter((memberId) => memberId !== audienceUserId);
      return peerIds.length === 0 || (
        peerIds.length === 1 &&
        !this.store.isBlockedBetween(audienceUserId, peerIds[0] as string) &&
        this.store.hasAcceptedRelationship(audienceUserId, peerIds[0] as string)
      );
    }
    const actorUserId = event.type === "reaction.updated"
      ? event.actorUserId
      : event.type === "receipt.delivered" || event.type === "receipt.read"
        ? event.userId
        : null;
    return actorUserId === null ||
      actorUserId === audienceUserId ||
      !this.store.isBlockedBetween(audienceUserId, actorUserId);
  }

  #eventChatId(event: DurableRealtimeEvent): string | null {
    switch (event.type) {
      case "chat.created": return event.chat.id;
      case "message.created":
      case "message.updated":
      case "message.deleted": return event.message.chatId;
      case "message.pinned": return event.pin.chatId;
      case "message.unpinned":
      case "receipt.delivered":
      case "receipt.read":
      case "reaction.updated": return event.chatId;
      case "topic.created":
      case "topic.updated": return event.topic.chatId;
      case "chat.member.changed": return event.membership.chatId;
      case "chat.preferences.updated": return event.chatId;
      case "chat.folders.updated": return null;
      case "chat.draft.changed": return event.chatId;
      case "sync.invalidated": return null;
      case "attachment.stored":
      case "relationship.request.created":
      case "relationship.request.removed":
      case "relationship.request.accepted":
      case "relationship.request.expired":
      case "relationship.block.changed":
      case "safety.report.submitted": return null;
    }
  }

  #send(
    connection: RealtimeConnection,
    message: ServerRealtimeMessage | ServerRealtimeMessageV2
  ): void {
    if (
      this.#backpressuredConnectionIds.has(connection.id) ||
      connection.socket.readyState !== 1
    ) return;
    const serialized = JSON.stringify(message);
    if (connection.socket.bufferedAmount + Buffer.byteLength(serialized, "utf8") > MAX_BUFFERED_BYTES) {
      this.#disconnectForBackpressure(
        connection,
        "Client is too slow; reconnect and synchronize",
        true
      );
      return;
    }
    connection.socket.send(serialized);
  }

  #disconnectForBackpressure(
    connection: RealtimeConnection,
    closeReason: string,
    announce: boolean
  ): void {
    if (this.#backpressuredConnectionIds.has(connection.id)) return;
    this.#backpressuredConnectionIds.add(connection.id);
    connection.active = false;
    connection.queue.length = 0;
    this.metrics.recordRealtimeGuard("backpressure");

    try {
      if (announce && connection.socket.readyState === 1) {
        const message: ServerRealtimeMessage | ServerRealtimeMessageV2 = connection.protocolVersion === 1
          ? { type: "sync.required", reason: "backpressure" }
          : {
              type: "sync.required",
              reason: "backpressure",
              headSequence: this.store.getLatestSequence(),
              recovery: { type: "http_snapshot", path: "/v2/sync/snapshot" }
            };
        const serialized = JSON.stringify(message);
        if (connection.socket.bufferedAmount + Buffer.byteLength(serialized, "utf8") <= MAX_BUFFERED_BYTES) {
          connection.socket.send(serialized);
        }
      }
    } catch {
      // Reconciliation hints are best-effort when the store or socket is
      // already unavailable under pressure.
    } finally {
      if (connection.socket.readyState === 0 || connection.socket.readyState === 1) {
        connection.socket.close(1013, closeReason);
      }
    }
  }

  #cannotContinueActivation(connection: RealtimeConnection): boolean {
    return this.#backpressuredConnectionIds.has(connection.id) || connection.socket.readyState !== 1;
  }

  #ensureSessionActive(connection: RealtimeConnection): boolean {
    try {
      if (this.store.isSessionActive(
        connection.sessionId,
        connection.userId,
        new Date().toISOString()
      )) return true;
    } catch {
      connection.active = false;
      connection.queue.length = 0;
      connection.socket.close(1011, "Session status unavailable");
      return false;
    }
    connection.active = false;
    connection.queue.length = 0;
    connection.socket.close(4001, "Session expired or revoked");
    return false;
  }

  #broadcastPresence(userId: string, presence: "online" | "offline", lastSeenAt: string | null): void {
    this.publishEphemeral(this.store.listPeerUserIds(userId), {
      type: "presence.updated",
      userId,
      presence,
      lastSeenAt
    });
  }
}
