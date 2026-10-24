/**
 * Pure text helpers of the canvas editor (CANVAS.md §4.4 / §5): ticking a task line, keeping the caret where it was when
 * the body is replaced by the server's merged one, and the headings for the outline. apps/shared/canvas_markdown.json
 * holds the cases the three clients share.
 */
import { type HeadingLevel, TASK_LINE } from "./markdown";

/**
 * The body with the task on `line` (0-based) ticked or unticked; null when that line is not a task (any more). Only the
 * box changes, so a member who may only tick (§4.7) sends a body the server accepts from them.
 */
export function toggleTaskLine(body: string, line: number, done?: boolean): string | null {
  const lines = body.split("\n");
  const current = lines[line];
  if (current === undefined) return null;
  const match = TASK_LINE.exec(current);
  if (!match) return null;
  const indent = match[1] ?? "";
  const box = indent.length + 3; // "- [" then the mark
  const wasDone = match[2] !== " ";
  const next = done ?? !wasDone;
  if (next === wasDone) return body;
  lines[line] = current.slice(0, box) + (next ? "x" : " ") + current.slice(box + 1);
  return lines.join("\n");
}

/**
 * Where the caret goes when the editor's text changes from `before` to `after` under it (a merge brought someone else's
 * edits, CANVAS.md §24): before the first difference it stays; after the last one it keeps its distance from the end.
 * Inside the changed stretch it follows its own line through the lines both texts keep (a line diff). A line that
 * changed itself (someone typed on it too) is matched to its new form and the caret follows the characters both keep,
 * so it stays where it was typing instead of jumping to the end of the whole change (another person's line). A line
 * that is gone puts it at the end of the line before; a line rewritten as a whole, at the end of the new line.
 * The same rule on the three clients (apps/shared/canvas_markdown.json `caret`).
 */
export function preserveCaret(before: string, after: string, caret: number): number {
  if (before === after) return Math.min(caret, after.length);
  const [prefix, suffix] = commonEnds(before, after);
  if (caret <= prefix) return caret;
  if (caret >= before.length - suffix) return Math.max(0, after.length - (before.length - caret));
  const beforeLines = before.split("\n");
  const afterLines = after.split("\n");
  const line = before.slice(0, caret).split("\n").length - 1;
  const column = caret - (before.lastIndexOf("\n", caret - 1) + 1);
  const offset = (k: number) => {
    let at = 0;
    for (let n = 0; n < k; n++) at += afterLines[n]!.length + 1;
    return at;
  };
  const [p, s] = commonEnds(beforeLines, afterLines);
  if (line < p) return offset(line) + column;
  if (line >= beforeLines.length - s) return offset(line + afterLines.length - beforeLines.length) + column;
  const midBefore = beforeLines.slice(p, beforeLines.length - s);
  const midAfter = afterLines.slice(p, afterLines.length - s);
  const i = line - p;
  let prev: [number, number] = [-1, -1];
  let next: [number, number] = [midBefore.length, midAfter.length];
  for (const [a, b] of keptPairs(midBefore, midAfter)) {
    if (a === i) return offset(p + b) + column;
    if (a < i) prev = [a, b];
    else {
      next = [a, b];
      break;
    }
  }
  const gapBefore = next[0] - prev[0] - 1;
  const gapAfter = next[1] - prev[1] - 1;
  if (gapAfter <= 0) {
    // The caret's line went: the end of the line before it (or the start).
    const k = p + prev[1];
    return k < 0 ? 0 : offset(k) + afterLines[k]!.length;
  }
  let k = prev[1] + 1 + (i - prev[0] - 1);
  if (gapBefore !== gapAfter) {
    // The new line most like the caret's (most characters kept at its ends), nearest to the same place in the gap.
    const own = beforeLines[line]!;
    const where = (i - prev[0] - 1) / Math.max(1, gapBefore);
    let bestScore = -1;
    let bestDistance = Infinity;
    for (let j = prev[1] + 1; j < next[1]; j++) {
      const [a, b] = commonEnds(own, midAfter[j]!);
      const distance = Math.abs((j - prev[1] - 1) / Math.max(1, gapAfter) - where);
      if (a + b > bestScore || (a + b === bestScore && distance < bestDistance)) {
        k = j;
        bestScore = a + b;
        bestDistance = distance;
      }
    }
  }
  return offset(p + k) + caretInLine(beforeLines[line]!, afterLines[p + k]!, column);
}

