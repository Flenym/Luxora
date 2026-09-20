# Luxora — Identity & Access Platform

**Канонический публичный релиз:** Beta-0.1  
**Разработчик и владелец:** Flenym  
**Статус документа:** canonical server design; current implementation и обязательный target разделены явно  
**Дата проверки источников:** 3 августа 2026  
**Связанные документы:** [Product Requirements](PRODUCT_REQUIREMENTS.md), [Threat Model](THREAT_MODEL.md), [UX Flows](UX_FLOWS.md), [Release Quality Gates](RELEASE_QUALITY_GATES.md), [API](../../API.md), [Database](../../DATABASE.md)

## 1. Назначение и язык статусов

Этот документ определяет единый серверный contract для identity, authentication, sessions, trusted-device linking, recovery, message-request safety boundary, discovery, export и account deletion. Он не объявляет отсутствующие функции готовыми.

Используются три статуса:

- **CURRENT** — код существует в runnable backend и подтверждён чтением implementation/tests.
- **TARGET** — обязателен до завершения серверной фазы и до перехода от тонкого iPhone integration harness к полной разработке iPhone-приложения.
- **LATER** — намеренно не входит в текущий server-completion gate; требует отдельного design/audit.

Внутренние номера HTTP, realtime и data-schema contracts не являются названиями релизов. Единственная публичная версия продукта — **Beta-0.1**.

## 2. Канонические решения

1. Account identity — immutable случайный `accountId`; username, display name, email, phone и device label не являются identity keys.
2. **Authenticator**, **session** и **device endpoint** — разные сущности. Synced passkey может работать на нескольких устройствах; она не доказывает, что вход выполнен с одного конкретного физического устройства.
3. CURRENT password login сохраняется на время миграции. TARGET предпочитает passkey-first и поддерживает несколько authenticators без принудительного удаления password fallback до доказанного recovery coverage.
4. Passkey private keys, device proof private keys, recovery secrets и refresh tokens никогда не передаются другим устройствам через Luxora server.
5. QR не содержит access/refresh token, account ID, username или готовую сессию. Он содержит только короткоживущий binding transcript; выдача сессии требует approval и proof of possession target key.
6. Любое добавление authenticator, recovery и destructive account mutation требует recent step-up. Push approval или знание username само по себе не является step-up.
7. Неизвестный отправитель создаёт message request, а не полноценный Direct. До accept отсутствуют read receipt, precise presence и calls.
8. Block привязан к immutable account ID, синхронизируется между устройствами и не создаёт явного oracle «вас заблокировали» для второй стороны.
9. Exact username lookup — осознанная публичная disclosure только в пределах privacy setting. Login/recovery/authenticator endpoints не раскрывают существование аккаунта.
10. Export и deletion — серверные jobs с step-up, idempotency, audit и проверяемой propagation policy; UI-only удаление недопустимо.
11. Security-sensitive state меняется транзакционно и публикуется в durable realtime только после commit.
12. Ни одна identity/access функция не расширяет E2EE claim: CURRENT content остаётся server-readable; Private E2EE identity/key design определяется отдельно.

## 3. Что реально существует сейчас

### 3.1. CURRENT authentication

- `POST /v1/auth/register`: username, display name, password, untrusted-display `deviceName`.
- `POST /v1/auth/login`: generic invalid username/password response.
- Username uniqueness использует lowercase ASCII normalization и unique constraint.
- Password: protocol currently accepts 12–128 JavaScript string units; Argon2id `m=65536 KiB`, `t=3`, `p=1`, output 32 bytes.
- Missing-account login выполняет Argon2 dummy-hash verification для уменьшения простого timing oracle.
- Access token: HS256 JWT, default TTL 900 seconds, strict `alg`, `iss`, `aud`, `sub`, `sid`, `jti`, `exp`, `token_use=access` verification.
- Refresh token: `luxr_` + 32 random bytes; database stores SHA-256 hash only; default absolute session lifetime 30 days.
- Refresh rotation atomically consumes previous token and inserts replacement. Reuse revokes the associated session and closes its realtime connections.

### 3.2. CURRENT session surface

- `GET /v1/auth/sessions` lists account-owned sessions.
- `DELETE /v1/auth/sessions/current` revokes current session.
- `DELETE /v1/auth/sessions/:id` revokes another owned session.
- Guarded HTTP checks token signature and active session state.
- Realtime checks active session during authentication and heartbeats; revocation closes matching sockets with code `4001`.
- Session list contains client-supplied `deviceName`, created/last-seen/expiry and current marker. It does not yet contain verified platform/build, coarse region, authenticator provenance or risk state.

### 3.3. CURRENT discovery and relationship boundary

- `GET /v1/users/lookup` performs exact case-insensitive lookup after privacy and either-direction block filtering and returns only `PublicProfile | null`.
- `GET /v1/users/search` is contextual: only accepted relationships are searched and presence/last-seen are excluded.
- Per-account privacy settings control exact username discovery and whether requests are accepted from otherwise eligible accounts.
- An unknown sender can create one bounded safe-text request; only the recipient may accept or quietly dismiss it. Accept atomically creates/reactivates the Direct, first message, relationship and audience-specific durable events.
- Directed blocks remove accepted relationship state and prevent Direct creation/mutations, requests, peer presence, typing and receipts in either direction. Block/unblock events sync only to the actor account; unblock is not acceptance.
- New group/channel creation may add only accounts with an accepted, unblocked creator relationship; it does not reveal block state between two other invitees.
- Safety reports re-authorize and snapshot only explicitly selected messages. Optional `alsoBlock` is independent; response/realtime contains no comment or evidence plaintext.
- Request content/link/profile snapshots, block profile snapshots, report evidence/comment and durable event payloads use the configured application encryption envelope. Identity audit rows are append-only at the SQLite boundary.
- Exact/contextual discovery and abuse-sensitive request/block/report mutations supplement route network limits with bounded in-process account and authenticated device-session fixed-window buckets. A session ID is not verified device identity; replica-shared anomaly/risk control remains absent.
- Message-request and safety-report nonce checks acquire an SQLite immediate writer reservation and recheck the operation fingerprint before side effects. Independent-connection races return the first canonical resource for an identical fingerprint and `CONFLICT` for changed reuse.
- Ordinary API request logs contain method and query-free path only; completion retains request ID, status and duration. A local canary covers query/password/token/content exclusion, not the ingress/DB/trace/crash pipeline.
- First-request media, link fetching/preview, staff moderation case workflow, contact upload and calls remain absent.

### 3.4. CURRENT gated passkey and lifecycle seams

Internal authenticated add-authenticator, identifier-free primary sign-in and
pre-account first-passkey signup seams exist. They combine the audited ceremony
domain, strict raw-byte HTTP parsing, pinned `@simplewebauthn/server`, encrypted
SQLite challenge/user-handle/credential state, separated authorization/refresh
key domains, atomic account/session/credential commits and bounded exact replay.
Their flags default off, production rejects enabling them and
`GET /v1/capabilities` remains `features.passkeys:false`; none is a public
authentication feature.

Migrations `014`–`016`, strict protocol schemas and an internal service add a durable
authenticator-management foundation with default-off non-production HTTP composition. It provides an
active-only secret-free list, encrypted Russian-capable labels, revision/ETag
rename, and target/revision-bound one-time revoke. Revoke terminally excludes
the credential from verification, atomically revokes known originating sessions
and refresh rows, and rejects removal of the last active authenticator on a
password-disabled account. Audit/outbox payloads are secret-free and append-only;
idempotency results are encrypted. Independent SQLite writers cover rename,
revoke and last-factor races.

