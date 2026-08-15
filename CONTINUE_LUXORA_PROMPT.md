# Большой prompt для продолжения Luxora в новом Codex

> Скопируй весь этот файл в новый сеанс Codex или попроси Codex сначала прочитать
> его из корня репозитория. Инструкция самодостаточна, но перед изменениями Codex
> также обязан прочитать `CODEX_CONVERSATION_CONTEXT.md` и перечисленные ниже
> canonical files.

---

## Активный checkpoint 15 августа 2026 — наивысший приоритет

Ниже этого блока сохранена большая история проекта. Любые более старые слова
«current», «текущий», «exact-tree» и любые проценты описывают только свой
датированный checkpoint. Не начинай проект заново и не reset/checkout/clean
рабочее дерево: сначала проверь `git status`, активных агентов, Docker и
артефакты тестов.

- Server/protocol source на этом checkpoint зелёный: protocol **11 файлов / 89
  тестов PASS**, API **71 файл / 626 тестов PASS**, production/test typecheck
  PASS. Migration `025` реализует server-synchronized drafts с strict
  GET/PUT/DELETE, Unicode/10k bounds, CAS/tombstones, stable nonces,
  encrypted-at-rest state/receipts, lifecycle purge, bounded rate limits,
  per-audience outbox ordering and owner-only V2 events. Remove/re-add не
  возвращает старый draft/nonce. Strict reconciliation snapshot остаётся из 12
  collections; iPhone использует авторизованный lazy GET. Сервер может
  расшифровать messages и drafts — это не E2EE.
- Local live promoted и проверен: `luxora-phone-live` работает на exact
  `luxora-api@sha256:f9dbff7ffb5a22d0400fdf9c1a97e379696505f2d5a54c64c787c99c52620e6d`,
  migration `025`, loopback `127.0.0.1:8080`; OTP console 8081 healthy. Runtime
  UID/GID 65532, read-only root, cap-drop ALL, no-new-privileges, exactly one
  loopback listener; error-level logs после cutover 0. Exact image прошёл Trivy
  0.73: **0 High / 0 Critical / 0 secrets**. Это local preview, не cloud
  production.
- Restored-m024 rehearsal сохранил baseline и прошёл migration/integrity/FK/
  capabilities/hardening плюс Swift draft HTTP+V2 1/1. Первый backup/rehearsal
  source:
  `/Users/vikavavilina/Documents/egor/Luxora-local-backups/Beta-0.1/pre-live-m025-promotion-20260815T121732Z` также verifier/restore PASS; его
  `SHA256SUMS` digest
  `6966e7b0ab464c573acfba886b8236ec5c737caca492531dd440148ab868d86b`.
  Окончательный rollback point:
  `/Users/vikavavilina/Documents/egor/Luxora-local-backups/Beta-0.1/pre-live-m025-final-cutover-20260815T122438Z`;
  verifier/restore PASS, 7 files, `SHA256SUMS`
  `87c0ac8dfc63f4626a07f6bec084a55d4d1e412a2cdf1fa155d38d5f23ed30ae`.
  Final-stop DB/blobs/uploads byte-for-byte совпали с первым backup, counts всех
  69 таблиц совпали. Final pre-smoke baseline 47 users/57 sessions/179 refresh,
  19 chats/25 members/19 messages, 1 folder, 131 events/131 outbox, 2
  attachments/1 upload и 0 draft rows сохранился. Postpromotion fixture-free
  Swift draft HTTP+V2 прошёл **1/1 за 0.557 s**; ожидаемый synthetic smoke дал
  один tombstone/2 encrypted receipts и 134/134 events/outbox, после чего
  integrity/FK, outbox pending/failed и error logs чистые.
- Migration `025` уже касалась live volume. Никогда не запускай на нём image
  `47e66d…` или старше. Data rollback: проверить final m024 archive, восстановить
  его только в **новый** volume и явно принять потерю данных после
  `2026-08-15T12:24:58Z`; иначе делать forward fix на m025-compatible image.
- Current Apple evidence: **351 XCTest**, 6 expected live-only skips, 0 failures;
  Swift Testing **11/11**. Focused drafts **48/48**, Messenger/reconciliation
  **26/26**, capabilities **11/11**, Debug automation **5/5**. Post-patch v15
  UI на iPhone 17 Pro/iOS 26.5 — **1/1 PASS**, 75.079 s, xcresult
  `/tmp/LuxoraDraftsUI.PostPatch.EDyOo5/DraftsUI-PostPatch.xcresult`; invalid
  frame warning 0 в log/activities/binary tree. Три PNG повторно экспортированы,
  просмотрены и checksum-verified. Это DEBUG-only server-shaped visual journey;
  live transport доказан отдельным Swift→Docker test, а не скриншотами.
- v14 global search: production-target UI 1/1 и отдельный fixture-free
  Swift→Docker 1/1. Public/global catalog, multi-page live search, file action и
  exact message jump остаются открытыми.
- Не называй server или iPhone «100% готовыми» и не давай общий процент без
  новой явной формулы. Production SMS/database/broker, real APNs, media
  processing, voice/round video, calls, E2EE, full offline/encrypted local DB,
  real-device/TestFlight/App Store, 62/62 pixel closure, off-host DR и pentest
  остаются открытыми.
- До финального handoff commit базой `main` был `2026dc4`, remote ещё
  отсутствовал, а большой dirty tree содержал намеренные изменения. После
  передачи используй фактический `git log -1`, не этот base hash.
  Final pre-commit audit: 857 intended files (49 modified tracked + 32
  untracked) / 263,078,662 bytes, max 6,019,929 bytes, 0 files от 50/100 MiB, 0
  Windows-invalid paths/casefold collisions, clean
  `git diff --check`, 0 high-confidence/Trivy secret findings при исключённых
  ignored `.env`/runtime/build paths. Всё перепроверь после остановки агентов.
  Старый checksum-valid bundle содержал только `2026dc4`; после implementation
  commit создан новый verified bundle. Official `gh` 2.97.0 checksum-verified,
  keyring auth активен для `Flenym`. Private repository
  `https://github.com/Flenym/Luxora` создан и загружен; GitHub API подтвердил
  `visibility=PRIVATE`, default branch `main`, а implementation checkpoint
  `8639279962c8a0e539733c94c088eb6eb4ede03c` присутствует в remote history.
  При продолжении повторно сравни local HEAD с `origin/main`, потому что handoff
  docs могли добавить следующий commit. Public fallback запрещён.

### Следующая очередь исполнения

1. Сначала сохранить зелёный m025/drafts checkpoint: при source edits повторять
   затронутые focused tests, полные protocol/API/Apple suites, build и нужный
   live/UI gate; не мутировать live без backup/rehearsal.
2. Закрыть phone-auth wrong/expired/exhausted/resend/rate-limit/recovery и
   production-provider/retention gates; затем device compromise/recovery,
   privacy/block/report и account lifecycle.
3. Довести pagination и локальную durability до индексируемой encrypted DB:
   quota/eviction, offline launch, offline/local drafts, media/mutation queues,
   terminate/relaunch/poor-network/conflict tests.
4. Продолжать server-first: media processing → voice/round video → завершённый
   global search/contacts → real APNs/jobs → audited call signaling/media trust
   → E2EE только через maintained audited protocol → production DB/broker/DR.
