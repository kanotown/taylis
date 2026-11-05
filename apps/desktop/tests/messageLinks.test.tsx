// @vitest-environment jsdom
/**
 * User report 2026-11-05: links to messages (`<server>/m/<id>`) sometimes did not jump to the message. The real
 * MainScreen, a real SyncEngine and the fake server, a body's link clicked as a reader would:
 * - a link written right before 「」（）。 or `.` (or Japanese without a space) was an ordinary link to the browser;
 * - the same link clicked again after scrolling away did nothing (the timeline and the thread watched the id only);
 * - a link to a message of the conversation on screen, clicked in its 「キャンバス」 tab, scrolled the timeline unseen
 *   under the canvas;
 * - a link into an archived public channel I have not joined dropped its conversation as gone;
 * - a link to a reply whose root was deleted said 「メッセージが見つかりません」 (the server's /context answered 404);
 * - on a phone, a link in a thread to a message of the timeline left the thread over it.
 */
import { useSyncExternalStore } from "react";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import type { ApiClient } from "../src/api/client";
import type { MessageOut } from "../src/api/types";
import { AppController } from "../src/state/app";
import { COMPACT_QUERY } from "../src/ui/compact";
import { MainScreen } from "../src/ui/MainScreen";
import { MessageBody } from "../src/ui/MessageBody";
import { clearScrollMemories } from "../src/ui/scrollMemory";
import { world, type World } from "./unreadWorld";

let compact = false;
/** The ids of the rows scrolled to (scrollIntoView), in order. */
let scrolledTo: string[] = [];

beforeEach(() => {
  clearScrollMemories();
  compact = false;
  scrolledTo = [];
  localStorage.clear();
  vi.stubGlobal("matchMedia", (query: string) => ({ matches: query === COMPACT_QUERY ? compact : false, addEventListener: () => {}, removeEventListener: () => {} }));
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  vi.spyOn(document, "hasFocus").mockReturnValue(true);
  HTMLElement.prototype.scrollIntoView = function (this: HTMLElement) {
    scrolledTo.push(this.id);
  };
  // A wide window (the thread pane beside the conversation); the header's tab strip unmeasured, so it shows every tab.
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    const width = this.parentElement?.hasAttribute("aria-hidden") ? 0 : 1400;
    return { x: 0, y: 0, top: 0, left: 0, right: width, bottom: 900, width, height: 900, toJSON: () => ({}) } as DOMRect;
  });
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
const BASE = "http://server";

/**
 * Bob in #c: 300 posts by alice (only the newest page is loaded on opening), a thread on post 150 with 30 replies.
 * `/context` answers as the server: 25 top-level rows before the message (a reply's root) and 26 from it.
 */
async function setup(options: { publicChannels?: () => Promise<unknown> } = {}) {
  const w = world({ posts: 300, lastRead: 300 });
  const record = w.server.channels.get(w.channelId)!;
  const root = record.messages[149]!;
  const replies = Array.from({ length: 30 }, (_, i) => w.server.post(w.channelId, w.alice.id, `返信 ${i + 1}`, undefined, root.id).message);
  w.server.markRead(w.bob.id, w.channelId, record.channel.last_seq);
  const inner = w.api as unknown as Record<string, unknown>;
  const messageContext = async (id: string): Promise<MessageOut[]> => {
    const holder = [...w.server.channels.values()].find((r) => r.messages.some((m) => m.id === id))!;
    const message = holder.messages.find((m) => m.id === id)!;
    if (message.deleted) throw new Error("404");
    const anchor = message.parent_id ? holder.messages.find((m) => m.id === message.parent_id)! : message;
    const rows = holder.messages.filter((m) => (!m.parent_id || m.also_in_channel) && !m.deleted).sort((a, b) => a.seq - b.seq);
    const before = rows.filter((m) => m.seq < anchor.seq).slice(-25);
    const after = rows.filter((m) => m.seq >= anchor.seq).slice(0, 26);
    return [...before, ...after].map((m) => w.server.viewAs(m, w.bob.id));
  };
  const api = new Proxy<Record<string, unknown>>({ ...inner, baseUrl: BASE, messageContext, ...(options.publicChannels ? { publicChannels: options.publicChannels } : {}) }, { get: (target, key: string) => target[key] ?? (async () => []) }) as unknown as ApiClient;
  w.api.publicChannels = (api as unknown as World["api"]).publicChannels;
  await w.engine.start();
  await w.engine.openChannel(w.channelId);
  await w.engine.idle();
  const controller = new AppController();
  (controller as unknown as { active: unknown }).active = { serverUrl: BASE, username: "bob", api, store: w.store, engine: w.engine, me: w.store.me, leaving: false };
  render(<Screen w={w} controller={controller} />);
  await settle(w);
  return { w, controller, root, replies, posts: record.messages.filter((m) => !m.parent_id) };
}

