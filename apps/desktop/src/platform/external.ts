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
