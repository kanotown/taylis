/**
 * M68 (CALENDAR.md §10): the 「繰り返し」 picker of an event's dialog and the words for a rule. The server stores a subset
 * of RFC 5545's RRULE (FREQ DAILY / WEEKLY / MONTHLY / YEARLY, INTERVAL, BYDAY, BYMONTHDAY, UNTIL as a date or COUNT) and
 * expands it; this module only turns the picker into such a rule (normalized as the server does) and a rule back into
 * the picker and into Japanese (「毎週 火・木曜日、12月20日まで」). Weekdays here are JavaScript's (0 = Sunday).
 */
import { type DayKey, parseDay } from "./calendarDates";

export type RepeatKind = "none" | "daily" | "weekly" | "monthly" | "yearly" | "custom";
export type RepeatFreq = "DAILY" | "WEEKLY" | "MONTHLY" | "YEARLY";
/** 毎月: the same date (「10 日」), the month's last day (「月末」), the nth weekday (「第 2 火曜日」) or the last such weekday (「最終 金曜日」). */
export type MonthlyMode = "day" | "monthEnd" | "nth" | "last";
export type RepeatEnd = "never" | "until" | "count";

export interface RepeatDraft {
  kind: RepeatKind;
  /** カスタム: what repeats every `interval`. The presets use their own. */
  freq: RepeatFreq;
  interval: number;
  /** 毎週: the weekdays (0 = Sunday). */
  weekdays: number[];
  monthly: MonthlyMode;
  end: RepeatEnd;
  /** The last day (included) when `end` is "until". */
  until: DayKey;
  count: number;
}

export const MAX_INTERVAL = 99;
export const MAX_COUNT = 999;

const CODES = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];
const NAMES = ["日", "月", "火", "水", "木", "金", "土"];
/** The server's order (RFC 5545's default week start): Monday first. */
const MONDAY_FIRST = [1, 2, 3, 4, 5, 6, 0];

export function noRepeat(start: DayKey): RepeatDraft {
  return { kind: "none", freq: "WEEKLY", interval: 1, weekdays: [parseDay(start).getDay()], monthly: "day", end: "never", until: "", count: 10 };
}

/** Which week of its month a day is in (1-5), and whether it is that weekday's last in the month. */
export function nthOfMonth(day: DayKey): { n: number; last: boolean } {
  const date = parseDay(day);
  const n = Math.ceil(date.getDate() / 7);
  const daysInMonth = new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate();
  return { n, last: date.getDate() + 7 > daysInMonth };
}

function freqOf(draft: RepeatDraft): RepeatFreq | null {
  switch (draft.kind) {
    case "none":
      return null;
    case "daily":
      return "DAILY";
    case "weekly":
      return "WEEKLY";
    case "monthly":
      return "MONTHLY";
    case "yearly":
      return "YEARLY";
    case "custom":
      return draft.freq;
  }
}

const compact = (day: DayKey) => day.replaceAll("-", "");

/** The rule for the picker (null: しない), normalized the way the server stores it. */
export function repeatToRrule(draft: RepeatDraft, start: DayKey): string | null {
  const freq = freqOf(draft);
  if (!freq) return null;
  const parts = [`FREQ=${freq}`];
  const interval = draft.kind === "custom" ? Math.min(Math.max(Math.round(draft.interval) || 1, 1), MAX_INTERVAL) : 1;
  if (interval !== 1) parts.push(`INTERVAL=${interval}`);
  if (freq === "WEEKLY") {
    const days = draft.weekdays.length ? draft.weekdays : [parseDay(start).getDay()];
    parts.push(`BYDAY=${MONDAY_FIRST.filter((d) => days.includes(d)).map((d) => CODES[d]).join(",")}`);
  } else if (freq === "MONTHLY") {
    const date = parseDay(start);
    if (draft.monthly === "nth") parts.push(`BYDAY=${nthOfMonth(start).n}${CODES[date.getDay()]}`);
    else if (draft.monthly === "last") parts.push(`BYDAY=-1${CODES[date.getDay()]}`);
    else if (draft.monthly === "monthEnd") parts.push("BYMONTHDAY=-1");
    else parts.push(`BYMONTHDAY=${date.getDate()}`);
  }
  if (draft.end === "until" && draft.until) parts.push(`UNTIL=${compact(draft.until)}`);
  else if (draft.end === "count") parts.push(`COUNT=${Math.min(Math.max(Math.round(draft.count) || 1, 1), MAX_COUNT)}`);
  return parts.join(";");
}

