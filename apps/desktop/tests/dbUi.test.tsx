// @vitest-environment jsdom
/**
 * M123 database screens (WIKI.md §5): the table (cells per type, a checkbox written in place, a new row, a header's
 * sort reaching the server's query), the relation picker (readable rows and candidates, one 「アクセスできないページ」 for
 * the rest, never their titles), the calendar's multi-day bars, and a row's properties above its body.
 */
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { DatabaseOut, DbProperty, DbRow, DbRowDetail, DbRowQuery, DbRowQueryOut } from "../src/api/types";
import type { AppController } from "../src/state/app";
import { Store } from "../src/sync/store";
import { COMPACT_QUERY } from "../src/ui/compact";
import { DatabaseView } from "../src/ui/DatabaseView";
import { type DbCtx, PropertyDialog, RelationPicker } from "../src/ui/DbCells";
import { RowProperties } from "../src/ui/RowProperties";

let compact = false;
beforeEach(() => {
  compact = false;
  vi.stubGlobal("matchMedia", (query: string) => ({ matches: query === COMPACT_QUERY ? compact : false, addEventListener: () => {}, removeEventListener: () => {} }));
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  localStorage.clear();
});

const settle = (ms = 40) => act(async () => { await new Promise((resolve) => setTimeout(resolve, ms)); });

function fakeController(api: Record<string, unknown>) {
  const store = new Store();
  store.upsertUser({ id: "u1", username: "kano", display_name: "加納", role: "member", created_at: "", updated_at: "", deactivated_at: null });
  const errors: unknown[] = [];
  const controller = {
    store,
    api,
    engine: null,
    isGuest: false,
    setError: (e: unknown) => errors.push(e),
    setNotice: () => {},
  } as unknown as AppController;
  return { controller, errors };
}

const p = (id: string, name: string, type: DbProperty["type"], extra: Partial<DbProperty> = {}): DbProperty => ({ id, name, type, options: [], number_format: null, relation: null, ...extra });
const PROPS: DbProperty[] = [
  p("title", "", "title"),
  p("stage", "段階", "select", { options: [{ id: "o1", name: "読む", color: "blue" }, { id: "o2", name: "読んだ", color: "green" }] }),
  p("done", "読了", "checkbox"),
  p("due", "締め切り", "date"),
  p("authors", "著者", "relation", { relation: { database_id: "people", database_title: "著者", pair_id: "papers", primary: true } }),
];

function database(views: DatabaseOut["views"], level: DatabaseOut["my_level"] = "full"): DatabaseOut {
  return { page_id: "db", schema_version: 3, properties: PROPS, views, my_level: level, row_count: 2, limits: { rows: 5000, properties: 50, options: 200, views: 20 } };
}

const row = (id: string, title: string, props: Record<string, unknown>, extra: Partial<DbRow> = {}): DbRow => ({
  id, database_id: "db", title, icon: null, position: id, version: 1, head_rev_id: "r", props: props as DbRow["props"], relations: {}, hidden_relations: [],
  created_at: "2026-10-01T00:00:00Z", created_by: "u1", updated_at: "2026-10-01T00:00:00Z", updated_by: "u1", ...extra,
});

const ROWS = [
  row("r1", "Attention", { stage: "o2", done: true, due: { start: "2026-10-05", end: "2026-10-13", time: false } }, { relations: { authors: ["a1"] }, hidden_relations: ["authors"] }),
  row("r2", "BERT", { stage: "o1", due: { start: "2026-10-14", end: null, time: false } }),
];

function api(views: DatabaseOut["views"], extra: Record<string, unknown> = {}) {
  const queries: DbRowQuery[] = [];
  const out = {
    wikiDatabase: vi.fn(async () => database(views)),
    queryWikiRows: vi.fn(async (_id: string, q: DbRowQuery): Promise<DbRowQueryOut> => {
      queries.push(q);
      return { rows: ROWS, refs: [{ id: "a1", database_id: "people", title: "Vaswani", icon: null }], total: 2, next_cursor: null, schema_version: 3 };
    }),
    setWikiCells: vi.fn(async (rowId: string, values: Record<string, unknown>) => ({ row: { ...ROWS.find((r) => r.id === rowId)!, props: { ...ROWS.find((r) => r.id === rowId)!.props, ...values } }, refs: [] })),
    createWikiRow: vi.fn(async () => ({ row: row("r3", "", {}), refs: [] })),
    ...extra,
  };
  return { api: out, queries };
}

