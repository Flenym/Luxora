import { lazy, Suspense, useEffect, useState } from "react";
import PhoneVisual from "./PhoneVisual";

const Hero3D = lazy(() => import("../Hero3D"));

/**
 * Loads the animated 3D hero only when it is appropriate: never with reduced
 * motion, and not on clearly low-power devices. Three.js lives in its own
 * lazy chunk, so the marketing bundle no longer ships it up front. The static
 * phone art renders first, keeping the hero free of layout shift.
 */
export default function HeroStage() {
  const [mode, setMode] = useState<"pending" | "three" | "static">("pending");

  useEffect(() => {
    const reduceMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
    const cores = navigator.hardwareConcurrency ?? 8;
    const memory = (navigator as Navigator & { deviceMemory?: number }).deviceMemory ?? 8;
    setMode(reduceMotion || cores <= 2 || memory <= 1 ? "static" : "three");
  }, []);

  if (mode === "static") return <PhoneVisual />;

  return (
    <Suspense fallback={<PhoneVisual />}>
      {mode === "three" ? <Hero3D /> : <PhoneVisual />}
    </Suspense>
  );
}
