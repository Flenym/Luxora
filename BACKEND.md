# Luxora Backend

**Релиз:** Beta-0.1  
**Владелец и разработчик:** Flenym  
**Статус:** runnable single-node Cloud preview

## 1. Scope

The backend implements a testable account/messaging/media/realtime contract, the IA-1 identity safety boundary and a provider-gated phone-first authentication slice. It is suitable for local development and controlled non-sensitive preview data. It is not a production-scale service and does not expose API-integrated call signaling, E2EE, push, public Spaces, a full moderation workflow or multi-region failover. Call control and SFU/TURN grant semantics currently exist only as an isolated tested package and loopback infrastructure harness.

## 2. Technology

| Layer | Current choice |
| --- | --- |
| Runtime | Node.js 22, ESM, TypeScript |
| HTTP | Fastify 5 |
| Validation | Shared Zod schemas from `@luxora/protocol` |
| Passwords | Argon2id via `argon2` |
| Access tokens | `jose`, HS256 JWT, 15-minute default |
| Refresh tokens | 256-bit opaque random value, SHA-256 hash stored |
| Database | `better-sqlite3`, WAL, single node |
| Realtime | Fastify WebSocket + `ws` |
| API documentation | OpenAPI and Swagger UI |
| Metrics | Prometheus text exposition |

## 3. Module responsibilities

- `src/config.ts` — validates environment and refuses unsafe production key configuration.
- `src/app.ts` — composition root, plugins, redacted logging, error normalization and shutdown hooks.
- `src/http/routes.ts` — boundary parsing, status codes and auth guards.
- `src/services/auth-service.ts` — registration, login, refresh rotation and session operations.
- `src/services/phone-auth-service.ts` — OTP challenge, verified existing-account session and new-account profile completion orchestration with exact durable replay.
- `src/phone-auth/phone-auth-security.ts` — purpose-separated HMAC digests, command fingerprints and constant-time code verification.
- `src/phone-auth/phone-delivery-provider.ts` — idempotent delivery boundary plus the silent local development provider; no real SMS vendor adapter is included.
- `src/services/passkey-login-service.ts` — internal identifier-free primary passkey login orchestration and bounded response recovery.
- `src/services/passkey-signup-service.ts` — independently gated pre-account first-passkey orchestration; it owns strict candidate/device/nonces, maintained verification and the atomic account/session projection.
- `src/http/passkey-signup-routes.ts` — internal-only pre-account signup transport contract; strict begin headers/body, raw bounded WebAuthn verify bytes, no-store/ETag responses and local anonymous route buckets, registered only by its separate non-production gate.
- `src/services/passkey-signup-expiry-sweeper.ts` — bounded startup/periodic reconciliation of abandoned pre-account signup intents with deterministic command ownership and SQLite contention backoff.
- `src/services/passkey-authenticator-management-service.ts` — internally routed active-authenticator list/rename/revoke orchestration with secret-free protocol projection, active-session checks, exact replay and observable post-commit session cleanup.
- `src/http/passkey-authenticator-management-routes.ts` — default-off, non-production-only strict management transport with target-bound revoke begin, resource ETags, no-store responses and bearer redaction.
- `src/passkeys/authenticator-management-binding.ts` — stable rename/revoke fingerprints and target/revision-bound `authenticator.revoke` digest domain.
- `src/passkeys/signup-authorization-token.ts` / `signup-refresh-token.ts` — signup-only authorization and deterministic initial-refresh key domains, separate from primary login.
- `src/services/chat-service.ts` — membership, chat and message invariants.
- `src/services/identity-access-service.ts` — discovery/privacy, requests, acceptance, blocks and selected-evidence reports.
- `src/realtime/routes.ts` — socket handshake and client commands.
- `src/realtime/hub.ts` — connection lifecycle, replay, ephemeral events and backpressure.
- `src/domain/store.ts` — persistence abstraction.
- `src/infrastructure/sqlite-store.ts` — queries, transactions, pagination and event log.
- `src/infrastructure/content-cipher.ts` — optional AES-GCM application-level envelope.
- `src/metrics.ts` — bounded-label operational metrics.

## 4. Startup configuration

