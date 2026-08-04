# Luxora — Product Requirements Document

**Канонический релиз:** Beta-0.1  
**Разработчик и владелец:** Flenym  
**Дата:** 3 августа 2026  
**Связанные документы:** [Product Research](../research/PRODUCT_RESEARCH.md), [Threat Model](THREAT_MODEL.md), [UX Flows](UX_FLOWS.md), [Release Quality Gates](RELEASE_QUALITY_GATES.md)

## 1. Product statement

**Luxora — спокойный, премиальный мессенджер для личных разговоров и осмысленных сообществ, в котором модель приватности видима до отправки первого сообщения.**

Пользователь получает один согласованный опыт на iPhone, iPad, macOS, Android, Windows, Linux и Web. Клиенты не обязаны выглядеть одинаково: они обязаны использовать одну информационную архитектуру, один security contract, одинаковые message semantics и нативные conventions каждой платформы.

## 2. Цели

### 2.1. Пользовательские outcomes

- Новый пользователь создаёт защищённый аккаунт и отправляет первое сообщение менее чем за 60 секунд, если контакт уже известен.
- Сообщение никогда не «теряется молча»: видны pending, sent, delivered, read или failed.
- Переключение устройств не нарушает порядок, drafts, read state, archive, pins и notification preferences.
- До вступления или отправки пользователь понимает, является пространство Private или Moderated.
- Неизвестный отправитель не получает presence/read/call доступ до accept.
- Большое сообщество остаётся понятным благодаря onboarding, topics, roles и персонализированному списку каналов.
- Интерфейс ощущается быстрым и премиальным, сохраняя contrast, Reduced Motion и keyboard/screen-reader usability.

### 2.2. Бизнес/операционные outcomes

- Архитектура поддерживает постепенное увеличение нагрузки без изменения публичных message semantics.
- Public discovery не монетизируется за счёт личного social graph или содержимого private conversations.
- Security claims технически проверяемы, versioned и проходят отдельный approval gate.
- Abuse operations имеют инструменты для public/moderated контекста, не создавая скрытого доступа к E2EE private content.

### 2.3. Не-цели первой production-версии

- Собственный криптографический протокол.
- Неограниченный анонимный global username search.
- Рекламная лента между личными чатами.
- Blockchain/кошелёк/платежи как часть core messaging.
- Полноценная workplace-suite замена с документами и project management.
- Federation между независимыми серверами до стабилизации abuse, identity и key-transparency моделей.

## 3. Термины и классы доверия

| Термин | Значение |
| --- | --- |
| Conversation | Упорядоченная лента сообщений с устойчивым ID и membership |
| Direct | Разговор двух аккаунтов |
| Circle | Закрытый групповой разговор без дерева каналов |
| Space | Долгоживущее сообщество с каналами, темами, ролями и onboarding |
| Channel | Broadcast-поток с optional comments/topics |
| Room | Audio/video пространство: ad-hoc, scheduled или drop-in |
| Device | Отдельный доверенный endpoint аккаунта со своей сессией; в E2EE target — со своей identity key |
| Private | Целевая E2EE-модель: сервер не имеет plaintext content; поиск содержимого выполняется на устройствах |
| Moderated | Сервер может индексировать и обрабатывать контент для модерации/search; это видно до вступления |
| Current Cloud | Текущий runnable slice: TLS + secure auth + server-readable content + storage-encryption hooks; **не E2EE** |

### 3.1. Неподвижные правила trust class

- Trust class виден в create/join flow и в conversation details.
- Private/Moderated нельзя изменить «переключателем» после появления контента.
- Миграция создаёт новый контейнер, показывает последствия и требует подтверждения владельца и участников по policy.
- Push payload для Private не содержит plaintext preview, если устройство не выдало локальное разрешение и platform mechanism не позволяет безопасную decryption extension.
- UI и marketing используют термин E2EE только после выполнения gates `SEC-E2EE-*` из Release Quality Gates.

