# Luxora — контекст разговора и передачи проекта

> Актуальность снимка: **15 августа 2026, активная рабочая сессия MSK (UTC+3)**.
> Владелец и разработчик продукта: **Flenym**.  
> Единственная пользовательская версия: **Beta-0.1**.  
> Этот файл специально создан для переноса работы в новый сеанс Codex и на другой компьютер. Он описывает историю, намерения, принятые решения и фактическую правду репозитория на момент снимка. Состояние кода после указанного времени необходимо перепроверять командами, а не считать неизменным.

## 0A. Активный checkpoint 15 августа 2026 — прочитать первым

Этот блок имеет приоритет над любым разделом ниже, даже если исторический
заголовок или предложение использует слова «current», «текущий» или
«exact-tree». Перед новой работой всё равно сначала проверить `git status`,
Docker и тестовые артефакты: общий workspace изменяется несколькими агентами.

- Current exact-tree server regression: protocol **11 файлов / 89 тестов PASS**,
  API **71 файл / 626 тестов PASS**, production/test typecheck PASS. Migration
  `025` добавляет server-synchronized drafts: strict GET/PUT/DELETE,
  10,000-code-point/well-formed-Unicode bounds, CAS/tombstones, stable nonces,
  encrypted-at-rest text and receipts, bounded rate limits, membership lifecycle
  purge and owner-only V2 `chat.draft.changed`. Remove/re-add не восстанавливает
  старый draft или nonce; per-audience outbox order и poison blocking доказаны.
  Сервер может расшифровать сообщения и drafts: **это не E2EE**. Reconciliation
  snapshot остаётся ровно из 12 collections; drafts восстанавливаются отдельным
  авторизованным lazy GET.
- Exact local runtime promoted: container `luxora-phone-live` использует
  `luxora-api@sha256:f9dbff7ffb5a22d0400fdf9c1a97e379696505f2d5a54c64c787c99c52620e6d`,
  healthy на `127.0.0.1:8080`, migration `025`; loopback OTP console на 8081
  healthy. Runtime — UID/GID 65532, read-only root, `cap-drop=ALL`,
  `no-new-privileges`, one loopback listener; после cutover error-level logs 0.
  Trivy 0.73 для exact image: **0 High / 0 Critical / 0 secrets**. Это local
  preview evidence, не cloud production proof.
- Restored-m024 rehearsal exact image прошёл migration `025`, baseline counts,
  integrity/FK, capabilities, hardening и fixture-free Swift draft HTTP+V2 1/1.
  Первый verified backup/rehearsal source:
  `/Users/vikavavilina/Documents/egor/Luxora-local-backups/Beta-0.1/pre-live-m025-promotion-20260815T121732Z`,
  `SHA256SUMS` digest
  `6966e7b0ab464c573acfba886b8236ec5c737caca492531dd440148ab868d86b`.
  Final pre-cutover sealed backup:
  `/Users/vikavavilina/Documents/egor/Luxora-local-backups/Beta-0.1/pre-live-m025-final-cutover-20260815T122438Z`;
  7 files, verifier/restore PASS, `SHA256SUMS` digest
  `87c0ac8dfc63f4626a07f6bec084a55d4d1e412a2cdf1fa155d38d5f23ed30ae`.
  Final-stop DB/blobs/uploads byte-for-byte совпали с первым backup, counts всех
  69 таблиц совпали. Final pre-smoke baseline: 47 users, 57 sessions, 179 refresh
  rows, 19 chats, 25 members, 19 messages, 1 folder, 131 events/131 outbox, 2
  attachments, 1 upload, 1 chunk и 0 draft rows. Postpromotion Swift draft
  HTTP+V2 прошёл
  **1/1 за 0.557 s**; ожидаемый synthetic smoke дал 48/59/181 users/sessions/
  refresh, 20 chats, 26 members, один draft tombstone, 2 encrypted receipts и
  134/134 events/outbox. Затем integrity/FK, outbox pending/failed остались
  чистыми. Protected final cutover window — около 103 s; новый image стал
  healthy через 7 s после запуска.
- Migration `025` уже касалась live volume. Никогда не запускать на нём
  `47e66d…` или более старый image. Data rollback допускается только через
  проверку final m024 archive, restore в **новый** volume и явное принятие потери
  данных после `2026-08-15T12:24:58Z`; иначе нужен forward fix, совместимый с
  migration `025`.
- Current-source Apple verification: **351 XCTest**, 6 ожидаемых live-only
  skips, 0 failures; Swift Testing **11/11 PASS**. Focused drafts **48/48**,
  Messenger/reconciliation **26/26**, capabilities **11/11**, Debug automation
  **5/5**. Candidate и postpromotion fixture-free Swift draft HTTP+V2 — по 1/1.
- Post-patch v15 iPhone 17 Pro/iOS 26.5 UI journey: **1/1 PASS**, 75.079 s,
  `/tmp/LuxoraDraftsUI.PostPatch.EDyOo5/DraftsUI-PostPatch.xcresult`. В build
  log, activities и xcresult binary tree нет `Invalid frame dimension`; три
  PNG `1206×2622` повторно экспортированы, просмотрены и совпадают с SHA.
  Скриншоты используют DEBUG-only server-shaped transport, а не live account.
  v14 global search отдельно имеет production-target UI 1/1 и fixture-free
  Swift→Docker 1/1; public/global catalog, multi-page live search, file open и
  exact message jump всё ещё открыты.
- Общий процент готовности намеренно не фиксируется. Production SMS/database/
  broker, real APNs delivery, media processing, voice/round video, calls, E2EE,
  full offline/encrypted local DB, real-device/TestFlight/App Store, 62/62 pixel
  closure, off-host DR и pentest остаются незакрытыми gates.
- До финального handoff commit базой `main` был `2026dc4`; рабочее дерево
  содержало намеренные незакоммиченные server/Apple/evidence/docs изменения, их
  нельзя reset/recreate. После передачи использовать фактический `git log -1`,
  а не считать этот base финальной вершиной. Read-only pre-handoff audit видел
  857 intended files (49 modified tracked + 32 untracked before commit),
  263,078,662 bytes, max file 6,019,929 bytes, 0 files от 50/100 MiB, 0
  Windows-invalid paths/casefold collisions, clean `git diff --check` и 0 Trivy
  secret findings при исключённых ignored `.env`/runtime/build путях. Перед
  commit всё перепроверить. Существующий transfer bundle checksum-valid, но
  содержит только `2026dc4` и **не включает dirty tree**; после final commit его
  нужно пересоздать.
- Official `gh` 2.97.0 установлен и checksum-verified; keyring auth активен для
  account `Flenym`. На момент проверки remote ещё отсутствовал. Root должен
  создать только private `Flenym/Luxora`, push текущего final commit и отдельно
  подтвердить `visibility=PRIVATE`/remote branch; до этого публикация считается
  **pending**, а не завершённой. Public fallback запрещён. Никогда не выводить
  OTP, `.env`, bearer/refresh material, GitHub credentials, encryption keys,
  реальные телефоны или другие приватные данные.

## 0B. Исторический checkpoint 11 августа 2026

### 0B.1. Exact-tree checkpoint 11 августа — история

Все слова «current» и «текущий» в этом подразделе относятся только к снимку 11
августа. Активный checkpoint 0A выше имеет безусловный приоритет.

- Exact-tree server regression зелёный: protocol **10 файлов / 85 тестов PASS**,
  API **68 файлов / 606 тестов PASS**, production/test typecheck также PASS.
- Server source и live volume содержат forward-only migrations **023** для
  синхронизируемых папок чатов и **024** для monotonic membership revision
  ledger. Reconciliation snapshot содержит ровно **12 collections**, включая
  `chat_folders`. Строгий default-on `SYNC_INVALIDATION_ENABLED` имеет
  schema-compatible emergency mode `false`: он подавляет только создание,
  replay/live/outbox delivery `sync.invalidated`, сохраняет обычные domain
  events и честно публикует capability `false`.
