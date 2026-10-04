import { ChevronLeft, ChevronRight, CopyPlus, X } from "lucide-react";
import { type FormEvent, useState } from "react";

import type { AppController } from "../state/app";
import { addMonths, type DayKey, dayLabel, localZone, monthGrid, monthLabel, today as todayKey, weekdayLabel } from "./calendarDates";
import { Button, cn, Field, Input, Modal } from "./primitives";
import {
  DEFAULT_MINUTES,
  DEFAULT_START,
  DURATIONS,
  durationLabel,
  MAX_SLOTS,
  scheduleProblem,
  type SlotDraft,
  slotLabel,
  slotToIn,
  sortSlots,
} from "./scheduling";

export interface ScheduleFormInitial {
  question?: string;
  slots?: SlotDraft[];
}

const SELECT =
  "h-8 rounded-md border border-line bg-canvas px-1.5 text-sm text-ink focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/30";
const TIME_INPUT = "h-8 w-[6.5rem] rounded-md border border-line bg-canvas px-1.5 text-sm text-ink focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/30";

/** The length choices, with a length the candidate already has (from `/日程 … 13:00-14:20`) kept in the list. */
function lengthChoices(current: number): number[] {
  return DURATIONS.includes(current) ? [...DURATIONS] : [...DURATIONS, current].sort((a, b) => a - b);
}

