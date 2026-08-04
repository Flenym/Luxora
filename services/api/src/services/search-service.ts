import type { Attachment, Message } from "@luxora/protocol";
import type { Store } from "../domain/store.js";
import { serviceUnavailable } from "../errors.js";
import type { SearchHasher } from "../infrastructure/search-hasher.js";

export class SearchService {
  constructor(
    private readonly store: Store,
    private readonly hasher: SearchHasher
  ) {}

  messages(userId: string, query: string, limit: number, cursor?: string, chatId?: string): {
    items: Message[];
    nextCursor: string | null;
  } {
    if (!this.hasher.available) {
      throw serviceUnavailable("Server-side search requires the configured data-encryption keyring");
    }
    const tokenized = this.hasher.query(query);
    return this.store.searchMessages(
      userId,
      tokenized.hashes,
      tokenized.termCount,
      limit,
      cursor,
      chatId
    );
  }

  attachments(userId: string, query: string, limit: number, cursor?: string): {
    items: Attachment[];
    nextCursor: string | null;
  } {
    if (!this.hasher.available) {
      throw serviceUnavailable("Server-side search requires the configured data-encryption keyring");
    }
    const tokenized = this.hasher.query(query);
    return this.store.searchAttachments(userId, tokenized.hashes, tokenized.termCount, limit, cursor);
  }
}
