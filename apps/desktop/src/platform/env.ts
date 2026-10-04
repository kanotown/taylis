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

/** macOS window buttons end at x = 76 (trafficLightPosition x = 16); reserve 8 px after them. */
export const TRAFFIC_LIGHTS_INSET = 84;

/** The same bundle opened in a browser (M12j): served by Caddy next to the API, same origin, cookie session. */
export function isWeb(): boolean {
  return typeof window !== "undefined" && !isTauri();
}
