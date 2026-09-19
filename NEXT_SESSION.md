# Luxora — NEXT SESSION

**Точка продолжения (обновлено 2026-09-19):** export (035, `5df2317`, CI PASS), deletion (036), media binaries и export retention worker (037, `8b0b665`, CI PASS), image thumbnails (`8bae86a`, CI PASS: Node/Web/Desktop 4m27s, Security 2m31s), WAV duration (`b873747`, CI PASS: Node/Web/Desktop 3m13s, Security 2m7s) готовы и запушены. Локально зелёный: protocol 17/104 build, API 91/703, оба typecheck; последняя миграция 037.

## Как продолжить без потери контекста

1. Прочитай `PROJECT_STATE.md`, затем `TODO.md` (секция autonomous-трекера вверху).
2. Проверь состояние: `git status --short --branch`, `git log --oneline -5`,
   `gh run list --repo Flenym/Luxora --limit 4`.
3. Канонические контракты: `packages/protocol/src/index.ts`,
    `services/api/src/infrastructure/migrations.ts` (последняя `037`),
   `docs/specs/IPHONE_FUNCTIONAL_COMPLETION_MATRIX_RU.md` (частично устарела).

## Ближайшая очередь

1. Calls signaling first slice (create/get/end поверх call-control executor); остаток — invite/ring/push/grants/webhooks, затем search.
2. Export/delete, QR-linking, contact discovery.
3. Финальный QA.

## Правила цикла (не нарушать)

- Server-first: сначала protocol → migration → store → service → routes → тесты.
- Перед пушем: `npm --prefix packages/protocol run build`, оба typecheck,
  **полный** `npm --prefix services/api test` (86 файлов / ~3 мин). Частичные
  прогоны уже дважды давали красный CI.
- Swift проверить нельзя локально (Windows) — только CI. После правок Swift
  ждать Apple Swift + IPA.
- Не коммитить `luxora.json` (сессионный файл) и `dist/`.
- Не выдавать DEBUG-фикстуры за продукт; сервер читает сообщения (не E2EE).
- После каждого slice: TODO + PROJECT_STATE + этот файл.

## Известные детали экспортного слайца

- Скачивание: `GET /v1/data-exports/:id/download` (по спеке §14).
- Шаг-up “phishing_resistant” не реализован как отдельный purpose (StepUpTokenPurpose — только authenticator.add/revoke); честная декларация «сильнейший настроенный аутентификатор + предупреждение о миграции».
- Export/Delete done: `POST/GET/DELETE /v1/account/deletion`, state machine `none → scheduled → deletion_pending → executing → completed|failed_retryable`, grace 7 дней, cancel только в `scheduled`. Sweep на старте + каждые 10 минут. Tombstone: `username → deleted:{id}`, `display_name → Deleted Account`, `deleted_at` в users + `WHERE deleted_at IS NULL` в lookup (findUserByUsername/Discovery/search). Execution ревокит все sessions + push, tombstone профиль, помечает owned attachments удалёнными, истекает export-артефакты. Step-up “phishing_resistant” в cancel не реализован как отдельный purpose — как у экспорта: сильнейший настроенный аутентификатор + предупреждение о миграции.