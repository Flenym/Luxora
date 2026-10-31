/**
 * Locale-aware presentation helpers for the messenger UI.
 * Pure functions only: no React, no DOM, no network.
 */

export function initials(name: string | null | undefined): string {
  const clean = (name ?? "").trim();
  if (!clean) return "?";
  const parts = clean.split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) {
    const chars = Array.from(parts[0]!);
    return (chars[0] ?? "?").toUpperCase() + (chars[1] ?? "").toUpperCase();
  }
  const first = Array.from(parts[0]!)[0] ?? "";
  const last = Array.from(parts[parts.length - 1]!)[0] ?? "";
  return (first + last).toUpperCase();
}

/** Code points, not UTF-16 units, so a message limit matches the API contract. */
export function countCodePoints(value: string): number {
  return Array.from(value).length;
}

export function truncate(value: string, max = 140): string {
  const chars = Array.from(value);
  return chars.length <= max ? value : chars.slice(0, max).join("") + "…";
}

export function formatClock(value: string | number | Date, locale: string): string {
  const date = toDate(value);
  if (!date) return "";
  try {
    return new Intl.DateTimeFormat(locale, { hour: "2-digit", minute: "2-digit" }).format(date);
  } catch {
    return date.toTimeString().slice(0, 5);
  }
}

export function toDate(value: string | number | Date): Date | null {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function startOfDay(date: Date): number {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

export function isSameDay(a: Date, b: Date): boolean {
  return startOfDay(a) === startOfDay(b);
}

const WEEKDAY: Record<string, Intl.DateTimeFormat> = {};

function weekdayFormatter(locale: string): Intl.DateTimeFormat {
  return (WEEKDAY[locale] ??= new Intl.DateTimeFormat(locale, { weekday: "short" }));
}

/**
 * Compact timestamp for chat rows: clock today, explicit label yesterday,
 * weekday within the last week, short date before that.
 */
export function formatRelativeChatTime(
  value: string | number | Date,
  locale: string,
  labels: { yesterday: string },
): string {
  const date = toDate(value);
  if (!date) return "";
  const now = new Date();
  if (isSameDay(date, now)) return formatClock(date, locale);
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (isSameDay(date, yesterday)) return labels.yesterday;
  const diffDays = Math.round((startOfDay(now) - startOfDay(date)) / 86_400_000);
  if (diffDays > 1 && diffDays < 7) {
    const raw = weekdayFormatter(locale).format(date);
    return raw.charAt(0).toUpperCase() + raw.slice(1);
  }
  try {
    return new Intl.DateTimeFormat(locale, { day: "2-digit", month: "2-digit", year: "numeric" }).format(date);
  } catch {
    return date.toLocaleDateString();
  }
}

/** Day separator inside a conversation. */
export function formatDaySeparator(
  value: string | number | Date,
  locale: string,
  labels: { today: string; yesterday: string },
): string {
  const date = toDate(value);
  if (!date) return "";
  const now = new Date();
  if (isSameDay(date, now)) return labels.today;
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (isSameDay(date, yesterday)) return labels.yesterday;
  try {
    return new Intl.DateTimeFormat(locale, {
      weekday: "long",
      day: "numeric",
      month: "long",
      ...(date.getFullYear() === now.getFullYear() ? {} : { year: "numeric" }),
    }).format(date);
  } catch {
    return date.toLocaleDateString();
  }
}

export function formatFileSize(bytes: number, locale: string): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "";
  const units = ["Б", "КБ", "МБ", "ГБ"];
  const enUnits = ["B", "KB", "MB", "GB"];
  const ru = locale.toLowerCase().startsWith("ru");
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const formatted = new Intl.NumberFormat(locale, {
    maximumFractionDigits: unit === 0 ? 0 : value >= 10 ? 1 : 1,
  }).format(value);
  return `${formatted} ${(ru ? units : enUnits)[unit]}`;
}

export function formatDuration(ms: number | undefined | null): string {
  if (!ms || ms <= 0) return "0:00";
  const totalSeconds = Math.round(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

/** Russian plural picker: pluralRu(2, "участник", "участника", "участников"). */
export function pluralRu(count: number, one: string, few: string, many: string): string {
  const abs = Math.abs(count) % 100;
  const last = abs % 10;
  if (abs > 10 && abs < 20) return many;
  if (last > 1 && last < 5) return few;
  if (last === 1) return one;
  return many;
}

export function presenceLabel(
  presence: "online" | "offline" | undefined,
  locale: string,
  labels: { online: string; offline: string },
): string {
  if (!presence) return labels.offline;
  if (presence === "online") return labels.online;
  return labels.offline;
}

/** Human summary of a message for conversation rows / reply quotes. */
export function messagePreview(
  body: string | null,
  attachments: { kind: string; fileName: string }[],
  labels: { image: string; video: string; voice: string; audio: string; file: string },
): string {
  const attachment = attachments[0];
  if (attachment) {
    const base =
      attachment.kind === "image"
        ? labels.image
        : attachment.kind === "video" || attachment.kind === "video_message"
          ? labels.video
          : attachment.kind === "voice"
            ? labels.voice
            : attachment.kind === "audio"
              ? labels.audio
              : labels.file;
    return attachments.length > 1 ? `${base} (+${attachments.length - 1})` : base;
  }
  const clean = (body ?? "").replace(/\s+/g, " ").trim();
  return clean.length > 0 ? clean : "";
}

/** True when the browser prefers reduced motion (safe in non-DOM environments). */
export function prefersReducedMotion(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
  try {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
}
