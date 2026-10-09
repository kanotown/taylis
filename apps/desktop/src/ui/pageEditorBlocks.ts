/**
 * M151 (WIKI.md §28): moving the page editor's blocks — what the ⋮⋮ handle, its menu and ⌘⇧↑ / ⌘⇧↓ act on. A block
 * is a child of the page, a callout or a toggle (a quote, a table, a toggle's title go with what holds them); a list
 * line takes the deeper lines after it (its children) along. Blocks keep their nodes when moved, so a block's source
 * (`src`) is written back as it was wherever the dialect reads it the same in the new place (checked on the lines
 * around it, pageMarkdown.readsAsShown); otherwise the moved blocks are written anew. A list moved under a shallower
 * line is lifted to fit (its children keep their depth below it). One move is one step of the undo history.
 */
import type { JSONContent } from "@tiptap/core";
import { Fragment, type Node as PMNode } from "@tiptap/pm/model";
import { type EditorState, Selection, TextSelection, type Transaction } from "@tiptap/pm/state";

import { CONTAINER_DEPTH } from "./markdown";
import { readsAsShown, type RichNode } from "./pageMarkdown";
import type { SourceMap } from "./pageEditorSchema";

/** What holds blocks that can move. */
const HOLDERS = new Set(["doc", "callout", "toggle"]);
const isContainer = (node: PMNode) => node.type.name === "callout" || node.type.name === "toggle";

/** One or more neighbouring blocks of one holder, moved together. */
export interface BlockUnit {
  /** The positions before its first block and after its last one. */
  from: number;
  to: number;
  /** Its blocks' indexes in their holder (`end` excluded). */
  first: number;
  end: number;
}

/** The first index of a holder that holds blocks (a toggle's title is not one). */
const firstBlock = (holder: PMNode) => (holder.type.name === "toggle" ? 1 : 0);

/**
 * The position before the block at `pos` (the deepest one a holder holds), or null. Between two blocks: the one after
 * (`side` "end": the one before, where a selection ends).
 */
export function blockPosAt(doc: PMNode, pos: number, side: "start" | "end" = "start"): number | null {
  const $pos = doc.resolve(Math.max(0, Math.min(pos, doc.content.size)));
  if (side === "end" && HOLDERS.has($pos.parent.type.name) && $pos.nodeBefore && $pos.index() > firstBlock($pos.parent)) return pos - $pos.nodeBefore.nodeSize;
  if (HOLDERS.has($pos.parent.type.name) && $pos.nodeAfter && $pos.index() >= firstBlock($pos.parent)) return pos;
  for (let d = $pos.depth; d >= 1; d--) {
    if (HOLDERS.has($pos.node(d - 1).type.name) && $pos.node(d).type.name !== "toggleTitle") return $pos.before(d);
  }
  if ($pos.depth === 0 && $pos.nodeBefore) return pos - $pos.nodeBefore.nodeSize;
  return null;
}

/** The block at `blockPos` with the deeper list lines after it. */
export function unitAt(doc: PMNode, blockPos: number): BlockUnit {
  const $at = doc.resolve(blockPos);
  const holder = $at.parent;
  const first = $at.index();
  const node = holder.child(first);
  let end = first + 1;
  let to = blockPos + node.nodeSize;
  if (node.type.name === "listLine") {
    while (end < holder.childCount && holder.child(end).type.name === "listLine" && holder.child(end).attrs.level > node.attrs.level) {
      to += holder.child(end).nodeSize;
      end++;
    }
  }
  return { from: blockPos, to, first, end };
}