## 4. Аудитории и jobs-to-be-done

### P1. Личный пользователь

«Когда я общаюсь с близкими, я хочу быстро найти человека, понять, что разговор приватный, и продолжить на другом устройстве без потери контекста».

### P2. Мобильная группа

«Когда мы координируем поездку/семью/учёбу, я хочу сообщения, media, poll/event, pins и call без настройки сервера».

### P3. Участник сообщества

«Когда я вступаю в большое пространство, я хочу сразу увидеть нужные темы, правила и людей, не разбираясь в десятках каналов».

### P4. Владелец/модератор

«Я хочу настроить роли и безопасное onboarding, видеть audit log, управлять spam/raid и применять понятные санкции без скрытых permission conflicts».

### P5. Пользователь высокого риска

«Я хочу проверять devices/identity, отключать discoverability, использовать disappearing messages и понимать metadata/backup limitations без маркетинговых эвфемизмов».

### P6. Creator/organization

«Я хочу публиковать обновления, организовать comments/topics и видеть агрегированную аналитику без доступа к личным данным подписчиков».

## 5. Платформенная стратегия

### 5.1. Целевые клиенты

- **Apple:** SwiftUI для iPhone/iPad/macOS, shared domain layer там, где это не ухудшает platform behavior.
- **Android:** нативный Kotlin/Compose client.
- **Windows/Linux:** desktop client с нативными integrations, keyboard-first UX и background update strategy.
- **Web:** responsive web app/PWA с installable shell, offline cache и feature detection.

Общий backend и формальные protocol contracts обязательны. Общая UI codebase не является целью сама по себе.

### 5.2. Adaptive layout contract

- Compact: один pane, navigation stack, bottom-level destinations.
- Medium: list + conversation, optional details sheet.
- Expanded desktop/tablet: resizable sidebar + conversation + inspector; independent call window/popout разрешён.
- Все critical actions доступны pointer, keyboard и touch.
- RTL, Dynamic Type/text scaling, screen reader, high contrast и Reduced Motion входят в design baseline.

## 6. Этапы поставки

| Этап | Результат | Не является |
| --- | --- | --- |
| M0 — Runnable foundation | Web experience + рабочий auth/messaging/realtime backend slice; честная Current Cloud маркировка | Production messenger, E2EE или заявка на scale |
| M1 — Private beta | Direct/Circle messaging, media baseline, offline/reconnect, multi-device sessions, safety baseline, Web + первые native clients | Public discovery или security-certified E2EE |
| M2 — Trust beta | Audited Private E2EE pilot, encrypted backup pilot, key verification/transparency, calls beta | Разрешение автоматически включить E2EE всем |
| M3 — Community beta | Moderated Spaces, channels, topics, roles, onboarding, reports, audit log, public search under eligibility rules | Смешение private/public content |
| M4 — GA | Все целевые платформы, calls/media/search, SLO/DR/ops, accessibility/localization gates, security claims approved | «Готово навсегда»; roadmap продолжается |

## 7. Текущий runnable backend contract (M0)

Этот раздел описывает согласованный минимум и не расширяет security claim.

### 7.1. Runtime и storage

- Node.js 22 + Fastify.
- SQLite WAL за repository abstraction для local/single-node slice; production storage выбирается до M1 scale gate.
- TLS обязателен вне локальной разработки.
- Encryption at rest является deployment/KMS concern; наличие hook/config не означает, что каждое dev-окружение зашифровано.

### 7.2. Authentication

- Password KDF: Argon2id, минимум `m=64 MiB, t=3, p=1`; параметры versioned и могут усиливаться при login.
- Access token: HS256 JWT, TTL 15 минут, secret минимум 32 random bytes; production roadmap предусматривает asymmetric signing/key rotation.
- Refresh token: opaque random 256-bit, в БД только hash, rotation on use; reuse detection отзывает связанную session/token family.
- Сессии per-device, с просмотром и remote revoke.

