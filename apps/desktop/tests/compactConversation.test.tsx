// @vitest-environment jsdom
/**
 * M29 (Web, the narrow layout): the conversation's tab row (メッセージ / ピン留め / ファイル), the channel details page and
 * the thread's ← on the real MainScreen, on a real SyncEngine and the fake server. The whole screen at phone width.
 */
import { useSyncExternalStore } from "react";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import type { ApiClient } from "../src/api/client";
import type { FileListOut, MemberOut, MessageOut } from "../src/api/types";
import { AppController } from "../src/state/app";
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

/** Channel C with five posts by alice and a reply to the first; bob (this device) reads it. */
async function setup() {
  const w = world({ posts: 5, lastRead: 5 });
  const first = w.server.channels.get(w.channelId)!.messages[0]!;
  const reply = w.server.post(w.channelId, w.alice.id, "a reply", undefined, first.id).message;
  const inner = w.api as unknown as Record<string, unknown>;
  const pinned = { ...first, body: "ピンの本文" } as unknown as MessageOut;
  const pinnedReply = { ...reply, body: "返信のピン" } as unknown as MessageOut;
  const members: MemberOut[] = [w.alice.id, w.bob.id].map((user_id) => ({ user_id, role: user_id === w.alice.id ? "owner" : "member", joined_at: "" }) as MemberOut);
  const calls = { pins: 0, files: [] as Array<string | null | undefined>, members: 0 };
  const extra: Record<string, unknown> = {
    listPins: async () => { calls.pins += 1; return [pinned, pinnedReply]; },
    listFiles: async (options: { channelId?: string | null }) => { calls.files.push(options.channelId); return { items: [], next_cursor: null } satisfies FileListOut; },
    members: async () => { calls.members += 1; return members; },
    messageContext: async () => [first],
    replies: async () => [],
  };
  // Whatever else the screen asks for on the side (custom emoji, sections, drafts …) finds nothing.
  const api = new Proxy({ ...inner, ...extra }, { get: (target, key: string) => target[key] ?? (async () => []) }) as unknown as ApiClient;
  await w.engine.start();
  await w.engine.idle();
  const controller = new AppController();
  (controller as unknown as { active: unknown }).active = { serverUrl: "http://server", username: "bob", api, store: w.store, engine: w.engine, me: w.store.me, leaving: false };
  render(<Screen w={w} controller={controller} />);
  // Open the conversation from the list, as a tap on it does.
  await act(async () => {
    window.dispatchEvent(new CustomEvent("chikuwa:open-channel", { detail: w.channelId }));
    await w.engine.idle();
  });
  return { w, controller, calls, first };
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

const tab = (name: string) => within(screen.getByRole("tablist")).getByRole("tab", { name });
const selectedTab = () => within(screen.getByRole("tablist")).getAllByRole("tab").find((t) => t.getAttribute("aria-selected") === "true")?.textContent;
const timeline = () => document.querySelector<HTMLElement>(".timeline");
const flush = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });

it("the tabs switch the body in place: the conversation stays mounted, hidden and out of reach, under pins and files", async () => {
  const { calls, w } = await setup();
  const list = timeline()!;
  expect(list).toBeTruthy();
  expect(screen.getByText("m5")).toBeTruthy();
  expect(selectedTab()).toBe("メッセージ");
  expect(list.closest("[inert]")).toBeNull();
  expect(document.querySelector(".composer")?.closest("[inert]")).toBeNull();

  fireEvent.click(tab("ピン留め"));
  await flush();
  expect(selectedTab()).toBe("ピン留め");
  expect(screen.getByRole("tabpanel", { name: "ピン留め" })).toBeTruthy();
  expect(screen.getByText("ピンの本文")).toBeTruthy();
  expect(calls.pins).toBe(1);
  // The same timeline element (not remounted), now hidden with the composer.
  expect(timeline()).toBe(list);
  expect(list.closest("[inert]")?.className).toContain("invisible");
  expect(document.querySelector(".composer")?.closest("[inert]")).toBeTruthy();

  fireEvent.click(tab("ファイル"));
  await flush();
  expect(screen.getByRole("tabpanel", { name: "ファイル" })).toBeTruthy();
  expect(calls.files).toEqual([w.channelId]); // this channel only
  expect(screen.queryByRole("combobox", { name: "チャンネル" })).toBeNull(); // no channel choice
  expect(screen.getByPlaceholderText("ファイル名で絞り込む")).toBeTruthy();
  expect(timeline()).toBe(list);

  fireEvent.click(tab("メッセージ"));
  expect(screen.queryByRole("tabpanel")).toBeNull();
  expect(timeline()).toBe(list);
  expect(list.closest("[inert]")).toBeNull();
  w.engine.stop();
});

