/**
 * M150 (WIKI.md §22.6, §27): a Docs page's Markdown (the canvas dialect, CANVAS.md §4.2, M149's containers) ⇄ the
 * 見たまま page editor's document (ui/PageEditor.tsx, TipTap / ProseMirror JSON). Pure functions: no TipTap here.
 *
 * The body stays the storage. Reading keeps, on every block, the exact text it came from (`src`, and `eol`, the line
 * break after it, "\n", "\r\n", "\r" or "" at the end), so writing back gives the same bytes for every block nobody
 * touched — **opening and closing a page changes nothing** — and only an edited block is written in the canonical form.
 * Whether a block is untouched is the caller's to say (`SourceView.original`): the editor keeps the nodes it read and
 * compares (ProseMirror's `eq`, identity first); the tests compare JSON.
 *
 * Granularity: a paragraph is one node per body line (an empty paragraph is a blank line, as in the composer's rich
 * mode); headings, list items and checklist items are one line each, so a list keeps its other lines when one item is
 * edited; a quote, a code block, display math, a table, an image, an embed and a rule are one node each; a callout or a
 * toggle keeps its opener and close and its blocks one by one. Lists are flat (`listLine` with a kind and a level, as
 * the dialect is line based), numbered and indented by the renderer's own rules (apps/shared/lists.json).
 *
 * A block whose canonical form would not read back as the same (anything the dialect holds that the editor cannot) is
 * a `rawMarkdown` block: its text, edited in place as Markdown.
 */
import { stripTaskMarkers, TASK_MARKER } from "./canvasMarkers";
import { type Block, type BlockLines, CONTAINER_CLOSE, CONTAINER_OPEN, containerLines, LIST_LEVELS, parseBlocksWithLines, splitTableRow, TASK_LINE, type Token } from "./markdown";
import { inlineNodes, type InlineAtoms, type RichNode, serializeLine } from "./richMarkdown";

export type { RichNode } from "./richMarkdown";

/** What reading needs to know (which `:name:` are emoji the renderer draws). */
export type PageParseOptions = InlineAtoms;

/** The attributes that tie a node to its text; never part of what it shows. */
export const SOURCE_ATTRS = ["src", "sig", "eol", "openSrc", "openEol", "closeSrc"] as const;