/** The blocks the selection covers (one holder: the deepest that holds both ends), with the last one's children. */
export function selectedUnit(state: EditorState): BlockUnit | null {
  const { doc, selection } = state;
  let a = blockPosAt(doc, selection.from);
  // A selection that ends at the start of a line leaves that line out.
  const $to = doc.resolve(selection.to);
  let b = selection.empty ? a : blockPosAt(doc, $to.depth > 0 && $to.parent.isTextblock && $to.parentOffset === 0 ? $to.before() : selection.to, "end");
  if (a === null || b === null) return null;
  // Up to the holder both are in.
  for (let guard = 0; guard < 8; guard++) {
    const $a = doc.resolve(a);
    const $b = doc.resolve(b);
    if ($a.depth === $b.depth && $a.start() === $b.start()) break;
    if ($a.depth >= $b.depth) a = $a.before($a.depth);
    if ($b.depth >= $a.depth) b = $b.before($b.depth);
  }
  const last = unitAt(doc, Math.max(a, b));
  const head = unitAt(doc, Math.min(a, b));
  return { from: head.from, to: last.to, first: head.first, end: last.end };
}

/** How many callouts / toggles a node holds, one in another (its own included). */
function containerDepthOf(node: PMNode): number {
  let deepest = 0;
  node.forEach((child) => (deepest = Math.max(deepest, containerDepthOf(child))));
  return deepest + (isContainer(node) ? 1 : 0);
}

/** Whether the blocks `from`–`to` may go to `target` (a place between blocks of a holder; containers two deep at most). */
export function canPlace(doc: PMNode, unit: Pick<BlockUnit, "from" | "to">, target: number): boolean {
  if (target >= unit.from && target <= unit.to) return false;
  const $target = doc.resolve(target);
  if (!HOLDERS.has($target.parent.type.name) || $target.index() < firstBlock($target.parent)) return false;
  let around = 0;
  for (let d = 1; d <= $target.depth; d++) if (isContainer($target.node(d))) around++;
  let inside = 0;
  doc.slice(unit.from, unit.to).content.forEach((node) => (inside = Math.max(inside, containerDepthOf(node))));
  return around + inside <= CONTAINER_DEPTH;
}

/** The blocks `from`–`to` taken out (a holder left without blocks gets an empty line: it needs one). */
export function takeOut(tr: Transaction, from: number, to: number): void {
  const $from = tr.doc.resolve(from);
  const holder = $from.parent;
  const count = tr.doc.slice(from, to).content.childCount;
  if (count >= holder.childCount - firstBlock(holder)) tr.replaceWith(from, to, tr.doc.type.schema.nodes.paragraph!.create());
  else tr.delete(from, to);
}

/**
 * The transaction moving `unit` to `target` (a position in the document as it is), or null when it cannot go there.
 * The selection moves with the blocks when it was in them, else it goes to the start of the moved blocks.
 */
export function moveUnit(state: EditorState, unit: BlockUnit, target: number, sources: SourceMap, options: { emoji?: (name: string) => boolean } = {}): Transaction | null {
  if (!canPlace(state.doc, unit, target)) return null;
  const content = state.doc.slice(unit.from, unit.to).content;
  const tr = state.tr;
  takeOut(tr, unit.from, unit.to);
  const taken = tr.steps.length;
  const gap = tr.mapping.map(unit.from, -1);
  let at = tr.mapping.map(target);
  tr.insert(at, content);
  // Two quotes side by side would read as one: an empty line between (where the blocks went and where they were).
  const edges = [at + content.size, at, tr.mapping.slice(taken).map(gap, -1)].sort((x, y) => y - x);
  for (const edge of edges) {
    const $edge = tr.doc.resolve(edge);
    if ($edge.nodeBefore?.type.name !== "blockquote" || $edge.nodeAfter?.type.name !== "blockquote") continue;
    tr.insert(edge, state.schema.nodes.paragraph!.create());
    if (edge <= at) at += 2;
  }
  fitListLevels(tr, at, content.childCount);
  keepSource(tr, at, content.childCount, sources, options);
  const { selection } = state;
  if (selection.from >= unit.from && selection.to <= unit.to) {
    const json = selection.toJSON() as { anchor?: number; head?: number };
    const shift = at - unit.from;
    try {
      tr.setSelection(Selection.fromJSON(tr.doc, { ...json, ...(json.anchor !== undefined ? { anchor: json.anchor + shift } : {}), ...(json.head !== undefined ? { head: json.head + shift } : {}) }));
    } catch {
      tr.setSelection(Selection.near(tr.doc.resolve(at + 1)));
    }
  } else tr.setSelection(Selection.near(tr.doc.resolve(Math.min(at + 1, tr.doc.content.size))));
  return tr.scrollIntoView();
}

