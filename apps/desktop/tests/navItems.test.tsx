// @vitest-environment jsdom
/**
 * M111 「サイドバーの項目」: my sidebar's menu items (UserMe.nav_items). The catalogue and the rule against
 * apps/shared/nav-items.json, the sidebar drawing my order without the hidden ones (badges kept), and the settings'
 * switches, ↑ / ↓, drag and 「元に戻す」.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { UserMe } from "../src/api/types";
import type { AppController } from "../src/state/app";
import { Store } from "../src/sync/store";
import { fullNavItems, NAV_CATALOGUE, NAV_ORDER, type NavItem, type NavPlatform, reorderNavItems, shownNavItems, sidebarNavKeys } from "../src/ui/navItems";
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

function controllerWith(navItems: NavItem[] | null | undefined) {
  const server = new FakeServer();
  const me = server.addUser("alice");
  const store = new Store();
  store.setMe({ ...me, nav_items: navItems } as unknown as UserMe);
  const setNavItems = vi.fn(async (list: NavItem[] | null) => {
    store.setMe({ ...store.me!, nav_items: list });
    return true;
  });
  const controller = { store, engine: null, me, isGuest: false, isAdmin: false, version: 0, subscribe: () => () => {}, setNavItems } as unknown as AppController;
  return { store, controller, setNavItems };
}

const noop = () => {};
function menuLabels(): string[] {
  const list = screen.getByText("スレッド").closest("ul")!;
  return within(list).getAllByRole("button").map((button) => button.querySelector("span.flex-1")?.textContent ?? "");
}

describe("the sidebar", () => {
  const handlers = { onThreads: noop, onActivity: noop, onFiles: noop, onCanvases: noop, onCalendar: noop, onTasks: noop, onDeadlines: noop, onSaved: noop };

  it("not customised: every item in the default order", () => {
    const { controller } = controllerWith(null);
    render(<Sidebar controller={controller} channels={[]} currentId={null} unreadOnly={false} onToggleUnreadOnly={noop} onOpen={noop} onNewDm={noop} onNewChannel={noop} {...handlers} />);
    expect(menuLabels()).toEqual(["スレッド", "メンション", "ファイル", "キャンバス", "カレンダー", "タスク", "締切", "保存済み"]);
  });

  it("my order, without the hidden ones; a key it does not know is skipped", () => {
    const { controller, store } = controllerWith([
      { key: "saved", visible: true },
      { key: "some-future-page", visible: true },
      { key: "files", visible: false },
      { key: "canvases", visible: false },
      { key: "threads", visible: true },
    ]);
    store.setThreadSummary({ unread_count: 3, mention_count: 0 });
    render(<Sidebar controller={controller} channels={[]} currentId={null} unreadOnly={false} onToggleUnreadOnly={noop} onOpen={noop} onNewDm={noop} onNewChannel={noop} {...handlers} />);
    expect(menuLabels()).toEqual(["保存済み", "スレッド", "メンション", "カレンダー", "タスク", "締切"]);
    // A moved item keeps its badge.
    expect(screen.getByText("スレッド").closest("button")!.textContent).toContain("3");
  });

  it("sidebarNavKeys: reservations (M112) after 締切; no Times feed here", () => {
    expect(sidebarNavKeys(null)).toContain("reservations");
    expect(sidebarNavKeys(null).indexOf("reservations")).toBe(sidebarNavKeys(null).indexOf("deadlines") + 1);
    expect(sidebarNavKeys(null)).not.toContain("times-feed");
  });
});

describe("the settings", () => {
  const rows = () => screen.getAllByRole("listitem").map((li) => li.getAttribute("data-nav-item"));

  it("lists this client's items in my order with their switch", () => {
    const { controller } = controllerWith([{ key: "calendar", visible: false }]);
    render(<NavItemsSettings controller={controller} />);
    expect(rows()).toEqual(["calendar", "threads", "activity", "drafts", "reminders", "files", "canvases", "tasks", "deadlines", "reservations", "saved"]);
    expect((screen.getByRole("switch", { name: "カレンダー を表示" }) as HTMLInputElement).checked).toBe(false);
    expect((screen.getByRole("switch", { name: "スレッド を表示" }) as HTMLInputElement).checked).toBe(true);
  });

  it("a switch saves the whole list, unknown and other platforms' keys kept", () => {
    const { controller, setNavItems } = controllerWith([{ key: "times-feed", visible: false }, { key: "polls", visible: true }]);
    render(<NavItemsSettings controller={controller} />);
    fireEvent.click(screen.getByRole("switch", { name: "ファイル を表示" }));
    const saved = setNavItems.mock.calls[0]![0]!;
    expect(saved.slice(0, 2)).toEqual([{ key: "times-feed", visible: false }, { key: "polls", visible: true }]);
    expect(saved.find((item) => item.key === "files")).toEqual({ key: "files", visible: false });
    expect(saved.map((item) => item.key)).toContain("reservations");
  });

  it("↑ / ↓ and drag reorder; 元に戻す sends null", () => {
    const { controller, setNavItems } = controllerWith(null);
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
  });

  it("a server before M111 (no nav_items): no such setting", () => {
    const { controller } = controllerWith(undefined);
    const { container } = render(<NavItemsSettings controller={controller} />);
    expect(container.textContent).toBe("");
  });
});