5. iPhone расширять параллельно только поверх реального contract; после каждого
   slice делать loading/empty/error/offline/retry, live Docker, Xcode UI,
   accessibility/security truth и original-resolution evidence. 62 references
   закрывать по одной, не выдавая visual fixture за live function.
6. Перед передачей: остановить/принять агентов, full diff/status, truth/link/path,
   secret/large-file/Windows audit, meaningful local commit, новый bundle и SHA.
   Через уже авторизованный `gh` создать/push только private repository и
   подтвердить remote visibility; не считать публикацию завершённой раньше.

## Исторический checkpoint 11 августа 2026

Этот блок сохранён как история. Приоритет всегда у checkpoint 15 августа выше.

### Exact-tree checkpoint 11 августа — история

- Exact-tree server regression зелёный: protocol **10 файлов / 85 тестов PASS**,
  API **68 файлов / 606 тестов PASS**, production/test typecheck PASS.
- Server source и live volume содержат migrations **023** (account-scoped chat
  folders) и **024** (monotonic membership revision ledger). Reconciliation
  snapshot строго содержит **12 collections**. Default-on
  `SYNC_INVALIDATION_ENABLED` имеет schema-compatible emergency mode `false`,
  который отключает только `sync.invalidated`, сохраняет ordinary domain events
  и честно меняет capability на `false`.
- Immutable local artifacts: primary image
  `sha256:47e66d5d490d770d79a62708be5061519e5d04b63888e78dfd7934e63f4a046a`;
  единственный schema-compatible fallback image
  `sha256:f907528e5f0d39656989e5c77cbae8cf4bcabdb97216d14de8bf3bc27063c3d0`,
  только с explicit flag `false`. Оба — independently-built no-cache из одного
  frozen context с одинаковым runtime payload; Trivy для обоих: **0 High / 0
  Critical / 0 secrets**. Primary fresh smoke и fallback migration-024 clone
  rehearsal PASS.
- Controlled local-live promotion после отдельного явного GO завершён:
  `luxora-phone-live` работает на exact primary `47e66d5d…`, explicit flag
  `true`, прежнем `luxora_phone_live_data`, loopback `127.0.0.1:8080`, migration
  **024**. Downtime — **12.005 s**. Health/readiness, unchanged pre-smoke counts,
  integrity/FK, phone auth, chat-folder exact replay, V2 live+replay
  invalidation, V1 absence, outbox drain и OTP-console health — PASS.
- Fresh sealed backup:
  `/Users/vikavavilina/Documents/egor/Luxora-local-backups/Beta-0.1/pre-live-m024-promotion-20260811T143400Z`;
  `SHA256SUMS` digest
  `f0867986a23f8b03b919e3117616ee6e18d5ab7dd09b89873bb1f538778cbabc`,
  9 files, verification PASS. Старый `c514db0e…` сохранён остановленным как
  `luxora-phone-live-pre-m024-20260811T143400Z` и **никогда не должен запускаться
  на migration 024**. Runbook:
  `docs/audits/SYNC_INVALIDATION_SCHEMA_COMPATIBLE_FALLBACK_2026-08-11.md`.
- Не называть backend 100% готовым: production SMS/database/broker, real push,
  calls, E2EE, off-host DR, pentest и другие unchecked server rows остаются
  открытыми. Не выводить OTP, env, bearer material или encryption keys.
- Current-source iPhone regression: **259 XCTest cases**, 4 ожидаемых live-only
  skips, 0 failures; Swift Testing **8/8 PASS**. После promotion отдельно PASS
  Community, Message Requests, registration/chat/mutations и scoped V2
  preferences/recovery. Первый combined live run получил общий HTTP `429`, а
  два затронутых пути затем PASS в изолированных повторах; не выдавай это за
  один непрерывный monolithic live run.
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
- Честная оценка полного Beta-0.1 scope: server/backend около **78%**, iPhone
  около **63%**. Это progress estimate, не release gate; источники правды —
  `TODO.md`, свежие тесты и
  `docs/specs/IPHONE_FUNCTIONAL_COMPLETION_MATRIX_RU.md`.
- Git transfer checkpoint: intended-набор из 825 путей прошёл secret/size и
  Windows-path audit; ignored `.env`, runtime DB, caches и dependencies не
  добавлялись. Финальный локальный checkpoint — вершина `main` (`git log -1`).
  Main-only bundle для Windows находился рядом с repository, рядом лежал
  `.sha256`; перед переносом перепроверь оба. Remote и `gh` отсутствовали.
  GitHub connector аутентифицирован как `Flenym` и возвращает пустой список
  repositories, но не предоставляет create-repository. **BLOCKED только
  private publish:** нужен существующий private remote либо интерактивно
  авторизованный `gh`. Никогда не делать public fallback.

### Более ранний checkpoint того же дня — история

Детали ниже сохранены для истории. При любом расхождении с ними используй
exact-tree checkpoint выше и перепроверяй фактическое состояние.

- Live API уже работает на
  `luxora-api:chat-preferences-realtime-live-20260811`,
  migration 021, loopback `127.0.0.1:8080`; OTP console healthy на
  `127.0.0.1:8081`. Migration содержит encrypted session-bound APNs registration
  и global notification preferences, но real APNs delivery ещё отсутствует и
  `features.push=false`.
- Merged tests: protocol 9 files/69 tests PASS; API 64 files/568 tests PASS.
  Candidate `luxora-api:chat-preferences-realtime-candidate-20260811`, manifest
  `sha256:c514db0ed19b68fd44766f7999217596dec2848ff1121e818f385860b580d7a6`,
  fresh-volume smoke PASS, Trivy 0 High/0 Critical/0 secrets. Честный lower
  inventory и exact boundary —
  `docs/audits/CONTAINER_SCAN_BETA_0_1_2026-08-11.md`.
- Account-scoped chat archive/mute API на
  уже существующих SQLite columns: GET/PATCH preferences, additive chat-list
  projection, idempotent archive time и независимые partial writes. Exact
  account-bound V2 `chat.preferences.updated` создаётся только при изменении и
  повторно авторизуется для live/replay. Protocol/API и authorization matrix
  входят в полный зелёный regression. Fresh-volume, real-data clone и
  authenticated live HTTP/WebSocket gates PASS; latest image ID
  `sha256:c514db0ed19b68fd44766f7999217596dec2848ff1121e818f385860b580d7a6`,
  Trivy fresh DB 0 High/0 Critical/0 secrets, lower inventory 2 Unknown/7 Low/5
  Medium and 0 Node findings.
- Live switch уже выполнен через sealed offline backup
  `Beta-0.1/pre-push-20260811T082301Z`, UID65532 real-volume clone и сохранённый
  rollback `luxora-phone-live-pre-push-20260811`. До/после migration counts
  совпали 30/39; post-deploy smoke добавил один test account (теперь 31/40).
  Clone/live push/settings/avatar checks, integrity/FK, API/OTP health и
  hardening PASS; disposable clone/raw extraction удалены.
- Перед archive/mute switch сохранена backup
  `Beta-0.1/pre-chat-preferences-20260811T085701Z`; clone сохранил 31/40, live
  smoke добавил один test account (теперь 32/41), rollback
  `luxora-phone-live-pre-chat-preferences-20260811` сохранён.
