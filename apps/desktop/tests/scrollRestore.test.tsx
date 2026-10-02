// @vitest-environment jsdom
/**
 * M75: a conversation comes back where it was left (the real Timeline on a real SyncEngine and the fake server). jsdom
 * has no layout, so rows are laid out by seq: row `seq` sits at (seq - layout.first) × 60 px in a viewport of 15 rows;
 * scrollTop moves `layout.first` by whole rows, scrollIntoView puts a row at the top (or the centre).
 */
import { useState, useSyncExternalStore } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import type { MessageOut } from "../src/api/types";
import type { AppController } from "../src/state/app";
import { clearScrollMemories, conversationScrollKey, scrollMemoryFor } from "../src/ui/scrollMemory";
import { Timeline } from "../src/ui/Timeline";
import { type World, world } from "./unreadWorld";

const ROW = 60;
const ROWS = 15;
const layout = { first: 1 };

const seqsIn = (el: Element): number[] => [...el.querySelectorAll<HTMLElement>("article[data-seq]")].map((row) => Number(row.dataset["seq"]));

beforeEach(() => {
  clearScrollMemories();
  layout.first = 1;
  vi.spyOn(document, "hasFocus").mockReturnValue(true);
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    const seq = this.dataset["seq"] ? Number(this.dataset["seq"]) : null;
    const top = seq === null ? 0 : (seq - layout.first) * ROW;
    const height = seq === null ? ROWS * ROW : ROW;
    return { top, bottom: top + height, height, left: 0, right: 300, width: 300, x: 0, y: top, toJSON: () => ({}) } as DOMRect;
  });
  HTMLElement.prototype.scrollIntoView = function (this: HTMLElement, options?: boolean | ScrollIntoViewOptions) {
    const block = typeof options === "object" ? options.block : undefined;
    const target = this.dataset["seq"] ? this : (this.nextElementSibling as HTMLElement | null); // a divider: the row after it
    const seq = target?.dataset["seq"] ? Number(target.dataset["seq"]) : null;
    if (seq !== null) layout.first = block === "center" ? seq - Math.floor(ROWS / 2) : seq;
  };
  Object.defineProperty(HTMLElement.prototype, "clientHeight", { configurable: true, get: () => ROWS * ROW });
  Object.defineProperty(HTMLElement.prototype, "scrollTop", {
    configurable: true,
    get(this: HTMLElement) {
      const seqs = seqsIn(this);
      return seqs.length ? (layout.first - Math.min(...seqs)) * ROW + 1000 : 0; // never near the top: no automatic paging
    },
    set(this: HTMLElement, value: number) {
      const seqs = seqsIn(this);
      if (!seqs.length) return;
      const lowest = Math.min(...seqs);
      const last = Math.max(lowest, Math.max(...seqs) - ROWS + 1);
      layout.first = Math.min(last, Math.max(lowest, lowest + Math.round((value - 1000) / ROW)));
    },
  });
  Object.defineProperty(HTMLElement.prototype, "scrollHeight", {
    configurable: true,
    get(this: HTMLElement) {
      const seqs = seqsIn(this);
      return seqs.length ? this.scrollTop + ROWS * ROW + Math.max(0, (Math.max(...seqs) - (layout.first + ROWS - 1)) * ROW) : 0;
    },
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  for (const key of ["clientHeight", "scrollTop", "scrollHeight"]) delete (HTMLElement.prototype as unknown as Record<string, unknown>)[key];
});

function controllerFor(w: World) {
  return {
    store: w.store,
    engine: w.engine,
    api: undefined,
    activeServer: "https://chat.example",
    setError: vi.fn(),
    messageFocus: null as AppController["messageFocus"],
    editing: null,
    sendKey: "shift-enter",
    clearMessageFocus() {
      this.messageFocus = null;
    },
  };
}

/** The app's conversation switch (the sidebar): one Timeline for whichever conversation is shown, or none (a view). */
function screenFor(w: World, controller: ReturnType<typeof controllerFor>) {
  const shown = { show: (_id: string | null) => {} };
  function Screen() {
    const [id, setId] = useState<string | null>(w.channelId);
    shown.show = setId;
    useSyncExternalStore(
      (listener) => {
        const a = w.store.subscribe(listener);
        const b = w.engine.subscribe(listener);
        return () => {
          a();
          b();
        };
      },
      () => `${w.store.version}:${w.engine.status}`,
    );
    const channel = id ? w.store.getChannel(id) : undefined;
    return channel ? <Timeline controller={controller as unknown as AppController} channel={channel} /> : <p>view</p>;
  }
  return { Screen, shown };
}

const serverRead = (w: World) => w.server.readState(w.bob.id, w.channelId).last_read_seq;

async function settle(w: World) {
  await act(async () => {
    await w.engine.flushReads();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await w.engine.flushReads();
  });
}

