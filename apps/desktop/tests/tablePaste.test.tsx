// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { useSyncExternalStore } from "react";
import type { Editor } from "@tiptap/core";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AppController } from "../src/state/app";
import { Store } from "../src/sync/store";
import { Composer } from "../src/ui/Composer";
import { parseBlocks } from "../src/ui/markdown";
import { MessageBody } from "../src/ui/MessageBody";
import { decidePaste, gridToMarkdown, htmlGrid, notePasteKey, pastedTable, plainPasteRequested, tableInsertion, tsvGrid } from "../src/ui/tablePaste";
import { FakeServer } from "./fakeServer";

const fixture = (name: string) => readFileSync(join(__dirname, "fixtures", "paste", name), "utf8");
const EXCEL_HTML = fixture("excel.html");
const SHEETS_HTML = fixture("gsheets.html");
/** Excel's plain text of the same range (hidden row and column left out, the cell with a newline quoted). */
const EXCEL_TSV = '品目\t数量\t単価\t備考\r\nりんご\t3\t1,200\t\r\n"みかん\n(箱)"\tA|B 合算\t\t要確認\r\nTotal\t3\t\t\r\n\t\t\t\r\n';
const EXCEL_TABLE = ["| 品目 | 数量 | 単価 | 備考 |", "| --- | --- | --- | --- |", "| りんご | 3 | 1,200 |  |", "| みかん (箱) | A\\|B 合算 |  | 要確認 |", "| Total | 3 |  |  |"].join("\n");

/** A clipboard as a paste event carries it. */
function clipboard(data: Record<string, string>, files: File[] = []) {
  return { getData: (type: string) => data[type] ?? "", types: [...Object.keys(data), ...(files.length ? ["Files"] : [])], files, items: [] };
}
const snapshot = () => new File(["png"], "image.png", { type: "image/png" });

beforeEach(() => {
  localStorage.clear();
  plainPasteRequested(); // nothing left over from another test
  const range = Range.prototype as unknown as { getClientRects?: unknown; getBoundingClientRect?: unknown };
  range.getClientRects ??= () => [];
  range.getBoundingClientRect ??= () => new DOMRect();
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  delete (document as { execCommand?: unknown }).execCommand;
});

