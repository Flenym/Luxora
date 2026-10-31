# Luxora — NEXT SESSION

**Точка продолжения (обновлено 2026-10-31, финальный docs-проход):** ветка `feature/ios-calls-signaling` = PR #83 против `main`, **head `df39703`** (локально 29 коммитов ahead of `origin/main`), PR не смержен — **финальный CI на `df39703` полностью зелёный, остался мерж**. В ветке: iOS calls signaling + Call UI + LiveKit voice + **calls product surface** (история звонков, per-chat call log, call-back, in-call overlay с серверно-заякоренным таймером и honest mute, locked/limited gating; video locked — join-grant выдаёт только микрофон) + **community management UI** (invite links shown-once + revoke, join-request queue, ownership-transfer ceremony, join-by-link), серверный `call.state.changed`, capabilities-гейт звонков по медиаплану, медиастек start.bat/LiveKit/dev TURN/Caddy/CloudPub, web call fallback, **публичный продуктовый сайт (завершён)** и **web messenger client `/app` (реализован; 49 Vitest)**, CORS-фикс, direct-chat relationship guard, dependency-фиксы + CodeQL re-enabled, dev TURN image на pinned Alpine 3.24.3, docs-sync.

**CI на 2026-10-31 (финальный head `df39703` — ALL GREEN):** Node/Web/Desktop `verify` SUCCESS (49/49 web-тестов в CI); Apple Swift `swift-package` SUCCESS (396 XCTest + 6 expected skips + 20 Swift Testing, включая `CallHistoryTests`/`CommunityManagementStoreTests`) и `ios-compile` SUCCESS; Security and container SUCCESS (filesystem Trivy, dependency-review, CodeQL job, API/OTP images, internal `luxora-turn`, `make calls-smoke` incl. TURN auth accept/reject) и обязательный status-check «CodeQL» SUCCESS. Исторические снапшоты: `32e0d62` (Node/Security), `b682d99`/`d0a7a8f`/`32e0d62` (swift-package), `380881f` (ios-compile); на `d0a7a8f` ios-compile падал из-за `PhoneCommunityViews.swift` optional participant-resolver unwrap — исправлено в `df39703`.

## Как продолжить без потери контекста

1. Прочитай `PROJECT_STATE.md` (final state + CI-таблица), затем `WEB.md` (сайт/клиент и gaps) и `TODO.md` (очередь и автономный трекер).
2. Проверь состояние без git-записей: `git status --short --branch`, `git log --oneline origin/main..HEAD`, `gh run list --repo Flenym/Luxora --branch feature/ios-calls-signaling --limit 8`, `gh pr view 83 --json statusCheckRollup`.
3. Канонические контракты: `packages/protocol/src/index.ts`, `services/api/src/infrastructure/migrations.ts` (последняя `043_device_link_step_up`), `services/api/src/http/routes.ts` (`/v1/capabilities`), `services/api/src/app.ts` (CORS), `apps/web/src/app/contract.ts`, `docs/specs/CALLS_PLATFORM.md`, `docs/specs/IPHONE_FUNCTIONAL_COMPLETION_MATRIX_RU.md`.
4. Truth-гейт перед любым пушем: `bash infra/validate-public-metadata.sh` (WSL/Git Bash) — должен печатать `Public release/ownership metadata truth PASS (Beta-0.1; Flenym).`, плюс `make check-truth` не должен находить русские E2EE/call-копии в коде клиентов (`apps/web/src/pages/**` и публичная документация сайта исключены из этого blunt-гейта).

## Как запустить (Windows-воркспейс)

- **API + медиастек + публикация:** `start.bat` (или `powershell -File scripts/start-all.ps1`). Требуется Docker Desktop и залогиненный CloudPub CLI; поднимает LiveKit/dev TURN/Caddy TLS, генерирует `data/media.env`, запускает API на `127.0.0.1:2222` и пишет публичный URL в `data/public-origins.txt`. Без медиаплана: `scripts/start-server.ps1` (API на 2222 без звонков; `features.calls:false`).
- **Проверка звонков:** `GET http://127.0.0.1:2222/v1/capabilities` → `features.calls:true` только при полном `CALLS_*`-конфиге; fallback-страница `apps/call-web/index.html` принимает `?api=http://127.0.0.1:2222`.
- **Web:** `npm --prefix apps/web ci`, затем `npm --prefix apps/web run dev` (Vite на `0.0.0.0:4173`, proxy `/v1`,`/v2`,`/health` → `127.0.0.1:2222`). Маркетинг — `http://127.0.0.1:4173/`, мессенджер — `http://127.0.0.1:4173/app`. Проверки: `npm --prefix apps/web run typecheck`, `npm --prefix apps/web run build`, `npm --prefix apps/web test` (**49 Vitest**: api 17, realtime 13, store 19), `npm --prefix apps/web run preview`.
- **Desktop:** сначала `npm --prefix apps/web run build`, затем `npm --prefix apps/desktop run typecheck` / `run start` (shell грузит `apps/web/dist`, теперь с `/app`).
- **Полная проверка JS:** `npm --prefix packages/protocol run build`, оба typecheck, полный `npm --prefix services/api test` (**103 файла / 749 тестов** по последнему полному прогону), `npm --prefix packages/passkey-domain test` (70), `npm --prefix packages/call-control test` (23).
- **Swift:** локально на Windows не собирается — только Apple CI (`swift test --package-path apps/apple` на macOS; 396 XCTest + 6 expected skips + 20 Swift Testing — зелёные на `b682d99`/`d0a7a8f`/`32e0d62`). Apple IPA workflow запускается только на `main`.

## Ближайшая очередь

1. **Смержить PR #83** (Lead). Финальный CI на `df39703` уже полностью зелёный: Node/Web/Desktop verify, Apple Swift `swift-package` + `ios-compile`, Security and container (dependency-review + CodeQL + filesystem/image) и обязательный «CodeQL» check — SUCCESS.
2. **iPhone remaining (planned/next, НЕ shipped):** safety reports UI и account export/deletion UI (server + protocol готовы, iPhone client/views не написаны); реальный APNs push/CallKit — внешние гейты; durable outbox/cache, pagination, file open/download/share, video playback; real-device media/QoS.
3. **Web follow-up:** hosting CSP/headers + решение sessionStorage-refresh vs secure HttpOnly; закоммитить или явно оставить локальным браузерный E2E harness; desktop shell wiring; server-synced drafts/folders UI — отдельная фича; Web Push/PWA/offline cache не реализованы.
4. **Public site residuals:** деплой/хостинг (canonical `https://luxora.app` объявлен в metadata, но не поставляется репозиторием), честность `/status` и `/download`, финальный ручной SEO/a11y pass.
5. **Server remainders:** push-доставка (внешний блок), contact discovery БЕЗ upload, media transcode/quarantine, production DB/DR, production calls capacity/review; E2EE — отдельная аудируемая программа.

## Правила цикла (не нарушать)

- Server-first: protocol → migration → store → service → routes → tests.
- Перед пушем — полный API suite, оба typecheck, protocol build, web tests; частичные прогоны уже давали красный CI.
- Swift проверяется только в CI; после Swift-правок ждать Apple Swift (для iPhone-слайсов — обязательно до «done»).
- Не коммитить `luxora.json`, `dist/`, `data/`; не выдавать DEBUG-фикстуры за продукт.
- Не заявлять E2EE, real push, production SMS или production-звонки; `features.calls` — только из capabilities, не хардкодом; web-клиент — developer preview, пока нет hosting/CSP/E2E/audit.
- После каждого слайса — TODO + PROJECT_STATE + этот файл; docs-истина важнее красивого текста.
