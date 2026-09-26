import { AtSign, Bell, BellOff, Files, Hash, Keyboard, Lock, MessagesSquare, MoreHorizontal, Pin, Users } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import type { AppController } from "../state/app";
import type { MessageOut } from "../api/types";
import type { ChannelState, NotificationLevel, ThreadEntry } from "../sync/types";
import { hasUnread, isDmChannel, sectionChannels, stepChannel } from "./channels";
import { Composer } from "./Composer";
import { AdminDialog, ArchiveConfirm } from "./AdminDialog";
import { AddMemberDialog, MembersDialog, NewChannelDialog, NewDmDialog, RenameChannelDialog, SettingsDialog, ShortcutsDialog, TopicDialog } from "./Dialogs";
import { formatMuted } from "./format";
import { readSidebarWidth, SIDEBAR_DEFAULT, SIDEBAR_MAX, SIDEBAR_MIN, writeSidebarWidth } from "./prefs";
import { Badge, Button, cn, IconButton, Menu, MenuContent, MenuItem, MenuLabel, MenuRadioGroup, MenuRadioItem, MenuSeparator, MenuTrigger, Modal, modKey } from "./primitives";
import { QuickSwitcher } from "./QuickSwitcher";
import { PinsPane } from "./PinsPane";
import { MentionsView } from "./MentionsView";
import { DraftsView } from "./DraftsView";
import { FilesView } from "./FilesView";
import { ChannelBrowserDialog } from "./ChannelBrowserDialog";
import { SavedView } from "./SavedView";
import { SearchPane } from "./SearchPane";
import { Sidebar } from "./Sidebar";
import { ThreadPane } from "./ThreadPane";
import { ThreadsView } from "./ThreadsView";
import { Timeline } from "./Timeline";
import { Toast } from "./Toast";
import { TypingIndicator } from "./Typing";
import { presenceLabel } from "./Avatar";
import { activeStatus } from "./users";
import { StatusDialog } from "./StatusDialog";

