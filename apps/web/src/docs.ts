import type { Locale } from "./i18n";

export type Block =
  | { type: "h2"; text: string }
  | { type: "p"; text: string }
  | { type: "list"; items: string[] }
  | { type: "code"; code: string; lang?: string }
  | { type: "note"; text: string }
  | { type: "link"; text: string; to?: string; href?: string };

type PageCopy = { title: string; summary: string; blocks: Block[] };

export type DocPage = {
  slug: string;
  group: "start" | "account" | "messaging" | "platforms" | "security" | "developers";
  copy: Record<Locale, PageCopy>;
};

export const groupTitles: Record<DocPage["group"], Record<Locale, string>> = {
  start: { en: "Getting Started", ru: "Начало работы" },
  account: { en: "Account", ru: "Аккаунт" },
  messaging: { en: "Messaging", ru: "Переписки" },
  platforms: { en: "Platforms", ru: "Платформы" },
  security: { en: "Security", ru: "Безопасность" },
  developers: { en: "Developers", ru: "Разработчикам" },
};

const GITHUB = "https://github.com/Flenym/Luxora";

const soon = { en: "Planned — not available in Beta-0.1.", ru: "Запланировано — в Beta-0.1 недоступно." };

function platformPage(
  slug: string,
  title: string,
  summaryEn: string,
  summaryRu: string,
  directionEn: string,
  directionRu: string,
): DocPage {
  return {
    slug,
    group: "platforms",
    copy: {
      en: {
        title,
        summary: summaryEn,
        blocks: [
          { type: "p", text: "Release status: not released. There is no signed build, installer or store listing for this platform yet." },
          { type: "h2", text: "Direction" },
          { type: "p", text: directionEn },
          { type: "note", text: soon.en },
          { type: "link", text: "Build the web client from source today", to: "/download" },
        ],
      },
      ru: {
        title,
        summary: summaryRu,
        blocks: [
          { type: "p", text: "Статус релиза: не выпущено. Подписанной сборки, установщика или страницы в магазине для этой платформы пока нет." },
          { type: "h2", text: "Направление" },
          { type: "p", text: directionRu },
          { type: "note", text: soon.ru },
          { type: "link", text: "Соберите веб-клиент из исходников уже сегодня", to: "/download" },
        ],
      },
    },
  };
}

