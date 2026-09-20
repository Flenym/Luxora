# Luxora — NEXT SESSION

**Точка продолжения (обновлено 2026-09-20):** export (035, `5df2317`, CI PASS), deletion (036), media binaries и export retention worker (037, `8b0b665`, CI PASS), image thumbnails (`8bae86a`, CI PASS), WAV duration (`b873747`, CI PASS), calls slices 1–7 (CI PASS оба), search slice 1 (`57a801f`, CI PASS), QR device-link slices 1–3 (`d03d6fe` + `be4faa9` + `936e1a5` + `42dd53c`, CI PASS все) — всё запушено. Локально зелёный: protocol 17/104 build, API 99/733, оба typecheck; последняя миграция 042. QA-слайс в работе (uncommitted): log-leak canaries для linkSecret/webhook-auth.

## Как продолжить без потери контекста

1. Прочитай `PROJECT_STATE.md`, затем `TODO.md` (секция autonomous-трекера вверху).
2. Проверь состояние: `git status --short --branch`, `git log --oneline -5`,
   `gh run list --repo Flenym/Luxora --limit 4`.
3. Канонические контракты: `packages/protocol/src/index.ts`,
    `services/api/src/infrastructure/migrations.ts` (последняя `042`),
   `docs/specs/IPHONE_FUNCTIONAL_COMPLETION_MATRIX_RU.md` (частично устарела).

## Ближайшая очередь

1. QA-слайс (uncommitted): log-leak canaries, верификация счётчиков/матрицы/capabilities, дрейф доков. Затем: passkey-ceremony step-up альтернатива, contact discovery явно БЕЗ upload (spec-LATER), затем final QA.
2. Export/delete — done; QR-linking (slices 1–3 done) — остались step-up-ceremony, E2EE гранта, history bootstrap.
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