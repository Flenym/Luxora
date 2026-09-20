# Luxora API

**Релиз:** Beta-0.1  
**Владелец и разработчик:** Flenym  
**Protocol versions:** messaging realtime `1`; additive identity/access realtime `2`

## 1. Contract status

This is the implemented Cloud preview API. It transports server-readable content and is not E2EE. It includes the IA-1 identity safety boundary: privacy-filtered discovery, message requests, explicit acceptance, directed blocks and selected-evidence reports. The generated machine-readable contract is available from a running server at `/openapi.json`; Swagger UI is `/docs`.

Local base URL: `http://127.0.0.1:8080`. Public deployments must use HTTPS/WSS and exact allowed origins.

## 2. Common rules

- JSON request/response; body maximum 1 MiB.
- Authenticated HTTP uses `Authorization: Bearer <accessToken>`.
- IDs and `clientNonce` are UUIDs.
- Timestamps are ISO 8601 strings with timezone offset, emitted as UTC.
- Mutation schemas are strict; unknown fields fail validation.
- Pagination `limit` defaults to 30 and is capped at 100.
- Cursor is opaque, maximum 512 characters; clients never construct it.
- Message body trims outer whitespace, is non-empty and at most 10,000 Unicode code points.
- Access token default TTL is 900 seconds; use refresh endpoint, not long-lived access storage.

## 3. Error envelope

```json
{
  "error": {
    "code": "VALIDATION_FAILED",
    "message": "Request validation failed",
    "requestId": "request-correlation-id",
    "details": { "issues": [] }
  }
}
```

Stable public codes: `BAD_REQUEST`, `UNAUTHENTICATED`, `FORBIDDEN`, `NOT_FOUND`, `CONFLICT`, `RATE_LIMITED`, `VALIDATION_FAILED`, `INTERNAL_ERROR`, `SERVICE_UNAVAILABLE`.

Clients branch on `code`, not English `message`. Details are optional and must never be displayed as trusted HTML. `429` may include standard rate-limit headers; clients apply bounded exponential backoff with jitter.

## 4. Operations endpoints

| Method/path | Auth | Result |
| --- | --- | --- |
| `GET /health/live` | none | `{status:"ok", release:"Beta-0.1"}` |
| `GET /health/ready` | none | `200 ready` or `503 not_ready` |
| `GET /metrics` | optional configured bearer | Prometheus text format |
| `GET /v1/capabilities` | none | Versioned, account-free protocol/features/trust/runtime-limit contract |
| `GET /openapi.json` | none | Generated OpenAPI document |
| `GET /docs` | none | Swagger UI; production exposure is a deployment decision |

Health endpoints reveal no dependency credentials or internal stack.

### Operator administration (loopback, Beta-0.1 local preview)

Read-only projections behind a dedicated `ADMIN_TOKEN` bearer (minimum 32
characters). Without the token every `/v1/admin/*` route answers `503`; a
wrong token answers `401`. Responses are `private, no-store` and never carry
password material, digests, ciphertext blobs, bearer material or phone
numbers. Pagination uses opaque `limit`/`cursor` (cursor is a base64url
envelope; garbage input restarts from the head instead of failing).

| Method/path | Result |
| --- | --- |
| `GET /v1/admin/status` | `{migrationId,users,activeSessions,chatsByKind,messages,phoneIdentities,pendingOutbox,failedOutbox}` |
| `GET /v1/admin/users?limit=&cursor=` | `{items:[{id,username,displayName,phoneBound,phonePasswordEnabled,passwordAuthEnabled,activeSessions,chatCount,createdAt,lastSeenAt}],nextCursor}` |
| `GET /v1/admin/chats?limit=&cursor=` | `{items:[{id,kind,title,memberCount,messageCount,createdAt}],nextCursor}` |

The `apps/admin` console (port 4174) consumes exactly these three routes: a
server status board plus user and chat tables with «Ещё» page fetching.
Moderation, blocking and deletion operator actions are intentionally absent.

## 5. Authentication and sessions

### Provider-gated phone-first flow

Phone authentication is public at the HTTP boundary but disabled unless the
server has an active data-encryption key, an independent HMAC secret and a
delivery provider. `GET /v1/capabilities` reports the effective runtime truth
as `features.phoneAuthentication`; an enabled external configuration without
an injected provider fails startup instead of advertising a broken flow.

1. `POST /v1/auth/phone/challenges` (5/minute/IP plus a durable per-phone
   resend window) accepts strict
   `{countryCode,nationalNumber,deviceName,clientNonce}`. `countryCode` is the
   1–3 digit calling code without `+`; the server validates and normalizes the
   combined E.164 number. `201` returns
   `{challengeId,maskedPhone,expiresAt,retryAfterSeconds}` and never returns the
   code. Exact retry reuses the challenge/provider command; changed input under
   the same nonce conflicts.
2. `POST /v1/auth/phone/challenges/:challengeId/verify` (10/minute/IP) accepts
   `{code,deviceName,clientNonce}`. The six-digit code has bounded attempts and
   expiry. Account existence is read only after a correct code. An existing
   phone identity without an enabled secret password returns
   `{status:"authenticated",user,tokens}`. An account with that setting enabled
   returns `{status:"password_required",passwordToken,maskedPhone,expiresAt}`;
   a new number returns
   `{status:"profile_required",registrationToken,maskedPhone,expiresAt}`.
3. `POST /v1/auth/phone/password` (5/minute/IP) accepts the short-lived
   `{passwordToken,password,deviceName,clientNonce}` continuation. A correct
   password atomically creates the device session; distinct failures are
   durably bounded and lock the continuation grant. Exact retries recover the
   same encrypted response, while changed nonce reuse conflicts.
4. During the short registration window,
   `POST /v1/auth/phone/usernames/check` accepts
   `{registrationToken,username}` and returns
   `{username,available,suggestions}`. This read is 30/minute/IP and does not
   reserve the name.
5. `POST /v1/auth/phone/registrations` (5/minute/IP) accepts
   `{registrationToken,displayName,username,bio,deviceName,clientNonce}` and
   atomically creates the password-disabled account, verified phone binding,
   privacy defaults, device session and hash-only refresh record. `bio` may be
   empty. Exact committed retries recover the original encrypted token
   response; username and phone races cannot create a second account.
6. `POST /v1/auth/phone/recovery/start` (10/minute/IP) accepts
   `{passwordToken,clientNonce}` from a verified `password_required`
   continuation and opens exactly one durable recovery intent per account.
   `201` returns `{recoveryToken,maskedPhone,confirmAt,expiresAt}`. Completion
   is forbidden until `confirmAt`; a second concurrent start for the same
   account conflicts.
7. `POST /v1/auth/phone/recovery/complete` (5/minute/IP) accepts
   `{recoveryToken,password,deviceName,clientNonce}` where `password`
   (12–128 characters) is the replacement value. Only at/after `confirmAt` and
   before `expiresAt` does it atomically set the new phone-password hash,
   revoke every active session and push registration of the account, create
   the replacement device session and return the standard
   `{status:"authenticated",user,tokens}` envelope. Before `confirmAt` the
   server answers `403 PHONE_AUTH_RECOVERY_NOT_CONFIRMABLE` with a bounded
   `retryAfterSeconds`; consumed/expired intents return
   `401 PHONE_AUTH_RECOVERY_TOKEN_INVALID`.

The local development provider uses a configured six-digit code but never
logs or echoes it. Authenticated phone accounts can enable, change or disable
the optional post-OTP secret password through the self-scoped endpoints below;
changing or disabling an existing password requires the current value. A real
phone password uses a separate Argon2id hash/flag and never enables the legacy
username/password endpoint, so it cannot bypass the OTP step. A real SMS
provider remains an open release gate; recovery and binding work end-to-end
against the development provider and are covered by dedicated integration
suites. Profile avatars use the authenticated upload pipeline followed by the
owned server-processing command below; arbitrary external avatar URLs remain
outside the mutation contract.

### Authenticated phone binding for legacy (password) accounts

