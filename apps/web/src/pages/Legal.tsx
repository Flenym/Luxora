import { Container, PageHero, Section, useMeta } from "../components/ui";
import { useCopy } from "../i18n";

export default function Legal({ kind }: { kind: "privacy" | "terms" }) {
  const c = useCopy({
    en: {
      privacy: { title: "Privacy Policy", text: "The Luxora Privacy Policy is currently being prepared and will be published before launch." },
      terms: { title: "Terms of Service", text: "The Luxora Terms of Service are currently being prepared and will be published before launch." },
      eyebrow: "Legal",
    },
    ru: {
      privacy: { title: "Политика конфиденциальности", text: "Политика конфиденциальности Luxora сейчас готовится и будет опубликована до запуска." },
      terms: { title: "Условия использования", text: "Условия использования Luxora сейчас готовятся и будут опубликованы до запуска." },
      eyebrow: "Правовая информация",
    },
  });
  const item = c[kind];
  useMeta(`${item.title} — Luxora`, item.text);
  return (
    <>
      <PageHero eyebrow={c.eyebrow} title={item.title} />
      <Section>
        <Container className="narrow-text">
          <p className="lead">{item.text}</p>
        </Container>
      </Section>
    </>
  );
}
