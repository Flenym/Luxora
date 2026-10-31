import { useEffect, useRef, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { useCopy } from "../i18n";

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

/** Fades content in when it enters the viewport. Content is visible if IntersectionObserver is unavailable. */
export function Reveal({ children, delay = 0, className = "" }: { children: ReactNode; delay?: number; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [shown, setShown] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (!("IntersectionObserver" in window)) {
      setShown(true);
      return;
    }
    const io = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setShown(true);
          io.disconnect();
        }
      },
      { threshold: 0.12, rootMargin: "0px 0px -6% 0px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  return (
    <div ref={ref} className={`reveal ${shown ? "in" : ""} ${className}`} style={{ transitionDelay: `${delay}ms` }}>
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

/** Sets document title and description (and matching Open Graph tags) for the current page. */
export function useMeta(title: string, description: string) {
  useEffect(() => {
    document.title = title;
    let meta = document.querySelector<HTMLMetaElement>('meta[name="description"]');
    if (!meta) {
      meta = document.createElement("meta");
      meta.name = "description";
      document.head.appendChild(meta);
    }
    meta.content = description;
    const ogTitle = document.querySelector<HTMLMetaElement>('meta[property="og:title"]');
    if (ogTitle) ogTitle.content = title;
    const ogDesc = document.querySelector<HTMLMetaElement>('meta[property="og:description"]');
    if (ogDesc) ogDesc.content = description;
  }, [title, description]);
}

/** Accessible modal: closes on Escape, backdrop click or the close button; focus moves into the dialog. */
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
  const closeRef = useRef<HTMLButtonElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!open) return;
    closeRef.current?.focus();
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === "Escape") onCloseRef.current();
    };
    document.addEventListener("keydown", onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [open]);

  if (!open) return null;

  return (
    <div className="modal-backdrop" onMouseDown={() => onCloseRef.current()}>
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="modal-title"
        className="modal"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <h2 id="modal-title">{title}</h2>
        <div className="modal-body">{children}</div>
        <button ref={closeRef} className="btn btn-ghost btn-md" onClick={() => onCloseRef.current()}>
          {copy.close}
        </button>
      </div>
    </div>
  );
}

export function ComingSoonDialog({
  platform,
  open,
  onClose,
}: {
  platform: string;
  open: boolean;
  onClose: () => void;
}) {
  const copy = useCopy({
    en: { title: `Luxora for ${platform}`, a: "We're still working on it.", b: "Coming soon." },
    ru: { title: `Luxora для ${platform}`, a: "Мы ещё работаем над этим.", b: "Скоро." },
  });
  return (
    <Modal open={open} title={copy.title} onClose={onClose}>
      <p>{copy.a}</p>
      <p className="muted">{copy.b}</p>
    </Modal>
  );
}
