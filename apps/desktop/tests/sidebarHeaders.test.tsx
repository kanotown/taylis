// @vitest-environment jsdom
/**
 * 2026-10-12 (docs/MOBILE_UI.md §18.9, TIMES_FEED.md §7): the sidebar's section headers. At most one primary icon (＋)
 * and one ⋯ menu each, shown on hover / focus (always on touch); 「チャンネルを追加」 (the channel section's ＋ and its
 * last row) offers 探す / 作成, a guest neither; the Times section stands above 「チャンネル」 by default and moves (⋯
 * 上へ / 下へ, or its header dragged), kept in UserMe.desktop_places.times_before.
 */
import { act, cleanup, createEvent, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { SidebarSectionOut, UserMe } from "../src/api/types";
import type { AppController } from "../src/state/app";
import { Store } from "../src/sync/store";
import type { ChannelState } from "../src/sync/types";
import { type DesktopPlaces, placesChosen, timesAnchor, timesAnchorAt, timesAnchorMoved, withDefaultPlaces, withRail, withSpot, withTimesBefore, withTimesPlaced } from "../src/ui/desktopPlaces";
import { SECTION_DRAG, Sidebar } from "../src/ui/Sidebar";

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.restoreAllMocks();
});

const ME = "u-me";

function channel(over: Partial<ChannelState>): ChannelState {
  return {
    id: "c1", name: "general", type: "public", topic: null, archived: false, isMember: true, syncedSeq: 0, lastSeq: 0, lastReadSeq: 0,
    unreadCount: 0, mentionCount: 0, firstUnreadAt: null, notificationLevel: null, mutedUntil: null, muted: false,
    membership: { role: "member" }, dm_user_ids: null, times_owner_id: null,
    ...over,
  } as unknown as ChannelState;
}

const section = (id: string, name: string, position: number): SidebarSectionOut =>
  ({ id, name, emoji: null, collapsed: false, position, channel_ids: [], sort: "name", manual_order: [] });

/** `places`: the stored desktop_places ("old server": a server without it). */
function draw({ places = null, guest = false, custom = [] as SidebarSectionOut[], myTimes = false }: { places?: DesktopPlaces | null | "old server"; guest?: boolean; custom?: SidebarSectionOut[]; myTimes?: boolean } = {}) {
  const store = new Store();
  const me = { id: ME, username: "me", display_name: "わたし", role: guest ? "guest" : "member", nav_items: null, ...(places === "old server" ? {} : { desktop_places: places }) };
  store.setMe(me as unknown as UserMe);
  store.upsertChannel(channel({ id: "c1", name: "general" }) as never, { isMember: true, syncedSeq: 0, oldestLoadedSeq: 0 });
  store.upsertChannel(channel({ id: "t1", name: "times-bob", times_owner_id: "u-bob" }) as never, { isMember: true, syncedSeq: 0, oldestLoadedSeq: 0 });
  if (myTimes) store.upsertChannel(channel({ id: "t2", name: "times-me", times_owner_id: ME }) as never, { isMember: true, syncedSeq: 0, oldestLoadedSeq: 0 });
  store.replaceSidebar(custom);
  const controller = {
    store, engine: null, me: store.me, isGuest: guest, isAdmin: false, version: 0, subscribe: () => () => {},
    toggleFavorite: vi.fn(async () => {}), moveToSection: vi.fn(async () => true), moveSection: vi.fn(async () => true), setSectionCollapsed: vi.fn(async () => true),
    createSection: vi.fn(async () => true), setSectionSort: vi.fn(async () => true),
    // As the real one: the new value at once (the server's answer is the same).
    setDesktopPlaces: vi.fn(async (value: DesktopPlaces | null) => { store.setMe({ ...store.me!, desktop_places: value }); return true; }),
  };
  const handlers = { onNewDm: vi.fn(), onNewChannel: vi.fn(), onBrowse: vi.fn(), onReadAll: vi.fn(), onDirectory: vi.fn(), onTimesFeed: vi.fn(), onCreateTimes: vi.fn() };
  const element = () => (
    <Sidebar controller={controller as unknown as AppController} channels={[...store.channels.values()]} currentId={null} unreadOnly={false} onToggleUnreadOnly={() => {}} onOpen={() => {}} {...handlers} />
  );
  const view = render(element());
  return { store, controller, handlers, rerender: () => view.rerender(element()) };
}

