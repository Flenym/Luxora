# Luxora Testing Strategy

**Релиз:** Beta-0.1  
**Владелец и разработчик:** Flenym  
**Status:** foundational automated suites; production gate coverage not complete

## 1. Testing principle

Luxora optimizes for risk coverage and reproducible evidence, not a decorative coverage percentage. Messaging correctness requires adversarial retries, ordering, authorization, offline and partial failure—not only happy-path snapshots.

Current tests prove the runnable messaging/media foundation, IA-1 identity boundary, provider-gated phone-authentication slice and local client-state behavior. They do not prove the full server platform, real SMS delivery, E2EE, complete calls, push, production scale, accessibility or cross-platform availability.

## 2. Existing automated tests

### Shared protocol — 6 files / 59 tests

- registration defaults/normalization;
- strict message input and maximum bound rejection;
- resumable realtime authentication shape;
- astral emoji counted as one Unicode code point.
- strict PublicProfile/privacy/request/block/report projections and Unicode/link bounds;
- v1/v2 durable-event separation and actor/participant/recipient audience constraints.
- strict opaque-cursor, deterministic recovery-reason and no-content snapshot-manifest shapes.
- capability schema v1 construction from validated runtime state, including configured and unavailable server-search states;
- versioned golden fixtures for preferred realtime v2, one-version-back realtime v1, additive capability-v1 response fields and security-minimum `required_upgrade` without downgrade;
- additive response parsing remains tolerant while strict mutation parsing rejects unknown fields.
- authenticator-management projection accepts normalized Russian/emoji labels,
  rejects bidi controls and secret-bearing fields, binds ETag to ID/revision and
  compares RFC3339 lifecycle timestamps chronologically across offsets.
- phone-first schemas require digit-only calling codes, strict national numbers,
  six-digit OTPs and UUIDv4 nonces; verify safely discriminates
  `authenticated` from `profile_required`, while registration and username
  suggestion projections remain strict.

### API — 59 files / 552 tests

- register/login/refresh rotation/reuse revoke;
- same-process and independent-SQLite refresh races, one hash-only descendant, writer-reservation/shorter-family expiry boundaries, signer failure, forward/rollback clock movement, session-bound/standalone-atomic store CAS, lock contention, transport-cleanup failure and commit-ambiguity reconciliation;
- case-insensitive duplicate username;
- default-off phone-auth composition and capability truth, categorical
  development-provider production rejection, missing external-provider
  fail-closed behavior and secret/key-separation validation;
- phone begin/verify/register lifecycle with strict E.164 normalization,
  provider/challenge idempotency, durable same-phone cooldown across changed
  nonces, delivery ambiguity, expiry/attempt lockout and code secrecy;
- account enumeration only after correct OTP, tested existing-account
  `authenticated` and new-account `profile_required` branches, exact encrypted
  response replay, case-insensitive username availability/suggestions and
  atomic username/phone race handling;
- phone storage evidence for keyed indexes, context-bound encrypted
  phone/code/device/receipt payloads, challenge-to-identity AAD re-encryption,
  append-only audit/receipt/identity triggers and writer-transaction cooldown;
- chat membership/idempotency/edit revision authorization;
- independent two-connection SQLite chat races: exact/changed send and forward nonces, strict commit-ordered send/edit/delete timestamps under ±24-hour clocks, guarded/unguarded edit history, delete domination, immutable-ID read ties, monotonic delivered/read receipts and reaction desired state; terminal retry tests also cover edit/delete-stable encrypted command fingerprints, projection exclusion and fail-closed legacy ambiguity;
- realtime durable delivery/explicit receipts/resume;
- untrusted browser WebSocket Origin rejection;
- active realtime disconnect after session revoke;
- health/readiness and canonical OpenAPI release metadata;
- account-free `GET /v1/capabilities` with anonymous/invalid-bearer equivalence, explicit public no-store policy, OpenAPI inventory, exact configured runtime limits and actual SearchHasher false/true wiring;
- malformed/oversized body normalization;
- AES-GCM active/old-key rotation reads;
- ciphertext tamper rejection;
- mandatory production encryption-keyring validation.
- pre-account first-passkey signup service: strict accessor/proxy/coercion input,
  no username/credential availability lookup at begin, exact 32-byte candidate
  handle/challenge, signup-only authorization and refresh key namespaces,
  revision/attempt/expiry/raw-body/token/delivery substitution rejection,
  signer and verifier TOCTOU failure without ghost accounts, bounded committed
  replay, and real maintained-generator/verifier plus SQLite account creation;