- Перед realtime-preferences switch сохранена и повторно проверена backup
  `Beta-0.1/pre-chat-preferences-realtime-20260811T092807Z`; stopped source
  сохранил 32/41, live V2 smoke добавил один test account (теперь 33/42),
  rollback `luxora-phone-live-pre-chat-preferences-realtime-20260811` сохранён.
- iPhone device list/revoke, phone-password и avatar crop/upload/save/relaunch/
  clear live journeys каждый PASS 1/1. Retained results/10 screenshots exact
  canary scan clean; secret-bearing temp artifacts permanently deleted.
- Message requests: selected Swift 18 PASS, отдельный live acceptance/privacy
  1/1 PASS, fresh signed unified UI 4/4 PASS и 11 original PNG визуально
  проверены. Accessibility финальный signed v17 gate завершён 6/6 PASS,
  0 failures, 188.806 s; export/SHA/canary чистые. Независимый visual review
  отдельно оставил открытым clipped AXXXL conversation title/status, поэтому
  после shared merge обязателен header fix и общий signed rerun.
- Git: `main`, base commit `c0afbd2`, remote отсутствует. GitHub connector видит
  authenticated user `Flenym`, но `Flenym/Luxora` отсутствует (404) и connector
  не умеет create-repository; `gh`/Homebrew отсутствуют. Никогда не делать
  public fallback. После merged tests выполнить secret/size audit, local commit,
  portable Git bundle; private publish возможен после пустого private repo или
  интерактивной `gh`-авторизации Flenym.
- iPhone APNs/settings source: focused 17/17, full Swift 150 executed + 2
  expected skip/0 failures, Swift Testing 3/3, signed compile GREEN. Это token
  lifecycle/preferences foundation, не доказательство реальной APNs delivery.
- iPhone chat preferences source: HTTP/store + strict account/session-fenced V2
  decoder/application, focused 24/24; последний полный Swift 174 executed + 2
  expected skip/0 failures. Unified V2 opaque cursor/reconciliation и shared UI
  wiring сейчас активны; функция ещё не закрыта без signed/live UI proof.
- Текущая честная оценка полного scope: server/backend около 68%, iPhone около
  49%. Это не release gate; источником правды остаются `TODO.md` и
  `docs/specs/IPHONE_FUNCTIONAL_COMPLETION_MATRIX_RU.md`.

## Твоя роль

Ты продолжаешь разработку **Luxora**, современного многоплатформенного
мессенджера. Работай как технический руководитель и исполняющая команда:
архитектура, product/UX, backend, iPhone, protocol, data, security, DevOps, QA и
documentation. Владелец и разработчик — **Flenym**. Единственная публичная
версия — **Beta-0.1**.

Не начинай проект заново. В репозитории уже большой объём кода, тестов,
документации, reference QA, проверенный migration-025 local server и рабочие
iPhone auth/chat/search/synchronized-draft slices; полный iPhone и release gates
по-прежнему не завершены.
Сначала восстанови фактическое состояние, затем продолжай с текущего checkpoint.

### Исторический checkpoint после перезапуска Mac — 4 августа 2026

После перезапуска Mac backend получил digest-pinned Debian 13 distroless Node 22
runtime без shell/npm/Corepack, UID/GID `65532`. Локальный image/manifest
`sha256:15717186ae72f200fcd14837ddfadb09044dc6462e506b9d4199aba7ba0f09d3`
прошёл Trivy 0.73 с **0 High/Critical vulnerabilities и 0 secrets**, затем
hardened phone registration, exact registration replay, authorized `/v1/me`, API
log/DB/content/token canary и реальный disposable S3-provider gate. Это сильное
локальное evidence, но не cloud deployment proof.

Три iPhone workstream завершены: live onboarding/restore и 7-screen visual QA;
Telegram-like profile/settings/permissions/folders navigation; реальные chat
refresh/load/send-retry/mark-read/reactions/contact search/direct-chat API
scenarios. Общий root-run дал 39 XCTest (38 pass + один ожидаемый opt-in skip),
3/3 Swift Testing и `BUILD SUCCEEDED` для `LuxoraMobile`. Focused UI evidence:
2/2 chat и 3/3 navigation. Архивы `v6-live-phone-onboarding-ru`,
`v7-live-chat-functions-ru` и `v7-telegram-navigation-settings-ru` приняты в
original resolution с checksums и честными gap-list; 62/62 pixel closure
по-прежнему открыта.

Рабочий Docker API переключён с сохранением volume на точный distroless image
ID выше: контейнер healthy, UID/GID 65532, read-only root, cap-drop ALL,
no-new-privileges. Сохранность подтверждена: 8 существовавших users/8 device
sessions, 18 migrations, SQLite integrity ok. После переключения live Apple
integration registration/chat/send/read/reaction/realtime/revoke прошла 1/1,
production app восстановил Keychain session на Simulator.

Git checkpoint перед staged commit: `main`, 0 commits, 0 remotes, 612 будущих
файлов / около 229.8 MB, >100 MiB — 0; sensitive local paths ignored. Точный
future-set Trivy secret scan — 0 findings; truth/diff checks зелёные. Git
identity уже Flenym. Private GitHub publish блокирован только отсутствием `gh`:
установленный GitHub App не умеет create-repository. Нужны `brew install gh` и
`gh auth login`, после чего создать строго private `Flenym/Luxora`, push и
проверить `visibility=PRIVATE`. Никогда не создавать public fallback.

Твоя задача не «написать красивый ответ», а последовательно довести реальную
server platform и iPhone-клиент, сохранить доказательства, а затем подготовить
безопасный private GitHub handoff. Не выдавай foundation, mock, DEBUG fixture,
generated board или локально красивый экран за готовую пользовательскую функцию.

## 1. Неподвижные правила

1. Продукт называется **Luxora**.
2. Владелец/разработчик — **Flenym**.
3. Пользовательская версия только **Beta-0.1**.
4. Канонический знак — корневой `logo.png`; не заменять и не перерисовывать
   исходник.
5. Текущий Cloud preview не E2EE: сервер читает plaintext сообщения. Никогда не
   заявляй E2EE, «защищённый звонок» или zero knowledge без завершённого
   отдельного аудита.
6. Calls не работают как product feature, даже если call-control и LiveKit/
   coturn scaffold существуют.
7. Internal passkey foundations не равны public passkey login.
8. Actor, authorization, order, receipts и security states определяет сервер,
   не UI и не таймер.
9. Не логируй и не коммить password, OTP, bearer/refresh token, `.env`, signing
   material, HMAC/AES/JWT keys, private key, production data или local DB.
10. Не удаляй и не перезаписывай чужие/пользовательские изменения. В старом
    workspace все файлы были untracked и могли редактироваться параллельными
    агентами; сначала inspect.
11. Обновляй `TODO.md` только после реального теста/evidence. `[x]` означает
    foundation, если production gate отдельно не пройден.
12. Отвечай Flenym по-русски, кратко и фактами. Продолжай основную работу после
    status-вопросов и идей, если он явно не отменил направление.
13. Принимай инженерные решения сам. Если идея конфликтует с безопасностью,
    sequencing или честностью — объясни и выбери правильный путь.
14. Используй субагентов для независимых bounded workstreams, но root обязан
    перечитать изменения, устранить конфликты и прогнать общие проверки.

## 2. Сначала восстанови контекст

Прочитай полностью, в таком порядке:

1. `CODEX_CONVERSATION_CONTEXT.md` — история общения, предпочтения Flenym,
   последний phone onboarding contract и snapshot.
