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
  const focus = controller.messageFocus?.channelId === channel.id ? controller.messageFocus : null;
  const messages: MessageState[] = focus ? focus.context.map((m) => { const cached = store.message(channel.id, m.id); return cached && cached.updated_seq >= m.updated_seq ? cached : m; }).filter((m) => !m.deleted) : store.messages(channel.id);
  const me = store.me;
  const container = useRef<HTMLDivElement>(null);
  const bottom = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);
  const [showJump, setShowJump] = useState(false);
  // Newest seq the reader has had on screen at the bottom; messages above it from others are "new".
  const [seenSeq, setSeenSeq] = useState(channel.lastReadSeq);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const anchor = useRef<{ height: number; top: number } | null>(null);


  // The "new messages" divider stays where it was when the channel was opened.
  const unreadMark = useRef<{ channelId: string; seq: number | null }>({ channelId: "", seq: null });
  if (unreadMark.current.channelId !== channel.id) {
    unreadMark.current = { channelId: channel.id, seq: channel.unreadCount > 0 ? channel.lastReadSeq : null };
  }
  const heldUnread = engine?.unreadHold.get(channel.id);
  const items = buildTimeline(messages, { firstUnreadAfterSeq: heldUnread ?? unreadMark.current.seq, meId: me?.id ?? null });
  const lastId = messages[messages.length - 1]?.id;
  const maxSeq = messages.reduce((max, m) => (m.seq !== null && m.seq > max ? m.seq : max), 0);
  const unseenBelow = focus ? 0 : messages.filter((m) => m.seq !== null && m.seq > seenSeq && m.sender_id !== me?.id).length;
  const markSeen = () => {
    if (maxSeq > seenSeq) setSeenSeq(maxSeq);
  };

  const positioned = useRef(false);
  const scrollToBottom = () => bottom.current?.scrollIntoView({ block: "end" });
  const markVisible = () => {
    const el = container.current;
    if (!el || focus || !positioned.current || !document.hasFocus()) return;
    const bounds = el.getBoundingClientRect();
    const visible = [...el.querySelectorAll<HTMLElement>("article[data-seq]")].filter((row) => {
      const box = row.getBoundingClientRect();
      return box.bottom <= bounds.bottom + 1 && box.bottom > bounds.top && (box.top >= bounds.top || box.height > bounds.height);
    });
    const seq = Math.max(0, ...visible.map((row) => Number(row.dataset.seq)));
    if (seq > 0) engine?.markRead(channel.id, seq);
  };

  useLayoutEffect(() => {
    // Older messages were prepended: keep the viewport anchored to what the reader was looking at.
    const el = container.current;
    if (el && anchor.current) {
      el.scrollTop = anchor.current.top + (el.scrollHeight - anchor.current.height);
      anchor.current = null;
    }
  }, [messages.length]);

  useLayoutEffect(() => {
    positioned.current = false;
    atBottom.current = false;
    setSeenSeq(channel.lastReadSeq);
  }, [channel.id, focus?.messageId]);

  useLayoutEffect(() => {
    if (positioned.current || messages.length === 0) return;
    const target = focus?.parentId ?? focus?.messageId ?? messages.find((m) => m.seq !== null && unreadMark.current.seq !== null && m.seq > unreadMark.current.seq)?.id;
    if (target) document.getElementById(`timeline-${target}`)?.scrollIntoView({ block: focus ? "center" : "start" });
    else scrollToBottom();
    positioned.current = true;
    const el = container.current;
    atBottom.current = !!el && el.scrollHeight - el.scrollTop - el.clientHeight < 48;
    setShowJump(!atBottom.current);
    if (atBottom.current) markSeen();
  }, [channel.id, focus?.messageId, messages.length]);

  useEffect(() => {
    if (!focus && atBottom.current && positioned.current) {
      scrollToBottom();
      markSeen();
    }
  }, [lastId]);
  useEffect(() => {
    markVisible();
    window.addEventListener("focus", markVisible);
    return () => window.removeEventListener("focus", markVisible);
  }, [channel.id, channel.lastSeq, engine?.status, focus?.messageId, messages.length]);

  const onScroll = () => {
    const el = container.current;
    if (!el) return;
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    atBottom.current = distance < 48;
    setShowJump(distance > 240);
    if (atBottom.current) markSeen();
    markVisible();
    if (!focus && el.scrollTop < 120 && channel.hasOlder && channel.syncedSeq !== null && !loadingOlder && engine?.status === "online") {
      setLoadingOlder(true);
      anchor.current = { height: el.scrollHeight, top: el.scrollTop };
      void engine.loadOlder(channel.id).catch((error) => controller.setError(error)).finally(() => setLoadingOlder(false));
    }
  };


  return (
    <div className="timeline-wrap">
      <div className="timeline" ref={container} onScroll={onScroll}>
        {focus && <div className="context-notice">検索位置の前後の会話 <button className="link" onClick={() => { controller.clearMessageFocus(); requestAnimationFrame(scrollToBottom); }}>最新の会話に戻る</button></div>}
        {loadingOlder && <div className="muted centered-row">読み込み中…</div>}
        {!focus && !loadingOlder && channel.hasOlder && messages.length > 0 && engine && (
          <div className="centered-row">
            <button
              className="link"
              onClick={() => {
                const el = container.current;
                if (el) anchor.current = { height: el.scrollHeight, top: el.scrollTop };
                setLoadingOlder(true);
                void engine.loadOlder(channel.id).catch((error) => controller.setError(error)).finally(() => setLoadingOlder(false));
              }}
            >
              以前のメッセージを読み込む
            </button>
          </div>
        )}
        {!focus && !channel.hasOlder && messages.length > 0 && <div className="muted centered-row history-start">ここが会話の始まりです</div>}
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
          return <MessageRow key={item.message.id} controller={controller} message={item.message} compact={item.compact} onOpenThread={onOpenThread} />;
        })}
        <div ref={bottom} />
      </div>
      {!focus && showJump && (
        <button className={`jump${unseenBelow > 0 ? " fresh" : ""}`} onClick={scrollToBottom}>
          {unseenBelow > 0 ? `↓ 新着 ${unseenBelow} 件` : "↓ 最新のメッセージへ"}
        </button>
      )}
    </div>
  );
}


