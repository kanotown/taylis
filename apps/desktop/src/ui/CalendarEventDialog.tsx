/**
 * M51 (CALENDAR.md §7): an event's dialog. New: 題名, 終日, the dates and times (the device's zone; timed events go out
 * as UTC instants, all-day ones as dates), the calendar (自分 or a channel I may post in), 場所, 説明 and my 通知.
 * Someone who may not change the event (can_edit false) sees it read-only, with only their own alarm to set.
 * M68 (CALENDAR.md §10.7): 「繰り返し」 (RepeatPicker), and saving or deleting an occurrence of a recurring event asks which
 * ones (「この予定」「これ以降すべて」「すべての予定」); my alarm is the series' (every occurrence).
 */
import { MapPin, Repeat, Trash2 } from "lucide-react";
import { useRef, useState } from "react";

import { describeError } from "../api/errors";
import type { CalendarEventOut, CalendarOccurrenceUpdate, OccurrenceScope } from "../api/types";
import type { AppController } from "../state/app";
import type { ChannelState } from "../sync/types";
import {
  addDays,
  alarmChoices,
  channelColor,
  daysBetween,
  draftChanges,
  draftFromEvent,
  draftProblem,
  draftToCreate,
  draftToPatch,
  type EventDraft,
  eventWhen,
  localZone,
  MAX_DESCRIPTION,
  MAX_LOCATION,
  MAX_TITLE,
  remapAlarm,
} from "./calendarDates";
import {
  describeRrule,
  MAX_COUNT,
  MAX_INTERVAL,
  monthlyChoices,
  type RepeatDraft,
  type RepeatFreq,
  type RepeatKind,
  repeatToRrule,
  ruleChanged,
  WEEKDAY_NAMES,
} from "./calendarRecurrence";
import { canPostTopLevel } from "./channels";
import { Button, cn, Field, Input, Modal, Textarea } from "./primitives";

/** The channels whose calendars I may add to: public and private ones I belong to and may post in. */
export function writableCalendars(controller: AppController): ChannelState[] {
  return [...controller.store.channels.values()]
    .filter((c) => c.isMember && (c.type === "public" || c.type === "private") && !c.archived && canPostTopLevel(c, controller.isAdmin))
    .sort((a, b) => (a.name ?? "").localeCompare(b.name ?? "", "ja"));
}

const SELECT =
  "w-full rounded-lg border border-line bg-canvas px-3 py-2 text-sm text-ink focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/30 disabled:opacity-60";

function shiftTime(day: string, time: string, minutes: number): { day: string; time: string } {
  const date = new Date(`${day}T${time}`);
  date.setMinutes(date.getMinutes() + minutes);
  const pad = (n: number) => String(n).padStart(2, "0");
  return { day: `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`, time: `${pad(date.getHours())}:${pad(date.getMinutes())}` };
}

/** 「この予定」 is offered only when the change fits one occurrence (not its rule, not all-day ↔ timed). */
interface ScopeAsk {
  action: "save" | "delete";
  allowThis: boolean;
}

export const SCOPE_CHOICES: Array<{ value: OccurrenceScope; label: string }> = [
  { value: "this", label: "この予定" },
  { value: "following", label: "これ以降すべて" },
  { value: "all", label: "すべての予定" },
];