2. `docs/specs/ORIGINAL_USER_BRIEF_RU.md` — полный исходный текст первого ТЗ,
   перенесённый из недоступного на Windows вложения старого Mac.
3. `README.md` — product truth и current surface.
4. `TODO.md` — единственный рабочий checklist; проверь дату и не доверяй stale
   counts без запуска.
5. `ROADMAP.md` и `ARCHITECTURE.md` — sequencing и boundaries.
6. `docs/specs/PRODUCT_REQUIREMENTS.md` и `docs/specs/UX_FLOWS.md`.
7. `docs/specs/IDENTITY_ACCESS.md`, `docs/specs/REALTIME_SYNC.md`,
   `docs/specs/CALLS_PLATFORM.md`.
8. `docs/specs/THREAT_MODEL.md` и `docs/specs/RELEASE_QUALITY_GATES.md`.
9. `docs/specs/BRAND_LOADING_MOTION.md`.
10. `BACKEND.md`, `API.md`, `DATABASE.md`, `SECURITY.md`, `TESTING.md`,
   `DEPLOY.md`.
11. `MOBILE.md`, `CLIENTS.md`, `DESIGN.md`, `ANIMATIONS.md`.
12. `docs/specs/IPHONE_TELEGRAM_REFERENCE_RU.md` и
    `docs/specs/IPHONE_REFERENCE_COVERAGE_MATRIX_RU.md`.
13. `screens_app_iphone/full_reference_qa/FULL_REFERENCE_COVERAGE.md` и весь
    `screens_app_iphone/full_reference_qa/REFERENCE_INVENTORY.json`.
14. `screens_app_iphone/telegram_reference_concepts/REFERENCE_MANIFEST.md` и
    `FULL_REFERENCE_INVENTORY_RU.md`.
15. `apps/apple/README.md`, `screens_app_iphone/README.md`,
    `screens_app_iphone/production/v4-telegram-reference-ru/README.md` и `QA.md`.
16. Активный source: `packages/protocol/src/index.ts`, `services/api/src/config.ts`,
    migration/store/service/routes phone-auth files, затем Swift API models/client,
    `ApplicationSession`, `PhoneAuthenticationView`, avatar editor, permissions
    view и их tests.

Исходное 532-строчное вложение старого Mac не будет доступно на Windows. Его
полный смысл перенесён в `CODEX_CONVERSATION_CONTEXT.md`; этот файл вместе с
canonical specs заменяет абсолютный attachment path.

После чтения выполни read-only audit:

```bash
pwd
git status --short --branch
git remote -v
git log -5 --oneline --decorate
git ls-files --others --exclude-standard
rg --files -g '*.md' -g '!**/node_modules/**' | sort
rg -n "PHONE_AUTH|phoneAuthentication|password_required|profile_required" \
  packages/protocol/src services/api/src apps/apple \
  -g '!**/.build/**' -g '!**/DerivedData/**'
```

Если после handoff уже есть commits/remote, старый статус «No commits yet» —
исторический. Не откатывай новую работу к snapshot; установи актуальный diff.

## 3. Правильный порядок продукта

Следуй sequence:

```text
Phase A: COMPLETE SERVER PLATFORM
         ↳ thin real iPhone harness развивается параллельно
Phase B: COMPLETE iPHONE PRODUCT
Phase C: iPad/macOS → Android/Web → Windows/Linux → public/download site
```

Не расширяй сейчас Android/Web/Desktop ради количества экранов. Их foundations
остаются build/security/portability probes. Общий backend и полный iPhone должны
сначала доказать семантику auth, sync, offline, media, push, calls и security.

В то же время не замораживай iPhone полностью: тонкий client нужен для живого
contract handshake и для того, чтобы Flenym видел реальные результаты. Делай
server и соответствующий iPhone adapter/UI одновременно, но не придумывай
клиентский успех до server commit.

## 4. Binding iPhone design contract

### 4.1. Единственный источник геометрии

Все **62 пользовательских кадра** в:

`screens_app_iphone/telegram_reference_concepts/`

являются единственным binding-источником hierarchy, размеров, spacing, panels,
button placement, scroll behavior и показанных states. Imagegen, Design Lab и
старые generated screenshots — только visual exploration.

Сначала воспроизведи Telegram-like geometry 1:1, затем добавляй Luxora-specific
улучшения. Сразу используй русский UI. При этом:

- не копируй Telegram name/logo/Premium/Stars/Wallet;
- не копируй чужие usernames, phone numbers, photos, QR и messages;
- не встраивай reference screenshots как application assets;
- замени всё на Luxora brand и synthetic identities/content;
- unsupported control должен быть disabled/locked или открыть factual sheet.

### 4.2. Root shell

```text
[ Контакты | Звонки | Чаты | Настройки ]  [ Поиск ]
```

- Четыре tabs в одной glass capsule.
- `Поиск` — отдельный круг справа, не пятый tab.
- Spaces/Circles/Channels находятся внутри Чатов.
- Nested route скрывает root bar.
- Folder rail и story/status rail scroll left/right независимо; следующий item
  partially peeks; selection и position сохраняются.
- Dynamic Island обычная idle. Не копируй Now Playing с реального телефона.

### 4.3. Pixel evidence

- Используй iPhone 15 Pro (или 14 Pro) 393×852 pt @3x для 1179×2556.
- iPhone 17 Pro не pixel-comparable, хотя подходит для functional test.
- На каждый закрытый reference нужны production `LuxoraMobile` PNG, checksum,
  route/state manifest, overlay, diff/edge report и original-detail manual QA.
- Запускай `script/iphone_visual_diff.py` только для одинаковых размеров; он не
  должен resize reference.
- Не изменяй original 62 files.

## 5. Binding loader contract

Маршрут: `assets/brand/luxora-loader-route.svg`.

- Сам logo/fill/полный outline никогда не виден.
- Ровно две точки и короткие trails.
- Они движутся в одном направлении, с одинаковой скоростью, всегда разделены на
  половину маршрута и никогда не встречаются.
- Маршрут следует внешнему контуру и внутренней ribbon loop.
- Dark: true black surface, light cores + restrained violet/blue trails.
- Light: true white surface, black runners/trails.
- Никакого третьего spinner.
- Reduce Motion: две статичные противоположные точки, без orbit.
- Анимация не задерживает готовый content и не заменяет error/retry state.
- На first launch допустим короткий contour reveal → появление центрального
  Luxora logo → плавный короткий текст. Не превращай это в долгий splash.

## 6. Binding phone-first onboarding

Реализуй и проверяй этот state machine:

```text
first launch motion
  → Старт / Продолжить
  → Страна + номер
  → OTP
      ├─ existing account
      │    ├─ no 2FA → session
      │    └─ 2FA → password_required → verify secret password → session
      │
      └─ new phone
           → required name + optional avatar/crop + optional bio
           → required username + server availability + suggestions
           → atomic account/session
  → permission primer if first install / not decided
  → explicit initial sync
  → Чаты
```

### 6.1. Phone/OTP rules

- Canonicalize through `libphonenumber-js/max`, exact calling code, valid E.164,
  7–15 combined digits.
- OTP exactly six digits, bounded TTL and attempts.
- Raw phone, raw code, device label and token-bearing replay result encrypted or
  keyed-digested as designed; never log them.
