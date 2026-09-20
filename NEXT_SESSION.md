# Luxora — NEXT SESSION

**Точка продолжения (обновлено 2026-09-20):** export (035), deletion (036), export retention (037), thumbnails, WAV duration, calls 1–7, search 1, QR slices 1–4 (`1c4c8a3` + фиксы, CI PASS), iPhone search-chats (`8361e62` + `d12f49c`, CI PASS все), QA-слайс (`968eb38`, CI PASS), E2E N/A (`de28492`, CI PASS) — всё запушено. Security containment DONE локально (uncommitted, без миграции): `POST /v1/security/containment`, `containment.integration` 3/3, матрица 117→118, полный API 101/739.

## Как продолжить без потери контекста

1. Прочитай `PROJECT_STATE.md`, затем `TODO.md` (секция autonomous-трекера вверху).
2. Проверь состояние: `git status --short --branch`, `git log --oneline -5`,
   `gh run list --repo Flenym/Luxora --limit 4`.
3. Канонические контракты: `packages/protocol/src/index.ts`,
    `services/api/src/infrastructure/migrations.ts` (последняя `043`),
    `docs/specs/IPHONE_FUNCTIONAL_COMPLETION_MATRIX_RU.md` (обновлена под search/calls/devices).

## Ближайшая очередь

1. Security containment — коммит + пуш + CI. Дальше: contact discovery явно БЕЗ upload (spec-LATER), final QA, iPhone app epics (device-link UI, calls UI).
3. Финальный QA.

## Правила цикла (не нарушать)

- Server-first: сначала protocol → migration → store → service → routes → тесты.
- Перед пушем: `npm --prefix packages/protocol run build`, оба typecheck,
  **полный** `npm --prefix services/api test` (86 файлов / ~3 мин). Частичные
  прогоны уже дважды давали красный CI.
- После КАЖДОГО коммита: `git status` (пусто, кроме luxora.json) + `git show --stat HEAD`
  (все задуманные файлы внутри). Дважды терялись файлы мимо коммита (app.ts wiring → CI 503).
- Swift проверить нельзя локально (Windows) — только CI. После правок Swift
  ждать Apple Swift + IPA.
- Не коммитить `luxora.json` (сессионный файл) и `dist/`.
- Не выдавать DEBUG-фикстуры за продукт; сервер читает сообщения (не E2EE).
- После каждого slice: TODO + PROJECT_STATE + этот файл.

## Известные детали экспортного слайца

- Скачивание: `GET /v1/data-exports/:id/download` (по спеке §14).
- Шаг-up “phishing_resistant” не реализован как отдельный purpose (StepUpTokenPurpose — только authenticator.add/revoke); честная декларация «сильнейший настроенный аутентификатор + предупреждение о миграции».
- Export/Delete done: `POST/GET/DELETE /v1/account/deletion`, state machine `none → scheduled → deletion_pending → executing → completed|failed_retryable`, grace 7 дней, cancel только в `scheduled`. Sweep на старте + каждые 10 минут. Tombstone: `username → deleted:{id}`, `display_name → Deleted Account`, `deleted_at` в users + `WHERE deleted_at IS NULL` в lookup (findUserByUsername/Discovery/search). Execution ревокит все sessions + push, tombstone профиль, помечает owned attachments удалёнными, истекает export-артефакты. Step-up “phishing_resistant” в cancel не реализован как отдельный purpose — как у экспорта: сильнейший настроенный аутентификатор + предупреждение о миграции.