- internal-only signup transport: canonical NFC begin identity/device
  forwarding, exact single idempotency/authorization/revision headers,
  query-free/no-store/ETag behavior, bounded raw WebAuthn byte digest and media
  type, conflict revision propagation, strict trusted responses and local
  anonymous 5/10-per-minute route metadata across eight tests;
- independently gated signup composition: default physical 404 and OpenAPI
  absence, complete dedicated authorization/rotated-refresh/data-key setup,
  signup-only route reachability without enabling older passkey/login gates,
  categorical production and partial/unencrypted/short-TTL rejection,
  no-store responses, permanently false public capability, startup/periodic
  expiry execution and maintenance-timer cleanup on close;
- standalone signup-expiry reconciliation: bounded ordered batches and overlap
  guard, one sampled clock, deterministic secret-free restart ownership, exact
  receipt recovery after ambiguous commit, capped SQLite BUSY/LOCKED backoff,
  hostile Store/options/ID rejection, real SQLite restart/idempotency, atomic
  challenge cleanup and two independent-writer CAS evidence;
- independent SQLite signup writer evidence for same-username and duplicate
  credential races, all-or-nothing password-disabled account/privacy/handle/
  credential/session/token consumption, and challenge/receipt/outbox integrity;
- durable authenticator management: migration-013 encrypted-label backfill and
  reopen, Russian/emoji-safe names with bidi-control rejection, active-only
  secret-free projection and exact ETags, rename replay/conflict, target-bound
  consumed/expired revoke grant rejection, attributed session/refresh revoke,
  last-active password-disabled protection, exact append-only event/outbox/
  encrypted-receipt bindings and independent-writer rename/revoke races; app
  gates also prove management paths/OpenAPI remain absent and capability false;
- append-only SQLite `001–018` inventory, clean creation/reopen, upgrades from older checkpoints without domain/event/outbox rewrites, foreign-key integrity, two live connections, simultaneous same-host clean/upgrade constructors with under-lock migration-ID rechecks, and WAL bootstrap retry plus restoration of the regular write-wait policy;
- exact discovery/privacy and stranger group/Direct consent enforcement;
- request nonce/accept concurrency, recipient-only removal and stale replay invalidation;
- either-direction block enforcement across HTTP, presence, typing, receipts and realtime replay;
- selected-evidence report IDOR/idempotency, append-only audit, encrypted IA payloads and `004→005` migration backfill.
- V2 cursor tamper/non-canonical-MAC/exact-expiry/future/unsafe-number/account-session scope rejection with deterministic malformed/mixed recovery and no numeric downgrade, plus V1 numeric replay compatibility;
- replay-window overflow, sparse-sequence checkpointing, idempotent rebuild, same-process/external session revoke, session-store fault closure and current IA replay filtering;
- stable chat/block pagination, owner-only attachment state, dynamically reprojected blocked-actor group reactions, filtered receipts and reporter-only paginated report summaries with content/nonce canaries;
- `private, no-store` on successful and denied snapshot/reconciliation reads, including canonical messages, pins and topics.
- transactional domain/event/outbox rollback, atomic multi-audience enqueue, restart startup drain, expired-lease recovery, publish-before-ack at-least-once duplication, capped backoff/dead-letter, corrupt-row isolation, counter overflow and non-throwing post-commit notification.
- deterministic local realtime hostile mix: pre-queue frame-rate cutoff, rotating-chat typing bucket, pending/outbound backpressure `1013`, per-session socket cap, cross-version per-IP authentication/pending caps, cleanup and guard metrics.
- client-IP provenance hostile matrix: direct-mode forwarding-header denial, explicit proxy-CIDR chain traversal, prepend-spoof and untrusted-peer resistance, IPv4-mapped/IPv6 canonicalization, fail-closed malformed values, and one authentication bucket across realtime V1/V2. This is local application evidence, not production ingress or distributed-limit proof.

The count reflects current test cases, not all assertions or release-gate completion.

### Verified phone/backend evidence snapshot

- Shared protocol: 6 test files, 59 tests passed.
- Full API: 59 test files, 552 tests passed sequentially.
- Migration chain plus identity upgrade: 2 test files, 14 tests passed; this
  includes ordered migration `001–018` coverage without rewriting applied IDs.
- A Docker-built Beta-0.1 API passed readiness and a live development-provider
  journey: challenge, correct OTP, `profile_required`, username check,
  registration, authenticated `/v1/me` and `/v2/sync/snapshot`.

This is local deterministic evidence. The development provider sends no SMS and
its fixed test code is not returned or logged. The snapshot does not prove a
real SMS vendor, optional post-OTP 2FA, safe legacy-account binding,
avatar/profile upload, shared distributed limits or production deployment.

