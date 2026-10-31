/** New chat, message requests and profile/settings dialogs. */
import { useEffect, useRef, useState, type FormEvent } from "react";
import { AtSign, Check, LogOut, Search, UserPlus } from "lucide-react";
import { LuxoraApiError } from "../contract";
import type { Id, MessageRequest, PublicProfile } from "../contract";
import { useMessenger } from "../messenger";
import { useLocale } from "../../i18n";
import { useStrings } from "./copy";
import { Avatar, Modal, Spinner } from "./primitives";
import { countCodePoints, formatClock, formatFileSize } from "./format";

type Notify = (text: string, tone?: "notice" | "error") => void;

function errorText(error: unknown, fallback: string, errors?: Record<string, string>, unknown?: (code: string) => string) {
  if (error instanceof LuxoraApiError) {
    return (errors && errors[error.code]) || (unknown ? unknown(error.code) : error.message);
  }
  return fallback;
}

/* -------------------------------------------------------------- new chat */

export function NewChatDialog({ open, onClose, onNotify }: { open: boolean; onClose: () => void; onNotify: Notify }) {
  const s = useStrings();
  const api = useMessenger();
  const [username, setUsername] = useState("");
  const [looking, setLooking] = useState(false);
  const [profile, setProfile] = useState<PublicProfile | null>(null);
  const [lookupError, setLookupError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);
  const [requestMode, setRequestMode] = useState(false);
  const [requestText, setRequestText] = useState("");
  const [requestSending, setRequestSending] = useState(false);
  const [requestSent, setRequestSent] = useState(false);
  const [requestError, setRequestError] = useState<string | null>(null);
  const fieldRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!open) return;
    setUsername("");
    setProfile(null);
    setLookupError(null);
    setStartError(null);
    setRequestMode(false);
    setRequestText("");
    setRequestSent(false);
    setRequestError(null);
  }, [open]);

  const lookup = async (event?: FormEvent) => {
    event?.preventDefault();
    const value = username.trim();
    if (!value || looking) return;
    setLooking(true);
    setLookupError(null);
    setProfile(null);
    setStartError(null);
    setRequestMode(false);
    setRequestSent(false);
    try {
      const found = await api.lookupUser(value);
      if (!found) {
        setLookupError(s.dialogs.newChat.notFound(value));
      } else {
        setProfile(found);
      }
    } catch (error) {
      setLookupError(errorText(error, s.dialogs.newChat.error, s.auth.errors, s.auth.errorUnknown));
    } finally {
      setLooking(false);
    }
  };

  const start = async () => {
    if (!profile || starting) return;
    setStarting(true);
    setStartError(null);
    try {
      const chat = await api.startDirectChat(profile.id);
      await api.loadChats();
      await api.openChat(chat.id);
      onClose();
    } catch (error) {
      if (error instanceof LuxoraApiError && (error.code === "FORBIDDEN" || error.code === "NOT_FOUND")) {
        setRequestMode(true);
      } else {
        setStartError(errorText(error, s.dialogs.newChat.startError, s.auth.errors, s.auth.errorUnknown));
      }
    } finally {
      setStarting(false);
    }
  };

  const sendRequest = async (event?: FormEvent) => {
    event?.preventDefault();
    if (!profile || requestSending) return;
    const text = requestText.trim();
    const max = api.capabilities?.limits.maxMessageRequestCodePoints ?? 1000;
    if (!text) {
      setRequestError(s.dialogs.newChat.requestEmpty);
      return;
    }
    if (countCodePoints(text) > max) {
      setRequestError(s.dialogs.newChat.requestTooLong(max));
      return;
    }
    setRequestSending(true);
    setRequestError(null);
    try {
      await api.sendMessageRequest(profile.id, text);
      setRequestSent(true);
      onNotify(s.dialogs.newChat.requestSent);
      void api.loadRequests();
    } catch (error) {
      setRequestError(errorText(error, s.dialogs.newChat.requestError, s.auth.errors, s.auth.errorUnknown));
    } finally {
      setRequestSending(false);
    }
  };

  const charCount = countCodePoints(requestText);
  const maxRequest = api.capabilities?.limits.maxMessageRequestCodePoints ?? 1000;

  return (
    <Modal open={open} onClose={onClose} title={s.dialogs.newChat.title} testId="new-chat-dialog">
      <p className="dialog-lead">{s.dialogs.newChat.lead}</p>
      <form className="lookup-row" onSubmit={(event) => void lookup(event)}>
        <label className="field field--inline">
          <span className="field__label">{s.dialogs.newChat.usernameLabel}</span>
          <span className="field__control">
            <AtSign size={16} aria-hidden="true" />
            <input
              ref={fieldRef}
              data-testid="new-chat-username"
              data-autofocus
              value={username}
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              placeholder={s.dialogs.newChat.usernamePlaceholder}
              onChange={(event) => setUsername(event.target.value)}
              aria-label={s.dialogs.newChat.usernameLabel}
            />
          </span>
        </label>
        <button type="submit" className="button button--primary" data-testid="new-chat-lookup" disabled={looking || !username.trim()}>
          {looking ? <Spinner /> : <Search size={16} aria-hidden="true" />}
          {looking ? s.dialogs.newChat.lookingUp : s.dialogs.newChat.lookup}
        </button>
      </form>

      {lookupError ? (
        <p className="dialog-error" role="alert">
          {lookupError}
        </p>
      ) : null}

      {profile ? (
        <div className="profile-card">
          <Avatar name={profile.displayName} path={profile.avatarPath ?? null} size="lg" />
          <div className="profile-card__body">
            <p className="profile-card__name">{profile.displayName}</p>
            <p className="profile-card__username">@{profile.username}</p>
            {profile.bio ? <p className="profile-card__bio">{profile.bio}</p> : null}
          </div>
          <button
            type="button"
            className="button button--primary"
            data-testid="new-chat-start"
            onClick={() => void start()}
            disabled={starting || requestSent}
          >
            {starting ? <Spinner /> : <UserPlus size={16} aria-hidden="true" />}
            {starting ? s.dialogs.newChat.starting : s.dialogs.newChat.write}
          </button>
        </div>
      ) : null}

      {startError ? (
        <p className="dialog-error" role="alert">
          {startError}
        </p>
      ) : null}

      {requestMode ? (
        <form className="request-block" onSubmit={(event) => void sendRequest(event)}>
          <h3 className="request-block__title">{s.dialogs.newChat.requestTitle}</h3>
          <p className="request-block__lead">
            {s.dialogs.newChat.forbiddenNotice} {s.dialogs.newChat.requestLead}
          </p>
          {requestSent ? (
            <p className="request-block__sent" role="status">
              <Check size={16} aria-hidden="true" /> {s.dialogs.newChat.requestSent}
            </p>
          ) : (
            <>
              <textarea
                data-testid="message-request-text"
                className="request-block__input"
                value={requestText}
                rows={3}
                maxLength={maxRequest * 2}
                placeholder={s.dialogs.newChat.requestPlaceholder}
                aria-label={s.dialogs.newChat.requestTitle}
                onChange={(event) => setRequestText(event.target.value)}
              />
              <div className="request-block__meta">
                <span className={charCount > maxRequest ? "is-over" : ""}>
                  {charCount} / {maxRequest}
                </span>
                <button type="submit" className="button button--primary" data-testid="message-request-send" disabled={requestSending || charCount > maxRequest}>
                  {requestSending ? <Spinner /> : null}
                  {requestSending ? s.dialogs.newChat.requestSending : s.dialogs.newChat.requestSend}
                </button>
              </div>
            </>
          )}
          {requestError ? (
            <p className="dialog-error" role="alert">
              {requestError}
            </p>
          ) : null}
        </form>
      ) : null}
    </Modal>
  );
}

