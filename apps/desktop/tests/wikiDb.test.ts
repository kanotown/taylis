/**
 * M123 (WIKI.md §5): wiki databases without React — cells as text, the filters a type takes, the table's columns
 * from a view, and the calendar's month grid, multi-day bars in lanes, the agenda and moving a date.
 */
import { describe, expect, it } from "vitest";

import type { DbProperty, DbRow, DbView } from "../src/api/types";
import {
  agenda,
  cellText,
  clampWidth,
  databaseRights,
  columnsOf,
  formatNumber,
  isRestrictedValue,
  layoutWeek,
  monthBounds,
  monthGrid,
  moveColumn,
  newCondition,
  opsFor,
  readyConditions,
  shiftDate,
  spanOf,
  toViewColumns,
  viewBody,
  viewDiffers,
} from "../src/ui/wikiDb";

const prop = (id: string, type: DbProperty["type"], extra: Partial<DbProperty> = {}): DbProperty => ({ id, name: id, type, options: [], number_format: null, relation: null, ...extra });
const row = (id: string, props: Record<string, unknown> = {}, extra: Partial<DbRow> = {}): DbRow => ({
  id,
  database_id: "db",
  title: id,
  icon: null,
  position: "a",
  version: 1,
  head_rev_id: "r",
  props: props as DbRow["props"],
  relations: {},
  hidden_relations: [],
  created_at: "2026-10-07T00:00:00Z",
  created_by: "u1",
  updated_at: "2026-10-07T00:00:00Z",
  updated_by: "u1",
  ...extra,
});
const ctx = { locale: "ja-JP", names: (id: string) => ({ u1: "加納" })[id] ?? "?", refs: new Map([["r1", { id: "r1", database_id: "d2", title: "Vaswani", icon: null }]]), hidden: "アクセスできないページ", untitled: "無題" };

describe("cells as text", () => {
  it("each type", () => {
    const stage = prop("s", "select", { options: [{ id: "o1", name: "読む", color: "blue" }] });
    const tags = prop("t", "multi_select", { options: [{ id: "a", name: "ML", color: "gray" }, { id: "b", name: "HCI", color: "red" }] });
    const r = row("x", { s: "o1", t: ["b", "a"], n: 1200, d: { start: "2026-10-07", end: "2026-10-09", time: false }, p: ["u1"], c: true });
    expect(cellText(stage, r, ctx)).toBe("読む");
    expect(cellText(tags, r, ctx)).toBe("HCI, ML");
    expect(cellText(prop("n", "number", { number_format: "yen" }), r, ctx)).toBe("￥1,200");
    expect(cellText(prop("d", "date"), r, ctx)).toBe("2026/10/07 → 2026/10/09");
    expect(cellText(prop("p", "person"), r, ctx)).toBe("加納");
    expect(cellText(prop("c", "checkbox"), r, ctx)).toBe("✓");
    expect(cellText(prop("created_by", "created_by"), r, ctx)).toBe("加納");
  });

  it("a relation: readable titles, then one placeholder for the rest (no count, no titles)", () => {
    const rel = prop("rel", "relation");
    const r = row("x", {}, { relations: { rel: ["r1"] }, hidden_relations: ["rel"] });
    expect(cellText(rel, r, ctx)).toBe("Vaswani, アクセスできないページ");
    expect(cellText(rel, row("y", {}, { hidden_relations: ["rel"] }), ctx)).toBe("アクセスできないページ");
  });

  it("number formats", () => {
    expect(formatNumber(0.25, "percent", "ja-JP")).toBe("25%");
    expect(formatNumber(2026, "integer", "ja-JP")).toBe("2026");
    expect(formatNumber(12.5, "number", "en")).toBe("12.5");
  });
});

describe("filters", () => {
  it("the operators of each type are the server's", () => {
    expect(opsFor("title")).toContain("starts_with");
    expect(opsFor("number")).toEqual(["equals", "not_equals", "gt", "gte", "lt", "lte", "is_empty", "is_not_empty"]);
    expect(opsFor("checkbox")).toEqual(["equals"]);
    expect(opsFor("created_time")).toContain("between");
    expect(opsFor("updated_by")).toEqual(opsFor("person"));
    expect(opsFor("relation")).toEqual(["contains", "not_contains", "is_empty", "is_not_empty"]);
  });

  it("a new condition has a value of its kind; unfinished ones are not sent", () => {
    expect(newCondition(prop("c", "checkbox"))).toEqual({ prop_id: "c", op: "equals", value: true });
    expect(newCondition(prop("p", "person")).value).toBe("me");
    expect(readyConditions([{ op: "contains", value: "" }, { op: "is_empty" }, { op: "gt", value: 0 }])).toEqual([{ op: "is_empty" }, { op: "gt", value: 0 }]);
  });

  it("a saved condition on a row I cannot read is a marker, kept and sent back as it is", () => {
    expect(isRestrictedValue("restricted:1")).toBe(true);
    expect(isRestrictedValue("0190a6f0-0000-7000-8000-000000000000")).toBe(false);
    expect(isRestrictedValue(1)).toBe(false);
    const hidden = { op: "contains" as const, value: "restricted:0" };
    expect(readyConditions([hidden])).toEqual([hidden]);
  });
});

