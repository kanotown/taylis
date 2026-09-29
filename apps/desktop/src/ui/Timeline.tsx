import { AlarmClock, ArrowDown, AtSign, Bookmark, BookmarkCheck, CheckCheck, Forward, Hash, Link, Lock, Mail, MessageSquare, MessagesSquare, Pencil, Pin, PinOff, SmilePlus, Trash2, Users } from "lucide-react";
import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import type { ApiClient } from "../api/client";
import type { AppController } from "../state/app";
import type { SyncEngine } from "../sync/engine";
import type { Store } from "../sync/store";
import { caughtUp, covers, dividerMark, firstUnreadRow, jumpButtonShown, markUnreadOffered, nextAnchored, passedUnseen, readRangeReady } from "../sync/readGate";
import type { ChannelState, MessageState } from "../sync/types";
import { keyboardUp, tapClosesKeyboard } from "../platform/viewport";
import { AttachmentList } from "./Attachments";
import { messageRowKey } from "./messageKeyboard";
import { Avatar } from "./Avatar";
import { ackLine, bannerText, buildTimeline, fullTimestamp, rowKey, timeLabel } from "./format";
import { decodeMentions, encodeMentions, mentionsToNames } from "./mentions";
import { plainText } from "./markdown";
import { MessageBody } from "./MessageBody";
import { PollCard, pollHidesBody } from "./PollCard";
import { PriorityLabel } from "./PriorityLabel";
import { RevisionsDialog } from "./RevisionsDialog";
import { ShareDialog } from "./ShareDialog";
import { isSendKey, sendKeyLabel } from "./prefs";
import { Button, cn, IconButton, Input, Kbd, PopoverContent, PopoverRoot, PopoverTrigger, Textarea } from "./primitives";
import { StatusEmoji, UserPopover } from "./UserPopover";
import { channelTitle } from "./MainScreen";
import { EmojiPicker, rememberEmoji, useRecentEmoji } from "./EmojiPicker";
import { LinkPreviewCard } from "./LinkPreviewCard";
import { LONG_PRESS_MS, MessageActionsSheet, quickReactions } from "./MessageActionsSheet";
import { firstLink } from "./links";
import { CustomEmojiImage, customEmojiName } from "./customEmoji";
import { parsePermalink } from "./permalink";
import { reminderPresets, scheduleLabel, toLocalInput } from "./schedule";
import { READER_BACK } from "../platform/idle";
import { AcksDialog, ReactionsDialog } from "./WhoDialogs";


