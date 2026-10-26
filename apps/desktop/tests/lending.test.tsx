// @vitest-environment jsdom
// M170 (docs/LENDING.md §12.2, §14): 「備品」 on Desktop / Web — the borrow dialog (the longest date, nothing without the
// permission tick and the teacher, one request id for retries, 「先に借りました」 after a 409), the list's filters, what
// each role is offered, the numbers worked out after lending.updated, and the activity rows' rules.
process.env.TZ = "Asia/Tokyo";

import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ApiError, describeError, NetworkError } from "../src/api/errors";
import type { ActivityItem, LendingCategoryOut, LendingItemDetailOut, LendingItemOut, LendingLoanOut, LendingSettingsOut, UserMe, UserPublic } from "../src/api/types";
import type { AppController } from "../src/state/app";
import { lendingSummaryOf, SyncEngine } from "../src/sync/engine";
import { Store } from "../src/sync/store";
import { activityHeadline, activityKey, isDoneActivity, isShownActivity } from "../src/ui/activity";
import { BorrowDialog, ExtendDialog, LendingView } from "../src/ui/Lending";
import {
  addDays,
  approverChoices,
  borrowProblem,
  daysBetween,
  eventText,
  extendProblem,
  extendRange,
  filterItems,
  lendingBadgeCount,
  shortDate,
  sortItems,
  todayIn,
  unavailableText,
} from "../src/ui/lendingRules";
import { desktopNavKeys, sidebarNavKeys } from "../src/ui/navItems";
import { FakeServer } from "./fakeServer";

// 2026-10-26 (月) 10:00 in Tokyo.
const NOW = new Date("2026-10-26T01:00:00Z");

beforeEach(() => {
  vi.useFakeTimers({ now: NOW, toFake: ["Date"] });
});
afterEach(() => {
  vi.useRealTimers();
  cleanup();
});

const ME = "11111111-1111-4111-8111-111111111111";
const ALICE = "22222222-2222-4222-8222-222222222222";
const KANO = "33333333-3333-4333-8333-333333333333";
const SATO = "44444444-4444-4444-8444-444444444444";
const people: UserPublic[] = [
  { id: ME, username: "me", display_name: "わたし", role: "member", deactivated_at: null } as UserPublic,
  { id: ALICE, username: "alice", display_name: "アリス", role: "member", deactivated_at: null } as UserPublic,
  { id: KANO, username: "kano", display_name: "加納", role: "member", deactivated_at: null } as UserPublic,
  { id: SATO, username: "sato", display_name: "佐藤", role: "member", deactivated_at: null } as UserPublic,
];

const SETTINGS: LendingSettingsOut = { enabled: true, keeper_ids: [], default_max_days: 14, max_extensions: 2, keeper_overdue_days: 3, notice_minute: 540, tz: "Asia/Tokyo", is_keeper: false, updated_at: null };
const CATS: LendingCategoryOut[] = [
  { id: "c-cam", name: "カメラ", position: 0, requires_permission: true, max_days: 14, item_count: 2 },
  { id: "c-pc", name: "PC", position: 1, requires_permission: false, max_days: 30, item_count: 1 },
];

function item(over: Partial<LendingItemOut>): LendingItemOut {
  return {
    id: "i",
    name: "品",
    category_id: null,
    code: null,
    location: null,
    notes: null,
    photo: null,
    status: "available",
    status_note: null,
    requires_permission: false,
    requires_permission_source: "default",
    max_days: 14,
    max_days_source: "default",
    loan: null,
    watching: false,
    created_at: "2026-10-01T00:00:00Z",
    updated_at: "2026-10-01T00:00:00Z",
    ...over,
  };
}

function loan(over: Partial<LendingLoanOut>): LendingLoanOut {
  return {
    id: "l",
    item_id: "i",
    item_name: "品",
    item_code: null,
    borrower_id: ME,
    borrowed_at: "2026-10-20T01:00:00Z",
    due_on: "2026-10-30",
    original_due_on: "2026-10-30",
    overdue_days: 0,
    extension_count: 0,
    can_extend: true,
    latest_due_on: "2026-11-09",
    purpose: "撮影",
    permission_required: false,
    approver_id: null,
    permission_state: null,
    permission_decided_at: null,
    permission_note: null,
    returned_at: null,
    returned_by: null,
    return_condition: null,
    return_note: null,
    status: "active",
    details_hidden: false,
    ...over,
  };
}

