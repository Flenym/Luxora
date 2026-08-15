import { createHash } from "node:crypto";
import {
  CHAT_DRAFT_IDEMPOTENCY_TTL_SECONDS,
  ChatDraftMutationResponseSchema,
  ChatDraftStateResponseSchema,
  MAX_CHAT_DRAFT_ACTIVE_COMMAND_RECEIPTS,
  type ChatDraft,
  type ChatDraftMutationResponse,
  type ChatDraftStateResponse,
  type DeleteChatDraftRequest,
  type PutChatDraftRequest
} from "@luxora/protocol";
import type { Store } from "../domain/store.js";
import type {
  ChatMemberRecord,
  ChatDraftCommandReceiptRecord,
  ChatDraftRecord,
  StoredEvent
} from "../domain/types.js";
import { badRequest, conflict, notFound, rateLimited } from "../errors.js";
import type { EventPublisher } from "./event-publisher.js";

const RECEIPT_PURGE_BATCH_SIZE = 512;

function timestampAfter(wallNow: string, floor: string): string {
  if (wallNow > floor) return wallNow;
  return new Date(Date.parse(floor) + 1).toISOString();
}

function laterTimestamp(left: string, right: string): string {
  return Date.parse(left) >= Date.parse(right) ? left : right;
}

function commandFingerprint(operation: "put" | "delete", payload: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify({ version: 1, operation, payload }))
    .digest("hex");
}

export class ChatDraftService {
  constructor(
    private readonly store: Store,
    private readonly publisher: EventPublisher
  ) {}

  get(userId: string, chatId: string): ChatDraftStateResponse {
    this.#requireAvailableChat(userId, chatId);
    return this.#state(this.store.getChatDraft(userId, chatId));
  }

