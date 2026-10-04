// @vitest-environment jsdom
/** Windows: no system title bar; our top row carries the window buttons (tauri.windows.conf.json "decorations": false). */
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { customTitleBar, isWindows, overlayTitleBar, titleBarKind } from "../src/platform/env";
import { ScreenTitleStrip, WindowControls, type ControlledWindow } from "../src/ui/WindowControls";

const WINDOWS_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0";
const MAC_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)";
const LINUX_UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/605.1.15 (KHTML, like Gecko)";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
});

function platform(userAgent: string, navPlatform: string, tauri: boolean) {
  vi.stubGlobal("navigator", { ...navigator, userAgent, platform: navPlatform });
  if (tauri) (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
}

/** A window whose maximised flag the test flips, firing a resize like Tauri does. */
function fakeWindow(initial = false) {
  let maximized = initial;
  let handler: (() => void) | null = null;
  const unlisten = vi.fn();
  const win: ControlledWindow = {
    minimize: vi.fn(async () => {}),
    toggleMaximize: vi.fn(async () => {
      maximized = !maximized;
      handler?.();
    }),
    close: vi.fn(async () => {}),
    isMaximized: vi.fn(async () => maximized),
    onResized: vi.fn(async (h: () => void) => {
      handler = h;
      return unlisten;
    }),
  };
  return {
    win,
    unlisten,
    /** Maximised some other way (double-click on the row, Win+Up, a snap). */
    set(value: boolean) {
      maximized = value;
      handler?.();
    },
  };
}

const settle = () => act(async () => {
  await new Promise((resolve) => setTimeout(resolve, 0));
});

describe("the title bar per platform", () => {
  it("is ours on the Windows desktop app only", () => {
    platform(WINDOWS_UA, "Win32", true);
    expect(isWindows()).toBe(true);
    expect(customTitleBar()).toBe(true);
    expect(overlayTitleBar()).toBe(false);
    expect(titleBarKind()).toBe("custom");
  });

  it("stays the overlay on macOS", () => {
    platform(MAC_UA, "MacIntel", true);
    expect(customTitleBar()).toBe(false);
    expect(titleBarKind()).toBe("overlay");
  });

  it("is the system's on Linux and in a browser (even on Windows)", () => {
    platform(LINUX_UA, "Linux x86_64", true);
    expect(titleBarKind()).toBe("native");
    vi.unstubAllGlobals();
    delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
    platform(WINDOWS_UA, "Win32", false);
    expect(isWindows()).toBe(true);
    expect(customTitleBar()).toBe(false);
    expect(titleBarKind()).toBe("native");
  });
});

describe("the window buttons", () => {
  it("minimise, maximise and close the window", async () => {
    const fake = fakeWindow();
    render(<WindowControls source={async () => fake.win} />);
    await settle();
    fireEvent.click(screen.getByRole("button", { name: "最小化" }));
    fireEvent.click(screen.getByRole("button", { name: "最大化" }));
    await settle();
    fireEvent.click(screen.getByRole("button", { name: "閉じる" }));
    await settle();
    expect(fake.win.minimize).toHaveBeenCalledTimes(1);
    expect(fake.win.toggleMaximize).toHaveBeenCalledTimes(1);
    expect(fake.win.close).toHaveBeenCalledTimes(1);
  });

  it("swap maximise for restore while maximised, however it got there", async () => {
    const fake = fakeWindow(true);
    render(<WindowControls source={async () => fake.win} />);
    await settle();
    expect(screen.getByRole("button", { name: "元に戻す" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "最大化" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "元に戻す" }));
    await settle();
    expect(screen.getByRole("button", { name: "最大化" })).toBeTruthy();

    fake.set(true); // double-click on the row, Win+Up or a snap
    await settle();
    expect(screen.getByRole("button", { name: "元に戻す" })).toBeTruthy();
  });

  it("stop listening when they go away", async () => {
    const fake = fakeWindow();
    const { unmount } = render(<WindowControls source={async () => fake.win} />);
    await settle();
    expect(fake.win.onResized).toHaveBeenCalledTimes(1);
    unmount();
    expect(fake.unlisten).toHaveBeenCalledTimes(1);
  });

  it("make close red on hover, Windows style", () => {
    render(<WindowControls source={async () => fakeWindow().win} />);
    expect(screen.getByRole("button", { name: "閉じる" }).className).toContain("hover:bg-[#c42b1c]");
    expect(screen.getByRole("button", { name: "最小化" }).className).not.toContain("#c42b1c");
  });
});

describe("the strip on screens without the top row", () => {
  it("is a drag strip with the window buttons on Windows, clear of the rail", async () => {
    const fake = fakeWindow();
    render(<ScreenTitleStrip kind="custom" leftInset={68} source={async () => fake.win} />);
    await settle();
    const strip = screen.getByTestId("title-strip");
    expect(strip.hasAttribute("data-tauri-drag-region")).toBe(true);
    expect(strip.style.left).toBe("68px");
    // The buttons are buttons, not drag regions: Tauri only drags on the strip itself.
    for (const name of ["最小化", "最大化", "閉じる"]) expect(screen.getByRole("button", { name }).hasAttribute("data-tauri-drag-region")).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "閉じる" }));
    await settle();
    expect(fake.win.close).toHaveBeenCalledTimes(1);
  });

  it("is a bare drag strip on macOS, as before", () => {
    const { container } = render(<ScreenTitleStrip kind="overlay" />);
    const strip = container.firstElementChild as HTMLElement;
    expect(strip.hasAttribute("data-tauri-drag-region")).toBe(true);
    expect(strip.className).toBe("fixed inset-x-0 top-0 z-50 h-8");
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("is nothing where the system draws the title bar", () => {
    const { container } = render(<ScreenTitleStrip kind="native" />);
    expect(container.firstChild).toBeNull();
  });
});
