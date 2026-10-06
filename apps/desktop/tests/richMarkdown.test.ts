import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { parseBlocks, tokenizeInline, type Block, type Token } from "../src/ui/markdown";
import { docToMarkdown, markdownToDoc, plainTextToNodes, type RichNode } from "../src/ui/richMarkdown";

const shared = (name: string) => JSON.parse(readFileSync(resolve(__dirname, "../../shared", name), "utf8"));
const ZWSP = "​";

/** What a reader sees of a body: blocks with their tokens, zero-width spaces and the link spelling left out. */
function rendered(body: string): unknown {
  const tokens = (list: readonly Token[]) => {
    const out: Array<[string, string, string?]> = [];
    for (const token of list) {
      let entry: [string, string, string?];
      if (token.kind === "link") entry = token.label ? ["link", token.label, token.url] : ["text", token.url];
      else if (token.kind === "mention") entry = ["text", `<@${token.userId}>`];
      else if (token.kind === "mention_group") entry = ["text", `<@group:${token.groupId}>`];
      else if (token.kind === "mention_all") entry = ["text", `<!${token.target}>`];
      else if (token.kind === "newline") entry = ["text", "\n"];
      else entry = [token.kind, token.text];
      entry[1] = entry[1].split(ZWSP).join("");
      const last = out.at(-1);
      if (entry[0] === "text" && last?.[0] === "text") last[1] += entry[1];
      else if (entry[1]) out.push(entry);
    }
    return out;
  };
  const line = (list: readonly Token[]) => {
    const t = tokens(list);
    return t.length === 1 && t[0]![0] === "text" && t[0]![1].trim() === "" ? [] : t;
  };
  return parseBlocks(body).map((block: Block) => {
    switch (block.kind) {
      case "paragraph":
        return ["p", block.lines.map(line)];
      case "quote":
        return ["quote", block.lines.map(line)];
      case "heading":
        return ["h", block.level, tokens(block.tokens)];
      case "list":
        return ["list", block.items.map((item) => [item.level, item.marker, tokens(item.tokens)])];
      case "codeblock":
        return ["code", block.lang, block.text];
      case "table":
        return ["table", block.align, block.header.map(tokens), block.rows.map((row) => row.map(tokens))];
      default:
        return [block.kind];
    }
  });
}

const roundTrip = (markdown: string) => docToMarkdown(markdownToDoc(markdown));

const samples: string[] = [
  ...shared("inline-format.json").cases.map((c: { line: string }) => c.line),
  ...shared("inline-format.json").code_blocks.map((c: { body: string }) => c.body),
  ...shared("lists.json").cases.map((c: { body: string }) => c.body),
  ...shared("body-paragraphs.json").cases.map((c: { body: string }) => c.body),
  ...shared("dm-preview.json").cases?.map?.((c: { body?: string }) => c.body ?? "").filter(Boolean) ?? [],
  "plain text",
  "",
  "a\nb\n\nc",
  "\n\nleading and trailing\n\n",
  "**bold** and *also bold* and _italic_ and ~~strike~~ and `code`",
  "これは _強調_ です。これは**太字**です",
  "snake_case_name and __init__ and a*b*c",
  "[ラベル](https://example.com/a_b) と https://example.com/x_y_z と mail first_last@example.com",
  "# 見出し\n## 二\n### 三\n#### 四は文字",
  "> 引用 1\n> 引用 _2_\n>\n> 3\n\nあと",
  "> a\n\n> b",
  "- a\n- b\n  - c\n    - d\n      - e\n- f",
  "1. 一\n1. 二\n1. 三",
  "3. three\n4. four\n- bullet after\n\n7. again",
  "1. 準備\n  - 箇条\n  - 箇条\n  1. 番号\n2. 当日",
  "- a\nb\n- c",
  "```python\nprint('a_b')\n**not bold**\n```\nafter",
  "```\nunclosed fence",
  "| a | b |\n| :-- | --: |\n| `x` | **y** \\| z |\n| 1 |",
  "数式 $a_b$ と $$x_1 + y_1$$ はそのまま",
  "<@11111111-1111-4111-8111-111111111111> さん <!channel> <@group:22222222-2222-4222-8222-222222222222>",
  "¯\\_(ツ)_/¯ and \\*escaped\\* and \\_x\\_",
  "``a ` b`` and `` ` ``",
  "* not a list*",
  "trailing spaces  \n  indented line",
  "絵文字 :tada: と 😀",
  "a\n\n\n\nb",
  "- \n- x",
];

describe("rich composer Markdown round trip", () => {
  it.each(samples.map((s) => [JSON.stringify(s).slice(0, 60), s]))("%s is stable and renders the same", (_name, markdown) => {
    const once = roundTrip(markdown);
    expect(roundTrip(once)).toBe(once);
    expect(rendered(once)).toEqual(rendered(markdown));
  });

  it("keeps ordinary bodies exactly", () => {
    for (const body of [
      "plain text",
      "a\nb\n\nc",
      "**bold** and _italic_ and ~~strike~~ and `code`",
      "snake_case_name and __init__",
      "https://example.com/a_b_c",
      "これは _強調_ です",
      "# 見出し\n- a\n  - b\n1. x\n2. y\n> q",
      "```js\nconst a_b = 1;\n```",
      "数式 $a_b$ と $x_1 + y_1$",
      "[label](https://example.com)",
    ]) expect(roundTrip(body)).toBe(body);
  });

  it("normalises spellings that render the same", () => {
    expect(roundTrip("*bold*")).toBe("**bold**");
    expect(roundTrip("1. a\n1. b\n1. c")).toBe("1. a\n2. b\n3. c");
    expect(roundTrip("-   a\n    - b")).toBe("- a\n  - b");
    expect(roundTrip("[https://a.example/x](https://a.example/x)")).toBe("https://a.example/x");
  });
});