const list = () => screen.getByRole("navigation", { name: "チャンネルとDM" });
/** The sections' titles, top to bottom. */
const order = () => [...list().querySelectorAll("section > h2")].map((h2) => h2.textContent);
const headerOf = (title: string) => [...list().querySelectorAll<HTMLElement>("section > h2")].find((h2) => h2.textContent === title)!;
const sectionOf = (title: string) => headerOf(title).closest("section")!;
const headerButtons = (title: string) => within(headerOf(title)).getAllByRole("button").map((button) => button.getAttribute("aria-label") ?? button.textContent);
const items = (menu: HTMLElement) => within(menu).getAllByRole("menuitem").map((item) => item.textContent?.replace("›", "").trim());

async function openMenu(trigger: HTMLElement) {
  fireEvent.keyDown(trigger, { key: "Enter" });
  await act(async () => {});
  return screen.getByRole("menu");
}
const sectionMenu = (title: string) => openMenu(within(headerOf(title)).getByRole("button", { name: `${title} のメニュー` }));

describe("the section headers: one ＋ and one ⋯", () => {
  it("「チャンネル」: ＋ (チャンネルを追加) and ⋯ with すべて既読にする, 新しいセクション…, 並べ替え", async () => {
    const w = draw();
    expect(headerButtons("チャンネル")).toEqual(["チャンネル", "チャンネルを追加", "チャンネル のメニュー"]);
    const menu = await sectionMenu("チャンネル");
    expect(items(menu)).toEqual(["すべて既読にする", "新しいセクション…", "並べ替え"]);
    fireEvent.click(within(menu).getByRole("menuitem", { name: "すべて既読にする" }));
    expect(w.handlers.onReadAll).toHaveBeenCalledTimes(1);
    fireEvent.click(within(await sectionMenu("チャンネル")).getByRole("menuitem", { name: "新しいセクション…" }));
    await act(async () => {});
    expect(screen.getByRole("dialog", { name: "新しいセクション" })).toBeTruthy();
  });

  it("「ダイレクトメッセージ」: ＋ (new DM) and ⋯ with メンバー一覧 and 並べ替え", async () => {
    const w = draw();
    const buttons = headerButtons("ダイレクトメッセージ");
    expect(buttons).toHaveLength(3);
    expect(buttons[1]).toMatch(/^DM を開始/);
    fireEvent.click(within(headerOf("ダイレクトメッセージ")).getByRole("button", { name: buttons[1]! }));
    expect(w.handlers.onNewDm).toHaveBeenCalledTimes(1);
    const menu = await sectionMenu("ダイレクトメッセージ");
    expect(items(menu)).toEqual(["メンバー一覧", "並べ替え"]);
    fireEvent.click(within(menu).getByRole("menuitem", { name: "メンバー一覧" }));
    expect(w.handlers.onDirectory).toHaveBeenCalledTimes(1);
  });

  it("「Times」: ＋ to make my times (until I have one) and ⋯ with the feed and 上へ / 下へ", async () => {
    const w = draw();
    expect(headerButtons("Times")).toEqual(["Times", "自分の times を作る", "Times のメニュー"]);
    const menu = await sectionMenu("Times");
    expect(items(menu)).toEqual(["Times フィード", "上へ", "下へ"]);
    fireEvent.click(within(menu).getByRole("menuitem", { name: "Times フィード" }));
    expect(w.handlers.onTimesFeed).toHaveBeenCalledTimes(1);
    cleanup();
    draw({ myTimes: true });
    expect(headerButtons("Times")).toEqual(["Times", "Times のメニュー"]);
  });

  it("my own section: only its ⋯ (unchanged)", () => {
    draw({ custom: [section("s1", "研究", 0)] });
    expect(headerButtons("研究")).toEqual(["研究", "研究 のメニュー"]);
  });

  it("the icons show on hover or focus, while a menu is open, and always on a touch screen", () => {
    draw();
    for (const title of ["チャンネル", "Times", "ダイレクトメッセージ"]) {
      const actions = headerOf(title).querySelector("[data-section-actions]")!;
      expect(headerOf(title).className).toContain("group/section");
      for (const name of ["opacity-0", "group-hover/section:opacity-100", "group-focus-within/section:opacity-100", "has-[[data-state=open]]:opacity-100", "pointer-coarse:opacity-100"]) {
        expect(actions.className, `${title} ${name}`).toContain(name);
      }
    }
  });
});

