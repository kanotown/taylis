/**
 * The rich composer's document ⇄ the message Markdown (DATA_MODEL.md 「本文の形式」, 「リッチ入力」). The rich editor
 * (RichEditor.tsx, TipTap / ProseMirror) holds a document; the body, the draft and the edit box keep Markdown. This
 * module converts both ways on the editor's JSON, so it stays out of the TipTap bundle and is unit tested on its own.
 *
 * - Markdown → document reads the body with the renderer's own parser (markdown.ts `parseBlocks`), so the editor shows
 *   what the message shows. One body line is one paragraph (an empty paragraph is an empty line), a quote holds one
 *   paragraph per line and its lists, list items nest by level, a table is a raw Markdown block (edited as text). TeX math
 *   (apps/shared/math.json) keeps its source: an inline `$…$` / `$$…$$` is text with the `math` mark (its TeX, written
 *   back between its dollars as it was), a display block is a raw Markdown block.
 * - Document → Markdown writes the dialect: `**bold**`, `_italic_`, `~~strike~~`, `` `code` ``, `[label](url)` (a URL
 *   that is its own label is written bare), `# ` headings, `> ` quotes, `- ` / `1. ` lists two spaces per level,
 *   ``` fences. Marks never nest in this dialect, so the editor keeps one mark at a time. A character typed as text is
 *   escaped (`\_ \* \~ \` \$`) only where the renderer would otherwise read it as formatting: each line is checked with the
 *   renderer's tokenizer, so `snake_case`, URLs and e-mail addresses stay as typed. `_italic_` against a letter (Japanese
 *   inside a sentence) gets a zero-width space (U+200B) outside its `_`, and a paragraph line the renderer would read as
 *   a block (`- `, `1. `, `> `, `# `, ``` ``` ```, `$$`, a table separator) starts with one. A `$` typed as text that
 *   would open math is written `\$`; nothing inside a formula is ever escaped.
 */
import { parseBlocks, straightQuotes, tokenizeInline, type Block, type Token } from "./markdown";

/** A ProseMirror node as TipTap's JSON (`editor.getJSON()` / `setContent`). */
export interface RichNode {
  type: string;
  attrs?: Record<string, unknown>;
  content?: RichNode[];
  text?: string;
  marks?: Array<{ type: string; attrs?: Record<string, unknown> }>;
}

const ZWSP = "​";
const HEADING = /^(#{1,3})\s+(\S.*)$/;
const QUOTE = /^>\s?(.*)$/;
const BULLET = /^(\s*)[-*•]\s+(.*)$/;
const NUMBERED = /^(\s*)(\d{1,3})\.\s+(.*)$/;
const FENCE_START = /^```/;
/** A line the renderer may read as the start of display math (`mathBlockAt`). */
const MATH_START = /^\s*\$\$/;
const TABLE_SEPARATOR = /^[ \t]*\|?[ \t]*:?-+:?[ \t]*(?:\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*$/;
const WORD_CHAR = /[\p{L}\p{N}_]/u;
const BLANK = /^[\s　]*$/;
/** What the renderer never reads emphasis or escapes in: URLs, e-mail addresses, the shrug, @handles. */
const PROTECTED = [/https?:\/\/[^\s<>]+/g, /[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9-]{1,63}(?:\.[A-Za-z0-9-]{1,63}){1,8}/g, /¯\\_\(ツ\)_\/¯/g, /(?<![A-Za-z0-9._@<-])@[A-Za-z0-9._-]+/g];
const MARKERS = /[_*~`$]/g;
const SAFE_URL = /^https?:\/\/[^\s)]+$/;
const BARE_URL = /https?:\/\/[^\s<>]+/g;

// ---------------------------------------------------------------------------------------------------------------------
// Markdown → document

/** The editor's document for a Markdown body (a draft, a message opened for editing, text from the Markdown mode). */
export function markdownToDoc(markdown: string): RichNode {
  const content: RichNode[] = [];
  for (const block of parseBlocks(markdown)) content.push(...blockNodes(block));
  if (content.length === 0) content.push({ type: "paragraph" });
  return { type: "doc", content };
}

