/**
 * Message body format (DATA_MODEL.md "本文の形式"): plain text with mention tokens plus a light
 * markdown subset shared by the three clients. This is a tokenizer, not an HTML renderer: React
 * escapes everything.
 *
 * Inline: **bold** / *bold*, _italic_ (never inside a word, M107), ~~strike~~, `code`, [label](url), bare https?:// links,
 * e-mail addresses (text, never read for emphasis), \_ \* \~ \` \$ escapes, $TeX$ math (apps/shared/math.json),
 * <@user-id>, <@group:group-id> (M12k), <!channel> / <!here>. Blocks: "# " … "### " headings, ``` fences (optional language),
 * "> " quotes, "- " / "* " bullets, "1. " numbered items (nested by indenting 2–4 spaces or a tab, three levels;
 * numbering and markers in `listItems`, apps/shared/lists.json), "$$" display math, and (M15g) GFM tables: a "| a | b |" header, a "| --- | :-: |" separator, then "| … |" rows.
 *
 * The canvas dialect (CANVAS.md §4.2, `{ canvas: true }`) adds tasks ("- [ ] item" / "- [x] item", "*" too, two leading
 * spaces nest), images of the canvas ("![alt](attachment:<uuid>)" on a line of its own; other image URLs stay text) and
 * rules ("---" between blank lines). Messages keep showing all of these as text. apps/shared/canvas_markdown.json holds
 * the cases the three clients share. M80: the hidden task markers (` <!--task:<id>-->`, canvasMarkers.ts) are left out
 * in the canvas dialect.
 */
import { stripTaskMarkers } from "./canvasMarkers";
import { t } from "../i18n";

export type Token =
  | { kind: "text"; text: string }
  | { kind: "bold"; text: string }
  | { kind: "italic"; text: string }
  | { kind: "strike"; text: string }
  | { kind: "code"; text: string }
  | { kind: "codeblock"; text: string; lang?: string | null }
  | { kind: "link"; url: string; label?: string }
  | { kind: "mention"; userId: string }
  | { kind: "mention_group"; groupId: string }
  | { kind: "mention_all"; target: string }
  /** TeX math (apps/shared/math.json): `text` is the formula as written; `display` for `$$…$$` within a line. */
  | { kind: "math"; text: string; display: boolean }
  | { kind: "newline" };

export type Block =
  | { kind: "heading"; level: 1 | 2 | 3; tokens: Token[]; /** canvas: its line in the body */ line?: number }
  | { kind: "paragraph"; lines: Token[][] }
  | { kind: "quote"; lines: Token[][] }
  /** `ordered` / `start`: the first item's (a top-level item of the other kind starts a new list). */
  | { kind: "list"; ordered: boolean; start: number; items: ListItem[] }
  | { kind: "codeblock"; text: string; lang: string | null }
  /** Display math: `$$…$$` on a line (or lines) of its own (apps/shared/math.json). */
  | { kind: "math"; tex: string }
  | { kind: "table"; align: TableAlign[]; header: Token[][]; rows: Token[][][] }
  // The canvas dialect (CANVAS.md §4.2): `line` is the item's line in the body (0-based), which a tick changes.
  | { kind: "task"; items: TaskItem[] }
  | { kind: "image"; alt: string; attachmentId: string; line: number }
  | { kind: "hr" };

/** One list item (apps/shared/lists.json): its level (0–2), its kind, its number (0 for a bullet) and the marker drawn. */
export interface ListItem {
  level: number;
  ordered: boolean;
  number: number;
  marker: string;
  tokens: Token[];
}

export interface TaskItem {
  level: number;
  done: boolean;
  tokens: Token[];
  line: number;
}

export interface ParseOptions {
  /** The canvas dialect: tasks, images and rules. */
  canvas?: boolean;
}

/** A task line, as the server counts it (server/app/modules/canvases/service.py TASK_LINE). */
export const TASK_LINE = /^([ \t]*)[-*] \[([ xX])\](?: (.*))?$/;
const IMAGE_LINE = /^!\[([^\]\n]*)\]\(attachment:([0-9a-f-]{36})\)\s*$/i; // M44: an upper-case id too (Swift writes one)
const RULE_LINE = /^-{3,}\s*$/;

