# Luxora — Threat Model

**Канонический релиз:** Beta-0.1  
**Разработчик и владелец:** Flenym  
**Дата:** 3 августа 2026  
**Метод:** asset/data-flow analysis + STRIDE/LINDDUN-inspired review + abuse-case analysis  
**Область:** current runnable cloud slice и целевая production-архитектура Private/Moderated Spaces

## 1. Главный security contract

### 1.1. Что можно утверждать сейчас

Текущий M0 slice использует secure password hashing, short-lived access tokens, rotating refresh tokens, per-device sessions, TLS requirement, authorization/rate-limit/schema/log-redaction controls и storage-encryption integration points.

**M0 не является end-to-end encrypted messenger.** Сервер обрабатывает plaintext сообщений. Оператор с достаточным доступом или злоумышленник, скомпрометировавший application/storage layer, потенциально может прочитать содержимое. Ни UI, ни README, ни сайт, ни demo не должны использовать `end-to-end encrypted`, `only you can read`, `zero knowledge` или эквивалентные формулировки.

Допустимая формулировка до production evidence: **«Соединение защищено при передаче; это preview-окружение, не предназначенное для чувствительных данных».** Упоминание encryption at rest разрешено только для конкретного проверенного deployment.

### 1.2. Целевой contract

- **Private Direct/Circle/Saved:** E2EE by default, per-device identities, forward secrecy, post-compromise security, authenticated membership changes, encrypted local index и opt-in encrypted backup.
- **Moderated/Public Spaces:** TLS + envelope encryption at rest; серверный search/moderation/abuse processing. До join показывается server-readable disclosure.
- **Secret metadata-minimized mode:** только после стабильного E2EE, opt-in и с прозрачными ограничениями по multi-device, backup, notifications, recovery и abuse reporting. Это не «ещё более красивый замок», а отдельный риск/удобство contract.
- Security claim активируется только после migration/audit gates из [Release Quality Gates](RELEASE_QUALITY_GATES.md).

## 2. Security objectives

1. Только аутентифицированный участник и явно авторизованные сервисы получают доступ к объекту.
2. Компрометация одного session/token/device не должна автоматически давать бессрочный доступ ко всем устройствам.
3. Durable messaging сохраняет integrity, idempotency, causal/order semantics и auditability действий.
4. Private E2EE content недоступен delivery/storage/push/analytics операторам.
5. Moderated content обрабатывается только для заявленных целей, с least privilege, retention и audit.
6. Пользователь может проверить, какие devices и trust context участвуют в разговоре.
7. Abuse controls защищают получателя, не создавая скрытую массовую расшифровку private content.
8. Availability attacks деградируют систему контролируемо и не ломают authorization/ordering.
9. Logs, metrics, traces, crash reports и support tooling не становятся вторичной plaintext-базой.
10. Обновления клиентов и серверов имеют проверяемую provenance и безопасный rollback path.

## 3. Не-цели и фундаментальные ограничения

- E2EE не защищает plaintext на разблокированном, root/jailbreak-компрометированном или записывающем экран endpoint.
- Получатель может копировать, фотографировать или пересылать полученный контент; disappearing messages лишь уменьшают retention.
- E2EE не скрывает всю metadata. IP, timing, размер трафика, device/push identifiers и membership operations требуют отдельной минимизации.
- Moderated Spaces по определению не защищают content от server operator.
- Сервер не гарантирует доставку при глобальной сетевой блокировке или изъятии всех credentials пользователя.
- Криптографический аудит снижает, но не устраняет риск implementation bugs и endpoint compromise.
- «Anonymous» не используется как claim: Luxora может уменьшать linkability, но не обещает глобальную анонимность.

## 4. Архитектурная модель

### 4.1. Компоненты

