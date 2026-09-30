/**
 * M51 (CALENDAR.md §7): the calendar's date math, in the device's time zone. Days are "YYYY-MM-DD" keys; weeks start on
 * Sunday (日曜始まり, as Japanese wall calendars do) in the month grid and the week view alike. A timed event covers the
 * local days from its start to the instant before its end; an all-day one its dates (the end included), whatever the
 * zone.
 */
import type { CalendarEventCreate, CalendarEventOut, CalendarEventUpdate } from "../api/types";

export type DayKey = string;
export type CalendarMode = "month" | "week" | "list";

/** How far ahead the list (予定の一覧) and a channel's 「予定」 tab read. */
export const LIST_DAYS = 60;
/** The longest events (the server refuses longer ones: 400 calendar_event_too_long). */
export const MAX_TIMED_DAYS = 14;
export const MAX_ALL_DAY_DAYS = 60;
export const MAX_TITLE = 200;
export const MAX_LOCATION = 200;
export const MAX_DESCRIPTION = 4000;
/** A month cell shows this many events, then 「+N」. */
export const MONTH_CELL_EVENTS = 3;

const WEEKDAYS = ["日", "月", "火", "水", "木", "金", "土"];

const pad = (n: number) => String(n).padStart(2, "0");

/** "09:30": for <input type="time"> and for sorting. */
const hhmm = (iso: string) => {
  const date = new Date(iso);
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
};

export function localZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "Asia/Tokyo";
  } catch {
    return "Asia/Tokyo";
  }
}

export function dayKey(date: Date): DayKey {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** Local midnight of a day. */
export function parseDay(key: DayKey): Date {
  const [y, m, d] = key.split("-").map(Number);
  return new Date(y!, m! - 1, d!);
}

export function addDays(key: DayKey, days: number): DayKey {
  const date = parseDay(key);
  date.setDate(date.getDate() + days);
  return dayKey(date);
}

/** Whole days from `a` to `b` (calendar days, not 24-hour spans: a daylight-saving change does not count). */
export function daysBetween(a: DayKey, b: DayKey): number {
  const [ay, am, ad] = a.split("-").map(Number);
  const [by, bm, bd] = b.split("-").map(Number);
  return Math.round((Date.UTC(by!, bm! - 1, bd!) - Date.UTC(ay!, am! - 1, ad!)) / 86_400_000);
}

export function today(now: Date = new Date()): DayKey {
  return dayKey(now);
}

/** The Sunday on or before the day. */
export function weekStart(key: DayKey): DayKey {
  return addDays(key, -parseDay(key).getDay());
}

export function addMonths(key: DayKey, months: number): DayKey {
  const date = parseDay(key);
  return dayKey(new Date(date.getFullYear(), date.getMonth() + months, 1));
}

/** The weeks (Sunday first) that hold the month of `key`: 4 to 6 rows of 7 days. */
export function monthGrid(key: DayKey): DayKey[][] {
  const date = parseDay(key);
  const first = dayKey(new Date(date.getFullYear(), date.getMonth(), 1));
  const last = dayKey(new Date(date.getFullYear(), date.getMonth() + 1, 0));
  const weeks: DayKey[][] = [];
  for (let start = weekStart(first); start <= last; start = addDays(start, 7)) {
    weeks.push(Array.from({ length: 7 }, (_, i) => addDays(start, i)));
  }
  return weeks;
}

/** The days a mode shows around `anchor`: [start, end) (end excluded). The list starts at `anchor` itself. */
export function rangeFor(mode: CalendarMode, anchor: DayKey): { start: DayKey; end: DayKey } {
  if (mode === "month") {
    const weeks = monthGrid(anchor);
    return { start: weeks[0]![0]!, end: addDays(weeks[weeks.length - 1]![6]!, 1) };
  }
  if (mode === "week") {
    const start = weekStart(anchor);
    return { start, end: addDays(start, 7) };
  }
  return { start: anchor, end: addDays(anchor, LIST_DAYS) };
}

/** An instant with the device's offset ("2026-10-01T00:00:00+09:00"): the server reads all-day dates in it. */
export function isoLocal(date: Date): string {
  const offset = -date.getTimezoneOffset();
  const sign = offset >= 0 ? "+" : "-";
  const abs = Math.abs(offset);
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}` +
    `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
  );
}

/** GET /calendar/events's `from` / `to` for the days [start, end). */
export function rangeParams(start: DayKey, end: DayKey): { from: string; to: string } {
  return { from: isoLocal(parseDay(start)), to: isoLocal(parseDay(end)) };
}

