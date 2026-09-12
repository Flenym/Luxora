# Luxora Engineering TODO

**Релиз:** Beta-0.1  
**Владелец и разработчик:** Flenym  
**Обновлено:** 15 августа 2026

`[x]` means a repository foundation exists, not that a production gate passed. Execution order is server-complete → full iPhone → all other clients/public site.

Полное iPhone-завершение и непрерывная очередь проверяются по
[`docs/specs/IPHONE_FUNCTIONAL_COMPLETION_MATRIX_RU.md`](docs/specs/IPHONE_FUNCTIONAL_COMPLETION_MATRIX_RU.md);
один экран, fixture или backend endpoint не закрывает строку без live/Xcode/evidence gates.

## Immediate truth/build blockers

- [x] Only `Beta-0.1` appears as visible release metadata; only Flenym as owner/developer; repo-wide classified metadata gate passes while excluding internal package/API/platform versions.
- [ ] All simulated call, E2EE, delivery, presence, download and sync UI is removed or clearly labelled demo/roadmap.
- [x] Root editor/ignore/Make/Compose conventions exist.
- [x] Node, Apple, Android and security/container CI definitions exist.
- [x] API ships from a digest-pinned Debian 13 distroless Node 22 runtime as
  UID/GID `65532`, without shell/npm/Corepack. Current local-preview primary is
  `luxora-api@sha256:f9dbff7ffb5a22d0400fdf9c1a97e379696505f2d5a54c64c787c99c52620e6d`;
  it is healthy on loopback `127.0.0.1:8080`, hardened and on migration `025`.
  Trivy 0.73 reports 0 High/Critical vulnerabilities and 0 secrets. This is
  local evidence; cloud scanning, signing and provenance remain release gates.
- [ ] First clean-checkout runs are PASS and retained as release evidence.
- [ ] Branch protection and mandatory sensitive-path review are configured.
- [x] Loopback operator console foundation: token-gated read-only `/v1/admin/status`,
  `/v1/admin/users` and `/v1/admin/chats` with secret-free cursor pagination and
  `private, no-store` responses (migration-free, explicit 503 without
  `ADMIN_TOKEN`); the `apps/admin` console (Vite+React, port 4174) shows server
  status, user and chat tables. Protocol 12 files/92 tests PASS, API 74
  files/635 tests PASS. Write/moderation operator actions are intentionally out
  of scope for Beta-0.1.

## Server Phase 1 — finish text vertical slice

- [x] Shared strict protocol schemas and limits.
- [x] Argon2id, validated access JWT, rotating hash-only refresh and device sessions.
- [x] Direct/group/channel, text/reply/edit/tombstone/reaction.
- [x] Explicit idempotent delivered/read receipts.
- [x] Realtime auth/replay/typing/presence/heartbeat/backpressure/session revoke.
- [x] SQLite WAL/migrations and configured content envelope.
- [x] Health/readiness/OpenAPI/basic metrics.
- [x] Full executable IDOR/BOLA/BFLA matrix for every current HTTP endpoint, realtime command and durable audience branch, including oracle equality and no-side-effect probes.
- [x] Independent two-connection SQLite races cover exact/changed send and forward nonces, guarded/unguarded edits, edit/delete domination, monotonic read/delivered receipts, reaction desired state and ±24-hour server clocks.
- [x] Refresh rotation samples time inside a SQLite writer reservation, preserves the earlier family/session expiry, creates one hash-only descendant through a session-bound standalone-atomic store CAS, maps observed same-token/CAS/ambiguous-commit consumption to strict reuse, and maps uncommitted lock exhaustion to generic `503`; independent-writer, signer, clock, cleanup and ambiguity regressions pass.
- [ ] Prove refresh serialization and authoritative ambiguity reconciliation on the selected production database across pools/replicas/failover, add distributed realtime revoke fan-out/latency evidence, reuse alerts and recovery UX.
- [x] V2 account/session-bound signed cursor with seven-day logical TTL, 500-event replay bound, deterministic recovery reasons and authorized HTTP reconciliation boundary/hostile tests.
- [x] Independent V2 sync audit covers canonical cursor encoding/exact expiry, malformed/mixed recovery, active-session command/live-dispatch checks, private no-store success/error paths, blocked group reaction reprojection and reaction/receipt existence-oracle collapse.
- [x] Single-node SQLite realtime outbox atomically commits audience events with domain mutations, publishes at least once through owner-bound leases, recovers restart/expired claims, applies capped retry/backoff and retains poison rows as durable failed records.
- [ ] Physical/distributed event retention, attachment-deletion tombstones, rolling-deploy compatibility and production reconnect/load evidence.
- [x] Capability negotiation and one-version-back fixtures.
- [x] Default-on account-projection invalidation is durable on V2 live/replay,
  absent from V1, and truthfully capability-negotiated. The strict
  `SYNC_INVALIDATION_ENABLED=false` emergency seam suppresses only
  `sync.invalidated` creation/replay/live/outbox delivery, acknowledges skipped
  outbox rows and preserves ordinary events. Old capability fixtures parse the
  absent field conservatively as `false`.
