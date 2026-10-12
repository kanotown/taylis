// @vitest-environment jsdom
/**
 * MOBILE_UI.md §19: browser-like tabs on the real MainScreen (wide layout), a real SyncEngine and the fake server —
 * opening in a new tab (a row's menu, a middle click, ⌘-click), switching back to a tab's view / thread / history /
 * scroll position, only the active tab's conversation open in the engine, closing and reordering, the keys, the
 * per-device storage and its restore (targets that are gone dropped), the hidden bar with one tab, 「タブを使う」 off,
 * none on a phone. And the pure rules of desktopTabs.ts.
 */
import { useSyncExternalStore } from "react";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ApiClient } from "../src/api/client";
import type { MessageOut } from "../src/api/types";
import { AppController } from "../src/state/app";
import { COMPACT_QUERY } from "../src/ui/compact";
import { insertTab, moveTab, neighbourOf, nthTab, readStoredTabs, restoreTabs, stepTab, type Tab, tabCommand, type TabTarget } from "../src/ui/desktopTabs";
import { MainScreen } from "../src/ui/MainScreen";
import { clearScrollMemories } from "../src/ui/scrollMemory";
import { world, type World } from "./unreadWorld";

let compact = false;
const env = vi.hoisted(() => ({ web: false }));
vi.mock("../src/platform/env", async (original) => ({ ...(await original<typeof import("../src/platform/env")>()), isWeb: () => env.web }));
const viewRestores = vi.hoisted(() => [] as Array<{ key: string; restore: boolean }>);
vi.mock("../src/ui/viewScrollMemory", async (original) => {
  const real = await original<typeof import("../src/ui/viewScrollMemory")>();
  const useViewScrollMemory: typeof real.useViewScrollMemory = (root, memory, key, restore) =>
    real.useViewScrollMemory(root, memory, key, () => {
      const asked = restore();
      if (key) viewRestores.push({ key, restore: asked });
      return asked;
    });
  return { ...real, useViewScrollMemory };
});