| Компонент | Обрабатывает | Уровень доверия |
| --- | --- | --- |
| Native/Web clients | UI, local DB/cache, credentials, Private plaintext/keys target | High-risk endpoint, контролируется пользователем, но может быть скомпрометирован |
| Edge/load balancer | TLS termination/routing/rate limits | Видит network metadata; не должен видеть Private plaintext после E2EE |
| Auth service | accounts, authenticators, sessions, device metadata | Critical; не должен иметь message keys |
| API/chat service | membership, permissions, message mutations | M0 видит plaintext; target видит ciphertext для Private |
| Realtime gateway | authenticated connection, sequence/resume, ephemeral presence/typing | Untrusted delivery service для target E2EE |
| Message store | message envelopes, revisions/tombstones, cursors | M0 plaintext; target Private ciphertext + metadata |
| Media/object store + CDN | encrypted blobs, moderated media, thumbnails | Publicly unreachable by default; scoped URLs |
| Search | Moderated index; on-device Private index | Никогда не получает Private plaintext server-side |
| Calls/SFU/TURN | signaling, packet forwarding, relay metadata | Не получает media keys в target E2EE calls |
| Push providers | opaque wake-up/event hints, device token | External processor; plaintext minimized |
| KMS/HSM | service/data encryption keys | Critical trust anchor; isolated access/audit |
| Moderation/support | reports, public content, account actions | Privileged human boundary; no ambient Private content access |
| Observability/SIEM | redacted events, metrics, traces, alerts | Sensitive metadata store with strict retention |
| CI/CD/update distribution | builds, signing, deploys | Critical supply-chain boundary |

### 4.2. Trust boundaries and principal flows

1. **Client ↔ Edge:** TLS; hostile network and hostile client input assumed.
2. **Edge ↔ Services:** mutually authenticated service identity; explicit allowlists and authorization context.
3. **Auth ↔ Session store:** credentials/tokens boundary; no message content.
4. **Client ↔ Realtime:** bearer auth, Origin validation for Web, connection limits, sequence binding.
5. **Messaging ↔ Storage/Search:** Private/Moderated routing must be policy-enforced, not chosen by arbitrary request flag.
6. **Client ↔ Object store:** short-lived object-scoped credentials; upload/download authorization cannot rely on unguessable URL alone.
7. **Client ↔ Push provider:** provider receives no secret keys and minimum content.
8. **Client ↔ E2EE peers:** server is treated as malicious delivery service for content confidentiality/integrity, but identity service remains a separate trust problem addressed by verification/transparency.
9. **Production ↔ Staff/tooling:** just-in-time privileged access, strong auth, reason/ticket, tamper-evident audit.
10. **CI ↔ Release:** signed provenance, protected branches, isolated secrets, reproducible/attested build roadmap.

### 4.3. Simplified data flows

#### M0 Current Cloud send

`client plaintext → TLS edge → authorized chat API → schema/limits → durable store → event sequence → realtime recipient`

Server compromise can expose content; at-rest encryption mainly reduces disk/snapshot theft, not application/operator access.

#### Target Private send

`client plaintext → local encryption per conversation/device state → TLS edge → opaque envelope store/delivery → recipient local verification/decryption`

Search/transcription/link preview remain local unless the user explicitly invokes a clearly disclosed external processor.

#### Moderated send

`client plaintext → TLS edge → policy/abuse pipeline → envelope-encrypted store + search index → authorized recipients/moderators`

## 5. Assets and classification

| Class | Examples | Required handling |
| --- | --- | --- |
| Secret | Passwords, refresh tokens, private keys, backup recovery secret, signing/KMS keys | Never log; strongest storage; narrow access; rotation/revocation |
| Private content | Message/media/call plaintext, drafts, local search index | E2EE target; no analytics; explicit retention and local protection |
| Sensitive metadata | Social graph, memberships, IP/device/push token, presence, report data, search query | Minimize, pseudonymize, short retention, access audit |
| Account PII | Email/phone, recovery channel, profile visibility data | Field encryption where appropriate, purpose/retention, user controls |
| Moderated content | Public/space messages, reports, audit evidence | Encryption at rest, RBAC, purpose-bound moderation access |
| Operational | Latency, error codes, coarse region/build | Redacted, bounded labels, retention policy |
| Public | Public profile fields/channel posts explicitly published | Integrity/authenticity, abuse controls; not assumed harmless forever |

## 6. Threat actors

- Unauthenticated internet attacker, scanner or botnet.
- Credential-stuffing/phishing/SIM-swap attacker.
- Malicious or compromised authenticated account.
- Malicious conversation participant, admin or moderator.
- Compromised browser extension, OS, rooted/jailbroken endpoint or stolen unlocked device.
- Network/MitM attacker, hostile Wi-Fi, DNS/BGP interference.
- Malicious insider or over-privileged support/operator.
- Compromised cloud account, database snapshot, object bucket or CI/CD dependency.
- Push/CDN/analytics third party, lawful request or coercive operator.
- Spam/raid/harassment group targeting service availability or a person.
- Supply-chain attacker publishing malicious package/client update.
- Future cryptanalytic/quantum adversary collecting ciphertext now.

