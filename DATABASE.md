# Luxora Database

**Релиз:** Beta-0.1  
**Владелец и разработчик:** Flenym  
**Current engine:** SQLite through `better-sqlite3`, single node only

## 1. Contract and limits

SQLite is the persistence engine for the Phase 1 text vertical slice and the
Phase 2 passkey server checkpoint. It provides a deterministic
local/shared-preview database behind the `Store` interface and supports tested
independent connections on one host through WAL and writer reservation. It is
not the selected production-scale topology or a distributed secret vault and
must not be placed on a shared network filesystem or shared by API processes on
different hosts.

Runtime pragmas:

```text
foreign_keys = ON
journal_mode = WAL
synchronous = NORMAL
busy_timeout = 5000 ms
```

Database and directory must be accessible only to the service identity. Backups and `-wal`/`-shm` are equally sensitive.

## 2. Migration model

`schema_migrations(id, applied_at)` is created first. Startup retries WAL setup
in 10 ms busy slices inside one monotonic five-second window, then restores the
regular 5,000 ms transaction wait. Every ordered migration takes
`BEGIN IMMEDIATE`, rechecks its immutable ID while holding the writer
reservation, applies once and records that ID in the same transaction. This
prevents two same-host cold starts from acting on a stale pre-lock migration
inventory; it is not evidence for multi-host or rolling production migrations.

Current migrations:

| ID | Change |
| --- | --- |
| `001_initial` | accounts, sessions, chats, text messages, reads, reactions and event log |
| `002_realtime_event_entities` | event type/entity metadata and cleanup index |
| `003_delivery_receipts` | per-message/per-user delivered/read receipt table |
| `004_rich_messaging_media` | topics, attachments/uploads, versions, pins and blind search indexes |
| `005_identity_access_safety` | privacy, requests, relationships, blocks, reports and append-only identity audit |
| `006_realtime_transactional_outbox` | owner-leased, retryable publication state for every durable audience event |
| `007_forward_request_identity` | internal nullable self-FK retaining the immediate source of a forward command |
| `008_message_request_fingerprint` | encrypted immutable canonical send/forward command fingerprint for durable nonce comparison |
| `009_passkey_ceremony_repository` | passkey ceremony CAS, encrypted TTL challenge/user-handle/credential storage, receipts, event/outbox, global credential uniqueness and credential-row CAS |
| `010_passkey_step_up_grants` | durable one-time `authenticator.add` grant created by consumed passkey step-up and atomically linked to one initial registration |
| `011_passkey_login_intents` | identifier-free primary-login intents, encrypted challenge lifecycle, safe receipts/events/outbox and deterministic session/token replay projection |
| `012_passkey_signup_intents` | pre-account candidate UUID plus encrypted username/display/32-byte handle snapshot, bounded attempts/expiry and safe signup receipts/events/outbox without a users FK or username reservation |
| `013_passkey_signup_consumption` | explicit password-auth state and atomic verified signup consumption linking the new account, first credential, session and hash-only initial-token recovery metadata |
| `014_passkey_authenticator_management` | encrypted authenticator labels/lifecycle, append-only management audit/outbox/receipts, revoke-only step-up grants and passkey session-to-credential provenance |
| `015_passkey_authenticator_revoke_intents` | immutable semantic target/revision intent inserted atomically with revoke ceremony begin and required before verified grant creation |
| `016_passkey_authenticator_revoke_intent_delete_guard` | blocks direct deletion of a live revoke intent while its ceremony remains durable |
| `017_chat_membership_lifecycle` | membership revision/time CAS, owner/direct/size guards and immutable actor-scoped mutation receipts |
| `018_phone_authentication` | encrypted/digested phone challenge and identity lifecycle, immutable command receipts/audit and atomic phone registration/session commit |
| `019_phone_password_challenge` | separate phone-password verifier/enable state, bounded post-OTP continuation receipts and append-only audit without enabling legacy password login |
| `020_processed_profile_avatar` | owned server-verified avatar attachment binding, trust metadata and database triggers that reject foreign/raw/deleting avatar rows |
| `021_push_registration_preferences` | session-bound encrypted APNs token registrations plus account-scoped notification preferences with hidden previews by default |
| `022_chat_folders` | account folder-state revision, synchronized rule folders/overrides, hard limits, monotonic revision guards and encrypted immutable command receipts |
| `023_chat_folder_receipt_retention` | adds the advertised 24-hour expiry boundary and global expiry index to folder-command receipts while preserving databases that already applied `022` |

