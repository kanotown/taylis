// @vitest-environment jsdom
// M140 (docs/PRESENCE.md §7): 「在室状況」 — the board's grouping and counts, the quick buttons, my own states, the chip,
// the engine's events and the admin tab.
process.env.TZ = "Asia/Tokyo";

import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { AttendanceAdminSettingsOut, AttendanceBoardOut, AttendanceStateOut, UserMe, UserPublic } from "../src/api/types";
import type { AppController } from "../src/state/app";
import { SyncEngine } from "../src/sync/engine";
import { Store } from "../src/sync/store";
import { boardGroups, inRoomCount, myChoices, sinceLabel } from "../src/ui/attendance";
import { AttendanceAdminTab } from "../src/ui/AttendanceAdminTab";
import { AttendanceChip } from "../src/ui/AttendanceChip";
import { AttendanceView } from "../src/ui/AttendanceView";
import { desktopNavKeys, sidebarNavKeys } from "../src/ui/navItems";
import { FakeServer } from "./fakeServer";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const ME = "11111111-1111-4111-8111-111111111111";
const ALICE = "22222222-2222-4222-8222-222222222222";
const BOB = "33333333-3333-4333-8333-333333333333";
const GUEST = "44444444-4444-4444-8444-444444444444";
const people: UserPublic[] = [
  { id: ME, username: "me", display_name: "わたし", role: "member", deactivated_at: null } as UserPublic,
  { id: ALICE, username: "alice", display_name: "アリス", role: "member", deactivated_at: null } as UserPublic,
  { id: BOB, username: "bob", display_name: "ボブ", role: "admin", deactivated_at: null } as UserPublic,
  { id: GUEST, username: "guest", display_name: "ゲスト", role: "guest", deactivated_at: null } as UserPublic,
];

function state(id: string, label: string, kind: AttendanceStateOut["kind"], over: Partial<AttendanceStateOut> = {}): AttendanceStateOut {
  return { id, owner_id: null, label, emoji: null, color: "gray", kind, position: 0, archived: false, ...over };
}

const IN = state("s-in", "在室", "in_room", { emoji: "🟢", color: "green", position: 0 });
const CAMPUS = state("s-campus", "学内", "on_site", { position: 1 });
const OUT = state("s-out", "学外", "off_site", { position: 2 });
const HOME = state("s-home", "帰宅", "gone", { position: 3 });
const MEETING = state("s-meeting", "会議", "on_site", { owner_id: ALICE, color: "red" });
const MINE = state("s-mine", "出張", "off_site", { owner_id: ME });

function board(over: Partial<AttendanceBoardOut> = {}): AttendanceBoardOut {
  return {
    enabled: true,
    states: [IN, CAMPUS, OUT, HOME, MEETING, MINE],
    entries: [
      { user_id: ALICE, state_id: MEETING.id, since: "2026-10-07T00:15:00Z", note: "教授会", source: "app" },
      { user_id: BOB, state_id: IN.id, since: "2026-10-06T09:02:00Z", note: null, source: "integration" },
      { user_id: GUEST, state_id: IN.id, since: "2026-10-07T00:00:00Z", note: null, source: "app" },
    ],
    can_personalize: true,
    ...over,
  };
}

function storeWith(b: AttendanceBoardOut | null): Store {
  const store = new Store();
  store.setMe({ ...people[0]! } as unknown as UserMe);
  for (const user of people) store.upsertUser(user);
  store.setAttendance(b);
  return store;
}

