// @vitest-environment jsdom
/**
 * M150 (WIKI.md §22.6, §27): the 見たまま page editor on a Docs page, with the wiki hub and its save loop on a fake
 * server (tests/wikiFixtures.ts). Opening and leaving saves nothing; an edit saves the page with only that line
 * changed; switching to Markdown and back keeps the bytes and the caret's line; a merged body from the server comes in
 * (only its blocks change); the `/` menu, `[[` and `@`; no merged body while an IME composition is open; the setting.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { Editor } from "@tiptap/core";
import { TextSelection } from "@tiptap/pm/state";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { PageSaveIn, PageSaveOut, UserMe } from "../src/api/types";
import type { AppController } from "../src/state/app";
import { Store } from "../src/sync/store";
import { WikiHub } from "../src/sync/wiki";
import { COMPACT_QUERY } from "../src/ui/compact";
import { ShortcutsDialog } from "../src/ui/Dialogs";
import { DocPage } from "../src/ui/DocPage";
import { BlockSelection } from "../src/ui/pageEditorSelection";
import { pageHtmlFromPaste } from "../src/ui/pagePaste";
import { docsEditorModeOf } from "../src/ui/prefs";
import { DocsEditorModeSettings } from "../src/ui/Settings";
import { FakeWiki, item, uid } from "./wikiFixtures";

const ME = "0190a2b4-0000-7000-8000-0000000000e1";
const HANAKO = "0190a2b4-0000-7000-8000-0000000000e2";

beforeEach(() => {
  vi.stubGlobal("matchMedia", (query: string) => ({ matches: query === COMPACT_QUERY ? false : false, addEventListener: () => {}, removeEventListener: () => {} }));
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  const range = Range.prototype as unknown as { getClientRects?: unknown; getBoundingClientRect?: unknown };
  range.getClientRects ??= () => [];
  range.getBoundingClientRect ??= () => new DOMRect();
  (Element.prototype as unknown as { scrollIntoView?: unknown }).scrollIntoView ??= () => {};
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  localStorage.clear();
});

const settle = (ms = 30) => act(async () => { await new Promise((resolve) => setTimeout(resolve, ms)); });

/** A server that merges someone else's change into the next save (as the real one does, merged: true). */
class MergingWiki extends FakeWiki {
  mergeNext: ((sent: string) => string) | null = null;
  override async saveWikiPage(pageId: string, body: PageSaveIn): Promise<PageSaveOut> {
    const merge = this.mergeNext;
    this.mergeNext = null;
    const out = await super.saveWikiPage(pageId, body);
    if (!merge) return out;
    const merged = merge(body.body);
    this.bodies.set(pageId, merged);
    return { ...out, page: { ...out.page, body: merged }, merged: true };
  }
}

function controllerFor(hub: WikiHub, api: Record<string, unknown>, mode: "wysiwyg" | "markdown" | null) {
  const store = new Store();
  const me = { id: ME, username: "me", display_name: "わたし", role: "member", created_at: "", updated_at: "", deactivated_at: null };
  store.upsertUser(me);
  store.upsertUser({ id: HANAKO, username: "hanako", display_name: "花子", role: "member", created_at: "", updated_at: "", deactivated_at: null });
  store.setMe({ ...me, docs_editor_mode: mode } as unknown as UserMe);
  const errors: unknown[] = [];
  const setDocsEditorMode = vi.fn(async (next: "wysiwyg" | "markdown") => {
    store.setMe({ ...store.me!, docs_editor_mode: next });
    return true;
  });
  const controller = {
    store,
    api,
    engine: { wiki: hub },
    isGuest: false,
    isAdmin: false,
    accountKey: "test",
    setError: (e: unknown) => errors.push(e),
    setNotice: () => {},
    copyPageLink: vi.fn(async () => {}),
    requestOpenPage: vi.fn(),
    attachmentMeta: async () => null,
    copyMessageText: async () => {},
    setDocsEditorMode,
    get docsEditorMode() {
      return docsEditorModeOf(store.me);
    },
  } as unknown as AppController;
  return { controller, store, errors, setDocsEditorMode };
}

async function openPage(body: string, options: { mode?: "wysiwyg" | "markdown" | null; api?: MergingWiki } = {}) {
  const api = options.api ?? new MergingWiki();
  const pageId = uid(501);
  api.add(item(pageId, { title: "マニュアル", my_level: "edit" }), body);
  const hub = new WikiHub({ api, store: new Store(), options: { debounceMs: 10, feedDelayMs: 5, resolveDelayMs: 5 } });
  hub.applyBootstrap({ change_seq: 1 });
  const lookupWikiPages = vi.fn(async () => [{ id: "0190a2b4-0000-7000-8000-0000000000c1", title: "設計メモ", icon: null, kind: "page" }]);
  const { controller, setDocsEditorMode } = controllerFor(hub, { wikiBacklinks: async () => [], lookupWikiPages }, options.mode ?? null);
  render(<DocPage controller={controller} pageId={pageId} onOpenPage={() => {}} onShare={() => {}} onTrash={() => {}} onAddChild={() => {}} />);
  await settle(60);
  return { api, hub, pageId, controller, setDocsEditorMode, lookupWikiPages };
}

