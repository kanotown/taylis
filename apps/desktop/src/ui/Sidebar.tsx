import { AlarmClock, AtSign, Bell, BellOff, Bookmark, CalendarDays, CheckCheck, ChevronDown, Compass, FileText, Files, FolderPlus, Hash, ListTodo, Lock, MessagesSquare, Newspaper, NotebookText, Plus, Search, Settings, ShieldCheck, Timer, Users } from "lucide-react";
import { type ReactNode, useState } from "react";

import type { AppController } from "../state/app";
import type { ChannelState } from "../sync/types";
import { Avatar } from "./Avatar";
import { badgeCount, hasUnread, isDmChannel, isMutedChannel, isQuietChannel, sectionChannels, showsSelfNotesInDmSection } from "./channels";
import { useOpenSelfNotes } from "./DmListView";
import { channelTitle, myDisplayName } from "./MainScreen";
import { activityBadge } from "./mobileTabs";
import { Badge, cn, IconButton, Kbd, modKey } from "./primitives";
import { SectionIcon } from "./SectionDialog";
import { ChannelContextMenu, NewSectionDialog, SectionHeaderMenu } from "./SidebarMenus";
import { StatusEmoji } from "./UserPopover";

interface Props {
  controller: AppController;
  channels: ChannelState[];
  currentId: string | null;
  unreadOnly: boolean;
  onToggleUnreadOnly: () => void;
  /** Opens a conversation; one of 「参加できるチャンネル」 opens as its preview (SYNC_PROTOCOL.md §7.6.1), not joined. */
  onOpen: (id: string) => void;
  onNewDm: () => void;
  /** M13g: the member directory. */
  onDirectory?: () => void;
  onNewChannel: () => void;
  /** M24: make (or open) my times. */
  onCreateTimes?: () => void;
  /** L8: the Times feed (the Times section's first row, and an icon in its header for when it is folded). */
  onTimesFeed?: () => void;
  timesFeedActive?: boolean;
  onSearch?: () => void;
  onSettings?: () => void;
  /** The threads view (THREADS.md §5); `threadsActive` highlights its entry instead of a channel. */
  onThreads?: () => void;
  threadsActive?: boolean;
  /** 「保存済み」 (M11c). */
  onSaved?: () => void;
  savedActive?: boolean;
  /** Administration (M11e); shown to admins only. */
  onAdmin?: () => void;
  /** M11h: channel browser, recent mentions and drafts. */
  onBrowse?: () => void;
  /** M39: 「アクティビティ」 with its badge (the recent mentions, 「メンション」, for a server before M39). */
  onActivity?: () => void;
  activityActive?: boolean;
  onDrafts?: () => void;
  draftsActive?: boolean;
  /** M11i: files in my channels. */
  onFiles?: () => void;
  filesActive?: boolean;
  /** M44: the canvases of all my conversations. */
  onCanvases?: () => void;
  canvasesActive?: boolean;
  /** M51: my calendar and my channels'. */
  onCalendar?: () => void;
  calendarActive?: boolean;
  /** M55: 「自分のタスク」 and 「自分の担当」. */
  onTasks?: () => void;
  tasksActive?: boolean;
  /** M85 「締切」. */
  onDeadlines?: () => void;
  deadlinesActive?: boolean;
  /** M12a: every channel read to its end. */
  onReadAll?: () => void;
  /** M12e: reminders; listed while any is open. */
  onReminders?: () => void;
  remindersActive?: boolean;
}