## 7. Risk scale

- **Critical:** массовая compromise ключей/аутентификации, RCE, silent E2EE bypass, release-signing compromise, необратимая массовая потеря данных.
- **High:** cross-account content/metadata access, durable account takeover, large abuse bypass, backup/key disclosure.
- **Medium:** bounded metadata leak, scoped DoS, privacy setting bypass with limited reach.
- **Low:** low-impact information disclosure или nuisance без privilege/data escalation.

Likelihood: Likely / Possible / Unlikely с учётом existing controls. Любой open Critical блокирует release. High требует исправления или письменного time-bounded acceptance владельцем Security + Product; E2EE/identity High не принимается для GA claim.

## 8. Threat register — authentication and sessions

| ID | Threat | Initial | Required prevention | Detection/response | Residual |
| --- | --- | --- | --- | --- | --- |
| AUTH-01 | Credential stuffing/password spray | High | Argon2id `64MiB,t=3,p=1`; rate buckets by account/IP/device risk; breached-password screening without logging password; generic errors | Spike/risk alerts, temporary challenge, notify user | Medium |
| AUTH-02 | Username/email enumeration | High | Same status/timing envelope where feasible; bounded search; exact/prefix rules; no recovery disclosure | Enumeration heuristics and tarpitting | Medium |
| AUTH-03 | Access JWT forgery/alg confusion | Critical | Algorithm allowlist HS256 only in M0; 32+ random-byte secret; validate `iss/aud/sub/exp/session`; no `none`; migrate to asymmetric rotated keys | Token-failure telemetry, emergency key rotation/runbook | Low/Medium |
| AUTH-04 | Refresh DB theft/replay | High | 256-bit opaque token; only cryptographic hash stored; rotation every use; short family metadata; secure transport/storage | Reuse revokes family/session, user notification | Low |
| AUTH-05 | Refresh race causes false reuse | Medium | Writer-reserved compare-and-rotate; strict no-grace reuse revoke; clients serialize refresh and recover explicitly after ambiguity | Correlate same-device near-simultaneous attempts | Low |
| AUTH-06 | Token in URL/referrer/log | High | Bearer token only header/auth frame or Secure HttpOnly cookie design; never query; redaction | Canary-token log scans | Low |
| AUTH-07 | Web XSS steals JS tokens/plaintext | Critical | CSP, no unsafe HTML, Trusted Types roadmap, dependency controls; prefer BFF/HttpOnly refresh; access token in memory; sanitize rich text | CSP reports, session revoke, incident response | Medium |
| AUTH-08 | CSRF when cookies used | High | SameSite, CSRF token/origin validation, non-GET mutations; WebSocket Origin allowlist | CSRF anomaly telemetry | Low |
| AUTH-09 | Session survives revoke | High | Authorization/session status checked on refresh and connection; realtime disconnect fan-out; refresh family revoked atomically | Revocation latency SLI/alert | Low |
| AUTH-10 | QR-login phishing/relay | Critical | QR contains short-lived single-use challenge, origin/target device info; approval on trusted device with local biometric/PIN; never auto-login from arbitrary scanned QR | New-device notification, user-visible session list | Medium |
| AUTH-11 | Account recovery bypass | Critical | Recovery cannot override strong authenticators without delay/risk checks; no support-agent secret bypass; recovery events notify all devices | Hold/high-risk review, self-service freeze | Medium |
| AUTH-12 | SIM swap controls account | High | Phone not sole high-assurance authenticator; passkey/2FA; cooldown for sensitive changes | Carrier/number-change signals where lawful | Medium |

## 9. Threat register — API, authorization and realtime