### 7.3. HTTP surface

- `POST /v1/auth/register`
- `POST /v1/auth/login`
- `POST /v1/auth/refresh`
- `DELETE /v1/auth/sessions/current`
- `GET /v1/auth/sessions`
- `DELETE /v1/auth/sessions/:id`
- `GET /v1/me`
- `GET /v1/users/search`
- `GET|POST /v1/chats`
- `GET /v1/chats/:id/messages`
- `POST /v1/chats/:id/messages`
- `PATCH|DELETE` message resources
- read receipt endpoint
- `PUT|DELETE` reaction resource

### 7.4. Realtime surface

- `WS /v1/realtime` is numeric compatibility; `WS /v2/realtime` is the current scoped recovery contract.
- V2 client flow: `hello → authenticate(accessToken, resumeCursor?) → ready → dispatch* → sync.checkpoint`.
- Server events carry sparse global `sequence` plus an opaque account/session-bound cursor; sequence adjacency is never required.
- Event classes: message mutations, reaction/read changes, typing и presence.
- Client persists a dispatch/checkpoint cursor only after idempotent application; any `sync.required` uses the authoritative HTTP reset boundary, never silent skip.

### 7.5. Bounds

- HTTP body ≤ 1 MiB в M0; binary media идёт в отдельный upload pipeline позже.
- Message text ≤ 10,000 Unicode code points после нормализации policy.
- Pagination hard max 100.
- Listed members при создании группы ≤ 200 в M0.
- Global rate limit baseline 300 requests/minute/account/IP strategy; auth endpoints имеют существенно более строгие buckets.
- Helmet, explicit CORS allowlist, strict Zod schemas и redacted structured logs обязательны.

## 8. Functional requirements

Приоритеты: **P0** — блокирует соответствующий milestone; **P1** — нужен до GA; **P2** — после GA/эксперимент.

### 8.1. Identity, registration, sessions

| ID | Priority | Requirement | Acceptance |
| --- | --- | --- | --- |
| ID-001 | P0 | Аккаунт имеет immutable internal ID, mutable profile name и optional unique username | Смена username не меняет conversation identity и оставляет security audit event |
| ID-002 | P0 | Регистрация M0 поддерживает secure password flow; target добавляет passkey-first | Пароль никогда не логируется; generic error не раскрывает существование аккаунта |
| ID-003 | P0 | Username search в M0 rate-limited и не раскрывает phone/email | Exact/prefix policy документирована; blocked users исключены |
| ID-004 | P0 | Список устройств показывает platform, приблизительное location/IP-derived region, first/last active и current marker | Любую чужую session можно отозвать; revoke действует на refresh и realtime |
| ID-005 | P1 | Passkeys/WebAuthn являются рекомендуемым primary authenticator | Поддерживается multiple authenticators, recovery и lost-device flow |
| ID-006 | P1 | QR-linking требует approval с уже доверенного устройства и отображает target device/origin | QR одноразовый, короткоживущий, origin-bound; approval требует local auth |
| ID-007 | P1 | Телефон/email могут быть verification/recovery channels, но не обязаны быть публичной identity | Visibility и discoverability настраиваются независимо |
| ID-008 | P1 | High-risk режим отключает phone discoverability, link previews и unknown calls | Все изменения объясняют usability cost до применения |

### 8.2. Contact initiation and safety boundary

| ID | Priority | Requirement | Acceptance |
| --- | --- | --- | --- |
| CNT-001 | P0 | Неизвестный пользователь создаёт message request, а не обычный Direct | Получатель видит accept, delete и block/report |
| CNT-002 | P0 | До accept отправитель не получает read receipt, precise presence или возможность звонка | Проверено API authorization tests |
| CNT-003 | P0 | Request preview ограничивает media/links и частоту повторной отправки | Dangerous attachment не рендерится inline |
| CNT-004 | P1 | Shared Spaces/groups показываются как локальный trust cue, не как гарантия личности | UI не использует формулировку «verified» |
| CNT-005 | P1 | Exact username/QR/link доступен без глобального каталога private identities | Search enumeration tests проходят |

