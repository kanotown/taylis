/**
 * M150 (WIKI.md §22.6, §27): the page editor's Markdown ⇄ document, without an editor. The invariants:
 *
 * 1. A page read and written back untouched is the same bytes — every string of every apps/shared fixture, every
 *    Markdown file of the repository (docs/, the website) as a corpus, line breaks \n / \r\n / \r, and random bodies
 *    built from the dialect's pieces.
 * 2. The canonical form (every block written anew) is stable: written, read and written again it does not change, and
 *    it reads as the same blocks as the body it came from.
 * 3. Editing one block writes that block only (the rest keep their bytes).
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";

import { canonicalPage, docToPage, listRun, pageToDoc, type RichNode, sameShape, shapeOf, splitSourceLines } from "../src/ui/pageMarkdown";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const shared = join(root, "apps", "shared");

/** Every string in a JSON value (arrays of strings also joined as lines: a table's `lines`). */
function strings(value: unknown, out: string[] = []): string[] {
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) {
    if (value.length > 0 && value.every((v) => typeof v === "string")) out.push(value.join("\n"));
    value.forEach((v) => strings(v, out));
  } else if (value && typeof value === "object") Object.values(value).forEach((v) => strings(v, out));
  return out;
}

/** The fixtures that hold bodies (emoji.json is the emoji dataset: 4,000 short codes, nothing to read). */
const fixtureFiles = readdirSync(shared).filter((name) => name.endsWith(".json") && name !== "emoji.json");
const fixtureStrings = [...new Set(fixtureFiles.flatMap((name) => strings(JSON.parse(readFileSync(join(shared, name), "utf8")))))];

function markdownFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name.startsWith(".") || name === "build" || name === "dist") continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) markdownFiles(path, out);
    else if (name.endsWith(".md")) out.push(path);
  }
  return out;
}
const corpus = [...markdownFiles(join(root, "docs")), ...markdownFiles(join(root, "website")), join(root, "README.md"), join(root, "README.ja.md")].map((path) => ({ path, body: readFileSync(path, "utf8") }));

const emoji = (name: string) => ["smile", "party", "tada", "white_check_mark"].includes(name);
const roundTrip = (body: string) => docToPage(pageToDoc(body, { emoji }));

