import { useCopy } from "../i18n";

/**
 * Static, dependency-free stand-in for the animated Three.js hero. It is used
 * while the 3D chunk loads, when the visitor prefers reduced motion, on
 * low-power devices and when WebGL is unavailable. Purely decorative.
 */
export default function PhoneVisual() {
  const c = useCopy({
    en: {
      title: "Luxora",
      badge: "Beta-0.1",
      bubbles: ["Hello, this is Luxora", "Calm, fast, honest", "Only confirmed states"],
      input: "Write a message…",
    },
    ru: {
      title: "Luxora",
      badge: "Beta-0.1",
      bubbles: ["Привет, это Luxora", "Спокойно, быстро, честно", "Только подтверждённые статусы"],
      input: "Написать сообщение…",
    },
  });

  return (
    <div className="hero-3d phone-visual" aria-hidden="true">
      <div className="phone-frame">
        <div className="phone-screen">
          <div className="phone-head">
            <b>{c.title}</b>
            <small>{c.badge}</small>
          </div>
          <div className="phone-bubbles">
            <span className="phone-bubble in">{c.bubbles[0]}</span>
            <span className="phone-bubble out">{c.bubbles[1]}</span>
            <span className="phone-bubble in">{c.bubbles[2]}</span>
          </div>
          <div className="phone-input">{c.input}</div>
        </div>
      </div>
    </div>
  );
}
