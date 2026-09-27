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