const CAM_A = item({ id: "cam-a", name: "カメラ A", code: "CAM-01", category_id: "c-cam", requires_permission: true, requires_permission_source: "category", location: "301 棚 2" });
const CAM_B = item({ id: "cam-b", name: "カメラ B", code: "CAM-02", category_id: "c-cam", requires_permission: true, status: "on_loan", loan: { id: "lb", borrower_id: ALICE, borrowed_at: "2026-10-10T00:00:00Z", due_on: "2026-10-22", overdue_days: 4, permission_state: null, status: "active", returned_at: null, return_condition: null } });
const PC = item({ id: "pc-3", name: "ノート PC", code: "PC-03", category_id: "c-pc", max_days: 30, max_days_source: "category" });
const BOOK = item({ id: "book", name: "統計学入門", code: null, status: "in_repair", status_note: "表紙の破れ" });

function controllerWith(api: Record<string, unknown>, caps: string[] = []) {
  const store = new Store();
  store.setMe({ ...people[0]!, capabilities: caps } as unknown as UserMe);
  for (const user of people) store.upsertUser(user);
  const controller = {
    store,
    api,
    error: null,
    version: 0,
    subscribe: () => () => {},
    can: (capability: string) => caps.includes(capability),
    setError: vi.fn(),
    describe: (error: unknown) => describeError(error),
    openLendingRequest: null,
    requestOpenLending: vi.fn(),
    openDmWith: vi.fn(async () => null),
  } as unknown as AppController;
  return { controller, store };
}

const settle = async (times = 4) => {
  for (let i = 0; i < times; i++) await act(async () => { await Promise.resolve(); });
};