export const docPages: DocPage[] = [
  {
    slug: "introduction",
    group: "start",
    copy: {
      en: {
        title: "Introduction",
        summary: "What Luxora is and what stage it is at.",
        blocks: [
          { type: "p", text: "Luxora is a modern messenger designed for simple, fast and beautiful communication. The product is in active development." },
          { type: "h2", text: "Current status" },
          { type: "p", text: "Luxora is in Beta-0.1. Public native apps are not released yet, so most of these docs describe the direction of the product, not a finished release. The public site, the documentation and an early web messenger preview exist today." },
          { type: "p", text: "The repository already contains a tested server foundation: strict shared protocol contracts, identity and sessions, text messaging with replies and edits, realtime sync, and safety flows. That is real code with tests — not evidence of a finished public product." },
          { type: "h2", text: "What to read next" },
          { type: "list", items: ["Installation — how to run the web client from source", "Quick start — the short path from clone to a running preview", "Known boundaries — what Beta-0.1 deliberately does not do"] },
          { type: "note", text: "Beta builds run in Cloud preview mode. Connections are protected in transit, but the server processes message plaintext and can read message content. Beta builds are not end-to-end encrypted — do not use them for sensitive information." },
          { type: "link", text: "Read the security model", to: "/security" },
        ],
      },
      ru: {
        title: "Введение",
        summary: "Что такое Luxora и на каком он этапе.",
        blocks: [
          { type: "p", text: "Luxora — современный мессенджер для простого, быстрого и красивого общения. Продукт находится в активной разработке." },
          { type: "h2", text: "Текущий статус" },
          { type: "p", text: "Luxora в версии Beta-0.1. Публичные нативные приложения пока не выпущены, поэтому большая часть документации описывает направление развития продукта, а не готовый релиз. Сегодня существуют публичный сайт, документация и раннее превью веб-мессенджера." },
          { type: "p", text: "В репозитории уже есть протестированная серверная основа: строгие общие контракты протокола, идентификация и сеансы, текстовые сообщения с ответами и правками, realtime-синхронизация и сценарии безопасности. Это реальный код с тестами — но не доказательство готового публичного продукта." },
          { type: "h2", text: "Что читать дальше" },
          { type: "list", items: ["Установка — как запустить веб-клиент из исходников", "Быстрый старт — короткий путь от клонирования до работающего превью", "Известные границы — что Beta-0.1 намеренно не делает"] },
          { type: "note", text: "Бета-сборки работают в режиме Cloud preview. Соединение защищено при передаче, но сервер обрабатывает сообщения в открытом виде и может читать их содержимое. Бета-сборки не используют сквозное шифрование — не применяйте их для конфиденциальной информации." },
          { type: "link", text: "Прочитать модель безопасности", to: "/security" },
        ],
      },
    },
  },
  {
    slug: "installation",
    group: "start",
    copy: {
      en: {
        title: "Installation",
        summary: "What can be installed today, and how to run the web client from source.",
        blocks: [
          { type: "h2", text: "Native apps" },
          { type: "p", text: "Windows, macOS, Linux, iOS and Android apps are in development and not published. There is no signed installer, store listing or release channel for them yet, so this page does not link to one." },
          { type: "h2", text: "Web client from source" },
          { type: "p", text: "The web client is part of the public repository and can be built locally. You need Node.js 22 or newer and npm, plus a local Luxora API for the messenger to connect to." },
          { type: "list", items: ["Clone the public repository from GitHub.", "Install pinned dependencies for the web workspace.", "Start the API following the repository instructions for services/api.", "Start the Vite dev server and open http://127.0.0.1:4173."] },
          { type: "code", lang: "bash", code: "npm --prefix apps/web ci\nnpm --prefix apps/web run dev" },
          { type: "note", text: "A source build is a developer preview, not a signed release. It has no auto-updater and no support guarantee." },
          { type: "link", text: "Open the repository on GitHub", href: GITHUB },
          { type: "link", text: "Follow the quick start", to: "/docs/quick-start" },
        ],
      },
      ru: {
        title: "Установка",
        summary: "Что можно установить сегодня и как запустить веб-клиент из исходников.",
        blocks: [
          { type: "h2", text: "Нативные приложения" },
          { type: "p", text: "Приложения для Windows, macOS, Linux, iOS и Android находятся в разработке и не опубликованы. Подписанного установщика, страницы в магазине и канала релизов пока нет, поэтому эта страница не ссылается на них." },
          { type: "h2", text: "Веб-клиент из исходников" },
          { type: "p", text: "Веб-клиент — часть публичного репозитория, его можно собрать локально. Нужны Node.js 22 или новее, npm и локальный API Luxora, к которому подключится мессенджер." },
          { type: "list", items: ["Склонируйте публичный репозиторий с GitHub.", "Установите зафиксированные зависимости для веб-воркспейса.", "Запустите API по инструкции для services/api в репозитории.", "Запустите dev-сервер Vite и откройте http://127.0.0.1:4173."] },
          { type: "code", lang: "bash", code: "npm --prefix apps/web ci\nnpm --prefix apps/web run dev" },
          { type: "note", text: "Сборка из исходников — превью для разработчиков, а не подписанный релиз. У неё нет автообновления и гарантий поддержки." },
          { type: "link", text: "Открыть репозиторий на GitHub", href: GITHUB },
          { type: "link", text: "Перейти к быстрому старту", to: "/docs/quick-start" },
        ],
      },
    },
  },
  {
    slug: "quick-start",
    group: "start",
    copy: {
      en: {
        title: "Quick start",
        summary: "The short path from a clean machine to a running web messenger preview.",
        blocks: [
          { type: "p", text: "This is the shortest honest path to seeing the Beta-0.1 web client running. It is a development preview connected to a local API, not a hosted product." },
          { type: "h2", text: "1. Prepare the machine" },
          { type: "list", items: ["Node.js 22 or newer with npm.", "Git to clone the public repository.", "A terminal in the repository root."] },
          { type: "h2", text: "2. Install dependencies" },
          { type: "code", lang: "bash", code: "npm --prefix apps/web ci" },
          { type: "h2", text: "3. Start the API" },
          { type: "p", text: "Start the Luxora API from services/api following the repository instructions. The dev server proxies /v1, /v2 and /health to http://127.0.0.1:2222 by default, so keep the API on that port or adjust the proxy in apps/web/vite.config.ts." },
          { type: "h2", text: "4. Start the web client" },
          { type: "code", lang: "bash", code: "npm --prefix apps/web run dev" },
          { type: "p", text: "Open http://127.0.0.1:4173 for the public site and http://127.0.0.1:4173/app for the messenger preview. Accounts are created inside that local API environment — public registration is not open." },
          { type: "note", text: "The preview is Cloud preview mode: the server can read message content. It is not end-to-end encrypted and is not suitable for sensitive conversations." },
          { type: "link", text: "Open the repository on GitHub", href: GITHUB },
          { type: "link", text: "Check the project status", to: "/status" },
        ],
      },
      ru: {
        title: "Быстрый старт",
        summary: "Короткий путь от чистой машины до запущенного превью веб-мессенджера.",
        blocks: [
          { type: "p", text: "Это самый короткий честный путь увидеть веб-клиент Beta-0.1 в работе. Это превью для разработки, подключённое к локальному API, а не хостинговый продукт." },
          { type: "h2", text: "1. Подготовьте машину" },
          { type: "list", items: ["Node.js 22 или новее с npm.", "Git, чтобы склонировать публичный репозиторий.", "Терминал в корне репозитория."] },
          { type: "h2", text: "2. Установите зависимости" },
          { type: "code", lang: "bash", code: "npm --prefix apps/web ci" },
          { type: "h2", text: "3. Запустите API" },
          { type: "p", text: "Запустите API Luxora из services/api по инструкции в репозитории. Dev-сервер проксирует /v1, /v2 и /health на http://127.0.0.1:2222 по умолчанию, поэтому держите API на этом порту или настройте прокси в apps/web/vite.config.ts." },
          { type: "h2", text: "4. Запустите веб-клиент" },
          { type: "code", lang: "bash", code: "npm --prefix apps/web run dev" },
          { type: "p", text: "Откройте http://127.0.0.1:4173 — публичный сайт, и http://127.0.0.1:4173/app — превью мессенджера. Аккаунты создаются внутри этой локальной среды API; публичная регистрация не открыта." },
          { type: "note", text: "Превью работает в режиме Cloud preview: сервер может читать содержимое сообщений. Это не сквозное шифрование, и превью не подходит для конфиденциальных переписок." },
          { type: "link", text: "Открыть репозиторий на GitHub", href: GITHUB },
          { type: "link", text: "Проверить статус проекта", to: "/status" },
        ],
      },
    },
  },
  {
    slug: "first-steps",
    group: "start",
    copy: {
      en: {
        title: "First steps",
        summary: "What you can do in the messenger preview after signing in.",
        blocks: [
          { type: "p", text: "These first steps apply to the Beta-0.1 web messenger preview connected to a local API. Native apps are not released." },
          { type: "h2", text: "Sign in" },
          { type: "p", text: "Create or use an account inside the local development environment, then start the messenger at /app. Delivery states are shown only when the protocol confirms them — never by a timer." },
          { type: "h2", text: "Start a conversation" },
          { type: "p", text: "Direct chats are started through a message request when privacy rules require it; the recipient can accept or decline. Group chats exist in the server foundation and are planned for the product surface." },
          { type: "h2", text: "What works beyond text" },
          { type: "list", items: ["Text messages, replies, edits, deletions and reactions are part of the server foundation.", "Read receipts are explicit protocol events, not simulated.", "Attachments, calls, folders and multi-device sync are in development or planned."] },
          { type: "note", text: "Detailed end-user guides will be published together with the first public release." },
          { type: "link", text: "Read the messaging docs", to: "/docs/messages" },
        ],
      },
      ru: {
        title: "Первые шаги",
        summary: "Что можно сделать в превью мессенджера после входа.",
        blocks: [
          { type: "p", text: "Эти первые шаги относятся к превью веб-мессенджера Beta-0.1, подключённому к локальному API. Нативные приложения не выпущены." },
          { type: "h2", text: "Вход" },
          { type: "p", text: "Создайте или используйте аккаунт внутри локальной среды разработки, затем откройте мессенджер по адресу /app. Статусы доставки показываются только когда их подтверждает протокол — никогда по таймеру." },
          { type: "h2", text: "Начать переписку" },
          { type: "p", text: "Личные чаты начинаются через запрос на переписку, когда этого требуют правила приватности; получатель может принять или отклонить его. Групповые чаты есть в серверной основе и запланированы в продуктовой поверхности." },
          { type: "h2", text: "Что работает помимо текста" },
          { type: "list", items: ["Текстовые сообщения, ответы, правки, удаления и реакции входят в серверную основу.", "Статусы прочтения — явные события протокола, а не имитация.", "Вложения, звонки, папки и мультидевайсная синхронизация в разработке или запланированы."] },
          { type: "note", text: "Подробные руководства для пользователей появятся вместе с первым публичным релизом." },
          { type: "link", text: "Документация о сообщениях", to: "/docs/messages" },
        ],
      },
    },
  },
  {
    slug: "creating-an-account",
    group: "account",
    copy: {
      en: {
        title: "Creating an account",
        summary: "How accounts are created today and what the public flow will require.",
        blocks: [
          { type: "p", text: "Public sign-up is not open. There is no public registration screen on the site, and native apps are not released." },
          { type: "h2", text: "Today: local development accounts" },
          { type: "p", text: "In the development setup the web messenger talks to a local Luxora API, and accounts are created inside that environment. This is useful for testing the product, not for real use." },
          { type: "h2", text: "Planned flow" },
          { type: "p", text: "Public account creation is planned around a verified phone number and a one-time code, with passkey support as a separately gated option. The details will be confirmed before public launch and will not bypass the security review." },
          { type: "note", text: "Do not put sensitive information into development accounts: Beta builds are Cloud preview mode and the server can read message content." },
          { type: "link", text: "Read about account security", to: "/docs/account-security" },
        ],
      },
      ru: {
        title: "Создание аккаунта",
        summary: "Как аккаунты создаются сегодня и что потребует публичный сценарий.",
        blocks: [
          { type: "p", text: "Публичная регистрация не открыта. На сайте нет публичного экрана регистрации, нативные приложения не выпущены." },
          { type: "h2", text: "Сегодня: локальные аккаунты для разработки" },
          { type: "p", text: "В конфигурации разработки веб-мессенджер общается с локальным API Luxora, и аккаунты создаются внутри этой среды. Это полезно для тестирования продукта, но не для реального использования." },
          { type: "h2", text: "Запланированный сценарий" },
          { type: "p", text: "Публичное создание аккаунта запланировано по подтверждённому номеру телефона и одноразовому коду, поддержка passkey — отдельно контролируемая опция. Детали будут подтверждены до публичного запуска и не обойдут проверку безопасности." },
          { type: "note", text: "Не размещайте конфиденциальную информацию в аккаунтах разработки: бета-сборки работают в режиме Cloud preview, и сервер может читать содержимое сообщений." },
          { type: "link", text: "О безопасности аккаунта", to: "/docs/account-security" },
        ],
      },
    },
  },
  {
    slug: "profile",
    group: "account",
    copy: {
      en: {
        title: "Profile",
        summary: "Display name, username and avatar.",
        blocks: [
          { type: "p", text: "Basic profile editing (display name) is part of the messenger preview. Usernames, avatars and profile privacy controls are in development." },
          { type: "h2", text: "What is in the server foundation" },
          { type: "p", text: "The server supports profiles and identity updates with strict validation and authorization. The product surface for managing them is still being built." },
          { type: "note", text: soon.en },
        ],
      },
      ru: {
        title: "Профиль",
        summary: "Имя, имя пользователя и аватар.",
        blocks: [
          { type: "p", text: "Базовое редактирование профиля (отображаемое имя) входит в превью мессенджера. Имена пользователей, аватары и настройки приватности профиля в разработке." },
          { type: "h2", text: "Что есть в серверной основе" },
          { type: "p", text: "Сервер поддерживает профили и обновление идентичности со строгой валидацией и проверкой прав. Продуктовая поверхность для управления ими ещё строится." },
          { type: "note", text: soon.ru },
        ],
      },
    },
  },
  {
    slug: "settings",
    group: "account",
    copy: {
      en: {
        title: "Settings",
        summary: "Notifications, appearance and privacy options.",
        blocks: [
          { type: "p", text: "There is no full settings screen in Beta-0.1. The public site has a language switch; notification, appearance and privacy settings are planned." },
          { type: "h2", text: "Planned" },
          { type: "list", items: ["Notification preferences and quiet hours.", "Appearance and accessibility options.", "Privacy controls for discovery, receipts and presence."] },
          { type: "note", text: soon.en },
        ],
      },
      ru: {
        title: "Настройки",
        summary: "Уведомления, оформление и параметры приватности.",
        blocks: [
          { type: "p", text: "Полноценного экрана настроек в Beta-0.1 нет. На публичном сайте есть переключатель языка; настройки уведомлений, оформления и приватности запланированы." },
          { type: "h2", text: "Запланировано" },
          { type: "list", items: ["Параметры уведомлений и тихие часы.", "Оформление и параметры доступности.", "Настройки приватности для поиска, статусов прочтения и присутствия."] },
          { type: "note", text: soon.ru },
        ],
      },
    },
  },
  {
    slug: "sessions",
    group: "account",
    copy: {
      en: {
        title: "Sessions",
        summary: "See and end sessions on your devices.",
        blocks: [
          { type: "p", text: "The server foundation tracks per-device sessions and supports revoking them, with explicit session-invalidation events for connected clients." },
          { type: "h2", text: "Product surface" },
          { type: "p", text: "A screen that lists your devices and lets you end a session is planned. Until it ships, session management is a server capability, not a user-facing feature." },
          { type: "note", text: soon.en },
        ],
      },
      ru: {
        title: "Сеансы",
        summary: "Просмотр и завершение сеансов на устройствах.",
        blocks: [
          { type: "p", text: "Серверная основа отслеживает сеансы по устройствам и поддерживает их отзыв, с явными событиями инвалидации сеансов для подключённых клиентов." },
          { type: "h2", text: "Продуктовая поверхность" },
          { type: "p", text: "Экран со списком устройств и завершением сеанса запланирован. Пока он не вышел, управление сеансами — серверная возможность, а не пользовательская функция." },
          { type: "note", text: soon.ru },
        ],
      },
    },
  },
  {
    slug: "chats",
    group: "messaging",
    copy: {
      en: {
        title: "Chats",
        summary: "Private conversations and the chat list.",
        blocks: [
          { type: "p", text: "Direct conversations are part of the server foundation and appear in the web preview's chat list. Message requests gate conversations that privacy rules do not allow immediately." },
          { type: "h2", text: "Planned" },
          { type: "list", items: ["Folders, archive and pinned chat arrangement.", "Synchronized drafts across devices.", "Saved messages and scheduled send."] },
          { type: "note", text: "These organization features are planned, not available in Beta-0.1." },
        ],
      },
      ru: {
        title: "Чаты",
        summary: "Личные переписки и список чатов.",
        blocks: [
          { type: "p", text: "Личные переписки входят в серверную основу и отображаются в списке чатов веб-превью. Запросы на переписку ограничивают диалоги, которые правила приватности не разрешают сразу." },
          { type: "h2", text: "Запланировано" },
          { type: "list", items: ["Папки, архив и закрепление чатов.", "Синхронизация черновиков между устройствами.", "Избранное и отложенная отправка."] },
          { type: "note", text: "Эти функции организации запланированы и недоступны в Beta-0.1." },
        ],
      },
    },
  },
  {
    slug: "groups",
    group: "messaging",
    copy: {
      en: {
        title: "Groups",
        summary: "Conversations with several people.",
        blocks: [
          { type: "p", text: "Group chats exist in the server foundation with membership, roles and permissions. The web preview focuses on direct conversations first; group UI is planned." },
          { type: "h2", text: "Planned" },
          { type: "list", items: ["Group creation and invite links.", "Roles for owner, admin, moderator and member.", "Topics and admin audit surfaces."] },
          { type: "note", text: soon.en },
        ],
      },
      ru: {
        title: "Группы",
        summary: "Переписки с несколькими людьми.",
        blocks: [
          { type: "p", text: "Групповые чаты есть в серверной основе с участием, ролями и правами. Веб-превью сначала ориентировано на личные переписки; интерфейс групп запланирован." },
          { type: "h2", text: "Запланировано" },
          { type: "list", items: ["Создание групп и ссылки-приглашения.", "Роли владельца, администратора, модератора и участника.", "Темы и административные журналы."] },
          { type: "note", text: soon.ru },
        ],
      },
    },
  },
  {
    slug: "messages",
    group: "messaging",
    copy: {
      en: {
        title: "Messages",
        summary: "Sending, replies, edits and reactions.",
        blocks: [
          { type: "p", text: "Text messages are the most proven part of the project. The server foundation supports idempotent send, replies, edit history, deletion tombstones and reactions, with strict contracts shared between clients." },
          { type: "h2", text: "Delivery states" },
          { type: "p", text: "Sent, delivered and read appear only when the protocol emits the matching receipt. The app never simulates a status with a timer. This is the project's honesty rule, not a feature flag." },
          { type: "note", text: "Beta-0.1 is Cloud preview mode: the server can read message content. This is not end-to-end encryption." },
        ],
      },
      ru: {
        title: "Сообщения",
        summary: "Отправка, ответы, правки и реакции.",
        blocks: [
          { type: "p", text: "Текстовые сообщения — самая проработанная часть проекта. Серверная основа поддерживает идемпотентную отправку, ответы, историю правок, удаление и реакции, со строгими общими контрактами между клиентами." },
          { type: "h2", text: "Статусы доставки" },
          { type: "p", text: "«Отправлено», «доставлено» и «прочитано» появляются только когда протокол испускает соответствующее подтверждение. Приложение никогда не имитирует статус таймером. Это правило честности проекта, а не флаг функции." },
          { type: "note", text: "Beta-0.1 работает в режиме Cloud preview: сервер может читать содержимое сообщений. Это не сквозное шифрование." },
        ],
      },
    },
  },
  {
    slug: "media",
    group: "messaging",
    copy: {
      en: {
        title: "Media",
        summary: "Photos and videos.",
        blocks: [
          { type: "p", text: "The server has a media staging foundation: resumable encrypted uploads, authorized storage and byte-range download with quota handling. The web composer's media flow is still being built." },
          { type: "h2", text: "Current limits" },
          { type: "list", items: ["No public upload endpoint for end users yet.", "No server-side thumbnails or transcoding in this build.", "Voice messages and video notes are in development."] },
          { type: "note", text: soon.en },
        ],
      },
      ru: {
        title: "Медиа",
        summary: "Фото и видео.",
        blocks: [
          { type: "p", text: "На сервере есть основа для медиа: возобновляемые шифрованные загрузки, авторизованное хранилище и скачивание диапазонами с учётом квот. Медиа-поток в веб-композере ещё строится." },
          { type: "h2", text: "Текущие ограничения" },
          { type: "list", items: ["Публичного эндпоинта загрузки для пользователей пока нет.", "Серверных миниатюр и транскодинга в этой сборке нет.", "Голосовые сообщения и видеозаметки в разработке."] },
          { type: "note", text: soon.ru },
        ],
      },
    },
  },
  {
    slug: "files",
    group: "messaging",
    copy: {
      en: {
        title: "Files",
        summary: "Sharing documents.",
        blocks: [
          { type: "p", text: "File sharing uses the same media staging foundation as photos and videos: authorized upload, storage quotas and authenticated download. The user-facing sharing flow is planned." },
          { type: "note", text: soon.en },
          { type: "link", text: "Read the media docs", to: "/docs/media" },
        ],
      },
      ru: {
        title: "Файлы",
        summary: "Отправка документов.",
        blocks: [
          { type: "p", text: "Отправка файлов использует ту же основу, что и фото с видео: авторизованная загрузка, квоты хранилища и аутентифицированное скачивание. Пользовательский сценарий отправки запланирован." },
          { type: "note", text: soon.ru },
          { type: "link", text: "Документация о медиа", to: "/docs/media" },
        ],
      },
    },
  },
  platformPage(
    "windows",
    "Windows",
    "Luxora on Windows.",
    "Luxora на Windows.",
    "A native Windows client is planned after the server platform and the full iPhone app. It will be distributed as a signed installer with an anti-rollback updater before any public release.",
    "Нативный клиент для Windows запланирован после серверной платформы и полного приложения для iPhone. До публичного релиза он будет распространяться подписанным установщиком с защищённым от отката обновлением.",
  ),
  platformPage(
    "macos",
    "macOS",
    "Luxora on macOS.",
    "Luxora на macOS.",
    "A native macOS client is planned after the iPhone app, reusing proven Swift foundations while keeping a native interface.",
    "Нативный клиент для macOS запланирован после приложения для iPhone: с переиспользованием проверенных Swift-основ и нативным интерфейсом.",
  ),
  platformPage(
    "linux",
    "Linux",
    "Luxora on Linux.",
    "Luxora на Linux.",
    "Linux is planned together with the other desktop clients. Distribution format and packaging are not decided yet.",
    "Linux запланирован вместе с остальными десктоп-клиентами. Формат распространения и упаковка ещё не определены.",
  ),
  platformPage(
    "ios",
    "iOS",
    "Luxora on iPhone and iPad.",
    "Luxora на iPhone и iPad.",
    "The complete iPhone app is the next product milestone after the server platform. A thin integration harness exists today; it is not a public app and is not distributed.",
    "Полное приложение для iPhone — следующий продуктовый этап после серверной платформы. Сегодня существует тонкий интеграционный стенд; это не публичное приложение и оно не распространяется.",
  ),
  platformPage(
    "android",
    "Android",
    "Luxora on Android.",
    "Luxora на Android.",
    "Android is planned after iOS. No native Android client has been started.",
    "Android запланирован после iOS. Нативный Android-клиент ещё не начат.",
  ),
  platformPage(
    "web",
    "Web",
    "Luxora in the browser.",
    "Luxora в браузере.",
    "The web messenger preview is included in this build at /app and runs against a local API. It is the only client that works today, and it is a developer preview rather than a finished release.",
    "Превью веб-мессенджера включено в эту сборку по адресу /app и работает с локальным API. Это единственный клиент, который работает сегодня, и это превью для разработчиков, а не готовый релиз.",
  ),
  {
    slug: "account-security",
    group: "security",
    copy: {
      en: {
        title: "Account security",
        summary: "How account protection is designed and what exists today.",
        blocks: [
          { type: "p", text: "Account security is a server-side foundation in Beta-0.1: Argon2id password hashing, short-lived access tokens, rotating refresh tokens stored only as hashes, and per-device sessions with explicit revocation." },
          { type: "h2", text: "Not yet available" },
          { type: "list", items: ["Public sign-up and sign-in screens for real users.", "The device/session management screen.", "Passkeys as a public authentication feature.", "Account recovery as a finished flow."] },
          { type: "p", text: "The project's security document lists implemented controls next to the evidence that is still missing. That document is the honest status, not this page." },
          { type: "note", text: "Beta builds are Cloud preview mode and are not approved for sensitive use." },
          { type: "link", text: "Read the Security page", to: "/security" },
        ],
      },
      ru: {
        title: "Безопасность аккаунта",
        summary: "Как задумана защита аккаунта и что есть сегодня.",
        blocks: [
          { type: "p", text: "Безопасность аккаунта — серверная основа Beta-0.1: хеширование паролей Argon2id, короткоживущие access-токены, ротируемые refresh-токены, хранящиеся только в виде хешей, и сеансы по устройствам с явным отзывом." },
          { type: "h2", text: "Пока недоступно" },
          { type: "list", items: ["Публичные экраны регистрации и входа для реальных пользователей.", "Экран управления устройствами и сеансами.", "Passkey как публичная функция аутентификации.", "Восстановление аккаунта как готовый сценарий."] },
          { type: "p", text: "Документ безопасности проекта перечисляет реализованные меры рядом с недостающими доказательствами. Именно он — честный статус, а не эта страница." },
          { type: "note", text: "Бета-сборки работают в режиме Cloud preview и не одобрены для конфиденциального использования." },
          { type: "link", text: "Страница «Безопасность»", to: "/security" },
        ],
      },
    },
  },
  {
    slug: "privacy",
    group: "security",
    copy: {
      en: {
        title: "Privacy",
        summary: "How Luxora handles your data today.",
        blocks: [
          { type: "p", text: "Privacy and security are core priorities of Luxora. This page describes the current Beta-0.1 reality; the pre-launch Privacy Policy has the complete draft." },
          { type: "h2", text: "Cloud preview" },
          { type: "p", text: "Beta builds run in Cloud preview mode. Connections are protected in transit, but the server processes message plaintext and can read message content. Optional storage envelopes at rest do not change that trust boundary." },
          { type: "h2", text: "Planned: Private mode" },
          { type: "p", text: "End-to-end encryption is planned as a separate, audited mode with key verification and transparency, and it will ship only after an independent security review. No Beta-0.1 screen claims it." },
          { type: "h2", text: "The public website" },
          { type: "p", text: "The static site sets no cookies, runs no analytics and stores only your language choice in local storage. The pre-launch policy describes the limits in detail." },
          { type: "note", text: "Do not use Beta builds for sensitive information." },
          { type: "link", text: "Read the pre-launch Privacy Policy", to: "/privacy" },
          { type: "link", text: "Read the security model", to: "/security" },
        ],
      },
      ru: {
        title: "Приватность",
        summary: "Как Luxora работает с вашими данными сегодня.",
        blocks: [
          { type: "p", text: "Приватность и безопасность — ключевые приоритеты Luxora. Эта страница описывает текущую реальность Beta-0.1; полный черновик — в политике конфиденциальности." },
          { type: "h2", text: "Cloud preview" },
          { type: "p", text: "Бета-сборки работают в режиме Cloud preview. Соединение защищено при передаче, но сервер обрабатывает сообщения в открытом виде и может читать их содержимое. Опциональные конверты шифрования на диске не меняют эту границу доверия." },
          { type: "h2", text: "Запланировано: режим Private" },
          { type: "p", text: "Сквозное шифрование запланировано как отдельный проверенный режим с верификацией ключей и прозрачностью; он выйдет только после независимой проверки безопасности. Ни один экран Beta-0.1 не заявляет о нём." },
          { type: "h2", text: "Публичный сайт" },
          { type: "p", text: "Статический сайт не устанавливает cookies, не использует аналитику и хранит только выбор языка в локальном хранилище. Черновик политики подробно описывает ограничения." },
          { type: "note", text: "Не используйте бета-сборки для конфиденциальной информации." },
          { type: "link", text: "Черновик политики конфиденциальности", to: "/privacy" },
          { type: "link", text: "Модель безопасности", to: "/security" },
        ],
      },
    },
  },
  {
    slug: "api",
    group: "developers",
    copy: {
      en: {
        title: "API",
        summary: "Public API reference status.",
        blocks: [
          { type: "p", text: "There is no published public API specification yet. The server exposes capability discovery at GET /v1/capabilities, and the protocol contracts live in the repository as shared strict schemas." },
          { type: "h2", text: "What exists in the repository" },
          { type: "list", items: ["Typed HTTP and realtime contracts shared by server and clients.", "Capability discovery that clients use instead of guessing features.", "A reference API document maintained with the code."] },
          { type: "note", text: "Third-party API access is not open. Details will be documented before any public developer access exists." },
          { type: "link", text: "Open the repository on GitHub", href: GITHUB },
        ],
      },
      ru: {
        title: "API",
        summary: "Статус публичной документации API.",
        blocks: [
          { type: "p", text: "Опубликованной публичной спецификации API пока нет. Сервер предоставляет обнаружение возможностей через GET /v1/capabilities, а контракты протокола живут в репозитории как общие строгие схемы." },
          { type: "h2", text: "Что есть в репозитории" },
          { type: "list", items: ["Типизированные HTTP- и realtime-контракты, общие для сервера и клиентов.", "Обнаружение возможностей, которое клиенты используют вместо угадывания функций.", "Справочный документ API, поддерживаемый вместе с кодом."] },
          { type: "note", text: "Доступ к API для третьих сторон не открыт. Детали будут описаны до появления публичного доступа для разработчиков." },
          { type: "link", text: "Открыть репозиторий на GitHub", href: GITHUB },
        ],
      },
    },
  },
];

export const docOrder: string[] = docPages.map((page) => page.slug);

export function findDocPage(slug: string | undefined): DocPage | undefined {
  return docPages.find((page) => page.slug === slug);
}