/** 「編集」, then the 見たまま editor once its chunk is in. */
async function edit(): Promise<Editor> {
  fireEvent.click(screen.getByRole("tab", { name: "編集" }));
  const dom = await screen.findByRole("textbox", { name: "ページの本文" }, { timeout: 4000 });
  await settle();
  return (dom as unknown as { editor: Editor }).editor;
}

function type(editor: Editor, text: string) {
  act(() => {
    for (const ch of text) {
      const { from, to } = editor.state.selection;
      const handled = editor.view.someProp("handleTextInput", (f) => f(editor.view, from, to, ch, () => editor.state.tr.insertText(ch, from, to)));
      if (!handled) editor.view.dispatch(editor.state.tr.insertText(ch, from, to));
    }
  });
}

function caretAtEndOf(editor: Editor, index: number) {
  let pos = 0;
  for (let k = 0; k <= index; k++) pos += editor.state.doc.child(k).nodeSize;
  act(() => {
    editor.view.dispatch(editor.state.tr.setSelection(TextSelection.near(editor.state.doc.resolve(pos - 1), -1)));
  });
}

const saves = (api: FakeWiki) => api.calls.filter((call) => call.startsWith("save"));

const BODY = "# 手順\r\n\r\n最初の行\r\n*   古い書き方の項目\r\n1. 一\r\n1. 一\r\n\r\n::: callout ⚠️\r\n注意\r\n:::\r\n| a | b |\r\n|---|---|\r\n| 1 | 2 |";

describe("the 見たまま editor on a page", () => {
  it("is the default: 「編集」 opens it (its own chunk); opening and leaving saves nothing", async () => {
    const { api } = await openPage(BODY);
    const editor = await edit();
    expect(editor.state.doc.childCount).toBeGreaterThan(5);
    expect(document.querySelector("[data-editor-mode]")?.getAttribute("data-editor-mode")).toBe("wysiwyg");
    fireEvent.click(screen.getByRole("tab", { name: "閲覧" }));
    await settle(500);
    expect(saves(api)).toEqual([]);
    expect(api.bodies.get(uid(501))).toBe(BODY);
  });

  it("an edit is saved through the page's save loop with only that line changed", async () => {
    const { api } = await openPage(BODY);
    const editor = await edit();
    caretAtEndOf(editor, 2);
    type(editor, "（追記）");
    await settle(450);
    expect(saves(api)).toHaveLength(1);
    expect(api.bodies.get(uid(501))).toBe(BODY.replace("最初の行", "最初の行（追記）"));
    expect(document.querySelector("[data-save-state]")?.getAttribute("data-save-state")).toBe("saved");
  });

  it("switching to Markdown and back: the same bytes, the caret on its line, the setting saved, nothing saved by itself", async () => {
    const { api, setDocsEditorMode } = await openPage(BODY);
    const editor = await edit();
    caretAtEndOf(editor, 4); // 「1. 一」 on body line 4
    fireEvent.click(screen.getByRole("button", { name: "Markdown" }));
    await settle(60);
    expect(setDocsEditorMode).toHaveBeenCalledWith("markdown");
    const area = screen.getByRole("textbox", { name: /キャンバスの本文/ }) as HTMLTextAreaElement;
    expect(area.value).toBe(BODY.replace(/\r\n/g, "\n")); // a text area holds \n (the body is not changed by it)
    expect(area.value.slice(0, area.selectionStart).split(/\r\n|\r|\n/).length - 1).toBe(4);
    // A line further down, then back to 見たまま: the caret's block is that line's.
    const at = area.value.indexOf("注意");
    area.setSelectionRange(at, at);
    fireEvent.click(screen.getByRole("button", { name: "見たまま" }));
    const again = (await screen.findByRole("textbox", { name: "ページの本文" }, { timeout: 4000 })) as unknown as { editor: Editor };
    await settle();
    expect(again.editor.state.doc.child(again.editor.state.selection.$from.index(0)).type.name).toBe("callout");
    await settle(400);
    expect(saves(api)).toEqual([]);
  });

  it("a merged body from the server comes in: the other person's line appears, mine stays, no extra save", async () => {
    const api = new MergingWiki();
    await openPage(BODY, { api });
    const editor = await edit();
    api.mergeNext = (sent) => sent.replace("注意", "注意（花子が足した）");
    caretAtEndOf(editor, 0);
    type(editor, "！");
    await settle(450);
    expect(saves(api)).toHaveLength(1);
    const merged = BODY.replace("# 手順", "# 手順！").replace("注意", "注意（花子が足した）");
    expect(api.bodies.get(uid(501))).toBe(merged);
    const callout = editor.state.doc.content.content.find((node) => node.type.name === "callout")!;
    expect(callout.textContent).toBe("注意（花子が足した）");
    expect(editor.state.doc.child(0).textContent).toBe("手順！");
    await settle(300);
    expect(saves(api)).toHaveLength(1);
  });

  it("no merged body is put in while an IME composition is open (the loop keeps it for later)", async () => {
    const { hub, pageId } = await openPage(BODY);
    const editor = await edit();
    const held = hub.hold(pageId);
    expect(held.saver!.canReplace()).toBe(true);
    fireEvent.compositionStart(editor.view.dom);
    expect(editor.view.composing).toBe(true);
    expect(held.saver!.canReplace()).toBe(false);
    fireEvent.compositionEnd(editor.view.dom);
    await settle(80);
    expect(held.saver!.canReplace()).toBe(true);
    held.release();
  });
});

