# Luxora Roadmap

**Публичный релиз:** Beta-0.1  
**Владелец и разработчик:** Flenym  
**Правило:** этапы — внутренние workstreams, не новые версии и не обещанные даты.

## Non-negotiable sequence

```text
1. COMPLETE SERVER PLATFORM
   ↳ thin iPhone integration harness may verify contracts only
2. COMPLETE iPHONE PRODUCT
3. UNFREEZE iPAD / macOS / ANDROID / WEB / WINDOWS / LINUX / PUBLIC SITE
```

The repository currently contains a complete local Phase-1 text foundation and
tested partial foundations from later phases: rich media/storage/search, IA-1
relationships/safety, an isolated call-control domain and loopback SFU/TURN.
This is still not a complete server, and a later-phase foundation does not pass
that phase's production gate. Client foundations do not move server phases
forward unless they produce server-contract evidence. Truth/security/build
fixes remain allowed everywhere.

## Phase 1 — text vertical slice

Status: **implemented foundation; release evidence incomplete**.

Present:

- shared strict schemas and tests;
- register/login/refresh/device sessions and revoke;
- direct/group/channel creation and authorized reads;
- idempotent text send, reply reference, edit revision, tombstone, reactions;
- explicit delivered/read receipts;
- realtime auth, replay, typing, presence, heartbeat, backpressure and session revoke;
- SQLite WAL, migrations, optional/production-required content envelopes;
- health/readiness/OpenAPI/basic metrics and container baseline.

Exit tasks:

- clean-checkout CI evidence and repository truth scan;
- full current-endpoint authorization/rate/concurrency/fuzz matrix;
- authoritative reconciliation/cursor retention contract;
- canary log-leak proof, latency/correctness metrics and backup/restore drill;
- compatibility fixtures and capability negotiation.

## Phase 2 — identity, devices and access platform

Priority: **server P0**.

- Passkeys/WebAuthn, multiple authenticators, recovery and step-up.
- Device identity, QR linking approval, session compromise response and audit.
- Username/verified-channel discovery with enumeration limits.
- Message requests, accept/delete/block/report; no presence/receipt/call before accept.
- Contact/discoverability/privacy policy enforcement and data inventory.
- Account export/delete/retention lifecycle.

Gate: auth/identity threat cases, IDOR/BFLA, phishing/recovery tabletop and production secret/key rotation evidence.

## Phase 3 — complete conversation/community domain

Priority: **server P0**.

- Direct, Saved, Circles/groups, supergroups, channels and immutable trust classes.
- Membership lifecycle, owner/admin/moderator/member roles and effective permissions.
- Replies/quotes/forwards, pins, edit history, delete scopes, drafts, scheduled send.
- Topics, threads, channel comments, archive, folders and notification state.
- Moderated Spaces, onboarding, roles, audit log, slow mode, lockdown, reports/appeals.
- Stable deep links, search authorization and cross-version event semantics.

Gate: permission property tests, membership removal latency, moderation abuse cases and all conflict/offline states.

## Phase 4 — media, files and content processing

Priority: **server P0**.

- Scoped resumable/chunked direct-to-object upload and download.
- Quotas/reservations, abandoned-part cleanup and lifecycle deletion.
- MIME/magic/polyglot/zip-bomb handling; Moderated quarantine/transcode.
- Photo/video/GIF/sticker/emoji/document/large-file metadata contracts.
- Voice and video messages, waveform/duration/thumbnail and opt-in transcript boundary.
- Client-encrypted Private blobs/derivatives after crypto profile approval.

Gate: authorization/cache isolation, parser corpus, resume/interrupt, malware policy, cost controls and accessibility alternatives.

## Phase 5 — search, push and realtime completion

Priority: **server P0**.

- People/conversation/message/file/public-space search with permission-first filtering.
- Local-only Private content indexing contract; no server plaintext/search query.
- APNs/FCM/Web Push token lifecycle and content-minimized payload service.
- Durable notification preferences, mute/mentions/quiet schedule.
- Presence privacy, delivery/read aggregation, multi-device drafts/settings.
- Queue workers, idempotent jobs, retries/dead-letter and replay retention.
- Reconnect storm, rolling deploy and gap reconciliation evidence.

Gate: no inaccessible snippets, no Private plaintext leak, revoked-device cleanup and measured delivery/reconnect behavior.

## Phase 6 — calls platform

Priority: **server program, independently gated**.

