/**
 * M112 (docs/RESERVATIONS.md §6): the pure parts of the 「予約」 page — the day's timeline (bars in lanes, the seats in
 * use per hour), the booking choices (start on the hour, how long), my reservations, the operators' to-do and the
 * words. Times are the device's (the page draws one local day; the pools' grid is whole hours).
 */
import type { PoolOut, ReservationOut, TodoOut } from "../api/types";
import { t, weekdayName } from "../i18n";

export const HOUR_MS = 3_600_000;

const ms = (iso: string | null | undefined): number => (iso ? Date.parse(iso) : NaN);

/** Local midnight of the day `date` is in. */
export function dayStart(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

/** The days a booking can be made on: today and the next `horizonDays`. */
export function bookingDays(now: Date, horizonDays: number): Date[] {
  const today = dayStart(now);
  return Array.from({ length: horizonDays + 1 }, (_, i) => new Date(today.getFullYear(), today.getMonth(), today.getDate() + i));
}

/** 「今日」 「明日」 or 「10/7 (水)」. */
export function dayLabel(day: Date, now: Date): string {
  const diff = Math.round((dayStart(day).getTime() - dayStart(now).getTime()) / (24 * HOUR_MS));
  if (diff === 0) return t("common.today");
  if (diff === 1) return t("common.tomorrow");
  return t("common.monthDayWeekday", { month: day.getMonth() + 1, day: day.getDate(), weekday: weekdayName((day.getDay() + 6) % 7) });
}

/** 「13:00」. */
export function hm(iso: string | Date): string {
  const d = typeof iso === "string" ? new Date(iso) : iso;
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/** 「13:00〜16:00」 today, else 「10/7 (水) 13:00〜16:00」. */
export function spanLabel(startIso: string, endIso: string, now: Date): string {
  const start = new Date(startIso);
  const day = dayStart(start).getTime() === dayStart(now).getTime() ? "" : `${dayLabel(start, now)} `;
  return `${day}${hm(start)}${t("common.rangeTo")}${hm(endIso)}`;
}

/** 「13:00」 today, else 「10/7 (水) 13:00」. */
export function whenLabel(iso: string, now: Date): string {
  const d = new Date(iso);
  return dayStart(d).getTime() === dayStart(now).getTime() ? hm(d) : `${dayLabel(d, now)} ${hm(d)}`;
}

/** The bookings still counting (booked or on a seat). */
export function liveBookings(pool: PoolOut): ReservationOut[] {
  return pool.bookings.filter((b) => b.status === "booked" || b.status === "holding" || b.status === "returning");
}

/** Seats promised over [start, end): the bookings on it and the walk-ins whose guarantee reaches into it. */
function promised(pool: PoolOut, start: number, end: number, now: number, skipId?: string): number {
  let count = 0;
  for (const b of liveBookings(pool)) if (b.id !== skipId && ms(b.start_at) < end && ms(b.end_at) > start) count += 1;
  const from = Math.max(start, now);
  for (const h of pool.holders) {
    if (h.kind === "walkin" && h.status === "holding" && ms(h.guarantee_until) > from && from < end) count += 1;
  }
  return count;
}

/** Whether every hour of [start, start + hours) has a seat left (the server's check, as far as the page knows). */
export function slotFits(pool: PoolOut, start: Date, hours: number, now: Date, skipId?: string): boolean {
  for (let i = 0; i < hours; i += 1) {
    const from = start.getTime() + i * HOUR_MS;
    if (promised(pool, from, from + HOUR_MS, now.getTime(), skipId) + 1 > pool.capacity) return false;
  }
  return true;
}

/** The end of the booking horizon: midnight after the last bookable day. */
export function horizonEnd(pool: PoolOut, now: Date): Date {
  const today = dayStart(now);
  return new Date(today.getFullYear(), today.getMonth(), today.getDate() + pool.horizon_days + 1);
}

export interface StartChoice {
  start: Date;
  /** No seat left for even one hour. */
  full: boolean;
}

/** The starts on `day`: every hour from the current one (today) to 23:00. */
export function startChoices(pool: PoolOut, day: Date, now: Date): StartChoice[] {
  const first = dayStart(day);
  const out: StartChoice[] = [];
  const hourNow = new Date(now.getFullYear(), now.getMonth(), now.getDate(), now.getHours()).getTime();
  for (let h = 0; h < 24; h += 1) {
    const start = new Date(first.getFullYear(), first.getMonth(), first.getDate(), h);
    if (start.getTime() < hourNow || start.getTime() >= horizonEnd(pool, now).getTime()) continue;
    out.push({ start, full: !slotFits(pool, start, 1, now) });
  }
  return out;
}

/** How long a booking from `start` can be: 1 h up to max_hours, stopping at the first full hour and the horizon. */
export function durationChoices(pool: PoolOut, start: Date, now: Date): number[] {
  const out: number[] = [];
  const limit = horizonEnd(pool, now).getTime();
  for (let hours = 1; hours <= pool.max_hours; hours += 1) {
    if (start.getTime() + hours * HOUR_MS > limit || !slotFits(pool, start, hours, now)) break;
    out.push(hours);
  }
  return out;
}

export interface DurationDefault {
  /** The longest that fits (0 when not even an hour does). */
  hours: number;
  /** Why it is shorter than the pool's max_hours: the slot is full from `at`, or the booking horizon ends there. */
  limit: "max" | "full" | "horizon";
  at: Date | null;
}

/** The dialog's default length: the pool's max_hours, or the longest that fits from `start` (and why it stops). */
export function durationDefault(pool: PoolOut, start: Date, now: Date): DurationDefault {
  const hours = durationChoices(pool, start, now).length;
  if (hours >= pool.max_hours) return { hours, limit: "max", at: null };
  const at = new Date(start.getTime() + hours * HOUR_MS);
  return { hours, limit: at.getTime() + HOUR_MS > horizonEnd(pool, now).getTime() ? "horizon" : "full", at };
}

export interface TimelineBar {
  id: string;
  userId: string;
  kind: "walkin" | "booking";
  status: ReservationOut["status"];
  /** Fractions of the day (0 = midnight, 1 = the next midnight). */
  from: number;
  to: number;
  lane: number;
  start: string;
  end: string;
}

/**
 * The day's bars: bookings (booked, on a seat, used today) and walk-ins on a seat (from their assignment to the end of
 * the guarantee, or now if later), each in the first lane free at its start. More bars than seats at once (a pool
 * whose capacity was lowered) get lanes past the capacity.
 */
export function timelineBars(pool: PoolOut, day: Date, now: Date): TimelineBar[] {
  const from = dayStart(day).getTime();
  const to = from + 24 * HOUR_MS;
  const rows: Array<{ row: ReservationOut; start: number; end: number }> = [];
  for (const b of pool.bookings) {
    if (b.start_at && b.end_at) rows.push({ row: b, start: ms(b.start_at), end: ms(b.end_at) });
  }
  for (const h of pool.holders) {
    if (h.kind !== "walkin" || !h.assigned_at) continue;
    rows.push({ row: h, start: ms(h.assigned_at), end: Math.max(ms(h.guarantee_until) || 0, now.getTime()) });
  }
  const visible = rows.filter((r) => r.start < to && r.end > from).sort((a, b) => a.start - b.start || a.row.id.localeCompare(b.row.id));
  const laneEnds: number[] = [];
  return visible.map(({ row, start, end }) => {
    let lane = laneEnds.findIndex((until) => until <= start);
    if (lane === -1) {
      lane = laneEnds.length;
      laneEnds.push(end);
    } else laneEnds[lane] = end;
    return {
      id: row.id,
      userId: row.user_id,
      kind: row.kind,
      status: row.status,
      from: (Math.max(start, from) - from) / (to - from),
      to: (Math.min(end, to) - from) / (to - from),
      lane,
      start: new Date(start).toISOString(),
      end: new Date(end).toISOString(),
    };
  });
}

/** Seats in use (or promised) per hour of the day, for the phones' hour list and the grid's header. */
export function hourCounts(pool: PoolOut, day: Date, now: Date): number[] {
  const bars = timelineBars(pool, day, now);
  return Array.from({ length: 24 }, (_, h) => {
    const a = h / 24;
    const b = (h + 1) / 24;
    return bars.filter((bar) => bar.from < b && bar.to > a).length;
  });
}

export interface Mine {
  walkin: ReservationOut | null;
  bookings: ReservationOut[];
}

/** My walk-in request and my bookings that still count. */
export function myReservations(pool: PoolOut, meId: string | undefined): Mine {
  const walkin = [...pool.holders, ...pool.waiting].find((r) => r.id === pool.my_reservation_id) ?? null;
  const bookings = liveBookings(pool).filter((b) => b.user_id === meId);
  return { walkin, bookings };
}

/**
 * My one active reservation in the pool (one per person and pool, docs/RESERVATIONS.md §1): waiting, booked, on a seat
 * or returned but not yet removed. While there is one, 「予約する」 and 「今すぐ」 are off (the server answers 409
 * reservation_already_active). A server without `my_active_id` is read from the lists.
 */
export function myActive(pool: PoolOut, meId: string | undefined): ReservationOut | null {
  const rows = [...pool.holders, ...pool.waiting, ...liveBookings(pool)];
  if (pool.my_active_id !== undefined) return rows.find((r) => r.id === pool.my_active_id) ?? null;
  return rows.find((r) => r.user_id === meId) ?? null;
}

/** 「予約 10/7 (水) 13:00〜16:00」, 「今すぐ · 順番待ち」, 「今すぐ · 利用中」 (the 「すでに予約があります」 line). */
export function activeText(row: ReservationOut, now: Date): string {
  const state = row.status === "waiting" ? t("reservations.waitingState") : row.status === "holding" ? t("reservations.holding") : row.status === "returning" ? t("reservations.returned") : "";
  const head = row.kind === "booking" && row.start_at && row.end_at ? `${t("reservations.booking")} ${spanLabel(row.start_at, row.end_at, now)}` : t("reservations.walkin");
  return state ? `${head} · ${state}` : head;
}

/** My bookings across the pools still counting (the page's 「自分の予約」). */
export function myBookingCount(pools: readonly PoolOut[], meId: string | undefined): number {
  return pools.reduce((sum, pool) => sum + myReservations(pool, meId).bookings.length, 0);
}

/** What a walk-in request of mine says (empty when there is none). */
export function walkinText(row: ReservationOut, pool: PoolOut, now: Date): string {
  if (row.status === "waiting") {
    if (row.step === "assign") return row.until ? t("reservations.walkin.freeUntil", { until: whenLabel(row.until, now) }) : t("reservations.walkin.free");
    if (row.step === "swap") return row.ready ? t("reservations.walkin.soon") : t("reservations.walkin.afterGuarantee");
    return t("reservations.walkin.position", { position: row.position ?? "?" });
  }
  if (row.status === "returning") return t("reservations.walkin.returning");
  if (row.evict_at) return t("reservations.walkin.evictAt", { at: whenLabel(row.evict_at, now) });
  if (pool.next_evict_id === row.id) return row.guarantee_until ? t("reservations.walkin.holdingNext", { until: whenLabel(row.guarantee_until, now) }) : t("reservations.holding");
  return row.guarantee_until ? t("reservations.walkin.holdingUntil", { until: whenLabel(row.guarantee_until, now) }) : t("reservations.holding");
}

/** What a booking of mine says. */
export function bookingText(row: ReservationOut, now: Date): string {
  const span = row.start_at && row.end_at ? spanLabel(row.start_at, row.end_at, now) : "";
  if (row.status === "holding") return `${span} · ${t("reservations.holding")}`;
  if (row.status === "returning") return `${span} · ${t("reservations.returned")}`;
  if (row.start_at && ms(row.start_at) <= now.getTime()) return `${span} · ${t("reservations.startedWaiting")}`;
  return span;
}

/** The operators' to-dos that are due now (the badge counts them). */
export function dueTodos(pool: PoolOut): TodoOut[] {
  return pool.todos.filter((t) => !t.upcoming);
}

/**
 * The home tile's and the sidebar row's number: to-dos due in the pools I operate that someone is waiting on (assign,
 * swap, a booking that started). `remove:<id>` (returned, or its time over, with nobody waiting: RESERVATIONS.md §4)
 * stays listed on the page but is not counted (2026-10-06).
 */
export function reservationTodoCount(pools: readonly PoolOut[] | null): number {
  return (pools ?? []).reduce((sum, pool) => sum + dueTodos(pool).filter((todo) => todo.action !== "remove").length, 0);
}

const REASONS: Record<TodoOut["reason"], string> = {
  get free() { return t("reservations.reason.free"); },
  get returned() { return t("reservations.returned"); },
  get booking_ended() { return t("reservations.reason.bookingEnded"); },
  get guarantee_over() { return t("reservations.reason.guaranteeOver"); },
};

/** Finds a reservation of the pool by id (a to-do's sides). */
export function rowOf(pool: PoolOut, id: string | null | undefined): ReservationOut | undefined {
  if (!id) return undefined;
  return pool.holders.find((r) => r.id === id) ?? pool.waiting.find((r) => r.id === id) ?? pool.bookings.find((r) => r.id === id);
}

/** One to-do as a line: 「Alice さん (alice@…) に割り当てる」, 「Bob さんを外して Alice さんに割り当てる (返却済み)」. */
export function todoLine(todo: TodoOut, pool: PoolOut, name: (userId: string) => string, now: Date): string {
  const who = (id: string | null | undefined) => {
    const row = rowOf(pool, id);
    if (!row) return t("reservations.unknown");
    return row.email ? t("reservations.whoEmail", { name: name(row.user_id), email: row.email }) : t("reservations.who", { name: name(row.user_id) });
  };
  const target = rowOf(pool, todo.assign_id);
  const booked = target?.kind === "booking" && target.start_at && target.end_at ? t("reservations.todo.booked", { span: spanLabel(target.start_at, target.end_at, now) }) : "";
  const head = todo.upcoming ? t("reservations.todo.from", { at: whenLabel(todo.due_at, now) }) : "";
  if (todo.action === "assign") return head + t("reservations.todo.assign", { who: who(todo.assign_id) }) + booked;
  if (todo.action === "swap") return head + t("reservations.todo.swap", { out: who(todo.remove_id), who: who(todo.assign_id), reason: REASONS[todo.reason] }) + booked;
  return head + t("reservations.todo.remove", { who: who(todo.remove_id), reason: REASONS[todo.reason] });
}

/** The settings form's numbers, checked as the server does (null = fine). */
export function poolFormProblem(form: { name: string; capacity: string; maxHours: string; minHours: string; graceMinutes: string }): string | null {
  if (!form.name.trim()) return t("reservations.check.name");
  if (form.name.trim().length > 80) return t("reservations.check.nameTooLong");
  const whole = (value: string, low: number, high: number) => /^\d+$/.test(value.trim()) && Number(value) >= low && Number(value) <= high;
  if (!whole(form.capacity, 1, 100)) return t("reservations.check.capacity");
  if (!whole(form.maxHours, 1, 24)) return t("reservations.check.maxHours");
  if (!whole(form.minHours, 0, 720)) return t("reservations.check.minHours");
  if (!whole(form.graceMinutes, 0, 1440)) return t("reservations.check.grace");
  return null;
}

/** The device's zone for a new pool (the booking grid and the notices' times). */
export function deviceZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "Asia/Tokyo";
  } catch {
    return "Asia/Tokyo";
  }
}
