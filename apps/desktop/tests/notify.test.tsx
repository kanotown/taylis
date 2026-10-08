// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { UserMe } from "../src/api/types";
import type { AppController } from "../src/state/app";
import { setAvatarPainter } from "../src/platform/notificationAvatar";
import { clearNotifications, notificationPermission, notify, requestNotificationPermission } from "../src/platform/notify";
import { Store } from "../src/sync/store";
import { SettingsDialog } from "../src/ui/Settings";
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
    const controller = { store, me, totpStatus: async () => ({ enabled: false, recovery_codes_left: 0 }), sendKey: "shift-enter", setSendKey: vi.fn(), workspaces: [], subscribe: () => () => {} } as unknown as AppController;
    render(<SettingsDialog controller={controller} onClose={() => {}} />);
    expect(await screen.findByText("未設定")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "通知を許可" }));
    expect(await screen.findByText("許可済み")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "通知を許可" })).toBeNull();
  });

  it("a message's notification has the sender's picture as its icon, a data URL (PUSH_NOTIFICATIONS.md §9.1)", async () => {
    const options: Array<NotificationOptions | undefined> = [];
    class WithOptions {
      static get permission(): NotificationPermission { return "granted"; }
      onclose: (() => void) | null = null;
      constructor(_title: string, init?: NotificationOptions) { options.push(init); }
      close(): void {}
    }
    vi.stubGlobal("Notification", WithOptions);
    setAvatarPainter({ picture: async () => new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1]), initials: async () => new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 2]) });
    try {
      const fetched: string[] = [];
      const sender = { scope: "https://a.example.com", userId: "alice", name: "Alice", version: "v1", fetchBlob: async (path: string) => { fetched.push(path); return new Blob(["x"]); }, conversationId: "c", groupName: null, text: "hi" };
      await notify("Alice", "hi", undefined, { sender });
      await notify("Taylis", "test");
      expect(fetched).toEqual(["/api/v1/users/alice/avatar?v=v1"]); // with the workspace's session
      expect(options[0]).toEqual({ body: "hi", icon: "data:image/png;base64,iVBORw0KGgoB" });
      expect(options[1]).toEqual({ body: "test" });
    } finally {
      setAvatarPainter(null);
    }
  });

  it("a sign-out while a picture is fetched: neither it nor the queued ones appear, nor their clicks (review v0.1.48 #5)", async () => {
    const created: Array<{ title: string; icon?: string; onclick: (() => void) | null }> = [];
    class Tracked {
      static get permission(): NotificationPermission { return "granted"; }
      onclose: (() => void) | null = null;
      onclick: (() => void) | null = null;
      constructor(title: string, init?: NotificationOptions) { created.push(Object.assign(this, { title, icon: init?.icon })); }
      close(): void {}
    }
    vi.stubGlobal("Notification", Tracked);
    setAvatarPainter({ picture: async () => new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1]), initials: async () => new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 2]) });
    try {
      let arrive: ((blob: Blob) => void) | null = null;
      const opened: string[] = [];
      const sender = { scope: "https://a.example.com", userId: "secret", name: "Secret", version: "v1", fetchBlob: () => new Promise<Blob>((resolve) => { arrive = resolve; }), conversationId: "c", groupName: null, text: "confidential" };
      const first = notify("Secret", "confidential", () => opened.push("first"), { sender });
      const second = notify("Secret", "more", () => opened.push("second"));
      const third = notify("Secret", "and more", () => opened.push("third"));
      await vi.waitFor(() => expect(arrive).not.toBeNull());
      clearNotifications();
      arrive!(new Blob(["x"]));
      await Promise.all([first, second, third]);
      expect(created).toEqual([]);
      expect(opened).toEqual([]);
      // The next session's one shows at once (not behind the old picture), alone, without the old picture.
      await notify("Taylis", "after", () => opened.push("after"));
      expect(created.map((n) => [n.title, n.icon])).toEqual([["Taylis", undefined]]);
      vi.stubGlobal("focus", () => {});
      created[0]?.onclick?.();
      expect(opened).toEqual(["after"]);
    } finally {
      setAvatarPainter(null);
    }
  });

  it("says so when the browser blocked them, with no button to press", async () => {
    browserNotifications("denied");
    const store = new Store();
    const controller = { store, me: null, totpStatus: async () => null, sendKey: "shift-enter", setSendKey: vi.fn(), workspaces: [], subscribe: () => () => {} } as unknown as AppController;
    render(<SettingsDialog controller={controller} onClose={() => {}} />);
    expect(await screen.findByText("ブロック中")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "通知を許可" })).toBeNull();
  });
});
