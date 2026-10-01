// @vitest-environment jsdom
/**
 * M57 (CANVAS.md §17): the canvas editor's 「表」 and the table editor dialog — a new table put in after the caret's
 * line, the table at the caret opened, the cells, Tab and Enter, the row and column menus, 「完了」 writing the table
 * back as one edit, 「キャンセル」 leaving the text as it was, and a table someone changed meanwhile left alone.
 */
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AppController } from "../src/state/app";
import type { CanvasSaver } from "../src/sync/canvasSave";
import { Store } from "../src/sync/store";
import { CanvasEditor } from "../src/ui/CanvasEditor";

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  HTMLElement.prototype.scrollIntoView = () => {};
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  delete (document as { execCommand?: unknown }).execCommand;
});

/** The save loop as the editor sees it: what it was given, and someone else's merged text coming in. */
function fakeSaver(body: string) {
  const listeners = new Set<() => void>();
  const saver = {
    text: body,
    textRevision: 0,
    edits: [] as string[],
    canReplace: () => true,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    edit(text: string) {
      saver.text = text;
      saver.edits.push(text);
    },
    flush: async () => {},
    compositionEnded() {},
    /** Someone else's edits merged in (the loop replaces the text). */
    replace(text: string) {
      saver.text = text;
      saver.textRevision += 1;
      listeners.forEach((listener) => listener());
    },
  };
  return saver;
}

function setup(body: string) {
  const saver = fakeSaver(body);
  const controller = { store: new Store(), setError: vi.fn(), setNotice: vi.fn(), uploadCanvasImage: vi.fn() } as unknown as AppController & { setNotice: ReturnType<typeof vi.fn> };
  render(<CanvasEditor controller={controller} saver={saver as unknown as CanvasSaver} />);
  const area = screen.getByRole("textbox", { name: /キャンバスの本文/ }) as HTMLTextAreaElement;
  return { saver, controller, area };
}

/** The dialog closes and hands the focus back (a timer), the write-back's caret comes back (a frame). */
const settle = (ms = 30) => act(async () => { await new Promise((resolve) => setTimeout(resolve, ms)); });

/** Puts the caret at the start of line `line` and presses 「表」. */
async function openAt(area: HTMLTextAreaElement, line: number) {
  const at = area.value.split("\n").slice(0, line).reduce((n, l) => n + l.length + 1, 0);
  area.focus();
  area.setSelectionRange(at, at);
  fireEvent.click(screen.getByRole("button", { name: "表" }));
  await settle(0);
  return screen.getByRole("dialog");
}

const cell = (dialog: HTMLElement, name: string) => within(dialog).getByRole("textbox", { name }) as HTMLInputElement;
const type = (input: HTMLInputElement, value: string) => fireEvent.change(input, { target: { value } });
async function menu(dialog: HTMLElement, name: string, item: string) {
  fireEvent.keyDown(within(dialog).getByRole("button", { name }), { key: "Enter" });
  await settle(0);
  fireEvent.click(screen.getByRole("menuitem", { name: item }));
  await settle(0);
}

/** execCommand as a browser runs it on a text area: the selection replaced, then an `input` event. */
function browserEditing() {
  const exec = vi.fn((command: string, _ui?: boolean, value?: string) => {
    const el = document.activeElement as HTMLTextAreaElement;
    el.setRangeText(command === "delete" ? "" : value ?? "", el.selectionStart, el.selectionEnd, "end");
    el.dispatchEvent(new Event("input", { bubbles: true }));
    return true;
  });
  Object.defineProperty(document, "execCommand", { value: exec, configurable: true, writable: true });
  return exec;
}

const NEW = "| 列1 | 列2 | 列3 |\n| --- | --- | --- |\n|  |  |  |\n|  |  |  |";

