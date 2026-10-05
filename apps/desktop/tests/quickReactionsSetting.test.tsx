// @vitest-environment jsdom
/**
 * M50 「リアクションの候補」: my own quick reactions (UserMe.quick_reactions). The rule (apps/shared/quick-reactions.json),
 * the long-press sheet and the hover bar with a chosen list, the settings' six slots (pick, trade places, 元に戻す, a
 * refused save), my other device following through user.updated, and the sheet's thinner action rows.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { useSyncExternalStore } from "react";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ApiClient } from "../src/api/client";
import type { UserUpdate } from "../src/api/types";
import { AppController } from "../src/state/app";
import { LONG_PRESS_MS, quickReactions, SHEET_REACTIONS } from "../src/ui/MessageActionsSheet";
import { SettingsSectionBody } from "../src/ui/Settings";
import { Timeline } from "../src/ui/Timeline";
import { world, type World } from "./unreadWorld";

interface RuleCase { name: string; chosen: string[] | null; recent: string[]; count: number; expected: string[] }
const cases = JSON.parse(readFileSync(join(process.cwd(), "..", "shared", "quick-reactions.json"), "utf8")) as { defaults: string[]; rule: RuleCase[] };

let hover = true;
beforeEach(() => {
  hover = true;
  vi.stubGlobal("matchMedia", (query: string) => ({ matches: query === "(hover: none)" ? !hover : false, addEventListener: () => {}, removeEventListener: () => {} }));
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  vi.spyOn(document, "hasFocus").mockReturnValue(true);
  HTMLElement.prototype.scrollIntoView = () => {};
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  localStorage.clear();
});

const flush = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });

describe("the rule (apps/shared/quick-reactions.json)", () => {
  it("chosen wins, exactly and in order; null is recent first, then the defaults", () => {
    expect(SHEET_REACTIONS).toEqual(cases.defaults);
    for (const c of cases.rule) expect(quickReactions(c.recent, c.count, c.chosen), c.name).toEqual(c.expected);
  });
});

/** Bob on this device, channel C with one post by alice; PATCH /users/me goes to the fake server (or fails). */
async function setup(options: { fail?: boolean } = {}) {
  const w = world({ posts: 1, lastRead: 1 });
  const patches: UserUpdate[] = [];
  const inner = w.api as unknown as Record<string, unknown>;
  const extra = {
    baseUrl: "http://server",
    updateMe: async (patch: UserUpdate) => {
      patches.push(patch);
      if (options.fail) throw new Error("サーバに接続できません");
      if ("quick_reactions" in patch) w.server.setQuickReactions(w.bob.id, patch.quick_reactions ?? null);
      return w.server.meOf(w.bob.id);
    },
  };
  const api = new Proxy<Record<string, unknown>>({ ...inner, ...extra }, { get: (target, key: string) => target[key] ?? (async () => []) }) as unknown as ApiClient;
  await w.engine.start();
  await w.engine.openChannel(w.channelId);
  await w.engine.idle();
  const controller = new AppController();
  (controller as unknown as { active: unknown }).active = { serverUrl: "http://server", username: "bob", api, store: w.store, engine: w.engine, me: w.store.me, leaving: false };
  const setError = vi.spyOn(controller, "setError");
  render(<Screen w={w} controller={controller} />);
  await flush();
  return { w, controller, patches, setError };
}

function Screen({ w, controller }: { w: World; controller: AppController }) {
  useSyncExternalStore(
    (listener) => {
      const subs = [controller.subscribe(listener), w.store.subscribe(listener), w.engine.subscribe(listener)];
      return () => subs.forEach((unsubscribe) => unsubscribe());
    },
    () => `${controller.version}:${w.store.version}:${w.engine.status}`,
  );
  return (
    <>
      <Timeline controller={controller} channel={w.store.getChannel(w.channelId)!} />
      <div data-testid="settings"><SettingsSectionBody controller={controller} section="input" /></div>
    </>
  );
}

/** The six slots of 「リアクションの候補」, in order. */
function slots(): string[] {
  const section = within(screen.getByTestId("settings")).getByRole("region", { name: "リアクションの候補" });
  return within(section).getAllByRole("button").filter((b) => b.hasAttribute("data-slot")).map((b) => b.textContent ?? "");
}

function slot(index: number): HTMLElement {
  return screen.getByTestId("settings").querySelector(`[data-slot="${index}"]`)!;
}

/** The hover bar's quick reactions of the (only) row. */
function hoverBar(): string[] {
  return [...document.querySelectorAll(".row-actions button")].map((b) => (b as HTMLElement).title).filter((t) => t.endsWith("でリアクション")).map((t) => t.replace(" でリアクション", ""));
}

async function pickInPicker(title: string) {
  const search = within(screen.getByTestId("settings")).getByPlaceholderText("検索（例：tada、乾杯）");
  fireEvent.change(search, { target: { value: title.slice(1, -1) } });
  fireEvent.click(within(screen.getByTestId("settings")).getByTitle(title));
  await flush();
}

