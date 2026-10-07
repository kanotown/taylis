/**
 * M112 (docs/RESERVATIONS.md §6): 「予約」 — the workspace's shared, limited seats (e.g. the lab's Claude Premium seats).
 *
 * Per pool: my reservations (cancel / extend / return), 「予約する」 (a booking dialog: day, start on the hour, how
 * long) and 「今すぐ (順番待ち)」 (the walk-in queue), the operators' to-do (割り当てた / 外した / 入れ替えた, pressed
 * after doing it in the resource's own console), and the day's timeline (hours across, seats down; today and up to two
 * weeks ahead). Administrators add pools; they and a pool's creator change its settings (here only, not on phones).
 */
import { CalendarClock, ChevronLeft, ChevronRight, Pencil, Plus, Ticket, Trash2 } from "lucide-react";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";

import type { PoolCreate, PoolOut, ReservationOut, TodoOut } from "../api/types";
import type { AppController } from "../state/app";
import { Avatar } from "./Avatar";
import { BackButton } from "./compact";
import { Badge, Button, cn, Input, Modal } from "./primitives";
import {
  activeText,
  bookingDays,
  bookingText,
  dayLabel,
  dayStart,
  deviceZone,
  dueTodos,
  durationChoices,
  durationDefault,
  hm,
  myActive,
  myReservations,
  poolFormProblem,
  rowOf,
  spanLabel,
  startChoices,
  timelineBars,
  todoLine,
  walkinText,
  whenLabel,
} from "./reservationPools";
import { t } from "../i18n";

function userName(controller: AppController, userId: string): string {
  return controller.store.users.get(userId)?.display_name ?? t("reservations.unknown");
}

/** The page (the centre view on a wide screen, a pushed screen on a phone). */
export function ReservationsView({ controller }: { controller: AppController }) {
  const pools = controller.store.reservationPools;
  const [editing, setEditing] = useState<PoolOut | "new" | null>(null);
  useEffect(() => {
    void controller.engine?.loadReservationPools();
  }, [controller]);
  return (
    <div className="flex min-h-0 flex-1 flex-col" data-reservations-page>
      <header className="flex h-[52px] shrink-0 items-center gap-2 border-b border-line px-4 max-md:px-2">
        <BackButton />
        <span className="text-muted max-md:hidden"><Ticket size={18} /></span>
        <strong className="text-[15px]">{t("nav.reservations")}</strong>
        {controller.can("reservations.manage") && (
          <Button size="sm" className="ml-auto" onClick={() => setEditing("new")} aria-label={t("reservations.addPool")}>
            <Plus size={14} /> <span className="max-md:hidden">{t("reservations.addPool")}</span>
          </Button>
        )}
      </header>
      <div data-scroll-memory className="min-h-0 flex-1 overflow-y-auto px-4 py-4 max-md:px-3">
        <div className="mx-auto max-w-5xl space-y-8">
          {pools === null ? (
            <p className="text-sm text-muted">{t("common.loading")}</p>
          ) : pools.length === 0 ? (
            <p className="text-sm text-muted">
              {t("reservations.none")}{controller.can("reservations.manage") ? t("reservations.noneAdmin") : ""}
            </p>
          ) : (
            pools.map((pool) => <PoolSection key={pool.id} controller={controller} pool={pool} onEdit={() => setEditing(pool)} />)
          )}
        </div>
      </div>
      {editing !== null && <PoolSettingsDialog controller={controller} pool={editing === "new" ? null : editing} onClose={() => setEditing(null)} />}
    </div>
  );
}

function useNow(stepMs = 30_000): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), stepMs);
    return () => clearInterval(timer);
  }, [stepMs]);
  return now;
}

