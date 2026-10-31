/** Left pane: brand, search, filters, chat rows, requests and profile/connection footer. */
import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { ArrowLeft, BellOff, Inbox, Search, SquarePen, X } from "lucide-react";
import type { Chat, Id } from "../contract";
import { useMessenger } from "../messenger";
import { useLocale } from "../../i18n";
import { useStrings } from "./copy";
import { Avatar, Spinner } from "./primitives";
import { messagePreview, formatRelativeChatTime } from "./format";

type Filter = "all" | "unread" | "archived";

type SidebarProps = {
  onNewChat: () => void;
  onRequests: () => void;
  onProfile: () => void;
};

function isArchived(chat: Chat): boolean {
  return chat.archivedAt !== null;
}

function isMuted(chat: Chat): boolean {
  return chat.mutedUntil !== null && new Date(chat.mutedUntil).getTime() > Date.now();
}

function sortChats(chats: Chat[]): Chat[] {
  return [...chats].sort((a, b) => {
    const time = new Date(b.lastActivityAt).getTime() - new Date(a.lastActivityAt).getTime();
    return time !== 0 ? time : a.title.localeCompare(b.title);
  });
}

function matchesQuery(chat: Chat, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  if (chat.title.toLowerCase().includes(needle)) return true;
  const preview = chat.lastMessage
    ? messagePreview(chat.lastMessage.body, chat.lastMessage.attachments, {
        image: "image",
        video: "video",
        voice: "voice",
        audio: "audio",
        file: "file",
      })
    : "";
  return preview.toLowerCase().includes(needle);
}

export function ChatRow({
  chat,
  active,
  onSelect,
}: {
  chat: Chat;
  active: boolean;
  onSelect: (id: Id) => void;
}) {
  const s = useStrings();
  const { locale } = useLocale();
  const api = useMessenger();
  const me = api.user;
  const last = chat.lastMessage;
  const muted = isMuted(chat);
  const preview = last
    ? last.deletedAt
      ? s.sidebar.previewDeleted
      : messagePreview(last.body, last.attachments, {
          image: s.conversation.imageLabel,
          video: s.conversation.videoLabel,
          voice: s.conversation.voiceLabel,
          audio: s.conversation.audioLabel,
          file: s.conversation.fileLabel,
        })
    : s.sidebar.noMessages;
  const isOwn = Boolean(last && me && last.sender.id === me.id);
  const showSender = Boolean(
    last && !last.deletedAt && !isOwn && (chat.kind === "group" || chat.kind === "channel"),
  );

  return (
    <div role="listitem">
      <button
        type="button"
        className={`chat-row${active ? " is-active" : ""}`}
        data-testid={`chat-row-${chat.id}`}
        aria-current={active ? "true" : undefined}
        onClick={() => onSelect(chat.id)}
      >
        <Avatar name={chat.title} path={chat.avatarUrl?.startsWith("/") ? chat.avatarUrl : null} size="md" />
        <span className="chat-row__body">
          <span className="chat-row__top">
            <span className="chat-row__title">{chat.title}</span>
            {muted ? <BellOff size={14} className="chat-row__muted" aria-label={s.sidebar.muted} /> : null}
            <span className="chat-row__time">{formatRelativeChatTime(last?.createdAt ?? chat.lastActivityAt, locale, { yesterday: s.conversation.yesterday })}</span>
          </span>
          <span className="chat-row__bottom">
            <span className="chat-row__preview">
              {last && isOwn && !last.deletedAt ? <span className="chat-row__you">{s.sidebar.previewYou}</span> : null}
              {showSender ? <span className="chat-row__sender">{last!.sender.displayName}: </span> : null}
              {preview}
            </span>
            {chat.unreadCount > 0 ? (
              <span className="chat-row__unread" aria-label={s.sidebar.unreadAria(chat.unreadCount)}>
                {chat.unreadCount > 99 ? "99+" : chat.unreadCount}
              </span>
            ) : isArchived(chat) ? (
              <span className="chat-row__archive">{s.sidebar.archived}</span>
            ) : null}
          </span>
        </span>
      </button>
    </div>
  );
}