Public signup/sign-in and authenticator-management routes/UX, independent security
notifications and production operations/interoperability evidence remain
absent. Verified recovery channels, recovery codes, QR device linking, device
proof keys, account-wide containment, data export, account deletion and
retention workers are also absent. They must never be advertised as working.

## 4. CURRENT gaps that block the target

| Gap | Risk | Required resolution |
| --- | --- | --- |
| Password minimum is 12 | Current NIST guidance requires at least 15 characters for a password used as a single factor | New passwords move to 15; existing shorter values remain usable during a measured migration and receive upgrade guidance |
| Password length uses JS string units | Cross-client ambiguity and Unicode edge cases | Contract counts Unicode code points, never trims/normalizes/truncates password, and enforces a byte ceiling after UTF-8 encoding |
| Bearer access/refresh credentials | Offline token theft can be replayed | Retain rotation now; add per-session proof key and sender-constrained native-token profile after interop evidence |
| Client-provided device label looks authoritative | Social-engineering/misattribution | Store label separately from server-derived platform/build/signing identity and coarse region |
| Contact upload absent | Naive identifier hashes are enumerable | Keep absent until a dedicated private-discovery design and abuse/deletion evidence pass |
| Shared-group block rendering remains client policy | A blocked account’s shared-group content may still be delivered under membership | Implement/test explicit per-client hide policy without weakening group audit/moderation semantics |
| Exact lookup distributed risk control is incomplete | CURRENT local account and device-session buckets do not share state across API replicas and a session is not device attestation | Add shared abuse state, verified risk signals, anomaly telemetry and hostile distributed-load evidence |
| No account recovery/export/delete | Lockout and incomplete privacy lifecycle | Implement target contracts and propagation evidence below |

## 5. Identity and data model

The names below are logical entities. Physical schema may differ, but invariants may not.

### 5.1. Account and identifiers

`accounts`

- `id`: immutable random UUID; never recycled.
- `status`: `active | recovery_pending | containment | deletion_pending | deleted`.
- `securityEpoch`: monotonic integer incremented on account-wide containment/recovery.
- profile fields and timestamps.

`account_identifiers`

- `accountId`, `kind: username | email | phone`, canonical value, display value, verification state.
- independent `signInEnabled`, `recoveryEnabled`, `discoverability` and `visibility` fields.
- username canonicalization version. Beta-0.1 keeps the existing ASCII policy: lowercase, 3–32, begins with a letter, then letters/numbers/underscore.
- email/phone are never returned by username discovery.

Username changes emit a security event and do not change `accountId`, relationships, blocks or conversation ownership. Reuse/reservation policy must be published before username changes are enabled; stale links must resolve by account ID plus current username confirmation, never by silently transferring trust to a recycled name.

### 5.2. Authenticators

`authenticators`

- `id`, `accountId`, `kind: password | passkey | recovery_code | recovery_channel`.
- lifecycle: `active | suspended | revoked`; created/last-used/revoked timestamps and reason.
- user-assigned label is untrusted display metadata.
- binding source stores coarse security context, not raw long-lived fingerprinting data.

`webauthn_credentials`

- globally unique credential ID as base64url/binary.
- stable random, PII-free `userHandle`; it is not username/email/account primary key.
- COSE public key and algorithm.
- signature counter when supplied; zero is valid.
- `backupEligible` and latest `backupState` as risk/UX signals, not proof of one device.
- transports, AAGUID when available, attestation policy/result, created/last-used timestamps.
- no private key, biometric template, device PIN or passkey-provider cloud credential.

One account supports up to 20 active passkey credential records by default. The limit is abuse protection, is capability-advertised and can change without a protocol break.

### 5.3. Sessions and token families

`device_sessions`

- current fields plus server-derived `clientPlatform`, signed app identity/build, approximate region, authentication methods (`amr`), authentication time, risk state and `securityEpoch` at issuance.
- client label remains separate and is never rendered as verified.
- each native/desktop session may bind a non-exportable or OS-protected proof key; browser policy is separate.

`refresh_token_families` and `refresh_tokens`

- family/session/account binding, current generation, token hash, issue/use/expiry/revoke state and reason.
- one successful rotation lineage; ambiguous concurrent reuse fails closed and triggers explicit client recovery rather than issuing two descendants.
- account `securityEpoch` mismatch invalidates access, refresh and realtime even if the token signature is otherwise valid.

### 5.4. Ceremony, recovery and linking records

- `auth_ceremonies`: random ceremony ID, hash of challenge, purpose, account/session binding where applicable, expected RP/origin/UV, expiry, consumed timestamp.
- `step_up_transactions`: purpose, canonical target digest, minimum assurance, one-time JTI, five-minute expiry.
- `recovery_methods`: only verified channel metadata or keyed hash of saved recovery code; no plaintext code.
- `recovery_transactions`: risk state, satisfied factors, notification state, hold/completion/cancel times.
- `device_link_challenges`: hash of link secret, target ephemeral/proof public keys, transcript digest, expiry, state and approving session.
- `security_events`: typed append-only metadata without secret/content payload.

### 5.5. Relationships, safety and privacy jobs

- `relationships`: unordered account pair plus `none | requested | accepted`; it is not inferred from chat existence.
- `message_requests`: sender/recipient, first-message reference, `pending | accepted | recipient_dismissed | expired` state and anti-abuse timestamps. A recipient-private state has a deliberately coarser sender projection.
- `blocks`: blocker/blocked immutable account IDs, created/revoked timestamps. Block direction is private.
- `safety_reports`: reporter, subject, explicitly selected evidence references, trust class, case state and access audit.
- `data_exports`, `account_deletions`, `deletion_tasks`: job state, manifest/schema version, step-up evidence, deadlines and per-system propagation status.

## 6. Authenticator policy

### 6.1. Password profile

CURRENT Argon2id parameters remain the minimum: `m=64 MiB`, `t=3`, `p=1`. Parameters and implementation version are stored with each hash; a successful login rehashes when policy strengthens.

TARGET password rules:

- new single-factor passwords: 15–128 Unicode code points and at most 1024 UTF-8 bytes;
- no mandatory upper/lower/digit/symbol composition rule and no periodic forced change without evidence of compromise;
- accept password-manager autofill and paste; allow reveal control;
- compare the exact submitted value: no trim, Unicode normalization, case folding or silent truncation;
- block common/expected/known-compromised values using a locally held or privacy-reviewed blocklist; never send a raw password or unsalted reusable hash to analytics/third parties;
- online rate control combines per-account, per-network and coarse device risk without letting distributed attempts bypass the account bucket;
- successful password change revokes the old password authenticator material, rotates relevant token families and notifies existing channels.

Existing 12–14-character accounts are not silently locked out. They can sign in during migration, are prompted to add a passkey or stronger password, and cannot use the old password as the sole proof for the highest-risk changes after the migration deadline.

### 6.2. Passkey/WebAuthn relying-party profile

TARGET uses a dedicated authentication origin and RP boundary:

- canonical RP ID: `auth.luxora.app`;
- browser ceremonies only on exact production origin `https://auth.luxora.app`; preview/staging/debug origins use separate environments and credentials;
- no wildcard origin acceptance and no arbitrary subdomain-derived origin;
- Apple clients require the matching `webcredentials:auth.luxora.app` associated domain;
- Android clients require Digital Asset Links and exact allowlisted `android:apk-key-hash:<base64url SHA-256 signing certificate>` origins for each approved release/debug environment;
- `topOrigin`, when present, is checked against an explicit allowlist and cross-origin embedding is denied by default.

Registration defaults:

- 256-bit server-generated challenge, stored only as a hash, single-use, five-minute expiry;
- discoverable credential (`residentKey=required`) and `userVerification=required`;
- `attestation=none` for public consumer accounts unless a separately reviewed managed-device policy requires attestation;
- versioned COSE algorithm allowlist; initial compatibility baseline is ES256 and RS256, with additions/removals gated by platform interop and cryptographic review;
- `excludeCredentials` includes active credential IDs for the account where appropriate;
- stable random PII-free `user.id`; display name/username never becomes the cryptographic account key.

