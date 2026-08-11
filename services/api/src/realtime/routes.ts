import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import {
  AttachmentListResponseSchema,
  BlockListResponseSchema,
  ChatListResponseSchema,
  ClientRealtimeMessageSchema,
  CursorQuerySchema,
  IdSchema,
  MessageReactionListResponseSchema,
  MessageReceiptListResponseSchema,
  RealtimeSnapshotResponseSchema,
  SafetyReportListResponseSchema
} from "@luxora/protocol";
import type WebSocket from "ws";
import type { Store } from "../domain/store.js";
import type { AuthenticatedPrincipal } from "../domain/types.js";
import { AppError, unauthenticated } from "../errors.js";
import { TokenSecurity } from "../security.js";
import type { ChatService } from "../services/chat-service.js";
import { RealtimeCursorCodec } from "./cursor.js";
import type { RealtimeConnection } from "./hub.js";
import { RealtimeHub } from "./hub.js";
import { shouldPublishTyping, TYPING_TTL_MS } from "./typing-throttle.js";
import { clientIpBucketKey } from "../client-ip.js";

const AUTHENTICATION_TIMEOUT_MS = 5_000;
const HEARTBEAT_INTERVAL_MS = 25_000;
const CONNECTION_STALE_MS = 60_000;
const FRAME_RATE_WINDOW_MS = 10_000;
const MAX_FRAMES_PER_WINDOW = 120;
const TYPING_RATE_WINDOW_MS = 5_000;
const MAX_TYPING_FRAMES_PER_WINDOW = 8;
const AUTH_ATTEMPT_WINDOW_MS = 60_000;
const MAX_AUTH_ATTEMPTS_PER_IP = 60;
const MAX_PENDING_CONNECTIONS_PER_IP = 16;
const MAX_CONNECTIONS_PER_SESSION = 4;
const ReconciliationPageQuerySchema = CursorQuerySchema.strict();

interface WindowCounter {
  startedAt: number;
  used: number;
  denialNotified: boolean;
}

type WindowDecision = "allowed" | "first_denial" | "denied";

function takeWindow(
  counter: WindowCounter,
  now: number,
  windowMs: number,
  maximum: number
): WindowDecision {
  if (now - counter.startedAt >= windowMs) {
    counter.startedAt = now;
    counter.used = 0;
    counter.denialNotified = false;
  }
  if (counter.used < maximum) {
    counter.used += 1;
    return "allowed";
  }
  if (!counter.denialNotified) {
    counter.denialNotified = true;
    return "first_denial";
  }
  return "denied";
}

class RealtimeConnectionGuard {
  readonly #pendingByIp = new Map<string, number>();
  readonly #activeBySession = new Map<string, number>();
  readonly #authByIp = new Map<string, WindowCounter>();

  acquirePending(ip: string): boolean {
    const current = this.#pendingByIp.get(ip) ?? 0;
    if (current >= MAX_PENDING_CONNECTIONS_PER_IP) return false;
    this.#pendingByIp.set(ip, current + 1);
    return true;
  }

  releasePending(ip: string): void {
    this.#decrement(this.#pendingByIp, ip);
  }

  acquireSession(sessionId: string): boolean {
    const current = this.#activeBySession.get(sessionId) ?? 0;
    if (current >= MAX_CONNECTIONS_PER_SESSION) return false;
    this.#activeBySession.set(sessionId, current + 1);
    return true;
  }

  releaseSession(sessionId: string): void {
    this.#decrement(this.#activeBySession, sessionId);
  }

  takeAuthentication(ip: string, now: number): boolean {
    let counter = this.#authByIp.get(ip);
    if (counter === undefined) {
      counter = { startedAt: now, used: 0, denialNotified: false };
      this.#authByIp.set(ip, counter);
    }
    return takeWindow(counter, now, AUTH_ATTEMPT_WINDOW_MS, MAX_AUTH_ATTEMPTS_PER_IP) === "allowed";
  }

  prune(now = Date.now()): void {
    for (const [ip, counter] of this.#authByIp) {
      if (now - counter.startedAt >= AUTH_ATTEMPT_WINDOW_MS) this.#authByIp.delete(ip);
    }
  }

  clear(): void {
    this.#pendingByIp.clear();
    this.#activeBySession.clear();
    this.#authByIp.clear();
  }

  #decrement(counts: Map<string, number>, key: string): void {
    const next = (counts.get(key) ?? 0) - 1;
    if (next <= 0) counts.delete(key);
    else counts.set(key, next);
  }
}

