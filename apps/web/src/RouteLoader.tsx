/** Honest loading state for lazily loaded routes.
 *  The messenger shows a full-screen branded loader (same truthful "cloud preview"
 *  framing as the app); public routes show an inline status while their chunk loads. */
import "./route-loader.css";
import { useCopy } from "./i18n";

export default function RouteLoader({ fullscreen = false }: { fullscreen?: boolean }) {
  const c = useCopy({
    en: {
      app: "Loading the messenger…",
      page: "Loading…",
      hint: "Beta-0.1 · cloud preview · not end-to-end encrypted",
    },
    ru: {
      app: "Загружаем мессенджер…",
      page: "Загружаем…",
      hint: "Beta-0.1 · cloud preview · без end-to-end шифрования",
    },
  });

  if (fullscreen) {
    return (
      <div className="route-loader route-loader--full" role="status" aria-live="polite" aria-busy="true">
        <div className="route-loader__glow" aria-hidden="true" />
        <img className="route-loader__logo" src="/logo-64.png" alt="" width={56} height={56} />
        <p className="route-loader__name">Luxora · Beta-0.1</p>
        <span className="route-loader__bar" aria-hidden="true">
          <span />
        </span>
        <p className="route-loader__text">{c.app}</p>
        <p className="route-loader__hint">{c.hint}</p>
      </div>
    );
  }

  return (
    <div className="route-loader route-loader--inline" role="status" aria-live="polite" aria-busy="true">
      <span className="route-loader__spinner" aria-hidden="true" />
      <span className="route-loader__text">{c.page}</span>
    </div>
  );
}
