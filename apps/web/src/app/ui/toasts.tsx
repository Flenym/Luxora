/** Toast stack: store errors/notices plus local action feedback. One live region,
 *  stable test ids on the store-driven toasts only (E2E contract). */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { CircleAlert, Info, X } from "lucide-react";
import { useMessenger } from "../messenger";
import { useStrings } from "./copy";

type LocalToast = { id: number; text: string; tone: "notice" | "error" };

type ToastFeed = {
  notify: (text: string, tone?: "notice" | "error") => void;
  fail: (text: string) => void;
};

const ToastContext = createContext<ToastFeed>({ notify: () => {}, fail: () => {} });

export function useToasts(): ToastFeed {
  return useContext(ToastContext);
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [local, setLocal] = useState<LocalToast[]>([]);
  const counter = useRef(0);

  const dismiss = useCallback((id: number) => {
    setLocal((items) => items.filter((item) => item.id !== id));
  }, []);

  const notify = useCallback(
    (text: string, tone: "notice" | "error" = "notice") => {
      counter.current += 1;
      const id = counter.current;
      setLocal((items) => [...items.slice(-3), { id, text, tone }]);
      window.setTimeout(() => dismiss(id), tone === "error" ? 8000 : 5000);
    },
    [dismiss],
  );

  const feed = useMemo<ToastFeed>(() => ({ notify, fail: (text: string) => notify(text, "error") }), [notify]);

  return (
    <ToastContext.Provider value={feed}>
      {children}
      <ToastStack local={local} onDismiss={dismiss} />
    </ToastContext.Provider>
  );
}

function ToastStack({ local, onDismiss }: { local: LocalToast[]; onDismiss: (id: number) => void }) {
  const api = useMessenger();
  const s = useStrings();
  const [mounted, setMounted] = useState(true);

  useEffect(() => setMounted(true), []);

  return (
    <div className="toast-stack" aria-live="polite" aria-relevant="additions text" aria-atomic="false">
      {api.error ? (
        <div className="toast toast--error" data-testid="toast-error" role="alert">
          <CircleAlert size={17} aria-hidden="true" />
          <span className="toast__text">{api.error}</span>
          <button type="button" className="toast__dismiss" aria-label={s.toasts.dismiss} title={s.toasts.dismiss} onClick={() => api.clearError()}>
            <X size={15} aria-hidden="true" />
          </button>
        </div>
      ) : null}
      {api.notice ? (
        <div className="toast toast--notice" data-testid="toast-notice" role="status">
          <Info size={17} aria-hidden="true" />
          <span className="toast__text">{api.notice}</span>
          <button type="button" className="toast__dismiss" aria-label={s.toasts.dismiss} title={s.toasts.dismiss} onClick={() => api.dismissNotice()}>
            <X size={15} aria-hidden="true" />
          </button>
        </div>
      ) : null}
      {mounted
        ? local.map((toast) => (
            <div key={toast.id} className={`toast toast--${toast.tone} toast--local`} role={toast.tone === "error" ? "alert" : "status"}>
              {toast.tone === "error" ? <CircleAlert size={17} aria-hidden="true" /> : <Info size={17} aria-hidden="true" />}
              <span className="toast__text">{toast.text}</span>
              <button type="button" className="toast__dismiss" aria-label={s.toasts.dismiss} title={s.toasts.dismiss} onClick={() => onDismiss(toast.id)}>
                <X size={15} aria-hidden="true" />
              </button>
            </div>
          ))
        : null}
    </div>
  );
}