function blockNodes(block: Block): RichNode[] {
  switch (block.kind) {
    case "paragraph":
      return block.lines.map((line) => paragraph(inlineNodes(line, true)));
    case "heading":
      return [{ type: "heading", attrs: { level: block.level }, ...withContent(inlineNodes(block.tokens, false)) }];
    case "quote":
      // One paragraph per quoted line; a quoted list (apps/shared/lists.json `quoted`) is a list inside the quote.
      return [{ type: "blockquote", content: block.blocks.flatMap((inner) => (inner.kind === "list" ? listNodes(inner.items, 0, 0).nodes : inner.lines.map((line) => paragraph(inlineNodes(line, false))))) }];
    case "list":
      return listNodes(block.items, 0, 0).nodes;
    case "codeblock":
      return [{ type: "codeBlock", attrs: { language: block.lang }, ...withContent(block.text ? [{ type: "text", text: block.text }] : []) }];
    case "table":
      return [{ type: "rawMarkdown", content: [{ type: "text", text: tableMarkdown(block) }] }];
    case "math": {
      // Display math is edited as its source, like a table (the formula is trimmed: it renders the same).
      const source = block.tex.includes("\n") ? `$$\n${block.tex}\n$$` : `$$${block.tex}$$`;
      return [{ type: "rawMarkdown", content: [{ type: "text", text: source }] }];
    }
    default:
      return []; // tasks, images and rules exist in the canvas dialect only
  }
}

const paragraph = (nodes: RichNode[]): RichNode => ({ type: "paragraph", ...withContent(nodes) });
const withContent = (nodes: RichNode[]) => (nodes.length > 0 ? { content: nodes } : {});

type Item = Extract<Block, { kind: "list" }>["items"][number];

/** The lists at `level` from `from` on, until an item shallower than it: a change of kind starts another list. */
function listNodes(items: readonly Item[], from: number, level: number): { nodes: RichNode[]; next: number } {
  const nodes: RichNode[] = [];
  let current: RichNode | null = null;
  let currentOrdered = false;
  let i = from;
  while (i < items.length && items[i]!.level >= level) {
    const item = items[i]!;
    const last = current?.content?.at(-1);
    if (item.level > level && last) {
      const nested = listNodes(items, i, level + 1);
      last.content!.push(...nested.nodes);
      i = nested.next;
      continue;
    }
    if (!current || currentOrdered !== item.ordered) {
      current = item.ordered ? { type: "orderedList", attrs: { start: item.number }, content: [] } : { type: "bulletList", content: [] };
      currentOrdered = item.ordered;
      nodes.push(current);
    }
    current.content!.push({ type: "listItem", content: [paragraph(inlineNodes(item.tokens, false))] });
    i++;
  }
  return { nodes, next: i };
}

/** Inline tokens as text nodes with marks; the zero-width spaces this module writes are left out again. */
function inlineNodes(tokens: readonly Token[], lineStart: boolean): RichNode[] {
  const nodes: RichNode[] = [];
  const marked = (text: string, type: string, attrs?: Record<string, unknown>): RichNode => ({ type: "text", text, marks: [attrs ? { type, attrs } : { type }] });
  for (const token of tokens) {
    switch (token.kind) {
      case "text":
        nodes.push({ type: "text", text: token.text });
        break;
      case "bold":
      case "italic":
      case "strike":
      case "code":
        nodes.push(marked(token.text, token.kind));
        break;
      case "link":
        nodes.push(marked(token.label || token.url, "link", { href: token.url }));
        break;
      case "math":
        nodes.push(marked(token.text, "math", token.display ? { display: true } : undefined));
        break;
      case "mention":
        nodes.push({ type: "text", text: `<@${token.userId}>` });
        break;
      case "mention_group":
        nodes.push({ type: "text", text: `<@group:${token.groupId}>` });
        break;
      case "mention_all":
        nodes.push({ type: "text", text: `<!${token.target}>` });
        break;
      default:
        break;
    }
  }
  const isItalic = (node: RichNode | undefined) => node?.marks?.[0]?.type === "italic";
  const isMath = (node: RichNode | undefined) => node?.marks?.[0]?.type === "math" && !node.marks[0].attrs?.display;
  nodes.forEach((node, index) => {
    if (node.marks) return;
    let text = node.text ?? "";
    if ((index === 0 && lineStart) || isItalic(nodes[index - 1]) || isMath(nodes[index - 1])) text = text.startsWith(ZWSP) ? text.slice(1) : text;
    if (isItalic(nodes[index + 1]) && text.endsWith(ZWSP)) text = text.slice(0, -1);
    node.text = text;
  });
  // Neighbouring plain texts (a mention token beside text) are one node, as the editor keeps them.
  const merged: RichNode[] = [];
  for (const node of nodes) {
    if (!node.text) continue;
    const previous = merged.at(-1);
    if (previous && !previous.marks && !node.marks) previous.text += node.text;
    else merged.push(node);
  }
  return merged;
}

