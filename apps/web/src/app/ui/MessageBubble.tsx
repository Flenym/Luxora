/** One message row: grouping, replies, attachments, reactions, delivery truth,
 *  inline edit/delete and a keyboard-accessible context menu. */
import { useMemo, useRef, useState, type MouseEvent } from "react";
import {
  Check,
  CheckCheck,
  CircleAlert,
  Clock,
  Copy,
  CornerUpLeft,
  Ellipsis,
  Pencil,
  Pin,
  Plus,
  Reply,
  Trash,
} from "lucide-react";
import type { Chat, ChatMember, Id, MessageReceiptState, ReactionSummary, UiMessage, User } from "../contract";
import { useMessenger } from "../messenger";
import { useLocale } from "../../i18n";
import { useStrings } from "./copy";
import { formatClock, messagePreview, truncate } from "./format";
import { AttachmentItem } from "./Attachment";
import { Avatar, Popover, PopoverItem } from "./primitives";

export const QUICK_REACTIONS = ["💜", "👍", "🔥", "😂"];

const URL_PATTERN = /(https?:\/\/[^\s<>"']+)/g;

function renderText(body: string) {
  const parts = body.split(URL_PATTERN);
  return parts.map((part, index) => {
    if (index % 2 === 1) {
      return (
        <a key={`${index}-${part}`} href={part} target="_blank" rel="noopener noreferrer nofollow">
          {part}
        </a>
      );
    }
    return <span key={`${index}-${part}`}>{part}</span>;
  });
}

type Delivery = "sending" | "failed" | "sent" | "delivered" | "read";

function deliveryState(
  message: UiMessage,
  meId: Id | null,
  otherMemberIds: Id[],
  receipts: MessageReceiptState | undefined,
  sending: boolean,
  failed: boolean,
): Delivery {
  if (message._pending || sending) return "sending";
  if (message._failed || failed) return "failed";
  if (!meId) return "sent";
  const state = receipts;
  if (state?.complete && otherMemberIds.length > 0) {
    const byUser = new Map(state.items.map((item) => [item.userId, item]));
    const every = (check: (item: { userId: Id; deliveredAt: string; readAt: string | null }) => boolean) =>
      otherMemberIds.every((id) => {
        const item = byUser.get(id);
        return item ? check(item) : false;
      });
    if (every((item) => item.readAt != null)) return "read";
    if (every((item) => Boolean(item.deliveredAt))) return "delivered";
  }
  return "sent";
}

function DeliveryTicks({ state, onRetry }: { state: Delivery; onRetry: () => void }) {
  const s = useStrings();
  const label = s.conversation.delivery[state];
  if (state === "sending") {
    return (
      <span className="delivery delivery--sending" title={label}>
        <Clock size={14} aria-hidden="true" />
        <span className="sr-only">{label}</span>
      </span>
    );
  }
  if (state === "failed") {
    return (
      <button type="button" className="delivery delivery--failed" onClick={onRetry} title={label}>
        <CircleAlert size={14} aria-hidden="true" />
        <span>{s.conversation.retrySend}</span>
        <span className="sr-only">{label}</span>
      </button>
    );
  }
  if (state === "read") {
    return (
      <span className="delivery delivery--read" title={label}>
        <CheckCheck size={15} aria-hidden="true" />
        <span className="sr-only">{label}</span>
      </span>
    );
  }
  if (state === "delivered") {
    return (
      <span className="delivery delivery--delivered" title={label}>
        <CheckCheck size={15} aria-hidden="true" />
        <span className="sr-only">{label}</span>
      </span>
    );
  }
  return (
    <span className="delivery delivery--sent" title={label}>
      <Check size={14} aria-hidden="true" />
      <span className="sr-only">{label}</span>
    </span>
  );
}

type BubbleProps = {
  message: UiMessage;
  chat: Chat;
  members: ChatMember[];
  me: User | null;
  messagesById: Map<Id, UiMessage>;
  reactions: ReactionSummary[];
  receipts: MessageReceiptState | undefined;
  grouped: boolean;
  showSenderName: boolean;
  onReply: (message: UiMessage) => void;
  onJumpTo: (messageId: Id) => void;
  onRetry: (message: UiMessage) => void;
  onNotify: (text: string, tone?: "notice" | "error") => void;
};

export function MessageBubble({
  message,
  chat,
  members,
  me,
  messagesById,
  reactions,
  receipts,
  grouped,
  showSenderName,
  onReply,
  onJumpTo,
  onRetry,
  onNotify,
}: BubbleProps) {
  const s = useStrings();
  const { locale } = useLocale();
  const api = useMessenger();
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [quick, setQuick] = useState<{ x: number; y: number } | null>(null);
  const [editing, setEditing] = useState(false);
  const [editText, setEditText] = useState(message.body ?? "");
  const [saving, setSaving] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [copied, setCopied] = useState(false);
  const bubbleRef = useRef<HTMLDivElement | null>(null);

  const own = Boolean(me && message.sender.id === me.id);
  const deleted = Boolean(message.deletedAt);
  const pending = Boolean(message._pending) || api.outbox[message.clientNonce] === "sending";
  const failed = Boolean(message._failed) || api.outbox[message.clientNonce] === "failed";
  const otherMemberIds = useMemo(
    () => members.map((member) => member.user.id).filter((id) => id !== me?.id),
    [members, me?.id],
  );
  const delivery = own ? deliveryState(message, me?.id ?? null, otherMemberIds, receipts, pending, failed) : null;
  const replyTarget = message.replyToMessageId ? messagesById.get(message.replyToMessageId) : undefined;

  const canEdit = own && !deleted && message.kind === "text" && message.body !== null;
  const canDelete = !deleted && (own || chat.role === "owner" || chat.role === "admin");

  const openMenuAt = (x: number, y: number) => {
    setQuick(null);
    setMenu({ x, y });
  };

  const onContextMenu = (event: MouseEvent) => {
    event.preventDefault();
    openMenuAt(event.clientX, event.clientY);
  };

  const copyText = () => {
    const text = message.body ?? "";
    if (!text) return;
    const done = () => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
      onNotify(s.conversation.actionCopied);
    };
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(text).then(done, () => onNotify(s.conversation.copyFailed, "error"));
    } else {
      onNotify(s.conversation.copyFailed, "error");
    }
    setMenu(null);
  };

  const startEdit = () => {
    setEditText(message.body ?? "");
    setEditing(true);
    setMenu(null);
  };

  const saveEdit = () => {
    const next = editText.trim();
    if (!next || saving) return;
    setSaving(true);
    api
      .editMessage(message.id, next, message.revision)
      .then(
        () => setEditing(false),
        () => onNotify(s.conversation.actionSave + " — " + s.toasts.errorTitle.toLowerCase(), "error"),
      )
      .finally(() => setSaving(false));
  };

  const remove = () => {
    setConfirmDelete(false);
    setMenu(null);
    api.deleteMessage(message.id).catch(() => onNotify(s.toasts.errorTitle, "error"));
  };

  const toggleReaction = (emoji: string) => {
    setQuick(null);
    api.toggleReaction(message.id, emoji).catch(() => onNotify(s.toasts.errorTitle, "error"));
  };

  const jumpToReply = () => {
    if (!message.replyToMessageId) return;
    if (messagesById.has(message.replyToMessageId)) onJumpTo(message.replyToMessageId);
    else onNotify(s.conversation.replyUnavailable);
  };

  const replyPreview = replyTarget
    ? replyTarget.deletedAt
      ? s.conversation.deleted
      : messagePreview(replyTarget.body, replyTarget.attachments, {
          image: s.conversation.imageLabel,
          video: s.conversation.videoLabel,
          voice: s.conversation.voiceLabel,
          audio: s.conversation.audioLabel,
          file: s.conversation.fileLabel,
        })
    : message.replyToMessageId
      ? s.conversation.replyUnavailable
      : "";

  const replyAuthor = replyTarget
    ? replyTarget.sender.id === me?.id
      ? s.conversation.you
      : replyTarget.sender.displayName
    : "";

  return (
    <div
      className={`msg-row${own ? " msg-row--own" : " msg-row--other"}${grouped ? " msg-row--grouped" : ""}${deleted ? " msg-row--deleted" : ""}`}
      data-testid={`message-row-${message.id}`}
      id={`msg-${message.id}`}
    >
      {!own ? (
        <span className="msg-row__gutter">
          {grouped ? null : <Avatar name={message.sender.displayName} path={message.sender.avatarPath ?? null} size="xs" />}
        </span>
      ) : null}
      <div className="msg-row__stack">
        {showSenderName && !own ? <span className="msg-row__sender">{message.sender.displayName}</span> : null}
        {message.isPinned && !deleted ? (
          <span className="msg-row__pinned">
            <Pin size={12} aria-hidden="true" /> {s.conversation.pinned}
          </span>
        ) : null}
        <div
          ref={bubbleRef}
          className={`bubble${own ? " bubble--own" : ""}${deleted ? " bubble--deleted" : ""}`}
          onContextMenu={onContextMenu}
        >
          {message.forwardedFrom && !deleted ? (
            <p className="bubble__forwarded">
              <CornerUpLeft size={12} aria-hidden="true" />{" "}
              {s.conversation.forwarded(message.forwardedFrom.senderDisplayName)}
            </p>
          ) : null}

          {replyPreview && !deleted ? (
            <button
              type="button"
              className={`bubble__reply${replyTarget ? "" : " is-missing"}`}
              onClick={jumpToReply}
              title={replyTarget ? undefined : s.conversation.replyUnavailable}
            >
              <span className="bubble__reply-author">{replyAuthor || s.conversation.replyUnavailable}</span>
              <span className="bubble__reply-text">{truncate(replyPreview, 120)}</span>
            </button>
          ) : null}

          {!deleted
            ? message.attachments.map((attachment) => <AttachmentItem key={attachment.id} attachment={attachment} />)
            : null}

          {deleted ? (
            <p className="bubble__deleted">{s.conversation.deleted}</p>
          ) : editing ? (
            <div className="bubble__edit">
              <textarea
                className="bubble__edit-input"
                value={editText}
                rows={Math.min(6, Math.max(1, editText.split("\n").length))}
                aria-label={s.conversation.actionEdit}
                onChange={(event) => setEditText(event.target.value)}
                autoFocus
              />
              <div className="bubble__edit-actions">
                <button type="button" className="button button--ghost button--sm" onClick={() => setEditing(false)}>
                  {s.conversation.actionCancel}
                </button>
                <button
                  type="button"
                  className="button button--primary button--sm"
                  onClick={saveEdit}
                  disabled={saving || editText.trim().length === 0}
                >
                  {s.conversation.actionSave}
                </button>
              </div>
            </div>
          ) : message.body ? (
            <p className="bubble__text">{renderText(message.body)}</p>
          ) : null}

          {!deleted && message.transcript ? (
            <div className="bubble__transcript">
              <span className="bubble__transcript-label">{s.conversation.transcriptLabel}</span>
              <span>{truncate(message.transcript, 400)}</span>
            </div>
          ) : null}

          {!deleted && reactions.length > 0 ? (
            <div className="reactions" role="group" aria-label={s.conversation.reactionAdd}>
              {reactions.map((reaction) => (
                <button
                  key={reaction.emoji}
                  type="button"
                  className={`reaction${reaction.reactedByMe ? " is-mine" : ""}`}
                  aria-pressed={reaction.reactedByMe}
                  aria-label={s.conversation.reactionAria(reaction.emoji, reaction.count)}
                  onClick={() => toggleReaction(reaction.emoji)}
                >
                  <span aria-hidden="true">{reaction.emoji}</span>
                  <span className="reaction__count">{reaction.count}</span>
                </button>
              ))}
            </div>
          ) : null}

          <div className="bubble__meta">
            {copied ? <span className="bubble__copied">{s.conversation.actionCopied}</span> : null}
            {message.editedAt && !deleted ? <span className="bubble__edited">{s.conversation.edited}</span> : null}
            <time className="bubble__time" dateTime={message.createdAt}>
              {formatClock(message.createdAt, locale)}
            </time>
            {delivery ? <DeliveryTicks state={delivery} onRetry={() => onRetry(message)} /> : null}
            {!deleted ? (
              <span className="bubble__actions">
                <button
                  type="button"
                  className="bubble__action"
                  aria-label={s.conversation.reactionAdd}
                  title={s.conversation.reactionAdd}
                  onClick={(event) => {
                    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
                    setMenu(null);
                    setQuick({ x: rect.left, y: rect.top });
                  }}
                >
                  <Plus size={14} aria-hidden="true" />
                </button>
                <button
                  type="button"
                  className="bubble__action"
                  aria-label={s.conversation.messageMenu}
                  title={s.conversation.actionsTitle}
                  onClick={(event) => {
                    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
                    openMenuAt(Math.min(rect.left, window.innerWidth - 240), rect.bottom);
                  }}
                >
                  <Ellipsis size={15} aria-hidden="true" />
                </button>
              </span>
            ) : null}
          </div>
        </div>
      </div>

      <Popover
        open={Boolean(menu)}
        x={menu?.x ?? 0}
        y={menu?.y ?? 0}
        onClose={() => setMenu(null)}
        label={s.conversation.actionsTitle}
      >
        {confirmDelete ? (
          <div className="popover__confirm">
            <p>{s.conversation.actionDeleteConfirm}</p>
            <div className="popover__confirm-actions">
              <button type="button" className="button button--ghost button--sm" onClick={() => setConfirmDelete(false)}>
                {s.conversation.actionDeleteNo}
              </button>
              <button type="button" className="button button--danger button--sm" onClick={remove}>
                {s.conversation.actionDeleteYes}
              </button>
            </div>
          </div>
        ) : (
          <>
            <PopoverItem
              onSelect={() => {
                onReply(message);
                setMenu(null);
              }}
            >
              <Reply size={15} aria-hidden="true" /> {s.conversation.actionReply}
            </PopoverItem>
            {message.body ? (
              <PopoverItem onSelect={copyText}>
                <Copy size={15} aria-hidden="true" /> {s.conversation.actionCopy}
              </PopoverItem>
            ) : null}
            {canEdit ? (
              <PopoverItem onSelect={startEdit}>
                <Pencil size={15} aria-hidden="true" /> {s.conversation.actionEdit}
              </PopoverItem>
            ) : null}
            {canDelete ? (
              <PopoverItem
                danger
                onSelect={() => {
                  setConfirmDelete(true);
                }}
              >
                <Trash size={15} aria-hidden="true" /> {s.conversation.actionDelete}
              </PopoverItem>
            ) : null}
          </>
        )}
      </Popover>

      <Popover
        open={Boolean(quick)}
        x={quick?.x ?? 0}
        y={quick?.y ?? 0}
        onClose={() => setQuick(null)}
        label={s.conversation.reactionAdd}
      >
        <div className="quick-reactions">
          {QUICK_REACTIONS.map((emoji) => (
            <button
              key={emoji}
              type="button"
              className="quick-reactions__emoji"
              onClick={() => toggleReaction(emoji)}
              aria-label={s.conversation.reactionAria(emoji, 0)}
            >
              <span aria-hidden="true">{emoji}</span>
            </button>
          ))}
        </div>
      </Popover>
    </div>
  );
}
