/**
 * A conversation opened at a message (a search hit, an activity row, a permalink) shows the window the server sent
 * around it (`GET /messages/{id}/context`), not the store's live tail, under 「検索位置の前後の会話」 / 「最新の会話に戻る」.
 *
 * That window often reaches the newest message (a short channel, a recent mention), and the store may hold every row
 * after it anyway. The window then joins the live tail: rows that came in since (or that the store had beyond the
 * window) follow it, new ones keep coming as in the live view, and 「最新の会話に戻る」 is only offered while the reader
 * is away from the end (user report 2026-10-07: it stayed while the view showed the newest message).
 */

import { covers } from "../sync/readGate";
import type { MessageState } from "../sync/types";

export interface FocusWindow {
  /** The rows to draw: the window (fresher copies from the store where it has them), then the live tail when joined. */
  rows: MessageState[];
  /** The window meets the store's loaded range, which runs to the newest row: nothing newer is missing below. */
  joined: boolean;
}

/**
 * `context` is the server's window, each row already replaced by a fresher store copy; `live` the store's timeline of the
 * channel (store.messages) and `oldestLoadedSeq` where its loaded range starts. The store holds every row from
 * `oldestLoadedSeq` up, so when that is at or below the window's newest row (+1), the two meet and nothing lies between.
 */
export function focusWindow(context: readonly MessageState[], live: readonly MessageState[], oldestLoadedSeq: number | null): FocusWindow {
  const newest = context.reduce((max, m) => (m.seq !== null && m.seq > max ? m.seq : max), -1);
  const joined = newest >= 0 && covers(oldestLoadedSeq, newest);
  const shown = context.filter((m) => !m.deleted);
  if (!joined) return { rows: shown, joined };
  const ids = new Set(context.map((m) => m.id));
  // My placeholders (no seq yet) too: a post sent from here shows at the end, as in the live view.
  const tail = live.filter((m) => !m.deleted && !ids.has(m.id) && (m.seq === null || m.seq > newest));
  return { rows: tail.length > 0 ? [...shown, ...tail] : shown, joined };
}

/** 「最新の会話に戻る」: while newer rows are not in the window, or the reader is away from its end (the round button's rule). */
export function backToLatestShown(joined: boolean, awayFromEnd: boolean): boolean {
  return !joined || awayFromEnd;
}