describe("reading a pasted spreadsheet range", () => {
  it("Excel's HTML: header first, merged cells spread, hidden rows / columns and trailing empty rows gone, | escaped, <br> a space", () => {
    expect(pastedTable(clipboard({ "text/html": EXCEL_HTML, "text/plain": EXCEL_TSV }))).toEqual({ kind: "table", markdown: EXCEL_TABLE });
  });

  it("Excel's TSV alone reads the same (quoted cells, CRLF)", () => {
    expect(pastedTable(clipboard({ "text/plain": EXCEL_TSV }))).toEqual({ kind: "table", markdown: EXCEL_TABLE });
  });

  it("Google Sheets' HTML", () => {
    expect(pastedTable(clipboard({ "text/html": SHEETS_HTML, "text/plain": "Name\tScore\tNote\n加納\t92.5\t\"line one\nline two\"\nSmith\t88\t" }))).toEqual({
      kind: "table",
      markdown: "| Name | Score | Note |\n| --- | --- | --- |\n| 加納 | 92.5 | line one line two |\n| Smith | 88 |  |",
    });
  });

  it("LibreOffice / Numbers style tables with thead / th", () => {
    const html = "<table><thead><tr><th>a</th><th>b</th></tr></thead><tbody><tr><td>1</td><td rowspan=2>2</td></tr><tr><td>3</td></tr></tbody></table>";
    expect(htmlGrid(html)).toEqual([["a", "b"], ["1", "2"], ["3", ""]]);
  });

  it("is not a table: one cell, one row, one column, prose with a tab, tab-indented code, ragged lines, a table inside a web page", () => {
    expect(pastedTable(clipboard({ "text/html": "<table><tr><td>42</td></tr></table>", "text/plain": "42" }))).toBeNull();
    expect(pastedTable(clipboard({ "text/plain": "a\tb\tc" }))).toBeNull();
    expect(pastedTable(clipboard({ "text/plain": "a\nb\nc" }))).toBeNull();
    expect(tsvGrid("if (x) {\n\treturn 1;\n}")).toBeNull();
    expect(tsvGrid("\tone\n\ttwo\n\tthree")).toBeNull();
    expect(tsvGrid("a\tb\nc\td\te")).toBeNull();
    expect(htmlGrid("<p>See the table:</p><table><tr><td>a</td><td>b</td></tr><tr><td>c</td><td>d</td></tr></table>")).toBeNull();
  });

  it("escapes pipes and keeps a cell to one line", () => {
    expect(gridToMarkdown([["a|b", "c"], ["x\\|y", ""]])).toBe("| a\\|b | c |\n| --- | --- |\n| x\\\\|y |  |");
    const [table] = parseBlocks(gridToMarkdown([["a|b", "c"], ["1", "2"]]));
    expect(table?.kind).toBe("table");
    expect(tsvGrid('"one\ntwo"\tb\nc\td')).toEqual([["one two", "b"], ["c", "d"]]);
    expect(tsvGrid('"say ""hi"""\tb\nc\td')).toEqual([['say "hi"', "b"], ["c", "d"]]);
  });

  it("drops trailing empty columns", () => {
    expect(pastedTable(clipboard({ "text/plain": "a\tb\t\t\nc\td\t\t" }))).toEqual({ kind: "table", markdown: "| a | b |\n| --- | --- |\n| c | d |" });
  });

  it("is too large past 200 rows, 30 columns or the message's room", () => {
    const tsv = (rows: number, cols: number) => Array.from({ length: rows }, (_, r) => Array.from({ length: cols }, (_, c) => `${r}-${c}`).join("\t")).join("\n");
    expect(pastedTable(clipboard({ "text/plain": tsv(200, 2) }))?.kind).toBe("table");
    expect(pastedTable(clipboard({ "text/plain": tsv(2, 30) }))?.kind).toBe("table");
    expect(pastedTable(clipboard({ "text/plain": tsv(201, 2) }))).toEqual({ kind: "tooLarge", text: tsv(201, 2) });
    expect(pastedTable(clipboard({ "text/plain": tsv(2, 31) }))?.kind).toBe("tooLarge");
    expect(pastedTable(clipboard({ "text/plain": tsv(3, 3) }), 20)?.kind).toBe("tooLarge");
  });

  it("decides: a table wins over Excel's picture; inside code, after ⌘⇧V or for a lone cell the text goes without the picture", () => {
    const excel = clipboard({ "text/html": EXCEL_HTML, "text/plain": EXCEL_TSV }, [snapshot()]);
    expect(decidePaste(excel)).toEqual({ kind: "table", markdown: EXCEL_TABLE });
    expect(decidePaste(excel, { plain: true })).toEqual({ kind: "text", text: EXCEL_TSV, tooLarge: false });
    expect(decidePaste(excel, { inCode: true })).toEqual({ kind: "text", text: EXCEL_TSV, tooLarge: false });
    expect(decidePaste(clipboard({ "text/html": "<table><tr><td>42</td></tr></table>", "text/plain": "42\n" }, [snapshot()]))).toEqual({ kind: "text", text: "42\n", tooLarge: false });
    expect(decidePaste(clipboard({}, [snapshot()]))).toBeNull(); // a screenshot attaches
    expect(decidePaste(clipboard({ "text/plain": "just text" }))).toBeNull();
  });

  it("⌘⇧V / Ctrl+Shift+V marks the next paste plain, once", () => {
    notePasteKey({ key: "V", code: "KeyV", metaKey: true, ctrlKey: false, shiftKey: true }, 1000);
    expect(plainPasteRequested(1500)).toBe(true);
    expect(plainPasteRequested(1600)).toBe(false);
    notePasteKey({ key: "v", code: "KeyV", metaKey: false, ctrlKey: true, shiftKey: true }, 1000);
    expect(plainPasteRequested(3000)).toBe(false); // too long ago
    notePasteKey({ key: "v", code: "KeyV", metaKey: true, ctrlKey: false, shiftKey: false }, 1000);
    expect(plainPasteRequested(1100)).toBe(false);
  });

  it("puts the table between blank lines in a text area's text", () => {
    expect(tableInsertion({ text: "", start: 0, end: 0 }, "|t|")).toEqual({ text: "|t|\n\n", start: 5, end: 5 });
    expect(tableInsertion({ text: "見て", start: 2, end: 2 }, "|t|")).toEqual({ text: "見て\n\n|t|\n\n", start: 9, end: 9 });
    expect(tableInsertion({ text: "a\nb", start: 2, end: 2 }, "|t|")).toEqual({ text: "a\n\n|t|\n\nb", start: 6, end: 6 });
  });
});

