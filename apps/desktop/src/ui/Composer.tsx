import { ATTACHMENT_MAX_BYTES, ATTACHMENT_MAX_COUNT, forEachPicked, isPickBusy, refusePicked, takePicked } from "../platform/pickedFiles";
import { AtSign, Bold, CalendarDays, CaseSensitive, Check, CheckCheck, ChevronDown, Code, Ellipsis, Eye, EyeOff, Flag, Heading, Image, Info, Italic, LayoutTemplate, Link as LinkIcon, List, ListOrdered, Loader2, Paperclip, Plus, SendHorizontal, Smile, SquareCode, Strikethrough, TextQuote, Vote, X, Zap } from "lucide-react";
import { Fragment, type KeyboardEvent, type ReactNode, type RefObject, useEffect, useLayoutEffect, useRef, useState } from "react";

import type { AttachmentOut, Priority, TemplateOut, WorkflowOut } from "../api/types";
import type { AppController } from "../state/app";
import type { ChannelState, SendOptions } from "../sync/types";
import { composerMaxHeight } from "../platform/viewport";
import { PriorityLabel } from "./PriorityLabel";
import { PendingAttachments } from "./Attachments";
import { continueStructure, type EditState, indentListLine, insertLink, insideFence, replaceThroughBrowser, toggleFence, toggleLinePrefix, toggleWrap } from "./composerEdit";
import { commandCandidates, parseSlashCommand, type SlashCommand } from "./commands";
import { AiBadge } from "./ai";
import { encodeMentions, type MentionCandidate, mentionCandidates, mentionQuery } from "./mentions";
import { AddEmojiDialog, CustomEmojiImage } from "./customEmoji";
import { canPostTopLevel } from "./channels";
import { completeEmoji, customEmojiCandidates, emojiCandidates, emojiQuery, type EmojiEntry } from "./emoji";
import { EmojiPicker, readRecentEmoji, rememberEmoji } from "./EmojiPicker";
import { MessageBody } from "./MessageBody";
import { isSendKey, readFormatBar, sendKeyLabel, writeFormatBar } from "./prefs";
import { scheduleLabel, schedulePresets, toLocalInput } from "./schedule";
import { PollDialog } from "./PollDialog";
import { ChannelWorkflowsDialog, useChannelWorkflows, WorkflowEmoji, WorkflowRunDialog } from "./WorkflowViews";
import { findWorkflowCommand, workflowCandidates } from "./workflows";
import { ScheduleDialog, type ScheduleFormInitial } from "./ScheduleDialog";
import { slotsFromEntries } from "./scheduling";
import { appendTemplate, expandTemplate, findTemplate, orderTemplates, readSchedule, SCHEDULE_USAGE, templateCandidates, templateSummary, templateWithText } from "./templates";
import { Button, cn, IconButton, Kbd, Menu, MenuContent, MenuItem, MenuTrigger, modKey, PopoverAnchor, PopoverContent, PopoverRoot, PopoverTrigger } from "./primitives";

