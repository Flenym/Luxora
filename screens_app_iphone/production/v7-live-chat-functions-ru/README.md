# Luxora Beta-0.1 — iPhone chat/functions visual smoke

Дата проверки: 2026-08-04, Europe/Moscow. Владелец/разработчик: Flenym.

## Что находится в папке

| Файл | Сценарий | Разрешение |
|---|---|---:|
| `01-chat-list-ru.png` | Список чатов, папки, поиск и нижняя навигация | 1320 × 2868 |
| `02-conversation-ru.png` | Личный диалог, сообщения, реакции, закрытые сервером действия и composer | 1320 × 2868 |
| `03-new-message-ru.png` | Модальное создание сообщения, локальные диалоги и поле серверного поиска | 1320 × 2868 |

Все PNG являются full-device снимками: сохранены status bar, Dynamic Island и home indicator. На экранах нет токенов, паролей, телефонных номеров или иных секретов.

## Fixture и live-статус

Название `v7-live-chat-functions-ru` обозначает итерацию подключённого chat/functions слоя, но сами три PNG сняты в детерминированном DEBUG fixture-сценарии `LUXORA_UI_TEST_SCENARIO=messenger`. Этот сценарий:

- компилируется только в Debug;
- использует синтетические русские имена и сообщения;
- не содержит и не сохраняет учётные данные;
- исключён из Release;
- обеспечивает воспроизводимую геометрию и состояния интерфейса.

Поэтому PNG не выдаются за скриншоты реальных пользовательских данных. Live backend проверен отдельно интеграционным тестом.

Во время финальной проверки контейнер `luxora-phone-live` имел статус `healthy`, слушал только `127.0.0.1:8080`, а `/health/ready` возвращал:

```json
{"status":"ready","release":"Beta-0.1"}
```

Live-тест был повторно запущен 2026-08-04 в 20:41 MSK:

```sh
LUXORA_LIVE_TEST=1 swift test --package-path apps/apple \
  --filter LiveBackendIntegrationTests/testRegistrationSessionChatListAndRealtimeHandshake
```

Результат: 1 тест, 0 ошибок, 0.789 секунды. Сценарий проверяет регистрацию/сессию, сохранённый личный чат, отправку и чтение сообщения, отметку прочитанного, добавление и удаление реакции, обновление списка, realtime handshake и отзыв сессии.

## Среда и доказательства

- Xcode 26.6, build 17F113.
- iOS 26.5 Simulator.
- Устройство: iPhone 17 Pro Max, UDID `04D3DB7A-045D-41AA-AFFA-37F78AE1F267`.
- Build destination: iPhone 17 Pro, UDID `22D9F7E5-36B4-4A6E-9696-EEC13CF2C2DA`; simulator-бинарник затем установлен на указанное выше устройство пересъёмки.
- Scheme: `LuxoraMobile`, configuration: `Debug`.
- Bundle ID: `app.luxora.mobile`.
- Status bar зафиксирован на 09:41, Wi‑Fi 3/3, cellular 4/4, battery 100% charged.
- Снимки сделаны из рабочего дерева до итогового root-коммита; привязка этой выборки обеспечивается SHA-256 ниже.

Актуальная сборка Simulator:

```sh
xcodebuild -project apps/apple/Luxora.xcodeproj \
  -scheme LuxoraMobile -configuration Debug \
  -destination 'platform=iOS Simulator,id=22D9F7E5-36B4-4A6E-9696-EEC13CF2C2DA' \
  -derivedDataPath /tmp/luxora-v7-chat-functions-derived \
  build CODE_SIGNING_ALLOWED=NO
```

Результат: `BUILD SUCCEEDED`.

Проверки chat/functions перед пересъёмкой:

- `swift test --package-path apps/apple`: 39 XCTest выполнено — 38 passed, 1 ожидаемый opt-in skip, 0 ошибок; дополнительно 3/3 Swift Testing.
- Xcode UI smoke: 2/2, 0 ошибок — поиск без результатов и личный чат с отправкой текста/честным gate вложений.
- Xcode result bundle: `/tmp/luxora-chat-functions-uitests/Logs/Test/Test-LuxoraMobile-2026.08.04_20-32-05-+0300.xcresult`.

## Сравнение с Telegram-референсами

Каждый итоговый PNG и указанные референсы открыты и проверены в original resolution.

- `01-chat-list-ru.png` сравнивался с `telegram_sreenshots/chats.jpeg` и `telegram_reference_concepts/01_Главная_Чаты.png`: сохранены структура верхних pill-кнопок, крупный поиск, горизонтальные папки, плотные строки и отдельный нижний Search.
- `02-conversation-ru.png` сравнивался с `telegram_sreenshots/in_chat.jpeg` и `telegram_reference_concepts/27_Личный_чат.png`: сохранены back/header/action pills, pinned surface, разделитель даты, геометрия пузырей и нижний composer.
- `03-new-message-ru.png` сравнивался с ближайшими доступными референсами `02_Главная_Контакты.png` и `04_Глобальный_поиск.png`: сохранены плотный список контактов, glass-sheet и нижнее поле поиска. Отдельного референса Telegram для модального `Новое сообщение` в наборе нет.

Очевидных дефектов clipping, status bar или toolbar не обнаружено. В рамках этой пересъёмки код приложения не менялся. Отличия в цвете Luxora, initials вместо фото и заблокированные неподдержанные действия являются намеренными и не маскируют отсутствующий backend.

## SHA-256

```text
497d28a6c9f1dcd37250b300b299424c76189b76eec2192ef9c84222270cd424  01-chat-list-ru.png
17d0049b3bcc8b67b4c6867b424304a0d61837011b0d54ad4141490435244daf  02-conversation-ru.png
89e1c7a01c6780c16eb1b08f982e238859544e5021e99f7d1959dd00b8cf6e7f  03-new-message-ru.png
```

Проверка:

```sh
shasum -a 256 screens_app_iphone/production/v7-live-chat-functions-ru/*.png
```

## Честный gap-list Beta-0.1

- Сервер принимает upload, но отправка вложений из iPhone-чата ещё не подключена; UI показывает gate.
- Аудио- и видеозвонки закрыты до готовности signaling/media контрактов.
- Список чатов и история пока загружают первую страницу без cursor pagination.
- Reply, edit, delete, forward и pin не подключены к iPhone UI/API.
- Нет долговечной offline-очереди и локального кеша истории; draft сохраняется в состоянии экрана, отправка offline запрещена.
- Создание групп/каналов и управление участниками не подключены.
- Stories и push notifications отсутствуют.
- URL аватаров пока не отображаются моделью `Participant`; используется безопасный initials fallback.
- Реакции работают через HTTP/realtime в текущей сессии, но обычная повторная загрузка истории не обогащена reaction summaries сервером.
- Поиск нового собеседника ограничен подтверждёнными/известными контактами; message requests незнакомым пользователям не подключены.
