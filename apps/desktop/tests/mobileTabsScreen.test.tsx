// @vitest-environment jsdom
/**
 * M34 (Web, the narrow layout): the bottom tabs on the real MainScreen, a real SyncEngine and the fake server — each tab's
 * screens, the re-tap, the DM list, the activity tab, where a permalink lands, and that only the selected tab's top
 * screen reads (SYNC_PROTOCOL.md §10.1 2.). jsdom has no layout: for the reads, rows are laid out by seq as in
 * unreadBanner.test.tsx (row `seq` at (seq - first) × 60 px, 15 rows on screen, the end of the list shown).
 */
import { useSyncExternalStore } from "react";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import type { ApiClient } from "../src/api/client";
import type { MessageOut } from "../src/api/types";
import { AppController } from "../src/state/app";
import { COMPACT_QUERY } from "../src/ui/compact";
import { MainScreen } from "../src/ui/MainScreen";
import { world, type World } from "./unreadWorld";

let compact = true;
const ROW = 60;
const layout = { first: 1, rows: 15 };
const rowSeqs = (el: Element): number[] => [...el.querySelectorAll<HTMLElement>("article[data-seq]")].map((row) => Number(row.dataset["seq"]));

beforeEach(() => {
  compact = true;
  layout.first = 1;
  vi.stubGlobal("matchMedia", (query: string) => ({ matches: query === COMPACT_QUERY ? compact : false, addEventListener: () => {}, removeEventListener: () => {} }));
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  vi.spyOn(document, "hasFocus").mockReturnValue(true);
  HTMLElement.prototype.scrollIntoView = () => {};
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  for (const key of ["clientHeight", "scrollTop", "scrollHeight"]) delete (HTMLElement.prototype as unknown as Record<string, unknown>)[key];
});

/** Rows by seq, the newest at the bottom of the screen (a timeline following the end of its conversation). */
function layRowsOut() {
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    const seq = this.dataset["seq"] ? Number(this.dataset["seq"]) : null;
    const top = seq === null ? 0 : (seq - layout.first) * ROW;
    const height = seq === null ? layout.rows * ROW : ROW;
    return { top, bottom: top + height, height, left: 0, right: 300, width: 300, x: 0, y: top, toJSON: () => ({}) } as DOMRect;
  });
  HTMLElement.prototype.scrollIntoView = function (this: HTMLElement, options?: boolean | ScrollIntoViewOptions) {
    const block = typeof options === "object" ? options.block : undefined;
    const target = this.dataset["seq"] ? this : (this.nextElementSibling as HTMLElement | null); // a divider: the row after it
    const seq = target?.dataset["seq"] ? Number(target.dataset["seq"]) : null;
    if (seq !== null) layout.first = block === "center" ? seq - Math.floor(layout.rows / 2) : seq;
  };
  Object.defineProperty(HTMLElement.prototype, "clientHeight", { configurable: true, get: () => layout.rows * ROW });
  Object.defineProperty(HTMLElement.prototype, "scrollTop", {
    configurable: true,
    get(this: HTMLElement) {
      const seqs = rowSeqs(this);
      return seqs.length ? (layout.first - Math.min(...seqs)) * ROW + 1000 : 0;
    },
    set(this: HTMLElement, value: number) {
      const seqs = rowSeqs(this);
      if (seqs.length && value >= this.scrollHeight - this.clientHeight) layout.first = Math.max(...seqs) - layout.rows + 1;
    },
  });
  Object.defineProperty(HTMLElement.prototype, "scrollHeight", {
    configurable: true,
    get(this: HTMLElement) {
      const seqs = rowSeqs(this);
      return seqs.length ? this.scrollTop + this.clientHeight + Math.max(0, (Math.max(...seqs) - (layout.first + layout.rows - 1)) * ROW) : 0;
    },
  });
}

/**
 * Channel C (alice's posts m1..m`posts`, read by bob), a DM with alice holding one unread 「DM です」, bob's own notes,
 * and a thread under m1 that bob follows with one unread reply. Bob is on this device, at the home tab's root.
 */