/**
 * A list put under a line: its first line at most one deeper than the list line before it (the top level after
 * anything else), the lines under it lifted by as much.
 */
function fitListLevels(tr: Transaction, at: number, count: number): void {
  const $at = tr.doc.resolve(at);
  const first = $at.nodeAfter;
  if (!first || first.type.name !== "listLine") return;
  const before = $at.nodeBefore;
  const cap = (kind: string) => (kind === "task" ? 1 : 2);
  const max = before?.type.name === "listLine" ? Math.min(cap(first.attrs.kind), before.attrs.level + 1) : 0;
  const shift = first.attrs.level > max ? max - first.attrs.level : 0;
  if (shift === 0) return;
  let pos = at;
  for (let k = 0; k < count; k++) {
    const node = tr.doc.nodeAt(pos)!;
    if (node.type.name === "listLine") tr.setNodeMarkup(pos, undefined, { ...node.attrs, level: Math.max(0, Math.min(node.attrs.level + shift, cap(node.attrs.kind))) });
    pos += node.nodeSize;
  }
}

/**
 * The moved blocks keep their source when the lines around them read as shown; else they are written anew (their
 * ties dropped: first the blocks', then those of the blocks inside them).
 */
function keepSource(tr: Transaction, at: number, count: number, sources: SourceMap, options: { emoji?: (name: string) => boolean }): void {
  const $at = tr.doc.resolve(at);
  const index = $at.index();
  let depth = 0;
  for (let d = 1; d <= $at.depth; d++) if (isContainer($at.node(d))) depth++;
  const reads = () => {
    // All the blocks of the holder: a line's reading can depend on lines far from it (an opener and its close).
    const holder = tr.doc.resolve(at).parent;
    const nodes: PMNode[] = [];
    for (let k = firstBlock(holder); k < holder.childCount; k++) nodes.push(holder.child(k));
    return readsAsShown(nodes, sources.view(), (node) => node.toJSON() as RichNode, depth, { emoji: options.emoji });
  };
  if (reads()) return;
  // Written anew, more and more: the moved blocks, the blocks inside them, the lines beside them (two `$$` lines
  // around a moved one read as a formula), every block of the holder.
  const untieRange = (from: number, to: number, deep: boolean) => {
    const holder = tr.doc.resolve(at).parent;
    let pos = tr.doc.resolve(at).start();
    for (let k = 0; k < holder.childCount; k++) {
      if (k >= from && k < to) untieAt(tr, pos, deep);
      pos += tr.doc.nodeAt(pos)!.nodeSize;
    }
  };
  const passes: Array<[number, number, boolean]> = [[index, index + count, false], [index, index + count, true], [index - 1, index + count + 1, true], [0, Number.MAX_SAFE_INTEGER, true]];
  for (const [from, to, deep] of passes) {
    untieRange(from, to, deep);
    if (reads()) return;
  }
}

/** A node at `pos` (and with `deep` the nodes inside it) no longer tied to the text it was read from. */
function untieAt(tr: Transaction, pos: number, deep: boolean): void {
  const node = tr.doc.nodeAt(pos);
  if (!node) return;
  if (typeof node.attrs.sig === "string") tr.setNodeMarkup(pos, undefined, { ...node.attrs, src: null, sig: null, ...("openSrc" in node.attrs ? { openSrc: null, closeSrc: null } : {}) });
  if (!deep || node.isTextblock || node.isAtom) return;
  const inner: number[] = [];
  tr.doc.nodeAt(pos)!.descendants((child, offset) => {
    if (typeof child.attrs.sig === "string") inner.push(pos + 1 + offset);
    return !child.isTextblock;
  });
  for (const at of inner) untieAt(tr, at, false);
}