/** One pool: mine, the buttons, the to-do, the timeline, the walk-ins. */
export function PoolSection({ controller, pool, onEdit }: { controller: AppController; pool: PoolOut; onEdit: () => void }) {
  const now = useNow();
  const me = controller.store.me?.id;
  const mine = myReservations(pool, me);
  // One active reservation per person and pool: while I have one, both buttons are off and say why.
  const active = myActive(pool, me);
  const activeNote = active ? t("reservations.alreadyActive", { what: activeText(active, now) }) : undefined;
  const mineRef = useRef<HTMLDivElement>(null);
  const [day, setDay] = useState(() => dayStart(new Date()));
  const [booking, setBooking] = useState(false);
  const [busy, setBusy] = useState(false);
  const run = async (call: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await call();
    } finally {
      setBusy(false);
    }
  };
  const days = bookingDays(now, pool.horizon_days);
  const dayIndex = Math.max(0, days.findIndex((d) => d.getTime() === day.getTime()));
  const todos = pool.can_operate ? pool.todos : [];

  return (
    <section aria-label={pool.name} data-pool={pool.id} className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <Ticket size={16} className="shrink-0 text-muted" />
        <h2 className="min-w-0 truncate text-[16px] font-semibold">{pool.name}</h2>
        <span className="text-xs text-muted">{t("reservations.poolSummary", { capacity: pool.capacity, hours: pool.max_hours })}</span>
        {!pool.enabled && <Badge>{t("workflow.paused")}</Badge>}
        {pool.can_manage && (
          <Button size="sm" variant="ghost" onClick={onEdit} aria-label={t("reservations.poolSettingsOf", { name: pool.name })}><Pencil size={13} /></Button>
        )}
        <span className="ml-auto flex gap-2">
          <Button size="sm" disabled={!pool.enabled || busy || active !== null} onClick={() => setBooking(true)} title={activeNote}>
            <CalendarClock size={14} /> {t("reservations.book")}
          </Button>
          {!mine.walkin && (
            <Button size="sm" variant="secondary" disabled={!pool.enabled || busy || active !== null} onClick={() => void run(() => controller.reservePool(pool.id))} title={activeNote}>
              {t("reservations.walkinButton")}
            </Button>
          )}
        </span>
      </div>
      {activeNote && (
        <p className="-mt-2 text-xs text-muted" data-already-active>
          {activeNote}{" "}
          <button type="button" className="text-accent underline-offset-2 hover:underline" onClick={() => mineRef.current?.scrollIntoView?.({ block: "nearest", behavior: "smooth" })}>
            {t("reservations.showMine")}
          </button>
        </p>
      )}

      {(mine.walkin || mine.bookings.length > 0) && (
        <div ref={mineRef} className="rounded-xl border border-line px-3 py-2" aria-label={t("reservations.mine")}>
          <h3 className="text-xs font-semibold text-muted">{t("reservations.mine")}</h3>
          <ul className="divide-y divide-line">
            {mine.bookings.map((row) => (
              <li key={row.id} className="flex flex-wrap items-center gap-2 py-2 text-sm" data-my-booking={row.id}>
                <span className="min-w-0 flex-1">{bookingText(row, now)}</span>
                {row.status === "booked" && (
                  <>
                    <Button size="sm" variant="secondary" disabled={busy || !row.can_extend} onClick={() => void run(() => controller.extendReservation(row.id))} title={row.can_extend ? undefined : t("reservations.cannotExtend")}>
                      {t("reservations.extend")}
                    </Button>
                    <ConfirmButton label={t("reservations.cancel")} question={t("reservations.cancelQuestion")} disabled={busy} onConfirm={() => void run(() => controller.reservationAction(row.id, "cancel"))} />
                  </>
                )}
                {row.status === "holding" && (
                  <>
                    <Button size="sm" variant="secondary" disabled={busy || !row.can_extend} onClick={() => void run(() => controller.extendReservation(row.id))}>{t("reservations.extend")}</Button>
                    <ConfirmButton label={t("reservations.return")} question={t("reservations.returnQuestion")} disabled={busy} onConfirm={() => void run(() => controller.reservationAction(row.id, "return"))} />
                  </>
                )}
              </li>
            ))}
            {mine.walkin && (
              <li className="flex flex-wrap items-center gap-2 py-2 text-sm" data-my-walkin={mine.walkin.id}>
                <span className="min-w-0 flex-1">{t("reservations.walkinLine", { text: walkinText(mine.walkin, pool, now) })}</span>
                {mine.walkin.status === "waiting" && (
                  <Button size="sm" variant="secondary" disabled={busy} onClick={() => void run(() => controller.reservationAction(mine.walkin!.id, "cancel"))}>{t("reservations.cancel")}</Button>
                )}
                {mine.walkin.status === "holding" && (
                  <ConfirmButton label={t("reservations.return")} question={t("reservations.returnQuestion")} disabled={busy} onConfirm={() => void run(() => controller.reservationAction(mine.walkin!.id, "return"))} />
                )}
              </li>
            )}
          </ul>
        </div>
      )}

      {pool.can_operate && <TodoList controller={controller} pool={pool} todos={todos} now={now} busy={busy} run={run} />}

      <div className="space-y-2">
        <div className="flex items-center gap-1">
          <Button size="sm" variant="ghost" aria-label={t("reservations.prevDay")} disabled={dayIndex === 0} onClick={() => setDay(days[dayIndex - 1]!)}><ChevronLeft size={14} /></Button>
          <select
            aria-label={t("reservations.date")}
className="rounded-lg border border-line bg-canvas px-2 py-1 text-sm"
            value={day.getTime()}
            onChange={(e) => setDay(new Date(Number(e.target.value)))}
          >
            {days.map((d) => (
              <option key={d.getTime()} value={d.getTime()}>{dayLabel(d, now)}{dayLabel(d, now).length <= 2 ? ` (${d.getMonth() + 1}/${d.getDate()})` : ""}</option>
            ))}
          </select>
          <Button size="sm" variant="ghost" aria-label={t("reservations.nextDay")} disabled={dayIndex >= days.length - 1} onClick={() => setDay(days[dayIndex + 1]!)}><ChevronRight size={14} /></Button>
        </div>
        <Timeline controller={controller} pool={pool} day={day} now={now} />
      </div>

      <WalkIns controller={controller} pool={pool} now={now} busy={busy} run={run} />

      <p className="text-xs text-muted">
        {t("reservations.rules", { maxHours: pool.max_hours, minHours: pool.min_hours, grace: pool.grace_minutes })}
        {pool.can_operate ? t("reservations.operatorRule") : ""}
      </p>
      {booking && <BookingDialog controller={controller} pool={pool} initialDay={day} onClose={() => setBooking(false)} />}
    </section>
  );
}

