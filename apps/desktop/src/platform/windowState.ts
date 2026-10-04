/**
 * M93: whether the macOS window buttons (traffic lights) are on screen, so the rail and the header reserve their space
 * only then. In full screen (the green button) macOS hides them, and the reserved 84 px were empty. Zoom (double-click
 * on the title bar, Option-click on the green button) keeps them, and `isFullscreen()` stays false there, so the inset
 * stays. Windows (our own title bar, WindowControls) and Linux (the system one) have no traffic lights: no inset at all.
 */
import { useEffect, useState } from "react";

import { overlayTitleBar } from "./env";

/** The part of Tauri's window API this needs (a fake in tests). */
export interface WatchedWindow {
  isFullscreen(): Promise<boolean>;
  onResized(handler: () => void): Promise<() => void>;
}

/** The traffic lights take space: the overlay title bar, and not in full screen. */
export function reservesTrafficLights(overlay: boolean, fullscreen: boolean): boolean {
  return overlay && !fullscreen;
}

/** macOS animates into and out of full screen; ask again once the animation is over. */
export const SETTLE_MS = 700;

let fullscreen = false;
let watching: Promise<void> | null = null;
let stop: (() => void) | null = null;
const listeners = new Set<() => void>();

function set(value: boolean): void {
  if (value === fullscreen) return;
  fullscreen = value;
  for (const listener of listeners) listener();
}

/**
 * Follow a window's full-screen state: asked now and after every resize (again when the animation settles). Returns
 * once the first answer is in. Tests pass a fake window; the app passes nothing and gets Tauri's current window.
 */
export function watchFullscreen(source?: () => Promise<WatchedWindow>): Promise<void> {
  if (watching) return watching;
  watching = (async () => {
    try {
      const win = source ? await source() : await currentWindow();
      const ask = () => {
        win.isFullscreen().then(set, () => {
          /* the window is going away */
        });
      };
      let timer: ReturnType<typeof setTimeout> | null = null;
      const unlisten = await win.onResized(() => {
        ask();
        if (timer) clearTimeout(timer);
        timer = setTimeout(ask, SETTLE_MS);
      });
      stop = () => {
        unlisten();
        if (timer) clearTimeout(timer);
      };
      set(await win.isFullscreen());
    } catch (err) {
      console.warn("could not follow the window's full-screen state", err);
    }
  })();
  return watching;
}

async function currentWindow(): Promise<WatchedWindow> {
  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  const win = getCurrentWindow();
  return { isFullscreen: () => win.isFullscreen(), onResized: (handler) => win.onResized(() => handler()) };
}

/** Tests: forget the watched window and its state. */
export function resetWindowState(): void {
  stop?.();
  stop = null;
  watching = null;
  fullscreen = false;
}

export function isFullscreen(): boolean {
  return fullscreen;
}

/**
 * Whether the layout must leave room for the macOS window buttons now (the rail's top padding and width, the header's
 * left padding). Follows full screen in and out.
 */
export function useReservesTrafficLights(): boolean {
  const overlay = overlayTitleBar();
  const [full, setFull] = useState(fullscreen);
  useEffect(() => {
    if (!overlay) return;
    const listener = () => setFull(fullscreen);
    listeners.add(listener);
    listener();
    void watchFullscreen();
    return () => {
      listeners.delete(listener);
    };
  }, [overlay]);
  return reservesTrafficLights(overlay, full);
}
