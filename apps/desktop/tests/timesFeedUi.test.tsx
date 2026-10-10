// @vitest-environment jsdom
/**
 * L8 (TIMES_FEED.md §7, Desktop / Web): the Times feed on the real MainScreen, a real SyncEngine and the fake server —
 * the sidebar's 「フィード」 row and header icon, the phone home's 「Times」 tile, the rows (times' name, the 「新しい」 dot),
 * 「すべて既読にする」 (scope times), no read position moved by opening it, a row revealed in its channel, and the search's
 * 「Times」 chip and 「is:times」 suggestion.
 */
import { useSyncExternalStore } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import type { ApiClient } from "../src/api/client";
import type { SearchOut } from "../src/api/types";
import { AppController } from "../src/state/app";
import { Store } from "../src/sync/store";
import { COMPACT_QUERY } from "../src/ui/compact";
import { MainScreen } from "../src/ui/MainScreen";
import { SearchBar } from "../src/ui/SearchBar";
import { SearchView, type SearchSnapshot } from "../src/ui/SearchView";
import { EMPTY_SEARCH } from "../src/ui/search";
import { FakeServer } from "./fakeServer";
import { world, type World } from "./unreadWorld";

let compact = false;

beforeEach(() => {
  compact = false;
  localStorage.clear();
  vi.stubGlobal("matchMedia", (query: string) => ({ matches: query === COMPACT_QUERY ? compact : false, addEventListener: () => {}, removeEventListener: () => {} }));
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  vi.spyOn(document, "hasFocus").mockReturnValue(true);
  HTMLElement.prototype.scrollIntoView = () => {};
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

/** Bob reads #c (no times); alice's times has two posts bob has read one of; carol's times one post. */
async function setup() {
  const w = world({ posts: 1, lastRead: 1 });
  const carol = w.server.addUser("carol");
  const times = (owner: { id: string }, name: string) => {
    const channel = w.server.createChannel(name, owner.id);
    channel.times_owner_id = owner.id;
    w.server.join(channel.id, w.bob.id);
    return channel.id;
  };
  const aliceTimes = times(w.alice, "times-alice");
  const carolTimes = times(carol, "times-carol");
  w.server.post(aliceTimes, w.alice.id, "実験の準備");
  w.server.markRead(w.bob.id, aliceTimes, 1);
  w.server.post(aliceTimes, w.alice.id, "装置が動いた");
  w.server.post(carolTimes, carol.id, "論文を読む");
  const inner = w.api as unknown as Record<string, unknown>;
  const api = new Proxy<Record<string, unknown>>({ ...inner }, { get: (target, key: string) => target[key] ?? (async () => []) }) as unknown as ApiClient;
  await w.engine.start();
  await w.engine.idle();
  const controller = new AppController();
  (controller as unknown as { active: unknown }).active = { serverUrl: "http://server", username: "bob", api, store: w.store, engine: w.engine, me: w.store.me, leaving: false };
  render(<Screen w={w} controller={controller} />);
  await flush();
  return { w, controller, carol, aliceTimes, carolTimes };
}

const feed = () => screen.getByRole("feed", { name: "Times フィード" });
const feedHeader = () => screen.getByText("Times フィード", { selector: "strong" }).closest("header")!;

it("the sidebar's 「フィード」 opens the feed: rows newest first with their times' names and the 「新しい」 dot; nothing is read", async () => {
  const { w, aliceTimes, carolTimes } = await setup();
  const reads = w.calls.reads.length;
  fireEvent.click(screen.getByRole("button", { name: "フィード" }));
  await settle(w);
  expect(screen.getByText("Times フィード", { selector: "strong" })).toBeTruthy();
  const rows = [...feed().querySelectorAll("article")];
  expect(rows).toHaveLength(3);
  expect(rows.map((row) => row.querySelector("[data-feed-channel]")?.textContent)).toEqual(["#times-carol", "#times-alice", "#times-alice"]);
  expect(rows[0]!.textContent).toContain("論文を読む");
  expect(rows[1]!.textContent).toContain("装置が動いた");
  // The dot: past bob's read position (alice's times read to 1; carol's not at all).
  expect(rows.map((row) => !!row.querySelector("[data-feed-new]"))).toEqual([true, true, false]);
  // Opening the feed moved no read position and asked for none.
  expect(w.calls.reads.length).toBe(reads);
  expect(w.server.readState(w.bob.id, aliceTimes).last_read_seq).toBe(1);
  expect(w.server.readState(w.bob.id, carolTimes).last_read_seq).toBe(0);
  expect(w.server.timesFeedCalls).toEqual([null]);

  // A new post comes in at the top while the feed is on screen.
  w.server.post(aliceTimes, w.alice.id, "結果をまとめた");
  await settle(w);
  expect(feed().querySelector("article")!.textContent).toContain("結果をまとめた");

  // 「すべて既読にする」: read-all with scope times; the dots go.
  fireEvent.click(within(feedHeader()).getByRole("button", { name: "すべて既読にする" }));
  await settle(w);
  expect(w.server.readAllScopes).toEqual(["times"]);
  expect(feed().querySelector("[data-feed-new]")).toBeNull();
  expect(w.server.readState(w.bob.id, w.channelId).last_read_seq).toBe(1); // #c untouched
  w.engine.stop();
});

it("a row shows its message in its channel; the times' name opens the channel; the header icon opens the feed when folded", async () => {
  const { w, carolTimes } = await setup();
  fireEvent.click(screen.getByRole("button", { name: "Times フィード" }));
  await settle(w);
  const row = [...feed().querySelectorAll("article")].find((r) => r.textContent?.includes("論文を読む"))!;
  fireEvent.click(row.querySelector("[data-message-body], p, div.min-w-0")!);
  await settle(w);
  await waitFor(() => expect(screen.queryByRole("feed")).toBeNull());
  expect(screen.getByText("times-carol", { selector: "header strong" })).toBeTruthy();
  // Back to the feed, then the times' name.
  fireEvent.click(screen.getByRole("button", { name: "フィード" }));
  await settle(w);
  fireEvent.click(within(feed()).getAllByRole("button", { name: "#times-alice" })[0]!);
  await settle(w);
  expect(screen.getByText("times-alice", { selector: "header strong" })).toBeTruthy();
  expect(w.store.getChannel(carolTimes)).toBeTruthy();
  w.engine.stop();
});

it("the sidebar's 「フィード」 looks like the other rows: highlighted only while the feed is open (2026-10-02)", async () => {
  const { w } = await setup();
  const row = () => screen.getByRole("button", { name: "フィード" });
  const threads = () => screen.getByRole("button", { name: "スレッド" });
  const looksActive = (el: HTMLElement) => el.getAttribute("aria-current") === "page" || el.className.split(/\s+/).includes("bg-sidebar-active");
  // A channel is open: neither the feed row nor its header icon is highlighted, as 「スレッド」 is not.
  expect(looksActive(row())).toBe(false);
  // The same row, one step in (it sits under the Times header; 「スレッド」 is above the sections).
  const classes = (el: HTMLElement) => el.className.split(/\s+/).filter((c) => !/^p[lrx]-/.test(c)).sort();
  expect(classes(row())).toEqual(classes(threads()).filter((c) => c !== "font-semibold" && c !== "text-white"));
  expect(row().className).toContain("pl-5 pr-2.5");
  expect(looksActive(screen.getByRole("button", { name: "Times フィード" }))).toBe(false);
  fireEvent.click(row());
  await settle(w);
  expect(looksActive(row())).toBe(true);
  // Another view, then a channel: the highlight goes with the feed.
  fireEvent.click(threads());
  await settle(w);
  expect(looksActive(row())).toBe(false);
  fireEvent.click(row());
  await settle(w);
  fireEvent.click(screen.getByRole("button", { name: /^#?c$/ }));
  await settle(w);
  expect(looksActive(row())).toBe(false);
  w.engine.stop();
});

it("a reply also sent to the channel: its body shows the channel's row (no thread); 「スレッドに返信」 opens the thread (review #13)", async () => {
  const { w, controller, carol, carolTimes } = await setup();
  const parent = w.server.messageByBody(carolTimes, "論文を読む");
  w.server.post(carolTimes, carol.id, "返信もチャンネルに", undefined, parent.id, [], { alsoInChannel: true });
  fireEvent.click(screen.getByRole("button", { name: "Times フィード" }));
  await settle(w);
  const replyRow = () => [...feed().querySelectorAll("article")].find((r) => r.textContent?.includes("返信もチャンネルに"))!;
  // The row itself: the channel, at that row, with no thread open.
  fireEvent.click(replyRow().querySelector("div.min-w-0")!);
  await settle(w);
  await waitFor(() => expect(screen.queryByRole("feed")).toBeNull());
  expect(screen.getByText("times-carol", { selector: "header strong" })).toBeTruthy();
  expect(controller.messageFocus).toMatchObject({ channelId: carolTimes, parentId: null });
  expect(screen.queryByLabelText("スレッドのメッセージ一覧")).toBeNull();
  // Back in the feed (another conversation open behind it now: #c), 「スレッドに返信：」 opens the parent's thread.
  fireEvent.click(screen.getByRole("button", { name: "c" }));
  await settle(w);
  fireEvent.click(screen.getByRole("button", { name: "Times フィード" }));
  await settle(w);
  fireEvent.click(within(replyRow()).getByRole("button", { name: /スレッドに返信/ }));
  await settle(w);
  const list = screen.getByLabelText("スレッドのメッセージ一覧");
  // The thread of the row's channel, not of the conversation left open behind the feed.
  await waitFor(() => expect(list.textContent).toContain("返信もチャンネルに"));
  expect(screen.getByText("#times-carol にも送信")).toBeTruthy();
  w.engine.stop();
});

it("「自分の times に書く」 is 「自分の times を作る」 until I have one; the empty feed explains itself", async () => {
  const w = world({ posts: 1, lastRead: 1 });
  const inner = w.api as unknown as Record<string, unknown>;
  const ensureTimes = vi.fn(async () => {
    const channel = w.server.createChannel("times-bob", w.bob.id);
    channel.times_owner_id = w.bob.id;
    return { ...channel };
  });
  const api = new Proxy<Record<string, unknown>>({ ...inner, ensureTimes }, { get: (target, key: string) => target[key] ?? (async () => []) }) as unknown as ApiClient;
  await w.engine.start();
  await w.engine.idle();
  const controller = new AppController();
  (controller as unknown as { active: unknown }).active = { serverUrl: "http://server", username: "bob", api, store: w.store, engine: w.engine, me: w.store.me, leaving: false };
  render(<Screen w={w} controller={controller} />);
  await flush();
  fireEvent.click(screen.getByRole("button", { name: "Times フィード" }));
  await settle(w);
  expect(screen.getByText(/参加している times がありません/)).toBeTruthy();
  fireEvent.click(within(feedHeader()).getByRole("button", { name: "自分の times を作る" }));
  await settle(w);
  expect(ensureTimes).toHaveBeenCalledTimes(1);
  expect(screen.getByText("times-bob", { selector: "header strong" })).toBeTruthy();
  w.engine.stop();
});

it("a phone: the home's 「Times」 tile opens the feed", async () => {
  compact = true;
  const { w } = await setup();
  fireEvent.click(screen.getByRole("region", { name: "ホーム" }).querySelector<HTMLButtonElement>('[data-tile="times"]')!);
  await settle(w);
  expect(feed().querySelectorAll("article")).toHaveLength(3);
  w.engine.stop();
});

// ---- search ----

function searchWorld() {
  const server = new FakeServer();
  const me = server.addUser("bob");
  const sato = server.addUser("sato");
  const satoTimes = server.createChannel("times-sato", sato.id);
  satoTimes.times_owner_id = sato.id;
  satoTimes.archived = true;
  const store = new Store();
  store.upsertUser(me);
  store.upsertUser(sato);
  const hit = server.post(satoTimes.id, sato.id, "引き継ぎのメモ").message;
  const search = vi.fn(async (): Promise<SearchOut> => ({
    hits: [{ message: hit, score: 1 }],
    keywords: [],
    filters: { text: "", has: [], is_thread: false, is_times: true, exclude_archived: false, unresolved: [] },
    limit: 30,
    offset: 0,
    has_more: false,
    total: 1,
    total_capped: false,
    channels: [{ ...satoTimes }],
  }));
  const controller = { store, api: { search, listFiles: vi.fn() }, setError: vi.fn() } as unknown as AppController;
  return { store, controller, search, satoTimes, hit };
}

it("search: 「is:times」 among the empty box's suggestions, the 「Times」 chip, is_times sent", async () => {
  const s = searchWorld();
  const onSearch = vi.fn();
  render(<SearchBar controller={s.controller} current={null} open onOpenChange={() => {}} onSearch={onSearch} recent={[]} onRecentChange={() => {}} recentKey="k" placeholder="" />);
  expect((screen.getByLabelText("検索語") as HTMLInputElement).placeholder).toContain("is:times");
  fireEvent.click(screen.getByText(/times の投稿/));
  expect(onSearch).toHaveBeenCalledWith({ ...EMPTY_SEARCH, isTimes: true, sort: "newest" });
  cleanup();

  const onChange = vi.fn();
  const onOpen = vi.fn();
  const params = { ...EMPTY_SEARCH, q: "引き継ぎ", isTimes: true };
  render(<SearchView controller={s.controller} params={params} tab="messages" onTabChange={() => {}} onChange={onChange} onOpen={onOpen} onClose={() => {}} snapshot={{ current: null as SearchSnapshot | null }} />);
  await waitFor(() => expect(screen.getByText("1 件")).toBeTruthy());
  expect(s.search).toHaveBeenCalledWith(expect.objectContaining({ q: "引き継ぎ", is_times: true }));
  const chip = screen.getByRole("button", { name: /^Times/ });
  expect(chip.getAttribute("aria-pressed")).toBe("true");
  fireEvent.click(chip);
  expect(onChange).toHaveBeenCalledWith({ ...params, isTimes: false });
  // A hit of a times I am not in (archived: not in bootstrap) is named from SearchOut.channels and opens as a preview.
  const row = screen.getAllByRole("button").find((b) => b.textContent?.includes("引き継ぎのメモ"))!;
  expect(row.textContent).toContain("times-sato");
  expect(row.textContent).toContain("未参加・アーカイブ済み");
  expect(s.store.getChannel(s.satoTimes.id)).toBeUndefined();
  fireEvent.click(row);
  expect(s.store.getChannel(s.satoTimes.id)).toMatchObject({ isMember: false, archived: true });
  expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({ id: s.hit.id }));
});
