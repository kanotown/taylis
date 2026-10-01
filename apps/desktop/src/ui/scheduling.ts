/**
 * M53 (docs/SCHEDULING.md): scheduling polls (日程調整) — the form's candidates, their labels and the card's reading of
 * the answers. Times are the device's local time; the server keeps UTC instants (all-day candidates stay dates) and
 * writes the labels itself in the zone the form sends (`tz`), by the same rule as slotLabel here.
 */
import type { PollAnswer, PollOut, ScheduleSlotIn } from "../api/types";
import { addDays, type DayKey, dayKey, parseDay } from "./calendarDates";
import type { ScheduleEntry } from "./templates";

/** The server's limits (messages/schedule.py). */
export const MIN_SLOTS = 2;
export const MAX_SLOTS = 20;
export const MIN_MINUTES = 15;
export const MAX_MINUTES = 12 * 60;
export const MAX_COMMENT = 100;
export const DEFAULT_START = "10:00";
export const DEFAULT_MINUTES = 60;

/** The lengths the form offers. */
export const DURATIONS: readonly number[] = [15, 30, 45, 60, 90, 120, 180, 240, 360];

/** 「30 分」「1 時間」「1 時間半」「2 時間 15 分」. */
export function durationLabel(minutes: number): string {
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours === 0) return `${rest} 分`;
  if (rest === 0) return `${hours} 時間`;
  if (rest === 30) return `${hours} 時間半`;
  return `${hours} 時間 ${rest} 分`;
}

/** One candidate in the form: a day, and its start and length (or the whole day). */
export interface SlotDraft {
  day: DayKey;
  allDay: boolean;
  /** "HH:MM" (local). */
  start: string;
  minutes: number;
}

const WEEKDAYS = ["日", "月", "火", "水", "木", "金", "土"];
const pad = (n: number) => String(n).padStart(2, "0");
const TIME = /^([01]?\d|2[0-3]):([0-5]\d)$/;

function startOf(slot: SlotDraft): Date {
  return new Date(`${slot.day}T${slot.start.padStart(5, "0")}`);
}

function endOf(slot: SlotDraft): Date {
  return new Date(startOf(slot).getTime() + slot.minutes * 60_000);
}

const clock = (date: Date) => `${date.getHours()}:${pad(date.getMinutes())}`;

/** 「10/3 (土)」. */
export function shortDay(day: DayKey): string {
  const date = parseDay(day);
  return `${date.getMonth() + 1}/${date.getDate()} (${WEEKDAYS[date.getDay()]})`;
}

/** 「10/3 (土) 14:00〜15:00」, 「10/5 (月) 終日」, past midnight 「22:00〜24:00」 / 「23:00〜翌1:30」 (the server's rule). */
export function slotLabel(slot: SlotDraft): string {
  if (slot.allDay) return `${shortDay(slot.day)} 終日`;
  const start = startOf(slot);
  const end = endOf(slot);
  const endDay = dayKey(end);
  let until: string;
  if (endDay === slot.day) until = clock(end);
  else if (endDay === addDays(slot.day, 1) && end.getHours() === 0 && end.getMinutes() === 0) until = "24:00";
  else until = `翌${clock(end)}`;
  return `${shortDay(slot.day)} ${clock(start)}〜${until}`;
}

/** Earliest first; a day's all-day candidate before its times. */
export function sortSlots(slots: readonly SlotDraft[]): SlotDraft[] {
  const key = (s: SlotDraft) => `${s.day} ${s.allDay ? "" : s.start.padStart(5, "0")} ${String(s.minutes).padStart(4, "0")}`;
  return [...slots].sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
}

function slotKey(slot: SlotDraft): string {
  return slot.allDay ? `d:${slot.day}` : `t:${startOf(slot).getTime()}:${slot.minutes}`;
}

/** The candidates for newly picked days: the form's time (or the whole day) on each. */
export function slotsForDays(days: readonly DayKey[], allDay: boolean, start: string, minutes: number): SlotDraft[] {
  return days.map((day) => ({ day, allDay, start, minutes }));
}

/** What stops the form from being sent (the server's rules, said first here), or null. */
export function scheduleProblem(question: string, slots: readonly SlotDraft[]): string | null {
  if (!question.trim()) return "題名を入れてください";
  if (slots.length < MIN_SLOTS) return `候補を ${MIN_SLOTS} つ以上選んでください`;
  if (slots.length > MAX_SLOTS) return `候補は ${MAX_SLOTS} 個までです`;
  for (const slot of slots) {
    if (slot.allDay) continue;
    if (!TIME.test(slot.start)) return "時刻を入れてください";
    if (slot.minutes < MIN_MINUTES || slot.minutes > MAX_MINUTES) return "時間の長さは 15 分〜12 時間にしてください";
  }
  if (new Set(slots.map(slotKey)).size !== slots.length) return "同じ候補が複数あります";
  return null;
}

