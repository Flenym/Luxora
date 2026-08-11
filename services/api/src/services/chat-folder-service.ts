import { createHash, randomUUID } from "node:crypto";
import {
  ChatFolderDeleteResponseSchema,
  ChatFolderListResponseSchema,
  ChatFolderMutationResponseSchema,
  ChatFolderReorderResponseSchema,
  CHAT_FOLDER_IDEMPOTENCY_TTL_SECONDS,
  MAX_CHAT_FOLDER_ACTIVE_COMMAND_RECEIPTS,
  MAX_CHAT_FOLDERS,
  type ChatFolder,
  type ChatFolderDeleteResponse,
  type ChatFolderListResponse,
  type ChatFolderMutationResponse,
  type ChatFolderOverride,
  type ChatFolderReorderResponse,
  type ChatFolderRules,
  type CreateChatFolderRequest,
  type DeleteChatFolderRequest,
  type PatchChatFolderRequest,
  type ReorderChatFoldersRequest
} from "@luxora/protocol";
import type { Store } from "../domain/store.js";
import type {
  ChatFolderCommandReceiptRecord,
  ChatFolderRecord,
  StoredEvent
} from "../domain/types.js";
import { badRequest, conflict, notFound, rateLimited } from "../errors.js";
import type { EventPublisher } from "./event-publisher.js";

const CHAT_KIND_ORDER = ["direct", "group", "channel"] as const;
const RECEIPT_PURGE_BATCH_SIZE = 256;

function timestampAfter(wallNow: string, floor: string): string {
  if (wallNow > floor) return wallNow;
  return new Date(new Date(floor).getTime() + 1).toISOString();
}

function timestampAfterFolders(wallNow: string, folders: ChatFolderRecord[]): string {
  return folders.reduce(
    (candidate, folder) => timestampAfter(candidate, folder.updatedAt),
    wallNow
  );
}

function commandFingerprint(operation: string, payload: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify({ version: 1, operation, payload }))
    .digest("hex");
}

function normalizedRules(rules: ChatFolderRules): ChatFolderRules {
  return {
    includeKinds: CHAT_KIND_ORDER.filter((kind) => rules.includeKinds.includes(kind)),
    unreadOnly: rules.unreadOnly,
    excludeMuted: rules.excludeMuted,
    includeArchived: rules.includeArchived
  };
}

function normalizedOverrides(overrides: ChatFolderOverride[]): ChatFolderOverride[] {
  return [...overrides].sort((left, right) => {
    if (left.pinnedPosition !== null && right.pinnedPosition === null) return -1;
    if (left.pinnedPosition === null && right.pinnedPosition !== null) return 1;
    if (left.pinnedPosition !== null && right.pinnedPosition !== null) {
      const positionDifference = left.pinnedPosition - right.pinnedPosition;
      if (positionDifference !== 0) return positionDifference;
    }
    if (left.chatId === right.chatId) return 0;
    return left.chatId < right.chatId ? -1 : 1;
  });
}

function sameFolderContents(left: ChatFolderRecord, right: {
  title: string;
  rules: ChatFolderRules;
  overrides: ChatFolderOverride[];
}): boolean {
  return JSON.stringify({
    title: left.title,
    rules: normalizedRules(left.rules),
    overrides: normalizedOverrides(left.overrides)
  }) === JSON.stringify({
    title: right.title,
    rules: normalizedRules(right.rules),
    overrides: normalizedOverrides(right.overrides)
  });
}

export class ChatFolderService {
  constructor(
    private readonly store: Store,
    private readonly publisher: EventPublisher
  ) {}