Server registration verification must validate at least:

1. ceremony exists, is unexpired, unused and bound to the intended purpose/account/session;
2. `type`, challenge, exact origin, `topOrigin` policy and RP ID hash;
3. UP/UV policy, allowed algorithm and attestation format policy;
4. attestation/authenticator data parsing bounds and signature;
5. credential ID is globally unused and `userHandle` belongs to the transaction;
6. transaction consumes once in the same commit that stores the credential and security event.

Authentication uses identifier-free discoverable credentials by default. The options endpoint takes no username, returns the same shape for every caller, and resolves the account from a verified assertion `userHandle` plus credential record.

Server assertion verification must validate ceremony state, exact origin/RP, UP/UV, credential/account/userHandle consistency, signature, algorithm and transaction purpose. `signCount`, BE and BS changes feed risk telemetry; a zero/non-monotonic counter or synced backup state does not automatically prove cloning and must not create an unrecoverable lockout by itself.

### 6.3. Multiple authenticator lifecycle

- Encourage at least two independent ways to authenticate before password removal.
- Adding an authenticator requires the strongest currently available authentication up to the assurance of the new authenticator, plus a transaction-bound step-up.
- Adding/removing/suspending/renaming authenticators updates all account devices through a durable event and independent security notification.
- A user may immediately suspend a suspected authenticator with any valid backup authenticator. Destructive removal requires step-up, except the dedicated containment flow which is intentionally easy to reach.
- Removing the last usable authenticator is rejected unless a verified replacement or recovery method is committed in the same transaction.
- Admin/support cannot create an authenticator, retrieve passkey material or bypass recovery for an unproofed consumer account.

CURRENT foundation implements active list, label rename and terminal revoke in
the Store/service layer. It enforces the password-disabled last-active case,
target/revision-bound WebAuthn step-up, one-time grant consumption, exact replay,
append-only durable evidence and known originating-session invalidation. It does
not yet implement suspension, public HTTP/client composition, independent
notifications, verified replacement/recovery methods or distributed fan-out.

## 7. Sign-in, tokens and sessions

### 7.1. Authentication methods

TARGET supports:

- passkey-first sign-in and passkey-first account creation;
- CURRENT password sign-in during migration;
- recovery creates a restricted recovery session, never an ordinary fully privileged session before completion;
- authenticated QR linking creates a new session but is not a passkey clone and does not transfer a refresh token from the approving device.

The login result records `auth_time`, `amr` (`pwd`, `webauthn`, `recovery`, `device_link`) and assurance. Clients must not infer assurance from UI path alone.

### 7.2. Access and refresh token profile

CURRENT remains `Bearer`, access TTL 15 minutes and refresh/session absolute TTL 30 days. Refresh remains single-use rotation with reuse detection.

TARGET hardening:

- native/desktop sessions negotiate a proof-of-possession profile based on RFC 9449 semantics or a formally profiled equivalent: access and refresh family bind to the session public key; every protected request proves method, target URI, issued time, unique JTI and access-token hash;
- server-provided nonce and short proof acceptance window protect replay; private proof key stays in OS-protected storage;
- no silent downgrade from a sender-constrained session to Bearer. Capability absence fails with an upgrade/re-auth requirement;
- Web uses a same-site Backend-for-Frontend or Secure/HttpOnly/SameSite refresh cookie design; long-lived refresh is never placed in `localStorage`. An XSS-capable origin is not declared safe merely because DPoP exists;
- tokens never appear in URL, QR, deep link, analytics, crash report or notification.

DPoP-like sender constraint is a TARGET hardening gate, not a CURRENT claim. It requires multi-platform interop, clock-skew, nonce, retry/idempotency and key-loss tests before enforcement.

### 7.3. Session representation and revocation

The user-visible session list must distinguish:

- chosen label;
- server-derived platform/app build and signed app identity;
- approximate region with `Approximate` wording;
- created, last active, current, last authentication method and risk flag;
- whether the session has a bound proof key;
- associated authenticator only when the mapping is technically known; synced passkeys are not shown as a physical device.

Remote revoke is idempotent. The commit revokes refresh family, increments session revision, deletes/invalidates push and call registrations, closes HTTP/realtime authorization within the revocation SLO and emits only after commit. A stale client receives `UNAUTHENTICATED`, clears the complete credential family and preserves only explicitly exportable local drafts.

## 8. Step-up authentication

### 8.1. Assurance classes

| Class | Evidence | Permitted examples |
| --- | --- | --- |
| `session` | Active ordinary session | Read inbox, send within existing relationship |
| `recent_primary` | Password re-entry or WebAuthn UV within five minutes | Rename a non-security label, view export status |
| `phishing_resistant` | WebAuthn UV bound to exact transaction | Add passkey, link device, change recovery settings, disable high-risk mode |
| `recovery_restricted` | Recovery factors satisfied, hold may remain | Register replacement authenticator, review/revoke sessions; no messaging/export until completion |

If an account has a phishing-resistant authenticator, password-only step-up cannot silently downgrade a `phishing_resistant` requirement. Accounts without one receive an explicit migration/recovery path.

### 8.2. Transaction binding

Step-up options include `purpose` and a server-canonical `targetDigest`. Verification returns a one-time token with:

- `aud=luxora-step-up`, `sub`, `sid`, `jti`, `purpose`, `targetDigest`, `amr`, `auth_time`, issue/expiry;
- maximum lifetime five minutes;
- no use as ordinary API access;
- atomic one-time consumption with the protected mutation.

Required actions include authenticator add/remove, recovery method changes, device link approval, password/identifier change, security-mode weakening, privileged role grants, export creation, account deletion and destructive all-session containment. A single push approval, SMS code or device unlock reported only by client code is insufficient.

## 9. Recovery

### 9.1. Recovery methods

TARGET encourages two independent authenticators plus one offline saved recovery code.

- Saved recovery code has at least 128 random bits, is shown once, may be printed/downloaded as text or QR, and is stored server-side only as a keyed hash.
- A used code is consumed and replaced; failed verification is account/risk rate-limited and does not reset by requesting another code.
- Verified email/phone may be a notification or recovery channel, but phone/SMS is not sufficient alone for high-assurance recovery and is never public identity by default.
- Luxora consumer accounts are not government identity-proofed. Support cannot substitute subjective document/social checks for missing cryptographic/recovery evidence.

To recover an account that previously had phishing-resistant access, require one of:

1. an existing bound authenticator plus saved recovery code; or
2. two independent configured recovery methods, one of which is the saved recovery code; or
3. a separately designed and audited identity-proofing flow, which is **LATER** and absent now.

If the user configured no sufficient method and lost every authenticator, the account may be unrecoverable. Product copy must say this before password removal/recovery-code dismissal.

### 9.2. Recovery state machine

`requested → proofs_pending → hold | ready → completed | denied | cancelled | expired`

1. Start always returns the same status/timing envelope for existent and non-existent identifiers.
2. Notifications are sent only if the account exists, without changing the public response.
3. Successful proof creates `recovery_restricted`; high-risk signals impose a 24-hour hold, while a valid existing passkey plus saved code may complete immediately.
4. Existing sessions receive a durable warning and independent notification with `Deny / Secure account` action.
5. Completion atomically increments `securityEpoch`, revokes all sessions/token families/link challenges/step-up tokens/recovery codes, registers the replacement authenticator and issues a fresh session.
6. User reviews sessions/authenticators and receives truthful Private-history consequences. Account access recovery does not imply recovery of future E2EE keys or encrypted backup.

