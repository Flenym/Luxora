import { Link } from "react-router-dom";
import { ExternalLink, GITHUB_REPO_URL, Container, PageHero, Reveal, Section, Tag, useMeta } from "../components/ui";
import { useCopy } from "../i18n";

type BuildNote = { title: string; text: string; link: string; to?: string; href?: string };

export default function Blog() {
  const c = useCopy({
    en: {
      meta: [
        "Updates & build notes — Luxora",
        "Honest build notes from the Luxora repository. There are no dated announcements yet: these notes describe what exists in Beta-0.1 and what is still planned.",
      ],
      eyebrow: "Updates",
      title: "Build notes",
      lead: "There are no published articles yet. These notes describe the current repository state honestly; they are not dated announcements or marketing.",
      note: "Build note",
      posts: [
        {
          title: "Beta-0.1: what exists today",
          text: "A tested server foundation for identity, text messaging, realtime sync and safety flows exists in the repository. The web messenger is a preview and native apps are not released.",
          to: "/docs/introduction",
          link: "Read the introduction",
        },
        {
          title: "Truth before polish",
          text: "Features that are planned are labelled as planned, and the interface is not allowed to show a receipt, a security state or a capability that the protocol cannot prove.",
          to: "/security",
          link: "How security is described",
        },
        {
          title: "Cloud preview is not end-to-end encryption",
          text: "Beta builds protect traffic in transit, but the server processes message plaintext. Private E2EE is a separately gated mode and will not ship before an independent review.",
          to: "/docs/privacy",
          link: "Read the privacy docs",
        },
        {
          title: "Server first, then iPhone",
          text: "The build order is deliberate: complete the server platform, then the full iPhone app, and only after that the remaining clients and a public launch.",
          to: "/status",
          link: "See the project status",
        },
        {
          title: "Run the web client from source",
          text: "There are no public installers yet. The only way to try Luxora today is to build the web client from the public repository and connect it to a local API.",
          to: "/download",
          link: "Build from source",
        },
        {
          title: "Work happens in public",
          text: "Code, roadmap and the security model are in the public repository. Issues are the only real contact channel until a support process exists.",
          href: `${GITHUB_REPO_URL}/issues`,
          link: "Open GitHub issues",
        },
      ] as BuildNote[],
      source: "The repository is the canonical source:",
      repo: "github.com/Flenym/Luxora",
    },
    ru: {
      meta: [
        "Обновления и заметки — Luxora",
        "Честные заметки о разработке Luxora. Датированных анонсов пока нет: здесь описано, что есть в Beta-0.1 и что пока запланировано.",
      ],
      eyebrow: "Обновления",
      title: "Заметки о разработке",
      lead: "Опубликованных статей пока нет. Эти заметки честно описывают текущее состояние репозитория; это не датированные анонсы и не маркетинг.",
      note: "Заметка",
      posts: [
        {
          title: "Beta-0.1: что уже есть",
          text: "В репозитории есть протестированная серверная основа для идентификации, текстовых сообщений, realtime-синхронизации и сценариев безопасности. Веб-мессенджер — превью, нативные приложения не выпущены.",
          to: "/docs/introduction",
          link: "Читать введение",
        },
        {
          title: "Честность важнее лоска",
          text: "Запланированные функции помечены как запланированные, а интерфейс не имеет права показывать статус доставки, состояние безопасности или возможность, которые протокол не может подтвердить.",
          to: "/security",
          link: "Как описана безопасность",
        },
        {
          title: "Cloud preview — это не сквозное шифрование",
          text: "Бета-сборки защищают трафик при передаче, но сервер обрабатывает сообщения в открытом виде. Private E2EE — отдельный режим с собственными условиями, он не выйдет до независимой проверки.",
          to: "/docs/privacy",
          link: "Документация о приватности",
        },
        {
          title: "Сначала сервер, потом iPhone",
          text: "Порядок работы намеренный: сначала завершить серверную платформу, затем полное приложение для iPhone и только после этого остальные клиенты и публичный запуск.",
          to: "/status",
          link: "Статус проекта",
        },
        {
          title: "Запуск веб-клиента из исходников",
          text: "Публичных установщиков пока нет. Единственный способ попробовать Luxora сегодня — собрать веб-клиент из публичного репозитория и подключить его к локальному API.",
          to: "/download",
          link: "Собрать из исходников",
        },
        {
          title: "Работа идёт открыто",
          text: "Код, дорожная карта и модель безопасности — в публичном репозитории. Issues остаются единственным реальным каналом связи, пока нет процесса поддержки.",
          href: `${GITHUB_REPO_URL}/issues`,
          link: "Открыть issues на GitHub",
        },
      ] as BuildNote[],
      source: "Канонический источник — репозиторий:",
      repo: "github.com/Flenym/Luxora",
    },
  });
  useMeta(c.meta[0], c.meta[1]);

  return (
    <>
      <PageHero eyebrow={c.eyebrow} title={c.title} lead={c.lead} />
      <Section>
        <Container>
          <div className="posts">
            {c.posts.map((post, index) => (
              <Reveal key={post.title} delay={index * 50}>
                <article className="post">
                  <div className="post-meta">
                    <Tag>{c.note}</Tag>
                  </div>
                  <h2>{post.title}</h2>
                  <p>{post.text}</p>
                  <p className="post-link">
                    {post.href ? (
                      <a href={post.href} target="_blank" rel="noopener noreferrer">
                        {post.link} ↗
                      </a>
                    ) : (
                      <Link to={post.to ?? "/docs"}>{post.link} →</Link>
                    )}
                  </p>
                </article>
              </Reveal>
            ))}
          </div>
          <Reveal>
            <p className="muted section-gap">
              {c.source}{" "}
              <ExternalLink href={GITHUB_REPO_URL} className="text-link">{c.repo} ↗</ExternalLink>
            </p>
          </Reveal>
        </Container>
      </Section>
    </>
  );
}
