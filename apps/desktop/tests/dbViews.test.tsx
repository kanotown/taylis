// @vitest-environment jsdom
/**
 * M147 (WIKI.md §22.4, §25): a database's board (a column per group with its count, 「なし」, a card dragged to another
 * column or place in one write, the same from the keyboard with the card's ⋯, hidden columns), the list and the gallery
 * (the row's first image), the table's groups (collapsible), the layout settings, and the pure rules behind them.
 */
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { DatabaseOut, DbGroupOut, DbProperty, DbRow, DbRowQuery, DbRowQueryOut, DbView } from "../src/api/types";
import type { AppController } from "../src/state/app";
import { Store } from "../src/sync/store";
import { COMPACT_QUERY } from "../src/ui/compact";
import { DatabaseView, newView } from "../src/ui/DatabaseView";
import { boardValue, firstBoardProp, flattenSections, groupableProps, groupValue, moveInSections, placeIn, sectionsOf, viewBody, viewDiffers } from "../src/ui/wikiDb";

beforeEach(() => {
  vi.stubGlobal("matchMedia", (query: string) => ({ matches: query === COMPACT_QUERY ? false : false, addEventListener: () => {}, removeEventListener: () => {} }));
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  localStorage.clear();
});

const settle = (ms = 40) => act(async () => { await new Promise((resolve) => setTimeout(resolve, ms)); });

const p = (id: string, name: string, type: DbProperty["type"], extra: Partial<DbProperty> = {}): DbProperty => ({ id, name, type, options: [], number_format: null, relation: null, ...extra });
const PROPS: DbProperty[] = [
  p("title", "", "title"),
  p("stage", "段階", "select", { options: [{ id: "o1", name: "未着手", color: "gray" }, { id: "o2", name: "進行中", color: "blue" }, { id: "o3", name: "完了", color: "green" }] }),
  p("who", "担当", "person"),
  p("done", "済", "checkbox"),
  p("tags", "タグ", "multi_select", { options: [{ id: "t1", name: "A", color: "red" }] }),
  p("due", "締め切り", "date"),
  p("note", "メモ", "text"),
];

const row = (id: string, title: string, props: Record<string, unknown>, extra: Partial<DbRow> = {}): DbRow => ({
  id, database_id: "db", title, icon: null, position: id, version: 1, head_rev_id: "r", props: props as DbRow["props"], relations: {}, hidden_relations: [],
  created_at: "2026-10-01T00:00:00Z", created_by: "u1", updated_at: "2026-10-01T00:00:00Z", updated_by: "u1", ...extra,
});

const view = (extra: Partial<DbView>): DbView => ({ id: "v", name: "", type: "table", columns: [], sort: [], filter: null, date_prop_id: null, group_by: null, cover: "body", card_size: "medium", ...extra });
const BOARD = view({ id: "b", type: "board", group_by: { prop_id: "stage", date_unit: null, hidden: [], hide_empty: false }, columns: [{ prop_id: "title", hidden: false }, { prop_id: "note", hidden: false }, ...["stage", "who", "done", "tags", "due"].map((id) => ({ prop_id: id, hidden: true }))] });

const R1 = row("r1", "設計", { stage: "o2", note: "下書き" });
const R2 = row("r2", "実験", { stage: "o1" });
const R3 = row("r3", "調査", { stage: "o1" });
const R4 = row("r4", "雑務", {});

function database(views: DbView[], level: DatabaseOut["my_level"] = "edit"): DatabaseOut {
  return { page_id: "db", schema_version: 3, properties: PROPS, views, my_level: level, row_count: 4, limits: { rows: 5000, properties: 50, options: 200, views: 20 } };
}

function boardAnswer(): DbRowQueryOut {
  const groups: DbGroupOut[] = [
    { key: "o1", count: 2, hidden: false },
    { key: "o2", count: 1, hidden: false },
    { key: "o3", count: 0, hidden: false },
    { key: "", count: 1, hidden: false },
  ];
  return { rows: [R2, R3, R1, R4], row_groups: ["o1", "o1", "o2", ""], groups, refs: [], total: 4, next_cursor: null, schema_version: 3 };
}

function fakeController(api: Record<string, unknown>, isGuest = false) {
  const store = new Store();
  store.upsertUser({ id: "u1", username: "kano", display_name: "加納", role: "member", created_at: "", updated_at: "", deactivated_at: null });
  const errors: unknown[] = [];
  const controller = { store, api, engine: null, isGuest, setError: (e: unknown) => errors.push(e), setNotice: () => {} } as unknown as AppController;
  return { controller, errors };
}