Recovery endpoints never ask for password, OTP, private key or recovery secret in support chat. Codes are submitted only to the canonical TLS endpoint and never in URL query parameters.

## 10. Authenticated QR device linking

This is an application-specific binding protocol informed by NIST authenticator binding and RFC 8628 security lessons; it is not advertised as RFC 8628 OAuth Device Grant.

### 10.1. Transcript

1. Target device generates an ephemeral key-agreement key and a persistent session proof key in OS-protected storage.
2. Target requests a challenge with its public keys, signed app identity/build and untrusted label. Server returns `linkId`, 256-bit `linkSecret`, expiry and minimum polling interval. No account data is returned.
3. QR encodes version, exact `https://auth.luxora.app/device-link` origin, environment, `linkId`, `linkSecret`, target public-key transcript and server signature. It contains no token/account/user identifier.
4. Trusted device accepts only the canonical universal/app link, verifies server signature/environment/expiry, retrieves sanitized target details and shows `Approve` and equally visible `Deny`.
5. Approval requires local OS auth plus transaction-bound Luxora step-up. Both endpoints show a transcript-derived four-word short authentication string; it is a relay warning, not the cryptographic secret.
6. Server atomically consumes the challenge and creates a one-time link grant encrypted/bound to the target ephemeral/proof keys.
7. Target redeems the grant by proving possession of the persistent proof key. Only then does server issue a new session/token family bound to that key.
8. All existing sessions receive `New device linked`; independent notification includes time, platform, approximate region and one-tap containment.

### 10.2. Bounds and failure policy

- lifetime 120 seconds; secret and grant single-use;
- poll interval starts at two seconds and backs off; `429`/`Retry-After` is mandatory;
- create/approve/redeem buckets cover IP, approving account, target app identity and repeated denied transcripts;
- denial, expiry, mismatch, target key change or any second redemption permanently closes that challenge;
- polling never reveals username/account until successful proof-bound redemption;
- screenshot/relay remains a social-engineering risk, so confirmation always names the action and target. No QR flow uses gift, premium or payment wording;
- an approving device never receives the target refresh token and target never receives approving-device credentials;
- Private-history bootstrap and E2EE device keys are a separate audited protocol and cannot be smuggled into this access grant.

### 10.3. Grant confidentiality analysis (Beta-0.1 decision)

Session credentials are minted server-side and delivered to the target over
its own TLS connection authenticated by the link secret plus proof-key
possession. End-to-end grant encryption to a target ephemeral key is
deliberately NOT implemented in Beta-0.1, with this recorded reasoning:

- the relay/screenshot threat is handled by proof-of-possession: a leaked QR
  (secret only) cannot complete redemption without the proof private key,
  which never leaves the target device;
- encrypting to the target would not constrain a breached issuer, since the
  server mints the credentials it would encrypt;
- passive network observation is already covered by TLS plus
  secret-authenticated redemption.

Revisit only with a dedicated threat model if grant delivery ever leaves the
redeeming TLS session (e.g. push-delivered grants).

## 11. Session-compromise response

### 11.1. User actions

`POST /v1/security/containment` supports explicit scopes:

- `session`: revoke a selected suspected session and its device registrations;
- `all_other_sessions`: keep the currently reauthenticated session, revoke all others;
- `account`: increment `securityEpoch`, revoke every session/token/link/step-up/export download grant, suspend suspect authenticators and enter containment;
- `recovery_takeover`: deny a pending recovery, revoke the initiating context and freeze new links/recovery for a bounded review period.

Defensive suspension/revoke must remain reachable with one valid backup authenticator. A hijacker must not be able to make containment impossible by first removing factors; authenticator removal itself requires stronger step-up.

### 11.2. Atomic effects

Account containment transaction:

1. increments `securityEpoch`;
2. revokes token families and sessions;
3. invalidates auth, QR, recovery and step-up ceremonies;
4. removes push/call registrations and disconnects realtime;
5. cancels unready export jobs and device-link grants;
6. records an append-only security event without tokens/content;
7. queues independent notifications and recovery review after commit.

Target operational SLO: guarded HTTP and new refresh fail immediately after commit; connected realtime/call-control access is terminated p99 within five seconds in the tested deployment. If this SLO is not measured, UI says `Revocation requested`, not `Device secured`.

## 12. Message requests, accept/delete/block/report

### 12.1. Relationship state machine

Relationship: `none → requested → accepted`. Request resource: `pending → accepted | recipient_dismissed | expired`.

Orthogonal directed block state overrides every relationship. A block never becomes `accepted` by unblock; unblock returns to `none` unless a new request is explicitly accepted.

Request creation is transactionally denied when either direction is blocked, recipient policy disallows it, sender cooldown/quota is exceeded or recipient is unavailable. The sender receives a generic `RELATIONSHIP_UNAVAILABLE` reason envelope; it cannot distinguish block, privacy setting, nonexistent/deleted target or abuse restriction.

### 12.2. Pending boundary

Before accept:

- sender may submit one bounded safe-text request; links are inert in recipient preview and media is hidden/not downloaded automatically;
- no read/delivered-to-recipient detail, precise presence, last-seen, typing, calls, profile-change events or shared private membership graph;
- opening/previewing/deleting a request emits no signal to sender;
- request folder is quiet by default and separately rate-limited;
- server may expose permission-filtered shared public/moderated Spaces only as context, never as verification.

TARGET first request baseline: one message, at most 1,000 Unicode code points, no attachment and at most one normalized HTTP(S) link. Media requests remain disabled until the scanning/reveal/report gates pass.

### 12.3. Actions

- **Accept**: compare-and-set `pending→accepted`, creates/activates the Direct and emits durable accepted/chat events to both accounts exactly once.
- **Delete**: compare-and-set to `recipient_dismissed`; removes it from recipient views and starts a 30-day resend cooldown. The historical sender projection remains only `sent/pending`, never a deletion receipt. After cooldown a new request may be created only if policy/risk permits; it is a new resource and does not revive the dismissed content.
- **Block**: directed immutable-account block, syncs only to blocker’s devices, immediately enforces no new direct/request/call/presence/receipt access and hides future profile updates. Existing shared group membership remains governed by that group, but no precise presence/profile event crosses the block; directed interaction/mentions and rendering of shared-group content follow the blocker’s explicit hide policy.
- **Unblock**: removes block but does not accept, restore hidden requests, resend content or notify the other account.
- **Report**: separate action with exact evidence preview; `alsoBlock` is an explicit independent boolean. Report submission is idempotent and does not silently upload unrelated history.

For CURRENT Cloud reports, Safety may already have server access to moderated/server-readable content, but the report still records the exact user-selected evidence and access purpose. For future Private E2EE, only explicitly selected client-encrypted evidence may be uploaded; there is no ambient escrow.

## 13. Discovery, enumeration and profile privacy

### 13.1. Public exact lookup

TARGET replaces stranger-facing prefix search with:

`GET /v1/users/lookup?username=<canonical-exact>`

- exact ASCII case-insensitive match only;
- requester must be authenticated and rate-limited by account/network/device risk;
- account privacy must permit username discovery;
- response is `{ profile: PublicProfile | null }` with the same HTTP status/shape for no match, hidden, blocked or unavailable;
- `PublicProfile` contains account ID, current username, display name, avatar and explicitly public bio only. It never contains email, phone, presence, last-seen, session/device data or private/shared graph.

Because an opted-in username is intentionally discoverable, exact existence is a product disclosure, not something timing tricks can fully hide. Bulk enumeration remains prohibited through exact-only policy, quotas, anomaly detection and no count/prefix suggestions.

