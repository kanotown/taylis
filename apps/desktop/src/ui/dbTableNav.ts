/**
 * The database table's selected cell (WIKI.md §29): one cell is selected (highlighted) apart from the one being edited,
 * as in a spreadsheet. A row in several groups (a multi-select, people) is a line in each, so a cell is its group too.
 */

export interface CellKey {
  rowId: string;
  propId: string;
  /** The group's key ("" without grouping). */
  group: string;
}

export const sameCell = (a: CellKey | null, b: CellKey | null): boolean =>
  !!a && !!b && a.rowId === b.rowId && a.propId === b.propId && a.group === b.group;

/** The DOM id of a cell's focusable box (to move the focus with the selection). */
export const cellDomKey = (cell: CellKey): string => `${cell.group}\u001f${cell.rowId}\u001f${cell.propId}`;

/**
 * The cell an arrow key moves to from `from`, in the lines on screen (`lines`: each row of each open group, top to
 * bottom) and the columns shown; null at an edge (the selection stays) or for any other key.
 */
export function stepCell(from: CellKey, key: string, lines: { rowId: string; group: string }[], columns: string[]): CellKey | null {
  const line = lines.findIndex((l) => l.rowId === from.rowId && l.group === from.group);
  const column = columns.indexOf(from.propId);
  if (line < 0 || column < 0) return null;
  const [dl, dc] = key === "ArrowUp" ? [-1, 0] : key === "ArrowDown" ? [1, 0] : key === "ArrowLeft" ? [0, -1] : key === "ArrowRight" ? [0, 1] : [0, 0];
  if (dl === 0 && dc === 0) return null;
  const next = lines[line + dl];
  const propId = columns[column + dc];
  if (!next || !propId) return null;
  return { rowId: next.rowId, group: next.group, propId };
}

/** A key that starts editing the selected cell with what it types (a printable character, no ⌘ / Ctrl / Alt). */
export function typedSeed(event: { key: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean }): string | null {
  if (event.metaKey || event.ctrlKey || event.altKey) return null;
  return [...event.key].length === 1 && event.key !== " " ? event.key : null;
}
