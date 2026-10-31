import type { Locale } from "./i18n";

export type Block =
  | { type: "h2"; text: string }
  | { type: "p"; text: string }
  | { type: "list"; items: string[] }
  | { type: "code"; code: string; lang?: string }
  | { type: "note"; text: string };

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

const soon = { en: "Coming soon.", ru: "Скоро." };
const more = { en: "More information coming soon.", ru: "Подробности скоро." };

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
          { type: "p", text: "Luxora is in Beta-0.1. Public apps are not released yet, so the features in these docs describe the direction of the product, not a finished release." },
          { type: "note", text: "Beta builds run in Cloud preview mode. The server can read message content. Do not use Beta builds for sensitive information." },
        ],
      },
      ru: {
        title: "Введение",
        summary: "Что такое Luxora и на каком он этапе.",
        blocks: [
          { type: "p", text: "Luxora — современный мессенджер для простого, быстрого и красивого общения. Продукт находится в активной разработке." },
          { type: "h2", text: "Текущий статус" },
          { type: "p", text: "Luxora в версии Beta-0.1. Публичных приложений пока нет, поэтому функции из документации описывают направление развития, а не готовый релиз." },
          { type: "note", text: "Бета-сборки работают в режиме Cloud preview. Сервер может читать содержимое сообщений. Не используйте бета-сборки для конфиденциальной информации." },
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
        summary: "How to get Luxora on your device.",
        blocks: [
          { type: "p", text: "Native apps are not published yet. Platform availability is listed on the Download page." },
          { type: "h2", text: "Developers: run the web client locally" },
          { type: "p", text: "The web client lives in apps/web of the repository." },
          { type: "code", lang: "bash", code: "npm --prefix apps/web ci\nnpm --prefix apps/web run dev" },
        ],
      },
      ru: {
        title: "Установка",
        summary: "Как установить Luxora на устройство.",
        blocks: [
          { type: "p", text: "Нативные приложения пока не опубликованы. Доступность по платформам указана на странице «Скачать»." },
          { type: "h2", text: "Для разработчиков: запуск веб-клиента" },
          { type: "p", text: "Веб-клиент находится в apps/web репозитория." },
          { type: "code", lang: "bash", code: "npm --prefix apps/web ci\nnpm --prefix apps/web run dev" },
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
        summary: "What you will be able to do after you sign in.",
        blocks: [
          { type: "p", text: "Once the apps are available, the first steps will cover signing in, setting up your profile and starting your first conversation." },
          { type: "note", text: "Detailed first-run guides will be published together with the first public release." },
        ],
      },
      ru: {
        title: "Первые шаги",
        summary: "Что можно будет делать после входа.",
        blocks: [
          { type: "p", text: "Когда приложения станут доступны, первые шаги будут включать вход, настройку профиля и начало первого диалога." },
          { type: "note", text: "Подробные руководства появятся вместе с первым публичным релизом." },
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
        summary: "Sign-up flow overview.",
        blocks: [
          { type: "p", text: "Account creation is planned around a phone number and a one-time code. Details will be confirmed before public launch." },
          { type: "note", text: soon.en },
        ],
      },
      ru: {
        title: "Создание аккаунта",
        summary: "Обзор процесса регистрации.",
        blocks: [
          { type: "p", text: "Регистрация запланирована по номеру телефона и одноразовому коду. Детали будут подтверждены до публичного запуска." },
          { type: "note", text: soon.ru },
        ],
      },
    },
  },
  {
    slug: "profile",
    group: "account",
    copy: {
      en: { title: "Profile", summary: "Name, username and avatar.", blocks: [{ type: "p", text: `Profile settings are in development. ${more.en}` }] },
      ru: { title: "Профиль", summary: "Имя, имя пользователя и аватар.", blocks: [{ type: "p", text: `Настройки профиля в разработке. ${more.ru}` }] },
    },
  },
  {
    slug: "settings",
    group: "account",
    copy: {
      en: { title: "Settings", summary: "Notifications, appearance and privacy options.", blocks: [{ type: "p", text: `Settings are in development. ${more.en}` }] },
      ru: { title: "Настройки", summary: "Уведомления, оформление и параметры приватности.", blocks: [{ type: "p", text: `Настройки в разработке. ${more.ru}` }] },
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
          { type: "p", text: "Sessions are designed so you can see the devices signed in to your account and end any of them." },
          { type: "note", text: soon.en },
        ],
      },
      ru: {
        title: "Сеансы",
        summary: "Просмотр и завершение сеансов на устройствах.",
        blocks: [
          { type: "p", text: "Сеансы задуманы так, чтобы вы видели устройства, с которых выполнен вход, и могли завершить любое из них." },
          { type: "note", text: soon.ru },
        ],
      },
    },
  },
  {
    slug: "chats",
    group: "messaging",
    copy: {
      en: { title: "Chats", summary: "Private conversations and the chat list.", blocks: [{ type: "p", text: `Private chats, folders and archive are planned. ${more.en}` }] },
      ru: { title: "Чаты", summary: "Личные переписки и список чатов.", blocks: [{ type: "p", text: `Личные чаты, папки и архив запланированы. ${more.ru}` }] },
    },
  },
  {
    slug: "groups",
    group: "messaging",
    copy: {
      en: { title: "Groups", summary: "Conversations with several people.", blocks: [{ type: "p", text: `Group conversations are planned. ${more.en}` }] },
      ru: { title: "Группы", summary: "Переписки с несколькими людьми.", blocks: [{ type: "p", text: `Групповые переписки запланированы. ${more.ru}` }] },
    },
  },
  {
    slug: "messages",
    group: "messaging",
    copy: {
      en: { title: "Messages", summary: "Sending, replies, edits and reactions.", blocks: [{ type: "p", text: `Message features are in development. ${more.en}` }] },
      ru: { title: "Сообщения", summary: "Отправка, ответы, правки и реакции.", blocks: [{ type: "p", text: `Функции сообщений в разработке. ${more.ru}` }] },
    },
  },
  {
    slug: "media",
    group: "messaging",
    copy: {
      en: { title: "Media", summary: "Photos and videos.", blocks: [{ type: "p", text: `Media sharing is in development. ${more.en}` }] },
      ru: { title: "Медиа", summary: "Фото и видео.", blocks: [{ type: "p", text: `Отправка медиа в разработке. ${more.ru}` }] },
    },
  },
  {
    slug: "files",
    group: "messaging",
    copy: {
      en: { title: "Files", summary: "Sharing documents.", blocks: [{ type: "p", text: `File sharing is in development. ${more.en}` }] },
      ru: { title: "Файлы", summary: "Отправка документов.", blocks: [{ type: "p", text: `Отправка файлов в разработке. ${more.ru}` }] },
    },
  },
  {
    slug: "windows",
    group: "platforms",
    copy: {
      en: { title: "Windows", summary: "Luxora on Windows.", blocks: [{ type: "p", text: soon.en }] },
      ru: { title: "Windows", summary: "Luxora на Windows.", blocks: [{ type: "p", text: soon.ru }] },
    },
  },
  {
    slug: "macos",
    group: "platforms",
    copy: {
      en: { title: "macOS", summary: "Luxora on macOS.", blocks: [{ type: "p", text: soon.en }] },
      ru: { title: "macOS", summary: "Luxora на macOS.", blocks: [{ type: "p", text: soon.ru }] },
    },
  },
  {
    slug: "linux",
    group: "platforms",
    copy: {
      en: { title: "Linux", summary: "Luxora on Linux.", blocks: [{ type: "p", text: soon.en }] },
      ru: { title: "Linux", summary: "Luxora на Linux.", blocks: [{ type: "p", text: soon.ru }] },
    },
  },
  {
    slug: "ios",
    group: "platforms",
    copy: {
      en: { title: "iOS", summary: "Luxora on iPhone and iPad.", blocks: [{ type: "p", text: "In development. Coming soon." }] },
      ru: { title: "iOS", summary: "Luxora на iPhone и iPad.", blocks: [{ type: "p", text: "В разработке. Скоро." }] },
    },
  },
  {
    slug: "android",
    group: "platforms",
    copy: {
      en: { title: "Android", summary: "Luxora on Android.", blocks: [{ type: "p", text: soon.en }] },
      ru: { title: "Android", summary: "Luxora на Android.", blocks: [{ type: "p", text: soon.ru }] },
    },
  },
  {
    slug: "web",
    group: "platforms",
    copy: {
      en: { title: "Web", summary: "Luxora in the browser.", blocks: [{ type: "p", text: "The web client is in development. Source code is available on GitHub." }] },
      ru: { title: "Веб", summary: "Luxora в браузере.", blocks: [{ type: "p", text: "Веб-клиент в разработке. Исходный код доступен на GitHub." }] },
    },
  },
  {
    slug: "account-security",
    group: "security",
    copy: {
      en: { title: "Account security", summary: "Protecting your account.", blocks: [{ type: "p", text: `Account security features are in development. ${more.en}` }] },
      ru: { title: "Безопасность аккаунта", summary: "Защита вашего аккаунта.", blocks: [{ type: "p", text: `Функции защиты аккаунта в разработке. ${more.ru}` }] },
    },
  },
  {
    slug: "privacy",
    group: "security",
    copy: {
      en: {
        title: "Privacy",
        summary: "How Luxora handles your data.",
        blocks: [
          { type: "p", text: "Privacy and security are core priorities of Luxora. The full Privacy Policy will be published before launch." },
          { type: "note", text: "Beta builds run in Cloud preview mode. Message content is readable by the server." },
        ],
      },
      ru: {
        title: "Приватность",
        summary: "Как Luxora работает с вашими данными.",
        blocks: [
          { type: "p", text: "Приватность и безопасность — ключевые приоритеты Luxora. Полная политика конфиденциальности будет опубликована до запуска." },
          { type: "note", text: "Бета-сборки работают в режиме Cloud preview. Содержимое сообщений доступно серверу." },
        ],
      },
    },
  },
  {
    slug: "api",
    group: "developers",
    copy: {
      en: { title: "API", summary: "Public API reference.", blocks: [{ type: "p", text: soon.en }] },
      ru: { title: "API", summary: "Описание публичного API.", blocks: [{ type: "p", text: soon.ru }] },
    },
  },
];

export const docOrder: string[] = docPages.map((p) => p.slug);

export function findDocPage(slug: string | undefined): DocPage | undefined {
  return docPages.find((p) => p.slug === slug);
}
