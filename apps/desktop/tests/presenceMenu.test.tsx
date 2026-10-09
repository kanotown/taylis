// @vitest-environment jsdom
/**
 * The quick status menu (docs/PRESENCE.md §11): the shared rules (apps/shared/presence-rules.json: my choice, the look
 * others see, 「解除するまで」, the end's label, the one redraw timer, the request body, the durations), the header line,
 * the store's 取り込み中 look and its end by the clock, the red dot (and the directory's 🔕), the menu (choices,
 * durations, 解除), the settings' pause that mirrors it, and a change from another of my devices.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { DndDuration, PresenceChoice, PresenceStatus, UserMe, UserPublic } from "../src/api/types";
import type { AppController } from "../src/state/app";
import { Store } from "../src/sync/store";
import { Avatar } from "../src/ui/Avatar";
import { DirectoryDialog } from "../src/ui/DirectoryDialog";
import { isIndefiniteDnd, pauseValue } from "../src/ui/dnd";
import { MyStatusMenu } from "../src/ui/MyStatusMenu";
import { currentMe, DND_DURATIONS, dndEndLabel, myPresenceChoice, myPresenceLine, presenceLook, presenceRequest } from "../src/ui/presence";
import { SettingsSectionBody } from "../src/ui/Settings";
import { Sidebar } from "../src/ui/Sidebar";

interface PresenceRules {
  now: string;
  my_choice: Array<{ name: string; dnd_until: string | null; presence_hidden: boolean; presence_manual: string | null; choice: PresenceChoice }>;
  look: Array<{ name: string; connection: PresenceStatus; dnd_until: string | null; look: string }>;
  indefinite: Array<{ dnd_until: string | null; indefinite: boolean }>;
  end_label: { tz: string; cases: Array<{ dnd_until: string; label?: string; until_cleared?: boolean }> };
  soonest_end: Array<{ name: string; dnd_until: Array<string | null>; end: string | null }>;
  request: Array<{ status: PresenceChoice; duration?: DndDuration; tz?: string; body: Record<string, string> }>;
  durations: string[];
}
// A path, not a URL object: under jsdom the global URL is jsdom's, which node:fs does not take.
const rules = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../../shared/presence-rules.json"), "utf8")) as PresenceRules;
// The vectors' labels are in this zone (the app uses the device's).
process.env.TZ = rules.end_label.tz;

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const ME = "11111111-1111-4111-8111-111111111111";
const ALICE = "22222222-2222-4222-8222-222222222222";
const FOREVER = "9999-12-31T00:00:00Z";
const inMinutes = (minutes: number) => new Date(Date.now() + minutes * 60_000).toISOString();

const base = { role: "member", deactivated_at: null, created_at: "2026-10-01T00:00:00Z", updated_at: "2026-10-01T00:00:00Z" };
function meWith(over: Partial<UserMe> = {}): UserMe {
  return { id: ME, username: "me", display_name: "わたし", ...base, presence_hidden: false, presence_manual: null, dnd_until: null, ...over } as unknown as UserMe;
}
const alice = (over: Partial<UserPublic> = {}) => ({ id: ALICE, username: "alice", display_name: "アリス", ...base, dnd_until: null, ...over }) as unknown as UserPublic;

function storeWith(me: UserMe): Store {
  const store = new Store();
  store.setMe(me);
  store.upsertUser(me);
  store.upsertUser(alice());
  return store;
}

function controllerFor(store: Store, setMyPresence = vi.fn(async () => true)) {
  return { store, me: store.me, isGuest: false, isAdmin: false, can: () => false, version: 0, subscribe: () => () => {}, setError: vi.fn(), setMyPresence, updateProfile: vi.fn(async () => true) } as unknown as AppController & { updateProfile: ReturnType<typeof vi.fn> };
}

describe("the shared rules (apps/shared/presence-rules.json)", () => {
  const now = Date.parse(rules.now);

  it.each(rules.my_choice.map((c) => [c.name, c] as const))("my choice: %s", (_name, c) => {
    expect(myPresenceChoice({ dnd_until: c.dnd_until, presence_hidden: c.presence_hidden, presence_manual: c.presence_manual as UserMe["presence_manual"] }, now)).toBe(c.choice);
  });

  it.each(rules.look.map((c) => [c.name, c] as const))("the look others see: %s", (_name, c) => {
    expect(presenceLook(c.connection, { dnd_until: c.dnd_until }, now)).toBe(c.look);
  });

  it("「解除するまで」 is any dnd_until from 9999 on", () => {
    for (const c of rules.indefinite) expect(isIndefiniteDnd(c.dnd_until), String(c.dnd_until)).toBe(c.indefinite);
  });

  it("the end's label: the time today, the date and time on another day, 「解除するまで」", () => {
    for (const c of rules.end_label.cases) expect(dndEndLabel(c.dnd_until, new Date(now)), c.dnd_until).toBe(c.until_cleared ? "解除するまで" : c.label);
  });

  it.each(rules.soonest_end.map((c) => [c.name, c] as const))("the store's one redraw timer: %s", (_name, c) => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const store = new Store();
    c.dnd_until.forEach((until, i) => store.upsertUser(alice({ id: `u${i}`, username: `u${i}`, dnd_until: until })));
    if (c.end === null) {
      expect(vi.getTimerCount()).toBe(0);
      return;
    }
    const before = store.version;
    vi.advanceTimersByTime(Date.parse(c.end) - now);
    expect(store.version).toBe(before); // nothing until the end
    vi.advanceTimersByTime(100);
    expect(store.version).toBeGreaterThan(before); // the redraw, with no event
  });

  it("the request body: 取り込み中 carries its length and the zone, the others only the status", () => {
    for (const c of rules.request) expect(presenceRequest(c.status, c.duration, c.tz), c.status).toEqual(c.body);
  });

  it("the durations, in the menu's order", () => {
    expect(DND_DURATIONS).toEqual(rules.durations);
  });
});

describe("the header line", () => {
  it("names the choice, with the end for 取り込み中", () => {
    const now = new Date(2026, 9, 9, 10, 0);
    expect(myPresenceLine(meWith({ dnd_until: new Date(2026, 9, 9, 15, 30).toISOString() }), now)).toBe("取り込み中（〜15:30）");
    expect(myPresenceLine(meWith({ dnd_until: new Date(2026, 9, 10, 23, 59).toISOString() }), now)).toBe("取り込み中（〜10/10 23:59）");
    expect(myPresenceLine(meWith({ dnd_until: FOREVER }), now)).toBe("取り込み中（解除するまで）");
    expect(myPresenceLine(meWith({ presence_hidden: true }), now)).toBe("オフライン表示");
    expect(myPresenceLine(meWith({ presence_manual: "away" }), now)).toBe("離席中");
    expect(myPresenceLine(meWith(), now)).toBe("オンライン（自動）");
  });
});

describe("the store's look", () => {
  it("shows 取り込み中 from dnd_until and goes back by itself when it ends", () => {
    vi.useFakeTimers();
    const store = storeWith(meWith());
    store.setPresence(ALICE, "away");
    expect(store.presenceOf(ALICE)).toBe("away");
    store.upsertUser(alice({ dnd_until: inMinutes(10) }));
    expect(store.presenceOf(ALICE)).toBe("dnd");
    expect(store.connectionOf(ALICE)).toBe("away");
    const before = store.version;
    vi.advanceTimersByTime(10 * 60_000 + 100);
    expect(store.version).toBeGreaterThan(before); // a redraw without any event
    expect(store.presenceOf(ALICE)).toBe("away");
    // The indefinite pause arms no timer and never ends by itself.
    store.upsertUser(alice({ dnd_until: FOREVER }));
    expect(vi.getTimerCount()).toBe(0);
    expect(store.presenceOf(ALICE)).toBe("dnd");
  });
});

describe("the dot", () => {
  it("取り込み中 is a red disc with a white bar; offline draws nothing unless asked", () => {
    const { container, rerender } = render(<Avatar id={ALICE} name="アリス" presence="dnd" />);
    const dot = container.querySelector('[data-presence="dnd"]')!;
    expect(dot.className).toContain("bg-danger");
    expect(dot.querySelector("[data-dnd-bar]")!.className).toContain("bg-white");
    rerender(<Avatar id={ALICE} name="アリス" presence="offline" />);
    expect(container.querySelector("[data-presence]")).toBeNull();
    rerender(<Avatar id={ALICE} name="アリス" presence="offline" showOffline />);
    expect(container.querySelector('[data-presence="offline"]')).toBeTruthy();
    rerender(<Avatar id={ALICE} name="アリス" presence="away" />);
    expect(container.querySelector('[data-presence="away"]')!.className).toContain("bg-warning");
  });

  it("the sidebar's DM row and my header avatar draw it", () => {
    const store = storeWith(meWith({ presence_manual: "away" }));
    store.upsertUser(alice({ dnd_until: inMinutes(30) }));
    store.setPresence(ME, "away");
    const controller = controllerFor(store);
    const dm = { id: "c1", type: "dm", name: null, isMember: true, member_ids: [ME, ALICE], dm_user_ids: [ME, ALICE], last_seq: 0, last_read_seq: 0, unread_count: 0, mention_count: 0 } as never;
    render(<Sidebar controller={controller} channels={[dm]} currentId={null} unreadOnly={false} onToggleUnreadOnly={() => {}} onOpen={() => {}} onNewDm={() => {}} onNewChannel={() => {}} />);
    const header = screen.getByTestId("sidebar-header");
    const trigger = within(header).getByRole("button", { name: "自分のステータスを変える（離席中）" });
    expect(trigger.querySelector('[data-presence="away"]')).toBeTruthy();
    // The name still opens my profile card (M93).
    expect(within(header).getByRole("button", { name: "自分のプロフィール（わたし）" })).toBeTruthy();
  });

  it("the member directory's 🔕 ends with the pause, like the dot (dnd_until stays set until the next user.updated)", () => {
    vi.useFakeTimers();
    const store = storeWith(meWith());
    store.setPresence(ALICE, "online");
    store.upsertUser(alice({ dnd_until: inMinutes(10) }));
    const controller = controllerFor(store);
    // A new element each time: the main screen redraws the dialog on the store's version (the same element would bail out).
    const dialog = () => <DirectoryDialog controller={controller} onClose={() => {}} onOpen={() => {}} />;
    const view = render(dialog());
    const row = () => screen.getByText("アリス", { selector: "span.font-medium" }).closest("li")!;
    expect(within(row()).getByText("🔕")).toBeTruthy();
    expect(row().querySelector('[data-presence="dnd"]')).toBeTruthy();
    vi.advanceTimersByTime(10 * 60_000 + 100);
    view.rerender(dialog()); // the store's redraw
    expect(store.users.get(ALICE)!.dnd_until).not.toBeNull();
    expect(within(row()).queryByText("🔕")).toBeNull();
    expect(row().querySelector('[data-presence="online"]')).toBeTruthy();
  });
});

async function openMenu(): Promise<HTMLElement> {
  fireEvent.keyDown(screen.getByRole("button", { name: /自分のステータスを変える/ }), { key: "Enter" });
  return screen.findByRole("menu");
}

function renderMenu(store: Store, setMyPresence = vi.fn(async () => true), onSettings?: () => void) {
  const controller = controllerFor(store, setMyPresence);
  render(
    <MyStatusMenu controller={controller} onSettings={onSettings}>
      <button type="button" aria-label="自分のステータスを変える">me</button>
    </MyStatusMenu>,
  );
  return controller;
}

describe("the menu", () => {
  it("offers the four choices with the current one checked, one press each", async () => {
    const setMyPresence = vi.fn(async () => true);
    const store = storeWith(meWith());
    renderMenu(store, setMyPresence);
    const menu = await openMenu();
    expect(menu.querySelector("[data-my-presence-line]")!.textContent).toBe("オンライン（自動）");
    const choices = within(menu).getAllByRole("menuitemradio");
    expect(choices.map((c) => c.getAttribute("data-presence-choice"))).toEqual(["auto", "away", "dnd", "invisible"]);
    expect(choices.map((c) => c.getAttribute("aria-checked"))).toEqual(["true", "false", "false", "false"]);
    fireEvent.click(within(menu).getByText("離席中").closest("[role=menuitemradio]")!);
    expect(setMyPresence).toHaveBeenCalledWith({ status: "away" });
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    await openMenu();
    fireEvent.click(screen.getByText("オフライン表示").closest("[role=menuitemradio]")!);
    expect(setMyPresence).toHaveBeenLastCalledWith({ status: "invisible" });
    // 「ステータスを設定」 and 設定 are in the same menu.
    const onSettings = vi.fn();
    cleanup();
    renderMenu(store, setMyPresence, onSettings);
    const again = await openMenu();
    const opened = vi.fn();
    window.addEventListener("chikuwa:open-status", opened);
    fireEvent.click(within(again).getByText("ステータスを設定"));
    window.removeEventListener("chikuwa:open-status", opened);
    expect(opened).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    fireEvent.click(within(await openMenu()).getByText("設定"));
    expect(onSettings).toHaveBeenCalledTimes(1);
  });

  it("取り込み中 opens the durations; the server gets the choice and this device's zone", async () => {
    const setMyPresence = vi.fn(async () => true);
    renderMenu(storeWith(meWith()), setMyPresence);
    const menu = await openMenu();
    const dnd = menu.querySelector('[data-presence-choice="dnd"]') as HTMLElement;
    dnd.focus();
    fireEvent.keyDown(dnd, { key: "ArrowRight" });
    const durations = await waitFor(() => {
      const list = document.querySelector("[data-dnd-durations]");
      if (!list) throw new Error("not open");
      return list as HTMLElement;
    });
    expect([...durations.querySelectorAll("[data-dnd-duration]")].map((item) => item.textContent)).toEqual([
      "30 分",
      "1 時間",
      "2 時間",
      "4 時間",
      "今日の終わりまで",
      "明日まで",
      "解除するまで",
    ]);
    fireEvent.click(within(durations).getByText("今日の終わりまで"));
    expect(setMyPresence).toHaveBeenCalledWith({ status: "dnd", duration: "today", tz: Intl.DateTimeFormat().resolvedOptions().timeZone });
  });

  it("while 取り込み中: the header says until when, with 「解除」 (the settings' 「再開」: the pause alone ends)", async () => {
    const setMyPresence = vi.fn(async () => true);
    const until = new Date();
    until.setHours(23, 59, 0, 0);
    if (until.getTime() < Date.now() + 60_000) until.setTime(Date.now() + 30 * 60_000);
    // 「在席を隠す」 chosen in the settings underneath: 「解除」 must not drop it, as `auto` would.
    const controller = renderMenu(storeWith(meWith({ dnd_until: until.toISOString(), presence_hidden: true })), setMyPresence);
    const menu = await openMenu();
    expect(menu.querySelector("[data-my-presence-line]")!.textContent).toBe(`取り込み中（〜${dndEndLabel(until.toISOString())}）`);
    expect(menu.querySelector('[data-presence-choice="dnd"]')!.getAttribute("aria-checked")).toBe("true");
    fireEvent.click(within(menu).getByText("解除"));
    expect(controller.updateProfile).toHaveBeenCalledWith({ dnd_until: null });
    expect(setMyPresence).not.toHaveBeenCalled();
  });

  it("follows a change from another of my devices (user.updated before /users/me answers)", async () => {
    const store = storeWith(meWith());
    renderMenu(store);
    const menu = await openMenu();
    expect(menu.querySelector("[data-my-presence-line]")!.textContent).toBe("オンライン（自動）");
    act(() => store.upsertUser({ ...meWith(), dnd_until: FOREVER, updated_at: "2026-10-09T00:00:00Z" } as UserPublic));
    expect(currentMe(store)!.dnd_until).toBe(FOREVER);
    await waitFor(() => expect(menu.querySelector("[data-my-presence-line]")!.textContent).toBe("取り込み中（解除するまで）"));
  });
});

describe("the settings' 「通知を一時停止」", () => {
  it("is the same state: 取り込み中「解除するまで」 shows there, and 「再開」 ends it", async () => {
    const store = storeWith(meWith({ dnd_until: FOREVER }));
    const controller = controllerFor(store);
    expect(pauseValue(FOREVER)).toBe("解除するまで");
    render(<SettingsSectionBody controller={controller} section="pause" />);
    expect(screen.getByText("解除するまで")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "再開" }));
    await waitFor(() => expect(controller.updateProfile).toHaveBeenCalledWith({ dnd_until: null }));
  });
});