| ID | Threat | Initial | Required prevention | Detection/response | Residual |
| --- | --- | --- | --- | --- | --- |
| API-01 | IDOR reads/changes another chat/message/session | Critical | Object-level authorization on every repository/service path; opaque IDs not treated as control; negative test matrix | Denied-access metrics without object leakage | Low |
| API-02 | Mass assignment changes owner/role/trust class | Critical | Strict Zod allowlists, server-owned fields, invariant checks, immutable trust class | Audit mutation attempts | Low |
| API-03 | Injection | High | Parameterized queries/repository APIs; no dynamic SQL from filters; output context encoding | SAST/DAST, DB error alerts | Low |
| API-04 | Oversized/decompression payload DoS | High | 1 MiB body M0, decompression ratio/stream limits, pagination max 100, timeout/concurrency budgets | 413/rate anomaly dashboard | Medium |
| API-05 | Replay creates duplicate message/reaction | Medium | Actor-scoped nonce; writer-reserved authoritative fingerprint check; unique constraints; forward source identity; desired-state reaction and conditional revision | Duplicate/conflict SLI | Low on tested SQLite boundary |
| RT-01 | WS authenticates via leaked URL or never authenticates | High | `hello→authenticate` deadline; token not URL; close unauthenticated; max connections | Auth timeout/count alerts | Low |
| RT-02 | Cross-origin WebSocket hijack | High | Strict Origin allowlist and CSRF-equivalent rules when cookies; explicit CORS is not enough | Origin-denial metrics | Low |
| RT-03 | Resume cursor from another account leaks events | Critical | Cursor bound to account/session/stream; event authorization rechecked; bounded retention | Cross-principal resume tests | Low |
| RT-04 | Gap/sequence manipulation hides or reorders actions | High | Authenticated scoped cursors, monotonic application across legitimate sparse global positions and HTTP reconciliation | Gap/recovery rate alerts; forced snapshot | Low |
| RT-05 | Typing/presence flood or durable tracking | Medium | Ephemeral TTL, rate limit, authorization, no durable analytics; coarse presence | Abuse throttles | Low |
| RT-06 | Slow consumer exhausts memory | High | Per-connection buffer cap, backpressure, disconnect+resume, event size cap | Queue depth/eviction SLI | Medium |
| RT-07 | Crash between domain commit and realtime publication loses live convergence | High | Domain/event/outbox atomic SQLite transaction; owner lease; publish-before-ack; capped retry/dead-letter; cursor replay | Pending/oldest/failed outbox alerts and restart drill | Medium until cross-process broker/fan-out evidence |

## 10. Threat register — messaging, membership and sync

| ID | Threat | Initial | Required prevention | Detection/response | Residual |
| --- | --- | --- | --- | --- | --- |
| MSG-01 | Removed member continues reading/sending | Critical | Transactional membership revision + authorization; revoke subscriptions; target E2EE epoch/key update | Access probes, membership/key-rotation SLI | Low/Medium |
| MSG-02 | Delete/edit race erases evidence or wrong revision | High | Writer reservation, authoritative revision re-read, current-revision CAS/history, delete tombstone domination and pending-content purge; immutable Moderated audit remains required | Revision conflict metrics | Low on tested SQLite boundary |
| MSG-03 | Forged sender/system message | Critical | Server derives actor from session; signed/authenticated E2EE sender data target; reserved system event type | Integrity/audit alerts | Low |
| MSG-04 | Client/server clock changes ordering/expiry | Medium | Server canonical timestamps; send/edit/delete advance strictly above the committed aggregate floor; read/delivered timestamps are clamped monotonically; event sequence remains authoritative | Coarse clock-floor telemetry without user/content labels | Low on tested SQLite boundary |
| MSG-05 | Offline queue duplicate/loss | High | Durable local queue, idempotency, ack-after-durable-write, reconciliation | End-to-end chaos tests | Low |
| MSG-06 | Reaction/read cursor reveals blocked user activity | Medium | Request/block privacy boundary; visibility policy computed server-side | Privacy regression tests | Low |
| MSG-07 | Link preview SSRF/privacy leak | High | Fetch service isolated; scheme/IP/DNS rebinding checks, size/time limits, proxy; Private defaults local/opt-in | Egress logs/alerts without URL query retention | Medium |
| MSG-08 | Unicode spoofing/bi-di/control abuse | Medium | Safe rendering, visible username discriminator, control-character policy, confusable warnings for admin/system identities | Abuse reports and rendering tests | Medium |
| MSG-09 | Forward loses provenance/privacy | Medium | Explicit forwarded marker, source privacy policy, strip hidden metadata, no automatic original link across inaccessible scope | UX/security tests | Low |

## 11. Target E2EE threats and required design

### 11.1. Protocol rule

Luxora не проектирует «Luxora Cipher». Выбор профиля оформляется отдельным Security Architecture Review. Кандидаты должны опираться на externally reviewed, maintained implementations:

