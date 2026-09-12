import { randomUUID } from "node:crypto";
import type {
  AcceptMessageRequestResponse,
  BlockListResponse,
  BlockMutationResponse,
  CreateMessageRequest,
  CreateSafetyReport,
  MessageRequestListResponse,
  MessageRequestRecipientProjection,
  MessageRequestSenderProjection,
  PatchPrivacySettings,
  PrivacySettings,
  PublicProfile,
  SafetyReportSummary,
  User
} from "@luxora/protocol";
import type { Store } from "../domain/store.js";
import type {
  MessageRequestRecord,
  SafetyEvidenceSnapshot,
  SafetyReportRecord,
  StoredEvent,
  UserRecord
} from "../domain/types.js";
import { conflict, forbidden, notFound } from "../errors.js";
import type { SearchHasher } from "../infrastructure/search-hasher.js";
import type { EventPublisher } from "./event-publisher.js";

const REQUEST_TTL_MS = 30 * 86_400_000;
const REQUEST_RESEND_COOLDOWN_MS = 30 * 86_400_000;
const MAX_EXPIRATIONS_PER_ACTION = 100;

class MessageRequestAcceptLostRace extends Error {}

function pairKey(leftUserId: string, rightUserId: string): string {
  return [leftUserId, rightUserId].sort().join(":");
}

function directKey(leftUserId: string, rightUserId: string): string {
  return [leftUserId, rightUserId].sort().join(":");
}

function toPublicProfile(user: UserRecord): PublicProfile {
  return {
    id: user.id,
    username: user.username,
    displayName: user.displayName,
    bio: user.bio,
    avatarUrl: user.avatarUrl,
    avatarPath: user.avatarPath ?? null
  };
}

function expiresAt(now: Date): string {
  return new Date(now.getTime() + REQUEST_TTL_MS).toISOString();
}

function cooldownSince(now: Date): string {
  return new Date(now.getTime() - REQUEST_RESEND_COOLDOWN_MS).toISOString();
}

function isSqliteUniqueConstraint(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code = "code" in error && typeof error.code === "string" ? error.code : "";
  return code.startsWith("SQLITE_CONSTRAINT") || error.message.includes("UNIQUE constraint failed");
}

export class IdentityAccessService {
  constructor(
    private readonly store: Store,
    private readonly publisher: EventPublisher,
    private readonly search: SearchHasher,
    private readonly clock: () => Date = () => new Date()
  ) {}

  lookupUser(viewerUserId: string, username: string): PublicProfile | null {
    const user = this.store.findDiscoverableUserByUsername(viewerUserId, username.toLowerCase());
    if (user === null) return null;
    const profile = toPublicProfile(user);
    const privacy = this.store.getPrivacySettings(user.id);
    if (!this.store.privacyAllows(user.id, viewerUserId, privacy.profilePhoto)) {
      profile.avatarUrl = null;
      profile.avatarPath = null;
    }
    return {
      ...profile,
      lastSeenAt: this.store.privacyAllows(user.id, viewerUserId, privacy.lastSeen)
        ? (user.lastSeenAt ?? null)
        : null
    };
  }

  searchKnownUsers(
    viewerUserId: string,
    query: string,
    limit: number,
    cursor?: string
  ): { items: User[]; nextCursor: string | null } {
    return this.store.searchKnownUsers(viewerUserId, query, limit, cursor);
  }

  getPrivacySettings(userId: string): PrivacySettings {
    const settings = this.store.getPrivacySettings(userId);
    return {
      usernameDiscoverable: settings.usernameDiscoverable,
      messageRequests: settings.messageRequests,
      lastSeen: settings.lastSeen,
      profilePhoto: settings.profilePhoto,
      forwards: settings.forwards,
      voiceMessages: settings.voiceMessages,
      calls: settings.calls
    };
  }

