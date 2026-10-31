import { Link } from "react-router-dom";
import { Container, ButtonLink, useMeta } from "../components/ui";
import { useCopy } from "../i18n";

export default function NotFound() {
  const c = useCopy({
    en: {
      meta: ["Page not found — Luxora", "This page doesn't exist."],
      title: "This page doesn't exist.",
      text: "The link may be outdated, or the page may not have been published yet.",
      back: "Back to Luxora",
      docs: "Browse documentation",
    },
    ru: {
      meta: ["Страница не найдена — Luxora", "Такой страницы не существует."],
      title: "Такой страницы не существует.",
      text: "Возможно, ссылка устарела или страница ещё не опубликована.",
      back: "На главную Luxora",
      docs: "Открыть документацию",
    },
  });
  useMeta(c.meta[0], c.meta[1], { noindex: true });

  return (
    <section className="not-found">
      <Container className="not-found-inner">
        <p className="code">404</p>
        <h1>{c.title}</h1>
        <p className="muted">{c.text}</p>
        <div className="cta-row center">
          <ButtonLink to="/">{c.back}</ButtonLink>
          <Link to="/docs" className="btn btn-ghost btn-md">{c.docs}</Link>
        </div>
      </Container>
    </section>
  );
}
