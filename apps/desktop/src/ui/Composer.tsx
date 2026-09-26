import { type KeyboardEvent, useRef, useState } from "react";

import type { AppController } from "../state/app";
import type { ChannelState } from "../sync/types";
import { encodeMentions, type MentionCandidate, mentionCandidates, mentionQuery } from "./mentions";

const MAX_LENGTH = 20_000;
/** WebKit delivers the Enter that commits an IME composition after compositionend. */
const IME_COMMIT_GRACE_MS = 100;

export function Composer({ controller, channel }: { controller: AppController; channel: ChannelState }) {
  const [text, setText] = useState("");
  const [caret, setCaret] = useState(0);
  const [selected, setSelected] = useState(0);
  const composing = useRef(false);
  const composedAt = useRef(0);
  const area = useRef<HTMLTextAreaElement>(null);
  const store = controller.store;

  const query = mentionQuery(text, caret);
  const candidates = query ? mentionCandidates(query.query, [...store.users.values()]) : [];
  const active = Math.min(selected, Math.max(candidates.length - 1, 0));

  const send = () => {
    const body = encodeMentions(text.trim(), store.users.values());
    if (!body || !controller.engine) return;
    setText("");
    void controller.engine.send(channel.id, body);
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
    <div className="composer-wrap">
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
      <div className="composer">
        <textarea
          ref={area}
          value={text}
          maxLength={MAX_LENGTH}
          placeholder="メッセージを入力 (Enter で送信、Shift+Enter で改行、@ でメンション)"
          onChange={(e) => {
            setText(e.target.value);
            syncCaret(e.target);
          }}
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
        <button onClick={send} disabled={!text.trim()}>
          送信
        </button>
      </div>
    </div>
  );
}