- Два independently-built no-cache runtime artifacts созданы из одного frozen
  source context и имеют одинаковый проверенный runtime payload. Primary image
  ID:
  `sha256:47e66d5d490d770d79a62708be5061519e5d04b63888e78dfd7934e63f4a046a`.
  Единственный schema-compatible fallback image ID:
  `sha256:f907528e5f0d39656989e5c77cbae8cf4bcabdb97216d14de8bf3bc27063c3d0`,
  только с explicit flag `false`. Оба прошли Trivy: **0 High / 0 Critical / 0
  secrets**; primary fresh smoke и fallback migration-024 clone rehearsal PASS.
- После отдельного явного GO controlled local-live promotion завершён. Текущий
  `luxora-phone-live` использует exact primary `47e66d5d…`, explicit flag
  `true`, volume `luxora_phone_live_data`, loopback `127.0.0.1:8080` и migration
  **024**. Downtime составил **12.005 s**. Health/readiness, unchanged pre-smoke
  counts, SQLite integrity/FK, phone authentication, folder exact replay, V2
  live+replay invalidation, V1 absence, drained outbox и loopback OTP console —
  PASS.
- Новый sealed backup:
  `/Users/vikavavilina/Documents/egor/Luxora-local-backups/Beta-0.1/pre-live-m024-promotion-20260811T143400Z`;
  `SHA256SUMS` digest
  `f0867986a23f8b03b919e3117616ee6e18d5ab7dd09b89873bb1f538778cbabc`,
  9 files, verification PASS. Старый image
  `sha256:c514db0ed19b68fd44766f7999217596dec2848ff1121e818f385860b580d7a6`
  сохранён только в stopped container
  `luxora-phone-live-pre-m024-20260811T143400Z`: **никогда не запускать его на
  migration 024**. Подробный runbook —
  `docs/audits/SYNC_INVALIDATION_SCHEMA_COMPATIBLE_FALLBACK_2026-08-11.md`.
- Это успешный local-live preview checkpoint, не 100% server completion:
  production SMS/database/broker, real push delivery, calls, E2EE, off-host DR,
  pentest и остальные незакрытые строки `TODO.md` остаются открытыми. Никогда
  не выводить OTP, server env, bearer material или encryption keys.
- Current-source iPhone regression: **259 XCTest cases**, 4 ожидаемых live-only
  skips, 0 failures; Swift Testing **8/8 PASS**. После promotion отдельно PASS
  Community, Message Requests, registration/chat/mutations и scoped V2
  preferences/recovery. Первый combined live run получил общий HTTP `429`, а
  два затронутых пути затем PASS в изолированных повторах; это не один
  непрерывный monolithic live run.
- iPhone chat-folders **v13** принят: visual journey **1/1 PASS** в
  `Test-LuxoraMobile-2026.08.11_17-49-50-+0300.xcresult`, свежий combined
  folder/navigation/accessibility gate **4/4 PASS, 0 failures/skips** в
  `Test-LuxoraMobile-2026.08.11_17-53-16-+0300.xcresult`. Семь PNG `1206×2622`
  в `screens_app_iphone/production/v13-chat-folders-ru/` совпадают с
  manifest/SHA и просмотрены root+independent reviewer; P0/P2 нет. Финальный
  combined 4/4 содержит ровно одно non-failing предупреждение
  `Invalid frame dimension` в более широком composer/keyboard journey; A/B
  внешнего `GlassEffectContainer` не помог и был откатан. Это открытый P1 и
  bounded folder checkpoint, не завершение iPhone-продукта.
- Честная оценка полного Beta-0.1 scope на этом checkpoint: server/backend около
  **78%**, iPhone около **63%**. Это progress estimate, не release claim;
  источники правды — `TODO.md`, тестовые результаты и
  `docs/specs/IPHONE_FUNCTIONAL_COMPLETION_MATRIX_RU.md`.
- Git transfer checkpoint: аудит всего intended-набора (825 путей) не нашёл
  high-confidence secrets, файлов от 50 MiB, Windows-incompatible имён или
  case-fold collisions; ignored `.env`, runtime DB, caches и dependencies не
  добавлялись. Финальный локальный checkpoint — вершина `main` (`git log -1`).
  Main-only bundle для Windows находился рядом с проектом вне repository, его
  digest — в соседнем `.sha256`; оба нужно перепроверить перед переносом.
  Remote и команда `gh` отсутствуют. GitHub connector аутентифицирован как
  `Flenym` и возвращает пустой список repositories, но не предоставляет
  create-repository. **BLOCKED только private publish:** нужен существующий
  private remote либо интерактивно авторизованный `gh`; public fallback
  запрещён.

### 0B.2. Более ранний checkpoint того же дня — история

Нижеследующие детали сохранены как история работы до exact-tree checkpoint
0B.1. При расхождении приоритет имеет 0A; незавершённые live-прогоны нужно
перепроверить по `TODO.md`, Git diff и сохранённым xcresult/скриншотам.

- Текущий живой API уже безопасно переключён на контейнер
  `luxora-phone-live`, image
  `luxora-api:chat-preferences-realtime-live-20260811`,
  `127.0.0.1:8080`, healthy, UID/GID `65532`, read-only root,
  `cap-drop=ALL`, `no-new-privileges`; SQLite находится на migration 021.
  До миграции было 30 users/39 sessions, после switch осталось ровно 30/39;
  push post-deploy HTTP smoke добавил один test account, archive/mute HTTP smoke
  — ещё один, а authenticated V2 realtime smoke — третий, поэтому текущие числа
  33/42. Integrity `ok`,
  foreign-key violations 0. Loopback-only
  OTP console на `127.0.0.1:8081` также healthy и её code совпадает с API env
  без вывода значения. Не выводить code, server env или bearer material в
  логи/документы.
- Server source уже содержит migration 021 и строгий session-bound APNs
  registration/preferences foundation: token transport нормализуется как
  bounded opaque hex, raw token не возвращается, equality digest хранится
  отдельно от context-bound encrypted envelope, transfer/rotation/revoke
  атомарны, revoke session каскадно гасит registration, preview default —
  `hidden`. Реальный APNs sender/credentials/jobs/410 feedback отсутствуют,
  поэтому `features.push` остаётся `false`.
- Полный merged protocol regression: **9 файлов / 69 тестов PASS**. Полный API
  regression: **64 файла / 568 тестов PASS**. Authorization matrix содержит 66
  защищённых HTTP маршрутов. После push-deploy source также активировал уже
  существующие account-scoped `chat_members.archived_at/muted_until`: строгие
  GET/PATCH, idempotent archive timestamp, column-selective lost-update guard и
  chat-list projection. V2 `chat.preferences.updated` дополнительно связан с
  exact account/chat и создаётся только при реальном изменении подтверждённого
  состояния; live/replay recheck не пропускает его другому участнику. Fresh-volume,
  real-data clone и authenticated live HTTP/WebSocket gates PASS; текущий runtime
  уже содержит этот срез.
- Последний candidate/live image:
  `luxora-api:chat-preferences-realtime-candidate-20260811` /
  `luxora-api:chat-preferences-realtime-live-20260811`, OCI manifest/image ID
  `sha256:c514db0ed19b68fd44766f7999217596dec2848ff1121e818f385860b580d7a6`.
  Trivy 0.73 со свежей DB: 0 High, 0 Critical, 0 secret и 0 Node-package
  findings; отдельный all-severity inventory честно фиксирует 2 Unknown, 7 Low
  и 5 Medium Debian findings без доступной fixed version. См.
  `docs/audits/CONTAINER_SCAN_BETA_0_1_2026-08-11.md`.
- Candidate прошёл UID-правильный clone реального migration-020 volume: 30/39
  сохранились, migration 021 применена, integrity/FK чистые, реальный HTTP
  push/settings lost-update/avatar round trip PASS. Disposable clone удалён.
  Перед switch создана и повторно проверена sealed backup
  `/Users/vikavavilina/Documents/egor/Luxora-local-backups/Beta-0.1/pre-push-20260811T082301Z`;
  raw temporary extraction удалён без возможности восстановления. Stopped
  rollback container `luxora-phone-live-pre-push-20260811` сохранён. На live
  отдельно PASS token-free/encrypted registration, settings partial patches,
  revoke, readiness и hardening.
