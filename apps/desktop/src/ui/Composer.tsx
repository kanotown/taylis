import { Bold, Check, CheckCheck, Clock, Code, Eye, EyeOff, Flag, Heading, Info, Italic, LayoutTemplate, Link as LinkIcon, List, ListOrdered, Loader2, Paperclip, SendHorizontal, Smile, SquareCode, Strikethrough, TextQuote, Type, Vote, X } from "lucide-react";
import { type KeyboardEvent, type ReactNode, useEffect, useLayoutEffect, useRef, useState } from "react";

import type { AttachmentOut, Priority, TemplateOut } from "../api/types";
import type { AppController } from "../state/app";
import type { ChannelState, SendOptions } from "../sync/types";
import { composerMaxHeight } from "../platform/viewport";
import { PriorityLabel } from "./PriorityLabel";
import { PendingAttachments } from "./Attachments";
import { continueStructure, type EditState, indentListLine, insertLink, insideFence, toggleFence, toggleLinePrefix, toggleWrap } from "./composerEdit";
import { commandCandidates, parseSlashCommand, type SlashCommand } from "./commands";
import { encodeMentions, type MentionCandidate, mentionCandidates, mentionQuery } from "./mentions";
import { AddEmojiDialog, CustomEmojiImage } from "./customEmoji";
import { canPostTopLevel } from "./channels";
import { completeEmoji, customEmojiCandidates, emojiCandidates, emojiQuery, type EmojiEntry } from "./emoji";
import { EmojiPicker, readRecentEmoji, rememberEmoji } from "./EmojiPicker";
import { MessageBody } from "./MessageBody";
import { isSendKey, sendKeyLabel } from "./prefs";
import { scheduleLabel, schedulePresets, toLocalInput } from "./schedule";
import { PollDialog } from "./PollDialog";
import { appendTemplate, expandTemplate, findTemplate, nextWeekdays, orderTemplates, parseSchedule, SCHEDULE_QUESTION, SCHEDULE_USAGE, templateCandidates, templateSummary, templateWithText } from "./templates";
import { Button, cn, IconButton, Kbd, Menu, MenuContent, MenuItem, MenuTrigger, modKey, PopoverContent, PopoverRoot, PopoverTrigger } from "./primitives";

const MAX_LENGTH = 20_000;
/** WebKit delivers the Enter that commits an IME composition after compositionend. */
/** Bold, italic, strikethrough, code: always on the toolbar. */
const PRIMARY_TOOLS = 4;
const IME_COMMIT_GRACE_MS = 100;

