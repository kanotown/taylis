/**
 * L6 (M59, RECURRING.md): recurring posts and their collections — the summaries, the dialog's draft and its checks, and
 * the collection chip under a post. Pure, so the three clients' wording can be checked in tests.
 */
import type { CollectionOut, CollectSpec, RecurringPostCreate, RecurringPostOut, RecurringPostUpdate, RecurringSchedule } from "../api/types";
import type { ChannelState } from "../sync/types";
import { t, weekdayName } from "../i18n";

/** The {weekday} placeholder expands on the server in Japanese (shared channel content), so the preview hint does too. */
const JS_WEEKDAYS = ["日", "月", "火", "水", "木", "金", "土"] as const;
export const MAX_RECURRING_NAME = 40;
export const MAX_RECURRING_BODY = 4000;
export const MAX_AFTER_DAYS = 30;
const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** "09:00" → "9:00". */
export function clockLabel(time: string): string {
  const match = TIME.exec(time);
  return match ? `${Number(match[1])}:${match[2]}` : time;
}

/** 「毎週 月・木 9:00」, 「毎日 9:00」, 「毎月 1 日 9:00」, 「毎月 末日 18:00」; the zone when it is not this device's. */
export function scheduleSummary(schedule: RecurringSchedule, tz?: string, localTz?: string): string {
  let text: string;
  if (schedule.kind === "weekly") {
    const days = [...schedule.weekdays].sort((a, b) => a - b);
    text = days.length === 7 ? t("recurring.daily", { time: clockLabel(schedule.time) }) : t("recurring.weekly", { days: days.map((d) => weekdayName(d)).join(t("recurring.daySeparator")), time: clockLabel(schedule.time) });
  } else {
    text = t("recurring.monthly", { day: monthDayLabel(schedule.day), time: clockLabel(schedule.time) });
  }
  return tz && localTz && tz !== localTz ? `${text} (${tz})` : text;
}

/** 「当日 18:00 締切」 / 「3 日後 18:00 締切」. */
export function dueSummary(due: CollectSpec["due"]): string {
  return t("recurring.due", { day: due.after_days === 0 ? t("recurring.sameDay") : t("recurring.daysAfter", { count: due.after_days }), time: clockLabel(due.time) });
}

/** 「1 日」 「末日」 「29 日 (ない月は末日)」 (the monthly choice). */
export function monthDayLabel(day: number): string {
  return day === 31 ? t("recurring.lastDay") : day >= 29 ? t("recurring.dayOrLast", { day }) : t("recurring.dayOfMonth", { day });
}

/** 「10/9 (金) 18:00」 on this device's calendar. */
export function shortDateTime(iso: string): string {
  const date = new Date(iso);
  return `${t("common.monthDayWeekday", { month: date.getMonth() + 1, day: date.getDate(), weekday: weekdayName((date.getDay() + 6) % 7) })} ${date.getHours()}:${String(date.getMinutes()).padStart(2, "0")}`;
}

/** Whom it collects from, as one line (names from the caller's maps). */
export function targetsSummary(spec: CollectSpec, groupName: (id: string) => string | undefined, userName: (id: string) => string | undefined): string {
  if (spec.targets.all_members) return t("recurring.allMembers");
  const names = [
    ...(spec.targets.group_ids ?? []).map((id) => `@${groupName(id) ?? t("composer.group")}`),
    ...(spec.targets.user_ids ?? []).map((id) => userName(id) ?? "?"),
  ];
  return names.length > 4 ? t("recurring.namesAndMore", { names: names.slice(0, 4).join(t("common.listSeparator")), count: names.length - 4 }) : names.join(t("common.listSeparator"));
}

/** Owners and the administrators among the members of a channel (not a DM) manage its recurring posts. */
export function canManageRecurring(channel: ChannelState | undefined, isAdmin: boolean): boolean {
  if (!channel || !channel.isMember || (channel.type !== "public" && channel.type !== "private")) return false;
  return isAdmin || channel.membership?.role === "owner";
}

// --- the dialog's draft ------------------------------------------------------------------------------------------

export interface RecurringDraft {
  name: string;
  body: string;
  kind: "weekly" | "monthly";
  /** 0 = Monday. */
  weekdays: number[];
  day: number;
  time: string;
  collect: boolean;
  allMembers: boolean;
  groupIds: string[];
  userIds: string[];
  afterDays: number;
  dueTime: string;
}

export function emptyDraft(now: Date = new Date()): RecurringDraft {
  // Today's weekday (Monday = 0), 9:00; collecting off, due three days later at 18:00 when turned on.
  return {
    name: "",
    body: "",
    kind: "weekly",
    weekdays: [(now.getDay() + 6) % 7],
    day: 1,
    time: "09:00",
    collect: false,
    allMembers: false,
    groupIds: [],
    userIds: [],
    afterDays: 3,
    dueTime: "18:00",
  };
}

export function draftFromPost(post: RecurringPostOut): RecurringDraft {
  const base = emptyDraft();
  const schedule = post.schedule;
  return {
    ...base,
    name: post.name,
    body: post.body,
    kind: schedule.kind,
    weekdays: schedule.kind === "weekly" ? [...schedule.weekdays] : base.weekdays,
    day: schedule.kind === "monthly" ? schedule.day : base.day,
    time: schedule.time,
    collect: !!post.collect,
    allMembers: post.collect?.targets.all_members ?? false,
    groupIds: [...(post.collect?.targets.group_ids ?? [])],
    userIds: [...(post.collect?.targets.user_ids ?? [])],
    afterDays: post.collect?.due.after_days ?? base.afterDays,
    dueTime: post.collect?.due.time ?? base.dueTime,
  };
}

