/** M44: the history's comparison of two canvas versions (lines, and the words of a line touched up). */
import { describe, expect, it } from "vitest";

import { diffCounts, diffLines, diffRows, wordDiff, words } from "../src/ui/canvasDiff";

const kinds = (before: string, after: string) => diffLines(before, after).map((l) => `${l.kind === "same" ? " " : l.kind === "add" ? "+" : "-"}${l.text}`);

describe("diffLines", () => {
  it("keeps, adds and removes lines, with their numbers", () => {
    expect(kinds("a\nb\nc", "a\nc\nd")).toEqual([" a", "-b", " c", "+d"]);
    const lines = diffLines("a\nb\nc", "a\nc\nd");
    expect(lines.map((l) => [l.oldNo, l.newNo])).toEqual([[1, 1], [2, null], [3, 2], [null, 3]]);
    expect(diffCounts(lines)).toEqual({ added: 1, removed: 1 });
  });

  it("an empty side is all added / all removed", () => {
    expect(kinds("", "x\ny")).toEqual(["+x", "+y"]);
    expect(kinds("x\ny", "")).toEqual(["-x", "-y"]);
    expect(kinds("same", "same")).toEqual([" same"]);
  });

  it("finds the shortest script among repeated lines", () => {
    const before = ["- [ ] a", "- [ ] b", "- [ ] a", "- [ ] b"].join("\n");
    const after = ["- [ ] a", "- [ ] b", "- [ ] c", "- [ ] a", "- [ ] b"].join("\n");
    expect(diffCounts(diffLines(before, after))).toEqual({ added: 1, removed: 0 });
  });

  it("a line touched up shows the words that changed (Japanese without spaces)", () => {
    const lines = diffLines("# 議事録\n来週までに研究計画を提出する。", "# 議事録\n来週までに予稿を提出する。");
    const del = lines.find((l) => l.kind === "del")!;
    const add = lines.find((l) => l.kind === "add")!;
    expect(del.words?.filter((w) => w.changed).map((w) => w.text)).toEqual(["研究計画"]);
    expect(add.words?.filter((w) => w.changed).map((w) => w.text)).toEqual(["予稿"]);
    expect(add.words?.map((w) => w.text).join("")).toBe("来週までに予稿を提出する。");
  });

  it("a tick is one word; a line rewritten entirely has no word view", () => {
    const [del, add] = diffLines("- [ ] 旅費申請", "- [x] 旅費申請");
    expect(del!.words?.filter((w) => w.changed).map((w) => w.text)).toEqual([" "]);
    expect(add!.words?.filter((w) => w.changed).map((w) => w.text)).toEqual(["x"]);
    expect(wordDiff("全く別の内容です", "Completely different text")).toBeNull();
  });

  it("a large rewrite stays correct (the middle as replaced)", () => {
    const before = Array.from({ length: 4000 }, (_, i) => `line ${i}`).join("\n");
    const after = Array.from({ length: 4000 }, (_, i) => `row ${i}`).join("\n");
    const started = performance.now();
    const counts = diffCounts(diffLines(before, after));
    expect(counts).toEqual({ added: 4000, removed: 4000 });
    expect(performance.now() - started).toBeLessThan(2_000);
  });
});

describe("words", () => {
  it("cuts by script, space and punctuation as the server's merge does", () => {
    expect(words("研究計画を来週までに提出する。")).toEqual(["研究計画", "を", "来週", "までに", "提出", "する", "。"]);
    expect(words("see PGroonga docs")).toEqual(["see", " ", "PGroonga", " ", "docs"]);
    expect(words("カタカナー漢字")).toEqual(["カタカナー", "漢字"]);
  });
});

describe("diffRows", () => {
  it("folds long stretches of kept lines", () => {
    const before = Array.from({ length: 20 }, (_, i) => `l${i}`).join("\n");
    const after = before.replace("l10", "L10");
    const rows = diffRows(diffLines(before, after), 2);
    expect(rows.map((r) => (r.kind === "skip" ? `…${r.count}` : r.kind === "same" ? r.text : `${r.kind}:${r.text}`))).toEqual(["…8", "l8", "l9", "del:l10", "add:L10", "l11", "l12", "…7"]);
  });
});
