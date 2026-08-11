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
| Список чатов | List + account-scoped archive/mute/folders HTTP и приватный V2 realtime работают | HTTP/store, archive swipe, custom-folder filtering и strict scoped V2/recovery wiring подключены | Live load/refresh/error/retry; postpromotion scoped V2 preferences/recovery PASS; v13 deterministic production-surface journey and screenshots PASS | Cursor pagination, durable offline cache/outbox, poor-network/process-death proof и полный live folder UI journey |
| Личный чат и text send | Работает | Text + actions работают | Live direct/send/list/read/reaction/realtime; reply/edit/delete/forward/pin имеют API/store tests и Xcode UI evidence | Pagination, durable outbox, poor-network/process-death proof |
| Message requests незнакомым | Работает | Входящие/исходящие, точный username, create, accept→direct, приватное dismiss и GET/PATCH privacy подключены | API/store tests; отдельный live Docker 1/1; signed unified UI 4/4; 11 оригинальных кадров с SHA в `production/v10-message-requests-ru` | Cursor pagination, realtime reconciliation, offline/process-death recovery, полный pixel/accessibility/real-device/release gate |
| Группы и каналы | Create/get, роли участников, message authorization и realtime работают | Create/list/search/profile/add/promote/remove/leave подключены; у канала есть честный read-only composer для обычного участника | API/store 16/16; live Swift→Docker 1/1; signed Xcode UI 3/3; AXXXL 1/1; 11 оригинальных кадров в `production/v12-communities-ru` | Cursor pagination, offline/process-death recovery, real-device/release accessibility gate |
| Topics/threads/comments | Contract foundation работает | Нет | Server tests | Полный iPhone routing/composer/history/realtime |
| Attachments и файлы | Upload/storage/download работает, content unscanned | Нет отправки/просмотра | Local/S3 security gates | Picker/crop/upload/resume/send/view/download; scan/transcode pipeline |
| Фото и видео | Raw storage foundation | Нет | Нет product evidence | Processing, thumbnails, permissions, editor, retry/background, UI/live proof |
| Voice и round video messages | Нет product server pipeline | Нет | Нет | Capture/upload/processing/waveform/playback/background/interruption |
| Reactions/receipts | Работает | Частично | Live add/remove reaction и mark read | Rehydrate summaries, delivered/read details, complete realtime/offline merge |
| Search | Server known-user/message/file foundations | Только loaded/known subset | Focused UI tests | Global paginated people/chat/message/file search and privacy/error states |
| Contacts | Relationship/privacy foundation | Loaded-contact subset | Sort/filter/UI proof | Address-book permission/import policy, requests, blocks, full server search |
| Calls | Isolated call-control/SFU/TURN only | Locked | Infrastructure tests only | API signaling, grants, audio/video/group/screen share, permissions/QoS |
| Push notifications | Session-bound APNs registration and global preferences work; public delivery is absent | AppDelegate token bridge, session lifecycle and server-backed global settings implemented | Server encrypted/token-free lifecycle; iPhone focused 17/17, merged Swift/signed compile | Real APNs credentials/device delivery, opaque payload jobs, 410 feedback, foreground/background handling |
| Settings | Часть APIs существует | Несколько routes работают | Profile/QR/folders/privacy selected smokes | Все 05–19/32–35 screens, реальные values/actions и server persistence |
| Privacy and blocks | Server policy/blocks/report работает | Status screen only | Server authorization tests | Complete edit/block/report UX, live tests and exact Russian layouts |
| Devices/passkeys/recovery/2FA | Sessions есть; passkeys internal-only; 2FA/recovery нет | Mostly locked | Truthful gates | Public audited contracts then native UX and end-to-end recovery evidence |
| Realtime reconciliation | V1/V2, 12-collection snapshot и account projection invalidation работают | Strict account/session-fenced V2 apply, 12-collection snapshot rebuild и deterministic recovery подключены | Current-source Swift 259 cases / 4 expected live-only skips / 0 failures, Swift Testing 8/8; postpromotion scoped V2 preferences/recovery PASS | Durable local checkpoint, reconnect/backoff storm, process-death, poor-network и conflict proof |
| Offline/durable local data | Server idempotency exists | In-memory only | Failed-send retry | Local DB migrations, durable drafts/outbox/cache/index and poor-network suite |
| Accessibility/localization | Russian baseline | Частично | Source scan and selected labels | VoiceOver rotor, Dynamic Type, contrast, RTL, Reduce Motion/Transparency full suite |
| Performance/energy/crash | Server local gates | Не измерено полностью | Build/runtime smokes | Launch/scroll/memory/energy/crash profiling on supported real devices |
| Release/install/update | CI foundations | Simulator Debug only | Xcode build | Signing, archive, TestFlight/App Store, privacy manifests, rollback/update gates |

## Проверенный iPhone checkpoint 11 августа 2026

- Current-source Swift package: **259 XCTest cases**, из них **4 ожидаемых
  live-only skips**, **0 failures**; отдельный Swift Testing run — **8/8 PASS**.
- Свежий Simulator gate папок/навигации/accessibility:
  **4/4 PASS, 0 failures, 0 skips** в
  `/tmp/LuxoraFolders-DD/Logs/Test/Test-LuxoraMobile-2026.08.11_17-53-16-+0300.xcresult`.
- v13 evidence — **1/1 PASS** в `17-49-50.xcresult`; семь PNG
  `1206×2622` в `screens_app_iphone/production/v13-chat-folders-ru/` совпадают
  с manifest/SHA и просмотрены root и независимым reviewer. Для v13 не найдено
  P0/P2-дефектов.
- После live promotion отдельно прошли Community, Message Requests,
  registration/chat/mutations и scoped V2 preferences/recovery. Первый
  объединённый live-запуск упёрся в общий HTTP `429`; два затронутых пути затем
  прошли в изолированных повторах. Поэтому это честный набор зелёных
  postpromotion journeys, но не один непрерывный monolithic live run.
- Открытый P1: финальный combined 4/4 содержит ровно одно non-failing
  предупреждение `Invalid frame dimension (negative or non-finite)` в более
  широком composer/keyboard journey. Узкий A/B с удалением внешнего
  `GlassEffectContainer` предупреждение не устранил, поэтому изменение
  откатили; P1 остаётся открытым и не маскируется зелёным v13 gate.
- Взвешенная готовность полного iPhone scope сейчас оценивается примерно в
  **63%**. Это не product/release completion: media, voice/round video, calls,
  E2EE, durable offline/outbox и release/real-device gates ниже остаются
  открытыми.

## Непрерывная очередь исполнения

1. Phone-auth expiry/wrong-code/exhaustion/resend/rate-limit/recovery matrix.
2. Device compromise/recovery и оставшиеся privacy/block/report flows.
3. Cursor pagination и durable local DB/cache/outbox/reconciliation с
   poor-network/process-death tests.
4. Media upload/download, затем processed photo/video, voice и round video.
5. Global paginated search и contacts/address-book policy.
6. Real APNs delivery, затем calls только после готового signaling/media trust
   boundary.
7. Полные 62 reference journeys, accessibility/performance/security,
   real-device и release gates.

После каждого закрытого slice root обязан прогнать общий merged build/tests и
немедленно выдать агенту следующую открытую строку. Фраза «абсолютно всё
работает» допустима только когда в таблице нет незакрытого product или release
gate; до этого используется точное перечисление работающих и отсутствующих
функций.