Never edit an applied migration. New changes append a new ID. Before production rolling deploys, adopt expand/backfill/contract compatibility and prove old/new server coexistence.

## 3. Schema inventory

### `users`

| Column | Meaning / classification |
| --- | --- |
| `id` | immutable internal UUID |
| `username`, `username_normalized` | public/lookup identity; normalized value unique |
| `display_name`, `bio`, legacy `avatar_url` | profile data; arbitrary URL mutation is rejected |
| `avatar_attachment_id` | nullable FK to an owned `image` attachment whose trust columns prove server re-encoding; binding is guarded by insert/update triggers |
| `password_hash` | secret-equivalent verifier; Argon2id, never returned/logged |
| `password_auth_enabled` | explicit boolean authorization state; passkey-only signup stores `0` plus a per-account discarded-secret Argon2id placeholder |
| `created_at`, `updated_at`, `last_seen_at` | account/presence metadata; sensitive |

### `device_sessions`

`id`, `user_id`, untrusted-display `device_name`, created/last-seen/expiry and nullable revoke time. A current session is active only when ownership matches, not revoked and not expired.

### `refresh_tokens`

`id`, `session_id`, unique SHA-256 `token_hash`, creation/expiry and nullable `used_at`. Raw refresh value is never stored. Consumed-row retention enables reuse detection; cleanup/retention policy remains to be implemented.

### Phone authentication (`018`)

- `phone_auth_challenges` stores a keyed phone digest and code digest for
  equality/verification. Full E.164, masked response value, pending delivery
  code and device snapshot use context-bound data-encryption envelopes. A
  writer-transaction predicate enforces the configured resend window for the
  same phone digest; a provider retry keeps the same challenge ID as its
  idempotency key.
- Challenge state/revision and attempt/expiry checks gate the only allowed
  transitions. Correct verification resolves the phone identity only after
  code proof, then either atomically creates a session or issues one hashed,
  short-lived registration token.
- `phone_identities` binds one phone digest to one user. The verified E.164 is
  re-encrypted under stable `phone-identity:<user-id>:number` associated data;
  the delivery-challenge envelope is never copied as an unusable identity
  record.
- `phone_auth_command_receipts` retains encrypted exact success responses so a
  committed access/refresh result can survive response loss. Invalid-code
  receipts contain no response secret. `phone_auth_events` is a secret-free,
  append-only lifecycle audit. Direct updates/deletes of identities, receipts
  and audit rows are rejected by triggers.

These rows currently have no production retention worker, change-number or
account-deletion ceremony; those remain release gates.

### Phone password continuation (`019`)

`users.phone_password_hash` and `users.phone_password_enabled` are separate
from the legacy password verifier/enable flag. Database triggers reject an
enabled phone password without its Argon2id hash. Short-lived continuation
receipts contain encrypted exact success responses; failure rows contain no
password or bearer response. `phone_auth_password_events` is append-only and
records only challenge/revision/command-scope lifecycle metadata.

### Processed profile avatars (`020`)

`attachments.safety_status` and `metadata_trust` default existing and ordinary
uploads to `unscanned`/`client_declared`. Only a server-created derivative may
use `reencoded`/`server_verified`. `users.avatar_attachment_id` references that
derivative, and ownership/kind/trust/deletion triggers reject foreign or raw
bindings. Bound rows are excluded from orphan claims; replace/clear releases a
previous derivative only when neither a message nor another current profile
references it.

### Push registration and notification preferences (`021`)