/** Shared actions for timeline and thread messages. */
export function MessageRow({ controller, message, compact = false, onOpenThread, thread = false }: {
  controller: AppController; message: MessageState; compact?: boolean; onOpenThread?: (id: string) => void; thread?: boolean;
}) {
  const store = controller.store;
  const engine = controller.engine;
  const me = store.me;
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const editing = controller.editing === message.id;

  const sender = store.users.get(message.sender_id);
  const senderName = sender?.display_name ?? (message.pending ? me?.display_name : undefined) ?? "unknown";
  const mine = me?.id === message.sender_id;
  const reactions = message.reactions ?? [];
  return (
    <article
      key={message.id}
      id={`${thread ? "thread" : "timeline"}-${message.id}`}
      data-seq={message.seq ?? undefined}
      tabIndex={0}
      className={`message${controller.messageFocus?.messageId === message.id ? " highlighted" : ""}${compact ? " compact" : ""}${message.pending ? " pending" : ""}${message.failed ? " failed" : ""}`}
      title={compact ? fullTimestamp(message.created_at) : undefined}
      onClick={(event) => {
        // Alt+click marks the conversation unread from this message (Mattermost).
        if (event.altKey && !thread && message.seq !== null && !message.pending) engine?.markUnread(message.channel_id, message.seq);
      }}
    >
      <div className="gutter">
        {compact ? <span className="time-hover">{timeLabel(message.created_at)}</span> : <Avatar id={message.sender_id} name={senderName} />}
      </div>
      <div className="content">
        {!compact && (
          <div className="meta">
            <strong>{senderName}</strong>
            <time title={fullTimestamp(message.created_at)}>{timeLabel(message.created_at)}</time>
            {message.edited_at && <span className="muted">(編集済み)</span>}
          </div>
        )}
        {editing ? (
          <MessageEditor controller={controller} message={message} />
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
          {!thread && message.seq !== null && (
            <button title="ここから未読にする (Alt+クリック)" onClick={() => engine?.markUnread(message.channel_id, message.seq!)}>
              📩
            </button>
          )}
          {mine && (
            <button title="編集 (空の入力欄で ↑)" onClick={() => controller.setEditing(message.id)}>
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
}

/** Inline editor: Enter saves, Esc cancels, focus returns to the composer afterwards. */
function MessageEditor({ controller, message }: { controller: AppController; message: MessageState }) {
  const store = controller.store;
  const [draft, setDraft] = useState(() => decodeMentions(message.body, store.users));
  const composing = useRef(false);
  const finish = () => {
    controller.setEditing(null);
    requestAnimationFrame(() => document.querySelector<HTMLTextAreaElement>(".composer textarea")?.focus());
  };
  const save = () => {
    const body = encodeMentions(draft.trim(), store.users.values());
    finish();
    if (body && body !== message.body) void controller.editMessage(message.id, body);
  };
  return (
    <div className="editor">
      <textarea
        value={draft}
        rows={3}
        autoFocus
        aria-label="メッセージを編集"
        onFocus={(e) => e.currentTarget.setSelectionRange(e.currentTarget.value.length, e.currentTarget.value.length)}
        onChange={(e) => setDraft(e.target.value)}
        onCompositionStart={() => {
          composing.current = true;
        }}
        onCompositionEnd={() => {
          composing.current = false;
        }}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            finish();
          } else if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing && !composing.current && e.keyCode !== 229) {
            e.preventDefault();
            if (draft.trim()) save();
          }
        }}
      />
      <div>
        <button onClick={save} disabled={!draft.trim()}>
          保存
        </button>
        <button className="secondary" onClick={finish}>
          キャンセル
        </button>
        <span className="muted hint">Enter で保存、Esc で取り消し</span>
      </div>
    </div>
  );
}
