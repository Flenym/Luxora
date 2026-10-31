/** /app entry: full-screen messenger outside the marketing layout.
 *  booting -> branded loader, anonymous -> auth, ready -> two-pane shell. */
import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { WifiOff } from "lucide-react";
import "./app.css";
import { MessengerProvider, useMessenger } from "./messenger";
import { AuthScreen } from "./ui/AuthScreen";
import { Sidebar } from "./ui/Sidebar";
import { ConversationPane } from "./ui/ConversationPane";
import { NewChatDialog, ProfileDialog, RequestsDialog } from "./ui/dialogs";
import { ActiveCallOverlay, IncomingCallBanner } from "./ui/calls";
import { ToastProvider, useToasts } from "./ui/toasts";
import { useStrings } from "./ui/copy";

export default function MessengerApp() {
  return (
    <MessengerProvider>
      <MessengerRoot />
    </MessengerProvider>
  );
}

function MessengerRoot() {
  const api = useMessenger();
  if (api.phase === "booting") return <BootScreen />;
  if (api.phase === "fatal") return <FatalScreen />;
  if (api.phase !== "ready") return <AuthScreen />;
  return (
    <ToastProvider>
      <MessengerShell />
    </ToastProvider>
  );
}

function BootScreen() {
  const s = useStrings();
  return (
    <div className="boot" role="status" aria-live="polite" aria-busy="true">
      <div className="boot__aurora" aria-hidden="true" />
      <img className="boot__logo" src="/logo.png" alt="" width={64} height={64} />
      <p className="boot__name">{s.app.name}</p>
      <div className="boot__bar" aria-hidden="true">
        <span />
      </div>
      <p className="boot__label">{s.app.loading}</p>
      <p className="boot__hint">{s.app.loadingHint}</p>
      <Link className="boot__link" to="/">
        {s.app.backToSite}
      </Link>
    </div>
  );
}

function FatalScreen() {
  const s = useStrings();
  const api = useMessenger();
  return (
    <div className="boot boot--fatal" role="alert">
      <div className="boot__aurora" aria-hidden="true" />
      <img className="boot__logo" src="/logo.png" alt="" width={56} height={56} />
      <h1 className="boot__name">{s.app.fatalTitle}</h1>
      <p className="boot__label">{api.fatalError ?? s.app.fatalHint}</p>
      <p className="boot__hint">{s.app.fatalHint}</p>
      <div className="boot__actions">
        <button type="button" className="button button--primary" onClick={() => api.retryBoot()}>
          {s.app.retry}
        </button>
        <Link className="button button--ghost" to="/">
          {s.app.backToSite}
        </Link>
      </div>
    </div>
  );
}

function MessengerShell() {
  const s = useStrings();
  const api = useMessenger();
  const toasts = useToasts();
  const [newChatOpen, setNewChatOpen] = useState(false);
  const [requestsOpen, setRequestsOpen] = useState(false);
  const [profileOpen, setProfileOpen] = useState(false);
  const bootLoadedFor = useRef<string | null>(null);

  /* One initial fetch per signed-in session: chats and requests. */
  useEffect(() => {
    if (api.phase !== "ready" || !api.user) return;
    if (bootLoadedFor.current === api.user.id) return;
    bootLoadedFor.current = api.user.id;
    void api.loadChats();
    void api.loadRequests();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api.phase, api.user?.id]);

  /* Ctrl/Cmd+K focuses the chat search (Esc is owned by dialogs/popovers). */
  const focusSearch = useCallback(() => {
    const input = document.getElementById("chat-search");
    if (input instanceof HTMLInputElement) {
      input.focus();
      input.select();
    }
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        focusSearch();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [focusSearch]);

  const closeChat = () => api.closeChat();
  const offline = api.connection === "offline" || api.connection === "reconnecting";

  return (
    <div className={`app${api.activeChatId ? " app--chat-open" : ""}`} data-testid="app-shell">
      <div className="app__aurora" aria-hidden="true" />
      <div className="app__shell">
        <Sidebar
          onNewChat={() => setNewChatOpen(true)}
          onRequests={() => setRequestsOpen(true)}
          onProfile={() => setProfileOpen(true)}
        />
        <ConversationPane onNotify={toasts.notify} onBack={closeChat} />
      </div>

      {offline ? (
        <div className="connection-banner" role="status" aria-live="polite">
          <WifiOff size={16} aria-hidden="true" />
          <span>{api.connection === "offline" ? s.connection.offlineHint : s.connection.reconnectingHint}</span>
        </div>
      ) : null}

      <NewChatDialog open={newChatOpen} onClose={() => setNewChatOpen(false)} onNotify={toasts.notify} />
      <RequestsDialog open={requestsOpen} onClose={() => setRequestsOpen(false)} onNotify={toasts.notify} />
      <ProfileDialog open={profileOpen} onClose={() => setProfileOpen(false)} onNotify={toasts.notify} />

      <IncomingCallBanner onNotify={toasts.notify} />
      <ActiveCallOverlay onNotify={toasts.notify} />
    </div>
  );
}