Accounts created through `POST /v1/auth/register` can attach one verified
phone number while authenticated. Binding never reveals whether a number is
already bound before the correct OTP: availability is decided only after
verification, and the final attach is atomic.

1. `POST /v1/me/phone/binding/challenges` (authenticated, 5/minute/IP) accepts
   `{countryCode,nationalNumber,deviceName,clientNonce}` and returns the same
   `{challengeId,maskedPhone,expiresAt,retryAfterSeconds}` envelope as login
   challenges with the same durable resend window. An account that already
   owns a phone identity receives `409`.
2. `POST /v1/auth/phone/challenges/:challengeId/verify` also serves binding
   challenges: a correct code returns
   `{status:"binding_verified",bindingToken,maskedPhone,expiresAt}`. Wrong
   codes consume the same bounded attempt budget and lock the challenge.
3. `POST /v1/me/phone/binding/complete` (authenticated, 5/minute/IP) accepts
   `{bindingToken,clientNonce}` and atomically inserts the phone identity for
   the authenticated account only when the number is still unbound; a taken
   number consumes the grant and returns `409`. Success returns
   `{phonePassword:{eligible,enabled}}`, after which phone login works for
   that number and the secret password can be enabled.

### `POST /v1/auth/register`

Rate baseline: 5/minute/IP.

```json
{
  "username": "alex_morgan",
  "displayName": "Alex Morgan",
  "password": "a-long-password-from-a-manager",
  "deviceName": "Alex’s iPhone"
}
```

Username: 3–32 ASCII letters/numbers/underscore, starts with letter. Password: 12–128 characters. `201` returns `{user, tokens}`. Duplicate normalized username returns `CONFLICT`.

### `POST /v1/auth/login`

Rate baseline: 10/minute/IP. Same identity/device fields; invalid account or password returns generic `UNAUTHENTICATED`. `200` returns `{user, tokens}`.

### Auth token response

```json
{
  "accessToken": "short-lived-jwt",
  "refreshToken": "opaque-single-use-value",
  "tokenType": "Bearer",
  "expiresIn": 900,
  "sessionId": "uuid"
}
```

The refresh token is shown only to the client. Never log it, place it in a URL or store it in browser `localStorage`.

### `POST /v1/auth/refresh`

```json
{ "refreshToken": "opaque-single-use-value" }
```

Returns `{tokens}`. The previous refresh token becomes used. Reusing it revokes the session and returns `UNAUTHENTICATED`; clients must erase the token family and require sign-in.

### Session endpoints

| Method/path | Result |
| --- | --- |
| `GET /v1/auth/sessions` | `{items:[{id,deviceName,createdAt,lastSeenAt,expiresAt,current}]}` |
| `DELETE /v1/auth/sessions/current` | `204`; current session revoked |
| `DELETE /v1/auth/sessions/:id` | `204`; target must belong to current user |
| `GET /v1/me` | `{user}` for current principal |
| `PATCH /v1/me` | Update one or both of `displayName` and `bio`; authenticated account only |
| `PUT /v1/me/avatar` | Bind `{attachmentId}` only after the owned image is decoded, metadata-stripped, centre-cropped and re-encoded as a server-verified 512×512 PNG derivative |
| `DELETE /v1/me/avatar` | Clear the current derivative and release it for orphan retention cleanup |
| `GET /v1/me/phone-password` | `{eligible,enabled}` for the current phone-bound account |
| `PUT /v1/me/phone-password` | Enable with `{password}` or change with `{password,currentPassword}` |
| `DELETE /v1/me/phone-password` | Disable with `{currentPassword}` and replace the stored hash with a new discarded-secret Argon2id placeholder |

Revocation closes an active matching realtime connection with close code `4001`.
It also revokes every active push registration bound to that session in the same
database transaction.

### Push registration foundation and notification preferences

`features.push` remains `false`: these endpoints persist safe client state, but
there is no configured APNs sender or delivery claim yet.

| Method/path | Result |
| --- | --- |
| `GET /v1/push/registrations/current` | `{registration}` for the current session, or `null`; the projection never includes the device token |
| `PUT /v1/push/registrations/current` | Upsert strict `{platform:"apns",environment:"development"|"production",token}`; the topic is server-fixed to `app.luxora.mobile` |
| `DELETE /v1/push/registrations/current` | Idempotent `204`; revokes only the current session registration |
| `GET /v1/notifications/settings` | Account defaults/current message, request, mention, sound, badge and preview policy |
| `PATCH /v1/notifications/settings` | Strict non-empty partial settings update; preview is `hidden`, `sender`, or explicit `full` |

The hexadecimal token transport is bounded but does not assume one permanent
Apple token byte length. Tokens are encrypted at rest and are never returned,
logged, placed in URLs or included in notification payloads. Account/session
transfer of the same token is atomic so logout/login on one device cannot leave
delivery attached to the previous account.

### Internal passkey seams — not public product routes

`@luxora/protocol` and `services/api` contain a strict internal implementation
for these authenticated endpoints:

| Method/path | Contract purpose |
| --- | --- |
| `POST /v1/auth/passkey-ceremonies/registration` | Begin `authenticator.add` registration |
| `POST /v1/auth/passkey-ceremonies/authentication` | Begin discoverable `session.step_up` for `operation:"authenticator.add"` |
| `POST /v1/auth/passkey-ceremonies/authenticator-revocation` | Begin discoverable UV step-up bound to one authenticator ID and exact revision |
| `POST /v1/auth/passkey-ceremonies/:ceremonyId/verify` | Verify the registration/authentication kind already fixed by the stored ceremony |
| `GET /v1/auth/authenticators` | List the active secret-free authenticator projection |
| `PATCH /v1/auth/authenticators/:authenticatorId` | Rename one authenticator under exact resource ETag and idempotency key |
| `DELETE /v1/auth/authenticators/:authenticatorId` | Consume the target-bound step-up and terminally revoke one authenticator |
| `POST /v1/auth/register/passkey/options` | Separately gated internal pre-account signup begin; strict username/display/device/nonces with server-owned candidate identity |
| `POST /v1/auth/register/passkey/verify` | Separately gated internal raw registration verification and atomic first-account/session creation |
| `POST /v1/auth/passkeys/authentication/options` | Begin identifier-free primary login; strict `{clientNonce,deliveryNonce}` body |
| `POST /v1/auth/passkeys/authentication/verify` | Verify the raw discoverable assertion and atomically create the session |

The authenticated ceremony family is registered only when the internal development/test flag
`PASSKEY_INTERNAL_ROUTES_ENABLED` is explicitly enabled. The default is off,
production configuration rejects enabling it, and
`GET /v1/capabilities` always returns `features.passkeys:false`. Therefore these
paths are not part of the public Beta-0.1 API.

The same internal non-production gate now composes the durable
authenticator-management transport. Its trusted projection is strict and
secret-free (`id`, encrypted-at-rest display label, `active|revoked`, revision,
strong self-bound ETag and lifecycle timestamps). Internal service operations
can list active rows, rename by exact revision/idempotency fingerprint and
revoke after a target/revision-bound one-time `authenticator.revoke` WebAuthn
step-up. The routes are physically absent by default, forbidden in production,
and appear in OpenAPI only when `PASSKEY_INTERNAL_ROUTES_ENABLED=true` in a
non-production process. Capability discovery remains `features.passkeys:false`
in every configuration, so clients must not treat this seam as product support.

The pre-account signup pair uses the independent
`PASSKEY_INTERNAL_SIGNUP_ROUTES_ENABLED=false` gate. Production categorically
rejects `true`; non-production startup requires an independent ≥32-byte
`PASSKEY_SIGNUP_AUTHORIZATION_SECRET`, the complete signup-only
`PASSKEY_SIGNUP_REFRESH_KEYS`/`ACTIVE_PASSKEY_SIGNUP_REFRESH_KEY_ID` pair, an
active data-encryption key and access-token TTL of at least 601 seconds. Partial
configuration fails before route/storage composition. The authorization root and
every current/retained signup-refresh root must be mutually unique and cannot
reuse JWT, primary-login refresh or data-encryption material. This flag does not enable
authenticated add-authenticator or primary-login routes, and their existing flag
does not enable signup. Even when internally reachable, signup remains absent
from public capability discovery.

