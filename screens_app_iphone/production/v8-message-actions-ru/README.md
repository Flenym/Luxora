# Luxora Beta-0.1 — действия с сообщениями

Снимки сделаны 4 августа 2026 года из реально собранного `LuxoraMobile` на iPhone 17 Pro Max Simulator, iOS 26.5. Оригинальное разрешение каждого PNG — 1320 × 2868.

- `01-chat-message-actions-base.png` — основная русская переписка.
- `02-reply-composer.png` — ответ с контекстом исходного сообщения.
- `03-pinned-confirmed.png` — подтверждённое закрепление; status bar, навигация чата и постоянная панель закреплённого сообщения видимы одновременно.
- `04-forward-destination.png` — выбор чата для пересылки; названия используют primary label, подписи — secondary label, акцент оставлен на системных действиях.
- `05-edit-composer.png` — редактирование с сохранённым текстом и явным подтверждением.

Это не нарисованные макеты: кадры получены через `simctl screenshot` из SwiftUI-приложения. Для воспроизводимого визуального состояния использован DEBUG-only сервероподобный fixture; Release-сборка этот путь не компилирует. Он не выдаётся за доказательство живого сервера.

Отдельные проверки контракта и поведения на момент архива:

- API/store/realtime: 17 из 17 тестов пройдены;
- focused iPhone UI E2E `testMessagePinAndForwardProduceVisibleConfirmedDestinations`: пройден;
- живой backend-сценарий reply/edit/pin/unpin/idempotent forward/delete ранее пройден отдельно через Docker.

Контрольные суммы находятся в `SHA256SUMS`.
