/**
 * M57 (CANVAS.md §17): the canvas's table editor — a dialog with the table's cells as a grid of inputs (the header row
 * first). Tab / Shift+Tab move between the cells, Enter in the last cell adds a row; each row and each column has a
 * menu (also opened from a cell with Shift+F10 or the menu key). 「完了」 hands the table to the canvas editor, which
 * writes it back as one edit; 「キャンセル」, Esc and the close button change nothing. A click outside does not close
 * it (the edits would be lost).
 */
import { ChevronDown, EllipsisVertical, Plus, X } from "lucide-react";
import { Dialog } from "radix-ui";
import { type KeyboardEvent, useEffect, useRef, useState } from "react";

import { type Align, applyTableOp, type Table, type TableOp } from "./canvasTable";
import { Button, cn, Menu, MenuContent, MenuItem, MenuLabel, MenuRadioGroup, MenuRadioItem, MenuSeparator, MenuTrigger, modKey } from "./primitives";

const ALIGNS: Array<[string, Align, string]> = [["none", null, "なし"], ["left", "left", "左"], ["center", "center", "中央"], ["right", "right", "右"]];
const TEXT_ALIGN: Record<string, string> = { null: "text-left", left: "text-left", center: "text-center", right: "text-right" };

/** A cell's place: row -1 is the header. */
type Cell = { row: number; col: number };

