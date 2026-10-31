import { useEffect } from "react";
import { useLocation } from "react-router-dom";

/** Resets scroll on route change, or scrolls to the hash target (e.g. /#features). */
export function ScrollToTop() {
  const { pathname, hash } = useLocation();

  useEffect(() => {
    if (hash) {
      const target = document.getElementById(hash.slice(1));
      if (target) {
        target.scrollIntoView({ behavior: "smooth" });
        return;
      }
    }
    window.scrollTo({ top: 0, behavior: "auto" });
  }, [pathname, hash]);

  return null;
}
