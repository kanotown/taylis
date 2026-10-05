/**
 * 管理 →「アナリティクス」 (M116, docs/ANALYTICS.md §6): the pure parts (times, the bar geometry, the table's columns),
 * kept apart so the tests can check them.
 */
import type { AnalyticsMemberSort } from "../api/types";
import { intlLocale, type MessageKey, t } from "../i18n";

export const PERIODS = [7, 30, 90] as const;
export type Period = (typeof PERIODS)[number];
export const INACTIVE_CHOICES = [7, 14, 30, 90] as const;
export const PAGE_SIZE = 100;

/** The device's IANA time zone: the server cuts the days there (UTC when the runtime does not say). */
export function deviceTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

const UNITS: Array<[Intl.RelativeTimeFormatUnit, number]> = [
  ["year", 365 * 86_400],
  ["month", 30 * 86_400],
  ["day", 86_400],
  ["hour", 3_600],
  ["minute", 60],
];

/** 「3 日前」「2 時間前」「たった今」 (Intl, in the UI language); "" for no time. */
export function relativeTime(iso: string | null | undefined, now = new Date()): string {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const seconds = Math.round((date.getTime() - now.getTime()) / 1000);
  const format = new Intl.RelativeTimeFormat(intlLocale(), { numeric: "auto" });
  for (const [unit, size] of UNITS) {
    if (Math.abs(seconds) >= size) return format.format(Math.trunc(seconds / size), unit);
  }
  return format.format(0, "second");
}

/** The full date and time for the hover (the device's zone, the UI language). */
export function absoluteTime(iso: string | null | undefined): string {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString(intlLocale(), { year: "numeric", month: "short", day: "numeric", weekday: "short", hour: "2-digit", minute: "2-digit" });
}

/** A day of the series ("2026-10-06") as 「10/6 (火)」-like short text in the UI language. */
export function dayLabel(day: string | undefined): string {
  if (!day) return "";
  const [year = NaN, month = NaN, date = NaN] = day.split("-").map(Number);
  const value = new Date(Date.UTC(year, month - 1, date, 12));
  if (Number.isNaN(value.getTime())) return day;
  return value.toLocaleDateString(intlLocale(), { month: "numeric", day: "numeric", weekday: "short", timeZone: "UTC" });
}

export interface Bar {
  x: number;
  y: number;
  width: number;
  height: number;
  value: number;
}

/**
 * Bars for `values` in a `width` × `height` plot: one slot per value, a 2px gap between bars, a bar at least 1px tall
 * when its value is not 0 (a quiet day is still visible), 0 → no height. The scale tops out at the largest value.
 */
export function barLayout(values: readonly number[], width: number, height: number, gap = 2): { bars: Bar[]; max: number } {
  const max = Math.max(0, ...values);
  const slot = values.length ? width / values.length : 0;
  const barWidth = Math.max(1, slot - gap);
  const bars = values.map((value, index) => {
    const h = max > 0 && value > 0 ? Math.max(1, (value / max) * height) : 0;
    return { x: index * slot + (slot - barWidth) / 2, y: height - h, width: barWidth, height: h, value };
  });
  return { bars, max };
}

/**
 * An SVG path for a bar with 4px rounded top corners anchored to the baseline (flat bottom). Short bars get a smaller
 * radius so the shape never folds over.
 */
export function barPath(bar: Bar, radius = 4): string {
  if (bar.height <= 0) return "";
  const r = Math.min(radius, bar.width / 2, bar.height);
  const { x, y, width: w, height: h } = bar;
  return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`;
}

export interface MemberColumn {
  sort: AnalyticsMemberSort;
  label: string;
  /** The first click sorts this way (newest / most first for times and counts). */
  firstOrder: "asc" | "desc";
}

/** A column whose label is looked up when read (never at load time, docs/I18N.md §4). */
function column(sort: AnalyticsMemberSort, key: MessageKey, firstOrder: "asc" | "desc"): MemberColumn {
  return { sort, firstOrder, get label() { return t(key); } };
}

export const MEMBER_COLUMNS: ReadonlyArray<MemberColumn> = [
  column("name", "analytics.col.name", "asc"),
  column("role", "admin.users.role", "asc"),
  column("status", "analytics.col.status", "asc"),
  column("last_login_at", "analytics.col.lastLogin", "desc"),
  column("last_active_at", "analytics.col.lastActive", "desc"),
  column("messages_30d", "analytics.col.messages30d", "desc"),
];

/** Clicking a column: the same column flips the order, another one starts with its natural order. */
export function nextSort(current: { sort: AnalyticsMemberSort; order: "asc" | "desc" }, column: MemberColumn): { sort: AnalyticsMemberSort; order: "asc" | "desc" } {
  if (current.sort === column.sort) return { sort: column.sort, order: current.order === "asc" ? "desc" : "asc" };
  return { sort: column.sort, order: column.firstOrder };
}

const PLATFORM_KEYS = {
  desktop: "analytics.platform.desktop",
  web: "analytics.platform.web",
  ios: "analytics.platform.ios",
  android: "analytics.platform.android",
} as const;

export function platformLabel(platform: string): string {
  const key = PLATFORM_KEYS[platform as keyof typeof PLATFORM_KEYS];
  return key ? t(key) : platform;
}

/** members-20261006.csv in the device's date. */
export function csvFilename(now = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `members-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}.csv`;
}
