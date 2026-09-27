import { Bell, BellRing, X } from "lucide-react";
import { useEffect, useRef } from "react";

import type { MessageOut } from "../api/types";
import type { AppController } from "../state/app";
import type { ChannelState, MessageState } from "../sync/types";
import { Composer } from "./Composer";
import { channelTitle } from "./MainScreen";
import { Button, IconButton } from "./primitives";
import { MessageRow } from "./Timeline";
import { TypingIndicator } from "./Typing";

/** The right pane: one thread (parent + replies) with its own composer, follow toggle and read position. */
export function ThreadPane({ controller, channel, parentId, onClose }: { controller: AppController; channel: ChannelState; parentId: string; onClose: () => void }) {
  const store = controller.store;
  const engine = controller.engine;
  const entry = store.threads.get(parentId);
  // The parent comes from the channel, the threads list or a search hit; once seen it is kept for
  // this pane so a list refresh that drops the row does not blank the thread.
  const lastParent = useRef<{ id: string; message: MessageState } | null>(null);
  const found: MessageState | undefined = store.message(channel.id, parentId) ?? entry?.parent ?? controller.messageFocus?.context.find((m) => m.id === parentId);
  if (found) lastParent.current = { id: parentId, message: found };
  const parent = found ?? (lastParent.current?.id === parentId ? lastParent.current.message : undefined);
  const replies = store.replies(channel.id, parentId);
  const state = entry?.state;
  const focused = useRef<string | null>(null);
  const list = useRef<HTMLDivElement>(null);
  const lastReplyId = replies[replies.length - 1]?.id;

  // My own reply (or a reply arriving while I am at the bottom) shows the newest message.
  useEffect(() => {
    const el = list.current;
    const last = replies[replies.length - 1];
    if (!el || !last) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    if (nearBottom || (last.sender_id === store.me?.id && last.pending)) el.scrollTop = el.scrollHeight;
  }, [lastReplyId]);

  useEffect(() => {
    void engine?.loadReplies(channel.id, parentId).catch((error) => controller.setError(error));
  }, [engine, engine?.status, channel.id, parentId]);

  // THREADS.md §5: my relation to the thread (follow flag, read position) is fetched once per thread.
  useEffect(() => {
    if (state || !parent || parent.seq === null || parent.pending) return;
    void engine?.loadThreadState(parentId, parent as MessageOut).catch((error) => controller.setError(error));
  }, [engine, engine?.status, parentId, state !== undefined, parent?.seq]);

  // Read position = the newest reply that has been shown (never just "opened"), like the timeline.
  const markVisible = () => {
    const el = list.current;
    if (!el || !document.hasFocus()) return;
    const bounds = el.getBoundingClientRect();
    const visible = [...el.querySelectorAll<HTMLElement>("[data-replies] article[data-seq]")].filter((row) => {
      const box = row.getBoundingClientRect();
      return box.bottom <= bounds.bottom + 1 && box.bottom > bounds.top && (box.top >= bounds.top || box.height > bounds.height);
    });
    const seq = Math.max(0, ...visible.map((row) => Number(row.dataset["seq"])));
    if (seq > 0) engine?.markThreadRead(parentId, seq);
  };
  useEffect(() => {
    markVisible();
    const el = list.current;
    el?.addEventListener("scroll", markVisible, { passive: true });
    window.addEventListener("focus", markVisible);
    return () => {
      el?.removeEventListener("scroll", markVisible);
      window.removeEventListener("focus", markVisible);
    };
  }, [parentId, replies.length, lastReplyId, engine]);

  useEffect(() => {
    const id = controller.messageFocus?.messageId;
    if (id && focused.current !== id) {
      const row = document.getElementById(`thread-${id}`);
      if (row) { row.scrollIntoView({ block: "center" }); focused.current = id; }
    }
  }, [parentId, controller.messageFocus?.messageId, replies.length]);

  // 「新しい返信」: the divider sits before the first reply from someone else past my read position.
  const me = store.me?.id;
  const firstUnread = state ? replies.find((r) => r.seq !== null && r.seq > state.last_read_seq && r.sender_id !== me)?.id : undefined;

  return (
    <aside className="flex min-h-0 w-full min-w-0 flex-col border-l border-line bg-canvas">
      <header className="flex h-[52px] items-center gap-2 border-b border-line px-4">
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold">スレッド</div>
          <div className="truncate text-xs text-muted">{channelTitle(channel, controller)}</div>
        </div>
        {state && channel.isMember && (
          <Button
            size="sm"
            variant={state.following ? "secondary" : "ghost"}
            title={state.following ? "フォローを外すと一覧と通知から消えます" : "フォローすると返信が一覧と通知に届きます"}
            aria-pressed={state.following}
            onClick={() => void engine?.setThreadFollow(parentId, !state.following).catch((error) => controller.setError(error))}
          >
            {state.following ? <BellRing size={14} /> : <Bell size={14} />}
            {state.following ? "フォロー中" : "フォロー"}
          </Button>
        )}
        <IconButton label="閉じる (Esc)" onClick={onClose}>
          <X size={18} />
        </IconButton>
      </header>
      <div ref={list} className="min-h-0 flex-1 overflow-y-auto px-3 py-2">
        {parent ? (
          <>
            <MessageRow thread message={parent} controller={controller} />
            <div className="my-2 flex items-center gap-2 text-xs text-muted">
              <span className="whitespace-nowrap">{replies.length === 0 ? "返信はまだありません" : `${replies.length} 件の返信`}</span>
              <span className="h-px flex-1 bg-line" />
            </div>
            <div data-replies="">
              {replies.map((reply) => (
                <div key={reply.id}>
                  {reply.id === firstUnread && (
                    <div className="my-1 flex items-center gap-2 text-[11px] font-semibold text-rose-500">
                      <span className="h-px flex-1 bg-rose-400/70" />
                      新しい返信
                    </div>
                  )}
                  <MessageRow thread message={reply} controller={controller} />
                </div>
              ))}
            </div>
          </>
        ) : (
          <div className="py-8 text-center text-sm text-muted">メッセージが見つかりません</div>
        )}
      </div>
      {parent && channel.isMember && !channel.archived && <TypingIndicator controller={controller} channelId={channel.id} parentId={parentId} />}
      {parent && channel.isMember && !channel.archived && <Composer key={parentId} controller={controller} channel={channel} parentId={parentId} placeholder="スレッドに返信" />}
    </aside>
  );
}
