import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { Link, useLocation } from "react-router-dom";
import { useCopy, useLocale, type Locale } from "../i18n";

/** Canonical public origin for the marketing site (API/auth live on api./auth. subdomains). */
export const SITE_ORIGIN = "https://luxora.app";
/** Public source repository, the only honest contact channel that exists today. */
export const GITHUB_REPO_URL = "https://github.com/Flenym/Luxora";
export const GITHUB_ISSUES_URL = "https://github.com/Flenym/Luxora/issues";

export function Container({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <div className={`container ${className}`}>{children}</div>;
}

export function Section({
  id,
  alt = false,
  children,
  className = "",
}: {
  id?: string;
  alt?: boolean;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section id={id} className={`section ${alt ? "section-alt" : ""} ${className}`}>
      {children}
    </section>
  );
}

export function Eyebrow({ children }: { children: ReactNode }) {
  return <p className="eyebrow">{children}</p>;
}

export function Tag({ children, tone = "neutral" }: { children: ReactNode; tone?: "live" | "soon" | "neutral" }) {
  return <span className={`tag tag-${tone}`}>{children}</span>;
}

export function PageHero({
  eyebrow,
  title,
  lead,
  children,
}: {
  eyebrow?: string;
  title: string;
  lead?: string;
  children?: ReactNode;
}) {
  return (
    <header className="page-hero">
      <Container>
        {eyebrow && <Eyebrow>{eyebrow}</Eyebrow>}
        <h1>{title}</h1>
        {lead && <p className="lead">{lead}</p>}
        {children}
      </Container>
    </header>
  );
}

/** External link that opens in a new tab; the accessible name can be overridden. */
export function ExternalLink({
  href,
  children,
  className,
  label,
}: {
  href: string;
  children: ReactNode;
  className?: string;
  label?: string;
}) {
  return (
    <a className={className} href={href} target="_blank" rel="noopener noreferrer" aria-label={label}>
      {children}
    </a>
  );
}

/** Fades content in when it enters the viewport.
 *
 * Content is never left permanently hidden: without IntersectionObserver, with
 * reduced motion, when it is already on screen, or after a short safety timeout
 * that covers broken observers, scrolling harnesses and print/PDF rendering.
 */
export function Reveal({ children, delay = 0, className = "" }: { children: ReactNode; delay?: number; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [shown, setShown] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    let done = false;
    let io: IntersectionObserver | null = null;
    let timer = 0;
    let raf = 0;

    const reveal = () => {
      if (done) return;
      done = true;
      setShown(true);
      io?.disconnect();
      window.clearTimeout(timer);
    };

    const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
    if (reduce || !("IntersectionObserver" in window)) {
      reveal();
      return;
    }

    io = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) reveal();
      },
      { threshold: 0, rootMargin: "0px 0px 8% 0px" },
    );
    io.observe(el);

    // Safety net so real content can never stay invisible because of a missed
    // observer callback (small viewports, screenshot harnesses, odd embeds).
    timer = window.setTimeout(reveal, 2200);
    raf = window.requestAnimationFrame(() => {
      const rect = el.getBoundingClientRect();
      if (rect.top < window.innerHeight && rect.bottom > 0) reveal();
    });

    return () => {
      io?.disconnect();
      window.clearTimeout(timer);
      window.cancelAnimationFrame(raf);
    };
  }, []);

  return (
    <div ref={ref} className={`reveal ${shown ? "in" : ""} ${className}`} style={{ animationDelay: `${delay}ms` }}>
      {children}
    </div>
  );
}

type ButtonProps = {
  children: ReactNode;
  icon?: ReactNode;
  variant?: "primary" | "ghost";
  size?: "md" | "sm";
};

export function ButtonLink({ to, ...props }: ButtonProps & { to: string }) {
  return (
    <Link to={to} className={`btn btn-${props.variant ?? "primary"} btn-${props.size ?? "md"}`}>
      {props.icon}
      {props.children}
    </Link>
  );
}

