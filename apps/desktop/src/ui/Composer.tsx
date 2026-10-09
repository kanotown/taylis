import { ATTACHMENT_MAX_BYTES, ATTACHMENT_MAX_COUNT, forEachPicked, isPickBusy, refusePicked, takePicked } from "../platform/pickedFiles";
import { AtSign, Bold, CalendarDays, CaseSensitive, Check, CheckCheck, ChevronDown, Code, Ellipsis, Eye, EyeOff, Flag, Heading, Image, Info, Italic, LayoutTemplate, Link as LinkIcon, List, ListOrdered, Loader2, Paperclip, Plus, SendHorizontal, Smile, SquareCode, Strikethrough, TextQuote, Vote, X, Zap } from "lucide-react";
import { type KeyboardEvent, type ReactNode, type RefObject, Suspense, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

import type { AttachmentOut, Priority, TemplateOut, WorkflowOut } from "../api/types";
import type { AppController } from "../state/app";
import type { ChannelState, SendOptions } from "../sync/types";
import { composerMaxHeight } from "../platform/viewport";
import { PriorityLabel } from "./PriorityLabel";
import { PendingAttachments } from "./Attachments";
import { keepLineInView, settle, textAreaCaretLine } from "./composerScroll";
import { continueStructure, type EditState, indentListLine, insertLink, insideFence, linkFromPaste, replaceThroughBrowser, toggleFence, toggleLinePrefix, toggleWrap } from "./composerEdit";
import { commandCandidates, parseSlashCommand, type SlashCommand } from "./commands";
import { AiBadge } from "./ai";
import { aiBotIds, encodeMentions, type MentionCandidate, mentionCandidates, mentionQuery } from "./mentions";
import { AddEmojiDialog, CustomEmojiImage } from "./customEmoji";
import { canPostTopLevel } from "./channels";
import { completeEmoji, customEmojiCandidates, emojiCandidates, emojiQuery, type EmojiEntry } from "./emoji";
import { EmojiPicker, readRecentEmoji, rememberEmoji } from "./EmojiPicker";
import { MessageBody } from "./MessageBody";
import { isSendKey, readFormatBar, sendKeyLabel, writeFormatBar } from "./prefs";
import { isImeKey, LazyRichEditor, NO_FORMAT, type RichEditorApi, type RichFormat, type RichFormatState } from "./richEditorApi";
import { scheduleLabel, schedulePresets, toLocalInput } from "./schedule";
import { PollDialog } from "./PollDialog";
import { ChannelWorkflowsDialog, useChannelWorkflows, WorkflowEmoji, WorkflowRunDialog } from "./WorkflowViews";
import { findWorkflowCommand, workflowCandidates } from "./workflows";
import { ScheduleDialog, type ScheduleFormInitial } from "./ScheduleDialog";
import { slotsFromEntries } from "./scheduling";
import { appendTemplate, expandTemplate, findTemplate, orderTemplates, readSchedule, scheduleUsage, templateCandidates, templateSummary, templateWithText } from "./templates";
import { Button, cn, IconButton, Kbd, Menu, MenuContent, MenuItem, MenuTrigger, modKey, PopoverAnchor, PopoverContent, PopoverRoot, PopoverTrigger } from "./primitives";
import { t } from "../i18n";
import { OverflowToolbar } from "./OverflowToolbar";

const MAX_LENGTH = 20_000;

export function Composer({
  controller,
  channel,
  parentId = null,
  placeholder = t("composer.placeholder"),
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

  // 「リッチ」 / 「Markdown」 (users.composer_mode, rich when never chosen); both keep the draft as Markdown. A controller
  // without the setting (the tests' stand-ins) keeps the text area.
  const rich = (controller.composerMode ?? "markdown") === "rich";
  // The preview is the text area's: it goes with it, whichever composer (or settings, or another device) switched every
  // composer of mine to rich. Left on, it stood above the editor with no button to close it, the box as tall again
  // and the list above thrown up by as much (user report 2026-10-07); back in Markdown it came back instead of the text.
  if (rich && preview) setPreview(false);
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
  // The box of the text area or the rich editor, and its height as last laid out. Whatever takes its place is held at
  // that height until it has its own: the text area measuring itself (every keystroke), the other mode's input put in
  // its place (「Aa」 / 「M↓」, every composer of mine at once). Shorter for a moment, it would let the list above grow
  // and lose its bottom to the browser's clamping, and the list would stay up by as much (user report 2026-10-07). On
  // a switch the hold is part of the render, so it is there before any composer's input lays out the page.
  const inputBox = useRef<HTMLDivElement>(null);
  const inputHeight = useRef(0);
  const shownRich = useRef(rich);
  const switchHold = shownRich.current !== rich && inputHeight.current > 0 ? inputHeight.current : undefined;
  useLayoutEffect(() => {
    const box = inputBox.current;
    const el = area.current;
    if (!box) return;
    if (el && !preview) {
      if (inputHeight.current > 0) box.style.minHeight = `${inputHeight.current}px`;
      el.style.height = "auto";
      if (el.scrollHeight > 0) el.style.height = `${Math.min(el.scrollHeight, composerMaxHeight())}px`;
      // Scrolled by the caret's line, not by the browser's reveal of its glyph (composerScroll.ts); nothing to scroll
      // while the draft fits.
      keepLineInView(el, el.scrollHeight > 0 && el.ownerDocument.activeElement === el ? textAreaCaretLine(el) : null);
    }
    box.style.minHeight = "";
    shownRich.current = rich;
    inputHeight.current = box.offsetHeight;
  }, [text, preview, viewportHeight, rich]);
  const richApi = useRef<RichEditorApi | null>(null);
  // The rich editor's line up to the caret (mentions and emoji complete there) and the formats at the caret.
  const [richContext, setRichContext] = useState<{ text: string; caret: number } | null>(null);
  const [richFormat, setRichFormat] = useState<RichFormatState>(NO_FORMAT);
  /** The rich editor once it has loaded (the text area stands in until then). */
  const editor = () => (rich ? richApi.current : null);
  const typed = rich && richApi.current ? richContext ?? { text: "", caret: 0 } : { text, caret };
  const query = rich && richApi.current && !richContext ? null : mentionQuery(typed.text, typed.caret);
  // `:tada` completes to an emoji (M11f) when no mention is being typed.
  const emojiAt = query || (rich && richApi.current && !richContext) ? null : emojiQuery(typed.text, typed.caret);
  // Esc closes the candidate list for what is typed now (and goes no further: the screen's Esc would close the thread
  // or read the conversation); typing on shows it again.
  const listKey = query ? `@${query.start}:${query.query}` : emojiAt ? `:${emojiAt.start}:${emojiAt.query}` : `/${text}`;
  const [dismissed, setDismissed] = useState<string | null>(null);
  const listShown = dismissed !== listKey;
  const candidates = query && listShown ? mentionCandidates(query.query, [...store.users.values()], [...store.groups.values()], 6, aiBotIds(store)) : [];
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

  // The poll form, and the scheduling poll's form with what it starts with (M53: `/日程 …` fills it in).
  const [pollForm, setPollForm] = useState<{ question?: string; options?: string[]; multiple?: boolean } | null>(null);
  const [scheduleForm, setScheduleForm] = useState<ScheduleFormInitial | null>(null);
  const [templatesOpen, setTemplatesOpen] = useState(false);
  const send = () => {
    // The draft as it is now: the rich editor writes it on every keystroke, which may be newer than this render's.
    const text = store.draft(channel.id, parentId).text;
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
          controller.setError(command.args ? t("composer.noWorkflow", { name: command.args }) : t("composer.wfUsage"));
          return;
        }
        controller.setError(t("command.unknown", { name: command.name }));
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
          controller.setError(scheduleUsage());
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
    if (pending.length > 10 || body.length > MAX_LENGTH) { controller.setError(t("composer.tooLong")); return; }
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
    if (Number.isNaN(sendAt.getTime()) || sendAt.getTime() < Date.now() + 60_000) { controller.setError(t("composer.pickLater")); return; }
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
    if (isPickBusy(input)) { controller.setError(t("composer.stillReading")); return; }
    input?.click();
  };

  const pick = (candidate: MentionCandidate) => {
    if (!query) return;
    const rich = editor();
    if (rich) {
      setSelected(0);
      rich.replaceBeforeCaret(typed.caret - query.start, "@" + candidate.username + " ");
      return;
    }
    const next = text.slice(0, query.start) + "@" + candidate.username + " " + text.slice(caret);
    const position = query.start + candidate.username.length + 2;
    setSelected(0);
    apply({ text: next, start: position, end: position });
  };

  /** Replaces the input and puts the caret at its end (a template inserted, M30). */
  const putText = (next: string) => {
    setSelected(0);
    const rich = editor();
    if (rich) {
      setText(rich.setMarkdown(next));
      return;
    }
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
    const next = completeEmoji(typed.text, emojiAt.start, typed.caret, entry.glyph);
    rememberEmoji(entry.glyph);
    setSelected(0);
    const rich = editor();
    if (rich) {
      rich.replaceBeforeCaret(typed.caret - emojiAt.start, next.text.slice(emojiAt.start, next.caret));
      return;
    }
    apply({ text: next.text, start: next.caret, end: next.caret });
  };

  /** The toolbar picker: insert at the caret (replacing a selection) and keep typing. */
  const insertEmoji = (entry: EmojiEntry) => {
    rememberEmoji(entry.glyph);
    setEmojiOpen(false);
    const rich = editor();
    if (rich) return rich.insertText(entry.glyph);
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
  const startMention = () => {
    const rich = editor();
    if (rich) return rich.insertText(richContext && richContext.caret > 0 && !/\s/.test(richContext.text[richContext.caret - 1]!) ? " @" : "@");
    startMentionInText();
  };
  const startMentionInText = () => edit((s) => {
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
  // The ones that do not fit fold into 「その他の書式」 (OverflowToolbar); `group` starts a group after a divider.
  const format = (name: RichFormat, markdown: () => void) => () => {
    const rich = editor();
    if (rich) rich.run(name);
    else markdown();
  };
  const tools: Array<{ icon: ReactNode; label: string; run: () => void; group?: true; active?: boolean }> = [
    { icon: <Bold size={15} />, label: t("composer.format.boldKey", { key: `${modKey()}+B` }), run: format("bold", () => edit((s) => toggleWrap(s, "**"))), active: richFormat.bold },
    { icon: <Italic size={15} />, label: t("composer.format.italicKey", { key: `${modKey()}+I` }), run: format("italic", () => edit((s) => toggleWrap(s, "_"))), active: richFormat.italic },
    { icon: <Strikethrough size={15} />, label: t("composer.format.strikeKey", { key: `${modKey()}+Shift+X` }), run: format("strike", () => edit((s) => toggleWrap(s, "~~"))), active: richFormat.strike },
    { icon: <Code size={15} />, label: t("composer.format.codeKey", { key: `${modKey()}+Shift+C` }), run: format("code", () => edit((s) => toggleWrap(s, "`"))), group: true, active: richFormat.code },
    { icon: <SquareCode size={15} />, label: t("composer.format.codeBlock"), run: format("codeBlock", () => edit(toggleFence)), active: richFormat.codeBlock },
    { icon: <Heading size={15} />, label: t("composer.format.heading"), run: format("heading", () => edit((s) => toggleLinePrefix(s, "## "))), group: true, active: richFormat.heading },
    { icon: <TextQuote size={15} />, label: t("composer.format.quote"), run: format("quote", () => edit((s) => toggleLinePrefix(s, "> "))), active: richFormat.quote },
    { icon: <List size={15} />, label: t("composer.format.bullets"), run: format("bullets", () => edit((s) => toggleLinePrefix(s, "- "))), active: richFormat.bullets },
    { icon: <ListOrdered size={15} />, label: t("composer.format.numbered"), run: format("numbered", () => edit((s) => toggleLinePrefix(s, (i) => `${i + 1}. `))), active: richFormat.numbered },
    { icon: <LinkIcon size={15} />, label: t("composer.format.linkKey", { key: `${modKey()}+Shift+U` }), run: () => (editor() ? openLinkEditor() : edit((s) => insertLink(s))), group: true, active: richFormat.link },
  ];

  // The rich editor's link: a URL row above the text (the selection, or the link at the caret, gets it).
  const [linkEdit, setLinkEdit] = useState<{ href: string; error: boolean } | null>(null);
  const openLinkEditor = () => setLinkEdit({ href: editor()?.link() ?? "https://", error: false });
  const closeLinkEditor = () => {
    setLinkEdit(null);
    editor()?.focus("keep");
  };
  const applyLink = (remove = false) => {
    const href = linkEdit?.href.trim() ?? "";
    if (!remove && !/^https?:\/\/[^\s]+$/i.test(href)) {
      setLinkEdit({ href: linkEdit?.href ?? "", error: true });
      return;
    }
    editor()?.setLink(remove ? null : href);
    setLinkEdit(null);
  };

  // 「Aa」 / 「M↓」: the mode for every composer of mine (synced); the draft (Markdown) carries over as it is.
  const focusAfterSwitch = useRef(false);
  const switchMode = (next: "rich" | "markdown") => {
    if (next === (rich ? "rich" : "markdown")) return;
    focusAfterSwitch.current = true;
    setLinkEdit(null);
    void controller.setComposerMode(next);
  };
  useEffect(() => {
    if (!focusAfterSwitch.current || rich) return;
    focusAfterSwitch.current = false;
    area.current?.focus();
  }, [rich]);

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

  /** ↑ / ↓ / Enter / Tab / Esc in an open candidate list; true when taken. */
  const navigateList = (key: string): boolean => {
    if (listLength === 0) return false;
    if (key === "Escape") setDismissed(listKey);
    else if (key === "ArrowDown") setSelected((active + 1) % listLength);
    else if (key === "ArrowUp") setSelected((active - 1 + listLength) % listLength);
    else if (key === "Enter" || key === "Tab") {
      const candidate = candidates[active];
      if (candidate) pick(candidate);
      else if (emojiHits[active]) pickEmoji(emojiHits[active]!);
      else if (slashHits[active]) pickSlash(slashHits[active]!);
    } else return false;
    return true;
  };

  /** ↑ in an empty composer edits my newest message here; Shift+↑ replies to the newest in a thread. */
  const arrowUpWhenEmpty = (shift: boolean): boolean => {
    if (shift) {
      onReplyLast?.();
      return !!onReplyLast;
    }
    const me = store.me;
    const pool = parentId ? store.replies(channel.id, parentId) : store.messages(channel.id);
    const mine = pool.filter((m) => m.sender_id === me?.id && !m.pending && !m.deleted).at(-1);
    if (mine) controller.setEditing(mine.id);
    return !!mine;
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    const imeEnter = isImeKey({ isComposing: event.nativeEvent.isComposing, keyCode: event.keyCode }, composing.current, composedAt.current);
    if (!imeEnter && navigateList(event.key)) {
      event.preventDefault();
      if (event.key === "Escape") event.stopPropagation();
      return;
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
      if (arrowUpWhenEmpty(event.shiftKey)) event.preventDefault();
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

  /**
   * The rich editor's keys, before the editor's own (ProseMirror leaves composition keys out, and so does this): the
   * candidate lists, the send key, Shift+Enter as the newline (the editor's Enter: a new line, item or code line; an
   * empty item or quote line ends it), ⌘U / ⌘⇧U. Bold, italic, strike, code, lists and Tab are the editor's.
   */
  const onRichKeyDown = (event: globalThis.KeyboardEvent): boolean => {
    const api = richApi.current;
    if (!api) return false;
    const imeKey = isImeKey(event, api.composing(), composedAt.current);
    if (imeKey) return false;
    if (navigateList(event.key)) {
      if (event.key === "Escape") event.stopPropagation();
      return true;
    }
    const mod = event.metaKey || event.ctrlKey;
    if (mod && !event.altKey && event.key.toLowerCase() === "u") {
      if (event.shiftKey) openLinkEditor();
      else openPicker(fileInput.current);
      return true;
    }
    if (event.key === "ArrowUp" && !mod && !event.altKey && api.isEmpty()) return arrowUpWhenEmpty(event.shiftKey);
    if (event.key !== "Enter") return false;
    const sendKey = controller.sendKey ?? "mod-enter";
    if (isSendKey(event, sendKey)) {
      // With Enter as the send key, Enter inside a code block is still a newline.
      if (sendKey === "enter" && api.inCodeBlock()) return false;
      send();
      return true;
    }
    return event.shiftKey || mod ? api.newline() : false;
  };

  const textArea = (
    <textarea
      ref={area}
      data-composer-input
      value={text}
      maxLength={MAX_LENGTH}
      placeholder={placeholder}
      className={cn("block max-h-[280px] w-[calc(100%-2.25rem)] resize-none overflow-y-auto bg-transparent pb-1 pl-3 pr-1 pt-3 text-[14.5px] leading-6 text-ink outline-none placeholder:text-muted", preview && "hidden")}
      onChange={(e) => {
        setText(e.target.value);
        syncCaret(e.target);
        if (e.target.value.trim()) controller.engine?.sendTyping(channel.id, parentId ?? null); // §5.2, throttled by the engine
      }}
      onPaste={(event) => {
        if (event.clipboardData.files.length) {
          event.preventDefault();
          void pickFiles(Array.from(event.clipboardData.files));
          return;
        }
        // A URL pasted over selected text links it (composerEdit.linkFromPaste).
        const el = event.currentTarget;
        const linked = linkFromPaste({ text: el.value, start: el.selectionStart, end: el.selectionEnd }, event.clipboardData.getData("text/plain"));
        if (linked) {
          event.preventDefault();
          apply(linked);
        }
      }}
      aria-label={parentId ? t("composer.threadReply") : t("composer.message")}
      onKeyDown={onKeyDown}
      onScroll={(e) => settle(e.currentTarget)}
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
  );

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
        <ul className="absolute bottom-full left-4 z-20 mb-1 w-72 rounded-xl border border-line bg-canvas p-1 shadow-xl" aria-label={t("composer.emojiSuggestions")}>
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
              <span className="truncate text-muted">:{entry.shortcode}:</span>
              {entry.category === "custom" && store.customEmoji.get(entry.shortcode)?.label && <span className="ml-auto shrink-0 truncate text-xs text-muted">{store.customEmoji.get(entry.shortcode)!.label}</span>}
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
              <strong>@{candidate.username}</strong> <span className="text-muted">{candidate.label}</span>{candidate.kind === "group" && <span className="ml-auto rounded bg-accent-soft px-1.5 text-[10px] text-accent">{t("composer.group")}</span>}{candidate.ai && <AiBadge className="ml-auto" />}
            </li>
          ))}
        </ul>
      )}
      {slashHits.length > 0 && (
        <ul className="absolute bottom-full left-4 z-20 mb-1 max-h-80 w-96 max-w-[calc(100%-2rem)] overflow-y-auto rounded-xl border border-line bg-canvas p-1 shadow-xl" aria-label={t("composer.commandSuggestions")}>
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
                  <span className="min-w-0 flex-1 truncate text-muted">{hit.workflow.description || t("composer.workflow")}</span>
                  {!hit.workflow.can_run && <span className="ml-auto shrink-0 text-[10px] text-warning">{t("composer.unavailable")}</span>}
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
        {/* The formatting bar above the text, as in Slack (tester, 2026-09-30); 「Aa」 below shows or hides it. The tools
            that fit the composer show and the rest fold into 「…」 (OverflowToolbar, measured: 2026-10-08), the mode
            switch always at the end. */}
        {formatBar && (
          <OverflowToolbar
            role="group"
            tools={tools.map((tool) => ({ ...tool, active: rich ? !!tool.active : undefined, disabled: preview }))}
            label={t("composer.formatting")}
            className="px-2 pt-1.5"
            buttonClassName="h-7 w-7 shrink-0 text-muted hover:text-ink"
            activeClassName="bg-accent-soft text-accent"
            trailing={<ModeSwitch rich={rich} onSwitch={switchMode} />}
          />
        )}
        {linkEdit && (
          <form
            className="flex items-center gap-1.5 px-3 pt-2"
            onSubmit={(event) => {
              event.preventDefault();
              applyLink();
            }}
          >
            <LinkIcon size={13} className="shrink-0 text-muted" />
            <input
              autoFocus
              value={linkEdit.href}
              aria-label={t("composer.link.url")}
              aria-invalid={linkEdit.error || undefined}
              placeholder="https://"
              className={cn("h-7 min-w-0 flex-1 rounded-md border bg-canvas px-2 text-xs outline-none focus:border-accent", linkEdit.error ? "border-danger" : "border-line")}
              onChange={(e) => setLinkEdit({ href: e.target.value, error: false })}
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  e.preventDefault();
                  e.stopPropagation();
                  closeLinkEditor();
                }
              }}
            />
            <Button type="submit" size="sm" variant="secondary" className="h-7 shrink-0 text-xs">{t("composer.link.apply")}</Button>
            {richFormat.link && (
              <Button type="button" size="sm" variant="ghost" className="h-7 shrink-0 text-xs" onClick={() => applyLink(true)}>{t("composer.link.remove")}</Button>
            )}
            <IconButton label={t("common.cancel")} className="h-7 w-7 shrink-0 text-muted" onClick={closeLinkEditor}>
              <X size={13} />
            </IconButton>
            {linkEdit.error && <span className="sr-only" role="alert">{t("composer.link.invalid")}</span>}
          </form>
        )}
        {linkEdit?.error && <p className="px-3 pt-1 text-xs text-danger">{t("composer.link.invalid")}</p>}
        {(priority || ackRequested) && (
          <div className="flex items-center gap-2 px-3 pt-2 text-xs">
            {priority && <PriorityLabel priority={priority} />}
            {ackRequested && <span className="inline-flex items-center gap-1 text-muted"><CheckCheck size={12} /> {t("composer.askAck")}</span>}
            <button type="button" className="text-muted hover:text-ink" aria-label={t("composer.clearPriority")} onClick={() => { setPriority(null); setAckRequested(false); }}>
              <X size={12} />
            </button>
          </div>
        )}
        {uploading > 0 && (
          <div className="flex items-center gap-2 px-3 pt-2 text-xs text-muted" role="status">
            <Loader2 size={12} className="animate-spin" /> {t("composer.uploading")}
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
          aria-label={t("composer.pickMedia")}
          onChange={(e) => {
            const picked = takePicked(e.target);
            void pickFiles(picked.files, picked);
          }}
        />
        <div ref={inputBox} className="relative" style={switchHold ? { minHeight: switchHold } : undefined}>
          {/* As tall as the text area at most: a long preview pushed the send button off the window (tester, 2026-09-30). */}
          {preview && (
            <div className="mr-9 max-h-[280px] min-h-14 overflow-y-auto pb-1 pl-3 pr-1 pt-3" aria-label={t("composer.preview")}>
              {/* The same renderer and inputs as the timeline (custom emoji, packs, groups, an emoji-only message drawn large), so the
                  preview looks like the posted message. */}
              {text.trim() ? <MessageBody body={text} users={store.users} internalBase={controller.api?.baseUrl} customEmoji={store.customEmoji} controller={controller} groups={store.groups} jumbo /> : <span className="text-sm text-muted">{t("composer.nothingToPreview")}</span>}
            </div>
          )}
          {rich ? (
            <Suspense fallback={textArea}>
              <LazyRichEditor
                value={text}
                apiRef={richApi}
                ariaLabel={parentId ? t("composer.threadReply") : t("composer.message")}
                placeholder={placeholder}
                autoFocus={focusAfterSwitch.current}
                className="overflow-y-auto pb-1 pl-3 pr-10 pt-3 text-[14.5px] leading-6 text-ink"
                maxHeight={composerMaxHeight()}
                holdHeight={() => inputHeight.current}
                onChange={(markdown) => {
                  focusAfterSwitch.current = false;
                  setText(markdown);
                  if (markdown.trim()) controller.engine?.sendTyping(channel.id, parentId ?? null); // §5.2, throttled by the engine
                }}
                onKeyDown={onRichKeyDown}
                onContext={setRichContext}
                onFormat={setRichFormat}
                onFiles={(files) => void pickFiles(files)}
                onCompositionEnd={() => {
                  composedAt.current = Date.now();
                }}
              />
            </Suspense>
          ) : (
            textArea
          )}
          {/* The preview toggle in the text's top-right corner (2026-10-04); 「書式の書き方」 is by the send button. The text area and
              the preview stop 2.25rem short of the right edge, so their scrollbar runs left of this button, never under it. */}
          {!rich && <IconButton label={preview ? t("composer.backToEdit") : t("composer.preview")} aria-pressed={preview} className={cn("absolute right-1 top-1 h-7 w-7 text-muted hover:text-ink", preview && "bg-accent-soft text-accent")} onClick={() => setPreview((v) => !v)}>
            {preview ? <EyeOff size={15} /> : <Eye size={15} />}
          </IconButton>}
        </div>
        <div className="flex flex-nowrap items-center gap-2 px-2 pb-2" data-composer-actions>
          <div className="flex min-w-0 flex-1 flex-nowrap items-center gap-0.5">
            {/* 「＋」: attachments, a poll and the templates (Slack). The template list opens from it. */}
            <PopoverRoot open={templatesOpen} onOpenChange={setTemplatesOpen}>
              <Menu>
                <PopoverAnchor asChild>
                  <MenuTrigger asChild>
                    <IconButton label={t("composer.attachKey", { key: `${modKey()}+U` })} className="h-7 w-7 shrink-0 text-muted hover:text-ink">
                      <Plus size={17} />
                    </IconButton>
                  </MenuTrigger>
                </PopoverAnchor>
                <MenuContent align="start" side="top" onCloseAutoFocus={runAfterMenu}>
                  <MenuItem disabled={uploading > 0} onSelect={() => openPicker(mediaInput.current)}>
                    <Image size={14} className="text-muted" /> {t("composer.media")}
                  </MenuItem>
                  <MenuItem disabled={uploading > 0} onSelect={() => openPicker(fileInput.current)}>
                    <Paperclip size={14} className="text-muted" /> {t("composer.file")} <Kbd className="ml-auto">{modKey()}+U</Kbd>
                  </MenuItem>
                  <MenuItem onSelect={() => { afterMenu.current = () => setPollForm({}); }}>
                    <Vote size={14} className="text-muted" /> {t("composer.poll")}
                  </MenuItem>
                  <MenuItem onSelect={() => { afterMenu.current = () => setScheduleForm({}); }}>
                    <CalendarDays size={14} className="text-muted" /> {t("composer.schedulePoll")}
                  </MenuItem>
                  <MenuItem onSelect={() => { afterMenu.current = () => setTemplatesOpen(true); }}>
                    <LayoutTemplate size={14} className="text-muted" /> {t("composer.templatesMenu")}
                  </MenuItem>
                  {!parentId && isChannel && (
                    <MenuItem onSelect={() => { afterMenu.current = () => setWorkflowMenu(true); }}>
                      <Zap size={14} className="text-muted" /> {t("channel.workflowsMenu")}
                    </MenuItem>
                  )}
                </MenuContent>
              </Menu>
              <PopoverContent align="start" side="top" className="w-80 p-1" onCloseAutoFocus={(e) => e.preventDefault()}>
                <div className="px-2 pb-1 pt-1 text-xs font-semibold text-muted">{t("composer.templates")}</div>
                {templates.length === 0 ? (
                  <p className="px-2 pb-2 text-sm text-muted">{t("composer.noTemplates")}</p>
                ) : (
                  <ul className="max-h-72 overflow-y-auto" aria-label={t("composer.templateList")}>
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
            <IconButton label={formatBar ? t("composer.hideFormatting") : t("composer.showFormatting")} className={cn("h-7 w-7 shrink-0 hover:text-ink", formatBar ? "text-ink" : "text-muted")} onMouseDown={(e) => e.preventDefault()} onClick={toggleFormatBar}>
              <CaseSensitive size={18} />
            </IconButton>
            <PopoverRoot open={emojiOpen} onOpenChange={setEmojiOpen}>
              <PopoverAnchor virtualRef={emojiAnchor.anchor} />
              <button ref={emojiButton} type="button" title={t("composer.emoji")} aria-label={t("composer.emoji")} aria-haspopup="dialog" aria-expanded={emojiOpen} onClick={() => setEmojiOpen((open) => !open)} className="hidden h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted hover:bg-panel-2 hover:text-ink @[17rem]:flex">
                <Smile size={15} />
              </button>
              <PopoverContent align="start" side="top" className="w-auto p-3" onInteractOutside={emojiAnchor.keepOpenOnButton}>
                <EmojiPicker recent={readRecentEmoji()} custom={[...store.customEmoji.values()]} controller={controller} onAddCustom={() => { setEmojiOpen(false); setAddEmojiOpen(true); }} onPick={insertEmoji} />
              </PopoverContent>
            </PopoverRoot>
            <IconButton label={t("composer.addMention")} className="hidden h-7 w-7 shrink-0 text-muted hover:text-ink @[17rem]:inline-flex" disabled={preview} onMouseDown={(e) => e.preventDefault()} onClick={startMention}>
              <AtSign size={15} />
            </IconButton>
            {!parentId && (
              <PopoverRoot open={priorityOpen} onOpenChange={setPriorityOpen}>
                <PopoverAnchor virtualRef={priorityAnchor.anchor} />
                <button ref={priorityButton} type="button" title={t("composer.priority")} aria-label={t("composer.priority")} aria-haspopup="dialog" aria-expanded={priorityOpen} onClick={() => setPriorityOpen((open) => !open)} className={cn("hidden h-7 w-7 shrink-0 items-center justify-center rounded-lg hover:bg-ink/6 @[17rem]:inline-flex", priority || ackRequested ? "text-accent" : "text-muted hover:text-ink")}>
                  <Flag size={15} />
                </button>
                <PopoverContent align="start" side="top" className="w-60 p-2" onInteractOutside={priorityAnchor.keepOpenOnButton}>
                  <div className="px-1 pb-1 text-xs font-semibold text-muted">{t("composer.priority")}</div>
                  {([[null, t("composer.priorityNormal")], ["important", t("composer.priorityImportant")], ["urgent", t("composer.priorityUrgent")]] as Array<[Priority | null, string]>).map(([value, label]) => (
                    <button key={label} type="button" className={cn("flex w-full items-center justify-between rounded-md px-2 py-1.5 text-left text-sm hover:bg-panel", priority === value && "bg-accent-soft")} onClick={() => setPriority(value)}>
                      {value ? <PriorityLabel priority={value} /> : <span>{label}</span>}
                      {priority === value && <Check size={14} className="text-accent" />}
                    </button>
                  ))}
                  <label className="mt-1 flex cursor-pointer items-center gap-2 border-t border-line px-2 pt-2 text-sm">
                    <input type="checkbox" className="accent-[var(--accent)]" checked={ackRequested} onChange={(e) => setAckRequested(e.target.checked)} />
                    {t("composer.askAck")}
                  </label>
                </PopoverContent>
              </PopoverRoot>
            )}
            <Menu>
              <MenuTrigger asChild>
                <button ref={moreButton} type="button" title={t("composer.more")} aria-label={t("composer.moreActions")} className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted hover:bg-panel-2 hover:text-ink @[17rem]:hidden">
                  <Ellipsis size={15} />
                </button>
              </MenuTrigger>
              <MenuContent align="start" side="top" onCloseAutoFocus={runAfterMenu}>
                <MenuItem onSelect={() => { afterMenu.current = () => setEmojiOpen(true); }}>
                  <Smile size={14} className="text-muted" /> {t("composer.emoji")}
                </MenuItem>
                <MenuItem disabled={preview} onSelect={() => { afterMenu.current = startMention; }}>
                  <AtSign size={14} className="text-muted" /> {t("composer.addMention")}
                </MenuItem>
                {!parentId && (
                  <MenuItem onSelect={() => { afterMenu.current = () => setPriorityOpen(true); }}>
                    <Flag size={14} className="text-muted" /> {t("composer.priority")}
                  </MenuItem>
                )}
              </MenuContent>
            </Menu>
          </div>
          <div className="flex shrink-0 items-center gap-3">
            <MarkdownHelp />
            <span className="-ml-2 hidden items-center gap-1 whitespace-nowrap text-[11px] text-muted @3xl:flex">
              <Kbd>{sendKeyLabel(controller.sendKey ?? "mod-enter").send}</Kbd> {t("composer.send")} <Kbd>{sendKeyLabel(controller.sendKey ?? "mod-enter").newline}</Kbd> {t("composer.newline")}
            </span>
            {/* 「送信」 and its ▾ with 「後で送信」, as Slack's schedule dropdown. */}
            <div className="flex items-center">
              <Button size="sm" className="rounded-r-none" onClick={send} disabled={uploading > 0 || (!text.trim() && pending.length === 0)}>
                <SendHorizontal size={14} /> {t("composer.send")}
              </Button>
              <PopoverRoot open={scheduleOpen} onOpenChange={setScheduleOpen}>
                <PopoverTrigger asChild>
                  <button type="button" aria-label={t("composer.sendLater")} title={t("composer.sendLater")} disabled={uploading > 0 || scheduling || (!text.trim() && pending.length === 0)} className="inline-flex h-7 w-6 items-center justify-center rounded-r-md border-l border-white/30 bg-accent-solid text-white shadow-sm transition-colors hover:bg-accent-solid/90 disabled:pointer-events-none disabled:opacity-50">
                    <ChevronDown size={14} />
                  </button>
                </PopoverTrigger>
                <PopoverContent align="end" side="top" className="w-72 p-3">
                  <div className="mb-2 text-xs font-semibold text-muted">{t("composer.sendLater")}</div>
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
                    <input type="datetime-local" value={customAt} aria-label={t("settings.pause.custom")} className="h-8 flex-1 rounded-lg border border-line bg-canvas px-2 text-xs" onChange={(e) => setCustomAt(e.target.value)} />
                    <Button size="sm" variant="secondary" onClick={() => void schedule(new Date(customAt))}>{t("composer.schedule")}</Button>
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
          {channel.type === "dm" || channel.type === "group_dm" ? t("composer.alsoToConversation") : t("composer.alsoToChannel", { name: channel.name ?? "" })}
        </label>
      )}
    </div>
  );
}

type SlashHit = { kind: "command"; command: SlashCommand } | { kind: "template"; template: TemplateOut } | { kind: "workflow"; workflow: WorkflowOut };

/**
 * A popover opened by `button`, which folds into `more` (「…」) on a narrow composer: anchored at whichever of the two is
 * shown. The button opens and closes it itself rather than through a PopoverTrigger (2026-10-04: the emoji list opened
 * at the window's top-left). With a trigger next to a virtual PopoverAnchor, Radix takes the trigger for the anchor
 * until the custom anchor has registered (an effect), then unwraps the trigger, which mounts its button anew. When the
 * trigger's ref attaches after that effect, as under React's StrictMode (refs attached twice on mount: every
 * development build, `tauri dev` included), the anchor stays the unmounted button, a rectangle of zeros at (0, 0).
 * Without a trigger the virtual anchor is the only one. `keepOpenOnButton` goes to the content's `onInteractOutside`:
 * a press on the button is left to its own click (which closes), as a trigger's would be.
 */
function useShownAnchor(button: RefObject<HTMLElement | null>, more: RefObject<HTMLElement | null>) {
  const anchor = useRef({
    getBoundingClientRect: () => {
      const shown = [button.current, more.current].find((el) => el && el.getClientRects().length > 0);
      return shown ? shown.getBoundingClientRect() : new DOMRect();
    },
  });
  const keepOpenOnButton = useCallback((event: { target: EventTarget | null; preventDefault(): void }) => {
    if (event.target instanceof Node && button.current?.contains(event.target)) event.preventDefault();
  }, [button]);
  return { anchor, keepOpenOnButton };
}

/** 「Aa」 / 「M↓」 at the end of the format bar: rich text or Markdown (users.composer_mode, every composer of mine). */
function ModeSwitch({ rich, onSwitch }: { rich: boolean; onSwitch: (mode: "rich" | "markdown") => void }) {
  const option = (mode: "rich" | "markdown", glyph: string, label: string) => {
    const on = (mode === "rich") === rich;
    return (
      <button
        type="button"
        aria-pressed={on}
        aria-label={label}
        title={label}
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => onSwitch(mode)}
        className={cn("h-6 rounded-[5px] px-1.5 text-[11px] font-semibold leading-none", on ? "bg-canvas text-ink shadow-sm" : "text-muted hover:text-ink")}
      >
        {glyph}
      </button>
    );
  };
  return (
    <div role="group" aria-label={t("composer.mode")} className="ml-auto flex shrink-0 items-center gap-0.5 rounded-md bg-panel-2 p-0.5">
      {option("rich", "Aa", t("composer.mode.rich"))}
      {option("markdown", "M↓", t("composer.mode.markdown"))}
    </div>
  );
}

