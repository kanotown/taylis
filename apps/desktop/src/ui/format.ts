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
 * Timeline rows: date separators, one "new messages" divider before the first message the reader has
 * not seen, and consecutive messages from the same sender within five minutes collapsed into compact rows.
 */
export function buildTimeline(
  messages: MessageState[],
  options: { firstUnreadAfterSeq?: number | null; meId?: string | null; now?: Date } = {},
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
      previous !== null &&
      previous.sender_id === message.sender_id &&
      !previous.parent_id && // a reply also sent to the channel (M15c) keeps its own header
      !message.parent_id &&
      // Pending messages group like sent ones: my second message must not show the header until the server
      // confirms it and then drop it (the jolt when sending several in a row).
      Math.abs(new Date(message.created_at).getTime() - new Date(previous.created_at).getTime()) < GROUP_WINDOW_MS;
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