- Перед chat-preferences switch дополнительно создана и проверена sealed backup
  `/Users/vikavavilina/Documents/egor/Luxora-local-backups/Beta-0.1/pre-chat-preferences-20260811T085701Z`.
  Real-data clone сохранил 31/40, migration 021, integrity/FK и push regression;
  live smoke затем PASS. Disposable clone/raw extraction удалены, stopped
  rollback `luxora-phone-live-pre-chat-preferences-20260811` сохранён.
- Перед realtime-preferences switch создана и отдельно повторно проверена sealed
  backup `/Users/vikavavilina/Documents/egor/Luxora-local-backups/Beta-0.1/pre-chat-preferences-realtime-20260811T092807Z`.
  Stopped copy сохранил 32/41; fresh и real-data clone прошли migration 021,
  integrity/FK, authenticated V2 dispatch/idempotency и push/settings regression.
  Live smoke добавил один test account (33/42), а rollback
  `luxora-phone-live-pre-chat-preferences-realtime-20260811` сохранён. Все
  disposable volumes, raw restore copies, scan JSON и secret-bearing env extract
  удалены после проверки.
- iPhone auth/devices/avatar workstream: 39/39 focused Swift tests PASS и signed
  `TEST BUILD SUCCEEDED`; fixture-free device list/revoke journey PASS 1/1 с
  current-session marker и реальным исчезновением revoked session. Реальная
  phone → OTP → `password_required` ветка, invalid password, correct login,
  password change/disable PASS 1/1. Avatar crop/upload/save, app relaunch,
  server restore и clear PASS 1/1. Final retained xcresults и 10 кадров в
  `screens_app_iphone/production/v10-live-account-security-avatar-ru/` прошли
  exact canary scan; secret-bearing temporary/failed artifacts удалены exact
  path без возможности восстановления.
- Message requests workstream: 18 selected Swift tests PASS, один opt-in live
  skip ожидаем; отдельный fixture-free Docker acceptance/privacy journey PASS
  1/1. Fresh signed unified UI PASS 4/4; все 11 оригинальных 1320×2868 PNG
  визуально проверены и checksum-indexed в
  `screens_app_iphone/production/v10-message-requests-ru/`.
- Accessibility workstream: финальный signed v17 gate на iPhone 17 Pro Simulator
  iOS 26.5 завершён **6/6 PASS, 0 failures, 188.806 s**. Auth/chats/conversation/
  profile/profile-editor/settings закрывают текущий contract; узкий iOS 26.5
  Inspector false positive для пяти полностью видимых AXXXL fixtures сохранён
  как quarantine attachment вместе с ручным original screenshot proof. Root
  подтвердил полный message body, но на том же AXXXL кадре нашёл отдельный
  partially clipped conversation title/status; header остаётся открытым и
  требует fix + combined signed rerun после shared merge.
- iPhone APNs/preferences source foundation теперь включает AppDelegate token
  bridge, token/session ordering, replacement/signout/401 fences, strict
  token-free API/store и реальный экран global notification settings. Focused
  tests 17/17, полный Swift package 150 executed + 2 expected skip, 0 failures,
  Swift Testing 3/3; signed compile GREEN. Реальной APNs delivery без Apple
  credentials/device evidence всё ещё нет.
- Chat preferences iPhone source теперь имеет HTTP/store и strict account/session-
  fenced V2 decoder/application: focused **24/24 PASS**, последний полный Swift
  **174 executed + 2 expected skip, 0 failures**, Swift Testing 3/3. Unified V2
  opaque cursor/reconciliation и shared Russian UI wiring выполняются после
  accessibility release; нельзя считать эту функцию законченной раньше live UI proof.
- Оценка для коммуникации, а не release claim: полный server/backend около 68%,
  полный iPhone около 49%; узкое работающее ядро auth/profile/text chat заметно
  выше. Проценты пересчитывать только по
  `docs/specs/IPHONE_FUNCTIONAL_COMPLETION_MATRIX_RU.md`.
- Локальная ветка `main` имеет commit `c0afbd2` и большой проверяемый working
  tree. Remote отсутствует. GitHub connector аутентифицирован как `Flenym`, но
  `Flenym/Luxora` возвращает 404 и connector не предоставляет create-repository;
  `gh`/Homebrew отсутствуют. Нельзя создавать public fallback. После merged
  тестов нужны secret/size audit, осмысленный локальный commit и Git bundle;
  private publish требует, чтобы Flenym создал пустой private repository или
  дал интерактивную `gh`-авторизацию.

## 0. Checkpoint после перезапуска Mac (4 августа, исторический)

Этот раздел новее исторических чисел ниже и имеет приоритет при расхождении.
После непредвиденного выключения компьютера root-Codex восстановил Docker,
iPhone 17 Pro Simulator и три параллельные iPhone-линии. Все три линии завершены,
а root независимо принял их результаты. На момент последней записи:

- backend source и protocol оставались на проверенном checkpoint: API **59
  файлов / 552 теста**, protocol **6 файлов / 59 тестов**, migration chain сама
  по себе **13 тестов**, а migration+identity выборка — **2 файла / 14 тестов**;
- операции повторно прошли на новом runtime: API log/DB/content/token canary
  подтвердил SQLite integrity, `0` foreign-key violations, 18 миграций,
  encrypted request row и отсутствие raw canaries; production
  `S3StorageProvider` gate повторно прошёл readiness, SSE-S3 PUT/full/Range GET,
  DELETE, scoped IAM/public denial, version/lifecycle и ambiguous committed-PUT
  cleanup;
- production API runtime заменён на digest-pinned
  `gcr.io/distroless/nodejs22-debian13:nonroot`; он работает как
  `65532:65532`, не содержит shell/npm/Corepack. Собранный локальный образ
  `luxora-api:phone-final` имеет image/manifest ID
  `sha256:15717186ae72f200fcd14837ddfadb09044dc6462e506b9d4199aba7ba0f09d3`,
  размер около 69.1 MB и дал **0 High/Critical vulnerabilities, 0 secrets** в
  Trivy 0.73. Отдельный hardened live container прошёл phone registration,
  exact registration replay и authorized `/v1/me`;
- рабочий `luxora-phone-live` на `127.0.0.1:8080` безопасно переключён на
  `luxora-api:phone-final` с сохранением `luxora_phone_live_data`. Volume был
  переназначен с UID/GID старого Node-образа на `65532:65532`; при первой
  попытке readiness не прошёл из-за старого ownership, автоматический rollback
  вернул сервис, после исправления вторая попытка прошла. Текущий контейнер
  `healthy`, root filesystem read-only, `cap-drop=ALL`,
  `no-new-privileges=true`; сохранены 8 существовавших users/8 device sessions,
  18 migrations и SQLite `integrity_check=ok`;
- merged Apple package root-run: **39 XCTest**, из них 38 pass и один ожидаемый
  opt-in live skip, плюс **3/3 Swift Testing**. Общий `LuxoraMobile` Xcode build
  на iPhone Simulator завершился `BUILD SUCCEEDED`;
- fixture-free phone onboarding/restore снова прошли live API. Все семь
  full-device кадров и SHA-256 приняты в
  `screens_app_iphone/production/v6-live-phone-onboarding-ru/`; проблемные
  username и restored Settings пересняты с полной status bar. README честно
  оставляет Telegram 1:1 gate открытым;
- profile copy/share/QR/login-methods, loaded-message contact search, persisted
  contact sort, folder counts/filter/reset и реальные iOS permission
  statuses/actions проверены 3/3 focused UI tests. Пять принятых кадров,
  checksums и gap-list находятся в
  `screens_app_iphone/production/v7-telegram-navigation-settings-ru/`;