/** A table written back from its cells (the editor edits it as Markdown text). */
function tableMarkdown(block: Extract<Block, { kind: "table" }>): string {
  const cell = (tokens: Token[]) => serializeInline(tokenPieces(tokens)).replace(/\|/g, "\\|");
  const row = (cells: Token[][]) => `| ${cells.map(cell).join(" | ")} |`;
  const align = block.align.map((a) => (a === "center" ? ":-:" : a === "right" ? "--:" : a === "left" ? ":--" : "---"));
  return [row(block.header), `| ${align.join(" | ")} |`, ...block.rows.map(row)].join("\n");
}

// ---------------------------------------------------------------------------------------------------------------------
// Document → Markdown

/** The Markdown body of the editor's document (what is sent, saved as the draft or saved by the edit box). */
export function docToMarkdown(doc: RichNode): string {
  const lines: Array<{ text: string; paragraph: boolean }> = [];
  for (const block of doc.content ?? []) {
    switch (block.type) {
      case "paragraph":
        for (const line of splitLines(block.content)) lines.push({ text: blockSafe(serializeLine(line)), paragraph: true });
        break;
      case "heading": {
        const text = serializeLine(joinLines(block.content));
        const level = Math.min(Math.max(Number(block.attrs?.level) || 1, 1), 3);
        lines.push(BLANK.test(text) ? { text: "", paragraph: true } : { text: `${"#".repeat(level)} ${text.trimStart()}`, paragraph: false });
        break;
      }
      case "blockquote":
        for (const child of block.content ?? []) {
          if (child.type === "bulletList" || child.type === "orderedList") {
            for (const text of listLines(child, 0)) lines.push({ text: `> ${text}`, paragraph: false });
            continue;
          }
          for (const line of splitLines(child.type === "paragraph" ? child.content : [{ type: "text", text: plainOf(child) }])) {
            const text = serializeLine(line);
            // A quoted line typed as "- " / "1. " text stays text (the renderer reads quoted lists too).
            lines.push({ text: text ? `> ${BULLET.test(text) || NUMBERED.test(text) ? ZWSP + text : text}` : ">", paragraph: false });
          }
        }
        break;
      case "bulletList":
      case "orderedList":
        for (const text of listLines(block, 0)) lines.push({ text, paragraph: false });
        break;
      case "codeBlock": {
        const language = typeof block.attrs?.language === "string" && /^[A-Za-z0-9_+#.-]{1,20}$/.test(block.attrs.language) ? block.attrs.language : "";
        lines.push({ text: "```" + language, paragraph: false });
        for (const text of plainOf(block).split("\n")) lines.push({ text, paragraph: false });
        lines.push({ text: "```", paragraph: false });
        break;
      }
      case "rawMarkdown":
        for (const text of plainOf(block).split("\n")) lines.push({ text, paragraph: false });
        break;
      default:
        for (const text of plainOf(block).split("\n")) lines.push({ text: blockSafe(text), paragraph: true });
    }
  }
  // A paragraph line under a line with a pipe would make the two a table.
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.paragraph && TABLE_SEPARATOR.test(line.text) && lines[i - 1]!.text.includes("|") && !line.text.startsWith(ZWSP)) line.text = ZWSP + line.text;
  }
  return lines.map((line) => line.text).join("\n");
}

/** A paragraph line the renderer would read as a block starts with a zero-width space. */
function blockSafe(line: string): string {
  return HEADING.test(line) || QUOTE.test(line) || BULLET.test(line) || NUMBERED.test(line) || FENCE_START.test(line) || MATH_START.test(line) ? ZWSP + line : line;
}

