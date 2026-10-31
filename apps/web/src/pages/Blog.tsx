import { Container, PageHero, Reveal, Section, Tag, useMeta } from "../components/ui";
import { useCopy } from "../i18n";

export default function Blog() {
  const c = useCopy({
    en: {
      meta: ["Blog & updates — Luxora", "News, updates and behind-the-scenes notes from the Luxora team."],
      eyebrow: "Blog",
      title: "Updates",
      lead: "News and notes from building Luxora. Placeholder posts until the first articles are published.",
      soon: "Coming soon",
      posts: [
        { title: "Introducing Luxora", text: "Who we are and what Luxora is for." },
        { title: "The idea behind Luxora", text: "Why communication should feel effortless." },
        { title: "What's coming next", text: "The next features and platforms on the roadmap." },
        { title: "Building Luxora", text: "How the product is being made, in the open." },
      ],
    },
    ru: {
      meta: ["Блог и обновления — Luxora", "Новости, обновления и заметки о создании Luxora."],
      eyebrow: "Блог",
      title: "Обновления",
      lead: "Новости и заметки о том, как создаётся Luxora. Пока здесь заглушки до публикации первых статей.",
      soon: "Скоро",
      posts: [
        { title: "Знакомьтесь: Luxora", text: "Кто мы и для чего нужен Luxora." },
        { title: "Идея Luxora", text: "Почему общение должно быть лёгким." },
        { title: "Что дальше", text: "Ближайшие функции и платформы в дорожной карте." },
        { title: "Как создаётся Luxora", text: "Как продукт делается открыто." },
      ],
    },
  });
  useMeta(c.meta[0], c.meta[1]);

  return (
    <>
      <PageHero eyebrow={c.eyebrow} title={c.title} lead={c.lead} />
      <Section>
        <Container>
          <div className="posts">
            {c.posts.map((p, i) => (
              <Reveal key={p.title} delay={i * 60}>
                <article className="post">
                  <div className="post-meta">
                    <Tag tone="soon">{c.soon}</Tag>
                  </div>
                  <h2>{p.title}</h2>
                  <p>{p.text}</p>
                </article>
              </Reveal>
            ))}
          </div>
        </Container>
      </Section>
    </>
  );
}
