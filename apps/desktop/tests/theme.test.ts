// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { applyFont, applyPalette, applySidebarTone, applyTheme, DEFAULT_PALETTE, FONT_OPTIONS, readFont, writeFont, PALETTES, paletteLabel, readPalette, readSidebarTone, readTheme, SIDEBAR_TONES, themeLabel, writePalette, writeSidebarTone, writeTheme } from "../src/ui/theme";

const css = readFileSync(resolve(__dirname, "../src/styles.css"), "utf8");

afterEach(() => {
  localStorage.clear();
  delete document.documentElement.dataset["theme"];
  delete document.documentElement.dataset["palette"];
  delete document.documentElement.dataset["sidebar"];
  delete document.documentElement.dataset["font"];
});

describe("「フォント」 (2026-10-05)", () => {
  it("defaults to the bundled Noto Sans JP and keeps 「システムのフォント」 on this device (<html data-font>)", () => {
    expect(readFont()).toBe("noto");
    writeFont("system");
    expect(readFont()).toBe("system");
    expect(document.documentElement.dataset["font"]).toBe("system");
    expect(localStorage.getItem("chikuwa.prefs.font")).toBe("system");
    writeFont("noto");
    expect(localStorage.getItem("chikuwa.prefs.font")).toBeNull();
    expect(document.documentElement.dataset["font"]).toBeUndefined();
    applyFont("system");
    expect(document.documentElement.dataset["font"]).toBe("system");
    expect(FONT_OPTIONS.map(([, label]) => label)).toEqual(["Noto Sans JP", "システムのフォント"]);
  });

  it("the stylesheet puts Noto Sans JP Variable first, the system's fonts after, and drops it for data-font=system", () => {
    expect(css).toContain('--font-ui: "Noto Sans JP Variable", var(--font-system);');
    expect(css).toContain(':root[data-font="system"] { --font-ui: var(--font-system); }');
    expect(css).toMatch(/--font-system: -apple-system, [^;]*"Hiragino Sans"[^;]*sans-serif;/);
    expect(css).toContain("font-family: var(--font-ui);");
  });
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

  it("the dark sidebar's text is bright (2026-10-04: about 11:1 and more) and its headers and unread rows stay apart", () => {
    for (const palette of PALETTES) {
      const v = paletteVars(palette.value);
      for (const mode of ["light", "dark"] as const) {
        const p = (name: string) => v[mode === "dark" ? `${name}-dark` : name]!;
        const at = `${palette.value} ${mode}`;
        const text = contrast(p("sidebar-fg"), p("sidebar"));
        expect(text, `${at}: sidebar text`).toBeGreaterThanOrEqual(mode === "light" ? 11 : 12.5);
        expect(text, `${at}: sidebar text`).toBeLessThan(13.5);
        // Unread rows are white (and bold): clearly brighter than a read row.
        expect(contrast("#ffffff", p("sidebar")) - text, `${at}: unread vs read`).toBeGreaterThanOrEqual(1.2);
        // Section headers (--sidebar-muted, the text at 70 %): readable, and dimmer than a row.
        const header = contrast(over(p("sidebar-fg"), 0.7, p("sidebar")), p("sidebar"));
        expect(header, `${at}: section header`).toBeGreaterThanOrEqual(4.5);
        expect(text - header, `${at}: header vs row`).toBeGreaterThanOrEqual(3);
      }
    }
    expect(css).toContain("--sidebar-muted: color-mix(in srgb, var(--sidebar-fg) 70%, var(--sidebar));");
  });
});

// --- 「サイドバー: 明るい色」 -------------------------------------------------------------------

/** All declarations of the plain `:root {` blocks (the default palette and the tokens). */
const rootDecls: Record<string, string> = Object.fromEntries(
  [...css.matchAll(/^:root \{([^}]*)\}/gm)].flatMap((m) => [...m[1]!.matchAll(/(--[a-z0-9-]+): ([^;]+);/g)].map((d) => [d[1]!, d[2]!.trim()])),
);

interface Rgba { rgb: [number, number, number]; a: number }

/** Evaluates the stylesheet's colour expressions: a hex, `transparent`, `var(--x)` and `color-mix(in srgb, A n%, B)`. */
function evaluate(expr: string, vars: Record<string, string>): Rgba {
  expr = expr.trim();
  if (expr === "transparent") return { rgb: [0, 0, 0], a: 0 };
  const hex = /^#([0-9a-f]{6})$/.exec(expr);
  if (hex) return { rgb: [0, 1, 2].map((i) => parseInt(hex[1]!.slice(i * 2, i * 2 + 2), 16)) as [number, number, number], a: 1 };
  const ref = /^var\((--[a-z0-9-]+)\)$/.exec(expr);
  if (ref) {
    const value = vars[ref[1]!];
    expect(value, `${ref[1]} is defined`).toBeDefined();
    return evaluate(value!, vars);
  }
  const mix = /^color-mix\(in srgb, (.+) (\d+)%, (.+)\)$/.exec(expr);
  expect(mix, `can read ${expr}`).not.toBeNull();
  const [first, second, p] = [evaluate(mix![1]!, vars), evaluate(mix![3]!, vars), Number(mix![2]) / 100];
  const a = first.a * p + second.a * (1 - p);
  const rgb = [0, 1, 2].map((i) => (a === 0 ? 0 : (first.rgb[i]! * first.a * p + second.rgb[i]! * second.a * (1 - p)) / a)) as [number, number, number];
  return { rgb, a };
}

