# Luxora — PROJECT STATE (autonomous development mode)

**Обновлено:** 2026-09-20 · calls call-list DONE локально (uncommitted); iPhone DeviceLinkStore + client + фиксы (CI PASS все), containment (`bfd1f44`, CI PASS оба); API 101/739 зелёный локально
**Владелец:** Flenym · **Релиз:** Beta-0.1 · **Режим:** AUTONOMOUS DEVELOPMENT MODE (не останавливаться, не спрашивать)

## Текущая архитектура

- **Backend:** Node 22 Fastify API (`services/api`), SQLite WAL + строгие миграции (последняя `043_device_link_step_up`), V2 realtime outbox, capability negotiation, 12-collection reconciliation snapshot. Шифрование at-rest для секретов; сервер технически может читать сообщения — **это не E2EE** (честно зафиксировано).
- **Protocol:** `@luxora/protocol` — строгие zod-контракты (17 файлов / 104 теста).
- **iPhone:** Swift 6 `LuxoraKit` + `LuxoraMobile`, Keychain-сессии, серверные stores, DEBUG-фикстуры только для геометрии.
- **Проверено:** API 87 файлов / 689 тестов PASS (локально Windows), protocol 17/104, оба typecheck PASS. CI: по пушу `8b0b665` оба воркфлоу PASS (Node/Web/Desktop 4m9s, Security 3m27s).

## Что работает (end-to-end, с тестами)

Auth (register/login/refresh/sessions, phone OTP + password + recovery + binding, profile/patch/avatar), директы/группы/каналы + membership lifecycle (add/role/remove, revision ledger 024), invite-ссылки 032 + approval-очередь 033 (union join, approve/deny, realtime fan-out), message requests + block/report, текст/reply/edit/delete/forward/pin/reaction/receipts, папки 023, архив/мьют, черновики 025, отложенные 029, транскрипты 027–028, privacy policies 030, уведомления-категории 031 + APNs registration (без реальной доставки), global/people search foundations, cursor pagination везде, admin console read-only.

## Что частично работает

- **Voice:** запись/плеер/waveform UI есть; сервер хранит как attachments + transcription consent. Сквозной QA неполный.
- **Media:** raw upload/storage/download; нет processing (thumbnails/transcode/scan pipeline только заявлен флагами).
- **Privacy/blocks UI:** сервер полный; iPhone — список blocked + базовые экраны, полных edit/report flows нет.
- **Search:** people/messages/files foundations + UI; нет global catalog pagination и offline-индекса.
- **Realtime multi-device:** V2 outbox + fences работают; полных poor-network/process-death доказательств нет.
- **Calls:** только изолированный call-control/SFU-TURN domain; signaling и UI отсутствуют.
- **Web/Desktop/Android:** клиенты существуют, но не являются текущим фокусом; backend универсален.

## Что не работает / заблокировано внешними ресурсами

- Production SMS-провайдер, real APNs-доставка, E2EE (явно FUTURE, сервер читает данные), distribution/production-DB доказательства, real-device/release gates, TestFlight/подпись.

## Известные truth-хвосты (чинить немедленно, не откладывать)

- TODO-блокер «simulated call/E2EE/delivery/presence/download/sync UI» — аудит ниже.
- Матрица `IPHONE_FUNCTIONAL_COMPLETION_MATRIX_RU.md` частично устарела (миграции 025→032, счётчики тестов).

## Последние изменения

- Calls call-list DONE локально (uncommitted): `GET /v1/calls?chatId=` → `{calls: CallResponse[]}` (`updated_at` DESC, max 50, включая ended), `calls-signaling` 9/9, матрица 118→119, полный API 101/740, без миграции.
- iPhone DeviceLinkStore (`c75948c` + фиксы `d4538a1`/`ca8c043`, CI PASS все incl. Apple): state machine idle→creating→waiting→approved/denied/expired/closed/failed, polling-цикл с generation-fence, QR-контент, Swift-тесты сходимости/отмены/сессии.