`push_registrations` stores only a SHA-256 equality index and an authenticated,
context-bound encryption envelope for the opaque APNs token. The public
projection never contains the token. Every active row is bound to one owned,
unexpired device session; database triggers reject cross-account or revoked
session bindings, token rotation leaves at most one active row per session, and
session revocation invalidates its push row in the same SQLite transaction.
`notification_settings` is account-scoped and defaults lock-screen previews to
`hidden`; message/request/mention, sound and badge choices are synchronized.
Partial changes use one column-selective SQLite update with a monotonic
`updated_at`, so a device changing one preference cannot overwrite unrelated
fields from an earlier read/merge/write snapshot.
Actual APNs provider credentials, delivery jobs, 410-token feedback handling and
real-device delivery evidence remain separate release gates.

### `chats`

`id`, checked `kind` (`direct`, `group`, `channel`), title/avatar, nullable unique `direct_key`, creator, timestamps and nullable `last_message_id`. A direct key is deterministic for the unordered pair, including `self:<user>`.

### `chat_members`

Composite PK `(chat_id,user_id)`, checked role (`owner`, `admin`, `member`), positive `membership_revision`, immutable join time, monotonic membership update time plus account-scoped `archived_at` and `muted_until`. Membership is the current authorization source. Migration `017` enforces member limit 200, direct-role/delete immutability, a single immutable owner and exact revision increments for role changes. Legacy rows project join time as their initial update time without rewriting old domain data. Archive/mute desired-state writes are column-selective, so concurrent changes to different preference fields cannot overwrite one another; repeated archive preserves the first server timestamp. These fields are now exposed only to the owning membership through strict chat-preference GET/PATCH routes. Realtime preference events and synchronized custom folders are separate account-scoped projections over this membership source.

### `chat_membership_command_receipts`

Append-only PK `(actor_user_id,client_nonce)` binds one exact add/role/remove
fingerprint to chat, target and the full resulting membership snapshot. It is
written in the same immediate transaction as membership CAS and per-account
realtime outbox rows. A removal snapshot uses the terminal revision and removal
time even though the current authorization row is already gone. Ownership
transfer is deliberately not represented by this table yet.

### Chat folders (`022`–`023`)

- `chat_folder_states` has one optional row per `user_id`, a nonnegative
  account-wide revision and monotonic update time. Absence projects revision
  `0`; every real folder-state command increments exactly once. Its trigger
  rejects account changes, skipped/repeated revisions and backwards time.
- `chat_folders` stores account FK, a 1–48-Unicode-code-point title, server position
  `0...9999`, positive per-folder revision, three checked include-kind booleans,
  `unread_only`, `exclude_muted`, `include_archived` and ordered timestamps.
  `(id,user_id)` is unique for the composite override FK. A trigger caps each
  account at 10 folders; another trigger permits only immutable identity/create
  time plus an exact `revision + 1` and nondecreasing update time.
- `chat_folder_overrides` is keyed by `(folder_id,chat_id)` and also carries the
  same `user_id`. Composite FKs require both an account-owned folder and a
  current `(chat_id,user_id)` membership. `mode` is `include|exclude`; nullable
  pin position is `0...99`, unique within the folder, and only `include` rows
  may be pinned. The insert trigger caps a folder at 100 overrides. Folder
  deletion and membership removal cascade the corresponding rows.
- `chat_folder_command_receipts` is keyed by `(user_id,client_nonce)` across
  `create|update|delete|reorder`. The canonical operation fingerprint is a
  plaintext SHA-256 digest; the exact response is stored only as a `luxora:v1.*`
  authenticated-encryption envelope bound to AAD
  `chat-folder-receipt:<user-id>:<client-nonce>`. Migration `022`
  made rows immutable; forward migration `023` preserves already-written rows,
  removes only the delete guard, adds the indexed expiry column and requires it
  on every new row. Updates remain forbidden. Exact active retries decrypt the
  original response; a changed operation or fingerprint conflicts. The public
  window is 24 hours with at most 64 active rows per account. Logical reads and
  quota counts ignore expiry immediately; targeted nonce cleanup prevents a
  stale primary-key collision, while global bounded startup/periodic/command
  sweeps provide physical retention cleanup.

Folder service commands use one immediate transaction for folder/override
changes, account state revision, encrypted receipt and the account-audience
event/outbox row. Semantic PATCH/reorder no-ops persist only their replay
receipt: neither folder revision nor state revision advances and no event is
written. Reorder also performs account-state CAS, and GET projects folders,
overrides and state revision under one deferred SQLite read transaction. A
membership removal finds every affected folder before deleting the
membership, then removes the departed chat override, advances each affected
folder once, advances the removed account's state once and appends its exact
account event in the same membership transaction.