const TABLE = [{ id: "v1", name: "", type: "table" as const, columns: [], sort: [], filter: null, date_prop_id: null, cover: "body" as const, card_size: "medium" as const }];
const CALENDAR = [{ id: "cal", name: "締め切り", type: "calendar" as const, columns: [], sort: [], filter: null, date_prop_id: "due", cover: "body" as const, card_size: "medium" as const }];

describe("the table", () => {
  it("shows each type, the readable linked rows and one placeholder for the rest", async () => {
    const { api: fake } = api(TABLE);
    const { controller } = fakeController(fake);
    render(<DatabaseView controller={controller} databaseId="db" compact={false} renderPeek={() => null} onOpenRowPage={() => {}} />);
    await settle();
    const table = document.querySelector("[data-db-table]") as HTMLElement;
    expect(within(table).getByText("名前")).toBeTruthy(); // the unnamed title property
    expect(within(table).getByText("読んだ")).toBeTruthy();
    const first = table.querySelector("[data-row='r1']") as HTMLElement;
    expect(within(first).getByText("Vaswani")).toBeTruthy();
    expect(within(first).getByText("アクセスできないページ")).toBeTruthy();
    expect(within(table.querySelector("[data-row='r2']") as HTMLElement).queryByText("アクセスできないページ")).toBeNull();
    expect(screen.getByText("2 行")).toBeTruthy();
  });

  it("a checkbox is written at once; 「新規」 adds a row", async () => {
    const { api: fake } = api(TABLE);
    const { controller } = fakeController(fake);
    render(<DatabaseView controller={controller} databaseId="db" compact={false} renderPeek={() => null} onOpenRowPage={() => {}} />);
    await settle();
    const second = document.querySelector("[data-row='r2'] [data-cell='done'] [role='checkbox']") as HTMLElement;
    fireEvent.click(second);
    await settle();
    expect(fake.setWikiCells).toHaveBeenCalledWith("r2", { done: true }, expect.any(String));
    fireEvent.click(screen.getByText("新規"));
    await settle();
    expect(fake.createWikiRow).toHaveBeenCalledWith("db", expect.objectContaining({ title: "", props: {} }));
    expect(document.querySelector("[data-row='r3']")).toBeTruthy();
  });

  it("the toolbar's sort goes to the server's query, and a manager may save it to the view", async () => {
    const putWikiView = vi.fn(async () => database(TABLE));
    const { api: fake, queries } = api(TABLE, { putWikiView });
    const { controller } = fakeController(fake);
    render(<DatabaseView controller={controller} databaseId="db" compact={false} renderPeek={() => null} onOpenRowPage={() => {}} />);
    await settle();
    expect(queries[0]).toMatchObject({ view_id: "v1", sort: [], limit: 200 });
    fireEvent.click(screen.getByRole("button", { name: /並べ替え/ }));
    fireEvent.click(await screen.findByText("並べ替えを追加"));
    await settle(400);
    expect(queries.at(-1)?.sort).toEqual([{ prop_id: "title", direction: "asc" }]);
    fireEvent.click(screen.getByRole("button", { name: /ビューを保存/ }));
    await settle();
    expect(putWikiView).toHaveBeenCalledWith("db", "v1", expect.objectContaining({ sort: [{ prop_id: "title", direction: "asc" }] }));
  });

  it("view only: no 「新規」, no saving", async () => {
    const { api: fake } = api(TABLE, { wikiDatabase: vi.fn(async () => database(TABLE, "view")) });
    const { controller } = fakeController(fake);
    render(<DatabaseView controller={controller} databaseId="db" compact={false} renderPeek={() => null} onOpenRowPage={() => {}} />);
    await settle();
    expect(screen.queryByText("新規")).toBeNull();
    expect(document.querySelector("[data-row='r2'] [data-cell='done'] [role='checkbox']")).toBeNull();
  });
});