async function setup(options: { posts?: number } = {}) {
  const w = world({ posts: options.posts ?? 5, lastRead: options.posts ?? 5 });
  const first = w.server.channels.get(w.channelId)!.messages[0]!;
  w.server.post(w.channelId, w.bob.id, "my reply", undefined, first.id); // bob follows the thread
  w.server.post(w.channelId, w.alice.id, "alice's reply", undefined, first.id);
  const dmId = w.server.createChannel("", w.alice.id, "dm").id;
  w.server.channels.get(dmId)!.channel.dm_user_ids = [w.alice.id, w.bob.id];
  w.server.join(dmId, w.bob.id);
  const dmMessage = w.server.post(dmId, w.alice.id, "DM です").message;
  const notesId = w.server.createChannel("", w.bob.id, "dm").id;
  w.server.channels.get(notesId)!.channel.dm_user_ids = [w.bob.id];
  const inner = w.api as unknown as Record<string, unknown>;
  const mention = { ...first, body: "@bob メンションの本文" } as unknown as MessageOut;
  const extra: Record<string, unknown> = {
    listMentions: async () => ({ items: [mention], next_cursor: null }),
    search: async () => ({ hits: [{ message: dmMessage }], keywords: [], total: 1, total_capped: false, has_more: false, filters: { unresolved: [] } }),
    messageContext: async (id: string) => [w.server.channels.get(w.channelId)!.messages.find((m) => m.id === id) ?? w.server.channels.get(dmId)!.messages[0]!],
  };
  // Whatever else the screen asks for on the side (custom emoji, sections, drafts …) finds nothing.
  const api = new Proxy({ ...inner, ...extra }, { get: (target, key: string) => target[key] ?? (async () => []) }) as unknown as ApiClient;
  await w.engine.start();
  await w.engine.idle();
  const controller = new AppController();
  (controller as unknown as { active: unknown }).active = { serverUrl: "http://server", username: "bob", api, store: w.store, engine: w.engine, me: w.store.me, leaving: false };
  render(<Screen w={w} controller={controller} />);
  await flush();
  return { w, controller, dmId, dmMessage, first };
}

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
const bar = () => screen.queryByRole("navigation", { name: "タブ" });
const tabButton = (tab: string) => bar()!.querySelector<HTMLButtonElement>(`[data-tab="${tab}"]`)!;
const selected = () => bar()?.querySelector("[aria-current=page]")?.getAttribute("data-tab") ?? null;
const tap = async (tab: string) => {
  fireEvent.click(tabButton(tab));
  await flush();
};
/** The visible tab root (the others are hidden from the accessibility tree). */
const root = (tab: string) => document.querySelector<HTMLElement>(`[data-tab-root="${tab}"]`);
const header = () => screen.getByRole("banner");
const back = async () => {
  fireEvent.click(within(header()).getByRole("button", { name: "戻る" }));
  await flush();
};
const serverRead = (w: World) => w.server.readState(w.bob.id, w.channelId).last_read_seq;
async function settle(w: World) {
  await act(async () => {
    await w.engine.flushReads();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await w.engine.flushReads();
  });
}

