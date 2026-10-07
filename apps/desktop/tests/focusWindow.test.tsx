// @vitest-environment jsdom
/**
 * A conversation opened at a message (an activity row, a search hit, a permalink) shows the server's window around it.
 * User report 2026-10-07: after jumping from アクティビティ, the view showed the newest message yet 「最新の会話に戻る」
 * stayed, and rows posted meanwhile never appeared. The window now joins the store's live tail when the two meet, and
 * the button shows only while newer rows are missing or the reader is away from the end.
 */
import { useSyncExternalStore } from "react";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MessageOut } from "../src/api/types";
import type { AppController } from "../src/state/app";
import { Store } from "../src/sync/store";
import type { MessageState } from "../src/sync/types";
import { backToLatestShown, focusWindow } from "../src/ui/focusWindow";
import { Timeline } from "../src/ui/Timeline";
import { FakeServer } from "./fakeServer";

const row = (seq: number | null, extra: Partial<MessageState> = {}) => ({ id: `m${seq ?? "p"}`, seq, deleted: false, ...extra }) as MessageState;

describe("focusWindow", () => {
  it("joins the live tail when the store's loaded range reaches into the window", () => {
    const context = [row(4), row(5), row(6)];
    const live = [row(5), row(6), row(7), row(8)];
    const result = focusWindow(context, live, 5);
    expect(result.joined).toBe(true);
    expect(result.rows.map((m) => m.seq)).toEqual([4, 5, 6, 7, 8]); // no duplicates of the overlap
  });

  it("joins when the store starts right after the window, or holds the whole channel", () => {
    expect(focusWindow([row(4), row(6)], [row(7)], 7).joined).toBe(true);
    expect(focusWindow([row(4), row(6)], [row(7)], 0).joined).toBe(true);
  });

  it("stays a fixed window while rows between it and the store are not loaded", () => {
    const result = focusWindow([row(4), row(5)], [row(40), row(41)], 40);
    expect(result.joined).toBe(false);
    expect(result.rows.map((m) => m.seq)).toEqual([4, 5]);
  });

  it("stays a fixed window before the store has loaded the channel (last_seq not known yet)", () => {
    expect(focusWindow([row(4), row(5)], [], null).joined).toBe(false);
  });

  it("is never joined without a window", () => {
    expect(focusWindow([], [row(1)], 0)).toEqual({ rows: [], joined: false });
  });

  it("brings my placeholders (no seq yet) and leaves deleted rows out", () => {
    const result = focusWindow([row(4), row(5, { deleted: true })], [row(5, { deleted: true }), row(6, { deleted: true }), row(7), row(null)], 4);
    expect(result.rows.map((m) => m.seq)).toEqual([4, 7, null]);
  });

  it("offers 「最新の会話に戻る」 while newer rows are missing or the reader is away from the end", () => {
    expect(backToLatestShown(false, false)).toBe(true);
    expect(backToLatestShown(true, true)).toBe(true);
    expect(backToLatestShown(true, false)).toBe(false);
  });
});

// A fake layout (as in scrollAnchor.test.tsx): 60 px rows, a 600 px list, a real scrollTop.
const VIEW = 600;
const tops = new WeakMap<Element, number>();
const isList = (el: Element) => el.matches("[data-message-list]");
const rowsOf = (list: Element) => [...list.querySelectorAll<HTMLElement>("article[data-seq]")];
const offsetIn = (list: Element, target: HTMLElement) => Math.max(0, rowsOf(list).indexOf(target)) * 60;
const listOf = (el: Element) => el.closest("[data-message-list]");