- iPhone device-link API client DONE (локально, uncommitted, проверит Apple CI): `APIDeviceLinkChallenge/Status` + 6 методов клиента (create/poll/close/approve/deny/redeem) + contract-тесты путей/тел/декода; сервер без изменений.
- iPhone terminate-others (`b123d4f` + фиксы, CI PASS все incl. Apple): `containOtherSessions` (`POST /v1/security/containment`), `terminateOtherSessions` в store, кнопка + диалог + состояние во view, Swift-тесты store + contract.

- Security containment DONE локально (uncommitted): `POST /v1/security/containment` (session|all_other_sessions|account, 10/min, без миграции), account гасит все сессии + экспорты + push, realtime best-effort, `recovery_takeover` не принимается; `containment.integration` 3/3, typechecks clean, матрица 117→118, полный API 101/739; остаток — authenticator suspension + security epoch.
- iPhone search-chats wiring (`8361e62` + фикс `d12f49c`, CI PASS все incl. Apple): `GlobalChatSearchResult` + `searchChatsPage` (`/v1/search/chats`) + chats/channels loaders с kind-фильтром (paging/dedup/cursor-fail-closed), строки + счётчики во view, Swift-тесты; сервер без изменений. Плюс правка матрицы set Cu (Search/Calls/Devices rows).

