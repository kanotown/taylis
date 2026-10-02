// @vitest-environment jsdom
/**
 * M39 (Web): the activity, stage B, on the real MainScreen with a real SyncEngine and the fake server — the phone's
 * アクティビティ tab and the wide layout's 「アクティビティ」: filters, rows, dots, being on screen reads it, 「すべて既読」,
 * paging, opening a row, the badges, and 「リアクションのバナー」 in the settings.
 */
import { useSyncExternalStore } from "react";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import type { ApiClient } from "../src/api/client";
import type { UserMe, UserUpdate } from "../src/api/types";
import { AppController } from "../src/state/app";
import { ACTIVITY_READ_DELAY_MS } from "../src/ui/ActivityView";
import { COMPACT_QUERY } from "../src/ui/compact";
import { MainScreen } from "../src/ui/MainScreen";
import { world, type World } from "./unreadWorld";

let compact = true;

beforeEach(() => {
  compact = true;
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
 * Channel C (alice's m1..m3, read by bob) with carol in it too; bob's own post, a thread under m1 bob follows with
 * alice's reply, alice's mention of bob, then alice's 👍 and carol's 🎉 on bob's post: three unread items, newest first
 * the reaction, the mention, the reply. `mentions` more mentions before all that (paging).
 */
async function setup(options: { activity?: boolean; mentions?: number } = {}) {
  const w = world({ posts: 3, lastRead: 3 });
  w.server.activityEnabled = options.activity ?? true;
  const carol = w.server.addUser("carol");
  w.server.join(w.channelId, carol.id);
  for (let i = 1; i <= (options.mentions ?? 0); i++) w.server.post(w.channelId, w.alice.id, `<@${w.bob.id}> 古いメンション ${i}`);
  const m1 = w.server.channels.get(w.channelId)!.messages[0]!;
  const mine = w.server.post(w.channelId, w.bob.id, "スライド v2 です").message;
  w.server.post(w.channelId, w.bob.id, "bob の返信", undefined, m1.id);
  w.server.post(w.channelId, w.alice.id, "alice の返信", undefined, m1.id);
  w.server.post(w.channelId, w.alice.id, `<@${w.bob.id}> 来週の発表順を決めましょう`);
  w.server.react(w.channelId, w.alice.id, mine.id, "👍", true);
  w.server.react(w.channelId, carol.id, mine.id, "🎉", true);
  const inner = w.api as unknown as Record<string, unknown>;
  const updates: UserUpdate[] = [];
  const extra: Record<string, unknown> = {
    messageContext: async (id: string) => [w.server.channels.get(w.channelId)!.messages.find((m) => m.id === id)!],
    updateMe: async (patch: UserUpdate) => {
      updates.push(patch);
      if (patch.notify_reactions === true) w.server.notifyReactions.add(w.bob.id);
      if (patch.notify_reactions === false) w.server.notifyReactions.delete(w.bob.id);
      return { ...w.store.me!, ...patch } as UserMe;
    },
  };
  // Whatever else the screen asks for on the side (custom emoji, sections, drafts …) finds nothing.
  const api = new Proxy({ ...inner, ...extra }, { get: (target, key: string) => target[key] ?? (async () => []) }) as unknown as ApiClient;
  await w.engine.start();
  await w.engine.idle();
  const controller = new AppController();
  (controller as unknown as { active: unknown }).active = { serverUrl: "http://server", username: "bob", api, store: w.store, engine: w.engine, me: w.store.me, leaving: false };
  render(<Screen w={w} controller={controller} />);
  await flush();
  return { w, controller, carol, mine, m1, updates };
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
  await act(async () => {
    await w.engine.idle();
    await w.engine.flushActivity();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
};
/** Long enough on screen for the view to read what it shows. */
const look = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, ACTIVITY_READ_DELAY_MS + 100)); });
const bar = () => screen.queryByRole("navigation", { name: "タブ" });
const tabButton = (tab: string) => bar()!.querySelector<HTMLButtonElement>(`[data-tab="${tab}"]`)!;
const tap = async (tab: string) => {
  fireEvent.click(tabButton(tab));
  await flush();
};
const root = (tab: string) => document.querySelector<HTMLElement>(`[data-tab-root="${tab}"]`)!;
const rows = (scope: HTMLElement = document.body) => [...scope.querySelectorAll<HTMLButtonElement>("button[data-activity]")];
const labels = (scope?: HTMLElement) => rows(scope).map((row) => row.getAttribute("aria-label"));
const dots = (scope?: HTMLElement) => rows(scope).filter((row) => row.dataset["unread"] !== undefined).length;

it("the phone's activity tab: [すべて | メンション | スレッド | リアクション], rows newest first with their dots; on screen a moment, the badge clears and the dots stay until it is left", async () => {
  const { w, controller } = await setup();
  expect(tabButton("activity").getAttribute("aria-label")).toBe("アクティビティ (未読 3)");
  expect(tabButton("activity").querySelector("[data-badge]")?.getAttribute("data-badge")).toBe("danger");
  await tap("activity");
  const activity = root("activity");
  const filters = within(activity).getAllByRole("radio").map((radio) => [radio.textContent, radio.getAttribute("aria-checked")]);
  expect(filters).toEqual([["すべて", "true"], ["メンション", "false"], ["スレッド", "false"], ["リアクション", "false"]]);
  expect(labels(activity)).toEqual([
    "未読 Alice ほか 1 人が 🎉👍 · #c",
    "未読 Alice がメンション · #c",
    "未読 Alice がスレッドに返信 · #c",
  ]);
  expect(within(activity).getByText("「スライド v2 です」")).toBeTruthy(); // my message, under its reactions
  expect(within(activity).getByText("#c のスレッド")).toBeTruthy();
  expect(within(activity).getByText("@Bob 来週の発表順を決めましょう")).toBeTruthy();

  await look();
  await settle(w);
  // Read up to the newest row (the reaction): the badge is gone, the dots stay while looking.
  const newest = w.server.activityItems(w.bob.id)[0]!.at;
  expect(w.server.activityReadAt.get(w.bob.id)).toBe(newest);
  expect(w.store.activity).toMatchObject({ read_at: newest, unread_count: 0 });
  expect(dots(activity)).toBe(3);
  // Left and back: what was seen is read.
  await tap("home");
  expect(bar()!.querySelector('[data-tab="activity"] [data-badge]')).toBeNull();
  expect(tabButton("activity").getAttribute("aria-label")).toBe("アクティビティ");
  await tap("activity");
  await settle(w);
  expect(dots(root("activity"))).toBe(0);
  expect(controller.error).toBeNull();
  w.engine.stop();
});

it("filters list one kind each (GET /activity?filter=…); new activity while looking comes in with its dot and is read in turn", async () => {
  const { w, carol, mine } = await setup();
  await tap("activity");
  const activity = root("activity");
  fireEvent.click(within(activity).getByRole("radio", { name: "リアクション" }));
  await settle(w);
  expect(labels(activity)).toEqual(["未読 Alice ほか 1 人が 🎉👍 · #c"]);
  fireEvent.click(within(activity).getByRole("radio", { name: "メンション" }));
  await settle(w);
  expect(labels(activity)).toEqual(["未読 Alice がメンション · #c"]);
  fireEvent.click(within(activity).getByRole("radio", { name: "スレッド" }));
  await settle(w);
  expect(labels(activity)).toEqual(["未読 Alice がスレッドに返信 · #c"]);
  expect(w.server.activityRequests.map((r) => r.filter)).toEqual(["all", "reactions", "mentions", "threads"]);

  fireEvent.click(within(activity).getByRole("radio", { name: "すべて" }));
  await settle(w);
  await look();
  await settle(w);
  expect(w.store.activity?.unread_count).toBe(0);
  // Carol reacts again (🙏): the badge rises, the list comes again with that row on top, then it is read.
  await act(async () => {
    w.server.react(w.channelId, carol.id, mine.id, "🙏", true);
  });
  await settle(w);
  await settle(w);
  expect(labels(activity)[0]).toBe("未読 Alice ほか 1 人が 🎉👍🙏 · #c");
  await look();
  await settle(w);
  expect(w.store.activity?.unread_count).toBe(0);
  w.engine.stop();
});

it("⋯ → 「すべて既読」 clears the dots and the badge at once (PUT /activity/read)", async () => {
  const { w } = await setup();
  await tap("activity");
  const activity = root("activity");
  expect(dots(activity)).toBe(3);
  fireEvent.keyDown(within(activity).getByRole("button", { name: "アクティビティのメニュー" }), { key: "Enter" });
  fireEvent.click(await screen.findByRole("menuitem", { name: "すべて既読" }));
  await settle(w);
  expect(dots(activity)).toBe(0);
  expect(w.store.activity?.unread_count).toBe(0);
  expect(w.server.activitySummary(w.bob.id).unread_count).toBe(0);
  w.engine.stop();
});

it("pages: 「さらに読み込む」 brings the rows after the first 50", async () => {
  const { w } = await setup({ mentions: 55 });
  await tap("activity");
  const activity = root("activity");
  expect(rows(activity)).toHaveLength(50);
  fireEvent.click(within(activity).getByRole("button", { name: "さらに読み込む" }));
  await settle(w);
  expect(rows(activity)).toHaveLength(58);
  expect(within(activity).queryByRole("button", { name: "さらに読み込む" })).toBeNull();
  expect(w.server.activityRequests.at(-1)?.cursor).toBeTruthy();
  w.engine.stop();
});

it("a row opens its message: a mention in its conversation, a reply in its thread over the activity tab; ← back to the list", async () => {
  const { w } = await setup();
  await tap("activity");
  const activity = root("activity");
  fireEvent.click(rows(activity)[1]!); // the mention
  await settle(w);
  expect(bar()).toBeNull();
  expect(document.querySelector(".timeline")).toBeTruthy();
  expect(w.engine.currentChannelId).toBe(w.channelId);
  fireEvent.click(within(screen.getByRole("banner")).getByRole("button", { name: "戻る" }));
  await flush();
  expect(bar()?.querySelector("[aria-current=page]")?.getAttribute("data-tab")).toBe("activity");

  fireEvent.click(rows(activity)[2]!); // the reply
  await settle(w);
  const thread = screen.getByLabelText("スレッドのメッセージ一覧").closest("aside")!;
  expect(within(thread).getByText("alice の返信")).toBeTruthy();
  expect(bar()).toBeNull();
  expect(document.querySelector(".timeline")).toBeNull(); // the thread only, not its channel
  fireEvent.click(within(thread).getByRole("button", { name: "戻る" }));
  await flush();
  expect(screen.queryByLabelText("スレッドのメッセージ一覧")).toBeNull();
  expect(bar()?.querySelector("[aria-current=page]")?.getAttribute("data-tab")).toBe("activity");
  w.engine.stop();
});

it("the wide layout: 「アクティビティ」 in the sidebar with the same badge opens the same view; a row reveals its message in its conversation", async () => {
  compact = false;
  const { w } = await setup();
  const entry = screen.getByRole("button", { name: "アクティビティ (未読 3)" });
  expect(entry.querySelector("[data-badge]")?.getAttribute("data-badge")).toBe("danger");
  fireEvent.click(entry);
  await settle(w);
  const view = screen.getByRole("region", { name: "アクティビティ" });
  expect(within(view).getAllByRole("radio").map((radio) => radio.textContent)).toEqual(["すべて", "メンション", "スレッド", "リアクション"]);
  expect(labels(view)).toHaveLength(3);
  fireEvent.click(rows(view)[1]!);
  await settle(w);
  expect(screen.queryByRole("region", { name: "アクティビティ" })).toBeNull();
  expect(document.querySelector(".timeline")).toBeTruthy();
  expect(w.engine.currentChannelId).toBe(w.channelId);
  w.engine.stop();
});

it("a server before M39: the wide sidebar keeps 「メンション」 (the mentions list), with no badge", async () => {
  compact = false;
  const { w } = await setup({ activity: false });
  expect(w.store.activity).toBeNull();
  expect(screen.getByRole("button", { name: "メンション" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: /^アクティビティ/ })).toBeNull();
  w.engine.stop();
});

it("「自分」: 「リアクションのバナー」 (off at first, 「オフでもアクティビティに表示されます」) is saved with PATCH /users/me", async () => {
  const { w, updates } = await setup();
  await tap("you");
  // M40: 「自分」 → 「通知」.
  fireEvent.click(within(root("you")).getByRole("button", { name: "通知" }));
  await flush();
  const you = root("you");
  const toggle = within(you).getByRole("switch", { name: /リアクションのバナー/ }) as HTMLInputElement;
  expect(within(you).getByText("オフでもアクティビティに表示されます")).toBeTruthy();
  expect(toggle.checked).toBe(false);
  fireEvent.click(toggle);
  await settle(w);
  expect(updates).toEqual([{ notify_reactions: true }]);
  expect(w.store.me?.notify_reactions).toBe(true);
  expect(toggle.checked).toBe(true);
  w.engine.stop();
});

it("M76: a canvas that mentions me is a row (📝, 「Alice が「議事録」であなたをメンションしました」, the excerpt) that counts as a mention and opens the canvas", async () => {
  compact = false;
  const { w, controller } = await setup();
  const canvas = { id: "cv1", channel_id: w.channelId, title: "議事録" };
  await act(async () => {
    w.server.mentionInCanvas(w.bob.id, w.alice.id, canvas, "予稿 @Bob");
  });
  await settle(w);
  // canvas.mentioned brings the badge from the server: four unread, a mention among them.
  expect(w.store.activity).toMatchObject({ unread_count: 4, mention_unread: true });
  fireEvent.click(screen.getByRole("button", { name: "アクティビティ (未読 4)" }));
  await settle(w);
  const view = screen.getByRole("region", { name: "アクティビティ" });
  expect(labels(view)[0]).toBe("未読 Alice が「議事録」であなたをメンションしました · #c");
  const row = rows(view)[0]!;
  expect(row.dataset["activity"]).toBe("canvas_mention");
  expect(row.querySelector("[data-kind-icon=canvas]")?.textContent).toBe("📝");
  expect(within(row).getByText("#c のキャンバス")).toBeTruthy();
  expect(within(row).getByText("予稿 @Bob")).toBeTruthy();
  fireEvent.click(within(view).getByRole("radio", { name: "メンション" }));
  await settle(w);
  expect(labels(view)).toEqual(["未読 Alice が「議事録」であなたをメンションしました · #c", "未読 Alice がメンション · #c"]);
  fireEvent.click(within(view).getByRole("radio", { name: "スレッド" }));
  await settle(w);
  expect(labels(view)).toEqual(["未読 Alice がスレッドに返信 · #c"]);

  // Mentioned again while unread: the same row moves (one per canvas), with the new excerpt.
  fireEvent.click(within(view).getByRole("radio", { name: "メンション" }));
  await settle(w);
  await act(async () => {
    w.server.mentionInCanvas(w.bob.id, w.alice.id, canvas, "確認 @Bob");
  });
  await settle(w);
  await settle(w);
  expect(w.server.canvasMentions.get(w.bob.id)).toHaveLength(1);
  expect(rows(view).filter((r) => r.dataset["activity"] === "canvas_mention")).toHaveLength(1);

  // The row opens the canvas: its conversation's 「キャンバス」 tab.
  fireEvent.click(rows(view)[0]!);
  await settle(w);
  expect(screen.queryByRole("region", { name: "アクティビティ" })).toBeNull();
  expect(w.engine.currentChannelId).toBe(w.channelId);
  expect(screen.getByRole("tab", { name: "キャンバス" }).getAttribute("aria-selected")).toBe("true");
  expect(controller.error).toBeNull();
  w.engine.stop();
});

it("M76: an item of a kind this version does not know (a newer server) is skipped, not shown broken", async () => {
  const { w } = await setup();
  const real = w.server.listActivity.bind(w.server);
  w.server.listActivity = (...args: Parameters<typeof real>) => {
    const page = real(...args);
    return { ...page, items: [{ kind: "later_kind" as never, at: new Date().toISOString(), message: null, actor_ids: [w.alice.id], emojis: [] }, ...page.items] };
  };
  await tap("activity");
  expect(labels(root("activity"))).toHaveLength(3);
  w.engine.stop();
});
