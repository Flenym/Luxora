# Полный inventory iPhone-референсов

**Дата аудита:** 2026-08-04  
**Статус:** все исходники осмотрены вручную в `original detail`  
**Источник:** корень `telegram_reference_concepts/`  
**Назначение:** обязательный UX-эталон геометрии, плотности, иерархии, панелей, кнопок и показанных состояний для Luxora iPhone.

## Точный состав

- **62 пользовательских изображения** в **36 нумерованных семействах**.
- **61 PNG** имеет размер **1179×2556 px** — это binding Simulator-геометрия для iPhone 393×852 pt @3x.
- **1 JPEG**, `20_Контекстное_меню_текстового_сообщения_другого_человека.jpg`, имеет размер **1179×1237 px** и является намеренно обрезанным фрагментом состояния контекстного меню.
- Все 62 файла открыты и проверены визуально по одному. Исходники нельзя перемещать, переименовывать, редактировать или использовать как production assets.
- Новые растровые исследования создаются только в `generated_full_reference_ru/`, по одному asset на один вызов ImageGen.

Группировка по поверхности:

| Поверхность | Кадры |
| --- | ---: |
| Корневая навигация, списки и глобальный поиск (`01–04`) | 4 |
| Аккаунт, настройки и служебные экраны (`05–19`) | 33 |
| Контекстные меню, профили и разговоры (`20–31`) | 12 |
| Конфиденциальность (`32–35`) | 6 |
| Прикрепление и фоторедактор (`36`) | 7 |
| **Итого** | **62** |

## Binding-правила переноса в Luxora

1. Повторять показанную структуру, размеры, отступы, плотность, порядок элементов и состояние экрана максимально близко к референсу.
2. Заменять Telegram, бумажный самолётик, Premium/Stars/Wallet/Gifts, чужие иллюстрации и персональные данные на Luxora и безопасные синтетические данные.
3. Не считать картинку доказательством реализации. Runtime-proof — только реальный Simulator PNG 1179×2556 и тест соответствующего перехода.
4. Корневая панель Luxora: единая плавающая glass-панель `Контакты / Звонки / Чаты / Настройки` и отдельная круглая кнопка `Поиск`; пятой вкладки нет.
5. Вложенные экраны скрывают корневую панель. Обычный Dynamic Island — однотонный матово-чёрный, без ложного media/live состояния.
6. Все продуктовые строки — на русском, кроме Luxora и синтетических username. Горизонтальная карусель обязана показывать часть следующего элемента.
7. QR-концепты используют только явно нерабочий декоративный код или локально сгенерированный безопасный код; QR из исходника не копируется.

## Инвентарь 01–19: корень, аккаунт и настройки

