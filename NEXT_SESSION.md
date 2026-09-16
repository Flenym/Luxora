# Luxora — NEXT SESSION

**Точка продолжения (обновлено 2026-09-16):** account export first slice готов (локально зелёный: protocol 17/104, API 84/675, оба typecheck). Не закоммичен — работа в рабочем дереве.

## Как продолжить без потери контекста

1. Прочитай `PROJECT_STATE.md`, затем `TODO.md` (секция autonomous-трекера вверху).
2. Проверь состояние: `git status --short --branch`, `git log --oneline -5`,
   `gh run list --repo Flenym/Luxora --limit 4`.
3. Канонические контракты: `packages/protocol/src/index.ts`,
   `services/api/src/infrastructure/migrations.ts` (последняя `035`),
   `docs/specs/IPHONE_FUNCTIONAL_COMPLETION_MATRIX_RU.md` (частично устарела).

## Ближайшая очередь

1. Account delete/retention state machine (`none → scheduled → … → completed|failed_retryable`) + media binaries в экспорте.
2. Media processing остаток (thumbnails/transcode, duration/waveform) → search → calls signaling.
3. Export/delete, QR-linking, contact discovery.
4. Финальный QA.

## Правила цикла (не нарушать)

- Server-first: сначала protocol → migration → store → service → routes → тесты.
- Перед пушем: `npm --prefix packages/protocol run build`, оба typecheck,
  **полный** `npm --prefix services/api test` (84 файла / ~3 мин). Частичные
  прогоны уже дважды давали красный CI.
- Swift проверить нельзя локально (Windows) — только CI. После правок Swift
  ждать Apple Swift + IPA.
- Не коммитить `luxora.json` (сессионный файл) и `dist/`.
- Не выдавать DEBUG-фикстуры за продукт; сервер читает сообщения (не E2EE).
- После каждого slice: TODO + PROJECT_STATE + этот файл.

## Известные детали экспортного слайца

- Скачивание: `GET /v1/data-exports/:id/download` (по спеке §14).
- Шаг-up “phishing_resistant” не реализован как отдельный purpose (StepUpTokenPurpose — только authenticator.add/revoke); честная декларация «сильнейший настроенный аутентификатор + предупреждение о миграции».
- Экспорт: идемпотентный `POST /v1/data-exports` (reuse последнего ready с живым TTL), state polling, 7-day TTL, manifest SHA-256, NDJSON категории, encrypted-at-rest тела сообщений (сервер не видит plaintext). `omittedCategories:["mediaBinaries","tokens"]`.