const ZWSP = "​";
const HEADING = /^(#{1,3})\s+(\S.*)$/;
const QUOTE = /^>\s?(.*)$/;
const BULLET = /^(\s*)[-*•]\s+(.*)$/;
const NUMBERED = /^(\s*)(\d{1,3})\.\s+(.*)$/;
const FENCE = /^```/;
const MATH_START = /^\s*\$\$/;
const RULE_LINE = /^-{3,}\s*$/;
const IMAGE_OR_EMBED = /^!\[[^\]\n]*\]\((?:attachment|page):/i;
const TABLE_SEPARATOR = /^[ \t]*\|?[ \t]*:?-+:?[ \t]*(?:\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*$/;
const TASK_TEXT = /^\[[ xX]\](?: |$)/;

let sigCounter = 0;
/** A node's tie to what it was read as (unique in the session: nodes read later never share one). */
const nextSig = () => `s${(++sigCounter).toString(36)}`;

// ---------------------------------------------------------------------------------------------------------------------
// Markdown → document

interface ReadContext {
  /** The body's lines as stored (task markers in), and the line breaks between them (`seps[k]` after line k). */
  lines: string[];
  seps: string[];
  atoms: InlineAtoms;
}

/** The body's lines with the exact line breaks between them (the parser splits on \r\n, \r and \n alike). */
export function splitSourceLines(body: string): { lines: string[]; seps: string[] } {
  const lines: string[] = [];
  const seps: string[] = [];
  let last = 0;
  for (const match of body.matchAll(/\r\n|\r|\n/g)) {
    lines.push(body.slice(last, match.index));
    seps.push(match[0]);
    last = match.index! + match[0].length;
  }
  lines.push(body.slice(last));
  return { lines, seps };
}

/** The page editor's document for a body. Every block carries its source (see the module comment). */
export function pageToDoc(body: string, options: PageParseOptions = {}): RichNode {
  const { lines, seps } = splitSourceLines(body);
  const context: ReadContext = { lines, seps, atoms: { emoji: options.emoji } };
  const parsed = parseBlocksWithLines(body, { canvas: true });
  const content = readNodes(context, parsed.blocks, parsed.lines);
  return { type: "doc", content: content.length > 0 ? content : [{ type: "paragraph", attrs: { src: "", sig: nextSig(), eol: "" } }] };
}

const sourceOf = (c: ReadContext, from: number, to: number): string => {
  let out = c.lines[from] ?? "";
  for (let k = from + 1; k < to; k++) out += (c.seps[k - 1] ?? "\n") + (c.lines[k] ?? "");
  return out;
};
const eolAfter = (c: ReadContext, to: number): string => c.seps[to - 1] ?? "";
const markersOf = (line: string): string => (line.includes("<!--task:") ? (line.match(TASK_MARKER) ?? []).join("") : "");
const withContent = (nodes: RichNode[]) => (nodes.length > 0 ? { content: nodes } : {});

function readNodes(c: ReadContext, blocks: readonly Block[], ranges: readonly BlockLines[]): RichNode[] {
  const out: RichNode[] = [];
  blocks.forEach((block, index) => {
    const range = ranges[index]!;
    const nodes = blockNodes(c, block, range);
    // A block whose canonical text would read differently is kept as its Markdown (edited as text); lines one by one.
    if (block.kind === "paragraph") {
      for (const node of nodes) out.push(roundTrips([node], c.atoms) ? node : rawNode(String(node.attrs!.src), String(node.attrs!.eol)));
      return;
    }
    out.push(...(roundTrips(nodes, c.atoms) ? nodes : [rawNode(sourceOf(c, range.from, range.to), eolAfter(c, range.to))]));
  });
  return out;
}

function rawNode(src: string, eol: string): RichNode {
  const text = src.replace(/\r\n?/g, "\n");
  return { type: "rawMarkdown", attrs: { src, sig: nextSig(), eol }, ...withContent(text ? [{ type: "text", text }] : []) };
}

function lineAttrs(c: ReadContext, line: number): Record<string, unknown> {
  const src = c.lines[line] ?? "";
  return { src, sig: nextSig(), eol: eolAfter(c, line + 1), markers: markersOf(src) };
}

function blockNodes(c: ReadContext, block: Block, range: BlockLines): RichNode[] {
  const inl = (tokens: readonly Token[], lineStart: boolean) => inlineNodes(tokens, lineStart, c.atoms);
  const whole = () => ({ src: sourceOf(c, range.from, range.to), sig: nextSig(), eol: eolAfter(c, range.to) });
  switch (block.kind) {
    case "paragraph":
      return block.lines.map((tokens, k) => ({ type: "paragraph", attrs: lineAttrs(c, range.from + k), ...withContent(inl(tokens, true)) }));
    case "heading":
      return [{ type: "heading", attrs: { level: block.level, ...lineAttrs(c, range.from) }, ...withContent(inl(block.tokens, false)) }];
    case "list":
      return block.items.map((item, k) => ({
        type: "listLine",
        attrs: { kind: item.ordered ? "ordered" : "bullet", level: item.level, number: item.ordered ? item.number : null, checked: false, ...lineAttrs(c, range.from + k) },
        ...withContent(inl(item.tokens, true)),
      }));
    case "task":
      return block.items.map((item) => ({
        type: "listLine",
        attrs: { kind: "task", level: item.level, number: null, checked: item.done, ...lineAttrs(c, item.line) },
        ...withContent(inl(item.tokens, true)),
      }));
    case "quote": {
      const children: RichNode[] = [];
      for (const inner of block.blocks) {
        if (inner.kind === "list") {
          for (const item of inner.items) children.push({ type: "listLine", attrs: { kind: item.ordered ? "ordered" : "bullet", level: item.level, number: item.ordered ? item.number : null, checked: false }, ...withContent(inl(item.tokens, true)) });
        } else for (const tokens of inner.lines) children.push({ type: "paragraph", ...withContent(inl(tokens, true)) });
      }
      return [{ type: "blockquote", attrs: whole(), content: children.length > 0 ? children : [{ type: "paragraph" }] }];
    }
    case "codeblock":
      return [{ type: "codeBlock", attrs: { language: block.lang, ...whole() }, ...withContent(block.text ? [{ type: "text", text: block.text }] : []) }];
    case "math":
      return [{ type: "mathBlock", attrs: whole(), ...withContent(block.tex ? [{ type: "text", text: block.tex }] : []) }];
    case "table": {
      const attrs = whole();
      return [{ type: "table", attrs: { ...attrs, markdown: stripTaskMarkers(attrs.src.replace(/\r\n?/g, "\n")) } }];
    }
    case "image":
      return [{ type: "image", attrs: { attachmentId: block.attachmentId, alt: block.alt, ...whole() } }];
    case "embed":
      return [{ type: "embed", attrs: { pageId: block.pageId, viewId: block.viewId, label: block.label, ...whole() } }];
    case "hr":
      return [{ type: "horizontalRule", attrs: whole() }];
    case "callout":
    case "toggle": {
      const inner = readNodes(c, block.blocks, containerLines.get(block) ?? []);
      const close = range.to - 1;
      const attrs = { ...whole(), openSrc: c.lines[range.from] ?? "", openEol: c.seps[range.from] ?? "\n", closeSrc: c.lines[close] ?? ":::" };
      const body = inner.length > 0 ? inner : [{ type: "paragraph" }];
      if (block.kind === "callout") return [{ type: "callout", attrs: { icon: block.icon, ...attrs }, content: body }];
      return [{ type: "toggle", attrs, content: [{ type: "toggleTitle", ...withContent(inl(block.title, false)) }, ...body] }];
    }
  }
}

/** Whether nodes written in the canonical form read back as the same nodes (else the block stays Markdown). */
function roundTrips(nodes: RichNode[], atoms: InlineAtoms): boolean {
  // The atoms always do; a line of plain text without any sign the dialect reads does too.
  if (nodes.every((node) => node.type === "image" || node.type === "embed" || node.type === "table" || node.type === "horizontalRule" || (node.type === "paragraph" && plainLine(node)))) return true;
  const canonical = serializePage({ type: "doc", content: nodes }, jsonView(() => false), { edges: false }).text;
  const again = pageToDocUnchecked(canonical, atoms);
  return sameShape(again, nodes);
}

/**
 * Characters the inline writer may escape or read as a sign (a line that only looks like a block at its start reads
 * back the same: the writer puts a zero-width space in front, which reading drops).
 */
const SIGNS = /[\\_*~`$[\]<:@​]|https?:/;

