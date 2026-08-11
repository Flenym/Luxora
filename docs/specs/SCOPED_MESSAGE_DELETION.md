# Luxora Scoped Message Deletion Contract

**Canonical public release:** Beta-0.1

**Owner and developer:** Flenym

**Status:** PROPOSED / NOT IMPLEMENTED

This document is a design target. None of the proposed endpoint, capability,
tables, columns, receipt limits, personalized visibility rules or realtime
semantics described below exist merely because this file exists. They must not
be advertised or treated as available until the implementation and every gate
in this document pass.

## 1. Decision and boundary

The next bounded conversation-domain slice is scoped message deletion:

- `for_me` hides one message from every current and future device session of
  the authenticated account, without changing another account's view;
- `for_everyone` replaces one message with a global tombstone for every current
  participant who can see the chat.

Both operations are account-authenticated server commands. Neither is a
physical account-erasure or legal-retention API. Selected safety-report
evidence may outlive a message tombstone under the separately documented
report-retention boundary. Account export/delete and full retention propagation
remain separate work.

The current repository already has replies through `replyToMessageId`, a global
message tombstone path, message edit history, forwards, pins, topics, global
notification settings and archive/mute preferences. It does not yet have the
scoped contract defined here. This proposal extends the existing message model
instead of adding a new message type or reconciliation collection.

The slice intentionally excludes:

- batch chat-history deletion and clear-history commands;
- time-limited auto-delete, disappearing messages and Secret Chat semantics;
- account deletion, retention-policy administration and legal holds;
- moderator reasons, appeals and a complete moderation audit product;
- restoration or undo of `for_me` deletions;
- physical deletion of independently forwarded copies;
- any E2EE claim.

## 2. Proposed capability and constants

Only after the server implementation, compatibility fixtures and iPhone
consumer pass should capability schema v1 add these additive response fields:

```json
{
  "features": {
    "scopedMessageDeletion": true
  },
  "limits": {
    "messageDeletionIdempotencyTtlSeconds": 86400,
    "maxActiveMessageDeletionCommandReceipts": 64
  }
}
```

The proposed protocol constants are:

```text
MESSAGE_DELETION_IDEMPOTENCY_TTL_SECONDS = 86_400
MAX_ACTIVE_MESSAGE_DELETION_COMMAND_RECEIPTS = 64
```

Unknown capability response fields remain additive and ignorable. A server
must not advertise `scopedMessageDeletion=true` while the canonical endpoint,
storage, realtime projection or reconciliation filtering is unavailable.

## 3. Proposed HTTP contract

### 3.1 Canonical command

```http
POST /v1/messages/{messageId}/deletions
Authorization: Bearer <access token>
Content-Type: application/json
```

`messageId` and `clientNonce` use the existing canonical UUID `IdSchema`. Input
objects are strict and reject unknown fields.

`for_me` deliberately has no message revision precondition: the user's intent
is to remove the stable message identity from their account view regardless of
an edit that raced on another device.

```json
{
  "scope": "for_me",
  "clientNonce": "00000000-0000-4000-8000-000000000001"
}
```

`for_everyone` is destructive to other accounts and therefore requires an
optimistic concurrency precondition.

```json
{
  "scope": "for_everyone",
  "expectedRevision": 3,
  "clientNonce": "00000000-0000-4000-8000-000000000002"
}
```

`expectedRevision` is a non-negative safe integer. The two request variants are
a strict discriminated union; `expectedRevision` is rejected for `for_me` and
required for `for_everyone`.

### 3.2 Response

A successful command returns `200` and `Cache-Control: private, no-store`:

```json
{
  "scope": "for_me",
  "message": {
    "id": "00000000-0000-4000-8000-000000000010",
    "chatId": "00000000-0000-4000-8000-000000000020",
    "sender": {},
    "kind": "text",
    "body": null,
    "replyToMessageId": null,
    "topicId": null,
    "forwardedFrom": null,
    "attachments": [],
    "isPinned": false,
    "clientNonce": "00000000-0000-4000-8000-000000000030",
    "revision": 4,
    "createdAt": "2026-08-11T10:00:00.000Z",
    "updatedAt": "2026-08-11T10:05:00.000Z",
    "editedAt": null,
    "deletedAt": "2026-08-11T10:05:00.000Z"
  },
  "replayed": false
}
```

The abbreviated `sender` above stands for the existing strict `UserSchema`; it
is not a proposed empty object. The complete response schema is:

```text
MessageDeletionResponse {
  scope: "for_me" | "for_everyone"
  message: MessageSchema constrained to a tombstone
  replayed: boolean
}
```

The tombstone constraints are `body=null`, `replyToMessageId=null`,
`forwardedFrom=null`, `attachments=[]`, `isPinned=false` and non-null
`deletedAt`. A `for_me` tombstone is an account-specific projection and does
not imply that the authoritative global message row is deleted. Its projection
revision is the observed message revision plus one, and its `updatedAt` and
`deletedAt` equal the committed account-hide time. A `for_everyone` tombstone
uses the committed global message revision and deletion time.

### 3.3 Errors

| Status | Proposed meaning |
| --- | --- |
| `400` | malformed UUID, invalid scope/revision or unknown input field |
| `401` | missing, invalid, expired or revoked session |
| `403` | current member exists but lacks `for_everyone` authority |
| `404` | message/chat is absent or the actor is not a current chat member |
| `409` | stale global revision or active nonce reused for another command |
| `429` | mutation rate limit or active idempotency-receipt capacity reached |
| `503` | writer reservation cannot be obtained without an ambiguous commit |

The server never silently downgrades `for_everyone` to `for_me`. Errors must not
contain message content, sender profile, foreign membership, receipt state or a
distinguishing existence oracle for non-members.

## 4. Migration 025 target

The proposed forward-only migration ID is:

```text
025_scoped_message_deletion
```

It follows applied migrations `001` through `024`; migrations `022` through
`024` must remain byte-for-byte unchanged.

### 4.1 Account visibility rows

`message_account_deletions` contains no message content:

| Column | Constraint |
| --- | --- |
| `user_id` | non-null FK `users(id) ON DELETE CASCADE` |
| `message_id` | non-null FK `messages(id) ON DELETE CASCADE` |
| `chat_id` | non-null FK `chats(id) ON DELETE CASCADE` |
| `hidden_at` | non-null canonical timestamp, valid `julianday` |
| `projection_revision` | positive safe integer |

The primary key is `(user_id, message_id)`. An additional covering index is
`idx_message_account_deletions_chat(user_id, chat_id, message_id)`.

An insert trigger rejects a row unless the referenced message belongs to
`chat_id` and `(chat_id, user_id)` is a current membership. A separate trigger
rejects updates: a committed account deletion is immutable. Ordinary deletion
of these rows is permitted only through account/message/chat cascades. Removing
a membership does not remove the account deletion; if the account later rejoins
the same chat, the message must remain hidden.

### 4.2 Command receipts

`message_deletion_command_receipts` has:

| Column | Constraint |
| --- | --- |
| `user_id`, `client_nonce` | composite primary key; account-bound command identity |
| `message_id`, `chat_id` | non-null owned command target FKs |
| `scope` | `for_me` or `for_everyone` |
| `fingerprint` | exactly 64 lowercase hexadecimal SHA-256 characters |
| `response_ciphertext` | active Luxora content-envelope ciphertext |
| `created_at`, `expires_at` | valid timestamps with `expires_at > created_at` |

Required indexes are:

```text
idx_message_deletion_receipts_expiry(expires_at, user_id, client_nonce)
idx_message_deletion_receipts_account(user_id, expires_at, client_nonce)
```

Receipt identity/content is immutable. Expired rows remain deletable by the
bounded sweeper. Fresh inserts must always carry an expiry; no new unbounded
legacy receipt form is allowed.

### 4.3 Global deletion attribution

Migration 025 proposes two nullable internal columns on `messages`:

```text
deleted_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL
deletion_authority TEXT CHECK (
  deletion_authority IS NULL OR deletion_authority IN ('author', 'administrator')
)
```

New code writes both columns when it performs `for_everyone`. They are not part
of public `MessageSchema`. Existing tombstones remain valid with both columns
null. Migration 025 intentionally does not add a cross-column trigger that
would reject the previous binary's existing tombstone update: the extra schema
must remain rollback-compatible for one deployment window. Requiring
attribution at the database layer is a later migration only after the previous
writer has been retired.

### 4.4 Migration invariants

The migration must pass on both a fresh database and a database already applied
through `023`, including one containing legacy global tombstones. It must not
rewrite message content or synthesize account-deletion rows. All new tables are
`STRICT`; foreign keys remain enabled; migration application is atomic and
append-only.

## 5. Authorization semantics

Authorization is checked before mutation and repeated inside the immediate
SQLite writer transaction.

### `for_me`