  updatePrivacySettings(userId: string, update: PatchPrivacySettings): PrivacySettings {
    const at = this.clock().toISOString();
    const settings = this.store.transaction(() => {
      const changed = this.store.updatePrivacySettings(userId, {
        ...(update.usernameDiscoverable === undefined
          ? {}
          : { usernameDiscoverable: update.usernameDiscoverable }),
        ...(update.messageRequests === undefined
          ? {}
          : { messageRequests: update.messageRequests }),
        ...(update.lastSeen === undefined ? {} : { lastSeen: update.lastSeen }),
        ...(update.profilePhoto === undefined ? {} : { profilePhoto: update.profilePhoto }),
        ...(update.forwards === undefined ? {} : { forwards: update.forwards }),
        ...(update.voiceMessages === undefined ? {} : { voiceMessages: update.voiceMessages }),
        ...(update.calls === undefined ? {} : { calls: update.calls })
      }, at);
      this.store.appendIdentityAudit({
        id: randomUUID(),
        accountUserId: userId,
        actorUserId: userId,
        action: "privacy.updated",
        targetUserId: null,
        resourceId: null,
        createdAt: at
      });
      return changed;
    });
    return {
      usernameDiscoverable: settings.usernameDiscoverable,
      messageRequests: settings.messageRequests,
      lastSeen: settings.lastSeen,
      profilePhoto: settings.profilePhoto,
      forwards: settings.forwards,
      voiceMessages: settings.voiceMessages,
      calls: settings.calls
    };
  }

