# Luxora — Release Quality Gates

**Канонический релиз:** Beta-0.1  
**Разработчик и владелец:** Flenym  
**Дата:** 3 августа 2026  
**Принцип:** функция, SLO или security claim существует для релиза только тогда, когда приложено воспроизводимое evidence.

## 1. Gate policy

### 1.1. Решения

- **PASS:** критерий выполнен в release candidate и evidence доступно.
- **PASS WITH EXPIRY:** только для Medium/Low риска, есть owner, срок ≤ 30 дней, mitigation и rollback trigger.
- **FAIL:** блокирует milestone, где gate помечен обязательным.
- **N/A:** письменное обоснование и approver; отсутствие реализации не превращается в N/A, если UI/marketing её обещает.

### 1.2. Severity policy

- Open Critical defect/vulnerability: no ship в любое shared/production окружение.
- Open High: no GA; no beta для auth/authorization/privacy/data-loss/E2EE/updates. Иной High требует Security + Product acceptance с expiry.
- Medium: owner и план; release manager оценивает aggregate risk.
- Low: backlog допустим, если не нарушает claim/accessibility/legal baseline.

### 1.3. Evidence requirements

Каждая запись содержит:

- commit/build/container digest;
- environment/config profile без secrets;
- command/test suite и timestamp;
- raw report/log/trace/screenshot where relevant;
- owner и approver;
- known limitations;
- link на rollback/incident runbook для operational gate.

«Работает у меня», demo video без build identity и процент coverage без risk mapping не являются достаточным evidence.

## 2. Milestones and required gate sets

| Gate set | M0 Runnable | M1 Private beta | M2 E2EE pilot | M3 Community beta | M4 GA |
| --- | --- | --- | --- | --- | --- |
| Product truth/scope | Required | Required | Required | Required | Required |
| Build/test reproducibility | Required | Required | Required | Required | Required |
| Auth/API/realtime correctness | Required subset | Full | Full | Full | Full |
| Storage migration/DR | Local backup subset | Required | Required | Required | GA SLO |
| E2EE | Explicitly forbidden claim | Design in review | Full pilot gates | Full for Private | Full |
| Moderation/community | N/A unless visible | Internal only | Internal only | Full beta | Full |
| Media/calls | Only if actually exposed | Baseline | E2EE call pilot if exposed | Group beta | Full |
| Accessibility/localization | Core flow baseline | Full core | Full core | Full community | Full matrix |
| Performance/SLO | Dev budgets | Beta objectives | Beta objectives | Scale tests | Production SLO |
| Security external review | Internal | Targeted pentest | Crypto audit + pentest | Abuse/admin pentest | External pentest + remediation |

## 3. Product truth gates

| ID | Blocking criterion | Evidence | Owner |
| --- | --- | --- | --- |
| TRUTH-000 | Все public metadata используют ровно `Beta-0.1` и `Flenym`; альтернативные release/owner labels отсутствуют | Repository-wide metadata scan | Product |
| TRUTH-001 | UI, website, docs and store copy contain no feature unavailable in the build without `Coming later`/demo disclosure | Automated copy scan + manual inventory | Product |
| TRUTH-002 | M0 visibly states `not end-to-end encrypted` before sensitive use; no shield/copy implies otherwise | Screenshots + comprehension test | Product + Security |
| TRUTH-003 | Every `encrypted`, `private`, `anonymous`, `secure`, `zero knowledge`, latency/availability claim has scope, owner, evidence and review expiry | Claim inventory signed | Security + Legal/Product |
| TRUTH-004 | Private/Moderated trust class is visible before create/join/send and cannot silently change | UX test + API invariant tests | Product + Backend |
| TRUTH-005 | Current platform/browser support matrix matches build and feature detection | Device/browser report | Client leads |
| TRUTH-006 | Roadmap items are not rendered as active controls unless safely disabled with explanatory copy | UI inventory | Product/Design |
| TRUTH-007 | Limits (message/file/group/call) come from server capabilities/config or match documented constants | Contract test | Backend + Clients |

### 3.1. Security claim inventory template

