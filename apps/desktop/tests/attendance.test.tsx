// @vitest-environment jsdom
// M140 (docs/PRESENCE.md §7): 「在室状況」 — the board's grouping and counts, the quick buttons, my own states, the chip,
// the engine's events and the admin tab.
process.env.TZ = "Asia/Tokyo";

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { AttendanceAdminSettingsOut, AttendanceBoardOut, AttendanceStateOut, UserMe, UserPublic } from "../src/api/types";
import type { AppController } from "../src/state/app";
import { SyncEngine } from "../src/sync/engine";
import { Store } from "../src/sync/store";
import { type MessageKey, tIn, type UiLocale, UI_LOCALES } from "../src/i18n";
import { boardGroups, inRoomCount, myChoices, sinceLabel, stateText } from "../src/ui/attendance";
import { ATTENDANCE_BADGE_COLORS, ATTENDANCE_BADGE_FG, ATTENDANCE_ICONS, attendanceBadgeColor, StateBadge } from "../src/ui/attendanceIcons";
import { ATTENDANCE_COLORS } from "../src/ui/attendance";
import { AttendancePill, pillMode } from "../src/ui/AttendancePill";
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
  return { id, owner_id: null, label, icon: null, emoji: null, color: "gray", kind, position: 0, archived: false, ...over };
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
    can: () => admin,
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
    // All eight colours are offered as swatches.
    expect(within(within(dialog).getByRole("radiogroup", { name: "色" })).getAllByRole("radio")).toHaveLength(8);
    fireEvent.click(within(dialog).getByRole("radio", { name: "赤" }));
    fireEvent.change(within(dialog).getByRole("combobox", { name: "分類" }), { target: { value: "off_site" } });
    // A new state's icon follows its kind until one is picked.
    expect((within(dialog).getByRole("radio", { name: "外出" }) as HTMLInputElement).checked).toBe(true);
    fireEvent.click(within(dialog).getByRole("radio", { name: "会議" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "追加" }));
    await waitFor(() => expect(createMyAttendanceState).toHaveBeenCalledWith({ label: "会議", icon: "meeting", emoji: null, color: "red", kind: "off_site" }));
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

// --- icons (apps/shared/attendance-icons.json) and the quick switch (docs/PRESENCE.md §7.1) ---------------------------

interface IconCatalogue {
  icons: Array<{ key: string; lucide: string; sf: string; material: string; label: Record<UiLocale, string> }>;
  defaults: Record<string, string>;
}
const iconCatalogue = JSON.parse(readFileSync(join(process.cwd(), "..", "shared", "attendance-icons.json"), "utf8")) as IconCatalogue;

describe("the icons", () => {
  it("this copy is the shared catalogue, and the picker's names are its labels", () => {
    expect(ATTENDANCE_ICONS.map(({ key, lucide }) => ({ key, lucide }))).toEqual(iconCatalogue.icons.map(({ key, lucide }) => ({ key, lucide })));
    for (const icon of iconCatalogue.icons) {
      for (const locale of UI_LOCALES) expect(tIn(locale, `attendance.icon.${icon.key}` as MessageKey)).toBe(icon.label[locale]);
    }
  });

  it("a state draws its icon, else its emoji (an unknown key too), else nothing", () => {
    const { container } = render(
      <>
        <StateBadge state={{ ...OUT, icon: "off_site", emoji: "🚶" }} />
        <StateBadge state={{ ...MEETING, icon: "rocket-from-the-future", emoji: "🗣️" }} />
        <StateBadge state={CAMPUS} />
      </>,
    );
    const badges = [...container.querySelectorAll("[data-attendance-badge]")];
    expect(badges[0]!.querySelector("svg[data-attendance-icon='off_site']")).toBeTruthy();
    expect(badges[0]!.textContent).toBe("学外");
    expect(badges[1]!.querySelector("svg")).toBeNull();
    expect(badges[1]!.querySelector("[data-attendance-emoji]")!.textContent).toBe("🗣️");
    expect(badges[2]!.querySelector("svg, [data-attendance-emoji]")).toBeNull();
    // As text: the emoji only stands in when no icon is drawn.
    expect(stateText({ ...IN, icon: "in_room" })).toBe("在室");
    expect(stateText(IN)).toBe("🟢 在室");
  });

  it("the page's buttons and the chip use the icon", () => {
    const withIcons = board({ states: board().states.map((s) => (s.id === IN.id ? { ...s, icon: "in_room" } : s.id === MEETING.id ? { ...s, icon: "meeting" } : s)) });
    const controller = controllerFor(storeWith(withIcons), {});
    render(<AttendanceView controller={controller} />);
    const button = screen.getByRole("button", { name: "在室" });
    expect(button.querySelector("svg[data-attendance-icon='in_room']")).toBeTruthy();
    cleanup();
    const { container } = render(<AttendanceChip controller={controller} userId={ALICE} />);
    expect(container.querySelector("[data-attendance-chip] svg[data-attendance-icon='meeting']")).toBeTruthy();
  });
});

