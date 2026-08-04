export const TYPING_THROTTLE_MS = 800;
export const TYPING_TTL_MS = 5_000;
export const MAX_TRACKED_TYPING_CHATS = 8;

function evictOldest(entries: Map<string, number>): void {
  let oldestChatId: string | undefined;
  let oldestTimestamp = Number.POSITIVE_INFINITY;
  for (const [chatId, timestamp] of entries) {
    if (
      timestamp < oldestTimestamp ||
      (timestamp === oldestTimestamp && (oldestChatId === undefined || chatId < oldestChatId))
    ) {
      oldestChatId = chatId;
      oldestTimestamp = timestamp;
    }
  }
  if (oldestChatId !== undefined) entries.delete(oldestChatId);
}

export function compactTypingThrottleEntries(entries: Map<string, number>, now: number): void {
  for (const [chatId, timestamp] of entries) {
    if (timestamp > now || now - timestamp >= TYPING_TTL_MS) entries.delete(chatId);
  }
  while (entries.size > MAX_TRACKED_TYPING_CHATS) evictOldest(entries);
}

export function shouldPublishTyping(
  entries: Map<string, number>,
  chatId: string,
  now: number
): boolean {
  compactTypingThrottleEntries(entries, now);
  const previous = entries.get(chatId);
  if (previous !== undefined && now - previous < TYPING_THROTTLE_MS) return false;
  if (previous === undefined && entries.size >= MAX_TRACKED_TYPING_CHATS) evictOldest(entries);
  entries.set(chatId, now);
  return true;
}
