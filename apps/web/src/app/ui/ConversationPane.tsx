/** Right pane: header, message history and composer for the active chat. */
import { useEffect, useMemo, useState } from "react";
import { ArrowLeft, Phone, Video } from "lucide-react";
import { LuxoraApiError } from "../contract";
import type { Chat, UiMessage } from "../contract";
import { useMessenger } from "../messenger";
import { useStrings } from "./copy";
import { Avatar } from "./primitives";
import { MessageList } from "./MessageList";
import { Composer, type ReplyTarget } from "./Composer";
import { messagePreview } from "./format";

type ConversationPaneProps = {
  onNotify: (text: string, tone?: "notice" | "error") => void;
  onBack: () => void;
};

export function ConversationPane({ onNotify, onBack }: ConversationPaneProps) {
  const s = useStrings();
  const api = useMessenger();
  const chat = api.activeChat;
  const [reply, setReply] = useState<ReplyTarget | null>(null);
  const messages = chat ? (api.messages[chat.id] ?? []) : [];
  const draftReplyId = chat ? (api.drafts[chat.id]?.replyToMessageId ?? null) : null;
  const members = chat ? (api.members[chat.id] ?? []) : [];

  const otherMember = useMemo(() => {
    if (!chat || chat.kind !== "direct" || !api.user) return null;
    return members.find((member) => member.user.id !== api.user?.id)?.user ?? null;
  }, [chat, members, api.user]);

  useEffect(() => {
    setReply(null);
  }, [chat?.id]);

  useEffect(() => {
    if (!chat || !draftReplyId) return;
    const target = messages.find((message) => message.id === draftReplyId);
    const author = target
      ? target.sender.id === api.user?.id
        ? s.conversation.you
        : target.sender.displayName
      : s.conversation.replyUnavailable;
    const preview = target
      ? target.deletedAt
        ? s.conversation.deleted
        : messagePreview(target.body, target.attachments, {
            image: s.conversation.imageLabel,
            video: s.conversation.videoLabel,
            voice: s.conversation.voiceLabel,
            audio: s.conversation.audioLabel,
            file: s.conversation.fileLabel,
          })
      : s.conversation.replyUnavailable;
    setReply({ id: draftReplyId, message: target ?? null, author, preview });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chat?.id, draftReplyId]);

  const makeReply = (message: UiMessage) => {
    const author = message.sender.id === api.user?.id ? s.conversation.you : message.sender.displayName;
    const preview = message.deletedAt
      ? s.conversation.deleted
      : messagePreview(message.body, message.attachments, {
          image: s.conversation.imageLabel,
          video: s.conversation.videoLabel,
          voice: s.conversation.voiceLabel,
          audio: s.conversation.audioLabel,
          file: s.conversation.fileLabel,
        });
    setReply({ id: message.id, message, author, preview: preview || s.conversation.deleted });
    if (chat) api.setDraft(chat.id, api.drafts[chat.id]?.text ?? "", message.id);
    window.requestAnimationFrame(() => document.getElementById("message-input")?.focus());
  };

  const cancelReply = () => {
    setReply(null);
    if (chat) api.setDraft(chat.id, api.drafts[chat.id]?.text ?? "", null);
  };

  const attemptCall = (mode: "audio" | "video") => {
    if (!chat) return;
    const callsEnabled = Boolean(api.capabilities?.features.calls);
    const invoke = async () => {
      try {
        await api.startCall(chat.id, mode);
        onNotify(callsEnabled ? s.toasts.callStarted : s.toasts.callAttempt);
      } catch (error) {
        const message = error instanceof LuxoraApiError ? error.message : s.toasts.callError;
        onNotify(`${s.toasts.callAttempt} ${message}`, "error");
      }
    };
    void invoke();
  };

  if (!chat) {
    return (
      <section className="conversation conversation--empty" data-testid="conversation" aria-label={s.conversation.emptyTitle}>
        <div className="conversation-empty">
          <img className="conversation-empty__logo" src="/logo.png" alt="" width={64} height={64} />
          <h1 className="conversation-empty__title">{s.conversation.emptyTitle}</h1>
          <p className="conversation-empty__lead">{s.conversation.emptyLead}</p>
          <p className="conversation-empty__trust">{s.app.trustChip}</p>
        </div>
      </section>
    );
  }

  const title = chat.title || (otherMember?.displayName ?? s.conversation.kind.direct);
  const presence = otherMember ? api.presence[otherMember.id] ?? otherMember.presence ?? "offline" : null;
  const muted = chat.mutedUntil !== null && new Date(chat.mutedUntil).getTime() > Date.now();
  const callsEnabled = Boolean(api.capabilities?.features.calls);
  const callsAvailableInChat = chat.kind !== "channel";
  const roleLabel = s.conversation.role[chat.role];

  const subtitle =
    chat.kind === "direct"
      ? presence === "online"
        ? s.conversation.presence.online
        : s.conversation.presence.offline
      : s.conversation.subtitleGroup(s.conversation.members(chat.memberCount), roleLabel);

  return (
    <section className="conversation" data-testid="conversation" aria-label={title}>
      <header className="conversation-header" data-testid="conversation-header">
        <button type="button" className="conversation-header__back" aria-label={s.conversation.back} onClick={onBack}>
          <ArrowLeft size={20} aria-hidden="true" />
        </button>
        <Avatar
          name={title}
          path={chat.avatarUrl?.startsWith("/") ? chat.avatarUrl : null}
          size="sm"
          presence={chat.kind === "direct" ? presence : null}
        />
        <div className="conversation-header__identity">
          <h1 className="conversation-header__title" data-testid="chat-title" title={title}>
            {title}
          </h1>
          <p className="conversation-header__subtitle">
            {subtitle}
            {!callsEnabled && callsAvailableInChat ? (
              <span className="conversation-header__calls-inline"> · {s.conversation.callsChip}</span>
            ) : null}
            {muted ? ` · ${s.sidebar.muted}` : ""}
            {chat.unreadCount > 0 ? ` · ${s.sidebar.unreadAria(chat.unreadCount)}` : ""}
          </p>
        </div>
        <div className="conversation-header__actions">
          {callsAvailableInChat ? (
            <>
              {!callsEnabled ? <span className="conversation-header__calls-note">{s.conversation.callsChip}</span> : null}
              <button
                type="button"
                className="icon-button icon-button--md icon-button--ghost"
                aria-label={callsEnabled ? s.conversation.audioCall : s.conversation.callAria(s.conversation.audioCall)}
                title={callsEnabled ? s.conversation.audioCall : s.calls.mediaUnavailableNote}
                onClick={() => attemptCall("audio")}
              >
                <Phone size={18} aria-hidden="true" />
              </button>
              <button
                type="button"
                className="icon-button icon-button--md icon-button--ghost"
                aria-label={callsEnabled ? s.conversation.videoCall : s.conversation.callAria(s.conversation.videoCall)}
                title={callsEnabled ? s.conversation.videoCall : s.calls.mediaUnavailableNote}
                onClick={() => attemptCall("video")}
              >
                <Video size={18} aria-hidden="true" />
              </button>
            </>
          ) : (
            <span className="conversation-header__calls-note">{s.conversation.channelCalls}</span>
          )}
        </div>
      </header>

      <MessageList chat={chat} members={members} me={api.user} onReply={makeReply} onNotify={onNotify} />

      <Composer chat={chat} reply={reply} onCancelReply={cancelReply} onNotify={onNotify} />
    </section>
  );
}
