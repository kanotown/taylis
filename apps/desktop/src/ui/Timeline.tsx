import { useEffect, useRef, useState } from "react";

import type { AppController } from "../state/app";
import type { ChannelState, MessageState } from "../sync/types";
import { AttachmentList } from "./Attachments";
import { MessageBody } from "./MessageBody";
import { decodeMentions, encodeMentions } from "./mentions";

const REACTION_PALETTE = ["👍", "❤️", "😂", "🎉", "👀", "✅"];

export function Timeline({ controller, channel, onOpenThread }: { controller: AppController; channel: ChannelState; onOpenThread?: (id: string) => void }) {
  const store = controller.store;
  const engine = controller.engine;
  const messages = store.messages(channel.id);
  const bottom = useRef<HTMLDivElement>(null);
  const lastId = messages[messages.length - 1]?.id;
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const me = store.me;

  useEffect(() => {
    bottom.current?.scrollIntoView({ block: "end" });
  }, [lastId, channel.id]);

  // Viewing the newest messages in a focused window marks them read (SYNC_PROTOCOL.md §10).
  useEffect(() => {
    const mark = () => {
      if (document.hasFocus()) engine?.markRead(channel.id, channel.lastSeq);
    };
    mark();
    window.addEventListener("focus", mark);
    return () => window.removeEventListener("focus", mark);
  }, [channel.id, channel.lastSeq, engine]);

  const startEdit = (message: MessageState) => {
    setEditingId(message.id);
    setDraft(decodeMentions(message.body, store.users));
  };
  const saveEdit = (message: MessageState) => {
    const body = encodeMentions(draft.trim(), store.users.values());
    setEditingId(null);
    if (body && body !== message.body) void controller.editMessage(message.id, body);
  };

  return (
    <div className="timeline">
      {channel.hasOlder && channel.syncedSeq !== null && (
        <button className="secondary load-older" onClick={() => void engine?.loadOlder(channel.id)}>
          以前のメッセージを読み込む
        </button>
      )}
      {messages.map((message) => {
        const sender = store.users.get(message.sender_id);
        const mine = me?.id === message.sender_id;
        const reactions = message.reactions ?? [];
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
              {!message.pending && (
                <span className="actions">
                  {REACTION_PALETTE.map((emoji) => (
                    <button key={emoji} className="link" title="リアクション" onClick={() => void controller.toggleReaction(message, emoji)}>
                      {emoji}
                    </button>
                  ))}
                  {onOpenThread && (
                    <button className="link" onClick={() => onOpenThread(message.id)}>
                      スレッド
                    </button>
                  )}
                  {mine && (
                    <button className="link" onClick={() => startEdit(message)}>
                      編集
                    </button>
                  )}
                  {(mine || controller.isAdmin) &&
                    (confirmDeleteId === message.id ? (
                      <>
                        <button
                          className="link danger"
                          onClick={() => {
                            setConfirmDeleteId(null);
                            void controller.deleteMessage(message.id);
                          }}
                        >
                          本当に削除
                        </button>
                        <button className="link" onClick={() => setConfirmDeleteId(null)}>
                          やめる
                        </button>
                      </>
                    ) : (
                      <button className="link" onClick={() => setConfirmDeleteId(message.id)}>
                        削除
                      </button>
                    ))}
                </span>
              )}
            </div>
            {editingId === message.id ? (
              <div className="editor">
                <textarea value={draft} onChange={(e) => setDraft(e.target.value)} rows={3} autoFocus />
                <div>
                  <button onClick={() => saveEdit(message)} disabled={!draft.trim()}>
                    保存
                  </button>
                  <button className="secondary" onClick={() => setEditingId(null)}>
                    キャンセル
                  </button>
                </div>
              </div>
            ) : (
              <>
                {message.body && <MessageBody body={message.body} users={store.users} />}
                <AttachmentList attachments={message.attachments ?? []} controller={controller} />
              </>
            )}
            {(message.reply_count ?? 0) > 0 && onOpenThread && (
              <button className="link replies" onClick={() => onOpenThread(message.id)}>
                {message.reply_count} 件の返信
              </button>
            )}
            {reactions.length > 0 && (
              <div className="reactions">
                {reactions.map((reaction) => {
                  const reacted = !!me && reaction.user_ids.includes(me.id);
                  const names = reaction.user_ids.map((id) => store.users.get(id)?.display_name ?? "?").join(", ");
                  return (
                    <button
                      key={reaction.emoji}
                      className={`chip${reacted ? " mine" : ""}`}
                      title={names}
                      onClick={() => void controller.toggleReaction(message, reaction.emoji)}
                    >
                      {reaction.emoji} {reaction.count}
                    </button>
                  );
                })}
              </div>
            )}
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