| Variable | Required/default | Meaning |
| --- | --- | --- |
| `NODE_ENV` | `development` | `development`, `test`, `production` |
| `HOST` | `0.0.0.0` | Listen address |
| `PORT` | `8080` | Listen port |
| `DATABASE_PATH` | `./data/luxora.db` | SQLite file or `:memory:` in tests |
| `JWT_SECRET` | required, min 32 chars | HS256 signing secret; random and secret-managed outside test |
| `CORS_ORIGINS` | local origins | Comma-separated exact origins; wildcard rejected in production |
| `TRUSTED_PROXY_CIDRS` | empty | Explicit comma-separated source CIDRs of actual ingress/proxy hops; empty direct mode ignores forwarding headers |
| `ACCESS_TOKEN_TTL_SECONDS` | `900` | 60–3600 seconds |
| `REFRESH_TOKEN_TTL_DAYS` | `30` | 1–365 days |
| `PASSKEY_INTERNAL_ROUTES_ENABLED` | `false` | Development/test-only authenticated add-authenticator gate; production rejects `true` |
| `PASSKEY_BOOTSTRAP_REFRESH_KEYS` | optional internal seam | Dedicated JSON keyring of 32-byte base64url roots for exact initial-refresh recovery; with the active ID, internal flag and data-encryption key it wires primary login |
| `ACTIVE_PASSKEY_BOOTSTRAP_REFRESH_KEY_ID` | paired with the keyring | Key ID used for newly begun passkey-login intents; old IDs remain available for bounded replay recovery |
| `PASSKEY_INTERNAL_SIGNUP_ROUTES_ENABLED` | `false` | Separate development/test-only pre-account signup gate; production rejects `true` |
| `PASSKEY_SIGNUP_AUTHORIZATION_SECRET` | required only with signup gate | Independent ≥32-byte master secret for the signup-only signed authorization namespace; cannot reuse JWT, signup/login refresh or data material |
| `PASSKEY_SIGNUP_REFRESH_KEYS` | required only with signup gate | Signup-only JSON rotation keyring of exact 32-byte base64url roots; every retained root is unique and cannot be shared with authorization, JWT, login refresh or data encryption |
| `ACTIVE_PASSKEY_SIGNUP_REFRESH_KEY_ID` | paired with signup keyring | Active signup initial-refresh derivation key; retained keys support bounded committed replay |
| `DATA_ENCRYPTION_KEYS` | required in production | JSON map of key ID → 32-byte base64url AES key |
| `ACTIVE_DATA_ENCRYPTION_KEY_ID` | required in production | Key used for new envelopes; old keys retained for reads |
| `PHONE_AUTH_ENABLED` | `false` | Explicit phone-authentication gate; all related provider/secret settings are rejected while it is false |
| `PHONE_AUTH_PROVIDER` | `disabled` | `development` uses the fixed local code outside production; `external` requires an injected provider implementation |
| `PHONE_AUTH_HMAC_SECRET` | required when enabled | Independent ≥32-byte HMAC material; cannot reuse JWT, data-encryption or passkey secrets |
| `PHONE_AUTH_DEVELOPMENT_CODE` | development provider only | Exact six-digit local/Xcode code; forbidden with the external provider and in production |
| `PHONE_AUTH_CHALLENGE_TTL_SECONDS` | `300` | OTP challenge lifetime, 120–600 seconds |
| `PHONE_AUTH_REGISTRATION_TTL_SECONDS` | `600` | New-profile completion/replay window, 300–1,800 seconds |
| `PHONE_AUTH_RETRY_AFTER_SECONDS` | `60` | Durable same-phone resend cooldown, 30–300 seconds |
| `PHONE_AUTH_MAX_ATTEMPTS` | `5` | Failed-code attempt bound, 3–10 attempts |
| `SYNC_INVALIDATION_ENABLED` | `true` | Emergency-only rollback seam. `false` suppresses only `sync.invalidated` creation, replay and live/outbox delivery; ordinary domain events and schema migrations remain active, and capabilities advertise the degradation |
| `METRICS_TOKEN` | optional | Bearer protection for `/metrics`; otherwise isolate at network layer |

Production startup fails if the encryption keyring/active ID is absent or invalid. That check proves configuration intent only; deployment evidence must still verify storage, backups and key access.

`SYNC_INVALIDATION_ENABLED` is deliberately default-on and strict: only
`true`, `false`, `1` and `0` are accepted. Set it to `false` only as a bounded
incident fallback when `sync.invalidated` itself is the suspected fault. The
fallback keeps the migration chain and membership-revision ledger intact,
acknowledges suppressed historical invalidation outbox rows without delivering
them, filters invalidations before applying replay limits, and continues all
ordinary domain events. Operators must verify
`features.syncInvalidation:false` from `/v1/capabilities`; restoring the primary
mode requires a fresh reconciliation/snapshot check before returning the flag
to `true`.