### `messages`

`id`, chat/sender FKs, current `kind='text'`, nullable body, reply FK, `client_nonce`, revision and timestamps. Unique `(sender_id,client_nonce)` enforces idempotency across retries. `forward_source_message_id` is an internal nullable self-FK used only to distinguish the immediate source identity of forward retries. `request_fingerprint_ciphertext` retains the encrypted canonical original send/forward command so later edits/tombstones cannot change nonce semantics. Neither internal field is exposed by the protocol/event projection. Tombstone sets `body=NULL` and `deleted_at`; it does not promise immediate physical deletion from every backup.

Order and cursor are `(created_at DESC, id DESC)`. Server timestamps are canonical. A committed send/edit/delete uses the wall clock only when it is strictly above the authoritative aggregate timestamp; otherwise it advances that floor by one millisecond. UUID remains the deterministic tie-break for legacy/equal read targets.

### `chat_reads`

One latest read cursor per chat/user. Advancement compares canonical target message `(created_at,id)`, refuses rollback to older content and never decreases `read_at` under server-clock rollback.

### `message_receipts`

Composite PK `(message_id,user_id)`, first `delivered_at` and nullable monotonic `read_at`. Delivery insert is idempotent. Read also ensures delivery, persists `delivered_at <= read_at`, advances `chat_reads` only forward and returns the actual stored timestamp used in its realtime event.

### `message_reactions`

Composite PK `(message_id,user_id,emoji)` makes add/remove idempotent. Summary is grouped by emoji, ordered by count then emoji.

### IA-1 identity/safety tables

- `account_privacy_settings` stores exact-lookup and message-request policy per immutable user ID.
- `message_requests` stores one pending resource per unordered pair, sender-scoped nonce, state/expiry and encrypted body, normalized link and immutable sender/recipient profile snapshots.
- `account_relationships` stores only explicit acceptance. Migration `005` backfills pre-IA-1 Directs; a block removes acceptance and unblock does not recreate it.
- `account_blocks` is directed and stores an encrypted immutable profile snapshot for the blocker’s own list.
- `safety_reports` stores encrypted exact selected-evidence snapshots and optional comment; public responses expose summary only.
- `identity_audit_events` records successful identity mutations. SQLite triggers reject update and delete, making the table append-only at the database boundary.

### `realtime_events`

Autoincrement global `sequence`, `audience_user_id`, serialized event envelope, create time and optional event type/entity metadata. Each chat event is persisted once per member audience. Entity metadata lets delete remove pending message-content events to reduce stale replay leakage.

The global sequence may skip values for one user because other audiences share the counter. Authorization comes from audience, not adjacency.

### `realtime_outbox`

One row per durable event sequence, with initial/retry availability, bounded
attempt count, nullable owner/lease, publication time and durable failure code.
The event FK cascades when a pending message-content event is intentionally
purged. Initial rows are unconditionally due; only a failed attempt schedules
backoff. Publication is at least once because a crash can occur after hub
publication and before acknowledgement.

### Passkey repository (`009`–`010`)

- `passkey_challenge_secrets` is a bounded TTL vault. The 32-byte challenge is
  stored only in an AES-256-GCM envelope bound to its unrelated opaque
  reference. Resolve never makes it authoritative for one-time use; ceremony
  CAS does. Terminal flows discard best-effort, and
  `purgeExpiredPasskeyChallengeSecrets(nowMs, limit)` removes only expired rows
  in deterministic bounded batches.
- `passkey_user_handles` stores one stable 32-byte PII-free WebAuthn user handle
  per account as ciphertext plus a SHA-256 equality digest. A composite
  `(reference, account_id)` FK binds registration ceremonies and credentials to
  that account. Registration preparation returns an existing binding or a new
  in-memory CSPRNG candidate without writing it; an absent candidate is inserted
  only inside the authorized initial-registration transaction.
- `passkey_ceremonies` stores the exact account/session/device/purpose target,
  challenge reference+digest, expiry, attempts, terminal state and revision.
  The account/session composite FK prevents a session belonging to another
  account from being persisted. Registration also requires its account-bound
  user-handle reference.
