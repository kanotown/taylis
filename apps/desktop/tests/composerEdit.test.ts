import { describe, expect, it } from "vitest";

import { changedRange, clusterRange, continueStructure, indentListLine, insertLink, insideFence, linkFromPaste, toggleFence, toggleLinePrefix, toggleWrap } from "../src/ui/composerEdit";

describe("composer markdown helpers", () => {
  it("wraps, unwraps and inserts empty marker pairs", () => {
    expect(toggleWrap({ text: "make it bold", start: 8, end: 12 }, "**")).toEqual({ text: "make it **bold**", start: 10, end: 14 });
    expect(toggleWrap({ text: "make it **bold**", start: 10, end: 14 }, "**")).toEqual({ text: "make it bold", start: 8, end: 12 });
    expect(toggleWrap({ text: "make it **bold**", start: 8, end: 16 }, "**")).toEqual({ text: "make it bold", start: 8, end: 12 });
    expect(toggleWrap({ text: "ab", start: 1, end: 1 }, "`")).toEqual({ text: "a``b", start: 2, end: 2 });
  });

  it("fences a selection on its own lines", () => {
    expect(toggleFence({ text: "x = 1", start: 0, end: 5 })).toEqual({ text: "```\nx = 1\n```", start: 4, end: 9 });
    expect(toggleFence({ text: "before code after", start: 7, end: 11 }).text).toBe("before \n```\ncode\n```\n after");
  });

  it("toggles line prefixes for quotes and lists", () => {
    expect(toggleLinePrefix({ text: "a\nb", start: 0, end: 3 }, "> ")).toEqual({ text: "> a\n> b", start: 2, end: 7 });
    expect(toggleLinePrefix({ text: "> a\n> b", start: 2, end: 7 }, "> ")).toEqual({ text: "a\nb", start: 0, end: 3 });
    expect(toggleLinePrefix({ text: "one\ntwo", start: 0, end: 7 }, (i) => `${i + 1}. `).text).toBe("1. one\n2. two");
    expect(toggleLinePrefix({ text: "1. one\n2. two", start: 0, end: 13 }, (i) => `${i + 1}. `).text).toBe("one\ntwo");
  });

  it("inserts a link template and selects the url", () => {
    expect(insertLink({ text: "see docs", start: 4, end: 8 })).toEqual({ text: "see [docs](https://)", start: 11, end: 19 });
  });

  it("knows when the caret is inside a code fence", () => {
    expect(insideFence("```\ncode", 8)).toBe(true);
    expect(insideFence("```\ncode\n```\n", 13)).toBe(false);
    expect(insideFence("text with ``` inline", 20)).toBe(false);
  });

  it("continues lists and quotes on Enter and ends them on an empty item", () => {
    expect(continueStructure({ text: "- one", start: 5, end: 5 })).toEqual({ text: "- one\n- ", start: 8, end: 8 });
    expect(continueStructure({ text: "1. one", start: 6, end: 6 })).toEqual({ text: "1. one\n2. ", start: 10, end: 10 });
    expect(continueStructure({ text: "- one\n- ", start: 8, end: 8 })).toEqual({ text: "- one\n", start: 6, end: 6 });
    expect(continueStructure({ text: "> q", start: 3, end: 3 })).toEqual({ text: "> q\n> ", start: 6, end: 6 });
    expect(continueStructure({ text: "plain", start: 5, end: 5 })).toBeNull();
  });

  it("indents and outdents list lines with Tab", () => {
    expect(indentListLine({ text: "- a", start: 3, end: 3 }, false)).toEqual({ text: "  - a", start: 5, end: 5 });
    expect(indentListLine({ text: "  - a", start: 5, end: 5 }, true)).toEqual({ text: "- a", start: 3, end: 3 });
    expect(indentListLine({ text: "plain", start: 2, end: 2 }, false)).toBeNull();
  });

  it("finds the smallest replaced range, so a format goes through the browser's editing (and its undo) as one step", () => {
    const apply = (before: string, r: { start: number; end: number; text: string }) => before.slice(0, r.start) + r.text + before.slice(r.end);
    const cases: Array<[string, string]> = [
      ["ab", "a****b"],
      ["make it bold", "make it **bold**"],
      ["a\nb", "> a\n> b"],
      ["- item", "- item\n- "],
      ["- ", ""],
      ["same", "same"],
      ["😀", "😃"], // the same high surrogate: the whole emoji is replaced, never half of it
      ["x😀y", "x😀😀y"],
    ];
    for (const [before, after] of cases) expect(apply(before, changedRange(before, after))).toBe(after);
    expect(changedRange("ab", "a****b")).toEqual({ start: 1, end: 1, text: "****" });
    expect(changedRange("- item", "- item\n- ")).toEqual({ start: 6, end: 6, text: "\n- " });
    expect(changedRange("same", "same")).toEqual({ start: 4, end: 4, text: "" });
    expect(changedRange("😀", "😃")).toEqual({ start: 0, end: 2, text: "😃" });
    expect(changedRange("a😀", "a😀b😀")).toEqual({ start: 3, end: 3, text: "b😀" });
  });

  it("widens the range to whole clusters, as the browser deletes them (a task marker's stand-in, v0.1.21 check)", () => {
    const tag = "\u{E0020}"; // a canvas task marker's stand-in (canvasMarkers.ts): it clusters with the character before
    // Backspace beside the stand-in removes 約 and keeps the stand-in: the browser gets 「約 + stand-in」 → 「stand-in」.
    expect(changedRange(`- [ ] 予約${tag}\n`, `- [ ] 予${tag}\n`)).toEqual({ start: 7, end: 8, text: "" });
    expect(clusterRange(`- [ ] 予約${tag}\n`, `- [ ] 予${tag}\n`)).toEqual({ start: 7, end: 10, text: tag });
    // Combining marks and ZWJ emoji too; ranges on cluster boundaries stay as they were.
    expect(clusterRange("café!", "cafe!")).toEqual({ start: 3, end: 5, text: "e" });
    expect(clusterRange("a👩‍💻b", "ab")).toEqual(changedRange("a👩‍💻b", "ab"));
    expect(clusterRange("ab", "a****b")).toEqual({ start: 1, end: 1, text: "****" });
    expect(clusterRange("same", "same")).toEqual({ start: 4, end: 4, text: "" });
    const apply = (before: string, r: { start: number; end: number; text: string }) => before.slice(0, r.start) + r.text + before.slice(r.end);
    const pairs: Array<[string, string]> = [[`x約${tag}y`, `x${tag}y`], [`約${tag}`, `約${tag}約`], ["éé", "é"]];
    for (const [before, after] of pairs) {
      expect(apply(before, clusterRange(before, after))).toBe(after);
    }
  });

  it("links selected text when a single http(s) URL is pasted over it", () => {
    expect(linkFromPaste({ text: "read this now", start: 5, end: 9 }, "https://example.com/x")).toEqual({ text: "read [this](https://example.com/x) now", start: 34, end: 34 });
    // Spaces a double-click took stay outside the brackets; the clipboard's own spaces and newline go.
    expect(linkFromPaste({ text: "read this now", start: 5, end: 10 }, " https://example.com\n")).toEqual({ text: "read [this](https://example.com) now", start: 32, end: 32 });
    expect(linkFromPaste({ text: "日本語のリンク", start: 4, end: 7 }, "http://example.jp")?.text).toBe("日本語の[リンク](http://example.jp)");
  });

  it("leaves a paste alone when it should replace the selection as usual", () => {
    const url = "https://example.com";
    expect(linkFromPaste({ text: "abc", start: 1, end: 1 }, url)).toBeNull(); // no selection
    expect(linkFromPaste({ text: "abc", start: 0, end: 3 }, "not a url")).toBeNull();
    expect(linkFromPaste({ text: "abc", start: 0, end: 3 }, "mailto:a@example.com")).toBeNull();
    expect(linkFromPaste({ text: "abc", start: 0, end: 3 }, "https://a.example https://b.example")).toBeNull();
    expect(linkFromPaste({ text: "abc", start: 0, end: 3 }, "https://example.com/a_(b)")).toBeNull(); // the renderer stops at ")"
    expect(linkFromPaste({ text: "https://old.example", start: 0, end: 19 }, url)).toBeNull(); // a URL selected
    expect(linkFromPaste({ text: "a\nb", start: 0, end: 3 }, url)).toBeNull(); // over lines
    expect(linkFromPaste({ text: "[x](https://y.example)", start: 0, end: 22 }, url)).toBeNull(); // a link already
    expect(linkFromPaste({ text: "a [b] c", start: 0, end: 7 }, url)).toBeNull(); // brackets would break the label
    expect(linkFromPaste({ text: "a   b", start: 1, end: 4 }, url)).toBeNull(); // only spaces
  });
});