/** A paragraph of one plain text node with nothing in it the dialect reads (the common line: no check needed). */
function plainLine(node: RichNode): boolean {
  const content = node.content ?? [];
  return content.length === 0 || (content.length === 1 && content[0]!.type === "text" && !content[0]!.marks && !SIGNS.test(content[0]!.text ?? ""));
}

/** pageToDoc without the round-trip check (used by the check itself). */
function pageToDocUnchecked(body: string, atoms: InlineAtoms): RichNode[] {
  const { lines, seps } = splitSourceLines(body);
  const context: ReadContext = { lines, seps, atoms };
  const parsed = parseBlocksWithLines(body, { canvas: true });
  return parsed.blocks.flatMap((block, index) => blockNodes(context, block, parsed.lines[index]!));
}

/** Two node lists alike apart from their source attributes. */
export function sameShape(a: readonly RichNode[], b: readonly RichNode[]): boolean {
  return JSON.stringify(a.map(shapeOf)) === JSON.stringify(b.map(shapeOf));
}

/** A node without its source attributes (what it shows). */
export function shapeOf(node: RichNode): RichNode {
  const out: RichNode = { type: node.type };
  if (node.attrs) {
    const attrs: Record<string, unknown> = {};
    for (const key of Object.keys(node.attrs).sort()) if (!(SOURCE_ATTRS as readonly string[]).includes(key) && node.attrs[key] !== undefined) attrs[key] = node.attrs[key];
    if (Object.keys(attrs).length > 0) out.attrs = attrs;
  }
  if (node.text !== undefined) out.text = node.text;
  if (node.marks && node.marks.length > 0) out.marks = node.marks.map((mark) => (mark.attrs ? { type: mark.type, attrs: mark.attrs } : { type: mark.type }));
  if (node.content && node.content.length > 0) out.content = node.content.map(shapeOf);
  return out;
}

// ---------------------------------------------------------------------------------------------------------------------
// Document → Markdown

