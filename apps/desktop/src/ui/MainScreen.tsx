import { ArrowLeft, ArrowRight, AtSign, Bell, BellOff, ChevronDown, Files, Hash, Keyboard, Lock, Megaphone, MessagesSquare, MoreHorizontal, Pin, Star, Users } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

import type { AppController } from "../state/app";
import type { ActivityItem, ChannelLinkOut, ChannelOut, MessageOut } from "../api/types";
import { canEditLinks, ChannelLinkDialog, ChannelLinksBar } from "./ChannelLinks";
import type { ChannelState, MessageState, NotificationLevel, ThreadEntry } from "../sync/types";
import { canMakePublic, canPostTopLevel, conversationTitle, effectiveNotificationLevel, FOLLOW_DEFAULT, hasUnread, isDmChannel, isMutedChannel, myName, notificationChoices, overallLevel, sectionChannels, stepChannel } from "./channels";
import { CallButton, canStartCall } from "./Calls";
import { Composer } from "./Composer";
import { AdminDialog, ArchiveConfirm } from "./AdminDialog";
import { AddMemberDialog, MembersDialog, NewChannelDialog, NewDmDialog, RenameChannelDialog, ShortcutsDialog, TopicDialog } from "./Dialogs";
import { formatMuted } from "./format";
import { PANE_DEFAULT, PANE_MAX, PANE_MIN, readPaneWidth, readSidebarWidth, SIDEBAR_DEFAULT, SIDEBAR_MAX, SIDEBAR_MIN, writePaneWidth, writeSidebarWidth } from "./prefs";
import { Badge, Button, cn, IconButton, Menu, MenuCheckboxItem, MenuContent, MenuItem, MenuLabel, MenuRadioGroup, MenuRadioItem, MenuSeparator, MenuTrigger, Modal, modKey } from "./primitives";
import { QuickSwitcher } from "./QuickSwitcher";
import { ChannelPins, PinsPane } from "./PinsPane";
import { ChannelDetails } from "./ChannelDetails";
import { FeedsDialog } from "./ChannelFeeds";
import { ReservationsView } from "./Reservations";
import { AttendanceView } from "./AttendanceView";
import { pressable } from "./actions";
import { ActionsView } from "./ActionsView";
import { inRoomCount } from "./attendance";
import { DocsView } from "./DocsView";
import { reservationTodoCount } from "./reservationPools";
import { RecurringPostsDialog } from "./RecurringPosts";
import { ChannelWorkflowsDialog } from "./WorkflowViews";
import { CanvasPane } from "./CanvasPane";
import { type ConversationTab, ConversationTabs, eventsTabLabel } from "./ConversationTabs";
import { CalendarView, ChannelEvents, useCalendarHub } from "./CalendarView";
import { ChannelTasks } from "./TaskBoard";
import { MyTasksView } from "./MyTasksView";
import { DeadlineChip, DeadlinesView, newDeadlineInit } from "./DeadlinesView";
import { TaskDialog } from "./TaskDialog";
import { canEditBoard, type TaskCreateInit } from "./tasks";
import type { TaskOut } from "../api/types";
import { MentionsView } from "./MentionsView";
import { DirectoryDialog } from "./DirectoryDialog";
import { DraftsView } from "./DraftsView";
import { ChannelFiles, FilesView } from "./FilesView";
import { CanvasesView } from "./CanvasesView";
import { RemindersView } from "./RemindersView";
import { ChannelBrowserDialog } from "./ChannelBrowserDialog";
import { previewCanJoin, PreviewJoinBar, previewRefused, PreviewThreadPane, PreviewTimeline } from "./ChannelPreview";
import { BackButton, BackToList, useCompact } from "./compact";
import { useConnectionBanner } from "./hooks";
import { SavedView } from "./SavedView";
import { describeSearch, SearchBar } from "./SearchBar";
import { SearchView, type SearchSnapshot, type SearchTab } from "./SearchView";
import { WindowControls } from "./WindowControls";
import { WorkspaceMenu } from "./WorkspaceRail";
import { AttendancePill } from "./AttendancePill";
import { startSummary, SummaryDialog, SummaryMenuItems, summaryAvailable } from "./ai";
import { customTitleBar, isWeb, overlayTitleBar, TITLE_ROW_HEIGHT, TITLE_ROW_INSET_AFTER_RAIL, TRAFFIC_LIGHTS_INSET } from "../platform/env";
import { EMPTY_SEARCH, pushRecent, readRecent, recentKey, removeRecent, type SearchParams } from "./search";
import { HomeView } from "./HomeView";
import { JumpView } from "./JumpView";
import { NewMessageView } from "./NewMessageView";
import { pushRecentConversation, readGatherUnread, readRecentConversations, recentConversationsKey, writeGatherUnread } from "./home";
import { Sidebar } from "./Sidebar";
import { ThreadPane } from "./ThreadPane";
import { ThreadsView } from "./ThreadsView";
import { Timeline } from "./Timeline";
import { NoticeToast, Toast } from "./Toast";
import { TypingIndicator } from "./Typing";
import { presenceLabel } from "./Avatar";
import { StatusGlyph } from "./UserPopover";
import { activeStatus } from "./users";
import { StatusDialog } from "./StatusDialog";
import { CONVERSATION_MIN, headerFit, paneLayout } from "./paneLayout";
import { useNavigationHistory } from "./navigationHistory";
import { canGo, emptyHistory, go, type Place, type PlaceHistory, placeKey, restore, visit } from "./placeHistory";
import { scrollMemoryFor } from "./scrollMemory";
import { useViewScrollMemory } from "./viewScrollMemory";
import { historyStep, historyShortcutLabels, mouseHistoryStep } from "./historyShortcuts";
import { isImeKeyEvent } from "./ime";
import { focusChatRegion } from "./messageKeyboard";
import { ActivityView } from "./ActivityView";
import { DmListView } from "./DmListView";
import { MobileTabBar } from "./MobileTabBar";
import { landingTab, landOn, MOBILE_TABS, type MobileTab, tapTab } from "./mobileTabs";
import { SettingsDialog, type SettingsSection } from "./Settings";
import { TimesFeedView } from "./TimesFeedView";
import { YouView } from "./YouView";
import { t } from "../i18n";
import { canManageChannelByRight } from "./roles";

// "activity": the wide layout's 「アクティビティ」 (M39; the mentions list for a server before it).
// "canvases" (M44): the canvases of all my conversations. "calendar" (M51): my calendar and my channels'.
// "tasks" (M55): 「自分のタスク」 and 「自分の担当」. "times" (L8): the Times feed (TIMES_FEED.md §7).
// "deadlines" (M85): 「締切」, my channels' deadlines (DEADLINES.md).
// "reservations" (M112): 「予約」, the workspace's reservation pools (RESERVATIONS.md).
// "docs" (M121): 「ドキュメント」, the Docs tree and a page (WIKI.md §9.1).
// "attendance" (M140): 「在室状況」, the workspace's board (docs/PRESENCE.md §7).
type CentreView = "channel" | "threads" | "saved" | "activity" | "drafts" | "files" | "reminders" | "search" | "canvases" | "calendar" | "tasks" | "deadlines" | "times" | "reservations" | "docs" | "attendance" | "actions";
/** A message revealed in its conversation (the controller's focus): kept by a conversation's history entry (M67). */
type Focus = NonNullable<AppController["messageFocus"]>;

/**
 * What one screen of the narrow layout shows (M34: the selected tab's screens are live in MainScreen's state, the other
 * tabs' are kept as one of these). `pane` "list" is the tab's root.
 */
interface Nav {
  currentId: string | null;
  view: CentreView;
  threadId: string | null;
  threadChannelId: string | null;
  pinsOpen: boolean;
  pane: "list" | "main";
  filesChannelId: string | null;
  search: SearchParams | null;
  searchTab: SearchTab;
  backToSearch: boolean;
  tab: ConversationTab;
  details: boolean;
  results: SearchSnapshot | null;
}

/** A tab's root: its list, nothing of a conversation over it (the last conversation's id may stay, unopened). */
function rootNav(nav: Nav): Nav {
  return { ...nav, pane: "list", view: "channel", threadId: null, threadChannelId: null, pinsOpen: false, tab: "messages", details: false, backToSearch: false };
}

/** M67: the place a screen shows for the back / forward history (none on a phone's layout, or with no conversation open). */
function placeOf(nav: Pick<Nav, "currentId" | "view" | "search" | "filesChannelId">, focus: Focus | null, compact: boolean): Place<Focus> | null {
  if (compact) return null;
  const { currentId, view } = nav;
  if (view === "channel") return currentId ? { kind: "channel", channelId: currentId, focus: focus?.channelId === currentId ? focus : null } : null;
  return { kind: "view", view, search: view === "search" ? nav.search : null, filesChannelId: view === "files" ? nav.filesChannelId : null };
}

/** The place with the message it was revealed at: a change of either is recorded. */
function liveKey(place: Place<Focus>): string {
  return `${placeKey(place)}|${place.kind === "channel" ? (place.focus?.messageId ?? "") : ""}`;
}

const isRootNav = (nav: Nav) => nav.pane === "list";

type Dialog = "dm" | "channel" | "members" | "add-member" | "settings" | "topic" | "shortcuts" | "status" | "admin" | "rename" | "archive" | "leave" | "browse" | "directory" | "convert" | "link" | "recurring" | "feeds" | "workflows" | null;

const UNREAD_ONLY_KEY = "chikuwa.sidebar.unreadOnly";

function readUnreadOnly(): boolean {
  try {
    return localStorage.getItem(UNREAD_ONLY_KEY) === "1";
  } catch {
    return false;
  }
}

