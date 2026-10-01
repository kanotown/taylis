/** Pure text-editing helpers for the markdown composer (selection-aware, unit tested). */
export interface EditState {
  text: string;
  start: number;
  end: number;
}

/** Wrap the selection with markers, or unwrap when it is already wrapped; no selection inserts an empty pair. */
export function toggleWrap(state: EditState, prefix: string, suffix = prefix): EditState {
  const { text, start, end } = state;
  const selected = text.slice(start, end);
  const before = text.slice(0, start);
  const after = text.slice(end);
  if (before.endsWith(prefix) && after.startsWith(suffix)) {
    return { text: before.slice(0, -prefix.length) + selected + after.slice(suffix.length), start: start - prefix.length, end: end - prefix.length };
  }
  if (selected.startsWith(prefix) && selected.endsWith(suffix) && selected.length >= prefix.length + suffix.length) {
    const inner = selected.slice(prefix.length, selected.length - suffix.length);
    return { text: before + inner + after, start, end: start + inner.length };
  }
  return { text: before + prefix + selected + suffix + after, start: start + prefix.length, end: end + prefix.length };
}

/** Wrap the selection in a fenced code block on its own lines. */
export function toggleFence(state: EditState): EditState {
  const { text, start, end } = state;
  const selected = text.slice(start, end);
  const before = text.slice(0, start);
  const after = text.slice(end);
  const open = before.length === 0 || before.endsWith("\n") ? "```\n" : "\n```\n";
  const close = after.length === 0 || after.startsWith("\n") ? "\n```" : "\n```\n";
  return { text: before + open + selected + close + after, start: start + open.length, end: start + open.length + selected.length };
}

/** Prefix every selected line (or the caret's line) with `marker`; if all already have it, remove it. */
export function toggleLinePrefix(state: EditState, marker: string | ((index: number) => string)): EditState {
  const { text, start, end } = state;
  const lineStart = text.lastIndexOf("\n", start - 1) + 1;
  const lineEndIndex = text.indexOf("\n", Math.max(end - 1, start));
  const lineEnd = lineEndIndex === -1 ? text.length : lineEndIndex;
  const lines = text.slice(lineStart, lineEnd).split("\n");
  const markerFor = (i: number) => (typeof marker === "function" ? marker(i) : marker);
  const stripPattern = typeof marker === "function" ? /^\d{1,3}\.\s/ : null;
  const allHave = lines.every((line) => (stripPattern ? stripPattern.test(line) : line.startsWith(markerFor(0))));
  const replaced = lines.map((line, i) => {
    if (allHave) return stripPattern ? line.replace(stripPattern, "") : line.slice(markerFor(0).length);
    return markerFor(i) + line;
  });
  const next = replaced.join("\n");
  const delta = next.length - (lineEnd - lineStart);
  return { text: text.slice(0, lineStart) + next + text.slice(lineEnd), start: Math.max(lineStart, start + (allHave ? -markerFor(0).length : markerFor(0).length)), end: end + delta };
}

/** Insert a markdown link around the selection (or an empty template) and select the url part. */
export function insertLink(state: EditState, url = "https://"): EditState {
  const { text, start, end } = state;
  const selected = text.slice(start, end) || "リンク";
  const inserted = `[${selected}](${url})`;
  const urlStart = start + selected.length + 3;
  return { text: text.slice(0, start) + inserted + text.slice(end), start: urlStart, end: urlStart + url.length };
}