/** Where `unit` goes one step up or down: past the block (or list item with its children) beside it, out of a holder at its edge. */
export function stepTarget(doc: PMNode, unit: BlockUnit, direction: -1 | 1): number | null {
  const $from = doc.resolve(unit.from);
  const holder = $from.parent;
  const start = $from.start();
  const posOf = (index: number) => {
    let pos = start;
    for (let k = 0; k < index; k++) pos += holder.child(k).nodeSize;
    return pos;
  };
  const head = holder.child(unit.first);
  if (direction < 0) {
    if (unit.first <= firstBlock(holder)) return $from.depth > 0 ? $from.before($from.depth) : null;
    let k = unit.first - 1;
    // Past a whole list item: back over the lines deeper than the one moved (any other block: deeper than the top),
    // to the item they belong to. (M154: a paragraph moved up no longer parts an item from its children.)
    const level = head.type.name === "listLine" ? (head.attrs.level as number) : 0;
    while (k > firstBlock(holder) && holder.child(k).type.name === "listLine" && holder.child(k).attrs.level > level && holder.child(k - 1).type.name === "listLine") k--;
    return posOf(k);
  }
  if (unit.end >= holder.childCount) return $from.depth > 0 ? $from.after($from.depth) : null;
  const next = unitAt(doc, posOf(unit.end));
  return next.to;
}

/** ⌘⇧↑ / ⌘⇧↓: the selected blocks one step up or down (null: they are at the page's edge). */
export function stepBlocks(state: EditorState, direction: -1 | 1, sources: SourceMap, options: { emoji?: (name: string) => boolean } = {}): Transaction | null {
  const unit = selectedUnit(state);
  if (!unit) return null;
  const target = stepTarget(state.doc, unit, direction);
  return target === null ? null : moveUnit(state, unit, target, sources, options);
}

/** The blocks of `unit` taken out of the page. */
export function deleteUnit(state: EditorState, unit: BlockUnit): Transaction {
  const tr = state.tr;
  takeOut(tr, unit.from, unit.to);
  tr.setSelection(Selection.near(tr.doc.resolve(Math.min(unit.from, tr.doc.content.size))));
  return tr.scrollIntoView();
}

/** A copy of `unit` after it, tied to nothing (written anew; a task's hidden link stays with the original only). */
export function duplicateUnit(state: EditorState, unit: BlockUnit, untie: (attrs: Record<string, unknown>) => Record<string, unknown>): Transaction {
  const copy = (node: RichNode): RichNode => ({ ...node, ...(node.attrs ? { attrs: untie(node.attrs) } : {}), ...(node.content ? { content: node.content.map(copy) } : {}) });
  const nodes: PMNode[] = [];
  state.doc.slice(unit.from, unit.to).content.forEach((node) => nodes.push(state.schema.nodeFromJSON(copy(node.toJSON() as RichNode) as JSONContent)));
  const tr = state.tr.insert(unit.to, Fragment.fromArray(nodes));
  tr.setSelection(Selection.near(tr.doc.resolve(unit.to + 1)));
  return tr.scrollIntoView();
}

/** An empty line put after `unit` (the ＋ beside the handle), the caret in it. */
export function lineAfter(state: EditorState, unit: BlockUnit, text = ""): Transaction {
  const { paragraph } = state.schema.nodes;
  const tr = state.tr.insert(unit.to, paragraph!.create(null, text ? state.schema.text(text) : null));
  tr.setSelection(TextSelection.create(tr.doc, unit.to + 1 + text.length));
  return tr.scrollIntoView();
}