/** The lengths of the common start and end of two strings (UTF-16 units) or line lists, not overlapping. */
function commonEnds(a: string | readonly string[], b: string | readonly string[]): [number, number] {
  const max = Math.min(a.length, b.length);
  let prefix = 0;
  while (prefix < max && a[prefix] === b[prefix]) prefix++;
  let suffix = 0;
  while (suffix < max - prefix && a[a.length - 1 - suffix] === b[b.length - 1 - suffix]) suffix++;
  return [prefix, suffix];
}

/** Past this many cells (a × b) the diff is not run; what lies between is taken as replaced. */
const CARET_DIFF_CELLS = 250_000;

/** The pairs (index in a, index in b) of a longest common subsequence, in order. */
function keptPairs(a: readonly string[], b: readonly string[]): Array<[number, number]> {
  const n = a.length;
  const m = b.length;
  if (n === 0 || m === 0 || n * m > CARET_DIFF_CELLS) return [];
  const width = m + 1;
  const table = new Uint32Array((n + 1) * width);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      table[i * width + j] = a[i] === b[j] ? table[(i + 1) * width + j + 1]! + 1 : Math.max(table[(i + 1) * width + j]!, table[i * width + j + 1]!);
    }
  }
  const pairs: Array<[number, number]> = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      pairs.push([i, j]);
      i++;
      j++;
    } else if (table[(i + 1) * width + j]! >= table[i * width + j + 1]!) i++;
    else j++;
  }
  return pairs;
}

/** The caret's column in a line that changed: through the characters both keep (the last one before it). */
function caretInLine(before: string, after: string, column: number): number {
  const [p, s] = commonEnds(before, after);
  if (column <= p) return column;
  if (column >= before.length - s) return after.length - (before.length - column);
  const pairs = keptPairs(before.slice(p, before.length - s).split(""), after.slice(p, after.length - s).split(""));
  if (pairs.length === 0) return after.length - s; // rewritten as a whole: after the new text
  let at = p;
  for (const [i, j] of pairs) {
    if (p + i < column) at = p + j + 1;
    else break;
  }
  return at;
}

export interface OutlineEntry {
  level: HeadingLevel;
  text: string;
  line: number;
}

/** The headings of a body (outside code fences), for the outline beside a long canvas. */
export function outline(body: string): OutlineEntry[] {
  const entries: OutlineEntry[] = [];
  let fenced = false;
  body.split("\n").forEach((line, index) => {
    if (/^```/.test(line)) {
      fenced = !fenced;
      return;
    }
    if (fenced) return;
    const match = /^(#{1,4})\s+(\S.*)$/.exec(line);
    if (match) entries.push({ level: (match[1] ?? "#").length as HeadingLevel, text: (match[2] ?? "").replace(/[*_~`]/g, "").trim(), line: index });
  });
  return entries;
}

/** M72 (CANVAS.md §18.2): the heading the caret is under (its text), or null above the first one. */
export function sectionAt(text: string, caret: number): string | null {
  const line = text.slice(0, Math.max(0, caret)).split("\n").length - 1;
  let found: string | null = null;
  for (const entry of outline(text)) {
    if (entry.line > line) break;
    found = entry.text;
  }
  return found;
}

interface Selection {
  text: string;
  start: number;
  end: number;
}

