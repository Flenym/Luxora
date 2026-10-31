# Luxora iPhone — функциональная матрица полного завершения

**Релиз:** Beta-0.1

**Владелец и разработчик:** Flenym

**Назначение:** не позволять команде подменять работающую функцию экраном, fixture или процентом.

## Правило приёмки

Строка считается закрытой только когда одновременно существуют:

1. канонический server/protocol contract и авторизация;
2. production `LuxoraMobile` implementation без Design Lab dependency;
3. loading/empty/error/offline/retry и destructive confirmation states;
4. unit/contract/integration tests;
5. fixture-free live Docker path там, где функция сетевая;
6. Xcode UI journey и original-resolution screenshot по пользовательскому референсу;
7. accessibility, privacy и security truth без неподтверждённых обещаний.

`DEBUG` fixture может доказать геометрию и взаимодействие, но не сеть. Красивый
PNG не доказывает кнопку. Backend foundation не доказывает iPhone-функцию.

## Текущий функциональный статус

| Область | Server | iPhone | Доказано сейчас | До полного закрытия |
| --- | --- | --- | --- | --- |
| Первый запуск и contour loader | Contract в brand spec | Работает на Simulator | Onboarding и реальный Keychain restore используют две точки на невидимом маршруте; cancel/error/retry, Reduce Motion/Transparency и VoiceOver проверены | Real-device launch/energy gate |
| Ввод телефона и OTP | Реальный development-provider contract + loopback Docker OTP console | Работает для successful new account | Live challenge → OTP → profile required → registration; console security smoke | Existing account, wrong/expired/exhausted/resend/rate-limit/network recovery; production SMS |
| Имя, bio, username при регистрации | Работает; owned processed avatar endpoint реализован | Имя/bio, круглый crop и resumable upload→processed-avatar bind подключены | Live username/registration; fixture-free avatar crop/upload/save, terminate/relaunch restore и clear; server IDOR/privacy/quota tests | Expiry/rate-limit/storage-pressure/poor-network failure matrix и real-device gate |
| Редактирование своего профиля | Имя/bio `PATCH /v1/me` и processed avatar PUT/DELETE реализованы | Имя/bio и remote-avatar picker/crop/upload/clear подключены | Protocol/API tests; fixture-free live save/relaunch/reload/clear; server decode/crop/re-encode и privacy/block/clear | Authenticated image-cache policy, expiry/storage-pressure/network recovery и real-device evidence |
| Keychain session/refresh/logout | Работает | Частично | Restore и revoke live | Device list/revoke UX, compromise/recovery, background expiry races |
| Root shell, tabs, folders, status rail | Account-scoped archive/mute и synchronized custom-folder contracts работают | Русская оболочка с табами (включая Calls как gated-заглушку), горизонтальная folder rail, «Все»/«Архив»/custom filters, settings/editor и status rail подключены | v13 UI evidence 1/1; combined folder/navigation/accessibility UI 4/4; исторические 1206×2622 PNG в `screens_app_iphone/production/v13-chat-folders-ru/` | Полный 62-screen pixel closure, persistence/process-death, real-device и полная accessibility matrix |
| Список чатов | List + account-scoped archive/mute/folders HTTP и приватный V2 realtime работают | HTTP/store, archive swipe, custom-folder filtering, strict scoped V2/recovery и account/session-scoped confirmed cache foundation подключены | Live load/refresh/error/retry; postpromotion scoped V2 preferences/recovery PASS; v13 deterministic production-surface journey; atomic durable tests PASS | Cursor pagination, indexed/evicted local DB, full offline launch, poor-network/process-death live proof и полный live folder UI journey |
| Личный чат и text send | Работает | Text + actions и stable-nonce durable text outbox работают | Live direct/send/list/read/reaction/realtime; reply/edit/delete/forward/pin API/store/UI evidence; restart/corruption/retry/response-loss/order/logout tests PASS | Pagination, offline/local durable drafts, media/mutations, full offline/poor-network/process-death live proof |
| Синхронизированные черновики | GET/PUT/DELETE, CAS/tombstone, encrypted-at-rest state/receipts, membership scrub и private V2 event работают на migration 025 | Authorized load/autosave/delete, reply context, cross-chat restore, pacing/backoff/retry и realtime/session fences подключены; composer показывает sync-состояние и retry | Draft 48/48, Messenger/reconciliation 26/26, capability 11/11; postpromotion Swift→Docker HTTP+V2 1/1; post-patch v15 UI 1/1 | Offline local persistence, real process-death/poor-network/conflict storm, multi-device and real-device gates; server can decrypt drafts, so this is not E2EE; drafts stay outside the strict 12-collection snapshot and recover by authorized lazy GET |
| Message requests незнакомым | Работает (policy/requests/dismiss/accept, GET/PATCH privacy) | API-клиент, store, realtime-события requests, политика «кто может писать» (privacy screen) и тумблер уведомлений подключены; отдельного экрана входящих запросов в текущей модели «незнакомец сразу открывает direct chat» нет — это продуктовое решение, а не отсутствие данных. Исторические кадры раннего UI-среза: `screens_app_iphone/production/v10-message-requests-ru/` | API/store tests; live Docker request flow 1/1; privacy-policy UI smoke | Cursor pagination живого списка (если экран вернут), offline/process-death recovery, полный accessibility/real-device/release gate |
| Группы и каналы | Create/get, роли участников, message authorization и realtime работают | Create/list/search/profile/add/promote/remove/leave подключены; у канала есть честный read-only composer для обычного участника; community management (invite links shown-once + revoke, join-request approval queue, ownership-transfer ceremony, join-by-link) — **проверен Apple CI** | Apple CI: swift-package green на `b682d99`/`d0a7a8f`/`32e0d62`/`df39703` (включая `CommunityManagementStoreTests`); ios-compile FAILED на `d0a7a8f` (`PhoneCommunityViews.swift` optional participant-resolver unwrap), **fixed in `df39703` — финальный прогон зелёный**; API/store 16/16; live Swift→Docker 1/1; signed Xcode UI 3/3; исторические кадры в `screens_app_iphone/production/v12-communities-ru/` | Real-device evidence, cursor pagination, offline/process-death recovery, release accessibility gate |
| Topics/threads/comments | Contract foundation работает | `ChatTopicsStore` + управление топиками в профиле сообщества, chips выбора в композере, фильтр истории и topicID сквозь send-фаннел подключены | Store/contract tests в общем CI-пакете; composer-фильтр и отправка по topicID в коде | Realtime-конвергенция топиков при чужих изменениях, comments/threads как отдельный домен, offline/poor-network proof |
| Attachments и файлы | Upload/storage/download работает (content unscanned; thumbnails и WAV duration серверно проверены) | Отправка и просмотр подключены: composer media strip, photo picker (до 10 изображений), file importer, upload→send с attachmentIds, image-бабл, viewer с зумом, file-row с именем/размером, voice-бабл; file-row пока без open/download/share | Media/upload API tests; object-store security gates; Swift upload→send→view в общем CI-пакете | File open/download/share UX, video playback/thumbnail, upload resume/retry/background evidence, scan/transcode pipeline |
| Фото и видео | Raw storage + server-verified thumbnails/dimensions | Фото: галерея→crop-free send→просмотр и viewer с зумом работают. Видео: клиентского picker/playback нет (файл уйдёт как generic file) | Image send/view в коде; server metadata tests | Video picker/playback/thumbnail, editor, permissions/storage-pressure, retry/background, UI/live proof |
| Voice и round video messages | Attachments + transcription consent/transcript route работают; waveform/duration кроме WAV честно `client_declared` | Запись (таймер, уровни, отмена/стоп), recording bar, playback с waveform, consent-тумблер и отправка транскрипта подключены | Server consent-kind/transcript tests; recorder/player в коде, Swift tests в общем CI-пакете | Round video, real-device background/interruption/loss QA, серверная верификация waveform, сквозные live-доказательства |
| Reactions/receipts | Работает | Частично | Live add/remove reaction и mark read | Rehydrate summaries, delivered/read details, complete realtime/offline merge |
| Search | Permission-first people/message/file foundations | Server-authorized people/messages/files, server chat/channel title search (`GET /v1/search/chats`, kind-filtered remote scopes) подключены | Fixture-free Swift→Docker 1/1; v14 production-target UI 1/1; GlobalSearchStoreTests chats paging/unavailable/session-reset + contract chats-path | Public/global catalog, file open/download, exact message jump/highlight, offline index and complete privacy/error gates |
| Contacts | Relationship/privacy foundation | Loaded-contact subset | Sort/filter/UI proof | Address-book permission/import policy, requests, blocks, full server search |
| Calls | API signaling slices 1–7 + list (create/get/cancel/hangup, group invite, ring/accept/decline, join-grant, signed LiveKit webhook, membership-reconcile, stale sweeper), durable realtime `call.state.changed`; `calls:true` только при полном `CALLS_*`-медиаплане, иначе `calls:false` и join-grant `503` | Call surface **проверен Apple CI**: вкладка истории звонков (real history из `GET /v1/calls?chatId=`, direction/missed/status/duration из серверной правды, pull-to-refresh, call-back, честный locked/limited экран при `calls:false`), per-chat call log sheet, full-screen active-call overlay (elapsed timer от серверного acceptance/updated, mute только при подключённом медиа, speaker видимо недоступен, hangup, честная media-строка), incoming accept/decline banner, audio only, capability-gated; video остаётся locked | Apple CI: swift-package green на `b682d99`/`d0a7a8f`/`32e0d62`/`df39703`/`beb6ca7` (финальный `beb6ca7` — **455 XCTest / 6 expected skips / 0 failures + 20 Swift Testing**, включая `CallHistoryTests`); ios-compile PASS на `df39703`/`beb6ca7`; API tests для signaling/list/join-grant/webhook; media join проверен на локальном LiveKit-стеке: PR #110 — join только после accept, signed webhook двигает call в active; browser harness vs real media plane 18/18, API media-plane probe 14/14 (JWT grant + TURN creds через TLS) — это server/web evidence, iPhone app-side media E2E не заявляется | Push-дозвон и CallKit, video/screen share, media-E2EE, real-device QoS/потеря сети, production SFU/TURN capacity и независимый media-security review; iPhone app-side media session остаётся LiveKit voice (server join-grant), полный iPhone calls media E2E не заявляется |
| Push notifications | Session-bound APNs registration and global preferences work; public delivery is absent | AppDelegate token bridge, session lifecycle and server-backed global settings implemented | Server encrypted/token-free lifecycle; iPhone focused 17/17, merged Swift/signed compile | Real APNs credentials/device delivery, opaque payload jobs, 410 feedback, foreground/background handling |
| Settings | Серверные APIs есть для devices/password/notifications/privacy/folders | Профиль, QR, папки, privacy, blocked users, серверные устройства, пароль входа, уведомления, appearance (theme/accent/text scale), локальные data-настройки (keep media, auto-download, cache size/clear) и маршруты «Жалобы и отчёты» (privacy) / «Экспорт и удаление аккаунта» (data) подключены | Selected settings UI smokes; stores wiring и новые route-тесты в общем CI-пакете | Полный 05–19/32–35 pixel closure, live/real-device evidence |
| Privacy and blocks | Server policy/blocks/report работает | Приватность (discoverability, message-request policy, last seen/photo/forwards/voice/calls), список заблокированных с unblock и **report UI** подключены: report sheet из message menu для чужих сообщений с exact category picker, comment, alsoBlock и явным cloud-preview consent; «Мои жалобы» с cursor pagination | Server authorization tests; safety-report contract/store tests + privacy UI в общем CI-пакете | Edit/report полные flows для остальных поверхностей, live tests и точные русские layout-гейты |
| Account data (export/deletion) | Export 035 + deletion 036 + retention 037 работают по HTTP | **iPhone UI реализован (PR #109):** `AccountDataStore` (bounded polling экспорта, range download с проверкой size+SHA-256 через CryptoKit до ShareLink, deletion state machine по серверному 7-дневному grace, cancel без сетевых вызовов после deadline) + `PhoneAccountDataViews` (typed «УДАЛИТЬ» confirmation, grace deadline, honest pending/executing/completed/failed); честный лимит — no instant-deletion | `AccountDataStoreTests` (contract/store) в зелёном Apple CI `beb6ca7` (455 XCTest / 6 skipped / 0 failures) | Live/real-device evidence; production data-deletion certification отсутствует |
| Devices/passkeys/recovery/2FA | Sessions есть; passkeys internal-only; QR device-link slices 1–4 (challenge, approve/deny+SAS, password+XOR-ceremony step-up, proof-key redemption+session); 2FA/recovery нет | Частично: QR-link store, шит показа QR (own-device flow) и terminate-others подключены (`main`, коммиты `c75948c`/`a7db52c`/`cc6fce7`; Apple CI на `cc6fce7` красный — см. CI-раздел `PROJECT_STATE.md`); сканер-аппрувер, passkey-ceremony UX и QR-scan flow не подключены | Truthful gates + API 8/8 + 7/7 + 2/2; iPhone contract/store tests в общем CI-пакете | Passkey-ceremony client UX, E2E гранта, history bootstrap, native recovery evidence |
| Realtime reconciliation | V1/V2, strict 12-collection snapshot и account projection invalidation работают; drafts use private V2 events plus lazy GET; additive `call.state.changed` (только как refresh-trigger) | Strict account/session-fenced V2 apply, 12-collection rebuild, deterministic recovery, atomic local V2 checkpoint and draft session/lifecycle fences подключены | Apple CI: swift-package **455 XCTest / 6 expected skips / 0 failures + Swift Testing 20/20** на финальном `beb6ca7`; scoped V2 preferences/recovery и postpromotion draft HTTP+V2 PASS | Reconnect/backoff storm, real process-death/poor-network/conflict proof и доказанный offline launch |
| Offline/durable local data | Server idempotency exists | Account/session-scoped schema-v2 confirmed cache и ordered stable-nonce text outbox подключены; online drafts synchronize through the server | 11/11 focused cache/outbox tests; current merged package **455 XCTest / 6 expected skips / 0 failures + Swift Testing 20/20** (Apple CI, `beb6ca7`) | Финальная индексируемая encrypted DB, quota/eviction, offline launch, offline/local durable drafts, media/edit/delete/forward and real terminate/relaunch/poor-network gates |
| Accessibility/localization | Russian baseline | Частично | Source scan and selected labels | VoiceOver rotor, Dynamic Type, contrast, RTL, Reduce Motion/Transparency full suite |
| Performance/energy/crash | Server local gates | Не измерено полностью | Build/runtime smokes | Launch/scroll/memory/energy/crash profiling on supported real devices |
| Release/install/update | CI foundations | Simulator Debug only | Xcode build | Signing, archive, TestFlight/App Store, privacy manifests, rollback/update gates |
| UI-test CI gate (PR #110) | CI job `ui-tests` | Bounded offline subset существующих UI test suites на симуляторе, unsigned, xcresult/log/screenshot artifacts on failure; stale expectations исправлены статическим аудитом | Job добавлен; на head `260857f` первый прогон ещё выполнялся — **не подтверждён зелёным** | Полный UI/accessibility/release suite на всех reference journeys; job должен быть зелёным постоянно |

## Проверенный iPhone checkpoint 31 октября 2026 (PR #110)

- **PR #110 добавляет iPhone `ui-tests` CI job, но не меняет merged iPhone feature checkpoint:**
  job запускает bounded offline subset существующих UI test suites на симуляторе, unsigned, с
  xcresult/log/screenshot artifacts при падении; stale ожидания (stray brace, drifted
  identifiers/copy, privacy-row scrolling, offline API URLs) исправлены статическим аудитом.
  На head `260857f` первый прогон ещё выполнялся — **job добавлен, но не подтверждён зелёным**;
  docs не заявляют его green до завершения.
- **Calls media (server-side, PR #110):** join-grant теперь запрашивается только когда call
  joinable (после accept), локальный Docker media plane доставляет signed LiveKit webhooks на
  `/v1/internal/calls/livekit-webhook`, поэтому call переходит `connecting → active` и
  завершается на departures. Evidence: browser harness против real media plane **18/18**
  (bidirectional media, active via webhook, mute в обе стороны, hangup clears overlays, no console
  errors) и API media-plane probe **14/14** (JWT join grant + TURN creds через TLS). Это
  server/web evidence; **iPhone app-side media session остаётся LiveKit voice** по server
  join-grant, отдельный iPhone media E2E не заявляется. Cloud-preview, no E2EE.
- **UI-тесты в предыдущем merged checkpoint:** swift-package **455 XCTest / 6 expected skips /
  0 failures + 20 Swift Testing** (включая `CallHistoryTests`, `CallsStoreTests`,
  `CommunityManagementStoreTests`, safety/account-data contract/store тесты); ios-compile PASS
  на `beb6ca7`/`df39703`.
- **Remaining gates:** real APNs push/CallKit, E2EE, video/screen-share, real-device media/QoS,
  release/signing, полный UI/accessibility suite на всех reference journeys (job должен быть
  стабильно зелёным в CI).

## Проверенный iPhone checkpoint 31 октября 2026 (PR #109)

- **Apple CI (`Apple Swift`, PR #109, head `beb6ca7`, 2026-10-31):** `swift-package`
  — **SUCCESS: 455 XCTest executed, 6 skipped, 0 failures** плюс **20 Swift Testing
  в 3 suite PASS**. Счётчики включают calls (`CallHistoryTests`/`CallsStoreTests`),
  community management и **новые 26 contract/store тестов safety/account-data**
  (`SafetyReportContractTests`, `AccountDataStoreTests`). `ios-compile` — **SUCCESS**
  (4m32s). Swift на Windows-воркспейсе не собирается, поэтому CI — единственное
  исполняемое evidence; реальные устройства не проверялись.
- **iPhone safety reports — SHIPPED и проверен CI:** `LuxoraSafetyAPIClient`
  (own-report cursor list, nonce-idempotent submit, strict decode/sanitized errors),
  `SafetyReportsStore` (cursor pagination, nonce fence), `PhoneSafetyAndDataViews`
  (report sheet из message menu для чужих сообщений: exact category picker,
  comment, «also block», явный cloud-preview consent что сервер может читать
  содержимое; «Мои жалобы»). Server-readable by design — не E2EE.
- **iPhone account data (export/deletion) — SHIPPED и проверен CI:**
  `AccountDataStore` (bounded polling экспорта, range download с проверкой
  серверных size+SHA-256 через CryptoKit до ShareLink, deletion state machine по
  реальному 7-дневному grace; cancel отклоняется после deadline без сетевых
  вызовов), `PhoneAccountDataViews` (typed «УДАЛИТЬ» confirmation, grace deadline,
  honest pending/executing/completed/failed). No instant-deletion claims.
  Wiring в `ApplicationSession`, settings-маршруты «Жалобы и отчёты» (privacy) и
  «Экспорт и удаление аккаунта» (data), «Пожаловаться» в message menu.
- **Calls product surface — проверен Apple CI:** `d04e904` (signaling layer,
  realtime-декодер, API-клиент, store) + `4e41939` (Call UI: `CallsStore`,
  `CallBanner`, `CallMediaSession` через LiveKit Swift SDK) + `479dd53`
  (`call.state.changed` как refresh-trigger) + `4918cfa`/`df39703` (calls product
  surface: вкладка истории звонков с real history, per-chat лог, call-back,
  in-call overlay с серверно-заякоренным таймером и honest mute, locked/limited
  gating). Голос подключается только если сервер выдал join-grant, то есть
  только при сконфигурированном медиаплане; `features.calls` остаётся `false` на
  локальном API без медиаплана, и клиент показывает честный locked-экран вместо
  фейковой истории. Video, CallKit/push-дозвон, screen share и media-E2EE
  отсутствуют.
- **Community management UI — проверен Apple CI:** invite links shown-once +
  revoke, join-request approval queue, ownership-transfer ceremony, join-by-link
  (`CommunityManagementStore`/`PhoneCommunityManagementViews`, тесты
  `CommunityManagementStoreTests` в зелёном swift-package).
- **Серверный контракт для клиента:** миграции `038`–`039`, signaling 1–7 +
  `GET /v1/calls?chatId=`, durable `call.state.changed` в v2, `features.calls`
  из capabilities по факту `CALLS_*`-конфига; safety/data-export/account-deletion
  HTTP-контракты (035/036 + report). Актуальный серверный замер: FULL API
  **103 файла / 749 тестов** green (включая `direct-chat-relationship.integration
  .test.ts`), protocol 17/104, passkey-domain 70, call-control 23.
- **Ограничение evidence:** голос проверен на локальном LiveKit-стеке через
  серверный join-grant; safety report consent явно cloud-preview; real-device
  media/QoS, push-дозвон, CallKit, video и screen share не проверялись. Заявления
  «calls done»/«E2EE» или процент завершения iPhone-функций не делаются.
- Более ранний checkpoint (15 августа 2026, drafts/v15) сохраняется ниже как
  датированное evidence, а не заменяется этим run.
- **Следующее / planned (НЕ shipped):**
  1. real APNs push/CallKit — внешние гейты; E2EE — отдельная аудируемая программа;
     video/screen-share звонки;
  2. durable outbox/cache, pagination, attachment binding, file
     open/download/share, video playback, reconnect/backoff/sync.required
     reconciliation; real-device media/QoS;
  3. 62-screen pixel closure, accessibility/performance и release/signing-гейты;
  4. production data-deletion certification (server) остаётся открытым.
- **Web quality gate (для контраста, не iPhone):** веб-клиент `/app` — **49 Vitest**
  (api 17, realtime 13, store 19), typecheck/build green; browser E2E теперь
  **committed CI gate** (`tools/web-e2e` + job `web-e2e`, **16/16 checks PASS** в
  GitHub Actions); hosting CSP/headers и WCAG-аудит остаются открытыми.
- **Уже реализовано в коде (не числить как отсутствующее, но и не как
  release-ready):** attachments picker/upload/view, topics store + chips +
  history filter, voice recording UI + playback, message-request data layer +
  privacy policy, chat folders, synchronized drafts, device-link QR sheet,
  notification settings, blocked users list, server devices/password settings,
  appearance/data settings screens, safety reports UI, account export/deletion UI,
  calls banner + LiveKit voice, calls product surface и community management.
- Real-device, real APNs delivery, E2EE, offline/poor-network, 62-screen pixel
  closure и release/signing-гейты остаются открытыми.

## Проверенный iPhone checkpoint 15 августа 2026

- Current-source Swift package: **351 XCTest cases**, из них **6 ожидаемых
  live-only skips**, **0 failures**; отдельный Swift Testing run — **11/11
  PASS**. Draft-focused — **48/48**, Messenger/reconciliation — **26/26**,
  capabilities — **11/11**.
- Post-patch v15 journey на iPhone 17 Pro Simulator/iOS 26.5: **1/1 PASS, 0
  failures, 0 skips**, 75.079 s в
  `/tmp/LuxoraDraftsUI.PostPatch.EDyOo5/DraftsUI-PostPatch.xcresult`.
  Debug automation прошёл 5/5. Три PNG `1206×2622` заново экспортированы,
  просмотрены и совпадают с manifest/SHA. В log, activities и binary tree
  xcresult — 0 совпадений `Invalid frame dimension (negative or non-finite)`.
  Это DEBUG-only server-shaped UI evidence, не live-backend screenshot.
- Exact image `f9dbff7f…20e6d` promoted на локальный migration-025 runtime.
  Отдельный fixture-free postpromotion Swift draft HTTP+V2 journey прошёл 1/1
  за 0.557 s; baseline до synthetic smoke сохранён, SQLite integrity/FK,
  readiness, hardening, outbox и error-level logs чистые.
- v14 global search сохраняет отдельные fixture-free Swift→Docker 1/1 и
  production-target UI 1/1 checkpoints. v13 folders/navigation/accessibility и
  более ранние live slices остаются датированными evidence, а не заменой
  текущего общего run.
- Общий процент намеренно не заявляется: media, voice/round video, calls —
  остаётся открытым (call UI/voice preview подключён, но push-дозвон, CallKit,
  video, call history, real-device/QoS и независимый media review — нет), а
  также E2EE, production SMS/real APNs, full offline/encrypted local DB, 62/62
  pixel closure, real-device и distribution/release gates.

## Непрерывная очередь исполнения

1. Phone-auth expiry/wrong-code/exhaustion/resend/rate-limit/recovery matrix.
2. Device compromise/recovery и оставшиеся privacy/block/report flows.
3. Cursor pagination и продолжение durable foundation до индексируемой
   encrypted local DB: quota/eviction, offline launch, offline/local drafts,
   media/mutations и реальные poor-network/process-death tests.
4. Media upload/download, затем processed photo/video, voice и round video.
5. Завершить global paginated search и contacts/address-book policy.
6. Real APNs delivery; затем calls remainders — push-дозвон/CallKit,
   video/screen share, call history UI, production SFU/TURN capacity,
   real-device QoS и независимый media-security review.
7. Полные 62 reference journeys, accessibility/performance/security,
   real-device и release gates.

После каждого закрытого slice root обязан прогнать общий merged build/tests и
немедленно выдать агенту следующую открытую строку. Фраза «абсолютно всё
работает» допустима только когда в таблице нет незакрытого product или release
gate; до этого используется точное перечисление работающих и отсутствующих
функций.
