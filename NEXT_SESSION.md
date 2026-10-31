# Luxora — NEXT SESSION

**Точка продолжения (обновлено 2026-10-31, PR #110):** PR #109 (iPhone safety/account data) **смержен в `main`** (`0fda88a`). Текущий PR **#110** — ветка `feature/completeness-pass`, **head `260857f`** (7 коммитов ahead of `main`): **реальное calls media end-to-end локально** (join только после accept, signed LiveKit webhooks, web mute/unmute), **завершённая cursor pagination** (7 endpoints), **desktop Electron client** (`luxora://app` + loopback API bridge + CI smoke), **web a11y/perf/PWA** (axe в committed E2E, 0 findings, code splitting, honest PWA shell), **iPhone `ui-tests` job** (bounded offline subset на симуляторе). Docs обновлены; PR ожидает коммита docs и мержа после ios-compile + ui-tests.

**CI на 2026-10-31 (head `260857f`):** verify PASS (API **104/759**, web build + **49/49 vitest**); `web-e2e` PASS (**17/17** functional + axe); `desktop` PASS (**49 s**, Xvfb); Security and container PASS (filesystem Trivy, dependency-review, codeql, API/OTP images, internal `luxora-turn`, `make calls-smoke` incl. TURN auth accept/reject) + required «CodeQL» PASS; Apple `swift-package` PASS; **`ios-compile` и `ui-tests` на момент записи ещё выполнялись** — первый зелёный результат не подтверждён.

## Как продолжить без потери контекста

1. Прочитай `PROJECT_STATE.md` (state + CI-таблица), затем `WEB.md`, `DESKTOP.md`, `TESTING.md` и `TODO.md`.
2. Проверь состояние без git-записей: `git status --short --branch`, `git log --oneline origin/main..HEAD`, `gh run list --repo Flenym/Luxora --branch feature/completeness-pass --limit 10`, `gh pr view 110 --json statusCheckRollup`.
3. Канонические контракты: `packages/protocol/src/index.ts`, `services/api/src/infrastructure/migrations.ts` (последняя `043_device_link_step_up`), `services/api/src/http/routes.ts` (`/v1/capabilities`, pagination), `services/api/src/app.ts` (CORS), `apps/web/src/app/contract.ts`, `apps/desktop/src/main.ts`, `tools/web-e2e/`, `docs/specs/CALLS_PLATFORM.md`, `docs/specs/IPHONE_FUNCTIONAL_COMPLETION_MATRIX_RU.md`.
4. Truth-гейт перед любым пушем: `bash infra/validate-public-metadata.sh` (WSL/Git Bash) — должен печатать `Public release/ownership metadata truth PASS (Beta-0.1; Flenym).`, плюс `make check-truth` не должен находить русские E2EE/call-копии в коде клиентов.

## Как запустить (Windows-воркспейс)

- **API + медиастек + публикация:** `start.bat` (или `powershell -File scripts/start-all.ps1`) — LiveKit/dev TURN/Caddy TLS, `data/media.env`, API на `127.0.0.1:2222`, CloudPub. Без медиаплана: `scripts/start-server.ps1` (`features.calls:false`).
- **Calls media локально:** `powershell -File scripts/dev-calls.ps1` поднимает Docker media plane, задаёт signed webhook URL (`/v1/internal/calls/livekit-webhook`) и `VITE_LUXORA_API` для calls API на 8080; `GET http://127.0.0.1:8080/v1/capabilities` → `features.calls:true`. Локальные calls evidence-скрипты (browser 18/18, API probe 14/14) — в ignored `data/qa/` (`calls-browser-e2e.mjs`, `calls-probe.mjs`), не в CI.
- **Web:** `npm --prefix apps/web ci`, `npm --prefix apps/web run dev` (Vite `0.0.0.0:4173`, proxy `/v1`,`/v2`,`/health` → `127.0.0.1:2222`); `/app` — мессенджер. Проверки: `typecheck`, `build`, `test` (49 Vitest), `preview`.
- **Web E2E + axe:** `npm --prefix tools/web-e2e ci`, затем `npm --prefix tools/web-e2e test` (self-contained API :2222 + preview :4173, нужен Chrome; **17/17** checks с axe); attach-режим: `node tools/web-e2e/runner.mjs --attach`; только axe: `npm --prefix tools/web-e2e run a11y` / `node tools/web-e2e/runner.mjs --a11y-only --attach`. Детали — `tools/web-e2e/README.md`.
- **Desktop:** `npm --prefix apps/web run build`, затем `npm --prefix apps/desktop run typecheck` / `run start` (Electron грузит `luxora://app` через bridge к loopback API); smoke-режим: `LUXORA_DESKTOP_SMOKE=1`.
- **Полная проверка JS:** `npm --prefix packages/protocol run build`, оба typecheck, `npm --prefix services/api test` (**104 файла / 759 тестов**), `npm --prefix packages/passkey-domain test` (70), `npm --prefix packages/call-control test` (23), `node scripts/qa-api-smoke.mjs` (46-step matrix: 45 PASS + 1 optional SKIP без server-log path).
- **Swift:** локально на Windows не собирается — только Apple CI (`swift test --package-path apps/apple`; merged checkpoint 455 XCTest + 6 expected skips + 20 Swift Testing). Новый `ui-tests` job — bounded offline simulator subset; первый зелёный прогон подтвердить.

## Ближайшая очередь

1. **Смержить PR #110** после коммита docs — дождаться `ios-compile` и первого `ui-tests` результата; не заявлять их зелёными до завершения.
2. **Follow-ups:** optional calls media E2E в CI (с поднимаемым media stack; сейчас 18/18 локальный ignored harness); packaged desktop release/signing/updater; hosted web с CSP/headers; manual WCAG/assistive-technology аудит `/app` (axe — floor, не конformance proof).
3. **iPhone remaining (НЕ shipped):** real APNs push/CallKit, E2EE, durable outbox/cache, pagination, file download/share, video playback, real-device media/QoS, release-гейты.
4. **Public site residuals:** deployment/hosting, `/status`/`/download` честность, ручной SEO/a11y pass.
5. **Server remainders:** push-доставка (внешний блок), contact discovery БЕЗ upload, media transcode/quarantine, production DB/DR, production calls capacity/review; E2EE — отдельная аудируемая программа.

## Правила цикла (не нарушать)

- Server-first: protocol → migration → store → service → routes → tests.
- Перед пушем — полный API suite, оба typecheck, protocol build, web tests/E2E; частичные прогоны уже давали красный CI.
- Swift проверяется только в CI; после Swift-правок ждать Apple Swift (ios-compile + ui-tests).
- Не коммитить `luxora.json`, `dist/`, `data/` (calls evidence остаётся в ignored `data/qa`); не выдавать DEBUG-фикстуры за продукт.
- Не заявлять E2EE, real push, production SMS или production-звонки; calls — cloud-preview media plane; `features.calls` — только из capabilities; PWA никогда не кэширует сообщения; axe — floor, не конformance proof.
- После каждого слайса — TODO + PROJECT_STATE + этот файл; docs-истина важнее красивого текста.
