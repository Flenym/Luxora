# Luxora Beta-0.1 — синхронизированные черновики (iPhone)

Три кадра сняты непосредственно с production-target `LuxoraMobile` на iPhone
17 Pro Simulator (iOS 26.5). Это оригинальные XCTest attachments без ретуши,
склейки или дорисовки; каждый PNG имеет размер `1206 × 2622` и просмотрен в
исходном разрешении после экспорта из успешного result bundle.

Данные и транспорт в этом journey — строго opt-in **DEBUG-only server-shaped
fixture**, а не live backend. Без launch-флага сценарий не создаётся, а
Release-сборка fixture не содержит. UI, composer, синхронизационные состояния,
повтор, отправка и очистка проходят через production SwiftUI/store-путь.

## Кадры

1. `01-rate-limit-retry.png` — первый autosave получил 429 с ограниченным
   `Retry-After: 3`; введённый текст сохранён, отображаются точная ошибка и
   доступное действие «Повторить».
2. `02-cross-chat-restored.png` — после сохранения отдельного черновика в другом
   чате исходный чат открыт снова, и его собственный текст восстановлен в
   composer с доступной отправкой.
3. `03-sent-and-cleared.png` — восстановленный текст отправлен как сообщение,
   сервероподобное удаление черновика завершено, composer очищен и send
   недоступен.

Помимо кадров тест проверил initial load, видимый autosave loading для обоих
чатов, настоящую software keyboard и inline-dismiss, строгие accessibility ID
failure/retry, hittable manual retry, неизменный logical command при повторе,
отсутствие чужого текста после переключения чатов и завершённую очистку.

## Воспроизводимость и проверка

- Scheme: `LuxoraMobile`.
- Test:
  `LuxoraMobileUITests/testSynchronizedDraftLoadingAutosaveCrossChatRestoreRateLimitRetryKeyboardAndSend()`.
- Result: **1/1 PASS, 0 failures, 0 skips**, 75.079 с.
- Xcode result bundle:
  `/tmp/LuxoraDraftsUI.PostPatch.EDyOo5/DraftsUI-PostPatch.xcresult`.
- Simulator: `B8C6A79C-8F71-4A09-B141-EE1FFCA480EA`, iPhone 17 Pro,
  iOS 26.5.
- Focused Swift compile/tests: `DebugLaunchAutomationTests` — **5/5 PASS**.
- Точный runtime warning `Invalid frame dimension (negative or non-finite)`:
  **0** совпадений в xcodebuild log, test activities и бинарном дереве
  успешного xcresult.
- Метаданные и source attachment names находятся в `manifest.json`,
  контрольные суммы — в `SHA256SUMS`.

Эти кадры подтверждают показанный iPhone journey, но не подменяют отдельные
live-backend, conflict/reconciliation и multi-device интеграционные тесты.
