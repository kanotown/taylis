/**
 * 2026-11-16 (a hostile-server review): a formula stays in its own box. KaTeX caps positive sizes but not negative
 * ones (\kern{-300em}, \raisebox{-300em}{…}). What moves sideways or out of the box is clipped by the wrappers
 * (app.css; checked in WebKit and Chromium with fractions, sums with limits, matrices, cases, roots and accents: none
 * cut), and a formula taller than MATH_MAX_HEIGHT_EM is not drawn at all (its source shows).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import katex from "katex";
import { describe, expect, it } from "vitest";

import { MATH_MAX_HEIGHT_EM, mathFits, renderMath } from "../src/ui/MathView";

describe("formulas stay in their box", () => {
  it("draws ordinary formulas, inline and display", () => {
    for (const tex of ["\\frac{a+b}{c^2}", "\\sum_{i=1}^{n} x_i^2", "\\int_0^1 f(x)\\,dx", "\\begin{pmatrix} a & b \\\\ c & d \\end{pmatrix}", "x\\!y", "\\raisebox{0.5em}{x}", "\\kern-0.2em x"]) {
      for (const display of [false, true]) expect(renderMath(katex, tex, display), tex).toContain("katex");
    }
    // A tall but honest matrix (40 rows) is still drawn.
    const rows = Array.from({ length: 40 }, (_, i) => String(i)).join("\\\\");
    expect(renderMath(katex, `\\begin{pmatrix}${rows}\\end{pmatrix}`, true)).toContain("katex");
  });

  it("does not draw a formula pushed thousands of pixels down (its source shows instead)", () => {
    for (const tex of ["\\raisebox{-300em}{\\text{偽}}", "\\raisebox{-20em}{\\raisebox{-20em}{\\raisebox{-20em}{\\raisebox{-20em}{x}}}}", "\\rule[-300em]{1em}{1em}"]) {
      for (const display of [false, true]) expect(renderMath(katex, tex, display), tex).toBeNull();
    }
    expect(mathFits('<span class="katex-strut" style="height:1.04em;vertical-align:-0.34em;"></span>')).toBe(true);
    expect(mathFits(`<span class="katex-strut" style="height:${MATH_MAX_HEIGHT_EM + 1}em;"></span>`)).toBe(false);
  });

  it("the wrappers clip what leaves them (app.css, shared with the phones' editor)", () => {
    const css = readFileSync(join(process.cwd(), "src", "app.css"), "utf8");
    expect(css).toMatch(/^\.math-inline \{ display: inline-block; max-width: 100%; clip-path: inset\(/m);
    expect(css).toMatch(/^\.math-display \{ clip-path: inset\(0\); \}/m);
    // Not scoped to a message body: the page editor and the phones' editor draw the same wrappers.
    expect(css).not.toMatch(/\.body \.math-inline \{/);
  });
});
