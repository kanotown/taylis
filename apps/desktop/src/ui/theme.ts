/**
 * M40 「表示」: 端末に合わせる / ライト / ダーク (and 「テーマの色」, below), kept per device (browser storage, not synced). The colours are the
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

/**
 * 「テーマの色」: the brand colours (sidebar, rail, accent), per device like the mode above and combined with it. The
 * colours are the `--p-*` blocks in styles.css (each with its light and dark values); `swatch` is the light sidebar and
 * accent, for the settings' preview (a test keeps them equal to the stylesheet's).
 */
export type Palette = "taylis" | "indigo" | "green" | "purple" | "rose" | "gray";

const PALETTE_KEY = "chikuwa.prefs.palette";
export const DEFAULT_PALETTE: Palette = "taylis";

export const PALETTES: Array<{ value: Palette; label: string; swatch: { sidebar: string; accent: string } }> = [
  { value: "taylis", label: "Taylis (栗)", swatch: { sidebar: "#3b2b21", accent: "#8f5530" } },
  { value: "indigo", label: "藍", swatch: { sidebar: "#2a2340", accent: "#5050c8" } },
  { value: "green", label: "緑", swatch: { sidebar: "#1e3a2f", accent: "#2e7550" } },
  { value: "purple", label: "紫", swatch: { sidebar: "#3a2150", accent: "#7c3fb0" } },
  { value: "rose", label: "紅", swatch: { sidebar: "#4a1e2c", accent: "#b02f50" } },
  { value: "gray", label: "グレー", swatch: { sidebar: "#2c2e33", accent: "#4f5b6b" } },
];

export function paletteLabel(palette: Palette): string {
  return PALETTES.find((p) => p.value === palette)?.label ?? PALETTES[0]!.label;
}

export function readPalette(): Palette {
  try {
    const value = localStorage.getItem(PALETTE_KEY);
    return PALETTES.find((p) => p.value === value)?.value ?? DEFAULT_PALETTE;
  } catch {
    return DEFAULT_PALETTE;
  }
}

/** Puts the palette on screen (<html data-palette>; the default has none). */
export function applyPalette(palette: Palette, root: HTMLElement = document.documentElement): void {
  if (palette === DEFAULT_PALETTE) delete root.dataset["palette"];
  else root.dataset["palette"] = palette;
}

const paletteListeners = new Set<() => void>();

export function writePalette(palette: Palette): void {
  try {
    if (palette === DEFAULT_PALETTE) localStorage.removeItem(PALETTE_KEY);
    else localStorage.setItem(PALETTE_KEY, palette);
  } catch {
    /* per-device convenience only: it still applies to this window */
  }
  applyPalette(palette);
  for (const listener of paletteListeners) listener();
}

export function usePalette(): Palette {
  return useSyncExternalStore(
    (listener) => {
      paletteListeners.add(listener);
      return () => paletteListeners.delete(listener);
    },
    readPalette,
  );
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