- [x] Deterministic single-process frame/typing-rate, slow-consumer, session/pending/auth reconnect hostile mix with cleanup and metrics; production distributed/load evidence remains a separate gate.
- [ ] Log/content/token canary proof.
- [x] API-process request logging uses route templates (no query/object IDs), server-generated request IDs, and passes query/path/password/token/content canaries while retaining method/status/duration.
- [x] Reproducible local production-container log/content/token plus stopped-SQLite raw-canary gate with exact synthetic cleanup.
- [x] Reproducible stopped local SQLite + blobs/uploads backup/restore synthetic drill.
- [ ] Duration/correctness metrics, online coordination and real-dataset restore evidence.

## Server Phase 2 — identity/access

- [ ] Telegram-style phone authentication end-to-end release gate.
  - [x] Server foundation: strict E.164 country-calling-code/number contract, six-digit OTP challenge, correct-code-only account lookup, existing phone-account login vs short-lived profile-registration token, name/bio/username completion, availability suggestions, password-disabled phone accounts and exact encrypted token-response replay.
  - [x] SQLite migration `018_phone_authentication`: keyed phone/code/token digests; encrypted full and masked phone, delivery code, device snapshot and bearer responses; atomic identity/user/session/refresh commits; append-only receipts/audit; bounded attempts/expiry; durable per-phone resend window and same-provider-command retry after ambiguous delivery failure. Clean Node 22 Linux evidence: focused API/config/storage/authorization 30/30, migration + identity 2 files/14 tests, full API 59 files/552 tests; shared protocol typecheck plus 6 files/59 tests also pass. A fresh production image and disposable hardened development-provider container complete challenge → profile-required → username check → registration → exact replay → authenticated `/v1/me`; raw DB/WAL inspection finds no full number, OTP or masked number.
  - [x] Add a separate loopback-only Docker OTP console for Xcode/local client work. The explicit `development` profile uses a pinned distroless non-root/read-only container, never logs the fixed code, rejects production/non-development/malformed configuration and non-local Host headers, and passes health/code-shape/DNS-rebinding/production-fail-closed smoke. It is not an API route or a production SMS substitute.
  - [ ] Wire and qualify a real production SMS provider (the external provider remains an injected interface and startup fails closed without one), distributed IP/phone/risk abuse controls, delivery observability, retention/cleanup and production-database fault injection.
  - [x] Add the requested optional post-OTP secret-password state for phone-bound accounts: correct OTP returns `password_required`, the continuation is short-lived/bounded/replay-safe, the separate Argon2id hash never enables legacy username/password login, and authenticated settings support enable/change/disable.
  - [ ] Add independent phone-password recovery and a verified phone-binding path for pre-phone legacy accounts; current phone-created accounts intentionally keep legacy password auth disabled.
    - [x] Server foundation (migration `026_phone_recovery_and_binding`, 2026-09-10): recovery intents with a deliberate confirmation window (`PHONE_AUTH_RECOVERY_DELAY_SECONDS`, production requires ≥ 3600 s) and bounded completion TTL; completion atomically sets a new phone-password hash, revokes all active sessions/push registrations, creates the replacement session and records append-only receipts/events. Binding lets an authenticated legacy (password) account verify a new phone through the same strict OTP state machine (`binding_verified` union member) and atomically attach the identity only if the phone is still unbound; wrong-code attempts, resend windows, replay receipts and generic enumeration-safe errors mirror the login flow. Evidence: protocol 11 files/89 tests PASS, API 73 files/632 tests PASS including `phone-recovery.integration.test.ts` and `phone-binding.integration.test.ts`, both typechecks green. Remaining gates: real SMS provider wiring, iPhone client UI for recovery/binding, rate-limit distribution, and production fault injection.
  - [x] Add a strict authenticated post-registration profile-update boundary for display name and bio: `PATCH /v1/me` accepts only those owner fields, trims and bounds them, persists atomically in SQLite and rejects empty/unknown/unauthenticated mutations. Protocol typecheck/build plus 2 protocol and 2 API integration tests pass in clean Node 22 Linux. iPhone wiring/UI evidence remains a separate client checkpoint.
  - [x] Server half of safe profile avatars: strict `{attachmentId}` mutation accepts only an owned verified image, reads it through authorized storage, bounds source bytes/pixels, auto-orients, centre-crops and metadata-strips into a 512×512 PNG derivative, rechecks quota under the writer lock, binds it with SQLite ownership/trust triggers, honors discovery/block visibility, and supports clear/orphan retention. Arbitrary `avatarUrl` mutation remains rejected. The merged protocol suite is green at 9 files/68 tests and the API at 64 files/567 tests. The verified distroless image passed fresh-volume and real-data-clone migration 021 flows; the live migration preserved 30 users/39 sessions exactly, then a post-deploy smoke intentionally added one test account. Current live integrity/foreign keys and API/OTP hardening are clean. Sealed pre-push backup `Beta-0.1/pre-push-20260811T082301Z` and stopped rollback container are retained outside the active runtime.
  - [x] Wire resumable upload → processed avatar binding into onboarding/profile on the real iPhone client. Focused Swift tests and signed build pass; fixture-free crop/upload/save, terminate/relaunch server restore and clear pass 1/1 with canary-clean retained evidence. Expiry/rate-limit/storage-pressure and real-device gates remain open.
