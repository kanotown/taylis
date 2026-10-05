// @vitest-environment jsdom
/**
 * M35 (PUSH_NOTIFICATIONS.md §4): the overall notification setting in the settings, a conversation's notification menu
 * (「既定（…）」 / its own levels / 「ミュート」 / 「8 時間ミュート」), the sidebar row's 「ミュート」, and /mute and /unmute —
 * on the real MainScreen with a real SyncEngine and the fake server answering the PUTs and PATCH /users/me.
 */
import { useSyncExternalStore } from "react";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import type { ApiClient } from "../src/api/client";
import type { NotificationLevel, UserUpdate } from "../src/api/types";
import { AppController } from "../src/state/app";
import { ChannelDetails } from "../src/ui/ChannelDetails";
import { SettingsDialog } from "../src/ui/Settings";
import { MainScreen } from "../src/ui/MainScreen";
import { world, type World } from "./unreadWorld";

beforeEach(() => {
  // The wide layout (no media query matches): the header's bell menu and the sidebar.
  vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} }));
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  vi.spyOn(document, "hasFocus").mockReturnValue(true);
  HTMLElement.prototype.scrollIntoView = () => {};
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

interface PrefCall { channelId: string; level: NotificationLevel | null; mutedUntil: string | null; muted: boolean | undefined }

/** Channel C (bob reads everything), bob on this device. The PUTs and PATCH /users/me go to the fake server. */
async function setup() {
  const w = world({ posts: 2, lastRead: 2 });
  const puts: PrefCall[] = [];
  const extra: Record<string, unknown> = {
    setNotificationPreference: async (channelId: string, level: NotificationLevel | null, mutedUntil: string | null, muted?: boolean) => {
      puts.push({ channelId, level, mutedUntil, muted });
      return w.server.setNotificationPreference(w.bob.id, channelId, { level, muted_until: mutedUntil, muted });
    },
    updateMe: async (patch: UserUpdate) => {
      if (patch.notification_default) w.server.setNotificationDefault(w.bob.id, patch.notification_default);
      return (await w.api.bootstrap()).me;
    },
    totpStatus: async () => ({ enabled: false, recovery_codes_left: 0 }),
  };
  const inner = w.api as unknown as Record<string, unknown>;
  // Whatever else the screen asks for on the side (custom emoji, sections, drafts …) finds nothing.
  const api = new Proxy({ ...inner, ...extra }, { get: (target, key: string) => target[key] ?? (async () => []) }) as unknown as ApiClient;
  await w.engine.start();
  await w.engine.idle();
  const controller = new AppController();
  (controller as unknown as { active: unknown }).active = { serverUrl: "http://server", username: "bob", api, store: w.store, engine: w.engine, me: w.store.me, leaving: false };
  return { w, controller, puts };
}

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

/** Opens the header's bell menu (Radix opens a menu from the keyboard as well). */
async function openBellMenu() {
  fireEvent.keyDown(screen.getByRole("button", { name: "通知設定" }), { key: "Enter" });
  await flush();
  return screen.getByRole("menu");
}

async function choose(item: HTMLElement, w: World) {
  fireEvent.click(item);
  await act(async () => { await w.engine.idle(); await new Promise((resolve) => setTimeout(resolve, 0)); });
}

const sidebarRow = () => within(screen.getByRole("navigation", { name: "チャンネルとDM" })).getByRole("button", { name: /^c/ });

it("the header menu: 「既定（…）」 follows the overall setting, own levels, 「ミュート」 on / off and the timed mute", async () => {
  const { w, controller, puts } = await setup();
  render(<Screen w={w} controller={controller} />);
  await flush();
  fireEvent.click(sidebarRow());
  await flush();

  let menu = await openBellMenu();
  const followDefault = within(menu).getByRole("menuitemradio", { name: "既定（メンションと DM のみ）" });
  expect(followDefault.getAttribute("aria-checked")).toBe("true");
  expect(within(menu).getByRole("menuitemcheckbox", { name: "ミュート" }).getAttribute("aria-checked")).toBe("false");
  await choose(within(menu).getByRole("menuitemradio", { name: "すべてのメッセージ" }), w);
  expect(puts.at(-1)).toEqual({ channelId: w.channelId, level: "all", mutedUntil: null, muted: undefined });
  expect(w.store.getChannel(w.channelId)).toMatchObject({ notificationLevel: "all", muted: false });

  // Back to the default: level null. The overall setting changes 「既定（…）」.
  menu = await openBellMenu();
  await choose(within(menu).getByRole("menuitemradio", { name: "既定（メンションと DM のみ）" }), w);
  expect(puts.at(-1)).toMatchObject({ level: null, muted: undefined });
  expect(w.store.getChannel(w.channelId)!.notificationLevel).toBeNull();
  await act(async () => { await controller.setNotificationDefault("all"); });
  menu = await openBellMenu();
  expect(within(menu).getByRole("menuitemradio", { name: "既定（すべての新着メッセージ）" }).getAttribute("aria-checked")).toBe("true");

  // Muted until unmuted: the own level stays null, the sidebar shows it muted; the bell is crossed out.
  await choose(within(menu).getByRole("menuitemcheckbox", { name: "ミュート" }), w);
  expect(puts.at(-1)).toEqual({ channelId: w.channelId, level: null, mutedUntil: null, muted: true });
  expect(w.store.getChannel(w.channelId)).toMatchObject({ notificationLevel: null, muted: true });
  expect(sidebarRow().querySelector(".lucide-bell-off")).toBeTruthy();
  expect(screen.getByRole("button", { name: "通知設定" }).querySelector(".lucide-bell-off")).toBeTruthy();
  menu = await openBellMenu();
  expect(within(menu).getByRole("menuitemcheckbox", { name: "ミュート" }).getAttribute("aria-checked")).toBe("true");

  // The timed mute is still there, and leaves `muted` as it is.
  await choose(within(menu).getByRole("menuitem", { name: "8 時間ミュート" }), w);
  expect(puts.at(-1)).toMatchObject({ level: null, muted: undefined });
  expect(puts.at(-1)!.mutedUntil).not.toBeNull();
  expect(w.store.getChannel(w.channelId)).toMatchObject({ muted: true });
  menu = await openBellMenu();
  expect(within(menu).getByRole("menuitem", { name: /^ミュート解除（/ })).toBeTruthy();
  await choose(within(menu).getByRole("menuitemcheckbox", { name: "ミュート" }), w);
  expect(puts.at(-1)).toMatchObject({ level: null, muted: false });
  expect(puts.at(-1)!.mutedUntil).not.toBeNull(); // the timed mute keeps running
  w.engine.stop();
});

