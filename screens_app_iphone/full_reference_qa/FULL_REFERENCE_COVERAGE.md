# Luxora iPhone — полное покрытие пользовательских референсов

**Продукт:** Luxora Beta-0.1  
**Владелец / разработчик:** Flenym  
**Контрольная дата:** 2026-08-04  
**Источник:** `screens_app_iphone/telegram_reference_concepts/`  
**Machine-readable companion:** `REFERENCE_INVENTORY.json`

## Результат аудита

- В исходном разрешении вручную просмотрены **все 62 пользовательских файла**:
  61 полноэкранный PNG 1179×2556 px и один намеренно обрезанный JPEG
  1179×1237 px.
- Исходники не изменялись, не перемещались и не используются как assets.
- Для каждого файла в JSON зафиксированы экран и flow, точная иерархия,
  панели, кнопки, tab bars, modal-состояния, прокрутка, тема, interaction states,
  Swift mapping, backend dependency/truth gate, implementation/test status и
  доступная visual-diff метрика.
- **Только эти 62 пользовательских скрина** — authoritative binding-источник
  геометрии и информационной иерархии. Imagegen, Design Lab и Simulator кадры
  используются для исследования/проверки и не добавляют authoritative экраны.
- Референс — binding-источник геометрии и информационной иерархии, но не
  доказательство runtime-реализации. Runtime evidence — только Simulator capture
  реального `LuxoraMobile` и соответствующий тест.
- Прямой same-size runtime pair сейчас существует для **7 из 62** кадров; у
  оставшихся 55 нет попиксельного доказательства 1:1. В JSON 25 кадров имеют
  простой статус `planned`, ещё 7 — planned layout/attachment с отдельным gate;
  зелёные 8 UI-тестов проверяют маршруты и truth states, а не все 62 экрана.

## Неподвижные продуктовые правила

1. Корневая навигация Luxora: единая glass-панель
   `Контакты / Звонки / Чаты / Настройки` и отдельная круглая кнопка `Поиск`.
   Старый Imagegen-вариант `Inbox / Spaces / Calls / Search / You` — черновик и
   больше не является контрактом. Spaces открывается из Чатов.
2. Вложенные экраны скрывают корневую панель. Dynamic Island не изображает
   ложную live/media activity.
3. Telegram, его знак, Premium, Stars, Wallet, Gifts, чужие usernames, телефоны,
   фотографии, QR и сообщения не переносятся. Используются Luxora и безопасные
   синтетические данные.
4. Кнопка без серверного контракта показывает lock/explanation. Она не должна
   локально изображать успешный звонок, upload, push, passkey, E2EE, mutation или
   оплату.
5. Пользовательские изображения не копируются даже ради более похожего diff.
   Медиа-зоны остаются синтетическими или явно закрытыми.
6. Основной iPhone auth flow — русскоязычный phone-first сценарий:
   `Старт → Страна и номер телефона → OTP → Имя и профиль`. Username/password,
   email-first и passkey-first UI не могут быть основным входом. Позже они
   допустимы только как secondary/recovery/step-up путь по реальному контракту.
7. Каждый из 62 кадров обязан получить 1:1 русскую Luxora-репликацию геометрии
   до произвольного редизайна. Здесь `1:1` означает hierarchy, размеры, отступы,
   панели и показанное состояние — не буквальное копирование бренда, PII, QR,
   чужого media или коммерческого успеха.

## Binding auth flow, которого нет среди 62 кадров

Это обязательный продуктовый gap, поэтому его нельзя выдать за «скопированный
1:1» экран. До появления пользовательского phone-auth референса геометрия должна
оставаться Telegram-like и native iPhone, а порядок состояний фиксирован:

1. Старт: знак Luxora, короткое русское объяснение, `Продолжить`.
2. Страна и номер: country picker, код страны, форматированный номер,
   `Продолжить`, validation и rate-limit состояния.
3. OTP: masked destination, one-time-code autofill, resend timer,
   неверный/истёкший код и смена номера; код никогда не логируется.
