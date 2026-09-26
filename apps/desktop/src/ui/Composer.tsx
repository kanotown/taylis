import { type KeyboardEvent, useRef, useState } from "react";

import type { AttachmentOut } from "../api/types";
import type { AppController } from "../state/app";
import type { ChannelState } from "../sync/types";
import { PendingAttachments } from "./Attachments";
import { encodeMentions, type MentionCandidate, mentionCandidates, mentionQuery } from "./mentions";

const MAX_LENGTH = 20_000;
/** WebKit delivers the Enter that commits an IME composition after compositionend. */
const IME_COMMIT_GRACE_MS = 100;

export function Composer({
  controller,
  channel,
  parentId = null,
  placeholder = "メッセージを入力 (Enter で送信、Shift+Enter で改行、@ でメンション)",
}: {
  controller: AppController;
  channel: ChannelState;
  parentId?: string | null;
  placeholder?: string;
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
    if (event.key !== "Enter" || event.shiftKey) return;
    if (imeEnter) return; // confirming a Japanese conversion, not sending
    event.preventDefault();
    send();
  };

  return (
    <div className="composer-wrap" onDragOver={(event) => event.preventDefault()} onDrop={(event) => {
      event.preventDefault(); void pickFiles(event.dataTransfer.files);
    }}>
      {candidates.length > 0 && (
        <ul className="mention-suggestions">
          {candidates.map((candidate, index) => (
            <li
              key={candidate.username}
              className={index === active ? "active" : ""}
              onMouseDown={(event) => {
                event.preventDefault();
                pick(candidate);
              }}
            >
              <strong>@{candidate.username}</strong> <span className="muted">{candidate.label}</span>
            </li>
          ))}
        </ul>
      )}
      {uploading > 0 && <div className="muted" role="status">添付をアップロード中… 完了後に送信できます</div>}
      <PendingAttachments items={pending} onRemove={(item) => setPending((items) => items.filter((a) => a.id !== item.id))} />
      <div className="composer">
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
        <button className="secondary attach" title="ファイルを添付" onClick={() => fileInput.current?.click()} disabled={uploading > 0}>
          {uploading > 0 ? "…" : "📎"}
        </button>
        <textarea
          ref={area}
          value={text}
          maxLength={MAX_LENGTH}
          placeholder={placeholder}
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
        <button onClick={send} disabled={uploading > 0 || (!text.trim() && pending.length === 0)}>
          送信
        </button>
      </div>
    </div>
  );
}
