/**
 * The canvas's Markdown source editor (CANVAS.md §5 「編集」): a text area with a toolbar (headings, emphasis, lists,
 * checklists, quotes, code, links, mentions, rules, tables (M57), images), the composer's list continuation and `@`
 * completion. Mentions show as `@username` and are stored as `<@uuid>` (§4.2). Every change goes to the save loop (sync/canvasSave.ts); a body the
 * loop replaces (someone else's merged edits, a box ticked in the preview) comes back here with the caret kept.
 * M80 (§22): the hidden task markers of checklist items show as invisible stand-ins (canvasMarkers.ts) that move with
 * their lines; Backspace / Delete beside one take the visible character, a copy leaves them out, a cut keeps them for a
 * paste back into a canvas editor (the line moved keeps its task).
 */
import { ATTACHMENT_MAX_BYTES, forEachPicked, isPickBusy, refusePicked, takePicked } from "../platform/pickedFiles";
import { AtSign, Bold, Code, Heading1, Heading2, Heading3, ImagePlus, Italic, Link as LinkIcon, List, ListChecks, ListOrdered, Loader2, Minus, Strikethrough, Table as TableIcon, TextQuote } from "lucide-react";
import { type ClipboardEvent, type CSSProperties, type KeyboardEvent, type MutableRefObject, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";

import { ApiError } from "../api/errors";
import type { PageRef } from "../api/types";
import type { CanvasSaver, SavedDoc } from "../sync/canvasSave";
import { applySlash, insertEmbed, insertLinkAt, insertPageLink, isEmbedQuery, pageLinkQuery, type SlashKey, slashItems, slashQuery } from "./docEditor";
import { PageIcon } from "./PageIcon";
import type { AppController } from "../state/app";
import { anchorLine, findTable, insertTable, lineOf, lineStart, newTable, parseTable, sameTable, type Table, type TableOrigin, writeBackTable } from "./canvasTable";
import { CanvasTableDialog } from "./CanvasTableDialog";
import { CANVAS_PRESENCE_REFRESH_MS } from "../sync/canvasPresence";
import { attachmentRefs, insertImageLine, insertRule, MAX_CANVAS_IMAGES, preserveCaret, sectionAt, setHeading, toggleTasks } from "./canvasText";
import { continueStructure, type EditState, indentListLine, insertLink, linkFromPaste, replaceThroughBrowser, toggleLinePrefix, toggleWrap } from "./composerEdit";
import { deleteBesideStandIns, stripStandIns, TaskMarkerTable } from "./canvasMarkers";
import { aiBotIds, decodeMentions, encodeMentions, type MentionCandidate, mentionCandidates, mentionQuery } from "./mentions";
import { cn, modKey } from "./primitives";
import { OverflowToolbar, type ToolbarTool } from "./OverflowToolbar";
import { t } from "../i18n";

/** M80: what a cut in a canvas editor keeps besides the plain text — the lines with their task markers. */
const CUT_TYPE = "application/x-chikuwachat-canvas";

/**
 * M121 (WIKI.md §7.3): the editor on a Docs page — no 「編集中」 frames (pages have no presence yet), `[[` suggests
 * pages to link and `/` at the start of a line opens the block menu.
 */
export interface DocEditorLinks {
  /** The `[[` suggestions: pages I can read whose title contains `q`. */
  lookup(q: string): Promise<PageRef[]>;
  /** The `/` menu's 「子ページ」: a new page below this one (null: refused, the error shown). */
  createChild(): Promise<PageRef | null>;
  /** The `/` menu's 「データベース」 (M123): a new database below this page. */
  createDatabase?(): Promise<PageRef | null>;
  /** M149: `![[` (「データベースを埋め込む」) — databases I can read whose title contains `q`. */
  lookupDatabases?(q: string): Promise<PageRef[]>;
  /** M149: the view an embed of this database names (its first; null: none known, the embed then has no view). */
  embedView?(databaseId: string): Promise<string | null>;
}

export function CanvasEditor({ controller, saver, className, style, autoFocus = false, onTextArea, doc = null, initialCaretLine = null, caretLineRef }: {
  controller: AppController;
  saver: CanvasSaver<SavedDoc>;
  className?: string;
  style?: CSSProperties;
  autoFocus?: boolean;
  /** §23: the text area, for the scroll sync with the preview beside it (null when the editor goes). */
  onTextArea?: (element: HTMLTextAreaElement | null) => void;
  /** M121: a Docs page's links and block menu (null: a canvas). */
  doc?: DocEditorLinks | null;
  /** M150: the line to put the caret on when opened (switching from the 見たまま editor). */
  initialCaretLine?: number | null;
  /** M150: the caret's line now (switching to the 見たまま editor). */
  caretLineRef?: MutableRefObject<(() => number) | null>;
}) {
  const store = controller.store;
  useSyncExternalStore((listener) => saver.subscribe(listener), () => saver.textRevision);
  const markers = useRef<TaskMarkerTable | null>(null);
  markers.current ??= new TaskMarkerTable();
  const table = markers.current;
  const decode = (wire: string) => table.hide(decodeMentions(wire, store.users, store.groups));
  const encode = (shown: string) => table.show(encodeMentions(shown, store.users.values(), store.groups.values()));
  const [text, setText] = useState(() => decode(saver.text));
  const [caret, setCaret] = useState(0);
  const [selected, setSelected] = useState(0);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const area = useRef<HTMLTextAreaElement>(null);
  /** The stored text the shown one stands for: a change of the loop's text that is not this one is taken in. */
  const wire = useRef(saver.text);
  const composing = useRef(false);
  const pendingSelection = useRef<{ start: number; end: number } | null>(null);

  // An IME composition must not have its text replaced under it: the loop keeps a merged body for later meanwhile.
  useEffect(() => {
    saver.canReplace = () => !composing.current;
    return () => {
      saver.canReplace = () => true;
    };
  }, [saver]);

  // The loop replaced the text (a merge, someone else's version, a tick in the preview): show it, the caret kept.
  useEffect(() => {
    if (saver.text === wire.current) return;
    const el = area.current;
    const next = decode(saver.text);
    wire.current = saver.text;
    const start = el?.selectionStart ?? text.length;
    const end = el?.selectionEnd ?? start;
    pendingSelection.current = { start: preserveCaret(text, next, start), end: preserveCaret(text, next, end) };
    setText(next);
  }, [saver.textRevision]); // eslint-disable-line react-hooks/exhaustive-deps

  useLayoutEffect(() => {
    const selection = pendingSelection.current;
    const el = area.current;
    if (!selection || !el) return;
    pendingSelection.current = null;
    if (document.activeElement === el) el.setSelectionRange(selection.start, selection.end);
    setCaret(selection.start);
  }, [text]);

  useEffect(() => {
    if (autoFocus) area.current?.focus();
  }, [autoFocus]);

  // M150: switching from the 見たまま editor puts the caret on the line it was on; it asks for the line going back.
  useLayoutEffect(() => {
    const el = area.current;
    if (!el || initialCaretLine === null) return;
    const at = lineStart(el.value, Math.max(0, initialCaretLine));
    el.focus();
    el.setSelectionRange(at, at);
    setCaret(at);
    const lineHeight = parseFloat(getComputedStyle(el).lineHeight) || 28;
    el.scrollTop = Math.max(0, initialCaretLine * lineHeight - el.clientHeight / 3);
    // Once, when the editor opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    if (!caretLineRef) return;
    caretLineRef.current = () => {
      const el = area.current;
      return el ? lineOf(el.value, el.selectionStart ?? 0) : 0;
    };
    return () => {
      caretLineRef.current = null;
    };
  }, [caretLineRef]);

  useLayoutEffect(() => {
    onTextArea?.(area.current);
    return () => onTextArea?.(null);
  }, [onTextArea]);

  // M72 (CANVAS.md §18.2): 「編集中」 for the conversation's other members — while the text area has the focus (said
  // again on typing and when the caret's heading changes, else every 20 s), stopped on blur and when the editor goes.
  const engine = controller.engine;
  const focused = useRef(false);
  const lastAnnounced = useRef(0);
  /** `soon`: from typing or the caret moving — looked at once a second at most (the heading is found by a scan). */
  const announce = (editing: boolean, soon = false) => {
    const now = Date.now();
    if (editing && soon && now - lastAnnounced.current < 1000) return;
    lastAnnounced.current = now;
    if (doc) return; // M121: a page has no presence frames (WIKI.md §7.3, later)
    const el = area.current;
    engine?.setCanvasEditing(saver.id, editing, editing && el ? sectionAt(el.value, el.selectionStart ?? 0) : null);
  };
  useEffect(() => {
    if (doc) return;
    const timer = setInterval(() => {
      if (focused.current) announce(true);
    }, CANVAS_PRESENCE_REFRESH_MS);
    return () => {
      clearInterval(timer);
      engine?.setCanvasEditing(saver.id, false);
    };
  }, [engine, saver, !doc]); // eslint-disable-line react-hooks/exhaustive-deps

  const change = (next: string) => {
    setText(next);
    textRef.current = next;
    const stored = encode(next);
    wire.current = stored;
    saver.edit(stored);
  };

  // M44 (§4.10): images pasted, dropped or picked are uploaded (pending) and put in as `![](attachment:<id>)` lines at
  // the caret; the save that carries them binds them to the canvas. Only images: other files are not drawn in a canvas.
  const textRef = useRef(text);
  textRef.current = text;
  const [uploading, setUploading] = useState(0);
  const picker = useRef<HTMLInputElement>(null);
  /** Pasted, dropped or picked images (`picked`: from the picker, copied one at a time before each upload and the
   *  input cleared after the last; the count and sizes are checked before any byte is read, review v0.1.30 #5). */
  const insertImages = async (list: readonly File[], picked?: { release: () => void }) => {
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
      if (!uploaded) return;
      const el = area.current;
      const current = textRef.current;
      const focused = !!el && document.activeElement === el;
      const start = focused ? (el.selectionStart ?? current.length) : (lastCaret.current ?? current.length);
      const end = focused ? (el.selectionEnd ?? start) : start;
      const next = insertImageLine({ text: current, start: Math.min(start, current.length), end: Math.min(end, current.length) }, uploaded.id);
      change(next.text);
      lastCaret.current = next.start;
      setCaret(next.start);
      if (focused) {
        const restore = () => el.setSelectionRange(next.start, next.end);
        if (typeof requestAnimationFrame === "function") requestAnimationFrame(restore);
        else setTimeout(restore, 0);
      }
    };
    if (!picked) {
      for (const file of images) await insert(file);
      return;
    }
    await forEachPicked(images, insert, release, (error) => {
      setUploading((n) => n - 1);
      controller.setError(error);
    });
  };
  /** Where the caret was when the text area lost the focus (a toolbar's file picker takes it). */
  const lastCaret = useRef<number | null>(null);

  /**
   * Puts `next` in the text area through the browser's own editing (replaceThroughBrowser, as the composer does), so
   * ⌘Z / Ctrl+Z takes an edit back as one step and the text reaches the save loop through onChange; where the browser
   * does not take it (jsdom), the text is set. The selection is set to `next`'s.
   */
  const put = (next: EditState) => {
    const el = area.current;
    if (el && replaceThroughBrowser(el, next.text)) el.setSelectionRange(next.start, next.end);
    else {
      change(next.text);
      // The text set by React puts the caret at the end: back where the edit leaves it once that is drawn.
      if (el && document.activeElement === el && typeof requestAnimationFrame === "function") {
        requestAnimationFrame(() => {
          if (document.activeElement === el && el.value === next.text) el.setSelectionRange(next.start, next.end);
        });
      }
    }
    setCaret(next.start);
  };

  /** `put`, then focus and selection come back on the next frame (a toolbar button or a dialog took them). */
  const apply = (next: EditState) => {
    put(next);
    const restore = () => {
      area.current?.focus();
      area.current?.setSelectionRange(next.start, next.end);
    };
    if (typeof requestAnimationFrame === "function") requestAnimationFrame(restore);
    else setTimeout(restore, 0);
  };

  /** A formatting edit on the current selection. */
  const edit = (transform: (state: EditState) => EditState | null): boolean => {
    const el = area.current;
    if (!el) return false;
    const value = el.value;
    const next = transform({ text: value, start: el.selectionStart ?? value.length, end: el.selectionEnd ?? value.length });
    if (!next) return false;
    apply(next);
    return true;
  };

  // M57 (§17): 「表」 opens the table at the caret in the table editor, or a new 3 × 2 table to go after the caret's line.
  // 「完了」 writes the table into the text as one edit (auto-save, the merge and undo as for typing); a new table goes
  // in only then. 「キャンセル」 changes nothing, and neither does 「完了」 on a table left unedited (no tidying).
  const [tableEdit, setTableEdit] = useState<{ table: Table; isNew: boolean } | null>(null);
  const tableSession = useRef<{
    table: Table;
    /** An existing table: where it was. A new one: the caret's line (its number and text) it goes after. */
    place: { origin: TableOrigin } | { line: number; content: string };
    outcome: Table | "cancel" | null;
  } | null>(null);
  const openTable = () => {
    const el = area.current;
    if (!el) return;
    const value = el.value;
    const line = lineOf(value, el.selectionStart ?? value.length);
    const range = findTable(value, line);
    if (range) {
      const lines = value.split("\n").slice(range[0], range[1] + 1);
      const table = parseTable(lines);
      tableSession.current = { table, place: { origin: { range, lines } }, outcome: null };
      setTableEdit({ table, isNew: false });
    } else {
      const fresh = newTable();
      tableSession.current = { table: fresh, place: { line, content: value.split("\n")[line] ?? "" }, outcome: null };
      setTableEdit({ table: fresh, isNew: true });
    }
  };
  /** After the dialog has gone (the focus handed back): the table written in, the caret at its first line. */
  const finishTable = () => {
    const session = tableSession.current;
    const el = area.current;
    if (!session || session.outcome === null || !el) return;
    tableSession.current = null;
    const { outcome, place } = session;
    const value = el.value;
    if (outcome === "cancel" || ("origin" in place && sameTable(outcome, session.table))) {
      el.focus();
      return;
    }
    const out = "origin" in place
      ? writeBackTable(value, place.origin, outcome)
      : { ...insertTable(value, anchorLine(value, place.line, place.content), outcome), inserted: false };
    const at = lineStart(out.text, out.range[0]);
    apply({ text: out.text, start: at, end: at });
    if (out.inserted) controller.setNotice(t("canvasEditor.tableConflict"));
  };
  const closeTable = (outcome: Table | "cancel") => {
    if (tableSession.current) tableSession.current.outcome = outcome;
    setTableEdit(null);
  };

  // M121: on a page, `[[` (page links) and `/` at a line's start (the block menu) come before the `@` suggestions.
  const linkQ = doc ? pageLinkQuery(text, caret) : null;
  // M149: `![[` lists databases to embed.
  const embedQ = !!linkQ && !!doc?.lookupDatabases && isEmbedQuery(text, linkQ.start);
  const linkListKey = linkQ ? `${embedQ ? "embed" : "link"}:${linkQ.start}:${linkQ.query}` : null;
  const slashQ = doc && !linkQ ? slashQuery(text, caret) : null;
  const slashListKey = slashQ ? `slash:${slashQ.start}:${slashQ.query}` : null;
  const [linkResults, setLinkResults] = useState<{ key: string; pages: PageRef[] } | null>(null);
  useEffect(() => {
    if (!doc || !linkQ || dismissed === linkListKey) return;
    const key = linkListKey!;
    const timer = setTimeout(() => {
      void (embedQ && doc.lookupDatabases ? doc.lookupDatabases(linkQ.query.trim()) : doc.lookup(linkQ.query.trim())).then((pages) => setLinkResults({ key, pages }), () => setLinkResults({ key, pages: [] }));
    }, 120);
    return () => clearTimeout(timer);
  }, [linkListKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const pageCandidates: PageRef[] = linkQ && dismissed !== linkListKey && linkResults?.key === linkListKey ? linkResults.pages : [];
  const slashCandidates = slashQ && dismissed !== slashListKey ? slashItems(slashQ.query) : [];
  const query = linkQ || slashQ ? null : mentionQuery(text, caret);
  const listKey = query ? `${query.start}:${query.query}` : linkQ ? linkListKey : slashListKey;
  const candidates: MentionCandidate[] = query && dismissed !== listKey
    ? mentionCandidates(query.query, [...store.users.values()], [...store.groups.values()], 8, aiBotIds(store)).filter((c) => c.kind !== "all") // `<!channel>` notifies nobody in a canvas
    : [];
  const listLength = pageCandidates.length || slashCandidates.length || candidates.length;
  const active = Math.min(selected, Math.max(listLength - 1, 0));
  const [childBusy, setChildBusy] = useState(false);
  /** M149: a database's embed at `start` once its first view is known (the view id keeps the embed on that view). */
  const embedAt = (start: number, page: PageRef) => {
    setChildBusy(true);
    void (doc?.embedView ? doc.embedView(page.id) : Promise.resolve(null)).then((viewId) => {
      setChildBusy(false);
      const value = area.current?.value ?? textRef.current;
      const at = Math.min(start, value.length);
      apply(insertEmbed({ text: value, start: at, end: at }, page, viewId));
    });
  };
  const pickPage = (page: PageRef) => {
    if (!linkQ) return;
    if (embedQ) {
      // The `![[query` goes now; the embed comes where it was.
      const start = linkQ.start - 1;
      edit((s) => ({ text: s.text.slice(0, start) + s.text.slice(s.start), start, end: start }));
      embedAt(start, page);
    } else edit((s) => insertPageLink(s, linkQ.start, page));
    setSelected(0);
  };
  const pickSlash = (key: SlashKey) => {
    if (!slashQ) return;
    const el = area.current;
    if (!el) return;
    const result = applySlash({ text: el.value, start: el.selectionStart ?? el.value.length, end: el.selectionEnd ?? el.value.length }, slashQ.start, key);
    setSelected(0);
    apply(result.state);
    if (result.kind === "table") {
      if (typeof requestAnimationFrame === "function") requestAnimationFrame(() => openTable());
      else setTimeout(openTable, 0);
    }
    else if (result.kind === "image") {
      if (isPickBusy(picker.current)) controller.setError(t("canvasEditor.stillReading"));
      else picker.current?.click();
    } else if ((result.kind === "childPage" || result.kind === "database") && doc) {
      const create = result.kind === "database" && doc.createDatabase ? doc.createDatabase() : doc.createChild();
      setChildBusy(true);
      void create.then((page) => {
        setChildBusy(false);
        if (!page) return;
        // M149 (WIKI.md §22.5): a new database is embedded where the `/` was (its view in the body), a page linked.
        if (result.kind === "database" && doc.embedView) {
          embedAt(result.state.start, page);
          return;
        }
        const current = area.current;
        const at = Math.min(result.state.start, (current?.value ?? textRef.current).length);
        apply(insertLinkAt({ text: current?.value ?? textRef.current, start: at, end: at }, page));
      });
    }
  };
  const pick = (candidate: MentionCandidate) => {
    if (!query) return;
    edit((s) => {
      const inserted = `@${candidate.username} `;
      const at = query.start;
      const caretAt = s.start;
      return { text: s.text.slice(0, at) + inserted + s.text.slice(caretAt), start: at + inserted.length, end: at + inserted.length };
    });
    setSelected(0);
  };

  // Groups as the dividers show them; what does not fit the pane goes into 「…」 (OverflowToolbar).
  const tools: ToolbarTool[] = [
    { icon: <Heading1 size={16} />, label: t("canvasEditor.heading", { n: 1 }), run: () => edit((s) => setHeading(s, 1)) },
    { icon: <Heading2 size={16} />, label: t("canvasEditor.heading", { n: 2 }), run: () => edit((s) => setHeading(s, 2)) },
    { icon: <Heading3 size={16} />, label: t("canvasEditor.heading", { n: 3 }), run: () => edit((s) => setHeading(s, 3)) },
    { group: true, icon: <Bold size={16} />, label: t("composer.format.boldKey", { key: `${modKey()}+B` }), run: () => edit((s) => toggleWrap(s, "**")) },
    { icon: <Italic size={16} />, label: t("composer.format.italicKey", { key: `${modKey()}+I` }), run: () => edit((s) => toggleWrap(s, "_")) },
    { icon: <Strikethrough size={16} />, label: t("composer.syntax.strike"), run: () => edit((s) => toggleWrap(s, "~~")) },
    { group: true, icon: <List size={16} />, label: t("composer.format.bullets"), run: () => edit((s) => toggleLinePrefix(s, "- ")) },
    { icon: <ListOrdered size={16} />, label: t("composer.format.numbered"), run: () => edit((s) => toggleLinePrefix(s, (i) => `${i + 1}. `)) },
    { icon: <ListChecks size={16} />, label: t("canvasEditor.checklist"), run: () => edit(toggleTasks) },
    { icon: <TextQuote size={16} />, label: t("composer.format.quote"), run: () => edit((s) => toggleLinePrefix(s, "> ")) },
    { icon: <Code size={16} />, label: t("canvasEditor.code"), run: () => edit((s) => toggleWrap(s, "`")) },
    { group: true, icon: <LinkIcon size={16} />, label: t("composer.syntax.link"), run: () => edit((s) => insertLink(s)) },
    { icon: <AtSign size={16} />, label: t("nav.mentions"), run: () => edit((s) => {
      const lead = s.start > 0 && !/\s/.test(s.text[s.start - 1] ?? "") ? " @" : "@";
      return { text: s.text.slice(0, s.start) + lead + s.text.slice(s.end), start: s.start + lead.length, end: s.start + lead.length };
    }) },
    { icon: <Minus size={16} />, label: t("canvasEditor.rule"), run: () => edit(insertRule) },
    { icon: <TableIcon size={16} />, label: t("canvasEditor.table"), run: openTable },
    { icon: <ImagePlus size={16} />, label: t("canvasEditor.image"), run: () => { if (isPickBusy(picker.current)) controller.setError(t("canvasEditor.stillReading")); else picker.current?.click(); } },
  ];

  /** M80: a copy or a cut without the stand-ins; a cut also keeps the stored form (markers) for a paste back. */
  const copyOut = (event: ClipboardEvent<HTMLTextAreaElement>, cut: boolean) => {
    const el = event.currentTarget;
    const start = el.selectionStart ?? 0;
    const end = el.selectionEnd ?? start;
    const selected = el.value.slice(start, end);
    const plain = stripStandIns(selected);
    if (plain === selected) return; // no marker in it: the browser's own copy
    event.preventDefault();
    event.clipboardData.setData("text/plain", plain);
    if (!cut) return;
    event.clipboardData.setData(CUT_TYPE, table.show(selected));
    put({ text: el.value.slice(0, start) + el.value.slice(end), start, end: start });
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    const ime = event.nativeEvent.isComposing || composing.current || event.keyCode === 229;
    if (listLength > 0 && !ime) {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        setSelected((active + (event.key === "ArrowDown" ? 1 : listLength - 1)) % listLength);
        return;
      }
      if (event.key === "Enter" || event.key === "Tab") {
        event.preventDefault();
        if (pageCandidates.length > 0) {
          const page = pageCandidates[active];
          if (page) pickPage(page);
        } else if (slashCandidates.length > 0) {
          const item = slashCandidates[active];
          if (item) pickSlash(item.key);
        } else {
          const candidate = candidates[active];
          if (candidate) pick(candidate);
        }
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        setDismissed(listKey);
        return;
      }
    }
    if (event.key === "Escape") {
      // Leaves the text area only (the screen's Esc would switch back to the messages).
      event.stopPropagation();
      area.current?.blur();
      return;
    }
    const mod = event.metaKey || event.ctrlKey;
    if (mod && !event.altKey && !event.shiftKey) {
      const key = event.key.toLowerCase();
      if (key === "b" && edit((s) => toggleWrap(s, "**"))) event.preventDefault();
      else if (key === "i" && edit((s) => toggleWrap(s, "_"))) event.preventDefault();
      else if (key === "s") {
        event.preventDefault(); // habit: saves now instead of the browser's 「保存」
        void saver.flush();
      }
      return;
    }
    if (ime) return;
    if ((event.key === "Backspace" || event.key === "Delete") && !event.altKey && !event.metaKey && !event.ctrlKey) {
      // M80: beside a task marker's stand-in, the visible character goes and the marker stays.
      const el = area.current;
      if (el && el.selectionStart === el.selectionEnd) {
        const next = deleteBesideStandIns(el.value, el.selectionStart ?? 0, event.key === "Backspace");
        if (next) {
          event.preventDefault();
          put({ text: next.text, start: next.caret, end: next.caret });
          return;
        }
      }
    }
    if (event.key === "Tab") {
      if (edit((s) => indentListLine(s, event.shiftKey))) event.preventDefault();
      return;
    }
    if (event.key === "Enter" && !event.shiftKey) {
      if (edit((s) => continueStructure(s))) event.preventDefault();
    }
  };

  return (
    <div className={cn("relative flex min-h-0 flex-col", className)} style={style}>
      <OverflowToolbar tools={tools} label={t("composer.formatting")} className="shrink-0 border-b border-line px-2 py-1" buttonClassName="h-7 w-7 shrink-0 text-muted hover:text-ink" />
      <textarea
        ref={area}
        aria-label={t("canvasEditor.body")}
        className="min-h-0 flex-1 resize-none bg-canvas px-5 py-4 text-[15px] leading-7 text-ink outline-none placeholder:text-muted max-md:px-4"
        placeholder={t("canvasEditor.placeholder")}
        value={text}
        spellCheck={false}
        onChange={(event) => {
          change(event.target.value);
          setCaret(event.target.selectionStart ?? event.target.value.length);
          focused.current = true;
          announce(true, true);
        }}
        onSelect={(event) => {
          setCaret(event.currentTarget.selectionStart ?? 0);
          if (focused.current) announce(true, true); // a new heading goes out; the same one is not repeated
        }}
        onFocus={() => {
          focused.current = true;
          announce(true);
        }}
        onKeyDown={onKeyDown}
        onCompositionStart={() => {
          composing.current = true;
        }}
        onCompositionEnd={() => {
          composing.current = false;
          saver.compositionEnded();
        }}
        onBlur={(event) => {
          lastCaret.current = event.currentTarget.selectionStart ?? null;
          focused.current = false;
          announce(false);
          void saver.flush();
        }}
        onCopy={(event) => copyOut(event, false)}
        onCut={(event) => copyOut(event, true)}
        onPaste={(event) => {
          const files = [...event.clipboardData.files];
          if (files.some((file) => file.type.startsWith("image/"))) {
            event.preventDefault();
            void insertImages(files);
            return;
          }
          // M80: lines cut in a canvas editor come back with their task markers (as this editor's stand-ins).
          const raw = event.clipboardData.getData(CUT_TYPE);
          const plain = event.clipboardData.getData("text/plain");
          if (raw && plain && stripStandIns(table.hide(raw)) === plain.replace(/\r\n?/g, "\n")) {
            event.preventDefault();
            const el = event.currentTarget;
            const start = el.selectionStart ?? el.value.length;
            const end = el.selectionEnd ?? start;
            const inserted = table.hide(raw);
            put({ text: el.value.slice(0, start) + inserted + el.value.slice(end), start: start + inserted.length, end: start + inserted.length });
            return;
          }
          // A URL pasted over selected text links it, as in the composer; not over a task marker's invisible stand-in.
          const el = event.currentTarget;
          const selected = el.value.slice(el.selectionStart, el.selectionEnd);
          const linked = stripStandIns(selected) === selected ? linkFromPaste({ text: el.value, start: el.selectionStart, end: el.selectionEnd }, plain) : null;
          if (linked) {
            event.preventDefault();
            put(linked);
          }
        }}
        onDragOver={(event) => {
          if ([...event.dataTransfer.types].includes("Files")) event.preventDefault();
        }}
        onDrop={(event) => {
          if (event.dataTransfer.files.length === 0) return;
          event.preventDefault();
          event.currentTarget.focus();
          void insertImages([...event.dataTransfer.files]);
        }}
      />
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
      {uploading > 0 && (
        <div role="status" className="pointer-events-none absolute bottom-3 right-3 z-10 inline-flex items-center gap-1.5 rounded-full border border-line bg-canvas px-3 py-1 text-xs text-muted shadow">
          <Loader2 size={12} className="animate-spin" /> {t("canvasEditor.uploading", { count: uploading })}
        </div>
      )}
      {tableEdit && (
        <CanvasTableDialog
          initial={tableEdit.table}
          isNew={tableEdit.isNew}
          onDone={(table) => closeTable(table)}
          onCancel={() => closeTable("cancel")}
          onClosed={finishTable}
        />
      )}
      {pageCandidates.length > 0 && (
        <ul className="absolute bottom-3 left-3 z-20 w-80 max-w-[calc(100%-1.5rem)] rounded-xl border border-line bg-canvas p-1 shadow-xl" aria-label={t("docs.linkSuggestions")}>
          {pageCandidates.map((page, index) => (
            <li
              key={page.id}
              role="option"
              aria-selected={index === active}
              className={cn("flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-sm", index === active ? "bg-accent-soft" : "hover:bg-panel")}
              onMouseDown={(event) => {
                event.preventDefault();
                pickPage(page);
              }}
            >
              <PageIcon controller={controller} icon={page.icon} size={14} />
              <span className="truncate">{page.title || t("docs.untitled")}</span>
            </li>
          ))}
        </ul>
      )}
      {slashCandidates.length > 0 && (
        <ul className="absolute bottom-3 left-3 z-20 max-h-80 w-64 max-w-[calc(100%-1.5rem)] overflow-y-auto rounded-xl border border-line bg-canvas p-1 shadow-xl" aria-label={t("docs.slash.menu")}>
          {slashCandidates.map((item, index) => (
            <li
              key={item.key}
              role="option"
              aria-selected={index === active}
              className={cn("flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-sm", index === active ? "bg-accent-soft" : "hover:bg-panel")}
              onMouseDown={(event) => {
                event.preventDefault();
                pickSlash(item.key);
              }}
            >
              {t(item.label)}
            </li>
          ))}
        </ul>
      )}
      {childBusy && (
        <div role="status" className="pointer-events-none absolute bottom-3 right-3 z-10 inline-flex items-center gap-1.5 rounded-full border border-line bg-canvas px-3 py-1 text-xs text-muted shadow">
          <Loader2 size={12} className="animate-spin" /> {t("docs.creatingChild")}
        </div>
      )}
      {candidates.length > 0 && (
        <ul className="absolute bottom-3 left-3 z-20 w-72 max-w-[calc(100%-1.5rem)] rounded-xl border border-line bg-canvas p-1 shadow-xl" aria-label={t("canvasEditor.mentionSuggestions")}>
          {candidates.map((candidate, index) => (
            <li
              key={candidate.username}
              className={cn("flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-sm", index === active ? "bg-accent-soft" : "hover:bg-panel")}
              onMouseDown={(event) => {
                event.preventDefault();
                pick(candidate);
              }}
            >
              <strong>@{candidate.username}</strong> <span className="truncate text-muted">{candidate.label}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