describe("the table's columns", () => {
  const props = [prop("title", "title"), prop("a", "text"), prop("b", "number"), prop("c", "date")];

  it("the view's order and widths first, the rest after; the title never hides", () => {
    const columns = columnsOf(props, [{ prop_id: "b", width: 90 }, { prop_id: "title", hidden: true }, { prop_id: "gone" }]);
    expect(columns.map((c) => [c.prop.id, c.width, c.hidden])).toEqual([["b", 90, false], ["title", 260, false], ["a", 180, false], ["c", 180, false]]);
    expect(toViewColumns(columns)[0]).toEqual({ prop_id: "b", width: 90, hidden: false });
  });

  it("moving and resizing", () => {
    const columns = columnsOf(props, []);
    expect(moveColumn(columns, "c", 0).map((c) => c.prop.id)).toEqual(["c", "title", "a", "b"]);
    expect(clampWidth(10)).toBe(60);
    expect(clampWidth(5000)).toBe(1000);
  });

  it("a view differs once its sort, filter or columns change here", () => {
    const view: DbView = { id: "v", name: "", type: "table", columns: [], sort: [], filter: null, date_prop_id: null };
    expect(viewDiffers(view, viewBody(view))).toBe(false);
    expect(viewDiffers(view, { ...viewBody(view), sort: [{ prop_id: "a", direction: "asc" }] })).toBe(true);
    expect(viewDiffers(view, { ...viewBody(view), filter: { combinator: "and", conditions: [] } })).toBe(false);
  });
});

describe("the calendar", () => {
  it("six weeks from Monday covering the month", () => {
    const grid = monthGrid(2026, 9, 1);
    expect(grid).toHaveLength(6);
    expect(grid[0]![0]).toBe("2026-09-28");
    expect(grid[0]![3]).toBe("2026-10-01");
    expect(grid[5]![6]).toBe("2026-11-08");
    expect(monthGrid(2026, 9, 0)[0]![0]).toBe("2026-09-27");
    expect(monthBounds(2026, 1)).toEqual(["2026-02-01", "2026-02-28"]);
  });

  it("a date range spans its days; a week holds bars in lanes that do not overlap", () => {
    const week = monthGrid(2026, 9, 1)[1]!; // 10/05 (Mon) … 10/11
    const bars = layoutWeek(week, [
      { rowId: "one-day", first: "2026-10-07", last: "2026-10-07" },
      { rowId: "long", first: "2026-10-05", last: "2026-10-09" },
      { rowId: "from-before", first: "2026-09-30", last: "2026-10-06" },
      { rowId: "goes-on", first: "2026-10-10", last: "2026-10-14" },
      { rowId: "elsewhere", first: "2026-10-20", last: "2026-10-21" },
    ]);
    const byId = Object.fromEntries(bars.map((b) => [b.rowId, b]));
    expect(byId.elsewhere).toBeUndefined();
    expect(byId.long).toMatchObject({ startCol: 0, endCol: 4, lane: 0, fromBefore: false, goesOn: false });
    expect(byId["from-before"]).toMatchObject({ startCol: 0, endCol: 1, lane: 1, fromBefore: true });
    expect(byId["goes-on"]).toMatchObject({ startCol: 5, endCol: 6, lane: 0, goesOn: true });
    expect(byId["one-day"]).toMatchObject({ startCol: 2, endCol: 2, lane: 1 });
  });

  it("a row's days on its date property; a time on this device's day; computed dates too", () => {
    const due = prop("d", "date");
    expect(spanOf(due, row("a", { d: { start: "2026-10-07", end: "2026-10-09", time: false } }))).toEqual(["2026-10-07", "2026-10-09"]);
    expect(spanOf(due, row("b"))).toBeNull();
    const made = spanOf(prop("m", "created_time"), row("c"));
    expect(made?.[0]).toMatch(/^2026-10-0[67]$/);
  });

  it("the agenda lists a row on every day it covers, within the month", () => {
    const days = agenda([{ rowId: "a", first: "2026-09-30", last: "2026-10-02" }, { rowId: "b", first: "2026-10-02", last: "2026-10-02" }], "2026-10-01", "2026-10-31");
    expect(days).toEqual([{ day: "2026-10-01", rowIds: ["a"] }, { day: "2026-10-02", rowIds: ["a", "b"] }]);
  });

  it("dragging moves the start and the end together, keeping times", () => {
    expect(shiftDate({ start: "2026-10-30", end: "2026-11-02", time: false }, 3)).toEqual({ start: "2026-11-02", end: "2026-11-05", time: false });
    const moved = shiftDate({ start: "2026-10-07T09:30:00+09:00", end: null, time: true }, -1);
    expect(new Date(moved.start).getTime() - new Date("2026-10-07T09:30:00+09:00").getTime()).toBe(-86_400_000);
    expect(moved.end).toBeNull();
  });
});

describe("who may do what with a database (M144)", () => {
  it("edit shapes, full also deletes and retypes; guests only edit values", () => {
    expect(databaseRights("view", false)).toEqual({ canEdit: false, canShape: false, canDestroy: false });
    expect(databaseRights("edit", false)).toEqual({ canEdit: true, canShape: true, canDestroy: false });
    expect(databaseRights("full", false)).toEqual({ canEdit: true, canShape: true, canDestroy: true });
    expect(databaseRights("full", true)).toEqual({ canEdit: true, canShape: false, canDestroy: false });
    expect(databaseRights(undefined, false)).toEqual({ canEdit: false, canShape: false, canDestroy: false });
  });
});
