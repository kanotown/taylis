// @vitest-environment jsdom
/**
 * M111 「サイドバーの項目」: my sidebar's menu items (UserMe.nav_items). The catalogue and the rule against
 * apps/shared/nav-items.json, the sidebar drawing my order (badges kept), and the settings' ↑ / ↓, drag and 「元に戻す」.
 * 2026-10-12: where each stands on Desktop / Web (UserMe.desktop_places), apart from the phones' visibility.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { UserMe } from "../src/api/types";
import type { AppController } from "../src/state/app";
import { Store } from "../src/sync/store";
import type { DesktopPlaces } from "../src/ui/desktopPlaces";
import { fullNavItems, NAV_CATALOGUE, NAV_ORDER, type NavItem, type NavPlatform, reorderNavItems, resetNavOrder, shownNavItems, sidebarNavKeys } from "../src/ui/navItems";
import { NavItemsSettings } from "../src/ui/Settings";
import { Sidebar } from "../src/ui/Sidebar";
import { FakeServer } from "./fakeServer";

interface Shared {
  items: Array<{ key: string; label: string; mobile_label?: string; visible: boolean; platforms: NavPlatform[] }>;
  order: Record<NavPlatform, string[]>;
  cases: Array<{ name: string; stored: NavItem[] | null; platform: NavPlatform; implemented: string[]; full: NavItem[]; shown: NavItem[] }>;
  reorder: Array<{ name: string; stored: NavItem[] | null; platform: NavPlatform; implemented: string[]; order: string[]; full: NavItem[] }>;
}
const shared = JSON.parse(readFileSync(join(process.cwd(), "..", "shared", "nav-items.json"), "utf8")) as Shared;

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("the catalogue and the rule (apps/shared/nav-items.json)", () => {
  it("this copy is the shared catalogue", () => {
    expect(NAV_CATALOGUE.map(({ key, label, visible, platforms }) => ({ key, label, visible, platforms }))).toEqual(
      shared.items.map(({ key, label, visible, platforms }) => ({ key, label, visible, platforms })),
    );
    expect(NAV_ORDER).toEqual(shared.order);
  });

  it("full and shown", () => {
    for (const c of shared.cases) {
      const full = fullNavItems(c.stored, c.platform);
      expect(full, c.name).toEqual(c.full);
      expect(shownNavItems(full, c.platform, c.implemented), c.name).toEqual(c.shown);
    }
  });

  it("reordering the shown items keeps everything else in its slot", () => {
    for (const c of shared.reorder) expect(reorderNavItems(fullNavItems(c.stored, c.platform), c.order, c.platform, c.implemented), c.name).toEqual(c.full);
  });
});

function controllerWith(navItems: NavItem[] | null | undefined, places: DesktopPlaces | null | "absent" = null) {
  const server = new FakeServer();
  const me = server.addUser("alice");
  const store = new Store();
  store.setMe({ ...me, nav_items: navItems, desktop_places: places === "absent" ? undefined : places } as unknown as UserMe);
  const setNavItems = vi.fn(async (list: NavItem[] | null) => {
    store.setMe({ ...store.me!, nav_items: list });
    return true;
  });
  const setDesktopPlaces = vi.fn(async (value: DesktopPlaces | null) => {
    store.setMe({ ...store.me!, desktop_places: value });
    return true;
  });
  const controller = { store, engine: null, me, isGuest: false, isAdmin: false, version: 0, subscribe: () => () => {}, setNavItems, setDesktopPlaces } as unknown as AppController;
  return { store, controller, setNavItems, setDesktopPlaces };
}

const noop = () => {};
/** 2026-10-12: the menu items are places: icons in the rail (MOBILE_UI.md §18) or rows near the sidebar's top (§18.2). */
function menuLabels(): string[] {
  const rail = screen.getByRole("navigation", { name: "場所" });
  return [...rail.querySelectorAll<HTMLElement>("button[data-nav-item]")].map((button) => button.getAttribute("aria-label") ?? "");
}
function rowKeys(): string[] {
  return [...document.querySelectorAll<HTMLElement>("[data-sidebar-places] button[data-nav-item]")].map((button) => button.dataset.navItem!);
}

describe("the sidebar", () => {
  const handlers = { onThreads: noop, onActivity: noop, onFiles: noop, onCanvases: noop, onCalendar: noop, onTasks: noop, onDeadlines: noop, onSaved: noop };

  it("not customised: スレッド a sidebar row, the others in the rail, in the default order", () => {
    const { controller } = controllerWith(null);
    render(<Sidebar controller={controller} channels={[]} currentId={null} unreadOnly={false} onToggleUnreadOnly={noop} onOpen={noop} onNewDm={noop} onNewChannel={noop} {...handlers} />);
    expect(menuLabels()).toEqual(["メンション", "ファイル", "キャンバス", "カレンダー", "タスク", "締切", "保存済み"]);
    expect(rowKeys()).toEqual(["threads"]);
  });

  it("my order; a phone-hidden item (visible false) still shows here (2026-10-12); a key it does not know is skipped", () => {
    const { controller, store } = controllerWith([
      { key: "saved", visible: true },
      { key: "some-future-page", visible: true },
      { key: "files", visible: false },
      { key: "canvases", visible: false },
      { key: "threads", visible: true },
    ], { rail: true, items: [{ key: "threads", place: "rail" }, { key: "canvases", place: "hidden" }] });
    store.setThreadSummary({ unread_count: 3, mention_count: 0 });
    render(<Sidebar controller={controller} channels={[]} currentId={null} unreadOnly={false} onToggleUnreadOnly={noop} onOpen={noop} onNewDm={noop} onNewChannel={noop} {...handlers} />);
    expect(menuLabels()).toEqual(["保存済み", "ファイル", "スレッド", "メンション", "カレンダー", "タスク", "締切"]);
    // A moved item keeps its badge.
    expect(screen.getByRole("button", { name: "スレッド" }).textContent).toContain("3");
  });

  it("sidebarNavKeys: reservations (M112) after 締切; no Times feed here", () => {
    expect(sidebarNavKeys(null)).toContain("reservations");
    expect(sidebarNavKeys(null).indexOf("reservations")).toBe(sidebarNavKeys(null).indexOf("deadlines") + 1);
    expect(sidebarNavKeys(null)).not.toContain("times-feed");
  });
});