const title = () => document.querySelector("main header strong")?.textContent ?? null;
const timelineRow = (id: string) => document.getElementById(`timeline-${id}`);
const threadRow = (id: string) => document.getElementById(`thread-${id}`);
const timesScrolledTo = (domId: string) => scrolledTo.filter((id) => id === domId).length;
/** alice posts `body` in #c; bob clicks the message link chip of that post (the last one with `label`). */
const postAndClick = async (w: World, body: string, parentId: string | null = null) => {
  const { message } = w.server.post(w.channelId, w.alice.id, body, undefined, parentId);
  await settle(w);
  const row = (parentId ? threadRow(message.id) : timelineRow(message.id))!;
  expect(row).toBeTruthy();
  return { message, click: async () => {
    fireEvent.click(within(row).getByRole("button", { name: /メッセージを表示/ }));
    await settle(w);
    await settle(w);
  } };
};

it("a message link written with Japanese marks or a full stop right after it opens in the app", () => {
  const id = "0190a8c2-7d3e-7b1a-9c4e-1f2a3b4c5d6e";
  for (const body of [
    `古いメッセージ（${BASE}/m/${id}）を参照`,
    `「${BASE}/m/${id}」を見て`,
    `${BASE}/m/${id}を見て`,
    `${BASE}/m/${id}.`,
    `<${BASE}/m/${id}>`,
    `${BASE.replace("http:", "https:")}/m/${id.toUpperCase()}?x=1#y`,
    `${BASE}/m/${id}/`,
  ]) {
    const open = vi.fn();
    const { container, unmount } = render(<MessageBody body={body} users={new Map()} internalBase={BASE} onOpenMessage={open} />);
    expect(container.querySelector("a"), body).toBeNull();
    fireEvent.click(within(container).getByRole("button", { name: /メッセージを表示/ }));
    expect(open, body).toHaveBeenCalledWith(id);
    // What was around the link stays as text.
    for (const mark of ["）を参照", "」を見て", "を見て", "."]) if (body.endsWith(mark)) expect(container.textContent).toContain(mark);
    unmount();
  }
  // Another server's link stays an ordinary link.
  const { container } = render(<MessageBody body={`https://chat.example.com/m/${id}`} users={new Map()} internalBase={BASE} onOpenMessage={vi.fn()} />);
  expect(container.querySelector("a")?.getAttribute("href")).toBe(`https://chat.example.com/m/${id}`);
});

it("a link to a message far back in the history loads around it, scrolls there and highlights it; again after scrolling away", async () => {
  const { w, controller, posts } = await setup();
  const old = posts[4]!;
  expect(timelineRow(old.id)).toBeNull(); // not loaded
  const link = await postAndClick(w, `古いメッセージ（${BASE}/m/${old.id}）を参照`);
  await link.click();
  expect(controller.messageFocus?.messageId).toBe(old.id);
  expect(timelineRow(old.id)).toBeTruthy();
  expect(timelineRow(old.id)!.className).toMatch(/highlight|bg-/);
  expect(timesScrolledTo(`timeline-${old.id}`)).toBe(1);
  // The reader scrolls away and clicks the same link again (the link's row is in the window too: the timeline shows the
  // window, so they find it with 「最新の会話に戻る」 or another link to it).
  await act(async () => { await controller.openPermalink(old.id); });
  await settle(w);
  expect(timesScrolledTo(`timeline-${old.id}`)).toBe(2);
  w.engine.stop();
});

it("a link to a message of the conversation on screen, clicked in its canvas tab, brings 「メッセージ」 back", async () => {
  const { w, controller, posts } = await setup();
  const target = posts[290]!;
  const tabs = within(screen.getByRole("tablist", { name: "会話の表示" }));
  fireEvent.click(tabs.getByRole("tab", { name: "キャンバス" }));
  await settle(w);
  expect(tabs.getByRole("tab", { name: "キャンバス" }).getAttribute("aria-selected")).toBe("true");
  // A link in the canvas (CanvasBody's onOpenMessage is controller.openPermalink).
  await act(async () => { await controller.openPermalink(target.id); });
  await settle(w);
  expect(tabs.getByRole("tab", { name: "メッセージ" }).getAttribute("aria-selected")).toBe("true");
  expect(timesScrolledTo(`timeline-${target.id}`)).toBe(1);
  w.engine.stop();
});