// --- the solid badge palette (apps/shared/attendance-badge-colors.json, docs/PRESENCE.md §2.2) ------------------------

interface BadgePalette { fg: string; min_text_contrast: number; min_icon_contrast: number; colors: Record<string, string> }
const badgePalette = JSON.parse(readFileSync(join(process.cwd(), "..", "shared", "attendance-badge-colors.json"), "utf8")) as BadgePalette;

/** WCAG 2.x relative luminance and contrast ratio of two #RRGGBB colours. */
function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}
function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
}

describe("the badge palette", () => {
  it("this copy is the shared palette, with a shade for every colour key", () => {
    expect(ATTENDANCE_BADGE_FG).toBe(badgePalette.fg);
    expect(ATTENDANCE_BADGE_COLORS).toEqual(badgePalette.colors);
    expect(Object.keys(badgePalette.colors)).toEqual([...ATTENDANCE_COLORS]);
    expect(attendanceBadgeColor("nonsense")).toBe(badgePalette.colors.gray);
  });

  it("white on every shade meets WCAG AA (text 4.5:1, icons 3:1)", () => {
    expect(contrast("#FFFFFF", "#000000")).toBeCloseTo(21, 5);
    expect(badgePalette.min_text_contrast).toBeGreaterThanOrEqual(4.5);
    expect(badgePalette.min_icon_contrast).toBeGreaterThanOrEqual(3);
    for (const [key, shade] of Object.entries(ATTENDANCE_BADGE_COLORS)) {
      const ratio = contrast(ATTENDANCE_BADGE_FG, shade);
      expect(ratio, key).toBeGreaterThanOrEqual(badgePalette.min_text_contrast);
      expect(ratio, key).toBeGreaterThanOrEqual(badgePalette.min_icon_contrast);
    }
  });

  it("the badge, the selected button and the chip are solid with white; an unselected button only tints its icon", () => {
    const { container } = render(<StateBadge state={{ ...OUT, color: "yellow", emoji: "🚶" }} />);
    const badge = container.querySelector("[data-attendance-badge]") as HTMLElement;
    expect(badge.style.background).toBe("rgb(161, 98, 7)");
    expect(badge.style.color).toBe("rgb(255, 255, 255)");
    expect(badge.className).not.toContain("text-emoji");
    // The emoji fallback sits on the solid badge too.
    expect(badge.querySelector("[data-attendance-emoji]")!.textContent).toBe("🚶");
    cleanup();
    const mine = { ...board(), entries: [...board().entries, { user_id: ME, state_id: IN.id, since: "2026-10-07T00:00:00Z", note: null, source: "app" as const }] };
    render(<AttendanceView controller={controllerFor(storeWith(mine), {})} />);
    const selected = screen.getByRole("button", { name: "在室", pressed: true });
    expect(selected.style.background).not.toBe("");
    expect(selected.style.color).toBe("rgb(255, 255, 255)");
    const unselected = screen.getAllByRole("button", { pressed: false })[0]!;
    expect(unselected.style.background).toBe("");
    expect(unselected.querySelector(".attendance-tint")).toBeTruthy();
  });
});