export function Timeline({ controller, channel, onOpenThread }: { controller: AppController; channel: ChannelState; onOpenThread?: (id: string) => void }) {
  const store = controller.store;
  const engine = controller.engine;
  const focus = controller.messageFocus?.channelId === channel.id ? controller.messageFocus : null;
  const messages: MessageState[] = focus ? focus.context.map((m) => { const cached = store.message(channel.id, m.id); return cached && cached.updated_seq >= m.updated_seq ? cached : m; }).filter((m) => !m.deleted) : store.messages(channel.id);
  const me = store.me;
  const container = useRef<HTMLDivElement>(null);
  const bottom = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);
  /** When the reader last dragged, wheeled or keyed on the list: scrolls long after that are not theirs. */
  const readerInputAt = useRef(0);
  /** Until when the end is held after the keyboard came or went (the input and the list settle their heights). */
  const holdEndUntil = useRef(0);
  const [tapHandlers] = useState(() => tapClosesKeyboard());
  const [showJump, setShowJump] = useState(false);
  // Newest seq the reader has had on screen at the bottom; messages above it from others are "new".
  const [seenSeq, setSeenSeq] = useState(channel.lastReadSeq);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const anchor = useRef<{ height: number; top: number } | null>(null);

  // The "new messages" divider stays where it was when the channel was opened, or the search context was left (that
  // works like opening, §10.1 4.), or 「最初の未読へ」 reached it.
  const markKey = `${channel.id}:${focus?.messageId ?? ""}`;
  const unreadMark = useRef<{ key: string; seq: number | null }>({ key: "", seq: null });
  if (unreadMark.current.key !== markKey) {
    unreadMark.current = { key: markKey, seq: channel.unreadCount > 0 ? channel.lastReadSeq : null };
  }
  const heldUnread = engine?.unreadHold.get(channel.id);
  // §10.1: drawn only when the loaded range reaches it (above the oldest loaded row it would be a lie); never
  // in a search context.
  const mark = focus ? null : dividerMark(heldUnread, unreadMark.current.seq, channel.oldestLoadedSeq);
  // Rebuilt when the rows, the divider or the day change, not on every render of the app (M21).
  const today = new Date().toDateString();
  const items = useMemo(() => buildTimeline(messages, { firstUnreadAfterSeq: mark, meId: me?.id ?? null }), [messages, mark, me?.id, today]);
  // The rows are memoized (M21): one function for the life of the view, calling the latest prop (MainScreen passes a new
  // one on every render).
  const openThreadRef = useRef(onOpenThread);
  openThreadRef.current = onOpenThread;
  const [openThread] = useState(() => (id: string) => openThreadRef.current?.(id));
  const last = messages[messages.length - 1];
  const lastId = last ? rowKey(last) : undefined;
  const maxSeq = messages.reduce((max, m) => (m.seq !== null && m.seq > max ? m.seq : max), 0);
  const unseenBelow = focus ? 0 : messages.filter((m) => m.seq !== null && m.seq > seenSeq && m.sender_id !== me?.id).length;
  const markSeen = () => {
    if (maxSeq > seenSeq) setSeenSeq(maxSeq);
  };

  const positioned = useRef(false);
  const [isPositioned, setIsPositioned] = useState(false);
  /** Newest seq present when the view last positioned itself or followed new rows. */
  const followedSeq = useRef(0);
  /** The last row when the view positioned itself, until the follow effect below has seen that commit. */
  const openedWith = useRef<{ lastId: string | undefined } | null>(null);
  /**
   * §10.1 2.: the read position just went down. Rows already on screen must not undo that, so visible rows read nothing
   * until the view really changes: the reader's own input, rows added, the window back in front, the connection. The
   * banner appearing is no such change (it shrinks the scroller, and a reader at the bottom is kept there).
   */
  const quiet = useRef(false);
  const divider = useRef<HTMLDivElement>(null);
  // §10.1 anchored: the first unread row has been on screen since this view opened (or nothing is unread).
  // Visible rows mark read only then: rows loaded above the viewport were never shown.
  const anchoredRef = useRef(false);
  const [anchored, setAnchoredState] = useState(false);
  const setAnchored = (value: boolean) => {
    anchoredRef.current = value;
    setAnchoredState(value);
  };
  /** Re-evaluated from the latest rows and channel state, taken at the same moment (§10.1 2.); `seen` is the screen. */
  const reanchor = (seen: ScreenRows = NOTHING_SEEN): boolean => {
    const current = store.getChannel(channel.id) ?? channel;
    const first = firstUnreadRow(store.messages(channel.id), current.lastReadSeq, me?.id);
    const next = nextAnchored(anchoredRef.current, current.unreadCount, readRangeReady(current), first, seen.shown, passedUnseen(first, seen.seqs, seen.partly));
    if (next !== anchoredRef.current) setAnchored(next);
    return next;
  };
  /** The first unread row at the top, with 「新着メッセージ」 above it on screen when the divider precedes it (SYNC_PROTOCOL.md §10.1 4.). */
  const showFromRow = (row: MessageState) => {
    const element = document.getElementById(`timeline-${row.id}`);
    const before = divider.current && divider.current.nextElementSibling === element ? divider.current : element;
    before?.scrollIntoView({ block: "start" });
  };
  // The channel whose 「最初の未読へ」 is loading (the view outlives channel switches).
  const [jumping, setJumping] = useState<string | null>(null);
  const jumpingFor = useRef<string | null>(null);
  const [jumpRequest, setJumpRequest] = useState(0);
  const shownChannel = useRef(channel.id);
  shownChannel.current = channel.id;
  const shownFocus = useRef(focus);
  shownFocus.current = focus;
  const content = useRef<HTMLDivElement>(null);
  const holdingEnd = () => Date.now() < holdEndUntil.current && Date.now() - readerInputAt.current > 800;
  // Scroll the container itself (scrollIntoView would also move scrollable ancestors).
  const scrollToBottom = () => {
    const el = container.current;
    if (el) el.scrollTop = el.scrollHeight;
  };
  /** From where the view is now: at the bottom (everything loaded counts as seen) and the bottom button. */
  const measureScroll = () => {
    const el = container.current;
    if (!el) return;
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    atBottom.current = distance < 48;
    setShowJump(distance > 240);
    // Before positioning the list sits at its initial place (the bottom): what is below the divider is still new (7.).
    if (atBottom.current && positioned.current) markSeen();
  };
  // Images loading, the composer growing or the window resizing change heights after we positioned:
  // stay pinned to the bottom when the reader was there.
  useEffect(() => {
    const el = container.current;
    const inner = content.current;
    if (!el || !inner || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      if ((atBottom.current || holdingEnd()) && positioned.current && !anchor.current) scrollToBottom();
    });
    observer.observe(el);
    observer.observe(inner);
    // The keyboard coming or going on a phone: at the end, the list stays at the end while things settle.
    const viewport = window.visualViewport;
    const keyboardMoved = () => {
      if (atBottom.current && positioned.current) holdEndUntil.current = Date.now() + 700;
    };
    viewport?.addEventListener("resize", keyboardMoved);
    return () => {
      observer.disconnect();
      viewport?.removeEventListener("resize", keyboardMoved);
    };
  }, []);
  // Input of the reader's own on the list (not scrolling done by the view, nor the banner resizing it).
  useEffect(() => {
    const el = container.current;
    if (!el) return;
    const input = (event: Event) => {
      quiet.current = false;
      // Scrolling input only: a tap (that may close the keyboard) does not move the list.
      if (event.type !== "pointerdown") readerInputAt.current = Date.now();
    };
    const events = ["wheel", "touchmove", "pointerdown", "keydown"] as const;
    for (const name of events) el.addEventListener(name, input, { passive: true });
    return () => {
      for (const name of events) el.removeEventListener(name, input);
    };
  }, []);
  const markVisible = () => {
    const el = container.current;
    // Not while 「最初の未読へ」 loads either: the view is about to land elsewhere (§10.1 4.).
    if (!el || focus || !positioned.current || quiet.current || jumpingFor.current === channel.id || !document.hasFocus()) return;
    const seen = screenRows(el, "article[data-seq]", "timeline-");
    const nowAnchored = reanchor(seen);
    const seq = Math.max(0, ...seen.seqs);
    if (nowAnchored && seq > 0) engine?.markRead(channel.id, seq);
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
    setIsPositioned(false);
    setAnchored(false);
    quiet.current = false;
    atBottom.current = false;
    setSeenSeq(channel.lastReadSeq);
  }, [channel.id, focus?.messageId]);

  // Once per open (or focus change): the search hit centred; else the divider and the row after it at the top, so
  // the reader starts where unread starts (anchored at once, no banner flash); else the newest message (§10.1).
  useLayoutEffect(() => {
    // Not on my placeholders alone (a failed send is kept): the rows they follow have not arrived yet.
    if (positioned.current || messages.length === 0 || (!focus && channel.oldestLoadedSeq === null)) return;
    const unread = !focus && mark !== null ? firstUnreadRow(messages, mark, me?.id) : null;
    const target = focus ? (focus.parentId ?? focus.messageId) : unread?.id;
    if (unread) showFromRow(unread);
    else if (target) document.getElementById(`timeline-${target}`)?.scrollIntoView({ block: "center" });
    else scrollToBottom();
    positioned.current = true;
    followedSeq.current = maxSeq;
    openedWith.current = { lastId };
    setIsPositioned(true);
    if (!focus) {
      if (target) setAnchored(true);
      else reanchor();
    }
    const el = container.current;
    atBottom.current = !!el && el.scrollHeight - el.scrollTop - el.clientHeight < 48;
    setShowJump(!atBottom.current);
    if (atBottom.current) markSeen();
  }, [channel.id, focus?.messageId, messages.length]);

  // New messages while at the bottom, and a top-level post sent from this device, show the newest message. A layout
  // effect, so the ResizeObserver never pins the bottom first. Only that post reads the channel (§10.1 11.), so only it
  // may carry the view past rows from others; my replies (also sent to the channel), my posts from other devices and
  // scheduled sends follow like anyone's. A poll (postedHere) is followed whichever comes first, its row or the answer
  // that names it: the effect runs again when the name arrives after the row.
  useLayoutEffect(() => {
    const since = followedSeq.current;
    followedSeq.current = maxSeq;
    // The commit that opened the view (or left the search context) placed it already: following too would carry it from
    // the divider to the bottom whenever my own placeholder (a failed send stays one) is the last row.
    const opened = openedWith.current !== null && openedWith.current.lastId === lastId;
    openedWith.current = null;
    const last = messages[messages.length - 1];
    // A poll made here is such a post too, though it skips the send queue (no placeholder).
    const mine = !!last && last.sender_id === me?.id && !last.parent_id && (last.pending === true || last.id === controller.postedHere);
    if (opened || focus || !positioned.current || !(atBottom.current || mine)) return;
    scrollToBottom();
    // A batch taller than the screen (the catch-up after reconnecting, or when a held channel opens) would put its
    // unread rows above the viewport unseen, and reading at the bottom would then skip them: its first unread row
    // goes to the top instead, as on opening (§10.1). Only when every row after the mark is held: after a §7.3 reload
    // the oldest row loaded is no place to start (「以前を読み込む」 would run at once above it), so the view stays at
    // the bottom and rule 2 and the banner take over.
    const current = store.getChannel(channel.id) ?? channel;
    const after = Math.max(since, current.lastReadSeq);
    const first = mine || !covers(current.oldestLoadedSeq, after) ? null : firstUnreadRow(messages, after, me?.id);
    const row = first ? document.getElementById(`timeline-${first.id}`) : null;
    const el = container.current;
    if (first && row && el && row.getBoundingClientRect().top < el.getBoundingClientRect().top) {
      showFromRow(first);
      measureScroll();
      // A landing (§10.1 4.): when that row is the first unread one and the range is ready, anchored now, as when
      // opening. Rows and channel state both taken live (§10.1 2.).
      if (readRangeReady(current) && firstUnreadRow(store.messages(channel.id), current.lastReadSeq, me?.id)?.id === first.id) setAnchored(true);
      return;
    }
    atBottom.current = true;
    markSeen();
  }, [lastId, controller.postedHere]);

  const reloads = engine?.reloadCount(channel.id) ?? 0;
  const status = engine?.status;
  /** The channel and the view as the effect below last saw them. */
  const lastSeen = useRef({ channelId: channel.id, lastReadSeq: channel.lastReadSeq, held: heldUnread, reloads, rows: messages.length, status });
  useEffect(() => {
    const before = lastSeen.current;
    lastSeen.current = { channelId: channel.id, lastReadSeq: channel.lastReadSeq, held: heldUnread, reloads, rows: messages.length, status };
    const same = before.channelId === channel.id;
    // §10.1 2.: the position went down (another device's 「ここから未読にする」, a lower bootstrap value) or a hold ended
    // without a read. Rows already on screen must not undo that: this evaluation sends nothing, and neither does any
    // until the view changes (quiet above).
    const lowered = same && (channel.lastReadSeq < before.lastReadSeq || (before.held !== undefined && heldUnread === undefined && channel.lastReadSeq <= before.lastReadSeq));
    // A §7.3 reload replaced the rows, perhaps with no evaluation while they were gone (in the background).
    const reloaded = same && reloads !== before.reloads;
    if (before.rows !== messages.length || before.status !== status) quiet.current = false;
    if (lowered) quiet.current = true;
    // A read.updated or the catch-up can make the range stop reaching the read position: anchored drops then too,
    // even while the window is in the background.
    if (positioned.current && !focus) {
      if (lowered || reloaded) setAnchored(false);
      else reanchor();
    }
    markVisible();
    const backInFront = () => {
      quiet.current = false;
      markVisible();
    };
    window.addEventListener("focus", backInFront);
    window.addEventListener(READER_BACK, backInFront);
    return () => {
      window.removeEventListener("focus", backInFront);
      window.removeEventListener(READER_BACK, backInFront);
    };
  }, [channel.id, channel.lastSeq, channel.syncedSeq, channel.lastReadSeq, channel.unreadCount, channel.oldestLoadedSeq, status, focus?.messageId, messages.length, heldUnread, reloads]);

  // 「最初の未読へ」 (§10.1): page back until the range reaches the read position, then start there like opening.
  const jumpToFirstUnread = async () => {
    if (!engine || jumping) return;
    const id = channel.id;
    setJumping(id);
    jumpingFor.current = id;
    let reached = false;
    try {
      reached = await engine.loadFirstUnread(id);
    } catch (error) {
      controller.setError(error);
    } finally {
      setJumping(null);
      jumpingFor.current = null;
    }
    if (!reached || shownChannel.current !== id || shownFocus.current) return; // the banner stays; pressing again goes on
    unreadMark.current = { key: `${id}:`, seq: store.getChannel(id)?.lastReadSeq ?? null };
    setJumpRequest((n) => n + 1);
  };
  useLayoutEffect(() => {
    if (jumpRequest === 0 || focus) return;
    const current = store.getChannel(channel.id) ?? channel;
    const at = dividerMark(engine?.unreadHold.get(channel.id), unreadMark.current.seq, current.oldestLoadedSeq);
    const row = at === null ? null : firstUnreadRow(store.messages(channel.id), at, me?.id);
    if (!row || at === null) return;
    showFromRow(row);
    // As when opening there: what follows the divider is new for the bottom button (「新着 N 件」).
    setSeenSeq(at);
    measureScroll();
    setAnchored(true);
    quiet.current = false; // the reader pressed it
    markVisible(); // already there when the row was at the top: no scroll event follows
  }, [jumpRequest]);

  // 「既読にする」: like Esc, the whole conversation regardless of the loaded range.
  const readToEnd = () => {
    const current = store.getChannel(channel.id) ?? channel;
    engine?.markRead(channel.id, current.lastSeq, { force: true });
  };
  const online = engine?.status === "online";
  // Not while a catch-up (connecting or online) is bringing the unread rows and none of them is held yet: the first of
  // them then goes to the top, and a banner would only flash (§10.1 5.).
  const rowsComing = (online || engine?.status === "connecting") && !caughtUp(channel) && firstUnreadRow(messages, channel.lastReadSeq, me?.id) === null;
  // Nor while my top-level post is on its way: it reads the channel when it goes through (§10.1 11.). Following it to the
  // bottom may have dropped the anchor, which stays dropped (rows passed on the way are not read by the view).
  const sending = !!last && last.pending === true && !last.failed && last.sender_id === me?.id && !last.parent_id;
  const showBanner = !!engine && !focus && isPositioned && channel.unreadCount > 0 && !anchored && heldUnread === undefined && !rowsComing && !sending;
  // The banner changes the scroller's height: a reader at the bottom stays there. Before the scroll event that
  // opening at the bottom queued, which would otherwise measure the old bottom and leave the view above it.
  useLayoutEffect(() => {
    if (atBottom.current && positioned.current) scrollToBottom();
  }, [showBanner]);

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
    // Typing at the end on a phone, or the keyboard just came or went: iOS Safari scrolls the list up by what the input
    // grew, to follow the caret, and the input settles its height. Not the reader's scrolls, so the list stays at the
    // end (platform/viewport.ts).
    if ((atBottom.current || holdingEnd()) && positioned.current && (keyboardUp() || holdingEnd())
        && Date.now() - readerInputAt.current > 800 && el.scrollHeight - el.scrollTop - el.clientHeight > 1) {
      scrollToBottom();
      return;
    }
    measureScroll();
    markVisible();
    if (!focus && el.scrollTop < 120 && channel.hasOlder && channel.syncedSeq !== null && !loadingOlder && engine?.status === "online") loadOlder();
  };

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      {/* Above the scroller, not in it: hiding it then only makes the scroller taller and never moves the rows under
          the reader (WebKit has no scroll anchoring), so the first unread row stays at the top (§10.1). */}
      {showBanner && (
        <div className="unread-banner mx-4 mt-2 flex shrink-0 items-center justify-between gap-3 rounded-lg bg-accent-soft px-3 py-2 text-xs text-ink shadow-sm">
          <span className="min-w-0 truncate">{bannerText(channel.unreadCount, channel.firstUnreadAt, new Date())}</span>
          {jumping === channel.id ? (
            <span className="shrink-0 text-muted">読み込み中…</span>
          ) : (
            <span className="flex shrink-0 items-center gap-2">
              {jumpButtonShown(readRangeReady(channel), channel.unreadCount) && (
                <Button variant="link" size="sm" disabled={!online} onClick={() => void jumpToFirstUnread()}>
                  最初の未読へ
                </Button>
              )}
              <Button variant="link" size="sm" disabled={!online} onClick={readToEnd}>
                既読にする
              </Button>
            </span>
          )}
        </div>
      )}
      <div data-message-list data-chat-focus tabIndex={-1} aria-label="メッセージ一覧" className="timeline flex-1 overflow-y-auto px-4 pb-2 pt-2" ref={container} onScroll={onScroll} {...tapHandlers}>
        <div ref={content}>
        {focus && (
          <div className="sticky top-0 z-10 mb-2 flex items-center justify-between rounded-lg bg-accent-soft px-3 py-2 text-xs text-ink shadow-sm">
            <span>検索位置の前後の会話</span>
            {/* The conversation then opens like any other (first unread row or the newest), see the positioning above. */}
            <Button variant="link" size="sm" onClick={() => controller.clearMessageFocus()}>
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
        {!focus && !channel.hasOlder && messages.length > 0 && <ChannelIntro controller={controller} channel={channel} />}
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
              <div key={item.key} ref={divider} className="my-2 flex items-center gap-3 text-xs font-semibold text-rose-500">
                <span className="h-px flex-1 bg-rose-400/70" />
                <span>新着メッセージ</span>
                <span className="h-px flex-1 bg-rose-400/70" />
              </div>
            );
          }
          return <MessageRow key={rowKey(item.message)} controller={controller} message={item.message} compact={item.compact} onOpenThread={onOpenThread ? openThread : undefined} />;
        })}
        <div ref={bottom} />
        </div>
      </div>
      {!focus && showJump && (
        <button
          type="button"
          onClick={() => {
            quiet.current = false; // the reader's own move
            scrollToBottom();
          }}
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

/** What one look at the screen found (§10.1 2.): the rows shown (message ids, §10.3, and seqs), and those at least partly on screen. */
export interface ScreenRows {
  shown: ReadonlySet<string>;
  seqs: readonly number[];
  partly: ReadonlySet<string>;
}

const NOTHING_SEEN: ScreenRows = { shown: new Set(), seqs: [], partly: new Set() };

/** Where typing goes: with it focused, a phone shows its keyboard. */
export function isTextInput(element: Element | null): boolean {
  return element instanceof HTMLTextAreaElement || element instanceof HTMLInputElement || (element instanceof HTMLElement && element.isContentEditable);
}

/**
 * The `selector` rows of a scroller on screen. Shown = the §10 criterion (the bottom edge on screen, and the top edge
 * too unless the row is taller than the screen). Rows are matched by message id (`idPrefix` + id), never by React key.
 */
export function screenRows(scroller: HTMLElement, selector: string, idPrefix: string): ScreenRows {
  const bounds = scroller.getBoundingClientRect();
  const shown = new Set<string>();
  const partly = new Set<string>();
  const seqs: number[] = [];
  for (const row of scroller.querySelectorAll<HTMLElement>(selector)) {
    const box = row.getBoundingClientRect();
    if (box.bottom <= bounds.top || box.top >= bounds.bottom) continue;
    const id = row.id.slice(idPrefix.length);
    partly.add(id);
    // One pixel of slack at both edges: a row scrolled to the top can sit half a pixel above it (fractional row heights).
    if (box.bottom <= bounds.bottom + 1 && (box.top >= bounds.top - 1 || box.height > bounds.height)) {
      shown.add(id);
      seqs.push(Number(row.dataset["seq"]));
    }
  }
  return { shown, seqs, partly };
}

/** The start of a conversation (M11h): what the channel is for, who made it, how many are in it. */
export function ChannelIntro({ controller, channel }: { controller: AppController; channel: ChannelState }) {
  const store = controller.store;
  const isDm = channel.type === "dm" || channel.type === "group_dm";
  const creator = channel.created_by ? store.users.get(channel.created_by)?.display_name : null;
  const created = channel.created_at ? new Date(channel.created_at) : null;
  const title = channelTitle(channel, controller);
  return (
    <div className="mb-3 border-b border-line pb-4 pt-6">
      <div className="flex items-center gap-2 text-xl font-bold">
        {isDm ? <AtSign size={22} className="text-muted" /> : channel.type === "private" ? <Lock size={22} className="text-muted" /> : <Hash size={22} className="text-muted" />}
        {title.replace(/^#/, "")}
      </div>
      <p className="mt-1.5 text-sm text-muted">
        {isDm ? (
          <>{title} との会話の始まりです。</>
        ) : (
          <>
            {creator ? `${creator} が` : ""}
            {created ? `${created.getFullYear()}年${created.getMonth() + 1}月${created.getDate()}日に` : ""}作成した{channel.type === "private" ? "非公開" : "公開"}チャンネルの始まりです。
            {channel.member_count ? ` メンバー ${channel.member_count} 人。` : ""}
          </>
        )}
      </p>
      {(channel.purpose || channel.topic) && <p className="mt-1 text-sm text-ink">{channel.purpose || channel.topic}</p>}
    </div>
  );
}

/**
 * One message with hover actions; shared by the timeline and the thread pane.
 *
 * Reads here everything the row shows besides its message, and the row itself (MessageRowView) is memoized on that
 * (M21): the whole app re-renders on every change of the store (a typing frame, a keystroke in the composer, another
 * channel's unread count), and re-rendering 1,000 rows took 330 ms each time. Messages are replaced, never changed in
 * place (store.upsertMessage), so a changed message is a new object. `rowsVersion` stands for me, the users, the groups
 * and the custom emoji (mutable maps). Anything else a row shows must come in as a prop here, or be subscribed to by the
 * part that shows it (LinkPreviewCard, useAvatarUrl, UserPopover while open, ShareDialog).
 */
export function MessageRow({ controller, message, compact = false, onOpenThread, thread = false, readOnly = false, threadParent }: {
  controller: AppController; message: MessageState; compact?: boolean; onOpenThread?: (id: string) => void; thread?: boolean;
  /**
   * A channel read before joining (SYNC_PROTOCOL.md §7.6.1): the message is only read. No hover bar, no long-press
   * sheet, no reacting, voting or acknowledging (the server refuses them from non-members too).
   */
  readOnly?: boolean;
  /** The parent of a reply also sent to the channel, when it is not in the store (a preview holds its own rows). */
  threadParent?: MessageState;
}) {
  const store = controller.store;
  // §10.1 10.: moving the position forward (past unread rows) only while all of them are held; back always.
  const conversation = store.getChannel(message.channel_id);
  // The quick reactions are the emoji I used last (M25): a pick in any row changes them in every row, so they come in
  // as a prop (the memoized row would otherwise keep reading the old three until something else re-rendered it).
  const recentEmoji = useRecentEmoji();
  return (
    <MessageRowView
      controller={controller}
      message={message}
      compact={compact}
      onOpenThread={onOpenThread}
      thread={thread}
      store={store}
      engine={controller.engine}
      api={controller.api}
      rowsVersion={store.rowsVersion}
      recentEmoji={recentEmoji}
      editing={controller.editing === message.id}
      highlighted={controller.messageFocus?.messageId === message.id}
      saved={store.isBookmarked(message.id)}
      isAdmin={controller.isAdmin}
      // M15c: a reply also sent to the channel names its thread in the timeline and opens it.
      threadParent={!thread && message.parent_id ? (store.getMessage(message.channel_id, message.parent_id) ?? threadParent) : undefined}
      unreadOffered={!readOnly && !thread && message.seq !== null && !message.pending && !!conversation && markUnreadOffered(message.seq, conversation)}
      readOnly={readOnly}
    />
  );
}

interface MessageRowViewProps {
  controller: AppController;
  message: MessageState;
  compact: boolean;
  onOpenThread: ((id: string) => void) | undefined;
  thread: boolean;
  store: Store;
  engine: SyncEngine | null;
  api: ApiClient | null;
  /** Only compared (the row re-renders when it moves): the row reads the maps it stands for from `store`. */
  rowsVersion: number;
  /** The emoji I used last, newest first (EmojiPicker): the quick reactions of the hover bar and the pickers' 「最近」. */
  recentEmoji: string[];
  editing: boolean;
  highlighted: boolean;
  saved: boolean;
  isAdmin: boolean;
  threadParent: MessageState | undefined;
  unreadOffered: boolean;
  readOnly: boolean;
}

const MessageRowView = memo(function MessageRowView({ controller, message, compact, onOpenThread, thread, store, engine, api, recentEmoji, editing, highlighted, saved, isAdmin, threadParent, unreadOffered, readOnly }: MessageRowViewProps) {
  const me = store.me;
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [remindOpen, setRemindOpen] = useState(false);
  const [remindAt, setRemindAt] = useState(() => toLocalInput(new Date(Date.now() + 60 * 60_000)));
  // M12e: a note on the reminder (the API's `note`, as on Android); sent with a preset or the chosen time.
  const [remindNote, setRemindNote] = useState("");
  const remind = (at: Date) => {
    setRemindOpen(false);
    void controller.setReminder(message.id, at, remindNote.trim() || null);
    setRemindNote("");
  };
  const [pickerOpen, setPickerOpen] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);
  const [revisionsOpen, setRevisionsOpen] = useState(false);
  const [chipPicker, setChipPicker] = useState(false);
  // M27 「リアクションした人」: from the long-press sheet on a phone, from the hover bar with a mouse.
  const [reactionsOpen, setReactionsOpen] = useState(false);
  // M25: the long-press sheet on touch screens (a mouse has the hover bar), and where it opens.
  const [sheet, setSheet] = useState<"actions" | "emoji" | null>(null);
  const press = useRef<{ timer: number; x: number; y: number } | null>(null);
  /** The press became a long press: the finger lifting must not tap the sheet item now under it. */
  const pressed = useRef(false);
  /** The keyboard was up when the finger came down: that tap only closes it (as on iOS / Android). */
  const typing = useRef(false);
  const cancelPress = () => {
    if (press.current) window.clearTimeout(press.current.timer);
    press.current = null;
  };
  const touchScreen = () => typeof window.matchMedia === "function" && window.matchMedia("(hover: none)").matches;

  const sender = store.users.get(message.sender_id);
  const senderName = sender?.display_name ?? (message.pending ? me?.display_name : undefined) ?? "unknown";
  const mine = me?.id === message.sender_id;
  const reactions = message.reactions ?? [];
  const size = thread ? 30 : 36;
  const rawLink = message.body ? firstLink(message.body) : null;
  const link = rawLink && api && parsePermalink(api.baseUrl, rawLink) ? null : rawLink; // our own permalinks get no card
  const pinnedBy = message.pinned_at ? (store.users.get(message.pinned_by ?? "")?.display_name ?? "?") : null;
  const threadId = message.parent_id ?? message.id;
  return (
    <article
      key={rowKey(message)}
      id={`${thread ? "thread" : "timeline"}-${message.id}`}
      data-seq={message.seq ?? undefined}
      tabIndex={0}
      aria-keyshortcuts="ArrowUp ArrowDown Home End Enter Shift+F10 ArrowRight T"
      onKeyDown={(event) => messageRowKey(event, !message.pending && !message.deleted && onOpenThread ? () => onOpenThread(threadId) : undefined)}
      className={cn(
        "message group relative -mx-2 grid gap-x-2.5 rounded-lg px-2 outline-none transition-colors hover:bg-panel focus-visible:ring-2 focus-visible:ring-accent/40",
        thread ? "grid-cols-[30px_minmax(0,1fr)]" : "grid-cols-[36px_minmax(0,1fr)]",
        compact ? "py-1" : "mt-1 py-1.5",
        highlighted && "highlighted",
        message.pending && "opacity-60",
        message.failed && "opacity-100 shadow-[inset_3px_0_0_var(--danger)]",
      )}
      title={compact ? fullTimestamp(message.created_at) : undefined}
      onClick={(event) => {
        // A dialog this row opened (who reacted, who confirmed …) sits in a portal: React still bubbles its clicks and
        // touches here, but they are not on the message.
        if (!event.currentTarget.contains(event.target as Node)) return;
        // Alt+click marks the conversation unread from this message (Mattermost).
        if (event.altKey && unreadOffered) engine?.markUnread(message.channel_id, message.seq!);
        // On a phone a tap on a message opens its thread, to read or to reply (Slack; testers, 2026-09-29), unless it was
        // on a link, a button or an image of the message, or the keyboard was up (the tap closes it).
        else if (touchScreen() && onOpenThread && !message.pending && !typing.current && !(event.target as HTMLElement).closest("a, button, input, textarea, img, video, [role=button]")) {
          // The tap focused the row, and a focused row shows its actions: on a phone they float over the screen
          // (styles.css) and would cover the thread's reply box. Unfocused first, so they go as the thread opens.
          event.currentTarget.blur();
          onOpenThread(threadId);
        }
      }}
      onTouchStart={(event) => {
        if (!event.currentTarget.contains(event.target as Node)) return; // in a dialog of this row (above)
        typing.current = isTextInput(document.activeElement);
        if (message.pending || readOnly || !touchScreen() || event.touches.length !== 1) return;
        const touch = event.touches[0]!;
        cancelPress();
        press.current = {
          x: touch.clientX,
          y: touch.clientY,
          timer: window.setTimeout(() => {
            press.current = null;
            pressed.current = true;
            (document.activeElement as HTMLElement | null)?.blur?.(); // the keyboard goes, as on iOS / Android
            navigator.vibrate?.(10);
            setSheet("actions");
          }, LONG_PRESS_MS),
        };
      }}
      onTouchMove={(event) => {
        const touch = event.touches[0];
        if (press.current && touch && Math.hypot(touch.clientX - press.current.x, touch.clientY - press.current.y) > 10) cancelPress();
      }}
      onTouchEnd={(event) => {
        cancelPress();
        if (pressed.current) event.preventDefault(); // no click from this touch
        pressed.current = false;
      }}
      onTouchCancel={cancelPress}
      onContextMenu={(event) => { if (touchScreen()) event.preventDefault(); }}
    >
      <div className="flex justify-center pt-0.5">
        {compact ? (
          // Grouped under the previous message: its time, faint, where the avatar would be, so where one message ends
          // and the next begins shows (testers, 2026-09-28; the same on iOS and Android).
          <span className="pt-1 text-[11px] leading-4 text-muted tabular-nums">{timeLabel(message.created_at)}</span>
        ) : (
          <UserPopover controller={controller} userId={message.sender_id} className="rounded-lg">
            <Avatar id={message.sender_id} name={senderName} size={size} />
          </UserPopover>
        )}
      </div>
      <div className="min-w-0">
        {!thread && message.parent_id && (
          <button type="button" className="mb-0.5 flex max-w-full items-center gap-1 text-left text-[11px] text-muted hover:text-ink" onClick={() => onOpenThread?.(threadId)}>
            <MessageSquare size={11} className="shrink-0" />
            <span className="shrink-0">スレッドに返信:</span>
            <span className="truncate">{threadParent ? plainText(mentionsToNames(threadParent.body, store.users, store.groups), 80) || "(添付ファイル)" : "元のメッセージ"}</span>
          </button>
        )}
        {thread && message.parent_id && message.also_in_channel && (
          <div className="mb-0.5 text-[11px] text-muted">チャンネルにも送信済み</div>
        )}
        {message.priority && <PriorityLabel priority={message.priority} className="mb-1" />}
        {(pinnedBy || saved) && (
          <div className="mb-0.5 flex items-center gap-3 text-[11px] text-muted">
            {pinnedBy && (
              <span className="inline-flex items-center gap-1 text-warning" title={message.pinned_at ? fullTimestamp(message.pinned_at) : undefined}>
                <Pin size={11} /> {pinnedBy} がピン留め
              </span>
            )}
            {saved && (
              <span className="inline-flex items-center gap-1 text-accent">
                <BookmarkCheck size={11} /> 保存済み
              </span>
            )}
          </div>
        )}
        {!compact && (
          <div className="flex items-baseline gap-2 text-xs text-muted">
            <UserPopover controller={controller} userId={message.sender_id} className="hover:underline">
              <strong className="text-sm text-ink">{senderName}</strong>
            </UserPopover>
            {sender?.role === "bot" && <span className="rounded bg-panel-2 px-1 text-[10px] font-bold text-muted" title="受信 Webhook の投稿">BOT</span>}
            <StatusEmoji controller={controller} userId={message.sender_id} />
            <time title={fullTimestamp(message.created_at)}>{timeLabel(message.created_at)}</time>
            {message.edited_at &&
              (mine && !readOnly ? (
                <button type="button" className="hover:text-ink hover:underline" title="編集履歴を見る" onClick={() => setRevisionsOpen(true)}>
                  (編集済み)
                </button>
              ) : (
                <span title={fullTimestamp(message.edited_at)}>(編集済み)</span>
              ))}
          </div>
        )}
        {editing ? (
          <MessageEditor controller={controller} message={message} />
        ) : (
          <>
            {message.body && !pollHidesBody(message) && (
              <MessageBody body={message.body} users={store.users} internalBase={api?.baseUrl} onOpenMessage={(id) => void controller.openPermalink(id)} customEmoji={store.customEmoji} controller={controller} keywords={store.me?.notify_keywords} groups={store.groups} />
            )}
            <AttachmentList attachments={message.attachments ?? []} controller={controller} />
            {!message.pending && link && <LinkPreviewCard controller={controller} url={link} />}
          </>
        )}
        {message.failed && (
          <div className="mt-1 flex items-center gap-2 text-xs text-danger">
            送信に失敗しました
            <Button variant="link" size="sm" onClick={() => message.client_msg_id && void engine?.retryFailed(message.client_msg_id)}>再送</Button>
            <Button variant="link" size="sm" onClick={() => message.client_msg_id && engine?.discardFailed(message.client_msg_id)}>破棄</Button>
          </div>
        )}
        {message.poll && <PollCard poll={message.poll} message={message} controller={controller} readOnly={readOnly} />}
        {message.ack_requested && !message.pending && <AckBar controller={controller} message={message} readOnly={readOnly} />}
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
              const chip = cn(
                "inline-flex h-6 items-center gap-1 rounded-full border px-2 text-xs transition-colors",
                reacted ? "border-accent bg-accent-soft text-ink" : "border-line bg-panel text-ink",
                !readOnly && !reacted && "hover:border-accent/50",
              );
              const content = (
                <>
                  <span>{(() => { const name = customEmojiName(reaction.emoji); const custom = name ? store.customEmoji.get(name) : undefined; return custom ? <CustomEmojiImage controller={controller} emoji={custom} size={16} /> : reaction.emoji; })()}</span>
                  <span className="font-medium">{reaction.count}</span>
                </>
              );
              // Read before joining: the names still show on hover, but nothing toggles.
              return readOnly ? (
                <span key={reaction.emoji} title={names} className={chip}>{content}</span>
              ) : (
                <button key={reaction.emoji} type="button" title={names} onClick={() => void controller.toggleReaction(message, reaction.emoji)} className={chip}>
                  {content}
                </button>
              );
            })}
            {/* M25: add another reaction right there (the picker on a mouse, the sheet's picker on a phone). */}
            {!readOnly && <PopoverRoot open={chipPicker} onOpenChange={(open) => { if (open && touchScreen()) setSheet("emoji"); else setChipPicker(open); }}>
              <PopoverTrigger asChild>
                <button type="button" aria-label="リアクションを追加" title="リアクションを追加" className="inline-flex h-6 items-center rounded-full border border-line bg-panel px-1.5 text-muted hover:border-accent/50 hover:text-ink">
                  <SmilePlus size={14} />
                </button>
              </PopoverTrigger>
              <PopoverContent align="start" className="w-auto p-3">
                <EmojiPicker
                  recent={recentEmoji}
                  custom={[...store.customEmoji.values()]}
                  controller={controller}
                  onPick={(entry) => {
                    setChipPicker(false);
                    rememberEmoji(entry.glyph);
                    void controller.toggleReaction(message, entry.glyph);
                  }}
                />
              </PopoverContent>
            </PopoverRoot>}
          </div>
        )}
      </div>
      {!message.pending && !readOnly && (
        <div className={cn("row-actions pointer-events-none absolute -top-3.5 right-2 flex items-center gap-0.5 rounded-lg border border-line bg-canvas p-0.5 opacity-0 shadow-md transition-opacity", (pickerOpen || confirmDelete) && "pointer-events-auto opacity-100")}>
          {/* The three I used last (then the defaults), as the phone sheet's six (M25); the rest is in the picker. */}
          {quickReactions(recentEmoji, 3).map((emoji) => (
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
            <PopoverContent align="end" className="w-auto p-3">
              <EmojiPicker
                recent={recentEmoji}
                custom={[...store.customEmoji.values()]}
                controller={controller}
                onPick={(entry) => {
                  setPickerOpen(false);
                  rememberEmoji(entry.glyph);
                  void controller.toggleReaction(message, entry.glyph);
                }}
              />
            </PopoverContent>
          </PopoverRoot>
          {reactions.length > 0 && (
            <IconButton label="リアクションした人" className="h-7 w-7 text-muted hover:text-ink" onClick={() => setReactionsOpen(true)}>
              <Users size={15} />
            </IconButton>
          )}
          {onOpenThread && (
            <IconButton label="スレッドで返信" className="h-7 w-7 text-muted hover:text-ink" onClick={() => onOpenThread(threadId)}>
              <MessageSquare size={15} />
            </IconButton>
          )}
          <IconButton label="リンクをコピー" className="h-7 w-7 text-muted hover:text-ink" onClick={() => void controller.copyPermalink(message.id)}>
            <Link size={15} />
          </IconButton>
          <IconButton label="別のチャンネルに共有" className="h-7 w-7 text-muted hover:text-ink" onClick={() => setShareOpen(true)}>
            <Forward size={15} />
          </IconButton>
          <PopoverRoot open={remindOpen} onOpenChange={setRemindOpen}>
            <PopoverTrigger asChild>
              <button type="button" title="リマインド" aria-label="リマインド" className="flex h-7 w-7 items-center justify-center rounded-md text-muted hover:bg-panel-2 hover:text-ink">
                <AlarmClock size={15} />
              </button>
            </PopoverTrigger>
            <PopoverContent align="end" className="w-72 p-3">
              <div className="mb-2 text-xs font-semibold text-muted">リマインド</div>
              <Input value={remindNote} maxLength={200} placeholder="メモ (任意)" aria-label="リマインドのメモ" className="mb-2 h-9 text-sm" onChange={(e) => setRemindNote(e.target.value)} />
              <ul className="space-y-0.5">
                {reminderPresets().map((preset) => (
                  <li key={preset.key}>
                    <button type="button" className="flex w-full items-center justify-between rounded-md px-2 py-1.5 text-left text-sm hover:bg-panel" onClick={() => remind(preset.at)}>
                      <span>{preset.label}</span>
                      <span className="text-xs text-muted">{scheduleLabel(preset.at.toISOString())}</span>
                    </button>
                  </li>
                ))}
              </ul>
              {/* Finger-sized on a touch screen (the hover bar floats there too, styles.css). */}
              <div className="mt-2 flex items-center gap-2 border-t border-line pt-2">
                <input type="datetime-local" value={remindAt} aria-label="日時を指定" className="h-9 min-w-0 flex-1 rounded-lg border border-line bg-canvas px-2 text-sm" onChange={(e) => setRemindAt(e.target.value)} />
                <Button size="sm" variant="secondary" onClick={() => { const at = new Date(remindAt); if (Number.isNaN(at.getTime()) || at.getTime() < Date.now() + 60_000) { controller.setError("1 分以上先の時刻を選んでください"); return; } remind(at); }}>設定</Button>
              </div>
            </PopoverContent>
          </PopoverRoot>
          <IconButton label={saved ? "保存を解除" : "あとで見る (保存)"} className={cn("h-7 w-7 hover:text-ink", saved ? "text-accent" : "text-muted")} onClick={() => void controller.toggleBookmark(message)}>
            {saved ? <BookmarkCheck size={15} /> : <Bookmark size={15} />}
          </IconButton>
          <IconButton label={message.pinned_at ? "ピン留めを外す" : "チャンネルにピン留め"} className={cn("h-7 w-7 hover:text-ink", message.pinned_at ? "text-warning" : "text-muted")} onClick={() => void controller.togglePin(message)}>
            {message.pinned_at ? <PinOff size={15} /> : <Pin size={15} />}
          </IconButton>
          {unreadOffered && (
            <IconButton label="ここから未読にする (Alt+クリック)" className="h-7 w-7 text-muted hover:text-ink" onClick={() => engine?.markUnread(message.channel_id, message.seq!)}>
              <Mail size={15} />
            </IconButton>
          )}
          {mine && (
            <IconButton label="編集 (空の入力欄で ↑)" className="h-7 w-7 text-muted hover:text-ink" onClick={() => controller.setEditing(message.id)}>
              <Pencil size={15} />
            </IconButton>
          )}
          {(mine || isAdmin) && (
            <PopoverRoot open={confirmDelete} onOpenChange={setConfirmDelete}>
              <PopoverTrigger asChild>
                <button type="button" title="削除" aria-label="削除" className="flex h-7 w-7 items-center justify-center rounded-md text-muted hover:bg-panel-2 hover:text-danger">
                  <Trash2 size={15} />
                </button>
              </PopoverTrigger>
              <PopoverContent align="end" className="w-64 p-3">
                <div className="text-sm font-medium">このメッセージを削除しますか？</div>
                <div className="mt-1 text-xs text-muted">削除したメッセージは元に戻せません。</div>
                <div className="mt-3 flex justify-end gap-2">
                  <Button variant="secondary" size="sm" onClick={() => setConfirmDelete(false)}>
                    キャンセル
                  </Button>
                  <Button variant="danger" size="sm" onClick={() => { setConfirmDelete(false); void controller.deleteMessage(message.id); }}>
                    削除する
                  </Button>
                </div>
              </PopoverContent>
            </PopoverRoot>
          )}
        </div>
      )}
      {shareOpen && <ShareDialog controller={controller} message={message} onClose={() => setShareOpen(false)} />}
      {revisionsOpen && <RevisionsDialog controller={controller} message={message} onClose={() => setRevisionsOpen(false)} />}
      {reactionsOpen && <ReactionsDialog controller={controller} message={message} onClose={() => setReactionsOpen(false)} />}
      {sheet && (
        <MessageActionsSheet
          controller={controller}
          message={message}
          initialView={sheet}
          onClose={() => setSheet(null)}
          onOpenThread={onOpenThread}
          onShare={() => setShareOpen(true)}
          onShowReactions={() => setReactionsOpen(true)}
          unreadOffered={unreadOffered}
          saved={saved}
          isAdmin={isAdmin}
        />
      )}
    </article>
  );
});

/** Inline editor: Enter saves, Esc cancels, focus returns to the composer afterwards. */
function MessageEditor({ controller, message }: { controller: AppController; message: MessageState }) {
  const store = controller.store;
  const [draft, setDraft] = useState(() => decodeMentions(message.body, store.users, store.groups));
  const composing = useRef(false);
  const [saving, setSaving] = useState(false);
  const finish = () => {
    controller.setEditing(null);
    requestAnimationFrame(() => document.querySelector<HTMLTextAreaElement>(".composer textarea")?.focus());
  };
  // Codex audit C4: closed only once the server took the edit; a failure (offline) keeps the text and the editor open.
  const save = async () => {
    const body = encodeMentions(draft.trim(), store.users.values(), store.groups.values());
    if (!body || body === message.body) return finish();
    setSaving(true);
    const saved = await controller.editMessage(message.id, body);
    setSaving(false);
    if (saved) finish();
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
          } else if (isSendKey(e, controller.sendKey ?? "shift-enter") && !e.nativeEvent.isComposing && !composing.current && e.keyCode !== 229) {
            e.preventDefault();
            if (draft.trim() && !saving) void save();
          }
        }}
      />
      <div className="flex items-center gap-2">
        <Button size="sm" onClick={() => void save()} disabled={!draft.trim() || saving}>
          {saving ? "保存中…" : "保存"}
        </Button>
        <Button size="sm" variant="secondary" onClick={finish}>
          キャンセル
        </Button>
        <span className="flex items-center gap-1 text-[11px] text-muted">
          <Kbd>{sendKeyLabel(controller.sendKey ?? "shift-enter").send}</Kbd> 保存 <Kbd>Esc</Kbd> 取り消し
        </span>
      </div>
    </div>
  );
}