  list(userId: string): ChatFolderListResponse {
    const snapshot = this.store.getChatFolderSnapshot(userId);
    return ChatFolderListResponseSchema.parse({
      items: snapshot.items.map((folder) => this.#view(folder)),
      stateRevision: snapshot.stateRevision
    });
  }

  create(userId: string, input: CreateChatFolderRequest): ChatFolderMutationResponse {
    const fingerprint = commandFingerprint("create", {
      title: input.title,
      rules: normalizedRules(input.rules),
      overrides: normalizedOverrides(input.overrides)
    });
    const result = this.store.immediateTransaction(() => {
      const commandAt = new Date().toISOString();
      this.#prepareReceiptWindow(userId, input.clientNonce, commandAt);
      const replay = this.#replay(
        userId,
        input.clientNonce,
        "create",
        fingerprint,
        commandAt,
        (value) => ChatFolderMutationResponseSchema.parse(value)
      );
      if (replay !== null) return { response: replay, events: [] as StoredEvent[] };
      this.#requireReceiptCapacity(userId, commandAt);
      if (this.store.countChatFolders(userId) >= MAX_CHAT_FOLDERS) {
        throw conflict(`An account can contain at most ${MAX_CHAT_FOLDERS} custom chat folders`);
      }

      this.#requireAvailableOverrides(userId, input.overrides);
      const now = commandAt;
      const existing = this.store.listChatFolders(userId);
      const folder = this.store.createChatFolder({
        id: randomUUID(),
        userId,
        title: input.title,
        position: existing.length,
        revision: 1,
        rules: normalizedRules(input.rules),
        overrides: normalizedOverrides(input.overrides),
        createdAt: now,
        updatedAt: now
      });
      const stateRevision = this.store.advanceChatFolderStateRevision(userId, now);
      const response = ChatFolderMutationResponseSchema.parse({
        folder: this.#view(folder),
        stateRevision,
        replayed: false
      });
      this.#storeReceipt(userId, input.clientNonce, "create", fingerprint, response, now);
      const event = this.store.appendEvent(userId, {
        type: "chat.folders.updated",
        audience: "actor_account",
        accountId: userId,
        stateRevision,
        changedAt: now
      }, now);
      return { response, events: [event] };
    });
    this.publisher.publish(result.events);
    return result.response;
  }