  createMessageRequest(senderUserId: string, input: CreateMessageRequest): MessageRequestSenderProjection {
    if (senderUserId === input.recipientUserId) {
      throw conflict("Saved messages do not use message requests");
    }

    const duplicate = this.store.findMessageRequestByNonce(senderUserId, input.clientNonce);
    if (duplicate !== null) {
      if (
        duplicate.recipientId !== input.recipientUserId ||
        duplicate.body !== input.body ||
        duplicate.linkUrl !== input.validatedLink
      ) {
        throw conflict("clientNonce was already used for a different message request");
      }
      return this.#senderProjection(duplicate);
    }

    const recipient = this.store.findUserById(input.recipientUserId);
    if (recipient === null) throw this.#relationshipUnavailable();
    const sender = this.store.findUserById(senderUserId);
    if (sender === null) throw this.#relationshipUnavailable();
    const privacy = this.store.getPrivacySettings(recipient.id);
    if (
      privacy.messageRequests !== "everyone" ||
      this.store.isBlockedBetween(senderUserId, recipient.id)
    ) {
      throw this.#relationshipUnavailable();
    }
    if (this.store.hasAcceptedRelationship(senderUserId, recipient.id)) {
      throw conflict("The relationship is already accepted", { reason: "relationship_accepted" });
    }

    const now = this.clock();
    this.#expireForUser(senderUserId, now.toISOString());
    const key = pairKey(senderUserId, recipient.id);
    const pending = this.store.findPendingMessageRequestByPair(key);
    if (pending !== null) {
      const reason = pending.senderId === senderUserId
        ? "request_already_pending"
        : "incoming_request_exists";
      throw conflict("A message request already exists", { reason });
    }
    if (
      this.store.findRecentDismissedMessageRequest(
        senderUserId,
        recipient.id,
        cooldownSince(now)
      ) !== null
    ) {
      throw this.#relationshipUnavailable();
    }

    const createdAt = now.toISOString();
    let result: { request: MessageRequestRecord; events: StoredEvent[] };
    try {
      result = this.store.immediateTransaction(() => {
        // Acquire SQLite's writer reservation before the nonce recheck. Two API
        // processes/connections can both miss the optimistic read above, but
        // only one can pass this check and create side effects.
        const concurrentNonce = this.store.findMessageRequestByNonce(
          senderUserId,
          input.clientNonce
        );
        if (concurrentNonce !== null) {
          if (
            concurrentNonce.recipientId !== input.recipientUserId ||
            concurrentNonce.body !== input.body ||
            concurrentNonce.linkUrl !== input.validatedLink
          ) {
            throw conflict("clientNonce was already used for a different message request");
          }
          return { request: concurrentNonce, events: [] };
        }
        if (this.store.isBlockedBetween(senderUserId, recipient.id)) {
          throw this.#relationshipUnavailable();
        }
        if (this.store.getPrivacySettings(recipient.id).messageRequests !== "everyone") {
          throw this.#relationshipUnavailable();
        }
        if (this.store.hasAcceptedRelationship(senderUserId, recipient.id)) {
          throw conflict("The relationship is already accepted", { reason: "relationship_accepted" });
        }
        const concurrentPending = this.store.findPendingMessageRequestByPair(key);
        if (concurrentPending !== null) {
          const reason = concurrentPending.senderId === senderUserId
            ? "request_already_pending"
            : "incoming_request_exists";
          throw conflict("A message request already exists", { reason });
        }
        if (
          this.store.findRecentDismissedMessageRequest(
            senderUserId,
            recipient.id,
            cooldownSince(now)
          ) !== null
        ) {
          throw this.#relationshipUnavailable();
        }
        const request = this.store.createMessageRequest({
          id: randomUUID(),
          pairKey: key,
          senderId: senderUserId,
          recipientId: recipient.id,
          clientNonce: input.clientNonce,
          body: input.body,
          linkUrl: input.validatedLink,
          senderProfile: toPublicProfile(sender),
          recipientProfile: toPublicProfile(recipient),
          createdAt,
          expiresAt: expiresAt(now)
        });
        const senderProjection = this.#senderProjection(request);
        const recipientProjection = this.#recipientProjection(request);
        const events = [
          this.store.appendEvent(senderUserId, {
            type: "relationship.request.created",
            audience: "sender_account",
            request: { ...senderProjection, state: "pending" }
          }, createdAt),
          this.store.appendEvent(recipient.id, {
            type: "relationship.request.created",
            audience: "recipient_account",
            request: { ...recipientProjection, state: "pending" }
          }, createdAt)
        ];
        this.store.appendIdentityAudit({
          id: randomUUID(),
          accountUserId: senderUserId,
          actorUserId: senderUserId,
          action: "message_request.created",
          targetUserId: recipient.id,
          resourceId: request.id,
          createdAt
        });
        return { request, events };
      });
    } catch (error) {
      if (!isSqliteUniqueConstraint(error)) throw error;
      const concurrentNonce = this.store.findMessageRequestByNonce(senderUserId, input.clientNonce);
      if (concurrentNonce !== null) {
        if (
          concurrentNonce.recipientId === input.recipientUserId &&
          concurrentNonce.body === input.body &&
          concurrentNonce.linkUrl === input.validatedLink
        ) return this.#senderProjection(concurrentNonce);
        throw conflict("clientNonce was already used for a different message request");
      }
      const concurrent = this.store.findPendingMessageRequestByPair(key);
      if (
        concurrent !== null &&
        concurrent.senderId === senderUserId &&
        concurrent.clientNonce === input.clientNonce &&
        concurrent.body === input.body &&
        concurrent.linkUrl === input.validatedLink
      ) return this.#senderProjection(concurrent);
      throw conflict("A message request already exists", { reason: "request_already_pending" });
    }
    this.publisher.publish(result.events);
    return this.#senderProjection(result.request);
  }