/* --------------------------------------------------------- message requests */

export function RequestsDialog({ open, onClose, onNotify }: { open: boolean; onClose: () => void; onNotify: Notify }) {
  const s = useStrings();
  const { locale } = useLocale();
  const api = useMessenger();
  const [busyId, setBusyId] = useState<Id | null>(null);
  const pendingOpenRef = useRef<Set<Id> | null>(null);

  useEffect(() => {
    if (!open) return;
    void api.loadRequests();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    const known = pendingOpenRef.current;
    if (!known) return;
    const created = api.chats.find((chat) => !known.has(chat.id));
    if (!created) return;
    pendingOpenRef.current = null;
    onNotify(s.dialogs.requests.acceptedOpen);
    onClose();
    void api.openChat(created.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api.chats]);

  const accept = async (request: MessageRequest) => {
    if (busyId) return;
    setBusyId(request.id);
    pendingOpenRef.current = new Set(api.chats.map((chat) => chat.id));
    try {
      await api.acceptRequest(request.id);
      await Promise.all([api.loadRequests(), api.loadChats()]);
      window.setTimeout(() => {
        if (pendingOpenRef.current) {
          pendingOpenRef.current = null;
          onNotify(s.dialogs.requests.accepted);
          onClose();
        }
      }, 2500);
    } catch (error) {
      pendingOpenRef.current = null;
      onNotify(errorText(error, s.dialogs.requests.error, s.auth.errors, s.auth.errorUnknown), "error");
    } finally {
      setBusyId(null);
    }
  };

  const decline = async (request: MessageRequest) => {
    if (busyId) return;
    setBusyId(request.id);
    try {
      await api.declineRequest(request.id);
      await api.loadRequests();
      onNotify(s.dialogs.requests.declined);
    } catch (error) {
      onNotify(errorText(error, s.dialogs.requests.error, s.auth.errors, s.auth.errorUnknown), "error");
    } finally {
      setBusyId(null);
    }
  };

  const stateLabel = (request: MessageRequest) => {
    if (request.state === "pending") return s.dialogs.requests.pending;
    if (request.state === "accepted") return s.dialogs.requests.acceptedState;
    if (request.state === "expired") return s.dialogs.requests.expired;
    return s.dialogs.requests.dismissed;
  };

  const renderRequest = (request: MessageRequest) => {
    const incoming = request.direction === "incoming";
    const person = incoming ? request.sender : request.recipient;
    const name = person?.displayName ?? s.dialogs.requests.fromFallback;
    return (
      <li key={request.id} className="request-row">
        <Avatar name={name} path={person?.avatarPath ?? null} size="sm" />
        <div className="request-row__body">
          <p className="request-row__name">
            {name}
            {person ? <span className="request-row__username"> @{person.username}</span> : null}
            <span className={`request-row__state request-row__state--${request.state}`}>{stateLabel(request)}</span>
          </p>
          <p className="request-row__text">{request.body.trim() || s.dialogs.requests.noText}</p>
          <p className="request-row__meta">
            {formatClock(request.createdAt, locale)} · {s.dialogs.requests.expires(formatClock(request.expiresAt, locale))}
          </p>
        </div>
        {request.state === "pending" && incoming ? (
          <div className="request-row__actions">
            <button
              type="button"
              className="button button--primary button--sm"
              onClick={() => void accept(request)}
              disabled={busyId === request.id}
            >
              {busyId === request.id ? <Spinner /> : null}
              {s.dialogs.requests.accept}
            </button>
            <button
              type="button"
              className="button button--ghost button--sm"
              onClick={() => void decline(request)}
              disabled={busyId === request.id}
            >
              {s.dialogs.requests.decline}
            </button>
          </div>
        ) : null}
      </li>
    );
  };

  return (
    <Modal open={open} onClose={onClose} title={s.dialogs.requests.title} testId="requests-dialog">
      {api.requests.loading ? (
        <div className="dialog-state" role="status">
          <Spinner label={s.dialogs.requests.loading} />
          <p>{s.dialogs.requests.loading}</p>
        </div>
      ) : api.requests.error ? (
        <div className="dialog-state">
          <p className="dialog-error">{s.dialogs.requests.error}</p>
          <button type="button" className="button button--ghost" onClick={() => void api.loadRequests()}>
            {s.dialogs.requests.retry}
          </button>
        </div>
      ) : (
        <div className="requests-panel">
          <section aria-labelledby="requests-incoming-title">
            <h3 className="requests-panel__heading" id="requests-incoming-title">
              {s.dialogs.requests.incoming}
            </h3>
            {api.requests.incoming.length === 0 ? (
              <p className="dialog-empty">{s.dialogs.requests.emptyIncoming}</p>
            ) : (
              <ul className="request-list">{api.requests.incoming.map(renderRequest)}</ul>
            )}
          </section>
          <section aria-labelledby="requests-outgoing-title">
            <h3 className="requests-panel__heading" id="requests-outgoing-title">
              {s.dialogs.requests.outgoing}
            </h3>
            {api.requests.outgoing.length === 0 ? (
              <p className="dialog-empty">{s.dialogs.requests.emptyOutgoing}</p>
            ) : (
              <ul className="request-list">{api.requests.outgoing.map(renderRequest)}</ul>
            )}
          </section>
        </div>
      )}
    </Modal>
  );
}

/* ------------------------------------------------------------------ profile */

export function ProfileDialog({ open, onClose, onNotify }: { open: boolean; onClose: () => void; onNotify: Notify }) {
  const s = useStrings();
  const { locale, setLocale } = useLocale();
  const api = useMessenger();
  const [displayName, setDisplayName] = useState(api.user?.displayName ?? "");
  const [bio, setBio] = useState(api.user?.bio ?? "");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [signingOut, setSigningOut] = useState(false);

  useEffect(() => {
    if (!open) return;
    setDisplayName(api.user?.displayName ?? "");
    setBio(api.user?.bio ?? "");
    setSaved(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const dirty = displayName.trim() !== (api.user?.displayName ?? "") || bio.trim() !== (api.user?.bio ?? "");
  const validName = displayName.trim().length > 0 && displayName.trim().length <= 80;

  const save = async () => {
    if (!validName || saving) return;
    setSaving(true);
    setSaved(false);
    try {
      await api.updateProfile({ displayName: displayName.trim(), bio: bio.trim() });
      setSaved(true);
    } catch (error) {
      onNotify(errorText(error, s.dialogs.profile.saveError, s.auth.errors, s.auth.errorUnknown), "error");
    } finally {
      setSaving(false);
    }
  };

  const signOut = async () => {
    if (signingOut) return;
    setSigningOut(true);
    try {
      await api.signOut();
      onClose();
      onNotify(s.toasts.signedOut);
    } catch (error) {
      onNotify(errorText(error, s.toasts.errorTitle, s.auth.errors, s.auth.errorUnknown), "error");
      setSigningOut(false);
    }
  };

  const connectionLabel = s.connection[api.connection];
  const joined = api.user ? new Date(api.user.createdAt) : null;

  return (
    <Modal open={open} onClose={onClose} title={s.dialogs.profile.title} testId="profile-dialog">
      <div className="profile-head">
        <Avatar name={api.user?.displayName ?? s.conversation.you} path={api.user?.avatarPath ?? null} size="lg" />
        <div>
          <p className="profile-head__name">{api.user?.displayName ?? s.conversation.you}</p>
          <p className="profile-head__username">
            <AtSign size={13} aria-hidden="true" />
            {api.user?.username ?? "—"}
          </p>
        </div>
      </div>

      <form
        className="profile-form"
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <label className="field">
          <span className="field__label">{s.dialogs.profile.displayName}</span>
          <span className="field__control">
            <input
              data-testid="profile-edit-name"
              value={displayName}
              maxLength={80}
              onChange={(event) => setDisplayName(event.target.value)}
              aria-label={s.dialogs.profile.displayName}
            />
          </span>
          <span className="field__hint">{s.dialogs.profile.displayNameHint}</span>
        </label>
        <label className="field">
          <span className="field__label">{s.dialogs.profile.bio}</span>
          <span className="field__control field__control--area">
            <textarea
              data-testid="profile-edit-bio"
              value={bio}
              rows={3}
              onChange={(event) => setBio(event.target.value)}
              placeholder={s.dialogs.profile.bioPlaceholder}
              aria-label={s.dialogs.profile.bio}
            />
          </span>
          <span className="field__hint">{s.dialogs.profile.bioHint}</span>
        </label>
        <div className="profile-form__actions">
          <button
            type="submit"
            className="button button--primary"
            data-testid="profile-save"
            disabled={saving || !validName || !dirty}
          >
            {saving ? <Spinner /> : null}
            {saving ? s.dialogs.profile.saving : s.dialogs.profile.save}
          </button>
          {saved ? (
            <span className="profile-form__saved" role="status">
              <Check size={15} aria-hidden="true" /> {s.dialogs.profile.saved}
            </span>
          ) : null}
        </div>
      </form>

      <div className="profile-meta">
        <div>
          <span className="profile-meta__label">{s.dialogs.profile.connection}</span>
          <span className="profile-meta__value">{connectionLabel}</span>
        </div>
        <div>
          <span className="profile-meta__label">{s.dialogs.profile.session}</span>
          <span className="profile-meta__value">
            {api.connection === "online" ? s.connection.online : connectionLabel}
          </span>
        </div>
        {joined ? (
          <div>
            <span className="profile-meta__label">{s.dialogs.profile.joined}</span>
            <span className="profile-meta__value">
              {new Intl.DateTimeFormat(locale, { day: "2-digit", month: "short", year: "numeric" }).format(joined)}
            </span>
          </div>
        ) : null}
      </div>

      <div className="profile-locale">
        <span className="field__label">{s.dialogs.profile.locale}</span>
        <div className="locale-switch" role="group" aria-label={s.dialogs.profile.locale}>
          <button type="button" className={locale === "ru" ? "is-active" : ""} aria-pressed={locale === "ru"} onClick={() => setLocale("ru")}>
            RU
          </button>
          <button type="button" className={locale === "en" ? "is-active" : ""} aria-pressed={locale === "en"} onClick={() => setLocale("en")}>
            EN
          </button>
        </div>
      </div>

      <p className="dialog-trust">{s.dialogs.profile.trustBody}</p>

      <div className="profile-footer">
        <button type="button" className="button button--danger" data-testid="sign-out-button" onClick={() => void signOut()} disabled={signingOut}>
          {signingOut ? <Spinner /> : <LogOut size={16} aria-hidden="true" />}
          {signingOut ? s.dialogs.profile.signingOut : s.dialogs.profile.signOut}
        </button>
        {api.capabilities ? (
          <span className="profile-footer__limits">
            {formatFileSize(api.capabilities.limits.maxAttachmentBytes, locale)}
          </span>
        ) : null}
      </div>
    </Modal>
  );
}
