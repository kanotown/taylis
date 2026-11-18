// @vitest-environment jsdom
/**
 * §27.4 / §27.9 (docs/DRIVE.md): the drive list's columns — what gives way as the listing narrows (judged by the widths
 * as set), how far a column may be dragged (its limits, and the name's least width), and the widths kept on this device.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { actionsWidth, CHECK_WIDTH, changedWidths, clampColumn, COLUMN_LIMITS, columnRange, columnWidthsFrom, DEFAULT_COLUMN_WIDTHS, DRIVE_COLUMNS, driveColumns, type DriveColumns, type DriveColumnWidths, NAME_MIN } from "../src/drive/columns";
import { readDriveColumnWidths, writeDriveColumnWidth } from "../src/ui/prefs";

afterEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

const ALL: DriveColumns = { modified: true, by: true, size: true, hover: true };

/** The name column's width in a table `width` px wide showing `shown`. */
function nameWidth(width: number, widths: DriveColumnWidths, shown: DriveColumns): number {
  return width - CHECK_WIDTH - actionsWidth(shown) - DRIVE_COLUMNS.reduce((sum, column) => sum + (shown[column] ? widths[column] : 0), 0);
}

describe("driveColumns", () => {
  it("gives way as the listing narrows: who changed it, then the size, then the hover buttons, then the time", () => {
    expect(driveColumns(Infinity)).toEqual(ALL);
    expect(driveColumns(1000)).toEqual(ALL);
    // The default widths: everything from 696 px (the name keeps 200), as about 700 before the widths could change.
    expect(driveColumns(696)).toEqual(ALL);
    expect(driveColumns(695)).toEqual({ ...ALL, by: false });
    expect(driveColumns(650)).toEqual({ ...ALL, by: false });
    expect(driveColumns(568)).toEqual({ ...ALL, by: false });
    expect(driveColumns(567)).toEqual({ modified: true, by: false, size: false, hover: true });
    expect(driveColumns(488)).toEqual({ modified: true, by: false, size: false, hover: true });
    expect(driveColumns(487)).toEqual({ modified: true, by: false, size: false, hover: false });
    expect(driveColumns(424)).toEqual({ modified: true, by: false, size: false, hover: false });
    expect(driveColumns(423)).toEqual({ modified: false, by: false, size: false, hover: false });
    expect(driveColumns(360)).toEqual({ modified: false, by: false, size: false, hover: false });
  });

  it("judges by the widths as set: a widened column hides sooner, narrowed ones stay longer", () => {
    const wide = { ...DEFAULT_COLUMN_WIDTHS, modified: 300 };
    expect(driveColumns(800)).toEqual(ALL);
    expect(driveColumns(800, wide)).toEqual({ ...ALL, by: false });
    expect(driveColumns(600, wide)).toEqual({ modified: true, by: false, size: false, hover: false });
    expect(driveColumns(579, wide)).toEqual({ modified: false, by: false, size: false, hover: false });
    const narrow = { modified: 72, by: 72, size: 56 };
    expect(driveColumns(544, narrow)).toEqual(ALL);
    expect(driveColumns(543, narrow)).toEqual({ ...ALL, by: false });
  });

  it("never leaves the name less than its minimum, and a wider listing never shows less", () => {
    const sets: DriveColumnWidths[] = [DEFAULT_COLUMN_WIDTHS, { modified: 72, by: 72, size: 56 }, { modified: 320, by: 320, size: 200 }, { modified: 90, by: 250, size: 140 }];
    for (const widths of sets) {
      let before = driveColumns(0, widths);
      for (let width = 0; width <= 1600; width += 1) {
        const shown = driveColumns(width, widths);
        if (shown.modified || shown.hover) expect(nameWidth(width, widths, shown)).toBeGreaterThanOrEqual(NAME_MIN);
        for (const key of ["modified", "by", "size", "hover"] as const) if (before[key]) expect(shown[key]).toBe(true);
        before = shown;
      }
    }
  });
});

