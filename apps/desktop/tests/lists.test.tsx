// @vitest-environment jsdom
/**
 * Lists (DATA_MODEL.md 「本文の形式」, 2026-10-06): levels, numbers and markers as every client draws them
 * (apps/shared/lists.json), and the nested <ol start> / <ul> the desktop draws them with. Code spans and blocks
 * (apps/shared/inline-format.json `code_blocks`).
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { BlockView, listGroups } from "../src/ui/MessageBody";
import { type Block, parseBlocks, type Token } from "../src/ui/markdown";

interface Vectors {
  cases: Array<{ name: string; body: string; blocks: string[]; lists: Array<Array<[number, string, string]>> }>;
  quoted: Array<{ name: string; body: string; blocks: string[]; quotes: unknown[][] }>;
}

const shared = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "shared");
const vectors = JSON.parse(readFileSync(join(shared, "lists.json"), "utf8")) as Vectors;
const inlineVectors = JSON.parse(readFileSync(join(shared, "inline-format.json"), "utf8")) as {
  code_blocks: Array<{ name: string; body: string; text: string }>;
};

const text = (tokens: Token[]) => tokens.map((t) => ("text" in t ? t.text : t.kind === "link" ? t.label ?? t.url : "")).join("");

describe("lists (apps/shared/lists.json)", () => {
  it.each(vectors.cases)("$name", ({ body, blocks, lists }) => {
    const parsed = parseBlocks(body);
    expect(parsed.map((b) => b.kind)).toEqual(blocks);
    const got = parsed.filter((b): b is Extract<Block, { kind: "list" }> => b.kind === "list").map((b) => b.items.map((item) => [item.level, item.marker, text(item.tokens)]));
    expect(got).toEqual(lists);
  });

  it("has the cases", () => {
    expect(vectors.cases.length).toBeGreaterThan(20);
  });

  it.each(vectors.cases)("drawn as nested lists in the same order: $name", ({ body }) => {
    for (const block of parseBlocks(body)) {
      if (block.kind !== "list") continue;
      const { container } = render(<BlockView block={block} users={new Map()} />);
      // Every item once, in order, each at the depth of its level.
      const items = [...container.querySelectorAll("li")];
      expect(items.length).toBe(block.items.length);
      items.forEach((li, i) => {
        let depth = -1;
        for (let el: Element | null = li; el && el !== container; el = el.parentElement) if (el.tagName === "OL" || el.tagName === "UL") depth++;
        expect(depth).toBe(block.items[i]!.level);
        // The browser's marker is the list's start plus the item's place in it, in the level's style.
        const list = li.parentElement as HTMLOListElement;
        if (list.tagName === "OL") {
          const n = list.start + [...list.children].indexOf(li);
          expect(n).toBe(block.items[i]!.number);
          expect(list.style.listStyleType).toBe(["decimal", "lower-alpha", "lower-roman"][block.items[i]!.level]);
        } else {
          expect(list.dataset.marker).toBe(["disc", "circle", "square"][block.items[i]!.level]);
        }
      });
    }
  });

  it("a nested list under a far-along list starts at its own number", () => {
    const block = parseBlocks("1. a\n2. b\n3. c\n  1. d\n  2. e\n4. f")[0] as Extract<Block, { kind: "list" }>;
    const groups = listGroups(block.items);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.entries[2]!.children[0]).toMatchObject({ ordered: true, level: 1, start: 1 });
    const { container } = render(<BlockView block={block} users={new Map()} />);
    expect([...container.querySelectorAll("ol")].map((ol) => ol.start)).toEqual([1, 1]);
  });
});

describe("lists in quotes (apps/shared/lists.json quoted)", () => {
  const quotedText = (lines: Token[][]) => lines.map(text);
  it.each(vectors.quoted)("$name", ({ body, blocks, quotes }) => {
    const parsed = parseBlocks(body);
    expect(parsed.map((b) => b.kind)).toEqual(blocks);
    const got = parsed
      .filter((b): b is Extract<Block, { kind: "quote" }> => b.kind === "quote")
      .map((q) => q.blocks.map((inner) => (inner.kind === "list" ? ["list", inner.items.map((item) => [item.level, item.marker, text(item.tokens)])] : ["paragraph", quotedText(inner.lines)])));
    expect(got).toEqual(quotes);
  });

  it("has the cases", () => {
    expect(vectors.quoted.length).toBeGreaterThan(10);
  });

  it("draws a quoted list as a list with drawn bullets, no literal marker", () => {
    const [block] = parseBlocks("> 手順：\n> - a\n>   - b\n>     - c\n> 1. d");
    const { container } = render(<BlockView block={block!} users={new Map()} />);
    const quote = container.querySelector("blockquote")!;
    expect([...quote.querySelectorAll("ul.md-ul")].map((ul) => (ul as HTMLElement).dataset.marker)).toEqual(["disc", "circle", "square"]);
    expect([...quote.querySelectorAll("li")].map((li) => li.firstChild?.textContent)).toEqual(["a", "b", "c", "d"]);
    expect(quote.querySelector("ol")?.start).toBe(1);
    expect(quote.textContent).not.toContain("- ");
  });
});

describe("code blocks (apps/shared/inline-format.json code_blocks)", () => {
  it.each(inlineVectors.code_blocks)("$name", ({ body, text: expected }) => {
    const block = parseBlocks(body).find((b) => b.kind === "codeblock");
    expect(block).toMatchObject({ kind: "codeblock", text: expected });
  });
});
