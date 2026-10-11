// @vitest-environment jsdom
/**
 * The places rail (2026-10-12, docs/MOBILE_UI.md §18): the sidebar's menu items as icons left of the conversation list.
 * What fits the rail's height, what goes under 「その他」, badges, the highlight, the one tab stop and the arrow keys, the
 * customise menu (UserMe.nav_items `visible`), and that every page the sidebar used to list is still one click or two away.
 */
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { Bell, Files } from "lucide-react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { UserMe } from "../src/api/types";
import type { AppController } from "../src/state/app";
import { Store } from "../src/sync/store";
import { DESKTOP_NAV_KEYS, type NavItem } from "../src/ui/navItems";
import { type Place, PlacesRail, RAIL_ITEM_PITCH, railFit, railLayout, strongestBadge } from "../src/ui/PlacesRail";
import { Sidebar } from "../src/ui/Sidebar";
import { FakeServer } from "./fakeServer";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const place = (key: string, over: Partial<Place> = {}): Place => ({ key, label: key, icon: <Files size={20} />, onSelect: vi.fn(), active: false, ...over });

describe("the rules", () => {
  it("railFit: all while not laid out; else as many as fit above 「その他」 and the customise button", () => {
    expect(railFit(12, 0)).toBe(12);
    // 16 px of padding and two controls of 44 px: 600 px hold (600 - 16 - 88) / 44 = 11 icons.
    expect(railFit(12, 600)).toBe(11);
    expect(railFit(5, 600)).toBe(5);
    expect(railFit(12, 16 + 2 * RAIL_ITEM_PITCH + 3 * RAIL_ITEM_PITCH)).toBe(3);
    expect(railFit(12, 50)).toBe(0);
    // Without the customise button (a server without the setting) one more fits.
    expect(railFit(12, 16 + RAIL_ITEM_PITCH + 3 * RAIL_ITEM_PITCH, 1)).toBe(3);
  });

  it("railLayout: pinned and railable in my order, the first `fit`; everything else under 「その他」 in order", () => {
    const places = ["a", "b", "c", "d", "e"].map((key) => place(key, { railable: key !== "c" }));
    const { rail, more } = railLayout(places, new Set(["a", "c", "d", "e"]), 2);
    expect(rail.map((p) => p.key)).toEqual(["a", "d"]);
    expect(more.map((p) => p.key)).toEqual(["b", "c", "e"]);
  });

  it("strongestBadge: red beats neutral, none without badges", () => {
    expect(strongestBadge([place("a")])).toBeNull();
    expect(strongestBadge([place("a", { badge: { text: "2", tone: "neutral" } })])).toBe("neutral");
    expect(strongestBadge([place("a", { badge: { text: "2", tone: "neutral" } }), place("b", { badge: { text: "1", tone: "danger" } })])).toBe("danger");
  });
});

