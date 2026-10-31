# Luxora — PROJECT STATE (autonomous development mode)

**Обновлено:** 2026-10-31 · ветка `feature/ios-calls-signaling`, PR #83 (head `df39703`; локальный счётчик — 29 коммитов ahead of `origin/main`; PR не смержен, финальный CI на этом head — все workflow SUCCESS)  
**Владелец:** Flenym · **Релиз:** Beta-0.1 · **Режим:** AUTONOMOUS DEVELOPMENT MODE (не останавливаться, не спрашивать)

## Текущая архитектура

- **Backend:** Node 22 Fastify API (`services/api`), SQLite WAL + строгие миграции (последняя `043_device_link_step_up`), V2 realtime outbox, capability negotiation, 12-collection reconciliation snapshot. Шифрование at-rest для секретов; сервер технически может читать сообщения — **это не E2EE** (честно зафиксировано). CORS допускает все браузерные mutation-методы по exact-allowlist и отдаёт только безопасные exposed-заголовки; есть preflight regression test. `POST /v1/chats` для non-self Direct теперь требует accepted, unblocked relationship (`b811985`).
- **Protocol:** `@luxora/protocol` — строгие zod-контракты. Realtime v2 аддитивен: durable события мессенджинга, IA-1/membership/preferences/folders/drafts/sync-invalidated и `call.state.changed` (только `callId/chatId/state/revision/occurredAt`, без media/SDP/ICE/TURN/grant-материала).
- **Calls:** серверный call control (миграции `038_call_control_records`, `039_call_room_index`): create/get/cancel/hangup, group invite, ring/accept/decline, join-grant (LiveKit HS256 JWT 120 c + coturn REST 300 c), подписанный LiveKit-webhook, membership-reconcile, stale-reconnecting sweeper и `GET /v1/calls?chatId=`. `call.state.changed` пишется в одной транзакции со снапшотом и outbox; клиент перечитывает звонок через REST. `GET /v1/capabilities` отдаёт `features.calls:true` только при полном `CALLS_*`-медиаплане, иначе `calls:false` и join-grant `503`.
- **Медиаплан:** `docker-compose.calls.yml` поднимает LiveKit SFU, dev TURN relay и Caddy TLS; dev TURN собирается из `tools/coturn/Dockerfile` на pinned Alpine 3.24.3 (upstream coturn alpine-теги везут brotli CVE-2026-111497) и публикует порт от непривилегированного пользователя. `start.bat` → `scripts/start-all.ps1` генерирует `data/media.env`, поднимает стек, доверяет локальному CA, стартует API на 2222 и публикует его через CloudPub CLI. Локальный harness, не production-топология.
- **Web:** публичный продуктовый сайт завершён (14 маршрутов, 22 docs-страницы RU/EN, SEO/JSON-LD/canonical/OG/robots/sitemap, а11y, lazy 3D hero) и веб-клиент мессенджера по `/app` реализован: React, `src/app/core` (REST-клиент с access-токеном в памяти и refresh в `sessionStorage`, realtime `/v2`, чистые store-хелперы, call-media адаптеры) + `src/app/ui`; dev/preview proxy `/v1`, `/v2`, `/health` → `127.0.0.1:2222`. Клиент — developer preview, не выпущенный продукт.
- **Клиенты:** iPhone — SwiftUI + Keychain + realtime + серверные stores; calls preview: `CallsStore` + `CallBanner` + `CallMediaSession` (LiveKit SDK); **calls product surface** (вкладка истории звонков, per-chat лог, call-back, in-call overlay с серверно-заякоренным таймером и honest mute, locked/limited gating; video locked — join-grant выдаёт только микрофон) и **community management UI** (invite links shown-once + revoke, join-request approval queue, ownership-transfer ceremony, join-by-link) — обе поверхности закоммичены и проверены Apple CI. Electron грузит `apps/web/dist` (public site + `/app`), messaging not integrated. Android — demo-only.

## Итоговое CI/evidence состояние

Состояние на 2026-10-31: финальный head `df39703` прошёл **все workflow-прогоны SUCCESS**.

