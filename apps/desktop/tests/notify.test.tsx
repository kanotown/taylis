// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { UserMe } from "../src/api/types";
import type { AppController } from "../src/state/app";
import { notificationPermission, notify, requestNotificationPermission } from "../src/platform/notify";
import { Store } from "../src/sync/store";
import { SettingsDialog } from "../src/ui/Dialogs";
import { FakeServer } from "./fakeServer";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

/** The browser's Notification API: `permission` as the browser keeps it, granted by a request. */
function browserNotifications(initial: "default" | "denied" = "default") {
  let permission: NotificationPermission = initial;
  const created: string[] = [];
  const requestPermission = vi.fn(async () => {
    if (permission === "default") permission = "granted";
    return permission;
  });
  class FakeNotification {
    static get permission(): NotificationPermission { return permission; }
    static requestPermission = requestPermission;
    onclose: (() => void) | null = null;
    constructor(title: string) { created.push(title); }
    close(): void {}
  }
  vi.stubGlobal("Notification", FakeNotification);
  return { created, requestPermission };
}

describe("browser notifications (M28b: the permission is asked for from the settings, never from an event)", () => {
  it("shows nothing and asks nothing while never allowed; the settings' request grants it", async () => {
    const { created, requestPermission } = browserNotifications();
    await notify("ChikuwaChat", "a message");
    expect(created).toEqual([]);
    expect(requestPermission).not.toHaveBeenCalled(); // a request outside a click is ignored by browsers
    expect(await notificationPermission()).toBe("default");
    expect(await requestNotificationPermission()).toBe("granted");
    await notify("ChikuwaChat", "a message");
    expect(created).toEqual(["ChikuwaChat"]);
  });

  it("offers 「通知を許可」 in the settings while unset and shows the state afterwards", async () => {
    browserNotifications();
    const server = new FakeServer();
    const me = server.addUser("alice") as unknown as UserMe;
    const store = new Store();
    store.setMe(me);
    store.upsertUser(me);
    const controller = { store, me, totpStatus: async () => ({ enabled: false, recovery_codes_left: 0 }), sendKey: "shift-enter", setSendKey: vi.fn() } as unknown as AppController;
    render(<SettingsDialog controller={controller} onClose={() => {}} />);
    expect(await screen.findByText("未設定")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "通知を許可" }));
    expect(await screen.findByText("許可済み")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "通知を許可" })).toBeNull();
  });

  it("says so when the browser blocked them, with no button to press", async () => {
    browserNotifications("denied");
    const store = new Store();
    const controller = { store, me: null, totpStatus: async () => null, sendKey: "shift-enter", setSendKey: vi.fn() } as unknown as AppController;
    render(<SettingsDialog controller={controller} onClose={() => {}} />);
    expect(await screen.findByText("ブロック中")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "通知を許可" })).toBeNull();
  });
});