beforeEach(() => {
  vi.spyOn(document, "hasFocus").mockReturnValue(true);
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    const list = listOf(this);
    let top = 0;
    let height = 0;
    if (this.matches("article[data-seq]") && list) {
      top = offsetIn(list, this) - list.scrollTop;
      height = 60;
    } else if (isList(this)) {
      height = VIEW;
    }
    return { top, bottom: top + height, height, left: 0, right: 300, width: 300, x: 0, y: top, toJSON: () => ({}) } as DOMRect;
  });
  HTMLElement.prototype.scrollIntoView = function (this: HTMLElement) {
    const list = listOf(this);
    if (list && this.matches("article[data-seq]")) list.scrollTop = offsetIn(list, this);
  };
  Object.defineProperty(HTMLElement.prototype, "clientHeight", { configurable: true, get(this: HTMLElement) { return isList(this) ? VIEW : 0; } });
  Object.defineProperty(HTMLElement.prototype, "scrollHeight", { configurable: true, get(this: HTMLElement) { return isList(this) ? Math.max(VIEW, rowsOf(this).length * 60) : 0; } });
  Object.defineProperty(HTMLElement.prototype, "scrollTop", {
    configurable: true,
    get(this: HTMLElement) { return tops.get(this) ?? 0; },
    set(this: HTMLElement, value: number) { tops.set(this, Math.max(0, Math.min(value, this.scrollHeight - this.clientHeight))); },
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  for (const key of ["clientHeight", "scrollTop", "scrollHeight"]) delete (HTMLElement.prototype as unknown as Record<string, unknown>)[key];
});

/** A channel of `posts` messages; the store holds those from `loadedFrom` (null: none loaded yet). */
function world(posts: number, loadedFrom: number | null) {
  const server = new FakeServer();
  const me = server.addUser("alice");
  const other = server.addUser("bob");
  const channel = server.createChannel("general", me.id);
  server.join(channel.id, other.id);
  const all = Array.from({ length: posts }, (_, i) => server.post(channel.id, other.id, `message ${i + 1}`).message);
  const store = new Store();
  store.upsertUser(me);
  store.upsertUser(other);
  store.setMe(me as never);
  store.upsertChannel(channel, { isMember: true, syncedSeq: loadedFrom === null ? null : posts, oldestLoadedSeq: loadedFrom === null ? null : loadedFrom <= 1 ? 0 : loadedFrom });
  if (loadedFrom !== null) for (const m of all.slice(loadedFrom - 1)) store.upsertMessage(m);
  store.updateChannel(channel.id, { lastSeq: posts, lastReadSeq: posts, hasOlder: loadedFrom !== null && loadedFrom > 1 });
  const engine = { send: vi.fn(), markRead: vi.fn(), sendTyping: vi.fn(), status: "online", unreadHold: new Map<string, number>(), reloadCount: () => 0 };
  const controller = { store, engine, api: undefined, setError: vi.fn(), clearMessageFocus: vi.fn(), messageFocus: null as AppController["messageFocus"], editing: null, sendKey: "shift-enter" };
  /** Opened at message `seq`, the server's window: `before` rows before it and `after` from it on (as /context sends). */
  const focusAt = (seq: number, before = 25, after = 26, messageId?: string) => {
    controller.messageFocus = { channelId: channel.id, messageId: messageId ?? all[seq - 1]!.id, parentId: messageId ? all[seq - 1]!.id : null, context: all.slice(Math.max(0, seq - 1 - before), seq - 1 + after) };
  };
  const arrive = (body: string) => {
    const message = server.post(channel.id, other.id, body).message;
    act(() => {
      store.upsertMessage(message);
      store.updateChannel(channel.id, { lastSeq: message.seq, syncedSeq: message.seq });
    });
    return message;
  };
  function View() {
    useSyncExternalStore(store.subscribe.bind(store), () => store.version);
    return <Timeline controller={controller as unknown as AppController} channel={store.getChannel(channel.id)!} />;
  }
  const open = () => {
    const view = render(<View />);
    return { view, list: view.container.querySelector<HTMLElement>(".timeline")! };
  };
  return { server, me, other, channel, all, store, engine, controller, focusAt, arrive, open };
}

const banner = (list: HTMLElement) => list.textContent?.includes("最新の会話に戻る") ?? false;
const seqs = (list: HTMLElement) => rowsOf(list).map((r) => Number(r.dataset["seq"]));
const atEnd = (list: HTMLElement) => list.scrollHeight - list.scrollTop - list.clientHeight;
const scrollTo = (list: HTMLElement, top: number) => {
  fireEvent.wheel(list);
  list.scrollTop = top;
  fireEvent.scroll(list);
};