- `passkey_ceremony_events`, `passkey_ceremony_outbox`,
  `passkey_command_receipts` and `passkey_creation_receipts` are written in the
  same transaction as the aggregate. The outbox projection excludes actor,
  challenge and credential material. Receipts contain only the domain's safe
  overall command fingerprint; neither a WebAuthn response nor its standalone
  digest is stored.
- `passkey_credentials` uses a globally unique SHA-256 credential-ID digest for
  exact lookup. The canonical credential ID is encrypted separately. Public key
  plus transports use a second record-bound encrypted material envelope;
  algorithm, row revision, sign counter and BE/BS remain checked columns needed
  for verification and CAS. Migration `014` makes the account limit count only
  active management metadata, while the global credential digest remains
  retained after revoke so a retired credential cannot be registered again.
  The limit of 20 is enforced inside the same immediate registration transaction.
- `passkey_step_up_grants` contains authorization metadata only: source
  authentication ceremony ID, exact account/session/current device binding,
  fixed `authenticator.add` purpose, target digest, authentication/issue/expiry
  seconds and nullable one-time consumption link. No raw JWT, signature, bearer
  value or `jti` is persisted. The signed-token verifier authenticates the
  canonical deterministic `jti`; SQLite CAS authority is the unique source
  authentication ceremony ID plus every durable binding field.
- A grant insert is accepted only while the matching authentication aggregate
  and its current `passkey.ceremony.consumed` event exist and agree on
  kind/purpose, verified terminal outcome, actor, target and auth time. The
  source authentication ID deliberately is not an FK: cleanup of that
  transient ceremony cannot remove an already issued authorization while its
  registration is pending. The linked registration ID is a unique deferred FK,
  so grant CAS may happen before the registration rows in the same transaction;
  deleting that registration cascades its authorization record.
- Database triggers reject direct credential insertion/update unless the linked
  grant is consumed and its registration aggregate is itself consumed with the
  exact account/session/device/purpose target. Immutable-binding and consume-once
  triggers add defense in depth around the repository CAS. Credential identity,
  account/handle/material/algorithm/discovery/BE/registration/creation bindings
  cannot be changed by direct SQL; only the intended authentication CAS fields
  remain mutable. Direct grant deletion is refused while its parent account and
  session exist, preventing delete-and-reinsert reset of one-time consumption;
  session/account FK cascades remain valid once the parent has gone.

Credential rows intentionally keep only the immutable scalar
`registration_ceremony_id`, without an FK to the transient ceremony. Session or
ceremony retention therefore cannot destroy/block an enrolled credential;
account deletion remains the credential lifecycle boundary. Ceremony/event/
receipt retention policy and operational deletion worker are still open gates.

### Primary login and pre-account signup (`011`–`013`)

- Primary-login intents are identifier-free until the maintained verifier
  resolves a discoverable credential. Their safe receipts/outbox omit account,
  credential, assertion and bearer material; deterministic refresh/access
  metadata permits only bounded exact committed-response recovery.
- Signup intents deliberately have no candidate-account FK and do not reserve
  `users.username_normalized`. The server-generated candidate UUID, username,
  normalized username, display name and exact 32-byte WebAuthn handle are an
  encrypted immutable snapshot. Only handle/challenge/delivery equality digests,
  opaque references, policy, attempts, state and timestamps remain queryable.
- Signup begin never reads `users` or `passkey_credentials`; an already-used
  username therefore produces the same pending ceremony shape. The verified
  `BEGIN IMMEDIATE` commit decides global account/username/handle/credential,
  generated session and refresh uniqueness and either inserts every row or none.
- A successful first-passkey transaction creates `users` with
  `password_auth_enabled=0`, a valid Argon2id hash of a random discarded secret,
  default privacy settings, the handle and credential, session, hash-only refresh,
  consumption record, terminal intent, event/outbox/receipt, then removes the
  challenge lease. No raw signup authorization, WebAuthn JSON, password secret or
  access/refresh bearer is accepted by the Store boundary.
