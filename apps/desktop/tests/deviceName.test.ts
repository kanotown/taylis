// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

// The device's name in 「ログイン中の端末」: never navigator.platform's "MacIntel" (frozen on Apple silicon Macs too).
const state = vi.hoisted(() => ({ computerName: "Toru's MacBook Air" as string | null, fail: false }));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: async (command: string) => {
    if (command !== "computer_name") throw new Error(`unexpected ${command}`);
    if (state.fail) throw new Error("command not found");
    return state.computerName;
  },
}));

import { browserDeviceName, desktopDeviceName, resolveDeviceName } from "../src/platform/deviceName";

const MAC_SAFARI = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15";
const MAC_CHROME = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";
const WIN_EDGE = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36 Edg/140.0.0.0";
const WIN_FIREFOX = "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:143.0) Gecko/20100101 Firefox/143.0";
const LINUX_CHROME = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";
const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";
const ANDROID = "Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36";
const MAC_WEBVIEW = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)";

afterEach(() => {
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
  state.fail = false;
  state.computerName = "Toru's MacBook Air";
});

describe("device names", () => {
  it("names a browser by its OS and browser", () => {
    expect(browserDeviceName(MAC_SAFARI)).toBe("Mac (Safari)");
    expect(browserDeviceName(MAC_CHROME)).toBe("Mac (Chrome)");
    expect(browserDeviceName(WIN_EDGE)).toBe("Windows (Edge)");
    expect(browserDeviceName(WIN_FIREFOX)).toBe("Windows (Firefox)");
    expect(browserDeviceName(LINUX_CHROME)).toBe("Linux (Chrome)");
    expect(browserDeviceName(IPHONE)).toBe("iPhone (Safari)");
    expect(browserDeviceName(ANDROID)).toBe("Android (Chrome)");
    expect(browserDeviceName("")).toBe("ブラウザ");
  });

  it("names the desktop app by its OS and the computer's name, clipped to the server's 80", () => {
    expect(desktopDeviceName(MAC_WEBVIEW, "Toru's MacBook Air")).toBe("Mac (Toru's MacBook Air)");
    expect(desktopDeviceName(WIN_EDGE, "DESKTOP-1234")).toBe("Windows (DESKTOP-1234)");
    expect(desktopDeviceName(MAC_WEBVIEW, null)).toBe("Mac");
    expect(desktopDeviceName(MAC_WEBVIEW, "  ")).toBe("Mac");
    expect(desktopDeviceName("", null)).toBe("デスクトップ");
    expect(desktopDeviceName(MAC_WEBVIEW, "x".repeat(200))).toHaveLength(80);
  });

  it("asks the Rust side in the desktop app, and does without the name when it cannot", async () => {
    expect(await resolveDeviceName(MAC_SAFARI)).toBe("Mac (Safari)"); // a browser
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
    expect(await resolveDeviceName(MAC_WEBVIEW)).toBe("Mac (Toru's MacBook Air)");
    state.fail = true;
    vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(await resolveDeviceName(MAC_WEBVIEW)).toBe("Mac");
  });
});
