/** CANVAS.md §23: the canvas editor's scroll sync — the line ↔ offset mapping, the anchors and the parser's line ranges. */
import { describe, expect, it } from "vitest";

import { anchorLineOf, buildAnchors, lastAtOrBefore, lineAtOffset, mapScroll, offsetOfLine } from "../src/ui/canvasScrollSync";
import { parseBlocksWithLines } from "../src/ui/markdown";

// Lines 28 px high, line 2 wrapped onto three rows; content from y = 16 (padding) to 16 + 6 × 28.
const tops = [16, 44, 72, 156, 184];
const end = 212;

describe("lastAtOrBefore", () => {
  it("finds the last value at or before y", () => {
    expect(lastAtOrBefore(tops, 0)).toBe(-1);
    expect(lastAtOrBefore(tops, 16)).toBe(0);
    expect(lastAtOrBefore(tops, 100)).toBe(2);
    expect(lastAtOrBefore(tops, 184)).toBe(4);
    expect(lastAtOrBefore(tops, 9999)).toBe(4);
    expect(lastAtOrBefore([], 5)).toBe(-1);
  });
});

describe("offsetOfLine / lineAtOffset", () => {
  it("whole lines are their tops", () => {
    tops.forEach((top, k) => expect(offsetOfLine(tops, end, k)).toBe(top));
  });
  it("a fraction is that far into the line's height (a wrapped line is taller)", () => {
    expect(offsetOfLine(tops, end, 2.5)).toBe(114);
    expect(offsetOfLine(tops, end, 4.5)).toBe(198);
    expect(lineAtOffset(tops, end, 114)).toBe(2.5);
    expect(lineAtOffset(tops, end, 198)).toBe(4.5);
  });
  it("round trips", () => {
    for (const line of [0, 0.25, 1, 2.1, 2.9, 3.5, 4.75]) expect(lineAtOffset(tops, end, offsetOfLine(tops, end, line))).toBeCloseTo(line, 9);
  });
  it("clamps at the ends; an empty text is line 0 at 0", () => {
    expect(offsetOfLine(tops, end, -3)).toBe(16);
    expect(offsetOfLine(tops, end, 99)).toBe(end);
    expect(lineAtOffset(tops, end, 0)).toBe(0);
    expect(lineAtOffset(tops, end, 9999)).toBe(5);
    expect(offsetOfLine([], 0, 3)).toBe(0);
    expect(lineAtOffset([], 0, 30)).toBe(0);
  });
});

