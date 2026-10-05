// @vitest-environment jsdom
// M112 (docs/RESERVATIONS.md §6): the 「予約」 page — the timeline, the booking choices, my reservations, the operators'
// to-do — and its pure helpers.
process.env.TZ = "Asia/Tokyo";

import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { PoolOut, ReservationOut, TodoOut, UserMe, UserPublic } from "../src/api/types";
import type { AppController } from "../src/state/app";
import { Store } from "../src/sync/store";
import { BookingDialog, PoolSection } from "../src/ui/Reservations";
import {
  bookingDays,
  dayLabel,
  durationChoices,
  hourCounts,
  myReservations,
  poolFormProblem,
  reservationTodoCount,
  slotFits,
  startChoices,
  timelineBars,
  todoLine,
  walkinText,
} from "../src/ui/reservationPools";

// 2026-10-05 (月) 10:20 in Tokyo.
const NOW = new Date("2026-10-05T01:20:00Z");
const at = (hour: number, day = 5) => new Date(2026, 9, day, hour).toISOString();

beforeEach(() => {
  vi.useFakeTimers({ now: NOW, toFake: ["Date"] });
});
afterEach(() => {
  vi.useRealTimers();
  cleanup();
});

const ME = "11111111-1111-4111-8111-111111111111";
const ALICE = "22222222-2222-4222-8222-222222222222";
const BOB = "33333333-3333-4333-8333-333333333333";
const people: UserPublic[] = [
  { id: ME, username: "me", display_name: "わたし", role: "member" } as UserPublic,
  { id: ALICE, username: "alice", display_name: "アリス", role: "member" } as UserPublic,
  { id: BOB, username: "bob", display_name: "ボブ", role: "member" } as UserPublic,
];

function row(over: Partial<ReservationOut>): ReservationOut {
  return {
    id: "r",
    user_id: ALICE,
    kind: "booking",
    status: "booked",
    requested_at: "2026-10-04T00:00:00Z",
    start_at: null,
    end_at: null,
    assigned_at: null,
    guarantee_until: null,
    returned_at: null,
    evict_at: null,
    email: null,
    position: null,
    step: null,
    pair_id: null,
    ready: false,
    until: null,
    can_extend: false,
    ...over,
  };
}

function pool(over: Partial<PoolOut> = {}): PoolOut {
  return {
    id: "p1",
    name: "Claude Premium シート",
    capacity: 2,
    min_hours: 6,
    max_hours: 6,
    grace_minutes: 15,
    tz: "Asia/Tokyo",
    enabled: true,
    operator_ids: [],
    log_channel_id: null,
    visibility: "all",
    visibility_channel_id: null,
    visibility_group_id: null,
    holders: [],
    waiting: [],
    bookings: [],
    todos: [],
    next_evict_id: null,
    my_reservation_id: null,
    can_manage: false,
    can_operate: false,
    horizon_days: 14,
    created_at: "2026-10-01T00:00:00Z",
    updated_at: "2026-10-01T00:00:00Z",
    ...over,
  };
}

const B1 = row({ id: "b1", user_id: ALICE, start_at: at(12), end_at: at(15) });
const B2 = row({ id: "b2", user_id: BOB, start_at: at(13), end_at: at(14) });
const WALK = row({ id: "w1", user_id: BOB, kind: "walkin", status: "holding", assigned_at: at(9), guarantee_until: at(11) });

