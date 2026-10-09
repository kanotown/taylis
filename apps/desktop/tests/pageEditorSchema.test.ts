// @vitest-environment jsdom
/**
 * M150 (WIKI.md §22.6, §27): the 見たまま page editor's document in a real TipTap editor (without the page around it).
 * The round trip through the editor's own schema: every fixture string and the corpus open and close unchanged; each
 * kind of block edited with the editor's commands writes the expected Markdown and leaves the other blocks' bytes;
 * typing Markdown converts; undo / redo; a merge brought in replaces only the blocks it changed.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Editor, type JSONContent } from "@tiptap/core";
import { closeHistory } from "@tiptap/pm/history";
import { NodeSelection, Selection, TextSelection } from "@tiptap/pm/state";
import { afterEach, describe, expect, it } from "vitest";

import { blockPosAt, canPlace, deleteUnit, duplicateUnit, moveUnit, unitAt } from "../src/ui/pageEditorBlocks";
import { BlockSelection, extendTo, pasteAfterBlocks } from "../src/ui/pageEditorSelection";
import { cellPos, editTable } from "../src/ui/pageEditorTable";
import { pageHtmlFromPaste } from "../src/ui/pagePaste";
import { jsonView, readsAsShown, type RichNode } from "../src/ui/pageMarkdown";
import { applyMerge, createPageDocument } from "../src/ui/pageEditorDoc";
import { editorMarkdown, markdownSlice, pageExtensions, type PageEditorHost, PortalRegistry, sliceMarkdown, SourceMap, untied } from "../src/ui/pageEditorSchema";

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
const corpus = readdirSync(docsDir).filter((n) => n.endsWith(".md") && statSync(join(docsDir, n)).size < 600_000).map((n) => readFileSync(join(docsDir, n), "utf8"));

export function fakeHost(): PageEditorHost {
  return {
    portals: new PortalRegistry(),
    sources: new SourceMap(),
    render: { pageLink: () => null, emoji: () => null, image: () => null, embed: () => null, math: () => null, inlineMath: () => null, calloutIcon: () => null },
    mentionLabel: (md) => `@${md.slice(2, 6)}`,
    isEmoji: (name) => name === "smile" || name === "party",
    pickIcon: () => {},
    editMath: () => {},
    save: () => {},
    link: () => {},
    focusTitle: () => {},
    text: { placeholder: "", editTable: "", raw: "Markdown", toggleOpen: "open", toggleClose: "close", checkbox: "done", changeIcon: "icon", untitledToggle: "" },
    editable: () => true,
  };
}

let editors: Editor[] = [];
afterEach(() => {
  editors.forEach((e) => e.destroy());
  editors = [];
});

function open(body: string) {
  const element = document.createElement("div");
  document.body.append(element);
  const host = fakeHost();
  const sources = host.sources;
  // The clipboard as PageEditor.tsx sets it up: Markdown out and in, blocks pasted after a block selection (M154).
  const ref: { editor: Editor | null } = { editor: null };
  const editor = new Editor({
    element,
    extensions: pageExtensions(host),
    content: createPageDocument(body, host.isEmoji) as JSONContent,
    editorProps: {
      clipboardTextSerializer: (slice) => sliceMarkdown(ref.editor!, slice, sources),
      clipboardTextParser: (text) => markdownSlice(ref.editor!, text, host.isEmoji),
      handlePaste: (view, _event, slice) => pasteAfterBlocks(view, slice),
    },
  });
  ref.editor = editor;
  sources.add(editor.state.doc);
  editors.push(editor);
  return { editor, sources, host, markdown: () => editorMarkdown(editor.state.doc, sources).text };
}

/** Types text the way the keyboard does (input rules run). */
function type(editor: Editor, text: string) {
  for (const ch of text) {
    const { from, to } = editor.state.selection;
    const handled = editor.view.someProp("handleTextInput", (f) => f(editor.view, from, to, ch, () => editor.state.tr.insertText(ch, from, to)));
    if (!handled) editor.view.dispatch(editor.state.tr.insertText(ch, from, to));
  }
}

const press = (editor: Editor, key: string, init: KeyboardEventInit = {}) => {
  const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init });
  editor.view.someProp("handleKeyDown", (f) => f(editor.view, event));
};

/** The caret at the end of the top-level block `index` (its text). */
function caretInBlock(editor: Editor, index: number, at: "start" | "end" = "end") {
  let pos = 0;
  for (let k = 0; k < index; k++) pos += editor.state.doc.child(k).nodeSize;
  const node = editor.state.doc.child(index);
  const inner = at === "start" ? pos + 1 : pos + node.nodeSize - 1;
  editor.view.dispatch(editor.state.tr.setSelection(TextSelection.near(editor.state.doc.resolve(inner), at === "start" ? 1 : -1)));
}

describe("the round trip through the editor's schema", () => {
  it(`every fixture string (${fixtureStrings.length}) opens and closes unchanged`, () => {
    const element = document.createElement("div");
    const host = fakeHost();
    const editor = new Editor({ element, extensions: pageExtensions(host) });
    editors.push(editor);
    const failures: string[] = [];
    for (const body of fixtureStrings) {
      editor.commands.setContent(createPageDocument(body, host.isEmoji) as JSONContent, { emitUpdate: false });
      const sources = new SourceMap();
      sources.add(editor.state.doc);
      if (editorMarkdown(editor.state.doc, sources).text !== body) failures.push(body);
    }
    expect(failures).toEqual([]);
  });

  it(`the docs/ corpus (${corpus.length} files) opens and closes unchanged`, () => {
    for (const body of corpus) {
      const { markdown } = open(body);
      expect(markdown() === body).toBe(true);
    }
  });
});

const BODY = [
  "# 研究室マニュアル",
  "",
  "はじめに **大事** なこと。",
  "* 項目 A",
  "*   項目 B",
  "    * 入れ子",
  "",
  "1. 一",
  "1. 二",
  "",
  "- [ ] 予稿 <!--task:0190a2b4-0000-7000-8000-000000000001-->",
  "- [x] 発表",
  "",
  "> 引用の行",
  "> - 引用のリスト",
  "",
  "```py",
  "print(‘hi’)",
  "```",
  "",
  "$$x^2$$",
  "",
  "| 名前 | 締切 |",
  "| --- | --- |",
  "| 予稿 | 10/3 |",
  "",
  "---",
  "",
  "![](attachment:0190a2b4-0000-7000-8000-0000000000aa)",
  "![db](page:0190a2b4-0000-7000-8000-0000000000bb#view=v1)",
  "::: callout ⚠️",
  "注意の **本文**",
  "- 中のリスト",
  ":::",
  "::: toggle 詳しく",
  "隠れた行",
  ":::",
  "<@0190a2b4-0000-7000-8000-0000000000dd> と [ページ](page:0190a2b4-0000-7000-8000-0000000000cc) :smile:",
  "最後の行",
].join("\r\n");

