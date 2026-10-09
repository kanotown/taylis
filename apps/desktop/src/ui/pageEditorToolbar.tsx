/**
 * M155 (WIKI.md §30.2): what floats over a text selection in the 見たまま page editor — Notion's toolbar: 「変換 ▾」 (the
 * block's kind: the handle menu's list), bold, italic, strikethrough, code, inline math, a link (⌘K's box) — the 「変換」
 * list it and ⌘/ open, and the icons of the `/` menu's items (lucide, as the toolbars').
 *
 * When the toolbar shows is a pure function of the editor's state (`toolbarState`), so the schema tests check it
 * without React: a selection of text inside one text block, never collapsed, never during an IME composition, never on
 * a block selection (M154) or a selected atom. In a code block (code, math, raw Markdown) only 「コピー」 (code holds no
 * marks); in a table's cell, a toggle's title and a quote only the marks (no block of its own to turn). The toolbar sits
 * above the selection's first line (below its last line when the top of the pane is near), inside the editor's wrapper
 * so it scrolls with the text; Esc hides it until the selection changes (PageEditor.tsx).
 */
import type { ChainedCommands, Editor } from "@tiptap/core";
import { Fragment, type Node as PMNode } from "@tiptap/pm/model";
import { type EditorState, NodeSelection, Selection, TextSelection } from "@tiptap/pm/state";
import { Bold, Check, ChevronDown, ChevronRight, Code, Copy, Database, FilePlus, Heading1, Heading2, Heading3, Image as ImageIcon, Italic, LayoutGrid, Lightbulb, Link as LinkIcon, List, ListChecks, ListOrdered, Minus, Sigma, SquareCode, Strikethrough, Table as TableIcon, TextQuote, Type } from "lucide-react";
import { type KeyboardEvent as ReactKeyboardEvent, type ReactNode, useEffect, useLayoutEffect, useRef } from "react";

import type { SlashKey } from "./docEditor";
import { BlockSelection } from "./pageEditorSelection";
import { cn, modKey } from "./primitives";
import { type MessageKey, t } from "../i18n";

/** A kind a line turns into (the handle's menu, the toolbar's 「変換 ▾」, ⌘/). */
export type TurnKey = "text" | "h1" | "h2" | "h3" | "bullets" | "numbered" | "tasks" | "quote" | "callout" | "toggle" | "code" | "math";

/** The kinds a block turns into, in the order the menus show them. */
export const TURN_INTO: ReadonlyArray<{ key: TurnKey; label: MessageKey }> = [
  { key: "text", label: "docs.wysiwyg.text" },
  { key: "h1", label: "docs.slash.h1" },
  { key: "h2", label: "docs.slash.h2" },
  { key: "h3", label: "docs.slash.h3" },
  { key: "bullets", label: "docs.slash.bullets" },
  { key: "numbered", label: "docs.slash.numbered" },
  { key: "tasks", label: "docs.slash.tasks" },
  { key: "quote", label: "docs.slash.quote" },
  { key: "callout", label: "docs.slash.callout" },
  { key: "toggle", label: "docs.slash.toggle" },
  { key: "code", label: "docs.slash.code" },
  { key: "math", label: "docs.slash.math" },
];

/** The icon of a `/` item or of a kind of block. */
export function slashIcon(key: SlashKey | TurnKey, size = 15): ReactNode {
  switch (key) {
    case "text":
      return <Type size={size} />;
    case "h1":
      return <Heading1 size={size} />;
    case "h2":
      return <Heading2 size={size} />;
    case "h3":
      return <Heading3 size={size} />;
    case "bullets":
      return <List size={size} />;
    case "numbered":
      return <ListOrdered size={size} />;
    case "tasks":
      return <ListChecks size={size} />;
    case "quote":
      return <TextQuote size={size} />;
    case "callout":
      return <Lightbulb size={size} />;
    case "toggle":
      return <ChevronRight size={size} />;
    case "table":
      return <TableIcon size={size} />;
    case "code":
      return <SquareCode size={size} />;
    case "math":
      return <Sigma size={size} />;
    case "divider":
      return <Minus size={size} />;
    case "image":
      return <ImageIcon size={size} />;
    case "pageLink":
      return <LinkIcon size={size} />;
    case "childPage":
      return <FilePlus size={size} />;
    case "database":
      return <Database size={size} />;
    case "embedDatabase":
      return <LayoutGrid size={size} />;
  }
}

