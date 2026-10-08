import { Bell, BellRing, MoreHorizontal } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";

import type { MessageOut } from "../api/types";
import type { AppController } from "../state/app";
import { firstUnreadRow, passedUnseen } from "../sync/readGate";
import type { ChannelState, MessageState } from "../sync/types";
import { tapClosesKeyboard } from "../platform/viewport";
import { Composer } from "./Composer";
import { continuesGroup, rowKey } from "./format";
import { channelTitle } from "./MainScreen";
import { PaneBackButton, PaneCloseButton } from "./compact";
import { Button, Menu, MenuContent, MenuTrigger } from "./primitives";
import { SummaryChoices, summaryAvailable } from "./ai";
import { jumpToLatestShown, unseenBelow, useListAnchor } from "./scrollAnchor";
import { JumpToLatestButton, MessageRow, screenRows } from "./Timeline";
import { TypingIndicator } from "./Typing";
import { READER_BACK } from "../platform/idle";
import { t } from "../i18n";

/** The right pane: one thread (parent + replies) with its own composer, follow toggle and read position. */
export function ThreadPane({ controller, channel, parentId, onClose }: { controller: AppController; channel: ChannelState; parentId: string; onClose: () => void }) {
  const store = controller.store;
  const engine = controller.engine;
  const entry = store.threads.get(parentId);
  // The parent comes from the channel, the threads list, a search hit or the Times feed (L8); once seen it is kept for
  // this pane so a list refresh that drops the row does not blank the thread.
  const lastParent = useRef<{ id: string; message: MessageState } | null>(null);
  // THREADS.md §5 「元のメッセージの削除」: a deleted root leaves the store, but the threads list, a search hit or the
  // copy kept below may still hold it; this session saw it deleted, so none of them is shown.
  const rootDeleted = store.wasDeleted(parentId);
  const found: MessageState | undefined = rootDeleted ? undefined : store.message(channel.id, parentId) ?? entry?.parent ?? controller.messageFocus?.context.find((m) => m.id === parentId) ?? engine?.timesFeed?.find(parentId);
  if (found) lastParent.current = { id: parentId, message: found };
  const parent = rootDeleted ? undefined : (found ?? (lastParent.current?.id === parentId ? lastParent.current.message : undefined));
  const replies = store.replies(channel.id, parentId);
  const state = entry?.state;
  // §7.7: the channel's rows (these replies among them) are not trimmed while the thread is open.
  useEffect(() => engine?.viewing(channel.id), [engine, channel.id]);
  const focused = useRef<string | null>(null);
  const list = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  /**
   * The thread keeps still while its content changes height, as the timeline does (scrollAnchor.ts): at the end it
   * follows photos and cards arriving until the reader scrolls up; elsewhere (landed on 「新しい返信」, a hit) the
   * topmost row on screen keeps its place when the parent or replies above it grow.
   */
  const anchor = useListAnchor(list, content, "article[id^='thread-']");
  const [tapHandlers] = useState(() => tapClosesKeyboard());
  const lastReplyId = replies[replies.length - 1]?.id;
  const me = store.me?.id;
  // §10.2: ready once the whole thread was fetched here (the engine forgets that when the channel's messages are
  // cleared) and my read position in it is known. Before that the held replies may be only the newest ones.
  const [loaded, setLoaded] = useState<string | null>(null);
  const ready = loaded === parentId && !!engine?.threadComplete(parentId) && state !== undefined;
  /**
   * The thread was shown live here (its replies fetched while the root stood). Its root deleted after that (an event,
   * a catch-up, my own delete, the replies' 404 on reconnecting) closes the pane, with 「元のメッセージが削除されたため、
   * スレッドを閉じました」 unless I deleted it from this pane. A thread opened when its root was already gone (a stale
   * link, an activity row) stays open and says so instead.
   */
  const liveSeen = useRef<string | null>(null);
  if (loaded === parentId && !rootDeleted) liveSeen.current = parentId;
  useEffect(() => {
    if (!rootDeleted || liveSeen.current !== parentId) return;
    liveSeen.current = null;
    const mine = controller.takeThreadDelete(parentId);
    onClose();
    if (!mine) controller.setNotice(t("thread.rootDeletedClosed"));
  }, [rootDeleted, parentId]);
  // Like the timeline's: visible replies mark read only after the first unread reply has been on screen.
  const anchored = useRef(false);
  /** The parent whose opening position was applied (once, when the thread is ready). */
  const positioned = useRef<string | null>(null);
  const dividerMark = useRef<{ parentId: string; seq: number | null } | null>(null);
  /** The reader scrolled before the thread was ready: the opening position is then skipped. */
  const userScrolled = useRef(false);
  const divider = useRef<HTMLDivElement>(null);
  // A search hit or permalink inside this thread.
  const focusId = controller.messageFocus?.parentId === parentId ? controller.messageFocus.messageId : null;
  /**
   * 「最新の返信へ」 / 「新しい返信 N 件」, the timeline's button (long threads, testers 2026-10-07): shown while the reader
   * is up in the thread, counting replies from others newer than the newest one they had on screen at the end (or, on
   * opening, than their read position in the thread).
   */
  const [showJump, setShowJump] = useState(false);
  const [seenSeq, setSeenSeq] = useState<number | null>(null);
  const maxSeq = useRef(0);
  maxSeq.current = replies.reduce((max, reply) => (reply.seq !== null && reply.seq > max ? reply.seq : max), 0);
  const measureJump = () => {
    const el = list.current;
    if (!el) return;
    setShowJump(jumpToLatestShown(anchor.atBottom, el.scrollHeight - el.scrollTop - el.clientHeight));
    if (anchor.atBottom && positioned.current === parentId) setSeenSeq(maxSeq.current);
  };

  useLayoutEffect(() => {
    anchored.current = false;
    positioned.current = null;
    userScrolled.current = false;
    anchor.reset();
    setShowJump(false);
    setSeenSeq(null);
  }, [parentId]);

  // Replies came or went (the whole thread arriving puts the older ones above those held): the row on screen stays
  // where it is, by that row, not by the height the list gained. At the end, the follow below and the resize observer
  // keep the end.
  useLayoutEffect(() => {
    if (!anchor.atBottom) anchor.keep();
  }, [replies.length]);

  // My own reply (or a reply arriving while I am at the bottom) shows the newest message. A layout effect, before the
  // opening position below: the landing of the commit that makes the thread ready wins.
  useLayoutEffect(() => {
    const el = list.current;
    const last = replies[replies.length - 1];
    if (!el || !last) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    if (anchor.atBottom || nearBottom || (last.sender_id === store.me?.id && last.pending)) anchor.toBottom();
    measureJump(); // a reply from someone else below a reader up in the thread: the button shows and counts it
  }, [lastReplyId]);

  // Fetched on open and after reconnecting, and again as soon as the engine forgets the whole thread while online (a
  // §7.3 reload of the channel, §10.2): waiting for the connection to change would leave it unread for good.
  const complete = !!engine?.threadComplete(parentId);
  const fetched = useRef<{ engine: unknown; key: string } | null>(null);
  useEffect(() => {
    const key = `${channel.id}:${parentId}:${engine?.status}`;
    if (complete && fetched.current?.engine === engine && fetched.current.key === key) return; // that fetch completed it
    if (rootDeleted) return; // the server has no thread for it any more
    fetched.current = { engine, key };
    void engine?.loadReplies(channel.id, parentId).then((ok) => {
      if (ok) setLoaded(parentId);
    }, (error) => controller.setError(error));
  }, [engine, engine?.status, channel.id, parentId, complete, rootDeleted]);

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
    if (hit || (unread && divider.current)) {
      if (hit) hit.scrollIntoView({ block: "center" });
      else divider.current!.scrollIntoView({ block: "start" });
      anchor.placed(); // the landed row keeps its place while the parent and replies above it grow
    } else {
      anchor.toBottom();
    }
    if (!ready) return;
    positioned.current = parentId;
    if (!hit && unread) anchored.current = true;
    setSeenSeq(state?.last_read_seq ?? maxSeq.current); // the replies after the read position are new for the button
    measureJump();
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
  const parentMissing = parent === undefined && !rootDeleted;
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
    // Where the list is first (at the end, or a correction making up for growth above the row on screen), then what
    // is on screen reads.
    const onScroll = () => {
      anchor.scrolled();
      measureJump();
      markVisible();
    };
    el?.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("focus", markVisible);
    window.addEventListener(READER_BACK, markVisible);
    return () => {
      el?.removeEventListener("scroll", onScroll);
      window.removeEventListener("focus", markVisible);
      window.removeEventListener(READER_BACK, markVisible);
    };
  }, [parentId, replies.length, lastReplyId, engine, ready, state?.last_read_seq]);

  useEffect(() => {
    const id = controller.messageFocus?.messageId;
    if (id && focused.current !== id) {
      const row = document.getElementById(`thread-${id}`);
      if (row) {
        row.scrollIntoView({ block: "center" });
        anchor.placed();
        focused.current = id;
      }
    }
  }, [parentId, controller.messageFocus?.messageId, replies.length]);

  // 「新しい返信」: the divider sits before the first reply from someone else past my read position when the whole thread
  // was first held (the newest replies alone would put it in the wrong place), and stays there while it is open, like
  // the channel's divider. Taken from the live position, it showed and went at once as the replies were read (tester,
  // 2026-09-30; iOS and Android take it the same way).
  if (ready && state && dividerMark.current?.parentId !== parentId) {
    dividerMark.current = { parentId, seq: firstUnreadRow(replies, state.last_read_seq, me) ? state.last_read_seq : null };
  }
  const markSeq = dividerMark.current?.parentId === parentId ? dividerMark.current.seq : null;
  const firstUnread = markSeq !== null ? firstUnreadRow(replies, markSeq, me)?.id : undefined;
  // M47 「連続した投稿をまとめる」: replies group by the timeline's rule; the parent above always has its picture, and
  // 「新しい返信」 starts a new run.
  const group = controller.groupPosts;
  const unseen = unseenBelow(replies, seenSeq, me);

  return (
    <aside className="flex min-h-0 w-full min-w-0 flex-col border-l border-line bg-canvas max-md:border-l-0">
      <header className="flex h-[52px] items-center gap-2 border-b border-line px-4">
        <PaneBackButton onClick={onClose} />
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold">{t("nav.threads")}</div>
          <div className="truncate text-xs text-muted">{channelTitle(channel, controller)}</div>
        </div>
        {state && channel.isMember && !rootDeleted && (
          <Button
            size="sm"
            variant={state.following ? "secondary" : "ghost"}
            title={state.following ? t("thread.unfollowTitle") : t("thread.followTitle")}
            aria-pressed={state.following}
            onClick={() => void engine?.setThreadFollow(parentId, !state.following).catch((error) => controller.setError(error))}
          >
            {state.following ? <BellRing size={14} /> : <Bell size={14} />}
            {state.following ? t("thread.following") : t("thread.follow")}
          </Button>
        )}
        {/* M65: 「このスレッドを要約」 (docs/AI.md §6), only to the one who asks. */}
        {parent && !parent.pending && parent.seq !== null && !parent.parent_id && channel.isMember && summaryAvailable(controller) && (
          <Menu>
            <MenuTrigger asChild>
              <button type="button" aria-label={t("thread.actions")} title={t("thread.actions")} className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-ink transition-colors hover:bg-ink/6">
                <MoreHorizontal size={18} />
              </button>
            </MenuTrigger>
            <MenuContent align="end">
              <SummaryChoices controller={controller} channelId={channel.id} choices={[{ label: t("thread.summarize"), target: { channelId: channel.id, scope: "thread", threadId: parentId } }]} />
            </MenuContent>
          </Menu>
        )}
        <PaneCloseButton onClick={onClose} />
      </header>
      <div className="relative flex min-h-0 flex-1 flex-col">
      {/* Chromium's own scroll anchoring is off: the pane anchors itself, the same on every engine (scrollAnchor.ts). */}
      <div data-message-list data-chat-focus tabIndex={-1} aria-label={t("preview.threadList")} ref={list} className="min-h-0 flex-1 overflow-y-auto px-3 py-2 [overflow-anchor:none]" {...tapHandlers}>
        <div ref={content}>
        {parent ? (
          <>
            <MessageRow thread message={parent} controller={controller} />
            <div className="my-2 flex items-center gap-2 text-xs text-muted">
              <span className="whitespace-nowrap">{replies.length === 0 ? t("preview.noReplies") : t("timeline.replyCount", { count: replies.length })}</span>
              <span className="h-px flex-1 bg-line" />
            </div>
            <div data-replies="">
              {replies.map((reply, index) => (
                <div key={rowKey(reply)}>
                  {reply.id === firstUnread && (
                    <div ref={divider} className="my-1 flex items-center gap-2 text-[11px] font-semibold text-rose-500">
                      <span className="h-px flex-1 bg-rose-400/70" />
                      {t("thread.newReplies")}
                    </div>
                  )}
                  <MessageRow thread message={reply} controller={controller} compact={group && index > 0 && reply.id !== firstUnread && continuesGroup(replies[index - 1]!, reply)} />
                </div>
              ))}
            </div>
          </>
        ) : (
          <div className="py-8 text-center text-sm text-muted">{rootDeleted ? t("thread.rootDeleted") : t("preview.messageMissing")}</div>
        )}
        </div>
      </div>
      {parent && showJump && (
        <JumpToLatestButton
          label={unseen > 0 ? t("thread.newCount", { count: unseen }) : t("thread.toLatest")}
          highlighted={unseen > 0}
          onClick={() => {
            anchor.toBottom();
            measureJump();
          }}
        />
      )}
      </div>
      {parent && channel.isMember && !channel.archived && <Composer key={parentId} controller={controller} channel={channel} parentId={parentId} placeholder={t("thread.replyPlaceholder")} />}
      {parent && channel.isMember && !channel.archived && <TypingIndicator controller={controller} channelId={channel.id} parentId={parentId} />}
    </aside>
  );
}