| Claim | Exact surfaces | Technical meaning | Evidence | Owner | Review date | Kill switch/corrective copy |
| --- | --- | --- | --- | --- | --- | --- |
| Example: `Private — end-to-end encrypted` | Header, create/join, website | Server cannot derive content keys; authenticated devices only | Audit + protocol/build report | Security | YYYY-MM-DD | Disable Private creation + replace copy |

No row, no claim.

## 4. Repository and build gates

| ID | Criterion | Minimum evidence |
| --- | --- | --- |
| BUILD-001 | Clean checkout installs and builds with documented supported toolchain | CI job from empty cache |
| BUILD-002 | Lockfiles are committed; dependency resolution is deterministic | Hash/diff check |
| BUILD-003 | Unit/integration/UI test commands are documented and non-interactive | CI logs |
| BUILD-004 | Production build contains no dev keys, sample credentials, debug endpoints or source-map secrets | Artifact scan |
| BUILD-005 | Schema/API/event compatibility check runs in CI | Contract report |
| BUILD-006 | Generated artifacts have build/version/commit identity visible in diagnostics | Runtime screenshot/API output |
| BUILD-007 | License/SBOM generation succeeds; prohibited/unknown license list empty or approved | SPDX/CycloneDX + license report |
| BUILD-008 | Release artifacts/container images are signed/attested before GA | Signature/provenance verification |

## 5. M0 runnable-slice gates

M0 can be shared as a technical preview only after all rows pass.

| ID | Criterion |
| --- | --- |
| M0-001 | Node.js 22 supported version is pinned/documented; clean start fails safely when required secrets/config are absent. |
| M0-002 | SQLite WAL repository initializes deterministically; schema setup is idempotent; file/WAL/shm permissions and backup procedure documented. |
| M0-003 | Register/login/refresh/current logout/list sessions/revoke session happy and negative paths pass. |
| M0-004 | Argon2id uses at least `m=64 MiB,t=3,p=1`; test confirms hash verification and versioned rehash path. |
| M0-005 | JWT accepts only HS256, validates required claims/expiry and rejects weak/default secret at startup; configured secret ≥ 32 random bytes. |
| M0-006 | Refresh token is random 256-bit, hash-only in DB, atomically rotates, detects reuse and revokes correct family/session. |
| M0-007 | Chat/message/edit/delete/read/reaction endpoints enforce membership/ownership with cross-account IDOR negative suite. |
| M0-008 | Body ≤ 1 MiB, message ≤ 10k code points, page ≤ 100 and group create ≤ 200 listed members are server-enforced with clear 4xx errors. |
| M0-009 | Global and auth-specific rate limits are enabled; register/login/search/send/typing/reaction/reconnect abuse tests do not exhaust service. |
| M0-010 | Helmet/security headers, exact production CORS allowlist, safe error handler and strict Zod schemas pass config tests. |
| M0-011 | Logs redact Authorization, cookies, tokens, password, message content and sensitive PII; canary scan returns zero leaks. |
| M0-012 | WS handshake `hello→authenticate→ready`, auth deadline, heartbeat, max message, connection/backpressure bounds pass. |
| M0-013 | WS resume cursor is account/session-bound; replay/gap/duplicate/reconnect suite reaches same final state as HTTP snapshot. |
| M0-014 | Preview banner says M0 is not E2EE and unsuitable for sensitive information. |
| M0-015 | Clean CI test/build and a short smoke run complete without manual DB edits. |

## 6. Functional correctness gates

### 6.1. Identity and sessions

- Duplicate usernames/identifiers resolved atomically and case/Unicode normalization policy tested.
- Account lookup/recovery errors do not disclose existence beyond accepted product search policy.
- Current device cannot accidentally revoke a different device due to stale list/index.
- Revoked session loses refresh, HTTP and existing realtime access within defined SLA.
- Concurrent refresh race yields one valid rotation lineage and safe handling of loser.
- Device metadata displayed to user matches stored session identity, not untrusted client label alone.

### 6.2. Messaging

- Idempotent send: 10 retries of one client key produce exactly one canonical message.
- Ack is emitted only after durable commit required by current durability contract.
- Edit requires expected revision; delete/edit/reaction/read concurrency has deterministic final state.
- Read cursor is monotonic; old device event cannot mark newer content unread.
- Reply target deletion/membership loss produces safe unavailable state, not broken render/API leak.
- Removed member cannot read/send/subscribe after membership transaction.
- Block/request boundary removes receipts, precise presence and calls before accept/after block.
- Unicode normalization, bidi controls, long grapheme clusters, emoji sequences and 10k boundary render safely.

