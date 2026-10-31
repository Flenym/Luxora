/** Call surfaces: honest incoming banner and active-call overlay.
 *  Signaling is real; media is never faked. `call.media` and capabilities decide
 *  what is displayed, and the mute control is explicitly unavailable because the
 *  contract exposes no mute action. */
import { MicOff, Phone, PhoneOff, Video, X } from "lucide-react";
import type { Call, Chat } from "../contract";
import { useMessenger } from "../messenger";
import { useStrings } from "./copy";

type Notify = (text: string, tone?: "notice" | "error") => void;

function callPeerTitle(call: Call, chats: Chat[], fallback: string): string {
  const chat = chats.find((item) => item.id === call.chatId);
  return chat?.title || fallback;
}

export function IncomingCallBanner({ onNotify }: { onNotify: Notify }) {
  const s = useStrings();
  const api = useMessenger();
  const call = api.call.incoming;
  if (!call || api.call.active) return null;
  const title = callPeerTitle(call, api.chats, s.calls.peerFallback);
  const video = call.mediaMode === "video";

  const accept = () => {
    api.acceptCall().catch((error: unknown) => {
      onNotify(error instanceof Error ? error.message : s.toasts.errorTitle, "error");
    });
  };
  const decline = () => {
    api.declineCall().catch((error: unknown) => {
      onNotify(error instanceof Error ? error.message : s.toasts.errorTitle, "error");
    });
  };

  return (
    <div className="call-banner" data-testid="call-incoming-banner" role="alertdialog" aria-live="assertive" aria-label={title}>
      <span className="call-banner__pulse" aria-hidden="true">
        {video ? <Video size={20} /> : <Phone size={20} />}
      </span>
      <span className="call-banner__body">
        <span className="call-banner__title">{title}</span>
        <span className="call-banner__sub">
          {video ? s.calls.incomingVideo : s.calls.incomingGroup}
        </span>
        {!api.capabilities?.features.calls ? <span className="call-banner__note">{s.calls.mediaUnavailableNote}</span> : null}
      </span>
      <span className="call-banner__actions">
        <button type="button" className="button button--danger button--sm" data-testid="call-decline" onClick={decline}>
          <PhoneOff size={15} aria-hidden="true" /> {s.calls.decline}
        </button>
        <button type="button" className="button button--primary button--sm" data-testid="call-accept" onClick={accept}>
          <Phone size={15} aria-hidden="true" /> {s.calls.accept}
        </button>
      </span>
    </div>
  );
}

export function ActiveCallOverlay({ onNotify }: { onNotify: Notify }) {
  const s = useStrings();
  const api = useMessenger();
  const call = api.call.active;
  if (!call) return null;
  const title = callPeerTitle(call, api.chats, s.calls.peerFallback);
  const ended = call.state === "ended";
  const media = api.call.media;

  const hangup = () => {
    api.hangupCall().catch((error: unknown) => {
      onNotify(error instanceof Error ? error.message : s.toasts.errorTitle, "error");
    });
  };

  const mediaNote =
    media === "unavailable"
      ? s.calls.mediaUnavailableNote
      : media === "failed"
        ? s.calls.mediaFailedNote(api.call.mediaError ?? s.toasts.errorTitle)
        : media === "connecting"
          ? s.calls.media.connecting
          : s.calls.mediaConnectedNote;

  return (
    <div className="call-overlay" data-testid="call-overlay" role="dialog" aria-modal="true" aria-label={s.calls.overlayTitle(title)}>
      <div className="call-card">
        <div className="call-card__head">
          <span className={`call-card__badge call-card__badge--${media}`}>
            {call.mediaMode === "video" ? <Video size={18} aria-hidden="true" /> : <Phone size={18} aria-hidden="true" />}
            {call.mediaMode === "video" ? s.calls.videoMode : s.calls.audioMode}
          </span>
          <button
            type="button"
            className="icon-button icon-button--sm icon-button--ghost"
            aria-label={s.calls.dismiss}
            title={s.calls.dismiss}
            onClick={() => api.dismissCall()}
          >
            <X size={18} aria-hidden="true" />
          </button>
        </div>
        <h2 className="call-card__title">{title}</h2>
        <p className="call-card__kind">{call.kind === "group" ? s.calls.kindGroup : s.calls.kindOneToOne}</p>
        <p className="call-card__state" role="status" aria-live="polite">
          {s.calls.state[call.state]}
        </p>
        <p className="call-card__participants">{s.calls.participants(call.participants.length)}</p>

        <p className={`call-card__media call-card__media--${media}`}>{mediaNote}</p>

        <div className="call-card__controls">
          <button
            type="button"
            className="call-control"
            aria-label={s.calls.mute}
            title={s.calls.muteUnavailable}
            disabled
          >
            <MicOff size={19} aria-hidden="true" />
            <span>{s.calls.mute}</span>
          </button>
          <button
            type="button"
            className="call-control call-control--hangup"
            data-testid="call-hangup"
            aria-label={s.calls.hangup}
            title={s.calls.hangup}
            onClick={ended ? () => api.dismissCall() : hangup}
          >
            <PhoneOff size={20} aria-hidden="true" />
            <span>{s.calls.hangup}</span>
          </button>
        </div>
        <p className="call-card__honest">{s.calls.mediaUnavailableNote}</p>
      </div>
    </div>
  );
}
