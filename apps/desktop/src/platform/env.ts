export function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

/**
 * The desktop app on macOS draws under the title bar (tauri.conf.json titleBarStyle "Overlay"): the top bar holds
 * the window buttons' space and moves the window (data-tauri-drag-region). Windows keeps its own title bar.
 */
export function overlayTitleBar(): boolean {
  return isTauri() && typeof navigator !== "undefined" && /Mac/.test(navigator.platform);
}

/** macOS window buttons end at x = 76 (trafficLightPosition x = 16); reserve 8 px after them. */
export const TRAFFIC_LIGHTS_INSET = 84;

/** The same bundle opened in a browser (M12j): served by Caddy next to the API, same origin, cookie session. */
export function isWeb(): boolean {
  return typeof window !== "undefined" && !isTauri();
}