type Timing = Pick<CalendarEventOut, "all_day" | "starts_at" | "ends_at" | "start_date" | "end_date">;

/** The first and last local day an event covers. */
export function eventDays(event: Timing): { first: DayKey; last: DayKey } {
  if (event.all_day) return { first: event.start_date!, last: event.end_date! };
  const start = new Date(event.starts_at!);
  const end = new Date(new Date(event.ends_at!).getTime() - 1);
  return { first: dayKey(start), last: dayKey(end < start ? start : end) };
}

export function coversDay(event: Timing, day: DayKey): boolean {
  const { first, last } = eventDays(event);
  return first <= day && day <= last;
}

/**
 * The server's overlap rule (CALENDAR.md §4) for [from, to), both ISO instants: timed events by instant, all-day ones
 * by the local dates of `from` and of the instant before `to`.
 */
export function overlapsRange(event: Timing, from: string, to: string): boolean {
  const start = new Date(from);
  const end = new Date(to);
  if (!event.all_day) return new Date(event.starts_at!) < end && new Date(event.ends_at!) > start;
  const first = dayKey(start);
  const last = dayKey(new Date(end.getTime() - 1));
  return event.start_date! <= last && event.end_date! >= first;
}

/** Earliest first; on a day, all-day events before timed ones; then by title. */
export function compareEvents(a: CalendarEventOut, b: CalendarEventOut): number {
  const ka = a.all_day ? `${a.start_date}T` : `${dayKey(new Date(a.starts_at!))}T${hhmm(a.starts_at!)}`;
  const kb = b.all_day ? `${b.start_date}T` : `${dayKey(new Date(b.starts_at!))}T${hhmm(b.starts_at!)}`;
  return ka < kb ? -1 : ka > kb ? 1 : a.title.localeCompare(b.title, "ja");
}

/** The events on a day, in order. */
export function eventsOn(events: Iterable<CalendarEventOut>, day: DayKey): CalendarEventOut[] {
  return [...events].filter((event) => coversDay(event, day)).sort((a, b) => sortOnDay(a, b, day));
}

function sortOnDay(a: CalendarEventOut, b: CalendarEventOut, day: DayKey): number {
  const rank = (e: CalendarEventOut) => (e.all_day || eventDays(e).first < day ? 0 : 1);
  if (rank(a) !== rank(b)) return rank(a) - rank(b);
  return compareEvents(a, b);
}

/** "14:00" in local time. */
export function clock(iso: string): string {
  const date = new Date(iso);
  return `${date.getHours()}:${pad(date.getMinutes())}`;
}

/** "10月1日 (木)". */
export function dayLabel(key: DayKey): string {
  const date = parseDay(key);
  return `${date.getMonth() + 1}月${date.getDate()}日 (${WEEKDAYS[date.getDay()]})`;
}

export function weekdayLabel(index: number): string {
  return WEEKDAYS[index]!;
}

export function monthLabel(key: DayKey): string {
  const date = parseDay(key);
  return `${date.getFullYear()}年${date.getMonth() + 1}月`;
}

/** The header of a mode's range: 「2026年10月」, 「10月4日 (日) 〜 10月10日 (土)」, 「10月1日 (木) から」. */
export function rangeTitle(mode: CalendarMode, anchor: DayKey): string {
  if (mode === "month") return monthLabel(anchor);
  if (mode === "week") {
    const start = weekStart(anchor);
    return `${dayLabel(start)} 〜 ${dayLabel(addDays(start, 6))}`;
  }
  return `${dayLabel(anchor)} から`;
}

/** What a row says of the time on `day`: 「終日」, 「14:00〜15:30」, 「〜15:30」 (began earlier), 「14:00〜」 (ends later). */
export function timeOnDay(event: Timing, day: DayKey): string {
  if (event.all_day) return "終日";
  const { first, last } = eventDays(event);
  const start = first === day ? clock(event.starts_at!) : "";
  const end = last === day ? clock(event.ends_at!) : "";
  if (!start && !end) return "終日";
  return `${start}〜${end}`;
}

/** The whole time of an event, for its dialog and its row: 「10月1日 (木) 14:00〜15:00」, 「10月1日 (木)〜10月3日 (土) 終日」. */
export function eventWhen(event: Timing): string {
  const { first, last } = eventDays(event);
  if (event.all_day) return first === last ? `${dayLabel(first)} 終日` : `${dayLabel(first)}〜${dayLabel(last)} 終日`;
  const start = `${dayLabel(dayKey(new Date(event.starts_at!)))} ${clock(event.starts_at!)}`;
  const endDay = dayKey(new Date(event.ends_at!));
  const end = endDay === dayKey(new Date(event.starts_at!)) ? clock(event.ends_at!) : `${dayLabel(endDay)} ${clock(event.ends_at!)}`;
  return `${start}〜${end}`;
}

