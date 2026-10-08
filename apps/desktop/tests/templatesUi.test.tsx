// @vitest-environment jsdom
/**
 * M145 templates and copies on Desktop / Web (WIKI.md §22.3): the gallery (白紙, built-in, everyone's templates), the
 * tree's 「テンプレート」, 「テンプレートとして保存」 and 「複製」 from a page's ⋯, a template's banner, the table's 「新規 ▾」
 * (a row from a template, blank, a new template, the default), a row template's 「今日」 / 「自分」, and the hub keeping
 * templates out of the tree.
 */
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { CanvasTemplateOut, DatabaseOut, DbProperty, DbRow, DbRowQueryOut, PageDuplicate, PageItem, WikiAccessOut, WikiTemplatesOut } from "../src/api/types";
import type { AppController } from "../src/state/app";
import { Store } from "../src/sync/store";
import { WikiHub } from "../src/sync/wiki";
import { COMPACT_QUERY } from "../src/ui/compact";
import { DatabaseView } from "../src/ui/DatabaseView";
import { CellDisplay, CellEditor, type DbCtx } from "../src/ui/DbCells";
import { createPage } from "../src/ui/docsActions";
import { DocPage } from "../src/ui/DocPage";
import { TemplateGallery } from "../src/ui/DocsTemplates";
import { DocsTree } from "../src/ui/DocsTree";
import { FakeWiki, item, uid } from "./wikiFixtures";

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

function fakeController(options: { api?: Record<string, unknown>; hub?: WikiHub | null; isGuest?: boolean } = {}) {
  const store = new Store();
  store.upsertUser({ id: "u-me", username: "me", display_name: "わたし", role: "member", created_at: "", updated_at: "", deactivated_at: null });
  const errors: unknown[] = [];
  const notices: string[] = [];
  const controller = {
    store,
    api: options.api ?? null,
    engine: options.hub ? { wiki: options.hub } : null,
    isGuest: options.isGuest ?? false,
    isAdmin: false,
    accountKey: "test",
    setError: (e: unknown) => errors.push(e),
    setNotice: (text: string) => notices.push(text),
    copyPageLink: vi.fn(async () => {}),
    requestOpenPage: vi.fn(),
    attachmentMeta: async () => null,
    copyMessageText: async () => {},
  } as unknown as AppController;
  return { controller, store, errors, notices };
}

const builtin = (key: string, name: string): CanvasTemplateOut => ({ id: `b-${key}`, key, name, description: `${name}の説明`, title: name, body: "", position: 0, builtin: true, hidden: false, updated_at: "2026-10-08T00:00:00Z" });

class TemplateWiki extends FakeWiki {
  templates: WikiTemplatesOut = { pages: [], builtins: [builtin("weekly_report", "週報"), builtin("minutes", "議事録")] };
  async wikiTemplates(): Promise<WikiTemplatesOut> {
    this.calls.push("templates");
    return this.templates;
  }
}

function hubWith(api: FakeWiki): WikiHub {
  const hub = new WikiHub({ api, store: new Store(), options: { debounceMs: 10, feedDelayMs: 5, resolveDelayMs: 5 } });
  hub.applyBootstrap({ change_seq: 1 });
  return hub;
}

