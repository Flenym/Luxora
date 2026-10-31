# Luxora — PROJECT STATE (autonomous development mode)

**Обновлено:** 2026-10-31 · PR #110 (ветка `feature/completeness-pass`, head `ef57595`, 11 коммитов ahead of `main`) — все проверки на этом head зелёные; PR #109 (iPhone safety/account data) уже смержен в `main` коммитом `0fda88a`  
**Владелец:** Flenym · **Релиз:** Beta-0.1 · **Режим:** AUTONOMOUS DEVELOPMENT MODE (не останавливаться, не спрашивать)

## Текущая архитектура

- **Backend:** Node 22 Fastify API (`services/api`), SQLite WAL + строгие миграции (последняя `043_device_link_step_up`), V2 realtime outbox, capability negotiation, 12-collection reconciliation snapshot. Шифрование at-rest для секретов; сервер технически может читать сообщения — **это не E2EE** (честно зафиксировано). CORS допускает все браузерные mutation-методы по exact-allowlist; `POST /v1/chats` для non-self Direct требует accepted, unblocked relationship; в PR #110 завершена **аддитивная cursor pagination** для ранее «полных» списков: sessions, chat members, topics, invite links, join requests, message edit history и call history (default 100/max 100, calls default/max 50; ответы `{items| calls, nextCursor}`). Документировано в `API.md`.
- **Protocol:** `@luxora/protocol` — строгие zod-контракты. Realtime v2 аддитивен: durable события мессенджинга, IA-1/membership/preferences/folders/drafts/sync-invalidated и `call.state.changed` (только `callId/chatId/state/revision/occurredAt`, без media/SDP/ICE/TURN/grant-материала).
- **Calls:** серверный call control (миграции `038_call_control_records`, `039_call_room_index`) + **реальное медиа end-to-end локально (PR #110):** media join теперь только когда звонок joinable (после accept, а не во время ringing); LiveKit через local Docker media plane (LiveKit + TURN + Caddy) доставляет подписанные webhooks на `/v1/internal/calls/livekit-webhook`, поэтому звонки переходят `connecting → active` и завершаются при disconnect; `scripts/dev-calls.ps1` задаёт webhook URL и корректный `VITE_LUXORA_API` для calls API на 8080. `call.state.changed` пишется в одной транзакции со снапшотом и outbox. Web-клиент получил mute/unmute через media-соединение (contract + store + UI) и honest cloud-preview copy в активном overlay. `GET /v1/capabilities` отдаёт `features.calls:true` только при полном `CALLS_*`-медиаплане.
- **Медиаплан:** `docker-compose.calls.yml` поднимает LiveKit SFU, dev TURN relay и Caddy TLS; dev TURN собирается из `tools/coturn/Dockerfile` на pinned Alpine 3.24.3 (upstream coturn alpine-теги везут brotli CVE-2026-111497). Локальный harness, не production-топология.
- **Web:** публичный сайт + веб-клиент `/app`; **PR #110:** axe-core 4.14 WCAG 2.x A/AA аудит встроен в committed E2E gate (9 состояний, fail на critical/serious, пустой baseline, JSON/markdown artifacts); web-ui исправлены все findings — **0 critical / 0 serious / 0 moderate / 0 minor** на 22 dev + 21 production-preview состояниях; keyboard checks 11/11; route-level code splitting (initial marketing payload 606.33 kB raw / 170.60 kB gzip → 287.99 kB raw / 89.73 kB gzip, −52.5%/−47.4%); honest PWA shell (manifest + icons + `sw.js`, кэширует только public shell/static; никогда `/v1`, `/v2`, `/health` или сообщения; registration только production-HTTPS; 0 регистраций в dev/preview).
- **Desktop:** Electron shell теперь по-настоящему запускает web-клиент: packaged web build сервится через кастомную secure scheme `luxora://app`, CSP ставится in-handler; loopback `LUXORA_API_URL` пробрасывается через sandboxed CommonJS preload (старый ESM preload не загружался); web-клиент использует bridge только для loopback-origins; explicit CORS origin `luxora://app`; есть `LUXORA_DESKTOP_SMOKE=1` режим и новый CI job `desktop` (PASS, 49 s, Xvfb, CI-only sandbox switch при сохранённых sandbox/contextIsolation/nodeIntegration protections).
- **iPhone:** SwiftUI + Keychain + realtime + серверные stores: calls product surface, community management, safety reports и account export/deletion UI (в `main`). **PR #110 добавляет `ui-tests` job:** bounded offline subset существующих UI test suites на симуляторе, unsigned, с xcresult/log/screenshot artifacts при падении; stale UI-test ожидания исправлены статическим аудитом.

## Итоговое CI/evidence состояние

Состояние на 2026-10-31: PR #110 head `ef57595` — **все проверки зелёные**, включая первый зелёный `ui-tests` (8/8 selected simulator UI tests, 14m32s) и `ios-compile`.

| Проверка | Статус | Где подтверждено |
| --- | --- | --- |
| Node/Web/Desktop `verify` | ✅ PASS | `ef57595`: API full suite **104 файла / 759 тестов**, web build + **49/49 vitest**, truth-гейт PASS |
| `web-e2e` job (functional + axe) | ✅ PASS | `ef57595`: **17/17 checks passed**, включая «accessibility audit: no critical/serious WCAG 2.x A/AA violations» (job ~21 s functional+audit) |
| `desktop` job (Electron smoke) | ✅ PASS | `ef57595`: Xvfb + `LUXORA_DESKTOP_SMOKE=1`, 37–49 s; sandbox/contextIsolation protections сохранены |
| Apple `swift-package` | ✅ PASS | `ef57595`: merged checkpoint (455 XCTest / 6 skipped / 0 failures + 20 Swift Testing); PR #110 не меняет count |
| Apple `ios-compile` | ✅ PASS | `ef57595` |
| Security and container | ✅ PASS | `ef57595`: filesystem Trivy, dependency-review, codeql, images, calls-smoke incl. TURN auth accept/reject; required «CodeQL» check PASS |
| Calls media (локально, Docker media plane) | ✅ 18/18 | Browser harness против реального media plane: оба peer подключены с bidirectional media, call active через signed webhook, mute в обе стороны, hangup очищает оба overlay, без unexpected console errors |
| Calls media API probe | ✅ 14/14 | JWT join grant + TURN credentials через TLS против локального медиаплана |
| Pagination smoke | ✅ 45 PASS + 1 SKIP | `scripts/qa-api-smoke.mjs` 46-step matrix; SKIP только когда не передан server-log path |
| Public metadata gate | ✅ PASS | `bash infra/validate-public-metadata.sh` → `Public release/ownership metadata truth PASS (Beta-0.1; Flenym).` |

- **Calls media evidence (PR #110):** new media join ordering, signed LiveKit webhook delivery from local Docker media plane, web mute/unmute through the media connection, honest cloud-preview copy; screenshots under ignored `data/qa/calls-shots`. Remaining honest limits: browser/desktop/iPhone calls are **cloud-preview** (server media plane, no E2EE); real-device/CallKit/APNs still open.
- **Pagination evidence:** `pagination.integration.test.ts` follows `nextCursor` to a terminal page, asserts no loss/duplication, terminal cursor, garbage-cursor 400 and limit bounds for the seven lists; API suite 104/759; smoke 45 PASS + 1 optional SKIP. Bounded lists documented as intentional rather than silently truncated.
- **Web a11y/perf/PWA evidence:** axe gate in the committed E2E (`logs` show PASS, empty baseline), 0 findings across dev/preview audits, 11/11 keyboard checks, code-split bundle numbers above, PWA caches only public shell and is production-HTTPS-only. axe is a floor, **not** conformance/assistive-technology proof.
- **Desktop evidence:** custom scheme origin + in-handler CSP + loopback-only API bridge + explicit CORS; CI `desktop` job PASS (49 s). Packaged distribution/signing is **not** shipped.
- **iPhone ui-tests (verified):** first green on `ef57595` — **8/8 selected simulator UI tests passed, 0 failures, 14m32s**, unsigned, artifacts available. История итерации: первый прогон 12m17s с 2 падениями (contrast на auth footnote + empty-search surface не наблюдался); исправлено снятием авто-фокуса клавиатуры перед phone-screen audit, усилением auth footnote до conforming secondary (0.78 white on black), заменой system `ContentUnavailableView` на app-owned русскую no-results surface («Ничего не найдено» / «Попробуйте изменить запрос.») со стабильным `inbox-empty-search`, строгим `#if DEBUG` initial state вместо гонки `.searchable` и общим derived-data путём в CI. Это bounded subset, а не полное UI-покрытие; contrast audit покрывает обнаруженные проблемы, не доказывает конформанс.
- **Историческая справка:** `a801cb3` (protocol 17/104, API 101/743, Apple 396 XCTest + 20 Swift Testing), `df39703` (PR #83 all-green), `beb6ca7` (PR #109: Apple 455 XCTest / 6 skips / 20 Swift Testing, verify PASS, web-e2e 16/16).

## Что работает end-to-end

Auth (register/login/refresh/sessions, phone OTP + password + recovery + binding, profile/patch/avatar), директы/группы/каналы + membership lifecycle, invite-ссылки + approval-очередь, message requests + block/report, текст/reply/edit/delete/forward/pin/reaction/receipts, папки, архив/мьют, черновики, отложенные, транскрипты, privacy policies, уведомления-категории + APNs registration (без реальной доставки), поиск, **полная cursor pagination по спискам**, admin console read-only, export/deletion/retention, security containment, QR device-link 040–043, thumbnails/WAV duration, публичный сайт, web messenger `/app` (auth/shell/history/send/attachments/receipt-truth/realtime v2/message requests/axe-audited a11y/PWA shell; calls media locally verified with mute), iPhone calls/community/safety/account-data surfaces, desktop Electron shell, и **реальное calls media локально (cloud-preview, без E2EE)**.

## Что частично работает / не shipped

- **Calls:** media работает локально против Docker media plane, но это cloud-preview: нет E2EE, нет production SFU/TURN capacity/QoS-доказательств, нет CallKit/push-дозвона, видео/screen share остаются locked; real-device и независимый media security review открыты.
- **Web client остаток:** staging/production hosting с CSP/headers не поставляется репозиторием, формальный WCAG/assistive-technology аудит (axe — floor) и manual review открыты; нет server-synced drafts/folders UI; offline message cache отсутствует (PWA кэширует только public shell); presence приблизительный.
- **Desktop:** Electron shell запускает реальный web-клиент и проходит CI smoke, но packaged signed distribution, updater/anti-rollback и OS vault остаются открытыми; renderer origin — `luxora://app`, API — loopback-only.
- **iPhone:** `LuxoraKit` store всё ещё in-memory (нет durable outbox/cache, pagination, attachment binding, file open/download/share, video picker/playback, reconnect/backoff/sync.required reconciliation); real APNs push/CallKit отсутствуют; новый `ui-tests` job ждёт первого зелёного прогона.
- **Media:** raw upload/storage/download + thumbnails + WAV duration; нет quarantine/transcode/scan pipeline; AVIF/HEIC размеры и non-WAV duration честно `client_declared`.
- **Search:** нет global catalog pagination, contacts policy и offline-индекса.
- **Realtime multi-device:** V2 outbox + fences работают; полных poor-network/process-death доказательств нет.
- **Android:** demo-only.

## Что не работает / заблокировано внешними ресурсами

Production SMS-провайдер, real APNs-доставка, E2EE (сервер читает данные), production SFU/TURN-ёмкость/стоимость relay, production DB/scale/DR, signed artifacts, TestFlight/подпись, внешние аудиты, real-device/release gates, публичные passkeys и contact upload.

## Известные truth-хвосты

- Apple `ios-compile` и `ui-tests` зелёные на `ef57595`; `ui-tests` — bounded offline subset (8/8, 14m32s), не полное UI-покрытие, а axe/contrast audit — не конformance proof.
- Calls — cloud-preview с server media plane: нельзя заявлять E2EE, production calls или «защищённый звонок»; web/desktop/iPhone используют один и тот же media-plane boundary.
- axe-аудит — committed gate (критичные/serious = fail), но **не** доказательство WCAG-конформанса и не замена ручному screen-reader/assistive-tech аудиту.
- PWA `sw.js` кэширует только public shell/static; сообщения и `/v1`/`/v2`/`/health` никогда не кэшируются; preview/dev registration отсутствует.
- Desktop packaged distribution/signing/updater не поставляется; loopback-only API bridge — защитная граница, не production deployment.
- Публичный сайт: `/download` — «Coming Soon», `/status` — статичный снапшот; canonical origin объявлен в metadata, но деплой/хостинг не поставляется.
- Fallback-страница звонков `apps/call-web/index.html` — диагностическая, использует CDN `livekit-client` и `sessionStorage`; не продукт.

## Следующие шаги (после мержа PR #110)

1. **Смержить PR #110** — docs закоммичены; все проверки на `ef57595` зелёные (verify, web-e2e 17/17, desktop, security + required CodeQL, swift-package, ios-compile, ui-tests 8/8/14m32s).
2. **Optional:** вынести calls media E2E в CI (с поднимаемым media stack) — сейчас 18/18 локальный harness в ignored `data/qa`; packaged desktop release/signing/updater; hosted web с CSP/headers.
3. **iPhone remaining:** durable outbox/cache, pagination, file download/share, video playback, real APNs/CallKit, E2EE, real-device/release gates; `ui-tests` зелёный (8/8/14m32s), но это bounded subset — расширять покрытие.
4. **Server:** push-доставка, contact discovery без upload, media transcode/quarantine, production DB/DR, production calls capacity/review; E2EE — отдельная аудируемая программа.
5. **Public site:** deployment/hosting, финальный ручной SEO/a11y pass.