- [ ] Passkeys/WebAuthn, multiple authenticators, recovery and step-up.
- [x] Authenticated WebAuthn ceremony orchestration contract with exact RP/origin, 32-byte ref/digest challenge boundary and CAS/idempotency/race tests.
- [x] Independent passkey-domain adversarial audit: actor-oracle-safe errors, response-bound idempotency, exact command/store/verifier normalization, active-policy rehydration, verifier-crossing-expiry handling, immutable-BE enforcement, global credential-ID and credential-row-CAS contracts/tests.
- [x] Internal-only authenticated add-authenticator seam with strict/raw-byte HTTP handling, encrypted SQLite challenge/user-handle/credential records, `@simplewebauthn/server` pinned to `13.3.2`, a short-lived step-up token backed by a one-time grant and atomic replay-safe credential commit; default routes are absent, production enablement is rejected and `features.passkeys` remains `false`.
- [x] Internal-only identifier-free primary passkey login seam with strict raw assertion transport, cryptographically authenticated pre-lookup bootstrap, atomic session/refresh/access commit, exact bounded response-loss recovery, synced-counter risk telemetry and encrypted durable lifecycle with bounded abandoned-intent expiry reconciliation; route wiring additionally requires its dedicated rotation keyring and public capability remains `false`.
- [x] Durable pre-account passkey-signup intent foundation: canonical candidate subjects without a users FK or username reservation, field-bound encrypted identity/32-byte handle, existing secret-vault challenges, bounded CAS attempts/expiry, safe event/outbox/receipt projections, retention indexes and independent-writer/hostile tests; every public route remains unavailable.
- [x] Atomic verified first-passkey Store commit: exact candidate binding creates the password-disabled account, privacy defaults, first handle/credential, initial session/refresh/access replay projection and consumed audit record all-or-nothing; username/credential/handle/account races leave no ghosts, authenticated add-passkey authorization stays intact and `features.passkeys` remains `false`.
- [x] Internal pre-account signup service: strict username/display/device/nonces, repository-free maintained WebAuthn bootstrap, signup-only signed authorization and refresh namespaces, exact revision/expiry/attempt/body binding, per-account discarded-secret Argon2id placeholder, atomic first account/session commit and bounded deterministic response-loss replay; fake plus real-verifier/SQLite hostile tests pass and `features.passkeys` stays `false`.
- [x] Internal-only pre-account signup Fastify transport module: canonical strict begin body plus `Idempotency-Key`, query-free/no-store responses, raw bounded `application/webauthn+json` verify with `If-Match`/ETag and `Bootstrap-Authorization`, anonymous local 5/10-per-minute route buckets and eight boundary tests.
- [x] Separate fail-closed signup composition gate: `PASSKEY_INTERNAL_SIGNUP_ROUTES_ENABLED=false`, categorical production rejection, dedicated authorization secret plus independently rotated signup-refresh keys/active ID and active data encryption; default paths/OpenAPI stay absent, complete non-production config reaches only signup, old passkey/login gates are unchanged and capability remains `false`.
- [x] Pre-account signup-expiry reconciliation: one-clock bounded ordered batches, deterministic candidate-secret-free command ownership, writer-time/revision CAS, exact receipt reconciliation, atomic event/outbox/receipt plus challenge cleanup, capped SQLite BUSY/LOCKED backoff and restart/two-writer/idempotency tests; startup and ten-minute periodic execution are wired independently of route availability and the shared timer is cleared on app close.
- [x] Durable authenticator-management foundation: active-only secret-free list projection, encrypted Russian-capable labels, revision/ETag rename, target/revision-bound one-time `authenticator.revoke` WebAuthn ceremony, atomic terminal revoke, attributed session/refresh invalidation, append-only audit/outbox/encrypted receipts, password-disabled last-active invariant, migration-013 backfill/reopen, restart/response-loss recovery and independent-writer races. Strict management HTTP is composed only behind the existing non-production internal flag; default/production paths remain absent and `features.passkeys` remains `false`.
- [ ] Before public primary-login enablement, equalize or independently bound the maintained-verifier timing difference between unknown high-entropy credential IDs and known credentials; retain distributed enumeration/abuse evidence.
- [ ] Before public passkey-first signup or authenticator-management enablement, add distributed anonymous abuse/admission controls, independent security notifications, public route/UX review, production datastore/vault/operations evidence and Apple/Web/Android interoperability; account recovery remains open.
- [ ] Authenticated QR device linking and security event/device compromise flow.
- [x] Message requests, atomic accept/private dismiss, bidirectional block and selected-evidence report boundary.
- [x] Exact username discovery, accepted-contact search, privacy policy and enumeration-safe projections.
- [x] Bounded in-process account and device-session buckets supplement network limits on discovery and abuse-sensitive relationship/report mutations.
- [ ] Account/device/risk-aware discovery quotas, distributed-enumeration anomaly evidence and abuse response.
- [x] Independent two-connection SQLite writer races return the first message-request/report result for identical nonces and stable conflict for changed fingerprints.
- [ ] Multi-process/production-database request/report nonce and accept-vs-block fault-injection evidence.
- [ ] Privacy-preserving contact discovery/upload design and abuse evidence.
- [ ] Account export/delete/retention and data inventory.

## Server Phase 3 — complete chat/community domain