export function Composer({
  controller,
  channel,
  parentId = null,
  placeholder = "メッセージを入力 (@ でメンション)",
  onReplyLast,
}: {
  controller: AppController;
  channel: ChannelState;
  parentId?: string | null;
  placeholder?: string;
  /** Shift+↑ in an empty composer: reply in a thread to the newest message (Slack / Mattermost). */
  onReplyLast?: () => void;
}) {
  const store = controller.store;
  const { text, attachments: pending } = store.draft(channel.id, parentId);
  const uploading = store.uploading(channel.id, parentId);
  const setText = (text: string) => store.setDraft(channel.id, parentId, { text });
  const setPending = (update: AttachmentOut[] | ((items: AttachmentOut[]) => AttachmentOut[])) => {
    const items = store.draft(channel.id, parentId).attachments;
    store.setDraft(channel.id, parentId, { attachments: typeof update === "function" ? update(items) : update });
  };
  // M15c: "also send to the channel" for a thread reply; unticked again after each send (Slack).
  const [alsoInChannel, setAlsoInChannel] = useState(false);
  // M15e: priority and "ask for acknowledgement" for a top-level post; cleared after each send.
  const [priority, setPriority] = useState<Priority | null>(null);
  const [ackRequested, setAckRequested] = useState(false);
  const [priorityOpen, setPriorityOpen] = useState(false);
  const canShare = parentId !== null && canPostTopLevel(channel, controller.isAdmin);
  const [caret, setCaret] = useState(0);
  const [selected, setSelected] = useState(0);
  const [preview, setPreview] = useState(false);

  const fileInput = useRef<HTMLInputElement>(null);
  const mediaInput = useRef<HTMLInputElement>(null);
  const composing = useRef(false);
  const composedAt = useRef(0);
  const area = useRef<HTMLTextAreaElement>(null);
  // Grow with the draft (lists and code blocks span several lines) up to a cap, then scroll. On a phone the cap follows
  // what the keyboard leaves (platform/viewport.ts), also when the keyboard comes or goes.
  const [viewportHeight, setViewportHeight] = useState(() => window.visualViewport?.height ?? 0);
  useEffect(() => {
    const viewport = window.visualViewport;
    if (!viewport) return;
    const update = () => setViewportHeight(viewport.height);
    viewport.addEventListener("resize", update);
    return () => viewport.removeEventListener("resize", update);
  }, []);
  useLayoutEffect(() => {
    const el = area.current;
    if (!el || preview) return;
    // Measuring collapses the text area for a moment; its box keeps its height meanwhile, or the timeline above would
    // grow, lose its bottom to the browser's clamping and jump on every keystroke.
    const box = el.parentElement;
    const held = box?.style.minHeight ?? "";
    if (box) box.style.minHeight = `${box.offsetHeight}px`;
    el.style.height = "auto";
    if (el.scrollHeight > 0) el.style.height = `${Math.min(el.scrollHeight, composerMaxHeight())}px`;
    if (box) box.style.minHeight = held;
  }, [text, preview, viewportHeight]);
  const query = mentionQuery(text, caret);
  // `:tada` completes to an emoji (M11f) when no mention is being typed.
  const emojiAt = query ? null : emojiQuery(text, caret);
  // Esc closes the candidate list for what is typed now (and goes no further: the screen's Esc would close the thread
  // or read the conversation); typing on shows it again.
  const listKey = query ? `@${query.start}:${query.query}` : emojiAt ? `:${emojiAt.start}:${emojiAt.query}` : `/${text}`;
  const [dismissed, setDismissed] = useState<string | null>(null);
  const listShown = dismissed !== listKey;
  const candidates = query && listShown ? mentionCandidates(query.query, [...store.users.values()], [...store.groups.values()]) : [];
  const emojiHits = emojiAt && listShown ? [...customEmojiCandidates(emojiAt.query, store.customEmoji), ...emojiCandidates(emojiAt.query)].slice(0, 8) : [];
  const [addEmojiOpen, setAddEmojiOpen] = useState(false);
  // M30: the templates in the order they are offered here (a times channel puts `suggest_in = times` first).
  const templates = orderTemplates(store.templates.values(), !!channel.times_owner_id);
  // `/st` at the very start offers the slash commands (M13b), then the templates whose name fits (M30).
  const slashHits: SlashHit[] = query || emojiAt || !listShown ? [] : [
    ...commandCandidates(text).map((command) => ({ kind: "command" as const, command })),
    ...templateCandidates(text, templates).map((template) => ({ kind: "template" as const, template })),
  ];
  const listLength = candidates.length > 0 ? candidates.length : emojiHits.length > 0 ? emojiHits.length : slashHits.length;
  const active = Math.min(selected, Math.max(listLength - 1, 0));
  const [emojiOpen, setEmojiOpen] = useState(false);
  const [moreToolsOpen, setMoreToolsOpen] = useState(false);

  // The poll form and what it starts with (`/日程` alone fills it in, M30).
  const [pollForm, setPollForm] = useState<{ question?: string; options?: string[]; multiple?: boolean } | null>(null);
  const [templatesOpen, setTemplatesOpen] = useState(false);
  const send = () => {
    const command = parseSlashCommand(text);
    if (command) {
      if (!command.known) {
        // M30: `/name` (or `/name text`) of a template is not sent: the input takes the template instead.
        const template = findTemplate(templates, command.name);
        if (template) {
          putText(templateWithText(expandTemplate(template.body), command.args));
          return;
        }
        controller.setError(`/${command.name} というコマンドはありません (/help で一覧)`);
        return;
      }
      if (command.name === "poll" && !command.args.trim()) {
        // `/poll` alone opens the form (a question and its options can still be typed after it).
        setText("");
        setPollForm({});
        return;
      }
      if (command.name === "日程") {
        if (!command.args) {
          // `/日程` alone: the form, with the next five weekdays as the options.
          setText("");
          setPollForm({ question: SCHEDULE_QUESTION, options: nextWeekdays(new Date(), 5), multiple: true });
          return;
        }
        if (!parseSchedule(command.args)) {
          // Nothing is posted; what was typed stays to be corrected.
          controller.setError(SCHEDULE_USAGE);
          return;
        }
      }
      setText("");
      void controller.runCommand(command, channel, parentId);
      return;
    }
    const body = encodeMentions(text.trim(), store.users.values(), store.groups.values());
    if ((!body && pending.length === 0) || !controller.engine || uploading > 0) return;
    if (pending.length > 10 || body.length > MAX_LENGTH) { controller.setError("添付は10件、本文は20,000文字までです"); return; }
    const ids = pending.map((a) => a.id);
    setText("");
    setPending([]);
    const options: SendOptions = {};
    if (canShare && alsoInChannel) options.alsoInChannel = true;
    if (!parentId && priority) options.priority = priority;
    if (!parentId && ackRequested) options.ackRequested = true;
    setAlsoInChannel(false);
    setPriority(null);
    setAckRequested(false);
    void controller.engine.send(channel.id, body, undefined, parentId, ids, options);
  };

  // M12d 「後で送信」: the same draft, posted by the server at the chosen time.
  const [scheduleOpen, setScheduleOpen] = useState(false);
  const [customAt, setCustomAt] = useState(() => toLocalInput(new Date(Date.now() + 60 * 60_000)));
  // Codex audit C2: one key per schedule, kept while the same draft is scheduled again after a failure (the first
  // request may have gone through), whatever time is picked the second time: the server then answers with the row it
  // made, instead of making a second one. No second request while one is on its way.
  const [scheduling, setScheduling] = useState(false);
  const scheduleKey = useRef<{ key: string; what: string } | null>(null);
  const schedule = async (sendAt: Date) => {
    const body = encodeMentions(text.trim(), store.users.values(), store.groups.values());
    if ((!body && pending.length === 0) || uploading > 0 || scheduling) return;
    if (Number.isNaN(sendAt.getTime()) || sendAt.getTime() < Date.now() + 60_000) { controller.setError("1 分以上先の時刻を選んでください"); return; }
    const ids = pending.map((a) => a.id);
    const what = JSON.stringify([channel.id, parentId, body, ids]);
    if (scheduleKey.current?.what !== what) scheduleKey.current = { key: crypto.randomUUID(), what };
    const typed = text;
    setScheduleOpen(false);
    setScheduling(true);
    const done = await controller.scheduleMessage(channel.id, parentId, body, ids, sendAt, scheduleKey.current.key);
    setScheduling(false);
    if (!done) return;
    scheduleKey.current = null;
    // Codex audit C1: what was typed while the request was on its way stays (only the scheduled text leaves).
    if (store.draft(channel.id, parentId).text === typed) setText("");
    setPending((items) => items.filter((a) => !ids.includes(a.id)));
  };

  const pickFiles = async (files: FileList | null) => {
    const api = controller.api;
    if (!files || !api) return;
    const batch = Array.from(files);
    if (pending.length + uploading + batch.length > 10) { controller.setError("添付は10件までです"); return; }
    store.trackUpload(channel.id, parentId, batch.length);
    for (const file of batch) {
      try {
        const uploaded = await api.uploadAttachment(file, file.name);
        setPending((items) => [...items, uploaded]);
      } catch (error) {
        controller.setError(error);
      } finally {
        store.trackUpload(channel.id, parentId, -1);
      }
    }
  };

  const pick = (candidate: MentionCandidate) => {
    if (!query) return;
    const next = text.slice(0, query.start) + "@" + candidate.username + " " + text.slice(caret);
    const position = query.start + candidate.username.length + 2;
    setText(next);
    setSelected(0);
    setCaret(position);
    requestAnimationFrame(() => {
      area.current?.focus();
      area.current?.setSelectionRange(position, position);
    });
  };

  /** Replaces the input and puts the caret at its end (a template inserted, M30). */
  const putText = (next: string) => {
    setText(next);
    setSelected(0);
    setCaret(next.length);
    const restore = () => {
      area.current?.focus();
      area.current?.setSelectionRange(next.length, next.length);
    };
    if (typeof requestAnimationFrame === "function") requestAnimationFrame(restore);
    else setTimeout(restore, 0);
  };

  /** The 「テンプレート」 button: the body alone in an empty input, else after what is there and a blank line. */
  const insertTemplate = (template: TemplateOut) => {
    setTemplatesOpen(false);
    putText(appendTemplate(store.draft(channel.id, parentId).text, expandTemplate(template.body)));
  };

  const pickSlash = (hit: SlashHit) => {
    if (hit.kind === "command") pickCommand(hit.command);
    else putText(expandTemplate(hit.template.body)); // the whole input is `/na…`: it becomes the template at once
  };

  const pickCommand = (command: SlashCommand) => {
    const next = `/${command.name} `;
    setText(next);
    setSelected(0);
    setCaret(next.length);
    requestAnimationFrame(() => {
      area.current?.focus();
      area.current?.setSelectionRange(next.length, next.length);
    });
  };

  const pickEmoji = (entry: EmojiEntry) => {
    if (!emojiAt) return;
    const next = completeEmoji(text, emojiAt.start, caret, entry.glyph);
    rememberEmoji(entry.glyph);
    setText(next.text);
    setSelected(0);
    setCaret(next.caret);
    requestAnimationFrame(() => {
      area.current?.focus();
      area.current?.setSelectionRange(next.caret, next.caret);
    });
  };

  /** The toolbar picker: insert at the caret (replacing a selection) and keep typing. */
  const insertEmoji = (entry: EmojiEntry) => {
    rememberEmoji(entry.glyph);
    setEmojiOpen(false);
    edit((s) => ({ text: s.text.slice(0, s.start) + entry.glyph + s.text.slice(s.end), start: s.start + entry.glyph.length, end: s.start + entry.glyph.length }));
  };

  const syncCaret = (element: HTMLTextAreaElement) => setCaret(element.selectionStart ?? element.value.length);

  /** Run a markdown edit on the current selection and restore focus + selection afterwards. */
  const edit = (transform: (state: EditState) => EditState | null): boolean => {
    const el = area.current;
    if (!el) return false;
    const next = transform({ text, start: el.selectionStart ?? text.length, end: el.selectionEnd ?? text.length });
    if (!next) return false;
    setText(next.text);
    setCaret(next.start);
    const restore = () => {
      el.focus();
      el.setSelectionRange(next.start, next.end);
    };
    if (typeof requestAnimationFrame === "function") requestAnimationFrame(restore);
    else setTimeout(restore, 0);
    return true;
  };
  // The first PRIMARY_TOOLS always show; the rest fold into 「その他の書式」 when the composer is narrow.
  const tools: Array<{ icon: ReactNode; label: string; run: () => void }> = [
    { icon: <Bold size={15} />, label: `太字 (${modKey()}+B)`, run: () => edit((s) => toggleWrap(s, "**")) },
    { icon: <Italic size={15} />, label: `斜体 (${modKey()}+I)`, run: () => edit((s) => toggleWrap(s, "_")) },
    { icon: <Strikethrough size={15} />, label: `取り消し線 (${modKey()}+Shift+X)`, run: () => edit((s) => toggleWrap(s, "~~")) },
    { icon: <Code size={15} />, label: `コード (${modKey()}+Shift+C)`, run: () => edit((s) => toggleWrap(s, "`")) },
    { icon: <SquareCode size={15} />, label: "コードブロック", run: () => edit(toggleFence) },
    { icon: <Heading size={15} />, label: "見出し (## )", run: () => edit((s) => toggleLinePrefix(s, "## ")) },
    { icon: <TextQuote size={15} />, label: "引用", run: () => edit((s) => toggleLinePrefix(s, "> ")) },
    { icon: <List size={15} />, label: "箇条書き", run: () => edit((s) => toggleLinePrefix(s, "- ")) },
    { icon: <ListOrdered size={15} />, label: "番号付きリスト", run: () => edit((s) => toggleLinePrefix(s, (i) => `${i + 1}. `)) },
    { icon: <LinkIcon size={15} />, label: `リンク (${modKey()}+Shift+U)`, run: () => edit((s) => insertLink(s)) },
  ];

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    const imeEnter =
      event.nativeEvent.isComposing ||
      composing.current ||
      event.keyCode === 229 ||
      Date.now() - composedAt.current < IME_COMMIT_GRACE_MS;
    if (listLength > 0 && !imeEnter) {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        setDismissed(listKey);
        return;
      }
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setSelected((active + 1) % listLength);
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        setSelected((active - 1 + listLength) % listLength);
        return;
      }
      if (event.key === "Enter" || event.key === "Tab") {
        event.preventDefault();
        const candidate = candidates[active];
        if (candidate) pick(candidate);
        else if (emojiHits[active]) pickEmoji(emojiHits[active]!);
        else if (slashHits[active]) pickSlash(slashHits[active]!);
        return;
      }
    }
    const mod = event.metaKey || event.ctrlKey;
    if (mod && !event.altKey) {
      const key = event.key.toLowerCase();
      let handled = false;
      if (key === "b" && !event.shiftKey) handled = edit((s) => toggleWrap(s, "**"));
      else if (key === "i" && !event.shiftKey) handled = edit((s) => toggleWrap(s, "_"));
      else if (key === "x" && event.shiftKey) handled = edit((s) => toggleWrap(s, "~~"));
      else if (key === "c" && event.shiftKey) handled = edit((s) => toggleWrap(s, "`"));
      else if (key === "u" && event.shiftKey) handled = edit((s) => insertLink(s));
      else if (key === "u") {
        fileInput.current?.click();
        handled = true;
      }
      if (handled) {
        event.preventDefault();
        return;
      }
    }
    if (event.key === "Tab" && !imeEnter && listLength === 0) {
      // Tab changes the nesting of a list line; elsewhere it keeps moving focus.
      if (edit((s) => indentListLine(s, event.shiftKey))) event.preventDefault();
      return;
    }
    if (event.key === "ArrowUp" && text === "" && !imeEnter) {
      if (event.shiftKey) {
        if (onReplyLast) {
          event.preventDefault();
          onReplyLast();
        }
        return;
      }
      // ↑ in an empty composer edits my newest message in this conversation.
      const me = store.me;
      const pool = parentId ? store.replies(channel.id, parentId) : store.messages(channel.id);
      const mine = pool.filter((m) => m.sender_id === me?.id && !m.pending && !m.deleted).at(-1);
      if (mine) {
        event.preventDefault();
        controller.setEditing(mine.id);
      }
      return;
    }
    if (event.key !== "Enter") return;
    if (imeEnter) return; // confirming a Japanese conversion, not sending
    const sendKey = controller.sendKey ?? "mod-enter";
    if (isSendKey(event, sendKey)) {
      const el = area.current;
      // With Enter as the send key, Enter inside an open ``` fence is still a newline.
      if (sendKey === "enter" && insideFence(text, el?.selectionStart ?? text.length)) return;
      event.preventDefault();
      send();
      return;
    }
    // Newline: continue a list / quote (or end it on an empty item); otherwise the plain newline.
    if (edit((s) => continueStructure(s))) event.preventDefault();
  };

  return (
    <div
      className="composer relative px-4 pb-1 pt-1"
      onDragOver={(event) => event.preventDefault()}
      onDrop={(event) => {
        event.preventDefault();
        void pickFiles(event.dataTransfer.files);
      }}
    >
      {addEmojiOpen && <AddEmojiDialog controller={controller} onClose={() => setAddEmojiOpen(false)} />}
      {pollForm && <PollDialog controller={controller} channelId={channel.id} parentId={parentId} initial={pollForm} onClose={() => setPollForm(null)} />}
      {emojiHits.length > 0 && (
        <ul className="absolute bottom-full left-4 z-20 mb-1 w-72 rounded-xl border border-line bg-canvas p-1 shadow-xl" aria-label="絵文字の候補">
          {emojiHits.map((entry, index) => (
            <li
              key={entry.shortcode}
              className={cn("flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-sm", index === active ? "bg-accent-soft" : "hover:bg-panel")}
              onMouseDown={(event) => {
                event.preventDefault();
                pickEmoji(entry);
              }}
            >
              {entry.category === "custom" && store.customEmoji.get(entry.shortcode) ? (
                <CustomEmojiImage controller={controller} emoji={store.customEmoji.get(entry.shortcode)!} size={20} />
              ) : (
                <span className="text-lg leading-none">{entry.glyph}</span>
              )}{" "}
              <span className="text-muted">:{entry.shortcode}:</span>
            </li>
          ))}
        </ul>
      )}
      {candidates.length > 0 && (
        <ul className="absolute bottom-full left-4 z-20 mb-1 w-72 rounded-xl border border-line bg-canvas p-1 shadow-xl">
          {candidates.map((candidate, index) => (
            <li
              key={candidate.username}
              className={cn("flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-sm", index === active ? "bg-accent-soft" : "hover:bg-panel")}
              onMouseDown={(event) => {
                event.preventDefault();
                pick(candidate);
              }}
            >
              <strong>@{candidate.username}</strong> <span className="text-muted">{candidate.label}</span>{candidate.kind === "group" && <span className="ml-auto rounded bg-accent-soft px-1.5 text-[10px] text-accent">グループ</span>}
            </li>
          ))}
        </ul>
      )}
      {slashHits.length > 0 && (
        <ul className="absolute bottom-full left-4 z-20 mb-1 max-h-80 w-96 max-w-[calc(100%-2rem)] overflow-y-auto rounded-xl border border-line bg-canvas p-1 shadow-xl" aria-label="コマンドの候補">
          {slashHits.map((hit, index) => (
            <li
              key={hit.kind === "command" ? hit.command.name : hit.template.id}
              className={cn("flex items-baseline gap-2 rounded-lg px-2.5 py-1.5 text-sm", index === active ? "bg-accent-soft" : "hover:bg-panel")}
              onMouseDown={(event) => {
                event.preventDefault();
                pickSlash(hit);
              }}
            >
              {hit.kind === "command" ? (
                <>
                  <strong className="font-mono">{hit.command.usage}</strong> <span className="text-muted">{hit.command.description}</span>
                </>
              ) : (
                <>
                  <strong className="shrink-0 font-mono">/{hit.template.name}</strong>
                  <span className="min-w-0 flex-1 truncate text-muted">{templateSummary(hit.template.body)}</span>
                  {hit.template.scope === "user" && <TemplateMark />}
                </>
              )}
            </li>
          ))}
        </ul>
      )}
      <div className="rounded-xl border border-line bg-canvas shadow-sm transition focus-within:border-accent focus-within:ring-2 focus-within:ring-accent/25">
        {(priority || ackRequested) && (
          <div className="flex items-center gap-2 px-3 pt-2 text-xs">
            {priority && <PriorityLabel priority={priority} />}
            {ackRequested && <span className="inline-flex items-center gap-1 text-muted"><CheckCheck size={12} /> 確認を求める</span>}
            <button type="button" className="text-muted hover:text-ink" aria-label="重要度を外す" onClick={() => { setPriority(null); setAckRequested(false); }}>
              <X size={12} />
            </button>
          </div>
        )}
        {uploading > 0 && (
          <div className="flex items-center gap-2 px-3 pt-2 text-xs text-muted" role="status">
            <Loader2 size={12} className="animate-spin" /> 添付をアップロード中… 完了後に送信できます
          </div>
        )}
        <div className={cn((pending.length > 0 || uploading > 0) && "px-2 pt-2")}>
          <PendingAttachments items={pending} uploading={uploading} controller={controller} onRemove={(item) => setPending((items) => items.filter((a) => a.id !== item.id))} />
        </div>
        <input
          ref={fileInput}
          type="file"
          multiple
          hidden
          onChange={(e) => {
            void pickFiles(e.target.files);
            e.target.value = "";
          }}
        />
        <input
          ref={mediaInput}
          type="file"
          accept="image/*,video/*"
          multiple
          hidden
          aria-label="写真・動画を選択"
          onChange={(e) => {
            void pickFiles(e.target.files);
            e.target.value = "";
          }}
        />
        {/* As tall as the text area at most: a long preview pushed the send button off the window (tester, 2026-09-30). */}
        {preview && (
          <div className="max-h-[280px] min-h-14 overflow-y-auto px-3 pb-1 pt-3" aria-label="プレビュー">
            {text.trim() ? <MessageBody body={text} users={store.users} /> : <span className="text-sm text-muted">プレビューする本文がありません</span>}
          </div>
        )}
        <textarea
          ref={area}
          value={text}
          maxLength={MAX_LENGTH}
          placeholder={placeholder}
          className={cn("block max-h-[280px] w-full resize-none overflow-y-auto bg-transparent px-3 pb-1 pt-3 text-[14.5px] leading-6 text-ink outline-none placeholder:text-muted", preview && "hidden")}
          onChange={(e) => {
            setText(e.target.value);
            syncCaret(e.target);
            if (e.target.value.trim()) controller.engine?.sendTyping(channel.id, parentId ?? null); // §5.2, throttled by the engine
          }}
          onPaste={(event) => { if (event.clipboardData.files.length) { event.preventDefault(); void pickFiles(event.clipboardData.files); } }}
          aria-label={parentId ? "スレッドの返信" : "メッセージ"}
          onKeyDown={onKeyDown}
          onKeyUp={(e) => syncCaret(e.currentTarget)}
          onClick={(e) => syncCaret(e.currentTarget)}
          onCompositionStart={() => {
            composing.current = true;
          }}
          onCompositionEnd={() => {
            composing.current = false;
            composedAt.current = Date.now();
          }}
          rows={2}
        />
        {/* Sized by the composer, not the window: a thread pane or a narrow window folds the toolbar. */}
        <div className="@container px-2 pb-2">
        <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1">
          <div className="flex min-w-0 flex-wrap items-center gap-0.5">
            {tools.map((tool, index) => (
              <IconButton
                key={tool.label}
                label={tool.label}
                className={cn("h-7 w-7 text-muted hover:text-ink", index >= PRIMARY_TOOLS && "hidden @2xl:inline-flex")}
                disabled={preview}
                onMouseDown={(e) => e.preventDefault()}
                onClick={tool.run}
              >
                {tool.icon}
              </IconButton>
            ))}
            <PopoverRoot open={moreToolsOpen} onOpenChange={setMoreToolsOpen}>
              <PopoverTrigger asChild>
                <button type="button" title="その他の書式" aria-label="その他の書式" disabled={preview} onMouseDown={(e) => e.preventDefault()} className="flex h-7 w-7 items-center justify-center rounded-md text-muted hover:bg-panel-2 hover:text-ink disabled:opacity-40 @2xl:hidden">
                  <Type size={15} />
                </button>
              </PopoverTrigger>
              <PopoverContent align="start" className="w-auto p-1.5" onOpenAutoFocus={(e) => e.preventDefault()}>
                <div className="flex gap-0.5">
                  {tools.slice(PRIMARY_TOOLS).map((tool) => (
                    <IconButton
                      key={tool.label}
                      label={tool.label}
                      className="h-8 w-8 text-muted hover:text-ink"
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => {
                        tool.run();
                        setMoreToolsOpen(false);
                      }}
                    >
                      {tool.icon}
                    </IconButton>
                  ))}
                </div>
              </PopoverContent>
            </PopoverRoot>
            <PopoverRoot open={emojiOpen} onOpenChange={setEmojiOpen}>
              <PopoverTrigger asChild>
                <button type="button" title="絵文字" aria-label="絵文字" className="flex h-7 w-7 items-center justify-center rounded-md text-muted hover:bg-panel-2 hover:text-ink">
                  <Smile size={15} />
                </button>
              </PopoverTrigger>
              <PopoverContent align="start" className="w-auto p-3">
                <EmojiPicker recent={readRecentEmoji()} custom={[...store.customEmoji.values()]} controller={controller} onAddCustom={() => { setEmojiOpen(false); setAddEmojiOpen(true); }} onPick={insertEmoji} />
              </PopoverContent>
            </PopoverRoot>
            <span className="mx-1 h-4 w-px bg-line" />
            <Menu>
              <MenuTrigger asChild>
                <IconButton label={`ファイルを添付 (${modKey()}+U)`} className="h-7 w-7 text-muted hover:text-ink" disabled={uploading > 0}>
                  <Paperclip size={15} />
                </IconButton>
              </MenuTrigger>
              <MenuContent align="start" side="top">
                <MenuItem onSelect={() => mediaInput.current?.click()}>写真・動画</MenuItem>
                <MenuItem onSelect={() => fileInput.current?.click()}>ファイル</MenuItem>
              </MenuContent>
            </Menu>
            <IconButton label="アンケートを作成" className="h-7 w-7 text-muted hover:text-ink" onClick={() => setPollForm({})}>
              <Vote size={15} />
            </IconButton>
            <PopoverRoot open={templatesOpen} onOpenChange={setTemplatesOpen}>
              <PopoverTrigger asChild>
                <button type="button" title="テンプレート" aria-label="テンプレート" className="flex h-7 w-7 items-center justify-center rounded-md text-muted hover:bg-panel-2 hover:text-ink">
                  <LayoutTemplate size={15} />
                </button>
              </PopoverTrigger>
              <PopoverContent align="start" side="top" className="w-80 p-1" onCloseAutoFocus={(e) => e.preventDefault()}>
                <div className="px-2 pb-1 pt-1 text-xs font-semibold text-muted">テンプレート</div>
                {templates.length === 0 ? (
                  <p className="px-2 pb-2 text-sm text-muted">テンプレートはありません (設定で追加できます)</p>
                ) : (
                  <ul className="max-h-72 overflow-y-auto" aria-label="テンプレートの一覧">
                    {templates.map((template) => (
                      <li key={template.id}>
                        <button type="button" className="flex w-full items-baseline gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-panel" onClick={() => insertTemplate(template)}>
                          <span className="shrink-0 font-medium">{template.name}</span>
                          <span className="min-w-0 flex-1 truncate text-xs text-muted">{templateSummary(template.body)}</span>
                          {template.scope === "user" && <TemplateMark />}
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </PopoverContent>
            </PopoverRoot>
            <IconButton label={preview ? "編集に戻る" : "プレビュー"} aria-pressed={preview} className={cn("h-7 w-7 text-muted hover:text-ink", preview && "bg-accent-soft text-accent")} onClick={() => setPreview((v) => !v)}>
              {preview ? <EyeOff size={15} /> : <Eye size={15} />}
            </IconButton>
            <MarkdownHelp />
            {!parentId && (
              <PopoverRoot open={priorityOpen} onOpenChange={setPriorityOpen}>
                <PopoverTrigger asChild>
                  <button type="button" title="重要度" aria-label="重要度" className={cn("inline-flex h-7 w-7 items-center justify-center rounded-lg hover:bg-ink/6", priority || ackRequested ? "text-accent" : "text-muted hover:text-ink")}>
                    <Flag size={15} />
                  </button>
                </PopoverTrigger>
                <PopoverContent align="start" className="w-60 p-2">
                  <div className="px-1 pb-1 text-xs font-semibold text-muted">重要度</div>
                  {([[null, "通常"], ["important", "重要"], ["urgent", "緊急"]] as Array<[Priority | null, string]>).map(([value, label]) => (
                    <button key={label} type="button" className={cn("flex w-full items-center justify-between rounded-md px-2 py-1.5 text-left text-sm hover:bg-panel", priority === value && "bg-accent-soft")} onClick={() => setPriority(value)}>
                      {value ? <PriorityLabel priority={value} /> : <span>{label}</span>}
                      {priority === value && <Check size={14} className="text-accent" />}
                    </button>
                  ))}
                  <label className="mt-1 flex cursor-pointer items-center gap-2 border-t border-line px-2 pt-2 text-sm">
                    <input type="checkbox" className="accent-[var(--accent)]" checked={ackRequested} onChange={(e) => setAckRequested(e.target.checked)} />
                    確認を求める
                  </label>
                </PopoverContent>
              </PopoverRoot>
            )}
          </div>
          <div className="ml-auto flex shrink-0 items-center gap-3">
            <span className="hidden items-center gap-1 text-[11px] text-muted @3xl:flex">
              <Kbd>{sendKeyLabel(controller.sendKey ?? "mod-enter").send}</Kbd> 送信 <Kbd>{sendKeyLabel(controller.sendKey ?? "mod-enter").newline}</Kbd> 改行
            </span>
            <PopoverRoot open={scheduleOpen} onOpenChange={setScheduleOpen}>
              <PopoverTrigger asChild>
                <button type="button" aria-label="後で送信" title="後で送信" disabled={uploading > 0 || scheduling || (!text.trim() && pending.length === 0)} className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-muted transition-colors hover:bg-ink/6 hover:text-ink disabled:opacity-40">
                  <Clock size={15} />
                </button>
              </PopoverTrigger>
              <PopoverContent align="end" className="w-72 p-3">
                <div className="mb-2 text-xs font-semibold text-muted">後で送信</div>
                <ul className="space-y-0.5">
                  {schedulePresets().map((preset) => (
                    <li key={preset.key}>
                      <button type="button" className="flex w-full items-center justify-between rounded-md px-2 py-1.5 text-left text-sm hover:bg-panel" onClick={() => void schedule(preset.at)}>
                        <span>{preset.label}</span>
                        <span className="text-xs text-muted">{scheduleLabel(preset.at.toISOString())}</span>
                      </button>
                    </li>
                  ))}
                </ul>
                <div className="mt-2 flex items-center gap-2 border-t border-line pt-2">
                  <input type="datetime-local" value={customAt} aria-label="日時を指定" className="h-8 flex-1 rounded-lg border border-line bg-canvas px-2 text-xs" onChange={(e) => setCustomAt(e.target.value)} />
                  <Button size="sm" variant="secondary" onClick={() => void schedule(new Date(customAt))}>予約</Button>
                </div>
              </PopoverContent>
            </PopoverRoot>
            <Button size="sm" onClick={send} disabled={uploading > 0 || (!text.trim() && pending.length === 0)}>
              <SendHorizontal size={14} /> 送信
            </Button>
          </div>
        </div>
        </div>
      </div>
      {canShare && (
        <label className="mt-1.5 flex w-fit cursor-pointer items-center gap-1.5 text-xs text-muted">
          <input type="checkbox" className="accent-[var(--accent)]" checked={alsoInChannel} onChange={(e) => setAlsoInChannel(e.target.checked)} />
          {channel.type === "dm" || channel.type === "group_dm" ? "会話にも送信" : `#${channel.name ?? ""} にも送信`}
        </label>
      )}
    </div>
  );
}

type SlashHit = { kind: "command"; command: SlashCommand } | { kind: "template"; template: TemplateOut };

/** Marks my own templates in the lists (the workspace's have none). */
function TemplateMark() {
  return <span className="ml-auto shrink-0 rounded bg-accent-soft px-1.5 text-[10px] text-accent">個人</span>;
}

const SYNTAX: Array<[string, string]> = [
  ["**太字** または *太字*", "太字"],
  ["_斜体_", "斜体"],
  ["~~取り消し~~", "取り消し線"],
  ["`コード`", "インラインコード"],
  ["# 見出し / ## / ###", "見出し (3 段階)"],
  ["```言語 … ``` (行頭)", "コードブロック。中では Enter で改行"],
  ["> 引用", "引用。Enter で次の行も引用"],
  ["- 項目 / 1. 項目", "箇条書き / 番号付き。Enter で次の項目、空の項目で Enter すると終了、Tab で字下げ"],
  ["[表示名](https://…)", "リンク"],
  ["| 項目 | 担当 |\n| --- | --- |\n| API | 田中 |", "表 (2 行目の --- で見出しと区切る。:--: で中央寄せ)"],
  ["@名前", "メンション (候補から選ぶ)"],
];

/** "?" popover with the supported syntax. */
function MarkdownHelp() {
  return (
    <PopoverRoot>
      <PopoverTrigger asChild>
        <button type="button" aria-label="書式の書き方" title="書式の書き方" className="inline-flex h-7 w-7 items-center justify-center rounded-lg text-muted hover:bg-ink/6 hover:text-ink">
          <Info size={15} />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[420px] p-3">
        <div className="mb-2 text-xs font-semibold">書式 (軽量 Markdown)</div>
        <table className="w-full text-xs">
          <tbody className="divide-y divide-line">
            {SYNTAX.map(([syntax, meaning]) => (
              <tr key={syntax}>
                <td className="whitespace-nowrap py-1 pr-3 align-top">
                  <code className="rounded bg-panel-2 px-1.5 py-0.5">{syntax}</code>
                </td>
                <td className="py-1 text-muted">{meaning}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </PopoverContent>
    </PopoverRoot>
  );
}
