/** Small accessible primitives shared across the messenger UI. */
import {
  useEffect,
  useId,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type CSSProperties,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import type { Presence, ChatRole } from "../contract";
import { useStrings } from "./copy";
import { initials } from "./format";
import { useAuthedObjectUrl } from "./media";

/* ------------------------------------------------------------------ avatar */

type AvatarProps = {
  name: string | null | undefined;
  path?: string | null;
  size?: "xs" | "sm" | "md" | "lg";
  presence?: Presence | null;
  className?: string;
};

/** Initials are the guaranteed fallback; an authenticated avatar is optional. */
export function Avatar({ name, path, size = "md", presence, className }: AvatarProps) {
  const { url } = useAuthedObjectUrl(path ?? null);
  const [broken, setBroken] = useState(false);
  useEffect(() => setBroken(false), [url]);
  const label = (name ?? "").trim() || "?";
  return (
    <span
      className={`avatar avatar--${size}${className ? ` ${className}` : ""}`}
      role="img"
      aria-label={label}
      data-presence={presence ?? undefined}
    >
      <span className="avatar__initials" aria-hidden="true">
        {initials(name)}
      </span>
      {url && !broken ? (
        <img className="avatar__image" src={url} alt="" aria-hidden="true" onError={() => setBroken(true)} />
      ) : null}
      {presence ? <span className={`avatar__presence avatar__presence--${presence}`} aria-hidden="true" /> : null}
    </span>
  );
}

/* --------------------------------------------------------------- icon button */

type IconButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  label: string;
  size?: "sm" | "md";
  variant?: "ghost" | "solid" | "accent";
  testId?: string;
  children: ReactNode;
};

export function IconButton({ label, size = "md", variant = "ghost", className, testId, children, ...rest }: IconButtonProps) {
  return (
    <button
      type="button"
      {...rest}
      data-testid={testId}
      aria-label={label}
      title={rest.title ?? label}
      className={`icon-button icon-button--${size} icon-button--${variant}${className ? ` ${className}` : ""}`}
    >
      {children}
    </button>
  );
}

/* ------------------------------------------------------------------ spinner */

export function Spinner({ label }: { label?: string }) {
  return (
    <span className="spinner" role="status" aria-live="polite" aria-label={label ?? "Loading"}>
      <span className="spinner__ring" aria-hidden="true" />
    </span>
  );
}

/* -------------------------------------------------------------------- modal */

let openModalCount = 0;

type ModalProps = {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  testId?: string;
  className?: string;
  variant?: "card" | "overlay";
};