it("a link into an archived public channel I have not joined opens its preview at the message", async () => {
  let listed = true;
  const holder: { w?: World } = {};
  const { w, controller } = await setup({
    // As the server: the browsable list leaves archived channels out.
    publicChannels: async () => [...holder.w!.server.channels.values()].filter((r) => r.channel.type === "public" && !r.members.has(holder.w!.bob.id) && !r.channel.archived && listed).map((r) => ({ ...r.channel, member_count: r.members.size, membership: null })),
  }).then((s) => { holder.w = s.w; return s; });
  void listed;
  const old = w.server.createChannel("old", w.alice.id);
  const { message } = w.server.post(old.id, w.alice.id, "アーカイブ前の投稿");
  w.server.channels.get(old.id)!.channel.archived = true;
  listed = false;
  expect(w.store.getChannel(old.id)).toBeUndefined();
  await act(async () => { expect(await controller.openPermalink(message.id)).toBe(true); });
  await settle(w);
  expect(title()).toBe("old");
  expect(screen.getByText("アーカイブ前の投稿")).toBeTruthy();
  w.engine.stop();
});

it("a link to a reply opens its thread at the reply, and scrolls there again when clicked again", async () => {
  const { w, controller, root, replies } = await setup();
  const target = replies[2]!;
  const link = await postAndClick(w, `「${BASE}/m/${target.id}」を見て`);
  await link.click();
  expect(controller.messageFocus?.parentId).toBe(root.id);
  expect(threadRow(target.id)).toBeTruthy();
  const first = timesScrolledTo(`thread-${target.id}`);
  expect(first).toBeGreaterThan(0);
  // A link inside the thread to the same reply, clicked after scrolling away.
  const inThread = await postAndClick(w, `${BASE}/m/${target.id}`, root.id);
  await inThread.click();
  expect(timesScrolledTo(`thread-${target.id}`)).toBeGreaterThan(first);
  w.engine.stop();
});

it("a link to a reply whose root was deleted opens its thread saying so", async () => {
  const { w, controller, posts } = await setup();
  const goneRoot = posts[200]!;
  const { message: reply } = w.server.post(w.channelId, w.alice.id, "消された親への返信", undefined, goneRoot.id);
  w.server.delete(w.channelId, w.alice.id, goneRoot.id);
  await settle(w);
  await act(async () => { expect(await controller.openPermalink(reply.id)).toBe(true); });
  await settle(w);
  expect(controller.error).toBeNull();
  expect(screen.getByText("元のメッセージは削除されました")).toBeTruthy();
  w.engine.stop();
});

it("a deleted message's link says it is not found", async () => {
  const { w, controller, posts } = await setup();
  w.server.delete(w.channelId, w.alice.id, posts[10]!.id);
  await settle(w);
  await act(async () => { expect(await controller.openPermalink(posts[10]!.id)).toBe(false); });
  expect(controller.error).toBeTruthy();
  w.engine.stop();
});

it("on a phone, a link in a thread to a message of the timeline leaves the thread for the timeline", async () => {
  compact = true;
  const { w, controller, root, replies, posts } = await setup();
  await act(async () => { await controller.openPermalink(replies[0]!.id); });
  await settle(w);
  expect(threadRow(replies[0]!.id)).toBeTruthy();
  await act(async () => { await controller.openPermalink(posts[280]!.id); });
  await settle(w);
  expect(threadRow(replies[0]!.id)).toBeNull();
  expect(timelineRow(posts[280]!.id)).toBeTruthy();
  expect(timesScrolledTo(`timeline-${posts[280]!.id}`)).toBe(1);
  // A link to the thread's root keeps the thread (it shows the root at its top).
  await act(async () => { await controller.openPermalink(replies[1]!.id); });
  await settle(w);
  await act(async () => { await controller.openPermalink(root.id); });
  await settle(w);
  expect(threadRow(replies[1]!.id)).toBeTruthy();
  w.engine.stop();
});

it("a message link pinned to the conversation's links bar opens in the app", async () => {
  const { w, controller, posts } = await setup();
  const target = posts[3]!;
  act(() => w.store.setChannelLinks(w.channelId, [{ id: "l1", title: "前の話", url: `${BASE}/m/${target.id}`, position: 0, created_by: w.alice.id, created_at: new Date().toISOString() }]));
  await settle(w);
  const open = vi.spyOn(window, "open").mockImplementation(() => null);
  fireEvent.click(within(screen.getByLabelText("リンク")).getByRole("link", { name: /前の話/ }));
  await settle(w);
  await settle(w);
  expect(open).not.toHaveBeenCalled();
  expect(controller.messageFocus?.messageId).toBe(target.id);
  expect(timesScrolledTo(`timeline-${target.id}`)).toBe(1);
  w.engine.stop();
});