### 6.3. Offline/realtime

- Network off/on, 10-second and 10-minute outages, socket flaps and process kill preserve queued messages/drafts.
- Resume across a gap either fills all events once or triggers snapshot; no silent success with incomplete state.
- Duplicate/out-of-order dispatch is ignored/applied deterministically.
- Slow consumer is disconnected with resumable cursor before unbounded memory growth.
- ±24-hour client clock skew does not corrupt message order, expiry or token validation display.
- Realtime head is usable while older paginated history loads.

## 7. API and compatibility gates

| ID | Criterion |
| --- | --- |
| API-001 | Versioned OpenAPI/JSON schemas and realtime event schemas are generated/validated. |
| API-002 | Every field has required/optional/null semantics and unknown-field policy. |
| API-003 | Clients one supported version behind pass compatibility suite for non-security-breaking release. |
| API-004 | Breaking schema/event changes have migration, feature negotiation and minimum-version policy. |
| API-005 | Error taxonomy is stable, localizable and never exposes stack/SQL/internal secret. |
| API-006 | Pagination has stable cursor under concurrent inserts/deletes and enforced hard max. |
| API-007 | Idempotency scope/TTL and conflict behavior are documented and tested. |
| API-008 | Feature/capability discovery prevents clients hardcoding future limits/security state. |

## 8. Authentication and application-security gates