function listLines(list: RichNode, depth: number): string[] {
  const out: string[] = [];
  const ordered = list.type === "orderedList";
  const start = Number(list.attrs?.start ?? 1);
  (list.content ?? []).forEach((item, index) => {
    const marker = ordered ? `${(Number.isFinite(start) ? start : 1) + index}. ` : "- ";
    const parts = item.content ?? [];
    const text = parts.filter((p) => p.type === "paragraph").map((p) => serializeLine(joinLines(p.content))).join(" ");
    out.push("  ".repeat(depth) + marker + text);
    for (const child of parts) if (child.type === "bulletList" || child.type === "orderedList") out.push(...listLines(child, depth + 1));
  });
  return out;
}

/** The inline nodes of a block cut at its hard breaks (each part one body line). */
function splitLines(content: RichNode[] | undefined): RichNode[][] {
  const lines: RichNode[][] = [[]];
  for (const node of content ?? []) {
    if (node.type === "hardBreak") lines.push([]);
    else lines[lines.length - 1]!.push(node);
  }
  return lines;
}

/** One line where the dialect has no line breaks (a heading, a list item): a hard break is a space. */
function joinLines(content: RichNode[] | undefined): RichNode[] {
  return (content ?? []).map((node) => (node.type === "hardBreak" ? { type: "text", text: " " } : node));
}

function plainOf(node: RichNode): string {
  if (node.type === "text") return node.text ?? "";
  if (node.type === "hardBreak") return "\n";
  return (node.content ?? []).map(plainOf).join("");
}

// ---------------------------------------------------------------------------------------------------------------------
// One line of inline Markdown

type PieceKind = "text" | "bold" | "italic" | "strike" | "code" | "math" | "link";
interface Piece {
  kind: PieceKind;
  text: string;
  /** A link's URL; "display" for `$$…$$` math. */
  href?: string;
}

const MARK_ORDER: PieceKind[] = ["code", "math", "link", "bold", "italic", "strike"];

function nodePieces(nodes: readonly RichNode[]): Piece[] {
  const pieces: Piece[] = [];
  for (const node of nodes) {
    const text = node.type === "text" ? node.text ?? "" : plainOf(node);
    if (!text) continue;
    const types = new Set((node.marks ?? []).map((mark) => mark.type));
    const kind = MARK_ORDER.find((k) => types.has(k)) ?? "text";
    const mark = node.marks?.find((m) => m.type === kind);
    const href = kind === "link" ? String(mark?.attrs?.href ?? "") : kind === "math" && mark?.attrs?.display ? "display" : undefined;
    pieces.push(href !== undefined ? { kind, text, href } : { kind, text });
  }
  return mergePieces(pieces);
}

function tokenPieces(tokens: readonly Token[]): Piece[] {
  return nodePieces(inlineNodes(tokens, false));
}

function mergePieces(pieces: Piece[]): Piece[] {
  const out: Piece[] = [];
  for (const piece of pieces) {
    const last = out.at(-1);
    if (last && last.kind === piece.kind && last.href === piece.href) last.text += piece.text;
    else out.push({ ...piece });
  }
  return out;
}

const lineCache = new Map<string, string>();

function serializeLine(nodes: readonly RichNode[]): string {
  if (nodes.length === 0) return "";
  const key = JSON.stringify(nodes);
  const hit = lineCache.get(key);
  if (hit !== undefined) return hit;
  const line = serializeInline(nodePieces(nodes));
  if (lineCache.size > 500) lineCache.clear();
  lineCache.set(key, line);
  return line;
}

/** How a piece is written: plain text, or the marker form the dialect has for it (null: written as plain text). */
interface Emitted {
  /** What the renderer should read here: [kind, text, href]. */
  expect: Piece[];
  /** Plain text: the text and the marker positions that may be escaped. */
  text?: string;
  candidates?: number[];
  /** A mark: its Markdown (`bare` for a link that is its own label). */
  raw?: string;
  bare?: string;
  /** Italic only: needs a word boundary on its left / right. */
  italic?: boolean;
  /** Inline `$…$` math: its closing `$` must not be followed by an ASCII letter or digit. */
  math?: boolean;
}

