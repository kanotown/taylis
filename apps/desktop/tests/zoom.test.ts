// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

const setZoom = vi.fn(async (_zoom: number) => {});
vi.mock("@tauri-apps/api/webview", () => ({ getCurrentWebview: () => ({ setZoom }) }));

import { applyZoom, readZoom, setUpZoom, stepZoom, writeZoom, zoomKey, zoomLabel, ZOOM_STEPS } from "../src/platform/zoom";

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

afterEach(() => {
  localStorage.clear();
  delete (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  applyZoom(1);
  setZoom.mockClear();
});

const key = (init: KeyboardEventInit) => new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });

describe("「文字の大きさ」 (desktop app)", () => {
  it("steps through 80 %–200 % and stays at the ends; 0 is back to 100 %", () => {
    expect(ZOOM_STEPS).toEqual([0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2]);
    expect(stepZoom(1, 1)).toBe(1.1);
    expect(stepZoom(1.1, 1)).toBe(1.25);
    expect(stepZoom(1, -1)).toBe(0.9);
    expect(stepZoom(0.8, -1)).toBe(0.8);
    expect(stepZoom(2, 1)).toBe(2);
    expect(stepZoom(1.75, 0)).toBe(1);
    expect(zoomLabel(1.25)).toBe("125%");
  });

  it("knows the keys: ⌘ on a Mac, Ctrl elsewhere; +, =, ; and the keypad's +, - and 0", () => {
    const mac = (k: string, extra: Partial<KeyboardEvent> = {}) => zoomKey({ key: k, code: "", metaKey: true, ctrlKey: false, altKey: false, ...extra }, true);
    expect(mac("+")).toBe(1);
    expect(mac("=")).toBe(1);
    expect(mac(";")).toBe(1); // JIS: the 「+」 key without Shift
    expect(mac("-")).toBe(-1);
    expect(mac("0")).toBe(0);
    expect(mac("Add", { code: "NumpadAdd" } as Partial<KeyboardEvent>)).toBe(1);
    expect(mac("k")).toBeNull();
    expect(mac("-", { altKey: true })).toBeNull();
    expect(zoomKey({ key: "-", code: "Minus", metaKey: false, ctrlKey: true, altKey: false }, true)).toBeNull(); // Ctrl on a Mac
    expect(zoomKey({ key: "-", code: "Minus", metaKey: false, ctrlKey: true, altKey: false }, false)).toBe(-1); // Windows
    expect(zoomKey({ key: "0", code: "Digit0", metaKey: true, ctrlKey: false, altKey: false }, false)).toBeNull();
  });

  it("keeps the level on this device and puts it on the webview, with --ui-zoom for the window buttons' space", async () => {
    (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};
    expect(readZoom()).toBe(1);
    writeZoom(1.25);
    await flush();
    expect(localStorage.getItem("chikuwa.prefs.zoom")).toBe("1.25");
    expect(readZoom()).toBe(1.25);
    expect(setZoom).toHaveBeenLastCalledWith(1.25);
    expect(document.documentElement.style.getPropertyValue("--ui-zoom")).toBe("1.25");
    writeZoom(1);
    expect(localStorage.getItem("chikuwa.prefs.zoom")).toBeNull();
    expect(document.documentElement.style.getPropertyValue("--ui-zoom")).toBe("");
    localStorage.setItem("chikuwa.prefs.zoom", "3");
    expect(readZoom()).toBe(1);
  });

  it("the desktop app: the saved level at startup and the keys from anywhere; a browser is left alone", async () => {
    (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};
    localStorage.setItem("chikuwa.prefs.zoom", "1.1");
    const ctrl = !/Mac/.test(navigator.platform);
    const mod = ctrl ? { ctrlKey: true } : { metaKey: true };
    const stop = setUpZoom(true);
    await flush();
    expect(setZoom).toHaveBeenLastCalledWith(1.1);
    const plus = key({ key: "+", ...mod });
    document.body.dispatchEvent(plus);
    expect(plus.defaultPrevented).toBe(true);
    expect(readZoom()).toBe(1.25);
    document.body.dispatchEvent(key({ key: "0", ...mod }));
    expect(readZoom()).toBe(1);
    stop();
    await flush();
    setZoom.mockClear();
    const stopWeb = setUpZoom(false);
    const minus = key({ key: "-", ...mod });
    document.body.dispatchEvent(minus);
    expect(minus.defaultPrevented).toBe(false);
    expect(readZoom()).toBe(1);
    stopWeb();
    await flush();
    expect(setZoom).not.toHaveBeenCalled();
  });
});
