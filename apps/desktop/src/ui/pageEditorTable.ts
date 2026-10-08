/**
 * M151 (WIKI.md §28): a page table's cells edited in place — where the caret is, moving between cells (Tab, Shift+Tab,
 * Enter, Shift+Enter), rows and columns added and deleted, a column's alignment, and the shape kept (every row as many
 * cells as the header, whatever an edit across cells did). Each is a transaction; the table is then written anew as
 * GFM (pageMarkdown.tableText), an untouched one as it was read.
 */
import type { Node as PMNode } from "@tiptap/pm/model";
import { type EditorState, Plugin, PluginKey, TextSelection, type Transaction } from "@tiptap/pm/state";

export type CellAlign = "left" | "center" | "right" | null;

/** The table the caret is in, and its cell (row 0 is the header). */
export interface CellPlace {
  tablePos: number;
  table: PMNode;
  row: number;
  col: number;
}

export function cellPlace(state: EditorState): CellPlace | null {
  const { $from } = state.selection;
  for (let d = $from.depth; d >= 2; d--) {
    if ($from.node(d).type.name !== "tableCell") continue;
    return { tablePos: $from.before(d - 2), table: $from.node(d - 2), row: $from.index(d - 2), col: $from.index(d - 1) };
  }
  return null;
}

/** The position inside cell (`row`, `col`) of the table at `tablePos` (its start, or its end). */
export function cellPos(table: PMNode, tablePos: number, row: number, col: number, end = false): number {
  let pos = tablePos + 1;
  for (let r = 0; r < row; r++) pos += table.child(r).nodeSize;
  const rowNode = table.child(row);
  pos += 1;
  for (let c = 0; c < col; c++) pos += rowNode.child(c).nodeSize;
  return pos + 1 + (end ? rowNode.child(col).content.size : 0);
}

/** A new row for the table: empty cells with the header's alignments. */
function emptyRow(state: EditorState, table: PMNode): PMNode {
  const { tableRow, tableCell } = state.schema.nodes;
  const header = table.child(0);
  const cells: PMNode[] = [];
  header.forEach((cell) => cells.push(tableCell!.create({ align: cell.attrs.align })));
  return tableRow!.create(null, cells);
}

/** The caret put into a cell of the table at `tablePos` in `tr`'s document (its text selected, as a sheet does). */
function into(tr: Transaction, tablePos: number, row: number, col: number, select = true): Transaction {
  const table = tr.doc.nodeAt(tablePos)!;
  const from = cellPos(table, tablePos, row, col);
  const to = cellPos(table, tablePos, row, col, true);
  return tr.setSelection(TextSelection.create(tr.doc, select ? from : to, to)).scrollIntoView();
}

/** Tab / Shift+Tab: the next / previous cell (Tab in the last cell adds a row). Null outside a table. */
export function stepCell(state: EditorState, direction: 1 | -1): Transaction | null {
  const place = cellPlace(state);
  if (!place) return null;
  const { table, tablePos } = place;
  const width = table.child(0).childCount;
  let row = place.row;
  let col = place.col + direction;
  if (col >= table.child(row).childCount) {
    row++;
    col = 0;
  } else if (col < 0) {
    row--;
    col = width - 1;
  }
  if (row < 0) return state.tr;
  if (row >= table.childCount) {
    const tr = state.tr.insert(tablePos + table.nodeSize - 1, emptyRow(state, table));
    return into(tr, tablePos, row, 0);
  }
  return into(state.tr, tablePos, row, Math.min(col, table.child(row).childCount - 1));
}

/** Enter / Shift+Enter: the cell below / above (Enter on the last row adds a row). Never a line break: GFM has none. */
export function verticalCell(state: EditorState, direction: 1 | -1): Transaction | null {
  const place = cellPlace(state);
  if (!place) return null;
  const { table, tablePos, col } = place;
  const row = place.row + direction;
  if (row < 0) return state.tr;
  let tr = state.tr;
  if (row >= table.childCount) tr = tr.insert(tablePos + table.nodeSize - 1, emptyRow(state, table));
  const next = tr.doc.nodeAt(tablePos)!;
  return into(tr, tablePos, row, Math.min(col, next.child(row).childCount - 1), false);
}

export type TableEdit = "rowAbove" | "rowBelow" | "deleteRow" | "columnLeft" | "columnRight" | "deleteColumn" | { align: CellAlign };

