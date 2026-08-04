# Luxora Realtime Cursor and Reconciliation Contract

Status: implemented Beta-0.1 single-node foundation. Owner and developer: **Flenym**.

This document describes the current `/v2/realtime` and `/v2/sync/*` contract. It
does not claim distributed retention, cross-region ordering, rolling-deploy
compatibility, or cross-process realtime fan-out.

## 1. Stream position

`sequence` is a monotonically increasing SQLite event watermark. It is global,
so an account's authorized events can legitimately have gaps. A client must
never require `next.sequence == previous.sequence + 1`.

The resumable v2 position is the opaque `luxora-rt1.*` cursor, not the number.
The API authenticates the cursor with a domain-separated HMAC and binds it to:

- cursor format version;
- immutable account ID;
- device-session ID;
- last safely applied global watermark;
- issue time.

The cursor is authenticated, not encrypted. Clients must store and return it
verbatim and must not parse claims from it. Cursor validity is bounded by both:

- `REALTIME_CURSOR_TTL_SECONDS`: seven days;
- `REALTIME_MAX_REPLAY_EVENTS`: 500 authorized-account event rows after the
  cursor and through the captured server head.

The TTL is currently a logical serving boundary. Encrypted event-row physical
pruning and distributed retention enforcement remain production work.
The advertised expiry instant is exclusive: a cursor is invalid at
`cursorExpiresAt`, not one second after it. Non-canonical base64url aliases are
rejected even when they decode to the same MAC bytes.

## 2. Connect and checkpoint order

The supported v2 flow is:

1. server sends `hello(protocolVersion=2)`;
2. client sends `authenticate(accessToken, resumeCursor?)`;
3. server verifies the access token, active session, cursor signature, scope,
   TTL and position before durable dispatch;
4. server sends `ready`;
5. for a valid resume, server sends zero or more authorized `dispatch` frames;
6. server sends `sync.checkpoint` at the captured head;
7. live dispatch continues.

For a scoped resume, `ready.sequence` is the cursor's already-applied sequence,
while `ready.headSequence` is only the replay target. The client must not persist
`headSequence` as applied state. It persists each dispatch cursor only after the
event has been applied idempotently, then persists the final checkpoint after
all prior frames.

A fresh v2 connection without a cursor starts at the current head and receives
a signed checkpoint. A numeric `resumeFrom` is accepted only on legacy
`/v1/realtime`; `/v2/realtime` never downgrades a malformed, foreign, expired or
mixed cursor request to numeric replay.

Before choosing a realtime path, an account-free client reads capability schema
v1 from `GET /v1/capabilities`. The current policy advertises supported versions
`[1, 2]`, preferred version `2` and minimum version `1`; v1 is the supported
one-version-back contract. A client chooses a common version without going below
the advertised minimum. If the client's highest supported version is below a
later security minimum, the protocol decision is `required_upgrade` with
`downgradeAllowed:false`; another no-common-version case is `incompatible`, also
without downgrade. Versioned fixtures in `packages/protocol/fixtures/realtime`
and `packages/protocol/fixtures/compatibility` lock these rules to executable
schemas. This contract evidence is not rolling-deploy or multi-process rollout
evidence.

The server also rechecks active session state before each authenticated client
command and before queued/live delivery. Same-process revocation invokes direct
socket termination; externally changed or naturally expired state is caught at
the next command, dispatch or heartbeat. A session-store read failure closes the
socket fail-closed instead of allowing delivery.

## 3. Deterministic recovery reasons

An unusable v2 resume sends `ready(cursor=null,resumed=false)`, then
`sync.required` with `recovery.path=/v2/sync/snapshot`, and closes with WebSocket
code `4009` before durable dispatch.

| Reason | Meaning |
| --- | --- |
| `cursor_invalid` | malformed/tampered cursor, future-issued cursor, numeric-only v2 resume, or mixed cursor inputs |
| `cursor_scope_mismatch` | valid cursor belongs to another account or device session |
| `cursor_expired` | seven-day logical cursor lifetime elapsed |
| `cursor_ahead` | signed cursor sequence is beyond the current durable head |
| `replay_window_exceeded` | more than 500 account event rows require replay |
| `backpressure` | pending connection queue exceeded its bounded capacity |

These reasons contain no cursor claims, content, snippets, profile data or
foreign stream positions. A revoked/expired access session fails authentication
and cannot obtain a snapshot or reuse its cursor through a replacement session.

## 4. Authoritative HTTP boundary

`GET /v2/sync/snapshot` requires an active Bearer session and returns no user
content. It returns:

- an account/session-scoped signed boundary cursor and expiry;
- the durable head captured before collection reads;
- the exact local collections to reset;
- authenticated canonical resource paths and pagination rules;
- the v2 resume path and the explicit `sequenceAdjacencyRequired=false` rule.

Recovery is idempotent:

1. fetch the boundary;
2. clear only the listed sync-owned local collections;
3. exhaust every canonical resource page using its returned `nextCursor`;
4. for every chat, exhaust messages and fetch current pins/topics; for every
   message, fetch current reactions and receipts;