it("the bar shows on the tabs' roots and pushed lists, not in a conversation; the home list has 「スレッド」 but no 「メンション」; the wide layout has no bar", async () => {
  const { w, controller } = await setup();
  expect(bar()).toBeTruthy();
  expect(selected()).toBe("home");
  expect(within(root("home")!).getByText("スレッド")).toBeTruthy();
  expect(within(root("home")!).queryByText("メンション")).toBeNull();
  expect(w.engine.currentChannelId).toBeNull(); // nothing open at a root

  fireEvent.click(within(root("home")!).getByTitle("#c"));
  await act(async () => { await w.engine.idle(); });
  expect(document.querySelector(".timeline")).toBeTruthy();
  expect(bar()).toBeNull();
  expect(root("home")!.getAttribute("aria-hidden")).toBe("true");
  expect(w.engine.currentChannelId).toBe(w.channelId);

  await back();
  expect(bar()).toBeTruthy();
  expect(document.querySelector(".timeline")).toBeNull();
  expect(w.engine.currentChannelId).toBeNull();

  // A list pushed on the root (スレッド) keeps the bar; the selected tab's button pops back to the root.
  fireEvent.click(within(root("home")!).getByText("スレッド"));
  await flush();
  expect(root("home")!.getAttribute("aria-hidden")).toBe("true");
  expect(bar()).toBeTruthy();
  await tap("home");
  expect(root("home")!.getAttribute("aria-hidden")).toBeNull();
  // At the root, another tap scrolls the list to the top.
  const list = within(root("home")!).getByRole("navigation", { name: "チャンネルとDM" });
  list.scrollTop = 240;
  await tap("home");
  expect(list.scrollTop).toBe(0);

  compact = false;
  act(() => controller.setEditing(null));
  expect(bar()).toBeNull();
  expect(document.querySelector("[data-tab-root]")).toBeNull();
  expect(screen.getByRole("button", { name: "メンション" })).toBeTruthy(); // the wide sidebar keeps it
  w.engine.stop();
});

it("badges: DM counts unread DMs, activity the unread threads (+ channels with a mention), home a dot for unread channels", async () => {
  const { w, dmId } = await setup();
  expect(tabButton("dm").getAttribute("aria-label")).toBe("DM (未読 1)");
  expect(tabButton("dm").querySelector("[data-badge]")?.textContent).toBe("1");
  expect(tabButton("activity").getAttribute("aria-label")).toBe("アクティビティ (未読 1)");
  expect(tabButton("activity").querySelector("[data-badge]")?.getAttribute("data-badge")).toBe("neutral");
  expect(tabButton("home").querySelector("[data-badge=dot]")).toBeNull();

  // A mention in the channel: the activity badge counts it and turns red; the channel is unread (home's dot).
  await act(async () => {
    w.server.post(w.channelId, w.alice.id, `<@${w.bob.id}> 見て`);
    await w.engine.idle();
  });
  expect(w.store.getChannel(w.channelId)!.mentionCount).toBe(1);
  expect(tabButton("home").querySelector("[data-badge=dot]")).toBeTruthy();
  expect(tabButton("activity").getAttribute("aria-label")).toBe("アクティビティ (未読 2)");
  expect(tabButton("activity").querySelector("[data-badge]")?.getAttribute("data-badge")).toBe("danger");
  // A new DM message: the DM badge stays one conversation.
  await act(async () => {
    w.server.post(dmId, w.alice.id, "もう一通");
    await w.engine.idle();
  });
  expect(tabButton("dm").querySelector("[data-badge]")?.textContent).toBe("1");
  w.engine.stop();
});

it("the DM tab: 「自分へのメモ」 first, then by the last message, times, unread bold with its count, a name filter, 「新しいメッセージ」; a row opens on the DM tab", async () => {
  const { w, dmId } = await setup();
  await tap("dm");
  expect(selected()).toBe("dm");
  const list = within(root("dm")!);
  const rows = list.getAllByRole("listitem");
  const name = (row: HTMLElement) => row.querySelector<HTMLElement>("span.text-\\[15px\\]")!;
  expect(rows.map((row) => name(row).textContent)).toEqual(["自分へのメモ", "Alice"]);
  const alice = rows[1]!;
  expect(alice.textContent).toMatch(/\d{1,2}:\d{2}/); // today: the time
  expect(name(alice).className).toContain("font-bold");
  expect(within(alice).getByText("1")).toBeTruthy();
  expect(name(rows[0]!).className).not.toContain("font-bold");

  fireEvent.change(list.getByPlaceholderText("DM を検索"), { target: { value: "ALI" } });
  expect(list.getAllByRole("listitem")).toHaveLength(1);
  fireEvent.change(list.getByPlaceholderText("DM を検索"), { target: { value: "zzz" } });
  expect(list.getByText("一致する DM はありません")).toBeTruthy();
  fireEvent.change(list.getByPlaceholderText("DM を検索"), { target: { value: "" } });

  fireEvent.click(list.getByRole("button", { name: "新しいメッセージ" }));
  expect(screen.getByRole("heading", { name: "ダイレクトメッセージ" })).toBeTruthy();
  fireEvent.keyDown(window, { key: "Escape" });
  await flush();

  fireEvent.click(within(root("dm")!).getByText("Alice"));
  await act(async () => { await w.engine.idle(); });
  expect(bar()).toBeNull();
  expect(w.engine.currentChannelId).toBe(dmId);
  expect(screen.getByText("DM です")).toBeTruthy();
  await back();
  expect(selected()).toBe("dm");
  expect(w.engine.currentChannelId).toBeNull();
  w.engine.stop();
});

