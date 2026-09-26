import { ArrowDown, Mail, MessageSquare, MessagesSquare, Pencil, SmilePlus, Trash2 } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";

import type { AppController } from "../state/app";
import type { ChannelState, MessageState } from "../sync/types";
import { AttachmentList } from "./Attachments";
import { Avatar } from "./Avatar";
import { buildTimeline, fullTimestamp, timeLabel } from "./format";
import { decodeMentions, encodeMentions } from "./mentions";
import { MessageBody } from "./MessageBody";
import { Button, cn, IconButton, Kbd, PopoverContent, PopoverRoot, PopoverTrigger, Textarea } from "./primitives";

const REACTION_PALETTE = ["👍", "❤️", "😂", "🎉", "👀", "✅", "🙏", "🔥", "😢", "😮", "💯", "🚀", "👏", "🤔", "😍", "😅", "🙌", "💪", "☕", "🍵", "🎂", "🥳", "😴", "🫡"];

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
  const content = useRef<HTMLDivElement>(null);
  // Scroll the container itself (scrollIntoView would also move scrollable ancestors).
  const scrollToBottom = () => {
    const el = container.current;
    if (el) el.scrollTop = el.scrollHeight;
  };
  // Images loading, the composer growing or the window resizing change heights after we positioned:
  // stay pinned to the bottom when the reader was there.
  useEffect(() => {
    const el = container.current;
    const inner = content.current;
    if (!el || !inner || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      if (atBottom.current && positioned.current && !anchor.current) scrollToBottom();
    });
    observer.observe(el);
    observer.observe(inner);
    return () => observer.disconnect();
  }, []);
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

  const loadOlder = () => {
    const el = container.current;
    if (!engine || loadingOlder) return;
    if (el) anchor.current = { height: el.scrollHeight, top: el.scrollTop };
    setLoadingOlder(true);
    void engine.loadOlder(channel.id).catch((error) => controller.setError(error)).finally(() => setLoadingOlder(false));
  };

  const onScroll = () => {
    const el = container.current;
    if (!el) return;
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    atBottom.current = distance < 48;
    setShowJump(distance > 240);
    if (atBottom.current) markSeen();
    markVisible();
    if (!focus && el.scrollTop < 120 && channel.hasOlder && channel.syncedSeq !== null && !loadingOlder && engine?.status === "online") loadOlder();
  };

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <div className="timeline flex-1 overflow-y-auto px-4 pb-3 pt-2" ref={container} onScroll={onScroll}>
        <div ref={content}>
        {focus && (
          <div className="sticky top-0 z-10 mb-2 flex items-center justify-between rounded-lg bg-accent-soft px-3 py-2 text-xs text-ink shadow-sm">
            <span>検索位置の前後の会話</span>
            <Button variant="link" size="sm" onClick={() => { controller.clearMessageFocus(); requestAnimationFrame(scrollToBottom); }}>
              最新の会話に戻る
            </Button>
          </div>
        )}
        {loadingOlder && <div className="py-2 text-center text-xs text-muted">読み込み中…</div>}
        {!focus && !loadingOlder && channel.hasOlder && messages.length > 0 && engine && (
          <div className="py-1 text-center">
            <Button variant="link" size="sm" onClick={loadOlder}>
              以前のメッセージを読み込む
            </Button>
          </div>
        )}
        {!focus && !channel.hasOlder && messages.length > 0 && <div className="py-3 text-center text-xs text-muted">ここが会話の始まりです</div>}
        {messages.length === 0 && (
          <div className="flex flex-col items-center gap-2 px-4 py-16 text-center">
            <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-accent-soft text-accent">
              <MessagesSquare size={22} />
            </span>
            <strong className="text-base">まだメッセージはありません</strong>
            <span className="text-sm text-muted">最初のメッセージを送ってみましょう。</span>
          </div>
        )}
        {items.map((item) => {
          if (item.kind === "date") {
            return (
              <div key={item.key} className="my-3 flex items-center gap-3 text-xs text-muted">
                <span className="h-px flex-1 bg-line" />
                <span className="rounded-full border border-line bg-canvas px-3 py-0.5">{item.label}</span>
                <span className="h-px flex-1 bg-line" />
              </div>
            );
          }
          if (item.kind === "unread") {
            return (
              <div key={item.key} className="my-2 flex items-center gap-3 text-xs font-semibold text-rose-500">
                <span className="h-px flex-1 bg-rose-400/70" />
                <span>新着メッセージ</span>
                <span className="h-px flex-1 bg-rose-400/70" />
              </div>
            );
          }
          return <MessageRow key={item.message.id} controller={controller} message={item.message} compact={item.compact} onOpenThread={onOpenThread} />;
        })}
        <div ref={bottom} />
        </div>
      </div>
      {!focus && showJump && (
        <button
          type="button"
          onClick={scrollToBottom}
          className={cn(
            "absolute bottom-3 right-6 inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-medium shadow-lg transition-colors",
            unseenBelow > 0 ? "border-accent bg-accent text-white hover:bg-accent/90" : "border-line bg-canvas text-ink hover:bg-panel",
          )}
        >
          <ArrowDown size={14} />
          {unseenBelow > 0 ? `新着 ${unseenBelow} 件` : "最新のメッセージへ"}
        </button>
      )}
    </div>
  );
}