it("Back from 「ピン留め」 or 「ファイル」 returns to 「メッセージ」 first; Esc and the header's ← too; a conversation opens on 「メッセージ」", async () => {
  const { w } = await setup();
  const list = timeline()!;
  const conversation = history.state;
  const push = vi.spyOn(history, "pushState");
  fireEvent.click(tab("ピン留め"));
  fireEvent.click(tab("ファイル"));
  expect(push).toHaveBeenCalledTimes(1); // pins and files share one entry
  act(() => window.dispatchEvent(new PopStateEvent("popstate", { state: conversation })));
  expect(selectedTab()).toBe("メッセージ");
  expect(timeline()).toBe(list);

  fireEvent.click(tab("ピン留め"));
  fireEvent.keyDown(window, { key: "Escape" });
  expect(selectedTab()).toBe("メッセージ");

  fireEvent.click(tab("ファイル"));
  fireEvent.click(within(screen.getByRole("banner")).getByRole("button", { name: "戻る" }));
  expect(selectedTab()).toBe("メッセージ"); // not the list yet
  expect(timeline()).toBe(list);

  // Opening the conversation again starts on 「メッセージ」.
  fireEvent.click(tab("ピン留め"));
  await act(async () => {
    window.dispatchEvent(new CustomEvent("chikuwa:open-channel", { detail: w.channelId }));
    await w.engine.idle();
  });
  expect(selectedTab()).toBe("メッセージ");
  w.engine.stop();
});

it("a pin opens its message back on 「メッセージ」 (a reply in its thread)", async () => {
  const { w } = await setup();
  fireEvent.click(tab("ピン留め"));
  await flush();
  fireEvent.click(screen.getByText("ピンの本文"));
  await flush();
  expect(screen.queryByRole("tabpanel")).toBeNull();
  expect(selectedTab()).toBe("メッセージ");
  expect(timeline()?.closest("[inert]")).toBeNull();
  expect(screen.queryByLabelText("スレッドのメッセージ一覧")).toBeNull();

  fireEvent.click(tab("ピン留め"));
  await flush();
  fireEvent.click(screen.getByText("返信のピン"));
  await flush();
  expect(selectedTab()).toBe("メッセージ");
  expect(screen.getByLabelText("スレッドのメッセージ一覧")).toBeTruthy();
  w.engine.stop();
});

it("the channel name opens the details page over the conversation; ← and the browser's Back close it", async () => {
  const { calls, w } = await setup();
  const list = timeline()!;
  const conversation = history.state;
  fireEvent.click(screen.getByTitle("チャンネル情報"));
  await flush();
  const details = screen.getByRole("region", { name: "チャンネル情報" });
  expect(within(details).getByText("トピック")).toBeTruthy();
  expect(within(details).getByText("説明")).toBeTruthy();
  expect(within(details).getByText("すべてのメッセージ")).toBeTruthy();
  expect(within(details).getByText("メンバー（2）")).toBeTruthy();
  expect(within(details).getByText("チャンネルを退出…")).toBeTruthy();
  expect(calls.members).toBe(1);
  expect(timeline()).toBe(list); // still mounted under the page

  fireEvent.click(within(details).getByRole("button", { name: "戻る" }));
  expect(screen.queryByRole("region", { name: "チャンネル情報" })).toBeNull();
  expect(timeline()).toBe(list);

  fireEvent.click(screen.getByTitle("チャンネル情報"));
  expect(screen.getByRole("region", { name: "チャンネル情報" })).toBeTruthy();
  act(() => window.dispatchEvent(new PopStateEvent("popstate", { state: conversation })));
  expect(screen.queryByRole("region", { name: "チャンネル情報" })).toBeNull();

  // 「退出」 from the page asks first, with the existing dialog.
  fireEvent.click(screen.getByTitle("チャンネル情報"));
  fireEvent.click(screen.getByText("チャンネルを退出…"));
  expect(screen.getByRole("heading", { name: /を退出しますか？/ })).toBeTruthy();
  w.engine.stop();
});

it("the thread's header has ← (戻る) on a phone and ✕ in the wide layout", async () => {
  const { w, controller } = await setup();
  const threadPane = () => screen.queryByLabelText("スレッドのメッセージ一覧")?.closest("aside") ?? null;
  fireEvent.click(screen.getByText(/1 件の返信/));
  await flush();
  const thread = threadPane()!;
  expect(within(thread).getByRole("button", { name: "戻る" })).toBeTruthy();
  expect(within(thread).queryByRole("button", { name: "閉じる（Esc）" })).toBeNull();
  fireEvent.click(within(thread).getByRole("button", { name: "戻る" }));
  expect(threadPane()).toBeNull();
  expect(screen.getByRole("tablist")).toBeTruthy();

  // The window widened: no tab row (only the header's 「メッセージ | キャンバス」, M43), the links bar and the header icons
  // as before, and the thread keeps its ✕.
  compact = false;
  act(() => controller.setEditing(null));
  expect(screen.queryByRole("tab", { name: "ピン留め" })).toBeNull();
  expect(screen.getAllByRole("tab").map((t) => t.textContent)).toEqual(["メッセージ", "キャンバス", "予定", "タスク"]);
  expect(screen.getByRole("button", { name: "ピン留め" })).toBeTruthy();
  fireEvent.click(screen.getByText(/1 件の返信/));
  await flush();
  expect(within(threadPane()!).getByRole("button", { name: "閉じる（Esc）" })).toBeTruthy();
  expect(within(threadPane()!).queryByRole("button", { name: "戻る" })).toBeNull();
  w.engine.stop();
});