- реальные refresh/load/retry chat states, optimistic text send/retry с тем же
  `clientNonce`, mark-read, reactions, confirmed-contact search и direct-chat
  create/open проверены 2/2 focused UI tests. Три принятых кадра и gap-list — в
  `screens_app_iphone/production/v7-live-chat-functions-ru/`. Кадры используют
  deterministic DEBUG state, а fixture-free live API доказан отдельно;
- после переключения на final distroless runtime live chat integration повторно
  прошёл **1/1**: registration/session/direct chat/send/list/read/reaction
  add/remove/realtime/revoke. Установленный production bundle затем запущен на
  Simulator и восстановил реальную Keychain session до пустого Chats root;
- Flenym повторно закрепил: каждая новая рабочая страница должна сразу
  соответствовать его Telegram reference geometry/style, а не оставаться
  generic technical UI. Binding sources — оба каталога
  `screens_app_iphone/telegram_reference_concepts/` и
  `screens_app_iphone/telegram_sreenshots/` (если второй присутствует);
- предварительный Git-набор после визуальных архивов: **612 файлов / примерно
  229.8 MB**, максимум 6,019,929 байт, файлов больше 100 MiB — 0. `.env`, DB,
  dependencies и build caches игнорируются. Trivy 0.73 secret scan точного
  будущего Git-набора дал 0 findings; `make check-truth` и `git diff --check`
  прошли. Ветка `main`, remote/commit на этом снимке ещё отсутствуют; локальная
  Git identity установлена на Flenym с GitHub noreply address;
- private repository ещё не создан: GitHub CLI `gh` отсутствует, а подключённый
  GitHub App не имеет операции create-repository. Flenym должен один раз
  выполнить `brew install gh` и `gh auth login`; только затем создать/проверить
  `Flenym/Luxora` с `visibility=PRIVATE`. Публичный fallback запрещён.

Перед commit/push остаётся выполнить финальный staged audit, создать локальный
commit и переносимый Git bundle. Если ниже уже появился commit SHA, он новее
этой строки. GitHub publish по-прежнему запрещено делать public fallback.

## 1. Зачем существует этот файл

Flenym переносит работу с текущего Mac на Windows-компьютер. Новый Codex не будет
видеть старую переписку, локальные сообщения агентов и временные результаты
Xcode/Docker. Поэтому этот документ сохраняет:

- исходную цель Luxora;
- важные уточнения пользователя в хронологическом порядке;
- стиль совместной работы, которого ожидает Flenym;
- обязательные продуктовые и визуальные решения;
- честное состояние backend и iPhone-клиента;
- известные пробелы, риски и противоречия документации;
- границу между реальной функцией, DEBUG-фикстурой, концептом и планом.

Здесь **нет секретов**. Не добавлять в этот файл содержимое `.env`, JWT/HMAC/AES
ключи, GitHub tokens, реальные OTP, refresh/access tokens, signing certificates
или приватные ключи. Имеющиеся локальные `.env` намеренно исключены из Git.

## 2. Кто пользователь и как с ним работать

### 2.1. Неподвижная идентичность проекта

- Название продукта: **Luxora**.
- Владелец и разработчик: **Flenym**.
- Единственная публичная версия: **Beta-0.1**.
- Не создавать и не публиковать никакие другие видимые версии без прямого
  решения Flenym; во всех текущих материалах использовать только **Beta-0.1**.
  Внутренние версии API/schema/realtime и package SemVer не являются
  пользовательской версией.
- Канонический исходник бренда: корневой [`logo.png`](logo.png).

### 2.2. Ожидаемое поведение Codex

Flenym прямо делегировал технические и продуктовые решения руководителю-Codex.
Он ожидает, что Codex:

- действует как CTO/руководитель команды, сам выбирает архитектуру и порядок;
- не спрашивает разрешения на каждую мелочь;
- не соглашается автоматически с каждой новой идеей, если она ломает порядок,
  безопасность или качество;
- принимает идеи в backlog и объясняет, почему отдельную вещь нельзя честно
  включить сейчас;
- продолжает основную работу после промежуточного вопроса или новой идеи, если
  пользователь явно не отменил задачу;
- использует все доступные агентские слоты, когда работу можно безопасно
  распараллелить;
- даёт агентам непересекающиеся зоны ответственности, затем сам проверяет их
  изменения;
- просит каждого агента фиксировать выполненные пункты в `TODO.md` только после
  реальной проверки;
- часто и кратко сообщает прогресс на русском, но не останавливается только ради
  статуса;
- показывает реальные скриншоты/тесты/логи, а не выдаёт демонстрационную фикстуру
  за готовое приложение;
- говорит правду о недостающих функциях, даже если Flenym очень хочет скорее
  пользоваться мессенджером;
- сохраняет код, документацию и evidence вместе.

Пользователь пишет разговорно, иногда голосовым распознаванием, с опечатками и
может резко выражать недовольство. Суть резкой реакции обычно в одном из трёх:
показан не тот артефакт, демо названо продуктом или работа остановилась. Отвечать
спокойно, конкретными фактами и продолжать работу.

### 2.3. Как давать проценты

В старом разговоре звучала приблизительная оценка около **72% backend** и
**28% iPhone в целом** (около 38% визуальной оболочки и 18% реально подключённых
функций). Это была коммуникационная оценка, а не измеренный release gate.
Новый Codex не должен наследовать её как факт. Процент разрешено публиковать
только вместе с матрицей: реализовано, интегрировано, протестировано, проверено
визуально и production-ready. Код-фундамент не равен готовой функции.

## 3. Исходное большое техническое задание

Первоначальное ТЗ было передано как локальное вложение:

`/Users/vikavavilina/.codex/attachments/fe5f0783-53ef-4bf0-9a74-b9799363341f/pasted-text.txt`

Этот абсолютный путь не перенесётся на Windows. Поэтому исходный текст целиком
добавлен в [`docs/specs/ORIGINAL_USER_BRIEF_RU.md`](docs/specs/ORIGINAL_USER_BRIEF_RU.md),
а ниже сохранён его полный смысл вместе с последующими уточнениями.

### 3.1. Роль и качество

Codex должен выступать одновременно как CTO, архитектор, product manager,
UX/UI-дизайнер, backend/frontend/native-разработчик, DevOps, QA, security и
планирующий AI-агент. Luxora должна стать современным мессенджером мирового
уровня, способным конкурировать с Telegram, WhatsApp, Signal и Discord.

До реализации требовалось изучить возможности и UX этих продуктов, Telegram
documentation и Apple design guidance, взять лучшие идеи и сформировать единый
продукт. Позднее Flenym уточнил визуальную стратегию для iPhone: сначала
воспроизвести предоставленные Telegram-референсы по геометрии 1:1, на русском,
и только затем добавлять собственные решения Luxora.

### 3.2. Платформы

Целевые клиенты:

- iPhone на SwiftUI;
- iPad;
- macOS;
- Android;
- Windows;
- Linux;
- Web;
- отдельный публичный/скачиваемый сайт.

Все клиенты должны использовать один backend, одну семантику идентичности,
сообщений, ошибок и синхронизации. Общий UI-код не обязателен; нативное поведение
каждой платформы важнее механической пиксельной одинаковости между платформами.

### 3.3. Основная функциональная цель

Полный замысел включает:

- личные чаты и Saved Messages;
- группы, Circles, супергруппы, каналы, Spaces;
- комментарии, темы, threads, ответы, цитаты, пересылки;
- реакции, закреплённые сообщения, историю изменений;
- архив, папки, drafts, scheduled send;
- глобальный поиск людей/чатов/сообщений/файлов/групп/каналов;
- text, photos, video, GIF, stickers, emoji, documents и большие файлы;
- голосовые и круглые video messages;
- просмотр/редактирование/удаление media и сообщений;
- явные sent/delivered/read/failed состояния;
- push, notification preferences, mute и multi-device sync;
- typing, presence, online/last seen с privacy policy;
- профили, avatar, bio, username, links, shared groups/media;
- QR login/device linking, несколько устройств, recovery и settings;
- dark/light/system themes и полную локализацию;
- аудио-, видео- и групповые звонки, демонстрацию экрана, шумоподавление,
  хорошее качество и минимальную задержку;
