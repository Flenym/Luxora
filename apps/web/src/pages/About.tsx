import { Gauge, Layers, MessageCircle, PenTool, type LucideIcon } from "lucide-react";
import { ButtonLink, Container, PageHero, Reveal, Section, useMeta } from "../components/ui";
import { useCopy } from "../i18n";

const icons: LucideIcon[] = [Gauge, Layers, PenTool, MessageCircle];

export default function About() {
  const c = useCopy({
    en: {
      meta: ["About — Luxora", "The idea behind Luxora: communication should feel effortless."],
      eyebrow: "About",
      title: "Communication should feel effortless.",
      lead: "Luxora is being built around a simple idea. Messaging should be fast, clear and pleasant to use, every day.",
      values: [
        { title: "Speed", text: "Fast to open and quick to respond." },
        { title: "Simplicity", text: "Fewer screens, clearer choices." },
        { title: "Craft", text: "Attention to detail in every state and transition." },
        { title: "Honesty", text: "Say what works, and say what does not yet." },
      ],
      h: "Built in the open, step by step.",
      p: "Luxora is in active development. Features are released when they are ready, and the site describes only what is real today.",
      contact: "Get in touch",
      updates: "Read updates",
    },
    ru: {
      meta: ["О проекте — Luxora", "Идея Luxora: общение должно быть лёгким."],
      eyebrow: "О проекте",
      title: "Общение должно быть лёгким.",
      lead: "Luxora строится вокруг простой идеи. Переписка должна быть быстрой, понятной и приятной каждый день.",
      values: [
        { title: "Скорость", text: "Быстро открывается и быстро отвечает." },
        { title: "Простота", text: "Меньше экранов, яснее выбор." },
        { title: "Качество", text: "Внимание к деталям в каждом состоянии и переходе." },
        { title: "Честность", text: "Говорим, что работает, и что пока нет." },
      ],
      h: "Строим открыто, шаг за шагом.",
      p: "Luxora в активной разработке. Функции выходят, когда готовы, а сайт описывает только то, что существует сегодня.",
      contact: "Связаться с нами",
      updates: "Читать обновления",
    },
  });
  useMeta(c.meta[0], c.meta[1]);

  return (
    <>
      <PageHero eyebrow={c.eyebrow} title={c.title} lead={c.lead} />
      <Section>
        <Container>
          <div className="values">
            {c.values.map((v, i) => {
              const Icon = icons[i];
              return (
                <Reveal key={v.title} delay={i * 60}>
                  <article className="value">
                    <span className="icon-box"><Icon size={22} aria-hidden="true" /></span>
                    <h2>{v.title}</h2>
                    <p>{v.text}</p>
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
            <h2 className="display section-gap">{c.h}</h2>
            <p>{c.p}</p>
            <div className="cta-row">
              <ButtonLink to="/contact" variant="ghost">{c.contact}</ButtonLink>
              <ButtonLink to="/blog">{c.updates}</ButtonLink>
            </div>
          </Reveal>
        </Container>
      </Section>
    </>
  );
}