describe("the rules", () => {
  it("counts the workspace's dates", () => {
    expect(todayIn("Asia/Tokyo", new Date("2026-10-26T15:30:00Z"))).toBe("2026-10-27"); // past midnight in Tokyo
    expect(todayIn("UTC", new Date("2026-10-26T15:30:00Z"))).toBe("2026-10-26");
    expect(todayIn("No/Such_Zone", NOW)).toBe("2026-10-26"); // the device's zone (Tokyo here)
    expect(addDays("2026-10-26", 14)).toBe("2026-11-09");
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(daysBetween("2026-10-22", "2026-10-26")).toBe(4);
    expect(shortDate("2026-11-09", "2026-10-26")).toBe("11/9");
    expect(shortDate("2027-01-04", "2026-10-26")).toBe("2027/1/4");
  });

  it("filters by category, status and words, and sorts", () => {
    const all = [BOOK, CAM_A, CAM_B, PC];
    expect(filterItems(all, { category: "c-cam", status: "all", query: "" }).map((i) => i.id)).toEqual(["cam-a", "cam-b"]);
    expect(filterItems(all, { category: "none", status: "all", query: "" }).map((i) => i.id)).toEqual(["book"]);
    expect(filterItems(all, { category: "all", status: "available", query: "" }).map((i) => i.id)).toEqual(["cam-a", "pc-3"]);
    expect(filterItems(all, { category: "all", status: "overdue", query: "" }).map((i) => i.id)).toEqual(["cam-b"]);
    // the name, the number or the place; full-width and case folded
    expect(filterItems(all, { category: "all", status: "all", query: "ｐｃ－03" }).map((i) => i.id)).toEqual(["pc-3"]);
    expect(filterItems(all, { category: "all", status: "all", query: "301 カメラ" }).map((i) => i.id)).toEqual(["cam-a"]);
    expect(sortItems(all, "code").map((i) => i.id)).toEqual(["cam-a", "cam-b", "pc-3", "book"]);
    expect(sortItems(all, "due").map((i) => i.id)[0]).toBe("cam-b");
    expect(sortItems(all, "name").map((i) => i.id)).toEqual(["book", "cam-a", "cam-b", "pc-3"]); // the server's order kept
  });

  it("allows borrowing up to the longest date, with the permission and a candidate teacher", () => {
    const approvers = { user_ids: [KANO, SATO], suggested_ids: [SATO], self_approved: false };
    const form = { dueOn: "2026-11-09", purpose: "学会の撮影", permissionConfirmed: true, approverId: KANO };
    expect(borrowProblem(form, CAM_A, "2026-10-26", approvers)).toBeNull();
    expect(borrowProblem({ ...form, dueOn: "2026-11-10" }, CAM_A, "2026-10-26", approvers)).toBe("lending.check.dueTooLong");
    expect(borrowProblem({ ...form, dueOn: "2026-10-25" }, CAM_A, "2026-10-26", approvers)).toBe("lending.check.duePast");
    expect(borrowProblem({ ...form, dueOn: "2026-10-26" }, CAM_A, "2026-10-26", approvers)).toBeNull(); // back the same day
    expect(borrowProblem({ ...form, purpose: "  " }, CAM_A, "2026-10-26", approvers)).toBe("lending.check.purpose");
    expect(borrowProblem({ ...form, permissionConfirmed: false }, CAM_A, "2026-10-26", approvers)).toBe("lending.check.permission");
    expect(borrowProblem({ ...form, approverId: ALICE }, CAM_A, "2026-10-26", approvers)).toBe("lending.check.approver");
    // a teacher borrows without the tick; an item without permission ignores it
    expect(borrowProblem({ ...form, permissionConfirmed: false, approverId: "" }, CAM_A, "2026-10-26", { ...approvers, self_approved: true })).toBeNull();
    expect(borrowProblem({ ...form, permissionConfirmed: false, approverId: "" }, PC, "2026-10-26", null)).toBeNull();
    // my supervisor first, then by name; narrowed by name
    const nameOf = (id: string) => people.find((u) => u.id === id)!.display_name;
    expect(approverChoices(approvers, nameOf).map((c) => [c.name, c.suggested])).toEqual([["佐藤", true], ["加納", false]]);
    expect(approverChoices(approvers, nameOf, "加").map((c) => c.id)).toEqual([KANO]);
  });

  it("extends within the borrower's range; a keeper anywhere from today", () => {
    const l = loan({ due_on: "2026-10-30", latest_due_on: "2026-11-09" });
    expect(extendRange(l, "2026-10-26", false)).toEqual({ min: "2026-10-31", max: "2026-11-09" });
    expect(extendRange(l, "2026-10-26", true)).toEqual({ min: "2026-10-26", max: "2027-10-26" });
    expect(extendProblem("2026-11-09", extendRange(l, "2026-10-26", false), l.due_on, false)).toBeNull();
    expect(extendProblem("2026-10-30", extendRange(l, "2026-10-26", false), l.due_on, false)).toBe("lending.check.sameDue");
    expect(extendProblem("2026-10-29", extendRange(l, "2026-10-26", false), l.due_on, false)).toBe("lending.check.notLater");
    expect(extendProblem("2026-11-10", extendRange(l, "2026-10-26", false), l.due_on, false)).toBe("lending.check.dueTooLong");
    expect(extendProblem("2026-10-27", extendRange(l, "2026-10-26", true), l.due_on, true)).toBeNull(); // earlier, as a keeper
    expect(extendProblem("2026-10-25", extendRange(l, "2026-10-26", true), l.due_on, true)).toBe("lending.check.duePast");
  });

  it("says who took the item first, and words the history", () => {
    const nameOf = (id: string) => people.find((u) => u.id === id)?.display_name ?? "?";
    const taken = new ApiError(409, "lending_item_unavailable", "", { status: "on_loan", loan_id: "x", borrower_id: ALICE, due_on: "2026-10-30" });
    expect(unavailableText(taken, ME, nameOf, "2026-10-26")).toBe("アリス さんが先に借りました（10/30 まで）");
    expect(unavailableText(new ApiError(409, "lending_item_unavailable", "", { status: "on_loan", borrower_id: ME, due_on: "2026-10-30" }), ME, nameOf, "2026-10-26")).toBe("すでに借りています");
    expect(unavailableText(new ApiError(409, "lending_item_unavailable", "", { status: "in_repair" }), ME, nameOf, "2026-10-26")).toBe("この備品は今は借りられません（修理中）");
    expect(unavailableText(new ApiError(400, "lending_due_invalid", ""), ME, nameOf, "2026-10-26")).toBeNull();
    expect(eventText({ kind: "borrowed", details: { due_on: "2026-10-30" } }, "2026-10-26")).toBe("が借りた（10/30 まで）");
    expect(eventText({ kind: "extended", details: { from: "2026-10-30", to: "2026-11-05" } }, "2026-10-26")).toBe("が延長（10/30 → 11/5）");
    expect(eventText({ kind: "returned", details: { condition: "issue", by_keeper: true } }, "2026-10-26")).toBe("が返却を記録");
    expect(eventText({ kind: "status", details: { from: "available", to: "in_repair", note: "表紙" } }, "2026-10-26")).toBe("が「修理中」に変更（表紙）");
    expect(eventText({ kind: "something_new", details: {} }, "2026-10-26")).toBe("が変更");
  });

  it("works the bootstrap's numbers out from the loans, and the badge from them", () => {
    const mine = [loan({ id: "a" }), loan({ id: "b", overdue_days: 2 }), loan({ id: "c", status: "returned", returned_at: "2026-10-20T00:00:00Z" })];
    const active = [loan({ id: "x", borrower_id: ALICE, overdue_days: 3 }), loan({ id: "y", borrower_id: SATO, overdue_days: 0 }), loan({ id: "z", borrower_id: KANO, overdue_days: 1 })];
    const summary = lendingSummaryOf({ ...SETTINGS, is_keeper: true }, mine, active, (id) => id === SATO);
    expect(summary).toEqual({ enabled: true, is_keeper: true, my_active_count: 2, my_overdue_count: 1, keeper_attention_count: 2, settings_updated_at: null });
    expect(lendingBadgeCount(summary)).toBe(3);
    expect(lendingBadgeCount({ ...summary, is_keeper: false })).toBe(1);
    expect(lendingBadgeCount(null)).toBe(0);
    expect(lendingSummaryOf(SETTINGS, mine, active, () => true).keeper_attention_count).toBe(0); // not a keeper
  });

  it("puts 「備品」 in the sidebar only while lending is on, after 予約", () => {
    expect(sidebarNavKeys(null, desktopNavKeys(false, false, false))).not.toContain("lending");
    const keys = sidebarNavKeys(null, desktopNavKeys(false, false, true));
    expect(keys.indexOf("lending")).toBe(keys.indexOf("reservations") + 1);
  });

  it("shows equipment activity items and their to-do state", () => {
    const lending = { item_id: "n1", lending_item_id: "cam-a", loan_id: "l1", item_name: "カメラ A", role: "approver" as const, text: "🔑 …", done: false, done_at: null, done_by: null };
    const row = { kind: "lending", id: "n1", at: NOW.toISOString(), actor_ids: [], lending } as unknown as ActivityItem;
    expect(isShownActivity(row)).toBe(true);
    expect(isShownActivity({ ...row, lending: null } as ActivityItem)).toBe(false);
    expect(activityKey(row)).toBe("lending:n1");
    expect(activityHeadline(row, () => "?")).toEqual({ who: "カメラ A", what: " · 許可の確認" });
    expect(activityHeadline({ ...row, lending: { ...lending, item_name: null, role: "keeper" } } as ActivityItem, () => "?")).toEqual({ who: "備品", what: " · 備品係" });
    expect(isDoneActivity(row, new Set())).toBe(false);
    expect(isDoneActivity(row, new Set(["n1"]))).toBe(true);
    expect(isDoneActivity({ ...row, lending: { ...lending, done: true } } as ActivityItem, new Set())).toBe(true);
  });
});

