/**
 * M57 (CANVAS.md §17): the canvas table editor's text rules — reading a Markdown table into rows and columns, writing
 * it back, finding the table at the caret, inserting a new one, and the edits (rows, columns, alignment). A port of
 * apps/shared/gen_canvas_table.py; every client runs the cases in apps/shared/canvas_table.json.
 */
import { t, t as i18nT } from "../i18n";

export type Align = "left" | "center" | "right" | null;

export interface Table {
  align: Align[];
  header: string[];
  rows: string[][];
}

/** A table's first and last line (0-based, both included). */
export type LineRange = [number, number];

const SEPARATOR = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;

/** Cells of one row: outer pipes dropped, split on unescaped pipes, `\|` read as `|`, each trimmed. */
export function splitRow(line: string): string[] {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|") && !s.endsWith("\\|")) s = s.slice(0, -1);
  const cells: string[] = [];
  let cur = "";
  let i = 0;
  while (i < s.length) {
    if (s[i] === "\\" && i + 1 < s.length && s[i + 1] === "|") {
      cur += "|";
      i += 2;
      continue;
    }
    if (s[i] === "|") {
      cells.push(cur.trim());
      cur = "";
    } else {
      cur += s[i];
    }
    i++;
  }
  cells.push(cur.trim());
  return cells;
}

function alignOf(cell: string): Align {
  const c = cell.trim();
  const left = c.startsWith(":");
  const right = c.endsWith(":");
  if (left && right) return "center";
  if (left) return "left";
  if (right) return "right";
  return null;
}

/** A table block (header, separator, body rows); body rows padded or cut to the header's count. */
export function parseTable(lines: readonly string[]): Table {
  const header = splitRow(lines[0] ?? "");
  const n = header.length;
  const seps = splitRow(lines[1] ?? "");
  const align = header.map((_, i) => (i < seps.length ? alignOf(seps[i]!) : null));
  const rows = lines.slice(2).map((line) => {
    const cells = splitRow(line);
    return Array.from({ length: n }, (_, i) => cells[i] ?? "");
  });
  return { align, header, rows };
}

/** A cell as written: one line (line breaks become spaces), `|` escaped, trimmed. */
export function cellText(text: string): string {
  return text.replace(/\s*\r?\n\s*/g, " ").trim().replaceAll("|", "\\|");
}

const MARKS: Record<string, string> = { null: "---", left: ":---", center: ":---:", right: "---:" };

export function serializeTable(table: Table): string[] {
  const row = (cells: readonly string[]) => "| " + cells.map(cellText).join(" | ") + " |";
  const sep = "| " + table.align.map((a) => MARKS[String(a)]).join(" | ") + " |";
  return [row(table.header), sep, ...table.rows.map(row)];
}

const isRow = (line: string) => line.trimStart().startsWith("|");

/**
 * The [first, last] line of the table whose lines include `caretLine`: consecutive lines starting with `|` whose
 * second line is a separator. Null when the caret is not in a table (a table without leading pipes is not one here).
 */
export function findTable(text: string, caretLine: number): LineRange | null {
  const lines = text.split("\n");
  if (!(caretLine >= 0 && caretLine < lines.length) || !isRow(lines[caretLine]!)) return null;
  let start = caretLine;
  while (start > 0 && isRow(lines[start - 1]!)) start--;
  let end = caretLine;
  while (end + 1 < lines.length && isRow(lines[end + 1]!)) end++;
  if (end - start < 1 || !SEPARATOR.test(lines[start + 1]!)) return null;
  return [start, end];
}

/** A new 3×2 table, its headers named in the UI language. */
export function newTable(): Table {
  return { align: [null, null, null], header: [1, 2, 3].map((n) => t("table.newColumn", { n })), rows: [["", "", ""], ["", "", ""]] };
}

/**
 * `table` (newTable() by default) put after the caret's line (at the start when the text is empty), with a blank line
 * between it and any text before or after. Returns the new text and the table's [first, last] line.
 */
export function insertTable(text: string, caretLine: number, table: Table = newTable()): { text: string; range: LineRange } {
  const lines = text ? text.split("\n") : [];
  const at = lines.length > 0 ? Math.max(0, Math.min(caretLine + 1, lines.length)) : 0;
  const block = serializeTable(table);
  let before = lines.slice(0, at);
  let after = lines.slice(at);
  if (before.length > 0 && before[before.length - 1]!.trim() !== "") before = [...before, ""];
  if (after.length > 0 && after[0]!.trim() !== "") after = ["", ...after];
  const first = before.length;
  return { text: [...before, ...block, ...after].join("\n"), range: [first, first + block.length - 1] };
}