export function CalendarEventDialog({ controller, event, initial, onClose }: {
  controller: AppController;
  /** The event opened; null makes a new one from `initial`. */
  event: CalendarEventOut | null;
  initial?: EventDraft;
  onClose: () => void;
}) {
  const hub = controller.engine?.calendar ?? null;
  const [draft, setDraft] = useState<EventDraft>(() => (event ? draftFromEvent(event) : initial!));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [askScope, setAskScope] = useState<ScopeAsk | null>(null);
  const clientId = useRef(crypto.randomUUID());
  const opened = useRef<typeof draft | null>(event ? draftFromEvent(event) : null);
  const recurring = !!event?.recurring;
  const seriesId = event ? (event.series_id ?? event.id) : null;
  const editable = !event || event.can_edit;
  const calendars = writableCalendars(controller);
  const problem = editable ? draftProblem(draft) : null;
  const alarmChanged = (event?.alarm?.minutes_before ?? null) !== draft.alarm;
  const set = (patch: Partial<EventDraft>) => {
    setDraft((current) => ({ ...current, ...patch }));
    setError(null);
  };

  /** Moving the start carries the end along (the event keeps its length). */
  const moveStart = (day: string, time: string) => {
    if (draft.allDay) {
      const length = Math.max(0, daysBetween(draft.startDay, draft.endDay));
      set({ startDay: day, endDay: day ? addDays(day, length) : draft.endDay });
      return;
    }
    const before = new Date(`${draft.startDay}T${draft.startTime}`).getTime();
    const after = new Date(`${day}T${time}`).getTime();
    if (Number.isNaN(before) || Number.isNaN(after) || !draft.endDay || !draft.endTime) {
      set({ startDay: day, startTime: time });
      return;
    }
    const end = shiftTime(draft.endDay, draft.endTime, Math.round((after - before) / 60_000));
    set({ startDay: day, startTime: time, endDay: end.day, endTime: end.time });
  };

  const save = async () => {
    if (!hub || busy) return;
    if (problem) {
      setError(problem);
      return;
    }
    if (event && recurring && editable) {
      const changes = draftChanges(draft, opened.current!);
      const rule = ruleChanged(draft.repeat, draft.startDay, event.rrule);
      if (Object.keys(changes).length > 0 || rule) {
        setAskScope({ action: "save", allowThis: !rule && draft.allDay === event.all_day });
        return;
      }
    }
    setBusy(true);
    try {
      if (!event) {
        await hub.create(draftToCreate(draft, localZone(), clientId.current));
      } else {
        if (editable && !recurring) {
          const rrule = repeatToRrule(draft.repeat, draft.startDay);
          await hub.update(event.id, { ...draftToPatch(draft), ...(rrule ? { rrule, tz: localZone() } : {}) });
        }
        if (alarmChanged || (editable && draft.allDay !== event.all_day && draft.alarm !== null)) {
          // The server remaps the alarm when the event turns all-day (or back); what was chosen here wins.
          await hub.setAlarm(seriesId!, draft.alarm);
        }
      }
      onClose();
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!hub || !event || busy) return;
    setBusy(true);
    try {
      await hub.remove(event.id);
      onClose();
    } catch (err) {
      setError(describeError(err));
      setBusy(false);
    }
  };

  /** A recurring event's occurrence saved or deleted, for the occurrences chosen. */
  const applyScope = async (scope: OccurrenceScope) => {
    if (!hub || !event || !askScope || busy) return;
    setBusy(true);
    try {
      if (askScope.action === "delete") {
        await hub.removeOccurrence(seriesId!, event.occurrence_start, scope);
      } else {
        const body: CalendarOccurrenceUpdate = { scope, ...draftChanges(draft, opened.current!) };
        if (scope !== "this" && ruleChanged(draft.repeat, draft.startDay, event.rrule)) body.rrule = repeatToRrule(draft.repeat, draft.startDay);
        const result = await hub.updateOccurrence(seriesId!, event.occurrence_start, body);
        if (alarmChanged) await hub.setAlarm(result.series_id ?? result.id, draft.alarm);
      }
      onClose();
    } catch (err) {
      setError(describeError(err));
      setAskScope(null);
      setBusy(false);
    }
  };

  const calendarName = (choice: string) => (choice === "me" ? "自分" : `#${controller.store.getChannel(choice)?.name ?? event?.channel_name ?? "?"}`);
  const title = !event ? "予定を追加" : editable ? "予定を編集" : "予定";

  return (
    <Modal onClose={onClose} title={title} className="w-[520px]">
      <form
        className="mt-4 space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        {editable ? (
          <>
            <Field label="題名">
              <Input autoFocus value={draft.title} maxLength={MAX_TITLE} placeholder="ゼミ" onChange={(e) => set({ title: e.target.value })} />
            </Field>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={draft.allDay}
                onChange={(e) => {
                  const allDay = e.target.checked;
                  // An all-day event cannot end before it starts: a timed one ending on an earlier day keeps its start day.
                  set({ allDay, endDay: draft.endDay < draft.startDay ? draft.startDay : draft.endDay, alarm: remapAlarm(draft.alarm, allDay) });
                }}
              />
              終日
            </label>
            <div className="grid grid-cols-[auto_1fr_auto] items-center gap-x-2 gap-y-2 text-sm">
              <span className="text-xs font-medium text-muted">開始</span>
              <Input type="date" aria-label="開始日" value={draft.startDay} onChange={(e) => moveStart(e.target.value, draft.startTime)} />
              {draft.allDay ? <span /> : <Input type="time" aria-label="開始時刻" className="w-32" value={draft.startTime} onChange={(e) => moveStart(draft.startDay, e.target.value)} />}
              <span className="text-xs font-medium text-muted">終了</span>
              <Input type="date" aria-label="終了日" value={draft.endDay} min={draft.startDay} onChange={(e) => set({ endDay: e.target.value })} />
              {draft.allDay ? <span /> : <Input type="time" aria-label="終了時刻" className="w-32" value={draft.endTime} onChange={(e) => set({ endTime: e.target.value })} />}
            </div>
            <RepeatPicker
              repeat={draft.repeat}
              start={draft.startDay}
              onChange={(repeat) => set({ repeat })}
            />
            <Field label="カレンダー">
              <select
                className={SELECT}
                aria-label="カレンダー"
                value={draft.calendar}
                disabled={!!event}
                onChange={(e) => set({ calendar: e.target.value })}
              >
                <option value="me">自分 (自分だけに表示)</option>
                {event && event.channel_id && !calendars.some((c) => c.id === event.channel_id) && (
                  <option value={event.channel_id}>{calendarName(event.channel_id)}</option>
                )}
                {calendars.map((c) => (
                  <option key={c.id} value={c.id}>#{c.name}</option>
                ))}
              </select>
            </Field>
            <Field label="場所">
              <Input value={draft.location} maxLength={MAX_LOCATION} placeholder="5 号館 501 / https://…" onChange={(e) => set({ location: e.target.value })} />
            </Field>
            <Field label="説明">
              <Textarea rows={3} value={draft.description} maxLength={MAX_DESCRIPTION} onChange={(e) => set({ description: e.target.value })} />
            </Field>
          </>
        ) : (
          event && <ReadOnlyEvent event={event} calendar={calendarName(event.channel_id ?? "me")} />
        )}
        <Field label="通知" hint={draft.calendar !== "me" ? "通知は自分にだけ届きます" : undefined}>
          <select className={SELECT} aria-label="通知" value={draft.alarm === null ? "" : String(draft.alarm)} onChange={(e) => set({ alarm: e.target.value === "" ? null : Number(e.target.value) })}>
            {alarmChoices(draft.allDay).map((choice) => (
              <option key={String(choice.value)} value={choice.value === null ? "" : String(choice.value)}>{choice.label}</option>
            ))}
          </select>
        </Field>
        {error && <p role="alert" className="text-sm text-danger">{error}</p>}
        {askScope ? (
          <div role="group" aria-label={askScope.action === "delete" ? "繰り返しの予定の削除" : "繰り返しの予定の変更"} className="space-y-2 rounded-lg bg-panel-2 px-3 py-2">
            <div className="text-sm font-medium">{askScope.action === "delete" ? "繰り返しの予定の削除" : "繰り返しの予定の変更"}</div>
            <div className="flex flex-wrap items-center justify-end gap-2">
              {SCOPE_CHOICES.filter((choice) => askScope.allowThis || choice.value !== "this").map((choice) => (
                <Button
                  key={choice.value}
                  size="sm"
                  variant={askScope.action === "delete" ? "danger" : choice.value === "this" ? "primary" : "secondary"}
                  disabled={busy}
                  onClick={() => void applyScope(choice.value)}
                >
                  {choice.label}
                </Button>
              ))}
              <Button size="sm" variant="ghost" onClick={() => setAskScope(null)}>キャンセル</Button>
            </div>
          </div>
        ) : confirmDelete ? (
          <div className="flex items-center justify-end gap-2 rounded-lg bg-danger/10 px-3 py-2">
            <span className="mr-auto text-sm">この予定を削除しますか？</span>
            <Button variant="secondary" size="sm" onClick={() => setConfirmDelete(false)}>キャンセル</Button>
            <Button variant="danger" size="sm" disabled={busy} onClick={() => void remove()}>削除する</Button>
          </div>
        ) : (
          <div className="flex items-center justify-end gap-2 pt-1">
            {event && editable && (
              <Button variant="ghost" className="mr-auto text-danger" onClick={() => (recurring ? setAskScope({ action: "delete", allowThis: true }) : setConfirmDelete(true))}>
                <Trash2 size={15} /> 削除
              </Button>
            )}
            <Button variant="secondary" onClick={onClose}>{editable || alarmChanged ? "キャンセル" : "閉じる"}</Button>
            {(editable || alarmChanged) && (
              <Button type="submit" disabled={busy || !!problem || !hub}>{event ? "保存" : "追加"}</Button>
            )}
          </div>
        )}
      </form>
    </Modal>
  );
}