describe("the rail", () => {
  const rail = () => screen.getByRole("navigation", { name: "場所" });
  const railKeys = () => [...rail().querySelectorAll<HTMLElement>("button[data-nav-item]")].map((b) => b.dataset.navItem);
  const openMore = async () => {
    fireEvent.keyDown(within(rail()).getByRole("button", { name: "その他" }), { key: "Enter" });
    return screen.findByRole("menu");
  };

  it("pinned icons with their names, badges and the open one highlighted; the rest under 「その他」", async () => {
    const files = place("files", { label: "ファイル" });
    const places = [
      place("threads", { label: "スレッド", badge: { text: "3", tone: "neutral" }, active: true }),
      place("activity", { label: "アクティビティ", icon: <Bell size={20} />, ariaLabel: "アクティビティ（未読 2）", badge: { text: "2", tone: "danger" } }),
      files,
      place("saved", { label: "保存済み", count: 4 }),
    ];
    render(<PlacesRail places={places} pinned={new Set(["threads", "activity", "saved"])} onTogglePin={vi.fn()} />);
    expect(railKeys()).toEqual(["threads", "activity", "saved"]);
    const threads = within(rail()).getByRole("button", { name: "スレッド" });
    expect(threads.getAttribute("aria-current")).toBe("page");
    expect(threads.className).toContain("bg-sidebar-active");
    expect(threads.querySelector("[data-badge]")!.textContent).toBe("3");
    expect(threads.querySelector("[data-badge]")!.getAttribute("data-badge")).toBe("neutral");
    const activity = within(rail()).getByRole("button", { name: "アクティビティ（未読 2）" });
    expect(activity.getAttribute("aria-current")).toBeNull();
    expect(activity.querySelector('[data-badge="danger"]')!.textContent).toBe("2");
    // 「その他」 holds the unpinned one and opens it.
    const menu = await openMore();
    const items = within(menu).getAllByRole("menuitem").filter((item) => item.hasAttribute("data-nav-item"));
    expect(items.map((item) => item.dataset.navItem)).toEqual(["files"]);
    fireEvent.click(items[0]!);
    expect(files.onSelect).toHaveBeenCalledTimes(1);
  });

  it("a short window: the pinned icons that do not fit go under 「その他」, which then carries their badge and highlight", async () => {
    vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(16 + 2 * RAIL_ITEM_PITCH + 2 * RAIL_ITEM_PITCH);
    const places = [place("a"), place("b"), place("c", { badge: { text: "1", tone: "danger" } }), place("d", { active: true })];
    render(<PlacesRail places={places} pinned={new Set(["a", "b", "c", "d"])} onTogglePin={vi.fn()} />);
    expect(railKeys()).toEqual(["a", "b"]);
    const more = within(rail()).getByRole("button", { name: "その他" });
    expect(more.querySelector('[data-more-badge="danger"]')).toBeTruthy();
    expect(more.className).toContain("bg-sidebar-active");
    const menu = await openMore();
    expect(within(menu).getAllByRole("menuitem").filter((i) => i.dataset.navItem).map((i) => i.dataset.navItem)).toEqual(["c", "d"]);
  });

  it("one tab stop (the open place, else the first); ↑ ↓ Home End move through the icons, 「その他」 and the customise button", () => {
    vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
    const places = [place("a"), place("b", { active: true }), place("c")];
    render(<PlacesRail places={places} pinned={new Set(["a", "b", "c"])} onTogglePin={vi.fn()} />);
    const items = [...rail().querySelectorAll<HTMLElement>("[data-rail-item]")];
    expect(items).toHaveLength(5);
    expect(items.filter((item) => item.tabIndex === 0).map((item) => item.dataset.navItem)).toEqual(["b"]);
    items[1]!.focus();
    fireEvent.keyDown(items[1]!, { key: "ArrowDown" });
    expect(document.activeElement).toBe(items[2]);
    fireEvent.keyDown(items[2]!, { key: "ArrowDown" });
    expect(document.activeElement?.hasAttribute("data-rail-more")).toBe(true);
    fireEvent.keyDown(document.activeElement!, { key: "End" });
    expect(document.activeElement?.hasAttribute("data-rail-customize")).toBe(true);
    fireEvent.keyDown(document.activeElement!, { key: "ArrowDown" });
    expect(document.activeElement).toBe(items[0]);
    fireEvent.keyDown(items[0]!, { key: "ArrowUp" });
    expect(document.activeElement?.hasAttribute("data-rail-customize")).toBe(true);
    fireEvent.keyDown(document.activeElement!, { key: "Home" });
    expect(document.activeElement).toBe(items[0]);
    // Enter / Space are the button's own.
    fireEvent.click(document.activeElement!);
    expect(places[0]!.onSelect).toHaveBeenCalledTimes(1);
  });

  it("the customise menu pins and unpins (and stays open); no menu without the setting", async () => {
    const onTogglePin = vi.fn();
    const onArrange = vi.fn();
    const view = render(<PlacesRail places={[place("a", { label: "エー" }), place("b", { label: "ビー" })]} pinned={new Set(["a"])} onTogglePin={onTogglePin} onArrange={onArrange} />);
    fireEvent.keyDown(within(rail()).getByRole("button", { name: "レールに出す項目" }), { key: "Enter" });
    const menu = await screen.findByRole("menu");
    const boxes = within(menu).getAllByRole("menuitemcheckbox");
    expect(boxes.map((box) => box.getAttribute("aria-checked"))).toEqual(["true", "false"]);
    fireEvent.click(boxes[0]!);
    expect(onTogglePin).toHaveBeenLastCalledWith("a", false);
    fireEvent.click(within(screen.getByRole("menu")).getAllByRole("menuitemcheckbox")[1]!);
    expect(onTogglePin).toHaveBeenLastCalledWith("b", true);
    fireEvent.click(within(screen.getByRole("menu")).getByRole("menuitem", { name: "並べ替え…" }));
    expect(onArrange).toHaveBeenCalledTimes(1);
    view.unmount();
    render(<PlacesRail places={[place("a")]} pinned={new Set(["a"])} />);
    expect(within(rail()).queryByRole("button", { name: "レールに出す項目" })).toBeNull();
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

describe("the sidebar with the rail", () => {
  const noop = () => {};
  const handlers = () => ({
    onThreads: vi.fn(), onActivity: vi.fn(), onDrafts: vi.fn(), onReminders: vi.fn(), onFiles: vi.fn(), onCanvases: vi.fn(), onDocs: vi.fn(),
    onCalendar: vi.fn(), onTasks: vi.fn(), onDeadlines: vi.fn(), onReservations: vi.fn(), onSaved: vi.fn(),
  });
  const handlerOf: Record<string, keyof ReturnType<typeof handlers>> = {
    threads: "onThreads", activity: "onActivity", drafts: "onDrafts", reminders: "onReminders", files: "onFiles", canvases: "onCanvases", docs: "onDocs",
    calendar: "onCalendar", tasks: "onTasks", deadlines: "onDeadlines", reservations: "onReservations", saved: "onSaved",
  };

  it("every page the sidebar listed is in the rail or under 「その他」 and opens from there, hidden or empty ones too", async () => {
    const { controller } = controllerWith([{ key: "files", visible: false }, { key: "docs", visible: false }, { key: "saved", visible: false }]);
    const h = handlers();
    render(<Sidebar controller={controller} channels={[]} currentId={null} unreadOnly={false} onToggleUnreadOnly={noop} onOpen={noop} onNewDm={noop} onNewChannel={noop} {...h} />);
    const rail = screen.getByRole("navigation", { name: "場所" });
    const inRail = [...rail.querySelectorAll<HTMLElement>("button[data-nav-item]")];
    // Nothing in 下書き / リマインダー: not in the rail (as the sidebar rows were), but under 「その他」.
    expect(inRail.map((b) => b.dataset.navItem)).toEqual(["threads", "activity", "canvases", "calendar", "tasks", "deadlines", "reservations"]);
    for (const button of inRail) fireEvent.click(button);
    fireEvent.keyDown(within(rail).getByRole("button", { name: "その他" }), { key: "Enter" });
    const menu = await screen.findByRole("menu");
    const more = within(menu).getAllByRole("menuitem").filter((item) => item.dataset.navItem);
    expect(more.map((item) => item.dataset.navItem)).toEqual(["files", "docs", "saved", "drafts", "reminders"]);
    expect(new Set([...inRail, ...more].map((el) => el.dataset.navItem))).toEqual(new Set(DESKTOP_NAV_KEYS));
    fireEvent.click(more[0]!);
    for (const key of [...inRail.map((b) => b.dataset.navItem!), "files"]) expect(h[handlerOf[key]!], key).toHaveBeenCalledTimes(1);
    // The conversation list itself no longer lists them: it starts with the sections.
    const list = screen.getByRole("navigation", { name: "チャンネルとDM" });
    expect(within(list).queryByRole("button", { name: "スレッド" })).toBeNull();
    expect(list.querySelector("[data-nav-item]")).toBeNull();
  });

  it("badges: threads (red with a mention), activity, fired reminders; drafts in the rail once there is one", () => {
    const { store, controller } = controllerWith(null);
    store.setThreadSummary({ unread_count: 4, mention_count: 1 });
    store.setDraft("c1", null, { text: "書きかけ", attachments: [] });
    render(<Sidebar controller={controller} channels={[]} currentId={null} unreadOnly={false} onToggleUnreadOnly={noop} onOpen={noop} onNewDm={noop} onNewChannel={noop} {...handlers()} threadsActive />);
    const rail = screen.getByRole("navigation", { name: "場所" });
    const threads = within(rail).getByRole("button", { name: "スレッド" });
    expect(threads.querySelector('[data-badge="danger"]')!.textContent).toBe("4");
    expect(threads.getAttribute("aria-current")).toBe("page");
    expect(within(rail).getByRole("button", { name: "下書き" })).toBeTruthy();
  });

  it("unpinning from the customise menu saves the whole list with that item hidden (the settings' switch)", async () => {
    const { controller, setNavItems } = controllerWith(null);
    render(<Sidebar controller={controller} channels={[]} currentId={null} unreadOnly={false} onToggleUnreadOnly={noop} onOpen={noop} onNewDm={noop} onNewChannel={noop} {...handlers()} />);
    const rail = screen.getByRole("navigation", { name: "場所" });
    fireEvent.keyDown(within(rail).getByRole("button", { name: "レールに出す項目" }), { key: "Enter" });
    const menu = await screen.findByRole("menu");
    fireEvent.click(within(menu).getByRole("menuitemcheckbox", { name: "カレンダー" }));
    const saved = setNavItems.mock.calls[0]![0]!;
    expect(saved.find((item) => item.key === "calendar")).toEqual({ key: "calendar", visible: false });
    expect(saved.filter((item) => !item.visible)).toHaveLength(1);
  });
});