/** The kind of a block as the 「変換」 list names it (null: not a kind it offers, such as a table or an image). */
export function kindOf(node: PMNode | null | undefined): TurnKey | null {
  if (!node) return null;
  switch (node.type.name) {
    case "paragraph":
      return "text";
    case "heading":
      return `h${Number(node.attrs.level) || 1}` as TurnKey;
    case "listLine":
      return node.attrs.kind === "ordered" ? "numbered" : node.attrs.kind === "task" ? "tasks" : "bullets";
    case "blockquote":
      return "quote";
    case "callout":
    case "toggle":
      return node.type.name;
    case "codeBlock":
      return "code";
    case "mathBlock":
      return "math";
    default:
      return null;
  }
}

// --- when the toolbar shows ------------------------------------------------------------------------------------------------

/** What the toolbar offers: the marks and 「変換」, the marks alone, or 「コピー」 alone (a code block). */
export type ToolbarKind = "block" | "marks" | "code";

export interface ToolbarPlace {
  from: number;
  to: number;
  kind: ToolbarKind;
}

const HOLDERS = new Set(["doc", "callout", "toggle"]);
const LINES = new Set(["paragraph", "heading", "listLine"]);

/** The toolbar's place for the editor's state (null: nothing shows). */
export function toolbarState(state: EditorState, composing = false): ToolbarPlace | null {
  const { selection } = state;
  if (composing || selection.empty || selection instanceof BlockSelection || selection instanceof NodeSelection) return null;
  const { $from, $to } = selection;
  const parent = $from.parent;
  if (!parent.isTextblock || !$from.sameParent($to)) return null;
  if (parent.type.spec.code) return { from: selection.from, to: selection.to, kind: "code" };
  const line = LINES.has(parent.type.name) && $from.depth > 0 && HOLDERS.has($from.node($from.depth - 1).type.name);
  return { from: selection.from, to: selection.to, kind: line ? "block" : "marks" };
}

/** Whether the selected text is only text (inline math takes a run of text, not atoms). */
export function plainTextSelected(state: EditorState): boolean {
  const { from, to } = state.selection;
  let plain = true;
  state.doc.nodesBetween(from, to, (node) => {
    if (node.isInline && !node.isText) plain = false;
    return plain;
  });
  return plain && state.doc.textBetween(from, to, "", "￼").trim().length > 0;
}

/** Whether the selected text can be an inline formula: text alone (no atoms), on one line, without a `$` of its own. */
export function mathSelectable(state: EditorState): boolean {
  if (!plainTextSelected(state)) return false;
  const text = state.doc.textBetween(state.selection.from, state.selection.to, "\n", "￼");
  return !text.includes("$") && !text.includes("\n");
}

// --- what the toolbar and ⌘/ do -----------------------------------------------------------------------------------------

/** The selected text made an inline formula (`$…$`): its TeX is the text, spaces around it stay outside; the caret after it. */
export function wrapMath(editor: Editor): boolean {
  const { state } = editor;
  if (!mathSelectable(state)) return false;
  const { from, to } = state.selection;
  const raw = state.doc.textBetween(from, to, "", "");
  const lead = raw.length - raw.trimStart().length;
  const trail = raw.length - raw.trimEnd().length;
  const node = state.schema.nodes.inlineMath!.create({ tex: raw.trim() });
  const tr = state.tr.replaceWith(from + lead, to - trail, node);
  tr.setSelection(TextSelection.create(tr.doc, from + lead + node.nodeSize));
  editor.view.dispatch(tr.scrollIntoView());
  editor.commands.focus();
  return true;
}

