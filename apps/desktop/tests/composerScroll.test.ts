// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

import { contentLine, fits, keepLineInView, lineAround, markerLine, revealLine, settle, textAreaCaretLine } from "../src/ui/composerScroll";

afterEach(() => vi.restoreAllMocks());

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

  it("asks for the caret's line only above the cap (the text area's mirror is not built while the draft fits)", () => {
    const sizes = { clientHeight: 88, scrollHeight: 89 };
    const el = element(sizes);
    const caret = vi.fn(() => line(13));
    keepLineInView(el, caret);
    expect(caret).not.toHaveBeenCalled();
    sizes.clientHeight = 280;
    sizes.scrollHeight = 352;
    keepLineInView(el, caret);
    expect(caret).toHaveBeenCalledTimes(1);
    expect(el.scrollTop).toBe(72);
    el.remove();
  });

  describe("the mirror's marker", () => {
    // The mirror at viewport top 100 with a 1 px border; the marker's first fragment on line 2, a 21 px glyph box.
    const fragment = (n: number, top = 100 + 1) => ({ top: top + 12 + 24 * n + 1.5, bottom: top + 12 + 24 * n + 22.5 });
    const box = (over: Partial<{ top: number; height: number; offsetHeight: number; clientTop: number }> = {}) => ({
      getBoundingClientRect: () => ({ top: over.top ?? 100, height: over.height ?? 400 }),
      offsetHeight: over.offsetHeight ?? 400,
      clientTop: over.clientTop ?? 1,
    });

    it("is its first line fragment: a Japanese marker runs to the paragraph's end, over many lines", () => {
      const marker = { getClientRects: () => [fragment(2), fragment(3), fragment(4)], offsetTop: 61.5, offsetHeight: 69 };
      expect(markerLine(marker, box())).toEqual({ top: 61.5, bottom: 82.5 });
      expect(lineAround(markerLine(marker, box()), 24)).toEqual(line(2));
      // Its offset box, which the old measure took, reached line 4: the input would have scrolled to the paragraph's end.
      expect(marker.offsetTop + marker.offsetHeight).toBeGreaterThan(line(4).top);
    });

    it("turns viewport pixels into the mirror's own under a zoom, and falls back to the offset box without rects", () => {
      // WebKit's `zoom: 0.9`: the mirror's 400 px show as 360, and the fragment's pixels are 0.9 of its own.
      const zoomed = { getClientRects: () => [{ top: 100 + (1 + 12 + 48 + 1.5) * 0.9, bottom: 100 + (1 + 12 + 48 + 22.5) * 0.9 }], offsetTop: 61.5, offsetHeight: 21 };
      const { top, bottom } = markerLine(zoomed, box({ height: 360 }));
      expect(top).toBeCloseTo(61.5);
      expect(bottom).toBeCloseTo(82.5);
      expect(markerLine({ getClientRects: () => [], offsetTop: 61.5, offsetHeight: 21 }, box())).toEqual({ top: 61.5, bottom: 82.5 });
    });

    it("textAreaCaretLine lays out the rest of the caret's word, or of a Japanese paragraph, and reads one line of it", () => {
      const area = document.createElement("textarea");
      area.style.paddingTop = "12px";
      area.style.lineHeight = "24px";
      area.style.fontSize = "14.5px";
      document.body.appendChild(area);
      const markers: string[] = [];
      const isMirror = (el: Element | null) => el instanceof HTMLDivElement && el.style.visibility === "hidden";
      vi.spyOn(Element.prototype, "getClientRects").mockImplementation(function (this: Element) {
        if (!(this instanceof HTMLSpanElement) || !isMirror(this.parentElement)) return [] as unknown as DOMRectList;
        markers.push(this.textContent ?? "");
        const lines = Math.ceil((this.textContent?.length ?? 1) / 10); // ten characters a line
        return Array.from({ length: lines }, (_, i) => fragment(2 + i, 100)) as unknown as DOMRectList;
      });
      vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
        return { top: isMirror(this) ? 100 : 0, height: 0, bottom: 0, left: 0, right: 0, width: 0, x: 0, y: 0, toJSON: () => ({}) };
      });
      const caretAt = (value: string, caret: number) => {
        area.value = value;
        area.setSelectionRange(caret, caret);
        return textAreaCaretLine(area);
      };
      const paragraph = "設計の話を決める会議の日取りをまだ誰も決めていないので早めに相談したい。";
      expect(caretAt(`${paragraph}\n次の段落`, 10)).toEqual(line(2)); // the marker wraps over four lines; the caret's is the first
      expect(markers.at(-1)).toBe(paragraph.slice(10));
      expect(caretAt("hello world and more", 8)).toEqual(line(2));
      expect(markers.at(-1)).toBe("rld"); // the caret's word, so it wraps where it does
      caretAt("end", 3);
      expect(markers.at(-1)).toBe("​"); // nothing after the caret: a zero-width stand-in
      expect(document.body.querySelector("div")).toBeNull(); // the mirror is gone
      area.remove();
    });
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
