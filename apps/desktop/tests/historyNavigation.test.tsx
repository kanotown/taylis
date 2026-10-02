// @vitest-environment jsdom
/**
 * M67: back / forward between places on the real MainScreen (wide layout), a real SyncEngine and the fake server — the
 * ← → buttons beside the search box, ⌘[ / ⌘] and ⌘← / ⌘→ (macOS), Alt+← / Alt+→ (Windows), not while typing for the
 * arrow keys, not under a dialog, the thread pane not an entry, a conversation that is gone skipped, none on a phone.
 */
import { useSyncExternalStore } from "react";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import type { ApiClient } from "../src/api/client";
import type { MessageOut } from "../src/api/types";
import { AppController } from "../src/state/app";
import { COMPACT_QUERY } from "../src/ui/compact";
import { historyStep } from "../src/ui/historyShortcuts";
import { MainScreen } from "../src/ui/MainScreen";
import { clearScrollMemories } from "../src/ui/scrollMemory";
import { world, type World } from "./unreadWorld";

let compact = false;
let platform = "MacIntel";
const env = vi.hoisted(() => ({ web: true }));
vi.mock("../src/platform/env", async (original) => ({ ...(await original<typeof import("../src/platform/env")>()), isWeb: () => env.web }));
// M75: which centre views were asked to come back where they were scrolled to (the real hook underneath).
const viewRestores = vi.hoisted(() => [] as Array<{ key: string; restore: boolean }>);
vi.mock("../src/ui/viewScrollMemory", async (original) => {
  const real = await original<typeof import("../src/ui/viewScrollMemory")>();
  const useViewScrollMemory: typeof real.useViewScrollMemory = (root, memory, key, restore) =>
    real.useViewScrollMemory(root, memory, key, () => {
      const asked = restore();
      if (key) viewRestores.push({ key, restore: asked });
      return asked;
    });
  return { ...real, useViewScrollMemory };
});

