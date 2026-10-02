/**
 * M75: where the reader was in each place (Slack). Going back / forward (M67) to a conversation or a centre view, and
 * opening a conversation again from the sidebar (⌘K, Alt+↑↓ …), puts the list back where it was left in this session,
 * instead of at the first unread row or the newest. Kept in memory only: per workspace, per place (placeHistory's
 * `placeKey`), a small LRU map. Never in browser storage.
 *
 * A position is an anchor, not a pixel scrollTop: the row that was topmost on screen (a message id, or a list row's
 * key) and how far below the top of the viewport it was. Late images, link cards and rows loaded above move pixels, not
 * that row. A list without keyed rows keeps a scrollTop as the last resort.
 *
 * The decisions are pure here; the DOM sides are Timeline (through its ListAnchor) and useViewScrollMemory.
 */

export interface SavedPosition {
  /** The topmost row on screen (a message id in a conversation, a row's key in a view); null: a list without keys. */
  rowKey: string | null;
  /** How far the top of that row was below the top of the viewport (negative: partly above it). */
  offset: number;
  /** The scroller's scrollTop then: only for a list without keyed rows. */
  scrollTop: number;
  /** At the end of the list: a conversation then opens as usual (the first unread row or the newest, new messages). */
  atBottom: boolean;
}

export const SCROLL_MEMORY_CAP = 100;

/** Positions by place key, the least recently used dropped past the cap. */
export class ScrollMemory {
  private readonly positions = new Map<string, SavedPosition>();

  constructor(readonly cap = SCROLL_MEMORY_CAP) {}

  save(key: string, position: SavedPosition): void {
    this.positions.delete(key);
    this.positions.set(key, position);
    while (this.positions.size > this.cap) {
      const oldest = this.positions.keys().next().value;
      if (oldest === undefined) break;
      this.positions.delete(oldest);
    }
  }

  /** The position left there (a use: it becomes the most recent). */
  get(key: string): SavedPosition | null {
    const position = this.positions.get(key);
    if (!position) return null;
    this.positions.delete(key);
    this.positions.set(key, position);
    return position;
  }

  forget(key: string): void {
    this.positions.delete(key);
  }

  get size(): number {
    return this.positions.size;
  }

  keys(): string[] {
    return [...this.positions.keys()];
  }
}

const memories = new Map<string, ScrollMemory>();

/** The memory of one workspace (its server; the screen is remounted per workspace, the memory outlives that). */
export function scrollMemoryFor(workspace: string): ScrollMemory {
  let memory = memories.get(workspace);
  if (!memory) {
    memory = new ScrollMemory();
    memories.set(workspace, memory);
  }
  return memory;
}

/** Tests: a fresh start. */
export function clearScrollMemories(): void {
  memories.clear();
}

export type RestoreDecision =
  /** Land as today (a conversation: the first unread row or the newest; a view: its top). */
  | { kind: "default" }
  /** The reader had been at the end: stay there (a conversation opens as usual, which shows what is new). */
  | { kind: "bottom" }
  /** Put this row back at this offset from the top of the viewport. */
  | { kind: "anchor"; rowKey: string; offset: number }
  /** A list without keyed rows: this scrollTop. */
  | { kind: "scrollTop"; scrollTop: number };

/**
 * What a place shows when it comes back. An explicit move to a message (a search hit, a permalink, a reveal, a history
 * entry left at a revealed message) always wins: that message is the place. Nothing saved, or no restore asked for (a
 * view opened from the sidebar starts at its top), is today's landing.
 */
export function restoreDecision(saved: SavedPosition | null, options: { explicit: boolean; requested: boolean }): RestoreDecision {
  if (options.explicit || !options.requested || !saved) return { kind: "default" };
  if (saved.atBottom) return { kind: "bottom" };
  if (saved.rowKey !== null) return { kind: "anchor", rowKey: saved.rowKey, offset: saved.offset };
  return { kind: "scrollTop", scrollTop: saved.scrollTop };
}

/** The place key of a conversation's own timeline (placeHistory's `placeKey` for it). */
export const conversationScrollKey = (channelId: string) => `channel:${channelId}`;