describe("the gallery", () => {
  it("offers 白紙, the built-in templates and everyone's templates, and answers the choice", async () => {
    const api = new TemplateWiki();
    const tpl = uid(901);
    api.templates.pages = [item(tpl, { title: "研究会の記録", is_template: true, my_level: "view", icon: "📝" })];
    const hub = hubWith(api);
    const { controller } = fakeController({ hub });
    const onPick = vi.fn();
    const onClose = vi.fn();
    render(<TemplateGallery controller={controller} title="新しいページ" onPick={onPick} onClose={onClose} />);
    await settle();
    expect(screen.getByRole("button", { name: /白紙のページ/ })).toBeTruthy();
    const builtins = screen.getByRole("region", { name: "組み込み" });
    expect(within(builtins).getAllByRole("button").map((b) => b.querySelector(".font-medium")?.textContent)).toEqual(["週報", "議事録"]);
    const everyone = screen.getByRole("region", { name: "みんなのテンプレート" });
    fireEvent.click(within(everyone).getByRole("button", { name: /研究会の記録/ }));
    expect(onPick).toHaveBeenCalledWith({ kind: "page", id: tpl });
    expect(onClose).toHaveBeenCalled();
    cleanup();

    // starting an empty page from a template: no 白紙; a built-in one by its key
    render(<TemplateGallery controller={controller} title="テンプレートから始める" blank={false} onPick={onPick} onClose={() => {}} />);
    await settle();
    expect(screen.queryByRole("button", { name: /白紙のページ/ })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /議事録/ }));
    expect(onPick).toHaveBeenLastCalledWith({ kind: "builtin", key: "minutes" });
  });

  it("no templates of anyone yet: says how to make one", async () => {
    const hub = hubWith(new TemplateWiki());
    const { controller } = fakeController({ hub });
    render(<TemplateGallery controller={controller} title="新しいページ" onPick={() => {}} onClose={() => {}} />);
    await settle();
    expect(screen.getByText(/「テンプレートとして保存」で作れます/)).toBeTruthy();
  });

  it("a page made from a choice sends the template (and its zone) to the server", async () => {
    const createWikiPage = vi.fn(async (body: Record<string, unknown>) => ({ ...item(uid(950)), body: "", breadcrumbs: [], children: [], ...body }));
    const { controller } = fakeController({ api: { createWikiPage } });
    await createPage(controller, { parentId: "p", template: { kind: "page", id: "tpl" } });
    expect(createWikiPage).toHaveBeenLastCalledWith(expect.objectContaining({ parent_id: "p", template_page_id: "tpl", template_key: null, is_template: false, tz: expect.any(String) }));
    await createPage(controller, { template: { kind: "builtin", key: "minutes" } });
    expect(createWikiPage).toHaveBeenLastCalledWith(expect.objectContaining({ template_key: "minutes", template_page_id: null }));
    await createPage(controller, { isTemplate: true });
    expect(createWikiPage).toHaveBeenLastCalledWith(expect.objectContaining({ is_template: true, template_key: null, template_page_id: null }));
  });
});

describe("the tree's 「テンプレート」", () => {
  it("lists the templates I can read (not in 共有 / プライベート), ＋ for a new one but not for a guest", async () => {
    const api = new TemplateWiki();
    api.add(item(uid(911), { title: "マニュアル" }));
    api.templates.pages = [item(uid(912), { title: "週報のひな形", is_template: true })];
    const hub = hubWith(api);
    await settle();
    const onNewTemplate = vi.fn();
    const onOpen = vi.fn();
    const { controller } = fakeController({ hub });
    render(<DocsTree controller={controller} selectedId={null} onOpen={onOpen} onCreate={() => {}} onNewTemplate={onNewTemplate} onMove={() => {}} onTrash={() => {}} onOpenTrash={() => {}} />);
    await settle();
    const section = screen.getByRole("region", { name: "テンプレート" });
    fireEvent.click(within(section).getByRole("button", { name: /週報のひな形/ }));
    expect(onOpen).toHaveBeenCalledWith(uid(912));
    fireEvent.click(within(section).getByRole("button", { name: "新しいテンプレート" }));
    expect(onNewTemplate).toHaveBeenCalled();
    expect(within(screen.getByRole("region", { name: "共有" })).queryByText("週報のひな形")).toBeNull();
    cleanup();
    const guest = fakeController({ hub, isGuest: true });
    render(<DocsTree controller={guest.controller} selectedId={null} onOpen={() => {}} onCreate={() => {}} onNewTemplate={null} onMove={() => {}} onTrash={() => {}} onOpenTrash={() => {}} />);
    expect(within(screen.getByRole("region", { name: "テンプレート" })).queryByRole("button", { name: "新しいテンプレート" })).toBeNull();
  });

  it("the hub: a page that became a template leaves the tree for the template list, and back", async () => {
    const api = new TemplateWiki();
    const id = uid(921);
    api.add(item(id, { title: "まとめ" }));
    const hub = hubWith(api);
    await settle();
    await hub.loadTemplates();
    expect(hub.page(id)).toBeTruthy();
    hub.upsert({ ...item(id, { title: "まとめ", is_template: true, version: 2 }) });
    expect(hub.page(id)).toBeUndefined();
    expect(hub.templatePages().map((p) => p.id)).toEqual([id]);
    hub.upsert({ ...item(id, { title: "まとめ", is_template: false, version: 3 }) });
    expect(hub.page(id)).toBeTruthy();
    expect(hub.templatePages()).toEqual([]);
    // wiki.changed reads the list again once it was read
    api.calls.length = 0;
    hub.applyEvent("wiki.changed", { seq: 2 });
    await settle(30);
    expect(api.calls).toContain("templates");
  });
});

