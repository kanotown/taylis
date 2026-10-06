/**
 * M43: the canvas dialect (CANVAS.md §4.2) and the editor's text helpers, from the fixture the three clients share
 * (apps/shared/canvas_markdown.json), plus the desktop-only toolbar edits.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { attachmentRefs, insertImageLine, insertRule, outline, preserveCaret, setHeading, toggleTaskLine, toggleTasks } from "../src/ui/canvasText";
import { continueStructure } from "../src/ui/composerEdit";
import { type Block, parseBlocks, type Token } from "../src/ui/markdown";

interface Fixture {
  blocks: Array<{ name: string; body: string; canvas?: boolean; blocks: unknown[] }>;
  toggle: Array<{ body: string; line: number; expected: string | null }>;
  caret: Array<{ name: string; before: string; after: string; caret: number; expected: number }>;
  page_links: { cases: Array<{ name: string; body: string; canvas?: boolean; links: Array<{ url: string; label: string }> }> };
}

const fixture = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "..", "shared", "canvas_markdown.json"), "utf8")) as Fixture;

/** A token's source text (markers of emphasis dropped, as the fixture's `text` keeps only what the reader sees). */
const text = (tokens: Token[]): string =>
  tokens.map((t) => ("text" in t ? t.text : t.kind === "link" ? t.label ?? t.url : t.kind === "mention" ? `<@${t.userId}>` : "")).join("");

function describeBlock(block: Block): unknown {
  switch (block.kind) {
    case "heading":
      return { kind: "heading", level: block.level, text: text(block.tokens) };
    case "paragraph":
      return { kind: "paragraph", lines: block.lines.map(text) };
    case "list":
      return { kind: "list", ordered: block.ordered, items: block.items.map((item) => text(item.tokens)) };
    case "task":
      return { kind: "task", items: block.items.map((item) => ({ level: item.level, done: item.done, text: text(item.tokens), line: item.line })) };
    case "image":
      return { kind: "image", alt: block.alt, attachment_id: block.attachmentId, line: block.line };
    case "hr":
      return { kind: "hr" };
    case "codeblock":
      return { kind: "codeblock", text: block.text };
    default:
      return { kind: block.kind };
  }
}

describe("the canvas dialect (apps/shared/canvas_markdown.json)", () => {
  it.each(fixture.blocks.map((c) => [c.name, c] as const))("%s", (_name, c) => {
    expect(parseBlocks(c.body, { canvas: c.canvas ?? true }).map(describeBlock)).toEqual(c.blocks);
  });

  it.each(fixture.toggle.map((c, i) => [i, c] as const))("tick %i", (_i, c) => {
    expect(toggleTaskLine(c.body, c.line)).toBe(c.expected);
  });

  it.each(fixture.caret.map((c) => [c.name, c] as const))("caret: %s", (_name, c) => {
    expect(preserveCaret(c.before, c.after, c.caret)).toBe(c.expected);
  });

  // M121 (WIKI.md §2.3): `page:` and `attachment:` links of the canvas dialect.
  it.each(fixture.page_links.cases.map((c) => [c.name, c] as const))("links: %s", (_name, c) => {
    const links: Array<{ url: string; label: string }> = [];
    const visit = (tokens: Token[]) => tokens.forEach((t) => { if (t.kind === "link") links.push({ url: t.url, label: t.label ?? t.url }); });
    for (const block of parseBlocks(c.body, { canvas: c.canvas ?? true })) {
      if (block.kind === "heading") visit(block.tokens);
      else if (block.kind === "paragraph") block.lines.forEach(visit);
      else if (block.kind === "list") block.items.forEach((item) => visit(item.tokens));
      else if (block.kind === "task") block.items.forEach((item) => visit(item.tokens));
    }
    expect(links).toEqual(c.links);
  });
});

describe("the editor's edits", () => {
  it("ticks to a given state (a click on a box that is already so changes nothing)", () => {
    expect(toggleTaskLine("- [x] a", 0, true)).toBe("- [x] a");
    expect(toggleTaskLine("- [x] a", 0, false)).toBe("- [ ] a");
  });

  it("headings: set, change level, remove", () => {
    expect(setHeading({ text: "議題", start: 1, end: 1 }, 2).text).toBe("## 議題");
    expect(setHeading({ text: "## 議題", start: 4, end: 4 }, 1).text).toBe("# 議題");
    expect(setHeading({ text: "# 議題", start: 3, end: 3 }, 1).text).toBe("議題");
  });

  it("checklist: lines and bullets become tasks, tasks become text again", () => {
    expect(toggleTasks({ text: "資料\n- 練習", start: 0, end: 7 }).text).toBe("- [ ] 資料\n- [ ] 練習");
    expect(toggleTasks({ text: "- [ ] 資料\n- [x] 練習", start: 0, end: 16 }).text).toBe("資料\n練習");
  });

  it("a rule goes on its own line between blank lines", () => {
    expect(insertRule({ text: "前\n後", start: 1, end: 1 })).toEqual({ text: "前\n\n---\n\n後", start: 8, end: 8 });
    expect(insertRule({ text: "", start: 0, end: 0 }).text).toBe("---\n\n");
  });

  it("Enter in a task goes on with an open box; on an empty one it ends the list", () => {
    expect(continueStructure({ text: "- [x] 資料", start: 8, end: 8 })).toEqual({ text: "- [x] 資料\n- [ ] ", start: 15, end: 15 });
    expect(continueStructure({ text: "  * [ ] 入れ子", start: 11, end: 11 })?.text).toBe("  * [ ] 入れ子\n  * [ ] ");
    expect(continueStructure({ text: "a\n- [ ] ", start: 8, end: 8 })).toEqual({ text: "a\n", start: 2, end: 2 });
  });

  it("the outline lists headings outside code", () => {
    expect(outline("# A\ntext\n```\n# not\n```\n## B\n### C")).toEqual([
      { level: 1, text: "A", line: 0 },
      { level: 2, text: "B", line: 5 },
      { level: 3, text: "C", line: 6 },
    ]);
  });
});

describe("images (M44)", () => {
  const id = "0190a2b4-0000-7000-8000-000000000001";

  it("an image goes in on a line of its own at the caret, the caret below it", () => {
    expect(insertImageLine({ text: "", start: 0, end: 0 }, id)).toEqual({ text: `![](attachment:${id})\n`, start: 53, end: 53 });
    const mid = insertImageLine({ text: "前の文後の文", start: 3, end: 3 }, id);
    expect(mid.text).toBe(`前の文\n![](attachment:${id})\n後の文`);
    expect(mid.text.slice(mid.start)).toBe("後の文");
    const atLineStart = insertImageLine({ text: "a\nb", start: 2, end: 2 }, id, "図 1");
    expect(atLineStart.text).toBe(`a\n![図 1](attachment:${id})\nb`);
    const replacing = insertImageLine({ text: "a\nselected\n", start: 2, end: 10 }, id);
    expect(replacing.text).toBe(`a\n![](attachment:${id})\n`);
  });

  it("counts the distinct attachments a body names (upper-case ids too, as Swift writes them)", () => {
    const body = `![](attachment:${id})\n![x](attachment:${id.toUpperCase()})\n[資料](attachment:0190a2b4-0000-7000-8000-000000000002)`;
    expect([...attachmentRefs(body)]).toEqual([id, "0190a2b4-0000-7000-8000-000000000002"]);
    expect(parseBlocks(`![](attachment:${id.toUpperCase()})`, { canvas: true })).toEqual([{ kind: "image", alt: "", attachmentId: id, line: 0 }]);
  });
});
