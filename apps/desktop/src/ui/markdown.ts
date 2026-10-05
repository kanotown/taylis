/**
 * Message body format (DATA_MODEL.md "本文の形式"): plain text with mention tokens plus a light
 * markdown subset shared by the three clients. This is a tokenizer, not an HTML renderer: React
 * escapes everything.
 *
 * Inline: **bold** / *bold*, _italic_ (never inside a word, M107), ~~strike~~, `code`, [label](url), bare https?:// links,
 * e-mail addresses (text, never read for emphasis), \_ \* \~ \` escapes,
 * <@user-id>, <@group:group-id> (M12k), <!channel> / <!here>. Blocks: "# " … "### " headings, ``` fences (optional language),
 * "> " quotes, "- " / "* " bullets, "1. " numbered items (two leading spaces nest one level),
 * and (M15g) GFM tables: a "| a | b |" header, a "| --- | :-: |" separator, then "| … |" rows.
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
  | { kind: "newline" };

export type Block =
  | { kind: "heading"; level: 1 | 2 | 3; tokens: Token[]; /** canvas: its line in the body */ line?: number }
  | { kind: "paragraph"; lines: Token[][] }
  | { kind: "quote"; lines: Token[][] }
  | { kind: "list"; ordered: boolean; start: number; items: Array<{ level: number; tokens: Token[] }> }
  | { kind: "codeblock"; text: string; lang: string | null }
  | { kind: "table"; align: TableAlign[]; header: Token[][]; rows: Token[][][] }
  // The canvas dialect (CANVAS.md §4.2): `line` is the item's line in the body (0-based), which a tick changes.
  | { kind: "task"; items: TaskItem[] }
  | { kind: "image"; alt: string; attachmentId: string; line: number }
  | { kind: "hr" };

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
  /(\*\*((?:\\.|[^*\n\\])+?)\*\*)|(`([^`\n]+)`)|(\*((?:\\.|[^*\n\\])+)\*)|(_(?![\s\u3000_])((?:\\.|[^\n\\])*?(?:\\.|[^\s\u3000_\\]))_(?![\p{L}\p{N}_]))|(~~((?:\\.|[^~\n\\])+)~~)|(\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\))|(<@group:([0-9a-f-]{36})>)|(<@([0-9a-f-]{36})>)|(<!(channel|here)>)|(https?:\/\/[^\s<>]+)|(\\([_*~`]))|([A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9-]{1,63}(?:\.[A-Za-z0-9-]{1,63}){1,8}|¯\\_\(ツ\)_\/¯)/gu;
const WITH_BLOCKS = new RegExp(`(\`\`\`([\\s\\S]*?)\`\`\`)|${INLINE.source}|(\\n)`, "gu");
const WORD_BEFORE = /[\p{L}\p{N}_]$/u;
const ESCAPED = /\\([_*~`])/g;

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
    else if (g(3) !== undefined) tokens.push({ kind: "code", text: g(4) ?? "" });
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
    else tokens.push({ kind: "newline" });
    last = index + match[0].length;
  }
  text(body.slice(last));
  return tokens;
}

/** "lang\ncode" → language tag and code; a fence without a language keeps the whole text. */
function splitFence(raw: string): { text: string; lang: string | null } {
  const match = /^([A-Za-z0-9_+#.-]{1,20})?\n([\s\S]*)$/.exec(raw);
  if (match && match[1] !== undefined) return { lang: match[1].toLowerCase(), text: (match[2] ?? "").replace(/\n$/, "") };
  return { lang: null, text: raw.replace(/^\n|\n$/g, "") };
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
  const blocks: Block[] = [];
  const canvas = options.canvas === true;
  // M80 (CANVAS.md §22): a canvas's hidden task markers are never shown (each line keeps its place).
  const lines = body.replace(/\r\n?/g, "\n").split("\n").map((line) => (canvas ? stripTaskMarkers(line) : line));
  let i = 0;
  const push = (block: Block) => blocks.push(block);
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
    const line = lines[i] ?? "";
    if (opensFence(i)) {
      const fence = FENCE.exec(line);
      const close = fenceCloseAfter(i);
      push({ kind: "codeblock", text: lines.slice(i + 1, close).join("\n"), lang: fence?.[1] ? fence[1].toLowerCase() : null });
      i = close + 1;
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading) {
      push({ kind: "heading", level: (heading[1] ?? "#").length as 1 | 2 | 3, tokens: tokenizeInline(heading[2] ?? ""), ...(canvas ? { line: i } : {}) });
      i++;
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
      push({ kind: "image", alt: m[1] ?? "", attachmentId: (m[2] ?? "").toLowerCase(), line: i });
      i++;
      continue;
    }
    if (isRule(i)) {
      push({ kind: "hr" });
      i++;
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
    const bullet = BULLET.exec(line);
    const numbered = NUMBERED.exec(line);
    if (bullet || numbered) {
      const ordered = !bullet;
      const items: Array<{ level: number; tokens: Token[] }> = [];
      const start = numbered ? Number(numbered[2]) : 1;
      while (i < lines.length) {
        const current = lines[i] ?? "";
        const m = ordered ? NUMBERED.exec(current) : BULLET.exec(current);
        if (!m || isTask(i)) break;
        const indent = (m[1] ?? "").replace(/\t/g, "  ").length;
        const text = ordered ? (m[3] ?? "") : (m[2] ?? "");
        items.push({ level: indent >= 2 ? 1 : 0, tokens: tokenizeInline(text) });
        i++;
      }
      push({ kind: "list", ordered, start, items });
      continue;
    }
    // Paragraph: consecutive ordinary lines (blank lines stay as empty lines inside it).
    const paragraph: Token[][] = [];
    while (i < lines.length) {
      const current = lines[i] ?? "";
      if (paragraph.length > 0 && (opensFence(i) || opensTable(i) || HEADING.test(current) || QUOTE.test(current) || BULLET.test(current) || NUMBERED.test(current) || isImage(i) || isRule(i))) break;
      paragraph.push(tokenizeInline(current));
      i++;
    }
    push({ kind: "paragraph", lines: paragraph });
  }
  return blocks;
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