  put(
    userId: string,
    chatId: string,
    input: PutChatDraftRequest
  ): ChatDraftMutationResponse {
    const fingerprint = commandFingerprint("put", {
      chatId,
      text: input.text,
      replyToMessageId: input.replyToMessageId,
      expectedRevision: input.expectedRevision
    });
    const result = this.store.immediateTransaction(() => {
      const membership = this.#requireAvailableChat(userId, chatId);
      const commandAt = new Date().toISOString();
      this.#prepareReceiptWindow(userId, input.clientNonce, commandAt);
      const replay = this.#replay(
        userId,
        input.clientNonce,
        "put",
        chatId,
        fingerprint,
        commandAt
      );
      if (replay !== null) return { response: replay, events: [] as StoredEvent[] };
      this.#requireReceiptCapacity(userId, commandAt);
      this.#requireReplyTarget(chatId, input.replyToMessageId);

      const current = this.store.getChatDraft(userId, chatId);
      const currentRevision = current?.revision ?? 0;
      if (currentRevision !== input.expectedRevision) {
        throw conflict("Chat draft revision changed; refresh and retry", { currentRevision });
      }

      if (
        current !== null &&
        current.deletedAt === null &&
        current.text === input.text &&
        current.replyToMessageId === input.replyToMessageId
      ) {
        const response = ChatDraftMutationResponseSchema.parse({
          ...this.#state(current),
          replayed: false
        });
        this.#storeReceipt(
          userId,
          input.clientNonce,
          "put",
          chatId,
          fingerprint,
          response,
          commandAt
        );
        return { response, events: [] as StoredEvent[] };
      }

      const changedAt = timestampAfter(
        commandAt,
        current === null
          ? membership.joinedAt
          : laterTimestamp(current.updatedAt, membership.joinedAt)
      );
      const draft = this.store.putChatDraft(userId, chatId, {
        text: input.text,
        replyToMessageId: input.replyToMessageId,
        expectedRevision: input.expectedRevision,
        updatedAt: changedAt
      });
      if (draft === null) throw conflict("Chat draft revision changed; refresh and retry");
      const response = ChatDraftMutationResponseSchema.parse({
        ...this.#state(draft),
        replayed: false
      });
      this.#storeReceipt(
        userId,
        input.clientNonce,
        "put",
        chatId,
        fingerprint,
        response,
        commandAt
      );
      return {
        response,
        events: [this.#appendEvent(userId, chatId, draft, changedAt)]
      };
    });
    this.publisher.publish(result.events);
    return result.response;
  }

  delete(
    userId: string,
    chatId: string,
    input: DeleteChatDraftRequest
  ): ChatDraftMutationResponse {
    const fingerprint = commandFingerprint("delete", {
      chatId,
      expectedRevision: input.expectedRevision
    });
    const result = this.store.immediateTransaction(() => {
      const membership = this.#requireAvailableChat(userId, chatId);
      const commandAt = new Date().toISOString();
      this.#prepareReceiptWindow(userId, input.clientNonce, commandAt);
      const replay = this.#replay(
        userId,
        input.clientNonce,
        "delete",
        chatId,
        fingerprint,
        commandAt
      );
      if (replay !== null) return { response: replay, events: [] as StoredEvent[] };
      this.#requireReceiptCapacity(userId, commandAt);

      const current = this.store.getChatDraft(userId, chatId);
      if (
        current === null ||
        current.deletedAt !== null ||
        current.revision !== input.expectedRevision
      ) {
        throw conflict("Chat draft revision changed; refresh and retry", {
          currentRevision: current?.revision ?? 0
        });
      }
      const changedAt = timestampAfter(
        commandAt,
        laterTimestamp(current.updatedAt, membership.joinedAt)
      );
      const tombstone = this.store.deleteChatDraft(
        userId,
        chatId,
        input.expectedRevision,
        changedAt
      );
      if (tombstone === null) throw conflict("Chat draft revision changed; refresh and retry");
      const response = ChatDraftMutationResponseSchema.parse({
        ...this.#state(tombstone),
        replayed: false
      });
      this.#storeReceipt(
        userId,
        input.clientNonce,
        "delete",
        chatId,
        fingerprint,
        response,
        commandAt
      );
      return {
        response,
        events: [this.#appendEvent(userId, chatId, tombstone, changedAt)]
      };
    });
    this.publisher.publish(result.events);
    return result.response;
  }

  #requireAvailableChat(userId: string, chatId: string): ChatMemberRecord {
    // Unknown and inaccessible chats deliberately share one response so this
    // account-private endpoint cannot be used as a chat existence oracle.
    const membership = this.store.getChatMember(chatId, userId);
    if (membership === null) {
      throw notFound("Chat not found");
    }
    return membership;
  }

  #requireReplyTarget(chatId: string, replyToMessageId: string | null): void {
    if (replyToMessageId === null) return;
    const target = this.store.findMessageRecord(replyToMessageId);
    if (target === null || target.chatId !== chatId || target.deletedAt !== null) {
      throw badRequest("Reply target is unavailable");
    }
  }

  #state(record: ChatDraftRecord | null): ChatDraftStateResponse {
    if (record === null) {
      return ChatDraftStateResponseSchema.parse({ draft: null, revision: 0 });
    }
    const draft = record.deletedAt === null ? this.#view(record) : null;
    return ChatDraftStateResponseSchema.parse({ draft, revision: record.revision });
  }

  #view(record: ChatDraftRecord): ChatDraft {
    if (record.deletedAt !== null || record.text === null) {
      throw new Error("A deleted chat draft has no active projection");
    }
    return {
      chatId: record.chatId,
      text: record.text,
      replyToMessageId: record.replyToMessageId,
      revision: record.revision,
      updatedAt: record.updatedAt
    };
  }

  #appendEvent(
    userId: string,
    chatId: string,
    record: ChatDraftRecord,
    changedAt: string
  ): StoredEvent {
    return this.store.appendEvent(userId, {
      type: "chat.draft.changed",
      audience: "account_sessions",
      accountId: userId,
      chatId,
      draft: record.deletedAt === null ? this.#view(record) : null,
      revision: record.revision,
      changedAt
    }, changedAt);
  }

  #replay(
    userId: string,
    clientNonce: string,
    operation: "put" | "delete",
    chatId: string,
    fingerprint: string,
    at: string
  ): ChatDraftMutationResponse | null {
    const receipt = this.store.findChatDraftCommandReceipt(userId, clientNonce, at);
    if (receipt === null) return null;
    if (
      receipt.operation !== operation ||
      receipt.chatId !== chatId ||
      receipt.fingerprint !== fingerprint
    ) {
      throw conflict("clientNonce has already been used for a different draft command");
    }
    const stored = ChatDraftMutationResponseSchema.parse(JSON.parse(receipt.responseJson) as unknown);
    return ChatDraftMutationResponseSchema.parse({ ...stored, replayed: true });
  }

  #requireReceiptCapacity(userId: string, at: string): void {
    if (
      this.store.countActiveChatDraftCommandReceipts(userId, at)
      < MAX_CHAT_DRAFT_ACTIVE_COMMAND_RECEIPTS
    ) return;

    const oldestExpiry = this.store.getOldestChatDraftCommandReceiptExpiry(userId, at);
    const retryAfterSeconds = oldestExpiry === null
      ? CHAT_DRAFT_IDEMPOTENCY_TTL_SECONDS
      : Math.max(1, Math.ceil((Date.parse(oldestExpiry) - Date.parse(at)) / 1_000));
    throw rateLimited(
      "Chat draft command window is full; retry after the oldest idempotency receipt expires",
      {
        retryAfterSeconds,
        idempotencyTtlSeconds: CHAT_DRAFT_IDEMPOTENCY_TTL_SECONDS,
        maxActiveReceipts: MAX_CHAT_DRAFT_ACTIVE_COMMAND_RECEIPTS
      }
    );
  }

  #prepareReceiptWindow(userId: string, clientNonce: string, at: string): void {
    this.store.deleteExpiredChatDraftCommandReceipt(userId, clientNonce, at);
    this.store.purgeExpiredChatDraftCommandReceipts(at, RECEIPT_PURGE_BATCH_SIZE);
  }

  #storeReceipt(
    userId: string,
    clientNonce: string,
    operation: "put" | "delete",
    chatId: string,
    fingerprint: string,
    response: ChatDraftMutationResponse,
    at: string
  ): void {
    const receipt: ChatDraftCommandReceiptRecord = {
      userId,
      clientNonce,
      operation,
      chatId,
      fingerprint,
      responseJson: JSON.stringify(response),
      createdAt: at,
      expiresAt: new Date(
        Date.parse(at) + CHAT_DRAFT_IDEMPOTENCY_TTL_SECONDS * 1_000
      ).toISOString()
    };
    this.store.createChatDraftCommandReceipt(receipt);
  }
}