### 8.3. Message model and composer

| ID | Priority | Requirement | Acceptance |
| --- | --- | --- | --- |
| MSG-001 | P0 | Send использует client-generated idempotency key и optimistic local echo | Повтор запроса не создаёт duplicate; canonical ID заменяет local ID без скачка |
| MSG-002 | P0 | Состояния: composing, pending, sent/server-accepted, delivered-device, read, failed | State semantics одинаковы на всех клиентах и документированы |
| MSG-003 | P0 | Reply/quote хранит stable target reference и safe snapshot | Deleted target не ломает thread; видно «original unavailable» |
| MSG-004 | P0 | Edit создаёт revision metadata; UI помечает edited | Concurrent edit разрешается server revision/precondition; конфликт не теряет draft |
| MSG-005 | P0 | Delete имеет scopes local/everyone согласно policy | Scope и последствия видны до confirm; tombstone синхронизируется |
| MSG-006 | P0 | Reactions идемпотентны per actor/reaction; counts приходят realtime | Reconnect reconciliation не удваивает count |
| MSG-007 | P0 | Read cursor монотонный per device/conversation | Старое событие не откатывает прочитанность |
| MSG-008 | P0 | Typing — ephemeral, rate-limited, auto-expiring | Не хранится в durable history/analytics |
| MSG-009 | P1 | Pins, forwards, scheduled send, drafts и saved messages синхронизируются | У каждого объекта есть явный permission/retention contract |
| MSG-010 | P1 | Rich text ограничен безопасным semantic subset | Copy/paste round-trip и screen-reader reading order проходят |
| MSG-011 | P1 | History of edits видна согласно trust class/policy | Public moderation log нельзя стереть обычным edit/delete |
| MSG-012 | P2 | Translation/AI actions работают только по явному invoke и показывают data boundary | Private plaintext не отправляется third party без per-action consent |

### 8.4. Sync and offline

| ID | Priority | Requirement | Acceptance |
| --- | --- | --- | --- |
| SYNC-001 | P0 | Все durable events имеют monotonically ordered stream position в пределах заявленного scope | Gap detection, replay и duplicate tests обязательны |
| SYNC-002 | P0 | Offline send queue сохраняет порядок пользователя и idempotency keys | Kill/relaunch не теряет queued message; user может retry/cancel |
| SYNC-003 | P0 | Reconnect использует resume cursor, затем bounded reconciliation | После forced gap состояние совпадает с server snapshot |
| SYNC-004 | P0 | Clock клиента не определяет canonical order | ±24h clock skew не ломает order/expiry display |
| SYNC-005 | P1 | Draft/archive/mute/pin/folder state синхронизируется независимо от message stream | Conflict policy deterministic и тестируется на двух devices |
| SYNC-006 | P1 | History bootstrap пагинируется и не блокирует realtime head | Новые сообщения видны до завершения загрузки истории |

### 8.5. Media and files

| ID | Priority | Requirement | Acceptance |
| --- | --- | --- | --- |
| MED-001 | P1 | Direct-to-object-storage resumable upload с short-lived scoped credentials | App server не буферизует large file; resume работает после network loss |
| MED-002 | P1 | Pre-upload validation, MIME sniffing, filename normalization, quotas и malware pipeline для Moderated content | Executable/polyglot samples не становятся active content |
| MED-003 | P1 | Private media шифруется на клиенте отдельным content key | Object store/CDN не получает plaintext; key не находится в URL/log |
| MED-004 | P1 | Progressive image/video/audio rendering не раскрывает media через public cache | Cache headers и signed URL expiry тестируются |
| MED-005 | P1 | Voice/video notes имеют waveform, duration, playback speed и transcript opt-in | Transcript boundary объяснён; accessibility alternative есть |
| MED-006 | P1 | File size limits versioned server capability, не hardcoded marketing | Клиент корректно показывает limit до upload |

