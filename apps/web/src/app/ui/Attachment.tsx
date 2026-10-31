/** Attachments rendered from authenticated blobs only — no unauthenticated URLs.
 *  Every unsupported/undecodable case falls back to an honest label, never a fake player. */
import { useEffect, useState } from "react";
import { Download, FileText, Image as ImageIcon, Play, TriangleAlert } from "lucide-react";
import type { Attachment } from "../contract";
import { useLocale } from "../../i18n";
import { useStrings } from "./copy";
import { formatDuration, formatFileSize } from "./format";
import { useAuthedDownload, useAuthedObjectUrl } from "./media";
import { Spinner } from "./primitives";

function metaLabel(attachment: Attachment, locale: string): string {
  const bits: string[] = [];
  if (attachment.kind === "voice" || attachment.kind === "audio") {
    bits.push(formatDuration(attachment.metadata.durationMs));
  }
  bits.push(formatFileSize(attachment.sizeBytes, locale));
  return bits.join(" · ");
}

function DownloadButton({ attachment }: { attachment: Attachment }) {
  const s = useStrings();
  const download = useAuthedDownload();
  const [state, setState] = useState<"idle" | "busy" | "failed">("idle");
  const onClick = () => {
    setState("busy");
    download(attachment.downloadPath, attachment.fileName).then(
      () => setState("idle"),
      () => setState("failed"),
    );
  };
  return (
    <button
      type="button"
      className="attachment__download"
      onClick={onClick}
      disabled={state === "busy"}
      aria-label={`${s.conversation.download}: ${attachment.fileName}`}
      title={state === "failed" ? s.conversation.downloadUnavailable : s.conversation.download}
    >
      {state === "busy" ? <Spinner /> : <Download size={16} aria-hidden="true" />}
      <span className="attachment__download-label">
        {state === "failed" ? s.conversation.downloadUnavailable : s.conversation.download}
      </span>
    </button>
  );
}

export function AttachmentView({ attachment }: { attachment: Attachment }) {
  const s = useStrings();
  const { locale } = useLocale();

  if (attachment.kind === "image") {
    return <ImageAttachment attachment={attachment} />;
  }

  return (
    <div className="attachment attachment--file">
      <span className="attachment__icon" aria-hidden="true">
        <FileText size={20} />
      </span>
      <span className="attachment__meta">
        <span className="attachment__name" title={attachment.fileName}>
          {attachment.fileName}
        </span>
        <span className="attachment__sub">
          {s.conversation.fileLabel} · {metaLabel(attachment, locale)}
        </span>
      </span>
      <DownloadButton attachment={attachment} />
    </div>
  );
}

function ImageAttachment({ attachment }: { attachment: Attachment }) {
  const s = useStrings();
  const { locale } = useLocale();
  const thumbnail = attachment.thumbnailPath ?? attachment.downloadPath;
  const { url, loading, error } = useAuthedObjectUrl(thumbnail);
  const [broken, setBroken] = useState(false);
  useEffect(() => setBroken(false), [url]);
  const width = attachment.metadata.width ?? 0;
  const height = attachment.metadata.height ?? 0;
  const ratio = width > 0 && height > 0 ? Math.min(Math.max(width / height, 0.55), 2.2) : 1.4;

  if (url && !broken) {
    return (
      <figure className="attachment attachment--image">
        <img
          src={url}
          alt={attachment.fileName}
          loading="lazy"
          onError={() => setBroken(true)}
          style={{ aspectRatio: String(ratio) }}
        />
        <figcaption className="attachment__caption">
          <span>{formatFileSize(attachment.sizeBytes, locale)}</span>
          <DownloadButton attachment={attachment} />
        </figcaption>
      </figure>
    );
  }

  return (
    <div className="attachment attachment--image-placeholder">
      <span className="attachment__icon" aria-hidden="true">
        {loading ? <Spinner /> : <ImageIcon size={22} />}
      </span>
      <span className="attachment__meta">
        <span className="attachment__name" title={attachment.fileName}>
          {attachment.fileName}
        </span>
        <span className="attachment__sub">
          {loading ? s.conversation.imageLoading : s.conversation.imagePreviewUnavailable}
          {error ? "" : ` · ${formatFileSize(attachment.sizeBytes, locale)}`}
        </span>
      </span>
      <DownloadButton attachment={attachment} />
    </div>
  );
}

export function AudioAttachment({ attachment }: { attachment: Attachment }) {
  const s = useStrings();
  const { url, loading, error } = useAuthedObjectUrl(attachment.downloadPath);
  const isVoice = attachment.kind === "voice";
  if (url) {
    return (
      <div className="attachment attachment--audio">
        <span className="attachment__icon" aria-hidden="true">
          <Play size={18} />
        </span>
        <span className="attachment__audio-body">
          <span className="attachment__name">
            {isVoice ? s.conversation.voiceLabel : s.conversation.audioLabel}
            <span className="attachment__sub"> · {formatDuration(attachment.metadata.durationMs)}</span>
          </span>
          <audio controls src={url} aria-label={isVoice ? s.conversation.voiceLabel : s.conversation.audioLabel} />
        </span>
      </div>
    );
  }
  return (
    <div className="attachment attachment--audio attachment--unavailable">
      <span className="attachment__icon" aria-hidden="true">
        {loading ? <Spinner /> : <Play size={18} />}
      </span>
      <span className="attachment__meta">
        <span className="attachment__name">
          {isVoice ? s.conversation.voiceLabel : s.conversation.audioLabel} ·{" "}
          {formatDuration(attachment.metadata.durationMs)}
        </span>
        <span className="attachment__sub attachment__sub--warn">
          <TriangleAlert size={13} aria-hidden="true" />{" "}
          {loading ? s.conversation.loadingMedia : s.conversation.playbackUnavailable}
        </span>
      </span>
    </div>
  );
}

export function VideoAttachment({ attachment }: { attachment: Attachment }) {
  const s = useStrings();
  const { url, loading, error } = useAuthedObjectUrl(attachment.downloadPath);
  if (url) {
    return (
      <div className="attachment attachment--video">
        <video controls src={url} aria-label={s.conversation.videoLabel} />
        <span className="attachment__caption">
          <span>{s.conversation.videoLabel}</span>
          <DownloadButton attachment={attachment} />
        </span>
      </div>
    );
  }
  return (
    <div className="attachment attachment--file">
      <span className="attachment__icon" aria-hidden="true">
        {loading ? <Spinner /> : <Play size={20} />}
      </span>
      <span className="attachment__meta">
        <span className="attachment__name" title={attachment.fileName}>
          {attachment.fileName}
        </span>
        <span className="attachment__sub attachment__sub--warn">
          <TriangleAlert size={13} aria-hidden="true" />
          {loading ? s.conversation.loadingMedia : s.conversation.playbackUnavailable}
        </span>
      </span>
      <DownloadButton attachment={attachment} />
    </div>
  );
}

export function AttachmentItem({ attachment }: { attachment: Attachment }) {
  if (attachment.kind === "image") return <AttachmentView attachment={attachment} />;
  if (attachment.kind === "voice" || attachment.kind === "audio") return <AudioAttachment attachment={attachment} />;
  if (attachment.kind === "video" || attachment.kind === "video_message") return <VideoAttachment attachment={attachment} />;
  return <AttachmentView attachment={attachment} />;
}