/** What someone who may not change the event sees of it. */
function ReadOnlyEvent({ event, calendar }: { event: CalendarEventOut; calendar: string }) {
  return (
    <div className="space-y-2">
      <div className="flex items-start gap-2">
        <span aria-hidden className="mt-1.5 h-3 w-3 shrink-0 rounded-sm" style={{ background: channelColor(event.channel_id) }} />
        <div className="min-w-0">
          <div className="break-words text-[15px] font-semibold">{event.title}</div>
          <div className="text-sm text-muted">{eventWhen(event)}</div>
          <div className="text-xs text-muted">{calendar}</div>
          {event.recurring && (
            <div className="flex items-center gap-1 text-xs text-muted">
              <Repeat size={12} aria-hidden /> {describeRrule(event.rrule, event.all_day ? event.start_date! : localDay(event.starts_at!))}
            </div>
          )}
        </div>
      </div>
      {event.location && (
        <div className={cn("flex items-start gap-1.5 break-all text-sm")}>
          <MapPin size={14} className="mt-0.5 shrink-0 text-muted" /> {event.location}
        </div>
      )}
      {event.description && <p className="whitespace-pre-wrap break-words rounded-lg bg-panel-2 px-3 py-2 text-sm">{event.description}</p>}
      <p className="text-xs text-muted">この予定を変更できるのは、作成者・チャンネルのオーナー・管理者です。</p>
    </div>
  );
}


