# Luxora iPhone — Telegram-reference RU checkpoint v4

Это текущая production-контрольная точка интерфейса `LuxoraMobile`, а не набор
макетов. Все 10 PNG сняты с нативного Debug-приложения на отдельном iPhone 15
Pro Simulator и вручную просмотрены в полном разрешении 1179×2556.

## Среда

- Xcode 26.6 (17F113), iOS 26.5 Simulator.
- Устройство: `Luxora Reference iPhone 15 Pro`, 393×852 pt, scale 3×.
- Локаль `ru-RU`, тёмная тема, Dynamic Island без Now Playing.
- Reduce Motion выключен; Reduce Transparency — системное значение.
- Схема `LuxoraMobile`, bundle id `app.luxora.mobile`.

## Правдивость состояния

Кадры 01–09 используют `DEBUG`-only server-shaped UI-test scenario. Он нужен для
детерминированной проверки геометрии и навигации, исключён из Release и не
считается доказательством живого backend. Кадр 10 запускается без fixture entry
и показывает реальную русскую auth-ошибку при недоступном сервере.

Звонки, истории, серверные папки, медиа, passkeys, push и E2EE не выдаются за
готовые: соответствующие действия заблокированы или открывают объяснение
фактического статуса.

## Кадры

1. `01-chats.png` — корень Чатов без status rail.
2. `02-chats-status.png` — тот же корень с переполняемой горизонтальной лентой.
3. `03-contacts.png` — Контакты, секции и индекс А–Я/#.
4. `04-edit-chats.png` — режим редактирования и честно недоступные bulk-действия.
5. `05-direct-conversation.png` — вложенный личный чат без нижней root-панели.
6. `06-contact-profile.png` — профиль, ровно пять действий, details/scopes/grid.
7. `07-global-search.png` — глобальный поиск по уже загруженным перепискам.
8. `08-settings.png` — корень русских настроек.
9. `09-calls.png` — вкладка Звонки с явным capability gate.
10. `10-real-auth-unavailable.png` — fixture-free состояние недоступного API.

SHA-256, route/state и параметры среды находятся в `manifest.json`.

## Граница приёмки

Это green checkpoint основных маршрутов, но не закрытие полного набора из 62
привязанных референсов. Текущий статус каждого источника указан в
`docs/specs/IPHONE_REFERENCE_COVERAGE_MATRIX_RU.md`. Overlay/difference отчёты
хранятся рядом в `visual-diff/`; высокая сырая разница ожидаема для чужих медиа,
персональных данных и брендовых областей и требует ручной оценки, а не
автоматического принятия.