5. connect to `/v2/realtime` with the boundary `resumeCursor`;
6. apply replay frames idempotently, then persist `sync.checkpoint`.

Mutations committed after the boundary are replayed. Reconciliation chat pages
use immutable `created_at/id` order rather than the activity-sorted UX list;
block pages use stable blocked-account ID order. Other paginated rebuild
collections use immutable creation order. This prevents an update or block
recreation from moving an existing object across already-consumed pages.

Current canonical resources are:

| State | Path | Privacy boundary |
| --- | --- | --- |
| Incoming/outgoing requests | `/v1/message-requests?direction=…` | current participant projection; private dismissal remains private |
| Blocks | `/v2/sync/blocks` | authenticated blocker's stable snapshots only |
| Chats | `/v2/sync/chats` | current member only, stable sync order |
| Messages | `/v1/chats/{chatId}/messages` | current chat member authorization |
| Pins/topics | `/v1/chats/{chatId}/pins`, `/topics` | current chat member authorization |
| Reactions/receipts | `/v1/messages/{messageId}/reactions`, `/receipts` | current member; blocked actor state filtered |
| Owned attachments | `/v1/attachments` | owner-only; never message-derived grants |
| Submitted safety summaries | `/v1/safety/reports` | authenticated reporter only; no evidence, comment, nonce, profile or moderation fields |

All reconciliation success and error responses are `private, no-store`.
Resource templates contain no
concrete account/chat/message IDs, and request logging uses route templates
rather than concrete URL paths or queries.

## 5. Replay authorization

Stored audience is necessary but not sufficient for delivery. Every replay and
live dispatch rechecks current state:

- current chat membership;
- accepted and unblocked Direct relationship;
- actor/block filtering for actor-aware group state such as reactions and receipts;
- current message-request state and private audience;
- actor-only block and report events;
- strict v1/v2 event compatibility.

An inaccessible stored event is skipped without exposing payload, snippet or
entity ID. The subsequent v2 checkpoint advances across filtered and unrelated
global sequence gaps safely.

Reaction events are additionally reprojected from current canonical state for
each audience at dispatch. Filtering only the triggering actor is insufficient:
an allowed actor's older aggregate could otherwise contain a reaction from an
account blocked after the event was stored.

## 6. Single-node transactional publication

Every new audience-specific `realtime_events` row creates a matching
`realtime_outbox` row in the same SQLite transaction/savepoint as the domain
mutation. A failed event or outbox insert therefore rolls back the surrounding
command; there is no committed-domain/missing-outbox state in this path.
Initial rows use an unconditional epoch-due marker. Event timestamps may be
logically advanced above a committed aggregate when a producer clock moves
backward, so they are never used to delay the first publication attempt;
`available_at` becomes a delay only for bounded retry backoff.

The process-local worker:

- claims due rows in sequence order under `BEGIN IMMEDIATE`;
- records a random worker owner, bounded batch and expiring lease;
- calls the local hub before setting `published_at`;
- retries explicit decode/publish failures with capped exponential backoff;
- reclaims expired leases after restart;
- retains an unreadable or repeatedly unpublished row as a durable
  `failed_at/failure_code` record after the bounded attempt budget.

Delivery is at-least-once. A crash after local hub publication but before the
SQLite acknowledgement intentionally permits a duplicate sequence after lease
expiry. Clients must apply durable events idempotently by sequence. A startup
drain with no connected socket may mark the local hub publication attempt, but
does not remove `realtime_events`; a reconnecting client still recovers the
event through cursor replay.

This outbox is not a client receipt and not a distributed broker. With several
API processes, one worker can claim an event while the relevant socket belongs
to another process. Redis Streams, NATS JetStream or another reviewed fan-out
transport—with idempotent sequence keys, consumer recovery and load evidence—is
a separate production gate.

## 7. Explicit residual work

- `/v1/realtime` numeric replay is compatibility-only and cannot provide the v2
  account/session cursor guarantee.
- SQLite is a single-node preview store; scalable cross-process fan-out,
  distributed cursor retention and rolling-deploy compatibility are not
  implemented.
- Durable failed outbox rows require an operator alert, inspection and reviewed
  repair/requeue procedure; they are never silently acknowledged or deleted.
- Idle sockets whose session is revoked by another process rely on the bounded
  heartbeat check until another command/dispatch occurs; production revoke
  fan-out latency still needs measured evidence.
- A deterministic single-process hostile harness now covers frame/typing rates,
  pending/session/auth connection bounds, slow-consumer eviction and cleanup.
  Production/multi-replica reconnect-storm and load evidence, physical event
  deletion, attachment-deletion tombstones and rolling-deploy interoperability
  remain open gates.
- Snapshot resources cover the currently implemented durable domains. Future
  membership, device, notification, call, push and E2EE state must add their own
  canonical resource before emitting a recoverable durable v2 event.