### Repository truth metadata

`make check-truth` scans first-party source and documentation for non-canonical
Beta-style release tokens, owner/developer metadata, package authors and product
copyrights. It allows only the public `Beta-0.1` label and Flenym ownership while
deliberately excluding dependency/generated files and treating package SemVer,
Apple numeric bundle versions and HTTP/realtime/schema v1/v2 as internal versions.

### Passkey ceremony domain — 51 tests

The isolated package covers exact RP/origin and UP/UV policy, challenge secrecy and expiry, actor/session/device binding, command and creation idempotency, ambiguous commits, globally unique credential IDs, authentication credential-row CAS, verifier/store normalization, honest zero-counter support, hard non-advancing supported-counter rejection before store effects, backup-state signals, and safe error/outbox projections. API tests additionally cover the maintained adapter, encrypted SQLite repository, internal primary-login/signup orchestration, scheduled expiry reconciliation and the non-routed durable authenticator list/rename/revoke foundation. They still do not provide public signup/sign-in/management availability, independent security notifications, recovery, production vault/abuse evidence or platform interoperability.

### Apple — 39 XCTest cases + 3 Swift Testing cases at the current merged checkpoint

The merged package checkpoint executes 39 XCTest cases: 38 pass and the explicitly
opt-in live-backend case skips by default. Three additional Swift Testing cases
pass. Coverage includes truthful application states, phone request/verify/
registration models, country and E.164 bounds, session restore/refresh
serialization, send/filter/reaction behavior, cancellation, durable cursor
application, old-session isolation, DEBUG automation validation, canonical UUID
paths, the composer media truth gate, remote chat refresh/load/error/retry,
stable-nonce failed-send retry, read/reaction contracts, known-contact direct
chat, profile/QR safety, folder filtering/sorting and iOS permission projection.

The merged `LuxoraMobile` source also completed a no-signing iPhone Simulator
Xcode build. Focused UI evidence passed 2/2 chat-function smokes and 3/3
profile/folder/contact-navigation smokes. These focused runs do not replace a
single complete release UI suite.

A separate opt-in `LuxoraMobile` UI test completed a fixture-free local
development-provider journey on iPhone 17 Pro: phone challenge, correct OTP,
`profile_required`, name/bio, live username availability, account/session
creation, permission rationale, sync into Chats and a later Keychain session
restore. This is narrow local evidence, not a full release UI suite or proof of
production SMS, existing-account/2FA, remote avatar upload, durable offline,
all permission outcomes, accessibility or all 62 reference screens.

A separate opt-in live chat integration passed registration/session creation,
direct chat persistence, text send/list/read, reaction add/remove, realtime
handshake and session revoke. It is live local API evidence, not production
deployment, SMS, push, media, call or durable-offline proof.

### Android — 3 tests

Local `MessengerState` send/whitespace/filter+search behavior. These test demo state only.

### Server operations — 3 disposable gates

`make api-log-canary` builds the current production API image, starts it as a
non-root, read-only, capability-free container on an ephemeral loopback port and
exercises registration, exact lookup, a durable private request, invalid bearer,
object-ID route and unmatched-path handling. Structured logs must retain only
method/route template, a server-generated request ID, status and duration while
excluding query values, concrete object IDs, attacker request IDs, credentials,
tokens and private content. After a graceful stop, the gate checks SQLite integrity,
foreign keys, migrations, encrypted request storage and raw-file canaries. It
uses only a uniquely named synthetic volume and removes that container and
volume on both success and failure. This is local application-process evidence,
not proof for an external log collector or production pipeline.

`make s3-live-gate` builds the current production API image and exercises its
real `S3StorageProvider` against digest-pinned MinIO on a Docker-internal network
with no host ports. The gate creates runtime-only bootstrap, static SSE test and
service credentials; the service identity is distinct from the bootstrap admin
and can access object data only below `attachments/*`. It requires private
anonymous behavior (`403`), versioning, configured current/noncurrent/delete-marker
lifecycle rules, SSE-S3-confirmed PUT/full GET/Range GET/DELETE, cross-prefix
`AccessDenied`, and cleanup after a response is dropped only after MinIO commits
the PUT. It inspects retained data versions/delete markers, then permanently
purges only the validated synthetic bucket versions, bucket, user, policy,
container, volume and network and proves they are absent. This is local
S3-compatibility evidence, not cloud IAM, public-access-block or managed-KMS proof;
the static key mode is test-only and lifecycle execution itself is asynchronous.

