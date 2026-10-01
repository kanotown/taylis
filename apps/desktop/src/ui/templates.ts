/**
 * Post templates and /日程 (M30, DATA_MODEL.md message_templates): the rules the three clients share. Checked against
 * apps/shared/templates.json. Dates are the device's local calendar dates.
 */

import type { TemplateOut } from "../api/types";

const WEEKDAYS = ["日", "月", "火", "水", "木", "金", "土"] as const;
const DAY_MS = 86_400_000;

/** A calendar date without a time or a zone. */
interface Day {
  y: number;
  m: number;
  d: number;
}

function dayOf(date: Date): Day {
  return { y: date.getFullYear(), m: date.getMonth() + 1, d: date.getDate() };
}

/** Days since 1970-01-01 (UTC arithmetic, so no daylight-saving hour gets in the way). */
function dayNumber(day: Day): number {
  return Date.UTC(day.y, day.m - 1, day.d) / DAY_MS;
}

function fromNumber(n: number): Day {
  const date = new Date(n * DAY_MS);
  return { y: date.getUTCFullYear(), m: date.getUTCMonth() + 1, d: date.getUTCDate() };
}

function weekdayOf(day: Day): number {
  return new Date(dayNumber(day) * DAY_MS).getUTCDay();
}

function isRealDay(day: Day): boolean {
  if (day.m < 1 || day.m > 12 || day.d < 1) return false;
  return day.d <= new Date(Date.UTC(day.y, day.m, 0)).getUTCDate();
}

const pad = (n: number) => String(n).padStart(2, "0");

/** ISO 8601 week: `2026-W40` (the year is the week's, so 2027/01/01 is in `2026-W53`). */
function isoWeek(day: Day): string {
  // The week belongs to the year of its Thursday; week 1 holds that year's first Thursday.
  const thursdayN = dayNumber(day) - ((weekdayOf(day) + 6) % 7) + 3;
  const year = fromNumber(thursdayN).y;
  const week = Math.floor((thursdayN - dayNumber({ y: year, m: 1, d: 1 })) / 7) + 1;
  return `${year}-W${pad(week)}`;
}

/** `{date}` `{weekday}` `{week}` replaced once (the result is not read again); any other `{…}` stays. */
export function expandTemplate(body: string, today: Date = new Date()): string {
  const day = dayOf(today);
  const weekday = WEEKDAYS[weekdayOf(day)]!;
  return body.replace(/\{(date|weekday|week)\}/g, (_, key: string) => {
    if (key === "date") return `${day.y}/${pad(day.m)}/${pad(day.d)} (${weekday})`;
    if (key === "weekday") return weekday;
    return isoWeek(day);
  });
}

/** What the input holds after the 「テンプレート」 button: the body alone when empty, else after a blank line. */
export function appendTemplate(text: string, body: string): string {
  return text.trim() ? `${text.trimEnd()}\n\n${body}` : body;
}

/** What `/name text` becomes: the body, then a line break and the text when there is any. */
export function templateWithText(body: string, text: string): string {
  return text ? `${body}\n${text}` : body;
}

// --- /日程 -----------------------------------------------------------------------------------

export const SCHEDULE_USAGE = "/日程 [題名] 日付 … (例: /日程 ゼミ 10/3 10/5-10/7 13:00)";
export const SCHEDULE_QUESTION = "日程調整";
const MAX_RANGE_DAYS = 14;
const MIN_OPTIONS = 2;
const MAX_OPTIONS = 10;

const DATE = String.raw`(?:(\d{4})/)?(\d{1,2})/(\d{1,2})`;
const DATE_TOKEN = new RegExp(String.raw`^${DATE}(?:[-〜~](?:${DATE}|(\d{1,2})))?$`);
const TIME_TOKEN = /^(\d{1,2}):(\d{2})(?:[-〜~](\d{1,2}):(\d{2}))?$/;

function label(day: Day, thisYear: number): string {
  const date = day.y === thisYear ? `${day.m}/${day.d}` : `${day.y}/${day.m}/${day.d}`;
  return `${date} (${WEEKDAYS[weekdayOf(day)]})`;
}

/** Minutes since midnight, or null when not a time of day. */
function minutes(h: string, mm: string): number | null {
  const hour = Number(h);
  const minute = Number(mm);
  return hour <= 23 && minute <= 59 ? hour * 60 + minute : null;
}

const clock = (total: number) => `${Math.floor(total / 60)}:${pad(total % 60)}`;

/** One date read from `/日程` arguments, with its time of day when one followed it (minutes since midnight). */
export interface ScheduleEntry {
  /** "YYYY-MM-DD". */
  day: string;
  from: number | null;
  to: number | null;
}

/**
 * The grammar of `/日程 [質問] 日付 …` (apps/shared/templates.json): the question and every date (a range gives each of
 * its days) with the time after it; null when the arguments cannot be read. No limit on how many.
 */
