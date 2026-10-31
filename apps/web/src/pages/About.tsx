import { Gauge, Code, Layers, MessageCircle, PenTool, type LucideIcon } from "lucide-react";
import { ButtonLink, Container, ExternalLink, GITHUB_REPO_URL, PageHero, Reveal, Section, useMeta } from "../components/ui";
import { useCopy } from "../i18n";

const icons: LucideIcon[] = [Gauge, Layers, PenTool, MessageCircle];

export default function About() {
  const c = useCopy({
    en: {
      meta: [
        "About — Luxora",
        "Luxora is a protocol-first messenger built in the open by Flenym. Beta-0.1 is in development: a server foundation, an early web messenger preview and honest documentation.",
      ],
      eyebrow: "About",
      title: "Communication should feel effortless.",
      lead: "Luxora is being built around a simple idea: messaging should be fast, clear and pleasant to use, every day — without exaggerating what the product can do.",
      values: [
        { title: "Speed", text: "Fast to open and quick to respond." },
        { title: "Simplicity", text: "Fewer screens, clearer choices." },
        { title: "Craft", text: "Attention to detail in every state and transition." },
        { title: "Honesty", text: "Say what works, and say what does not yet." },
      ],
      h: "Built in the open, step by step.",
      p1: "Luxora is in active development. Features are released when they are ready, and the site describes only what is real today: a server platform in Beta-0.1, an early web messenger preview and documentation that names its own limits.",
      p2: "The build order is deliberate — the shared server platform comes first, then the complete iPhone app, and only then the remaining native clients and the full public launch. A later feature is never shown as working in an earlier build.",
      p3: "The source code is public under the MIT license. There is no company behind Luxora and no secret roadmap: the repository, the roadmap and the security model are the source of truth.",
      factsTitle: "Project facts",
      facts: [
        ["Release", "Beta-0.1 · In development"],
        ["Owner & developer", "Flenym"],
        ["License", "MIT (source code)"],
        ["Source", "github.com/Flenym/Luxora"],
        ["Web messenger", "Preview available at /app"],
        ["Native apps", "Not released"],
      ] as Array<[string, string]>,
      contact: "Contact",
      updates: "Read updates",
      security: "Security model",
      github: "GitHub repository",
    },
    ru: {
      meta: [
        "О проекте — Luxora",
        "Luxora — мессенджер, который строится открыто разработчиком Flenym. Beta-0.1 в разработке: серверная основа, раннее превью веб-мессенджера и честная документация.",
      ],
      eyebrow: "О проекте",
      title: "Общение должно быть лёгким.",
      lead: "Luxora строится вокруг простой идеи: переписка должна быть быстрой, понятной и приятной каждый день — без преувеличения возможностей продукта.",
      values: [
        { title: "Скорость", text: "Быстро открывается и быстро отвечает." },
        { title: "Простота", text: "Меньше экранов, яснее выбор." },
        { title: "Качество", text: "Внимание к деталям в каждом состоянии и переходе." },
        { title: "Честность", text: "Говорим, что работает, и что пока нет." },
      ],
      h: "Строим открыто, шаг за шагом.",
      p1: "Luxora в активной разработке. Функции выходят, когда готовы, а сайт описывает только то, что реально существует сегодня: серверная платформа в Beta-0.1, раннее превью веб-мессенджера и документация, которая называет свои ограничения.",
      p2: "Порядок работы намеренный: сначала общая серверная платформа, затем полное приложение для iPhone и только потом остальные нативные клиенты и публичный запуск. Будущая функция никогда не показывается как работающая в более ранней сборке.",
      p3: "Исходный код открыт по лицензии MIT. За Luxora не стоит компания, и секретной дорожной карты нет: репозиторий, ROADMAP и модель безопасности — источник правды.",
      factsTitle: "Факты о проекте",
      facts: [
        ["Релиз", "Beta-0.1 · В разработке"],
        ["Владелец и разработчик", "Flenym"],
        ["Лицензия", "MIT (исходный код)"],
        ["Исходники", "github.com/Flenym/Luxora"],
        ["Веб-мессенджер", "Превью доступно по адресу /app"],
        ["Нативные приложения", "Не выпущены"],
      ] as Array<[string, string]>,
      contact: "Контакты",
      updates: "Читать обновления",
      security: "Модель безопасности",
      github: "Репозиторий на GitHub",
    },
  });
  useMeta(c.meta[0], c.meta[1]);

  return (
    <>
      <PageHero eyebrow={c.eyebrow} title={c.title} lead={c.lead} />
      <Section>
        <Container>
          <div className="values">
            {c.values.map((value, index) => {
              const Icon = icons[index];
              return (
                <Reveal key={value.title} delay={index * 60}>
                  <article className="value">
                    <span className="icon-box"><Icon size={22} aria-hidden="true" /></span>
                    <h2>{value.title}</h2>
                    <p>{value.text}</p>
                  </article>
                </Reveal>
              );
            })}
          </div>
        </Container>
      </Section>
      <Section alt>
        <Container className="about-grid">
          <Reveal className="narrow-text">
            <h2 className="display section-gap">{c.h}</h2>
            <p>{c.p1}</p>
            <p>{c.p2}</p>
            <p>{c.p3}</p>
            <div className="cta-row">
              <ButtonLink to="/contact" variant="ghost">{c.contact}</ButtonLink>
              <ButtonLink to="/blog">{c.updates}</ButtonLink>
              <ButtonLink to="/security" variant="ghost">{c.security}</ButtonLink>
            </div>
          </Reveal>
          <Reveal delay={120}>
            <div className="fact-card">
              <h2>{c.factsTitle}</h2>
              <dl className="fact-list">
                {c.facts.map(([label, value]) => (
                  <div key={label}>
                    <dt>{label}</dt>
                    <dd>{value}</dd>
                  </div>
                ))}
              </dl>
              <ExternalLink href={GITHUB_REPO_URL} className="text-link">
                <Code size={16} aria-hidden="true" /> {c.github} ↗
              </ExternalLink>
            </div>
          </Reveal>
        </Container>
      </Section>
    </>
  );
}