export type TableOp =
  | ["add_row", number]
  | ["delete_row", number]
  | ["move_row", number, number]
  | ["add_column", number]
  | ["delete_column", number]
  | ["set_align", number, Align];

/** One edit of the table, as a new table (the given one is left as it is). */
export function applyTableOp(table: Table, op: TableOp): Table {
  const t: Table = { align: [...table.align], header: [...table.header], rows: table.rows.map((r) => [...r]) };
  const n = t.header.length;
  switch (op[0]) {
    case "add_row": // a blank body row inserted at index (0..rows)
      t.rows.splice(op[1], 0, Array<string>(n).fill(""));
      break;
    case "delete_row": // a body row; the header stays
      t.rows.splice(op[1], 1);
      break;
    case "move_row": {
      const [r] = t.rows.splice(op[1], 1);
      if (r) t.rows.splice(op[2], 0, r);
      break;
    }
    case "add_column": // a blank column at index (0..n), headed 「列N」 with N the new count
      t.header.splice(op[1], 0, i18nT("table.newColumn", { n: n + 1 }));
      t.align.splice(op[1], 0, null);
      for (const r of t.rows) r.splice(op[1], 0, "");
      break;
    case "delete_column": // refused (unchanged) for the last column
      if (n > 1) {
        t.header.splice(op[1], 1);
        t.align.splice(op[1], 1);
        for (const r of t.rows) r.splice(op[1], 1);
      }
      break;
    case "set_align":
      t.align[op[1]] = op[2];
      break;
  }
  return t;
}

export function sameTable(a: Table, b: Table): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** The 0-based line the offset `at` is on. */
export function lineOf(text: string, at: number): number {
  let line = 0;
  for (let i = 0; i < at && i < text.length; i++) if (text.charCodeAt(i) === 10) line++;
  return line;
}

/** The offset where line `line` starts. */
export function lineStart(text: string, line: number): number {
  let at = 0;
  for (let i = 0; i < line; i++) {
    const next = text.indexOf("\n", at);
    if (next < 0) return text.length;
    at = next + 1;
  }
  return at;
}

/** Where a table opened in the editor was: its lines then, to find it again in the text as it is now. */
export interface TableOrigin {
  range: LineRange;
  lines: string[];
}

/**
 * The text with the edited table written back. The table is looked for where it was (its lines unchanged); when the
 * text moved meanwhile (someone else's merged edits), at the place holding exactly those lines as a whole table,
 * nearest to where it was. When it is nowhere as it was (someone changed the table itself), the edited table is put in
 * as a new table after the table now at that place (or where it was), so neither version is lost.
 */
export function writeBackTable(text: string, origin: TableOrigin, table: Table): { text: string; range: LineRange; inserted: boolean } {
  const lines = text.split("\n");
  const n = origin.lines.length;
  const holds = (at: number) => {
    const found = findTable(text, at);
    return !!found && found[0] === at && found[1] === at + n - 1 && origin.lines.every((line, i) => lines[at + i] === line);
  };
  let at: number | null = holds(origin.range[0]) ? origin.range[0] : null;
  if (at === null) {
    for (let i = 0; i + n <= lines.length; i++) {
      if (holds(i) && (at === null || Math.abs(i - origin.range[0]) < Math.abs(at - origin.range[0]))) at = i;
    }
  }
  if (at !== null) {
    const block = serializeTable(table);
    const next = [...lines.slice(0, at), ...block, ...lines.slice(at + n)];
    return { text: next.join("\n"), range: [at, at + block.length - 1], inserted: false };
  }
  const near = Math.min(origin.range[0], Math.max(lines.length - 1, 0));
  const there = findTable(text, near);
  const put = insertTable(text, there ? there[1] : near - 1, table);
  return { text: put.text, range: put.range, inserted: true };
}

/**
 * The line a new table goes after: the caret's line when it still reads as it did when the editor opened, else the
 * nearest line that does (someone else's merged edits moved it), else the same line number (kept in the text).
 */
export function anchorLine(text: string, line: number, content: string): number {
  const lines = text.split("\n");
  if (lines[line] === content) return line;
  let best: number | null = null;
  lines.forEach((l, i) => {
    if (l === content && (best === null || Math.abs(i - line) < Math.abs(best - line))) best = i;
  });
  return best ?? Math.min(line, lines.length - 1);
}