const doc = (...content: RichNode[]): RichNode => ({ type: "doc", content });
const p = (...content: RichNode[]): RichNode => ({ type: "paragraph", ...(content.length ? { content } : {}) });
const text = (value: string, ...marks: string[]): RichNode => ({ type: "text", text: value, ...(marks.length ? { marks: marks.map((type) => ({ type })) } : {}) });

describe("rich composer serialisation", () => {
  it("escapes typed markers only where they would format", () => {
    const literal = docToMarkdown(doc(p(text("*not bold* and _not italic_ and ~~no~~ and `no`"))));
    expect(tokenizeInline(literal)).toEqual([{ kind: "text", text: "*not bold* and _not italic_ and ~~no~~ and `no`" }]);
    expect(docToMarkdown(doc(p(text("a_b and 2*3 and snake_case"))))).toBe("a_b and 2*3 and snake_case");
    expect(docToMarkdown(doc(p(text("see https://x.example/_a_ now"))))).toBe("see https://x.example/_a_ now");
  });

  it("keeps a typed block marker as text with a zero-width space", () => {
    for (const line of ["- not a list", "1. not numbered", "> not a quote", "# not a heading", "```"]) {
      const out = docToMarkdown(doc(p(text(line))));
      expect(out).toBe(ZWSP + line);
      expect(parseBlocks(out)[0]!.kind).toBe("paragraph");
    }
    // Inside a quote, a list item or a heading the renderer reads the text inline: nothing added.
    expect(docToMarkdown(doc({ type: "blockquote", content: [p(text("- x"))] }))).toBe("> - x");
    expect(docToMarkdown(doc({ type: "bulletList", content: [{ type: "listItem", content: [p(text("> y"))] }] }))).toBe("- > y");
  });

  it("does not let a paragraph under a piped line become a table", () => {
    const out = docToMarkdown(doc(p(text("a | b")), p(text("--- | ---"))));
    expect(parseBlocks(out).map((b) => b.kind)).toEqual(["paragraph"]);
  });

  it("writes italic inside a Japanese sentence with word boundaries", () => {
    const out = docToMarkdown(doc(p(text("これは"), text("強調", "italic"), text("です"))));
    expect(out).toBe(`これは${ZWSP}_強調_${ZWSP}です`);
    expect(tokenizeInline(out).map((t) => t.kind)).toEqual(["text", "italic", "text"]);
    expect(roundTrip(out)).toBe(out);
    // The editor never sees the zero-width spaces.
    expect(JSON.stringify(markdownToDoc(out))).not.toContain(ZWSP);
  });

  it("moves spaces out of italic and writes one mark at a time", () => {
    expect(docToMarkdown(doc(p(text("a "), text(" b ", "italic"), text("c"))))).toBe("a  _b_ c");
    expect(docToMarkdown(doc(p(text("x", "bold", "italic"))))).toBe("**x**");
    expect(docToMarkdown(doc(p({ type: "text", text: "a*b", marks: [{ type: "bold" }] })))).toBe("**a\\*b**");
  });

  it("writes code with backticks inside and links", () => {
    expect(docToMarkdown(doc(p(text("a`b", "code"))))).toBe("`` a`b ``");
    expect(tokenizeInline("`` a`b ``")).toEqual([{ kind: "code", text: "a`b" }]);
    const link = (label: string, href: string): RichNode => ({ type: "text", text: label, marks: [{ type: "link", attrs: { href } }] });
    expect(docToMarkdown(doc(p(link("サイト", "https://example.com/a b(c)"))))).toBe("[サイト](https://example.com/a%20b%28c%29)");
    expect(docToMarkdown(doc(p(link("https://example.com", "https://example.com"))))).toBe("https://example.com");
    expect(docToMarkdown(doc(p(link("https://example.com", "https://example.com"), text("ja"))))).toBe("[https://example.com](https://example.com)ja");
    expect(docToMarkdown(doc(p(link("x", "javascript:alert(1)"))))).toBe("x");
  });

  it("writes lists, nesting and numbering", () => {
    const item = (label: string, ...nested: RichNode[]): RichNode => ({ type: "listItem", content: [p(text(label)), ...nested] });
    const out = docToMarkdown(doc({ type: "orderedList", attrs: { start: 3 }, content: [item("a", { type: "bulletList", content: [item("b"), item("c")] }), item("d")] }));
    expect(out).toBe("3. a\n  - b\n  - c\n4. d");
  });

  it("turns hard breaks into lines (paragraphs) and spaces (where the dialect has no line breaks)", () => {
    expect(docToMarkdown(doc(p(text("a"), { type: "hardBreak" }, text("b"))))).toBe("a\nb");
    expect(docToMarkdown(doc({ type: "heading", attrs: { level: 2 }, content: [text("a"), { type: "hardBreak" }, text("b")] }))).toBe("## a b");
  });

  it("reads pasted plain text as literal lines", () => {
    expect(docToMarkdown(doc(...plainTextToNodes("**x**\n\n- y")))).toBe(`\\*\\*x\\*\\*\n\n${ZWSP}- y`.replace("\\*\\*x\\*\\*", docToMarkdown(doc(p(text("**x**"))))));
    expect(tokenizeInline(docToMarkdown(doc(p(text("**x**"))))).map((t) => t.kind)).toEqual(["text"]);
  });
});
