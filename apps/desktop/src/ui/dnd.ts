import type { UserPublic } from "../api/types";

/** Do not disturb (M12c): a manual pause or the daily quiet hours, evaluated in the user's own zone. */

export interface QuietHours {
  start: string;
  end: string;
  days?: number[];
  tz: string;
}

const WEEKDAYS: Record<string, number> = { Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6 };

function minutesOf(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}

/** Local weekday (0 = Monday) and minutes after midnight in `tz`; null when the zone is unknown. */
export function localClock(now: Date, tz: string): { weekday: number; minutes: number } | null {
  try {
    const parts = new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short", hour: "numeric", minute: "numeric", hourCycle: "h23" }).formatToParts(now);
    const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
    const weekday = WEEKDAYS[get("weekday")];
    if (weekday === undefined) return null;
    return { weekday, minutes: (Number(get("hour")) % 24) * 60 + Number(get("minute")) };
  } catch {
    return null;
  }
}

/** Same rule as the server: an overnight window belongs to the day it starts on. */
export function inQuietHours(hours: QuietHours, now = new Date()): boolean {
  const start = minutesOf(hours.start);
  const end = minutesOf(hours.end);
  if (start === end) return false;
  const clock = localClock(now, hours.tz);
  if (!clock) return false;
  const days = new Set(hours.days && hours.days.length > 0 ? hours.days : [0, 1, 2, 3, 4, 5, 6]);
  if (start < end) return start <= clock.minutes && clock.minutes < end && days.has(clock.weekday);
  if (clock.minutes >= start) return days.has(clock.weekday);
  return clock.minutes < end && days.has((clock.weekday + 6) % 7);
}

export function dndActive(user: UserPublic | undefined | null, now = new Date()): boolean {
  if (!user) return false;
  if (user.dnd_until && Date.parse(user.dnd_until) > now.getTime()) return true;
  return user.quiet_hours ? inQuietHours(user.quiet_hours, now) : false;
}

export type DndChoice = "30m" | "1h" | "2h" | "tomorrow";

export const DND_OPTIONS: Array<[DndChoice, string]> = [
  ["30m", "30 分"],
  ["1h", "1 時間"],
  ["2h", "2 時間"],
  ["tomorrow", "明日 8:00"],
];

export function dndUntilAt(choice: DndChoice, now = new Date()): string {
  const at = new Date(now);
  switch (choice) {
    case "30m":
      at.setMinutes(at.getMinutes() + 30);
      break;
    case "1h":
      at.setHours(at.getHours() + 1);
      break;
    case "2h":
      at.setHours(at.getHours() + 2);
      break;
    case "tomorrow":
      at.setDate(at.getDate() + 1);
      at.setHours(8, 0, 0, 0);
      break;
  }
  return at.toISOString();
}

export const DAY_LABELS = ["月", "火", "水", "木", "金", "土", "日"];

export function deviceTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

/** "22:00〜07:00 (月〜金)" for the profile card. */
export function quietHoursLabel(hours: QuietHours): string {
  const days = hours.days && hours.days.length > 0 && hours.days.length < 7 ? ` (${hours.days.map((d) => DAY_LABELS[d]).join("")})` : "";
  return `${hours.start}〜${hours.end}${days}`;
}

/** The manual pause still running (dnd_until in the future), else null. */
export function pausedUntil(user: Pick<UserPublic, "dnd_until"> | undefined | null, now = new Date()): string | null {
  const until = user?.dnd_until;
  return until && Date.parse(until) > now.getTime() ? until : null;
}

const hhmm = (at: Date) => `${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}`;

/** M40, 「通知を一時停止」's value: 「オフ」, 「〜 15:30 まで」 today, 「〜 10/1 08:00 まで」 on another day. */
export function pauseValue(until: string | null | undefined, now = new Date()): string {
  if (!until) return "オフ";
  const at = new Date(until);
  if (Number.isNaN(at.getTime()) || at.getTime() <= now.getTime()) return "オフ";
  const sameDay = at.toDateString() === now.toDateString();
  return sameDay ? `〜 ${hhmm(at)} まで` : `〜 ${at.getMonth() + 1}/${at.getDate()} ${hhmm(at)} まで`;
}

/** M40, 「おやすみ時間」's value: 「22:00〜07:00」 (with the days when not every day) or 「オフ」. */
export function quietHoursValue(hours: QuietHours | null | undefined): string {
  return hours ? quietHoursLabel(hours) : "オフ";
}

/** 「日時を指定」: a datetime-local value ("2026-10-01T09:30") as an instant, or null when empty, invalid or not ahead. */
export function customPauseAt(value: string, now = new Date()): string | null {
  if (!value) return null;
  const at = new Date(value);
  if (Number.isNaN(at.getTime()) || at.getTime() <= now.getTime()) return null;
  return at.toISOString();
}

/** A datetime-local value for `at` in the device's zone (the picker's starting point). */
export function localInputValue(at: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}T${hhmm(at)}`;
}