/** The colour as seen over an opaque `bottom`. */
function flat(colour: Rgba, bottom = "#ffffff"): string {
  const base = evaluate(bottom, {});
  return `#${colour.rgb.map((c, i) => Math.round(c * colour.a + base.rgb[i]! * (1 - colour.a)).toString(16).padStart(2, "0")).join("")}`;
}

/** The light sidebar's declarations (both of its blocks must say the same). */
function lightSidebarBlock(): Record<string, string> {
  const blocks = [
    /:root\[data-sidebar="light"\]:not\(\[data-theme="dark"\]\) \{([^}]*)\}/.exec(css),
    /:root\[data-sidebar="light"\]\[data-theme="light"\] \{([^}]*)\}/.exec(css),
  ].map((m) => {
    expect(m).not.toBeNull();
    return Object.fromEntries([...m![1]!.matchAll(/(--[a-z0-9-]+): ([^;]+);/g)].map((d) => [d[1]!, d[2]!.trim()]));
  });
  expect(blocks[0]).toEqual(blocks[1]);
  return blocks[0]!;
}

describe("「サイドバー: 明るい色」", () => {
  it("defaults to the dark sidebar and keeps a choice on this device (<html data-sidebar>)", () => {
    expect(readSidebarTone()).toBe("dark");
    writeSidebarTone("light");
    expect(readSidebarTone()).toBe("light");
    expect(document.documentElement.dataset["sidebar"]).toBe("light");
    expect(localStorage.getItem("chikuwa.prefs.sidebar")).toBe("light");
    writeSidebarTone("dark");
    expect(localStorage.getItem("chikuwa.prefs.sidebar")).toBeNull();
    expect(document.documentElement.dataset["sidebar"]).toBeUndefined();
    localStorage.setItem("chikuwa.prefs.sidebar", "neon");
    expect(readSidebarTone()).toBe("dark");
    applySidebarTone("light");
    expect(document.documentElement.dataset["sidebar"]).toBe("light");
    expect(SIDEBAR_TONES.map(([, label]) => label)).toEqual(["濃い色", "明るい色"]);
  });

  it("applies in light mode only: the OS's light unless pinned dark, or a pinned light; after the dark blocks", () => {
    expect(css).toContain('@media (prefers-color-scheme: light) {\n  :root[data-sidebar="light"]:not([data-theme="dark"]) {');
    const pinned = css.indexOf(':root[data-sidebar="light"][data-theme="light"] {');
    expect(pinned).toBeGreaterThan(css.indexOf(':root[data-theme="dark"] {'));
    expect(css.indexOf('@media (prefers-color-scheme: light)')).toBeGreaterThan(css.indexOf('@media (prefers-color-scheme: dark)'));
    const block = lightSidebarBlock();
    // Every sidebar token is replaced (none left white on a light background).
    expect(Object.keys(block).sort()).toEqual([
      "--sidebar", "--sidebar-active", "--sidebar-active-fg", "--sidebar-edge", "--sidebar-fg", "--sidebar-hover", "--sidebar-line", "--sidebar-muted", "--sidebar-rail", "--sidebar-strong",
    ]);
    expect(block["--sidebar-active"]).toBe("var(--accent-solid)");
  });

  it("every palette's light sidebar: dark text (7:1 and more), unread darker still, headers AA, the active row white on the accent", () => {
    const block = lightSidebarBlock();
    for (const palette of PALETTES) {
      const v = paletteVars(palette.value);
      const vars: Record<string, string> = { ...rootDecls, "--accent-solid": "var(--p-accent-solid)", ...Object.fromEntries(Object.entries(v).map(([k, value]) => [`--p-${k}`, value])) };
      const token = (name: string, bottom?: string) => flat(evaluate(block[name]!, vars), bottom);
      const bg = token("--sidebar");
      const at = palette.value;
      expect(contrast(bg, "#ffffff"), `${at}: near-white`).toBeLessThan(1.15);
      const text = contrast(token("--sidebar-fg"), bg);
      const strong = contrast(token("--sidebar-strong"), bg);
      expect(text, `${at}: sidebar text`).toBeGreaterThanOrEqual(7);
      expect(strong - text, `${at}: unread vs read`).toBeGreaterThanOrEqual(3);
      expect(contrast(token("--sidebar-muted"), bg), `${at}: section header`).toBeGreaterThanOrEqual(4.5);
      expect(contrast(token("--sidebar-fg"), token("--sidebar-hover", bg)), `${at}: text on hover`).toBeGreaterThanOrEqual(7);
      expect(contrast(token("--sidebar-active-fg"), token("--sidebar-active")), `${at}: the active row`).toBeGreaterThanOrEqual(4.5);
      // The rail is a shade darker than the sidebar, and the workspace's indicator / ring (strong) shows on it.
      const rail = token("--sidebar-rail");
      expect(luminance(rail), `${at}: rail darker`).toBeLessThan(luminance(bg));
      expect(contrast(token("--sidebar-strong"), rail), `${at}: on the rail`).toBeGreaterThanOrEqual(7);
      // Separators and the edge against the canvas can be seen (non-text, 1.2:1 at least).
      expect(contrast(token("--sidebar-line", bg), bg), `${at}: separators`).toBeGreaterThanOrEqual(1.2);
      expect(contrast(token("--sidebar-edge", "#ffffff"), "#ffffff"), `${at}: edge`).toBeGreaterThanOrEqual(1.2);
    }
  });
});