export function MainScreen({ controller }: { controller: AppController }) {
  const engine = controller.engine;
  const store = controller.store;
  // macOS: room for the window buttons, in full screen too (they show during the exit animation; README).
  const trafficLights = overlayTitleBar();
  const windowButtons = customTitleBar();
  const [currentId, setCurrentId] = useState<string | null>(() => engine?.currentChannelId ?? engine?.preview?.channelId ?? [...store.channels.values()].find((channel) => channel.isMember && !store.isDmClosed(channel.id))?.id ?? null);
  const [dialog, setDialog] = useState<Dialog>(null);
  // M93: the section the settings open on (「プロフィールを編集」 from my profile card opens 「プロフィール」).
  const [settingsSection, setSettingsSection] = useState<SettingsSection | undefined>(undefined);
  const [editingLink, setEditingLink] = useState<ChannelLinkOut | null>(null);
  const [threadId, setThreadId] = useState<string | null>(null);
  // "threads": the centre column lists followed threads (THREADS.md §5); the selected one opens on the right.
  const [view, setView] = useState<CentreView>("channel");
  /** M121: the Docs page on screen in 「ドキュメント」 (kept while other views are open). */
  const [docsPageId, setDocsPageId] = useState<string | null>(null);
  /** M11i: the channel the files view is scoped to (null: all my channels). */
  const [filesChannelId, setFilesChannelId] = useState<string | null>(null);
  const [threadChannelId, setThreadChannelId] = useState<string | null>(null);
  // M16b: the search on screen (view "search"), the open search box, and the way back from a result.
  const [search, setSearch] = useState<SearchParams | null>(null);
  const [searchTab, setSearchTab] = useState<SearchTab>("messages");
  const [searchOpen, setSearchOpen] = useState(false);
  const [backToSearch, setBackToSearch] = useState(false);
  const searchSnapshot = useRef<SearchSnapshot | null>(null);
  const recentStorageKey = recentKey(controller.accountKey ?? "");
  const [recent, setRecent] = useState(() => readRecent(recentStorageKey));
  const [pinsOpen, setPinsOpen] = useState(false);
  const [switcher, setSwitcher] = useState(false);
  const [unreadOnly, setUnreadOnly] = useState(readUnreadOnly);
  // M37, phones: 「移動・検索」 or ✏️'s picker over the screen, 「未読をまとめる」, and the recent conversations.
  const [homeOverlay, setHomeOverlay] = useState<"jump" | "compose" | null>(null);
  const [gatherUnread, setGatherUnread] = useState(readGatherUnread);
  const recentConversationsStorageKey = recentConversationsKey(controller.accountKey ?? "");
  const [recentConversations, setRecentConversations] = useState(() => readRecentConversations(recentConversationsStorageKey));
  /** Set when a conversation opens from ✏️: its input takes the focus once it is on screen. */
  const focusComposer = useRef(false);
  const [sidebarWidth, setSidebarWidth] = useState(readSidebarWidth);
  const [paneWidth, setPaneWidth] = useState(readPaneWidth);
  // Phones: one column at a time, the conversation list first; a conversation or a view covers it until 「戻る」.
  const compact = useCompact();
  const desktopRoot = useRef<HTMLDivElement>(null);
  const [availableWidth, setAvailableWidth] = useState(() => window.innerWidth);
  useLayoutEffect(() => {
    const root = desktopRoot.current;
    if (!root) return;
    const measure = () => setAvailableWidth(root.getBoundingClientRect().width);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(root);
    return () => observer.disconnect();
  }, [compact]);
  const columns = paneLayout(availableWidth, sidebarWidth, paneWidth, !!threadId || pinsOpen);
  // The conversation header's own width: with the thread pane open the centre narrows and its tabs and buttons fold
  // (headerFit) instead of overlapping (2026-10-02).
  const [headerWidth, setHeaderWidth] = useState(0);
  const headerObserver = useRef<ResizeObserver | null>(null);
  const headerRef = useCallback((el: HTMLElement | null) => {
    headerObserver.current?.disconnect();
    headerObserver.current = null;
    if (!el) return;
    const measure = () => setHeaderWidth(el.getBoundingClientRect().width);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    headerObserver.current = new ResizeObserver(measure);
    headerObserver.current.observe(el);
  }, []);
  const fit = headerFit(headerWidth);
  const [pane, setPane] = useState<"list" | "main">(() => (controller.messageFocus ? "main" : "list"));
  // M29, phones only: the conversation's tab (the timeline stays mounted under the others) and its details page.
  // M43: 「キャンバス」 is a tab on the wide layout too.
  const [tab, setTab] = useState<ConversationTab>("messages");
  /** M43: the canvas picked in each conversation this session (none: its tab canvas, else the newest). */
  const [canvasChoice, setCanvasChoice] = useState<Record<string, string | null>>({});
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [membersVersion, setMembersVersion] = useState(0);
  // M34, phones only: the bottom tab, and the other tabs' screens as they were left (the selected tab's are live above).
  const [mobileTab, setMobileTab] = useState<MobileTab>(() => (controller.messageFocus ? landingTab(store.getChannel(controller.messageFocus.channelId)) : "home"));
  const [savedTabs, setSavedTabs] = useState<Partial<Record<MobileTab, Nav>>>({});
  const [youPopToRoot, setYouPopToRoot] = useState(0);
  const navigation = { currentId, view, threadId, threadChannelId, pinsOpen, pane, filesChannelId, search, searchTab, backToSearch, tab, details: detailsOpen };
  const focus = controller.messageFocus;
  /** Put a screen on (a history entry coming back, a tab's screens coming back or landing). */
  const applyNav = (nav: Nav) => {
    setCurrentId(nav.currentId);
    setView(nav.view);
    setThreadId(nav.threadId);
    setThreadChannelId(nav.threadChannelId);
    setPinsOpen(nav.pinsOpen);
    setTab(nav.tab);
    setDetailsOpen(nav.details);
    setPane(nav.pane);
    setFilesChannelId(nav.filesChannelId);
    setSearch(nav.search);
    setSearchTab(nav.searchTab);
    setBackToSearch(nav.backToSearch);
    searchSnapshot.current = nav.results;
    setSearchOpen(false);
    setDialog(null);
    setSwitcher(false);
    setHomeOverlay(null);
  };
  /** The live screen of the selected tab. */
  const currentNav = (): Nav => ({ ...navigation, results: searchSnapshot.current });
  // One entry for 「ピン留め」 and 「ファイル」 together: Back from either returns to 「メッセージ」 first (M29). A tab
  // switch is an entry too (M34): Back after it returns to the tab before, with every tab's screens as they were then.
  const navigationKey = JSON.stringify({ ...navigation, mobileTab, tab: tab !== "messages", focus: focus?.messageId ?? null });
  // M67 / review v0.1.18 #13: the place a browser Back / Forward put back (its liveKey), until the places history takes
  // it as a move to its entry rather than a new visit.
  const browserRestored = useRef<string | null>(null);
  /** M75: the centre view (its place key) that back / forward just put back: its list returns to where it was. */
  const restoreView = useRef<string | null>(null);
  useNavigationHistory(navigationKey, { ...navigation, focus, results: searchSnapshot.current, mobileTab, savedTabs }, (previous) => {
    const restored = placeOf(previous, previous.focus, compactRef.current);
    const restoredKey = restored ? liveKey(restored) : null;
    // M75: a centre view the browser's Back / Forward put back comes back where it was scrolled to.
    restoreView.current = restored?.kind === "view" ? placeKey(restored) : null;
    browserRestored.current = restoredKey !== null && restoredKey !== livePlaceKeyRef.current ? restoredKey : null;
    controller.messageFocus = previous.focus;
    controller.setEditing(null);
    applyNav(previous);
    setMobileTab(previous.mobileTab);
    setSavedTabs(previous.savedTabs);
  }, isWeb());
  // The sidebar's views toggle back to the conversation on a desktop; on a phone a tap always opens them.
  const compactRef = useRef(compact);
  compactRef.current = compact;
  // A desktop window narrowed past the breakpoint keeps showing what was open, not the list.
  const wasCompact = useRef(compact);
  useEffect(() => {
    if (compact && !wasCompact.current) setPane("main");
    wasCompact.current = compact;
  }, [compact]);
  const back = compact
    ? () => {
        controller.setEditing(null);
        setPane("list");
      }
    : null;

  // M34: each tab's root stays mounted once shown (its scroll position survives), hidden while another is on screen.
  const tabRoots = useRef<Partial<Record<MobileTab, HTMLDivElement | null>>>({});
  const visitedTabs = useRef(new Set<MobileTab>(["home"]));
  visitedTabs.current.add(mobileTab);
  /** A tap on the bottom bar (MOBILE_UI.md §5): another tab brings its screens back; the selected one pops to its root, or scrolls it up. */
  const selectTab = (target: MobileTab, live: Nav = currentNav()) => {
    const result = tapTab({ tab: mobileTab, saved: savedTabs }, live, target, rootNav, isRootNav);
    // M40: 「自分」 again from one of its screens returns to its list (the tab's own stack, kept in YouView).
    if (result.scrollTop && target === "you") setYouPopToRoot((value) => value + 1);
    if (result.scrollTop) {
      for (const element of tabRoots.current[target]?.querySelectorAll<HTMLElement>("*") ?? []) {
        if (element.scrollTop <= 0) continue;
        if (typeof element.scrollTo === "function") element.scrollTo({ top: 0, behavior: "smooth" });
        else element.scrollTop = 0;
      }
      return;
    }
    if (controller.messageFocus) controller.clearMessageFocus();
    if (controller.editing) controller.setEditing(null);
    setMobileTab(result.stacks.tab);
    setSavedTabs(result.stacks.saved);
    applyNav(result.live);
  };
  /**
   * A notification, permalink or search result on a phone (M34 (7)): a DM on the DM tab, a channel (and its thread) on
   * the home tab, replacing that tab's screens; the other tabs keep theirs.
   */
  const land = (channelId: string, parentId: string | null, patch: Partial<Nav> = {}) => {
    const live = currentNav();
    const target = landingTab(store.getChannel(channelId));
    const screen: Nav = { ...rootNav(live), pane: "main", currentId: channelId, threadChannelId: channelId, threadId: parentId, ...patch };
    const result = landOn({ tab: mobileTab, saved: savedTabs }, live, target, screen);
    setMobileTab(result.stacks.tab);
    setSavedTabs(result.stacks.saved);
    applyNav(result.live);
  };

  // Drag the strip between the sidebar and the conversation to resize; double-click resets.
  const startResize = (event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = columns.sidebarWidth;
    let width = startWidth;
    const move = (e: PointerEvent) => {
      width = Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, availableWidth - CONVERSATION_MIN), Math.max(SIDEBAR_MIN, startWidth + e.clientX - startX));
      setSidebarWidth(width);
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      writeSidebarWidth(width);
    };
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  // The thread / pins pane is dragged by its left edge (wider to the left); the conversation keeps 360 px.
  const startPaneResize = (event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = columns.paneWidth;
    const max = Math.max(PANE_MIN, Math.min(PANE_MAX, availableWidth - columns.sidebarWidth - CONVERSATION_MIN));
    let width = startWidth;
    const move = (e: PointerEvent) => {
      width = Math.min(max, Math.max(PANE_MIN, startWidth - (e.clientX - startX)));
      setPaneWidth(width);
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      writePaneWidth(width);
    };
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const channels = [...store.channels.values()];
  const current: ChannelState | undefined = currentId ? store.getChannel(currentId) : undefined;
  // §7.6.1: a public channel I have not joined opens read-only (its preview), never for a guest (who cannot browse).
  const previewing = !!current && !current.isMember && current.type === "public" && !controller.isGuest;
  // The thread pane belongs to the current channel, or to the channel of the row picked in the threads view or the Times
  // feed (a feed row's thread is not in the conversation left open behind it).
  const threadChannel: ChannelState | undefined = view === "threads" || view === "times" ? (threadChannelId ? store.getChannel(threadChannelId) : undefined) : current;
  const status = engine?.status ?? "idle";
  const banner = useConnectionBanner(status);

  // The keyboard handler is registered once and reads the latest state through this ref.
  const state = useRef({ currentId, dialog, threadId, searchOpen, switcher, view, pinsOpen, tab, detailsOpen, compact, mobileTab, homeOverlay });
  state.current = { currentId, dialog, threadId, searchOpen, switcher, view, pinsOpen, tab, detailsOpen, compact, mobileTab, homeOverlay };
  /** A conversation always opens on 「メッセージ」, without its details page (M29). */
  const resetConversation = () => {
    setTab("messages");
    setDetailsOpen(false);
  };

  useEffect(() => {
    // Only a channel I belong to; a new member without channels sees the empty state (M12h invites).
    if (!currentId && channels.length > 0) {
      const first = channels.find((c) => c.isMember && !store.isDmClosed(c.id)) ?? channels.find((c) => c.isMember);
      if (first) setCurrentId(first.id);
    }
  }, [currentId, channels.length]);

  // The open channel left the store (I was removed, it was made private while I previewed it, bootstrap dropped it):
  // 「チャンネルを選択してください」 would otherwise keep its dead id, its thread and its preview. The effect above
  // then opens the first channel of mine.
  const currentGone = !!currentId && !current;
  useEffect(() => {
    if (!currentGone) return;
    if (engine?.preview?.channelId === currentId) engine.closePreview();
    setCurrentId(null);
    setThreadId(null);
    setThreadChannelId(null);
    setPinsOpen(false);
    resetConversation();
  }, [currentGone, currentId, engine]);

  // A row of this screen's lists being revealed is placed by its own handler (M34: an activity row stays on its tab).
  const revealing = useRef<string | null>(null);
  // A reply opened from a threads-list card: its thread is already open where the list put it (see landOnReply).
  const threadListFocus = useRef<string | null>(null);
  // A focus set outside this screen (a permalink opened in the browser, M12j): show its conversation. On a phone it
  // lands on its tab (M34), unless its conversation is the one on screen.
  useEffect(() => {
    const focus = controller.messageFocus;
    if (focus && threadListFocus.current === focus.messageId) return;
    if (focus) threadListFocus.current = null;
    if (!focus || (compact && revealing.current === focus.messageId)) return;
    if (focus.channelId === currentId && view === "channel" && (!compact || pane === "main")) {
      // Its conversation is already on screen (a notification's click while it was left open behind other apps, a
      // permalink to a reply in it): a reply still opens its thread, scrolled to and highlighting the reply (ThreadPane).
      // Before (2026-10-08), this returned at once and the timeline only showed the thread's root.
      if (focus.parentId !== null && (threadId !== focus.parentId || threadChannelId !== focus.channelId)) {
        setThreadChannelId(focus.channelId);
        setThreadId(focus.parentId);
      }
      return;
    }
    // M39: a reply opened from the activity tab: its thread is over that tab's root, and shows the reply itself.
    if (compact && mobileTab === "activity" && view === "threads" && pane === "main" && focus.parentId !== null && focus.parentId === threadId) return;
    if (compact) {
      land(focus.channelId, focus.parentId);
      return;
    }
    setPane("main");
    setView("channel");
    setSearchOpen(false);
    setPinsOpen(false);
    resetConversation();
    setCurrentId(focus.channelId);
    setThreadChannelId(focus.channelId);
    setThreadId(focus.parentId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [controller.messageFocus]);

  // M141: the DM on screen was just closed here (its ⋯ menu or its sidebar row): leave it as leaving a channel does.
  useEffect(() => {
    const id = controller.closedChannelRequest;
    if (!id) return;
    controller.closedChannelRequest = null;
    if (id !== currentId) return;
    setCurrentId(null);
    setThreadId(null);
    setThreadChannelId(null);
    setPinsOpen(false);
    resetConversation();
    setPane("list");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [controller.closedChannelRequest]);

  // M13b: a slash command (/join, /dm) asked for a conversation.
  useEffect(() => {
    const id = controller.openChannelRequest;
    if (!id) return;
    controller.openChannelRequest = null;
    open(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [controller.openChannelRequest]);

  // M44, the web: the browser keeps no store of unsaved canvas edits (CANVAS.md §5). Closing the tab sends them on a
  // keepalive request (pagehide); what such a request cannot carry (a conflict open, refused, too long) asks to stay.
  useEffect(() => {
    const hub = engine?.canvases;
    const api = controller.api;
    if (!isWeb() || !hub || !api) return;
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (!hub.mustStay && !engine?.wiki?.mustStay) return;
      event.preventDefault();
      event.returnValue = "";
    };
    const pageHide = () => {
      hub.unload((canvasId, body) => api.saveCanvasKeepalive(canvasId, body));
      engine?.wiki?.unload((pageId, body) => api.saveWikiPageKeepalive(pageId, body)); // M121: Docs pages too
    };
    window.addEventListener("beforeunload", beforeUnload);
    window.addEventListener("pagehide", pageHide);
    return () => {
      window.removeEventListener("beforeunload", beforeUnload);
      window.removeEventListener("pagehide", pageHide);
    };
  }, [engine, controller.api]);

  // M44: a canvas asked for from elsewhere (a /c/ link in a message or the browser's URL).
  useEffect(() => {
    const request = controller.openCanvasRequest;
    if (!request) return;
    controller.openCanvasRequest = null;
    openCanvas(request.channelId, request.canvasId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [controller.openCanvasRequest]);

  // A channel of mine opens through the member path; one I have not joined as its preview. Joining flips `previewing`,
  // and the conversation then loads like any other of mine. On a phone the engine's open conversation is the one on
  // the selected tab's screen, none at a tab's root (M34 (8), MOBILE_UI.md §10 1.).
  const engineChannelId = !compact || (pane === "main" && view === "channel") ? currentId : null;
  useEffect(() => {
    if (!engine) return;
    if (!engineChannelId) {
      if (compact) engine.closeChannel();
      return;
    }
    // M141 (SYNC_PROTOCOL.md §7.9): a closed DM opened on purpose (search, ⌘K, a profile, a link, a notification, the
    // history) shows in the lists again.
    if (!previewing) controller.reopenIfClosed(engineChannelId);
    const opened = previewing ? engine.openPreview(engineChannelId) : engine.openChannel(engineChannelId);
    void opened.catch((error) => controller.setError(error));
  }, [engineChannelId, engine, previewing, compact]);

  // M37: every conversation opened goes first in this device's 「最近の会話」 (per account).
  useEffect(() => {
    if (engineChannelId) setRecentConversations(pushRecentConversation(recentConversationsStorageKey, engineChannelId));
  }, [engineChannelId, recentConversationsStorageKey]);

  // M37: a conversation opened from ✏️ gets its input focused once it is on screen.
  useEffect(() => {
    if (!focusComposer.current || pane !== "main" || view !== "channel") return;
    focusComposer.current = false;
    const timer = setTimeout(() => document.querySelector<HTMLElement>(".composer [data-composer-input]")?.focus(), 0);
    return () => clearTimeout(timer);
  }, [currentId, pane, view, mobileTab]);

  const open = (id: string) => {
    controller.clearMessageFocus();
    controller.setEditing(null);
    setCurrentId(id);
    setThreadId(null);
    setThreadChannelId(null);
    setPinsOpen(false);
    resetConversation();
    setView("channel");
    setSwitcher(false);
    setBackToSearch(false);
    setPane("main");
  };

  /**
   * M44: a canvas in its conversation's 「キャンバス」 tab (a search hit, ⌘K, a /c/ link, the 「キャンバス」 list). On a
   * phone it lands on the conversation's tab as a notification does; from the search the way back stays.
   */
  const openCanvas = (channelId: string, canvasId: string, options: { fromSearch?: boolean } = {}) => {
    setCanvasChoice((choice) => ({ ...choice, [channelId]: canvasId }));
    if (compactRef.current) {
      controller.clearMessageFocus();
      controller.setEditing(null);
      setHomeOverlay(null);
      setSwitcher(false);
      land(channelId, null, { tab: "canvas", ...(options.fromSearch ? { backToSearch: true, search, searchTab, results: searchSnapshot.current } : {}) });
      return;
    }
    open(channelId);
    setTab("canvas");
    if (options.fromSearch) setBackToSearch(true);
  };

  /** M55: a channel's 「タスク」 tab (a group of 「自分の担当」, a notification); on a phone it lands as a notification does. */
  const openTasksTab = (channelId: string) => {
    if (compactRef.current) {
      controller.clearMessageFocus();
      controller.setEditing(null);
      setHomeOverlay(null);
      setSwitcher(false);
      land(channelId, null, { tab: "tasks" });
      return;
    }
    open(channelId);
    setTab("tasks");
  };

  /** M55: a task's message: back to 「メッセージ」 first (the board may cover the very conversation it is in). */
  const openTaskMessage = (messageId: string) => {
    setTab("messages");
    void controller.openPermalink(messageId);
  };

  /** M55: the task a notification asked for, in its dialog over its board's tab (a personal one over 「タスク」). */
  const [taskDialog, setTaskDialog] = useState<TaskOut | null>(null);
  /** M85: ⋯ 「締切を追加…」 (a new deadline on the open channel's board). */
  const [deadlineInit, setDeadlineInit] = useState<TaskCreateInit | null>(null);
  /**
   * M121: a Docs page (a `page:` link, a /p/ permalink, a notification, an activity item, a search hit): 「ドキュメント」
   * with that page, whatever was on screen (on a phone too: the view covers the tab's list).
   */
  const openDocsPage = (pageId: string | null) => {
    controller.clearMessageFocus();
    controller.setEditing(null);
    setThreadId(null);
    setThreadChannelId(null);
    setSearchOpen(false);
    setSwitcher(false);
    setHomeOverlay(null);
    setBackToSearch(false);
    setPinsOpen(false);
    resetConversation();
    setDocsPageId(pageId);
    setPane("main");
    setView("docs");
  };
  useEffect(() => {
    const request = controller.openPageRequest;
    if (!request) return;
    controller.openPageRequest = null;
    openDocsPage(request.pageId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [controller.openPageRequest]);
  // M112: a reservation notification (or activity item) asked for 「予約」.
  const reservationsAsked = useRef(controller.openReservationsRequest);
  useEffect(() => {
    if (controller.openReservationsRequest === reservationsAsked.current) return;
    reservationsAsked.current = controller.openReservationsRequest;
    openView("reservations");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [controller.openReservationsRequest]);
  useEffect(() => {
    const request = controller.openTaskRequest;
    if (!request) return;
    controller.openTaskRequest = null;
    const channel = request.channelId ? store.getChannel(request.channelId) : undefined;
    // L9: a DM's task has no board: over 「タスク」 like a personal one.
    if (channel?.isMember && !isDmChannel(channel)) openTasksTab(channel.id);
    else if (view !== "tasks") openView("tasks");
    void controller.loadTask(request.taskId).then((task) => { if (task) setTaskDialog(task); });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [controller.openTaskRequest]);

  /** M44: the comments of a canvas are its shared message's thread, beside the canvas (over it on a phone). */
  const openCanvasThread = (channelId: string, messageId: string) => {
    controller.clearMessageFocus();
    setPinsOpen(false);
    setThreadChannelId(channelId);
    setThreadId(messageId);
  };

  /**
   * M37, a phone: a conversation picked in 「移動・検索」 or ✏️ lands where it belongs (a DM on the DM tab, a channel on
   * the home tab), as a notification does.
   */
  const openLanded = (id: string, options: { focusComposer?: boolean } = {}) => {
    controller.clearMessageFocus();
    controller.setEditing(null);
    setHomeOverlay(null);
    focusComposer.current = !!options.focusComposer;
    land(id, null);
  };

  const openSaved = () => {
    controller.clearMessageFocus();
    controller.setEditing(null);
    setThreadId(null);
    setThreadChannelId(null);
    setSearchOpen(false);
    setBackToSearch(false);
    setPinsOpen(false);
    resetConversation();
    setPane("main");
    setView((v) => (v === "saved" && !compactRef.current ? "channel" : "saved"));
  };

  /** A card in the pins pane / saved view (or a phone's pins / files tab): show the message in its conversation. */
  const revealFromList = (message: MessageOut) => {
    revealing.current = message.id;
    void controller.revealMessage(message).then((ok) => {
      revealing.current = null;
      if (!ok) return;
      if (compactRef.current) setPane("main"); // from the activity tab's mentions (M34): onto that tab's screens
      setView("channel");
      setSearchOpen(false);
      setBackToSearch(false);
      setPinsOpen(false);
      resetConversation();
      setCurrentId(message.channel_id);
      setThreadChannelId(message.channel_id);
      setThreadId(message.parent_id ?? null);
    });
  };

  /**
   * A live result under the search box (or in a phone's 「移動・検索」): the message in its conversation, as a result of
   * the results page opens, without 「検索結果に戻る」 (no results page was shown). The words go to the recent searches.
   */
  const openLiveResult = (message: MessageOut, other: ChannelOut | undefined, q: string) => {
    // A channel I have not joined opens as its preview (M27): the store learns of it first.
    if (other && !store.getChannel(message.channel_id)) store.upsertChannel(other, { isMember: false });
    if (q) setRecent(pushRecent(recentStorageKey, { ...EMPTY_SEARCH, q }));
    if (!compactRef.current) return revealFromList(message);
    revealing.current = message.id;
    void controller.revealMessage(message).then((ok) => {
      revealing.current = null;
      if (!ok) return;
      setHomeOverlay(null);
      land(message.channel_id, message.parent_id ?? null);
    });
  };

  /** M16b: run a search from the box; the results take the centre column. */
  const runSearch = (params: SearchParams) => {
    controller.clearMessageFocus();
    controller.setEditing(null);
    searchSnapshot.current = null;
    setRecent(pushRecent(recentStorageKey, params));
    setSearch(params);
    setThreadId(null);
    setThreadChannelId(null);
    setPinsOpen(false);
    resetConversation();
    setBackToSearch(false);
    setView("search");
    setPane("main");
  };

  /** A result: its conversation (or thread) around the message, with 「検索結果に戻る」. */
  const openSearchResult = (message: MessageOut) => {
    revealing.current = message.id;
    void controller.revealMessage(message).then((ok) => {
      revealing.current = null;
      if (!ok) return;
      // A phone: on the result's tab (M34 (7)); the search stays on the home tab's screens.
      if (compactRef.current) {
        land(message.channel_id, message.parent_id ?? null, { backToSearch: true, search, searchTab, results: searchSnapshot.current });
        return;
      }
      setView("channel");
      setPinsOpen(false);
      resetConversation();
      setCurrentId(message.channel_id);
      setThreadChannelId(message.channel_id);
      setThreadId(message.parent_id ?? null);
      setBackToSearch(true);
    });
  };

  const openFiles = (channelId: string | null) => {
    controller.clearMessageFocus();
    controller.setEditing(null);
    setThreadId(null);
    setThreadChannelId(null);
    setSearchOpen(false);
    setBackToSearch(false);
    setPinsOpen(false);
    resetConversation();
    setFilesChannelId(channelId);
    setView("files");
    setPane("main");
  };

  const openView = (next: "activity" | "drafts" | "reminders" | "canvases" | "calendar" | "tasks" | "deadlines" | "times" | "reservations" | "docs" | "attendance" | "actions") => {
    controller.clearMessageFocus();
    controller.setEditing(null);
    setThreadId(null);
    setThreadChannelId(null);
    setSearchOpen(false);
    setBackToSearch(false);
    setPinsOpen(false);
    resetConversation();
    setPane("main");
    setView((v) => (v === next && !compactRef.current ? "channel" : next));
  };

  const openThreads = () => {
    controller.clearMessageFocus();
    controller.setEditing(null);
    setThreadId(null);
    setThreadChannelId(null);
    setSearchOpen(false);
    setBackToSearch(false);
    resetConversation();
    setPane("main");
    setView((v) => (v === "threads" && !compactRef.current ? "channel" : "threads"));
  };

  /** L8: 「N 件の返信」 or 「スレッドで返信」 on a row of the Times feed: its thread beside the feed (over it on a phone). */
  const openFeedThread = (channelId: string, parentId: string) => {
    controller.clearMessageFocus();
    controller.setEditing(null);
    setThreadChannelId(channelId);
    setThreadId(parentId);
  };

  /** L8: 「自分の times を作る」 (from the feed's header too): made on the server, then it opens. */
  const createTimes = () => void controller.ensureTimes().then((id) => { if (id) open(id); });

  /**
   * A reply under a threads-list card (THREADS.md §5): its thread opens at once and lands on the reply when the focus comes
   * (the thread pane scrolls to and marks the focused reply). The view stays where it is: the focus effect above leaves a
   * focus marked here alone.
   */
  const landOnReply = (reply: MessageState | undefined) => {
    if (!reply || reply.seq === null) return;
    threadListFocus.current = reply.id;
    void controller.revealMessage(reply as MessageOut);
  };

  const openThreadEntry = (entry: ThreadEntry, reply?: MessageState) => {
    controller.clearMessageFocus();
    setThreadChannelId(entry.state.channel_id);
    setThreadId(entry.parent.id);
    landOnReply(reply);
  };

  /** M34: a thread row of the activity tab: the thread goes over that tab's root. */
  const openActivityThread = (entry: ThreadEntry, reply?: MessageState) => {
    controller.clearMessageFocus();
    controller.setEditing(null);
    resetConversation();
    setPinsOpen(false);
    setBackToSearch(false);
    setView("threads");
    setThreadChannelId(entry.state.channel_id);
    setThreadId(entry.parent.id);
    setPane("main");
    landOnReply(reply);
  };

  /**
   * M39, a row of the activity: its message, revealed in its conversation (a reply: in its thread). On a phone a reply's
   * thread goes over the activity tab's root, as a thread row of stage A did; anything else opens its conversation on
   * that tab's screens.
   */
  const openActivityItem = (item: ActivityItem) => {
    // M112: a reservation notice opens 「予約」.
    if (item.reservation) {
      openView("reservations");
      return;
    }
    // M121: a page mention or a page shared with me opens the page.
    if (item.page) {
      openDocsPage(item.page.page_id);
      return;
    }
    // M76: a canvas mention opens the canvas (as its notification does).
    if (item.canvas) {
      openCanvas(item.canvas.channel_id, item.canvas.canvas_id);
      return;
    }
    const message = item.message;
    if (!message) return;
    if (!compactRef.current || !message.parent_id) {
      revealFromList(message);
      return;
    }
    const parentId = message.parent_id;
    revealing.current = message.id;
    void controller.revealMessage(message).then((ok) => {
      revealing.current = null;
      if (!ok) return;
      controller.setEditing(null);
      resetConversation();
      setPinsOpen(false);
      setBackToSearch(false);
      setSearchOpen(false);
      setView("threads");
      setThreadChannelId(message.channel_id);
      setThreadId(parentId);
      setPane("main");
    });
  };

  /** The thread's ← / ✕ / Esc: back to what is under it (on a phone's activity tab, its root). */
  const closeThread = () => {
    const s = state.current;
    if (s.compact && s.mobileTab === "activity" && s.view === "threads") {
      setThreadId(null);
      setThreadChannelId(null);
      setView("channel");
      setPane("list");
    } else setThreadId(null);
  };

  // M67: back / forward between places (a conversation or a centre view), the wide layout only. The place on screen is
  // recorded whatever opened it (the sidebar, ⌘K, a permalink, Alt+↑↓, a search result); a restored entry is the same
  // place again, so recording it adds nothing. A phone's layout has its own back (the bottom tabs' stacks, and the
  // browser's history on the web) and records nothing here.
  const [places, setPlaces] = useState<PlaceHistory<Focus>>(emptyHistory);
  const livePlace = placeOf(navigation, focus, compact);
  const livePlaceRef = useRef(livePlace);
  livePlaceRef.current = livePlace;
  const livePlaceKey = livePlace ? liveKey(livePlace) : null;
  const livePlaceKeyRef = useRef(livePlaceKey);
  livePlaceKeyRef.current = livePlaceKey;
  useEffect(() => {
    const place = livePlaceRef.current;
    // On the web, a place the browser's Back / Forward restored moves the in-app history to its entry (else C → D → E,
    // browser Back to D, made C, D, E, D: the in-app Forward was off and Back went to E). Tauri has no such restore.
    const restored = browserRestored.current !== null && browserRestored.current === livePlaceKey;
    browserRestored.current = null;
    if (place) setPlaces((history) => (restored ? restore(history, place) : visit(history, place)));
  }, [livePlaceKey]);
  /** A conversation can be shown again while it is in the store and readable (mine, or a public one to preview). */
  const placeAvailable = (place: Place<Focus>): boolean => {
    const readable = (id: string) => {
      const channel = store.getChannel(id);
      return !!channel && (channel.isMember || (channel.type === "public" && !controller.isGuest));
    };
    if (place.kind === "channel") return readable(place.channelId);
    return place.view !== "files" || !place.filesChannelId || readable(place.filesChannelId);
  };
  /** A place back on screen as a plain open shows it (a conversation lands as on opening, or at the message it was revealed at). */
  const showPlace = (place: Place<Focus>) => {
    restoreView.current = place.kind === "view" ? placeKey(place) : null;
    setSearchOpen(false);
    setSwitcher(false);
    if (place.kind === "channel") {
      open(place.channelId);
      if (place.focus) {
        controller.messageFocus = place.focus;
        setThreadChannelId(place.channelId);
        setThreadId(place.focus.parentId);
      }
      return;
    }
    controller.clearMessageFocus();
    controller.setEditing(null);
    setThreadId(null);
    setThreadChannelId(null);
    setBackToSearch(false);
    setPinsOpen(false);
    resetConversation();
    setPane("main");
    if (place.view === "search") {
      searchSnapshot.current = null;
      setSearch(place.search);
    }
    if (place.view === "files") setFilesChannelId(place.filesChannelId);
    setView(place.view);
  };
  // M75: a centre view's list position, recorded while it is on screen (the wide layout) and put back when back /
  // forward returns to it (opened from the sidebar, it starts at its top). A conversation keeps its own (Timeline).
  const viewRoot = useRef<HTMLDivElement>(null);
  const viewScrollKey = livePlace?.kind === "view" ? placeKey(livePlace) : null;
  useViewScrollMemory(viewRoot, scrollMemoryFor(controller.activeServer ?? ""), viewScrollKey, () => {
    const asked = restoreView.current !== null && restoreView.current === viewScrollKey;
    restoreView.current = null;
    return asked;
  });
  const canGoBack = !compact && canGo(places, -1, placeAvailable);
  const canGoForward = !compact && canGo(places, 1, placeAvailable);
  const goHistory = (step: -1 | 1) => {
    const moved = go(places, step, placeAvailable);
    if (!moved) return;
    setPlaces(moved.history);
    showPlace(moved.place);
  };
  const goHistoryRef = useRef(goHistory);
  goHistoryRef.current = goHistory;
  const selectTabRef = useRef(selectTab);
  selectTabRef.current = selectTab;
  const historyLabels = historyShortcutLabels();

  const toggleUnreadOnly = () => {
    setUnreadOnly((value) => {
      try {
        localStorage.setItem(UNREAD_ONLY_KEY, value ? "0" : "1");
      } catch {
        /* per-viewer convenience only */
      }
      return !value;
    });
  };

  useEffect(() => {
    const navigationOrder = () => {
      const all = [...controller.store.channels.values()];
      const store = controller.store;
      const sections = sectionChannels(all, { favorites: store.favorites, sections: store.sidebarSections, defaults: store.sidebarDefaults, meId: store.me?.id ?? null, title: (c) => channelTitle(c, controller), dmPins: store.dmPins, closedDms: store.closedDms });
      return [...sections.favorites, ...sections.custom.flatMap((group) => group.channels), ...sections.channels, ...sections.times, ...sections.dms];
    };
    const onKey = (event: KeyboardEvent) => {
      // An open menu or popover (Radix) has already used this Esc to close itself.
      if (event.key === "Escape" && event.defaultPrevented) return;
      // Esc during an IME conversion cancels the conversion only (the search box stays open, nothing is marked read).
      if (event.key === "Escape" && isImeKeyEvent(event)) return;
      const mod = event.metaKey || event.ctrlKey;
      const key = event.key.toLowerCase();
      const s = state.current;
      // A dialog or the switcher on top has the keyboard: the shortcuts that open or move things would act under it
      // (the search box under a modal, a channel switched behind the settings). Esc and ⌘/ still work there.
      const covered = !!s.dialog || s.switcher || !!s.homeOverlay;
      // M67: back / forward, the wide layout only (a phone-width web page leaves ⌘[ / Alt+← to the browser, whose
      // history is that layout's back). Kept from the browser under a dialog too, where they do nothing.
      const step = s.compact ? null : historyStep(event);
      if (step !== null) {
        event.preventDefault();
        if (!covered) goHistoryRef.current(step);
        return;
      }
      if (event.key === "F6" && !mod && !event.altKey && !covered && !s.searchOpen) {
        if (focusChatRegion(event.shiftKey)) event.preventDefault();
      } else if (mod && !event.shiftKey && !event.altKey && /^[1-9]$/.test(event.key) && controller.multiWorkspace) {
        // M16c: ⌘1 … ⌘9 open the n-th workspace of the rail (Slack).
        event.preventDefault();
        controller.switchToIndex(Number(event.key) - 1);
      } else if (mod && !event.shiftKey && key === "k" && !covered) {
        event.preventDefault();
        setSwitcher(true);
      } else if (mod && event.shiftKey && key === "k" && !covered) {
        event.preventDefault();
        setDialog("dm");
      } else if (mod && !event.shiftKey && key === "f" && !covered) {
        event.preventDefault();
        // A phone has no search box: 「移動・検索」 is the way in (M37).
        if (s.compact) setHomeOverlay("jump");
        else setSearchOpen(true);
      } else if (mod && event.shiftKey && key === "t" && !covered) {
        event.preventDefault();
        openThreads();
      } else if (mod && event.shiftKey && key === "e" && !covered) {
        event.preventDefault();
        setDialog("browse");
      } else if (mod && event.shiftKey && key === "l" && !covered) {
        event.preventDefault();
        document.querySelector<HTMLElement>(".composer [data-composer-input]")?.focus();
      } else if (mod && key === "/") {
        event.preventDefault();
        setDialog((d) => (d === "shortcuts" ? null : "shortcuts"));
      } else if (event.altKey && (event.key === "ArrowUp" || event.key === "ArrowDown") && !covered) {
        event.preventDefault();
        const next = stepChannel(navigationOrder(), s.currentId, event.key === "ArrowDown" ? 1 : -1, { unreadOnly: event.shiftKey, meId: controller.store.me?.id ?? null });
        if (next) open(next.id);
      } else if (event.key === "Escape") {
        if (s.switcher) setSwitcher(false);
        else if (s.dialog) setDialog(null);
        else if (s.homeOverlay) setHomeOverlay(null);
        else if (s.searchOpen) setSearchOpen(false);
        else if (s.detailsOpen) setDetailsOpen(false);
        else if (s.pinsOpen) setPinsOpen(false);
        else if (s.threadId) closeThread();
        else if (controller.editing) controller.setEditing(null);
        else if (s.tab !== "messages") setTab("messages");
        else if (s.view !== "channel") setView("channel");
        else if (s.currentId) {
          // Nothing to close: Esc marks the open conversation read (Mattermost).
          const channel = controller.store.getChannel(s.currentId);
          // Anything unread, also quiet (M24) or muted rows without a mention.
          if (channel && channel.unreadCount > 0) controller.engine?.markRead(channel.id, channel.lastSeq, { force: true });
        }
      }
    };
    const onSwitch = () => setSwitcher(true);
    // Profile cards (UserPopover) ask the screen to open a DM or the status editor.
    const onOpenChannel = (event: Event) => open(String((event as CustomEvent<string>).detail));
    const onOpenStatus = () => setDialog("status");
    const onOpenProfile = () => {
      if (state.current.compact) selectTabRef.current("you");
      else {
        setSettingsSection("profile");
        setDialog("settings");
      }
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("chikuwa:quick-switch", onSwitch);
    window.addEventListener("chikuwa:open-channel", onOpenChannel);
    window.addEventListener("chikuwa:open-status", onOpenStatus);
    window.addEventListener("chikuwa:open-profile", onOpenProfile);
    // M67: the mouse's back / forward buttons in the desktop app (a browser makes them its own Back / Forward, which the
    // web build's history entries already follow).
    const onMouse = (event: MouseEvent) => {
      const step = mouseHistoryStep(event.button);
      const s = state.current;
      if (step === null || s.compact) return;
      event.preventDefault();
      if (!s.dialog && !s.switcher && !s.homeOverlay) goHistoryRef.current(step);
    };
    if (!isWeb()) window.addEventListener("mouseup", onMouse);
    return () => {
      window.removeEventListener("mouseup", onMouse);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("chikuwa:quick-switch", onSwitch);
      window.removeEventListener("chikuwa:open-channel", onOpenChannel);
      window.removeEventListener("chikuwa:open-status", onOpenStatus);
      window.removeEventListener("chikuwa:open-profile", onOpenProfile);
    };
  }, [controller]);

  /** 「#name に参加する」 under a preview: the same conversation goes on as one of mine. */
  const join = async (id: string) => {
    if (!(await controller.joinChannel(id))) return;
    setCurrentId(id);
    resetConversation();
    setPane("main");
  };

  const replyToLast = () => {
    if (!current) return;
    const last = store.messages(current.id).filter((m) => !m.pending && !m.deleted).at(-1);
    if (last) setThreadId(last.id);
  };

  const muteLabel = current ? formatMuted(current.mutedUntil) : null;
  // M35: the conversation's own level (null = follows my overall setting) and what it comes to.
  const ownLevel: NotificationLevel | null = current?.notificationLevel ?? null;
  const overall = overallLevel(store.me ?? controller.me);
  const silenced = !!current && (effectiveNotificationLevel(current, store.me?.id ?? null, overall) === "none" || isMutedChannel(current));
  const isChannel = current?.type === "public" || current?.type === "private";
  // M141 「会話を閉じる」: DMs and group DMs of mine, on a server that has closes (bootstrap's closed_dms).
  const closable = !!current && isDmChannel(current) && current.isMember && store.closedDms !== null;
  // M51: the channel's events today and tomorrow, for the 「予定」 tab's count (read when it opens, kept by the hub).
  const calendar = useCalendarHub(controller);
  const upcomingChannelId = current && current.isMember && isChannel && view === "channel" ? current.id : null;
  useEffect(() => {
    if (calendar && upcomingChannelId && engine?.status === "online") void calendar.loadUpcoming(upcomingChannelId);
  }, [calendar, upcomingChannelId, engine?.status]);
  const upcomingCount = upcomingChannelId ? (calendar?.upcomingOf(upcomingChannelId)?.length ?? 0) : 0;
  // M142: owners, and channels.manage (administrators and managers; docs/ROLES.md §2).
  const canManage = !!current && (current.membership?.role === "owner" || canManageChannelByRight(current, (capability) => controller.can(capability)));
  const [busyAction, setBusyAction] = useState(false);

  const dmOther = current && isDmChannel(current) ? (current.dm_user_ids ?? []).filter((id) => id !== store.me?.id) : [];

  const searchBar = (
    <SearchBar
      controller={controller}
      current={view === "search" || backToSearch ? search : null}
      open={searchOpen}
      onOpenChange={setSearchOpen}
      onSearch={runSearch}
      onOpenMessage={openLiveResult}
      recent={recent}
      onRecentChange={setRecent}
      recentKey={recentStorageKey}
      placeholder={t("main.searchIn", { workspace: controller.workspaceName })}
    />
  );
  const sidebar = (
    <Sidebar
      controller={controller}
      channels={channels}
      currentId={compact ? null : currentId}
      unreadOnly={unreadOnly}
      onToggleUnreadOnly={toggleUnreadOnly}
      onOpen={open}
      onNewDm={() => setDialog("dm")} onDirectory={() => setDialog("directory")}
      onNewChannel={() => setDialog("channel")}
      onCreateTimes={createTimes}
      onTimesFeed={() => openView("times")}
      timesFeedActive={view === "times"}
      onSettings={() => (compact ? selectTab("you") : setDialog("settings"))}
      onThreads={openThreads}
      threadsActive={view === "threads"}
      onSaved={openSaved}
      savedActive={view === "saved"}
      onAdmin={() => setDialog("admin")}
      onBrowse={() => setDialog("browse")}
      onActivity={compact ? undefined : () => openView("activity")}
      activityActive={view === "activity"}
      onDrafts={() => openView("drafts")}
      draftsActive={view === "drafts"}
      onFiles={() => (view === "files" && !compact ? setView("channel") : openFiles(null))}
      filesActive={view === "files"}
      onCanvases={() => openView("canvases")}
      canvasesActive={view === "canvases"}
      onDocs={engine?.wiki?.available ? () => openView("docs") : undefined}
      docsActive={view === "docs"}
      onCalendar={() => openView("calendar")}
      calendarActive={view === "calendar"}
      onTasks={() => openView("tasks")}
      tasksActive={view === "tasks"}
      onDeadlines={() => openView("deadlines")}
      deadlinesActive={view === "deadlines"}
      onReservations={store.reservationPools ? () => openView("reservations") : undefined}
      reservationsActive={view === "reservations"}
      reservationsCount={reservationTodoCount(store.reservationPools)}
      onAttendance={store.attendance ? () => openView("attendance") : undefined}
      attendanceActive={view === "attendance"}
      attendanceCount={store.attendance ? inRoomCount(store.attendance, store.users.values()) : 0}
      onActions={pressable(store.actions).length ? () => openView("actions") : undefined}
      actionsActive={view === "actions"}
      onReadAll={() => void controller.markAllRead()}
      onReminders={() => openView("reminders")}
      remindersActive={view === "reminders"}
    />
  );
  // The channel's own ⋯ items (on a phone they follow the conversation items in the same menu).
  const channelMenuItems = current ? (
    <>
      {!current.archived && <MenuItem onSelect={() => setDialog("topic")}>{t("channel.editTopic")}</MenuItem>}
      {canManage && !current.archived && <MenuItem onSelect={() => setDialog("rename")}>{t("channel.rename")}</MenuItem>}
      <MenuItem onSelect={() => setDialog("members")}>{t("channel.members")}</MenuItem>
      {(current.type === "public" || current.type === "private") && current.isMember && <MenuItem onSelect={() => setDialog("recurring")}>{t("channel.recurringMenu")}</MenuItem>}
      {(current.type === "public" || current.type === "private") && <MenuItem onSelect={() => setDialog("feeds")}>{t("channel.feedsMenu")}</MenuItem>}
      {(current.type === "public" || current.type === "private") && <MenuItem onSelect={() => setDialog("workflows")}>{t("channel.workflowsMenu")}</MenuItem>}
      {(current.type === "public" || current.type === "private") && current.isMember && canEditBoard(current, controller.isAdmin) && !!controller.engine?.tasks?.available && (
        <MenuItem onSelect={() => setDeadlineInit(newDeadlineInit(controller, current.id))}>{t("channel.addDeadline")}</MenuItem>
      )}
      {canEditLinks(current, controller) && <MenuItem onSelect={() => { setEditingLink(null); setDialog("link"); }}>{t("channel.addLink")}</MenuItem>}
      {canManage && !current.archived && (
        <MenuItem onSelect={() => void controller.setPostingPolicy(current.id, current.posting_policy === "owners" ? "everyone" : "owners")}>
          {current.posting_policy === "owners" ? t("channel.postingEveryone") : current.times_owner_id ? t("channel.postingTimesOwner") : t("channel.postingOwners")}
        </MenuItem>
      )}
      {canManage && current.type === "public" && <MenuItem onSelect={() => setDialog("convert")}>{t("channel.convertToPrivate")}</MenuItem>}
      {canMakePublic(current, controller.isAdmin) && <MenuItem onSelect={() => setDialog("convert")}>{t("channel.convertToPublic")}</MenuItem>}
      <MenuSeparator />
      <MenuItem onSelect={() => setDialog("leave")}>{t("channel.leave")}</MenuItem>
      {canManage && !current.archived && <MenuItem className="text-danger" onSelect={() => setDialog("archive")}>{t("channel.archive")}</MenuItem>}
      {canManage && current.archived && <MenuItem onSelect={() => void controller.unarchiveChannel(current.id)}>{t("channel.unarchive")}</MenuItem>}
    </>
  ) : null;
  // The thread or the pinned messages: a resizable column on the right, the whole screen on a phone (where the pins are
  // a tab of the conversation instead, M29).
  const sidePane =
    pinsOpen && !compact && current && view === "channel" ? (
      <PinsPane controller={controller} channel={current} onOpen={revealFromList} onClose={() => setPinsOpen(false)} />
    ) : threadId && threadChannel && threadChannel.isMember ? (
      <ThreadPane controller={controller} channel={threadChannel} parentId={threadId} onClose={closeThread} />
    ) : threadId && threadChannel && previewing && threadChannel.id === current?.id ? (
      <PreviewThreadPane controller={controller} channel={threadChannel} parentId={threadId} onClose={closeThread} />
    ) : null;
  // M29, phones: the conversation's tab row and details page (joined conversations, not a preview).
  const tabbed = compact && !!current && current.isMember && !previewing;
  const showDetails = tabbed && detailsOpen && view === "channel";
  // M43: the wide layout has 「メッセージ | キャンバス」 in the header (its pins and files stay a pane and a view).
  const canvasTab = !!current && current.isMember && !previewing;
  const headerTabs: ReadonlyArray<readonly [ConversationTab, string]> = [
    ["messages", t("main.tab.messages")],
    ["canvas", t("main.tab.canvas")],
    ...(isChannel ? [["events", eventsTabLabel(upcomingCount)] as const, ["tasks", t("main.tab.tasks")] as const] : []),
  ];
  // Too narrow a header moves pins, files, members and the shortcuts button into ⋯ (headerFit).
  const tightHeader = !compact && fit === "tight";
  const shownTab: ConversationTab = tabbed
    ? (tab === "events" || tab === "tasks") && !isChannel ? "messages" : tab
    : canvasTab && (tab === "canvas" || ((tab === "events" || tab === "tasks") && isChannel)) ? tab : "messages";
  // Nothing of the conversation counts as seen while another tab or a page covers it (SYNC_PROTOCOL.md §10.1 2.).
  const conversationOnScreen = shownTab === "messages" && (!compact || (!showDetails && !sidePane));
  const openDetails = () => {
    controller.setEditing(null);
    setDetailsOpen(true);
  };
  const addLink = () => {
    setEditingLink(null);
    setDialog("link");
  };
  const editLink = (link: ChannelLinkOut) => {
    setEditingLink(link);
    setDialog("link");
  };
  const centre = (
    <>
      {banner && (
        <div className={cn("px-4 py-1 text-center text-xs font-medium text-white", banner === "connecting" ? "bg-accent-solid" : "bg-warning")}>
          {banner === "connecting" ? t("connection.connectingLong") : t("connection.offlineWaiting")}
        </div>
      )}
      {/* M75: box-less, only to find the centre view's list (useViewScrollMemory). */}
      <div ref={viewRoot} className="contents">
      {view === "search" && search ? (
        <SearchView
          controller={controller}
          params={search}
          tab={searchTab}
          onTabChange={setSearchTab}
          onChange={setSearch}
          onOpen={openSearchResult}
          onOpenCanvas={(canvas) => openCanvas(canvas.channel_id, canvas.id, { fromSearch: true })}
          onOpenPage={engine?.wiki?.available ? (page) => openDocsPage(page.id) : undefined}
          onClose={() => {
            setView("channel");
            if (compact) setPane("list");
          }}
          snapshot={searchSnapshot}
        />
      ) : view === "threads" && compact && mobileTab === "activity" ? (
        // M34: a thread from the activity tab covers this; the tab's own list is under it.
        null
      ) : view === "threads" ? (
        <ThreadsView controller={controller} selectedId={threadId} onOpen={openThreadEntry} onOpenChannel={(entry) => revealFromList(entry.parent)} />
      ) : view === "saved" ? (
        <SavedView controller={controller} onOpen={revealFromList} />
      ) : view === "times" ? (
        <TimesFeedView controller={controller} onReveal={(message) => revealFromList(message as MessageOut)} onOpenThread={openFeedThread} onOpenChannel={open} onCreateTimes={createTimes} />
      ) : view === "activity" ? (
        store.activity ? (
          <ActivityView controller={controller} active onOpen={openActivityItem} onOpenMessage={revealFromList} onOpenThread={openActivityThread} />
        ) : (
          <MentionsView controller={controller} onOpen={revealFromList} />
        )
      ) : view === "reminders" ? (
        <RemindersView controller={controller} onOpen={(row) => void controller.openPermalink(row.message_id)} />
      ) : view === "files" ? (
        <FilesView controller={controller} channelId={filesChannelId} onChannelChange={setFilesChannelId} onOpen={revealFromList} />
      ) : view === "canvases" ? (
        <CanvasesView
          controller={controller}
          onOpen={(canvas) => openCanvas(canvas.channel_id, canvas.id)}
          onSearch={(q) => {
            runSearch({ ...EMPTY_SEARCH, q });
            setSearchTab("canvases");
          }}
        />
      ) : view === "docs" ? (
        <DocsView controller={controller} pageId={docsPageId} onOpenPage={setDocsPageId} compact={compact} />
      ) : view === "calendar" ? (
        <CalendarView controller={controller} />
      ) : view === "tasks" ? (
        <MyTasksView controller={controller} onOpenBoard={openTasksTab} />
      ) : view === "deadlines" ? (
        <DeadlinesView controller={controller} />
      ) : view === "reservations" ? (
        <ReservationsView controller={controller} />
      ) : view === "attendance" ? (
        <AttendanceView controller={controller} />
      ) : view === "actions" ? (
        <ActionsView controller={controller} />
      ) : view === "drafts" ? (
        <DraftsView controller={controller} onOpen={(channelId, parentId) => { open(channelId); if (parentId) { setThreadChannelId(channelId); setThreadId(parentId); } }} />
      ) : current && (current.isMember || previewing) ? (
        <>
          {backToSearch && search && (
            <button
              type="button"
              onClick={() => {
                // A phone's DM tab (M34): the search is on the home tab's screens.
                if (compact && mobileTab !== "home" && savedTabs.home?.view === "search") selectTab("home", { ...currentNav(), backToSearch: false });
                else {
                  setBackToSearch(false);
                  setView("search");
                }
              }}
              className="flex shrink-0 items-center gap-1.5 border-b border-line bg-accent-soft/70 px-4 py-1.5 text-left text-xs font-medium text-accent hover:bg-accent-soft"
            >
              <ArrowLeft size={13} />
              <span className="shrink-0">{t("main.backToResults")}</span>
              <span className="min-w-0 truncate font-normal opacity-80">{describeSearch(controller, search)}</span>
            </button>
          )}
          <header ref={headerRef} className="flex h-[52px] items-center gap-3 border-b border-line px-4 max-md:gap-2 max-md:pr-2">
            {/* On a phone, Back from 「ピン留め」 / 「ファイル」 returns to 「メッセージ」 first (M29). */}
            <BackToList.Provider value={tabbed && tab !== "messages" ? () => setTab("messages") : back}>
              <BackButton />
            </BackToList.Provider>
            {/* The left part gives way to the buttons (shrink-0): the topic first, then mostly the tabs (they scroll
                sideways) and a little the title (an ellipsis), so nothing slides under the buttons when the thread pane
                narrows the column (2026-10-02). Narrower still, the tabs and some buttons fold (headerFit). */}
            <div className="flex min-w-0 flex-1 items-center gap-2 overflow-hidden">
              {tabbed ? (
                // M29: the name opens the conversation's details page.
                <button type="button" className="flex min-w-0 items-center gap-2 rounded-md text-left" title={isChannel ? t("main.channelInfo") : t("main.conversationInfo")} onClick={openDetails}>
                  <span className="text-muted">
                    {isChannel ? (current.type === "private" ? <Lock size={18} /> : <Hash size={18} />) : <AtSign size={18} />}
                  </span>
                  <strong className="truncate text-[15px]">{channelTitle(current, controller).replace(/^#/, "")}</strong>
                </button>
              ) : (
                <>
                  <span className="shrink-0 text-muted">
                    {isChannel ? (current.type === "private" ? <Lock size={18} /> : <Hash size={18} />) : <AtSign size={18} />}
                  </span>
                  <strong className="min-w-0 truncate text-[15px]" title={channelTitle(current, controller)}>{channelTitle(current, controller).replace(/^#/, "")}</strong>
                </>
              )}
              {current.archived && <Badge>{t("channel.archived")}</Badge>}
              {canvasTab && !compact && fit !== "full" && (
                // Too narrow for the strip: one button with the shown tab's name opens the same choices.
                <Menu>
                  <MenuTrigger asChild>
                    <button
                      type="button"
                      aria-label={t("main.viewLabel", { view: headerTabs.find(([value]) => value === shownTab)?.[1] ?? t("main.tab.messages") })}
                      className="ml-1 inline-flex h-7 shrink-0 items-center gap-1 whitespace-nowrap rounded-lg bg-panel-2 px-2.5 text-xs font-medium text-ink transition-colors hover:bg-ink/6"
                    >
                      {headerTabs.find(([value]) => value === shownTab)?.[1] ?? t("main.tab.messages")}
                      <ChevronDown size={13} className="text-muted" />
                    </button>
                  </MenuTrigger>
                  <MenuContent align="start">
                    <MenuRadioGroup value={shownTab} onValueChange={(value) => setTab(value as ConversationTab)}>
                      {headerTabs.map(([value, label]) => (
                        <MenuRadioItem key={value} value={value}>{label}</MenuRadioItem>
                      ))}
                    </MenuRadioGroup>
                  </MenuContent>
                </Menu>
              )}
              {canvasTab && !compact && fit === "full" && (
                <div role="tablist" aria-label={t("main.view")} className="ml-1 flex min-w-[6rem] shrink-[4] overflow-x-auto overflow-y-hidden rounded-lg bg-panel-2 p-0.5 text-xs font-medium [scrollbar-width:none]">
                  {headerTabs.map(([value, label]) => (
                    <button
                      key={value}
                      type="button"
                      role="tab"
                      aria-selected={shownTab === value}
                      onClick={() => setTab(value)}
                      className={cn("shrink-0 whitespace-nowrap rounded-md px-2.5 py-1 transition-colors", shownTab === value ? "bg-canvas text-ink shadow-sm" : "text-muted hover:text-ink")}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              )}
              {/* M85: the channel's next open deadline (opens it). */}
              {isChannel && current.isMember && !previewing && <DeadlineChip controller={controller} channel={current} onOpen={setTaskDialog} />}
              {isChannel && current.posting_policy === "owners" && (
                <span className="text-muted" title={t("main.announcementTitle")}>
                  <Megaphone size={15} />
                </span>
              )}
              {/* A tight header leaves the topic to ⋯ 「トピックを編集」 (the name comes first). */}
              {isChannel && current.isMember && !current.archived && !tightHeader && (
                <button
                  type="button"
                  className={cn("min-w-0 shrink-[100] truncate text-sm hover:underline max-md:hidden", current.topic ? "text-muted" : "text-muted/70")}
                  onClick={() => setDialog("topic")}
                  title={t("channel.editTopic")}
                >
                  {current.topic ? current.topic : t("channel.addTopic")}
                </button>
              )}
              {!isChannel && dmOther.length > 1 && <span className="truncate text-xs text-muted">{t("common.people", { count: dmOther.length + 1 })}</span>}
              {!isChannel && dmOther.length === 1 && dmOther[0] && (
                <span className="flex items-center gap-1.5 text-xs text-muted" title={t("main.presence")}>
                  <span className={cn("h-2 w-2 rounded-full", store.presenceOf(dmOther[0]) === "online" ? "bg-success" : store.presenceOf(dmOther[0]) === "away" ? "bg-warning" : "bg-line")} />
                  {presenceLabel(store.presenceOf(dmOther[0]))}
                  {activeStatus(store.users.get(dmOther[0])) && (
                    <span className="ml-1 truncate">
                      <StatusGlyph controller={controller} emoji={activeStatus(store.users.get(dmOther[0]))!.emoji} /> {activeStatus(store.users.get(dmOther[0]))!.text}
                    </span>
                  )}
                </span>
              )}
            </div>
            <div className="flex shrink-0 items-center gap-0.5">
              {/* M117: 📞 stays on a phone too (one tap from 「今から話そう」). */}
              {canStartCall(controller, current) && <CallButton key={current.id} controller={controller} channel={current} />}
              {/* A phone keeps the bell and the ⋯ menu; the rest of these move into that menu. */}
              {current.isMember && !compact && (
                <>
                  <IconButton
                    label={store.isFavorite(current.id) ? t("channel.unfavorite") : t("channel.favorite")}
                    className={cn(store.isFavorite(current.id) && "text-warning")}
                    onClick={() => void controller.toggleFavorite(current.id)}
                  >
                    <Star size={18} className={cn(store.isFavorite(current.id) && "fill-current")} />
                  </IconButton>
                  {!tightHeader && (
                    <>
                      <IconButton label={t("main.pins")} className={cn(pinsOpen && "bg-ink/6 text-warning")} onClick={() => setPinsOpen((open) => !open)}>
                        <Pin size={18} />
                      </IconButton>
                      <IconButton label={t("nav.files")} onClick={() => openFiles(current.id)}>
                        <Files size={18} />
                      </IconButton>
                    </>
                  )}
                </>
              )}
              {isChannel && current.isMember && !compact && !tightHeader && (
                <IconButton label={t("channel.members")} onClick={() => setDialog("members")}>
                  <Users size={18} />
                </IconButton>
              )}
              {current.isMember && (
                <Menu>
                  <MenuTrigger asChild>
                    <button
                      type="button"
                      aria-label={t("main.notificationSettings")}
                      title={t("main.notificationSettings")}
                      className={cn("inline-flex h-8 w-8 items-center justify-center rounded-lg transition-colors hover:bg-ink/6", silenced ? "text-muted" : "text-ink")}
                    >
                      {silenced ? <BellOff size={18} /> : <Bell size={18} />}
                    </button>
                  </MenuTrigger>
                  <MenuContent>
                    <MenuLabel>{t("settings.section.notifications")}</MenuLabel>
                    {/* M35: a level change keeps both mutes (the timed one is sent back as it is, `muted` is left out). */}
                    <MenuRadioGroup
                      value={ownLevel ?? FOLLOW_DEFAULT}
                      onValueChange={(value) => void controller.setNotification(current.id, value === FOLLOW_DEFAULT ? null : (value as NotificationLevel), current.mutedUntil)}
                    >
                      {notificationChoices(overall).map((choice) => (
                        <MenuRadioItem key={choice.value} value={choice.value}>{choice.label}</MenuRadioItem>
                      ))}
                    </MenuRadioGroup>
                    <MenuSeparator />
                    <MenuCheckboxItem checked={!!current.muted} onCheckedChange={(on) => void controller.setNotification(current.id, ownLevel, current.mutedUntil, on === true)}>
                      {t("channel.mute")}
                    </MenuCheckboxItem>
                    {muteLabel ? (
                      <MenuItem onSelect={() => void controller.setNotification(current.id, ownLevel, null)}>{t("channel.unmuteTimed", { until: muteLabel })}</MenuItem>
                    ) : (
                      <MenuItem onSelect={() => void controller.setNotification(current.id, ownLevel, new Date(Date.now() + 8 * 3600_000).toISOString())}>{t("channel.mute8h")}</MenuItem>
                    )}
                  </MenuContent>
                </Menu>
              )}
              {current.isMember && (isChannel || compact || tightHeader || closable || summaryAvailable(controller)) && (
                <Menu>
                  <MenuTrigger asChild>
                    <button type="button" aria-label={isChannel ? t("main.channelActions") : t("main.conversationActions")} title={isChannel ? t("main.channelActions") : t("main.conversationActions")} className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-ink transition-colors hover:bg-ink/6">
                      <MoreHorizontal size={18} />
                    </button>
                  </MenuTrigger>
                  <MenuContent align="end">
                    <MenuLabel>{isChannel ? `#${current.name}` : channelTitle(current, controller)}</MenuLabel>
                    {/* A phone: the pins and files are tabs, the channel's own items are on its details page (M29). */}
                    {compact ? (
                      <>
                        <MenuItem onSelect={() => void controller.toggleFavorite(current.id)}>
                          {store.isFavorite(current.id) ? t("channel.unfavorite") : t("channel.favorite")}
                        </MenuItem>
                        <MenuItem onSelect={openDetails}>{isChannel ? t("main.channelInfo") : t("main.conversationInfo")}</MenuItem>
                      </>
                    ) : (
                      <>
                        {/* A narrow header (headerFit "tight"): the buttons it left out. Members are below already. */}
                        {tightHeader && (
                          <>
                            <MenuItem onSelect={() => setPinsOpen((open) => !open)}>{pinsOpen ? t("main.closePins") : t("main.pins")}</MenuItem>
                            <MenuItem onSelect={() => openFiles(current.id)}>{t("nav.files")}</MenuItem>
                            <MenuItem onSelect={() => setDialog("shortcuts")}>{t("main.shortcuts")}</MenuItem>
                            {isChannel && <MenuSeparator />}
                          </>
                        )}
                        {isChannel && channelMenuItems}
                      </>
                    )}
                    {closable && (
                      <>
                        {(compact || tightHeader) && <MenuSeparator />}
                        <MenuItem onSelect={() => void controller.closeDm(current.id)}>{t("dmClose.close")}</MenuItem>
                      </>
                    )}
                    {/* M65: 「要約」 (docs/AI.md §6), only to the one who asks. */}
                    <SummaryMenuItems controller={controller} channel={current} onSummary={(target) => startSummary(controller, target)} separator={compact || isChannel || tightHeader || closable} />
                  </MenuContent>
                </Menu>
              )}
              {!compact && !tightHeader && (
                <IconButton label={t("main.shortcutsKey", { key: `${modKey()}+/` })} onClick={() => setDialog("shortcuts")}>
                  <Keyboard size={18} />
                </IconButton>
              )}
            </div>
          </header>
          {tabbed ? (
            <ConversationTabs controller={controller} channel={current} tab={tab} onTab={setTab} onAddLink={addLink} onEditLink={editLink} upcoming={upcomingCount} />
          ) : (
            <ChannelLinksBar controller={controller} channel={current} onAdd={addLink} onEdit={editLink} />
          )}
          {/* M29: on a phone the pins and files tabs cover the conversation, which stays mounted (its scroll position,
              read anchor and draft survive) but hidden, out of reach, and not looked at (the timeline's `active`). */}
          {/* M43: the wide layout's canvas tab covers the conversation the same way. */}
          <div className={compact || canvasTab ? "relative flex min-h-0 flex-1 flex-col" : "contents"}>
            <div className={cn(compact || canvasTab ? "flex min-h-0 flex-1 flex-col" : "contents", shownTab !== "messages" && "invisible")} inert={shownTab !== "messages" || undefined}>
              {previewing ? (
                <>
                  <PreviewTimeline controller={controller} channel={current} onOpenThread={(id) => { setThreadChannelId(current.id); setThreadId(id); }} onJoin={join} />
                  {(!previewRefused(controller, current.id) || !previewCanJoin(current)) && <PreviewJoinBar controller={controller} channel={current} onJoin={join} />}
                </>
              ) : (
                <Timeline controller={controller} channel={current} active={conversationOnScreen} onOpenThread={(id) => { setThreadChannelId(current.id); setThreadId(id); }} />
              )}
              {current.isMember && !current.archived && canPostTopLevel(current, controller.isAdmin) && (
                <Composer key={current.id} controller={controller} channel={current} onReplyLast={replyToLast} />
              )}
              {current.isMember && !current.archived && !canPostTopLevel(current, controller.isAdmin) && (
                <div className="flex items-center gap-2 border-t border-line px-4 py-3 text-sm text-muted">
                  <Megaphone size={16} /> {t("main.ownersOnly")}
                </div>
              )}
              {/* Under the input, as in Slack: its line above it left a wide gap over the input (2026-09-29). */}
              {current.isMember && !current.archived && <TypingIndicator controller={controller} channelId={current.id} />}
              {current.archived && <div className="border-t border-line px-4 py-3 text-sm text-muted">{t("main.archivedNoPost")}</div>}
            </div>
            {shownTab === "canvas" && (
              <div role="tabpanel" aria-label={t("main.tab.canvas")} className="absolute inset-0 flex min-h-0 flex-col bg-canvas">
                <CanvasPane
                  controller={controller}
                  channel={current}
                  canvasId={canvasChoice[current.id] ?? null}
                  onSelect={(id) => setCanvasChoice((choice) => ({ ...choice, [current.id]: id }))}
                  onOpenThread={openCanvasThread}
                />
              </div>
            )}
            {shownTab === "events" && (
              <div role="tabpanel" aria-label={t("main.tab.events")} className="absolute inset-0 flex min-h-0 flex-col bg-canvas">
                <ChannelEvents controller={controller} channel={current} />
              </div>
            )}
            {shownTab === "tasks" && (
              <div role="tabpanel" aria-label={t("main.tab.tasks")} className="absolute inset-0 flex min-h-0 flex-col bg-canvas">
                <ChannelTasks controller={controller} channel={current} onOpenMessage={openTaskMessage} />
              </div>
            )}
            {shownTab === "pins" && (
              <div role="tabpanel" aria-label={t("main.pins")} className="absolute inset-0 flex min-h-0 flex-col bg-canvas">
                <ChannelPins controller={controller} channel={current} onOpen={revealFromList} />
              </div>
            )}
            {shownTab === "files" && (
              <div role="tabpanel" aria-label={t("nav.files")} className="absolute inset-0 flex min-h-0 flex-col bg-canvas">
                <ChannelFiles controller={controller} channel={current} onOpen={revealFromList} />
              </div>
            )}
          </div>
        </>
      ) : (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 text-center">
          <span className="flex h-14 w-14 items-center justify-center rounded-2xl bg-accent-soft text-accent">
            <MessagesSquare size={26} />
          </span>
          <strong className="text-base">{t("main.pickChannel")}</strong>
          <span className="text-sm text-muted">{t("main.pickChannelHint", { key: `${modKey()}+K` })}</span>
        </div>
      )}
      </div>
    </>
  );
  const overlays = (
    <>
      <Toast controller={controller} />
      <SummaryDialog controller={controller} />
      <NoticeToast controller={controller} />
      {switcher && <QuickSwitcher controller={controller} onOpen={open} onOpenCanvas={(canvas) => openCanvas(canvas.channel_id, canvas.id)} onClose={() => setSwitcher(false)} />}
      {dialog === "dm" && <NewDmDialog controller={controller} onClose={() => setDialog(null)} onOpen={open} />}
      {dialog === "directory" && <DirectoryDialog controller={controller} onClose={() => setDialog(null)} onOpen={open} />}
      {dialog === "channel" && <NewChannelDialog controller={controller} onClose={() => setDialog(null)} onOpen={open} />}
      {dialog === "members" && current && (
        <MembersDialog controller={controller} channel={current} onClose={() => setDialog(null)} onAdd={() => setDialog("add-member")} />
      )}
      {dialog === "add-member" && current && (
        <AddMemberDialog
          controller={controller}
          channelId={current.id}
          onClose={() => {
            // Back to where it was opened: the details page (whose list then reloads) or the members dialog.
            if (showDetails) {
              setDialog(null);
              setMembersVersion((v) => v + 1);
            } else setDialog("members");
          }}
        />
      )}
      {dialog === "topic" && current && <TopicDialog controller={controller} channel={current} onClose={() => setDialog(null)} />}
      {dialog === "settings" && (
        <SettingsDialog
          controller={controller}
          initialSection={settingsSection}
          onClose={() => {
            setDialog(null);
            setSettingsSection(undefined);
          }}
        />
      )}
      {dialog === "status" && <StatusDialog controller={controller} onClose={() => setDialog(null)} />}
      {dialog === "admin" && <AdminDialog controller={controller} onClose={() => setDialog(null)} />}
      {dialog === "browse" && <ChannelBrowserDialog controller={controller} onClose={() => setDialog(null)} onOpen={open} onCreate={() => setDialog("channel")} />}
      {dialog === "rename" && current && <RenameChannelDialog controller={controller} channel={current} onClose={() => setDialog(null)} />}
      {dialog === "archive" && current && (
        <ArchiveConfirm channel={current} busy={busyAction} onClose={() => setDialog(null)} onConfirm={() => { setBusyAction(true); void controller.archiveChannel(current.id).then(() => { setBusyAction(false); setDialog(null); }); }} />
      )}
      {dialog === "link" && current && (
        <ChannelLinkDialog controller={controller} channel={current} link={editingLink} onClose={() => { setDialog(null); setEditingLink(null); }} />
      )}
      {dialog === "convert" && current && (
        <ConvertConfirm
          channel={current}
          isAdmin={controller.isAdmin}
          busy={busyAction}
          onClose={() => setDialog(null)}
          onConfirm={(type) => { setBusyAction(true); void controller.convertChannel(current.id, type).then(() => { setBusyAction(false); setDialog(null); }); }}
        />
      )}
      {dialog === "leave" && current && (
        <Modal onClose={() => setDialog(null)} title={t("channel.leaveTitle", { name: current.name ?? "" })} className="w-[440px]">
          <p className="mt-3 text-sm text-muted">{current.type === "private" ? t("channel.leavePrivateNote") : t("channel.leavePublicNote")}</p>
          <div className="mt-4 flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setDialog(null)}>{t("common.cancel")}</Button>
            <Button variant="danger" disabled={busyAction} onClick={() => { setBusyAction(true); void controller.leaveChannel(current.id).then((ok) => { setBusyAction(false); setDialog(null); if (ok) { setCurrentId(null); resetConversation(); setPane("list"); } }); }}>
              {t("channel.leaveConfirm")}
            </Button>
          </div>
        </Modal>
      )}
      {dialog === "shortcuts" && <ShortcutsDialog onClose={() => setDialog(null)} />}
      {dialog === "recurring" && current && <RecurringPostsDialog controller={controller} channel={current} onClose={() => setDialog(null)} />}
      {dialog === "feeds" && current && <FeedsDialog controller={controller} channel={current} onClose={() => setDialog(null)} />}
      {dialog === "workflows" && current && <ChannelWorkflowsDialog controller={controller} channel={current} manage onClose={() => setDialog(null)} />}
      {taskDialog && <TaskDialog controller={controller} task={controller.engine?.tasks?.find(taskDialog.id) ?? taskDialog} onClose={() => setTaskDialog(null)} onOpenMessage={openTaskMessage} />}
      {deadlineInit && <TaskDialog controller={controller} task={null} init={deadlineInit} onClose={() => setDeadlineInit(null)} onOpenMessage={openTaskMessage} />}
    </>
  );

  if (compact) {
    const atRoot = pane === "list";
    // Hidden inside a conversation, a thread or the details page (Slack); shown on the roots and the lists pushed on them.
    const showTabBar = atRoot || (view !== "channel" && !sidePane && !showDetails);
    const rootContent = (value: MobileTab) =>
      value === "home" ? (
        <HomeView
          controller={controller}
          gatherUnread={gatherUnread}
          onGatherUnread={(on) => {
            writeGatherUnread(on);
            setGatherUnread(on);
          }}
          onOpen={open}
          onJump={() => setHomeOverlay("jump")}
          onCompose={() => setHomeOverlay("compose")}
          onThreads={openThreads}
          onTimesFeed={() => openView("times")}
          onDrafts={() => openView("drafts")}
          onSaved={openSaved}
          onReminders={() => openView("reminders")}
          onFiles={() => openFiles(null)}
          onCanvases={() => openView("canvases")}
          onDocs={engine?.wiki?.available ? () => openView("docs") : undefined}
          onCalendar={() => openView("calendar")}
          onTasks={() => openView("tasks")}
          onDeadlines={() => openView("deadlines")}
          onReservations={store.reservationPools ? () => openView("reservations") : undefined}
          onAttendance={store.attendance ? () => openView("attendance") : undefined}
          onActions={pressable(store.actions).length ? () => openView("actions") : undefined}
          onBrowse={() => setDialog("browse")}
          onNewChannel={() => setDialog("channel")}
          onDirectory={() => setDialog("directory")}
          onCreateTimes={createTimes}
          onAllDms={() => selectTab("dm")}
        />
      ) : value === "dm" ? (
        <DmListView controller={controller} onOpen={open} onNew={() => setDialog("dm")} />
      ) : value === "activity" ? (
        <ActivityView controller={controller} active={atRoot && mobileTab === "activity"} onOpen={openActivityItem} onOpenMessage={revealFromList} onOpenThread={openActivityThread} />
      ) : (
        <YouView controller={controller} popToRoot={youPopToRoot} onAttendance={store.attendance ? () => openView("attendance") : undefined} />
      );
    return (
      <BackToList.Provider value={back}>
        <div className="flex h-full flex-col overflow-hidden bg-canvas text-ink">
          <div className="relative min-h-0 flex-1">
            {/* M34: every tab's root stays mounted once shown, so its scroll position survives; only the selected
                tab's shows, and none under a conversation or a view. */}
            {MOBILE_TABS.filter((value) => visitedTabs.current.has(value)).map((value) => {
              const hidden = !atRoot || value !== mobileTab;
              return (
                <div
                  key={value}
                  ref={(element) => { tabRoots.current[value] = element; }}
                  data-tab-root={value}
                  className={cn("absolute inset-0 flex flex-col", value === "home" ? "bg-sidebar" : "bg-canvas", hidden && "invisible")}
                  aria-hidden={hidden || undefined}
                  inert={hidden || undefined}
                >
                  {rootContent(value)}
                </div>
              );
            })}
            {/* Mounted only while on screen: a hidden timeline would mark messages read. */}
            {pane === "main" && <main className="absolute inset-0 flex min-h-0 flex-col bg-canvas">{centre}</main>}
            {pane === "main" && sidePane && <div className="absolute inset-0 z-30 flex min-h-0 bg-canvas">{sidePane}</div>}
            {/* M29: the details page over the conversation, which stays mounted under it. */}
            {pane === "main" && showDetails && current && (
              <div className="absolute inset-0 z-30 flex min-h-0 bg-canvas">
                <ChannelDetails
                  controller={controller}
                  channel={current}
                  membersVersion={membersVersion}
                  onClose={() => setDetailsOpen(false)}
                  onDialog={(next) => {
                    if (next === "link") setEditingLink(null);
                    setDialog(next);
                  }}
                />
              </div>
            )}
          </div>
          {/* The bottom tabs, except in a conversation, a thread or the details page (Slack). */}
          {showTabBar && <MobileTabBar controller={controller} tab={mobileTab} onTab={(value) => selectTab(value)} />}
          {homeOverlay === "jump" && (
            <JumpView
              controller={controller}
              recentIds={recentConversations}
              recentSearches={recent}
              onOpen={(id) => openLanded(id)}
              onOpenPerson={(userId) => void controller.openDmWith(userId).then((id) => { if (id) openLanded(id); })}
              onSearch={(params) => {
                setHomeOverlay(null);
                runSearch(params);
              }}
              onOpenMessage={openLiveResult}
              onRemoveRecentSearch={(params) => setRecent(removeRecent(recentStorageKey, params))}
              onClose={() => setHomeOverlay(null)}
            />
          )}
          {homeOverlay === "compose" && <NewMessageView controller={controller} onOpen={(id) => openLanded(id, { focusComposer: true })} onClose={() => setHomeOverlay(null)} />}
          {overlays}
        </div>
      </BackToList.Provider>
    );
  }

  return (
    <div
      ref={desktopRoot}
      className="grid h-full grid-cols-[var(--sidebar-w)_minmax(0,1fr)_auto] grid-rows-[auto_minmax(0,1fr)] overflow-hidden bg-canvas text-ink"
      style={{ "--sidebar-w": `${columns.sidebarWidth}px` } as React.CSSProperties}
    >
      {/* The workspace over the sidebar (M16c) and the search box across the rest (M16b), as in Slack. On macOS this
          row is the title bar: it moves the window, and leaves room for the window buttons when no rail does. On Windows
          it is the whole title bar (no system one): it moves the window, and ends with our own window buttons. Only the
          row's own empty space drags; the buttons and the search box inside it don't. */}
      <div
        data-tauri-drag-region
        className="flex h-10 min-w-0 items-center bg-sidebar px-2"
        style={trafficLights ? { height: TITLE_ROW_HEIGHT, paddingLeft: controller.showsRail ? TITLE_ROW_INSET_AFTER_RAIL : `calc(${TRAFFIC_LIGHTS_INSET}px / var(--ui-zoom, 1))` } : undefined}
      >
        <WorkspaceMenu controller={controller} />
        {/* 在室状況's quick switch (docs/PRESENCE.md §7.1): the free space right of the name; icon only when narrow. */}
        <AttendancePill controller={controller} placement="sidebar" shortcut onOpenBoard={() => openView("attendance")} />
      </div>
      <div data-tauri-drag-region className={cn("col-span-2 flex h-10 items-center gap-2 border-b border-sidebar-edge bg-sidebar pl-3", windowButtons ? "pr-0" : "pr-3")} style={trafficLights ? { height: TITLE_ROW_HEIGHT } : undefined}>
        {/* M67: back / forward between places, beside the search box as in Slack. */}
        <nav aria-label={t("main.history")} className="flex shrink-0 items-center gap-0.5">
          <IconButton tone="sidebar" label={historyLabels.back} disabled={!canGoBack} onClick={() => goHistory(-1)} className="h-7 w-7 disabled:opacity-40">
            <ArrowLeft size={16} />
          </IconButton>
          <IconButton tone="sidebar" label={historyLabels.forward} disabled={!canGoForward} onClick={() => goHistory(1)} className="h-7 w-7 disabled:opacity-40">
            <ArrowRight size={16} />
          </IconButton>
        </nav>
        {searchBar}
        {windowButtons && <WindowControls />}
      </div>
      {sidebar}
      {/* min-h-0: a grid item's default min-height is its content height, which would grow the row past the window. */}
      <main className="relative flex min-h-0 min-w-0 flex-col">
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label={t("main.sidebarWidth")}
          title={t("main.resizeHint")}
          onPointerDown={startResize}
          onDoubleClick={() => {
            setSidebarWidth(SIDEBAR_DEFAULT);
            writeSidebarWidth(SIDEBAR_DEFAULT);
          }}
          className="absolute -left-1 top-0 z-20 h-full w-2 cursor-col-resize transition-colors hover:bg-accent/40 active:bg-accent/60"
        />
        {sidePane && columns.replaceCentre ? <div className="flex min-h-0 flex-1">{sidePane}</div> : centre}
      </main>
      {sidePane && !columns.replaceCentre ? (
        <div className="relative flex min-h-0" style={{ width: columns.paneWidth }}>
          <div
            role="separator"
            aria-orientation="vertical"
            aria-label={t("main.paneWidth")}
            title={t("main.resizeHint")}
            onPointerDown={startPaneResize}
            onDoubleClick={() => {
              setPaneWidth(PANE_DEFAULT);
              writePaneWidth(PANE_DEFAULT);
            }}
            className="absolute -left-1 top-0 z-20 h-full w-2 cursor-col-resize transition-colors hover:bg-accent/40 active:bg-accent/60"
          />
          {sidePane}
        </div>
      ) : null}
      {overlays}
    </div>
  );
}

/** M15b: public → private hides the channel from non-members; private → public shows its whole history. */
function ConvertConfirm({ channel, isAdmin, busy, onClose, onConfirm }: {
  channel: ChannelState;
  isAdmin: boolean;
  busy: boolean;
  onClose: () => void;
  onConfirm: (type: "public" | "private") => void;
}) {
  const toPrivate = channel.type === "public";
  return (
    <Modal onClose={onClose} title={toPrivate ? t("channel.convertPrivateTitle", { name: channel.name ?? "" }) : t("channel.convertPublicTitle", { name: channel.name ?? "" })} className="w-[460px]">
      <p className="mt-3 text-sm text-muted">
        {toPrivate
          ? t("channel.convertPrivateNote")
          : t("channel.convertPublicNote")}
      </p>
      {toPrivate && !isAdmin && <p className="mt-2 text-sm text-muted">{t("channel.convertBackAdminOnly")}</p>}
      <div className="mt-4 flex justify-end gap-2">
        <Button variant="secondary" onClick={onClose}>{t("common.cancel")}</Button>
        <Button variant="danger" disabled={busy} onClick={() => onConfirm(toPrivate ? "private" : "public")}>
          {toPrivate ? t("channel.makePrivate") : t("channel.makePublic")}
        </Button>
      </div>
    </Modal>
  );
}

export function channelTitle(channel: ChannelState, controller: AppController): string {
  return conversationTitle(channel, controller.store.users, controller.store.me?.id ?? controller.me?.id ?? null, controller.store.me ?? controller.me);
}

/** My name as the lists show it (my own DM's title, and its placeholder row's). */
export function myDisplayName(controller: AppController): string {
  return myName(controller.store.users, controller.store.me?.id ?? controller.me?.id ?? null, controller.store.me ?? controller.me);
}
