import { BookOpen, Code, Globe, Laptop, Monitor, Smartphone, Tablet, Terminal, type LucideIcon } from "lucide-react";
import { Link } from "react-router-dom";
import { Container, ExternalLink, GITHUB_REPO_URL, PageHero, Reveal, Section, Tag, useMeta } from "../components/ui";
import { useCopy } from "../i18n";

const icons: LucideIcon[] = [Monitor, Laptop, Terminal, Smartphone, Tablet, Globe];

export default function Download() {
  const c = useCopy({
    en: {
      meta: [
        "Download Luxora — build from source",
        "Luxora has no public installers yet. Run the web client from source today; native apps are in development and will be listed here when signed builds exist.",
      ],
      eyebrow: "Download",
      title: "Get Luxora.",
      lead: "There are no public installers yet. The only way to run Luxora today is to build the web client from source — it is a developer preview, not a signed release.",
      sourceTitle: "Run it from source",
      sourceText:
        "The web client lives in apps/web of the public repository. You need Node.js 22+ and a local Luxora API; nothing is uploaded or installed automatically.",
      step1: "Clone the public repository.",
      step2: "Install the pinned dependencies.",
      step3: "Start the Vite dev server and open http://127.0.0.1:4173.",
      repo: "Open the repository on GitHub",
      docs: "Read the installation docs",
      honesty:
        "This is a source build for developers. There is no signed installer, no auto-updater and no release channel for native apps yet — and we will not link to files that do not exist.",
      platformsTitle: "Platforms",
      platformsLead:
        "Windows, macOS, Linux, iOS and Android builds are in development. No signed artifact exists for any of them, so no download is offered here.",
      planned: "Not released",
      platformNote: "No installer yet.",
      docsLink: "Platform notes",
      platforms: [
        { name: "Windows", text: "Desktop app for Windows PCs." },
        { name: "macOS", text: "Desktop app for Mac." },
        { name: "Linux", text: "Desktop app for Linux distributions." },
        { name: "iOS", text: "App for iPhone and iPad." },
        { name: "Android", text: "App for Android phones and tablets." },
        { name: "Web", text: "The only client that runs today — from source." },
      ],
    },
    ru: {
      meta: [
        "Скачать Luxora — сборка из исходников",
        "Публичных установщиков Luxora пока нет. Веб-клиент можно собрать из исходников; нативные приложения в разработке и появятся здесь, когда будут подписанные сборки.",
      ],
      eyebrow: "Скачать",
      title: "Получите Luxora.",
      lead: "Публичных установщиков пока нет. Единственный способ запустить Luxora сегодня — собрать веб-клиент из исходников. Это сборка для разработчиков, а не подписанный релиз.",
      sourceTitle: "Запуск из исходников",
      sourceText:
        "Веб-клиент находится в apps/web публичного репозитория. Нужны Node.js 22+ и локальный API Luxora; ничего не загружается и не устанавливается автоматически.",
      step1: "Склонируйте публичный репозиторий.",
      step2: "Установите зафиксированные зависимости.",
      step3: "Запустите dev-сервер Vite и откройте http://127.0.0.1:4173.",
      repo: "Открыть репозиторий на GitHub",
      docs: "Документация по установке",
      honesty:
        "Это сборка для разработчиков. Подписанного установщика, автообновления и канала релизов нативных приложений пока нет — и мы не будем давать ссылки на файлы, которых не существует.",
      platformsTitle: "Платформы",
      platformsLead:
        "Сборки для Windows, macOS, Linux, iOS и Android в разработке. Подписанных артефактов нет ни для одной платформы, поэтому скачать их нельзя.",
      planned: "Не выпущено",
      platformNote: "Установщика пока нет.",
      docsLink: "Заметки о платформе",
      platforms: [
        { name: "Windows", text: "Десктопное приложение для ПК на Windows." },
        { name: "macOS", text: "Десктопное приложение для Mac." },
        { name: "Linux", text: "Десктопное приложение для дистрибутивов Linux." },
        { name: "iOS", text: "Приложение для iPhone и iPad." },
        { name: "Android", text: "Приложение для телефонов и планшетов на Android." },
        { name: "Web", text: "Единственный клиент, который работает сегодня — из исходников." },
      ],
    },
  });
  useMeta(c.meta[0], c.meta[1]);

  const platformPages = ["windows", "macos", "linux", "ios", "android", "web"];

  return (
    <>
      <PageHero eyebrow={c.eyebrow} title={c.title} lead={c.lead} />

      <Section>
        <Container>
          <div className="source-build">
            <div className="source-build-main">
              <h2 className="display section-gap">{c.sourceTitle}</h2>
              <p className="lead">{c.sourceText}</p>
              <ol className="step-list">
                <li>
                  <span>{c.step1}</span>
                  <ExternalLink href={GITHUB_REPO_URL} className="text-link">
                    {c.repo} ↗
                  </ExternalLink>
                </li>
                <li>
                  <span>{c.step2}</span>
                  <div className="code-block">
                    <div className="code-head"><span>bash</span></div>
                    <pre><code>{"npm --prefix apps/web ci"}</code></pre>
                  </div>
                </li>
                <li>
                  <span>{c.step3}</span>
                  <div className="code-block">
                    <div className="code-head"><span>bash</span></div>
                    <pre><code>{"npm --prefix apps/web run dev"}</code></pre>
                  </div>
                </li>
              </ol>
              <div className="cta-row">
                <ExternalLink href={GITHUB_REPO_URL} className="btn btn-primary btn-md">
                  <Code size={18} aria-hidden="true" />
                  {c.repo}
                </ExternalLink>
                <Link to="/docs/installation" className="btn btn-ghost btn-md">
                  <BookOpen size={18} aria-hidden="true" />
                  {c.docs}
                </Link>
              </div>
            </div>
            <aside className="source-build-aside" aria-label={c.sourceTitle}>
              <div className="notice-card">
                <h2>{c.platformsTitle}</h2>
                <p>{c.honesty}</p>
              </div>
            </aside>
          </div>
        </Container>
      </Section>

      <Section alt>
        <Container>
          <Reveal>
            <h2 className="display">{c.platformsTitle}</h2>
            <p className="lead">{c.platformsLead}</p>
          </Reveal>
          <div className="platform-grid">
            {c.platforms.map((platform, index) => {
              const Icon = icons[index];
              return (
                <Reveal key={platform.name} delay={index * 50}>
                  <article className="platform-card">
                    <div className="platform-head">
                      <span className="icon-box"><Icon size={22} aria-hidden="true" /></span>
                      <Tag tone="soon">{c.planned}</Tag>
                    </div>
                    <h3>{platform.name}</h3>
                    <p>{platform.text}</p>
                    <span className="muted platform-note">{c.platformNote}</span>
                    <Link to={`/docs/${platformPages[index]}`} className="text-link">
                      {c.docsLink} →
                    </Link>
                  </article>
                </Reveal>
              );
            })}
          </div>
        </Container>
      </Section>
    </>
  );
}
