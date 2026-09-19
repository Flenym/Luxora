# Luxora — PROJECT STATE (autonomous development mode)

**Обновлено:** 2026-09-19 · QR device-link slice 1 (challenge lifecycle) + search slice 1 + calls slices 1–7, API 98/727 зелёный локально
**Владелец:** Flenym · **Релиз:** Beta-0.1 · **Режим:** AUTONOMOUS DEVELOPMENT MODE (не останавливаться, не спрашивать)

## Текущая архитектура

- **Backend:** Node 22 Fastify API (`services/api`), SQLite WAL + строгие миграции (последняя `037_data_export_retention`), V2 realtime outbox, capability negotiation, 12-collection reconciliation snapshot. Шифрование at-rest для секретов; сервер технически может читать сообщения — **это не E2EE** (честно зафиксировано).
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

- QR device-link slice 1 (challenge lifecycle) DONE (локально, uncommitted): миграция `040_device_link_challenges`, `DeviceLinkService` create/poll/close (linkSecret once, +120s/2s/429, digest-only, sweeper 10-мин), `device-links.integration` 3/3, матрица 112→114, typechecks clean, инвентаризации 040, полный API 98/727; остаток — approval slice 2, grant/session slice 3.
- Conversation search DONE (локально, uncommitted): `GET /v1/search/chats` (substring по titles групп/каналов, только текущие memberships, `updated_at` DESC + cursor `limit+1`/garbage `400`, plaintext titles без blind index, экранированные wildcards, ASCII `NOCASE`, директы исключены), без миграции/protocol-изменений (`q 1..80`), матрица 111→112, `search-chats.integration` 2/2, typecheck clean, полный suite пока НЕ гонялся; остаток — Unicode-folding, SPC-007 public catalog, offline-индекс, iPhone scope local-only.
- Calls signaling slice 7 stale sweeper DONE (локально, uncommitted): `sweepStaleReconnecting` (`network-timeout`, 10-мин timer, без routes/migration, матрица 111), `calls-reconnect-sweeper.integration` 1/1, typecheck clean, полный API 96/722; остаток — push-доставка, затем search (grant refresh покрыт re-issuance).
- Calls signaling slice 6 membership hook DONE (локально, uncommitted): `onMemberRemoved`→`reconcileMembership` (`membership_removed`, epoch bump, host `ending→ended`), без routes/migration (111), `calls-signaling.integration` 8/8, typecheck clean, полный API 95/721; остаток — push-доставка, grant refresh, crash sweeper, затем search.
- Calls signaling slice 5 webhooks DONE (локально, uncommitted): `POST /v1/internal/calls/livekit-webhook` (LiveKit JWT/raw-body, issuer==API key, 401 на подделку), миграция `039_call_room_index`, dispatch joined/left/aborted/finished, ack `200 {received:true}`, матрица 110→111, тесты 4/4 + 2/2; остаток — push-доставка, membership_removed hook, grant refresh, crash sweeper, затем search.
- Calls signaling slice 4 join-grants DONE (локально, uncommitted, 93/714): `POST /v1/calls/:id/join-grant` LiveKit HS256 JWT 120s + coturn REST 300s, rechecks membership/relationship/block/session/epoch, 503-gate до полного LiveKit+TURN конфига, секреты вне responses/logs, `calls:false`, матрица 109→110, `calls-join-grant.integration` 4/4, typechecks clean; остаток — webhooks, push/ringing, membership_removed hook, grant refresh.
- Calls signaling slice 3 DONE (локально, uncommitted, 92/710): `POST /v1/calls/:id/invite` host-only/group-only, member/block/session guards, `InviteCallParticipantRequestSchema`, матрица 108→109; остаток — join-grants, webhooks, push-доставка, membership_removed hook, затем search.
- Calls signaling slice 2 DONE (локально, uncommitted, 92/708): групповые звонки, `POST .../ring|accept|decline`, convergent re-ring, `unreachableMemberIds`, матрица 105→108, `calls-signaling.integration` 5/5. Остаток — join-grants, webhooks, push-доставка.
- Calls signaling first slice DONE (локально, uncommitted): миграция `038_call_control_records`, `CallService` поверх `@luxora/call-control` executor + SQLite-адаптер, маршруты create/get/cancel/hangup, `calls-signaling.integration` 3/3, auth-матрица 101→105, остаток — invite/ring/push/grants/webhooks.
- WAV duration verification DONE (локально, uncommitted): pure-TS `measureWavDuration` (RIFF walk, PCM/float/extensible), `complete()` для `audio`/`voice` + `audio/wav` принимает измеренный durationMs + `server_verified`, остальной audio/waveform честно `client_declared`; тесты 4/4 + 1/1 (5000ms claim → 1000ms measured), API typecheck clean.
- Image thumbnails (`8bae86a`, CI PASS оба воркфлоу: Node/Web/Desktop 4m27s, Security 2m31s, 89/698): sharp-JPEG 320px q80 в `complete()` для image >320px (best-effort), `GET /v1/attachments/:id/thumbnail` owner-or-granted (stranger 404/anonymous 401, no-store), protocol `thumbnailPath?` + `thumbnail{sha256,sizeBytes,width,height}?`, без миграции, orphan/export покрытие, AVIF/HEIC + audio/video duration/waveform честно `client_declared`.
- Data export retention worker (локально зелёный, 87/689): миграция `037_data_export_retention` (`data_exports.object_deleted_at`), `DataExportRetentionWorker.sweep(now)` переводит готовые с истёкшим `expires_at` в `expired` и удаляет storage-объекты истёкших с пометкой `object_deleted_at`, запуск на старте + каждые 10 минут; unit 4/4, protocol 17/104 PASS, оба typecheck PASS (спека §14.3: 7 дней после ready, удаление объекта в пределах 24ч).
- Media binaries в экспорте (локально зелёный, 86/685): `listAllOwnedAttachments` маппится через `#mapAttachment` (camelCase + расшифровка имён), бинарники в архиве как `media/<attachmentId>/<fileName>`, per-file SHA-256 в manifest, расхождение размера объекта фейлит экспорт (503) вместо тихой потери. Экспорт-тест теперь грузит PNG и сверяет его в архиве. `omittedCategories` остался `["tokens"]`.
- Account deletion state machine first slice (локально зелёный): migration `036` (`account_deletions` + `users.deleted_at`), protocol `AccountDeletion*` схемы, `AccountDeletionService` (schedule/status/cancel/sweep), 3 HTTP routes `POST/GET/DELETE /v1/account/deletion`, sweep по образцу passkey-свиперов, grace 7 дней. Execution: revoke всех sessions + push, tombstone profile (`deleted:{id}`, `Deleted Account`, `deleted_at`, lookup `WHERE deleted_at IS NULL`), expire export artifacts, mark owned attachments deleted. Authorization matrix 3 маршрута → 100 protected routes. Unit 7/7 + integration 3/3; полный API 86 файлов / 685 тестов PASS.
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

1. Retention workers (deletion ledger, TTL) — медиа-бинары в экспорте уже сделаны.
2. Media processing остаток (thumbnails/transcode, duration/waveform) → calls signaling.
