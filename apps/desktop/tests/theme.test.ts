// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { applyPalette, applyTheme, DEFAULT_PALETTE, PALETTES, paletteLabel, readPalette, readTheme, themeLabel, writePalette, writeTheme } from "../src/ui/theme";

const css = readFileSync(resolve(__dirname, "../src/styles.css"), "utf8");

afterEach(() => {
  localStorage.clear();
  delete document.documentElement.dataset["theme"];
  delete document.documentElement.dataset["palette"];
});

describe("「表示」 (M40)", () => {
  it("defaults to the OS and keeps a choice on this device", () => {
    expect(readTheme()).toBe("system");
    writeTheme("dark");
    expect(readTheme()).toBe("dark");
    expect(document.documentElement.dataset["theme"]).toBe("dark");
    writeTheme("light");
    expect(document.documentElement.dataset["theme"]).toBe("light");
    writeTheme("system");
    expect(localStorage.getItem("chikuwa.prefs.theme")).toBeNull();
    expect(document.documentElement.dataset["theme"]).toBeUndefined();
    localStorage.setItem("chikuwa.prefs.theme", "sepia");
    expect(readTheme()).toBe("system");
    applyTheme("dark");
    expect(document.documentElement.dataset["theme"]).toBe("dark");
    expect(themeLabel("system")).toBe("端末に合わせる");
  });

  it("the stylesheet: the palette's values, dark tokens for the OS unless pinned light, and for a pinned dark", () => {
    expect(css).toMatch(/:root \{[^}]*--accent: var\(--p-accent\);/);
    expect(css).toContain('@media (prefers-color-scheme: dark) {\n  :root:not([data-theme="light"]) {');
    expect(css).toMatch(/:root\[data-theme="dark"\] \{[^}]*--accent: var\(--p-accent-dark\);/);
    expect(css).toMatch(/:root\[data-theme="dark"\] \{[^}]*--accent-solid: var\(--p-accent-solid-dark\);/);
  });
});

// --- 「テーマの色」 ------------------------------------------------------------------------------

/** The `--p-*` values of one palette's block (the default is the first plain `:root` block). */
function paletteVars(name: string): Record<string, string> {
  const selector = name === DEFAULT_PALETTE ? ":root {" : `:root[data-palette="${name}"] {`;
  const start = css.indexOf(selector);
  expect(start, `no block for ${name}`).toBeGreaterThanOrEqual(0);
  const body = css.slice(start, css.indexOf("}", start));
  return Object.fromEntries([...body.matchAll(/--p-([a-z-]+): (#[0-9a-f]{6});/g)].map((m) => [m[1]!, m[2]!]));
}

function luminance(hex: string): number {
  const channel = (i: number) => {
    const c = parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(0) + 0.7152 * channel(1) + 0.0722 * channel(2);
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

/** `top` with `alpha` over `bottom` (the sidebar's active row is white at 16 %). */
function over(top: string, alpha: number, bottom: string): string {
  const mix = (i: number) => Math.round(parseInt(top.slice(1 + i * 2, 3 + i * 2), 16) * alpha + parseInt(bottom.slice(1 + i * 2, 3 + i * 2), 16) * (1 - alpha));
  return `#${[0, 1, 2].map((i) => mix(i).toString(16).padStart(2, "0")).join("")}`;
}

const CANVAS = { light: "#ffffff", dark: "#17181d" };
const PANEL = { light: "#f6f6f9", dark: "#1e1f26" };

describe("「テーマの色」", () => {
  it("defaults to Taylis and keeps a choice on this device (<html data-palette>)", () => {
    expect(readPalette()).toBe("taylis");
    writePalette("green");
    expect(readPalette()).toBe("green");
    expect(document.documentElement.dataset["palette"]).toBe("green");
    expect(localStorage.getItem("chikuwa.prefs.palette")).toBe("green");
    writePalette("taylis");
    expect(localStorage.getItem("chikuwa.prefs.palette")).toBeNull();
    expect(document.documentElement.dataset["palette"]).toBeUndefined();
    localStorage.setItem("chikuwa.prefs.palette", "neon");
    expect(readPalette()).toBe("taylis");
    applyPalette("rose");
    expect(document.documentElement.dataset["palette"]).toBe("rose");
    expect(paletteLabel("indigo")).toBe("藍");
  });

  it("the stylesheet has every palette, light and dark, and the settings' swatches match it", () => {
    expect(css).toContain(`--p-sidebar: ${PALETTES[0]!.swatch.sidebar};`);
    for (const palette of PALETTES) {
      const vars = paletteVars(palette.value);
      expect(Object.keys(vars).sort()).toEqual(["accent", "accent-dark", "accent-soft", "accent-soft-dark", "accent-solid", "accent-solid-dark", "sidebar", "sidebar-dark", "sidebar-fg", "sidebar-fg-dark"]);
      expect(vars["sidebar"]).toBe(palette.swatch.sidebar);
      expect(vars["accent"]).toBe(palette.swatch.accent);
    }
  });

  it("every palette passes WCAG AA (4.5:1) for text on the sidebar, white on the accent, and the accent as text", () => {
    for (const palette of PALETTES) {
      const v = paletteVars(palette.value);
      for (const mode of ["light", "dark"] as const) {
        const p = (name: string) => v[mode === "dark" ? `${name}-dark` : name]!;
        const at = `${palette.value} ${mode}`;
        expect(contrast(p("sidebar-fg"), p("sidebar")), `${at}: sidebar text`).toBeGreaterThanOrEqual(4.5);
        expect(contrast("#ffffff", over("#ffffff", 0.16, p("sidebar"))), `${at}: the active row`).toBeGreaterThanOrEqual(4.5);
        expect(contrast("#ffffff", p("accent-solid")), `${at}: white on the accent`).toBeGreaterThanOrEqual(4.5);
        expect(contrast(p("accent"), CANVAS[mode]), `${at}: links on the canvas`).toBeGreaterThanOrEqual(4.5);
        expect(contrast(p("accent"), PANEL[mode]), `${at}: links on a panel`).toBeGreaterThanOrEqual(4.5);
        expect(contrast(p("accent"), p("accent-soft")), `${at}: accent text on its tint`).toBeGreaterThanOrEqual(4.5);
      }
    }
  });
});
