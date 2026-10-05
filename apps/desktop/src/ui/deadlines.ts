/**
 * M85 (L5, docs/DEADLINES.md): deadlines — channel tasks of kind `deadline` whose advance notices the server's
 * 「締切」 bot posts in the channel. The pure rules: the notice days, when a deadline has passed, the channel header's
 * chip (the next open deadline: 「全国大会 原稿 あと 3 日」 / 「今日」 / 「明日」) and 「締切」's groups (今週 / 今月 /
 * それ以降 / 過ぎたもの). No store, no React.
 */
import type { TaskOut } from "../api/types";
import { addDays, clock, type DayKey, dayKey, daysBetween, parseDay, weekStart } from "./calendarDates";
import { dueDay, dueLabel } from "./tasks";
import { t, weekdayName } from "../i18n";

/** The server's default (LAB.md §E): a week, three days, the day before and the day itself. */
export const DEFAULT_NOTICE_DAYS: readonly number[] = [7, 3, 1, 0];
/** What the dialog offers (the server takes any of 0 to 60, at most 6). */
export const NOTICE_CHOICES: readonly number[] = [14, 7, 3, 1, 0];

type DeadlineLike = Pick<TaskOut, "id" | "kind" | "status" | "due_on" | "channel_id" | "title"> & { due_at?: string | null };

export function isDeadline(task: Pick<TaskOut, "kind">): boolean {
  return task.kind === "deadline";
}

/** 「当日」 / 「前日」 / 「3 日前」. */
export function noticeLabel(days: number): string {
  if (days === 0) return t("recurring.sameDay");
  if (days === 1) return t("deadlines.dayBefore");
  return t("deadlines.daysBefore", { count: days });
}

/** 「7 日前・3 日前・前日・当日」, largest first; 「通知しない」 for none. */
export function noticeSummary(days: readonly number[] | null | undefined): string {
  const sorted = [...new Set(days ?? [])].sort((a, b) => b - a);
  return sorted.length === 0 ? t("notify.channel.none") : sorted.map(noticeLabel).join(t("recurring.daySeparator"));
}

/** The days as the server keeps them (distinct, largest first). */
export function normalizeNoticeDays(days: readonly number[]): number[] {
  return [...new Set(days)].sort((a, b) => b - a);
}

export function sameNoticeDays(a: readonly number[] | null | undefined, b: readonly number[] | null | undefined): boolean {
  const x = normalizeNoticeDays(a ?? []);
  const y = normalizeNoticeDays(b ?? []);
  return x.length === y.length && x.every((d, i) => d === y[i]);
}

/** Over: a due time once it has come, a date once its day is over (in this device's zone). */
export function deadlinePassed(task: Pick<DeadlineLike, "due_on"> & { due_at?: string | null }, today: DayKey, now: Date = new Date()): boolean {
  if (task.due_at) return new Date(task.due_at).getTime() <= now.getTime();
  const day = dueDay(task);
  return !!day && day < today;
}

/** By date, then a due time (a date alone is the whole day: after the timed ones that day), then id. */
export function compareDeadlines(a: DeadlineLike, b: DeadlineLike): number {
  const da = dueDay(a) ?? "";
  const db = dueDay(b) ?? "";
  if (da !== db) return da < db ? -1 : 1;
  const ta = a.due_at ? new Date(a.due_at).getTime() : Number.POSITIVE_INFINITY;
  const tb = b.due_at ? new Date(b.due_at).getTime() : Number.POSITIVE_INFINITY;
  if (ta !== tb) return ta < tb ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** The header's chip: the channel's nearest deadline still open and not over. */
export function nextDeadline<T extends DeadlineLike>(tasks: readonly T[], channelId: string, today: DayKey, now: Date = new Date()): T | null {
  const open = tasks.filter((t) => isDeadline(t) && t.channel_id === channelId && t.status !== "done" && !!t.due_on && !deadlinePassed(t, today, now));
  return open.sort(compareDeadlines)[0] ?? null;
}

/** When, as the chip says it: 「今日」 (「今日 17:00」), 「明日」, else 「あと N 日」. */
export function remainingText(task: Pick<DeadlineLike, "due_on"> & { due_at?: string | null }, today: DayKey): string {
  const day = dueDay(task);
  if (!day) return "";
  const days = daysBetween(today, day);
  const time = task.due_at ? ` ${clock(task.due_at)}` : "";
  if (days <= 0) return `${t("common.today")}${time}`;
  if (days === 1) return `${t("common.tomorrow")}${time}`;
  return t("deadlines.daysLeft", { count: days });
}

/** 「全国大会 原稿 あと 3 日」. */
export function deadlineChipText(task: DeadlineLike, today: DayKey): string {
  return `${task.title} ${remainingText(task, today)}`;
}

/** How urgent the chip looks: today or tomorrow (red), within a week (amber), later (plain). */
export function deadlineTone(task: Pick<DeadlineLike, "due_on"> & { due_at?: string | null }, today: DayKey): "soon" | "week" | "later" {
  const day = dueDay(task);
  if (!day) return "later";
  const days = daysBetween(today, day);
  return days <= 1 ? "soon" : days <= 7 ? "week" : "later";
}

/** A row's date: 「10/9 (金)」, 「10/9 (金) 17:00」, 「今日」 for today. */
export function deadlineWhen(task: Pick<DeadlineLike, "due_on"> & { due_at?: string | null }, today: DayKey): string {
  const day = dueDay(task);
  if (!day) return "";
  const weekday = weekdayName((parseDay(day).getDay() + 6) % 7);
  const label = day === today ? t("common.today") : `${dueLabel(day, today)} (${weekday})`;
  return task.due_at ? `${label} ${clock(task.due_at)}` : label;
}

export type DeadlineGroupKey = "week" | "month" | "later" | "past";
export const DEADLINE_GROUP_LABELS: Readonly<Record<DeadlineGroupKey, string>> = { get week() { return t("deadlines.group.week"); }, get month() { return t("deadlines.group.month"); }, get later() { return t("deadlines.group.later"); }, get past() { return t("deadlines.group.past"); } };

export interface DeadlineGroup<T> {
  key: DeadlineGroupKey;
  label: string;
  tasks: T[];
}

/**
 * 「締切」: 今週 (through this week's Saturday, the calendar's weeks), 今月 (the rest of this month), それ以降, and
 * 過ぎたもの (over, done or not; the most recent first). Done ones still ahead stay in their group (the row shows ✓).
 * Empty groups are left out.
 */
export function deadlineGroups<T extends DeadlineLike>(tasks: readonly T[], today: DayKey, now: Date = new Date()): DeadlineGroup<T>[] {
  const weekEnd = addDays(weekStart(today), 6);
  const first = parseDay(today);
  const monthEnd = dayKey(new Date(first.getFullYear(), first.getMonth() + 1, 0));
  const buckets: Record<DeadlineGroupKey, T[]> = { week: [], month: [], later: [], past: [] };
  for (const task of tasks) {
    if (!isDeadline(task) || !task.due_on) continue;
    const day = dueDay(task)!;
    if (deadlinePassed(task, today, now)) buckets.past.push(task);
    else if (day <= weekEnd) buckets.week.push(task);
    else if (day <= monthEnd) buckets.month.push(task);
    else buckets.later.push(task);
  }
  for (const key of ["week", "month", "later"] as const) buckets[key].sort(compareDeadlines);
  buckets.past.sort((a, b) => compareDeadlines(b, a));
  return (["week", "month", "later", "past"] as const).filter((key) => buckets[key].length > 0).map((key) => ({ key, label: DEADLINE_GROUP_LABELS[key], tasks: buckets[key] }));
}