interface ParsedRule {
  freq: RepeatFreq;
  interval: number;
  byday: Array<{ n: number | null; weekday: number }>;
  bymonthday: number | null;
  until: DayKey | null;
  count: number | null;
}

/** A rule as the server sends it (null when it is not one this client understands). */
export function parseRrule(rrule: string): ParsedRule | null {
  const fields = new Map<string, string>();
  for (const part of rrule.replace(/^RRULE:/i, "").split(";")) {
    const [name, value] = part.split("=");
    if (!name || value === undefined) return null;
    fields.set(name.toUpperCase(), value.toUpperCase());
  }
  const freq = fields.get("FREQ");
  if (freq !== "DAILY" && freq !== "WEEKLY" && freq !== "MONTHLY" && freq !== "YEARLY") return null;
  const byday: ParsedRule["byday"] = [];
  for (const item of (fields.get("BYDAY") ?? "").split(",").filter(Boolean)) {
    const match = /^([+-]?\d)?(SU|MO|TU|WE|TH|FR|SA)$/.exec(item);
    if (!match) return null;
    byday.push({ n: match[1] ? Number(match[1]) : null, weekday: CODES.indexOf(match[2]!) });
  }
  const until = fields.get("UNTIL");
  return {
    freq,
    interval: Number(fields.get("INTERVAL") ?? "1") || 1,
    byday,
    bymonthday: fields.has("BYMONTHDAY") ? Number(fields.get("BYMONTHDAY")) : null,
    until: until && /^\d{8}$/.test(until) ? `${until.slice(0, 4)}-${until.slice(4, 6)}-${until.slice(6, 8)}` : null,
    count: fields.has("COUNT") ? Number(fields.get("COUNT")) : null,
  };
}

/** The picker for an event's rule (null rule: しない). `start` is the day the picker shows (the opened occurrence's). */
export function rruleToRepeat(rrule: string | null | undefined, start: DayKey): RepeatDraft {
  const draft = noRepeat(start);
  const rule = rrule ? parseRrule(rrule) : null;
  if (!rule) return draft;
  const kinds: Record<RepeatFreq, RepeatKind> = { DAILY: "daily", WEEKLY: "weekly", MONTHLY: "monthly", YEARLY: "yearly" };
  draft.kind = rule.interval !== 1 ? "custom" : kinds[rule.freq];
  draft.freq = rule.freq;
  draft.interval = rule.interval;
  if (rule.freq === "WEEKLY" && rule.byday.length) draft.weekdays = rule.byday.map((d) => d.weekday);
  if (rule.freq === "MONTHLY") {
    const nth = rule.byday[0]?.n ?? null;
    draft.monthly = nth === null ? (rule.bymonthday === -1 ? "monthEnd" : "day") : nth < 0 ? "last" : "nth";
  }
  if (rule.until) {
    draft.end = "until";
    draft.until = rule.until;
  } else if (rule.count) {
    draft.end = "count";
    draft.count = rule.count;
  }
  return draft;
}

/**
 * Whether the picker says something other than the event's rule (a change for 「これ以降」 / 「すべて」 only). The event's
 * rule is read through the picker first, so the defaults a rule may leave out (the start's weekday or date) compare alike.
 */
export function ruleChanged(draft: RepeatDraft, start: DayKey, rrule: string | null | undefined): boolean {
  const before = rrule ? repeatToRrule(rruleToRepeat(rrule, start), start) : null;
  return (repeatToRrule(draft, start) ?? null) !== before;
}