function controllerFor(store: Store, mode: "markdown" | "rich") {
  const send = vi.fn();
  const uploadAttachment = vi.fn(async (file: File) => ({ id: `att-${file.name}`, filename: file.name, content_type: file.type, size: file.size }));
  const setNotice = vi.fn();
  const controller = { store, engine: { send, sendTyping: vi.fn(), status: "online" }, api: { uploadAttachment }, setError: vi.fn(), setNotice, sendKey: "enter", isAdmin: false, composerMode: mode } as unknown as AppController;
  return { controller, send, uploadAttachment, setNotice };
}

function world(mode: "markdown" | "rich") {
  const server = new FakeServer();
  const me = server.addUser("alice");
  const channel = server.createChannel("general", me.id);
  const store = new Store();
  store.upsertUser(me);
  store.upsertChannel(channel, { isMember: true, syncedSeq: 0, oldestLoadedSeq: 0 });
  const parts = controllerFor(store, mode);
  function View() {
    useSyncExternalStore(store.subscribe.bind(store), () => store.version);
    return <Composer controller={parts.controller} channel={store.getChannel(channel.id)!} />;
  }
  render(<View />);
  return { ...parts, store, draft: () => store.draft(channel.id).text };
}

/** execCommand as a browser runs it on a text area (the edit stays on the undo stack). */
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

describe("Markdown mode (the text area)", () => {
  const box = () => screen.getByRole("textbox") as HTMLTextAreaElement;
  const type = (value: string) => {
    fireEvent.change(box(), { target: { value } });
    box().focus();
    box().setSelectionRange(value.length, value.length);
  };

  it("Excel's html + text + picture: the table is inserted (through the browser's editing), nothing attached, and sent as the GFM table", async () => {
    const exec = browserEditing();
    const w = world("markdown");
    type("集計です");
    const allowed = fireEvent.paste(box(), { clipboardData: clipboard({ "text/html": EXCEL_HTML, "text/plain": EXCEL_TSV }, [snapshot()]) });
    expect(allowed).toBe(false);
    expect(exec).toHaveBeenCalledOnce();
    expect(w.draft()).toBe(`集計です\n\n${EXCEL_TABLE}\n\n`);
    expect(w.uploadAttachment).not.toHaveBeenCalled();
    fireEvent.keyDown(box(), { key: "Enter" });
    expect(w.send).toHaveBeenCalledOnce();
    const body = w.send.mock.calls[0]![1] as string;
    expect(body).toBe(`集計です\n\n${EXCEL_TABLE}`);
    // The timeline draws it as a table.
    cleanup();
    const { container } = render(<MessageBody body={body} users={new Map()} />);
    expect(container.querySelectorAll("table th")).toHaveLength(4);
    expect(container.querySelectorAll("table tbody tr")).toHaveLength(3);
    expect(container.querySelector("table tbody tr:nth-child(2) td:nth-child(2)")?.textContent).toBe("A|B 合算");
  });

  it("a screenshot still attaches; ⌘⇧V pastes the raw text; a large table pastes as text with a notice", async () => {
    const w = world("markdown");
    type("");
    expect(fireEvent.paste(box(), { clipboardData: clipboard({}, [snapshot()]) })).toBe(false);
    await waitFor(() => expect(w.uploadAttachment).toHaveBeenCalledOnce());
    fireEvent.keyDown(box(), { key: "V", code: "KeyV", metaKey: true, shiftKey: true });
    expect(fireEvent.paste(box(), { clipboardData: clipboard({ "text/html": EXCEL_HTML, "text/plain": EXCEL_TSV }, [snapshot()]) })).toBe(true); // the browser pastes the text
    expect(w.uploadAttachment).toHaveBeenCalledOnce();
    const big = Array.from({ length: 250 }, (_, r) => `${r}\tx`).join("\n");
    expect(fireEvent.paste(box(), { clipboardData: clipboard({ "text/plain": big }) })).toBe(true);
    expect(w.setNotice).toHaveBeenCalledWith(expect.stringContaining("表が大きすぎる"));
  });

  it("inside a ``` fence the TSV stays as it is", () => {
    const w = world("markdown");
    type("```\n");
    expect(fireEvent.paste(box(), { clipboardData: clipboard({ "text/plain": "a\tb\nc\td" }) })).toBe(true);
    expect(w.draft()).toBe("```\n");
  });
});

