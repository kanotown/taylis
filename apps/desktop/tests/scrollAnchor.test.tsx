// @vitest-environment jsdom
/**
 * The timeline keeps still while its content changes height (testers, 2026-10-01: "when opening a channel the scroll
 * position sometimes suddenly jumps a lot"): the decisions in scrollAnchor.ts, then the real Timeline, ThreadPane and
 * PreviewTimeline on a fake layout in which rows have heights that can change, as link cards, photos and videos
 * arriving change them.
 */
import { useSyncExternalStore } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { UserMe } from "../src/api/types";
import type { AppController } from "../src/state/app";
import { SyncEngine } from "../src/sync/engine";
import { Store } from "../src/sync/store";
import { PreviewTimeline } from "../src/ui/ChannelPreview";
import { anchorCorrection, BOTTOM_SLACK_PX, firstRowBelow, JUMP_BUTTON_PX, jumpToLatestShown, stillAtBottom, unseenBelow } from "../src/ui/scrollAnchor";
import { ThreadPane } from "../src/ui/ThreadPane";
import { Timeline } from "../src/ui/Timeline";
import { FakeServer } from "./fakeServer";
import { threadWorld, type World, world } from "./unreadWorld";

describe("decisions", () => {
  it("stays at the bottom while content grows under it, and leaves it only on a scroll up", () => {
    expect(stillAtBottom(false, 500, 500, BOTTOM_SLACK_PX - 1)).toBe(true); // near the end
    expect(stillAtBottom(true, 500, 500, 300)).toBe(true); // a card arrived: scrollTop did not move
    expect(stillAtBottom(true, 500, 800, 300)).toBe(true); // pinned again part way
    expect(stillAtBottom(true, 500, 499.5, 300)).toBe(true); // rounding
    expect(stillAtBottom(true, 500, 200, 300)).toBe(false); // the reader scrolled up
    expect(stillAtBottom(false, 500, 500, 300)).toBe(false); // was not at the bottom
  });

  it("finds the topmost row on screen by bisection", () => {
    const bottoms = [-100, -20, 0.5, 40, 100, 160];
    expect(firstRowBelow(bottoms.length, (i) => bottoms[i]!, 0)).toBe(3); // 0.5 is within the pixel of slack
    expect(firstRowBelow(bottoms.length, (i) => bottoms[i]!, -200)).toBe(0);
    expect(firstRowBelow(bottoms.length, (i) => bottoms[i]!, 500)).toBe(-1);
    expect(firstRowBelow(0, () => 0, 0)).toBe(-1);
  });

  it("shows the button to the newest row away from the end, counting rows from others the reader has not had on screen", () => {
    expect(jumpToLatestShown(true, 5000)).toBe(false); // following the end (content growing under it)
    expect(jumpToLatestShown(false, JUMP_BUTTON_PX)).toBe(false); // just above the end
    expect(jumpToLatestShown(false, JUMP_BUTTON_PX + 1)).toBe(true);
    const rows = [
      { seq: 10, sender_id: "alice" },
      { seq: 11, sender_id: "me" },
      { seq: 12, sender_id: "alice" },
      { seq: null, sender_id: "me" }, // my placeholder
    ];
    expect(unseenBelow(rows, 9, "me")).toBe(2);
    expect(unseenBelow(rows, 10, "me")).toBe(1); // my own row is not new
    expect(unseenBelow(rows, 12, "me")).toBe(0);
    expect(unseenBelow(rows, null, "me")).toBe(0); // not positioned yet
  });

  it("corrects by how far the anchor row moved, ignoring sub-pixel rounding", () => {
    expect(anchorCorrection(24, 264)).toBe(240);
    expect(anchorCorrection(24, -40)).toBe(-64);
    expect(anchorCorrection(24, 24.6)).toBe(0);
  });
});

// A fake layout: rows stacked by their heights (60 px unless changed), the list 600 px tall, a real scrollTop.
const VIEW = 600;
const heights = new Map<number, number>();
const tops = new WeakMap<Element, number>();
const resizeCallbacks: ResizeObserverCallback[] = [];

