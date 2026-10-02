/**
 * M51 (CALENDAR.md §7): 「カレンダー」 — my own events and those of my channels, as a month (titles in the days, 「+N」
 * past three), a week (all-day row over a time grid) or a list (day by day from today). 「すべて / 自分 / #channel」
 * filters; each channel has its fixed colour. Weeks start on Sunday. A channel's 「予定」 tab (ChannelEvents) lists
 * its events ahead with 「予定を追加」. M55 (TASKS.md §6): the tasks due in the range, as all-day rows 「☐ 題名」 (done:
 * 「☑」, struck through); a click opens the task. M68 (CALENDAR.md §10.7): a recurring event's rows carry 🔁 and its rule in
 * words; 「購読」 opens the private iCal feed URLs (CalendarFeedsDialog).
 */
import { CalendarDays, ChevronLeft, ChevronRight, MapPin, Plus, Repeat, Rss } from "lucide-react";
import { type ReactNode, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";

import type { CalendarEventOut, TaskOut } from "../api/types";
import type { AppController } from "../state/app";
import type { CalendarHub, CalendarWindow } from "../sync/calendar";
import type { ChannelState } from "../sync/types";
import { CalendarEventDialog, writableCalendars } from "./CalendarEventDialog";
import { CalendarFeedsDialog } from "./CalendarFeedsDialog";
import { describeRrule } from "./calendarRecurrence";
import {
  addDays,
  addMonths,
  type CalendarMode,
  channelColor,
  dayBlocks,
  type DayKey,
  dayLabel,
  daysBetween,
  type EventDraft,
  eventsOn,
  LIST_DAYS,
  MONTH_CELL_EVENTS,
  monthGrid,
  newDraft,
  parseDay,
  rangeFor,
  rangeParams,
  rangeTitle,
  timeOnDay,
  today as todayKey,
  weekdayLabel,
  weekStart,
} from "./calendarDates";
import { BackButton } from "./compact";
import { Button, cn } from "./primitives";
import { readCalendarMode, writeCalendarMode } from "./prefs";
import { useTaskHub } from "./TaskBoard";
import { TaskDialog } from "./TaskDialog";
import { filterTasks, hasBoard, taskPlace, tasksForDay } from "./tasks";
import { conversationTitle } from "./channels";

/** "all", "me" (my own calendar) or a channel id. */
export type CalendarFilter = string;

type DialogState = { event: CalendarEventOut | null; initial?: EventDraft } | null;

const HOUR_PX = 44;

export function useCalendarHub(controller: AppController): CalendarHub | null {
  const hub = controller.engine?.calendar ?? null;
  useSyncExternalStore(
    (listener) => (hub ? hub.subscribe(listener) : () => {}),
    () => hub?.version ?? 0,
  );
  return hub;
}

/** Re-render when the day changes (today's highlight, the list's start). */
function useToday(): DayKey {
  const [day, setDay] = useState(() => todayKey());
  useEffect(() => {
    const timer = setInterval(() => setDay((current) => (current === todayKey() ? current : todayKey())), 60_000);
    return () => clearInterval(timer);
  }, []);
  return day;
}

export function filterEvents(events: CalendarEventOut[], filter: CalendarFilter): CalendarEventOut[] {
  if (filter === "all") return events;
  if (filter === "me") return events.filter((e) => e.channel_id === null);
  return events.filter((e) => e.channel_id === filter);
}

function readableChannels(controller: AppController): ChannelState[] {
  return [...controller.store.channels.values()]
    .filter((c) => c.isMember && (c.type === "public" || c.type === "private"))
    .sort((a, b) => (a.name ?? "").localeCompare(b.name ?? "", "ja"));
}

function windowNote(win: CalendarWindow | undefined): string | null {
  if (!win) return null;
  if (win.state === "unsupported") return "このサーバはカレンダーに対応していません";
  if (win.state === "failed") return "予定を読み込めませんでした。再接続すると読み直します";
  return null;
}

export function CalendarView({ controller }: { controller: AppController }) {
  const hub = useCalendarHub(controller);
  const now = useToday();
  const [mode, setModeState] = useState<CalendarMode>(readCalendarMode);
  const [anchor, setAnchor] = useState<DayKey>(now);
  const [filter, setFilter] = useState<CalendarFilter>("all");
  const [dialog, setDialog] = useState<DialogState>(null);
  const [feeds, setFeeds] = useState(false);
  const { start, end } = rangeFor(mode, anchor);
  const { from, to } = rangeParams(start, end);
  useEffect(() => {
    if (!hub) return;
    void hub.open("view", from, to);
  }, [hub, from, to]);
  useEffect(() => () => hub?.close("view"), [hub]);
  const win = hub?.window("view");
  const events = filterEvents(win?.events ?? [], filter);
  // M55: the tasks due in the same days (dates, the end excluded).
  const taskHub = useTaskHub(controller);
  const [taskDialog, setTaskDialog] = useState<TaskOut | null>(null);
  useEffect(() => {
    if (taskHub?.available) void taskHub.openDue("calendar", start, end);
  }, [taskHub, start, end]);
  useEffect(() => () => taskHub?.closeDue("calendar"), [taskHub]);
  const tasks = filterTasks(taskHub?.dueWindow("calendar")?.tasks ?? [], filter, controller.store.me?.id ?? null);
  // L9: a DM's task (no channel name, no board) by the DM's other members.
  const placeOf = (task: TaskOut) =>
    taskPlace(task, (id) => {
      const channel = controller.store.getChannel(id);
      return channel && !hasBoard(channel) ? conversationTitle(channel, controller.store.users, controller.store.me?.id ?? null, controller.store.me) : null;
    });
  const channels = readableChannels(controller);
  const setMode = (next: CalendarMode) => {
    writeCalendarMode(next);
    setModeState(next);
    if (next === "list") setAnchor(now);
  };
  const step = (direction: 1 | -1) => {
    if (mode === "month") setAnchor((a) => addMonths(a, direction));
    else if (mode === "week") setAnchor((a) => addDays(a, 7 * direction));
    else setAnchor((a) => addDays(a, LIST_DAYS * direction));
  };
  const calendarFor = (): string => {
    if (filter === "all" || filter === "me") return "me";
    return writableCalendars(controller).some((c) => c.id === filter) ? filter : "me";
  };
  const create = (day: DayKey, hour?: number) => {
    const initial = newDraft(day, calendarFor());
    if (hour !== undefined) {
      const pad = (n: number) => String(n).padStart(2, "0");
      initial.startTime = `${pad(hour)}:00`;
      initial.endTime = hour === 23 ? "23:59" : `${pad(hour + 1)}:00`;
    }
    setDialog({ event: null, initial });
  };
  const note = windowNote(win);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* A phone: the range on the first row, the modes, the filter and 「＋」 on the second. */}
      <header className="flex shrink-0 flex-wrap items-center gap-2 border-b border-line px-4 md:h-[52px] md:flex-nowrap max-md:px-2 max-md:py-1.5">
        <BackButton />
        <span className="text-muted max-md:hidden"><CalendarDays size={18} /></span>
        <strong className="shrink-0 whitespace-nowrap text-[15px] max-md:hidden">カレンダー</strong>
        <div className="ml-2 flex min-w-0 items-center gap-1 max-md:ml-0 max-md:flex-1">
          <Button variant="secondary" size="sm" onClick={() => setAnchor(now)}>今日</Button>
          <button type="button" aria-label="前へ" className="inline-flex h-7 w-7 items-center justify-center rounded-md hover:bg-ink/6" onClick={() => step(-1)}>
            <ChevronLeft size={16} />
          </button>
          <button type="button" aria-label="次へ" className="inline-flex h-7 w-7 items-center justify-center rounded-md hover:bg-ink/6" onClick={() => step(1)}>
            <ChevronRight size={16} />
          </button>
          <span data-range-title className="min-w-0 truncate text-sm font-semibold">{rangeTitle(mode, anchor)}</span>
        </div>
        <div className="ml-auto flex shrink-0 items-center gap-2 max-md:w-full">
          <div role="tablist" aria-label="表示" className="flex rounded-lg bg-panel-2 p-0.5 text-xs font-medium">
            {([["month", "月"], ["week", "週"], ["list", "一覧"]] as const).map(([value, label]) => (
              <button
                key={value}
                type="button"
                role="tab"
                aria-selected={mode === value}
                onClick={() => setMode(value)}
                className={cn("rounded-md px-2.5 py-1 transition-colors", mode === value ? "bg-canvas text-ink shadow-sm" : "text-muted hover:text-ink")}
              >
                {label}
              </button>
            ))}
          </div>
          <select
            aria-label="絞り込み"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            className="h-7 max-w-[160px] rounded-md border border-line bg-canvas px-1.5 text-xs max-md:min-w-0 max-md:max-w-none max-md:flex-1"
          >
            <option value="all">すべて</option>
            <option value="me">自分</option>
            {channels.map((c) => (
              <option key={c.id} value={c.id}>#{c.name}</option>
            ))}
          </select>
          <button
            type="button"
            aria-label="カレンダーを購読"
            title="カレンダーを購読 (iCal)"
            onClick={() => setFeeds(true)}
            className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted hover:bg-ink/6 hover:text-ink"
          >
            <Rss size={15} />
          </button>
          <Button size="sm" onClick={() => create(start <= now && now < end ? now : mode === "month" ? `${anchor.slice(0, 7)}-01` : start)} aria-label="予定を追加">
            <Plus size={14} /> <span className="max-md:hidden">予定を追加</span>
          </Button>
        </div>
      </header>
      {note && <div className="border-b border-line bg-warning/10 px-4 py-1.5 text-xs text-muted">{note}</div>}
      {!hub ? (
        <div className="py-16 text-center text-sm text-muted">接続すると表示します</div>
      ) : mode === "month" ? (
        <MonthGrid anchor={anchor} today={now} events={events} tasks={tasks} onOpenTask={setTaskDialog} onOpen={(event) => setDialog({ event })} onNew={create} onDay={(day) => { setAnchor(day); setMode("week"); }} />
      ) : mode === "week" ? (
        <WeekGrid anchor={anchor} today={now} events={events} tasks={tasks} onOpenTask={setTaskDialog} onOpen={(event) => setDialog({ event })} onNew={create} />
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
          <AgendaList events={events} tasks={tasks} taskPlaceOf={placeOf} onOpenTask={setTaskDialog} start={start} end={end} today={now} onOpen={(event) => setDialog({ event })} loading={win?.state === "loading"} />
        </div>
      )}
      {dialog && <CalendarEventDialog controller={controller} event={dialog.event} initial={dialog.initial} onClose={() => setDialog(null)} />}
      {taskDialog && <TaskDialog controller={controller} task={taskHub?.find(taskDialog.id) ?? taskDialog} onClose={() => setTaskDialog(null)} />}
      {feeds && <CalendarFeedsDialog controller={controller} onClose={() => setFeeds(false)} />}
    </div>
  );
}