describe("the settings", () => {
  const rows = () => screen.getAllByRole("listitem").map((li) => li.getAttribute("data-nav-item"));
  const where = (item: string) => screen.getByRole("combobox", { name: `${item} の置き場所` }) as HTMLSelectElement;

  it("lists this client's items in my order with where each goes (not the phones' visibility)", () => {
    const { controller } = controllerWith([{ key: "calendar", visible: false }], { rail: true, items: [{ key: "files", place: "hidden" }] });
    render(<NavItemsSettings controller={controller} />);
    expect(rows()).toEqual(["calendar", "threads", "activity", "drafts", "reminders", "files", "canvases", "docs", "tasks", "deadlines", "reservations", "saved"]);
    expect(where("カレンダー").value).toBe("rail");
    expect(where("スレッド").value).toBe("sidebar");
    expect(where("下書き").value).toBe("sidebar");
    expect(where("ファイル").value).toBe("hidden");
    expect(screen.queryByRole("switch", { name: "カレンダー を表示" })).toBeNull();
    expect((screen.getByRole("switch", { name: "アイコン列を使う" }) as HTMLInputElement).checked).toBe(true);
  });

  it("a choice saves desktop_places only; the phones' list (nav_items) is left alone", () => {
    const { controller, setNavItems, setDesktopPlaces } = controllerWith([{ key: "times-feed", visible: false }, { key: "polls", visible: true }], { rail: true, items: [{ key: "future", place: "rail" }] });
    render(<NavItemsSettings controller={controller} />);
    fireEvent.change(where("ファイル"), { target: { value: "sidebar" } });
    expect(setDesktopPlaces).toHaveBeenLastCalledWith({ rail: true, items: [{ key: "future", place: "rail" }, { key: "files", place: "sidebar" }] });
    fireEvent.click(screen.getByRole("switch", { name: "アイコン列を使う" }));
    expect(setDesktopPlaces).toHaveBeenLastCalledWith({ rail: false, items: [{ key: "future", place: "rail" }] });
    expect(setNavItems).not.toHaveBeenCalled();
  });

  it("↑ / ↓ and drag reorder; 元に戻す puts back the order (the phones' hidden tiles kept) and the placement", () => {
    const { controller, setNavItems, setDesktopPlaces } = controllerWith(null);
    render(<NavItemsSettings controller={controller} />);
    expect((screen.getByRole("button", { name: "元に戻す" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "保存済み を上へ" }));
    let saved = setNavItems.mock.calls.at(-1)![0]!;
    expect(shownNavItems(saved).map((item) => item.key).slice(-2)).toEqual(["saved", "reservations"]);
    cleanup();
    render(<NavItemsSettings controller={controller} />);
    const items = screen.getAllByRole("listitem");
    const dataTransfer = { effectAllowed: "" };
    fireEvent.dragStart(items.find((li) => li.getAttribute("data-nav-item") === "tasks")!, { dataTransfer });
    fireEvent.dragOver(items[0]!, { dataTransfer });
    fireEvent.drop(items[0]!, { dataTransfer });
    saved = setNavItems.mock.calls.at(-1)![0]!;
    expect(shownNavItems(saved).map((item) => item.key).slice(0, 2)).toEqual(["tasks", "threads"]);
    fireEvent.click(screen.getByRole("button", { name: "元に戻す" }));
    expect(setNavItems.mock.calls.at(-1)![0]).toBeNull();
    // A phone hid a tile: the order goes back, the tile stays hidden there; the placement resets too.
    cleanup();
    const other = controllerWith([{ key: "files", visible: false }, { key: "threads", visible: true }], { rail: false, items: [] });
    render(<NavItemsSettings controller={other.controller} />);
    fireEvent.click(screen.getByRole("button", { name: "元に戻す" }));
    const back = other.setNavItems.mock.calls.at(-1)![0]!;
    expect(back.map((item) => item.key)).toEqual(NAV_ORDER.desktop);
    expect(back.find((item) => item.key === "files")).toEqual({ key: "files", visible: false });
    expect(other.setDesktopPlaces).toHaveBeenLastCalledWith(null);
    expect(setDesktopPlaces).not.toHaveBeenCalled();
  });

  it("resetNavOrder: null when nothing but the order was chosen", () => {
    expect(resetNavOrder(fullNavItems([{ key: "saved", visible: true }]))).toBeNull();
    expect(resetNavOrder(fullNavItems([{ key: "x-new", visible: true }]))!.at(-1)).toEqual({ key: "x-new", visible: true });
  });

  it("a server without desktop_places: the order only, no placement", () => {
    const { controller } = controllerWith(null, "absent");
    render(<NavItemsSettings controller={controller} />);
    expect(screen.queryByRole("combobox", { name: "ファイル の置き場所" })).toBeNull();
    expect(screen.queryByRole("switch", { name: "アイコン列を使う" })).toBeNull();
    expect(screen.getByRole("button", { name: "ファイル を上へ" })).toBeTruthy();
  });

  it("a server before M111 (no nav_items): no such setting", () => {
    const { controller } = controllerWith(undefined);
    const { container } = render(<NavItemsSettings controller={controller} />);
    expect(container.textContent).toBe("");
  });
});