describe("a page's ⋯: 「テンプレートとして保存」 and 「複製」", () => {
  const parentAccess: WikiAccessOut = {
    page_id: "parent",
    inherit_access: true,
    my_level: "edit",
    own: [],
    effective: [{ principal_type: "workspace", principal_id: null, level: "edit", inherited: false, source_page_id: "parent", source_title: null }],
  };

  async function openPage(extra: Partial<PageItem> = {}) {
    const api = new TemplateWiki();
    const parentId = uid(931);
    const pageId = uid(932);
    api.add(item(parentId, { title: "研究室" }));
    api.add(item(pageId, { parent_id: parentId, title: "議事録 10/8", my_level: "edit", ...extra }), "# 議題\n");
    const hub = hubWith(api);
    const duplicateWikiPage = vi.fn(async (_id: string, body: PageDuplicate) => ({
      page: { ...item(uid(933), { title: body.title ?? "", is_template: !!body.as_template }), body: "", breadcrumbs: [], children: [] },
      row: null,
    }));
    const onOpenPage = vi.fn();
    const { controller, notices } = fakeController({ hub, api: { wikiBacklinks: async () => [], wikiAccess: vi.fn(async () => parentAccess), duplicateWikiPage } });
    render(<DocPage controller={controller} pageId={pageId} onOpenPage={onOpenPage} onShare={() => {}} onTrash={() => {}} onAddChild={() => {}} />);
    await settle(60);
    const openMenu = () => {
      fireEvent.keyDown(screen.getByRole("button", { name: "ページの操作" }), { key: "Enter" });
      return screen.getByRole("menu");
    };
    return { pageId, duplicateWikiPage, onOpenPage, notices, openMenu };
  }

  it("「テンプレートとして保存」: a copy at the top level that everyone can use (or only me)", async () => {
    const { pageId, duplicateWikiPage, onOpenPage, notices, openMenu } = await openPage();
    fireEvent.click(within(openMenu()).getByRole("menuitem", { name: /テンプレートとして保存/ }));
    const dialog = screen.getByRole("dialog");
    expect((within(dialog).getByRole("textbox", { name: "ページの題名" }) as HTMLInputElement).value).toBe("議事録 10/8");
    expect((within(dialog).getByRole("radio", { name: "ワークスペースの全員が使える（閲覧）" }) as HTMLInputElement).checked).toBe(true);
    fireEvent.click(within(dialog).getByRole("radio", { name: "自分だけ" }));
    fireEvent.click(within(dialog).getByRole("button", { name: /テンプレートとして保存/ }));
    await settle();
    expect(duplicateWikiPage).toHaveBeenCalledWith(pageId, expect.objectContaining({ as_template: true, title: "議事録 10/8", access: "private" }));
    expect(onOpenPage).toHaveBeenCalledWith(uid(933));
    expect(notices).toContain("テンプレート「議事録 10/8」を保存しました");
  });

  it("「複製」: 「（コピー）」 beside the original, showing who will see it (the parent's sharing)", async () => {
    const { pageId, duplicateWikiPage, openMenu } = await openPage();
    fireEvent.click(within(openMenu()).getByRole("menuitem", { name: "複製" }));
    await settle();
    const dialog = screen.getByRole("dialog");
    expect((within(dialog).getByRole("textbox", { name: "ページの題名" }) as HTMLInputElement).value).toBe("議事録 10/8（コピー）");
    expect(within(dialog).getByText(/「研究室」の中に置くので/)).toBeTruthy();
    const who = within(dialog).getByRole("list", { name: "見られる人" });
    expect(within(who).getByText("ワークスペースの全員")).toBeTruthy();
    expect(within(dialog).queryByRole("radio")).toBeNull();
    fireEvent.click(within(dialog).getByRole("button", { name: /複製/ }));
    await settle();
    expect(duplicateWikiPage).toHaveBeenCalledWith(pageId, { as_template: false, title: "議事録 10/8（コピー）", client_save_id: expect.any(String) });
  });

  it("a template: the banner (its placeholders), 「このテンプレートでページを作成」, no 「テンプレートとして保存」", async () => {
    const { openMenu } = await openPage({ parent_id: null, is_template: true, title: "週報" });
    const banner = document.querySelector("[data-template-banner='page']") as HTMLElement;
    expect(banner.textContent).toContain("このページはテンプレートです");
    expect(banner.textContent).toContain("{{date}}");
    expect(banner.textContent).toContain("{{parent}}");
    expect(within(banner).getByRole("button", { name: /このテンプレートでページを作成/ })).toBeTruthy();
    const menu = openMenu();
    expect(within(menu).queryByRole("menuitem", { name: /テンプレートとして保存/ })).toBeNull();
    expect(within(menu).getByRole("menuitem", { name: /テンプレートを解除/ })).toBeTruthy();
  });
});

