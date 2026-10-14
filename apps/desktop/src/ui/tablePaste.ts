/**
 * A spreadsheet range pasted into a message (the composer, the thread composer, the edit box; both input modes) becomes a
 * GFM table (markdown.ts M15g), as Mattermost does (apps/desktop/README.md 「入力欄：表の貼り付け」):
 *
 * - The clipboard's `text/html` holding a `<table>` and nothing else of substance (Excel, Numbers, Google Sheets,
 *   LibreOffice Calc; also a table copied from Word or a web page): its cells, merged cells spread as empty cells
 *   (pagePaste.ts `tableGrid`), Excel's hidden rows and columns left out. Failing that, `text/plain` that is
 *   tab-separated: two lines or more, two columns or more, every line as many (Excel's quoting of a cell holding a
 *   newline or a quote is read).
 * - Two rows and two columns at least (after the trailing empty rows and columns go): one cell, one row or one column
 *   pastes as text. The first row is the header (Mattermost's behaviour); the columns keep the default alignment.
 * - A cell is one line: its line breaks become spaces (the renderer draws no `<br>` in a cell), runs of white space one
 *   space, `|` written `\|`.
 * - At most MAX_ROWS rows and MAX_COLUMNS columns, and the message within its length (MAX_BODY): a larger range pastes as
 *   the plain text it came with, and a notice says so.
 * - With a table on the clipboard its files (Excel's picture of the range) are not attached; a paste of only files
 *   (a screenshot) attaches them as before.
 * - ⌘⇧V / Ctrl+Shift+V (paste as plain text) pastes the plain text as before (`plainPasteRequested`).
 *
 * Pure apart from the DOM parser: tests run it on recorded clipboard contents (tests/tablePaste.test.ts).
 */
import { tableGrid } from "./pagePaste";

export const MAX_ROWS = 200;
export const MAX_COLUMNS = 30;
/** The server's limit on a message body (server/app/modules/messages/schemas.py MAX_BODY_LENGTH). */
export const MAX_BODY = 20_000;

/** What a paste event offers (a `DataTransfer`, or a test's stand-in). */
export interface ClipboardLike {
  getData(type: string): string;
  readonly types?: readonly string[];
}

export type PastedTable =
  /** Convert: the GFM table's lines (no blank lines around). */
  | { kind: "table"; markdown: string }
  /** A table, but too large for a message: paste `text` (the clipboard's plain text) instead, and say so. */
  | { kind: "tooLarge"; text: string };

/** The table a paste holds, null when it holds none (files, prose, one cell, code). `room`: characters the message has left. */
export function pastedTable(data: ClipboardLike, room = MAX_BODY): PastedTable | null {
  const grid = clipboardGrid(data);
  if (!grid) return null;
  const rows = trimGrid(grid);
  if (rows.length < 2 || (rows[0]?.length ?? 0) < 2) return null;
  const text = data.getData("text/plain");
  if (rows.length > MAX_ROWS || rows[0]!.length > MAX_COLUMNS) return { kind: "tooLarge", text };
  const markdown = gridToMarkdown(rows);
  // Blank lines around it count too (tableInsertion adds up to four characters).
  if (markdown.length + 4 > room) return { kind: "tooLarge", text };
  return { kind: "table", markdown };
}

/** Whether the clipboard holds an HTML table (a spreadsheet's copy): its files (a picture of the range) are not attached. */
export function hasHtmlTable(data: ClipboardLike): boolean {
  return /<table[\s>]/i.test(data.getData("text/html"));
}

/** The grid of cell texts: the HTML table, else tab-separated plain text; null when neither is there. */
export function clipboardGrid(data: ClipboardLike): string[][] | null {
  const html = data.getData("text/html");
  if (html && /<table[\s>]/i.test(html)) return htmlGrid(html);
  return tsvGrid(data.getData("text/plain"));
}

