import { ArrowDown, AtSign, Bookmark, BookmarkCheck, Hash, Lock, MessageSquare, MessagesSquare, MoreHorizontal, Pencil, Pin, SmilePlus } from "lucide-react";
import { Fragment, memo, Suspense, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import type { ApiClient } from "../api/client";
import type { AppController } from "../state/app";
import type { SyncEngine } from "../sync/engine";
import type { Store } from "../sync/store";
import { caughtUp, covers, dividerMark, firstUnreadRow, jumpButtonShown, markUnreadOffered, nextAnchored, passedUnseen, readRangeReady } from "../sync/readGate";
import type { ChannelState, MessageState } from "../sync/types";
import { keyboardUp, tapClosesKeyboard } from "../platform/viewport";
import { AckBar } from "./AckBar";
import { AttachmentList } from "./Attachments";
import { messageRowKey } from "./messageKeyboard";
import { Avatar } from "./Avatar";
import { linkFromPaste, replaceThroughBrowser } from "./composerEdit";
import { bannerText, buildTimeline, compactNames, dateLabel, fullTimestamp, lastReplyLabel, rowKey, timeLabel } from "./format";
import { decodeMentions, encodeMentions, mentionsToNames } from "./mentions";
import { attachmentText, plainText } from "./markdown";
import { AiBadge } from "./ai";
import { MessageBody } from "./MessageBody";
import { PollCard, pollHidesBody } from "./PollCard";
import { CallCard, callHidesBody } from "./Calls";
import { PriorityLabel } from "./PriorityLabel";
import { WorkflowLabel } from "./WorkflowViews";
import { CollectionChip } from "./RecurringPosts";
import { RevisionsDialog } from "./RevisionsDialog";
import { ShareDialog } from "./ShareDialog";
import { ReportDialog } from "./ModerationDialogs";
import { isSendKey, sendKeyLabel } from "./prefs";
import { isImeKey, LazyRichEditor, type RichEditorApi } from "./richEditorApi";
import { Button, cn, HoverList, IconButton, Input, Kbd, Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger, PopoverAnchor, PopoverContent, PopoverRoot, PopoverTrigger, Textarea } from "./primitives";
import { hoverMenuGroups, type MessageActionKey, messageActions, rowFitsQuickReactions } from "./messageActions";
import { EmojiText, StatusEmoji, UserPopover } from "./UserPopover";
import { channelTitle, myDisplayName } from "./MainScreen";
import { isSelfNotes, selfNotesIntro } from "./channels";
import { intlLocale, t } from "../i18n";
import { EmojiPicker, rememberEmoji, useRecentEmoji } from "./EmojiPicker";
import { autoLinkPreview, LinkPreviewCard } from "./LinkPreviewCard";
import { LONG_PRESS_MS, MessageActionsSheet, quickReactions } from "./MessageActionsSheet";
import { firstLink } from "./links";
import { CustomEmojiImage, customEmojiName } from "./customEmoji";
import { parsePermalink } from "./permalink";
import { reminderPresets, scheduleLabel, toLocalInput } from "./schedule";
import { BOTTOM_SLACK_PX, jumpToLatestShown, ListAnchor, stillAtBottom, unseenBelow as countUnseen } from "./scrollAnchor";
import { conversationScrollKey, restoreDecision, scrollMemoryFor } from "./scrollMemory";
import { backToLatestShown, focusWindow } from "./focusWindow";
import { READER_BACK } from "../platform/idle";
import { ReactionsDialog } from "./WhoDialogs";
import { isSystemMessage, systemMessageText } from "./systemMessage";
import { TaskDialog } from "./TaskDialog";
import { MessageTaskChips } from "./MessageTaskChips";
import { canShareConversationTask, messageReviewInit, messageTaskInit } from "./tasks";


export function Timeline({ controller, channel, onOpenThread, active = true }: {
  controller: AppController;
  channel: ChannelState;
  onOpenThread?: (id: string) => void;
  /**
   * M29: false while the conversation is kept mounted but not on screen (a phone's 「ピン留め」 / 「ファイル」 tab, the
   * channel details or a thread over it): no row counts as shown (SYNC_PROTOCOL.md §10.1 2.), so nothing is read and
   * nothing counts as seen for 「新着 N 件」, which is not drawn either. Back on screen, it looks again.
   */
  active?: boolean;
}) {
  const activeRef = useRef(active);
  activeRef.current = active;
  const store = controller.store;
  const engine = controller.engine;
  const focus = controller.messageFocus?.channelId === channel.id ? controller.messageFocus : null;
  // Opened at a message: the server's window around it, joined to the live tail when the two meet (focusWindow.ts).
  const around = focus ? focusWindow(focus.context.map((m) => { const cached = store.message(channel.id, m.id); return cached && cached.updated_seq >= m.updated_seq ? cached : m; }), store.messages(channel.id), channel.oldestLoadedSeq) : null;
  const messages: MessageState[] = around ? around.rows : store.messages(channel.id);
  /** Not a fixed window: the live tail is in the list, so new rows come in and are followed as in the live view. */
  const live = !around || around.joined;
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
  /**
   * The topmost row on screen, how far below the top of the list it was and the list's scrollTop then (scrollAnchor.ts):
   * when content above it changes height (a link card or a photo arriving, older rows loaded), the view moves with it,
   * so what the reader looks at stays put. WebKit has no CSS scroll anchoring, and Chromium's is off on this list.
   */
  const [rowAnchor] = useState(() => new ListAnchor(() => container.current, "article[id^='timeline-']"));
  /** scrollTop at the last scroll event (or the view's own move to the bottom): what a scroll up is measured from. */
  const lastTop = useRef(0);
  /**
   * M75: where the reader was in each conversation this session (scrollMemory.ts). A conversation opened again (the
   * sidebar, ⌘K, back / forward …) comes back at its row; one left at the bottom, or opened at a message, lands as usual.
   */
  const scrollMemory = scrollMemoryFor(controller.activeServer ?? "");
  /** The conversation whose next positioning may restore (this view's first, or one just switched to); null once used. */
  const restoreFor = useRef<string | null>(channel.id);
  const shownId = useRef(channel.id);

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
  const group = controller.groupPosts;
  const items = useMemo(() => buildTimeline(messages, { firstUnreadAfterSeq: mark, meId: me?.id ?? null, group }), [messages, mark, me?.id, today, group]);
  // The rows are memoized (M21): one function for the life of the view, calling the latest prop (MainScreen passes a new
  // one on every render).
  const openThreadRef = useRef(onOpenThread);
  openThreadRef.current = onOpenThread;
  const [openThread] = useState(() => (id: string) => openThreadRef.current?.(id));
  const last = messages[messages.length - 1];
  const lastId = last ? rowKey(last) : undefined;
  const maxSeq = messages.reduce((max, m) => (m.seq !== null && m.seq > max ? m.seq : max), 0);
  const unseenBelow = focus ? 0 : countUnseen(messages, seenSeq, me?.id);
  const markSeen = () => {
    if (activeRef.current && maxSeq > seenSeq) setSeenSeq(maxSeq);
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
    rememberAnchor();
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
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    lastTop.current = el.scrollTop;
    rememberAnchor();
  };
  /** Takes the topmost row on screen as the anchor. */
  const rememberAnchor = () => rowAnchor.remember();
  /** Content changed height: the anchor row goes back where it was, unless the list scrolled since it was taken. */
  const keepAnchor = () => rowAnchor.keep();
  /**
   * From where the view is now: at the bottom (everything loaded counts as seen) and the bottom button. `landed`: the
   * view just put a row at the top itself (rows may have been added above in the same breath, so how far scrollTop moved
   * says nothing): only the distance to the end counts.
   */
  const measureScroll = (landed = false) => {
    const el = container.current;
    if (!el) return;
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    // Content growing under a reader at the bottom is no scroll of theirs: the list stays there (scrollAnchor.ts).
    atBottom.current = landed ? distance < BOTTOM_SLACK_PX : stillAtBottom(atBottom.current, lastTop.current, el.scrollTop, distance);
    lastTop.current = el.scrollTop;
    setShowJump(jumpToLatestShown(atBottom.current, distance));
    // Before positioning the list sits at its initial place (the bottom): what is below the divider is still new (7.).
    if (atBottom.current && positioned.current) markSeen();
  };
  // Images loading, link cards arriving, the composer growing or the window resizing change heights after we
  // positioned: stay pinned to the bottom when the reader was there, else keep the row they look at where it is.
  useEffect(() => {
    const el = container.current;
    const inner = content.current;
    if (!el || !inner || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      if (!positioned.current) return;
      if (atBottom.current || holdingEnd()) scrollToBottom();
      else keepAnchor();
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
    if (!el || !activeRef.current || focus || !positioned.current || quiet.current || jumpingFor.current === channel.id || !document.hasFocus()) return;
    const seen = screenRows(el, "article[data-seq]", "timeline-");
    const nowAnchored = reanchor(seen);
    const seq = Math.max(0, ...seen.seqs);
    if (nowAnchored && seq > 0) engine?.markRead(channel.id, seq);
  };

  useLayoutEffect(() => {
    // Older messages were prepended (or rows came or went): the row the reader was looking at stays where it was. By
    // that row, not by the height the list gained, which also counted photos and cards that grew below the screen
    // while the page loaded and threw the view down by as much.
    if (positioned.current && !atBottom.current) keepAnchor();
  }, [messages.length]);

  useLayoutEffect(() => {
    // Another conversation (not a search context of the same one, nor leaving it: 「最新の会話に戻る」 is a landing).
    if (shownId.current !== channel.id) restoreFor.current = channel.id;
    shownId.current = channel.id;
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
    // M75: back where the reader left it, when that row is still loaded. Not a landing on the first unread row: what is
    // on screen decides anchored as on any look (§10.1 2.), so rows below a position in the middle are not read.
    const requested = restoreFor.current === channel.id;
    restoreFor.current = null;
    const decision = restoreDecision(requested && !focus ? scrollMemory.get(conversationScrollKey(channel.id)) : null, { explicit: !!focus, requested });
    const restoredRow = decision.kind === "anchor" ? document.getElementById(`timeline-${decision.rowKey}`) : null;
    const unread = !focus && !restoredRow && mark !== null ? firstUnreadRow(messages, mark, me?.id) : null;
    const target = focus ? (focus.parentId ?? focus.messageId) : unread?.id;
    if (restoredRow && decision.kind === "anchor") rowAnchor.placeAt(restoredRow, decision.offset);
    else if (unread) showFromRow(unread);
    else if (target) document.getElementById(`timeline-${target}`)?.scrollIntoView({ block: "center" });
    else scrollToBottom();
    rememberAnchor();
    positioned.current = true;
    followedSeq.current = maxSeq;
    openedWith.current = { lastId };
    setIsPositioned(true);
    if (!focus) {
      if (target) setAnchored(true);
      else reanchor();
    }
    const el = container.current;
    atBottom.current = !!el && el.scrollHeight - el.scrollTop - el.clientHeight < BOTTOM_SLACK_PX;
    lastTop.current = el?.scrollTop ?? 0;
    setShowJump(jumpToLatestShown(atBottom.current, el ? el.scrollHeight - el.scrollTop - el.clientHeight : 0));
    if (atBottom.current) markSeen();
    recordPosition();
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
    if (opened || !live || !positioned.current || !(atBottom.current || mine)) return;
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
      measureScroll(true);
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

  // Back on screen (M29, another tab or a page over it closed): like the window back in front, the rows shown are looked
  // at again, and what is at the bottom now counts as seen.
  const wasActive = useRef(active);
  useEffect(() => {
    if (active === wasActive.current) return;
    wasActive.current = active;
    if (!active) return;
    quiet.current = false;
    measureScroll();
    markVisible();
  }, [active]);

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
    measureScroll(true);
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
    if (!engine || loadingOlder) return;
    setLoadingOlder(true);
    void engine.loadOlder(channel.id).catch((error) => controller.setError(error)).finally(() => setLoadingOlder(false));
  };

  /** M75: this conversation's position, for when it comes back (not a search context: that is another list). */
  const recordPosition = () => {
    const el = container.current;
    if (!el || !positioned.current || focus) return;
    const row = rowAnchor.snapshot();
    const rowKey = row && row.id.startsWith("timeline-") ? row.id.slice("timeline-".length) : null;
    scrollMemory.save(conversationScrollKey(channel.id), { rowKey, offset: row?.offset ?? 0, scrollTop: el.scrollTop, atBottom: atBottom.current });
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
    // A scroll of the view's own (an anchor correction, a landing) left the list where the anchor was taken: content
    // that grew since, before the resize observer saw it, is made up for here rather than taken as the new place.
    if (positioned.current && !atBottom.current) keepAnchor();
    else rememberAnchor();
    markVisible();
    recordPosition();
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
            <span className="shrink-0 text-muted">{t("common.loading")}</span>
          ) : (
            <span className="flex shrink-0 items-center gap-2">
              {jumpButtonShown(readRangeReady(channel), channel.unreadCount) && (
                <Button variant="link" size="sm" disabled={!online} onClick={() => void jumpToFirstUnread()}>
                  {t("timeline.firstUnread")}
                </Button>
              )}
              <Button variant="link" size="sm" disabled={!online} onClick={readToEnd}>
                {t("timeline.markRead")}
              </Button>
            </span>
          )}
        </div>
      )}
      <div data-message-list data-chat-focus tabIndex={-1} aria-label={t("timeline.list")} className="timeline flex-1 overflow-y-auto px-4 pb-2 pt-2 [overflow-anchor:none]" ref={container} onScroll={onScroll} {...tapHandlers}>
        <div ref={content}>
        {focus && backToLatestShown(live, showJump) && (
          <div className="sticky top-0 z-10 mb-2 flex items-center justify-between rounded-lg bg-accent-soft px-3 py-2 text-xs text-ink shadow-sm">
            <span>{t("timeline.aroundResult")}</span>
            {/* The conversation then opens like any other (first unread row or the newest), see the positioning above. */}
            <Button variant="link" size="sm" onClick={() => controller.clearMessageFocus()}>
              {t("timeline.backToLatest")}
            </Button>
          </div>
        )}
        {loadingOlder && <div className="py-2 text-center text-xs text-muted">{t("common.loading")}</div>}
        {!focus && !loadingOlder && channel.hasOlder && messages.length > 0 && engine && (
          <div className="py-1 text-center">
            <Button variant="link" size="sm" onClick={loadOlder}>
              {t("timeline.loadOlder")}
            </Button>
          </div>
        )}
        {!focus && !channel.hasOlder && messages.length > 0 && <ChannelIntro controller={controller} channel={channel} />}
        {messages.length === 0 && (
          <div className="flex flex-col items-center gap-2 px-4 py-16 text-center">
            <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-accent-soft text-accent">
              <MessagesSquare size={22} />
            </span>
            {/* My own DM (a DM with only me) says what it is for, under my name. */}
            {isSelfNotes(channel, me?.id ?? controller.me?.id ?? null) ? (
              <>
                <strong className="text-base">{myDisplayName(controller)}</strong>
                <span className="max-w-md text-sm text-muted">{selfNotesIntro()}</span>
              </>
            ) : (
              <>
                <strong className="text-base">{t("timeline.empty")}</strong>
                <span className="text-sm text-muted">{t("timeline.emptyHint")}</span>
              </>
            )}
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
                <span>{t("timeline.newMessages")}</span>
                <span className="h-px flex-1 bg-rose-400/70" />
              </div>
            );
          }
          return <MessageRow key={rowKey(item.message)} controller={controller} message={item.message} compact={item.compact} onOpenThread={onOpenThread ? openThread : undefined} />;
        })}
        <div ref={bottom} />
        </div>
      </div>
      {!focus && showJump && active && (
        <JumpToLatestButton
          label={unseenBelow > 0 ? t("timeline.newCount", { count: unseenBelow }) : t("timeline.toLatest")}
          highlighted={unseenBelow > 0}
          onClick={() => {
            quiet.current = false; // the reader's own move
            scrollToBottom();
          }}
        />
      )}
    </div>
  );
}

