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
| Root shell, tabs, folders, status rail | Account-scoped archive/mute и synchronized custom-folder contracts работают | Русская четырёхвкладочная оболочка, горизонтальная folder rail, «Все»/«Архив»/custom filters, settings/editor и status rail подключены | v13 UI evidence 1/1; combined folder/navigation/accessibility UI 4/4; 7 checksum-verified 1206×2622 PNG root+reviewer inspected | Полный 62-screen pixel closure, persistence/process-death, real-device и полная accessibility matrix |
| Список чатов | List + account-scoped archive/mute/folders HTTP и приватный V2 realtime работают | HTTP/store, archive swipe, custom-folder filtering, strict scoped V2/recovery и account/session-scoped confirmed cache foundation подключены | Live load/refresh/error/retry; postpromotion scoped V2 preferences/recovery PASS; v13 deterministic production-surface journey; atomic durable tests PASS | Cursor pagination, indexed/evicted local DB, full offline launch, poor-network/process-death live proof и полный live folder UI journey |
| Личный чат и text send | Работает | Text + actions и stable-nonce durable text outbox работают | Live direct/send/list/read/reaction/realtime; reply/edit/delete/forward/pin API/store/UI evidence; restart/corruption/retry/response-loss/order/logout tests PASS | Pagination, offline/local durable drafts, media/mutations, full offline/poor-network/process-death live proof |
| Синхронизированные черновики | GET/PUT/DELETE, CAS/tombstone, encrypted-at-rest state/receipts, membership scrub и private V2 event работают на migration 025 | Authorized load/autosave/delete, reply context, cross-chat restore, pacing/backoff/retry и realtime/session fences подключены | Draft 48/48, Messenger/reconciliation 26/26, capability 11/11; postpromotion Swift→Docker HTTP+V2 1/1; post-patch v15 UI 1/1 и 3 checksum-verified PNG | Offline local persistence, real process-death/poor-network/conflict storm, multi-device and real-device gates; server can decrypt drafts, so this is not E2EE; drafts stay outside the strict 12-collection snapshot and recover by authorized lazy GET |
| Message requests незнакомым | Работает | Входящие/исходящие, точный username, create, accept→direct, приватное dismiss и GET/PATCH privacy подключены | API/store tests; отдельный live Docker 1/1; signed unified UI 4/4; 11 оригинальных кадров с SHA в `production/v10-message-requests-ru` | Cursor pagination, realtime reconciliation, offline/process-death recovery, полный pixel/accessibility/real-device/release gate |
| Группы и каналы | Create/get, роли участников, message authorization и realtime работают | Create/list/search/profile/add/promote/remove/leave подключены; у канала есть честный read-only composer для обычного участника | API/store 16/16; live Swift→Docker 1/1; signed Xcode UI 3/3; AXXXL 1/1; 11 оригинальных кадров в `production/v12-communities-ru` | Cursor pagination, offline/process-death recovery, real-device/release accessibility gate |
| Topics/threads/comments | Contract foundation работает | Нет | Server tests | Полный iPhone routing/composer/history/realtime |
| Attachments и файлы | Upload/storage/download работает, content unscanned | Нет отправки/просмотра | Local/S3 security gates | Picker/crop/upload/resume/send/view/download; scan/transcode pipeline |
| Фото и видео | Raw storage foundation | Нет | Нет product evidence | Processing, thumbnails, permissions, editor, retry/background, UI/live proof |
| Voice и round video messages | Нет product server pipeline | Нет | Нет | Capture/upload/processing/waveform/playback/background/interruption |
| Reactions/receipts | Работает | Частично | Live add/remove reaction и mark read | Rehydrate summaries, delivered/read details, complete realtime/offline merge |
| Search | Permission-first people/message/file foundations | Server-authorized people/messages, server file projections и local synchronized chat/channel results подключены | Fixture-free Swift→Docker 1/1; v14 production-target UI 1/1 и 2 checksum-verified PNG | Public/global catalog, multi-page live UI, file open/download, exact message jump/highlight, offline index and complete privacy/error gates |
| Contacts | Relationship/privacy foundation | Loaded-contact subset | Sort/filter/UI proof | Address-book permission/import policy, requests, blocks, full server search |
| Calls | Isolated call-control/SFU/TURN only | Locked | Infrastructure tests only | API signaling, grants, audio/video/group/screen share, permissions/QoS |
| Push notifications | Session-bound APNs registration and global preferences work; public delivery is absent | AppDelegate token bridge, session lifecycle and server-backed global settings implemented | Server encrypted/token-free lifecycle; iPhone focused 17/17, merged Swift/signed compile | Real APNs credentials/device delivery, opaque payload jobs, 410 feedback, foreground/background handling |
| Settings | Часть APIs существует | Несколько routes работают | Profile/QR/folders/privacy selected smokes | Все 05–19/32–35 screens, реальные values/actions и server persistence |
| Privacy and blocks | Server policy/blocks/report работает | Status screen only | Server authorization tests | Complete edit/block/report UX, live tests and exact Russian layouts |
| Devices/passkeys/recovery/2FA | Sessions есть; passkeys internal-only; 2FA/recovery нет | Mostly locked | Truthful gates | Public audited contracts then native UX and end-to-end recovery evidence |
| Realtime reconciliation | V1/V2, strict 12-collection snapshot и account projection invalidation работают; drafts use private V2 events plus lazy GET | Strict account/session-fenced V2 apply, 12-collection rebuild, deterministic recovery, atomic local V2 checkpoint and draft session/lifecycle fences подключены | Current-source 351 XCTest / 6 expected live-only skips / 0 failures, Swift Testing 11/11; scoped V2 preferences/recovery and postpromotion draft HTTP+V2 PASS | Reconnect/backoff storm, real process-death/poor-network/conflict proof и доказанный offline launch |
| Offline/durable local data | Server idempotency exists | Account/session-scoped schema-v2 confirmed cache и ordered stable-nonce text outbox подключены; online drafts synchronize through the server | 11/11 focused cache/outbox tests; current merged package 351 XCTest / 6 expected skips / 0 failures + Swift Testing 11/11 | Финальная индексируемая encrypted DB, quota/eviction, offline launch, offline/local durable drafts, media/edit/delete/forward and real terminate/relaunch/poor-network gates |
| Accessibility/localization | Russian baseline | Частично | Source scan and selected labels | VoiceOver rotor, Dynamic Type, contrast, RTL, Reduce Motion/Transparency full suite |
| Performance/energy/crash | Server local gates | Не измерено полностью | Build/runtime smokes | Launch/scroll/memory/energy/crash profiling on supported real devices |
| Release/install/update | CI foundations | Simulator Debug only | Xcode build | Signing, archive, TestFlight/App Store, privacy manifests, rollback/update gates |

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
- Общий процент намеренно не заявляется: media, voice/round video, calls, E2EE,
  production SMS/real APNs, full offline/encrypted local DB, 62/62 pixel closure,
  real-device и distribution/release gates остаются открытыми.

## Непрерывная очередь исполнения

1. Phone-auth expiry/wrong-code/exhaustion/resend/rate-limit/recovery matrix.
2. Device compromise/recovery и оставшиеся privacy/block/report flows.
3. Cursor pagination и продолжение durable foundation до индексируемой
   encrypted local DB: quota/eviction, offline launch, offline/local drafts,
   media/mutations и реальные poor-network/process-death tests.
4. Media upload/download, затем processed photo/video, voice и round video.
5. Завершить global paginated search и contacts/address-book policy.
6. Real APNs delivery, затем calls только после готового signaling/media trust
   boundary.
7. Полные 62 reference journeys, accessibility/performance/security,
   real-device и release gates.

После каждого закрытого slice root обязан прогнать общий merged build/tests и
немедленно выдать агенту следующую открытую строку. Фраза «абсолютно всё
работает» допустима только когда в таблице нет незакрытого product или release
gate; до этого используется точное перечисление работающих и отсутствующих
функций.