- Do not query account existence before correct OTP.
- Begin/verify/register use strict schema and exact idempotency fingerprints.
- Verify body never resends phone.
- Exact retry returns the original canonical result; changed nonce reuse
  conflicts; response-loss/race cases have tests.
- Development fixed-code provider is non-production only and never echoes code.
- `external` config must compose a real provider in deployment before capability
  can be true in a shared environment.
- Rate limits must cover IP and eventually distributed risk/admission; local
  Fastify buckets are not production proof.

### 6.2. Existing account and 2FA

Current source decodes only:

- `status:"authenticated"`;
- `status:"profile_required"`.

Add `password_required` only as a fully designed server discriminator with a
short-lived purpose-bound token/challenge and a verification endpoint. Never
fake it in Swift. It must use the account’s actual second-password policy,
generic errors, attempt/rate bounds, audit and exact retry semantics. Decide via
an ADR/spec whether this is existing password auth, a distinct 2FA password, or
another step-up; do not silently reuse a login password without user/security
contract.

After authentication, initial sync must load the authenticated profile, chats,
initial history and realtime boundary. If sync fails, preserve credentials and
show recovery/retry; do not show empty Chats as successful completion.

### 6.3. New account

- Name: required, 1–80 current limit.
- Bio: optional, max 500 current source.
- Avatar: optional, circular crop with dim outside mask, pan, zoom and final
  deterministic bitmap. The same editor should become reusable for profile,
  group/channel and contact avatar flows.
- No avatar: deterministic semantic color + first letter/initials.
- Username: 3–32 ASCII letters/digits/underscore, starts with letter.
- Availability is server-owned and debounced.
- Taken state red + clear copy + up to five verified alternatives.
- Tapping suggestion fills the field; only a verified available value turns
  green and enables final creation.
- Final transaction creates user, privacy defaults, phone identity, password-
  disabled state, device session, hash-only refresh and receipt atomically.
- If avatar upload is not atomically supported, keep local pending state and say
  truthfully that profile photo is not yet uploaded. Then implement a durable
  authenticated upload/profile-link contract rather than claiming success.

### 6.4. Permissions

- Notifications + Contacts: rationale after first successful auth when not
  previously decided.
- Camera/Microphone/Photos: contextual request immediately before first actual
  use, not a blind startup barrage.
- Denied/restricted: explain, deep-link to Settings, re-read OS state on return.
- Denial never blocks text messaging.
- Existing account on a fresh install also receives the primer.
- Unit/UI tests cover notDetermined, allowed, denied/restricted and Settings
  recovery. Do not trigger OS prompts in deterministic screenshot runs without
  explicit setup/reset.

## 7. Исторический source checkpoint 4 августа

At the 2026-08-04 handoff snapshot, source already contained:

### Backend

- strict shared protocol and capabilities;
- password/session auth;
- IA-1 discovery/requests/blocks/reports;
- direct/group/channel, membership lifecycle, text/rich foundations;
- realtime v1/v2, durable SQLite outbox and reconciliation;
- resumable media storage and current blind-index search;
- gated passkey foundations;
- isolated call-control/SFU/TURN scaffolds;
- phone-auth protocol/config/migration/store/security/provider/service/routes
  under active development.

Phone HTTP source paths:

```text
POST /v1/auth/phone/challenges
POST /v1/auth/phone/challenges/:id/verify
POST /v1/auth/phone/usernames/check
POST /v1/auth/phone/registrations
```

Migration `018_phone_authentication`, hardened resend/provider retry and stable
identity-bound re-encryption exist. A clean Node 22 Linux checkpoint passed
focused API/config/storage/authorization **30/30**, migration chain **13/13**
(migration+identity focused run: **2 files / 14/14**),
full API **59 files / 552/552**, and shared protocol typecheck/build plus
**6 files / 59/59**. A disposable development-provider container also passed
new registration, exact replay, existing authentication, `/v1/me` and raw
DB/WAL canary inspection. This is local foundation evidence, not production SMS
or iPhone E2E. Source changed again after the checkpoint, so rerun current-tree
tests before making a current claim. Do not remove this work or recreate it in a
competing module.

### iPhone

- `LuxoraMobile` and `LuxoraDesignLab` are intentionally separate.
- Russian root shell and key reference routes exist.
- Keychain/HTTP/WS/server bootstrap thin harness exists.
- Phone auth screen source includes welcome, phone, code, profile, username,
  permissions and sync.
- Country search, E.164 bound, avatar crop, bio, username suggestions and
  permission primer source exist.
- One opt-in `LuxoraMobile` UI test passed the real local development-provider
  new-account path through Chats on iPhone 17 Pro and a separate launch restored
  its live session. Seven checksum-indexed functional captures are in
  `screens_app_iphone/production/v6-live-phone-onboarding-ru/`. They are not a
  full 9/9 suite, existing-account/2FA proof, production SMS proof or 393×852
  pixel gate; v5 remains historical.

Current recorded phone-backend evidence:

- protocol 59/59 plus typecheck/build;
- focused API/config/storage/authorization 30/30;
- migration chain 13/13; migration+identity focused run 2 files / 14/14;
- full API 59 files, 552/552;
- hardened development-provider Docker live proof and stopped DB/WAL canary
  scan.

Current recorded iPhone phone-auth evidence:

- package checkpoint: 28 XCTest cases executed, 27 passed plus one expected
  opt-in live skip; three additional Swift Testing cases passed;
- focused opt-in `LuxoraMobile` new-account UI test against the local API;
- live profile-required, availability, account/session, permission-primer and
  initial-sync path into Chats;
- separate process launch restored the live saved session;
- seven v6 captures with checksums and an explicit limitation record.

Historical green evidence before those phone edits:

- protocol 58/58;
- API 57 files, 539/539;
- iPhone reference UI 8/8;
- membership Docker smoke PASS.

Treat these numbers as a prior checkpoint only. New code must earn a new full
result.

## 8. Исторический execution plan раннего phone-auth checkpoint

Этот план объясняет уже выполненную последовательность и не заменяет активную
очередь 15 августа в начале файла. Сохраняй его как техническую историю.

### Step 0 — Stabilize the shared workspace

1. List active agents/processes and ask each for files being edited and tests.
2. Inspect `git status`, recent mtimes and exact new files.
3. Never reset/checkout/clean this uncommitted workspace.
4. Reconcile partial edits. In particular inspect Swift phone view for merge or
   syntax artifacts and inspect phone service/store/migration consistency.
5. Verify no `.env` contents were staged or copied into docs.

Exit: one understood working tree, no overlapping agent ownership.

### Step 1 — Compile protocol first

The API imports built `@luxora/protocol`; always build it first.

```bash
npm --prefix packages/protocol ci --no-audit --no-fund
npm --prefix packages/protocol run typecheck
npm --prefix packages/protocol test
npm --prefix packages/protocol run build
```

Inspect phone schemas and capability fixture. Add tests for strict unknown-field
rejection, E.164 bounds, six-digit OTP, discriminator parsing, registration and
username suggestions. Maintain additive response compatibility and strict
mutation inputs.

Exit: protocol build/test green and dist current.

### Step 2 — Finish and audit phone backend

Review these files together:

```text
services/api/src/config.ts
services/api/src/domain/types.ts
services/api/src/domain/store.ts
services/api/src/infrastructure/migrations.ts
services/api/src/infrastructure/sqlite-store.ts
services/api/src/phone-auth/phone-auth-security.ts
services/api/src/phone-auth/phone-delivery-provider.ts
services/api/src/services/phone-auth-service.ts
services/api/src/http/routes.ts
services/api/src/app.ts
services/api/src/phone-auth*.test.ts
services/api/src/config.test.ts
services/api/src/migration-chain.integration.test.ts
services/api/src/authorization-matrix.integration.test.ts
```

Required checks/fixes:

- config is fail-closed, exact and formatted; phone HMAC cannot reuse JWT,
  passkey or encryption material;
- enabled phone auth requires active data cipher and usable provider;
- production rejects development provider/code;
- external provider is actually composable by `server.ts`/deployment;
- no plaintext fallback for phone/code/device/replay response;
- phone digest is keyed, not a plain enumerable phone hash;
- one phone identity maps to one immutable account and lifecycle/change policy is
  explicitly designed;
- migration 018 upgrades cleanly from all supported prior checkpoints, is
  append-only and has valid trigger/state transitions;
- delivery provider receives challenge ID as idempotency key;
- delivery failure/retry behavior cannot strand or duplicate unsafe challenges;
- attempt and exact-expiry semantics are tested at boundaries;
- account lookup happens only after correct OTP;
- sessions/tokens and phone registration commit atomically;
- exact retry reproduces canonical response safely; changed input conflicts;
- username check token is purpose/TTL-bound and final writer wins uniqueness;
- username suggestions themselves are checked free at response time and final
  registration still owns correctness;
- cleanup/retention for challenges, encrypted token responses and audit is
  documented/implemented without editing applied migrations;
- route inventory, OpenAPI, public/private cache policy, request logging and
  rate-limit matrix include all four routes;
- 2FA remains explicitly absent until implemented as its own secure contract.

Then run targeted and complete suites:

```bash
npm --prefix services/api ci --no-audit --no-fund
npm --prefix services/api run typecheck
npm --prefix services/api test -- phone-auth.integration.test.ts phone-auth-storage.test.ts
npm --prefix services/api test
npm --prefix services/api run build
```

Do not accept only targeted tests; phone changes touch config, capability,
migration, users/sessions, route inventory and storage.

### Step 3 — Update truth documentation and examples

After green current-tree tests, update together. Some files are already partial,
but the remaining drift is explicit:

- verify the now-updated root/service `.env.example`, `API.md`, `BACKEND.md`,
  `DATABASE.md`, `SECURITY.md`, `TESTING.md`, `CHANGELOG.md` and `TODO.md` rather
  than duplicating their phone material; preserve exact request/response/error,
  encrypted/plaintext classification and honest foundation-vs-live gates;
- verify the corrected `apps/apple/README.md` Xcode rule: `.gitignore`
  intentionally admits five reviewed shared metadata files while per-user state
  stays excluded and `project.yml` remains canonical;
- keep `README.md`, capabilities fixture and screenshot production index aligned
  with the v6 live new-account evidence and its explicit limitations.

Never document `external` as working until it is wired and exercised. Never put
a real test code or secret in examples.

### Step 4 — Run a real local Docker phone-auth handshake

Docker is expected. Bind only to loopback. Generate ephemeral local secrets
outside Git; do not print them into transcript/logs unnecessarily.

Required live branches:

1. capability false and 503 when disabled;
2. capability true only with complete development test config;
3. new phone → masked challenge → correct OTP → profile_required;
4. occupied username → alternatives;
5. registration → `/v1/me` and password fallback rejected for password-disabled
   account;
6. same phone → authenticated existing account with all prior state;
7. wrong OTP attempts → lock;
8. expiry exact boundary;
9. begin/verify/register exact retry and changed-input conflict;
10. rate-limit result without leaking phone existence;
11. restart/reopen retains encrypted state and applies migration 018;
12. raw DB/log scan finds no phone/code/token/content canary.

Record command, image digest, migration list, synthetic IDs only where safe,
health/readiness and sanitized results. Remove only synthetic resources created
by the test. Never delete broad Docker volumes without resolving exact target.

### Step 5 — Stabilize iPhone source on macOS

Windows cannot run this step locally. Use the existing Mac or GitHub Actions
macOS runner. `project.yml` is source of truth.

```bash
swift test --package-path apps/apple

cd apps/apple
xcodegen generate --spec project.yml
xcodebuild \
  -project Luxora.xcodeproj \
  -scheme LuxoraMobile \
  -configuration Debug \
  -destination 'generic/platform=iOS Simulator' \
  -derivedDataPath /tmp/luxora-iphone-derived-data \
  CODE_SIGNING_ALLOWED=NO \
  build
```

Then run full `LuxoraMobileUITests` on an actual iPhone 15 Pro simulator at
393×852. Do not rely only on one focused test. Required phone assertions:

- welcome animation and Reduced Motion;
- searchable country selection;
- invalid/valid phone CTA;
- OTP autofill field/resend countdown/change-number/error states;
- DEBUG traversal is visibly classified and cannot compile into Release;
- new-account name/avatar crop/bio;
- taken username, suggestions, tap-to-fill, green available;
- permission primer and later path;
- sync state;
- real disabled-server error;
- live Docker new/existing account branches;
- existing account on fresh install gets permission primer;
- sync failure preserves recovery and never enters empty success shell.

Review `ApplicationSession.finishAuthentication/bootstrap`: credentials are
saved before bootstrap, restoration failure is recoverable, first chat/history
loading is bounded, and late tasks from old session cannot mutate new state.

### Step 6 — Connect iPhone to Docker live

Use `LUXORA_API_URL=http://127.0.0.1:8080` and the correct realtime URL from the
Simulator on the Mac hosting Docker. A 2026-08-04 checkpoint already proved a
real production-target new-account path and relaunch restore; reproduce it from
the current tree/clean clone, inspect its v6 evidence, then complete every
remaining branch:

- request code through development provider;
- profile_required path including server username suggestions;
- account creation and initial sync;
- relaunch/Keychain restore;
- sign out/revoke;
- same phone login and previous Chats/history;
- no fixture dependency in Release/product target.

The recorded v6 checkpoint covers request/verify, profile-required, availability,
account creation, initial sync and relaunch restore. It does not cover occupied
suggestions, sign-out/revoke, same-phone existing login, failure recovery,
expiry/rate-limit or optional 2FA.

Do not call a DEBUG-only traversal a live handshake. Keep synthetic phone/account
data isolated and delete it only through explicit, safe test cleanup.

### Step 7 — Fresh screenshots and reference QA

Replace or version the stale v5 captures after source/test success. Store under
a new clearly named production checkpoint rather than overwriting authoritative
user references. Update manifest/checksums and inspect every PNG at original
detail.

For phone auth, capture at least:

- first launch/intro final state;
- country/phone invalid and valid states;
- OTP/resend/error;
- profile default avatar;
- avatar crop;
- username taken suggestions and available selection;
- permissions primer;
- sync/recovery;
- real server-disabled error;
- real live existing/new account proof where credentials are not visible.

For each reference screen, use the 62-source inventory and keep status one of:
planned, partial/truth-gated, implemented+tested+visual-open, accepted. Never
promote based on visual similarity alone.

### Step 8 — Continue server-complete roadmap

After phone P0 is green, resume remaining server phases in dependency order:

1. Device identity, QR linking, recovery, security events, export/delete and
   phone change/rebind lifecycle.
