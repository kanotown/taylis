import { AlarmClock, AtSign, Bell, BellOff, BookOpen, Bookmark, CalendarDays, CheckCheck, ChevronDown, Compass, DoorOpen, FileText, Files, FolderPlus, Hash, ListTodo, Lock, MessagesSquare, Newspaper, NotebookText, Plus, Search, Settings, ShieldCheck, Ticket, Timer, Users } from "lucide-react";
import { type ReactNode, useState } from "react";

import type { DefaultSectionKey } from "../api/types";
import type { AppController, SortTarget } from "../state/app";
import type { ChannelState } from "../sync/types";
import { Avatar } from "./Avatar";
import { badgeCount, defaultSort, hasUnread, isDmChannel, isMutedChannel, isQuietChannel, sectionChannels, showsSelfNotesInDmSection } from "./channels";
import { useOpenSelfNotes } from "./DmListView";
import { channelTitle, myDisplayName } from "./MainScreen";
import { activityBadge } from "./mobileTabs";
import { desktopNavKeys, sidebarNavKeys } from "./navItems";
import { Badge, cn, IconButton, Kbd, modKey } from "./primitives";
import { SectionIcon } from "./SectionDialog";
import { ChannelContextMenu, DefaultSectionMenu, NewSectionDialog, PinMark, SectionHeaderMenu } from "./SidebarMenus";
import { StatusEmoji, UserPopover } from "./UserPopover";
import { t } from "../i18n";

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
  /** M121: 「ドキュメント」 (none for a server without Docs). */
  onDocs?: () => void;
  docsActive?: boolean;
  /** M51: my calendar and my channels'. */
  onCalendar?: () => void;
  calendarActive?: boolean;
  /** M55: 「自分のタスク」 and 「自分の担当」. */
  onTasks?: () => void;
  tasksActive?: boolean;
  /** M85 「締切」. */
  onDeadlines?: () => void;
  deadlinesActive?: boolean;
  /** M112: 「予約」 (shown once the server answered the pools; a server before M112 has none). */
  onReservations?: () => void;
  reservationsActive?: boolean;
  /** To-dos due in the pools I operate. */
  reservationsCount?: number;
  /** M140: 「在室状況」 (only while the workspace has the board on); the number is who is in the room. */
  onAttendance?: () => void;
  attendanceActive?: boolean;
  attendanceCount?: number;
  /** M12a: every channel read to its end. */
  onReadAll?: () => void;
  /** M12e: reminders; listed while any is open. */
  onReminders?: () => void;
  remindersActive?: boolean;
}