The primary-login pair additionally requires
`PASSKEY_BOOTSTRAP_REFRESH_KEYS`, `ACTIVE_PASSKEY_BOOTSTRAP_REFRESH_KEY_ID`
and an active AES-256-GCM data-encryption key. A half-configured keyring or a
plaintext challenge repository fails closed; merely configuring keys never
enables routes without the internal flag.

The internal seam also requires a configured AES-256-GCM data-encryption
keyring. Its repository rejects passkey challenge, user-handle and credential
writes instead of falling back to plaintext storage.

The authenticated seam supports a user who already has a bound
discoverable credential: it performs `session.step_up` for the exact
account/session/device/operation and then atomically consumes that one-time
grant while binding an additional authenticator. A bearer session alone is
insufficient. The separate primary-login seam is username-free and account-free
until a maintained WebAuthn verifier authenticates the discoverable assertion;
its options never expose `allowCredentials`. The separate pre-account service
can prepare and verify the first authenticator without querying username or
credential availability at begin. Its transport is reachable only under the
complete non-production signup gate and does not itself enable authenticated
authenticator management, independent security notifications, account recovery
or a user-facing production flow. The authenticated internal flag controls its
own management transport independently.

Begin requests use `Idempotency-Key: <command UUID>` and a separate body
`clientNonce`. Registration accepts strict
`{clientNonce, stepUpCeremonyId}` and the separate exact header
`Step-Up-Authorization: Bearer <compact-JWT>`; authentication accepts strict
`{clientNonce, operation:"authenticator.add"}`. Authenticator-revoke begin uses
strict `{clientNonce,credentialRecordId,expectedRevision}`. Rename and revoke
require a self-bound `If-Match` authenticator ETag plus `Idempotency-Key`; final
revoke also requires `{authenticationCeremonyId}` and the exact
`Step-Up-Authorization` bearer returned by ceremony verification. The step-up token is capped at
4,096 bytes and the ceremony ID is an explicit durable binding, not a value
discovered by trusting unverified JWT claims. The server derives the
authenticated actor, exact origin and purpose target digest. Begin responses
return a versioned safe ceremony handle plus standards-compatible WebAuthn
options, use `Cache-Control: private, no-store`, and allow additive response
fields. Registration options require bounded `excludeCredentials` (normalized
to `[]` when empty); authentication options require `allowCredentials:[]` and
therefore a discoverable credential.

Verify uses canonical `If-Match: "<revision>"`, the command UUID in
`Idempotency-Key`, and `Content-Type: application/webauthn+json`. Its body is the
raw WebAuthn credential JSON object—not a wrapper. The internal HTTP boundary
retains and caps the exact accepted bytes at 65,536, derives byte length and
SHA-256 server-side, then applies the strict kind-specific schema before
maintained-library verification. Clients never submit a response digest or byte
length.

The internal signup begin transport additionally requires canonicalized
username plus NFC display/device names and a delivery nonce; duplicate or
missing `Idempotency-Key` and every query string fail before service execution.
Signup verify carries the signed bearer only in `Bootstrap-Authorization`, uses
the same exact raw-byte digest and revision headers, and returns authoritative
ETag plus `Cache-Control: no-store`. Its local anonymous route configuration is
five begins and ten verifies per minute per canonical source-IP bucket. This is
only executable transport evidence, not distributed abuse control or route
availability.

Primary login begin returns a purpose-bound `bootstrapAuthorization` bearer in
the response body. Verify carries that exact bearer only in
`Bootstrap-Authorization`, never inside the assertion JSON, and uses the same
raw-byte, idempotency and revision headers described above. Unknown credential,
user-handle/account mismatch and verifier rejection share the same generic
`UNAUTHENTICATED` response. Success updates authenticator telemetry, creates the
session plus hash-only initial refresh token in one SQLite transaction, and
returns the raw refresh token only in the no-store HTTP response. Exact
committed retries rederive the same first refresh/access pair within the bounded
recovery window; non-monotonic synced-authenticator counters are retained as a
risk signal and do not lock out the user. A bounded startup/periodic sweeper
transitions abandoned expired intents through the same writer-time/CAS terminal
commit, emits their event/outbox/receipt and deletes the challenge secret.

Pre-account signup uses a different issuer/audience/subject/token-use and HKDF
key namespace from primary login. Its signed authorization binds
`account.create`, intent, initial revision, candidate/challenge/policy digests,
delivery nonce, device name, refresh derivation key and exact issue/expiry/
recovery times before any durable token-derived lookup. Begin never performs a
user or credential availability query and always uses `excludeCredentials:[]`;
global username and credential uniqueness is decided only by the verified
writer transaction. Success creates the password-disabled account, privacy
defaults, first handle/credential, device session and hash-only refresh plus
access replay projection atomically. Raw authorization, delivery bearer,
WebAuthn JSON and raw access/refresh tokens are not accepted by Store mutations
or receipts. Exact committed retries can rederive the initial token pair only
inside the signed recovery window.

The signup-expiry reconciler runs at app startup and every ten minutes regardless
of signup route availability, then its shared maintenance timer is cleared on
app close. It samples one clock and processes bounded rows ordered by
expiry/intent ID. Deterministic command scope/fingerprint use only intent ID,
revision and expiry; immediate writer-time/revision CAS owns the transition, and
the same SQLite transaction persists event/outbox/receipt while deleting the
challenge. Exact receipt lookup reconciles restart or second-owner ambiguity.
Only explicit SQLite `BUSY`/`LOCKED` failures receive capped backoff.

Both fixed paths reject every non-empty query string so usernames, account IDs
or bearers cannot become accepted URL metadata. When two different authenticated
verify commands race at one revision, the loser receives `409 CONFLICT`, the
safe current ceremony state/revision and a matching authoritative `ETag`.

The transient begin options necessarily carry the one-time challenge and, for
registration, a random PII-free `user.id`; these values are never part of a
finish/error/authenticator projection. Registration verify success returns only
safe ceremony ID/kind/purpose/state/revision/expiry, `verified:true` and replay
status. Authentication verify success additionally requires
`stepUpAuthorization:{scheme:"Bearer",token,purpose:"authenticator.add",expiresAt}`.
It never returns credential ID, public key, challenge metadata, user handle,
sign counter or raw attestation/assertion. The token alone is not mutation
authority: registration authorization requires an exact
account/session/device/ceremony/purpose/target binding and an atomic
compare-and-consume of the durable SQLite grant in the same transaction as the
encrypted credential commit. Exact committed retries reconcile to the winning
receipt; token, grant or target substitution fails closed. Signature-only
acceptance or replay is forbidden.
Failures use generic reasons and the existing broad API error codes. The reason
vocabulary is `step_up_required`,
`assurance_insufficient`, `challenge_expired`, `ceremony_unavailable`,
`ceremony_conflict`, `verification_failed` or `temporarily_unavailable`; an
authorized conflict may additionally expose only state and revision. Begin
persists revision `1`, verify matches `"1"`, and successful consumption returns
revision `2`.

## 6. Users and chats

### Discovery and privacy

- `GET /v1/users/lookup?username=<exact>` performs authenticated, case-insensitive exact lookup and returns `{profile: PublicProfile|null}`. Hidden, blocked and absent accounts use the same null shape. `PublicProfile` has no presence, last-seen, session or contact-graph data.
- `GET /v1/users/search?q=<query>&limit=<n>&cursor=<opaque>` searches only accepted relationships and returns a no-presence projection; it is not a global directory.
- `GET /v1/search/chats?q=<query>&limit=<n>&cursor=<opaque>` substring-matches group/channel titles for current memberships only, ordered `updated_at` DESC with cursor pagination (`limit+1` pattern, garbage cursor `400`); `LIKE` wildcards are escaped so the match is literal, titles are plaintext so no blind index is involved, and matching is ASCII case-insensitive (`LIKE COLLATE NOCASE`) with full Unicode folding queued as a follow-up. Direct chats are excluded — DMs are found via people search.
- `GET /v1/privacy` returns `{settings}`. `PATCH /v1/privacy` accepts one or both of `usernameDiscoverable` and `messageRequests: "everyone"|"nobody"`.