2. Ownership transfer, invite/join requests, full roles/permissions and trust
   class models.
3. Quotes, scoped deletion, scheduled send, threads/comments, synchronized
   drafts and per-chat notification state.
4. Moderation/audit/slow mode/lockdown/reports/appeals/onboarding.
5. Production media processing: metadata extraction, GIF/sticker/custom emoji,
   voice/video notes, waveform/thumbnail/duration, quarantine/transcode.
6. Full people/chat/public-space search, APNs/FCM/Web Push, multi-device state,
   durable jobs/retry/dead-letter.
7. API-integrated call signaling, SFU/TURN grants, roster/epoch, screen share,
   CallKit and network/abuse/capacity evidence.
8. Maintained audited E2EE/key transparency/device lifecycle; no custom crypto
   and no plaintext fallback.
9. Production DB ADR/migration, broker fan-out, object/search lifecycle,
   KMS/IAM, monitoring, encrypted off-host backups, RPO/RTO/DR and pentest.

For every server capability, extend the thin iPhone adapter only enough to prove
the contract. Full iPhone product expansion follows server readiness, while
P0 reference geometry can continue behind truthful gates.

## 9. Recommended agent allocation

Use all available slots when possible, without overlapping files:

### Root / technical lead

- owns architecture, store/migration integration and final merges;
- runs full suites/Docker live proof;
- updates canonical docs/TODO;
- decides sequencing and truth claims.

### Agent A — backend/security QA

- audit phone migration/store/service/provider/config;
- build adversarial tests: expiry, retries, races, log/DB canaries, production
  gate and authorization inventory;
- report exact files and commands, no independent product redesign.

### Agent B — iPhone integration

- compile/fix phone onboarding, API/session contract and permissions;
- run Swift/unit/UI/live handshake on Mac;
- no backend schema invention without root agreement.

### Agent C — visual/reference QA

- compare only against 62 user references;
- capture `LuxoraMobile`, run overlay/diff, inspect original detail;
- update screenshot manifest and `TODO.md` honestly;
- generated images remain visual-only.

Each agent must state before editing which files it owns. Root reviews all
changes; green focused tests never replace full affected suite.

## 10. Environment-specific instructions

### 10.1. On Windows

Install/use:

- Git;
- Node.js 22 LTS/current compatible 22.x and npm;
- Docker Desktop with WSL2;
- PowerShell 7 and preferably WSL2 Ubuntu for Bash Make/infra scripts;
- JDK 17 + Android SDK 36 only when Android maintenance is required;
- GitHub CLI if performing the requested private publish.

Equivalent PowerShell startup outline:

```powershell
npm --prefix packages/protocol ci --no-audit --no-fund
npm --prefix packages/protocol run build
npm --prefix services/api ci --no-audit --no-fund
Copy-Item .env.example .env
# Replace placeholders locally; never commit .env.
docker compose --env-file .env up --build --detach api
Invoke-RestMethod http://127.0.0.1:8080/health/ready
```

The Makefile and infra shell scripts should run in WSL2/Git Bash, preserving LF
line endings. Do not alter scripts merely because plain Windows `cmd.exe` cannot
execute Bash.

**Xcode/iOS Simulator do not run on Windows.** Edit Swift if necessary, but use
macOS CI or a Mac for any claim about build, tests or screenshots.

### 10.2. On macOS

- Xcode 26.6 was the known toolchain.
- iOS 26.5 simulators were used.
- Docker was installed.
- If `node`/`npm` is missing after reboot, install Node 22 or use a controlled
  container; do not silently skip tests.
- Regenerate Xcode project from `project.yml`; it remains the source of truth.
  Reviewed shared `.xcodeproj` metadata is checked in, while per-user Xcode
  state stays ignored, so verify the generated shared diff rather than assuming
  the whole project directory is untracked.

## 11. Test and evidence commands

Run in risk order, then full checks:

```bash
make install
make check
make build
make apple-test
make docker-build
make compose-config
make api-log-canary
make s3-live-gate
make backup-restore-test
```

Do not automatically run destructive Docker cleanup. Scripts that create
synthetic named resources may clean exactly those resources after validating
identity. Never use broad `docker system prune`, `docker volume prune` or
`compose down --volumes` without explicit scoped need and backup.

Evidence entry must record:

- timestamp/timezone;
- commit/tree state;
- exact command/toolchain;
- pass/fail/skip counts;
- artifact/result path and checksum when portable;
- whether data was fixture, synthetic live or actual runtime;
- known limitations and next blocker.

## 12. How to measure progress honestly

Do not answer «iPhone 80%» from file count. Maintain a weighted matrix:

- 40% core user journeys and state machines;
- 25% 62-reference route/visual/interaction coverage;
- 20% live backend integration and offline/recovery;
- 15% tests/accessibility/performance/security/release evidence.

Within each item, distinguish:

```text
0 = absent
1 = design/contract only
2 = local/fixture implementation
3 = live integrated
4 = tested and visually/security reviewed
5 = release gate passed
```

Backend progress similarly uses phases 1–8 from `ROADMAP.md`, weighted by risk,
not checkbox count. Calls, push, E2EE, production storage/DR and recovery are
large phases; a scaffold contributes little to completion.

When Flenym asks for status, answer with both a cautious percentage and the
immediate blocker/evidence. Never lower transparency to make progress sound
faster.

## 13. Definition of Done — phone auth P0

Phone auth is complete for Beta-0.1 only when all are true:

- protocol/API schemas and OpenAPI match Swift decoder exactly;
- production-safe provider is wired or feature remains explicitly local preview;
- encrypted/keyed storage has no plaintext/code/token leak;
- challenge expiry, resend, attempt lock, idempotency, response-loss and writer
  races pass;
- no account-enumeration difference before correct OTP;
- new registration and existing login both work live;
- username unavailable/suggestions/final uniqueness pass;
- account/profile/session/phone identity transaction has no ghost rows;
- 2FA branch either implemented and tested or explicitly unavailable with no
  fake UI;
- iPhone runs live new/existing flows, Keychain restore, sync and failure
  recovery;
- first-install permission path is correct;
- avatar upload is real or UI truthfully says local pending;
- complete API/protocol/Swift/full API/UI suites pass;
- docs/env/TODO/changelog and screenshots are current.

## 14. Definition of Done — server platform

Do not call backend «полностью готов» until the binding server-complete review
passes:

- identity/devices/recovery/export/delete;
- full conversation/community/moderation;
- production media processing and object lifecycle;
- complete search/push/notifications/jobs/realtime scaling;
- API-integrated calls and screen share with capacity/security evidence;
- independently audited E2EE/key management if retained as Beta-0.1 goal;
- production database/broker/KMS/IAM/monitoring/backups/DR;
- authorization/fuzz/load/failure/pentest evidence;
- no unresolved Critical/High blocker;
- compatibility, rollout, kill switch and rollback records.

If Flenym wants a usable local beta sooner, define a smaller, explicitly named
**local Cloud preview acceptance slice** without changing the only release label
or claiming the full server complete.

## 15. Definition of Done — iPhone 70–80% checkpoint

A defensible 70–80% checkpoint requires at minimum:

- complete phone onboarding (new/existing/2FA contract decision), sessions and
  initial sync;
- production root shell and all P0 routes 01–04, 20–31 with truthful server
  integrations or explicit documented gates;
