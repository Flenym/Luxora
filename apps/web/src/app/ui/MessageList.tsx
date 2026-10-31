/** Conversation message list: grouping, day separators, unread divider,
 *  pagination, auto-scroll with preservation, typing row and honest empties. */
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ArrowDown, LoaderCircle } from "lucide-react";
import type { Chat, ChatMember, Id, UiMessage, User } from "../contract";
import { useMessenger } from "../messenger";
import { useLocale } from "../../i18n";
import { useStrings } from "./copy";
import { formatDaySeparator, isSameDay, prefersReducedMotion } from "./format";
import { MessageBubble } from "./MessageBubble";
import { Spinner } from "./primitives";

const GROUP_WINDOW_MS = 5 * 60 * 1000;

type Row =
  | { type: "day"; key: string; at: string }
  | { type: "divider"; key: string }
  | { type: "message"; key: string; message: UiMessage; grouped: boolean; showSenderName: boolean };

type MessageListProps = {
  chat: Chat;
  members: ChatMember[];
  me: User | null;
  onReply: (message: UiMessage) => void;
  onNotify: (text: string, tone?: "notice" | "error") => void;
};

export function MessageList({ chat, members, me, onReply, onNotify }: MessageListProps) {
  const s = useStrings();
  const { locale } = useLocale();
  const api = useMessenger();
  const messages = api.messages[chat.id] ?? [];
  const page = api.pages[chat.id];
  const receiptsFor = api.receipts;
  const typing = (api.typing[chat.id] ?? []).filter((entry) => entry.expiresAt > Date.now());

  const listRef = useRef<HTMLDivElement | null>(null);
  const dividerRef = useRef<HTMLDivElement | null>(null);
  const atBottomRef = useRef(true);
  const openedRef = useRef<Id | null>(null);
  const pendingUnreadRef = useRef(0);
  const prependRef = useRef<{ height: number; top: number; count: number } | null>(null);
  const [atBottom, setAtBottom] = useState(true);
  const [divider, setDivider] = useState<{ chatId: Id; index: number } | null>(null);

  const messagesById = useMemo(() => new Map<Id, UiMessage>(messages.map((message) => [message.id, message])), [messages]);
  const lastMessage = messages.length > 0 ? messages[messages.length - 1]! : null;

  /* Remember the unread count of the chat at the moment it is opened, so the
     "new messages" divider is not erased by the subsequent markRead commit. */
  const initialUnreadRef = useRef(0);
  useEffect(() => {
    initialUnreadRef.current = chat.unreadCount;
    pendingUnreadRef.current = chat.unreadCount;
    openedRef.current = null;
    setDivider(null);
    setAtBottom(true);
    atBottomRef.current = true;
    // Capture the unread count only when the chat changes: a later markRead
    // commit must not erase the "new messages" divider.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chat.id]);

  /* First paint of a freshly opened chat: jump to the unread divider or bottom. */
  useLayoutEffect(() => {
    if (messages.length === 0) return;
    if (openedRef.current === chat.id) return;
    openedRef.current = chat.id;
    const unread = pendingUnreadRef.current;
    const index = unread > 0 ? Math.max(0, messages.length - Math.min(unread, messages.length)) : -1;
    const el = listRef.current;
    if (index >= 0) {
      setDivider({ chatId: chat.id, index });
    } else {
      if (el) el.scrollTop = el.scrollHeight;
      atBottomRef.current = true;
      setAtBottom(true);
    }
  }, [chat.id, messages.length]);

  useLayoutEffect(() => {
    if (!divider) return;
    const node = dividerRef.current;
    const el = listRef.current;
    if (node && el) {
      // Scroll the message container itself: scrollIntoView would also scroll
      // the page and push the app header out of the viewport.
      const containerRect = el.getBoundingClientRect();
      const nodeRect = node.getBoundingClientRect();
      el.scrollTop += nodeRect.top - containerRect.top - (el.clientHeight - nodeRect.height) / 2;
      atBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 160;
      setAtBottom(atBottomRef.current);
    }
  }, [divider]);

  /* Auto-scroll when new messages arrive while the reader is at the bottom. */
  const lastKey = lastMessage ? `${lastMessage.id}:${lastMessage.revision}` : "";
  useLayoutEffect(() => {
    if (!lastKey) return;
    if (openedRef.current !== chat.id) return;
    const el = listRef.current;
    if (!el) return;
    if (atBottomRef.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [lastKey, chat.id]);

  /* Preserve the reading position when older pages are prepended. */
  useLayoutEffect(() => {
    const prep = prependRef.current;
    if (!prep) return;
    if (messages.length === prep.count) return;
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight - prep.height + prep.top;
    prependRef.current = null;
  }, [messages.length]);

  useEffect(() => {
    if (page?.loading || !prependRef.current) return;
    if (messages.length === prependRef.current.count) prependRef.current = null;
  }, [page?.loading, messages.length]);

  /* Server-truth read receipt for the newest incoming message. */
  useEffect(() => {
    if (!lastMessage || !me) return;
    if (lastMessage.sender.id === me.id || lastMessage.deletedAt) return;
    if (chat.unreadCount <= 0) return;
    api.markRead(chat.id, lastMessage.id).catch(() => {
      /* read receipts are best-effort; never block the UI */
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chat.id, lastMessage?.id, chat.unreadCount]);

  const dividerIndex = divider && divider.chatId === chat.id ? divider.index : -1;

  const rows = useMemo<Row[]>(() => {
    const result: Row[] = [];
    let previous: UiMessage | null = null;
    messages.forEach((message, index) => {
      if (index === dividerIndex) result.push({ type: "divider", key: "new-messages-divider" });
      const at = message.createdAt;
      if (!previous || !isSameDay(new Date(previous.createdAt), new Date(at))) {
        result.push({ type: "day", key: `day-${index}-${at}`, at });
      }
      const bothAlive = previous !== null && !previous.deletedAt && !message.deletedAt;
      const sameSender = previous !== null && previous.sender.id === message.sender.id;
      const closeInTime =
        previous !== null &&
        Math.abs(new Date(message.createdAt).getTime() - new Date(previous.createdAt).getTime()) < GROUP_WINDOW_MS;
      const grouped = Boolean(
        bothAlive && sameSender && closeInTime && isSameDay(new Date(previous!.createdAt), new Date(at)),
      );
      result.push({
        type: "message",
        key: message.id,
        message,
        grouped,
        showSenderName: !grouped && (chat.kind === "group" || chat.kind === "channel"),
      });
      previous = message;
    });
    if (dividerIndex >= messages.length && messages.length > 0) {
      result.push({ type: "divider", key: "new-messages-divider" });
    }
    return result;
  }, [messages, dividerIndex, chat.kind]);

  const onScroll = () => {
    const el = listRef.current;
    if (!el) return;
    const bottom = el.scrollHeight - el.scrollTop - el.clientHeight < 160;
    atBottomRef.current = bottom;
    setAtBottom(bottom);
  };

  const scrollToBottom = () => {
    const el = listRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: prefersReducedMotion() ? "auto" : "smooth" });
  };

  const jumpToMessage = (messageId: Id) => {
    const node = document.getElementById(`msg-${messageId}`);
    if (!node) {
      onNotify(s.conversation.replyUnavailable);
      return;
    }
    const el = listRef.current;
    if (el) {
      const containerRect = el.getBoundingClientRect();
      const nodeRect = node.getBoundingClientRect();
      el.scrollTo({
        top: el.scrollTop + nodeRect.top - containerRect.top - containerRect.height / 3,
        behavior: prefersReducedMotion() ? "auto" : "smooth",
      });
    }
    node.classList.add("is-highlighted");
    window.setTimeout(() => node.classList.remove("is-highlighted"), 1600);
  };

  const loadOlder = () => {
    const el = listRef.current;
    if (!el) return;
    prependRef.current = { height: el.scrollHeight, top: el.scrollTop, count: messages.length };
    api.loadOlder(chat.id).catch(() => {
      prependRef.current = null;
      onNotify(s.toasts.errorTitle, "error");
    });
  };

  const loaded = page?.loaded ?? false;
  const loading = page?.loading ?? false;

  return (
    <div className="conversation__messages-wrap">
      <div
        ref={listRef}
        className="message-list"
        data-testid="message-list"
        role="log"
        aria-label={s.conversation.kind[chat.kind]}
        aria-live="polite"
        onScroll={onScroll}
      >
        {page?.nextCursor ? (
          <div className="message-list__top">
            <button
              type="button"
              className="button button--ghost button--sm"
              data-testid="load-older"
              onClick={loadOlder}
              disabled={loading}
            >
              {loading ? <LoaderCircle size={15} className="spin" aria-hidden="true" /> : null}
              {loading ? s.conversation.loadingOlder : s.conversation.loadOlder}
            </button>
          </div>
        ) : null}

        {!loaded && messages.length === 0 ? (
          <div className="message-list__state" role="status">
            <Spinner label={s.conversation.loadingMessages} />
            <p>{s.conversation.loadingMessages}</p>
          </div>
        ) : page?.error && messages.length === 0 ? (
          <div className="message-list__state">
            <p>{s.conversation.messagesError}</p>
            <button type="button" className="button button--ghost" onClick={() => void api.openChat(chat.id)}>
              {s.conversation.retryLoad}
            </button>
          </div>
        ) : messages.length === 0 ? (
          <div className="message-list__state">
            <p>{s.sidebar.noMessages}</p>
          </div>
        ) : (
          <>
            {rows.map((row) => {
              if (row.type === "day") {
                return (
                  <div key={row.key} className="day-separator" role="separator" aria-label={formatDaySeparator(row.at, locale, s.conversation)}>
                    <span>{formatDaySeparator(row.at, locale, s.conversation)}</span>
                  </div>
                );
              }
              if (row.type === "divider") {
                return (
                  <div
                    key={row.key}
                    ref={dividerRef}
                    className="new-messages-divider"
                    data-testid="new-messages-divider"
                    role="separator"
                    aria-label={s.conversation.newMessages}
                  >
                    <span>{s.conversation.newMessages}</span>
                  </div>
                );
              }
              const receiptState = receiptsFor[row.message.id];
              return (
                <MessageBubble
                  key={row.key}
                  message={row.message}
                  chat={chat}
                  members={members}
                  me={me}
                  messagesById={messagesById}
                  reactions={api.reactions[row.message.id] ?? []}
                  receipts={receiptState}
                  grouped={row.grouped}
                  showSenderName={row.showSenderName}
                  onReply={onReply}
                  onJumpTo={jumpToMessage}
                  onRetry={(message) => void api.retrySend(chat.id, message.clientNonce)}
                  onNotify={onNotify}
                />
              );
            })}
          </>
        )}

        {typing.length > 0 ? (
          <div className="typing-indicator" data-testid="typing-indicator" role="status" aria-live="polite">
            <span className="typing-indicator__dots" aria-hidden="true">
              <span />
              <span />
              <span />
            </span>
            <span>{s.conversation.typing(typing.map((entry) => entry.displayName))}</span>
          </div>
        ) : null}

        <div className="message-list__bottom-anchor" aria-hidden="true" />
      </div>

      {!atBottom && messages.length > 0 ? (
        <button type="button" className="jump-latest" onClick={scrollToBottom} aria-label={s.conversation.jumpLatest} title={s.conversation.jumpLatest}>
          <ArrowDown size={17} aria-hidden="true" />
        </button>
      ) : null}
    </div>
  );
}
