import { describe, expect, it } from "vitest";

import { highlightPieces, keywordRanges } from "../src/ui/highlight";

describe("search highlighting", () => {
  it("finds every occurrence case-insensitively and merges overlaps", () => {
    expect(keywordRanges("Tokyo rain, tokyo sun", ["tokyo"])).toEqual([
      [0, 5],
      [12, 17],
    ]);
    expect(keywordRanges("東京の天気", ["東京", "の天", "天気"])).toEqual([[0, 5]]);
    expect(keywordRanges("nothing", ["", "zzz"])).toEqual([]);
    expect(highlightPieces("a東京b", ["東京"])).toEqual([
      { text: "a", hit: false },
      { text: "東京", hit: true },
      { text: "b", hit: false },
    ]);
  });
});
