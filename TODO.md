# Luxora Engineering TODO

**Релиз:** Beta-0.1  
**Владелец и разработчик:** Flenym  
**Обновлено:** 4 августа 2026

`[x]` means a repository foundation exists, not that a production gate passed. Execution order is server-complete → full iPhone → all other clients/public site.

## Immediate truth/build blockers

- [x] Only `Beta-0.1` appears as visible release metadata; only Flenym as owner/developer; repo-wide classified metadata gate passes while excluding internal package/API/platform versions.
- [ ] All simulated call, E2EE, delivery, presence, download and sync UI is removed or clearly labelled demo/roadmap.
- [x] Root editor/ignore/Make/Compose conventions exist.
- [x] Node, Apple, Android and security/container CI definitions exist.
- [x] API ships from a digest-pinned Debian 13 distroless Node 22 runtime as
  UID/GID `65532`, without shell/npm/Corepack. The exact local image passes
  Trivy 0.73 with 0 High/Critical vulnerabilities and 0 secrets, hardened phone
  registration/exact replay/authorized-me smoke, API log/DB canary and the live
  disposable S3-provider gate; cloud deployment scanning/signing/provenance is
  still a separate production gate.
- [ ] First clean-checkout runs are PASS and retained as release evidence.
- [ ] Branch protection and mandatory sensitive-path review are configured.

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
  - [ ] Wire and qualify a real production SMS provider (the external provider remains an injected interface and startup fails closed without one), distributed IP/phone/risk abuse controls, delivery observability, retention/cleanup and production-database fault injection.
  - [ ] Add the requested optional post-OTP secret-password/second-factor state, secure recovery, and a verified phone-binding path for pre-phone legacy accounts; current phone-created accounts intentionally have password auth disabled.
  - [ ] Add pre-auth avatar upload/crop/profile binding or a safe post-registration profile-update flow, then prove expiry/retry/rate-limit/existing/profile-required branches through the real iPhone client. Default initial/color avatars remain a client presentation concern until this exists.
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
- [ ] Quotes, scoped deletion, scheduled send, threads/comments/archive/folders/drafts/notification state.
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
- [ ] Verified photo/video/audio metadata extraction, GIF/sticker/custom-emoji/document/large-file processing.
- [ ] Voice/video notes, waveform/thumbnail/duration and transcript consent boundary.
- [ ] Encrypted Private blob/derivative design after crypto gate.

## Server Phase 5 — search/push/realtime/jobs

- [x] Permission-first current message/file blind-index search with membership filtering and key-backfill foundation.
- [ ] Complete people/chat/public-space search, ranking, pagination abuse and inaccessible-snippet corpus.
- [ ] Local-only Private search contract and encrypted local-index semantics.
- [ ] APNs/FCM/Web Push token lifecycle and opaque/minimized payloads.
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
- [ ] Current Telegram-reference iPhone pass: native iOS 26 shell is implemented as Контакты/Звонки/Чаты/Настройки plus a separate Поиск control; overflow folder/status rails, dense chats and expanded Russian Settings are implemented. All 62 primary references are reviewed/mapped and seven same-size overlays expose remaining deviations. Live new-account phone onboarding is now closed, while P0 routes and the full 62-screen 1:1 Russian acceptance set remain in progress.
- [ ] P0 pixel closure 01/02/04: Chats remains `0.1301 / 0.3281` with header/actions/rows open; Contacts improved to `0.0660 / 0.4132` but exact row/avatar/alphabet detail remains open; Search improved to `0.0992 / 0.3535` but global result taxonomy and live server search remain gated.
- [ ] P0 truth/geometry closure 03/24/27: Calls intentionally shows an empty signaling gate (`0.0951 / 0.2397`); Contact profile has aligned main Y-bands (`0.1451 / 0.3643`) but locked media/actions; Direct chat (`0.2184 / 0.1662`) still differs in message heights/content and lacks durable media.
- [ ] P0 phone-auth QA: successful `profile_required` live handshake, complete country picker, combined E.164 validation, exact native contour route and restored new-account session are proven. Still prove expiry, wrong-code attempt exhaustion, resend/rate-limit and existing-account branches through the real iPhone client, then retain the complete UI suite as one release artifact.
- [x] P0 registration onboarding client path: name, optional circular avatar crop, optional 500-character bio, server username availability/errors/suggestions, permission rationale, explicit account synchronization and Chats are implemented. A live no-avatar new-account run proves profile, username, registration and deterministic colored-initial fallback. Remote avatar persistence remains correctly unclaimed until the server exposes an upload/profile-update endpoint.
- [ ] P0 existing-account/2FA onboarding: route authenticated users through explicit sync/recovery; add `password_required` only after the backend discriminator and verification contract exist. Current decoder supports only `authenticated` and `profile_required`, so a password mock cannot close 2FA.
- [ ] P0 contextual permissions: the production first-install rationale and user-triggered notification/contact requests are implemented; camera, microphone and photo usage descriptions are packaged and those permissions remain deferred until first relevant use. Still cover allow/deny/limited/restricted, Settings recovery and OS-state recheck with retained UI tests on supported OS versions.
- [ ] P0 remaining 20–23 and 25–31: ownership-aware context menus, channel/group/contact profiles, direct/saved/channel/group conversations and mutation/failure states still lack 1:1 runtime captures/tests.
- [ ] P1 05–19 and 32–35: Settings root remains `0.1941 / 0.2209`; complete all long-scroll/profile/device/folder/notification/data/storage/appearance/power/language/support/QR/privacy screens in Russian, using all five family-17 layouts without Telegram commerce or unsupported promises.
- [ ] Durable outbox/cursor/reconcile harness with poor-network tests.
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
- [ ] Replace the generic session-restoration progress view with the proven contour treatment and validate cancellation/failure recovery.
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
