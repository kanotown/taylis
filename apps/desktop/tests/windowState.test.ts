/** M93: the macOS window buttons' inset follows full screen (hidden there), not zoom (they stay). */
import { afterEach, describe, expect, it, vi } from "vitest";

import { isFullscreen, reservesTrafficLights, resetWindowState, SETTLE_MS, watchFullscreen, type WatchedWindow } from "../src/platform/windowState";

afterEach(() => {
  resetWindowState();
  vi.useRealTimers();
});

/** A window whose full-screen flag the test flips, firing a resize like Tauri does. */
function fakeWindow(initial = false) {
  let full = initial;
  let handler: (() => void) | null = null;
  const unlisten = vi.fn();
  const win: WatchedWindow = {
    isFullscreen: vi.fn(async () => full),
    onResized: vi.fn(async (h: () => void) => {
      handler = h;
      return unlisten;
    }),
  };
  return {
    win,
    unlisten,
    /** Full screen (the green button) or not; `resize` = the event arrives. */
    set(value: boolean, resize = true) {
      full = value;
      if (resize) handler?.();
    },
    resize() {
      handler?.();
    },
  };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("the traffic-light inset", () => {
  it("is reserved only for the overlay title bar outside full screen", () => {
    expect(reservesTrafficLights(true, false)).toBe(true); // macOS, windowed or zoomed
    expect(reservesTrafficLights(true, true)).toBe(false); // macOS full screen: the buttons are hidden
    expect(reservesTrafficLights(false, false)).toBe(false); // Windows / Linux / the browser: native title bar
    expect(reservesTrafficLights(false, true)).toBe(false);
  });

  it("follows the window into and out of full screen, asking again when the animation settles", async () => {
    vi.useFakeTimers();
    const fake = fakeWindow(false);
    await watchFullscreen(async () => fake.win);
    expect(isFullscreen()).toBe(false);
    fake.set(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(isFullscreen()).toBe(true);
    // The flag flips late (mid-animation): the settled ask picks it up.
    fake.set(false, true);
    await vi.advanceTimersByTimeAsync(0);
    expect(isFullscreen()).toBe(false);
    fake.set(true, false); // no resize event yet
    fake.resize();
    await vi.advanceTimersByTimeAsync(SETTLE_MS);
    expect(isFullscreen()).toBe(true);
  });

  it("stays windowed while zoomed (resizes without full screen)", async () => {
    const fake = fakeWindow(false);
    await watchFullscreen(async () => fake.win);
    fake.resize(); // zoom: the window grows, isFullscreen() stays false
    await flush();
    expect(isFullscreen()).toBe(false);
  });

  it("starts in full screen when the window already is, and watches only once", async () => {
    const fake = fakeWindow(true);
    await watchFullscreen(async () => fake.win);
    expect(isFullscreen()).toBe(true);
    await watchFullscreen(async () => fakeWindow(false).win);
    expect(fake.win.onResized).toHaveBeenCalledTimes(1);
    resetWindowState();
    expect(fake.unlisten).toHaveBeenCalled();
    expect(isFullscreen()).toBe(false);
  });

  it("keeps the inset when the window API is not there", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await watchFullscreen(async () => {
      throw new Error("no window");
    });
    expect(isFullscreen()).toBe(false);
    expect(warn).toHaveBeenCalled();
  });
});
