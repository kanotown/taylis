// @vitest-environment jsdom
import { useSyncExternalStore } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { UserMe } from "../src/api/types";
import type { AppController } from "../src/state/app";
import { Store } from "../src/sync/store";
import { EDIT_MIN, EDIT_STEP, editBoxHeight, editCap, editMax, handleKeyHeight, readEditHeight, revealDelta, writeEditHeight } from "../src/ui/editBox";
import { Timeline } from "../src/ui/Timeline";
import { FakeServer } from "./fakeServer";

const ROOM = { pane: 800, viewport: 900, composerCap: 280 };

describe("the edit box's height rules (editBox.ts)", () => {
  it("grows with the text up to 60 % of the pane, never under the composer's cap nor over the pane's room", () => {
    expect(editCap(ROOM, null)).toBe(480);
    expect(editBoxHeight(100, ROOM, null, null)).toBe(100); // short: as tall as the text
    expect(editBoxHeight(1216, ROOM, null, null)).toBe(480); // 60 lines: the cap, then it scrolls
    // A short pane: the composer's cap (280), but room left for the handle and the buttons.
    expect(editCap({ ...ROOM, pane: 400 }, null)).toBe(280);
    expect(editCap({ ...ROOM, pane: 300 }, null)).toBe(300 - 64);
    // A phone's keyboard: what the visible viewport leaves decides.
    expect(editMax({ pane: 700, viewport: 360, composerCap: 96 })).toBe(296);
    expect(editCap({ pane: 700, viewport: 360, composerCap: 96 }, null)).toBe(296);
    // Not laid out yet: the composer's cap.
    expect(editCap({ pane: 0, viewport: 0, composerCap: 280 }, null)).toBe(280);
  });

  it("takes the remembered height as its cap and a dragged one as its height, within the room", () => {
    expect(editCap(ROOM, 300)).toBe(300);
    expect(editBoxHeight(1216, ROOM, 300, null)).toBe(300);
    expect(editBoxHeight(100, ROOM, 300, null)).toBe(100); // shorter text: the box stays its own size
    expect(editBoxHeight(100, ROOM, 300, 500)).toBe(500); // dragged: that height while it is open
    expect(editBoxHeight(100, ROOM, null, 10)).toBe(EDIT_MIN);
    expect(editBoxHeight(100, ROOM, null, 5000)).toBe(800 - 64);
    expect(editCap(ROOM, 5000)).toBe(800 - 64);
  });

  it("moves with ↑ / ↓ on the handle (Shift by four lines), Home / End to the least and the most", () => {
    expect(handleKeyHeight("ArrowDown", false, 300, ROOM)).toBe(300 + EDIT_STEP);
    expect(handleKeyHeight("ArrowUp", false, 300, ROOM)).toBe(300 - EDIT_STEP);
    expect(handleKeyHeight("ArrowUp", true, 300, ROOM)).toBe(300 - 4 * EDIT_STEP);
    expect(handleKeyHeight("ArrowUp", false, EDIT_MIN, ROOM)).toBe(EDIT_MIN);
    expect(handleKeyHeight("ArrowDown", false, 730, ROOM)).toBe(736);
    expect(handleKeyHeight("Home", false, 300, ROOM)).toBe(EDIT_MIN);
    expect(handleKeyHeight("End", false, 300, ROOM)).toBe(736);
    expect(handleKeyHeight("a", false, 300, ROOM)).toBeNull();
  });

  it("reveals the box top first on opening, and only follows its growth while typing", () => {
    const view = { top: 100, bottom: 900 };
    expect(revealDelta(view, { top: 300, bottom: 600 }, true)).toBe(0); // in view
    expect(revealDelta(view, { top: 700, bottom: 1300 }, true)).toBe(1300 + 8 - 900); // below: up to its bottom
    expect(revealDelta(view, { top: 700, bottom: 1700 }, true)).toBe(700 - 100 - 8); // taller than the view: its top
    expect(revealDelta(view, { top: -200, bottom: 400 }, true)).toBe(-200 - 100 - 8); // opened above the screen
    // Typing: grown a line below the view, followed; a box whose top was scrolled away is not pulled back.
    expect(revealDelta(view, { top: 500, bottom: 924 }, false)).toBe(32);
    expect(revealDelta(view, { top: -200, bottom: 800 }, false)).toBe(0);
    expect(revealDelta(view, { top: 50, bottom: 950 }, false)).toBe(0);
  });

  it("remembers the height on this device, and survives storage that throws", () => {
    localStorage.clear();
    expect(readEditHeight()).toBeNull();
    writeEditHeight(321.4);
    expect(localStorage.getItem("chikuwa.prefs.editHeight")).toBe("321");
    expect(readEditHeight()).toBe(321);
    writeEditHeight(null);
    expect(readEditHeight()).toBeNull();
    localStorage.setItem("chikuwa.prefs.editHeight", "junk");
    expect(readEditHeight()).toBeNull();
    const get = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    const set = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    expect(readEditHeight()).toBeNull();
    expect(() => writeEditHeight(300)).not.toThrow();
    get.mockRestore();
    set.mockRestore();
    localStorage.clear();
  });
});