describe("the helpers", () => {
  it("puts bars in lanes and counts the seats per hour", () => {
    const p = pool({ bookings: [B1, B2], holders: [WALK] });
    const bars = timelineBars(p, new Date(2026, 9, 5), NOW);
    expect(bars.map((b) => [b.id, b.lane])).toEqual([["w1", 0], ["b1", 0], ["b2", 1]]);
    expect(bars[1]!.from).toBeCloseTo(12 / 24);
    const counts = hourCounts(p, new Date(2026, 9, 5), NOW);
    expect(counts.slice(9, 16)).toEqual([1, 1, 0, 1, 2, 1, 0]);
    // another day shows nothing of today
    expect(timelineBars(p, new Date(2026, 9, 6), NOW)).toEqual([]);
  });

  it("offers the starts from the current hour, greys full ones and stops durations at the first full hour", () => {
    const p = pool({ bookings: [B1, B2] });
    const starts = startChoices(p, new Date(2026, 9, 5), NOW);
    expect(starts[0]!.start.getHours()).toBe(10); // 10:20 → the current hour
    expect(starts.find((s) => s.start.getHours() === 13)?.full).toBe(true);
    expect(starts.find((s) => s.start.getHours() === 12)?.full).toBe(false);
    expect(durationChoices(p, new Date(2026, 9, 5, 10), NOW)).toEqual([1, 2, 3]); // 13:00 is full
    expect(durationChoices(p, new Date(2026, 9, 5, 14), NOW)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(slotFits(p, new Date(2026, 9, 5, 13), 1, NOW)).toBe(false);
    // a walk-in's guarantee holds its hours too
    const walk = pool({ capacity: 1, holders: [WALK] });
    expect(slotFits(walk, new Date(2026, 9, 5, 10), 1, NOW)).toBe(false);
    expect(slotFits(walk, new Date(2026, 9, 5, 11), 1, NOW)).toBe(true);
    // two weeks: the last day, nothing past it
    const days = bookingDays(NOW, 14);
    expect(days).toHaveLength(15);
    expect(dayLabel(days[0]!, NOW)).toBe("今日");
    expect(dayLabel(days[1]!, NOW)).toBe("明日");
    expect(dayLabel(days[2]!, NOW)).toBe("10/7 (水)");
    expect(durationChoices(p, new Date(2026, 9, 19, 22), NOW)).toEqual([1, 2]);
  });

  it("words my walk-in, the to-dos and the badge", () => {
    const waiting = row({ id: "q1", user_id: ME, kind: "walkin", status: "waiting", step: "assign", until: at(13), position: 1 });
    const p = pool({ waiting: [waiting], my_reservation_id: "q1", bookings: [B1] });
    expect(myReservations(p, ME).walkin?.id).toBe("q1");
    expect(walkinText(waiting, p, NOW)).toBe("空きあり (〜13:00 まで) · 担当者の割り当て待ち");
    expect(walkinText({ ...waiting, step: "wait", position: 2, until: null }, p, NOW)).toBe("順番待ち 2 番目");
    const todos: TodoOut[] = [
      { key: "assign:q1", action: "assign", reason: "free", assign_id: "q1", remove_id: null, due_at: NOW.toISOString(), upcoming: false },
      { key: "booking:b1", action: "swap", reason: "guarantee_over", assign_id: "b1", remove_id: "w1", due_at: at(12), upcoming: true },
    ];
    const withTodos = pool({ waiting: [{ ...waiting, email: "me@example.jp" }], holders: [WALK], bookings: [B1], todos });
    const name = (id: string) => people.find((u) => u.id === id)!.display_name;
    expect(todoLine(todos[0]!, withTodos, name, NOW)).toBe("わたし さん (me@example.jp) に割り当てる");
    expect(todoLine(todos[1]!, withTodos, name, NOW)).toBe("12:00 から: ボブ さん を外して アリス さん に割り当てる (保証時間が終了) · 予約 12:00〜15:00");
    expect(reservationTodoCount([withTodos])).toBe(1);
    expect(reservationTodoCount(null)).toBe(0);
    expect(poolFormProblem({ name: "x", capacity: "3", maxHours: "25", minHours: "6", graceMinutes: "15" })).toMatch("予約の最長");
    expect(poolFormProblem({ name: "x", capacity: "3", maxHours: "6", minHours: "6", graceMinutes: "15" })).toBeNull();
  });
});

function setup(p: PoolOut) {
  const store = new Store();
  store.setMe({ ...people[0]! } as unknown as UserMe);
  for (const user of people) store.upsertUser(user);
  store.setReservationPools([p]);
  const controller = {
    store,
    isAdmin: false,
    isGuest: false,
    error: null,
    version: 0,
    subscribe: () => () => {},
    reservePool: vi.fn(async () => p),
    reservationAction: vi.fn(async () => p),
    swapReservations: vi.fn(async () => p),
    bookReservation: vi.fn(async () => p),
    extendReservation: vi.fn(async () => p),
  } as unknown as AppController & Record<string, ReturnType<typeof vi.fn>>;
  return { controller };
}

const settle = () => act(async () => { await Promise.resolve(); });

describe("the page", () => {
  it("lists my bookings with extend / cancel and the walk-in button", async () => {
    const mine = row({ id: "m1", user_id: ME, start_at: at(16), end_at: at(18), can_extend: true });
    const { controller } = setup(pool({ bookings: [B1, mine] }));
    render(<PoolSection controller={controller} pool={controller.store.reservationPools![0]!} onEdit={() => {}} />);
    const box = screen.getByLabelText("自分の予約");
    expect(within(box).getByText("16:00〜18:00")).toBeTruthy();
    fireEvent.click(within(box).getByRole("button", { name: "1 時間延長" }));
    expect(controller.extendReservation).toHaveBeenCalledWith("m1");
    await settle();
    fireEvent.click(within(box).getByRole("button", { name: "取り消す" }));
    fireEvent.click(within(box).getAllByRole("button", { name: "取り消す" }).at(-1)!);
    expect(controller.reservationAction).toHaveBeenCalledWith("m1", "cancel");
    await settle();
    fireEvent.click(screen.getByRole("button", { name: "今すぐ (順番待ち)" }));
    expect(controller.reservePool).toHaveBeenCalledWith("p1");
    // the timeline draws both bookings (mine stands out)
    expect(document.querySelector('[data-bar="m1"]')).toBeTruthy();
    expect(document.querySelector('[data-bar="b1"]')?.getAttribute("title")).toBe("アリス · 予約 12:00〜15:00");
  });

  it("gives operators the to-do buttons", async () => {
    const waiting = row({ id: "q1", user_id: ALICE, kind: "walkin", status: "waiting", step: "assign", email: "alice@example.jp" });
    const back = row({ id: "h1", user_id: BOB, kind: "walkin", status: "returning", assigned_at: at(8), guarantee_until: at(14) });
    const todos: TodoOut[] = [
      { key: "assign:q1", action: "assign", reason: "free", assign_id: "q1", remove_id: null, due_at: NOW.toISOString(), upcoming: false },
      { key: "remove:h1", action: "remove", reason: "returned", assign_id: null, remove_id: "h1", due_at: NOW.toISOString(), upcoming: false },
    ];
    const { controller } = setup(pool({ waiting: [waiting], holders: [back], todos, can_operate: true }));
    render(<PoolSection controller={controller} pool={controller.store.reservationPools![0]!} onEdit={() => {}} />);
    const list = screen.getByLabelText("担当者の作業");
    expect(within(list).getByText("アリス さん (alice@example.jp) に割り当てる")).toBeTruthy();
    fireEvent.click(within(list).getByRole("button", { name: "割り当てた" }));
    expect(controller.reservationAction).toHaveBeenCalledWith("q1", "assign");
    await settle();
    fireEvent.click(within(list).getByRole("button", { name: "外した" }));
    expect(controller.reservationAction).toHaveBeenCalledWith("h1", "remove");
  });

  it("books the chosen start and length", async () => {
    const p = pool({ bookings: [B1, B2] });
    const { controller } = setup(p);
    const onClose = vi.fn();
    render(<BookingDialog controller={controller} pool={p} initialDay={new Date(2026, 9, 5)} onClose={onClose} />);
    const start = screen.getByLabelText("開始") as HTMLSelectElement;
    expect([...start.options].find((o) => o.text.startsWith("13:00"))?.disabled).toBe(true);
    fireEvent.change(start, { target: { value: String(new Date(2026, 9, 5, 14).getTime()) } });
    fireEvent.change(screen.getByLabelText("時間"), { target: { value: "3" } });
    fireEvent.click(screen.getByRole("button", { name: "予約する" }));
    await vi.waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(controller.bookReservation).toHaveBeenCalledWith("p1", new Date(2026, 9, 5, 14).toISOString(), 3);
  });
});