describe("editing a block writes that block only", () => {
  const lines = BODY.split("\r\n");
  const replaced = (index: number, line: string | string[]) => [...lines.slice(0, index), ...(Array.isArray(line) ? line : [line]), ...lines.slice(index + 1)].join("\r\n");

  it("opens unchanged (CRLF, the hidden marker, curled quotes in code, U+FE0F in the icon)", () => {
    expect(open(BODY).markdown()).toBe(BODY);
  });

  it("a paragraph: text typed at its end", () => {
    const { editor, markdown } = open(BODY);
    caretInBlock(editor, 2);
    type(editor, "追記");
    expect(markdown()).toBe(replaced(2, "はじめに **大事** なこと。追記"));
  });

  it("a heading: its level changed", () => {
    const { editor, markdown } = open(BODY);
    caretInBlock(editor, 0);
    editor.commands.setNode("heading", { level: 2 });
    expect(markdown()).toBe(replaced(0, "## 研究室マニュアル"));
  });

  it("bold toggled on a word: the line in the canonical form", () => {
    const { editor, markdown } = open(BODY);
    caretInBlock(editor, 2, "start");
    editor.commands.setTextSelection({ from: editor.state.selection.from, to: editor.state.selection.from + 4 });
    editor.commands.toggleBold();
    expect(markdown()).toBe(replaced(2, "**はじめに** **大事** なこと。"));
  });

  it("a list item edited: its own line, the others keep `*   項目 B` and its four-space child", () => {
    const { editor, markdown } = open(BODY);
    caretInBlock(editor, 3);
    type(editor, "!");
    expect(markdown()).toBe(replaced(3, "- 項目 A!"));
  });

  it("Enter after a list item: a new item at the same level; Tab nests it under the one before", () => {
    const { editor, markdown } = open(BODY);
    caretInBlock(editor, 5);
    press(editor, "Enter");
    type(editor, "新");
    expect(markdown()).toBe(replaced(5, ["    * 入れ子", "    - 新"]));
    press(editor, "Tab", { shiftKey: true });
    expect(markdown()).toBe(replaced(5, ["    * 入れ子", "- 新"]));
  });

  it("a numbered item added: counts on after the last", () => {
    const { editor, markdown } = open(BODY);
    caretInBlock(editor, 8);
    press(editor, "Enter");
    type(editor, "三");
    expect(markdown()).toBe(replaced(8, ["1. 二", "3. 三"]));
  });

  it("a checklist item ticked: `[x]`, its hidden marker kept", () => {
    const { editor, markdown } = open(BODY);
    const pos = [...Array(10).keys()].reduce((sum, k) => sum + editor.state.doc.child(k).nodeSize, 0);
    const node = editor.state.doc.child(10);
    editor.view.dispatch(editor.state.tr.setNodeMarkup(pos, undefined, { ...node.attrs, checked: true }));
    expect(markdown()).toBe(replaced(10, "- [x] 予稿 <!--task:0190a2b4-0000-7000-8000-000000000001-->"));
  });

  it("Enter in the middle of a linked checklist item: the marker stays on the first half, the new item is open", () => {
    const { editor, markdown } = open(BODY);
    caretInBlock(editor, 10, "start");
    editor.commands.setTextSelection(editor.state.selection.from + 1);
    press(editor, "Enter");
    expect(markdown()).toBe(replaced(10, ["- [ ] 予 <!--task:0190a2b4-0000-7000-8000-000000000001-->", "- [ ] 稿"]));
  });

  it("a quote edited: the quote in the canonical form, the rest as it was", () => {
    const { editor, markdown } = open(BODY);
    caretInBlock(editor, 13);
    type(editor, "!");
    expect(markdown()).toBe(BODY.replace("> 引用の行\r\n> - 引用のリスト", "> 引用の行\n> - 引用のリスト!"));
  });

  it("a code block edited: written with straight quotes and its language", () => {
    const { editor, markdown } = open(BODY);
    caretInBlock(editor, 15);
    type(editor, "!");
    expect(markdown()).toBe(BODY.replace("```py\r\nprint(‘hi’)\r\n```", "```py\nprint('hi')!\n```"));
  });

  it("display math edited", () => {
    const { editor, markdown } = open(BODY);
    caretInBlock(editor, 17);
    type(editor, "+1");
    expect(markdown()).toBe(replaced(20, "$$x^2+1$$"));
  });

  it("a table's cell edited in place: only the table's lines, in the canonical form", () => {
    const { editor, markdown } = open(BODY);
    let pos = 0;
    for (let k = 0; k < 19; k++) pos += editor.state.doc.child(k).nodeSize;
    const table = editor.state.doc.child(19);
    expect(table.type.name).toBe("table");
    editor.commands.setTextSelection(cellPos(table, pos, 1, 1, true));
    type(editor, "（延長）");
    expect(markdown()).toBe(BODY.replace("| 予稿 | 10/3 |", "| 予稿 | 10/3（延長） |").replace("| 名前 | 締切 |\r\n| --- | --- |\r\n| 予稿", "| 名前 | 締切 |\n| --- | --- |\n| 予稿"));
  });

  it("a callout's line edited: the opener with its U+FE0F icon and the close stay", () => {
    const { editor, markdown } = open(BODY);
    const index = editor.state.doc.content.content.findIndex((n) => n.type.name === "callout");
    let pos = 0;
    for (let k = 0; k < index; k++) pos += editor.state.doc.child(k).nodeSize;
    // The callout's first line: inside the callout (pos + 1), its paragraph's end.
    const paragraph = editor.state.doc.child(index).child(0);
    editor.commands.setTextSelection(pos + 1 + paragraph.nodeSize - 1);
    type(editor, "！");
    expect(markdown()).toBe(BODY.replace("注意の **本文**", "注意の **本文！**")); // typing on at a bold end stays bold
  });

  it("a toggle's title edited", () => {
    const { editor, markdown } = open(BODY);
    const index = editor.state.doc.content.content.findIndex((n) => n.type.name === "toggle");
    let pos = 0;
    for (let k = 0; k < index; k++) pos += editor.state.doc.child(k).nodeSize;
    const title = editor.state.doc.child(index).child(0);
    editor.commands.setTextSelection(pos + 1 + title.nodeSize - 1);
    type(editor, "見る");
    expect(markdown()).toBe(BODY.replace("::: toggle 詳しく", "::: toggle 詳しく見る"));
  });

  it("a line with atoms edited: the mention, the page link and the emoji stay as written", () => {
    const { editor, markdown } = open(BODY);
    caretInBlock(editor, editor.state.doc.childCount - 2);
    type(editor, "。");
    expect(markdown()).toBe(BODY.replace(":smile:\r\n最後", ":smile:。\r\n最後"));
  });

  it("a rule, an image and an embed deleted: the lines around them stay", () => {
    const { editor, markdown } = open(BODY);
    const index = editor.state.doc.content.content.findIndex((n) => n.type.name === "image");
    let pos = 0;
    for (let k = 0; k < index; k++) pos += editor.state.doc.child(k).nodeSize;
    const size = editor.state.doc.child(index).nodeSize + editor.state.doc.child(index + 1).nodeSize;
    editor.view.dispatch(editor.state.tr.delete(pos, pos + size));
    expect(markdown()).toBe(BODY.replace("![](attachment:0190a2b4-0000-7000-8000-0000000000aa)\r\n![db](page:0190a2b4-0000-7000-8000-0000000000bb#view=v1)\r\n", ""));
  });

  it("undo brings the bytes back; redo the edit", () => {
    const { editor, markdown } = open(BODY);
    caretInBlock(editor, 2);
    type(editor, "追記");
    expect(markdown()).not.toBe(BODY);
    editor.commands.undo();
    expect(markdown()).toBe(BODY);
    editor.commands.redo();
    expect(markdown()).toBe(replaced(2, "はじめに **大事** なこと。追記"));
  });
});

