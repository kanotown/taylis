/**
 * M154 (WIKI.md §30.1): the block selection of the 見たまま page editor — Notion's "select the block" mode. Esc on text
 * selects the block the caret is in (in a callout or toggle: the inner block first, Esc again the container, once more
 * clears it and leaves the editor); ↑ / ↓ move to the block before / after (↑ at a container's first block selects the
 * container, ↓ at its last the block after it), Shift+↑ / ↓ extend the range within its holder, Shift+click too; ⌘A on
 * text selects the block's text, then every block; Enter edits at the end of the block, a key typed does the same and
 * goes in there; Backspace / Delete remove the blocks, ⌘D duplicates them below, ⌘⇧↑ / ↓ move them (M151,
 * ui/pageEditorBlocks.ts), ⌘C / ⌘X copy and cut them as their Markdown and HTML (ProseMirror's clipboard with
 * `content()` and `replace()`), ⌘V pastes after them (`pasteAfterBlocks`).
 *
 * `BlockSelection` is a ProseMirror selection whose anchor and head are blocks of one holder (the page, a callout, a
 * toggle); a list line selected takes the deeper lines after it, as the handle does (pageEditorBlocks.unitAt). It is
 * drawn by node decorations on the selected blocks only (never a scan of the page: WIKI.md §27.6) and hides the text
 * caret (`visible` false: ProseMirror's `ProseMirror-hideselection`). Selection changes alone are never written to
 * the body (PageEditor writes on document changes only).
 */
import { Extension } from "@tiptap/core";
import { Fragment, type Node as PMNode, type ResolvedPos, type Schema, Slice } from "@tiptap/pm/model";
import { type EditorState, NodeSelection, Plugin, PluginKey, Selection, SelectionRange, TextSelection, type Transaction } from "@tiptap/pm/state";
import type { Mappable } from "@tiptap/pm/transform";
import { Decoration, DecorationSet, type EditorView } from "@tiptap/pm/view";

import { isImeKeyEvent } from "./ime";
import { blockPosAt, deleteUnit, duplicateUnit, takeOut, unitAt } from "./pageEditorBlocks";

/** What holds blocks a selection can be of. */
const HOLDERS = new Set(["doc", "callout", "toggle"]);

/** Whether `pos` is right before a block of a holder (what the anchor and the head of a block selection are). */
function isBlockPos(doc: PMNode, pos: number): boolean {
  if (!Number.isInteger(pos) || pos < 0 || pos > doc.content.size) return false;
  const $pos = doc.resolve(pos);
  const node = $pos.nodeAfter;
  return !!node && node.isBlock && HOLDERS.has($pos.parent.type.name) && node.type.name !== "toggleTitle";
}

/** A selection of one or more neighbouring blocks of one holder: the anchor block and the head block (where it extends to). */
export class BlockSelection extends Selection {
  /** The position before the block the selection started on. */
  readonly $anchorBlock: ResolvedPos;
  /** The position before the block the selection extends to (the anchor block itself for one block). */
  readonly $headBlock: ResolvedPos;

  constructor($anchorBlock: ResolvedPos, $headBlock: ResolvedPos = $anchorBlock) {
    const doc = $anchorBlock.node(0);
    const first = Math.min($anchorBlock.pos, $headBlock.pos);
    // The last block takes its deeper list lines with it, as the handle and ⌘⇧↑↓ do.
    const last = unitAt(doc, Math.max($anchorBlock.pos, $headBlock.pos));
    const $from = doc.resolve(first);
    const $to = doc.resolve(last.to);
    // The anchor and head span the blocks in the DOM (a range, so the browser copies on ⌘C), in the selection's direction.
    const forward = $headBlock.pos >= $anchorBlock.pos;
    super(forward ? $from : $to, forward ? $to : $from, [new SelectionRange($from, $to)]);
    this.$anchorBlock = $anchorBlock;
    this.$headBlock = $headBlock;
  }

  /** Whether `anchor` and `head` are before blocks of the same holder of `doc`. */
  static valid(doc: PMNode, anchor: number, head: number = anchor): boolean {
    if (!isBlockPos(doc, anchor) || !isBlockPos(doc, head)) return false;
    const $a = doc.resolve(anchor);
    const $h = doc.resolve(head);
    return $a.depth === $h.depth && $a.start() === $h.start();
  }

