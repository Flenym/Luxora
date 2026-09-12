# Luxora Changelog

All user-visible and engineering changes for the only public release label are recorded here.

**Владелец и разработчик:** Flenym

## Beta-0.1 — 10 September 2026 (Windows checkpoint + phone recovery/binding)
- Restored the green Beta-0.1 checkpoint on the Windows workspace: protocol 11 files/89 tests and the full API suite pass. Fixed three portability/resource defects found while re-baselining: directory fsync is skipped on Windows (EPERM) in the local storage provider and upload staging while per-file fsync durability is preserved, and the SQLite store constructor now closes the database handle before rethrowing a migration failure instead of leaking it on every platform.
- Added the phone-password recovery server slice (migration `026_phone_recovery_and_binding`, ADR 0002): a forgotten secret password is reset through a durable single-use intent that requires the verified-OTP `passwordToken`, enforces a deliberate configurable confirmation window (`PHONE_AUTH_RECOVERY_DELAY_SECONDS`; production startup rejects < 3600 s) and a bounded completion TTL, then atomically sets the new Argon2id hash, revokes all sessions and push registrations, creates the replacement session and records append-only receipts/events. Idempotent exact replay, conflict on concurrent intents, and generic errors are covered by a dedicated integration suite.
- Added authenticated phone binding for legacy (username/password) accounts: strict begin/verify/complete flow over a dedicated binding-challenge table mirroring the login OTP state machine, `binding_verified` as an additive verify-response union member, bounded attempts with payload-free failure receipts, durable resend windows, no availability disclosure before the correct OTP, and an atomic attach that succeeds only while the number stays unbound. Phone login and the optional secret password become reachable for legacy accounts after a successful binding.
- Added four HTTP routes with route-level rate limits, extended the authorization matrix to 76 protected/public probes and the migration-chain inventory to `026_phone_recovery_and_binding`; protocol schemas, tokens (`luxrc_`, `luxbt_`), capability-neutral additive response members and their strict-validation tests were added to the shared protocol. Evidence: protocol 11 files/89 tests PASS; API 73 files/632 tests PASS; production/test typechecks green.
- Added the iPhone recovery client slice: a Russian «Забыли пароль?» step in the phone onboarding flow drives the durable recovery intent (start, confirmation-window wait, new-password completion that re-authenticates), the verify decoder accepts the additive `binding_verified` member, `PHONE_AUTH_RECOVERY_TOKEN_INVALID`/`NOT_CONFIRMABLE` map to dedicated failure states, and a new `PhoneBindingStore` + Settings binding section wire the authenticated legacy-account phone binding end-to-end. Local secrets/runtime for the Windows API preview are produced by `start.bat` (port 2222, development OTP provider, persisted `data/luxora-server.env` ignored by Git).
- Added Telegram-style direct chats: strangers now open a direct chat immediately while the recipient keeps the «Кто может написать мне» privacy gate (everyone vs contacts-only); the iPhone message-request UI was removed. Evidence: protocol 11 files/89 tests PASS; API 71 files/626 tests PASS.
- Added the loopback operator console: token-gated read-only `/v1/admin/status`, `/v1/admin/users` and `/v1/admin/chats` (secret-free cursor pagination, `private, no-store`, explicit 503 without `ADMIN_TOKEN`) plus the `apps/admin` console UI on port 4174. Moderation and user-management write actions stay out of scope for Beta-0.1. Evidence: protocol 12 files/92 tests PASS; API 74 files/635 tests PASS.

## Beta-0.1 — 3 August 2026

- Replaced the production API runtime layer with a digest-pinned Debian 13
  distroless Node 22 image running as UID/GID `65532`, with npm, Corepack and a
  shell absent from the shipped image. The exact local image passed Trivy 0.73
  with zero High/Critical vulnerability and secret findings, then completed a
  hardened live phone registration, exact replay and authorized `/v1/me` smoke;
  this remains point-in-time local evidence rather than deployed-cloud proof.