describe("typing Markdown converts", () => {
  const cases: Array<[string, string]> = [
    ["# 見出し", "# 見出し"],
    ["### 小見出し", "### 小見出し"],
    ["- 項目", "- 項目"],
    ["* 項目", "- 項目"],
    ["3. 三", "3. 三"],
    ["[] やること", "- [ ] やること"],
    ["[x] 済み", "- [x] 済み"],
    ["- [ ] 箇条から", "- [ ] 箇条から"],
    ["> 引用", "> 引用"],
    ["**太字** と", "**太字** と"],
    ["`code` ", "`code` "],
    ["$$ x^2", "$$x^2$$"],
    ["絵文字 :smile: ", "絵文字 :smile: "],
    ["snake_case_name ", "snake_case_name "],
    ["式 $x^2$ と", "式 $x^2$ と"],
  ];
  it.each(cases)("%s", (typed, expected) => {
    const { editor, markdown } = open("");
    editor.commands.focus("end");
    type(editor, typed);
    expect(markdown()).toBe(expected);
  });

  it("--- on a line of its own is a rule (with the blank lines it needs)", () => {
    const { editor, markdown } = open("前");
    caretInBlock(editor, 0);
    press(editor, "Enter");
    type(editor, "---");
    type(editor, "後");
    expect(markdown()).toBe("前\n\n---\n\n後");
  });
});

describe("pasting and merges", () => {
  it("Markdown pasted as text becomes blocks (written anew)", () => {
    const { editor, markdown } = open("");
    const slice = markdownSlice(editor, "## 貼った\n- a\n- b", () => false);
    editor.view.dispatch(editor.state.tr.replaceSelection(slice));
    expect(markdown()).toBe("## 貼った\n- a\n- b");
  });

  it("HTML pasted (a list, bold, a heading) becomes the dialect", () => {
    const { editor, markdown } = open("");
    editor.commands.insertContent("<h2>題</h2><p>本文 <strong>強</strong></p><div data-list-line data-kind=\"bullet\" data-level=\"0\">一</div><div data-list-line data-kind=\"bullet\" data-level=\"1\">二</div>");
    expect(markdown()).toBe("## 題\n本文 **強**\n- 一\n  - 二");
  });

  it("a merge from the server replaces only the blocks it changed; the caret stays in the block typed in", () => {
    const { editor, sources, markdown } = open(BODY);
    caretInBlock(editor, 2);
    const before = editor.state.doc.child(0);
    const merged = BODY.replace("最後の行", "最後の行（他の人）");
    expect(applyMerge(editor, sources, merged, () => false)).toBe("partial");
    expect(markdown()).toBe(merged);
    expect(editor.state.doc.child(0)).toBe(before);
    expect(editor.state.selection.$from.index(0)).toBe(2);
  });
});

/** The position before the top-level block `index`. */
const before = (editor: Editor, index: number) => {
  let pos = 0;
  for (let k = 0; k < index; k++) pos += editor.state.doc.child(k).nodeSize;
  return pos;
};