describe("the menus", () => {
  it("「/」 at a line's start: the block menu, filtered by what follows, Enter picks (a heading)", async () => {
    const { api } = await openPage("本文");
    const editor = await edit();
    caretAtEndOf(editor, 0);
    act(() => {
      editor.commands.splitBlock();
    });
    type(editor, "/");
    await settle();
    const menu = screen.getByRole("listbox", { name: "ブロックを追加" });
    expect(within(menu).getAllByRole("option").length).toBeGreaterThan(10);
    type(editor, "h2");
    await settle();
    expect(within(screen.getByRole("listbox")).getAllByRole("option")[0]!.textContent).toMatch(/見出し 2/);
    fireEvent.keyDown(editor.view.dom, { key: "Enter" });
    type(editor, "章");
    await settle(450);
    expect(api.bodies.get(uid(501))).toBe("本文\n## 章");
  });

  it("「/」 then 「コールアウト」: a callout with the caret inside", async () => {
    const { api } = await openPage("");
    const editor = await edit();
    type(editor, "/callout");
    await settle();
    fireEvent.keyDown(editor.view.dom, { key: "Enter" });
    type(editor, "大事");
    await settle(450);
    expect(api.bodies.get(uid(501))).toBe("::: callout 💡\n大事\n:::");
  });

  it("「[[」: pages to link; the choice is a chip written as `[title](page:id)`", async () => {
    const { api, lookupWikiPages } = await openPage("");
    const editor = await edit();
    type(editor, "参照 [[設計");
    await settle(250);
    expect(lookupWikiPages).toHaveBeenCalledWith("設計", 8);
    const menu = screen.getByRole("listbox", { name: "リンクするページ" });
    expect(within(menu).getByText("設計メモ")).toBeTruthy();
    fireEvent.keyDown(editor.view.dom, { key: "Enter" });
    await settle(450);
    expect(api.bodies.get(uid(501))).toBe("参照 [設計メモ](page:0190a2b4-0000-7000-8000-0000000000c1) ");
  });

  it("「@」: people to mention; the choice is written as `<@id>`", async () => {
    const { api } = await openPage("");
    const editor = await edit();
    type(editor, "確認 @han");
    await settle();
    expect(within(screen.getByRole("listbox")).getByText("@hanako")).toBeTruthy();
    fireEvent.keyDown(editor.view.dom, { key: "Enter" });
    await settle(450);
    expect(api.bodies.get(uid(501))).toBe(`確認 <@${HANAKO}> `);
    expect(editor.view.dom.textContent).toContain("@花子");
  });

  it("Escape closes a menu without touching the text", async () => {
    await openPage("");
    const editor = await edit();
    type(editor, "/");
    await settle();
    expect(screen.getByRole("listbox")).toBeTruthy();
    fireEvent.keyDown(editor.view.dom, { key: "Escape" });
    await settle();
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(editor.state.doc.textContent).toBe("/");
  });
});

