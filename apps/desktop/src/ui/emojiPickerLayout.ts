/**
 * The emoji picker's one scrolling list (2026-10-07, docs/EMOJI.md §6): its sections in order, the section the scroll
 * position is in, and the lazily drawn chunks of a section's grid. Pure, for the tests.
 */

/** The section keys in list (and tab) order: recent, the ungrouped custom emoji, each pack, then the standard categories. */
export function pickerSectionKeys(opts: { recent: boolean; custom: boolean; packIds: readonly string[]; standard: readonly string[] }): string[] {
  return [...(opts.recent ? ["recent"] : []), ...(opts.custom ? ["custom"] : []), ...opts.packIds.map((id) => `pack:${id}`), ...opts.standard];
}

/**
 * The section the list is scrolled to: the last one whose top is at or above the top of the view (`tops` are the
 * sections' offsets in the list, ascending). A tab click scrolls to exactly a section's top, so that section wins
 * (1px of slack for fractional scroll positions).
 */
export function sectionAt(tops: readonly number[], scrollTop: number): number {
  let index = 0;
  for (let i = 0; i < tops.length; i++) {
    if (tops[i]! <= scrollTop + 1) index = i;
    else break;
  }
  return index;
}

export interface GridChunk {
  start: number;
  end: number;
  /** Exact height in px (rows × cell): a chunk takes its room before it is drawn, so nothing moves when it is. */
  height: number;
}

/** A grid of `count` cells in `columns` columns, cut into chunks of `rowsPerChunk` rows of `cell` px. */
export function gridChunks(count: number, columns: number, cell: number, rowsPerChunk: number): GridChunk[] {
  const chunks: GridChunk[] = [];
  const per = columns * rowsPerChunk;
  for (let start = 0; start < count; start += per) {
    const end = Math.min(count, start + per);
    chunks.push({ start, end, height: Math.ceil((end - start) / columns) * cell });
  }
  return chunks;
}
