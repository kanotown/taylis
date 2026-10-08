/**
 * M150 (WIKI.md §22.6, §27): the 見たまま (WYSIWYG) editor of a Docs page on Desktop / Web. Loaded lazily
 * (DocPage.tsx): TipTap and this file are their own chunk. The body stays Markdown: the editor reads it with
 * ui/pageMarkdown.ts and, once typing pauses (and on leaving, ⌘S, switching to Markdown, the window hiding), writes it
 * back and hands it to the same save loop as the Markdown editor (sync/canvasSave.ts: autosave, the server's merge,
 * versions, conflicts). Untouched blocks are written back as they were read, so opening and closing a page never
 * changes a byte; a merged body coming back replaces only the blocks it changed (ui/pageEditorDoc.ts). IME: the editor
 * takes no merged body while a composition is open or while an edit waits to be written (the loop keeps it for the
 * next save, which the server merges again).
 *
 * Like the Markdown editor: the `/` menu (anywhere in a line), `[[` page links (`![[` embeds a database), `@` mentions,
 * images pasted, dropped or picked (uploaded, then a block), tables through the table dialog. Markdown typed converts
 * (`# `, `- `, `1. `, `[] `, `> `, ``` ``` ```, `---`, `$$ `, `**x**`…); pasted text is read as Markdown, pasted HTML keeps
 * headings, lists, quotes, code and the marks.
 *
 * M151 (WIKI.md §28): a ⋮⋮ handle and a ＋ beside the block under the pointer (drag to move it, click for its menu:
 * turn into, duplicate, move, delete; ＋ opens the `/` menu on a new line under it), ⌘⇧↑ / ⌘⇧↓ (ui/pageEditorBlocks.ts).
 */
