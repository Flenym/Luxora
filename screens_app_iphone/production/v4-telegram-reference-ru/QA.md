# QA — v4 Telegram-reference RU

## Автоматическая проверка

- `./script/check_apple_russian_ui.sh` — passed.
- `swift test --package-path apps/apple` — 20 XCTest passed, один opt-in
  live-backend test skipped; 3 Swift Testing passed.
- Полный `LuxoraMobileUITests` на `Luxora Reference iPhone 15 Pro`, iOS 26.5 —
  8/8 passed, 0 failures, 211.768 s.
- Xcode result:
  `/tmp/luxora-reference-ui-derived/Logs/Test/Test-LuxoraMobile-2026.08.04_17-25-46-+0300.xcresult`.

## Same-size visual diff

Семь пар проверены без resize, на 1179×2556. Метрики ниже не маскируют чужие
медиа, тексты и брендовые зоны, поэтому они диагностические. Низкий F1 не равен
автоматическому отказу, но каждый overlay также просмотрен вручную.

| Пара | NMAE | Edge F1 | Ручной вывод |
| --- | ---: | ---: | --- |
| 01 Чаты | 0.1301 | 0.3281 | Поиск, folder rail и нижняя оболочка имеют близкие опорные полосы; заголовок, верхние действия и строки ещё не приняты. |
| 02 Контакты | 0.0660 | 0.4132 | Header/search, invite-блок и плотность строк сведены по основным Y-полосам; русский текст, синтетические аватары и алфавитный rail намеренно отличаются. |
| 03 Звонки | 0.0951 | 0.2397 | Намеренное отклонение: история не выдумана, пока signaling недоступен. Это truth-gate, не визуальное закрытие референса. |
| 04 Поиск | 0.0992 | 0.3535 | Recent people, compact results, нижние scopes/input/close сведены по опорным полосам; поиск ограничен загруженными чатами, media остаётся честным gate. |
| 05 Настройки | 0.1941 | 0.2209 | Верхний профиль и группировка карточек заметно отличаются; P1 не принят. |
| 24 Профиль контакта | 0.1451 | 0.3643 | После перехода 150→100 pt совпали основные Y-полосы героя, действий, details, scopes и grid; различия остаются в синтетических данных, locked-state и медиа. |
| 27 Личный чат | 0.2184 | 0.1662 | Header/pinned/composer существуют, но высоты сообщений и наполненность не совпадают; медиа нельзя копировать или подделывать. |

Отчёты, overlays, heatmaps и edge-карты находятся в `visual-diff/<pair>/`.

## Проверка продуктовой правды

- Nested screens скрывают нижнюю root-панель.
- Звонки, status/story, media, server folder mutations, push, passkeys и E2EE
  остаются явно заблокированными до реального контракта.
- Debug server-shaped scenario не попадает в Release.
- `10-real-auth-unavailable.png` снят без fixture entry.
- Исходные 62 reference-изображения не изменялись.

## Следующие дефекты по важности

1. Завершить P0-корень 01 по overlay и обязательный phone/OTP/profile auth-flow, сохраняя русские строки.
2. Реализовать только поддержанные сервером состояния direct/group/channel и
   контекстные действия; неподдержанные оставить locked.
3. После P0 пройти настройки/privacy и только затем media attachment editor.
