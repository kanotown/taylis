/**
 * The canvas's Markdown source editor (CANVAS.md §5 「編集」): a text area with a toolbar (headings, emphasis, lists,
 * checklists, quotes, code, links, rules, mentions), the composer's list continuation and `@` completion. Mentions show
 * as `@username` and are stored as `<@uuid>` (§4.2). Every change goes to the save loop (sync/canvasSave.ts); a body the
 * loop replaces (someone else's merged edits, a box ticked in the preview) comes back here with the caret kept.
 */
import { AtSign, Bold, Code, Heading1, Heading2, Heading3, ImagePlus, Italic, Link as LinkIcon, List, ListChecks, ListOrdered, Loader2, Minus, Strikethrough, TextQuote } from "lucide-react";
import { type CSSProperties, type KeyboardEvent, type ReactNode, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";

import { ApiError } from "../api/errors";
import type { CanvasSaver } from "../sync/canvasSave";
import type { AppController } from "../state/app";
import { attachmentRefs, insertImageLine, insertRule, MAX_CANVAS_IMAGES, preserveCaret, setHeading, toggleTasks } from "./canvasText";
import { continueStructure, type EditState, indentListLine, insertLink, toggleLinePrefix, toggleWrap } from "./composerEdit";
import { decodeMentions, encodeMentions, type MentionCandidate, mentionCandidates, mentionQuery } from "./mentions";
import { cn, IconButton, modKey } from "./primitives";

export function CanvasEditor({ controller, saver, className, style, autoFocus = false }: {
  controller: AppController;
  saver: CanvasSaver;
  className?: string;
  style?: CSSProperties;
  autoFocus?: boolean;
}) {
  const store = controller.store;
  useSyncExternalStore((listener) => saver.subscribe(listener), () => saver.textRevision);
  const decode = (wire: string) => decodeMentions(wire, store.users, store.groups);
  const encode = (shown: string) => encodeMentions(shown, store.users.values(), store.groups.values());
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

  /** A formatting edit on the current selection; focus and selection come back afterwards. */
  const edit = (transform: (state: EditState) => EditState | null): boolean => {
    const el = area.current;
    if (!el) return false;
    const next = transform({ text, start: el.selectionStart ?? text.length, end: el.selectionEnd ?? text.length });
    if (!next) return false;
    change(next.text);
    setCaret(next.start);
    const restore = () => {
      el.focus();
      el.setSelectionRange(next.start, next.end);
    };
    if (typeof requestAnimationFrame === "function") requestAnimationFrame(restore);
    else setTimeout(restore, 0);
    return true;
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
    { icon: <ImagePlus size={16} />, label: "画像 (貼り付け・ドロップでも入れられます)", run: () => picker.current?.click() },
  ];

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
      <div role="toolbar" aria-label="書式" className="flex shrink-0 items-center gap-0.5 overflow-x-auto border-b border-line px-2 py-1 [scrollbar-width:none]">
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
        }}
        onSelect={(event) => setCaret(event.currentTarget.selectionStart ?? 0)}
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
          void saver.flush();
        }}
        onPaste={(event) => {
          const files = [...event.clipboardData.files];
          if (files.some((file) => file.type.startsWith("image/"))) {
            event.preventDefault();
            void insertImages(files);
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
