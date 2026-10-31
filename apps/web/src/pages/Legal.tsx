import { Container, ExternalLink, GITHUB_ISSUES_URL, PageHero, Section, useMeta } from "../components/ui";
import { useCopy } from "../i18n";

type LegalSection = { heading: string; paragraphs: string[]; list?: string[] };
type LegalDoc = { title: string; summary: string; sections: LegalSection[] };

export default function Legal({ kind }: { kind: "privacy" | "terms" }) {
  const c = useCopy({
    en: {
      eyebrow: "Legal",
      draftTag: "Pre-launch draft · Beta-0.1",
      draftNote:
        "This is a pre-launch draft written for Beta-0.1. It describes the current, limited reality and will be replaced by a reviewed policy before any public launch.",
      contact: "Questions about this document can be raised in GitHub issues.",
      privacy: {
        title: "Privacy Policy",
        summary:
          "How the Luxora public website and Beta-0.1 builds handle data today. Luxora is in development and has no public production deployment yet.",
        sections: [
          {
            heading: "What this policy covers",
            paragraphs: [
              "This policy covers the public website and the Beta-0.1 builds of Luxora. It is not a final policy: no public production service or native app has been released yet, and this document will be replaced by a reviewed policy before that happens.",
            ],
          },
          {
            heading: "What the website collects",
            paragraphs: [
              "The public site is a static build. It does not set cookies, does not run analytics or advertising trackers, and does not ask you to create an account.",
              "Your language choice (English or Russian) is stored only in your browser's local storage under the key luxora-lang. It never leaves your device and can be cleared by clearing site data.",
              "When the site is served by a hosting provider, that provider may create standard request logs (IP address, user agent, timestamp, requested URL) for security and operations. Luxora does not add any tracking on top of those logs.",
            ],
          },
          {
            heading: "The web messenger preview at /app",
            paragraphs: [
              "The /app messenger is an early preview. In this development setup it connects to a local Luxora API and requires an account on that API; public sign-up is not open.",
              "Beta-0.1 runs in Cloud preview mode. Connections are protected in transit, but the server processes message plaintext and can read message content. Beta builds are not end-to-end encrypted and must not be used for sensitive information.",
              "Message content, account identifiers and session data handled by a Beta API deployment are processed by that deployment. The current security model, including what is and is not protected, is described in SECURITY.md in the public repository.",
            ],
          },
          {
            heading: "Third-party links",
            paragraphs: [
              "The site links to GitHub for source code, issue tracking and security documentation. Following those links leaves the Luxora site, and GitHub's own terms and privacy policy apply.",
            ],
          },
          {
            heading: "Data requests and contact",
            paragraphs: [
              "There is no email inbox or support desk for Luxora yet, so access or deletion requests cannot be processed through one. Issues in the public repository are the only real contact channel today; self-service account deletion is not part of the current public surface.",
            ],
          },
          {
            heading: "Changes to this policy",
            paragraphs: [
              "This draft will change as the product and its deployment model are built out. Before a public launch, a reviewed policy will be published and linked from the site footer.",
            ],
          },
        ],
      },
      terms: {
        title: "Terms of Service",
        summary:
          "Pre-launch terms for the Luxora website and Beta-0.1 builds. No public paid service, SLA or native app release exists yet.",
        sections: [
          {
            heading: "What Luxora is today",
            paragraphs: [
              "Luxora is an open project in active development. There is no publicly deployed production service, no released native app and no paid plan. The web messenger at /app is a preview of a Beta-0.1 build.",
            ],
          },
          {
            heading: "Beta software",
            paragraphs: [
              "Beta-0.1 builds are experimental and provided as-is, without warranties of any kind. Features may change, break or be removed, and there is no uptime commitment or service-level agreement.",
              "Beta builds run in Cloud preview mode and are not end-to-end encrypted. Do not use them for sensitive, confidential or regulated information.",
            ],
          },
          {
            heading: "Source code and license",
            paragraphs: [
              "The source code is published under the MIT license; the license text in the repository is authoritative. Third-party components keep their own licenses.",
              "The Luxora name and logo identify this project. The source license does not grant permission to present a modified build as the official Luxora product or to imply a security guarantee the project does not make.",
            ],
          },
          {
            heading: "Acceptable use",
            paragraphs: [
              "Do not use the project, the site or any beta deployment to break the law, to abuse other people, to attack or overload the service, or to misrepresent the security properties of your build.",
              "Do not test security controls against systems you do not own without permission. Report security concerns through the process described on the Security page.",
            ],
          },
          {
            heading: "No accounts or payments",
            paragraphs: [
              "Public registration is not open. Luxora does not currently sell subscriptions, take payments or operate a paid support channel, and this site does not ask you for payment details.",
            ],
          },
          {
            heading: "Third-party services",
            paragraphs: [
              "Links to GitHub and other third-party services are provided for convenience. Those services are governed by their own terms and privacy policies, not by these terms.",
            ],
          },
          {
            heading: "Changes to these terms",
            paragraphs: [
              "These pre-launch terms will change before any public release. The version published with the first public launch will replace this draft.",
            ],
          },
        ],
      },
    },
    ru: {
      eyebrow: "Правовая информация",
      draftTag: "Черновик до запуска · Beta-0.1",
      draftNote:
        "Это черновик, написанный для Beta-0.1. Он описывает текущую ограниченную реальность и будет заменён проверенным документом до публичного запуска.",
      contact: "Вопросы по документу можно задать в issues на GitHub.",
      privacy: {
        title: "Политика конфиденциальности",
        summary:
          "Как публичный сайт Luxora и сборки Beta-0.1 работают с данными сегодня. Luxora в разработке, публичного продакшен-развёртывания пока нет.",
        sections: [
          {
            heading: "Что покрывает эта политика",
            paragraphs: [
              "Политика покрывает публичный сайт и сборки Luxora Beta-0.1. Это не финальный документ: публичный продакшен-сервис и нативные приложения ещё не выпущены, и до этого момента политика будет заменена проверенной версией.",
            ],
          },
          {
            heading: "Какие данные собирает сайт",
            paragraphs: [
              "Публичный сайт — статическая сборка. Он не устанавливает cookies, не использует аналитику и рекламные трекеры и не просит создать аккаунт.",
              "Выбранный язык (английский или русский) хранится только в локальном хранилище браузера под ключом luxora-lang. Он не покидает устройство и удаляется вместе с данными сайта.",
              "Если сайт обслуживается хостинг-провайдером, провайдер может вести стандартные журналы запросов (IP-адрес, user agent, время, запрошенный URL) для безопасности и эксплуатации. Luxora не добавляет к этим журналам никакого трекинга.",
            ],
          },
          {
            heading: "Превью веб-мессенджера по адресу /app",
            paragraphs: [
              "Мессенджер /app — раннее превью. В текущей конфигурации разработки он подключается к локальному API Luxora и требует аккаунт в этом API; публичная регистрация не открыта.",
              "Beta-0.1 работает в режиме Cloud preview. Соединение защищено при передаче, но сервер обрабатывает сообщения в открытом виде и может читать их содержимое. Бета-сборки не используют сквозное шифрование, и их нельзя применять для конфиденциальной информации.",
              "Содержимое сообщений, идентификаторы аккаунта и данные сеансов, обрабатываемые развёртыванием Beta API, обрабатываются этим развёртыванием. Текущая модель безопасности, включая то, что защищено, а что нет, описана в SECURITY.md в публичном репозитории.",
            ],
          },
          {
            heading: "Сторонние ссылки",
            paragraphs: [
              "Сайт ссылается на GitHub для исходного кода, трекинга задач и документации по безопасности. Переходя по этим ссылкам, вы покидаете сайт Luxora, и применяются условия и политика GitHub.",
            ],
          },
          {
            heading: "Запросы данных и связь",
            paragraphs: [
              "У Luxora пока нет ни почтового ящика, ни службы поддержки, поэтому запросы доступа или удаления данных не могут быть обработаны через них. Issues в публичном репозитории — единственный реальный канал связи сегодня; самостоятельное удаление аккаунта не входит в текущую публичную поверхность продукта.",
            ],
          },
          {
            heading: "Изменения политики",
            paragraphs: [
              "Черновик будет меняться по мере развития продукта и модели развёртывания. До публичного запуска будет опубликована проверенная политика со ссылкой в подвале сайта.",
            ],
          },
        ],
      },
      terms: {
        title: "Условия использования",
        summary:
          "Условия до запуска для сайта Luxora и сборок Beta-0.1. Публичного платного сервиса, SLA и релиза нативных приложений пока нет.",
        sections: [
          {
            heading: "Что такое Luxora сегодня",
            paragraphs: [
              "Luxora — открытый проект в активной разработке. Публично развёрнутого продакшен-сервиса, выпущенных нативных приложений и платных планов нет. Веб-мессенджер по адресу /app — превью сборки Beta-0.1.",
            ],
          },
          {
            heading: "Бета-программное обеспечение",
            paragraphs: [
              "Сборки Beta-0.1 экспериментальны и предоставляются как есть, без каких-либо гарантий. Функции могут меняться, ломаться или удаляться; обязательств по аптайму и соглашения об уровне обслуживания нет.",
              "Бета-сборки работают в режиме Cloud preview и не используют сквозное шифрование. Не используйте их для конфиденциальной, секретной или регулируемой информации.",
            ],
          },
          {
            heading: "Исходный код и лицензия",
            paragraphs: [
              "Исходный код опубликован по лицензии MIT; определяющим является текст лицензии в репозитории. Сторонние компоненты сохраняют собственные лицензии.",
              "Название и логотип Luxora идентифицируют этот проект. Лицензия на исходный код не даёт права выдавать изменённую сборку за официальный продукт Luxora или заявлять о гарантиях безопасности, которых проект не даёт.",
            ],
          },
          {
            heading: "Допустимое использование",
            paragraphs: [
              "Не используйте проект, сайт и любые бета-развёртывания для нарушения закона, злоупотребления по отношению к другим людям, атак или перегрузки сервиса, а также для искажения свойств безопасности своей сборки.",
              "Не проверяйте средства защиты на системах, которыми не владеете, без разрешения. О проблемах безопасности сообщайте по процедуре со страницы «Безопасность».",
            ],
          },
          {
            heading: "Аккаунты и платежи",
            paragraphs: [
              "Публичная регистрация не открыта. Luxora сейчас не продаёт подписки, не принимает платежи и не ведёт платную поддержку, а сайт не запрашивает платёжные данные.",
            ],
          },
          {
            heading: "Сторонние сервисы",
            paragraphs: [
              "Ссылки на GitHub и другие сторонние сервисы даны для удобства. На эти сервисы распространяются их собственные условия и политики конфиденциальности, а не эти условия.",
            ],
          },
          {
            heading: "Изменения условий",
            paragraphs: [
              "Эти условия до запуска изменятся до любого публичного релиза. Версия, опубликованная вместе с первым публичным запуском, заменит этот черновик.",
            ],
          },
        ],
      },
    },
  });

  const doc: LegalDoc = c[kind];
  useMeta(`${doc.title} — Luxora`, doc.summary, { path: `/${kind}` });

  return (
    <>
      <PageHero eyebrow={c.eyebrow} title={doc.title} lead={doc.summary} />
      <Section>
        <Container className="narrow-text legal">
          <p className="legal-draft-tag">{c.draftTag}</p>
          <p className="legal-draft-note">{c.draftNote}</p>
          {doc.sections.map((section) => (
            <section key={section.heading} className="legal-section">
              <h2>{section.heading}</h2>
              {section.paragraphs.map((paragraph) => (
                <p key={paragraph}>{paragraph}</p>
              ))}
              {section.list && (
                <ul>
                  {section.list.map((item) => (
                    <li key={item}>{item}</li>
                  ))}
                </ul>
              )}
            </section>
          ))}
          <p className="muted legal-contact">
            {c.contact}{" "}
            <ExternalLink href={GITHUB_ISSUES_URL} className="text-link">GitHub issues ↗</ExternalLink>
          </p>
        </Container>
      </Section>
    </>
  );
}
