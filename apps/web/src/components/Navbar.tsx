import { useEffect, useState } from "react";
import { Link, NavLink, useLocation } from "react-router-dom";
import { Globe, Menu, X } from "lucide-react";
import { ButtonLink, ComingSoonDialog } from "./ui";
import { useCopy, useLocale } from "../i18n";

export default function Navbar() {
  const [scrolled, setScrolled] = useState(false);
  const [open, setOpen] = useState(false);
  const [openApp, setOpenApp] = useState(false);
  const { pathname } = useLocation();
  const { locale, setLocale } = useLocale();
  const c = useCopy({
    en: {
      home: "Luxora home",
      main: "Main",
      mobile: "Mobile",
      links: [
        { to: "/#features", label: "Features" },
        { to: "/security", label: "Security" },
        { to: "/download", label: "Download" },
        { to: "/docs", label: "Docs" },
        { to: "/faq", label: "FAQ" },
      ],
      openApp: "Open Luxora",
      download: "Download",
      about: "About",
      contact: "Contact",
      openMenu: "Open menu",
      closeMenu: "Close menu",
      language: "Language",
    },
    ru: {
      home: "Luxora — на главную",
      main: "Основная навигация",
      mobile: "Мобильная навигация",
      links: [
        { to: "/#features", label: "Возможности" },
        { to: "/security", label: "Безопасность" },
        { to: "/download", label: "Скачать" },
        { to: "/docs", label: "Документация" },
        { to: "/faq", label: "FAQ" },
      ],
      openApp: "Открыть Luxora",
      download: "Скачать",
      about: "О проекте",
      contact: "Контакты",
      openMenu: "Открыть меню",
      closeMenu: "Закрыть меню",
      language: "Язык",
    },
  });

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 8);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  useEffect(() => {
    setOpen(false);
  }, [pathname]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("keydown", onKey);
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = "";
    };
  }, [open]);

  return (
    <header className={`navbar ${scrolled ? "scrolled" : ""}`}>
      <div className="container navbar-inner">
        <Link to="/" className="brand" aria-label={c.home}>
          <img src="/logo.png" alt="" width={30} height={30} />
          <span>Luxora</span>
        </Link>

        <nav className="nav-desktop" aria-label={c.main}>
          {c.links.map((l) => (
            <NavLink key={l.to} to={l.to} className="nav-link">
              {l.label}
            </NavLink>
          ))}
        </nav>

        <div className="nav-actions">
          <div className="lang" role="group" aria-label={c.language}>
            <Globe size={14} aria-hidden="true" />
            <button
              className={`lang-btn ${locale === "en" ? "active" : ""}`}
              aria-pressed={locale === "en"}
              onClick={() => setLocale("en")}
            >
              EN
            </button>
            <span aria-hidden="true">/</span>
            <button
              className={`lang-btn ${locale === "ru" ? "active" : ""}`}
              aria-pressed={locale === "ru"}
              onClick={() => setLocale("ru")}
            >
              RU
            </button>
          </div>
          <button className="btn btn-ghost btn-sm nav-open" onClick={() => setOpenApp(true)}>
            {c.openApp}
          </button>
          <ButtonLink to="/download" size="sm">{c.download}</ButtonLink>
          <button
            className="menu-toggle"
            aria-label={open ? c.closeMenu : c.openMenu}
            aria-expanded={open}
            aria-controls="mobile-menu"
            onClick={() => setOpen((v) => !v)}
          >
            {open ? <X size={22} aria-hidden="true" /> : <Menu size={22} aria-hidden="true" />}
          </button>
        </div>
      </div>

      <div id="mobile-menu" className={`mobile-menu ${open ? "open" : ""}`} hidden={!open}>
        <nav aria-label={c.mobile}>
          {c.links.map((l) => (
            <NavLink key={l.to} to={l.to} className="mobile-link">
              {l.label}
            </NavLink>
          ))}
          <NavLink to="/download" className="mobile-link mobile-link-cta">{c.download}</NavLink>
          <NavLink to="/about" className="mobile-link">{c.about}</NavLink>
          <NavLink to="/contact" className="mobile-link">{c.contact}</NavLink>
        </nav>
      </div>

      <ComingSoonDialog platform="Web" open={openApp} onClose={() => setOpenApp(false)} />
    </header>
  );
}
