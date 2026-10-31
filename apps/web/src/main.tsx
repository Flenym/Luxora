import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import App from "./App";
import { LocaleProvider } from "./i18n";
import "./styles.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <LocaleProvider>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </LocaleProvider>
  </StrictMode>,
);

/* Honest PWA shell registration.
 *
 * Only a production HTTPS deployment installs the public-shell worker; dev
 * servers, `vite preview` and the headless E2E harness (plain http) never
 * register it, so tests keep a clean network path. The worker caches public
 * shell/static assets only — never /v1 or /v2 API traffic, sessions or message
 * content (see public/sw.js). The messenger remains online-only: there is no
 * offline message access in Beta-0.1 cloud preview. */
if (
  import.meta.env.PROD &&
  typeof navigator !== "undefined" &&
  "serviceWorker" in navigator &&
  typeof window !== "undefined" &&
  window.location.protocol === "https:"
) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch(() => {
      /* A missing/failed worker must never affect the app: fail silently. */
    });
  });
}