  static create(doc: PMNode, anchor: number, head: number = anchor): BlockSelection {
    return new BlockSelection(doc.resolve(anchor), doc.resolve(head));
  }

  /** Every top-level block of the page (null when it has none). */
  static all(doc: PMNode): BlockSelection | null {
    return doc.childCount === 0 ? null : BlockSelection.create(doc, 0, doc.content.size - doc.lastChild!.nodeSize);
  }

  /** The selected blocks in order (the holder's children from the first to the last, deeper list lines included). */
  forEachBlock(f: (node: PMNode, pos: number) => void): void {
    const doc = this.$from.doc;
    let pos = this.from;
    while (pos < this.to) {
      const node = doc.nodeAt(pos)!;
      f(node, pos);
      pos += node.nodeSize;
    }
  }

  map(doc: PMNode, mapping: Mappable): Selection {
    const anchor = mapping.mapResult(this.$anchorBlock.pos, 1);
    const head = mapping.mapResult(this.$headBlock.pos, 1);
    if (!anchor.deleted && !head.deleted && BlockSelection.valid(doc, anchor.pos, head.pos)) return new BlockSelection(doc.resolve(anchor.pos), doc.resolve(head.pos));
    return Selection.near(doc.resolve(Math.min(head.pos, doc.content.size)));
  }

  eq(other: Selection): boolean {
    return other instanceof BlockSelection && other.$anchorBlock.pos === this.$anchorBlock.pos && other.$headBlock.pos === this.$headBlock.pos;
  }

  /** The blocks, closed (what ⌘C puts on the clipboard: their HTML, and their Markdown through the text serializer). */
  override content(): Slice {
    return this.$from.doc.slice(this.from, this.to);
  }

  /** The blocks replaced by `content` (⌘V without our paste handler), or taken out (⌘X, `deleteSelection`). */
  override replace(tr: Transaction, content: Slice = Slice.empty): void {
    const { from, to } = this;
    const blocks = blocksOf(content.content, tr.doc.type.schema);
    if (blocks.size === 0) {
      takeOut(tr, from, to);
      tr.setSelection(textNear(tr.doc, Math.min(from, tr.doc.content.size)));
      return;
    }
    tr.replaceWith(from, to, blocks);
    tr.setSelection(Selection.near(tr.doc.resolve(from + blocks.size), -1));
  }

  override replaceWith(tr: Transaction, node: PMNode): void {
    this.replace(tr, new Slice(Fragment.from(node), 0, 0));
  }

  override toJSON(): { type: string; anchor: number; head: number } {
    return { type: "block", anchor: this.$anchorBlock.pos, head: this.$headBlock.pos };
  }

  override getBookmark(): BlockBookmark {
    return new BlockBookmark(this.$anchorBlock.pos, this.$headBlock.pos);
  }

  static override fromJSON(doc: PMNode, json: { anchor?: unknown; head?: unknown }): BlockSelection {
    if (typeof json.anchor !== "number" || typeof json.head !== "number" || !BlockSelection.valid(doc, json.anchor, json.head)) throw new RangeError("Invalid input for BlockSelection.fromJSON");
    return BlockSelection.create(doc, json.anchor, json.head);
  }
}

BlockSelection.prototype.visible = false;
try {
  Selection.jsonID("block", BlockSelection);
} catch {
  // Registered already (another copy of this module in the same ProseMirror).
}

/** What the undo history keeps of a block selection (restored when the blocks come back). */
class BlockBookmark {
  constructor(readonly anchor: number, readonly head: number) {}

  map(mapping: Mappable): BlockBookmark {
    return new BlockBookmark(mapping.map(this.anchor, 1), mapping.map(this.head, 1));
  }

  resolve(doc: PMNode): Selection {
    return BlockSelection.valid(doc, this.anchor, this.head) ? BlockSelection.create(doc, this.anchor, this.head) : Selection.near(doc.resolve(Math.min(this.head, doc.content.size)));
  }
}