function setup(views: DbView[], answer: (q: DbRowQuery) => DbRowQueryOut, extra: Record<string, unknown> = {}, level: DatabaseOut["my_level"] = "edit") {
  const queries: DbRowQuery[] = [];
  const fake = {
    wikiDatabase: vi.fn(async () => database(views, level)),
    queryWikiRows: vi.fn(async (_id: string, q: DbRowQuery) => { queries.push(q); return answer(q); }),
    moveWikiRow: vi.fn(async (rowId: string) => ({ row: [R1, R2, R3, R4].find((r) => r.id === rowId)!, refs: [] })),
    createWikiRow: vi.fn(async () => ({ row: row("r9", "", {}), refs: [] })),
    setWikiCells: vi.fn(async (rowId: string) => ({ row: [R1, R2, R3, R4].find((r) => r.id === rowId)!, refs: [] })),
    putWikiView: vi.fn(async () => database(views, level)),
    fetchBlob: vi.fn(async () => new Blob(["x"], { type: "image/png" })),
    ...extra,
  };
  const { controller, errors } = fakeController(fake);
  render(<DatabaseView controller={controller} databaseId="db" compact={false} renderPeek={() => null} onOpenRowPage={() => {}} />);
  return { fake, queries, errors };
}

const column = (key: string) => document.querySelector(`[data-board-column='${key}']`) as HTMLElement;
const cardTitles = (key: string) => [...column(key).querySelectorAll("[data-card]")].map((c) => c.getAttribute("data-card"));

