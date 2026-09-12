import { randomUUID } from "node:crypto";
import type {
  AddChatMemberRequest,
  Attachment,
  Chat,
  ChatMember,
  ChatMembership,
  ChatMembershipMutationResponse,
  ChatPreferences,
  CreateChatRequest,
  CreateTopicRequest,
  EditMessageRequest,
  ForwardMessageRequest,
  Message,
  MessagePin,
  MessageReceipt,
  MessageVersion,
  PatchChatPreferences,
  PutMessageTranscript,
  RealtimeEvent,
  RemoveChatMemberRequest,
  SendMessageRequest,
  Topic,
  UpdateChatMemberRoleRequest,
  UpdateTopicRequest
} from "@luxora/protocol";
import type { Store } from "../domain/store.js";
import type {
  ChatMemberRecord,
  ChatMembershipCommandReceiptRecord,
  ChatRecord,
  MessageRecord,
  StoredEvent,
  UserRecord
} from "../domain/types.js";
import { conflict, forbidden, notFound } from "../errors.js";
import type { SearchHasher } from "../infrastructure/search-hasher.js";
import type { EventPublisher } from "./event-publisher.js";

const MAX_PINS_PER_CHAT = 50;
const MAX_CHAT_MEMBERS = 200;

function directKey(leftUserId: string, rightUserId: string): string {
  return leftUserId === rightUserId
    ? `self:${leftUserId}`
    : [leftUserId, rightUserId].sort().join(":");
}

function timestampAfter(wallNow: string, floor: string): string {
  if (wallNow > floor) return wallNow;
  return new Date(new Date(floor).getTime() + 1).toISOString();
}

function sendRequestFingerprint(
  chatId: string,
  input: SendMessageRequest,
  attachmentIds: string[]
): string {
  return JSON.stringify({
    version: 1,
    operation: "send",
    chatId,
    body: input.body,
    replyToMessageId: input.replyToMessageId,
    topicId: input.topicId,
    attachmentIds,
    transcriptionConsent: input.transcriptionConsent
  });
}

function forwardRequestFingerprint(
  sourceMessageId: string,
  input: ForwardMessageRequest
): string {
  return JSON.stringify({
    version: 1,
    operation: "forward",
    sourceMessageId,
    chatId: input.chatId,
    topicId: input.topicId
  });
}

function membershipRequestFingerprint(
  operation: ChatMembershipCommandReceiptRecord["operation"],
  chatId: string,
  targetUserId: string,
  input: AddChatMemberRequest | UpdateChatMemberRoleRequest | RemoveChatMemberRequest
): string {
  return JSON.stringify({
    version: 1,
    operation,
    chatId,
    targetUserId,
    ...("role" in input ? { role: input.role } : {}),
    ...("expectedRevision" in input ? { expectedRevision: input.expectedRevision } : {})
  });
}

export class ChatService {
  constructor(
    private readonly store: Store,
    private readonly publisher: EventPublisher,
    private readonly search: SearchHasher
  ) {}

  createChat(actorUserId: string, input: CreateChatRequest): Chat {
    const now = new Date().toISOString();
    if (input.kind === "direct") {
      if (this.store.findUserById(input.userId) === null) throw notFound("User not found");
      if (
        input.userId !== actorUserId &&
        (
          this.store.isBlockedBetween(actorUserId, input.userId) ||
          (!this.store.hasAcceptedRelationship(actorUserId, input.userId) &&
            this.store.getPrivacySettings(input.userId).messageRequests === "nobody")
        )
      ) {
        throw this.#relationshipUnavailable();
      }
      const key = directKey(actorUserId, input.userId);
      const existing = this.store.findDirectChat(key);
      if (existing !== null) {
        const chat = this.store.getChatForUser(existing.id, actorUserId);
        if (chat === null) throw forbidden();
        return chat;
      }

      let result: { chat: Chat; events: StoredEvent[] };
      try {
        result = this.store.transaction(() => {
          if (
            input.userId !== actorUserId &&
            (
              this.store.isBlockedBetween(actorUserId, input.userId) ||
              (!this.store.hasAcceptedRelationship(actorUserId, input.userId) &&
                this.store.getPrivacySettings(input.userId).messageRequests === "nobody")
            )
          ) {
            throw this.#relationshipUnavailable();
          }
          const chatId = randomUUID();
          this.store.createChat({
            id: chatId,
            kind: "direct",
            title: null,
            directKey: key,
            createdBy: actorUserId,
            createdAt: now
          });
          this.store.addChatMember(chatId, actorUserId, "member", now);
          this.store.addChatMember(chatId, input.userId, "member", now);
          return this.#appendPersonalizedChatCreated(chatId, now, actorUserId);
        });
      } catch (error) {
        if (!(error instanceof Error) || !error.message.includes("chats.direct_key")) throw error;
        const concurrent = this.store.findDirectChat(key);
        const chat = concurrent === null ? null : this.store.getChatForUser(concurrent.id, actorUserId);
        if (chat === null) throw error;
        return chat;
      }
      this.publisher.publish(result.events);
      return result.chat;
    }

    const memberIds = [...new Set([actorUserId, ...input.memberIds])];
    for (const memberId of memberIds) {
      if (this.store.findUserById(memberId) === null) throw notFound(`User ${memberId} not found`);
    }
    for (const memberId of memberIds) {
      if (
        memberId !== actorUserId &&
        (
          this.store.isBlockedBetween(actorUserId, memberId) ||
          !this.store.hasAcceptedRelationship(actorUserId, memberId)
        )
      ) {
        throw this.#relationshipUnavailable();
      }
    }
    const result = this.store.transaction(() => {
      for (const memberId of memberIds) {
        if (
          memberId !== actorUserId &&
          (
            this.store.isBlockedBetween(actorUserId, memberId) ||
            !this.store.hasAcceptedRelationship(actorUserId, memberId)
          )
        ) {
          throw this.#relationshipUnavailable();
        }
      }
      const chatId = randomUUID();
      this.store.createChat({
        id: chatId,
        kind: input.kind,
        title: input.title,
        directKey: null,
        createdBy: actorUserId,
        createdAt: now
      });
      for (const memberId of memberIds) {
        this.store.addChatMember(chatId, memberId, memberId === actorUserId ? "owner" : "member", now);
      }
      return this.#appendPersonalizedChatCreated(chatId, now, actorUserId);
    });
    this.publisher.publish(result.events);
    return result.chat;
  }