describe("rich mode", () => {
  async function richWorld() {
    const w = world("rich");
    const dom = () => document.querySelector<HTMLElement>(".rich-editor");
    await waitFor(() => expect(dom()).not.toBeNull());
    const editor = () => (dom() as unknown as { editor: Editor }).editor;
    const paste = (data: Record<string, string>, files: File[] = []) => act(() => void fireEvent.paste(dom()!, { clipboardData: clipboard(data, files) }));
    return { ...w, dom, editor, paste };
  }

  it("inserts the table as a raw Markdown block, attaches nothing, and sends the GFM table", async () => {
    const w = await richWorld();
    act(() => {
      w.editor().commands.focus();
      w.editor().commands.insertContent("集計です");
    });
    w.paste({ "text/html": EXCEL_HTML, "text/plain": EXCEL_TSV }, [snapshot()]);
    expect(w.dom()!.querySelector("pre[data-raw-markdown]")?.textContent).toBe(EXCEL_TABLE);
    expect(w.uploadAttachment).not.toHaveBeenCalled();
    act(() => w.editor().commands.insertContent("以上"));
    expect(w.draft()).toBe(`集計です\n${EXCEL_TABLE}\n以上`);
    const blocks = parseBlocks(w.draft());
    expect(blocks.map((b) => b.kind)).toEqual(["paragraph", "table", "paragraph"]);
    act(() => void fireEvent.keyDown(w.dom()!, { key: "Enter" }));
    expect(w.send).toHaveBeenCalledOnce();
    expect(w.send.mock.calls[0]![1]).toBe(`集計です\n${EXCEL_TABLE}\n以上`);
  });

  it("a screenshot attaches; ⌘⇧V pastes the plain text; Google Sheets converts", async () => {
    const w = await richWorld();
    act(() => void w.editor().commands.focus());
    w.paste({}, [snapshot()]);
    await waitFor(() => expect(w.uploadAttachment).toHaveBeenCalledOnce());
    act(() => void fireEvent.keyDown(w.dom()!, { key: "v", code: "KeyV", ctrlKey: true, shiftKey: true }));
    w.paste({ "text/plain": "a\tb\nc\td" });
    expect(w.dom()!.querySelector("pre[data-raw-markdown]")).toBeNull();
    expect(w.draft()).toBe("a\tb\nc\td");
    act(() => void w.editor().commands.setContent(""));
    w.paste({ "text/html": SHEETS_HTML, "text/plain": "Name\tScore\tNote" });
    expect(w.draft()).toContain("| Name | Score | Note |\n| --- | --- | --- |");
  });
});
