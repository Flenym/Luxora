import type { SyncInvalidationReason } from "@luxora/protocol";
import type { Store } from "../domain/store.js";
import type { StoredEvent } from "../domain/types.js";

export function appendSyncInvalidations(
  store: Store,
  accountIds: Iterable<string>,
  reason: SyncInvalidationReason,
  changedAt: string,
  enabled = true
): StoredEvent[] {
  if (!enabled) return [];
  return [...new Set(accountIds)].map((accountId) => store.appendEvent(accountId, {
    type: "sync.invalidated",
    audience: "account_projection",
    accountId,
    reason,
    changedAt
  }, changedAt));
}
