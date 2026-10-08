/**
 * M150 (WIKI.md §22.6, §27): the 見たまま page editor's document in and out of the save loop — the body read into the
 * editor, a merged body brought in (only the top-level blocks it changed are replaced, outside the undo history, the
 * selection mapped over the change), and the caret's place as a body line (switching to Markdown and back).
 */
import type { Editor, JSONContent } from "@tiptap/core";
import type { Node as PMNode } from "@tiptap/pm/model";
import { TextSelection } from "@tiptap/pm/state";

import { changedRange, pageToDoc, type RichNode } from "./pageMarkdown";
import { editorMarkdown, type SourceMap } from "./pageEditorSchema";

/** The editor's document for a body. */
export function createPageDocument(body: string, isEmoji: (name: string) => boolean): RichNode {
  return pageToDoc(body, { emoji: isEmoji });
}

/**
 * A body from elsewhere (a merge, someone else's version) put into the editor: the blocks that are still as read and
 * alike at the start and the end stay (their nodes, so node views and the caret stay too); the rest is replaced. When
 * the result would not write back as that body (a list line whose indent depends on its neighbours), the whole
 * document is replaced. "none" when the editor already holds it.
 */
export function applyMerge(editor: Editor, sources: SourceMap, body: string, isEmoji: (name: string) => boolean): "none" | "partial" | "full" {
  const doc = editor.state.doc;
  const fresh = createPageDocument(body, isEmoji);
  const view = sources.view();
  const old = view.children(doc);
  const range = changedRange(old, view, fresh.content ?? []);
  if (!range) {
    if (editorMarkdown(doc, sources).text === body) return "none";
  } else {
    let from = 0;
    for (let k = 0; k < range.from; k++) from += old[k]!.nodeSize;
    let to = from;
    for (let k = range.from; k < range.to; k++) to += old[k]!.nodeSize;
    const nodes = range.nodes.map((node) => editor.schema.nodeFromJSON(node as JSONContent));
    const tr = editor.state.tr.replaceWith(from, to, nodes);
    tr.setMeta("addToHistory", false);
    tr.setMeta("pageMerge", true);
    editor.view.dispatch(tr);
    sources.add(editor.state.doc);
    if (editorMarkdown(editor.state.doc, sources).text === body) return "partial";
  }
  const index = Math.min(editor.state.selection.$from.index(0), (fresh.content?.length ?? 1) - 1);
  const nodes = (fresh.content ?? []).map((node) => editor.schema.nodeFromJSON(node as JSONContent));
  const tr = editor.state.tr.replaceWith(0, editor.state.doc.content.size, nodes);
  tr.setMeta("addToHistory", false);
  tr.setMeta("pageMerge", true);
  tr.setSelection(TextSelection.near(tr.doc.resolve(blockStart(tr.doc, index) + 1)));
  editor.view.dispatch(tr);
  sources.clear();
  sources.add(editor.state.doc);
  return "full";
}

/** The position before the top-level block `index`. */
export function blockStart(doc: PMNode, index: number): number {
  let pos = 0;
  for (let k = 0; k < Math.min(index, doc.childCount); k++) pos += doc.child(k).nodeSize;
  return pos;
}

/** The body line the caret's top-level block starts on (switching to the Markdown editor puts its caret there). */
export function caretLine(editor: Editor, sources: SourceMap): number {
  const { starts } = editorMarkdown(editor.state.doc, sources);
  return starts[editor.state.selection.$from.index(0)] ?? 0;
}

/** The caret put at the start of the block that holds body line `line` (coming from the Markdown editor). */
export function placeCaretAtLine(editor: Editor, sources: SourceMap, line: number): void {
  const { starts } = editorMarkdown(editor.state.doc, sources);
  let index = 0;
  while (index + 1 < starts.length && starts[index + 1]! <= line) index++;
  const pos = blockStart(editor.state.doc, index);
  const tr = editor.state.tr.setSelection(TextSelection.near(editor.state.doc.resolve(Math.min(pos + 1, editor.state.doc.content.size))));
  editor.view.dispatch(tr.scrollIntoView());
}