- [ ] Direct/Saved/Circle/supergroup/channel/Space models and immutable trust class.
- [x] Group/channel membership list/add/role/remove with one immutable owner, 200-member limit, actor-scoped exact receipts, optimistic revisions, V2 current/removed audiences, reconciliation template and independent-writer removal-vs-send proof.
- [ ] Ownership transfer ceremony, invitation approval/privacy, join requests/links and production-database membership fault injection.
- [x] Replies, privacy-minimized forwards, pins, edit history and topic foundations.
- [x] Account-scoped archive/mute foundation on existing membership columns: strict GET/PATCH, additive chat projections, idempotent server archive time, explicit unarchive/unmute and column-selective writes pass protocol/API/authorization tests. V2 emits an exact account-bound `chat.preferences.updated` only after a real confirmed state change; live/replay rechecks account identity and current membership, while V1 skips the additive event. The foundation is carried forward by the current migration-025 local runtime. Full release-scale reconnect/offline evidence remains separate.
- [x] Account-scoped synchronized custom chat folders: five strict authenticated routes, 10-folder/48-code-point-title/100-override limits, atomic snapshot reads, folder/account CAS revisions, normalized encrypted exact-response receipts with a public 24-hour/64-active quota, actionable `Retry-After`, migration `023`, indexed bounded cleanup, semantic no-op handling, exact-account V2 realtime and atomic override cleanup on membership removal. At the 11 August slice checkpoint, protocol 10 files/85 tests, API 68 files/606 tests, both typechecks, migration chain 15/15 and authorization matrices passed; the current migration-025 image carries this already-verified foundation forward.
- [x] Migration `024_chat_membership_revision_ledger` prevents remove/re-add ABA
  resets. Candidate-migrated fallback rehearsal proved revisions `1 → 2 → 3`.
  Controlled promotion preserved every pre-smoke row count, completed in
  `12.005 s`, and retained verified sealed backup
  `Beta-0.1/pre-live-m024-promotion-20260811T143400Z` with `SHA256SUMS` digest
  `f0867986a23f8b03b919e3117616ee6e18d5ab7dd09b89873bb1f538778cbabc`.
  These migration-024 images are historical rollback artifacts only. Migration
  `025` has touched the live volume, so `47e66d…`, `f907528e…` and older images
  must never be started on it; data rollback requires restoring the verified
  pre-m025 archive into a new volume and accepting post-backup data loss.
- [x] Server synchronized-draft foundation: authenticated per-chat GET/PUT/DELETE, 10,000-code-point and well-formed-Unicode bounds, same-chat live reply validation, account+chat monotonic CAS including delete tombstones, encrypted text/exact-retry receipts, stable nonces and migration `025`. Membership removal atomically scrubs the active draft, receipts and historical draft events/outbox; remove/re-add does not revive an old draft or nonce. PUT+DELETE share bounded session/account rate limits, outbox heads preserve per-audience order, and V2-only `chat.draft.changed` reaches only the owning account's authorized sessions. Unknown/inaccessible chats share one 404 boundary. The application server can decrypt drafts: this is not E2EE. The strict 12-collection reconciliation snapshot remains unchanged and iPhone recovers drafts through authorized lazy GET. Exact-tree evidence passes API 71 files/626 tests, protocol 11 files/89 tests and both typechecks. The exact `f9dbff7f…20e6d` image passed restored-m024 rehearsal and Trivy, then promoted to migration `025`; final pre-cutover backup `Beta-0.1/pre-live-m025-final-cutover-20260815T122438Z` verifies with `SHA256SUMS` digest `87c0ac8dfc63f4626a07f6bec084a55d4d1e412a2cdf1fa155d38d5f23ed30ae`. Postpromotion draft HTTP+V2 Swift integration passes 1/1 in 0.557 s, with SQLite integrity/FK and outbox pending/failed counts clean.
- [ ] Quotes, scoped deletion, scheduled send, threads/comments and per-chat notification overrides.
- [x] Text-only scheduled send (migration `029_scheduled_messages`): `POST /v1/chats/:id/scheduled` (60 s minimum lead, 365-day horizon, no attachments in Beta-0.1), per-chat pending/failed list with opaque cursors, owner-only cancel, and a 30-second dispatcher that replays the exact live-send guards (membership, relationship/privacy, posting permission, topic, reply target) with bounded failure codes; the scheduled client nonce becomes the message nonce so a crash-retry cannot duplicate. iPhone composer sheet with date picker written, awaiting Xcode/CI verification (billing-blocked). Evidence: protocol 14 files/97 tests PASS; API 75 files/639 tests PASS.
- [ ] Moderation, audit, slow mode, lockdown, reports/appeals and onboarding.
- [ ] Permission property tests and moderation abuse simulations.

## Server Phase 4 — media/files

