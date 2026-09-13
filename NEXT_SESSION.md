# Luxora — NEXT SESSION

**Точка продолжения (обновлено 2026-09-13):** `main` = `e0063be`, CI зелёный.

## Как продолжить без потери контекста

1. Прочитай `PROJECT_STATE.md`, затем `TODO.md` (секция autonomous-трекера вверху).
2. Проверь состояние: `git status --short --branch`, `git log --oneline -5`,
   `gh run list --repo Flenym/Luxora --limit 4`.
3. Канонические контракты: `packages/protocol/src/index.ts`,
   `services/api/src/infrastructure/migrations.ts` (последняя `032`),
   `docs/specs/IPHONE_FUNCTIONAL_COMPLETION_MATRIX_RU.md` (частично устарела).

## Правила цикла (не нарушать)

- Server-first: сначала protocol → migration → store → service → routes → тесты.
- Перед пушем: `npm --prefix packages/protocol run build`, оба typecheck,
  **полный** `npm --prefix services/api test` (78 файлов / ~3 мин). Частичные
  прогоны уже дважды давали красный CI.
- Swift проверить нельзя локально (Windows) — только CI. После правок Swift
  ждать Apple Swift + IPA.
- Не коммитить `luxora.json` (сессионный файл) и `dist/`.
- Не выдавать DEBUG-фикстуры за продукт; сервер читает сообщения (не E2EE).
- После каждого slice: TODO + PROJECT_STATE + этот файл.

## Ближайшая очередь

1. Topics iPhone (в работе): сервер готов — `GET/POST /v1/chats/:id/topics`, `PATCH /v1/topics/:id`, `topicId` в send/list messages + realtime `topic.created/updated`. Клиент: модель `ChatTopic`, методы в `LuxoraAPIClient` (CRUD + `topicId` в `messages`/`sendMessage`/`APISendMessageBody`), фильтр истории в store, UI chips + composer, contract tests. Начало: `LuxoraAPIClient.swift:646` (`messages`), `:675` (`sendMessage`), `:1388` (`APISendMessageBody`).
2. Voice QA → media processing → search → calls signaling.
3. Export/delete, QR-linking, contact discovery.
4. Финальный QA.
