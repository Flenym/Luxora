import { Link } from "react-router-dom";
import { GITHUB_REPO_URL } from "./ui";
import { useCopy } from "../i18n";

type FooterColumn = { title: string; items: Array<[string, string]> };

export default function Footer() {
  const c = useCopy({
    en: {
      home: "Luxora home",
      tagline: "A modern messenger designed for simple, fast and beautiful communication.",
      openApp: "Open messenger",
      columns: [
        {
          title: "Product",
          items: [
            ["/app", "Open messenger"],
            ["/download", "Download"],
            ["/security", "Security"],
            ["/#features", "Features"],
          ],
        },
        {
          title: "Docs",
          items: [
            ["/docs", "Documentation"],
            ["/docs/introduction", "Getting started"],
            ["/docs/installation", "Installation"],
            ["/docs/quick-start", "Quick start"],
            ["/faq", "FAQ"],
          ],
        },
        {
          title: "Project",
          items: [
            ["/about", "About"],
            ["/blog", "Updates"],
            ["/status", "Status"],
            ["/contact", "Contact"],
          ],
        },
        {
          title: "Legal",
          items: [
            ["/privacy", "Privacy"],
            ["/terms", "Terms"],
          ],
        },
      ] as FooterColumn[],
      github: "GitHub",
      owner: "Owner & developer: Flenym",
      rights: "© 2026 Luxora",
      status: "Beta-0.1 · In development",
      externalHint: "(opens in a new tab)",
    },
    ru: {
      home: "Luxora — на главную",
      tagline: "Современный мессенджер для простого, быстрого и красивого общения.",
      openApp: "Открыть мессенджер",
      columns: [
        {
          title: "Продукт",
          items: [
            ["/app", "Открыть мессенджер"],
            ["/download", "Скачать"],
            ["/security", "Безопасность"],
            ["/#features", "Возможности"],
          ],
        },
        {
          title: "Документация",
          items: [
            ["/docs", "Документация"],
            ["/docs/introduction", "Введение"],
            ["/docs/installation", "Установка"],
            ["/docs/quick-start", "Быстрый старт"],
            ["/faq", "FAQ"],
          ],
        },
        {
          title: "Проект",
          items: [
            ["/about", "О проекте"],
            ["/blog", "Обновления"],
            ["/status", "Статус"],
            ["/contact", "Контакты"],
          ],
        },
        {
          title: "Правовая информация",
          items: [
            ["/privacy", "Конфиденциальность"],
            ["/terms", "Условия"],
          ],
        },
      ] as FooterColumn[],
      github: "GitHub",
      owner: "Владелец и разработчик: Flenym",
      rights: "© 2026 Luxora",
      status: "Beta-0.1 · В разработке",
      externalHint: "(откроется в новой вкладке)",
    },
  });

  return (
    <footer className="footer">
      <div className="container">
        <div className="footer-grid">
          <div className="footer-brand">
            <Link to="/" className="brand" aria-label={c.home}>
              <img src="/logo-64.png" alt="" width={30} height={30} />
              <span>Luxora</span>
            </Link>
            <p>{c.tagline}</p>
            <p className="footer-owner">{c.owner}</p>
            <Link to="/app" className="footer-app-link">{c.openApp} →</Link>
          </div>
          {c.columns.map((column) => (
            <div key={column.title}>
              <h2 className="footer-title">{column.title}</h2>
              <ul className="footer-list">
                {column.items.map(([to, label]) => (
                  <li key={to}>
                    <Link to={to}>{label}</Link>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
        <div className="footer-bottom">
          <span>{c.rights}</span>
          <span className="footer-links">
            <a href={GITHUB_REPO_URL} target="_blank" rel="noopener noreferrer">
              {c.github} <span className="visually-hidden">{c.externalHint}</span> ↗
            </a>
            <span className="muted">{c.status}</span>
          </span>
        </div>
      </div>
    </footer>
  );
}