describe("M151: moving blocks", () => {
  const lines = BODY.split("\r\n");
  const keys = (editor: Editor, direction: "ArrowUp" | "ArrowDown") => press(editor, direction, { ctrlKey: true, shiftKey: true }) // jsdom is not a Mac: Mod is Ctrl;

  it("⌘⇧↓ moves a line past the next; both keep their bytes and line breaks; undo restores them exactly", () => {
    const { editor, markdown } = open(BODY);
    caretInBlock(editor, 2);
    keys(editor, "ArrowDown");
    expect(markdown()).toBe([...lines.slice(0, 2), lines[3], lines[2], ...lines.slice(4)].join("\r\n"));
    expect(editor.state.selection.$from.parent.textContent).toBe("はじめに 大事 なこと。"); // the caret moved with it
    editor.commands.undo();
    expect(markdown()).toBe(BODY);
  });

  it("a list item moves with its children (`*   項目 B` and its four-space child keep their text)", () => {
    const { editor, markdown } = open(BODY);
    caretInBlock(editor, 4);
    keys(editor, "ArrowUp");
    expect(markdown()).toBe([...lines.slice(0, 3), "*   項目 B", "    * 入れ子", "* 項目 A", ...lines.slice(6)].join("\r\n"));
    keys(editor, "ArrowUp");
    expect(markdown()).toBe([...lines.slice(0, 2), "*   項目 B", "    * 入れ子", lines[2], "* 項目 A", ...lines.slice(6)].join("\r\n"));
  });

  it("a nested item moved away from its list is lifted to the top level (written anew)", () => {
    const { editor, sources, markdown } = open(BODY);
    editor.view.dispatch(moveUnit(editor.state, unitAt(editor.state.doc, before(editor, 5)), before(editor, 2), sources, {})!);
    expect(markdown()).toBe([lines[0], lines[1], "- 入れ子", lines[2], lines[3], lines[4], ...lines.slice(6)].join("\r\n"));
  });

  it("numbered lines swapped keep `1.` (the renderer numbers them)", () => {
    const { editor, markdown } = open("1. 一\n1. 二\n1. 三");
    caretInBlock(editor, 2);
    keys(editor, "ArrowUp");
    expect(markdown()).toBe("1. 一\n1. 三\n1. 二");
  });

  it("a block moved into a callout, then out again at its first line (⌘⇧↑)", () => {
    const { editor, sources, markdown } = open("前\n::: callout 💡\n中\n:::\n後");
    // 「前」 into the callout, before 「中」.
    editor.view.dispatch(moveUnit(editor.state, unitAt(editor.state.doc, 0), before(editor, 1) + 1, sources, {})!);
    expect(markdown()).toBe("::: callout 💡\n前\n中\n:::\n後");
    keys(editor, "ArrowUp");
    expect(markdown()).toBe("前\n::: callout 💡\n中\n:::\n後");
  });

  it("a line that would read differently in its new place is written anew (`:::` into a callout)", () => {
    const { editor, sources, markdown } = open(":::\n::: callout\nx\n:::");
    expect(editor.state.doc.child(0).type.name).toBe("paragraph");
    editor.view.dispatch(moveUnit(editor.state, unitAt(editor.state.doc, 0), before(editor, 1) + 1, sources, {})!);
    expect(markdown()).toBe("::: callout\n​:::\nx\n:::");
  });

  it("the only block of a callout moved out leaves an empty line in it", () => {
    const { editor, sources, markdown } = open("::: callout\nx\n:::\n後");
    editor.view.dispatch(moveUnit(editor.state, unitAt(editor.state.doc, 1), editor.state.doc.content.size, sources, {})!);
    expect(markdown()).toBe("::: callout\n:::\n後\nx");
  });

  it("containers go two deep at most: a toggle with a callout in it cannot go into a callout", () => {
    const { editor, sources } = open("::: toggle t\n::: callout\nx\n:::\n:::\n::: callout\ny\n:::");
    const unit = unitAt(editor.state.doc, 0);
    expect(canPlace(editor.state.doc, unit, before(editor, 1) + 1)).toBe(false);
    expect(moveUnit(editor.state, unit, before(editor, 1) + 1, sources, {})).toBeNull();
    expect(canPlace(editor.state.doc, unitAt(editor.state.doc, before(editor, 1)), 0)).toBe(true);
  });

  it("a rule moved beside text gets the blank lines it needs", () => {
    const { editor, markdown } = open("a\nb\n\n---\n\nc");
    editor.view.dispatch(editor.state.tr.setSelection(NodeSelection.create(editor.state.doc, before(editor, 3))));
    keys(editor, "ArrowUp");
    expect(markdown()).toBe("a\nb\n\n---\n\n\nc"); // past the blank line (a block too)
    keys(editor, "ArrowUp");
    expect(markdown()).toBe("a\n\n---\n\nb\n\n\nc");
  });

  it("the selected lines move together", () => {
    const { editor, markdown } = open("a\nb\nc\nd");
    editor.view.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, before(editor, 1) + 1, before(editor, 2) + 2)));
    keys(editor, "ArrowDown");
    expect(markdown()).toBe("a\nd\nb\nc");
  });

  it("random moves on random pages: the body always reads as the editor shows it, undo gives the bytes back", () => {
    const pieces = ["# 見出し", "本文", "", "- a", "  - b", "    - c", "1. one", "1. one", "  1. inner", "- [ ] task", "  - [ ] sub", "> quote", "```", "code", "```", "$$x$$", "---", "| a | b |", "| --- | --- |", "| 1 | 2 |", "a | b", ":::", "$$", "::: callout 💡", "::: toggle t", ":::", "![](attachment:0190a2b4-0000-7000-8000-0000000000aa)", "* star", "*   wide"];
    let seed = 151;
    const next = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
    let moved = 0;
    for (let k = 0; k < 1000; k++) {
      const body = Array.from({ length: 3 + Math.floor(next() * 12) }, () => pieces[Math.floor(next() * pieces.length)]!).join("\n");
      editors.forEach((e) => e.destroy());
      editors = [];
      const { editor, sources, markdown } = open(body);
      expect(markdown()).toBe(body);
      const blocks: number[] = [];
      editor.state.doc.descendants((node, pos) => {
        if (blockPosAt(editor.state.doc, pos) === pos && node.type.name !== "toggleTitle") blocks.push(pos);
        return node.type.name === "doc" || node.type.name === "callout" || node.type.name === "toggle";
      });
      const unit = unitAt(editor.state.doc, blocks[Math.floor(next() * blocks.length)]!);
      const targets = [...blocks, editor.state.doc.content.size].filter((pos) => canPlace(editor.state.doc, unit, pos));
      if (targets.length === 0) continue;
      const tr = moveUnit(editor.state, unit, targets[Math.floor(next() * targets.length)]!, sources, {});
      editor.view.dispatch(tr!);
      moved++;
      const written = markdown();
      const shown = editor.state.doc.toJSON() as RichNode;
      expect(readsAsShown(shown.content ?? [], jsonView(() => false), (n) => n, 0) && readsAsShown([...Array(editor.state.doc.childCount).keys()].map((i) => editor.state.doc.child(i)), sources.view(), (n) => n.toJSON() as RichNode, 0), `${JSON.stringify(body)} → ${JSON.stringify(written)}`).toBe(true);
      editor.commands.undo();
      expect(markdown()).toBe(body);
    }
    expect(moved).toBeGreaterThan(700);
  }, 60_000);

  it("duplicate (written anew, a task's hidden link stays with the original) and delete", () => {
    const { editor, markdown } = open("- [ ] 予稿 <!--task:0190a2b4-0000-7000-8000-000000000001-->\n後");
    editor.view.dispatch(duplicateUnit(editor.state, unitAt(editor.state.doc, 0), untied));
    expect(markdown()).toBe("- [ ] 予稿 <!--task:0190a2b4-0000-7000-8000-000000000001-->\n- [ ] 予稿\n後");
    editor.view.dispatch(deleteUnit(editor.state, unitAt(editor.state.doc, 0)));
    expect(markdown()).toBe("- [ ] 予稿\n後");
  });
});

