import { describe, expect, it } from "vitest";

import { docToMarkdown, markdownToDoc, type RichNode } from "../src/ui/richMarkdown";

/** A small seeded generator, so a failure repeats. */
function prng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

const ATOMS = ["a", "b", "あ", "強調", " ", "_", "*", "~", "`", "**", "__", "~~", "1", ".", "-", "#", ">", "|", "(", ")", "[", "]", "x_y", "$a_b$", "https://ex.am/p_q ", "me@ex.am", "@kano"];
const MARKS = [null, null, null, "bold", "italic", "strike", "code", "link"];

function randomLine(rand: () => number): RichNode[] {
  const nodes: RichNode[] = [];
  const n = 1 + Math.floor(rand() * 5);
  for (let i = 0; i < n; i++) {
    let text = "";
    const m = 1 + Math.floor(rand() * 4);
    for (let k = 0; k < m; k++) text += ATOMS[Math.floor(rand() * ATOMS.length)];
    const mark = MARKS[Math.floor(rand() * MARKS.length)];
    if (!mark) nodes.push({ type: "text", text });
    else if (mark === "link") nodes.push({ type: "text", text, marks: [{ type: "link", attrs: { href: "https://example.com/" + i } }] });
    else nodes.push({ type: "text", text, marks: [{ type: mark }] });
  }
  return nodes;
}

/** The document as a reader sees it: marks per character (spaces at an italic's ends are plain), texts merged. */
function normal(doc: RichNode): string {
  const out: string[] = [];
  const walk = (node: RichNode, path: string) => {
    if (node.type === "text") {
      const mark = node.marks?.[0];
      const bareLink = mark?.type === "link" && mark.attrs?.href === node.text;
      const kind = mark && !bareLink ? mark.type + (mark.type === "link" ? String(mark.attrs?.href) : "") : "";
      // A `]` in a link's label is written as 「］」 (the dialect's label cannot hold it).
      for (const ch of mark?.type === "link" ? (node.text ?? "").replace(/\]/g, "］") : node.text ?? "") out.push(`${path}|${kind && !(kind === "italic" && /\s/.test(ch)) ? kind : ""}|${ch}`);
      return;
    }
    (node.content ?? []).forEach((child, i) => walk(child, child.type === "text" ? path : `${path}/${child.type}${i}`));
  };
  walk(doc, "");
  return out.join("\n");
}

describe("rich composer serialisation (generated lines)", () => {
  it("reads back what was written, line after line", () => {
    const rand = prng(20261006);
    const failures: string[] = [];
    for (let run = 0; run < 3000; run++) {
      const line = randomLine(rand);
      // A URL typed as text ends at a space: the renderer takes whatever follows it into the link.
      // Out of reach of the dialect: a code span holding ``, a `[` in text before a link (the label would start there).
      const plain = line.map((node) => (node.marks?.[0]?.type === "link" ? "\u0001" : node.text)).join("");
      if (line.some((node) => node.marks?.[0]?.type === "code" && node.text!.includes("`")) || /\[[^\]]*\u0001/.test(plain)) continue;
      const doc: RichNode = { type: "doc", content: [{ type: "paragraph", content: line }] };
      const markdown = docToMarkdown(doc);
      const back = markdownToDoc(markdown);
      if (normal(back) !== normal(doc)) failures.push(JSON.stringify(line) + " → " + JSON.stringify(markdown) + " → " + JSON.stringify(back.content?.[0]?.content));
    }
    expect(failures.slice(0, 10)).toEqual([]);
  });

  it("keeps typed block markers in paragraphs as text, line after line", () => {
    const rand = prng(42);
    const starts = ["- ", "* ", "• ", "1. ", "12. ", "> ", ">", "# ", "### ", "```", "```js", "| a | b |", "| --- | --- |", "---", "  - ", "\t1. ", "", " "];
    const failures: string[] = [];
    for (let run = 0; run < 2000; run++) {
      const content: RichNode[] = [];
      const n = 1 + Math.floor(rand() * 5);
      for (let i = 0; i < n; i++) {
        const line = starts[Math.floor(rand() * starts.length)]! + (rand() < 0.7 ? "x" : "");
        content.push({ type: "paragraph", ...(line ? { content: [{ type: "text", text: line }] } : {}) });
      }
      const doc: RichNode = { type: "doc", content };
      const markdown = docToMarkdown(doc);
      const back = markdownToDoc(markdown);
      if (normal(back) !== normal(doc)) failures.push(JSON.stringify(markdown));
    }
    expect(failures.slice(0, 10)).toEqual([]);
  });
});