/** What keeps the draft from being saved, in words; null when it can be. The server checks the same. */
export function recurringDraftProblem(draft: RecurringDraft): string | null {
  const name = draft.name.trim().split(/\s+/).join(" ");
  if (!name) return t("reservations.check.name");
  if ([...name].length > MAX_RECURRING_NAME) return t("workflow.check.nameTooLong", { max: MAX_RECURRING_NAME });
  if (!draft.body.trim()) return t("recurring.check.body");
  if (draft.body.length > MAX_RECURRING_BODY) return t("recurring.check.bodyTooLong", { max: MAX_RECURRING_BODY });
  if (draft.kind === "weekly" && draft.weekdays.length === 0) return t("recurring.check.weekdays");
  if (draft.kind === "monthly" && !(Number.isInteger(draft.day) && draft.day >= 1 && draft.day <= 31)) return t("recurring.check.day");
  if (!TIME.test(draft.time)) return t("recurring.check.time");
  if (draft.collect) {
    if (!draft.allMembers && draft.groupIds.length === 0 && draft.userIds.length === 0) return t("recurring.check.targets");
    if (!(Number.isInteger(draft.afterDays) && draft.afterDays >= 0 && draft.afterDays <= MAX_AFTER_DAYS)) return t("recurring.check.afterDays", { max: MAX_AFTER_DAYS });
    if (!TIME.test(draft.dueTime)) return t("recurring.check.dueTime");
  }
  return null;
}

function scheduleOf(draft: RecurringDraft): RecurringSchedule {
  return draft.kind === "weekly"
    ? { kind: "weekly", weekdays: [...new Set(draft.weekdays)].sort((a, b) => a - b), time: draft.time }
    : { kind: "monthly", day: draft.day, time: draft.time };
}

function collectOf(draft: RecurringDraft): CollectSpec | null {
  if (!draft.collect) return null;
  return {
    targets: draft.allMembers ? { all_members: true, group_ids: [], user_ids: [] } : { all_members: false, group_ids: [...draft.groupIds], user_ids: [...draft.userIds] },
    due: { after_days: draft.afterDays, time: draft.dueTime },
  };
}

/** POST body; `tz` is this device's zone (the schedule's and the due time's). */
export function createBody(draft: RecurringDraft, tz: string): RecurringPostCreate {
  return { name: draft.name.trim(), body: draft.body, schedule: scheduleOf(draft), tz, collect: collectOf(draft), enabled: true };
}

/** PATCH body: everything the dialog shows (the zone stays the post's). */
export function updateBody(draft: RecurringDraft): RecurringPostUpdate {
  return { name: draft.name.trim(), body: draft.body, schedule: scheduleOf(draft), collect: collectOf(draft) };
}

/** The body's placeholders as they would read today (the dialog's hint). */
export function placeholderHint(today: Date = new Date()): string {
  const y = today.getFullYear();
  const m = String(today.getMonth() + 1).padStart(2, "0");
  const d = String(today.getDate()).padStart(2, "0");
  const weekday = JS_WEEKDAYS[today.getDay()];
  return t("recurring.placeholderHint", { example: `${y}/${m}/${d} (${weekday})`, weekdayValue: weekday, weekValue: isoWeek(today) });
}

function isoWeek(today: Date): string {
  const day = Date.UTC(today.getFullYear(), today.getMonth(), today.getDate()) / 86_400_000;
  const thursday = day - ((new Date(day * 86_400_000).getUTCDay() + 6) % 7) + 3;
  const year = new Date(thursday * 86_400_000).getUTCFullYear();
  const week = Math.floor((thursday - Date.UTC(year, 0, 1) / 86_400_000) / 7) + 1;
  return `${year}-W${String(week).padStart(2, "0")}`;
}

// --- the chip under a collecting post ------------------------------------------------------------------------------

export interface CollectionChipState {
  /** 「提出 7/10 · 締切 10/9 (金) 18:00」 */
  label: string;
  /** Me as a target: whether I have replied; null when I am not one. */
  mine: "pending" | "submitted" | null;
  overdue: boolean;
  /** Everyone has submitted. */
  complete: boolean;
}

export function collectionChip(collection: CollectionOut, meId: string | null | undefined, now: Date = new Date()): CollectionChipState {
  const submitted = collection.submitted_user_ids.length;
  const isTarget = !!meId && collection.target_user_ids.includes(meId);
  return {
    label: t("recurring.chip", { submitted, total: collection.target_count, due: shortDateTime(collection.due_at) }),
    mine: isTarget ? (collection.submitted_user_ids.includes(meId!) ? "submitted" : "pending") : null,
    overdue: Date.parse(collection.due_at) <= now.getTime(),
    complete: collection.target_count > 0 && submitted >= collection.target_count,
  };
}

/** The dialog's two lists: 提出済み and 未提出, each in the targets' order. */
export function collectionLists(collection: CollectionOut): { submitted: string[]; missing: string[] } {
  const done = new Set(collection.submitted_user_ids);
  return {
    submitted: collection.target_user_ids.filter((id) => done.has(id)),
    missing: collection.target_user_ids.filter((id) => !done.has(id)),
  };
}
