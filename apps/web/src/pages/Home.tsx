import { ArrowRight, BookOpen, Check, CheckCheck, Lock, Phone, Shield, Sparkles, Users, Video, Mic, Pin, Layers, Bell } from "lucide-react";
import { Link } from "react-router-dom";
import Hero3D from "../Hero3D";
import { ButtonLink, Container, Eyebrow, Reveal, Section, Tag, useMeta } from "../components/ui";
import { useCopy } from "../i18n";

const platforms = ["Windows", "macOS", "Linux", "iOS", "Android", "Web"];

export default function Home() {
  const c = useCopy({
    en: {
      metaTitle: "Luxora — A better way to communicate",
      metaDesc: "Luxora is a modern messenger designed for simple, fast and beautiful communication. Currently in development.",
      badge: "Beta-0.1 · In development",
      titleA: "A better way to",
      titleB: "communicate.",
      lead: "A modern messenger designed for simple, fast and beautiful communication. Built with privacy and clarity in mind.",
      download: "Download Luxora",
      explore: "Explore Luxora",
      platforms: "Windows · macOS · Linux · iOS · Android · Web",
      msgEyebrow: "Messaging",
      msgTitle: "Conversations, made simple.",
      msgLead: "Private and group chats in a calm, focused interface.",
      msgSub: "Private and group conversations",
      msgText: "Talk one-on-one or with a group. Replies, forwards, edits and pinned messages are planned for the first release.",
      planned: "Planned",
      replies: "Replies and forwards",
      edits: "Edit history",
      pins: "Pinned messages",
      allEyebrow: "Everything",
      allTitle: "Your world, in one place.",
      folders: "Folders and drafts",
      foldersText: "Organize chats into folders. Drafts are planned to stay in sync across your devices.",
      groups: "Groups",
      groupsText: "Communicate with many people in one place.",
      reactions: "Reactions",
      reactionsText: "React to messages and keep the conversation moving.",
      calls: "Voice & video",
      callsText: "Voice and video calls. Released only after a security review.",
      comingSoon: "Coming Soon",
      media: "Media and files",
      mediaText: "Share photos, videos and files. Resumable uploads are in development.",
      privEyebrow: "Privacy",
      privTitle: "Privacy matters.",
      privLead: "Privacy and security are core priorities of Luxora. The security model is explained openly, and the app never shows a security label it cannot back up.",
      privBtn: "Read about security",
      modeNowTag: "Now",
      modeLaterTag: "Later",
      modeNow: "Cloud preview",
      modeNowText: "Current Beta mode. The server can read message content.",
      modeE2E: "Private",
      modeE2EText: "End-to-end encryption, planned after independent review.",
      modeDelivery: "Honest delivery",
      modeDeliveryText: "Sent, delivered and read states come only from the protocol.",
      platEyebrow: "Platforms",
      platTitle: "Built for every device.",
      platLead: "Planned platforms. None of them are released yet.",
      ctaTitle: "Luxora is on its way.",
      ctaLead: "Read the docs, follow the updates, or get in touch.",
      docs: "Documentation",
      updates: "Updates",
      chatWelcome: "Welcome to Luxora.",
      chatOut: "Clean, fast and calm. Exactly what I wanted.",
      chatIn: "Statuses only show what the protocol confirms.",
      chatRead: "Sent · Delivered · Read",
      chatInput: "Write a message…",
      chatName: "Luxora team",
      chatOnline: "online",
    },
    ru: {
      metaTitle: "Luxora — Лучший способ общаться",
      metaDesc: "Luxora — современный мессенджер для простого, быстрого и красивого общения. Сейчас в разработке.",
      badge: "Beta-0.1 · В разработке",
      titleA: "Лучший способ",
      titleB: "общаться.",
      lead: "Современный мессенджер для простого, быстрого и красивого общения. Создан с вниманием к приватности и ясности.",
      download: "Скачать Luxora",
      explore: "Узнать больше",
      platforms: "Windows · macOS · Linux · iOS · Android · Web",
      msgEyebrow: "Переписки",
      msgTitle: "Общение без лишнего.",
      msgLead: "Личные чаты и группы в спокойном, сфокусированном интерфейсе.",
      msgSub: "Личные чаты и группы",
      msgText: "Общайтесь один на один или в группе. Ответы, пересылка, правки и закреплённые сообщения запланированы для первого релиза.",
      planned: "Запланировано",
      replies: "Ответы и пересылка",
      edits: "История правок",
      pins: "Закреплённые сообщения",
      allEyebrow: "Всё",
      allTitle: "Ваш мир в одном месте.",
      folders: "Папки и черновики",
      foldersText: "Раскладывайте чаты по папкам. Черновики запланированы к синхронизации между устройствами.",
      groups: "Группы",
      groupsText: "Общайтесь со многими людьми в одном месте.",
      reactions: "Реакции",
      reactionsText: "Реагируйте на сообщения и держите разговор живым.",
      calls: "Голос и видео",
      callsText: "Голосовые и видеозвонки. Выйдут только после проверки безопасности.",
      comingSoon: "Скоро",
      media: "Медиа и файлы",
      mediaText: "Отправляйте фото, видео и файлы. Загрузка с возобновлением в разработке.",
      privEyebrow: "Приватность",
      privTitle: "Приватность важна.",
      privLead: "Приватность и безопасность — ключевые приоритеты Luxora. Модель безопасности объясняется открыто, а приложение никогда не показывает метку безопасности, которую не может подтвердить.",
      privBtn: "Подробнее о безопасности",
      modeNowTag: "Сейчас",
      modeLaterTag: "Позже",
      modeNow: "Cloud preview",
      modeNowText: "Текущий режим беты. Сервер может читать содержимое сообщений.",
      modeE2E: "Private",
      modeE2EText: "Сквозное шифрование, запланировано после независимой проверки.",
      modeDelivery: "Честная доставка",
      modeDeliveryText: "Статусы «отправлено», «доставлено» и «прочитано» приходят только из протокола.",
      platEyebrow: "Платформы",
      platTitle: "Для любого устройства.",
      platLead: "Запланированные платформы. Ни одна пока не выпущена.",
      ctaTitle: "Luxora уже в пути.",
      ctaLead: "Читайте документацию, следите за обновлениями или свяжитесь с нами.",
      docs: "Документация",
      updates: "Обновления",
      chatWelcome: "Добро пожаловать в Luxora.",
      chatOut: "Чисто, быстро и спокойно. Именно то, что нужно.",
      chatIn: "Статусы показывают только то, что подтвердил протокол.",
      chatRead: "Отправлено · Доставлено · Прочитано",
      chatInput: "Написать сообщение…",
      chatName: "Команда Luxora",
      chatOnline: "в сети",
    },
  });

  useMeta(c.metaTitle, c.metaDesc);

  return (
    <>
      <section className="hero">
        <Container className="hero-grid">
          <Reveal className="hero-copy">
            <Tag tone="soon">{c.badge}</Tag>
            <h1 className="hero-title">
              {c.titleA} <span className="grad">{c.titleB}</span>
            </h1>
            <p className="lead">{c.lead}</p>
            <div className="cta-row">
              <ButtonLink to="/download" icon={<ArrowRight size={18} aria-hidden="true" />}>
                {c.download}
              </ButtonLink>
              <ButtonLink to="/about" variant="ghost">{c.explore}</ButtonLink>
            </div>
            <p className="platform-line">{c.platforms}</p>
          </Reveal>
          <Reveal delay={150} className="hero-visual">
            <Hero3D />
          </Reveal>
        </Container>
      </section>

      <Section id="features">
        <Container>
          <Reveal>
            <Eyebrow>{c.msgEyebrow}</Eyebrow>
            <h2 className="display">{c.msgTitle}</h2>
            <p className="lead">{c.msgLead}</p>
          </Reveal>
          <div className="showcase">
            <Reveal className="showcase-text">
              <h3>{c.msgSub}</h3>
              <p>{c.msgText}</p>
              <ul className="check-list">
                <li><Check size={16} aria-hidden="true" /> {c.replies} <Tag>{c.planned}</Tag></li>
                <li><Check size={16} aria-hidden="true" /> {c.edits} <Tag>{c.planned}</Tag></li>
                <li><Check size={16} aria-hidden="true" /> {c.pins} <Tag>{c.planned}</Tag></li>
              </ul>
            </Reveal>
            <Reveal delay={120} className="mock-card">
              <ChatMock c={c} />
            </Reveal>
          </div>
        </Container>
      </Section>

      <Section alt>
        <Container>
          <Reveal>
            <Eyebrow>{c.allEyebrow}</Eyebrow>
            <h2 className="display">{c.allTitle}</h2>
          </Reveal>
          <div className="bento">
            <Reveal className="bento-card span-2">
              <Layers size={22} aria-hidden="true" className="accent-icon" />
              <h3>{c.folders}</h3>
              <p>{c.foldersText}</p>
              <Tag>{c.planned}</Tag>
            </Reveal>
            <Reveal delay={80} className="bento-card">
              <Users size={22} aria-hidden="true" className="accent-icon" />
              <h3>{c.groups}</h3>
              <p>{c.groupsText}</p>
              <Tag>{c.planned}</Tag>
            </Reveal>
            <Reveal delay={160} className="bento-card">
              <Pin size={22} aria-hidden="true" className="accent-icon" />
              <h3>{c.reactions}</h3>
              <p>{c.reactionsText}</p>
              <Tag>{c.planned}</Tag>
            </Reveal>
            <Reveal delay={80} className="bento-card">
              <Phone size={22} aria-hidden="true" className="accent-icon" />
              <h3>{c.calls}</h3>
              <p>{c.callsText}</p>
              <Tag tone="soon">{c.comingSoon}</Tag>
            </Reveal>
            <Reveal delay={160} className="bento-card span-2">
              <Video size={22} aria-hidden="true" className="accent-icon" />
              <h3>{c.media}</h3>
              <p>{c.mediaText}</p>
              <Tag>{c.planned}</Tag>
            </Reveal>
          </div>
        </Container>
      </Section>

      <Section id="security">
        <Container className="split">
          <Reveal>
            <Eyebrow>{c.privEyebrow}</Eyebrow>
            <h2 className="display">{c.privTitle}</h2>
            <p className="lead">{c.privLead}</p>
            <ButtonLink to="/security" variant="ghost" icon={<Shield size={18} aria-hidden="true" />}>
              {c.privBtn}
            </ButtonLink>
          </Reveal>
          <Reveal delay={120}>
            <div className="mode-stack">
              <div className="mode-item">
                <Lock size={18} aria-hidden="true" />
                <div>
                  <b>{c.modeNow}</b>
                  <p>{c.modeNowText}</p>
                </div>
                <Tag tone="live">{c.modeNowTag}</Tag>
              </div>
              <div className="mode-item">
                <Sparkles size={18} aria-hidden="true" />
                <div>
                  <b>{c.modeE2E}</b>
                  <p>{c.modeE2EText}</p>
                </div>
                <Tag tone="soon">{c.modeLaterTag}</Tag>
              </div>
              <div className="mode-item">
                <CheckCheck size={18} aria-hidden="true" />
                <div>
                  <b>{c.modeDelivery}</b>
                  <p>{c.modeDeliveryText}</p>
                </div>
                <Tag tone="soon">{c.planned}</Tag>
              </div>
            </div>
          </Reveal>
        </Container>
      </Section>

      <Section alt>
        <Container>
          <Reveal>
            <Eyebrow>{c.platEyebrow}</Eyebrow>
            <h2 className="display">{c.platTitle}</h2>
            <p className="lead">{c.platLead}</p>
          </Reveal>
          <div className="platform-chips">
            {platforms.map((p, i) => (
              <Reveal key={p} delay={i * 60}>
                <Link to="/download" className="chip">
                  {p} <Tag tone="soon">{c.comingSoon}</Tag>
                </Link>
              </Reveal>
            ))}
          </div>
        </Container>
      </Section>

      <Section>
        <Container>
          <Reveal className="cta-panel">
            <Bell size={24} aria-hidden="true" className="accent-icon" />
            <h2 className="display">{c.ctaTitle}</h2>
            <p className="lead">{c.ctaLead}</p>
            <div className="cta-row center">
              <ButtonLink to="/docs" icon={<BookOpen size={18} aria-hidden="true" />}>{c.docs}</ButtonLink>
              <ButtonLink to="/blog" variant="ghost">{c.updates}</ButtonLink>
            </div>
          </Reveal>
        </Container>
      </Section>
    </>
  );
}

type HomeCopy = {
  chatWelcome: string;
  chatOut: string;
  chatIn: string;
  chatRead: string;
  chatInput: string;
  chatName: string;
  chatOnline: string;
};

function ChatMock({ c }: { c: HomeCopy }) {
  return (
    <div className="chat-mock" aria-hidden="true">
      <div className="chat-head">
        <span className="avatar">L</span>
        <div>
          <b>{c.chatName}</b>
          <small>{c.chatOnline}</small>
        </div>
        <Mic size={16} className="muted-icon" />
      </div>
      <div className="chat-body">
        <div className="bubble in">{c.chatWelcome}</div>
        <div className="bubble out">{c.chatOut}</div>
        <div className="bubble in">{c.chatIn}</div>
        <div className="bubble out">{c.chatRead}</div>
      </div>
      <div className="chat-input">{c.chatInput}</div>
    </div>
  );
}
