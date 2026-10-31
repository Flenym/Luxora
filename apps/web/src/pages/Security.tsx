import { KeyRound, LifeBuoy, SlidersHorizontal, UserCheck, type LucideIcon } from "lucide-react";
import { Container, ExternalLink, GITHUB_ISSUES_URL, GITHUB_REPO_URL, PageHero, Reveal, Section, Tag, useMeta } from "../components/ui";
import { useCopy } from "../i18n";

const icons: LucideIcon[] = [UserCheck, KeyRound, SlidersHorizontal, LifeBuoy];

export default function Security() {
  const c = useCopy({
    en: {
      meta: [
        "Security & privacy — Luxora",
        "Luxora Beta-0.1 runs in Cloud preview mode and is not end-to-end encrypted. Read exactly what is protected today and what is still planned.",
      ],
      eyebrow: "Security",
      title: "Privacy matters.",
      lead: "Luxora is built around a simple rule: the interface never shows a security label it cannot back up. Today that means an honest Cloud preview, not end-to-end encryption.",
      statusTag: "Current status",
      statusTitle: "What is true today",
      s1: "Beta builds run in Cloud preview mode. Connections are protected in transit, but the server processes message plaintext and can read message content. Do not use Beta builds for sensitive information.",
      s2: "End-to-end encryption is planned as a separate mode. It will be enabled only after an independent security review, and until then the app must not claim it.",
      s3: "Calls, multi-device encryption and anonymous accounts are not available. They are roadmap items, not hidden features.",
      s4: "The project publishes its security model openly in SECURITY.md in the repository, including the controls that exist and the evidence that is still missing.",
      pillars: [
        { title: "Account protection", text: "Sign-in and recovery are designed to be clear and hard to abuse. Public sign-up is not open yet.", status: "In development" },
        { title: "Session control", text: "Seeing the devices signed in to your account and ending a session is planned with the account surface.", status: "Planned" },
        { title: "You stay in control", text: "Choosing what others see and who can contact you will expand before public launch.", status: "Planned" },
        { title: "Responsible data handling", text: "Collect only what the product needs and explain it plainly. The pre-launch Privacy Policy describes the current limits.", status: "Now" },
      ],
      reportTag: "Reporting",
      reportTitle: "How to report a security issue",
      reportText:
        "Private security reporting is not configured yet. Please open a GitHub issue with no exploit details and ask for a private channel; do not publish reproduction steps for an unfixed problem. Non-sensitive questions can go to the same place.",
      reportIssues: "Open a GitHub issue",
      reportDoc: "Read SECURITY.md",
      reportDocHint: "(opens GitHub in a new tab)",
    },
    ru: {
      meta: [
        "Безопасность и приватность — Luxora",
        "Luxora Beta-0.1 работает в режиме Cloud preview и не использует сквозное шифрование. Узнайте, что защищено сегодня, а что пока запланировано.",
      ],
      eyebrow: "Безопасность",
      title: "Приватность важна.",
      lead: "Luxora построен на простом правиле: интерфейс никогда не показывает метку безопасности, которую не может подтвердить. Сегодня это честный Cloud preview, а не сквозное шифрование.",
      statusTag: "Текущий статус",
      statusTitle: "Что верно сегодня",
      s1: "Бета-сборки работают в режиме Cloud preview. Соединение защищено при передаче, но сервер обрабатывает сообщения в открытом виде и может читать их содержимое. Не используйте бета-сборки для конфиденциальной информации.",
      s2: "Сквозное шифрование запланировано как отдельный режим. Оно будет включено только после независимой проверки безопасности, а до этого приложение не должно заявлять о нём.",
      s3: "Звонки, шифрование на нескольких устройствах и анонимные аккаунты недоступны. Это пункты дорожной карты, а не скрытые функции.",
      s4: "Проект открыто публикует модель безопасности в SECURITY.md в репозитории: какие меры уже есть и каких доказательств ещё не хватает.",
      pillars: [
        { title: "Защита аккаунта", text: "Вход и восстановление задуманы понятными и трудными для злоупотреблений. Публичная регистрация пока не открыта.", status: "В разработке" },
        { title: "Контроль сеансов", text: "Просмотр устройств с выполненным входом и завершение сеанса запланированы вместе с аккаунтом.", status: "Запланировано" },
        { title: "Контроль у вас", text: "Выбор того, что видят другие и кто может связаться, расширится до публичного запуска.", status: "Запланировано" },
        { title: "Ответственная работа с данными", text: "Собираем только необходимое и объясняем это простым языком. Черновик политики конфиденциальности описывает текущие ограничения.", status: "Сейчас" },
      ],
      reportTag: "Сообщения об уязвимостях",
      reportTitle: "Как сообщить о проблеме безопасности",
      reportText:
        "Приватный канал для сообщений о безопасности пока не настроен. Откройте issue на GitHub без деталей эксплуатации и попросите приватный канал; не публикуйте шаги воспроизведения неисправленной проблемы. Обычные вопросы можно задать там же.",
      reportIssues: "Открыть issue на GitHub",
      reportDoc: "Прочитать SECURITY.md",
      reportDocHint: "(откроется GitHub в новой вкладке)",
    },
  });
  useMeta(c.meta[0], c.meta[1]);

  return (
    <>
      <PageHero eyebrow={c.eyebrow} title={c.title} lead={c.lead} />
      <Section>
        <Container>
          <div className="pillar-grid">
            {c.pillars.map((pillar, index) => {
              const Icon = icons[index];
              return (
                <Reveal key={pillar.title} delay={index * 60}>
                  <article className="pillar">
                    <span className="icon-box"><Icon size={22} aria-hidden="true" /></span>
                    <h2>{pillar.title}</h2>
                    <p>{pillar.text}</p>
                    <Tag tone={pillar.status === "Now" || pillar.status === "Сейчас" ? "live" : "soon"}>{pillar.status}</Tag>
                  </article>
                </Reveal>
              );
            })}
          </div>
        </Container>
      </Section>
      <Section alt>
        <Container className="narrow-text">
          <Reveal>
            <Tag tone="soon">{c.statusTag}</Tag>
            <h2 className="display section-gap">{c.statusTitle}</h2>
            <p>{c.s1}</p>
            <p>{c.s2}</p>
            <p>{c.s3}</p>
            <p className="muted">{c.s4}</p>
          </Reveal>
        </Container>
      </Section>
      <Section>
        <Container className="narrow-text">
          <Reveal>
            <h2 className="display">{c.reportTitle}</h2>
            <p>{c.reportText}</p>
            <div className="cta-row">
              <ExternalLink href={GITHUB_ISSUES_URL} className="btn btn-primary btn-md">
                {c.reportIssues} ↗
              </ExternalLink>
              <ExternalLink href={`${GITHUB_REPO_URL}/blob/main/SECURITY.md`} className="btn btn-ghost btn-md">
                {c.reportDoc}
                <span className="visually-hidden">{c.reportDocHint}</span>
              </ExternalLink>
            </div>
          </Reveal>
        </Container>
      </Section>
    </>
  );
}
