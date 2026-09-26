import { type KeyboardEvent, useRef, useState } from "react";

import type { AppController } from "../state/app";
import type { ChannelState } from "../sync/types";

const MAX_LENGTH = 20_000;
/** WebKit delivers the Enter that commits an IME composition after compositionend. */
const IME_COMMIT_GRACE_MS = 100;

export function Composer({ controller, channel }: { controller: AppController; channel: ChannelState }) {
  const [text, setText] = useState("");
  const composing = useRef(false);
  const composedAt = useRef(0);

  const send = () => {
    const body = text.trim();
    if (!body || !controller.engine) return;
    setText("");
    void controller.engine.send(channel.id, body);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== "Enter" || event.shiftKey) return;
    const imeEnter =
      event.nativeEvent.isComposing ||
      composing.current ||
      event.keyCode === 229 ||
      Date.now() - composedAt.current < IME_COMMIT_GRACE_MS;
    if (imeEnter) return; // confirming a Japanese conversion, not sending
    event.preventDefault();
    send();
  };

  return (
    <div className="composer">
      <textarea
        value={text}
        maxLength={MAX_LENGTH}
        placeholder="メッセージを入力 (Enter で送信、Shift+Enter で改行)"
        onChange={(e) => setText(e.target.value)}
        onKeyDown={onKeyDown}
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
  );
}