- any current chat member may hide a visible or global-tombstone message;
- an active direct relationship is not required, so blocking cannot prevent a
  user from removing already known content from their own account view;
- the command changes no other account, membership, receipt or message row.

### `for_everyone`

- in Direct and Saved chats, only the original sender may delete globally;
- in Group and Channel chats, the original sender may delete their own message;
- Group/Channel owners and administrators may globally delete another member's
  message;
- a Member may never globally delete another sender's message;
- there is no silent role inference or fallback scope;
- Beta-0.1 proposes no time window, but `expectedRevision` is mandatory.

A receipt replay still requires an active session and current chat membership.
If membership was removed after the successful command, retry returns the same
member-safe `404` rather than exposing a historical receipt. A role downgrade
does not invalidate an exact receipt for a command that already committed while
the actor remains a member; replay performs no new destructive action.

## 6. Account-specific visibility

Every content-reading path must apply the account-deletion anti-join in SQL
before pagination or aggregation. Filtering an already limited page is invalid
because it creates short pages, unstable cursors and existence leaks.

| Surface | Required `for_me` behavior |
| --- | --- |
| chat message pages | omit the message before cursor limit |
| topic message pages | apply the same account anti-join |
| chat preview | choose the newest message not hidden for this account |
| unread count | exclude hidden messages |
| chat folders | inherit the corrected per-account unread/preview projection |
| message search | omit hidden messages before grouping/limit |
| file search | omit a link reachable only through hidden messages |
| pins | omit pins whose message is hidden for the viewer |
| edit/history/forward/reaction/receipt | return the normal viewer-safe not-found shape |
| reply validation | a hidden target is unavailable to that actor |
| attachment download | require ownership or another currently visible grant |

An attachment owner retains access to their own upload inventory even after
hiding a message. An attachment also remains accessible when another visible
message or an authorized avatar grants access. Local hiding never unlinks or
deletes content required by other accounts.

A visible message may retain `replyToMessageId` pointing at a target hidden for
the viewer. The client must render an unavailable/deleted reply target without
trying to recover its content through another endpoint.

`chats.updated_at` and activity pagination remain global in this bounded slice
to preserve existing cursor stability. `lastMessage` becomes viewer-specific;
the UI uses the returned visible message timestamp for preview copy. A future
account-specific inbox-order aggregate is separate work.

## 7. Global tombstone and content scrub

`for_everyone` preserves the stable message ID, chat/topic placement, sender,
creation time, revision and tombstone time needed for ordering and referential
integrity. In the same transaction it must:

1. set body, reply and forward provenance/display ciphertext to null;
2. clear the immutable send-request content fingerprint so an old send nonce
   fails closed instead of recreating or comparing deleted content;
3. delete edit-history and message-search-token rows;
4. delete pins, reactions and per-message delivery/read receipt rows;
5. unlink `message_attachments` rows;
6. set an unreferenced, non-avatar attachment's `linked_at` to null so the
   existing bounded orphan lifecycle can reclaim it;
7. remove retained `message.created`/`message.updated` content events for that
   message and their outbox rows;
8. write deletion attribution and the new command receipt;
9. append the tombstone realtime events.

The message mutation, content scrub, receipt and realtime outbox writes are one
atomic writer transaction. A failure before commit leaves the original message
and every derivative intact; a failure after commit is reconciled by the
receipt and durable event stream.

Independent forwarded copies are separate message rows and remain visible.
Selected safety-report evidence may remain encrypted under its report purpose;
the user-facing deletion flow and future privacy inventory must disclose that
exception without exposing it through the message API.

## 8. Realtime and reconciliation

No thirteenth snapshot collection is proposed. The authoritative reset remains
the current 12-collection contract. Message/chat/search resources return their
account-filtered state, so a full reset naturally omits `for_me` rows.

The proposed realtime representation reuses the existing event discriminant:

```json
{
  "type": "message.deleted",
  "scope": "for_me",
  "message": "<MessageSchema tombstone>"
}
```

`scope` is an additive field on `message.deleted`, not a new event type.

- `for_me` appends the personalized tombstone only to the actor account's
  durable stream, reaching every active device session for that account;
- `for_everyone` appends a global tombstone to every current eligible member;
- locally hidden accounts are excluded from later edit, reaction, receipt,
  pin and global-delete projections for that message so content cannot
  resurrect;
- a prior `message.created` followed by `message.deleted(for_me)` remains valid
  ordered replay and must converge to hidden state;
- mutation, event row and realtime-outbox row commit atomically.

