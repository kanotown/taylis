import { describe, expect, it } from "vitest";

import { firstLink } from "../src/ui/links";

describe("first link of a body (M11g)", () => {
  it("finds the first http(s) URL outside code and trims trailing punctuation", () => {
    expect(firstLink("see https://example.com/a?b=1, then https://other.test")).toBe("https://example.com/a?b=1");
    expect(firstLink("日本語の文 https://example.com/x。")).toBe("https://example.com/x");
    expect(firstLink("(https://example.com/paren)")).toBe("https://example.com/paren");
    expect(firstLink("`https://code.example.com` and ```\nhttps://fenced.example.com\n``` none")).toBeNull();
    expect(firstLink("no links here")).toBeNull();
    expect(firstLink("[label](https://example.com/md)")).toBe("https://example.com/md");
  });
});