/** M15g: a column's alignment from its separator cell (":--" left, ":-:" center, "--:" right). */
export type TableAlign = "left" | "center" | "right" | null;

// M107 (apps/shared/inline-format.json): `_` emphasis follows CommonMark's word rule: the closing `_` is not followed by a
// letter, digit or `_` (the lookahead) and the opening one is not preceded by one (checked in `scan`; no lookbehind for
// older WebKit), so snake_case and e-mail addresses stay as they are. `\_` `\*` `\~` `` \` `` are the literal character
// (also inside emphasis). E-mail addresses (and the shrug ¯\_(ツ)_/¯, which keeps its backslash) are text tokens of
// their own, so emphasis and escapes are never read inside them.
const INLINE =
  /(\*\*((?:\\.|[^*\n\\])+?)\*\*)|(``(?!`)(?:[^`\n]|`(?!`))+?``(?!`)|`([^`\n]+)`)|(\*((?:\\.|[^*\n\\])+)\*)|(_(?![\s\u3000_])((?:\\.|[^\n\\])*?(?:\\.|[^\s\u3000_\\]))_(?![\p{L}\p{N}_]))|(~~((?:\\.|[^~\n\\])+)~~)|(\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\))|(<@group:([0-9a-f-]{36})>)|(<@([0-9a-f-]{36})>)|(<!(channel|here)>)|(https?:\/\/[^\s<>]+)|(\\([_*~`$]))|([A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9-]{1,63}(?:\.[A-Za-z0-9-]{1,63}){1,8}|¯\\_\(ツ\)_\/¯)|(\$\$((?:\\.|[^$\n\\])+?)\$\$)|(\$(?![\s$])((?:\\.|[^$\n\\])*?(?:\\.|[^\s$\\]))\$(?![0-9A-Za-z]))/gu;
const WITH_BLOCKS = new RegExp(`(\`\`\`([\\s\\S]*?)\`\`\`)|${INLINE.source}|(\\n)`, "gu");
const WORD_BEFORE = /[\p{L}\p{N}_]$/u;

/**
 * TeX math (apps/shared/math.json, DATA_MODEL.md 「本文の形式」). Inline `$…$` as Pandoc reads it: the opening `$` is
 * followed by a non-space, the closing one preceded by a non-space and not followed by a digit (nor an ASCII letter, so
 * `$HOME and $PATH` stays text), so prices ($5 and $10) are not math. `$$…$$` within a line is math too; on a line (or
 * lines, no blank line between) of its own it is a display block (`mathBlockAt`). `\$` is a dollar; code spans, code
 * blocks and URLs are never read for math; an unmatched `$` stays as it is. A formula longer than this stays text.
 */
export const MATH_MAX_LENGTH = 2000;

/** Display math starting at `lines[index]`: its formula and its last line, or null when the line opens none. */
export function mathBlockAt(lines: readonly string[], index: number): { tex: string; end: number } | null {
  const first = (lines[index] ?? "").trim();
  if (!first.startsWith("$$")) return null;
  const done = (tex: string, end: number) => {
    const trimmed = tex.trim();
    return trimmed === "" || trimmed.length > MATH_MAX_LENGTH ? null : { tex: trimmed, end };
  };
  if (first.length >= 4 && first.endsWith("$$")) {
    const tex = first.slice(2, -2);
    return tex.includes("$$") ? null : done(tex, index);
  }
  const head = first.slice(2);
  if (head.includes("$$")) return null;
  for (let k = index + 1; k < lines.length; k++) {
    const line = lines[k] ?? "";
    const trimmed = line.trim();
    if (trimmed === "") return null; // a blank line ends the search: the $$ was not math
    if (!trimmed.includes("$$")) continue;
    const tail = trimmed.slice(0, -2);
    if (!trimmed.endsWith("$$") || tail.includes("$$")) return null;
    return done([head, ...lines.slice(index + 1, k), tail].join("\n"), k);
  }
  return null;
}
const ESCAPED = /\\([_*~`$])/g;

/** Whole-body tokens (inline markup, fenced code and newlines); kept for highlighting and old callers. */
export function tokenize(body: string): Token[] {
  return scan(body, new RegExp(WITH_BLOCKS.source, "gu"), true);
}

/** Inline tokens of one line (no fences, no newlines). */
export function tokenizeInline(line: string): Token[] {
  return scan(line, new RegExp(INLINE.source, "gu"), false);
}

function scan(body: string, pattern: RegExp, withBlocks: boolean): Token[] {
  const tokens: Token[] = [];
  const text = (value: string) => {
    if (value === "") return;
    const previous = tokens[tokens.length - 1];
    if (previous?.kind === "text") previous.text += value;
    else tokens.push({ kind: "text", text: value });
  };
  const unescape = (value: string) => value.replace(ESCAPED, "$1");
  let last = 0;
  pattern.lastIndex = 0;
  for (let match = pattern.exec(body); match !== null; match = pattern.exec(body)) {
    const index = match.index;
    // The fence groups exist only in WITH_BLOCKS; shift the inline group indices accordingly.
    const groups = match;
    const g = (n: number) => groups[withBlocks ? n + 2 : n];
    if (g(7) !== undefined && WORD_BEFORE.test(body.slice(Math.max(0, index - 2), index))) {
      // An underscore inside a word never opens emphasis: it stays text and the scan goes on after it.
      pattern.lastIndex = index + 1;
      continue;
    }
    text(body.slice(last, index));
    if (withBlocks && match[1] !== undefined) {
      const fenced = splitFence(match[2] ?? "");
      tokens.push({ kind: "codeblock", text: fenced.text, lang: fenced.lang });
    } else if (g(1) !== undefined) tokens.push({ kind: "bold", text: unescape(g(2) ?? "") });
    else if (g(3) !== undefined) tokens.push({ kind: "code", text: codeSpan(g(3) ?? "", g(4)) });
    else if (g(5) !== undefined) tokens.push({ kind: "bold", text: unescape(g(6) ?? "") });
    else if (g(7) !== undefined) tokens.push({ kind: "italic", text: unescape(g(8) ?? "") });
    else if (g(9) !== undefined) tokens.push({ kind: "strike", text: unescape(g(10) ?? "") });
    else if (g(11) !== undefined) tokens.push({ kind: "link", url: g(13) ?? "", label: g(12) ?? "" });
    else if (g(14) !== undefined) tokens.push({ kind: "mention_group", groupId: g(15) ?? "" });
    else if (g(16) !== undefined) tokens.push({ kind: "mention", userId: g(17) ?? "" });
    else if (g(18) !== undefined) tokens.push({ kind: "mention_all", target: g(19) ?? "" });
    else if (g(20) !== undefined) tokens.push({ kind: "link", url: g(20) ?? "" });
    else if (g(21) !== undefined) text(g(22) ?? "");
    else if (g(23) !== undefined) text(g(23) ?? "");
    else if (g(24) !== undefined || g(26) !== undefined) {
      // TeX math: too long or blank, it stays the text it was.
      const tex = g(24) !== undefined ? (g(25) ?? "") : (g(27) ?? "");
      if (tex.length > MATH_MAX_LENGTH || tex.trim() === "") text(match[0]);
      else tokens.push({ kind: "math", text: tex, display: g(24) !== undefined });
    } else tokens.push({ kind: "newline" });
    last = index + match[0].length;
  }
  text(body.slice(last));
  return tokens;
}

/**
 * The text of an inline code span (apps/shared/inline-format.json): `single` is the text between single backticks;
 * otherwise `whole` is a ``double`` span, which may hold a backtick, and loses one space at each end when it has one at
 * both (CommonMark: "`` ` ``" is a backtick).
 */
function codeSpan(whole: string, single: string | undefined): string {
  if (single !== undefined) return straightQuotes(single);
  const inner = whole.slice(2, -2);
  const trimmed = inner.length >= 2 && inner.startsWith(" ") && inner.endsWith(" ") && inner.trim() !== "" ? inner.slice(1, -1) : inner;
  return straightQuotes(trimmed);
}

/**
 * Code shows the quotes a keyboard curled back straight (2026-10-06): iOS's smart punctuation and the Japanese keyboards
 * turn ' and " into ‘ ’ “ ”, so `it's` arrived as `it’s` (apps/shared/inline-format.json, code_blocks too).
 */
export function straightQuotes(text: string): string {
  return /[‘’“”]/.test(text) ? text.replace(/[‘’]/g, "'").replace(/[“”]/g, '"') : text;
}

/** "lang\ncode" → language tag and code; a fence without a language keeps the whole text. */
function splitFence(raw: string): { text: string; lang: string | null } {
  const match = /^([A-Za-z0-9_+#.-]{1,20})?\n([\s\S]*)$/.exec(raw);
  if (match && match[1] !== undefined) return { lang: match[1].toLowerCase(), text: straightQuotes((match[2] ?? "").replace(/\n$/, "")) };
  return { lang: null, text: straightQuotes(raw.replace(/^\n|\n$/g, "")) };
}

const BULLET = /^(\s*)[-*•]\s+(.*)$/;
const NUMBERED = /^(\s*)(\d{1,3})\.\s+(.*)$/;
const QUOTE = /^>\s?(.*)$/;
const TABLE_SEPARATOR = /^[ \t]*\|?[ \t]*:?-+:?[ \t]*(?:\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*$/;

/** M15g: the cells of a table row; "\|" is a literal pipe, outer pipes are optional. */
export function splitTableRow(line: string): string[] {
  let text = line.trim();
  if (text.startsWith("|")) text = text.slice(1);
  if (text.endsWith("|") && !text.endsWith("\\|")) text = text.slice(0, -1);
  const cells: string[] = [];
  let current = "";
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === "\\" && text[i + 1] === "|") {
      current += "|";
      i++;
    } else if (ch === "|") {
      cells.push(current.trim());
      current = "";
    } else {
      current += ch;
    }
  }
  cells.push(current.trim());
  return cells;
}

function tableAlign(cell: string): TableAlign {
  const left = cell.startsWith(":");
  const right = cell.endsWith(":");
  return left && right ? "center" : right ? "right" : left ? "left" : null;
}
const HEADING = /^(#{1,3})\s+(\S.*)$/;

/** Block structure for rendering: paragraphs, quotes, lists and fenced code, in order. */
export function parseBlocks(body: string, options: ParseOptions = {}): Block[] {
  return parseBlocksWithLines(body, options).blocks;
}

/** The lines of the body a block came from: `from` (0-based) up to, not including, `to`. */
export interface BlockLines {
  from: number;
  to: number;
}

/**
 * parseBlocks with each block's source lines beside it (`lines[k]` belongs to `blocks[k]`): the canvas editor's
 * scroll sync (ui/canvasScrollSync.ts) matches the preview's blocks to the editor's lines with them. Every line of the
 * body is in exactly one block, in order.
 */
export function parseBlocksWithLines(body: string, options: ParseOptions = {}): { blocks: Block[]; lines: BlockLines[] } {
  const blocks: Block[] = [];
  const ranges: BlockLines[] = [];
  const canvas = options.canvas === true;
  // M80 (CANVAS.md §22): a canvas's hidden task markers are never shown (each line keeps its place).
  const lines = body.replace(/\r\n?/g, "\n").split("\n").map((line) => (canvas ? stripTaskMarkers(line) : line));
  let i = 0;
  let start = 0;
  /** A block from `from` (the line the construct began on, by default) to the current line. */
  const push = (block: Block, from = start) => {
    blocks.push(block);
    ranges.push({ from, to: i });
  };
  const blank = (index: number) => index < 0 || index >= lines.length || (lines[index] ?? "").trim() === "";
  const isTask = (index: number) => canvas && TASK_LINE.test(lines[index] ?? "");
  const isImage = (index: number) => canvas && IMAGE_LINE.test(lines[index] ?? "");
  const isRule = (index: number) => canvas && RULE_LINE.test(lines[index] ?? "") && blank(index - 1) && blank(index + 1);
  const FENCE = /^```([A-Za-z0-9_+#.-]{0,20})\s*$/;
  // A fence opens a code block only when a closing ``` line follows; otherwise it is ordinary text.
  const fenceCloseAfter = (index: number) => lines.findIndex((l, k) => k > index && /^```\s*$/.test(l));
  const opensFence = (index: number) => FENCE.test(lines[index] ?? "") && fenceCloseAfter(index) !== -1;
  // M15g: a header row with a pipe, directly followed by a separator with as many cells.
  const opensTable = (index: number) => {
    const header = lines[index] ?? "";
    const separator = lines[index + 1] ?? "";
    return header.includes("|") && TABLE_SEPARATOR.test(separator) && splitTableRow(header).length === splitTableRow(separator).length;
  };
  while (i < lines.length) {
    start = i;
    const line = lines[i] ?? "";
    if (opensFence(i)) {
      const fence = FENCE.exec(line);
      const close = fenceCloseAfter(i);
      i = close + 1;
      push({ kind: "codeblock", text: straightQuotes(lines.slice(start + 1, close).join("\n")), lang:fence?.[1] ? fence[1].toLowerCase() : null });
      continue;
    }
    const math = mathBlockAt(lines, i);
    if (math) {
      i = math.end + 1;
      push({ kind: "math", tex: math.tex });
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading) {
      i++;
      push({ kind: "heading", level: (heading[1] ?? "#").length as 1 | 2 | 3, tokens: tokenizeInline(heading[2] ?? ""), ...(canvas ? { line: start } : {}) });
      continue;
    }
    if (isTask(i)) {
      const items: TaskItem[] = [];
      while (i < lines.length && isTask(i)) {
        const m = TASK_LINE.exec(lines[i] ?? "")!;
        const indent = (m[1] ?? "").replace(/\t/g, "  ").length;
        items.push({ level: indent >= 2 ? 1 : 0, done: m[2] !== " ", tokens: tokenizeInline(m[3] ?? ""), line: i });
        i++;
      }
      push({ kind: "task", items });
      continue;
    }
    if (isImage(i)) {
      const m = IMAGE_LINE.exec(line)!;
      i++;
      push({ kind: "image", alt: m[1] ?? "", attachmentId: (m[2] ?? "").toLowerCase(), line: start });
      continue;
    }
    if (isRule(i)) {
      i++;
      push({ kind: "hr" });
      continue;
    }
    const quote = QUOTE.exec(line);
    if (quote) {
      const quoted: Token[][] = [];
      while (i < lines.length) {
        const q = QUOTE.exec(lines[i] ?? "");
        if (!q) break;
        quoted.push(tokenizeInline(q[1] ?? ""));
        i++;
      }
      push({ kind: "quote", lines: quoted });
      continue;
    }
    if (opensTable(i)) {
      const header = splitTableRow(line);
      const align = splitTableRow(lines[i + 1] ?? "").map(tableAlign);
      const rows: Token[][][] = [];
      i += 2;
      while (i < lines.length && (lines[i] ?? "").includes("|") && (lines[i] ?? "").trim() !== "") {
        const cells = splitTableRow(lines[i] ?? "");
        rows.push(header.map((_, c) => tokenizeInline(cells[c] ?? ""))); // short rows pad, long rows are cut (GFM)
        i++;
      }
      push({ kind: "table", align, header: header.map((cell) => tokenizeInline(cell)), rows });
      continue;
    }
    if (listLine(line)) {
      const rows: ListLine[] = [];
      while (i < lines.length && !isTask(i)) {
        const row = listLine(lines[i] ?? "");
        if (!row) break;
        rows.push(row);
        i++;
      }
      // A top-level item of the other kind starts a new list (as in CommonMark).
      const items = listItems(rows);
      let from = 0;
      for (let k = 1; k <= items.length; k++) {
        if (k < items.length && !(items[k]!.level === 0 && items[k]!.ordered !== items[from]!.ordered)) continue;
        const run = items.slice(from, k);
        blocks.push({ kind: "list", ordered: run[0]!.ordered, start: run[0]!.ordered ? run[0]!.number : 1, items: run });
        ranges.push({ from: start + from, to: start + k }); // one item per line
        from = k;
      }
      continue;
    }
    // Paragraph: consecutive ordinary lines (blank lines stay as empty lines inside it).
    const paragraph: Token[][] = [];
    while (i < lines.length) {
      const current = lines[i] ?? "";
      if (paragraph.length > 0 && (opensFence(i) || opensTable(i) || HEADING.test(current) || QUOTE.test(current) || BULLET.test(current) || NUMBERED.test(current) || isImage(i) || isRule(i) || mathBlockAt(lines, i))) break;
      paragraph.push(tokenizeInline(current));
      i++;
    }
    push({ kind: "paragraph", lines: paragraph });
  }
  return { blocks, lines: ranges };
}

/** A list line: its indent (a tab is 4 columns), its kind, the number written ("3." → 3) and its text. */
interface ListLine {
  indent: number;
  ordered: boolean;
  written: number;
  text: string;
}

function listLine(line: string): ListLine | null {
  const numbered = NUMBERED.exec(line);
  if (numbered) return { indent: indentWidth(numbered[1] ?? ""), ordered: true, written: Number(numbered[2]), text: numbered[3] ?? "" };
  const bullet = BULLET.exec(line);
  if (bullet) return { indent: indentWidth(bullet[1] ?? ""), ordered: false, written: 0, text: bullet[2] ?? "" };
  return null;
}

const indentWidth = (indent: string) => indent.replace(/\t/g, "    ").length;

/** Three levels: 1. a. i. for numbers, • ◦ ▪ for bullets (apps/shared/lists.json). */
export const LIST_LEVELS = 3;

/**
 * Levels, numbers and markers of consecutive list lines (apps/shared/lists.json, the same in the three clients). An item
 * indented 2 or more columns past the one before nests one level deeper (2–4 spaces or a tab, at most three levels); a
 * smaller indent goes back to the level it matches. Each run of items at one level under one parent is a list of its
 * own: it starts at the number its first item is written with ("3." starts at 3) and counts on from there whatever the
 * others say ("1. 1. 1." is 1, 2, 3); a run of the other kind (bullets among numbers) starts again. Level 1 numbers are
 * 1. 2. 3., level 2 a. b. c., level 3 i. ii. iii.; bullets • ◦ ▪.
 */
function listItems(rows: readonly ListLine[]): ListItem[] {
  const indents: number[] = [];
  const counters: Array<{ ordered: boolean; next: number } | undefined> = [];
  return rows.map((row) => {
    if (indents.length === 0) indents.push(row.indent);
    else {
      while (indents.length > 1 && row.indent < indents[indents.length - 1]!) indents.pop();
      if (row.indent >= indents[indents.length - 1]! + 2 && indents.length < LIST_LEVELS) indents.push(row.indent);
    }
    const level = indents.length - 1;
    counters.length = level + 1; // the lists deeper than this item end here
    const counter = counters[level];
    const number = !row.ordered ? 0 : counter?.ordered ? counter.next : row.written;
    counters[level] = { ordered: row.ordered, next: number + 1 };
    return { level, ordered: row.ordered, number, marker: listMarker(row.ordered, level, number), tokens: tokenizeInline(row.text) };
  });
}

/** "1." / "a." / "i." by level (a number below 1 stays decimal, as CSS does), "•" / "◦" / "▪" for bullets. */
export function listMarker(ordered: boolean, level: number, number: number): string {
  if (!ordered) return ["•", "◦", "▪"][Math.min(level, 2)]!;
  if (level === 1 && number >= 1) return `${alpha(number)}.`;
  if (level >= 2 && number >= 1 && number < 4000) return `${roman(number)}.`;
  return `${number}.`;
}

/** 1 → a, 26 → z, 27 → aa (CSS lower-alpha). */
function alpha(n: number): string {
  let out = "";
  for (let k = n; k > 0; k = Math.floor((k - 1) / 26)) out = String.fromCharCode(97 + ((k - 1) % 26)) + out;
  return out;
}

/** 4 → iv (CSS lower-roman). */
function roman(n: number): string {
  const table: Array<[number, string]> = [[1000, "m"], [900, "cm"], [500, "d"], [400, "cd"], [100, "c"], [90, "xc"], [50, "l"], [40, "xl"], [10, "x"], [9, "ix"], [5, "v"], [4, "iv"], [1, "i"]];
  let out = "";
  let k = n;
  for (const [value, letters] of table) for (; k >= value; k -= value) out += letters;
  return out;
}

/** How a paragraph block is drawn (apps/shared/body-paragraphs.json, the same in the three clients). */
export interface ParagraphLayout {
  /** Blank lines before / after it: a paragraph gap there, separating it from the block before / after. */
  gapBefore: boolean;
  gapAfter: boolean;
  /** The runs of lines between blank lines; empty when the paragraph is only blank lines (then it is one gap). */
  groups: Token[][][];
}

/**
 * 2026-10-05: one newline is a line break; one or more blank lines are a paragraph gap (about 0.4 of a line) rather
 * than empty lines, several blank lines collapsing into one gap (as in Slack and markdown). A line of spaces is blank.
 */
export function paragraphLayout(lines: Token[][]): ParagraphLayout {
  const blank = (tokens: Token[]) => tokens.every((token) => token.kind === "text" && token.text.trim() === "");
  const groups: Token[][][] = [];
  let current: Token[][] = [];
  for (const row of lines) {
    if (blank(row)) {
      if (current.length > 0) groups.push(current);
      current = [];
    } else current.push(row);
  }
  if (current.length > 0) groups.push(current);
  if (groups.length === 0) return { gapBefore: false, gapAfter: false, groups };
  return { gapBefore: blank(lines[0]!), gapAfter: blank(lines[lines.length - 1]!), groups };
}

/** One-line plain text for notifications and previews: markers removed, newlines collapsed. */
export function plainText(body: string, maxLength = 200): string {
  const text = body
    .replace(/^```[A-Za-z0-9_+#.-]*\s*$/gm, "")
    .replace(/^[ \t]*\|?[ \t]*:?-+:?[ \t]*(?:\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*$/gm, "") // M15g: table separators
    .replace(/^[ \t]*\|(.*)\|[ \t]*$/gm, (_, inner: string) => inner.split("|").map((cell) => cell.trim()).join(" "))
    .replace(/^(#{1,3})\s+/gm, "")
    .replace(/^>\s?/gm, "")
    .replace(/^\s*(?:[-*•]|\d{1,3}\.)\s+/gm, "")
    // M107: the inline markers are those the tokenizer reads (apps/shared/inline-format.json), not patterns of their own.
    .split("\n")
    .map((line) => tokenizeInline(line).map(inlineText).join(""))
    .join("\n")
    .replace(/\s*\n+\s*/g, " ")
    .trim();
  return text.length > maxLength ? text.slice(0, maxLength - 1) + "…" : text;
}

/** What a reader sees of an inline token as text; mention tokens stay as they are (callers name them first). */
function inlineText(token: Token): string {
  switch (token.kind) {
    case "link":
      return token.label || token.url;
    case "mention":
      return `<@${token.userId}>`;
    case "mention_group":
      return `<@group:${token.groupId}>`;
    case "mention_all":
      return `<!${token.target}>`;
    case "newline":
      return "\n";
    case "math":
      return token.display ? `$$${token.text}$$` : `$${token.text}$`; // the source as written (apps/shared/math.json)
    default:
      return token.text;
  }
}

/**
 * What a message without text sent, for notifications and one-line excerpts (tester, 2026-09-30: 「画像を送信」 rather
 * than 「新しいメッセージ」). The server's push and the phones use the same words. "" without attachments.
 */
export function attachmentText(attachments: ReadonlyArray<{ content_type: string }> | undefined): string {
  const n = attachments?.length ?? 0;
  if (!attachments || n === 0) return "";
  if (attachments.every((a) => a.content_type.startsWith("image/"))) return n === 1 ? t("sent.image") : t("sent.images", { count: n });
  if (attachments.every((a) => a.content_type.startsWith("video/"))) return n === 1 ? t("sent.video") : t("sent.videos", { count: n });
  return n === 1 ? t("sent.file") : t("sent.files", { count: n });
}