- серьёзную безопасность, масштабирование, cache/queue/logging/monitoring,
  object storage, backup/restore и production operations;
- unit, integration, UI, performance, stress и security tests;
- CI/CD, Docker, автоматические сборки/тесты/релизы;
- сайт: главная, скачать, возможности, безопасность, FAQ, блог,
  документация и поддержка.

### 3.4. Визуальный замысел

- Впечатление: премиальное, спокойное, точное, «как приложение Apple 2026».
- Использовать системную типографику, Liquid Glass/blur/depth только там, где
  они помогают и не ломают читаемость/производительность.
- Максимально плавные, но функциональные и прерываемые анимации.
- Идеальные отступы, иконки и состояния; минимум визуального шума.
- Дизайн строится вокруг исходного `logo.png` и violet/indigo/electric-blue
  бренда, но reading surfaces остаются спокойными.
- Accessibility, Reduce Motion, Reduce Transparency, Dynamic Type, high contrast
  и VoiceOver являются частью базового качества, а не «потом».

## 4. Хронология ключевых уточнений Flenym

Ниже не дословная стенограмма, а полный журнал решений в порядке появления.

1. Flenym спросил, прочитано ли всё ТЗ, и потребовал учитывать его целиком.
2. Зафиксировал владельца/разработчика **Flenym** и единственную версию
   **Beta-0.1**.
3. Предложил порядок «сервер → iPhone → остальные платформы», но отдельно дал
   Codex право решить правильный инженерный порядок.
4. Разрешил установить/использовать Docker при необходимости.
5. Уточнил: backend должен быть спроектирован полностью для всех будущих
   клиентов; после него iPhone получает все функции; только после работающей
   пары server+iPhone остальные клиенты повторяют проверенные контракты.
6. Сообщил, что на Mac установлен Xcode и его нужно использовать для реальной
   проверки iPhone-приложения.
7. Несколько раз потребовал подключить больше агентов и вести backend/iPhone
   параллельно там, где это ускоряет результат.
8. Предложил branded loader по контуру логотипа.
9. Исправил механику loader: две точки не летят навстречу. Они всегда находятся
   на противоположных половинах одного маршрута, движутся **в одном направлении
   с одной скоростью и никогда не встречаются**.
10. Исправил внешний вид loader: сам логотип, заливка и полный контур не видны.
    Видны только две точки и короткие лучи, которые временно обнаруживают часть
    внешней и внутренней петли маршрута.
11. Для чёрного фона runners светлые/брендовые; для белого — чёрные.
12. Попросил не прекращать работу во время его отсутствия и после коротких
    сообщений «продолжай».
13. Попросил показывать реальные текущие iPhone-результаты скриншотами в
    репозитории. Резко отверг показ старой демки вместо работы активного агента.
14. Уточнил, что Codex не должен слепо следовать каждой его тактической идее:
    нужно брать нужное число backend-агентов и объяснять собственные решения.
15. Потребовал разделить production-приложение и приложение для дизайна/тестов.
    Это реализовано как `LuxoraMobile` и `LuxoraDesignLab`.
16. Попросил генерировать imagegen-концепты для всех страниц, но затем уточнил,
    что реальная iPhone-реализация должна исходить из его Telegram-скриншотов.
17. Указал старый набор `screens_app_iphone/telegram_sreenshots`, а затем полный
    authoritative-набор `screens_app_iphone/telegram_reference_concepts`.
18. Потребовал сначала воспроизвести все страницы, панели, кнопки, расположение
    и состояния Telegram-референсов 1:1, сразу на русском; собственные улучшения
    разрешены только после этого базового прохода.
19. Попросил горизонтально прокручиваемые папки чатов и stories/status: свайп
    влево показывает продолжение, свайп вправо возвращает начало.
20. Уточнил, что Dynamic Island на исходных фотографиях мог показывать музыку
    телефона; Luxora должна использовать обычную idle Dynamic Island и не
    копировать системный Now Playing.
21. Потребовал одновременно делать SwiftUI и перепроверять каждый экран через
    Xcode/Simulator; скриншоты складывать и обновлять в
    `screens_app_iphone/`.
22. Потребовал переделать вход как в Telegram: основной путь только по номеру
    телефона. Username/password не является основным iPhone UX.
23. Подробно описал конечный onboarding, сохранённый в следующем разделе.
24. После выключения компьютера попросил возобновить root и всех агентов,
    поднять Docker и Simulator, продолжить backend+iPhone.
25. Попросил в конце создать **приватный GitHub-репозиторий только для него**,
    загрузить туда проект и создать два больших portable MD-файла для нового
    Codex на Windows. Этот файл — первый из двух; второй —
    [`CONTINUE_LUXORA_PROMPT.md`](CONTINUE_LUXORA_PROMPT.md).

## 5. Binding phone-first authentication и onboarding

Это последнее подробное продуктовое уточнение пользователя и P0-контракт.

### 5.1. Первый запуск

1. При первом запуске показать короткую интересную анимацию бренда, не держать
   пользователя на бесконечном splash.
2. Сначала работает невидимый contour loader; затем знак Luxora может плавно
   появиться/переместиться к центру, после чего плавно появляется короткий текст.
3. Пользователь нажимает `Продолжить`.
4. При последующих запусках нельзя искусственно повторять длинное onboarding;
   session restoration показывает только реальную работу и recovery/error.

### 5.2. Телефон и OTP

1. Экран страны/номера использует country picker, код страны и форматированный
   номер.
2. Сервер нормализует и проверяет E.164; клиент не решает, существует ли
   аккаунт.
3. Сервер отправляет шестизначный одноразовый код через provider abstraction.
4. OTP не логируется и не возвращается в production-response.
5. До правильного кода сервер не выполняет различимый lookup существования
   phone identity.
6. После правильного OTP сервер сам выбирает одну из веток.

### 5.3. Существующий аккаунт

1. Если телефон уже привязан, ответ означает вход.
2. Если у аккаунта настроен дополнительный «секретный пароль»/2FA, сервер должен
   вернуть отдельный `password_required` discriminator и выдать сессию только
   после успешной второй проверки. **Этого контракта сейчас нет.**
3. Без 2FA сервер сразу создаёт device session и tokens.
4. Клиент явно синхронизирует профиль, список чатов, историю/первое состояние и
   realtime cursor; нельзя показать пустые чаты как успешный вход при ошибке
   sync.
5. После успешной sync пользователь попадает в `Чаты` со всем ранее сохранённым
   серверным состоянием.
6. Если приложение установлено впервые и разрешения ещё не спрашивались, ветка
   существующего аккаунта также проходит permission primer.

### 5.4. Новый аккаунт

После правильного OTP для неизвестного номера порядок фиксирован:

`имя/avatar/bio → username → permissions → sync → Чаты`.

- Имя обязательно.
- Bio/описание необязательно и создаётся вместе с профилем.
- Avatar необязателен.
- Если avatar не выбран, показывается детерминированный цветной круг с первой
  буквой/инициалами имени или username.
- Выбор изображения открывает редактор: круглая область результата, затемнение
  снаружи, pan и zoom. Та же reusable crop-механика понадобится для профиля,
  контакта, группы, канала и других avatar/logo flows.
- Нельзя говорить, что avatar загружен, пока нет завершённого server upload/link
  контракта.
- Username обязателен в текущем уточнённом flow. Он проверяется на сервере.
- Занятый username подсвечивается красным с объяснением.
- Сервер предлагает до нескольких свободных альтернатив, обычно с суффиксами
  `_1`, `_2` и т.п.
- Нажатие на suggestion помещает его в поле; доступный вариант получает зелёный
  статус. Только после этого активна кнопка создания аккаунта.
- Финальное создание пользователя, phone identity, profile, session и refresh
  должно быть атомарным и идемпотентным.

### 5.5. Разрешения

- Notifications и Contacts можно объяснить после первого успешного входа или
  регистрации, если это новая установка и решение ещё не принималось.
