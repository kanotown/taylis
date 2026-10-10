// @vitest-environment jsdom
/**
 * M153a (WIKI.md §30.3): the page editor bundled for the phones (src/mobileEditor/) driven through the native bridge
 * with a recording transport — `load` → `requestBody` gives back the exact bytes of every shared fixture string and
 * of the docs corpus (§22.6's invariant, through the bridge); a `replace` waits while an IME composition is open or an
 * edit is about to be written (Desktop's canReplace rule); `changed` goes out 300 ms after typing with only the edited
 * line changed; the people, pages and emoji native provides reach `@`, `[[` and the chips; images, links, the theme, the
 * keyboard, commands, read-only, and what a phone does not offer.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { Editor } from "@tiptap/core";
import { TextSelection } from "@tiptap/pm/state";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { BRIDGE_VERSION, createBridge, type NativeMessage, type WebMessage } from "../../shared/mobile-editor/src/bridge";
import { COMPACT_QUERY } from "../src/ui/compact";
import { COMPOSITION_SETTLE_MS } from "../src/mobileEditor/bridgeEnv";
import { MobileEditorApp } from "../src/mobileEditor/MobileEditorApp";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const shared = join(root, "apps", "shared");

function strings(value: unknown, out: string[] = []): string[] {
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) {
    if (value.length > 0 && value.every((v) => typeof v === "string")) out.push(value.join("\n"));
    value.forEach((v) => strings(v, out));
  } else if (value && typeof value === "object") Object.values(value).forEach((v) => strings(v, out));
  return out;
}
const fixtureStrings = [...new Set(readdirSync(shared).filter((n) => n.endsWith(".json") && n !== "emoji.json").flatMap((n) => strings(JSON.parse(readFileSync(join(shared, n), "utf8")))))];
const docsDir = join(root, "docs");
// The docs corpus (the schema test takes them all; here each goes through React and the bridge, so the long ones are left out).
const corpus = readdirSync(docsDir).filter((n) => n.endsWith(".md") && statSync(join(docsDir, n)).size < 120_000).map((n) => [n, readFileSync(join(docsDir, n), "utf8")] as const);

const HANAKO = "0190a2b4-0000-7000-8000-0000000000e2";
const PAGE = "0190a2b4-0000-7000-8000-0000000000c1";
const BODY = "# 手順\r\n\r\n最初の行\r\n*   古い書き方の項目\r\n1. 一\r\n1. 一\r\n\r\n::: callout ⚠️\r\n注意\r\n:::\r\n| a | b |\r\n|---|---|\r\n| 1 | 2 |";

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
  document.documentElement.removeAttribute("data-theme");
});

const settle = (ms = 30) => act(async () => { await new Promise((resolve) => setTimeout(resolve, ms)); });

/** The page with a transport that records what it sends. */
function page() {
  const sent: WebMessage[] = [];
  const bridge = createBridge({ kind: "dev", post: (json) => sent.push(JSON.parse(json) as WebMessage) });
  render(<MobileEditorApp bridge={bridge} />);
  const receive = (message: NativeMessage) => act(() => bridge.receive(message));
  const editor = () => (screen.getByRole("textbox", { name: "ページの本文" }) as unknown as { editor: Editor }).editor;
  const last = <T extends WebMessage["type"]>(type: T) => sent.filter((m): m is Extract<WebMessage, { type: T }> => m.type === type).at(-1);
  const requestBody = (): Extract<WebMessage, { type: "bodyRequested"; body: string }> => {
    receive({ type: "requestBody" });
    const answer = last("bodyRequested")!;
    if (!("body" in answer)) throw new Error("bodyRequested without a body (not loaded)");
    return answer;
  };
  return { sent, bridge, receive, editor, last, requestBody };
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

describe("the bridge and the body", () => {
  it("says ready (with the version) once the page is up, then load mounts the editor with the title", () => {
    const p = page();
    expect(p.sent[0]).toEqual({ type: "ready", version: BRIDGE_VERSION });
    expect(screen.queryByRole("textbox")).toBeNull();
    p.receive({ type: "load", body: BODY, title: "マニュアル", theme: "dark", locale: "ja" });
    expect(screen.getByRole("textbox", { name: "ページの本文" })).toBeTruthy();
    expect(document.title).toBe("マニュアル");
    expect(document.documentElement.dataset["theme"]).toBe("dark");
    expect(p.sent.filter((m) => m.type === "changed")).toHaveLength(0);
  });

  // Every string takes a full mount of the editor: the whole set (3,000+) is what pageMarkdown.test.ts and
  // pageEditorSchema.test.ts already prove byte for byte, and it ran past CI's 120 s; here every 8th string goes
  // through the bridge (FULL_FIXTURES=1 for all of them).
  const sampled = process.env["FULL_FIXTURES"] ? fixtureStrings : fixtureStrings.filter((_, i) => i % 8 === 0);

  it("load → requestBody gives back the exact bytes of the shared fixture strings (§22.6 (1), through the bridge)", () => {
    const p = page();
    expect(sampled.length).toBeGreaterThan(100);
    for (const body of sampled) {
      p.receive({ type: "load", body });
      const answer = p.requestBody();
      expect(answer.body, JSON.stringify(body)).toBe(body);
      expect(answer.dirty).toBe(false);
    }
    expect(p.sent.filter((m) => m.type === "changed")).toHaveLength(0);
  }, 120_000);

  it("…and of the docs corpus, with CRLF too", () => {
    const p = page();
    expect(corpus.length).toBeGreaterThan(10);
    for (const [name, body] of corpus) {
      p.receive({ type: "load", body });
      expect(p.requestBody().body, name).toBe(body);
    }
    const crlf = corpus[0]![1].replace(/\n/g, "\r\n");
    p.receive({ type: "load", body: crlf });
    expect(p.requestBody().body).toBe(crlf);
  }, 120_000);

  it("typing sends changed after 300 ms with dirty true, and only the edited line is written anew", async () => {
    const p = page();
    p.receive({ type: "load", body: BODY });
    const editor = p.editor();
    caretAtEndOf(editor, 2);
    type(editor, "を直す");
    expect(p.last("changed")).toBeUndefined();
    await settle(350);
    const changed = p.last("changed")!;
    expect(changed.dirty).toBe(true);
    expect(changed.body).toBe(BODY.replace("最初の行\r\n", "最初の行を直す\r\n"));
    expect(p.requestBody()).toMatchObject({ body: changed.body, dirty: true, caretLine: 2 });
  });

  it("requestBody right after typing writes the document now, without a changed of its own", () => {
    const p = page();
    p.receive({ type: "load", body: "本文" });
    const editor = p.editor();
    caretAtEndOf(editor, 0);
    type(editor, "！");
    expect(p.requestBody()).toMatchObject({ body: "本文！", dirty: true });
    expect(p.sent.filter((m) => m.type === "changed")).toHaveLength(0);
  });

  it("replace brings a merged body in (only its blocks), outside the undo history, dirty false", () => {
    const p = page();
    p.receive({ type: "load", body: BODY });
    const editor = p.editor();
    const first = editor.state.doc.child(0);
    const merged = BODY.replace("注意", "注意（花子が直した）");
    p.receive({ type: "replace", body: merged });
    expect(editor.state.doc.child(0)).toBe(first); // the heading's node stayed
    expect(p.requestBody()).toMatchObject({ body: merged, dirty: false });
    expect(editor.can().undo()).toBe(false);
  });

  it("replace during an IME composition waits for the composition to end (canReplace)", async () => {
    const p = page();
    p.receive({ type: "load", body: BODY });
    const editor = p.editor();
    fireEvent.compositionStart(editor.view.dom);
    expect(editor.view.composing).toBe(true);
    const merged = BODY.replace("注意", "注意（他の人）");
    p.receive({ type: "replace", body: merged });
    expect(p.requestBody().body).toBe(BODY);
    act(() => {
      fireEvent.compositionEnd(editor.view.dom);
    });
    // Not at once: ProseMirror finishes its composition after the editor's handler (COMPOSITION_SETTLE_MS).
    expect(p.requestBody().body).toBe(BODY);
    await settle(COMPOSITION_SETTLE_MS + 40);
    expect(p.requestBody().body).toBe(merged);
  });

  it("replace while an edit waits to be written is dropped: the edit goes out, native merges again", async () => {
    const p = page();
    p.receive({ type: "load", body: "一行目\n二行目" });
    const editor = p.editor();
    caretAtEndOf(editor, 0);
    type(editor, "！");
    p.receive({ type: "replace", body: "一行目\n二行目（他の人）" });
    await settle(350);
    expect(p.last("changed")!.body).toBe("一行目！\n二行目");
    expect(p.requestBody().body).toBe("一行目！\n二行目");
  });

  // Review v0.1.49 #1: native must know which body the editor's text was written on, or it saves a text written before a
  // dropped replace on the merged version (the other person's lines deleted).
  it("baseGen: the gen of the last load / replace taken comes back with changed and bodyRequested; a dropped replace leaves it", async () => {
    const p = page();
    p.receive({ type: "load", body: "一行目\n二行目", gen: 1 });
    const editor = p.editor();
    caretAtEndOf(editor, 0);
    type(editor, "！");
    await settle(350);
    expect(p.last("changed")).toEqual({ type: "changed", body: "一行目！\n二行目", dirty: true, baseGen: 1 });
    // A merge comes in while the next edit waits to be written: held, then dropped by that edit.
    type(editor, "？");
    p.receive({ type: "replace", body: "一行目！\n二行目（他の人）", gen: 2 });
    await settle(350);
    expect(p.last("changed")).toEqual({ type: "changed", body: "一行目！？\n二行目", dirty: true, baseGen: 1 });
    expect(p.requestBody()).toMatchObject({ body: "一行目！？\n二行目", baseGen: 1 });
    // Native merged again: taken at once (nothing waits), and the text is written on gen 3 from now.
    p.receive({ type: "replace", body: "一行目！？\n二行目（他の人）", gen: 3 });
    expect(p.requestBody()).toMatchObject({ body: "一行目！？\n二行目（他の人）", dirty: false, baseGen: 3 });
    type(editor, "。");
    expect(p.requestBody()).toMatchObject({ baseGen: 3, dirty: true });
    // A replace that is the text already moves baseGen too (nothing to put in).
    const now = p.requestBody().body;
    p.receive({ type: "replace", body: now, gen: 4 });
    expect(p.requestBody()).toMatchObject({ body: now, dirty: false, baseGen: 4 });
  });

  it("baseGen: a replace held through an IME composition and let in after it ends moves baseGen to its gen", async () => {
    const p = page();
    p.receive({ type: "load", body: BODY, gen: 7 });
    const editor = p.editor();
    fireEvent.compositionStart(editor.view.dom);
    const merged = BODY.replace("注意", "注意（他の人）");
    p.receive({ type: "replace", body: merged, gen: 8 });
    expect(p.requestBody()).toMatchObject({ body: BODY, baseGen: 7 });
    act(() => {
      fireEvent.compositionEnd(editor.view.dom);
    });
    await settle(COMPOSITION_SETTLE_MS + 40);
    expect(p.requestBody()).toMatchObject({ body: merged, baseGen: 8 });
  });

  it("without gen from native, no baseGen goes back (the messages of bridge version 1)", async () => {
    const p = page();
    p.receive({ type: "load", body: "本文" });
    const editor = p.editor();
    caretAtEndOf(editor, 0);
    type(editor, "！");
    await settle(350);
    expect(p.last("changed")).toEqual({ type: "changed", body: "本文！", dirty: true });
    expect(p.requestBody()).toEqual({ type: "bodyRequested", body: "本文！", dirty: true, caretLine: 0 });
  });

  // Review v0.1.49 #2: a page read again after its web process ended has no body; an empty answer was saved over the page.
  it("requestBody before any load answers loaded: false (no body), with the request's id; after a load the id comes back with the body", () => {
    const p = page();
    p.receive({ type: "requestBody", id: 5 });
    expect(p.last("bodyRequested")).toEqual({ type: "bodyRequested", loaded: false, id: 5 });
    p.receive({ type: "requestBody" });
    expect(p.last("bodyRequested")).toEqual({ type: "bodyRequested", loaded: false });
    p.receive({ type: "load", body: "本文", gen: 2 });
    p.receive({ type: "requestBody", id: 6 });
    expect(p.last("bodyRequested")).toEqual({ type: "bodyRequested", body: "本文", dirty: false, caretLine: 0, baseGen: 2, id: 6 });
  });

  it("a replace that waited is applied when the pending edit changed nothing", async () => {
    const p = page();
    p.receive({ type: "load", body: "一行目\n二行目" });
    const editor = p.editor();
    caretAtEndOf(editor, 0);
    type(editor, "！");
    act(() => {
      editor.commands.undo();
    });
    p.receive({ type: "replace", body: "一行目\n二行目（他の人）" });
    // The 300 ms write-out finds nothing to write and lets the held body in (after the composition settle).
    await settle(300 + COMPOSITION_SETTLE_MS + 150);
    expect(p.sent.filter((m) => m.type === "changed")).toHaveLength(0);
    expect(p.requestBody().body).toBe("一行目\n二行目（他の人）");
  });

  it("losing the focus sends the caret's line; a second load is a new editor", () => {
    const p = page();
    p.receive({ type: "load", body: BODY });
    const editor = p.editor();
    caretAtEndOf(editor, 2);
    act(() => {
      fireEvent.blur(editor.view.dom);
    });
    expect(p.last("caret")).toEqual({ type: "caret", line: 2 });
    p.receive({ type: "load", body: "別のページ", caretLine: 0 });
    expect(p.editor()).not.toBe(editor);
    expect(p.requestBody().body).toBe("別のページ");
  });
});

describe("what native provides", () => {
  it("providePeople (before load: chips are labelled as the body is read): `@` offers them, needPeople is asked for the query, a pick writes <@id>", async () => {
    const p = page();
    p.receive({ type: "providePeople", people: [{ id: HANAKO, username: "hanako", display_name: "花子" }, { id: "0190a2b4-0000-7000-8000-0000000000f1", username: "m2", display_name: "M2", kind: "group", members: 4 }] });
    p.receive({ type: "load", body: `本文 <@${HANAKO}>` });
    expect(screen.getByRole("textbox", { name: "ページの本文" }).textContent).toContain("@花子");
    const editor = p.editor();
    caretAtEndOf(editor, 0);
    type(editor, " @ha");
    await settle(150);
    expect(p.last("needPeople")).toEqual({ type: "needPeople", query: "ha" });
    const rows = within(screen.getByRole("listbox", { name: "メンションの候補" })).getAllByRole("option");
    expect(rows.map((row) => row.textContent)).toEqual([expect.stringContaining("@hanako")]);
    fireEvent.keyDown(editor.view.dom, { key: "Enter" });
    expect(p.requestBody().body).toBe(`本文 <@${HANAKO}> <@${HANAKO}> `);
  });

  it("providePages answers needPages: `[[` lists the page, a pick writes [title](page:id), a tap on the chip opens it natively", async () => {
    const p = page();
    p.receive({ type: "load", body: "本文" });
    const editor = p.editor();
    caretAtEndOf(editor, 0);
    type(editor, " [[設");
    await settle(150);
    expect(p.last("needPages")).toEqual({ type: "needPages", query: "設" });
    p.receive({ type: "providePages", query: "設", pages: [{ id: PAGE, title: "設計メモ", icon: "📐", kind: "page" }] });
    await settle();
    const rows = within(screen.getByRole("listbox", { name: "リンクするページ" })).getAllByRole("option");
    expect(rows.map((row) => row.textContent)).toEqual([expect.stringContaining("設計メモ")]);
    fireEvent.keyDown(editor.view.dom, { key: "Enter" });
    expect(p.requestBody().body).toBe(`本文 [設計メモ](page:${PAGE}) `);
    const chip = screen.getByText("設計メモ").closest("button")!;
    fireEvent.click(chip);
    expect(p.last("openLink")).toEqual({ type: "openLink", url: `page:${PAGE}` });
  });

  it("the whole tree (query null) answers later lookups without asking native", async () => {
    const p = page();
    p.receive({ type: "load", body: "本文" });
    p.receive({ type: "providePages", query: null, pages: [{ id: PAGE, title: "設計メモ" }, { id: "0190a2b4-0000-7000-8000-0000000000c2", title: "議事録" }] });
    const editor = p.editor();
    caretAtEndOf(editor, 0);
    type(editor, " [[議");
    await settle(150);
    expect(p.last("needPages")).toBeUndefined();
    const rows = within(screen.getByRole("listbox", { name: "リンクするページ" })).getAllByRole("option");
    expect(rows.map((row) => row.textContent)).toEqual([expect.stringContaining("議事録")]);
  });

  it("provideEmoji: `:name:` of a custom emoji is an atom drawn from its URL, the bytes stay", () => {
    const p = page();
    p.receive({ type: "provideEmoji", emoji: [{ name: "lab", url: "taylis-editor://app/emoji/lab", label: "研究室" }] });
    p.receive({ type: "load", body: "行 :lab: :unknown_one:" });
    const img = screen.getByRole("textbox", { name: "ページの本文" }).querySelector("img[data-custom-emoji='lab']") as HTMLImageElement;
    expect(img.src).toBe("taylis-editor://app/emoji/lab");
    expect(p.requestBody().body).toBe("行 :lab: :unknown_one:");
  });

  it("images load from load.attachmentUrl ({id}); the image button asks native (pickImage) and insertImage puts the block in", () => {
    const p = page();
    p.receive({ type: "load", body: "![写真](attachment:0190a2b4-0000-7000-8000-00000000a001)", attachmentUrl: "taylis-editor://app/attachment/{id}" });
    const body = screen.getByRole("textbox", { name: "ページの本文" });
    expect((body.querySelector("img") as HTMLImageElement).src).toBe("taylis-editor://app/attachment/0190a2b4-0000-7000-8000-00000000a001");
    fireEvent.click(within(screen.getByRole("toolbar", { name: "書式" })).getByRole("button", { name: "画像（貼り付け・ドロップでも入れられます）" }));
    expect(p.last("pickImage")).toEqual({ type: "pickImage" });
    expect(body.querySelector("input[type=file]")).toBeNull();
    p.receive({ type: "insertImage", attachmentId: "0190a2b4-0000-7000-8000-00000000a002", url: "taylis-editor://app/attachment/a002-now", alt: "新しい" });
    expect(p.requestBody().body).toBe("![写真](attachment:0190a2b4-0000-7000-8000-00000000a001)\n![新しい](attachment:0190a2b4-0000-7000-8000-00000000a002)\n");
    const images = [...body.querySelectorAll("img")].map((img) => (img as HTMLImageElement).src);
    expect(images).toContain("taylis-editor://app/attachment/a002-now");
  });

  it("the `/` menu offers neither a child page, a database nor an embed on a phone", async () => {
    const p = page();
    p.receive({ type: "load", body: "本文" });
    const editor = p.editor();
    caretAtEndOf(editor, 0);
    act(() => {
      editor.commands.splitBlock();
    });
    type(editor, "/");
    await settle();
    const labels = within(screen.getByRole("listbox", { name: "ブロックを追加" })).getAllByRole("option").map((row) => row.textContent ?? "");
    expect(labels.some((l) => l.includes("画像"))).toBe(true);
    expect(labels.some((l) => l.includes("子ページを作る") || l.includes("データベースを作って埋め込む") || l.includes("データベースを埋め込む"))).toBe(false);
  });
});

describe("the native side's controls", () => {
  it("setTheme and setViewport: the html attribute and the keyboard's height", () => {
    const p = page();
    p.receive({ type: "load", body: "本文", theme: "light" });
    expect(document.documentElement.dataset["theme"]).toBe("light");
    p.receive({ type: "setTheme", theme: "system" });
    expect(document.documentElement.dataset["theme"]).toBeUndefined();
    p.receive({ type: "setViewport", keyboardHeight: 336, safeBottom: 34 });
    expect(document.documentElement.style.getPropertyValue("--keyboard-height")).toBe("336px");
    expect(document.documentElement.style.getPropertyValue("--safe-bottom")).toBe("34px");
  });

  it("the formatting row is at the bottom of the screen; the editor does not take the focus by itself; focus / blur come from native", async () => {
    const p = page();
    p.receive({ type: "load", body: "本文" });
    const row = screen.getByRole("toolbar", { name: "書式" });
    expect(row.className).toContain("pe-toolbar-bottom");
    // jsdom cannot focus a contenteditable: the calls are what is checked (TipTap focuses on the next frame).
    const dom = p.editor().view.dom;
    const focus = vi.spyOn(dom, "focus");
    const blur = vi.spyOn(dom, "blur");
    await settle(40);
    expect(focus).not.toHaveBeenCalled();
    p.receive({ type: "focus" });
    await settle(40);
    expect(focus).toHaveBeenCalled();
    p.receive({ type: "blur" });
    expect(blur).toHaveBeenCalled();
  });

  it("command: bold on the selection, a heading, undo; an unknown name is refused before it reaches the editor", async () => {
    const p = page();
    p.receive({ type: "load", body: "太くする行" });
    const editor = p.editor();
    act(() => {
      editor.commands.setTextSelection({ from: 1, to: 5 });
    });
    p.receive({ type: "command", name: "bold" });
    expect(p.requestBody().body).toBe("**太くする**行");
    p.receive({ type: "command", name: "h2" });
    expect(p.requestBody().body).toBe("## **太くする**行");
    p.receive({ type: "command", name: "undo" });
    expect(p.requestBody().body).toBe("**太くする**行");
    p.bridge.receive({ type: "command", name: "explode" });
    expect(p.last("log")).toMatchObject({ level: "warn", message: 'message refused: command: unknown name "explode"' });
  });

  it("readOnly: the editor shows the body but cannot be edited", () => {
    const p = page();
    p.receive({ type: "load", body: "読むだけ", readOnly: true });
    const editor = p.editor();
    expect(editor.isEditable).toBe(false);
    expect(editor.view.dom.getAttribute("contenteditable")).toBe("false");
    expect(p.requestBody().body).toBe("読むだけ");
  });

  it("↑ on the first line asks native for the title; a message that is not JSON is refused with log", () => {
    const p = page();
    p.receive({ type: "load", body: "本文" });
    const editor = p.editor();
    act(() => {
      editor.commands.setTextSelection(1);
    });
    fireEvent.keyDown(editor.view.dom, { key: "ArrowLeft" });
    expect(p.last("focusTitle")).toEqual({ type: "focusTitle" });
    act(() => p.bridge.receive("{oops"));
    expect(p.last("log")).toMatchObject({ level: "warn", message: "message refused: not JSON" });
  });
});
