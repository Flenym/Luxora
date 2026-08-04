# Luxora — продуктовое исследование

**Статус:** baseline для продуктовых и UX-решений  
**Канонический релиз:** Beta-0.1  
**Разработчик и владелец:** Flenym  
**Дата среза:** 3 августа 2026  
**Метод:** анализ официальных продуктовых страниц, help-центров, инженерных публикаций и протокольных спецификаций. Материалы конкурентов используются как доказательство паттернов и ограничений, а не как разрешение копировать интерфейс.

## 1. Краткий вывод

Рынок не предлагает одного мессенджера, который одновременно максимизирует облачную доступность, приватность содержимого, глобальный поиск, публичные сообщества и модерацию. У каждого лидера есть ясная оптимизация:

| Продукт | Главная оптимизация | Сильный паттерн | Системный компромисс |
| --- | --- | --- | --- |
| Telegram | Облачная скорость, многоплатформенность, broadcast | Единый список чатов, папки, каналы, темы, быстрый переход между устройствами | Обычные cloud chats не являются E2EE; Secret Chats существуют отдельно и привязаны к устройствам |
| WhatsApp | Простое общение с реальными контактами | Низкий порог входа, E2EE по умолчанию, понятные receipts, звонки и группы | Идентичность исторически завязана на телефон; общественные форматы отделены в Updates |
| Signal | Минимизация доверия и приватность по умолчанию | E2EE всегда, message requests, safety numbers, приватные группы, точные privacy-настройки | Более осторожный discovery; server-side поиск и модерация содержимого несовместимы с моделью |
| Discord | Долгоживущие сообщества и синхронное присутствие | Servers, каналы, роли, permissions, threads/forums, onboarding, persistent voice | Текст не E2EE; структура может перегружать нового участника |

**Продуктовая возможность Luxora:** создать один спокойный inbox для личных разговоров и осмысленных сообществ, но явно разделить два доверительных контекста:

1. **Private Spaces** — личные чаты, «Избранное» и закрытые круги; целевая модель — E2EE по умолчанию и локальный поиск.
2. **Moderated Spaces** — публичные пространства и каналы; содержимое доступно серверной модерации, discovery и server-side поиску. Этот факт всегда видим до вступления.

Такое разделение честнее, чем универсальная надпись «secure», и позволяет сохранить обе ценности без скрытого ослабления одной из них.

## 2. Исследовательские вопросы

- Как люди быстро понимают, где находятся: в личном чате, группе, публичном канале или голосовом пространстве?
- Какие механики удерживают сложность большого продукта под контролем?
- Как работают message requests, discovery и onboarding без превращения продукта в спам-каталог?
- Что означает «защищённый мессенджер» в каждом продукте на уровне поведения, а не лозунга?
- Как синхронизировать несколько устройств и при этом сохранять честный security contract?
- Какие паттерны звонков масштабируются от одного собеседника до сообщества?
- Как применить Liquid Glass как функциональный слой навигации, а не декоративный фильтр поверх всего?

## 3. Telegram

### 3.1. Подтверждённые возможности и поведение