- Camera, microphone и Photos/gallery должны запрашиваться контекстно перед
  первой реальной функцией, а не все сразу без причины.
- На deny/restricted показывать понятную причину и кнопку перехода в Settings;
  при возвращении перечитывать OS state.
- Повторная попытка video call/voice/photo после deny должна объяснять, какое
  разрешение нужно и где его включить.
- Отказ не должен блокировать обычные текстовые чаты.

## 6. Binding Telegram-reference contract для iPhone

### 6.1. Источник истины

Единственный binding-набор геометрии и информационной иерархии:

[`screens_app_iphone/telegram_reference_concepts/`](screens_app_iphone/telegram_reference_concepts/)

В нём 62 пользовательских файла: 61 PNG 1179×2556 и один намеренно обрезанный
JPEG 1179×1237. SHA-256 и полная карта находятся в:

- [`screens_app_iphone/full_reference_qa/FULL_REFERENCE_COVERAGE.md`](screens_app_iphone/full_reference_qa/FULL_REFERENCE_COVERAGE.md);
- [`screens_app_iphone/full_reference_qa/REFERENCE_INVENTORY.json`](screens_app_iphone/full_reference_qa/REFERENCE_INVENTORY.json);
- [`screens_app_iphone/telegram_reference_concepts/REFERENCE_MANIFEST.md`](screens_app_iphone/telegram_reference_concepts/REFERENCE_MANIFEST.md).

`imagegen_concepts`, `concepts`, `LuxoraDesignLab` и Simulator captures помогают
проектировать и проверять, но не создают новый binding-экран и не доказывают
работающий runtime.

### 6.2. Что означает «скопировать 1:1»

Flenym разрешил и потребовал 1:1 проход. Рабочая трактовка репозитория:

- воспроизводить hierarchy, размеры, inset, плотность, панели, расположение
  кнопок, scroll behavior и показанные states;
- русский язык с первого production-прохода;
- не копировать знак/название Telegram, Premium/Stars/Wallet, чужие usernames,
  телефоны, сообщения, QR, фотографии и коммерческие обещания;
- использовать Luxora brand и синтетические данные;
- пользовательские скриншоты не встраивать как raster assets приложения;
- неподдержанные сервером кнопки оставлять видимо locked/disabled с честным
  объяснением, а не изображать локальный успех.

### 6.3. Корневая навигация

- Одна floating glass capsule с четырьмя пунктами строго в порядке:
  `Контакты / Звонки / Чаты / Настройки`.
- Справа отдельная круглая кнопка `Поиск`.
- Search не является пятой вкладкой внутри capsule.
- Spaces/Circles/Channels находятся внутри `Чаты`.
- На вложенных conversation/profile/settings detail нижняя root-панель скрыта.
- Folder rail и story/status rail — независимые горизонтальные scrollers с
  частично видимым следующим элементом и восстановлением позиции.
- Dynamic Island — обычная idle, без скопированной музыки/альбомной активности.

### 6.4. Геометрический gate

- Pixel-comparable устройство: iPhone 14 Pro или 15 Pro, **393×852 pt, 3x**, то
  есть 1179×2556 PNG.
- iPhone 17 Pro 402×874 полезен для functional QA, но не для 1:1 diff.
- Для каждого реализованного reference нужен production capture, manifest,
  same-size overlay, difference/edge report и ручной просмотр original detail.
- Допуск без объяснения: около 1 pt для контейнеров/dividers/navigation/icon
  centers и 2 pt для baseline/optical alignment.

### 6.5. Loader

Канонические файлы:

- [`docs/specs/BRAND_LOADING_MOTION.md`](docs/specs/BRAND_LOADING_MOTION.md);
- [`assets/brand/luxora-loader-route.svg`](assets/brand/luxora-loader-route.svg);
- [`design-previews/brand-loader/`](design-previews/brand-loader/).

Нельзя рисовать логотип, ghost fill, третий spinner или полный persistent stroke.
Ровно две одинаково быстрые точки, фаза 0.5, одно направление, короткие trails,
внешняя и внутренняя петля. Reduced Motion показывает статичную противоположную
пару. Контент готовности важнее завершения декоративного цикла.

## 7. Принятый инженерный порядок

Канонический порядок, закреплённый в `README.md`, `ARCHITECTURE.md`, `ROADMAP.md`
и `TODO.md`:

```text
1. Полная server platform
   ↳ во время неё допускается тонкий iPhone integration harness
2. Полный iPhone product
3. iPad / macOS / Android / Web / Windows / Linux / публичный сайт
```

Причина: один проверенный backend contract должен существовать до того, как семь
клиентов начнут независимо выдумывать auth/sync/media/call semantics. При этом
тонкий iPhone harness развивается параллельно, потому что он выявляет проблемы
HTTP/WS/Keychain/onboarding раньше и даёт Flenym видимый результат.

Работа над другими клиентами сейчас заморожена, кроме truth/security/build
maintenance. Их существующие foundations нельзя называть готовыми приложениями.

## 8. Фактическое состояние репозитория на момент снимка

### 8.1. Git и размер

- Репозиторий инициализирован на ветке `main`, но **не имеет ни одного commit**.
- `git status` показывает все проектные файлы как untracked.
- Remote не настроен.
- Git user.name/user.email в проверенном выводе не были настроены/показаны.
- Полный workspace около 1.8 GiB из-за ignored build/cache.
- После добавления live iPhone evidence набор файлов, не исключённых
  `.gitignore`, составлял около **596 файлов / 213 MiB**;
  крупнейший отдельный файл около 6 MiB, то есть явного GitHub 100 MiB blocker
  на момент проверки нет.
- `.env`, `services/api/.env`, `.codex`, `node_modules`, build/dist,
  `.build`, Gradle caches, Xcode per-user state, runtime DB и backups исключены.
- `apps/apple/project.yml` остаётся источником истины. Пять shared-файлов
  `apps/apple/Luxora.xcodeproj` (`project.pbxproj`, workspace metadata и три
  shared schemes) сейчас намеренно входят в будущий Git-набор; `xcuserdata` и
  прочее per-user состояние исключены. После генерации shared metadata должен
  совпадать с `project.yml`, а не становиться независимой конфигурацией.

### 8.2. Структура

```text
apps/apple/          SwiftUI shared kit, LuxoraMobile, LuxoraDesignLab, macOS probe
apps/android/        Kotlin/Compose local foundation
apps/web/            React/Vite landing + local messenger prototype
apps/desktop/        hardened Electron shell over Web build
packages/protocol/   canonical Zod HTTP/realtime contracts
packages/passkey-domain/ isolated WebAuthn ceremony domain
packages/call-control/ isolated call state/grant domain
services/api/        Fastify API + realtime + SQLite repository
infra/               Compose, observability, backup/S3/calls probes
docs/                specs, ADRs, audits, research
assets/brand/        derived transparent logo and reviewed loader route
screens_app_iphone/  user references, generated concepts, runtime evidence, QA
script/              Apple source scan, visual diff, build helpers
```

### 8.3. Tooling текущего Mac

- Docker Engine 29.6.2 и Docker Compose 5.3.1 доступны.
- Xcode 26.6 (17F113) доступен.
- iOS 26.5 Simulator `iPhone 17 Pro` был booted при снимке.
- Отдельный development-proof container `luxora-phone-live` был healthy и
  слушал только `127.0.0.1:8080`; это локальный phone-auth evidence, а не
  production deployment и не основной Compose stack.
- `node`/`npm` не находились в shell `PATH` после перезагрузки. Проверки JS можно
  выполнять в Docker либо установить Node.js 22. На новом Windows Node 22 нужно
  установить явно.

## 9. Backend: что действительно сделано

### 9.1. Базовая платформа

- Node.js 22, TypeScript ESM, Fastify 5, strict Zod boundaries.
- SQLite WAL, foreign keys, transactional append-only migrations и Store seam.
- Health/readiness, OpenAPI/Swagger, Prometheus metrics, exact CORS/Origin,
  Helmet, bounded body/page/message limits, sanitized errors и redacted logs.