Phone authentication is disabled by default. Enabling it without an active
data-encryption key, independent HMAC material or a usable delivery provider
fails before the application is exposed. The `development` provider is
categorically rejected in production and never logs or returns its fixed code.
The `external` mode also fails closed unless an implementation is injected at
the composition boundary; selecting it in environment variables alone does not
pretend that real SMS delivery exists. Capability discovery reflects only the
effective runnable state.

When the internal primary-passkey-login seam is configured, startup also
requires `ACCESS_TOKEN_TTL_SECONDS >= 601`: the initial access token must cover
the 300-second ceremony, the 300-second response-loss recovery bound, and the
worst-case whole-second rounding edge. The default `900` satisfies this gate.

`PASSKEY_INTERNAL_SIGNUP_ROUTES_ENABLED=true` is accepted only outside
production and only with the complete signup authorization secret, signup-only
refresh keyring/active ID and active data-encryption key. Partial injected or
environment configuration fails before Fastify or storage composition. Signup
and existing authenticated/login flags are independent; enabling one never
registers either of the others. The signup recovery bound likewise requires
`ACCESS_TOKEN_TTL_SECONDS >= 601`. Capability discovery remains
`features.passkeys:false` for every combination.

At startup and every ten minutes, a bounded passkey-login expiry sweep closes
abandoned `pending` intents with the same SQLite revision CAS and writer-time
check used by request-driven expiry. Each transition atomically persists its
event/outbox/receipt and removes the encrypted challenge secret; concurrent
request winners are skipped safely.

The signup expiry counterpart runs at startup and on the same ten-minute
maintenance interval even when its routes are disabled, so intents left by a
previous internal run are not stranded. It samples one clock, processes a
bounded ordered set, retries only recognized SQLite `BUSY`/`LOCKED` contention
with capped deterministic backoff, and uses a secret-free proof over intent
ID/revision/expiry so a restart or second owner can reconcile the exact receipt.
The Store's immediate writer-time/revision CAS owns the transition and atomically
removes the challenge with the event/outbox/receipt. App close clears the shared
maintenance timer before closing the Store.

Migrations `014`–`016` and the management service provide a durable authenticator
lifecycle foundation with an internal-only HTTP composition. Existing credentials receive an
encrypted default label during idempotent startup backfill; future add/signup
commits create metadata atomically. Rename uses exact command fingerprints and
revision CAS. Revoke requires a fresh consumed-WebAuthn-derived grant bound to
the account, active session, opaque credential record and expected revision;
the same transaction terminally disables verifier lookup, writes append-only
event/outbox/encrypted receipt evidence and revokes sessions/refresh rows known
to originate from that credential. A password-disabled account keeps at least
one active authenticator. Independent writers cover replay, rename/revoke and
last-factor races.

The management paths share `PASSKEY_INTERNAL_ROUTES_ENABLED`: they remain
physical `404` and absent from OpenAPI by default, and production rejects the
flag. When enabled in development/test they are authenticated and no-store,
while capability discovery still remains `features.passkeys:false`. Public
composition, independent security
notifications, distributed session fan-out/retry, recovery and client interop
remain required gates.

## 5. Authentication lifecycle

### Register/login

Username is normalized to lowercase for uniqueness. Password hash parameters are Argon2id `memoryCost=65536`, `timeCost=3`, `parallelism=1`, 32-byte output. Login uses a dummy hash when the account is absent to reduce trivial timing enumeration. Errors remain generic for invalid credentials.

### Phone-first OTP

`POST /v1/auth/phone/challenges` normalizes the calling code plus national
number to E.164 and creates an idempotent delivery command. A SQLite writer
predicate enforces the configured cooldown by keyed phone digest even when a
caller changes its nonce or multiple writers race. Exact begin retries reuse
the challenge ID, which the delivery provider must also treat as its
idempotency key.

`POST /v1/auth/phone/challenges/:challengeId/verify` applies strict expiry and
attempt bounds. Account existence is queried only after a correct OTP, so the
begin response and invalid-code behavior do not disclose whether the phone is
registered. A verified existing identity returns
`status: "authenticated"` with a new device session. An unknown verified
number returns `status: "profile_required"` with a short-lived registration
token.

The profile-required path offers a case-insensitive username availability
check with deterministic available suffix suggestions; checking does not
reserve a name. Registration atomically creates the password-disabled user,
privacy defaults, verified phone identity, device session and hash-only refresh
row. Username and phone races have one database winner.

Phone, masked value, delivery code, device snapshot and successful replay
payloads are stored in context-bound AES-GCM envelopes. Digests and fingerprints
use independent HMAC domains. Durable command receipts recover the exact
committed response after transport loss, while identity creation decrypts the
challenge envelope and re-encrypts the number under stable identity-specific
associated data rather than copying ciphertext bound to challenge AAD.