function weekdayList(days: number[]): string {
  return MONDAY_FIRST.filter((d) => days.includes(d)).map((d) => NAMES[d]).join("・");
}

function shortDay(day: DayKey): string {
  const date = parseDay(day);
  return `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日`;
}

/**
 * A rule in words: 「毎日」「3 日ごと」「毎週 火・木曜日」「2 週間ごと 月曜日」「毎月 10 日」「毎月 月末」「毎月 第 2 火曜日」「毎月 最終 金曜日」
 * 「毎年 1月10日」, then 「、2026年12月20日まで」 or 「、10 回」. `start` is the series' first day (its date, its weekday).
 */
export function describeRrule(rrule: string | null | undefined, start: DayKey): string {
  if (!rrule) return "繰り返さない";
  const rule = parseRrule(rrule);
  if (!rule) return "繰り返し";
  const date = parseDay(start);
  const every = (unit: string, one: string) => (rule.interval === 1 ? one : `${rule.interval} ${unit}ごと`);
  let text: string;
  switch (rule.freq) {
    case "DAILY":
      text = every("日", "毎日");
      break;
    case "WEEKLY": {
      const days = rule.byday.length ? rule.byday.map((d) => d.weekday) : [date.getDay()];
      text = `${every("週間", "毎週")} ${weekdayList(days)}曜日`;
      break;
    }
    case "MONTHLY": {
      const nth = rule.byday[0];
      let which: string;
      if (nth && nth.n !== null) which = `${nth.n < 0 ? "最終" : `第 ${nth.n}`} ${NAMES[nth.weekday]}曜日`;
      else if (rule.bymonthday === -1) which = "月末";
      else which = `${rule.bymonthday ?? date.getDate()} 日`;
      text = `${every("か月", "毎月")} ${which}`;
      break;
    }
    case "YEARLY":
      text = `${every("年", "毎年")} ${date.getMonth() + 1}月${date.getDate()}日`;
      break;
  }
  if (rule.until) text += `、${shortDay(rule.until)}まで`;
  else if (rule.count) text += `、${rule.count} 回`;
  return text;
}

/** The picker's choices for 毎月 on a day: 「毎月 10 日」, 「毎月 第 2 火曜日」 and, in a month's last week, 「毎月 最終 火曜日」. */
export function monthlyChoices(start: DayKey): Array<{ value: MonthlyMode; label: string }> {
  const date = parseDay(start);
  const { n, last } = nthOfMonth(start);
  const weekday = NAMES[date.getDay()];
  const choices: Array<{ value: MonthlyMode; label: string }> = [{ value: "day", label: `毎月 ${date.getDate()} 日` }];
  if (new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate() === date.getDate()) choices.push({ value: "monthEnd", label: "毎月 月末" });
  if (n <= 4) choices.push({ value: "nth", label: `毎月 第 ${n} ${weekday}曜日` });
  if (last) choices.push({ value: "last", label: `毎月 最終 ${weekday}曜日` });
  return choices;
}

/** What stops the picker from being saved, or null. */
export function repeatProblem(draft: RepeatDraft, start: DayKey): string | null {
  if (draft.kind === "none") return null;
  if (draft.kind === "custom" && (!Number.isInteger(draft.interval) || draft.interval < 1 || draft.interval > MAX_INTERVAL)) {
    return `間隔は 1〜${MAX_INTERVAL} にしてください`;
  }
  if ((freqOf(draft) === "WEEKLY") && draft.weekdays.length === 0) return "曜日を選んでください";
  if (draft.end === "until") {
    if (!draft.until) return "終了日を入れてください";
    if (draft.until < start) return "終了日は開始日より後にしてください";
  }
  if (draft.end === "count" && (!Number.isInteger(draft.count) || draft.count < 1 || draft.count > MAX_COUNT)) {
    return `回数は 1〜${MAX_COUNT} にしてください`;
  }
  return null;
}

export { NAMES as WEEKDAY_NAMES };