- `passkey_signup_consumptions` retains only account/handle/credential/session/
  initial-refresh IDs, access expiry, refresh derivation key ID and commit time.
  Together with the signed client-held authorization, this supports bounded exact
  response-loss replay without persisting a raw bearer.
- Expired pending signup intents are selected by `(expires_at_ms, intent_id)` in
  bounded batches. The standalone reconciler uses one observed clock and a
  deterministic command proof containing only intent ID/revision/expiry; the
  immediate Store transaction rechecks writer time and revision, then commits the
  terminal event/outbox/receipt and challenge deletion together. Exact receipts
  reconcile restart/two-writer ambiguity, while only explicit SQLite
  `BUSY`/`LOCKED` errors receive capped backoff. App startup and the bounded
  ten-minute maintenance interval invoke it even when signup routes are disabled.

### Authenticator management (`014`–`016`)

- `passkey_authenticator_metadata` binds one credential record and account to an
  AES-256-GCM encrypted display label, terminal `active|revoked` lifecycle,
  monotonic revision and exact created/updated/revoked timestamps. Label AAD is
  stable across revisions so revoke can preserve the ciphertext exactly.
- Startup performs an immediate, idempotent migration-013 backfill for every
  existing credential using the encrypted Russian default `Ключ доступа` and a
  deterministic registered event/outbox. Future authenticated-add and signup
  credential commits create metadata and registration evidence atomically.
- `passkey_authenticator_events` and `passkey_authenticator_outbox` contain only
  schema/event/account/opaque authenticator/revision/lifecycle/time metadata.
  Exact-binding and append-only triggers reject field substitution, extra secret
  fields, update and live-parent deletion. Command receipts bind the same event
  and store the complete result only in an authenticated encryption envelope.
- `passkey_authenticator_step_up_grants` is separate from the existing
  `authenticator.add` table. A row can be created only from a consumed verified
  authentication ceremony bound to `authenticator.revoke`, the target opaque
  credential record and expected management revision. It is immutable,
  unexpired and consumable once; consumed or expired authorization is not
  reissued as fresh authority.
- `passkey_authenticator_revoke_intents` fixes the account/session/opaque target,
  expected management revision and SHA-256 target digest in the same transaction
  as ceremony begin. Verification can create a revoke grant only when that
  immutable row still matches the consumed ceremony; update or direct live-row
  deletion is rejected.
- `passkey_session_credential_origins` records the credential that produced each
  successfully verified signup/login session. Revoke atomically marks the
  authenticator terminal, excludes the credential from every verifier lookup,
  revokes attributed sessions and consumes their refresh rows. Post-commit live
  transport cleanup is observable but its distributed fan-out/retry worker is
  still a release gate.
- Password-disabled accounts cannot revoke their last active authenticator.
  Independent SQLite writers prove rename/rename, exact/changed command replay,
  revoke/revoke and two-target last-factor serialization. Revoked metadata is
  retained for audit and exact receipts but omitted from the account list.

The migrations themselves advertise no capability. The application composes
strict management routes only under the default-off, production-forbidden
authenticated passkey flag; capability discovery stays false and independent
security notification/recovery delivery remains absent.

## 4. Relationships

```text
users ──< device_sessions ──< refresh_tokens
users ──< chat_members >── chats ──< messages
users ── chat_folder_states
users ──< chat_folders ──< chat_folder_overrides >── chat_members
users ──< chat_folder_command_receipts
messages ──< message_reactions
messages ──< message_receipts
chat_members/users ──< chat_reads >── messages
users ──< realtime_events (audience)
realtime_events ── realtime_outbox
users ──< passkey_user_handles ──< passkey_credentials
users/device_sessions ──< passkey_ceremonies ──< passkey_ceremony_events
passkey_ceremony_events ── passkey_ceremony_outbox / passkey receipts
consumed passkey authentication ── passkey_step_up_grants ── linked registration
pre-account passkey_signup_intents ── passkey_signup_events / outbox / receipts
consumed passkey signup ── passkey_signup_consumptions ── users/session/credential IDs
passkey_credentials ── passkey_authenticator_metadata ── management events/outbox/receipts
pending target-bound authentication ── passkey_authenticator_revoke_intents
consumed target-bound authentication + revoke intent ── passkey_authenticator_step_up_grants
passkey_credentials ── passkey_session_credential_origins ── device_sessions
users ── account_privacy_settings
users ──< message_requests / account_relationships / account_blocks
users ──< safety_reports / identity_audit_events
```

