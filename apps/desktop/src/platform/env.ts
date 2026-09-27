export function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

/** The same bundle opened in a browser (M12j): served by Caddy next to the API, same origin, cookie session. */
export function isWeb(): boolean {
  return typeof window !== "undefined" && !isTauri();
}