- Docker multi-stage non-root image; root Compose bind только на loopback,
  read-only root FS, dropped capabilities и healthcheck.

### 9.2. Password/session auth

- Username/password registration/login с Argon2id.
- Short-lived HS256 access JWT с issuer/audience/session claims.
- Hash-only opaque rotating refresh tokens.
- Strict single-use rotation, reuse revoke, writer-reserved race handling,
  session list/current/remote revoke и same-process realtime disconnect.

### 9.3. Identity/access

- Exact privacy-filtered username lookup.
- Contextual search accepted contacts.
- Message requests, atomic accept/private dismiss.
- Directed block, accepted relationship и selected-evidence safety report.
- Abuse-sensitive local account/session/IP buckets и adversarial authorization
  tests.

### 9.4. Messaging/community foundation

- Direct/group/channel creation, reads and authorization.
- Group/channel membership list/add/role/remove, immutable owner, 200-member
  limit, exact nonce receipts, revisions и independent-writer removal-vs-send.
- Text send/reply/edit/tombstone/reactions.
- Pins, topics, edit versions и privacy-minimized forwards foundations.
- Explicit delivered/read receipts; no timer inference.
- Полные ownership transfer, invitations/join requests, comments/threads,
  drafts/scheduled send и moderation пока не готовы.

### 9.5. Realtime/sync

- WebSocket v1/v2, auth deadline, heartbeat, typing/presence, bounds,
  backpressure и per-session connection caps.
- Durable per-audience SQLite events/outbox.
- V2 account/session-bound HMAC cursor, seven-day logical TTL, max 500 replay,
  deterministic `sync.required` и authorized 12-collection HTTP reconciliation
  snapshot.
- Account-scoped `sync.invalidated` поддерживает V2 live/replay и имеет
  schema-compatible default-on emergency seam; V1 безопасно пропускает это
  additive event.
- Cross-process broker/fan-out, rolling deploy, production retention/load и
  distributed session revoke ещё не готовы.

### 9.6. Media/search

- Resumable encrypted staging, local/S3 providers, authorized full/Range
  download, quotas, orphan/restart/response-loss tests.
- MIME/magic allowlist и честный `unscanned` status.
- Permission-first blind-index message/file search foundation.
- Нет production malware quarantine/transcode, verified metadata pipeline,
  voice/video note derivatives, GIF/sticker/custom emoji completeness и
  production cloud IAM/KMS evidence.

### 9.7. Passkeys and calls

- Несколько внутренних passkey add/login/signup/management foundations с
  WebAuthn verifier, encrypted state, exact replay, migrations и races.
- Они default-off, запрещены в production и public capability остаётся false.
- Recovery, public UX/routes, notifications и cross-platform evidence отсутствуют.
- Isolated `packages/call-control` и loopback LiveKit/coturn harness существуют.
  API signaling, signed grants, client calls и screen sharing отсутствуют.
- E2EE не реализовано; текущий Cloud preview server-readable.

## 10. Backend phone-auth checkpoint

После старого backend checkpoint добавлен и независимо усилен новый server
foundation:

- `libphonenumber-js` 1.13.10;
- protocol schemas для phone challenge/OTP/profile-required/authenticated,
  username availability и registration;
- dynamic capability `features.phoneAuthentication`;
- config gate `disabled | development | external`, отдельный HMAC root,
  обязательный active data-encryption key при enable;
- migration `018_phone_authentication`;
- `phone_identities`, `phone_auth_challenges`, immutable encrypted receipts и
  append-only audit events;
- HMAC digests для E.164/code/registration token/fingerprints;
- encrypted E.164, pending delivery code, device name и replay response;
- challenge states `pending_delivery|pending|verified|consumed|locked|expired`;
- HTTP:
  - `POST /v1/auth/phone/challenges`;
  - `POST /v1/auth/phone/challenges/:id/verify`;
  - `POST /v1/auth/phone/usernames/check`;
  - `POST /v1/auth/phone/registrations`;
- account lookup только после правильного OTP;
- existing identity возвращает `status:"authenticated"` и создаёт session;
- новый номер возвращает `status:"profile_required"` и короткоживущий
  registration token;
- username suggestions и атомарная password-disabled phone registration;
- durable per-phone resend window, который не позволяет обходить
  `retryAfterSeconds` новым nonce;
- повтор ambiguous provider delivery использует тот же challenge ID как
  idempotency key;
- verified E.164 переносится из challenge envelope в identity envelope с новым
  стабильным identity-bound AAD, поэтому ciphertext остаётся расшифровываемым;
- source tests: phone integration/storage плюс migration/config/authorization/
  protocol additions.

Зафиксированный чистый Node 22 Linux checkpoint после hardening:

- focused API/config/storage/authorization: **30/30**;
- migration chain: **13/13**; migration+identity focused run:
  **2 files / 14/14**;
- full API: **59 files, 552/552**;
- shared protocol typecheck/build и **6 files, 59/59**.

Свежий production image и disposable hardened development-provider container
прошли challenge → `profile_required` → username check → registration → exact
replay → existing-account authentication → authenticated `/v1/me`; остановленный
raw DB/WAL scan не нашёл full phone, OTP или masked-phone canary. Это доказывает
локальный development-provider foundation, но не production SMS и не полный
iPhone E2E. После этого checkpoint service/test source продолжал изменяться,
поэтому перед новым claim всё равно нужен повторный current-tree full run.

Открыто:

- реальный production SMS provider/credentials/webhook/delivery semantics;
- external provider composition из `server.ts`/deployment, а не только injected
  test seam;
- production/distributed rate/abuse controls и retention/sweeper;
- 2FA `password_required` branch и verification endpoint;
- avatar/profile-media server contract;
- phone privacy/discoverability settings;
- повторный docs/truth/secret scan после любых следующих source edits;
- живой Docker ↔ iPhone handshake всех веток, expiry, retry, wrong attempts,
  rate limit и response-loss/race evidence.

## 11. iPhone: что действительно существует

### 11.1. Project/targets

- Swift 6.2 package, iOS 18/macOS 15 deployment declarations.
- XcodeGen `apps/apple/project.yml`, Xcode 26.6.
- `LuxoraMobile` — production-shaped app без DesignFixtures dependency.
- `LuxoraDesignLab` — отдельное визуальное приложение с fixtures.
- Отдельные UI-test bundles для каждого.
- `defaultLocalization: ru`; root logo включается из канонического файла.

### 11.2. Server harness

- URLSession client, basic WebSocket decoder/client.
- Keychain session credentials и serialized refresh coordinator.
- Restore/login/register/revoke.
- Load current user, chats, first selected conversation messages.
- Optimistic remote text send и basic message/typing realtime.
- Honest restoring/connecting/connected/offline/error states.
- Нет durable local DB/outbox, robust `sync.required` apply, full paging,
  background sync, APNs, remote media/actions/calls/E2EE.

### 11.3. Russian Telegram-reference UI

- Русская shell: Контакты / Звонки / Чаты / Настройки + отдельный Поиск.
- Folder/status rails прокручиваются в обе стороны.
- Chats, contacts, edit chats, direct conversation, contact profile, search,
  Settings root и Calls gate имеют runtime routes/tests.
- Вложенные экраны скрывают root shell.
- Неподдержанные calls/media/folders/push/passkeys/E2EE показывают truth gate.
- v4 содержит 10 production-target captures, но 01–09 используют DEBUG
  server-shaped data и не являются live backend proof.
- Только 7/62 references имеют same-size пары; все визуально ещё открыты.

### 11.4. Активный новый phone onboarding

В source уже появились состояния:

`welcome → phone → code → profile → username → permissions → sync`.

Также есть:

- first-launch contour-to-logo/text motion;
- searchable country picker и combined E.164 limit;
- disabled invalid CTAs, masked phone, `.oneTimeCode`, resend timer;
- real API calls `requestPhoneCode`, `verifyPhoneCode`,
  `checkPhoneUsername`, `completePhoneRegistration`;