- [x] Scoped resumable chunked upload plus authorized full/Range download foundation for local/S3 storage.
- [x] Current object authorization, quota reservation, encrypted staging, restart resume and abandoned/orphan cleanup tests.
- [x] MIME/magic allowlist, honest `unscanned` state, forced download and `private, no-store` preview boundary.
- [x] Adversarial upload/media IDOR, block-direction download/search/forward revocation, mixed-grant atomicity and owner/group non-regression tests.
- [x] Local encrypted-blob fail-closed header/length/GCM/source-hash/path/Range/fsync tests plus hermetic S3 range/body/encryption/canary tests.
- [x] Filename traversal/control/bidi rejection, malformed chunk/Range matrices, late-completion duplicate and failed-upload quota-release tests.
- [x] Disposable live S3-compatible gate proves a private versioned bucket, prefix-scoped non-admin identity, local static-key SSE-S3 write/read confirmation, lifecycle configuration, versioned-delete residue, real provider CRUD/Range and committed-PUT-response-loss cleanup with exact synthetic purge.
- [ ] Production provider public-access-block/account controls, workload IAM, managed KMS key policy/rotation/audit, observed lifecycle execution and version/delete propagation evidence.
- [ ] Polyglot/zip-bomb corpus plus Moderated malware quarantine/probe/transcode pipeline.
- [x] Image/video/video-message/audio/voice/file contracts with explicitly client-declared metadata trust.
- [x] Voice-note server bounds (no migration: metadata is an encrypted envelope): `voice`/`audio` uploads reject client-declared `durationMs` above 60 minutes (`VOICE_NOTE_MAX_DURATION_MS`) and require a non-empty `waveform` when one is declared; protocol keeps duration/waveform additive and bounded. Evidence: API media voice-policy integration test (create-only, no bytes moved) green. Client recording/playback UI is written (`PhoneVoiceRecorder`, waveform bubble, inline player, composer voice button) but awaits Xcode/CI verification — GitHub Actions is billing-blocked as of 2026-09-12. Transcript-consent UX remains open.
- [ ] Verified photo/video/audio metadata extraction, GIF/sticker/custom-emoji/document/large-file processing.
- [x] Voice/video notes, waveform/thumbnail/duration and transcript consent boundary (server slice): `POST /v1/chats/:id/messages` accepts `transcriptionConsent` (refined: requires attachments); `PUT /v1/messages/:id/transcript` attaches one receiver-made transcript only to consenting voice/audio messages — first nonce wins, same-nonce replays, different-nonce conflicts, DB trigger + SQLite checks enforce consent; transcripts are server-readable (cloud preview, no E2EE) and disclosed as such. Migrations `027_message_transcription_consent` + `028_message_transcript_commands`. iPhone decode/UI written, awaiting Xcode/CI verification (billing-blocked). Evidence: protocol 13 files/95 tests PASS; API 74 files/637 tests PASS.
- [ ] Encrypted Private blob/derivative design after crypto gate.

## Server Phase 5 — search/push/realtime/jobs

- [x] Permission-first current message/file blind-index search with membership filtering and key-backfill foundation.
- [ ] Complete people/chat/public-space search, ranking, pagination abuse and inaccessible-snippet corpus.
- [ ] Local-only Private search contract and encrypted local-index semantics.
- [ ] APNs/FCM/Web Push token lifecycle and opaque/minimized payloads.
- [x] APNs registration foundation: current-session upsert/rotate/transfer/revoke, encrypted token at rest, token-free projection, strict app topic/environment boundary, session-revoke cascade and synchronized global notification preferences with hidden previews by default. The full merged protocol/API regressions pass at 9 files/68 tests and 64 files/567 tests respectively. Fresh-volume, stopped real-data clone and live HTTP/hardening checks pass on migration 021 with rollback and sealed backup retained. Real APNs provider credentials/delivery/410 feedback and real-device delivery evidence remain open.
- [ ] Synced notification, mute, presence and multi-device state.
- [ ] Durable jobs/retry/dead-letter/idempotency and replay retention.
- [ ] Rolling deploy/reconnect storm/no-snippet-leak evidence.

## Server Phase 6 — calls

- [x] Loopback-only digest-pinned LiveKit/coturn harness, health/metrics and TURN REST-auth accept/reject smoke.
- [x] Isolated versioned call-control aggregate/persistence contract with deterministic table/property tests (not API-integrated).
- [x] Least-privilege SFU/TURN grant descriptor model with bounded TTL/source/epoch tests (signers and endpoints not integrated).
- [ ] Versioned 1:1/group/room signaling state machine.
- [ ] Scoped short-lived TURN credentials, quotas and relay privacy mode.
- [ ] SFU roster/membership/quality adaptation and capacity model.
- [ ] Screen-share source/indicator/pause/stop/crash cleanup.
- [ ] Call race, network lab, abuse, accessibility and cost tests.
- [ ] Audited media E2EE/key verification before protected-call claim.

## Server Phase 7 — key management/E2EE

- [ ] Maintained audited protocol/library profile; no custom crypto.
- [ ] Per-device key packages/link/revoke/reset/loss and epoch updates.
- [ ] FS/PCS, verification and key transparency/independent monitor.
- [ ] Private media/search/push/report/backup boundaries.
- [ ] Cross-platform vectors, interop, downgrade/rollback/fuzz/property tests.
- [ ] Independent audit with zero unresolved Critical/High.
- [ ] Kill switch/upgrade path with no plaintext fallback.

## Server Phase 8 — production storage/operations/DR

- [ ] Production database ADR and representative load/failure tests.
- [ ] Rolling schema migration and scalable cross-process realtime fan-out/broker delivery.
- [ ] Queue/cache/object/search lifecycle and deletion propagation.
- [ ] KMS/IAM/JIT access, SBOM, artifact signing/attestation.
- [ ] Golden signals plus send/dispatch/resume correctness dashboards.
- [ ] Alerts/runbooks/on-call/canary/rollback and incident tabletops.
- [x] Offline preview restore verifies checksums, permissions, migrations and local object references.
- [ ] Encrypted/off-host automated backups, retention/deletion, target object-store recovery, measured RPO/RTO and DR game day.
- [ ] External pentest and remediation retest.

## Thin iPhone server harness — allowed now