  listChats(userId: string, limit: number, cursor?: string): { items: Chat[]; nextCursor: string | null } {
    return this.store.listChats(userId, limit, cursor);
  }

  listMessages(
    userId: string,
    chatId: string,
    limit: number,
    cursor?: string,
    topicId?: string
  ): { items: Message[]; nextCursor: string | null } {
    this.#requireMember(chatId, userId);
    if (topicId !== undefined) this.#requireTopic(chatId, topicId, true);
    return this.store.listMessages(chatId, limit, cursor, topicId);
  }

  getChat(userId: string, chatId: string): Chat {
    const chat = this.store.getChatForUser(chatId, userId);
    if (chat === null) throw notFound("Chat not found");
    return chat;
  }

  getPreferences(userId: string, chatId: string): ChatPreferences {
    this.#requireMember(chatId, userId);
    const preferences = this.store.getChatPreferences(chatId, userId);
    if (preferences === null) throw forbidden("You are not a member of this chat");
    return preferences;
  }

  updatePreferences(
    userId: string,
    chatId: string,
    input: PatchChatPreferences
  ): ChatPreferences {
    const changedAt = new Date().toISOString();
    const result = this.store.immediateTransaction(() => {
      this.#requireMember(chatId, userId);
      const previous = this.store.getChatPreferences(chatId, userId);
      if (previous === null) throw forbidden("You are not a member of this chat");
      const preferences = this.store.updateChatPreferences(chatId, userId, {
        changedAt,
        ...(input.archived === undefined ? {} : { archived: input.archived }),
        ...(input.mutedUntil === undefined ? {} : { mutedUntil: input.mutedUntil })
      });
      if (preferences === null) throw forbidden("You are not a member of this chat");
      const changed = previous.archivedAt !== preferences.archivedAt ||
        previous.mutedUntil !== preferences.mutedUntil;
      const events = changed
        ? [this.store.appendEvent(userId, {
            type: "chat.preferences.updated",
            audience: "member_account",
            accountId: userId,
            chatId,
            preferences,
            changedAt
          }, changedAt)]
        : [];
      return { preferences, events };
    });
    this.publisher.publish(result.events);
    return result.preferences;
  }

  listMembers(userId: string, chatId: string): { items: ChatMember[] } {
    this.#requireMember(chatId, userId);
    return { items: this.store.listChatMembers(chatId).map((member) => this.#memberView(member)) };
  }

  addMember(
    actorUserId: string,
    chatId: string,
    input: AddChatMemberRequest
  ): ChatMembershipMutationResponse {
    const fingerprint = membershipRequestFingerprint("add", chatId, input.userId, input);
    const result = this.store.immediateTransaction(() => {
      const replay = this.#membershipReplay(actorUserId, input.clientNonce, fingerprint);
      if (replay !== null) return { response: replay, events: [] as StoredEvent[] };

      const actor = this.#requireMember(chatId, actorUserId);
      const chat = this.store.findChatRecord(chatId);
      if (chat === null) throw notFound("Chat not found");
      if (chat.kind === "direct") throw conflict("Direct chat membership is immutable");
      if (!['owner', 'admin'].includes(actor.role)) {
        throw forbidden("Only chat administrators can add members");
      }
      if (input.role === "admin" && actor.role !== "owner") {
        throw forbidden("Only the chat owner can add administrators");
      }
      if (this.store.findUserById(input.userId) === null) throw notFound("User not found");
      if (this.store.getChatMember(chatId, input.userId) !== null) {
        throw conflict("User is already a member of this chat");
      }
      if (
        input.userId !== actorUserId &&
        (
          this.store.isBlockedBetween(actorUserId, input.userId) ||
          !this.store.hasAcceptedRelationship(actorUserId, input.userId)
        )
      ) {
        throw this.#relationshipUnavailable();
      }
      if (this.store.countChatMembers(chatId) >= MAX_CHAT_MEMBERS) {
        throw conflict(`A chat can contain at most ${MAX_CHAT_MEMBERS} members`);
      }

      const now = new Date().toISOString();
      const membership = this.store.createChatMember(chatId, input.userId, input.role, now);
      if (membership === null) throw conflict("User is already a member of this chat");
      const effectiveAt = membership.updatedAt;
      this.#storeMembershipReceipt({
        actorUserId,
        clientNonce: input.clientNonce,
        operation: "add",
        chatId,
        targetUserId: input.userId,
        fingerprint,
        membership,
        createdAt: effectiveAt
      });

      const events: StoredEvent[] = [];
      const addedChat = this.store.getChatForUser(chatId, input.userId);
      if (addedChat === null) throw new Error("Created membership is not visible to its account");
      events.push(this.store.appendEvent(
        input.userId,
        { type: "chat.created", chat: addedChat },
        effectiveAt
      ));
      events.push(...this.#appendMembershipChanged(
        chatId,
        "added",
        membership,
        actorUserId,
        effectiveAt
      ));
      return { response: { membership: this.#membershipView(membership), replayed: false }, events };
    });
    this.publisher.publish(result.events);
    return result.response;
  }

  updateMemberRole(
    actorUserId: string,
    chatId: string,
    targetUserId: string,
    input: UpdateChatMemberRoleRequest
  ): ChatMembershipMutationResponse {
    const fingerprint = membershipRequestFingerprint("role_update", chatId, targetUserId, input);
    const result = this.store.immediateTransaction(() => {
      const replay = this.#membershipReplay(actorUserId, input.clientNonce, fingerprint);
      if (replay !== null) return { response: replay, events: [] as StoredEvent[] };

      const actor = this.#requireMember(chatId, actorUserId);
      const chat = this.store.findChatRecord(chatId);
      if (chat === null) throw notFound("Chat not found");
      if (chat.kind === "direct") throw conflict("Direct chat membership is immutable");
      if (actor.role !== "owner") throw forbidden("Only the chat owner can change member roles");
      const target = this.store.getChatMember(chatId, targetUserId);
      if (target === null) throw notFound("Chat member not found");
      if (target.role === "owner") {
        throw conflict("Ownership transfer requires a dedicated ceremony");
      }
      if (target.revision !== input.expectedRevision) {
        throw conflict("Chat membership revision is stale", { currentRevision: target.revision });
      }
      if (target.role === input.role) throw conflict("Chat member already has this role");

      const now = timestampAfter(new Date().toISOString(), target.updatedAt);
      const membership = this.store.updateChatMemberRole(
        chatId,
        targetUserId,
        input.role,
        input.expectedRevision,
        now
      );
      if (membership === null) throw conflict("Chat membership revision is stale");
      this.#storeMembershipReceipt({
        actorUserId,
        clientNonce: input.clientNonce,
        operation: "role_update",
        chatId,
        targetUserId,
        fingerprint,
        membership,
        createdAt: now
      });
      const events = this.#appendMembershipChanged(
        chatId,
        "role_updated",
        membership,
        actorUserId,
        now
      );
      return { response: { membership: this.#membershipView(membership), replayed: false }, events };
    });
    this.publisher.publish(result.events);
    return result.response;
  }

