import { Bold, Check, CheckCheck, Clock, Code, Eye, EyeOff, Flag, Heading, Info, Italic, Link as LinkIcon, List, ListOrdered, Loader2, Paperclip, SendHorizontal, Smile, SquareCode, Strikethrough, TextQuote, X } from "lucide-react";
import { type KeyboardEvent, type ReactNode, useLayoutEffect, useRef, useState } from "react";

import type { AttachmentOut, Priority } from "../api/types";
import type { AppController } from "../state/app";
import type { ChannelState, SendOptions } from "../sync/types";
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
import { Button, cn, IconButton, Kbd, modKey, PopoverContent, PopoverRoot, PopoverTrigger } from "./primitives";

const MAX_LENGTH = 20_000;
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
  const composing = useRef(false);
  const composedAt = useRef(0);
  const area = useRef<HTMLTextAreaElement>(null);
  // Grow with the draft (lists and code blocks span several lines) up to a cap, then scroll.
  useLayoutEffect(() => {
    const el = area.current;
    if (!el || preview) return;
    el.style.height = "auto";
    if (el.scrollHeight > 0) el.style.height = `${Math.min(el.scrollHeight, 280)}px`;
  }, [text, preview]);
  const query = mentionQuery(text, caret);
  const candidates = query ? mentionCandidates(query.query, [...store.users.values()], [...store.groups.values()]) : [];
  // `:tada` completes to an emoji (M11f) when no mention is being typed.
  const emojiAt = query ? null : emojiQuery(text, caret);
  const emojiHits = emojiAt ? [...customEmojiCandidates(emojiAt.query, store.customEmoji), ...emojiCandidates(emojiAt.query)].slice(0, 8) : [];
  const [addEmojiOpen, setAddEmojiOpen] = useState(false);
  // `/st` at the very start offers the slash commands (M13b).
  const commandHits = query || emojiAt ? [] : commandCandidates(text);
  const listLength = candidates.length > 0 ? candidates.length : emojiHits.length > 0 ? emojiHits.length : commandHits.length;
  const active = Math.min(selected, Math.max(listLength - 1, 0));
  const [emojiOpen, setEmojiOpen] = useState(false);

  const send = () => {
    const command = parseSlashCommand(text);
    if (command) {
      if (!command.known) {
        controller.setError(`/${command.name} というコマンドはありません (/help で一覧)`);
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
  const schedule = async (sendAt: Date) => {
    const body = encodeMentions(text.trim(), store.users.values(), store.groups.values());
    if ((!body && pending.length === 0) || uploading > 0) return;
    if (Number.isNaN(sendAt.getTime()) || sendAt.getTime() < Date.now() + 60_000) { controller.setError("1 分以上先の時刻を選んでください"); return; }
    const ids = pending.map((a) => a.id);
    setScheduleOpen(false);
    if (await controller.scheduleMessage(channel.id, parentId, body, ids, sendAt)) {
      setText("");
      setPending([]);
    }
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
        else if (commandHits[active]) pickCommand(commandHits[active]!);
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
    const sendKey = controller.sendKey ?? "shift-enter";
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
      className="composer relative px-4 pb-3 pt-1"
      onDragOver={(event) => event.preventDefault()}
      onDrop={(event) => {
        event.preventDefault();
        void pickFiles(event.dataTransfer.files);
      }}
    >
      {addEmojiOpen && <AddEmojiDialog controller={controller} onClose={() => setAddEmojiOpen(false)} />}
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
      {commandHits.length > 0 && (
        <ul className="absolute bottom-full left-4 z-20 mb-1 w-96 rounded-xl border border-line bg-canvas p-1 shadow-xl">
          {commandHits.map((command, index) => (
            <li
              key={command.name}
              className={cn("flex items-baseline gap-2 rounded-lg px-2.5 py-1.5 text-sm", index === active ? "bg-accent-soft" : "hover:bg-panel")}
              onMouseDown={(event) => {
                event.preventDefault();
                pickCommand(command);
              }}
            >
              <strong className="font-mono">{command.usage}</strong> <span className="text-muted">{command.description}</span>
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
        <div className={cn(pending.length > 0 && "px-2 pt-2")}>
          <PendingAttachments items={pending} onRemove={(item) => setPending((items) => items.filter((a) => a.id !== item.id))} />
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
        {preview && (
          <div className="min-h-14 px-3 pb-1 pt-3" aria-label="プレビュー">
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
        <div className="flex items-center justify-between gap-2 px-2 pb-2">
          <div className="flex items-center gap-0.5">
            {tools.map((tool) => (
              <IconButton key={tool.label} label={tool.label} className="h-7 w-7 text-muted hover:text-ink" disabled={preview} onMouseDown={(e) => e.preventDefault()} onClick={tool.run}>
                {tool.icon}
              </IconButton>
            ))}
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
            <IconButton label={`ファイルを添付 (${modKey()}+U)`} className="h-7 w-7 text-muted hover:text-ink" onClick={() => fileInput.current?.click()} disabled={uploading > 0}>
              <Paperclip size={15} />
            </IconButton>
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
          <div className="flex items-center gap-3">
            <span className="hidden items-center gap-1 text-[11px] text-muted lg:flex">
              <Kbd>{sendKeyLabel(controller.sendKey ?? "shift-enter").send}</Kbd> 送信 <Kbd>{sendKeyLabel(controller.sendKey ?? "shift-enter").newline}</Kbd> 改行
            </span>
            <PopoverRoot open={scheduleOpen} onOpenChange={setScheduleOpen}>
              <PopoverTrigger asChild>
                <button type="button" aria-label="後で送信" title="後で送信" disabled={uploading > 0 || (!text.trim() && pending.length === 0)} className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-muted transition-colors hover:bg-ink/6 hover:text-ink disabled:opacity-40">
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
      {canShare && (
        <label className="mt-1.5 flex w-fit cursor-pointer items-center gap-1.5 text-xs text-muted">
          <input type="checkbox" className="accent-[var(--accent)]" checked={alsoInChannel} onChange={(e) => setAlsoInChannel(e.target.checked)} />
          {channel.type === "dm" || channel.type === "group_dm" ? "会話にも送信" : `#${channel.name ?? ""} にも送信`}
        </label>
      )}
    </div>
  );
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
