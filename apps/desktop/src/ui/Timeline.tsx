import { useEffect, useLayoutEffect, useRef, useState } from "react";

import type { AppController } from "../state/app";
import type { ChannelState, MessageState } from "../sync/types";
import { AttachmentList } from "./Attachments";
import { Avatar } from "./Avatar";
import { buildTimeline, fullTimestamp, timeLabel } from "./format";
import { MessageBody } from "./MessageBody";
import { decodeMentions, encodeMentions } from "./mentions";

const REACTION_PALETTE = ["👍", "❤️", "😂", "🎉", "👀", "✅"];

export function Timeline({ controller, channel, onOpenThread }: { controller: AppController; channel: ChannelState; onOpenThread?: (id: string) => void }) {
  const store = controller.store;
  const engine = controller.engine;
  const messages = store.messages(channel.id);
  const me = store.me;
  const container = useRef<HTMLDivElement>(null);
  const bottom = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);
  const [showJump, setShowJump] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const anchor = useRef<{ height: number; top: number } | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  // The "new messages" divider stays where it was when the channel was opened.
  const unreadMark = useRef<{ channelId: string; seq: number | null }>({ channelId: "", seq: null });
  if (unreadMark.current.channelId !== channel.id) {
    unreadMark.current = { channelId: channel.id, seq: channel.unreadCount > 0 ? channel.lastReadSeq : null };
  }
  const items = buildTimeline(messages, { firstUnreadAfterSeq: unreadMark.current.seq, meId: me?.id ?? null });
  const lastId = messages[messages.length - 1]?.id;

  const scrollToBottom = () => bottom.current?.scrollIntoView({ block: "end" });

  useLayoutEffect(() => {
    // Older messages were prepended: keep the viewport anchored to what the reader was looking at.
    const el = container.current;
    if (el && anchor.current) {
      el.scrollTop = anchor.current.top + (el.scrollHeight - anchor.current.height);
      anchor.current = null;
    }
  }, [messages.length]);

  useEffect(() => {
    // A newly opened channel always starts at the newest message.
    atBottom.current = true;
    setShowJump(false);
    scrollToBottom();
  }, [channel.id]);

  useEffect(() => {
    if (atBottom.current) scrollToBottom();
  }, [lastId]);

  // Viewing the newest messages in a focused window marks them read (SYNC_PROTOCOL.md §10).
  useEffect(() => {
    const mark = () => {
      if (document.hasFocus() && atBottom.current) engine?.markRead(channel.id, channel.lastSeq);
    };
    mark();
    window.addEventListener("focus", mark);
    return () => window.removeEventListener("focus", mark);
  }, [channel.id, channel.lastSeq, engine]);

  const onScroll = () => {
    const el = container.current;
    if (!el) return;
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    atBottom.current = distance < 48;
    setShowJump(distance > 240);
    if (atBottom.current) engine?.markRead(channel.id, channel.lastSeq);
    if (el.scrollTop < 120 && channel.hasOlder && channel.syncedSeq !== null && !loadingOlder && engine) {
      setLoadingOlder(true);
      anchor.current = { height: el.scrollHeight, top: el.scrollTop };
      void engine.loadOlder(channel.id).finally(() => setLoadingOlder(false));
    }
  };

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
    <div className="timeline-wrap">
      <div className="timeline" ref={container} onScroll={onScroll}>
        {loadingOlder && <div className="muted centered-row">読み込み中…</div>}
        {!loadingOlder && channel.hasOlder && messages.length > 0 && engine && (
          <div className="centered-row">
            <button
              className="link"
              onClick={() => {
                const el = container.current;
                if (el) anchor.current = { height: el.scrollHeight, top: el.scrollTop };
                setLoadingOlder(true);
                void engine.loadOlder(channel.id).finally(() => setLoadingOlder(false));
              }}
            >
              以前のメッセージを読み込む
            </button>
          </div>
        )}
        {!channel.hasOlder && messages.length > 0 && <div className="muted centered-row history-start">ここが会話の始まりです</div>}
        {messages.length === 0 && (
          <div className="empty-state">
            <strong>まだメッセージはありません</strong>
            <span className="muted">最初のメッセージを送ってみましょう。</span>
          </div>
        )}
        {items.map((item) => {
          if (item.kind === "date") {
            return (
              <div key={item.key} className="day-sep">
                <span>{item.label}</span>
              </div>
            );
          }
          if (item.kind === "unread") {
            return (
              <div key={item.key} className="unread-sep">
                <span>新着メッセージ</span>
              </div>
            );
          }
          const message = item.message;
          const sender = store.users.get(message.sender_id);
          const senderName = sender?.display_name ?? (message.pending ? me?.display_name : undefined) ?? "unknown";
          const mine = me?.id === message.sender_id;
          const reactions = message.reactions ?? [];
          return (
            <article
              key={message.id}
              className={`message${item.compact ? " compact" : ""}${message.pending ? " pending" : ""}${message.failed ? " failed" : ""}`}
              title={item.compact ? fullTimestamp(message.created_at) : undefined}
            >
              <div className="gutter">
                {item.compact ? <span className="time-hover">{timeLabel(message.created_at)}</span> : <Avatar id={message.sender_id} name={senderName} />}
              </div>
              <div className="content">
                {!item.compact && (
                  <div className="meta">
                    <strong>{senderName}</strong>
                    <time title={fullTimestamp(message.created_at)}>{timeLabel(message.created_at)}</time>
                    {message.edited_at && <span className="muted">(編集済み)</span>}
                  </div>
                )}
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
                {message.failed && (
                  <div className="error send-failed">
                    送信に失敗しました
                    <button className="link" onClick={() => void engine?.retryFailed()}>
                      再送
                    </button>
                    <button className="link" onClick={() => message.client_msg_id && engine?.discardFailed(message.client_msg_id)}>
                      破棄
                    </button>
                  </div>
                )}
                {(message.reply_count ?? 0) > 0 && onOpenThread && (
                  <button className="link replies" onClick={() => onOpenThread(message.id)}>
                    💬 {message.reply_count} 件の返信
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
              </div>
              {!message.pending && (
                <div className="actions">
                  {REACTION_PALETTE.map((emoji) => (
                    <button key={emoji} title="リアクション" onClick={() => void controller.toggleReaction(message, emoji)}>
                      {emoji}
                    </button>
                  ))}
                  {onOpenThread && (
                    <button title="スレッドで返信" onClick={() => onOpenThread(message.id)}>
                      💬
                    </button>
                  )}
                  {mine && (
                    <button title="編集" onClick={() => startEdit(message)}>
                      ✏️
                    </button>
                  )}
                  {(mine || controller.isAdmin) &&
                    (confirmDeleteId === message.id ? (
                      <>
                        <button
                          className="danger"
                          onClick={() => {
                            setConfirmDeleteId(null);
                            void controller.deleteMessage(message.id);
                          }}
                        >
                          本当に削除
                        </button>
                        <button onClick={() => setConfirmDeleteId(null)}>やめる</button>
                      </>
                    ) : (
                      <button title="削除" onClick={() => setConfirmDeleteId(message.id)}>
                        🗑
                      </button>
                    ))}
                </div>
              )}
            </article>
          );
        })}
        <div ref={bottom} />
      </div>
      {showJump && (
        <button className="jump" onClick={scrollToBottom}>
          ↓ 最新のメッセージへ
        </button>
      )}
    </div>
  );
}