4. Имя и профиль: имя обязательно, фамилия/avatar опциональны; затем атомарное
   создание/вход и восстановление сессии.

Legacy username/password `LuxoraAuthenticationScreen`, старые Design Lab auth
boards, прежний fixture-free auth-unavailable кадр и `gap-auth-welcome-ru-v3`
считаются **superseded как основной iPhone auth UX**. Основной iOS branch уже
использует `LuxoraPhoneAuthenticationScreen`; username/password остаётся non-iOS
fallback и DEBUG automation, а не пользовательским iPhone-входом. Живой phone
OTP backend handshake всё ещё обязателен до полного зелёного статуса.

### Текущий Swift phone-auth runtime

- Реализованы `welcome → country/phone → six-digit OTP → name/profile →
  contour transition`, disabled CTA до валидного ввода, `.oneTimeCode`, masked
  phone, resend timer, server errors и честно gated avatar.
- Production callbacks идут через `requestPhoneCode`, `verifyPhoneCode` и
  `completePhoneRegistration`; DEBUG preview явно сообщает, что SMS/аккаунт не
  создавались.
- Шесть `PhoneAuthenticationContractTests` запущены независимо: **6/6 passed**.
  Последний полный evidence — 8/8 UI; после добавления traversal-теста в source
  уже 9 UI tests, поэтому свежий 9/9 прогон ещё требуется.
- После first-pass QA в source уже добавлены searchable полный набор стран,
  combined E.164 ≤15, tertiary contrast 0.58 и точная native cubic copy
  `assets/brand/luxora-loader-route.svg`. Пять существующих v5 captures сняты до
  этих исправлений, поэтому нужны recapture/original-detail QA и свежий 9/9 run;
  live provider/expiry/rate-limit handshake также не доказан.

### Обязательное продолжение onboarding

| Этап | Требование | Проверенный Swift-статус | Truth gate |
| --- | --- | --- | --- |
| Intro | contour motion → phone | Реализовано; exact SVG source уже перенесён, recapture pending | Нельзя считать bitmap runtime evidence |
| Phone | страна/номер → OTP | Реализовано; searchable country metadata и E.164 bound есть в source | Live provider, abuse/rate-limit и expiry не доказаны |
| OTP existing | `authenticated` → явная синхронизация → Чаты | Bootstrap user/chats/first messages существует, но отдельного sync UX/test branch нет | Ошибка sync обязана сохранять recovery, не показывать ложный вход |
| OTP 2FA | `password_required` → пароль 2FA → sync | **Не реализовано**; decoder знает только `authenticated/profile_required` | Backend discriminator/endpoint отсутствует; UI только documented/gated |
| Registration profile | имя + avatar select/circular crop + optional bio | Только обязательное имя; avatar сейчас gated, bio/crop отсутствуют | Profile/avatar endpoints и durable upload отсутствуют |
| Username | availability debounce, ошибки и suggestions | **Не реализовано** | Backend username/profile endpoints pending; локальная «доступность» запрещена |
| Permissions | rationale → системные prompts → Чаты | **Не реализовано** | Notifications/contacts/mic/camera/photos запрашиваются по одному и только в контексте |
| Permission recovery | denied/restricted → Settings recovery | **Не реализовано** | Deep link в Settings и повторная проверка OS state обязательны |
| Default avatar | цветной круг с инициалами | `AvatarView` реализует deterministic accent + initials | Нужен onboarding/runtime test для нового аккаунта без фото |

Порядок registration branch фиксирован: `OTP → имя/avatar crop/bio → username
availability/suggestions → permission rationale → sync → Чаты`. Existing-account
branch: `OTP → (password_required при 2FA) → sync → Чаты`. Camera/microphone/photos
не запрашиваются все при первом запуске: они появляются перед первой реальной
функцией, объясняют цель и дают восстановление через Settings после deny.

## Binding geometry и токены