Identity/discovery responses use `Cache-Control: no-store`. Exact/contextual lookup and abuse-sensitive request/block/report mutations have route network limits plus bounded in-process account and device-session buckets. The device-session key is the authenticated session ID, not device attestation, and these local buckets are not a shared multi-replica risk engine.

### Message requests, blocks and reports

| Method/path | Authorization/result |
| --- | --- |
| `POST /v1/message-requests` | Sender; one text up to 1,000 Unicode code points, no attachment, at most one inert HTTP(S) link |
| `GET /v1/message-requests?direction=incoming|outgoing` | Own privacy-filtered request projection |
| `POST /v1/message-requests/:id/accept` | Recipient only; CAS acceptance atomically creates/reactivates Direct and first message |
| `DELETE /v1/message-requests/:id` | Recipient-only quiet dismissal; no sender event or dismissal state |
| `PUT /v1/blocks/:accountId` | Directed block keyed by immutable account ID; syncs only to blocker devices |
| `DELETE /v1/blocks/:accountId` | Unblock; does not restore acceptance or notify target |
| `GET /v1/blocks` | Own block list with immutable encrypted-at-rest profile snapshots |
| `POST /v1/safety/reports` | Exact authorized selected-message evidence; optional explicit `alsoBlock` |
| `GET /v1/safety/reports` | Own paginated immutable summaries only; never evidence/comment/nonce/moderation internals |

Request creation collapses nonexistent, hidden-policy, blocked and unavailable targets to generic `FORBIDDEN` with `reason: relationship_unavailable`. Its sender-scoped `clientNonce`, and the reporter-scoped report `clientNonce`, are rechecked after an SQLite writer reservation: an identical retry returns the first canonical resource while changed reuse returns `CONFLICT`, including races between independent database connections. Before acceptance there is no Direct, typing, presence, receipt or call relationship. Report responses/realtime contain only a summary, never plaintext comment or evidence.

### `GET /v1/chats`

Returns authorized chats with role, member count, last message/activity and unread count.

### `GET /v1/chats/:id`

Returns `{chat}` for an authorized member. Non-members receive `FORBIDDEN`; the API does not rely on UUID secrecy.

### Per-account chat archive and mute preferences

`GET /v1/chats/:id/preferences` returns only the current member's
`{preferences:{archivedAt,mutedUntil}}`. `PATCH /v1/chats/:id/preferences`
accepts a strict non-empty subset:

```json
{ "archived": true, "mutedUntil": "2026-08-12T09:00:00.000Z" }
```

`archived:false` unarchives and `mutedUntil:null` unmutes. Archive time is
server-owned and repeating the same desired archive state preserves its first
timestamp. Independent partial updates use one column-selective SQLite write,
so changing mute does not reset archive and vice versa. The state belongs to
one membership/account; it never changes another member's view. Current
cross-device convergence uses the exact-account realtime preference event;
synchronized custom folders use the separate account-global contract below.

### Synchronized custom chat folders

All five routes are authenticated, account-scoped and `private, no-store`.
Mutation routes have the 60/minute IP bucket plus independent 40/minute account
and 30/minute device-session buckets, and accept strict JSON only:

| Method/path | Strict request | Success |
| --- | --- | --- |
| `GET /v1/chat-folders` | No body | `200 {items:[ChatFolder],stateRevision}` |
| `POST /v1/chat-folders` | `{title,rules,overrides,clientNonce}` | `201 {folder,stateRevision,replayed}` |
| `PUT /v1/chat-folders/order` | `{folderIds,expectedStateRevision,clientNonce}` | `200 {items,stateRevision,replayed}` |
| `PATCH /v1/chat-folders/:id` | `{expectedRevision,clientNonce}` plus at least one of `title`, `rules`, `overrides` | `200 {folder,stateRevision,replayed}` |
| `DELETE /v1/chat-folders/:id` | `{expectedRevision,clientNonce}` | `200 {folderId,stateRevision,replayed}` |

`ChatFolder` is
`{id,title,position,revision,rules,overrides,createdAt,updatedAt}`. A title is
1–48 Unicode code points. An account may have at most 10 custom folders.
`rules` is exactly
`{includeKinds,unreadOnly,excludeMuted,includeArchived}`;
`includeKinds` contains at most the three unique values `direct`, `group` and
`channel`. `overrides` contains at most 100 unique current-member chat IDs.
Each override is exactly `{chatId,mode,pinnedPosition}` where `mode` is
`include|exclude`; `pinnedPosition` is always present, nullable, unique when
non-null and limited to `0...99`. Only an `include` override may be pinned.
The server owns `position`: create appends a folder, PATCH does not accept
position, and reorder requires one non-empty, unique list containing the exact
current folder-ID set (maximum 10) plus the exact `expectedStateRevision` from
the client's last atomic folder snapshot.

`revision` is the positive optimistic revision of one folder;
`stateRevision` is the nonnegative account-wide folder-state revision. A stale
PATCH/DELETE revision, stale reorder state revision, reorder list that is no
longer the exact current folder set, folder-count overflow or changed reuse of
a nonce returns `409 CONFLICT`.
An unavailable/foreign override chat returns `400 BAD_REQUEST`; strict-shape
violations return `400 VALIDATION_FAILED`.
PATCH/DELETE of a missing or another account's folder uses the same generic
`404`. Missing/invalid authentication is `401` before validation or lookup.
Exceeding a mutation route's request bucket returns `429 RATE_LIMITED`.
The GET response reads folder rows, overrides and `stateRevision` from one
SQLite snapshot, so a concurrent writer cannot produce a hybrid projection.

Every mutation `clientNonce` is scoped to the actor account across create,
update, delete and reorder. Its operation and canonical normalized fingerprint
bind an update-immutable encrypted response receipt. An exact response-loss retry returns the
original response with `replayed:true`, without another mutation, state revision
or event; reuse for another operation/body conflicts. This guarantee lasts
exactly 86,400 seconds from the command clock. Capabilities advertise that TTL
and the maximum 64 active receipts per account. At capacity, a new nonce gets
`429` with `Retry-After` and structured retry details; exact active retries still
work. Expired rows are ignored immediately, deleted on nonce reuse, swept in
bounded batches on startup, every ten minutes and during folder commands. A
PATCH whose normalized
title/rules/overrides already equal current state and a reorder that repeats the
current order still store their replay receipt but preserve folder revisions and
`stateRevision`, and emit no event. Real create/PATCH/delete/reorder changes
advance `stateRevision` exactly once; changing a folder or its position advances
that folder's revision exactly once. Delete compacts the remaining positions;
only a surviving folder whose position changes advances its revision.

Removing an account from a chat atomically removes that chat's overrides from
all folders owned by the removed account. Every affected folder advances once,
the account folder state advances once for the whole membership command, and an
account-only folder update event is committed alongside the removal event.

### `POST /v1/chats`

Direct:

```json
{ "kind": "direct", "userId": "target-user-uuid" }
```

Group/channel:

```json
{
  "kind": "group",
  "title": "Launch room",
  "memberIds": ["member-user-uuid"]
}
```

`kind` is `direct`, `group` or `channel`; title max 120; at most 199 listed members plus creator. `201` returns `{chat}`. A non-self Direct requires an accepted, unblocked relationship; request acceptance creates it first. Recreating an active direct returns the existing direct. A group/channel creator may initially add only their own accepted, unblocked relationships; private block state between two other invitees is not exposed as an oracle.

### Group/channel membership