describe("M151: HTML pasted from Notion, Word and Google Docs (tests/fixtures/paste)", () => {
  const fixture = (name: string) => readFileSync(join(dirname(fileURLToPath(import.meta.url)), "fixtures", "paste", name), "utf8");
  // jsdom has no ClipboardEvent (ProseMirror's pasteHTML makes one).
  (globalThis as { ClipboardEvent?: unknown }).ClipboardEvent ??= class extends Event {
    clipboardData = null;
  };
  const paste = (html: string, body = "") => {
    const { editor, markdown } = open(body);
    editor.commands.focus("end");
    editor.view.pasteHTML(pageHtmlFromPaste(html));
    return markdown();
  };

  it("Word: headings, marks, list paragraphs (bullets in a symbol font, numbers, levels), a table with paragraphs in its cells; no Office leftovers", () => {
    const html = pageHtmlFromPaste(fixture("word.html"));
    expect(html).not.toMatch(/<o:p|<!--|<style|<meta|<xml|supportLists|mso-list:\s*Ignore/i);
    expect(paste(fixture("word.html"))).toBe(["# 研究室の手順", "まず**装置の電源**を入れ、_必ず_\u200b記録する。", "", "- 試料を準備する", "  - 温度を~~確認~~測る", "- 測定する", "1. 一つ目", "2. 二つ目", "| 項目 | 値 |", "| --- | ---: |", "| 温度 (degC) | 25 \\| 26 |", "Done."].join("\n"));
  });

  it("Google Docs: the guid wrapper is not bold, span styles are marks, nested lists, checklists, a table with colspan / rowspan", () => {
    expect(paste(fixture("gdocs.html"))).toBe(["## 議事録", "ふつうの文と**太字**_斜体_~~取り消し~~と[リンク](https://example.com/minutes)", "- 項目 A", "  - 入れ子", "- 項目 B", "- [x] ~~済んだこと~~", "- [ ] まだのこと", "| 担当と期限 |  | 状態 |", "| --- | --- | :---: |", "| 花子 | 10/3 | 済 |", "|  | 11/1 | 未 |"].join("\n"));
  });

  it("Notion's HTML export: callouts with their icon (one in a toggle), toggles, to-dos, a table with its header", () => {
    expect(paste(fixture("notion-export.html"))).toBe(["# 実験ノート", "本文の**太字**と`code`。", "::: callout ⚠️", "装置は**必ず**止めてから", "- 中のリスト", ":::", "::: toggle 詳しい手順", "隠れた行", "::: callout 💡", "トグルの中のコールアウト", ":::", ":::", "- [x] 済んだ", "- [ ] まだ", "| 名前 | 役割 |", "| --- | --- |", "| 花子 | 測定 \\| 解析 |"].join("\n"));
  });

  it("Notion's app and pages: <aside> with a leading emoji, <details>, `[x]` items, a callout block around a note", () => {
    expect(paste(fixture("notion-app.html"))).toBe(["## 週次の予定", "::: callout 📌", "締切は**金曜**まで", ":::", "::: toggle 過去の議事録", "先週は休み", ":::", "- [x] 予稿を出す", "- [ ] 発表練習", "1. 一", "2. 二", "  1. 二の一", "::: callout 🧪", "試薬の扱い", ":::"].join("\n"));
  });

  it("callouts and toggles three deep give up the innermost frame (the dialect holds two)", () => {
    expect(paste("<aside>💡 一<details><summary>二</summary><aside>🔥 三</aside></details></aside>")).toBe(["::: callout 💡", "一", "::: toggle 二", "🔥 三", ":::", ":::"].join("\n"));
  });
});

describe("M151: inline math is an atom", () => {
  it("typed `$x$` is one; a line edited beside untouched formulas writes their TeX as it was", () => {
    const { editor, markdown } = open("前 $\\frac{a|b}{c}$ と $$x\\$$$ 後\n次");
    const line = editor.state.doc.child(0);
    expect(line.content.content.filter((n) => n.type.name === "inlineMath").map((n) => [n.attrs.tex, n.attrs.display])).toEqual([["\\frac{a|b}{c}", false], ["x\\$", true]]);
    caretInBlock(editor, 0);
    type(editor, "！");
    expect(markdown()).toBe("前 $\\frac{a|b}{c}$ と $$x\\$$$ 後！\n次");
    caretInBlock(editor, 1);
    type(editor, " $y$");
    expect(editor.state.doc.child(1).lastChild?.type.name).toBe("inlineMath");
    expect(markdown()).toBe("前 $\\frac{a|b}{c}$ と $$x\\$$$ 後！\n次 $y$");
  });

  it("the arrows select it and Enter opens its TeX; in a code span `$x$` stays text", () => {
    const opened: number[] = [];
    const { editor } = open("a $x$ b");
    const host = (editor.extensionManager.extensions.find((e) => e.name === "pageKeys")!.options as { host: PageEditorHost }).host;
    host.editMath = (pos) => opened.push(pos);
    editor.view.dispatch(editor.state.tr.setSelection(NodeSelection.create(editor.state.doc, 3)));
    press(editor, "Enter");
    expect(opened).toEqual([3]);
    const code = open("");
    code.editor.commands.focus("end");
    code.editor.commands.toggleCode();
    type(code.editor, "$x$");
    expect(code.markdown()).toBe("`$x$`");
  });

  it("a formula next to a letter keeps the zero-width space that ends it", () => {
    const { editor, markdown } = open("$x$​abc");
    caretInBlock(editor, 0);
    type(editor, "d");
    expect(markdown()).toBe("$x$​abcd");
  });
});