/** The only table of pasted HTML as cell texts; null when there is none, several, or text around it (a web page's part). */
export function htmlGrid(html: string): string[][] | null {
  if (typeof DOMParser === "undefined") return null;
  const doc = new DOMParser().parseFromString(html, "text/html");
  const body = doc.body;
  for (const el of Array.from(body.querySelectorAll("style, script, meta, link, title, xml"))) el.remove();
  const tables = Array.from(body.querySelectorAll("table")).filter((table) => !table.parentElement?.closest("table"));
  if (tables.length !== 1) return null;
  const table = tables[0]!;
  // Anything else of substance (a paragraph of a web page around the table) makes it a document, not a range.
  const outside = body.cloneNode(true) as HTMLElement;
  outside.querySelector("table")?.remove();
  if ((outside.textContent ?? "").replace(/[\s 　]+/g, "") !== "" || outside.querySelector("img")) return null;
  const cells = tableGrid(table, { skipHidden: true });
  if (!cells) return null;
  const { grid, order } = cells;
  const width = Math.max(0, ...grid.map((row) => row.length));
  return order.map((r) => Array.from({ length: width }, (_, c) => {
    const cell = grid[r]?.[c];
    return cell ? cellText(cell) : "";
  }));
}

/** A cell's text on one line: line breaks and block edges are spaces, white space runs one space. */
function cellText(cell: Element): string {
  let out = "";
  const walk = (node: Node) => {
    if (node.nodeType === 3) out += node.textContent ?? "";
    else if (node.nodeType === 1) {
      const el = node as Element;
      if (el.tagName === "BR") out += " ";
      else if (el.tagName !== "STYLE" && el.tagName !== "SCRIPT") {
        const block = /^(P|DIV|LI|H[1-6]|TABLE|TR|TD|TH|UL|OL)$/.test(el.tagName);
        if (block) out += " ";
        el.childNodes.forEach(walk);
        if (block) out += " ";
      }
    }
  };
  cell.childNodes.forEach(walk);
  return oneLine(out);
}

const oneLine = (text: string) => text.replace(/[\s ]+/g, " ").trim();

/**
 * Tab-separated text as cells, null unless it is a table: two lines or more, every line with the same number of cells,
 * two or more (Excel's TSV: a cell holding a tab, a newline or a quote is quoted, `""` a quote).
 */
export function tsvGrid(text: string): string[][] | null {
  if (!text.includes("\t")) return null;
  const rows = parseTsv(text.replace(/\r\n?/g, "\n"));
  while (rows.length > 0 && rows[rows.length - 1]!.every((cell) => cell === "")) rows.pop();
  if (rows.length < 2) return null;
  const width = rows[0]!.length;
  if (width < 2 || rows.some((row) => row.length !== width)) return null;
  // Lines indented with a tab (code) are not a table: its first column would be empty throughout.
  if (rows.every((row) => row[0]!.trim() === "")) return null;
  return rows.map((row) => row.map(oneLine));
}

function parseTsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let i = 0;
  const raw = () => {
    let cell = "";
    while (i < text.length && text[i] !== "\t" && text[i] !== "\n") cell += text[i++];
    return cell;
  };
  for (;;) {
    let cell: string | null = null;
    if (text[i] === '"') {
      // Quoted: up to the quote that is not doubled, which must end the cell; else the cell only starts with a quote.
      let quoted = "";
      let j = i + 1;
      for (; j < text.length; j++) {
        if (text[j] !== '"') quoted += text[j];
        else if (text[j + 1] === '"') quoted += text[++j];
        else break;
      }
      if (j < text.length && (j + 1 >= text.length || text[j + 1] === "\t" || text[j + 1] === "\n")) {
        cell = quoted;
        i = j + 1;
      }
    }
    row.push(cell ?? raw());
    if (i >= text.length) {
      rows.push(row);
      return rows;
    }
    if (text[i] === "\n") {
      rows.push(row);
      row = [];
      if (++i >= text.length) return rows;
    } else i++;
  }
}

