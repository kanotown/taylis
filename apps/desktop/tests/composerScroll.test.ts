// @vitest-environment jsdom
import { describe, expect, it } from "vitest";

import { contentLine, fits, keepLineInView, lineAround, revealLine, settle } from "../src/ui/composerScroll";

// The composer's box: 12 px of padding above the text, 4 below, 24 px lines, 280 px at most (Composer.tsx).
const PADDING = { top: 12, bottom: 4 };
const line = (n: number) => ({ top: 12 + 24 * n, bottom: 36 + 24 * n }); // the nth line (0-based)
const box = (lines: number, scrollTop = 0) => {
  const scrollHeight = 16 + 24 * lines;
  return { scrollTop, clientHeight: Math.min(scrollHeight, 280), scrollHeight };
};

/** A div with the given heights (jsdom lays nothing out). */
function element(sizes: { clientHeight: number; scrollHeight: number; offsetHeight?: number; rect?: { top: number; height: number } }) {
  const el = document.createElement("div");
  el.style.paddingTop = "12px";
  el.style.paddingBottom = "4px";
  Object.defineProperty(el, "clientHeight", { configurable: true, get: () => sizes.clientHeight });
  Object.defineProperty(el, "scrollHeight", { configurable: true, get: () => sizes.scrollHeight });
  Object.defineProperty(el, "offsetHeight", { configurable: true, get: () => sizes.offsetHeight ?? sizes.clientHeight });
  let scrollTop = 0;
  Object.defineProperty(el, "scrollTop", { configurable: true, get: () => scrollTop, set: (v: number) => (scrollTop = Math.max(0, Math.min(v, sizes.scrollHeight - sizes.clientHeight))) });
  const rect = sizes.rect ?? { top: 0, height: sizes.clientHeight };
  el.getBoundingClientRect = () => ({ top: rect.top, bottom: rect.top + rect.height, height: rect.height, left: 0, right: 300, width: 300, x: 0, y: rect.top, toJSON: () => ({}) });
  document.body.appendChild(el);
  return el;
}

describe("the composer's scrolling (composerScroll.ts)", () => {
  it("has nothing to scroll while the draft fits, a zoom's rounding pixel included", () => {
    expect(fits({ clientHeight: 88, scrollHeight: 88 })).toBe(true);
    expect(fits({ clientHeight: 88, scrollHeight: 89 })).toBe(true); // WebKit at 110 %
    expect(fits({ clientHeight: 280, scrollHeight: 304 })).toBe(false);
    // Typing on the fourth line of four: the box grew, nothing scrolls, whatever the caret's line says.
    expect(revealLine({ ...box(4), scrollTop: 1 }, line(3), PADDING)).toBe(0);
    expect(revealLine({ clientHeight: 88, scrollHeight: 89, scrollTop: 1 }, line(2), PADDING)).toBe(0);
  });

  it("shows the last line with the padding below it, by whole lines as lines come and go", () => {
    // Enter at the end of 11 lines (the cap) and on: 24 px per line, never the 18 or 23 the engines stopped at.
    expect(revealLine(box(12, 0), line(11), PADDING)).toBe(24);
    expect(revealLine(box(13, 24), line(12), PADDING)).toBe(48);
    expect(revealLine(box(14, 48), line(13), PADDING)).toBe(72);
    // Backspace back up: the end stays at the bottom.
    expect(revealLine(box(13, 48), line(12), PADDING)).toBe(48);
    expect(revealLine(box(12, 24), line(11), PADDING)).toBe(24);
  });

  it("does not move for the IME's text or a Japanese caret, whose box is shorter than a Latin one", () => {
    const latin = lineAround({ top: 12 + 24 * 13, bottom: 36 + 24 * 13 }, 24);
    const japanese = lineAround({ top: 13.5 + 24 * 13, bottom: 34.5 + 24 * 13 }, 24); // a 21 px glyph box, centred
    const composing = lineAround({ top: 15 + 24 * 13, bottom: 37 + 24 * 13 }, 24); // lower: the IME's underlined text
    expect(japanese).toEqual(latin);
    for (const caret of [latin, japanese, composing]) expect(revealLine(box(14, 72), caret, PADDING)).toBe(72);
  });

  it("leaves a line in view where it is and brings others in just enough, with a few pixels of their neighbours", () => {
    // 14 lines scrolled to the end: lines 3 to 13 are in view.
    expect(revealLine(box(14, 72), line(5), PADDING)).toBe(72);
    expect(revealLine(box(14, 72), line(3), PADDING)).toBe(72);
    expect(revealLine(box(14, 72), line(2), PADDING)).toBe(line(2).top - 4);
    expect(revealLine(box(14, 0), line(12), PADDING)).toBe(line(12).bottom + 4 - 280);
    // The first line comes with the padding above it.
    expect(revealLine(box(14, 72), line(0), PADDING)).toBe(0);
  });

  it("puts a line taller than the box at its top (a long heading on a phone)", () => {
    expect(revealLine({ scrollTop: 0, clientHeight: 96, scrollHeight: 400 }, { top: 150, bottom: 260 }, PADDING)).toBe(146);
  });

  it("measures the caret's line, not its glyph", () => {
    expect(lineAround({ top: 40, bottom: 58 }, 24)).toEqual({ top: 37, bottom: 61 });
    expect(lineAround({ top: 40, bottom: 70 }, 24)).toEqual({ top: 40, bottom: 70 }); // a heading's taller glyphs
    expect(lineAround({ top: 40, bottom: 58 }, 0)).toEqual({ top: 40, bottom: 58 });
  });

  it("hides the scrollbar and goes back to the top while the draft fits, and scrolls again above the cap", () => {
    const sizes = { clientHeight: 88, scrollHeight: 89 };
    const el = element(sizes);
    el.scrollTop = 1;
    expect(settle(el)).toBe(true);
    expect(el.style.overflowY).toBe("hidden");
    expect(el.scrollTop).toBe(0);
    sizes.clientHeight = 280;
    sizes.scrollHeight = 304;
    expect(settle(el)).toBe(false);
    expect(el.style.overflowY).toBe("auto");
    el.remove();
  });

  it("scrolls a box to the caret's line, reading the padding from its style", () => {
    const el = element({ clientHeight: 280, scrollHeight: 352 });
    keepLineInView(el, line(13));
    expect(el.scrollTop).toBe(72);
    keepLineInView(el, line(5)); // in view: stays
    expect(el.scrollTop).toBe(72);
    keepLineInView(el, null); // the input is not focused: only settled
    expect(el.scrollTop).toBe(72);
    el.remove();
  });

  it("turns viewport coordinates into the box's content coordinates, also under a zoom", () => {
    const el = element({ clientHeight: 280, scrollHeight: 352, rect: { top: 400, height: 280 } });
    el.scrollTop = 72;
    // The glyph 4 px below the box's top edge: line 3 of the content (12 + 3 × 24 = 84 .. 108).
    expect(contentLine(el, { top: 400 + 13.5, bottom: 400 + 34.5 }, 24)).toEqual({ top: 72 + 12, bottom: 72 + 36 });
    // WebKit's `zoom: 0.9`: viewport pixels are 0.9 of the box's own.
    const zoomed = element({ clientHeight: 280, scrollHeight: 352, offsetHeight: 280, rect: { top: 400, height: 252 } });
    zoomed.scrollTop = 72;
    expect(contentLine(zoomed, { top: 400 + 13.5 * 0.9, bottom: 400 + 34.5 * 0.9 }, 24)).toEqual({ top: 84, bottom: 108 });
    el.remove();
    zoomed.remove();
  });
});