| Семейство | Файлы | Кадры | Обязательное покрытие |
| --- | --- | ---: | --- |
| 01 Главная — Чаты | `01_Главная_Чаты.png` | 1 | Состояние подключения в header, общий capsule действий, поиск, folder rail, закреплённые и обычные чаты, непрочитанные/время/pin, выбранная вкладка `Чаты`. |
| 02 Главная — Контакты | `02_Главная_Контакты.png` | 1 | Сортировка, добавление, поиск, приглашение, плотный список контактов, online/last seen, выбранная вкладка `Контакты`. |
| 03 Главная — Звонки | `03_Главная_Звонки.png` | 1 | Редактирование, `Все / Пропущенные`, новый звонок, исходящие и пропущенные записи, красные состояния, info-controls, выбранная вкладка `Звонки`. |
| 04 Глобальный поиск | `04_Глобальный_поиск.png` | 1 | Recent people rail, `Недавние / Очистить`, смешанные результаты, scope rail с частично видимым следующим scope, нижний поиск и закрытие. |
| 05 Настройки | `05_Настройки_01.png` … `_04.png` | 4 | Hero и QR/edit, статус/цвет/фото, switcher аккаунтов, `Мой профиль`, proxy; sticky compact header; профиль/избранное/звонки/устройства/папки; уведомления/privacy/data/appearance/power/language; support/about. Коммерческие строки — только benchmark. |
| 06 Редактирование профиля | `06_Редактирование_профиля_01.png`, `_02.png` | 2 | Cancel/done, avatar/photo, имя/фамилия, bio и visibility, birthday и visibility, номер/username/color/channel/chat automation, add account, logout. |
| 07 Мой профиль | `07_Мой_профиль_01_обычный_вид.png`, `_02_развёрнутое_фото.png` | 2 | Обычный и full-bleed hero, progress line, статус/edit, online, музыка, preview канала, info/business cards, content tabs. Commerce-tabs заменяются продуктовой Luxora-функцией или удаляются. |
| 08 Устройства | `08_Устройства_01.png`, `_02.png` | 2 | QR-link illustration/instructions, add device, current device, terminate other sessions, active sessions с platform/version/approximate region/time, auto-terminate timer. |
| 09 Папки чатов | `09_Папки_чатов_01.png`, `_02.png` | 2 | Illustration/description, создание папки, all/custom folders с цветами, recommended folders, add, folder tags toggle. |
| 10 Уведомления | `10_Уведомления_01.png`, `_02.png` | 2 | Account master toggle; private/group/channel/status/reaction categories; exceptions; in-app sound/vibrate/preview; lock-screen names; badge policy; new contacts; reset. |
| 11 Данные и память | `11_Данные_и_память_01.png`, `_02.png` | 2 | Storage/data usage, auto-download Cellular/Wi-Fi/reset, save-to-photos categories, call data mode, share suggestions, edited media, music pause, raise-to-listen, proxy. |
| 12 Использование памяти | `12_Использование_памяти_01.png`, `_02.png` | 2 | Donut chart, cache categories/clear, auto-remove durations, max cache slider, media segments, per-dialog storage list. |
| 13 Использование данных | `13_Использование_данных_01.png`, `_02.png` | 2 | Donut chart, `Все / Мобильная / Wi‑Fi`, usage categories, sent/received totals, reset statistics. |
| 14 Оформление | `14_Оформление_01.png`, `_02.png` | 2 | Theme preview/swatches, chat themes/wallpaper/color, light/dark/auto, text size, bubble corners, animations, stickers/emoji, Luxora app-icon grid, next-media toggle. |
| 15 Энергосбережение | `15_Энергосбережение_01.png`, `_02.png` | 2 | Threshold slider, autoplay video/GIF, sticker/emoji animation, interface effects, media preload, background updates. |
| 16 Язык | `16_Язык_01.png` | 1 | Search, translation controls, do-not-translate list, diverse language list including RTL scripts. |
| 17 Premium benchmark | `17_Telegram_Premium_01.png` … `_05.png` | 5 | Инвентарь возможных feature-benefits, но не экран для копирования. Не создавать `Luxora Premium`, оплату, Stars, badge или коммерческие обещания без отдельного продуктового решения. |
| 18 Support warning | `18_Поддержка_предупреждение.png` | 1 | Центрированный modal поверх settings, объяснение поддержки, кнопки FAQ/OK. |
| 19 QR профиля | `19_QR_код_профиля_01_тёмная_тема.png`, `_02_светлая_тема.png` | 2 | Большая QR-card, avatar/handle, selector тем, close/theme, share/scan; dark и light состояния. Только безопасный нерабочий QR. |

## Инвентарь 20–36: сообщения, профили, privacy и вложения

