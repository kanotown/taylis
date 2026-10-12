// @vitest-environment jsdom
/**
 * The places rail (2026-10-12, docs/MOBILE_UI.md §18): the sidebar's menu items as icons left of the conversation list.
 * What fits the rail's height, what goes under 「その他」, badges, the highlight, the one tab stop and the arrow keys; where
 * each place stands (UserMe.desktop_places: rail / sidebar rows / hidden, and hiding the rail), saved apart from the
 * phones' nav_items; 下書き and リマインダー where I put them even while empty; and that every page the sidebar used to list
 * is still one click or two away.
 */
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { Bell, Files } from "lucide-react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { UserMe } from "../src/api/types";
import type { AppController } from "../src/state/app";
import { Store } from "../src/sync/store";
import { chosenSpot, defaultSpot, type DesktopPlaces, type PlaceSpot, railShown, shownSpot, withRail, withSpot } from "../src/ui/desktopPlaces";
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
const spots = (map: Record<string, PlaceSpot>, fallback: PlaceSpot = "rail") => (key: string) => map[key] ?? fallback;

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

  it("railLayout: the rail's places in my order, the first `fit`; the hidden and the overflow under 「その他」; sidebar rows in neither", () => {
    const places = ["a", "b", "c", "d", "e"].map((key) => place(key));
    const { rail, more } = railLayout(places, spots({ b: "hidden", c: "sidebar" }), 2);
    expect(rail.map((p) => p.key)).toEqual(["a", "d"]);
    expect(more.map((p) => p.key)).toEqual(["b", "e"]);
  });

  it("strongestBadge: red beats neutral, none without badges", () => {
    expect(strongestBadge([place("a")])).toBeNull();
    expect(strongestBadge([place("a", { badge: { text: "2", tone: "neutral" } })])).toBe("neutral");
    expect(strongestBadge([place("a", { badge: { text: "2", tone: "neutral" } }), place("b", { badge: { text: "1", tone: "danger" } })])).toBe("danger");
  });

  it("desktopPlaces: スレッド and 下書き default to the sidebar; a choice wins; the rail hidden turns its places into sidebar rows", () => {
    expect(defaultSpot("threads")).toBe("sidebar");
    expect(defaultSpot("drafts")).toBe("sidebar");
    expect(defaultSpot("files")).toBe("rail");
    expect(defaultSpot("my-times")).toBe("rail");
    const stored: DesktopPlaces = { rail: true, items: [{ key: "files", place: "hidden" }, { key: "threads", place: "rail" }, { key: "future", place: "rail" }] };
    expect(chosenSpot(stored, "files")).toBe("hidden");
    expect(chosenSpot(stored, "threads")).toBe("rail");
    expect(chosenSpot(null, "threads")).toBe("sidebar");
    expect(railShown(null)).toBe(true);
    expect(railShown(undefined)).toBe(true);
    const off = withRail(stored, false);
    expect(off).toEqual({ rail: false, items: stored.items });
    expect(shownSpot(off, "threads")).toBe("sidebar");
    expect(shownSpot(off, "files")).toBe("hidden");
    expect(shownSpot(off, "calendar")).toBe("sidebar");
    // A change keeps the other items (unknown keys too) in their place, and adds a new one at the end.
    expect(withSpot(stored, "threads", "hidden").items).toEqual([{ key: "files", place: "hidden" }, { key: "threads", place: "hidden" }, { key: "future", place: "rail" }]);
    expect(withSpot(null, "saved", "sidebar")).toEqual({ rail: true, items: [{ key: "saved", place: "sidebar" }] });
  });
});