/**
 * How the writer sees a document: ProseMirror nodes in the editor, JSON in tests. `original(node)` says whether the
 * node is still exactly what was read (its `src` is then written as it was).
 */
export interface SourceView<N> {
  type(node: N): string;
  attrs(node: N): Record<string, unknown>;
  children(node: N): readonly N[];
  /** A textblock's inline content as JSON (only asked of edited blocks). */
  inline(node: N): RichNode[];
  /** The text of a code-like block (code, math, raw Markdown). */
  text(node: N): string;
  original(node: N): boolean;
}

/** A SourceView of JSON nodes; `original` decides what counts as untouched. */
export function jsonView(original: (node: RichNode) => boolean): SourceView<RichNode> {
  return {
    type: (node) => node.type,
    attrs: (node) => node.attrs ?? {},
    children: (node) => node.content ?? [],
    inline: (node) => node.content ?? [],
    text: (node) => (node.content ?? []).map((child) => child.text ?? "").join(""),
    original,
  };
}

/** The JSON nodes of a document just read, as the untouched ones (tests and the round trip without an editor). */
export function originalsOf(doc: RichNode): (node: RichNode) => boolean {
  const seen = new Map<string, string>();
  const walk = (node: RichNode) => {
    const sig = node.attrs?.sig;
    if (typeof sig === "string") seen.set(sig, JSON.stringify(node));
    node.content?.forEach(walk);
  };
  walk(doc);
  return (node) => {
    const sig = node.attrs?.sig;
    return typeof sig === "string" && seen.get(sig) === JSON.stringify(node);
  };
}

/** What one block wrote: its text (lines joined by its own line breaks) and what the joining looks at. */
interface Emitted {
  text: string;
  /** The line break after it ("" at the end of what was read: a node after it gets "\n"). */
  eol: string;
  kind: "paragraph" | "list" | "table" | "hr" | "other";
}

export interface SerializeOptions {
  /** Whether the blocks are the page's top level (a rule may then touch the start or the end). Default true. */
  edges?: boolean;
}

/**
 * The Markdown of the document, and the line each top-level block starts on (the editors' caret mapping): untouched
 * blocks as they were read, the others in the canonical form.
 */
export function serializePage<N>(doc: N, view: SourceView<N>, options: SerializeOptions = {}): { text: string; starts: number[] } {
  const emitted = emitBlocks(view.children(doc), view);
  return joinEmitted(emitted, view, options.edges ?? true);
}

/**
 * M151: whether blocks written as they are (untouched ones as their `src`) read back as what the editor shows, there
 * (`depth`: inside that many callouts / toggles). Blocks moved keep their source only where this holds: a line's
 * source can read differently beside other lines (a lone `:::` closes an opener lines above it). Compared as shown:
 * each block's kind and text, list lines at the level and number the renderer gives them, blank lines left out.
 */
export function readsAsShown<N>(nodes: readonly N[], view: SourceView<N>, json: (node: N) => RichNode, depth: number, options: PageParseOptions = {}): boolean {
  let text = joinEmitted(emitBlocks(nodes, view), view, false).text;
  for (let k = 0; k < depth; k++) text = `::: callout\n${text}\n:::`;
  let read = pageToDoc(text, options).content ?? [];
  for (let k = 0; k < depth; k++) read = read.length === 1 && read[0]!.type === "callout" ? (read[0]!.content ?? []) : [];
  return JSON.stringify(shownBlocks(read)) === JSON.stringify(shownBlocks(nodes.map(json)));
}

/** What blocks show (see readsAsShown): marks and how a line is spelled do not depend on the lines around it. */
function shownBlocks(nodes: readonly RichNode[]): unknown[] {
  const out: unknown[] = [];
  const lists = new Map<RichNode, { level: number; number: number }>();
  for (let k = 0; k < nodes.length; ) {
    let end = k;
    while (end < nodes.length && nodes[end]!.type === "listLine") end++;
    if (end === k) {
      k++;
      continue;
    }
    const run = nodes.slice(k, end);
    listRun(run.map((node) => ({ kind: String(node.attrs?.kind), level: Number(node.attrs?.level ?? 0), number: node.attrs?.number == null ? null : Number(node.attrs.number) }))).forEach((shown, i) => lists.set(run[i]!, shown));
    k = end;
  }
  for (const node of nodes) {
    if (node.type === "paragraph" && !node.content?.length) continue;
    const attrs = node.attrs ?? {};
    const list = lists.get(node);
    const key = [node.type, attrs.kind ?? null, list?.level ?? attrs.level ?? null, list?.number ?? null, attrs.checked ?? null, typeof attrs.icon === "string" ? attrs.icon.trim() : null, attrs.language ?? null];
    if (node.type === "callout" || node.type === "toggle" || node.type === "blockquote" || node.type === "table" || node.type === "tableRow") out.push([...key, shownBlocks(node.content ?? [])]);
    else out.push([...key, shownText(node)]);
  }
  return out;
}

