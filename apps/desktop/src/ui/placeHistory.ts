import type { SearchParams } from "./search";

/**
 * M67: the wide layout's back / forward (Slack's ← →, ⌘[ / ⌘], Alt+← / →). A history of *places*: a conversation
 * (optionally the message it was revealed at) or a top-level view of the centre column. The thread pane, the pins pane,
 * a conversation's tabs and dialogs are not places. Kept in memory for one workspace's screen; never in browser storage.
 *
 * Pure: MainScreen records the place on screen with `visit` and moves with `go`.
 */

export type PlaceView = "threads" | "saved" | "activity" | "drafts" | "files" | "reminders" | "search" | "canvases" | "calendar" | "tasks" | "times";

export type Place<F = unknown> =
  | { kind: "channel"; channelId: string; /** The reveal it was left at (the controller's message focus), or none. */ focus: F | null }
  | { kind: "view"; view: PlaceView; /** "search": its query. */ search: SearchParams | null; /** "files": the channel it is scoped to. */ filesChannelId: string | null };

export interface PlaceHistory<F = unknown> {
  entries: Place<F>[];
  /** The entry on screen; -1 while empty. */
  index: number;
}

export const HISTORY_CAP = 50;

export const emptyHistory = <F>(): PlaceHistory<F> => ({ entries: [], index: -1 });

/** Which place it is: a conversation is one place whatever message it was revealed at (that is replaced, not added). */
export function placeKey(place: Place<unknown>): string {
  if (place.kind === "channel") return `channel:${place.channelId}`;
  if (place.view === "search") return `search:${JSON.stringify(place.search)}`;
  if (place.view === "files") return `files:${place.filesChannelId ?? ""}`;
  return `view:${place.view}`;
}

/**
 * The place now on screen. The same place as the current entry replaces it (consecutive duplicates are not stored, and
 * a conversation keeps its latest reveal); another drops the forward entries, goes on top, and the oldest go past the cap.
 */
export function visit<F>(history: PlaceHistory<F>, place: Place<F>, cap = HISTORY_CAP): PlaceHistory<F> {
  const current = history.entries[history.index];
  if (current && placeKey(current) === placeKey(place)) {
    const entries = history.entries.slice();
    entries[history.index] = place;
    return { entries, index: history.index };
  }
  const entries = [...history.entries.slice(0, history.index + 1), place];
  const drop = Math.max(0, entries.length - cap);
  return { entries: entries.slice(drop), index: entries.length - 1 - drop };
}

/** The nearest entry in that direction that can be shown and is not where we are (-1 when none). */
function target<F>(history: PlaceHistory<F>, step: -1 | 1, available: (place: Place<F>) => boolean): number {
  const current = history.entries[history.index];
  const here = current ? placeKey(current) : null;
  for (let i = history.index + step; i >= 0 && i < history.entries.length; i += step) {
    const place = history.entries[i]!;
    if (available(place) && placeKey(place) !== here) return i;
  }
  return -1;
}

export function canGo<F>(history: PlaceHistory<F>, step: -1 | 1, available: (place: Place<F>) => boolean): boolean {
  return target(history, step, available) >= 0;
}

/**
 * Back (-1) or forward (+1): the nearest place that can be shown (a conversation left, deleted or no longer readable is
 * skipped). The entries passed over are dropped, so they are not offered again. Null when there is nowhere to go.
 */
export function go<F>(history: PlaceHistory<F>, step: -1 | 1, available: (place: Place<F>) => boolean): { history: PlaceHistory<F>; place: Place<F> } | null {
  const to = target(history, step, available);
  if (to < 0) return null;
  const lo = Math.min(to, history.index);
  const hi = Math.max(to, history.index);
  // Keep the two ends, drop what lies strictly between them.
  const entries = [...history.entries.slice(0, lo + 1), ...history.entries.slice(hi)];
  const index = step < 0 ? lo : lo + 1;
  return { history: { entries, index }, place: entries[index]! };
}

/**
 * The web's own Back / Forward (popstate) put `place` back on screen: the entry it came from, not a new visit. The
 * nearest entry of that place (the one just behind or ahead first) becomes the current one, taking its latest reveal,
 * and nothing is dropped, so the in-app arrows go on from there. Only a place found nowhere is recorded as a visit.
 */
export function restore<F>(history: PlaceHistory<F>, place: Place<F>, cap = HISTORY_CAP): PlaceHistory<F> {
  const key = placeKey(place);
  const { entries, index } = history;
  for (let distance = 0; distance < entries.length; distance++) {
    for (const i of distance === 0 ? [index] : [index - distance, index + distance]) {
      const entry = entries[i];
      if (!entry || placeKey(entry) !== key) continue;
      const next = entries.slice();
      next[i] = place;
      return { entries: next, index: i };
    }
  }
  return visit(history, place, cap);
}