beforeEach(() => {
  clearScrollMemories();
  viewRestores.length = 0;
  compact = false;
  platform = "MacIntel";
  env.web = true;
  localStorage.clear();
  vi.stubGlobal("matchMedia", (query: string) => ({ matches: query === COMPACT_QUERY ? compact : false, addEventListener: () => {}, removeEventListener: () => {} }));
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  vi.spyOn(navigator, "platform", "get").mockImplementation(() => platform);
  vi.spyOn(document, "hasFocus").mockReturnValue(true);
  HTMLElement.prototype.scrollIntoView = () => {};
  // A wide window: the thread pane goes beside the conversation, not over it (paneLayout).
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

/** Bob in #c (alice's post with one reply), #d and #e. */
async function setup() {
  const w = world({ posts: 1, lastRead: 1 });
  const extra = (name: string) => {
    const channel = w.server.createChannel(name, w.alice.id);
    w.server.join(channel.id, w.bob.id);
    return channel.id;
  };
  const d = extra("d");
  const e = extra("e");
  const parent = w.server.channels.get(w.channelId)!.messages[0]!;
  w.server.post(w.channelId, w.alice.id, "返信", undefined, parent.id);
  w.server.markRead(w.bob.id, w.channelId, 2);
  const inner = w.api as unknown as Record<string, unknown>;
  const getMessage = w.api.getMessage as (id: string) => Promise<MessageOut>;
  const messageContext = async (id: string) => [await getMessage(id)];
  const api = new Proxy<Record<string, unknown>>({ ...inner, messageContext }, { get: (target, key: string) => target[key] ?? (async () => []) }) as unknown as ApiClient;
  await w.engine.start();
  await w.engine.idle();
  const controller = new AppController();
  (controller as unknown as { active: unknown }).active = { serverUrl: "http://server", username: "bob", api, store: w.store, engine: w.engine, me: w.store.me, leaving: false };
  render(<Screen w={w} controller={controller} />);
  await settle(w);
  const reply = w.server.channels.get(w.channelId)!.messages[1]!;
  return { w, controller, d, e, reply };
}

const sidebar = () => within(screen.getByRole("navigation", { name: "チャンネルとDM" }));
const openRow = async (w: World, name: string) => {
  fireEvent.click(sidebar().getByRole("button", { name: new RegExp(`^${name}$`) }));
  await settle(w);
};
const title = () => document.querySelector("main header strong")?.textContent ?? null;
const viewActive = (name: string) => sidebar().getByRole("button", { name }).getAttribute("aria-current") === "page";
const backButton = () => within(screen.getByRole("navigation", { name: "履歴" })).getAllByRole("button")[0] as HTMLButtonElement;
const forwardButton = () => within(screen.getByRole("navigation", { name: "履歴" })).getAllByRole("button")[1] as HTMLButtonElement;
const press = async (w: World, init: KeyboardEventInit, target: EventTarget = window) => {
  let event!: KeyboardEvent;
  await act(async () => {
    event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
    target.dispatchEvent(event);
  });
  await settle(w);
  return event;
};
const composer = () => document.querySelector<HTMLTextAreaElement>(".composer textarea")!;

it("the ← → buttons go back and forward between conversations and views; a new place drops the forward entries", async () => {
  const { w } = await setup();
  expect(title()).toBe("c");
  expect(backButton().getAttribute("aria-label")).toBe("戻る (⌘[)");
  expect(forwardButton().getAttribute("aria-label")).toBe("進む (⌘])");
  expect(backButton().disabled).toBe(true);
  expect(forwardButton().disabled).toBe(true);

  await openRow(w, "d");
  expect(title()).toBe("d");
  expect(backButton().disabled).toBe(false);
  expect(forwardButton().disabled).toBe(true);
  fireEvent.click(sidebar().getByRole("button", { name: "スレッド" }));
  await settle(w);
  expect(viewActive("スレッド")).toBe(true);

  fireEvent.click(backButton());
  await settle(w);
  expect(title()).toBe("d");
  expect(viewActive("スレッド")).toBe(false);
  expect(forwardButton().disabled).toBe(false);
  fireEvent.click(backButton());
  await settle(w);
  expect(title()).toBe("c");
  expect(backButton().disabled).toBe(true);
  fireEvent.click(forwardButton());
  await settle(w);
  expect(title()).toBe("d");
  expect(forwardButton().disabled).toBe(false);

  // Somewhere new from the middle: the threads view ahead is gone.
  await openRow(w, "e");
  expect(title()).toBe("e");
  expect(forwardButton().disabled).toBe(true);
  fireEvent.click(backButton());
  await settle(w);
  expect(title()).toBe("d");
  fireEvent.click(backButton());
  await settle(w);
  expect(title()).toBe("c");
  expect(backButton().disabled).toBe(true);
  w.engine.stop();
});

it("macOS: ⌘[ / ⌘] anywhere, ⌘← / ⌘→ only outside a text field, nothing under a dialog", async () => {
  const { w } = await setup();
  await openRow(w, "d");

  expect((await press(w, { key: "[", metaKey: true })).defaultPrevented).toBe(true);
  expect(title()).toBe("c");
  await press(w, { key: "]", metaKey: true });
  expect(title()).toBe("d");
  await press(w, { key: "ArrowLeft", metaKey: true });
  expect(title()).toBe("c");
  await press(w, { key: "ArrowRight", metaKey: true });
  expect(title()).toBe("d");

  // Typing: ⌘← moves to the start of the line, ⌥← by a word; neither navigates nor is taken from the field.
  const field = composer();
  field.focus();
  expect((await press(w, { key: "ArrowLeft", metaKey: true }, field)).defaultPrevented).toBe(false);
  expect((await press(w, { key: "ArrowLeft", altKey: true }, field)).defaultPrevented).toBe(false);
  expect(title()).toBe("d");
  // ⌘[ is no editing key: it goes back from the composer too (Slack).
  await press(w, { key: "[", metaKey: true }, composer());
  expect(title()).toBe("c");
  // Not while the IME composes.
  await press(w, { key: "]", metaKey: true, isComposing: true }, composer());
  expect(title()).toBe("c");

  // Under a dialog (the shortcut list) the keys do nothing.
  await press(w, { key: "/", metaKey: true });
  expect(screen.getByRole("dialog")).toBeTruthy();
  expect(screen.getByText("履歴を戻る / 進む (マウスの戻る / 進むボタンも)")).toBeTruthy();
  await press(w, { key: "]", metaKey: true });
  expect(title()).toBe("c");
  await press(w, { key: "Escape" });
  await press(w, { key: "]", metaKey: true });
  expect(title()).toBe("d");
  w.engine.stop();
});

it("Windows: Alt+← / Alt+→ (also in the composer), not ⌘[; the mouse's back / forward buttons in the desktop app", async () => {
  platform = "Win32";
  env.web = false;
  const { w } = await setup();
  expect(backButton().getAttribute("aria-label")).toBe("戻る (Alt + ←)");
  await openRow(w, "d");
  await press(w, { key: "[", metaKey: true });
  await press(w, { key: "[", ctrlKey: true });
  expect(title()).toBe("d");
  await press(w, { key: "ArrowLeft", altKey: true });
  expect(title()).toBe("c");
  await press(w, { key: "ArrowRight", altKey: true }, composer());
  expect(title()).toBe("d");

  // Mouse buttons 4 / 5 (isWeb() is false here: the desktop app).
  await act(async () => { window.dispatchEvent(new MouseEvent("mouseup", { button: 3, bubbles: true, cancelable: true })); });
  await settle(w);
  expect(title()).toBe("c");
  await act(async () => { window.dispatchEvent(new MouseEvent("mouseup", { button: 4, bubbles: true, cancelable: true })); });
  await settle(w);
  expect(title()).toBe("d");
  w.engine.stop();
});

it("the web build leaves the mouse's back / forward buttons to the browser (its history entries follow them)", async () => {
  const { w } = await setup();
  await openRow(w, "d");
  const up = new MouseEvent("mouseup", { button: 3, bubbles: true, cancelable: true });
  await act(async () => { window.dispatchEvent(up); });
  await settle(w);
  expect(up.defaultPrevented).toBe(false);
  expect(title()).toBe("d");
  w.engine.stop();
});

it("web: the browser's Back / Forward move the ← → history to the entry they restore, not a new visit (review v0.1.18 #13)", async () => {
  const { w } = await setup();
  const states: Record<string, unknown> = { c: history.state };
  await openRow(w, "d");
  states.d = history.state;
  await openRow(w, "e");
  states.e = history.state;
  const browser = async (name: string) => {
    await act(async () => { window.dispatchEvent(new PopStateEvent("popstate", { state: states[name] })); });
    await settle(w);
    expect(title()).toBe(name);
  };

  // C → D → E, browser Back to D: in-app Forward goes to E, in-app Back to C (not C, D, E, D).
  await browser("d");
  expect(forwardButton().disabled).toBe(false);
  expect(backButton().disabled).toBe(false);
  fireEvent.click(forwardButton());
  await settle(w);
  expect(title()).toBe("e");
  expect(forwardButton().disabled).toBe(true);
  await browser("d");
  fireEvent.click(backButton());
  await settle(w);
  expect(title()).toBe("c");
  expect(backButton().disabled).toBe(true);

  // Then the browser's Forward and the in-app arrows / shortcuts alternately.
  await browser("d");
  expect(backButton().disabled).toBe(false);
  expect(forwardButton().disabled).toBe(false);
  await browser("e");
  expect(forwardButton().disabled).toBe(true);
  await press(w, { key: "[", metaKey: true });
  expect(title()).toBe("d");
  await press(w, { key: "[", metaKey: true });
  expect(title()).toBe("c");
  await browser("d");
  await press(w, { key: "]", metaKey: true });
  expect(title()).toBe("e");
  expect(forwardButton().disabled).toBe(true);
  fireEvent.click(backButton());
  await settle(w);
  expect(title()).toBe("d");

  // Somewhere new is still a visit: it drops what is ahead.
  await browser("c");
  await openRow(w, "e");
  fireEvent.click(backButton());
  await settle(w);
  expect(title()).toBe("c");
  expect(backButton().disabled).toBe(true);
  w.engine.stop();
});

it("opening and closing the thread pane is no entry; a conversation that is gone is skipped", async () => {
  const { w, d } = await setup();
  fireEvent.click(screen.getByRole("button", { name: /1 件の返信/ }));
  await settle(w);
  expect(screen.getByText("返信")).toBeTruthy();
  expect(backButton().disabled).toBe(true);

  await openRow(w, "d");
  await openRow(w, "e");
  expect(title()).toBe("e");
  act(() => w.engine.removeChannel(d));
  await settle(w);
  fireEvent.click(backButton());
  await settle(w);
  expect(title()).toBe("c");
  expect(backButton().disabled).toBe(true);
  fireEvent.click(forwardButton());
  await settle(w);
  expect(title()).toBe("e");
  w.engine.stop();
});

it("a message revealed in a conversation is that conversation's entry: back lands on the message again", async () => {
  const { w, controller, reply } = await setup();
  await openRow(w, "d");
  await act(async () => { await controller.openPermalink(reply.id); });
  await settle(w);
  expect(title()).toBe("c");
  expect(controller.messageFocus?.messageId).toBe(reply.id);
  // c, d, c (revealed): the reveal is a place of its own after d.
  await openRow(w, "e");
  expect(controller.messageFocus).toBeNull();
  fireEvent.click(backButton());
  await settle(w);
  expect(title()).toBe("c");
  expect(controller.messageFocus?.messageId).toBe(reply.id);
  expect(screen.getAllByText("返信").length).toBeGreaterThan(0); // its thread beside it, as the reveal left it
  fireEvent.click(backButton());
  await settle(w);
  expect(title()).toBe("d");
  expect(controller.messageFocus).toBeNull();
  w.engine.stop();
});

it("M75: back / forward to a centre view asks it back where it was scrolled to; the sidebar opens it at its top", async () => {
  const { w } = await setup();
  fireEvent.click(sidebar().getByRole("button", { name: "スレッド" }));
  await settle(w);
  await openRow(w, "d");
  fireEvent.click(backButton());
  await settle(w);
  expect(viewActive("スレッド")).toBe(true);
  fireEvent.click(forwardButton());
  await settle(w);
  expect(title()).toBe("d");
  await press(w, { key: "[", metaKey: true });
  expect(viewActive("スレッド")).toBe(true);
  // A conversation in between, then the view again from the sidebar: a fresh open.
  await openRow(w, "e");
  fireEvent.click(sidebar().getByRole("button", { name: "スレッド" }));
  await settle(w);
  expect(viewRestores).toEqual([
    { key: "view:threads", restore: false },
    { key: "view:threads", restore: true },
    { key: "view:threads", restore: true },
    { key: "view:threads", restore: false },
  ]);
  w.engine.stop();
});

it("a phone-width layout has no ← → and leaves ⌘[ to the browser (that layout's own back)", async () => {
  compact = true;
  const { w } = await setup();
  expect(screen.queryByRole("navigation", { name: "履歴" })).toBeNull();
  expect((await press(w, { key: "[", metaKey: true })).defaultPrevented).toBe(false);
  w.engine.stop();
});

it("historyStep: the keys per platform", () => {
  const key = (init: Partial<KeyboardEvent>) => ({ key: "", metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, isComposing: false, target: null, ...init }) as KeyboardEvent;
  expect(historyStep(key({ key: "[", metaKey: true }), true)).toBe(-1);
  expect(historyStep(key({ key: "]", metaKey: true }), true)).toBe(1);
  expect(historyStep(key({ key: "[", metaKey: true, shiftKey: true }), true)).toBeNull(); // the browser's tab switch
  expect(historyStep(key({ key: "ArrowLeft", altKey: true }), true)).toBeNull();
  expect(historyStep(key({ key: "ArrowLeft", altKey: true }), false)).toBe(-1);
  expect(historyStep(key({ key: "ArrowRight", altKey: true }), false)).toBe(1);
  expect(historyStep(key({ key: "[", metaKey: true }), false)).toBeNull();
  expect(historyStep(key({ key: "ArrowLeft", ctrlKey: true, altKey: true }), false)).toBeNull();
});