describe("the board's rules", () => {
  it("groups by state in kind order, unset last; guests are never on it", () => {
    const groups = boardGroups(board(), people);
    expect(groups.map((g) => [g.state?.label ?? null, g.people.map((p) => p.user.username)])).toEqual([
      ["在室", ["bob"]],
      ["会議", ["alice"]],
      [null, ["me"]],
    ]);
    expect(inRoomCount(board(), people)).toBe(1);
  });

  it("offers the workspace's states then mine, never someone else's or an archived one", () => {
    const b = board({ states: [...board().states, state("s-old", "旧", "gone", { archived: true })] });
    expect(myChoices(b, ME).map((s) => s.label)).toEqual(["在室", "学内", "学外", "帰宅", "出張"]);
  });

  it("says since when: the time today, the date before", () => {
    const now = new Date("2026-10-07T03:00:00Z");
    expect(sinceLabel("2026-10-07T00:15:00Z", now)).toBe("9:15 から");
    expect(sinceLabel("2026-10-06T09:02:00Z", now)).toBe("10/6 18:02 から");
  });

  it("the sidebar item shows only while the board is on", () => {
    expect(sidebarNavKeys(null, desktopNavKeys(false))).not.toContain("attendance");
    expect(sidebarNavKeys(null, desktopNavKeys(true)).at(-1)).toBe("attendance");
  });

  it("the store keeps a row per person and says when a state is unknown", () => {
    const store = storeWith(board());
    expect(store.applyAttendanceEntry({ user_id: ME, state_id: IN.id, since: "2026-10-07T01:00:00Z", note: null, source: "app" })).toBe(true);
    expect(store.attendance!.entries.filter((e) => e.user_id === ME)).toHaveLength(1);
    expect(store.applyAttendanceEntry({ user_id: ME, state_id: "s-new", since: "2026-10-07T01:00:00Z", note: null, source: "app" })).toBe(false);
    store.setAttendance({ enabled: false, states: [], entries: [], can_personalize: false });
    expect(store.attendance).toBeNull();
  });
});

function controllerFor(store: Store, api: Record<string, unknown>, admin = false) {
  return {
    store,
    api,
    isAdmin: admin,
    isGuest: false,
    error: null,
    version: 0,
    subscribe: () => () => {},
    setError: vi.fn(),
    setNotice: vi.fn(),
    engine: { loadAttendance: vi.fn(async () => {}) },
  } as unknown as AppController;
}

describe("the page", () => {
  it("one press switches my state; the current one is pressed; the board follows", async () => {
    const store = storeWith(board());
    const setMyAttendance = vi.fn(async (stateId: string, note: string | null) => ({ user_id: ME, state_id: stateId, since: "2026-10-07T01:00:00Z", note, source: "app" as const }));
    render(<AttendanceView controller={controllerFor(store, { setMyAttendance })} />);
    expect(screen.getByText("在室 1 人")).toBeTruthy();
    const buttons = within(screen.getByRole("group", { name: "状態を選ぶ" })).getAllByRole("button");
    expect(buttons.map((b) => b.textContent)).toEqual(["🟢在室", "学内", "学外", "帰宅", "出張 （自分用）"]);
    expect(buttons.every((b) => b.getAttribute("aria-pressed") === "false")).toBe(true);
    fireEvent.click(buttons[0]!);
    await waitFor(() => expect(setMyAttendance).toHaveBeenCalledWith(IN.id, null));
    await waitFor(() => expect(screen.getByRole("button", { name: /在室/, pressed: true })).toBeTruthy());
    expect(screen.getByText("在室 2 人")).toBeTruthy();
    const group = document.querySelector(`[data-attendance-group="${IN.id}"]`) as HTMLElement;
    expect(within(group).getByText(/わたし/)).toBeTruthy();
    // The note is saved with the current state.
    const note = screen.getByRole("textbox", { name: "メモ" });
    fireEvent.change(note, { target: { value: "  3 号室 " } });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => expect(setMyAttendance).toHaveBeenLastCalledWith(IN.id, "3 号室"));
  });

  it("buttons are reachable by keyboard (real buttons) and errors go to the banner", async () => {
    const store = storeWith(board());
    const failure = new Error("nope");
    const controller = controllerFor(store, { setMyAttendance: vi.fn(async () => { throw failure; }) });
    render(<AttendanceView controller={controller} />);
    const button = screen.getByRole("button", { name: "学内" });
    expect(button.tagName).toBe("BUTTON");
    button.focus();
    fireEvent.click(button);
    await waitFor(() => expect(controller.setError).toHaveBeenCalledWith(failure));
  });

  it("my own states: listed, added through the form, only when allowed", async () => {
    const store = storeWith(board());
    const createMyAttendanceState = vi.fn(async () => MINE);
    const controller = controllerFor(store, { createMyAttendanceState });
    const { unmount } = render(<AttendanceView controller={controller} />);
    const own = screen.getByRole("region", { name: "自分用の状態" });
    expect(within(own).getByText("出張")).toBeTruthy();
    fireEvent.click(within(own).getByRole("button", { name: /自分用の状態を追加/ }));
    const dialog = screen.getByRole("dialog");
    fireEvent.change(within(dialog).getByRole("textbox", { name: "名前" }), { target: { value: "会議" } });
    fireEvent.change(within(dialog).getByRole("combobox", { name: "色" }), { target: { value: "red" } });
    fireEvent.change(within(dialog).getByRole("combobox", { name: "分類" }), { target: { value: "on_site" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "追加" }));
    await waitFor(() => expect(createMyAttendanceState).toHaveBeenCalledWith({ label: "会議", emoji: null, color: "red", kind: "on_site" }));
    unmount();
    render(<AttendanceView controller={controllerFor(storeWith(board({ can_personalize: false })), {})} />);
    expect(screen.queryByRole("region", { name: "自分用の状態" })).toBeNull();
  });

  it("says the board is off", () => {
    render(<AttendanceView controller={controllerFor(storeWith(null), {})} />);
    expect(screen.getByText(/在室状況はオフ/)).toBeTruthy();
  });

  it("the chip shows someone's state, and nothing without one", () => {
    const controller = controllerFor(storeWith(board()), {});
    const { container } = render(<><AttendanceChip controller={controller} userId={ALICE} /><AttendanceChip controller={controller} userId={ME} /></>);
    const chips = container.querySelectorAll("[data-attendance-chip]");
    expect(chips).toHaveLength(1);
    expect(chips[0]!.textContent).toBe("会議");
    expect(chips[0]!.getAttribute("title")).toContain("教授会");
  });
});