- Added the disabled-by-default Telegram-style phone-authentication server foundation: strict normalized phone challenges, six-digit OTP, anti-enumerating correct-code-only account resolution, existing-account versus registration branching, username availability/suggestions, atomic account/session creation and exact response-loss replay. Migration `018_phone_authentication` stores keyed digests plus AES-GCM envelopes and append-only audit/receipts; an independent hardening pass added a transactional per-phone resend window, provider-command retry with the same challenge ID, encrypted masked-phone storage and stable user-bound re-encryption of the verified identity number. A production SMS provider, optional post-OTP secret password, legacy-account phone binding and avatar/profile upload remain open, so the end-to-end TODO stays unchecked.
- Added the Russian phone-first iPhone harness: intro/contour transition, complete country search, phone/OTP, `profile_required` profile and bio, local circular avatar crop/fallback, live username availability/suggestions, permission rationale, explicit synchronization and Keychain restoration. A fixture-free iPhone 17 Pro Simulator UI test completed the local development-provider new-account path through Chats and restored the session after relaunch; it is not production SMS, 2FA, remote avatar persistence, durable offline or full 62-screen acceptance evidence.
- Expanded the iPhone connected messaging slice with explicit chat/message loading and retry states, optimistic text retry using the same client nonce, server read cursors and reactions, known-contact discovery and direct-chat creation. Added Telegram-like Russian chat, conversation, new-message, profile, QR, folder, privacy and Settings routes with factual locks for unsupported media/calls/profile APIs. The merged package passes 39 XCTest cases (one expected opt-in skip) plus three Swift Testing cases and an iPhone Simulator Xcode build; selected visual smokes are not a 62/62 pixel-complete claim.
- Integrated the audited passkey domain into separately gated internal-only authenticated add-authenticator/management, identifier-free sign-in and pre-account signup foundations. They use strict raw-byte HTTP handling, encrypted SQLite challenge/handle/credential state, `@simplewebauthn/server` pinned to `13.3.2`, transaction-bound authorization, atomic replay-safe commits and scheduled intent reconciliation. Every routed family remains absent by default, production startup rejects enabling it and the public capability remains `passkeys:false`; public signup/sign-in/bootstrap/management UX, notifications and recovery are still missing.
- Added durable authenticator management: encrypted Russian-capable labels, active-only secret-free projection, revision/ETag rename, atomically persisted target-bound WebAuthn revoke intent/grant, terminal credential disablement, attributed session/refresh invalidation, password-disabled last-active protection and append-only audit/outbox/encrypted idempotency receipts. Restart/response-loss, exact replay/substitution, default route-absence, guarded internal routing and independent SQLite writer races pass; this does not expose a public management API.
- Replaced boolean proxy trust with an explicit CIDR allowlist and one canonical IPv4/IPv6 abuse-bucket key across HTTP and realtime V1/V2; hostile tests cover direct/header spoofing, trusted chains, malformed values and representation rotation without claiming distributed rate limiting.
- Hardened the isolated passkey domain so a non-zero stored signature counter must strictly advance: malformed verifier successes fail before ceremony consumption or credential-store effects, honest `0→0` counters remain supported, and only coarse secret-free rejection handling is allowed.
- Added a repo-wide public metadata truth gate that enforces the sole `Beta-0.1`/Flenym product identity while distinguishing internal package SemVer, Apple bundle metadata and API/schema versions.
- Added the canonical account-free `GET /v1/capabilities` schema-v1 contract with factual HTTP/reconciliation/realtime versions, Cloud-preview trust, explicit disabled E2EE/calls/passkeys/push state, actual search availability and config-derived runtime limits; versioned fixtures cover preferred realtime v2, one-version-back v1, additive responses and required upgrade without downgrade.
- Added a digest-pinned, no-host-port live S3-compatible gate for the production provider: private/versioned MinIO, distinct prefix-scoped service identity, static-key SSE-S3 confirmation, lifecycle/versioned-delete evidence, full and Range reads, public/cross-prefix denial, committed-PUT ambiguity cleanup and exact synthetic purge. This is not cloud KMS/IAM evidence.
- Independently hardened strict refresh rotation: writer-reserved expiry sampling, session-bound standalone-atomic SQLite CAS, no family-expiry extension, signer-failure non-consumption/orphan prevention, commit-ambiguity reconciliation, safe lock-contention mapping and post-revoke cleanup isolation.
- Hardened the thin Apple server harness with Keychain-backed single-flight token refresh, monotonic realtime resume cursors, and cursor advancement for durable event types the preview does not yet render.
- Added a loopback-only, digest-pinned LiveKit/coturn infrastructure harness and an explicit calls trust/state/grant gate; this does not claim that Luxora calls are implemented.
- Added an independently audited isolated call-control package with revision/epoch races, atomic outbox/receipt contracts and least-privilege SFU/TURN grant descriptors; it is not API-integrated and does not make calls available.
- Added IA-1 exact discovery/privacy, message requests with atomic acceptance/private dismissal, directed block enforcement, selected-evidence reports and additive realtime v2.
- Added the independently audited WebAuthn ceremony-domain with exact RP/origin/UP/UV policy, secret challenge references, idempotency and credential-state CAS contracts; the later internal seam consumes it, but it still does not make passkey sign-in available.
- Added account/session-bound HMAC realtime cursors, deterministic stale/future/foreign/overflow recovery, no-adjacency checkpoints and an authorized HTTP reconciliation boundary with stable sync pagination and privacy-filtered canonical resources.

Status: server-first technical preview with a runnable text-messaging vertical slice and gated later-phase foundations. Not approved for sensitive or production use.

### Added — product and design foundations

- Canonical Luxora brand based on `logo.png`, violet/indigo/electric-blue palette, light/dark surfaces, restrained glass and reduced-motion behavior.
- Source-backed analysis of Telegram, WhatsApp, Signal, Discord and Apple design guidance.
- Product requirements, threat model, UX flows and evidence-based release quality gates.
- Detailed architecture, roadmap, backend/API/security/database/deploy/client/design/testing documentation.
- Server-first sequencing: complete server platform, then full iPhone, then remaining clients/public site.

