// @vitest-environment jsdom
/**
 * M37 (Web, the narrow layout): the phone's home on the real MainScreen, a real SyncEngine and the fake server — its
 * header and ⋯, the tiles, 「未読をまとめる」, the short DM section, 「移動・検索」 and ✏️'s picker; and ⌘K's order in the
 * wide layout (the shared jump-match rule).
 */
import { useSyncExternalStore } from "react";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import type { ApiClient } from "../src/api/client";
import { AppController } from "../src/state/app";
import { COMPACT_QUERY } from "../src/ui/compact";
import { GATHER_UNREAD_KEY } from "../src/ui/home";
import { MainScreen } from "../src/ui/MainScreen";
import { world, type World } from "./unreadWorld";

let compact = true;

beforeEach(() => {
  compact = true;
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

/**
 * Bob is in #c (read) and #general, has a DM with alice holding one unread message, his own notes, follows a thread with
 * one unread reply; #random is public and bob is not in it; carol exists. `extraDms` more DMs, newer than alice's.
 */
async function setup(options: { extraDms?: number } = {}) {
  const w = world({ posts: 3, lastRead: 3 });
  const carol = w.server.addUser("carol");
  const first = w.server.channels.get(w.channelId)!.messages[0]!;
  w.server.post(w.channelId, w.bob.id, "my reply", undefined, first.id);
  w.server.post(w.channelId, w.alice.id, "alice's reply", undefined, first.id);
  const generalId = w.server.createChannel("general", w.alice.id).id;
  w.server.join(generalId, w.bob.id);
  w.server.createChannel("random", w.alice.id);
  const dm = (userIds: string[]) => {
    const id = w.server.createChannel("", w.bob.id, userIds.length > 2 ? "group_dm" : "dm").id;
    w.server.channels.get(id)!.channel.dm_user_ids = userIds;
    for (const userId of userIds) w.server.join(id, userId);
    return id;
  };
  const dmId = dm([w.alice.id, w.bob.id]);
  w.server.post(dmId, w.alice.id, "DM です");
  const notesId = dm([w.bob.id]);
  for (let i = 0; i < (options.extraDms ?? 0); i++) {
    const id = dm([w.server.addUser(`user${i}`).id, w.bob.id]);
    w.server.post(id, w.bob.id, `hi ${i}`);
  }
  const createDm = Object.assign(
    async (userIds: string[]) => {
      createDm.calls.push(userIds);
      const channel = w.server.createChannel("", w.bob.id, userIds.length > 1 ? "group_dm" : "dm");
      channel.dm_user_ids = [...new Set([w.bob.id, ...userIds])];
      return { ...channel };
    },
    { calls: [] as string[][] },
  );
  const inner = w.api as unknown as Record<string, unknown>;
  const api = new Proxy<Record<string, unknown>>({ ...inner, createDm }, { get: (target, key: string) => target[key] ?? (async () => []) }) as unknown as ApiClient;
  await w.engine.start();
  await w.engine.idle();
  const controller = new AppController();
  (controller as unknown as { active: unknown }).active = { serverUrl: "http://server", username: "bob", api, store: w.store, engine: w.engine, me: w.store.me, leaving: false };
  render(<Screen w={w} controller={controller} />);
  await flush();
  return { w, controller, carol, generalId, dmId, notesId, createDm };
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
const settle = async (w: World) => {
  await act(async () => { await w.engine.idle(); });
  await flush();
};
const home = () => screen.getByRole("region", { name: "ホーム" });
const bar = () => screen.queryByRole("navigation", { name: "タブ" });
const selected = () => bar()?.querySelector("[aria-current=page]")?.getAttribute("data-tab") ?? null;
const section = (key: string) => home().querySelector<HTMLElement>(`[data-home-section="${key}"]`);
const rowNames = (el: HTMLElement | null) => [...(el?.querySelectorAll("li:not(.folded) button span.truncate") ?? [])].map((span) => span.textContent);
const back = async () => {
  fireEvent.click(within(screen.getByRole("banner")).getByRole("button", { name: "戻る" }));
  await flush();
};
async function openHomeMenu() {
  fireEvent.keyDown(within(home()).getByRole("button", { name: "ホームのメニュー" }), { key: "Enter" });
  await flush();
  return screen.getByRole("menu");
}
const jump = () => screen.queryByRole("dialog", { name: "移動・検索" });
/** "kind:name" for each row of 移動・検索 (the name without the avatar's initial or the badge). */
const jumpRows = () => [...jump()!.querySelectorAll<HTMLButtonElement>("[data-jump-row]")].map((row) => `${row.dataset["jumpRow"]}:${row.querySelector("span.truncate")?.textContent}`);

it("the header: the workspace's name and ⋯ (no avatar, search icon or ＋); ⋯ holds the home's actions", async () => {
  const { w } = await setup();
  const header = home().querySelector("header")!;
  expect(header.textContent).toContain("ChikuwaChat");
  expect(within(header).getAllByRole("button").map((b) => b.getAttribute("aria-label"))).toEqual(["ホームのメニュー"]);
  expect(header.querySelector("img, [data-avatar]")).toBeNull();
  const menu = await openHomeMenu();
  expect([...menu.querySelectorAll('[role^="menuitem"]')].map((item) => item.textContent)).toEqual([
    "すべて既読にする…", "未読をまとめる", "チャンネルを探す", "チャンネルを作成", "メンバー一覧", "新しいセクション…", "自分の times を作る", "再読み込み",
  ]);
  expect(within(menu).getByRole("menuitemcheckbox", { name: "未読をまとめる" }).getAttribute("aria-checked")).toBe("false");

  // 「再読み込み」: bootstrap again (the engine's resync).
  const bootstrap = vi.spyOn(w.api, "bootstrap");
  fireEvent.click(within(menu).getByRole("menuitem", { name: "再読み込み" }));
  await settle(w);
  expect(bootstrap).toHaveBeenCalledTimes(1);

  // 「メンバー一覧」 opens the directory.
  fireEvent.click(within(await openHomeMenu()).getByRole("menuitem", { name: "メンバー一覧" }));
  await flush();
  expect(screen.getByRole("dialog")).toBeTruthy();
  w.engine.stop();
});

it("「すべて既読にする」 asks first", async () => {
  const { w, dmId } = await setup();
  expect(w.store.getChannel(dmId)!.unreadCount).toBe(1);
  fireEvent.click(within(await openHomeMenu()).getByRole("menuitem", { name: "すべて既読にする…" }));
  await flush();
  const dialog = screen.getByRole("dialog", { name: "すべて既読にしますか？" });
  fireEvent.click(within(dialog).getByRole("button", { name: "キャンセル" }));
  await flush();
  expect(w.store.getChannel(dmId)!.unreadCount).toBe(1);
  fireEvent.click(within(await openHomeMenu()).getByRole("menuitem", { name: "すべて既読にする…" }));
  await flush();
  fireEvent.click(within(screen.getByRole("dialog", { name: "すべて既読にしますか？" })).getByRole("button", { name: "既読にする" }));
  await settle(w);
  expect(w.store.getChannel(dmId)!.unreadCount).toBe(0);
  w.engine.stop();
});

it("the tiles replace the chips: スレッド with its unread count, a zero dimmed but still a tap", async () => {
  const { w } = await setup();
  expect(within(home()).queryByRole("button", { name: "未読" })).toBeNull(); // the old unread-only chip
  const tile = (key: string) => home().querySelector<HTMLButtonElement>(`[data-tile="${key}"]`)!;
  expect([...home().querySelectorAll("[data-tile]")].map((t) => t.getAttribute("data-tile"))).toEqual(["threads", "drafts", "saved", "reminders", "calendar", "tasks", "files", "canvases"]);
  expect(tile("threads").getAttribute("aria-label")).toBe("スレッド (1)");
  expect(tile("threads").hasAttribute("data-empty")).toBe(false);
  expect(tile("drafts").hasAttribute("data-empty")).toBe(true);
  expect(tile("drafts").className).toContain("opacity-50");
  expect(tile("files").hasAttribute("data-empty")).toBe(false); // no count
  fireEvent.click(tile("drafts"));
  await flush();
  expect(screen.getByText("送信していない下書きはありません")).toBeTruthy();
  expect(bar()).toBeTruthy(); // a list pushed on the root keeps the bar
  w.engine.stop();
});

it("「未読をまとめる」: a 「未読」 section first gathers the unread conversations, out of their own sections; stored on this device", async () => {
  const { w, dmId } = await setup();
  const sections = () => [...home().querySelectorAll<HTMLElement>("[data-home-section]")].map((s) => s.dataset["homeSection"]);
  expect(sections()).toEqual(["channels", "dms"]);
  expect(rowNames(section("dms"))).toEqual(["Bob", "Alice"]);
  expect(rowNames(section("channels"))).toEqual(["c", "general", "チャンネルを追加"]);
  // Rows are 44 px or more and carry no topic line.
  expect(within(section("channels")!).getByTitle("#c").className).toContain("min-h-11");

  fireEvent.click(within(await openHomeMenu()).getByRole("menuitemcheckbox", { name: "未読をまとめる" }));
  await flush();
  expect(localStorage.getItem(GATHER_UNREAD_KEY)).toBe("1");
  expect(sections()).toEqual(["unread", "channels", "dms"]);
  expect(rowNames(section("unread"))).toEqual(["Alice"]);
  expect(rowNames(section("dms"))).toEqual(["Bob"]);

  // Read (on another device): it goes back to its own section.
  await act(async () => {
    w.server.markRead(w.bob.id, dmId, w.server.channels.get(dmId)!.channel.last_seq);
    await w.engine.idle();
  });
  await flush();
  expect(rowNames(section("unread"))).toEqual([]);
  expect(within(section("unread")!).getByText("未読の会話はありません")).toBeTruthy();
  expect(rowNames(section("dms"))).toEqual(["Bob", "Alice"]);
  w.engine.stop();
});

it("the DM section: my own DM, the 5 newest, then 「すべての DM」 to the DM tab; folded, an unread DM still shows", async () => {
  const { w } = await setup({ extraDms: 6 });
  expect(rowNames(section("dms"))).toEqual(["Bob", "User5", "User4", "User3", "User2", "User1", "Alice", "すべての DM"]);
  fireEvent.click(within(section("dms")!).getByText("ダイレクトメッセージ"));
  await flush();
  expect(rowNames(section("dms"))).toEqual(["Alice"]); // folded: the unread one stays
  fireEvent.click(within(section("dms")!).getByText("ダイレクトメッセージ"));
  await flush();
  fireEvent.click(within(section("dms")!).getByText("すべての DM"));
  await flush();
  expect(selected()).toBe("dm");
  w.engine.stop();
});

it("移動・検索: recent conversations when empty; typing lists 会話, 人 and the message search; a DM lands on the DM tab; Esc closes", async () => {
  const { w, dmId, notesId } = await setup();
  fireEvent.click(within(home()).getByText("移動・検索"));
  expect(jump()).toBeTruthy();
  expect(document.activeElement).toBe(screen.getByPlaceholderText("会話・人・メッセージを検索"));
  expect(jumpRows()).toEqual([]);
  fireEvent.keyDown(screen.getByPlaceholderText("会話・人・メッセージを検索"), { key: "Escape" });
  await flush();
  expect(jump()).toBeNull();
  expect(bar()).toBeTruthy(); // still the home root

  // A conversation opened is recorded (this device, this account).
  fireEvent.click(within(home()).getByTitle("#general"));
  await settle(w);
  await back();
  fireEvent.click(within(home()).getByTitle("#c"));
  await settle(w);
  await back();
  fireEvent.click(within(home()).getByText("移動・検索"));
  expect(within(jump()!).getByText("最近の会話")).toBeTruthy();
  expect(jumpRows()).toEqual(["conversation:c", "conversation:general"]);

  const input = screen.getByPlaceholderText("会話・人・メッセージを検索");
  fireEvent.change(input, { target: { value: "ALI" } });
  expect(jumpRows()).toEqual(["conversation:Alice", "person:Alice", "search:「ALI」をメッセージ検索"]);
  expect(within(jump()!).getByText("会話")).toBeTruthy();
  expect(within(jump()!).getByText("人")).toBeTruthy();
  // Enter opens the first row: the DM, on the DM tab.
  fireEvent.keyDown(input, { key: "Enter" });
  await settle(w);
  expect(jump()).toBeNull();
  expect(w.engine.currentChannelId).toBe(dmId);
  await back();
  expect(selected()).toBe("dm");

  // Me among the people: my own DM.
  fireEvent.click(bar()!.querySelector<HTMLButtonElement>('[data-tab="home"]')!);
  await flush();
  fireEvent.click(within(home()).getByText("移動・検索"));
  fireEvent.change(screen.getByPlaceholderText("会話・人・メッセージを検索"), { target: { value: "@bob" } });
  const person = jump()!.querySelector<HTMLButtonElement>('[data-jump-row="person"]')!;
  expect(person.textContent).toContain("(自分)");
  fireEvent.click(person);
  await settle(w);
  expect(w.engine.currentChannelId).toBe(notesId);
  w.engine.stop();
});

it("✏️: a channel opens with its input focused; people picked make a group DM; my own DM is offered", async () => {
  const { w, carol, createDm, notesId } = await setup();
  const fab = () => within(home()).getByRole("button", { name: "新しいメッセージ" });
  const picker = () => screen.getByRole("dialog", { name: "新しいメッセージ" });
  const picks = (kind: string) => [...picker().querySelectorAll<HTMLElement>(`[data-pick="${kind}"]`)].map((row) => row.querySelector("span.truncate")?.textContent);

  fireEvent.click(fab());
  expect(document.activeElement).toBe(within(picker()).getByLabelText("宛先"));
  expect(picks("self")[0]).toContain("Bob");
  expect(picks("channel")).toEqual(["c", "general"]);
  expect(picks("joinable")).toEqual(["random"]);
  expect(picks("person")).toEqual(["Alice", "Carol"]);
  fireEvent.change(within(picker()).getByLabelText("宛先"), { target: { value: "gen" } });
  expect(picks("channel")).toEqual(["general"]);
  expect(picks("self")).toEqual([]);
  fireEvent.click(picker().querySelector('[data-pick="channel"]')!);
  await settle(w);
  await flush();
  expect(screen.queryByRole("dialog", { name: "新しいメッセージ" })).toBeNull();
  expect(bar()).toBeNull();
  expect(document.activeElement).toBe(document.querySelector(".composer textarea"));
  await back();

  // Two people: a group DM, on the DM tab.
  fireEvent.click(fab());
  fireEvent.click(within(picker()).getByText("Alice").closest("button")!);
  fireEvent.click(within(picker()).getByText("Carol").closest("button")!);
  expect(picks("channel")).toEqual([]); // with people picked, the channels step aside
  fireEvent.click(within(picker()).getByRole("button", { name: "開く" }));
  await settle(w);
  await flush();
  expect(createDm.calls).toEqual([[w.alice.id, carol.id]]);
  const group = [...w.store.channels.values()].find((c) => c.type === "group_dm")!;
  expect(w.engine.currentChannelId).toBe(group.id);
  expect(document.activeElement).toBe(document.querySelector(".composer textarea"));
  await back();
  expect(selected()).toBe("dm");

  // My own DM.
  fireEvent.click(bar()!.querySelector<HTMLButtonElement>('[data-tab="home"]')!);
  await flush();
  fireEvent.click(fab());
  fireEvent.click(picker().querySelector('[data-pick="self"]')!);
  await settle(w);
  expect(w.engine.currentChannelId).toBe(notesId);
  expect(createDm.calls).toHaveLength(1); // it existed
  w.engine.stop();
});

it("⌘K (wide layout) filters and orders by the jump-match rule", async () => {
  compact = false;
  const { w } = await setup();
  expect(bar()).toBeNull();
  fireEvent.keyDown(window, { key: "k", metaKey: true });
  await flush();
  const input = screen.getByPlaceholderText("チャンネル・相手・キャンバスの名前で移動…");
  const items = () => [...document.querySelectorAll("[cmdk-item]")].map((item) => item.querySelector("span.flex-1")?.textContent);
  expect(items()).toEqual(["Alice", "c", "general", "Bob"]); // empty: unread first, then by name (as before)
  fireEvent.change(input, { target: { value: "al" } });
  await flush();
  expect(items()).toEqual(["Alice", "general"]); // starts with, then contains
  fireEvent.change(input, { target: { value: "zzz" } });
  await flush();
  expect(items()).toEqual([]);
  expect(screen.getByText("該当なし")).toBeTruthy();
  w.engine.stop();
});