describe("the admin tab", () => {
  const settings: AttendanceAdminSettingsOut = {
    enabled: true,
    personal_rule: "nobody",
    personal_group_ids: [],
    log_retention_days: 365,
    states: [IN, CAMPUS, OUT, HOME],
  };

  function adminApi(over: Record<string, unknown> = {}) {
    return {
      baseUrl: "https://chat.example.com",
      adminAttendanceSettings: vi.fn(async () => settings),
      adminUpdateAttendanceSettings: vi.fn(async () => settings),
      adminReorderAttendanceStates: vi.fn(async () => settings),
      adminAttendanceIntegrations: vi.fn(async () => [{ id: "i1", name: "研究室サイト", url: "https://lab.example.ac.jp/hook", secret_name: "lab-site", enabled: true, inbound: true, created_at: "2026-10-07T00:00:00Z", last_inbound_at: null }]),
      adminCreateAttendanceIntegration: vi.fn(async () => ({ integration: { id: "i2", name: "new", url: null, secret_name: null, enabled: true, inbound: true, created_at: "2026-10-07T00:00:00Z", last_inbound_at: null }, token: "tya_secret" })),
      adminTestAttendanceIntegration: vi.fn(async () => ({ delivery: { id: "d1", event: "attendance.test", user_id: BOB, status: "delivered", attempts: 1, last_status_code: 204, last_error: null, created_at: "2026-10-07T00:00:00Z", delivered_at: "2026-10-07T00:00:01Z", next_attempt_at: null, to_label: "在室" } })),
      adminAttendanceDeliveries: vi.fn(async () => []),
      attendanceLog: vi.fn(async () => ({ items: [{ id: 1, user_id: ALICE, from_state_id: IN.id, to_state_id: MEETING.id, note: null, at: "2026-10-07T00:15:00Z", source: "integration", actor_id: null, integration_id: "i1" }], next_before_id: null })),
      ...over,
    };
  }

  it("states in order with ↑ / ↓, the rule, integrations with a test send and the log", async () => {
    const api = adminApi();
    const controller = controllerFor(storeWith(board()), api, true);
    render(<AttendanceAdminTab controller={controller} />);
    await screen.findByRole("region", { name: "ワークスペースの状態" });
    expect(screen.getByRole("switch", { name: "在室状況を使う" })).toHaveProperty("checked", true);
    fireEvent.click(screen.getByRole("button", { name: "学内 を上へ" }));
    await waitFor(() => expect(api.adminReorderAttendanceStates).toHaveBeenCalledWith([CAMPUS.id, IN.id, OUT.id, HOME.id]));
    fireEvent.change(screen.getByRole("combobox", { name: "自分用の状態を追加できる人" }), { target: { value: "everyone" } });
    await waitFor(() => expect(api.adminUpdateAttendanceSettings).toHaveBeenCalledWith({ personal_rule: "everyone" }));

    const row = await screen.findByText("研究室サイト");
    const item = row.closest("[data-integration]") as HTMLElement;
    expect(within(item).getByText(/lab-site/)).toBeTruthy();
    fireEvent.click(within(item).getByRole("button", { name: /テスト送信/ }));
    await waitFor(() => expect(api.adminTestAttendanceIntegration).toHaveBeenCalledWith("i1"));
    await waitFor(() => expect(controller.setNotice).toHaveBeenCalledWith("テスト送信が届きました（HTTP 204）"));

    const log = screen.getByRole("region", { name: "最近の変更" });
    await waitFor(() => expect(within(log).getByText("アリス")).toBeTruthy());
    expect(within(log).getByText("🟢 在室 → 会議")).toBeTruthy();
    expect(within(log).getByText("連携")).toBeTruthy();
  });

  it("a new integration shows its inbound token once", async () => {
    const api = adminApi();
    render(<AttendanceAdminTab controller={controllerFor(storeWith(board()), api, true)} />);
    fireEvent.click(await screen.findByRole("button", { name: /連携を追加/ }));
    const dialog = screen.getByRole("dialog");
    fireEvent.change(within(dialog).getByRole("textbox", { name: "名前" }), { target: { value: "new" } });
    await act(async () => {
      fireEvent.click(within(dialog).getByRole("button", { name: "保存" }));
    });
    await waitFor(() => expect(api.adminCreateAttendanceIntegration).toHaveBeenCalledWith({ name: "new", url: null, secret_name: null, inbound: true }));
    expect(await screen.findByText("tya_secret")).toBeTruthy();
  });

  it("off: only the switch", async () => {
    const api = adminApi({ adminAttendanceSettings: vi.fn(async () => ({ ...settings, enabled: false })) });
    render(<AttendanceAdminTab controller={controllerFor(storeWith(null), api, true)} />);
    const toggle = await screen.findByRole("switch", { name: "在室状況を使う" });
    expect(screen.queryByRole("region", { name: "ワークスペースの状態" })).toBeNull();
    fireEvent.click(toggle);
    await waitFor(() => expect(api.adminUpdateAttendanceSettings).toHaveBeenCalledWith({ enabled: true }));
  });
});