function emitPieces(pieces: readonly Piece[]): Emitted[] {
  const out: Emitted[] = [];
  const plain = (text: string) => {
    if (!text) return;
    out.push({ expect: [{ kind: "text", text }], text, candidates: markerPositions(text) });
  };
  for (const piece of pieces) {
    switch (piece.kind) {
      case "text":
        plain(piece.text);
        break;
      case "bold":
      case "strike": {
        const marker = piece.kind === "bold" ? "**" : "~~";
        const inner = escapeInside(piece.text, marker[0]!);
        if (inner === null) plain(piece.text);
        else out.push({ expect: [{ kind: piece.kind, text: piece.text }], raw: marker + inner + marker });
        break;
      }
      case "italic": {
        const core = piece.text.replace(/^[\s　]+/, "").replace(/[\s　]+$/, "");
        const lead = piece.text.slice(0, piece.text.length - piece.text.trimStart().length);
        const trail = piece.text.slice(piece.text.trimEnd().length);
        const inner = core ? escapeInside(core, "_") : null;
        if (inner === null) {
          plain(piece.text);
          break;
        }
        plain(lead);
        out.push({ expect: [{ kind: "italic", text: core }], raw: `_${inner}_`, italic: true });
        plain(trail);
        break;
      }
      case "code": {
        const text = piece.text;
        if (!text.includes("`")) out.push({ expect: [{ kind: "code", text: straightQuotes(text) }], raw: "`" + text + "`" });
        else if (!text.includes("``") && !text.includes("\n")) out.push({ expect: [{ kind: "code", text: straightQuotes(text) }], raw: "`` " + text + " ``" });
        else plain(text);
        break;
      }
      case "math": {
        // The formula as it was typed, between its dollars; never escaped (a `\$` inside is TeX's dollar).
        const fence = piece.href === "display" ? "$$" : "$";
        if (piece.text.includes("\n") || piece.text.trim() === "") plain(piece.text);
        else out.push({ expect: [piece.href ? { kind: "math", text: piece.text, href: piece.href } : { kind: "math", text: piece.text }], raw: fence + piece.text + fence, math: !piece.href });
        break;
      }
      case "link": {
        const href = (piece.href ?? "").replace(/ /g, "%20").replace(/\(/g, "%28").replace(/\)/g, "%29");
        if (!SAFE_URL.test(href)) {
          plain(piece.text);
          break;
        }
        const label = piece.text.replace(/\]/g, "］").replace(/\n/g, " ");
        const bracketed = `[${label}](${href})`;
        if (piece.text === href) out.push({ expect: [{ kind: "link", text: href, href }], raw: bracketed, bare: href });
        else out.push({ expect: [{ kind: "link", text: label, href }], raw: bracketed });
        break;
      }
    }
  }
  return out;
}

/** The text inside `**` / `~~` / `_`: its own marker escaped; null when the dialect cannot hold it (a final `\`). */
function escapeInside(text: string, marker: string): string | null {
  if (text.endsWith("\\") || text.includes("\n")) return null;
  return text.split(marker).join("\\" + marker);
}

/** The positions of `_ * ~ \`` in plain text, outside URLs, e-mail addresses and @handles. */
function markerPositions(text: string): number[] {
  const guarded = new Set<number>();
  for (const pattern of PROTECTED) {
    for (const match of text.matchAll(pattern)) {
      // The renderer tries emphasis before an address at its first character: a leading `_` is not protected.
      const lead = match[0].length - match[0].replace(/^_+/, "").length;
      for (let k = match.index! + lead; k < match.index! + match[0].length; k++) guarded.add(k);
    }
  }
  const positions: number[] = [];
  for (const match of text.matchAll(MARKERS)) if (!guarded.has(match.index!)) positions.push(match.index!);
  return positions;
}

function assemble(parts: readonly Emitted[], escaped: ReadonlySet<string>, bareLinks: boolean): string {
  const strings = parts.map((part, index) => {
    if (part.text !== undefined) {
      let text = part.text;
      const positions = (part.candidates ?? []).filter((p) => escaped.has(`${index}:${p}`)).sort((a, b) => b - a);
      for (const p of positions) text = text.slice(0, p) + "\\" + text.slice(p);
      return text;
    }
    return bareLinks && part.bare !== undefined ? part.bare : part.raw ?? "";
  });
  // `_italic_` next to a letter, digit or `_` is not emphasis: a zero-width space makes the word boundary.
  return strings
    .map((value, index) => {
      // `$x$` right before a letter or digit is not math (prices): a zero-width space ends it.
      if (parts[index]!.math) return /^[0-9A-Za-z]/.test(strings[index + 1] ?? "") ? value + ZWSP : value;
      if (!parts[index]!.italic) return value;
      const before = strings[index - 1]?.slice(-1) ?? "";
      const after = strings[index + 1]?.slice(0, 1) ?? "";
      // After `.` `%` `+` `-` an address that starts the italic would begin at that character and swallow the `_`.
      const intoAddress = /[.%+-]/.test(before) && /^_[A-Za-z0-9._%+-]*@/.test(value);
      return ((before && WORD_CHAR.test(before)) || intoAddress ? ZWSP : "") + value + (after && WORD_CHAR.test(after) ? ZWSP : "");
    })
    .join("");
}