describe("the borrow dialog", () => {
  const approvers = { user_ids: [KANO, SATO], suggested_ids: [SATO], self_approved: false };

  it("offers dates up to the longest, and 借りる only with a purpose", async () => {
    const borrow = vi.fn(async () => loan({}));
    const { controller } = controllerWith({ borrowLendingItem: borrow });
    const done = vi.fn();
    render(<BorrowDialog controller={controller} item={PC} settings={SETTINGS} onClose={() => {}} onDone={done} onTaken={() => {}} />);
    const date = screen.getByLabelText(/返す日/) as HTMLInputElement;
    expect(date.max).toBe("2026-11-25"); // 30 days (the category's)
    expect(date.min).toBe("2026-10-26");
    expect(date.value).toBe("2026-11-25"); // the longest by default
    expect(document.querySelector("[data-due-hint]")?.textContent).toBe("最長 30 日（11/25 まで）");
    expect(document.querySelector("[data-permission-fields]")).toBeNull();
    const submit = screen.getByRole("button", { name: "借りる" }) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText(/目的/), { target: { value: "学会の撮影" } });
    expect(submit.disabled).toBe(false);
    fireEvent.click(submit);
    await settle();
    expect(borrow).toHaveBeenCalledWith("pc-3", expect.objectContaining({ due_on: "2026-11-25", purpose: "学会の撮影", permission_confirmed: false, approver_id: null }));
    expect(done).toHaveBeenCalled();
  });

  it("needs 「教員の許可を得た」 and the teacher (my supervisor first) when the item asks", async () => {
    const borrow = vi.fn(async () => loan({}));
    const { controller } = controllerWith({ borrowLendingItem: borrow, lendingApprovers: vi.fn(async () => approvers) });
    render(<BorrowDialog controller={controller} item={CAM_A} settings={SETTINGS} onClose={() => {}} onDone={() => {}} onTaken={() => {}} />);
    await settle();
    const fields = document.querySelector("[data-permission-fields]") as HTMLElement;
    expect(fields).toBeTruthy();
    const picker = within(fields).getByRole("combobox", { name: "許可した教員" }) as HTMLSelectElement;
    expect([...picker.options].map((o) => o.textContent)).toEqual(["選んでください", "佐藤（指導教員）", "加納"]);
    expect(picker.value).toBe(SATO); // the supervisor chosen
    fireEvent.change(screen.getByLabelText(/目的/), { target: { value: "撮影" } });
    const submit = screen.getByRole("button", { name: "借りる" }) as HTMLButtonElement;
    expect(submit.disabled).toBe(true); // not ticked
    fireEvent.click(within(fields).getByLabelText("教員の許可を得た"));
    fireEvent.change(picker, { target: { value: "" } });
    expect(submit.disabled).toBe(true); // no teacher
    fireEvent.change(picker, { target: { value: KANO } });
    expect(submit.disabled).toBe(false);
    fireEvent.click(submit);
    await settle();
    expect(borrow).toHaveBeenCalledWith("cam-a", expect.objectContaining({ permission_confirmed: true, approver_id: KANO }));
  });

  it("a teacher of @faculty borrows without the tick", async () => {
    const { controller } = controllerWith({ lendingApprovers: vi.fn(async () => ({ ...approvers, self_approved: true })) });
    render(<BorrowDialog controller={controller} item={CAM_A} settings={SETTINGS} onClose={() => {}} onDone={() => {}} onTaken={() => {}} />);
    await settle();
    expect(document.querySelector("[data-permission-fields]")).toBeNull();
    expect(document.querySelector("[data-self-approved]")).toBeTruthy();
    fireEvent.change(screen.getByLabelText(/目的/), { target: { value: "撮影" } });
    expect((screen.getByRole("button", { name: "借りる" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("sends a retry after a network failure with the same request id", async () => {
    const ids: string[] = [];
    const borrow = vi.fn(async (_item: string, body: { client_request_id: string }) => {
      ids.push(body.client_request_id);
      if (ids.length === 1) throw new NetworkError(new TypeError("Failed to fetch"));
      return loan({});
    });
    const done = vi.fn();
    const { controller } = controllerWith({ borrowLendingItem: borrow });
    render(<BorrowDialog controller={controller} item={PC} settings={SETTINGS} onClose={() => {}} onDone={done} onTaken={() => {}} />);
    fireEvent.change(screen.getByLabelText(/目的/), { target: { value: "撮影" } });
    fireEvent.click(screen.getByRole("button", { name: "借りる" }));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 800)); });
    await settle();
    expect(ids).toHaveLength(2);
    expect(ids[0]).toBe(ids[1]);
    expect(done).toHaveBeenCalledOnce();
  });

  it("says who borrowed it first after a 409, and has the item read again", async () => {
    const borrow = vi.fn(async () => {
      throw new ApiError(409, "lending_item_unavailable", "", { status: "on_loan", loan_id: "x", borrower_id: ALICE, due_on: "2026-10-30" });
    });
    const taken = vi.fn();
    const { controller } = controllerWith({ borrowLendingItem: borrow });
    render(<BorrowDialog controller={controller} item={PC} settings={SETTINGS} onClose={() => {}} onDone={() => {}} onTaken={taken} />);
    fireEvent.change(screen.getByLabelText(/目的/), { target: { value: "撮影" } });
    fireEvent.click(screen.getByRole("button", { name: "借りる" }));
    await settle();
    expect(screen.getByRole("alert").textContent).toBe("アリス さんが先に借りました（10/30 まで）");
    expect(taken).toHaveBeenCalledOnce();
    expect(borrow).toHaveBeenCalledOnce(); // a refusal is not retried
  });
});

describe("the extend dialog", () => {
  it("offers the borrower's range, the extensions left and who waits", async () => {
    const extend = vi.fn(async () => loan({}));
    const { controller } = controllerWith({ extendLendingLoan: extend });
    render(<ExtendDialog controller={controller} loan={loan({ extension_count: 1 })} settings={SETTINGS} today="2026-10-26" asKeeper={false} watchers={2} onClose={() => {}} onDone={() => {}} />);
    const date = screen.getByLabelText(/新しい返す日/) as HTMLInputElement;
    expect([date.min, date.max, date.value]).toEqual(["2026-10-31", "2026-11-09", "2026-11-09"]);
    expect(document.querySelector("[data-extensions-left]")?.textContent).toBe("あと 1 回延長できます");
    expect(document.querySelector("[data-watchers]")?.textContent).toBe("この備品を待っている人がいます（2 人）");
    fireEvent.click(screen.getByRole("button", { name: "延長" }));
    await settle();
    expect(extend).toHaveBeenCalledWith("l", "2026-11-09");
  });
});

describe("the page", () => {
  function api(settings: LendingSettingsOut) {
    const detail = (id: string): LendingItemDetailOut => ({ ...[CAM_A, CAM_B, PC, BOOK].find((i) => i.id === id)!, recent_loans: [], watcher_count: 0 });
    return {
      lendingSettings: vi.fn(async () => settings),
      lendingItems: vi.fn(async () => [BOOK, CAM_A, CAM_B, PC]),
      lendingCategories: vi.fn(async () => CATS),
      lendingItem: vi.fn(async (id: string) => detail(id)),
      lendingItemHistory: vi.fn(async () => ({ events: [], next_before: null })),
      lendingLoan: vi.fn(async () => loan({ id: "lb", item_id: "cam-b", borrower_id: ALICE, details_hidden: true, purpose: null })),
      lendingLoans: vi.fn(async () => []),
    };
  }
  const tabs = () => screen.getAllByRole("tab").map((tab) => tab.getAttribute("data-lending-tab"));

  it("a member: the list, its filters, and borrowing from the detail; no keeper tools", async () => {
    const fake = api(SETTINGS);
    const { controller } = controllerWith(fake);
    render(<LendingView controller={controller} />);
    await settle();
    expect(tabs()).toEqual(["items", "active", "mine"]);
    expect(screen.queryByRole("button", { name: "備品を追加" })).toBeNull();
    const rows = () => [...document.querySelectorAll("[data-lending-item]")].map((row) => row.getAttribute("data-lending-item"));
    expect(rows()).toEqual(["book", "cam-a", "cam-b", "pc-3"]);
    // the overdue loan reads in red with who has it
    expect(document.querySelector('[data-lending-item="cam-b"]')?.textContent).toContain("アリス · 4 日過ぎ");
    fireEvent.click(screen.getByRole("radio", { name: "カメラ" }));
    expect(rows()).toEqual(["cam-a", "cam-b"]);
    fireEvent.change(screen.getByRole("searchbox", { name: "名前・管理番号・置き場所" }), { target: { value: "CAM-02" } });
    expect(rows()).toEqual(["cam-b"]);
    fireEvent.change(screen.getByRole("searchbox", { name: "名前・管理番号・置き場所" }), { target: { value: "" } });
    fireEvent.click(document.querySelector('[data-lending-item="cam-a"]')!);
    await settle();
    const detail = document.querySelector('[data-lending-detail="cam-a"]') as HTMLElement;
    expect(within(detail).getByRole("button", { name: "借りる" })).toBeTruthy();
    expect(within(detail).queryByRole("button", { name: /編集/ })).toBeNull();
    // someone else's loan: the watch, no return
    fireEvent.click(document.querySelector('[data-lending-item="cam-b"]')!);
    await settle();
    const other = document.querySelector('[data-lending-detail="cam-b"]') as HTMLElement;
    expect(within(other).queryByRole("button", { name: "返す" })).toBeNull();
    expect(within(other).queryByRole("button", { name: "返却を記録" })).toBeNull();
    expect(within(other).getByRole("button", { name: "返却されたら知らせる" }).getAttribute("aria-pressed")).toBe("false");
  });

  it("a keeper: 延滞 and 管理, editing, recording someone's return; 設定 with lending.manage", async () => {
    const fake = api({ ...SETTINGS, is_keeper: true });
    const { controller } = controllerWith(fake, ["lending.manage"]);
    render(<LendingView controller={controller} />);
    await settle();
    expect(tabs()).toEqual(["items", "active", "mine", "overdue", "manage", "settings"]);
    expect(screen.getByRole("button", { name: "備品を追加" })).toBeTruthy();
    fireEvent.click(document.querySelector('[data-lending-item="cam-b"]')!);
    await settle();
    const detail = document.querySelector('[data-lending-detail="cam-b"]') as HTMLElement;
    expect(within(detail).getByRole("button", { name: "返却を記録" })).toBeTruthy();
    expect(within(detail).getByRole("button", { name: "返す日を変える" })).toBeTruthy();
    expect((within(detail).getByRole("button", { name: /状態を変える/ }) as HTMLButtonElement).disabled).toBe(true); // on loan
    expect(within(detail).getByRole("button", { name: /編集/ })).toBeTruthy();
    fireEvent.click(screen.getByRole("tab", { name: /設定/ }));
    expect(document.querySelector("[data-lending-settings]")).toBeTruthy();
  });

  it("reads the list again after lending.updated", async () => {
    const fake = api(SETTINGS);
    const { controller, store } = controllerWith(fake);
    render(<LendingView controller={controller} />);
    await settle();
    expect(fake.lendingItems).toHaveBeenCalledTimes(1);
    act(() => store.noteLendingChanged());
    await settle();
    expect(fake.lendingItems).toHaveBeenCalledTimes(2);
  });

  it("while the feature is off: a word, and the switch for administrators", async () => {
    const fake = api({ ...SETTINGS, enabled: false });
    const { controller } = controllerWith(fake, ["lending.manage"]);
    render(<LendingView controller={controller} />);
    await settle();
    expect(screen.getByText("備品の機能はオフになっています。")).toBeTruthy();
    expect(screen.getByLabelText("備品の機能を使う")).toBeTruthy();
    expect(fake.lendingItems).not.toHaveBeenCalled();
  });
});

describe("the engine", () => {
  async function setup(onLendingNotice?: (notice: { text: string }) => void) {
    const server = new FakeServer();
    const alice = server.addUser("alice");
    const bob = server.addUser("bob");
    const store = new Store();
    const engine = new SyncEngine(
      { api: server.apiFor(bob.id), connect: server.connectorFor(bob.id), store, getAccessToken: () => "token", sleep: async () => {}, random: () => 0.5, onLendingNotice },
      { pageSize: 3, gapLimit: 5, reconnectMinMs: 0 },
    );
    return { server, alice, bob, store, engine };
  }

  it("takes the bootstrap's numbers, and works them out again after lending.updated", async () => {
    vi.useRealTimers();
    const { server, bob, store, engine } = await setup();
    server.lending = { enabled: true, is_keeper: false, my_active_count: 1, my_overdue_count: 0, keeper_attention_count: 0, settings_updated_at: null };
    await engine.start();
    await engine.idle();
    expect(store.lending?.my_active_count).toBe(1);
    const revision = store.lendingRevision;
    server.lendingSettings = SETTINGS;
    server.lendingLoans = { mine: [loan({ borrower_id: bob.id, overdue_days: 1 }), loan({ id: "l2", borrower_id: bob.id })] };
    server.emitLendingUpdated();
    server.emitLendingUpdated(); // a burst is one read
    await engine.idle();
    await new Promise((resolve) => setTimeout(resolve, 350));
    await engine.idle();
    expect(server.lendingReads).toBe(1);
    expect(store.lendingRevision).toBe(revision + 1);
    expect(store.lending).toMatchObject({ my_active_count: 2, my_overdue_count: 1 });
    // turned off: no numbers, no item
    server.lendingSettings = { ...SETTINGS, enabled: false };
    server.emitLendingUpdated({ settings: true });
    await new Promise((resolve) => setTimeout(resolve, 350));
    await engine.idle();
    expect(store.lending).toBeNull();
    engine.stop();
  });

  it("shows an equipment notice", async () => {
    vi.useRealTimers();
    const notices: string[] = [];
    const { server, bob, engine } = await setup((n) => notices.push(n.text));
    await engine.start();
    await engine.idle();
    server.noticeLending(bob.id, "📦 「カメラ A」は明日（10/30）が返す日です。");
    await engine.idle();
    expect(notices).toEqual(["📦 「カメラ A」は明日（10/30）が返す日です。"]);
    engine.stop();
  });
});