beforeEach(() => {
  clearScrollMemories();
  viewRestores.length = 0;
  compact = false;
  env.web = false;
  localStorage.clear();
  vi.stubGlobal("matchMedia", (query: string) => ({ matches: query === COMPACT_QUERY ? compact : false, addEventListener: () => {}, removeEventListener: () => {} }));
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  vi.spyOn(navigator, "platform", "get").mockImplementation(() => "MacIntel");
  vi.spyOn(document, "hasFocus").mockReturnValue(true);
  HTMLElement.prototype.scrollIntoView = () => {};
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({ x: 0, y: 0, top: 0, left: 0, right: 1400, bottom: 900, width: 1400, height: 900, toJSON: () => ({}) });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function Screen({ w, controller }: { w: World; controller: AppController }) {
  useSyncExternalStore(
    (listener) => {
      const subs = [controller.subscribe(listener), w.store.subscribe(listener), w.engine.subscribe(listener)];
      return () => subs.forEach((unsubscribe) => unsubscribe());
    },
    () => `${controller.version}:${w.store.version}:${w.engine.status}`,
  );
  return <MainScreen controller={controller} />;
}

const flush = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
const settle = async (w: World) => {
  await act(async () => { await w.engine.idle(); });
  await flush();
  await flush();
};

/** Bob in #c (alice's post with one reply, read), #d (two unread posts) and #e. */
async function setup(options: { before?: (w: World, ids: { d: string; e: string }) => void; renderFirst?: boolean } = {}) {
  const w = world({ posts: 1, lastRead: 1 });
  const extra = (name: string) => {
    const channel = w.server.createChannel(name, w.alice.id);
    w.server.join(channel.id, w.bob.id);
    return channel.id;
  };
  const d = extra("d");
  const e = extra("e");
  w.server.post(d, w.alice.id, "d1");
  w.server.post(d, w.alice.id, "d2");
  const parent = w.server.channels.get(w.channelId)!.messages[0]!;
  w.server.post(w.channelId, w.alice.id, "返信", undefined, parent.id);
  w.server.markRead(w.bob.id, w.channelId, 2);
  const inner = w.api as unknown as Record<string, unknown>;
  const getMessage = w.api.getMessage as (id: string) => Promise<MessageOut>;
  const messageContext = async (id: string) => [await getMessage(id)];
  const api = new Proxy<Record<string, unknown>>({ ...inner, messageContext }, { get: (target, key: string) => target[key] ?? (async () => []) }) as unknown as ApiClient;
  // renderFirst: a browser's start, the screen up before the bootstrap (an empty store).
  if (!options.renderFirst) {
    await w.engine.start();
    await w.engine.idle();
  }
  const controller = new AppController();
  (controller as unknown as { active: unknown }).active = { serverUrl: "http://server", username: "bob", api, store: w.store, engine: w.engine, me: w.store.me, leaving: false };
  options.before?.(w, { d, e });
  const view = render(<Screen w={w} controller={controller} />);
  if (options.renderFirst) {
    await settle(w);
    await act(async () => { await w.engine.start(); });
  }
  await settle(w);
  return { w, controller, d, e, parent, view };
}

const sidebar = () => within(screen.getByRole("navigation", { name: "チャンネルとDM" }));
const row = (name: string) => sidebar().getByRole("button", { name: new RegExp(`^${name}`) });
const place = (name: string) => screen.getAllByRole("button", { name }).find((button) => button.hasAttribute("data-nav-item"))!;
const title = () => document.querySelector("main header strong")?.textContent ?? null;
const tabList = () => screen.queryByRole("tablist", { name: "タブ" });
const tabs = () => within(tabList()!).getAllByRole("tab");
const tabNames = () => tabs().map((tab) => tab.textContent);
const activeTab = () => tabs().find((tab) => tab.getAttribute("aria-selected") === "true")?.textContent ?? null;
const backButton = () => within(screen.getByRole("navigation", { name: "履歴" })).getAllByRole("button")[0] as HTMLButtonElement;
const middleClick = (element: Element) => {
  fireEvent.mouseDown(element, { button: 1 });
  fireEvent(element, new MouseEvent("auxclick", { bubbles: true, cancelable: true, button: 1 }));
};
const press = async (w: World, init: KeyboardEventInit) => {
  let event!: KeyboardEvent;
  await act(async () => {
    event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
    window.dispatchEvent(event);
  });
  await settle(w);
  return event;
};
const openInNewTabFromMenu = async (w: World, element: Element) => {
  fireEvent.contextMenu(element);
  fireEvent.click(within(screen.getByRole("menu")).getByRole("menuitem", { name: "新しいタブで開く" }));
  await settle(w);
};

it("one tab: no bar; 「新しいタブで開く」 on a row opens it behind the tab on screen, and the bar appears", async () => {
  const { w } = await setup();
  expect(title()).toBe("c");
  expect(tabList()).toBeNull();
  await openInNewTabFromMenu(w, row("d"));
  expect(title()).toBe("c"); // a background tab, as a browser opens a link in a new tab
  expect(tabNames()).toEqual(["c", "d"]);
  expect(activeTab()).toBe("c");
  // d's tab: unread without a mention is a dot (the sidebar's rule); a mention is a red number.
  expect(tabs()[1]!.querySelector("[data-tab-badge]")?.getAttribute("data-tab-badge")).toBe("dot");
  w.engine.stop();
});

it("a middle click and ⌘-click open in a new tab; ⌘⇧-click brings it to the front; a plain click stays in the tab", async () => {
  const { w } = await setup();
  middleClick(row("d"));
  await settle(w);
  expect(tabs()).toHaveLength(2);
  expect(title()).toBe("c");
  fireEvent.click(row("e"), { metaKey: true });
  await settle(w);
  expect(tabs()).toHaveLength(3);
  // Right of the active tab, the newest first next to it (a browser's order for links opened one after another is
  // after the previous ones; ours: right after the active tab).
  expect(tabNames()).toEqual(["c", "e", "d"]);
  expect(title()).toBe("c");
  fireEvent.click(place("スレッド"), { metaKey: true, shiftKey: true });
  await settle(w);
  expect(activeTab()).toBe("スレッド");
  expect(place("スレッド").getAttribute("aria-current")).toBe("page");
  fireEvent.click(row("e"));
  await settle(w);
  expect(title()).toBe("e");
  expect(activeTab()).toBe("e");
  expect(tabs()).toHaveLength(4);
  w.engine.stop();
});

it("only the active tab's conversation is open: a background tab marks nothing read; switching opens it", async () => {
  const { w, d } = await setup();
  const before = w.calls.reads.length;
  middleClick(row("d"));
  await settle(w);
  expect(w.engine.currentChannelId).toBe(w.channelId);
  expect(w.store.getChannel(d)!.unreadCount).toBe(2);
  expect(screen.queryByText("d1")).toBeNull(); // its timeline is not mounted
  expect(w.calls.reads.length).toBe(before);
  fireEvent.click(tabs()[1]!);
  await settle(w);
  expect(title()).toBe("d");
  expect(w.engine.currentChannelId).toBe(d);
  expect(screen.getByText("d1")).toBeTruthy();
  // The tab on screen shows no badge; c, now behind, has nothing unread.
  expect(document.querySelector("[data-tab-badge]")).toBeNull();
  w.engine.stop();
});

it("each tab keeps its view, its thread pane and its own back / forward; a view comes back where it was scrolled to", async () => {
  const { w } = await setup();
  fireEvent.click(screen.getByRole("button", { name: /1 件の返信/ }));
  await settle(w);
  expect(screen.getByText("返信")).toBeTruthy();
  middleClick(row("d"));
  await settle(w);
  fireEvent.click(tabs()[1]!);
  await settle(w);
  expect(title()).toBe("d");
  expect(screen.queryByText("返信")).toBeNull(); // no thread pane in this tab
  expect(backButton().disabled).toBe(true); // a new tab has a history of its own
  fireEvent.click(row("e"));
  await settle(w);
  fireEvent.click(place("スレッド"));
  await settle(w);
  expect(backButton().disabled).toBe(false);

  fireEvent.click(tabs()[0]!);
  await settle(w);
  expect(title()).toBe("c");
  expect(screen.getByText("返信")).toBeTruthy(); // the thread pane as it was left
  expect(backButton().disabled).toBe(true);

  viewRestores.length = 0;
  fireEvent.click(tabs()[1]!);
  await settle(w);
  expect(place("スレッド").getAttribute("aria-current")).toBe("page");
  expect(viewRestores[0]).toEqual({ key: "view:threads", restore: true });
  fireEvent.click(backButton());
  await settle(w);
  expect(title()).toBe("e");
  fireEvent.click(backButton());
  await settle(w);
  expect(title()).toBe("d");
  w.engine.stop();
});

it("closing: ×, a middle click on a tab, the active one hands over to its right neighbour; the last tab stays", async () => {
  const { w } = await setup();
  middleClick(row("d"));
  middleClick(row("e"));
  await settle(w);
  expect(tabNames()).toEqual(["c", "e", "d"]);
  middleClick(tabs()[1]!.parentElement!);
  await settle(w);
  expect(tabNames()).toEqual(["c", "d"]);
  fireEvent.click(screen.getByRole("button", { name: "c のタブを閉じる" }));
  await settle(w);
  // One tab left: the bar goes, d is on screen.
  expect(tabList()).toBeNull();
  expect(title()).toBe("d");
  w.engine.stop();
});

it("reordering: dragging a tab, and 左へ / 右へ移動 in its menu", async () => {
  const { w } = await setup();
  middleClick(row("d"));
  middleClick(row("e"));
  await settle(w);
  expect(tabNames()).toEqual(["c", "e", "d"]);
  const holder = (index: number) => tabs()[index]!.parentElement!;
  fireEvent.dragStart(holder(0));
  // jsdom's drag events carry no pointer position: the drop lands before the tab it is dropped on.
  fireEvent.dragOver(holder(2));
  fireEvent.drop(holder(2));
  await settle(w);
  expect(tabNames()).toEqual(["e", "c", "d"]);
  fireEvent.contextMenu(holder(2));
  fireEvent.click(within(screen.getByRole("menu")).getByRole("menuitem", { name: "左へ移動" }));
  await settle(w);
  expect(tabNames()).toEqual(["e", "d", "c"]);
  expect(activeTab()).toBe("c");
  w.engine.stop();
});

it("the keys: ⌘T, ⌘W, ⌘⇧[ / ], Ctrl+Tab, ⌘1 / ⌘9; with one tab ⌘W and ⌘1 are left alone", async () => {
  const { w } = await setup();
  expect((await press(w, { key: "w", code: "KeyW", metaKey: true })).defaultPrevented).toBe(false);
  expect((await press(w, { key: "1", code: "Digit1", metaKey: true })).defaultPrevented).toBe(false);

  expect((await press(w, { key: "t", code: "KeyT", metaKey: true })).defaultPrevented).toBe(true);
  expect(screen.getByRole("dialog")).toBeTruthy(); // 移動・検索, to take the new tab somewhere
  await press(w, { key: "Escape" });
  expect(tabNames()).toEqual(["c", "c"]);
  middleClick(row("d"));
  await settle(w);
  expect(tabNames()).toEqual(["c", "c", "d"]);
  expect(tabs()[1]!.getAttribute("aria-selected")).toBe("true");

  await press(w, { key: "}", code: "BracketRight", metaKey: true, shiftKey: true });
  expect(title()).toBe("d");
  await press(w, { key: "Tab", ctrlKey: true });
  expect(tabs()[0]!.getAttribute("aria-selected")).toBe("true"); // round the end
  await press(w, { key: "Tab", ctrlKey: true, shiftKey: true });
  expect(title()).toBe("d");
  await press(w, { key: "{", code: "BracketLeft", metaKey: true, shiftKey: true });
  expect(tabs()[1]!.getAttribute("aria-selected")).toBe("true");
  await press(w, { key: "9", code: "Digit9", metaKey: true });
  expect(title()).toBe("d");
  await press(w, { key: "1", code: "Digit1", metaKey: true });
  expect(tabs()[0]!.getAttribute("aria-selected")).toBe("true");
  expect((await press(w, { key: "w", code: "KeyW", metaKey: true })).defaultPrevented).toBe(true);
  expect(tabs()).toHaveLength(2);
  expect(tabs()[0]!.getAttribute("aria-selected")).toBe("true"); // the right neighbour of the closed one
  expect(title()).toBe("c");
  w.engine.stop();
});

it("the tabs are kept on this device and come back; a tab whose conversation is gone is dropped", async () => {
  const { w, controller, view, e } = await setup();
  middleClick(row("d"));
  await settle(w);
  fireEvent.click(row("e"), { metaKey: true, shiftKey: true });
  await settle(w);
  fireEvent.click(place("スレッド"));
  await settle(w);
  expect(tabNames()).toEqual(["c", "スレッド", "d"]);
  const key = `chikuwa.tabs.${controller.accountKey}`;
  const stored = JSON.parse(localStorage.getItem(key)!) as { tabs: Array<{ id: string; target: TabTarget }>; active: string };
  expect(stored.tabs.map((tab) => tab.target.view)).toEqual(["channel", "threads", "channel"]);
  expect(stored.tabs[1]!.target.currentId).toBe(e); // the conversation left behind the view, as on one screen
  expect(stored.active).toBe(stored.tabs[1]!.id);
  view.unmount();

  // Next start: the same tabs, the threads view on screen. One more stored tab points at a conversation that is no more.
  stored.tabs.push({ id: "gone", target: { ...stored.tabs[0]!.target, currentId: "00000000-0000-0000-0000-000000000000" } });
  localStorage.setItem(key, JSON.stringify(stored));
  render(<Screen w={w} controller={controller} />);
  await settle(w);
  expect(tabNames()).toEqual(["c", "スレッド", "d"]);
  expect(activeTab()).toBe("スレッド");
  expect(place("スレッド").getAttribute("aria-current")).toBe("page");
  expect(w.engine.currentChannelId).toBe(e);
  fireEvent.click(tabs()[2]!);
  await settle(w);
  expect(title()).toBe("d");
  w.engine.stop();
});

it("a browser's start (an empty store until the bootstrap): the stored tabs come back once it is in", async () => {
  const target = (currentId: string, view = "channel"): TabTarget => ({ view, currentId, threadId: null, threadChannelId: null, docsPageId: null, filesChannelId: null, tab: "messages", search: null });
  let key = "";
  const { w, d, e } = await setup({
    renderFirst: true,
    before: (world, ids) => {
      key = "chikuwa.tabs.http://server|bob";
      localStorage.setItem(key, JSON.stringify({ tabs: [{ id: "t1", target: target(world.channelId) }, { id: "t2", target: target(ids.d) }, { id: "t3", target: target(ids.e, "threads") }], active: "t2" }));
    },
  });
  void e;
  expect(tabNames()).toEqual(["c", "d", "スレッド"]);
  expect(activeTab()).toBe("d");
  expect(title()).toBe("d");
  expect(w.engine.currentChannelId).toBe(d);
  expect(JSON.parse(localStorage.getItem(key)!).tabs).toHaveLength(3);
  w.engine.stop();
});

it("「タブを使う」 off: no bar, no 「新しいタブで開く」, the other tabs closed", async () => {
  const { w, controller } = await setup();
  middleClick(row("d"));
  await settle(w);
  expect(tabs()).toHaveLength(2);
  act(() => controller.setUseTabs(false));
  await settle(w);
  expect(tabList()).toBeNull();
  fireEvent.contextMenu(row("d"));
  expect(within(screen.getByRole("menu")).queryByRole("menuitem", { name: "新しいタブで開く" })).toBeNull();
  expect(localStorage.getItem("chikuwa.prefs.useTabs")).toBe("0");
  w.engine.stop();
});

it("a phone-width page: no tabs and no 「新しいタブで開く」 for a conversation (it has no URL of its own)", async () => {
  compact = true;
  env.web = true;
  const { w } = await setup();
  expect(tabList()).toBeNull();
  const homeRow = screen.getAllByRole("button", { name: /^d/ })[0]!;
  fireEvent.contextMenu(homeRow);
  expect(screen.queryByRole("menuitem", { name: "新しいタブで開く" })).toBeNull();
  w.engine.stop();
});

it("a place of the rail and a thread of 「スレッド」 open in a new tab from their menus", async () => {
  // Bob replied in c's thread: he follows it (THREADS.md).
  const { w } = await setup({ before: (world) => void world.server.post(world.channelId, world.bob.id, "僕も", undefined, world.server.channels.get(world.channelId)!.messages[0]!.id) });
  await openInNewTabFromMenu(w, place("カレンダー"));
  expect(tabNames()).toEqual(["c", "カレンダー"]);
  fireEvent.click(place("スレッド"));
  await settle(w);
  const card = document.querySelector<HTMLElement>("li[data-row-key]");
  expect(card).not.toBeNull();
  await openInNewTabFromMenu(w, card!);
  expect(tabNames()).toEqual(["スレッド", "c", "カレンダー"]);
  fireEvent.click(tabs()[1]!);
  await settle(w);
  expect(title()).toBe("c");
  expect(screen.getByText("返信")).toBeTruthy(); // the thread beside its conversation
  w.engine.stop();
});

describe("desktopTabs (pure)", () => {
  const tab = (id: string): Tab<null> => ({ id, saved: null, target: { view: "channel", currentId: id, threadId: null, threadChannelId: null, docsPageId: null, filesChannelId: null, tab: "messages", search: null } });
  const ids = (list: readonly Tab<null>[]) => list.map((entry) => entry.id);

  it("insert right of the active one, the neighbour on close, moves, steps round the ends, ⌘9 the last", () => {
    const list = [tab("a"), tab("b"), tab("c")];
    expect(ids(insertTab(list, "a", tab("x")))).toEqual(["a", "x", "b", "c"]);
    expect(ids(insertTab(list, "zz", tab("x")))).toEqual(["a", "b", "c", "x"]);
    expect(neighbourOf(list, "b")).toBe("c");
    expect(neighbourOf(list, "c")).toBe("b");
    expect(neighbourOf([tab("a")], "a")).toBeNull();
    expect(ids(moveTab(list, "a", 2))).toEqual(["b", "c", "a"]);
    expect(ids(moveTab(list, "c", 0))).toEqual(["c", "a", "b"]);
    expect(stepTab(list, "c", 1)).toBe("a");
    expect(stepTab(list, "a", -1)).toBe("c");
    expect(stepTab([tab("a")], "a", 1)).toBeNull();
    expect(nthTab(list, 2)).toBe("b");
    expect(nthTab(list, 9)).toBe("c");
    expect(nthTab(list, 5)).toBeNull();
  });

  it("tabCommand: the app's keys per platform, Alt on the web, nothing while composing", () => {
    const key = (init: Partial<KeyboardEvent>) => ({ key: "", code: "", metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, isComposing: false, ...init }) as KeyboardEvent;
    expect(tabCommand(key({ key: "t", code: "KeyT", metaKey: true }), true, false)).toEqual({ kind: "new" });
    expect(tabCommand(key({ key: "t", code: "KeyT", ctrlKey: true }), true, false)).toBeNull(); // a Mac's Ctrl+T
    expect(tabCommand(key({ key: "t", code: "KeyT", ctrlKey: true }), false, false)).toEqual({ kind: "new" });
    expect(tabCommand(key({ key: "w", code: "KeyW", metaKey: true }), true, false)).toEqual({ kind: "close" });
    expect(tabCommand(key({ key: "T", code: "KeyT", metaKey: true, shiftKey: true }), true, false)).toBeNull(); // ⌘⇧T: threads
    expect(tabCommand(key({ key: "{", code: "BracketLeft", metaKey: true, shiftKey: true }), true, false)).toEqual({ kind: "step", delta: -1 });
    expect(tabCommand(key({ key: "]", code: "BracketRight", metaKey: true }), true, false)).toBeNull(); // ⌘]: history
    expect(tabCommand(key({ key: "Tab", ctrlKey: true }), true, false)).toEqual({ kind: "step", delta: 1 });
    expect(tabCommand(key({ key: "Tab", ctrlKey: true, shiftKey: true }), false, false)).toEqual({ kind: "step", delta: -1 });
    expect(tabCommand(key({ key: "3", code: "Digit3", metaKey: true }), true, false)).toEqual({ kind: "nth", digit: 3 });
    expect(tabCommand(key({ key: "¡", code: "Digit1", metaKey: true, altKey: true }), true, false)).toBeNull(); // ⌘⌥1: workspaces
    expect(tabCommand(key({ key: "†", code: "KeyT", altKey: true }), true, false)).toBeNull();
    expect(tabCommand(key({ key: "†", code: "KeyT", altKey: true }), true, true)).toEqual({ kind: "new" });
    expect(tabCommand(key({ key: "∑", code: "KeyW", altKey: true }), true, true)).toEqual({ kind: "close" });
    expect(tabCommand(key({ key: "™", code: "Digit2", altKey: true }), true, true)).toEqual({ kind: "nth", digit: 2 });
    expect(tabCommand(key({ key: "”", code: "BracketLeft", altKey: true, shiftKey: true }), true, true)).toEqual({ kind: "step", delta: -1 });
    expect(tabCommand(key({ key: "t", code: "KeyT", metaKey: true, isComposing: true }), true, false)).toBeNull();
  });

  it("storage: broken entries are skipped, gone targets dropped, the active one falls to its right neighbour", () => {
    const target = (id: string): TabTarget => ({ view: "channel", currentId: id, threadId: null, threadChannelId: null, docsPageId: null, filesChannelId: null, tab: "messages", search: null });
    localStorage.setItem("chikuwa.tabs.k", JSON.stringify({ tabs: [{ id: "a", target: target("a") }, { id: "b" }, { id: "a", target: target("x") }, { id: "c", target: target("c") }, { id: "d", target: target("d") }], active: "c" }));
    const stored = readStoredTabs("k")!;
    expect(stored.tabs.map((entry) => entry.id)).toEqual(["a", "c", "d"]);
    expect(restoreTabs(stored, (t) => (t.currentId === "c" ? null : t))).toEqual({ tabs: [{ id: "a", target: target("a") }, { id: "d", target: target("d") }], active: "d" });
    expect(restoreTabs(stored, (t) => (t.currentId === "a" ? t : null))).toEqual({ tabs: [{ id: "a", target: target("a") }], active: "a" });
    expect(restoreTabs(stored, () => null)).toBeNull();
    localStorage.setItem("chikuwa.tabs.k", "{not json");
    expect(readStoredTabs("k")).toBeNull();
  });
});