export function Sidebar({ onNewChat, onRequests, onProfile }: SidebarProps) {
  const s = useStrings();
  const api = useMessenger();
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [serverResults, setServerResults] = useState<Chat[]>([]);
  const [serverSearching, setServerSearching] = useState(false);
  const searchRef = useRef<HTMLInputElement | null>(null);

  const requestsCount = api.requests.incoming.filter((request) => request.state === "pending").length;

  useEffect(() => {
    const term = query.trim();
    if (!term || term.length < 1 || !api.capabilities?.features.serverSearchConfigured) {
      setServerResults([]);
      setServerSearching(false);
      return;
    }
    let cancelled = false;
    setServerSearching(true);
    const timer = window.setTimeout(() => {
      api.searchChats(term).then(
        (items) => {
          if (cancelled) return;
          setServerResults(items);
          setServerSearching(false);
        },
        () => {
          if (cancelled) return;
          setServerResults([]);
          setServerSearching(false);
        },
      );
    }, 320);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      setServerSearching(false);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, api.searchChats, api.capabilities?.features.serverSearchConfigured]);

  const visibleChats = useMemo(() => {
    const byFilter = api.chats.filter((chat) => {
      if (filter === "archived") return isArchived(chat);
      if (isArchived(chat)) return false;
      if (filter === "unread") return chat.unreadCount > 0;
      return true;
    });
    const local = byFilter.filter((chat) => matchesQuery(chat, query));
    if (!query.trim()) return sortChats(local);
    const seen = new Set(local.map((chat) => chat.id));
    const remote = serverResults.filter((chat) => {
      if (seen.has(chat.id)) return false;
      seen.add(chat.id);
      if (filter === "archived") return isArchived(chat);
      if (filter === "unread") return chat.unreadCount > 0;
      return true;
    });
    return [...sortChats(local), ...sortChats(remote)];
  }, [api.chats, filter, query, serverResults]);

  const connectionLabel = s.connection[api.connection];
  const connectionTone =
    api.connection === "online" ? "online" : api.connection === "offline" ? "offline" : "pending";

  return (
    <aside className="sidebar" aria-label={s.sidebar.chatsAria}>
      <h1 className="sr-only">{s.sidebar.chatsAria}</h1>
      <div className="sidebar__brandrow">
        <div className="brand">
          <img className="brand__mark" src="/logo.png" alt="" width={30} height={30} />
          <span className="brand__name">{s.app.name}</span>
          <span className="brand__beta">{s.app.beta}</span>
        </div>
        <Link className="sidebar__sitelink" to="/" aria-label={s.app.backToSite} title={s.app.backToSite}>
          <ArrowLeft size={16} aria-hidden="true" />
        </Link>
      </div>

      <div className="sidebar__searchrow">
        <label className="search-field">
          <Search size={17} aria-hidden="true" />
          <input
            ref={searchRef}
            id="chat-search"
            data-testid="chat-search"
            type="search"
            role="searchbox"
            aria-label={s.sidebar.searchLabel}
            placeholder={s.sidebar.searchPlaceholder}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            autoComplete="off"
            spellCheck={false}
          />
          {query ? (
            <button
              type="button"
              className="search-field__clear"
              aria-label={s.sidebar.clearSearch}
              onClick={() => {
                setQuery("");
                searchRef.current?.focus();
              }}
            >
              <X size={15} aria-hidden="true" />
            </button>
          ) : null}
        </label>
        <button
          type="button"
          className="sidebar__action"
          data-testid="new-chat-button"
          aria-label={s.sidebar.newChat}
          title={s.sidebar.newChat}
          onClick={onNewChat}
        >
          <SquarePen size={19} aria-hidden="true" />
        </button>
        <button
          type="button"
          className="sidebar__action"
          data-testid="requests-button"
          aria-label={s.sidebar.requestsAria(requestsCount)}
          title={s.sidebar.requests}
          onClick={onRequests}
        >
          <Inbox size={19} aria-hidden="true" />
          {requestsCount > 0 ? <span className="sidebar__action-badge">{requestsCount > 9 ? "9+" : requestsCount}</span> : null}
        </button>
      </div>

      <div className="filter-chips" role="group" aria-label={s.sidebar.searchLabel}>
        <button
          type="button"
          className={`filter-chip${filter === "all" ? " is-active" : ""}`}
          data-testid="chat-filter-all"
          aria-pressed={filter === "all"}
          onClick={() => setFilter("all")}
        >
          {s.sidebar.filtersAll}
        </button>
        <button
          type="button"
          className={`filter-chip${filter === "unread" ? " is-active" : ""}`}
          data-testid="chat-filter-unread"
          aria-pressed={filter === "unread"}
          onClick={() => setFilter("unread")}
        >
          {s.sidebar.filtersUnread}
        </button>
        <button
          type="button"
          className={`filter-chip${filter === "archived" ? " is-active" : ""}`}
          data-testid="chat-filter-archived"
          aria-pressed={filter === "archived"}
          onClick={() => setFilter("archived")}
        >
          {s.sidebar.filtersArchived}
        </button>
        {serverSearching ? (
          <span className="filter-chips__searching" role="status">
            <Spinner label={s.sidebar.searching} />
          </span>
        ) : null}
      </div>

      <div className="chat-list" data-testid="chat-list" role="list" aria-busy={api.chatsLoading || serverSearching}>
        {api.chatsLoading && api.chats.length === 0 ? (
          <div className="chat-list__state" role="status">
            <Spinner label={s.sidebar.loading} />
            <p>{s.sidebar.loading}</p>
          </div>
        ) : api.chatsError && api.chats.length === 0 ? (
          <div className="chat-list__state">
            <p>{s.sidebar.loadError}</p>
            <button type="button" className="button button--ghost" onClick={() => void api.loadChats()}>
              {s.sidebar.retry}
            </button>
          </div>
        ) : visibleChats.length === 0 ? (
          <div className="chat-list__state">
            {query.trim() ? (
              <p>{s.sidebar.emptySearch}</p>
            ) : filter !== "all" ? (
              <p>{s.sidebar.emptyFilter}</p>
            ) : (
              <>
                <p className="chat-list__empty-title">{s.sidebar.emptyTitle}</p>
                <p>{s.sidebar.emptyLead}</p>
              </>
            )}
          </div>
        ) : (
          visibleChats.map((chat) => (
            <ChatRow
              key={chat.id}
              chat={chat}
              active={chat.id === api.activeChatId}
              onSelect={(id) => void api.openChat(id)}
            />
          ))
        )}
      </div>

      <div className="sidebar__foot">
        <button
          type="button"
          className="profile-button"
          data-testid="profile-menu"
          title={s.sidebar.profileButton}
          aria-haspopup="dialog"
          onClick={onProfile}
        >
          <span aria-hidden="true">
            <Avatar
              name={api.user?.displayName ?? s.conversation.you}
              path={api.user?.avatarPath ?? null}
              size="sm"
              presence={api.connection === "online" ? "online" : "offline"}
            />
          </span>
          <span className="profile-button__text">
            <span className="profile-button__name">{api.user?.displayName ?? s.conversation.you}</span>
          </span>
        </button>
        <span
          className={`connection-pill connection-pill--${connectionTone}`}
          data-testid="app-connection-banner"
          role="status"
          aria-live="polite"
          aria-label={s.app.connectionAria(connectionLabel)}
          title={
            api.connection === "offline"
              ? s.connection.offlineHint
              : api.connection === "reconnecting"
                ? s.connection.reconnectingHint
                : connectionLabel
          }
        >
          <span className="connection-pill__dot" aria-hidden="true" />
          {connectionLabel}
        </span>
      </div>
    </aside>
  );
}
