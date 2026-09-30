/** Presentation helpers shared by the timeline, sidebar and dialogs. */
import type { MessageState } from "../sync/types";

const WEEKDAYS = ["日", "月", "火", "水", "木", "金", "土"];

export function dayKey(iso: string, now = new Date()): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return dayKey(now.toISOString(), now);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

/** 今日 / 昨日 / 9月26日 (金) / 2025年12月31日 (水) */
export function dateLabel(iso: string, now = new Date()): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const today = dayKey(now.toISOString(), now);
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  const key = dayKey(iso, now);
  if (key === today) return "今日";
  if (key === dayKey(yesterday.toISOString(), now)) return "昨日";
  const weekday = WEEKDAYS[date.getDay()] ?? "";
  const md = `${date.getMonth() + 1}月${date.getDate()}日 (${weekday})`;
  return date.getFullYear() === now.getFullYear() ? md : `${date.getFullYear()}年${md}`;
}

export function timeLabel(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "送信中…";
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

/**
 * The unread banner's "since" (§10.1): 10:23 today, 昨日 10:23, else the day separator's text and the time.
 * Always 24-hour HH:mm in the device's time zone, never locale-formatted.
 */
export function sinceLabel(iso: string, now = new Date()): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const t = timeLabel(iso);
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  const key = dayKey(iso, now);
  if (key === dayKey(now.toISOString(), now)) return t;
  if (key === dayKey(yesterday.toISOString(), now)) return `昨日 ${t}`;
  return `${dateLabel(iso, now)} ${t}`;
}

/** 1234 → "1,234": ASCII commas whatever the locale. */
export function group3(n: number): string {
  return String(Math.trunc(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/**
 * A few names in a line (M27, the same on iOS and Android): 「山田、佐藤、鈴木」, and past `max` the first ones and
 * 「ほか N 人」 (「山田、佐藤、鈴木 ほか 2 人」). The full list is a tap or a hover away wherever this is shown.
 */
export function compactNames(names: readonly string[], max = 3): string {
  const shown = names.slice(0, max).join("、");
  return names.length > max ? `${shown} ほか ${names.length - max} 人` : shown;
}

/** 「山田、佐藤 が確認」 / 「山田、佐藤、鈴木 ほか 2 人が確認」: who acknowledged a message (M27; empty when nobody did). */
export function ackLine(names: readonly string[], max = 3): string {
  if (names.length === 0) return "";
  return names.length > max ? `${compactNames(names, max)}が確認` : `${compactNames(names, max)} が確認`;
}

/** 「未読 2,000 件 · 10:23 以降」; without the time when the server sent none (older servers). */
export function bannerText(n: number, firstUnreadAt: string | null | undefined, now = new Date()): string {
  const since = firstUnreadAt ? sinceLabel(firstUnreadAt, now) : "";
  return `未読 ${group3(n)} 件` + (since ? ` · ${since} 以降` : "");
}

export function fullTimestamp(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString("ja-JP", { year: "numeric", month: "long", day: "numeric", weekday: "short", hour: "2-digit", minute: "2-digit" });
}

/** One or two characters for an avatar: "Toru Kano" → "TK", "かのう" → "か". */
export function initials(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return "?";
  const words = trimmed.split(/\s+/);
  if (words.length >= 2 && /^[A-Za-z]/.test(words[0]!) && /^[A-Za-z]/.test(words[1]!)) {
    return (words[0]![0]! + words[1]![0]!).toUpperCase();
  }
  return [...trimmed][0]!.toUpperCase();
}

/** A stable hue per user id so the same person always gets the same avatar colour. */
export function avatarHue(id: string): number {
  let hash = 0;
  for (const char of id) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return hash % 360;
}

export type TimelineItem =
  | { kind: "date"; key: string; label: string }
  | { kind: "unread"; key: string }
  | { kind: "message"; key: string; message: MessageState; compact: boolean };

const GROUP_WINDOW_MS = 5 * 60 * 1000;

/**
 * M47: whether `message` goes on under `previous` as a compact row, in a timeline or a thread: the same sender, within
 * five minutes, on the same day (a date separator comes between otherwise), neither a system post. The callers cut the
 * run at their dividers; the timeline also at a reply sent to the channel. Pending messages group like sent ones: my
 * second message must not show the header until the server confirms it and then drop it (the jolt when sending several
 * in a row).
 */
export function continuesGroup(previous: MessageState, message: MessageState, now = new Date()): boolean {
  return (
    (previous.type ?? "user") === "user" &&
    (message.type ?? "user") === "user" &&
    previous.sender_id === message.sender_id &&
    dayKey(previous.created_at, now) === dayKey(message.created_at, now) &&
    Math.abs(new Date(message.created_at).getTime() - new Date(previous.created_at).getTime()) < GROUP_WINDOW_MS
  );
}

/**
 * Timeline rows: date separators, one "new messages" divider before the first message the reader has
 * not seen, and, with `group` (M47 「連続した投稿をまとめる」), consecutive messages from the same sender within
 * five minutes collapsed into compact rows.
 */
export function buildTimeline(
  messages: MessageState[],
  options: { firstUnreadAfterSeq?: number | null; meId?: string | null; now?: Date; group?: boolean } = {},
): TimelineItem[] {
  const now = options.now ?? new Date();
  const items: TimelineItem[] = [];
  let previous: MessageState | null = null;
  let previousDay = "";
  let unreadPlaced = false;
  for (const message of messages) {
    const day = dayKey(message.created_at, now);
    if (day !== previousDay) {
      items.push({ kind: "date", key: `date:${day}`, label: dateLabel(message.created_at, now) });
      previousDay = day;
      previous = null;
    }
    const after = options.firstUnreadAfterSeq;
    if (
      !unreadPlaced &&
      after !== null &&
      after !== undefined &&
      message.seq !== null &&
      message.seq > after &&
      message.sender_id !== options.meId
    ) {
      items.push({ kind: "unread", key: "unread" });
      unreadPlaced = true;
      previous = null;
    }
    const compact =
      !!options.group &&
      previous !== null &&
      !previous.parent_id && // a reply also sent to the channel (M15c) keeps its own header
      !message.parent_id &&
      continuesGroup(previous, message, now);
    items.push({ kind: "message", key: message.id, message, compact });
    previous = message;
  }
  return items;
}

export function formatMuted(mutedUntil: string | null): string | null {
  if (!mutedUntil) return null;
  const until = new Date(mutedUntil);
  if (Number.isNaN(until.getTime()) || until.getTime() <= Date.now()) return null;
  return `${timeLabel(mutedUntil)} までミュート`;
}

/**
 * A message row's React key: the client_msg_id, which my pending message keeps when the server confirms it (its id
 * changes from "local:…" to the server's). Keyed by id, the row was unmounted and mounted again on every send: the
 * jolt when sending. Every client keys its rows this way.
 */
export function rowKey(message: { id: string; client_msg_id?: string | null }): string {
  return message.client_msg_id || message.id;
}