CURRENT uses the applicable per-route network/IP limiter together with fixed-window account and device-session buckets in the API process. Discovery consumes a shared account allowance across that account's sessions and a smaller allowance for the current session. These bounded local stores prevent simple token refresh and network rotation from resetting the authenticated bucket on one process; they do not provide cross-replica aggregation, device attestation, anomaly scoring or a production abuse-response claim.

### 13.2. Contextual search

Prefix search is allowed only in an explicit authorized scope such as accepted contacts or a Space where both users may view membership. The endpoint receives the scope, verifies membership before query and returns a scope-specific projection. It must not fall back to the global directory.

### 13.3. Recovery/login privacy

- login/password/recovery start uses generic status and comparable work/timing where feasible;
- password dummy verification remains;
- passkey authentication is usernameless and does not return per-account `allowCredentials` to an unauthenticated identifier probe;
- notification sending is asynchronous and does not alter public response;
- rate-limit errors do not expose whether an account-specific bucket exists;
- exact search terms, phone/email values and contact graph are excluded from product analytics and ordinary logs.

CURRENT enforces the log rule with a query-free request serializer. Method, path, request ID, response status and duration remain operationally available; headers, query strings and bodies are not part of the request log object.

### 13.4. Contact discovery

Contact upload is **LATER**. Plain, unsalted or merely salted hashes of phone/email are not accepted as privacy-preserving because the identifier space is enumerable. Any future design requires point-of-use consent, a dedicated private-discovery threat model, abuse limits, deletion semantics and proof that the server/analytics does not receive the raw address book.

## 14. Data export, account deletion and retention

### 14.1. Export contract

Export requires a one-time `phishing_resistant` step-up when available, or the strongest configured authenticator plus explicit migration warning. It is an asynchronous idempotent job.

The archive contains:

- `manifest.json`: `exportSchemaVersion`, account ID, created time, trust-class disclosures, included/omitted categories and per-file SHA-256;
- newline-delimited JSON for profile/settings, sessions/security history, relationships, own messages and membership records according to authorization;
- media owned/accessible by the requester with stable relative paths and MIME metadata;
- only the minimum other-user public/context fields required to understand the requester’s data;
- no password hash, access/refresh token, passkey public-key management internals, recovery secret, push token, raw IP, staff/security risk rules or other users’ restricted data.

Download uses authenticated `GET /v1/data-exports/:id/download` with range support and `Cache-Control: no-store`; no bearer/signed-object URL is placed in logs/referrers. Ready artifacts expire after seven days and are deleted within 24 hours after expiry. Private E2EE export is client-side from decrypted local data or server ciphertext; server does not gain plaintext to produce it.

### 14.2. Account deletion state machine

`none → scheduled → deletion_pending → executing → completed | failed_retryable`

1. Scheduling requires one-time step-up and an exact preview of effects/exceptions.
2. Default grace is seven days. Existing sessions and independent channels are notified immediately.
3. During grace the account shows a persistent deletion warning. Status/export/cancel remain available; cancellation requires a previously bound authenticator or valid recovery proof, not possession of the scheduling session alone.
4. Cancellation returns the account to `active`; any sessions already revoked by a related security action are not resurrected.
5. At the deadline, execution freezes mutations, increments `securityEpoch`, revokes all credentials/sessions/grants and closes cancellation before driving idempotent per-system tasks.
6. Completion is declared only when live stores, search, caches, CDN/object references and replicas meet the published SLA; backup expiry remains separately disclosed.

Deletion scope:

- account profile becomes an unavailable tombstone and direct identifiers are removed/reserved according to published anti-impersonation policy;
- Current Cloud Direct/Circle authored content is tombstoned where policy permits; recipients may retain prior downloads/exports/screenshots, which Luxora cannot claw back;
- Moderated/public content may be anonymized or retained for moderation/audit/legal purpose disclosed before confirmation;
- future Private server ciphertext/metadata is deleted, but other participants’ decrypted local copies cannot be remotely guaranteed erased;
- unreferenced owned objects, search tokens, thumbnails, push mappings and export artifacts are queued for deletion;
- safety reports/legal holds follow their separately disclosed purpose, access and expiry and never silently keep the whole account.

### 14.3. Target retention defaults

These are engineering defaults for Beta-0.1 deployment policy; Privacy/Legal may shorten them. Any extension must be purpose-specific, approved and user-disclosed.

| Data | Active retention | Delete/expiry behavior |
| --- | --- | --- |
| WebAuthn challenge/step-up secret | 5 minutes, single-use | Secret/hash removed within 24 hours; coarse outcome only in security log |
| QR link secret/grant | 120 seconds, single-use | Secret/grant removed within 24 hours |
| Access token | 15 minutes | Rejected immediately on session/security-epoch revoke |
| Refresh/session | absolute 30 days by default | Hash/family revoked immediately; minimal security metadata follows audit retention |
| Saved recovery code | until replaced/used/account deletion | Keyed hash only; consume immediately |
| Pending message request | 30 days | Expire; sender content tombstoned, recipient dismissal cooldown may retain pair metadata 30 days |
| Exact raw IP in security systems | maximum 7 days | Derive coarse region, then delete raw value unless incident hold |
| Coarse auth/security event | 180 days | Delete or aggregate irreversibly; no content/query/token |
| Export artifact | 7 days after ready | Delete within 24 hours |
| Live deleted account/content copies | published target ≤30 days | Per-system task evidence required |
| Backups containing deleted data | published target ≤90 days | Not restored into active service without replaying deletion ledger |
| Closed safety case evidence | 180 days by default | Purpose/jurisdiction-specific hold must be visible and audited |

CURRENT SQLite slice does not yet implement this end-to-end matrix. No retention/deletion compliance claim is allowed until workers, backup replay and evidence pass.

## 15. Versioned HTTP contract

### 15.1. Compatibility rules

- Resource paths remain under `/v1`; every target request schema is strict and rejects unknown mutation fields.
- `GET /v1/capabilities` is the single account-free discovery surface. CURRENT schema v1 advertises `identityContractVersion`, implemented protocol versions, runtime limits, Cloud-preview trust, explicit disabled E2EE/calls/passkeys/push state and whether server search is configured. Passkey authenticator, RP ID and token-proof details are absent; they may be added only as additive fields after those features are integrated and tested. Clients do not infer feature availability from the release label.
- Additive response fields may be ignored; removing/changing semantics requires a new HTTP version or an explicit capability/min-client transition.
- Eligible non-secret mutation retries use `Idempotency-Key` (128-bit random, account+route scoped, retained 24 hours) or the documented resource/client nonce. Same key with a different non-secret operation fingerprint returns `CONFLICT`. CURRENT message-request and safety-report client nonces are writer-serialized and tested across independent SQLite connections; this is not a claim for an untested production database. Password, assertion, recovery proof, link secret and step-up token are never copied into an idempotency record; their ceremony/resource state supplies replay control.
- The internally gated CURRENT authenticator-management service uses the same semantic rule with encrypted result receipts and independent SQLite writer tests. Its strict routes, headers and no-store policy are executable only outside production; public exposure remains TARGET until notification, operations and interoperability gates pass.
- Secrets never appear in paths/query strings. `Cache-Control: no-store` applies to auth, ceremony, recovery, link, export and deletion responses.
- Stable public error code remains the current broad taxonomy. Clients branch on machine-readable `error.details.reason`, never localized `message`.

Planned reasons include `step_up_required`, `assurance_insufficient`, `challenge_expired`, `challenge_consumed`, `authenticator_limit`, `last_authenticator`, `recovery_pending`, `link_pending`, `link_denied`, `relationship_unavailable`, `account_contained` and `deletion_pending`. Reasons that would expose block/account existence collapse to `relationship_unavailable` or generic auth outcome.

### 15.2. Endpoint inventory