describe("columnRange and clampColumn", () => {
  it("a column may grow only as far as leaves the name its minimum beside the rest shown", () => {
    expect(columnRange("modified", DEFAULT_COLUMN_WIDTHS, ALL, Infinity)).toEqual({ min: 72, max: 320 });
    // 700 px with the defaults: the name has 204, so each column may grow by 4.
    expect(columnRange("modified", DEFAULT_COLUMN_WIDTHS, ALL, 700)).toEqual({ min: 72, max: 148 });
    expect(columnRange("by", DEFAULT_COLUMN_WIDTHS, ALL, 700)).toEqual({ min: 72, max: 132 });
    expect(columnRange("size", DEFAULT_COLUMN_WIDTHS, ALL, 700)).toEqual({ min: 56, max: 84 });
    // A hidden column takes no room from the others.
    expect(columnRange("modified", DEFAULT_COLUMN_WIDTHS, { ...ALL, by: false }, 700)).toEqual({ min: 72, max: 276 });
    // Never below the column's own minimum, however narrow.
    expect(columnRange("size", DEFAULT_COLUMN_WIDTHS, ALL, 300)).toEqual({ min: 56, max: 56 });
    for (const column of DRIVE_COLUMNS) {
      const range = columnRange(column, DEFAULT_COLUMN_WIDTHS, ALL, 2000);
      expect(range).toEqual({ min: COLUMN_LIMITS[column].min, max: COLUMN_LIMITS[column].max });
    }
  });

  it("a width is kept within its range in whole pixels", () => {
    expect(clampColumn(10, { min: 72, max: 320 })).toBe(72);
    expect(clampColumn(999, { min: 72, max: 320 })).toBe(320);
    expect(clampColumn(150.6, { min: 72, max: 320 })).toBe(151);
  });
});

describe("the widths on this device", () => {
  it("reads defaults until a column is changed; keeps only the changed ones; a default is not stored", () => {
    expect(readDriveColumnWidths()).toEqual(DEFAULT_COLUMN_WIDTHS);
    writeDriveColumnWidth("modified", 200);
    expect(readDriveColumnWidths()).toEqual({ ...DEFAULT_COLUMN_WIDTHS, modified: 200 });
    expect(JSON.parse(localStorage.getItem("chikuwa.prefs.driveColumns")!)).toEqual({ modified: 200 });
    // Another column changed later keeps the first (another listing may have set it).
    writeDriveColumnWidth("size", 64);
    expect(readDriveColumnWidths()).toEqual({ modified: 200, by: 128, size: 64 });
    writeDriveColumnWidth("modified", 144);
    writeDriveColumnWidth("size", 80);
    expect(localStorage.getItem("chikuwa.prefs.driveColumns")).toBeNull();
  });

  it("anything out of a column's limits or not a number reads as its default", () => {
    expect(columnWidthsFrom(null)).toEqual(DEFAULT_COLUMN_WIDTHS);
    expect(columnWidthsFrom("wide")).toEqual(DEFAULT_COLUMN_WIDTHS);
    expect(columnWidthsFrom({ modified: 10, by: "200", size: 99.6 })).toEqual({ ...DEFAULT_COLUMN_WIDTHS, size: 100 });
    expect(columnWidthsFrom({ modified: Infinity, by: 321, size: 201 })).toEqual(DEFAULT_COLUMN_WIDTHS);
    localStorage.setItem("chikuwa.prefs.driveColumns", "{not json");
    expect(readDriveColumnWidths()).toEqual(DEFAULT_COLUMN_WIDTHS);
    expect(changedWidths(DEFAULT_COLUMN_WIDTHS)).toBeNull();
    expect(changedWidths({ ...DEFAULT_COLUMN_WIDTHS, by: 150 })).toEqual({ by: 150 });
  });

  it("storage that throws (a private window, blocked site data) reads the defaults and does not break a write", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("blocked"); });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("blocked"); });
    expect(readDriveColumnWidths()).toEqual(DEFAULT_COLUMN_WIDTHS);
    expect(() => writeDriveColumnWidth("by", 200)).not.toThrow();
  });
});