it("the activity tab: [メンション | スレッド]; a mention opens its conversation and a thread row its thread on the activity tab, ← back to its root", async () => {
  const { w } = await setup();
  await tap("activity");
  const activity = within(root("activity")!);
  expect(activity.getByRole("radio", { name: "メンション" }).getAttribute("aria-checked")).toBe("true");
  fireEvent.click(await activity.findByText("@bob メンションの本文"));
  await act(async () => { await w.engine.idle(); });
  await flush();
  expect(bar()).toBeNull();
  expect(document.querySelector(".timeline")).toBeTruthy();
  expect(w.engine.currentChannelId).toBe(w.channelId);
  await back();
  expect(selected()).toBe("activity");

  fireEvent.click(activity.getByRole("radio", { name: /スレッド/ }));
  await flush();
  fireEvent.click(await activity.findByText(/2 件の返信/));
  await flush();
  const thread = screen.getByLabelText("スレッドのメッセージ一覧").closest("aside")!;
  expect(bar()).toBeNull();
  expect(within(thread).getByText("alice's reply")).toBeTruthy();
  fireEvent.click(within(thread).getByRole("button", { name: "戻る" }));
  await flush();
  expect(screen.queryByLabelText("スレッドのメッセージ一覧")).toBeNull();
  expect(selected()).toBe("activity");
  expect(activity.getByRole("radio", { name: /スレッド/ }).getAttribute("aria-checked")).toBe("true");
  w.engine.stop();
});

it("a DM permalink lands on the DM tab, the home tab keeps its conversation; the browser's Back returns to it", async () => {
  const { w, controller, dmId, dmMessage } = await setup();
  fireEvent.click(within(root("home")!).getByTitle("#c"));
  await act(async () => { await w.engine.idle(); });
  const inHome = history.state;

  await act(async () => { await controller.openPermalink(dmMessage.id); await w.engine.idle(); });
  await flush();
  expect(w.engine.currentChannelId).toBe(dmId);
  expect(screen.getByText("DM です")).toBeTruthy();
  await back();
  expect(selected()).toBe("dm"); // landed on the DM tab
  await tap("home");
  expect(bar()).toBeNull(); // the home tab's conversation, as it was left
  expect(w.engine.currentChannelId).toBe(w.channelId);
  expect(within(header()).getByText("c")).toBeTruthy();

  // A channel permalink from the DM tab lands on the home tab, replacing its screens.
  await back();
  await tap("dm");
  await act(async () => { await controller.openPermalink(w.server.channels.get(w.channelId)!.messages[1]!.id); await w.engine.idle(); });
  await flush();
  expect(w.engine.currentChannelId).toBe(w.channelId);
  await back();
  expect(selected()).toBe("home");

  // Back to the entry of the home conversation: the home tab, its conversation.
  act(() => window.dispatchEvent(new PopStateEvent("popstate", { state: inHome })));
  await flush();
  expect(bar()).toBeNull();
  expect(w.engine.currentChannelId).toBe(w.channelId);
  w.engine.stop();
});

