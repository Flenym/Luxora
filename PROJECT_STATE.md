# Luxora — PROJECT STATE (autonomous development mode)

**Обновлено:** 2026-10-31 · PR #109 (ветка `feature/iphone-safety-and-e2e`, head `beb6ca7`, 4 коммита ahead of `main`) — все проверки на этом head зелёные; PR #83 (iOS calls/community + web client) уже смержен в `main` коммитом `919d0f6`  
**Владелец:** Flenym · **Релиз:** Beta-0.1 · **Режим:** AUTONOMOUS DEVELOPMENT MODE (не останавливаться, не спрашивать)

## Текущая архитектура

- **Backend:** Node 22 Fastify API (`services/api`), SQLite WAL + строгие миграции (последняя `043_device_link_step_up`), V2 realtime outbox, capability negotiation, 12-collection reconciliation snapshot. Шифрование at-rest для секретов; сервер технически может читать сообщения — **это не E2EE** (честно зафиксировано). CORS допускает все браузерные mutation-методы по exact-allowlist и отдаёт безопасные exposed-заголовки; `POST /v1/chats` для non-self Direct требует accepted, unblocked relationship (`b811985`, в `main`).
- **Protocol:** `@luxora/protocol` — строгие zod-контракты. Realtime v2 аддитивен: durable события мессенджинга, IA-1/membership/preferences/folders/drafts/sync-invalidated и `call.state.changed` (только `callId/chatId/state/revision/occurredAt`, без media/SDP/ICE/TURN/grant-материала).
- **Calls:** серверный call control (миграции `038_call_control_records`, `039_call_room_index`): create/get/cancel/hangup, group invite, ring/accept/decline, join-grant (LiveKit HS256 JWT 120 c + coturn REST 300 c), подписанный LiveKit-webhook, membership-reconcile, stale-reconnecting sweeper и `GET /v1/calls?chatId=`. `call.state.changed` пишется в одной транзакции со снапшотом и outbox; клиент перечитывает звонок через REST. `GET /v1/capabilities` отдаёт `features.calls:true` только при полном `CALLS_*`-медиаплане, иначе `calls:false` и join-grant `503`.
- **Медиаплан:** `docker-compose.calls.yml` поднимает LiveKit SFU, dev TURN relay и Caddy TLS; dev TURN собирается из `tools/coturn/Dockerfile` на pinned Alpine 3.24.3 (upstream coturn alpine-теги везут brotli CVE-2026-111497) и работает от непривилегированного пользователя. `start.bat` → `scripts/start-all.ps1` генерирует `data/media.env`, поднимает стек, доверяет локальному CA, стартует API на 2222 и публикует его через CloudPub CLI. Локальный harness, не production-топология.
- **Web:** публичный продуктовый сайт завершён (14 маршрутов, 22 docs-страницы RU/EN, SEO/JSON-LD/canonical/OG/robots/sitemap, а11y, lazy 3D hero) и веб-клиент мессенджера по `/app` реализован (React, `src/app/core` + `src/app/ui`, access token в памяти, refresh в `sessionStorage`, realtime `/v2`). **Browser E2E теперь committed CI gate:** `tools/web-e2e` (pinned `puppeteer-core` 25.16.0, CSPRNG-аккаунты/пароли, реальный API с генерируемыми dev-секретами и временной SQLite, `vite preview`, autodetect системного Chrome / `CHROME_PATH`, screenshots+report artifact при падении, process-tree cleanup) + job `web-e2e` в `.github/workflows/node.yml` (ubuntu-24.04, 15-мин кап): **PASS в GitHub Actions**, 16 user-observable checks. Клиент — developer preview, не выпущенный продукт.
- **iPhone:** SwiftUI + Keychain + realtime + серверные stores. В `main` уже есть calls product surface (history/per-chat log/call-back/in-call overlay с honest mute; video locked) и community management (invite links shown-once+revoke, join-request queue, ownership-transfer ceremony, join-by-link). **PR #109 добавляет safety/account-data surface:** `LuxoraSafetyAPIClient` (safety reports list/submit; data export request/status/range download; account deletion status/schedule/cancel — strict decode, sanitized errors), `SafetyReportsStore` (own-report cursor pagination, nonce-idempotent submit), `AccountDataStore` (bounded export polling, download verified по size+SHA-256 через CryptoKit до ShareLink, deletion state machine по серверному 7-дневному grace; cancel отклоняется после deadline без сетевых вызовов), `PhoneSafetyAndDataViews` (report sheet с category picker/comment/alsoBlock и явным cloud-preview consent; «Мои жалобы»; account-data screen с typed «УДАЛИТЬ» confirmation, grace deadline и honest executing/completed/failed состояния), wiring в `ApplicationSession`, settings-маршруты «Жалобы и отчёты» (privacy) и «Экспорт и удаление аккаунта» (data), «Пожаловаться» в message menu для чужих сообщений.
- **Desktop/Android:** Electron грузит `apps/web/dist` (public site + `/app`), messaging не интегрирован; Android — demo-only.

