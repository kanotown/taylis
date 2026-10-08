// @vitest-environment jsdom
/**
 * M149 (WIKI.md §22.5, §26): callouts, toggles and embedded databases as a page or canvas draws them (ui/CanvasBody.tsx),
 * the `/` menu's 「コールアウト」「トグル」「データベースを埋め込む」 and the embed's text edit (ui/docEditor.ts). The parsing
 * itself is the shared fixture's (tests/canvasMarkdown.test.ts).
 */
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { DatabaseOut, DbProperty, DbRow, DbRowQuery, DbRowQueryOut, DbView, PageRef } from "../src/api/types";
import type { AppController } from "../src/state/app";
import { Store } from "../src/sync/store";
import type { CanvasSaver } from "../src/sync/canvasSave";
import { CanvasBody } from "../src/ui/CanvasBody";
import { CanvasEditor } from "../src/ui/CanvasEditor";
import { COMPACT_QUERY } from "../src/ui/compact";
import { EMBED_ROWS } from "../src/ui/DatabaseView";
import { applySlash, insertEmbed, isEmbedQuery, slashItems } from "../src/ui/docEditor";
import { MessageBody } from "../src/ui/MessageBody";

beforeEach(() => {
  vi.stubGlobal("matchMedia", (query: string) => ({ matches: query === COMPACT_QUERY ? false : false, addEventListener: () => {}, removeEventListener: () => {} }));
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const settle = (ms = 40) => act(async () => { await new Promise((resolve) => setTimeout(resolve, ms)); });

const DB = "0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b";
const PROPS: DbProperty[] = [{ id: "title", name: "", type: "title", options: [], number_format: null, relation: null }];
const view = (id: string, name: string): DbView => ({ id, name, type: "table", columns: [], sort: [], filter: null, date_prop_id: null, group_by: null, cover: "body", card_size: "medium" });
const database = (): DatabaseOut => ({ page_id: DB, schema_version: 1, properties: PROPS, views: [view("v1", "すべて"), view("v2", "今週")], my_level: "view", row_count: 30, limits: { rows: 5000, properties: 50, options: 200, views: 20 } });
const row = (id: string, title: string): DbRow => ({
  id, database_id: DB, title, icon: null, position: id, version: 1, head_rev_id: "r", props: {}, relations: {}, hidden_relations: [],
  created_at: "2026-10-01T00:00:00Z", created_by: "u1", updated_at: "2026-10-01T00:00:00Z", updated_by: "u1",
});

/** A controller whose wiki hub knows `refs` (a page id → its ref, or null: one I cannot read). */
function fakeController(api: Record<string, unknown>, refs: Map<string, PageRef | null> | null = null) {
  const store = new Store();
  const opened: string[] = [];
  const hub = refs ? { subscribe: () => () => {}, version: 1, resolve: (id: string) => refs.get(id), pages: new Map(), page: () => undefined, onRows: () => () => {} } : null;
  const controller = {
    store, api, engine: hub ? { wiki: hub } : null, isGuest: false,
    setError: () => {}, setNotice: () => {}, openPermalink: () => {},
    requestOpenPage: (id: string) => opened.push(id),
  } as unknown as AppController;
  return { controller, opened };
}

describe("callouts and toggles", () => {
  it("a callout is a tinted box with its icon and its content as blocks; a toggle starts closed", () => {
    const { controller } = fakeController({});
    const ticks: Array<[number, boolean]> = [];
    const body = "::: callout ⚠️\n**注意**\n- 一つ目\n:::\n::: toggle 詳細\n- [ ] 中のタスク\n:::";
    render(<CanvasBody body={body} controller={controller} onToggleTask={(line, done) => ticks.push([line, done])} />);
    const callout = document.querySelector("[data-callout='0']") as HTMLElement;
    expect(callout.getAttribute("data-tone")).toBe("yellow");
    expect(callout.textContent).toContain("⚠️");
    expect(callout.querySelector("strong")?.textContent).toBe("注意");
    expect(callout.querySelector("ul")?.textContent).toContain("一つ目");
    const toggle = document.querySelector("[data-toggle='4']") as HTMLDetailsElement;
    expect(toggle.tagName).toBe("DETAILS");
    expect(toggle.open).toBe(false);
    expect(toggle.querySelector("summary")?.textContent).toBe("詳細");
    // A task inside ticks its own line of the body.
    fireEvent.click(toggle.querySelector("input[type='checkbox']")!);
    expect(ticks).toEqual([[5, true]]);
  });

  it("a toggle inside a callout; the outer wrappers keep the scroll sync's lines", () => {
    const { controller } = fakeController({});
    render(<CanvasBody body={"前\n::: callout\n::: toggle 中\nx\n:::\n:::\n後"} controller={controller} onToggleTask={null} />);
    expect(document.querySelector("[data-callout='1'] [data-toggle='2']")).toBeTruthy();
    expect([...document.querySelectorAll(".canvas-body > [data-line]")].map((el) => el.getAttribute("data-line"))).toEqual(["0", "1", "6"]);
  });

  it("messages keep the markers as text", () => {
    render(<MessageBody body={"::: callout 💡\n本文\n:::"} users={new Map()} />);
    expect(document.querySelector(".callout")).toBeNull();
    expect(document.body.textContent).toContain("::: callout 💡");
  });
});

describe("an embedded database", () => {
  function setup(refs: Map<string, PageRef | null> | null, failing = false) {
    const queries: DbRowQuery[] = [];
    const answer: DbRowQueryOut = { rows: Array.from({ length: EMBED_ROWS }, (_, i) => row(`r${i}`, `行 ${i}`)), refs: [], total: 30, next_cursor: "c", schema_version: 1 };
    const api = {
      wikiDatabase: vi.fn(async () => { if (failing) throw Object.assign(new Error("gone"), { status: 404 }); return database(); }),
      queryWikiRows: vi.fn(async (_id: string, q: DbRowQuery) => { queries.push(q); return answer; }),
    };
    const fake = fakeController(api, refs);
    render(<CanvasBody body={`見出し\n![秘密の表](page:${DB}#view=v2)`} controller={fake.controller} onToggleTask={null} />);
    return { api, queries, opened: fake.opened };
  }

  it("shows the named view, its first rows and 「すべて表示」, without the other views' tabs", async () => {
    const { queries, opened } = setup(null);
    await settle();
    expect(queries[0]).toMatchObject({ view_id: "v2", limit: EMBED_ROWS });
    const embed = document.querySelector("[data-embed='v2']") as HTMLElement;
    expect(embed.querySelector("[data-embed-view]")?.textContent).toContain("今週");
    expect(screen.queryByRole("tab")).toBeNull();
    expect(embed.textContent).toContain("行 0");
    expect(screen.queryByText("さらに読み込む")).toBeNull();
    fireEvent.click(screen.getByText("すべて表示"));
    expect(opened).toEqual([DB]);
  });

  it("a page I cannot read is a placeholder that never shows the label", async () => {
    const { api } = setup(new Map([[DB, null]]));
    await settle();
    expect(document.querySelector(`[data-embed-unavailable='${DB}']`)?.textContent).toBe("アクセスできないページ");
    expect(document.body.textContent).not.toContain("秘密の表");
    expect(api.wikiDatabase).not.toHaveBeenCalled();
  });

  it("a database that fails to load (gone, not shared) is the same placeholder", async () => {
    setup(null, true);
    await settle();
    expect(document.querySelector("[data-embed-unavailable]")).toBeTruthy();
    expect(document.body.textContent).not.toContain("秘密の表");
  });

  it("an ordinary page is its link", async () => {
    const { api } = setup(new Map([[DB, { id: DB, title: "手順", icon: null, kind: "page" }]]));
    await settle();
    expect(document.querySelector(`[data-page-link='${DB}']`)?.textContent).toContain("手順");
    expect(api.wikiDatabase).not.toHaveBeenCalled();
  });
});

describe("the editor (M149)", () => {
  function editor(body: string) {
    const saver = {
      text: body, textRevision: 0, edits: [] as string[],
      canReplace: () => true, subscribe: () => () => {}, flush: async () => {}, compositionEnded() {},
      edit(text: string) { saver.text = text; saver.edits.push(text); },
    };
    const doc = {
      lookup: vi.fn(async () => [{ id: "p1", title: "ページ", icon: null, kind: "page" }] as PageRef[]),
      createChild: vi.fn(async () => null),
      createDatabase: vi.fn(async () => ({ id: DB, title: "", icon: null, kind: "database" }) as PageRef),
      lookupDatabases: vi.fn(async () => [{ id: DB, title: "予定", icon: null, kind: "database" }] as PageRef[]),
      embedView: vi.fn(async () => "v1"),
    };
    const { controller } = fakeController({});
    render(<CanvasEditor controller={controller} saver={saver as unknown as CanvasSaver} doc={doc} />);
    const area = screen.getByRole("textbox") as HTMLTextAreaElement;
    return { saver, doc, area };
  }

  it("`![[` lists databases, and the choice becomes an embed with its first view", async () => {
    const { saver, doc, area } = editor("");
    fireEvent.change(area, { target: { value: "前\n![[予" } });
    await settle(200);
    expect(doc.lookupDatabases).toHaveBeenCalledWith("予");
    expect(doc.lookup).not.toHaveBeenCalled();
    fireEvent.mouseDown(screen.getByRole("option", { name: /予定/ }));
    await settle();
    expect(doc.embedView).toHaveBeenCalledWith(DB);
    expect(saver.text).toBe(`前\n![予定](page:${DB}#view=v1)\n`);
  });

  it("「データベースを作って埋め込む」 makes the database and embeds it where the / was", async () => {
    const { saver, doc, area } = editor("");
    fireEvent.change(area, { target: { value: "前\n/データベースを作" } });
    await settle();
    fireEvent.mouseDown(screen.getByRole("option", { name: /データベースを作って埋め込む/ }));
    await settle();
    expect(doc.createDatabase).toHaveBeenCalled();
    expect(saver.text).toBe(`前\n![無題](page:${DB}#view=v1)\n`);
  });
});

describe("the / menu (M149)", () => {
  const at = (text: string) => ({ text, start: text.length, end: text.length });

  it("offers callout, toggle and embed", () => {
    expect(slashItems("コール").map((i) => i.key)).toContain("callout");
    expect(slashItems("toggle").map((i) => i.key)).toEqual(["toggle"]);
    expect(slashItems("embed").map((i) => i.key)).toEqual(["embedDatabase"]);
  });

  it("a callout and a toggle with the caret inside; the close stays on a line of its own", () => {
    const callout = applySlash(at("前\n/callout"), 2, "callout").state;
    expect(callout.text).toBe("前\n::: callout 💡\n\n:::");
    expect(callout.text.slice(0, callout.start)).toBe("前\n::: callout 💡\n");
    const toggle = applySlash({ text: "/toggle後ろ", start: 7, end: 7 }, 0, "toggle").state;
    expect(toggle.text).toBe("::: toggle \n\n:::\n後ろ");
    expect(toggle.start).toBe("::: toggle ".length);
  });

  it("「データベースを埋め込む」 opens the `![[` list; the choice is an embed on a line of its own", () => {
    const opened = applySlash(at("/embed"), 0, "embedDatabase").state;
    expect(opened.text).toBe("![[");
    expect(isEmbedQuery(opened.text, 1)).toBe(true);
    expect(isEmbedQuery("[[", 0)).toBe(false);
    const page = { id: DB, title: "予定 [仮]" };
    const first = `![予定 ［仮］](page:${DB}#view=v1)\n`;
    expect(insertEmbed({ text: "", start: 0, end: 0 }, page, "v1")).toEqual({ text: first, start: first.length, end: first.length });
    const mid = insertEmbed({ text: "前後", start: 1, end: 1 }, page, null);
    expect(mid.text).toBe(`前\n![予定 ［仮］](page:${DB})\n後`);
    expect(mid.text.slice(mid.start)).toBe("後");
  });
});
