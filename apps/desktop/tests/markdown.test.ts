import { describe, expect, it } from "vitest";

import { tokenize } from "../src/ui/markdown";

describe("message body tokenizer", () => {
  it("handles the inline subset, mentions, links and newlines", () => {
    const body = "hi *bold* and _it_ `code` <@00000000-0000-7000-8000-000000000001> <!channel>\nhttps://example.com/x?y=1 done";
    expect(tokenize(body)).toEqual([
      { kind: "text", text: "hi " },
      { kind: "bold", text: "bold" },
      { kind: "text", text: " and " },
      { kind: "italic", text: "it" },
      { kind: "text", text: " " },
      { kind: "code", text: "code" },
      { kind: "text", text: " " },
      { kind: "mention", userId: "00000000-0000-7000-8000-000000000001" },
      { kind: "text", text: " " },
      { kind: "mention_all", target: "channel" },
      { kind: "newline" },
      { kind: "link", url: "https://example.com/x?y=1" },
      { kind: "text", text: " done" },
    ]);
  });

  it("keeps code blocks verbatim and leaves unmatched markers as text", () => {
    expect(tokenize("```\nlet *x* = 1\n```")).toEqual([{ kind: "codeblock", text: "let *x* = 1" }]);
    expect(tokenize("a * b * c")).toEqual([{ kind: "text", text: "a " }, { kind: "bold", text: " b " }, { kind: "text", text: " c" }]);
    expect(tokenize("plain_text_here")).toEqual([{ kind: "text", text: "plain" }, { kind: "italic", text: "text" }, { kind: "text", text: "here" }]);
    expect(tokenize("<script>alert(1)</script>")).toEqual([{ kind: "text", text: "<script>alert(1)</script>" }]);
  });
});