Mapped baseline: [OWASP ASVS 5.0](https://owasp.org/www-project-application-security-verification-standard/) and [OWASP MASVS](https://mas.owasp.org/MASVS/).

| ID | Blocking criterion |
| --- | --- |
| SEC-AUTH-001 | Password/token/session design passes threat-model cases AUTH-01…AUTH-12. |
| SEC-AUTH-002 | Passkeys, when exposed, validate origin/RP ID/challenge/user verification/counter policy and support multiple authenticators/recovery. |
| SEC-AUTH-003 | High-impact role/account/device changes require recent/step-up authentication. |
| SEC-WEB-001 | CSP/frame-ancestors/referrer/permissions policies reviewed; no unsafe HTML path; XSS suite passes. |
| SEC-WEB-002 | Cookie deployments pass SameSite/Secure/HttpOnly/CSRF/Origin tests; bearer deployments never store long-lived refresh in localStorage. |
| SEC-API-001 | Automated IDOR/BOLA/BFLA test exists for every resource/action/role. |
| SEC-API-002 | Injection, request smuggling relevant to proxy stack, cache poisoning and SSRF tests pass. |
| SEC-RT-001 | WebSocket Origin/auth/replay/resume/backpressure/rate-limit tests pass. |
| SEC-LOG-001 | Canary secrets/content never appear in app/proxy/DB slow logs/traces/crash reports. |
| SEC-DEP-001 | SCA has no known exploitable Critical/High; exceptions follow expiry policy. |
| SEC-PENTEST-001 | Required milestone external/independent pentest findings remediated and retested. |

## 9. E2EE migration and claim gates

These gates must all pass before the first UI or marketing E2EE claim, even in beta. «Feature flag off for most users» не отменяет gate для тех, кому он включён.

### 9.1. Architecture and implementation

| ID | Blocking criterion |
| --- | --- |
| SEC-E2EE-001 | Versioned protocol profile specifies identity, 1:1/group establishment, device fan-out, membership, ratchet/epoch, cipher suites, errors and downgrade behavior. |
| SEC-E2EE-002 | No custom cryptographic primitive/protocol; selected maintained library provenance, license, update owner and security history reviewed. |
| SEC-E2EE-003 | Per-device key generation/storage/link/revoke/reset/loss flows implemented on every supported pilot platform. |
| SEC-E2EE-004 | Test vectors and cross-platform interoperability pass for every supported suite/version. |
| SEC-E2EE-005 | Property/chaos tests cover loss, duplication, reordering, delayed device, state rollback, skipped-key bounds and membership churn. |
| SEC-E2EE-006 | Protocol downgrade/plaintext fallback impossible; unsupported state fails closed with recoverable draft. |
| SEC-E2EE-007 | Identity verification and key-change UX pass comprehension/security tests. |
| SEC-E2EE-008 | Key transparency/consistency design detects server substitution/split view in adversarial test; independent monitor/runbook exists. |
| SEC-E2EE-009 | Independent cryptographic design and implementation audit has zero unresolved Critical/High; Medium treatment signed. |

### 9.2. Feature boundaries

| ID | Blocking criterion |
| --- | --- |
| SEC-E2EE-010 | Private search is local; server logs/index receive no query/plaintext. |
| SEC-E2EE-011 | Push payload, link preview, thumbnails, transcription, translation/AI and crash diagnostics do not create hidden plaintext channel. |
| SEC-E2EE-012 | Private report shows exact selected plaintext/context and encrypts only to Safety; no ambient escrow. |
| SEC-E2EE-013 | Encrypted backup recovery secret is never uploaded/logged; provider-inability-to-decrypt and lost-key semantics tested. |
| SEC-E2EE-014 | Device addition/history sharing and member removal rotate/authenticate state before future delivery. |
| SEC-E2EE-015 | Private → Moderated migration creates a new container and explicit participant/content flow; no in-place toggle. |
| SEC-E2EE-016 | Secret metadata-minimized mode lists remaining metadata and measured latency/battery/data/recovery limitations; no anonymity claim. |

### 9.3. Rollout

- Internal dogfood with synthetic/non-sensitive data first.
- External pilot requires opt-in disclosure, supported-platform lock and emergency creation kill switch.
- Protocol metrics contain versions/outcomes only, no keys/plaintext/stable cross-conversation correlation.
- A rollback may disable new sends/creation or require upgrade; it may **never** silently send plaintext.
- Security advisories/update SLA and protocol deprecation path exercised before GA.

## 10. Privacy and data-governance gates

| ID | Criterion |
| --- | --- |
| PRIV-001 | Data inventory maps every persisted/logged/third-party field to purpose, class, owner, retention and deletion behavior. |
| PRIV-002 | Product analytics schema contains no plaintext content, contacts, exact search query, raw private membership graph, tokens/keys or precise continuous location. |
| PRIV-003 | Permission prompts occur at point of use after value explanation; denial leaves usable fallback. |
| PRIV-004 | Export contains user-owned data in documented format without secrets/other users’ restricted data. |
| PRIV-005 | Account deletion revokes sessions/keys, queues storage/index/CDN/log-derived deletion under published SLA and shows exceptions. |
| PRIV-006 | Push/CDN/analytics/subprocessors and regional data flows are inventoried and reflected in policy. |
| PRIV-007 | Privacy Checkup accurately changes backend enforcement, not only local UI. |
| PRIV-008 | Contact discovery has explicit consent; phone/email low-entropy values are not «protected» merely by unsalted hashing. |
| PRIV-009 | Support/moderation access is case-bound, just-in-time and audited; Private plaintext has no ambient access path. |

## 11. Storage, migration, backup and disaster-recovery gates

### M0/local

- WAL-consistent backup/restore test restores acknowledged messages and sessions as designed.
- File permissions prevent unrelated local users; dev datasets contain no real sensitive data.
- Crash/power-loss simulation does not leave schema partially migrated.

### Private beta/production

| ID | Criterion |
| --- | --- |
| DATA-001 | Production database choice passes representative load and failure tests; SQLite is not assumed horizontally scalable. |
| DATA-002 | Schema migration forward/backward compatibility supports rolling deploy; destructive migration has verified backup/restore. |
| DATA-003 | At-rest encryption is proven on DB, replicas, backups, object store and relevant logs for deployment making that claim. |
| DATA-004 | KMS IAM, rotation, break-glass and audit tested; DB operator alone cannot administer KMS. |
| DATA-005 | RPO ≤ 5 min and RTO ≤ 60 min target for GA metadata/ciphertext service, demonstrated by timed restore/game day. |
| DATA-006 | No acknowledged durable message loss in failover/chaos test. |
| DATA-007 | Backup restoration includes integrity, permissions, index reconciliation and object references. |
| DATA-008 | Retention/deletion propagates to search, cache, CDN, replicas and backups according to documented SLA. |

## 12. Reliability and performance gates

Reference measurements use documented region, dataset, payload, client/device, network and concurrency. Empty localhost benchmarks are not evidence.

### 12.1. Service objectives

| ID | Private beta | GA |
| --- | --- | --- |
| PERF-API | API monthly availability ≥ 99.9% | ≥ 99.95% |
| PERF-SEND | Same-region send→durable ack p95 ≤ 250 ms, p99 ≤ 750 ms | p95 ≤ 200 ms, p99 ≤ 600 ms |
| PERF-DISPATCH | Ack→online recipient dispatch p95 ≤ 500 ms | p95 ≤ 350 ms |
| PERF-RESUME | Resume after network restoration p95 ≤ 2 s | ≤ 1.5 s |
| PERF-CRASH | Crash-free sessions ≥ 99.5% | ≥ 99.8% |
| PERF-DUP | No duplicates in suite; measured < 1 ppm | < 0.1 ppm |

### 12.2. Load/chaos gates

- Load includes send/edit/delete/reaction/read/typing/presence/reconnect mix, not only GET health.
- Rate-limited hostile traffic cannot starve authenticated send path.
- Reconnect storm after 1/5/15-minute outage stays within capacity and applies jitter/backoff.
- Database/object/search dependency latency and failure produce bounded queues/timeouts/circuit behavior.
- Rolling deploy preserves realtime cursors and does not mass-duplicate/drop events.
- Regional failover/restore meets measured SLO or release copy/plan is adjusted.
- Capacity plan has at least 2× measured peak headroom for beta and defined scale trigger.

## 13. Web and client performance gates

| ID | Criterion |
| --- | --- |
| UI-001 | Reference mobile Web LCP ≤ 2.5 s beta / 2.0 s GA on documented 4G profile; CLS ≤ 0.1; INP ≤ 200 ms target. |
| UI-002 | Conversation with 10k messages remains virtualized; scroll/send latency stays within interaction budget. |
| UI-003 | Composer input does not drop keystrokes under realtime event load. |
| UI-004 | Core animation targets 60 fps and no task waits for animation; reference low-end devices documented. |
| UI-005 | Glass/blur GPU and memory cost measured; Reduce Transparency fallback available. |
| UI-006 | Background/offline storage quota handling does not silently lose queued sends. |
| UI-007 | Memory/battery/network budgets measured for 30-min chat and call scenarios. |
| UI-008 | App cold/warm launch and reconnect budgets pass per platform reference matrix. |

## 14. Media/file gates

| ID | Criterion |
| --- | --- |
| MED-001 | Resumable multipart upload survives process/network interruption and is idempotent. |
| MED-002 | Object access requires authorization/scoped short-lived credential; public-bucket and cache-key tests pass. |
| MED-003 | MIME/magic/polyglot/filename/zip-bomb/parser test corpus handled safely. |
| MED-004 | Moderated malware/transcode pipeline fail-closed policy and quarantine runbook tested. |
| MED-005 | Private media/thumbnail keys never enter URL/log/server index; cross-device decrypt tests pass. |
| MED-006 | EXIF/location stripped by default and `send original` disclosure tested. |
| MED-007 | File limits/quotas and abandoned-upload GC prevent unbounded storage cost. |
| MED-008 | Accessibility alternatives exist for audio/video controls and transcript boundary is explicit. |

## 15. Calling gates

| ID | Criterion |
| --- | --- |
| CALL-001 | State-machine race suite: simultaneous answer/decline, multi-device ring, reconnect, handoff, host leave, membership change. |
| CALL-002 | Call setup success/join latency/packet loss/jitter/quality measured on Wi-Fi, 4G/5G, high RTT/loss and relay-only. |
| CALL-003 | Mic/camera/screen permissions fail gracefully; ending/crashing always stops capture. |
| CALL-004 | TURN credentials short-lived/scoped; bandwidth abuse and exhaustion test pass. |
| CALL-005 | E2EE media keys absent from SFU/TURN/logs; rekey on join/leave and stale-member rejection tested. |
| CALL-006 | Privacy/verification UI reflects negotiated state; broadcast/stage exception never shows E2EE. |
| CALL-007 | Screen-share source/indicator/pause/stop behavior verified per platform; sensitive-notification guidance present. |
| CALL-008 | Keyboard/screen-reader paths cover join, mute, camera, hand, participant, share and leave. |

## 16. Community, moderation and abuse gates

| ID | Criterion |
| --- | --- |
| MOD-001 | Effective permission matrix/property tests cover owner/admin/moderator/member/guest/custom roles and channel overrides. |
| MOD-002 | High-impact permission/bulk actions require step-up, reason and immutable audit. |
| MOD-003 | Removed/banned/blocked actor loses HTTP/realtime/search/media access within defined SLA. |
| MOD-004 | Join/request/spam/raid/slow-mode/lockdown simulations pass at target scale. |
| MOD-005 | Report evidence scope is visible; Private report uploads only selected context. |
| MOD-006 | Report brigading, moderator abuse and appeal tabletop completed; action reversibility/expiry defined. |
| MOD-007 | Public discovery eligibility/safety/age/region rules are server enforced and rapid delist works. |
| MOD-008 | Search/index deletion and permission change purge inaccessible snippets under measured SLA. |
| MOD-009 | Onboarding never grants a role above configured safe ceiling and has preview/audit. |

## 17. Accessibility gates

Baseline follows platform guidance and WCAG 2.2 AA for Web.

| ID | Blocking criterion |
| --- | --- |
| A11Y-001 | Core journeys in UX Flows complete with screen reader and keyboard/switch-equivalent input. |
| A11Y-002 | Focus order/restore, modal trapping/dismissal and deep-link focus are correct. |
| A11Y-003 | Text scales to platform largest accessibility sizes without loss of critical content/action. |
| A11Y-004 | Contrast meets AA in light/dark/glass/media backgrounds; high contrast/Reduce Transparency tested. |
| A11Y-005 | Reduced Motion removes zoom/depth/animated blur/repetitive motion while preserving state. |
| A11Y-006 | Delivery/security/presence/error state is not color/motion-only and has concise accessible label. |
| A11Y-007 | Composer/message action/reaction/media/call controls have labels, role, state and target size. |
| A11Y-008 | Captions/transcript or equivalent plan exists for required audio/video content; no autoplay trap. |
| A11Y-009 | Automated scan has zero critical violations, but manual audit remains mandatory. |

## 18. Localization and internationalization gates

- No concatenated user-facing strings or hardcoded English in required surfaces.
- Plurals, grammar, dates, time zones, numbers, file sizes and relative time use locale-aware APIs.
- RTL mirrors navigation/layout where appropriate but not phone numbers/code/media semantics incorrectly.
- Pseudo-localization with +40% expansion passes without clipped critical action.
- Username/normalization/confusable policy tested across scripts; security/system identity remains distinguishable.
- Initial GA languages have linguistic review of security, consent, delete/report/recovery copy.
- Locale fallback never exposes localization key/internal error.

## 19. Design and UX comprehension gates

| ID | Criterion |
| --- | --- |
| UX-001 | ≥ 85% moderated-test participants correctly identify who can access content in Current Cloud, Private and Moderated contexts. |
| UX-002 | ≤ 5% confuse M0 preview with E2EE after onboarding/conversation header. |
| UX-003 | Median first message ≤ 60 seconds for known contact path. |
| UX-004 | Users recover from offline failure/retry without losing text in ≥ 95% task trials. |
| UX-005 | Delete scope, device link and backup lost-key consequences are correctly understood by ≥ 90% target participants. |
| UX-006 | Space onboarding leads ≥ 70% to a relevant channel in first session during beta experiment. |
| UX-007 | No dark pattern: decline/not-now/delete-local alternatives visible and keyboard accessible. |
| UX-008 | Motion/glass preference does not increase error/task time > 5%; performance/contrast gates also pass. |

## 20. Observability and operations gates

| ID | Criterion |
| --- | --- |
| OPS-001 | Golden signals dashboards: traffic, errors, latency, saturation plus send/dispatch/resume correctness SLIs. |
| OPS-002 | Alerts have actionable threshold, owner, severity, runbook and dedup; page test completed. |
| OPS-003 | Trace/log correlation works with pseudonymous IDs and zero secret/content canary leaks. |
| OPS-004 | On-call can identify regional/dependency/release issue and activate rollback/feature kill switch. |
| OPS-005 | Incident tabletop covers auth key leak, refresh replay, IDOR, DB/object exposure, message loss, push leak, malicious release and E2EE downgrade. |
| OPS-006 | Status/support communication templates avoid unsupported security claims and preserve investigation integrity. |
| OPS-007 | Privileged production access uses phishing-resistant MFA, JIT/reason/audit; quarterly access review complete. |
| OPS-008 | Retention/rotation for logs, metrics, audit and backups verified by deletion test. |

## 21. CI/CD and supply-chain gates

- Protected branch, mandatory review and code ownership for auth, authorization, crypto, permissions, migrations, CI/release.
- Untrusted fork/PR jobs receive no production/signing/package-publish secret.
- Secret scan, SAST, SCA, IaC/container scan and relevant DAST run at defined frequency; failures block by severity policy.
- Dependencies pinned; install scripts/network egress restricted where practical; provenance/SBOM stored.
- Release signing keys protected in hardware/managed signing boundary with audited access and rotation/recovery plan.
- Desktop updater verifies signature and anti-rollback/minimum secure version.
- Mobile store releases and phased rollout have build identity, crash/security monitoring and halt path.
- Server deploy supports canary, backward-compatible migration and automated rollback based on error/correctness thresholds.

## 22. Release candidate matrix

Minimum supported matrix is declared per release and cannot be «latest only» without policy. It includes:

- Latest and previous supported iOS/iPadOS on low/high reference hardware.
- Latest and previous supported Android API levels across low/mid/high devices.
- Current supported macOS/Windows distributions and named Linux packages/desktops.
- Safari, Chrome, Firefox, Edge versions in support policy; WebView/PWA mode where offered.
- IPv4/IPv6, Wi-Fi/4G/5G, high RTT/loss, captive/offline transitions.
- Light/dark/high contrast/Reduce Transparency/Reduce Motion/largest text/RTL.
- One, two and multiple linked devices; offline/stale/revoked device.
- Small/large history, group/space membership and moderated role combinations.

## 23. Rollout and rollback gates

### Before rollout

- Feature flag default/audience, config validation and kill switch tested in production-like environment.
- Database/event/client compatibility supports mixed versions.
- Capacity, support FAQ, privacy copy, dashboard/alert and incident owner ready.
- User-data migration has dry run, checksum and bounded rollback/forward-fix plan.

### Automated halt triggers

- Any cross-account access, token/key/content leak or false E2EE state.
- Acknowledged message loss/duplication above threshold.
- Crash-free sessions or send success falls below release floor.
- Error/latency/buffer/database saturation exceeds predeclared threshold for sustained window.
- Abuse/spam impact or notification storm exceeds safety threshold.

### E2EE rollback rule

Allowed: stop new Private creation/sends, require client upgrade, retain queued drafts, restore compatible encrypted protocol version after review. Forbidden: silently downgrade existing Private conversation to server-readable/plaintext.

## 24. Ship review checklist

Release manager records one answer per item:

1. What exact milestone/build is shipping and to whom?
2. Which features/security claims are user-visible?
3. Are all required gates PASS, and are exceptions time-bounded/approved?
4. Are schema/event/client versions compatible with deployed population?
5. Are rollback, kill switches, dashboards, alerts and on-call tested?
6. Are support/privacy/legal/localization/accessibility materials aligned with this build?
7. What are the top three residual risks and measurable halt triggers?
8. Who has final Product, Engineering, Security, Privacy/Legal, QA and Operations sign-off?

### Required sign-off by milestone

| Milestone | Sign-off |
| --- | --- |
| M0 shared preview | Engineering, QA, Product truth, Security M0 |
| M1 private beta | Product, Client/Backend, QA, Security, Privacy, Operations |
| M2 E2EE pilot | All above + independent crypto review owner + Legal/claims |
| M3 community beta | All above + Trust & Safety/Moderation |
| M4 GA | Executive release owner + all functional owners, DR and external security evidence |

## 25. Exit report template

```text
Release/build:
Audience/rollout %:
Commit/artifact digests:
Required gate sets:
PASS:
PASS WITH EXPIRY (owner/date):
FAIL/N/A rationale:
Open defects by severity:
Security claims enabled:
Top residual risks:
Dashboards/alerts/runbooks:
Rollback/kill-switch test:
Approvals:
Decision: SHIP / HOLD
```