| Проверка | Статус | Где подтверждено |
| --- | --- | --- |
| Финальный прогон `df39703` | ✅ **ALL GREEN** | Node/Web/Desktop `verify` SUCCESS; Apple Swift `swift-package` + `ios-compile` SUCCESS; Security and container `dependency-review` + `codeql` + `filesystem-and-image` SUCCESS; обязательный status-check «CodeQL» SUCCESS |
| Node/Web/Desktop (`verify`) | ✅ SUCCESS | `df39703`, `32e0d62` (и `380881f`/`4918cfa`-class pushes); включает web build + **49/49 vitest** |
| Security and container (полный) | ✅ PASSED | `df39703` и `32e0d62`: filesystem Trivy, dependency-review, CodeQL job, built API/OTP images, built internal `luxora-turn` image, `make calls-smoke` incl. TURN auth accept/reject |
| Apple Swift `swift-package` (`swift test`) | ✅ SUCCESS | `df39703`, `b682d99`, `d0a7a8f`, `32e0d62`: **396 XCTest + 6 expected skips + 20 Swift Testing**, включая новые `CallHistoryTests` и `CommunityManagementStoreTests` |
| Apple Swift `ios-compile` | ✅ SUCCESS на `df39703` | Ранее PASSED на `380881f`, FAILED на `d0a7a8f` (`PhoneCommunityViews.swift` optional participant-resolver unwrap), исправлено в `df39703` — финальный прогон зелёный |
| API full suite | ✅ **103 файла / 749 тестов** green | Локальный полный прогон + CI; включает новый `direct-chat-relationship.integration.test.ts` |
| Web messenger browser E2E | ✅ Локально (не CI): 13–14/14 шагов в повторных прогонах | sign-in, sidebar/search, message request → accept, open chat, realtime message to second account, reply (menu), delivery ticks from receipts, image upload, honest calls gating, profile/sign-out, mobile viewport, zero unexpected console errors; последний нестабильный шаг — тайминг селектора в harness, не продукт |
| Public metadata gate | ✅ PASS (`Beta-0.1; Flenym`) | `bash infra/validate-public-metadata.sh` |

- **Backend security fix (`b811985`):** `POST /v1/chats` для non-self Direct теперь требует accepted, unblocked relationship; ранее проверка действовала только при `messageRequests:"nobody"` — документированный контракт обходился. Новый `direct-chat-relationship.integration.test.ts`, обновлены boundary fixtures; smoke harness **42/42**, FULL API suite **103/749** green. Browser E2E доказывает: stranger Direct → `403` → честный message-request fallback → accept → direct chat → realtime delivery.
- **TURN dev image:** upstream coturn alpine-теги содержат brotli CVE-2026-111497, поэтому dev relay собирается из `tools/coturn/Dockerfile` на pinned Alpine 3.24.3 и работает от непривилегированного пользователя; Security-прогон `32e0d62` собирает и сканирует `luxora-turn` и проверяет TURN auth accept/reject через `make calls-smoke`.
- **Продуктовое состояние iPhone:** calls product surface и community management **проверены CI** — финальный `df39703` полностью зелёный, включая `swift-package` (396 XCTest + 6 expected skips + 20 Swift Testing с `CallHistoryTests`/`CommunityManagementStoreTests`) и `ios-compile`. **НЕ shipped:** iPhone safety reports UI и account export/deletion UI (server + protocol есть, iPhone client/views не написаны), real APNs push/CallKit, E2EE, real-device/release gates.
- **Историческая справка:** предыдущий полный серверный замер на `a801cb3` — protocol 17/104, passkey-domain 70, call-control 23, API 101/743, Apple Swift 396 XCTest + 20 Swift Testing; с тех пор добавлены calls/community, CORS, direct-chat guard и web-клиент, поэтому актуальные цифры — в таблице выше.

## Что работает end-to-end

Auth (register/login/refresh/sessions, phone OTP + password + recovery + binding, profile/patch/avatar), директы/группы/каналы + membership lifecycle 024 (с обязательной accepted-relationship для non-self Direct), invite-ссылки 032 + approval-очередь 033, message requests + block/report, текст/reply/edit/delete/forward/pin/reaction/receipts, папки 023, архив/мьют, черновики 025, отложенные 029, транскрипты 027–028, privacy policies 030, уведомления-категории 031 + APNs registration (без реальной доставки), global/people/message/file/chat search, cursor pagination, admin console read-only, account export 035 + deletion 036 + export retention 037, security containment, QR device-link 040–043, thumbnails и WAV duration, calls signaling 1–7, публичный продуктовый сайт, web messenger client `/app` (auth/shell/history/send/attachments/receipt-truth/realtime v2/message requests/call signalling UI с honest unavailable media) и iPhone calls product surface + community management (проверены CI).

