// @vitest-environment jsdom
/**
 * M47 「連続した投稿をまとめる」 (per device, off by default): off, every post in a channel and in a thread has its picture
 * and name; on, consecutive posts from one person are grouped in both (the thread's parent always keeps its picture).
 * The real Timeline, ThreadPane and 「表示」 settings on a real AppController, SyncEngine and the fake server.
 */
import { useSyncExternalStore } from "react";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import type { ApiClient } from "../src/api/client";
import { AppController } from "../src/state/app";
import { SettingsSectionBody } from "../src/ui/Settings";
import { ThreadPane } from "../src/ui/ThreadPane";
import { Timeline } from "../src/ui/Timeline";
import { world, type World } from "./unreadWorld";

beforeEach(() => {
  vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} }));
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  vi.spyOn(document, "hasFocus").mockReturnValue(true);
  HTMLElement.prototype.scrollIntoView = () => {};
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  localStorage.clear();
});

/** Channel C: alice twice, bob, alice again; a thread under alice's first post with alice ×2 then bob ×2. */
async function setup() {
  const w = world();
  const one = w.server.post(w.channelId, w.alice.id, "one").message;
  w.server.post(w.channelId, w.alice.id, "two");
  w.server.post(w.channelId, w.bob.id, "three");
  w.server.post(w.channelId, w.alice.id, "four");
  for (const [sender, body] of [[w.alice.id, "r1"], [w.alice.id, "r2"], [w.bob.id, "r3"], [w.bob.id, "r4"]] as const) w.server.post(w.channelId, sender, body, undefined, one.id);
  w.server.markRead(w.bob.id, w.channelId, 8);
  w.server.markThreadRead(w.bob.id, one.id, 8);
  const inner = w.api as unknown as Record<string, unknown>;
  // Whatever else the rows ask for on the side finds nothing.
  const api = new Proxy<Record<string, unknown>>({ ...inner, baseUrl: "http://server" }, { get: (target, key: string) => target[key] ?? (async () => []) }) as unknown as ApiClient;
  await w.engine.start();
  await w.engine.openChannel(w.channelId);
  await w.engine.idle();
  const controller = new AppController();
  (controller as unknown as { active: unknown }).active = { serverUrl: "http://server", username: "bob", api, store: w.store, engine: w.engine, me: w.store.me, leaving: false };
  render(<Screen w={w} controller={controller} parentId={one.id} />);
  await flush();
  return { w, controller };
}

/** The conversation, its thread and the 「表示」 settings side by side, re-rendered like the app. */
function Screen({ w, controller, parentId }: { w: World; controller: AppController; parentId: string }) {
  useSyncExternalStore(
    (listener) => {
      const subs = [controller.subscribe(listener), w.store.subscribe(listener), w.engine.subscribe(listener)];
      return () => subs.forEach((unsubscribe) => unsubscribe());
    },
    () => `${controller.version}:${w.store.version}:${w.engine.status}`,
  );
  const channel = w.store.getChannel(w.channelId)!;
  return (
    <>
      <div data-testid="channel"><Timeline controller={controller} channel={channel} /></div>
      <div data-testid="thread"><ThreadPane controller={controller} channel={channel} parentId={parentId} onClose={() => {}} /></div>
      <div data-testid="settings"><SettingsSectionBody controller={controller} section="appearance" /></div>
    </>
  );
}

const flush = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });

/** Each row's sender name, or "·" for a row grouped under the one before (no picture, no name). */
function rows(pane: "channel" | "thread"): string[] {
  const articles = [...screen.getByTestId(pane).querySelectorAll<HTMLElement>("article")];
  return articles.map((row) => {
    const name = row.querySelector("strong")?.textContent;
    if (!name) expect(row.querySelector(".rounded-\\[22\\%\\]")).toBeNull(); // no picture either
    return name ?? "·";
  });
}

const groupSwitch = () => within(screen.getByTestId("settings")).getByRole("switch", { name: /連続した投稿をまとめる/ });

it("off by default: every post in the channel and in the thread shows its sender", async () => {
  const { w } = await setup();
  expect(groupSwitch()).toHaveProperty("checked", false);
  expect(rows("channel")).toEqual(["Alice", "Alice", "Bob", "Alice"]);
  expect(rows("thread")).toEqual(["Alice", "Alice", "Alice", "Bob", "Bob"]); // the parent, then r1..r4
  w.engine.stop();
});

it("the switch groups the open channel and thread at once, and is kept on this device; off again ungroups them", async () => {
  const { w, controller } = await setup();
  fireEvent.click(groupSwitch());
  await flush();
  expect(controller.groupPosts).toBe(true);
  expect(localStorage.getItem("chikuwa.prefs.groupPosts")).toBe("1");
  expect(rows("channel")).toEqual(["Alice", "·", "Bob", "Alice"]);
  // The parent always keeps its picture; r1 is under it with its own header, r2 and r4 group.
  expect(rows("thread")).toEqual(["Alice", "Alice", "·", "Bob", "·"]);
  expect(new AppController().groupPosts).toBe(true); // the next start reads it back

  fireEvent.click(groupSwitch());
  await flush();
  expect(localStorage.getItem("chikuwa.prefs.groupPosts")).toBeNull();
  expect(rows("channel")).toEqual(["Alice", "Alice", "Bob", "Alice"]);
  expect(rows("thread")).toEqual(["Alice", "Alice", "Alice", "Bob", "Bob"]);
  w.engine.stop();
});

it("without browser storage the switch still works for this window", async () => {
  vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("blocked"); });
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("blocked"); });
  const { w, controller } = await setup();
  expect(controller.groupPosts).toBe(false);
  fireEvent.click(groupSwitch());
  await flush();
  expect(controller.groupPosts).toBe(true);
  expect(rows("channel")).toEqual(["Alice", "·", "Bob", "Alice"]);
  w.engine.stop();
});
