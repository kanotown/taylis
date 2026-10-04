/**
 * 「文字の大きさ」 (desktop app only): ⌘ / Ctrl + 「+」 「-」 「0」 and the settings row zoom the whole window in fixed steps,
 * kept per device (browser storage) and put back at startup.
 *
 * Through Tauri's `Webview.setZoom` (WKWebView's page zoom on macOS, WebView2's zoom factor on Windows), with our own
 * key handler, rather than the window option `zoomHotkeysEnabled`: that one gives WebView2's own zoom on Windows and an
 * injected 20 %-step polyfill on macOS, neither of which remembers the level after a restart or lets the settings show
 * and set it. In a browser nothing here runs: the browser's own zoom keys and menu do this and it remembers per site.
 *
 * The macOS window buttons are drawn by the system at a fixed size; the space kept for them divides by the zoom
 * (`--ui-zoom`, WorkspaceRail and MainScreen) so they stay clear of our buttons at any level.
 */
import { useSyncExternalStore } from "react";

import { isTauri } from "./env";

export const ZOOM_STEPS = [0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2] as const;
export const DEFAULT_ZOOM = 1;
const ZOOM_KEY = "chikuwa.prefs.zoom";

export function zoomLabel(zoom: number): string {
  return `${Math.round(zoom * 100)}%`;
}

export function readZoom(): number {
  try {
    const value = Number(localStorage.getItem(ZOOM_KEY));
    return (ZOOM_STEPS as readonly number[]).includes(value) ? value : DEFAULT_ZOOM;
  } catch {
    return DEFAULT_ZOOM;
  }
}

/** The next step up (1) or down (-1) from `zoom`, staying at the ends; 0 is back to 100 %. */
export function stepZoom(zoom: number, direction: -1 | 0 | 1): number {
  if (direction === 0) return DEFAULT_ZOOM;
  if (direction === 1) return ZOOM_STEPS.find((step) => step > zoom + 1e-9) ?? ZOOM_STEPS[ZOOM_STEPS.length - 1]!;
  return [...ZOOM_STEPS].reverse().find((step) => step < zoom - 1e-9) ?? ZOOM_STEPS[0];
}

const isMac = () => typeof navigator !== "undefined" && /Mac/.test(navigator.platform);

/**
 * Which zoom key `event` is: ⌘ (macOS) / Ctrl (Windows, Linux) with 「+」 (also 「=」, the same key without Shift on a US
 * keyboard, and 「;」, the same key without Shift on a JIS one) or the keypad's +, 「-」 or the keypad's -, 「0」 or the keypad's 0.
 * Null for anything else (Option / Alt held too, or the other modifier).
 */
export function zoomKey(event: Pick<KeyboardEvent, "key" | "code" | "metaKey" | "ctrlKey" | "altKey">, mac: boolean = isMac()): -1 | 0 | 1 | null {
  if (event.altKey || (mac ? !event.metaKey || event.ctrlKey : !event.ctrlKey || event.metaKey)) return null;
  if (event.key === "+" || event.key === "=" || event.key === ";" || event.code === "NumpadAdd") return 1;
  if (event.key === "-" || event.key === "_" || event.code === "NumpadSubtract") return -1;
  if (event.key === "0" || event.code === "Numpad0") return 0;
  return null;
}

let current = DEFAULT_ZOOM;
const listeners = new Set<() => void>();

/** Puts `zoom` on screen: the webview's zoom, and `--ui-zoom` for the space kept for the macOS window buttons. */
export function applyZoom(zoom: number, root: HTMLElement = document.documentElement): void {
  current = zoom;
  if (zoom === DEFAULT_ZOOM) root.style.removeProperty("--ui-zoom");
  else root.style.setProperty("--ui-zoom", String(zoom));
  if (!isTauri()) return;
  void import("@tauri-apps/api/webview")
    .then(({ getCurrentWebview }) => getCurrentWebview().setZoom(zoom))
    .catch((err: unknown) => console.warn("could not set the window's zoom", err));
}

export function writeZoom(zoom: number): void {
  try {
    if (zoom === DEFAULT_ZOOM) localStorage.removeItem(ZOOM_KEY);
    else localStorage.setItem(ZOOM_KEY, String(zoom));
  } catch {
    /* per-device convenience only: it still applies to this window */
  }
  applyZoom(zoom);
  for (const listener of listeners) listener();
}

/** The level as the settings show it (follows the keys at once). */
export function useZoom(): number {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => current,
  );
}

/**
 * The desktop app: the saved level now, and the zoom keys from anywhere in the window (capture phase, before a text
 * area or a dialog sees them). Does nothing in a browser. Returns the way to stop listening (tests).
 */
export function setUpZoom(desktop: boolean = isTauri()): () => void {
  if (!desktop) return () => {};
  applyZoom(readZoom());
  const onKey = (event: KeyboardEvent) => {
    const direction = zoomKey(event);
    if (direction === null) return;
    event.preventDefault();
    const next = stepZoom(current, direction);
    if (next !== current) writeZoom(next);
  };
  window.addEventListener("keydown", onKey, true);
  return () => window.removeEventListener("keydown", onKey, true);
}
