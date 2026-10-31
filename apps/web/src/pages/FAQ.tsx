import { useState } from "react";
import { ChevronDown } from "lucide-react";
import { Container, PageHero, Section, useMeta } from "../components/ui";
import { useCopy } from "../i18n";

export default function FAQ() {
  const c = useCopy({
    en: {
      meta: ["FAQ — Luxora", "Answers to common questions about Luxora: platforms, accounts, the web version and launch."],
      eyebrow: "FAQ",
      title: "Frequently asked questions",
      items: [
        { q: "What is Luxora?", a: "Luxora is a modern messenger designed for simple, fast and beautiful communication. It is currently in development." },
        { q: "Is Luxora free?", a: "More information will be available soon." },
        { q: "Which platforms will Luxora support?", a: "Windows, macOS, Linux, iOS, Android and the web are planned. See the Download page for status." },
        { q: "How do I create an account?", a: "Account creation is not open yet. More information will be available soon." },
        { q: "Can I use Luxora on multiple devices?", a: "Multi-device use is planned. More information will be available soon." },
        { q: "Is there a web version?", a: "A web version is in development. Its source code is available on GitHub." },
        { q: "When will Luxora launch?", a: "There is no launch date yet. More information will be available soon." },
        { q: "Where can I report a problem?", a: "Use the Contact page. Security issues should be reported privately first." },
      ],
    },
    ru: {
      meta: ["FAQ — Luxora", "Ответы на частые вопросы о Luxora: платформы, аккаунты, веб-версия и запуск."],
      eyebrow: "FAQ",
      title: "Частые вопросы",
      items: [
        { q: "Что такое Luxora?", a: "Luxora — современный мессенджер для простого, быстрого и красивого общения. Сейчас он в разработке." },
        { q: "Luxora бесплатный?", a: "Подробности скоро." },
        { q: "Какие платформы поддержит Luxora?", a: "Запланированы Windows, macOS, Linux, iOS, Android и веб. Статус — на странице «Скачать»." },
        { q: "Как создать аккаунт?", a: "Регистрация пока не открыта. Подробности скоро." },
        { q: "Можно ли использовать Luxora на нескольких устройствах?", a: "Работа на нескольких устройствах запланирована. Подробности скоро." },
        { q: "Есть ли веб-версия?", a: "Веб-версия в разработке. Исходный код доступен на GitHub." },
        { q: "Когда выйдет Luxora?", a: "Даты запуска пока нет. Подробности скоро." },
        { q: "Куда сообщить о проблеме?", a: "Используйте страницу «Контакты». Проблемы безопасности лучше сначала сообщать приватно." },
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
            {c.items.map((item, i) => {
              const isOpen = open === i;
              return (
                <div key={item.q} className={`acc-item ${isOpen ? "open" : ""}`}>
                  <h2>
                    <button
                      className="acc-btn"
                      aria-expanded={isOpen}
                      aria-controls={`faq-${i}`}
                      id={`faq-btn-${i}`}
                      onClick={() => setOpen(isOpen ? null : i)}
                    >
                      <span>{item.q}</span>
                      <ChevronDown size={20} aria-hidden="true" />
                    </button>
                  </h2>
                  <div id={`faq-${i}`} role="region" aria-labelledby={`faq-btn-${i}`} className="acc-panel" hidden={!isOpen}>
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