describe("the engine", () => {
  it("loads the board from bootstrap, follows attendance.updated and reads again on config_updated", async () => {
    const server = new FakeServer();
    const alice = server.addUser("alice");
    const bob = server.addUser("bob");
    server.createChannel("general", alice.id);
    server.attendance = board({ entries: [], states: [IN, HOME] });
    const store = new Store();
    const engine = new SyncEngine({ api: server.apiFor(alice.id), connect: server.connectorFor(alice.id), store, getAccessToken: () => "t", sleep: async () => {} }, { pageSize: 50 });
    await engine.start();
    await engine.idle();
    expect(store.attendance?.states.map((s) => s.id)).toEqual([IN.id, HOME.id]);
    server.emitAttendance("attendance.updated", { user_id: bob.id, state_id: IN.id, since: "2026-10-07T00:00:00Z", note: null, source: "app" });
    await engine.idle();
    expect(store.attendance?.entries).toEqual([{ user_id: bob.id, state_id: IN.id, since: "2026-10-07T00:00:00Z", note: null, source: "app" }]);
    // Turned off: the read after config_updated (300 ms later) clears the board.
    server.attendance = null;
    server.emitAttendance("attendance.config_updated", {});
    await engine.idle();
    await waitFor(() => expect(store.attendance).toBeNull(), { timeout: 2000 });
    engine.stop();
  });
});