describe("M151: table cells edited in place", () => {
  const BODY_TABLE = "前\n| 名前 | 締切 |\n|---|--:|\n| 予稿 | 10/3 |\n後";
  const tableAt = (editor: Editor) => ({ pos: before(editor, 1), node: editor.state.doc.child(1) });
  const caretIn = (editor: Editor, row: number, col: number) => {
    const { pos, node } = tableAt(editor);
    editor.commands.setTextSelection(cellPos(node, pos, row, col, true));
  };

  it("Tab / Shift+Tab move between cells; Tab in the last cell adds a row; Enter goes down (and adds a row at the end)", () => {
    const { editor, markdown } = open(BODY_TABLE);
    caretIn(editor, 0, 0);
    press(editor, "Tab");
    type(editor, "期限");
    expect(markdown()).toBe("前\n| 名前 | 期限 |\n| --- | ---: |\n| 予稿 | 10/3 |\n後");
    press(editor, "Tab", { shiftKey: true });
    expect(editor.state.selection.$from.parent.textContent).toBe("名前");
    caretIn(editor, 1, 1);
    press(editor, "Tab");
    type(editor, "本番");
    press(editor, "Enter");
    type(editor, "後日");
    expect(markdown()).toBe("前\n| 名前 | 期限 |\n| --- | ---: |\n| 予稿 | 10/3 |\n| 本番 |  |\n| 後日 |  |\n後");
    press(editor, "Enter", { shiftKey: true });
    expect(editor.state.selection.$from.parent.textContent).toBe("本番");
  });

  it("rows and columns added and deleted, a column's alignment; undo gives the bytes back", () => {
    const { editor, markdown } = open(BODY_TABLE);
    caretIn(editor, 1, 0);
    const run = (edit: Parameters<typeof editTable>[1]) => editor.view.dispatch(editTable(editor.state, edit)!);
    run("columnRight");
    type(editor, "新");
    expect(markdown()).toBe("前\n| 名前 |  | 締切 |\n| --- | --- | ---: |\n| 予稿 | 新 | 10/3 |\n後");
    run({ align: "center" });
    run("rowAbove");
    expect(markdown()).toBe("前\n| 名前 |  | 締切 |\n| --- | :---: | ---: |\n|  |  |  |\n| 予稿 | 新 | 10/3 |\n後");
    run("deleteRow");
    run("deleteColumn");
    expect(markdown()).toBe(BODY_TABLE); // the same cells as read again: the table as it was written
    for (let k = 0; k < 8; k++) editor.commands.undo();
    expect(markdown()).toBe(BODY_TABLE);
  });

  it("a deletion across two cells keeps the row as wide as the header", () => {
    const { editor, markdown } = open(BODY_TABLE);
    const { pos, node } = tableAt(editor);
    editor.view.dispatch(editor.state.tr.delete(cellPos(node, pos, 1, 0) + 1, cellPos(node, pos, 1, 1) + 2));
    expect(editor.state.doc.child(1).child(1).childCount).toBe(2);
    expect(markdown()).toBe("前\n| 名前 | 締切 |\n| --- | ---: |\n| 予/3 |  |\n後");
  });

  it("a 200 × 8 table: a key in a cell and the table written again stay fast", () => {
    const rows = ["| " + Array.from({ length: 8 }, (_, k) => `列${k}`).join(" | ") + " |", "| " + Array(8).fill("---").join(" | ") + " |"];
    for (let r = 0; r < 200; r++) rows.push("| " + Array.from({ length: 8 }, (_, k) => `値 ${r}-${k} **太**`).join(" | ") + " |");
    const { editor, markdown } = open(rows.join("\n"));
    const node = editor.state.doc.child(0);
    editor.commands.setTextSelection(cellPos(node, 0, 101, 3, true)); // row 0 is the header
    const started = performance.now();
    type(editor, "追記");
    const typed = performance.now();
    const written = markdown();
    const done = performance.now();
    expect(written.split("\n")[102]).toContain("値 100-3 **太追記**"); // typing on at a bold end stays bold
    // Measured on the development Mac (M5 Max, jsdom): see WIKI.md §28 (CI machines are slower).
    expect((typed - started) / 2).toBeLessThan(100);
    expect(done - typed).toBeLessThan(500);
  });
});