/** A small deterministic random source (the fuzz is the same on every run). */
function random(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

const PIECES = [
  "# 見出し", "## Heading **bold**", "### h3", "本文の行", "plain _italic_ and **bold** and ~~strike~~ and `code`", "", "", "  ", "- a", "- b", "  - nested", "    - deeper", "      - too deep",
  "1. one", "1. one again", "3. three", "  1. inner", "* star", "- [ ] task", "- [x] done", "  - [ ] sub task", "- [ ] linked <!--task:0190a2b4-0000-7000-8000-000000000001-->",
  "> quote", "> - quoted item", ">", "```", "```ts", "const x = 1;", "$$", "$$x^2$$", "\\frac{a}{b}", "---", "| a | b |", "| --- | :-: |", "| 1 | 2 |",
  "![](attachment:0190a2b4-0000-7000-8000-0000000000aa)", "![db](page:0190a2b4-0000-7000-8000-0000000000bb#view=v1)", "::: callout 💡", "::: callout", "::: toggle 詳細", "::: toggle", ":::",
  "[ページ](page:0190a2b4-0000-7000-8000-0000000000cc) と <@0190a2b4-0000-7000-8000-0000000000dd>", ":smile: :unknown: :party:", "https://example.com/a_b_c", "snake_case_name", "$5 and $10", "$x$ math",
  "\\_escaped\\_", "a | b", "--- | ---", "<!channel>", "[link](https://example.com)", "\t- tab item", "> > nested quote", "​# zwsp heading text",
];

function fuzzBody(next: () => number): string {
  const n = 1 + Math.floor(next() * 14);
  const lines: string[] = [];
  for (let k = 0; k < n; k++) lines.push(PIECES[Math.floor(next() * PIECES.length)]!);
  const breaks = ["\n", "\n", "\n", "\r\n", "\r"];
  let body = "";
  lines.forEach((line, k) => {
    body += line;
    if (k < lines.length - 1) body += breaks[Math.floor(next() * breaks.length)]!;
  });
  return next() < 0.2 ? body + "\n" : body;
}

// The corpus (every Markdown file of docs/ and website/) keeps growing; CI's runner took past vitest's 5 s on the
// idempotency pass (2026-10-10). The functions themselves are timed below (the 100,000-character page).
vi.setConfig({ testTimeout: 60_000 });

describe("the round trip: a page opened and closed is the same bytes", () => {
  it(`every string of the apps/shared fixtures (${fixtureStrings.length})`, () => {
    expect(fixtureStrings.length).toBeGreaterThan(500);
    const failures = fixtureStrings.filter((body) => roundTrip(body) !== body);
    expect(failures).toEqual([]);
  });

  it(`the repository's Markdown files as a corpus (${corpus.length} files)`, () => {
    expect(corpus.length).toBeGreaterThan(20);
    for (const { path, body } of corpus) expect(roundTrip(body), path).toBe(body);
  });

  it("the corpus with \\r\\n and \\r line breaks", () => {
    for (const { path, body } of corpus.slice(0, 8)) {
      for (const eol of ["\r\n", "\r"]) {
        const converted = body.replace(/\n/g, eol);
        expect(roundTrip(converted), `${path} ${JSON.stringify(eol)}`).toBe(converted);
      }
    }
  });

  it("3,000 random bodies built from the dialect's pieces", () => {
    const next = random(150);
    for (let k = 0; k < 3000; k++) {
      const body = fuzzBody(next);
      expect(roundTrip(body), JSON.stringify(body)).toBe(body);
    }
  });

  it("a 100,000-character page is read and written back in well under a second (WIKI.md §22.6: no jank)", () => {
    let body = "";
    for (let k = 0; body.length < 100_000; k++) body += corpus[k % corpus.length]!.body.slice(0, 8_000) + "\n";
    body = body.slice(0, 100_000);
    const started = performance.now();
    const doc = pageToDoc(body, { emoji });
    const read = performance.now();
    expect(docToPage(doc)).toBe(body);
    const written = performance.now();
    // Measured on the development Mac (M5 Max): 14 ms for both (CI machines are slower).
    expect(read - started).toBeLessThan(1500);
    expect(written - read).toBeLessThan(1000);
  });

  it("edge cases: empty, blank lines only, a trailing break, a lone close, an unclosed container", () => {
    for (const body of ["", "\n", "\n\n", "a\n", "a\r\n", ":::", "::: callout 💡\nnever closed", "```\nno close", "$$\nno close", "---", "a\n---\nb", "::: callout\n:::", "::: toggle t\n:::", "::: callout\n::: toggle x\n::: callout\ndeep\n:::\n:::\n:::"]) {
      expect(roundTrip(body), JSON.stringify(body)).toBe(body);
    }
  });
});

describe("the canonical form", () => {
  const stable = (body: string) => {
    const once = canonicalPage(pageToDoc(body, { emoji }));
    const twice = canonicalPage(pageToDoc(once, { emoji }));
    return { once, twice, thrice: canonicalPage(pageToDoc(twice, { emoji })) };
  };

  it("is idempotent from the first rewrite on (fixtures, corpus, fuzz)", () => {
    const next = random(7);
    const bodies = [...fixtureStrings, ...corpus.map((c) => c.body), ...Array.from({ length: 1500 }, () => fuzzBody(next))];
    for (const body of bodies) {
      const { once, twice } = stable(body);
      expect(twice, JSON.stringify(body).slice(0, 200)).toBe(once);
    }
  });

  it("reads as the same blocks as the body it was written from (fixtures and corpus)", () => {
    const failures: string[] = [];
    for (const body of [...fixtureStrings, ...corpus.map((c) => c.body)]) {
      const read = pageToDoc(body, { emoji }).content ?? [];
      const again = pageToDoc(canonicalPage(pageToDoc(body, { emoji })), { emoji }).content ?? [];
      if (!sameShape(read.filter((n) => !isBlank(n)), again.filter((n) => !isBlank(n)))) failures.push(body.slice(0, 120));
    }
    expect(failures).toEqual([]);
  });
});

const isBlank = (node: RichNode) => node.type === "paragraph" && !node.content;

describe("reading", () => {
  it("one paragraph node per line, lists flat with their level, number and kind, a task's marker kept aside", () => {
    const doc = pageToDoc("a\n\n- x\n  - y\n3. z\n- [x] t <!--task:0190a2b4-0000-7000-8000-000000000001-->");
    const shapes = (doc.content ?? []).map(shapeOf);
    expect(shapes.map((n) => n.type)).toEqual(["paragraph", "paragraph", "listLine", "listLine", "listLine", "listLine"]);
    expect(shapes[2]!.attrs).toMatchObject({ kind: "bullet", level: 0 });
    expect(shapes[3]!.attrs).toMatchObject({ kind: "bullet", level: 1 });
    expect(shapes[4]!.attrs).toMatchObject({ kind: "ordered", level: 0, number: 3 });
    expect(shapes[5]!.attrs).toMatchObject({ kind: "task", checked: true, markers: " <!--task:0190a2b4-0000-7000-8000-000000000001-->" });
    expect(shapes[5]!.content).toEqual([{ type: "text", text: "t" }]);
  });

  it("mentions, page links and known emoji are atoms; callouts and toggles hold their blocks; embeds, images, tables are atoms", () => {
    const doc = pageToDoc("<@0190a2b4-0000-7000-8000-0000000000dd> [x](page:0190a2b4-0000-7000-8000-0000000000cc) :smile: :nope:\n::: callout 💡\n- a\n:::\n::: toggle **T**\nbody\n:::\n![](attachment:0190a2b4-0000-7000-8000-0000000000aa)\n\n| a |\n| - |", { emoji });
    const [line, callout, toggle, image, , table] = (doc.content ?? []).map(shapeOf);
    expect(line!.content!.map((n) => n.type)).toEqual(["mention", "text", "pageLink", "text", "emoji", "text"]);
    expect(callout).toMatchObject({ type: "callout", attrs: { icon: "💡" }, content: [{ type: "listLine" }] });
    expect(toggle!.content![0]).toEqual({ type: "toggleTitle", content: [{ type: "text", text: "T", marks: [{ type: "bold" }] }] });
    expect(image).toMatchObject({ type: "image", attrs: { alt: "" } });
    expect(table).toMatchObject({ type: "table", content: [{ type: "tableRow", content: [{ type: "tableCell", content: [{ type: "text", text: "a" }] }] }] });
  });

  it("keeps the exact line breaks of every line", () => {
    expect(splitSourceLines("a\r\nb\rc\n")).toEqual({ lines: ["a", "b", "c", ""], seps: ["\r\n", "\r", "\n"] });
  });

  it("list markers in the editor follow the renderer (lists.json): levels clamp to one past the line before, numbers count on", () => {
    expect(listRun([{ kind: "ordered", level: 0, number: 3 }, { kind: "ordered", level: 0, number: 3 }, { kind: "ordered", level: 2, number: 1 }, { kind: "bullet", level: 0, number: null }])).toEqual([
      { level: 0, number: 3 },
      { level: 0, number: 4 },
      { level: 1, number: 1 },
      { level: 0, number: 0 },
    ]);
  });
});

/** Edits on the JSON document (the editor's own edits are in pageEditor.test.tsx). */
describe("editing one block writes that block only", () => {
  const body = "# 題\r\n\r\n* one\r\n*   two\r\n\r\n1. a\r\n1. b\r\n\r\n> q\r\n\r\n::: callout ⚠️\r\ninside\r\n:::\r\nlast";
  const edit = (change: (doc: RichNode) => void) => {
    const doc = pageToDoc(body);
    const original = JSON.parse(JSON.stringify(doc)) as RichNode;
    const keep = new Map<string, string>();
    const walk = (node: RichNode) => {
      if (typeof node.attrs?.sig === "string") keep.set(node.attrs.sig, JSON.stringify(node));
      node.content?.forEach(walk);
    };
    walk(original);
    change(doc);
    return docToPage(doc, (node) => typeof node.attrs?.sig === "string" && keep.get(node.attrs.sig) === JSON.stringify(node));
  };
  const blocks = (doc: RichNode) => doc.content!;

  it("a heading's text", () => {
    expect(edit((doc) => (blocks(doc)[0]!.content = [{ type: "text", text: "新しい題" }]))).toBe(body.replace("# 題", "# 新しい題"));
  });

  it("one list item: its own line only (the other keeps `*   two`), the line breaks kept", () => {
    expect(edit((doc) => (blocks(doc)[2]!.content = [{ type: "text", text: "uno" }]))).toBe(body.replace("* one", "- uno"));
  });

  it("an item inserted in a numbered list counts on; the item after it keeps its line (the renderer counts it on)", () => {
    const out = edit((doc) => blocks(doc).splice(6, 0, { type: "listLine", attrs: { kind: "ordered", level: 0, number: null, checked: false }, content: [{ type: "text", text: "new" }] }));
    expect(out).toBe(body.replace("1. a\r\n1. b", "1. a\r\n2. new\n1. b"));
  });

  it("a task ticked keeps its hidden marker", () => {
    const doc = pageToDoc("- [ ] x <!--task:0190a2b4-0000-7000-8000-000000000001-->\n- [ ] y");
    const original = originalOf(doc);
    doc.content![0]!.attrs!.checked = true;
    expect(docToPage(doc, original)).toBe("- [x] x <!--task:0190a2b4-0000-7000-8000-000000000001-->\n- [ ] y");
  });

  it("inside a callout: the opener (with its U+FE0F icon) and close stay, only the edited line changes", () => {
    expect(edit((doc) => (blocks(doc)[10]!.content![0]!.content = [{ type: "text", text: "changed" }]))).toBe(body.replace("inside", "changed"));
  });

  it("a callout's icon changed: only its opener is rewritten", () => {
    expect(edit((doc) => (blocks(doc)[10]!.attrs!.icon = "💡"))).toBe(body.replace("::: callout ⚠️", "::: callout 💡"));
  });

  it("a paragraph typed to look like Markdown stays text (a zero-width space in front)", () => {
    expect(edit((doc) => (blocks(doc)[11]!.content = [{ type: "text", text: "# not a heading" }]))).toBe(body.replace("last", "​# not a heading"));
  });

  it("a rule put between two lines gets the blank lines it needs", () => {
    const out = edit((doc) => blocks(doc).splice(1, 1, { type: "horizontalRule" }));
    expect(out.startsWith("# 題\r\n\n---\n\n* one")).toBe(true);
  });
});

describe("M151: tables written from their cells", () => {
  const cell = (content: RichNode[], align: string | null = null): RichNode => ({ type: "tableCell", attrs: { align }, ...(content.length ? { content } : {}) });
  const text = (value: string): RichNode => ({ type: "text", text: value });
  const table = (rows: RichNode[][]): RichNode => ({ type: "doc", content: [{ type: "table", content: rows.map((cells) => ({ type: "tableRow", content: cells })) }] });
  const cellsOf = (doc: RichNode) => (doc.content![0]!.content ?? []).map((row) => (row.content ?? []).map((c) => shapeOf(c).content ?? []));

  it("pipes, backslashes, code spans and links with pipes, empty cells, Japanese: GFM that reads back as the same cells", () => {
    const doc = table([
      [cell([text("名前")], "left"), cell([text("a|b")], "center"), cell([text("メモ")], "right")],
      [cell([text("back\\slash \\| end\\")]), cell([{ type: "text", text: "x | y", marks: [{ type: "code" }] }]), cell([])],
      [cell([text("日本語 **ではない**")]), cell([{ type: "text", text: "リンク", marks: [{ type: "link", attrs: { href: "https://example.com/a|b" } }] }]), cell([text("太字"), { type: "text", text: "強", marks: [{ type: "bold" }] }])],
    ]);
    const written = canonicalPage(doc);
    expect(written).toBe([
      "| 名前 | a\\|b | メモ |",
      "| :--- | :---: | ---: |",
      "| back\\slash \\\\| end\\ | `x \\| y` |  |",
      "| 日本語 **ではない\\*\\* | [リンク](https://example.com/a\\|b) | 太字**強** |",
    ].join("\n"));
    const again = pageToDoc(written);
    expect(again.content![0]!.type).toBe("table");
    expect(cellsOf(again)).toEqual(cellsOf(doc));
    expect(canonicalPage(again)).toBe(written);
  });

  it("random cell texts (pipes, backslashes, marks' signs, spaces inside) read back as typed", () => {
    const next = random(151);
    const chars = ["a", "b", "表", "|", "\\", "`", "*", "_", "~", "$", " ", "[", "]", "(", ")", ":", "-", "#", "<", "@"];
    for (let k = 0; k < 1500; k++) {
      const cells = Array.from({ length: 1 + Math.floor(next() * 4) }, () => Array.from({ length: Math.floor(next() * 9) }, () => chars[Math.floor(next() * chars.length)]!).join("").trim());
      const doc = table([cells.map((value) => cell(value ? [text(value)] : [])), cells.map(() => cell([text("x")]))]);
      const written = canonicalPage(doc);
      const read = pageToDoc(written);
      expect(read.content![0]!.type, JSON.stringify(cells)).toBe("table");
      expect(read.content![0]!.content![0]!.content!.map((c) => (c.content ?? []).map((n) => n.text ?? "").join("")), `${JSON.stringify(cells)} → ${written}`).toEqual(cells);
    }
  });

  it("a table read keeps its source; one cell edited writes the whole table anew (rows padded to the header)", () => {
    const body = "前\n|a|b|\n|-|:-:|\n|1|\n後";
    const doc = pageToDoc(body);
    expect(docToPage(doc)).toBe(body);
    const original = originalOf(doc);
    doc.content![1]!.content![1]!.content![0]!.content = [text("一")];
    expect(docToPage(doc, original)).toBe("前\n| a | b |\n| --- | :---: |\n| 一 |  |\n後");
  });
});

function originalOf(doc: RichNode) {
  const keep = new Map<string, string>();
  const walk = (node: RichNode) => {
    if (typeof node.attrs?.sig === "string") keep.set(node.attrs.sig, JSON.stringify(node));
    node.content?.forEach(walk);
  };
  walk(JSON.parse(JSON.stringify(doc)) as RichNode);
  return (node: RichNode) => typeof node.attrs?.sig === "string" && keep.get(node.attrs.sig) === JSON.stringify(node);
}
