/**
 * M187 (docs/MOBILE_UI.md §30): the `@` / `:` completions shared by the composer and the inline edit box
 * (ui/completion.ts), and the text-area helpers the two share (ui/composerEdit.ts).
 */
import { describe, expect, it } from "vitest";

import { completeAt, completionKey, completionQueries, emojiCompletions, emojiInsert, mentionInsert, moveActive, takenAfter } from "../src/ui/completion";
import { insertMentionMark, markdownShortcut, mentionMark } from "../src/ui/composerEdit";

const custom = (name: string, label: string | null = null, keywords: string[] = []) => ({ name, label, keywords });

describe("completionQueries", () => {
  it("reads before the caret: a mention first, else an emoji", () => {
    expect(completionQueries({ text: "hi @bo", caret: 6 })).toEqual({ mention: { start: 3, query: "bo" }, emoji: null });
    expect(completionQueries({ text: "hi :tad and more", caret: 7 })).toEqual({ mention: null, emoji: { start: 3, query: "tad" } });
    // What follows the caret is not read: the word before it is completed in the middle of the text.
    expect(completionQueries({ text: "確認 @an さん", caret: 6 }).mention).toEqual({ start: 3, query: "an" });
    expect(completionQueries({ text: "hi @bo", caret: 2 })).toEqual({ mention: null, emoji: null });
  });

  it("reads nothing without a text (a selection, the rich editor in code)", () => {
    expect(completionQueries(null)).toEqual({ mention: null, emoji: null });
  });
});

describe("completionKey", () => {
  it("names what is typed, else the owner's own list", () => {
    expect(completionKey({ mention: { start: 3, query: "bo" }, emoji: null }, "/x")).toBe("@3:bo");
    expect(completionKey({ mention: null, emoji: { start: 0, query: "ta" } }, "/x")).toBe(":0:ta");
    expect(completionKey({ mention: null, emoji: null }, "/st")).toBe("/st");
    expect(completionKey({ mention: null, emoji: null })).toBe("");
  });
});

describe("emojiCompletions", () => {
  it("puts the workspace's emoji first, by name, label or keyword, 8 in all", () => {
    const mine = new Map([
      ["tada-party", custom("tada-party")],
      ["hpd-bow", custom("hpd-bow", "おじぎ", ["ありがとう"])],
    ]);
    const hits = emojiCompletions("tada", mine);
    expect(hits[0]).toMatchObject({ shortcode: "tada-party", glyph: ":tada-party:", category: "custom" });
    expect(hits.some((entry) => entry.glyph === "🎉")).toBe(true);
    expect(emojiCompletions("ありがとう", mine)[0]?.glyph).toBe(":hpd-bow:");
    expect(emojiCompletions("s", new Map()).length).toBeLessThanOrEqual(8);
    expect(emojiCompletions("smile", new Map())).toHaveLength(8);
  });
});

describe("completeAt", () => {
  it("replaces the query, keeps the text after the caret and puts the caret after the insert", () => {
    expect(completeAt("hi @bo", 3, 6, mentionInsert("bob"))).toEqual({ text: "hi @bob ", caret: 8 });
    expect(completeAt("a :tad b", 2, 6, emojiInsert("🎉"))).toEqual({ text: "a 🎉  b", caret: 5 });
  });

  it("with reuseSpace (the edit box) takes a space after the caret as the pick's own, the caret after it", () => {
    expect(completeAt("a :tad b", 2, 6, emojiInsert("🎉"), true)).toEqual({ text: "a 🎉 b", caret: 5 });
    expect(completeAt("x @an さん", 2, 5, mentionInsert("android2"), true)).toEqual({ text: "x @android2 さん", caret: 12 });
    // No space after the caret (a word, a line's end, the text's end): the pick's own space as in the composer.
    expect(completeAt("x @anさん", 2, 5, mentionInsert("android2"), true)).toEqual({ text: "x @android2 さん", caret: 12 });
    expect(completeAt("確認 @an\nさん", 3, 6, mentionInsert("android2"), true)).toEqual({ text: "確認 @android2 \nさん", caret: 13 });
    expect(completeAt("x @an", 2, 5, mentionInsert("android2"), true)).toEqual({ text: "x @android2 ", caret: 12 });
  });

  it("takenAfter is what the rich editor replaces after its caret", () => {
    expect(takenAfter("@bob ", " rest", true)).toBe(1);
    expect(takenAfter("@bob ", " rest", false)).toBe(0);
    expect(takenAfter("@bob ", "", true)).toBe(0);
    expect(takenAfter("@bob ", "\nrest", true)).toBe(0);
  });
});

describe("moveActive", () => {
  it("moves with the arrows, wrapping round", () => {
    expect(moveActive("ArrowDown", 0, 3)).toBe(1);
    expect(moveActive("ArrowDown", 2, 3)).toBe(0);
    expect(moveActive("ArrowUp", 0, 3)).toBe(2);
    expect(moveActive("Enter", 0, 3)).toBeNull();
    expect(moveActive("ArrowDown", 0, 0)).toBeNull();
  });
});

describe("the 「@」 button and the format shortcuts (composerEdit.ts)", () => {
  it("puts @ at the caret, after a space when a word ends there", () => {
    expect(mentionMark("")).toBe("@");
    expect(mentionMark("hi ")).toBe("@");
    expect(mentionMark("hi")).toBe(" @");
    expect(insertMentionMark({ text: "hi there", start: 2, end: 2 })).toEqual({ text: "hi @ there", start: 4, end: 4 });
    expect(insertMentionMark({ text: "hi xx", start: 3, end: 5 })).toEqual({ text: "hi @", start: 4, end: 4 });
  });

  it("maps ⌘B / ⌘I / ⌘⇧X / ⌘⇧C / ⌘⇧U to their formats", () => {
    const state = { text: "word", start: 0, end: 4 };
    expect(markdownShortcut("b", false)?.(state).text).toBe("**word**");
    expect(markdownShortcut("I", false)?.(state).text).toBe("_word_");
    expect(markdownShortcut("x", true)?.(state).text).toBe("~~word~~");
    expect(markdownShortcut("c", true)?.(state).text).toBe("`word`");
    expect(markdownShortcut("u", true)?.(state).text).toBe("[word](https://)");
    expect(markdownShortcut("u", false)).toBeNull();
    expect(markdownShortcut("b", true)).toBeNull();
    expect(markdownShortcut("x", false)).toBeNull();
  });
});
