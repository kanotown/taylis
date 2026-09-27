import { describe, expect, it } from "vitest";

import { splitKeywords } from "../src/ui/keywords";

describe("notification keywords (M12g)", () => {
  it("marks case-insensitive hits and leaves other text alone", () => {
    expect(splitKeywords("ボブさん、DEPLOY 手順を確認", ["ボブ", "deploy"])).toEqual(["", { hit: "ボブ" }, "さん、", { hit: "DEPLOY" }, " 手順を確認"].filter((p) => p !== ""));
    expect(splitKeywords("nothing here", ["deploy"])).toEqual(["nothing here"]);
    expect(splitKeywords("a.b matches a.b not aXb", ["a.b"])).toEqual([{ hit: "a.b" }, " matches ", { hit: "a.b" }, " not aXb"]);
    expect(splitKeywords("", ["x"])).toEqual([""]);
  });
});