- QR device-link slice 4 passkey-ceremony step-up (DONE локально, uncommitted): миграция `043` (`device_link_step_up_intents`+`device_link_step_up_grants`), `beginStepUp device-link.approve`+`linkId` (`targetDigest` account/session/linkId; unknown/non-pending → `404`/`409`), JWT purpose `device-link.approve`, approval password XOR ceremony (JWT + grant bindings link/account/session/device/digest/TTL/session-live, затем CAS; replay → `409`); тесты stepup 2/2 + integration 8/8, оба typecheck + protocol build clean, матрица без изменений, полный API 100/736; generic-grant routing proven (no stray rows); остаток — E2E гранта, history bootstrap, contact discovery БЕЗ upload, QA.
- QA-слайс в работе (uncommitted): log-leak canaries для linkSecret/webhook-auth в `request-logging.test.ts`; верификация счётчиков/матрицы/capabilities/дрейфа доков.
- QR device-link slice 3 redemption (`42dd53c`, CI PASS все 4): миграция `042_device_link_redemption`, redeem `201 {tokens}` (possession-proof, approved-only, CAS approved→consumed, session via TokenSecurity+createSession, `sync.invalidated` всем сессиям), `device-links.integration` 7/7, typechecks clean, матрица 116→117; остаток — E2E гранта, passkey step-up альтернатива, Private-history bootstrap, затем contact discovery БЕЗ upload, затем QA.
- QR device-link slice 2b password step-up (`936e1a5`, CI PASS оба): approve требует `{linkSecret?, password}` via `DeviceLinkApproveRequestSchema` (нет пароля → `400`, неверный → `403`; сверка с хешем аппрувера + dummy-timing guard + `passwordAuthEnabled` + live-session check, затем CAS-decide), deny без изменений, SAS из COMMITTED-записи (approve-ответ и poll таргета совпадают), HONESTY LIMIT knowledge-factor (НЕ phishing-resistant), transaction-bound (linkId+approver+session до CAS), passkey-ceremony step-up — плановый апгрейд до шипа; тесты `device-links.integration` 5/5 + `device-link-service.test` 2/2, API typecheck clean, полный API 99/731; остаток — slice 3 (выполнен в `42dd53c`).
- QR device-link slice 2 approval (`be4faa9`, CI PASS оба): миграция `041_device_link_approval` (`approved_by_account_id`), `POST /v1/device-links/challenges/:id/approve|deny` (bearer approver + linkSecret; pending→approved/denied, non-pending 409, expired lazy-expire 409, unknown/wrong 401 identical), SAS 4 слова из 256-word списка (`sha256(luxora-device-link-sas-v1:secretHash:approverId)`) в approve-ответе и poll таргета (approver id не раскрывается), HONESTY LIMIT step-up НЕ enforced (закрыт в `936e1a5`), матрица 114→116, `device-link-service.test` 2/2 + `device-links.integration` 5/5, typechecks clean.
- QR device-link slice 1 (challenge lifecycle) (`d03d6fe`, CI PASS оба): миграция `040_device_link_challenges`, `DeviceLinkService` create/poll/close (linkSecret once, +120s/2s/429, digest-only, sweeper 10-мин), `device-links.integration` 3/3, матрица 112→114, typechecks clean, инвентаризации 040.
- Conversation search (`57a801f`, CI PASS оба): `GET /v1/search/chats` (substring по titles групп/каналов, только текущие memberships, `updated_at` DESC + cursor `limit+1`/garbage `400`, plaintext titles без blind index, экранированные wildcards, ASCII `NOCASE`, директы исключены), без миграции/protocol-изменений (`q 1..80`), матрица 111→112, `search-chats.integration` 2/2, typecheck clean; остаток — Unicode-folding, SPC-007 public catalog, offline-индекс, iPhone scope local-only.
- Calls signaling slice 7 stale sweeper (`27bb510`, CI PASS оба): `sweepStaleReconnecting` (`network-timeout`, 10-мин timer, без routes/migration, матрица 111), `calls-reconnect-sweeper.integration` 1/1, typecheck clean; остаток — push-доставка.
- Calls signaling slice 6 membership hook (`5d70e36`, CI PASS оба): `onMemberRemoved`→`reconcileMembership` (`membership_removed`, epoch bump, host `ending→ended`), без routes/migration (111), `calls-signaling.integration` 8/8, typecheck clean.
- Calls signaling slice 5 webhooks (`e3d2ef8`, CI PASS все 4): `POST /v1/internal/calls/livekit-webhook` (LiveKit JWT/raw-body, issuer==API key, 401 на подделку), миграция `039_call_room_index`, dispatch joined/left/aborted/finished, ack `200 {received:true}`, матрица 110→111, тесты 4/4 + 2/2.
- Calls signaling slice 4 join-grants (`6f99edf`, CI PASS оба): `POST /v1/calls/:id/join-grant` LiveKit HS256 JWT 120s + coturn REST 300s, rechecks membership/relationship/block/session/epoch, 503-gate до полного LiveKit+TURN конфига, секреты вне responses/logs, `calls:false`, матрица 109→110, `calls-join-grant.integration` 4/4, typechecks clean.
- Calls signaling slice 3 (`c31f644`, CI PASS оба): `POST /v1/calls/:id/invite` host-only/group-only, member/block/session guards, `InviteCallParticipantRequestSchema`, матрица 108→109.
- Calls signaling slice 2 (`2076c9b`, CI PASS оба): групповые звонки, `POST .../ring|accept|decline`, convergent re-ring, `unreachableMemberIds`, матрица 105→108, `calls-signaling.integration` 5/5.
- Calls signaling first slice + Docker fix (`5b1d2f8` + `7c4552f`, CI PASS оба): миграция `038_call_control_records`, `CallService` поверх `@luxora/call-control` executor + SQLite-адаптер, маршруты create/get/cancel/hangup, `calls-signaling.integration` 3/3, auth-матрица 101→105.
- WAV duration verification (`b873747`, CI PASS оба): pure-TS `measureWavDuration` (RIFF walk, PCM/float/extensible), `complete()` для `audio`/`voice` + `audio/wav` принимает измеренный durationMs + `server_verified`, остальной audio/waveform честно `client_declared`; тесты 4/4 + 1/1 (5000ms claim → 1000ms measured), API typecheck clean.
- Image thumbnails (`8bae86a`, CI PASS оба воркфлоу: Node/Web/Desktop 4m27s, Security 2m31s, 89/698): sharp-JPEG 320px q80 в `complete()` для image >320px (best-effort), `GET /v1/attachments/:id/thumbnail` owner-or-granted (stranger 404/anonymous 401, no-store), protocol `thumbnailPath?` + `thumbnail{sha256,sizeBytes,width,height}?`, без миграции, orphan/export покрытие, AVIF/HEIC + audio/video duration/waveform честно `client_declared`.
- Data export retention worker (`8b0b665`, CI PASS оба): миграция `037_data_export_retention` (`data_exports.object_deleted_at`), `DataExportRetentionWorker.sweep(now)` переводит готовые с истёкшим `expires_at` в `expired` и удаляет storage-объекты истёкших с пометкой `object_deleted_at`, запуск на старте + каждые 10 минут; unit 4/4, protocol 17/104 PASS, оба typecheck PASS (спека §14.3: 7 дней после ready, удаление объекта в пределах 24ч).
- Media binaries в экспорте (`437e1cd`, CI PASS оба): `listAllOwnedAttachments` маппится через `#mapAttachment` (camelCase + расшифровка имён), бинарники в архиве как `media/<attachmentId>/<fileName>`, per-file SHA-256 в manifest, расхождение размера объекта фейлит экспорт (503) вместо тихой потери. Экспорт-тест теперь грузит PNG и сверяет его в архиве. `omittedCategories` остался `["tokens"]`.
- Account deletion state machine first slice (`1bc1640`, CI PASS оба): migration `036` (`account_deletions` + `users.deleted_at`), protocol `AccountDeletion*` схемы, `AccountDeletionService` (schedule/status/cancel/sweep), 3 HTTP routes `POST/GET/DELETE /v1/account/deletion`, sweep по образцу passkey-свиперов, grace 7 дней. Execution: revoke всех sessions + push, tombstone profile (`deleted:{id}`, `Deleted Account`, `deleted_at`, lookup `WHERE deleted_at IS NULL`), expire export artifacts, mark owned attachments deleted. Authorization matrix 3 маршрута → 100 protected routes. Unit 7/7 + integration 3/3.
- Account export first slice (DONE, CI PASS): `POST /v1/data-exports` (идемпотентный, 201), async tar.gz сборка, `manifest.json` с per-file SHA-256 + `omittedCategories:["tokens"]`, NDJSON profile/settings/sessions/relationships/blocks/chats/messages/media, 7-day TTL, `GET .../:id` polling, `GET .../:id/download` Range+no-store+ETag (по спеке §14), stranger `404`. Коммит `5df2317`, push на main, оба CI workflow success.
- Search pagination convergence (локально зелёный): messages global+scoped `2/2/1`, known-users `2/1`, files `1/1/1`, garbage cursor `400`.
- Media: server-verified image dimensions (локально зелёный): zero-dependency PNG/GIF/WebP/JPEG-парсер, mismatch `400`, adopt + `server_verified`, AVIF/HEIC честно `client_declared`.
- Voice playback round-trip (локально зелёный): multi-chunk out-of-order upload → consent-send → receiver `206` + sha-точное скачивание → transcript-конвергенция, stranger `404`. CI-red Swift-фикс (`await` вне XCTAssert) — Apple Swift success в CI.
- Voice consent-kind gate (локально зелёный, CI ждёт пуша): send-time `400` для `transcriptionConsent` без voice/audio, audio parity для consent/transcript, iPhone `VoiceTranscriptStoreTests` (4 guard-теста). По пути починен предсуществующий time-bomb в ownership-transfer expiry-тесте (хардкод 2026-09-15T12:00Z → now+25h; падал и без моих правок).
- Topics composer+фильтр (CI зелёный везде): topicID через send/media/durable/retry, chips + индикатор, visibleMessages, canSend-правило, store-тесты.
- Topics management slice — CI зелёный везде.
- Параллельная сессия в workspace: LICENSE (MIT), README.md/RU rework — втянуто, бейджи приведены к truth-гейту.
- `81ce142` invite-ссылки 032 (+фиксы Swift-тестов, бейджей).
- `b41448e` ремонт красного main после 030/031.
- `f877742` категории уведомлений 031.

## Следующий приоритет (порядок)

1. QR-linking slice 4: passkey-ceremony step-up альтернатива → grant E2EE → history bootstrap.
2. Contact discovery — только дизайн (upload запрещён спекой до threat model).
3. Финальный QA: клиенты (iPhone device-link/calls UI за гейтами), multilayer gates.