const FOCUSABLE =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** Portal dialog with focus trap, Escape handling, scroll lock and focus restore. */
export function Modal({ open, onClose, title, children, testId, className, variant = "card" }: ModalProps) {
  const s = useStrings();
  const panelRef = useRef<HTMLDivElement | null>(null);
  const titleId = useId();
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    openModalCount += 1;
    const { overflow } = document.body.style;
    document.body.style.overflow = "hidden";

    const focusFirst = () => {
      const panel = panelRef.current;
      if (!panel) return;
      const target =
        panel.querySelector<HTMLElement>("[data-autofocus]") ?? panel.querySelector<HTMLElement>(FOCUSABLE);
      (target ?? panel).focus({ preventScroll: true });
    };
    const frame = window.requestAnimationFrame(focusFirst);

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        onCloseRef.current();
        return;
      }
      if (event.key !== "Tab") return;
      const panel = panelRef.current;
      if (!panel) return;
      const nodes = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
        (node) => node.offsetParent !== null || node === document.activeElement,
      );
      if (nodes.length === 0) {
        event.preventDefault();
        panel.focus();
        return;
      }
      const first = nodes[0]!;
      const last = nodes[nodes.length - 1]!;
      if (event.shiftKey && (document.activeElement === first || document.activeElement === panel)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      window.cancelAnimationFrame(frame);
      document.removeEventListener("keydown", onKeyDown, true);
      document.body.style.overflow = overflow;
      openModalCount = Math.max(0, openModalCount - 1);
      if (openModalCount === 0 && previous && document.contains(previous)) {
        previous.focus({ preventScroll: true });
      }
    };
  }, [open]);

  if (!open || typeof document === "undefined") return null;

  const content = (
    <div className={`lux-modal lux-modal--${variant}`}>
      <div
        className="lux-modal__backdrop"
        aria-hidden="true"
        onMouseDown={() => onCloseRef.current()}
      />
      <div
        ref={panelRef}
        className={`lux-modal__panel${className ? ` ${className}` : ""}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        data-testid={testId}
      >
        <div className="lux-modal__head">
          <h2 id={titleId} className="lux-modal__title">
            {title}
          </h2>
          <IconButton label={s.dialogs.close} size="sm" onClick={() => onCloseRef.current()}>
            <X size={18} aria-hidden="true" />
          </IconButton>
        </div>
        <div className="lux-modal__body">{children}</div>
      </div>
    </div>
  );

  return createPortal(content, document.body);
}

/* ------------------------------------------------------------------ popover */

type PopoverProps = {
  open: boolean;
  x: number;
  y: number;
  onClose: () => void;
  label: string;
  children: ReactNode;
  align?: "left" | "right";
};

/** Small anchored menu: outside click + Escape close, arrow-key roving focus. */
export function Popover({ open, x, y, onClose, label, children }: PopoverProps) {
  const panelRef = useRef<HTMLDivElement | null>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      const panel = panelRef.current;
      if (!panel) return;
      if (event.target instanceof Node && !panel.contains(event.target)) onCloseRef.current();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onCloseRef.current();
        return;
      }
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        const panel = panelRef.current;
        if (!panel) return;
        const items = Array.from(panel.querySelectorAll<HTMLElement>("[role='menuitem'], button")).filter(
          (node) => !node.hasAttribute("disabled"),
        );
        if (items.length === 0) return;
        event.preventDefault();
        const index = items.indexOf(document.activeElement as HTMLElement);
        const next =
          event.key === "ArrowDown"
            ? items[(index + 1 + items.length) % items.length]!
            : items[(index - 1 + items.length) % items.length]!;
        next.focus();
      }
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKeyDown, true);
    const previouslyFocused =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const frame = window.requestAnimationFrame(() => {
      const panel = panelRef.current;
      const first = panel?.querySelector<HTMLElement>("[role='menuitem'], button:not([disabled])");
      first?.focus({ preventScroll: true });
    });
    return () => {
      window.cancelAnimationFrame(frame);
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKeyDown, true);
      // Restore focus to the control that opened the menu once it is unmounted.
      window.requestAnimationFrame(() => {
        const active = document.activeElement;
        const focusIsLost = active === null || active === document.body;
        if (previouslyFocused !== null && document.contains(previouslyFocused) && focusIsLost) {
          previouslyFocused.focus({ preventScroll: true });
        }
      });
    };
  }, [open]);

  if (!open || typeof document === "undefined") return null;
  const left = Math.max(8, Math.min(x, window.innerWidth - 232));
  const top = Math.max(8, Math.min(y, window.innerHeight - 8));
  return createPortal(
    <div
      ref={panelRef}
      className="popover"
      role="menu"
      aria-label={label}
      style={{ left, top } as CSSProperties}
    >
      {children}
    </div>,
    document.body,
  );
}

export function PopoverItem({
  children,
  onSelect,
  danger,
  disabled,
}: {
  children: ReactNode;
  onSelect: () => void;
  danger?: boolean;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      className={`popover__item${danger ? " popover__item--danger" : ""}`}
      onClick={onSelect}
      disabled={disabled}
    >
      {children}
    </button>
  );
}

/* -------------------------------------------------------------- misc badges */

export function RoleBadge({ role }: { role: ChatRole }) {
  const s = useStrings();
  if (role === "member") return null;
  return <span className={`role-badge role-badge--${role}`}>{s.conversation.role[role]}</span>;
}

export function Chip({ children, tone = "neutral" }: { children: ReactNode; tone?: "neutral" | "violet" | "warn" }) {
  return <span className={`chip chip--${tone}`}>{children}</span>;
}
