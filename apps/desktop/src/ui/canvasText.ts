/**
 * Pure text helpers of the canvas editor (CANVAS.md §4.4 / §5): ticking a task line, keeping the caret where it was when
 * the body is replaced by the server's merged one, and the headings for the outline. apps/shared/canvas_markdown.json
 * holds the cases the three clients share.
 */
import { TASK_LINE } from "./markdown";

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
 * edits): before the first difference it stays; after the last one it keeps its distance from the end; inside the changed
 * stretch it follows its own line when that line is still there (the nearest copy of it), else it goes to the end of
 * the change.
 */
export function preserveCaret(before: string, after: string, caret: number): number {
  if (before === after) return Math.min(caret, after.length);
  const max = Math.min(before.length, after.length);
  let prefix = 0;
  while (prefix < max && before.charCodeAt(prefix) === after.charCodeAt(prefix)) prefix++;
  let suffix = 0;
  while (suffix < max - prefix && before.charCodeAt(before.length - 1 - suffix) === after.charCodeAt(after.length - 1 - suffix)) suffix++;
  if (caret <= prefix) return caret;
  if (caret >= before.length - suffix) return Math.max(0, after.length - (before.length - caret));
  // Inside the changed stretch: find the caret's line in the new text, nearest to where it would have moved.
  const lineStart = before.lastIndexOf("\n", caret - 1) + 1;
  const lineEndIndex = before.indexOf("\n", caret);
  const lineText = before.slice(lineStart, lineEndIndex === -1 ? before.length : lineEndIndex);
  const column = caret - lineStart;
  const beforeLines = before.split("\n");
  const afterLines = after.split("\n");
  const lineIndex = before.slice(0, lineStart).split("\n").length - 1;
  const expected = lineIndex + (afterLines.length - beforeLines.length);
  let best = -1;
  if (lineText.trim() !== "") {
    for (let k = 0; k < afterLines.length; k++) {
      if (afterLines[k] !== lineText) continue;
      if (best === -1 || Math.abs(k - expected) < Math.abs(best - expected) || (Math.abs(k - expected) === Math.abs(best - expected) && Math.abs(k - lineIndex) < Math.abs(best - lineIndex))) best = k;
    }
  }
  if (best !== -1) {
    let offset = 0;
    for (let k = 0; k < best; k++) offset += (afterLines[k] ?? "").length + 1;
    return offset + column;
  }
  return Math.max(prefix, after.length - suffix);
}

export interface OutlineEntry {
  level: 1 | 2 | 3;
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
    const match = /^(#{1,3})\s+(\S.*)$/.exec(line);
    if (match) entries.push({ level: (match[1] ?? "#").length as 1 | 2 | 3, text: (match[2] ?? "").replace(/[*_~`]/g, "").trim(), line: index });
  });
  return entries;
}

interface Selection {
  text: string;
  start: number;
  end: number;
}

/** The caret's line (or the selected lines) as a heading of `level`; the same level again makes it text. */
export function setHeading(state: Selection, level: 1 | 2 | 3): Selection {
  const { text, start, end } = state;
  const lineStart = text.lastIndexOf("\n", start - 1) + 1;
  const lineEndIndex = text.indexOf("\n", Math.max(end - 1, start));
  const lineEnd = lineEndIndex === -1 ? text.length : lineEndIndex;
  const lines = text.slice(lineStart, lineEnd).split("\n");
  const marker = "#".repeat(level) + " ";
  const same = lines.every((line) => line.startsWith(marker));
  const next = lines.map((line) => {
    const bare = line.replace(/^#{1,3}\s+/, "");
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
