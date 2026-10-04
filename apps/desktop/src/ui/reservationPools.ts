/** M99 (docs/RESERVATIONS.md §6): the pure parts of a channel's reservation pools (the card and its words). */
import type { PoolOut, ReservationOut } from "../api/types";
import { shortDateTime } from "./recurring";

export type MyReservation =
  | { kind: "none" }
  | { kind: "waiting"; row: ReservationOut }
  | { kind: "holding"; row: ReservationOut }
  | { kind: "returning"; row: ReservationOut };

/** My request in the pool, if any. */
export function myReservation(pool: PoolOut): MyReservation {
  const id = pool.my_reservation_id;
  if (!id) return { kind: "none" };
  const held = pool.holders.find((r) => r.id === id);
  if (held) return held.status === "returning" ? { kind: "returning", row: held } : { kind: "holding", row: held };
  const waiting = pool.waiting.find((r) => r.id === id);
  return waiting ? { kind: "waiting", row: waiting } : { kind: "none" };
}

/** 「2/3 · 待ち 1」: seats in use of the capacity, and the queue. */
export function poolSummary(pool: PoolOut): string {
  const base = `${pool.holders.length}/${pool.capacity}`;
  return pool.waiting.length > 0 ? `${base} · 待ち ${pool.waiting.length}` : base;
}

/** What my chip says about me (empty when I am not in the pool). */
export function myStatusText(pool: PoolOut, when: (iso: string) => string = shortDateTime): string {
  const mine = myReservation(pool);
  switch (mine.kind) {
    case "none":
      return "";
    case "waiting":
      return `待ち ${mine.row.position ?? "?"} 番目`;
    case "returning":
      return "返却中";
    case "holding":
      if (mine.row.evict_at) return `${when(mine.row.evict_at)} 以降に外されます`;
      return mine.row.guarantee_until ? `利用中 (保証 ${when(mine.row.guarantee_until)} まで)` : "利用中";
  }
}

/** Whether my chip should stand out: I am about to lose the seat, or a seat is ready for me. */
export function myStatusUrgent(pool: PoolOut): boolean {
  const mine = myReservation(pool);
  return (mine.kind === "holding" && !!mine.row.evict_at) || (mine.kind === "waiting" && mine.row.ready);
}

/** The line under a waiting member: where they stand. */
export function waiterLine(row: ReservationOut, pool: PoolOut, name: (userId: string) => string, when: (iso: string) => string = shortDateTime): string {
  const since = `${when(row.requested_at)} に予約`;
  if (row.step === "assign") return `${since} · 空きあり (担当者の割り当て待ち)`;
  if (row.step === "swap") {
    const holder = pool.holders.find((h) => h.id === row.pair_id);
    const who = holder ? `${name(holder.user_id)} さん` : "前の人";
    if (holder?.status === "returning") return `${since} · ${who}の返却分 (担当者が外し次第)`;
    if (row.ready) return `${since} · ${who}と入れ替えできます`;
    return holder?.evict_at ? `${since} · ${who}の後 (${when(holder.evict_at)} 以降)` : `${since} · ${who}の後`;
  }
  return `${since} · 保証時間が過ぎる人を待っています`;
}

/** The line under a holder: since when, and until when the seat is guaranteed. */
export function holderLine(row: ReservationOut, when: (iso: string) => string = shortDateTime): string {
  const parts: string[] = [];
  if (row.assigned_at) parts.push(`${when(row.assigned_at)} から`);
  if (row.guarantee_until) parts.push(`保証 ${when(row.guarantee_until)} まで`);
  return parts.join(" · ");
}

export type HolderBadge = { text: string; tone: "neutral" | "accent" | "danger" } | null;

/** A holder's state at a glance (returning, to be removed, past the guarantee). */
export function holderBadge(row: ReservationOut, pool: PoolOut, now: Date, when: (iso: string) => string = shortDateTime): HolderBadge {
  if (row.status === "returning") return { text: "返却済み · 外し待ち", tone: "accent" };
  if (row.evict_at) return row.ready ? { text: "入れ替えできます", tone: "danger" } : { text: `${when(row.evict_at)} 以降に外す`, tone: "danger" };
  if (pool.next_evict_id === row.id) return { text: "次に外す", tone: "accent" };
  if (row.guarantee_until && new Date(row.guarantee_until).getTime() <= now.getTime()) return { text: "保証時間終了", tone: "neutral" };
  return null;
}

/** The settings form's numbers, checked as the server does (null = fine). */
export function poolFormProblem(form: { name: string; capacity: string; minHours: string; graceMinutes: string }): string | null {
  if (!form.name.trim()) return "名前を入力してください";
  if (form.name.trim().length > 80) return "名前は 80 文字までです";
  const whole = (value: string, low: number, high: number) => /^\d+$/.test(value.trim()) && Number(value) >= low && Number(value) <= high;
  if (!whole(form.capacity, 1, 100)) return "枠の数は 1〜100 の整数で入力してください";
  if (!whole(form.minHours, 0, 720)) return "最低保証時間は 0〜720 時間の整数で入力してください";
  if (!whole(form.graceMinutes, 0, 1440)) return "猶予は 0〜1440 分の整数で入力してください";
  return null;
}

/** The device's zone for a new pool (the bot writes its times in it). */
export function deviceZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "Asia/Tokyo";
  } catch {
    return "Asia/Tokyo";
  }
}
