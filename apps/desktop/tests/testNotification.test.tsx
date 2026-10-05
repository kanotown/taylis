// @vitest-environment jsdom
/**
 * 「テスト通知を送る」 (PUSH_NOTIFICATIONS.md §15): the words for each device's result, the settings' button and list, the
 * local notification shown at once, and notification.test from another device of mine.
 */
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ApiError } from "../src/api/errors";
import type { NotificationTest, TestNotificationDevice, TestNotificationOut, UserMe } from "../src/api/types";
import { AppController, testNotificationBody } from "../src/state/app";

const TEST_NOTIFICATION_BODY = testNotificationBody();
import { SyncEngine } from "../src/sync/engine";
import { Store } from "../src/sync/store";
import { SettingsDialog } from "../src/ui/Settings";
import { permissionHint, testDeviceName, testDeviceStatus, testNotificationNotes } from "../src/ui/TestNotification";
import { FakeServer } from "./fakeServer";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function device(extra: Partial<TestNotificationDevice>): TestNotificationDevice {
  return { device_id: crypto.randomUUID(), device_name: null, platform: "ios", push_provider: "apns", current: false, status: "sent", detail: null, last_seen_at: null, ...extra };
}

function result(devices: TestNotificationDevice[], extra: Partial<TestNotificationOut> = {}): TestNotificationOut {
  return { apns_configured: true, fcm_configured: true, dnd_active: false, sent_count: devices.filter((d) => d.status === "sent").length, devices, ...extra };
}

/** The browser's Notification API, granted: what was shown. */
function grantedNotifications() {
  const shown: { title: string; body: string }[] = [];
  class FakeNotification {
    static permission: NotificationPermission = "granted";
    static requestPermission = async () => "granted";
    onclose: (() => void) | null = null;
    constructor(title: string, options?: { body?: string }) { shown.push({ title, body: options?.body ?? "" }); }
    close(): void {}
  }
  vi.stubGlobal("Notification", FakeNotification);
  return shown;
}

describe("the result's words", () => {
  it("names each device and says what happened there", () => {
    expect(testDeviceName(device({ device_name: "Mac", platform: "desktop", current: true }))).toBe("Mac（この端末）");
    expect(testDeviceName(device({ platform: "android" }))).toBe("Android");
    expect(testDeviceStatus(device({ status: "sent" }))).toEqual({ text: "送信しました", tone: "ok" });
    expect(testDeviceStatus(device({ status: "failed", detail: "BadDeviceToken" })).text).toBe("送れませんでした（BadDeviceToken）");
    expect(testDeviceStatus(device({ status: "no_token" })).tone).toBe("problem");
    expect(testDeviceStatus(device({ status: "not_configured", push_provider: "fcm" })).text).toBe("このサーバでは Android のプッシュが無効です");
    expect(testDeviceStatus(device({ status: "in_app", platform: "desktop" })).tone).toBe("none");
    expect(testDeviceStatus(device({ status: "disabled", detail: "session_expired" })).text).toBe("ログインの期限切れ");
    expect(testDeviceStatus(device({ status: "disabled", detail: "logout" })).text).toBe("ログアウト済み");
  });

  it("says when this server has no push, when no phone can take one, and that DND was ignored", () => {
    const desk = device({ platform: "desktop", push_provider: "none", status: "in_app" });
    expect(testNotificationNotes(result([desk], { apns_configured: false, fcm_configured: false }))).toEqual([
      "このサーバはプッシュ通知が設定されていません（iPhone・Android のアプリには、開いている間だけ通知が出ます）",
      "プッシュ通知を受け取れる端末（iPhone・Android のアプリ）はありません",
    ]);
    expect(testNotificationNotes(result([device({})], { fcm_configured: false }))).toEqual(["Android のプッシュ（FCM）はこのサーバでは無効です"]);
    expect(testNotificationNotes(result([device({})], { apns_configured: false, dnd_active: true }))).toEqual([
      "iOS のプッシュ（APNs）はこのサーバでは無効です",
      "通知を一時停止中ですが、テスト通知は送りました",
    ]);
    // A logged-out phone does not count.
    expect(testNotificationNotes(result([device({ status: "disabled" })]))).toEqual(["プッシュ通知を受け取れる端末（iPhone・Android のアプリ）はありません"]);
  });

  it("points to where notifications are turned on", () => {
    expect(permissionHint("granted", true, "Macintosh")).toBeNull();
    expect(permissionHint("default", true, "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)")).toContain("システム設定");
    expect(permissionHint("default", true, "Mozilla/5.0 (Windows NT 10.0)")).toContain("Windows の「設定」");
    expect(permissionHint("default", false, "")).toContain("「通知を許可」");
    expect(permissionHint("denied", false, "")).toContain("サイト設定");
  });
});

