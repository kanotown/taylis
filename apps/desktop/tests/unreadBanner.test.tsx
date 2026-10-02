// @vitest-environment jsdom
/**
 * M17 UI checks (SYNC_PROTOCOL.md §10.1 / §10.2): the real Timeline and ThreadPane on a real SyncEngine and the fake
 * server. jsdom has no layout, so rows are laid out by seq: row `seq` sits at (seq - layout.first) × 60 px in a
 * viewport of `layout.rows` rows, scrollIntoView moves `layout.first`, and setting scrollTop to the end shows the newest.
 */
import { useState, useSyncExternalStore } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ApiClient } from "../src/api/client";
import { ApiError, NetworkError } from "../src/api/errors";
import type { MessageOut } from "../src/api/types";
import { AppController } from "../src/state/app";
import { SyncEngine } from "../src/sync/engine";
import { Store } from "../src/sync/store";
import { clearScrollMemories } from "../src/ui/scrollMemory";
import { ThreadPane } from "../src/ui/ThreadPane";
import { Timeline } from "../src/ui/Timeline";
import { rowMenuLabels, tick } from "./rowMenu";
import { stamp, threadWorld, type World, world } from "./unreadWorld";

const ROW = 60;
/** `shift`: every row that many px above its slot (Chrome with fractional row heights leaves a row 0.5 px off). */
const layout = { first: 1, rows: 15, shift: 0 };
const scrolled: Array<{ seq: number | null; block: string | undefined; text: string }> = [];

const rowSeqs = (el: Element): number[] => [...el.querySelectorAll<HTMLElement>("article[data-seq]")].map((row) => Number(row.dataset["seq"]));