describe("M154: block selection (WIKI.md §30.1)", () => {
  const LINES = ["# 題", "本文の行", "- 親", "  - 子", "- 次", "::: callout 💡", "中の一", "中の二", ":::", "![](attachment:0190a2b4-0000-7000-8000-0000000000aa)", "最後"];
  const BODY_SEL = LINES.join("\n");
  const esc = (editor: Editor) => press(editor, "Escape");
  const arrow = (editor: Editor, key: "ArrowUp" | "ArrowDown", init: KeyboardEventInit = {}) => press(editor, key, init);
  const blocks = (editor: Editor) => editor.state.selection instanceof BlockSelection ? [editor.state.selection.from, editor.state.selection.to] : null;
  const selectedDom = (editor: Editor) => editor.view.dom.querySelectorAll(".pe-selected").length;
  /** The caret at the end of the inner block `inner` of the top-level block `index`. */
  const caretInside = (editor: Editor, index: number, inner: number) => {
    const container = editor.state.doc.child(index);
    let pos = before(editor, index) + 1;
    for (let k = 0; k < inner; k++) pos += container.child(k).nodeSize;
    editor.commands.setTextSelection(pos + container.child(inner).nodeSize - 1);
  };
  /** A clipboard for the editor's copy / cut / paste events (jsdom has none). */
  const clipboard = (editor: Editor) => {
    const data = new Map<string, string>();
    const transfer = { getData: (type: string) => data.get(type) ?? "", setData: (type: string, value: string) => void data.set(type, value), clearData: () => data.clear(), files: [], types: [] as string[], items: [] };
    return {
      data,
      fire: (type: "copy" | "cut" | "paste") => {
        const event = new Event(type, { bubbles: true, cancelable: true });
        Object.defineProperty(event, "clipboardData", { value: transfer });
        editor.view.dom.dispatchEvent(event);
      },
    };
  };

  it("Esc selects the caret's block (a list line with its deeper lines); in a callout the inner block first, then the callout; at the top it clears; nothing is written", () => {
    const { editor, markdown } = open(BODY_SEL);
    editor.view.focus();
    caretInBlock(editor, 1);
    esc(editor);
    expect(blocks(editor)).toEqual([before(editor, 1), before(editor, 2)]);
    expect(selectedDom(editor)).toBe(1);
    expect(editor.state.selection.visible).toBe(false);
    expect(editor.view.dom.classList.contains("ProseMirror-hideselection")).toBe(true);
    caretInBlock(editor, 2);
    esc(editor);
    expect(blocks(editor)).toEqual([before(editor, 2), before(editor, 4)]); // 親 with 子
    expect(selectedDom(editor)).toBe(2);
    caretInside(editor, 5, 0);
    esc(editor);
    expect(blocks(editor)).toEqual([before(editor, 5) + 1, before(editor, 5) + 1 + editor.state.doc.child(5).child(0).nodeSize]);
    expect(selectedDom(editor)).toBe(1);
    esc(editor);
    expect(blocks(editor)).toEqual([before(editor, 5), before(editor, 6)]);
    expect(editor.view.dom.querySelector(".pe-selected")?.matches("[data-callout]")).toBe(true);
    esc(editor);
    expect(editor.state.selection).toBeInstanceOf(TextSelection);
    expect(editor.state.selection.$from.parent.textContent).toBe("中の一");
    expect(selectedDom(editor)).toBe(0);
    expect(editor.view.dom.classList.contains("ProseMirror-hideselection")).toBe(false);
    expect(markdown()).toBe(BODY_SEL);
  });

  it("↑ / ↓ move block by block (a child line on its own), out of a callout at its end, onto the callout at its start; the page's edges stop", () => {
    const { editor, markdown } = open(BODY_SEL);
    caretInBlock(editor, 1);
    esc(editor);
    arrow(editor, "ArrowDown");
    expect(blocks(editor)).toEqual([before(editor, 2), before(editor, 4)]);
    arrow(editor, "ArrowDown");
    expect(blocks(editor)).toEqual([before(editor, 3), before(editor, 4)]);
    arrow(editor, "ArrowDown");
    arrow(editor, "ArrowDown");
    expect(blocks(editor)).toEqual([before(editor, 5), before(editor, 6)]); // the callout, not into it
    arrow(editor, "ArrowDown");
    expect(blocks(editor)).toEqual([before(editor, 6), before(editor, 7)]); // the image
    arrow(editor, "ArrowDown");
    arrow(editor, "ArrowDown");
    expect(blocks(editor)).toEqual([before(editor, 7), editor.state.doc.content.size]); // the last block stays
    arrow(editor, "ArrowUp");
    arrow(editor, "ArrowUp");
    expect(blocks(editor)).toEqual([before(editor, 5), before(editor, 6)]);
    caretInside(editor, 5, 1);
    esc(editor);
    arrow(editor, "ArrowDown");
    expect(blocks(editor)).toEqual([before(editor, 6), before(editor, 7)]); // out of the callout
    caretInside(editor, 5, 0);
    esc(editor);
    arrow(editor, "ArrowUp");
    expect(blocks(editor)).toEqual([before(editor, 5), before(editor, 6)]); // the callout itself
    for (let k = 0; k < 5; k++) arrow(editor, "ArrowUp");
    expect(blocks(editor)).toEqual([0, before(editor, 1)]);
    expect(markdown()).toBe(BODY_SEL);
  });

  it("Shift+↓ / ↑ extend and shrink by whole list items within the holder (never out of it); the anchor stays; Shift+click lifts to the anchor's holder", () => {
    const { editor } = open(BODY_SEL);
    caretInBlock(editor, 1);
    esc(editor);
    arrow(editor, "ArrowDown", { shiftKey: true });
    expect(blocks(editor)).toEqual([before(editor, 1), before(editor, 4)]); // 親 with 子
    arrow(editor, "ArrowDown", { shiftKey: true });
    expect(blocks(editor)).toEqual([before(editor, 1), before(editor, 5)]); // 次 (not 子 again)
    arrow(editor, "ArrowDown", { shiftKey: true });
    expect(blocks(editor)).toEqual([before(editor, 1), before(editor, 6)]);
    expect(selectedDom(editor)).toBe(5); // 本文の行, 親, 子, 次, the callout (its inner blocks are not marked)
    arrow(editor, "ArrowUp", { shiftKey: true });
    expect(blocks(editor)).toEqual([before(editor, 1), before(editor, 5)]);
    arrow(editor, "ArrowUp", { shiftKey: true });
    expect(blocks(editor)).toEqual([before(editor, 1), before(editor, 4)]); // back to 親 (with 子), one step
    for (let k = 0; k < 6; k++) arrow(editor, "ArrowUp", { shiftKey: true });
    expect(blocks(editor)).toEqual([0, before(editor, 2)]); // the head above the anchor; the anchor block stays in
    expect((editor.state.selection as BlockSelection).$anchorBlock.pos).toBe(before(editor, 1));
    // From below a list item, Shift+↑ takes the item with its deeper lines.
    caretInBlock(editor, 4);
    esc(editor);
    arrow(editor, "ArrowUp", { shiftKey: true });
    expect(blocks(editor)).toEqual([before(editor, 2), before(editor, 5)]);
    // Shift+click on a line inside the callout: the callout (lifted to the page).
    expect(extendTo(editor.state, before(editor, 5) + 2)!.to).toBe(before(editor, 6));
    // Inside the callout Shift+↓ stops at its last block, and a click outside it extends nothing.
    caretInside(editor, 5, 0);
    esc(editor);
    arrow(editor, "ArrowDown", { shiftKey: true });
    arrow(editor, "ArrowDown", { shiftKey: true });
    expect(blocks(editor)).toEqual([before(editor, 5) + 1, before(editor, 6) - 1]);
    expect(extendTo(editor.state, before(editor, 7) + 1)).toBeNull();
  });

  it("⌘A selects the block's text, then every block of the page", () => {
    const { editor } = open(BODY_SEL);
    caretInBlock(editor, 1);
    press(editor, "a", { ctrlKey: true }); // jsdom is not a Mac: Mod is Ctrl
    expect(editor.state.selection).toBeInstanceOf(TextSelection);
    expect([editor.state.selection.from, editor.state.selection.to]).toEqual([before(editor, 1) + 1, before(editor, 2) - 1]);
    press(editor, "a", { ctrlKey: true });
    expect(blocks(editor)).toEqual([0, editor.state.doc.content.size]);
    expect(selectedDom(editor)).toBe(editor.state.doc.childCount);
    press(editor, "a", { ctrlKey: true });
    expect(blocks(editor)).toEqual([0, editor.state.doc.content.size]);
  });

  it("Enter edits at the end of the block; a key typed does the same and goes in there; an image stays a node selection on Enter, a key makes a line under it", () => {
    const { editor, markdown } = open(BODY_SEL);
    caretInBlock(editor, 1, "start");
    esc(editor);
    press(editor, "Enter");
    expect(editor.state.selection).toBeInstanceOf(TextSelection);
    expect(editor.state.selection.$from.parent.textContent).toBe("本文の行");
    expect(editor.state.selection.$from.parentOffset).toBe(4);
    type(editor, "！");
    esc(editor);
    press(editor, "x");
    expect(editor.state.selection).toBeInstanceOf(TextSelection);
    type(editor, "x");
    expect(markdown()).toBe(BODY_SEL.replace("本文の行", "本文の行！x"));
    editor.view.dispatch(editor.state.tr.setSelection(BlockSelection.create(editor.state.doc, before(editor, 6))));
    press(editor, "Enter");
    expect(editor.state.selection).toBeInstanceOf(NodeSelection);
    editor.view.dispatch(editor.state.tr.setSelection(BlockSelection.create(editor.state.doc, before(editor, 6))));
    press(editor, "a");
    type(editor, "a");
    expect(markdown()).toBe(BODY_SEL.replace("本文の行", "本文の行！x").replace("0000000000aa)\n", "0000000000aa)\na\n"));
    // A callout: its last text; a toggle: its title.
    const toggled = open("::: toggle 題\n中\n:::\n::: callout\n一\n二\n:::");
    toggled.editor.view.dispatch(toggled.editor.state.tr.setSelection(BlockSelection.create(toggled.editor.state.doc, 0)));
    press(toggled.editor, "Enter");
    expect(toggled.editor.state.selection.$from.parent.type.name).toBe("toggleTitle");
    toggled.editor.view.dispatch(toggled.editor.state.tr.setSelection(BlockSelection.create(toggled.editor.state.doc, before(toggled.editor, 1))));
    press(toggled.editor, "Enter");
    expect(toggled.editor.state.selection.$from.parent.textContent).toBe("二");
  });

  it("Backspace / Delete remove the blocks in one undo step; the others keep their bytes; undo brings the bytes and the selection back; a callout emptied keeps a line", () => {
    const CRLF = LINES.join("\r\n");
    const { editor, markdown } = open(CRLF);
    caretInBlock(editor, 2);
    esc(editor);
    press(editor, "Backspace");
    expect(markdown()).toBe([...LINES.slice(0, 2), ...LINES.slice(4)].join("\r\n"));
    expect(editor.state.selection).toBeInstanceOf(TextSelection);
    editor.commands.undo();
    expect(markdown()).toBe(CRLF);
    expect(blocks(editor)).toEqual([before(editor, 2), before(editor, 4)]);
    caretInside(editor, 5, 0);
    esc(editor);
    arrow(editor, "ArrowDown", { shiftKey: true });
    press(editor, "Delete");
    expect(markdown()).toBe(CRLF.replace("中の一\r\n中の二\r\n", "")); // an empty callout is written without a line
    expect(editor.state.doc.child(5).childCount).toBe(1);
    editor.commands.undo();
    expect(markdown()).toBe(CRLF);
  });

  it("⌘D duplicates the blocks below (written anew, a task's hidden link not copied) and selects the copies; undo restores the bytes", () => {
    const BODY_D = "*   古い <!--task:0190a2b4-0000-7000-8000-000000000001-->\n    * 子\n後";
    const { editor, markdown } = open(BODY_D);
    caretInBlock(editor, 0);
    esc(editor);
    press(editor, "d", { ctrlKey: true });
    expect(markdown()).toBe("*   古い <!--task:0190a2b4-0000-7000-8000-000000000001-->\n    * 子\n- 古い\n  - 子\n後");
    expect(blocks(editor)).toEqual([before(editor, 2), before(editor, 4)]);
    press(editor, "d", { ctrlKey: true });
    expect(markdown()).toBe("*   古い <!--task:0190a2b4-0000-7000-8000-000000000001-->\n    * 子\n- 古い\n  - 子\n- 古い\n  - 子\n後");
    editor.commands.undo();
    editor.commands.undo();
    expect(markdown()).toBe(BODY_D);
  });

  it("⌘⇧↓ / ↑ move the selected blocks; the selection goes with them", () => {
    const { editor, markdown } = open(BODY_SEL);
    caretInBlock(editor, 1);
    esc(editor);
    press(editor, "ArrowDown", { ctrlKey: true, shiftKey: true });
    expect(markdown()).toBe([LINES[0], LINES[2], LINES[3], LINES[1], ...LINES.slice(4)].join("\n"));
    expect(editor.state.selection).toBeInstanceOf(BlockSelection);
    expect((editor.state.selection as BlockSelection).$anchorBlock.nodeAfter?.textContent).toBe("本文の行");
    press(editor, "ArrowUp", { ctrlKey: true, shiftKey: true });
    expect(markdown()).toBe(BODY_SEL);
    expect(blocks(editor)).toEqual([before(editor, 1), before(editor, 2)]);
  });

  it("⌘C puts the blocks' Markdown (their bytes) on the clipboard; ⌘V pastes after the blocks (written anew) and selects them; ⌘X takes them out; untouched blocks keep every byte", () => {
    const BODY_C = "# 題\r\n*   古い\r\n    * 子\r\n後";
    const { editor, markdown } = open(BODY_C);
    const clip = clipboard(editor);
    caretInBlock(editor, 1);
    esc(editor);
    clip.fire("copy");
    expect(clip.data.get("text/plain")).toBe("*   古い\r\n    * 子");
    expect(clip.data.get("text/html")).toContain("data-list-line");
    expect(markdown()).toBe(BODY_C);
    clip.fire("paste");
    expect(markdown()).toBe("# 題\r\n*   古い\r\n    * 子\r\n- 古い\n  - 子\n後");
    expect(blocks(editor)).toEqual([before(editor, 3), before(editor, 5)]);
    editor.view.dispatch(closeHistory(editor.state.tr)); // the paste and the cut would group as one undo step within 500 ms
    clip.fire("cut");
    expect(clip.data.get("text/plain")).toBe("- 古い\n  - 子");
    expect(markdown()).toBe(BODY_C);
    editor.commands.undo();
    expect(markdown()).toBe("# 題\r\n*   古い\r\n    * 子\r\n- 古い\n  - 子\n後");
    // Text copied out of a line pastes as a line of its own after the blocks; a callout cut empty keeps a line.
    editor.view.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, before(editor, 5) + 1, before(editor, 5) + 2)));
    clip.fire("copy");
    expect(clip.data.get("text/plain")).toBe("後");
    editor.view.dispatch(editor.state.tr.setSelection(BlockSelection.create(editor.state.doc, 0)));
    clip.fire("paste");
    expect(markdown()).toBe("# 題\r\n後\n*   古い\r\n    * 子\r\n- 古い\n  - 子\n後");
    const callout = open("::: callout 💡\n一\n二\n:::\n後");
    const inner = clipboard(callout.editor);
    callout.editor.view.dispatch(callout.editor.state.tr.setSelection(BlockSelection.create(callout.editor.state.doc, 1, 4)));
    inner.fire("cut");
    expect(inner.data.get("text/plain")).toBe("一\n二");
    expect(callout.markdown()).toBe("::: callout 💡\n:::\n後");
    expect(callout.editor.state.doc.child(0).childCount).toBe(1);
  });

  it("a merge from the server keeps the selection on its block, and lets it go when the block is gone", () => {
    const { editor, sources } = open(BODY_SEL);
    caretInBlock(editor, 1);
    esc(editor);
    expect(applyMerge(editor, sources, BODY_SEL.replace("最後", "最後（他）"), () => false)).toBe("partial");
    expect(blocks(editor)).toEqual([before(editor, 1), before(editor, 2)]);
    expect(applyMerge(editor, sources, BODY_SEL.replace("本文の行\n", "").replace("最後", "最後（他）"), () => false)).not.toBe("none");
    expect(editor.state.selection).not.toBeInstanceOf(BlockSelection);
  });

  it("JSON and the undo history's bookmark round-trip; an invalid position is refused", () => {
    const { editor } = open(BODY_SEL);
    const selection = BlockSelection.create(editor.state.doc, before(editor, 2), before(editor, 4));
    expect(selection.toJSON()).toEqual({ type: "block", anchor: before(editor, 2), head: before(editor, 4) });
    expect(Selection.fromJSON(editor.state.doc, selection.toJSON()).eq(selection)).toBe(true);
    expect(selection.getBookmark().resolve(editor.state.doc).eq(selection)).toBe(true);
    expect(() => BlockSelection.fromJSON(editor.state.doc, { anchor: 1, head: 1 })).toThrow(RangeError);
    expect(BlockSelection.valid(editor.state.doc, before(editor, 1), before(editor, 5) + 1)).toBe(false); // different holders
  });
});