- [x] Initial typed HTTP/WS adapter for auth/chat load/send and basic message/typing realtime.
- [x] Keychain credential and serialized single-flight refresh harness.
- [x] CI-pinned XcodeGen configuration produces an iPhone-only `LuxoraMobile` project, double-generation diff-checks cleanly, bundles the canonical root logo and passes a generic iOS Simulator build on Xcode 26.6.
- [x] Native phone `NavigationStack` plus tested restoring/unauthenticated/connecting/connected/offline/error/preview root-state checkpoint, with tested cancellation/send gating and audited old-session isolation.
- [x] Signed iPhone 17 Pro Simulator evidence loads two accepted Directs and a four-message history from a real local API/realtime handshake; canonical lowercase UUID paths and the no-microphone-before-media-gate composer truth are regression-tested, with three connected PNGs in the repository root.
- [x] `LuxoraMobile` and `LuxoraDesignLab` are separate apps and UI-test bundles; deterministic fixtures are linked only by Design Lab and cannot provide a production entry path.
- [x] Ten full-frame Design Lab screens and one fixture-free production authentication state are captured on iPhone 17 Pro, visibly classified as implemented fixture or concept-not-implemented, checksum-indexed in `screens_app_iphone/manifest.json`, and visually inspected without clipped evidence.
- [x] Production authentication resolves a failed server capability request after an explicit debug session reset and keeps passkeys disabled with an honest unavailable reason.
- [x] Historical checkpoint (superseded): the English Inbox/Spaces/Calls/Search/You shell and `production/v2-five-tab-shell` evidence remain only as an implementation record; they are not the current Russian Telegram-reference UI.
- [x] Historical checkpoint (superseded): the English You/settings `production/v3-you-settings` captures remain only as an implementation record; they are not current acceptance evidence.
- [x] Russian-first Apple localization foundation is packaged with `defaultLocalization: ru`; authentication, shell, errors and linked legacy views pass the repository Russian UI source scan, 20 package tests pass with only the opt-in live-backend test skipped, and the current iPhone Debug target builds for a generic Simulator.
- [x] Independent full-reference QA inspects all 62 immutable user screenshots at original detail, verifies every source SHA-256, records per-file hierarchy/controls/scroll/runtime/backend/test truth in `screens_app_iphone/full_reference_qa/`, and makes only those 62 screenshots authoritative; generated boards remain visual-only, while the old username/password primary auth is explicitly superseded by the required Russian country/phone → OTP → name/profile flow.
- [x] The primary iOS auth surface implements Russian `Старт → страна/номер → OTP → имя/профиль → username → разрешения → Чаты`, exact live API adapter calls, disabled invalid CTAs, masked phone, resend timer and a truthful DEBUG-only traversal. The complete searchable country picker, combined E.164 bound, reviewed SVG contour route and iOS 26 presentation behavior are covered by Xcode UI tests. Merged package verification executes 39 XCTest cases with 38 passes plus one expected opt-in live skip, and three additional Swift Testing cases pass; a separate opt-in fixture-free iPhone 17 Pro run completed the real challenge/OTP/profile-required/username/registration/sync path and persisted the restored session. Seven full-device, checksum-verified frames are retained in `screens_app_iphone/production/v6-live-phone-onboarding-ru/`; their README explicitly leaves Telegram 1:1 acceptance open.
- [x] Connected iPhone chat/navigation checkpoint: remote refresh/load/error/retry, optimistic text retry with the same nonce, mark-read, reaction add/remove, known-contact search and direct-chat creation are implemented and live-tested against the local API. Profile copy/share/QR, loaded-message contact search, persisted contact sort, folder filter/count/reset and real iOS permission-state routes are implemented with unsupported server actions locked. Merged Swift tests, Xcode build, 2/2 chat UI smokes and 3/3 navigation smokes pass; eight selected full-device captures and honest gap lists are retained in `screens_app_iphone/production/v7-live-chat-functions-ru/` and `v7-telegram-navigation-settings-ru/`. This closes a functional checkpoint, not the 62-screen pixel gate.
- [x] Synchronized iPhone chat-folders v13 checkpoint: system All/Archive, horizontally scrollable custom folders, strict rules/explicit overrides/custom pin order, server-confirmed settings/editor mutations, Russian selected states and process-safe DEBUG route automation are wired into the production SwiftUI shell. At that historical checkpoint, package verification executed 259 XCTest cases with 4 expected live-only skips and 0 failures plus Swift Testing 8/8. The visual journey passes 1/1 in `Test-LuxoraMobile-2026.08.11_17-49-50-+0300.xcresult`; the final folder/navigation/accessibility group passes 4/4 with 0 failures/skips. Seven final 1206×2622 frames, a truthful separate-launch/real-swipe archive record and verified manifest/SHA are retained in `screens_app_iphone/production/v13-chat-folders-ru/` and were inspected by root plus an independent reviewer; v13 has no P0/P2 finding. This is deterministic UI evidence, not a live-backend screenshot claim, offline/process-death proof or 62/62 pixel closure.
- [x] Message Requests iPhone functional checkpoint: incoming/outgoing lists, exact-username recipient lookup, nonce-stable creation, atomic accept into a direct chat with the server-confirmed first message, recipient-private dismiss and server-confirmed privacy GET/PATCH are wired through `ApplicationSession`/`MessengerStore`. Loading/empty/error/retry/destructive-confirmation states are real, inconsistent projections are rejected, 17 non-live selected package tests pass, the separate fixture-free Docker journey passes 1/1, and one signed iPhone 17 Pro Max unified run passes 4/4. Eleven visually inspected 1320×2868 captures plus README/SHA are retained in `screens_app_iphone/production/v10-message-requests-ru/`. Cursor pagination, offline/process-death recovery, realtime reconciliation and the complete pixel/accessibility/release gates remain open.
- [x] iPhone APNs registration/global notification-settings foundation: AppDelegate token bridge, strict token-free API/store, token-before-session/session-before-token ordering, rotation/signout/replacement/late-401 fences, permission-denied unregister and Debug/Release environment mapping are implemented. Focused tests pass 17/17, merged Swift package executes 150 with 2 expected skips and 0 failures plus Swift Testing 3/3, and signed compile is green. Real Apple credentials/device delivery, foreground/background payload handling and 410 feedback remain open.
- [x] Postpromotion live iPhone integration checkpoint: Community, Message Requests, registration/chat/mutations and scoped V2 preferences/recovery journeys all pass. The first combined live run hit global HTTP 429, after which its two affected paths passed isolated retries; do not describe this as one uninterrupted monolithic live run.
- [x] Account/session-scoped iPhone durable text foundation: atomic schema-v2 confirmed conversation/message cache, v1 migration, corruption quarantine, ordered stable-nonce outbox, single-flight retry, committed-response-loss recovery, persisted V2 checkpoint metadata and exact logout/session-replacement fences are wired into the production session. At that slice checkpoint, focused tests passed 11/11 and the merged package passed 278 XCTest cases with 5 expected live-only skips plus Swift Testing 8/8. This stores message plaintext under iOS data protection because Beta-0.1 has neither E2EE nor an encrypted local database; it is not a full offline, privacy, scale or process-kill acceptance gate.
- [x] iPhone global-search v14 checkpoint: production store/UI searches server-authorized people and messages, displays server file projections, searches already-synchronized chats/channels locally and opens people/message results. Fixture-free Swift→Docker search passes 1/1; the deterministic production-target UI journey passes 1/1 and retains two reviewed checksum-verified 1206×2622 frames in `screens_app_iphone/production/v14-global-search-ru/`. Public people/space discovery, multi-page live UI, file open/download, exact message jump/highlight, offline indexing and the 62-screen gate remain open.
- [x] iPhone synchronized-drafts v15 checkpoint: authorized load/autosave/delete, same-chat reply context, cross-chat restore, 750 ms global pacing, bounded retry/backoff, actionable `Retry-After`, exact-replay authoritative refresh, realtime/session fences and membership/lifecycle purge are wired through production stores and views. Focused draft tests pass 48/48, Messenger/reconciliation 26/26 and capability 11/11; the full package passes 351 XCTest cases with 6 expected live-only skips and 0 failures plus Swift Testing 11/11. Debug automation passes 5/5. The post-patch iPhone 17 Pro/iOS 26.5 production-target UI journey passes 1/1 in 75.079 s with zero `Invalid frame dimension` findings, and three reviewed checksum-verified frames are retained in `screens_app_iphone/production/v15-synchronized-drafts-ru/`. A separate postpromotion Swift→Docker HTTP+V2 run passes 1/1. The screenshots themselves use a DEBUG-only server-shaped fixture; offline local persistence, process-death/poor-network conflict proof, multi-device and real-device release gates remain open.
- [ ] Current Telegram-reference iPhone pass: native iOS 26 shell is implemented as Контакты/Звонки/Чаты/Настройки plus a separate Поиск control; overflow folder/status rails, dense chats and expanded Russian Settings are implemented. All 62 primary references are reviewed/mapped and seven same-size overlays expose remaining deviations. Live new-account phone onboarding is now closed, while P0 routes and the full 62-screen 1:1 Russian acceptance set remain in progress.
- [ ] P0 pixel closure 01/02/04: Chats remains `0.1301 / 0.3281` with header/actions/rows open; Contacts improved to `0.0660 / 0.4132` but exact row/avatar/alphabet detail remains open; Search improved to `0.0992 / 0.3535`, while public/global taxonomy, multi-page live behavior and exact result navigation remain gated.
- [ ] P0 truth/geometry closure 03/24/27: Calls intentionally shows an empty signaling gate (`0.0951 / 0.2397`); Contact profile has aligned main Y-bands (`0.1451 / 0.3643`) but locked media/actions; Direct chat (`0.2184 / 0.1662`) still differs in message heights/content and lacks durable media.
- [ ] P0 phone-auth QA: successful `profile_required` and existing-account `password_required` live handshakes, complete country picker, combined E.164 validation, exact native contour route and restored sessions are proven. Still prove expiry, wrong-code attempt exhaustion, resend/rate-limit and recovery branches through the real iPhone client, then retain the complete UI suite as one release artifact.
  - [x] Server-integrated recovery client slice (2026-09-10): `LuxoraPhoneAuthenticationScreen` gains a «Забыли пароль?» recovery step wired to `POST /v1/auth/phone/recovery/start|complete` through `ApplicationSession.startPhoneRecovery/completePhoneRecovery` with nonce-retaining command tracking, `binding_verified` decoded as an additive verify-response union member, and new `PHONE_AUTH_RECOVERY_*` failure classifications with Russian copy. Swift Testing suites cover the recovery/binding request contracts, recovery intent decoding, binding status handling and failure classification. Live Xcode verification and the binding settings UI journey remain open (Windows cannot run Xcode; verification via GitHub Actions macOS CI).