const isList = (el: Element) => el.matches("[data-message-list]");
const rowsOf = (list: Element) => [...list.querySelectorAll<HTMLElement>("article[data-seq]")];
const heightOf = (row: HTMLElement) => heights.get(Number(row.dataset["seq"])) ?? 60;
const contentHeight = (list: Element) => rowsOf(list).reduce((sum, row) => sum + heightOf(row), 0);
const offsetIn = (list: Element, target: HTMLElement) => {
  let y = 0;
  for (const row of rowsOf(list)) {
    if (row === target) return y;
    y += heightOf(row);
  }
  return y;
};
const listOf = (el: Element) => el.closest("[data-message-list]");

beforeEach(() => {
  heights.clear();
  resizeCallbacks.length = 0;
  vi.spyOn(document, "hasFocus").mockReturnValue(true);
  vi.stubGlobal("ResizeObserver", class {
    constructor(callback: ResizeObserverCallback) {
      resizeCallbacks.push(callback);
    }
    observe() {}
    unobserve() {}
    disconnect() {}
  });
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    const list = listOf(this);
    let top = 0;
    let height = 0;
    if (this.matches("article[data-seq]") && list) {
      top = offsetIn(list, this) - list.scrollTop;
      height = heightOf(this);
    } else if (isList(this)) {
      height = VIEW;
    }
    return { top, bottom: top + height, height, left: 0, right: 300, width: 300, x: 0, y: top, toJSON: () => ({}) } as DOMRect;
  });
  HTMLElement.prototype.scrollIntoView = function (this: HTMLElement) {
    const list = listOf(this);
    const row = this.matches("article[data-seq]") ? this : (this.nextElementSibling as HTMLElement | null); // a divider: the row after it
    if (list && row) list.scrollTop = offsetIn(list, row);
  };
  Object.defineProperty(HTMLElement.prototype, "clientHeight", { configurable: true, get(this: HTMLElement) { return isList(this) ? VIEW : 0; } });
  Object.defineProperty(HTMLElement.prototype, "scrollHeight", { configurable: true, get(this: HTMLElement) { return isList(this) ? Math.max(VIEW, contentHeight(this)) : 0; } });
  Object.defineProperty(HTMLElement.prototype, "scrollTop", {
    configurable: true,
    get(this: HTMLElement) {
      return tops.get(this) ?? 0;
    },
    set(this: HTMLElement, value: number) {
      tops.set(this, Math.max(0, Math.min(value, this.scrollHeight - this.clientHeight)));
    },
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  for (const key of ["clientHeight", "scrollTop", "scrollHeight"]) delete (HTMLElement.prototype as unknown as Record<string, unknown>)[key];
});

function View({ w }: { w: World }) {
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
  const channel = w.store.getChannel(w.channelId);
  if (!channel) return null;
  const controller = { store: w.store, engine: w.engine, api: undefined, setError: vi.fn(), messageFocus: null, editing: null, sendKey: "shift-enter" };
  return <Timeline controller={controller as unknown as AppController} channel={channel} />;
}

async function open(w: World) {
  await w.engine.start();
  await w.engine.idle();
  const view = render(<View w={w} />);
  await act(async () => {
    await w.engine.openChannel(w.channelId);
    await w.engine.idle();
  });
  return view.container.querySelector<HTMLElement>(".timeline")!;
}

const rowTop = (list: HTMLElement, seq: number) => list.querySelector<HTMLElement>(`article[data-seq="${seq}"]`)!.getBoundingClientRect().top;
const atEnd = (list: HTMLElement) => list.scrollHeight - list.scrollTop - list.clientHeight;
/** Content changed height: the browser runs the resize observers (the scroll event, if any, comes after). */
const resized = () => act(() => { for (const callback of resizeCallbacks) callback([], {} as ResizeObserver); });

