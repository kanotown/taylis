import type { MouseEvent } from "react";

import { isTauri } from "./env";

/**
 * A click on an external (http/https) link. A browser opens `target="_blank"` links by itself; the
 * Tauri webview ignores them, so there the system browser opens the URL through tauri-plugin-opener
 * (its capability allows http and https only).
 */
export function openExternalLink(event: MouseEvent<HTMLElement>, url: string): void {
  if (!isTauri() || event.defaultPrevented) return;
  event.preventDefault();
  void import("@tauri-apps/plugin-opener")
    .then(({ openUrl }) => openUrl(url))
    .catch((err: unknown) => console.error("could not open the link", err));
}

/** Open a URL in the system browser from the Tauri app (Google sign-in's start page, docs/SSO.md §6). */
export async function openInBrowser(url: string): Promise<void> {
  const { openUrl } = await import("@tauri-apps/plugin-opener");
  await openUrl(url);
}

/**
 * M117 (docs/CALLS.md §7): a tab opened during the click itself, for a URL known only after a request. A browser blocks a
 * window opened after an await; the Tauri app needs none (the system browser opens it). Null when blocked or not needed.
 */
export function reserveTab(): Window | null {
  if (isTauri()) return null;
  try {
    return window.open("", "_blank");
  } catch {
    return null;
  }
}

/**
 * A meeting room (M117) outside the app: the system browser from the Tauri app (camera and microphone stay out of the
 * webview), a new tab on the web: the reserved one when there is one, else a fresh one.
 */
export function openOutside(url: string, tab: Window | null = null): void {
  if (isTauri()) {
    void openInBrowser(url).catch((err: unknown) => console.error("could not open the link", err));
    return;
  }
  if (tab && !tab.closed) {
    tab.opener = null;
    tab.location.href = url;
    return;
  }
  window.open(url, "_blank", "noopener,noreferrer");
}