| Method/path | Auth | Status | Purpose |
| --- | --- | --- | --- |
| `GET /v1/capabilities` | none | CURRENT | Shared version/trust/feature/runtime-limit discovery without account data |
| `POST /v1/auth/register/passkey/options` | none | INTERNAL ONLY | Begin pre-account signup behind its separate non-production key/config gate |
| `POST /v1/auth/register/passkey/verify` | bootstrap authorization | INTERNAL ONLY | Verify raw registration and atomically create account/session; not publicly advertised |
| `POST /v1/auth/passkeys/authentication/options` | none | INTERNAL ONLY | Usernameless assertion options behind non-production flag and dedicated key gates |
| `POST /v1/auth/passkeys/authentication/verify` | bootstrap authorization | INTERNAL ONLY | Verify raw assertion and atomically create session; not publicly advertised |
| `GET /v1/auth/authenticators` | session | INTERNAL ONLY | List safe active authenticator summaries behind the authenticated non-production gate |
| `POST /v1/auth/passkey-ceremonies/registration` | session + one-time `Step-Up-Authorization` grant | INTERNAL ONLY | Begin authenticated additional-passkey binding; registered only behind a non-production internal flag |
| `POST /v1/auth/passkey-ceremonies/authentication` | session | INTERNAL ONLY | Begin discoverable UV bound to the exact `authenticator.add` step-up target |
| `POST /v1/auth/passkey-ceremonies/authenticator-revocation` | session | INTERNAL ONLY | Begin discoverable UV bound to one authenticator ID and exact revision |
| `POST /v1/auth/passkey-ceremonies/:ceremonyId/verify` | same actor/session/device + ceremony revision | INTERNAL ONLY | Verify the stored ceremony kind, issuing step-up or atomically binding a credential; never creates a login session |
| `PATCH /v1/auth/authenticators/:id` | session | INTERNAL ONLY | Rename display label under exact ETag/idempotency binding |
| `DELETE /v1/auth/authenticators/:id` | session + target-bound step-up | INTERNAL ONLY | Revoke authenticator; last-factor invariant |
| `POST /v1/auth/recovery` | none | TARGET | Generic recovery start |
| `POST /v1/auth/recovery/:id/proofs` | recovery transaction | TARGET | Submit one bounded proof |
| `POST /v1/auth/recovery/:id/complete` | recovery restricted | TARGET | Replace authenticators and rotate account epoch |
| `DELETE /v1/auth/recovery/:id` | authenticated/recovery | TARGET | Deny/cancel transaction |
| `POST /v1/auth/device-links` | target proof | TARGET | Create short-lived link challenge |
| `GET /v1/auth/device-links/:id` | target proof | TARGET | Poll bounded status |
| `POST /v1/auth/device-links/:id/approve` | session + step-up | TARGET | Approve exact target transcript |
| `POST /v1/auth/device-links/:id/redeem` | target proof | TARGET | Redeem one-time grant into new session |
| `DELETE /v1/auth/device-links/:id` | target/approver | TARGET | Deny/cancel |
| `POST /v1/security/containment` | session/recovery action | TARGET | Revoke selected scope/account epoch |
| `GET /v1/privacy` / `PATCH /v1/privacy` | session | CURRENT | Read/update exact-discovery and request policy |
| `GET /v1/users/lookup` | session | CURRENT | Exact privacy-filtered username lookup |
| `GET /v1/users/search` | session | CURRENT | Search accepted relationships only |
| `POST /v1/message-requests` | session | CURRENT | Create bounded first request |
| `GET /v1/message-requests` | session | CURRENT | List own incoming/outgoing requests |
| `POST /v1/message-requests/:id/accept` | recipient | CURRENT | Atomically accept/create Direct |
| `DELETE /v1/message-requests/:id` | recipient | CURRENT | Local dismiss; no sender signal |
| `PUT /v1/blocks/:accountId` | session | CURRENT | Block immutable account ID |
| `DELETE /v1/blocks/:accountId` | session | CURRENT | Unblock without accept/notification |
| `GET /v1/blocks` | session | CURRENT | List actor-owned blocks with immutable profile snapshots |
| `POST /v1/safety/reports` | session | CURRENT | Submit exact selected evidence |
| `POST /v1/data-exports` | session + step-up | TARGET | Start idempotent export |
| `GET /v1/data-exports/:id` | owner session | TARGET | Status/manifest summary |
| `GET /v1/data-exports/:id/download` | owner session | TARGET | Authenticated no-store download |
| `POST /v1/account/deletion` | session + step-up | TARGET | Schedule deletion |
| `GET /v1/account/deletion` | owner restricted/session | TARGET | Status/propagation summary |
| `DELETE /v1/account/deletion` | strong auth | TARGET | Cancel during grace |

CURRENT auth/session endpoints remain as documented in [API.md](../../API.md) during migration.

### 15.3. Canonical ceremony shapes

The current internal implementation covers authenticated `authenticator.add`,
authenticated `session.step_up`, identifier-free primary passkey login,
pre-account first-passkey signup and internally gated durable authenticator
list/rename/revoke. The authenticated/login family uses
`PASSKEY_INTERNAL_ROUTES_ENABLED`; signup uses the separate
`PASSKEY_INTERNAL_SIGNUP_ROUTES_ENABLED`. Both default off and production rejects
either. Signup additionally requires its independent authorization secret,
rotated refresh keyring/active ID and active encrypted storage; partial setup
fails closed. Capability discovery remains `passkeys:false`. Primary login is
additionally absent unless its dedicated refresh-recovery keyring and encrypted
challenge storage are configured. Step-up verification issues a bounded
purpose-bound handoff, registration atomically consumes that one-time grant with
the encrypted credential commit, and primary login resolves the account only
after maintained-library verification before atomically creating its session.
Management revoke uses a separate target/revision-bound one-time grant and
terminally disables verifier lookup plus known originating sessions. Bearer
possession alone never authorizes binding or revoking a credential. No
management endpoint is registered or advertised.

Registration begin uses `Idempotency-Key: <command UUID>` and strict JSON:

```json
{
  "clientNonce": "uuid",
  "stepUpCeremonyId": "uuid"
}
```

It also requires the separate exact header
`Step-Up-Authorization: Bearer <canonical-compact-JWT>`; the token is bounded to
4,096 bytes.

Its private/no-store response is:

```json
{
  "schemaVersion": 1,
  "ceremony": {
    "id": "uuid",
    "kind": "registration",
    "purpose": "authenticator.add",
    "state": "pending",
    "revision": 1,
    "expiresAt": "2026-08-04T12:05:00Z"
  },
  "replayed": false,
  "options": {
    "challenge": "base64url",
    "rp": { "id": "auth.luxora.app", "name": "Luxora" },
    "user": {
      "id": "random-pii-free-base64url-user-handle",
      "name": "current_username",
      "displayName": "Current display name"
    },
    "pubKeyCredParams": [
      { "type": "public-key", "alg": -7 },
      { "type": "public-key", "alg": -257 }
    ],
    "excludeCredentials": [],
    "timeout": 300000,
    "attestation": "none",
    "authenticatorSelection": {
      "residentKey": "required",
      "requireResidentKey": true,
      "userVerification": "required"
    }
  }
}
```

Step-up begin uses the same command/nonce separation and the only current
operation:

```json
{
  "clientNonce": "uuid",
  "operation": "authenticator.add"
}
```

The server canonicalizes account + session + operation into the internal target
digest. Step-up options use an empty `allowCredentials` list, so only a
discoverable credential may be selected and its PII-free user handle must be
returned and verified. Successful authentication verification requires:

```json
{
  "stepUpAuthorization": {
    "scheme": "Bearer",
    "token": "canonical-compact-JWT",
    "purpose": "authenticator.add",
    "expiresAt": "2026-08-04T12:10:00Z"
  }
}
```