/**
 * Pieces as the renderer reads them back: neighbouring texts merged and zero-width spaces dropped; a URL in plain text
 * is a link (the renderer finds it), and a link written bare stays apart from the text after it, which it would take in.
 */
function signature(pieces: readonly Piece[]): string {
  const merged: Piece[] = [];
  for (const piece of pieces) {
    const text = piece.text.split(ZWSP).join("");
    if (!text) continue;
    const last = merged.at(-1);
    if (piece.kind === "text" && last?.kind === "text") last.text += text;
    else merged.push({ ...piece, text });
  }
  const out: Array<[string, string, string | null]> = [];
  for (const piece of merged) {
    if (piece.kind !== "text") {
      out.push([piece.kind, piece.text, piece.href ?? null]);
      continue;
    }
    let last = 0;
    for (const match of piece.text.matchAll(BARE_URL)) {
      if (match.index! > last) out.push(["text", piece.text.slice(last, match.index), null]);
      out.push(["link", match[0], match[0]]);
      last = match.index! + match[0].length;
    }
    if (last < piece.text.length) out.push(["text", piece.text.slice(last), null]);
  }
  return JSON.stringify(out);
}

function readBack(line: string): string {
  const pieces: Piece[] = tokenizeInline(line).map((token): Piece => {
    switch (token.kind) {
      case "bold":
      case "italic":
      case "strike":
      case "code":
        return { kind: token.kind, text: token.text };
      case "link":
        return { kind: "link", text: token.label || token.url, href: token.url };
      case "math":
        return token.display ? { kind: "math", text: token.text, href: "display" } : { kind: "math", text: token.text };
      case "mention":
        return { kind: "text", text: `<@${token.userId}>` };
      case "mention_group":
        return { kind: "text", text: `<@group:${token.groupId}>` };
      case "mention_all":
        return { kind: "text", text: `<!${token.target}>` };
      case "text":
        return { kind: "text", text: token.text };
      default:
        return { kind: "text", text: "" };
    }
  });
  return signature(pieces);
}

/** Most marker positions tried one by one; a longer line keeps all its escapes (still correct, just more `\`). */
const MAX_MINIMISED = 200;

/**
 * One line of pieces as Markdown that the renderer reads back as the same pieces, with as few escapes as it can: first
 * none, else every marker in plain text escaped and then each escape left out again where the line still reads the
 * same.
 */
function serializeInline(pieces: readonly Piece[]): string {
  const parts = emitPieces(pieces);
  const expected = signature(parts.flatMap((part) => part.expect));
  const none = new Set<string>();
  const first = assemble(parts, none, true);
  if (readBack(first) === expected) return first;
  const all = new Set<string>();
  parts.forEach((part, index) => (part.candidates ?? []).forEach((p) => all.add(`${index}:${p}`)));
  let bare = true;
  if (readBack(assemble(parts, all, true)) !== expected) {
    if (readBack(assemble(parts, all, false)) !== expected) return assemble(parts, all, false);
    bare = false;
    if (readBack(assemble(parts, none, false)) === expected) return assemble(parts, none, false);
  }
  if (all.size > MAX_MINIMISED) return assemble(parts, all, bare);
  const kept = new Set(all);
  for (const key of all) {
    kept.delete(key);
    if (readBack(assemble(parts, kept, bare)) !== expected) kept.add(key);
  }
  return assemble(parts, kept, bare);
}

// ---------------------------------------------------------------------------------------------------------------------
// Pasted plain text

/** Plain text pasted into the rich editor: literal text, one paragraph per line (never read as Markdown). */
export function plainTextToNodes(text: string): RichNode[] {
  return text.replace(/\r\n?/g, "\n").split("\n").map((line) => paragraph(line ? [{ type: "text", text: line }] : []));
}
