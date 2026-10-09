// @vitest-environment jsdom
/**
 * The database table's selection is cheap (WIKI.md §29.1): on a page of 200 rows, an arrow key or a click redraws the
 * cells whose selection changed, not every cell (the cells are memoised, their callbacks keep one identity). Counted
 * through CellDisplay, which every cell renders once per draw.
 */
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { DatabaseOut, DbProperty, DbRow, DbRowQueryOut } from "../src/api/types";
import type { AppController } from "../src/state/app";
import { Store } from "../src/sync/store";
import { COMPACT_QUERY } from "../src/ui/compact";
import { DatabaseView } from "../src/ui/DatabaseView";
import { CellDisplay } from "../src/ui/DbCells";

vi.mock("../src/ui/DbCells", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/ui/DbCells")>();
  return { ...real, CellDisplay: vi.fn(real.CellDisplay) };
});

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("matchMedia", (query: string) => ({ matches: query === COMPACT_QUERY ? false : false, addEventListener: () => {}, removeEventListener: () => {} }));
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  localStorage.clear();
});

const settle = () => act(async () => { await vi.advanceTimersByTimeAsync(40); });

const ROWS_ON_PAGE = 200;
const p = (id: string, name: string, type: DbProperty["type"], extra: Partial<DbProperty> = {}): DbProperty => ({ id, name, type, options: [], number_format: null, relation: null, ...extra });
const PROPS: DbProperty[] = [
  p("title", "", "title"),
  p("stage", "段階", "select", { options: [{ id: "o1", name: "読む", color: "blue" }, { id: "o2", name: "読んだ", color: "green" }] }),
  p("done", "読了", "checkbox"),
  p("due", "締め切り", "date"),
  p("note", "メモ", "text"),
];
const COLUMNS = PROPS.length;
const VIEW: DatabaseOut["views"] = [{ id: "v1", name: "", type: "table", columns: [], sort: [], filter: null, date_prop_id: null, cover: "body", card_size: "medium" }];
const DATABASE: DatabaseOut = { page_id: "db", schema_version: 1, properties: PROPS, views: VIEW, my_level: "full", row_count: ROWS_ON_PAGE, limits: { rows: 5000, properties: 50, options: 200, views: 20 } };
const ROWS: DbRow[] = Array.from({ length: ROWS_ON_PAGE }, (_, i) => ({
  id: `r${i}`, database_id: "db", title: `Row ${i}`, icon: null, position: String(i).padStart(4, "0"), version: 1, head_rev_id: "r",
  props: { stage: i % 2 ? "o1" : "o2", done: i % 3 === 0, due: { start: "2026-10-05", end: null, time: false }, note: `note ${i}` } as DbRow["props"],
  relations: {}, hidden_relations: [], created_at: "2026-10-01T00:00:00Z", created_by: "u1", updated_at: "2026-10-01T00:00:00Z", updated_by: "u1",
}));

function controller(): AppController {
  const store = new Store();
  store.upsertUser({ id: "u1", username: "kano", display_name: "加納", role: "member", created_at: "", updated_at: "", deactivated_at: null });
  const api = {
    wikiDatabase: vi.fn(async () => DATABASE),
    queryWikiRows: vi.fn(async (): Promise<DbRowQueryOut> => ({ rows: ROWS, refs: [], total: ROWS_ON_PAGE, next_cursor: null, schema_version: 1 })),
  };
  return { store, api, engine: null, isGuest: false, setError: () => {}, setNotice: () => {} } as unknown as AppController;
}

const box = (rowId: string, propId: string) => document.querySelector(`[data-row='${rowId}'] [data-cell='${propId}'] [data-cell-focus]`) as HTMLElement;
const td = (rowId: string, propId: string) => document.querySelector(`[data-row='${rowId}'] [data-cell='${propId}']`) as HTMLElement;
const draws = () => vi.mocked(CellDisplay).mock.calls.length;

describe("a page of 200 rows", () => {
  it("an arrow key or a click redraws the two cells whose selection changed, not the page", async () => {
    render(<DatabaseView controller={controller()} databaseId="db" compact={false} renderPeek={() => null} onOpenRowPage={() => {}} />);
    await settle();
    expect(document.querySelectorAll("[data-db-table] tbody tr")).toHaveLength(ROWS_ON_PAGE);
    expect(draws()).toBeGreaterThanOrEqual(ROWS_ON_PAGE * COLUMNS); // every cell, at least once
    // The focus reaching a cell (a Tab) selects it: that cell alone.
    vi.mocked(CellDisplay).mockClear();
    act(() => box("r10", "title").focus());
    expect(td("r10", "title").getAttribute("aria-selected")).toBe("true");
    expect(draws()).toBe(1);
    // An arrow: the cell left and the cell reached.
    vi.mocked(CellDisplay).mockClear();
    fireEvent.keyDown(box("r10", "title"), { key: "ArrowDown" });
    expect(td("r11", "title").getAttribute("aria-selected")).toBe("true");
    expect(td("r10", "title").getAttribute("aria-selected")).toBe("false");
    expect(document.activeElement).toBe(box("r11", "title"));
    expect(draws()).toBe(2);
    vi.mocked(CellDisplay).mockClear();
    fireEvent.keyDown(box("r11", "title"), { key: "ArrowRight" });
    expect(td("r11", "stage").getAttribute("aria-selected")).toBe("true");
    expect(draws()).toBe(2);
    // Three more to the last column, then one at the edge, where the selection stays and nothing is redrawn.
    vi.mocked(CellDisplay).mockClear();
    for (let i = 0; i < 4; i += 1) fireEvent.keyDown(document.activeElement as HTMLElement, { key: "ArrowRight" });
    expect(td("r11", "note").getAttribute("aria-selected")).toBe("true");
    expect(document.activeElement).toBe(box("r11", "note"));
    expect(draws()).toBe(6);
    // A press elsewhere (its pointerdown, the focus a mousedown gives the box): the two cells again, the rest untouched.
    vi.mocked(CellDisplay).mockClear();
    fireEvent.pointerDown(box("r150", "done"));
    act(() => box("r150", "done").focus());
    expect(td("r150", "done").getAttribute("aria-selected")).toBe("true");
    expect(td("r11", "note").getAttribute("aria-selected")).toBe("false");
    expect(draws()).toBe(2);
  });
});
