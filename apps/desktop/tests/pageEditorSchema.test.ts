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
import { NodeSelection, TextSelection } from "@tiptap/pm/state";
import { afterEach, describe, expect, it } from "vitest";

import { blockPosAt, canPlace, deleteUnit, duplicateUnit, moveUnit, unitAt } from "../src/ui/pageEditorBlocks";
import { jsonView, readsAsShown, type RichNode } from "../src/ui/pageMarkdown";
import { applyMerge, createPageDocument } from "../src/ui/pageEditorDoc";
import { editorMarkdown, markdownSlice, pageExtensions, type PageEditorHost, PortalRegistry, SourceMap, untied } from "../src/ui/pageEditorSchema";

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
    render: { pageLink: () => null, emoji: () => null, image: () => null, embed: () => null, table: () => null, math: () => null, calloutIcon: () => null },
    mentionLabel: (md) => `@${md.slice(2, 6)}`,
    isEmoji: (name) => name === "smile" || name === "party",
    openTable: () => {},
    pickIcon: () => {},
    save: () => {},
    link: () => {},
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
  const editor = new Editor({ element, extensions: pageExtensions(host), content: createPageDocument(body, host.isEmoji) as JSONContent });
  sources.add(editor.state.doc);
  editors.push(editor);
  return { editor, sources, markdown: () => editorMarkdown(editor.state.doc, sources).text };
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

  it("a table replaced (as the table dialog does): only its lines", () => {
    const { editor, markdown } = open(BODY);
    let pos = 0;
    for (let k = 0; k < 19; k++) pos += editor.state.doc.child(k).nodeSize;
    const table = editor.state.doc.child(19);
    expect(table.type.name).toBe("table");
    editor.view.dispatch(editor.state.tr.setNodeMarkup(pos, undefined, { ...table.attrs, markdown: "| 名前 | 締切 |\n| --- | --- |\n| 本番 | 11/1 |" }));
    expect(markdown()).toBe(BODY.replace("| 予稿 | 10/3 |", "| 本番 | 11/1 |").replace("| 名前 | 締切 |\r\n| --- | --- |\r\n| 本番", "| 名前 | 締切 |\n| --- | --- |\n| 本番"));
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