`make backup-restore-test` creates a temporary WAL-mode SQLite fixture with a
local attachment and resumable upload chunk, performs the stopped-service backup,
verifies its SHA-256/size manifest, restores into a new destination and checks
database/blob/upload bytes. Negative probes require tamper detection and reject
restore over an existing destination. This proves only the offline local-preview
script path, not production recovery.

### Missing current suites

- No automated Web component/E2E/accessibility tests.
- No Electron integration/packaging security tests.
- No complete iOS release UI suite, durable-persistence or comprehensive network-journey matrix; the opt-in live phone test covers only the narrow successful new-account path listed above.
- No Android network/persistence/instrumentation journey tests.
- No load/chaos/DAST/fuzz suite or production/online backup-restore suite.

## 3. Local commands

```bash
# Install deterministic JS dependencies
make install

# Product truth, type checks, protocol and API tests
make check

# All JS/TS builds
make build

# Native foundations
make apple-test
make android-test

# Container build and Compose validation
make docker-build
make compose-config

# Disposable production-container log/content/token and stopped-DB canary
make api-log-canary

# Disposable live production S3 provider/IAM/versioning/failure gate
make s3-live-gate

# Disposable local/offline SQLite + blobs/uploads recovery drill
make backup-restore-test
```

Direct commands:

```bash
npm --prefix packages/protocol test
npm --prefix packages/passkey-domain test
npm --prefix services/api test
swift test --package-path apps/apple
apps/android/gradlew --no-daemon testDebugUnitTest lintDebug
```

Tests use synthetic data and isolated temporary/in-memory databases. Never point a test suite at a production dataset/account without a reviewed test plan.

## 4. CI matrix

| Workflow | Runner | Current checks |
| --- | --- | --- |
| Node, Web and Desktop | Ubuntu 24.04, Node 22 | protocol, passkey/call domains and API type+tests+build; Web build, desktop typecheck, truth scan |
| Apple Swift | macOS 26 | Swift package tests; reproducible XcodeGen generation and iPhone-only `LuxoraMobile` generic Simulator build without signing |
| Android Gradle | Ubuntu 24.04, JDK 17 | unit, lint and debug APK assemble |
| Security and container | Ubuntu 24.04 | dependency review, JS/TS CodeQL, Trivy filesystem/image, Docker build |

Jobs use minimum read/security permissions, timeouts and cancellation. Maturity backlog: immutable action/image pinning, SBOM/provenance, native SAST, secret scan, signed artifact and retained reports.

## 5. Test pyramid by server phase

### Unit/property

- normalization/validation/bounds and public error mapping;
- permission/trust-class invariants;
- refresh-token family transitions and clock/expiry;
- message nonce/revision/read-order state machines;
- cursor encode/decode and event replay rules;
- media parser metadata/quotas/jobs;
- call signaling membership/race state machine;
- E2EE test vectors/state loss/skipped-key bounds/downgrade.

### Integration

- real Fastify + isolated database + WebSocket;
- cross-account IDOR on every resource/action;
- transaction + durable event + reconnect convergence;
- production config/key rotation and migration from every supported prior schema;
- future object/search/push/queue/SFU/TURN adapters in hermetic test environments;
- backup restore plus permission/index/object reconciliation.

### Contract/conformance

- generated OpenAPI plus realtime golden JSON corpus;
- one-supported-version-old client behavior;
- every client language decodes/encodes the same fixtures;
- unknown/additive fields, nullable/optional and capability negotiation;
- security-incompatible version fails closed with draft recovery.

### End-to-end

- clean environment, signed/identified build and production-like dependencies;
- create account/device → request/accept → send offline/reconnect → edit/react/deliver/read → revoke;
- media resume, search permission, push token lifecycle;
- call join/reconnect/share/stop and group membership changes;
- Private device link/verification/revoke/backup restore after crypto gate;
- user-visible rollback/update-required behavior.

## 6. Current text vertical-slice backlog

Blocking additions:

- endpoint/action/role IDOR table including stale previously-authorized IDs;
- 10 identical send retries produce one message/event outcome;
- concurrent refresh uses one lineage and safely handles loser/reuse;
- monotonic read under equal timestamp/tie-break and out-of-order frames;
- delivered idempotency and read-implies-receipt semantics;
- delete removes pending content-bearing replay events while preserving tombstone;
- edit/delete/reaction/read races converge after reconnect;
- deterministic local resume overflow, slow-consumer and connection/reconnect bounds exist; production proxy, multi-process and 1/5/15-minute outage load evidence remains;
- session revoke latency for HTTP, refresh and all matching sockets;
- Unicode bidi/confusable/grapheme/10k boundaries;
- rate-limit evasion/hostile mix and safe 4xx/5xx envelopes;
- log canary across success/error/Swagger/WebSocket/DB;
- migration crash, online backup coordination and real-dataset restore evidence;
- offline local-preview backup/restore script coverage exists, but encrypted
  archives, off-host/target object-store recovery and RPO/RTO drills do not.