For legacy realtime v1 projection the server may omit `scope`; the already
supported `message.deleted` tombstone still causes the correct local result.
Current v2 and generated clients must ignore additive event fields or receive a
version-specific projection. Compatibility fixtures must prove both paths
before capability advertisement. A new realtime protocol number is not needed
unless a maintained client is found to reject the additive projection.

Snapshot-boundary behavior is deterministic:

- deletion before a collection read is already filtered from HTTP;
- deletion after the boundary is delivered by cursor replay;
- deletion racing a page traversal cannot be lost because the client resumes
  from the captured boundary after completing the reset;
- session revocation wins before snapshot, command and queued/live dispatch.

## 9. Idempotency, limits and cleanup

The canonical SHA-256 fingerprint is computed from canonical JSON:

```text
{
  version: 1,
  operation: "message.delete",
  chatId,
  messageId,
  scope,
  expectedRevision: number | null
}
```

`clientNonce` identifies the receipt and is not duplicated in the fingerprint.
The receipt is scoped by authenticated account, so another account may use the
same UUID without collision.

Within the writer transaction, command order is:

1. sample `commandAt` from the wall clock;
2. delete an expired receipt for the same account/nonce;
3. run one bounded global expired-receipt purge;
4. check an active receipt before capacity, so valid retry still succeeds when
   the account is at its cap;
5. same fingerprint returns the stored validated response with
   `replayed=true` and performs no mutation/event;
6. different fingerprint returns `409` with no target details;
7. enforce the 64-active account cap and actionable `Retry-After`;
8. authorize/recheck, mutate, store the encrypted response and append events.

Receipt TTL uses `commandAt`, not a future-skewed message timestamp. Message and
projection timestamps use `timestampAfter(wallNow, message.updatedAt)` to remain
strictly monotonic. Cleanup runs at startup, every ten minutes and opportunistically
per command in bounded batches of 256. Both the expiry and account-cap queries
must use the declared indexes without a temporary B-tree.

Different nonces reaching an already committed identical `for_me` state return
the original account-hide timestamp as a semantic no-op, create their own
bounded receipt and emit no duplicate event. A fresh `for_everyone` nonce for
an existing tombstone succeeds only when current authorization and the current
tombstone revision satisfy the request; otherwise it returns the same stale
revision conflict as any other destructive command.

## 10. Required race outcomes

Independent SQLite connections, not only promises sharing one connection, must
cover these races:

| Race | Required outcome |
| --- | --- |
| same nonce, same command | one commit; other call returns exact replay |
| same nonce, changed scope/message/revision | one commit; changed command gets stable `409` |
| two different `for_me` nonces | one visibility row; second is a semantic no-op |
| edit vs `for_everyone` | revision CAS selects one winner; no mixed body/tombstone |
| edit vs `for_me` | either observed revision may win; actor remains hidden and receives no later edit |
| `for_me` vs `for_everyone` | local state stays hidden; global winner also tombstones every other view |
| role downgrade vs admin delete | writer order decides authorization; no post-downgrade delete |
| membership removal vs either scope | removal-first rejects; deletion-first commits before removal event |
| reply/forward vs global delete | delete-first hides source; copy-first leaves a valid independent copy |
| last-message hide vs concurrent send | chat preview/unread is one consistent viewer projection |
| response loss after commit | retry recovers from receipt with no second event |
| outbox/event failure before commit | message and visibility state roll back together |
| future server clock | chronology stays monotonic while receipt TTL remains wall-clock bounded |

The race suite must assert database state, HTTP result, durable event audiences,
outbox rows and raw receipt counts after every outcome.

## 11. Security requirements

- The account visibility table stores identifiers and timestamps only.
- Exact command responses are encrypted with the active content-encryption key
  and domain-separated by account plus nonce.
- Fingerprints are one-way SHA-256 values over canonical command metadata and
  never contain body text.
- Logs use route templates and server request IDs; message/chat IDs, nonce,
  body, attachment names, ciphertext and receipt response never appear.
- Non-member object access collapses to the existing not-found boundary.
- `for_me` cannot be used to infer whether another account still sees content.
- `for_everyone` authority is rechecked inside the writer reservation.
- Existing block and accepted-relationship policy cannot prevent a user from
  hiding content locally, but it still governs new direct-chat interaction.
- Hidden content cannot be recovered through search, pin, receipt, reaction,
  history, forward or attachment side channels.
- Rate limits are proposed at 60/IP/minute, 40/account/minute and
  30/device-session/minute, in addition to the receipt cap.