describe("the quick switch", () => {
  const withIcons = () => board({ states: board().states.map((s) => (s.id === OUT.id ? { ...s, icon: "off_site", color: "purple" as const } : s)) });
  const mineIn = (b: AttendanceBoardOut, stateId: string, note: string | null = null): AttendanceBoardOut => ({
    ...b,
    entries: [...b.entries, { user_id: ME, state_id: stateId, since: "2026-10-07T00:00:00Z", note, source: "app" }],
  });

  it("shows my state (icon, colour, name), or 「在室状況」 with an outline", () => {
    const { container, unmount } = render(<AttendancePill controller={controllerFor(storeWith(mineIn(withIcons(), OUT.id)), {})} placement="sidebar" />);
    const pill = container.querySelector("[data-attendance-pill]") as HTMLElement;
    expect(pill.getAttribute("data-attendance-pill")).toBe("off_site");
    expect(pill.textContent).toBe("学外");
    expect(pill.querySelector("svg[data-attendance-icon='off_site']")).toBeTruthy();
    expect(pill.getAttribute("aria-label")).toBe("在室状況：学外");
    // The solid badge: the purple shade with white (docs/PRESENCE.md §2.2).
    expect(pill.style.background).toBe("rgb(124, 58, 237)");
    expect(pill.style.color).toBe("rgb(255, 255, 255)");
    unmount();
    render(<AttendancePill controller={controllerFor(storeWith(withIcons()), {})} placement="sidebar" />);
    const none = screen.getByRole("button", { name: "在室状況を変える" });
    expect(none.textContent).toBe("在室状況");
    expect(none.getAttribute("data-attendance-pill")).toBe("none");
  });

  it("is not there while the board is off, nor for guests", () => {
    const { container } = render(<AttendancePill controller={controllerFor(storeWith(null), {})} placement="sidebar" />);
    expect(container.querySelector("[data-attendance-pill]")).toBeNull();
    const guest = { ...controllerFor(storeWith(withIcons()), {}), isGuest: true } as unknown as AppController;
    render(<AttendancePill controller={guest} placement="sidebar" />);
    expect(document.querySelector("[data-attendance-pill]")).toBeNull();
  });

  it("collapses to its icon, the name in the tooltip", () => {
    render(<AttendancePill controller={controllerFor(storeWith(mineIn(withIcons(), OUT.id)), {})} placement="sidebar" collapsed />);
    const pill = screen.getByRole("button", { name: "在室状況：学外" });
    expect(pill.getAttribute("data-collapsed")).toBe("true");
    expect(pill.textContent).toBe("");
    expect(pill.getAttribute("title")).toBe("在室状況：学外");
    expect(pill.querySelector("svg[data-attendance-icon='off_site']")).toBeTruthy();
  });

  it("fits the row: the whole name first, then the icon, the name cut to its minimum, then nothing", () => {
    expect(pillMode({ room: 240, nameNatural: 100, nameMin: 60, full: 80 })).toBe("full");
    expect(pillMode({ room: 160, nameNatural: 100, nameMin: 60, full: 80 })).toBe("icon");
    expect(pillMode({ room: 110, nameNatural: 100, nameMin: 60, full: 80 })).toBe("icon");
    expect(pillMode({ room: 80, nameNatural: 100, nameMin: 60, full: 80 })).toBe("hidden");
    // A short name is never cut: its whole width is its minimum.
    expect(pillMode({ room: 80, nameNatural: 40, nameMin: 40, full: 80 })).toBe("icon");
  });

  it("the menu switches with one press and keeps the note only for the same state", async () => {
    const store = storeWith(mineIn(withIcons(), IN.id, "3 号室"));
    const setMyAttendance = vi.fn(async (stateId: string, note: string | null) => ({ user_id: ME, state_id: stateId, since: "2026-10-07T01:00:00Z", note, source: "app" as const }));
    const onOpenBoard = vi.fn();
    render(<AttendancePill controller={controllerFor(store, { setMyAttendance })} placement="sidebar" onOpenBoard={onOpenBoard} />);
    fireEvent.click(screen.getByRole("button", { name: "在室状況：在室" }));
    const menu = await screen.findByRole("menu", { name: "状態を選ぶ" });
    const items = within(menu).getAllByRole("menuitemradio");
    expect(items.map((i) => i.textContent)).toEqual(["🟢在室", "学内", "学外", "帰宅", "出張（自分用）"]);
    expect(items[0]!.getAttribute("aria-checked")).toBe("true");
    await waitFor(() => expect(document.activeElement).toBe(items[0]));
    fireEvent.click(items[2]!);
    await waitFor(() => expect(setMyAttendance).toHaveBeenCalledWith(OUT.id, null));
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    expect(screen.getByRole("button", { name: "在室状況：学外" })).toBeTruthy();

    // The note, and 「在室状況を開く」.
    fireEvent.click(screen.getByRole("button", { name: "在室状況：学外" }));
    fireEvent.change(await screen.findByRole("textbox", { name: "メモ" }), { target: { value: "15 時に戻ります" } });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => expect(setMyAttendance).toHaveBeenLastCalledWith(OUT.id, "15 時に戻ります"));
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    fireEvent.click(screen.getByRole("button", { name: "在室状況：学外" }));
    fireEvent.click(await screen.findByRole("button", { name: "在室状況を開く" }));
    expect(onOpenBoard).toHaveBeenCalled();
  });

  it("the menu closes on a press on the title bar (a drag region), on the window's blur and on Esc; not on a press inside", async () => {
    // 2026-10-08: it stayed open after a click elsewhere in the top bar. The bar as the desktop app has it: Tauri's
    // script stops the mousedown on the bare drag region (and the WebView may send that press without a pointerdown).
    const row = document.createElement("div");
    row.setAttribute("data-tauri-drag-region", "");
    document.body.append(row);
    const tauri = (event: MouseEvent) => {
      if (event.target === row) {
        event.preventDefault();
        event.stopImmediatePropagation();
      }
    };
    document.addEventListener("mousedown", tauri);
    try {
      render(<AttendancePill controller={controllerFor(storeWith(withIcons()), {})} placement="sidebar" />);
      const pill = screen.getByRole("button", { name: "在室状況を変える" });
      const reopen = async () => {
        fireEvent.click(pill);
        return screen.findByRole("menu");
      };

      const menu = await reopen();
      // Inside (a state, the note) keeps it open.
      fireEvent.pointerDown(within(menu).getAllByRole("menuitemradio")[1]!);
      fireEvent.mouseDown(within(menu).getAllByRole("menuitemradio")[1]!);
      expect(screen.queryByRole("menu")).toBeTruthy();

      fireEvent.mouseDown(row, { button: 0 });
      await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());

      await reopen();
      fireEvent.pointerDown(row, { button: 0 });
      await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());

      await reopen();
      act(() => {
        fireEvent.blur(window);
      });
      await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());

      await reopen();
      fireEvent.keyDown(document.body, { key: "Escape" });
      await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());

      // The pill itself still toggles.
      await reopen();
      fireEvent.pointerDown(pill);
      fireEvent.mouseDown(pill);
      fireEvent.click(pill);
      await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    } finally {
      document.removeEventListener("mousedown", tauri);
      row.remove();
    }
  });

  it("works from the keyboard: ↓ opens, arrows move, Esc closes, ⌘⇧Y opens from anywhere", async () => {
    render(<AttendancePill controller={controllerFor(storeWith(withIcons()), {})} placement="sidebar" shortcut />);
    const pill = screen.getByRole("button", { name: "在室状況を変える" });
    pill.focus();
    fireEvent.keyDown(pill, { key: "ArrowDown" });
    const menu = await screen.findByRole("menu");
    const items = within(menu).getAllByRole("menuitemradio");
    await waitFor(() => expect(document.activeElement).toBe(items[0]));
    fireEvent.keyDown(items[0]!, { key: "ArrowDown" });
    expect(document.activeElement).toBe(items[1]);
    fireEvent.keyDown(items[1]!, { key: "End" });
    expect(document.activeElement).toBe(items.at(-1));
    fireEvent.keyDown(items.at(-1)!, { key: "ArrowDown" });
    expect(document.activeElement).toBe(items[0]);
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    fireEvent.keyDown(window, { key: "y", metaKey: true, shiftKey: true });
    expect(await screen.findByRole("menu")).toBeTruthy();
  });
});
