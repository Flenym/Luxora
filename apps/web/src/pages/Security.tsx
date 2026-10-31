import { KeyRound, LifeBuoy, SlidersHorizontal, UserCheck, type LucideIcon } from "lucide-react";
import { Container, PageHero, Reveal, Section, Tag, useMeta } from "../components/ui";
import { useCopy } from "../i18n";

const icons: LucideIcon[] = [UserCheck, KeyRound, SlidersHorizontal, LifeBuoy];

export default function Security() {
  const c = useCopy({
    en: {
      meta: ["Security & privacy — Luxora", "How Luxora approaches privacy, account protection and responsible data handling."],
      eyebrow: "Security",
      title: "Privacy matters.",
      lead: "Luxora is built around a simple rule: the interface never shows a security label it cannot back up.",
      pillars: [
        { title: "Account protection", text: "Your account is yours. Sign-in and recovery are designed to be clear and hard to abuse." },
        { title: "Session control", text: "See the devices signed in to your account and end any session you do not recognise." },
        { title: "You stay in control", text: "Choose what others can see and who can contact you. Options will expand before launch." },
        { title: "Responsible data handling", text: "Collect only what the product needs and explain it plainly." },
      ],
      statusTag: "Current status",
      statusTitle: "What is true today",
      s1: "Beta builds run in Cloud preview mode. The connection to the server is protected in transit, but the server can read message content. Do not use Beta builds for sensitive information.",
      s2: "End-to-end encryption is planned as a separate mode and will be enabled only after an independent security review. Until then, it is not available.",
      s3: "Security reports are welcome. Please contact us through the Contact page before publishing details.",
    },
    ru: {
      meta: ["Безопасность и приватность — Luxora", "Как Luxora подходит к приватности, защите аккаунта и ответственной работе с данными."],
      eyebrow: "Безопасность",
      title: "Приватность важна.",
      lead: "Luxora построен на простом правиле: интерфейс никогда не показывает метку безопасности, которую не может подтвердить.",
      pillars: [
        { title: "Защита аккаунта", text: "Аккаунт принадлежит вам. Вход и восстановление задуманы понятными и трудными для злоупотреблений." },
        { title: "Контроль сеансов", text: "Смотрите устройства, с которых выполнен вход, и завершайте любой незнакомый сеанс." },
        { title: "Контроль у вас", text: "Выбирайте, что видят другие и кто может с вами связаться. Возможности расширятся до запуска." },
        { title: "Ответственная работа с данными", text: "Собираем только то, что нужно продукту, и объясняем это простым языком." },
      ],
      statusTag: "Текущий статус",
      statusTitle: "Что верно сегодня",
      s1: "Бета-сборки работают в режиме Cloud preview. Соединение с сервером защищено при передаче, но сервер может читать содержимое сообщений. Не используйте бета-сборки для конфиденциальной информации.",
      s2: "Сквозное шифрование запланировано как отдельный режим и будет включено только после независимой проверки безопасности. До этого момента оно недоступно.",
      s3: "Сообщения о уязвимостях приветствуются. Пожалуйста, свяжитесь с нами через страницу «Контакты» до публикации подробностей.",
    },
  });
  useMeta(c.meta[0], c.meta[1]);

  return (
    <>
      <PageHero eyebrow={c.eyebrow} title={c.title} lead={c.lead} />
      <Section>
        <Container>
          <div className="pillar-grid">
            {c.pillars.map((p, i) => {
              const Icon = icons[i];
              return (
                <Reveal key={p.title} delay={i * 60}>
                  <article className="pillar">
                    <span className="icon-box"><Icon size={22} aria-hidden="true" /></span>
                    <h2>{p.title}</h2>
                    <p>{p.text}</p>
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
            <p className="muted">{c.s3}</p>
          </Reveal>
        </Container>
      </Section>
    </>
  );
}