/** The nearest place for a text caret to `pos` (forward first), else whatever selection is there. */
function textNear(doc: PMNode, pos: number): Selection {
  const $pos = doc.resolve(pos);
  return Selection.findFrom($pos, 1, true) ?? Selection.findFrom($pos, -1, true) ?? Selection.near($pos);
}

/** `fragment` as blocks: inline content (text copied out of a line) in a paragraph of its own. */
function blocksOf(fragment: Fragment, schema: Schema): Fragment {
  const blocks: PMNode[] = [];
  let inline: PMNode[] = [];
  const flush = () => {
    if (inline.length > 0) blocks.push(schema.nodes.paragraph!.create(null, inline));
    inline = [];
  };
  fragment.forEach((node) => {
    if (node.isInline) inline.push(node);
    else {
      flush();
      blocks.push(node);
    }
  });
  flush();
  return Fragment.fromArray(blocks);
}

// --- what the keys do ---------------------------------------------------------------------------------------------------

/**
 * Esc: on text, the deepest block the caret is in; on a block selection, the callout or toggle holding it (null at the
 * top: the caller clears the selection).
 */
export function escapeSelection(state: EditorState): BlockSelection | null {
  const { doc, selection } = state;
  if (selection instanceof BlockSelection) {
    const $a = selection.$anchorBlock;
    return $a.depth === 0 ? null : BlockSelection.create(doc, $a.before($a.depth));
  }
  const pos = blockPosAt(doc, selection.from);
  return pos === null ? null : BlockSelection.create(doc, pos);
}

/** The position of the list item (with the lines deeper than it) that the line before index `index` belongs to. */
function itemBefore(holder: PMNode, start: number, index: number): number {
  const first = holder.type.name === "toggle" ? 1 : 0;
  let k = index - 1;
  while (k > first && holder.child(k).type.name === "listLine" && holder.child(k - 1).type.name === "listLine" && holder.child(k - 1).attrs.level < holder.child(k).attrs.level) k--;
  let pos = start;
  for (let i = 0; i < k; i++) pos += holder.child(i).nodeSize;
  return pos;
}

/**
 * ↑ / ↓: the block before / after the head, in the page's order (a list line's deeper lines are lines of their own). At
 * a holder's first block ↑ selects the holder (a callout or toggle), at its last ↓ the block after the holder. With
 * `extend` (Shift) the head alone moves, within the holder, by whole list items (the deeper lines already go with the
 * line above them). Null: nothing there.
 */
export function stepSelection(state: EditorState, direction: -1 | 1, extend: boolean): BlockSelection | null {
  const selection = state.selection;
  if (!(selection instanceof BlockSelection)) return null;
  const { doc } = state;
  const $head = selection.$headBlock;
  const holder = $head.parent;
  let next: number | null = null;
  if (extend) {
    if (direction > 0) {
      const after = unitAt(doc, $head.pos).to;
      if (after < $head.end()) next = after;
    } else if ($head.index() > (holder.type.name === "toggle" ? 1 : 0)) next = itemBefore(holder, $head.start(), $head.index());
    return next === null ? null : new BlockSelection(selection.$anchorBlock, doc.resolve(next));
  }
  if (direction > 0) {
    if ($head.index() + 1 < holder.childCount) next = $head.pos + $head.nodeAfter!.nodeSize;
    else if ($head.depth > 0) {
      let pos = $head.after($head.depth);
      for (;;) {
        const $pos = doc.resolve(pos);
        if ($pos.nodeAfter) {
          next = pos;
          break;
        }
        if ($pos.depth === 0) break;
        pos = $pos.after($pos.depth);
      }
    }
  } else {
    const first = holder.type.name === "toggle" ? 1 : 0;
    if ($head.index() > first) next = $head.pos - $head.nodeBefore!.nodeSize;
    else if ($head.depth > 0) next = $head.before($head.depth);
  }
  return next === null ? null : BlockSelection.create(doc, next);
}

/** Shift+click (or Shift and the handle): the range extended to the block at `pos`, lifted to the anchor's holder (null: not in it). */
export function extendTo(state: EditorState, pos: number): BlockSelection | null {
  const selection = state.selection;
  if (!(selection instanceof BlockSelection)) return null;
  const { doc } = state;
  const block = blockPosAt(doc, pos);
  if (block === null) return null;
  const $a = selection.$anchorBlock;
  let $p = doc.resolve(block);
  while ($p.depth > $a.depth) $p = doc.resolve($p.before($p.depth));
  if ($p.depth !== $a.depth || $p.start() !== $a.start()) return null;
  return new BlockSelection($a, $p);
}

