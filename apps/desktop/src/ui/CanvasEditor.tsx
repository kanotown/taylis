/**
 * The canvas's Markdown source editor (CANVAS.md §5 「編集」): a text area with a toolbar (headings, emphasis, lists,
 * checklists, quotes, code, links, mentions, rules, tables (M57), images), the composer's list continuation and `@`
 * completion. Mentions show as `@username` and are stored as `<@uuid>` (§4.2). Every change goes to the save loop (sync/canvasSave.ts); a body the
 * loop replaces (someone else's merged edits, a box ticked in the preview) comes back here with the caret kept.
 * M80 (§22): the hidden task markers of checklist items show as invisible stand-ins (canvasMarkers.ts) that move with
 * their lines; Backspace / Delete beside one take the visible character, a copy leaves them out, a cut keeps them for a
 * paste back into a canvas editor (the line moved keeps its task).
 */
import { AtSign, Bold, Code, Heading1, Heading2, Heading3, ImagePlus, Italic, Link as LinkIcon, List, ListChecks, ListOrdered, Loader2, Minus, Strikethrough, Table as TableIcon, TextQuote } from "lucide-react";
import { type ClipboardEvent, type CSSProperties, type KeyboardEvent, type ReactNode, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";

import { ApiError } from "../api/errors";
import type { CanvasSaver } from "../sync/canvasSave";
import type { AppController } from "../state/app";
import { anchorLine, findTable, insertTable, lineOf, lineStart, NEW_TABLE, parseTable, sameTable, type Table, type TableOrigin, writeBackTable } from "./canvasTable";
import { CanvasTableDialog } from "./CanvasTableDialog";
import { CANVAS_PRESENCE_REFRESH_MS } from "../sync/canvasPresence";
import { attachmentRefs, insertImageLine, insertRule, MAX_CANVAS_IMAGES, preserveCaret, sectionAt, setHeading, toggleTasks } from "./canvasText";
import { continueStructure, type EditState, indentListLine, insertLink, replaceThroughBrowser, toggleLinePrefix, toggleWrap } from "./composerEdit";
import { deleteBesideStandIns, stripStandIns, TaskMarkerTable } from "./canvasMarkers";
import { decodeMentions, encodeMentions, type MentionCandidate, mentionCandidates, mentionQuery } from "./mentions";
import { cn, IconButton, modKey } from "./primitives";

/** M80: what a cut in a canvas editor keeps besides the plain text — the lines with their task markers. */
const CUT_TYPE = "application/x-chikuwachat-canvas";

export function CanvasEditor({ controller, saver, className, style, autoFocus = false }: {
  controller: AppController;
  saver: CanvasSaver;
  className?: string;
  style?: CSSProperties;
  autoFocus?: boolean;
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
    const el = area.current;
    engine?.setCanvasEditing(saver.id, editing, editing && el ? sectionAt(el.value, el.selectionStart ?? 0) : null);
  };
  useEffect(() => {
    const timer = setInterval(() => {
      if (focused.current) announce(true);
    }, CANVAS_PRESENCE_REFRESH_MS);
    return () => {
      clearInterval(timer);
      engine?.setCanvasEditing(saver.id, false);
    };
  }, [engine, saver]); // eslint-disable-line react-hooks/exhaustive-deps

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
  const insertImages = async (list: readonly File[]) => {
    const images = list.filter((file) => file.type.startsWith("image/"));
    if (images.length === 0) {
      if (list.length > 0) controller.setError("キャンバスに入れられるのは画像だけです");
      return;
    }
    if (attachmentRefs(saver.text).size + images.length > MAX_CANVAS_IMAGES) {
      controller.setError(new ApiError(400, "too_many_canvas_images", "Too many images"));
      return;
    }
    setUploading((n) => n + images.length);
    for (const file of images) {
      const uploaded = await controller.uploadCanvasImage(file);
      setUploading((n) => n - 1);
      if (!uploaded) continue;
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
    }
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
      tableSession.current = { table: NEW_TABLE, place: { line, content: value.split("\n")[line] ?? "" }, outcome: null };
      setTableEdit({ table: NEW_TABLE, isNew: true });
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
    if (out.inserted) controller.setNotice("編集中に表がほかの人に変更されていたので、編集した表はその下に新しい表として入れました");
  };
  const closeTable = (outcome: Table | "cancel") => {
    if (tableSession.current) tableSession.current.outcome = outcome;
    setTableEdit(null);
  };

  const query = mentionQuery(text, caret);
  const listKey = query ? `${query.start}:${query.query}` : null;
  const candidates: MentionCandidate[] = query && dismissed !== listKey
    ? mentionCandidates(query.query, [...store.users.values()], [...store.groups.values()], 8).filter((c) => c.kind !== "all") // `<!channel>` notifies nobody in a canvas
    : [];
  const active = Math.min(selected, Math.max(candidates.length - 1, 0));
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

  const tools: Array<{ icon: ReactNode; label: string; run: () => void } | "gap"> = [
    { icon: <Heading1 size={16} />, label: "見出し 1", run: () => edit((s) => setHeading(s, 1)) },
    { icon: <Heading2 size={16} />, label: "見出し 2", run: () => edit((s) => setHeading(s, 2)) },
    { icon: <Heading3 size={16} />, label: "見出し 3", run: () => edit((s) => setHeading(s, 3)) },
    "gap",
    { icon: <Bold size={16} />, label: `太字 (${modKey()}+B)`, run: () => edit((s) => toggleWrap(s, "**")) },
    { icon: <Italic size={16} />, label: `斜体 (${modKey()}+I)`, run: () => edit((s) => toggleWrap(s, "_")) },
    { icon: <Strikethrough size={16} />, label: "取り消し線", run: () => edit((s) => toggleWrap(s, "~~")) },
    "gap",
    { icon: <List size={16} />, label: "箇条書き", run: () => edit((s) => toggleLinePrefix(s, "- ")) },
    { icon: <ListOrdered size={16} />, label: "番号付きリスト", run: () => edit((s) => toggleLinePrefix(s, (i) => `${i + 1}. `)) },
    { icon: <ListChecks size={16} />, label: "チェックリスト", run: () => edit(toggleTasks) },
    { icon: <TextQuote size={16} />, label: "引用", run: () => edit((s) => toggleLinePrefix(s, "> ")) },
    { icon: <Code size={16} />, label: "コード", run: () => edit((s) => toggleWrap(s, "`")) },
    "gap",
    { icon: <LinkIcon size={16} />, label: "リンク", run: () => edit((s) => insertLink(s)) },
    { icon: <AtSign size={16} />, label: "メンション", run: () => edit((s) => {
      const lead = s.start > 0 && !/\s/.test(s.text[s.start - 1] ?? "") ? " @" : "@";
      return { text: s.text.slice(0, s.start) + lead + s.text.slice(s.end), start: s.start + lead.length, end: s.start + lead.length };
    }) },
    { icon: <Minus size={16} />, label: "区切り線", run: () => edit(insertRule) },
    { icon: <TableIcon size={16} />, label: "表", run: openTable },
    { icon: <ImagePlus size={16} />, label: "画像 (貼り付け・ドロップでも入れられます)", run: () => picker.current?.click() },
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
    if (candidates.length > 0 && !ime) {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        setSelected((active + (event.key === "ArrowDown" ? 1 : candidates.length - 1)) % candidates.length);
        return;
      }
      if (event.key === "Enter" || event.key === "Tab") {
        event.preventDefault();
        const candidate = candidates[active];
        if (candidate) pick(candidate);
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
      <div role="toolbar" aria-label="書式" className="flex shrink-0 items-center gap-0.5 overflow-x-auto overflow-y-hidden border-b border-line px-2 py-1 [scrollbar-width:none]">
        {tools.map((tool, index) =>
          tool === "gap" ? (
            <span key={index} aria-hidden className="mx-1 h-4 w-px shrink-0 bg-line" />
          ) : (
            <IconButton key={index} label={tool.label} className="h-7 w-7 shrink-0 text-muted hover:text-ink" onMouseDown={(event) => event.preventDefault()} onClick={tool.run}>
              {tool.icon}
            </IconButton>
          ),
        )}
      </div>
      <textarea
        ref={area}
        aria-label="キャンバスの本文 (Markdown)"
        className="min-h-0 flex-1 resize-none bg-canvas px-5 py-4 text-[15px] leading-7 text-ink outline-none placeholder:text-muted max-md:px-4"
        placeholder={"# 見出し\n本文を書きます。\n- [ ] チェックリスト\n@名前 でメンション"}
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
        aria-label="キャンバスに入れる画像"
        onChange={(event) => {
          const files = [...(event.target.files ?? [])];
          event.target.value = "";
          void insertImages(files);
        }}
      />
      {uploading > 0 && (
        <div role="status" className="pointer-events-none absolute bottom-3 right-3 z-10 inline-flex items-center gap-1.5 rounded-full border border-line bg-canvas px-3 py-1 text-xs text-muted shadow">
          <Loader2 size={12} className="animate-spin" /> 画像をアップロード中… ({uploading})
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
      {candidates.length > 0 && (
        <ul className="absolute bottom-3 left-3 z-20 w-72 max-w-[calc(100%-1.5rem)] rounded-xl border border-line bg-canvas p-1 shadow-xl" aria-label="メンションの候補">
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
