// @vitest-environment jsdom
/**
 * The timeline keeps still while its content changes height (testers, 2026-10-01: "when opening a channel the scroll
 * position sometimes suddenly jumps a lot"): the decisions in scrollAnchor.ts, then the real Timeline on a fake layout
 * in which rows have heights that can change, as link cards, photos and videos arriving change them.
 */
import { useSyncExternalStore } from "react";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AppController } from "../src/state/app";
import { anchorCorrection, BOTTOM_SLACK_PX, firstRowBelow, stillAtBottom } from "../src/ui/scrollAnchor";
import { Timeline } from "../src/ui/Timeline";
import { type World, world } from "./unreadWorld";

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

const isList = (el: Element) => el.classList.contains("timeline");
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
const listOf = (el: Element) => el.closest(".timeline");

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
