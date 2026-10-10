/**
 * The height of the inline edit box (Timeline.tsx's MessageEditor, the rich editor and the text area alike).
 *
 * A long message was hard to edit in a box of the composer's size (user report 2026-10-10). The box now grows with the
 * text up to a generous cap — 60 % of the conversation's pane, never less than the composer's cap — and above it
 * scrolls by the caret's line as the composer does (composerScroll.ts). Its bottom edge can be dragged (or moved with
 * ↑ / ↓ on the focused handle): the box then keeps that height while it is open, and the height is remembered on this
 * device as the cap of later edit boxes; a double-click (or Delete) goes back to the automatic cap. Whatever the cap,
 * the box leaves room in the pane (and, on a phone, in what the keyboard leaves) for its handle and buttons.
 */

const EDIT_HEIGHT = "chikuwa.prefs.editHeight";

/** Three lines and the padding: no shorter, dragged or not. */
export const EDIT_MIN = 72;
/** What ↑ / ↓ on the handle change (a line of the rich editor). */
export const EDIT_STEP = 24;
/** Of the pane's height, the automatic cap. */
export const EDIT_SHARE = 0.6;
/** Left in the pane under the box: the handle, the buttons and a margin. */
export const EDIT_RESERVE = 64;

/** The space the box lives in, in px. */
export interface EditRoom {
  /** The conversation's (or thread's) scroller, its client height; 0 when unknown (not laid out). */
  pane: number;
  /** The visible viewport (what a phone's keyboard leaves); 0 when unknown. */
  viewport: number;
  /** The composer's cap (platform/viewport.ts composerMaxHeight). */
  composerCap: number;
}

/** The most the box may be: the pane and the visible viewport, less the room for the handle and the buttons. */
export function editMax(room: EditRoom): number {
  const visible = Math.min(room.pane > 0 ? room.pane : Infinity, room.viewport > 0 ? room.viewport : Infinity);
  return Number.isFinite(visible) ? Math.max(EDIT_MIN, Math.round(visible - EDIT_RESERVE)) : Infinity;
}

function clamp(value: number, room: EditRoom): number {
  return Math.min(editMax(room), Math.max(EDIT_MIN, Math.round(value)));
}

/**
 * How tall the box grows before it scrolls: the height the user chose (remembered), else 60 % of the pane and at least
 * the composer's cap; never more than editMax.
 */
export function editCap(room: EditRoom, preferred: number | null): number {
  if (preferred !== null) return clamp(preferred, room);
  return clamp(Math.max(room.composerCap, room.pane * EDIT_SHARE), room);
}

/**
 * The box's height for content `content` px tall (the text area's scrollHeight): the content up to the cap, or the
 * dragged height (kept while the box is open, even above shorter text).
 */
export function editBoxHeight(content: number, room: EditRoom, preferred: number | null, dragged: number | null): number {
  if (dragged !== null) return clamp(dragged, room);
  return Math.min(Math.max(content, 0), editCap(room, preferred));
}

/** The height after a key on the handle, or null when the key is not the handle's (↑ shorter, ↓ taller, Shift ×4,
 * Home / End the least and the most). */
export function handleKeyHeight(key: string, shift: boolean, current: number, room: EditRoom): number | null {
  const step = shift ? EDIT_STEP * 4 : EDIT_STEP;
  if (key === "ArrowUp") return clamp(current - step, room);
  if (key === "ArrowDown") return clamp(current + step, room);
  if (key === "Home") return EDIT_MIN;
  if (key === "End") return Number.isFinite(editMax(room)) ? editMax(room) : current;
  return null;
}

/** A vertical span in viewport pixels. */
export interface Span {
  top: number;
  bottom: number;
}

/**
 * How far to scroll the conversation so the edit box (with its buttons) is in view, its top first: down until its
 * bottom shows, but never so far that its top leaves the view. On opening (`open`), also up when its top is above the
 * view (the message opened above the screen). While typing the view only follows the box's growth downwards: a reader
 * who scrolled the box's top away is not pulled back to it.
 */
export function revealDelta(view: Span, box: Span, open: boolean, margin = 8): number {
  let delta = 0;
  if (box.bottom + margin > view.bottom) delta = Math.min(box.bottom + margin - view.bottom, Math.max(0, box.top - view.top - margin));
  if (open && box.top - delta < view.top + margin) delta = box.top - view.top - margin;
  return Math.abs(delta) < 1 ? 0 : delta;
}

function read(): string | null {
  try {
    return localStorage.getItem(EDIT_HEIGHT);
  } catch {
    return null;
  }
}

/** The height chosen on this device (per device: browser storage), null for the automatic cap. */
export function readEditHeight(): number | null {
  const raw = read();
  if (raw === null) return null;
  const value = Number(raw);
  return Number.isFinite(value) && value >= EDIT_MIN && value <= 10000 ? value : null;
}

export function writeEditHeight(value: number | null): void {
  try {
    if (value === null) localStorage.removeItem(EDIT_HEIGHT);
    else localStorage.setItem(EDIT_HEIGHT, String(Math.round(value)));
  } catch {
    /* a per-device convenience only */
  }
}
