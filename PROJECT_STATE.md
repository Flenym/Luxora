# Luxora — PROJECT STATE (autonomous development mode)

**Обновлено:** 2026-09-15 ~19:00 UTC · `main` — voice consent-kind gate + Swift guard-тесты, API 80/658 зелёный локально
**Владелец:** Flenym · **Релиз:** Beta-0.1 · **Режим:** AUTONOMOUS DEVELOPMENT MODE (не останавливаться, не спрашивать)

## Текущая архитектура

- **Backend:** Node 22 Fastify API (`services/api`), SQLite WAL + строгие миграции (последняя `032_chat_invite_links`), V2 realtime outbox, capability negotiation, 12-collection reconciliation snapshot. Шифрование at-rest для секретов; сервер технически может читать сообщения — **это не E2EE** (честно зафиксировано).
- **Protocol:** `@luxora/protocol` — строгие zod-контракты (17 файлов / 104 теста).
- **iPhone:** Swift 6 `LuxoraKit` + `LuxoraMobile`, Keychain-сессии, серверные stores, DEBUG-фикстуры только для геометрии.
- **Проверено:** API 80 файлов / 658 тестов PASS (локально Windows; CI ждёт пуша), protocol 17/104, оба typecheck PASS. Swift-тесты только через CI.

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

- Voice consent-kind gate (локально зелёный, CI ждёт пуша): send-time `400` для `transcriptionConsent` без voice/audio, audio parity для consent/transcript, iPhone `VoiceTranscriptStoreTests` (4 guard-теста). По пути починен предсуществующий time-bomb в ownership-transfer expiry-тесте (хардкод 2026-09-15T12:00Z → now+25h; падал и без моих правок).
- Topics composer+фильтр (CI зелёный везде): topicID через send/media/durable/retry, chips + индикатор, visibleMessages, canSend-правило, store-тесты.
- Topics management slice — CI зелёный везде.
- Параллельная сессия в workspace: LICENSE (MIT), README.md/RU rework — втянуто, бейджи приведены к truth-гейту.
- `81ce142` invite-ссылки 032 (+фиксы Swift-тестов, бейджей).
- `b41448e` ремонт красного main после 030/031.
- `f877742` категории уведомлений 031.

## Следующий приоритет (порядок)

1. Voice остаток QA: playback через authenticated download + poor-network/process-death доказательства (запись/upload/consent/transcript уже покрыты).
2. Media processing → search → calls signaling (по готовности, каждый со Slice-тестами).