/** Trailing empty rows and columns dropped; every row as wide as the table. */
export function trimGrid(grid: string[][]): string[][] {
  const rows = grid.map((row) => row.map(oneLine));
  while (rows.length > 0 && rows[rows.length - 1]!.every((cell) => cell === "")) rows.pop();
  let width = 0;
  for (const row of rows) for (let c = row.length - 1; c >= width; c--) if (row[c] !== "") width = c + 1;
  return rows.map((row) => Array.from({ length: width }, (_, c) => row[c] ?? ""));
}

/** The GFM table: the first row the header, `| --- |` under it, `|` in a cell as `\|`. */
export function gridToMarkdown(rows: string[][]): string {
  const line = (cells: string[]) => `| ${cells.map((cell) => cell.replace(/\|/g, "\\|")).join(" | ")} |`;
  const [header, ...body] = rows;
  return [line(header!), line(header!.map(() => "---")), ...body.map(line)].join("\n");
}

/** The text area's text with the table put in place of the selection, blank lines around it, the caret after it. */
export function tableInsertion(state: { text: string; start: number; end: number }, markdown: string): { text: string; start: number; end: number } {
  const before = state.text.slice(0, state.start);
  const after = state.text.slice(state.end);
  const lead = before === "" || before.endsWith("\n\n") ? "" : before.endsWith("\n") ? "\n" : "\n\n";
  const trail = after.startsWith("\n\n") ? "" : after.startsWith("\n") ? "\n" : "\n\n";
  const inserted = lead + markdown + trail;
  const caret = before.length + inserted.length - (after === "" ? 0 : trail.length);
  return { text: before + inserted + after, start: caret, end: caret };
}

// --- ⌘⇧V / Ctrl+Shift+V ------------------------------------------------------------------------------------------------

let plainPasteAt = -Infinity;
const PLAIN_PASTE_WINDOW_MS = 1000;

/** Notes ⌘⇧V / Ctrl+Shift+V (and Safari's ⌥⇧⌘V): the paste it starts stays plain text. */
export function notePasteKey(event: Pick<KeyboardEvent, "key" | "code" | "metaKey" | "ctrlKey" | "shiftKey">, now = Date.now()): void {
  if ((event.metaKey || event.ctrlKey) && event.shiftKey && (event.key.toLowerCase() === "v" || event.code === "KeyV")) plainPasteAt = now;
}

/** True for the paste right after ⌘⇧V (once). */
export function plainPasteRequested(now = Date.now()): boolean {
  const requested = now - plainPasteAt < PLAIN_PASTE_WINDOW_MS;
  plainPasteAt = -Infinity;
  return requested;
}

// One listener for every input (the text areas and the rich editor), before any of them handles the key.
if (typeof window !== "undefined") window.addEventListener("keydown", (event) => notePasteKey(event), true);

/** What a paste into a message input does before its own handling (files, a URL over a selection, the browser's paste). */
export type PasteDecision =
  /** Insert the GFM table (`tableInsertion` in a text area, a raw Markdown block in the rich editor). */
  | { kind: "table"; markdown: string }
  /** Paste the plain text and attach nothing (⌘⇧V, a table that is too large, a lone cell); `tooLarge` says why. */
  | { kind: "text"; text: string; tooLarge: boolean };

/**
 * The decision for a paste: `room` is what the message has left, `inCode` a caret inside a code block or fence (a table
 * pasted there stays its text), `plain` a paste as plain text (⌘⇧V). Null: none of this applies, the input goes on as
 * before (files attach, a URL over a selection links it, the browser pastes).
 */
export function decidePaste(data: ClipboardLike, options: { room?: number; inCode?: boolean; plain?: boolean } = {}): PasteDecision | null {
  const text = data.getData("text/plain");
  if (options.plain && text) return { kind: "text", text, tooLarge: false };
  if (!options.inCode) {
    const table = pastedTable(data, options.room ?? MAX_BODY);
    if (table?.kind === "table") return table;
    if (table?.kind === "tooLarge") return text ? { kind: "text", text, tooLarge: true } : null;
  }
  // A spreadsheet's single cell or row: its text, not the picture of it that comes along.
  return hasHtmlTable(data) && text ? { kind: "text", text, tooLarge: false } : null;
}