describe("M151: ⌘K", () => {
  it("finds pages: the selected text becomes a link to the page chosen; the app's ⌘K does not see the key", async () => {
    const { api, lookupWikiPages } = await openPage("設計を見る");
    const editor = await edit();
    const outside = vi.fn();
    window.addEventListener("keydown", outside);
    act(() => {
      editor.view.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, 1, 3)));
    });
    fireEvent.keyDown(editor.view.dom, { key: "k", ctrlKey: true }); // jsdom is not a Mac: Mod is Ctrl
    expect(outside).not.toHaveBeenCalled();
    window.removeEventListener("keydown", outside);
    const field = screen.getByRole("combobox", { name: "リンク先（URL またはページ）" });
    fireEvent.change(field, { target: { value: "設計" } });
    await settle(250);
    expect(lookupWikiPages).toHaveBeenCalledWith("設計", 8);
    expect(within(screen.getByRole("listbox", { name: "リンクするページ" })).getByText("設計メモ")).toBeTruthy();
    fireEvent.submit(field.closest("form")!);
    await settle(450);
    expect(api.bodies.get(uid(501))).toBe("[設計](page:0190a2b4-0000-7000-8000-0000000000c1)を見る");
  });

  it("with nothing selected a page is its chip with its title; a URL is a link as before", async () => {
    const { api } = await openPage("");
    const editor = await edit();
    fireEvent.keyDown(editor.view.dom, { key: "k", ctrlKey: true });
    await settle(250);
    fireEvent.submit(screen.getByRole("combobox").closest("form")!);
    type(editor, "と");
    fireEvent.keyDown(editor.view.dom, { key: "k", ctrlKey: true });
    const field = screen.getByRole("combobox");
    fireEvent.change(field, { target: { value: "https://example.com/x" } });
    fireEvent.submit(field.closest("form")!);
    await settle(450);
    expect(api.bodies.get(uid(501))).toBe("[設計メモ](page:0190a2b4-0000-7000-8000-0000000000c1) とhttps://example.com/x");
  });
});

describe("M151: inline math", () => {
  it("a click opens its TeX; Enter saves the change; emptied, the formula goes; TeX KaTeX cannot read shows in the error colour", async () => {
    const { api } = await openPage("式 $x$ です\n壊れた $\\frac{$ 式");
    await edit();
    await settle(200);
    const broken = document.querySelectorAll("[data-inline-math]")[1]!;
    expect(broken.querySelector("[data-math='error']")?.textContent).toBe("\\frac{");
    fireEvent.click(document.querySelector("[data-inline-math]")!);
    const field = screen.getByRole("textbox", { name: "数式（TeX）" }) as HTMLInputElement;
    expect(field.value).toBe("x");
    fireEvent.change(field, { target: { value: "y^2" } });
    fireEvent.submit(field.closest("form")!);
    await settle(450);
    expect(api.bodies.get(uid(501))).toBe("式 $y^2$ です\n壊れた $\\frac{$ 式");
    fireEvent.click(document.querySelector("[data-inline-math]")!);
    const again = screen.getByRole("textbox", { name: "数式（TeX）" }) as HTMLInputElement;
    fireEvent.change(again, { target: { value: "" } });
    fireEvent.keyDown(again, { key: "Escape" });
    await settle(450);
    expect(api.bodies.get(uid(501))).toBe("式  です\n壊れた $\\frac{$ 式");
  });
});

describe("the setting and pasting", () => {
  it("Settings: 見たまま / Markdown, 見たまま when never chosen; a server without it shows nothing", () => {
    const store = new Store();
    store.setMe({ id: ME, username: "me", display_name: "わたし", role: "member", docs_editor_mode: null } as unknown as UserMe);
    const setDocsEditorMode = vi.fn(async () => true);
    const controller = { store, setDocsEditorMode } as unknown as AppController;
    const { rerender } = render(<DocsEditorModeSettings controller={controller} />);
    expect(screen.getByRole("button", { name: /見たまま/ }).getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: /^Markdown/ }));
    expect(setDocsEditorMode).toHaveBeenCalledWith("markdown");
    store.setMe({ id: ME, username: "me", display_name: "わたし", role: "member" } as unknown as UserMe);
    rerender(<DocsEditorModeSettings controller={controller} />);
    expect(screen.queryByRole("button", { name: /見たまま/ })).toBeNull();
  });

  it("HTML lists pasted (nested, numbered, checkboxes) become flat list lines", () => {
    const html = pageHtmlFromPaste("<ul><li><p>一 <b>太</b></p><ul><li>二</li></ul></li></ul><ol><li>三</li></ol><ul><li><input type=\"checkbox\" checked>済</li></ul>");
    const doc = new DOMParser().parseFromString(html, "text/html");
    const lines = [...doc.querySelectorAll("[data-list-line]")].map((el) => [el.getAttribute("data-kind"), el.getAttribute("data-level"), el.getAttribute("data-checked"), el.innerHTML]);
    expect(lines).toEqual([
      ["bullet", "0", null, "一 <b>太</b>"],
      ["bullet", "1", null, "二"],
      ["ordered", "0", null, "三"],
      ["task", "0", "true", "済"],
    ]);
  });
});

