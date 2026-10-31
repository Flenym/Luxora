# Luxora — NEXT SESSION

**Точка продолжения (обновлено 2026-10-31):** ветка `feature/ios-calls-signaling` = PR #83 против `main`, head на момент записи `ec6846b` (**21 коммит**; счётчик может расти): iOS calls signaling + Call UI + LiveKit voice + calls product surface (история звонков, per-chat лог, in-call overlay/mute) + community management (invite links/join requests/ownership transfer/join-by-link), серверный `call.state.changed`, capabilities-гейт звонков по медиаплану, медиастек start.bat/LiveKit/coturn/Caddy/CloudPub, web call fallback, **публичный продуктовый сайт (завершён)** и **web messenger client `/app` (реализован, 48 Vitest PASS)**, CORS-фикс, dependency-фиксы + CodeQL re-enabled, security-фикс heartbeat timers/coturn pin, docs-sync. PR **не смержен**.

**CI на 2026-10-31:** `4918cfa` — Node/Web/Desktop **SUCCESS** (48 web-тестов прошли), Apple Swift **FAILURE** (compile errors community-management в `ApplicationSession.swift`), Security FAILURE; на `ec6846b` dependency-review и job codeql — SUCCESS, `filesystem-and-image` — FAILURE («Calls Compose security invariants failed»), обязательный status-check «CodeQL» — FAILURE (default setup не настроен), Node/Apple ещё выполняются. Не заявлять Apple/Security зелёными до завершённого прогона.

## Как продолжить без потери контекста

1. Прочитай `PROJECT_STATE.md` (актуальный state + evidence), затем `WEB.md` (сайт/клиент и gaps) и `TODO.md` (очередь и автономный трекер).
2. Проверь состояние без git-записей: `git status --short --branch`, `git log --oneline origin/main..HEAD`, `gh run list --repo Flenym/Luxora --branch feature/ios-calls-signaling --limit 6`, `gh pr view 83 --json statusCheckRollup`.
3. Канонические контракты: `packages/protocol/src/index.ts`, `services/api/src/infrastructure/migrations.ts` (последняя `043_device_link_step_up`), `services/api/src/http/routes.ts` (`/v1/capabilities`), `services/api/src/app.ts` (CORS), `apps/web/src/app/contract.ts`, `docs/specs/CALLS_PLATFORM.md`, `docs/specs/IPHONE_FUNCTIONAL_COMPLETION_MATRIX_RU.md`.
4. Truth-гейт перед любым пушем: `bash infra/validate-public-metadata.sh` (WSL/Git Bash) — должен печатать `Public release/ownership metadata truth PASS (Beta-0.1; Flenym).`, плюс `make check-truth` не должен находить русские E2EE/call-копии в коде клиентов (`apps/web/src/pages/**` и публичная документация сайта исключены коммитом `2baac72`).

## Как запустить (Windows-воркспейс)

- **API + медиастек + публикация:** `start.bat` (или `powershell -File scripts/start-all.ps1`). Требуется Docker Desktop и залогиненный CloudPub CLI; поднимает LiveKit/coturn/Caddy TLS, генерирует `data/media.env`, запускает API на `127.0.0.1:2222` и пишет публичный URL в `data/public-origins.txt`. Без медиаплана: `scripts/start-server.ps1` (API на 2222 без звонков; `features.calls:false`).
- **Проверка звонков:** `GET http://127.0.0.1:2222/v1/capabilities` → `features.calls:true` только при полном `CALLS_*`-конфиге; fallback-страница `apps/call-web/index.html` принимает `?api=http://127.0.0.1:2222`.
- **Web:** `npm --prefix apps/web ci`, затем `npm --prefix apps/web run dev` (Vite на `0.0.0.0:4173`, proxy `/v1`,`/v2`,`/health` → `127.0.0.1:2222`). Маркетинг — `http://127.0.0.1:4173/`, мессенджер — `http://127.0.0.1:4173/app`. Проверки: `npm --prefix apps/web run typecheck`, `npm --prefix apps/web run build`, `npm --prefix apps/web test` (**48 Vitest**: api 17, realtime 12, store 19), `npm --prefix apps/web run preview`.
- **Desktop:** сначала `npm --prefix apps/web run build`, затем `npm --prefix apps/desktop run typecheck` / `run start` (shell грузит `apps/web/dist`, теперь с `/app`).
- **Полная проверка JS:** `npm --prefix packages/protocol run build`, оба typecheck, полный `npm --prefix services/api test` (101 файл / 743 теста по последнему полному замеру), `npm --prefix packages/passkey-domain test` (70), `npm --prefix packages/call-control test` (23).
- **Swift:** локально на Windows не собирается — только Apple CI (`swift test --package-path apps/apple` на macOS; последний завершённый замер — 396 XCTest + 20 Swift Testing на `a801cb3`; прогон на `4918cfa` ждёт завершения). Apple IPA workflow запускается только на `main`.

## Ближайшая очередь

> Приоритет на 31 октября 2026 по указанию пользователя — **iPhone**. Ни один
> in-progress iPhone-слайс не считается готовым до Apple CI green + подтверждения Lead.

1. **Дождаться и подтвердить CI на head PR:** Node/Web/Desktop (48 web-тестов), Security
   (dependency-review, filesystem/image, CodeQL) и Apple Swift (iPhone calls/community).
   Зафиксировать evidence и только потом считать CI зелёным.
2. **iPhone остатки:** safety reports + account export/deletion CLI/UI (ios-safety, в работе),
   затем real-device/offline gates. iPhone calls — audio only + capability-gated; без
   CallKit/push/video/screen-share/media-E2EE.
3. **Web follow-up:** решить, коммитить ли headless-Chrome E2E в CI (сейчас локальный harness);
   desktop shell wiring; hosting CSP/headers + решение sessionStorage-refresh vs secure HttpOnly;
   server-synced drafts/folders UI — отдельная фича; Web Push/PWA/offline cache — не реализованы.
4. **Public site residuals:** деплой/хостинг (canonical `https://luxora.app` объявлен в metadata,
   но не поставляется репозиторием), честность `/status` и `/download`, ручной SEO/a11y pass,
   `apps/web/README.md` refresh (зона web-team, сейчас устарел).
5. **Desktop shell wiring** после клиента: CSP, навигация, permission-хендлеры, меню
   New Message/Search против реального `/app`-клиента.
6. **iPhone technical remainders:** durable outbox/cache + pagination + attachment binding,
   file open/download/share, video picker/playback, push/CallKit/video-call (внешние/серверные
   гейты), real-device media/QoS.
7. **Server remainders:** push-доставка (внешний блок), contact discovery БЕЗ upload,
   media transcode/quarantine, production DB/DR.

## Правила цикла (не нарушать)

- Server-first: protocol → migration → store → service → routes → tests.
- Перед пушем — полный API suite, оба typecheck, protocol build, web tests; частичные прогоны уже давали красный CI.
- Swift проверяется только в CI; после Swift-правок ждать Apple Swift (для iPhone-слайсов — обязательно до «done»).
- Не коммитить `luxora.json`, `dist/`, `data/`; не выдавать DEBUG-фикстуры за продукт.
- Не заявлять E2EE, real push, production SMS или production-звонки; `features.calls` — только из capabilities, не хардкодом; web-клиент — developer preview, пока нет hosting/CSP/E2E/audit.
- После каждого слайса — TODO + PROJECT_STATE + этот файл; docs-истина важнее красивого текста.