- [x] P0 registration/profile client path: name, optional circular avatar crop, optional 500-character bio, server username availability/errors/suggestions, permission rationale, explicit account synchronization and Chats are implemented. Onboarding and profile editing use the real resumable upload → processed avatar binding; fixture-free runs prove crop/upload/save, terminate/relaunch server restore and clear. Expiry/rate-limit/storage-pressure, poor-network and real-device evidence remain open.
- [x] P0 existing-account/2FA functional checkpoint: real phone → OTP → `password_required`, invalid-password rejection, correct login, server password change and disable pass fixture-free 1/1 after fixing the SwiftUI focus/root-replacement race. Expiry/exhaustion/recovery and complete release UI coverage remain open.
- [ ] P0 contextual permissions: the production first-install rationale and user-triggered notification/contact requests are implemented; camera, microphone and photo usage descriptions are packaged and those permissions remain deferred until first relevant use. Still cover allow/deny/limited/restricted, Settings recovery and OS-state recheck with retained UI tests on supported OS versions.
- [ ] P0 remaining 20–23 and 25–31: ownership-aware context menus, channel/group/contact profiles, direct/saved/channel/group conversations and mutation/failure states still lack 1:1 runtime captures/tests.
- [ ] P1 05–19 and 32–35: Settings root remains `0.1941 / 0.2209`; v13 retains accepted folder settings/editor evidence, while the remaining long-scroll/profile/device/notification/data/storage/appearance/power/language/support/QR/privacy screens still need complete Russian family-17 coverage without Telegram commerce or unsupported promises.
- [x] The retained post-patch v15 cross-chat composer/keyboard journey has 0 `Invalid frame dimension (negative or non-finite)` findings in the build log, test activities and xcresult binary tree. This closes the documented warning on that exercised path, not a whole-app warning/performance gate.
- [ ] Complete the durable foundation as an indexed encrypted local database with quota/eviction, offline launch, offline/local durable drafts, media/edit/delete/forward queues, reconnect storm/conflict handling and real terminate/relaunch/poor-network tests. Confirmed snapshots, stable-nonce text replay, server-synchronized online drafts, schema migration/corruption recovery and persisted V2 checkpoint are implemented and unit-tested; JSON whole-state storage and Simulator/unit evidence do not close this product/release gate.
- [ ] Add media/push/call/E2EE interop fixtures only when corresponding server phase is testable.
- [ ] Keep it synthetic/minimal; no broad product polish or fake completion.