/**
 * The round button over the bottom of a message list (the timeline, a thread) that goes to the newest row at once (no
 * animated scroll). Highlighted while it counts rows from others that came in below.
 */
export function JumpToLatestButton({ label, highlighted, onClick }: { label: string; highlighted: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "absolute bottom-3 right-6 inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-medium shadow-lg transition-colors",
        highlighted ? "border-accent bg-accent-solid text-white hover:bg-accent-solid/90" : "border-line bg-canvas text-ink hover:bg-panel",
      )}
    >
      <ArrowDown size={14} />
      {label}
    </button>
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
  // My own DM: titled with my name (channelTitle), and what it is for instead of 「… との会話の始まりです。」.
  const self = isSelfNotes(channel, store.me?.id ?? controller.me?.id ?? null);
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
        {self ? (
          selfNotesIntro()
        ) : isDm ? (
          <>{t("timeline.dmStart", { title })}</>
        ) : (
          <>
            {channelStartText(creator || null, created, channel.type === "private")}
            {channel.member_count ? t("timeline.memberCount", { count: channel.member_count }) : ""}
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
export function MessageRow({ controller, message, compact = false, onOpenThread, thread = false, readOnly = false, threadParent, feed }: {
  controller: AppController; message: MessageState; compact?: boolean; onOpenThread?: (id: string) => void; thread?: boolean;
  /**
   * A channel read before joining (SYNC_PROTOCOL.md §7.6.1): the message is only read. No hover bar, no long-press
   * sheet, no reacting, voting or acknowledging (the server refuses them from non-members too).
   */
  readOnly?: boolean;
  /** The parent of a reply also sent to the channel, when it is not in the store (a preview holds its own rows). */
  threadParent?: MessageState;
  /**
   * L8, a row of the Times feed (TIMES_FEED.md §7): the times' name after the sender's (it opens the channel), the
   * 「新しい」 dot, and a click on the row reveals it in its channel. Nothing that needs the conversation open (editing in
   * place, 「ここから未読にする」). The callbacks must be stable (the row is memoized).
   */
  feed?: FeedRowProps;
}) {
  const store = controller.store;
  // §10.1 10.: moving the position forward (past unread rows) only while all of them are held; back always.
  const conversation = store.getChannel(message.channel_id);
  // The quick reactions are the emoji I used last (M25): a pick in any row changes them in every row, so they come in
  // as a prop (the memoized row would otherwise keep reading the old three until something else re-rendered it).
  const recentEmoji = useRecentEmoji();
  const [shown, setShown] = useState(false); // M104: a blocked person's message, shown on request
  // M88: a join / leave line is one muted line, never grouped, without actions (docs/MEMBERSHIP.md §1).
  if (isSystemMessage(message)) return <SystemMessageRow message={message} store={store} rowsVersion={store.rowsVersion} thread={thread} />;
  // M104 (docs/MODERATION.md §4): a message of someone I blocked is folded away until I ask to see it.
  if (store.isBlocked(message.sender_id) && !message.deleted && !shown) {
    return <BlockedMessageRow message={message} thread={thread} onShow={() => setShown(true)} />;
  }
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
      chosenReactions={store.me?.quick_reactions ?? null}
      editing={controller.editing === message.id}
      highlighted={controller.messageFocus?.messageId === message.id}
      saved={store.isBookmarked(message.id)}
      isAdmin={controller.isAdmin}
      // M15c: a reply also sent to the channel names its thread in the timeline and opens it.
      threadParent={!thread && message.parent_id ? (store.getMessage(message.channel_id, message.parent_id) ?? threadParent) : undefined}
      unreadOffered={!feed && !readOnly && !thread && message.seq !== null && !message.pending && !!conversation && markUnreadOffered(message.seq, conversation)}
      readOnly={readOnly}
      feedChannel={feed?.channelName}
      feedNew={feed?.isNew ?? false}
      onOpenChannel={feed?.onOpenChannel}
      onActivate={feed?.onActivate}
    />
  );
}

/**
 * M104 (docs/MODERATION.md §4): the folded row of a blocked person's message, 「ブロック中のユーザーのメッセージ」 with
 * 「表示」. Still an `article` with its seq, so the list's anchoring and read marks treat it like any row.
 */
function BlockedMessageRow({ message, thread, onShow }: { message: MessageState; thread: boolean; onShow: () => void }) {
  return (
    <article
      key={rowKey(message)}
      id={`${thread ? "thread" : "timeline"}-${message.id}`}
      data-seq={message.seq ?? undefined}
      data-blocked=""
      tabIndex={0}
      onKeyDown={(event) => messageRowKey(event, undefined)}
      className="message -mx-2 my-1 flex items-center gap-2 rounded-lg px-2 py-1 text-xs text-muted outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
    >
      <span className="min-w-0 italic">{t("timeline.blockedMessage")}</span>
      <button type="button" className="shrink-0 text-accent hover:underline" onClick={onShow}>{t("timeline.show")}</button>
    </article>
  );
}

/**
 * M88: a system message (the join / leave lines) as Slack shows it: one centred, muted line with the names from the
 * directory and the time on hover. Still an `article` with its seq, so the list's anchoring, keyboard moves and the
 * visible-range read marks treat it like any row; no hover bar, menu or long-press sheet.
 */
const SystemMessageRow = memo(function SystemMessageRow({ message, store, thread }: { message: MessageState; store: Store; rowsVersion: number; thread: boolean }) {
  const text = systemMessageText(message, (id) => store.users.get(id)?.display_name);
  return (
    <article
      key={rowKey(message)}
      id={`${thread ? "thread" : "timeline"}-${message.id}`}
      data-seq={message.seq ?? undefined}
      data-system=""
      tabIndex={0}
      aria-keyshortcuts="ArrowUp ArrowDown Home End"
      onKeyDown={(event) => messageRowKey(event, undefined)}
      title={fullTimestamp(message.created_at)}
      className="message -mx-2 my-1 flex items-center justify-center gap-2 rounded-lg px-2 py-1 text-center text-xs text-muted outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
    >
      <span className="min-w-0 break-words">{text}</span>
      <time className="shrink-0 tabular-nums opacity-70" dateTime={message.created_at}>
        {timeLabel(message.created_at)}
      </time>
    </article>
  );
});

export interface FeedRowProps {
  channelName: string;
  isNew: boolean;
  onOpenChannel: (channelId: string) => void;
  onActivate: (message: MessageState) => void;
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
  /** M50: the quick reactions I chose (UserMe.quick_reactions); null = the recent-first rule. */
  chosenReactions: readonly string[] | null;
  editing: boolean;
  highlighted: boolean;
  saved: boolean;
  isAdmin: boolean;
  threadParent: MessageState | undefined;
  unreadOffered: boolean;
  readOnly: boolean;
  /** L8: the times' name (a row of the Times feed); undefined elsewhere. */
  feedChannel?: string;
  feedNew?: boolean;
  onOpenChannel?: (channelId: string) => void;
  onActivate?: (message: MessageState) => void;
}

/**
 * C3 (MOBILE_POLISH.md): the line under a thread parent, as in Slack: up to three repliers' avatars (most recent first),
 * 「N 件の返信」 and 「最終返信 今日 14:05」. An older server sends no repliers: the speech bubble stands in for them.
 */
function ThreadSummaryLine({ message, store, onOpen }: { message: MessageState; store: Store; onOpen: () => void }) {
  const repliers = message.reply_user_ids ?? [];
  const nameOf = (id: string) => store.users.get(id)?.display_name ?? "?";
  const last = message.last_reply_at ? lastReplyLabel(message.last_reply_at) : "";
  // Who replied and when last, above the line (HoverList), not a native title at the pointer.
  const hover = [
    repliers.length > 0 ? t("timeline.repliers", { names: compactNames(repliers.map(nameOf)) }) : "",
    message.last_reply_at ? t("timeline.lastReply", { at: fullTimestamp(message.last_reply_at) }) : "",
  ].filter(Boolean).join("\n");
  return (
    <HoverList content={hover}>
    <button
      type="button"
      data-testid="thread-summary"
      className="group mt-1 flex max-w-full items-center gap-2 rounded-md text-left text-xs"
      onClick={onOpen}
    >
      {repliers.length > 0 ? (
        <span className="flex shrink-0 -space-x-1">
          {repliers.slice(0, 3).map((id) => (
            <Avatar key={id} id={id} name={nameOf(id)} size={20} className="rounded-md text-[9px] ring-2 ring-canvas" />
          ))}
        </span>
      ) : (
        <MessageSquare size={13} className="shrink-0 text-accent" />
      )}
      <span className="whitespace-nowrap font-semibold text-accent group-hover:underline">{t("timeline.replyCount", { count: message.reply_count })}</span>
      {last && (
        <span className="truncate text-muted">{last}</span>
      )}
    </button>
    </HoverList>
  );
}

const MessageRowView = memo(function MessageRowView({ controller, message, compact, onOpenThread, thread, store, engine, api, recentEmoji, chosenReactions, editing, highlighted, saved, isAdmin, threadParent, unreadOffered, readOnly, feedChannel, feedNew = false, onOpenChannel, onActivate }: MessageRowViewProps) {
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
  const [reportOpen, setReportOpen] = useState(false); // M104
  const [revisionsOpen, setRevisionsOpen] = useState(false);
  const [chipPicker, setChipPicker] = useState(false);
  // M27 「リアクションした人」: from the long-press sheet on a phone, from the hover bar with a mouse.
  const [reactionsOpen, setReactionsOpen] = useState(false);
  // M55 「タスクにする」: the task dialog, new, from this message.
  const [taskOpen, setTaskOpen] = useState(false);
  const canMakeTask = !!engine?.tasks?.available && !message.deleted;
  // L9 「レビューを依頼」: a shared task of kind review in this conversation (a DM too), where I may add tasks. The
  // conversation's state (archived, posting policy, my role) is not a prop of the memoized row: it is read whenever the
  // row renders, so a change made while the row stays put shows late at worst (the server checks it again).
  const [reviewOpen, setReviewOpen] = useState(false);
  const canRequestReview = canMakeTask && message.seq !== null && !message.pending && canShareConversationTask(store.getChannel(message.channel_id), isAdmin);
  // The hover bar's 「その他」 menu. What an item opens (a dialog, the remind or delete popover by ⋯) opens once the menu
  // has closed and handed focus back, which the new layer would otherwise take for a click outside (as in the composer).
  const [menuOpen, setMenuOpen] = useState(false);
  const afterMenu = useRef<(() => void) | null>(null);
  const runAfterMenu = (event: Event) => {
    const run = afterMenu.current;
    if (!run) return;
    afterMenu.current = null;
    event.preventDefault();
    run();
  };
  const moreButton = useRef<HTMLButtonElement>(null);
  const moreAnchor = useRef({ getBoundingClientRect: () => moreButton.current?.getBoundingClientRect() ?? new DOMRect() });
  // Whether the quick reactions fit the bar (rowFitsQuickReactions), from the row's own width when the bar is about to
  // show (hover or focus): no observer per row, and the thread pane or a narrow window drops them.
  const [wideRow, setWideRow] = useState(true);
  const measureRow = (row: HTMLElement) => setWideRow(rowFitsQuickReactions(row.clientWidth));
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
  // Our own permalinks get no card, nor a call's room (M117: its card has 「参加する」).
  const link = (rawLink && api && parsePermalink(api.baseUrl, rawLink)) || message.call ? null : rawLink;
  const pinnedBy = message.pinned_at ? (store.users.get(message.pinned_by ?? "")?.display_name ?? "?") : null;
  const threadId = message.parent_id ?? message.id;
  // The same actions as the long-press sheet (messageActions.ts): the bar shows a few, ⋯ the rest.
  const editable = mine && feedChannel === undefined;
  const actions = messageActions({ message, mine, isAdmin, saved, thread: !!onOpenThread, editable, showReactions: true, canMakeTask, canRequestReview, unreadOffered });
  const offered = new Set(actions.map((action) => action.key));
  const afterClose = (work: () => void) => () => { afterMenu.current = work; };
  const menuRun: Record<MessageActionKey, () => void> = {
    reactions: afterClose(() => setReactionsOpen(true)),
    thread: () => onOpenThread?.(threadId),
    edit: () => controller.setEditing(message.id),
    copyText: () => void controller.copyMessageText(message.body),
    save: () => void controller.toggleBookmark(message),
    remind: afterClose(() => setRemindOpen(true)),
    task: afterClose(() => setTaskOpen(true)),
    review: afterClose(() => setReviewOpen(true)),
    unread: () => engine?.markUnread(message.channel_id, message.seq!),
    copyLink: () => void controller.copyPermalink(message.id),
    share: afterClose(() => setShareOpen(true)),
    pin: () => void controller.togglePin(message),
    report: afterClose(() => setReportOpen(true)),
    delete: afterClose(() => setConfirmDelete(true)),
  };
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
      onMouseEnter={(event) => measureRow(event.currentTarget)}
      onFocus={(event) => measureRow(event.currentTarget)}
      onClick={(event) => {
        // A dialog this row opened (who reacted, who confirmed …) sits in a portal: React still bubbles its clicks and
        // touches here, but they are not on the message.
        if (!event.currentTarget.contains(event.target as Node)) return;
        // Alt+click marks the conversation unread from this message (Mattermost).
        if (event.altKey && unreadOffered) engine?.markUnread(message.channel_id, message.seq!);
        // L8: a row of the Times feed shows its message in its channel (a mouse too), unless the click was on something of
        // the message or ended a text selection.
        else if (onActivate) {
          const target = event.target as HTMLElement;
          if (message.pending || typing.current || target.closest("a, button, input, textarea, img, video, [role=button]") || window.getSelection?.()?.toString()) return;
          event.currentTarget.blur();
          onActivate(message);
        }
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
      {/* items-start: the avatar's button would stretch to the row's height and centre the picture in it (a tall message's
          picture sat beside its middle, below the name). */}
      <div className="flex items-start justify-center pt-0.5">
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
            <span className="shrink-0">{t("timeline.repliedToThread")}</span>
            <span className="truncate">{threadParent ? <EmojiText controller={controller} text={plainText(mentionsToNames(threadParent.body, store.users, store.groups), 80) || attachmentText(threadParent.attachments) || t("common.attachmentParen")} /> : t("timeline.originalMessage")}</span>
          </button>
        )}
        {thread && message.parent_id && message.also_in_channel && (
          <div className="mb-0.5 text-[11px] text-muted">{t("timeline.alsoSentToChannel")}</div>
        )}
        {message.priority && <PriorityLabel priority={message.priority} className="mb-1" />}
        {/* M94: posted through a workflow's form. */}
        {message.workflow && !message.deleted && <div><WorkflowLabel controller={controller} message={message} /></div>}
        {(pinnedBy || saved) && (
          <div className="mb-0.5 flex items-center gap-3 text-[11px] text-muted">
            {pinnedBy && (
              <span className="inline-flex items-center gap-1 text-warning" title={message.pinned_at ? fullTimestamp(message.pinned_at) : undefined}>
                <Pin size={11} /> {t("timeline.pinnedBy", { name: pinnedBy })}
              </span>
            )}
            {saved && (
              <span className="inline-flex items-center gap-1 text-accent">
                <BookmarkCheck size={11} /> {t("nav.saved")}
              </span>
            )}
          </div>
        )}
        {!compact && (
          <div className="flex items-baseline gap-2 text-xs text-muted">
            <UserPopover controller={controller} userId={message.sender_id} className="hover:underline">
              <strong className="text-sm text-ink">{senderName}</strong>
            </UserPopover>
            {sender?.role === "bot" && (store.aiAgentOf(message.sender_id) ? <AiBadge /> : <span className="rounded bg-panel-2 px-1 text-[10px] font-bold text-muted" title={t("timeline.botTitle")}>BOT</span>)}
            <StatusEmoji controller={controller} userId={message.sender_id} />
            {feedChannel !== undefined && (
              <button type="button" data-feed-channel="" className="min-w-0 truncate font-medium text-muted hover:text-ink hover:underline" title={t("timeline.openChannel", { name: feedChannel })} onClick={() => onOpenChannel?.(message.channel_id)}>
                #{feedChannel}
              </button>
            )}
            <time title={fullTimestamp(message.created_at)}>{feedChannel !== undefined ? `${dateLabel(message.created_at)} ${timeLabel(message.created_at)}` : timeLabel(message.created_at)}</time>
            {feedNew && <span data-feed-new="" role="img" aria-label={t("timeline.newPost")} title={t("timeline.newPostTitle")} className="h-2 w-2 shrink-0 self-center rounded-full bg-accent" />}
            {message.edited_at &&
              (mine && !readOnly ? (
                <button type="button" className="hover:text-ink hover:underline" title={t("timeline.viewRevisions")} onClick={() => setRevisionsOpen(true)}>
                  {t("timeline.edited")}
                </button>
              ) : (
                <span title={fullTimestamp(message.edited_at)}>{t("timeline.edited")}</span>
              ))}
          </div>
        )}
        {editing ? (
          <MessageEditor controller={controller} message={message} />
        ) : (
          <>
            {/* M117: a call's card stands for the server's body (the same link); an edited body still shows. */}
            {message.call && !message.deleted && <CallCard controller={controller} call={message.call} createdAt={message.created_at} />}
            {message.body && !pollHidesBody(message) && !callHidesBody(message) && (
              <MessageBody body={message.body} users={store.users} internalBase={api?.baseUrl} onOpenMessage={(id) => void controller.openPermalink(id)} customEmoji={store.customEmoji} controller={controller} keywords={store.me?.notify_keywords} groups={store.groups} jumbo />
            )}
            <AttachmentList attachments={message.attachments ?? []} controller={controller} downloadable={!message.pending && !message.failed} />
            {!message.pending && link && <LinkPreviewCard controller={controller} url={link} auto={autoLinkPreview(store, message.sender_id)} />}
          </>
        )}
        {message.failed && (
          <div className="mt-1 flex items-center gap-2 text-xs text-danger">
            {t("timeline.sendFailed")}
<Button variant="link" size="sm" onClick={() => message.client_msg_id && void engine?.retryFailed(message.client_msg_id)}>{t("timeline.resend")}</Button>
            <Button variant="link" size="sm" onClick={() => message.client_msg_id && engine?.discardFailed(message.client_msg_id)}>{t("timeline.discard")}</Button>
          </div>
        )}
        {message.poll && <PollCard poll={message.poll} message={message} controller={controller} readOnly={readOnly} />}
        {message.ack_requested && !message.pending && <AckBar controller={controller} message={message} readOnly={readOnly} />}
        {message.collection && !message.deleted && <CollectionChip controller={controller} message={message} />}
        {/* L9: the chips come from the message itself (message.updated change="tasks" replaces it: the row re-renders). */}
        {(message.tasks?.length ?? 0) > 0 && !message.deleted && <MessageTaskChips controller={controller} tasks={message.tasks!} readOnly={readOnly} />}
        {(message.reply_count ?? 0) > 0 && onOpenThread && <ThreadSummaryLine message={message} store={store} onOpen={() => onOpenThread(message.id)} />}
        {reactions.length > 0 && (
          <div className="mt-1.5 flex flex-wrap gap-1">
            {reactions.map((reaction) => {
              const reacted = !!me && reaction.user_ids.includes(me.id);
              const names = reaction.user_ids.map((id) => store.users.get(id)?.display_name ?? "?").join("、");
              const chip = cn(
                "inline-flex h-6 items-center gap-1 rounded-full border px-2 text-xs transition-colors",
                reacted ? "border-accent bg-accent-soft text-ink" : "border-line bg-panel text-ink",
                !readOnly && !reacted && "hover:border-accent/50",
              );
              const content = (
                <>
                  {/* One 16px box for both kinds (2026-10-04): a standard emoji was 12px text next to a 16px image. */}
                  <span data-reaction-emoji className="inline-flex h-4 min-w-4 items-center justify-center text-base leading-none">{(() => { const name = customEmojiName(reaction.emoji); const custom = name ? store.customEmoji.get(name) : undefined; return custom ? <CustomEmojiImage controller={controller} emoji={custom} size={16} /> : name ? <span className="text-xs">{reaction.emoji}</span> : reaction.emoji; })()}</span>
                  <span className="font-medium">{reaction.count}</span>
                </>
              );
              // Read before joining: the names still show on hover, but nothing toggles.
              return readOnly ? (
                <HoverList key={reaction.emoji} content={names}><span tabIndex={0} data-reacted-by={names} className={chip}>{content}</span></HoverList>
              ) : (
                <HoverList key={reaction.emoji} content={names}>
                  <button type="button" data-reacted-by={names} onClick={() => void controller.toggleReaction(message, reaction.emoji)} className={chip}>
                    {content}
                  </button>
                </HoverList>
              );
            })}
            {/* M25: add another reaction right there (the picker on a mouse, the sheet's picker on a phone). */}
            {!readOnly && <PopoverRoot open={chipPicker} onOpenChange={(open) => { if (open && touchScreen()) setSheet("emoji"); else setChipPicker(open); }}>
              <PopoverTrigger asChild>
                <button type="button" aria-label={t("timeline.addReaction")} title={t("timeline.addReaction")} className="inline-flex h-6 items-center rounded-full border border-line bg-panel px-1.5 text-muted hover:border-accent/50 hover:text-ink">
                  <SmilePlus size={14} />
                </button>
              </PopoverTrigger>
              <PopoverContent align="start" className="w-auto p-3" onAnchorHidden={() => setChipPicker(false)}>
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
        // Slack's bar: quick reactions, 「リアクションを追加」, the thread, 「あとで見る」, my edit, and 「その他」 (⋯) with the
        // rest (messageActions.ts, the same list as the long-press sheet). It stays shown while its menu or a popover
        // opened from it is open (they sit in portals, outside the row's hover).
        <div className={cn("row-actions pointer-events-none absolute -top-3.5 right-2 flex max-w-[calc(100%-1rem)] items-center gap-0.5 rounded-lg border border-line bg-canvas p-0.5 opacity-0 shadow-md transition-opacity", (pickerOpen || confirmDelete || remindOpen || menuOpen) && "pointer-events-auto opacity-100")}>
          {/* The first three I chose (M50), else the three I used last (then the defaults), as the phone sheet's six (M25).
              Left out on a narrow row (the thread pane): 「リアクションを追加」 still has them. */}
          {wideRow && quickReactions(recentEmoji, 3, chosenReactions).map((emoji) => (
            <button key={emoji} type="button" title={t("timeline.reactWith", { emoji })} className="h-7 w-7 shrink-0 rounded-md text-base leading-none hover:bg-panel-2" onClick={() => void controller.toggleReaction(message, emoji)}>
              {emoji}
            </button>
          ))}
          <PopoverRoot open={pickerOpen} onOpenChange={setPickerOpen}>
            <PopoverTrigger asChild>
              <button type="button" title={t("timeline.addReaction")} aria-label={t("timeline.addReaction")} className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted hover:bg-panel-2 hover:text-ink">
                <SmilePlus size={16} />
              </button>
            </PopoverTrigger>
            <PopoverContent align="end" className="w-auto p-3" onAnchorHidden={() => setPickerOpen(false)}>
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
          {offered.has("thread") && (
            <IconButton label={t("timeline.replyInThread")} className="h-7 w-7 shrink-0 text-muted hover:text-ink" onClick={() => onOpenThread?.(threadId)}>
              <MessageSquare size={15} />
            </IconButton>
          )}
          <IconButton label={saved ? t("timeline.unsave") : t("timeline.save")} className={cn("h-7 w-7 shrink-0 hover:text-ink", saved ? "text-accent" : "text-muted")} onClick={() => void controller.toggleBookmark(message)}>
            {saved ? <BookmarkCheck size={15} /> : <Bookmark size={15} />}
          </IconButton>
          {offered.has("edit") && (
            <IconButton label={t("timeline.editHint")} className="h-7 w-7 shrink-0 text-muted hover:text-ink" onClick={() => controller.setEditing(message.id)}>
              <Pencil size={15} />
            </IconButton>
          )}
          <Menu open={menuOpen} onOpenChange={(open) => { if (open) afterMenu.current = null; setMenuOpen(open); }}>
            <MenuTrigger asChild>
              <button ref={moreButton} type="button" title={t("composer.more")} aria-label={t("composer.more")} className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted hover:bg-panel-2 hover:text-ink data-[state=open]:bg-panel-2 data-[state=open]:text-ink">
                <MoreHorizontal size={16} />
              </button>
            </MenuTrigger>
            <MenuContent align="end" aria-label={t("timeline.moreActions")} onCloseAutoFocus={runAfterMenu}>
              {hoverMenuGroups(actions).map((group, index) => (
                <Fragment key={group[0]!.key}>
                  {index > 0 && <MenuSeparator />}
                  {group.map((action) => (
                    <MenuItem key={action.key} className={action.danger ? "text-danger" : undefined} onSelect={menuRun[action.key]}>
                      <action.icon size={14} className={action.danger ? undefined : "text-muted"} />
                      {action.label}
                      {action.key === "unread" && <span aria-hidden className="ml-auto pl-3 text-[11px] text-muted">{t("timeline.altClick")}</span>}
                    </MenuItem>
                  ))}
                </Fragment>
              ))}
            </MenuContent>
          </Menu>
          {/* 「リマインド…」 and 「削除」 from the menu open by ⋯. */}
          <PopoverRoot open={remindOpen} onOpenChange={setRemindOpen}>
            <PopoverAnchor virtualRef={moreAnchor} />
            <PopoverContent align="end" className="w-72 p-3" aria-label={t("timeline.remind")}>
              <div className="mb-2 text-xs font-semibold text-muted">{t("timeline.remind")}</div>
              <Input value={remindNote} maxLength={200} placeholder={t("timeline.remindNote")} aria-label={t("timeline.remindNoteLabel")} className="mb-2 h-9 text-sm" onChange={(e) => setRemindNote(e.target.value)} />
              <ul className="space-y-0.5">
                {reminderPresets().map((preset) => (
                  <li key={preset.key}>
                    <button type="button" className="flex w-full items-center justify-between rounded-md px-2 py-1.5 text-left text-sm hover:bg-panel" onClick={() => remind(preset.at)}>
                      <span>{preset.label}</span>
                      {scheduleLabel(preset.at.toISOString()) !== preset.label && <span className="text-xs text-muted">{scheduleLabel(preset.at.toISOString())}</span>}
                    </button>
                  </li>
                ))}
              </ul>
              {/* Finger-sized on a touch screen (the hover bar floats there too, styles.css). */}
              <div className="mt-2 flex items-center gap-2 border-t border-line pt-2">
                <input type="datetime-local" value={remindAt} aria-label={t("settings.pause.custom")} className="h-9 min-w-0 flex-1 rounded-lg border border-line bg-canvas px-2 text-sm" onChange={(e) => setRemindAt(e.target.value)} />
                <Button size="sm" variant="secondary" onClick={() => { const at = new Date(remindAt); if (Number.isNaN(at.getTime()) || at.getTime() < Date.now() + 60_000) { controller.setError(t("composer.pickLater")); return; } remind(at); }}>{t("timeline.set")}</Button>
              </div>
            </PopoverContent>
          </PopoverRoot>
          <PopoverRoot open={confirmDelete} onOpenChange={setConfirmDelete}>
            <PopoverAnchor virtualRef={moreAnchor} />
            <PopoverContent align="end" className="w-64 p-3" aria-label={t("timeline.deleteMessage")}>
              <div className="text-sm font-medium">{t("timeline.deleteTitle")}</div>
              <div className="mt-1 text-xs text-muted">{t("timeline.deleteNote")}</div>
              <div className="mt-3 flex justify-end gap-2">
                <Button variant="secondary" size="sm" onClick={() => setConfirmDelete(false)}>
                  {t("common.cancel")}
                </Button>
                <Button variant="danger" size="sm" onClick={() => { setConfirmDelete(false); void controller.deleteMessage(message.id); }}>
                  {t("common.deleteConfirm")}
                </Button>
              </div>
            </PopoverContent>
          </PopoverRoot>
        </div>
      )}
      {shareOpen && <ShareDialog controller={controller} message={message} onClose={() => setShareOpen(false)} />}
      {reportOpen && <ReportDialog controller={controller} message={message} onClose={() => setReportOpen(false)} />}
      {revisionsOpen && <RevisionsDialog controller={controller} message={message} onClose={() => setRevisionsOpen(false)} />}
      {reactionsOpen && <ReactionsDialog controller={controller} message={message} onClose={() => setReactionsOpen(false)} />}
      {taskOpen && (
        <TaskDialog
          controller={controller}
          task={null}
          init={messageTaskInit(message, store.getChannel(message.channel_id), store.users, store.groups, isAdmin)}
          onClose={() => setTaskOpen(false)}
        />
      )}
      {reviewOpen && (
        <TaskDialog
          controller={controller}
          task={null}
          init={messageReviewInit(message, store.users, store.groups)}
          onClose={() => setReviewOpen(false)}
        />
      )}
      {sheet && (
        <MessageActionsSheet
          controller={controller}
          message={message}
          initialView={sheet}
          onClose={() => setSheet(null)}
          onOpenThread={onOpenThread}
          onShare={() => setShareOpen(true)}
          onReport={() => setReportOpen(true)}
          onShowReactions={() => setReactionsOpen(true)}
          onMakeTask={canMakeTask ? () => setTaskOpen(true) : undefined}
          onRequestReview={canRequestReview ? () => setReviewOpen(true) : undefined}
          unreadOffered={unreadOffered}
          saved={saved}
          isAdmin={isAdmin}
          canEdit={editable}
        />
      )}
    </article>
  );
});

/**
 * Inline editor: Enter saves, Esc cancels, focus returns to the composer afterwards. In 「リッチ」 mode (users.composer_mode)
 * the message opens in the rich editor (its Markdown read back into formats) and is saved as Markdown again.
 */
function MessageEditor({ controller, message }: { controller: AppController; message: MessageState }) {
  const store = controller.store;
  const [draft, setDraft] = useState(() => decodeMentions(message.body, store.users, store.groups));
  const composing = useRef(false);
  const rich = (controller.composerMode ?? "markdown") === "rich";
  const richApi = useRef<RichEditorApi | null>(null);
  const composedAt = useRef(0);
  const latest = useRef(draft);
  latest.current = draft;
  const [saving, setSaving] = useState(false);
  const finish = () => {
    controller.setEditing(null);
    requestAnimationFrame(() => document.querySelector<HTMLElement>(".composer [data-composer-input]")?.focus());
  };
  // Codex audit C4: closed only once the server took the edit; a failure (offline) keeps the text and the editor open.
  const save = async () => {
    const body = encodeMentions(latest.current.trim(), store.users.values(), store.groups.values());
    if (!body || body === message.body) return finish();
    setSaving(true);
    const saved = await controller.editMessage(message.id, body);
    setSaving(false);
    if (saved) finish();
  };
  const textArea = (
      <Textarea
        value={draft}
        rows={3}
        autoFocus
        aria-label={t("timeline.editMessage")}
        onFocus={(e) => e.currentTarget.setSelectionRange(e.currentTarget.value.length, e.currentTarget.value.length)}
        onChange={(e) => setDraft(e.target.value)}
        onPaste={(e) => {
          // A URL pasted over selected text links it, as in the composer (composerEdit.linkFromPaste).
          const el = e.currentTarget;
          const linked = linkFromPaste({ text: el.value, start: el.selectionStart, end: el.selectionEnd }, e.clipboardData.getData("text/plain"));
          if (!linked) return;
          e.preventDefault();
          if (replaceThroughBrowser(el, linked.text)) el.setSelectionRange(linked.start, linked.end);
          else setDraft(linked.text);
        }}
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
          } else if (isSendKey(e, controller.sendKey ?? "mod-enter") && !e.nativeEvent.isComposing && !composing.current && e.keyCode !== 229) {
            e.preventDefault();
            if (draft.trim() && !saving) void save();
          }
        }}
      />
  );
  /** The rich editor's keys (never during an IME composition): Esc, the save key, Shift+Enter as its newline. */
  const onRichKeyDown = (event: KeyboardEvent): boolean => {
    const api = richApi.current;
    if (!api || isImeKey(event, api.composing(), composedAt.current)) return false;
    if (event.key === "Escape") {
      finish();
      return true;
    }
    if (event.key !== "Enter") return false;
    const sendKey = controller.sendKey ?? "mod-enter";
    if (isSendKey(event, sendKey)) {
      if (sendKey === "enter" && api.inCodeBlock()) return false;
      if (latest.current.trim() && !saving) void save();
      return true;
    }
    return event.shiftKey || event.metaKey || event.ctrlKey ? api.newline() : false;
  };
  return (
    <div className="mt-1 space-y-2">
      {rich ? (
        <Suspense fallback={textArea}>
          <LazyRichEditor
            value={draft}
            apiRef={richApi}
            ariaLabel={t("timeline.editMessage")}
            autoFocus
            className="max-h-[280px] overflow-y-auto rounded-lg border border-line bg-canvas px-3 py-2 text-[14.5px] leading-6 text-ink focus-within:border-accent focus-within:ring-2 focus-within:ring-accent/25"
            onChange={(markdown) => {
              latest.current = markdown;
              setDraft(markdown);
            }}
            onKeyDown={onRichKeyDown}
            onCompositionEnd={() => {
              composedAt.current = Date.now();
            }}
          />
        </Suspense>
      ) : (
        textArea
      )}
      {/* The actions sit at the bottom right with 保存 last, as in Slack (the user, 2026-10-07); the keys' hint on the left. */}
      <div className="flex items-center gap-2">
        <span className="flex min-w-0 flex-1 items-center gap-1 text-[11px] text-muted">
          <Kbd>{sendKeyLabel(controller.sendKey ?? "mod-enter").send}</Kbd> {t("common.save")} <Kbd>Esc</Kbd> {t("timeline.escCancel")}
        </span>
        <Button size="sm" variant="secondary" onClick={finish}>
          {t("common.cancel")}
        </Button>
        <Button size="sm" onClick={() => void save()} disabled={!draft.trim() || saving}>
          {saving ? t("common.saving") : t("common.save")}
        </Button>
      </div>
    </div>
  );
}

/** The intro line of a channel's history: who made it and when (both optional), public or private (M115). */
function channelStartText(creator: string | null, created: Date | null, isPrivate: boolean): string {
  const kind = isPrivate ? t("timeline.kindPrivate") : t("timeline.kindPublic");
  const date = created ? created.toLocaleDateString(intlLocale(), { year: "numeric", month: "long", day: "numeric" }) : null;
  if (creator && date) return t("timeline.channelStartByOn", { creator, date, kind });
  if (creator) return t("timeline.channelStartBy", { creator, kind });
  if (date) return t("timeline.channelStartOn", { date, kind });
  return t("timeline.channelStart", { kind });
}