The token is a short-lived transport proof, not standalone mutation authority.
The registration boundary must verify its exact
account/session/ceremony/purpose/target binding and atomically
compare-and-consume the durable one-time grant; signature-only acceptance or
replay is forbidden.

Both kinds finish at
`POST /v1/auth/passkey-ceremonies/:ceremonyId/verify` with headers
`Idempotency-Key`, `If-Match: "<revision>"` and
`Content-Type: application/webauthn+json`. The body is the raw standards
registration/authentication credential object itself. The transport caps the
exact body at 65,536 bytes and derives byte length plus SHA-256 before parsing;
the client never sends those values. Binary values are canonical unpadded
base64url. Strict structural validation precedes handoff to a maintained
verifier, but never substitutes for its challenge/origin/RP/UP/UV/signature and
credential-binding checks.

Registration success returns only safe ceremony metadata, `verified:true` and
`replayed`; any supplied `stepUpAuthorization` field is stripped. Authentication
success additionally requires the bounded authorization object above. Neither
branch returns credential ID, public key, challenge/reference/digest, user
handle, sign count or raw attestation/assertion. Generic errors expose no such
material; their reasons use the existing binding vocabulary
(`step_up_required`, `assurance_insufficient`, `challenge_expired`,
`ceremony_unavailable`, `ceremony_conflict`, `verification_failed` or
`temporarily_unavailable`). An already-authorized conflict may include only
state and revision. Begin persists revision `1`; verify matches `"1"` and a
successful consume returns revision `2`.

Device-link create response:

```json
{
  "linkId": "uuid",
  "linkSecret": "base64url-256-bit",
  "verificationUri": "https://auth.luxora.app/device-link",
  "expiresIn": 120,
  "pollIntervalSeconds": 2,
  "serverSignedTranscript": "base64url"
}
```

`linkSecret` is returned only once with `no-store`; status polling requires proof by the target key as well as `linkId` and never returns the secret.

Report submission:

```json
{
  "subjectAccountId": "uuid",
  "category": "spam",
  "evidence": [
    { "type": "message", "messageId": "uuid" }
  ],
  "comment": "optional bounded text",
  "alsoBlock": true,
  "clientNonce": "uuid"
}
```

Server re-authorizes every evidence reference and records exactly what was accepted. It never expands to neighboring messages silently.

## 16. Versioned realtime contract

### 16.1. CURRENT v1

`GET /v1/realtime` with `protocolVersion=1` remains the implemented messaging contract. Identity/access events below are not inserted into the strict v1 union without compatibility evidence.

### 16.2. CURRENT IA-1 v2

IA-1 durable events ship on `/v2/realtime` with `protocolVersion=2`. The same durable `dispatch(sequence,event)` semantics apply; `/v1/realtime` skips IA-1 events while still advancing through its authorized server watermark.

CURRENT event classes:

- `relationship.request.created`, recipient-private reason-free `relationship.request.removed`, `relationship.request.accepted`, `relationship.request.expired`;
- `relationship.block.changed` only to blocker’s own account devices;
- `safety.report.submitted` only to reporter’s own devices.

TARGET future event classes:

- `identity.session.created`, `identity.session.updated`, `identity.session.revoked`;
- `identity.authenticator.added`, `identity.authenticator.suspended`, `identity.authenticator.revoked`;
- `identity.device_link.requested`, `identity.device_link.completed`, `identity.device_link.denied`;
- `identity.recovery.started`, `identity.recovery.cancelled`, `identity.recovery.completed`;
- `identity.security_epoch.changed`, `identity.account.contained`;
- `data.export.ready`, `data.export.expired`, `account.deletion.scheduled`, `account.deletion.cancelled`.

No event contains challenge, QR/link secret, assertion, password/recovery proof, refresh/access token, full IP, exact search query, report plaintext evidence or export download credential.

Privacy routing rules:

- preview/delete/block of a request does not emit a sender-visible event; recipient devices may receive a reason-free removal event;
- target of a block never receives `blocked_by` data; access changes reconcile as generic unavailable state;
- authenticator/session/recovery/link events are account-private and never fan out to conversation peers;
- accepted relationship may notify both sides only after transactional commit;
- security events remain durable through resume; independent notification is still required because compromised sessions may be offline.

Unknown additive events must advance the durable cursor without corrupting state. Security-critical unknown event/capability mismatch triggers bounded snapshot or required upgrade, never silent success.

## 17. Concurrency and transaction invariants

1. WebAuthn, step-up, recovery code, link secret/grant and export download grant are compare-and-consume single-use values.
2. Credential bind and ceremony consume occur in one transaction; credential ID has global unique constraint.
3. Authenticator removal checks last-usable-factor under the same lock/transaction as revoke.
4. Refresh rotation has one descendant. The losing concurrent request never receives an independently valid lineage.
5. Session/account revoke and security-epoch increment commit before realtime/push/call disconnect events.
6. Request accept is compare-and-set and creates at most one canonical Direct for the unordered account pair.
7. Block wins over concurrent request create/accept and call invite. Authorization rechecks block at commit, dispatch and media/call grant issuance.
8. Request delete is recipient-private; no durable sender audience event is persisted.
9. Export snapshot records a high-water mark and manifest; concurrent changes are either consistently before/after and documented, never partially serialized without indication.
10. Deletion tasks are idempotent, resumable and tracked per live DB, search, object/CDN, cache, replica and backup ledger.
11. A restored backup replays the deletion ledger before serving traffic.
12. Outbox publication is after the same durable transaction or through a transactional outbox; notification failure does not roll back security state.

## 18. Logging, metrics and audit

Never log or metric-label:

- password/hash input, WebAuthn challenge/assertion/clientData/attestation blob, private/public credential body;
- access/refresh/step-up/link/recovery/export tokens or signed URLs;
- QR transcript, device private/proof material;
- email/phone, exact username lookup query, contact graph, raw report content;
- exact IP after the short security retention window.

Allowed operational dimensions are service/build, coarse region, ceremony/action class, outcome taxonomy, latency bucket, protocol version and rotating pseudonymous account/session correlation. No stable high-cardinality user IDs in product analytics.

Append-only security audit records actor class, target class, action, outcome, assurance, coarse source context, reason and related incident/case ID. User-visible security history is a privacy-filtered projection, not raw internal risk telemetry.

Required alerts/SLOs:

- credential stuffing/spray and distributed recovery enumeration;
- refresh reuse and abnormal concurrent rotations;
- authenticator binding/link/recovery bursts or repeated denial;
- revocation propagation latency and sockets/call grants surviving revoke;
- export/deletion job stalls and propagation SLA breach;
- unexpected passkey origin/RP/algorithm/counter/backup-state changes;
- message-request spam/report brigading without exposing content in metrics.

## 19. Threat cases and required tests

