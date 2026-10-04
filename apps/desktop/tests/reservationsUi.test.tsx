// @vitest-environment jsdom
// M99 (docs/RESERVATIONS.md §6): a channel's reservation pools — the bar's chips, the card for members and operators,
// and the pure helpers.
process.env.TZ = "Asia/Tokyo";

import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ChannelOut, PoolOut, ReservationOut, UserMe, UserPublic } from "../src/api/types";
import type { AppController } from "../src/state/app";
import { Store } from "../src/sync/store";
import type { ChannelState } from "../src/sync/types";
import { ReservationBar, ReservationCard } from "../src/ui/Reservations";
import { holderBadge, myReservation, myStatusText, poolFormProblem, poolSummary, waiterLine } from "../src/ui/reservationPools";

afterEach(() => {
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
    status: "waiting",
    requested_at: "2026-10-04T00:00:00Z",
    assigned_at: null,
    guarantee_until: null,
    returned_at: null,
    evict_at: null,
    email: null,
    position: null,
    step: null,
    pair_id: null,
    ready: false,
    ...over,
  };
}

const HOLDER = row({ id: "h1", user_id: ALICE, status: "holding", assigned_at: "2026-10-04T00:00:00Z", guarantee_until: "2026-10-04T06:00:00Z", pair_id: "w1" });
const WAITER = row({ id: "w1", user_id: BOB, position: 1, step: "swap", pair_id: "h1" });

function pool(over: Partial<PoolOut> = {}): PoolOut {
  return {
    id: "p1",
    channel_id: "c-lab",
    name: "Claude Premium シート",
    capacity: 1,
    min_hours: 6,
    grace_minutes: 15,
    tz: "Asia/Tokyo",
    enabled: true,
    operator_ids: [],
    bot_user_id: null,
    holders: [HOLDER],
    waiting: [WAITER],
    next_evict_id: "h1",
    my_reservation_id: null,
    can_manage: false,
    can_operate: false,
    created_at: "2026-10-01T00:00:00Z",
    updated_at: "2026-10-01T00:00:00Z",
    ...over,
  };
}

function setup(p: PoolOut, { inBar = false } = {}) {
  const store = new Store();
  store.setMe({ ...people[0]! } as unknown as UserMe);
  for (const user of people) store.upsertUser(user);
  const channel = store.upsertChannel(
    { id: "c-lab", type: "public", name: "claude", topic: null, purpose: null, archived: false, created_at: "2026-01-01T00:00:00Z", last_seq: 0, posting_policy: "everyone" } as unknown as ChannelOut,
    { isMember: true, membership: { role: "member" } as never },
  );
  store.setReservationPools("c-lab", [p]);
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
  } as unknown as AppController & Record<string, ReturnType<typeof vi.fn>>;
  if (inBar) render(<ReservationBar controller={controller} channel={channel as ChannelState} />);
  else render(<ReservationCard controller={controller} channel={channel as ChannelState} pool={p} />);
  return { controller };
}

const flush = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });

describe("helpers", () => {
  it("summarises the pool and my place", () => {
    expect(poolSummary(pool())).toBe("1/1 · 待ち 1");
    expect(poolSummary(pool({ waiting: [] }))).toBe("1/1");
    expect(myReservation(pool()).kind).toBe("none");
    expect(myStatusText(pool({ my_reservation_id: "w1" }))).toBe("待ち 1 番目");
    expect(myStatusText(pool({ my_reservation_id: "h1" }))).toBe("利用中 (保証 10/4 (日) 15:00 まで)");
    const told = pool({ my_reservation_id: "h1", holders: [{ ...HOLDER, evict_at: "2026-10-04T07:15:00Z" }] });
    expect(myStatusText(told)).toBe("10/4 (日) 16:15 以降に外されます");
  });

  it("says where a waiting member stands and what a holder is", () => {
    const name = (id: string) => (id === ALICE ? "アリス" : "ボブ");
    expect(waiterLine(WAITER, pool(), name)).toBe("10/4 (日) 9:00 に予約 · アリス さんの後");
    expect(waiterLine({ ...WAITER, step: "assign" }, pool(), name)).toContain("空きあり");
    expect(waiterLine({ ...WAITER, step: "wait" }, pool(), name)).toContain("保証時間が過ぎる人を待っています");
    const now = new Date("2026-10-04T08:00:00Z");
    expect(holderBadge(HOLDER, pool(), now)?.text).toBe("次に外す");
    expect(holderBadge({ ...HOLDER, evict_at: "2026-10-04T08:15:00Z" }, pool(), now)?.text).toBe("10/4 (日) 17:15 以降に外す");
    expect(holderBadge({ ...HOLDER, evict_at: "2026-10-04T07:15:00Z", ready: true }, pool(), now)?.text).toBe("入れ替えできます");
    expect(holderBadge({ ...HOLDER, status: "returning" }, pool(), now)?.text).toBe("返却済み · 外し待ち");
    expect(holderBadge(HOLDER, pool({ next_evict_id: null }), now)?.text).toBe("保証時間終了");
  });

  it("checks the settings form", () => {
    const ok = { name: "シート", capacity: "3", minHours: "6", graceMinutes: "15" };
    expect(poolFormProblem(ok)).toBeNull();
    expect(poolFormProblem({ ...ok, name: " " })).toBe("名前を入力してください");
    expect(poolFormProblem({ ...ok, capacity: "0" })).toContain("枠の数");
    expect(poolFormProblem({ ...ok, minHours: "1.5" })).toContain("最低保証");
    expect(poolFormProblem({ ...ok, graceMinutes: "2000" })).toContain("猶予");
  });
});

