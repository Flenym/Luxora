import { Info } from "lucide-react";
import { Container, PageHero, Reveal, Section, Tag, useMeta } from "../components/ui";
import { useCopy } from "../i18n";

type StatusRow = { name: string; state: string; stateNote: string };

export default function Status() {
  const c = useCopy({
    en: {
      meta: [
        "Project status — Luxora",
        "Static snapshot of what exists in the Luxora repository. There is no public deployment yet, so no live uptime or SLA is published.",
      ],
      eyebrow: "Status",
      title: "Project status",
      lead: "There is no public production deployment yet, so there is no uptime, incident history or SLA to report. This page is a static snapshot of the repository, not live monitoring.",
      banner: "Static snapshot · Beta-0.1 · not a live status page",
      bannerNote:
        "No monitoring is connected. When a public deployment exists, a real status page with measured uptime will replace this snapshot.",
      rows: [
        { name: "Public web site", state: "Static build", stateNote: "Local dev server only; no production hosting yet." },
        { name: "Web messenger (/app)", state: "Preview", stateNote: "Connected to a local API; not a public deployment." },
        { name: "Luxora API", state: "Local stack", stateNote: "Runs locally from source; production platform not deployed." },
        { name: "iPhone app", state: "In development", stateNote: "Thin integration harness; no public release." },
        { name: "Android / macOS / Windows / Linux", state: "Planned", stateNote: "Native clients are not started." },
        { name: "Monitoring, on-call, backups", state: "Not connected", stateNote: "Required before any uptime claim can be made." },
      ] as StatusRow[],
      liveNote:
        "This page intentionally does not show uptime percentages, green checkmarks or SLAs. Those numbers do not exist yet, and inventing them would break the project's truth rule.",
      metaLabel: "Release",
      metaValue: "Beta-0.1 · In development",
    },
    ru: {
      meta: [
        "Статус проекта — Luxora",
        "Статичный снимок того, что есть в репозитории Luxora. Публичного развёртывания пока нет, поэтому живой аптайм и SLA не публикуются.",
      ],
      eyebrow: "Статус",
      title: "Статус проекта",
      lead: "Публичного продакшен-развёртывания пока нет, поэтому нет ни аптайма, ни истории инцидентов, ни SLA. Эта страница — статичный снимок репозитория, а не живой мониторинг.",
      banner: "Статичный снимок · Beta-0.1 · не живая страница статуса",
      bannerNote:
        "Мониторинг не подключён. Когда появится публичное развёртывание, этот снимок заменит настоящая страница статуса с измеренным аптаймом.",
      rows: [
        { name: "Публичный сайт", state: "Статичная сборка", stateNote: "Только локальный dev-сервер; продакшен-хостинга пока нет." },
        { name: "Веб-мессенджер (/app)", state: "Превью", stateNote: "Работает с локальным API; это не публичное развёртывание." },
        { name: "API Luxora", state: "Локальный стек", stateNote: "Запускается локально из исходников; продакшен-платформа не развёрнута." },
        { name: "Приложение iPhone", state: "В разработке", stateNote: "Тонкий интеграционный стенд; публичного релиза нет." },
        { name: "Android / macOS / Windows / Linux", state: "Запланировано", stateNote: "Нативные клиенты не начаты." },
        { name: "Мониторинг, дежурства, бэкапы", state: "Не подключено", stateNote: "Нужны до любого заявления об аптайме." },
      ] as StatusRow[],
      liveNote:
        "Эта страница намеренно не показывает проценты аптайма, зелёные галочки и SLA. Этих цифр ещё не существует, а их выдумывание нарушает правило честности проекта.",
      metaLabel: "Релиз",
      metaValue: "Beta-0.1 · В разработке",
    },
  });
  useMeta(c.meta[0], c.meta[1]);

  return (
    <>
      <PageHero eyebrow={c.eyebrow} title={c.title} lead={c.lead} />
      <Section>
        <Container className="narrow-text">
          <Reveal>
            <div className="status-banner is-static">
              <Info size={22} aria-hidden="true" />
              <b>{c.banner}</b>
            </div>
            <dl className="status-list">
              {c.rows.map((row) => (
                <div key={row.name} className="status-row">
                  <dt>
                    {row.name}
                    <small>{row.stateNote}</small>
                  </dt>
                  <dd>
                    <Tag tone="soon">{row.state}</Tag>
                  </dd>
                </div>
              ))}
              <div className="status-row">
                <dt>{c.metaLabel}</dt>
                <dd><Tag>{c.metaValue}</Tag></dd>
              </div>
            </dl>
            <p className="muted">{c.bannerNote}</p>
            <p className="muted">{c.liveNote}</p>
          </Reveal>
        </Container>
      </Section>
    </>
  );
}
