import { useState } from "react";
import { ChevronDown } from "lucide-react";
import { Container, PageHero, Section, useMeta } from "../components/ui";
import { useCopy } from "../i18n";

export default function FAQ() {
  const c = useCopy({
    en: {
      meta: [
        "FAQ — Luxora",
        "Direct answers about Luxora: what works today in Beta-0.1, why there are no downloads yet, what Cloud preview means and how to report a problem.",
      ],
      eyebrow: "FAQ",
      title: "Frequently asked questions",
      items: [
        {
          q: "What is Luxora?",
          a: "Luxora is a modern messenger being built in the open. The current Beta-0.1 repository contains a tested server foundation for identity, text messaging, realtime sync and safety flows, plus an early web messenger preview. Native apps are in development.",
        },
        {
          q: "Can I download Luxora?",
          a: "Not yet. There are no public installers, no signed native builds and no release channel. The only way to run Luxora today is to build the web client from the public repository; the Download page explains exactly how.",
        },
        {
          q: "What is Cloud preview?",
          a: "Cloud preview is the current Beta-0.1 trust mode. Connections are protected in transit, but the server processes message plaintext and can read message content. It is not end-to-end encryption. Do not use Beta builds for sensitive information.",
        },
        {
          q: "Is Luxora end-to-end encrypted?",
          a: "No. Private end-to-end encryption is a separately gated roadmap mode that will ship only after an independent security review. Until then the interface must not claim it, and neither does this site.",
        },
        {
          q: "Which platforms will Luxora support?",
          a: "Windows, macOS, Linux, iOS, Android and the web are planned. None of the native apps is released; the web messenger preview works today when connected to a Luxora API.",
        },
        {
          q: "How do I create an account?",
          a: "Public sign-up is not open. In the development setup the web messenger connects to a local API where accounts are created through that environment; there is no public registration flow yet.",
        },
        {
          q: "Is Luxora free?",
          a: "The source code is public under the MIT license and there are no paid plans today. Luxora does not sell subscriptions or accept payments, and future pricing is not decided.",
        },
        {
          q: "Can I use Luxora on multiple devices?",
          a: "Multi-device sessions are a server-side foundation, but multi-device sync as a finished product feature is planned. It is not presented as available in Beta-0.1.",
        },
        {
          q: "Is there a web version?",
          a: "Yes, an early web messenger preview is included in this build at /app. It is a development preview, not a finished release, and it does not replace the native apps.",
        },
        {
          q: "When will Luxora launch?",
          a: "There is no launch date. The order is deliberate: complete the server platform, then the full iPhone app, then the remaining clients and a public launch. Dates will be announced only when they are real.",
        },
        {
          q: "Where can I report a problem or ask a question?",
          a: "Use GitHub issues in the public repository — it is the only real contact channel today. For security problems, do not publish exploit details; follow the reporting process on the Security page.",
        },
      ],
    },
    ru: {
      meta: [
        "FAQ — Luxora",
        "Прямые ответы о Luxora: что работает в Beta-0.1 сегодня, почему нет загрузок, что такое Cloud preview и как сообщить о проблеме.",
      ],
      eyebrow: "FAQ",
      title: "Частые вопросы",
      items: [
        {
          q: "Что такое Luxora?",
          a: "Luxora — современный мессенджер, который строится открыто. В текущем репозитории Beta-0.1 есть протестированная серверная основа для идентификации, текстовых сообщений, realtime-синхронизации и сценариев безопасности, а также раннее превью веб-мессенджера. Нативные приложения в разработке.",
        },
        {
          q: "Можно ли скачать Luxora?",
          a: "Пока нет. Публичных установщиков, подписанных нативных сборок и канала релизов не существует. Единственный способ запустить Luxora сегодня — собрать веб-клиент из публичного репозитория; на странице «Скачать» описано как именно.",
        },
        {
          q: "Что такое Cloud preview?",
          a: "Cloud preview — текущий режим доверия Beta-0.1. Соединение защищено при передаче, но сервер обрабатывает сообщения в открытом виде и может читать их содержимое. Это не сквозное шифрование. Не используйте бета-сборки для конфиденциальной информации.",
        },
        {
          q: "Использует ли Luxora сквозное шифрование?",
          a: "Нет. Private E2EE — отдельный режим дорожной карты, который выйдет только после независимой проверки безопасности. До этого интерфейс не имеет права заявлять о нём, и сайт тоже.",
        },
        {
          q: "Какие платформы поддержит Luxora?",
          a: "Запланированы Windows, macOS, Linux, iOS, Android и веб. Нативные приложения не выпущены; превью веб-мессенджера работает сегодня при подключении к API Luxora.",
        },
        {
          q: "Как создать аккаунт?",
          a: "Публичная регистрация не открыта. В конфигурации разработки веб-мессенджер подключается к локальному API, где аккаунты создаются в этой среде; публичного сценария регистрации пока нет.",
        },
        {
          q: "Luxora бесплатный?",
          a: "Исходный код открыт по лицензии MIT, платных планов сегодня нет. Luxora не продаёт подписки и не принимает платежи, будущая модель ценообразования не определена.",
        },
        {
          q: "Можно ли использовать Luxora на нескольких устройствах?",
          a: "Мультидевайсные сеансы — серверная основа, но синхронизация между устройствами как готовая функция запланирована. В Beta-0.1 она не подаётся как доступная.",
        },
        {
          q: "Есть ли веб-версия?",
          a: "Да, в эту сборку включено раннее превью веб-мессенджера по адресу /app. Это превью для разработки, а не готовый релиз, и оно не заменяет нативные приложения.",
        },
        {
          q: "Когда выйдет Luxora?",
          a: "Даты запуска нет. Порядок намеренный: сначала завершить серверную платформу, затем полное приложение для iPhone, потом остальные клиенты и публичный запуск. Даты будут объявлены только когда они реальны.",
        },
        {
          q: "Куда сообщить о проблеме или задать вопрос?",
          a: "Используйте issues на GitHub в публичном репозитории — это единственный реальный канал связи сегодня. О проблемах безопасности не публикуйте детали эксплуатации; следуйте процедуре со страницы «Безопасность».",
        },
      ],
    },
  });
  useMeta(c.meta[0], c.meta[1]);
  const [open, setOpen] = useState<number | null>(0);

  return (
    <>
      <PageHero eyebrow={c.eyebrow} title={c.title} />
      <Section>
        <Container className="narrow-text">
          <div className="accordion">
            {c.items.map((item, index) => {
              const isOpen = open === index;
              return (
                <div key={item.q} className={`acc-item ${isOpen ? "open" : ""}`}>
                  <h2>
                    <button
                      className="acc-btn"
                      aria-expanded={isOpen}
                      aria-controls={`faq-${index}`}
                      id={`faq-btn-${index}`}
                      onClick={() => setOpen(isOpen ? null : index)}
                    >
                      <span>{item.q}</span>
                      <ChevronDown size={20} aria-hidden="true" />
                    </button>
                  </h2>
                  <div id={`faq-${index}`} role="region" aria-labelledby={`faq-btn-${index}`} className="acc-panel" hidden={!isOpen}>
                    <p>{item.a}</p>
                  </div>
                </div>
              );
            })}
          </div>
        </Container>
      </Section>
    </>
  );
}