/** A block kind the lines of the selection turn into (the `/` menu, 「変換」); false: not a kind of line. */
export function setKind(chain: ChainedCommands, key: SlashKey | TurnKey): boolean {
  switch (key) {
    case "text":
      chain.setNode("paragraph").run();
      return true;
    case "h1":
    case "h2":
    case "h3":
      chain.setNode("heading", { level: Number(key.slice(1)) }).run();
      return true;
    case "bullets":
      chain.setNode("listLine", { kind: "bullet", level: 0 }).run();
      return true;
    case "numbered":
      chain.setNode("listLine", { kind: "ordered", level: 0, number: 1 }).run();
      return true;
    case "tasks":
      chain.setNode("listLine", { kind: "task", level: 0 }).run();
      return true;
    case "quote":
      chain.setNode("paragraph").wrapIn("blockquote").run();
      return true;
    case "code":
      chain.setNode("codeBlock").run();
      return true;
    case "math":
      chain.setNode("mathBlock").run();
      return true;
    default:
      return false;
  }
}

/**
 * How many callouts / toggles the blocks `from`–`to` (the block at `from` alone without `to`) would be in if they were
 * wrapped in one more: those around them and the deepest inside them.
 */
export function containerDepthAt(editor: Editor | null, from: number, to: number | null = null): number {
  if (!editor) return 0;
  const { doc } = editor.state;
  const $pos = doc.resolve(from);
  let depth = 0;
  for (let d = 1; d <= $pos.depth; d++) if ($pos.node(d).type.name === "callout" || $pos.node(d).type.name === "toggle") depth++;
  const inner = (node: PMNode): number => {
    let deepest = 0;
    node.forEach((child) => (deepest = Math.max(deepest, inner(child))));
    return deepest + (node.type.name === "callout" || node.type.name === "toggle" ? 1 : 0);
  };
  let inside = 0;
  if (to === null) {
    const node = doc.nodeAt(from);
    inside = node ? inner(node) : 0;
  } else doc.slice(from, to).content.forEach((node) => (inside = Math.max(inside, inner(node))));
  return depth + inside;
}

/** The blocks ⌘/ turns: the selected blocks, or the caret's line in a holder (none in a table's cell, a toggle's title, a quote). */
export function turnRange(state: EditorState): { from: number; to: number } | null {
  const { selection } = state;
  if (selection instanceof BlockSelection) return { from: selection.from, to: selection.to };
  const { $from } = selection;
  if (!$from.parent.isTextblock || $from.depth === 0) return null;
  const holder = $from.node($from.depth - 1).type.name;
  if (!HOLDERS.has(holder) || !["paragraph", "heading", "listLine", "codeBlock", "mathBlock"].includes($from.parent.type.name)) return null;
  return { from: $from.before(), to: $from.after() };
}

/**
 * The blocks `from`–`to` (neighbours in one holder) turned into `key`: the lines' kinds keep their text, a callout or
 * toggle is put around them (several at once from ⌘/ on a block selection). `keep`: the text selection that stays (the
 * toolbar's and ⌘/'s pick); else the caret goes to the end of the last block (the handle's menu).
 */
export function turnBlocks(editor: Editor, from: number, to: number, key: TurnKey, keep: { from: number; to: number } | null = null): void {
  const { state } = editor;
  const { schema, doc } = state;
  if (key === "callout" || key === "toggle") {
    if (containerDepthAt(editor, from, to) >= 2) return;
    const content = doc.slice(from, to).content;
    let node: PMNode;
    if (key === "callout") node = schema.nodes.callout!.create({ icon: "💡" }, content);
    else {
      // The first line is the toggle's title; what follows is inside it (an empty line when nothing does).
      const first = content.firstChild!;
      const titled = first.isTextblock && first.inlineContent && !first.type.spec.code;
      const title = schema.nodes.toggleTitle!.create(null, titled ? first.content : null);
      const rest = titled ? content.cut(first.nodeSize) : content;
      node = schema.nodes.toggle!.create(null, Fragment.from(title).append(rest.childCount > 0 ? rest : Fragment.from(schema.nodes.paragraph!.create())));
    }
    const tr = state.tr.replaceWith(from, to, node);
    // The kept text is one position further in (inside the callout, or the toggle's title); else the end of the last block.
    tr.setSelection(keep ? TextSelection.create(tr.doc, keep.from + 1, keep.to + 1) : Selection.near(tr.doc.resolve(from + node.nodeSize - 1), -1));
    editor.view.dispatch(tr.scrollIntoView());
    editor.commands.focus();
    return;
  }
  const range = keep ?? { from: Selection.near(doc.resolve(from), 1).from, to: Selection.near(doc.resolve(to), -1).to };
  editor.view.dispatch(state.tr.setSelection(TextSelection.between(doc.resolve(range.from), doc.resolve(range.to))));
  setKind(editor.chain().focus(), key);
  if (!keep) editor.commands.setTextSelection(editor.state.selection.to);
}

