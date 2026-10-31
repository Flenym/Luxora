import { Link } from "react-router-dom";
import { useCopy } from "../i18n";

export default function Footer() {
  const c = useCopy({
    en: {
      home: "Luxora home",
      tagline: "A modern messenger designed for simple, fast and beautiful communication.",
      columns: [
        { title: "Product", items: [["/#features", "Features"], ["/download", "Download"], ["/security", "Security"]] },
        { title: "Resources", items: [["/docs", "Documentation"], ["/faq", "FAQ"], ["/blog", "Blog"], ["/status", "Status"]] },
        { title: "Company", items: [["/about", "About"], ["/contact", "Contact"]] },
        { title: "Legal", items: [["/privacy", "Privacy"], ["/terms", "Terms"]] },
      ] as Array<{ title: string; items: Array<[string, string]> }>,
      rights: "© 2026 Luxora",
      status: "Beta-0.1 · In development",
    },
    ru: {
      home: "Luxora — на главную",
      tagline: "Современный мессенджер для простого, быстрого и красивого общения.",
      columns: [
        { title: "Продукт", items: [["/#features", "Возможности"], ["/download", "Скачать"], ["/security", "Безопасность"]] },
        { title: "Ресурсы", items: [["/docs", "Документация"], ["/faq", "FAQ"], ["/blog", "Блог"], ["/status", "Статус"]] },
        { title: "Компания", items: [["/about", "О проекте"], ["/contact", "Контакты"]] },
        { title: "Правовая информация", items: [["/privacy", "Конфиденциальность"], ["/terms", "Условия"]] },
      ] as Array<{ title: string; items: Array<[string, string]> }>,
      rights: "© 2026 Luxora",
      status: "Beta-0.1 · В разработке",
    },
  });

  return (
    <footer className="footer">
      <div className="container">
        <div className="footer-grid">
          <div className="footer-brand">
            <Link to="/" className="brand" aria-label={c.home}>
              <img src="/logo.png" alt="" width={30} height={30} />
              <span>Luxora</span>
            </Link>
            <p>{c.tagline}</p>
          </div>
          {c.columns.map((col) => (
            <div key={col.title}>
              <h3 className="footer-title">{col.title}</h3>
              <ul className="footer-list">
                {col.items.map(([to, label]) => (
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
          <span className="muted">{c.status}</span>
        </div>
      </div>
    </footer>
  );
}