beforeEach(() => {
  clearScrollMemories();
  layout.first = 1;
  layout.rows = 15;
  layout.shift = 0;
  scrolled.length = 0;
  vi.spyOn(document, "hasFocus").mockReturnValue(true);
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    const seq = this.dataset["seq"] ? Number(this.dataset["seq"]) : null;
    const top = seq === null ? 0 : (seq - layout.first) * ROW - layout.shift;
    const height = seq === null ? layout.rows * ROW : ROW;
    return { top, bottom: top + height, height, left: 0, right: 300, width: 300, x: 0, y: top, toJSON: () => ({}) } as DOMRect;
  });
  HTMLElement.prototype.scrollIntoView = function (this: HTMLElement, options?: boolean | ScrollIntoViewOptions) {
    const block = typeof options === "object" ? options.block : undefined;
    const target = this.dataset["seq"] ? this : (this.nextElementSibling as HTMLElement | null); // a divider: the row after it
    const seq = target?.dataset["seq"] ? Number(target.dataset["seq"]) : null;
    scrolled.push({ seq, block, text: this.textContent ?? "" });
    if (seq !== null) layout.first = block === "center" ? seq - Math.floor(layout.rows / 2) : seq;
  };
  Object.defineProperty(HTMLElement.prototype, "clientHeight", { configurable: true, get: () => layout.rows * ROW });
  Object.defineProperty(HTMLElement.prototype, "scrollTop", {
    configurable: true,
    get(this: HTMLElement) {
      const seqs = rowSeqs(this);
      return seqs.length ? (layout.first - Math.min(...seqs)) * ROW + 1000 : 0; // never near the top: no automatic paging
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
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  for (const key of ["clientHeight", "scrollTop", "scrollHeight"]) delete (HTMLElement.prototype as unknown as Record<string, unknown>)[key];
});

function controllerFor(w: World) {
  return {
    store: w.store,
    engine: w.engine,
    api: undefined,
    setError: vi.fn(),
    messageFocus: null as AppController["messageFocus"],
    editing: null,
    sendKey: "shift-enter",
    clearMessageFocus() {
      this.messageFocus = null;
    },
  };
}

/** Re-renders on every store change and engine status change, like the app. */
function View({ w, controller, parentId, active }: { w: World; controller: ReturnType<typeof controllerFor>; parentId?: string; active?: boolean }) {
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
  const app = controller as unknown as AppController;
  return parentId ? <ThreadPane controller={app} channel={channel} parentId={parentId} onClose={() => {}} /> : <Timeline controller={app} channel={channel} active={active} />;
}

/** Start, show the (empty) conversation, then open it: the newest page arrives and the view positions itself. */
async function openView(w: World, controller = controllerFor(w)) {
  await w.engine.start();
  await w.engine.idle();
  const view = render(<View w={w} controller={controller} />);
  await act(async () => {
    await w.engine.openChannel(w.channelId);
    await w.engine.idle();
  });
  return { view, controller, timeline: view.container.querySelector<HTMLElement>(".timeline")! };
}

async function settle(w: World) {
  await act(async () => {
    await w.engine.flushReads();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await w.engine.flushReads();
  });
}

/** The reader's own scroll: input on the list (a wheel), then the scroll event. A scroll event alone is the view's own. */
function userScroll(el: HTMLElement) {
  fireEvent.wheel(el);
  fireEvent.scroll(el);
}

/** The seq of the row right after 「新着メッセージ」 (null: no divider). */
function dividerBefore(): number | null {
  const label = screen.queryByText("新着メッセージ");
  const next = label?.parentElement?.nextElementSibling as HTMLElement | null | undefined;
  return label ? Number(next?.dataset["seq"]) : null;
}

const banner = () => document.querySelector(".unread-banner");
const button = (text: string) => screen.queryByText(text) as HTMLButtonElement | null;
const serverRead = (w: World) => w.server.readState(w.bob.id, w.channelId).last_read_seq;

// V4 and V6 render several hundred real rows, which jsdom takes seconds for.
describe("channel view with more unread than one page (§10.1)", { timeout: 30_000 }, () => {
  it("V1: opens with the first unread row at the top below the divider, no banner; reading moves the position", async () => {
    const w = world({ posts: 130, lastRead: 100 });
    const { timeline } = await openView(w);
    // Real-shaped rows: a confirmed row keeps its client_msg_id, which is not its id (§10.3).
    expect(w.store.messages(w.channelId).every((m) => m.client_msg_id && m.client_msg_id !== m.id)).toBe(true);
    expect(dividerBefore()).toBe(101);
    // The divider goes to the top, so it is on screen with the row after it.
    expect(scrolled).toEqual([{ seq: 101, block: "start", text: "新着メッセージ" }]);
    expect(banner()).toBeNull();
    await settle(w);
    expect(serverRead(w)).toBe(115); // rows 101..115 on screen
    expect(screen.getByText("新着 30 件")).toBeTruthy();
    layout.first = 116;
    fireEvent.scroll(timeline);
    await settle(w);
    expect(serverRead(w)).toBe(130);
    w.engine.stop();
  });

  it("V2 / V3: 2,000 unread opens at the bottom with no divider and no read; 「既読にする」 reads to the end", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2026, 8, 28, 15, 0));
    const w = world({ posts: 3000, lastRead: 1000 });
    stamp(w, 1001, new Date(2026, 8, 28, 10, 23));
    const { timeline } = await openView(w);
    expect(dividerBefore()).toBeNull();
    expect(scrolled).toEqual([]);
    expect(layout.first).toBe(2986); // the newest rows
    expect(banner()?.textContent).toContain("未読 2,000 件 · 10:23 以降");
    expect(banner()?.closest(".timeline")).toBeNull(); // above the scroller: hiding it moves no row
    expect(button("最初の未読へ")).toBeNull(); // 2,000 > 500
    expect(button("既読にする")).toBeTruthy();
    await settle(w);
    expect(w.calls.reads).toEqual([]);
    expect(w.store.getChannel(w.channelId)?.lastReadSeq).toBe(1000);
    expect(serverRead(w)).toBe(1000);
    // Scrolled up: the bottom button counts nothing (the unread rows are not loaded).
    layout.first = 2960;
    fireEvent.scroll(timeline);
    expect(screen.getByText("最新のメッセージへ")).toBeTruthy();
    expect(screen.queryByText(/^新着 \d+ 件$/)).toBeNull();

    fireEvent.click(button("既読にする")!);
    await settle(w);
    expect(w.calls.reads).toEqual([{ seq: 3000, mode: "advance" }]);
    expect(w.server.readState(w.bob.id, w.channelId)).toMatchObject({ unread_count: 0, first_unread_at: null });
    expect(banner()).toBeNull();
    expect(dividerBefore()).toBeNull();
    w.engine.stop();
  });

  it("V4 / V39: 「最初の未読へ」 shows 読み込み中…, loads two pages of 200 and lands at the first unread row before reading", async () => {
    layout.rows = 12;
    const w = world({ posts: 1300, lastRead: 1000 });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const history = w.api.history;
    w.api.history = async (channelId, before, limit) => {
      if (limit === 200) await gate;
      return history(channelId, before, limit);
    };
    await openView(w);
    expect(banner()?.textContent).toMatch(/^未読 300 件 · /);
    expect(button("最初の未読へ")).toBeTruthy();
    expect(button("既読にする")).toBeTruthy();
    expect(dividerBefore()).toBeNull();

    await act(async () => {
      fireEvent.click(button("最初の未読へ")!);
    });
    expect(banner()?.textContent).toContain("読み込み中…");
    expect(button("最初の未読へ")).toBeNull();
    expect(button("既読にする")).toBeNull();

    await act(async () => {
      release();
      await w.engine.idle();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(w.calls.history).toEqual([{ before: null, limit: 50 }, { before: 1251, limit: 200 }, { before: 1051, limit: 200 }]);
    expect(w.store.messages(w.channelId)).toHaveLength(450);
    expect(dividerBefore()).toBe(1001);
    expect(scrolled.at(-1)).toMatchObject({ seq: 1001, block: "start", text: "新着メッセージ" });
    expect(banner()).toBeNull();
    expect(screen.getByText("新着 300 件")).toBeTruthy(); // as when opening there: all of it is below
    await settle(w);
    expect(serverRead(w)).toBe(1012); // rows 1001..1012 on screen
    expect(w.calls.reads).toEqual([{ seq: 1012, mode: "advance" }]); // nothing from where the view was before landing
    w.engine.stop();
  });

  it("V6: paging up by hand makes the range ready, but rows only loaded above the screen are not read", async () => {
    layout.rows = 16;
    const w = world({ posts: 1300, lastRead: 1000 });
    const { timeline } = await openView(w);
    for (let i = 0; i < 5; i++) {
      await act(async () => {
        await w.engine.loadOlder(w.channelId);
      });
    }
    expect(w.store.getChannel(w.channelId)?.oldestLoadedSeq).toBe(1001);
    expect(dividerBefore()).toBe(1001); // covers(1001, 1000)
    expect(banner()).toBeTruthy();
    expect(button("最初の未読へ")).toBeTruthy();
    layout.first = 1045; // 1045..1060
    fireEvent.scroll(timeline);
    await settle(w);
    expect(w.calls.reads).toEqual([]);
    layout.first = 1001; // the first unread row comes on screen
    fireEvent.scroll(timeline);
    await settle(w);
    expect(w.calls.reads.at(-1)).toEqual({ seq: 1016, mode: "advance" });
    expect(banner()).toBeNull();
    w.engine.stop();
  });

  it("V7: another device reads up to 2990: the banner stays until 2991 is shown; 「最初の未読へ」 only scrolls", async () => {
    layout.rows = 6; // 2995..3000 at the bottom
    const w = world({ posts: 3000, lastRead: 1000 });
    const { timeline } = await openView(w);
    w.server.markRead(w.bob.id, w.channelId, 2990);
    await act(async () => {
      await w.engine.idle();
    });
    expect(banner()?.textContent).toMatch(/^未読 10 件/);
    expect(button("最初の未読へ")).toBeTruthy();
    fireEvent.scroll(timeline);
    await settle(w);
    expect(w.calls.reads).toEqual([]);

    await act(async () => {
      fireEvent.click(button("最初の未読へ")!);
      await w.engine.idle();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(w.calls.history).toHaveLength(1); // no request
    expect(dividerBefore()).toBe(2991);
    expect(scrolled.at(-1)).toMatchObject({ seq: 2991, block: "start", text: "新着メッセージ" });
    await settle(w);
    expect(w.calls.reads).toEqual([{ seq: 2996, mode: "advance" }]);
    expect(banner()).toBeNull();
    w.engine.stop();
  });

  it("V10: a §7.3 reload after a long time offline drops the anchor: banner with only 「既読にする」, no reads", async () => {
    const w = world({ posts: 130, lastRead: 100 });
    const { timeline } = await openView(w);
    layout.first = 116;
    fireEvent.scroll(timeline);
    await settle(w);
    expect(serverRead(w)).toBe(130);
    w.engine.stop();
    for (let i = 131; i <= 6130; i++) w.server.post(w.channelId, w.alice.id, `m${i}`);
    await act(async () => {
      await w.engine.start();
      await w.engine.idle();
    });
    expect(w.store.getChannel(w.channelId)?.oldestLoadedSeq).toBe(6081);
    // At the bottom: the oldest row loaded is no place to start (「以前を読み込む」 right above it would run at once).
    expect(layout.first).toBe(6116);
    expect(banner()?.textContent).toMatch(/^未読 6,000 件/);
    expect(button("最初の未読へ")).toBeNull();
    expect(button("既読にする")).toBeTruthy();
    layout.first = 6116;
    fireEvent.scroll(timeline);
    await settle(w);
    expect(serverRead(w)).toBe(130);
    w.engine.stop();
  });

  it("V13: 「ここから未読にする」 moves the divider, hides the banner and pauses marking", async () => {
    const w = world({ posts: 130, lastRead: 100 });
    const { timeline } = await openView(w);
    await settle(w);
    expect(serverRead(w)).toBe(115);
    await act(async () => {
      w.engine.markUnread(w.channelId, 110);
    });
    await settle(w);
    expect(w.calls.reads.at(-1)).toEqual({ seq: 109, mode: "set" });
    expect(dividerBefore()).toBe(110);
    expect(banner()).toBeNull();
    layout.first = 116;
    fireEvent.scroll(timeline);
    await settle(w);
    expect(serverRead(w)).toBe(109);
    w.engine.stop();
  });

  it("V16: offline, both banner buttons are shown but disabled", async () => {
    const w = world({ posts: 1300, lastRead: 1000 });
    await openView(w);
    expect(button("最初の未読へ")?.disabled).toBe(false);
    await act(async () => {
      w.engine.stop();
    });
    expect(button("最初の未読へ")?.disabled).toBe(true);
    expect(button("既読にする")?.disabled).toBe(true);
  });

  it("V17: a search hit is centred with no banner, no divider and no read", async () => {
    const w = world({ posts: 1300, lastRead: 1000 });
    const records = w.server.channels.get(w.channelId)!.messages;
    const hit = records.find((m) => m.seq === 1100)!;
    const controller = controllerFor(w);
    controller.messageFocus = { channelId: w.channelId, messageId: hit.id, parentId: null, context: records.filter((m) => m.seq >= 1075 && m.seq <= 1126) as MessageOut[] };
    await openView(w, controller);
    expect(scrolled).toEqual([{ seq: 1100, block: "center", text: expect.any(String) as string }]);
    expect(document.querySelector("article.highlighted")?.id).toBe(`timeline-${hit.id}`);
    expect(banner()).toBeNull();
    expect(dividerBefore()).toBeNull();
    await settle(w);
    expect(w.calls.reads).toEqual([]);
    w.engine.stop();
  });

  it("M29: kept mounted under another tab (a phone's pins / files), the view reads nothing and counts nothing seen; back on screen it reads what it shows", async () => {
    const w = world({ posts: 130, lastRead: 100 });
    const { view, controller, timeline } = await openView(w);
    await settle(w);
    expect(serverRead(w)).toBe(115); // rows 101..115 on screen
    const reads = w.calls.reads.length;

    expect(screen.getByText("新着 30 件")).toBeTruthy();

    view.rerender(<View w={w} controller={controller} active={false} />);
    expect(screen.queryByText(/^新着 \d+ 件$/)).toBeNull(); // not drawn while hidden
    // Rows 116..130 where the screen would be: nothing is on screen, so nothing is read.
    layout.first = 116;
    userScroll(timeline);
    await settle(w);
    expect(w.calls.reads.length).toBe(reads);
    expect(serverRead(w)).toBe(115);

    // Back on 「メッセージ」: the rows shown now are read.
    view.rerender(<View w={w} controller={controller} active />);
    await settle(w);
    expect(serverRead(w)).toBe(130);

    // A new row while hidden follows at the bottom but is not read (nor seen) until the view is back.
    view.rerender(<View w={w} controller={controller} active={false} />);
    const before = w.calls.reads.length;
    await act(async () => {
      w.server.post(w.channelId, w.alice.id, "m131");
      await w.engine.idle();
    });
    await settle(w);
    expect(w.calls.reads.length).toBe(before);
    expect(serverRead(w)).toBe(130);
    view.rerender(<View w={w} controller={controller} active />);
    await settle(w);
    expect(serverRead(w)).toBe(131);
    w.engine.stop();
  });
});

describe("new rows never carry unread rows above the screen unseen (§10.1)", { timeout: 30_000 }, () => {
  /** Channel C read to the bottom: rows 116..130 on screen. */
  async function readToBottom(w: World, timeline: HTMLElement) {
    layout.first = 116;
    fireEvent.scroll(timeline);
    await settle(w);
    expect(serverRead(w)).toBe(130);
  }

  /** Bob is away while alice posts 300 more (fewer than gapLimit: the catch-up appends them, no §7.3 reload). */
  function awayWhileAlicePosts(w: World) {
    w.engine.stop();
    for (let i = 131; i <= 430; i++) w.server.post(w.channelId, w.alice.id, `m${i}`);
  }

  /** The app's channel switch: one Timeline for whichever channel is shown. */
  function switcher(w: World, controller: ReturnType<typeof controllerFor>) {
    const shown = { show: (_id: string) => {} };
    function Switch() {
      const [id, setId] = useState(w.channelId);
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
      const channel = w.store.getChannel(id);
      return channel ? <Timeline controller={controller as unknown as AppController} channel={channel} /> : null;
    }
    return { Switch, shown };
  }

  it("reconnecting while at the bottom: the catch-up's first row goes to the top, only rows shown are read", async () => {
    const w = world({ posts: 130, lastRead: 100 });
    const { timeline } = await openView(w);
    await readToBottom(w, timeline);
    awayWhileAlicePosts(w);
    await act(async () => {
      await w.engine.start();
      await w.engine.idle();
    });
    await settle(w);
    expect(layout.first).toBe(131);
    expect(serverRead(w)).toBe(145); // rows 131..145, not the newest
    expect(screen.getByText("新着 300 件")).toBeTruthy();

    // Down to the newest in one go: 146..415 went past unseen, so nothing is read (§10.1 2.) and the banner offers the rest.
    layout.first = 416;
    fireEvent.scroll(timeline);
    await settle(w);
    expect(serverRead(w)).toBe(145);
    expect(banner()?.textContent).toMatch(/^未読 285 件/);
    fireEvent.click(button("既読にする")!);
    await settle(w);
    expect(serverRead(w)).toBe(430);

    // A new message while at the bottom still shows the newest one and reads it.
    await act(async () => {
      w.server.post(w.channelId, w.alice.id, "m431");
      await w.engine.idle();
    });
    await settle(w);
    expect(layout.first).toBe(417);
    expect(serverRead(w)).toBe(431);
    w.engine.stop();
  });

  it("reconnecting at the bottom with rows half a pixel off their slot: the first new row at the top still counts as shown", async () => {
    const w = world({ posts: 130, lastRead: 100 });
    const { timeline } = await openView(w);
    await readToBottom(w, timeline);
    layout.shift = 0.5; // a thread summary above made the row heights fractional
    awayWhileAlicePosts(w); // 300 rows: two catch-up pages, ready only after the second
    await act(async () => {
      await w.engine.start();
      await w.engine.idle();
    });
    await settle(w);
    expect(layout.first).toBe(131);
    expect(serverRead(w)).toBe(145);
    expect(banner()).toBeNull();
    layout.first = 146;
    userScroll(timeline);
    await settle(w);
    expect(serverRead(w)).toBe(160);
    w.engine.stop();
  });

  it("the catch-up's first row put at the top is a landing: anchored there, even a few pixels off", async () => {
    const w = world({ posts: 130, lastRead: 100 });
    const { timeline } = await openView(w);
    await readToBottom(w, timeline);
    layout.shift = 2;
    w.engine.stop();
    for (let i = 131; i <= 280; i++) w.server.post(w.channelId, w.alice.id, `m${i}`); // one catch-up page: ready at once
    await act(async () => {
      await w.engine.start();
      await w.engine.idle();
    });
    await settle(w);
    expect(layout.first).toBe(131);
    expect(serverRead(w)).toBe(145); // 131 is cut by 2 px, but the view landed on it
    expect(banner()).toBeNull();
    w.engine.stop();
  });

  it("my failed post as the last row: opening, or switching back, keeps 「新着メッセージ」 at the top", async () => {
    const w = world({ posts: 150, lastRead: 100 });
    const other = w.server.createChannel("d", w.alice.id).id;
    w.server.join(other, w.bob.id);
    await w.engine.start();
    await w.engine.idle();
    w.api.failNext(new ApiError(403, "posting_restricted", "no"));
    await w.engine.send(w.channelId, "refused"); // before this device loaded the channel: the placeholder alone
    expect(w.store.messages(w.channelId).at(-1)).toMatchObject({ body: "refused", pending: true, failed: true });
    const controller = controllerFor(w);
    const { Switch, shown } = switcher(w, controller);
    const view = render(<Switch />);
    await act(async () => {
      await w.engine.openChannel(w.channelId);
      await w.engine.idle();
    });
    await settle(w);
    expect(layout.first).toBe(101);
    expect(dividerBefore()).toBe(101);
    expect(serverRead(w)).toBe(115);

    await act(async () => {
      shown.show(other);
      await w.engine.openChannel(other);
      await w.engine.idle();
    });
    w.api.failNext(new ApiError(403, "posting_restricted", "no"));
    await act(async () => {
      await w.engine.send(w.channelId, "refused again"); // e.g. forwarded there from another conversation
    });
    // M75 would bring the conversation back where it was left (101): this is about landing as on opening.
    clearScrollMemories();
    await act(async () => {
      shown.show(w.channelId);
      await w.engine.openChannel(w.channelId);
      await w.engine.idle();
    });
    await settle(w);
    expect(view.container.querySelector(".timeline")).toBeTruthy();
    expect(layout.first).toBe(116); // the divider (mark 115), not the bottom (136)
    expect(dividerBefore()).toBe(116);
    expect(serverRead(w)).toBe(130);
    w.engine.stop();
  });

  it("V35: switching to a held channel after reconnecting: no banner while its catch-up loads, then 「新着メッセージ」 at the top", async () => {
    const w = world({ posts: 130, lastRead: 100 });
    const other = w.server.createChannel("d", w.alice.id).id;
    w.server.join(other, w.bob.id);
    const controller = controllerFor(w);
    await w.engine.start();
    await w.engine.idle();
    const { Switch, shown } = switcher(w, controller);
    const view = render(<Switch />);
    await act(async () => {
      await w.engine.openChannel(w.channelId);
      await w.engine.idle();
    });
    const timeline = view.container.querySelector<HTMLElement>(".timeline")!;
    await readToBottom(w, timeline);
    await act(async () => {
      shown.show(other);
      await w.engine.openChannel(other);
      await w.engine.idle();
    });
    awayWhileAlicePosts(w);
    await act(async () => {
      await w.engine.start();
      await w.engine.idle();
    });
    expect(w.store.getChannel(w.channelId)).toMatchObject({ syncedSeq: 130, lastSeq: 430, unreadCount: 300 });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const delta = w.api.delta;
    w.api.delta = async (...args: Parameters<typeof delta>) => {
      await gate;
      return delta(...args);
    };
    scrolled.length = 0;
    await act(async () => {
      shown.show(w.channelId);
      void w.engine.openChannel(w.channelId);
    });
    expect(layout.first).toBe(116); // the held rows, at the bottom
    expect(banner()).toBeNull(); // the catch-up is on its way: the banner would only flash
    await act(async () => {
      release();
      await w.engine.idle();
    });
    await settle(w);
    expect(dividerBefore()).toBe(131);
    expect(scrolled.at(-1)).toMatchObject({ seq: 131, block: "start", text: "新着メッセージ" });
    expect(serverRead(w)).toBe(145);
    expect(banner()).toBeNull();
    w.engine.stop();
  });

  it("V35: a held channel's missing rows are not 'nothing unread': scrolled away meanwhile, the jump to the newest reads nothing", async () => {
    const w = world({ posts: 130, lastRead: 100 });
    const other = w.server.createChannel("d", w.alice.id).id;
    w.server.join(other, w.bob.id);
    const controller = controllerFor(w);
    await w.engine.start();
    await w.engine.idle();
    const { Switch, shown } = switcher(w, controller);
    const view = render(<Switch />);
    await act(async () => {
      await w.engine.openChannel(w.channelId);
      await w.engine.idle();
    });
    const timeline = view.container.querySelector<HTMLElement>(".timeline")!;
    await readToBottom(w, timeline);
    await act(async () => {
      shown.show(other);
      await w.engine.openChannel(other);
      await w.engine.idle();
    });
    awayWhileAlicePosts(w);
    await act(async () => {
      await w.engine.start();
      await w.engine.idle();
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const delta = w.api.delta;
    w.api.delta = async (...args: Parameters<typeof delta>) => {
      await gate;
      return delta(...args);
    };
    await act(async () => {
      shown.show(w.channelId);
      void w.engine.openChannel(w.channelId);
    });
    layout.first = 90; // the reader scrolls up before the new rows arrive
    fireEvent.scroll(timeline);
    await act(async () => {
      release();
      await w.engine.idle();
    });
    await settle(w);
    expect(layout.first).toBe(90);
    expect(w.calls.reads.map((r) => r.seq)).toEqual([115, 130]);
    expect(banner()?.textContent).toMatch(/^未読 300 件/); // row 131 has not been on screen
    expect(button("最初の未読へ")).toBeTruthy();

    fireEvent.click(screen.getByText("新着 300 件"));
    fireEvent.scroll(timeline);
    await settle(w);
    expect(layout.first).toBe(416);
    expect(serverRead(w)).toBe(130);
    w.engine.stop();
  });

  it("my poll follows to the bottom whichever comes first, its row or the answer that names it (§10.1 11., M28b)", async () => {
    const w = world({ posts: 130, lastRead: 130 });
    const { view, controller, timeline } = await openView(w);
    expect(layout.first).toBe(116);
    layout.first = 90; // the reader scrolled up
    userScroll(timeline);
    // The poll's event lands before the POST's answer (a slow answer): a row from "someone" while scrolled up stays put.
    const poll = w.server.postPoll(w.channelId, w.bob.id, { question: "どれ?", options: ["A", "B"] });
    await act(async () => { await w.engine.idle(); });
    expect(document.getElementById(`timeline-${poll.id}`)).toBeTruthy();
    expect(layout.first).toBe(90);
    // The answer arrives: the controller names the post (createPoll) and re-renders.
    (controller as unknown as { postedHere: string | null }).postedHere = poll.id;
    await act(async () => { view.rerender(<View w={w} controller={controller} />); });
    expect(layout.first).toBe(117); // 117..131: the poll at the bottom
    w.engine.stop();
  });

  it("relaunching from the persisted store with 300 new posts: the first new row at the top, only rows shown are read", async () => {
    const w = world({ posts: 130, lastRead: 100 });
    const { view, timeline } = await openView(w);
    await readToBottom(w, timeline);
    awayWhileAlicePosts(w);
    view.unmount();
    const store = Store.fromSnapshot(w.store.snapshot());
    const engine = new SyncEngine(
      { api: w.api, connect: w.server.connectorFor(w.bob.id), store, getAccessToken: () => "t", sleep: async () => {}, random: () => 0.5, isActive: () => true },
      { reconnectMinMs: 0 },
    );
    const relaunched: World = { ...w, store, engine };
    render(<View w={relaunched} controller={controllerFor(relaunched)} />);
    void engine.openChannel(w.channelId); // offline yet: remembered for the start
    await act(async () => {
      await engine.start();
      await engine.idle();
    });
    await settle(relaunched);
    expect(layout.first).toBe(131);
    expect(serverRead(w)).toBe(145);
    engine.stop();
  });

  it("V43: my reply also sent to the channel leaves the view where it is: a reply does not read the channel", async () => {
    const w = world({ posts: 400, lastRead: 100 });
    const { timeline } = await openView(w);
    for (let i = 0; i < 6; i++) {
      await act(async () => {
        await w.engine.loadOlder(w.channelId);
      });
    }
    layout.first = 101;
    fireEvent.scroll(timeline);
    await settle(w);
    layout.first = 116;
    fireEvent.scroll(timeline);
    await settle(w);
    expect(serverRead(w)).toBe(130);
    const parent = w.store.messages(w.channelId).find((m) => m.seq === 120)!;
    await act(async () => {
      await w.engine.send(w.channelId, "my reply", undefined, parent.id, [], { alsoInChannel: true });
      await w.engine.idle();
    });
    await settle(w);
    expect(w.store.messages(w.channelId).at(-1)).toMatchObject({ body: "my reply", parent_id: parent.id });
    expect(layout.first).toBe(116);
    expect(serverRead(w)).toBe(130);

    // My own top-level post still shows the newest message (the server reads the channel with it). Following it went
    // past 131..386 unseen, which drops the anchor, but no banner shows for the moment the post is on its way.
    const banners: string[] = [];
    const stop = w.store.subscribe(() => {
      if (banner()) banners.push(banner()!.textContent ?? "");
    });
    await act(async () => {
      await w.engine.send(w.channelId, "my post");
      await w.engine.idle();
    });
    await settle(w);
    stop();
    expect(layout.first).toBe(387); // the bottom as drawn with the placeholder (the layout model places rows by seq)
    expect(serverRead(w)).toBe(402);
    expect(banner()).toBeNull();
    expect(banners).toEqual([]);
    w.engine.stop();
  });
});

describe("round 2: the anchor, the read position and the banner (§10.1)", { timeout: 30_000 }, () => {
  /** Row `seq` of channel C as rendered. */
  const rowOf = (w: World, seq: number) => document.getElementById(`timeline-${w.store.messages(w.channelId).find((m) => m.seq === seq)!.id}`)!;

  it("V11 (corrected): another device marks unread below the screen: the anchor drops, nothing is read, the banner offers both", async () => {
    const w = world({ posts: 130, lastRead: 100 });
    const { timeline } = await openView(w);
    layout.first = 116;
    fireEvent.scroll(timeline);
    await settle(w);
    expect(serverRead(w)).toBe(130);
    await act(async () => {
      w.server.markRead(w.bob.id, w.channelId, 100, "set");
      await w.engine.idle();
    });
    await settle(w);
    expect(w.store.getChannel(w.channelId)).toMatchObject({ lastReadSeq: 100, unreadCount: 30 });
    expect(banner()?.textContent).toMatch(/^未読 30 件/);
    expect(button("最初の未読へ")).toBeTruthy();
    expect(button("既読にする")).toBeTruthy();
    userScroll(timeline); // 101 is above the screen
    await settle(w);
    expect(w.calls.reads.map((r) => r.seq)).toEqual([115, 130]);
    expect(serverRead(w)).toBe(100);
    w.engine.stop();
  });

  it("V36: the position goes down while its first unread row is on screen: that evaluation reads nothing, the next scroll does", async () => {
    const w = world({ posts: 130, lastRead: 130 });
    const { timeline } = await openView(w);
    expect(layout.first).toBe(116); // nothing unread: the newest
    layout.first = 95; // scrolled up: 95..109
    fireEvent.scroll(timeline);
    await settle(w);
    await act(async () => {
      w.server.markRead(w.bob.id, w.channelId, 100, "set");
      await w.engine.idle();
    });
    await settle(w);
    expect(w.calls.reads).toEqual([]);
    expect(serverRead(w)).toBe(100);
    userScroll(timeline);
    await settle(w);
    expect(w.calls.reads).toEqual([{ seq: 109, mode: "advance" }]);
    w.engine.stop();
  });

  it("V36 at the bottom: the banner appearing and the view keeping its bottom read nothing; the reader's scroll does", async () => {
    const w = world({ posts: 130, lastRead: 100 });
    const { timeline } = await openView(w);
    layout.first = 116;
    userScroll(timeline);
    await settle(w);
    expect(serverRead(w)).toBe(130);
    await act(async () => {
      w.server.markRead(w.bob.id, w.channelId, 125, "set"); // on the phone: unread from 126, which is on screen here
      await w.engine.idle();
    });
    await settle(w);
    expect(banner()?.textContent).toMatch(/^未読 5 件/);
    // The banner made the scroller shorter and the view scrolled back to its bottom: a scroll event with no input.
    fireEvent.scroll(timeline);
    await settle(w);
    expect(w.calls.reads.map((r) => r.seq)).toEqual([115, 130]);
    expect(serverRead(w)).toBe(125);
    userScroll(timeline);
    await settle(w);
    expect(serverRead(w)).toBe(130);
    expect(banner()).toBeNull();
    w.engine.stop();
  });

  it("V36: after the position went down, the window back in front or new rows go on reading as usual", async () => {
    const w = world({ posts: 130, lastRead: 130 });
    const { timeline } = await openView(w);
    await act(async () => {
      w.server.markRead(w.bob.id, w.channelId, 125, "set");
      await w.engine.idle();
    });
    fireEvent.scroll(timeline);
    await settle(w);
    expect(serverRead(w)).toBe(125);
    fireEvent.focus(window);
    await settle(w);
    expect(serverRead(w)).toBe(130);
    await act(async () => {
      w.server.markRead(w.bob.id, w.channelId, 125, "set");
      await w.engine.idle();
    });
    await settle(w);
    expect(serverRead(w)).toBe(125);
    await act(async () => {
      w.server.post(w.channelId, w.alice.id, "m131");
      await w.engine.idle();
    });
    await settle(w);
    expect(serverRead(w)).toBe(131);
    w.engine.stop();
  });

  it("V37: a hold that ends without a read drops the anchor: nothing is read until the held row is shown", async () => {
    const w = world({ posts: 130, lastRead: 100 });
    const other = w.server.createChannel("d", w.alice.id).id;
    w.server.join(other, w.bob.id);
    const { timeline } = await openView(w);
    await settle(w);
    expect(serverRead(w)).toBe(115);
    await act(async () => {
      w.engine.markUnread(w.channelId, 110);
    });
    await settle(w);
    layout.first = 116; // reading on while the hold pauses marking
    fireEvent.scroll(timeline);
    await settle(w);
    expect(serverRead(w)).toBe(109);
    await act(async () => {
      await w.engine.openChannel(other); // another conversation opened while this view stays (a sheet): the hold ends
      await w.engine.idle();
    });
    expect(w.engine.unreadHold.has(w.channelId)).toBe(false);
    await settle(w);
    userScroll(timeline);
    await settle(w);
    expect(serverRead(w)).toBe(109);
    expect(banner()?.textContent).toMatch(/^未読 21 件/);
    layout.first = 110;
    userScroll(timeline);
    await settle(w);
    expect(serverRead(w)).toBe(124);
    w.engine.stop();
  });

  it("V37: the hold ends without a read while the held row is on screen: that evaluation reads nothing, the next scroll does", async () => {
    const w = world({ posts: 130, lastRead: 100 });
    const other = w.server.createChannel("d", w.alice.id).id;
    w.server.join(other, w.bob.id);
    const { timeline } = await openView(w);
    await settle(w);
    await act(async () => {
      w.engine.markUnread(w.channelId, 110);
    });
    await settle(w);
    expect(serverRead(w)).toBe(109);
    await act(async () => {
      await w.engine.openChannel(other);
      await w.engine.idle();
    });
    await settle(w);
    expect(serverRead(w)).toBe(109); // 110..115 are on screen, but the reader marked them unread
    fireEvent.scroll(timeline); // the view's own (the banner, the bottom kept): still nothing
    await settle(w);
    expect(serverRead(w)).toBe(109);
    userScroll(timeline);
    await settle(w);
    expect(serverRead(w)).toBe(115);
    w.engine.stop();
  });

  it("V33: reconnecting while the catch-up is on its way: no banner, not ready; then its first row at the top", async () => {
    const w = world({ posts: 130, lastRead: 100 });
    const { timeline } = await openView(w);
    layout.first = 116;
    fireEvent.scroll(timeline);
    await settle(w);
    expect(serverRead(w)).toBe(130);
    w.engine.stop();
    for (let i = 131; i <= 430; i++) w.server.post(w.channelId, w.alice.id, `m${i}`);
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const reached = new Promise<void>((resolve) => (entered = resolve));
    const delta = w.api.delta;
    w.api.delta = async (...args: Parameters<typeof delta>) => {
      entered();
      await gate;
      return delta(...args);
    };
    let started!: Promise<void>;
    await act(async () => {
      started = w.engine.start();
      await reached;
    });
    expect(w.engine.status).toBe("connecting");
    expect(w.store.getChannel(w.channelId)).toMatchObject({ syncedSeq: 130, lastSeq: 430, unreadCount: 300 });
    expect(w.engine.readRangeReady(w.channelId)).toBe(false);
    expect(banner()).toBeNull();
    fireEvent.scroll(timeline);
    await act(async () => {
      release();
      await started;
      await w.engine.idle();
    });
    await settle(w);
    expect(layout.first).toBe(131);
    expect(w.calls.reads.map((r) => r.seq)).toEqual([115, 130, 145]);
    w.engine.stop();
  });

  it("V34: the first unread row going past above the screen unseen drops the anchor; partly on screen it does not", async () => {
    const w = world({ posts: 150, lastRead: 100 });
    const { timeline } = await openView(w);
    await settle(w);
    expect(serverRead(w)).toBe(115);
    fireEvent.click(screen.getByText("新着 50 件")); // a screen and more at once: 116..135 never shown
    fireEvent.scroll(timeline);
    await settle(w);
    expect(layout.first).toBe(136);
    expect(serverRead(w)).toBe(115);
    expect(banner()?.textContent).toMatch(/^未読 35 件/);
    await act(async () => {
      fireEvent.click(button("最初の未読へ")!);
      await w.engine.idle();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(w.calls.history).toHaveLength(1); // held already: no request
    expect(scrolled.at(-1)).toMatchObject({ seq: 116, block: "start", text: "新着メッセージ" });
    await settle(w);
    expect(serverRead(w)).toBe(130);
    layout.first = 131.5; // 131 cut at the top edge: the reader is going on
    fireEvent.scroll(timeline);
    await settle(w);
    expect(serverRead(w)).toBe(145);
    w.engine.stop();
  });

  it("V38: 「ここから未読にする」 is not offered (nor Alt+click) past a range that does not reach the read position", async () => {
    const w = world({ posts: 3000, lastRead: 1000 });
    await openView(w);
    expect(rowMenuLabels(rowOf(w, 2990))).not.toContain("ここから未読にする");
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    await tick();
    fireEvent.click(rowOf(w, 2990), { altKey: true });
    await settle(w);
    expect(w.calls.reads).toEqual([]);
    expect(w.engine.unreadHold.has(w.channelId)).toBe(false);
    w.engine.stop();
    cleanup();

    const v1 = world({ posts: 130, lastRead: 100 });
    await openView(v1);
    await settle(v1);
    expect(rowMenuLabels(rowOf(v1, 125))).toContain("ここから未読にする");
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    await tick();
    fireEvent.click(rowOf(v1, 125), { altKey: true });
    await settle(v1);
    expect(v1.calls.reads.at(-1)).toEqual({ seq: 124, mode: "set" });
    v1.engine.stop();
  });

  it("V40: the list starts at the bottom, yet the bottom button counts from the divider: 「新着 30 件」", async () => {
    layout.first = 116;
    const w = world({ posts: 130, lastRead: 100 });
    await openView(w);
    expect(layout.first).toBe(101);
    expect(screen.getByText("新着 30 件")).toBeTruthy();
    w.engine.stop();
  });

  it("V45: a §7.3 reload in the background drops the anchor, even with no evaluation while the rows were gone", async () => {
    const w = world({ posts: 130, lastRead: 100, gapLimit: 10 });
    const { timeline } = await openView(w);
    await settle(w);
    expect(serverRead(w)).toBe(115);
    vi.mocked(document.hasFocus).mockReturnValue(false);
    w.server.socketsOf(w.bob.id)[0]!.dropNext = 19;
    await act(async () => {
      for (let i = 131; i <= 150; i++) w.server.post(w.channelId, w.alice.id, `m${i}`);
      await w.engine.idle();
    });
    expect(w.engine.stats.reloads).toBe(1);
    expect(w.store.getChannel(w.channelId)).toMatchObject({ oldestLoadedSeq: 101, lastReadSeq: 115 }); // the new page reaches it
    vi.mocked(document.hasFocus).mockReturnValue(true);
    fireEvent.focus(window);
    await settle(w);
    expect(serverRead(w)).toBe(115);
    expect(banner()?.textContent).toMatch(/^未読 \d+ 件/);
    layout.first = 116;
    fireEvent.scroll(timeline);
    await settle(w);
    expect(serverRead(w)).toBe(130);
    w.engine.stop();
  });

  it("V45: a reload never drawn with its range empty (all of it between two renders) drops the anchor as well", async () => {
    const w = world({ posts: 130, lastRead: 100 });
    await openView(w);
    await settle(w);
    expect(serverRead(w)).toBe(115);
    vi.mocked(document.hasFocus).mockReturnValue(false);
    w.server.socketsOf(w.bob.id)[0]!.dropNext = 20;
    for (let i = 131; i <= 150; i++) w.server.post(w.channelId, w.alice.id, `m${i}`);
    const page = await w.server.apiFor(w.bob.id).history(w.channelId, null, 50);
    // What catchUp does on a gap over gapLimit, inside one batch: React never sees the empty range.
    act(() => {
      const reloads = (w.engine as unknown as { reloads: Map<string, number> }).reloads;
      reloads.set(w.channelId, w.engine.reloadCount(w.channelId) + 1);
      w.store.clearMessages(w.channelId);
      w.store.updateChannel(w.channelId, { syncedSeq: null, oldestLoadedSeq: null, hasOlder: true });
      for (const message of page.messages) w.store.upsertMessage(message);
      w.store.updateChannel(w.channelId, { syncedSeq: 150, lastSeq: 150, oldestLoadedSeq: 101, hasOlder: true });
    });
    vi.mocked(document.hasFocus).mockReturnValue(true);
    fireEvent.focus(window);
    await settle(w);
    expect(serverRead(w)).toBe(115);
    expect(banner()?.textContent).toMatch(/^未読 \d+ 件/); // 116 has not been on screen since
    w.engine.stop();
  });

  it("V46: rows that arrived but are not drawn yet are judged with the channel state of the same moment", async () => {
    layout.rows = 16;
    const w = world({ posts: 1300, lastRead: 1000 });
    const { timeline } = await openView(w);
    for (let i = 0; i < 4; i++) {
      await act(async () => {
        await w.engine.loadOlder(w.channelId);
      });
    }
    expect(w.store.getChannel(w.channelId)?.oldestLoadedSeq).toBe(1051);
    layout.first = 1051; // at the loaded head: 1051..1066
    fireEvent.scroll(timeline);
    await settle(w);
    // The 5th page as loadOlder stores it (1001..1050 held, the range ready), evaluated before React draws it.
    const page = await w.server.apiFor(w.bob.id).history(w.channelId, 1051, 50);
    act(() => {
      for (const message of page.messages) w.store.upsertMessage(message);
      w.store.updateChannel(w.channelId, { oldestLoadedSeq: 1001 });
      expect(rowSeqs(timeline)[0]).toBe(1051);
      fireEvent.scroll(timeline);
    });
    await settle(w);
    expect(w.calls.reads).toEqual([]); // 1051 is not the first unread row: 1001 is, and it was never shown
    layout.first = 1001;
    fireEvent.scroll(timeline);
    await settle(w);
    expect(w.calls.reads).toEqual([{ seq: 1016, mode: "advance" }]);
    w.engine.stop();
  });

  it("V47: 「最初の未読へ」 adds 200 rows with links: previews are asked for only near the screen", async () => {
    layout.rows = 12;
    // A screen above and below the viewport intersects (the card's rootMargin of 100%).
    const observers = new Set<{ callback: IntersectionObserverCallback; targets: Set<Element> }>();
    class NearObserver {
      private readonly entry: { callback: IntersectionObserverCallback; targets: Set<Element> };
      constructor(callback: IntersectionObserverCallback) {
        this.entry = { callback, targets: new Set() };
        observers.add(this.entry);
      }
      observe(target: Element) {
        this.entry.targets.add(target);
      }
      disconnect() {
        observers.delete(this.entry);
      }
    }
    vi.stubGlobal("IntersectionObserver", NearObserver);
    const lookAround = () => {
      for (const observer of [...observers]) {
        const near = [...observer.targets].filter((target) => {
          const seq = Number(target.closest<HTMLElement>("article[data-seq]")?.dataset["seq"]);
          return seq >= layout.first - layout.rows && seq < layout.first + 2 * layout.rows;
        });
        if (near.length) observer.callback(near.map((target) => ({ target, isIntersecting: true }) as IntersectionObserverEntry), observer as unknown as IntersectionObserver);
      }
    };
    const w = world({ posts: 600, lastRead: 400, body: (i) => `m${i} https://example.com/${i}` });
    const controller = controllerFor(w);
    const linkPreview = vi.fn((_url: string) => undefined);
    Object.assign(controller, { linkPreviews: new Map(), linkPreview, subscribeLinkPreviews: () => () => {} });
    await openView(w, controller);
    lookAround();
    await act(async () => {
      fireEvent.click(button("最初の未読へ")!);
      await w.engine.idle();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(w.store.messages(w.channelId)).toHaveLength(250);
    expect(layout.first).toBe(401);
    lookAround();
    const asked = linkPreview.mock.calls.map(([url]) => Number(url.split("/").at(-1)));
    expect(asked.length).toBeLessThan(80);
    expect(asked.every((seq) => (seq >= 389 && seq < 425) || seq >= 577)).toBe(true);
    expect(asked).toContain(401);
    w.engine.stop();
  });

  it("V48: leaving the search context opens like opening: the mark taken again, the divider at the top", async () => {
    const w = world({ posts: 130, lastRead: 100 });
    const records = w.server.channels.get(w.channelId)!.messages;
    const hit = records.find((m) => m.seq === 90)!;
    const controller = controllerFor(w);
    controller.messageFocus = { channelId: w.channelId, messageId: hit.id, parentId: null, context: records.filter((m) => m.seq >= 80 && m.seq <= 100) as MessageOut[] };
    const { view } = await openView(w, controller);
    expect(scrolled).toEqual([{ seq: 90, block: "center", text: expect.any(String) as string }]);
    await act(async () => {
      w.server.markRead(w.bob.id, w.channelId, 110); // another device reads meanwhile
      await w.engine.idle();
    });
    scrolled.length = 0;
    await act(async () => {
      controller.clearMessageFocus();
      view.rerender(<View w={w} controller={controller} />);
    });
    expect(dividerBefore()).toBe(111);
    expect(scrolled).toEqual([{ seq: 111, block: "start", text: "新着メッセージ" }]);
    await settle(w);
    expect(serverRead(w)).toBe(125);
    w.engine.stop();
  });

  it("V48: read to the end, a search hit in the same conversation, back: the newest, no divider", async () => {
    const w = world({ posts: 130, lastRead: 100 });
    const records = w.server.channels.get(w.channelId)!.messages;
    const controller = controllerFor(w);
    const { view, timeline } = await openView(w, controller);
    layout.first = 116;
    fireEvent.scroll(timeline);
    await settle(w);
    expect(serverRead(w)).toBe(130);
    controller.messageFocus = { channelId: w.channelId, messageId: records.find((m) => m.seq === 90)!.id, parentId: null, context: records.filter((m) => m.seq >= 80 && m.seq <= 100) as MessageOut[] };
    await act(async () => {
      view.rerender(<View w={w} controller={controller} />);
    });
    scrolled.length = 0;
    await act(async () => {
      controller.clearMessageFocus();
      view.rerender(<View w={w} controller={controller} />);
    });
    expect(dividerBefore()).toBeNull();
    expect(scrolled).toEqual([]);
    expect(layout.first).toBe(116);
    w.engine.stop();
  });

  it("my post from another device leaves the view where it is; its read.updated reads the channel", async () => {
    const w = world({ posts: 130, lastRead: 100 });
    await openView(w);
    await settle(w);
    expect(layout.first).toBe(101);
    await act(async () => {
      w.server.post(w.channelId, w.bob.id, "from my phone");
      await w.engine.idle();
    });
    await settle(w);
    expect(layout.first).toBe(101);
    expect(w.store.getChannel(w.channelId)).toMatchObject({ lastReadSeq: 131, unreadCount: 0 });
    w.engine.stop();
  });
});

describe("thread pane waits for the whole thread (§10.2)", () => {
  async function openThread(w: Awaited<ReturnType<typeof threadWorld>>) {
    const controller = controllerFor(w);
    const view = render(<View w={w} controller={controller} parentId={w.parent.id} />);
    await act(async () => {
      await w.engine.idle();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    return { view, controller, list: view.container.querySelector<HTMLElement>("[data-replies]")!.closest<HTMLElement>("[data-message-list]")! };
  }

  it("V24: live replies alone sit at the bottom and are not read; once loaded, 「新しい返信」 goes to the top", async () => {
    layout.rows = 8;
    const w = await threadWorld();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const replies = w.api.replies;
    w.api.replies = async (id) => {
      await gate;
      return replies(id);
    };
    const controller = controllerFor(w);
    render(<View w={w} controller={controller} parentId={w.parent.id} />);
    expect(layout.first).toBe(523); // r29 and r30 at the bottom
    expect(screen.queryByText("新しい返信")).toBeNull();
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0)); // a mark would have gone out by now (no debounce here)
    });
    expect(w.calls.threadReads).toEqual([]);
    expect(w.store.threads.get(w.parent.id)?.state.last_read_seq).toBe(510);

    await act(async () => {
      release();
      await w.engine.idle();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(scrolled.at(-1)).toMatchObject({ seq: 511, block: "start", text: "新しい返信" });
    await settle(w);
    expect(w.calls.threadReads).toEqual([518]); // r11..r18 on screen
    // Read now, and the divider stays where it was placed for this open (it used to go at once).
    expect(w.store.threads.get(w.parent.id)?.state.last_read_seq).toBe(518);
    expect(screen.getByText("新しい返信").closest("[data-replies] > *")?.querySelector("article")?.getAttribute("data-seq")).toBe("511");
    w.engine.stop();
  });

  it("leaving the channel through the app forgets that its threads were complete", async () => {
    const w = await threadWorld();
    expect(await w.engine.loadReplies(w.channelId, w.parent.id)).toBe(true);
    const app = new AppController();
    app.api = { leaveChannel: async () => {} } as unknown as ApiClient;
    Object.assign((app as unknown as { active: object }).active, { store: w.store, engine: w.engine });
    expect(await app.leaveChannel(w.channelId)).toBe(true);
    expect(w.store.getChannel(w.channelId)).toBeUndefined();
    expect(w.engine.threadComplete(w.parent.id)).toBe(false);
    w.engine.stop();
  });

  it("V26: nothing unread: opens at the bottom and changes nothing", async () => {
    layout.rows = 8;
    const w = await threadWorld({ threadRead: 530 });
    await openThread(w);
    await settle(w);
    expect(layout.first).toBe(523);
    expect(scrolled).toEqual([]);
    expect(screen.queryByText("新しい返信")).toBeNull();
    expect(w.calls.threadReads).toEqual([]);
    w.engine.stop();
  });

  it("V27: GET replies fails: nothing read; after reconnecting the position is applied once, unless the reader scrolled", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {}); // the queue logs the failed step
    for (const scrolledFirst of [false, true]) {
      layout.rows = 8;
      scrolled.length = 0;
      const w = await threadWorld();
      w.api.failNext(new NetworkError("offline"));
      const { controller, list } = await openThread(w);
      expect(controller.setError).toHaveBeenCalled();
      expect(layout.first).toBe(523);
      await settle(w);
      expect(w.calls.threadReads).toEqual([]);
      if (scrolledFirst) fireEvent.wheel(list);

      w.server.disconnect(w.bob.id);
      await act(async () => {
        for (let i = 0; i < 50 && w.engine.status !== "online"; i++) await w.engine.idle();
        await w.engine.idle();
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      expect(w.engine.threadComplete(w.parent.id)).toBe(true);
      await settle(w);
      if (scrolledFirst) {
        expect(scrolled).toEqual([]); // left where the reader is
        expect(w.calls.threadReads).toEqual([]); // r11 was never shown
      } else {
        expect(scrolled.at(-1)).toMatchObject({ seq: 511, block: "start", text: "新しい返信" });
        expect(w.calls.threadReads).toEqual([518]);
      }
      w.engine.stop();
      cleanup();
    }
  });

  it("a thread never read opens at the first reply from someone else", async () => {
    layout.rows = 8;
    const w = await threadWorld({ threadRead: 0 });
    await openThread(w);
    expect(scrolled.at(-1)).toMatchObject({ seq: 501, block: "start", text: "新しい返信" });
    await settle(w);
    expect(w.calls.threadReads).toEqual([508]);
    w.engine.stop();
  });

  it("V49: a §7.3 reload while online forgets the whole thread: the open pane fetches it again, and reads wait for that", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    layout.rows = 8;
    const w = await threadWorld({ gapLimit: 100 });
    let fetches = 0;
    let gate: Promise<void> | null = null;
    const replies = w.api.replies;
    w.api.replies = async (id) => {
      fetches += 1;
      if (gate) await gate;
      return replies(id);
    };
    const { list } = await openThread(w);
    await settle(w);
    expect(fetches).toBe(1);
    expect(w.calls.threadReads).toEqual([518]);
    let release!: () => void;
    gate = new Promise<void>((resolve) => (release = resolve));
    w.server.socketsOf(w.bob.id)[0]!.dropNext = 149;
    await act(async () => {
      for (let i = 0; i < 150; i++) w.server.post(w.channelId, w.alice.id, `later ${i}`);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(w.engine.stats.reloads).toBe(1);
    expect(w.engine.status).toBe("online");
    expect(fetches).toBe(2); // not waiting for the connection to change
    expect(w.engine.threadComplete(w.parent.id)).toBe(false);
    w.engine.markThreadRead(w.parent.id, 525);
    fireEvent.scroll(list);
    await act(async () => {
      release();
      await w.engine.idle();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(w.engine.threadComplete(w.parent.id)).toBe(true);
    expect(w.calls.threadReads).toEqual([518]);
    layout.first = 519;
    fireEvent.scroll(list);
    await settle(w);
    expect(w.calls.threadReads).toEqual([518, 526]);
    w.engine.stop();
  });

  it("V50: the list moving while the thread loads (replies inserted above) is not the reader scrolling: it still lands", async () => {
    layout.rows = 8;
    const w = await threadWorld();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const replies = w.api.replies;
    w.api.replies = async (id) => {
      await gate;
      return replies(id);
    };
    const view = render(<View w={w} controller={controllerFor(w)} parentId={w.parent.id} />);
    fireEvent.scroll(view.container.querySelector<HTMLElement>("[data-replies]")!.closest<HTMLElement>("[data-message-list]")!);
    await act(async () => {
      release();
      await w.engine.idle();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(scrolled.at(-1)).toMatchObject({ seq: 511, block: "start", text: "新しい返信" });
    w.engine.stop();
  });

  it("V45 in a thread: a §7.3 reload in the background drops the anchor, so a reply cut at the top is not read on", async () => {
    layout.rows = 8;
    const w = await threadWorld({ gapLimit: 5, threadRead: 530 });
    const { list } = await openThread(w);
    await settle(w);
    expect(layout.first).toBe(523); // read to the end: the newest replies
    vi.mocked(document.hasFocus).mockReturnValue(false);
    w.server.socketsOf(w.bob.id)[0]!.dropNext = 9;
    await act(async () => {
      for (let i = 31; i <= 40; i++) w.server.post(w.channelId, w.alice.id, `r${i}`, undefined, w.parent.id);
      await w.engine.idle();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await act(async () => {
      await w.engine.idle();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(w.engine.stats.reloads).toBe(1);
    expect(w.engine.threadComplete(w.parent.id)).toBe(true); // fetched again meanwhile
    layout.first = 531.5; // r31, the first unread reply, cut at the top edge
    vi.mocked(document.hasFocus).mockReturnValue(true);
    fireEvent.focus(window);
    await settle(w);
    expect(w.calls.threadReads).toEqual([]);
    layout.first = 531;
    fireEvent.scroll(list);
    await settle(w);
    expect(w.calls.threadReads).toEqual([538]);
    w.engine.stop();
  });

  it("V51: new replies taller than the screen went past a thread read to the end: the anchor drops, nothing is read", async () => {
    layout.rows = 8;
    const w = await threadWorld({ threadRead: 530 });
    const { list } = await openThread(w);
    await settle(w);
    expect(layout.first).toBe(523);
    w.engine.stop();
    for (let i = 31; i <= 40; i++) w.server.post(w.channelId, w.alice.id, `r${i}`, undefined, w.parent.id);
    await act(async () => {
      await w.engine.start(); // the catch-up brings the 10 replies at once
      await w.engine.idle();
    });
    await settle(w);
    expect(w.store.replies(w.channelId, w.parent.id)).toHaveLength(40);
    layout.first = 533; // followed to the newest replies: 533..540
    fireEvent.scroll(list);
    await settle(w);
    expect(w.calls.threadReads).toEqual([]);
    layout.first = 531;
    fireEvent.scroll(list);
    await settle(w);
    expect(w.calls.threadReads).toEqual([538]);
    w.engine.stop();
  });
});