### 8.6. Search, folders, archive

| ID | Priority | Requirement | Acceptance |
| --- | --- | --- | --- |
| SRCH-001 | P0 | M0 search явно отражает только server-readable Current Cloud data | UI не помечает его E2EE/private index |
| SRCH-002 | P1 | Private full-text index строится локально из расшифрованных сообщений | Index encrypted at rest; logout/device revoke очищает keys/index |
| SRCH-003 | P1 | Search scope включает People, Conversations, Messages, Media/Files и Public Spaces согласно permissions | Result не раскрывает inaccessible snippet/count |
| SRCH-004 | P1 | Filters поддерживают sender/date/type/space | Empty/no-access/offline states различаются |
| ORG-001 | P1 | Archive не равен delete и может auto-return on new message по preference | Поведение синхронизируется |
| ORG-002 | P1 | Smart/custom folders используют include/exclude rules и manual pins | Preview показывает, какие чаты войдут до save |

### 8.7. Circles, Spaces, channels, topics

| ID | Priority | Requirement | Acceptance |
| --- | --- | --- | --- |
| GRP-001 | P0 | Circle membership имеет owner/admin/member roles и versioned membership events | Removed member немедленно теряет API/realtime access |
| SPC-001 | P1 | Space создаётся с выбранным immutable trust class | Class и последствия видны на create/join/overview |
| SPC-002 | P1 | Role templates: owner, admin, moderator, member, guest; custom roles расширяют их | Effective permissions explainable; deny/allow conflict deterministic |
| SPC-003 | P1 | Channels поддерживают text, media, topic/forum, announcement и voice room semantics | Channel type определяет composer, notifications и permissions |
| SPC-004 | P1 | Onboarding имеет не более 5 коротких вопросов и назначает relevant channels/roles | Всегда есть skip с safe defaults; ответы можно изменить |
| SPC-005 | P1 | Topics имеют title, tags, participants, state open/closed и notification policy | Search и deep links сохраняют topic context |
| SPC-006 | P1 | Channel comments — отдельный thread/topic, не визуально неразличимый second inbox | Admin может выключить comments, slow mode и approval |
| SPC-007 | P1 | Public discovery требует age/safety/quality eligibility и preview before join | Private members/social graph не участвуют в ranking без consent |
| SPC-008 | P1 | Moderation actions имеют reason, actor, scope, expiry и immutable audit record | Moderators видят preview-as-role и appeal workflow |

### 8.8. Calls and live rooms

| ID | Priority | Requirement | Acceptance |
| --- | --- | --- | --- |
| CALL-001 | P1 | 1:1 audio/video call поддерживает ringing, decline, busy, reconnect и device handoff policy | State machine протестирована на race cases |
| CALL-002 | P1 | Group call поддерживает link/invite, lobby/approval, grid/focus, active speaker, reactions и raise hand | Host controls и participant privacy доступны с keyboard/screen reader |
| CALL-003 | P1 | Screen share позволяет выбрать application/window/screen и всегда показывает persistent sharing indicator | OS permission отказ не разрывает call |
| CALL-004 | P1 | Network adaptation меняет bitrate/resolution без UI freeze | Quality downgrade объясним, reconnect не создаёт ghost participant |
| CALL-005 | P1 | Noise suppression/echo cancellation имеют clear state и off option | Music/high-fidelity use case не искажается без возможности отключить |
| CALL-006 | P1 | E2EE call claim имеет verification UI и отдельный audited protocol gate | Stage/broadcast exception маркируется до join |

### 8.9. Notifications, presence, status