interface RealtimeDependencies {
  store: Store;
  security: TokenSecurity;
  chats: ChatService;
  hub: RealtimeHub;
  cursors: RealtimeCursorCodec;
  allowedOrigins: string[];
}

function send(socket: WebSocket, message: unknown): void {
  if (socket.readyState === 1) socket.send(JSON.stringify(message));
}

function realtimeError(socket: WebSocket, error: unknown): void {
  if (error instanceof AppError) {
    send(socket, { type: "error", code: error.code, message: error.message });
  } else {
    send(socket, { type: "error", code: "BAD_REQUEST", message: "Invalid realtime message" });
  }
}

function realtimeRateLimited(socket: WebSocket, message: string): void {
  send(socket, { type: "error", code: "RATE_LIMITED", message });
}

function realtimeSessionStatus(
  socket: WebSocket,
  dependencies: RealtimeDependencies,
  sessionId: string,
  userId: string
): boolean | null {
  try {
    return dependencies.store.isSessionActive(sessionId, userId, new Date().toISOString());
  } catch {
    socket.close(1011, "Session status unavailable");
    return null;
  }
}

export function registerRealtimeRoutes(app: FastifyInstance, dependencies: RealtimeDependencies): void {
  const connectionGuard = new RealtimeConnectionGuard();
  const guardCleanup = setInterval(() => connectionGuard.prune(), AUTH_ATTEMPT_WINDOW_MS);
  guardCleanup.unref();
  app.addHook("onClose", async () => {
    clearInterval(guardCleanup);
    connectionGuard.clear();
  });
  registerSnapshotRoute(app, dependencies);
  registerReconciliationResourceRoutes(app, dependencies);
  registerRealtimeRoute(app, "/v1/realtime", 1, dependencies, connectionGuard);
  registerRealtimeRoute(app, "/v2/realtime", 2, dependencies, connectionGuard);
}

function messageIdFromParams(params: unknown): string {
  if (typeof params !== "object" || params === null || !("messageId" in params)) {
    return IdSchema.parse(undefined);
  }
  return IdSchema.parse(params.messageId);
}

function registerReconciliationResourceRoutes(
  app: FastifyInstance,
  dependencies: RealtimeDependencies
): void {
  app.get("/v1/messages/:messageId/reactions", async (request, reply) => {
    setReconciliationCacheHeaders(reply);
    const principal = await authenticateSnapshotRequest(request, dependencies);
    const response = MessageReactionListResponseSchema.parse({
      items: dependencies.chats.listMessageReactions(
        principal.userId,
        messageIdFromParams(request.params)
      )
    });
    return reply.send(response);
  });

  app.get("/v1/messages/:messageId/receipts", async (request, reply) => {
    setReconciliationCacheHeaders(reply);
    const principal = await authenticateSnapshotRequest(request, dependencies);
    const response = MessageReceiptListResponseSchema.parse({
      items: dependencies.chats.listMessageReceipts(
        principal.userId,
        messageIdFromParams(request.params)
      )
    });
    return reply.send(response);
  });

  app.get("/v1/attachments", async (request, reply) => {
    setReconciliationCacheHeaders(reply);
    const principal = await authenticateSnapshotRequest(request, dependencies);
    const query = ReconciliationPageQuerySchema.parse(request.query);
    const response = AttachmentListResponseSchema.parse(
      dependencies.store.listOwnedAttachments(
        principal.userId,
        query.limit,
        query.cursor
      )
    );
    return reply.send(response);
  });

  app.get("/v1/safety/reports", async (request, reply) => {
    setReconciliationCacheHeaders(reply);
    const principal = await authenticateSnapshotRequest(request, dependencies);
    const query = ReconciliationPageQuerySchema.parse(request.query);
    const page = dependencies.store.listSafetyReports(
      principal.userId,
      query.limit,
      query.cursor
    );
    const response = SafetyReportListResponseSchema.parse({
      items: page.items.map((report) => ({
        id: report.id,
        subjectAccountId: report.subjectUserId,
        category: report.category,
        evidenceCount: report.evidence.length,
        alsoBlocked: report.alsoBlocked,
        status: "submitted",
        submittedAt: report.createdAt
      })),
      nextCursor: page.nextCursor
    });
    return reply.send(response);
  });

  app.get("/v2/sync/chats", async (request, reply) => {
    setReconciliationCacheHeaders(reply);
    const principal = await authenticateSnapshotRequest(request, dependencies);
    const query = ReconciliationPageQuerySchema.parse(request.query);
    const response = ChatListResponseSchema.parse(
      dependencies.store.listChatsForReconciliation(
        principal.userId,
        query.limit,
        query.cursor
      )
    );
    return reply.send(response);
  });

  app.get("/v2/sync/blocks", async (request, reply) => {
    setReconciliationCacheHeaders(reply);
    const principal = await authenticateSnapshotRequest(request, dependencies);
    const query = ReconciliationPageQuerySchema.parse(request.query);
    const page = dependencies.store.listBlocksForReconciliation(
      principal.userId,
      query.limit,
      query.cursor
    );
    const response = BlockListResponseSchema.parse({
      items: page.items.map((block) => ({
        accountId: block.blockedUserId,
        profileSnapshot: block.profileSnapshot,
        blockedAt: block.createdAt
      })),
      nextCursor: page.nextCursor
    });
    return reply.send(response);
  });
}