| Слой | Контракт из 62 кадров | Правило Luxora |
| --- | --- | --- |
| Canvas | 1179×2556 px = 393×852 pt @3x | Simulator proof снимается строго в этом размере, без resize |
| Базовый inset | около 48 px = 16 pt | Единый левый/правый ритм списков, cards и search |
| Background | почти чёрный, системная глубина | `Color.black`/semantic background; light только для явно показанных состояний |
| Group surface | около `#1C1C1E` | Семантическая secondary surface, без baked-in raster |
| Card radius | около 72–75 px = 24–25 pt | Большие grouped cards и sheets |
| Dense row | около 156–180 px = 52–60 pt | Текст, subtitle, accessory и inset separator |
| Root nav | плавающая glass capsule + отдельный круг | Четыре tabs в capsule; Поиск никогда не становится пятой вкладкой |
| Круглый control | около 130 px = 43–44 pt | Search/new-call/close только с доступной touch target |
| Separator | 1 physical px, inset после leading content | Не проводить под avatar/icon без показанного основания |
| Primary/secondary | white / system gray | Контраст проверяется в dark, light и accessibility modes |
| Accent | референсный blue/green не копируется слепо | Luxora violet/blue; green/red оставлять semantic success/danger |
| Horizontal rails | следующий item частично виден | Folder/status/scope rails не обрезаются как статичная строка |
| Long pages | sticky/collapsing header | Vertical content scrolls behind safe header/root chrome |

## Reusable component matrix

| Компонент | Binding-семейства | Swift runtime mapping | Состояния, которые нельзя потерять |
| --- | --- | --- | --- |
| Root glass navigation | 01–04 | `LuxoraPhoneRootView` | selected/unselected, hidden on nested route, separate Search circle |
| Inline search field | 01, 02, 04, 16 | `PhoneInlineSearchField` | idle, focused, query, clear, unavailable global search |
| Folder/scope rail | 01, 04, 09, 22–24 | `InboxFolderStrip` и будущий shared rail | selected, overflow preview, reorder/locked mutation |
| Status/avatar rail | 01, 04 | `PhoneStatusRail` | partial next card, viewed/unavailable, no fake story playback |
| Dense entity row | 01–03, 08, 12, 13, 16, 23 | shared row primitives | avatar/icon, title, subtitle, badge, timestamp, divider, disabled |
| Settings group/row | 05, 08–16, 32–35 | `PhoneSettingsRow` + settings views | toggle/value/disclosure/destructive/gated |
| Profile hero/actions | 07, 22–24 | `PhoneContactProfileView`; shared hero pending | normal/expanded photo, presence, 4–5 actions, sticky collapse |
| Conversation header/pin | 27–31 | `PhoneDirectConversationView`, `PhonePinnedContext` | presence/member count, muted, numbered pins, hidden root tab bar |
| Message bubble | 20, 26–31 | `PhoneMessageBubble` | incoming/outgoing, reply, media, sending/sent/read/failed, selected |
| Message composer | 27–31, 36 | `MessageComposer` | text send only when contract permits; attachments/voice show truth gate |
| Context action surface | 20, 21, 26 | pending | reaction rail, ownership-aware actions, destructive confirm |
| Media grid/viewer | 22, 24, 28–30, 36 | pending / locked cells | synthetic-only, loading/progress/failure/offline, permissions |
| QR card/scanner | 08, 19 | pending | decorative/disabled until verified deep-link and session confirmation |
| Modal alert/sheet | 18, 20, 21, 26, 36 | feature-status sheet + pending shared surface | dimming, cancel, destructive, keyboard/safe-area behavior |
| Contour loader | gap G01 | runtime pending; accepted visual direction only | invisible logo, outer+inner exact SVG paths, two 180°-offset runners moving same direction/equal speed |

## Coverage 01–36