  removeMember(
    actorUserId: string,
    chatId: string,
    targetUserId: string,
    input: RemoveChatMemberRequest
  ): ChatMembershipMutationResponse {
    const fingerprint = membershipRequestFingerprint("remove", chatId, targetUserId, input);
    const result = this.store.immediateTransaction(() => {
      const replay = this.#membershipReplay(actorUserId, input.clientNonce, fingerprint);
      if (replay !== null) return { response: replay, events: [] as StoredEvent[] };

      const actor = this.#requireMember(chatId, actorUserId);
      const chat = this.store.findChatRecord(chatId);
      if (chat === null) throw notFound("Chat not found");
      if (chat.kind === "direct") throw conflict("Direct chat membership is immutable");
      const target = this.store.getChatMember(chatId, targetUserId);
      if (target === null) throw notFound("Chat member not found");
      if (target.role === "owner") {
        throw conflict("The chat owner cannot leave before ownership is transferred");
      }
      const removingSelf = actorUserId === targetUserId;
      const canRemove = removingSelf ||
        actor.role === "owner" ||
        (actor.role === "admin" && target.role === "member");
      if (!canRemove) throw forbidden("You cannot remove this chat member");
      if (target.revision !== input.expectedRevision) {
        throw conflict("Chat membership revision is stale", { currentRevision: target.revision });
      }

      const now = timestampAfter(new Date().toISOString(), target.updatedAt);
      const affectedFolders = this.store.listChatFolders(targetUserId)
        .filter((folder) => folder.overrides.some((override) => override.chatId === chatId));
      const folderChangedAt = affectedFolders.reduce(
        (candidate, folder) => timestampAfter(candidate, folder.updatedAt),
        now
      );
      const draftBeforeRemoval = this.store.getChatDraft(targetUserId, chatId);
      const membership = this.store.removeChatMember(
        chatId,
        targetUserId,
        input.expectedRevision,
        now
      );
      if (membership === null) throw conflict("Chat membership revision is stale");
      this.#storeMembershipReceipt({
        actorUserId,
        clientNonce: input.clientNonce,
        operation: "remove",
        chatId,
        targetUserId,
        fingerprint,
        membership,
        createdAt: now
      });
      const events = this.#appendMembershipChanged(
        chatId,
        "removed",
        membership,
        actorUserId,
        now,
        targetUserId
      );
      if (draftBeforeRemoval?.deletedAt === null) {
        const draftTombstone = this.store.getChatDraft(targetUserId, chatId);
        if (draftTombstone === null || draftTombstone.deletedAt === null) {
          throw new Error("Could not tombstone chat draft after membership removal");
        }
        events.push(this.store.appendEvent(targetUserId, {
          type: "chat.draft.changed",
          audience: "account_sessions",
          accountId: targetUserId,
          chatId,
          draft: null,
          revision: draftTombstone.revision,
          changedAt: draftTombstone.updatedAt
        }, draftTombstone.updatedAt));
      }
      if (affectedFolders.length > 0) {
        for (const folder of affectedFolders) {
          const updated = this.store.updateChatFolder(targetUserId, folder.id, {
            title: folder.title,
            rules: folder.rules,
            overrides: folder.overrides.filter((override) => override.chatId !== chatId),
            expectedRevision: folder.revision,
            updatedAt: folderChangedAt
          });
          if (updated === null) {
            throw new Error("Could not reconcile chat folder after membership removal");
          }
        }
        const stateRevision = this.store.advanceChatFolderStateRevision(targetUserId, folderChangedAt);
        events.push(this.store.appendEvent(targetUserId, {
          type: "chat.folders.updated",
          audience: "actor_account",
          accountId: targetUserId,
          stateRevision,
          changedAt: folderChangedAt
        }, folderChangedAt));
      }
      return { response: { membership: this.#membershipView(membership), replayed: false }, events };
    });
    this.publisher.publish(result.events);
    return result.response;
  }

  sendMessage(userId: string, chatId: string, input: SendMessageRequest): Message {
    const member = this.#requireMember(chatId, userId);
    const chat = this.store.findChatRecord(chatId);
    if (chat === null) throw notFound("Chat not found");
    this.#requireActiveDirectRelationship(chat, userId);
    this.#requirePostingPermission(chat, member);
    const attachmentIds = [...new Set(input.attachmentIds)];
    if (attachmentIds.length !== input.attachmentIds.length) {
      throw conflict("The same attachment cannot be added to a message more than once");
    }
    const requestFingerprint = sendRequestFingerprint(chatId, input, attachmentIds);

    const result = this.store.immediateTransaction(() => {
      const currentMember = this.#requireMember(chatId, userId);
      const currentChat = this.store.findChatRecord(chatId);
      if (currentChat === null) throw notFound("Chat not found");
      this.#requireActiveDirectRelationship(currentChat, userId);
      this.#requirePostingPermission(currentChat, currentMember);
      const duplicate = this.store.findMessageByNonce(userId, input.clientNonce);
      if (duplicate !== null) {
        if (!this.#matchesMessageRequestFingerprint(duplicate, requestFingerprint)) {
          throw conflict("clientNonce was already used for a different message");
        }
        return { message: this.store.getMessage(duplicate.id) as Message, events: [] as StoredEvent[] };
      }
      this.#requireTopic(chatId, input.topicId, false);
      const attachments = this.#requireOwnedAttachments(userId, attachmentIds);
      if (input.replyToMessageId !== null) {
        const replied = this.store.findMessageRecord(input.replyToMessageId);
        if (replied === null || replied.chatId !== chatId || replied.deletedAt !== null) {
          throw notFound("Reply target not found in this chat");
        }
      }
      const effectiveAt = timestampAfter(new Date().toISOString(), currentChat.updatedAt);
      const record = this.store.createMessage({
        id: randomUUID(),
        chatId,
        senderId: userId,
        body: input.body,
        replyToMessageId: input.replyToMessageId,
        topicId: input.topicId,
        forwardedFromMessageId: null,
        forwardedFromChatId: null,
        forwardedFromSenderId: null,
        forwardedFromSenderName: null,
        forwardedFromCreatedAt: null,
        forwardSourceMessageId: null,
        requestFingerprint,
        clientNonce: input.clientNonce,
        createdAt: effectiveAt,
        transcriptionConsent: input.transcriptionConsent === true
      });
      for (const [ordinal, attachment] of attachments.entries()) {
        this.store.addMessageAttachment(record.id, attachment.id, ordinal, effectiveAt);
      }
      this.store.replaceMessageSearchTokens(record.id, input.body === null ? [] : this.search.index(input.body));
      const message = this.store.getMessage(record.id) as Message;
      const events = this.store.appendChatEvent(chatId, { type: "message.created", message }, effectiveAt);
      return { message, events };
    });
    this.publisher.publish(result.events);
    return result.message;
  }

  attachTranscript(userId: string, messageId: string, input: PutMessageTranscript): Message {
    const original = this.#requireVisibleMessage(messageId, userId, "Message not found");
    if (original.deletedAt !== null) throw notFound("Message not found");
    const now = new Date().toISOString();
    const outcome = this.store.attachMessageTranscript({
      messageId,
      authorUserId: userId,
      text: input.text,
      clientNonce: input.clientNonce,
      createdAt: now
    });
    if (outcome === null) {
      throw forbidden("This message cannot carry a transcript", { reason: "transcript_unavailable" });
    }
    if (outcome.status === "nonce_conflict") {
      throw conflict("clientNonce was already used for a different transcript");
    }
    const message = this.store.getMessage(outcome.message.id) as Message;
    const events = this.store.appendChatEvent(original.chatId, { type: "message.updated", message }, now);
    this.publisher.publish(events);
    return message;
  }

  editMessage(userId: string, messageId: string, input: EditMessageRequest): Message {
    const original = this.#requireVisibleMessage(messageId, userId, "Message not found");
    const chat = this.store.findChatRecord(original.chatId);
    if (chat === null) throw notFound("Chat not found");
    this.#requireActiveDirectRelationship(chat, userId);
    if (original.senderId !== userId) throw forbidden("Only the author can edit this message");
    if (original.deletedAt !== null) throw conflict("Deleted messages cannot be edited");
    if (input.body === null && this.store.listMessageAttachmentIds(messageId).length === 0) {
      throw conflict("A text-only message cannot have an empty body");
    }
    if (input.expectedRevision !== undefined && input.expectedRevision !== original.revision) {
      throw conflict("Message was changed by another client");
    }
    const result = this.store.immediateTransaction(() => {
      const current = this.#requireVisibleMessage(messageId, userId, "Message not found");
      const currentChat = this.store.findChatRecord(current.chatId);
      if (currentChat === null) throw notFound("Chat not found");
      this.#requireActiveDirectRelationship(currentChat, userId);
      if (current.senderId !== userId) throw forbidden("Only the author can edit this message");
      if (input.expectedRevision !== undefined && input.expectedRevision !== current.revision) {
        throw conflict("Message was changed by another client");
      }
      if (current.deletedAt !== null) throw conflict("Deleted messages cannot be edited");
      if (input.body === null && this.store.listMessageAttachmentIds(messageId).length === 0) {
        throw conflict("A text-only message cannot have an empty body");
      }
      if (input.body === current.body) {
        return { message: this.store.getMessage(messageId) as Message, events: [] as StoredEvent[] };
      }
      const effectiveAt = timestampAfter(new Date().toISOString(), current.updatedAt);
      this.store.addMessageVersion(messageId, current.revision, current.body, userId, effectiveAt);
      const updated = this.store.updateMessage(messageId, input.body, current.revision, effectiveAt);
      if (updated === null) throw conflict("Message was changed by another client");
      this.store.replaceMessageSearchTokens(messageId, input.body === null ? [] : this.search.index(input.body));
      const message = this.store.getMessage(updated.id) as Message;
      const events = this.store.appendChatEvent(current.chatId, { type: "message.updated", message }, effectiveAt);
      return { message, events };
    });
    this.publisher.publish(result.events);
    return result.message;
  }

  deleteMessage(userId: string, messageId: string): Message {
    const original = this.#requireVisibleMessage(messageId, userId, "Message not found");
    const member = this.store.getChatMember(original.chatId, userId) as ChatMemberRecord;
    if (original.senderId !== userId && !["owner", "admin"].includes(member.role)) {
      throw forbidden("Only the author or a chat administrator can delete this message");
    }
    const result = this.store.immediateTransaction(() => {
      const current = this.#requireVisibleMessage(messageId, userId, "Message not found");
      const currentMember = this.store.getChatMember(current.chatId, userId) as ChatMemberRecord;
      if (current.senderId !== userId && !["owner", "admin"].includes(currentMember.role)) {
        throw forbidden("Only the author or a chat administrator can delete this message");
      }
      if (current.deletedAt !== null) {
        return { message: this.store.getMessage(messageId) as Message, events: [] as StoredEvent[] };
      }
      const effectiveAt = timestampAfter(new Date().toISOString(), current.updatedAt);
      this.store.removePendingMessageContentEvents(messageId);
      this.store.deleteMessageVersions(messageId);
      this.store.replaceMessageSearchTokens(messageId, []);
      this.store.unpinMessage(current.chatId, messageId);
      this.store.deleteMessage(messageId, effectiveAt);
      const message = this.store.getMessage(messageId) as Message;
      const events = this.store.appendChatEvent(current.chatId, { type: "message.deleted", message }, effectiveAt);
      return { message, events };
    });
    this.publisher.publish(result.events);
    return result.message;
  }

  getMessageHistory(userId: string, messageId: string): MessageVersion[] {
    const message = this.#requireVisibleMessage(messageId, userId, "Message not found");
    if (message.deletedAt !== null) throw notFound("Message not found");
    return this.store.listMessageVersions(messageId);
  }

  forwardMessage(userId: string, sourceMessageId: string, input: ForwardMessageRequest): Message {
    this.#requireVisibleMessage(sourceMessageId, userId, "Source message not found");
    const targetMember = this.#requireMember(input.chatId, userId);
    const targetChat = this.store.findChatRecord(input.chatId);
    if (targetChat === null) throw notFound("Target chat not found");
    this.#requireActiveDirectRelationship(targetChat, userId);
    this.#requirePostingPermission(targetChat, targetMember);
    const requestFingerprint = forwardRequestFingerprint(sourceMessageId, input);

    const result = this.store.immediateTransaction(() => {
      const currentSource = this.#requireVisibleMessage(sourceMessageId, userId, "Source message not found");
      const currentTargetMember = this.#requireMember(input.chatId, userId);
      const currentTargetChat = this.store.findChatRecord(input.chatId);
      if (currentTargetChat === null) throw notFound("Target chat not found");
      this.#requireActiveDirectRelationship(currentTargetChat, userId);
      this.#requirePostingPermission(currentTargetChat, currentTargetMember);

      const duplicate = this.store.findMessageByNonce(userId, input.clientNonce);
      if (duplicate !== null) {
        if (!this.#matchesForwardRequestFingerprint(
          duplicate,
          currentSource,
          input,
          requestFingerprint
        )) {
          throw conflict("clientNonce was already used for a different message");
        }
        return { message: this.store.getMessage(duplicate.id) as Message, events: [] as StoredEvent[] };
      }
      this.#requireTopic(input.chatId, input.topicId, false);
      if (currentSource.deletedAt !== null) throw notFound("Source message not found");

      const currentSourceSender = this.store.findUserById(currentSource.senderId);
      if (currentSourceSender === null) throw notFound("Source message sender not found");
      const rootMessageId = currentSource.forwardedFromMessageId ?? currentSource.id;
      const rootChatId = currentSource.forwardedFromChatId ?? currentSource.chatId;
      const rootSenderId = currentSource.forwardedFromSenderId ?? currentSource.senderId;
      const rootSenderName = currentSource.forwardedFromSenderName ?? currentSourceSender.displayName;
      const rootCreatedAt = currentSource.forwardedFromCreatedAt ?? currentSource.createdAt;
      const currentAttachmentIds = this.store.listMessageAttachmentIds(currentSource.id);
      if (currentAttachmentIds.some((attachmentId) =>
        !this.store.canUserAccessAttachment(userId, attachmentId)
      )) {
        throw notFound("Source message not found");
      }
      const effectiveAt = timestampAfter(new Date().toISOString(), currentTargetChat.updatedAt);
      const record = this.store.createMessage({
        id: randomUUID(),
        chatId: input.chatId,
        senderId: userId,
        body: currentSource.body,
        replyToMessageId: null,
        topicId: input.topicId,
        forwardedFromMessageId: rootMessageId,
        forwardedFromChatId: rootChatId,
        forwardedFromSenderId: rootSenderId,
        forwardedFromSenderName: rootSenderName,
        forwardedFromCreatedAt: rootCreatedAt,
        forwardSourceMessageId: sourceMessageId,
        requestFingerprint,
        clientNonce: input.clientNonce,
        createdAt: effectiveAt,
        // Transcription consent is sender-scoped: forwards start without it.
        transcriptionConsent: false
      });
      for (const [ordinal, attachmentId] of currentAttachmentIds.entries()) {
        this.store.addMessageAttachment(record.id, attachmentId, ordinal, effectiveAt);
      }
      this.store.replaceMessageSearchTokens(
        record.id,
        currentSource.body === null ? [] : this.search.index(currentSource.body)
      );
      const message = this.store.getMessage(record.id) as Message;
      const events = this.store.appendChatEvent(
        input.chatId,
        { type: "message.created", message },
        effectiveAt
      );
      return { message, events };
    });
    this.publisher.publish(result.events);
    return result.message;
  }

  listPins(userId: string, chatId: string): MessagePin[] {
    this.#requireMember(chatId, userId);
    return this.store.listPins(chatId);
  }

  pinMessage(userId: string, chatId: string, messageId: string): MessagePin {
    const member = this.#requireMember(chatId, userId);
    const chat = this.store.findChatRecord(chatId);
    if (chat === null) throw notFound("Chat not found");
    this.#requireActiveDirectRelationship(chat, userId);
    this.#requireModerationPermission(chat, member);
    const message = this.store.findMessageRecord(messageId);
    if (message === null || message.chatId !== chatId || message.deletedAt !== null) {
      throw notFound("Message not found in this chat");
    }
    const existing = this.store.listPins(chatId).find((pin) => pin.messageId === messageId);
    if (existing !== undefined) return existing;
    if (this.store.listPins(chatId).length >= MAX_PINS_PER_CHAT) {
      throw conflict(`A chat cannot have more than ${MAX_PINS_PER_CHAT} pinned messages`);
    }
    const now = new Date().toISOString();
    const result = this.store.transaction(() => {
      const pin = this.store.pinMessage(chatId, messageId, userId, now);
      const events = this.store.appendChatEvent(chatId, { type: "message.pinned", pin }, now);
      return { pin, events };
    });
    this.publisher.publish(result.events);
    return result.pin;
  }

  unpinMessage(userId: string, chatId: string, messageId: string): boolean {
    const member = this.#requireMember(chatId, userId);
    const chat = this.store.findChatRecord(chatId);
    if (chat === null) throw notFound("Chat not found");
    this.#requireActiveDirectRelationship(chat, userId);
    this.#requireModerationPermission(chat, member);
    const message = this.store.findMessageRecord(messageId);
    if (message === null || message.chatId !== chatId || message.deletedAt !== null) {
      throw notFound("Message not found in this chat");
    }
    const now = new Date().toISOString();
    const result = this.store.transaction(() => {
      const removed = this.store.unpinMessage(chatId, messageId);
      const events = removed
        ? this.store.appendChatEvent(chatId, { type: "message.unpinned", chatId, messageId }, now)
        : [];
      return { removed, events };
    });
    this.publisher.publish(result.events);
    return result.removed;
  }

  listTopics(userId: string, chatId: string): Topic[] {
    this.#requireMember(chatId, userId);
    return this.store.listTopics(chatId);
  }

  createTopic(userId: string, chatId: string, input: CreateTopicRequest): Topic {
    const member = this.#requireMember(chatId, userId);
    const chat = this.store.findChatRecord(chatId);
    if (chat === null) throw notFound("Chat not found");
    if (chat.kind === "direct") throw conflict("Direct chats do not support topics");
    if (chat.kind === "channel") this.#requireModerationPermission(chat, member);
    const now = new Date().toISOString();
    const result = this.store.transaction(() => {
      const record = this.store.createTopic(randomUUID(), chatId, input.title, userId, now);
      const topic = this.store.getTopic(record.id) as Topic;
      const events = this.store.appendChatEvent(chatId, { type: "topic.created", topic }, now);
      return { topic, events };
    });
    this.publisher.publish(result.events);
    return result.topic;
  }

  updateTopic(userId: string, topicId: string, input: UpdateTopicRequest): Topic {
    const existing = this.store.findTopicRecord(topicId);
    if (existing === null) throw notFound("Topic not found");
    const member = this.store.getChatMember(existing.chatId, userId);
    if (member === null) throw notFound("Topic not found");
    const chat = this.store.findChatRecord(existing.chatId);
    if (chat === null) throw notFound("Chat not found");
    this.#requireModerationPermission(chat, member);
    const now = new Date().toISOString();
    const result = this.store.transaction(() => {
      this.store.updateTopic(topicId, input.title, input.closed, now);
      const topic = this.store.getTopic(topicId) as Topic;
      const events = this.store.appendChatEvent(existing.chatId, { type: "topic.updated", topic }, now);
      return { topic, events };
    });
    this.publisher.publish(result.events);
    return result.topic;
  }

  listMessageReactions(
    userId: string,
    messageId: string
  ): Array<{ emoji: string; count: number; reactedByMe: boolean }> {
    const message = this.store.findMessageRecord(messageId);
    if (
      message === null ||
      this.store.getChatMember(message.chatId, userId) === null
    ) throw notFound("Message not found");
    if (message.deletedAt !== null) return [];
    return this.store.getReactionSummary(messageId, userId);
  }

  listMessageReceipts(userId: string, messageId: string): MessageReceipt[] {
    const message = this.store.findMessageRecord(messageId);
    if (
      message === null ||
      this.store.getChatMember(message.chatId, userId) === null
    ) throw notFound("Message not found");
    if (message.deletedAt !== null) return [];
    const currentMembers = new Set(this.store.listChatMemberIds(message.chatId));
    return this.store.listMessageReceipts(messageId).filter((receipt) =>
      currentMembers.has(receipt.userId) &&
      (
        receipt.userId === userId ||
        !this.store.isBlockedBetween(userId, receipt.userId)
      )
    );
  }

  markRead(userId: string, chatId: string, messageId: string): StoredEvent[] {
    this.#requireMember(chatId, userId);
    const chat = this.store.findChatRecord(chatId);
    if (chat === null) throw notFound("Chat not found");
    this.#requireActiveDirectRelationship(chat, userId);
    const message = this.store.findMessageRecord(messageId);
    if (message === null || message.chatId !== chatId) throw notFound("Message not found in this chat");
    const events = this.store.immediateTransaction(() => {
      this.#requireMember(chatId, userId);
      const currentChat = this.store.findChatRecord(chatId);
      if (currentChat === null) throw notFound("Chat not found");
      this.#requireActiveDirectRelationship(currentChat, userId);
      const currentMessage = this.store.findMessageRecord(messageId);
      if (currentMessage === null || currentMessage.chatId !== chatId) {
        throw notFound("Message not found in this chat");
      }
      const receipt = this.store.markRead(chatId, userId, messageId, new Date().toISOString());
      if (!receipt.advanced) return [];
      return this.#appendActorVisibleChatEvent(chatId, {
        type: "receipt.read",
        chatId,
        userId,
        messageId,
        readAt: receipt.readAt
      }, receipt.readAt, userId);
    });
    this.publisher.publish(events);
    return events;
  }

  markDelivered(userId: string, chatId: string, messageId: string): StoredEvent[] {
    this.#requireMember(chatId, userId);
    const chat = this.store.findChatRecord(chatId);
    if (chat === null) throw notFound("Chat not found");
    this.#requireActiveDirectRelationship(chat, userId);
    const message = this.store.findMessageRecord(messageId);
    if (message === null || message.chatId !== chatId) throw notFound("Message not found in this chat");
    const events = this.store.immediateTransaction(() => {
      this.#requireMember(chatId, userId);
      const currentChat = this.store.findChatRecord(chatId);
      if (currentChat === null) throw notFound("Chat not found");
      this.#requireActiveDirectRelationship(currentChat, userId);
      const currentMessage = this.store.findMessageRecord(messageId);
      if (currentMessage === null || currentMessage.chatId !== chatId) {
        throw notFound("Message not found in this chat");
      }
      const receipt = this.store.markDelivered(messageId, userId, new Date().toISOString());
      if (receipt === null) return [];
      return this.#appendActorVisibleChatEvent(chatId, {
        type: "receipt.delivered",
        chatId,
        userId,
        messageId,
        deliveredAt: receipt.deliveredAt
      }, receipt.deliveredAt, userId);
    });
    this.publisher.publish(events);
    return events;
  }

  setReaction(userId: string, messageId: string, emoji: string, active: boolean): Array<{ emoji: string; count: number; reactedByMe: boolean }> {
    const message = this.#requireVisibleMessage(messageId, userId, "Message not found");
    const chat = this.store.findChatRecord(message.chatId);
    if (chat === null) throw notFound("Chat not found");
    this.#requireActiveDirectRelationship(chat, userId);
    if (message.deletedAt !== null) throw conflict("Deleted messages cannot be reacted to");
    const result = this.store.immediateTransaction(() => {
      const current = this.#requireVisibleMessage(messageId, userId, "Message not found");
      const currentChat = this.store.findChatRecord(current.chatId);
      if (currentChat === null) throw notFound("Chat not found");
      this.#requireActiveDirectRelationship(currentChat, userId);
      if (current.deletedAt !== null) throw conflict("Deleted messages cannot be reacted to");
      const now = new Date().toISOString();
      this.store.setReaction(messageId, userId, emoji, active, now);
      const reactions = this.store.getReactionSummary(messageId, userId);
      return {
        reactions,
        events: this.store.listChatMemberIds(current.chatId)
          .filter((audienceUserId) =>
            audienceUserId === userId || !this.store.isBlockedBetween(userId, audienceUserId)
          )
          .map((audienceUserId) => this.store.appendEvent(audienceUserId, {
            type: "reaction.updated",
            chatId: current.chatId,
            messageId,
            reactions: this.store.getReactionSummary(messageId, audienceUserId),
            actorUserId: userId
          }, now))
      };
    });
    this.publisher.publish(result.events);
    return result.reactions;
  }

  #requireMember(chatId: string, userId: string) {
    const member = this.store.getChatMember(chatId, userId);
    if (member === null) throw forbidden("You are not a member of this chat");
    return member;
  }

  #membershipView(record: ChatMemberRecord): ChatMembership {
    return {
      chatId: record.chatId,
      userId: record.userId,
      role: record.role,
      revision: record.revision,
      joinedAt: record.joinedAt,
      updatedAt: record.updatedAt
    };
  }

  #memberView(record: ChatMemberRecord): ChatMember {
    const user = this.store.findUserById(record.userId);
    if (user === null) throw new Error("Chat membership references a missing user");
    return { membership: this.#membershipView(record), user: this.#userView(user) };
  }

  #userView(user: UserRecord): ChatMember["user"] {
    return {
      id: user.id,
      username: user.username,
      displayName: user.displayName,
      bio: user.bio,
      avatarUrl: user.avatarUrl,
      avatarPath: user.avatarPath ?? null,
      createdAt: user.createdAt
    };
  }

  #membershipReplay(
    actorUserId: string,
    clientNonce: string,
    fingerprint: string
  ): ChatMembershipMutationResponse | null {
    const receipt = this.store.findChatMembershipCommandReceipt(actorUserId, clientNonce);
    if (receipt === null) return null;
    if (receipt.fingerprint !== fingerprint) {
      throw conflict("clientNonce has already been used for a different membership command");
    }
    return { membership: this.#membershipView(receipt.membership), replayed: true };
  }

  #storeMembershipReceipt(receipt: ChatMembershipCommandReceiptRecord): void {
    this.store.createChatMembershipCommandReceipt(receipt);
  }

  #appendMembershipChanged(
    chatId: string,
    change: "added" | "role_updated" | "removed",
    membership: ChatMemberRecord,
    actorUserId: string,
    changedAt: string,
    removedUserId?: string
  ): StoredEvent[] {
    const memberEvent = {
      type: "chat.member.changed" as const,
      audience: "member_account" as const,
      change,
      membership: this.#membershipView(membership),
      actorUserId,
      changedAt
    };
    const events = this.store.listChatMemberIds(chatId)
      .map((audienceUserId) => this.store.appendEvent(audienceUserId, memberEvent, changedAt));
    if (removedUserId !== undefined) {
      events.push(this.store.appendEvent(removedUserId, {
        ...memberEvent,
        audience: "removed_account"
      }, changedAt));
    }
    return events;
  }

  #requireVisibleMessage(messageId: string, userId: string, message = "Message not found"): MessageRecord {
    const record = this.store.findMessageRecord(messageId);
    if (record === null || this.store.getChatMember(record.chatId, userId) === null) {
      throw notFound(message);
    }
    return record;
  }

  #matchesMessageRequestFingerprint(message: MessageRecord, requestFingerprint: string): boolean {
    // Mutable body/history/tombstone state cannot reconstruct a pre-008 send
    // command safely. An absent immutable fingerprint therefore fails closed.
    return message.requestFingerprint !== null && message.requestFingerprint === requestFingerprint;
  }

  #matchesForwardRequestFingerprint(
    message: MessageRecord,
    source: MessageRecord,
    input: ForwardMessageRequest,
    requestFingerprint: string
  ): boolean {
    if (message.requestFingerprint !== null) {
      return message.requestFingerprint === requestFingerprint;
    }
    if (
      message.chatId !== input.chatId ||
      message.replyToMessageId !== null ||
      message.topicId !== input.topicId
    ) return false;
    if (message.forwardSourceMessageId !== null) {
      return message.forwardSourceMessageId === source.id;
    }
    // A pre-007 forwarded row cannot distinguish multiple source instances that
    // share one root. Fail closed instead of converging an ambiguous retry.
    return false;
  }

  #requireOwnedAttachments(userId: string, ids: string[]): Attachment[] {
    if (ids.length === 0) return [];
    const records = this.store.listAttachmentsByIds(ids);
    if (records.length !== ids.length) throw notFound("One or more attachments are not ready");
    const byId = new Map(records.map((record) => [record.id, record]));
    return ids.map((id) => {
      const record = byId.get(id);
      if (record === undefined) throw notFound("Attachment not found");
      if (record.ownerUserId !== userId) {
        throw forbidden("Only the attachment owner can add it to a new message; forward the source message instead");
      }
      return this.store.getAttachment(id) as Attachment;
    });
  }

  #requireTopic(chatId: string, topicId: string | null, allowClosed: boolean): void {
    if (topicId === null) return;
    const topic = this.store.findTopicRecord(topicId);
    if (topic === null || topic.chatId !== chatId) throw notFound("Topic not found in this chat");
    if (!allowClosed && topic.closedAt !== null) throw conflict("Topic is closed");
  }

  #requirePostingPermission(chat: ChatRecord, member: ChatMemberRecord): void {
    if (chat.kind === "channel" && !["owner", "admin"].includes(member.role)) {
      throw forbidden("Only channel administrators can publish messages");
    }
  }

  #requireModerationPermission(chat: ChatRecord, member: ChatMemberRecord): void {
    if (chat.kind !== "direct" && !["owner", "admin"].includes(member.role)) {
      throw forbidden("Only chat administrators can manage this resource");
    }
  }

  #requireActiveDirectRelationship(chat: ChatRecord, actorUserId: string): void {
    if (chat.kind !== "direct") return;
    if (chat.directKey === directKey(actorUserId, actorUserId)) return;

    const peerUserIds = this.store.listChatMemberIds(chat.id).filter((memberId) => memberId !== actorUserId);
    const peerUserId = peerUserIds[0];
    if (
      peerUserIds.length !== 1 ||
      peerUserId === undefined ||
      this.store.isBlockedBetween(actorUserId, peerUserId) ||
      (!this.store.hasAcceptedRelationship(actorUserId, peerUserId) &&
        this.store.getPrivacySettings(peerUserId).messageRequests === "nobody")
    ) {
      throw this.#relationshipUnavailable();
    }
  }

  #appendActorVisibleChatEvent(
    chatId: string,
    event: RealtimeEvent,
    at: string,
    actorUserId: string
  ): StoredEvent[] {
    return this.store.listChatMemberIds(chatId)
      .filter((audienceUserId) =>
        audienceUserId === actorUserId || !this.store.isBlockedBetween(actorUserId, audienceUserId)
      )
      .map((audienceUserId) => this.store.appendEvent(audienceUserId, event, at));
  }

  #relationshipUnavailable() {
    return forbidden("Relationship is unavailable", { reason: "relationship_unavailable" });
  }

  #appendPersonalizedChatCreated(chatId: string, at: string, actorUserId: string): { chat: Chat; events: StoredEvent[] } {
    const events: StoredEvent[] = [];
    for (const memberId of this.store.listChatMemberIds(chatId)) {
      const memberChat = this.store.getChatForUser(chatId, memberId) as Chat;
      events.push(this.store.appendEvent(memberId, { type: "chat.created", chat: memberChat }, at));
    }
    return { chat: this.store.getChatForUser(chatId, actorUserId) as Chat, events };
  }
}
