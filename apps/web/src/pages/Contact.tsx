import { useState, type FormEvent } from "react";
import { Check } from "lucide-react";
import { Container, PageHero, Section, useMeta } from "../components/ui";
import { useCopy } from "../i18n";

type Copy = ReturnType<typeof useContactCopy>;

function useContactCopy() {
  return useCopy({
    en: {
      meta: ["Contact — Luxora", "Get in touch with the Luxora team."],
      eyebrow: "Contact",
      title: "Say hello.",
      lead: "Questions, feedback or partnership ideas. Messages are not sent anywhere yet.",
      name: "Name",
      email: "Email",
      message: "Message",
      send: "Send message",
      thanksTitle: "Thanks for reaching out.",
      thanksText: "We have received your message.",
      errName: "Please enter your name.",
      errEmail: "Please enter a valid email.",
      errMessage: "Please write a message.",
    },
    ru: {
      meta: ["Контакты — Luxora", "Свяжитесь с командой Luxora."],
      eyebrow: "Контакты",
      title: "Напишите нам.",
      lead: "Вопросы, отзывы или идеи для партнёрства. Сообщения пока никуда не отправляются.",
      name: "Имя",
      email: "Email",
      message: "Сообщение",
      send: "Отправить",
      thanksTitle: "Спасибо, что написали.",
      thanksText: "Мы получили ваше сообщение.",
      errName: "Укажите имя.",
      errEmail: "Укажите корректный email.",
      errMessage: "Напишите сообщение.",
    },
  });
}

export default function Contact() {
  const c: Copy = useContactCopy();
  useMeta(c.meta[0], c.meta[1]);
  const [sent, setSent] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});

  const onSubmit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const data = new FormData(e.currentTarget);
    const next: Record<string, string> = {};
    if (!String(data.get("name") ?? "").trim()) next.name = c.errName;
    const email = String(data.get("email") ?? "").trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) next.email = c.errEmail;
    if (!String(data.get("message") ?? "").trim()) next.message = c.errMessage;
    setErrors(next);
    if (Object.keys(next).length === 0) setSent(true);
  };

  return (
    <>
      <PageHero eyebrow={c.eyebrow} title={c.title} lead={c.lead} />
      <Section>
        <Container className="narrow-text">
          {sent ? (
            <div className="thanks" role="status">
              <span className="icon-box"><Check size={22} aria-hidden="true" /></span>
              <h2>{c.thanksTitle}</h2>
              <p>{c.thanksText}</p>
            </div>
          ) : (
            <form className="form" onSubmit={onSubmit} noValidate>
              <Field id="name" label={c.name} error={errors.name} />
              <Field id="email" label={c.email} type="email" error={errors.email} />
              <Field id="message" label={c.message} multiline error={errors.message} />
              <button type="submit" className="btn btn-primary btn-md">{c.send}</button>
            </form>
          )}
        </Container>
      </Section>
    </>
  );
}

function Field({ id, label, type = "text", multiline = false, error }: { id: string; label: string; type?: string; multiline?: boolean; error?: string }) {
  const common = {
    id,
    name: id,
    "aria-invalid": !!error,
    "aria-describedby": error ? `${id}-error` : undefined,
    className: "input",
  };
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      {multiline ? <textarea rows={6} {...common} /> : <input type={type} {...common} />}
      {error && <small id={`${id}-error`} className="field-error">{error}</small>}
    </div>
  );
}