describe("「チャンネルを追加」", () => {
  it("the header's ＋ and the section's last row offer 探す and 作成", async () => {
    const w = draw();
    let menu = await openMenu(within(headerOf("チャンネル")).getByRole("button", { name: "チャンネルを追加" }));
    expect(items(menu)).toEqual(["チャンネルを探す", "チャンネルを作成"]);
    fireEvent.click(within(menu).getByRole("menuitem", { name: "チャンネルを探す" }));
    expect(w.handlers.onBrowse).toHaveBeenCalledTimes(1);
    const lastRow = sectionOf("チャンネル").querySelector<HTMLElement>("[data-add-channel-row]")!;
    expect(lastRow.textContent).toBe("チャンネルを追加");
    menu = await openMenu(lastRow);
    expect(items(menu)).toEqual(["チャンネルを探す", "チャンネルを作成"]);
    fireEvent.click(within(menu).getByRole("menuitem", { name: "チャンネルを作成" }));
    expect(w.handlers.onNewChannel).toHaveBeenCalledTimes(1);
    // No 「チャンネルを探す」 row any more.
    expect(within(sectionOf("チャンネル")).queryByRole("button", { name: "チャンネルを探す" })).toBeNull();
  });

  it("a guest may do neither: no ＋ and no row", () => {
    draw({ guest: true });
    expect(within(sectionOf("チャンネル")).queryByRole("button", { name: "チャンネルを追加" })).toBeNull();
    expect(sectionOf("チャンネル").querySelector("[data-add-channel-row]")).toBeNull();
    expect(headerButtons("チャンネル")).toEqual(["チャンネル", "チャンネル のメニュー"]);
  });
});

describe("where the Times section stands", () => {
  it("by default right above 「チャンネル」, after my own sections (which keep their order)", () => {
    draw();
    expect(order()).toEqual(["Times", "チャンネル", "ダイレクトメッセージ"]);
    cleanup();
    draw({ custom: [section("s1", "研究", 0), section("s2", "授業", 1)] });
    expect(order()).toEqual(["研究", "授業", "Times", "チャンネル", "ダイレクトメッセージ"]);
  });

  it("上へ / 下へ move it one section and keep it in desktop_places.times_before (the rest of the setting kept)", async () => {
    const places: DesktopPlaces = { rail: false, items: [{ key: "files", place: "hidden" }] };
    const w = draw({ places, custom: [section("s1", "研究", 0)] });
    fireEvent.click(within(await sectionMenu("Times")).getByRole("menuitem", { name: "下へ" }));
    expect(w.controller.setDesktopPlaces).toHaveBeenLastCalledWith({ rail: false, items: [{ key: "files", place: "hidden" }], times_before: "dms" });
    w.rerender();
    expect(order()).toEqual(["研究", "チャンネル", "Times", "ダイレクトメッセージ"]);
    fireEvent.click(within(await sectionMenu("Times")).getByRole("menuitem", { name: "下へ" }));
    expect(w.controller.setDesktopPlaces).toHaveBeenLastCalledWith(expect.objectContaining({ times_before: "end" }));
    w.rerender();
    expect(order()).toEqual(["研究", "チャンネル", "ダイレクトメッセージ", "Times"]);
    // At the end: 下へ is off.
    let menu = await sectionMenu("Times");
    expect(within(menu).getByRole("menuitem", { name: "下へ" }).getAttribute("data-disabled")).not.toBeNull();
    fireEvent.keyDown(menu, { key: "Escape" });
    await act(async () => {});
    // Up three times: before 「研究」, the top; 上へ is off there.
    for (let step = 0; step < 3; step += 1) {
      fireEvent.click(within(await sectionMenu("Times")).getByRole("menuitem", { name: "上へ" }));
      w.rerender();
    }
    expect(w.store.me?.desktop_places?.times_before).toBe("s1");
    expect(order()).toEqual(["Times", "研究", "チャンネル", "ダイレクトメッセージ"]);
    menu = await sectionMenu("Times");
    expect(within(menu).getByRole("menuitem", { name: "上へ" }).getAttribute("data-disabled")).not.toBeNull();
    fireEvent.keyDown(menu, { key: "Escape" });
    await act(async () => {});
    // Back to just above 「チャンネル」: stored as the default (null).
    fireEvent.click(within(await sectionMenu("Times")).getByRole("menuitem", { name: "下へ" }));
    expect(w.controller.setDesktopPlaces).toHaveBeenLastCalledWith({ rail: false, items: [{ key: "files", place: "hidden" }], times_before: null });
  });

  it("its header drags onto another section, before or after it (by the pointer's half)", () => {
    const w = draw({ custom: [section("s1", "研究", 0)] });
    expect(headerOf("Times").getAttribute("draggable")).toBe("true");
    const drag = (onto: string, after: boolean) => {
      const data: Record<string, string> = {};
      const dataTransfer = { types: [] as string[], setData: (type: string, value: string) => { data[type] = value; dataTransfer.types.push(type); }, getData: (type: string) => data[type] ?? "", effectAllowed: "", dropEffect: "none" };
      fireEvent.dragStart(headerOf("Times"), { dataTransfer });
      expect(dataTransfer.types).toEqual([SECTION_DRAG]);
      const target = sectionOf(onto);
      vi.spyOn(target, "getBoundingClientRect").mockReturnValue({ top: 100, height: 40, bottom: 140, left: 0, right: 200, width: 200, x: 0, y: 100, toJSON: () => ({}) });
      const at = (event: Event) => { Object.defineProperty(event, "clientY", { value: after ? 130 : 110 }); return event; };
      fireEvent(target, at(createEvent.dragOver(target, { dataTransfer })));
      const edge = target.getAttribute("data-drop-edge");
      fireEvent(target, at(createEvent.drop(target, { dataTransfer })));
      return edge;
    };
    expect(drag("ダイレクトメッセージ", true)).toBe("after");
    expect(w.controller.setDesktopPlaces).toHaveBeenLastCalledWith(expect.objectContaining({ times_before: "end" }));
    w.rerender();
    expect(drag("研究", false)).toBe("before");
    expect(w.controller.setDesktopPlaces).toHaveBeenLastCalledWith(expect.objectContaining({ times_before: "s1" }));
    w.rerender();
    expect(drag("チャンネル", true)).toBe("after");
    expect(w.controller.setDesktopPlaces).toHaveBeenLastCalledWith(expect.objectContaining({ times_before: "dms" }));
    // My own section's header dropped on Times does nothing (they move among themselves).
    expect(w.controller.moveSection).not.toHaveBeenCalled();
  });

  it("follows the stored place on every device; a deleted section's id reads as the default", () => {
    draw({ places: { rail: true, items: [], times_before: "dms" } });
    expect(order()).toEqual(["チャンネル", "Times", "ダイレクトメッセージ"]);
    cleanup();
    draw({ places: { rail: true, items: [], times_before: "gone-section" } });
    expect(order()).toEqual(["Times", "チャンネル", "ダイレクトメッセージ"]);
  });

  it("a server without desktop_places: the default place, no 上へ / 下へ, no dragging", async () => {
    draw({ places: "old server" });
    expect(order()).toEqual(["Times", "チャンネル", "ダイレクトメッセージ"]);
    expect(headerOf("Times").getAttribute("draggable")).toBeNull();
    expect(items(await sectionMenu("Times"))).toEqual(["Times フィード"]);
  });
});