describe("the settings' 「テスト通知を送る」", () => {
  function controllerWith(send: () => Promise<TestNotificationOut>) {
    const server = new FakeServer();
    const me = server.addUser("alice") as unknown as UserMe;
    const store = new Store();
    store.setMe(me);
    store.upsertUser(me);
    return { store, me, totpStatus: async () => ({ enabled: false, recovery_codes_left: 0 }), sendKey: "shift-enter", setSendKey: vi.fn(), workspaces: [], subscribe: () => () => {}, sendTestNotification: vi.fn(send) } as unknown as AppController;
  }

  it("sends and lists each device's result", async () => {
    grantedNotifications();
    const controller = controllerWith(async () =>
      result(
        [
          device({ device_name: "Mac", platform: "desktop", push_provider: "none", status: "in_app", current: true }),
          device({ device_name: "iPhone", status: "sent" }),
          device({ device_name: "Pixel", platform: "android", push_provider: "fcm", status: "not_configured" }),
        ],
        { fcm_configured: false },
      ),
    );
    render(<SettingsDialog controller={controller} onClose={() => {}} />);
    fireEvent.click(await screen.findByRole("button", { name: "テスト通知を送る" }));
    const list = await screen.findByRole("list", { name: "端末ごとの結果" });
    expect(within(list).getAllByRole("listitem").map((li) => li.textContent)).toEqual([
      "Mac（この端末）この端末に表示しました",
      "iPhone送信しました",
      "Pixelこのサーバでは Android のプッシュが無効です",
    ]);
    expect(screen.getByText("Android のプッシュ（FCM）はこのサーバでは無効です")).toBeTruthy();
    expect(controller.sendTestNotification).toHaveBeenCalledTimes(1);
  });

  it("says why it was refused (the rate limit)", async () => {
    grantedNotifications();
    const controller = controllerWith(async () => {
      throw new ApiError(429, "test_notification_rate_limited", "Too many test notifications");
    });
    render(<SettingsDialog controller={controller} onClose={() => {}} />);
    fireEvent.click(await screen.findByRole("button", { name: "テスト通知を送る" }));
    expect((await screen.findByRole("alert")).textContent).toBe("テスト通知は 10 分に 5 回までです。少し待ってからお試しください");
  });
});

describe("AppController", () => {
  async function setup() {
    const server = new FakeServer();
    const bob = server.addUser("bob");
    const store = new Store();
    const out = result([]);
    const api = { ...server.apiFor(bob.id), sendTestNotification: vi.fn(async () => out) };
    const controller = new AppController();
    const session = { serverUrl: "http://server", username: "bob", api, store, engine: null, me: null, leaving: false };
    (controller as unknown as { active: unknown }).active = session;
    const engine = (controller as unknown as { makeEngine(s: unknown): SyncEngine }).makeEngine(session);
    const deps = (engine as unknown as { deps: { onTestNotification?: (t: NotificationTest) => void } }).deps;
    return { controller, api, out, deps };
  }
  const echo: NotificationTest = { title: "Taylis", body: TEST_NOTIFICATION_BODY, device_id: null, sent_at: "2026-10-04T00:00:00Z" };

  it("shows this device's notification at once and does not show the echo again", async () => {
    const shown = grantedNotifications();
    const { controller, api, out, deps } = await setup();
    expect(await controller.sendTestNotification()).toBe(out);
    expect(api.sendTestNotification).toHaveBeenCalledTimes(1);
    expect(shown).toEqual([{ title: "Taylis", body: TEST_NOTIFICATION_BODY }]);
    deps.onTestNotification?.(echo);
    await Promise.resolve();
    expect(shown).toHaveLength(1);
  });

  it("shows a test asked for on another device", async () => {
    const shown = grantedNotifications();
    const { deps } = await setup();
    deps.onTestNotification?.(echo);
    await vi.waitFor(() => expect(shown).toEqual([{ title: "Taylis", body: TEST_NOTIFICATION_BODY }]));
  });
});

describe("SyncEngine", () => {
  it("passes notification.test on", async () => {
    const server = new FakeServer();
    const bob = server.addUser("bob");
    const tests: NotificationTest[] = [];
    const engine = new SyncEngine(
      { api: server.apiFor(bob.id), connect: server.connectorFor(bob.id), store: new Store(), getAccessToken: () => "t", sleep: async () => {}, random: () => 0.5, isActive: () => false, onTestNotification: (t) => tests.push(t) },
      { reconnectMinMs: 0 },
    );
    await engine.start();
    await engine.idle();
    server.socketsOf(bob.id)[0]!.deliver({ type: "event", id: 9001, event: "notification.test", ts: new Date().toISOString(), channel_id: null, seq: null, data: { title: "Taylis", body: "x", device_id: "d1", sent_at: "2026-10-04T00:00:00Z" } });
    await engine.idle();
    expect(tests.map((t) => t.device_id)).toEqual(["d1"]);
    engine.stop();
  });
});
