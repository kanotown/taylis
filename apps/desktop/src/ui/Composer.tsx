import { Loader2, Paperclip, SendHorizontal } from "lucide-react";
import { type KeyboardEvent, useRef, useState } from "react";

import type { AttachmentOut } from "../api/types";
import type { AppController } from "../state/app";
import type { ChannelState } from "../sync/types";
import { PendingAttachments } from "./Attachments";
import { encodeMentions, type MentionCandidate, mentionCandidates, mentionQuery } from "./mentions";
import { Button, cn, IconButton, Kbd, modKey } from "./primitives";

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
  const [caret, setCaret] = useState(0);
  const [selected, setSelected] = useState(0);

  const fileInput = useRef<HTMLInputElement>(null);
  const composing = useRef(false);
  const composedAt = useRef(0);
  const area = useRef<HTMLTextAreaElement>(null);
  const query = mentionQuery(text, caret);
  const candidates = query ? mentionCandidates(query.query, [...store.users.values()]) : [];
  const active = Math.min(selected, Math.max(candidates.length - 1, 0));

  const send = () => {
    const body = encodeMentions(text.trim(), store.users.values());
    if ((!body && pending.length === 0) || !controller.engine || uploading > 0) return;
    if (pending.length > 10 || body.length > MAX_LENGTH) { controller.setError("添付は10件、本文は20,000文字までです"); return; }
    const ids = pending.map((a) => a.id);
    setText("");
    setPending([]);
    void controller.engine.send(channel.id, body, undefined, parentId, ids);
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

  const syncCaret = (element: HTMLTextAreaElement) => setCaret(element.selectionStart ?? element.value.length);

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    const imeEnter =
      event.nativeEvent.isComposing ||
      composing.current ||
      event.keyCode === 229 ||
      Date.now() - composedAt.current < IME_COMMIT_GRACE_MS;
    if (candidates.length > 0 && !imeEnter) {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setSelected((active + 1) % candidates.length);
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        setSelected((active - 1 + candidates.length) % candidates.length);
        return;
      }
      if (event.key === "Enter" || event.key === "Tab") {
        event.preventDefault();
        const candidate = candidates[active];
        if (candidate) pick(candidate);
        return;
      }
    }
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "u") {
      event.preventDefault();
      fileInput.current?.click();
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
    if (event.key !== "Enter" || event.shiftKey) return;
    if (imeEnter) return; // confirming a Japanese conversion, not sending
    event.preventDefault();
    send();
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
              <strong>@{candidate.username}</strong> <span className="text-muted">{candidate.label}</span>
            </li>
          ))}
        </ul>
      )}
      <div className="rounded-xl border border-line bg-canvas shadow-sm transition focus-within:border-accent focus-within:ring-2 focus-within:ring-accent/25">
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
        <textarea
          ref={area}
          value={text}
          maxLength={MAX_LENGTH}
          placeholder={placeholder}
          className="block w-full resize-none bg-transparent px-3 pb-1 pt-3 text-[14.5px] leading-6 text-ink outline-none placeholder:text-muted"
          onChange={(e) => {
            setText(e.target.value);
            syncCaret(e.target);
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
        <div className="flex items-center justify-between px-2 pb-2">
          <IconButton label={`ファイルを添付 (${modKey()}+U)`} className="text-muted hover:text-ink" onClick={() => fileInput.current?.click()} disabled={uploading > 0}>
            <Paperclip size={16} />
          </IconButton>
          <div className="flex items-center gap-3">
            <span className="hidden items-center gap-1 text-[11px] text-muted sm:flex">
              <Kbd>Enter</Kbd> 送信 <Kbd>Shift+Enter</Kbd> 改行
            </span>
            <Button size="sm" onClick={send} disabled={uploading > 0 || (!text.trim() && pending.length === 0)}>
              <SendHorizontal size={14} /> 送信
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
