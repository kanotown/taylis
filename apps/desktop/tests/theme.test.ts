// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { applyTheme, readTheme, themeLabel, writeTheme } from "../src/ui/theme";

afterEach(() => {
  localStorage.clear();
  delete document.documentElement.dataset["theme"];
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

  it("the stylesheet: the brand colour #5b5bd6, dark tokens for the OS unless pinned light, and for a pinned dark", () => {
    const css = readFileSync(resolve(__dirname, "../src/styles.css"), "utf8");
    expect(css).toMatch(/:root \{[^}]*--accent: #5b5bd6;/);
    expect(css).toContain('@media (prefers-color-scheme: dark) {\n  :root:not([data-theme="light"]) {');
    expect(css).toMatch(/:root\[data-theme="dark"\] \{[^}]*--accent: #7f7ff2;/);
  });
});