/** One edit of the caret's table; null outside one (or when it would leave no row / no column). */
export function editTable(state: EditorState, edit: TableEdit): Transaction | null {
  const place = cellPlace(state);
  if (!place) return null;
  const { table, tablePos, row, col } = place;
  const { tableRow, tableCell } = state.schema.nodes;
  const rows: PMNode[] = [];
  table.forEach((r) => rows.push(r));
  const cellsOf = (r: PMNode) => {
    const out: PMNode[] = [];
    r.forEach((c) => out.push(c));
    return out;
  };
  let caret = { row, col };
  if (edit === "rowAbove" || edit === "rowBelow") {
    // Above the header: the new row is the header (the old header a body row).
    const at = edit === "rowAbove" ? row : row + 1;
    rows.splice(at, 0, emptyRow(state, table));
    caret = { row: at, col };
  } else if (edit === "deleteRow") {
    if (rows.length <= 1) return null;
    rows.splice(row, 1);
    caret = { row: Math.min(row, rows.length - 1), col };
  } else if (edit === "columnLeft" || edit === "columnRight") {
    const at = edit === "columnLeft" ? col : col + 1;
    for (let r = 0; r < rows.length; r++) {
      const cells = cellsOf(rows[r]!);
      cells.splice(Math.min(at, cells.length), 0, tableCell!.create());
      rows[r] = tableRow!.create(null, cells);
    }
    caret = { row, col: at };
  } else if (edit === "deleteColumn") {
    if (table.child(0).childCount <= 1) return null;
    for (let r = 0; r < rows.length; r++) {
      const cells = cellsOf(rows[r]!);
      if (col < cells.length) cells.splice(col, 1);
      rows[r] = tableRow!.create(null, cells.length > 0 ? cells : [tableCell!.create()]);
    }
    caret = { row, col: Math.max(0, col - (col >= table.child(0).childCount - 1 ? 1 : 0)) };
  } else {
    for (let r = 0; r < rows.length; r++) {
      const cells = cellsOf(rows[r]!);
      if (col < cells.length) cells[col] = cells[col]!.type.create({ ...cells[col]!.attrs, align: edit.align }, cells[col]!.content);
      rows[r] = tableRow!.create(null, cells);
    }
  }
  const tr = state.tr.replaceWith(tablePos, tablePos + table.nodeSize, table.type.create(table.attrs, rows));
  return into(tr, tablePos, caret.row, caret.col, false);
}

const shapeKey = new PluginKey("pageTableShape");

/**
 * Every row of a changed table as many cells as its header (an edit across cells can join or split them): short rows
 * get empty cells, long ones lose the cells past the header (GFM drops them too).
 */
export const tableShape = () =>
  new Plugin({
    key: shapeKey,
    appendTransaction: (transactions, _old, state) => {
      if (!transactions.some((tr) => tr.docChanged)) return null;
      const tables = new Set<number>();
      for (const tr of transactions) {
        for (const map of tr.mapping.maps) {
          map.forEach((_a, _b, from, to) => {
            for (const at of [from, to]) {
              const $at = state.doc.resolve(Math.min(at, state.doc.content.size));
              for (let d = $at.depth; d >= 1; d--) if ($at.node(d).type.name === "table") tables.add($at.before(d));
            }
            // Tables put in whole (pasted).
            state.doc.nodesBetween(Math.min(from, state.doc.content.size), Math.min(to, state.doc.content.size), (node, pos) => {
              if (node.type.name === "table") tables.add(pos);
              return node.type.name !== "table" && !node.isTextblock;
            });
          });
        }
      }
      if (tables.size === 0) return null;
      const tr = state.tr;
      for (const pos of [...tables].sort((a, b) => b - a)) {
        const table = state.doc.nodeAt(pos);
        if (!table || table.type.name !== "table") continue;
        const width = table.child(0).childCount;
        let rowPos = pos + 1;
        const fixes: Array<{ at: number; size: number; row: PMNode }> = [];
        table.forEach((row) => {
          if (row.childCount !== width) {
            const cells: PMNode[] = [];
            for (let k = 0; k < width; k++) cells.push(k < row.childCount ? row.child(k) : state.schema.nodes.tableCell!.create({ align: table.child(0).child(k).attrs.align }));
            fixes.push({ at: rowPos, size: row.nodeSize, row: row.type.create(row.attrs, cells) });
          }
          rowPos += row.nodeSize;
        });
        for (const fix of fixes.reverse()) tr.replaceWith(fix.at, fix.at + fix.size, fix.row);
      }
      return tr.docChanged ? tr : null;
    },
  });