/** C with 60 posts, all read; D with 20, all read. C is open, at its newest (rows 46..60). */
async function twoConversations() {
  const w = world({ posts: 60, lastRead: 60 });
  const other = w.server.createChannel("d", w.alice.id).id;
  w.server.join(other, w.bob.id);
  for (let i = 1; i <= 20; i++) w.server.post(other, w.alice.id, `d${i}`);
  w.server.markRead(w.bob.id, other, w.server.channels.get(other)!.messages.at(-1)!.seq);
  await w.engine.start();
  await w.engine.idle();
  const controller = controllerFor(w);
  const { Screen, shown } = screenFor(w, controller);
  const view = render(<Screen />);
  await act(async () => {
    await w.engine.openChannel(w.channelId);
    await w.engine.idle();
  });
  await settle(w);
  expect(layout.first).toBe(46);
  const go = async (id: string | null) => {
    await act(async () => {
      shown.show(id);
      if (id) await w.engine.openChannel(id);
      await w.engine.idle();
    });
    await settle(w);
  };
  return { w, other, controller, view, go, timeline: () => view.container.querySelector<HTMLElement>(".timeline")! };
}

/** The reader's own scroll: input on the list, then the scroll event. */
function userScrollTo(el: HTMLElement, first: number) {
  layout.first = first;
  fireEvent.wheel(el);
  fireEvent.scroll(el);
}

it("a conversation opened again from the sidebar comes back at the row it was left at", async () => {
  const { w, other, go, timeline } = await twoConversations();
  userScrollTo(timeline(), 20);
  await settle(w);
  await go(other);
  expect(layout.first).toBe(6); // D at its newest
  await go(w.channelId);
  expect(layout.first).toBe(20);
  expect(screen.queryByText("最新のメッセージへ")).toBeTruthy();
  w.engine.stop();
});

it("comes back after the timeline was unmounted (a centre view in between)", async () => {
  const { w, go, timeline } = await twoConversations();
  userScrollTo(timeline(), 25);
  await settle(w);
  await go(null);
  expect(screen.getByText("view")).toBeTruthy();
  await go(w.channelId);
  expect(layout.first).toBe(25);
  w.engine.stop();
});

it("a position in the middle reads nothing below it: new messages there stay unread (§10.1)", async () => {
  const { w, other, go, timeline } = await twoConversations();
  userScrollTo(timeline(), 20);
  await settle(w);
  await go(other);
  for (let i = 61; i <= 65; i++) w.server.post(w.channelId, w.alice.id, `m${i}`);
  await act(async () => {
    await w.engine.idle();
  });
  await go(w.channelId);
  expect(layout.first).toBe(20);
  expect(serverRead(w)).toBe(60);
  expect(w.store.getChannel(w.channelId)!.unreadCount).toBe(5);
  // Scrolling on through them reads them as usual.
  userScrollTo(timeline(), 51);
  await settle(w);
  expect(serverRead(w)).toBe(65);
  w.engine.stop();
});

it("left at the bottom, it opens as usual: at the new messages, or the newest", async () => {
  const { w, other, go } = await twoConversations();
  await go(other);
  await go(w.channelId);
  expect(layout.first).toBe(46);
  await go(other);
  for (let i = 61; i <= 65; i++) w.server.post(w.channelId, w.alice.id, `m${i}`);
  await act(async () => {
    await w.engine.idle();
  });
  await go(w.channelId);
  expect(layout.first).toBe(61); // 「新着メッセージ」 and the first unread row at the top
  expect(screen.getByText("新着メッセージ")).toBeTruthy();
  w.engine.stop();
});

it("an explicit move to a message wins over the remembered row", async () => {
  const { w, other, controller, go, timeline } = await twoConversations();
  userScrollTo(timeline(), 20);
  await settle(w);
  await go(other);
  const rows = w.store.messages(w.channelId);
  const hit = rows.find((m) => m.seq === 40)!;
  controller.messageFocus = { channelId: w.channelId, messageId: hit.id, parentId: null, context: rows.filter((m) => m.seq! >= 30 && m.seq! <= 50) as unknown as MessageOut[] };
  await go(w.channelId);
  expect(layout.first).toBe(33); // the hit centred
  expect(scrollMemoryFor("https://chat.example").get(conversationScrollKey(w.channelId))?.rowKey).toBe(rows.find((m) => m.seq === 20)!.id);
  w.engine.stop();
});

it("falls back to the usual landing when the remembered row is no longer loaded", async () => {
  const { w, other, go } = await twoConversations();
  await go(other);
  scrollMemoryFor("https://chat.example").save(conversationScrollKey(w.channelId), { rowKey: "gone", offset: 0, scrollTop: 0, atBottom: false });
  await go(w.channelId);
  expect(layout.first).toBe(46);
  w.engine.stop();
});