function EventChip({ event, day, onOpen }: { event: CalendarEventOut; day: DayKey; onOpen: (event: CalendarEventOut) => void }) {
  const color = channelColor(event.channel_id);
  const time = timeOnDay(event, day);
  const filled = event.all_day || time === "終日";
  return (
    <button
      type="button"
      data-event={event.id}
      title={`${time} ${event.title}${event.channel_name ? ` (#${event.channel_name})` : ""}`}
      onClick={(e) => {
        e.stopPropagation();
        onOpen(event);
      }}
      className={cn("flex w-full min-w-0 items-center gap-1 rounded px-1 text-left text-[11.5px] leading-[18px] hover:brightness-95", filled ? "text-white" : "text-ink hover:bg-ink/5")}
      style={filled ? { background: color } : undefined}
    >
      {!filled && <span aria-hidden className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: color }} />}
      {/* A phone's narrow days keep the title, not the time. */}
      {!filled && <span className="shrink-0 tabular-nums text-muted max-md:hidden">{time.replace(/〜.*$/, "")}</span>}
      <span className="min-w-0 truncate">{event.title}</span>
    </button>
  );
}

/** M55: a task due that day, an all-day row 「☐ 題名」 (done 「☑」, struck through) in its board's colour. */
export function TaskChip({ task, onOpen }: { task: TaskOut; onOpen: (task: TaskOut) => void }) {
  const color = channelColor(task.channel_id);
  const done = task.status === "done";
  return (
    <button
      type="button"
      data-task={task.id}
      title={`期限: ${task.title}${task.channel_name ? ` (#${task.channel_name})` : ""}`}
      onClick={(e) => {
        e.stopPropagation();
        onOpen(task);
      }}
      className="flex w-full min-w-0 items-center gap-1 rounded border-l-[3px] px-1 text-left text-[11.5px] leading-[18px] text-ink hover:brightness-95"
      style={{ borderLeftColor: color, background: `color-mix(in srgb, ${color} 14%, var(--color-canvas, #fff))` }}
    >
      <span aria-hidden className="shrink-0" style={{ color }}>{done ? "☑" : "☐"}</span>
      <span className={cn("min-w-0 truncate", done && "text-muted line-through")}>{task.title}</span>
    </button>
  );
}

/** A month cell's rows: all-day events, then the tasks due, then timed events (cut to MONTH_CELL_EVENTS by the caller). */
function cellRows(events: CalendarEventOut[], tasks: TaskOut[], day: DayKey): Array<{ event: CalendarEventOut } | { task: TaskOut }> {
  const list = eventsOn(events, day);
  const allDay = list.filter((e) => e.all_day || timeOnDay(e, day) === "終日");
  const timed = list.filter((e) => !allDay.includes(e));
  return [...allDay.map((event) => ({ event })), ...tasksForDay(tasks, day).map((task) => ({ task })), ...timed.map((event) => ({ event }))];
}

export function MonthGrid({ anchor, today, events, tasks = [], onOpen, onOpenTask = () => {}, onNew, onDay }: {
  anchor: DayKey;
  today: DayKey;
  events: CalendarEventOut[];
  /** M55: the tasks due in the range. */
  tasks?: TaskOut[];
  onOpen: (event: CalendarEventOut) => void;
  onOpenTask?: (task: TaskOut) => void;
  onNew: (day: DayKey) => void;
  onDay: (day: DayKey) => void;
}) {
  const weeks = monthGrid(anchor);
  const month = anchor.slice(0, 7);
  return (
    <div className="flex min-h-0 flex-1 flex-col" role="grid" aria-label="月">
      <div className="grid shrink-0 grid-cols-7 border-b border-line text-center text-[11px] font-medium text-muted" role="row">
        {Array.from({ length: 7 }, (_, i) => (
          <div key={i} role="columnheader" className={cn("py-1", i === 0 && "text-rose-500", i === 6 && "text-sky-600")}>{weekdayLabel(i)}</div>
        ))}
      </div>
      <div className="grid min-h-0 flex-1 auto-rows-fr overflow-y-auto" style={{ gridTemplateRows: `repeat(${weeks.length}, minmax(96px, 1fr))` }}>
        {weeks.map((week) => (
          <div key={week[0]} className="grid grid-cols-7 border-b border-line last:border-b-0" role="row">
            {week.map((day, i) => {
              const list = cellRows(events, tasks, day);
              const shown = list.slice(0, MONTH_CELL_EVENTS);
              const more = list.length - shown.length;
              const outside = day.slice(0, 7) !== month;
              return (
                <div
                  key={day}
                  role="gridcell"
                  data-day={day}
                  aria-label={dayLabel(day)}
                  onClick={() => onNew(day)}
                  className={cn("flex min-w-0 cursor-pointer flex-col gap-px border-r border-line p-1 last:border-r-0 hover:bg-panel-2/40", outside && "bg-panel-2/40")}
                >
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      onDay(day);
                    }}
                    className={cn(
                      "mb-0.5 inline-flex h-5 min-w-5 items-center justify-center self-start rounded-full px-1 text-[11px] tabular-nums hover:bg-ink/8",
                      outside && "text-muted",
                      i === 0 && !outside && "text-rose-500",
                      i === 6 && !outside && "text-sky-600",
                      day === today && "bg-accent font-bold text-white hover:bg-accent",
                    )}
                    title="この週を表示"
                  >
                    {parseDay(day).getDate()}
                  </button>
                  {shown.map((row) =>
                    "task" in row ? (
                      <TaskChip key={`task-${row.task.id}`} task={row.task} onOpen={onOpenTask} />
                    ) : (
                      <EventChip key={row.event.id} event={row.event} day={day} onOpen={onOpen} />
                    ),
                  )}
                  {more > 0 && (
                    <button
                      type="button"
                      data-more={more}
                      onClick={(e) => {
                        e.stopPropagation();
                        onDay(day);
                      }}
                      className="self-start rounded px-1 text-[11px] font-medium text-muted hover:bg-ink/6 hover:text-ink"
                    >
                      +{more}
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}

export function WeekGrid({ anchor, today, events, tasks = [], onOpen, onOpenTask = () => {}, onNew }: {
  anchor: DayKey;
  today: DayKey;
  events: CalendarEventOut[];
  /** M55: the tasks due in the week (in the all-day row). */
  tasks?: TaskOut[];
  onOpen: (event: CalendarEventOut) => void;
  onOpenTask?: (task: TaskOut) => void;
  onNew: (day: DayKey, hour?: number) => void;
}) {
  const start = weekStart(anchor);
  const days = Array.from({ length: 7 }, (_, i) => addDays(start, i));
  const scroller = useRef<HTMLDivElement>(null);
  // Morning in view first (8:00), as calendars do.
  useLayoutEffect(() => {
    if (scroller.current) scroller.current.scrollTop = HOUR_PX * 8 - 8;
  }, [start]);
  const allDay = days.map((day) => eventsOn(events, day).filter((e) => e.all_day || timeOnDay(e, day) === "終日"));
  const [minute, setMinute] = useState(() => new Date().getHours() * 60 + new Date().getMinutes());
  useEffect(() => {
    const timer = setInterval(() => setMinute(new Date().getHours() * 60 + new Date().getMinutes()), 60_000);
    return () => clearInterval(timer);
  }, []);
  const columns = "grid-cols-[48px_repeat(7,minmax(0,1fr))]";
  return (
    <div className="flex min-h-0 flex-1 flex-col" aria-label="週">
      <div className={cn("grid shrink-0 border-b border-line", columns)}>
        <div />
        {days.map((day, i) => (
          <div key={day} className={cn("border-l border-line py-1 text-center text-[11px]", i === 0 && "text-rose-500", i === 6 && "text-sky-600")}>
            <span className={cn("inline-flex h-6 min-w-6 items-center justify-center rounded-full px-1 font-semibold tabular-nums", day === today && "bg-accent text-white")}>
              {parseDay(day).getDate()}
            </span>
            <span className="ml-1 text-muted">{weekdayLabel(i)}</span>
          </div>
        ))}
      </div>
      <div className={cn("grid shrink-0 border-b border-line", columns)} aria-label="終日">
        <div className="px-1 py-1 text-right text-[10px] text-muted">終日</div>
        {days.map((day, i) => (
          <div key={day} className="flex min-h-[26px] min-w-0 flex-col gap-px border-l border-line p-0.5" data-all-day={day}>
            {allDay[i]!.map((event) => (
              <EventChip key={event.id} event={event} day={day} onOpen={onOpen} />
            ))}
            {tasksForDay(tasks, day).map((task) => (
              <TaskChip key={`task-${task.id}`} task={task} onOpen={onOpenTask} />
            ))}
          </div>
        ))}
      </div>
      <div ref={scroller} className="min-h-0 flex-1 overflow-y-auto">
        <div className={cn("relative grid", columns)} style={{ height: HOUR_PX * 24 }}>
          <div className="relative">
            {Array.from({ length: 24 }, (_, hour) => (
              <div key={hour} className="absolute right-1 -translate-y-1/2 text-[10px] tabular-nums text-muted" style={{ top: hour * HOUR_PX }}>
                {hour === 0 ? "" : `${hour}:00`}
              </div>
            ))}
          </div>
          {days.map((day) => (
            <div key={day} className="relative border-l border-line" data-week-day={day}>
              {Array.from({ length: 24 }, (_, hour) => (
                <button
                  key={hour}
                  type="button"
                  aria-label={`${dayLabel(day)} ${hour}:00 に予定を追加`}
                  onClick={() => onNew(day, hour)}
                  className="absolute inset-x-0 border-t border-line/60 hover:bg-panel-2/60"
                  style={{ top: hour * HOUR_PX, height: HOUR_PX }}
                />
              ))}
              {day === today && (
                <div aria-hidden className="pointer-events-none absolute inset-x-0 z-10 h-px bg-rose-500" style={{ top: (minute / 60) * HOUR_PX }} />
              )}
              {dayBlocks(events, day).map((block) => {
                const color = channelColor(block.event.channel_id);
                return (
                  <button
                    key={block.event.id}
                    type="button"
                    data-event={block.event.id}
                    onClick={() => onOpen(block.event)}
                    title={`${timeOnDay(block.event, day)} ${block.event.title}`}
                    className="absolute z-[5] overflow-hidden rounded-md border-l-[3px] px-1 py-0.5 text-left text-[11px] leading-tight text-ink shadow-sm hover:brightness-95"
                    style={{
                      top: (block.top / 60) * HOUR_PX,
                      height: Math.max((block.height / 60) * HOUR_PX - 1, 16),
                      left: `calc(${(block.lane / block.lanes) * 100}% + 1px)`,
                      width: `calc(${100 / block.lanes}% - 2px)`,
                      borderLeftColor: color,
                      background: `color-mix(in srgb, ${color} 16%, var(--color-canvas, #fff))`,
                    }}
                  >
                    <div className="truncate font-semibold">{block.event.title}</div>
                    <div className="truncate tabular-nums text-muted">{timeOnDay(block.event, day)}</div>
                  </button>
                );
              })}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/** Day by day, the days with events only (「今日」 and 「明日」 marked). */
export function AgendaList({ events, tasks = [], taskPlaceOf = (task) => taskPlace(task), start, end, today, onOpen, onOpenTask = () => {}, loading = false, empty = "この期間の予定はありません", showCalendar = true }: {
  events: CalendarEventOut[];
  /** M55: the tasks due, after the day's events. */
  tasks?: TaskOut[];
  /** Where a task lives (「#lab」, 「自分のタスク」, L9: a DM by its members). */
  taskPlaceOf?: (task: TaskOut) => string;
  start: DayKey;
  end: DayKey;
  today: DayKey;
  onOpen: (event: CalendarEventOut) => void;
  onOpenTask?: (task: TaskOut) => void;
  loading?: boolean;
  empty?: ReactNode;
  showCalendar?: boolean;
}) {
  const days = useMemo(() => {
    const out: Array<[DayKey, CalendarEventOut[], TaskOut[]]> = [];
    const count = daysBetween(start, end);
    for (let i = 0; i < count; i++) {
      const day = addDays(start, i);
      const list = eventsOn(events, day);
      const due = tasksForDay(tasks, day);
      if (list.length > 0 || due.length > 0) out.push([day, list, due]);
    }
    return out;
  }, [events, tasks, start, end]);
  if (days.length === 0) return <div className="py-16 text-center text-sm text-muted">{loading ? "読み込み中…" : empty}</div>;
  return (
    <div className="mx-auto max-w-3xl space-y-4" aria-label="予定の一覧">
      {days.map(([day, list, due]) => (
        <section key={day} data-agenda-day={day}>
          <h3 className="mb-1 flex items-baseline gap-2 text-xs font-semibold text-muted">
            <span className={cn(day === today && "text-accent")}>{dayLabel(day)}</span>
            {day === today && <span className="text-accent">今日</span>}
            {day === addDays(today, 1) && <span>明日</span>}
          </h3>
          <ul className="divide-y divide-line rounded-xl border border-line">
            {list.map((event) => (
              <li key={event.id}>
                <button type="button" data-event={event.id} onClick={() => onOpen(event)} className="flex w-full items-start gap-3 px-3 py-2 text-left hover:bg-panel-2/60">
                  <span className="w-[92px] shrink-0 pt-px text-xs tabular-nums text-muted">{timeOnDay(event, day)}</span>
                  <span aria-hidden className="mt-1 h-3 w-1 shrink-0 self-stretch rounded-full" style={{ background: channelColor(event.channel_id) }} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium">{event.title}</span>
                    <span className="flex min-w-0 items-center gap-2 text-xs text-muted">
                      {showCalendar && <span className="shrink-0">{event.channel_name ? `#${event.channel_name}` : "自分"}</span>}
                      {event.recurring && (
                        <span className="flex min-w-0 items-center gap-0.5 truncate" title={describeRrule(event.rrule, day)}>
                          <Repeat size={11} className="shrink-0" aria-label="繰り返し" />
                          <span className="truncate max-md:hidden">{describeRrule(event.rrule, day)}</span>
                        </span>
                      )}
                      {event.location && (
                        <span className="flex min-w-0 items-center gap-0.5 truncate"><MapPin size={11} className="shrink-0" />{event.location}</span>
                      )}
                    </span>
                  </span>
                </button>
              </li>
            ))}
            {due.map((task) => (
              <li key={`task-${task.id}`}>
                <button type="button" data-task={task.id} onClick={() => onOpenTask(task)} className="flex w-full items-start gap-3 px-3 py-2 text-left hover:bg-panel-2/60">
                  <span className="w-[92px] shrink-0 pt-px text-xs text-muted">期限</span>
                  <span aria-hidden className="mt-1 h-3 w-1 shrink-0 self-stretch rounded-full" style={{ background: channelColor(task.channel_id) }} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium">
                      <span aria-hidden className="mr-1">{task.status === "done" ? "☑" : "☐"}</span>
                      <span className={cn(task.status === "done" && "text-muted line-through")}>{task.title}</span>
                    </span>
                    {showCalendar && <span className="block text-xs text-muted">{taskPlaceOf(task)}</span>}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

/** A channel's 「予定」 tab: its events for the next 60 days, and 「予定を追加」 for those who may post. */
export function ChannelEvents({ controller, channel }: { controller: AppController; channel: ChannelState }) {
  const hub = useCalendarHub(controller);
  const now = useToday();
  const [dialog, setDialog] = useState<DialogState>(null);
  const end = addDays(now, LIST_DAYS);
  const { from, to } = rangeParams(now, end);
  const key = `channel:${channel.id}`;
  useEffect(() => {
    if (!hub) return;
    void hub.open(key, from, to, channel.id);
  }, [hub, key, from, to, channel.id]);
  useEffect(() => () => hub?.close(key), [hub, key]);
  const win = hub?.window(key);
  const canAdd = writableCalendars(controller).some((c) => c.id === channel.id);
  const note = windowNote(win);
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b border-line px-4 py-2">
        <span className="text-sm font-semibold">予定</span>
        <span className="text-xs text-muted">これから {LIST_DAYS} 日</span>
        {canAdd && (
          <Button size="sm" className="ml-auto" onClick={() => setDialog({ event: null, initial: newDraft(now, channel.id) })}>
            <Plus size={14} /> 予定を追加
          </Button>
        )}
      </div>
      {note && <div className="border-b border-line bg-warning/10 px-4 py-1.5 text-xs text-muted">{note}</div>}
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
        <AgendaList
          events={win?.events ?? []}
          start={now}
          end={end}
          today={now}
          onOpen={(event) => setDialog({ event })}
          loading={!win || win.state === "loading"}
          empty="これからの予定はありません"
          showCalendar={false}
        />
      </div>
      {dialog && <CalendarEventDialog controller={controller} event={dialog.event} initial={dialog.initial} onClose={() => setDialog(null)} />}
    </div>
  );
}