/**
 * M15e: 「確認しました」 for readers, and who has acknowledged so far: a few names in the line (M27, 「山田、佐藤 が確認」),
 * all of them, oldest first, a click or a tap away. `readOnly` (a channel read before joining): the names only.
 */
function AckBar({ controller, message, readOnly }: { controller: AppController; message: MessageState; readOnly: boolean }) {
  const store = controller.store;
  const me = store.me;
  const acks = message.acks ?? [];
  const mine = !!me && acks.some((a) => a.user_id === me.id);
  const own = me?.id === message.sender_id;
  const names = acks.map((a) => store.users.get(a.user_id)?.display_name ?? "?");
  const [listOpen, setListOpen] = useState(false);
  return (
    <div className="mt-1.5 flex min-w-0 items-center gap-2 text-xs">
      {!own && !readOnly && (
        <button
          type="button"
          className={cn("inline-flex items-center gap-1 rounded-md border px-2 py-1 font-medium", mine ? "border-accent/40 bg-accent-soft text-accent" : "border-line text-ink hover:bg-panel")}
          onClick={() => void controller.toggleAck(message)}
        >
          <CheckCheck size={13} /> {mine ? "確認済み" : "確認しました"}
        </button>
      )}
      {acks.length > 0 ? (
        <button type="button" className="min-w-0 truncate text-left text-muted hover:text-ink hover:underline" title={names.join("、")} aria-label={`確認した人 (${acks.length} 人)`} onClick={() => setListOpen(true)}>
          {ackLine(names)}
        </button>
      ) : (
        <span className="text-muted">まだ誰も確認していません</span>
      )}
      {listOpen && <AcksDialog controller={controller} message={message} onClose={() => setListOpen(false)} />}
    </div>
  );
}
