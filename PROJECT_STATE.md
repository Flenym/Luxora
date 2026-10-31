# Luxora — PROJECT STATE (autonomous development mode)

**Обновлено:** 2026-10-31 · ветка `feature/ios-calls-signaling`, PR #83 (13 коммитов к `main`, не смержен)  
**Владелец:** Flenym · **Релиз:** Beta-0.1 · **Режим:** AUTONOMOUS DEVELOPMENT MODE (не останавливаться, не спрашивать)

## Текущая архитектура

- **Backend:** Node 22 Fastify API (`services/api`), SQLite WAL + строгие миграции (последняя `043_device_link_step_up`), V2 realtime outbox, capability negotiation, 12-collection reconciliation snapshot. Шифрование at-rest для секретов; сервер технически может читать сообщения — **это не E2EE** (честно зафиксировано).
- **Protocol:** `@luxora/protocol` — строгие zod-контракты. Realtime v2 аддитивен: durable события мессенджинга, IA-1/membership/preferences/folders/drafts/sync-invalidated и `call.state.changed` (только `callId/chatId/state/revision/occurredAt`, без media/SDP/ICE/TURN/grant-материала).
- **Calls:** серверный call control (миграции `038_call_control_records`, `039_call_room_index`): create/get/cancel/hangup, group invite, ring/accept/decline, join-grant (LiveKit HS256 JWT 120 c + coturn REST 300 c), подписанный LiveKit-webhook, membership-reconcile и stale-reconnecting sweeper. `call.state.changed` пишется в одной транзакции со снапшотом и outbox; клиент перечитывает звонок через REST. `GET /v1/capabilities` отдаёт `features.calls:true` **только** когда настроены все пять `CALLS_*` переменных (LiveKit URL/API key/secret + TURN secret/URLs); иначе `calls:false`, а join-grant отдаёт `503`.
- **Медиаплан:** `docker-compose.calls.yml` поднимает LiveKit SFU, coturn и Caddy TLS (`wss://localhost:7443`, `infra/calls/Caddyfile`); `start.bat` → `scripts/start-all.ps1` генерирует `data/media.env`, поднимает стек, доверяет локальному CA, стартует API на 2222 (`scripts/start-server.ps1`) и публикует его через CloudPub CLI (`data/public-origins.txt`). Это локальный harness, не production-топология.
- **Клиенты:** iPhone — SwiftUI + Keychain + realtime + серверные stores; calls preview: `CallsStore` + `CallBanner` + `CallMediaSession` (LiveKit SDK), голос только при сконфигурированном медиаплане. Web — публичный продуктовый сайт на React Router + RU/EN, веб-клиент мессенджера в разработке (только контракт `apps/web/src/app/contract.ts` закоммичен). Electron — закалённый shell, грузящий `apps/web/dist`. Android — demo-only.

## Проверено (evidence)

- **CI run `41203355415` для коммита `a801cb3`, 2026-10-31:** protocol **17 файлов / 104 теста PASS**; passkey-domain **70 тестов PASS**; call-control **23 теста PASS**; API **101 файл / 743 теста PASS**; Web `npm run build` (tsc + vite) PASS; desktop typecheck PASS. Итог workflow красный только на `make check-truth` (статическая проверка русских E2EE-копий в публичных страницах сайта) — исправлено коммитом `2baac72` (гейт сужен до кода клиентов), повторный запуск на момент записи не завершён.
- **CI run `41203355300` для `a801cb3`:** Apple Swift — **396 XCTest (6 ожидаемых live-only skips, 0 failures) + 20 Swift Testing PASS**, unsigned iOS compile PASS.
- **Локально Windows (зафиксировано Lead):** API 101 / 743 PASS, protocol 17 / 104 PASS (2026-10-31, до новых правок). Web typecheck+build PASS.
- **`main` (`cc6fce7`, 2026-09-20):** Node/Web/Desktop — зелёный; Apple Swift и Apple IPA красные на этом коммите; Security (schedule) красный с 2026-10-12 по dependency-находкам. Поэтому заявление «CI зелёный на main» из README убрано.
- **PR #83 (`feature/ios-calls-signaling`):** Node-джоба до `make check-truth` зелёная, Apple Swift зелёный; Security (`dependency-review`, `filesystem-and-image`) красный — чинит `ci-deps`.

## Что работает end-to-end, с тестами

Auth (register/login/refresh/sessions, phone OTP + password + recovery + binding, profile/patch/avatar), директы/группы/каналы + membership lifecycle (add/role/remove, revision ledger 024), invite-ссылки 032 + approval-очередь 033 (union join, approve/deny, realtime fan-out), message requests + block/report, текст/reply/edit/delete/forward/pin/reaction/receipts, папки 023, архив/мьют, черновики 025, отложенные 029, транскрипты 027–028, privacy policies 030, уведомления-категории 031 + APNs registration (без реальной доставки), global/people/message/file/chat search, cursor pagination, admin console read-only, account export 035 + deletion 036 + export retention 037, security containment (`POST /v1/security/containment`), QR device-link 040–043 (challenge, approve/deny+SAS, password/step-up, proof-key redemption), thumbnails и WAV duration, calls signaling 1–7 (см. архитектуру выше), публичный продуктовый сайт (21 docs-страница, RU/EN, landing/security/download/FAQ/about/blog/status/contact/legal; сборка проверена CI).

## Что частично работает