describe("M154: the title and the body, the block selection on the page", () => {
  const title = () => screen.getByRole("textbox", { name: "ページの題名" }) as HTMLInputElement;

  it("Enter in the title puts the caret at the start of the body; ↑ on the body's first line goes back to the title's end; nothing is saved", async () => {
    const { api } = await openPage(BODY);
    const editor = await edit();
    caretAtEndOf(editor, 2);
    const input = title();
    act(() => input.focus());
    fireEvent.keyDown(input, { key: "Enter" });
    await settle(60);
    expect(editor.state.selection.from).toBe(1);
    expect(document.activeElement).toBe(editor.view.dom);
    fireEvent.keyDown(editor.view.dom, { key: "ArrowUp" });
    expect(document.activeElement).toBe(input);
    expect(input.selectionStart).toBe(input.value.length);
    // ← at the very start too; ↑ further down does not leave the body.
    act(() => editor.commands.focus(1));
    fireEvent.keyDown(editor.view.dom, { key: "ArrowLeft" });
    expect(document.activeElement).toBe(input);
    act(() => editor.view.focus());
    caretAtEndOf(editor, 2);
    expect(document.activeElement).toBe(editor.view.dom);
    fireEvent.keyDown(editor.view.dom, { key: "ArrowUp" });
    expect(document.activeElement).toBe(editor.view.dom);
    await settle(450);
    expect(saves(api)).toEqual([]);
  });

  it("Enter in the title while reading opens the editor with the caret at the start of the body", async () => {
    const { api } = await openPage(BODY);
    fireEvent.keyDown(title(), { key: "Enter" });
    const dom = await screen.findByRole("textbox", { name: "ページの本文" }, { timeout: 4000 });
    await settle(60);
    const editor = (dom as unknown as { editor: Editor }).editor;
    expect(editor.state.selection.from).toBe(1);
    await settle(450);
    expect(saves(api)).toEqual([]);
  });

  it("Esc, the arrows and ⌘A select blocks without writing anything; leaving the editor clears the selection", async () => {
    const { api } = await openPage(BODY);
    const editor = await edit();
    caretAtEndOf(editor, 2);
    fireEvent.keyDown(editor.view.dom, { key: "Escape" });
    expect(editor.state.selection).toBeInstanceOf(BlockSelection);
    expect(editor.view.dom.querySelectorAll(".pe-selected")).toHaveLength(1);
    fireEvent.keyDown(editor.view.dom, { key: "ArrowDown" });
    fireEvent.keyDown(editor.view.dom, { key: "ArrowDown", shiftKey: true });
    expect(editor.view.dom.querySelectorAll(".pe-selected")).toHaveLength(2);
    fireEvent.keyDown(editor.view.dom, { key: "a", ctrlKey: true });
    expect((editor.state.selection as BlockSelection).to).toBe(editor.state.doc.content.size);
    await settle(450);
    expect(saves(api)).toEqual([]);
    expect(api.bodies.get(uid(501))).toBe(BODY);
    fireEvent.blur(editor.view.dom);
    expect(editor.state.selection).toBeInstanceOf(TextSelection);
    expect(editor.view.dom.querySelectorAll(".pe-selected")).toHaveLength(0);
    await settle(450);
    expect(saves(api)).toEqual([]);
  });

  it("Delete on selected blocks saves the body with just those lines gone; Backspace at the very start changes nothing", async () => {
    const { api } = await openPage(BODY);
    const editor = await edit();
    caretAtEndOf(editor, 3); // 「*   古い書き方の項目」
    fireEvent.keyDown(editor.view.dom, { key: "Escape" });
    fireEvent.keyDown(editor.view.dom, { key: "Delete" });
    await settle(450);
    expect(saves(api)).toHaveLength(1);
    expect(api.bodies.get(uid(501))).toBe(BODY.replace("*   古い書き方の項目\r\n", ""));
    act(() => editor.commands.setTextSelection(1));
    fireEvent.keyDown(editor.view.dom, { key: "Backspace" }); // the heading becomes text (as before)
    await settle(450);
    expect(saves(api)).toHaveLength(2);
    expect(editor.state.doc.child(0).type.name).toBe("paragraph");
    const afterwards = BODY.replace("*   古い書き方の項目\r\n", "").replace("# 手順", "手順");
    expect(api.bodies.get(uid(501))).toBe(afterwards);
    fireEvent.keyDown(editor.view.dom, { key: "Backspace" }); // at the very start of the page: nothing
    await settle(450);
    expect(saves(api)).toHaveLength(2);
    expect(editor.state.doc.childCount).toBe(8);
    expect(api.bodies.get(uid(501))).toBe(afterwards);
  });

  it("the shortcuts dialog lists the editor's keys under 「ドキュメントの編集」", () => {
    render(<ShortcutsDialog onClose={() => {}} />);
    expect(screen.getByText("ドキュメントの編集")).toBeTruthy();
    expect(screen.getByText("ブロックを選択（囲みの中ではもう一度で囲み、さらにもう一度で解除）")).toBeTruthy();
    expect(screen.getByText("Ctrl/⌘ + D （ブロックを選択中）")).toBeTruthy();
    expect(screen.getByText("本文の先頭へ")).toBeTruthy();
    expect(screen.getByText("ブロックの種類を変える（変換のメニュー）")).toBeTruthy();
    expect(screen.getByText("Enter と同じ（新しいブロック。ブロックの中の改行は無い）")).toBeTruthy();
  });
});