  patch(
    userId: string,
    folderId: string,
    input: PatchChatFolderRequest
  ): ChatFolderMutationResponse {
    const fingerprint = commandFingerprint("update", {
      folderId,
      expectedRevision: input.expectedRevision,
      ...(input.title === undefined ? {} : { title: input.title }),
      ...(input.rules === undefined ? {} : { rules: normalizedRules(input.rules) }),
      ...(input.overrides === undefined ? {} : { overrides: normalizedOverrides(input.overrides) })
    });
    const result = this.store.immediateTransaction(() => {
      const commandAt = new Date().toISOString();
      this.#prepareReceiptWindow(userId, input.clientNonce, commandAt);
      const replay = this.#replay(
        userId,
        input.clientNonce,
        "update",
        fingerprint,
        commandAt,
        (value) => ChatFolderMutationResponseSchema.parse(value)
      );
      if (replay !== null) return { response: replay, events: [] as StoredEvent[] };
      this.#requireReceiptCapacity(userId, commandAt);

      const current = this.store.findChatFolder(userId, folderId);
      if (current === null) throw notFound("Chat folder not found");
      if (current.revision !== input.expectedRevision) {
        throw conflict("Chat folder revision changed; refresh and retry");
      }
      const next = {
        title: input.title ?? current.title,
        rules: normalizedRules(input.rules ?? current.rules),
        overrides: normalizedOverrides(input.overrides ?? current.overrides)
      };
      this.#requireAvailableOverrides(userId, next.overrides);
      const now = commandAt;
      if (sameFolderContents(current, next)) {
        const response = ChatFolderMutationResponseSchema.parse({
          folder: this.#view(current),
          stateRevision: this.store.getChatFolderStateRevision(userId),
          replayed: false
        });
        this.#storeReceipt(userId, input.clientNonce, "update", fingerprint, response, now);
        return { response, events: [] as StoredEvent[] };
      }

      const changedAt = timestampAfter(now, current.updatedAt);
      const folder = this.store.updateChatFolder(userId, folderId, {
        ...next,
        expectedRevision: input.expectedRevision,
        updatedAt: changedAt
      });
      if (folder === null) throw conflict("Chat folder revision changed; refresh and retry");
      const stateRevision = this.store.advanceChatFolderStateRevision(userId, changedAt);
      const response = ChatFolderMutationResponseSchema.parse({
        folder: this.#view(folder),
        stateRevision,
        replayed: false
      });
      this.#storeReceipt(userId, input.clientNonce, "update", fingerprint, response, commandAt);
      const event = this.#appendUpdatedEvent(userId, stateRevision, changedAt);
      return { response, events: [event] };
    });
    this.publisher.publish(result.events);
    return result.response;
  }

  delete(
    userId: string,
    folderId: string,
    input: DeleteChatFolderRequest
  ): ChatFolderDeleteResponse {
    const fingerprint = commandFingerprint("delete", {
      folderId,
      expectedRevision: input.expectedRevision
    });
    const result = this.store.immediateTransaction(() => {
      const commandAt = new Date().toISOString();
      this.#prepareReceiptWindow(userId, input.clientNonce, commandAt);
      const replay = this.#replay(
        userId,
        input.clientNonce,
        "delete",
        fingerprint,
        commandAt,
        (value) => ChatFolderDeleteResponseSchema.parse(value)
      );
      if (replay !== null) return { response: replay, events: [] as StoredEvent[] };
      this.#requireReceiptCapacity(userId, commandAt);

      const current = this.store.findChatFolder(userId, folderId);
      if (current === null) throw notFound("Chat folder not found");
      if (current.revision !== input.expectedRevision) {
        throw conflict("Chat folder revision changed; refresh and retry");
      }
      const allFolders = this.store.listChatFolders(userId);
      const now = timestampAfterFolders(commandAt, allFolders);
      if (!this.store.deleteChatFolder(userId, folderId, input.expectedRevision)) {
        throw conflict("Chat folder revision changed; refresh and retry");
      }
      const remainingIds = this.store.listChatFolders(userId).map((folder) => folder.id);
      if (remainingIds.length > 0) this.store.reorderChatFolders(userId, remainingIds, now);
      const stateRevision = this.store.advanceChatFolderStateRevision(userId, now);
      const response = ChatFolderDeleteResponseSchema.parse({
        folderId,
        stateRevision,
        replayed: false
      });
      this.#storeReceipt(userId, input.clientNonce, "delete", fingerprint, response, commandAt);
      const event = this.#appendUpdatedEvent(userId, stateRevision, now);
      return { response, events: [event] };
    });
    this.publisher.publish(result.events);
    return result.response;
  }

  reorder(userId: string, input: ReorderChatFoldersRequest): ChatFolderReorderResponse {
    const fingerprint = commandFingerprint("reorder", {
      folderIds: input.folderIds,
      expectedStateRevision: input.expectedStateRevision
    });
    const result = this.store.immediateTransaction(() => {
      const commandAt = new Date().toISOString();
      this.#prepareReceiptWindow(userId, input.clientNonce, commandAt);
      const replay = this.#replay(
        userId,
        input.clientNonce,
        "reorder",
        fingerprint,
        commandAt,
        (value) => ChatFolderReorderResponseSchema.parse(value)
      );
      if (replay !== null) return { response: replay, events: [] as StoredEvent[] };
      this.#requireReceiptCapacity(userId, commandAt);

      const current = this.store.listChatFolders(userId);
      const currentStateRevision = this.store.getChatFolderStateRevision(userId);
      if (currentStateRevision !== input.expectedStateRevision) {
        throw conflict("Chat folder state changed; refresh and retry");
      }
      const currentIds = current.map((folder) => folder.id);
      const requestedSet = new Set(input.folderIds);
      if (
        input.folderIds.length !== currentIds.length ||
        currentIds.some((folderId) => !requestedSet.has(folderId))
      ) {
        throw conflict("Chat folders changed; refresh and retry");
      }
      const now = timestampAfterFolders(commandAt, current);
      const changed = currentIds.some((folderId, index) => folderId !== input.folderIds[index]);
      const items = changed
        ? this.store.reorderChatFolders(userId, input.folderIds, now)
        : current;
      const stateRevision = changed
        ? this.store.advanceChatFolderStateRevision(userId, now)
        : currentStateRevision;
      const response = ChatFolderReorderResponseSchema.parse({
        items: items.map((folder) => this.#view(folder)),
        stateRevision,
        replayed: false
      });
      this.#storeReceipt(userId, input.clientNonce, "reorder", fingerprint, response, commandAt);
      const events = changed
        ? [this.#appendUpdatedEvent(userId, stateRevision, now)]
        : [];
      return { response, events };
    });
    this.publisher.publish(result.events);
    return result.response;
  }

  #requireAvailableOverrides(userId: string, overrides: ChatFolderOverride[]): void {
    for (const override of overrides) {
      if (this.store.getChatMember(override.chatId, userId) === null) {
        throw badRequest("Chat folder contains an unavailable chat");
      }
    }
  }

  #appendUpdatedEvent(userId: string, stateRevision: number, at: string): StoredEvent {
    return this.store.appendEvent(userId, {
      type: "chat.folders.updated",
      audience: "actor_account",
      accountId: userId,
      stateRevision,
      changedAt: at
    }, at);
  }

  #requireReceiptCapacity(userId: string, at: string): void {
    if (
      this.store.countActiveChatFolderCommandReceipts(userId, at)
      >= MAX_CHAT_FOLDER_ACTIVE_COMMAND_RECEIPTS
    ) {
      const oldestExpiry = this.store.getOldestChatFolderCommandReceiptExpiry(userId, at);
      const retryAfterSeconds = oldestExpiry === null
        ? CHAT_FOLDER_IDEMPOTENCY_TTL_SECONDS
        : Math.max(1, Math.ceil((Date.parse(oldestExpiry) - Date.parse(at)) / 1_000));
      throw rateLimited(
        "Chat folder command window is full; retry after the oldest idempotency receipt expires",
        {
          retryAfterSeconds,
          idempotencyTtlSeconds: CHAT_FOLDER_IDEMPOTENCY_TTL_SECONDS,
          maxActiveReceipts: MAX_CHAT_FOLDER_ACTIVE_COMMAND_RECEIPTS
        }
      );
    }
  }

  #prepareReceiptWindow(userId: string, clientNonce: string, at: string): void {
    this.store.deleteExpiredChatFolderCommandReceipt(userId, clientNonce, at);
    this.store.purgeExpiredChatFolderCommandReceipts(at, RECEIPT_PURGE_BATCH_SIZE);
  }

  #view(folder: ChatFolderRecord): ChatFolder {
    return {
      id: folder.id,
      title: folder.title,
      position: folder.position,
      revision: folder.revision,
      rules: normalizedRules(folder.rules),
      overrides: normalizedOverrides(folder.overrides),
      createdAt: folder.createdAt,
      updatedAt: folder.updatedAt
    };
  }

  #replay<T extends { replayed: boolean }>(
    userId: string,
    clientNonce: string,
    operation: ChatFolderCommandReceiptRecord["operation"],
    fingerprint: string,
    at: string,
    parse: (value: unknown) => T
  ): T | null {
    const receipt = this.store.findChatFolderCommandReceipt(userId, clientNonce, at);
    if (receipt === null) return null;
    if (receipt.operation !== operation || receipt.fingerprint !== fingerprint) {
      throw conflict("clientNonce has already been used for a different chat folder command");
    }
    const response = parse(JSON.parse(receipt.responseJson) as unknown);
    return parse({ ...response, replayed: true });
  }

  #storeReceipt(
    userId: string,
    clientNonce: string,
    operation: ChatFolderCommandReceiptRecord["operation"],
    fingerprint: string,
    response: ChatFolderMutationResponse | ChatFolderDeleteResponse | ChatFolderReorderResponse,
    at: string
  ): void {
    this.store.createChatFolderCommandReceipt({
      userId,
      clientNonce,
      operation,
      fingerprint,
      responseJson: JSON.stringify(response),
      createdAt: at,
      expiresAt: new Date(
        Date.parse(at) + CHAT_FOLDER_IDEMPOTENCY_TTL_SECONDS * 1_000
      ).toISOString()
    });
  }
}