describe("desktopPlaces: the Times anchor", () => {
  const keys = ["favorites", "s1", "channels", "dms"];
  it("places, moves and anchors", () => {
    expect(timesAnchor(null, keys)).toBe("channels");
    expect(timesAnchor({ rail: true, items: [], times_before: "s1" }, keys)).toBe("s1");
    expect(timesAnchor({ rail: true, items: [], times_before: "end" }, keys)).toBe("end");
    expect(timesAnchor({ rail: true, items: [], times_before: "s9" }, keys)).toBe("channels");
    expect(withTimesPlaced(keys, "channels")).toEqual(["favorites", "s1", "times", "channels", "dms"]);
    expect(withTimesPlaced(keys, "end")).toEqual(["favorites", "s1", "channels", "dms", "times"]);
    // お気に入り not drawn (empty): the anchor on it still lands at the top.
    const shown = ["times", "s1", "channels", "dms"];
    expect(timesAnchorMoved(shown, -1)).toBeNull();
    expect(timesAnchorMoved(shown, 1)).toBe("channels");
    expect(timesAnchorMoved(["s1", "channels", "times", "dms"], -1)).toBe("channels");
    expect(timesAnchorMoved(["s1", "channels", "dms", "times"], 1)).toBeNull();
    expect(timesAnchorAt(["s1", "times", "channels", "dms"], "dms", true)).toBe("end");
    expect(timesAnchorAt(["s1", "times", "channels", "dms"], "s1", true)).toBe("channels");
  });

  it("the other setters keep it; 設定の「元に戻す」 resets the places but not it", () => {
    const stored: DesktopPlaces = { rail: true, items: [], times_before: "dms" };
    expect(withSpot(stored, "files", "hidden").times_before).toBe("dms");
    expect(withRail(stored, false).times_before).toBe("dms");
    expect(withTimesBefore(withSpot(null, "files", "rail"), "channels")).toEqual({ rail: true, items: [{ key: "files", place: "rail" }], times_before: null });
    expect(placesChosen(stored)).toBe(false);
    expect(placesChosen(withRail(stored, false))).toBe(true);
    expect(withDefaultPlaces({ rail: false, items: [{ key: "files", place: "hidden" }], times_before: "dms" })).toEqual({ rail: true, items: [], times_before: "dms" });
    expect(withDefaultPlaces({ rail: false, items: [] })).toBeNull();
  });
});
