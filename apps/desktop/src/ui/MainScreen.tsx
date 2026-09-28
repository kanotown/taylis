import { ArrowLeft, AtSign, Bell, BellOff, Files, Hash, Keyboard, Lock, Megaphone, MessagesSquare, MoreHorizontal, Pin, Star, Users } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";

import type { AppController } from "../state/app";
import type { ChannelLinkOut, MessageOut } from "../api/types";
import { canEditLinks, ChannelLinkDialog, ChannelLinksBar } from "./ChannelLinks";
import type { ChannelState, NotificationLevel, ThreadEntry } from "../sync/types";
import { canPostTopLevel, conversationTitle, hasUnread, isDmChannel, sectionChannels, stepChannel } from "./channels";
import { Composer } from "./Composer";
import { AdminDialog, ArchiveConfirm } from "./AdminDialog";
import { AddMemberDialog, MembersDialog, NewChannelDialog, NewDmDialog, RenameChannelDialog, SettingsDialog, ShortcutsDialog, TopicDialog } from "./Dialogs";
import { formatMuted } from "./format";
import { PANE_DEFAULT, PANE_MAX, PANE_MIN, readPaneWidth, readSidebarWidth, SIDEBAR_DEFAULT, SIDEBAR_MAX, SIDEBAR_MIN, writePaneWidth, writeSidebarWidth } from "./prefs";
import { Badge, Button, cn, IconButton, Menu, MenuContent, MenuItem, MenuLabel, MenuRadioGroup, MenuRadioItem, MenuSeparator, MenuTrigger, Modal, modKey } from "./primitives";
import { QuickSwitcher } from "./QuickSwitcher";
import { PinsPane } from "./PinsPane";
import { MentionsView } from "./MentionsView";
import { DirectoryDialog } from "./DirectoryDialog";
import { DraftsView } from "./DraftsView";
import { FilesView } from "./FilesView";
import { RemindersView } from "./RemindersView";
import { ChannelBrowserDialog } from "./ChannelBrowserDialog";
import { BackButton, BackToList, useCompact } from "./compact";
import { useConnectionBanner } from "./hooks";
import { SavedView } from "./SavedView";
import { describeSearch, SearchBar } from "./SearchBar";
import { SearchView, type SearchSnapshot, type SearchTab } from "./SearchView";
import { WorkspaceMenu } from "./WorkspaceRail";
import { isWeb, overlayTitleBar, TRAFFIC_LIGHTS_INSET } from "../platform/env";
import { pushRecent, readRecent, recentKey, type SearchParams } from "./search";
import { Sidebar } from "./Sidebar";
import { ThreadPane } from "./ThreadPane";
import { ThreadsView } from "./ThreadsView";
import { Timeline } from "./Timeline";
import { NoticeToast, Toast } from "./Toast";
import { TypingIndicator } from "./Typing";
import { presenceLabel } from "./Avatar";
import { activeStatus } from "./users";
import { StatusDialog } from "./StatusDialog";
import { CONVERSATION_MIN, paneLayout } from "./paneLayout";
import { useNavigationHistory } from "./navigationHistory";
import { focusChatRegion } from "./messageKeyboard";