function localDay(iso: string): string {
  const date = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

const REPEAT_KINDS: Array<{ value: RepeatKind; label: string }> = [
  { value: "none", label: "しない" },
  { value: "daily", label: "毎日" },
  { value: "weekly", label: "毎週" },
  { value: "monthly", label: "毎月" },
  { value: "yearly", label: "毎年" },
  { value: "custom", label: "カスタム" },
];

const UNITS: Array<{ value: RepeatFreq; label: string }> = [
  { value: "DAILY", label: "日" },
  { value: "WEEKLY", label: "週" },
  { value: "MONTHLY", label: "か月" },
  { value: "YEARLY", label: "年" },
];

/** 「繰り返し」: しない / 毎日 / 毎週 (曜日) / 毎月 (日付・第 N 曜日) / 毎年 / カスタム (間隔), the end, and the rule in words. */
export function RepeatPicker({ repeat, start, onChange }: { repeat: RepeatDraft; start: string; onChange: (repeat: RepeatDraft) => void }) {
  const set = (patch: Partial<RepeatDraft>) => onChange({ ...repeat, ...patch });
  const freq: RepeatFreq | null =
    repeat.kind === "custom" ? repeat.freq : repeat.kind === "none" ? null : (({ daily: "DAILY", weekly: "WEEKLY", monthly: "MONTHLY", yearly: "YEARLY" }) as const)[repeat.kind];
  const months = start ? monthlyChoices(start) : [];
  const rrule = start ? repeatToRrule(repeat, start) : null;
  return (
    <div className="space-y-2 text-sm" data-repeat-picker>
      <Field label="繰り返し">
        <select
          className={SELECT}
          aria-label="繰り返し"
          value={repeat.kind}
          onChange={(e) => {
            const kind = e.target.value as RepeatKind;
            set({ kind, ...(kind === "custom" && repeat.kind !== "custom" ? { freq: freq ?? "WEEKLY" } : {}) });
          }}
        >
          {REPEAT_KINDS.map((choice) => (
            <option key={choice.value} value={choice.value}>{choice.label}</option>
          ))}
        </select>
      </Field>
      {repeat.kind === "custom" && (
        <div className="flex items-center gap-2">
          <Input
            type="number"
            aria-label="間隔"
            className="w-20"
            min={1}
            max={MAX_INTERVAL}
            value={String(repeat.interval)}
            onChange={(e) => set({ interval: Number(e.target.value) })}
          />
          <select className={cn(SELECT, "w-auto")} aria-label="間隔の単位" value={repeat.freq} onChange={(e) => set({ freq: e.target.value as RepeatFreq })}>
            {UNITS.map((unit) => (
              <option key={unit.value} value={unit.value}>{unit.label}</option>
            ))}
          </select>
          <span className="text-muted">ごと</span>
        </div>
      )}
      {freq === "WEEKLY" && (
        <div role="group" aria-label="曜日" className="flex gap-1">
          {WEEKDAY_NAMES.map((name, day) => {
            const on = repeat.weekdays.includes(day);
            return (
              <button
                key={name}
                type="button"
                aria-pressed={on}
                aria-label={`${name}曜日`}
                onClick={() => set({ weekdays: on ? repeat.weekdays.filter((d) => d !== day) : [...repeat.weekdays, day] })}
                className={cn(
                  "h-8 w-8 rounded-full border text-xs font-medium",
                  on ? "border-accent bg-accent text-white" : "border-line text-muted hover:text-ink",
                )}
              >
                {name}
              </button>
            );
          })}
        </div>
      )}
      {freq === "MONTHLY" && (
        <select className={SELECT} aria-label="毎月の日" value={repeat.monthly} onChange={(e) => set({ monthly: e.target.value as RepeatDraft["monthly"] })}>
          {months.map((choice) => (
            <option key={choice.value} value={choice.value}>{choice.label}</option>
          ))}
          {!months.some((choice) => choice.value === repeat.monthly) && <option value={repeat.monthly}>{describeRrule(rrule, start)}</option>}
        </select>
      )}
      {repeat.kind !== "none" && (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs font-medium text-muted">終了</span>
          <select className={cn(SELECT, "w-auto")} aria-label="繰り返しの終了" value={repeat.end} onChange={(e) => set({ end: e.target.value as RepeatDraft["end"] })}>
            <option value="never">なし</option>
            <option value="until">日付</option>
            <option value="count">回数</option>
          </select>
          {repeat.end === "until" && <Input type="date" aria-label="繰り返しの終了日" className="w-40" min={start} value={repeat.until} onChange={(e) => set({ until: e.target.value })} />}
          {repeat.end === "count" && (
            <span className="flex items-center gap-1">
              <Input type="number" aria-label="回数" className="w-20" min={1} max={MAX_COUNT} value={String(repeat.count)} onChange={(e) => set({ count: Number(e.target.value) })} />
              回
            </span>
          )}
        </div>
      )}
      {rrule && (
        <p className="flex items-center gap-1 text-xs text-muted" data-repeat-summary>
          <Repeat size={12} aria-hidden /> {describeRrule(rrule, start)}
        </p>
      )}
    </div>
  );
}