/** ⌘A: the text of the caret's block; when that is selected already (or blocks are), every block of the page. */
export function selectMore(state: EditorState): Selection | null {
  const { doc, selection } = state;
  if (selection instanceof BlockSelection) return BlockSelection.all(doc);
  const { $from, $to } = selection;
  if ($from.parent.isTextblock && $from.sameParent($to) && !(selection.from === $from.start() && selection.to === $from.end())) return TextSelection.create(doc, $from.start(), $from.end());
  return BlockSelection.all(doc);
}

/**
 * Enter (or a key typed) on a block selection: the caret at the end of the head block (a toggle: its title; a callout, a
 * quote, a table: the last text in it). An atom (an image, a rule, an embed) stays selected as a node on Enter; a key
 * typed gets a new line under the blocks.
 */
export function editSelection(state: EditorState, typing: boolean): Transaction {
  const selection = state.selection as BlockSelection;
  const { doc } = state;
  const $head = selection.$headBlock;
  const node = $head.nodeAfter!;
  const tr = state.tr;
  if (node.isAtom || node.isLeaf) {
    if (!typing) tr.setSelection(NodeSelection.create(doc, $head.pos));
    else {
      tr.insert(selection.to, state.schema.nodes.paragraph!.create());
      tr.setSelection(TextSelection.create(tr.doc, selection.to + 1));
    }
  } else if (node.type.name === "toggle") tr.setSelection(TextSelection.create(doc, $head.pos + 1 + node.firstChild!.nodeSize - 1));
  else if (node.isTextblock) tr.setSelection(TextSelection.create(doc, $head.pos + node.nodeSize - 1));
  else tr.setSelection(Selection.near(doc.resolve($head.pos + node.nodeSize - 1), -1));
  return tr.scrollIntoView();
}

/** Backspace / Delete: the selected blocks taken out (one step of the undo history), the caret where they were. */
export function deleteSelection(state: EditorState): Transaction {
  const selection = state.selection as BlockSelection;
  return deleteUnit(state, { from: selection.from, to: selection.to, first: selection.$from.index(), end: selection.$to.index() });
}

/** ⌘D: a copy of the selected blocks after them (written anew), the copies selected. */
export function duplicateSelection(state: EditorState, untie: (attrs: Record<string, unknown>) => Record<string, unknown>): Transaction {
  const selection = state.selection as BlockSelection;
  const { from, to } = selection;
  const tr = duplicateUnit(state, { from, to, first: selection.$from.index(), end: selection.$to.index() }, untie);
  const last = blockPosAt(state.doc, to, "end") ?? from;
  tr.setSelection(BlockSelection.create(tr.doc, to, to + (last - from)));
  return tr;
}

/**
 * ⌘V on a block selection: what was pasted goes after the selected blocks (nothing is replaced), and is selected. False
 * when the selection is not of blocks (the editor pastes as usual).
 */
export function pasteAfterBlocks(view: EditorView, slice: Slice): boolean {
  const { state } = view;
  const selection = state.selection;
  if (!(selection instanceof BlockSelection)) return false;
  const blocks = blocksOf(slice.content, state.schema);
  if (blocks.size === 0) return true;
  const at = selection.to;
  const tr = state.tr.insert(at, blocks);
  tr.setSelection(BlockSelection.create(tr.doc, at, at + blocks.size - blocks.lastChild!.nodeSize));
  view.dispatch(tr.scrollIntoView().setMeta("paste", true).setMeta("uiEvent", "paste"));
  return true;
}

/** The selection a block selection leaves behind: a text caret at the start of its first block. */
export function clearedSelection(state: EditorState): Selection {
  return textNear(state.doc, state.selection.from);
}

// --- the extension ------------------------------------------------------------------------------------------------------

export const blockSelectionKey = new PluginKey("pageBlockSelection");