describe("the board", () => {
  it("asks for groups and shows a column per group, 「なし」 last, with counts and the card's properties", async () => {
    const { queries } = setup([BOARD], boardAnswer);
    await settle();
    expect(queries[0]).toMatchObject({ view_id: "b", grouped: true, group_by: { prop_id: "stage" }, limit: 1000, covers: false });
    const keys = [...document.querySelectorAll("[data-board-column]")].map((c) => c.getAttribute("data-board-column"));
    expect(keys).toEqual(["o1", "o2", "o3", ""]);
    expect(within(column("o1")).getByText("未着手")).toBeTruthy();
    expect(within(column("")).getByText("なし")).toBeTruthy();
    expect(within(column("o1")).getByText("2")).toBeTruthy();
    expect(cardTitles("o1")).toEqual(["r2", "r3"]);
    expect(cardTitles("o3")).toEqual([]);
    // The shown property (メモ), not the hidden one (担当).
    expect(within(column("o2")).getByText("下書き")).toBeTruthy();
    expect(column("o2").querySelector("[data-card-prop='who']")).toBeNull();
    // The view tab and the new-view menu know the new types.
    expect(screen.getByRole("tab", { name: /ボード/ })).toBeTruthy();
  });

  it("a card dragged onto another column takes its value and its place, in one write", async () => {
    const { fake } = setup([BOARD], boardAnswer);
    await settle();
    const card = column("o1").querySelector("[data-card='r2']") as HTMLElement;
    fireEvent.dragStart(card, { dataTransfer: { setData: () => {}, effectAllowed: "" } });
    const target = column("o2").querySelector("[data-card='r1']") as HTMLElement;
    vi.spyOn(target, "getBoundingClientRect").mockReturnValue({ top: 0, height: 40, bottom: 40, left: 0, right: 100, width: 100, x: 0, y: 0, toJSON: () => ({}) });
    fireEvent.dragOver(target, { clientY: 5 });
    fireEvent.drop(column("o2"));
    await settle();
    expect(fake.moveWikiRow).toHaveBeenCalledWith("r2", { set: { stage: "o2" }, before_id: "r1", client_op_id: expect.any(String) });
    // Shown at once (and read again from the server).
    expect(fake.queryWikiRows.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it("a card dragged within its column only takes its place; a sorted board does not reorder", async () => {
    const { fake } = setup([BOARD], boardAnswer);
    await settle();
    const card = column("o1").querySelector("[data-card='r2']") as HTMLElement;
    fireEvent.dragStart(card, { dataTransfer: { setData: () => {}, effectAllowed: "" } });
    fireEvent.dragOver(column("o1").querySelector("[data-column-end]") as HTMLElement);
    fireEvent.dragOver(column("o1"));
    fireEvent.drop(column("o1"));
    await settle();
    expect(fake.moveWikiRow).toHaveBeenCalledWith("r2", { set: {}, after_id: "r3", client_op_id: expect.any(String) });
    cleanup();
    const sorted = { ...BOARD, sort: [{ prop_id: "title", direction: "asc" as const }] };
    const again = setup([sorted], boardAnswer);
    await settle();
    expect(screen.getByText("並べ替えがあるため、列の中の順番は並べ替えのとおりです")).toBeTruthy();
    const drag = column("o1").querySelector("[data-card='r2']") as HTMLElement;
    fireEvent.dragStart(drag, { dataTransfer: { setData: () => {}, effectAllowed: "" } });
    fireEvent.dragOver(column("o1"));
    fireEvent.drop(column("o1"));
    await settle();
    expect(again.fake.moveWikiRow).not.toHaveBeenCalled();
    // To another column it still takes the value, without a place.
    fireEvent.dragStart(drag, { dataTransfer: { setData: () => {}, effectAllowed: "" } });
    fireEvent.dragOver(column("o3"));
    fireEvent.drop(column("o3"));
    await settle();
    expect(again.fake.moveWikiRow).toHaveBeenCalledWith("r2", { set: { stage: "o3" }, client_op_id: expect.any(String) });
  });

  it("the card's ⋯ moves it from the keyboard: to a column, up and down", async () => {
    const { fake } = setup([BOARD], boardAnswer);
    await settle();
    fireEvent.keyDown(screen.getByRole("button", { name: "「調査」の操作" }), { key: "Enter" });
    fireEvent.click(await screen.findByRole("menuitem", { name: "「完了」へ移動" }));
    await settle();
    expect(fake.moveWikiRow).toHaveBeenLastCalledWith("r3", { set: { stage: "o3" }, client_op_id: expect.any(String) });
    fireEvent.keyDown(screen.getByRole("button", { name: "「実験」の操作" }), { key: "Enter" });
    expect(screen.queryByRole("menuitem", { name: /上へ/ })).toBeNull(); // the first card
    fireEvent.click(await screen.findByRole("menuitem", { name: /下へ/ }));
    await settle();
    expect(fake.moveWikiRow).toHaveBeenLastCalledWith("r2", { set: {}, after_id: "r3", client_op_id: expect.any(String) });
  });

  it("「＋」 under a column adds a row with its value; hiding a column keeps it in 「隠したグループ」", async () => {
    const hidden = (q: DbRowQuery): DbRowQueryOut => {
      const out = boardAnswer();
      if (!q.group_by?.hidden?.includes("o3")) return out;
      return { ...out, groups: out.groups!.map((g) => (g.key === "o3" ? { ...g, hidden: true } : g)) };
    };
    const { fake, queries } = setup([BOARD], hidden);
    await settle();
    fireEvent.click(screen.getByRole("button", { name: "「進行中」に行を追加" }));
    await settle();
    expect(fake.createWikiRow).toHaveBeenCalledWith("db", expect.objectContaining({ props: { stage: "o2" } }));
    fireEvent.keyDown(screen.getByRole("button", { name: "グループ「完了」の操作" }), { key: "Enter" });
    fireEvent.click(await screen.findByRole("menuitem", { name: /グループを隠す/ }));
    await settle(400);
    expect(queries.at(-1)?.group_by?.hidden).toEqual(["o3"]);
    expect(column("o3")).toBeNull();
    const shelf = document.querySelector("[data-board-hidden]") as HTMLElement;
    expect(within(shelf).getByText("完了")).toBeTruthy();
    expect(screen.getByRole("button", { name: /ビューを保存/ })).toBeTruthy();
    fireEvent.click(within(shelf).getByRole("button", { name: "「完了」を表示" }));
    await settle(400);
    expect(queries.at(-1)?.group_by?.hidden).toEqual([]);
  });

  it("view access: no drag, no ⋯, no 「＋」", async () => {
    setup([BOARD], boardAnswer, {}, "view");
    await settle();
    expect((column("o1").querySelector("[data-card='r2']") as HTMLElement).getAttribute("draggable")).toBe("false");
    expect(screen.queryByRole("button", { name: "「調査」の操作" })).toBeNull();
    expect(screen.queryByRole("button", { name: /に行を追加/ })).toBeNull();
  });

  it("a board without its property asks for one", async () => {
    setup([{ ...BOARD, group_by: null }], () => ({ rows: [R1], refs: [], total: 1, next_cursor: null, schema_version: 3 }));
    await settle();
    expect(document.querySelector("[data-board-empty]")?.textContent).toContain("レイアウト");
  });
});

describe("the list, the gallery and the table's groups", () => {
  it("a list line per row with its shown properties", async () => {
    setup([view({ id: "l", type: "list", columns: [{ prop_id: "note", hidden: false }] })], () => ({ rows: [R1, R2], refs: [], total: 2, next_cursor: null, schema_version: 3 }));
    await settle();
    const list = document.querySelector("[data-db-list]") as HTMLElement;
    expect([...list.querySelectorAll("[data-row]")].map((r) => r.getAttribute("data-row"))).toEqual(["r1", "r2"]);
    expect(within(list).getByText("下書き")).toBeTruthy();
  });

  it("a gallery asks for the pictures and shows each card's first image", async () => {
    const pictured = row("r1", "設計", {}, { cover: { attachment_id: "a1", thumbnail: true, width: 40, height: 30 } });
    const { queries, fake } = setup([view({ id: "g", type: "gallery", card_size: "large" })], () => ({ rows: [pictured, R2], refs: [], total: 2, next_cursor: null, schema_version: 3 }));
    vi.stubGlobal("URL", Object.assign(URL, { createObjectURL: () => "blob:x", revokeObjectURL: () => {} }));
    await settle();
    expect(queries[0]).toMatchObject({ covers: true, grouped: false });
    expect(document.querySelector("[data-db-gallery]")?.getAttribute("data-card-size")).toBe("large");
    expect(fake.fetchBlob).toHaveBeenCalledWith("/api/v1/attachments/a1/thumbnail");
    expect(document.querySelector("[data-cover='a1'] img")).toBeTruthy();
    expect(document.querySelector("[data-row='r2'] [data-cover] img")).toBeNull();
  });

  it("a gallery without pictures does not ask for them", async () => {
    const { queries } = setup([view({ id: "g", type: "gallery", cover: "none" })], () => ({ rows: [R1], refs: [], total: 1, next_cursor: null, schema_version: 3 }));
    await settle();
    expect(queries[0]).toMatchObject({ covers: false });
    expect(document.querySelector("[data-cover]")).toBeNull();
  });

  it("a grouped table has a header per group that closes; a row in two groups is a line in each", async () => {
    const tagged = row("r1", "設計", { tags: ["t1"] });
    const answer = (): DbRowQueryOut => ({
      rows: [tagged, R2, tagged], row_groups: ["t1", "", ""], refs: [], total: 3, next_cursor: null, schema_version: 3,
      groups: [{ key: "t1", count: 1, hidden: false }, { key: "", count: 2, hidden: false }],
    });
    const { queries } = setup([view({ group_by: { prop_id: "tags", date_unit: null, hidden: [], hide_empty: false } })], answer);
    await settle();
    expect(queries[0]).toMatchObject({ grouped: true, limit: 1000 });
    const table = document.querySelector("[data-db-table]") as HTMLElement;
    expect([...table.querySelectorAll("[data-group-row]")].map((r) => r.getAttribute("data-group-row"))).toEqual(["t1", ""]);
    expect(table.querySelectorAll("[data-row='r1']").length).toBe(2);
    fireEvent.click(within(table).getByRole("button", { name: "「なし」を閉じる" }));
    expect(table.querySelectorAll("[data-row]").length).toBe(1);
    expect(within(table).getByRole("button", { name: "「なし」を開く" }).getAttribute("aria-expanded")).toBe("false");
  });

  it("the layout panel groups a table by a date's week and the change is a draft to save", async () => {
    const { queries, fake } = setup([view({})], () => ({ rows: [R1], refs: [], total: 1, next_cursor: null, schema_version: 3, groups: [], row_groups: [] }));
    await settle();
    fireEvent.click(screen.getByRole("button", { name: /レイアウト/ }));
    const panel = await screen.findByText("グループ");
    const select = panel.parentElement!.querySelector("select") as HTMLSelectElement;
    expect([...select.options].map((o) => o.textContent)).toEqual(["グループにしない", "段階", "担当", "済", "タグ", "締め切り"]);
    fireEvent.change(select, { target: { value: "due" } });
    fireEvent.change(await screen.findByLabelText("日付のまとめ方"), { target: { value: "week" } });
    await settle(400);
    expect(queries.at(-1)).toMatchObject({ grouped: true, group_by: { prop_id: "due", date_unit: "week", hidden: [] } });
    fireEvent.click(screen.getByRole("button", { name: /ビューを保存/ }));
    await settle();
    expect(fake.putWikiView).toHaveBeenCalledWith("db", "v", expect.objectContaining({ group_by: expect.objectContaining({ prop_id: "due", date_unit: "week" }) }));
  });
});

describe("the rules", () => {
  const db = database([]);
  const stage = PROPS[1]!, who = PROPS[2]!, done = PROPS[3]!;

  it("what may group what", () => {
    expect(groupableProps(PROPS, "board").map((x) => x.id)).toEqual(["stage", "who", "done"]);
    expect(groupableProps(PROPS, "table").map((x) => x.id)).toEqual(["stage", "who", "done", "tags", "due"]);
    expect(groupableProps(PROPS, "calendar")).toEqual([]);
    expect(firstBoardProp(db)?.id).toBe("stage");
    expect(firstBoardProp({ properties: [PROPS[0]!, done, who] })?.id).toBe("who");
  });

  it("a card's new value from its old and new column", () => {
    const r = row("x", "x", { who: ["u1", "u2"] });
    expect(boardValue(stage, r, "o1", "o2")).toBe("o2");
    expect(boardValue(stage, r, "o1", "")).toBeNull();
    expect(boardValue(done, r, "false", "true")).toBe(true);
    expect(boardValue(done, r, "true", "false")).toBe(false);
    expect(boardValue(who, r, "u1", "u3")).toEqual(["u2", "u3"]);
    expect(boardValue(who, r, "u1", "u2")).toEqual(["u2"]);
    expect(boardValue(who, r, "u1", "")).toBeNull();
    expect(groupValue(stage, "o1", null)).toBe("o1");
    expect(groupValue(stage, "", null)).toBeUndefined();
    expect(groupValue(done, "true", null)).toBe(true);
    expect(groupValue(who, "u1", null)).toEqual(["u1"]);
    expect(groupValue(PROPS[5]!, "2026-10-05", "day")).toEqual({ start: "2026-10-05", end: null, time: false });
    expect(groupValue(PROPS[5]!, "2026-10-05", "week")).toBeUndefined();
  });

  it("where a card lands, and the sections at once", () => {
    const sections = sectionsOf(boardAnswer().groups!, [R2, R3, R1, R4], ["o1", "o1", "o2", ""]);
    expect(sections.map((s) => [s.key, s.rows.map((r) => r.id)])).toEqual([["o1", ["r2", "r3"]], ["o2", ["r1"]], ["o3", []], ["", ["r4"]]]);
    expect(placeIn(sections[0]!.rows, "r2", 0)).toEqual({ before_id: "r3" });
    expect(placeIn(sections[0]!.rows, "r2", 1)).toEqual({ after_id: "r3" });
    expect(placeIn(sections[2]!.rows, "r2", 0)).toEqual({});
    expect(placeIn(sections[1]!.rows, "r2", 99)).toEqual({ after_id: "r1" });
    const moved = moveInSections(sections, { ...R2, props: { stage: "o2" } }, "o1", "o2", 0);
    expect(moved.map((s) => [s.key, s.count, s.rows.map((r) => r.id)])).toEqual([["o1", 1, ["r3"]], ["o2", 2, ["r2", "r1"]], ["o3", 0, []], ["", 1, ["r4"]]]);
    expect(flattenSections(moved)).toEqual({ rows: [R3, { ...R2, props: { stage: "o2" } }, R1, R4], rowGroups: ["o1", "o2", "o2", ""] });
    const within = moveInSections(sections, R2, "o1", "o1", 1);
    expect(within[0]!.rows.map((r) => r.id)).toEqual(["r3", "r2"]);
    expect(within[0]!.count).toBe(2);
  });

  it("a new view's settings and what counts as a change", () => {
    const board = newView(db, "board");
    expect(board.group_by).toEqual({ prop_id: "stage", date_unit: null, hidden: [], hide_empty: false });
    // The cards show the first three properties but the board's own.
    expect(board.columns!.filter((c) => !c.hidden).map((c) => c.prop_id)).toEqual(["title", "who", "done", "tags"]);
    expect(newView(db, "gallery").group_by).toBeNull();
    const saved = { ...BOARD };
    expect(viewDiffers(saved, viewBody(saved))).toBe(false);
    expect(viewDiffers(saved, { ...viewBody(saved), group_by: { ...saved.group_by!, hidden: ["o1"] } })).toBe(true);
    expect(viewDiffers(saved, { ...viewBody(saved), card_size: "small" })).toBe(true);
  });
});
