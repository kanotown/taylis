// @vitest-environment jsdom
// 2026-10-30 (PUSH_NOTIFICATIONS.md §4, SYNC_PROTOCOL.md §10.5): 「他の人の Times もすべて通知」 in the settings
// (users.times_notification_default), and the unread rules following it through the store's `me`.
import { useSyncExternalStore } from "react";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import type { ApiClient } from "../src/api/client";
import type { ChannelOut, UserMe, UserPublic } from "../src/api/types";
import { AppController } from "../src/state/app";
import { hasUnread, isQuietChannel } from "../src/ui/channels";
import { SettingsDialog } from "../src/ui/Settings";

afterEach(() => cleanup());

const flush = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });

const ME = "11111111-1111-4111-8111-1111111111aa";
const me = (extra: Partial<UserMe>): UserMe =>
  ({ id: ME, username: "me", display_name: "わたし", email: null, must_change_password: false, notify_keywords: [], presence_hidden: false, notification_default: "all", notify_reactions: false, notify_tasks: true, has_password: true, ...extra }) as unknown as UserMe;

function setup(initial: Partial<UserMe>) {
  const patches: unknown[] = [];
  const controller = new AppController();
  controller.api = {
    baseUrl: "http://server",
    totpStatus: async () => ({ enabled: false, recovery_codes_left: 0 }),
    updateMe: async (patch: Partial<UserMe>) => { patches.push(patch); return { ...controller.store.me!, ...patch }; },
  } as unknown as ApiClient;
  controller.store.setMe(me(initial));
  controller.store.upsertUser({ id: ME, username: "me", display_name: "わたし" } as UserPublic);
  function View() {
    useSyncExternalStore((l) => controller.store.subscribe(l), () => controller.store.version);
    return <SettingsDialog controller={controller} onClose={() => {}} />;
  }
  render(<View />);
  fireEvent.click(within(screen.getByRole("navigation", { name: "設定の項目" })).getByRole("button", { name: "通知" }));
  return { controller, patches };
}

describe("「他の人の Times もすべて通知」", () => {
  it("is saved as times_notification_default and lifts the quiet unread of others' times", async () => {
    const { controller, patches } = setup({ times_notification_default: "mentions" });
    controller.store.upsertChannel({ id: "c-times", type: "public", name: "times-bob", times_owner_id: "bob", archived: false, created_at: "2026-01-01T00:00:00Z", last_seq: 4 } as unknown as ChannelOut, { isMember: true, unreadCount: 3, mentionCount: 0 });
    const times = () => controller.store.getChannel("c-times")!;
    expect([hasUnread(times(), ME), isQuietChannel(times(), ME)]).toEqual([false, true]);

    const toggle = screen.getByRole("switch", { name: /他の人の Times もすべて通知/ }) as HTMLInputElement;
    expect(toggle.checked).toBe(false);
    fireEvent.click(toggle);
    await flush();
    expect(patches).toEqual([{ times_notification_default: "all" }]);
    expect((screen.getByRole("switch", { name: /他の人の Times もすべて通知/ }) as HTMLInputElement).checked).toBe(true);
    expect([hasUnread(times(), ME), isQuietChannel(times(), ME)]).toEqual([true, false]);
  });

  it("is not offered by a server without the setting", () => {
    setup({});
    expect(screen.queryByRole("switch", { name: /他の人の Times もすべて通知/ })).toBeNull();
  });
});
