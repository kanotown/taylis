import { useEffect, useRef } from "react";

import type { AppController } from "../state/app";
import type { ChannelState } from "../sync/types";
import { MessageBody } from "./MessageBody";

export function Timeline({ controller, channel }: { controller: AppController; channel: ChannelState }) {
  const store = controller.store;
  const engine = controller.engine;
  const messages = store.messages(channel.id);
  const bottom = useRef<HTMLDivElement>(null);
  const lastId = messages[messages.length - 1]?.id;

  useEffect(() => {
    bottom.current?.scrollIntoView({ block: "end" });
    engine?.markSeen(channel.id);
  }, [lastId, channel.id, engine]);

  return (
    <div className="timeline">
      {channel.hasOlder && channel.syncedSeq !== null && (
        <button className="secondary load-older" onClick={() => void engine?.loadOlder(channel.id)}>
          以前のメッセージを読み込む
        </button>
      )}
      {messages.map((message) => {
        const sender = store.users.get(message.sender_id);
        return (
          <article key={message.id} className={`message${message.pending ? " pending" : ""}${message.failed ? " failed" : ""}`}>
            <div className="meta">
              <strong>{sender?.display_name ?? (message.pending ? store.me?.display_name : "?")}</strong>
              <time>{formatTime(message.created_at)}</time>
              {message.edited_at && <span className="muted">(編集済み)</span>}
              {message.failed && (
                <span className="error">
                  送信失敗
                  <button className="link" onClick={() => void engine?.retryFailed()}>
                    再送
                  </button>
                  <button className="link" onClick={() => message.client_msg_id && engine?.discardFailed(message.client_msg_id)}>
                    破棄
                  </button>
                </span>
              )}
            </div>
            <MessageBody body={message.body} users={store.users} />
          </article>
        );
      })}
      <div ref={bottom} />
    </div>
  );
}

function formatTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "送信中…";
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}
