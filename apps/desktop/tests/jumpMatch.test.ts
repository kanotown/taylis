/** M37: the jump-match rule (MOBILE_UI.md §6.2) against the cases every client shares (apps/shared/jump-match.json). */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { type JumpItem, matchScore, normalizeName, rankItems } from "../src/ui/jumpMatch";

interface Vectors {
  normalize: Array<{ input: string; output: string }>;
  score: Array<{ query: string; names: string[]; score: 0 | 1 | 2 | null }>;
  rank: { items: JumpItem[]; cases: Array<{ query: string; ids: string[] }> };
}

const vectors = JSON.parse(readFileSync(new URL("../../shared/jump-match.json", import.meta.url), "utf8")) as Vectors;

describe("jump-match (apps/shared/jump-match.json)", () => {
  it.each(vectors.normalize)("normalize $input", ({ input, output }) => {
    expect(normalizeName(input)).toBe(output);
  });

  it.each(vectors.score)("score $query in $names", ({ query, names, score }) => {
    expect(matchScore(query, names)).toBe(score);
  });

  it.each(vectors.rank.cases)("rank $query", ({ query, ids }) => {
    expect(rankItems(query, vectors.rank.items).map((item) => item.id)).toEqual(ids);
  });

  it("has cases for each part", () => {
    expect(vectors.normalize.length).toBeGreaterThan(0);
    expect(vectors.score.length).toBeGreaterThan(0);
    expect(vectors.rank.cases.length).toBeGreaterThan(0);
  });
});

describe("jump-match, beyond the shared cases", () => {
  it("a word starts after ・ and an ideographic space; katakana and half-width forms meet hiragana", () => {
    expect(matchScore("しんちょく", ["M2・シンチョク"])).toBe(1);
    expect(matchScore("会議", ["定例　会議"])).toBe(1);
    expect(matchScore("ｼﾝ", ["しんちょく"])).toBe(0);
  });

  it("the best of the names counts, and ties go by unread, then the title in code-unit order", () => {
    const items: JumpItem[] = [
      { id: "b", title: "beta", names: ["beta", "xa"] },
      { id: "a", title: "alpha", names: ["xa-alpha"] },
      { id: "c", title: "gamma", names: ["a-gamma"], unread: true },
    ];
    // a: "xa-alpha" starts a word with "a" (1); b: contains "a" (2); c: starts with "a" (0).
    expect(rankItems("a", items).map((i) => i.id)).toEqual(["c", "a", "b"]);
    expect(rankItems("zz", items)).toEqual([]);
    expect(rankItems("  ", items)).toEqual([]);
  });
});