/** POST …/messages `poll.slots`: local times become UTC instants; all-day candidates stay dates. */
export function slotToIn(slot: SlotDraft): ScheduleSlotIn {
  if (slot.allDay) return { date: slot.day };
  return { starts_at: startOf(slot).toISOString(), ends_at: endOf(slot).toISOString() };
}

/** `/日程 ゼミ 10/3 10/5 13:00-14:30` (templates.ts readSchedule) → candidates: a time without an end lasts an hour. */
export function slotsFromEntries(entries: readonly ScheduleEntry[]): SlotDraft[] {
  const slots: SlotDraft[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    const slot: SlotDraft =
      entry.from === null
        ? { day: entry.day, allDay: true, start: DEFAULT_START, minutes: DEFAULT_MINUTES }
        : {
            day: entry.day,
            allDay: false,
            start: `${pad(Math.floor(entry.from / 60))}:${pad(entry.from % 60)}`,
            minutes: Math.min(MAX_MINUTES, Math.max(MIN_MINUTES, entry.to === null ? DEFAULT_MINUTES : entry.to - entry.from)),
          };
    if (seen.has(slotKey(slot))) continue;
    seen.add(slotKey(slot));
    slots.push(slot);
  }
  return sortSlots(slots);
}

// --- the card -------------------------------------------------------------------------------------

export function isSchedulePoll(poll: PollOut | null | undefined): boolean {
  return poll?.kind === "schedule";
}

export interface SlotCounts {
  yes: number;
  maybe: number;
  no: number;
}

export function slotCounts(poll: PollOut): SlotCounts[] {
  return poll.options.map((_, index) => {
    const answers = poll.answers?.[index];
    return { yes: answers?.yes_count ?? 0, maybe: answers?.maybe_count ?? 0, no: answers?.no_count ?? 0 };
  });
}

/**
 * My answer per candidate (null = unanswered). A named poll's answers come with every change, events too, so they are
 * read from the lists (always current); an anonymous poll lists nobody, and `my_answers` (responses to me only, kept by
 * the store across events) is all there is.
 */
export function myAnswers(poll: PollOut, meId: string | null | undefined): (PollAnswer | null)[] {
  if (!poll.anonymous) {
    return poll.options.map((_, index) => {
      const answers = poll.answers?.[index];
      if (!meId || !answers) return null;
      if (answers.yes.includes(meId)) return "yes";
      if (answers.maybe.includes(meId)) return "maybe";
      if (answers.no.includes(meId)) return "no";
      return null;
    });
  }
  return poll.options.map((_, index) => poll.my_answers?.[index] ?? null);
}

/** My comment ("" = none), by the same rule as myAnswers. */
export function myComment(poll: PollOut, meId: string | null | undefined): string {
  if (!poll.anonymous) return (meId && poll.comments?.find((c) => c.user_id === meId)?.text) || "";
  return poll.my_comment ?? "";
}

/** My answers after pressing `answer` on candidate `index`: pressing the answer I already gave takes it back. */
export function pressAnswer(current: readonly (PollAnswer | null)[], index: number, answer: PollAnswer): (PollAnswer | null)[] {
  return current.map((value, i) => (i === index ? (value === answer ? null : answer) : value));
}

/** PUT …/poll/answers `answers`: the answered candidates only. */
export function answersBody(answers: readonly (PollAnswer | null)[]): { index: number; answer: PollAnswer }[] {
  return answers.flatMap((answer, index) => (answer ? [{ index, answer }] : []));
}

/** The candidates with the most ○ (none when nobody said ○ yet). */
export function bestSlots(poll: PollOut): number[] {
  const counts = slotCounts(poll).map((c) => c.yes);
  const top = Math.max(0, ...counts);
  if (top === 0) return [];
  return counts.flatMap((count, index) => (count === top ? [index] : []));
}

/** How many people answered (named: the respondents; anonymous: the most answers any candidate got). */
export function respondentCount(poll: PollOut): number {
  if (!poll.anonymous) return poll.respondents?.length ?? 0;
  return Math.max(0, ...slotCounts(poll).map((c) => c.yes + c.maybe + c.no));
}

export const ANSWER_MARK: Record<PollAnswer, string> = { yes: "○", maybe: "△", no: "×" };
export const ANSWER_NAME: Record<PollAnswer, string> = { yes: "参加できる", maybe: "未定", no: "参加できない" };