| Method/path | Authorization/result |
| --- | --- |
| `GET /v1/chats/:id/members` | Current member; returns `{items:[{membership,user}]}` in stable join order |
| `POST /v1/chats/:id/members` | Owner/admin adds an accepted, unblocked relationship; only owner may add an admin |
| `PATCH /v1/chats/:id/members/:userId` | Owner changes a non-owner role using `expectedRevision` |
| `DELETE /v1/chats/:id/members/:userId` | Owner removes non-owner; admin removes member; non-owner may leave |
| `POST /v1/chats/:id/invite-links` | Owner/admin mints a bearer link; `201` returns `{invite,token,replayed:false}` |
| `GET /v1/chats/:id/invite-links` | Owner/admin lists metadata-only `{items:[invite]}` (no token material) |
| `DELETE /v1/chats/:id/invite-links/:linkId` | Owner/admin revokes idempotently; returns `{invite,replayed}` |
| `POST /v1/invite-links/join` | Any authenticated account joins by bearer token; `201` returns joined/pending union |
| `GET /v1/chats/:id/join-requests` | Owner/admin lists `{items:[request]}` for one chat |
| `POST /v1/chats/:id/join-requests/:requestId/approve` | Owner/admin admits; returns `{request,membership,replayed}` |
| `POST /v1/chats/:id/join-requests/:requestId/deny` | Owner/admin rejects; returns `{request,membership:null,replayed}` |

Add body is strict `{userId,role:"admin"|"member",clientNonce}`. Role change is
strict `{role,expectedRevision,clientNonce}`; removal is strict
`{expectedRevision,clientNonce}`. Every result is
`{membership:{chatId,userId,role,revision,joinedAt,updatedAt},replayed}`. The
actor-scoped nonce has an immutable command receipt: exact response-loss retry
returns the same snapshot without a second event, while changed reuse conflicts.
Direct membership is immutable. A group/channel has one non-removable owner,
maximum 200 current members, and ownership transfer remains a separate unimplemented
ceremony. Removal commits before authorization is rechecked, so a racing message
from the removed account is rejected.

Invite creation is strict `{approvalRequired?,expiresInSeconds?,maxUses?,clientNonce}` (expiry at
most 90 days, at most 10000 uses). The raw 43-char token is returned exactly
once and stored as a SHA-256 digest only: a lost create response cannot be
replayed and answers `409` with `invite_token_shown_once` — rotate the link
instead. Join is strict `{token,clientNonce}` and answers a discriminated
union: `{outcome:"joined",membership,replayed}` for direct links or
`{outcome:"pending",request,replayed}` for approval links. Existing members get an
idempotent joined replay without consuming a use. Unknown tokens
are generic `404`; revoked/expired/exhausted links are `404` with a
`revoked`/`expired`/`exhausted` reason. Joining emits the same `chat.created`
plus `chat.member.changed(added)` events as a direct add and counts against the
200-member bound.

Approval links queue `{id,chatId,userId,inviteLinkId,state,decidedBy,createdAt,decidedAt}`
requests instead of admitting: `GET /v1/chats/:id/join-requests` lists them for
owner/admin, `POST .../approve` admits (consumes one use, emits membership events
plus `chat.join.request.changed` to the requester and admins) and `POST .../deny`
rejects. Decisions are idempotent by state and replay the current snapshot; a
dead link fails the approval with the link reason while the request stays pending.
Denied requesters may file a fresh request. Realtime fans `chat.join.request.changed`
(`member_account` audience) to current owner/admins on filing and to requester plus
admins on decision.

Ownership transfer is a two-step ceremony between the sole owner and one current
member: `POST /v1/chats/:id/ownership-transfers` with strict
`{targetUserId,clientNonce}` mints a 24-hour pending transfer (`201`
`{transfer,replayed}`); `POST .../:transferId/accept` by the designated
successor atomically swaps the roles (successor → owner, owner → admin) with
monotonic revision bumps; `POST .../:transferId/cancel` by the initiator aborts.
`GET /v1/chats/:id/ownership-transfers` shows the pending ceremony to managers
and the successor (`{transfer|null}`). Exactly one pending ceremony per chat;
reused nonces replay exactly; expired ceremonies 404 with `transfer_expired` and
stop blocking fresh ones. Accept/decision replays return the current snapshot.
Accept emits the transfer-changed event plus two `role_updated` membership events;
the DB trigger only permits owner-role writes while the live ceremony names both
sides, so every other owner mutation still aborts.

## 7. Messages

### `GET /v1/chats/:id/messages`

Authorized cursor page `{items, nextCursor}`. Current order is most-recent-first by canonical creation timestamp and ID in storage; clients must follow the returned contract and not reorder by local device time.

### `POST /v1/chats/:id/messages`

```json
{
  "kind": "text",
  "body": "Hello from a real client",
  "clientNonce": "client-generated-uuid",
  "replyToMessageId": null
}
```

`201` means server accepted under the current durability contract and returns `{message}`. Retrying the identical sender nonce returns the same canonical message. Reusing a nonce for different content/chat returns `CONFLICT`.

`201` alone means server accepted. A client may show “Delivered” only after an explicit recipient acknowledgement below, never from a timer or mere socket presence.

Media messages pass `attachmentIds` (owned, completed uploads) instead of/in addition to `body`, plus optional `transcriptionConsent: true` to let members attach a transcript to the voice note later. Consent without a `voice`/`audio` attachment is rejected with `400`; the fingerprint covers consent, so a reused nonce with different consent conflicts.

### `PUT /v1/messages/:messageId/transcript`

```json
{ "text": "User-provided transcript", "clientNonce": "client-generated-uuid" }
```

Any chat member may attach one transcript to a message that (a) is not deleted, (b) carries a `voice`/`audio` attachment and (c) was sent with `transcriptionConsent: true`. First writer wins: the same nonce replays the stored message, a different nonce or different text conflicts (`409`). Without consent or voice content the server answers `403 transcript_unavailable`. Transcripts are stored server-side and visible to chat members — Beta-0.1 is cloud preview without E2EE, and the client must disclose this before submitting. A successful attach emits `message.updated` so members converge.

### Scheduled messages (text-only Beta-0.1)

`POST /v1/chats/:id/scheduled` accepts `{body,clientNonce,replyToMessageId?,topicId?,sendAt}`. `sendAt` must be at least 60 seconds in the future and at most 365 days ahead; attachment payloads are rejected with `400` (attachments would outlive their orphan retention, so the Beta-0.1 contract is text-only). `201` returns `{scheduled}` with `state:"pending"`. `GET /v1/chats/:id/scheduled` lists the caller's pending/failed rows with opaque cursors; `DELETE /v1/scheduled/:id` cancels an own pending row (`204`, `404` otherwise).

A 30-second server dispatcher sends due rows through the exact live-send guards evaluated at send time (membership, relationship/privacy, channel posting permission, topic, reply target). Guard failures resolve to bounded `failureCode` values (`membership_lost`, `relationship_unavailable`, `posting_forbidden`, `topic_gone`, `reply_gone`, `chat_gone`, `dispatch_failed`) visible in the list. The scheduled `clientNonce` becomes the message nonce, so a crash between send and mark-sent replays instead of duplicating.

### `PATCH /v1/messages/:messageId`

```json
{ "body": "Corrected text", "expectedRevision": 0 }
```

Author only. Returns `{message}`. A stale expected revision returns `CONFLICT`. Clients retain the user’s draft and offer review/copy-as-new.

### `DELETE /v1/messages/:messageId`

Author or current owner/admin. Returns `{message}` with `body:null` and `deletedAt`. This is synchronized tombstone behavior, not a guarantee of immediate physical backup erasure.

### `POST /v1/chats/:id/read`

```json
{ "messageId": "uuid-in-the-same-chat" }
```

Returns `204` and publishes a durable `receipt.read` event only when the cursor advances. The store compares canonical message order so an older acknowledgement cannot move the cursor backward.

### `POST /v1/chats/:id/delivered`

```json
{ "messageId": "uuid-in-the-same-chat" }
```

Returns `204`. The first acknowledgement per recipient/message is persisted and publishes durable `receipt.delivered`; retries are idempotent. It means that recipient account/device flow explicitly acknowledged the message under the current contract, not that every recipient device stored or displayed it.

### Reactions

`PUT /v1/messages/:messageId/reactions` adds and `DELETE` removes:

```json
{ "emoji": "💜" }
```

Returns `{items:[{emoji,count,reactedByMe}]}`. Operation is idempotent for actor/message/emoji.

Authenticated reconciliation reads are `GET /v1/messages/:messageId/reactions` and
`GET /v1/messages/:messageId/receipts`. They require current chat membership,
return `no-store` canonical state and filter actors hidden by a current block.
`GET /v1/attachments` is a paginated owner-only attachment list; it never grants
items merely because the requester can access a message-derived download.
Completed image uploads carry server-measured `width`/`height` with
`metadataTrust:"server_verified"` (PNG/GIF/WebP/JPEG; a declared size that
disagrees with the bytes is rejected with `400`); unmeasurable formats
honestly keep `client_declared`. At upload-complete the server best-effort
generates a bounded JPEG thumbnail (320px long edge, quality 80, sharp) for
`kind:"image"` larger than 320px; undecodable (e.g. HEIC) or tiny images get
none and the upload still succeeds. Thumbnails are served at
`GET /v1/attachments/:id/thumbnail` under owner-or-granted authorization
(stranger `404`, anonymous `401`) with `no-store`, and storage keys are never
exposed (deterministic `thumbnails/{id}.jpg`). The attachment projection
carries optional `thumbnailPath`, and `ImageMetadata` carries optional strict
`thumbnail{sha256,sizeBytes,width,height}`; orphan cleanup deletes thumbnails
with the attachment. At upload-complete the server measures WAV duration for `audio`/`voice` with `audio/wav` and marks `server_verified`; other audio containers stay `client_declared`.

### Account data export

`POST /v1/data-exports` requests an on-demand export archive. It is
idempotent: repeated requests reuse the most recent `ready` export while it is
still valid and return `201` with the same record. A fresh export is built
asynchronously over an in-process queue; polling `GET /v1/data-exports/:id`
until `state` leaves `pending` is the delivery mechanism. A ready export
expires after 7 days; expired archives become `state:"expired"` and the next
request rebuilds them. Whole-account access is always bound to the current
bearer session and record ownership; a stranger's attempt returns `404`.

The response record is `{id,state,sizeBytes,sha256,createdAt,readyAt,expiresAt}`.
`GET /v1/data-exports/:id/download` downloads the artifact as
`application/gzip` with `Cache-Control: private, no-store`, an ETag equal to
the SHA-256, `Accept-Ranges: bytes` and byte-range `206` responses, so a large
archive can be resumed or hashed incrementally. The archive is a `.tar.gz`
containing `manifest.json` (per-file SHA-256 plus included/omitted categories)
and line-delimited JSON entries: `profile.jsonl`, `settings.jsonl`,
`sessions.jsonl`, `relationships.jsonl`, `blocks.jsonl`, `chats.jsonl`,
`messages.jsonl` and `media.jsonl`. Messages are exported as stored
(encrypted-at-rest) payloads. Owned attachment binaries are included as
`media/<attachmentId>/<fileName>` entries whose per-file SHA-256 lets the
client verify them against `media.jsonl`; missing or resized objects fail the
export rather than silently omitting data. JPEG thumbnails ship as
`media/<attachmentId>/thumbnail.jpg` entries with manifest SHA. Only token/secret material is
declared in the manifest under `omittedCategories`.

Ready exports expire 7 days after ready (`state:"expired"`); download of an
expired export answers `409`. A periodic worker deletes the storage object
within 24 hours, and a new request rebuilds the archive.

### Account deletion

`POST /v1/account/deletion` schedules account deletion for the current user.
A scheduled deletion enters a seven-day grace period (`state:"scheduled"` with
`scheduledAt` and `graceDeadlineAt`); while scheduled it can be cancelled with
`DELETE /v1/account/deletion`, which returns the account to `active`
(`state:"none"`, `canceledAt` set). Re-scheduling during grace reuses the
existing record (idempotent). The grace state machine is
`none → scheduled → deletion_pending → executing → completed | failed_retryable`
and is driven by a periodic worker.

At the deadline the worker freezes the account: it revokes every active device
session and push registration, tombstones the profile (`username` becomes a
reserved `deleted:<id>` value that cannot be looked up or searched, display name
becomes `Deleted Account`), expires data-export artifacts and marks owned
attachments deleted. The task state transitions
`scheduled → deletion_pending → executing → completed`; a task failure leaves a
retryable `failed_retryable` record with `lastError` and is re-attempted by the
next sweep. `GET /v1/account/deletion` returns the current record (or
`state:"none"` when nothing is scheduled). Whole-account access is always bound
to the current bearer session; a different account cannot read or cancel it
(`404` on cancel when none is scheduled).

### Security containment

`POST /v1/security/containment` (authenticated via `authGuard`, 10/minute) accepts strict `{scope:"session"|"all_other_sessions"|"account", sessionId?}` and returns `{scope, revokedSessionIds}`. `session` revokes one owned session (`sessionId` required, `400` when missing, `404` for a foreign/unknown session); `all_other_sessions` revokes every session except the current one, while `account` revokes all sessions including the current one, expires data-export artifacts and revokes push registrations. Realtime connections for revoked sessions are terminated best-effort. Missing/invalid authentication is `401` before validation; `recovery_takeover` is explicitly not accepted yet, and authenticator suspension plus a security epoch remain the documented remainder. No migration; covered by `containment.integration` 3/3, both typechecks clean, matrix 117→118.

### Calls (signaling slices 1–7)

