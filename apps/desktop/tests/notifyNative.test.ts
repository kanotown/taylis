// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The macOS app shows notifications through our UNUserNotificationCenter commands (src-tauri/src/mac_notify.rs) so they
// appear while Taylis is frontmost, Windows through our own toasts (src-tauri/src/win_notify.rs) so that a click comes
// back; elsewhere ("unavailable": Linux, tauri dev on macOS) the notification plugin as before.
const state = vi.hoisted(() => ({
  native: "granted" as string,
  afterRequest: "granted" as string,
  calls: [] as { command: string; args?: Record<string, unknown> }[],
  clicked: null as ((event: { payload: string }) => void) | null,
  plugin: { granted: true, sent: [] as string[] },
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: async (command: string, args?: Record<string, unknown>) => {
    state.calls.push({ command, args });
    if (command === "native_notification_permission") {
      if (state.native === "throw") throw new Error("command not found");
      return state.native;
    }
    if (command === "native_notification_request") return (state.native = state.afterRequest);
    return undefined;
  },
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: async (event: string, handler: (event: { payload: string }) => void) => {
    if (event === "notification-clicked") state.clicked = handler;
    return () => {};
  },
}));

vi.mock("@tauri-apps/plugin-notification", () => ({
  isPermissionGranted: async () => state.plugin.granted,
  requestPermission: async () => "granted",
  sendNotification: ({ title }: { title: string }) => state.plugin.sent.push(title),
}));

import { clearNotifications, notificationPermission, notify, requestNotificationPermission } from "../src/platform/notify";

const commands = () => state.calls.map((c) => c.command);
const sent = () => state.calls.filter((c) => c.command === "native_notification_send").map((c) => c.args);

beforeEach(() => {
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
  state.native = "granted";
  state.afterRequest = "granted";
  state.calls = [];
  state.plugin.sent = [];
});

afterEach(() => {
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
});

describe("desktop notifications on macOS (native UNUserNotificationCenter)", () => {
  it("shows through the native command, not the plugin", async () => {
    await notify("Taylis", "hello");
    expect(sent()).toEqual([expect.objectContaining({ title: "Taylis", body: "hello" })]);
    expect(state.plugin.sent).toEqual([]);
  });

  it("runs the click action of the clicked notification only, once", async () => {
    const opened: string[] = [];
    await notify("task", "a", () => opened.push("a"));
    await notify("task", "b", () => opened.push("b"));
    const ids = sent().map((args) => String(args?.id));
    expect(ids).toHaveLength(2);
    const [first, second] = ids as [string, string];
    expect(first).not.toBe(second);
    state.clicked?.({ payload: second });
    state.clicked?.({ payload: second });
    expect(opened).toEqual(["b"]);
    clearNotifications();
    state.clicked?.({ payload: first });
    expect(opened).toEqual(["b"]); // sign-out forgets the actions
    await vi.waitFor(() => expect(commands()).toContain("native_notification_clear"));
  });

  it("asks the OS the first time, and shows nothing when the reader declines", async () => {
    state.native = "default";
    state.afterRequest = "denied";
    await notify("Taylis", "hello");
    expect(commands()).toContain("native_notification_request");
    expect(sent()).toEqual([]);
  });

  it("the settings show what System Settings say and ask from 「通知を許可」", async () => {
    state.native = "denied";
    expect(await notificationPermission()).toBe("denied");
    state.native = "default";
    expect(await notificationPermission()).toBe("default");
    expect(await requestNotificationPermission()).toBe("granted");
  });

  it("falls back to the notification plugin where native ones are unavailable (Linux, tauri dev)", async () => {
    state.native = "unavailable";
    await notify("Taylis", "hello");
    expect(sent()).toEqual([]);
    expect(state.plugin.sent).toEqual(["Taylis"]);
    expect(await notificationPermission()).toBe("granted");
  });

  it("falls back to the plugin when the native command fails", async () => {
    state.native = "throw";
    await notify("Taylis", "hello");
    expect(sent()).toEqual([]);
    expect(state.plugin.sent).toEqual(["Taylis"]);
  });
});

describe("desktop notifications on Windows (our own toasts, win_notify.rs)", () => {
  // The Rust side answers "granted" on Windows (toasts have no permission prompt). Before, Windows used the plugin,
  // whose toasts never reported a click: clicking one only dismissed it (the issue, desktop v0.1.45).
  it("shows through the native command, never asks, and a click runs the notification's own action", async () => {
    const opened: string[] = [];
    await notify("#general", "alice: hi", () => opened.push("message"));
    expect(commands()).not.toContain("native_notification_request");
    expect(state.plugin.sent).toEqual([]);
    const [args] = sent();
    expect(args).toEqual(expect.objectContaining({ title: "#general", body: "alice: hi" }));
    state.clicked?.({ payload: String(args?.id) });
    expect(opened).toEqual(["message"]);
    expect(await notificationPermission()).toBe("granted");
    expect(await requestNotificationPermission()).toBe("granted");
  });

  it("a notification without a click action is still shown (its click only brings the window up, on the Rust side)", async () => {
    await notify("Taylis", "test");
    expect(sent()).toEqual([expect.objectContaining({ title: "Taylis", body: "test" })]);
  });
});