/** Marks my own templates in the lists (the workspace's have none). */
function TemplateMark() {
  return <span className="ml-auto shrink-0 rounded bg-accent-soft px-1.5 text-[10px] text-accent">{t("composer.personal")}</span>;
}

function syntaxRows(): Array<[string, string]> {
  return [
    [t("composer.syntax.boldEx"), t("composer.syntax.bold")],
    [t("composer.syntax.italicEx"), t("composer.syntax.italic")],
    [t("composer.syntax.strikeEx"), t("composer.syntax.strike")],
    [t("composer.syntax.codeEx"), t("composer.syntax.code")],
    [t("composer.syntax.headingEx"), t("composer.syntax.heading")],
    [t("composer.syntax.fenceEx"), t("composer.syntax.fence")],
    [t("composer.syntax.quoteEx"), t("composer.syntax.quote")],
    [t("composer.syntax.listEx"), t("composer.syntax.list")],
    [t("composer.syntax.linkEx"), t("composer.syntax.link")],
    [t("composer.syntax.tableEx"), t("composer.syntax.table")],
    [t("composer.syntax.mathEx"), t("composer.syntax.math")],
    [t("composer.syntax.mathBlockEx"), t("composer.syntax.mathBlock")],
    [t("composer.syntax.mentionEx"), t("composer.syntax.mention")],
    ["\\_ \\* \\~ \\` \\$", t("composer.syntax.escape")],
  ];
}

/**
 * 「書式の書き方」: the supported syntax, by the send button. Kept inside the window (2026-10-04: cut off at times):
 * above the button when there is room, as tall as the room there is, scrolling inside. An example of several lines
 * (the table) is a code block with its line breaks.
 */
export function MarkdownHelp() {
  return (
    <PopoverRoot>
      <PopoverTrigger asChild>
        <button type="button" aria-label={t("composer.syntaxHelp")} title={t("composer.syntaxHelp")} className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-muted hover:bg-ink/6 hover:text-ink">
          <Info size={15} />
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" side="top" className="max-h-[var(--radix-popover-content-available-height)] w-[420px] overflow-y-auto p-3">
        <div className="mb-2 text-xs font-semibold">{t("composer.syntaxTitle")}</div>
        <table className="w-full text-xs">
          <tbody className="divide-y divide-line">
            {syntaxRows().map(([syntax, meaning]) => (
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