First-slice call signaling persists in migration `038_call_control_records` (`calls`, `call_events`, `call_outbox`, `call_command_receipts`, `call_creation_receipts`) through a new `CallService` wrapping the audited `@luxora/call-control` `CallControlExecutor` with a SQLite adapter (atomic commit, CAS plus idempotency receipts). `POST /v1/calls` creates a call (`201`) in direct chats (`one_to_one`) and, since the second slice, group chats (`group`); `GET /v1/calls/:id` is participant-only (stranger `404`), `POST /v1/calls/:id/cancel` is host-only and `POST /v1/calls/:id/hangup` ends for self/everyone, with the participant actor device always taken from the current session. Invitees are members with a live session; unreachable members are listed in `unreachableMemberIds` (`409` when nobody is reachable, `403` when the caller is blocked with any member). Retrying the same `clientNonce` returns the same `callId` with `replayed:true` instead of creating a second call. `409` also covers a stale `expectedRevision` (the response carries the current snapshot). The second slice adds the pre-connect flow: host-only `POST /v1/calls/:id/ring` advances `created → inviting → ringing` (a re-ring on an already-ringing call convergently returns it), invitee `POST /v1/calls/:id/accept` moves to `connecting`, and `POST /v1/calls/:id/decline` (`declined`|`busy`) ends a 1:1 call while a group call keeps ringing for the rest. Calls reaching `ending` are finalized to `ended` server-side immediately, while media-plane confirmation arrives later with webhooks. Projections never expose `roomName`/device/session internals and `GET /v1/capabilities` keeps `calls:false`. Slice 3 adds host-only `POST /v1/calls/:id/invite` with strict `{expectedRevision, inviteeMemberId}` (`InviteCallParticipantRequestSchema`) returning `201`; it is group-only (1:1 fixed membership returns `409`), requires the invitee to be a current chat member (`404` otherwise) and unblocked with the inviter (`403`), and binds the invitee device to the latest live session (`409` when none, `409` on duplicate device). The auth matrix grows 108→109 protected routes. Slice 4 adds `POST /v1/calls/:id/join-grant` with strict `{requestedSources}` returning a LiveKit SFU HS256 JWT (120s, roomJoin-only, publish limited to requested∩allowed∩consented, audio-call microphone-only) plus coturn REST credentials (username `expiry:identity.tokenId`, base64 HMAC-SHA1, 300s) and `serverUrl`. Issuance rechecks membership/relationship/block/session/epoch on every call and requires an accepted (`connecting`+) participant on a `connecting`+ call (stranger `404`, ended/pre-accept `403`, audio+camera `403`). The route answers `503` until `CALLS_LIVEKIT_URL`/`API_KEY`/`API_SECRET` plus `CALLS_TURN_SHARED_SECRET`/`URLS` are all configured with independent key material, and secrets never appear in responses or logs while `GET /v1/capabilities` keeps `calls:false`. Push/ringing delivery, membership_removed hook and grant refresh are explicitly not yet implemented and come next. Slice 5 adds `POST /v1/internal/calls/livekit-webhook` without bearer auth: LiveKit JWT signature auth over the raw body bytes (`application/webhook+json` raw-bytes parser, SHA-256-of-raw-body claim, 5-minute clock tolerance, issuer must equal the configured API key; forged/expired/malformed → `401`). Dispatch runs as the system media-plane actor with migration `039_call_room_index` (`call_rooms` + snapshot backfill): `participant_joined` → `mark_active` (convergent skip when already active), `participant_left`/`connection_aborted` → `connection_lost` when eligible, `room_finished` → `end_call(completed)` + `finish_ending`, with a single retry on revision conflict and deterministic command IDs for replay convergence. Unknown rooms/participants/events and inapplicable states are acknowledged `200 {received:true}` without oracle or poison retries, and the webhook only confirms media-plane facts — it cannot grant authorization. Slice 6 adds the membership-removal hook with no new routes (matrix stays 111) and no migration (reads existing snapshots): `ChatService.removeMember` fires optional `onMemberRemoved(chatId, memberId)` after commit (replay path excluded), wired in `app.ts` to `CallService.reconcileMembership` fire-and-forget with error log, which issues `membership_removed` as system `membership-service` for every non-terminal membership of the removed member across live (non-ended) calls in that chat via new store `listLiveCallsForChat` (`json_extract` state filter), with epoch bump, revoked status, host-removal `ending→ended` finalization, already-terminal skipped and failures counted. Session revoke needs no hook (grant issuance rechecks liveness, in-flight tokens expire ≤120s) and block is not membership removal (grants already denied via block policy). Tests: `calls-signaling.integration` 8/8 (new reconcile test: revoke + epoch 2, removed grant `403`, survivor grant `200`), API typecheck clean, full suite not yet run; honest remainder is push/ringing delivery (real APNs blocked externally), grant refresh, crash-cleanup sweeper, then search. Slice 7 adds the stale-reconnecting sweeper with no new routes (matrix stays 111) and no migration: `CallService.sweepStaleReconnecting(now, timeoutMs>=60s, limit=100)` ends calls stuck with a reconnecting participant past the `updated_at` watermark via `end_call(network-timeout)` + `finish_ending` as system media-plane, using store `listStaleReconnectingCalls(beforeIso, limit)` (`json_extract`/`json_each`, non-ended + reconnecting + watermark) wired into the existing 10-minute `cleanupTimer` (10-minute timeout), idempotent with races converging by reload (domain errors skipped, infra errors counted; calls exposed on `app.luxora` for tests). Tests: new `calls-reconnect-sweeper.integration` 1/1 (stuck→ended/network-timeout, fresh untouched, resweep no-op), API typecheck clean, full suite not yet run; honest remainder is push/ringing delivery (real APNs blocked externally), then search (grant refresh covered by stateless re-issuance).

New `GET /v1/calls?chatId=` returns `{calls: CallResponse[]}` ordered `updated_at` DESC (max 50, including ended calls for missed-call history) as polling discovery until push delivery lands. Missing `chatId` answers `400`, while unknown chats and non-members share one `404` with no oracle.

### Device linking (slices 1–4)

First-slice challenge lifecycle persists in migration `040_device_link_challenges` (`device_link_challenges` + `idx_device_link_expiry`) via `DeviceLinkService`: `POST /v1/device-links/challenges` is PUBLIC and bearer-free (10/min) returning `linkId` plus a 256-bit `linkSecret` shown once, `expiresAt` (+120s) and `pollIntervalMs` 2000, while `POST .../:id/poll` accepts optional `{linkSecret?}` with secret-first checks (unknown id or wrong/missing secret → identical `401`, no oracle; lazy pending→expired) and a 2s minimum interval (early poll → `429` with retry-after header via AppError details, terminal states skip throttle), and `POST .../:id/close` convergently moves pending→closed. The server stores only the SHA-256 digest (`luxora-device-link-v1` domain), never logs or stores the secret, and polling reveals no account data. Creation is in the PUBLIC list and poll+close are PROTECTED (secretless probes `401` with no side effects, matrix 112→114). A startup + 10-minute sweeper expires pending rows and purges terminal rows older than 24h; approval (step-up+SAS) and grant redemption/session issuance are explicitly not in this slice. Slice 2 adds `POST /v1/device-links/challenges/:id/approve|deny` (bearer approver + linkSecret; pending→approved records `approved_by_account_id` via migration `041_device_link_approval` / pending→denied; non-pending → `409` with current challenge, expired lazy-expires then `409`, unknown/wrong secret → identical `401`; matrix 114→116). Slice 2b requires password step-up on approve: `POST .../:id/approve` accepts `{linkSecret?, password}` via `DeviceLinkApproveRequestSchema` (missing password → `400`, wrong password → `403`); the service verifies the password against the approver's hash with dummy-timing guard + `passwordAuthEnabled` + live-session check, then CAS-decides; deny is unchanged (bearer + secret, no password). SAS is 4 words from a 256-word list derived via `sha256(luxora-device-link-sas-v1:secretHash:approverId)`, now derived from the COMMITTED record so the approve response and target poll always match, with the approver id NEVER exposed to the target. HONESTY LIMIT: knowledge-factor (NOT phishing-resistant) step-up, transaction-bound (linkId+approver+session verified before CAS); passkey-ceremony step-up is now implemented as the slice-4 alternative below. Slice 3 adds grant redemption in migration `042_device_link_redemption` (`proof_public_key_jwk` + `redeemed_session_id`): create accepts an optional strict Ed25519 `proofPublicKey` JWK, and `POST /v1/device-links/challenges/:id/redeem {linkSecret?, proofSignature?}` returns `201 {tokens}` only for approved challenges (others `409`, legacy keyless challenges honestly unredeemable `409`) via single-use CAS `approved→consumed`, where possession proof (Ed25519 over `luxora-device-link-redeem-v1:{linkId}`), NOT the secret, authorizes so a relayed QR alone cannot complete (forged `403`, replay `409`), with the session minted via `TokenSecurity` + `store.createSession` (sign-before-write, `deviceName` = `targetLabel`). Redemption fans `sync.invalidated session_list_changed` to all existing sessions (new protocol enum + Swift case; consumer ignores reason and triggers reconcile), never logs secrets/keys, matrix `116→117`. Slice 4 adds the passkey-ceremony step-up alternative in migration `043_device_link_step_up` (`device_link_step_up_intents` + `device_link_step_up_grants`): `beginStepUp` now accepts `operation:"device-link.approve"` + `linkId` with `targetDigest` binding account/session/linkId (unknown link to `404`, non-pending to `409`); consumed ceremonies route to device-link grants while the generic `authenticator.add` path is untouched, and `verify()` issues a JWT with purpose `device-link.approve` (`StepUpTokenPurpose` + `PasskeyStepUpOperationSchema` extended). Approval now accepts password XOR ceremony pair (schema-refined): the ceremony path verifies the JWT plus grant-row bindings (link/account/session/device/digest/TTL/session-live) then CAS-decides, and replay convergently returns `409` with the current challenge. Matrix unchanged (no new routes). Local evidence: `device-link-stepup.test` 2/2 (real ceremony via seam adapter: issuance + binding + negatives), `device-links.integration` 8/8 (HTTP consumption incl. replay/wrong-purpose/no-grant), API typecheck clean, protocol 17/104 + typecheck/build clean; full API 100/736. Honest remainder: Private-history bootstrap, then contact discovery explicitly WITHOUT upload (spec-LATER), final QA. E2E grant encryption is a recorded N/A (§10.3: relay threat covered by proof possession + TLS).

## 8. Core response shapes