type MetaOptions = {
  /** Absolute path used for the canonical URL; defaults to the current router path. */
  path?: string;
  /** 404/utility pages must not be indexed and must not advertise a canonical public URL. */
  noindex?: boolean;
};

function upsertMeta(attribute: "name" | "property", key: string, content: string) {
  let meta = document.head.querySelector<HTMLMetaElement>(`meta[${attribute}="${key}"]`);
  if (!meta) {
    meta = document.createElement("meta");
    meta.setAttribute(attribute, key);
    document.head.appendChild(meta);
  }
  meta.content = content;
}

function normalizePath(path: string) {
  const withSlash = path.startsWith("/") ? path : `/${path}`;
  const withoutHash = withSlash.split("#")[0].split("?")[0];
  return withoutHash === "/" ? "/" : withoutHash.replace(/\/+$/, "");
}

export function canonicalUrlFor(path: string) {
  return `${SITE_ORIGIN}${normalizePath(path)}`;
}

function setCanonical(href: string | null) {
  let link = document.head.querySelector<HTMLLinkElement>('link[rel="canonical"]');
  if (!href) {
    link?.remove();
    return;
  }
  if (!link) {
    link = document.createElement("link");
    link.rel = "canonical";
    document.head.appendChild(link);
  }
  link.href = href;
}

/** Sets document title, description, canonical URL and matching Open Graph /
 * Twitter metadata for the current public page. */
export function useMeta(title: string, description: string, options: MetaOptions = {}) {
  const { pathname } = useLocation();
  const { locale } = useLocale();
  const { noindex = false, path } = options;

  useEffect(() => {
    const canonical = canonicalUrlFor(path ?? pathname);
    const ogLocale = locale === "ru" ? "ru_RU" : "en_US";
    const ogLocaleAlt = locale === "ru" ? "en_US" : "ru_RU";

    document.title = title;
    upsertMeta("name", "description", description);
    upsertMeta("name", "robots", noindex ? "noindex, nofollow" : "index, follow");
    upsertMeta("property", "og:title", title);
    upsertMeta("property", "og:description", description);
    upsertMeta("property", "og:locale", ogLocale);
    upsertMeta("property", "og:locale:alternate", ogLocaleAlt);
    upsertMeta("name", "twitter:title", title);
    upsertMeta("name", "twitter:description", description);

    if (noindex) {
      setCanonical(null);
    } else {
      upsertMeta("property", "og:url", canonical);
      setCanonical(canonical);
    }
  }, [title, description, noindex, path, pathname, locale]);
}

/**
 * Accessible modal dialog: moves focus inside, traps Tab/Shift+Tab, closes on
 * Escape, backdrop click or the close button, and restores the previous focus.
 */
export function Modal({
  open,
  title,
  onClose,
  children,
}: {
  open: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const copy = useCopy({ en: { close: "Close" }, ru: { close: "Закрыть" } });
  const titleId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!open) return;

    restoreFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;

    const dialog = dialogRef.current;
    const focusables = () =>
      Array.from(
        dialog?.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ) ?? [],
      ).filter((el) => el.getClientRects().length > 0);

    dialog?.focus();

    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onCloseRef.current();
        return;
      }
      if (event.key !== "Tab" || !dialog) return;
      const items = focusables();
      if (items.length === 0) {
        event.preventDefault();
        dialog.focus();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement;
      if (event.shiftKey && (active === first || active === dialog)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("keydown", onKey);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = previousOverflow;
      const restore = restoreFocusRef.current;
      if (restore && document.contains(restore)) restore.focus();
    };
  }, [open]);

  if (!open) return null;

  return (
    <div className="modal-backdrop" onMouseDown={() => onCloseRef.current()}>
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="modal"
        tabIndex={-1}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <h2 id={titleId}>{title}</h2>
        <div className="modal-body">{children}</div>
        <button ref={closeRef} className="btn btn-ghost btn-md" onClick={() => onCloseRef.current()}>
          {copy.close}
        </button>
      </div>
    </div>
  );
}

export function localeName(locale: Locale) {
  return locale === "ru" ? "Русский" : "English";
}
