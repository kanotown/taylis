import { describe, expect, it } from "vitest";

import { parseBlocks, plainText, tokenize, tokenizeInline } from "../src/ui/markdown";

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
    expect(tokenize("```\nlet *x* = 1\n```")).toEqual([{ kind: "codeblock", text: "let *x* = 1", lang: null }]);
    expect(tokenize("a * b * c")).toEqual([{ kind: "text", text: "a " }, { kind: "bold", text: " b " }, { kind: "text", text: " c" }]);
    expect(tokenize("plain_text_here")).toEqual([{ kind: "text", text: "plain" }, { kind: "italic", text: "text" }, { kind: "text", text: "here" }]);
    expect(tokenize("<script>alert(1)</script>")).toEqual([{ kind: "text", text: "<script>alert(1)</script>" }]);
  });
});


describe("light markdown blocks", () => {
  it("parses quotes, lists, fences with a language and paragraphs in order", () => {
    const body = ["plan:", "- one **strong**", "- two", "  - nested", "1. first", "2. second", "> quoted _q_", "> more", "```ts", "const x = 1;", "```", "tail ~~gone~~ [docs](https://example.com/d)"].join("\n");
    const blocks = parseBlocks(body);
    expect(blocks.map((b) => b.kind)).toEqual(["paragraph", "list", "list", "quote", "codeblock", "paragraph"]);
    expect(blocks[1]).toEqual({
      kind: "list",
      ordered: false,
      start: 1,
      items: [
        { level: 0, tokens: [{ kind: "text", text: "one " }, { kind: "bold", text: "strong" }] },
        { level: 0, tokens: [{ kind: "text", text: "two" }] },
        { level: 1, tokens: [{ kind: "text", text: "nested" }] },
      ],
    });
    expect(blocks[2]).toMatchObject({ kind: "list", ordered: true, start: 1 });
    expect(blocks[3]).toEqual({ kind: "quote", lines: [[{ kind: "text", text: "quoted " }, { kind: "italic", text: "q" }], [{ kind: "text", text: "more" }]] });
    expect(blocks[4]).toEqual({ kind: "codeblock", text: "const x = 1;", lang: "ts" });
    expect(blocks[5]).toEqual({
      kind: "paragraph",
      lines: [[{ kind: "text", text: "tail " }, { kind: "strike", text: "gone" }, { kind: "text", text: " " }, { kind: "link", url: "https://example.com/d", label: "docs" }]],
    });
  });

  it("parses up to three heading levels and leaves deeper or bare hashes alone", () => {
    expect(parseBlocks("# Title\n## Sub **b**\n### Third\n#### not\n#nospace")).toEqual([
      { kind: "heading", level: 1, tokens: [{ kind: "text", text: "Title" }] },
      { kind: "heading", level: 2, tokens: [{ kind: "text", text: "Sub " }, { kind: "bold", text: "b" }] },
      { kind: "heading", level: 3, tokens: [{ kind: "text", text: "Third" }] },
      { kind: "paragraph", lines: [[{ kind: "text", text: "#### not" }], [{ kind: "text", text: "#nospace" }]] },
    ]);
  });

  it("keeps unterminated fences and stray markers as text", () => {
    expect(parseBlocks("```\nopen")).toEqual([{ kind: "paragraph", lines: [[{ kind: "text", text: "```" }], [{ kind: "text", text: "open" }]] }]);
    expect(tokenizeInline("2 * 3 = 6")).toEqual([{ kind: "text", text: "2 * 3 = 6" }]);
    expect(tokenizeInline("**both** and *slack*")).toEqual([{ kind: "bold", text: "both" }, { kind: "text", text: " and " }, { kind: "bold", text: "slack" }]);
  });

  it("tokenize() still reports fenced code with its language", () => {
    expect(tokenize("```py\nprint(1)\n```")).toEqual([{ kind: "codeblock", text: "print(1)", lang: "py" }]);
    expect(tokenize("```\nlet *x* = 1\n```")).toEqual([{ kind: "codeblock", text: "let *x* = 1", lang: null }]);
  });
});

describe("plain text for notifications", () => {
  it("drops markdown markers and joins lines", () => {
    expect(plainText("# 今日\n- **太字** と `code`\n> 引用 [docs](https://example.com/d)\n```ts\nlet x = 1;\n```")).toBe("今日 太字 と code 引用 docs let x = 1;");
    expect(plainText("a".repeat(300)).length).toBe(200);
  });
});

describe("group mention tokens (M12k)", () => {
  it("tokenises <@group:id> separately from user mentions", () => {
    const tokens = tokenize("<@group:00000000-0000-7000-8000-00000000000a> and <@00000000-0000-7000-8000-000000000001>");
    expect(tokens.map((t) => t.kind)).toEqual(["mention_group", "text", "mention"]);
    expect(tokens[0]).toEqual({ kind: "mention_group", groupId: "00000000-0000-7000-8000-00000000000a" });
  });
});
