// @vitest-environment jsdom
// M192 (PUSH_NOTIFICATIONS.md §18): 「止めていた間のメンションをまとめて通知」 in the settings (users.notify_digest). The desktop
// shows no summary itself (its unread state is on screen); the switch is for the phones' push.
import { useSyncExternalStore } from "react";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import type { ApiClient } from "../src/api/client";
import type { UserMe, UserPublic } from "../src/api/types";
import { setLocale } from "../src/i18n";
import { AppController } from "../src/state/app";
import { SettingsDialog } from "../src/ui/Settings";

afterEach(() => {
  cleanup();
  setLocale("ja");
});

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
  return { controller, patches };
}

function openNotifications(name: string) {
  fireEvent.click(within(screen.getByRole("navigation", { name: name === "通知" ? "設定の項目" : "Settings" })).getByRole("button", { name }));
}

describe("「止めていた間のメンションをまとめて通知」", () => {
  it("is on by default, explains itself and is saved as notify_digest", async () => {
    const { controller, patches } = setup({ notify_digest: true });
    openNotifications("通知");
    const toggle = screen.getByRole("switch", { name: /止めていた間のメンションをまとめて通知/ }) as HTMLInputElement;
    expect(toggle.checked).toBe(true);
    expect(screen.getByText("おやすみ時間・一時停止のあとに 1 件にまとめて届きます")).toBeTruthy();
    fireEvent.click(toggle);
    await flush();
    expect(patches).toEqual([{ notify_digest: false }]);
    expect(controller.store.me?.notify_digest).toBe(false);
    expect((screen.getByRole("switch", { name: /止めていた間のメンションをまとめて通知/ }) as HTMLInputElement).checked).toBe(false);
    fireEvent.click(screen.getByRole("switch", { name: /止めていた間のメンションをまとめて通知/ }));
    await flush();
    expect(patches).toEqual([{ notify_digest: false }, { notify_digest: true }]);
  });

  it("is not offered by a server without the setting", () => {
    setup({});
    openNotifications("通知");
    expect(screen.queryByRole("switch", { name: /止めていた間のメンションをまとめて通知/ })).toBeNull();
  });

  it("reads in English too", () => {
    setLocale("en");
    setup({ notify_digest: true });
    openNotifications("Notifications");
    expect(screen.getByRole("switch", { name: /Sum up the mentions from while notifications were paused/ })).toBeTruthy();
    expect(screen.getByText("Arrives as one notification after quiet hours or a pause")).toBeTruthy();
  });
});