// ---- The box in the timeline (jsdom lays nothing out: the sizes the code reads are given here) ----

const LINE = 20;
const PAD = 16;
let rects: { list: { top: number; bottom: number }; box: { top: number; bottom: number } };
const scrollTops = new WeakMap<Element, number>();
const saved: PropertyDescriptor[] = [];

beforeEach(() => {
  localStorage.clear();
  rects = { list: { top: 0, bottom: 800 }, box: { top: 100, bottom: 300 } };
  const proto = HTMLElement.prototype;
  saved.length = 0;
  for (const name of ["clientHeight", "scrollTop"] as const) saved.push(Object.getOwnPropertyDescriptor(proto, name) ?? Object.getOwnPropertyDescriptor(Element.prototype, name)!);
  saved.push(Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "scrollHeight") ?? Object.getOwnPropertyDescriptor(Element.prototype, "scrollHeight")!);
  Object.defineProperty(proto, "clientHeight", { configurable: true, get(this: HTMLElement) { return this.hasAttribute("data-message-list") ? 800 : 0; } });
  Object.defineProperty(proto, "scrollTop", { configurable: true, get(this: HTMLElement) { return scrollTops.get(this) ?? 0; }, set(this: HTMLElement, v: number) { scrollTops.set(this, v); } });
  // A text area as tall as its lines.
  Object.defineProperty(HTMLTextAreaElement.prototype, "scrollHeight", { configurable: true, get(this: HTMLTextAreaElement) { return PAD + LINE * this.value.split("\n").length; } });
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    const span = this.hasAttribute("data-message-list") ? rects.list : this.hasAttribute("data-edit-box") ? rects.box : { top: 0, bottom: 0 };
    return { top: span.top, bottom: span.bottom, height: span.bottom - span.top, left: 0, right: 600, width: 600, x: 0, y: span.top, toJSON: () => ({}) } as DOMRect;
  });
  const range = Range.prototype as unknown as { getClientRects?: unknown; getBoundingClientRect?: unknown };
  range.getClientRects ??= () => [];
  range.getBoundingClientRect ??= () => new DOMRect();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  Object.defineProperty(HTMLElement.prototype, "clientHeight", saved[0]!);
  Object.defineProperty(HTMLElement.prototype, "scrollTop", saved[1]!);
  Object.defineProperty(HTMLTextAreaElement.prototype, "scrollHeight", saved[2]!);
  localStorage.clear();
});

/** The conversation shown, then the edit opened on my message (as a click on 「編集」 does, the list already placed). */
function renderEditing(body: string, mode: "markdown" | "rich" = "markdown") {
  const server = new FakeServer();
  const me = server.addUser("alice");
  const channel = server.createChannel("general", me.id);
  const store = new Store();
  store.setMe(me as unknown as UserMe);
  store.upsertUser(me);
  const mine = server.post(channel.id, me.id, body).message;
  store.upsertMessage(mine);
  store.upsertChannel(server.channels.get(channel.id)!.channel, { isMember: true, syncedSeq: 1, oldestLoadedSeq: 0, lastReadSeq: 1 });
  const controller = {
    store, engine: null, api: null, version: 0, setError: vi.fn(), messageFocus: null, editing: null as string | null, isAdmin: false, sendKey: "mod-enter", composerMode: mode,
    linkPreviews: new Map(), linkPreview: vi.fn(), subscribeLinkPreviews: () => () => {}, subscribe: () => () => {},
    setEditing: vi.fn(function (this: { editing: string | null }, id: string | null) { this.editing = id; }),
    editMessage: vi.fn(async () => true),
  };
  function View() {
    useSyncExternalStore((l) => store.subscribe(l), () => store.version);
    return <Timeline controller={controller as unknown as AppController} channel={store.getChannel(channel.id)!} />;
  }
  const view = render(<View />);
  controller.editing = mine.id;
  view.rerender(<View />);
  return controller;
}

const lines = (n: number) => Array.from({ length: n }, (_, i) => `line ${i + 1}`).join("\n");
const handle = () => screen.getByRole("separator", { name: "編集欄の高さ" });
const list = () => document.querySelector<HTMLElement>("[data-message-list]")!;

