import { describe, expect, it, vi } from "vitest";

import { composerMaxHeight, followVisualViewport, tapClosesKeyboard } from "../src/platform/viewport";

/** A window with a visual viewport the test moves, like iOS Safari when the keyboard comes up. */
function fakeWindow(opts: { hover?: boolean } = {}) {
  const listeners: Record<string, () => void> = {};
  const viewport = {
    height: 800,
    scale: 1,
    offsetTop: 0,
    addEventListener: (type: string, fn: () => void) => { listeners[type] = fn; },
    removeEventListener: (type: string) => { delete listeners[type]; },
  };
  const style = new Map<string, string>();
  const win = {
    visualViewport: viewport,
    scrollY: 0,
    scrollTo: vi.fn(() => { win.scrollY = 0; viewport.offsetTop = 0; }),
    matchMedia: (query: string) => ({ matches: query === "(hover: none)" && !opts.hover }),
    document: {
      documentElement: { style: { setProperty: (k: string, v: string) => style.set(k, v) } },
      activeElement: null as unknown,
    },
  };
  return { win: win as unknown as Window, raw: win, viewport, listeners, style };
}

describe("followVisualViewport", () => {
  it("fits the app to what the keyboard leaves and undoes Safari's pan", () => {
    const { win, raw, viewport, listeners, style } = fakeWindow();
    const stop = followVisualViewport(win);
    expect(style.get("--app-height")).toBe("800px");

    // The keyboard comes up: Safari shrinks the visual viewport and pans the page to the input.
    viewport.height = 480;
    viewport.offsetTop = 320;
    raw.scrollY = 320;
    listeners.resize!();
    expect(style.get("--app-height")).toBe("480px");
    expect(raw.scrollTo).toHaveBeenCalledWith(0, 0);

    stop();
    expect(listeners.resize).toBeUndefined();
  });

  it("leaves the page alone while the reader has zoomed in", () => {
    const { win, viewport, listeners, style } = fakeWindow();
    followVisualViewport(win);
    viewport.scale = 2;
    viewport.height = 400;
    listeners.resize!();
    expect(style.get("--app-height")).toBe("800px");
  });
});

describe("tapClosesKeyboard", () => {
  const touch = (x: number, y: number) => ({ touches: [{ clientX: x, clientY: y }] });
  const end = (target: unknown = { closest: () => null }) => ({ target: target as EventTarget, preventDefault: vi.fn() });

  it("while typing on a touch screen, a tap on the list only closes the keyboard", () => {
    const blur = vi.fn();
    const phone = fakeWindow();
    phone.raw.document.activeElement = { tagName: "TEXTAREA", blur };
    const handlers = tapClosesKeyboard(phone.win);
    handlers.onTouchStartCapture(touch(100, 200));
    handlers.onTouchMoveCapture(touch(103, 204)); // a finger's wobble is still a tap
    const tap = end();
    handlers.onTouchEndCapture(tap);
    expect(blur).toHaveBeenCalledTimes(1);
    expect(tap.preventDefault).toHaveBeenCalled(); // the message is not focused (its actions stay closed)
  });

  it("leaves scrolls, buttons and links alone", () => {
    const blur = vi.fn();
    const phone = fakeWindow();
    phone.raw.document.activeElement = { tagName: "TEXTAREA", blur };
    const handlers = tapClosesKeyboard(phone.win);
    handlers.onTouchStartCapture(touch(100, 200));
    handlers.onTouchMoveCapture(touch(100, 260)); // a scroll
    handlers.onTouchEndCapture(end());
    handlers.onTouchStartCapture(touch(100, 200));
    const onButton = end({ closest: (selector: string) => (selector.includes("button") ? {} : null) });
    handlers.onTouchEndCapture(onButton);
    expect(onButton.preventDefault).not.toHaveBeenCalled();
    expect(blur).not.toHaveBeenCalled();
  });

  it("does nothing when not typing or with a mouse", () => {
    const blur = vi.fn();
    const mouse = fakeWindow({ hover: true });
    mouse.raw.document.activeElement = { tagName: "TEXTAREA", blur };
    const handlers = tapClosesKeyboard(mouse.win);
    handlers.onTouchStartCapture(touch(1, 1));
    handlers.onTouchEndCapture(end());
    const phone = fakeWindow();
    phone.raw.document.activeElement = { tagName: "DIV", blur };
    const idle = tapClosesKeyboard(phone.win);
    idle.onTouchStartCapture(touch(1, 1));
    idle.onTouchEndCapture(end());
    expect(blur).not.toHaveBeenCalled();
  });
});

describe("composerMaxHeight", () => {
  it("keeps the conversation in view on a phone", () => {
    const phone = fakeWindow();
    phone.viewport.height = 480; // the keyboard is up
    expect(composerMaxHeight(phone.win)).toBe(120);
    phone.viewport.height = 300; // at least four lines
    expect(composerMaxHeight(phone.win)).toBe(96);
    phone.viewport.height = 2000;
    expect(composerMaxHeight(phone.win)).toBe(280);
    expect(composerMaxHeight(fakeWindow({ hover: true }).win)).toBe(280);
  });
});