describe("「表」 in the canvas editor", () => {
  it("opens a new 3 × 2 table; 「完了」 puts it after the caret's line (blank lines around it) as an edit like typing", async () => {
    const { saver, area } = setup("# 学会\n本文");
    const dialog = await openAt(area, 0);
    expect(area.value).toBe("# 学会\n本文"); // nothing goes in before 「完了」
    expect(saver.edits).toEqual([]);
    expect(within(dialog).getByRole("heading", { name: "表を追加" })).toBeTruthy();
    expect(["見出し 1", "見出し 2", "見出し 3"].map((name) => cell(dialog, name).value)).toEqual(["列1", "列2", "列3"]);
    expect(document.activeElement).toBe(cell(dialog, "見出し 1")); // focused and selected: typing replaces 「列1」
    expect(cell(dialog, "3 行目 3 列").value).toBe("");

    type(cell(dialog, "見出し 1"), "名前");
    type(cell(dialog, "見出し 2"), "締切");
    type(cell(dialog, "2 行目 1 列"), "予稿");
    type(cell(dialog, "2 行目 2 列"), "10/3");
    type(cell(dialog, "3 行目 1 列"), "a|b");
    fireEvent.click(within(dialog).getByRole("button", { name: "完了" }));
    await settle();
    expect(screen.queryByRole("dialog")).toBeNull();
    const table = "| 名前 | 締切 | 列3 |\n| --- | --- | --- |\n| 予稿 | 10/3 |  |\n| a\\|b |  |  |";
    expect(area.value).toBe(`# 学会\n\n${table}\n\n本文`);
    expect(saver.text).toBe(area.value);
    expect(area.selectionStart).toBe("# 学会\n\n".length); // the caret at the table, so 「表」 opens it again
  });

  it("opens the table at the caret, with its cells and alignment; nothing edited → 「完了」 leaves the text as it is", async () => {
    const body = "前\n\n|名前|締切|\n|:--|--:|\n|予稿|10/3|\n\n後";
    const { saver, area } = setup(body);
    const dialog = await openAt(area, 4);
    expect(within(dialog).getByRole("heading", { name: "表を編集" })).toBeTruthy();
    expect(cell(dialog, "見出し 2").value).toBe("締切");
    expect(cell(dialog, "2 行目 1 列").value).toBe("予稿");
    expect(cell(dialog, "2 行目 2 列").className).toContain("text-right");
    fireEvent.click(within(dialog).getByRole("button", { name: "完了" }));
    await settle();
    expect(area.value).toBe(body); // not even tidied
    expect(saver.edits).toEqual([]);
  });

  it("Tab and Shift+Tab move between the cells; Enter in the last cell adds a row", async () => {
    const { area } = setup("| A | B |\n| --- | --- |\n| 1 | 2 |");
    const dialog = await openAt(area, 0);
    cell(dialog, "見出し 1").focus();
    fireEvent.keyDown(cell(dialog, "見出し 1"), { key: "Tab" });
    expect(document.activeElement).toBe(cell(dialog, "見出し 2"));
    fireEvent.keyDown(cell(dialog, "見出し 2"), { key: "Tab" });
    expect(document.activeElement).toBe(cell(dialog, "2 行目 1 列"));
    fireEvent.keyDown(cell(dialog, "2 行目 1 列"), { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(cell(dialog, "見出し 2"));
    // An IME's Enter (confirming a word) is the IME's.
    fireEvent.keyDown(cell(dialog, "2 行目 2 列"), { key: "Enter", keyCode: 229 });
    expect(within(dialog).queryByRole("textbox", { name: "3 行目 1 列" })).toBeNull();
    fireEvent.keyDown(cell(dialog, "2 行目 2 列"), { key: "Enter" });
    await settle(0);
    expect(document.activeElement).toBe(cell(dialog, "3 行目 1 列"));
    type(cell(dialog, "3 行目 1 列"), "3");
    fireEvent.keyDown(cell(dialog, "3 行目 1 列"), { key: "Enter", ctrlKey: true }); // Ctrl+Enter: 完了
    await settle();
    expect(area.value).toBe("| A | B |\n| --- | --- |\n| 1 | 2 |\n| 3 |  |");
  });

  it("the row and column menus: add, move and delete rows, add and delete columns, alignment", async () => {
    const { area } = setup("| A | B |\n| --- | --- |\n| 1 | 2 |\n| 3 | 4 |");
    const dialog = await openAt(area, 1);
    await menu(dialog, "2 行目のメニュー", "下に行を追加");
    expect(document.activeElement).toBe(cell(dialog, "3 行目 1 列"));
    type(cell(dialog, "3 行目 1 列"), "x");
    await menu(dialog, "3 行目のメニュー", "上へ");
    expect(cell(dialog, "2 行目 1 列").value).toBe("x");
    await menu(dialog, "4 行目のメニュー", "行を削除");
    await menu(dialog, "1 列目のメニュー", "右に列を追加");
    expect(document.activeElement).toBe(cell(dialog, "見出し 2"));
    expect(cell(dialog, "見出し 2").value).toBe("列3");
    await menu(dialog, "3 列目のメニュー", "列を削除");
    // 揃え: 中央 on column 2.
    fireEvent.keyDown(within(dialog).getByRole("button", { name: "2 列目のメニュー" }), { key: "Enter" });
    await settle(0);
    expect(screen.getByRole("menuitemradio", { name: "なし" }).getAttribute("aria-checked")).toBe("true");
    fireEvent.click(screen.getByRole("menuitemradio", { name: "中央" }));
    await settle(0);
    fireEvent.click(within(dialog).getByRole("button", { name: "完了" }));
    await settle();
    expect(area.value).toBe("| A | 列3 |\n| --- | :---: |\n| x |  |\n| 1 |  |");
  });

  it("the last column cannot be deleted; Shift+F10 in a cell opens its row menu", async () => {
    const { area } = setup("| 見出しだけ |\n| --- |");
    const dialog = await openAt(area, 0);
    fireEvent.keyDown(within(dialog).getByRole("button", { name: "1 列目のメニュー" }), { key: "Enter" });
    await settle(0);
    expect(screen.getByRole("menuitem", { name: "列を削除" }).getAttribute("aria-disabled")).toBe("true");
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
    await settle(0);
    fireEvent.click(within(dialog).getByRole("button", { name: /行を追加/ }));
    await settle(0);
    expect(document.activeElement).toBe(cell(dialog, "2 行目 1 列"));
    fireEvent.keyDown(cell(dialog, "2 行目 1 列"), { key: "F10", shiftKey: true });
    await settle(0);
    expect(within(screen.getByRole("menu")).getByRole("menuitem", { name: "行を削除" })).toBeTruthy();
  });
});

describe("「キャンセル」", () => {
  it("a new table: nothing goes in", async () => {
    const { saver, area } = setup("一行目\n二行目");
    const dialog = await openAt(area, 0);
    type(cell(dialog, "見出し 1"), "名前");
    fireEvent.click(within(dialog).getByRole("button", { name: "キャンセル" }));
    await settle();
    expect(area.value).toBe("一行目\n二行目");
    expect(saver.edits).toEqual([]);
  });

  it("changes nothing in a table that was there (Esc too)", async () => {
    const body = "| A | B |\n| --- | --- |\n| 1 | 2 |";
    const { saver, area } = setup(body);
    let dialog = await openAt(area, 2);
    type(cell(dialog, "2 行目 1 列"), "変更");
    fireEvent.click(within(dialog).getByRole("button", { name: "キャンセル" }));
    await settle();
    dialog = await openAt(area, 2);
    type(cell(dialog, "2 行目 1 列"), "変更");
    fireEvent.keyDown(cell(dialog, "2 行目 1 列"), { key: "Escape" });
    await settle();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(area.value).toBe(body);
    expect(saver.edits).toEqual([]);
  });
});

describe("someone else's edits while the dialog is open", () => {
  it("lines merged in above: the table is found where it moved and written back there", async () => {
    const { saver, area } = setup("# 学会\n\n| A | B |\n| --- | --- |\n| 1 | 2 |");
    const dialog = await openAt(area, 3);
    await act(async () => saver.replace("# 学会\n追記\n\n| A | B |\n| --- | --- |\n| 1 | 2 |"));
    type(cell(dialog, "2 行目 2 列"), "二");
    fireEvent.click(within(dialog).getByRole("button", { name: "完了" }));
    await settle();
    expect(area.value).toBe("# 学会\n追記\n\n| A | B |\n| --- | --- |\n| 1 | 二 |");
  });

  it("a new table goes after the caret's line where that line is now", async () => {
    const { saver, area } = setup("見出し\n本文");
    const dialog = await openAt(area, 0);
    await act(async () => saver.replace("追記\n見出し\n本文"));
    fireEvent.click(within(dialog).getByRole("button", { name: "完了" }));
    await settle();
    expect(area.value).toBe(`追記\n見出し\n\n${NEW}\n\n本文`);
  });

  it("the table itself changed: mine goes in below theirs as a new table, and a notice says so", async () => {
    const { saver, controller, area } = setup("| A | B |\n| --- | --- |\n| 1 | 2 |\n\n後");
    const dialog = await openAt(area, 0);
    await act(async () => saver.replace("| A | B |\n| --- | --- |\n| 1 | 彼 |\n\n後"));
    type(cell(dialog, "2 行目 1 列"), "私");
    fireEvent.click(within(dialog).getByRole("button", { name: "完了" }));
    await settle();
    expect(area.value).toBe("| A | B |\n| --- | --- |\n| 1 | 彼 |\n\n| A | B |\n| --- | --- |\n| 私 | 2 |\n\n後");
    expect(controller.setNotice).toHaveBeenCalledWith(expect.stringContaining("新しい表として"));
  });
});

describe("through the browser's editing, so ⌘Z takes it back", () => {
  it("a write-back and a new table are one insertText each (one undo step), the rest of the text untouched", async () => {
    const exec = browserEditing();
    const { saver, area } = setup("前\n\n| A | B |\n| --- | --- |\n| 1 | 2 |\n\n後");
    const dialog = await openAt(area, 4);
    expect(exec).not.toHaveBeenCalled(); // opening an existing table changes nothing
    type(cell(dialog, "2 行目 2 列"), "20");
    fireEvent.click(within(dialog).getByRole("button", { name: "完了" }));
    await settle();
    expect(exec).toHaveBeenCalledExactlyOnceWith("insertText", false, "0");
    expect(area.value).toBe("前\n\n| A | B |\n| --- | --- |\n| 1 | 20 |\n\n後");
    expect(saver.text).toBe(area.value); // the input event reached the save loop

    exec.mockClear();
    await openAt(area, 0);
    expect(exec).not.toHaveBeenCalled();
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "完了" }));
    await settle();
    expect(exec).toHaveBeenCalledOnce();
    expect(exec.mock.calls[0]![0]).toBe("insertText");
    expect(area.value).toBe(`前\n\n${NEW}\n\n| A | B |\n| --- | --- |\n| 1 | 20 |\n\n後`);
    expect(saver.text).toBe(area.value);
  });
});
