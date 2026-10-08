// @vitest-environment jsdom
/**
 * THREADS.md §5 「元のメッセージの削除」 on the real MainScreen (wide layout), a real SyncEngine and the fake server: the
 * open thread closes when its root is deleted (an event: with 「元のメッセージが削除されたため、スレッドを閉じました」; my
 * own delete from the thread pane: without), the threads list and the reply draft drop it, and a thread opened when its
 * root is already gone says so instead of showing an empty thread.
 */
import { useSyncExternalStore } from "react";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import type { ApiClient } from "../src/api/client";
import type { MessageOut } from "../src/api/types";
import { AppController } from "../src/state/app";
import { COMPACT_QUERY } from "../src/ui/compact";
import { MainScreen } from "../src/ui/MainScreen";
import { clearScrollMemories } from "../src/ui/scrollMemory";
import { chooseFromRowMenu } from "./rowMenu";
import { world, type World } from "./unreadWorld";

const CLOSED_NOTICE = "元のメッセージが削除されたため、スレッドを閉じました";

beforeEach(() => {
  clearScrollMemories();
  localStorage.clear();
  vi.stubGlobal("matchMedia", (query: string) => ({ matches: query === COMPACT_QUERY ? false : query !== "(hover: none)", addEventListener: () => {}, removeEventListener: () => {} }));
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
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

/** Bob (me) in #c: Alice's post with Alice's reply, and my own post with Alice's reply. */
async function setup() {
  const w = world({ posts: 1, lastRead: 1 });
  const theirs = w.server.channels.get(w.channelId)!.messages[0]!;
  w.server.post(w.channelId, w.alice.id, "アリスの返信", undefined, theirs.id);
  const mine = w.server.post(w.channelId, w.bob.id, "ボブの親").message;
  w.server.post(w.channelId, w.alice.id, "ボブへの返信", undefined, mine.id);
  w.server.markRead(w.bob.id, w.channelId, 4);
  const inner = w.api as unknown as Record<string, unknown>;
  const getMessage = w.api.getMessage as (id: string) => Promise<MessageOut>;
  const messageContext = async (id: string) => [await getMessage(id)];
  const deleteMessage = async (id: string) => w.server.delete(w.channelId, w.bob.id, id);
  const api = new Proxy<Record<string, unknown>>({ ...inner, messageContext, deleteMessage }, { get: (target, key: string) => target[key] ?? (async () => []) }) as unknown as ApiClient;
  await w.engine.start();
  await w.engine.idle();
  const controller = new AppController();
  (controller as unknown as { active: unknown }).active = { serverUrl: "http://server", username: "bob", api, store: w.store, engine: w.engine, me: w.store.me, leaving: false };
  render(<Screen w={w} controller={controller} />);
  await settle(w);
  return { w, controller, theirs, mine };
}

/** The thread pane (the right column), or null. */
const threadPane = () => screen.queryByLabelText("スレッドのメッセージ一覧")?.closest("aside") ?? null;
const openThread = async (w: World, id: string) => {
  const row = document.getElementById(`timeline-${id}`)!;
  fireEvent.click(within(row).getByRole("button", { name: /1 件の返信/ }));
  await settle(w);
};

it("the root deleted by someone else (an event): the thread closes with the notice", async () => {
  const { w, controller, theirs } = await setup();
  await openThread(w, theirs.id);
  expect(threadPane()).not.toBeNull();
  expect(screen.getByText("アリスの返信")).toBeTruthy();

  await act(async () => { w.server.delete(w.channelId, w.alice.id, theirs.id); });
  await settle(w);
  expect(threadPane()).toBeNull();
  expect(screen.queryByText("アリスの返信")).toBeNull();
  expect(controller.notice).toBe(CLOSED_NOTICE);
  expect(screen.getByRole("status").textContent).toContain(CLOSED_NOTICE);
  w.engine.stop();
});

it("my own delete from the thread pane's root row closes it without a notice; from the channel, with one", async () => {
  const { w, controller, mine, theirs } = await setup();
  await openThread(w, mine.id);
  const root = document.getElementById(`thread-${mine.id}`)!;
  expect(root).not.toBeNull();
  await chooseFromRowMenu("削除", root);
  fireEvent.click(within(screen.getByRole("dialog", { name: "メッセージの削除" })).getByRole("button", { name: "削除する" }));
  await settle(w);
  expect(threadPane()).toBeNull();
  expect(controller.notice).toBeNull();

  // Alice deleting her own post while I have its thread open: someone else's deletion.
  await openThread(w, theirs.id);
  expect(threadPane()).not.toBeNull();
  await act(async () => { w.server.delete(w.channelId, w.alice.id, theirs.id); });
  await settle(w);
  expect(threadPane()).toBeNull();
  expect(controller.notice).toBe(CLOSED_NOTICE);
  w.engine.stop();
});

it("a thread opened after its root was deleted (a stale link) says so: no replies, no composer, no notice", async () => {
  const { w, controller, theirs } = await setup();
  const reply = w.server.channels.get(w.channelId)!.messages.find((m) => m.parent_id === theirs.id)!;
  await act(async () => { w.server.delete(w.channelId, w.alice.id, theirs.id); });
  await settle(w);
  await act(async () => { await controller.openPermalink(reply.id); });
  await settle(w);
  const pane = document.querySelector("aside") as HTMLElement;
  expect(within(pane).getByText("元のメッセージは削除されました")).toBeTruthy();
  expect(within(pane).queryByText("アリスの返信")).toBeNull();
  expect(within(pane).queryByRole("textbox")).toBeNull();
  expect(controller.notice).toBeNull();
  expect(controller.error).toBeNull(); // the replies' 404 is the deleted state, not an error
  w.engine.stop();
});

it("the store: a deleted root leaves the threads list and takes its reply draft with it", async () => {
  const { w, mine } = await setup();
  await act(async () => { await w.engine.loadThreads("all"); });
  expect(w.store.threads.has(mine.id)).toBe(true); // I follow my own post's thread
  act(() => w.store.setDraft(w.channelId, mine.id, { text: "書きかけ" }));
  act(() => w.store.setDraft(w.channelId, null, { text: "チャンネルの書きかけ" }));
  // Deleted on another device of mine: the event.
  await act(async () => { w.server.delete(w.channelId, w.bob.id, mine.id); });
  await settle(w);
  expect(w.store.threads.has(mine.id)).toBe(false);
  expect(w.store.wasDeleted(mine.id)).toBe(true);
  expect(w.store.draft(w.channelId, mine.id).text).toBe("");
  expect(w.store.draft(w.channelId, null).text).toBe("チャンネルの書きかけ");
  w.engine.stop();
});

it("the engine: replies answering 404 (a deletion missed while away) forget the thread instead of failing", async () => {
  const { w, theirs } = await setup();
  w.store.setDraft(w.channelId, theirs.id, { text: "書きかけ" });
  // The deletion happens where this device does not see it (no event reaches the store).
  const record = w.server.channels.get(w.channelId)!;
  const index = record.messages.findIndex((m) => m.id === theirs.id);
  record.messages[index] = { ...record.messages[index]!, deleted: true, body: "" };
  let ok: boolean | undefined;
  await act(async () => { ok = await w.engine.loadReplies(w.channelId, theirs.id); });
  expect(ok).toBe(false);
  expect(w.store.wasDeleted(theirs.id)).toBe(true);
  expect(w.store.message(w.channelId, theirs.id)).toBeUndefined();
  expect(w.store.draft(w.channelId, theirs.id).text).toBe("");
  w.engine.stop();
});