Canonical design and the truth boundary: [docs/specs/CALLS_PLATFORM.md](docs/specs/CALLS_PLATFORM.md).

- Versioned signaling state machine for 1:1/group/drop-in/scheduled calls.
- Short-lived scoped TURN credentials, relay policy and abuse quotas.
- SFU topology, roster/epoch/membership, grid/focus metadata and network adaptation.
- Screen-share source/indicator/pause/stop lifecycle and crash cleanup.
- Noise/echo/high-fidelity capability negotiation.
- Call metrics without media/content; capacity and relay-cost controls.
- E2EE media-key design/verification only after audit; SFU/TURN never receives media keys for that claim.

Gate: race/property tests, Wi-Fi/mobile/high-loss lab, TURN exhaustion, privacy/accessibility, independent security review. No client may show a working/protected call before this and its own end-to-end gate.

## Phase 7 — key management and Private E2EE

Priority: **server/security program, independently gated**.

- Select maintained audited 1:1 and group libraries/profile; no custom crypto.
- Per-device identity/prekeys/key packages, authenticated link/revoke/reset/loss.
- Forward secrecy, post-compromise security and group membership epochs.
- Key verification and append-only transparency with independent monitor.
- Encrypted media, local search, push, reports and translation/AI boundary.
- Opt-in encrypted backup/restore with user-only recovery secret.
- Cross-platform vectors, interop, loss/reorder/rollback/downgrade/property/fuzz tests.
- Independent design/implementation audit; migration/kill switch without plaintext fallback.

Gate: every `SEC-E2EE-*` quality gate passes before any `Private`/E2EE public copy. Server completion means this subsystem is evidence-ready, not merely coded.

## Phase 8 — production data and operations platform

Priority: **server P0, required to call the platform complete**.

- Production DB decision/load evidence; rolling migrations and transactional outbox.
- Stateless API/realtime scaling, bounded cache/queue dependencies and regional plan.
- Object/search/push/call data retention and deletion propagation.
- KMS/IAM/JIT privileged access, secrets, signing, SBOM/provenance.
- Golden-signal plus send/dispatch/resume correctness telemetry.
- Actionable alerts/runbooks, canary/rollback/kill switches and on-call.
- Encrypted backups, integrity/permission restore, measured RPO/RTO, chaos/DR game day.
- Abuse operations, legal/privacy purpose controls and audited support access.

Gate: production-like load/failure, no acknowledged message loss, external pentest/remediation and timed restore evidence.

## Thin iPhone integration harness during server phases

Allowed only to validate real contracts:

- typed HTTP/WS adapter and golden fixtures;
- Keychain session storage and refresh serialization;
- durable outbox/cursor/reconciliation test shell;
- synthetic media/push/call/E2EE interop harnesses as their server phases mature;
- poor-network/background/security test evidence.

Not allowed: broad product polish, independent feature semantics, marketing screenshots implying completion or using the harness as a substitute for server gates.

## Phase 9 — complete iPhone

Begins only after Phases 1–8 satisfy the server-complete review.

- Implement the full planned product experience over stable capabilities.
- Complete onboarding/auth/devices, all chat/community/media/search/call/privacy flows.
- Offline-first local model, push/background, storage pressure and recovery.
- VoiceOver, Dynamic Type, localization/RTL, Reduced Motion/Transparency.
- Real-device performance, energy, crash-free, poor-network and security gates.
- App Store signing/privacy/support/rollout/rollback evidence.

Exit: no demo fallback on a working surface; full iPhone gate matrix PASS.

## Phase 10 — remaining clients and public site

Only stable server + full iPhone unfreeze this phase.

1. iPad and macOS may reuse proven Swift domain/network/storage while keeping native UX.
2. Android replaces demo state with the same protocol/offline conformance corpus.
3. Web separates public site/authenticated app and adopts a reviewed browser session/cache model.
4. Windows/Linux use a reviewed signed shell/updater and OS credential vault.
5. Public site publishes only evidence-backed availability, security and download claims.

Platform order within this phase may change by product evidence, but none may bypass contract and release gates.

## Review cadence

- Weekly server phase risk/dependency review.
- Every contract change: compatibility, offline/failure, privacy and rollback review.
- Monthly product-truth and data/log canary audit.
- End of each phase: clean build, raw evidence, open defects, residual risks and HOLD/SHIP decision.
- External review for crypto, auth/admin/calls and production pentest milestones.
