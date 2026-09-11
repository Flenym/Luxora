# Luxora Beta-0.1 — глобальный поиск (iPhone)

Два кадра сняты непосредственно с production-target `LuxoraMobile` на iPhone
17 Pro Simulator (iOS 26.5). Это сохранённые XCTest attachments без ретуши,
склейки или дорисовки; каждый PNG имеет размер `1206 × 2622` и просмотрен в
оригинальном разрешении.

Данные на кадрах — **DEBUG-only server-shaped fixture**, а не live-аккаунт.
Release-сборка этот fixture не содержит. Сетевой путь отдельно проверен
fixture-free Swift→Docker integration-тестом 1/1: пользователь скрыт до
принятия relationship, появляется после принятия, а отправленное сообщение
находится серверным поиском.

## Кадры

1. `01-people-results.png` — область «Люди», запрос «Арина», найденный
   принятый контакт и активная русская клавиатура.
2. `02-message-results.png` — область «Сообщения», запрос «навигация» и два
   сервероподобных результата доступного диалога.

UI journey не ограничился снимками: он нажал строку человека, дождался чата
«Арина Волкова», затем в новом процессе нашёл сообщение, нажал его и дождался
правильного conversation-screen с найденным текстом.

## Воспроизводимость

- Scheme: `LuxoraMobile`.
- Test:
  `LuxoraMobileUITests/testGlobalSearchFindsServerShapedPeopleAndMessagesAndOpensTheirChat()`.
- Result: **1/1 PASS, 0 failures, 0 skips**.
- Xcode result bundle:
  `/tmp/LuxoraGlobalSearchEvidenceFinal/Logs/Test/Test-LuxoraMobile-2026.08.15_13-22-43-+0300.xcresult`.
- Simulator: `B8C6A79C-8F71-4A09-B141-EE1FFCA480EA`, iPhone 17 Pro,
  iOS 26.5.
- Общий production-target build перед journey: `BUILD SUCCEEDED` в
  `/tmp/LuxoraMergedGenericBuild` для arm64 и x86_64 Simulator.
- Контрольные суммы находятся в `SHA256SUMS`, метаданные — в `manifest.json`.

## Честные границы

- «Люди» сейчас означает принятые/доступные серверу контакты, а не публичный
  каталог всех аккаунтов.
- «Чаты» и «Каналы» ищут только уже синхронизированные локальные проекции.
- Нажатие сообщения открывает его чат, но ещё не прокручивает и не подсвечивает
  точный message ID.
- File results уже декодируются и отображаются, но open/download action и
  live/UI evidence файлов ещё отсутствуют.
- Store/API pagination, повтор, session fence и malformed cursor проверены
  unit-тестами; этот конкретный UI journey не является multi-page live proof.
- Кадры не закрывают полный 62-screen pixel/accessibility/real-device gate.