- asynchronous 1:1 establishment и ratcheting с forward secrecy/post-compromise security; PQ-ready roadmap оценивает PQXDH/современный hybrid profile, а не самодельное добавление KEM;
- group key management на [RFC 9420 MLS](https://www.rfc-editor.org/info/rfc9420/) или эквивалентной независимо проверенной схеме;
- multi-device session semantics учитывают отдельную identity каждого device и asynchronous delivery;
- protocol version, cipher suite и downgrade behavior жёстко определены.

Спецификации Signal ([X3DH](https://signal.org/docs/specifications/x3dh/), [Double Ratchet](https://signal.org/docs/specifications/doubleratchet/), [Sesame](https://signal.org/docs/specifications/sesame/)) являются исследовательскими источниками, но не лицензией реализовать протокол «по статье» без зрелой библиотеки и экспертизы.

### 11.2. Threat register

| ID | Threat | Initial | Required control / gate | Residual target |
| --- | --- | --- | --- | --- |
| E2EE-01 | Server substitutes identity/device key (MITM) | Critical | Safety/verification codes + append-only key transparency with inclusion/consistency proofs; key-change alerts; independent monitor | Medium |
| E2EE-02 | Silent new device receives history | Critical | Existing trusted-device approval, device list visible, membership/key update, history-sharing consent/policy | Low |
| E2EE-03 | Removed device/member decrypts future data | Critical | Immediate session revoke + ratchet/MLS epoch update; no future key distribution | Low |
| E2EE-04 | Compromised current key decrypts past/future indefinitely | Critical | FS and PCS, secure deletion, periodic/member-change updates, documented recovery window | Medium endpoint-dependent |
| E2EE-05 | Protocol downgrade to Current Cloud/weak suite | Critical | Trust class immutable; downgrade impossible in message envelope; fail closed; conspicuous migration object | Low |
| E2EE-06 | Malformed ciphertext/state DoS | High | Fuzzed parser, bounded skipped keys/state, authenticated before expensive work, recovery/re-sync design | Medium |
| E2EE-07 | Multi-device fan-out omits attacker-chosen device/list | High | Authenticated device list/transparency, sender device consistency, gossip/checkpoint | Medium |
| E2EE-08 | Backup provider reads or swaps archive | Critical | Client-side AEAD; recovery secret never uploaded; manifest/version/rollback integrity; key confirmation | Low/Medium |
| E2EE-09 | Lost recovery secret leads to support bypass | Critical | No bypass; explicit loss warning, optional recovery methods with separately analyzed trust | Low security / High availability |
| E2EE-10 | Notifications/search/AI leak plaintext | Critical | Opaque push; local index; local link preview where possible; per-action disclosure for external processing | Low |
| E2EE-11 | Report feature becomes covert escrow | High | User explicitly selects messages; client packages plaintext + provenance for Safety; UI shows exact data | Medium |
| E2EE-12 | Harvest-now-decrypt-later | High | PQ threat review, crypto agility without downgrade, hybrid migration plan, inventory of long-lived sensitivity | Medium until PQ profile audited |
| E2EE-13 | Sender repudiation conflicts with abuse evidence | Medium | Document deniability/provenance semantics; reports treated as user-supplied evidence, not cryptographic universal truth | Medium |

### 11.3. Key lifecycle requirements

- Device generates private keys locally using platform CSPRNG; export prohibited unless protocol explicitly requires wrapped transfer.
- Private keys use Keychain/Secure Enclave/Android Keystore/OS credential protection where available; hardware backing is capability, not universal claim.
- Device addition, removal, identity reset and key change are visible security events.
- Secret material has zeroization/secure-deletion strategy, acknowledging filesystem/runtime limitations.
- Key backups use versioned AEAD and memory-hard recovery-secret derivation only when a human secret is involved.
- Algorithm/cipher-suite deprecation has dual-read/bounded migration, never silent plaintext fallback.
- Cryptographic telemetry records only version/outcome/error class, not keys/ciphertext/plaintext correlation IDs with long retention.

## 12. Moderated/Public Spaces and abuse

| ID | Threat | Initial | Required prevention | Residual |
| --- | --- | --- | --- | --- |
| MOD-01 | Admin permission escalation/hidden override | High | Role templates, deterministic effective policy, preview-as-role, 2FA/passkey requirement for high-impact roles | Medium |
| MOD-02 | Raid/spam overwhelms space | High | Join/message rate tiers, account age/risk, slow mode, approval/lobby, bulk action limits, emergency lockdown | Medium |
| MOD-03 | Malicious moderator mass-deletes/bans | High | Step-up auth, dual-control for extreme actions, immutable audit, bounded undo/appeal | Medium |
| MOD-04 | Moderator browses unrelated private data | Critical | Separate moderation tenancy/API, ABAC by case/space, just-in-time access, audit; no Private plaintext path | Low |
| MOD-05 | Report brigading censors legitimate user | High | Reporter reputation/rate, evidence quality, human review, appeal, action confidence/expiry | Medium |
| MOD-06 | Discovery recommends harmful/illegal space | High | Eligibility period, safety requirements, sampling/review, age/region policy, rapid delist | Medium |
| MOD-07 | Public search leaks deleted/private content | High | Permission filter before scoring/snippet, purge pipeline/SLA, index tombstones | Low/Medium |
| MOD-08 | Legal/support export exceeds purpose | High | Scoped export, approval, minimization, transparency/legal policy, immutable access log | Medium |

### 12.1. Private reporting semantics

Для E2EE conversation сервер не получает ambient content. Report flow:

1. Пользователь выбирает конкретные сообщения/профиль/контекст.
2. Клиент показывает preview точного набора данных, включая attachments и ближайший контекст.
3. Клиент формирует report package с plaintext выбранного, locally available provenance и reporter statement.
4. Package шифруется public key Safety service и получает короткую retention policy.
5. Собеседнику не сообщается факт report, если это создаёт retaliation risk.
6. Report не рассматривается как безусловное доказательство авторства вне определённой protocol semantics.

## 13. Media, files and previews

| ID | Threat | Initial | Required control | Residual |
| --- | --- | --- | --- | --- |
| MED-01 | Public bucket/signed URL leaks file | Critical | Block public access, object authorization, short-lived audience-bound URL/cookie, random ID not sole control | Low |
| MED-02 | MIME/polyglot/active-content attack | High | Magic-byte sniff, transcode safe formats, attachment disposition, sandbox, no inline SVG/HTML | Medium |
| MED-03 | Malware in E2EE file | High | Client warnings, OS scanning where available, sender reputation; optional user-consented local scan; server cannot scan plaintext | Medium/High inherent |
| MED-04 | Image parser exploit | High | Maintained sandboxed codecs, memory limits, server-side transcode for Moderated, client hardening/fuzzing | Medium |
| MED-05 | Metadata/EXIF leaks location | High | Strip by default on upload/share preview; explicit «send original metadata» choice | Low |
| MED-06 | Upload quota/storage DoS | High | Reservation, per-user/space quotas, multipart limits, abandoned-upload GC, billing alarms | Medium |
| MED-07 | Thumbnail/transcript leaks Private plaintext | Critical | Generate locally for Private or encrypt derivative separately; no server transcription without explicit export | Low |
| MED-08 | CDN cache serves wrong authorization | Critical | Auth-aware cache key or opaque encrypted blob; `private/no-store` where applicable; cache poisoning tests | Low |

## 14. Calls and realtime media

| ID | Threat | Initial | Required control | Residual |
| --- | --- | --- | --- | --- |
| CALL-01 | SFU/TURN hears media | Critical | E2EE frame encryption above transport; audited group key management; keys never sent to SFU | Low/Medium endpoint |
| CALL-02 | Unknown participant joins/impersonates | High | Lobby/invite auth, visible roster, join/leave epoch change, verification code for high risk | Medium |
| CALL-03 | Old participant decrypts future frames | Critical | Rekey on membership epoch, bounded transition, stale-key rejection | Low |
| CALL-04 | Screen share exposes unexpected window | High | Explicit source picker, persistent indicator, pause, sensitive-notification guidance | Medium user-dependent |
| CALL-05 | IP disclosure peer-to-peer | Medium/High | TURN relay privacy option/default for high-risk mode; disclose latency trade-off | Low/Medium |
| CALL-06 | TURN bandwidth theft/DoS | High | Short-lived scoped credentials, quotas, allocation limits, egress anomaly alerts | Medium |
| CALL-07 | Recording ambiguity | High | OS/platform signals where available; Luxora recording requires participant indicator/consent; cannot prevent external camera | Medium |
| CALL-08 | Stage/broadcast falsely marked E2EE | Critical | Separate call class and disclosure before join; security icon derives from negotiated state, not room name | Low |

## 15. Client and platform threats

| ID | Threat | Required control |
| --- | --- | --- |
| CLI-01 | Local DB/cache theft | OS data protection + encrypted sensitive DB/index + key not colocated unprotected; logout/revoke cleanup |
| CLI-02 | Clipboard/screenshot leakage | Avoid auto-copy; clear sensitive temporary values where platform permits; view-once warning; no impossible screenshot-prevention claim |
| CLI-03 | Notification preview leakage | Per-device preview policy, opaque Private push, local decrypt extension only after threat review |
| CLI-04 | Root/jailbreak/debug hooks | Detect as risk signal where reliable, do not pretend perfect; protect keys with hardware/OS controls; high-risk warning/feature limits proportionately |
| CLI-05 | Malicious deep/universal link | Strict scheme/host/path parsing, confirmation for join/link-device/payment-like actions, no token in link |
| CLI-06 | Web service worker/cache leaks | Scope correctly, no cache for secrets, purge on logout, versioned cache migration, CSP |
| CLI-07 | Desktop filesystem permissions/backups | User-only permissions, OS credential vault, sensitive backup exclusions or encrypted backup |
| CLI-08 | Accessibility overlay spoofing/clickjacking | Platform secure-window judiciously for secrets, explicit local-auth dialogs, Web frame-ancestors CSP |
| CLI-09 | Malicious/stale client protocol | Minimum supported versions for critical security migrations; signed updates; fail closed on unsupported crypto |

## 16. Metadata and privacy threats

| ID | Threat | Control |
| --- | --- | --- |
| PRIV-01 | Contact discovery uploads address book/social graph | Explicit permission at point of use; private discovery/PSI research; salted hashes alone do not protect low-entropy phone numbers |
| PRIV-02 | Presence becomes surveillance history | Approximate ephemeral presence, no long-term raw history, user visibility controls, request/block boundary |
| PRIV-03 | IP/device fingerprint correlates identities | Short retention, coarse derived region, separation from product analytics, relay option for calls |
| PRIV-04 | Push token correlates account/device | Treat as sensitive, rotate/delete, restrict provider payload, separate mapping service |
| PRIV-05 | Search queries expose intent | Private query stays local; Moderated query logs disabled/redacted or short-lived with coarse aggregate |
| PRIV-06 | Notification timing reveals conversation | Metadata-minimized mode may batch/opaque wakeups with battery/latency disclosure |
| PRIV-07 | Ciphertext size/timing reveals behavior | Padding/batching evaluated for Secret mode; default mode documents residual leakage |
| PRIV-08 | Analytics recreates social graph | No raw participant/content IDs in product analytics; privacy review for every event/schema |

### 16.1. Secret metadata-minimized mode requirements

Перед реализацией отдельный UX и security review должен зафиксировать:

- какие metadata остаются у server/push/network observer;
- поддерживаются ли multi-device history, backup, calls, reactions, receipts и search;
- влияет ли batching/padding/relay на latency, data и battery;
- как проходит device loss/recovery;
- что может быть отправлено при report;
- отсутствие слов «анонимный» и «невидимый», если свойства не доказаны.

## 17. Infrastructure, operations and supply chain

- Production разделён по accounts/projects/environments; dev/test не имеют production datasets/secrets.
- KMS/HSM keys имеют purpose-specific policy, rotation, audit и break-glass procedure; application DB admins не получают KMS admin автоматически.
- Service-to-service identity короткоживущая; network allowlists не заменяют auth.
- Database/object backups encrypted, restore-тестируются и имеют deletion/retention policy.
- SQLite M0: restrictive file permissions, WAL/shm included consistently in backup, no shared network filesystem; production migration gate обязателен.
- IaC, container/base images and dependencies pinned/scanned; SBOM генерируется на release.
- CI jobs используют least-privilege ephemeral credentials; untrusted PR не получает secrets.
- Release artifacts signed; mobile/desktop update channel проверяет signature и защищён от rollback на уязвимую версию.
- Branch protection, mandatory review for auth/crypto/permissions, CODEOWNERS/security ownership.
- SAST, SCA, secret scan, IaC scan, DAST, API negative tests и fuzzing parsers входят в gates.
- Production admin access — phishing-resistant MFA/passkey, JIT, reason, session recording/audit по закону и policy.
- Egress allowlisting для link preview/media processors; SSRF-sensitive metadata endpoints недоступны.

## 18. Logging, telemetry and support controls

### 18.1. Никогда не логировать

- Password, access/refresh token, passkey assertion secret material.
- E2EE keys, backup recovery secret, device-link secret.
- Message/media plaintext, drafts, notification preview, exact search query.
- Full email/phone/IP when coarse or tokenized value sufficient.
- Signed object URLs и authorization headers.

### 18.2. Разрешённый operational event shape

- Timestamp, service/build, coarse region, request/event class, outcome/error taxonomy, latency bucket.
- Rotating pseudonymous account/session correlation ID с короткой retention.
- Resource type и opaque scoped correlation ID только если нужен incident diagnosis.
- Security-relevant action: actor, target class, policy decision, reason, ticket/approval; без content.

### 18.3. Support

- Support impersonation запрещён; staff не запрашивает password/OTP/recovery secret.
- View-as-user tooling не получает Private content и требует explicit user-consented diagnostic bundle.
- Любой privileged lookup имеет purpose, case ID и immutable access audit.
- Diagnostic export показывает пользователю exact contents и redacts secrets автоматически.

## 19. Current M0 mandatory controls

До любого shared deployment должны быть доказаны:

1. TLS, production HSTS и exact CORS/Origin allowlists.
2. Argon2id parameters и rehash path; password/token log canaries absent.
3. JWT algorithm/claim validation; secret entropy/startup failure при weak/default secret.
4. Atomic refresh rotation/reuse revocation; per-device list/revoke.
5. Object-level authorization negative tests для каждого endpoint.
6. Strict request schemas, body/pagination/message/member bounds.
7. WS auth deadline, resume-account binding, heartbeat/backpressure и event authorization.
8. Parameterized storage access, file permissions, consistent WAL backup behavior.
9. Redacted structured logs; no stack/error echo with secrets.
10. Rate limits для register/login/search/send/typing/reaction/reconnect.
11. Explicit preview banner: no sensitive data, no E2EE claim.
12. Dependency/secret scan, reproducible clean install/test и incident contact.

## 20. Validation program

| Layer | Required validation |
| --- | --- |
| Unit/property | Permission invariants, monotonic cursors, token family transitions, parser bounds |
| Integration | Cross-account IDOR, revoked session, duplicate/replay, reconnect gap, concurrent edit/delete |
| Fuzz | JSON/event parsers, rich text, media metadata, E2EE envelopes/state, deep links |
| DAST/API | Auth bypass, injection, CORS/CSRF, cache, rate-limit evasion, error leakage |
| Mobile/Web | MASVS/ASVS mapped checklist, local storage, screenshots/clipboard, Web CSP/XSS |
| Infrastructure | IAM/KMS/object public access, secret exposure, backup restore, network egress |
| Abuse | Spam/raid/report brigading/admin misuse simulations |
| Crypto | Test vectors, interop, downgrade, state-loss, identity substitution, independent design+implementation audit |
| Human | Phishing/recovery/support exercises, privilege review, incident tabletop |

References: [OWASP ASVS 5.0](https://owasp.org/www-project-application-security-verification-standard/), [OWASP MASVS](https://mas.owasp.org/MASVS/), [NIST SP 800-63B-4](https://pages.nist.gov/800-63-4/sp800-63b.html), [RFC 9420](https://www.rfc-editor.org/info/rfc9420/).

## 21. Residual top risks

1. **M0 server-readable content.** Acceptable only for non-sensitive preview/test data with explicit disclosure; blocks production privacy claim.
2. **Endpoint compromise.** Remains high-impact even after E2EE; mitigated with OS key protection, updates and session/device controls.
3. **Identity service compromise.** Key transparency/verification reduces silent substitution but требует независимого monitor и зрелого UX.
4. **Abuse in E2EE.** Server cannot proactively inspect content; requests, rate/risk signals and explicit user reports remain necessary.
5. **Metadata correlation.** Default low-latency multi-device push exposes some timing/network metadata; Secret mode only after measured design.
6. **Supply chain.** A signed malicious client defeats E2EE; release pipeline and signing keys are cryptographic trust roots.
7. **PQ transition.** Long-lived private content may face harvest-now-decrypt-later risk until an audited hybrid profile is deployed.

## 22. Review cadence and ownership

- Threat model updated при изменении auth, trust class, crypto profile, device linking, backup, search, push, media, calls, moderation, analytics или infrastructure boundary.
- Quarterly review до GA, затем минимум дважды в год и после каждого material incident.
- Product owns truthful wording and consent; Security owns threat/risk acceptance; Engineering owns controls/evidence; Privacy/Legal own purpose/retention; Operations owns detection/response.
- Закрытие риска требует link на test/audit/config/runbook evidence, а не только статус «done».