function shownText(node: RichNode): string {
  if (node.type === "text") return node.text ?? "";
  const attrs = node.attrs ?? {};
  if (node.type === "pageLink") return `[${String(attrs.label ?? "")}](${String(attrs.id ?? "")})`;
  if (typeof attrs.md === "string") return attrs.md;
  if (typeof attrs.tex === "string") return `$${attrs.tex}$`;
  if (node.type === "image" || node.type === "embed") return JSON.stringify([attrs.attachmentId ?? attrs.pageId, attrs.alt ?? attrs.label, attrs.viewId ?? null]);
  return (node.content ?? []).map(shownText).join("");
}

/** Convenience for JSON documents (tests, the Markdown mode's checks): untouched = as `pageToDoc` returned it. */
export function docToPage(doc: RichNode, original: (node: RichNode) => boolean = originalsOf(doc)): string {
  return serializePage(doc, jsonView(original)).text;
}

/** The canonical Markdown of a document (every block written anew). */
export function canonicalPage(doc: RichNode): string {
  return serializePage(doc, jsonView(() => false)).text;
}

function joinEmitted<N>(emitted: readonly Emitted[], _view: SourceView<N>, edges: boolean): { text: string; starts: number[] } {
  let text = "";
  const starts: number[] = [];
  let line = 0;
  let previous: Emitted | null = null;
  let previousLast = "";
  const countLines = (value: string) => (value.match(/\r\n|\r|\n/g)?.length ?? 0);
  for (let i = 0; i < emitted.length; i++) {
    const entry = { ...emitted[i]! };
    const first = entry.text.split(/\r\n|\r|\n/, 1)[0] ?? "";
    // A line under a line with a pipe that reads as a table's separator (as many cells) would make the two a table
    // (never so as read: the renderer would have read a table there).
    if (entry.kind === "paragraph" && (previous?.kind === "paragraph" || previous?.kind === "list") && previousLast.includes("|") && TABLE_SEPARATOR.test(entry.text) && splitTableRow(previousLast).length === splitTableRow(entry.text).length) entry.text = ZWSP + entry.text;
    let blankBefore = false;
    if (previous) {
      // A table takes in the lines with a pipe after it; a rule needs blank lines around it.
      if (previous.kind === "table" && first.trim() !== "" && first.includes("|")) blankBefore = true;
      // M151: a table whose header looks like a separator under a line with a pipe would make that line its header.
      if (entry.kind === "table" && previousLast.includes("|") && TABLE_SEPARATOR.test(first) && splitTableRow(previousLast).length === splitTableRow(first).length) blankBefore = true;
      if (entry.kind === "hr" && previousLast.trim() !== "") blankBefore = true;
      if (previous.kind === "hr" && first.trim() !== "") blankBefore = true;
      let sep = previous.eol || "\n";
      // "\r" then an empty line whose break is "\n" would read as one "\r\n": the break before it becomes "\n".
      if (sep === "\r" && entry.text === "" && i < emitted.length - 1 && (entry.eol || "\n").startsWith("\n")) sep = "\n";
      text += sep;
      line += 1;
      if (blankBefore) {
        text += "\n";
        line += 1;
      }
    } else if (entry.kind === "hr" && !edges) {
      text += "\n";
      line += 1;
    }
    starts.push(line);
    text += entry.text;
    line += countLines(entry.text);
    previous = entry;
    const lines = entry.text.split(/\r\n|\r|\n/);
    previousLast = lines[lines.length - 1] ?? "";
  }
  if (previous?.kind === "hr" && !edges) text += "\n";
  return { text, starts };
}