it("the sidebar row's context menu mutes until unmuted, and 「ミュート解除」 ends both mutes", async () => {
  const { w, controller, puts } = await setup();
  w.server.setNotificationPreference(w.bob.id, w.channelId, { level: "all", muted_until: null });
  await w.engine.idle();
  render(<Screen w={w} controller={controller} />);
  await flush();
  expect(sidebarRow().querySelector(".lucide-bell-off")).toBeNull();

  fireEvent.contextMenu(sidebarRow());
  await flush();
  await choose(within(screen.getByRole("menu")).getByRole("menuitem", { name: "ミュート" }), w);
  expect(puts.at(-1)).toEqual({ channelId: w.channelId, level: "all", mutedUntil: null, muted: true });
  expect(sidebarRow().querySelector(".lucide-bell-off")).toBeTruthy();

  act(() => w.store.setNotification(w.channelId, "all", new Date(Date.now() + 3_600_000).toISOString(), true));
  fireEvent.contextMenu(sidebarRow());
  await flush();
  await choose(within(screen.getByRole("menu")).getByRole("menuitem", { name: "ミュート解除" }), w);
  expect(puts.at(-1)).toEqual({ channelId: w.channelId, level: "all", mutedUntil: null, muted: false });
  expect(w.store.getChannel(w.channelId)).toMatchObject({ notificationLevel: "all", mutedUntil: null, muted: false });
  expect(sidebarRow().querySelector(".lucide-bell-off")).toBeNull();
  w.engine.stop();
});

it("/mute sets the timed mute with the own level (null when following the default); /unmute ends both mutes", async () => {
  const { w, controller, puts } = await setup();
  const channel = () => w.store.getChannel(w.channelId)!;
  await act(async () => { await controller.runCommand({ name: "mute", args: "", known: true }, channel(), null); });
  expect(puts.at(-1)).toMatchObject({ level: null, muted: undefined });
  expect(puts.at(-1)!.mutedUntil).not.toBeNull();
  act(() => w.store.setNotification(w.channelId, "mentions", channel().mutedUntil, true));
  await act(async () => { await controller.runCommand({ name: "unmute", args: "", known: true }, channel(), null); });
  expect(puts.at(-1)).toEqual({ channelId: w.channelId, level: "mentions", mutedUntil: null, muted: false });
  w.engine.stop();
});

it("the phone's details page: the same choices as radios, 「ミュート」 as a switch", async () => {
  const { w, controller, puts } = await setup();
  const Details = () => {
    useSyncExternalStore((listener) => w.store.subscribe(listener), () => w.store.version);
    return <ChannelDetails controller={controller} channel={w.store.getChannel(w.channelId)!} onClose={() => {}} onDialog={() => {}} membersVersion={0} />;
  };
  render(<Details />);
  await flush();
  const group = screen.getByRole("radiogroup", { name: "通知" });
  expect((within(group).getByRole("radio", { name: "既定（メンションと DM のみ）" }) as HTMLInputElement).checked).toBe(true);
  fireEvent.click(within(group).getByRole("radio", { name: "通知しない" }));
  await flush();
  expect(puts.at(-1)).toEqual({ channelId: w.channelId, level: "none", mutedUntil: null, muted: undefined });
  expect((within(group).getByRole("radio", { name: "通知しない" }) as HTMLInputElement).checked).toBe(true);
  fireEvent.click(screen.getByRole("switch", { name: /^ミュート/ }));
  await flush();
  expect(puts.at(-1)).toEqual({ channelId: w.channelId, level: "none", mutedUntil: null, muted: true });
  expect((screen.getByRole("switch", { name: /^ミュート/ }) as HTMLInputElement).checked).toBe(true);
  expect(screen.getByRole("button", { name: "8 時間ミュート" })).toBeTruthy();
  w.engine.stop();
});

it("the settings' overall 「通知」 saves at once and explains that channels and DMs come first", async () => {
  const { w, controller } = await setup();
  render(<SettingsDialog controller={controller} onClose={() => {}} />);
  await flush();
  const group = screen.getByRole("radiogroup", { name: "通知" });
  expect((within(group).getByRole("radio", { name: "メンションと DM のみ" }) as HTMLInputElement).checked).toBe(true);
  expect(screen.getByText("チャンネルごとの設定が優先されます。DM は『なし』以外なら常に通知されます。")).toBeTruthy();
  fireEvent.click(within(group).getByRole("radio", { name: "なし" }));
  await flush();
  expect(w.server.notificationDefaults.get(w.bob.id)).toBe("none");
  expect(w.store.me?.notification_default).toBe("none");
  expect((within(group).getByRole("radio", { name: "なし" }) as HTMLInputElement).checked).toBe(true);
  expect((within(group).getByRole("radio", { name: "すべての新着メッセージ" }) as HTMLInputElement).checked).toBe(false);
  w.engine.stop();
});