export function Sidebar({ controller, channels, currentId, unreadOnly, onToggleUnreadOnly, onOpen, onNewDm,
  onDirectory, onNewChannel, onCreateTimes, onTimesFeed, timesFeedActive = false, onSearch, onSettings, onThreads, threadsActive = false, onSaved, savedActive = false, onAdmin, onBrowse, onActivity, activityActive = false, onDrafts, draftsActive = false, onFiles, filesActive = false, onCanvases, canvasesActive = false, onCalendar, calendarActive = false, onTasks, tasksActive = false, onDeadlines, deadlinesActive = false, onReadAll, onReminders, remindersActive = false }: Props) {
  const store = controller.store;
  const reminderCount = store.reminders.size;
  const firedCount = store.firedReminderCount();
  const draftCount = store.listDrafts().length + store.scheduled.size;
  // M39: the same badge as the phone's activity tab (none before M39: the entry is the mentions list then).
  const activity = activityBadge(channels, store.threadSummary, store.activity);
  const me = store.me ?? controller.me;
  const sections = sectionChannels(channels, (c) => channelTitle(c, controller), { unreadOnly, currentId, favorites: store.favorites, sections: store.sidebarSections, meId: me?.id ?? null });
  // M24: offer to make my times until I have one.
  const hasMyTimes = !!me && channels.some((c) => c.times_owner_id === me.id);
  // M26: the default sections fold up on this device (my own sections fold on all of them, via the server).
  const [folded, toggleFolded] = useFoldedDefaults();
  const [newSection, setNewSection] = useState(false);
  // My own DM is always the first DM (sectionChannels); until it exists, a placeholder row with my picture and name
  // stands there, not while the section is folded or only unread conversations are listed.
  const myName = myDisplayName(controller);
  const selfPlaceholder = showsSelfNotesInDmSection(channels, me?.id ?? null, myName, { collapsed: folded.has("dms"), unreadOnly });
  const { creating: creatingSelf, open: openSelfNotes } = useOpenSelfNotes(controller, me?.id ?? null, onOpen);
  // A folded section still shows what is unread and the open conversation (Slack). The others stay in the list, folded
  // away (.fold-row), so they slide shut and open rather than jump (testers, 2026-09-29).
  const shown = (rows: ChannelState[], collapsed: boolean) => rows.map((c) => item(c, collapsed && c.id !== currentId && !hasUnread(c, me?.id ?? null)));
  // Dropped on a default section: out of my own section (the conversation goes back where it belongs by kind).
  const backToDefault = (channelId: string) => {
    if (store.sidebarSections.some((section) => section.channel_ids.includes(channelId))) void controller.moveToSection(channelId, null);
  };
  const status = controller.engine?.status ?? "idle";

  const item = (channel: ChannelState, folded = false) => {
    const muted = isMutedChannel(channel);
    const unread = hasUnread(channel, me?.id ?? null) && channel.id !== currentId;
    // M24: someone else's times with new posts but no mention: not bold, a faint dot (SYNC_PROTOCOL.md §10.5).
    const quietUnread = !unread && channel.id !== currentId && channel.unreadCount > 0 && isQuietChannel(channel, me?.id ?? null);
    const badge = badgeCount(channel);
    const active = channel.id === currentId;
    // A DM's avatar is the other person's; my own notes (a DM with only me) show mine.
    const other = isDmChannel(channel) ? ((channel.dm_user_ids ?? []).find((id) => id !== me?.id) ?? me?.id) : undefined;
    return (
      <li key={channel.id} className={cn("fold-row", folded && "folded")} aria-hidden={folded || undefined} inert={folded}>
        <div className="fold-inner">
        <ChannelContextMenu controller={controller} channel={channel}>
        <button
          type="button"
          // M26: dragged onto a section's header (or list) it moves there (Slack).
          draggable
          onDragStart={(event) => {
            event.dataTransfer.setData(CHANNEL_DRAG, channel.id);
            event.dataTransfer.effectAllowed = "move";
          }}
          onClick={() => onOpen(channel.id)}
          title={channelTitle(channel, controller)}
          className={cn(
            "flex w-full items-center gap-2 rounded-lg px-2.5 py-[6px] text-left text-[13.5px] leading-5 transition-colors",
            active ? "bg-sidebar-active text-white" : "hover:bg-sidebar-hover hover:text-white",
            unread && "font-semibold text-white",
            muted && !unread && !active && "opacity-55",
          )}
        >
          {isDmChannel(channel) ? (
            other ? <Avatar
              id={other} name={store.users.get(other)?.display_name ?? "?"} size={18} className="rounded-md text-[9px]"
              presence={store.presenceOf(other)}
              presenceClassName="border border-sidebar"
            /> : <AtSign size={15} className="shrink-0 opacity-70" />
          ) : channel.type === "private" ? (
            <Lock size={15} className="shrink-0 opacity-70" />
          ) : (
            <Hash size={15} className="shrink-0 opacity-70" />
          )}
          <span className="flex-1 truncate">{channelTitle(channel, controller).replace(/^#/, "")}</span>
          {other && <StatusEmoji controller={controller} userId={other} className="shrink-0" />}
          {muted && <BellOff size={12} className="shrink-0 opacity-70" />}
          {unread && badge > 0 ? <Badge tone="danger">{badge}</Badge> : unread ? <span className="h-2 w-2 shrink-0 rounded-full bg-white" /> : quietUnread ? <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-white/40" title="新しい投稿があります (静かな未読)" /> : null}
        </button>
        </ChannelContextMenu>
        </div>
      </li>
    );
  };

  return (
    <nav data-chat-focus aria-label="チャンネルとDM" className="flex h-full min-h-0 flex-col overflow-y-auto bg-sidebar px-2 pb-4 text-sidebar-fg">
      {/* Pinned: my avatar, search, 管理 and 設定 stay in view while the list scrolls. */}
      <div data-testid="sidebar-header" className="sticky top-0 z-10 -mx-2 flex items-center gap-2.5 border-b border-white/10 bg-sidebar px-4 py-3">
        {me && <Avatar id={me.id} name={me.display_name} size={34} className="rounded-xl" />}
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-semibold text-white">{me?.display_name ?? ""}</div>
          <div className="flex min-w-0 items-center gap-1.5 text-[11px] opacity-80" title={statusTitle(status)}>
            <span className={cn("h-2 w-2 shrink-0 rounded-full", status === "online" ? "bg-success" : status === "connecting" ? "animate-pulse bg-warning" : status === "offline" ? "bg-warning" : "bg-white/30")} />
            <span className="truncate whitespace-nowrap">{statusLabel(status)}</span>
          </div>
        </div>
        {onSearch && (
          <IconButton tone="sidebar" label={`検索 (${modKey()}+F)`} onClick={onSearch}>
            <Search size={17} />
          </IconButton>
        )}
        {onAdmin && controller.isAdmin && (
          <IconButton tone="sidebar" label="管理" onClick={onAdmin}>
            <ShieldCheck size={17} />
          </IconButton>
        )}
        {onSettings && (
          <IconButton tone="sidebar" label="設定" onClick={onSettings}>
            <Settings size={17} />
          </IconButton>
        )}
      </div>

      <div className="flex gap-1.5 px-1 py-2.5">
        <button
          type="button"
          onClick={() => window.dispatchEvent(new CustomEvent("chikuwa:quick-switch"))}
          className="flex h-8 flex-1 items-center gap-2 rounded-lg bg-white/8 px-2.5 text-left text-[13px] hover:bg-white/14 hover:text-white"
        >
          <Search size={14} className="opacity-70" />
          <span className="flex-1">移動…</span>
          <Kbd className="border-white/20 bg-transparent text-sidebar-fg/80 max-md:hidden">{modKey()} K</Kbd>
        </button>
        <button
          type="button"
          aria-pressed={unreadOnly}
          title={unreadOnly ? "すべて表示" : "未読のみ表示"}
          onClick={onToggleUnreadOnly}
          className={cn("h-8 rounded-lg px-2.5 text-xs font-medium transition-colors", unreadOnly ? "bg-accent text-white" : "bg-white/8 hover:bg-white/14 hover:text-white")}
        >
          未読
        </button>
      </div>

      {onThreads && (
        <ul className="mt-1 space-y-px">
          <li>
            <button
              type="button"
              onClick={onThreads}
              aria-current={threadsActive ? "page" : undefined}
              title={`スレッド (${modKey()}+Shift+T)`}
              className={cn(
                "flex w-full items-center gap-2 rounded-lg px-2.5 py-[6px] text-left text-[13.5px] leading-5 transition-colors",
                threadsActive ? "bg-sidebar-active text-white" : "hover:bg-sidebar-hover hover:text-white",
                store.threadSummary.unread_count > 0 && "font-semibold text-white",
              )}
            >
              <MessagesSquare size={15} className="shrink-0 opacity-70" />
              <span className="flex-1 truncate">スレッド</span>
              {store.threadSummary.unread_count > 0 && (
                <Badge tone={store.threadSummary.mention_count > 0 ? "danger" : "neutral"} className={store.threadSummary.mention_count > 0 ? undefined : "bg-white/20 text-white"}>
                  {store.threadSummary.unread_count}
                </Badge>
              )}
            </button>
          </li>
          {onActivity && (
            <li>
              <button
                type="button"
                onClick={onActivity}
                aria-current={activityActive ? "page" : undefined}
                aria-label={store.activity ? (activity.count > 0 ? `アクティビティ (未読 ${activity.count})` : "アクティビティ") : "メンション"}
                title={store.activity ? "メンション・スレッドへの返信・リアクション" : "自分宛てのメンション"}
                className={cn(
                  "flex w-full items-center gap-2 rounded-lg px-2.5 py-[6px] text-left text-[13.5px] leading-5 transition-colors",
                  activityActive ? "bg-sidebar-active text-white" : "hover:bg-sidebar-hover hover:text-white",
                  store.activity && activity.count > 0 && "font-semibold text-white",
                )}
              >
                {store.activity ? <Bell size={15} className="shrink-0 opacity-70" /> : <AtSign size={15} className="shrink-0 opacity-70" />}
                <span className="flex-1 truncate">{store.activity ? "アクティビティ" : "メンション"}</span>
                {store.activity && activity.count > 0 && (
                  <Badge tone={activity.mention ? "danger" : "neutral"} className={activity.mention ? undefined : "bg-white/20 text-white"}>
                    <span data-badge={activity.mention ? "danger" : "neutral"}>{activity.count > 99 ? "99+" : activity.count}</span>
                  </Badge>
                )}
              </button>
            </li>
          )}
          {onDrafts && draftCount > 0 && (
            <li>
              <button
                type="button"
                onClick={onDrafts}
                aria-current={draftsActive ? "page" : undefined}
                title="送信していない下書き"
                className={cn(
                  "flex w-full items-center gap-2 rounded-lg px-2.5 py-[6px] text-left text-[13.5px] leading-5 transition-colors",
                  draftsActive ? "bg-sidebar-active text-white" : "hover:bg-sidebar-hover hover:text-white",
                )}
              >
                <FileText size={15} className="shrink-0 opacity-70" />
                <span className="flex-1 truncate">下書き</span>
                <span className="text-[11px] opacity-70">{draftCount}</span>
              </button>
            </li>
          )}
          {onReminders && reminderCount > 0 && (
            <li>
              <button
                type="button"
                onClick={onReminders}
                aria-current={remindersActive ? "page" : undefined}
                title="リマインダー"
                className={cn(
                  "flex w-full items-center gap-2 rounded-lg px-2.5 py-[6px] text-left text-[13.5px] leading-5 transition-colors",
                  remindersActive ? "bg-sidebar-active text-white" : "hover:bg-sidebar-hover hover:text-white",
                  firedCount > 0 && !remindersActive && "font-semibold text-white",
                )}
              >
                <AlarmClock size={15} className="shrink-0 opacity-70" />
                <span className="flex-1 truncate">リマインダー</span>
                {firedCount > 0 ? <Badge tone="danger">{firedCount}</Badge> : <span className="text-[11px] opacity-70">{reminderCount}</span>}
              </button>
            </li>
          )}
          {onFiles && (
            <li>
              <button
                type="button"
                onClick={onFiles}
                aria-current={filesActive ? "page" : undefined}
                title="チャンネルのファイル"
                className={cn(
                  "flex w-full items-center gap-2 rounded-lg px-2.5 py-[6px] text-left text-[13.5px] leading-5 transition-colors",
                  filesActive ? "bg-sidebar-active text-white" : "hover:bg-sidebar-hover hover:text-white",
                )}
              >
                <Files size={15} className="shrink-0 opacity-70" />
                <span className="flex-1 truncate">ファイル</span>
              </button>
            </li>
          )}
          {onCanvases && (
            <li>
              <button
                type="button"
                onClick={onCanvases}
                aria-current={canvasesActive ? "page" : undefined}
                title="自分の会話のキャンバス"
                className={cn(
                  "flex w-full items-center gap-2 rounded-lg px-2.5 py-[6px] text-left text-[13.5px] leading-5 transition-colors",
                  canvasesActive ? "bg-sidebar-active text-white" : "hover:bg-sidebar-hover hover:text-white",
                )}
              >
                <NotebookText size={15} className="shrink-0 opacity-70" />
                <span className="flex-1 truncate">キャンバス</span>
              </button>
            </li>
          )}
          {onCalendar && (
            <li>
              <button
                type="button"
                onClick={onCalendar}
                aria-current={calendarActive ? "page" : undefined}
                title="自分とチャンネルの予定"
                className={cn(
                  "flex w-full items-center gap-2 rounded-lg px-2.5 py-[6px] text-left text-[13.5px] leading-5 transition-colors",
                  calendarActive ? "bg-sidebar-active text-white" : "hover:bg-sidebar-hover hover:text-white",
                )}
              >
                <CalendarDays size={15} className="shrink-0 opacity-70" />
                <span className="flex-1 truncate">カレンダー</span>
              </button>
            </li>
          )}
          {onTasks && (
            <li>
              <button
                type="button"
                onClick={onTasks}
                aria-current={tasksActive ? "page" : undefined}
                title="自分のタスクと担当のタスク"
                className={cn(
                  "flex w-full items-center gap-2 rounded-lg px-2.5 py-[6px] text-left text-[13.5px] leading-5 transition-colors",
                  tasksActive ? "bg-sidebar-active text-white" : "hover:bg-sidebar-hover hover:text-white",
                )}
              >
                <ListTodo size={15} className="shrink-0 opacity-70" />
                <span className="flex-1 truncate">タスク</span>
              </button>
            </li>
          )}
          {onDeadlines && (
            <li>
              <button
                type="button"
                onClick={onDeadlines}
                aria-current={deadlinesActive ? "page" : undefined}
                title="参加しているチャンネルの締切"
                className={cn(
                  "flex w-full items-center gap-2 rounded-lg px-2.5 py-[6px] text-left text-[13.5px] leading-5 transition-colors",
                  deadlinesActive ? "bg-sidebar-active text-white" : "hover:bg-sidebar-hover hover:text-white",
                )}
              >
                <Timer size={15} className="shrink-0 opacity-70" />
                <span className="flex-1 truncate">締切</span>
              </button>
            </li>
          )}
          {onSaved && (
            <li>
              <button
                type="button"
                onClick={onSaved}
                aria-current={savedActive ? "page" : undefined}
                title="保存したメッセージ"
                className={cn(
                  "flex w-full items-center gap-2 rounded-lg px-2.5 py-[6px] text-left text-[13.5px] leading-5 transition-colors",
                  savedActive ? "bg-sidebar-active text-white" : "hover:bg-sidebar-hover hover:text-white",
                )}
              >
                <Bookmark size={15} className="shrink-0 opacity-70" />
                <span className="flex-1 truncate">保存済み</span>
                {store.bookmarks.size > 0 && <span className="text-[11px] opacity-70">{store.bookmarks.size}</span>}
              </button>
            </li>
          )}
        </ul>
      )}

      {sections.favorites.length > 0 && (
        <Section title="お気に入り" collapsed={folded.has("favorites")} onToggle={() => toggleFolded("favorites")} onDropChannel={(id) => { if (!store.isFavorite(id)) void controller.toggleFavorite(id); }}>
          <ul className="space-y-px">{shown(sections.favorites, folded.has("favorites"))}</ul>
        </Section>
      )}
      {sections.custom.map(({ section, channels: members }, index) => (
        <Section
          key={section.id}
          title={section.name}
          icon={<SectionIcon controller={controller} emoji={section.emoji} />}
          collapsed={section.collapsed}
          onToggle={() => void controller.setSectionCollapsed(section.id, !section.collapsed)}
          onDropChannel={(id) => { if (!section.channel_ids.includes(id)) void controller.moveToSection(id, section.id); }}
          action={<SectionHeaderMenu controller={controller} section={section} index={index} count={sections.custom.length} />}
        >
          <ul className="space-y-px">{shown(members, section.collapsed)}</ul>
          {members.length === 0 && !unreadOnly && !section.collapsed && <Hint>会話をここへドラッグ、または右クリック →「セクションに移動」</Hint>}
        </Section>
      ))}
      <Section
        title="チャンネル"
        collapsed={folded.has("channels")}
        onToggle={() => toggleFolded("channels")}
        onDropChannel={backToDefault}
        action={
          <span className="flex items-center">
            {onReadAll && (
              <IconButton tone="sidebar" label="すべて既読にする" className="h-6 w-6" onClick={onReadAll}>
                <CheckCheck size={14} />
              </IconButton>
            )}
            {onBrowse && !controller.isGuest && (
              <IconButton tone="sidebar" label={`チャンネルを探す (${modKey()}+Shift+E)`} className="h-6 w-6" onClick={onBrowse}>
                <Compass size={14} />
              </IconButton>
            )}
            <IconButton tone="sidebar" label="新しいセクション" className="h-6 w-6" onClick={() => setNewSection(true)}>
              <FolderPlus size={14} />
            </IconButton>
            {!controller.isGuest && (
              <IconButton tone="sidebar" label="チャンネルを作成" className="h-6 w-6" onClick={onNewChannel}>
                <Plus size={14} />
              </IconButton>
            )}
          </span>
        }
      >
        <ul className="space-y-px">{shown(sections.channels, folded.has("channels"))}</ul>
        {sections.channels.length === 0 && <Hint>{unreadOnly ? "未読のチャンネルはありません" : "まだチャンネルがありません"}</Hint>}
      </Section>
      {(sections.times.length > 0 || (onCreateTimes && !hasMyTimes && !controller.isGuest && !unreadOnly)) && (
        <Section
          title="Times"
          collapsed={folded.has("times")}
          onToggle={() => toggleFolded("times")}
          onDropChannel={backToDefault}
          action={
            <span className="flex items-center">
              {onTimesFeed && (
                <IconButton tone="sidebar" label="Times フィード" className="h-6 w-6" onClick={onTimesFeed}>
                  <Newspaper size={14} />
                </IconButton>
              )}
              {onCreateTimes && !hasMyTimes && !controller.isGuest && (
                <IconButton tone="sidebar" label="自分の times を作る" className="h-6 w-6" onClick={onCreateTimes}>
                  <Plus size={14} />
                </IconButton>
              )}
            </span>
          }
        >
          <ul className="space-y-px">
            {onTimesFeed && (
              // L8: the posts of every times I am in, newest first (TIMES_FEED.md §7); folded away with the section.
              <li className={cn("fold-row", folded.has("times") && !timesFeedActive && "folded")} aria-hidden={(folded.has("times") && !timesFeedActive) || undefined} inert={folded.has("times") && !timesFeedActive}>
                <div className="fold-inner">
                  <button
                    type="button"
                    onClick={onTimesFeed}
                    aria-current={timesFeedActive ? "page" : undefined}
                    title="参加している times の新しい投稿"
                    className={cn(
                      "flex w-full items-center gap-2 rounded-lg px-2.5 py-[6px] text-left text-[13.5px] leading-5 transition-colors",
                      timesFeedActive ? "bg-sidebar-active text-white" : "hover:bg-sidebar-hover hover:text-white",
                    )}
                  >
                    <Newspaper size={15} className="shrink-0 opacity-70" />
                    <span className="flex-1 truncate">フィード</span>
                  </button>
                </div>
              </li>
            )}
            {shown(sections.times, folded.has("times"))}
          </ul>
          {sections.times.length === 0 && <Hint>+ で自分の times を作成</Hint>}
        </Section>
      )}
      <Section
        title="ダイレクトメッセージ"
        collapsed={folded.has("dms")}
        onToggle={() => toggleFolded("dms")}
        onDropChannel={backToDefault}
        action={
          <span className="flex items-center">
            {onDirectory && (
              <IconButton tone="sidebar" label="メンバー一覧" className="h-6 w-6" onClick={onDirectory}>
                <Users size={14} />
              </IconButton>
            )}
            <IconButton tone="sidebar" label={`DM を開始 (${modKey()}+Shift+K)`} className="h-6 w-6" onClick={onNewDm}>
              <Plus size={14} />
            </IconButton>
          </span>
        }
      >
        <ul className="space-y-px">
          {selfPlaceholder && me && (
            <li>
              <button
                type="button"
                onClick={openSelfNotes}
                disabled={creatingSelf}
                aria-busy={creatingSelf}
                data-self-notes-placeholder=""
                title={myName}
                className="flex w-full items-center gap-2 rounded-lg px-2.5 py-[6px] text-left text-[13.5px] leading-5 transition-colors hover:bg-sidebar-hover hover:text-white disabled:opacity-60"
              >
                <Avatar id={me.id} name={myName} size={18} className="rounded-md text-[9px]" />
                <span className="flex-1 truncate">{myName}</span>
              </button>
            </li>
          )}
          {shown(sections.dms, folded.has("dms"))}
        </ul>
        {sections.dms.length === 0 && !selfPlaceholder && <Hint>{unreadOnly ? "未読の DM はありません" : "+ から相手を選んで開始"}</Hint>}
      </Section>
      {sections.browse.length > 0 && (
        <Section title="参加できるチャンネル">
          <ul className="space-y-px">
            {sections.browse.map((c) => (
              <li key={c.id}>
                {/* M27: a click shows the channel read-only first; its bar joins (Slack). */}
                <button
                  type="button"
                  onClick={() => onOpen(c.id)}
                  aria-current={c.id === currentId ? "page" : undefined}
                  className={cn(
                    "flex w-full items-center gap-2 rounded-lg px-2.5 py-[6px] text-left text-[13.5px]",
                    c.id === currentId ? "bg-sidebar-active text-white" : "opacity-80 hover:bg-sidebar-hover hover:text-white hover:opacity-100",
                  )}
                >
                  <Hash size={15} className="shrink-0 opacity-70" />
                  <span className="flex-1 truncate">{c.name}</span>
                </button>
              </li>
            ))}
          </ul>
        </Section>
      )}
      {newSection && <NewSectionDialog controller={controller} onClose={() => setNewSection(false)} />}
    </nav>
  );
}

const FOLDED_KEY = "chikuwa.sidebar.folded";

/** Which default sections are folded on this device (favorites, channels, times, dms); a per-viewer convenience. */
export function useFoldedDefaults(): [ReadonlySet<string>, (key: string) => void] {
  const [folded, setFolded] = useState<ReadonlySet<string>>(() => {
    try {
      const parsed: unknown = JSON.parse(localStorage.getItem(FOLDED_KEY) ?? "[]");
      return new Set(Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string") : []);
    } catch {
      return new Set();
    }
  });
  const toggle = (key: string) =>
    setFolded((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      try {
        localStorage.setItem(FOLDED_KEY, JSON.stringify([...next]));
      } catch {
        /* folding still works for this session */
      }
      return next;
    });
  return [folded, toggle];
}

/** The data type a dragged conversation row carries (M26); files dragged in from outside have none of it. */
const CHANNEL_DRAG = "application/x-chikuwa-channel";

/**
 * A sidebar section. M26 (Slack): the header folds it (`onToggle`), with an icon before the title; a conversation row
 * dropped on it goes to `onDropChannel`.
 */
function Section({ title, icon, action, children, collapsed = false, onToggle, onDropChannel }: {
  title: string;
  icon?: ReactNode;
  action?: ReactNode;
  children: ReactNode;
  collapsed?: boolean;
  onToggle?: () => void;
  onDropChannel?: (channelId: string) => void;
}) {
  const [over, setOver] = useState(false);
  const accepts = (event: React.DragEvent) => !!onDropChannel && event.dataTransfer.types.includes(CHANNEL_DRAG);
  return (
    <section
      className={cn("mt-3 rounded-lg transition-colors", over && "bg-white/10 ring-1 ring-white/25")}
      onDragOver={(event) => {
        if (!accepts(event)) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "move";
        if (!over) setOver(true);
      }}
      onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOver(false); }}
      onDrop={(event) => {
        setOver(false);
        const id = accepts(event) ? event.dataTransfer.getData(CHANNEL_DRAG) : "";
        if (!id) return;
        event.preventDefault();
        onDropChannel?.(id);
      }}
    >
      <h2 className="mb-1 flex h-6 items-center justify-between gap-1 px-2.5 text-[11px] font-semibold uppercase tracking-wider text-sidebar-fg/70">
        {onToggle ? (
          <button type="button" aria-expanded={!collapsed} onClick={onToggle} className="-ml-1 flex min-w-0 flex-1 items-center gap-1 rounded-md px-1 text-left uppercase hover:text-sidebar-fg">
            <ChevronDown size={12} className={cn("shrink-0 transition-transform duration-200", collapsed && "-rotate-90")} />
            {icon}
            <span className="truncate">{title}</span>
          </button>
        ) : (
          <span className="flex min-w-0 items-center gap-1 truncate">{icon}{title}</span>
        )}
        {action}
      </h2>
      {children}
    </section>
  );
}

function Hint({ children }: { children: React.ReactNode }) {
  return <p className="px-2.5 py-1 text-xs opacity-60">{children}</p>;
}

/** Short enough for the narrowest sidebar (the banner over the conversation says more). */
export function statusLabel(status: string): string {
  switch (status) {
    case "online":
      return "オンライン";
    case "connecting":
      return "接続中…";
    case "offline":
      return "再接続中…";
    default:
      return "オフライン";
  }
}

export function statusTitle(status: string): string {
  switch (status) {
    case "online":
      return "サーバに接続しています";
    case "connecting":
      return "サーバに接続しています…";
    case "offline":
      return "サーバに接続できません。自動で再接続します";
    default:
      return "オフライン";
  }
}
