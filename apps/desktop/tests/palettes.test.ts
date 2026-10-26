import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { DEFAULT_PALETTE, PALETTES } from "../src/ui/theme";

const css = readFileSync(resolve(__dirname, "../src/app.css"), "utf8");
const shared = JSON.parse(readFileSync(resolve(__dirname, "../../shared/palettes.json"), "utf8")) as {
  order: string[];
  palettes: Record<string, { light: Record<string, string>; dark: Record<string, string> }>;
};

/** The --p-* values of one palette block of app.css (the default is the plain :root block). */
function cssPalette(name: string): { light: Record<string, string>; dark: Record<string, string> } {
  const selector = name === DEFAULT_PALETTE ? /:root\s*\{([^}]*)\}/ : new RegExp(`:root\\[data-palette="${name}"\\]\\s*\\{([^}]*)\\}`);
  const body = css.match(selector)?.[1] ?? "";
  const light: Record<string, string> = {};
  const dark: Record<string, string> = {};
  for (const [, key, value] of body.matchAll(/--p-([\w-]+):\s*(#[0-9a-fA-F]{6})/g)) {
    if (key!.endsWith("-dark")) dark[key!.slice(0, -"-dark".length)] = value!;
    else light[key!] = value!;
  }
  return { light, dark };
}

describe("apps/shared/palettes.json (the phones' 「テーマの色」)", () => {
  it("lists the desktop's palettes in the settings' order, the default first", () => {
    expect(shared.order).toEqual(PALETTES.map((p) => p.value));
    expect(shared.order[0]).toBe(DEFAULT_PALETTE);
  });

  it("has the same colours as app.css", () => {
    for (const name of shared.order) expect(shared.palettes[name], name).toEqual(cssPalette(name));
  });
});