## Итоговое CI/evidence состояние

Состояние на 2026-10-31: PR #109 head `beb6ca7` — **все проверки зелёные**.

| Проверка | Статус | Где подтверждено |
| --- | --- | --- |
| PR #109 head `beb6ca7` | ✅ **ALL GREEN** | swift-package, ios-compile, verify, web-e2e, dependency-review, codeql, filesystem-and-image, required «CodeQL» — все SUCCESS |
| Apple Swift `swift-package` | ✅ SUCCESS | `beb6ca7`: **455 XCTest executed, 6 skipped, 0 failures** + **20 Swift Testing** в 3 suite; счётчики включают calls (`CallHistoryTests`/`CallsStoreTests`), community management и новые safety/account-data тесты |
| Apple Swift `ios-compile` | ✅ SUCCESS | `beb6ca7` (4m32s); ранее green на `380881f`/`df39703`, красный на `d0a7a8f` — unwrap fix в `df39703` |
| Node/Web/Desktop `verify` | ✅ SUCCESS | `beb6ca7`: API full suite **103 файла / 749 тестов**, web build + **49/49 vitest**, truth-гейт PASS |
| `web-e2e` job (Node workflow) | ✅ SUCCESS | `beb6ca7`: **16/16 checks passed** в GitHub Actions (job ~54 s), artifacts загружаются только при failure |
| Security and container | ✅ SUCCESS | `beb6ca7`: filesystem Trivy, dependency-review, codeql, built API/OTP images, internal `luxora-turn`, `make calls-smoke` incl. TURN auth accept/reject; required «CodeQL» check SUCCESS |
| PR #83 | ✅ MERGED | `919d0f6` в `main`, финальный прогон `df39703` был all-green |