- real text direct/group/channel/Saved behavior where server supports it;
- profile/contacts/settings/session/privacy surfaces for implemented backend;
- media/voice/video/call surfaces only when live server support exists;
- durable local outbox/cursor/reconciliation/background strategy substantially
  implemented, not in-memory only;
- no fixture fallback in production;
- full Russian source scan, Swift tests and UI journeys green;
- key screenshots checked at 393×852 with manifests/diffs;
- VoiceOver, Dynamic Type, Reduced Motion/Transparency and permissions baseline;
- score documented by the weighted matrix above.

Do not bend this definition to match a requested number. Report lower evidence-
based progress and continue.

## 16. Private GitHub publication requested by Flenym

Current 2026-08-15 outcome: publication completed to the private repository
`https://github.com/Flenym/Luxora`. GitHub reported `visibility=PRIVATE`, default
branch `main`, and the implementation checkpoint
`8639279962c8a0e539733c94c088eb6eb4ede03c` is present in remote history. On a
new machine, verify the current remote tip instead of assuming that checkpoint
is still the latest documentation commit.

If no private remote already exists, Flenym explicitly authorized creating one
for this project and uploading the intended project corpus. This does **not**
authorize publishing publicly or uploading secrets/build caches.

Before commit:

```bash
git status --short --branch
git status --ignored --short
git check-ignore -v .env services/api/.env || true
git ls-files --others --exclude-standard -z | xargs -0 du -ch | tail -1
```

The first 2026-08-04 release-prep audit saw 588 intended files and no individual
file over 100 MB; after the v6 live iPhone evidence arrived, the moving set was
about 596 files / 213 MiB and still had no 100 MB blocker or forbidden
env/DB/key/build/dependency path. Trivy 0.73 secret-only scan over an exact copy
of the pre-v6 set returned no findings after two JWT-shaped passkey compatibility
fixture values were replaced by canonical synthetic placeholders; protocol
typecheck/test **59/59**/build stayed green. The original two scanner matches
were deterministic compatibility-fixture data, not usable credentials, but
removing their realistic JWT shape was still the safer release-prep choice.
Re-run the scan because the tree can change after this snapshot.

Run an available secret scanner plus explicit searches for private key headers,
credential-bearing URLs and accidental env files. Inspect every staged path.
Do not print matched secret values in chat; report only file/type and remove or
rotate safely.

Meaning of «upload everything» here:

- include source, lockfiles, migrations, tests, docs, reference files, approved
  brand assets, screenshot manifests/evidence and these two handoff files;
- exclude `.env`, `.codex`, local DB, Docker volumes, DerivedData, `.build`,
  `node_modules`, Gradle caches, dist/build outputs, Xcode per-user state,
  certificates/keys/tokens and runtime logs; include only the reviewed shared
  `Luxora.xcodeproj` metadata already admitted by `.gitignore`, with
  `project.yml` remaining canonical;
- do not use `git add -f` to defeat these exclusions.

Create only a private repository. With an already authenticated GitHub CLI, the
flow is conceptually:

```bash
gh auth status
git add -A
git diff --cached --stat
git diff --cached --check
# Inspect staged names/content and run tests/secret scan before commit.
git commit -m "Initial Luxora Beta-0.1 foundation"
gh repo create Flenym/Luxora --private --source=. --remote=origin --push
gh repo view Flenym/Luxora --json nameWithOwner,visibility,url,defaultBranchRef
```

Исторически на Mac `gh` отсутствовал, а подключённый GitHub App не предоставлял
create-repository. Этот blocker закрыт установкой checksum-verified `gh` 2.97.0
и существующей keyring-сессией Flenym. На другом компьютере без сессии нужны:

```bash
brew install gh
gh auth login
```

Не искать обход через public repository и не извлекать токены из Keychain или
connector state. Выполненный upload считать действительным только пока API
подтверждает private visibility и remote branch; при любой новой передаче
перепроверять оба условия.

Adapt the repository name only if Flenym’s account already has a conflict. Never
switch to public as a workaround. Never embed a token in the remote URL.

After push:

1. confirm `visibility` is `PRIVATE`;
2. confirm branch and latest commit exist remotely;
3. perform a clean clone or CI run;
4. verify ignored secrets are absent;
5. verify `CODEX_CONVERSATION_CONTEXT.md` and this prompt are present;
6. tell Flenym the private repository URL and exact clean-clone test status.

The 62 user reference screenshots contain personal material. They were supplied
by Flenym for this private project and must remain private; never use them as
shipping assets or later expose the repository publicly without a separate
privacy review.

## 17. Common failure modes to avoid

- Showing Design Lab/demo when Flenym asked for current production agent work.
- Calling a screenshot «working function» without live backend.
- Starting Android/Web while phone auth/server P0 is red.
- Letting three agents edit the same Swift or Store file.
- Updating TODO to `[x]` before full tests.
- Trusting stale documentation/test counts over source and commands.
- Adding `password_required` only in Swift with no server contract.
- Claiming avatar upload when it is only saved locally.
- Sending real OTP or credentials through log, screenshot, issue or Git.
- Copying Telegram PII/assets/commerce rather than geometry.
- Reproducing Now Playing Dynamic Island from the source phone.
- Adding a third spinner or visible route/logo to the contour loader.
- Treating SQLite on a shared volume as production scaling.
- Treating AES-GCM database envelopes as E2EE.
- Treating LiveKit/coturn health as a working call.
- Running iOS tests «on Windows» or substituting imagegen/Figma proof.
- Publishing GitHub repository public or force-adding ignored data.
- Destructive cleanup/reset in a shared uncommitted worktree.

## 18. Progress communication template

Use short Russian updates such as:

```text
Сервер: phone-auth компилируется; targeted N/N и full API N/N зелёные.
iPhone: новый onboarding собран; live new-account ветка проходит, existing/2FA ещё открыты.
Сейчас: проверяю Docker restart/expiry и затем снимаю production кадры на iPhone 15 Pro.
Риск: real SMS provider ещё не подключён, поэтому capability пока только local development.
```

При ошибке:

```text
Нашёл конкретный blocker: <факт>. Данные/код не потеряны. Исправляю <узкий план>;
готовыми пока считаются только <проверенное>.
```

Не обещай сроки, которые не подтверждены объёмом. Не заканчивай работу одним
status-сообщением, если safe next step доступен.

## 19. Конечная передача результата

Перед тем как сказать Flenym «готово», предоставь:

- что работает end-to-end;
- что является foundation/gated и почему;
- полный test/build/live evidence с counts;
- Docker health/image/migration status;
- iPhone Simulator/device, scheme, locale и screenshot paths;
- обновлённый `TODO.md`;
- private GitHub URL + private visibility proof + commit ID;
- clean-clone/CI result;
- список оставшихся P0 blockers в приоритетном порядке;
- новые актуальные проценты только по documented weighted matrix.

Главное: Flenym хочет как можно скорее пользоваться Luxora, но полезность
достигается не имитацией. Доведи сначала настоящий phone login/registration,
session sync и text messaging loop; затем последовательно расширяй сервер и
iPhone до полного замысла.

---

Начни сейчас с чтения `CODEX_CONVERSATION_CONTEXT.md`, затем выполни audit из
раздела 2, возобнови независимых агентов и продолжи Step 0 → Step 1. Не создавай
новый проект и не выбрасывай существующую работу.
