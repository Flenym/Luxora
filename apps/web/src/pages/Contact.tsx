import { BookOpen, Code, MessageSquare, ShieldAlert } from "lucide-react";
import { Link } from "react-router-dom";
import { Container, ExternalLink, GITHUB_ISSUES_URL, GITHUB_REPO_URL, PageHero, Reveal, Section, Tag, useMeta } from "../components/ui";
import { useCopy } from "../i18n";

export default function Contact() {
  const c = useCopy({
    en: {
      meta: [
        "Contact — Luxora",
        "How to reach the Luxora project today: GitHub issues for bugs and feedback. There is no email inbox or phone number published yet.",
      ],
      eyebrow: "Contact",
      title: "Say hello.",
      lead: "Luxora is a small open project without a support team yet. The honest way to reach it today is GitHub.",
      noFormTitle: "No contact form, no fake inbox",
      noFormText:
        "There is no email address, phone number or support desk for Luxora yet. A message form would have nowhere to go, so this page does not pretend otherwise. The channels below are real.",
      channels: [
        {
          title: "Bugs, questions and feedback",
          text: "Open an issue in the public repository. Feature requests and documentation corrections are welcome there too.",
          link: GITHUB_ISSUES_URL,
          label: "Open a GitHub issue",
        },
        {
          title: "Security reports",
          text: "Private reporting is not configured yet. Open an issue without exploit details and ask for a private channel; do not publish reproduction steps.",
          link: GITHUB_ISSUES_URL,
          label: "See how to report",
        },
        {
          title: "Source and roadmap",
          text: "The repository contains the code, ROADMAP.md and SECURITY.md — the canonical answer to most questions about Luxora.",
          link: GITHUB_REPO_URL,
          label: "Open the repository",
        },
      ],
      docsTitle: "Before you write",
      docsText: "Many answers already exist in the documentation, the FAQ and the project status page.",
      docs: "Documentation",
      faq: "FAQ",
      status: "Project status",
      ownerNote: "Project owner & developer: Flenym.",
    },
    ru: {
      meta: [
        "Контакты — Luxora",
        "Как связаться с проектом Luxora сегодня: issues на GitHub для ошибок и отзывов. Почтовый адрес и телефон пока не публикуются.",
      ],
      eyebrow: "Контакты",
      title: "Напишите нам.",
      lead: "Luxora — небольшой открытый проект без службы поддержки. Честный способ связаться сегодня — GitHub.",
      noFormTitle: "Без формы и без выдуманного почтового ящика",
      noFormText:
        "У Luxora пока нет ни email, ни телефона, ни службы поддержки. Форма сообщений вела бы в пустоту, поэтому эта страница не притворяется, что она работает. Каналы ниже — настоящие.",
      channels: [
        {
          title: "Ошибки, вопросы и отзывы",
          text: "Откройте issue в публичном репозитории. Запросы функций и исправления документации тоже принимаются там.",
          link: GITHUB_ISSUES_URL,
          label: "Открыть issue на GitHub",
        },
        {
          title: "Сообщения о безопасности",
          text: "Приватный канал пока не настроен. Откройте issue без деталей эксплуатации и попросите приватный канал; не публикуйте шаги воспроизведения.",
          link: GITHUB_ISSUES_URL,
          label: "Как сообщить",
        },
        {
          title: "Исходники и дорожная карта",
          text: "В репозитории есть код, ROADMAP.md и SECURITY.md — канонический ответ на большинство вопросов о Luxora.",
          link: GITHUB_REPO_URL,
          label: "Открыть репозиторий",
        },
      ],
      docsTitle: "Перед тем как писать",
      docsText: "Многие ответы уже есть в документации, FAQ и на странице статуса проекта.",
      docs: "Документация",
      faq: "FAQ",
      status: "Статус проекта",
      ownerNote: "Владелец и разработчик проекта: Flenym.",
    },
  });
  useMeta(c.meta[0], c.meta[1]);

  const icons = [MessageSquare, ShieldAlert, Code];

  return (
    <>
      <PageHero eyebrow={c.eyebrow} title={c.title} lead={c.lead} />
      <Section>
        <Container className="narrow-text">
          <Reveal>
            <div className="notice-card">
              <Tag tone="soon">Beta-0.1</Tag>
              <h2 className="section-gap">{c.noFormTitle}</h2>
              <p>{c.noFormText}</p>
            </div>
          </Reveal>
          <div className="contact-channels">
            {c.channels.map((channel, index) => {
              const Icon = icons[index];
              return (
                <Reveal key={channel.title} delay={index * 60}>
                  <article className="contact-card">
                    <span className="icon-box"><Icon size={22} aria-hidden="true" /></span>
                    <h2>{channel.title}</h2>
                    <p>{channel.text}</p>
                    <ExternalLink href={channel.link} className="text-link">
                      {channel.label} ↗
                    </ExternalLink>
                  </article>
                </Reveal>
              );
            })}
          </div>
        </Container>
      </Section>
      <Section alt>
        <Container className="narrow-text">
          <Reveal>
            <h2 className="display">{c.docsTitle}</h2>
            <p className="lead">{c.docsText}</p>
            <div className="cta-row">
              <Link to="/docs" className="btn btn-primary btn-md">
                <BookOpen size={18} aria-hidden="true" />
                {c.docs}
              </Link>
              <Link to="/faq" className="btn btn-ghost btn-md">{c.faq}</Link>
              <Link to="/status" className="btn btn-ghost btn-md">{c.status}</Link>
            </div>
            <p className="muted section-gap">{c.ownerNote}</p>
          </Reveal>
        </Container>
      </Section>
    </>
  );
}