- **iPhone safety/account-data (PR #109):** 26 новых contract/store тестов (`SafetyReportContractTests`, `AccountDataStoreTests`); honest limits сохранены — нет instant-deletion, нет E2EE-заявлений; отчёт несёт явное cloud-preview согласие (сервер может читать содержимое), удаление идёт строго через серверный 7-дневный grace и typed-подтверждение, экспорт проверяется по size+SHA-256 до шаринга.
- **Web E2E в CI:** сценарии включают auth error, sign-in, stranger-Direct guard → message request → accept, chat reopen/open, realtime delivery, reply, honest delivery tick (без fake failed), image upload/render, honest call gating, profile, sign-out, zero unexpected console errors; `tools/web-e2e/**` добавлен в path filters, существующие jobs не тронуты, actionlint clean.
- **Продуктовое состояние iPhone:** calls product surface, community management и safety/account-data — **verified CI**. **НЕ shipped:** real APNs push/CallKit, E2EE, video/screen-share, real-device/release gates.
- **Историческая справка:** прежние замеры — `a801cb3` (protocol 17/104, API 101/743, Apple 396 XCTest + 20 Swift Testing), `df39703` (все workflow зелёные); актуальные цифры — в таблице выше.

## Что работает end-to-end

Auth (register/login/refresh/sessions, phone OTP + password + recovery + binding, profile/patch/avatar), директы/группы/каналы + membership lifecycle 024 (с обязательной accepted-relationship для non-self Direct), invite-ссылки 032 + approval-очередь 033, message requests + block/report, текст/reply/edit/delete/forward/pin/reaction/receipts, папки 023, архив/мьют, черновики 025, отложенные 029, транскрипты 027–028, privacy policies 030, уведомления-категории 031 + APNs registration (без реальной доставки), global/people/message/file/chat search, cursor pagination, admin console read-only, account export 035 + deletion 036 + export retention 037, security containment, QR device-link 040–043, thumbnails и WAV duration, calls signaling 1–7, публичный продуктовый сайт, web messenger client `/app` (auth/shell/history/send/attachments/receipt-truth/realtime v2/message requests/call signalling UI с honest unavailable media; browser E2E в CI), iPhone calls product surface + community management + safety reports + account data (export/delete) surfaces — всё проверено CI.

## Что частично работает / не shipped

- **Web client остаток:** нет server-synced drafts/folders UI (локальные drafts/filter), нет видео/screen share, PWA/service worker/push, offline-кэша; calls media не проверено end-to-end (локальный сервер без медиаплана: `features.calls:false`, адаптер `unavailable`); presence приблизительный; hosting CSP/headers и формальный WCAG-аудит `/app` ещё открыты (E2E уже в CI).
- **Calls:** нет push-дозвона/CallKit, видео/screen-share, media-E2EE, production-ёмкости SFU/TURN, real-device/QoS-доказательств и независимого security review.
- **iPhone:** `LuxoraKit` store всё ещё in-memory (нет durable outbox/cache, pagination, attachment binding, file open/download/share, video picker/playback, reconnect/backoff/sync.required reconciliation) и нет real-device gates; real APNs push/CallKit отсутствуют.
- **Media:** raw upload/storage/download + thumbnails + WAV duration; нет quarantine/transcode/scan pipeline; AVIF/HEIC размеры и non-WAV duration честно `client_declared`.
- **Search:** нет global catalog pagination, contacts policy и offline-индекса.
- **Realtime multi-device:** V2 outbox + fences работают; полных poor-network/process-death доказательств нет.
- **Desktop/Android:** Electron shell грузит web-сборку, но messaging не интегрирован; Android — demo-only.

## Что не работает / заблокировано внешними ресурсами

Production SMS-провайдер, real APNs-доставка, E2EE (явно FUTURE, сервер читает данные), production SFU/TURN-ёмкость и стоимость relay, production DB/scale/DR, signed artifacts, TestFlight/подпись, внешние аудиты, real-device/release gates, публичные passkeys и contact upload.

## Известные truth-хвосты

- PR #109 head `beb6ca7` — все проверки зелёные; PR ещё **не смержен** (Lead коммитит docs и мержит).
- iPhone safety/account-data — shipped с honest limits: no instant-deletion/E2EE claims, отчёт требует явного cloud-preview consent, удаление идёт через серверный 7-дневный grace; real APNs/CallKit и E2EE остаются future.
- Веб-клиент — developer preview: refresh-токен в `sessionStorage` (XSS-граница), hosting CSP/headers — release gates; browser E2E теперь CI gate (`tools/web-e2e`).
- Публичный сайт: `/download` — «Coming Soon», `/status` — статичный снапшот; canonical/OG origin `https://luxora.app` объявлен в metadata, но деплой/хостинг этим репозиторием не поставляется.
- Fallback-страница звонков `apps/call-web/index.html` использует CDN `livekit-client` и `sessionStorage` — диагностическая, не продукт.
- Message requests на iPhone: data layer + policy + notification toggle есть, отдельного inbox-экрана нет — продуктовое решение; у web-клиента inbox есть.

## Следующие шаги (после мержа PR #109)

1. **Смержить PR #109** после коммита docs (Lead) — head `beb6ca7` уже all-green.
2. **iPhone остатки:** real APNs push + CallKit, E2EE, video/screen-share, durable outbox/cache, pagination, file download/share, video playback, real-device media/QoS и release-гейты.
3. **Web follow-up:** hosting CSP/headers, решение sessionStorage vs HttpOnly, desktop shell wiring, server-synced drafts/folders — отдельные фичи; WCAG-аудит `/app`.
4. **Server:** push-доставка, contact discovery без upload, media transcode/quarantine, production DB/DR и production calls capacity/review; E2EE — отдельная аудируемая программа.
5. **Public site:** deployment/hosting, финальный ручной SEO/a11y pass.
