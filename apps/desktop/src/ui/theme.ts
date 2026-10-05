/**
 * M40 「表示」: 端末に合わせる / ライト / ダーク (and 「テーマの色」, below), kept per device (browser storage, not synced). The colours are the
 * tokens in styles.css; "system" leaves them to prefers-color-scheme, the others pin them with <html data-theme>.
 */
import { useSyncExternalStore } from "react";
import { t, labelled } from "../i18n";

export type Theme = "system" | "light" | "dark";

const THEME_KEY = "chikuwa.prefs.theme";

export const THEME_OPTIONS: Array<[Theme, string]> = [
  labelled("system", "theme.system"),
  labelled("light", "theme.light"),
  labelled("dark", "theme.dark"),
];

export function themeLabel(theme: Theme): string {
  return THEME_OPTIONS.find(([value]) => value === theme)?.[1] ?? t("theme.system");
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
  { value: "taylis", get label() { return t("theme.palette.taylis"); }, swatch: { sidebar: "#3b2b21", accent: "#8f5530" } },
  { value: "indigo", get label() { return t("theme.palette.indigo"); }, swatch: { sidebar: "#2a2340", accent: "#5050c8" } },
  { value: "green", get label() { return t("theme.palette.green"); }, swatch: { sidebar: "#1e3a2f", accent: "#2e7550" } },
  { value: "purple", get label() { return t("theme.palette.purple"); }, swatch: { sidebar: "#3a2150", accent: "#7c3fb0" } },
  { value: "rose", get label() { return t("theme.palette.rose"); }, swatch: { sidebar: "#4a1e2c", accent: "#b02f50" } },
  { value: "gray", get label() { return t("theme.palette.gray"); }, swatch: { sidebar: "#2c2e33", accent: "#4f5b6b" } },
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

/**
 * 「サイドバー」: 濃い色 (the palette's dark sidebar, the default) or 明るい色 (near-white tinted by the palette's accent,
 * dark text from its sidebar colour, the active row in the accent's fill), per device and combined with the palette.
 * Light mode only: the stylesheet takes <html data-sidebar="light"> only where the light tokens are in force, so in
 * dark mode the sidebar stays dark whatever the choice.
 */
export type SidebarTone = "dark" | "light";

const SIDEBAR_KEY = "chikuwa.prefs.sidebar";

export const SIDEBAR_TONES: Array<[SidebarTone, string]> = [
  labelled("dark", "theme.sidebar.dark"),
  labelled("light", "theme.sidebar.light"),
];

export function readSidebarTone(): SidebarTone {
  try {
    return localStorage.getItem(SIDEBAR_KEY) === "light" ? "light" : "dark";
  } catch {
    return "dark";
  }
}

/** Puts the choice on screen (<html data-sidebar="light">; the default has none). */
export function applySidebarTone(tone: SidebarTone, root: HTMLElement = document.documentElement): void {
  if (tone === "light") root.dataset["sidebar"] = "light";
  else delete root.dataset["sidebar"];
}

const sidebarListeners = new Set<() => void>();

export function writeSidebarTone(tone: SidebarTone): void {
  try {
    if (tone === "light") localStorage.setItem(SIDEBAR_KEY, "light");
    else localStorage.removeItem(SIDEBAR_KEY);
  } catch {
    /* per-device convenience only: it still applies to this window */
  }
  applySidebarTone(tone);
  for (const listener of sidebarListeners) listener();
}

export function useSidebarTone(): SidebarTone {
  return useSyncExternalStore(
    (listener) => {
      sidebarListeners.add(listener);
      return () => sidebarListeners.delete(listener);
    },
    readSidebarTone,
  );
}

/**
 * 「フォント」 (2026-10-05): the bundled Noto Sans JP (the default; @fontsource-variable/noto-sans-jp, its unicode-range
 * subsets fetched only as the text needs them) or the system's fonts, per device. <html data-font="system"> swaps the
 * stylesheet's --font-ui; with it set, no Noto file is fetched.
 */
export type FontChoice = "noto" | "system";

const FONT_KEY = "chikuwa.prefs.font";

export const FONT_OPTIONS: Array<[FontChoice, string]> = [
  ["noto", "Noto Sans JP"],
  labelled("system", "theme.font.system"),
];

export function readFont(): FontChoice {
  try {
    return localStorage.getItem(FONT_KEY) === "system" ? "system" : "noto";
  } catch {
    return "noto";
  }
}

/** Puts the choice on screen (<html data-font="system">; the default has none). */
export function applyFont(font: FontChoice, root: HTMLElement = document.documentElement): void {
  if (font === "system") root.dataset["font"] = "system";
  else delete root.dataset["font"];
}

const fontListeners = new Set<() => void>();

export function writeFont(font: FontChoice): void {
  try {
    if (font === "system") localStorage.setItem(FONT_KEY, "system");
    else localStorage.removeItem(FONT_KEY);
  } catch {
    /* per-device convenience only: it still applies to this window */
  }
  applyFont(font);
  for (const listener of fontListeners) listener();
}

export function useFont(): FontChoice {
  return useSyncExternalStore(
    (listener) => {
      fontListeners.add(listener);
      return () => fontListeners.delete(listener);
    },
    readFont,
  );
}