describe("M155: the floating toolbar, ⌘/, the `/` menu's sections, `@` pages, the editing look (WIKI.md §30.2)", () => {
  const TOOLBAR = "選択範囲の書式";
  /** Text `from`–`to` (offsets in the text) of the top-level block `index` selected. */
  const selectIn = (editor: Editor, index: number, from: number, to: number) => {
    let pos = 0;
    for (let k = 0; k < index; k++) pos += editor.state.doc.child(k).nodeSize;
    act(() => {
      editor.view.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, pos + 1 + from, pos + 1 + to)));
    });
  };

  it("text selected shows the toolbar; bold from it saves only that line; Esc hides it and the next Esc selects the block; nothing on a caret or a block selection", async () => {
    const { api } = await openPage(BODY);
    const editor = await edit();
    expect(screen.queryByRole("toolbar", { name: TOOLBAR })).toBeNull();
    selectIn(editor, 2, 0, 4); // 最初の行
    const toolbar = screen.getByRole("toolbar", { name: TOOLBAR });
    expect(toolbar.getAttribute("data-selection-toolbar")).toBe("block");
    expect(within(toolbar).getByRole("button", { name: "変換" })).toBeTruthy();
    const bold = () => within(screen.getByRole("toolbar", { name: TOOLBAR })).getByRole("button", { name: "太字（Ctrl+B）" });
    expect(bold().getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(bold());
    await settle(450);
    expect(api.bodies.get(uid(501))).toBe(BODY.replace("最初の行", "**最初の行**"));
    expect(bold().getAttribute("aria-pressed")).toBe("true");
    expect([editor.state.selection.from, editor.state.selection.to]).toEqual([editor.state.selection.from, editor.state.selection.from + 4]);
    fireEvent.keyDown(editor.view.dom, { key: "Escape" });
    expect(screen.queryByRole("toolbar", { name: TOOLBAR })).toBeNull();
    expect(editor.state.selection).toBeInstanceOf(TextSelection);
    fireEvent.keyDown(editor.view.dom, { key: "Escape" });
    expect(editor.state.selection).toBeInstanceOf(BlockSelection);
    expect(screen.queryByRole("toolbar", { name: TOOLBAR })).toBeNull();
    act(() => editor.commands.setTextSelection(1));
    expect(screen.queryByRole("toolbar", { name: TOOLBAR })).toBeNull();
    await settle(450);
    expect(saves(api)).toHaveLength(1);
  });

  it("in a table's cell the toolbar has the marks only; 「変換 ▾」 lists the kinds and 見出し 2 turns the line, keeping the selection", async () => {
    const { api } = await openPage(BODY);
    const editor = await edit();
    const table = editor.state.doc.childCount - 1;
    selectIn(editor, table, 2, 3); // the cell 「a」: the row and the cell open before its text
    const inCell = screen.getByRole("toolbar", { name: TOOLBAR });
    expect(inCell.getAttribute("data-selection-toolbar")).toBe("marks");
    expect(within(inCell).queryByRole("button", { name: "変換" })).toBeNull();
    expect(within(inCell).getByRole("button", { name: "太字（Ctrl+B）" })).toBeTruthy();
    selectIn(editor, 2, 0, 2);
    const from = editor.state.selection.from;
    fireEvent.click(within(screen.getByRole("toolbar", { name: TOOLBAR })).getByRole("button", { name: "変換" }));
    const menu = await screen.findByRole("menu", { name: "ブロックを変換" });
    expect(within(menu).getByRole("menuitemradio", { name: "テキスト" }).getAttribute("aria-checked")).toBe("true");
    fireEvent.click(within(menu).getByRole("menuitemradio", { name: "見出し 2" }));
    await settle(450);
    expect(api.bodies.get(uid(501))).toBe(BODY.replace("最初の行", "## 最初の行"));
    expect([editor.state.selection.from, editor.state.selection.to]).toEqual([from, from + 2]);
    expect(screen.queryByRole("menu", { name: "ブロックを変換" })).toBeNull();
  });

  it("⌘/ opens the 「変換」 list for the caret's line; 見出し 3 is saved with only that line changed; a block selection of two lines becomes one callout", async () => {
    const { api } = await openPage(BODY);
    const editor = await edit();
    caretAtEndOf(editor, 2);
    fireEvent.keyDown(editor.view.dom, { key: "/", ctrlKey: true });
    const menu = await screen.findByRole("menu", { name: "ブロックを変換" });
    expect(within(menu).getByRole("menuitemradio", { name: "テキスト" }).getAttribute("aria-checked")).toBe("true");
    fireEvent.click(within(menu).getByRole("menuitemradio", { name: "見出し 3" }));
    await settle(450);
    expect(api.bodies.get(uid(501))).toBe(BODY.replace("最初の行", "### 最初の行"));
    expect(editor.state.doc.child(2).type.name).toBe("heading");
    fireEvent.keyDown(editor.view.dom, { key: "Escape" });
    fireEvent.keyDown(editor.view.dom, { key: "ArrowDown", shiftKey: true });
    expect(editor.state.selection).toBeInstanceOf(BlockSelection);
    fireEvent.keyDown(editor.view.dom, { key: "/", ctrlKey: true });
    fireEvent.click(within(await screen.findByRole("menu", { name: "ブロックを変換" })).getByRole("menuitemradio", { name: "コールアウト" }));
    await settle(450);
    // The lines inside keep their own line endings (the heading's, the untouched item's bytes); the new opener is LF.
    expect(api.bodies.get(uid(501))).toBe(BODY.replace("最初の行\r\n*   古い書き方の項目\r\n", "::: callout 💡\n### 最初の行\r\n*   古い書き方の項目\r\n:::\n"));
  });

  it("the `/` menu: sections with a line of help, 「todo」 filters to the checklist, the pick is remembered as 「最近使ったもの」 on this device", async () => {
    const { api } = await openPage("本文");
    const editor = await edit();
    caretAtEndOf(editor, 0);
    act(() => {
      editor.commands.splitBlock();
    });
    type(editor, "/");
    await settle();
    const menu = screen.getByRole("listbox", { name: "ブロックを追加" });
    expect(within(menu).getAllByRole("group").map((group) => group.getAttribute("aria-label"))).toEqual(["基本", "リスト", "メディア", "埋め込み", "高度"]);
    expect(within(menu).getByText("チェックボックスで進み具合を追う")).toBeTruthy();
    expect(within(menu).getAllByRole("option")).toHaveLength(18);
    type(editor, "todo");
    await settle();
    const options = within(screen.getByRole("listbox")).getAllByRole("option");
    expect(options).toHaveLength(1);
    expect(options[0]!.textContent).toContain("チェックリスト");
    fireEvent.keyDown(editor.view.dom, { key: "Enter" });
    type(editor, "やる");
    await settle(450);
    expect(api.bodies.get(uid(501))).toBe("本文\n- [ ] やる");
    expect(JSON.parse(localStorage.getItem("taylis.docs.slashRecents")!)).toEqual(["tasks"]);
    fireEvent.keyDown(editor.view.dom, { key: "Enter" });
    type(editor, "/");
    await settle();
    const again = within(screen.getByRole("listbox", { name: "ブロックを追加" })).getAllByRole("group");
    expect(again[0]!.getAttribute("aria-label")).toBe("最近使ったもの");
    expect(within(again[0]!).getAllByRole("option")).toHaveLength(1);
    expect(within(again[0]!).getAllByRole("option")[0]!.textContent).toContain("チェックリスト");
    expect(within(again[0]!).getAllByRole("option")[0]!.getAttribute("aria-selected")).toBe("true");
  });

  it("`@` offers pages after the people: a page chosen is the chip `[[` makes; people stay first", async () => {
    const { api, lookupWikiPages } = await openPage("");
    const editor = await edit();
    type(editor, "確認 @設");
    await settle(250);
    expect(lookupWikiPages).toHaveBeenCalledWith("設", 8);
    const menu = screen.getByRole("listbox", { name: "メンションの候補" });
    expect(within(menu).getByText("ページ")).toBeTruthy();
    expect(within(menu).getByText("設計メモ")).toBeTruthy();
    fireEvent.keyDown(editor.view.dom, { key: "Enter" });
    await settle(450);
    expect(api.bodies.get(uid(501))).toBe("確認 [設計メモ](page:0190a2b4-0000-7000-8000-0000000000c1) ");
    type(editor, "@h");
    await settle(250);
    const rows = within(screen.getByRole("listbox", { name: "メンションの候補" })).getAllByRole("option");
    expect(rows.map((row) => row.textContent)).toEqual([expect.stringContaining("@hanako"), expect.stringContaining("設計メモ")]);
  });

  it("the editing look is the reading look: blank lines, headings, lists, checklists, rules, callouts, quotes, tables and toggles have the reader's margins", async () => {
    // The editor's rules from styles.css go into the document: jsdom hands back what they declare. The reader's Tailwind
    // classes are read as the scale they name (0.25rem a step), so the two sides are compared in pixels.
    const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "src", "styles.css"), "utf8");
    const style = document.createElement("style");
    style.textContent = (css.match(/\.page-editor[^{}]*\{[^}]*\}/g) ?? []).join("\n");
    document.head.append(style);
    const px = (value: string) => (value.endsWith("rem") ? parseFloat(value) * 16 : parseFloat(value) || 0);
    const tw = (el: Element | null, prefix: string) => {
      const found = [...(el?.classList ?? [])].map((c) => /^(m[tby]|h|p[xy]|pl|gap)-(\d+(?:\.\d+)?)$/.exec(c)).find((m) => m && m[1] === prefix);
      return found ? Number(found[2]) * 4 : 0;
    };
    const PARITY = "前\n# 見出し\n\n段落\n\n\n次の段落\n- 項目\n- 項目 2\n\n- [ ] やる\n\n---\n\n::: callout 💡\n中\n:::\n> 引用\n| a |\n| --- |\n| 1 |\n::: toggle 題\n中\n:::";
    await openPage(PARITY);
    const reading = document.querySelector(".canvas-body")!;
    const read = {
      heading: reading.querySelector("[id^=canvas-h-]"),
      gap: reading.querySelector("p.mt-2\\.5"),
      list: reading.querySelector("ul.md-ul"),
      tasks: reading.querySelector("ul.list-none"),
      rule: reading.querySelector("hr"),
      callout: reading.querySelector(".callout"),
      quote: reading.querySelector("blockquote"),
      table: reading.querySelector("table")?.parentElement ?? null,
      toggle: reading.querySelector("details"),
    };
    const editor = await edit();
    const dom = editor.view.dom;
    const cs = (selector: string) => getComputedStyle(dom.querySelector(selector)!);
    // The six blank lines: after the heading (before text) and the two between paragraphs are the reader's `mt-2.5`
    // gap, a margin (the second of the run adds nothing: the margins collapse); the ones between a list and a
    // checklist, a checklist and a rule, a rule and a callout are the reader's `h-2.5` box.
    const blanks = [...dom.querySelectorAll("p")].filter((p) => p.textContent === "");
    expect(blanks).toHaveLength(6);
    const gap = tw(read.gap, "mt");
    const box = tw(reading.querySelector("div.h-2\\.5"), "h");
    expect([gap, box]).toEqual([10, 10]);
    expect(blanks.map((p) => px(getComputedStyle(p).marginTop))).toEqual([gap, gap, 0, 0, 0, 0]);
    expect(blanks.map((p) => px(getComputedStyle(p).height))).toEqual([0, 0, 0, box, box, box]);
    expect(px(cs("h1").marginTop)).toBe(tw(read.heading, "mt"));
    expect(px(cs("h1").marginBottom)).toBe(tw(read.heading, "mb"));
    expect(cs("h1").lineHeight).toBe("2rem"); // the reader's text-2xl keeps its own line height (measured in Chrome: 32px)
    expect(px(cs("[data-list-line]").marginTop)).toBe(tw(read.list, "my"));
    expect(px(cs("[data-list-line][data-kind='task']").marginTop)).toBe(tw(read.tasks, "my"));
    expect(px(cs(".pe-hr").marginTop)).toBe(tw(read.rule, "my"));
    expect(px(cs(".pe-callout").marginTop)).toBe(tw(read.callout, "my"));
    expect(px(cs(".pe-callout").paddingTop)).toBe(tw(read.callout, "py"));
    expect(px(cs(".pe-callout").paddingLeft)).toBe(tw(read.callout, "px"));
    expect(px(cs("blockquote").marginTop)).toBe(tw(read.quote, "my"));
    expect(px(cs("blockquote").paddingLeft)).toBe(tw(read.quote, "pl"));
    expect(px(cs(".pe-table").marginTop)).toBe(tw(read.table, "my"));
    expect(px(cs(".pe-toggle").marginTop)).toBe(tw(read.toggle, "my"));
    expect(getComputedStyle(dom).lineHeight).toBe("1.75rem"); // the reader's leading-7
    expect(reading.classList.contains("leading-7")).toBe(true);
    style.remove();
  });
});