| Family | Frames | Required hierarchy/state | Runtime / test truth | Backend gate | Priority |
| --- | ---: | --- | --- | --- | --- |
| 01 Chats | 1 | connection header → action capsule → search → folders → pinned/normal rows → root nav | Implemented and UI-tested; visual acceptance still open | chat/realtime truth | P0 |
| 02 Contacts | 1 | sort/add → search → invite → indexed contact rows → root nav | Implemented and UI-tested; geometry recapture in progress at audit cutoff | contacts/presence freshness | P0 |
| 03 Calls | 1 | edit/segments/new call → history → root nav | Root and empty truth-gate tested; history intentionally absent | signaling, CallKit, call records | P0 |
| 04 Search | 1 | recent people → recent results → scopes → bottom field/close | Loaded-chat search tested; exact reference composition not accepted | global search API | P0 |
| 05 Settings | 4 | hero/account actions → grouped rows → support/about across scroll | Root implemented/tested; nested rows are mixed partial/gated | identity, sessions, push, privacy, media | P1 |
| 06 Edit profile | 2 | cancel/done/avatar → identity/bio/birthday/account fields → logout | Entry exists; dedicated mutation flow not complete | profile/identity mutation API | P1 |
| 07 Own profile | 2 | normal hero + expanded photo → status/info/content tabs | Planned; Settings hero is not counted as equivalent | profile/media API | P1 |
| 08 Devices | 2 | QR link/add → current session → revoke others/active sessions/timer | Current session/logout only; UI truth gate | session enumeration/device-link/revoke | P1 |
| 09 Folders | 2 | intro/create → all/custom/recommended folders → tags | Local selection tested; server mutation locked | folders API/sync | P1 |
| 10 Notifications | 2 | master/categories/exceptions → in-app/lock/badge/reset | Screen skeleton exists; push not claimed | APNs, durable jobs, preference API | P1 |
| 11 Data/storage | 2 | usage → auto-download/save/calls/share/proxy | Current facts shown; media controls gated | durable media/cache/network policy | P1 |
| 12 Storage usage | 2 | donut/categories/clear → retention/limit/per-dialog | Planned | durable cache metrics/eviction | P1 |
| 13 Data usage | 2 | donut/scope → category totals/reset | Planned | persisted traffic metrics | P1 |
| 14 Appearance | 2 | preview/themes → mode/text/corners/motion/icons | Theme and Reduce Motion work; full matrix incomplete | mostly local; asset/legal review | P1 |
| 15 Power saving | 2 | threshold → autoplay/animation/effects/preload/background | Reduce Motion works; network/media policy incomplete | media/calls/jobs | P1 |
| 16 Language | 1 | search/translation controls → language/RTL list | Russian packaged/tested; other locales not offered as complete | localization + translation service | P1 |
| 17 Premium layouts | 5 | 1:1 русская геометрия как truth-gated Luxora capability/info; без Telegram/Premium/purchase | Planned layout replication; commerce excluded | product truth; billing только при отдельном решении | P1 layout / Frozen commerce |
| 18 Support warning | 1 | dimmed settings → centered alert → FAQ/OK | Help entry exists; exact modal not runtime-proven | real support routes/process | P1 |
| 19 Profile QR | 2 | QR card/avatar/handle → theme selector/share/scan | Planned; source QR never copied | verified deep links/scanner | P1 |
| 20 Incoming context | 1 crop | selected bubble → reactions → action menu | Planned | message mutations/moderation | P0 |
| 21 Own sticker context | 1 | reactions/sticker/receipt → ownership actions | Planned | sticker/media/message API | P0 |
| 22 Channel profile | 1 | hero/actions → clipped scopes → media grid | Planned | channels/media API | P0 |
| 23 Group profile | 1 | hero/actions → scopes → add/member list | Planned | groups/membership/presence | P0 |
| 24 Contact profile | 1 | 100 pt hero → five actions → details → scopes/grid | Implemented + UI-tested; media cells locked | media/shared content API | P0 |
| 25 Edit contact | 1 | cancel/done/avatar → names/notes/photo/delete | Entry/gate only | contacts mutation/photo API | P0 |
| 26 Own message context | 1 | reactions/read receipt → reply/copy/edit/pin/forward/delete/select | Planned | ownership-aware mutations | P0 |
| 27 Direct chat | 1 | header/pin → mixed bubbles/media/reply/day → composer | Read/text path tested; visual and media coverage partial | send/media/realtime states | P0 |
| 28 Saved messages | 1 | search/tags → text/file/date/image → composer | Planned | saved storage/upload/download | P0 |
| 29 Admin channel | 1 | header/pin → media post/reactions/views/comments → admin composer | Planned | channel admin/mutations/media | P0 |
| 30 Muted channel | 1 | muted header/pin → subscriber feed/actions | Planned | channel read/mute/comments | P0 |
| 31 Group chat | 1 | header/pins → sender groups/replies → composer | Planned | group messages/membership | P0 |
| 32 Privacy/security | 3 | account protection → visibility → deletion/data/link policy | Partial gated page tested; policies do not fake mutation | privacy/account lifecycle API | P1 |
| 33 Phone privacy | 1 | visibility → discoverability → exceptions | Planned | privacy API | P1 |
| 34 Bio privacy | 1 | three audiences → exceptions | Planned | privacy API | P1 |
| 35 Voice/video privacy | 1 | audiences → never/always exception lists | Planned | privacy/media API | P1 |
| 36 Attachments/editor | 7 | gallery/types/camera → preview/adjust/draw/crop | Launcher truth-gate tested; editor not implemented | permissions + durable upload/media processing | P2 after media contract |