describe("the table's selected cell (WIKI.md §29)", () => {
  const box = (rowId: string, propId: string) => document.querySelector(`[data-row='${rowId}'] [data-cell='${propId}'] [data-cell-focus]`) as HTMLElement;
  const td = (rowId: string, propId: string) => document.querySelector(`[data-row='${rowId}'] [data-cell='${propId}']`) as HTMLElement;
  /** A mouse click as the browser sends it: pointerdown (where Radix closes an open editor), mousedown, click. */
  const press = async (el: HTMLElement) => {
    fireEvent.pointerDown(el);
    fireEvent.mouseDown(el);
    fireEvent.click(el);
    await settle(20);
  };
  const editor = () => screen.queryByLabelText("値を編集") as HTMLInputElement | null;
  const open = async () => {
    const { api: fake } = api(TABLE);
    const { controller } = fakeController(fake);
    render(<DatabaseView controller={controller} databaseId="db" compact={false} renderPeek={() => null} onOpenRowPage={() => {}} />);
    await settle();
    return fake;
  };

  it("a click elsewhere while editing saves the edit once and only selects the clicked cell; a second click edits it", async () => {
    const fake = await open();
    await press(box("r1", "title"));
    expect(editor()?.value).toBe("Attention");
    fireEvent.change(editor()!, { target: { value: "Attention!" } });
    await press(box("r2", "title"));
    expect(fake.setWikiCells).toHaveBeenCalledTimes(1);
    expect(fake.setWikiCells).toHaveBeenCalledWith("r1", { title: "Attention!" }, expect.any(String));
    expect(editor()).toBeNull();
    expect(td("r2", "title").getAttribute("aria-selected")).toBe("true");
    expect(td("r1", "title").getAttribute("aria-selected")).toBe("false");
    // The second click on the selected cell edits it; Esc cancels without saving.
    await press(box("r2", "title"));
    expect(editor()?.value).toBe("BERT");
    fireEvent.change(editor()!, { target: { value: "BERT?" } });
    fireEvent.keyDown(editor()!, { key: "Escape" });
    await settle(20);
    expect(editor()).toBeNull();
    expect(fake.setWikiCells).toHaveBeenCalledTimes(1);
    expect(td("r2", "title").getAttribute("aria-selected")).toBe("true");
  });

  it("a checkbox clicked while another cell is edited is only selected; the next click flips it", async () => {
    const fake = await open();
    await press(box("r1", "title"));
    expect(editor()).toBeTruthy();
    await press(box("r2", "done"));
    expect(editor()).toBeNull();
    expect(fake.setWikiCells).not.toHaveBeenCalled(); // the title did not change: nothing to save
    expect(td("r2", "done").getAttribute("aria-selected")).toBe("true");
    await press(box("r2", "done"));
    expect(fake.setWikiCells).toHaveBeenCalledWith("r2", { done: true }, expect.any(String));
  });

  it("arrows move the selection, Enter and typing edit it, Esc clears it", async () => {
    const fake = await open();
    await press(box("r1", "title"));
    fireEvent.keyDown(editor()!, { key: "Escape" });
    await settle(20);
    expect(td("r1", "title").getAttribute("aria-selected")).toBe("true");
    fireEvent.keyDown(box("r1", "title"), { key: "ArrowDown" });
    expect(td("r2", "title").getAttribute("aria-selected")).toBe("true");
    expect(document.activeElement).toBe(box("r2", "title"));
    fireEvent.keyDown(box("r2", "title"), { key: "ArrowDown" }); // the last line: stays
    expect(td("r2", "title").getAttribute("aria-selected")).toBe("true");
    fireEvent.keyDown(box("r2", "title"), { key: "ArrowRight" });
    expect(td("r2", "stage").getAttribute("aria-selected")).toBe("true");
    fireEvent.keyDown(box("r2", "stage"), { key: "Enter" });
    await settle(20);
    expect(screen.getByLabelText("選択肢を探す")).toBeTruthy();
    fireEvent.keyDown(screen.getByLabelText("選択肢を探す"), { key: "Escape" });
    await settle(20);
    // Typing on a selected text cell edits it, going on after its value; Enter saves once.
    fireEvent.keyDown(box("r2", "stage"), { key: "ArrowLeft" });
    fireEvent.keyDown(box("r2", "title"), { key: "s" });
    await settle(20);
    expect(editor()?.value).toBe("BERTs");
    const input = editor()!;
    fireEvent.keyDown(input, { key: "Enter" });
    fireEvent.blur(input); // a late blur saves nothing more
    await settle(20);
    expect(fake.setWikiCells).toHaveBeenCalledTimes(1);
    expect(fake.setWikiCells).toHaveBeenCalledWith("r2", { title: "BERTs" }, expect.any(String));
    // An IME's key does not type into the cell; ⌘ shortcuts are left alone.
    fireEvent.keyDown(box("r2", "title"), { key: "a", metaKey: true });
    fireEvent.keyDown(box("r2", "title"), { key: "Process", keyCode: 229 });
    expect(editor()).toBeNull();
    const esc = fireEvent.keyDown(box("r2", "title"), { key: "Escape" });
    expect(esc).toBe(false); // handled (the screen's Esc waits)
    expect(td("r2", "title").getAttribute("aria-selected")).toBe("false");
  });
});