// --- the toolbar -------------------------------------------------------------------------------------------------------------

/** Where the toolbar goes, relative to the wrapper: above the selection's first line, or below its last near the pane's top. */
function placeToolbar(editor: Editor, wrapper: HTMLElement, place: ToolbarPlace): { left: number; top: number; below: boolean; width: number } {
  const box = wrapper.getBoundingClientRect();
  try {
    const start = editor.view.coordsAtPos(place.from);
    const end = editor.view.coordsAtPos(place.to, -1);
    const pane = wrapper.closest("[data-wysiwyg-page]")?.getBoundingClientRect();
    // The sticky formatting row is 40px tall: the toolbar flips below the selection when it would go under it.
    const below = start.top - 44 < (pane?.top ?? 0) + 40;
    return { left: start.left - box.left, top: (below ? end.bottom : start.top) - box.top, below, width: box.width };
  } catch {
    // No layout to measure (a hidden pane, a test): the wrapper's top left.
    return { left: 0, top: 0, below: true, width: box.width };
  }
}

export function SelectionToolbar({ editor, wrapper, place, marks, mathEnabled, turnOpen, onToggle, onMath, onLink, onTurn, onCopy }: {
  editor: Editor;
  wrapper: HTMLElement;
  place: ToolbarPlace;
  /** The marks at the selection (pressed buttons). */
  marks: { bold: boolean; italic: boolean; strike: boolean; code: boolean };
  mathEnabled: boolean;
  turnOpen: boolean;
  onToggle: (mark: "bold" | "italic" | "strike" | "code") => void;
  onMath: () => void;
  onLink: () => void;
  /** 「変換 ▾」 pressed: its list under the button. */
  onTurn: (anchor: DOMRect) => void;
  onCopy: () => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  const at = placeToolbar(editor, wrapper, place);
  // Its own size is known once drawn: above the line means its bottom at the line's top; it stays inside the wrapper.
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    el.style.top = `${at.below ? at.top + 6 : at.top - 6 - el.offsetHeight}px`;
    el.style.left = `${Math.max(0, Math.min(at.left, at.width - el.offsetWidth))}px`;
  });
  const mod = modKey();
  const button = (key: string, label: string, icon: ReactNode, run: () => void, pressed?: boolean, disabled?: boolean) => (
    <button
      key={key}
      type="button"
      tabIndex={-1}
      aria-label={label}
      title={label}
      aria-pressed={pressed}
      disabled={disabled}
      className={cn("grid h-7 w-7 place-items-center rounded-md text-muted hover:bg-panel hover:text-ink disabled:opacity-40 disabled:hover:bg-transparent", pressed && "bg-accent-soft text-ink")}
      onMouseDown={(event) => event.preventDefault()}
      onClick={run}
    >
      {icon}
    </button>
  );
  const divider = <span aria-hidden className="mx-0.5 h-4 w-px shrink-0 bg-line" />;
  return (
    <div ref={box} role="toolbar" aria-label={t("docs.wysiwyg.selectionTools")} data-selection-toolbar={place.kind} className="absolute z-20 flex items-center gap-0.5 rounded-lg border border-line bg-canvas p-0.5 shadow-md" style={{ top: at.top, left: at.left }}>
      {place.kind === "code" && button("copy", t("docs.wysiwyg.copySelection"), <Copy size={15} />, onCopy)}
      {place.kind === "block" && (
        <>
          <button
            type="button"
            tabIndex={-1}
            aria-haspopup="menu"
            aria-expanded={turnOpen}
            title={`${t("docs.wysiwyg.turnInto")}（${mod}/）`}
            className={cn("flex h-7 items-center gap-0.5 rounded-md px-1.5 text-sm text-ink hover:bg-panel", turnOpen && "bg-panel")}
            onMouseDown={(event) => event.preventDefault()}
            onClick={(event) => onTurn(event.currentTarget.getBoundingClientRect())}
          >
            {t("docs.wysiwyg.turnInto")}
            <ChevronDown size={13} className="text-muted" aria-hidden="true" />
          </button>
          {divider}
        </>
      )}
      {place.kind !== "code" && (
        <>
          {button("bold", t("composer.format.boldKey", { key: `${mod}+B` }), <Bold size={15} />, () => onToggle("bold"), marks.bold)}
          {button("italic", t("composer.format.italicKey", { key: `${mod}+I` }), <Italic size={15} />, () => onToggle("italic"), marks.italic)}
          {button("strike", t("composer.format.strikeKey", { key: `${mod}+Shift+X` }), <Strikethrough size={15} />, () => onToggle("strike"), marks.strike)}
          {button("code", t("composer.format.codeKey", { key: `${mod}+E` }), <Code size={15} />, () => onToggle("code"), marks.code)}
          {button("math", t("docs.wysiwyg.inlineMath"), <Sigma size={15} />, onMath, undefined, !mathEnabled)}
          {divider}
          {button("link", t("composer.format.linkKey", { key: `${mod}+K` }), <LinkIcon size={15} />, onLink, editor.isActive("link"))}
        </>
      )}
    </div>
  );
}