- existing-account `authenticated` branch вызывает initial bootstrap;
- new-account profile: required name, optional bio;
- Photos picker + circular crop/pan/zoom editor;
- deterministic colored-initial fallback avatar;
- debounced server username check, red taken state, suggestion chips, green
  available state;
- notification/contact permission primer, deny → Settings recovery;
- local pending avatar persistence после реального account creation с честным
  комментарием, что серверная загрузка ещё не выполнена;
- DEBUG-only traversal, который прямо сообщает, что SMS/account не создавались.

На момент снимка эти файлы **редактировались агентом**. Последний package
checkpoint выполнил 28 XCTest cases: 27 passed и один ожидаемый opt-in live skip;
ещё три Swift Testing cases прошли. Отдельный opt-in production-target UI test
уже прошёл на
iPhone 17 Pro Simulator против `luxora-phone-live`: реальный challenge и
development OTP → `profile_required` → profile/username availability → account
commit → permission primer → initial sync → `Чаты`. Отдельный `simctl launch`
восстановил сохранённую live session. Семь checksum-indexed кадров и честные
границы evidence находятся в
`screens_app_iphone/production/v6-live-phone-onboarding-ru/`; это functional
proof, не 393×852 pixel gate и не production SMS proof. Старые v5 PNG остаются
историческими.

Открыто:

- повтор current-source Swift/package/build после последующих edits и один
  сохранённый полный release UI-suite artifact;
- live existing-account, occupied-username suggestions, wrong/expired OTP,
  retry/rate-limit, sign-out/revoke и failure-recovery branches;
- `password_required`/2FA;
- настоящий avatar upload/link и profile update;
- существующий аккаунт + first-install permissions runtime test;
- contextual Camera/Microphone/Photos recovery на реальных функциях;
- fresh 9/9 UI run и новые captures на iPhone 15 Pro 393×852;
- полный набор 62/62 production screens и interactions;
- durable outbox/offline/reconciliation/background/push;
- media/voice/video messages/calls — только после server contracts.

## 12. Подтверждённые evidence checkpoints

Новый phone-backend checkpoint описан в разделе 10: protocol **59/59**, focused
API **30/30**, migration chain **13/13** (migration+identity focused run
**2 files / 14/14**), full API **59 files / 552/552**, Docker
development-provider handshake и stopped DB/WAL canary scan. Это самая свежая
зафиксированная server evidence, но не освобождает от повтора после последующих
edits или clean clone.

Отдельный current iPhone checkpoint: opt-in `LuxoraMobile` UI test прошёл live
new-account development-provider path до Chats, повторный launch восстановил
session, а семь v6 кадров сохранены с SHA-256. Это не полный UI suite и не
доказательство existing-account/2FA/production SMS.

До него были зелёными:

- shared protocol: **58/58 passed**;
- API full sequential: **57 files, 539/539 passed**, около 72.55 s;
- membership integration/storage/race suites добавлены и проходили;
- Docker API image был собран; live health/readiness и synthetic membership
  add → promote → remove проходили; migration `017` была применена;
- iPhone reference UI: **8/8 passed**, 0 failures, 211.768 s, Xcode 26.6;
- v4 QA и visual diffs находятся в
  `screens_app_iphone/production/v4-telegram-reference-ru/`.

Временные `/tmp/*.xcresult`, локальный Docker volume и применённая локальная DB
не перенесутся через GitHub. Считать их исторической записью, а не заменой
нового clean-clone evidence.

## 13. Документы, которые могут отставать от кода

На момент обновлённого снимка `API.md`, `BACKEND.md`, `DATABASE.md`,
`SECURITY.md`, `TESTING.md`, `CHANGELOG.md`, `TODO.md`, root/service
`.env.example` и основной phone section `apps/apple/README.md` уже отражали
server foundation и live new-account iPhone checkpoint, честно оставляя
production SMS/2FA/avatar/distributed gates открытыми.

`apps/apple/README.md` также исправлен: `project.yml` остаётся canonical,
reviewed shared project/workspace/schemes входят в Git, а per-user state
исключён. На момент снимка известной рассинхронизации этих handoff-фактов с
перечисленными canonical docs не осталось; после следующих edits всё равно
повторить truth scan и сравнение source ↔ docs.

Следующий Codex должен исправить документацию после того, как новый код пройдёт
tests. Не обновлять docs так, будто production SMS или 2FA уже работают.

## 14. Что нельзя заявлять

- Luxora сейчас не production-ready.
- Нет E2EE; сервер видит message plaintext в текущем Cloud preview.
- Storage AES-GCM не является E2EE.
- Нет пользовательских звонков, несмотря на call-control/SFU/TURN foundations.
- Нет полного push, voice/video messages, media pipeline, full moderation,
  production DB/HA/DR или всех клиентов.
- Internal passkey seams не являются public passkey feature.
- DEBUG fixture/screenshot не является live server evidence.
- Успешный API build не означает готовый iPhone flow.
- Красивый экран не означает работающую кнопку.
- «Загрузили абсолютно всё в GitHub» никогда не включает secrets, local DB,
  build caches, DerivedData или unreviewed credentials.

## 15. GitHub-перенос, который попросил Flenym

Требование: приватный репозиторий, доступный только Flenym, чтобы продолжить на
Windows. Перед первым push обязательно:

1. дождаться завершения/остановки агентов и перечитать `git status`;
2. запустить secret scan и проверить ignored files;
3. никогда не использовать `git add -f` для `.env`, keys, DB, `.codex`, build
   output или generated Xcode project;
4. проверить размер/лицензионную и privacy-чувствительность screenshots;
5. создать **private**, не public repository;
6. сделать осмысленный первый commit только после завершения текущих edits;
7. push и затем через GitHub UI/API подтвердить visibility=private и наличие
   именно нужных source/docs/assets/evidence;
8. клонировать в чистую временную директорию или использовать CI как proof, что
   репозиторий воспроизводим без локальных caches;
9. не писать GitHub token/URL с credential в документы или remote URL.

User references содержат реальные лица/данные из предоставленных скриншотов.
Flenym явно попросил включить проект в свой приватный repository, но эти файлы
никогда не должны стать публичными или попасть в assets приложения.

## 16. Перенос на Windows: существенное ограничение

На Windows можно полноценно продолжать protocol/backend/Web/Android/Electron,
Docker, документацию и редактирование Swift source. Но Xcode и iOS Simulator
работают только на macOS. Поэтому новый Codex обязан:

- не утверждать, что выполнил iPhone build/UI test локально на Windows;
- использовать GitHub Actions macOS runner или доступный Mac для Swift/Xcode
  evidence;
- хранить `project.yml` как source of truth и регенерировать `.xcodeproj` на Mac;
- не заменять Simulator proof картинкой из браузера/Figma/imagegen.

## 17. Финальная директива из текущего разговора

Flenym хочет, чтобы работа продолжалась, а не завершалась созданием этих файлов.
Текущая цель после передачи:

1. сохранить зелёный migration-025/drafts checkpoint и повторять точные
   affected/full/live/UI gates после каждого source change;
2. закрыть оставшиеся phone-auth failure/recovery/production-provider gates,
   device compromise/recovery, privacy/block/report и account lifecycle;
3. довести pagination и local durability до encrypted indexed DB с offline,
   quota/eviction, local drafts/media/mutation queues и process-death tests;
4. продолжать server-first roadmap: media/voice/round video, search/contacts,
   real push/jobs, calls, затем audited E2EE и production operations/DR;
5. постепенно закрывать 62 iPhone references только реальными routes/states с
   live/Xcode/accessibility evidence;
6. после финального audit/commit пересоздать transfer bundle, создать через уже
   авторизованный `gh` только private `Flenym/Luxora`, push и проверить private
   visibility/remote branch перед заявлением об успешной публикации.

Самодостаточная рабочая инструкция для следующего Codex находится в
[`CONTINUE_LUXORA_PROMPT.md`](CONTINUE_LUXORA_PROMPT.md).