describe("who shapes the database (M144)", () => {
  const renderAt = async (level: DatabaseOut["my_level"], isGuest = false) => {
    const { api: fake } = api(TABLE, { wikiDatabase: vi.fn(async () => database(TABLE, level)) });
    const { controller } = fakeController(fake);
    (controller as { isGuest: boolean }).isGuest = isGuest;
    render(<DatabaseView controller={controller} databaseId="db" compact={false} renderPeek={() => null} onOpenRowPage={() => {}} />);
    await settle();
  };

  it("edit access adds views and properties (the header's ＋ too)", async () => {
    await renderAt("edit");
    expect(screen.getByRole("button", { name: "ビューを追加" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "ビューのメニュー" })).toBeTruthy();
    const table = document.querySelector("[data-db-table]") as HTMLElement;
    expect(within(table).getByRole("button", { name: "プロパティを追加" })).toBeTruthy();
  });

  it("view only, and a guest even with full access: no view or property controls", async () => {
    await renderAt("view");
    expect(screen.queryByRole("button", { name: "ビューを追加" })).toBeNull();
    expect(screen.queryByRole("button", { name: "プロパティを追加" })).toBeNull();
    cleanup();
    await renderAt("full", true);
    expect(screen.queryByRole("button", { name: "ビューを追加" })).toBeNull();
    expect(screen.queryByRole("button", { name: "ビューのメニュー" })).toBeNull();
  });

  const dialog = (canDestroy: boolean, prop: DbProperty | null, changeSchema = vi.fn(async () => null)) => {
    const { controller } = fakeController({});
    const ctx: DbCtx = { controller, database: database(TABLE, canDestroy ? "full" : "edit"), refs: new Map(), canEdit: true, canShape: true, canDestroy, setCell: async () => {}, changeSchema, openRow: () => {} };
    render(<PropertyDialog ctx={ctx} prop={prop} databases={[{ id: "db", title: "論文" }, { id: "people", title: "著者" }]} onClose={() => {}} />);
    return changeSchema;
  };

  it("an editor renames and adds options, but neither deletes, retypes nor removes saved options", async () => {
    const changeSchema = dialog(false, PROPS[1]!);
    expect((screen.getByLabelText("種類") as HTMLSelectElement).disabled).toBe(true);
    expect(screen.queryByRole("button", { name: /プロパティを削除/ })).toBeNull();
    expect(screen.queryAllByRole("button", { name: "外す" })).toHaveLength(0);
    expect(document.querySelector("[data-full-only-note]")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /選択肢を追加/ }));
    expect(screen.getAllByRole("button", { name: "外す" })).toHaveLength(1); // the new, unsaved one
    const names = screen.getAllByLabelText("選択肢の名前") as HTMLInputElement[];
    fireEvent.change(names.at(-1)!, { target: { value: "書いた" } });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await settle();
    expect(changeSchema).toHaveBeenCalledWith([{ op: "update", id: "stage", options: [{ id: "o1", name: "読む", color: "blue" }, { id: "o2", name: "読んだ", color: "green" }, { name: "書いた", color: expect.any(String) }] }]);
  });

  it("an editor's new relation is one-way (no two-way choice)", () => {
    dialog(false, null);
    fireEvent.change(screen.getByLabelText("種類"), { target: { value: "relation" } });
    expect(screen.queryByText("相手のデータベースにも表示する（双方向）")).toBeNull();
  });

  it("full access: delete, retype, remove options, two-way", () => {
    dialog(true, PROPS[1]!);
    expect((screen.getByLabelText("種類") as HTMLSelectElement).disabled).toBe(false);
    expect(screen.getByRole("button", { name: /プロパティを削除/ })).toBeTruthy();
    expect(screen.getAllByRole("button", { name: "外す" })).toHaveLength(2);
    expect(document.querySelector("[data-full-only-note]")).toBeNull();
    cleanup();
    dialog(true, null);
    fireEvent.change(screen.getByLabelText("種類"), { target: { value: "relation" } });
    expect(screen.getByText("相手のデータベースにも表示する（双方向）")).toBeTruthy();
  });
});