/** The caret's line (or the selected lines) as a heading of `level`; the same level again makes it text. */
export function setHeading(state: Selection, level: HeadingLevel): Selection {
  const { text, start, end } = state;
  const lineStart = text.lastIndexOf("\n", start - 1) + 1;
  const lineEndIndex = text.indexOf("\n", Math.max(end - 1, start));
  const lineEnd = lineEndIndex === -1 ? text.length : lineEndIndex;
  const lines = text.slice(lineStart, lineEnd).split("\n");
  const marker = "#".repeat(level) + " ";
  const same = lines.every((line) => line.startsWith(marker));
  const next = lines.map((line) => {
    const bare = line.replace(/^#{1,4}\s+/, "");
    return same ? bare : marker + bare;
  });
  const joined = next.join("\n");
  const firstDelta = (next[0] ?? "").length - (lines[0] ?? "").length;
  return { text: text.slice(0, lineStart) + joined + text.slice(lineEnd), start: Math.max(lineStart, start + firstDelta), end: end + joined.length - (lineEnd - lineStart) };
}

/** The selected lines as tasks ("- [ ] "; a bullet becomes one), or back to text when they all are tasks already. */
export function toggleTasks(state: Selection): Selection {
  const { text, start, end } = state;
  const lineStart = text.lastIndexOf("\n", start - 1) + 1;
  const lineEndIndex = text.indexOf("\n", Math.max(end - 1, start));
  const lineEnd = lineEndIndex === -1 ? text.length : lineEndIndex;
  const lines = text.slice(lineStart, lineEnd).split("\n");
  const all = lines.every((line) => TASK_LINE.test(line));
  const next = lines.map((line) => {
    if (all) return line.replace(/^(\s*)[-*] \[[ xX]\] ?/, "$1");
    if (TASK_LINE.test(line)) return line;
    const match = /^(\s*)(?:[-*•]\s+)?(.*)$/.exec(line);
    return `${match?.[1] ?? ""}- [ ] ${match?.[2] ?? ""}`;
  });
  const joined = next.join("\n");
  const firstDelta = (next[0] ?? "").length - (lines[0] ?? "").length;
  return { text: text.slice(0, lineStart) + joined + text.slice(lineEnd), start: Math.max(lineStart, start + firstDelta), end: Math.max(lineStart, end + joined.length - (lineEnd - lineStart)) };
}

/** A rule ("---") on a line of its own between blank lines, after the caret's line; the caret goes below it. */
export function insertRule(state: Selection): Selection {
  const { text, end } = state;
  const lineEndIndex = text.indexOf("\n", end);
  const at = lineEndIndex === -1 ? text.length : lineEndIndex;
  const before = text.slice(0, at);
  const after = text.slice(at);
  const lead = before === "" ? "" : before.endsWith("\n\n") ? "" : before.endsWith("\n") ? "\n" : "\n\n";
  const inserted = `${lead}---\n\n`;
  const rest = after.startsWith("\n") ? after.slice(1) : after;
  const caret = before.length + inserted.length;
  return { text: before + inserted + rest, start: caret, end: caret };
}

/** M44 (§4.10): the canvas's own limit of images and files (the server says too_many_canvas_images past it). */
export const MAX_CANVAS_IMAGES = 100;

/** The distinct attachments a body names (`attachment:<id>`, as the server counts them when it binds). */
export function attachmentRefs(body: string): Set<string> {
  const ids = new Set<string>();
  for (const match of body.matchAll(/\(attachment:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\)/gi)) ids.add((match[1] ?? "").toLowerCase());
  return ids;
}

/** M44: an image `![alt](attachment:<id>)` on a line of its own at the caret (replacing a selection); the caret goes after it. */
export function insertImageLine(state: Selection, attachmentId: string, alt = ""): Selection {
  const { text, start, end } = state;
  const before = text.slice(0, start);
  const after = text.slice(end);
  const lead = before === "" || before.endsWith("\n") ? "" : "\n";
  const trail = after.startsWith("\n") ? "" : "\n";
  const line = `![${alt.replace(/[\]\n]/g, " ")}](attachment:${attachmentId})`;
  const next = before + lead + line + trail + after;
  // After the image's line break: on the line below it.
  const caret = before.length + lead.length + line.length + 1;
  return { text: next, start: caret, end: caret };
}

/** Task counts as the server makes them for a list (the "3/8" beside a canvas). */
export function taskProgress(total: number, done: number): string | null {
  return total > 0 ? `${done}/${total}` : null;
}