/** One message with hover actions; shared by the timeline and the thread pane. */
export function MessageRow({ controller, message, compact = false, onOpenThread, thread = false }: {
  controller: AppController; message: MessageState; compact?: boolean; onOpenThread?: (id: string) => void; thread?: boolean;
}) {
  const store = controller.store;
  const engine = controller.engine;
  const me = store.me;
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const editing = controller.editing === message.id;

  const sender = store.users.get(message.sender_id);
  const senderName = sender?.display_name ?? (message.pending ? me?.display_name : undefined) ?? "unknown";
  const mine = me?.id === message.sender_id;
  const reactions = message.reactions ?? [];
  const highlighted = controller.messageFocus?.messageId === message.id;
  const size = thread ? 30 : 36;
  return (
    <article
      key={message.id}
      id={`${thread ? "thread" : "timeline"}-${message.id}`}
      data-seq={message.seq ?? undefined}
      tabIndex={0}
      className={cn(
        "message group relative -mx-2 grid gap-x-2.5 rounded-lg px-2 outline-none transition-colors hover:bg-panel focus-visible:ring-2 focus-visible:ring-accent/40",
        thread ? "grid-cols-[30px_minmax(0,1fr)]" : "grid-cols-[36px_minmax(0,1fr)]",
        compact ? "py-0.5" : "mt-1 py-1.5",
        highlighted && "highlighted",
        message.pending && "opacity-60",
        message.failed && "opacity-100 shadow-[inset_3px_0_0_var(--danger)]",
      )}
      title={compact ? fullTimestamp(message.created_at) : undefined}
      onClick={(event) => {
        // Alt+click marks the conversation unread from this message (Mattermost).
        if (event.altKey && !thread && message.seq !== null && !message.pending) engine?.markUnread(message.channel_id, message.seq);
      }}
    >
      <div className="flex justify-center pt-0.5">
        {compact ? <span className="time-hover pt-1 text-[10px] leading-4 text-muted">{timeLabel(message.created_at)}</span> : <Avatar id={message.sender_id} name={senderName} size={size} />}
      </div>
      <div className="min-w-0">
        {!compact && (
          <div className="flex items-baseline gap-2 text-xs text-muted">
            <strong className="text-sm text-ink">{senderName}</strong>
            <time title={fullTimestamp(message.created_at)}>{timeLabel(message.created_at)}</time>
            {message.edited_at && <span>(編集済み)</span>}
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
          <div className="mt-1 flex items-center gap-2 text-xs text-danger">
            送信に失敗しました
            <Button variant="link" size="sm" onClick={() => void engine?.retryFailed()}>再送</Button>
            <Button variant="link" size="sm" onClick={() => message.client_msg_id && engine?.discardFailed(message.client_msg_id)}>破棄</Button>
          </div>
        )}
        {(message.reply_count ?? 0) > 0 && onOpenThread && (
          <button type="button" className="mt-1 inline-flex items-center gap-1.5 rounded-md text-xs font-medium text-accent hover:underline" onClick={() => onOpenThread(message.id)}>
            <MessageSquare size={13} /> {message.reply_count} 件の返信
          </button>
        )}
        {reactions.length > 0 && (
          <div className="mt-1.5 flex flex-wrap gap-1">
            {reactions.map((reaction) => {
              const reacted = !!me && reaction.user_ids.includes(me.id);
              const names = reaction.user_ids.map((id) => store.users.get(id)?.display_name ?? "?").join(", ");
              return (
                <button
                  key={reaction.emoji}
                  type="button"
                  title={names}
                  onClick={() => void controller.toggleReaction(message, reaction.emoji)}
                  className={cn(
                    "inline-flex h-6 items-center gap-1 rounded-full border px-2 text-xs transition-colors",
                    reacted ? "border-accent bg-accent-soft text-ink" : "border-line bg-panel text-ink hover:border-accent/50",
                  )}
                >
                  <span>{reaction.emoji}</span>
                  <span className="font-medium">{reaction.count}</span>
                </button>
              );
            })}
          </div>
        )}
      </div>
      {!message.pending && (
        <div className="row-actions pointer-events-none absolute -top-3.5 right-2 flex items-center gap-0.5 rounded-lg border border-line bg-canvas p-0.5 opacity-0 shadow-md transition-opacity">
          {REACTION_PALETTE.slice(0, 3).map((emoji) => (
            <button key={emoji} type="button" title={`${emoji} でリアクション`} className="h-7 w-7 rounded-md text-base leading-none hover:bg-panel-2" onClick={() => void controller.toggleReaction(message, emoji)}>
              {emoji}
            </button>
          ))}
          <PopoverRoot open={pickerOpen} onOpenChange={setPickerOpen}>
            <PopoverTrigger asChild>
              <button type="button" title="リアクションを追加" aria-label="リアクションを追加" className="flex h-7 w-7 items-center justify-center rounded-md text-muted hover:bg-panel-2 hover:text-ink">
                <SmilePlus size={16} />
              </button>
            </PopoverTrigger>
            <PopoverContent align="end" className="w-64">
              <div className="grid grid-cols-8 gap-0.5">
                {REACTION_PALETTE.map((emoji) => (
                  <button
                    key={emoji}
                    type="button"
                    className="flex h-7 w-7 items-center justify-center rounded-md text-base hover:bg-panel-2"
                    onClick={() => {
                      setPickerOpen(false);
                      void controller.toggleReaction(message, emoji);
                    }}
                  >
                    {emoji}
                  </button>
                ))}
              </div>
            </PopoverContent>
          </PopoverRoot>
          {onOpenThread && (
            <IconButton label="スレッドで返信" className="h-7 w-7 text-muted hover:text-ink" onClick={() => onOpenThread(message.id)}>
              <MessageSquare size={15} />
            </IconButton>
          )}
          {!thread && message.seq !== null && (
            <IconButton label="ここから未読にする (Alt+クリック)" className="h-7 w-7 text-muted hover:text-ink" onClick={() => engine?.markUnread(message.channel_id, message.seq!)}>
              <Mail size={15} />
            </IconButton>
          )}
          {mine && (
            <IconButton label="編集 (空の入力欄で ↑)" className="h-7 w-7 text-muted hover:text-ink" onClick={() => controller.setEditing(message.id)}>
              <Pencil size={15} />
            </IconButton>
          )}
          {(mine || controller.isAdmin) &&
            (confirmDelete ? (
              <span className="flex items-center gap-1 pl-1">
                <Button variant="danger" size="sm" onClick={() => { setConfirmDelete(false); void controller.deleteMessage(message.id); }}>
                  削除する
                </Button>
                <Button variant="secondary" size="sm" onClick={() => setConfirmDelete(false)}>
                  やめる
                </Button>
              </span>
            ) : (
              <IconButton label="削除" className="h-7 w-7 text-muted hover:text-danger" onClick={() => setConfirmDelete(true)}>
                <Trash2 size={15} />
              </IconButton>
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
    <div className="mt-1 space-y-2">
      <Textarea
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
      <div className="flex items-center gap-2">
        <Button size="sm" onClick={save} disabled={!draft.trim()}>
          保存
        </Button>
        <Button size="sm" variant="secondary" onClick={finish}>
          キャンセル
        </Button>
        <span className="flex items-center gap-1 text-[11px] text-muted">
          <Kbd>Enter</Kbd> 保存 <Kbd>Esc</Kbd> 取り消し
        </span>
      </div>
    </div>
  );
}