describe("the calendar", () => {
  it("asks for the six weeks on screen; a range spans its days across weeks", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: new Date(2026, 9, 7, 12) });
    try {
      const { api: fake, queries } = api(CALENDAR);
      const { controller } = fakeController(fake);
      render(<DatabaseView controller={controller} databaseId="db" compact={false} renderPeek={() => null} onOpenRowPage={() => {}} />);
      await settle();
      expect(queries[0]?.range).toEqual({ prop_id: "due", start: "2026-09-28", end: "2026-11-08" });
      const bars = document.querySelectorAll("[data-bar='r1']");
      expect(bars).toHaveLength(2); // 10/05-10/11 and 10/12-10/13
      expect((bars[0] as HTMLElement).closest("[data-week]")?.getAttribute("data-week")).toBe("2026-10-05");
      expect((bars[1] as HTMLElement).closest("[data-week]")?.getAttribute("data-week")).toBe("2026-10-12");
    } finally {
      vi.useRealTimers();
    }
  });

  it("a narrow screen shows the month as an agenda", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: new Date(2026, 9, 7, 12) });
    try {
      const { api: fake } = api(CALENDAR);
      const { controller } = fakeController(fake);
      render(<DatabaseView controller={controller} databaseId="db" compact renderPeek={() => null} onOpenRowPage={() => {}} />);
      await settle();
      const list = document.querySelector("[data-db-agenda]") as HTMLElement;
      expect(within(list).getAllByText("Attention")).toHaveLength(9); // 10/05 … 10/13
      expect(within(list).getAllByText("BERT")).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("the relation picker", () => {
  it("lists linked rows I can read and candidates; adding keeps the others (the server keeps the hidden ones)", async () => {
    const candidates = vi.fn(async (_db: string, _prop: string, _q: string) => [{ id: "a1", database_id: "people", title: "Vaswani", icon: null }, { id: "a2", database_id: "people", title: "Devlin", icon: null }]);
    const { controller } = fakeController({ wikiRelationCandidates: candidates });
    const setCell = vi.fn(async () => {});
    const ctx: DbCtx = {
      controller, database: database(TABLE), refs: new Map([["a1", { id: "a1", database_id: "people", title: "Vaswani", icon: null }]]),
      canEdit: true, canShape: false, canDestroy: false, setCell, changeSchema: async () => null, openRow: () => {},
    };
    render(<RelationPicker ctx={ctx} prop={PROPS[4]!} row={ROWS[0]!} />);
    await settle(250);
    const picker = document.querySelector("[data-relation-picker]") as HTMLElement;
    expect(within(picker).getByText("アクセスできないページ")).toBeTruthy();
    expect(candidates).toHaveBeenCalledWith("db", "authors", "");
    fireEvent.click(within(picker).getByRole("button", { name: /Devlin/ }));
    expect(setCell).toHaveBeenCalledWith(ROWS[0], "authors", ["a1", "a2"]);
  });

  it("a relation to a database I cannot read: nothing to pick", async () => {
    const { controller } = fakeController({ wikiRelationCandidates: vi.fn(async () => []) });
    const prop = p("secret", "メモ", "relation", { relation: { database_id: null, database_title: null, pair_id: null, primary: true } });
    const ctx: DbCtx = { controller, database: database(TABLE), refs: new Map(), canEdit: true, canShape: false, canDestroy: false, setCell: async () => {}, changeSchema: async () => null, openRow: () => {} };
    render(<RelationPicker ctx={ctx} prop={prop} row={row("x", "x", {}, { hidden_relations: ["secret"] })} />);
    await settle();
    expect(screen.getByText("相手のデータベースを読めません")).toBeTruthy();
  });
});

describe("a row's page", () => {
  it("shows the properties above the body and the rows linking here one way", async () => {
    const detail: DbRowDetail = {
      row: ROWS[0]!, database: database(TABLE), database_title: "論文リスト",
      refs: [{ id: "a1", database_id: "people", title: "Vaswani", icon: null }],
      referenced_by: [{ database_id: "tasks", database_title: "タスク", prop_id: "x", prop_name: "参考", rows: [{ id: "t1", database_id: "tasks", title: "まとめる", icon: null }] }],
    };
    const { controller } = fakeController({ wikiRow: vi.fn(async () => detail) });
    render(<RowProperties controller={controller} rowId="r1" version={1} onOpenPage={() => {}} />);
    await settle();
    const section = screen.getByRole("region", { name: "プロパティ" });
    expect(within(section).getByText("段階")).toBeTruthy();
    expect(within(section).getByText("読んだ")).toBeTruthy();
    expect(within(section).getByText("Vaswani")).toBeTruthy();
    expect(within(section).getByText("アクセスできないページ")).toBeTruthy();
    expect(within(section).getByText("タスク の 参考")).toBeTruthy();
    expect(within(section).getByText("まとめる")).toBeTruthy();
  });
});
