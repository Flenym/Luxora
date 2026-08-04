import {
  FormEvent,
  KeyboardEvent,
  ReactNode,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

type Theme = "dark" | "light";
type AppView = "landing" | "messenger";
type IconName =
  | "archive"
  | "arrow"
  | "back"
  | "bell"
  | "bookmark"
  | "call"
  | "camera"
  | "check"
  | "chevron"
  | "close"
  | "download"
  | "edit"
  | "file"
  | "globe"
  | "grid"
  | "headphones"
  | "info"
  | "link"
  | "lock"
  | "menu"
  | "message"
  | "mic"
  | "moon"
  | "more"
  | "paperclip"
  | "people"
  | "pin"
  | "play"
  | "plus"
  | "search"
  | "send"
  | "settings"
  | "shield"
  | "smile"
  | "sparkles"
  | "sun"
  | "user"
  | "video";

function Icon({ name, size = 20 }: { name: IconName; size?: number }) {
  const paths: Record<IconName, ReactNode> = {
    archive: <><path d="M4 7.5h16v12H4z"/><path d="M3 4.5h18v3H3zM9 11.5h6"/></>,
    arrow: <><path d="M5 12h14M14 7l5 5-5 5"/></>,
    back: <><path d="m15 18-6-6 6-6"/></>,
    bell: <><path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9Z"/><path d="M10 21h4"/></>,
    bookmark: <path d="M6 4.5A1.5 1.5 0 0 1 7.5 3h9A1.5 1.5 0 0 1 18 4.5V21l-6-4-6 4Z"/>,
    call: <path d="M7 3H4.5A1.5 1.5 0 0 0 3 4.5C3 13.6 10.4 21 19.5 21a1.5 1.5 0 0 0 1.5-1.5V17l-4-1-1.3 2.2a16 16 0 0 1-9.9-9.9L8 7Z"/>,
    camera: <><path d="M14.5 6 13 4h-2L9.5 6H5a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2Z"/><circle cx="12" cy="13" r="4"/></>,
    check: <path d="m5 12 4 4L19 6"/>,
    chevron: <path d="m9 18 6-6-6-6"/>,
    close: <><path d="m6 6 12 12M18 6 6 18"/></>,
    download: <><path d="M12 3v12m-5-5 5 5 5-5M4 20h16"/></>,
    edit: <><path d="M12 20h9"/><path d="m16.5 3.5 4 4L8 20H4v-4Z"/></>,
    file: <><path d="M6 3h8l4 4v14H6z"/><path d="M14 3v5h5M9 13h6M9 17h4"/></>,
    globe: <><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/></>,
    grid: <><rect x="3" y="3" width="7" height="7" rx="2"/><rect x="14" y="3" width="7" height="7" rx="2"/><rect x="3" y="14" width="7" height="7" rx="2"/><rect x="14" y="14" width="7" height="7" rx="2"/></>,
    headphones: <><path d="M4 15v-3a8 8 0 0 1 16 0v3"/><path d="M4 15h3v6H5a1 1 0 0 1-1-1Zm16 0h-3v6h2a1 1 0 0 0 1-1Z"/></>,
    info: <><circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7h.01"/></>,
    link: <><path d="m10 13 4-4"/><path d="M7.5 16.5 5 19a3.5 3.5 0 0 1-5-5l3-3a3.5 3.5 0 0 1 5 0" transform="translate(2 -1)"/><path d="m14.5 7.5 2.5-2.5a3.5 3.5 0 0 1 5 5l-3 3a3.5 3.5 0 0 1-5 0" transform="translate(-2 1)"/></>,
    lock: <><rect x="4" y="10" width="16" height="11" rx="3"/><path d="M8 10V7a4 4 0 0 1 8 0v3M12 14v3"/></>,
    menu: <><path d="M4 7h16M4 12h16M4 17h16"/></>,
    message: <path d="M21 12a8 8 0 0 1-8 8H5l-3 2 1-5a9 9 0 1 1 18-5Z"/>,
    mic: <><rect x="9" y="3" width="6" height="12" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3M9 21h6"/></>,
    moon: <path d="M20 15.5A8.5 8.5 0 0 1 8.5 4 8.5 8.5 0 1 0 20 15.5Z"/>,
    more: <><circle cx="5" cy="12" r="1" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1" fill="currentColor" stroke="none"/><circle cx="19" cy="12" r="1" fill="currentColor" stroke="none"/></>,
    paperclip: <path d="m20.5 11.5-8.8 8.8a6 6 0 0 1-8.5-8.5l9.2-9.2a4 4 0 0 1 5.7 5.7l-9.2 9.2a2 2 0 0 1-2.8-2.8l8.5-8.5"/>,
    people: <><circle cx="9" cy="8" r="4"/><path d="M2 21v-2a7 7 0 0 1 14 0v2M16 4a4 4 0 0 1 0 8M18 15a6 6 0 0 1 4 6"/></>,
    pin: <><path d="m14 4 6 6-3 2-4 4-1 5-2-5-4-4 4-4Z"/><path d="m3 21 7-7"/></>,
    play: <path d="m9 6 9 6-9 6Z" fill="currentColor"/>,
    plus: <><path d="M12 5v14M5 12h14"/></>,
    search: <><circle cx="11" cy="11" r="7"/><path d="m20 20-4-4"/></>,
    send: <><path d="m22 2-8 20-4-8-8-4Z"/><path d="M22 2 10 14"/></>,
    settings: <><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1-2.8 2.8-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.6v.2h-4V21a1.7 1.7 0 0 0-1-1.6 1.7 1.7 0 0 0-1.9.3l-.1.1L4.2 17l.1-.1a1.7 1.7 0 0 0 .3-1.9A1.7 1.7 0 0 0 3 14H2.8v-4H3a1.7 1.7 0 0 0 1.6-1 1.7 1.7 0 0 0-.3-1.9L4.2 7 7 4.2l.1.1a1.7 1.7 0 0 0 1.9.3A1.7 1.7 0 0 0 10 3V2.8h4V3a1.7 1.7 0 0 0 1 1.6 1.7 1.7 0 0 0 1.9-.3l.1-.1L19.8 7l-.1.1a1.7 1.7 0 0 0-.3 1.9 1.7 1.7 0 0 0 1.6 1h.2v4H21a1.7 1.7 0 0 0-1.6 1Z"/></>,
    shield: <><path d="M12 2 20 5v6c0 5-3.4 9-8 11-4.6-2-8-6-8-11V5Z"/><path d="m8.5 12 2.2 2.2 4.8-5"/></>,
    smile: <><circle cx="12" cy="12" r="9"/><path d="M8 14s1.5 2 4 2 4-2 4-2M9 9h.01M15 9h.01"/></>,
    sparkles: <><path d="m12 3 1.2 3.8L17 8l-3.8 1.2L12 13l-1.2-3.8L7 8l3.8-1.2ZM19 14l.7 2.3L22 17l-2.3.7L19 20l-.7-2.3L16 17l2.3-.7ZM5 13l.8 2.2L8 16l-2.2.8L5 19l-.8-2.2L2 16l2.2-.8Z"/></>,
    sun: <><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></>,
    user: <><circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/></>,
    video: <><rect x="3" y="6" width="13" height="12" rx="3"/><path d="m16 10 5-3v10l-5-3Z"/></>,
  };

  return (
    <svg className="icon" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {paths[name]}
    </svg>
  );
}

function Logo({ compact = false }: { compact?: boolean }) {
  return (
    <span className={`brand ${compact ? "brand--compact" : ""}`}>
      <span className="brand__mark"><img src="/logo.png" alt="" /></span>
      {!compact && <span className="brand__word">Luxora</span>}
    </span>
  );
}

function useTheme() {
  const [theme, setTheme] = useState<Theme>(() => {
    const saved = localStorage.getItem("luxora-theme") as Theme | null;
    if (saved === "dark" || saved === "light") return saved;
    return window.matchMedia?.("(prefers-color-scheme: light)").matches ? "light" : "dark";
  });

  useEffect(() => {
    localStorage.setItem("luxora-theme", theme);
    document.querySelector('meta[name="theme-color"]')?.setAttribute("content", theme === "dark" ? "#07070b" : "#f2f2f7");
  }, [theme]);

  return [theme, () => setTheme((current) => current === "dark" ? "light" : "dark")] as const;
}

const featureCards = [
  {
    icon: "message" as IconName,
    index: "01",
    title: "Разговоры без шума",
    text: "В Beta-0.1 локально работают список чатов, фильтры, поиск и отправка в состояние вкладки. Каналы и пространства — следующий этап.",
    className: "feature-card--wide feature-card--inbox",
  },
  {
    icon: "video" as IconName,
    index: "02",
    title: "Звонки без лишних панелей",
    text: "Следующие этапы roadmap: пространственный звук, шумоподавление и демонстрация экрана. Сейчас показан только UX-концепт.",
    className: "feature-card--call",
  },
  {
    icon: "file" as IconName,
    index: "03",
    title: "Файлы — локальный сценарий",
    text: "Сейчас можно выбрать файл и увидеть его в переписке, без загрузки в сеть. Storage, предпросмотр и поиск по содержимому — roadmap.",
    className: "feature-card--files",
  },
  {
    icon: "sparkles" as IconName,
    index: "04",
    title: "Luxora Sense",
    text: "UX-концепт будущих локальных сводок, расшифровки голоса и перевода. AI-функции в Beta-0.1 не подключены.",
    className: "feature-card--sense",
  },
  {
    icon: "globe" as IconName,
    index: "05",
    title: "Один ритм на всех экранах",
    text: "Целевой multi-device сценарий: начать сообщение на телефоне и продолжить на компьютере. В Beta-0.1 синхронизация с сервером ещё не подключена.",
    className: "feature-card--wide feature-card--sync",
  },
];

const faqs = [
  ["Luxora уже доступна?", "Да, Beta-0.1 доступна как локальный интерактивный web-срез. Нативные клиенты, единый аккаунт и серверная синхронизация находятся в roadmap."],
  ["Как защищены сообщения сейчас?", "Beta-0.1 не отправляет демо-переписку на сервер: данные живут только в состоянии вкладки. Для сетевого контура предусмотрены TLS и аутентификация; per-device E2EE появится только после реализации и независимого аудита."],
  ["Можно перенести историю из другого мессенджера?", "Пока нет. Мастер локального импорта запланирован после подключения постоянного хранилища; Beta-0.1 показывает целевой UX этого сценария."],
  ["Есть ли лимит на размер файлов?", "В Beta-0.1 файл только добавляется в локальное состояние демо и никуда не загружается. Серверные лимиты будут опубликованы вместе с production storage."],
  ["Можно использовать Luxora в компании?", "Пока только для оценки интерфейса. Роли, темы, гостевые ссылки и управляемое хранение остаются частью продуктового roadmap."],
];

const blogPosts = [
  { tag: "Продукт", date: "28 июля", title: "Почему мессенджеру иногда лучше промолчать", text: "Про спокойные уведомления, фокус и новую этику внимания." },
  { tag: "Инженерия", date: "14 июля", title: "Как мы проектируем будущую доставку", text: "Целевой realtime-контур и ограничения, которые ещё предстоит проверить нагрузкой." },
  { tag: "Дизайн", date: "02 июля", title: "Живое стекло: интерфейс как естественная среда", text: "Как свет, материал и движение помогают понимать контекст." },
];

function ThemeButton({ theme, toggle }: { theme: Theme; toggle: () => void }) {
  return (
    <button className="icon-button" type="button" onClick={toggle} aria-label={theme === "dark" ? "Включить светлую тему" : "Включить тёмную тему"}>
      <Icon name={theme === "dark" ? "sun" : "moon"} size={18} />
    </button>
  );
}

function Landing({ theme, toggleTheme, openMessenger }: { theme: Theme; toggleTheme: () => void; openMessenger: () => void }) {
  const [menuOpen, setMenuOpen] = useState(false);

  const closeMenu = () => setMenuOpen(false);
  return (
    <div className="landing">
      <a className="skip-link" href="#main-content">К содержанию</a>
      <header className="site-header">
        <div className="site-header__inner shell glass-panel">
          <a href="#home" aria-label="Luxora, на главную" onClick={closeMenu}><Logo /></a>
          <nav className={`site-nav ${menuOpen ? "site-nav--open" : ""}`} aria-label="Основная навигация">
            <a href="#features" onClick={closeMenu}>Возможности</a>
            <a href="#security" onClick={closeMenu}>Безопасность</a>
            <a href="#download" onClick={closeMenu}>Клиенты</a>
            <a href="#resources" onClick={closeMenu}>Ресурсы</a>
          </nav>
          <div className="site-header__actions">
            <ThemeButton theme={theme} toggle={toggleTheme} />
            <button className="button button--small button--glass header-open" type="button" onClick={openMessenger}>Открыть Web</button>
            <button className="icon-button menu-button" type="button" onClick={() => setMenuOpen((value) => !value)} aria-expanded={menuOpen} aria-label="Открыть меню">
              <Icon name={menuOpen ? "close" : "menu"} />
            </button>
          </div>
        </div>
      </header>

      <main id="main-content">
        <section className="hero section" id="home">
          <div className="hero__aurora" aria-hidden="true"><span /><span /><span /></div>
          <div className="shell hero__layout">
            <div className="hero__copy reveal">
              <div className="eyebrow"><span className="eyebrow__pulse" /> Luxora Web · Beta-0.1</div>
              <h1>Ближе к важному.<br /><span>Дальше от шума.</span></h1>
              <p className="hero__lead">Локальный интерактивный срез будущего приватного мессенджера. Beta-0.1 демонстрирует чаты, темы и работу с файлами без серверной отправки.</p>
              <div className="hero__actions">
                <button className="button button--primary" type="button" onClick={openMessenger}>Открыть Luxora <Icon name="arrow" size={18} /></button>
                <a className="button button--ghost" href="#download">Планы приложений <Icon name="arrow" size={18} /></a>
              </div>
              <div className="hero__trust">
                <div className="avatar-stack" aria-hidden="true"><span>AK</span><span>MR</span><span>SV</span><span>+</span></div>
                <p><strong>Beta-0.1</strong><br />локальный интерфейсный срез</p>
              </div>
            </div>

            <div className="hero-product" aria-label="Предпросмотр интерфейса Luxora">
              <div className="hero-product__halo" aria-hidden="true" />
              <div className="hero-window glass-panel">
                <div className="hero-window__top">
                  <div className="window-dots" aria-hidden="true"><i /><i /><i /></div>
                  <span>Luxora</span>
                  <div className="hero-window__secure"><Icon name="lock" size={12} /> локальное демо</div>
                </div>
                <div className="hero-window__body">
                  <aside className="preview-sidebar">
                    <div className="preview-sidebar__head"><span className="mini-avatar mini-avatar--me">VV</span><span className="preview-search"><Icon name="search" size={13} /> Поиск</span></div>
                    <div className="preview-chat preview-chat--active"><span className="mini-avatar mini-avatar--gradient">AM</span><span><strong>Амелия</strong><small>Да, выглядит волшебно ✦</small></span><time>сейчас</time></div>
                    <div className="preview-chat"><span className="mini-avatar mini-avatar--team"><Icon name="people" size={14} /></span><span><strong>Product room</strong><small>Марк: отправил файл</small></span><time>12:42</time></div>
                    <div className="preview-chat"><span className="mini-avatar mini-avatar--photo">И</span><span><strong>Илья</strong><small>Запишем созвон?</small></span><time>вчера</time></div>
                    <div className="preview-chat"><span className="mini-avatar mini-avatar--violet">L</span><span><strong>Luxora Design</strong><small>4 новых сообщения</small></span><time>пн</time></div>
                  </aside>
                  <div className="preview-conversation">
                    <div className="preview-conversation__head">
                      <span className="mini-avatar mini-avatar--gradient">AM</span><span><strong>Амелия Рэй</strong><small><i /> в сети</small></span><span className="preview-call"><Icon name="call" size={15} /></span>
                    </div>
                    <div className="preview-messages">
                      <div className="date-chip">Сегодня</div>
                      <div className="preview-bubble preview-bubble--in">Доброе утро! Как тебе новая идея?<time>10:24</time></div>
                      <div className="preview-file"><span><Icon name="file" /></span><div><strong>Luxora concept.pdf</strong><small>8,4 МБ · PDF</small></div><Icon name="download" size={16} /></div>
                      <div className="preview-bubble preview-bubble--out">Очень чисто. Оставим больше воздуха и света.<time>10:26 <Icon name="check" size={10} /></time></div>
                      <div className="typing" aria-label="Амелия печатает"><i /><i /><i /></div>
                    </div>
                    <div className="preview-compose"><Icon name="plus" size={16} /><span>Сообщение</span><Icon name="mic" size={16} /></div>
                  </div>
                </div>
              </div>
              <div className="floating-note floating-note--secure glass-panel"><span><Icon name="shield" size={17} /></span><p><strong>Данные остаются локально</strong><small>В рамках текущей вкладки</small></p><Icon name="check" size={16} /></div>
              <div className="floating-note floating-note--sync glass-panel"><span><Icon name="sparkles" size={17} /></span><p><strong>Multi-device</strong><small>Целевой сценарий · roadmap</small></p></div>
            </div>
          </div>
          <a className="scroll-cue" href="#features"><span>Узнать больше</span><i /></a>
        </section>

        <section className="signal-strip" aria-label="Ключевые преимущества">
          <div className="shell signal-strip__inner">
            <div><strong>0 Б</strong><span>демо-чат не покидает вкладку</span></div>
            <div><strong>Local</strong><span>выбранные файлы не загружаются</span></div>
            <div><strong>2</strong><span>темы интерфейса</span></div>
            <div><strong>Roadmap</strong><span>синхронизация и звонки</span></div>
          </div>
        </section>

        <section className="section feature-section" id="features">
          <div className="shell">
            <div className="section-heading section-heading--center">
              <div className="kicker">Beta-0.1 + roadmap</div>
              <h2>Всё, что нужно для разговора.<br /><span>И ничего лишнего.</span></h2>
              <p>Luxora убирает препятствия между мыслью и человеком, которому она адресована.</p>
            </div>
            <div className="feature-grid">
              {featureCards.map((feature) => (
                <article className={`feature-card glass-panel ${feature.className}`} key={feature.index}>
                  <div className="feature-card__top"><span className="feature-card__icon"><Icon name={feature.icon} /></span><span>{feature.index}</span></div>
                  {feature.className.includes("inbox") && <InboxVisual />}
                  {feature.className.includes("call") && <CallVisual />}
                  {feature.className.includes("files") && <FileVisual />}
                  {feature.className.includes("sense") && <SenseVisual />}
                  {feature.className.includes("sync") && <SyncVisual />}
                  <div className="feature-card__copy"><h3>{feature.title}</h3><p>{feature.text}</p></div>
                </article>
              ))}
            </div>
          </div>
        </section>

        <section className="about-section" id="about" aria-labelledby="about-title">
          <div className="shell about-card glass-panel">
            <div><div className="kicker">О Luxora</div><h2 id="about-title">Создана с уважением<br />к вашему вниманию.</h2></div>
            <div className="about-card__copy"><p>Luxora — продукт Flenym. Мы соединяем приватную архитектуру, нативную скорость и спокойный интерфейс в одном пространстве для общения.</p><div className="about-meta"><span><small>Владелец и разработчик</small><strong>Flenym</strong></span><span><small>Текущий релиз</small><strong>Beta-0.1</strong></span></div></div>
          </div>
        </section>

        <section className="section continuity-section">
          <div className="shell continuity-grid">
            <div className="continuity-copy">
              <div className="kicker">Roadmap · multi-device</div>
              <h2>Один разговор.<br /><span>Любой экран.</span></h2>
              <p>Это целевой сценарий более позднего этапа roadmap. Сейчас веб-срез не переносит контекст между устройствами и не подключён к realtime API.</p>
              <ul className="check-list">
                <li><span><Icon name="plus" size={14} /></span>План: синхронные черновики и позиция чтения</li>
                <li><span><Icon name="plus" size={14} /></span>План: handoff звонка между устройствами</li>
                <li><span><Icon name="check" size={14} /></span>Сейчас: локальная работа интерфейса во вкладке</li>
              </ul>
              <button className="text-link" onClick={openMessenger} type="button">Попробовать в браузере <Icon name="arrow" size={17} /></button>
            </div>
            <div className="device-stage" aria-hidden="true">
              <div className="device device--desktop"><div className="device__screen"><div className="skeleton-rail" /><div className="skeleton-list"><i /><i /><i className="active" /><i /></div><div className="skeleton-chat"><b /><span /><span className="mine" /><span /></div></div></div>
              <div className="device device--phone"><div className="device__island" /><div className="device__mobile-head"><i /><span>Амелия</span><i /></div><div className="device__mobile-bubbles"><span /><span className="mine" /><span /></div><div className="device__mobile-compose" /></div>
              <div className="handoff-pill glass-panel"><span><Icon name="call" size={16} /></span><p><strong>Handoff звонка</strong><small>UX-концепт · roadmap</small></p><Icon name="chevron" size={15} /></div>
            </div>
          </div>
        </section>

        <section className="section security-section" id="security">
          <div className="security-orbit" aria-hidden="true"><i /><i /><i /></div>
          <div className="shell security-grid">
            <div className="security-visual">
              <div className="security-core"><span className="security-core__ring" /><div><Icon name="shield" size={48} /></div></div>
              <div className="security-chip security-chip--one glass-panel"><Icon name="lock" size={16} /> TLS + auth · transport</div>
              <div className="security-chip security-chip--two glass-panel"><Icon name="check" size={16} /> E2EE · roadmap</div>
              <div className="security-chip security-chip--three glass-panel"><Icon name="globe" size={16} /> Audit before release</div>
            </div>
            <div className="security-copy">
              <div className="kicker kicker--light">Безопасность · честный статус</div>
              <h2>Защита без<br /><span>непроверенных обещаний.</span></h2>
              <p>Beta-0.1 — локальное UI-демо: сообщения не отправляются на сервер. TLS и аутентификация покрывают подключаемый transport; per-device E2EE остаётся целевой архитектурой до реализации и аудита.</p>
              <div className="security-points">
                <article><span><Icon name="lock" /></span><div><h3>Что работает сейчас</h3><p>Демо-переписка хранится только в памяти вкладки; локально выбранные файлы не загружаются.</p></div></article>
                <article><span><Icon name="shield" /></span><div><h3>Сетевой фундамент</h3><p>TLS и аутентификация — обязательный минимум при подключении production API. UI не маскирует их под E2EE.</p></div></article>
                <article><span><Icon name="user" /></span><div><h3>Что идёт дальше</h3><p>Per-device keys, E2EE сообщений и звонков, проверка сессий и независимый аудит до заявления о защите.</p></div></article>
              </div>
              <a className="button button--light" href="#docs">Центр безопасности <Icon name="arrow" size={17} /></a>
            </div>
          </div>
        </section>

        <section className="section download-section" id="download">
          <div className="shell">
            <div className="section-heading section-heading--split">
              <div><div className="kicker">Клиенты · roadmap</div><h2>Нативные приложения готовятся.</h2></div>
              <p>Готовых публичных артефактов загрузки пока нет. Карточки ниже фиксируют целевые платформы, а Beta-0.1 доступна как web-срез и из исходного кода.</p>
            </div>
            <div className="download-grid">
              <DownloadCard icon="sun" name="iPhone & iPad" detail="Целевая платформа" status="В roadmap" />
              <DownloadCard icon="grid" name="macOS" detail="Исходный клиент в репозитории" status="Собрать из исходников" featured />
              <DownloadCard icon="grid" name="Windows" detail="Целевая платформа" status="В roadmap" />
              <DownloadCard icon="globe" name="Linux" detail="Целевая платформа" status="В roadmap" />
            </div>
            <div className="web-banner glass-panel">
              <div className="web-banner__icon"><Logo compact /></div>
              <div><h3>Откройте честное локальное демо</h3><p>Чаты, поиск, темы и выбор файлов работают в браузере. Сеть, звонки, push и постоянная история в Beta-0.1 не подключены.</p></div>
              <button className="button button--primary" type="button" onClick={openMessenger}>Открыть Web <Icon name="arrow" size={17} /></button>
            </div>
          </div>
        </section>

        <section className="section resource-section" id="resources">
          <div className="shell">
            <div className="section-heading"><div className="kicker">Журнал</div><h2>Как мы строим<br /><span>спокойное общение.</span></h2></div>
            <div className="blog-grid" id="blog">
              {blogPosts.map((post, index) => (
                <a href={`#article-${index + 1}`} className="blog-card" key={post.title}>
                  <div className={`blog-card__art blog-card__art--${index + 1}`}><span>{index === 0 ? "—  ·  —" : index === 1 ? "RT" : "L"}</span></div>
                  <div className="blog-card__meta"><span>{post.tag}</span><time>{post.date}</time></div>
                  <h3>{post.title}</h3><p>{post.text}</p>
                  <span className="blog-card__link">Читать <Icon name="arrow" size={16} /></span>
                </a>
              ))}
            </div>

            <div className="docs-block glass-panel" id="docs">
              <div className="docs-block__intro"><span className="docs-icon"><Icon name="file" size={26} /></span><div><div className="kicker">Документация</div><h2>Ответы для тех,<br />кто создаёт вместе с нами.</h2><p>Быстрый старт, протокол, SDK и рекомендации для сообществ.</p></div></div>
              <div className="docs-links">
                <a href="#getting-started"><span><Icon name="play" size={16} /></span><div><strong>Начало работы</strong><small>Аккаунт, устройства и первые пространства</small></div><Icon name="chevron" size={17} /></a>
                <a href="#api"><span><Icon name="link" size={16} /></span><div><strong>API и интеграции</strong><small>Боты, webhooks и приложения</small></div><Icon name="chevron" size={17} /></a>
                <a href="#communities"><span><Icon name="people" size={16} /></span><div><strong>Гайд для сообществ</strong><small>Роли, модерация и публичные каналы</small></div><Icon name="chevron" size={17} /></a>
              </div>
            </div>
          </div>
        </section>

        <section className="section faq-section" id="faq">
          <div className="shell faq-grid">
            <div className="faq-intro"><div className="kicker">FAQ</div><h2>Коротко<br />о главном.</h2><p>Не нашли ответ? Команда поддержки отвечает каждый день.</p><a href="#support" className="text-link">Написать нам <Icon name="arrow" size={17} /></a></div>
            <div className="faq-list">
              {faqs.map(([question, answer], index) => <details key={question} open={index === 0}><summary><span>{question}</span><i><Icon name="plus" size={18} /></i></summary><p>{answer}</p></details>)}
            </div>
          </div>
        </section>

        <section className="section support-section" id="support">
          <div className="shell support-card">
            <div className="support-card__glow" aria-hidden="true" />
            <div className="support-card__mark"><Logo compact /></div>
            <div><div className="kicker kicker--light">Контакт Beta-0.1</div><h2>Поговорим?</h2><p>Канал обратной связи Flenym по локальному web-срезу и roadmap Luxora.</p></div>
            <a className="button button--light" href="mailto:hello@luxora.app">hello@luxora.app <Icon name="arrow" size={17} /></a>
          </div>
        </section>
      </main>

      <footer className="site-footer">
        <div className="shell site-footer__top">
          <div className="site-footer__brand"><Logo /><p>Пространство для разговоров,<br />которые имеют значение.</p><div className="language"><Icon name="globe" size={16} /> Русский <Icon name="chevron" size={14} /></div></div>
          <div className="footer-links"><div><strong>Продукт</strong><a href="#features">Возможности</a><a href="#security">Безопасность</a><a href="#download">Клиенты</a><button onClick={openMessenger}>Web-версия</button></div><div><strong>Ресурсы</strong><a href="#blog">Журнал</a><a href="#docs">Документация</a><a href="#faq">FAQ</a><a href="#support">Поддержка</a></div><div><strong>Компания</strong><a href="#about">О Luxora</a><a href="#careers">Вакансии</a><a href="#brand">Бренд</a><a href="#press">Пресса</a></div></div>
        </div>
        <div className="shell site-footer__bottom"><span>© 2026 Flenym · Luxora Beta-0.1</span><div><a href="#privacy">Конфиденциальность</a><a href="#terms">Условия</a><a href="#cookies">Cookies</a></div><span>Made with care by Flenym.</span></div>
      </footer>
    </div>
  );
}

function InboxVisual() {
  return <div className="card-visual inbox-visual"><div className="inbox-line inbox-line--active"><span className="mini-avatar mini-avatar--gradient">A</span><div><strong>Амелия</strong><small>Печатает…</small></div><i>•</i></div><div className="inbox-line"><span className="mini-avatar mini-avatar--team">P</span><div><strong>Product room</strong><small>Новый макет уже здесь</small></div><time>12:42</time></div><div className="inbox-line"><span className="mini-avatar mini-avatar--photo">И</span><div><strong>Илья</strong><small>Голосовое · 0:24</small></div><time>10:18</time></div></div>;
}

function CallVisual() {
  return <div className="card-visual call-visual"><div className="call-orbit"><span className="call-avatar">AM</span><i /><i /></div><div className="call-wave">{[1,2,3,4,5,6,7,8,9,10,11].map((item) => <i key={item} />)}</div><span>00:18:42</span></div>;
}

function FileVisual() {
  return <div className="card-visual file-visual"><div className="file-tile file-tile--back"><Icon name="file" /><span>Brief.pdf</span></div><div className="file-tile"><div className="file-tile__preview">Lx</div><div><strong>Brand motion.mov</strong><small>1,8 ГБ · 72%</small><i><b /></i></div></div></div>;
}

function SenseVisual() {
  return <div className="card-visual sense-visual"><span className="sense-star"><Icon name="sparkles" size={24} /></span><p>Пока вас не было</p><strong>Команда выбрала второй вариант концепции и перенесла запуск на пятницу.</strong><div><span>12 сообщений</span><span>2 решения</span></div></div>;
}

function SyncVisual() {
  return <div className="card-visual sync-visual"><span className="sync-device sync-device--phone"><i /></span><span className="sync-line"><i /><i /><i /></span><span className="sync-device sync-device--laptop"><i /></span><span className="sync-status"><Icon name="plus" size={13} /> roadmap</span></div>;
}

function DownloadCard({ icon, name, detail, status, featured = false }: { icon: IconName; name: string; detail: string; status: string; featured?: boolean }) {
  return <article className={`download-card glass-panel ${featured ? "download-card--featured" : ""}`}><div className="download-card__icon"><Icon name={icon} size={26} /></div><div><h3>{name}</h3><p>{detail}</p></div><span className="download-card__button">{status}<Icon name={featured ? "file" : "chevron"} size={15} /></span>{featured && <span className="download-card__badge">Исходный код</span>}</article>;
}

type Chat = {
  id: string;
  name: string;
  initials: string;
  preview: string;
  time: string;
  unread?: number;
  muted?: boolean;
  online?: boolean;
  pinned?: boolean;
  kind?: "person" | "group" | "channel";
  color: string;
};

type Message = {
  id: string;
  from: "me" | "them";
  text?: string;
  time: string;
  status?: "sent" | "read";
  reaction?: string;
  reply?: string;
  file?: { name: string; size: string; type: string };
  voice?: string;
};

const initialChats: Chat[] = [
  { id: "amelia", name: "Амелия Рэй", initials: "АР", preview: "Да, выглядит волшебно ✦", time: "10:41", online: true, pinned: true, color: "aurora" },
  { id: "product", name: "Product room", initials: "PR", preview: "Марк: Отправил файл", time: "10:36", unread: 4, pinned: true, kind: "group", color: "ocean" },
  { id: "ilya", name: "Илья Ветров", initials: "ИВ", preview: "Голосовое сообщение · 0:24", time: "09:18", unread: 1, color: "coral" },
  { id: "design", name: "Luxora Design", initials: "LD", preview: "София: Посмотрите третий вариант", time: "вчера", muted: true, kind: "group", color: "violet" },
  { id: "news", name: "Luxora News", initials: "LN", preview: "Beta-0.1 уже доступна", time: "вчера", kind: "channel", color: "blue" },
  { id: "maria", name: "Мария Соколова", initials: "МС", preview: "Спасибо! До завтра", time: "пн", color: "rose" },
  { id: "saved", name: "Избранное", initials: "★", preview: "ideas-for-spring.md", time: "вс", color: "saved" },
];

const initialMessages: Record<string, Message[]> = {
  amelia: [
    { id: "a1", from: "them", text: "Доброе утро! У меня готова новая концепция стартового экрана.", time: "10:24" },
    { id: "a2", from: "them", file: { name: "Luxora · home concept.fig", size: "18,4 МБ", type: "FIG" }, time: "10:25" },
    { id: "a3", from: "me", text: "Очень чисто. Особенно нравится, как свет ведёт к главному действию.", time: "10:27", status: "read", reaction: "💜" },
    { id: "a4", from: "me", text: "Оставим больше воздуха в первом экране и проверим контраст на светлой теме.", time: "10:28", status: "read", reply: "новая концепция стартового экрана" },
    { id: "a5", from: "them", voice: "0:18", time: "10:34" },
    { id: "a6", from: "them", text: "Готово. И добавила мягкий переход между состояниями — теперь всё ощущается живым.", time: "10:40" },
    { id: "a7", from: "me", text: "Да, выглядит волшебно ✦", time: "10:41", status: "read" },
  ],
  product: [
    { id: "p1", from: "them", text: "Команда, фиксирую решения сегодняшнего синка.", time: "09:52" },
    { id: "p2", from: "them", file: { name: "Release plan · August.pdf", size: "3,2 МБ", type: "PDF" }, time: "10:02" },
    { id: "p3", from: "me", text: "Веб-версию Beta-0.1 можно включать в пятницу. Чек-лист закрою сегодня.", time: "10:14", status: "read" },
  ],
  ilya: [
    { id: "i1", from: "them", text: "Есть минутка? Хочу показать новую схему синхронизации.", time: "09:12" },
    { id: "i2", from: "them", voice: "0:24", time: "09:18" },
  ],
  design: [{ id: "d1", from: "them", text: "Собрала все состояния компонента. Посмотрите третий вариант — он спокойнее остальных.", time: "вчера" }],
  news: [{ id: "n1", from: "them", text: "Luxora Beta-0.1 уже доступна как локальный UI-срез. Спасибо, что помогаете Flenym делать общение человечнее.", time: "вчера" }],
  maria: [{ id: "m1", from: "them", text: "Спасибо! До завтра 👋", time: "пн" }],
  saved: [{ id: "s1", from: "me", file: { name: "ideas-for-spring.md", size: "12 КБ", type: "MD" }, time: "вс", status: "read" }],
};

type Filter = "all" | "unread" | "personal" | "groups";

function Messenger({ theme, toggleTheme, goHome }: { theme: Theme; toggleTheme: () => void; goHome: () => void }) {
  const [chats, setChats] = useState(initialChats);
  const [messages, setMessages] = useState(initialMessages);
  const [selectedId, setSelectedId] = useState("amelia");
  const [filter, setFilter] = useState<Filter>("all");
  const [query, setQuery] = useState("");
  const [draft, setDraft] = useState("");
  const [mobileChatOpen, setMobileChatOpen] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [toast, setToast] = useState("");
  const [activeRail, setActiveRail] = useState("chats");
  const fileInput = useRef<HTMLInputElement>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  const composerInput = useRef<HTMLTextAreaElement>(null);
  const messageEnd = useRef<HTMLDivElement>(null);

  const selectedChat = chats.find((chat) => chat.id === selectedId) ?? chats[0];
  const selectedMessages = messages[selectedId] ?? [];
  const filteredChats = useMemo(() => chats.filter((chat) => {
    const matchesQuery = `${chat.name} ${chat.preview}`.toLocaleLowerCase("ru").includes(query.toLocaleLowerCase("ru"));
    const matchesFilter = filter === "all" || (filter === "unread" && chat.unread) || (filter === "personal" && (!chat.kind || chat.kind === "person")) || (filter === "groups" && (chat.kind === "group" || chat.kind === "channel"));
    return matchesQuery && matchesFilter;
  }), [chats, filter, query]);

  useEffect(() => {
    messageEnd.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [selectedId, selectedMessages.length]);

  useEffect(() => {
    if (!toast) return;
    const timeout = window.setTimeout(() => setToast(""), 2600);
    return () => window.clearTimeout(timeout);
  }, [toast]);

  useEffect(() => {
    const bridge = window.luxoraDesktop;
    if (!bridge) return;
    const unsubscribe = bridge.onMenuAction((action) => {
      if (action === "search") {
        setMobileChatOpen(false);
        window.requestAnimationFrame(() => searchInput.current?.focus());
      }
      if (action === "new-message") {
        setMobileChatOpen(true);
        setDraft("");
        setToast("Новое сообщение · выберите разговор или начните печатать");
        window.requestAnimationFrame(() => composerInput.current?.focus());
      }
    });
    return typeof unsubscribe === "function" ? unsubscribe : undefined;
  }, []);

  const selectChat = (id: string) => {
    setSelectedId(id);
    setMobileChatOpen(true);
    setDetailsOpen(false);
    setChats((current) => current.map((chat) => chat.id === id ? { ...chat, unread: undefined } : chat));
  };

  const sendMessage = (event?: FormEvent) => {
    event?.preventDefault();
    const text = draft.trim();
    if (!text) return;
    const newMessage: Message = { id: `${selectedId}-${Date.now()}`, from: "me", text, time: new Intl.DateTimeFormat("ru", { hour: "2-digit", minute: "2-digit" }).format(new Date()), status: "sent" };
    setMessages((current) => ({ ...current, [selectedId]: [...(current[selectedId] ?? []), newMessage] }));
    setChats((current) => current.map((chat) => chat.id === selectedId ? { ...chat, preview: text, time: "сейчас" } : chat));
    setDraft("");
    window.setTimeout(() => {
      setMessages((current) => ({ ...current, [selectedId]: (current[selectedId] ?? []).map((message) => message.id === newMessage.id ? { ...message, status: "read" } : message) }));
    }, 900);
  };

  const handleComposerKey = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      sendMessage();
    }
  };

  const attachFile = (file?: File) => {
    if (!file) return;
    const size = file.size > 1_000_000 ? `${(file.size / 1_000_000).toFixed(1)} МБ` : `${Math.max(1, Math.round(file.size / 1_000))} КБ`;
    const next: Message = { id: `${selectedId}-file-${Date.now()}`, from: "me", file: { name: file.name, size, type: file.name.split(".").pop()?.toUpperCase() || "FILE" }, time: "сейчас", status: "sent" };
    setMessages((current) => ({ ...current, [selectedId]: [...(current[selectedId] ?? []), next] }));
    setChats((current) => current.map((chat) => chat.id === selectedId ? { ...chat, preview: `Файл: ${file.name}`, time: "сейчас" } : chat));
    setToast("Файл добавлен в разговор");
  };

  const railAction = (action: string, label: string) => {
    setActiveRail(action);
    setToast(`${label} доступны в полной версии Luxora`);
  };

  return (
    <div className={`messenger ${mobileChatOpen ? "messenger--chat-open" : ""}`}>
      <a className="skip-link" href="#conversation">К разговору</a>
      <aside className="app-rail" aria-label="Разделы Luxora">
        <button className="app-rail__logo" type="button" onClick={goHome} aria-label="На сайт Luxora"><Logo compact /></button>
        <nav>
          <button className={activeRail === "chats" ? "active" : ""} onClick={() => setActiveRail("chats")} aria-label="Чаты"><Icon name="message" /><span>Чаты</span><i>5</i></button>
          <button className={activeRail === "calls" ? "active" : ""} onClick={() => railAction("calls", "Звонки")} aria-label="Звонки"><Icon name="call" /><span>Звонки</span></button>
          <button className={activeRail === "people" ? "active" : ""} onClick={() => railAction("people", "Контакты")} aria-label="Контакты"><Icon name="people" /><span>Люди</span></button>
          <button className={activeRail === "saved" ? "active" : ""} onClick={() => { setActiveRail("saved"); selectChat("saved"); }} aria-label="Избранное"><Icon name="bookmark" /><span>Сохранено</span></button>
        </nav>
        <div className="app-rail__bottom"><button type="button" onClick={() => railAction("settings", "Настройки")} className={activeRail === "settings" ? "active" : ""} aria-label="Настройки"><Icon name="settings" /></button><button className="profile-orb" type="button" onClick={() => setToast("Профиль Виктории открыт")} aria-label="Открыть профиль">ВВ<span /></button></div>
      </aside>

      <aside className="chat-sidebar" aria-label="Список чатов">
        <header className="chat-sidebar__header"><div><p>Сообщения</p><h1>Чаты</h1></div><button className="icon-button icon-button--accent" type="button" onClick={() => setToast("Новый разговор — выберите контакт")} aria-label="Новый чат"><Icon name="edit" size={18} /></button></header>
        <label className="chat-search"><Icon name="search" size={17} /><span className="sr-only">Поиск чатов</span><input ref={searchInput} value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Поиск" /><kbd>⌘ K</kbd>{query && <button onClick={() => setQuery("")} type="button" aria-label="Очистить поиск"><Icon name="close" size={14} /></button>}</label>
        <div className="chat-filters" role="group" aria-label="Фильтр чатов">
          {([['all','Все'],['unread','Новые'],['personal','Личные'],['groups','Группы']] as [Filter, string][]).map(([value, label]) => <button type="button" className={filter === value ? "active" : ""} onClick={() => setFilter(value)} key={value}>{label}{value === "unread" && <span>5</span>}</button>)}
        </div>
        <div className="chat-list">
          {filteredChats.length ? filteredChats.map((chat) => (
            <button type="button" className={`chat-row ${selectedId === chat.id ? "chat-row--active" : ""}`} onClick={() => selectChat(chat.id)} key={chat.id} aria-current={selectedId === chat.id ? "true" : undefined}>
              <Avatar chat={chat} />
              <span className="chat-row__content"><span className="chat-row__title"><strong>{chat.name}</strong><time>{chat.time}</time></span><span className="chat-row__preview"><span>{chat.preview}</span>{chat.muted && <Icon name="bell" size={12} />}{chat.unread && <b>{chat.unread}</b>}</span></span>
              {chat.pinned && <Icon name="pin" size={11} />}
            </button>
          )) : <div className="empty-search"><span><Icon name="search" /></span><strong>Ничего не найдено</strong><p>Попробуйте другое имя или слово.</p></div>}
        </div>
        <div className="connection-state"><i /><span>Изменения сохранены в текущей вкладке</span><Icon name="check" size={14} /></div>
      </aside>

      <main className="conversation" id="conversation">
        <header className="conversation__header">
          <div className="conversation__identity"><button className="mobile-back" type="button" onClick={() => setMobileChatOpen(false)} aria-label="Вернуться к чатам"><Icon name="back" /></button><button className="identity-button" type="button" onClick={() => setDetailsOpen((value) => !value)}><Avatar chat={selectedChat} small /><span><strong>{selectedChat.name}</strong><small>{selectedChat.online ? <><i /> в сети · demo state</> : selectedChat.kind === "group" ? "18 участников · demo" : selectedChat.kind === "channel" ? "demo channel" : "статус · demo"}</small></span></button><span className="app-release-badge">Beta-0.1 · local</span></div>
          <div className="conversation__actions">
            <button className="icon-button" type="button" onClick={() => setSearchOpen((value) => !value)} aria-label="Поиск в разговоре"><Icon name="search" size={18} /></button>
            <button className="icon-button" type="button" onClick={() => setToast("Аудиозвонки появятся на этапе звонков · roadmap")} aria-label="Аудиозвонки — в roadmap"><Icon name="call" size={18} /></button>
            <button className="icon-button" type="button" onClick={() => setToast("Видеозвонки появятся на этапе звонков · roadmap")} aria-label="Видеозвонки — в roadmap"><Icon name="video" size={19} /></button>
            <button className="icon-button" type="button" onClick={() => setDetailsOpen((value) => !value)} aria-label="Информация о чате"><Icon name="info" size={18} /></button>
          </div>
        </header>

        {searchOpen && <div className="conversation-search"><Icon name="search" size={16} /><input autoFocus placeholder="Найти в этом разговоре" aria-label="Найти в этом разговоре" /><span>0 из 0</span><button onClick={() => setSearchOpen(false)} type="button"><Icon name="close" size={16} /></button></div>}
        <div className="pinned-message"><span><Icon name="pin" size={14} /></span><div><strong>Закреплённое сообщение</strong><p>Принцип: больше воздуха, меньше отвлечений.</p></div><button type="button" aria-label="Перейти к закреплённому"><Icon name="chevron" size={15} /></button></div>

        <div className="message-canvas">
          <div className="message-canvas__noise" aria-hidden="true" />
          <div className="message-stream" role="log" aria-live="polite" aria-label={`Переписка с ${selectedChat.name}`}>
            <div className="message-date"><span>Сегодня</span></div>
            {selectedMessages.map((message, index) => {
              const previous = selectedMessages[index - 1];
              const grouped = previous?.from === message.from;
              return <MessageBubble key={message.id} message={message} grouped={grouped} chat={selectedChat} onReact={() => setMessages((current) => ({ ...current, [selectedId]: current[selectedId].map((item) => item.id === message.id ? { ...item, reaction: item.reaction ? undefined : "💜" } : item) }))} />;
            })}
            {selectedChat.online && <div className="message-typing"><Avatar chat={selectedChat} tiny /><div><i /><i /><i /></div><span>{selectedChat.name.split(" ")[0]} печатает</span></div>}
            <div ref={messageEnd} />
          </div>
        </div>

        <form className="composer" onSubmit={sendMessage}>
          <input type="file" hidden ref={fileInput} onChange={(event) => { attachFile(event.target.files?.[0]); event.currentTarget.value = ""; }} />
          <button type="button" className="composer__attach" onClick={() => fileInput.current?.click()} aria-label="Прикрепить файл"><Icon name="paperclip" size={20} /></button>
          <div className="composer__field"><textarea ref={composerInput} rows={1} value={draft} onChange={(event) => setDraft(event.target.value)} onKeyDown={handleComposerKey} placeholder="Сообщение" aria-label={`Сообщение для ${selectedChat.name}`} /><button type="button" onClick={() => setDraft((current) => `${current}${current ? " " : ""}✨`)} aria-label="Добавить эмодзи"><Icon name="smile" size={20} /></button></div>
          <button className={`composer__send ${draft.trim() ? "composer__send--ready" : ""}`} type={draft.trim() ? "submit" : "button"} onClick={!draft.trim() ? () => setToast("Удерживайте, чтобы записать голосовое сообщение") : undefined} aria-label={draft.trim() ? "Отправить сообщение" : "Записать голосовое сообщение"}><Icon name={draft.trim() ? "send" : "mic"} size={19} /></button>
        </form>
      </main>

      <aside className={`details-panel ${detailsOpen ? "details-panel--open" : ""}`} aria-label="Информация о чате" aria-hidden={!detailsOpen}>
        <header><strong>Информация</strong><button className="icon-button" type="button" onClick={() => setDetailsOpen(false)} aria-label="Закрыть"><Icon name="close" size={18} /></button></header>
        <div className="details-profile"><Avatar chat={selectedChat} large /><h2>{selectedChat.name}</h2><p>{selectedChat.online ? "в сети · демо" : "@luxora_member"}</p><div><button type="button" onClick={() => setToast("Звонки находятся в roadmap")}><span><Icon name="call" /></span>Roadmap</button><button type="button" onClick={() => setSearchOpen(true)}><span><Icon name="search" /></span>Поиск</button><button type="button" onClick={() => setToast("Локальное demo-состояние обновлено")}><span><Icon name="bell" /></span>Без звука</button></div></div>
        <div className="details-bio"><p>Создаём вещи, которыми хочется пользоваться каждый день.</p><span>@{selectedChat.id}</span></div>
        <div className="details-section"><div><strong>Общие медиа</strong><button type="button">Показать все</button></div><div className="media-grid"><span>Lx</span><span /><span /><span /></div></div>
        <div className="details-links"><button type="button"><Icon name="bookmark" size={17} /><span>Сохранённые сообщения</span><b>Demo</b><Icon name="chevron" size={15} /></button><button type="button"><Icon name="bell" size={17} /><span>Уведомления</span><b>Не подключены</b><Icon name="chevron" size={15} /></button><button type="button"><Icon name="lock" size={17} /><span>E2EE</span><b>Roadmap</b><Icon name="chevron" size={15} /></button></div>
      </aside>

      <div className="app-top-actions"><ThemeButton theme={theme} toggle={toggleTheme} /><button className="icon-button" onClick={goHome} aria-label="Вернуться на сайт"><Icon name="globe" size={18} /></button></div>
      <div className={`app-toast ${toast ? "app-toast--visible" : ""}`} role="status"><Icon name="check" size={16} />{toast}</div>
    </div>
  );
}