export function Sidebar({ controller, channels, currentId, unreadOnly, onToggleUnreadOnly, onOpen, onNewDm,
  onDirectory, onNewChannel, onCreateTimes, onTimesFeed, timesFeedActive = false, onSearch, onSettings, onThreads, threadsActive = false, onSaved, savedActive = false, onAdmin, onBrowse, onActivity, activityActive = false, onDrafts, draftsActive = false, onFiles, filesActive = false, onCanvases, canvasesActive = false, onDocs, docsActive = false, onCalendar, calendarActive = false, onTasks, tasksActive = false, onDeadlines, deadlinesActive = false, onReservations, reservationsActive = false, reservationsCount = 0, onAttendance, attendanceActive = false, attendanceCount = 0, onReadAll, onReminders, remindersActive = false }: Props) {
  const store = controller.store;
  const reminderCount = store.reminders.size;
  const firedCount = store.firedReminderCount();
  const draftCount = store.listDrafts().length + store.scheduled.size;
  // M39: the same badge as the phone's activity tab (none before M39: the entry is the mentions list then).
  const activity = activityBadge(channels, store.threadSummary, store.activity);
  const me = store.me ?? controller.me;
  const sections = sectionChannels(channels, { unreadOnly, currentId, favorites: store.favorites, sections: store.sidebarSections, defaults: store.sidebarDefaults, meId: me?.id ?? null, title: (c) => channelTitle(c, controller), dmPins: store.dmPins, closedDms: store.closedDms });
  // DATA_MODEL.md sidebar_sections 「並べ替え」: each section's sort from its ⋯ menu; in 「手動」 a row dragged onto another row of
  // the same section lands before or after it (not while only unread conversations are listed: the hidden ones would
  // lose their place).
  const ids = (list: ChannelState[]) => () => list.map((c) => c.id);
  const defaultSortOf = (key: DefaultSectionKey) => defaultSort(store.sidebarDefaults, key).sort ?? "name";
  const sortMenu = (key: DefaultSectionKey, title: string, list: ChannelState[]) => (
    <DefaultSectionMenu controller={controller} target={{ default: key }} title={title} sort={defaultSortOf(key)} shownIds={ids(list)} />
  );
  const reorder = (target: SortTarget, list: ChannelState[], sort: string | null | undefined): Reorder | undefined =>
    sort === "manual" && !unreadOnly ? { ids: list.map((c) => c.id), apply: (next) => void controller.reorderSection(target, next) } : undefined;
  // M24: offer to make my times until I have one.
  const hasMyTimes = !!me && channels.some((c) => c.times_owner_id === me.id);
  // M26: the default sections fold up on this device (my own sections fold on all of them, via the server).
  const [folded, toggleFolded] = useFoldedDefaults();
  const [newSection, setNewSection] = useState(false);
  // My own DM is always the first DM (sectionChannels); until it exists, a placeholder row with my picture and name
  // stands there, not while the section is folded or only unread conversations are listed.
  const myName = myDisplayName(controller);
  const selfPlaceholder = showsSelfNotesInDmSection(channels, me?.id ?? null, myName, { collapsed: folded.has("dms"), unreadOnly });
  // M118: the placeholder stands after the pinned DMs, where my own DM would be.
  const pinnedDms = sections.dms.filter((c) => store.isDmPinned(c.id)).length;
  const dmOrder = reorder({ default: "dms" }, sections.dms, defaultSortOf("dms"));
  const { creating: creatingSelf, open: openSelfNotes } = useOpenSelfNotes(controller, me?.id ?? null, onOpen);
  // A folded section still shows what is unread and the open conversation (Slack). The others stay in the list, folded
  // away (.fold-row), so they slide shut and open rather than jump (testers, 2026-09-29).
  // `keep` names more rows a folded section still shows (Times: my own times).
  const shown = (rows: ChannelState[], collapsed: boolean, keep?: (c: ChannelState) => boolean, order?: Reorder) =>
    rows.map((c) => item(c, collapsed && c.id !== currentId && !hasUnread(c, me?.id ?? null) && !keep?.(c), order));
  // Times folded: 「フィード」 and my own times stay within reach (the others fold away); nothing extra without my times.
  const isMyTimes = (c: ChannelState) => !!me && c.times_owner_id === me.id;
  const timesFolded = folded.has("times");
  const feedFolded = timesFolded && !timesFeedActive && !hasMyTimes;
  // Dropped on a default section: out of my own section or out of お気に入り (the conversation goes back where it
  // belongs by kind). One place per conversation (DATA_MODEL.md sidebar_sections).
  const backToDefault = (channelId: string) => {
    if (store.isFavorite(channelId)) void controller.toggleFavorite(channelId);
    else if (store.sidebarSections.some((section) => section.channel_ids.includes(channelId))) void controller.moveToSection(channelId, null);
  };
  const status = controller.engine?.status ?? "idle";
  // My own sections reorder by dragging a header onto another (before or after it, by the pointer's half); the ⋯ menu's
  // 上へ / 下へ is the keyboard's way. The default sections stay where they are (they have no place on the server).
  const dropSection = (draggedId: string, targetIndex: number, after: boolean) => {
    const from = sections.custom.findIndex(({ section }) => section.id === draggedId);
    if (from < 0) return;
    let to = targetIndex + (after ? 1 : 0);
    if (from < to) to -= 1;
    if (to !== from) void controller.moveSection(draggedId, to);
  };
  // M111: the menu items I chose to show, in my order (UserMe.nav_items; null = all, the default order).
  // M140: 「在室状況」 while the workspace has the board on.
  const navKeys = sidebarNavKeys(me?.nav_items, desktopNavKeys(!!store.attendance));

  const item = (channel: ChannelState, folded = false, order?: Reorder) => {
    const muted = isMutedChannel(channel);
    const unread = hasUnread(channel, me?.id ?? null) && channel.id !== currentId;
    // M24: someone else's times with new posts but no mention: not bold, a faint dot (SYNC_PROTOCOL.md §10.5).
    const quietUnread = !unread && channel.id !== currentId && channel.unreadCount > 0 && isQuietChannel(channel, me?.id ?? null);
    const badge = badgeCount(channel);
    const active = channel.id === currentId;
    // A DM's avatar is the other person's; my own notes (a DM with only me) show mine.
    const other = isDmChannel(channel) ? ((channel.dm_user_ids ?? []).find((id) => id !== me?.id) ?? me?.id) : undefined;
    return (
      <ReorderRow key={channel.id} id={channel.id} order={order} folded={folded}>
        <div className="fold-inner">
        <ChannelContextMenu controller={controller} channel={channel}>
        <button
          type="button"
          // M26: dragged onto a section's header (or list) it moves there (Slack).
          draggable
          onDragStart={(event) => {
            event.dataTransfer.setData(CHANNEL_DRAG, channel.id);
            event.dataTransfer.effectAllowed = "move";
            draggedChannel = channel.id;
          }}
          onDragEnd={() => {
            draggedChannel = null;
          }}
          onClick={() => onOpen(channel.id)}
          title={channelTitle(channel, controller)}
          className={cn(
            "flex w-full items-center gap-2 rounded-lg py-[6px] text-left text-[13.5px] leading-5 transition-colors", SECTION_ROW_PAD,
            // Unread before active: on the active row its text colour wins (white on the accent of a light sidebar).
            unread && "font-semibold text-sidebar-strong",
            active ? "bg-sidebar-active text-sidebar-active-fg" : "hover:bg-sidebar-hover hover:text-sidebar-strong",
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
          {store.isDmPinned(channel.id) && <PinMark className="opacity-70" />}
          {muted && <BellOff size={12} className="shrink-0 opacity-70" />}
          {unread && badge > 0 ? <Badge tone="danger">{badge}</Badge> : unread ? <span className="h-2 w-2 shrink-0 rounded-full bg-sidebar-strong" /> : quietUnread ? <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-sidebar-strong/40" title={t("sidebar.quietUnread")} /> : null}
        </button>
        </ChannelContextMenu>
        </div>
      </ReorderRow>
    );
  };

  return (
    <nav data-chat-focus aria-label={t("sidebar.label")} className="flex h-full min-h-0 flex-col overflow-y-auto border-r border-sidebar-edge bg-sidebar px-2 pb-4 text-sidebar-fg">
      {/* Pinned: my avatar, search, 管理 and 設定 stay in view while the list scrolls. */}
      <div data-testid="sidebar-header" className="sticky top-0 z-10 -mx-2 flex items-center gap-2.5 border-b border-sidebar-line bg-sidebar px-4 py-3">
        {/* M93: my picture and name open my own profile card (status, title, 「プロフィールを編集」). */}
        {me ? (
          <UserPopover controller={controller} userId={me.id} className="-my-1 -ml-1.5 flex min-w-0 flex-1 items-center gap-2.5 rounded-lg py-1 pl-1.5 pr-1 hover:bg-sidebar-strong/10">
            <SidebarIdentity controller={controller} meId={me.id} name={me.display_name} status={status} />
          </UserPopover>
        ) : (
          <div className="flex min-w-0 flex-1 items-center gap-2.5">
            <SidebarIdentity controller={controller} meId={null} name="" status={status} />
          </div>
        )}
        {onSearch && (
          <IconButton tone="sidebar" label={t("sidebar.searchKey", { key: `${modKey()}+F` })} onClick={onSearch}>
            <Search size={17} />
          </IconButton>
        )}
        {onAdmin && controller.canAdminister && (
          <IconButton tone="sidebar" label={t("settings.section.admin")} onClick={onAdmin}>
            <ShieldCheck size={17} />
          </IconButton>
        )}
        {onSettings && (
          <IconButton tone="sidebar" label={t("settings.title")} onClick={onSettings}>
            <Settings size={17} />
          </IconButton>
        )}
      </div>

      <div className="flex gap-1.5 px-1 py-2.5">
        <button
          type="button"
          onClick={() => window.dispatchEvent(new CustomEvent("chikuwa:quick-switch"))}
          className="flex h-8 flex-1 items-center gap-2 rounded-lg bg-sidebar-strong/8 px-2.5 text-left text-[13px] hover:bg-sidebar-strong/14 hover:text-sidebar-strong"
        >
          <Search size={14} className="opacity-70" />
          <span className="flex-1">{t("sidebar.jump")}</span>
          <Kbd className="border-sidebar-strong/20 bg-transparent text-sidebar-fg/80 max-md:hidden">{modKey()} K</Kbd>
        </button>
        <button
          type="button"
          aria-pressed={unreadOnly}
          title={unreadOnly ? t("sidebar.showAll") : t("sidebar.showUnreadOnly")}
          onClick={onToggleUnreadOnly}
          className={cn("h-8 rounded-lg px-2.5 text-xs font-medium transition-colors", unreadOnly ? "bg-accent-solid text-white" : "bg-sidebar-strong/8 hover:bg-sidebar-strong/14 hover:text-sidebar-strong")}
        >
          {t("sidebar.unread")}
        </button>
      </div>

      {onThreads && (
        <ul className="mt-1 space-y-px">
          {navKeys.map((key) => {
            switch (key) {
              case "threads":
                return (
                <li key="threads">
                  <button
                    type="button"
                    onClick={onThreads}
                    aria-current={threadsActive ? "page" : undefined}
                    title={t("sidebar.threadsKey", { key: `${modKey()}+Shift+T` })}
                    className={cn(
                      "flex w-full items-center gap-2 rounded-lg px-2.5 py-[6px] text-left text-[13.5px] leading-5 transition-colors",
                      store.threadSummary.unread_count > 0 && "font-semibold text-sidebar-strong",
                      threadsActive ? "bg-sidebar-active text-sidebar-active-fg" : "hover:bg-sidebar-hover hover:text-sidebar-strong",
                    )}
                  >
                    <MessagesSquare size={15} className="shrink-0 opacity-70" />
                    <span className="flex-1 truncate">{t("nav.threads")}</span>
                    {store.threadSummary.unread_count > 0 && (
                      <Badge tone={store.threadSummary.mention_count > 0 ? "danger" : "neutral"} className={store.threadSummary.mention_count > 0 ? undefined : "bg-current/20 text-inherit"}>
                        {store.threadSummary.unread_count}
                      </Badge>
                    )}
                  </button>
                </li>
                );
              case "activity":
                return onActivity ? (
                <li key="activity">
                  <button
                    type="button"
                    onClick={onActivity}
                    aria-current={activityActive ? "page" : undefined}
                    aria-label={store.activity ? (activity.count > 0 ? t("sidebar.activityUnread", { count: activity.count }) : t("nav.activity")) : t("nav.mentions")}
                    title={store.activity ? t("sidebar.activityTitle") : t("sidebar.mentionsTitle")}
                    className={cn(
                      "flex w-full items-center gap-2 rounded-lg px-2.5 py-[6px] text-left text-[13.5px] leading-5 transition-colors",
                      store.activity && activity.count > 0 && "font-semibold text-sidebar-strong",
                      activityActive ? "bg-sidebar-active text-sidebar-active-fg" : "hover:bg-sidebar-hover hover:text-sidebar-strong",
                    )}
                  >
                    {store.activity ? <Bell size={15} className="shrink-0 opacity-70" /> : <AtSign size={15} className="shrink-0 opacity-70" />}
                    <span className="flex-1 truncate">{store.activity ? t("nav.activity") : t("nav.mentions")}</span>
                    {store.activity && activity.count > 0 && (
                      <Badge tone={activity.mention ? "danger" : "neutral"} className={activity.mention ? undefined : "bg-current/20 text-inherit"}>
                        <span data-badge={activity.mention ? "danger" : "neutral"}>{activity.count > 99 ? "99+" : activity.count}</span>
                      </Badge>
                    )}
                  </button>
                </li>
                ) : null;
              case "drafts":
                return onDrafts && draftCount > 0 ? (
                <li key="drafts">
                  <button
                    type="button"
                    onClick={onDrafts}
                    aria-current={draftsActive ? "page" : undefined}
                    title={t("sidebar.draftsTitle")}
                    className={cn(
                      "flex w-full items-center gap-2 rounded-lg px-2.5 py-[6px] text-left text-[13.5px] leading-5 transition-colors",
                      draftsActive ? "bg-sidebar-active text-sidebar-active-fg" : "hover:bg-sidebar-hover hover:text-sidebar-strong",
                    )}
                  >
                    <FileText size={15} className="shrink-0 opacity-70" />
                    <span className="flex-1 truncate">{t("nav.drafts")}</span>
                    <span className="text-[11px] opacity-70">{draftCount}</span>
                  </button>
                </li>
                ) : null;
              case "reminders":
                return onReminders && reminderCount > 0 ? (
                <li key="reminders">
                  <button
                    type="button"
                    onClick={onReminders}
                    aria-current={remindersActive ? "page" : undefined}
                    title={t("nav.reminders")}
                    className={cn(
                      "flex w-full items-center gap-2 rounded-lg px-2.5 py-[6px] text-left text-[13.5px] leading-5 transition-colors",
                      remindersActive ? "bg-sidebar-active text-sidebar-active-fg" : "hover:bg-sidebar-hover hover:text-sidebar-strong",
                      firedCount > 0 && !remindersActive && "font-semibold text-sidebar-strong",
                    )}
                  >
                    <AlarmClock size={15} className="shrink-0 opacity-70" />
                    <span className="flex-1 truncate">{t("nav.reminders")}</span>
                    {firedCount > 0 ? <Badge tone="danger">{firedCount}</Badge> : <span className="text-[11px] opacity-70">{reminderCount}</span>}
                  </button>
                </li>
                ) : null;
              case "files":
                return onFiles ? (
                <li key="files">
                  <button
                    type="button"
                    onClick={onFiles}
                    aria-current={filesActive ? "page" : undefined}
                    title={t("sidebar.filesTitle")}
                    className={cn(
                      "flex w-full items-center gap-2 rounded-lg px-2.5 py-[6px] text-left text-[13.5px] leading-5 transition-colors",
                      filesActive ? "bg-sidebar-active text-sidebar-active-fg" : "hover:bg-sidebar-hover hover:text-sidebar-strong",
                    )}
                  >
                    <Files size={15} className="shrink-0 opacity-70" />
                    <span className="flex-1 truncate">{t("nav.files")}</span>
                  </button>
                </li>
                ) : null;
              case "canvases":
                return onCanvases ? (
                <li key="canvases">
                  <button
                    type="button"
                    onClick={onCanvases}
                    aria-current={canvasesActive ? "page" : undefined}
                    title={t("sidebar.canvasesTitle")}
                    className={cn(
                      "flex w-full items-center gap-2 rounded-lg px-2.5 py-[6px] text-left text-[13.5px] leading-5 transition-colors",
                      canvasesActive ? "bg-sidebar-active text-sidebar-active-fg" : "hover:bg-sidebar-hover hover:text-sidebar-strong",
                    )}
                  >
                    <NotebookText size={15} className="shrink-0 opacity-70" />
                    <span className="flex-1 truncate">{t("nav.canvases")}</span>
                  </button>
                </li>
                ) : null;
              case "docs":
                return onDocs ? (
                <li key="docs">
                  <button
                    type="button"
                    onClick={onDocs}
                    aria-current={docsActive ? "page" : undefined}
                    title={t("sidebar.docsTitle")}
                    className={cn(
                      "flex w-full items-center gap-2 rounded-lg px-2.5 py-[6px] text-left text-[13.5px] leading-5 transition-colors",
                      docsActive ? "bg-sidebar-active text-sidebar-active-fg" : "hover:bg-sidebar-hover hover:text-sidebar-strong",
                    )}
                  >
                    <BookOpen size={15} className="shrink-0 opacity-70" />
                    <span className="flex-1 truncate">{t("nav.docs")}</span>
                  </button>
                </li>
                ) : null;
              case "calendar":
                return onCalendar ? (
                <li key="calendar">
                  <button
                    type="button"
                    onClick={onCalendar}
                    aria-current={calendarActive ? "page" : undefined}
                    title={t("sidebar.calendarTitle")}
                    className={cn(
                      "flex w-full items-center gap-2 rounded-lg px-2.5 py-[6px] text-left text-[13.5px] leading-5 transition-colors",
                      calendarActive ? "bg-sidebar-active text-sidebar-active-fg" : "hover:bg-sidebar-hover hover:text-sidebar-strong",
                    )}
                  >
                    <CalendarDays size={15} className="shrink-0 opacity-70" />
                    <span className="flex-1 truncate">{t("nav.calendar")}</span>
                  </button>
                </li>
                ) : null;
              case "tasks":
                return onTasks ? (
                <li key="tasks">
                  <button
                    type="button"
                    onClick={onTasks}
                    aria-current={tasksActive ? "page" : undefined}
                    title={t("sidebar.tasksTitle")}
                    className={cn(
                      "flex w-full items-center gap-2 rounded-lg px-2.5 py-[6px] text-left text-[13.5px] leading-5 transition-colors",
                      tasksActive ? "bg-sidebar-active text-sidebar-active-fg" : "hover:bg-sidebar-hover hover:text-sidebar-strong",
                    )}
                  >
                    <ListTodo size={15} className="shrink-0 opacity-70" />
                    <span className="flex-1 truncate">{t("nav.tasks")}</span>
                  </button>
                </li>
                ) : null;
              case "deadlines":
                return onDeadlines ? (
                <li key="deadlines">
                  <button
                    type="button"
                    onClick={onDeadlines}
                    aria-current={deadlinesActive ? "page" : undefined}
                    title={t("sidebar.deadlinesTitle")}
                    className={cn(
                      "flex w-full items-center gap-2 rounded-lg px-2.5 py-[6px] text-left text-[13.5px] leading-5 transition-colors",
                      deadlinesActive ? "bg-sidebar-active text-sidebar-active-fg" : "hover:bg-sidebar-hover hover:text-sidebar-strong",
                    )}
                  >
                    <Timer size={15} className="shrink-0 opacity-70" />
                    <span className="flex-1 truncate">{t("nav.deadlines")}</span>
                  </button>
                </li>
                ) : null;
              case "reservations":
                // M112: 「予約」, once the server answered the pools; the number is the to-dos due in the pools I operate.
                return onReservations ? (
                <li key="reservations">
                  <button
                    type="button"
                    onClick={onReservations}
                    data-nav-item="reservations"
                    aria-current={reservationsActive ? "page" : undefined}
                    title={t("sidebar.reservationsTitle")}
                    className={cn(
                      "flex w-full items-center gap-2 rounded-lg px-2.5 py-[6px] text-left text-[13.5px] leading-5 transition-colors",
                      reservationsActive ? "bg-sidebar-active text-sidebar-active-fg" : "hover:bg-sidebar-hover hover:text-sidebar-strong",
                    )}
                  >
                    <Ticket size={15} className="shrink-0 opacity-70" />
                    <span className="flex-1 truncate">{t("nav.reservations")}</span>
                    {!!reservationsCount && <Badge tone="danger">{reservationsCount > 99 ? "99+" : reservationsCount}</Badge>}
                  </button>
                </li>
                ) : null;
              case "attendance":
                // M140: 「在室状況」, while the workspace has the board on; a quiet count of who is in the room.
                return onAttendance ? (
                <li key="attendance">
                  <button
                    type="button"
                    onClick={onAttendance}
                    data-nav-item="attendance"
                    aria-current={attendanceActive ? "page" : undefined}
                    title={t("sidebar.attendanceTitle")}
                    className={cn(
                      "flex w-full items-center gap-2 rounded-lg px-2.5 py-[6px] text-left text-[13.5px] leading-5 transition-colors",
                      attendanceActive ? "bg-sidebar-active text-sidebar-active-fg" : "hover:bg-sidebar-hover hover:text-sidebar-strong",
                    )}
                  >
                    <DoorOpen size={15} className="shrink-0 opacity-70" />
                    <span className="flex-1 truncate">{t("nav.attendance")}</span>
                    {attendanceCount > 0 && <span className="text-xs opacity-70">{attendanceCount}</span>}
                  </button>
                </li>
                ) : null;
              case "saved":
                return onSaved ? (
                <li key="saved">
                  <button
                    type="button"
                    onClick={onSaved}
                    aria-current={savedActive ? "page" : undefined}
                    title={t("sidebar.savedTitle")}
                    className={cn(
                      "flex w-full items-center gap-2 rounded-lg px-2.5 py-[6px] text-left text-[13.5px] leading-5 transition-colors",
                      savedActive ? "bg-sidebar-active text-sidebar-active-fg" : "hover:bg-sidebar-hover hover:text-sidebar-strong",
                    )}
                  >
                    <Bookmark size={15} className="shrink-0 opacity-70" />
                    <span className="flex-1 truncate">{t("nav.saved")}</span>
                    {store.bookmarks.size > 0 && <span className="text-[11px] opacity-70">{store.bookmarks.size}</span>}
                  </button>
                </li>
                ) : null;
              default:
                return null; // a key this client does not draw (yet)
            }
          })}
        </ul>
      )}

      {sections.favorites.length > 0 && (
        <Section title={t("sidebar.favorites")} collapsed={folded.has("favorites")} onToggle={() => toggleFolded("favorites")} onDropChannel={(id) => { if (!store.isFavorite(id)) void controller.toggleFavorite(id); }}
          action={sortMenu("favorites", t("sidebar.favorites"), sections.favorites)}>
          <ul className="space-y-px">{shown(sections.favorites, folded.has("favorites"), undefined, reorder({ default: "favorites" }, sections.favorites, defaultSortOf("favorites")))}</ul>
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
          sectionId={section.id}
          onDropSection={(dragged, after) => dropSection(dragged, index, after)}
          action={<SectionHeaderMenu controller={controller} section={section} index={index} count={sections.custom.length} shownIds={ids(members)} />}
        >
          <ul className="space-y-px">{shown(members, section.collapsed, undefined, reorder({ section: section.id }, members, section.sort))}</ul>
          {members.length === 0 && !unreadOnly && !section.collapsed && <Hint>{t("sidebar.sectionEmptyHint")}</Hint>}
        </Section>
      ))}
      <Section
        title={t("sidebar.channels")}
collapsed={folded.has("channels")}
        onToggle={() => toggleFolded("channels")}
        onDropChannel={backToDefault}
        action={
          <span className="flex items-center">
            {onReadAll && (
              <IconButton tone="sidebar" label={t("sidebar.markAllRead")} className="h-6 w-6" onClick={onReadAll}>
                <CheckCheck size={14} />
              </IconButton>
            )}
            {onBrowse && !controller.isGuest && (
              <IconButton tone="sidebar" label={t("sidebar.browseKey", { key: `${modKey()}+Shift+E` })} className="h-6 w-6" onClick={onBrowse}>
                <Compass size={14} />
              </IconButton>
            )}
            <IconButton tone="sidebar" label={t("sidebar.newSection")} className="h-6 w-6" onClick={() => setNewSection(true)}>
              <FolderPlus size={14} />
            </IconButton>
            {!controller.isGuest && (
              <IconButton tone="sidebar" label={t("sidebar.createChannel")} className="h-6 w-6" onClick={onNewChannel}>
                <Plus size={14} />
              </IconButton>
            )}
            {sortMenu("channels", t("sidebar.channels"), sections.channels)}
          </span>
        }
      >
        <ul className="space-y-px">{shown(sections.channels, folded.has("channels"), undefined, reorder({ default: "channels" }, sections.channels, defaultSortOf("channels")))}</ul>
        {sections.channels.length === 0 && <Hint>{unreadOnly ? t("sidebar.noUnreadChannels") : t("sidebar.noChannels")}</Hint>}
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
                <IconButton tone="sidebar" label={t("sidebar.timesFeed")} className="h-6 w-6" onClick={onTimesFeed}>
                  <Newspaper size={14} />
                </IconButton>
              )}
              {onCreateTimes && !hasMyTimes && !controller.isGuest && (
                <IconButton tone="sidebar" label={t("sidebar.createTimes")} className="h-6 w-6" onClick={onCreateTimes}>
                  <Plus size={14} />
                </IconButton>
              )}
            </span>
          }
        >
          <ul className="space-y-px">
            {onTimesFeed && (
              // L8: the posts of every times I am in, newest first (TIMES_FEED.md §7); folded away with the section unless I have a times.
              <li className={cn("fold-row", feedFolded && "folded")} aria-hidden={feedFolded || undefined} inert={feedFolded}>
                <div className="fold-inner">
                  <button
                    type="button"
                    onClick={onTimesFeed}
                    aria-current={timesFeedActive ? "page" : undefined}
                    title={t("sidebar.feedTitle")}
                    className={cn(
                      "flex w-full items-center gap-2 rounded-lg py-[6px] text-left text-[13.5px] leading-5 transition-colors", SECTION_ROW_PAD,
                      timesFeedActive ? "bg-sidebar-active text-sidebar-active-fg" : "hover:bg-sidebar-hover hover:text-sidebar-strong",
                    )}
                  >
                    <Newspaper size={15} className="shrink-0 opacity-70" />
                    <span className="flex-1 truncate">{t("sidebar.feed")}</span>
                  </button>
                </div>
              </li>
            )}
            {shown(sections.times, timesFolded, isMyTimes)}
          </ul>
          {sections.times.length === 0 && <Hint>{t("sidebar.timesEmptyHint")}</Hint>}
        </Section>
      )}
      <Section
        title={t("sidebar.dms")}