export function readSchedule(args: string, today: Date = new Date()): { question: string; entries: ScheduleEntry[] } | null {
  const now = dayOf(today);
  const todayN = dayNumber(now);
  const words = args.split(/\s+/).filter(Boolean);
  const first = words.findIndex((w) => DATE_TOKEN.test(w));
  if (first < 0) return null;
  const question = words.slice(0, first).join(" ") || SCHEDULE_QUESTION;
  const entries: ScheduleEntry[] = [];
  let last: Day[] | null = null; // the days of the date just read, waiting for a time
  const flush = (from: number | null, to: number | null) => {
    for (const day of last ?? []) entries.push({ day: `${day.y}-${pad(day.m)}-${pad(day.d)}`, from, to });
    last = null;
  };
  for (const word of words.slice(first)) {
    const date = DATE_TOKEN.exec(word);
    if (date) {
      flush(null, null);
      const [, y1, m1, d1, y2, m2, d2, dayOnly] = date;
      const start: Day = { y: y1 ? Number(y1) : now.y, m: Number(m1), d: Number(d1) };
      if (!isRealDay(start)) return null;
      // A date without a year is this year's, or next year's when that is more than 30 days ago.
      if (!y1 && todayN - dayNumber(start) > 30) start.y += 1;
      if (!isRealDay(start)) return null; // 2/29 of a year that has none
      let end = start;
      if (m2 !== undefined) {
        end = { y: y2 ? Number(y2) : start.y, m: Number(m2), d: Number(d2) };
        if (!isRealDay(end)) return null;
        if (!y2 && dayNumber(end) < dayNumber(start)) end = { ...end, y: end.y + 1 };
        if (!isRealDay(end)) return null;
      } else if (dayOnly !== undefined) {
        end = { y: start.y, m: start.m, d: Number(dayOnly) };
        if (!isRealDay(end)) return null;
      }
      const span = dayNumber(end) - dayNumber(start) + 1;
      if (span < 1 || span > MAX_RANGE_DAYS) return null;
      const days: Day[] = [];
      for (let n = dayNumber(start); n <= dayNumber(end); n++) days.push(fromNumber(n));
      last = days;
      continue;
    }
    const time = TIME_TOKEN.exec(word);
    if (!time || !last) return null; // not a date, or a time that does not follow one
    const from = minutes(time[1]!, time[2]!);
    if (from === null) return null;
    let to: number | null = null;
    if (time[3] !== undefined) {
      to = minutes(time[3], time[4]!);
      if (to === null || to <= from) return null;
    }
    flush(from, to);
  }
  flush(null, null);
  return { question, entries };
}

/**
 * `/日程 [質問] 日付 …` → a multiple-choice poll's question and options; null when the arguments cannot be read (the
 * command then posts nothing and shows its usage). The phones' `/日程` until M54; the Web makes a scheduling poll from
 * readSchedule since M53.
 */
export function parseSchedule(args: string, today: Date = new Date()): { question: string; options: string[] } | null {
  const read = readSchedule(args, today);
  if (!read) return null;
  const thisYear = today.getFullYear();
  const labels = read.entries.map((entry) => {
    const [y, m, d] = entry.day.split("-").map(Number);
    let text = label({ y: y!, m: m!, d: d! }, thisYear);
    if (entry.from !== null) text += ` ${clock(entry.from)}`;
    if (entry.to !== null) text += `〜${clock(entry.to)}`;
    return text;
  });
  const options = [...new Set(labels)];
  if (options.length < MIN_OPTIONS || options.length > MAX_OPTIONS) return null;
  return { question: read.question, options };
}

/** The options `/日程` alone offers: the next `count` weekdays after today. */
export function nextWeekdays(today: Date = new Date(), count = 5): string[] {
  const now = dayOf(today);
  const out: string[] = [];
  for (let n = dayNumber(now) + 1; out.length < count; n++) {
    const day = fromNumber(n);
    const weekday = weekdayOf(day);
    if (weekday !== 0 && weekday !== 6) out.push(label(day, now.y));
  }
  return out;
}

// --- choosing ---------------------------------------------------------------------------------

/** The workspace's, then mine, each by position then name; in a times channel the `suggest_in = times` ones first. */
export function orderTemplates(templates: Iterable<TemplateOut>, inTimes = false): TemplateOut[] {
  const rows = [...templates].sort(
    (a, b) =>
      Number(a.scope === "user") - Number(b.scope === "user") ||
      a.position - b.position ||
      a.name.localeCompare(b.name, "ja"),
  );
  if (!inTimes) return rows;
  return [...rows.filter((t) => t.suggest_in === "times"), ...rows.filter((t) => t.suggest_in !== "times")];
}

const key = (name: string) => name.normalize("NFC").toLowerCase();

/** The template `/name` means (case-insensitive); my own wins over the workspace's of the same name. */
export function findTemplate(templates: Iterable<TemplateOut>, name: string): TemplateOut | null {
  const wanted = key(name);
  let found: TemplateOut | null = null;
  for (const row of templates) {
    if (key(row.name) !== wanted) continue;
    if (row.scope === "user") return row;
    found = row;
  }
  return found;
}

/** Templates whose name starts with what follows the `/` (the whole input is `/…`, no space yet). */
export function templateCandidates(text: string, ordered: readonly TemplateOut[]): TemplateOut[] {
  const match = /^\/([\p{L}\p{N}_-]*)$/u.exec(text);
  if (!match) return [];
  const prefix = key(match[1]!);
  return ordered.filter((t) => key(t.name).startsWith(prefix));
}

/** The first line with text, without its bold marks: what the lists show under a template's name (as on iOS / Android). */
export function templateSummary(body: string): string {
  return (body.split("\n").find((line) => line.trim())?.trim() ?? "").replaceAll("**", "");
}
