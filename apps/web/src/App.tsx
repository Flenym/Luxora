import { lazy, Suspense } from "react";
import { Navigate, Outlet, Route, Routes, useLocation } from "react-router-dom";
import Navbar from "./components/Navbar";
import Footer from "./components/Footer";
import { ScrollToTop } from "./components/ScrollToTop";
import Home from "./pages/Home";
import RouteLoader from "./RouteLoader";
import { useCopy } from "./i18n";

/*
 * Route-level code splitting: the authenticated messenger (its data layer,
 * livekit client and app stylesheet) and the heavier public pages ship as their
 * own chunks. Home stays eager because it is the initial marketing route (the
 * 3D hero scene is already lazy inside it), so the landing page paints without
 * an extra round trip. Every lazy route has an honest loading fallback.
 */
const MessengerApp = lazy(() => import("./app/MessengerApp"));
const DocsPage = lazy(() => import("./pages/DocsPage"));
const Download = lazy(() => import("./pages/Download"));
const Security = lazy(() => import("./pages/Security"));
const FAQ = lazy(() => import("./pages/FAQ"));
const About = lazy(() => import("./pages/About"));
const Blog = lazy(() => import("./pages/Blog"));
const Status = lazy(() => import("./pages/Status"));
const Contact = lazy(() => import("./pages/Contact"));
const Legal = lazy(() => import("./pages/Legal"));
const NotFound = lazy(() => import("./pages/NotFound"));

function Layout() {
  const { pathname } = useLocation();
  const c = useCopy({ en: "Skip to content", ru: "Перейти к содержимому" });
  return (
    <>
      <ScrollToTop />
      <a className="skip-link" href="#main">{c}</a>
      <Navbar />
      {/* tabIndex={-1} lets the skip link move keyboard focus, not just scroll. */}
      <main id="main" tabIndex={-1}>
        <Suspense fallback={<RouteLoader />}>
          {/* Keyed wrapper re-runs the enter animation on every route change. */}
          <div key={pathname} className="page-enter">
            <Outlet />
          </div>
        </Suspense>
      </main>
      <Footer />
    </>
  );
}

const messengerRoute = (
  <Suspense fallback={<RouteLoader fullscreen />}>
    <MessengerApp />
  </Suspense>
);

export default function App() {
  return (
    <Routes>
      {/* Authenticated messenger: full-screen, intentionally outside the marketing layout. */}
      <Route path="app" element={messengerRoute} />
      <Route path="app/*" element={messengerRoute} />
      <Route element={<Layout />}>
        <Route index element={<Home />} />
        <Route path="download" element={<Download />} />
        <Route path="security" element={<Security />} />
        <Route path="docs" element={<Navigate to="/docs/introduction" replace />} />
        <Route path="docs/:slug" element={<DocsPage />} />
        <Route path="faq" element={<FAQ />} />
        <Route path="about" element={<About />} />
        <Route path="blog" element={<Blog />} />
        <Route path="status" element={<Status />} />
        <Route path="contact" element={<Contact />} />
        <Route path="privacy" element={<Legal kind="privacy" />} />
        <Route path="terms" element={<Legal kind="terms" />} />
        <Route path="*" element={<NotFound />} />
      </Route>
    </Routes>
  );
}