## Simulator visual QA

Все указанные пары имеют одинаковый размер 1179×2556; resize не применялся.
Метрики диагностические: тексты и чужое медиа намеренно различаются. Overlay,
heatmap и edge-карты лежат в
`screens_app_iphone/production/v4-telegram-reference-ru/visual-diff/`.

| Pair | NMAE | Edge F1 | Попиксельный вывод |
| --- | ---: | ---: | --- |
| 01 Chats | 0.1301 | 0.3281 | Search/folder/lower chrome имеют близкие опорные полосы; header/actions/rows не приняты |
| 02 Contacts | 0.0660 | 0.4132 | Финальная recapture улучшила header/search и плотность; disabled invite — truth gate, avatar/row detail остаётся open |
| 03 Calls | 0.0951 | 0.2397 | Намеренное отличие: история не выдумана до signaling |
| 04 Search | 0.0992 | 0.3535 | Финальная recapture улучшила recent/scopes/results; глобальный server search всё ещё gated, P0 visual acceptance open |
| 05 Settings | 0.1941 | 0.2209 | Hero и card grouping заметно отличаются; P1 не принят |
| 24 Contact profile | 0.1451 | 0.3643 | После avatar 150→100 pt совпали основные Y-bands; media/fixtures остаются намеренно иными |
| 27 Direct chat | 0.2184 | 0.1662 | Header/pin/composer есть; message heights/content не совпадают, media не подделывается |

Финальные стабильные SHA-256 после geometry recapture: `03-contacts.png` —
`4b602b4d…4574dfb`, `06-contact-profile.png` — `c9b7e155…429af13`,
`07-global-search.png` — `6666a375…312a20`. Все три повторно просмотрены в
original detail; полный UI-прогон после них — 8/8 green.

## QA новых Luxora-концептов

- `gap-permissions-primer-ru-v2` визуально чистый, но его notification/calls
  rationale нельзя превращать в обещание недоступных push/calls; microphone и
  camera должны вызвать отдельные системные prompts.
- `gap-network-reconnect-error-ru-v1` годится как visual-only offline state;
  retry, переход в Network Settings и Diagnostics принимаются только при реально
  подключённых действиях. Иначе action скрывается или честно блокируется.
- `auth-phone-01-start-ru-v2` проверен в original detail: русский phone-first
  intent и Beta-0.1 copy корректны; статус — visual-only QA pass, не authoritative.
- `auth-phone-02-country-number-ru-v1` имеет правильную hierarchy
  country → +7/number → explanation → CTA → phone keypad, но не принят по
  состоянию: при пустом placeholder кнопка `Далее` выглядит enabled. Она должна
  быть disabled до валидного E.164; `Изменить страну` дублирует tappable country
  row. OTP и имя/профиль boards пока отсутствуют, поэтому auth flow не закрыт.
