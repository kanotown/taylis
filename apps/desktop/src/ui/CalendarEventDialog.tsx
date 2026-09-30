/**
 * M51 (CALENDAR.md §7): an event's dialog. New: 題名, 終日, the dates and times (the device's zone; timed events go out
 * as UTC instants, all-day ones as dates), the calendar (自分 or a channel I may post in), 場所, 説明 and my 通知.
 * Someone who may not change the event (can_edit false) sees it read-only, with only their own alarm to set.
 */
import { MapPin, Trash2 } from "lucide-react";
import { useRef, useState } from "react";

import { describeError } from "../api/errors";
import type { CalendarEventOut } from "../api/types";
import type { AppController } from "../state/app";
import type { ChannelState } from "../sync/types";
import {
  addDays,
  alarmChoices,
  channelColor,
  daysBetween,
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
  const clientId = useRef(crypto.randomUUID());
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
    setBusy(true);
    try {
      if (!event) {
        await hub.create(draftToCreate(draft, localZone(), clientId.current));
      } else {
        if (editable) await hub.update(event.id, draftToPatch(draft));
        if (alarmChanged || (editable && draft.allDay !== event.all_day && draft.alarm !== null)) {
          // The server remaps the alarm when the event turns all-day (or back); what was chosen here wins.
          await hub.setAlarm(event.id, draft.alarm);
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
        {confirmDelete ? (
          <div className="flex items-center justify-end gap-2 rounded-lg bg-danger/10 px-3 py-2">
            <span className="mr-auto text-sm">この予定を削除しますか？</span>
            <Button variant="secondary" size="sm" onClick={() => setConfirmDelete(false)}>キャンセル</Button>
            <Button variant="danger" size="sm" disabled={busy} onClick={() => void remove()}>削除する</Button>
          </div>
        ) : (
          <div className="flex items-center justify-end gap-2 pt-1">
            {event && editable && (
              <Button variant="ghost" className="mr-auto text-danger" onClick={() => setConfirmDelete(true)}>
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

