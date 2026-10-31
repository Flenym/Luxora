# Luxora — NEXT SESSION

**Точка продолжения (обновлено 2026-10-31):** ветка `feature/ios-calls-signaling` = PR #83 против `main` (13 коммитов: iOS calls signaling + Call UI + LiveKit voice, серверный `call.state.changed`, capabilities-гейт звонков по медиаплану, медиастек start.bat/LiveKit/coturn/Caddy/CloudPub, web call fallback, публичный продуктовый сайт, CI-фиксы). PR **не смержен**; web-клиент мессенджера и CI-фиксы дописываются в этой же сессии/ветке.

## Как продолжить без потери контекста

1. Прочитай `PROJECT_STATE.md` (актуальный state + evidence), затем `WEB.md` (статус сайта/клиента) и `TODO.md` (очередь и автономный трекер).
2. Проверь состояние без git-записей: `git status --short --branch`, `git log --oneline origin/main..HEAD`, `gh run list --repo Flenym/Luxora --branch feature/ios-calls-signaling --limit 6`.
3. Канонические контракты: `packages/protocol/src/index.ts`, `services/api/src/infrastructure/migrations.ts` (последняя `043_device_link_step_up`), `services/api/src/http/routes.ts` (`/v1/capabilities`), `docs/specs/CALLS_PLATFORM.md`, `docs/specs/IPHONE_FUNCTIONAL_COMPLETION_MATRIX_RU.md`.
4. Truth-гейт перед любым пушем: `bash infra/validate-public-metadata.sh` (WSL/Git Bash) — должен печатать `Public release/ownership metadata truth PASS (Beta-0.1; Flenym).`, плюс `make check-truth` не должен находить русские E2EE/call-копии в коде клиентов (`apps/web/src/pages/**` и публичная документация сайта из-под этого blunt-гейта исключены коммитом `2baac72`).

## Как запустить (Windows-воркспейс)

- **API + медиастек + публикация:** `start.bat` (или `powershell -File scripts/start-all.ps1`). Требуется Docker Desktop и залогиненный CloudPub CLI; поднимает LiveKit/coturn/Caddy TLS, генерирует `data/media.env`, запускает API на `127.0.0.1:2222` и пишет публичный URL в `data/public-origins.txt`. Без медиаплана: `scripts/start-server.ps1` (API на 2222 без звонков).
- **Проверка звонков:** `GET http://127.0.0.1:2222/v1/capabilities` → `features.calls:true` только при полном `CALLS_*`-конфиге; fallback-страница `apps/call-web/index.html` открывается в браузере и принимает `?api=http://127.0.0.1:2222`.
- **Web:** `npm --prefix apps/web ci`, `npm --prefix apps/web run dev` (Vite на `0.0.0.0:4173`), `npm --prefix apps/web run typecheck`, `npm --prefix apps/web run build`, `npm --prefix apps/web run preview`; тесты пакета — `npm --prefix apps/web run test` (Vitest).
- **Desktop:** сначала `npm --prefix apps/web run build`, затем `npm --prefix apps/desktop run typecheck` / `run start` (shell грузит `apps/web/dist`).
- **Полная проверка JS:** `npm --prefix packages/protocol run build`, оба typecheck, полный `npm --prefix services/api test` (101 файл / 743 теста по состоянию на 2026-10-31), `npm --prefix packages/passkey-domain test` (70), `npm --prefix packages/call-control test` (23).
- **Swift:** локально на Windows не собирается — только Apple CI (`swift test --package-path apps/apple` на macOS, 396 XCTest + 20 Swift Testing на коммите `a801cb3`). Apple IPA workflow запускается только на `main`.

## Ближайшая очередь

> Приоритет на 31 октября 2026 по указанию пользователя — **iPhone**. Слайсы ниже
> реализуются параллельно; docs не должны называть их готовыми до подтверждения
> Apple CI green от Lead.

1. **iPhone focus — три in-progress слайса:**
   - **Calls product surface (ios-calls):** вкладка Calls сейчас locked-заглушка;
     нет call history UI, per-chat call log, in-call mute/speaker; video call
     остаётся locked (серверный grant выдаёт только микрофон).
   - **Community management UI (ios-community):** API-клиент и модели invite
     links/join requests/ownership transfer есть, UI ещё нет.
   - **Safety reports + account data UI (ios-safety):** сервер/protocol report,
     export (035), deletion (036) есть; iPhone client/UI отсутствует.
2. **Web messenger client** — довести `apps/web/src/app` (API/realtime/store/UI) до
   feature-complete, проверить в браузере на живом API, добавить тесты в CI, затем
   Phase B docs-слайса docs-truth (WEB.md + README web rows и т.д. — точный список
   фич пришлёт Lead).
3. **CI:** `ci-deps` — dependency-review + filesystem/image Security; после
   `2baac72` перезапустить Node/Web/Desktop workflow и убедиться, что
   `make check-truth` зелёный; решить вопрос CodeQL (re-enable или
   документированный отказ). Apple CI должен быть зелёным на финальном коммите
   iPhone-слайсов.
4. **Public site QA:** mojibake `—` в `apps/web/index.html`, truth-копии, SEO/meta,
   a11y, responsive, hosting headers; `/download` и `/status` должны оставаться
   честными.
5. **Desktop shell wiring** после клиента: CSP, навигация, permission-хендлеры,
   меню New Message/Search против реального клиента.
6. **iPhone technical remainders:** durable outbox/cache + pagination +
   attachment binding, file open/download/share, video picker/playback,
   push/CallKit/video-call (внешние/серверные гейты), real-device media/QoS.
7. **Server remainders:** push-доставка (внешний блок), contact discovery БЕЗ
   upload, media transcode/quarantine, production DB/DR.

## Правила цикла (не нарушать)

- Server-first: protocol → migration → store → service → routes → tests.
- Перед пушем — полный API suite, оба typecheck, protocol build; частичные прогоны уже давали красный CI.
- Swift проверяется только в CI; после Swift-правок ждать Apple Swift.
- Не коммитить `luxora.json`, `dist/`, `data/`; не выдавать DEBUG-фикстуры за продукт.
- Не заявлять E2EE, real push, production SMS или production-звонки; `features.calls` — только из capabilities, не хардкодом.
- После каждого слайса — TODO + PROJECT_STATE + этот файл; docs-истина важнее красивого текста.