| Семейство | Файлы | Кадры | Обязательное покрытие |
| --- | --- | ---: | --- |
| 20 Incoming text context | `20_Контекстное_меню_текстового_сообщения_другого_человека.jpg` | 1 | Reaction rail над выбранным bubble; glass menu reply/copy/pin/forward/delete/select; учитывать cropped reference. |
| 21 Outgoing sticker context | `21_Контекстное_меню_стикера_который_отправил_я.png` | 1 | Reaction rail, sticker preview, receipt line, favorite/reply/pin/edit/view set/forward/delete/select. |
| 22 Профиль канала | `22_Профиль_канала_медиа.png` | 1 | Avatar/name/subscribers, message/unmute/leave/more, clipped content tabs, 3-column media grid. |
| 23 Профиль группы | `23_Профиль_группы_участники.png` | 1 | Avatar/name/count/edit, mute/search/leave/more, clipped tabs, add members, dense member list, online/last seen/owner badge. |
| 24 Профиль контакта | `24_Профиль_контакта_медиа.png` | 1 | Avatar/name/presence/edit, call/video/mute/search/more, masked details/QR/birthday, clipped tabs, 3-column shared-media grid. |
| 25 Редактирование контакта | `25_Редактирование_контакта.png` | 1 | Cancel/done/avatar, first/last name, private notes, suggest/change/reset photo, delete contact. |
| 26 Outgoing message context | `26_Контекстное_меню_сообщения_который_отправил_я.png` | 1 | Reaction rail, selected reply bubble, read timestamp, reply/copy/edit/pin/forward/delete/select. |
| 27 Личный чат | `27_Личный_чат.png` | 1 | Identity header/presence/avatar, pin strip, mixed bubbles/media, circular video message, reply/day chip/composer. |
| 28 Избранное | `28_Избранное_отправленный_файл_и_фото.png` | 1 | Search/tag/more, long text, file card/download, date chips, image preview, camera composer. |
| 29 Канал — администратор | `29_Канал_вид_администратора.png` | 1 | Header/subscribers/avatar, pin strip, media-collage post, caption/reactions/views/comments/share, broadcast composer and admin controls. |
| 30 Канал — подписчик muted | `30_Канал_вид_подписчика_без_звука.png` | 1 | Muted header, pin strip, posts/comments/share/reactions/views, subscriber action bar. Gifts/commerce не переносить. |
| 31 Групповой чат | `31_Групповой_чат.png` | 1 | Header/member count, numbered pins/list, multi-sender colored names, nested replies, reply counts, composer. |
| 32 Privacy & Security | `32_Конфиденциальность_и_безопасность_01.png` … `_03.png` | 3 | Blocked, passcode/biometrics, 2SV, passkeys, auto-delete, login email; granular visibility; account deletion and data/open-link settings. |
| 33 Privacy — phone | `33_Конфиденциальность_номер_телефона.png` | 1 | Who sees number, discoverability, always-share exceptions. |
| 34 Privacy — bio | `34_Конфиденциальность_о_себе.png` | 1 | Three visibility choices and always-share exceptions. |
| 35 Privacy — voice/video | `35_Конфиденциальность_голосовые_сообщения.png` | 1 | Three visibility choices, never/always exception lists. |
| 36 Attachments & photo edit | `36_Прикрепление_вложений_01_галерея.png` … `_07_кадрирование.png` | 7 | Gallery sheet, overflowing type dock, camera, preview/send, adjustment sliders, drawing, crop/rotate/flip/aspect. Все пользовательские фотографии заменять синтетическими. |

## Материально отсутствующие flow-семейства

Эти **27 семейств** нужны полному iPhone-приложению по ТЗ, но не имеют достаточного binding-референса среди 62 изображений. Их нельзя выдавать за уже покрытые.