describe("「リアクションの候補」 in 入力", () => {
  it("not set: the slots show the recent-first rule; a pick saves all six with that slot replaced", async () => {
    localStorage.setItem("chikuwa.emoji.recent", JSON.stringify(["🙏", ":party:"]));
    const { w, patches } = await setup();
    expect(slots()).toEqual(["🙏", "👍", "❤️", "😂", "🎉", "👀"]);
    const reset = within(screen.getByTestId("settings")).getByRole("button", { name: "元に戻す" }) as HTMLButtonElement;
    expect(reset.disabled).toBe(true);
    expect(hoverBar()).toEqual(["🙏", "👍", "❤️"]);

    fireEvent.click(slot(1));
    expect(slot(1).getAttribute("aria-pressed")).toBe("true");
    // Plain emoji only: no 「カスタム」 tab, and the recent :party: is not offered.
    expect(within(screen.getByTestId("settings")).queryByText("カスタム")).toBeNull();
    await pickInPicker(":sushi:");
    expect(patches).toEqual([{ quick_reactions: ["🙏", "🍣", "❤️", "😂", "🎉", "👀"] }]);
    expect(slots()).toEqual(["🙏", "🍣", "❤️", "😂", "🎉", "👀"]);
    expect(w.store.me?.quick_reactions).toEqual(["🙏", "🍣", "❤️", "😂", "🎉", "👀"]);
    expect(reset.disabled).toBe(false);
    // The hover bar follows at once (the first three), and recent picks no longer move it.
    expect(hoverBar()).toEqual(["🙏", "🍣", "❤️"]);
    localStorage.setItem("chikuwa.emoji.recent", JSON.stringify(["🔥"]));
    expect(slots()).toEqual(["🙏", "🍣", "❤️", "😂", "🎉", "👀"]);
  });

  it("an emoji already in another slot trades places; 元に戻す goes back to the rule (null)", async () => {
    const { w, patches } = await setup();
    w.server.quickReactions.set(w.bob.id, ["🔥", "🙏", "👍"]);
    await act(async () => { await w.engine.refreshMe(); });
    // refreshMe keeps only newer answers: this one has the same updated_at, which counts.
    expect(slots()).toEqual(["🔥", "🙏", "👍"]);
    fireEvent.click(slot(0));
    await pickInPicker(":+1:");
    expect(patches.at(-1)).toEqual({ quick_reactions: ["👍", "🙏", "🔥"] });
    expect(slots()).toEqual(["👍", "🙏", "🔥"]);

    fireEvent.click(within(screen.getByTestId("settings")).getByRole("button", { name: "元に戻す" }));
    await flush();
    expect(patches.at(-1)).toEqual({ quick_reactions: null });
    expect(w.store.me?.quick_reactions).toBeNull();
    expect(slots()).toEqual(SHEET_REACTIONS);
  });

  it("a refused save puts the previous list back and says why", async () => {
    const { w, setError } = await setup({ fail: true });
    fireEvent.click(slot(5));
    await pickInPicker(":sushi:");
    expect(setError).toHaveBeenCalled();
    expect(w.store.me?.quick_reactions ?? null).toBeNull();
    expect(slots()).toEqual(SHEET_REACTIONS);
  });

  it("a server before M50 (no quick_reactions in UserMe) shows no such setting", async () => {
    const { w } = await setup();
    act(() => {
      const { quick_reactions: _omit, ...older } = w.store.me!;
      w.store.setMe(older);
    });
    expect(within(screen.getByTestId("settings")).queryByRole("region", { name: "リアクションの候補" })).toBeNull();
  });
});

describe("the long-press sheet", () => {
  it("shows exactly the chosen ones in order, and its action rows are 44px with no extra padding", async () => {
    hover = false;
    localStorage.setItem("chikuwa.emoji.recent", JSON.stringify(["🙏"]));
    const { w } = await setup();
    w.server.quickReactions.set(w.bob.id, ["🍣", "🍜", "🍺"]);
    await act(async () => { await w.engine.refreshMe(); });
    const row = document.querySelector('[id^="timeline-"]') as HTMLElement;
    vi.useFakeTimers();
    fireEvent.touchStart(row, { touches: [{ clientX: 10, clientY: 10 }] });
    act(() => { vi.advanceTimersByTime(LONG_PRESS_MS); });
    const sheet = screen.getByRole("dialog", { name: "メッセージの操作" });
    const buttons = within(sheet).getAllByRole("button");
    expect(buttons.slice(0, 4).map((b) => b.getAttribute("aria-label"))).toEqual(["🍣 でリアクション", "🍜 でリアクション", "🍺 でリアクション", "その他のリアクション"]);
    // (b) tester request 2026-10-01: the rows stay one finger (44px) tall, no taller.
    const rows = within(sheet).getAllByRole("listitem").map((li) => li.querySelector("button")!);
    expect(rows.length).toBeGreaterThan(5);
    for (const button of rows) {
      expect(button.className).toContain("h-11");
      expect(button.className).not.toMatch(/\bpy-|\bmin-h-/);
    }
  });
});

describe("my other device", () => {
  it("reads my settings again when user.updated about me is newer; others' changes do not ask", async () => {
    const { w } = await setup();
    const me = vi.spyOn(w.api as unknown as { me: () => Promise<unknown> }, "me");
    act(() => w.server.setQuickReactions(w.alice.id, ["🎉"]));
    await flush();
    expect(me).not.toHaveBeenCalled();
    // My phone chose them: this device hears user.updated (public fields only) and reads GET /users/me.
    act(() => w.server.setQuickReactions(w.bob.id, ["🙏", "🔥"]));
    await vi.waitFor(() => expect(w.store.me?.quick_reactions).toEqual(["🙏", "🔥"]));
    expect(me).toHaveBeenCalledTimes(1);
    expect(slots()).toEqual(["🙏", "🔥"]);
    expect(hoverBar()).toEqual(["🙏", "🔥"]);
  });
});