  listMessageRequests(
    userId: string,
    direction: "incoming" | "outgoing",
    limit: number,
    cursor?: string
  ): MessageRequestListResponse {
    this.#expireForUser(userId, this.clock().toISOString());
    const page = this.store.listMessageRequests(userId, direction, limit, cursor);
    return {
      items: page.items.map((request) => direction === "incoming"
        ? this.#recipientProjection(request)
        : this.#senderProjection(request)),
      nextCursor: page.nextCursor
    };
  }

  acceptMessageRequest(recipientUserId: string, requestId: string): AcceptMessageRequestResponse {
    const now = this.clock().toISOString();
    this.#expireForUser(recipientUserId, now);
    const current = this.store.findMessageRequestById(requestId);
    if (current === null || current.recipientId !== recipientUserId) {
      throw notFound("Message request not found");
    }
    if (current.state === "accepted" && current.chatId !== null && current.acceptedAt !== null) {
      const chat = this.store.getChatForUser(current.chatId, recipientUserId);
      if (chat === null) throw notFound("Accepted conversation not found");
      return {
        request: {
          ...this.#recipientProjection(current),
          state: "accepted",
          acceptedAt: current.acceptedAt
        },
        chat
      };
    }
    if (current.state !== "pending" || this.store.isBlockedBetween(current.senderId, recipientUserId)) {
      throw notFound("Message request not found");
    }

    const key = pairKey(current.senderId, recipientUserId);
    const [leftUserId, rightUserId] = [current.senderId, recipientUserId].sort();
    let result: { chatId: string; events: StoredEvent[] } | null;
    try {
      result = this.store.transaction(() => {
        if (this.store.isBlockedBetween(current.senderId, recipientUserId)) {
          throw notFound("Message request not found");
        }
        const existingDirect = this.store.findDirectChat(directKey(current.senderId, recipientUserId));
        const chatId = existingDirect?.id ?? randomUUID();

        // The request row references the Direct. Create the Direct first inside
        // the same transaction, then use compare-and-set; a lost race throws so
        // the provisional Direct is rolled back instead of being orphaned.
        if (existingDirect === null) {
          this.store.createChat({
            id: chatId,
            kind: "direct",
            title: null,
            directKey: key,
            createdBy: current.senderId,
            createdAt: now
          });
          this.store.addChatMember(chatId, current.senderId, "member", now);
          this.store.addChatMember(chatId, recipientUserId, "member", now);
        }
        const accepted = this.store.acceptMessageRequest(requestId, recipientUserId, chatId, now);
        if (!accepted) throw new MessageRequestAcceptLostRace();
        this.store.createAcceptedRelationship(key, leftUserId as string, rightUserId as string, requestId, now);

      // The request resource ID is a server-generated UUID and therefore forms
      // a distinct idempotency namespace from client-created chat nonces.
      const existingMessage = this.store.findMessageByNonce(current.senderId, current.id);
      const messageRecord = existingMessage ?? this.store.createMessage({
        id: randomUUID(),
        chatId,
        senderId: current.senderId,
        body: current.body,
        replyToMessageId: null,
        topicId: null,
        forwardedFromMessageId: null,
        forwardedFromChatId: null,
        forwardedFromSenderId: null,
        forwardedFromSenderName: null,
        forwardedFromCreatedAt: null,
        clientNonce: current.id,
        createdAt: now,
        transcriptionConsent: false
      });
      if (existingMessage === null) {
        this.store.replaceMessageSearchTokens(messageRecord.id, this.search.index(current.body));
      }
      const message = this.store.getMessage(messageRecord.id);
      if (message === null) throw new Error("Accepted request message could not be materialized");

      const events: StoredEvent[] = [];
      for (const participantUserId of [current.senderId, recipientUserId]) {
        const chat = this.store.getChatForUser(chatId, participantUserId);
        if (chat === null) throw new Error("Accepted direct could not be projected");
        events.push(this.store.appendEvent(participantUserId, { type: "chat.created", chat }, now));
        events.push(this.store.appendEvent(participantUserId, {
          type: "relationship.request.accepted",
          audience: "participant_account",
          requestId,
          chat,
          acceptedAt: now
        }, now));
      }
      events.push(...this.store.appendChatEvent(chatId, { type: "message.created", message }, now));
      this.store.appendIdentityAudit({
        id: randomUUID(),
        accountUserId: recipientUserId,
        actorUserId: recipientUserId,
        action: "message_request.accepted",
        targetUserId: current.senderId,
        resourceId: requestId,
        createdAt: now
      });
        return { chatId, events };
      });
    } catch (error) {
      if (!(error instanceof MessageRequestAcceptLostRace) && !isSqliteUniqueConstraint(error)) {
        throw error;
      }
      const concurrent = this.store.findMessageRequestById(requestId);
      if (concurrent?.state !== "accepted" || concurrent.chatId === null) {
        throw notFound("Message request not found");
      }
      result = null;
    }

    if (result !== null) this.publisher.publish(result.events);
    const acceptedRequest = this.store.findMessageRequestById(requestId);
    if (acceptedRequest === null || acceptedRequest.chatId === null || acceptedRequest.acceptedAt === null) {
      throw new Error("Accepted request state is incomplete");
    }
    const chat = this.store.getChatForUser(acceptedRequest.chatId, recipientUserId);
    if (chat === null) throw new Error("Accepted direct is unavailable");
    return {
      request: {
        ...this.#recipientProjection(acceptedRequest),
        state: "accepted",
        acceptedAt: acceptedRequest.acceptedAt
      },
      chat
    };
  }

  dismissMessageRequest(recipientUserId: string, requestId: string): void {
    const current = this.store.findMessageRequestById(requestId);
    if (current === null || current.recipientId !== recipientUserId) {
      throw notFound("Message request not found");
    }
    if (current.state === "recipient_dismissed") return;
    if (current.state !== "pending") throw notFound("Message request not found");
    const at = this.clock().toISOString();
    const event = this.store.transaction(() => {
      if (!this.store.dismissMessageRequest(requestId, recipientUserId, at)) {
        throw notFound("Message request not found");
      }
      this.store.removeMessageRequestCreatedEvents(recipientUserId, requestId);
      const removed = this.store.appendEvent(recipientUserId, {
        type: "relationship.request.removed",
        audience: "recipient_account",
        requestId,
        removedAt: at
      }, at);
      this.store.appendIdentityAudit({
        id: randomUUID(),
        accountUserId: recipientUserId,
        actorUserId: recipientUserId,
        action: "message_request.dismissed",
        targetUserId: current.senderId,
        resourceId: requestId,
        createdAt: at
      });
      return removed;
    });
    this.publisher.publish([event]);
  }

  blockAccount(blockerUserId: string, blockedUserId: string): BlockMutationResponse {
    if (blockerUserId === blockedUserId) throw conflict("An account cannot block itself");
    const target = this.store.findUserById(blockedUserId);
    if (target === null) throw notFound("Account not found");
    const at = this.clock().toISOString();
    const result = this.store.transaction(() => {
      const block = this.store.createBlock(blockerUserId, blockedUserId, toPublicProfile(target), at);
      if (!block.created) return { record: block.record, events: [] as StoredEvent[] };
      this.store.deleteAcceptedRelationship(blockerUserId, blockedUserId);
      const closedRequests = this.store.closePendingMessageRequestsBetween(blockerUserId, blockedUserId, at);
      const events: StoredEvent[] = [];
      for (const request of closedRequests) {
        this.store.removeMessageRequestCreatedEvents(request.recipientId, request.id);
        if (request.recipientId === blockerUserId) {
          events.push(this.store.appendEvent(blockerUserId, {
            type: "relationship.request.removed",
            audience: "recipient_account",
            requestId: request.id,
            removedAt: at
          }, at));
        }
      }
      this.store.appendIdentityAudit({
        id: randomUUID(),
        accountUserId: blockerUserId,
        actorUserId: blockerUserId,
        action: "block.created",
        targetUserId: blockedUserId,
        resourceId: null,
        createdAt: at
      });
      return {
        record: block.record,
        events: [...events, this.store.appendEvent(blockerUserId, {
          type: "relationship.block.changed",
          audience: "actor_account",
          accountId: blockedUserId,
          blocked: true,
          changedAt: at
        }, at)]
      };
    });
    this.publisher.publish(result.events);
    return {
      accountId: blockedUserId,
      blocked: true,
      changedAt: result.record.createdAt
    };
  }

  unblockAccount(blockerUserId: string, blockedUserId: string): BlockMutationResponse {
    if (blockerUserId === blockedUserId) throw conflict("An account cannot unblock itself");
    const at = this.clock().toISOString();
    const result = this.store.transaction(() => {
      const removed = this.store.deleteBlock(blockerUserId, blockedUserId);
      if (!removed) return [] as StoredEvent[];
      this.store.appendIdentityAudit({
        id: randomUUID(),
        accountUserId: blockerUserId,
        actorUserId: blockerUserId,
        action: "block.removed",
        targetUserId: blockedUserId,
        resourceId: null,
        createdAt: at
      });
      return [this.store.appendEvent(blockerUserId, {
        type: "relationship.block.changed",
        audience: "actor_account",
        accountId: blockedUserId,
        blocked: false,
        changedAt: at
      }, at)];
    });
    this.publisher.publish(result);
    return { accountId: blockedUserId, blocked: false, changedAt: at };
  }

  listBlocks(userId: string, limit: number, cursor?: string): BlockListResponse {
    const page = this.store.listBlocks(userId, limit, cursor);
    return {
      items: page.items.map((block) => ({
        accountId: block.blockedUserId,
        profileSnapshot: block.profileSnapshot,
        blockedAt: block.createdAt
      })),
      nextCursor: page.nextCursor
    };
  }

  createSafetyReport(reporterUserId: string, input: CreateSafetyReport): SafetyReportSummary {
    if (reporterUserId === input.subjectAccountId) throw conflict("An account cannot report itself");
    const duplicate = this.store.findSafetyReportByNonce(reporterUserId, input.clientNonce);
    if (duplicate !== null) {
      if (!this.#sameReport(duplicate, input)) {
        throw conflict("clientNonce was already used for a different safety report");
      }
      return this.#reportSummary(duplicate);
    }
    const subject = this.store.findUserById(input.subjectAccountId);
    if (subject === null) throw notFound("Account not found");
    const at = this.clock().toISOString();
    let result: { report: SafetyReportRecord; events: StoredEvent[] };
    try {
      result = this.store.immediateTransaction(() => {
        // The nonce check must happen after acquiring the writer reservation
        // and before optional block/audit/realtime side effects.
        const concurrent = this.store.findSafetyReportByNonce(
          reporterUserId,
          input.clientNonce
        );
        if (concurrent !== null) {
          if (!this.#sameReport(concurrent, input)) {
            throw conflict("clientNonce was already used for a different safety report");
          }
          return { report: concurrent, events: [] };
        }
        const evidence = input.evidence.map(({ messageId }): SafetyEvidenceSnapshot => {
          const message = this.store.findMessageRecord(messageId);
          if (
            message === null ||
            message.deletedAt !== null ||
            message.senderId !== input.subjectAccountId ||
            this.store.getChatMember(message.chatId, reporterUserId) === null
          ) {
            throw notFound("Selected report evidence is unavailable");
          }
          return {
            type: "message",
            messageId: message.id,
            chatId: message.chatId,
            senderUserId: message.senderId,
            createdAt: message.createdAt,
            body: message.body,
            attachmentIds: this.store.listMessageAttachmentIds(message.id)
          };
        });
        const actorEvents: StoredEvent[] = [];
        let alsoBlocked = false;
        if (input.alsoBlock) {
          const block = this.store.createBlock(
            reporterUserId,
            subject.id,
            toPublicProfile(subject),
            at
          );
          alsoBlocked = true;
          if (block.created) {
            this.store.deleteAcceptedRelationship(reporterUserId, subject.id);
            const closedRequests = this.store.closePendingMessageRequestsBetween(
              reporterUserId,
              subject.id,
              at
            );
            for (const request of closedRequests) {
              this.store.removeMessageRequestCreatedEvents(request.recipientId, request.id);
              if (request.recipientId === reporterUserId) {
                // The actor may synchronize local removal, but the other account
                // receives no signal that a report or block occurred.
                actorEvents.push(this.store.appendEvent(reporterUserId, {
                  type: "relationship.request.removed",
                  audience: "recipient_account",
                  requestId: request.id,
                  removedAt: at
                }, at));
              }
            }
            this.store.appendIdentityAudit({
              id: randomUUID(),
              accountUserId: reporterUserId,
              actorUserId: reporterUserId,
              action: "block.created",
              targetUserId: subject.id,
              resourceId: null,
              createdAt: at
            });
            actorEvents.push(this.store.appendEvent(reporterUserId, {
              type: "relationship.block.changed",
              audience: "actor_account",
              accountId: subject.id,
              blocked: true,
              changedAt: at
            }, at));
          }
        }
        const report = this.store.createSafetyReport({
          id: randomUUID(),
          reporterUserId,
          subjectUserId: subject.id,
          category: input.category,
          evidence,
          comment: input.comment,
          clientNonce: input.clientNonce,
          alsoBlocked,
          createdAt: at
        });
        this.store.appendIdentityAudit({
          id: randomUUID(),
          accountUserId: reporterUserId,
          actorUserId: reporterUserId,
          action: "report.submitted",
          targetUserId: subject.id,
          resourceId: report.id,
          createdAt: at
        });
        const summary = this.#reportSummary(report);
        actorEvents.push(this.store.appendEvent(reporterUserId, {
          type: "safety.report.submitted",
          audience: "actor_account",
          report: summary
        }, at));
        return { report, events: actorEvents };
      });
    } catch (error) {
      if (!isSqliteUniqueConstraint(error)) throw error;
      const concurrent = this.store.findSafetyReportByNonce(reporterUserId, input.clientNonce);
      if (concurrent === null) throw error;
      if (!this.#sameReport(concurrent, input)) {
        throw conflict("clientNonce was already used for a different safety report");
      }
      return this.#reportSummary(concurrent);
    }
    this.publisher.publish(result.events);
    return this.#reportSummary(result.report);
  }

  #senderProjection(request: MessageRequestRecord): MessageRequestSenderProjection {
    return {
      id: request.id,
      direction: "outgoing",
      state: request.state === "recipient_dismissed" ? "pending" : request.state,
      body: request.body,
      recipient: request.recipientProfile,
      createdAt: request.createdAt,
      expiresAt: request.expiresAt
    };
  }