/** The blocks of one level (the page, a quote, a callout or toggle), each as it was or canonical. */
function emitBlocks<N>(nodes: readonly N[], view: SourceView<N>): Emitted[] {
  const out: Emitted[] = [];
  let list: ListState | null = null;
  for (const node of nodes) {
    const type = view.type(node);
    const attrs = view.attrs(node);
    const eol = typeof attrs.eol === "string" ? attrs.eol : "\n";
    if (type === "listLine") {
      const kind = attrs.kind === "task" ? "task" : "list";
      if (!list || list.kind !== kind) list = newListState(kind);
      out.push({ text: listLineText(node, view, list), eol, kind: "list" });
      continue;
    }
    list = null;
    const kind: Emitted["kind"] = type === "paragraph" ? "paragraph" : type === "table" ? "table" : type === "horizontalRule" ? "hr" : "other";
    if (view.original(node) && typeof attrs.src === "string") {
      out.push({ text: attrs.src, eol, kind });
      continue;
    }
    out.push({ text: canonicalBlock(node, view), eol, kind });
  }
  return out;
}

/** A block written anew (its children may still be written as they were). */
function canonicalBlock<N>(node: N, view: SourceView<N>): string {
  const attrs = view.attrs(node);
  const markers = typeof attrs.markers === "string" ? attrs.markers : "";
  switch (view.type(node)) {
    case "paragraph":
      return blockSafe(serializeLine(view.inline(node), true)) + markers;
    case "heading": {
      const text = serializeLine(view.inline(node), true);
      const level = Math.min(Math.max(Number(attrs.level) || 1, 1), 3);
      return text.trim() === "" ? markers.trimStart() : `${"#".repeat(level)} ${text.trimStart()}${markers}`;
    }
    case "blockquote":
      return quoteText(node, view);
    case "codeBlock": {
      const language = typeof attrs.language === "string" && /^[A-Za-z0-9_+#.-]{1,20}$/.test(attrs.language) ? attrs.language : "";
      return "```" + language + "\n" + view.text(node) + "\n```";
    }
    case "mathBlock": {
      const tex = view.text(node).trim();
      if (!tex) return "";
      return tex.includes("\n") ? `$$\n${tex}\n$$` : `$$${tex}$$`;
    }
    case "rawMarkdown":
      return view.text(node);
    case "table":
      return String(attrs.markdown ?? "");
    case "image":
      return `![${cleanLabel(String(attrs.alt ?? ""))}](attachment:${String(attrs.attachmentId ?? "")})`;
    case "embed":
      return `![${cleanLabel(String(attrs.label ?? ""))}](page:${String(attrs.pageId ?? "")}${attrs.viewId ? `#view=${String(attrs.viewId)}` : ""})`;
    case "horizontalRule":
      return "---";
    case "callout":
    case "toggle":
      return containerText(node, view);
    default:
      return view.text(node);
  }
}

const cleanLabel = (label: string) => label.replace(/[[\]\n]/g, (c) => (c === "[" ? "［" : c === "]" ? "］" : " "));

/** A paragraph line the renderer would read as a block (or a container's line) starts with a zero-width space. */
function blockSafe(line: string): string {
  return HEADING.test(line) || QUOTE.test(line) || BULLET.test(line) || NUMBERED.test(line) || FENCE.test(line) || MATH_START.test(line) || RULE_LINE.test(line) || IMAGE_OR_EMBED.test(line) || CONTAINER_OPEN.test(line) || CONTAINER_CLOSE.test(line) ? ZWSP + line : line;
}

function containerText<N>(node: N, view: SourceView<N>): string {
  const attrs = view.attrs(node);
  const children = view.children(node);
  let opener: string;
  let blocks = children;
  if (view.type(node) === "toggle") {
    const titleNode = children[0] && view.type(children[0]) === "toggleTitle" ? children[0] : null;
    blocks = titleNode ? children.slice(1) : children;
    const title = titleNode ? serializeLine(view.inline(titleNode), true).trim() : "";
    const canonical = `::: toggle${title ? " " + title : ""}`;
    // The opener as it was while the title is unchanged (spaces, the keyword's spacing).
    opener = typeof attrs.openSrc === "string" && sameOpener(attrs.openSrc, canonical) ? attrs.openSrc : canonical;
  } else {
    const icon = typeof attrs.icon === "string" ? attrs.icon.trim() : "";
    const canonical = `::: callout${icon ? " " + icon : ""}`;
    opener = typeof attrs.openSrc === "string" && sameOpener(attrs.openSrc, canonical) ? attrs.openSrc : canonical;
  }
  const inner = joinEmitted(emitBlocks(blocks, view), view, false).text;
  const lastEol = blocks.length > 0 ? String(view.attrs(blocks[blocks.length - 1]!).eol || "\n") : "\n";
  let openEol = typeof attrs.openEol === "string" && attrs.openEol ? attrs.openEol : "\n";
  if (openEol === "\r" && inner === "" && lastEol.startsWith("\n")) openEol = "\n";
  const close = typeof attrs.closeSrc === "string" && CONTAINER_CLOSE.test(attrs.closeSrc) ? attrs.closeSrc : ":::";
  // An empty container (as read, or emptied) is its opener and close only.
  if (inner === "" && blocks.length === 1 && view.type(blocks[0]!) === "paragraph" && view.attrs(blocks[0]!).src == null) return opener + openEol + close;
  return opener + openEol + inner + lastEol + close;
}

/** Whether two opener lines read as the same container with the same icon / title. */
function sameOpener(a: string, b: string): boolean {
  const x = CONTAINER_OPEN.exec(a);
  const y = CONTAINER_OPEN.exec(b);
  return !!x && !!y && x[1] === y[1] && (x[2] ?? "").trim() === (y[2] ?? "").trim();
}

function quoteText<N>(node: N, view: SourceView<N>): string {
  const lines: string[] = [];
  let list: ListState | null = null;
  for (const child of view.children(node)) {
    if (view.type(child) === "listLine") {
      list ??= newListState("list");
      lines.push(`> ${listLineText(child, view, list, true)}`);
      continue;
    }
    list = null;
    const text = serializeLine(view.inline(child), true);
    lines.push(text ? `> ${BULLET.test(text) || NUMBERED.test(text) ? ZWSP + text : text}` : ">");
  }
  return lines.join("\n");
}

// --- lists ------------------------------------------------------------------------------------------------------------

/**
 * The renderer's list reading (markdown.ts `listItems`) run over the lines as they are written, so that a line kept as
 * it was and a line written anew sit at the level and number the editor shows.
 */
interface ListState {
  kind: "list" | "task";
  indents: number[];
  counters: Array<{ ordered: boolean; next: number } | undefined>;
}

const newListState = (kind: "list" | "task"): ListState => ({ kind, indents: [], counters: [] });
const indentWidth = (indent: string) => indent.replace(/\t/g, "    ").length;

/** The level a list line with this indent gets (the state moves on). */
function levelFor(state: ListState, indent: number): number {
  const { indents } = state;
  if (indents.length === 0) indents.push(indent);
  else {
    while (indents.length > 1 && indent < indents[indents.length - 1]!) indents.pop();
    if (indent >= indents[indents.length - 1]! + 2 && indents.length < LIST_LEVELS) indents.push(indent);
  }
  return indents.length - 1;
}

/** The number an item at `level` shows (the state moves on); `written` is what its line says. */
function numberFor(state: ListState, level: number, ordered: boolean, written: number): number {
  state.counters.length = level + 1;
  const counter = state.counters[level];
  const number = !ordered ? 0 : counter?.ordered ? counter.next : written;
  state.counters[level] = { ordered, next: number + 1 };
  return number;
}

/**
 * The numbers and levels of a run of list lines as the renderer draws them (the editor's markers): a level deeper than
 * one past the line before is drawn one past it; a numbered line that starts a run shows its own number (1 when new).
 */
export function listRun(rows: ReadonlyArray<{ kind: string; level: number; number: number | null }>): Array<{ level: number; number: number }> {
  let state: ListState | null = null;
  let depth = 0;
  return rows.map((row) => {
    const kind = row.kind === "task" ? "task" : "list";
    if (!state || state.kind !== kind) {
      state = newListState(kind);
      depth = 0;
    }
    if (kind === "task") return { level: Math.max(0, Math.min(row.level, 1)), number: 0 };
    const level = Math.max(0, Math.min(row.level, depth, LIST_LEVELS - 1));
    depth = level + 1;
    const ordered = row.kind === "ordered";
    return { level, number: numberFor(state, level, ordered, row.number ?? 1) };
  });
}

/** One list line: as it was when untouched and still at its level and number, else written anew. */
function listLineText<N>(node: N, view: SourceView<N>, state: ListState, quoted = false): string {
  const attrs = view.attrs(node);
  const kind = attrs.kind === "task" ? "task" : attrs.kind === "ordered" ? "ordered" : "bullet";
  const markers = typeof attrs.markers === "string" ? attrs.markers : "";
  const src = !quoted && view.original(node) && typeof attrs.src === "string" ? attrs.src : null;
  if (kind === "task") {
    const level = Math.min(Math.max(Number(attrs.level) || 0, 0), 1);
    if (src !== null) {
      const match = TASK_LINE.exec(stripTaskMarkers(src));
      if (match && (indentWidth(match[1] ?? "") >= 2 ? 1 : 0) === level) return src;
    }
    const text = serializeLine(view.inline(node), true);
    return `${level > 0 ? "  " : ""}- [${attrs.checked ? "x" : " "}] ${text}${markers}`;
  }
  const ordered = kind === "ordered";
  const wanted = Math.max(0, Math.min(Number(attrs.level) || 0, state.indents.length, LIST_LEVELS - 1));
  if (src !== null) {
    const line = stripTaskMarkers(src);
    const numbered = NUMBERED.exec(line);
    const bullet = numbered ? null : BULLET.exec(line);
    const row = numbered ? { indent: indentWidth(numbered[1] ?? ""), ordered: true, written: Number(numbered[2]) } : bullet ? { indent: indentWidth(bullet[1] ?? ""), ordered: false, written: 0 } : null;
    if (row && row.ordered === ordered) {
      // Tried on a copy: the line is kept only where the renderer puts it at the same level and number.
      const trial: ListState = { kind: "list", indents: [...state.indents], counters: [...state.counters] };
      const level = levelFor(trial, row.indent);
      const number = numberFor(trial, level, ordered, row.written);
      const expected = ordered ? numberFor({ kind: "list", indents: [], counters: [...state.counters] }, wanted, true, Number(attrs.number ?? 1) || 1) : 0;
      if (level === wanted && (!ordered || number === expected)) {
        state.indents = trial.indents;
        state.counters = trial.counters;
        return src;
      }
    }
  }
  // Written anew: the indent the renderer reads as `wanted` after the lines before (the same as a sibling's, or two
  // past the parent's), the number it counts.
  const indent = state.indents.length === 0 ? 0 : wanted < state.indents.length ? state.indents[wanted]! : state.indents[state.indents.length - 1]! + 2;
  const level = levelFor(state, indent);
  const number = numberFor(state, level, ordered, Number(attrs.number ?? 1) || 1);
  let text = serializeLine(view.inline(node), true);
  if (!ordered && TASK_TEXT.test(text)) text = ZWSP + text; // "- [ ] x" typed as a bullet's text is not a checklist
  return `${" ".repeat(indent)}${ordered ? `${number}. ` : "- "}${text}${markers}`;
}

// ---------------------------------------------------------------------------------------------------------------------
// Merges coming in

/**
 * The top-level blocks a new body changes: the old document's blocks that are still what they were read as and match
 * the new body's blocks at the start and the end stay; the rest (`from` up to `to` in the old, `nodes` from the new) is
 * replaced. Null when nothing changed.
 */
export function changedRange<N>(oldBlocks: readonly N[], view: SourceView<N>, newBlocks: readonly RichNode[]): { from: number; to: number; nodes: RichNode[] } | null {
  const same = (old: N, fresh: RichNode) => {
    const attrs = view.attrs(old);
    return view.original(old) && attrs.src === fresh.attrs?.src && view.type(old) === fresh.type && (attrs.eol ?? "") === (fresh.attrs?.eol ?? "");
  };
  let head = 0;
  while (head < oldBlocks.length && head < newBlocks.length && same(oldBlocks[head]!, newBlocks[head]!)) head++;
  let tail = 0;
  while (tail < oldBlocks.length - head && tail < newBlocks.length - head && same(oldBlocks[oldBlocks.length - 1 - tail]!, newBlocks[newBlocks.length - 1 - tail]!)) tail++;
  if (head === oldBlocks.length && head === newBlocks.length) return null;
  return { from: head, to: oldBlocks.length - tail, nodes: newBlocks.slice(head, newBlocks.length - tail) };
}