## Что частично работает / не shipped

- **Web client остаток:** нет server-synced drafts/folders UI (локальные drafts/filter), нет видео/screen share, PWA/service worker/push, offline-кэша; calls media не проверено end-to-end (локальный сервер без медиаплана: `features.calls:false`, адаптер `unavailable`); presence приблизительный; браузерный E2E — локальный, не CI; формального WCAG-аудита `/app` нет.
- **Calls:** нет push-дозвона/CallKit, видео/screen share, media-E2EE, production-ёмкости SFU/TURN, real-device/QoS-доказательств и независимого security review.
- **iPhone:** `LuxoraKit` store всё ещё in-memory (нет durable outbox/cache, pagination, attachment binding, file open/download/share, video picker/playback, reconnect/backoff/sync.required reconciliation) и нет real-device gates; safety reports UI и account export/deletion UI не написаны.
- **Media:** raw upload/storage/download + thumbnails + WAV duration; нет quarantine/transcode/scan pipeline; AVIF/HEIC размеры и non-WAV duration честно `client_declared`.
- **Search:** нет global catalog pagination, contacts policy и offline-индекса.
- **Realtime multi-device:** V2 outbox + fences работают; полных poor-network/process-death доказательств нет.
- **Desktop/Android:** Electron shell грузит web-сборку, но messaging не интегрирован; Android — demo-only.

## Что не работает / заблокировано внешними ресурсами

Production SMS-провайдер, real APNs-доставка, E2EE (явно FUTURE, сервер читает данные), production SFU/TURN-ёмкость и стоимость relay, production DB/scale/DR, signed artifacts, TestFlight/подпись, внешние аудиты, real-device/release gates, публичные passkeys и contact upload.

## Известные truth-хвосты

- Финальный CI на `df39703` — **все workflow SUCCESS** (Node/Web/Desktop verify, Apple Swift swift-package + ios-compile, Security dependency-review + CodeQL + filesystem-and-image + обязательный «CodeQL» check); green зафиксирован после завершения прогонов.
- iPhone safety reports UI и account export/deletion UI — **planned/next**, а не shipped; real APNs/CallKit и E2EE — заблокированы/будущее.
- Веб-клиент — developer preview: refresh-токен в `sessionStorage` (XSS-граница), hosting CSP/headers и CI E2E — release gates; `apps/web/README.md` приведён в соответствие (public site + `/app`, 49 тестов, gaps).
- Публичный сайт: `/download` — «Coming Soon», `/status` — статичный снапшот; canonical/OG origin `https://luxora.app` объявлен в metadata, но деплой/хостинг этим репозиторием не поставляется.
- Fallback-страница звонков `apps/call-web/index.html` использует CDN `livekit-client` и `sessionStorage` — диагностическая, не продукт.
- Message requests на iPhone: data layer + policy + notification toggle есть, отдельного inbox-экрана нет — продуктовое решение; у web-клиента inbox есть.

## Следующие шаги (после мержа PR #83)

1. **Смержить PR #83** — финальный CI на `df39703` уже полностью зелёный (Lead).
2. **iPhone остатки:** safety reports UI + account export/deletion UI (server/protocol готовы); реальный APNs push/CallKit — внешние гейты; durable outbox/cache, pagination, file download/share, video playback; real-device media/QoS.
3. **Web follow-up:** hosting CSP/headers + решение sessionStorage vs HttpOnly, закоммитить или явно оставить локальным E2E harness, desktop shell wiring, server-synced drafts/folders — отдельные фичи.
4. **Server:** push-доставка, contact discovery без upload, media transcode/quarantine, production DB/DR и production calls capacity/review; E2EE — отдельная аудируемая программа.
5. **Public site:** deployment/hosting, финальный ручной SEO/a11y pass.