describe("a conversation opened at a message", () => {
  it("a short channel the window covers: no 「最新の会話に戻る」, and new rows come in and are followed", () => {
    const w = world(5, 1);
    w.focusAt(3);
    const { list } = w.open();
    expect(seqs(list)).toEqual([1, 2, 3, 4, 5]);
    expect(list.querySelector("article.highlighted")?.id).toBe(`timeline-${w.all[2]!.id}`); // still the landing
    expect(banner(list)).toBe(false);
    for (let n = 0; n < 12; n += 1) w.arrive(`new ${n}`); // more than a screen
    expect(seqs(list).at(-1)).toBe(17);
    expect(atEnd(list)).toBe(0); // followed
    expect(banner(list)).toBe(false);
  });

  it("a long channel whose newest rows the store holds: offered while away from the end, gone once the end is on screen", () => {
    const w = world(100, 51);
    w.focusAt(30); // the window runs to 55, the store from 51: they meet
    const { list } = w.open();
    expect(seqs(list).at(-1)).toBe(100);
    expect(atEnd(list)).toBeGreaterThan(240);
    expect(banner(list)).toBe(true);
    scrollTo(list, list.scrollHeight - list.clientHeight);
    expect(banner(list)).toBe(false);
    w.arrive("after reaching the end");
    expect(seqs(list).at(-1)).toBe(101);
    expect(atEnd(list)).toBe(0); // re-attached: followed as in the live view
    scrollTo(list, list.scrollTop - 1000); // up again
    expect(banner(list)).toBe(true);
  });

  it("not within the threshold's reach of the end: still hidden a little above it", () => {
    const w = world(100, 51);
    w.focusAt(30);
    const { list } = w.open();
    scrollTo(list, list.scrollHeight - list.clientHeight - 120);
    expect(banner(list)).toBe(false);
  });

  it("a window far from the newest rows keeps the button, at its end too, and rows arriving do not show in it", () => {
    const w = world(100, 81);
    w.focusAt(30); // the window runs to 55; the store holds 81.. only
    const { list } = w.open();
    expect(seqs(list).at(-1)).toBe(55);
    expect(banner(list)).toBe(true);
    scrollTo(list, list.scrollHeight - list.clientHeight);
    expect(banner(list)).toBe(true);
    w.arrive("elsewhere");
    expect(seqs(list).at(-1)).toBe(55);
    expect(banner(list)).toBe(true);
  });

  it("a window loaded before the channel's rows: joined as soon as the store's first page arrives", () => {
    const w = world(10, null);
    w.focusAt(8);
    const { list } = w.open();
    expect(banner(list)).toBe(true); // nothing says yet that no newer row is missing
    act(() => {
      for (const m of w.all) w.store.upsertMessage(m);
      w.store.updateChannel(w.channel.id, { oldestLoadedSeq: 0, syncedSeq: 10 });
    });
    expect(banner(list)).toBe(false);
    w.arrive("live");
    expect(seqs(list).at(-1)).toBe(11);
  });

  it("a reply revealed in its thread: the timeline around its parent follows the same rule", () => {
    const w = world(6, 1);
    const reply = w.server.post(w.channel.id, w.other.id, "a reply", undefined, w.all[3]!.id).message;
    w.store.upsertMessage(reply);
    w.focusAt(4, 25, 26, reply.id);
    const { list } = w.open();
    expect(list.querySelector("article.highlighted")).toBeNull(); // the reply is highlighted in its thread, not here
    expect(seqs(list)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(banner(list)).toBe(false);
  });

  it("reads nothing, joined or not (a search context, SYNC_PROTOCOL.md §10.1)", () => {
    const w = world(5, 1);
    w.store.updateChannel(w.channel.id, { lastReadSeq: 2, unreadCount: 3 });
    w.focusAt(3);
    w.open();
    w.arrive("new");
    expect(w.engine.markRead).not.toHaveBeenCalled();
  });
});
