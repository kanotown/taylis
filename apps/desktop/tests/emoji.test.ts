import { describe, expect, it } from "vitest";

import { completeEmoji, emojiByShortcode, emojiCandidates, emojiQuery, replaceShortcodes, searchEmoji } from "../src/ui/emoji";

describe("emoji shortcodes (M11f)", () => {
  it("replaces known shortcodes and leaves the rest alone", () => {
    expect(replaceShortcodes("done :tada: :+1:")).toBe("done 🎉 👍");
    expect(replaceShortcodes("time is 10:30 and :unknown_thing: stays")).toBe("time is 10:30 and :unknown_thing: stays");
    expect(replaceShortcodes("no colons")).toBe("no colons");
    expect(emojiByShortcode("bento")?.glyph).toBe("🍱");
  });

  it("detects the query before the caret", () => {
    expect(emojiQuery("hello :ta", 9)).toEqual({ start: 6, query: "ta" });
    expect(emojiQuery("hello :t", 8)).toBeNull(); // one character is too little
    expect(emojiQuery("10:30", 5)).toBeNull(); // not at a word start
    expect(emojiQuery("(:sm", 4)).toEqual({ start: 1, query: "sm" });
    expect(emojiQuery("hello :tada: done", 5)).toBeNull();
  });

  it("ranks shortcode prefixes before keyword matches and searches in Japanese", () => {
    expect(emojiCandidates("ta").map((e) => e.shortcode)).toContain("tada");
    expect(emojiCandidates("ta")[0]!.shortcode.startsWith("ta")).toBe(true);
    expect(emojiCandidates("弁当")[0]!.glyph).toBe("🍱");
    expect(searchEmoji("").length).toBeGreaterThan(200);
    expect(searchEmoji("乾杯").map((e) => e.glyph)).toContain("🍻");
  });

  it("completes the query with the glyph and moves the caret", () => {
    expect(completeEmoji("hi :tad", 3, 7, "🎉")).toEqual({ text: "hi 🎉 ", caret: 3 + "🎉".length + 1 });
    expect(completeEmoji(":sm rest", 0, 3, "😄")).toEqual({ text: "😄  rest", caret: "😄".length + 1 });
  });

  it("has the full standard set (2026-10-04: no 🎓): found in Japanese and English; the old shortcodes stay", () => {
    expect(searchEmoji("").length).toBeGreaterThan(1800);
    for (const word of ["卒業", "graduation", "academic", "帽子", "mortar_board"]) expect(searchEmoji(word).map((e) => e.glyph)).toContain("🎓");
    expect(emojiByShortcode("mortar_board")?.glyph).toBe("🎓");
    expect(searchEmoji("日本").map((e) => e.glyph)).toContain("🇯🇵");
    // Shortcodes of the hand-made list (in old messages as `:name:`) still show.
    expect(replaceShortcodes(":smile: :heart: :bento: :+1:")).toBe("😄 ❤️ 🍱 👍");
    // No skin-tone variants as separate cells (as before).
    expect(searchEmoji("").some((e) => /[\u{1F3FB}-\u{1F3FF}]/u.test(e.glyph))).toBe(false);
  });
});
