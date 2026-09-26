import { type KeyboardEvent, useState } from "react";

import type { AppController } from "../state/app";
import type { ChannelState } from "../sync/types";

const MAX_LENGTH = 20_000;

export function Composer({ controller, channel }: { controller: AppController; channel: ChannelState }) {
  const [text, setText] = useState("");

  const send = () => {
    const body = text.trim();
    if (!body || !controller.engine) return;
    setText("");
    void controller.engine.send(channel.id, body);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      send();
    }
  };

  return (
    <div className="composer">
      <textarea
        value={text}
        maxLength={MAX_LENGTH}
        placeholder="メッセージを入力 (Enter で送信、Shift+Enter で改行)"
        onChange={(e) => setText(e.target.value)}
        onKeyDown={onKeyDown}
        rows={2}
      />
      <button onClick={send} disabled={!text.trim()}>
        送信
      </button>
    </div>
  );
}