| ID | Priority | Requirement | Acceptance |
| --- | --- | --- | --- |
| NTF-001 | P0 | Permission prompt появляется после in-app explanation/first relevant action | Dismiss сохраняет способ включить позже |
| NTF-002 | P0 | Per-conversation mute, mentions-only и global quiet schedule синхронизируются | Mute не влияет на unread count без отдельного выбора |
| NTF-003 | P1 | Private notification previews управляются global + per-chat policy | Locked screen не получает plaintext при disabled previews |
| PRS-001 | P0 | Presence approximate, expiring и privacy-controlled | Disconnect/timeout очищает online; block/request boundary соблюдается |
| PRS-002 | P1 | Status имеет audience и expiry; не используется для ad targeting | Audience preview доступен до publish |

### 8.10. Profile, settings, localization, accessibility

| ID | Priority | Requirement | Acceptance |
| --- | --- | --- | --- |
| PROF-001 | P0 | Profile содержит name, avatar, bio, username и links с granular visibility | Dangerous URLs предупреждаются; metadata не раскрывает registration date без choice |
| SET-001 | P0 | Light/dark/system theme; reduce transparency/motion respects OS | Нет unreadable glass state в любой теме |
| SET-002 | P1 | Privacy Checkup группирует controls по вопросам «кто может найти/написать/позвонить/увидеть» | Результат summary экспортируем для support без secret values |
| L10N-001 | P1 | Все user-facing strings локализуемы, включая plural/date/number/RTL | Pseudo-localization + RTL visual test входят в CI |
| A11Y-001 | P0 | Semantics, focus order, labels, keyboard и screen reader поддерживаются для core flow | Register → find → request → send → read выполним без pointer/vision |
| A11Y-002 | P0 | Text scaling/Dynamic Type не скрывает content/actions | Largest accessibility sizes проходят без critical truncation |
| A11Y-003 | P0 | Status не кодируется только цветом/анимацией | Есть label/symbol; Reduced Motion сохраняет смысл |

## 9. Security and privacy requirements

| ID | Priority | Requirement | Acceptance |
| --- | --- | --- | --- |
| SEC-001 | P0 | TLS 1.2+ baseline, TLS 1.3 preferred; HSTS production | Plain HTTP redirect/deny policy проверена; weak suites disabled |
| SEC-002 | P0 | Authorization проверяется на каждом object access, не только в UI | IDOR suite покрывает chat/message/session/media/admin resources |
| SEC-003 | P0 | Secrets и message content не попадают в logs/traces/crash reports | Automated canary-secret/log scan проходит |
| SEC-004 | P0 | Refresh reuse, credential stuffing, enumeration и realtime abuse обнаруживаются/ограничиваются | Runbooks и alerts проверены table-top exercise |
| SEC-005 | P0 | Storage encryption hooks не рекламируются как E2EE | Claim inventory содержит owner/evidence/expiry |
| SEC-E2EE-001 | P0 для M2 | Per-device identity, authenticated device linking/revocation и recovery semantics реализованы | Protocol tests + independent audit без Critical/High |
| SEC-E2EE-002 | P0 для M2 | 1:1 protocol обеспечивает FS/PCS согласно выбранной audited design; group protocol основан на audited MLS/эквиваленте | Formal protocol profile, test vectors, interop и downgrade tests |
| SEC-E2EE-003 | P0 для M2 | Key verification/transparency и key-change UX защищают от silent server key substitution | Split-view/rollback simulation обнаруживается |
| SEC-E2EE-004 | P0 для M2 | Encrypted backup opt-in, recovery secret только у пользователя | Provider не может восстановить plaintext/secret; lost-key warning tested |
| SEC-E2EE-005 | P0 для M2 | Search, link preview, translation, report и notification semantics не создают скрытый plaintext channel | Data-flow review и adversarial privacy test подписаны |
| PRIV-001 | P0 | Data inventory, purpose, retention, deletion и access roles документированы | Каждое поле schema имеет classification/retention owner |
| PRIV-002 | P1 | Telemetry минимизирована, pseudonymous и отключаема там, где не essential | Raw content/contacts/social graph запрещены в product analytics |