Current gaps are a real SMS adapter/operations contract, optional post-OTP
secret-password step-up, a reviewed ceremony for binding phones to legacy
accounts, avatar/profile-upload binding, retention/change-number/deletion
workers and distributed production rate limiting/abuse evidence.

### Access token

Claims include issuer `https://api.luxora.app`, audience `luxora-clients`, subject user ID, `sid`, `jti`, issued/expiry and `token_use=access`. Verification accepts only HS256 and validates required UUID claims. HS256 is an M0 choice; asymmetric signing and rotation require a future ADR.

### Refresh/session

The client receives `luxr_` + 32 random bytes. Only SHA-256 hash is stored. Every successful refresh acquires a SQLite writer reservation, samples commit time only after that reservation, rechecks token/session state, atomically consumes the prior row and inserts one replacement without lengthening the earlier token-family/session expiry. A serialized same-token race can return at most one rotation; the loser is classified as reuse, revokes the whole device session and never creates a second lineage. A commit-then-error ambiguity is authoritatively reread and fails closed when consumption is visible; uncommitted SQLite lock exhaustion maps to a retryable `503`. Exact expiry is exclusive and refresh/session lifecycle timestamps do not move backward across observed clock rollback. Durable session revoke invalidates guarded HTTP and refresh; local realtime termination is invoked after commit, while cross-process fan-out/latency evidence remains open.

Client requirement: serialize refresh per device. The current strict fail-closed policy intentionally makes the apparent winner unusable after a concurrent reuse signal, so an ambiguous network retry requires sign-in/recovery; production-database primary-read/failover/commit fault injection, distributed revoke fan-out and user security alerts remain future gates.

Decision record: [ADR-0001 — strict single-use refresh rotation under races](docs/adr/0001-strict-refresh-rotation-races.md).

## 6. Messaging behavior

- `direct` is unique for an unordered pair (including Saved/self via `self:<id>`); a non-self Direct requires explicit accepted relationship state.
- `group` and `channel` accept up to 199 listed IDs plus the creator.
- Creator owns group/channel; channel publish is owner/admin only.
- Group/channel member list/add/role/remove mutations use strict actor-scoped nonces, immutable receipts and positive membership revisions. Owner/admin permissions are rechecked inside an immediate writer transaction.
- Direct membership cannot mutate; groups/channels cap at 200 current accounts. The sole owner cannot be demoted, removed or leave until a dedicated ownership-transfer ceremony exists.
- Exact retries return the first result without duplicate events. Independent-writer tests prove one revision winner and prove committed removal defeats a message that began against the older membership snapshot.
- Message actor is derived from auth, never request body.
- `clientNonce` is unique per sender. Identical retry returns the original message; reuse with different content/chat conflicts.
- Reply target must exist in the same chat.
- Only author edits; optional `expectedRevision` detects concurrent change.
- Author or owner/admin may tombstone-delete under current policy.
- Reactions are idempotent by message/user/emoji.
- Read endpoint verifies message membership in the same chat.

Delivered receipts are explicit per-user acknowledgements via HTTP/WS and are idempotently persisted; they are not inferred from time or socket presence. IA-1 adds quiet message requests, atomic acceptance, either-direction block enforcement across direct mutations/presence/typing/receipts, and selected-evidence reports. Block removal does not restore acceptance. Missing behavior includes ownership transfer/invitation approval, local-only delete, archive/folders, contact upload, moderation case handling and retention/delete propagation.

## 7. Realtime behavior

- Endpoints: strict messaging `GET /v1/realtime` and additive IA-1 `GET /v2/realtime` with WebSocket upgrade.
- Browser `Origin` must match the exact allowlist; native clients may omit Origin.
- Server sends `hello`; authenticate within 5 seconds.
- Heartbeat interval 25 seconds; stale after 60 seconds.
- Max inbound frame 64 KiB; binary frames rejected; compression disabled.
- V2 uses HMAC-authenticated account/session-bound cursors with a seven-day logical TTL, max 500-event replay, deterministic `sync.required` reasons and an authoritative HTTP reset boundary; sequence values are sparse global watermarks, not adjacency promises.
- Stable reconciliation pages cover current chats/blocks plus per-chat members and canonical requests/messages/pins/topics/reactions/receipts, owner-only attachments and reporter-only safe report summaries. Numeric replay remains compatibility-only on V1.
- Pending activation queue max 1,000 events; projected socket buffered bytes max 1 MB. Overflow clears process memory, records a guard metric and closes `1013`; durable SQLite replay remains authoritative.
- A connection accepts at most 120 inbound frames per fixed 10 seconds. Typing is additionally limited to 8 frames per connection per fixed 5 seconds, throttled per chat to 800 ms and expires after 5 seconds.
- Per-process reconnect guards allow 16 pending unauthenticated sockets/canonical source IP, 60 authentication attempts/canonical source IP/minute shared across V1/V2, and 4 live sockets/device-session. Direct mode uses the socket peer; proxy mode accepts forwarding metadata only through explicit trusted source CIDRs. Slots are released on close.
- Presence is process-local and ephemeral; it is not a durable availability guarantee.