// --- databases -------------------------------------------------------------------------------------------------------

const prop = (id: string, name: string, type: DbProperty["type"]): DbProperty => ({ id, name, type, options: [], number_format: null, relation: null });
const PROPS = [prop("title", "", "title"), prop("due", "締め切り", "date"), prop("owner", "担当", "person")];
const row = (id: string, title: string, props: Record<string, unknown> = {}): DbRow => ({
  id, database_id: "db", title, icon: null, position: id, version: 1, head_rev_id: "r", props: props as DbRow["props"], relations: {}, hidden_relations: [],
  created_at: "2026-10-01T00:00:00Z", created_by: "u-me", updated_at: "2026-10-01T00:00:00Z", updated_by: "u-me",
});
const TABLE = [{ id: "v1", name: "", type: "table" as const, columns: [], sort: [], filter: null, date_prop_id: null, cover: "body" as const, card_size: "medium" as const }];

function database(extra: Partial<DatabaseOut> = {}): DatabaseOut {
  return {
    page_id: "db", schema_version: 1, properties: PROPS, views: TABLE, my_level: "edit", row_count: 1,
    limits: { rows: 5000, properties: 50, options: 200, views: 20 },
    templates: [{ id: "t1", title: "週報", icon: null }, { id: "t2", title: "実験ノート", icon: null }],
    default_template_id: "t1",
    ...extra,
  };
}