function endOfSlot(slot: SlotDraft): string {
  const date = new Date(`${slot.day}T${slot.start.padStart(5, "0")}`);
  date.setMinutes(date.getMinutes() + slot.minutes);
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

/**
 * 「日程調整を作成」 (M53, SCHEDULING.md §5): a title, the days picked on a month calendar (Sunday first), a time (start and
 * length) or 終日 for all of them, then the candidates listed: each one's time can change, it can be removed, and another
 * time on the same day added. Sent as a scheduling poll with the device's zone (the server writes the labels in it).
 */
export function ScheduleDialog({ controller, channelId, parentId, onClose, initial, now = new Date() }: {
  controller: AppController;
  channelId: string;
  parentId: string | null;
  onClose: () => void;
  initial?: ScheduleFormInitial;
  now?: Date;
}) {
  const today = todayKey(now);
  const [question, setQuestion] = useState(initial?.question ?? "");
  const [slots, setSlots] = useState<SlotDraft[]>(() => sortSlots(initial?.slots ?? []));
  const firstDay = slots[0]?.day;
  const [month, setMonth] = useState<DayKey>(() => (firstDay && firstDay > today ? firstDay : today));
  const [allDay, setAllDay] = useState(() => slots.length > 0 && slots.every((s) => s.allDay));
  const [start, setStart] = useState(() => slots.find((s) => !s.allDay)?.start ?? DEFAULT_START);
  const [minutes, setMinutes] = useState(() => slots.find((s) => !s.allDay)?.minutes ?? DEFAULT_MINUTES);
  const [anonymous, setAnonymous] = useState(false);
  const [busy, setBusy] = useState(false);
  const [tried, setTried] = useState(false);
  const problem = scheduleProblem(question, slots);
  const picked = new Set(slots.map((s) => s.day));
  const thisMonth = month.slice(0, 7);

  const toggleDay = (day: DayKey) => {
    setSlots((all) => (all.some((s) => s.day === day) ? all.filter((s) => s.day !== day) : sortSlots([...all, { day, allDay, start, minutes }])));
  };
  /** The time chosen above goes to every candidate. */
  const applyToAll = (patch: Partial<Pick<SlotDraft, "allDay" | "start" | "minutes">>) => {
    if (patch.allDay !== undefined) setAllDay(patch.allDay);
    if (patch.start !== undefined) setStart(patch.start);
    if (patch.minutes !== undefined) setMinutes(patch.minutes);
    setSlots((all) => {
      // Several times on one day become one when they turn all-day.
      const next = all.map((s) => ({ ...s, ...patch }));
      const seen = new Set<string>();
      return sortSlots(next.filter((s) => {
        const key = s.allDay ? s.day : `${s.day} ${s.start} ${s.minutes}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      }));
    });
  };
  const change = (index: number, patch: Partial<SlotDraft>) => setSlots((all) => all.map((s, i) => (i === index ? { ...s, ...patch } : s)));
  const remove = (index: number) => setSlots((all) => all.filter((_, i) => i !== index));
  /** Another time on the same day, right after this one. */
  const addAfter = (index: number) =>
    setSlots((all) => {
      const slot = all[index]!;
      const next = { ...slot, start: endOfSlot(slot) };
      return sortSlots([...all, next.start > slot.start ? next : { ...slot, start: DEFAULT_START }]);
    });

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setTried(true);
    if (problem || busy) return;
    setBusy(true);
    const made = await controller.createSchedulePoll(channelId, parentId, question.trim(), sortSlots(slots).map(slotToIn), localZone(), anonymous);
    setBusy(false);
    if (made) onClose();
  };

  return (
    <Modal onClose={onClose} title="日程調整を作成" description="候補の日時を選ぶと、メンバーが ○ △ × で答えます" className="w-[540px]">
      <form className="mt-3 space-y-3" onSubmit={(event) => void submit(event)}>
        <Field label="題名">
          <Input value={question} maxLength={200} autoFocus placeholder="例: M2 中間発表の練習" onChange={(e) => setQuestion(e.target.value)} />
        </Field>

        <div className="grid gap-3 sm:grid-cols-[minmax(0,15rem)_1fr]">
          <div aria-label="候補の日" role="group">
            <div className="mb-1 flex items-center justify-between">
              <button type="button" aria-label="前の月" className="flex h-7 w-7 items-center justify-center rounded-md text-muted hover:bg-panel hover:text-ink" onClick={() => setMonth((m) => addMonths(m, -1))}>
                <ChevronLeft size={15} />
              </button>
              <span className="text-sm font-medium">{monthLabel(month)}</span>
              <button type="button" aria-label="次の月" className="flex h-7 w-7 items-center justify-center rounded-md text-muted hover:bg-panel hover:text-ink" onClick={() => setMonth((m) => addMonths(m, 1))}>
                <ChevronRight size={15} />
              </button>
            </div>
            <div className="grid grid-cols-7 text-center text-[11px] text-muted">
              {[0, 1, 2, 3, 4, 5, 6].map((i) => (
                <span key={i} className={cn(i === 0 && "text-danger", i === 6 && "text-accent")}>{weekdayLabel(i)}</span>
              ))}
            </div>
            <div className="grid grid-cols-7 gap-0.5">
              {monthGrid(month).flat().map((day) => {
                const inMonth = day.slice(0, 7) === thisMonth;
                const past = day < today;
                const chosen = picked.has(day);
                return (
                  <button
                    key={day}
                    type="button"
                    data-pick-day={day}
                    aria-label={dayLabel(day)}
                    aria-pressed={chosen}
                    disabled={past && !chosen}
                    onClick={() => toggleDay(day)}
                    className={cn(
                      "h-8 rounded-md text-sm tabular-nums transition-colors",
                      chosen ? "bg-accent-solid font-semibold text-white" : "hover:bg-panel",
                      !inMonth && !chosen && "text-muted/60",
                      day === today && !chosen && "ring-1 ring-accent/50",
                      past && !chosen && "cursor-default opacity-40 hover:bg-transparent",
                    )}
                  >
                    {Number(day.slice(8))}
                  </button>
                );
              })}
            </div>
          </div>

          <div className="space-y-2">
            <span className="text-xs font-medium text-muted">時刻 (すべての候補)</span>
            <div className="flex gap-1" role="radiogroup" aria-label="時刻か終日か">
              <Button type="button" size="sm" variant={allDay ? "secondary" : "primary"} role="radio" aria-checked={!allDay} onClick={() => applyToAll({ allDay: false })}>時刻を決める</Button>
              <Button type="button" size="sm" variant={allDay ? "primary" : "secondary"} role="radio" aria-checked={allDay} onClick={() => applyToAll({ allDay: true })}>終日</Button>
            </div>
            {!allDay && (
              <div className="flex flex-wrap items-center gap-1.5 text-sm">
                <input type="time" aria-label="開始時刻" className={TIME_INPUT} value={start} step={300} onChange={(e) => e.target.value && applyToAll({ start: e.target.value })} />
                <span className="text-muted">から</span>
                <select aria-label="長さ" className={SELECT} value={minutes} onChange={(e) => applyToAll({ minutes: Number(e.target.value) })}>
                  {lengthChoices(minutes).map((m) => <option key={m} value={m}>{durationLabel(m)}</option>)}
                </select>
              </div>
            )}
            <p className="text-xs text-muted">カレンダーで日を選ぶと候補に入ります (もう一度押すと外れます)。</p>
          </div>
        </div>

        <div className="space-y-1">
          <div className="flex items-baseline justify-between text-xs font-medium text-muted">
            <span>候補</span>
            <span className={cn(slots.length > MAX_SLOTS && "text-danger")}>{slots.length} / {MAX_SLOTS}</span>
          </div>
          {slots.length === 0 ? (
            <p className="rounded-lg border border-dashed border-line px-3 py-3 text-center text-sm text-muted">カレンダーで日を選んでください</p>
          ) : (
            <ul className="max-h-60 space-y-1 overflow-y-auto" aria-label="候補の一覧">
              {slots.map((slot, index) => (
                <li key={`${slot.day}-${index}`} data-slot-row className="flex flex-wrap items-center gap-1.5 rounded-lg border border-line px-2 py-1">
                  <span className="min-w-[9rem] flex-1 text-sm">{slotLabel(slot)}</span>
                  {!slot.allDay && (
                    <>
                      <input type="time" aria-label={`${slotLabel(slot)} の開始時刻`} className={TIME_INPUT} value={slot.start} step={300} onChange={(e) => e.target.value && change(index, { start: e.target.value })} />
                      <select aria-label={`${slotLabel(slot)} の長さ`} className={SELECT} value={slot.minutes} onChange={(e) => change(index, { minutes: Number(e.target.value) })}>
                        {lengthChoices(slot.minutes).map((m) => <option key={m} value={m}>{durationLabel(m)}</option>)}
                      </select>
                      <button type="button" aria-label={`${slotLabel(slot)} の後に同じ日の候補を追加`} title="同じ日に別の時刻を追加" className="flex h-8 w-8 items-center justify-center rounded-md text-muted hover:bg-panel hover:text-ink" onClick={() => addAfter(index)}>
                        <CopyPlus size={15} />
                      </button>
                    </>
                  )}
                  <button type="button" aria-label={`${slotLabel(slot)} を削除`} className="flex h-8 w-8 items-center justify-center rounded-md text-muted hover:bg-panel hover:text-ink" onClick={() => remove(index)}>
                    <X size={15} />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={anonymous} onChange={(e) => setAnonymous(e.target.checked)} className="h-4 w-4 accent-[var(--accent)]" />
          匿名にする (誰が答えたか表示しない)
        </label>
        {tried && problem && <p className="text-xs text-danger">{problem}</p>}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose}>キャンセル</Button>
          <Button type="submit" disabled={busy}>{busy ? "作成中…" : "作成"}</Button>
        </div>
      </form>
    </Modal>
  );
}