- Telegram описывает себя как cloud-based messenger с одновременным доступом с нескольких устройств. Официальный FAQ отдельно говорит, что обычные private/group Cloud Chats используют client-server encryption, а Secret Chats добавляют client-client E2EE и доступны только на исходных устройствах. Источник: [Telegram FAQ](https://telegram.org/faq).
- Механизм обновлений основан на push-последовательностях с `seq`/`pts`/`qts`; клиент обязан устранять gaps и не применять событие дважды. Это важный эталон не UI, а корректности realtime sync. Источник: [Working with Updates](https://core.telegram.org/api/updates).
- Папки являются синхронизируемыми фильтрами по типу/статусу чатов, могут иметь allow/deny rules и в некоторых случаях делиться ссылкой. В UI они обычно выглядят как вкладки. Источник: [Dialog folders](https://core.telegram.org/api/folders).
- Реакции — отдельные realtime-события, поддерживают состояние выбранной реакции, счётчики и unread reactions. Источник: [Message reactions](https://core.telegram.org/api/reactions).
- Темы и треды отделяют параллельные разговоры от основного потока. Источники: [Forum topics](https://core.telegram.org/api/forum), [Message threads](https://core.telegram.org/api/threads).
- QR-login является отдельным авторизационным потоком, а не просто QR-ссылкой. Источник: [Login via QR code](https://core.telegram.org/api/qr-login).
- Telegram документирует Secret Chats и требования к E2EE-клиентам отдельно. Источник: [End-to-End Encryption, Secret Chats](https://core.telegram.org/api/end-to-end).
- Современные group calls позволяют приглашение ссылкой/QR, screen sharing и визуальную проверку E2EE; официальный анонс заявляет до 200 участников конкретного формата звонка. Источник: [Extra-Secure Group Calls](https://telegram.org/blog/group-calls-made-easy).
- Desktop/tablet calling показывает полезный large-screen паттерн: независимое окно, grid/focus layouts и выбор конкретного приложения для screen share. Источник: [Group Video Calls](https://telegram.org/blog/group-video-calls).

### 3.2. Что стоит перенять как принцип

- **Единая лента событий с восстановлением gaps.** «Мгновенно» не означает «без модели порядка».
- **Progressive disclosure.** Inbox остаётся простым, а папки, архив и фильтры появляются по мере роста нагрузки.
- **Один объект сообщения, много действий.** Reply, quote, edit, delete, react, pin и forward должны опираться на устойчивый message identity.
- **Синхронизация организационного состояния.** Архив, mute, pin, drafts и read cursor важны не меньше текста сообщения.
- **Desktop как самостоятельный клиент.** Не растягивать мобильную колонку на широкое окно.

### 3.3. Что не переносить

- Не использовать одно слово «зашифровано» для режимов с разными trust boundaries.
- Не перегружать первый экран stories, подарками, bot commerce и вторичными entry points.
- Не делать destructive actions мгновенными без undo/confirmation там, где ошибка имеет широкую область воздействия.
- Не копировать визуальную композицию, иконографию или расположение Telegram; перенимаются информационные принципы.

## 4. WhatsApp

### 4.1. Подтверждённые возможности и поведение

- Официальная messaging-страница объединяет filters/lists, pins, formatting, translations, GIF/stickers, reactions, video/voice notes и документы до 2 GB. Источник: [WhatsApp Messaging](https://www.whatsapp.com/messaging).
- Groups поддерживают polls, events/RSVP, large files, group calls и приглашение до 1000 человек; пользователь контролирует, кто может добавить его в группу. Источник: [WhatsApp Groups](https://www.whatsapp.com/groups).
- Calls доступны на mobile, tablet, desktop и web; официальная страница описывает group calls до 32 человек, screen sharing, raise hand, reactions, scheduling и call links. Источник: [WhatsApp Calling](https://www.whatsapp.com/calling).
- Каналы находятся в отдельной вкладке Updates, их уведомления muted by default; подписки и directory отделены от личных чатов. Источник: [WhatsApp Channels](https://www.whatsapp.com/channels).
- Status — исчезающие через 24 часа фото, видео, voice notes и текст с настраиваемой аудиторией. Источник: [WhatsApp Status](https://www.whatsapp.com/status).
- Multi-device использует отдельную identity key для каждого устройства, client fan-out и E2EE-синхронизацию app state/history. Источники: [Meta Engineering: WhatsApp multi-device](https://engineering.fb.com/2021/07/14/security/whatsapp-multi-device/), [WhatsApp Encryption Overview, version 9 (PDF)](https://www.whatsapp.com/security/WhatsApp-Security-Whitepaper.pdf).
- Whitepaper от 25 февраля 2026 описывает Signal Protocol, per-device keys, group Sender Keys, message history/app-state sync, calls, verification и companion removal. Он же подчёркивает, что encryption has no off switch в определённых personal communication flows. Источник: [WhatsApp Encryption Overview](https://www.whatsapp.com/security/WhatsApp-Security-Whitepaper.pdf).
- Security UX включает two-step verification, suspicious takeover checks, report/block и recovery guidance. Источник: [WhatsApp Security](https://www.whatsapp.com/security).
- Privacy Checkup и Silence Unknown Callers объединяют сложные privacy controls в понятный guided flow. Источник: [Meta: Privacy Features](https://about.fb.com/news/2023/06/new-whatsapp-privacy-features-silence-unknown-callers-and-privacy-checkup/).

### 4.2. Что стоит перенять как принцип

- **Разговор — главная поверхность.** Публичный контент не должен вытеснять личный inbox.
- **Receipts как компактный язык состояния.** Pending, sent, delivered, read и failed должны различаться без текста в каждой строке.
- **Privacy Checkup.** Безопасность лучше объяснять сценарием «кто может…», а не списком системных переключателей.
- **Группа как инструмент координации.** Poll, event, RSVP и call могут жить рядом с сообщениями, если composer не превращается в панель управления.
- **Безопасное device linking.** Primary-device approval, biometric confirmation, список сессий и remote revoke — хороший минимальный contract.

### 4.3. Что не переносить

- Не делать телефонный номер обязательной публичной идентичностью.
- Не смешивать monetized discovery с личными relationship signals.
- Не скрывать ограничения linked devices или backup semantics от пользователя.
- Не считать E2EE достаточной защитой от захвата аккаунта, вредоносного endpoint или social engineering.

## 5. Signal

### 5.1. Подтверждённые возможности и поведение

- Signal заявляет E2EE всегда для каждого сообщения и звонка; privacy не является переключаемым режимом. Safety numbers позволяют проверять собеседника. Источник: [Is it private? Can I trust it?](https://support.signal.org/hc/en-us/articles/360007320391-Is-it-private-Can-I-trust-it).
- Официальный feature index включает secure backups, linked-device/transfer сценарии, call links, usernames, stories, edit/reply, screen sharing, disappearing messages, Note to Self, archive и темы. Источник: [Signal Messenger Features](https://support.signal.org/hc/en-us/sections/360001602792-Signal-Messenger-Features).
- Usernames служат только для инициирования контакта, не являются profile name или глобальным каталогом; точный username, QR или link ведут к message request. Настройки отдельно определяют видимость и discoverability по номеру. Источник: [Phone Number Privacy and Usernames](https://support.signal.org/hc/en-us/articles/6712070553754-Phone-Number-Privacy-and-Usernames).
- Message requests создают trust checkpoint до полноценного разговора; общие группы и identity cues помогают оценить запрос. Источники: [Message Requests](https://signal.org/blog/message-requests/), [Phone Number Privacy — Deeper Dive](https://support.signal.org/hc/en-us/articles/6829998083994-Phone-Number-Privacy-and-Usernames-Deeper-Dive).
- Signal private groups спроектированы так, чтобы сервис не хранил plaintext group membership/title/avatar/attributes. Источник: [Signal Private Group System](https://signal.org/blog/signal-private-group-system/).
- Disappearing messages уменьшают долговечность истории, но официальный текст честно предупреждает: они не защищают от злонамеренного получателя с другой камерой. Источник: [Disappearing Messages](https://support.signal.org/hc/en-us/articles/360007320771-Set-and-manage-disappearing-messages).
- Stories E2EE, имеют явные audience controls и могут быть полностью выключены. Источник: [Signal Stories](https://support.signal.org/hc/en-us/articles/5008009166234-Stories).
- Secure Backups — opt-in, E2EE и управляются recovery key; удаляемые/view-once данные имеют специальные правила исключения. Источники: [Introducing Signal Secure Backups](https://signal.org/blog/introducing-secure-backups/), [Signal Secure Backups Support](https://support.signal.org/hc/en-us/articles/9708267671322-Signal-Secure-Backups).
- Протокольная база документирует asynchronous key agreement, ratcheting и multi-device session management. Источники: [X3DH](https://signal.org/docs/specifications/x3dh/), [Double Ratchet](https://signal.org/docs/specifications/doubleratchet/), [Sesame](https://signal.org/docs/specifications/sesame/).

### 5.2. Что стоит перенять как принцип

- **Privacy default, не privacy maze.** Безопасный baseline должен работать без ручной настройки.
- **Identity ceremony только по требованию.** Обычный пользователь видит понятный статус; high-risk пользователь может сравнить safety code out-of-band.
- **Message request как граница согласия.** До accept запрещены presence, read receipts, calls и обильные вложения.
- **Честные ограничения.** Disappearing не означает невозможность копирования; backup recovery key нельзя «восстановить поддержкой».
- **Минимизация social graph.** Не строить глобальный searchable directory личных usernames.

### 5.3. Что не переносить буквально

- Не считать минимальный discovery правильным для публичных сообществ; там нужен отдельный публичный контекст.
- Не обещать server-side full-text search для E2EE-истории.
- Не строить собственную криптографию по мотивам спецификаций. Нужны зрелые библиотеки, protocol expertise, аудит и migration plan.

## 6. Discord

### 6.1. Подтверждённые возможности и поведение

- Servers организованы каналами; text, voice и forums имеют разные цели, категории и channel-specific permissions. Источник: [Discord Server Setup Guide](https://support.discord.com/hc/en-us/articles/33023827550359-Discord-Server-Setup-Guide).
- Roles and permissions дают гибкое управление, а private channel начинается с запрета `View Channel` для `@everyone`. Источник: [Discord Roles and Permissions](https://support.discord.com/hc/en-us/articles/214836687-Discord-Roles-and-Permissions).
- Threads удерживают неожиданный подтопик в отдельном временном пространстве, имеют slow mode и auto-close; поиск канала включает threads. Источник: [Threads FAQ](https://support.discord.com/hc/en-us/articles/4403205878423-Threads-FAQ).
- Forum Channels предназначены для долгоживущих тематических обсуждений, в отличие от быстрого потока text channel. Источник: [Forum Channels FAQ](https://support.discord.com/hc/en-us/articles/6208479917079-Forum-Channels-FAQ).
- Community Onboarding задаёт несколько вопросов и на их основе выдаёт роли/каналы; участник позже может изменить ответы. Источник: [Community Onboarding FAQ](https://support.discord.com/hc/en-us/articles/11074987197975-Community-Onboarding-FAQ).
- Server Guide даёт приветствие, задачи и resource pages, чтобы новый участник не терялся в дереве каналов. Источник: [Server Guide FAQ](https://support.discord.com/hc/en-us/articles/13497665141655-Server-Guide-FAQ).
- Message Requests и Spam folder отделяют неизвестные DMs от обычного inbox. Источник: [Discord Message Requests](https://support.discord.com/hc/en-us/articles/7924992471191-Message-Requests).
- Screen share поддерживает application/window/full-screen выбор, grid/focus/popout views и platform-specific audio limitations. Источник: [Go Live and Screen Share](https://support.discord.com/hc/en-us/articles/360040816151-Go-Live-and-Screen-Share).
- По состоянию на март 2026 voice/video в DMs, group DMs, voice channels и Go Live E2EE по умолчанию; Stage Channels — исключение. Discord прямо пишет, что не планирует E2EE для текста. Источники: [Every Voice and Video Call Is Now E2EE](https://discord.com/blog/every-voice-and-video-call-on-discord-is-now-end-to-end-encrypted), [Meet DAVE](https://discord.com/blog/meet-dave-e2ee-for-audio-video).
- DAVE использует WebRTC transforms и MLS, поддерживает epoch changes и verification codes; design/implementation открыты и прошли внешний аудит. Источник: [Meet DAVE](https://discord.com/blog/meet-dave-e2ee-for-audio-video).
- Safety center рекомендует strong password, 2FA, privacy settings и предупреждает о QR-login phishing. Источник: [Securing Your Discord Account](https://discord.com/safety/securing-your-discord-account).

### 6.2. Что стоит перенять как принцип

- **Стабильная пространственная модель.** Пользователь всегда знает `пространство → канал/тема → разговор`.
- **Роли как наборы возможностей.** Не раздавать десятки независимых флажков каждому участнику вручную.
- **Onboarding по намерению.** Пара ответов скрывает нерелевантные каналы и снижает first-session overload.
- **Разные контейнеры для разной скорости разговора.** Live chat, topic и knowledge-like forum не должны выглядеть одинаково.
- **Voice as presence.** Вход/выход без формального «созвона» полезен для команд и дружеских сообществ.

### 6.3. Что не переносить

- Не показывать пустое дерево из десятков каналов до персонализации.
- Не использовать бесконечные permission overrides без explainability и preview-as-role.
- Не смешивать приватные и модерируемые пространства под одной иконкой защиты.
- Не повторять gaming-centric плотность и визуальный шум.

## 7. Apple HIG и Liquid Glass

### 7.1. Подтверждённые рекомендации

- Liquid Glass — отдельный функциональный слой controls/navigation над content layer. Apple прямо не рекомендует использовать его как материал контента. Источник: [HIG: Materials](https://developer.apple.com/design/human-interface-guidelines/materials).
- Standard SwiftUI/UIKit/AppKit controls получают системное поведение материала автоматически; навигация и поиск должны оставаться универсальными и последовательно организованными между платформами. Источник: [Adopting Liquid Glass](https://developer.apple.com/documentation/TechnologyOverviews/adopting-liquid-glass).
- Материал динамически адаптируется ради legibility, а более крупная форма визуально становится «толще». Источник: [WWDC25: Meet Liquid Glass](https://developer.apple.com/videos/play/wwdc2025/219/).
- Motion должен объяснять статус, feedback или пространственную связь; он краток, отменяем и не является единственным каналом информации. Источник: [HIG: Motion](https://developer.apple.com/design/human-interface-guidelines/motion).
- Reduce Motion требует уменьшать repetitive/zoom/depth/blur animations и заменять пространственные transitions на fades. Источник: [HIG: Accessibility](https://developer.apple.com/design/human-interface-guidelines/accessibility/).
- Typography должна сохранять hierarchy и Dynamic Type; Apple советует минимум гарнитур, читаемые веса и адаптацию layout ко всем размерам. Источник: [HIG: Typography](https://developer.apple.com/design/human-interface-guidelines/typography).
- Layout должен адаптироваться к ориентации, resizable windows, Dynamic Type, locale и RTL, сохраняя узнаваемую структуру. Источник: [HIG: Layout](https://developer.apple.com/design/human-interface-guidelines/layout).
- Search допускает recent searches, suggestions, corrections, scope и filters; в tab-based apps поиск может быть отдельной вкладкой. Источники: [HIG: Searching](https://developer.apple.com/design/human-interface-guidelines/searching), [HIG: Search fields](https://developer.apple.com/design/human-interface-guidelines/search-fields).
- Onboarding должен быть быстрым, по возможности optional и contextual; несущественные настройки откладываются. Источник: [HIG: Onboarding](https://developer.apple.com/design/human-interface-guidelines/onboarding).
- Notification permission лучше запрашивать после собственного объяснения ценности, а не на первом кадре. Источник: [HIG: Managing notifications](https://developer.apple.com/design/human-interface-guidelines/managing-notifications).
- Privacy UI должен объяснять цель доступа в момент необходимости и использовать системные security technologies. Источник: [HIG: Privacy](https://developer.apple.com/design/human-interface-guidelines/privacy/).

### 7.2. Выводы для бренда Luxora

Логотип — светящаяся лента в диапазоне violet/indigo/electric blue на чёрном фоне. Из него следует не «залить всё градиентом», а три брендовых свойства:

1. **Luminous focus:** цвет появляется в активном состоянии, presence и ключевом CTA.
2. **Ribbon continuity:** переходы поддерживают ощущение непрерывности между inbox, conversation и call.
3. **Deep calm:** фон и content surfaces спокойные; glow используется дозированно.

Glass разрешён для navigation bars, floating composer controls, menus и call controls. Message bubbles, списки и длинный текст остаются устойчивыми content surfaces с высоким контрастом. Это одновременно ближе к HIG и дешевле по GPU/battery.

## 8. Синтез: оригинальная модель Luxora

### 8.1. Information architecture

| Уровень | Объект Luxora | Назначение | Privacy class |
| --- | --- | --- | --- |
| Inbox | Разговор | 1:1, saved, малый закрытый круг | Private |
| Spaces | Пространство | Долгоживущее сообщество с каналами/темами/ролями | Private или Moderated, фиксируется при создании |
| Channels | Канал | Broadcast с optional comments/topics | Обычно Moderated |
| Live | Комната | Audio/video/screen share, drop-in или scheduled | Наследует class родителя |

Privacy class нельзя тихо изменить. Перевод Private → Moderated или обратно требует создания нового объекта и явной миграции участников/контента.

### 8.2. Главные продуктовые правила

- Inbox открывается первым; публичный discovery не вставляется между личными разговорами.
- Новый контакт проходит message request; до accept не раскрываются presence/read state и звонки.
- Search объясняет область: **On this device** для E2EE и **Luxora Search** для moderated/public data.
- Для каждого conversation header доступна простая строка: «Private — only members can read» или «Moderated — reports can include messages».
- Любое сообщение имеет stable ID, local optimistic ID, immutable creation author/time и revision history policy.
- «Delete for everyone» показывает scope, deadline/policy и tombstone semantics до подтверждения.
- Public spaces получают onboarding, role templates, rate controls, audit log и safety requirements до discovery eligibility.
- Presence приблизителен и privacy-controlled; «online» никогда не используется как гарантия доступности.
- Premium aesthetics не имеют права снижать contrast, accessibility или performance.

## 9. Product principles

1. **Conversation before content.** Luxora помогает говорить, а не удерживает внимание любой ценой.
2. **Privacy has a label.** Пользователь видит реальную модель защиты, а не неопределённый shield.
3. **Fast, then certain.** UI оптимистичен, но все состояния доставки, ошибки и конфликты разрешимы.
4. **Complexity arrives when earned.** Темы, роли и automation появляются по контексту.
5. **One identity, many devices, explicit trust.** Каждое устройство видно, проверяемо и отзывно.
6. **Motion explains continuity.** Анимация показывает причинность и никогда не блокирует работу.
7. **Safety is a conversation feature.** Requests, block, report, slow mode и role safety встроены в основные flows.
8. **No custom cryptography.** Протоколы и библиотеки выбираются после threat analysis и независимой проверки.

## 10. Проверяемые продуктовые гипотезы

| ID | Гипотеза | Эксперимент | Метрика успеха |
| --- | --- | --- | --- |
| H1 | Privacy label повышает понимание без снижения send rate | Usability test двух trust contexts | ≥ 85% верно отвечают, кто может прочитать контент; разница task completion < 5% |
| H2 | Inbox-first снижает time-to-first-message | Prototype test против content-first IA | Median first message ≤ 60 сек после регистрации |
| H3 | Message request снижает вред без потери полезных контактов | Cohort + abuse review | ≥ 40% снижение unwanted DM impressions; accept rate полезных запросов не хуже baseline > 10% |
| H4 | Intent onboarding снижает channel overload | 5-question max onboarding | ≥ 70% новых участников открывают релевантный channel в первую сессию |
| H5 | Локальный E2EE-search воспринимается приемлемо | Test cross-device expectations | ≥ 80% понимают индексацию; support complaints < 1% active searchers |
| H6 | Дозированный glass ощущается premium, но не мешает | Contrast/performance/usability lab | WCAG AA, 60 fps target, preference ≥ 60% без роста ошибок |

## 11. Ограничения исследования

- Feature rollout может зависеть от региона, тарифа, версии клиента и даты; ссылки фиксируют состояние источников на дату среза.
- Официальные страницы описывают намерение поставщика и не заменяют независимый security audit.
- В исследовании не использовались закрытые telemetry/retention данные конкурентов.
- Конкретные визуальные размеры и gestures должны валидироваться на реальных устройствах, клавиатурах, screen readers и при плохой сети.
- Криптографические спецификации описывают строительные блоки, но не являются готовой архитектурой Luxora.

## 12. Дополнительные нормативные источники

- [RFC 9420 — Messaging Layer Security](https://www.rfc-editor.org/info/rfc9420/) — asynchronous group key establishment с forward secrecy и post-compromise security; также документирует metadata и delivery-service threats.
- [NIST SP 800-63B-4](https://pages.nist.gov/800-63-4/sp800-63b.html) — authentication lifecycle и phishing-resistant authenticators, включая WebAuthn/passkeys.
- [OWASP ASVS 5.0](https://owasp.org/www-project-application-security-verification-standard/) — verification baseline для web/backend controls.
- [OWASP MASVS](https://mas.owasp.org/MASVS/) — storage, crypto, auth, network, platform, code, resilience и privacy controls мобильных клиентов.
