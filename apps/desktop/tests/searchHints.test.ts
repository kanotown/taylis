import { describe, expect, it } from "vitest";

import { appendModifier } from "../src/ui/searchHints";

describe("search hints (M15h)", () => {
  it("adds a modifier once, leaving open ones ready for typing", () => {
    expect(appendModifier("", "has:file")).toBe("has:file ");
    expect(appendModifier("仕様  ", "has:link")).toBe("仕様 has:link ");
    expect(appendModifier("仕様 has:link ", "has:link")).toBe("仕様 has:link ");
    expect(appendModifier("仕様", "from:@")).toBe("仕様 from:@");
    expect(appendModifier("", "in:#")).toBe("in:#");
  });
});