## Full iPhone — blocked until server complete

- [ ] Full product information architecture and every planned flow.
- [ ] Complete auth/devices/chat/community/media/search/push/call/privacy UX.
- [ ] Offline/background/recovery/storage-pressure behavior.
- [ ] VoiceOver/Dynamic Type/RTL/localization/Reduced Motion/Transparency.
- [ ] Real-device performance/energy/crash/security and App Store rollout gates.

## Frozen until server + full iPhone stable

- [ ] iPad full client.
- [ ] macOS full client.
- [ ] Android full client.
- [ ] Authenticated Web client.
- [ ] Windows/Linux full clients and signed update channels.
- [ ] Public site feature/download/security publication.

Only build/security/truth/accessibility maintenance is allowed in these foundations meanwhile. They must not invent independent protocol semantics.

## Brand contour loader — approved design, integration sequenced

- [x] Preserve the supplied root logo and derive a transparent RGBA master without replacing it.
- [x] Specify dark/true-black and light/true-white contour-loader modes with two same-direction, always-opposing points and compact rays.
- [x] Extract and visually review one closed SVG motion route across the logo's outer edge and internal ribbon loop; keep the logo and complete route invisible in the loader.
- [x] Add a standalone design preview plus Reduced Motion/Transparency, high-contrast, lifecycle and timing rules.
- [x] Port the reviewed SVG route into platform-native SwiftUI contour data using the reviewed 1254-unit source coordinates and uniform transform.
- [x] Wire the invisible-route, two-runner contour reveal into the iPhone first-launch screen with Reduced Motion handling.
- [x] Replace the generic session-restoration progress view with the proven contour treatment and validate cancellation/failure recovery. The production root now restores a real Keychain session through the invisible two-runner route, exposes cancel/error/retry/sign-in-again states, passes Reduced Motion/Transparency and VoiceOver simulator gates, and retains a fixture-free bad-API → retry → live Chats journey. Real-device energy remains separate below.
- [ ] Validate the loader on real iPhone hardware for VoiceOver, motion settings, energy, launch time and failure recovery.
- [ ] Wire the loader into the public/download website only after that phase is unfrozen and prove no LCP/INP regression.
- [ ] Port the proven loader to remaining clients in the approved client order.

## Required release evidence

- [ ] Commit/build/image/artifact digests and toolchain matrix.
- [ ] Raw unit/integration/UI/performance/security/accessibility reports.
- [ ] Open defects by severity and expiring exceptions.
- [ ] Claim inventory with evidence/owner/review date/kill switch.
- [ ] Backup/restore, rollback and incident drill records.
- [ ] Product, Engineering, Security, Privacy, QA and Operations decision.

Binding criteria: [docs/specs/RELEASE_QUALITY_GATES.md](docs/specs/RELEASE_QUALITY_GATES.md).
