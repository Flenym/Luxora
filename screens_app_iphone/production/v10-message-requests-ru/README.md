# Luxora iPhone — запросы на переписку

Владелец/разработчик: **Flenym**

Версия: **Beta-0.1**

Снято 11 августа 2026 года на iPhone 17 Pro Max Simulator, iOS 26.5. Все PNG сохранены в исходном размере XCTest-вложения: 1320 × 2868 пикселей.

## Экраны

1. `01-incoming.png` — подтверждённый серверообразный входящий список.
2. `02-outgoing.png` — исходящий запрос в состоянии ожидания.
3. `03-new-confirmed-recipient.png` — точный username, найденный получатель и первое сообщение.
4. `04-private-dismiss-confirm.png` — приватное подтверждение удаления.
5. `05-accepted-chat.png` — принятый direct-чат с первым подтверждённым сообщением и composer.
6. `06-privacy-confirmed.png` — настройки, подтверждённые сервером.
7. `07-load-error.png` — видимая ошибка загрузки и retry.
8. `08-action-error-retry.png` — запрос остаётся на месте после ошибки действия.
9. `09-privacy-error.png` — неподтверждённая настройка не применяется; ошибка и retry видимы.
10. `10-loading.png` — честное состояние загрузки без выдуманных людей.
11. `11-empty.png` — честное пустое состояние.

## Проверка

- Signed `build-for-testing`: `** TEST BUILD SUCCEEDED **`, подпись `Sign to Run Locally`.
- Один свежий XCTest-result: `/tmp/LuxoraMessageRequestsUnified-04D3-20260811-v3.xcresult`.
- Unified UI: 4 теста пройдено, 0 ошибок, 0 пропусков; 190.646 секунды тестов.
- Swift package: 18 выбранных тестов, 17 пройдено, 1 live opt-in пропущен, 0 ошибок.
- Отдельный live Docker proof: `LiveBackendIntegrationTests/testMessageRequestsPrivacyDismissAndAcceptanceAgainstLiveDocker` — 1/1, 0 ошибок, 1.015 секунды.
- Каждый из 11 PNG просмотрен в оригинальном разрешении; видимых пустых, повреждённых или не соответствующих сценарию кадров нет.

UI-прогон использует только DEBUG server-shaped fixture для воспроизводимых состояний. Fixture не компилируется в Release и не выдаётся за работу с живым API. Live-проверка против `127.0.0.1:8080` выполнялась отдельно; коды входа и другие секреты в артефакты не записывались.

Контрольные суммы находятся в `SHA256SUMS`.