`User`: `id`, `username`, `displayName`, `bio`, legacy nullable `avatarUrl`, authenticated nullable `avatarPath`, `createdAt`, optional presence/lastSeen.

`Chat`: `id`, `kind`, `title`, nullable `avatarUrl`, `role`, `memberCount`, nullable `lastMessage`, `lastActivityAt`, `createdAt`, `unreadCount`, nullable account-scoped `archivedAt` and `mutedUntil`.
`Message`: `id`, `chatId`, sender object, `kind:"text"`, nullable `body`, nullable `replyToMessageId`, `clientNonce`, nonnegative `revision`, create/update/edit/delete timestamps.

Clients tolerate and ignore additive response fields but send only fields accepted by the current strict mutation schema. Versioned golden fixtures exercise preferred realtime v2, supported one-version-back realtime v1, capability schema v1 and required-upgrade behavior.

## 9. WebSocket realtime

URLs: legacy messaging `/v1/realtime` and current scoped recovery `/v2/realtime`; use WSS outside local development. Access tokens are sent in an authentication frame, never query string. The complete implemented contract is in `docs/specs/REALTIME_SYNC.md`.

### Handshake

Server:

```json
{
  "type": "hello",
  "protocolVersion": 2,
  "connectionId": "uuid",
  "heartbeatIntervalMs": 25000
}
```

Client within five seconds:

```json
{
  "type": "authenticate",
  "accessToken": "short-lived-jwt",
  "resumeCursor": "luxora-rt1.opaque.authenticated"
}
```

Server:

```json
{
  "type": "ready",
  "userId": "uuid",
  "sessionId": "uuid",
  "sequence": 123,
  "headSequence": 130,
  "cursor": "luxora-rt1.opaque.authenticated",
  "resumed": true,
  "resumeMode": "scoped_cursor",
  "retention": { "maxReplayEvents": 500, "cursorTtlSeconds": 604800 }
}
```

`sequence` is a sparse global watermark, not a client-derived cursor and not an adjacency promise. V2 dispatch carries an opaque account/session-bound cursor; after replay the server emits `sync.checkpoint`. The client persists a dispatch/checkpoint cursor only after all preceding state was applied idempotently.

Malformed, foreign-session, expired, future or overflowed v2 cursors never downgrade to numeric replay. The server sends a reason-specific recovery frame and closes with code `4009` before durable dispatch:

```json
{
  "type": "sync.required",
  "reason": "replay_window_exceeded",
  "headSequence": 130,
  "recovery": { "type": "http_snapshot", "path": "/v2/sync/snapshot" }
}
```

`GET /v2/sync/snapshot` returns a no-content signed boundary plus authenticated canonical reset paths. Rebuild resources include stable-order chat/block pages, per-chat members, requests, messages, pins/topics, reactions/receipts, owner-only attachments and reporter-only safety summaries. The client exhausts them, then reconnects with the boundary cursor; it never silently skips. Numeric `resumeFrom` remains compatibility-only on `/v1/realtime`.

### Durable dispatch

```json
{
  "type": "dispatch",
  "sequence": 124,
  "cursor": "luxora-rt1.opaque.authenticated",
  "event": { "type": "message.created", "message": {} }
}
```

Durable v1 event types: `chat.created`, `message.created|updated|deleted`, `attachment.stored`, `message.pinned|unpinned`, `topic.created|updated`, `receipt.delivered|read`, `reaction.updated`.

V2 additionally receives `chat.member.changed`, `chat.preferences.updated` and
`chat.folders.updated`. Current members receive the membership
`member_account` projection for add/role/remove. The removed account receives a
single `removed_account` removal projection after the membership row is gone;
older chat-scoped queued/replayed events fail current-membership authorization.
A preference event is written only when the confirmed archive/mute value changes,
is bound to the exact account in both its encrypted durable payload and outbox
audience, and is re-authorized against current membership before live/replay
delivery. Another member of the same chat cannot receive it. V1 skips these
additive events and must reconcile. Folder state changes use the strict
account-global event
`{type:"chat.folders.updated",audience:"actor_account",accountId,stateRevision,changedAt}`.
Its durable row/outbox audience is the same account, and the hub checks exact
`accountId` equality for both live and replay delivery; another account cannot
receive it. Semantic no-ops emit no folder event.

### Ephemeral frames

Client: `heartbeat`, `typing.start`, `typing.stop`, `receipt.delivered`, `receipt.read`.  
Server: `heartbeat`, `heartbeat.ack`, `typing.updated`, `presence.updated`, `error`.

Typing auto-expires and is not durable. Presence means an authenticated connection is currently known by this process and is approximate. Accepted-relationship and either-direction block checks gate peer presence and direct typing; shared-group typing excludes blocked counterpart audiences.

The local gateway bounds each connection to 120 inbound frames per fixed 10
seconds and typing to 8 commands per fixed 5 seconds before the existing 800 ms
per-chat throttle. V1/V2 share a process-local 60 authentication-attempt/IP/minute
bucket; at most 16 unauthenticated sockets/IP and 4 live sockets/device-session
are retained. These are availability controls, not a distributed risk engine.

### Close/recovery rules

- `4001`: authentication/session expired or revoked — refresh/sign in as appropriate, never loop blindly.
- `1008`: origin/policy violation or inbound frame-rate cutoff — do not hot-loop; a rate cutoff requires bounded backoff.
- `1013`: slow consumer/backpressure or a temporary pending/auth/session connection bound — reconnect with jitter and the last applied cursor; server may require full sync.
- Network loss: exponential backoff with jitter, one active reconnect attempt, preserve outbox.

## 10. Compatibility and missing capabilities

`/v1/realtime` remains the strict messaging stream and skips additive identity/membership/preference/folder durable events. `/v2/realtime` is additive and accepts messaging plus `chat.member.changed`, `chat.preferences.updated`, `chat.folders.updated`, `relationship.request.created|removed|accepted|expired`, `relationship.block.changed`, and `safety.report.submitted`; explicit audience fields are enforced by server routing and re-authorized against current state before live/replay dispatch. Request removal is recipient-account-only and carries no dismissal reason. Sender-visible dismissal, block-target and report-subject events intentionally do not exist.

Current Docker Node 22 evidence: shared protocol 17 files / 104 tests; folder
API, storage and independent-writer race suites 3 files / 22 tests; full merged
API 86 files / 685 tests; and HTTP/realtime authorization matrices 2 files / 16
tests. The final expiry-purge query-plan check additionally passes 7/7 after the
full run and proves both paths use their declared indexes without a temporary
B-tree. The matrices inventory 100 protected HTTP routes, 87 explicit source
routes and 23 durable realtime audience branches.

`GET /v1/capabilities` is the canonical public discovery contract. It needs no
bearer token, ignores an invalid bearer, and returns `Cache-Control: no-store`
plus `Pragma: no-cache` without marking the response private. Schema version 1
publishes the supported/preferred/minimum protocol versions, IA contract version,
current cloud-preview trust posture, implemented feature flags and exact server
limits for messages, pages, realtime replay and uploads. Runtime attachment,
quota, chunk and upload-session limits come from the active server configuration;
`features.serverSearchConfigured` reflects the actual active search keyring.
Clients validate the known schema, ignore additive response fields, and require
an upgrade for an incompatible security-critical contract instead of guessing
or downgrading below the advertised minimum. It does not claim a minimum client
build or an unproved security posture.
The golden response is `packages/protocol/fixtures/capabilities/v1/current.json`.

Public passkeys/WebAuthn, passkey signup/signin/bootstrap/management, recovery,
user-facing step-up, QR device linking, contact upload, account delete/retention
workers, push, full moderation workflow, calls and E2EE remain explicitly
`false` or absent. Account data export and the account-deletion state machine
are now exposed as plain authenticated HTTP routes without a capabilities flag
or a worker-backed queue. The default-off, non-production internal passkey and
authenticator-management seams do not change that public contract. First-request media, link fetching/previews and malware
scanning remain disabled; URLs are only syntax-validated and rendered inert.
Creating similarly named local UI does not extend this API.
