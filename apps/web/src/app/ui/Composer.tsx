/** Composer: auto-growing textarea, honest uploads with progress, reply preview,
 *  drafts and typing signals. Media truth is stated next to the controls. */
import { useEffect, useLayoutEffect, useRef, useState, type ChangeEvent, type DragEvent, type KeyboardEvent } from "react";
import { LoaderCircle, Paperclip, Send, ShieldAlert, X } from "lucide-react";
import type { Attachment, Chat, Id, UiMessage } from "../contract";
import { LuxoraApiError } from "../contract";
import { useMessenger } from "../messenger";
import { useLocale } from "../../i18n";
import { useStrings } from "./copy";
import { countCodePoints, formatFileSize, truncate } from "./format";
import { IconButton } from "./primitives";

export type ReplyTarget = { id: Id; message: UiMessage | null; author: string; preview: string };

type ComposerProps = {
  chat: Chat;
  reply: ReplyTarget | null;
  onCancelReply: () => void;
  onNotify: (text: string, tone?: "notice" | "error") => void;
};

type Upload = { fileName: string; progress: number };

export function Composer({ chat, reply, onCancelReply, onNotify }: ComposerProps) {
  const s = useStrings();
  const { locale } = useLocale();
  const api = useMessenger();
  const draft = api.drafts[chat.id];
  const [text, setText] = useState(draft?.text ?? "");
  const [busy, setBusy] = useState(false);
  const [upload, setUpload] = useState<Upload | null>(null);
  const [draftRestored, setDraftRestored] = useState(false);
  const [overLimit, setOverLimit] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const typingTimer = useRef<number | null>(null);
  const restoredTimer = useRef<number | null>(null);

  const maxCodePoints = api.capabilities?.limits.maxMessageCodePoints ?? 10_000;
  const length = countCodePoints(text);
  const readOnly = chat.kind === "channel" && chat.role === "member";
  const uploading = upload !== null;
  const offline = api.connection === "offline" || api.connection === "reconnecting";
  const canSend = !readOnly && !uploading && !busy && text.trim().length > 0 && length <= maxCodePoints;

  const clearTyping = () => {
    if (typingTimer.current) {
      window.clearTimeout(typingTimer.current);
      typingTimer.current = null;
    }
    api.setTyping(chat.id, false);
  };

  useEffect(() => {
    const initial = api.drafts[chat.id]?.text ?? "";
    setText(initial);
    setOverLimit(false);
    if (initial.trim()) {
      setDraftRestored(true);
      if (restoredTimer.current) window.clearTimeout(restoredTimer.current);
      restoredTimer.current = window.setTimeout(() => setDraftRestored(false), 4000);
    } else {
      setDraftRestored(false);
    }
    return () => {
      if (typingTimer.current) window.clearTimeout(typingTimer.current);
      if (restoredTimer.current) window.clearTimeout(restoredTimer.current);
      api.setTyping(chat.id, false);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chat.id]);

  useLayoutEffect(() => {
    const node = textareaRef.current;
    if (!node) return;
    node.style.height = "auto";
    node.style.height = `${Math.min(node.scrollHeight, 168)}px`;
  }, [text]);

  const persistDraft = (value: string, replyId: Id | null) => {
    api.setDraft(chat.id, value, replyId);
  };

  const signalTyping = () => {
    api.setTyping(chat.id, true);
    if (typingTimer.current) window.clearTimeout(typingTimer.current);
    typingTimer.current = window.setTimeout(() => {
      typingTimer.current = null;
      api.setTyping(chat.id, false);
    }, 2600);
  };

  const onChange = (event: ChangeEvent<HTMLTextAreaElement>) => {
    const value = event.target.value;
    setText(value);
    setOverLimit(countCodePoints(value) > maxCodePoints);
    persistDraft(value, reply?.id ?? null);
    if (value.trim()) signalTyping();
    else clearTyping();
  };

  const resetAfterSend = () => {
    setText("");
    persistDraft("", null);
    onCancelReply();
    clearTyping();
    window.requestAnimationFrame(() => textareaRef.current?.focus());
  };

  const send = async () => {
    if (!canSend) return;
    const body = text.trim();
    const replyId = reply?.id ?? null;
    setBusy(true);
    setText("");
    persistDraft(body, replyId);
    try {
      await api.sendMessage({ chatId: chat.id, body, replyToMessageId: replyId });
      resetAfterSend();
    } catch (error) {
      setText(body);
      persistDraft(body, replyId);
      onNotify(error instanceof LuxoraApiError ? error.message : s.toasts.errorTitle, "error");
    } finally {
      setBusy(false);
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      void send();
    }
    if (event.key === "Escape" && reply) {
      event.preventDefault();
      onCancelReply();
    }
  };

  const onFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    const maxBytes = api.capabilities?.limits.maxAttachmentBytes ?? 100 * 1024 * 1024;
    if (file.size > maxBytes) {
      onNotify(s.composer.uploadTooLarge(formatFileSize(maxBytes, locale)), "error");
      return;
    }
    setUpload({ fileName: file.name, progress: 0 });
    try {
      const uploaded: Attachment = await api.uploadFile(file, (fraction) => {
        setUpload({ fileName: file.name, progress: Math.round(Math.min(1, Math.max(0, fraction)) * 100) });
      });
      const body = text.trim();
      await api.sendMessage({
        chatId: chat.id,
        body,
        replyToMessageId: reply?.id ?? null,
        attachmentIds: [uploaded.id],
      });
      resetAfterSend();
    } catch (error) {
      onNotify(error instanceof LuxoraApiError ? error.message : s.composer.uploadFailed, "error");
    } finally {
      setUpload(null);
    }
  };

  const onDragOver = (event: DragEvent) => {
    event.preventDefault();
  };

  if (readOnly) {
    return (
      <div className="composer composer--readonly">
        <p className="composer__readonly-note">
          <ShieldAlert size={15} aria-hidden="true" /> {s.composer.sentReadOnly}
        </p>
      </div>
    );
  }

  return (
    <div className="composer" onDragOver={onDragOver}>
      {reply ? (
        <div className="reply-preview" data-testid="reply-preview">
          <span className="reply-preview__bar" aria-hidden="true" />
          <span className="reply-preview__body">
            <span className="reply-preview__author">{reply.author}</span>
            <span className="reply-preview__text">{truncate(reply.preview, 140)}</span>
          </span>
          <IconButton label={s.composer.replyCancel} size="sm" onClick={onCancelReply}>
            <X size={16} aria-hidden="true" />
          </IconButton>
        </div>
      ) : null}

      {upload ? (
        <div className="upload-progress" role="status" aria-live="polite">
          <span className="upload-progress__label">
            <LoaderCircle size={15} className="spin" aria-hidden="true" />
            {s.composer.attachPreview(upload.fileName)} · {s.composer.uploadProgress(upload.progress)}
          </span>
          <span
            className="upload-progress__track"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={upload.progress}
            aria-label={s.composer.attach}
          >
            <span className="upload-progress__fill" style={{ width: `${upload.progress}%` }} />
          </span>
        </div>
      ) : null}

      {draftRestored ? (
        <p className="composer__draft-note" role="status">
          {s.composer.draftRestored}
        </p>
      ) : null}

      <div className="composer__box">
        <input
          ref={fileInputRef}
          type="file"
          className="composer__file-input"
          tabIndex={-1}
          aria-hidden="true"
          onChange={(event) => void onFile(event)}
        />
        <IconButton
          label={s.composer.attach}
          size="sm"
          className="composer__attach"
          testId="attach-button"
          aria-label={s.composer.attach}
          onClick={() => fileInputRef.current?.click()}
          disabled={uploading || busy}
        >
          <Paperclip size={19} aria-hidden="true" />
        </IconButton>

        <textarea
          ref={textareaRef}
          id="message-input"
          data-testid="message-input"
          className="composer__input"
          placeholder={reply ? s.composer.placeholderReply : s.composer.placeholder}
          aria-label={s.composer.placeholder}
          rows={1}
          value={text}
          onChange={onChange}
          onKeyDown={onKeyDown}
          onBlur={clearTyping}
          autoComplete="off"
          spellCheck
        />

        <button
          type="button"
          className="composer__send"
          data-testid="message-send"
          aria-label={s.composer.sendAria}
          title={s.composer.send}
          onClick={() => void send()}
          disabled={!canSend}
        >
          {busy ? <LoaderCircle size={18} className="spin" aria-hidden="true" /> : <Send size={18} aria-hidden="true" />}
          <span className="composer__send-label">{s.composer.send}</span>
        </button>
      </div>

      <div className="composer__meta">
        <span className="composer__note">
          <ShieldAlert size={13} aria-hidden="true" /> {s.composer.note(Boolean(api.capabilities?.features.calls))}
        </span>
        <span className="composer__hints">
          {offline ? <span className="composer__offline">{s.composer.offline}</span> : null}
          {length > Math.floor(maxCodePoints * 0.85) ? (
            <span className={`composer__counter${overLimit ? " is-over" : ""}`}>
              {overLimit ? s.composer.charOver(length - maxCodePoints) : s.composer.charLeft(maxCodePoints - length)}
            </span>
          ) : null}
          <span className="composer__shortcut">{s.composer.shortcutHint}</span>
        </span>
      </div>
    </div>
  );
}