it("switching tabs keeps each tab's screens: a list pushed on home comes back after the DM tab", async () => {
  const { w } = await setup();
  fireEvent.click(within(root("home")!).getByText("スレッド"));
  await flush();
  expect(screen.getByRole("banner").textContent).toContain("未読 1 件");
  const push = vi.spyOn(history, "pushState");
  await tap("dm");
  expect(push).toHaveBeenCalledTimes(1); // a tab switch is a history entry
  expect(selected()).toBe("dm");
  expect(root("dm")!.getAttribute("aria-hidden")).toBeNull();
  await tap("home");
  expect(selected()).toBe("home");
  expect(root("home")!.getAttribute("aria-hidden")).toBe("true"); // still under the threads list
  expect(screen.getByRole("banner").textContent).toContain("未読 1 件");
  w.engine.stop();
});

it("a search result in a DM lands on the DM tab; 「検索結果に戻る」 goes back to the results on the home tab", async () => {
  const { w, dmId } = await setup();
  fireEvent.click(within(root("home")!).getByText(/を検索$/));
  const input = await screen.findByPlaceholderText(/メッセージ、人、チャンネルを検索/);
  fireEvent.change(input, { target: { value: "DM" } });
  fireEvent.keyDown(input, { key: "Enter" });
  await flush();
  fireEvent.click(await screen.findByText(/DM です/));
  await act(async () => { await w.engine.idle(); });
  await flush();
  expect(w.engine.currentChannelId).toBe(dmId);
  expect(bar()).toBeNull();
  fireEvent.click(screen.getByText("検索結果に戻る"));
  await flush();
  expect(selected()).toBe("home");
  expect(await screen.findByText(/DM です/)).toBeTruthy(); // the results, on the home tab
  // The DM tab kept its conversation (without the way back to the results, which are on the home tab now).
  await back();
  await tap("dm");
  await act(async () => { await w.engine.idle(); });
  expect(bar()).toBeNull();
  expect(w.engine.currentChannelId).toBe(dmId);
  expect(screen.queryByText("検索結果に戻る")).toBeNull();
  w.engine.stop();
});

it("only the selected tab's top screen reads: a conversation left on another tab reads nothing and is not the engine's open one", async () => {
  layRowsOut();
  const { w, controller, dmMessage } = await setup({ posts: 20 });
  fireEvent.click(within(root("home")!).getByTitle("#c"));
  await act(async () => { await w.engine.idle(); });
  await settle(w);
  // On screen: a new row is read.
  await act(async () => { w.server.post(w.channelId, w.alice.id, "m-live"); await w.engine.idle(); });
  await settle(w);
  const last = w.server.channels.get(w.channelId)!.channel.last_seq;
  expect(serverRead(w)).toBe(last);

  // The home conversation is left under the DM tab: new rows there are not read, and notify again.
  await act(async () => { await controller.openPermalink(dmMessage.id); await w.engine.idle(); });
  await flush();
  expect(w.engine.currentChannelId).not.toBe(w.channelId);
  expect(document.querySelectorAll(".timeline")).toHaveLength(1); // the DM's only
  const reads = w.calls.reads.filter((r) => r.seq > last).length;
  await act(async () => { w.server.post(w.channelId, w.alice.id, "m-hidden"); await w.engine.idle(); });
  await settle(w);
  expect(serverRead(w)).toBe(last);
  expect(w.calls.reads.filter((r) => r.seq > last).length).toBe(reads);
  expect(w.store.getChannel(w.channelId)!.unreadCount).toBe(1);

  // Back on the home tab: the conversation is on screen again and reads what it shows.
  await back();
  expect(tabButton("home").querySelector("[data-badge=dot]")).toBeTruthy();
  await tap("home");
  await act(async () => { await w.engine.idle(); });
  await settle(w);
  expect(serverRead(w)).toBe(last + 1);
  w.engine.stop();
});