### Added — shared protocol

- Strict Zod schemas/types for identity, sessions, chats, text messages, reactions, receipts and realtime frames.
- Protocol version, canonical release label, stable public error taxonomy and hard request limits.
- Cursor response shapes and client nonce/edit revision semantics.
- Validation tests including unknown fields, message length and Unicode code-point handling.

### Added — backend text vertical slice

- Group/channel membership lifecycle: strict list/add/role/remove HTTP contracts, one immutable owner, 200-member limit, actor-scoped exact command receipts, optimistic revisions, additive V2 current/removed audiences, sync member resources and independent SQLite writer proof that removal defeats a racing send.
- Node.js 22 + Fastify API with exact CORS, Helmet, rate baseline, body bounds, redacted errors/logging and graceful shutdown.
- Argon2id registration/login, short-lived validated HS256 access JWT, hash-only rotating refresh tokens, reuse revoke and per-device session list/revoke.
- SQLite WAL repository, transactional migrations and single-node persistence abstraction.
- Direct, group and channel creation/list/detail with membership/role authorization.
- Idempotent text send, reply target, optimistic revision edit, synchronized tombstone delete, reactions and monotonic read cursor.
- Explicit idempotent delivered/read receipts over HTTP and WebSocket.
- Realtime hello/auth/ready, authorized durable per-user sequence/replay, heartbeat, typing, presence, bounds/backpressure and active socket revoke.
- AES-256-GCM context-bound envelopes for message bodies and durable event payloads when configured; production config requires keyring.
- Health/readiness, OpenAPI/Swagger UI and basic Prometheus exposition.
- Backend/protocol unit and integration suites for auth, authorization, realtime, operations and content cipher.
- Append-only `005_identity_access_safety` migration with encrypted request/profile/block/report/event payloads and immutable identity audit rows.
- IDOR, duplicate-accept, quiet-dismiss, block-audience, selected-evidence, migration-backfill and encrypted-at-rest tests for IA-1.

### Added — client foundations

- SwiftUI shared Apple design/models/views/in-memory store, explicit local preview, thin URLSession/WebSocket/Keychain server harness, an iPhone-only mobile target plus a frozen macOS foundation, local state tests and an opt-in live handshake test. Full iPad work has not started.
- Kotlin/Compose Android adaptive demo foundation, canonical generated logo asset and local state tests.
- React/Vite responsive product site and local in-tab messenger interaction demo with explicit roadmap labels.
- Electron Windows/Linux packaging shell with sandbox, context isolation, narrow preload bridge, navigation allowlist and CSP baseline.

These foundations are not full connected clients and are feature-frozen according to the server-first roadmap.

### Added — engineering and operations

- Root `.editorconfig`, `.gitignore`, Make targets and secret-free examples.
- Multi-stage API image with a shell-free/package-manager-free non-root
  distroless runtime and local hardened Compose stack.
- Optional local Prometheus profile and baseline API alerts.
- CI for Node/protocol/API/Web/desktop, Apple Swift/Xcode, Android Gradle and truth scan.
- Dependency review, CodeQL and Trivy repository/container workflows plus Dependabot configuration.

### Security disclosures and known limitations

- Beta-0.1 is **not end-to-end encrypted**. The server processes text plaintext; storage envelopes are not E2EE.
- No production-scale database, multi-region/high-availability topology, measured SLO or completed DR.
- No public passkey signup/signin/bootstrap, authenticator-management HTTP/UX, recovery, user-facing step-up, independent security notifications, QR linking, contact upload or account export/delete/retention workers. Separate internal add-authenticator/management, sign-in and signup seams are disabled by default and forbidden in production; all keep the public capability false and are not usable public authentication features.
- First-request media/link fetching is disabled; there is no malware scanning/transcoding production pipeline, push, public Spaces or moderation case workflow.
- No API-integrated call signaling/grant endpoint, audio/video/group call client or screen sharing. The isolated call-control package and loopback SFU/TURN harness are foundations only.
- No full production-ready iPhone/Web/Android/macOS/Windows/Linux client; Apple has only the thin connected harness described above, and existing interaction states can otherwise be synthetic and are labelled demo/roadmap.
- No public signed native download artifacts or production release automation.
- E2EE, calls, media and production operations require their separate implementation, interoperability, security, accessibility, load and audit gates.

### Compatibility

- Realtime protocol `1` remains the strict messaging stream; additive identity/access events use protocol `2`.
- Node runtime requirement is 22+.
- Apple foundation declares iOS 18/macOS 15 and Xcode 26 project generation.
- Android foundation declares minimum SDK 26, target/compile SDK 36 and JDK 17.

Internal roadmap phase names are not versions; the sole public release label remains Beta-0.1.
