/**
 * M80 (CANVAS.md §22): the hidden marker ` <!--task:<id>-->` the server puts at the end of a checklist item that a task
 * was made from (server/app/modules/canvases/markers.py). With it the box and the task's completion follow each other.
 * The apps never show it — not in the view, the history, the conflict panel, a copy or the editor — and keep it through
 * edits. apps/shared/canvas_task_markers.json holds the cases the three clients share.
 *
 * The editor (a plain text area) shows each marker as one invisible character: a Unicode tag character (U+E0020 + n,
 * default-ignorable, drawn as nothing), n being the marker's place in a table the editor keeps. The character moves with
 * its line through typing, merges coming in, and cut / paste inside the editor; on the way back each one becomes its
 * marker again at the end of its line. A table holds 95 markers; more stay as text (still kept, just visible).
 */

/** One marker, with the space before it (taken out with it). The id is lower-case, as the server writes it. */
export const TASK_MARKER = / ?<!--task:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})-->/g;

/** The text as a reader sees it: without markers. */
export function stripTaskMarkers(text: string): string {
  return text.includes("<!--task:") ? text.replace(TASK_MARKER, "") : text;
}

/** The ids of the tasks the text's markers name, in order. */
export function taskMarkerIds(text: string): string[] {
  return [...text.matchAll(TASK_MARKER)].map((m) => m[1]!);
}

const FIRST = 0xe0020;
const SLOTS = 95; // U+E0020 … U+E007E
/** One of the editor's stand-ins (a surrogate pair: two UTF-16 units). */
const STAND_IN = /[\u{E0020}-\u{E007E}]/gu;
export const STAND_IN_LENGTH = 2;

/** Whether the editor text has one of the stand-ins at `index` (UTF-16). */
export function standInAt(text: string, index: number): boolean {
  const code = text.codePointAt(index);
  return code !== undefined && code >= FIRST && code < FIRST + SLOTS && index + STAND_IN_LENGTH <= text.length;
}

/** The editor's table: which task each stand-in is. One per editor; the same id always gets the same character. */
export class TaskMarkerTable {
  private readonly ids: string[] = [];

  /** The stored text as the editor shows it: each marker (and the space before it) as its stand-in. */
  hide(wire: string): string {
    if (!wire.includes("<!--task:")) return wire;
    return wire.replace(TASK_MARKER, (whole, id: string) => {
      let slot = this.ids.indexOf(id);
      if (slot === -1) {
        if (this.ids.length >= SLOTS) return whole; // past the table: left as text
        slot = this.ids.push(id) - 1;
      }
      return String.fromCodePoint(FIRST + slot);
    });
  }

  /** The editor's text as stored: on each line the stand-ins go, and their markers follow at its end. */
  show(shown: string): string {
    if (!/[\u{E0020}-\u{E007E}]/u.test(shown)) return shown;
    return shown
      .split("\n")
      .map((line) => {
        const found: string[] = [];
        const bare = line.replace(STAND_IN, (ch) => {
          const id = this.ids[(ch.codePointAt(0) ?? FIRST) - FIRST];
          if (id !== undefined && !found.includes(id)) found.push(id);
          return "";
        });
        return found.length === 0 ? bare : `${bare} ${found.map((id) => `<!--task:${id}-->`).join(" ")}`;
      })
      .join("\n");
  }
}

/** The editor's text without the stand-ins (what a copy puts on the clipboard). */
export function stripStandIns(shown: string): string {
  return shown.replace(STAND_IN, "");
}

/**
 * Backspace (`backward`) or Delete next to a stand-in, with nothing selected: the visible character beside the caret
 * goes and the stand-ins stay (a browser would take the invisible one, or the character together with it). The caret
 * ends after any stand-ins that follow it. Null when no stand-in is involved (the browser's own deletion is right).
 */
export function deleteBesideStandIns(text: string, caret: number, backward: boolean): { text: string; caret: number } | null {
  if (backward) {
    let end = caret;
    while (end >= STAND_IN_LENGTH && standInAt(text, end - STAND_IN_LENGTH)) end -= STAND_IN_LENGTH;
    if (end === caret && !standInAt(text, end)) return null;
    if (end === 0) return { text, caret };
    const start = end - (isLowSurrogate(text.charCodeAt(end - 1)) && end >= 2 ? 2 : 1);
    return settle(text.slice(0, start) + text.slice(end), start + (caret - end));
  }
  let start = caret;
  while (standInAt(text, start)) start += STAND_IN_LENGTH;
  if (start >= text.length) return start === caret ? null : { text, caret: start };
  const end = start + (isHighSurrogate(text.charCodeAt(start)) && start + 1 < text.length ? 2 : 1);
  if (start === caret && !standInAt(text, end)) return null;
  return settle(text.slice(0, start) + text.slice(end), caret);
}

function settle(text: string, caret: number): { text: string; caret: number } {
  let at = caret;
  while (standInAt(text, at)) at += STAND_IN_LENGTH;
  return { text, caret: at };
}

const isHighSurrogate = (code: number) => code >= 0xd800 && code <= 0xdbff;
const isLowSurrogate = (code: number) => code >= 0xdc00 && code <= 0xdfff;
