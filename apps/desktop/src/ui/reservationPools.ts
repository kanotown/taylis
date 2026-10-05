/**
 * M112 (docs/RESERVATIONS.md §6): the pure parts of the 「予約」 page — the day's timeline (bars in lanes, the seats in
 * use per hour), the booking choices (start on the hour, how long), my reservations, the operators' to-do and the
 * words. Times are the device's (the page draws one local day; the pools' grid is whole hours).
 */
import type { PoolOut, ReservationOut, TodoOut } from "../api/types";

export const HOUR_MS = 3_600_000;
const WEEKDAYS = ["日", "月", "火", "水", "木", "金", "土"];

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
  if (diff === 0) return "今日";
  if (diff === 1) return "明日";
  return `${day.getMonth() + 1}/${day.getDate()} (${WEEKDAYS[day.getDay()]})`;
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
  return `${day}${hm(start)}〜${hm(endIso)}`;
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

/** My bookings across the pools still counting (the page's 「自分の予約」). */
export function myBookingCount(pools: readonly PoolOut[], meId: string | undefined): number {
  return pools.reduce((sum, pool) => sum + myReservations(pool, meId).bookings.length, 0);
}

/** What a walk-in request of mine says (empty when there is none). */
export function walkinText(row: ReservationOut, pool: PoolOut, now: Date): string {
  if (row.status === "waiting") {
    if (row.step === "assign") return row.until ? `空きあり (〜${whenLabel(row.until, now)} まで) · 担当者の割り当て待ち` : "空きあり · 担当者の割り当て待ち";
    if (row.step === "swap") return row.ready ? "まもなく担当者が割り当てます" : "前の人の保証時間の後に割り当てられます";
    return `順番待ち ${row.position ?? "?"} 番目`;
  }
  if (row.status === "returning") return "返却済み · 担当者が外すのを待っています";
  if (row.evict_at) return `${whenLabel(row.evict_at, now)} 以降に外されます`;
  if (pool.next_evict_id === row.id) return row.guarantee_until ? `利用中 (〜${whenLabel(row.guarantee_until, now)} まで保証、次に外す人)` : "利用中";
  return row.guarantee_until ? `利用中 (〜${whenLabel(row.guarantee_until, now)} まで保証)` : "利用中";
}

/** What a booking of mine says. */
export function bookingText(row: ReservationOut, now: Date): string {
  const span = row.start_at && row.end_at ? spanLabel(row.start_at, row.end_at, now) : "";
  if (row.status === "holding") return `${span} · 利用中`;
  if (row.status === "returning") return `${span} · 返却済み`;
  if (row.start_at && ms(row.start_at) <= now.getTime()) return `${span} · 開始 (担当者の割り当て待ち)`;
  return span;
}

/** The operators' to-dos that are due now (the badge counts them). */
export function dueTodos(pool: PoolOut): TodoOut[] {
  return pool.todos.filter((t) => !t.upcoming);
}

/** The home tile's and the sidebar row's number: to-dos due in the pools I operate. */
export function reservationTodoCount(pools: readonly PoolOut[] | null): number {
  return (pools ?? []).reduce((sum, pool) => sum + dueTodos(pool).length, 0);
}

const REASONS: Record<TodoOut["reason"], string> = {
  free: "空きあり",
  returned: "返却済み",
  booking_ended: "予約時間が終了",
  guarantee_over: "保証時間が終了",
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
    if (!row) return "(不明)";
    return row.email ? `${name(row.user_id)} さん (${row.email})` : `${name(row.user_id)} さん`;
  };
  const target = rowOf(pool, todo.assign_id);
  const booked = target?.kind === "booking" && target.start_at && target.end_at ? ` · 予約 ${spanLabel(target.start_at, target.end_at, now)}` : "";
  const head = todo.upcoming ? `${whenLabel(todo.due_at, now)} から: ` : "";
  if (todo.action === "assign") return `${head}${who(todo.assign_id)} に割り当てる${booked}`;
  if (todo.action === "swap") return `${head}${who(todo.remove_id)} を外して ${who(todo.assign_id)} に割り当てる (${REASONS[todo.reason]})${booked}`;
  return `${head}${who(todo.remove_id)} を外す (${REASONS[todo.reason]})`;
}

/** The settings form's numbers, checked as the server does (null = fine). */
export function poolFormProblem(form: { name: string; capacity: string; maxHours: string; minHours: string; graceMinutes: string }): string | null {
  if (!form.name.trim()) return "名前を入力してください";
  if (form.name.trim().length > 80) return "名前は 80 文字までです";
  const whole = (value: string, low: number, high: number) => /^\d+$/.test(value.trim()) && Number(value) >= low && Number(value) <= high;
  if (!whole(form.capacity, 1, 100)) return "枠の数は 1〜100 の整数で入力してください";
  if (!whole(form.maxHours, 1, 24)) return "予約の最長は 1〜24 時間の整数で入力してください";
  if (!whole(form.minHours, 0, 720)) return "今すぐの保証時間は 0〜720 時間の整数で入力してください";
  if (!whole(form.graceMinutes, 0, 1440)) return "猶予は 0〜1440 分の整数で入力してください";
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