describe("the inline edit box in the timeline", () => {
  it("grows with the text up to 60 % of the pane, typing more past the cap scrolls inside", () => {
    renderEditing("short\ntext");
    const area = screen.getByLabelText("メッセージを編集") as HTMLTextAreaElement;
    expect(area.style.height).toBe(`${PAD + 2 * LINE}px`);
    fireEvent.change(area, { target: { value: lines(10) } });
    expect(area.style.height).toBe(`${PAD + 10 * LINE}px`);
    fireEvent.change(area, { target: { value: lines(60) } });
    expect(area.style.height).toBe("480px");
    expect(handle().getAttribute("aria-valuenow")).toBe("480");
  });

  it("opens a long message as tall as the cap, with the box's top in view", () => {
    // The 60-line message sits low on the screen: its box runs past the bottom of the list.
    rects.box = { top: 600, bottom: 1150 };
    renderEditing(lines(60));
    const area = screen.getByLabelText("メッセージを編集") as HTMLTextAreaElement;
    expect(area.style.height).toBe("480px");
    expect(list().scrollTop).toBe(1150 + 8 - 800);
    expect(600 - list().scrollTop).toBeGreaterThanOrEqual(8); // its top still on screen
  });

  it("opens with its top in view when the message is above the screen", () => {
    rects.box = { top: -300, bottom: 250 };
    renderEditing(lines(60));
    expect(list().scrollTop).toBe(-300 - 8);
  });

  it("resizes from its handle with the keyboard, remembers it on this device, and resets", () => {
    renderEditing(lines(60));
    const area = screen.getByLabelText("メッセージを編集") as HTMLTextAreaElement;
    fireEvent.keyDown(handle(), { key: "ArrowDown" });
    expect(area.style.height).toBe(`${480 + EDIT_STEP}px`);
    expect(localStorage.getItem("chikuwa.prefs.editHeight")).toBe(String(480 + EDIT_STEP));
    fireEvent.keyDown(handle(), { key: "ArrowUp", shiftKey: true });
    expect(area.style.height).toBe(`${480 + EDIT_STEP - 4 * EDIT_STEP}px`);
    // The dragged height holds while open, even above shorter text.
    fireEvent.change(area, { target: { value: "one line" } });
    expect(area.style.height).toBe(`${480 - 3 * EDIT_STEP}px`);
    fireEvent.keyDown(handle(), { key: "Delete" });
    expect(localStorage.getItem("chikuwa.prefs.editHeight")).toBeNull();
    expect(area.style.height).toBe(`${PAD + LINE}px`);
  });

  it("resizes by dragging the handle and resets on a double-click", () => {
    renderEditing(lines(60));
    const area = screen.getByLabelText("メッセージを編集") as HTMLTextAreaElement;
    fireEvent.pointerDown(handle(), { button: 0, clientY: 500 });
    act(() => void window.dispatchEvent(new MouseEvent("pointermove", { clientY: 600 })));
    expect(area.style.height).toBe("580px");
    act(() => void window.dispatchEvent(new MouseEvent("pointerup", { clientY: 600 })));
    expect(localStorage.getItem("chikuwa.prefs.editHeight")).toBe("580");
    fireEvent.doubleClick(handle());
    expect(localStorage.getItem("chikuwa.prefs.editHeight")).toBeNull();
    expect(area.style.height).toBe("480px");
  });

  it("opens at the remembered height as its cap", () => {
    localStorage.setItem("chikuwa.prefs.editHeight", "300");
    renderEditing(lines(60));
    expect((screen.getByLabelText("メッセージを編集") as HTMLTextAreaElement).style.height).toBe("300px");
    cleanup();
    renderEditing("short");
    expect((screen.getByLabelText("メッセージを編集") as HTMLTextAreaElement).style.height).toBe(`${PAD + LINE}px`);
  });

  it("Esc on the handle cancels as in the box", () => {
    const controller = renderEditing("text");
    fireEvent.keyDown(handle(), { key: "Escape" });
    expect(controller.setEditing).toHaveBeenCalledWith(null);
  });

  it("gives the rich editor the same cap and the same handle", async () => {
    renderEditing(lines(60), "rich");
    await waitFor(() => expect(document.querySelector(".rich-editor")).not.toBeNull());
    const host = document.querySelector<HTMLElement>(".rich-editor")!.parentElement!;
    expect(host.style.maxHeight).toBe("480px");
    expect(host.style.height).toBe("");
    fireEvent.keyDown(handle(), { key: "ArrowDown" });
    expect(host.style.height).toBe(`${480 + EDIT_STEP}px`);
    expect(localStorage.getItem("chikuwa.prefs.editHeight")).toBe(String(480 + EDIT_STEP));
    fireEvent.doubleClick(handle());
    expect(host.style.height).toBe("");
    expect(host.style.maxHeight).toBe("480px");
  });
});