Подробности и abuse cases: [Threat Model](THREAT_MODEL.md).

## 10. Performance, reliability and scale objectives

Эти цифры — release objectives, а не обещание без измерения.

| Метрика | Private beta | GA target |
| --- | --- | --- |
| API availability | 99.9% monthly | 99.95% monthly |
| Send → server accepted, same region | p95 ≤ 250 ms, p99 ≤ 750 ms | p95 ≤ 200 ms, p99 ≤ 600 ms |
| Accepted → online recipient dispatch | p95 ≤ 500 ms | p95 ≤ 350 ms |
| Reconnect/resume after 10 s outage | p95 ≤ 2 s after network restored | p95 ≤ 1.5 s |
| Duplicate visible messages | 0 in correctness suite; < 1 ppm measured | < 0.1 ppm |
| Crash-free sessions | ≥ 99.5% | ≥ 99.8% |
| Web LCP landing/app shell on reference 4G | ≤ 2.5 s | ≤ 2.0 s |
| Core interaction animation | 60 fps target; no task blocked | ≥ 99% frames within platform budget on reference devices |
| Data loss | 0 acknowledged durable messages | 0 acknowledged durable messages |

## 11. Product analytics without content surveillance

### 11.1. North-star

**Weekly Meaningful Conversations (WMC):** conversations with at least two consenting participants and at least one response in a rolling week. Для Private контекста сервер считает только минимально необходимое delivery event metadata; message text/media не используется.

### 11.2. Supporting metrics

- Registration completion and median time-to-first-message.
- Message send success, retry, duplicate and delivery latency.
- Message-request accept/block/report rates, grouped by coarse abuse risk bucket.
- D1/D7 retained conversations, not raw time-in-app.
- Call connect success, join latency and quality failure categories.
- Search success via local on-device metric aggregation or privacy-preserving coarse events.
- Space onboarding completion and first relevant channel visit.
- Accessibility core-flow pass rate in automated/manual audits.

### 11.3. Запрещённые analytics inputs

- Plaintext message/media/voice transcription.
- Contact book, exact search query или full username graph.
- Private group membership graph для ranking/ads.
- Precise location или continuous presence history.
- Encryption keys, tokens, recovery codes, notification plaintext.

## 12. Основные риски и принятые решения

| Риск | Решение |
| --- | --- |
| E2EE конфликтует с server search/moderation | Immutable Private vs Moderated class; локальный search для Private |
| Multi-device усложняет identity/recovery | Per-device sessions сейчас; per-device crypto identity + transparency до M2 claim |
| Большая scope всех платформ | Protocol-first milestones, native platform teams, одинаковые semantics вместо pixel parity |
| Communities создают spam/raid нагрузку | Requests, rate tiers, onboarding, discovery eligibility, audit/appeal |
| Liquid Glass ухудшает contrast/GPU | Glass только functional layer; accessibility/performance gates |
| Current prototype воспринимают как production | Persistent M0 disclosure, claim inventory, README/UI wording gate |
| SQLite принимают за финальную scale architecture | Repository abstraction + mandatory storage migration/load gate до M1 |

## 13. Definition of Done для продуктовой функции

Функция считается готовой, когда:

1. Есть user story, permission/trust context и measurable acceptance criteria.
2. Определены empty/loading/offline/error/conflict/deleted states.
3. Есть API/event schema compatibility и migration behavior.
4. Пройдены unit/integration/UI/accessibility/security tests соответствующего риска.
5. Telemetry не содержит запрещённые поля и имеет retention owner.
6. Copy не делает неподтверждённых security/performance claims.
7. Документация и support/runbook обновлены.
8. Rollout имеет feature flag, kill switch, owner и rollback condition.
9. Release gates из [Release Quality Gates](RELEASE_QUALITY_GATES.md) подписаны.