describe("buildAnchors / mapScroll", () => {
  // Editor: 100 lines 20 px high from y = 0; 600 px scrolls. Preview: blocks at lines 0, 10, 50, 90 with their tops.
  const lines = Array.from({ length: 100 }, (_, k) => k * 20);
  const blocks = [
    { line: 0, top: 40 },
    { line: 10, top: 300 },
    { line: 50, top: 900 },
    { line: 90, top: 2500 },
  ];
  const anchors = buildAnchors(lines, 2000, blocks, 1400, 2600);

  it("both tops and both ends are anchors; a block that cannot reach the top edge is left out", () => {
    expect(anchors).toEqual([
      { editor: 0, preview: 0 },
      { editor: 200, preview: 300 }, // line 0 is at y 0: not after the (0, 0) anchor, left out
      { editor: 1000, preview: 900 },
      { editor: 1400, preview: 2600 }, // line 90 (editor 1800) is past the editor's last scroll position
    ]);
  });

  it("interpolates between anchors, both ways, and the two directions are inverses", () => {
    expect(mapScroll(anchors, 100, "editor")).toBe(150);
    expect(mapScroll(anchors, 600, "editor")).toBe(600);
    expect(mapScroll(anchors, 150, "preview")).toBe(100);
    for (const y of [0, 37, 200, 512, 999, 1200, 1400]) expect(mapScroll(anchors, mapScroll(anchors, y, "editor"), "preview")).toBeCloseTo(y, 9);
  });

  it("top and bottom: the other side goes to its top / its end", () => {
    expect(mapScroll(anchors, 0, "editor")).toBe(0);
    expect(mapScroll(anchors, -5, "editor")).toBe(0);
    expect(mapScroll(anchors, 1400, "editor")).toBe(2600);
    expect(mapScroll(anchors, 5000, "editor")).toBe(2600);
    expect(mapScroll(anchors, 2600, "preview")).toBe(1400);
  });

  it("a block out of order (hidden, measured at 0) is skipped", () => {
    const withHidden = buildAnchors(lines, 2000, [{ line: 10, top: 300 }, { line: 20, top: 0 }, { line: 50, top: 900 }], 1400, 2600);
    expect(withHidden.map((a) => a.editor)).toEqual([0, 200, 1000, 1400]);
  });

  it("nothing to scroll on one side: only (0, 0); everything maps to 0", () => {
    const short = buildAnchors(lines, 2000, blocks, 1400, 0);
    expect(short).toEqual([{ editor: 0, preview: 0 }]);
    expect(mapScroll(short, 700, "editor")).toBe(0);
    expect(mapScroll([], 700, "editor")).toBe(0);
  });

  it("an empty canvas", () => {
    const empty = buildAnchors([0], 28, [], 0, 0);
    expect(mapScroll(empty, 0, "editor")).toBe(0);
    expect(mapScroll(empty, 0, "preview")).toBe(0);
  });

  it("a long canvas: binary search keeps it exact", () => {
    const many = Array.from({ length: 20000 }, (_, k) => k * 28);
    const manyBlocks = Array.from({ length: 4000 }, (_, k) => ({ line: k * 5, top: k * 200 }));
    const big = buildAnchors(many, 20000 * 28, manyBlocks, 20000 * 28 - 800, 4000 * 200 - 800);
    expect(mapScroll(big, 1000 * 5 * 28 + 70, "editor")).toBe(1000 * 200 + 100);
    expect(mapScroll(big, 1000 * 200 + 100, "preview")).toBe(1000 * 5 * 28 + 70);
  });
});

describe("anchorLineOf", () => {
  it("the first line that is not blank; a blank block keeps its first line", () => {
    expect(anchorLineOf(["a", "", "", "text", "more"], 1, 5)).toBe(3);
    expect(anchorLineOf(["", "  ", ""], 0, 3)).toBe(0);
  });
});

describe("parseBlocksWithLines", () => {
  const body = [
    "# Title", // 0
    "", // 1
    "text", // 2
    "```js", // 3
    "code", // 4
    "```", // 5
    "$$", // 6
    "x^2", // 7
    "$$", // 8
    "| a | b |", // 9
    "|---|---|", // 10
    "| 1 | 2 |", // 11
    "- [ ] task", // 12
    "- [x] done", // 13
    "![](attachment:0190e4b0-0000-7000-8000-000000000001)", // 14
    "- one", // 15
    "- two", // 16
    "1. first", // 17
    "> quote", // 18
    "", // 19
    "---", // 20
    "", // 21
    "end", // 22
  ].join("\n");

  it("every block has its source lines, every line is in one block, in order", () => {
    const { blocks, lines } = parseBlocksWithLines(body, { canvas: true });
    expect(blocks.map((b) => b.kind)).toEqual(["heading", "paragraph", "codeblock", "math", "table", "task", "image", "list", "list", "quote", "paragraph", "hr", "paragraph"]);
    expect(lines).toEqual([
      { from: 0, to: 1 },
      { from: 1, to: 3 },
      { from: 3, to: 6 },
      { from: 6, to: 9 },
      { from: 9, to: 12 },
      { from: 12, to: 14 },
      { from: 14, to: 15 },
      { from: 15, to: 17 },
      { from: 17, to: 18 },
      { from: 18, to: 19 },
      { from: 19, to: 20 },
      { from: 20, to: 21 },
      { from: 21, to: 23 },
    ]);
  });

  it("parseBlocks gives the same blocks", async () => {
    const { parseBlocks } = await import("../src/ui/markdown");
    expect(parseBlocks(body, { canvas: true })).toEqual(parseBlocksWithLines(body, { canvas: true }).blocks);
  });
});
