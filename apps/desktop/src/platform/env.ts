export function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

/**
 * The desktop app on macOS draws under the title bar (tauri.conf.json titleBarStyle "Overlay"): the top bar holds
 * the window buttons' space and moves the window (data-tauri-drag-region). Windows has no system title bar at all
 * (customTitleBar); Linux keeps its own.
 */
export function overlayTitleBar(): boolean {
  return isTauri() && typeof navigator !== "undefined" && /Mac/.test(navigator.platform);
}

/** The WebView runs on Windows (WebView2's user agent says "Windows NT"); true in a browser on Windows too. */
export function isWindows(): boolean {
  return typeof navigator !== "undefined" && /Windows/.test(navigator.userAgent);
}

/**
 * The desktop app on Windows has no system title bar (tauri.windows.conf.json "decorations": false), as in Slack: our
 * top row moves the window, and draws its own minimise / maximise / close buttons (WindowControls).
 */
export function customTitleBar(): boolean {
  return isTauri() && isWindows();
}

/** How the window's title bar is drawn: under our top bar (macOS), by us (Windows), or by the system (Linux, Web). */
export type TitleBarKind = "overlay" | "custom" | "native";

export function titleBarKind(): TitleBarKind {
  if (overlayTitleBar()) return "overlay";
  if (customTitleBar()) return "custom";
  return "native";
}

/** macOS window buttons end at x = 76 (trafficLightPosition x = 16); reserve 8 px after them (points: the users divide
 * it by the zoom, platform/zoom.ts). */
export const TRAFFIC_LIGHTS_INSET = 84;

/** The workspace rail's width (its class says w-[68px]), on every platform: the macOS window buttons sit in the title
 * row above it (Slack), so it no longer widens to hold them. */
export const RAIL_WIDTH = 68;

/**
 * The title row's height on macOS: 40 px, never under 40 points. The window buttons are centred in the top 40 points
 * (tauri.conf.json trafficLightPosition y = 20) whatever the zoom, so below 100 % the row keeps 40 points to hold them;
 * above, the row grows with the zoom and they stay in its top 40 points. The rail's top cell has the same height.
 */
export const TITLE_ROW_HEIGHT = "max(40px, calc(40px / var(--ui-zoom, 1)))";

/**
 * With the rail on screen, the left padding of the title row's first cell: the window buttons start over the rail and
 * end 84 points from the window's edge; the cell starts after the rail (68 px, which scales with the zoom), so it keeps
 * what is left of the 84 points, and at least its usual 8 px.
 */
export const TITLE_ROW_INSET_AFTER_RAIL = `max(8px, calc(${TRAFFIC_LIGHTS_INSET}px / var(--ui-zoom, 1) - ${RAIL_WIDTH}px))`;

/** The same bundle opened in a browser (M12j): served by Caddy next to the API, same origin, cookie session. */
export function isWeb(): boolean {
  return typeof window !== "undefined" && !isTauri();
}
