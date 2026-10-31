import { useEffect, useRef, useState } from "react";
import { Link, NavLink, useLocation } from "react-router-dom";
import { Globe, Menu, X } from "lucide-react";
import { ButtonLink } from "./ui";
import { useCopy, useLocale } from "../i18n";

export default function Navbar() {
  const [scrolled, setScrolled] = useState(false);
  const [open, setOpen] = useState(false);
  const { pathname, hash } = useLocation();
  const { locale, setLocale } = useLocale();
  const toggleRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const wasOpenRef = useRef(false);

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
      openApp: "Open messenger",
      openAppMobile: "Open messenger",
      download: "Download",
      about: "About",
      contact: "Contact",
      openMenu: "Open menu",
      closeMenu: "Close menu",
      language: "Language",
      switchToEn: "Switch to English",
      switchToRu: "Switch to Russian",
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
      openApp: "Открыть мессенджер",
      openAppMobile: "Открыть мессенджер",
      download: "Скачать",
      about: "О проекте",
      contact: "Контакты",
      openMenu: "Открыть меню",
      closeMenu: "Закрыть меню",
      language: "Язык",
      switchToEn: "Переключить на английский",
      switchToRu: "Переключить на русский",
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

  // While the mobile menu is open: focus the first item, lock page scroll and
  // close on Escape. Focus returns to the toggle when the menu closes.
  useEffect(() => {
    if (!open) {
      if (wasOpenRef.current) {
        wasOpenRef.current = false;
        toggleRef.current?.focus();
      }
      return;
    }
    wasOpenRef.current = true;
    menuRef.current?.querySelector<HTMLElement>("a, button")?.focus();

    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = previousOverflow;
    };
  }, [open]);

  const isHashActive = (to: string) => {
    const [path, hashPart] = to.split("#");
    return pathname === (path || "/") && hash === `#${hashPart}`;
  };

  return (
    <header className={`navbar ${scrolled ? "scrolled" : ""}`}>
      <div className="container navbar-inner">
        <Link to="/" className="brand" aria-label={c.home}>
          <img src="/logo-64.png" alt="" width={30} height={30} />
          <span>Luxora</span>
        </Link>

        <nav className="nav-desktop" aria-label={c.main}>
          {c.links.map((link) =>
            link.to.includes("#") ? (
              <Link
                key={link.to}
                to={link.to}
                className={`nav-link ${isHashActive(link.to) ? "active" : ""}`}
                aria-current={isHashActive(link.to) ? "page" : undefined}
              >
                {link.label}
              </Link>
            ) : (
              <NavLink key={link.to} to={link.to} end={link.to === "/security" || link.to === "/download" || link.to === "/faq"} className="nav-link">
                {link.label}
              </NavLink>
            ),
          )}
        </nav>

        <div className="nav-actions">
          <div className="lang" role="group" aria-label={c.language}>
            <Globe size={14} aria-hidden="true" />
            <button
              className={`lang-btn ${locale === "en" ? "active" : ""}`}
              aria-pressed={locale === "en"}
              aria-label={`EN — ${c.switchToEn}`}
              lang="en"
              onClick={() => setLocale("en")}
            >
              EN
            </button>
            <span aria-hidden="true">/</span>
            <button
              className={`lang-btn ${locale === "ru" ? "active" : ""}`}
              aria-pressed={locale === "ru"}
              aria-label={`RU — ${c.switchToRu}`}
              lang="ru"
              onClick={() => setLocale("ru")}
            >
              RU
            </button>
          </div>
          <ButtonLink to="/app" size="sm">{c.openApp}</ButtonLink>
          <ButtonLink to="/download" variant="ghost" size="sm">{c.download}</ButtonLink>
          <button
            ref={toggleRef}
            className="menu-toggle"
            aria-label={open ? c.closeMenu : c.openMenu}
            aria-expanded={open}
            aria-controls="mobile-menu"
            onClick={() => setOpen((value) => !value)}
          >
            {open ? <X size={22} aria-hidden="true" /> : <Menu size={22} aria-hidden="true" />}
          </button>
        </div>
      </div>

      <div id="mobile-menu" ref={menuRef} className={`mobile-menu ${open ? "open" : ""}`} hidden={!open}>
        <nav aria-label={c.mobile}>
          <NavLink to="/app" className="mobile-link mobile-link-cta">{c.openAppMobile}</NavLink>
          {c.links.map((link) => (
            <NavLink key={link.to} to={link.to} className="mobile-link">
              {link.label}
            </NavLink>
          ))}
          <NavLink to="/about" className="mobile-link">{c.about}</NavLink>
          <NavLink to="/contact" className="mobile-link">{c.contact}</NavLink>
        </nav>
      </div>
    </header>
  );
}