SQLite persists one authorized copy of each durable event per audience user. This simplifies correct replay in M0 and is not the final fan-out storage model.

IA-1 events have explicit `sender_account`, `recipient_account`, `participant_account` or `actor_account` audience contracts and are re-authorized against current request/relationship/block state at live or replay dispatch. Membership events use current `member_account` or terminal `removed_account`; stale chat events are filtered immediately after removal. Recipient devices receive a reason-free request-removal event; sender-visible dismissal, block-target and report-subject events do not exist. V1 connections skip these additive events.

## 8. HTTP hardening

- 1 MiB body limit and strict input schemas.
- Exact CORS allowlist; credentials disabled for current bearer design.
- Helmet headers; Swagger UI uses a static CSP.
- Global 300 requests/minute/canonical source-IP baseline; tighter per-route network buckets. HTTP and realtime share the same IPv4/IPv6 normalization and explicit trusted-proxy policy. The still-internal anonymous primary-login and pre-account-signup routes use a separate bounded key that keeps IPv4 exact and aggregates canonical IPv6 by `/64`, so rotating only the subscriber-controlled low 64 bits does not create fresh local capacity; signup begin/verify are locally capped at 5/10 per minute. IA-1 additionally uses bounded per-process account/device-session buckets for exact/contextual discovery, request creation, relationship mutations and reports.
- Sanitized public errors with request IDs and no stack/SQL response.
- Structured request logs retain method plus query-free path; completion logs retain request ID, status and duration. Headers, query, body and credentials are excluded by construction, with a local token/password/content/query canary test.

Users behind NAT/carrier NAT/privacy relays intentionally share coarse IP capacity; this can create availability false positives and is not replaced with a client-controlled key. The `/64` passkey bucket is only a local mitigation: public enablement still requires a distributed limiter, admission/backpressure, bounded intent retention and operational evidence. Known work also includes production ingress/direct-bypass evidence, shared multi-replica abuse/reconnect state, verified-device/risk signals, distributed-enumeration and production reconnect/load evidence, CSP for separately hosted Web app, canary proof across ingress/DB/traces/crash paths, and proxy request-smuggling/cache/SSRF review. The current client-IP boundary is documented in `docs/audits/CLIENT_IP_TRUST_BETA_0_1.md`; the executable endpoint/event authorization matrix is documented in `docs/audits/AUTHORIZATION_MATRIX_BETA_0_1.md`.

## 9. Operations

- `/health/live`: process liveness and canonical release label.
- `/health/ready`: SQLite query readiness.
- `/metrics`: uptime, authenticated socket count, HTTP totals, public error-code totals and local realtime guard rejections by bounded reason.
- `/openapi.json` and `/docs`: generated API contract.
- SIGINT/SIGTERM trigger graceful Fastify close, socket close and DB close.

Metrics intentionally omit user/chat/content labels. Missing operational metrics include duration histograms, durable send/dispatch/resume correctness and dependency saturation.

## 10. Local commands

```bash
npm --prefix packages/protocol ci
npm --prefix packages/protocol run build
npm --prefix services/api ci
npm --prefix services/api run test
npm --prefix services/api run dev
```

Container build context is repository root:

```bash
docker build -f services/api/Dockerfile -t luxora-api:beta-0.1 .
make s3-live-gate
```

Deployment/backup details: [DEPLOY.md](DEPLOY.md). Schema details: [DATABASE.md](DATABASE.md). Endpoint contract: [API.md](API.md).

## 11. Production evolution gates

Do not split into microservices before stable ownership and measured pressure. The expected progression is repository abstraction → production database and transactional outbox → stateless API replicas → dedicated realtime fan-out → object/media workers → Moderated search. Every migration needs mixed-version compatibility, backup/restore, load/failure evidence and rollback.

The backend remains the top priority until its protocol/security/realtime exit gates pass; client feature proliferation does not substitute for backend correctness.