export function CanvasTableDialog({ initial, isNew, onDone, onCancel, onClosed }: {
  initial: Table;
  /** The table was just put in for this (the title says 「表を追加」). */
  isNew: boolean;
  onDone: (table: Table) => void;
  onCancel: () => void;
  /** After the dialog has gone (the focus is handed back): the editor writes the table back then. */
  onClosed: () => void;
}) {
  const [table, setTable] = useState(initial);
  const [menu, setMenu] = useState<string | null>(null);
  const cells = useRef(new Map<string, HTMLInputElement>());
  /** The cell to focus once the table has been drawn again (an edit from a key or a button). */
  const focusAfterDraw = useRef<Cell | null>(null);
  /** The cell to focus when a menu closes (its edit's cell, or the cell it was opened from); else its button. */
  const focusAfterMenu = useRef<Cell | null>(null);
  const cols = table.header.length;
  const rows = table.rows.length;

  const focusCell = (cell: Cell) => {
    const el = cells.current.get(`${cell.row}:${cell.col}`);
    if (!el) return false;
    el.focus();
    el.select();
    return true;
  };

  useEffect(() => {
    if (focusAfterDraw.current && focusCell(focusAfterDraw.current)) focusAfterDraw.current = null;
  });

  /** An edit from a key or a button; `focus` is the cell to go to then. */
  const run = (op: TableOp, focus: Cell) => {
    setTable((t) => applyTableOp(t, op));
    focusAfterDraw.current = focus;
  };
  /** An edit from a menu; `focus` (when given) is the cell to go to when the menu has closed. */
  const runFromMenu = (op: TableOp, focus?: Cell) => {
    setTable((t) => applyTableOp(t, op));
    if (focus) focusAfterMenu.current = focus;
  };

  const setCell = ({ row, col }: Cell, value: string) =>
    setTable((t) => (row < 0
      ? { ...t, header: t.header.map((h, i) => (i === col ? value : h)) }
      : { ...t, rows: t.rows.map((r, i) => (i === row ? r.map((c, j) => (j === col ? value : c)) : r)) }));

  const onCellKey = (event: KeyboardEvent<HTMLInputElement>, cell: Cell) => {
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    const index = (cell.row + 1) * cols + cell.col;
    const last = (rows + 1) * cols - 1;
    const at = (i: number): Cell => ({ row: Math.floor(i / cols) - 1, col: i % cols });
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      onDone(table);
    } else if (event.key === "Tab" && !event.altKey && !event.metaKey && !event.ctrlKey) {
      const next = index + (event.shiftKey ? -1 : 1);
      if (next < 0 || next > last) return; // out of the grid: the browser's own Tab
      event.preventDefault();
      focusCell(at(next));
    } else if (event.key === "Enter") {
      event.preventDefault();
      if (index === last) run(["add_row", rows], { row: rows, col: 0 });
      else focusCell(at(index + 1));
    } else if ((event.key === "F10" && event.shiftKey) || event.key === "ContextMenu") {
      event.preventDefault();
      focusAfterMenu.current = cell;
      setMenu(cell.row < 0 ? `col:${cell.col}` : `row:${cell.row}`);
    }
  };

  const cellInput = (cell: Cell, value: string, label: string) => (
    <input
      ref={(el) => {
        if (el) cells.current.set(`${cell.row}:${cell.col}`, el);
        else cells.current.delete(`${cell.row}:${cell.col}`);
      }}
      aria-label={label}
      value={value}
      spellCheck={false}
      onChange={(event) => setCell(cell, event.target.value)}
      onKeyDown={(event) => onCellKey(event, cell)}
      className={cn(
        "h-9 w-full min-w-28 border-0 bg-transparent px-2.5 text-sm text-ink outline-none focus:bg-accent-soft/60 focus:ring-2 focus:ring-inset focus:ring-accent/50",
        TEXT_ALIGN[String(table.align[cell.col] ?? null)],
        cell.row < 0 && "font-semibold",
      )}
    />
  );

  /** A menu's own props: opened by its button or from a cell (Shift+F10). */
  const menuProps = (key: string) => ({ open: menu === key, onOpenChange: (open: boolean) => setMenu(open ? key : null) });
  const contentProps = {
    onCloseAutoFocus: (event: Event) => {
      const cell = focusAfterMenu.current;
      focusAfterMenu.current = null;
      if (cell && focusCell(cell)) event.preventDefault();
    },
  };

  return (
    <Dialog.Root open onOpenChange={(open) => { if (!open) onCancel(); }}>
      <Dialog.Portal>
        <Dialog.Overlay className="rx-overlay fixed inset-0 z-40 bg-black/40 backdrop-blur-[2px]" />
        <Dialog.Content
          onPointerDownOutside={(event) => event.preventDefault()}
          onOpenAutoFocus={(event) => {
            // The first heading, selected: typing replaces 「列1」 of a new table.
            if (focusCell({ row: -1, col: 0 })) event.preventDefault();
          }}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            onClosed();
          }}
          className="rx-dialog fixed left-1/2 top-1/2 z-50 flex max-h-[88dvh] w-[min(960px,94vw)] -translate-x-1/2 -translate-y-1/2 flex-col rounded-2xl border border-line bg-canvas p-5 text-ink shadow-2xl focus:outline-none max-md:p-4"
        >
          <Dialog.Title className="text-base font-semibold">{isNew ? "表を追加" : "表を編集"}</Dialog.Title>
          <Dialog.Description className="mt-1 text-xs text-muted">
            Tab で次のマス、最後のマスで Enter を押すと行を追加します。Shift+F10 で行 (見出しでは列) のメニューを開きます。
          </Dialog.Description>
          <Dialog.Close asChild>
            <button type="button" aria-label="閉じる" className="absolute right-3 top-3 inline-flex h-7 w-7 items-center justify-center rounded-md text-muted hover:bg-ink/6">
              <X size={16} />
            </button>
          </Dialog.Close>

          <div className="mt-4 min-h-0 overflow-auto rounded-lg border border-line">
            <table className="w-full border-collapse text-sm">
              <thead>
                <tr className="bg-panel">
                  <th className="w-10 border-b border-line" aria-hidden />
                  {table.header.map((_, col) => (
                    <th key={col} className="border-b border-l border-line px-1 py-0.5 text-left font-normal">
                      <Menu {...menuProps(`col:${col}`)}>
                        <MenuTrigger asChild>
                          <button type="button" aria-label={`${col + 1} 列目のメニュー`} className="inline-flex h-6 items-center gap-1 rounded-md px-1.5 text-xs text-muted hover:bg-ink/6 hover:text-ink">
                            {col + 1} 列<ChevronDown size={12} />
                          </button>
                        </MenuTrigger>
                        <MenuContent align="start" {...contentProps}>
                          <MenuItem onSelect={() => runFromMenu(["add_column", col], { row: -1, col })}>左に列を追加</MenuItem>
                          <MenuItem onSelect={() => runFromMenu(["add_column", col + 1], { row: -1, col: col + 1 })}>右に列を追加</MenuItem>
                          <MenuItem disabled={cols <= 1} onSelect={() => runFromMenu(["delete_column", col], { row: -1, col: Math.min(col, cols - 2) })}>列を削除</MenuItem>
                          <MenuSeparator />
                          <MenuLabel>揃え</MenuLabel>
                          <MenuRadioGroup
                            value={ALIGNS.find(([, a]) => a === (table.align[col] ?? null))?.[0] ?? "none"}
                            onValueChange={(value) => runFromMenu(["set_align", col, ALIGNS.find(([key]) => key === value)?.[1] ?? null])}
                          >
                            {ALIGNS.map(([key, , label]) => (
                              <MenuRadioItem key={key} value={key}>{label}</MenuRadioItem>
                            ))}
                          </MenuRadioGroup>
                        </MenuContent>
                      </Menu>
                    </th>
                  ))}
                </tr>
                <tr className="bg-panel-2">
                  <th scope="row" className="whitespace-nowrap border-b border-line px-1.5 text-[11px] font-normal text-muted">見出し</th>
                  {table.header.map((value, col) => (
                    <th key={col} className="border-b border-l border-line p-0">{cellInput({ row: -1, col }, value, `見出し ${col + 1}`)}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {table.rows.map((cellsOfRow, row) => (
                  <tr key={row}>
                    <td className="border-b border-line px-0.5 text-center">
                      <Menu {...menuProps(`row:${row}`)}>
                        <MenuTrigger asChild>
                          <button type="button" aria-label={`${row + 2} 行目のメニュー`} className="inline-flex h-7 w-6 items-center justify-center rounded-md text-muted hover:bg-ink/6 hover:text-ink">
                            <EllipsisVertical size={14} />
                          </button>
                        </MenuTrigger>
                        <MenuContent align="start" {...contentProps}>
                          <MenuItem onSelect={() => runFromMenu(["add_row", row], { row, col: 0 })}>上に行を追加</MenuItem>
                          <MenuItem onSelect={() => runFromMenu(["add_row", row + 1], { row: row + 1, col: 0 })}>下に行を追加</MenuItem>
                          <MenuSeparator />
                          <MenuItem disabled={row === 0} onSelect={() => runFromMenu(["move_row", row, row - 1], { row: row - 1, col: focusAfterMenu.current?.col ?? 0 })}>上へ</MenuItem>
                          <MenuItem disabled={row === rows - 1} onSelect={() => runFromMenu(["move_row", row, row + 1], { row: row + 1, col: focusAfterMenu.current?.col ?? 0 })}>下へ</MenuItem>
                          <MenuSeparator />
                          <MenuItem onSelect={() => runFromMenu(["delete_row", row], rows > 1 ? { row: Math.min(row, rows - 2), col: 0 } : { row: -1, col: 0 })}>行を削除</MenuItem>
                        </MenuContent>
                      </Menu>
                    </td>
                    {cellsOfRow.map((value, col) => (
                      <td key={col} className="border-b border-l border-line p-0">{cellInput({ row, col }, value, `${row + 2} 行目 ${col + 1} 列`)}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="mt-4 flex flex-wrap items-center gap-2">
            <Button variant="secondary" size="sm" onClick={() => run(["add_row", rows], { row: rows, col: 0 })}>
              <Plus size={14} /> 行を追加
            </Button>
            <Button variant="secondary" size="sm" onClick={() => run(["add_column", cols], { row: -1, col: cols })}>
              <Plus size={14} /> 列を追加
            </Button>
            <span className="ml-auto" />
            <Button variant="ghost" onClick={onCancel}>キャンセル</Button>
            <Button title={`${modKey()}+Enter`} onClick={() => onDone(table)}>完了</Button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