type Dialog = "dm" | "channel" | "members" | "add-member" | "settings" | "topic" | "shortcuts" | "status" | "admin" | "rename" | "archive" | "leave" | "browse" | "directory" | "convert" | "link" | null;

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
  const [currentId, setCurrentId] = useState<string | null>(() => engine?.currentChannelId ?? [...store.channels.values()].find((channel) => channel.isMember)?.id ?? null);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [editingLink, setEditingLink] = useState<ChannelLinkOut | null>(null);
  const [threadId, setThreadId] = useState<string | null>(null);
  // "threads": the centre column lists followed threads (THREADS.md §5); the selected one opens on the right.
  const [view, setView] = useState<"channel" | "threads" | "saved" | "mentions" | "drafts" | "files" | "reminders" | "search">("channel");
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
  const [pane, setPane] = useState<"list" | "main">(() => (controller.messageFocus ? "main" : "list"));
  const navigation = { currentId, view, threadId, threadChannelId, pinsOpen, pane, filesChannelId, search, searchTab, backToSearch };
  const focus = controller.messageFocus;
  const navigationKey = JSON.stringify({ ...navigation, focus: focus?.messageId ?? null });
  useNavigationHistory(navigationKey, { ...navigation, focus, results: searchSnapshot.current }, (previous) => {
    controller.messageFocus = previous.focus;
    controller.setEditing(null);
    setCurrentId(previous.currentId);
    setView(previous.view);
    setThreadId(previous.threadId);
    setThreadChannelId(previous.threadChannelId);
    setPinsOpen(previous.pinsOpen);
    setPane(previous.pane);
    setFilesChannelId(previous.filesChannelId);
    setSearch(previous.search);
    setSearchTab(previous.searchTab);
    setBackToSearch(previous.backToSearch);
    searchSnapshot.current = previous.results;
    setSearchOpen(false);
    setDialog(null);
    setSwitcher(false);
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
  // The thread pane belongs to the current channel, or to the channel of the row picked in the threads view.
  const threadChannel: ChannelState | undefined = view === "threads" ? (threadChannelId ? store.getChannel(threadChannelId) : undefined) : current;
  const status = engine?.status ?? "idle";
  const banner = useConnectionBanner(status);

  // The keyboard handler is registered once and reads the latest state through this ref.
  const state = useRef({ currentId, dialog, threadId, searchOpen, switcher, view, pinsOpen });
  state.current = { currentId, dialog, threadId, searchOpen, switcher, view, pinsOpen };

  useEffect(() => {
    // Only a channel I belong to; a new member without channels sees the empty state (M12h invites).
    if (!currentId && channels.length > 0) {
      const first = channels.find((c) => c.isMember);
      if (first) setCurrentId(first.id);
    }
  }, [currentId, channels.length]);

  // A focus set outside this screen (a permalink opened in the browser, M12j): show its conversation.
  useEffect(() => {
    const focus = controller.messageFocus;
    if (!focus || (focus.channelId === currentId && view === "channel")) return;
    setPane("main");
    setView("channel");
    setSearchOpen(false);
    setPinsOpen(false);
    setCurrentId(focus.channelId);
    setThreadChannelId(focus.channelId);
    setThreadId(focus.parentId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [controller.messageFocus]);

  // M13b: a slash command (/join, /dm) asked for a conversation.
  useEffect(() => {
    const id = controller.openChannelRequest;
    if (!id) return;
    controller.openChannelRequest = null;
    open(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [controller.openChannelRequest]);

  useEffect(() => {
    if (currentId && engine) void engine.openChannel(currentId).catch((error) => controller.setError(error));
  }, [currentId, engine]);

  const open = (id: string) => {
    controller.clearMessageFocus();
    controller.setEditing(null);
    setCurrentId(id);
    setThreadId(null);
    setThreadChannelId(null);
    setPinsOpen(false);
    setView("channel");
    setSwitcher(false);
    setBackToSearch(false);
    setPane("main");
  };

  const openSaved = () => {
    controller.clearMessageFocus();
    controller.setEditing(null);
    setThreadId(null);
    setThreadChannelId(null);
    setSearchOpen(false);
    setBackToSearch(false);
    setPinsOpen(false);
    setPane("main");
    setView((v) => (v === "saved" && !compactRef.current ? "channel" : "saved"));
  };

  /** A card in the pins pane / saved view: show the message in its conversation. */
  const revealFromList = (message: MessageOut) => {
    void controller.revealMessage(message).then((ok) => {
      if (!ok) return;
      setView("channel");
      setSearchOpen(false);
      setBackToSearch(false);
      setPinsOpen(false);
      setCurrentId(message.channel_id);
      setThreadChannelId(message.channel_id);
      setThreadId(message.parent_id ?? null);
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
    setBackToSearch(false);
    setView("search");
    setPane("main");
  };

  /** A result: its conversation (or thread) around the message, with 「検索結果に戻る」. */
  const openSearchResult = (message: MessageOut) => {
    void controller.revealMessage(message).then((ok) => {
      if (!ok) return;
      setView("channel");
      setPinsOpen(false);
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
    setFilesChannelId(channelId);
    setView("files");
    setPane("main");
  };

  const openView = (next: "mentions" | "drafts" | "reminders") => {
    controller.clearMessageFocus();
    controller.setEditing(null);
    setThreadId(null);
    setThreadChannelId(null);
    setSearchOpen(false);
    setBackToSearch(false);
    setPinsOpen(false);
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
    setPane("main");
    setView((v) => (v === "threads" && !compactRef.current ? "channel" : "threads"));
  };

  const openThreadEntry = (entry: ThreadEntry) => {
    controller.clearMessageFocus();
    setThreadChannelId(entry.state.channel_id);
    setThreadId(entry.parent.id);
  };

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
      const sections = sectionChannels(all, (c) => channelTitle(c, controller), { favorites: store.favorites, sections: store.sidebarSections, meId: store.me?.id ?? null });
      return [...sections.favorites, ...sections.custom.flatMap((group) => group.channels), ...sections.channels, ...sections.times, ...sections.dms];
    };
    const onKey = (event: KeyboardEvent) => {
      // An open menu or popover (Radix) has already used this Esc to close itself.
      if (event.key === "Escape" && event.defaultPrevented) return;
      const mod = event.metaKey || event.ctrlKey;
      const key = event.key.toLowerCase();
      const s = state.current;
      if (event.key === "F6" && !mod && !event.altKey && !s.dialog && !s.switcher && !s.searchOpen) {
        if (focusChatRegion(event.shiftKey)) event.preventDefault();
      } else if (mod && !event.shiftKey && !event.altKey && /^[1-9]$/.test(event.key) && controller.multiWorkspace) {
        // M16c: ⌘1 … ⌘9 open the n-th workspace of the rail (Slack).
        event.preventDefault();
        controller.switchToIndex(Number(event.key) - 1);
      } else if (mod && !event.shiftKey && key === "k") {
        event.preventDefault();
        setSwitcher(true);
      } else if (mod && event.shiftKey && key === "k") {
        event.preventDefault();
        setDialog("dm");
      } else if (mod && !event.shiftKey && key === "f") {
        event.preventDefault();
        setSearchOpen(true);
      } else if (mod && event.shiftKey && key === "t") {
        event.preventDefault();
        openThreads();
      } else if (mod && event.shiftKey && key === "e") {
        event.preventDefault();
        setDialog("browse");
      } else if (mod && event.shiftKey && key === "l") {
        event.preventDefault();
        document.querySelector<HTMLTextAreaElement>(".composer textarea")?.focus();
      } else if (mod && key === "/") {
        event.preventDefault();
        setDialog((d) => (d === "shortcuts" ? null : "shortcuts"));
      } else if (event.altKey && (event.key === "ArrowUp" || event.key === "ArrowDown")) {
        event.preventDefault();
        const next = stepChannel(navigationOrder(), s.currentId, event.key === "ArrowDown" ? 1 : -1, { unreadOnly: event.shiftKey, meId: controller.store.me?.id ?? null });
        if (next) open(next.id);
      } else if (event.key === "Escape") {
        if (s.switcher) setSwitcher(false);
        else if (s.dialog) setDialog(null);
        else if (s.searchOpen) setSearchOpen(false);
        else if (s.pinsOpen) setPinsOpen(false);
        else if (s.threadId) setThreadId(null);
        else if (controller.editing) controller.setEditing(null);
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
    window.addEventListener("keydown", onKey);
    window.addEventListener("chikuwa:quick-switch", onSwitch);
    window.addEventListener("chikuwa:open-channel", onOpenChannel);
    window.addEventListener("chikuwa:open-status", onOpenStatus);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("chikuwa:quick-switch", onSwitch);
      window.removeEventListener("chikuwa:open-channel", onOpenChannel);
      window.removeEventListener("chikuwa:open-status", onOpenStatus);
    };
  }, [controller]);

  const join = async (id: string) => {
    if (!controller.api) return;
    try {
      const channel = await controller.api.joinChannel(id);
      store.upsertChannel(channel, { isMember: true });
      setCurrentId(id);
      setPane("main");
    } catch (error) {
      controller.setError(error);
    }
  };

  const replyToLast = () => {
    if (!current) return;
    const last = store.messages(current.id).filter((m) => !m.pending && !m.deleted).at(-1);
    if (last) setThreadId(last.id);
  };

  const muteLabel = current ? formatMuted(current.mutedUntil) : null;
  const level: NotificationLevel = current?.notificationLevel ?? (current && (current.type === "dm" || current.type === "group_dm") ? "all" : "mentions");
  const isChannel = current?.type === "public" || current?.type === "private";
  const canManage = !!current && (controller.isAdmin || current.membership?.role === "owner");
  const [busyAction, setBusyAction] = useState(false);

  const dmOther = current && isDmChannel(current) ? (current.dm_user_ids ?? []).filter((id) => id !== store.me?.id) : [];

  const searchBar = (
    <SearchBar
      controller={controller}
      current={view === "search" || backToSearch ? search : null}
      open={searchOpen}
      onOpenChange={setSearchOpen}
      onSearch={runSearch}
      recent={recent}
      onRecentChange={setRecent}
      recentKey={recentStorageKey}
      placeholder={`${controller.workspaceName} を検索`}
    />
  );
  const sidebar = (
    <Sidebar
      controller={controller}
      channels={channels}
      currentId={currentId}
      unreadOnly={unreadOnly}
      onToggleUnreadOnly={toggleUnreadOnly}
      onOpen={open}
      onJoin={(id) => void join(id)}
      onNewDm={() => setDialog("dm")} onDirectory={() => setDialog("directory")}
      onNewChannel={() => setDialog("channel")}
      onCreateTimes={() => void controller.ensureTimes().then((id) => { if (id) open(id); })}
      onSettings={() => setDialog("settings")}
      onThreads={openThreads}
      threadsActive={view === "threads"}
      onSaved={openSaved}
      savedActive={view === "saved"}
      onAdmin={() => setDialog("admin")}
      onBrowse={() => setDialog("browse")}
      onMentions={() => openView("mentions")}
      mentionsActive={view === "mentions"}
      onDrafts={() => openView("drafts")}
      draftsActive={view === "drafts"}
      onFiles={() => (view === "files" && !compact ? setView("channel") : openFiles(null))}
      filesActive={view === "files"}
      onReadAll={() => void controller.markAllRead()}
      onReminders={() => openView("reminders")}
      remindersActive={view === "reminders"}
    />
  );
  // The channel's own ⋯ items (on a phone they follow the conversation items in the same menu).
  const channelMenuItems = current ? (
    <>
      {!current.archived && <MenuItem onSelect={() => setDialog("topic")}>トピックを編集</MenuItem>}
      {canManage && !current.archived && <MenuItem onSelect={() => setDialog("rename")}>名前を変更</MenuItem>}
      <MenuItem onSelect={() => setDialog("members")}>メンバー</MenuItem>
      {canEditLinks(current, controller) && <MenuItem onSelect={() => { setEditingLink(null); setDialog("link"); }}>リンクを追加…</MenuItem>}
      {canManage && !current.archived && (
        <MenuItem onSelect={() => void controller.setPostingPolicy(current.id, current.posting_policy === "owners" ? "everyone" : "owners")}>
          {current.posting_policy === "owners" ? "誰でも投稿できるようにする" : current.times_owner_id ? "他の人はスレッドでだけ返信できるようにする" : "投稿をオーナーと管理者に限る"}
        </MenuItem>
      )}
      {canManage && current.type === "public" && <MenuItem onSelect={() => setDialog("convert")}>非公開チャンネルに変換…</MenuItem>}
      {controller.isAdmin && current.type === "private" && <MenuItem onSelect={() => setDialog("convert")}>公開チャンネルに変換…</MenuItem>}
      <MenuSeparator />
      <MenuItem onSelect={() => setDialog("leave")}>チャンネルを退出</MenuItem>
      {canManage && !current.archived && <MenuItem className="text-danger" onSelect={() => setDialog("archive")}>アーカイブ</MenuItem>}
      {canManage && current.archived && <MenuItem onSelect={() => void controller.unarchiveChannel(current.id)}>アーカイブを解除</MenuItem>}
    </>
  ) : null;
  const centre = (
    <>
      {banner && (
        <div className={cn("px-4 py-1 text-center text-xs font-medium text-white", banner === "connecting" ? "bg-accent" : "bg-warning")}>
          {banner === "connecting" ? "サーバに接続しています…" : "オフラインです。再接続を待っています…"}
        </div>
      )}
      {view === "search" && search ? (
        <SearchView
          controller={controller}
          params={search}
          tab={searchTab}
          onTabChange={setSearchTab}
          onChange={setSearch}
          onOpen={openSearchResult}
          onClose={() => {
            setView("channel");
            if (compact) setPane("list");
          }}
          snapshot={searchSnapshot}
        />
      ) : view === "threads" ? (
        <ThreadsView controller={controller} selectedId={threadId} onOpen={openThreadEntry} />
      ) : view === "saved" ? (
        <SavedView controller={controller} onOpen={revealFromList} />
      ) : view === "mentions" ? (
        <MentionsView controller={controller} onOpen={revealFromList} />
      ) : view === "reminders" ? (
        <RemindersView controller={controller} onOpen={(row) => void controller.openPermalink(row.message_id)} />
      ) : view === "files" ? (
        <FilesView controller={controller} channelId={filesChannelId} onChannelChange={setFilesChannelId} onOpen={revealFromList} />
      ) : view === "drafts" ? (
        <DraftsView controller={controller} onOpen={(channelId, parentId) => { open(channelId); if (parentId) { setThreadChannelId(channelId); setThreadId(parentId); } }} />
      ) : current ? (
        <>
          {backToSearch && search && (
            <button
              type="button"
              onClick={() => {
                setBackToSearch(false);
                setView("search");
              }}
              className="flex shrink-0 items-center gap-1.5 border-b border-line bg-accent-soft/70 px-4 py-1.5 text-left text-xs font-medium text-accent hover:bg-accent-soft"
            >
              <ArrowLeft size={13} />
              <span className="shrink-0">検索結果に戻る</span>
              <span className="min-w-0 truncate font-normal opacity-80">{describeSearch(controller, search)}</span>
            </button>
          )}
          <header className="flex h-[52px] items-center gap-3 border-b border-line px-4 max-md:gap-2 max-md:pr-2">
            <BackButton />
            <div className="flex min-w-0 flex-1 items-center gap-2">
              <span className="text-muted">
                {isChannel ? (current.type === "private" ? <Lock size={18} /> : <Hash size={18} />) : <AtSign size={18} />}
              </span>
              <strong className="truncate text-[15px]">{channelTitle(current, controller).replace(/^#/, "")}</strong>
              {current.archived && <Badge>アーカイブ済み</Badge>}
              {isChannel && current.posting_policy === "owners" && (
                <span className="text-muted" title="アナウンス: 投稿できるのはオーナーと管理者だけです">
                  <Megaphone size={15} />
                </span>
              )}
              {isChannel && current.isMember && !current.archived && (
                <button
                  type="button"
                  className={cn("min-w-0 truncate text-sm hover:underline max-md:hidden", current.topic ? "text-muted" : "text-muted/70")}
                  onClick={() => setDialog("topic")}
                  title="トピックを編集"
                >
                  {current.topic ? current.topic : "トピックを追加"}
                </button>
              )}
              {!isChannel && dmOther.length > 1 && <span className="truncate text-xs text-muted">{dmOther.length + 1} 人</span>}
              {!isChannel && dmOther.length === 1 && dmOther[0] && (
                <span className="flex items-center gap-1.5 text-xs text-muted" title="プレゼンス">
                  <span className={cn("h-2 w-2 rounded-full", store.presenceOf(dmOther[0]) === "online" ? "bg-success" : store.presenceOf(dmOther[0]) === "away" ? "bg-warning" : "bg-line")} />
                  {presenceLabel(store.presenceOf(dmOther[0]))}
                  {activeStatus(store.users.get(dmOther[0])) && (
                    <span className="ml-1 truncate">
                      {activeStatus(store.users.get(dmOther[0]))!.emoji} {activeStatus(store.users.get(dmOther[0]))!.text}
                    </span>
                  )}
                </span>
              )}
            </div>
            <div className="flex shrink-0 items-center gap-0.5">
              {/* A phone keeps the bell and the ⋯ menu; the rest of these move into that menu. */}
              {current.isMember && !compact && (
                <>
                  <IconButton
                    label={store.isFavorite(current.id) ? "お気に入りから外す" : "お気に入りに追加"}
                    className={cn(store.isFavorite(current.id) && "text-warning")}
                    onClick={() => void controller.toggleFavorite(current.id)}
                  >
                    <Star size={18} className={cn(store.isFavorite(current.id) && "fill-current")} />
                  </IconButton>
                  <IconButton label="ピン留め" className={cn(pinsOpen && "bg-ink/6 text-warning")} onClick={() => setPinsOpen((open) => !open)}>
                    <Pin size={18} />
                  </IconButton>
                  <IconButton label="ファイル" onClick={() => openFiles(current.id)}>
                    <Files size={18} />
                  </IconButton>
                </>
              )}
              {isChannel && !compact && (
                <IconButton label="メンバー" onClick={() => setDialog("members")}>
                  <Users size={18} />
                </IconButton>
              )}
              {current.isMember && (
                <Menu>
                  <MenuTrigger asChild>
                    <button
                      type="button"
                      aria-label="通知設定"
                      title="通知設定"
                      className={cn("inline-flex h-8 w-8 items-center justify-center rounded-lg transition-colors hover:bg-ink/6", (level === "none" || muteLabel) ? "text-muted" : "text-ink")}
                    >
                      {level === "none" || muteLabel ? <BellOff size={18} /> : <Bell size={18} />}
                    </button>
                  </MenuTrigger>
                  <MenuContent>
                    <MenuLabel>通知</MenuLabel>
                    <MenuRadioGroup value={level} onValueChange={(value) => void controller.setNotification(current.id, value as NotificationLevel, null)}>
                      <MenuRadioItem value="all">すべてのメッセージ</MenuRadioItem>
                      <MenuRadioItem value="mentions">メンションのみ</MenuRadioItem>
                      <MenuRadioItem value="none">通知しない</MenuRadioItem>
                    </MenuRadioGroup>
                    <MenuSeparator />
                    {muteLabel ? (
                      <MenuItem onSelect={() => void controller.setNotification(current.id, level, null)}>ミュート解除 ({muteLabel})</MenuItem>
                    ) : (
                      <MenuItem onSelect={() => void controller.setNotification(current.id, level, new Date(Date.now() + 8 * 3600_000).toISOString())}>8 時間ミュート</MenuItem>
                    )}
                  </MenuContent>
                </Menu>
              )}
              {current.isMember && (isChannel || compact) && (
                <Menu>
                  <MenuTrigger asChild>
                    <button type="button" aria-label={isChannel ? "チャンネルの操作" : "会話の操作"} title={isChannel ? "チャンネルの操作" : "会話の操作"} className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-ink transition-colors hover:bg-ink/6">
                      <MoreHorizontal size={18} />
                    </button>
                  </MenuTrigger>
                  <MenuContent align="end">
                    <MenuLabel>{isChannel ? `#${current.name}` : channelTitle(current, controller)}</MenuLabel>
                    {compact && (
                      <>
                        <MenuItem onSelect={() => void controller.toggleFavorite(current.id)}>
                          {store.isFavorite(current.id) ? "お気に入りから外す" : "お気に入りに追加"}
                        </MenuItem>
                        <MenuItem onSelect={() => setPinsOpen(true)}>ピン留め</MenuItem>
                        <MenuItem onSelect={() => openFiles(current.id)}>ファイル</MenuItem>
                        {isChannel && <MenuSeparator />}
                      </>
                    )}
                    {isChannel && channelMenuItems}
                  </MenuContent>
                </Menu>
              )}
              {!compact && (
                <IconButton label={`キーボードショートカット (${modKey()}+/)`} onClick={() => setDialog("shortcuts")}>
                  <Keyboard size={18} />
                </IconButton>
              )}
              {!current.isMember && (
                <Button size="sm" className="ml-2" onClick={() => void join(current.id)}>
                  参加する
                </Button>
              )}
            </div>
          </header>
          <ChannelLinksBar controller={controller} channel={current} onAdd={() => { setEditingLink(null); setDialog("link"); }} onEdit={(link) => { setEditingLink(link); setDialog("link"); }} />
          <Timeline controller={controller} channel={current} onOpenThread={(id) => { setThreadChannelId(current.id); setThreadId(id); }} />
          {current.isMember && !current.archived && <TypingIndicator controller={controller} channelId={current.id} />}
          {current.isMember && !current.archived && canPostTopLevel(current, controller.isAdmin) && (
            <Composer key={current.id} controller={controller} channel={current} onReplyLast={replyToLast} />
          )}
          {current.isMember && !current.archived && !canPostTopLevel(current, controller.isAdmin) && (
            <div className="flex items-center gap-2 border-t border-line px-4 py-3 text-sm text-muted">
              <Megaphone size={16} /> このチャンネルに投稿できるのはオーナーと管理者だけです。スレッドでは返信できます。
            </div>
          )}
          {current.archived && <div className="border-t border-line px-4 py-3 text-sm text-muted">アーカイブされたチャンネルには投稿できません</div>}
        </>
      ) : (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 text-center">
          <span className="flex h-14 w-14 items-center justify-center rounded-2xl bg-accent-soft text-accent">
            <MessagesSquare size={26} />
          </span>
          <strong className="text-base">チャンネルを選択してください</strong>
          <span className="text-sm text-muted">左のリストから選ぶか、{modKey()}+K で移動できます。</span>
        </div>
      )}
    </>
  );
  // The thread or the pinned messages: a resizable column on the right, the whole screen on a phone.
  const sidePane =
    pinsOpen && current && view === "channel" ? (
      <PinsPane controller={controller} channel={current} onOpen={revealFromList} onClose={() => setPinsOpen(false)} />
    ) : threadId && threadChannel ? (
      <ThreadPane controller={controller} channel={threadChannel} parentId={threadId} onClose={() => setThreadId(null)} />
    ) : null;
  const overlays = (
    <>
      <Toast controller={controller} />
      <NoticeToast controller={controller} />
      {switcher && <QuickSwitcher controller={controller} onOpen={open} onClose={() => setSwitcher(false)} />}
      {dialog === "dm" && <NewDmDialog controller={controller} onClose={() => setDialog(null)} onOpen={open} />}
      {dialog === "directory" && <DirectoryDialog controller={controller} onClose={() => setDialog(null)} onOpen={open} />}
      {dialog === "channel" && <NewChannelDialog controller={controller} onClose={() => setDialog(null)} onOpen={open} />}
      {dialog === "members" && current && (
        <MembersDialog controller={controller} channel={current} onClose={() => setDialog(null)} onAdd={() => setDialog("add-member")} />
      )}
      {dialog === "add-member" && current && <AddMemberDialog controller={controller} channelId={current.id} onClose={() => setDialog("members")} />}
      {dialog === "topic" && current && <TopicDialog controller={controller} channel={current} onClose={() => setDialog(null)} />}
      {dialog === "settings" && <SettingsDialog controller={controller} onClose={() => setDialog(null)} onStatus={() => setDialog("status")} />}
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
        <Modal onClose={() => setDialog(null)} title={`#${current.name} を退出しますか？`} className="w-[440px]">
          <p className="mt-3 text-sm text-muted">{current.type === "private" ? "非公開チャンネルなので、戻るには誰かに追加してもらう必要があります。" : "公開チャンネルなので、いつでも再参加できます。"}</p>
          <div className="mt-4 flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setDialog(null)}>キャンセル</Button>
            <Button variant="danger" disabled={busyAction} onClick={() => { setBusyAction(true); void controller.leaveChannel(current.id).then((ok) => { setBusyAction(false); setDialog(null); if (ok) { setCurrentId(null); setPane("list"); } }); }}>
              退出する
            </Button>
          </div>
        </Modal>
      )}
      {dialog === "shortcuts" && <ShortcutsDialog onClose={() => setDialog(null)} />}
    </>
  );

  if (compact) {
    return (
      <BackToList.Provider value={back}>
        <div className="relative h-full overflow-hidden bg-canvas text-ink">
          {/* The list stays mounted under a centre view, so its scroll position survives the round trip. */}
          <div className={cn("absolute inset-0 flex flex-col bg-sidebar", pane === "main" && "invisible")}>
            <div className="flex h-11 shrink-0 items-center px-2">
              <WorkspaceMenu controller={controller} />
            </div>
            <div className="shrink-0 px-3 pb-2">{searchBar}</div>
            <div className="min-h-0 flex-1">{sidebar}</div>
          </div>
          {/* Mounted only while on screen: a hidden timeline would mark messages read. */}
          {pane === "main" && <main className="absolute inset-0 flex min-h-0 flex-col bg-canvas">{centre}</main>}
          {pane === "main" && sidePane && <div className="absolute inset-0 z-30 flex min-h-0 bg-canvas">{sidePane}</div>}
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
          row is the title bar: it moves the window, and leaves room for the window buttons when no rail does. */}
      <div
        data-tauri-drag-region
        className="flex h-10 min-w-0 items-center bg-sidebar px-2"
        style={overlayTitleBar() && !controller.showsRail ? { paddingLeft: TRAFFIC_LIGHTS_INSET } : undefined}
      >
        <WorkspaceMenu controller={controller} />
      </div>
      <div data-tauri-drag-region className="col-span-2 flex h-10 items-center bg-sidebar px-3">
        {searchBar}
      </div>
      {sidebar}
      {/* min-h-0: a grid item's default min-height is its content height, which would grow the row past the window. */}
      <main className="relative flex min-h-0 min-w-0 flex-col">
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label="サイドバーの幅"
          title="ドラッグで幅を変更、ダブルクリックで元に戻す"
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
            aria-label="パネルの幅"
            title="ドラッグで幅を変更、ダブルクリックで元に戻す"
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
    <Modal onClose={onClose} title={`#${channel.name} を${toPrivate ? "非公開" : "公開"}チャンネルに変換しますか？`} className="w-[460px]">
      <p className="mt-3 text-sm text-muted">
        {toPrivate
          ? "メンバー以外はこのチャンネルを見つけられなくなり、参加には招待が必要になります。これまでのメッセージもメンバーだけが読めます。"
          : "ゲスト以外の全員がこのチャンネルを見つけて参加し、これまでのメッセージを含めて読めるようになります。"}
      </p>
      {toPrivate && !isAdmin && <p className="mt-2 text-sm text-muted">公開に戻せるのは管理者だけです。</p>}
      <div className="mt-4 flex justify-end gap-2">
        <Button variant="secondary" onClick={onClose}>キャンセル</Button>
        <Button variant="danger" disabled={busy} onClick={() => onConfirm(toPrivate ? "private" : "public")}>
          {toPrivate ? "非公開にする" : "公開にする"}
        </Button>
      </div>
    </Modal>
  );
}

export function channelTitle(channel: ChannelState, controller: AppController): string {
  return conversationTitle(channel, controller.store.users, controller.store.me?.id ?? null);
}