describe("the timeline holds its place while content arrives", () => {
  it("keeps the first unread row where it landed when rows above it grow (WebKit has no scroll anchoring)", async () => {
    const w = world({ posts: 100, lastRead: 80 });
    const list = await open(w);
    expect(rowTop(list, 81)).toBe(0); // landed: the first unread row at the top (the fake puts the divider's row there)
    heights.set(60, 300); // a link card and a photo arrived in a row above the screen
    heights.set(75, 200);
    await resized();
    expect(rowTop(list, 81)).toBe(0); // was 380 px down without the anchoring
    fireEvent.scroll(list); // the scroll event of that correction changes nothing more
    expect(rowTop(list, 81)).toBe(0);
    heights.set(90, 400); // below the anchor: nothing to make up for
    await resized();
    expect(rowTop(list, 81)).toBe(0);
    w.engine.stop();
  });

  it("makes up for growth that a scroll event of its own saw before the resize observer did", async () => {
    const w = world({ posts: 100, lastRead: 80 });
    const list = await open(w);
    heights.set(70, 260);
    fireEvent.scroll(list); // e.g. the event of an earlier correction, dispatched after the row grew
    expect(rowTop(list, 81)).toBe(0); // not taken as the new place
    w.engine.stop();
  });

  it("stays at the bottom when a scroll event measures it mid-growth, and follows the growth", async () => {
    const w = world({ posts: 100, lastRead: 100 });
    const list = await open(w);
    expect(atEnd(list)).toBe(0);
    heights.set(97, 400); // a photo and a card near the end arrive
    fireEvent.scroll(list); // a scroll event (not the reader's) sees the list 340 px above the end
    await resized();
    expect(atEnd(list)).toBe(0); // it used to stop following here, and stay hundreds of px up
    heights.set(99, 300);
    await resized();
    expect(atEnd(list)).toBe(0);
    w.engine.stop();
  });

  it("lets the reader leave the bottom, and then keeps their row instead", async () => {
    const w = world({ posts: 100, lastRead: 100 });
    const list = await open(w);
    fireEvent.wheel(list);
    list.scrollTop -= 900;
    fireEvent.scroll(list);
    const seq = Number(list.querySelectorAll<HTMLElement>("article[data-seq]")[Math.floor(list.scrollTop / 60)]!.dataset["seq"]);
    const before = rowTop(list, seq);
    heights.set(seq - 3, 240); // above the reader's row
    heights.set(100, 240); // at the end
    await resized();
    expect(atEnd(list)).toBeGreaterThan(BOTTOM_SLACK_PX); // not pulled back down
    expect(rowTop(list, seq)).toBe(before);
    w.engine.stop();
  });

  it("keeps the row on screen when older rows are prepended, whatever grew below the screen meanwhile", async () => {
    const w = world({ posts: 300, lastRead: 300 });
    const list = await open(w);
    fireEvent.wheel(list);
    list.scrollTop = 600; // rows 261.. at the top, not yet in the paging zone
    fireEvent.scroll(list);
    const before = rowTop(list, 262);
    // While the older page loads, cards arrive in rows below the screen (the old height-difference rule moved the view
    // down by all of that).
    heights.set(290, 400);
    heights.set(295, 300);
    await act(async () => {
      await w.engine.loadOlder(w.channelId);
      await w.engine.idle();
    });
    expect(list.querySelectorAll("article[data-seq]").length).toBeGreaterThan(50);
    expect(rowTop(list, 262)).toBe(before);
    w.engine.stop();
  });
});

// The thread pane (§10.2) on the same layout: the parent at seq 500, r1..r30 at 501..530 (threadWorld).
type ThreadWorld = Awaited<ReturnType<typeof threadWorld>>;

function ThreadView({ w }: { w: ThreadWorld }) {
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
  const channel = w.store.getChannel(w.channelId);
  if (!channel) return null;
  const controller = { store: w.store, engine: w.engine, api: undefined, setError: vi.fn(), messageFocus: null, editing: null, sendKey: "shift-enter", clearMessageFocus: vi.fn() };
  return <ThreadPane controller={controller as unknown as AppController} channel={channel} parentId={w.parent.id} onClose={() => {}} />;
}