/** The keys of the block selection, its drawing (a class on the selected blocks) and Shift+click. */
export const BlockSelectionKeys = Extension.create<{ untie: (attrs: Record<string, unknown>) => Record<string, unknown>; editable: () => boolean }>({
  name: "pageBlockSelection",
  // Before the page's keys (Enter, Backspace, the arrows) and the marks' shortcuts.
  priority: 1100,
  addOptions: () => ({ untie: (attrs) => attrs, editable: () => true }),
  addProseMirrorPlugins() {
    const { editor } = this;
    const options = this.options;
    return [
      new Plugin({
        key: blockSelectionKey,
        props: {
          decorations: (state) => {
            const selection = state.selection;
            if (!(selection instanceof BlockSelection)) return null;
            const decorations: Decoration[] = [];
            selection.forEachBlock((node, pos) => decorations.push(Decoration.node(pos, pos + node.nodeSize, { class: "pe-selected" })));
            return DecorationSet.create(state.doc, decorations);
          },
          handleKeyDown: (view, event) => {
            const { state } = view;
            const selection = state.selection;
            const mod = event.metaKey || event.ctrlKey;
            if (!(selection instanceof BlockSelection)) {
              if (view.composing || isImeKeyEvent(event)) return false;
              if (event.key === "Escape" && !mod && !event.altKey && !event.shiftKey) {
                const next = escapeSelection(state);
                if (next) view.dispatch(state.tr.setSelection(next).scrollIntoView());
                else editor.commands.blur();
                return true;
              }
              if (mod && !event.shiftKey && !event.altKey && event.key.toLowerCase() === "a") {
                const next = selectMore(state);
                if (!next) return false;
                view.dispatch(state.tr.setSelection(next));
                return true;
              }
              return false;
            }
            if (view.composing) return false;
            const editable = options.editable();
            if (event.key === "Escape") {
              const up = escapeSelection(state);
              if (up) view.dispatch(state.tr.setSelection(up).scrollIntoView());
              else {
                view.dispatch(state.tr.setSelection(clearedSelection(state)));
                editor.commands.blur();
              }
              return true;
            }
            if (mod && !event.altKey) {
              const key = event.key.toLowerCase();
              if (!event.shiftKey && key === "a") {
                const next = selectMore(state);
                if (next) view.dispatch(state.tr.setSelection(next));
                return true;
              }
              if (!event.shiftKey && key === "d") {
                if (editable) view.dispatch(duplicateSelection(state, options.untie));
                return true;
              }
              // ⌘⇧↑ / ↓ (the page's keys), ⌘Z, ⌘C / X / V (the clipboard events), the marks' keys: as they are.
              return false;
            }
            if (event.altKey) return false;
            switch (event.key) {
              case "ArrowUp":
              case "ArrowDown":
              case "ArrowLeft":
              case "ArrowRight": {
                const vertical = event.key === "ArrowUp" || event.key === "ArrowDown";
                const next = stepSelection(state, event.key === "ArrowUp" || event.key === "ArrowLeft" ? -1 : 1, vertical && event.shiftKey);
                if (next) view.dispatch(state.tr.setSelection(next).scrollIntoView());
                return true;
              }
              case "Enter":
                view.dispatch(editSelection(state, false));
                return true;
              case "Backspace":
              case "Delete":
                if (editable) view.dispatch(deleteSelection(state));
                return true;
              case "Tab":
                return true;
              default:
                // A character (or an IME starting): editing at the end of the block, the key going in there.
                if (event.key.length === 1 || event.key === "Process" || isImeKeyEvent(event)) {
                  if (!editable) return true;
                  view.dispatch(editSelection(state, true));
                  return false;
                }
                return false;
            }
          },
          handleDOMEvents: {
            mousedown: (view, event) => {
              if (!event.shiftKey || event.button !== 0 || !(view.state.selection instanceof BlockSelection)) return false;
              const at = view.posAtCoords({ left: event.clientX, top: event.clientY });
              const next = at ? extendTo(view.state, at.inside >= 0 ? at.inside : at.pos) : null;
              if (!next) return false;
              event.preventDefault();
              view.dispatch(view.state.tr.setSelection(next));
              return true;
            },
          },
        },
      }),
    ];
  },
});