function setReconciliationCacheHeaders(reply: { header(name: string, value: string): unknown }): void {
  reply.header("cache-control", "private, no-store");
  reply.header("pragma", "no-cache");
}

async function authenticateSnapshotRequest(
  request: FastifyRequest,
  dependencies: RealtimeDependencies
): Promise<AuthenticatedPrincipal> {
  const header = request.headers.authorization;
  if (header === undefined || !header.startsWith("Bearer ") || header.length <= 7) {
    throw unauthenticated();
  }
  const principal = await dependencies.security.verifyAccessToken(header.slice(7));
  if (!dependencies.store.isSessionActive(principal.sessionId, principal.userId, new Date().toISOString())) {
    throw unauthenticated("Session is no longer active");
  }
  return principal;
}

function registerSnapshotRoute(app: FastifyInstance, dependencies: RealtimeDependencies): void {
  app.get("/v2/sync/snapshot", {
    config: { rateLimit: { max: 30, timeWindow: "1 minute" } }
  }, async (request, reply) => {
    setReconciliationCacheHeaders(reply);
    const principal = await authenticateSnapshotRequest(request, dependencies);
    const capturedAt = new Date();
    const sequence = dependencies.store.getLatestSequence();
    const boundary = dependencies.cursors.issue(
      principal.userId,
      principal.sessionId,
      sequence,
      capturedAt
    );
    // Revocation wins if it races the initial check and boundary creation.
    if (!dependencies.store.isSessionActive(
      principal.sessionId,
      principal.userId,
      new Date().toISOString()
    )) {
      throw unauthenticated("Session is no longer active");
    }

    const response = RealtimeSnapshotResponseSchema.parse({
      contractVersion: 1,
      scope: "account_session",
      boundary: {
        sequence,
        cursor: boundary.cursor,
        capturedAt: capturedAt.toISOString(),
        cursorExpiresAt: boundary.expiresAt.toISOString()
      },
      reset: {
        required: true,
        collections: [
          "message_requests",
          "blocks",
          "chats",
          "members",
          "messages",
          "pins",
          "topics",
          "reactions",
          "receipts",
          "attachments",
          "safety_reports",
          "chat_folders"
        ]
      },
      resources: {
        incomingMessageRequests: "/v1/message-requests?direction=incoming",
        outgoingMessageRequests: "/v1/message-requests?direction=outgoing",
        blocks: "/v2/sync/blocks",
        chats: "/v2/sync/chats",
        attachments: "/v1/attachments",
        safetyReports: "/v1/safety/reports",
        chatFolders: "/v1/chat-folders",
        membersTemplate: "/v1/chats/{chatId}/members",
        messagesTemplate: "/v1/chats/{chatId}/messages",
        pinsTemplate: "/v1/chats/{chatId}/pins",
        topicsTemplate: "/v1/chats/{chatId}/topics",
        reactionsTemplate: "/v1/messages/{messageId}/reactions",
        receiptsTemplate: "/v1/messages/{messageId}/receipts"
      },
      pagination: {
        cursorParameter: "cursor",
        limitParameter: "limit",
        nextCursorField: "nextCursor",
        maxPageSize: 100
      },
      resume: {
        websocketPath: "/v2/realtime",
        authenticateField: "resumeCursor",
        applyEventsIdempotently: true,
        sequenceAdjacencyRequired: false
      }
    });
    return reply.send(response);
  });
}

