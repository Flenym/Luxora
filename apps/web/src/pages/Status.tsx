import { CheckCircle2 } from "lucide-react";
import { Container, PageHero, Reveal, Section, useMeta } from "../components/ui";
import { useCopy } from "../i18n";

export default function Status() {
  const c = useCopy({
    en: {
      meta: ["Status — Luxora", "Current status of Luxora services."],
      eyebrow: "Status",
      title: "Service status",
      lead: "Live monitoring is not connected yet. This page shows a static snapshot.",
      banner: "All systems operational",
      ok: "Operational",
      note: "Snapshot only. Real-time status will be shown here once monitoring is connected.",
      services: ["Messaging", "Authentication", "Media", "Notifications", "Web"],
    },
    ru: {
      meta: ["Статус — Luxora", "Текущее состояние сервисов Luxora."],
      eyebrow: "Статус",
      title: "Статус сервисов",
      lead: "Мониторинг в реальном времени пока не подключён. Страница показывает статичный снимок.",
      banner: "Все системы работают",
      ok: "В норме",
      note: "Только снимок. Статус в реальном времени появится здесь после подключения мониторинга.",
      services: ["Переписки", "Авторизация", "Медиа", "Уведомления", "Веб"],
    },
  });
  useMeta(c.meta[0], c.meta[1]);

  return (
    <>
      <PageHero eyebrow={c.eyebrow} title={c.title} lead={c.lead} />
      <Section>
        <Container className="narrow-text">
          <Reveal>
            <div className="status-banner">
              <CheckCircle2 size={22} aria-hidden="true" />
              <b>{c.banner}</b>
            </div>
            <ul className="status-list">
              {c.services.map((s) => (
                <li key={s}>
                  <span>{s}</span>
                  <span className="status-ok">{c.ok}</span>
                </li>
              ))}
            </ul>
            <p className="muted">{c.note}</p>
          </Reveal>
        </Container>
      </Section>
    </>
  );
}