collapsed={folded.has("dms")}
        onToggle={() => toggleFolded("dms")}
        onDropChannel={backToDefault}
        action={
          <span className="flex items-center">
            {onDirectory && (
              <IconButton tone="sidebar" label={t("sidebar.directory")} className="h-6 w-6" onClick={onDirectory}>
                <Users size={14} />
              </IconButton>
            )}
            <IconButton tone="sidebar" label={t("sidebar.newDmKey", { key: `${modKey()}+Shift+K` })} className="h-6 w-6" onClick={onNewDm}>
              <Plus size={14} />
            </IconButton>
            {sortMenu("dms", t("sidebar.dms"), sections.dms)}
          </span>
        }
      >
        <ul className="space-y-px">
          {shown(sections.dms.slice(0, pinnedDms), folded.has("dms"), undefined, dmOrder)}
          {selfPlaceholder && me && (
            <li>
              <button
                type="button"
                onClick={openSelfNotes}
                disabled={creatingSelf}
                aria-busy={creatingSelf}
                data-self-notes-placeholder=""
                title={myName}
                className={cn("flex w-full items-center gap-2 rounded-lg py-[6px] text-left text-[13.5px] leading-5 transition-colors hover:bg-sidebar-hover hover:text-sidebar-strong disabled:opacity-60", SECTION_ROW_PAD)}
              >
                <Avatar id={me.id} name={myName} size={18} className="rounded-md text-[9px]" />
                <span className="flex-1 truncate">{myName}</span>
              </button>
            </li>
          )}
          {shown(sections.dms.slice(pinnedDms), folded.has("dms"), undefined, dmOrder)}
        </ul>
        {sections.dms.length === 0 && !selfPlaceholder && <Hint>{unreadOnly ? t("sidebar.noUnreadDms") : t("sidebar.dmsEmptyHint")}</Hint>}
      </Section>
      {sections.browse.length > 0 && (
        <Section title={t("sidebar.joinable")}>
          <ul className="space-y-px">
            {sections.browse.map((c) => (
              <li key={c.id}>
                {/* M27: a click shows the channel read-only first; its bar joins (Slack). */}
                <button
                  type="button"
                  onClick={() => onOpen(c.id)}
                  aria-current={c.id === currentId ? "page" : undefined}
                  className={cn(
                    "flex w-full items-center gap-2 rounded-lg py-[6px] text-left text-[13.5px]", SECTION_ROW_PAD,
                    c.id === currentId ? "bg-sidebar-active text-sidebar-active-fg" : "opacity-80 hover:bg-sidebar-hover hover:text-sidebar-strong hover:opacity-100",
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

/**
 * The rows under a section header sit one step (10 px) in from its chevron (2026-10-05: the grouping was hard to see),
 * every row's icon on the same line. Padding inside the row, so the selected and hover fill stays full width.
 */
export const SECTION_ROW_PAD = "pl-5 pr-2.5";

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

/** A section in 「手動」: its conversations in order, and what a drop within it does with the new order. */
interface Reorder {
  ids: string[];
  apply: (ids: string[]) => void;
}

/** The conversation row being dragged (a dragover cannot read the drag's data, only its types). */
let draggedChannel: string | null = null;

/** Where `dragged` lands when dropped before or after `target` in `ids` (unchanged: null). */
export function reorderedIds(ids: readonly string[], dragged: string, target: string, after: boolean): string[] | null {
  if (dragged === target || !ids.includes(dragged) || !ids.includes(target)) return null;
  const rest = ids.filter((id) => id !== dragged);
  rest.splice(rest.indexOf(target) + (after ? 1 : 0), 0, dragged);
  return rest.every((id, index) => id === ids[index]) ? null : rest;
}

/**
 * A sidebar row. In a 「手動」 section another row of the same section dragged over it shows a line above or below
 * (by the pointer's half) and lands there; a row from elsewhere falls through to the section (moving it in).
 */
function ReorderRow({ id, order, folded, children }: { id: string; order?: Reorder; folded: boolean; children: ReactNode }) {
  const [edge, setEdge] = useState<"before" | "after" | null>(null);
  const mine = () => !!order && !!draggedChannel && draggedChannel !== id && order.ids.includes(draggedChannel);
  const half = (event: React.DragEvent): "before" | "after" => {
    const box = event.currentTarget.getBoundingClientRect();
    return box.height > 0 && event.clientY > box.top + box.height / 2 ? "after" : "before";
  };
  return (
    <li
      className={cn(
        "fold-row relative",
        folded && "folded",
        edge === "before" && "before:absolute before:inset-x-1 before:top-0 before:z-10 before:h-0.5 before:rounded-full before:bg-accent-solid",
        edge === "after" && "after:absolute after:inset-x-1 after:bottom-0 after:z-10 after:h-0.5 after:rounded-full after:bg-accent-solid",
      )}
      data-drop-edge={edge ?? undefined}
      aria-hidden={folded || undefined}
      inert={folded}
      onDragOver={order ? (event) => {
        if (!mine()) return;
        event.preventDefault();
        event.stopPropagation();
        event.dataTransfer.dropEffect = "move";
        const next = half(event);
        if (edge !== next) setEdge(next);
      } : undefined}
      onDragLeave={order ? () => setEdge(null) : undefined}
      onDrop={order ? (event) => {
        setEdge(null);
        if (!mine() || !draggedChannel) return;
        event.preventDefault();
        event.stopPropagation();
        const next = reorderedIds(order.ids, draggedChannel, id, half(event) === "after");
        draggedChannel = null;
        if (next) order.apply(next);
      } : undefined}
    >
      {children}
    </li>
  );
}

/** The data type a dragged conversation row carries (M26); files dragged in from outside have none of it. */
const CHANNEL_DRAG = "application/x-chikuwa-channel";
/** The data type a dragged section header carries (my own sections only); never taken as a conversation. */
export const SECTION_DRAG = "application/x-chikuwa-section";

/** The pinned header's picture, name and connection state (inside the button that opens my profile card). */
function SidebarIdentity({ controller, meId, name, status }: { controller: AppController; meId: string | null; name: string; status: string }) {
  return (
    <>
      {meId && <Avatar id={meId} name={name} size={34} className="rounded-xl" />}
      <span className="block min-w-0 flex-1">
        <span className="flex min-w-0 items-center gap-1">
          <span className="truncate text-sm font-semibold text-sidebar-strong">{name}</span>
          {meId && <StatusEmoji controller={controller} userId={meId} className="shrink-0" />}
        </span>
        <span className="flex min-w-0 items-center gap-1.5 text-[11px] opacity-80" title={statusTitle(status)}>
          <span className={cn("h-2 w-2 shrink-0 rounded-full", status === "online" ? "bg-success" : status === "connecting" ? "animate-pulse bg-warning" : status === "offline" ? "bg-warning" : "bg-sidebar-strong/30")} />
          <span className="truncate whitespace-nowrap">{statusLabel(status)}</span>
        </span>
      </span>
    </>
  );
}

/**
 * A sidebar section. M26 (Slack): the header folds it (`onToggle`), with an icon before the title; a conversation row
 * dropped on it goes to `onDropChannel`.
 */
function Section({ title, icon, action, children, collapsed = false, onToggle, onDropChannel, sectionId, onDropSection }: {
  title: string;
  icon?: ReactNode;
  action?: ReactNode;
  children: ReactNode;
  collapsed?: boolean;
  onToggle?: () => void;
  onDropChannel?: (channelId: string) => void;
  /** One of my own sections: its header drags (SECTION_DRAG), and a header dropped on it lands before or after it. */
  sectionId?: string;
  onDropSection?: (draggedId: string, after: boolean) => void;
}) {
  const [over, setOver] = useState(false);
  // Where a dragged section header would land: the line above or below this section.
  const [edge, setEdge] = useState<"before" | "after" | null>(null);
  const accepts = (event: React.DragEvent) => !!onDropChannel && event.dataTransfer.types.includes(CHANNEL_DRAG);
  const acceptsSection = (event: React.DragEvent) => !!onDropSection && event.dataTransfer.types.includes(SECTION_DRAG);
  const half = (event: React.DragEvent): "before" | "after" => {
    const box = event.currentTarget.getBoundingClientRect();
    return box.height > 0 && event.clientY > box.top + box.height / 2 ? "after" : "before";
  };
  return (
    <section
      data-section={sectionId}
      data-drop-edge={edge ?? undefined}
      className={cn(
        "relative mt-3 rounded-lg transition-colors",
        over && "bg-sidebar-strong/10 ring-1 ring-sidebar-strong/25",
        edge === "before" && "before:absolute before:inset-x-1 before:-top-1.5 before:h-0.5 before:rounded-full before:bg-accent-solid",
        edge === "after" && "after:absolute after:inset-x-1 after:-bottom-1.5 after:h-0.5 after:rounded-full after:bg-accent-solid",
      )}
      onDragOver={(event) => {
        if (acceptsSection(event)) {
          event.preventDefault();
          event.dataTransfer.dropEffect = "move";
          const next = half(event);
          if (edge !== next) setEdge(next);
          return;
        }
        if (!accepts(event)) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "move";
        if (!over) setOver(true);
      }}
      onDragLeave={(event) => {
        if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
        setOver(false);
        setEdge(null);
      }}
      onDrop={(event) => {
        setOver(false);
        setEdge(null);
        if (acceptsSection(event)) {
          const dragged = event.dataTransfer.getData(SECTION_DRAG);
          event.preventDefault();
          if (dragged && dragged !== sectionId) onDropSection?.(dragged, half(event) === "after");
          return;
        }
        const id = accepts(event) ? event.dataTransfer.getData(CHANNEL_DRAG) : "";
        if (!id) return;
        event.preventDefault();
        onDropChannel?.(id);
      }}
    >
      <h2
        draggable={sectionId ? true : undefined}
        title={sectionId ? t("sidebar.dragToReorder") : undefined}
        onDragStart={sectionId ? (event) => {
          event.dataTransfer.setData(SECTION_DRAG, sectionId);
          event.dataTransfer.effectAllowed = "move";
        } : undefined}
        className="mb-1 flex h-7 items-center justify-between gap-1 px-2.5 text-[13px] font-semibold uppercase tracking-wider text-sidebar-muted">
        {onToggle ? (
          <button type="button" aria-expanded={!collapsed} onClick={onToggle} className="-ml-1 flex min-w-0 flex-1 items-center gap-1 rounded-md px-1 text-left uppercase hover:text-sidebar-fg">
            <ChevronDown size={14} className={cn("shrink-0 transition-transform duration-200", collapsed && "-rotate-90")} />
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
  return <p className={cn("py-1 text-xs opacity-60", SECTION_ROW_PAD)}>{children}</p>;
}

/** Short enough for the narrowest sidebar (the banner over the conversation says more). */
export function statusLabel(status: string): string {
  switch (status) {
    case "online":
      return t("connection.online");
    case "connecting":
      return t("connection.connecting");
    case "offline":
      return t("connection.reconnecting");
    default:
      return t("connection.offline");
  }
}

export function statusTitle(status: string): string {
  switch (status) {
    case "online":
      return t("connection.onlineTitle");
    case "connecting":
      return t("connection.connectingLong");
    case "offline":
      return t("connection.offlineTitle");
    default:
      return t("connection.offline");
  }
}