import { Editor, type JSONContent } from "@tiptap/core";
import type { Node as PMNode } from "@tiptap/pm/model";
import { Selection, TextSelection } from "@tiptap/pm/state";
import { AlignCenter, AlignLeft, AlignRight, ArrowDown, ArrowUp, AtSign, BetweenHorizontalEnd, BetweenHorizontalStart, BetweenVerticalEnd, BetweenVerticalStart, Columns3, Rows3, Bold, Code, Copy, GripVertical, Heading1, Heading2, Heading3, ImagePlus, Italic, Link as LinkIcon, List, ListChecks, ListOrdered, Loader2, Minus, Pencil, Plus, Strikethrough, Table as TableIcon, TextQuote, Trash2 } from "lucide-react";
import { type MouseEvent as ReactMouseEvent, type MutableRefObject, type ReactNode, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";

import { ApiError } from "../api/errors";
import type { PageRef } from "../api/types";
import { ATTACHMENT_MAX_BYTES, forEachPicked, isPickBusy, refusePicked, takePicked } from "../platform/pickedFiles";
import type { AppController } from "../state/app";
import type { CanvasSaver, SavedDoc } from "../sync/canvasSave";
import { DatabaseEmbed } from "./CanvasBody";
import type { DocEditorLinks } from "./CanvasEditor";
import { CanvasImage } from "./CanvasImage";
import { parseTable, sameTable, serializeTable, type Table } from "./canvasTable";
import { CanvasTableDialog } from "./CanvasTableDialog";
import { attachmentRefs, MAX_CANVAS_IMAGES } from "./canvasText";
import { CustomEmojiImage } from "./customEmoji";
import { type SlashKey, slashItems } from "./docEditor";
import { emojiByShortcode, replaceShortcodes } from "./emoji";
import { EmojiPicker } from "./EmojiPicker";
import { MathView } from "./MathView";
import { aiBotIds, encodeMentions, type MentionCandidate, mentionCandidates, mentionQuery, mentionsToNames } from "./mentions";
import { inline } from "./MessageBody";
import { OverflowToolbar, type ToolbarTool } from "./OverflowToolbar";
import { cellPlace, editTable, type TableEdit } from "./pageEditorTable";
import { blockPosAt, type BlockUnit, canPlace, deleteUnit, duplicateUnit, lineAfter, moveUnit, stepBlocks, unitAt } from "./pageEditorBlocks";
import { applyMerge, caretLine, createPageDocument, placeCaretAtLine } from "./pageEditorDoc";
import { editorMarkdown, markdownSlice, pageExtensions, type PageEditorHost, PortalRegistry, SourceMap, untied } from "./pageEditorSchema";
import { PageIcon } from "./PageIcon";
import { PageLinkChip } from "./PageLinkChip";
import { cn, modKey } from "./primitives";
import { type MessageKey, t } from "../i18n";

/** How long typing pauses before the document is written to Markdown (the save loop then waits its own 2 s). */
export const WRITE_DELAY_MS = 300;

/** What the page asks of the editor (switching to Markdown: the text written now, the caret's line). */
export interface PageEditorHandle {
  commit(): void;
  caretLine(): number;
}

type Menu =
  | { kind: "slash"; from: number; to: number; query: string }
  | { kind: "link"; from: number; to: number; query: string; embed: boolean }
  | { kind: "mention"; from: number; to: number; query: string };

const SLASH_AT = /(?:^|\s)\/([^\s/]{0,20})$/u;
const LINK_AT = /(!?)\[\[([^[\]\n]{0,80})$/;

export default function PageEditor({ controller, saver, links, initialLine = null, handle, className }: {
  controller: AppController;
  saver: CanvasSaver<SavedDoc>;
  links: DocEditorLinks;
  /** The body line to put the caret on (coming from the Markdown editor); null: the start. */
  initialLine?: number | null;
  handle?: MutableRefObject<PageEditorHandle | null>;
  className?: string;
}) {
  const store = controller.store;
  const hostElement = useRef<HTMLDivElement>(null);
  const editorRef = useRef<Editor | null>(null);
  const sources = useRef(new SourceMap()).current;
  const portals = useRef(new PortalRegistry()).current;
  const emitted = useRef(saver.text);
  const pending = useRef(false);
  const refused = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [menu, setMenu] = useState<Menu | null>(null);
  const [selected, setSelected] = useState(0);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState(0);
  const [tableEdit, setTableEdit] = useState<{ table: Table; isNew: boolean; pos: number | null } | null>(null);
  const [iconPick, setIconPick] = useState<{ pos: number; rect: DOMRect } | null>(null);
  const [linkEdit, setLinkEdit] = useState<{ href: string; rect: DOMRect } | null>(null);
  // M151: the ⋮⋮ handle of the block under the pointer, a drag in progress, the handle's menu.
  const wrapper = useRef<HTMLDivElement>(null);
  const [hovered, setHovered] = useState<{ pos: number; top: number; left: number } | null>(null);
  const [dropLine, setDropLine] = useState<{ top: number; left: number; width: number } | null>(null);
  const [blockMenu, setBlockMenu] = useState<{ pos: number; rect: DOMRect } | null>(null);
  const dragging = useRef(false);
  // M151: the table the caret is in and the caret's column (its tools above it; typing in it draws nothing more).
  const [tableAt, setTableAt] = useState<{ pos: number; col: number; align: unknown } | null>(null);
  const picker = useRef<HTMLInputElement>(null);
  useSyncExternalStore((listener) => portals.subscribe(listener), () => portals.version);
  useSyncExternalStore((listener) => saver.subscribe(listener), () => saver.textRevision);

  const isEmoji = (name: string) => !!emojiByShortcode(name) || store.customEmoji.has(name);

  /** The document written as Markdown and handed to the save loop (nothing when it is what the loop holds). */
  const commit = () => {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    const editor = editorRef.current;
    if (!editor || !pending.current) return;
    pending.current = false;
    const markdown = editorMarkdown(editor.state.doc, sources).text;
    if (markdown !== emitted.current) {
      emitted.current = markdown;
      saver.edit(markdown);
    } else if (refused.current) saver.compositionEnded(); // a merge waited for nothing: read it now
    refused.current = false;
  };
  const commitRef = useRef(commit);
  commitRef.current = commit;

  // The page around the nodes (portals, dialogs); read through a ref so the editor is built once.
  const live = useRef({ controller, links });
  live.current = { controller, links };
  const host = useMemo<PageEditorHost>(() => ({
    portals,
    sources,
    render: {
      pageLink: (id, label) => <PageLinkChip controller={live.current.controller} pageId={id} label={label || undefined} />,
      emoji: (md) => {
        const name = md.slice(1, -1);
        const custom = store.customEmoji.get(name);
        if (custom) return <CustomEmojiImage controller={live.current.controller} emoji={custom} size="1.375em" inline />;
        return <span>{replaceShortcodes(md)}</span>;
      },
      image: (attachmentId, alt) => <CanvasImage controller={live.current.controller} attachmentId={attachmentId} alt={alt} />,
      embed: (pageId, viewId) => <DatabaseEmbed controller={live.current.controller} pageId={pageId} viewId={viewId} />,
      math: (tex) => (tex.trim() ? <MathView tex={tex.trim()} display /> : <span className="text-xs text-muted">{t("docs.wysiwyg.mathEmpty")}</span>),
      calloutIcon: (icon) => (icon ? <span aria-hidden="true">{inline([{ kind: "text", text: icon }], store.users, { customEmoji: store.customEmoji, controller: live.current.controller })}</span> : <span className="text-muted" aria-hidden="true">＋</span>),
    },
    mentionLabel: (md) => mentionsToNames(md, store.users, store.groups),
    isEmoji: (name) => !!emojiByShortcode(name) || store.customEmoji.has(name),
    pickIcon: (pos, anchor) => setIconPick({ pos, rect: anchor.getBoundingClientRect() }),
    save: () => {
      commitRef.current();
      void saver.flush();
    },
    link: () => openLink(),
    text: {
      placeholder: t("docs.wysiwyg.placeholder"),
      editTable: t("docs.wysiwyg.editTable"),
      raw: t("docs.wysiwyg.raw"),
      toggleOpen: t("docs.wysiwyg.toggleOpen"),
      toggleClose: t("docs.wysiwyg.toggleClose"),
      checkbox: t("tasks.dialog.complete"),
      changeIcon: t("docs.wysiwyg.changeIcon"),
      untitledToggle: t("docs.wysiwyg.toggleTitle"),
    },
    editable: () => true,
    // Built once; the latest page is read through `live`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }), []);

  useLayoutEffect(() => {
    const element = hostElement.current;
    if (!element) return;
    const started = performance.now();
    const editor = new Editor({
      element,
      extensions: pageExtensions(host),
      content: createPageDocument(saver.text, isEmoji) as JSONContent,
      editorProps: {
        attributes: { "aria-label": t("docs.wysiwyg.body"), "aria-multiline": "true", role: "textbox", class: "body page-editor", spellcheck: "false" },
        // The caret is kept clear of the window's edges (the sticky toolbar above, the menus below).
        scrollThreshold: { top: 60, bottom: 120, left: 0, right: 0 },
        scrollMargin: { top: 60, bottom: 120, left: 0, right: 0 },
        handleKeyDown: (view, event) => keyDown(event, view.composing),
        handlePaste: (view, event) => {
          const files = Array.from(event.clipboardData?.files ?? []);
          if (files.length === 0 && view.state.selection.$from.parent.type.name === "tableCell") {
            // M151: a cell holds one line: what is pasted, its lines joined.
            const text = (event.clipboardData?.getData("text/plain") ?? "").replace(/\s*\r?\n\s*/g, " ").trim();
            const slice = markdownSlice(editorRef.current!, text, isEmoji);
            view.dispatch((slice.openStart > 0 && slice.content.childCount === 1 ? view.state.tr.replaceSelection(slice) : view.state.tr.insertText(text)).scrollIntoView());
            return true;
          }
          if (files.length === 0) return false;
          void insertImages(files);
          return true;
        },
        handleDrop: (_view, event) => {
          const files = Array.from(event.dataTransfer?.files ?? []);
          if (files.length === 0) return false;
          event.preventDefault();
          void insertImages(files);
          return true;
        },
        // Text pasted is read as page Markdown (blocks, marks, links); the editor's own copies keep their HTML.
        clipboardTextParser: (text) => markdownSlice(editorRef.current!, text, isEmoji),
        // What a copy puts on the clipboard as text: the Markdown of what was selected.
        clipboardTextSerializer: (slice) => {
          const doc = editorRef.current!.schema.topNodeType.create(null, slice.content.childCount > 0 && slice.content.firstChild?.isInline ? editorRef.current!.schema.nodes.paragraph!.create(null, slice.content) : slice.content);
          return editorMarkdown(doc, new SourceMap()).text;
        },
        transformPastedHTML: flattenPastedLists,
        handleDOMEvents: {
          compositionend: () => {
            saver.compositionEnded();
            return false;
          },
          blur: () => {
            commitRef.current();
            void saver.flush();
            return false;
          },
        },
      },
      onUpdate: ({ transaction }) => {
        if (transaction.getMeta("pageMerge")) return;
        pending.current = true;
        if (timer.current) clearTimeout(timer.current);
        timer.current = setTimeout(() => commitRef.current(), WRITE_DELAY_MS);
      },
      onTransaction: ({ editor: current, transaction }) => {
        findMenu(current);
        // The block handle goes with any change (typing, a move); the pointer brings it back.
        if (transaction.docChanged) setHovered(null);
        const place = cellPlace(current.state);
        const align: unknown = place?.table.child(0).maybeChild(place.col)?.attrs.align ?? null;
        setTableAt((was) => (!place ? null : was?.pos === place.tablePos && was.col === place.col && was.align === align ? was : { pos: place.tablePos, col: place.col, align }));
      },
    });
    sources.add(editor.state.doc);
    editorRef.current = editor;
    if (initialLine !== null && initialLine > 0) placeCaretAtLine(editor, sources, initialLine);
    editor.commands.focus(initialLine !== null && initialLine > 0 ? undefined : "start");
    element.setAttribute("data-open-ms", String(Math.round(performance.now() - started)));
    if (handle) handle.current = { commit: () => commitRef.current(), caretLine: () => caretLine(editor, sources) };
    // The loop must not put a merged body in while a composition is open or an edit waits to be written.
    saver.canReplace = () => {
      const ok = !editor.view.composing && !pending.current;
      if (!ok) refused.current = true;
      return ok;
    };
    const onHide = () => {
      if (document.visibilityState !== "hidden") return;
      commitRef.current();
      void saver.flush();
    };
    document.addEventListener("visibilitychange", onHide);
    return () => {
      document.removeEventListener("visibilitychange", onHide);
      commitRef.current();
      saver.canReplace = () => true;
      if (handle) handle.current = null;
      editorRef.current = null;
      editor.destroy();
    };
    // Built once per page (DocPage keys it by the page); the body is followed below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The loop replaced the body (a merge, someone else's version, a tick elsewhere): only the blocks it changed.
  useEffect(() => {
    const editor = editorRef.current;
    if (!editor || saver.text === emitted.current) return;
    emitted.current = saver.text;
    applyMerge(editor, sources, saver.text, isEmoji);
  }, [saver.textRevision]); // eslint-disable-line react-hooks/exhaustive-deps

  // --- the menus (`/`, `[[`, `@`) -----------------------------------------------------------------------------------------

  function findMenu(editor: Editor) {
    const { selection } = editor.state;
    const { $from } = selection;
    if (!selection.empty || !$from.parent.isTextblock || $from.parent.type.spec.code || editor.isActive("code")) {
      setMenu(null);
      return;
    }
    const before = $from.parent.textBetween(0, $from.parentOffset, "\n", "￼");
    const inCell = $from.parent.type.name === "tableCell";
    const link = LINK_AT.exec(before);
    if (link) {
      const length = link[0].length;
      setMenu({ kind: "link", from: $from.pos - length, to: $from.pos, query: link[2] ?? "", embed: link[1] === "!" && !!links.lookupDatabases && !inCell });
      return;
    }
    // A table's cell holds a line: no blocks there.
    const slash = inCell ? null : SLASH_AT.exec(before);
    if (slash) {
      const length = (slash[1] ?? "").length + 1;
      setMenu({ kind: "slash", from: $from.pos - length, to: $from.pos, query: slash[1] ?? "" });
      return;
    }
    const mention = mentionQuery(before, before.length);
    if (mention) {
      setMenu({ kind: "mention", from: $from.pos - (before.length - mention.start), to: $from.pos, query: mention.query });
      return;
    }
    setMenu(null);
  }

  const menuKey = menu ? `${menu.kind}:${menu.from}:${menu.query}` : null;
  const [linkResults, setLinkResults] = useState<{ key: string; pages: PageRef[] } | null>(null);
  useEffect(() => {
    if (!menu || menu.kind !== "link" || dismissed === menuKey) return;
    const key = menuKey!;
    const query = menu.query.trim();
    const timer = setTimeout(() => {
      void (menu.embed && links.lookupDatabases ? links.lookupDatabases(query) : links.lookup(query)).then((pages) => setLinkResults({ key, pages }), () => setLinkResults({ key, pages: [] }));
    }, 120);
    return () => clearTimeout(timer);
  }, [menuKey]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => setSelected(0), [menuKey]);

  const open = !!menu && dismissed !== menuKey;
  const depth = containerDepth(editorRef.current);
  const slashList = open && menu.kind === "slash" ? slashItems(menu.query).filter((item) => (item.key !== "callout" && item.key !== "toggle") || depth < 2) : [];
  const pageList = open && menu.kind === "link" && linkResults?.key === menuKey ? linkResults.pages : [];
  const mentionList: MentionCandidate[] = open && menu.kind === "mention" ? mentionCandidates(menu.query, [...store.users.values()], [...store.groups.values()], 8, aiBotIds(store)).filter((c) => c.kind !== "all") : [];
  const listLength = slashList.length || pageList.length || mentionList.length;
  const active = Math.min(selected, Math.max(listLength - 1, 0));
  const state = useRef({ listLength, active, slashList, pageList, mentionList, menu, menuKey });
  state.current = { listLength, active, slashList, pageList, mentionList, menu, menuKey };

  /** A key before the editor's own handling; true when a menu took it. Never during an IME composition. */
  function keyDown(event: KeyboardEvent, composing: boolean): boolean {
    if (composing || event.isComposing || event.keyCode === 229) return false;
    const current = state.current;
    if (current.listLength > 0) {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        setSelected((current.active + (event.key === "ArrowDown" ? 1 : current.listLength - 1)) % current.listLength);
        return true;
      }
      if (event.key === "Enter" || event.key === "Tab") {
        if (current.pageList.length > 0) pickPage(current.pageList[current.active]!);
        else if (current.slashList.length > 0) pickSlash(current.slashList[current.active]!.key);
        else if (current.mentionList.length > 0) pickMention(current.mentionList[current.active]!);
        return true;
      }
      if (event.key === "Escape") {
        setDismissed(current.menuKey);
        return true;
      }
    }
    if (event.key === "Escape") {
      // Leaves the editor only (the screen's Esc would switch back to the messages).
      event.stopPropagation();
      editorRef.current?.commands.blur();
      return true;
    }
    return false;
  }

  /** `[[query` (or `![[query`) replaced by a page's link (or a database's embed, on a line of its own). */
  function pickPage(page: PageRef) {
    const editor = editorRef.current;
    const current = state.current.menu;
    if (!editor || !current || current.kind !== "link") return;
    if (current.embed) {
      editor.chain().focus().deleteRange({ from: current.from, to: current.to }).run();
      void embedDatabase(page);
      return;
    }
    editor.chain().focus().deleteRange({ from: current.from, to: current.to }).insertContent([{ type: "pageLink", attrs: { id: page.id, label: linkLabel(page.title) } }, { type: "text", text: " " }]).run();
  }

  async function embedDatabase(page: PageRef) {
    setBusy(true);
    const viewId = links.embedView ? await links.embedView(page.id) : null;
    setBusy(false);
    putBlock({ type: "embed", attrs: { pageId: page.id, viewId, label: linkLabel(page.title) } });
  }

  function pickMention(candidate: MentionCandidate) {
    const editor = editorRef.current;
    const current = state.current.menu;
    if (!editor || !current || current.kind !== "mention") return;
    const md = encodeMentions(`@${candidate.username}`, store.users.values(), store.groups.values());
    const user = /^<@([0-9a-f-]{36})>$/.exec(md);
    const group = /^<@group:([0-9a-f-]{36})>$/.exec(md);
    const atom = user ? { md, kind: "user", id: user[1] } : group ? { md, kind: "group", id: group[1] } : null;
    const chain = editor.chain().focus().deleteRange({ from: current.from, to: current.to });
    if (atom) chain.insertContent([{ type: "mention", attrs: atom }, { type: "text", text: " " }]).run();
    else chain.insertContent(`@${candidate.username} `).run();
  }

  /**
   * A block put in for the `/` menu or a dialog: in place of the empty line the caret is on, else after the caret's
   * block. An atom gets a line after it when nothing follows; the caret goes into the block (or after the atom).
   */
  function putBlock(json: JSONContent, caretAt: "inside" | "after" = "inside") {
    const editor = editorRef.current;
    if (!editor) return;
    const { state: editorState } = editor;
    const { $from } = editorState.selection;
    const node = editor.schema.nodeFromJSON(json);
    const tr = editorState.tr;
    const textblock = $from.parent;
    let pos: number;
    if (textblock.type.name === "paragraph" && textblock.content.size === 0) {
      pos = $from.before();
      tr.replaceWith(pos, $from.after(), node);
    } else {
      pos = $from.depth > 0 ? $from.after() : editorState.selection.to;
      tr.insert(pos, node);
    }
    const after = pos + node.nodeSize;
    if (node.isAtom || caretAt === "after") {
      if (!tr.doc.resolve(after).nodeAfter) tr.insert(after, editor.schema.nodes.paragraph!.create());
      tr.setSelection(TextSelection.near(tr.doc.resolve(after + 1)));
    } else tr.setSelection(TextSelection.near(tr.doc.resolve(pos + 1)));
    editor.view.dispatch(tr.scrollIntoView());
    editor.commands.focus();
  }

  /** A block kind the line at the caret turns into (the `/` menu, the handle's 「変換」); false: not a kind of line. */
  function setKind(chain: ReturnType<Editor["chain"]>, key: SlashKey | "text"): boolean {
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

  function pickSlash(key: SlashKey) {
    const editor = editorRef.current;
    const current = state.current.menu;
    if (!editor || !current || current.kind !== "slash") return;
    const chain = editor.chain().focus().deleteRange({ from: current.from, to: current.to });
    if (setKind(chain, key)) return;
    switch (key) {
      case "callout":
        chain.run();
        putBlock({ type: "callout", attrs: { icon: "💡" }, content: [{ type: "paragraph" }] });
        return;
      case "toggle":
        chain.run();
        putBlock({ type: "toggle", content: [{ type: "toggleTitle" }, { type: "paragraph" }] });
        return;
      case "divider":
        chain.run();
        putBlock({ type: "horizontalRule" });
        return;
      case "pageLink":
        chain.insertContent("[[").run();
        return;
      case "embedDatabase":
        chain.insertContent("![[").run();
        return;
      case "table":
        chain.run();
        setTableEdit({ table: newTableFor(), isNew: true, pos: null });
        return;
      case "image":
        chain.run();
        if (isPickBusy(picker.current)) controller.setError(t("canvasEditor.stillReading"));
        else picker.current?.click();
        return;
      case "childPage":
      case "database": {
        chain.run();
        const create = key === "database" && links.createDatabase ? links.createDatabase() : links.createChild();
        setBusy(true);
        void create.then((page) => {
          setBusy(false);
          if (!page) return;
          // M149: a new database is embedded where the `/` was; a page is linked.
          if (key === "database" && links.embedView) void embedDatabase(page);
          else editorRef.current?.chain().focus().insertContent([{ type: "pageLink", attrs: { id: page.id, label: linkLabel(page.title) } }, { type: "text", text: " " }]).run();
        });
        return;
      }
    }
  }

  // --- images, tables, icons, links ------------------------------------------------------------------------------------------

  async function insertImages(list: readonly File[], picked?: { release: () => void }) {
    const release = picked?.release ?? (() => {});
    const images = list.filter((file) => file.type.startsWith("image/"));
    if (images.length === 0) {
      release();
      if (list.length > 0) controller.setError(t("canvasEditor.imagesOnly"));
      return;
    }
    if (attachmentRefs(saver.text).size + images.length > MAX_CANVAS_IMAGES) {
      release();
      controller.setError(new ApiError(400, "too_many_canvas_images", "Too many images"));
      return;
    }
    const refusal = refusePicked(images, { maxFiles: MAX_CANVAS_IMAGES, maxBytes: ATTACHMENT_MAX_BYTES });
    if (refusal) {
      release();
      controller.setError(refusal);
      return;
    }
    setUploading((n) => n + images.length);
    const insert = async (file: File) => {
      const uploaded = await controller.uploadCanvasImage(file);
      setUploading((n) => n - 1);
      if (uploaded) putBlock({ type: "image", attrs: { attachmentId: uploaded.id, alt: "" } });
    };
    if (!picked) {
      for (const file of images) await insert(file);
      return;
    }
    await forEachPicked(images, insert, release, (error) => {
      setUploading((n) => n - 1);
      controller.setError(error);
    });
  }

  /** 「表を編集」: the caret's table in the table dialog (its cells as Markdown). */
  function openTable() {
    const editor = editorRef.current;
    const place = editor ? cellPlace(editor.state) : null;
    if (!editor || !place) return;
    const markdown = editorMarkdown(editor.schema.topNodeType.create(null, place.table), new SourceMap()).text;
    setTableEdit({ table: parseTable(markdown.split("\n")), isNew: false, pos: place.tablePos });
  }

  function finishTable(table: Table | null) {
    const session = tableEdit;
    setTableEdit(null);
    const editor = editorRef.current;
    if (!session || !editor || !table) {
      editor?.commands.focus();
      return;
    }
    const fresh = markdownSlice(editor, serializeTable(table).join("\n"), isEmoji).content.firstChild;
    if (!fresh || fresh.type.name !== "table") return;
    if (session.isNew) {
      putBlock(fresh.toJSON() as JSONContent);
      return;
    }
    if (session.pos === null || sameTable(table, session.table)) return;
    const node = editor.state.doc.nodeAt(session.pos);
    if (!node || node.type.name !== "table") return;
    editor.view.dispatch(editor.state.tr.replaceWith(session.pos, session.pos + node.nodeSize, fresh));
  }

  function openLink() {
    const editor = editorRef.current;
    if (!editor) return;
    const { from } = editor.state.selection;
    const coords = editor.view.coordsAtPos(from);
    setLinkEdit({ href: editor.isActive("link") ? String(editor.getAttributes("link").href ?? "") : "", rect: new DOMRect(coords.left, coords.top, 1, coords.bottom - coords.top) });
  }

  function applyLink(href: string) {
    setLinkEdit(null);
    const editor = editorRef.current;
    if (!editor) return;
    const url = href.trim();
    if (!url) {
      editor.chain().focus().extendMarkRange("link").unsetLink().run();
      return;
    }
    if (!/^https?:\/\//i.test(url)) return;
    if (editor.state.selection.empty && !editor.isActive("link")) {
      editor.chain().focus().insertContent({ type: "text", text: url, marks: [{ type: "link", attrs: { href: url } }] }).run();
      return;
    }
    editor.chain().focus().extendMarkRange("link").setLink({ href: url }).run();
  }

  // --- block handles (M151) ---------------------------------------------------------------------------------------------------

  /** The block under a point of the window (its position), with the element that draws it. */
  function blockAtPoint(editor: Editor, x: number, y: number): { pos: number; dom: HTMLElement } | null {
    const box = editor.view.dom.getBoundingClientRect();
    if (y < box.top || y > box.bottom) return null;
    // From the handle's gutter too: the point is looked up a little inside the text.
    const at = editor.view.posAtCoords({ left: Math.min(Math.max(x, box.left + 40), box.right - 8), top: y });
    if (!at) return null;
    const pos = blockPosAt(editor.state.doc, at.inside >= 0 ? at.inside : at.pos);
    const dom = pos === null ? null : (editor.view.nodeDOM(pos) as HTMLElement | null);
    return pos === null || !(dom instanceof HTMLElement) ? null : { pos, dom };
  }

  /** Where the handle of the block drawn by `dom` goes (beside its first line; a list line's marker). */
  function handlePlace(dom: HTMLElement): { top: number; left: number } | null {
    const box = wrapper.current?.getBoundingClientRect();
    if (!box) return null;
    const rect = dom.getBoundingClientRect();
    const marker = dom.matches("[data-list-line]") ? dom.querySelector(".pe-marker")?.getBoundingClientRect() : null;
    const scroller = wrapper.current?.closest("[data-wysiwyg-page]")?.getBoundingClientRect();
    const left = Math.max((marker?.left ?? rect.left) - 46, (scroller?.left ?? box.left - 46) + 2);
    return { top: rect.top - box.top + Math.min(rect.height, 28) / 2 - 12, left: left - box.left };
  }

  function hover(event: ReactMouseEvent) {
    const editor = editorRef.current;
    if (!editor || dragging.current || blockMenu) return;
    const found = blockAtPoint(editor, event.clientX, event.clientY);
    if (!found) return;
    const place = handlePlace(found.dom);
    if (!place) return;
    if (hovered?.pos !== found.pos || hovered.top !== place.top || hovered.left !== place.left) setHovered({ pos: found.pos, ...place });
  }

  /** Where the block being dragged would go for a point: a place between blocks and the line that shows it. */
  function dropTarget(editor: Editor, unit: BlockUnit, x: number, y: number): { target: number; line: { top: number; left: number; width: number } } | null {
    const box = wrapper.current?.getBoundingClientRect();
    const doc = editor.state.doc;
    if (!box) return null;
    const found = blockAtPoint(editor, x, y);
    if (!found) {
      // Under the last block: the end of the page.
      const last = doc.lastChild ? (editor.view.nodeDOM(doc.content.size - doc.lastChild.nodeSize) as HTMLElement | null) : null;
      if (!last || y < last.getBoundingClientRect().bottom || !canPlace(doc, unit, doc.content.size)) return null;
      const rect = last.getBoundingClientRect();
      return { target: doc.content.size, line: { top: rect.bottom - box.top, left: rect.left - box.left, width: rect.width } };
    }
    let pos = found.pos;
    let dom = found.dom;
    // Inside the dragged blocks, or deeper than containers may go: the block that holds that place.
    for (let guard = 0; guard < 4; guard++) {
      const rect = dom.getBoundingClientRect();
      const after = y > rect.top + rect.height / 2;
      const target = after ? pos + doc.nodeAt(pos)!.nodeSize : pos;
      if (target === unit.from || target === unit.to) return { target, line: { top: (after ? rect.bottom : rect.top) - box.top, left: rect.left - box.left, width: rect.width } };
      if (canPlace(doc, unit, target)) return { target, line: { top: (after ? rect.bottom : rect.top) - box.top, left: rect.left - box.left, width: rect.width } };
      const $pos = doc.resolve(pos);
      if ($pos.depth === 0) return null;
      pos = $pos.before($pos.depth);
      const outer = editor.view.nodeDOM(pos);
      if (!(outer instanceof HTMLElement)) return null;
      dom = outer;
    }
    return null;
  }

  /** The ⋮⋮ handle pressed: a drag moves the block (and a list line's children); a click opens the block's menu. */
  function grab(event: ReactMouseEvent<HTMLButtonElement>) {
    const editor = editorRef.current;
    if (!editor || !hovered || event.button !== 0) return;
    event.preventDefault();
    const unit = unitAt(editor.state.doc, hovered.pos);
    const start = { x: event.clientX, y: event.clientY };
    const button = event.currentTarget;
    let target: number | null = null;
    const move = (e: MouseEvent) => {
      if (!dragging.current && Math.hypot(e.clientX - start.x, e.clientY - start.y) < 4) return;
      dragging.current = true;
      const drop = dropTarget(editor, unit, e.clientX, e.clientY);
      target = drop?.target ?? null;
      setDropLine(drop?.line ?? null);
    };
    const up = () => {
      document.removeEventListener("mousemove", move);
      document.removeEventListener("mouseup", up);
      setDropLine(null);
      if (!dragging.current) {
        setBlockMenu({ pos: unit.from, rect: button.getBoundingClientRect() });
        return;
      }
      dragging.current = false;
      setHovered(null);
      if (target === null || target === unit.from || target === unit.to) return;
      const tr = moveUnit(editor.state, unit, target, sources, { emoji: isEmoji });
      if (tr) editor.view.dispatch(tr);
      editor.commands.focus();
    };
    document.addEventListener("mousemove", move);
    document.addEventListener("mouseup", up);
  }

  /** ＋ beside the handle: an empty line under the block with the `/` menu open in it. */
  function addBelow() {
    const editor = editorRef.current;
    if (!editor || !hovered) return;
    const node = editor.state.doc.nodeAt(hovered.pos);
    if (node?.type.name === "paragraph" && node.content.size === 0) {
      editor.chain().focus().setTextSelection(hovered.pos + 1).insertContent("/").run();
      return;
    }
    editor.view.dispatch(lineAfter(editor.state, unitAt(editor.state.doc, hovered.pos), "/"));
    editor.commands.focus();
  }

  /** What the handle's menu does with its block. */
  function blockAction(action: "duplicate" | "delete" | "up" | "down" | SlashKey | "text") {
    const editor = editorRef.current;
    const session = blockMenu;
    setBlockMenu(null);
    if (!editor || !session) return;
    const node = editor.state.doc.nodeAt(session.pos);
    if (!node) return;
    const unit = unitAt(editor.state.doc, session.pos);
    if (action === "duplicate") editor.view.dispatch(duplicateUnit(editor.state, unit, untied));
    else if (action === "delete") editor.view.dispatch(deleteUnit(editor.state, unit));
    else if (action === "up" || action === "down") {
      editor.view.dispatch(editor.state.tr.setSelection(Selection.near(editor.state.doc.resolve(session.pos + 1))));
      const tr = stepBlocks(editor.state, action === "up" ? -1 : 1, sources, { emoji: isEmoji });
      if (tr) editor.view.dispatch(tr);
    } else turnInto(editor, session.pos, node, action);
    editor.commands.focus();
  }

  /** The block at `pos` turned into another kind (a line's kinds; a callout or toggle around it). */
  function turnInto(editor: Editor, pos: number, node: PMNode, key: SlashKey | "text") {
    const { schema } = editor.state;
    if (key === "callout") {
      editor.view.dispatch(editor.state.tr.replaceWith(pos, pos + node.nodeSize, schema.nodes.callout!.create({ icon: "💡" }, node)));
      return;
    }
    if (key === "toggle") {
      const title = node.isTextblock && node.inlineContent ? node.content : null;
      const body = title ? schema.nodes.paragraph!.create() : node;
      editor.view.dispatch(editor.state.tr.replaceWith(pos, pos + node.nodeSize, schema.nodes.toggle!.create(null, [schema.nodes.toggleTitle!.create(null, title), body])));
      return;
    }
    setKind(editor.chain().focus().setTextSelection(pos + node.nodeSize - 1), key);
  }

  const run = (action: (editor: Editor) => void) => () => {
    const editor = editorRef.current;
    if (editor) action(editor);
  };
  const lineKind = (kind: string, attrs: Record<string, unknown> = {}) => run((editor) => {
    if (editor.isActive("listLine", { kind })) editor.chain().focus().setNode("paragraph").run();
    else editor.chain().focus().setNode("listLine", { kind, level: 0, ...attrs }).run();
  });
  const tools: ToolbarTool[] = [
    { icon: <Heading1 size={16} />, label: t("canvasEditor.heading", { n: 1 }), run: run((e) => e.chain().focus().toggleHeading({ level: 1 }).run()) },
    { icon: <Heading2 size={16} />, label: t("canvasEditor.heading", { n: 2 }), run: run((e) => e.chain().focus().toggleHeading({ level: 2 }).run()) },
    { icon: <Heading3 size={16} />, label: t("canvasEditor.heading", { n: 3 }), run: run((e) => e.chain().focus().toggleHeading({ level: 3 }).run()) },
    { group: true, icon: <Bold size={16} />, label: t("composer.format.boldKey", { key: `${modKey()}+B` }), run: run((e) => e.chain().focus().toggleBold().run()) },
    { icon: <Italic size={16} />, label: t("composer.format.italicKey", { key: `${modKey()}+I` }), run: run((e) => e.chain().focus().toggleItalic().run()) },
    { icon: <Strikethrough size={16} />, label: t("composer.syntax.strike"), run: run((e) => e.chain().focus().toggleStrike().run()) },
    { group: true, icon: <List size={16} />, label: t("composer.format.bullets"), run: lineKind("bullet") },
    { icon: <ListOrdered size={16} />, label: t("composer.format.numbered"), run: lineKind("ordered", { number: 1 }) },
    { icon: <ListChecks size={16} />, label: t("canvasEditor.checklist"), run: lineKind("task") },
    { icon: <TextQuote size={16} />, label: t("composer.format.quote"), run: run((e) => (e.isActive("blockquote") ? e.chain().focus().lift("blockquote").run() : e.chain().focus().wrapIn("blockquote").run())) },
    { icon: <Code size={16} />, label: t("canvasEditor.code"), run: run((e) => e.chain().focus().toggleCode().run()) },
    { group: true, icon: <LinkIcon size={16} />, label: t("composer.syntax.link"), run: openLink },
    { icon: <AtSign size={16} />, label: t("nav.mentions"), run: run((e) => e.chain().focus().insertContent(/\S$/.test(e.state.selection.$from.parent.textBetween(0, e.state.selection.$from.parentOffset)) ? " @" : "@").run()) },
    { icon: <Minus size={16} />, label: t("canvasEditor.rule"), run: () => putBlock({ type: "horizontalRule" }) },
    { icon: <TableIcon size={16} />, label: t("canvasEditor.table"), run: () => setTableEdit({ table: newTableFor(), isNew: true, pos: null }) },
    { icon: <ImagePlus size={16} />, label: t("canvasEditor.image"), run: () => { if (isPickBusy(picker.current)) controller.setError(t("canvasEditor.stillReading")); else picker.current?.click(); } },
  ];

  const menuAt = (() => {
    const editor = editorRef.current;
    if (!editor || !open || listLength === 0 || !menu) return null;
    const height = Math.min(320, listLength * 34 + 10);
    try {
      const coords = editor.view.coordsAtPos(menu.from);
      // Under the line, or above it when the window ends first.
      return coords.bottom + 4 + height > window.innerHeight && coords.top - 4 - height > 0
        ? { left: coords.left, top: coords.top - 4 - height, height }
        : { left: coords.left, top: Math.min(coords.bottom + 4, window.innerHeight - height - 8), height };
    } catch {
      // No layout to measure (a hidden pane): under the editor's top.
      const box = editor.view.dom.getBoundingClientRect();
      return { left: box.left, top: box.top + 24, height };
    }
  })();

  return (
    <div className={cn("relative flex min-h-0 flex-col", className)} data-page-editor="">
      <OverflowToolbar tools={tools} label={t("composer.formatting")} className="sticky top-0 z-10 shrink-0 border-b border-line bg-canvas px-2 py-1" buttonClassName="h-7 w-7 shrink-0 text-muted hover:text-ink" />
      <div ref={wrapper} className="relative" onMouseMove={hover} onMouseLeave={(event) => { if (!dragging.current && !blockMenu && !(event.relatedTarget instanceof globalThis.Node && wrapper.current?.contains(event.relatedTarget))) setHovered(null); }}>
        <div ref={hostElement} className="page-editor-host min-h-[40vh] px-0 py-3" />
        {hovered && (
          <div className="pe-handle absolute z-10 flex items-center" style={{ top: hovered.top, left: hovered.left }} data-block-handle="">
            <button type="button" tabIndex={-1} aria-label={t("docs.wysiwyg.addBelow")} title={t("docs.wysiwyg.addBelow")} onMouseDown={(event) => event.preventDefault()} onClick={addBelow} className="grid h-6 w-5 place-items-center rounded text-muted hover:bg-panel hover:text-ink">
              <Plus size={15} />
            </button>
            <button type="button" tabIndex={-1} aria-label={t("docs.wysiwyg.blockHandle")} title={t("docs.wysiwyg.blockHandleHint")} onMouseDown={grab} className="grid h-6 w-5 cursor-grab place-items-center rounded text-muted hover:bg-panel hover:text-ink active:cursor-grabbing">
              <GripVertical size={15} />
            </button>
          </div>
        )}
        {tableAt && <TableTools editor={editorRef.current} pos={tableAt.pos} wrapper={wrapper.current} onEdit={(edit) => {
          const editor = editorRef.current;
          const tr = editor ? editTable(editor.state, edit) : null;
          if (editor && tr) editor.view.dispatch(tr);
          editor?.commands.focus();
        }} onDialog={openTable} />}
        {dropLine && <div className="pointer-events-none absolute z-20 h-0.5 rounded bg-accent" style={{ top: dropLine.top - 1, left: dropLine.left, width: dropLine.width }} data-drop-line="" />}
      </div>
      {portals.entries().map(([key, { dom, node }]) => createPortal(node, dom, key))}
      <input
        ref={picker}
        type="file"
        accept="image/*"
        multiple
        hidden
        aria-label={t("canvasEditor.imageInput")}
        onChange={(event) => {
          const picked = takePicked(event.target);
          void insertImages(picked.files, picked);
        }}
      />
      {menuAt && (
        <ul
          role="listbox"
          aria-label={pageList.length > 0 ? t("docs.linkSuggestions") : slashList.length > 0 ? t("docs.slash.menu") : t("canvasEditor.mentionSuggestions")}
          className="fixed z-50 max-h-80 w-72 overflow-y-auto rounded-xl border border-line bg-canvas p-1 shadow-xl"
          style={{ left: Math.max(8, Math.min(menuAt.left, window.innerWidth - 300)), top: menuAt.top, maxHeight: menuAt.height }}
        >
          {pageList.map((page, index) => (
            <MenuRow key={page.id} active={index === active} onPick={() => pickPage(page)}>
              <PageIcon controller={controller} icon={page.icon} size={14} />
              <span className="truncate">{page.title || t("docs.untitled")}</span>
            </MenuRow>
          ))}
          {pageList.length === 0 && slashList.map((item, index) => (
            <MenuRow key={item.key} active={index === active} onPick={() => pickSlash(item.key)}>{t(item.label)}</MenuRow>
          ))}
          {pageList.length === 0 && slashList.length === 0 && mentionList.map((candidate, index) => (
            <MenuRow key={candidate.username} active={index === active} onPick={() => pickMention(candidate)}>
              <strong>@{candidate.username}</strong> <span className="truncate text-muted">{candidate.label}</span>
            </MenuRow>
          ))}
        </ul>
      )}
      {(busy || uploading > 0) && (
        <div role="status" className="pointer-events-none fixed bottom-4 right-4 z-50 inline-flex items-center gap-1.5 rounded-full border border-line bg-canvas px-3 py-1 text-xs text-muted shadow">
          <Loader2 size={12} className="animate-spin" /> {uploading > 0 ? t("canvasEditor.uploading", { count: uploading }) : t("docs.creatingChild")}
        </div>
      )}
      {tableEdit && (
        <CanvasTableDialog initial={tableEdit.table} isNew={tableEdit.isNew} onDone={(table) => finishTable(table)} onCancel={() => finishTable(null)} onClosed={() => editorRef.current?.commands.focus()} />
      )}
      {iconPick && (
        <FloatingBox rect={iconPick.rect} onClose={() => setIconPick(null)} width={340}>
          <EmojiPicker controller={controller} custom={[...store.customEmoji.values()]} onPick={(entry) => {
            const icon = entry.category === "custom" || !entry.glyph ? `:${entry.shortcode}:` : entry.glyph;
            const editor = editorRef.current;
            const node = editor?.state.doc.nodeAt(iconPick.pos);
            if (editor && node?.type.name === "callout") editor.view.dispatch(editor.state.tr.setNodeMarkup(iconPick.pos, undefined, { ...node.attrs, icon }));
            setIconPick(null);
            editor?.commands.focus();
          }} />
        </FloatingBox>
      )}
      {blockMenu && (
        <FloatingBox rect={blockMenu.rect} onClose={() => { setBlockMenu(null); editorRef.current?.commands.focus(); }} width={240}>
          <BlockMenu node={editorRef.current?.state.doc.nodeAt(blockMenu.pos) ?? null} canWrap={containerDepthAt(editorRef.current, blockMenu.pos) < 2} onPick={blockAction} />
        </FloatingBox>
      )}
      {linkEdit && (
        <FloatingBox rect={linkEdit.rect} onClose={() => { setLinkEdit(null); editorRef.current?.commands.focus(); }} width={320}>
          <form className="flex gap-1.5 p-1" onSubmit={(event) => { event.preventDefault(); applyLink(new FormData(event.currentTarget).get("href")?.toString() ?? ""); }}>
            <input name="href" autoFocus defaultValue={linkEdit.href} placeholder="https://" aria-label={t("docs.wysiwyg.linkUrl")} className="min-w-0 flex-1 rounded-md border border-line bg-canvas px-2 py-1 text-sm outline-none focus:border-accent" />
            <button type="submit" className="rounded-md bg-accent px-2.5 py-1 text-sm font-medium text-white">{t("docs.wysiwyg.linkApply")}</button>
          </form>
        </FloatingBox>
      )}
    </div>
  );
}

function MenuRow({ active, onPick, children }: { active: boolean; onPick: () => void; children: ReactNode }) {
  return (
    <li
      role="option"
      aria-selected={active}
      className={cn("flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-sm", active ? "bg-accent-soft" : "hover:bg-panel")}
      onMouseDown={(event) => {
        event.preventDefault();
        onPick();
      }}
    >
      {children}
    </li>
  );
}

/** A small box under a point of the page (the icon picker, the link field); Esc or a click outside closes it. */
function FloatingBox({ rect, onClose, width, children }: { rect: DOMRect; onClose: () => void; width: number; children: ReactNode }) {
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const down = (event: MouseEvent) => {
      if (box.current && !box.current.contains(event.target as globalThis.Node)) onClose();
    };
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        onClose();
      }
    };
    document.addEventListener("mousedown", down);
    document.addEventListener("keydown", key, true);
    return () => {
      document.removeEventListener("mousedown", down);
      document.removeEventListener("keydown", key, true);
    };
  }, [onClose]);
  const left = Math.max(8, Math.min(rect.left, window.innerWidth - width - 8));
  const top = Math.min(rect.bottom + 6, window.innerHeight - 120);
  return (
    <div ref={box} className="fixed z-50 rounded-xl border border-line bg-canvas p-2 shadow-xl" style={{ left, top, width }}>
      {children}
    </div>
  );
}

/** The tools of the table the caret is in, above it: rows, columns, a column's alignment, the table dialog. */
function TableTools({ editor, pos, wrapper, onEdit, onDialog }: { editor: Editor | null; pos: number; wrapper: HTMLElement | null; onEdit: (edit: TableEdit) => void; onDialog: () => void }) {
  const dom = editor?.view.nodeDOM(pos);
  if (!editor || !wrapper || !(dom instanceof HTMLElement)) return null;
  const box = wrapper.getBoundingClientRect();
  const rect = dom.getBoundingClientRect();
  const place = cellPlace(editor.state);
  const align = place ? place.table.child(0).maybeChild(place.col)?.attrs.align ?? null : null;
  const tools: Array<{ icon: ReactNode; label: string; edit?: TableEdit; pressed?: boolean; run?: () => void }> = [
    { icon: <BetweenHorizontalStart size={15} />, label: t("table.addRowAbove"), edit: "rowAbove" },
    { icon: <BetweenHorizontalEnd size={15} />, label: t("table.addRowBelow"), edit: "rowBelow" },
    { icon: <Rows3 size={15} />, label: t("table.deleteRow"), edit: "deleteRow" },
    { icon: <BetweenVerticalStart size={15} />, label: t("table.addColumnLeft"), edit: "columnLeft" },
    { icon: <BetweenVerticalEnd size={15} />, label: t("table.addColumnRight"), edit: "columnRight" },
    { icon: <Columns3 size={15} />, label: t("docs.wysiwyg.deleteColumn"), edit: "deleteColumn" },
    { icon: <AlignLeft size={15} />, label: t("docs.wysiwyg.alignLeft"), edit: { align: align === "left" ? null : "left" }, pressed: align === "left" },
    { icon: <AlignCenter size={15} />, label: t("docs.wysiwyg.alignCenter"), edit: { align: align === "center" ? null : "center" }, pressed: align === "center" },
    { icon: <AlignRight size={15} />, label: t("docs.wysiwyg.alignRight"), edit: { align: align === "right" ? null : "right" }, pressed: align === "right" },
    { icon: <Pencil size={14} />, label: t("docs.wysiwyg.editTable"), run: onDialog },
  ];
  return (
    <div role="toolbar" aria-label={t("docs.wysiwyg.tableTools")} className="absolute z-10 flex items-center gap-0.5 rounded-lg border border-line bg-canvas p-0.5 shadow-sm" style={{ top: Math.max(0, rect.top - box.top - 34), left: Math.max(0, rect.left - box.left) }} data-table-tools="">
      {tools.map((tool) => (
        <button
          key={tool.label}
          type="button"
          tabIndex={-1}
          aria-label={tool.label}
          title={tool.label}
          aria-pressed={tool.pressed}
          className={cn("grid h-7 w-7 place-items-center rounded-md text-muted hover:bg-panel hover:text-ink", tool.pressed && "bg-accent-soft text-ink")}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => (tool.edit !== undefined ? onEdit(tool.edit) : tool.run?.())}
        >
          {tool.icon}
        </button>
      ))}
    </div>
  );
}

/** A page's title as a link or embed label (brackets would end the link). */
function linkLabel(title: string): string {
  return title.replace(/[[\]]/g, (c) => (c === "[" ? "［" : "］")).replace(/\s*\n\s*/g, " ").trim() || t("docs.untitled");
}

/** How deep in callouts and toggles the caret is (they nest two deep). */
function containerDepth(editor: Editor | null): number {
  if (!editor) return 0;
  const { $from } = editor.state.selection;
  let depth = 0;
  for (let d = $from.depth; d > 0; d--) if ($from.node(d).type.name === "callout" || $from.node(d).type.name === "toggle") depth++;
  return depth;
}

/** How many callouts / toggles the block at `pos` would be in if it were wrapped in one more (theirs and its own). */
function containerDepthAt(editor: Editor | null, pos: number): number {
  if (!editor) return 0;
  const $pos = editor.state.doc.resolve(pos);
  let depth = 0;
  for (let d = 1; d <= $pos.depth; d++) if ($pos.node(d).type.name === "callout" || $pos.node(d).type.name === "toggle") depth++;
  const inner = (node: PMNode): number => {
    let deepest = 0;
    node.forEach((child) => (deepest = Math.max(deepest, inner(child))));
    return deepest + (node.type.name === "callout" || node.type.name === "toggle" ? 1 : 0);
  };
  const node = editor.state.doc.nodeAt(pos);
  return depth + (node ? inner(node) : 0);
}

/** The kinds a line turns into from the handle's menu (the `/` menu's kinds of line). */
const TURN_INTO: ReadonlyArray<{ key: SlashKey | "text"; label: MessageKey }> = [
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

/** ⌘⇧ (macOS) or Ctrl+Shift+ (the others), before an arrow. */
const moveKeys = () => (modKey() === "⌘" ? "⌘⇧" : "Ctrl+Shift+");

/** The ⋮⋮ handle's menu: turn into (lines), duplicate, delete, move up / down. */
function BlockMenu({ node, canWrap, onPick }: { node: PMNode | null; canWrap: boolean; onPick: (action: "duplicate" | "delete" | "up" | "down" | SlashKey | "text") => void }) {
  const line = !!node && ["paragraph", "heading", "listLine", "codeBlock", "mathBlock"].includes(node.type.name);
  const item = "flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-sm hover:bg-panel focus-visible:bg-panel focus-visible:outline-none";
  const menu = useRef<HTMLDivElement>(null);
  useEffect(() => menu.current?.querySelector<HTMLButtonElement>("button")?.focus(), []);
  return (
    <div ref={menu} role="menu" aria-label={t("docs.wysiwyg.blockMenu")} className="max-h-[70vh] overflow-y-auto" onKeyDown={(event) => {
      if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
      event.preventDefault();
      const buttons = [...(menu.current?.querySelectorAll<HTMLButtonElement>("button") ?? [])];
      const at = buttons.indexOf(document.activeElement as HTMLButtonElement);
      buttons[(at + (event.key === "ArrowDown" ? 1 : buttons.length - 1)) % buttons.length]?.focus();
    }}>
      {line && (
        <>
          <div className="px-2 pb-0.5 pt-1 text-[11px] font-semibold text-muted">{t("docs.wysiwyg.turnInto")}</div>
          {TURN_INTO.filter((kind) => canWrap || (kind.key !== "callout" && kind.key !== "toggle")).map((kind) => (
            <button key={kind.key} type="button" role="menuitem" className={item} onClick={() => onPick(kind.key)}>{t(kind.label)}</button>
          ))}
          <div className="my-1 border-t border-line" />
        </>
      )}
      <button type="button" role="menuitem" className={item} onClick={() => onPick("duplicate")}><Copy size={14} /> {t("docs.wysiwyg.duplicate")}</button>
      <button type="button" role="menuitem" className={item} onClick={() => onPick("up")}><ArrowUp size={14} /> {t("docs.wysiwyg.moveUp")}<span className="ml-auto text-xs text-muted">{moveKeys()}↑</span></button>
      <button type="button" role="menuitem" className={item} onClick={() => onPick("down")}><ArrowDown size={14} /> {t("docs.wysiwyg.moveDown")}<span className="ml-auto text-xs text-muted">{moveKeys()}↓</span></button>
      <button type="button" role="menuitem" className={cn(item, "text-danger")} onClick={() => onPick("delete")}><Trash2 size={14} /> {t("docs.wysiwyg.deleteBlock")}</button>
    </div>
  );
}

function newTableFor(): Table {
  return { align: [null, null, null], header: [1, 2, 3].map((n) => t("table.newColumn", { n })), rows: [["", "", ""], ["", "", ""]] };
}

/**
 * Lists pasted from web pages, Word or Google Docs (nested `ul` / `ol`) as the editor's flat list lines, keeping the
 * marks inside; checkboxes make checklist items.
 */
export function flattenPastedLists(html: string): string {
  if (!/<(ul|ol)\b/i.test(html) || typeof DOMParser === "undefined") return html;
  const doc = new DOMParser().parseFromString(html, "text/html");
  const flatten = (list: Element, level: number): Element[] => {
    const out: Element[] = [];
    for (const item of Array.from(list.children)) {
      if (item.tagName !== "LI") continue;
      const line = doc.createElement("div");
      line.setAttribute("data-list-line", "");
      const box = item.querySelector(":scope > input[type=checkbox], :scope > p > input[type=checkbox]") as HTMLInputElement | null;
      line.setAttribute("data-kind", box ? "task" : list.tagName === "OL" ? "ordered" : "bullet");
      line.setAttribute("data-level", String(Math.min(level, box ? 1 : 2)));
      if (box?.checked) line.setAttribute("data-checked", "true");
      const nested: Element[] = [];
      for (const child of Array.from(item.childNodes)) {
        if (child instanceof Element && (child.tagName === "UL" || child.tagName === "OL")) nested.push(child);
        else if (child instanceof Element && child.tagName === "INPUT") continue;
        else if (child instanceof Element && child.tagName === "P") line.append(...Array.from(child.childNodes));
        else line.append(child);
      }
      out.push(line);
      for (const sub of nested) out.push(...flatten(sub, level + 1));
    }
    return out;
  };
  for (const list of Array.from(doc.body.querySelectorAll("ul, ol"))) {
    if (list.parentElement?.closest("ul, ol")) continue;
    list.replaceWith(...flatten(list, 0));
  }
  return doc.body.innerHTML;
}