// --- the 「変換」 list --------------------------------------------------------------------------------------------------------

/** ↑ / ↓ (Home / End) in a small menu of buttons: the focus moves, wrapping. */
export function stepMenuFocus(container: HTMLElement | null, event: ReactKeyboardEvent): void {
  if (event.key !== "ArrowDown" && event.key !== "ArrowUp" && event.key !== "Home" && event.key !== "End") return;
  event.preventDefault();
  const buttons = [...(container?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? [])];
  if (buttons.length === 0) return;
  const at = buttons.indexOf(document.activeElement as HTMLButtonElement);
  const next = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1 : (at + (event.key === "ArrowDown" ? 1 : buttons.length - 1)) % buttons.length;
  buttons[next]?.focus();
}

/** The kinds a block turns into, as a menu (the toolbar's 「変換 ▾」, ⌘/): the current kind is checked and focused first. */
export function TurnIntoList({ current, canWrap, onPick }: { current: TurnKey | null; canWrap: boolean; onPick: (key: TurnKey) => void }) {
  const menu = useRef<HTMLDivElement>(null);
  useEffect(() => {
    (menu.current?.querySelector<HTMLButtonElement>('[aria-checked="true"]') ?? menu.current?.querySelector<HTMLButtonElement>("button"))?.focus();
  }, []);
  return (
    <div ref={menu} role="menu" aria-label={t("docs.wysiwyg.turnMenu")} className="max-h-[70vh] overflow-y-auto" onKeyDown={(event) => stepMenuFocus(menu.current, event)}>
      <div className="px-2 pb-0.5 pt-1 text-[11px] font-semibold text-muted">{t("docs.wysiwyg.turnInto")}</div>
      {TURN_INTO.filter((kind) => canWrap || (kind.key !== "callout" && kind.key !== "toggle")).map((kind) => (
        <button
          key={kind.key}
          type="button"
          role="menuitemradio"
          aria-checked={kind.key === current}
          className="flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-sm hover:bg-panel focus-visible:bg-panel focus-visible:outline-none"
          onClick={() => onPick(kind.key)}
        >
          <span className="grid h-6 w-6 shrink-0 place-items-center rounded-md bg-panel text-muted">{slashIcon(kind.key, 14)}</span>
          <span className="min-w-0 flex-1 truncate">{t(kind.label)}</span>
          {kind.key === current && <Check size={14} className="text-accent" aria-hidden="true" />}
        </button>
      ))}
    </div>
  );
}