function ConfirmButton({ label, question, disabled, onConfirm, variant = "secondary" }: { label: string; question: string; disabled?: boolean; onConfirm: () => void; variant?: "secondary" | "danger" | "primary" }) {
  const [asking, setAsking] = useState(false);
  if (!asking) return <Button size="sm" variant={variant === "primary" ? undefined : variant} disabled={disabled} onClick={() => setAsking(true)}>{label}</Button>;
  return (
    <span className="flex items-center gap-1 rounded-lg bg-panel-2 px-2 py-1 text-xs">
      {question}
      <Button size="sm" variant="secondary" onClick={() => setAsking(false)}>{t("reservations.dontDo")}</Button>
      <Button
        size="sm"
        variant={variant === "danger" ? "danger" : undefined}
        onClick={() => {
          setAsking(false);
          onConfirm();
        }}
      >
        {label}
      </Button>
    </span>
  );
}

/** The operators' to-do: what to do in the console now, and the bookings starting within 10 minutes. */
function TodoList({ controller, pool, todos, now, busy, run }: { controller: AppController; pool: PoolOut; todos: TodoOut[]; now: Date; busy: boolean; run: (call: () => Promise<unknown>) => Promise<void> }) {
  const name = (id: string) => userName(controller, id);
  const press = (todo: TodoOut) => {
    if (todo.action === "assign" && todo.assign_id) return run(() => controller.reservationAction(todo.assign_id!, "assign"));
    if (todo.action === "remove" && todo.remove_id) return run(() => controller.reservationAction(todo.remove_id!, "remove"));
    if (todo.action === "swap" && todo.remove_id && todo.assign_id) return run(() => controller.swapReservations(pool.id, todo.remove_id!, todo.assign_id!));
    return Promise.resolve();
  };
  const label = (todo: TodoOut) => (todo.action === "assign" ? t("reservations.assigned") : todo.action === "remove" ? t("reservations.removed") : t("reservations.swapped"));
  const upcomingBooking = (todo: TodoOut) => (todo.upcoming ? rowOf(pool, todo.assign_id) : undefined);
  return (
    <div className="rounded-xl border border-line px-3 py-2" aria-label={t("reservations.todos")} data-todos>
      <h3 className="flex items-center gap-2 text-xs font-semibold text-muted">
        {t("reservations.todos")} {dueTodos(pool).length > 0 && <Badge tone="danger">{dueTodos(pool).length}</Badge>}
      </h3>
      {todos.length === 0 ? (
        <p className="py-2 text-sm text-muted">{t("reservations.noTodos")}</p>
      ) : (
        <ul className="divide-y divide-line">
          {todos.map((todo) => {
            const early = upcomingBooking(todo);
            const tooEarly = !!early?.start_at && Date.parse(early.start_at) - now.getTime() > 10 * 60_000;
            return (
              <li key={todo.key} className="flex flex-wrap items-center gap-2 py-2 text-sm" data-todo={todo.key}>
                {todo.upcoming && <Badge tone="accent">{t("reservations.soon")}</Badge>}
                <span className="min-w-0 flex-1">{todoLine(todo, pool, name, now)}</span>
                <Button size="sm" variant={todo.upcoming ? "secondary" : undefined} disabled={busy || tooEarly} onClick={() => void press(todo)}>{label(todo)}</Button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

const LANE_PX = 28;

/** Hours across, seats down; bookings and walk-ins as bars (mine stand out). */
function Timeline({ controller, pool, day, now }: { controller: AppController; pool: PoolOut; day: Date; now: Date }) {
  const bars = timelineBars(pool, day, now);
  const lanes = Math.max(pool.capacity, ...bars.map((b) => b.lane + 1));
  const me = controller.store.me?.id;
  const today = dayStart(now).getTime() === day.getTime();
  const nowAt = (now.getTime() - day.getTime()) / (24 * 3_600_000);
  // A narrow screen scrolls the day sideways: today starts an hour before now, another day at its first bar.
  const scroller = useRef<HTMLDivElement>(null);
  const firstBar = bars[0]?.from ?? 0;
  useEffect(() => {
    const el = scroller.current;
    if (!el || el.scrollWidth <= el.clientWidth) return;
    const at = today ? Math.max(0, nowAt - 1 / 24) : firstBar;
    el.scrollLeft = at * el.scrollWidth;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [day.getTime()]);
  return (
    <div ref={scroller} className="overflow-x-auto rounded-xl border border-line" data-timeline>
      <div className="relative min-w-[720px]">
        <div className="flex border-b border-line text-[10px] text-muted">
          {Array.from({ length: 24 }, (_, h) => (
            <div key={h} className="flex-1 border-l border-line/60 px-0.5 first:border-l-0">{h}</div>
          ))}
        </div>
        <div className="relative" style={{ height: lanes * LANE_PX + 8 }}>
          {Array.from({ length: 24 }, (_, h) => (
            <div key={h} className="absolute bottom-0 top-0 border-l border-line/40" style={{ left: `${(h / 24) * 100}%` }} />
          ))}
          {Array.from({ length: lanes }, (_, lane) => (
            <div key={lane} className={cn("absolute left-0 right-0 border-t border-dashed border-line/50", lane >= pool.capacity && "border-danger/40")} style={{ top: 4 + lane * LANE_PX }} />
          ))}
          {today && nowAt > 0 && nowAt < 1 && <div className="absolute bottom-0 top-0 w-px bg-rose-500" style={{ left: `${nowAt * 100}%` }} aria-hidden="true" />}
          {bars.map((bar) => {
            const who = userName(controller, bar.userId);
            const span = `${hm(bar.start)}${t("common.rangeTo")}${hm(bar.end)}`;
            const mineBar = bar.userId === me;
            return (
              <div
                key={bar.id}
                data-bar={bar.id}
                title={`${who} · ${bar.kind === "walkin" ? t("reservations.walkin") : t("reservations.booking")} ${span}`}
                className={cn(
                  "absolute flex items-center gap-1 overflow-hidden rounded-md px-1.5 text-[11px] leading-none",
                  bar.kind === "walkin" ? "border border-dashed border-amber-500 bg-amber-500/15" : "bg-accent-soft text-accent",
                  bar.status === "done" && "opacity-50",
                  bar.status === "holding" && bar.kind === "booking" && "bg-accent-solid text-white",
                  mineBar && "ring-2 ring-accent",
                )}
                style={{ left: `${bar.from * 100}%`, width: `${Math.max(0.5, (bar.to - bar.from) * 100)}%`, top: 6 + bar.lane * LANE_PX, height: LANE_PX - 6 }}
              >
                <span className="truncate">{who}</span>
              </div>
            );
          })}
        </div>
      </div>
      <div className="flex gap-3 border-t border-line px-2 py-1 text-[11px] text-muted">
        <span><span className="mr-1 inline-block h-2 w-3 rounded-sm bg-accent-soft align-middle" />{t("reservations.booking")}</span>
        <span><span className="mr-1 inline-block h-2 w-3 rounded-sm bg-accent-solid align-middle" />{t("reservations.bookingInUse")}</span>
        <span><span className="mr-1 inline-block h-2 w-3 rounded-sm border border-dashed border-amber-500 align-middle" />{t("reservations.walkin")}</span>
      </div>
    </div>
  );
}

/** Walk-ins: who is on a seat (until when), and the queue. Operators also see the addresses. */
function WalkIns({ controller, pool, now, busy, run }: { controller: AppController; pool: PoolOut; now: Date; busy: boolean; run: (call: () => Promise<unknown>) => Promise<void> }) {
  if (pool.holders.length === 0 && pool.waiting.length === 0) return null;
  const person = (row: ReservationOut, line: string, extra?: ReactNode) => (
    <li key={row.id} className="flex items-center gap-2 py-1.5 text-sm" data-walkin={row.id}>
      <Avatar id={row.user_id} name={userName(controller, row.user_id)} size={22} className="rounded-md" />
      <span className="min-w-0 flex-1">
        <span className="font-medium">{userName(controller, row.user_id)}</span>
        {row.email && <span className="ml-1 text-xs text-muted">{row.email}</span>}
        <span className="block text-xs text-muted">{line}</span>
      </span>
      {extra}
    </li>
  );
  return (
    <div className="grid gap-3 md:grid-cols-2">
      <div className="rounded-xl border border-line px-3 py-2">
        <h3 className="text-xs font-semibold text-muted">{t("reservations.holdersTitle", { count: pool.holders.length, capacity: pool.capacity })}</h3>
        <ul>
          {pool.holders.map((row) =>
            person(
              row,
              row.kind === "booking" && row.start_at && row.end_at
                ? `${t("reservations.booking")} ${spanLabel(row.start_at, row.end_at, now)}${row.status === "returning" ? ` · ${t("reservations.returned")}` : ""}`
                : walkinText(row, pool, now),
            ),
          )}
          {pool.holders.length === 0 && <li className="py-1.5 text-sm text-muted">{t("reservations.nobody")}</li>}
        </ul>
      </div>
      <div className="rounded-xl border border-line px-3 py-2">
        <h3 className="text-xs font-semibold text-muted">{t("reservations.queueTitle", { count: pool.waiting.length })}</h3>
        <ul>
          {pool.waiting.map((row) =>
            person(
              row,
              `${t("reservations.since", { at: whenLabel(row.requested_at, now) })} · ${row.step === "assign" ? (row.until ? t("reservations.freeUntilShort", { until: whenLabel(row.until, now) }) : t("reservations.reason.free")) : row.step === "swap" ? t("reservations.nextSwap") : t("reservations.nth", { position: row.position })}`,
              pool.can_operate && row.user_id !== controller.store.me?.id ? (
                <ConfirmButton label={t("reservations.cancel")} question={t("reservations.cancelQueueQuestion", { name: userName(controller, row.user_id) })} disabled={busy} onConfirm={() => void run(() => controller.reservationAction(row.id, "cancel"))} />
              ) : undefined,
            ),
          )}
          {pool.waiting.length === 0 && <li className="py-1.5 text-sm text-muted">{t("reservations.nobody")}</li>}
        </ul>
      </div>
    </div>
  );
}

/** 「予約する」: a day, a start on the hour (full hours greyed) and how long. */
export function BookingDialog({ controller, pool, initialDay, onClose }: { controller: AppController; pool: PoolOut; initialDay: Date; onClose: () => void }) {
  const now = useMemo(() => new Date(), []);
  const days = bookingDays(now, pool.horizon_days);
  const [day, setDay] = useState(initialDay);
  const starts = startChoices(pool, day, now);
  const firstFree = starts.find((s) => !s.full)?.start ?? null;
  const [start, setStart] = useState<Date | null>(firstFree);
  const startOk = start && starts.some((s) => s.start.getTime() === start.getTime() && !s.full) ? start : firstFree;
  const durations = startOk ? durationChoices(pool, startOk, now) : [];
  // The length defaults to the pool's maximum, or the longest that fits from the start (and the dialog says why); a
  // length the person picked stays while it fits.
  const [hours, setHours] = useState<number | null>(null);
  const fit = startOk ? durationDefault(pool, startOk, now) : null;
  const chosenHours = hours !== null && durations.includes(hours) ? hours : (durations[durations.length - 1] ?? 1);
  const limitNote =
    fit && fit.hours > 0 && fit.at && fit.limit !== "max"
      ? fit.limit === "full"
        ? t("reservations.limitFull", { at: dayStart(fit.at).getTime() === dayStart(startOk!).getTime() ? hm(fit.at) : whenLabel(fit.at.toISOString(), now), count: fit.hours })
        : t("reservations.limitHorizon", { days: pool.horizon_days, count: fit.hours })
      : null;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async () => {
    if (!startOk) return;
    setBusy(true);
    setError(null);
    const out = await controller.bookReservation(pool.id, startOk.toISOString(), chosenHours);
    setBusy(false);
    if (out) onClose();
    else setError(controller.error ?? t("reservations.bookFailed"));
  };
  const end = startOk ? new Date(startOk.getTime() + chosenHours * 3_600_000) : null;
  return (
    <Modal onClose={onClose} title={t("reservations.bookTitle", { name: pool.name })} description={t("reservations.bookDescription", { max: pool.max_hours })} className="w-[480px]">
      <form
        className="mt-3 space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <label className="block text-xs font-semibold text-muted">
          {t("reservations.date")}
          <select className="mt-1 block w-full rounded-lg border border-line bg-canvas px-2 py-2 text-sm" value={day.getTime()} onChange={(e) => setDay(new Date(Number(e.target.value)))}>
            {days.map((d) => <option key={d.getTime()} value={d.getTime()}>{dayLabel(d, now)} ({d.getMonth() + 1}/{d.getDate()})</option>)}
          </select>
        </label>
        <div className="grid grid-cols-2 gap-2">
          <label className="block text-xs font-semibold text-muted">
            {t("common.start")}
            <select aria-label={t("common.start")} className="mt-1 block w-full rounded-lg border border-line bg-canvas px-2 py-2 text-sm" value={startOk?.getTime() ?? ""} onChange={(e) => setStart(new Date(Number(e.target.value)))}>
              {starts.map((s) => <option key={s.start.getTime()} value={s.start.getTime()} disabled={s.full}>{hm(s.start)}{s.full ? t("reservations.full") : ""}</option>)}
            </select>
          </label>
          <label className="block text-xs font-semibold text-muted">
            {t("reservations.hours")}
            <select aria-label={t("reservations.hours")} className="mt-1 block w-full rounded-lg border border-line bg-canvas px-2 py-2 text-sm" value={chosenHours} onChange={(e) => setHours(Number(e.target.value))} disabled={durations.length === 0}>
              {durations.map((h) => <option key={h} value={h}>{t("reservations.hoursValue", { count: h })}</option>)}
            </select>
          </label>
        </div>
        {startOk && end ? <p className="text-sm">{spanLabel(startOk.toISOString(), end.toISOString(), now)}</p> : <p className="text-sm text-muted">{t("reservations.noFreeTime")}</p>}
        {limitNote && <p className="text-xs text-muted" data-duration-limit>{limitNote}</p>}
        {error && <p role="alert" className="text-xs text-danger">{error}</p>}
        <div className="flex justify-end gap-2">
          <Button size="sm" variant="secondary" onClick={onClose}>{t("common.cancel")}</Button>
          <Button size="sm" type="submit" disabled={busy || !startOk || durations.length === 0}>{t("reservations.book")}</Button>
        </div>
      </form>
    </Modal>
  );
}

// --- settings ------------------------------------------------------------------------------------

type Form = {
  name: string;
  capacity: string;
  maxHours: string;
  minHours: string;
  graceMinutes: string;
  operatorIds: string[];
  enabled: boolean;
  visibility: "all" | "channel" | "group";
  visibilityChannelId: string;
  visibilityGroupId: string;
  logChannelId: string;
};

function formOf(pool: PoolOut | null): Form {
  return pool
    ? {
        name: pool.name,
        capacity: String(pool.capacity),
        maxHours: String(pool.max_hours),
        minHours: String(pool.min_hours),
        graceMinutes: String(pool.grace_minutes),
        operatorIds: [...pool.operator_ids],
        enabled: pool.enabled,
        visibility: pool.visibility,
        visibilityChannelId: pool.visibility_channel_id ?? "",
        visibilityGroupId: pool.visibility_group_id ?? "",
        logChannelId: pool.log_channel_id ?? "",
      }
    : { name: "", capacity: "3", maxHours: "6", minHours: "6", graceMinutes: "15", operatorIds: [], enabled: true, visibility: "all", visibilityChannelId: "", visibilityGroupId: "", logChannelId: "" };
}

/** Add or edit a pool (administrators; a pool's creator edits it), delete it. */
export function PoolSettingsDialog({ controller, pool, onClose }: { controller: AppController; pool: PoolOut | null; onClose: () => void }) {
  const store = controller.store;
  const [form, setForm] = useState<Form>(() => formOf(pool));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const people = [...store.users.values()]
    .filter((u) => u.role !== "bot" && u.role !== "guest" && !u.deactivated_at)
    .sort((a, b) => a.display_name.localeCompare(b.display_name, "ja"));
  const channels = [...store.channels.values()]
    .filter((c) => (c.type === "public" || c.type === "private") && c.isMember && !c.archived)
    .sort((a, b) => (a.name ?? "").localeCompare(b.name ?? "", "ja"));
  const groups = [...store.groups.values()].sort((a, b) => a.name.localeCompare(b.name, "ja"));
  const submit = async () => {
    const problem = poolFormProblem(form);
    if (problem) return setError(problem);
    if (form.visibility === "channel" && !form.visibilityChannelId) return setError(t("reservations.check.visibilityChannel"));
    if (form.visibility === "group" && !form.visibilityGroupId) return setError(t("reservations.check.visibilityGroup"));
    setBusy(true);
    setError(null);
    const body = {
      name: form.name.trim(),
      capacity: Number(form.capacity),
      max_hours: Number(form.maxHours),
      min_hours: Number(form.minHours),
      grace_minutes: Number(form.graceMinutes),
      operator_ids: form.operatorIds,
      enabled: form.enabled,
      visibility: form.visibility,
      visibility_channel_id: form.visibility === "channel" ? form.visibilityChannelId : null,
      visibility_group_id: form.visibility === "group" ? form.visibilityGroupId : null,
      log_channel_id: form.logChannelId || null,
    };
    const out = pool ? await controller.updateReservationPool(pool.id, body) : await controller.createReservationPool({ ...body, tz: deviceZone() } as PoolCreate);
    setBusy(false);
    if (out) onClose();
    else setError(controller.error ?? t("common.saveFailed"));
  };
  const field = "block text-xs font-semibold text-muted";
  const select = "mt-1 block w-full rounded-lg border border-line bg-canvas px-2 py-2 text-sm text-ink";
  return (
    <Modal onClose={onClose} title={pool ? t("reservations.poolSettings") : t("reservations.addPool")} description={t("reservations.poolDescription")} className="w-[600px]">
      <form
        className="mt-3 space-y-3"
        aria-label={pool ? t("reservations.editPool") : t("reservations.addPool")}
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <label className={field}>
          {t("reservations.name")}
          <Input className="mt-1" maxLength={80} placeholder={t("reservations.namePlaceholder")} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} autoFocus />
        </label>
        <div className="grid grid-cols-4 gap-2 max-md:grid-cols-2">
          <label className={field}>
            {t("reservations.capacity")}
            <Input className="mt-1" inputMode="numeric" value={form.capacity} onChange={(e) => setForm({ ...form, capacity: e.target.value })} />
          </label>
          <label className={field}>
            {t("reservations.maxHours")}
            <Input className="mt-1" inputMode="numeric" value={form.maxHours} onChange={(e) => setForm({ ...form, maxHours: e.target.value })} />
          </label>
          <label className={field}>
            {t("reservations.minHours")}
            <Input className="mt-1" inputMode="numeric" value={form.minHours} onChange={(e) => setForm({ ...form, minHours: e.target.value })} />
          </label>
          <label className={field}>
            {t("reservations.grace")}
            <Input className="mt-1" inputMode="numeric" value={form.graceMinutes} onChange={(e) => setForm({ ...form, graceMinutes: e.target.value })} />
          </label>
        </div>
        <fieldset>
          <legend className={field}>{t("reservations.operators")}</legend>
          <div className="mt-1 max-h-40 space-y-0.5 overflow-y-auto rounded-md border border-line px-2 py-1">
            {people.map((u) => (
              <label key={u.id} className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={form.operatorIds.includes(u.id)}
                  onChange={(e) => setForm({ ...form, operatorIds: e.target.checked ? [...form.operatorIds, u.id] : form.operatorIds.filter((id) => id !== u.id) })}
                />
                {u.display_name} <span className="text-xs text-muted">@{u.username}</span>
              </label>
            ))}
          </div>
          <p className="mt-1 text-xs text-muted">{t("reservations.operatorsNote")}</p>
        </fieldset>
        <div className="grid grid-cols-2 gap-2 max-md:grid-cols-1">
          <label className={field}>
            {t("reservations.visibility")}
            <select className={select} value={form.visibility} onChange={(e) => setForm({ ...form, visibility: e.target.value as Form["visibility"] })}>
              <option value="all">{t("reservations.visibilityAll")}</option>
              <option value="channel">{t("reservations.visibilityChannel")}</option>
              <option value="group">{t("reservations.visibilityGroup")}</option>
            </select>
          </label>
          {form.visibility === "channel" && (
            <label className={field}>
              {t("sidebar.channels")}
              <select className={select} value={form.visibilityChannelId} onChange={(e) => setForm({ ...form, visibilityChannelId: e.target.value })}>
                <option value="">{t("workflow.choose")}</option>
                {channels.map((c) => <option key={c.id} value={c.id}>#{c.name}</option>)}
              </select>
            </label>
          )}
          {form.visibility === "group" && (
            <label className={field}>
              {t("composer.group")}
              <select className={select} value={form.visibilityGroupId} onChange={(e) => setForm({ ...form, visibilityGroupId: e.target.value })}>
                <option value="">{t("workflow.choose")}</option>
                {groups.map((g) => <option key={g.id} value={g.id}>@{g.name}</option>)}
              </select>
            </label>
          )}
        </div>
        <label className={field}>
          {t("reservations.logChannel")}
          <select className={select} value={form.logChannelId} onChange={(e) => setForm({ ...form, logChannelId: e.target.value })}>
            <option value="">{t("reservations.noLog")}</option>
            {channels.map((c) => <option key={c.id} value={c.id}>#{c.name}</option>)}
          </select>
          <span className="mt-1 block font-normal">{t("reservations.logNote")}</span>
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={form.enabled} onChange={(e) => setForm({ ...form, enabled: e.target.checked })} />
          {t("reservations.accepting")}
        </label>
        {error && <p role="alert" className="text-xs text-danger">{error}</p>}
        {confirmDelete && pool && (
          <div className="space-y-1.5 rounded-lg bg-panel-2 px-2 py-1.5 text-xs">
            <p>
              {t("reservations.deleteQuestion", { name: pool.name })}
              {pool.holders.length > 0 ? t("reservations.deleteHolders", { count: pool.holders.length }) : ""}
            </p>
            <div className="flex justify-end gap-2">
              <Button size="sm" variant="secondary" onClick={() => setConfirmDelete(false)}>{t("common.cancel")}</Button>
              <Button size="sm" variant="danger" onClick={() => void controller.deleteReservationPool(pool.id).then((ok) => { if (ok) onClose(); })}>{t("common.delete")}</Button>
            </div>
          </div>
        )}
        <div className="flex items-center justify-end gap-2">
          {pool && !confirmDelete && (
            <Button size="sm" variant="ghost" className="mr-auto text-danger" onClick={() => setConfirmDelete(true)}><Trash2 size={13} /> {t("common.delete")}</Button>
          )}
          <Button size="sm" variant="secondary" onClick={onClose}>{t("common.cancel")}</Button>
          <Button size="sm" type="submit" disabled={busy}>{pool ? t("common.save") : t("common.add")}</Button>
        </div>
      </form>
    </Modal>
  );
}
