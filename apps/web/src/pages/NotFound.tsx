import { Container, ButtonLink, useMeta } from "../components/ui";
import { useCopy } from "../i18n";

export default function NotFound() {
  const c = useCopy({
    en: { meta: ["Page not found — Luxora", "This page doesn't exist."], title: "This page doesn't exist.", back: "Back to Luxora" },
    ru: { meta: ["Страница не найдена — Luxora", "Такой страницы не существует."], title: "Такой страницы не существует.", back: "На главную Luxora" },
  });
  useMeta(c.meta[0], c.meta[1]);
  return (
    <section className="not-found">
      <Container className="not-found-inner">
        <p className="code">404</p>
        <h1>{c.title}</h1>
        <ButtonLink to="/">{c.back}</ButtonLink>
      </Container>
    </section>
  );
}