## 7. Security testing

- SAST/SCA/secret/container/IaC scans on PR/main/schedule with severity policy.
- DAST/API: auth bypass, IDOR/BOLA/BFLA, injection, CORS/CSRF/Origin, smuggling/cache/SSRF relevant to deployed proxy.
- Fuzz JSON/event/rich-text/deep-link/media and future ciphertext/state parsers.
- Mobile MASVS and Web ASVS mappings with storage/network/platform tests.
- Infrastructure IAM/KMS/object public access/egress/backup/privileged access tests.
- Abuse simulations: enumeration, spam, raid, report brigading and moderator misuse.
- Independent pentest at required milestones; independent crypto review before E2EE claim.

Open Critical blocks every shared release. High in auth/authorization/privacy/data-loss/E2EE/update blocks beta and GA; exceptions follow canonical expiry policy only where allowed.

## 8. E2EE testing gate

No custom crypto and no UI claim until:

- selected library/profile provenance and exact version/cipher suite recorded;
- cross-platform published/internal vectors pass;
- loss, duplicate, reorder, delayed device, membership churn, rollback and state corruption property tests;
- server key substitution/split-view and transparency monitor tests;
- no downgrade/plaintext fallback;
- local search/push/preview/report/backup/AI boundary adversarial tests;
- independent audit findings remediated/retested.

Coverage percentage cannot substitute for these properties.

## 9. Calls/media testing

Calls: simultaneous answer/decline, multi-device ring, host leave, roster epoch, reconnect/handoff, relay-only, Wi-Fi/mobile/high RTT/loss, permission denied/revoked, crash stops screen capture, TURN abuse and SFU capacity. E2EE media test confirms keys absent from SFU/TURN/logs.

Media: multipart interruption/process kill, byte-range/resume, object authorization/cache keys, MIME/magic/polyglot/zip bomb/parser corpus, Moderated quarantine fail-closed, EXIF stripping, encrypted derivative isolation, quotas and abandoned-upload GC.

The current media/storage slice is runnable and adversarially tested, including a disposable live S3-compatible provider gate, but it deliberately stops before malware quarantine/transcoding, verified metadata extraction and live production-cloud object-store controls. Calls have an isolated tested call-control/grant model plus a loopback LiveKit/coturn harness; signaling endpoints, signed grants, client media sessions and production capacity evidence are not integrated yet.

## 10. Client testing after unfreeze

Thin iPhone harness runs server conformance/offline/security evidence during server phases. Full UI coverage waits for server completion. Remaining clients wait for server + full iPhone.

Per released client:

- unit/domain/local migration/outbox tests;
- mocked then real protocol conformance;
- UI journey on supported OS/device/browser matrix;
- background/kill/relaunch, low storage/memory/energy and clock skew;
- notification/camera/mic/photo permissions denied/revoked;
- signed update/rollback and revoked/minimum-version behavior;
- crash-free and performance evidence from privacy-reviewed telemetry.

## 11. Accessibility/localization

Automated scans are a floor. Manual core journey with VoiceOver/TalkBack/NVDA/keyboard/switch-equivalent input is mandatory. Test largest text, 200–400% Web zoom, high contrast, Reduce Motion/Transparency, RTL and pseudo-localization +40%.

State must not be color/motion-only. Focus order/restore, modal trapping, live-region noise, message action labels and touch targets are inspected. Security/consent/delete/recovery copy receives linguistic review.

## 12. Performance and chaos

Use documented build, region, dataset, payload, concurrency, device and network. Empty localhost benchmark is not release evidence.

- API send/dispatch/resume latency and availability objectives from PRD.
- Mixed send/edit/delete/reaction/read/typing/presence/reconnect, not GET-only load.
- 1/5/15-minute outage reconnect storm with jitter/backoff.
- DB/object/search/push/queue/SFU latency/failure and bounded queues.
- rolling deploy and regional restore/DR.
- client launch, 10k-message scroll, composer under event burst, memory/energy/network and glass GPU.

No current metric in docs is a public promise until this evidence exists.

## 13. Test evidence

Each release report records commit/build/image digest, exact command/toolchain, sanitized config profile, timestamp, raw report, known limitations, owner/approver and rollback/runbook. CI URL alone is insufficient if artifacts expire; retain required reports according to release policy.

Flaky test is a defect. Quarantine requires issue, owner, reason, expiry and equivalent blocking mitigation; never rerun until green as the release strategy.