function Avatar({ chat, small = false, tiny = false, large = false }: { chat: Chat; small?: boolean; tiny?: boolean; large?: boolean }) {
  return <span className={`avatar avatar--${chat.color} ${small ? "avatar--small" : ""} ${tiny ? "avatar--tiny" : ""} ${large ? "avatar--large" : ""}`}>{chat.initials}{chat.online && <i />}</span>;
}

function MessageBubble({ message, grouped, chat, onReact }: { message: Message; grouped: boolean; chat: Chat; onReact: () => void }) {
  return (
    <div className={`message-line message-line--${message.from} ${grouped ? "message-line--grouped" : ""}`}>
      {message.from === "them" && !grouped ? <Avatar chat={chat} tiny /> : message.from === "them" ? <span className="avatar-spacer" /> : null}
      <button className={`message-bubble ${message.file ? "message-bubble--file" : ""} ${message.voice ? "message-bubble--voice" : ""}`} type="button" onDoubleClick={onReact} aria-label={`${message.from === "me" ? "Вы" : chat.name}: ${message.text ?? message.file?.name ?? "голосовое сообщение"}. Двойное нажатие — реакция`}>
        {message.reply && <span className="message-reply"><strong>Амелия Рэй</strong>{message.reply}</span>}
        {message.file && <span className="message-file"><i>{message.file.type}</i><span><strong>{message.file.name}</strong><small>{message.file.size} · Нажмите, чтобы открыть</small></span><b><Icon name="download" size={17} /></b></span>}
        {message.voice && <span className="voice-note"><i><Icon name="play" size={16} /></i><span className="voice-wave">{[1,2,3,4,5,6,7,8,9,10,11,12,13,14,15].map((item) => <b key={item} />)}</span><small>{message.voice}</small></span>}
        {message.text && <span className="message-text">{message.text}</span>}
        <span className="message-meta">{message.time}{message.from === "me" && <Icon name="check" size={11} />}</span>
        {message.reaction && <span className="message-reaction">{message.reaction} <small>1</small></span>}
      </button>
    </div>
  );
}

export default function App() {
  const [theme, toggleTheme] = useTheme();
  const [view, setView] = useState<AppView>(() => window.location.pathname.startsWith("/app") ? "messenger" : "landing");

  useEffect(() => {
    const onPopState = () => setView(window.location.pathname.startsWith("/app") ? "messenger" : "landing");
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  const navigate = (next: AppView) => {
    const path = next === "messenger" ? "/app" : "/";
    if (window.location.pathname !== path) window.history.pushState({}, "", path);
    setView(next);
    window.scrollTo({ top: 0, behavior: "auto" });
  };

  return <div className="luxora-root" data-theme={theme}>{view === "landing" ? <Landing theme={theme} toggleTheme={toggleTheme} openMessenger={() => navigate("messenger")} /> : <Messenger theme={theme} toggleTheme={toggleTheme} goHome={() => navigate("landing")} />}</div>;
}