function registerRealtimeRoute(
  app: FastifyInstance,
  path: "/v1/realtime" | "/v2/realtime",
  protocolVersion: 1 | 2,
  dependencies: RealtimeDependencies,
  connectionGuard: RealtimeConnectionGuard
): void {
  app.get(path, { websocket: true }, (socket, request) => {
    const origin = request.headers.origin;
    if (origin !== undefined && !dependencies.allowedOrigins.includes(origin)) {
      send(socket, { type: "error", code: "FORBIDDEN", message: "WebSocket origin is not allowed" });
      socket.close(1008, "Origin not allowed");
      return;
    }
    const clientIp = clientIpBucketKey(request.ip);
    if (!connectionGuard.acquirePending(clientIp)) {
      dependencies.hub.recordGuard("pending_connections");
      realtimeRateLimited(socket, "Too many pending realtime connections");
      socket.close(1013, "Try again later");
      return;
    }
    const connectionId = randomUUID();
    let connection: RealtimeConnection | null = null;
    let principal: AuthenticatedPrincipal | null = null;
    let ownsPendingSlot = true;
    let ownedSessionSlot: string | null = null;
    let acceptingFrames = true;
    let processing = Promise.resolve();
    const frameWindow: WindowCounter = {
      startedAt: Date.now(),
      used: 0,
      denialNotified: false
    };
    const typingWindow: WindowCounter = {
      startedAt: Date.now(),
      used: 0,
      denialNotified: false
    };

    send(socket, {
      type: "hello",
      protocolVersion,
      connectionId,
      heartbeatIntervalMs: HEARTBEAT_INTERVAL_MS
    });

    const authenticationTimeout = setTimeout(() => {
      send(socket, { type: "error", code: "UNAUTHENTICATED", message: "Authentication timed out" });
      socket.close(4001, "Authentication required");
    }, AUTHENTICATION_TIMEOUT_MS);
    authenticationTimeout.unref();

    const heartbeatInterval = setInterval(() => {
      if (connection === null) return;
      if (socket.readyState !== 1) return;
      const sessionActive = realtimeSessionStatus(
        socket,
        dependencies,
        connection.sessionId,
        connection.userId
      );
      if (sessionActive === null) return;
      if (!sessionActive) {
        socket.close(4001, "Session expired or revoked");
        return;
      }
      if (Date.now() - connection.lastAliveAt > CONNECTION_STALE_MS) {
        socket.terminate();
        return;
      }
      send(socket, { type: "heartbeat", timestamp: new Date().toISOString() });
      socket.ping();
    }, HEARTBEAT_INTERVAL_MS);
    heartbeatInterval.unref();

    socket.on("pong", () => {
      if (connection !== null) dependencies.hub.markAlive(connection);
    });

    socket.on("message", (raw, isBinary) => {
      if (!acceptingFrames) return;
      const frameDecision = takeWindow(
        frameWindow,
        Date.now(),
        FRAME_RATE_WINDOW_MS,
        MAX_FRAMES_PER_WINDOW
      );
      if (frameDecision !== "allowed") {
        acceptingFrames = false;
        dependencies.hub.recordGuard("frame_rate");
        realtimeRateLimited(socket, "Too many realtime frames");
        socket.close(1008, "Realtime frame rate exceeded");
        return;
      }
      processing = processing.then(async () => {
        if (!acceptingFrames || socket.readyState !== 1) return;
        if (isBinary) throw new AppError(400, "BAD_REQUEST", "Binary realtime frames are not supported");
        let untrusted: unknown;
        try {
          untrusted = JSON.parse(raw.toString("utf8")) as unknown;
        } catch {
          throw new AppError(400, "BAD_REQUEST", "Realtime frames must be valid JSON");
        }
        const message = ClientRealtimeMessageSchema.parse(untrusted);

        if (message.type === "authenticate") {
          if (!connectionGuard.takeAuthentication(clientIp, Date.now())) {
            dependencies.hub.recordGuard("auth_rate");
            realtimeRateLimited(socket, "Too many realtime authentication attempts");
            socket.close(1013, "Try again later");
            return;
          }
          if (principal !== null) throw new AppError(409, "CONFLICT", "Connection is already authenticated");
          const verified = await dependencies.security.verifyAccessToken(message.accessToken);
          if (!acceptingFrames || socket.readyState !== 1) return;
          const sessionActive = realtimeSessionStatus(
            socket,
            dependencies,
            verified.sessionId,
            verified.userId
          );
          if (sessionActive === null) return;
          if (!sessionActive) {
            throw new AppError(401, "UNAUTHENTICATED", "Session is no longer active");
          }
          if (!connectionGuard.acquireSession(verified.sessionId)) {
            dependencies.hub.recordGuard("session_connections");
            realtimeRateLimited(socket, "Too many realtime connections for this device session");
            socket.close(1013, "Try again later");
            return;
          }
          ownedSessionSlot = verified.sessionId;
          connectionGuard.releasePending(clientIp);
          ownsPendingSlot = false;
          principal = verified;
          dependencies.store.touchSession(principal.sessionId, new Date().toISOString());
          connection = {
            id: connectionId,
            userId: principal.userId,
            sessionId: principal.sessionId,
            socket,
            protocolVersion,
            active: false,
            queue: [],
            lastAliveAt: Date.now(),
            lastTypingAtByChat: new Map()
          };
          clearTimeout(authenticationTimeout);
          dependencies.hub.registerPending(connection);
          dependencies.hub.activate(connection, {
            ...(message.resumeFrom === undefined ? {} : { resumeFrom: message.resumeFrom }),
            ...(message.resumeCursor === undefined ? {} : { resumeCursor: message.resumeCursor })
          });
          return;
        }

        if (principal === null || connection === null) {
          throw new AppError(401, "UNAUTHENTICATED", "Authenticate before sending realtime commands");
        }
        const sessionActive = realtimeSessionStatus(
          socket,
          dependencies,
          connection.sessionId,
          connection.userId
        );
        if (sessionActive === null) return;
        if (!sessionActive) {
          throw new AppError(401, "UNAUTHENTICATED", "Session is no longer active");
        }
        if (!connection.active) {
          throw new AppError(409, "CONFLICT", "Authoritative synchronization is required");
        }
        if (message.type === "heartbeat") {
          dependencies.hub.markAlive(connection);
          send(socket, { type: "heartbeat.ack", timestamp: message.timestamp });
          return;
        }
        if (message.type === "receipt.delivered") {
          dependencies.chats.markDelivered(principal.userId, message.chatId, message.messageId);
          return;
        }
        if (message.type === "receipt.read") {
          dependencies.chats.markRead(principal.userId, message.chatId, message.messageId);
          return;
        }
        if (message.type === "typing.start" || message.type === "typing.stop") {
          const typingDecision = takeWindow(
            typingWindow,
            Date.now(),
            TYPING_RATE_WINDOW_MS,
            MAX_TYPING_FRAMES_PER_WINDOW
          );
          if (typingDecision !== "allowed") {
            if (typingDecision === "first_denial") {
              dependencies.hub.recordGuard("typing_rate");
              realtimeRateLimited(socket, "Too many typing updates");
            }
            return;
          }
          const actorUserId = principal.userId;
          const member = dependencies.store.getChatMember(message.chatId, actorUserId);
          if (member === null) throw new AppError(403, "FORBIDDEN", "You are not a member of this chat");
          const chat = dependencies.store.findChatRecord(message.chatId);
          const memberIds = dependencies.store.listChatMemberIds(message.chatId);
          if (
            chat?.kind === "direct" &&
            memberIds.some((userId) => userId !== actorUserId && (
              dependencies.store.isBlockedBetween(actorUserId, userId) ||
              !dependencies.store.hasAcceptedRelationship(actorUserId, userId)
            ))
          ) {
            throw new AppError(403, "FORBIDDEN", "Relationship is unavailable");
          }
          const now = Date.now();
          if (!shouldPublishTyping(connection.lastTypingAtByChat, message.chatId, now)) return;
          const audience = memberIds.filter((userId) => userId === actorUserId ||
            !dependencies.store.isBlockedBetween(actorUserId, userId));
          dependencies.hub.publishEphemeral(
            audience,
            {
              type: "typing.updated",
              chatId: message.chatId,
              userId: actorUserId,
              isTyping: message.type === "typing.start",
              expiresAt: new Date(now + TYPING_TTL_MS).toISOString()
            },
            connection.id
          );
        }
      }).catch((error: unknown) => {
        realtimeError(socket, error);
        if (error instanceof AppError && error.statusCode === 401) {
          socket.close(4001, "Authentication failed");
        }
      });
    });

    socket.once("close", () => {
      acceptingFrames = false;
      clearTimeout(authenticationTimeout);
      clearInterval(heartbeatInterval);
      if (ownsPendingSlot) connectionGuard.releasePending(clientIp);
      if (ownedSessionSlot !== null) connectionGuard.releaseSession(ownedSessionSlot);
      if (connection !== null) dependencies.hub.remove(connection);
    });
  });
}