type Dialog = "dm" | "channel" | "members" | "add-member" | "settings" | "topic" | "shortcuts" | "status" | "admin" | "rename" | "archive" | "leave" | "browse" | null;

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
  const [currentId, setCurrentId] = useState<string | null>(engine?.currentChannelId ?? null);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [threadId, setThreadId] = useState<string | null>(null);
  // "threads": the centre column lists followed threads (THREADS.md §5); the selected one opens on the right.
  const [view, setView] = useState<"channel" | "threads" | "saved" | "mentions" | "drafts" | "files">("channel");
  /** M11i: the channel the files view is scoped to (null: all my channels). */
  const [filesChannelId, setFilesChannelId] = useState<string | null>(null);
  const [threadChannelId, setThreadChannelId] = useState<string | null>(null);
  const [searching, setSearching] = useState(false);
  const [pinsOpen, setPinsOpen] = useState(false);
  const [switcher, setSwitcher] = useState(false);
  const [unreadOnly, setUnreadOnly] = useState(readUnreadOnly);
  const [sidebarWidth, setSidebarWidth] = useState(readSidebarWidth);

  // Drag the strip between the sidebar and the conversation to resize; double-click resets.
  const startResize = (event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = sidebarWidth;
    let width = startWidth;
    const move = (e: PointerEvent) => {
      width = Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, startWidth + e.clientX - startX));
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

  const channels = [...store.channels.values()];
  const current: ChannelState | undefined = currentId ? store.getChannel(currentId) : undefined;
  // The thread pane belongs to the current channel, or to the channel of the row picked in the threads view.
  const threadChannel: ChannelState | undefined = view === "threads" ? (threadChannelId ? store.getChannel(threadChannelId) : undefined) : current;
  const status = engine?.status ?? "idle";

  // The keyboard handler is registered once and reads the latest state through this ref.
  const state = useRef({ currentId, dialog, threadId, searching, switcher, view, pinsOpen });
  state.current = { currentId, dialog, threadId, searching, switcher, view, pinsOpen };

  useEffect(() => {
    if (!currentId && channels.length > 0) {
      const first = channels.find((c) => c.isMember) ?? channels[0];
      if (first) setCurrentId(first.id);
    }
  }, [currentId, channels.length]);

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
  };

  const openSaved = () => {
    controller.clearMessageFocus();
    controller.setEditing(null);
    setThreadId(null);
    setThreadChannelId(null);
    setSearching(false);
    setPinsOpen(false);
    setView((v) => (v === "saved" ? "channel" : "saved"));
  };

  /** A card in the pins pane / saved view: show the message in its conversation. */
  const revealFromList = (message: MessageOut) => {
    void controller.revealMessage(message).then((ok) => {
      if (!ok) return;
      setView("channel");
      setSearching(false);
      setPinsOpen(false);
      setCurrentId(message.channel_id);
      setThreadChannelId(message.channel_id);
      setThreadId(message.parent_id ?? null);
    });
  };

  const openFiles = (channelId: string | null) => {
    controller.clearMessageFocus();
    controller.setEditing(null);
    setThreadId(null);
    setThreadChannelId(null);
    setSearching(false);
    setPinsOpen(false);
    setFilesChannelId(channelId);
    setView("files");
  };

  const openView = (next: "mentions" | "drafts") => {
    controller.clearMessageFocus();
    controller.setEditing(null);
    setThreadId(null);
    setThreadChannelId(null);
    setSearching(false);
    setPinsOpen(false);
    setView((v) => (v === next ? "channel" : next));
  };

  const openThreads = () => {
    controller.clearMessageFocus();
    controller.setEditing(null);
    setThreadId(null);
    setThreadChannelId(null);
    setSearching(false);
    setView((v) => (v === "threads" ? "channel" : "threads"));
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
      const sections = sectionChannels(all, (c) => channelTitle(c, controller));
      return [...sections.channels, ...sections.dms];
    };
    const onKey = (event: KeyboardEvent) => {
      const mod = event.metaKey || event.ctrlKey;
      const key = event.key.toLowerCase();
      const s = state.current;
      if (mod && !event.shiftKey && key === "k") {
        event.preventDefault();
        setSwitcher(true);
      } else if (mod && event.shiftKey && key === "k") {
        event.preventDefault();
        setDialog("dm");
      } else if (mod && !event.shiftKey && key === "f") {
        event.preventDefault();
        setSearching(true);
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
        const next = stepChannel(navigationOrder(), s.currentId, event.key === "ArrowDown" ? 1 : -1, { unreadOnly: event.shiftKey });
        if (next) open(next.id);
      } else if (event.key === "Escape") {
        if (s.switcher) setSwitcher(false);
        else if (s.dialog) setDialog(null);
        else if (s.searching) setSearching(false);
        else if (s.pinsOpen) setPinsOpen(false);
        else if (s.threadId) setThreadId(null);
        else if (controller.editing) controller.setEditing(null);
        else if (s.view !== "channel") setView("channel");
        else if (s.currentId) {
          // Nothing to close: Esc marks the open conversation read (Mattermost).
          const channel = controller.store.getChannel(s.currentId);
          if (channel && hasUnread(channel)) controller.engine?.markRead(channel.id, channel.lastSeq, { force: true });
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

  return (
    <div
      className="grid h-full grid-cols-[var(--sidebar-w)_minmax(0,1fr)_auto] grid-rows-[minmax(0,1fr)] overflow-hidden bg-canvas text-ink"
      style={{ "--sidebar-w": `${sidebarWidth}px` } as React.CSSProperties}
    >
      <Sidebar
        controller={controller}
        channels={channels}
        currentId={currentId}
        unreadOnly={unreadOnly}
        onToggleUnreadOnly={toggleUnreadOnly}
        onOpen={open}
        onJoin={(id) => void join(id)}
        onNewDm={() => setDialog("dm")}
        onNewChannel={() => setDialog("channel")}
        onSearch={() => setSearching(true)}
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
        onFiles={() => (view === "files" ? setView("channel") : openFiles(null))}
        filesActive={view === "files"}
      />
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
        {status !== "online" && status !== "idle" && (
          <div className={cn("px-4 py-1 text-center text-xs font-medium text-white", status === "connecting" ? "bg-accent" : "bg-warning")}>
            {status === "connecting" ? "サーバに接続しています…" : "オフラインです。再接続を待っています…"}
          </div>
        )}
        {view === "threads" ? (
          <ThreadsView controller={controller} selectedId={threadId} onOpen={openThreadEntry} />
        ) : view === "saved" ? (
          <SavedView controller={controller} onOpen={revealFromList} />
        ) : view === "mentions" ? (
          <MentionsView controller={controller} onOpen={revealFromList} />
        ) : view === "files" ? (
          <FilesView controller={controller} channelId={filesChannelId} onChannelChange={setFilesChannelId} onOpen={revealFromList} />
        ) : view === "drafts" ? (
          <DraftsView controller={controller} onOpen={(channelId, parentId) => { open(channelId); if (parentId) { setThreadChannelId(channelId); setThreadId(parentId); } }} />
        ) : current ? (
          <>
            <header className="flex h-[52px] items-center gap-3 border-b border-line px-4">
              <div className="flex min-w-0 flex-1 items-center gap-2">
                <span className="text-muted">
                  {isChannel ? (current.type === "private" ? <Lock size={18} /> : <Hash size={18} />) : <AtSign size={18} />}
                </span>
                <strong className="truncate text-[15px]">{channelTitle(current, controller).replace(/^#/, "")}</strong>
                {current.archived && <Badge>アーカイブ済み</Badge>}
                {isChannel && current.isMember && !current.archived && (
                  <button
                    type="button"
                    className={cn("min-w-0 truncate text-sm hover:underline", current.topic ? "text-muted" : "text-muted/70")}
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
              <div className="flex items-center gap-0.5">
                {current.isMember && (
                  <>
                    <IconButton label="ピン留め" className={cn(pinsOpen && "bg-ink/6 text-warning")} onClick={() => setPinsOpen((open) => !open)}>
                      <Pin size={18} />
                    </IconButton>
                    <IconButton label="ファイル" onClick={() => openFiles(current.id)}>
                      <Files size={18} />
                    </IconButton>
                  </>
                )}
                {isChannel && (
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
                {isChannel && current.isMember && (
                  <Menu>
                    <MenuTrigger asChild>
                      <button type="button" aria-label="チャンネルの操作" title="チャンネルの操作" className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-ink transition-colors hover:bg-ink/6">
                        <MoreHorizontal size={18} />
                      </button>
                    </MenuTrigger>
                    <MenuContent>
                      <MenuLabel>#{current.name}</MenuLabel>
                      {!current.archived && <MenuItem onSelect={() => setDialog("topic")}>トピックを編集</MenuItem>}
                      {canManage && !current.archived && <MenuItem onSelect={() => setDialog("rename")}>名前を変更</MenuItem>}
                      <MenuItem onSelect={() => setDialog("members")}>メンバー</MenuItem>
                      <MenuSeparator />
                      <MenuItem onSelect={() => setDialog("leave")}>チャンネルを退出</MenuItem>
                      {canManage && !current.archived && <MenuItem className="text-danger" onSelect={() => setDialog("archive")}>アーカイブ</MenuItem>}
                    </MenuContent>
                  </Menu>
                )}
                <IconButton label={`キーボードショートカット (${modKey()}+/)`} onClick={() => setDialog("shortcuts")}>
                  <Keyboard size={18} />
                </IconButton>
                {!current.isMember && (
                  <Button size="sm" className="ml-2" onClick={() => void join(current.id)}>
                    参加する
                  </Button>
                )}
              </div>
            </header>
            <Timeline controller={controller} channel={current} onOpenThread={(id) => { setThreadChannelId(current.id); setThreadId(id); }} />
            {current.isMember && !current.archived && <TypingIndicator controller={controller} channelId={current.id} />}
            {current.isMember && !current.archived && <Composer key={current.id} controller={controller} channel={current} onReplyLast={replyToLast} />}
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
      </main>
      {searching ? (
        <SearchPane
          controller={controller}
          onClose={() => setSearching(false)}
          onOpen={(message) => {
            void controller.revealMessage(message).then((ok) => {
              if (ok) { setCurrentId(message.channel_id); setThreadId(message.parent_id ?? null); setSearching(false); }
            });
          }}
        />
      ) : pinsOpen && current && view === "channel" ? (
        <PinsPane controller={controller} channel={current} onOpen={revealFromList} onClose={() => setPinsOpen(false)} />
      ) : threadId && threadChannel ? (
        <ThreadPane controller={controller} channel={threadChannel} parentId={threadId} onClose={() => setThreadId(null)} />
      ) : null}
      <Toast controller={controller} />
      {switcher && <QuickSwitcher controller={controller} onOpen={open} onClose={() => setSwitcher(false)} />}
      {dialog === "dm" && <NewDmDialog controller={controller} onClose={() => setDialog(null)} onOpen={open} />}
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
      {dialog === "leave" && current && (
        <Modal onClose={() => setDialog(null)} title={`#${current.name} を退出しますか？`} className="w-[440px]">
          <p className="mt-3 text-sm text-muted">{current.type === "private" ? "非公開チャンネルなので、戻るには誰かに追加してもらう必要があります。" : "公開チャンネルなので、いつでも再参加できます。"}</p>
          <div className="mt-4 flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setDialog(null)}>キャンセル</Button>
            <Button variant="danger" disabled={busyAction} onClick={() => { setBusyAction(true); void controller.leaveChannel(current.id).then((ok) => { setBusyAction(false); setDialog(null); if (ok) setCurrentId(null); }); }}>
              退出する
            </Button>
          </div>
        </Modal>
      )}
      {dialog === "shortcuts" && <ShortcutsDialog onClose={() => setDialog(null)} />}
    </div>
  );
}

export function channelTitle(channel: ChannelState, controller: AppController): string {
  if (channel.type === "public" || channel.type === "private") return `#${channel.name ?? ""}`;
  const me = controller.store.me?.id;
  const others = (channel.dm_user_ids ?? []).filter((id) => id !== me);
  if (others.length === 0) return "自分へのメモ";
  return others.map((id) => controller.store.users.get(id)?.display_name ?? "…").join(", ");
}