describe("the rail", () => {
  const rail = () => screen.getByRole("navigation", { name: "場所" });
  const railKeys = () => [...rail().querySelectorAll<HTMLElement>("button[data-nav-item]")].map((b) => b.dataset.navItem);
  const openMore = async () => {
    fireEvent.keyDown(within(rail()).getByRole("button", { name: "その他" }), { key: "Enter" });
    return screen.findByRole("menu");
  };

  it("the rail's icons with their names, badges and the open one highlighted; the hidden ones under 「その他」", async () => {
    const files = place("files", { label: "ファイル" });
    const places = [
      place("threads", { label: "スレッド", badge: { text: "3", tone: "neutral" }, active: true }),
      place("activity", { label: "アクティビティ", icon: <Bell size={20} />, ariaLabel: "アクティビティ（未読 2）", badge: { text: "2", tone: "danger" } }),
      files,
      place("saved", { label: "保存済み", count: 4 }),
      place("drafts", { label: "下書き" }),
    ];
    render(<PlacesRail places={places} spotOf={spots({ files: "hidden", drafts: "sidebar" })} onPlace={vi.fn()} />);
    expect(railKeys()).toEqual(["threads", "activity", "saved"]);
    const threads = within(rail()).getByRole("button", { name: "スレッド" });
    expect(threads.getAttribute("aria-current")).toBe("page");
    expect(threads.className).toContain("bg-sidebar-active");
    expect(threads.querySelector("[data-badge]")!.textContent).toBe("3");
    expect(threads.querySelector("[data-badge]")!.getAttribute("data-badge")).toBe("neutral");
    const activity = within(rail()).getByRole("button", { name: "アクティビティ（未読 2）" });
    expect(activity.getAttribute("aria-current")).toBeNull();
    expect(activity.querySelector('[data-badge="danger"]')!.textContent).toBe("2");
    // 「その他」 holds the hidden one (not the sidebar row) and opens it.
    const menu = await openMore();
    const items = within(menu).getAllByRole("menuitem").filter((item) => item.hasAttribute("data-nav-item"));
    expect(items.map((item) => item.dataset.navItem)).toEqual(["files"]);
    fireEvent.click(items[0]!);
    expect(files.onSelect).toHaveBeenCalledTimes(1);
  });

  it("an icon names itself in a tooltip on keyboard focus, also with 「新しいタブで開く」 around it (2026-10-12: the tabs' menu ate the tooltip)", async () => {
    vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} }); // the tooltip's placement
    const places = [place("threads", { label: "スレッド", hint: "フォロー中のスレッド" }), place("saved", { label: "保存済み" })];
    render(<PlacesRail places={places} spotOf={spots({})} onPlace={vi.fn()} onNewTab={vi.fn()} />);
    const threads = within(rail()).getByRole("button", { name: "スレッド" });
    act(() => threads.focus());
    const tip = await screen.findByRole("tooltip");
    expect(tip.textContent).toContain("スレッド");
    vi.unstubAllGlobals();
  });

  it("a short window: the icons that do not fit go under 「その他」, which then carries their badge and highlight", async () => {
    vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(16 + 2 * RAIL_ITEM_PITCH + 2 * RAIL_ITEM_PITCH);
    const places = [place("a"), place("b"), place("c", { badge: { text: "1", tone: "danger" } }), place("d", { active: true })];
    render(<PlacesRail places={places} spotOf={spots({})} onPlace={vi.fn()} />);
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
    render(<PlacesRail places={places} spotOf={spots({})} onPlace={vi.fn()} />);
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

  it("「項目の配置」: each place's submenu アイコン列 / サイドバー / 表示しない, hiding the rail, 並べ替え…; none without the setting", async () => {
    const onPlace = vi.fn();
    const onHideRail = vi.fn();
    const onArrange = vi.fn();
    const view = render(<PlacesRail places={[place("a", { label: "エー" }), place("b", { label: "ビー" })]} spotOf={spots({ b: "sidebar" })} onPlace={onPlace} onHideRail={onHideRail} onArrange={onArrange} />);
    fireEvent.keyDown(within(rail()).getByRole("button", { name: "項目の配置" }), { key: "Enter" });
    const menu = await screen.findByRole("menu");
    const rows = [...menu.querySelectorAll<HTMLElement>("[data-place-item]")];
    expect(rows.map((row) => [row.dataset.placeItem, row.dataset.spot, row.textContent])).toEqual([["a", "rail", "エーアイコン列›"], ["b", "sidebar", "ビーサイドバー›"]]);
    fireEvent.click(rows[1]!);
    const sub = await screen.findAllByRole("menu").then((menus) => menus.at(-1)!);
    const radios = within(sub).getAllByRole("menuitemradio");
    expect(radios.map((radio) => [radio.textContent!.replace("✓", ""), radio.getAttribute("aria-checked")])).toEqual([["アイコン列", "false"], ["サイドバー", "true"], ["表示しない", "false"]]);
    fireEvent.click(radios[2]!);
    expect(onPlace).toHaveBeenLastCalledWith("b", "hidden");
    view.unmount();
    render(<PlacesRail places={[place("a", { label: "エー" })]} spotOf={spots({})} onPlace={onPlace} onHideRail={onHideRail} onArrange={onArrange} />);
    fireEvent.keyDown(within(rail()).getByRole("button", { name: "項目の配置" }), { key: "Enter" });
    fireEvent.click(within(await screen.findByRole("menu")).getByRole("menuitem", { name: "アイコン列を隠す" }));
    expect(onHideRail).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(within(rail()).getByRole("button", { name: "項目の配置" }), { key: "Enter" });
    fireEvent.click(within(await screen.findByRole("menu")).getByRole("menuitem", { name: "並べ替え…" }));
    expect(onArrange).toHaveBeenCalledTimes(1);
    cleanup();
    render(<PlacesRail places={[place("a")]} spotOf={spots({})} />);
    expect(within(rail()).queryByRole("button", { name: "項目の配置" })).toBeNull();
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
  const draw = (controller: AppController, h: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
    render(<Sidebar controller={controller} channels={[]} currentId={null} unreadOnly={false} onToggleUnreadOnly={noop} onOpen={noop} onNewDm={noop} onNewChannel={noop} {...h} {...extra} />);
  const railOf = () => screen.getByRole("navigation", { name: "場所" });
  const railKeys = () => [...railOf().querySelectorAll<HTMLElement>("button[data-nav-item]")].map((b) => b.dataset.navItem!);
  const rowKeys = () => [...document.querySelectorAll<HTMLElement>("[data-sidebar-places] button[data-nav-item]")].map((b) => b.dataset.navItem!);

  it("every page the sidebar listed is in the rail, a sidebar row or under 「その他」, and opens from there", async () => {
    const { controller } = controllerWith(null, { rail: true, items: [{ key: "files", place: "hidden" }, { key: "docs", place: "hidden" }, { key: "saved", place: "sidebar" }] });
    const h = handlers();
    draw(controller, h);
    const inRail = [...railOf().querySelectorAll<HTMLElement>("button[data-nav-item]")];
    // 2026-10-12: 下書き / リマインダー stand where they are put even while empty; スレッド and 下書き are rows by default.
    expect(inRail.map((b) => b.dataset.navItem)).toEqual(["activity", "reminders", "canvases", "calendar", "tasks", "deadlines", "reservations"]);
    expect(rowKeys()).toEqual(["threads", "drafts", "saved"]);
    for (const button of inRail) fireEvent.click(button);
    const rows = [...document.querySelectorAll<HTMLElement>("[data-sidebar-places] button[data-nav-item]")];
    for (const button of rows) fireEvent.click(button);
    fireEvent.keyDown(within(railOf()).getByRole("button", { name: "その他" }), { key: "Enter" });
    const menu = await screen.findByRole("menu");
    const more = within(menu).getAllByRole("menuitem").filter((item) => item.dataset.navItem);
    expect(more.map((item) => item.dataset.navItem)).toEqual(["files", "docs"]);
    expect(new Set([...inRail, ...rows, ...more].map((el) => el.dataset.navItem))).toEqual(new Set(DESKTOP_NAV_KEYS));
    fireEvent.click(more[0]!);
    for (const key of [...inRail.map((b) => b.dataset.navItem!), ...rowKeys(), "files"]) expect(h[handlerOf[key]!], key).toHaveBeenCalledTimes(1);
    // The rows sit under ⌘K / 未読, before the sections.
    const list = screen.getByRole("navigation", { name: "チャンネルとDM" });
    const places = list.querySelector("[data-sidebar-places]")!;
    expect(places.previousElementSibling!.textContent).toContain("未読");
    expect(within(list).getByRole("button", { name: "スレッド" })).toBeTruthy();
  });

  it("pinned 下書き / リマインダー stay in the rail while empty, with a badge once they hold something (red for a fired reminder)", () => {
    const { store, controller } = controllerWith(null, { rail: true, items: [{ key: "drafts", place: "rail" }] });
    draw(controller, handlers());
    expect(railKeys()).toContain("drafts");
    expect(railKeys()).toContain("reminders");
    expect(within(railOf()).getByRole("button", { name: "下書き" }).querySelector("[data-badge]")).toBeNull();
    expect(within(railOf()).getByRole("button", { name: "リマインダー" }).querySelector("[data-badge]")).toBeNull();
    cleanup();
    store.setDraft("c1", null, { text: "書きかけ", attachments: [] });
    store.applyReminder({ id: "r1", status: "pending" } as never);
    draw(controller, handlers());
    expect(within(railOf()).getByRole("button", { name: "下書き" }).querySelector('[data-badge="neutral"]')!.textContent).toBe("1");
    expect(within(railOf()).getByRole("button", { name: "リマインダー" }).querySelector('[data-badge="neutral"]')!.textContent).toBe("1");
    cleanup();
    store.applyReminder({ id: "r2", status: "fired" } as never);
    draw(controller, handlers());
    expect(within(railOf()).getByRole("button", { name: "リマインダー" }).querySelector('[data-badge="danger"]')!.textContent).toBe("1");
  });

  it("badges: threads (red with a mention) on its sidebar row; the open place highlighted", () => {
    const { store, controller } = controllerWith(null);
    store.setThreadSummary({ unread_count: 4, mention_count: 1 });
    draw(controller, handlers(), { threadsActive: true });
    const threads = document.querySelector<HTMLElement>("[data-sidebar-places] [data-nav-item=threads]")!;
    expect(threads.textContent).toContain("4");
    expect(threads.getAttribute("aria-current")).toBe("page");
    expect(threads.className).toContain("font-semibold");
  });

  it("placing from the rail saves desktop_places (synced, mine) and leaves the phones' nav_items alone", async () => {
    const { controller, setNavItems, setDesktopPlaces } = controllerWith([{ key: "calendar", visible: false }]);
    draw(controller, handlers());
    // The phones hid カレンダー: the desktop still shows it (2026-10-12: decoupled).
    expect(railKeys()).toContain("calendar");
    fireEvent.keyDown(within(railOf()).getByRole("button", { name: "項目の配置" }), { key: "Enter" });
    const menu = await screen.findByRole("menu");
    fireEvent.click(menu.querySelector<HTMLElement>("[data-place-item=calendar]")!);
    const sub = (await screen.findAllByRole("menu")).at(-1)!;
    fireEvent.click(within(sub).getByRole("menuitemradio", { name: "サイドバー" }));
    expect(setDesktopPlaces).toHaveBeenLastCalledWith({ rail: true, items: [{ key: "calendar", place: "sidebar" }] });
    expect(setNavItems).not.toHaveBeenCalled();
    cleanup();
    draw(controller, handlers());
    expect(railKeys()).not.toContain("calendar");
    expect(rowKeys()).toEqual(["calendar", "threads", "drafts"]); // in my order (nav_items: カレンダー first)
  });

  it("the rail hidden: no rail, its places are sidebar rows, 「その他」 holds the hidden ones and shows the rail again", async () => {
    const { controller, setDesktopPlaces } = controllerWith(null, { rail: false, items: [{ key: "files", place: "hidden" }] });
    const h = handlers();
    draw(controller, h, { onArrangePlaces: vi.fn() });
    expect(screen.queryByRole("navigation", { name: "場所" })).toBeNull();
    expect(rowKeys()).toEqual(DESKTOP_NAV_KEYS.filter((key) => key !== "files"));
    fireEvent.keyDown(document.querySelector<HTMLElement>("[data-sidebar-more]")!, { key: "Enter" });
    const menu = await screen.findByRole("menu");
    const hidden = within(menu).getAllByRole("menuitem").filter((item) => item.dataset.navItem);
    expect(hidden.map((item) => item.dataset.navItem)).toEqual(["files"]);
    fireEvent.click(within(menu).getByRole("menuitem", { name: "アイコン列を表示" }));
    expect(setDesktopPlaces).toHaveBeenLastCalledWith({ rail: true, items: [{ key: "files", place: "hidden" }] });
  });

  it("hiding the rail from its menu saves rail: false", async () => {
    const { controller, setDesktopPlaces } = controllerWith(null);
    draw(controller, handlers());
    fireEvent.keyDown(within(railOf()).getByRole("button", { name: "項目の配置" }), { key: "Enter" });
    fireEvent.click(within(await screen.findByRole("menu")).getByRole("menuitem", { name: "アイコン列を隠す" }));
    expect(setDesktopPlaces).toHaveBeenLastCalledWith({ rail: false, items: [] });
  });

  it("a server without desktop_places: the defaults, no customise menu", () => {
    const { controller } = controllerWith(null, "absent");
    draw(controller, handlers());
    expect(rowKeys()).toEqual(["threads", "drafts"]);
    expect(within(railOf()).queryByRole("button", { name: "項目の配置" })).toBeNull();
    act(() => {});
  });
});