// --- colours -------------------------------------------------------------------------------------

/** One fixed colour per channel (from its id, the same on every device); my own calendar is slate. */
const PALETTE = ["#2563eb", "#16a34a", "#dc2626", "#9333ea", "#0891b2", "#db2777", "#ea580c", "#a16207", "#4f46e5"];
export const OWN_COLOR = "#64748b";

export function channelColor(channelId: string | null): string {
  if (!channelId) return OWN_COLOR;
  let hash = 0x811c9dc5; // FNV-1a
  for (let i = 0; i < channelId.length; i++) {
    hash ^= channelId.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return PALETTE[hash % PALETTE.length]!;
}

// --- alarms --------------------------------------------------------------------------------------

export interface AlarmChoice {
  value: number | null;
  label: string;
}

export const TIMED_ALARMS: AlarmChoice[] = [
  { value: null, label: "なし" },
  { value: 0, label: "開始時" },
  { value: 5, label: "5 分前" },
  { value: 10, label: "10 分前" },
  { value: 15, label: "15 分前" },
  { value: 30, label: "30 分前" },
  { value: 60, label: "1 時間前" },
  { value: 1440, label: "前日 (24 時間前)" },
];

/** An all-day event's alarm goes out at 8:00: the day before (1440) or on the day (-480). */
export const ALL_DAY_ALARMS: AlarmChoice[] = [
  { value: null, label: "なし" },
  { value: 1440, label: "前日 8:00" },
  { value: -480, label: "当日 8:00" },
];

export function alarmChoices(allDay: boolean): AlarmChoice[] {
  return allDay ? ALL_DAY_ALARMS : TIMED_ALARMS;
}

export function alarmLabel(minutes: number | null | undefined, allDay: boolean): string {
  return alarmChoices(allDay).find((choice) => choice.value === (minutes ?? null))?.label ?? "なし";
}

/** The alarm kept when the event turns all-day or back (the server does the same, CALENDAR.md §6). */
export function remapAlarm(minutes: number | null, allDay: boolean): number | null {
  if (minutes === null || minutes === 1440) return minutes;
  if (allDay) return -480;
  return minutes === -480 ? 60 : minutes;
}

// --- the dialog's form ---------------------------------------------------------------------------

/** "me" = my own calendar. */
export type CalendarChoice = "me" | string;

export interface EventDraft {
  title: string;
  allDay: boolean;
  startDay: DayKey;
  /** "HH:MM" (timed events). */
  startTime: string;
  endDay: DayKey;
  endTime: string;
  calendar: CalendarChoice;
  location: string;
  description: string;
  alarm: number | null;
}

/** A new event on `day`: the next whole hour for an hour (today), else 10:00. */
export function newDraft(day: DayKey, calendar: CalendarChoice = "me", now: Date = new Date()): EventDraft {
  let hour = 10;
  if (day === dayKey(now)) hour = Math.min(now.getHours() + 1, 23);
  const endHour = Math.min(hour + 1, 23);
  return {
    title: "",
    allDay: false,
    startDay: day,
    startTime: `${pad(hour)}:00`,
    endDay: day,
    endTime: hour === 23 ? "23:59" : `${pad(endHour)}:00`,
    calendar,
    location: "",
    description: "",
    alarm: null,
  };
}

export function draftFromEvent(event: CalendarEventOut): EventDraft {
  if (event.all_day) {
    return {
      title: event.title,
      allDay: true,
      startDay: event.start_date!,
      startTime: "10:00",
      endDay: event.end_date!,
      endTime: "11:00",
      calendar: event.channel_id ?? "me",
      location: event.location ?? "",
      description: event.description ?? "",
      alarm: event.alarm?.minutes_before ?? null,
    };
  }
  return {
    title: event.title,
    allDay: false,
    startDay: dayKey(new Date(event.starts_at!)),
    startTime: hhmm(event.starts_at!),
    endDay: dayKey(new Date(event.ends_at!)),
    endTime: hhmm(event.ends_at!),
    calendar: event.channel_id ?? "me",
    location: event.location ?? "",
    description: event.description ?? "",
    alarm: event.alarm?.minutes_before ?? null,
  };
}

function instant(day: DayKey, time: string): Date {
  return new Date(`${day}T${time}`);
}

/** What stops the form from being saved (the server's rules, said first here), or null. */
export function draftProblem(draft: EventDraft): string | null {
  const title = draft.title.trim();
  if (!title) return "題名を入れてください";
  if (title.length > MAX_TITLE) return `題名は ${MAX_TITLE} 文字までです`;
  if (draft.location.trim().length > MAX_LOCATION) return `場所は ${MAX_LOCATION} 文字までです`;
  if (draft.description.trim().length > MAX_DESCRIPTION) return `説明は ${MAX_DESCRIPTION} 文字までです`;
  if (!draft.startDay || !draft.endDay) return "日付を入れてください";
  if (draft.allDay) {
    if (draft.endDay < draft.startDay) return "終了日は開始日より後にしてください";
    if (daysBetween(draft.startDay, draft.endDay) >= MAX_ALL_DAY_DAYS) return `終日の予定は ${MAX_ALL_DAY_DAYS} 日までです`;
    return null;
  }
  if (!draft.startTime || !draft.endTime) return "時刻を入れてください";
  const start = instant(draft.startDay, draft.startTime);
  const end = instant(draft.endDay, draft.endTime);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return "日時を正しく入れてください";
  if (end <= start) return "終了は開始より後にしてください";
  if (end.getTime() - start.getTime() > MAX_TIMED_DAYS * 86_400_000) return `時刻の予定は ${MAX_TIMED_DAYS} 日までです`;
  return null;
}

function timing(draft: EventDraft): Pick<CalendarEventCreate, "all_day" | "starts_at" | "ends_at" | "start_date" | "end_date"> {
  if (draft.allDay) return { all_day: true, starts_at: null, ends_at: null, start_date: draft.startDay, end_date: draft.endDay };
  return {
    all_day: false,
    starts_at: instant(draft.startDay, draft.startTime).toISOString(),
    ends_at: instant(draft.endDay, draft.endTime).toISOString(),
    start_date: null,
    end_date: null,
  };
}

/** POST /calendar/events: local times become UTC instants, all-day days stay dates. */
export function draftToCreate(draft: EventDraft, tz: string, clientEventId: string): CalendarEventCreate {
  return {
    channel_id: draft.calendar === "me" ? null : draft.calendar,
    title: draft.title.trim(),
    ...timing(draft),
    location: draft.location.trim() || null,
    description: draft.description.trim() || null,
    alarm_minutes: draft.alarm,
    tz,
    client_event_id: clientEventId,
  };
}

/** PATCH /calendar/events/{id}: the whole form (its calendar cannot move). */
export function draftToPatch(draft: EventDraft): CalendarEventUpdate {
  return {
    title: draft.title.trim(),
    ...timing(draft),
    location: draft.location.trim() || null,
    description: draft.description.trim() || null,
  };
}

// --- the week view -------------------------------------------------------------------------------

export interface WeekBlock {
  event: CalendarEventOut;
  /** Minutes after the day's midnight, clipped to the day. */
  top: number;
  height: number;
  lane: number;
  lanes: number;
}

/** A day column's timed events: where each sits, side by side where they overlap. */
export function dayBlocks(events: Iterable<CalendarEventOut>, day: DayKey): WeekBlock[] {
  const dayStart = parseDay(day).getTime();
  const dayEnd = parseDay(addDays(day, 1)).getTime();
  const span = (dayEnd - dayStart) / 60_000;
  const items = [...events]
    .filter((e) => !e.all_day && coversDay(e, day))
    .map((event) => {
      const start = Math.max(new Date(event.starts_at!).getTime(), dayStart);
      const end = Math.min(new Date(event.ends_at!).getTime(), dayEnd);
      const top = ((start - dayStart) / 60_000 / span) * 1440;
      return { event, top, height: Math.max(((end - start) / 60_000 / span) * 1440, 20) };
    })
    .sort((a, b) => a.top - b.top || b.height - a.height);
  const blocks: WeekBlock[] = [];
  let cluster: WeekBlock[] = [];
  let clusterEnd = -1;
  const close = () => {
    const lanes = Math.max(1, ...cluster.map((b) => b.lane + 1));
    for (const block of cluster) block.lanes = lanes;
    cluster = [];
  };
  for (const item of items) {
    if (item.top >= clusterEnd) close();
    const taken = new Set(cluster.filter((b) => b.top + b.height > item.top).map((b) => b.lane));
    let lane = 0;
    while (taken.has(lane)) lane++;
    const block: WeekBlock = { ...item, lane, lanes: 1 };
    cluster.push(block);
    blocks.push(block);
    clusterEnd = Math.max(clusterEnd, item.top + item.height);
  }
  close();
  return blocks;
}