- **Calls media:** серверный signaling и durable-события работают; iPhone: call-баннер (входящий/активный), accept/decline/hangup, старт аудиозвонка, голос через LiveKit при полном медиаплане; web: отдельная fallback-страница `apps/call-web/index.html` (поллинг REST + LiveKit из CDN). Нет push-дозвона (только polling), CallKit, видео, screen share, call history UI, real-device/QoS-доказательств и независимого security review.
- **iPhone реализовано в коде (не путать с «нет»):** attachments (composer strip, photo picker ≤10, file importer, upload→send, image viewer с зумом, file-row), topics (`ChatTopicsStore`, управление в профиле сообщества, chips в композере, фильтр истории, topicID в send), voice (recorder с таймером/уровнями, recording bar, playback с waveform, consent/transcript), chat folders, synchronized drafts (load/autosave/delete/retry + sync-состояние), message-request data layer + privacy policy (отдельного inbox-экрана в текущей direct-chat модели нет), notification settings, blocked users list + unblock, серверные devices/password settings, appearance/data settings, QR device-link sheet, calls banner + LiveKit voice. Всё это — foundation/UI без real-device/offline/push-гейтов.
- **iPhone in-progress (не считать готовым до Apple CI green + подтверждения Lead):** calls product surface (вкладка Calls — locked-заглушка, нет call history/per-chat log/in-call mute-speaker, video locked), community management UI (API client/models invite links/join requests/ownership transfer есть, UI нет), safety reports + account-data UI (server/protocol есть, iPhone client/UI нет).
- **iPhone harness остаток:** durable outbox/cache, pagination, attachment binding, file open/download/share, video picker/playback, reconnect/backoff/sync.required reconciliation, real-device gates.
- **Voice:** запись/плеер/waveform UI есть; сервер хранит как attachments + transcription consent. Сквозной QA неполный (real-device background/interruption).
- **Media:** raw upload/storage/download + thumbnails + WAV duration; нет quarantine/transcode/scan pipeline. Размеры AVIF/HEIC и audio/video duration честно `client_declared`.
- **Privacy/blocks UI:** сервер полный; iPhone — blocked list + unblock и privacy policy есть, report-submission UI нет (в работе).
- **Search:** people/messages/files/chats foundations + UI; нет global catalog pagination, contacts policy и offline-индекса.
- **Realtime multi-device:** V2 outbox + fences работают; полных poor-network/process-death доказательств нет.
- **Web:** публичный сайт завершён; веб-клиент мессенджера в разработке в этом PR (контракт закоммичен, реализация ещё нет). Fallback-страница звонков — диагностическая, не продукт.
- **Desktop/Android:** shell/demo существуют, realtime и звонков нет; backend универсален.

## Что не работает / заблокировано внешними ресурсами

Production SMS-провайдер, real APNs-доставка, E2EE (явно FUTURE, сервер читает данные), production SFU/TURN-ёмкость и стоимость relay, production DB/scale/DR, signed artifacts, TestFlight/подпись, внешние аудиты, real-device/release gates, публичные passkeys и contact upload.

## Известные truth-хвосты

- CI: Node-гейт `make check-truth` — фикс `2baac72` ждёт перезапуска workflow; Security красный (dependency-review + filesystem/image) — задача `ci-deps`; Apple IPA на PR не запускается (только `main`).
- Публичный сайт: `/download` — только «Coming Soon», `/status` — статичный снапшот (сам это признаёт), «Open Luxora» открывает Coming Soon, пока клиент не готов. `apps/web/index.html` содержит mojibake в `<title>`/`og:title` (символ `—` испорчен) — передано web-site.
- Матрица `docs/specs/IPHONE_FUNCTIONAL_COMPLETION_MATRIX_RU.md` обновлена в этом docs-слайсе: Calls row + checkpoint 2026-10-31, а также строки Attachments/Topics/Voice/Settings/Safety/Account-data/Devices по фактическому коду; in-progress iPhone-слайсы (calls product surface, community management, safety/account data) помечены как «в работе», не как done.
- Message requests на iPhone: data layer (API client/store/realtime), приватная политика «кто может писать» и настройка уведомлений есть; отдельного экрана входящих запросов в текущей direct-chat модели нет — это зафиксированное продуктовое решение, а не отсутствие данных.
- Fallback-страница звонков использует CDN `livekit-client` и `sessionStorage` — не публиковать как продукт.

## Открытая очередь (порядок, приоритет 2026-10-31 — iPhone)

1. **iPhone in-progress слайсы:** calls product surface (ios-calls — history/per-chat log/in-call mute-speaker; видео только после серверного camera-гранта), community management UI (ios-community), safety reports + account data UI (ios-safety). Не считать готовыми до Apple CI green + подтверждения Lead.
2. **Web messenger completion** — довести `apps/web/src/app` до feature-complete, честно задокументировать (Phase B этого docs-слайса).
3. **CI security green** — dependency-review + filesystem/image (ci-deps), затем перезапуск Node (truth-гейт после `2baac72`) и переоценка CodeQL.
4. **Public site QA** — truth/SEO/a11y/responsive, mojibake fix, status/download честность, hosting headers.
5. **Desktop shell wiring** — связать shell с готовым web-клиентом, проверить CSP/навигацию/permission-запросы.
6. **iPhone technical remainders** — durable outbox/cache, pagination, attachment binding, file download/share, video playback, push/CallKit (внешний блок), real-device media/QoS.
7. **Server remainders** — push-доставка (внешний блок), contact discovery без upload, media transcode/quarantine, production DB/DR.