describe("the card", () => {
  it("lets a member reserve and shows no operator buttons or addresses", async () => {
    const { controller } = setup(pool({ holders: [{ ...HOLDER, email: null }] }));
    expect(screen.getByText("予約していません")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "割り当てた" })).toBeNull();
    expect(screen.queryByRole("button", { name: "外した" })).toBeNull();
    expect(document.querySelector("[data-email]")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "予約する" }));
    await flush();
    expect(controller.reservePool).toHaveBeenCalledWith("p1");
  });

  it("lets the holder return the seat after a confirmation", async () => {
    const { controller } = setup(pool({ my_reservation_id: "h1", holders: [{ ...HOLDER, user_id: ME }] }));
    expect(screen.getAllByText(/利用中/).length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole("button", { name: "返却する" }));
    const dialog = screen.getByRole("alertdialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "返却する" }));
    await flush();
    expect(controller.reservationAction).toHaveBeenCalledWith("h1", "return");
  });

  it("gives operators the addresses, 外した and 入れ替えた when the swap is ready", async () => {
    const ready = pool({
      can_operate: true,
      holders: [{ ...HOLDER, email: "alice@example.jp", evict_at: "2026-10-04T06:15:00Z", ready: true }],
      waiting: [{ ...WAITER, email: "bob@example.jp", ready: true }],
    });
    const { controller } = setup(ready);
    expect(screen.getByText("alice@example.jp")).toBeTruthy();
    expect(screen.getByText("bob@example.jp")).toBeTruthy();
    expect(screen.getByText("入れ替えできます")).toBeTruthy();
    expect(screen.getByRole("button", { name: "外した" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "入れ替えた" }));
    const dialog = screen.getByRole("alertdialog");
    expect(dialog.textContent).toContain("アリス さんを外して ボブ さんを割り当てましたか");
    fireEvent.click(within(dialog).getByRole("button", { name: "入れ替えた" }));
    await flush();
    expect(controller.swapReservations).toHaveBeenCalledWith("p1", "h1", "w1");
  });

  it("offers 割り当てた for a free seat", async () => {
    const free = pool({ capacity: 2, can_operate: true, waiting: [{ ...WAITER, step: "assign", pair_id: null, ready: true }] });
    const { controller } = setup(free);
    expect(screen.queryByRole("button", { name: "入れ替えた" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "割り当てた" }));
    await flush();
    expect(controller.reservationAction).toHaveBeenCalledWith("w1", "assign");
  });
});

describe("the bar", () => {
  it("shows one chip per pool with the count and my status, and opens the card", async () => {
    setup(pool({ my_reservation_id: "w1" }), { inBar: true });
    const bar = screen.getByLabelText("共有枠の予約");
    expect(within(bar).getByText("Claude Premium シート")).toBeTruthy();
    expect(within(bar).getByText("1/1 · 待ち 1")).toBeTruthy();
    expect(within(bar).getByText("· 待ち 1 番目")).toBeTruthy();
    fireEvent.click(within(bar).getByRole("button"));
    await flush();
    expect(document.querySelector("[data-reservation-card]")).toBeTruthy();
  });
});

describe("the store", () => {
  it("replaces a pool in place and drops a deleted one", () => {
    const store = new Store();
    store.setReservationPools("c-lab", [pool(), pool({ id: "p2" })]);
    store.putReservationPool(pool({ name: "新しい名前" }));
    expect(store.poolsOf("c-lab").map((p) => p.name)).toEqual(["新しい名前", "Claude Premium シート"]);
    store.dropReservationPool("c-lab", "p1");
    expect(store.poolsOf("c-lab").map((p) => p.id)).toEqual(["p2"]);
  });
});
