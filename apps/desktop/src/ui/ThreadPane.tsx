import { Bell, BellRing, X } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";

import type { MessageOut } from "../api/types";
import type { AppController } from "../state/app";
import { firstUnreadRow, passedUnseen } from "../sync/readGate";
import type { ChannelState, MessageState } from "../sync/types";
import { tapClosesKeyboard } from "../platform/viewport";
import { Composer } from "./Composer";
import { rowKey } from "./format";
import { channelTitle } from "./MainScreen";
import { Button, IconButton } from "./primitives";
import { MessageRow, screenRows } from "./Timeline";
import { TypingIndicator } from "./Typing";
import { READER_BACK } from "../platform/idle";

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
  // §7.7: the channel's rows (these replies among them) are not trimmed while the thread is open.
  useEffect(() => engine?.viewing(channel.id), [engine, channel.id]);
  const focused = useRef<string | null>(null);
  const list = useRef<HTMLDivElement>(null);
  const [tapHandlers] = useState(() => tapClosesKeyboard());
  const lastReplyId = replies[replies.length - 1]?.id;
  const me = store.me?.id;
  // §10.2: ready once the whole thread was fetched here (the engine forgets that when the channel's messages are
  // cleared) and my read position in it is known. Before that the held replies may be only the newest ones.
  const [loaded, setLoaded] = useState<string | null>(null);
  const ready = loaded === parentId && !!engine?.threadComplete(parentId) && state !== undefined;
  // Like the timeline's: visible replies mark read only after the first unread reply has been on screen.
  const anchored = useRef(false);
  /** The parent whose opening position was applied (once, when the thread is ready). */
  const positioned = useRef<string | null>(null);
  /** The reader scrolled before the thread was ready: the opening position is then skipped. */
  const userScrolled = useRef(false);
  const divider = useRef<HTMLDivElement>(null);
  // A search hit or permalink inside this thread.
  const focusId = controller.messageFocus?.parentId === parentId ? controller.messageFocus.messageId : null;

  useLayoutEffect(() => {
    anchored.current = false;
    positioned.current = null;
    userScrolled.current = false;
  }, [parentId]);

  // My own reply (or a reply arriving while I am at the bottom) shows the newest message.
  useEffect(() => {
    const el = list.current;
    const last = replies[replies.length - 1];
    if (!el || !last) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    if (nearBottom || (last.sender_id === store.me?.id && last.pending)) el.scrollTop = el.scrollHeight;
  }, [lastReplyId]);

  // Fetched on open and after reconnecting, and again as soon as the engine forgets the whole thread while online (a
  // §7.3 reload of the channel, §10.2): waiting for the connection to change would leave it unread for good.
  const complete = !!engine?.threadComplete(parentId);
  const fetched = useRef<{ engine: unknown; key: string } | null>(null);
  useEffect(() => {
    const key = `${channel.id}:${parentId}:${engine?.status}`;
    if (complete && fetched.current?.engine === engine && fetched.current.key === key) return; // that fetch completed it
    fetched.current = { engine, key };
    void engine?.loadReplies(channel.id, parentId).then((ok) => {
      if (ok) setLoaded(parentId);
    }, (error) => controller.setError(error));
  }, [engine, engine?.status, channel.id, parentId, complete]);

  // Until the thread is ready the held replies sit at the bottom (or the search hit is centred). Once it is, the
  // opening position is applied once: the hit, else 「新しい返信」 at the top, else the newest reply.
  useLayoutEffect(() => {
    const el = list.current;
    if (!el || positioned.current === parentId) return;
    if (userScrolled.current) {
      if (ready) positioned.current = parentId; // the reader moved first: leave the view where it is
      return;
    }
    const hit = focusId ? document.getElementById(`thread-${focusId}`) : null;
    const unread = ready && state ? firstUnreadRow(replies, state.last_read_seq, me) : null;
    if (hit) hit.scrollIntoView({ block: "center" });
    else if (unread && divider.current) divider.current.scrollIntoView({ block: "start" });
    else el.scrollTop = el.scrollHeight;
    if (!ready) return;
    positioned.current = parentId;
    if (!hit && unread) anchored.current = true;
  }, [parentId, replies.length, ready, focusId]);

  useEffect(() => {
    const el = list.current;
    if (!el) return;
    const moved = () => {
      userScrolled.current = true;
    };
    const events = ["wheel", "touchmove", "pointerdown", "keydown"] as const;
    for (const name of events) el.addEventListener(name, moved, { passive: true });
    return () => {
      for (const name of events) el.removeEventListener(name, moved);
    };
  }, []);

  // THREADS.md §5: my relation to the thread (follow flag, read position) is fetched once per thread.
  useEffect(() => {
    if (state || !parent || parent.seq === null || parent.pending) return;
    void engine?.loadThreadState(parentId, parent as MessageOut).catch((error) => controller.setError(error));
  }, [engine, engine?.status, parentId, state !== undefined, parent?.seq]);

  // No parent held: a thread opened from the preview and kept open through 「#name に参加する」 (§7.6.1), whose parent
  // is older than the page the conversation loaded. The engine fetches it, and the thread goes on with its composer.
  const parentMissing = parent === undefined;
  useEffect(() => {
    if (!parentMissing) return;
    void engine?.loadParent(channel.id, parentId).catch((error) => controller.setError(error));
  }, [engine, engine?.status, channel.id, parentId, parentMissing]);

  // §10.2 (false cases 1 and 2): the thread stopped being ready, or a §7.3 reload replaced the channel's rows (perhaps
  // refetched before any render saw the thread not ready). Dropped here even in the background, where markVisible
  // does not run.
  const reloads = engine?.reloadCount(channel.id) ?? 0;
  const seenReloads = useRef(reloads);
  useEffect(() => {
    if (!ready || seenReloads.current !== reloads) anchored.current = false;
    seenReloads.current = reloads;
  }, [ready, reloads]);

  // Read position = the newest reply that has been shown (never just "opened"), like the timeline.
  const markVisible = () => {
    const el = list.current;
    if (!el || !document.hasFocus()) return;
    const seen = screenRows(el, "[data-replies] article[data-seq]", "thread-");
    // §10.2 anchored: false while the thread is not ready; then true once the first unread reply (matched by message
    // id, §10.3) is on screen or there is none, until that reply goes past above the screen unseen (§10.1 2.).
    const unread = ready && state ? firstUnreadRow(replies, state.last_read_seq, me) : null;
    anchored.current = ready && (anchored.current ? !passedUnseen(unread, seen.seqs, seen.partly) : unread === null || seen.shown.has(unread.id));
    const seq = Math.max(0, ...seen.seqs);
    if (anchored.current && seq > 0) engine?.markThreadRead(parentId, seq);
  };
  useEffect(() => {
    markVisible();
    const el = list.current;
    el?.addEventListener("scroll", markVisible, { passive: true });
    window.addEventListener("focus", markVisible);
    window.addEventListener(READER_BACK, markVisible);
    return () => {
      el?.removeEventListener("scroll", markVisible);
      window.removeEventListener("focus", markVisible);
      window.removeEventListener(READER_BACK, markVisible);
    };
  }, [parentId, replies.length, lastReplyId, engine, ready, state?.last_read_seq]);

  useEffect(() => {
    const id = controller.messageFocus?.messageId;
    if (id && focused.current !== id) {
      const row = document.getElementById(`thread-${id}`);
      if (row) { row.scrollIntoView({ block: "center" }); focused.current = id; }
    }
  }, [parentId, controller.messageFocus?.messageId, replies.length]);

  // 「新しい返信」: the divider sits before the first reply from someone else past my read position; only once the
  // whole thread is held (the newest replies alone would put it in the wrong place).
  const firstUnread = ready && state ? firstUnreadRow(replies, state.last_read_seq, me)?.id : undefined;

  return (
    <aside className="flex min-h-0 w-full min-w-0 flex-col border-l border-line bg-canvas max-md:border-l-0">
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
      <div data-message-list data-chat-focus tabIndex={-1} aria-label="スレッドのメッセージ一覧" ref={list} className="min-h-0 flex-1 overflow-y-auto px-3 py-2" {...tapHandlers}>
        {parent ? (
          <>
            <MessageRow thread message={parent} controller={controller} />
            <div className="my-2 flex items-center gap-2 text-xs text-muted">
              <span className="whitespace-nowrap">{replies.length === 0 ? "返信はまだありません" : `${replies.length} 件の返信`}</span>
              <span className="h-px flex-1 bg-line" />
            </div>
            <div data-replies="">
              {replies.map((reply) => (
                <div key={rowKey(reply)}>
                  {reply.id === firstUnread && (
                    <div ref={divider} className="my-1 flex items-center gap-2 text-[11px] font-semibold text-rose-500">
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
      {parent && channel.isMember && !channel.archived && <Composer key={parentId} controller={controller} channel={channel} parentId={parentId} placeholder="スレッドに返信" />}
      {parent && channel.isMember && !channel.archived && <TypingIndicator controller={controller} channelId={channel.id} parentId={parentId} />}
    </aside>
  );
}
