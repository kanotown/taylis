/**
 * The phones' page editor bundle (vite.mobile-editor.config.ts, M153a): its CSP runs only the bundle's own script where
 * each app serves it (2026-11-16, a hostile-server review: script-src was the whole taylis-editor: scheme and 'self',
 * which also serve the page's pictures — a server's bytes) and lets the page talk to no one. Checked by hand with the
 * built page in WebKit under the iOS scheme (a WKURLSchemeHandler) and in Chromium / WebKit at the Android address:
 * the editor starts, and a <script> pointing at /attachment/<id> is refused.
 */
import { describe, expect, it } from "vitest";

import { CSP, EDITOR_SCRIPTS } from "../vite.mobile-editor.config";

function directive(name: string): string[] {
  const found = CSP.split(";").map((part) => part.trim().split(/\s+/)).find((words) => words[0] === name);
  return found ? found.slice(1) : [];
}

describe("the page editor bundle's CSP", () => {
  it("runs the bundle's script only, from where iOS and Android serve it", () => {
    expect(EDITOR_SCRIPTS).toEqual(["taylis-editor://app/editor.js", "https://appassets.androidplatform.net/editor/editor.js"]);
    expect(directive("script-src")).toEqual([...EDITOR_SCRIPTS]);
    for (const broad of ["'self'", "taylis-editor:", "'unsafe-inline'", "'unsafe-eval'", "https:", "*"]) expect(directive("script-src")).not.toContain(broad);
  });

  it("talks to no one, and loads nothing by default", () => {
    expect(directive("default-src")).toEqual(["'none'"]);
    expect(directive("connect-src")).toEqual(["'none'"]);
    expect(directive("base-uri")).toEqual(["'none'"]);
    expect(directive("form-action")).toEqual(["'none'"]);
  });
});