- Исправленный `auth-phone-02-country-number-ru-v2` повторно просмотрен:
  placeholder пустой, `Продолжить` disabled, country action один; visual-only QA
  pass. Он не заменяет production capture и не является одним из 62 источников.
- `auth-phone-03-otp-ru-v2` просмотрен в original detail: центрированный пустой
  six-digit field, synthetic masked phone, disabled resend/CTA и numeric keyboard
  прошли visual-only QA. Live OTP delivery/verify/error evidence он не доказывает.
- `auth-phone-04-name-profile-ru-v1` перенесён в `visual_only/` как superseded:
  он чисто показывает старое name-only состояние, но не содержит bio/circular
  crop, а `Создать профиль` преждевременно обещает terminal success до username,
  permissions и sync.
- `gap-auth-welcome-ru-v3` просмотрен в original detail и перенесён в
  `visual_only/` как **superseded non-phone auth**. Текст truth-safe, но экран не
  показывает обязательные country/phone → OTP → profile состояния и не может
  быть acceptance-основой. Ссылки условий/политики также требуют настоящих
  документов и маршрутов.
- Dark/light contour-loader v1 подтверждают правильную кинематику: два runner
  идут по inner/outer path **в одном направлении**, с одинаковой скоростью и
  смещением 180° по длине пути; полный знак не виден. Текущая строка
  `Защищённое соединение` не принимается как runtime copy без подтверждённого
  transport/security contract; нужен нейтральный текст либо удаление строки.
- Dark/light loader v3 прошли original-detail keyframe QA: ровно два runner,
  нейтральный `Beta-0.1 · Загрузка данных`, без spinner/security claim/полного
  логотипа. Они по-прежнему visual-only; текущий Swift source уже использует
  точную cubic copy SVG, но требует свежей motion recapture.
- Любая raster board остаётся design reference. Контур в приложении должен быть
  построен из точного SVG path логотипа, а не извлечён из PNG.

## Приоритетный screen graph

```text
P0  Launch/loader → Phone country/number → OTP → Name/profile
                      ↓
    Root Chats ↔ Contacts ↔ Calls(gated) ↔ Settings + Search
       ↓           ↓                         ↓
    Direct chat  Contact profile        Search result
       ↓           ↓
    Context actions / edit contact
       ↓
    Group chat ↔ Group profile
       ↓
    Channel feed (subscriber/admin) ↔ Channel profile
       ↓
    Creation flows / realtime delivery matrix / failure recovery

P1  Settings → Identity → Devices → Privacy → Notifications
             → Data/Storage → Appearance/Power → Language → Help/QR
             → 17 capability/info layouts with commerce removed

P2  Durable media contract → Attachments → Transfer states → Viewer/editor

Frozen  Premium/Stars/Wallet/Gifts/payment until separate product/legal/billing decision
```

### Acceptance order

1. Закрыть geometry defects корней 01/02/04 и сохранить truthful Calls gate.
2. Подключить direct/group/channel routes только к реально существующим read и
   mutation contracts; затем реализовать ownership-aware context menus.
3. Закрыть auth, permissions, offline/retry/rate-limit и realtime delivery
   states — сейчас 62 изображения их не покрывают.
4. После P0 довести settings/privacy и accessibility: Dynamic Type, VoiceOver,
   Reduce Motion/Transparency, high contrast, RTL и iPad adaptive layout.
5. Вложения, camera/editor, saved media и transfer UI начинать только после
   durable upload/download/cache contracts.

## Честная контрольная точка

На момент аудита есть работающий iPhone runtime, 8/8 зелёных UI-тестов последней
полной контрольной сборки и 6/6 свежих phone-contract unit tests, но **полное
приложение по 62 кадрам не готово**. Реализованы
корневые маршруты и несколько P0 slices; большинство messaging/profile/media и
глубоких settings состояний остаются partial или planned. Phone-first UI теперь
реализован, но свежий полный 9/9 UI run/recapture и live OTP handshake ещё
открыты. Эта граница закреплена в JSON отдельно для каждого файла, чтобы макет,
fixture и реальная функция не смешивались.