- Raw DB/WAL, API logs, error bodies and realtime events must pass content,
  token, nonce and profile canaries.

This is cloud-readable Beta-0.1 content, not E2EE. Scoped deletion must not be
described as cryptographic erasure.

## 12. Verification gate

Implementation is incomplete until all of the following pass in the exact
repository tree.

### Protocol

- strict request discriminant and unknown-field rejection;
- revision and UUID bounds;
- tombstone response refinements;
- capability additive-field tests;
- current and one-version-back HTTP/realtime compatibility fixtures.

### Migration and storage

- fresh migration chain through `025`;
- upgrade from applied `024` with users, chats, messages and legacy tombstones;
- `foreign_key_check`, integrity check and reopen evidence;
- mismatched chat/message and non-member insert rejection;
- immutable visibility/receipt rows;
- account/message/chat cascade behavior;
- expiry/account query plans use the named indexes and no temporary B-tree;
- encrypted response and plaintext-canary inspection of DB plus WAL.

### HTTP and authorization

- author/member/admin/owner matrices for Direct, Saved, Group and Channel;
- non-member and foreign-ID oracle equality with no side effects;
- stale revision, exact replay, changed fingerprint, TTL reuse and receipt cap;
- revoked/expired session and membership/role changes;
- legacy `DELETE` remains functional for one-version-back author/admin clients.

### Visibility and content

- messages, topics, chat preview, unread, folder filtering, search and pins;
- history, edit, forward, reactions and receipts;
- reply target missing projection;
- attachment owner, alternate visible grant and hidden-only denial;
- global scrub of body/history/search/pins/reactions/receipts/links/events;
- selected-report-evidence retention boundary and no report-summary leakage.

### Realtime and reconciliation

- `for_me` reaches every actor session and no foreign account;
- `for_everyone` reaches every eligible current member;
- v1 projection and v2 live/replay acceptance;
- no resurrection through later message-specific events;
- snapshot before/after/racing deletion and cursor recovery;
- atomic event/outbox behavior and process-restart delivery.

### Concurrency and regression

- every race in section 10 through independent writer connections;
- focused deletion integration/storage/race suites;
- full shared-protocol and API typecheck/test suites;
- complete HTTP and realtime authorization inventories;
- production image build, vulnerability/secret scan and disposable hardened
  authenticated smoke before any live promotion.

## 13. Compatibility and rollout

The existing `DELETE /v1/messages/{messageId}` is retained for one-version-back
clients during this slice. It continues to mean the existing global author/admin
tombstone and does not gain a required request body. The new iPhone client must
use the proposed canonical `POST .../deletions` command for nonce, CAS and scope.

Migration 025 is additive and forward-only. A previous application binary may
ignore the new tables and nullable columns, so a binary rollback does not
require schema rollback. Migration rows, visibility rows and receipts must
never be manually removed during deployment rollback. A later migration may
tighten attribution constraints only after the old writer is no longer a
supported rollback target.

The 12-collection reconciliation contract stays unchanged. The additive
capability and event field are advertised only after:

1. protocol compatibility fixtures pass;
2. the signed iPhone build understands scoped HTTP responses and the existing
   `message.deleted` projection;
3. fixture-free Swift-to-Docker deletion/relaunch/reconciliation passes;
4. the final server image passes full regression and security gates;
5. a stopped-service backup and exact rollback container exist.

No live database or server image should receive migration 025 as part of the
current chat-folder and membership-ledger promotion.

## 14. Dependencies and follow-on client work

Required dependencies:

- chat-folder migration `023`, membership-ledger migration `024`, candidate
  verification and iPhone snapshot-12 consumer must finish and promote safely
  first;
- the existing authenticated session guard, SQLite immediate transaction,
  content cipher, transactional realtime outbox, message schema and cursor
  reconciliation remain authoritative;
- no external credential, APNs provider, SMS provider, media hardware or call
  infrastructure is required for this server slice.

The subsequent iPhone integration should add a Russian destructive action
sheet with `Удалить у меня` and authorization-appropriate `Удалить у всех`, a
stable nonce across retry, optimistic local removal, explicit stale-revision
reconciliation and multi-device event handling. The client must not present
global deletion as successful until the server confirms it, and it must not
claim physical or cryptographic erasure.

After scoped deletion, the preferred small follow-on is per-chat notification
overrides. Synchronized drafts require a separate account-state conflict and
snapshot design; scheduled send requires the durable jobs platform; channel
comments/threads, moderation and account export/delete remain larger programs.
