import { Navigate, Outlet, Route, Routes, useLocation } from "react-router-dom";
import Navbar from "./components/Navbar";
import Footer from "./components/Footer";
import { ScrollToTop } from "./components/ScrollToTop";
import Home from "./pages/Home";
import Download from "./pages/Download";
import Security from "./pages/Security";
import FAQ from "./pages/FAQ";
import About from "./pages/About";
import Blog from "./pages/Blog";
import Status from "./pages/Status";
import Contact from "./pages/Contact";
import Legal from "./pages/Legal";
import DocsPage from "./pages/DocsPage";
import NotFound from "./pages/NotFound";
import { useCopy } from "./i18n";

function Layout() {
  const { pathname } = useLocation();
  const c = useCopy({ en: "Skip to content", ru: "Перейти к содержимому" });
  return (
    <>
      <ScrollToTop />
      <a className="skip-link" href="#main">{c}</a>
      <Navbar />
      <main id="main">
        {/* Keyed wrapper re-runs the enter animation on every route change. */}
        <div key={pathname} className="page-enter">
          <Outlet />
        </div>
      </main>
      <Footer />
    </>
  );
}

export default function App() {
  return (
    <Routes>
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