| ID | Attack/failure | Required control and evidence |
| --- | --- | --- |
| IA-01 | Password stuffing/spray | Account+network+risk buckets, local breached blocklist, Argon2 cost/load test, generic errors |
| IA-02 | Login/recovery enumeration | Dummy work, usernameless passkey options, async notification, timing distribution test, exact-public-search exception documented |
| IA-03 | WebAuthn challenge replay | 256-bit single-use challenge, purpose/account/session binding, consume-race test |
| IA-04 | Malicious origin/RP/subdomain | Exact origin/topOrigin/RP hash checks; staging/release Android signing-origin matrix; negative corpus |
| IA-05 | Forged/unsupported credential | Reviewed verifier, algorithm/format allowlist, parser size/fuzz tests, global credential uniqueness |
| IA-06 | Counter rollback or synced-passkey state change | Risk signal, no automatic irreversible lockout, user review/notification tests |
| IA-07 | Unauthorized authenticator binding | Strongest-available step-up, transaction digest, independent notification, last-factor invariant |
| IA-08 | Stolen bearer/refresh token | Rotation/reuse/revoke now; sender constraint target; OS storage and full token-family cleanup tests |
| IA-09 | Refresh retry race | Atomic lineage and simulated timeout/retry; exactly one surviving descendant |
| IA-10 | Revoked session remains online | HTTP/refresh/realtime/call/push propagation test against five-second target |
| IA-11 | QR screenshot/relay/substitution | 120-second transcript, exact origin, target key binding, SAS, explicit target sheet, single redemption and social-engineering UX test |
| IA-12 | QR poll/resource DoS | Account/IP/app buckets, bounded state, poll backoff, expiry cleanup/load test |
| IA-13 | Recovery via SIM swap/support | Phone never sole strong recovery, two-method policy, support cannot override, hold/deny/notification tabletop |
| IA-14 | Recovery attacker races owner | `securityEpoch`, existing-device deny, compare-and-complete, all-family revoke and recovery chaos tests |
| IA-15 | Session hijacker adds factor/deletes account | Purpose-bound one-use step-up, strongest method, notifications, cancellation/containment exercise |
| IA-16 | Username change bypasses block | Relationships/blocks keyed only by immutable account ID; migration/property test |
| IA-17 | Block oracle | Generic unavailable response, no target event, timing/status comparison and API diff tests |
| IA-18 | Request preview leaks read/presence/call | Authorization matrix across HTTP/WS/push/call/media; no preview/delete event to sender |
| IA-19 | Request spam/raid | First-message bounds, cooldown/quota/risk buckets, abuse load simulation and false-positive review |
| IA-20 | Forged/overbroad report | Evidence reauthorization, exact preview/hash manifest, idempotency, no ambient Private context |
| IA-21 | Export cross-account leak | Snapshot authorization, restricted profile projection, archive path traversal/zip-bomb tests, owner-only range download |
| IA-22 | Export token/log leak | Authenticated no-store download, redaction canary, referrer/cache/proxy tests |
| IA-23 | Partial deletion | Per-system ledger, retry/alert, live ≤30d and backup ≤90d evidence, restore-replay game day |
| IA-24 | Delete/restore loses shared semantics | Tombstone/anonymization policy, concurrent message/export tests, user-visible exception review |
| IA-25 | XSS/CSRF/browser token theft | BFF/HttpOnly cookie profile, SameSite+CSRF+Origin, CSP and logout cache purge; do not overclaim DPoP |
| IA-26 | Stale/incompatible client misses security event | v2 schema negotiation, minimum-version policy, unknown-event cursor test, snapshot/required-upgrade path |

## 20. Server-completion gates

Identity/access is not complete until artifacts exist for all applicable items:

### 20.1. Contract and storage

- Generated OpenAPI and protocol schemas match this endpoint/event inventory.
- Migrations are forward/backward compatible; every table/field has purpose, class, owner, retention and deletion behavior.
- Capability endpoint and strict unknown-field policy pass clients one supported version behind.
- All secrets are hashed/encrypted as specified and redaction canary finds zero leaks.

### 20.2. Authentication

- Password migration, breached-value blocklist and distributed throttling pass functional/load tests.
- WebAuthn registration/authentication passes W3C vectors plus origin/RP/challenge/UV/algorithm/counter/BE/BS negative matrix on Web, Apple and Android release identities.
- Multiple authenticator, last-factor, step-up replay/target substitution and notification tests pass.
- Recovery, QR relay/replay/expiry/poll and account-containment chaos tests pass.
- Revoked account/session cannot use HTTP, refresh, realtime, calls, push registration, media grants or export downloads within measured SLO.

### 20.3. Relationship safety

- Message request accept/delete/block/report state model passes concurrency and idempotency tests.
- Before accept/after block, no receipt/presence/typing/call/profile-event leakage across every transport.
- Exact discovery and contextual search pass enumeration, blocked-user and scope-authorization tests.
- Safety report contains only selected authorized evidence and every staff access is case-bound/audited.

### 20.4. Privacy lifecycle

- Export archive schema, checksums, authorization/redaction and expiry are tested with representative large accounts.
- Deletion dry run proves live/search/cache/object/CDN/replica tasks; backup restore replays deletion ledger.
- Published retention matrix matches actual configuration/metrics and has no stalled work beyond SLA.
- UX comprehension tests verify users understand passkey sharing/sync ambiguity, QR target, recovery loss, block/report and deletion limitations.

No checkbox alone is evidence. Gate record includes commit/image, environment, test/report link, owner, date, outcome and rollback/kill-switch.

## 21. Implementation order

1. **IA-0 truth/contract:** keep CURRENT auth stable; land schemas/data inventory/test vectors behind disabled capabilities.
2. **IA-1 safety boundary — CURRENT tested checkpoint:** exact profile projection, relationships, message requests, block/report and current HTTP/realtime/chat transport authorization. Remaining first-request media scanning, shared-group client hide policy, moderation case workflow and call-control integration stay explicit follow-up gates.
3. **IA-2 authenticators:** password migration, passkey registration/login, multiple authenticator management and step-up.
4. **IA-3 device trust:** verified session metadata, QR linking, proof-bound tokens, recovery and containment.
5. **IA-4 privacy lifecycle:** export, deletion/retention workers, backup deletion-ledger replay and operational evidence.
6. Enable capabilities gradually with server kill switches; never expose UI controls before their server gate passes.

The full iPhone feature phase starts only after the complete server platform, including applicable identity/access gates, is green. The existing thin iPhone harness remains an integration probe, not product completion.

## 22. Primary technical sources

Sources were checked on 3 August 2026. Product-specific TTLs, state machines and endpoint names above are Luxora decisions, not claims that a source mandates those exact values.

- [W3C Web Authentication Level 3](https://www.w3.org/TR/webauthn-3/) — current Candidate Recommendation Snapshot; ceremony verification, RP/origin, UV, counters, BE/BS and recommended five-minute timeout.
- [NIST SP 800-63B-4](https://pages.nist.gov/800-63-4/sp800-63b.html) — final authenticator lifecycle, multiple authenticator binding, phishing resistance, recovery, compromise invalidation and independent notifications.
- [RFC 9700 — OAuth 2.0 Security Best Current Practice](https://www.rfc-editor.org/rfc/rfc9700.html) — refresh rotation/replay detection, audience restriction and sender-constrained token guidance.
- [RFC 9449 — DPoP](https://www.rfc-editor.org/rfc/rfc9449.html) — application-level proof-of-possession profile and replay/nonces; used as target design input, not a CURRENT implementation claim.
- [RFC 8628 — OAuth 2.0 Device Authorization Grant](https://www.rfc-editor.org/rfc/rfc8628.html) — short-lived device/user codes, explicit approve/deny, polling and phishing lessons. Luxora QR linking is a separate profiled protocol.
- [Apple: Supporting passkeys](https://developer.apple.com/documentation/authenticationservices/supporting-passkeys) and [Passkeys overview](https://developer.apple.com/passkeys/) — AuthenticationServices relying-party/associated-domain integration and platform passkey behavior.
- [Android: Create a passkey](https://developer.android.com/identity/passkeys/create-passkeys) and [Credential Manager prerequisites](https://developer.android.com/identity/credential-manager/prerequisites) — Digital Asset Links and exact APK signing-certificate origin verification.
- [OWASP Forgot Password Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Forgot_Password_Cheat_Sheet.html), [MFA Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Multifactor_Authentication_Cheat_Sheet.html) and [Session Management Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html) — generic responses, one-use expiry, reauthentication and risk-event session handling.