| ID | Приоритет | Пробел |
| --- | --- | --- |
| G01 | P0 | Брендированный launch/loading: невидимый знак Luxora, два световых бегунка по внутреннему и внешнему контуру в одном направлении; dark/light варианты. |
| G02 | P0 | First run, регистрация и вход: телефон/email, OTP, пароль/2SV, passkey, recovery, согласия, выбор имени/avatar. |
| G03 | P0 | Системные permissions: contacts, notifications, microphone, camera, photos, local network; allow/deny/settings states. |
| G04 | P0 | Loading/skeleton, empty, offline, reconnecting, retry, rate-limit, maintenance и destructive-error states. |
| G05 | P1 | Статусы/stories: rail, viewer, capture/editor, audience/privacy, reply/reaction, archive. |
| G06 | P0 | Archive и folder-specific chat lists, edit/multi-select/reorder/bulk read/archive/delete, requests. |
| G07 | P0 | Поиск внутри разговора с переходом между совпадениями, датой, media/file/user filters. |
| G08 | P0 | Полные voice/video-message flows: запись, hold/lock, waveform, pause/preview/cancel/send и разрешения. |
| G09 | P0 | Emoji/sticker/GIF/custom-emoji picker, quick/full reaction picker и sticker-pack browser. |
| G10 | P0 | Реальные формы вложений вне gallery: document, location/live location, contact, poll, checklist, audio; показан только launcher dock. |
| G11 | P0 | Большие файлы: upload/download progress, pause/resume/cancel/retry, background transfer, offline queue и storage-limit states. |
| G12 | P0 | Полноэкранный photo/video/GIF viewer, player controls, gallery paging, video trim/edit/caption и document preview. |
| G13 | P0 | Продолжения message actions: reply target, forward destination, multi-select toolbar, edit mode/history, delete scopes/confirm, schedule/silent send, message info/read receipts. |
| G14 | P1 | Topics/forum, отдельная ветка комментариев и thread navigation; channel preview комментариев не покрывает полный flow. |
| G15 | P0 | Создание direct chat/group/supergroup/channel/folder: identity, members, permissions, confirmation и success states. |
| G16 | P1 | Admin/moderation: roles, permissions, bans, reports, join requests, invite links/QR, ownership transfer, audit log. |
| G17 | P1 | Contact discovery/add/invite, duplicate/conflict, blocked-users list и unblock/report flows. |
| G18 | P0 | 1:1 audio/video calls: incoming, ringing, connecting, active, reconnecting, minimized/PiP и ended/rating states. |
| G19 | P1 | Group calls, speaker grid, participant controls, screen sharing/picker/stop-share и call moderation. |
| G20 | P1 | Push/deep-link surfaces и in-app banners: private preview, grouped notification, muted/quiet states, exact-context navigation. |
| G21 | P0 | QR device login scanner, confirmation, device/session details и revoke confirmation; profile QR и device list этого не заменяют. |
| G22 | P0 | Security setup: passkey/2SV/local lock, change phone/email, recovery, delete/export account, connected apps and session challenge. |
| G23 | P1 | Полноценные Light/System/High Contrast, Dynamic Type, VoiceOver order, Reduce Motion/Transparency и реальные RTL layouts. |
| G24 | P1 | Недостающие profile flows: links, registration date, shared groups, status editor, avatar history/viewer и external-user variants. |
| G25 | P2 | Translation UI и disclosure: one-message, whole-chat, language exclusion, unavailable/offline/error states. |
| G26 | P1 | iPad adaptive navigation: split view, landscape, keyboard/pointer, multitasking и compact/regular transitions. |
| G27 | P0 | Явная realtime-state matrix: sending/sent/delivered/read/failed, typing/recording/uploading, edited/deleted, presence expiry и cross-device conflict. |

## Вывод аудита

Набор очень силён как binding-основа для корневых списков, настроек, профилей, privacy, базовых разговоров и фото-вложений. Он не является полным user-flow приложением: наибольшие пробелы — acquisition/auth, realtime transitions, creation/admin, voice/video capture, active calls, failure states и accessibility/adaptive layouts. Поэтому Swift-реализация должна идти в двух очередях:

1. Сначала воспроизвести 62 показанных состояния по геометрии и иерархии, с Luxora branding и синтетическими данными.
2. Затем закрыть G01–G27 оригинальными Luxora-экранами, не выдумывая, что они представлены в исходниках.
