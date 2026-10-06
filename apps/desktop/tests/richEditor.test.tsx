// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Editor, type JSONContent } from "@tiptap/core";
import { afterEach, describe, expect, it } from "vitest";

import { extensions } from "../src/ui/RichEditor";
import { docToMarkdown, markdownToDoc, type RichNode } from "../src/ui/richMarkdown";

const shared = (name: string) => JSON.parse(readFileSync(resolve(__dirname, "../../shared", name), "utf8"));

let editors: Editor[] = [];
afterEach(() => {
  editors.forEach((e) => e.destroy());
  editors = [];
});

function editorWith(markdown: string): Editor {
  const element = document.createElement("div");
  document.body.append(element);
  const editor = new Editor({ element, extensions: extensions(""), content: markdownToDoc(markdown) as JSONContent });
  editors.push(editor);
  return editor;
}

const markdownOf = (editor: Editor) => docToMarkdown(editor.getJSON() as RichNode);

const samples: string[] = [
  ...shared("inline-format.json").cases.map((c: { line: string }) => c.line),
  ...shared("inline-format.json").code_blocks.map((c: { body: string }) => c.body),
  ...shared("lists.json").cases.map((c: { body: string }) => c.body),
  ...shared("body-paragraphs.json").cases.map((c: { body: string }) => c.body),
  "**bold** _italic_ ~~strike~~ `code` [link](https://example.com) https://example.com/a_b",
  "# h1\n## h2\n### h3",
  "> quote\n> two\n>\n> three",
  "- a\n  - b\n    - c\n1. x\n  1. y",
  "```ts\nconst a = 1;\n```",
  "| a | b |\n| --- | --- |\n| 1 | 2 |",
  "これは${ZWSP}_強調_${ZWSP}です".replace(/\$\{ZWSP\}/g, "​"),
  "​- not a list",
  "数式 $a_b$ と $$\\frac{1}{2}$$ と \\$5",
  "$$\nE = mc^2\n$$",
];

describe("rich editor schema", () => {
  it.each(samples.map((s) => [JSON.stringify(s).slice(0, 50), s]))("holds %s as the converter writes it", (_name, markdown) => {
    const editor = editorWith(markdown);
    expect(markdownOf(editor)).toBe(docToMarkdown(markdownToDoc(markdown)));
  });

  it("keeps one mark at a time", () => {
    const editor = editorWith("**bold**");
    editor.chain().selectAll().toggleItalic().run();
    expect(markdownOf(editor)).toBe("_bold_");
  });

  it("converts Markdown typed as it is typed (input rules)", () => {
    const type = (editor: Editor, text: string) => {
      for (const ch of text) {
        const { from, to } = editor.state.selection;
        const handled = editor.view.someProp("handleTextInput", (f) => f(editor.view, from, to, ch, () => editor.state.tr.insertText(ch, from, to)));
        if (!handled) editor.view.dispatch(editor.state.tr.insertText(ch, from, to));
      }
    };
    const cases: Array<[string, string]> = [
      ["**太字** ", "**太字** "],
      ["*太字* ", "**太字** "],
      ["文 _斜体_ ", "文 _斜体_ "],
      ["~~消~~ ", "~~消~~ "],
      ["`code` ", "`code` "],
      ["- item", "- item"],
      ["1. item", "1. item"],
      ["> quote", "> quote"],
      ["## head", "## head"],
      ["__init__ ", "__init__ "],
      ["snake_case_name ", "snake_case_name "],
      ["式 $a_1$ ", "式 $a_1$ "],
      ["$5 and $10 ", "$5 and $10 "],
    ];
    for (const [typed, expected] of cases) {
      const editor = editorWith("");
      editor.commands.focus("end");
      type(editor, typed);
      expect(markdownOf(editor), typed).toBe(expected);
    }
  });

  it("undoes and redoes", () => {
    const editor = editorWith("");
    editor.commands.insertContent("abc");
    editor.chain().selectAll().toggleBold().run();
    expect(markdownOf(editor)).toBe("**abc**");
    editor.commands.undo();
    expect(markdownOf(editor)).toBe("abc");
    editor.commands.redo();
    expect(markdownOf(editor)).toBe("**abc**");
  });

  it("does not nest lists deeper than three levels", () => {
    const editor = editorWith("- a\n  - b\n    - c");
    editor.commands.focus("end");
    editor.commands.keyboardShortcut("Tab");
    expect(markdownOf(editor)).toBe("- a\n  - b\n    - c");
  });

  it("keeps quotes to plain lines", () => {
    const editor = editorWith("> a");
    editor.commands.focus("end");
    editor.commands.toggleBulletList();
    expect(markdownOf(editor).startsWith("> ") || markdownOf(editor).startsWith("- ")).toBe(true);
    expect(markdownOf(editor)).not.toContain("> - ");
  });
});