/** True when the caret is inside an open ``` fence (an odd number of fence markers before it). */
export function insideFence(text: string, caret: number): boolean {
  const before = text.slice(0, caret);
  return (before.match(/^```/gm) ?? []).length % 2 === 1;
}

const LIST_LINE = /^(\s*)(?:([-*•])|(\d{1,3})\.)\s(.*)$/;
const TASK_ITEM = /^(\s*)([-*]) \[[ xX]\](?: (.*))?$/;
const QUOTE_LINE = /^(>\s?)(.*)$/;

/**
 * Enter inside a list or quote: continue it on the next line (numbered lists count up); Enter on an
 * empty item ends the structure instead. Returns null when Enter should behave normally.
 */
export function continueStructure(state: EditState): EditState | null {
  const { text, start } = state;
  const lineStart = text.lastIndexOf("\n", start - 1) + 1;
  const line = text.slice(lineStart, start);
  // A task (the canvas dialect, CANVAS.md §5) goes on with a new open box.
  const task = TASK_ITEM.exec(line);
  if (task) {
    const [, indent = "", bullet = "-", rest = ""] = task;
    if (rest.trim() === "") return { text: text.slice(0, lineStart) + text.slice(start), start: lineStart, end: lineStart };
    const inserted = `\n${indent}${bullet} [ ] `;
    return { text: text.slice(0, start) + inserted + text.slice(start), start: start + inserted.length, end: start + inserted.length };
  }
  const list = LIST_LINE.exec(line);
  if (list) {
    const [, indent = "", bullet, number, rest = ""] = list;
    if (rest.trim() === "") {
      // Empty item: end the list by removing the marker.
      return { text: text.slice(0, lineStart) + text.slice(start), start: lineStart, end: lineStart };
    }
    const marker = bullet ? `${indent}${bullet} ` : `${indent}${Number(number) + 1}. `;
    const inserted = "\n" + marker;
    return { text: text.slice(0, start) + inserted + text.slice(start), start: start + inserted.length, end: start + inserted.length };
  }
  const quote = QUOTE_LINE.exec(line);
  if (quote) {
    const [, marker = "> ", rest = ""] = quote;
    if (rest.trim() === "") return { text: text.slice(0, lineStart) + text.slice(start), start: lineStart, end: lineStart };
    const inserted = "\n" + marker;
    return { text: text.slice(0, start) + inserted + text.slice(start), start: start + inserted.length, end: start + inserted.length };
  }
  return null;
}

/** Tab / Shift+Tab on a list line changes its nesting by two spaces. */
export function indentListLine(state: EditState, outdent: boolean): EditState | null {
  const { text, start, end } = state;
  const lineStart = text.lastIndexOf("\n", start - 1) + 1;
  const lineEndIndex = text.indexOf("\n", start);
  const lineEnd = lineEndIndex === -1 ? text.length : lineEndIndex;
  const line = text.slice(lineStart, lineEnd);
  if (!LIST_LINE.test(line)) return null;
  if (outdent) {
    if (!line.startsWith("  ")) return state;
    return { text: text.slice(0, lineStart) + line.slice(2) + text.slice(lineEnd), start: Math.max(lineStart, start - 2), end: Math.max(lineStart, end - 2) };
  }
  return { text: text.slice(0, lineStart) + "  " + line + text.slice(lineEnd), start: start + 2, end: end + 2 };
}

/**
 * The part of `before` that `after` replaces (their common start and end left out), so the composer can make a
 * change as one small edit of the text area, which the browser's undo then takes back (tester, 2026-09-30).
 * Never cuts between the two halves of a surrogate pair (an emoji).
 */
export function changedRange(before: string, after: string): { start: number; end: number; text: string } {
  const limit = Math.min(before.length, after.length);
  let start = 0;
  while (start < limit && before.charCodeAt(start) === after.charCodeAt(start)) start++;
  if (start > 0 && isHighSurrogate(before.charCodeAt(start - 1))) start--;
  let tail = 0;
  while (tail < limit - start && before.charCodeAt(before.length - 1 - tail) === after.charCodeAt(after.length - 1 - tail)) tail++;
  if (tail > 0 && isLowSurrogate(before.charCodeAt(before.length - tail))) tail--;
  return { start, end: before.length - tail, text: after.slice(start, after.length - tail) };
}

/**
 * Makes the text area read `next` as if it had been typed: the smallest changed range (changedRange) selected, then
 * replaced with `execCommand("insertText")`, which Chrome / WebView2 and WebKit (Tauri on macOS) put on the text area's
 * own undo stack, merged with typing, and announce with an `input` event (the composer's draft or the canvas follows
 * through onChange). The command is deprecated but has no replacement for this, and a stack of our own would fight the
 * native one (the Edit menu, IME). False where the browser does not take it (jsdom, a hidden text area): the caller
 * sets the text instead. Used by the composer and the canvas editor.
 */
export function replaceThroughBrowser(el: HTMLTextAreaElement, next: string): boolean {
  if (el.value === next) return true;
  el.focus();
  if (document.activeElement !== el || typeof document.execCommand !== "function") return false;
  const { start, end, text } = changedRange(el.value, next);
  el.setSelectionRange(start, end);
  try {
    return document.execCommand(text ? "insertText" : "delete", false, text) && el.value === next;
  } catch {
    return false;
  }
}

const isHighSurrogate = (code: number) => code >= 0xd800 && code <= 0xdbff;
const isLowSurrogate = (code: number) => code >= 0xdc00 && code <= 0xdfff;