const MAX_LENGTH = 20_000;
/** Bold, italic, strikethrough, code, code block: always on the formatting bar. */
const PRIMARY_TOOLS = 5;
/** WebKit delivers the Enter that commits an IME composition after compositionend. */
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
  const candidates = query && listShown ? mentionCandidates(query.query, [...store.users.values()], [...store.groups.values()], 6, new Set(store.aiStatus?.agents.map((a) => a.bot_user_id))) : [];
  const emojiHits = emojiAt && listShown ? [...customEmojiCandidates(emojiAt.query, store.customEmoji), ...emojiCandidates(emojiAt.query)].slice(0, 8) : [];
  const [addEmojiOpen, setAddEmojiOpen] = useState(false);
  // M30: the templates in the order they are offered here (a times channel puts `suggest_in = times` first).
  const templates = orderTemplates(store.templates.values(), !!channel.times_owner_id);
  // M94: the workflows this channel offers (`/name`, `/wf name`, 「＋」 → ワークフロー); not in a thread's composer.
  const isChannel = channel.type === "public" || channel.type === "private";
  const workflows = useChannelWorkflows(controller, !parentId && isChannel ? channel.id : null) ?? [];
  const [workflowRun, setWorkflowRun] = useState<WorkflowOut | null>(null);
  const [workflowMenu, setWorkflowMenu] = useState(false);
  // `/st` at the very start offers the slash commands (M13b), then the templates whose name fits (M30).
  const slashHits: SlashHit[] = query || emojiAt || !listShown ? [] : [
    ...commandCandidates(text).map((command) => ({ kind: "command" as const, command })),
    ...templateCandidates(text, templates).map((template) => ({ kind: "template" as const, template })),
    ...workflowCandidates(text, workflows).map((workflow) => ({ kind: "workflow" as const, workflow })),
  ];
  const listLength = candidates.length > 0 ? candidates.length : emojiHits.length > 0 ? emojiHits.length : slashHits.length;
  const active = Math.min(selected, Math.max(listLength - 1, 0));
  const [emojiOpen, setEmojiOpen] = useState(false);
  const [moreToolsOpen, setMoreToolsOpen] = useState(false);

  // The poll form, and the scheduling poll's form with what it starts with (M53: `/日程 …` fills it in).
  const [pollForm, setPollForm] = useState<{ question?: string; options?: string[]; multiple?: boolean } | null>(null);
  const [scheduleForm, setScheduleForm] = useState<ScheduleFormInitial | null>(null);
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
        // M94: `/name` of a workflow (or `/wf name`) opens its form; what was typed goes.
        const workflow = findWorkflowCommand(command.name, command.args, workflows);
        if (workflow) {
          setText("");
          setWorkflowRun(workflow);
          return;
        }
        if (command.name === "wf") {
          controller.setError(command.args ? `「${command.args}」というワークフローはこのチャンネルにありません` : "/wf の後にワークフローの名前を続けてください");
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
        // M53: the scheduling poll's form, with the dates (and times) typed after it as the candidates.
        const read = command.args ? readSchedule(command.args) : null;
        if (command.args && !read) {
          // Nothing opens; what was typed stays to be corrected.
          controller.setError(SCHEDULE_USAGE);
          return;
        }
        setText("");
        setScheduleForm(read ? { question: read.question, slots: slotsFromEntries(read.entries) } : {});
        return;
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

  /** Uploads picked, dropped or pasted files. The count and each size are checked before any byte is read (review
   *  v0.1.30 #5); a picker's files (`picked`) are then copied into memory one at a time, each uploaded before the
   *  next is read, and the input is cleared after the last (platform/pickedFiles.ts). The upload counter (which holds
   *  back sending) rises at once. */
  const pickFiles = async (files: File[], picked?: { release: () => void }) => {
    const api = controller.api;
    const release = picked?.release ?? (() => {});
    if (!api || files.length === 0) { release(); return; }
    const refusal = refusePicked(files, { maxFiles: ATTACHMENT_MAX_COUNT - pending.length - uploading, maxBytes: ATTACHMENT_MAX_BYTES });
    if (refusal) { release(); controller.setError(refusal); return; }
    const channelId = channel.id;
    store.trackUpload(channelId, parentId, files.length);
    const upload = async (file: File) => {
      try {
        const uploaded = await api.uploadAttachment(file, file.name);
        setPending((items) => [...items, uploaded]);
      } catch (error) {
        controller.setError(error);
      } finally {
        store.trackUpload(channelId, parentId, -1);
      }
    };
    if (!picked) {
      for (const file of files) await upload(file);
      return;
    }
    await forEachPicked(files, upload, release, (error) => {
      controller.setError(error);
      store.trackUpload(channelId, parentId, -1);
    });
  };

  /** Opens a file picker, unless the files picked on it last are still being read (a new pick would replace them). */
  const openPicker = (input: HTMLInputElement | null) => {
    if (isPickBusy(input)) { controller.setError("前に選んだファイルを読み込み中です"); return; }
    input?.click();
  };

  const pick = (candidate: MentionCandidate) => {
    if (!query) return;
    const next = text.slice(0, query.start) + "@" + candidate.username + " " + text.slice(caret);
    const position = query.start + candidate.username.length + 2;
    setSelected(0);
    apply({ text: next, start: position, end: position });
  };

  /** Replaces the input and puts the caret at its end (a template inserted, M30). */
  const putText = (next: string) => {
    setSelected(0);
    apply({ text: next, start: next.length, end: next.length });
  };

  /** The 「テンプレート」 button: the body alone in an empty input, else after what is there and a blank line. */
  const insertTemplate = (template: TemplateOut) => {
    setTemplatesOpen(false);
    putText(appendTemplate(store.draft(channel.id, parentId).text, expandTemplate(template.body)));
  };

  const pickSlash = (hit: SlashHit) => {
    if (hit.kind === "command") pickCommand(hit.command);
    else if (hit.kind === "workflow") {
      setText("");
      setWorkflowRun(hit.workflow);
    } else putText(expandTemplate(hit.template.body)); // the whole input is `/na…`: it becomes the template at once
  };

  const pickCommand = (command: SlashCommand) => {
    putText(`/${command.name} `);
  };

  const pickEmoji = (entry: EmojiEntry) => {
    if (!emojiAt) return;
    const next = completeEmoji(text, emojiAt.start, caret, entry.glyph);
    rememberEmoji(entry.glyph);
    setSelected(0);
    apply({ text: next.text, start: next.caret, end: next.caret });
  };

  /** The toolbar picker: insert at the caret (replacing a selection) and keep typing. */
  const insertEmoji = (entry: EmojiEntry) => {
    rememberEmoji(entry.glyph);
    setEmojiOpen(false);
    edit((s) => ({ text: s.text.slice(0, s.start) + entry.glyph + s.text.slice(s.end), start: s.start + entry.glyph.length, end: s.start + entry.glyph.length }));
  };

  const syncCaret = (element: HTMLTextAreaElement) => setCaret(element.selectionStart ?? element.value.length);

  /**
   * Puts `next` in the text area through the browser's own editing (replaceThroughBrowser), so ⌘Z / Ctrl+Z takes back
   * a format, an emoji, a completion, a template or a continued list one step at a time between what was typed, and
   * ⌘⇧Z / Ctrl+Y redoes it (tester, 2026-09-30). Setting the draft from React would drop the text area's undo history;
   * that stays the way only where the browser does not take the edit. Focus and selection come back afterwards.
   */
  const apply = (next: EditState) => {
    const el = area.current;
    if (el && replaceThroughBrowser(el, next.text)) el.setSelectionRange(next.start, next.end);
    else setText(next.text);
    setCaret(next.start);
    // Again on the next frame: a closing popover hands focus back to its button meanwhile.
    const restore = () => {
      area.current?.focus();
      area.current?.setSelectionRange(next.start, next.end);
    };
    if (typeof requestAnimationFrame === "function") requestAnimationFrame(restore);
    else setTimeout(restore, 0);
  };

  /** Run a markdown edit on the current selection. */
  const edit = (transform: (state: EditState) => EditState | null): boolean => {
    const el = area.current;
    if (!el) return false;
    const value = el.value;
    const next = transform({ text: value, start: el.selectionStart ?? value.length, end: el.selectionEnd ?? value.length });
    if (!next) return false;
    apply(next);
    return true;
  };

  /** 「@」: an @ at the caret (after a space when a word ends there), which opens the member list. */
  const startMention = () => edit((s) => {
    const at = s.start > 0 && !/\s/.test(s.text[s.start - 1]!) ? " @" : "@";
    const caret = s.start + at.length;
    return { text: s.text.slice(0, s.start) + at + s.text.slice(s.end), start: caret, end: caret };
  });

  // The formatting bar above the text (Slack), shown or hidden with 「Aa」, per device.
  const [formatBar, setFormatBar] = useState(readFormatBar);
  const toggleFormatBar = () => {
    writeFormatBar(!formatBar);
    setFormatBar(!formatBar);
  };
  // The first PRIMARY_TOOLS always show; the rest fold into 「その他の書式」 when the composer is narrow. `group`
  // starts a group after a divider.
  const tools: Array<{ icon: ReactNode; label: string; run: () => void; group?: true }> = [
    { icon: <Bold size={15} />, label: `太字 (${modKey()}+B)`, run: () => edit((s) => toggleWrap(s, "**")) },
    { icon: <Italic size={15} />, label: `斜体 (${modKey()}+I)`, run: () => edit((s) => toggleWrap(s, "_")) },
    { icon: <Strikethrough size={15} />, label: `取り消し線 (${modKey()}+Shift+X)`, run: () => edit((s) => toggleWrap(s, "~~")) },
    { icon: <Code size={15} />, label: `コード (${modKey()}+Shift+C)`, run: () => edit((s) => toggleWrap(s, "`")), group: true },
    { icon: <SquareCode size={15} />, label: "コードブロック", run: () => edit(toggleFence) },
    { icon: <Heading size={15} />, label: "見出し (## )", run: () => edit((s) => toggleLinePrefix(s, "## ")), group: true },
    { icon: <TextQuote size={15} />, label: "引用", run: () => edit((s) => toggleLinePrefix(s, "> ")) },
    { icon: <List size={15} />, label: "箇条書き", run: () => edit((s) => toggleLinePrefix(s, "- ")) },
    { icon: <ListOrdered size={15} />, label: "番号付きリスト", run: () => edit((s) => toggleLinePrefix(s, (i) => `${i + 1}. `)) },
    { icon: <LinkIcon size={15} />, label: `リンク (${modKey()}+Shift+U)`, run: () => edit((s) => insertLink(s)), group: true },
  ];

  // A menu entry that opens something else (a popover, the poll form, the member list) runs once the menu has closed
  // and handed focus back, which the new layer would otherwise take for a click outside and close again (Radix).
  const afterMenu = useRef<(() => void) | null>(null);
  const runAfterMenu = (event: Event) => {
    const run = afterMenu.current;
    if (!run) return;
    afterMenu.current = null;
    event.preventDefault();
    run();
  };
  // On a narrow composer the emoji, 「@」 and priority buttons fold into 「…」; their popovers then open from there.
  const emojiButton = useRef<HTMLButtonElement>(null);
  const priorityButton = useRef<HTMLButtonElement>(null);
  const moreButton = useRef<HTMLButtonElement>(null);
  const emojiAnchor = useShownAnchor(emojiButton, moreButton);
  const priorityAnchor = useShownAnchor(priorityButton, moreButton);

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
    if (mod && !event.altKey && !event.nativeEvent.isComposing && !composing.current) {
      const key = event.key.toLowerCase();
      let handled = false;
      if (key === "b" && !event.shiftKey) handled = edit((s) => toggleWrap(s, "**"));
      else if (key === "i" && !event.shiftKey) handled = edit((s) => toggleWrap(s, "_"));
      else if (key === "x" && event.shiftKey) handled = edit((s) => toggleWrap(s, "~~"));
      else if (key === "c" && event.shiftKey) handled = edit((s) => toggleWrap(s, "`"));
      else if (key === "u" && event.shiftKey) handled = edit((s) => insertLink(s));
      else if (key === "u") {
        openPicker(fileInput.current);
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
        void pickFiles(Array.from(event.dataTransfer.files));
      }}
    >
      {addEmojiOpen && <AddEmojiDialog controller={controller} onClose={() => setAddEmojiOpen(false)} />}
      {pollForm && <PollDialog controller={controller} channelId={channel.id} parentId={parentId} initial={pollForm} onClose={() => setPollForm(null)} />}
      {workflowRun && <WorkflowRunDialog controller={controller} workflow={workflowRun} here={channel.id} onClose={() => setWorkflowRun(null)} />}
      {workflowMenu && <ChannelWorkflowsDialog controller={controller} channel={channel} onClose={() => setWorkflowMenu(false)} />}
      {scheduleForm && <ScheduleDialog controller={controller} channelId={channel.id} parentId={parentId} initial={scheduleForm} onClose={() => setScheduleForm(null)} />}
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
              <strong>@{candidate.username}</strong> <span className="text-muted">{candidate.label}</span>{candidate.kind === "group" && <span className="ml-auto rounded bg-accent-soft px-1.5 text-[10px] text-accent">グループ</span>}{candidate.ai && <AiBadge className="ml-auto" />}
            </li>
          ))}
        </ul>
      )}
      {slashHits.length > 0 && (
        <ul className="absolute bottom-full left-4 z-20 mb-1 max-h-80 w-96 max-w-[calc(100%-2rem)] overflow-y-auto rounded-xl border border-line bg-canvas p-1 shadow-xl" aria-label="コマンドの候補">
          {slashHits.map((hit, index) => (
            <li
              key={hit.kind === "command" ? hit.command.name : hit.kind === "workflow" ? `wf:${hit.workflow.id}` : hit.template.id}
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
              ) : hit.kind === "workflow" ? (
                <>
                  <WorkflowEmoji workflow={hit.workflow} className="self-center" />
                  <strong className="shrink-0 font-mono">{/\s/.test(hit.workflow.name) ? `/wf ${hit.workflow.name}` : `/${hit.workflow.name}`}</strong>
                  <span className="min-w-0 flex-1 truncate text-muted">{hit.workflow.description || "ワークフロー"}</span>
                  {!hit.workflow.can_run && <span className="ml-auto shrink-0 text-[10px] text-warning">使えません</span>}
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
      {/* Sized by the composer, not the window: a thread pane or a narrow window folds what does not fit; no row wraps. */}
      <div className="@container rounded-xl border border-line bg-canvas shadow-sm transition focus-within:border-accent focus-within:ring-2 focus-within:ring-accent/25">
        {/* The formatting bar above the text, as in Slack (tester, 2026-09-30); 「Aa」 below shows or hides it. */}
        {formatBar && (
          <div className="flex items-center gap-0.5 px-2 pt-1.5" aria-label="書式">
            {tools.map((tool, index) => (
              <Fragment key={tool.label}>
                {tool.group && <span className={cn("mx-1 h-4 w-px shrink-0 bg-line", index >= PRIMARY_TOOLS && "hidden @[22rem]:block")} />}
                <IconButton
                  label={tool.label}
                  className={cn("h-7 w-7 shrink-0 text-muted hover:text-ink", index >= PRIMARY_TOOLS && "hidden @[22rem]:inline-flex")}
                  disabled={preview}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={tool.run}
                >
                  {tool.icon}
                </IconButton>
              </Fragment>
            ))}
            <PopoverRoot open={moreToolsOpen} onOpenChange={setMoreToolsOpen}>
              <PopoverTrigger asChild>
                <button type="button" title="その他の書式" aria-label="その他の書式" disabled={preview} onMouseDown={(e) => e.preventDefault()} className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted hover:bg-panel-2 hover:text-ink disabled:opacity-40 @[22rem]:hidden">
                  <Ellipsis size={15} />
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
          </div>
        )}
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
            const picked = takePicked(e.target);
            void pickFiles(picked.files, picked);
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
            const picked = takePicked(e.target);
            void pickFiles(picked.files, picked);
          }}
        />
        <div className="relative">
          {/* As tall as the text area at most: a long preview pushed the send button off the window (tester, 2026-09-30). */}
          {preview && (
            <div className="max-h-[280px] min-h-14 overflow-y-auto pb-1 pl-3 pr-10 pt-3" aria-label="プレビュー">
              {text.trim() ? <MessageBody body={text} users={store.users} /> : <span className="text-sm text-muted">プレビューする本文がありません</span>}
            </div>
          )}
          <textarea
            ref={area}
            value={text}
            maxLength={MAX_LENGTH}
            placeholder={placeholder}
            className={cn("block max-h-[280px] w-full resize-none overflow-y-auto bg-transparent pb-1 pl-3 pr-10 pt-3 text-[14.5px] leading-6 text-ink outline-none placeholder:text-muted", preview && "hidden")}
            onChange={(e) => {
              setText(e.target.value);
              syncCaret(e.target);
              if (e.target.value.trim()) controller.engine?.sendTyping(channel.id, parentId ?? null); // §5.2, throttled by the engine
            }}
            onPaste={(event) => { if (event.clipboardData.files.length) { event.preventDefault(); void pickFiles(Array.from(event.clipboardData.files)); } }}
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
          {/* The preview toggle in the text's top-right corner (2026-10-04); 「書式の書き方」 is by the send button. */}
          <IconButton label={preview ? "編集に戻る" : "プレビュー"} aria-pressed={preview} className={cn("absolute right-1 top-1 h-7 w-7 text-muted hover:text-ink", preview && "bg-accent-soft text-accent")} onClick={() => setPreview((v) => !v)}>
            {preview ? <EyeOff size={15} /> : <Eye size={15} />}
          </IconButton>
        </div>
        <div className="flex flex-nowrap items-center gap-2 px-2 pb-2" data-composer-actions>
          <div className="flex min-w-0 flex-1 flex-nowrap items-center gap-0.5">
            {/* 「＋」: attachments, a poll and the templates (Slack). The template list opens from it. */}
            <PopoverRoot open={templatesOpen} onOpenChange={setTemplatesOpen}>
              <Menu>
                <PopoverAnchor asChild>
                  <MenuTrigger asChild>
                    <IconButton label={`ファイルを添付・その他 (${modKey()}+U)`} className="h-7 w-7 shrink-0 text-muted hover:text-ink">
                      <Plus size={17} />
                    </IconButton>
                  </MenuTrigger>
                </PopoverAnchor>
                <MenuContent align="start" side="top" onCloseAutoFocus={runAfterMenu}>
                  <MenuItem disabled={uploading > 0} onSelect={() => openPicker(mediaInput.current)}>
                    <Image size={14} className="text-muted" /> 写真・動画
                  </MenuItem>
                  <MenuItem disabled={uploading > 0} onSelect={() => openPicker(fileInput.current)}>
                    <Paperclip size={14} className="text-muted" /> ファイル <Kbd className="ml-auto">{modKey()}+U</Kbd>
                  </MenuItem>
                  <MenuItem onSelect={() => { afterMenu.current = () => setPollForm({}); }}>
                    <Vote size={14} className="text-muted" /> アンケート
                  </MenuItem>
                  <MenuItem onSelect={() => { afterMenu.current = () => setScheduleForm({}); }}>
                    <CalendarDays size={14} className="text-muted" /> 日程調整
                  </MenuItem>
                  <MenuItem onSelect={() => { afterMenu.current = () => setTemplatesOpen(true); }}>
                    <LayoutTemplate size={14} className="text-muted" /> テンプレート…
                  </MenuItem>
                  {!parentId && isChannel && (
                    <MenuItem onSelect={() => { afterMenu.current = () => setWorkflowMenu(true); }}>
                      <Zap size={14} className="text-muted" /> ワークフロー…
                    </MenuItem>
                  )}
                </MenuContent>
              </Menu>
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
            <IconButton label={formatBar ? "書式を隠す" : "書式を表示"} className={cn("h-7 w-7 shrink-0 hover:text-ink", formatBar ? "text-ink" : "text-muted")} onMouseDown={(e) => e.preventDefault()} onClick={toggleFormatBar}>
              <CaseSensitive size={18} />
            </IconButton>
            <PopoverRoot open={emojiOpen} onOpenChange={setEmojiOpen}>
              <PopoverAnchor virtualRef={emojiAnchor} />
              <PopoverTrigger asChild>
                <button ref={emojiButton} type="button" title="絵文字" aria-label="絵文字" className="hidden h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted hover:bg-panel-2 hover:text-ink @[17rem]:flex">
                  <Smile size={15} />
                </button>
              </PopoverTrigger>
              <PopoverContent align="start" side="top" className="w-auto p-3">
                <EmojiPicker recent={readRecentEmoji()} custom={[...store.customEmoji.values()]} controller={controller} onAddCustom={() => { setEmojiOpen(false); setAddEmojiOpen(true); }} onPick={insertEmoji} />
              </PopoverContent>
            </PopoverRoot>
            <IconButton label="メンションを追加" className="hidden h-7 w-7 shrink-0 text-muted hover:text-ink @[17rem]:inline-flex" disabled={preview} onMouseDown={(e) => e.preventDefault()} onClick={startMention}>
              <AtSign size={15} />
            </IconButton>
            {!parentId && (
              <PopoverRoot open={priorityOpen} onOpenChange={setPriorityOpen}>
                <PopoverAnchor virtualRef={priorityAnchor} />
                <PopoverTrigger asChild>
                  <button ref={priorityButton} type="button" title="重要度" aria-label="重要度" className={cn("hidden h-7 w-7 shrink-0 items-center justify-center rounded-lg hover:bg-ink/6 @[17rem]:inline-flex", priority || ackRequested ? "text-accent" : "text-muted hover:text-ink")}>
                    <Flag size={15} />
                  </button>
                </PopoverTrigger>
                <PopoverContent align="start" side="top" className="w-60 p-2">
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
            <Menu>
              <MenuTrigger asChild>
                <button ref={moreButton} type="button" title="その他" aria-label="その他の操作" className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted hover:bg-panel-2 hover:text-ink @[17rem]:hidden">
                  <Ellipsis size={15} />
                </button>
              </MenuTrigger>
              <MenuContent align="start" side="top" onCloseAutoFocus={runAfterMenu}>
                <MenuItem onSelect={() => { afterMenu.current = () => setEmojiOpen(true); }}>
                  <Smile size={14} className="text-muted" /> 絵文字
                </MenuItem>
                <MenuItem disabled={preview} onSelect={() => { afterMenu.current = startMention; }}>
                  <AtSign size={14} className="text-muted" /> メンションを追加
                </MenuItem>
                {!parentId && (
                  <MenuItem onSelect={() => { afterMenu.current = () => setPriorityOpen(true); }}>
                    <Flag size={14} className="text-muted" /> 重要度
                  </MenuItem>
                )}
              </MenuContent>
            </Menu>
          </div>
          <div className="flex shrink-0 items-center gap-3">
            <MarkdownHelp />
            <span className="-ml-2 hidden items-center gap-1 whitespace-nowrap text-[11px] text-muted @3xl:flex">
              <Kbd>{sendKeyLabel(controller.sendKey ?? "mod-enter").send}</Kbd> 送信 <Kbd>{sendKeyLabel(controller.sendKey ?? "mod-enter").newline}</Kbd> 改行
            </span>
            {/* 「送信」 and its ▾ with 「後で送信」, as Slack's schedule dropdown. */}
            <div className="flex items-center">
              <Button size="sm" className="rounded-r-none" onClick={send} disabled={uploading > 0 || (!text.trim() && pending.length === 0)}>
                <SendHorizontal size={14} /> 送信
              </Button>
              <PopoverRoot open={scheduleOpen} onOpenChange={setScheduleOpen}>
                <PopoverTrigger asChild>
                  <button type="button" aria-label="後で送信" title="後で送信" disabled={uploading > 0 || scheduling || (!text.trim() && pending.length === 0)} className="inline-flex h-7 w-6 items-center justify-center rounded-r-md border-l border-white/30 bg-accent text-white shadow-sm transition-colors hover:bg-accent/90 disabled:pointer-events-none disabled:opacity-50">
                    <ChevronDown size={14} />
                  </button>
                </PopoverTrigger>
                <PopoverContent align="end" side="top" className="w-72 p-3">
                  <div className="mb-2 text-xs font-semibold text-muted">後で送信</div>
                  <ul className="space-y-0.5">
                    {schedulePresets().map((preset) => (
                      <li key={preset.key}>
                        <button type="button" className="flex w-full items-center justify-between rounded-md px-2 py-1.5 text-left text-sm hover:bg-panel" onClick={() => void schedule(preset.at)}>
                          <span>{preset.label}</span>
                          {scheduleLabel(preset.at.toISOString()) !== preset.label && <span className="text-xs text-muted">{scheduleLabel(preset.at.toISOString())}</span>}
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

type SlashHit = { kind: "command"; command: SlashCommand } | { kind: "template"; template: TemplateOut } | { kind: "workflow"; workflow: WorkflowOut };

/** A popover anchor at the first of these elements that is shown (the others folded away by the composer's width). */
function useShownAnchor(...elements: Array<RefObject<HTMLElement | null>>): RefObject<{ getBoundingClientRect(): DOMRect }> {
  return useRef({
    getBoundingClientRect: () => {
      const shown = elements.map((ref) => ref.current).find((el) => el && el.getClientRects().length > 0);
      return shown ? shown.getBoundingClientRect() : new DOMRect();
    },
  });
}

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

/**
 * 「書式の書き方」: the supported syntax, by the send button. Kept inside the window (2026-10-04: cut off at times):
 * above the button when there is room, as tall as the room there is, scrolling inside. An example of several lines
 * (the table) is a code block with its line breaks.
 */
export function MarkdownHelp() {
  return (
    <PopoverRoot>
      <PopoverTrigger asChild>
        <button type="button" aria-label="書式の書き方" title="書式の書き方" className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-muted hover:bg-ink/6 hover:text-ink">
          <Info size={15} />
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" side="top" className="max-h-[var(--radix-popover-content-available-height)] w-[420px] overflow-y-auto p-3">
        <div className="mb-2 text-xs font-semibold">書式 (軽量 Markdown)</div>
        <table className="w-full text-xs">
          <tbody className="divide-y divide-line">
            {SYNTAX.map(([syntax, meaning]) => (
              <tr key={syntax}>
                <td className="py-1 pr-3 align-top">
                  {syntax.includes("\n") ? (
                    <pre className="whitespace-pre rounded bg-panel-2 px-1.5 py-1 font-mono leading-5">{syntax}</pre>
                  ) : (
                    <code className="whitespace-nowrap rounded bg-panel-2 px-1.5 py-0.5">{syntax}</code>
                  )}
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
