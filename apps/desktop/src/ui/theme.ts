/**
 * M40 「表示」: 端末に合わせる / ライト / ダーク, kept per device (browser storage, not synced). The colours are the
 * tokens in styles.css; "system" leaves them to prefers-color-scheme, the others pin them with <html data-theme>.
 */
import { useSyncExternalStore } from "react";

export type Theme = "system" | "light" | "dark";

const THEME_KEY = "chikuwa.prefs.theme";

export const THEME_OPTIONS: Array<[Theme, string]> = [
  ["system", "端末に合わせる"],
  ["light", "ライト"],
  ["dark", "ダーク"],
];

export function themeLabel(theme: Theme): string {
  return THEME_OPTIONS.find(([value]) => value === theme)?.[1] ?? "端末に合わせる";
}

export function readTheme(): Theme {
  try {
    const value = localStorage.getItem(THEME_KEY);
    return value === "light" || value === "dark" ? value : "system";
  } catch {
    return "system";
  }
}

/** Puts the choice on screen (the <html> attribute the stylesheet reads). */
export function applyTheme(theme: Theme, root: HTMLElement = document.documentElement): void {
  if (theme === "system") delete root.dataset["theme"];
  else root.dataset["theme"] = theme;
}

const listeners = new Set<() => void>();

export function writeTheme(theme: Theme): void {
  try {
    if (theme === "system") localStorage.removeItem(THEME_KEY);
    else localStorage.setItem(THEME_KEY, theme);
  } catch {
    /* per-device convenience only: it still applies to this window */
  }
  applyTheme(theme);
  for (const listener of listeners) listener();
}

/** The choice as the settings show it (the 「表示」 row's value follows a change at once). */
export function useTheme(): Theme {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    readTheme,
  );
}