async function openThread(w: ThreadWorld) {
  const view = render(<ThreadView w={w} />);
  await act(async () => {
    await w.engine.idle();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  return view.container.querySelector<HTMLElement>("[data-message-list]")!;
}

async function settle(w: World) {
  await act(async () => {
    await w.engine.flushReads();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await w.engine.flushReads();
  });
}

describe("the thread pane holds its place while content arrives", () => {
  it("keeps 「新しい返信」 where it landed when the parent and replies above it grow, and reads from there", async () => {
    const w = await threadWorld({ threadRead: 510 });
    const list = await openThread(w);
    expect(screen.getByText("新しい返信")).toBeTruthy();
    expect(rowTop(list, 511)).toBe(0); // landed: the first unread reply at the top
    heights.set(500, 400); // the parent's photo and a link card in r5 arrive
    heights.set(505, 200);
    await resized();
    expect(rowTop(list, 511)).toBe(0); // was 480 px down without the anchoring
    fireEvent.scroll(list); // the scroll event of that correction
    expect(rowTop(list, 511)).toBe(0);
    await settle(w);
    expect(w.calls.threadReads).toEqual([520]); // r11..r20 on screen: the landing still reads (anchored)
    w.engine.stop();
  });

  it("stays at the end while a photo near it loads, even when a scroll event measures it mid-growth", async () => {
    const w = await threadWorld({ threadRead: 530 });
    const list = await openThread(w);
    expect(atEnd(list)).toBe(0);
    heights.set(529, 400);
    fireEvent.scroll(list); // not the reader's: the list is 340 px above the end for a moment
    await resized();
    expect(atEnd(list)).toBe(0); // it used to stay 340 px up
    w.engine.stop();
  });

  it("follows a live reply taller than the slack at the end (it was measured after the reply came)", async () => {
    const w = await threadWorld({ threadRead: 530 });
    const list = await openThread(w);
    expect(atEnd(list)).toBe(0);
    heights.set(531, 300); // r31 comes with a link card
    await act(async () => {
      w.server.post(w.channelId, w.alice.id, "r31", undefined, w.parent.id);
      await w.engine.idle();
    });
    expect(w.store.replies(w.channelId, w.parent.id)).toHaveLength(31);
    expect(atEnd(list)).toBe(0);
    w.engine.stop();
  });

  it("offers 「最新の返信へ」 to a reader up in a long thread, counts a live reply without moving, and goes to the end", async () => {
    const w = await threadWorld({ threadRead: 530 });
    const list = await openThread(w);
    expect(atEnd(list)).toBe(0);
    expect(screen.queryByText("最新の返信へ")).toBeNull(); // at the end: no button
    fireEvent.wheel(list);
    list.scrollTop -= 900; // reading older replies
    fireEvent.scroll(list);
    expect(screen.getByText("最新の返信へ")).toBeTruthy();
    const before = rowTop(list, 515);
    await act(async () => {
      w.server.post(w.channelId, w.alice.id, "r31", undefined, w.parent.id);
      await w.engine.idle();
    });
    expect(w.store.replies(w.channelId, w.parent.id)).toHaveLength(31);
    expect(rowTop(list, 515)).toBe(before); // the reading position stays put
    expect(screen.getByText("新しい返信 1 件")).toBeTruthy();
    fireEvent.click(screen.getByText("新しい返信 1 件"));
    fireEvent.scroll(list);
    expect(atEnd(list)).toBe(0);
    expect(screen.queryByText("新しい返信 1 件")).toBeNull();
    expect(screen.queryByText("最新の返信へ")).toBeNull();
    w.engine.stop();
  });

  it("counts the unread replies below 「新しい返信」 on the button when it opens there", async () => {
    const w = await threadWorld({ threadRead: 510 });
    await openThread(w);
    expect(screen.getByText("新しい返信 20 件")).toBeTruthy(); // r11..r30, 1200 px below the landing
    w.engine.stop();
  });

  it("keeps the reader's row when the whole thread arrives above the replies it held", async () => {
    const w = await threadWorld();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const replies = w.api.replies;
    w.api.replies = async (id) => {
      await gate;
      return replies(id);
    };
    heights.set(500, 400);
    heights.set(529, 600);
    heights.set(530, 300);
    const view = render(<ThreadView w={w} />);
    const list = view.container.querySelector<HTMLElement>("[data-message-list]")!;
    expect(atEnd(list)).toBe(0); // the parent, r29 and r30 held, at the end
    fireEvent.wheel(list); // the reader scrolls up into r29 before the thread is ready
    list.scrollTop -= 200;
    fireEvent.scroll(list);
    const before = rowTop(list, 529);
    expect(before).toBe(-100);
    await act(async () => {
      release();
      await w.engine.idle();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(w.store.replies(w.channelId, w.parent.id)).toHaveLength(30);
    expect(rowTop(list, 529)).toBe(before); // r1..r28 went in above it: 1680 px down without the anchoring
    expect(screen.getByText("新しい返信")).toBeTruthy();
    w.engine.stop();
  });
});

// The preview of a public channel I have not joined (§7.6.1): alice's #lab with 300 posts, pages of 50.
async function previewWorld() {
  const server = new FakeServer();
  const alice = server.addUser("alice");
  const bob = server.addUser("bob");
  const channel = server.createChannel("lab", alice.id);
  for (let i = 1; i <= 300; i++) server.post(channel.id, alice.id, `m${i}`);
  const store = new Store();
  const engine = new SyncEngine({ api: server.apiFor(bob.id), connect: server.connectorFor(bob.id), store, getAccessToken: () => "t", sleep: async () => {} }, { readDebounceMs: 0 });
  await engine.start();
  await engine.idle();
  store.setMe(server.users.get(bob.id) as unknown as UserMe);
  const controller = { store, engine, api: undefined, setError: vi.fn(), messageFocus: null, editing: null, sendKey: "shift-enter", clearMessageFocus: vi.fn() } as unknown as AppController;
  function PreviewView() {
    useSyncExternalStore((listener) => engine.subscribe(listener), () => engine.preview);
    useSyncExternalStore((listener) => store.subscribe(listener), () => store.version);
    return <PreviewTimeline controller={controller} channel={store.getChannel(channel.id)!} />;
  }
  const view = render(<PreviewView />);
  await act(async () => {
    await engine.openPreview(channel.id);
    await engine.idle();
  });
  return { engine, list: view.container.querySelector<HTMLElement>("[data-message-list]")! };
}

describe("the preview of a channel holds its place while content arrives", () => {
  it("stays at the end while photos and cards near it load", async () => {
    const { engine, list } = await previewWorld();
    expect(list.querySelectorAll("article[data-seq]")).toHaveLength(50);
    expect(atEnd(list)).toBe(0);
    heights.set(299, 400);
    fireEvent.scroll(list);
    await resized();
    expect(atEnd(list)).toBe(0); // it had no resize observer: 340 px up
    engine.stop();
  });

  it("keeps the row on screen when the older page goes above, whatever grew below the screen meanwhile", async () => {
    const { engine, list } = await previewWorld();
    fireEvent.wheel(list);
    list.scrollTop = 100; // rows 252.. at the top: in the paging zone, the older page is asked for
    fireEvent.scroll(list);
    const before = rowTop(list, 252);
    // While the older page loads, cards arrive in rows below the screen (the old height-difference rule moved the view
    // down by all of that).
    heights.set(290, 400);
    heights.set(295, 300);
    await act(async () => {
      await engine.idle();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(list.querySelectorAll("article[data-seq]")).toHaveLength(100);
    expect(rowTop(list, 252)).toBe(before);
    engine.stop();
  });
});
