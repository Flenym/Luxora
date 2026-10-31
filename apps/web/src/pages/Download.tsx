import { useState } from "react";
import { Globe, Laptop, Monitor, Smartphone, Tablet, Terminal, type LucideIcon } from "lucide-react";
import { ComingSoonDialog, Container, PageHero, Reveal, Section, Tag, useMeta } from "../components/ui";
import { useCopy } from "../i18n";

export default function Download() {
  const c = useCopy({
    en: {
      meta: ["Download Luxora", "Luxora is coming to Windows, macOS, Linux, iOS, Android and the web. Platform releases are in development."],
      eyebrow: "Download",
      title: "Get Luxora.",
      lead: "Luxora is in development. Apps for each platform will be announced here when they are ready.",
      soon: "Coming Soon",
      notify: "Notify me",
      platforms: [
        { name: "Windows", text: "Desktop app for Windows PCs." },
        { name: "macOS", text: "Desktop app for Mac." },
        { name: "Linux", text: "Desktop app for Linux distributions." },
        { name: "iOS", text: "App for iPhone and iPad." },
        { name: "Android", text: "App for Android phones and tablets." },
        { name: "Web", text: "Luxora in your browser." },
      ],
    },
    ru: {
      meta: ["Скачать Luxora", "Luxora скоро появится на Windows, macOS, Linux, iOS, Android и в вебе. Релизы для платформ в разработке."],
      eyebrow: "Скачать",
      title: "Получите Luxora.",
      lead: "Luxora в разработке. Приложения для каждой платформы будут анонсированы здесь, когда будут готовы.",
      soon: "Скоро",
      notify: "Сообщить мне",
      platforms: [
        { name: "Windows", text: "Десктопное приложение для ПК на Windows." },
        { name: "macOS", text: "Десктопное приложение для Mac." },
        { name: "Linux", text: "Десктопное приложение для дистрибутивов Linux." },
        { name: "iOS", text: "Приложение для iPhone и iPad." },
        { name: "Android", text: "Приложение для телефонов и планшетов на Android." },
        { name: "Web", text: "Luxora в браузере." },
      ],
    },
  });
  useMeta(c.meta[0], c.meta[1]);

  const icons: LucideIcon[] = [Monitor, Laptop, Terminal, Smartphone, Tablet, Globe];
  const [active, setActive] = useState<string | null>(null);

  return (
    <>
      <PageHero eyebrow={c.eyebrow} title={c.title} lead={c.lead} />
      <Section>
        <Container>
          <div className="platform-grid">
            {c.platforms.map((p, i) => {
              const Icon = icons[i];
              return (
                <Reveal key={p.name} delay={i * 60}>
                  <article className="platform-card">
                    <div className="platform-head">
                      <span className="icon-box"><Icon size={22} aria-hidden="true" /></span>
                      <Tag tone="soon">{c.soon}</Tag>
                    </div>
                    <h2>{p.name}</h2>
                    <p>{p.text}</p>
                    <button className="btn btn-ghost btn-md" onClick={() => setActive(p.name)}>
                      {c.notify}
                    </button>
                  </article>
                </Reveal>
              );
            })}
          </div>
        </Container>
      </Section>
      <ComingSoonDialog platform={active ?? ""} open={active !== null} onClose={() => setActive(null)} />
    </>
  );
}
