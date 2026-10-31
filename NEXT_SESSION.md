# Luxora — NEXT SESSION

**Точка продолжения (обновлено 2026-10-31, PR #109):** PR #83 (iOS calls/community + web client) **смержен в `main`** (`919d0f6`). Текущий PR **#109** — ветка `feature/iphone-safety-and-e2e`, **head `beb6ca7`** (4 коммита ahead of `main`): iPhone **safety reports + account data** surfaces (`LuxoraSafetyAPIClient`, `SafetyReportsStore`, `AccountDataStore`, `PhoneSafetyAndDataViews`, ApplicationSession/settings wiring, «Пожаловаться» в message menu, 26 новых contract/store тестов) и **web messenger browser E2E как committed GitHub Actions gate** (`tools/web-e2e` + job `web-e2e`, 16/16 checks). Все проверки на `beb6ca7` зелёные; PR ожидает мержа после коммита docs.

**CI на 2026-10-31 (head `beb6ca7` — ALL GREEN):** Apple Swift `swift-package` SUCCESS — **455 XCTest executed, 6 skipped, 0 failures** + **20 Swift Testing** (включая calls/community и новые safety/account-data тесты), `ios-compile` PASS (4m32s); Node/Web/Desktop `verify` SUCCESS — API **103/749**, web build + **49/49 vitest**; **`web-e2e` job SUCCESS — 16/16 checks** в GitHub Actions; Security and container SUCCESS (filesystem Trivy, dependency-review, codeql, API/OTP images, internal `luxora-turn`, `make calls-smoke` incl. TURN auth accept/reject); обязательный status-check «CodeQL» SUCCESS.

## Как продолжить без потери контекста

1. Прочитай `PROJECT_STATE.md` (final state + CI-таблица), затем `WEB.md` (сайт/клиент и gaps), `TESTING.md` (web E2E gate) и `TODO.md` (очередь и автономный трекер).
2. Проверь состояние без git-записей: `git status --short --branch`, `git log --oneline origin/main..HEAD`, `gh run list --repo Flenym/Luxora --branch feature/iphone-safety-and-e2e --limit 8`, `gh pr view 109 --json statusCheckRollup`.
3. Канонические контракты: `packages/protocol/src/index.ts`, `services/api/src/infrastructure/migrations.ts` (последняя `043_device_link_step_up`), `services/api/src/http/routes.ts` (`/v1/capabilities`), `services/api/src/app.ts` (CORS), `apps/web/src/app/contract.ts`, `apps/apple/Sources/LuxoraKit/Services/LuxoraSafetyAPIClient.swift`, `docs/specs/CALLS_PLATFORM.md`, `docs/specs/IPHONE_FUNCTIONAL_COMPLETION_MATRIX_RU.md`.
4. Truth-гейт перед любым пушем: `bash infra/validate-public-metadata.sh` (WSL/Git Bash) — должен печатать `Public release/ownership metadata truth PASS (Beta-0.1; Flenym).`, плюс `make check-truth` не должен находить русские E2EE/call-копии в коде клиентов (`apps/web/src/pages/**` и публичная документация сайта исключены из этого blunt-гейта).

## Как запустить (Windows-воркспейс)

- **API + медиастек + публикация:** `start.bat` (или `powershell -File scripts/start-all.ps1`). Требуется Docker Desktop и залогиненный CloudPub CLI; поднимает LiveKit/dev TURN/Caddy TLS, генерирует `data/media.env`, запускает API на `127.0.0.1:2222` и пишет публичный URL в `data/public-origins.txt`. Без медиаплана: `scripts/start-server.ps1` (API на 2222 без звонков; `features.calls:false`).
- **Проверка звонков:** `GET http://127.0.0.1:2222/v1/capabilities` → `features.calls:true` только при полном `CALLS_*`-конфиге; fallback-страница `apps/call-web/index.html` принимает `?api=http://127.0.0.1:2222`.
- **Web:** `npm --prefix apps/web ci`, затем `npm --prefix apps/web run dev` (Vite на `0.0.0.0:4173`, proxy `/v1`,`/v2`,`/health` → `127.0.0.1:2222`). Маркетинг — `http://127.0.0.1:4173/`, мессенджер — `http://127.0.0.1:4173/app`. Проверки: `npm --prefix apps/web run typecheck`, `npm --prefix apps/web run build`, `npm --prefix apps/web test` (**49 Vitest**: api 17, realtime 13, store 19), `npm --prefix apps/web run preview`.
- **Web browser E2E (committed gate):** `npm --prefix tools/web-e2e ci`, затем `npm --prefix tools/web-e2e test` (self-contained: поднимает API на 2222 + `vite preview` на 4173, нужен Chrome; 16 user-observable checks). Attach-режим против уже запущенных серверов: `node tools/web-e2e/runner.mjs --attach` (или `--api-base http://127.0.0.1:2222 --web-base http://127.0.0.1:4173`); self-check API spawn/env: `node tools/web-e2e/runner.mjs --api-only-check` (порт 2232). Детали — `tools/web-e2e/README.md`.
- **Desktop:** сначала `npm --prefix apps/web run build`, затем `npm --prefix apps/desktop run typecheck` / `run start` (shell грузит `apps/web/dist`, теперь с `/app`).
- **Полная проверка JS:** `npm --prefix packages/protocol run build`, оба typecheck, полный `npm --prefix services/api test` (**103 файла / 749 тестов**), `npm --prefix packages/passkey-domain test` (70), `npm --prefix packages/call-control test` (23).
- **Swift:** локально на Windows не собирается — только Apple CI (`swift test --package-path apps/apple` на macOS; на `beb6ca7` — **455 XCTest + 6 expected skips + 20 Swift Testing**). Apple IPA workflow запускается только на `main`.

## Ближайшая очередь

1. **Смержить PR #109** после коммита docs (head `beb6ca7` уже all-green). `main` уже содержит PR #83 (`919d0f6`).
2. **iPhone remaining (planned/next, НЕ shipped):** real APNs push + CallKit, E2EE, video/screen-share; durable outbox/cache, pagination, file download/share, video playback; real-device media/QoS и release-гейты. Safety reports/account-data UI больше не входят в очередь — shipped.
3. **Web follow-up:** hosting CSP/headers + решение sessionStorage vs HttpOnly, desktop shell wiring, server-synced drafts/folders UI, WCAG-аудит `/app` (browser E2E уже в CI).
4. **Public site residuals:** деплой/хостинг (canonical `https://luxora.app` объявлен в metadata, но не поставляется репозиторием), честность `/status` и `/download`, финальный ручной SEO/a11y pass.
5. **Server remainders:** push-доставка (внешний блок), contact discovery БЕЗ upload, media transcode/quarantine, production DB/DR, production calls capacity/review; E2EE — отдельная аудируемая программа.

## Правила цикла (не нарушать)

- Server-first: protocol → migration → store → service → routes → tests.
- Перед пушем — полный API suite, оба typecheck, protocol build, web tests; частичные прогоны уже давали красный CI.
- Swift проверяется только в CI; после Swift-правок ждать Apple Swift.
- Не коммитить `luxora.json`, `dist/`, `data/`; не выдавать DEBUG-фикстуры за продукт.
- Не заявлять E2EE, real push, production SMS или production-звонки; `features.calls` — только из capabilities, не хардкодом; web-клиент — developer preview пока нет hosting/CSP/WCAG; safety/account-data — only with server-readable cloud-preview consent и без instant-deletion claims.
- После каждого слайса — TODO + PROJECT_STATE + этот файл; docs-истина важнее красивого текста.