describe("the table's 「新規 ▾」", () => {
  function setup() {
    const createWikiRow = vi.fn(async (_db: string, body: { is_template: boolean }) => ({ row: row(body.is_template ? "t3" : "r9", ""), refs: [] }));
    const setWikiDefaultTemplate = vi.fn(async (_db: string, id: string | null) => database({ default_template_id: id }));
    const api = {
      wikiDatabase: vi.fn(async () => database()),
      queryWikiRows: vi.fn(async (): Promise<DbRowQueryOut> => ({ rows: [row("r1", "Real")], refs: [], total: 1, next_cursor: null, schema_version: 1 })),
      createWikiRow,
      setWikiDefaultTemplate,
    };
    const { controller } = fakeController({ api });
    const peek = vi.fn(() => null);
    render(<DatabaseView controller={controller} databaseId="db" compact={false} renderPeek={peek} onOpenRowPage={() => {}} />);
    return { createWikiRow, setWikiDefaultTemplate, peek };
  }
  const openMenu = () => {
    fireEvent.click(screen.getByRole("button", { name: "テンプレートから作る" }));
    return document.querySelector("[data-new-row-menu]") as HTMLElement;
  };

  it("「新規」 leaves the choice to the server (the default template); ▾ lists the templates with the default marked", async () => {
    const { createWikiRow } = setup();
    await settle();
    fireEvent.click(screen.getByText("新規"));
    await settle();
    expect(createWikiRow).toHaveBeenLastCalledWith("db", expect.objectContaining({ template_id: null, blank: false, is_template: false }));
    const menu = openMenu();
    const items = [...menu.querySelectorAll("[data-row-template]")];
    expect(items.map((li) => li.textContent)).toEqual(["週報既定", "実験ノート"]);
    fireEvent.click(within(menu).getByRole("button", { name: "実験ノート" }));
    await settle();
    expect(createWikiRow).toHaveBeenLastCalledWith("db", expect.objectContaining({ template_id: "t2", blank: false }));
  });

  it("▾: a blank row, a new template (opened beside the table), the default changed", async () => {
    const { createWikiRow, setWikiDefaultTemplate, peek } = setup();
    await settle();
    fireEvent.click(within(openMenu()).getByRole("button", { name: /白紙の行/ }));
    await settle();
    expect(createWikiRow).toHaveBeenLastCalledWith("db", expect.objectContaining({ template_id: null, blank: true }));
    fireEvent.click(within(openMenu()).getByRole("button", { name: /新しいテンプレート/ }));
    await settle();
    expect(createWikiRow).toHaveBeenLastCalledWith("db", expect.objectContaining({ is_template: true }));
    expect(peek).toHaveBeenLastCalledWith("t3", expect.any(Function));
    expect(document.querySelector("[data-row='t3']")).toBeNull(); // a template is not a row of the table
    fireEvent.click(within(openMenu()).getByRole("button", { name: "既定を外す" }));
    await settle();
    expect(setWikiDefaultTemplate).toHaveBeenLastCalledWith("db", null);
    fireEvent.click(within(openMenu()).getByRole("button", { name: "「実験ノート」を「新規」の既定にする" }));
    await settle();
    expect(setWikiDefaultTemplate).toHaveBeenLastCalledWith("db", "t2");
  });

  it("a row template's cells: 「今日」 and 「自分」 show and can be chosen", async () => {
    const setCell = vi.fn(async () => {});
    const { controller } = fakeController();
    const ctx: DbCtx = { controller, database: database(), refs: new Map(), canEdit: true, canShape: true, canDestroy: false, setCell, changeSchema: async () => null, openRow: () => {}, template: true };
    const template = row("t1", "週報", { due: { start: "@today", end: null, time: false }, owner: ["@me"] });
    render(<><CellDisplay ctx={ctx} prop={PROPS[1]!} row={template} /><CellDisplay ctx={ctx} prop={PROPS[2]!} row={template} /></>);
    expect(document.querySelector("[data-dynamic='today']")?.textContent).toBe("今日");
    expect(document.querySelector("[data-dynamic='me']")?.textContent).toBe("自分");
    cleanup();
    render(<CellEditor ctx={ctx} prop={PROPS[1]!} row={row("t1", "週報")} onDone={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "今日（行を作る日）" }));
    expect(setCell).toHaveBeenCalledWith(expect.anything(), "due", { start: "@today", end: null, time: false });
    cleanup();
    render(<CellEditor ctx={ctx} prop={PROPS[2]!} row={row("t1", "週報")} onDone={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "自分（行を作る人）" }));
    expect(setCell).toHaveBeenLastCalledWith(expect.anything(), "owner", ["@me"]);
    cleanup();
    // not a template: no such choices
    render(<CellEditor ctx={{ ...ctx, template: false }} prop={PROPS[1]!} row={row("r1", "x")} onDone={() => {}} />);
    expect(screen.queryByRole("button", { name: "今日（行を作る日）" })).toBeNull();
  });
});