  #recipientProjection(request: MessageRequestRecord): MessageRequestRecipientProjection {
    return {
      id: request.id,
      direction: "incoming",
      state: request.state,
      body: request.body,
      sender: request.senderProfile,
      createdAt: request.createdAt,
      expiresAt: request.expiresAt
    };
  }

  #expireForUser(userId: string, at: string): void {
    const candidates = this.store.listExpiredMessageRequestsForUser(
      userId,
      at,
      MAX_EXPIRATIONS_PER_ACTION
    );
    if (candidates.length === 0) return;
    const events = this.store.immediateTransaction(() => {
      const stored: StoredEvent[] = [];
      for (const request of candidates) {
        if (!this.store.expireMessageRequest(request.id, at)) continue;
        for (const participantUserId of [request.senderId, request.recipientId]) {
          stored.push(this.store.appendEvent(participantUserId, {
            type: "relationship.request.expired",
            audience: "participant_account",
            requestId: request.id,
            expiredAt: at
          }, at));
        }
        this.store.appendIdentityAudit({
          id: randomUUID(),
          accountUserId: request.senderId,
          actorUserId: request.senderId,
          action: "message_request.expired",
          targetUserId: request.recipientId,
          resourceId: request.id,
          createdAt: at
        });
      }
      return stored;
    });
    this.publisher.publish(events);
  }

  #sameReport(existing: SafetyReportRecord, input: CreateSafetyReport): boolean {
    return existing.subjectUserId === input.subjectAccountId &&
      existing.category === input.category &&
      existing.comment === input.comment &&
      existing.alsoBlocked === input.alsoBlock &&
      JSON.stringify(existing.evidence.map(({ messageId }) => messageId)) ===
        JSON.stringify(input.evidence.map(({ messageId }) => messageId));
  }

  #reportSummary(report: SafetyReportRecord): SafetyReportSummary {
    return {
      id: report.id,
      subjectAccountId: report.subjectUserId,
      category: report.category,
      evidenceCount: report.evidence.length,
      alsoBlocked: report.alsoBlocked,
      status: "submitted",
      submittedAt: report.createdAt
    };
  }

  #relationshipUnavailable() {
    return forbidden("Relationship is unavailable", { reason: "relationship_unavailable" });
  }
}
