# Synchronized chat drafts — Beta-0.1 server contract

## Scope

The server stores one private draft state for each `(account, chat)` pair. This
slice is negotiated by `GET /v1/capabilities` through `features.drafts=true`
and `limits.maxDraftCodePoints=10000`. The same response advertises the
24-hour idempotency TTL and 2,048-receipt per-account ceiling. Older capability
responses omit the feature and therefore parse as `drafts=false`.

This is a cloud-preview contract: draft text is readable by the server and is
encrypted at rest with the configured content key. It is not E2EE.

## HTTP

All routes require an active bearer session and current chat membership:

- `GET /v1/chats/{chatId}/draft`
- `PUT /v1/chats/{chatId}/draft`
- `DELETE /v1/chats/{chatId}/draft`

Unknown chats and chats unavailable to the caller return the same `404 Chat
not found` response. Drafts are account-private: another member of the same
chat sees its own independent `{draft:null, revision:0}` state.

`PUT` accepts exact draft text, an optional same-chat non-deleted reply target,
`expectedRevision`, and a UUID `clientNonce`. Text is bounded by Unicode code
points and must be well-formed Unicode; either lone UTF-16 surrogate is rejected
before any row, receipt, or event is written. Empty text is valid only when a
reply target is present. `DELETE` accepts a positive `expectedRevision` and UUID
`clientNonce`.

## Conflict and retry rules

- A pair with no state starts at revision `0`; its first `PUT` commits revision
  `1`.
- Every changed `PUT` and successful `DELETE` advances revision exactly once.
- Delete retains a content-free tombstone, so a later recreation continues the
  same revision sequence and a stale device cannot exploit an ABA reset.
- A semantic no-op stores its retry receipt but emits no event and does not
  advance revision.
- A reused nonce with the identical normalized command returns the exact prior
  response with `replayed=true` and emits no second event during the 24-hour
  idempotency window. After expiry it is evaluated against current CAS state as
  a new command.
- Reusing a nonce for any different operation, chat, content, reply target, or
  expected revision returns `409`.
- Competing writers with the same expected revision are serialized by an
  immediate SQLite transaction; exactly one changed command can commit.

Each account may retain at most 2,048 active draft command receipts. Exact
replays are checked before this capacity limit. A new nonce above the limit
returns `429` with the oldest-window retry time in both the `Retry-After`
header and `error.details.retryAfterSeconds`. Expired receipts are purged in
bounded batches during later draft mutations; hard account/chat deletion may
also cascade them. Active receipts cannot be deleted directly. Receipt response
and fingerprint fields are independently authenticated-encrypted at rest, so a
database snapshot does not expose a deterministic digest of low-entropy text.

Reply IDs that are unknown, deleted, or belong to another chat share one
`400 Reply target is unavailable` response at mutation time. The database keeps
the already-validated UUID as an opaque historical link rather than a physical
message foreign key. A later soft or hard message retention action therefore
cannot break draft CAS or erase draft text; clients must treat a target that is
no longer resolvable as unavailable.

## Realtime and privacy

Every changed state appends `chat.draft.changed` and its transactional outbox
row in the same database transaction. The event carries an explicit
`account_sessions` audience and is stored only for the owning account. Live and
replay authorization recheck the exact account. Active-draft delivery also
requires current membership and an exact match with the latest active database
projection (revision, timestamp, text, and reply target), so a delayed event
from an older membership lifecycle cannot republish private text. All active V2
device sessions for that account receive the latest authorized event. V1 skips
it because the event is not part of the V1 union.

Membership removal erases draft text and reply metadata, advances the draft
revision, deletes that account/chat's active retry receipts, and removes its
historical draft event/outbox ciphertext in the same immediate transaction as
the membership deletion. The service then emits only a new content-free draft
tombstone and the content-free membership removal event to the removed account.
The actor and remaining members never receive the private text. Removal replay
remains authorized after a later re-add so an offline device observes the
lifecycle boundary. Historical account-scoped tombstones may still replay and
transiently clear a local composer before the latest active projection; clients
must apply the subsequent higher-sequence state and retain CAS revisions.

The durable publisher claims only the earliest pending row for each account.
A retryable or leased head blocks later rows for that account while unrelated
accounts continue; a poison head releases its successors only after durable
dead-lettering. One drain invocation processes at most ten successively exposed
heads per account. Remaining ready rows are handled by the next timer or
post-commit drain, which bounds work without weakening per-account order.

## Reconciliation compatibility boundary

The existing iPhone client requires exact equality with the current twelve
reconciliation collections. Adding `drafts` to that list without a coordinated
client and contract-version migration would make cursor recovery fail closed.
For this checkpoint, draft sync is therefore negotiated through capabilities,
per-chat HTTP and the additive V2 event; `/v2/sync/snapshot` remains unchanged.

A later coordinated server+iPhone change must add an account draft collection,
version its reconciliation contract, update the strict client decoder, and add
forced-gap/process-death evidence before claiming authoritative draft recovery.