Foreign keys cascade only where current lifecycle semantics are explicit. User/account deletion propagation is not complete and must be designed across future object/search/cache/backup systems.

## 5. Transactions and acknowledgement

Operations that mutate domain state and create durable events run in one SQLite transaction. The HTTP result/publisher observes committed data. Important examples:

- create chat + all members + personalized `chat.created` events;
- create/edit/delete message + authorized audience events;
- reaction/receipt mutation + corresponding event;
- refresh token consume + hash-only replacement insert + session touch; commit
  time is sampled after the SQLite writer reservation, replacement preserves the
  earlier family/session expiry, and a visible commit-after-error is reconciled
  by revoking the session;
- request creation/acceptance, relationship state, first Direct message and audience-specific events;
- block/report mutations and actor-account audit/realtime rows.
- chat-folder create/update/delete/reorder, account state revision, encrypted
  exact receipt and `actor_account` event; membership removal also reconciles
  the removed account's affected folder overrides in its membership transaction.

Message-request and safety-report creation use an immediate writer transaction and recheck the actor-scoped nonce plus operation fingerprint after the reservation, before events/audit/block effects. Tests exercise two independent connections contending on an uncommitted writer: identical retries return the first row and changed nonce reuse returns `CONFLICT`. This is SQLite checkpoint evidence, not a production multi-process/database guarantee.

Message send/forward, edit/delete, read/delivered and reaction mutations also
reserve the writer before their authoritative nonce/revision/pointer state is
read. Send/forward exact retries converge on the first result; changed reuse is
a stable conflict. Version history and receipts update in the same transaction
as their per-audience event rows.

Passkey `commit()` reserves the SQLite writer and atomically compares ceremony
revision, inserts command/creation receipts, writes snapshot/internal event/
minimized outbox and applies the secure credential effect. Registration checks
the account limit and global credential-ID digest before insertion. Immediately
before a verified registration credential is inserted, the repository also
rejects a backwards commit clock and rechecks exact session ownership,
`revoked_at IS NULL` and `expires_at >` its actual commit clock; failure rolls
the aggregate, event, outbox, receipt and credential effect back together.
Authentication compares and increments the credential row revision while also
matching account, discovery mode, previous counter and previous BE/BS. Tests
use independent worker connections to prove one winner for duplicate global
credential IDs, the 19→20 account-limit boundary and two ceremonies updating
one credential. A losing effect rolls back its ceremony, event, outbox and
receipt. This is SQLite evidence, not behavior claimed for a future production
database.

For a successful `session.step_up` transition, that same immediate transaction
persists the consumed event, rechecks exact session ownership plus
`revoked_at IS NULL` and `expires_at >` the repository's actual commit clock,
creates a grant with at most 300 seconds TTL, updates the authentication
credential and writes receipts. Any late session race or credential failure
rolls all of it back.

Initial registration does not use ordinary `commit()`. Its dedicated immediate
transaction first rejects duplicate receipts, validates the verified signed
claims projection against the exact durable grant and registration actor/target,
samples the store clock, rechecks the active session, and CAS-consumes the grant
exactly once while linking the new registration ceremony. It then writes the
prepared user-handle binding when absent, pending aggregate, event, outbox and
both receipts. A concurrent different candidate for the same account loses
before its grant CAS, leaving that grant reusable after the caller reloads the
durable winner. Expiry is exclusive
(`nowSec < exp`); absent, future, expired, mismatched or reused authorization
leaves neither a user-handle nor registration rows and does not consume the grant. Domain receipt
reconciliation occurs before this path, so an exact replay does not spend the
grant twice.

Realtime in-process publication is attempted from the durable outbox after the
domain transaction returns. A client that misses process-local publication
reconnects and replays the retained durable event row.

## 6. Content encryption scope

When a valid keyring and active key ID are configured, AES-256-GCM envelopes protect:

- `messages.body`, bound with AAD context `message:<message-id>`;
- `messages.request_fingerprint_ciphertext`, bound with AAD context `message:<message-id>:request-fingerprint`;
- `realtime_events.event_json`, bound with AAD context `event:<audience-user-id>`;
- `chat_folder_command_receipts.response_ciphertext`, bound with AAD context
  `chat-folder-receipt:<user-id>:<client-nonce>`;
- message-request body/link/profile snapshots, block profile snapshots and safety-report evidence/comment, each bound to resource-specific AAD.
- passkey challenge, user handle, credential ID and credential material, each
  with a distinct reference/record-bound AAD context.

Envelope stores format version, encoded key ID, 12-byte random nonce, auth tag and ciphertext. Old key IDs remain readable for rotation. Tampering or copying ciphertext into a different contextual entity fails authentication.

Passkey vault/user-handle/credential writes reject the plaintext cipher even in
dev/test. Their searchable equality fields are digests over high-entropy
server/WebAuthn values; no raw challenge, user handle, credential ID, public key,
transport list, assertion or attestation is placed in a plaintext column.

Not encrypted by the general hook: usernames/profile, password hashes,
membership, chat title, timestamps, IDs, receipt/reaction metadata, sequence and
indexes. The app possesses keys and returns plaintext; this is storage defense,
**not E2EE**. Other dev/test content may use the plaintext cipher unless
configured; production config requires a keyring.

Migration/storage checkpoint evidence is scoped, not a full merged API claim:
the shared protocol suite passed 10 files / 83 tests; the chat-folder HTTP plus
direct SQLite storage suites passed 2 files / 11 tests; and the complete
HTTP/realtime authorization matrices passed 2 files / 14 tests in Docker Node
22. The storage suite also scans the database and WAL for plaintext receipt
canaries. The current full API suite still requires its separate
post-merge run.

## 7. Pagination and search

User/chat/message pages use opaque encoded cursors and fetch `limit+1` to determine `nextCursor`. Limit max 100. Message cursor is based on timestamp + UUID tie-break. Clients treat cursor as opaque and restart bounded reconciliation on invalid/expired cursor.

Exact public username lookup applies privacy and either-direction block filters and returns a narrow profile. Prefix/substring people search is limited to accepted relationships. Current message/file blind indexes are permission-filtered before projection; future Private search remains local/on-device.

## 8. Backup and restore

The current repository has a reproducible **offline local-preview** drill at
[`infra/operations/README.md`](infra/operations/README.md). After the API is
stopped, it uses SQLite's backup API to merge committed WAL state into a
standalone database and copies durable local blobs plus resumable upload staging
inside the same offline window. A sealed archive records SHA-256 and byte size
for every payload/metadata file, `schema_migrations`, full
`PRAGMA integrity_check`, foreign-key validation, local attachment/chunk
reconciliation and restrictive permissions.

Restore is deliberately limited to a new destination. It revalidates the
manifest before copying and verifies the restored database, migrations, blobs
and uploads afterward. Runtime secrets and data-encryption keys are not included;
encrypted data needs its compatible external keyring. Run the disposable proof
with `make backup-restore-test` and record controlled exercises using the
[evidence template](infra/operations/BACKUP_RESTORE_EVIDENCE_TEMPLATE.md).

This does not provide online backup coordination, encrypted/off-host archives,
signed provenance, retention/deletion, target object-store reconciliation, PITR
or measured RPO/RTO.
Do not claim production backup/DR until those gates and representative game days
pass. See [DEPLOY.md](DEPLOY.md).

## 9. Production storage migration

Server-platform completion requires an ADR and representative load/failure proof. Expected capabilities, not preselected branding:

- transactional constraints and outbox/event ordering;
- rolling schema compatibility;
- partition/index plan for messages/events/receipts;
- replicas/failover without acknowledged message loss;
- encryption/KMS separation, PITR and tested restore;
- retention/delete propagation and audit;
- explicit cursor/order semantics preserved for old clients.

A likely relational target may be PostgreSQL-compatible, but no choice is final until benchmarks, operations and failure behavior are recorded. Migration uses dual-compatible schema/backfill/reconciliation—not a big-bang dump with unverifiable downtime.
