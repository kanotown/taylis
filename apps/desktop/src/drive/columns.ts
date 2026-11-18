/**
 * The drive list's column widths (docs/DRIVE.md §27.9): 更新日時, 更新した人 and 大きさ have widths the person drags
 * (kept on this device, prefs.ts); the name column takes the rest and keeps at least NAME_MIN beside what is shown.
 * As the listing narrows, things give way in one order (who changed it, the size, the rows' hover buttons, the time),
 * judged by the widths as set: a widened column hides sooner rather than squeezing the names.
 */

export type DriveColumn = "modified" | "by" | "size";
export type DriveColumnWidths = Readonly<Record<DriveColumn, number>>;

/** The optional columns, left to right (each has a handle on its left edge while shown). */
export const DRIVE_COLUMNS: readonly DriveColumn[] = ["modified", "by", "size"];

export const COLUMN_LIMITS: Readonly<Record<DriveColumn, { readonly default: number; readonly min: number; readonly max: number }>> = {
  modified: { default: 144, min: 72, max: 320 },
  by: { default: 128, min: 72, max: 320 },
  size: { default: 80, min: 56, max: 200 },
};

export const DEFAULT_COLUMN_WIDTHS: DriveColumnWidths = { modified: COLUMN_LIMITS.modified.default, by: COLUMN_LIMITS.by.default, size: COLUMN_LIMITS.size.default };

/** The name column's least width beside what is shown: a drag stops there, and a column hides before it. */
export const NAME_MIN = 200;
/** The check box column. */
export const CHECK_WIDTH = 40;
/** The row actions: the ⋯ alone, or with the hover buttons (共有・ダウンロード) before it. */
export const ACTIONS_NARROW = 40;
export const ACTIONS_WIDE = 104;
/** One press of ← / → on a handle. */
export const COLUMN_STEP = 16;

/** What the list shows at a width of the listing (§27.4): the optional columns and the rows' hover buttons. */
export interface DriveColumns {
  modified: boolean;
  by: boolean;
  size: boolean;
  hover: boolean;
}

/** The order in which they give way as the listing narrows (each step frees room, so a wider listing never shows less). */
const GIVE_WAY: readonly (keyof DriveColumns)[] = ["by", "size", "hover", "modified"];

export function actionsWidth(shown: Pick<DriveColumns, "hover">): number {
  return shown.hover ? ACTIONS_WIDE : ACTIONS_NARROW;
}

/** What the name column gets in a table `tableWidth` px wide beside the check box, the actions and the shown columns. */
function nameRoom(tableWidth: number, widths: DriveColumnWidths, shown: DriveColumns): number {
  return DRIVE_COLUMNS.reduce((room, column) => (shown[column] ? room - widths[column] : room), tableWidth - CHECK_WIDTH - actionsWidth(shown));
}

/**
 * What a listing `width` px wide shows (Infinity: not measured yet): everything while the name keeps NAME_MIN, else
 * who changed it goes first, then the size, then the hover buttons (the ⋯ stays), then the time.
 */
export function driveColumns(width: number, widths: DriveColumnWidths = DEFAULT_COLUMN_WIDTHS): DriveColumns {
  const shown: DriveColumns = { modified: true, by: true, size: true, hover: true };
  for (const next of GIVE_WAY) {
    if (nameRoom(width, widths, shown) >= NAME_MIN) break;
    shown[next] = false;
  }
  return shown;
}

/** How wide `column` may be made now: its own limits, and no wider than leaves the name NAME_MIN beside the rest shown. */
export function columnRange(column: DriveColumn, widths: DriveColumnWidths, shown: DriveColumns, tableWidth: number): { min: number; max: number } {
  const { min, max } = COLUMN_LIMITS[column];
  const room = nameRoom(tableWidth, widths, { ...shown, [column]: false }) - NAME_MIN;
  return { min, max: Math.max(min, Math.min(max, Math.floor(room))) };
}

/** A width dragged or stepped to, kept within `range` (whole pixels). */
export function clampColumn(value: number, range: { min: number; max: number }): number {
  return Math.round(Math.min(range.max, Math.max(range.min, value)));
}

/** Widths read back from storage: each a number within its column's limits, else that column's default. */
export function columnWidthsFrom(raw: unknown): DriveColumnWidths {
  const stored = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
  const widths = { ...DEFAULT_COLUMN_WIDTHS };
  for (const column of DRIVE_COLUMNS) {
    const value = stored[column];
    const { min, max } = COLUMN_LIMITS[column];
    if (typeof value === "number" && Number.isFinite(value) && value >= min && value <= max) widths[column] = Math.round(value);
  }
  return widths;
}

/** The widths worth storing: those not at their default (null when every column is). */
export function changedWidths(widths: DriveColumnWidths): Partial<Record<DriveColumn, number>> | null {
  const changed: Partial<Record<DriveColumn, number>> = {};
  for (const column of DRIVE_COLUMNS) if (widths[column] !== DEFAULT_COLUMN_WIDTHS[column]) changed[column] = widths[column];
  return Object.keys(changed).length > 0 ? changed : null;
}
