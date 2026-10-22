import { AlarmClock, ArrowDown, ArrowUp, AtSign, Bell, BellOff, BookOpen, Bookmark, CalendarDays, CheckCheck, ChevronDown, DoorOpen, Ellipsis, Eye, FileText, Files, FolderPlus, HardDrive, Hash, ListTodo, Lock, MessagesSquare, Newspaper, NotebookPen, NotebookText, Plus, Search, Settings, ShieldCheck, Ticket, Timer, Users, WifiOff, Zap } from "lucide-react";
import { type ReactNode, useState } from "react";

import type { DefaultSectionKey } from "../api/types";
import type { AppController, SortTarget } from "../state/app";
import type { ChannelState } from "../sync/types";
import { Avatar, HEADER_AVATAR_SIZE, HEADER_DOT_SIZE, presenceDotOf, presenceLabel } from "./Avatar";
import { badgeCount, defaultSort, hasUnread, isDmChannel, isMutedChannel, isQuietChannel, sectionChannels, showsSelfNotesInDmSection } from "./channels";
import { useOpenSelfNotes } from "./DmListView";
import { channelTitle, myDisplayName } from "./MainScreen";
import { activityBadge } from "./mobileTabs";
import { pressable } from "./actions";
import { navItemsAfterPlaceDrop, placeMovable, railShown, shownSpot, TIMES_PLACE_KEYS, TIMES_SECTION, timesAnchor, timesAnchorAt, timesAnchorMoved, withRail, withSpot, withTimesBefore, withTimesPlaced } from "./desktopPlaces";
import { desktopNavKeys, fullNavItems, shownNavItems } from "./navItems";
import { type Place, PlaceMenuItems, type PlaceMove, PlacesRail, usePlaceDrag } from "./PlacesRail";
import { Badge, cn, IconButton, Kbd, Menu, MenuContent, MenuItem, MenuLabel, MenuSeparator, MenuTrigger, modKey } from "./primitives";
import { SectionIcon } from "./SectionDialog";
import { AddChannelMenu, ChannelContextMenu, type ChannelRowAction, DefaultSectionMenu, NewSectionDialog, PinMark, SectionHeaderMenu, SectionMenu, SectionMenuItem, SectionMenuSeparator, SidebarContextMenu } from "./SidebarMenus";
import { hasUnreadFeed } from "../sync/timesFeed";
import { clickOrNewTab, middleClickProps, NewTabContextMenu } from "./DesktopTabBar";
import { StatusEmoji } from "./UserPopover";
import { MyStatusMenu } from "./MyStatusMenu";
import { currentMe, myPresenceChoice, myPresenceLine } from "./presence";
import { t } from "../i18n";

interface Props {
  controller: AppController;
  channels: ChannelState[];
  currentId: string | null;
  unreadOnly: boolean;
  onToggleUnreadOnly: () => void;
  /** Opens a conversation; a public channel I have not joined (from a link or 「チャンネルを探す」) opens as its preview (SYNC_PROTOCOL.md §7.6.1). */
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
  /** M161: 「ドライブ」 (docs/DRIVE.md §17.1). */
  onDrive?: () => void;
  driveActive?: boolean;
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
  /** M143: 「操作」 (only while the buttons are on and I may press one). */
  onActions?: () => void;
  actionsActive?: boolean;
  /** M12a: every channel read to its end. */
  onReadAll?: () => void;
  /** M12e: reminders; listed while any is open. */
  onReminders?: () => void;
  remindersActive?: boolean;
  /** The rail's 「並べ替え…」: 設定 → 表示 (「サイドバーの項目」). */
  onArrangePlaces?: () => void;
  /** A row's context menu: its details, rename, leave, archive (the main screen opens the conversation and the dialog). */
  onChannelAction?: (channelId: string, action: ChannelRowAction) => void;
  /** MOBILE_UI.md §19: a conversation in a new tab (its menu, a middle click, ⌘-click; true: in front). None: no tabs here. */
  onOpenInNewTab?: (channelId: string, foreground: boolean) => void;
  /** MOBILE_UI.md §19: a place (its key) in a new tab, from the rail or its sidebar row. */
  onPlaceInNewTab?: (key: string, foreground: boolean) => void;
}

export function Sidebar({ controller, channels, currentId, unreadOnly, onToggleUnreadOnly, onOpen, onNewDm,
  onDirectory, onNewChannel, onCreateTimes, onTimesFeed, timesFeedActive = false, onSearch, onSettings, onThreads, threadsActive = false, onSaved, savedActive = false, onAdmin, onBrowse, onActivity, activityActive = false, onDrafts, draftsActive = false, onFiles, filesActive = false, onDrive, driveActive = false, onCanvases, canvasesActive = false, onDocs, docsActive = false, onCalendar, calendarActive = false, onTasks, tasksActive = false, onDeadlines, deadlinesActive = false, onReservations, reservationsActive = false, reservationsCount = 0, onAttendance, attendanceActive = false, attendanceCount = 0, onActions, actionsActive = false, onReadAll, onReminders, remindersActive = false, onArrangePlaces, onChannelAction, onOpenInNewTab, onPlaceInNewTab }: Props) {
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
  const myTimes = me ? channels.find((c) => c.times_owner_id === me.id) : undefined;
  const hasMyTimes = !!myTimes;
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
  // Times folded (2026-10-12, TIMES_FEED.md §7): 「フィード」 and my own times fold away too, like any row without
  // unread; the rail's 「Times フィード」 and 「自分の Times」 icons reach them (MOBILE_UI.md §18.5).
  const timesFolded = folded.has("times");
  const feedFolded = timesFolded;
  // Dropped on a default section: out of my own section or out of お気に入り (the conversation goes back where it
  // belongs by kind). One place per conversation (DATA_MODEL.md sidebar_sections).
  const backToDefault = (channelId: string) => {
    if (store.isFavorite(channelId)) void controller.toggleFavorite(channelId);
    else if (store.sidebarSections.some((section) => section.channel_ids.includes(channelId))) void controller.moveToSection(channelId, null);
  };
  const status = controller.engine?.status ?? "idle";
  // My own sections reorder by dragging a header onto another (before or after it, by the pointer's half); the ⋯ menu's
  // 上へ / 下へ is the keyboard's way. The default sections stay where they are, but for Times (below).
  const dropSection = (draggedId: string, targetIndex: number, after: boolean) => {
    const from = sections.custom.findIndex(({ section }) => section.id === draggedId);
    if (from < 0) return;
    let to = targetIndex + (after ? 1 : 0);
    if (from < to) to -= 1;
    if (to !== from) void controller.moveSection(draggedId, to);
  };
  // M111: the menu items in my order (UserMe.nav_items; the order is shared with the phones). M140: 「在室状況」 while the
  // workspace has the board on. 2026-10-12 (MOBILE_UI.md §18.2): each stands where I put it (UserMe.desktop_places: the
  // rail, a sidebar row, or only under 「その他」), not by nav_items' `visible` (the phones' tiles).
  const implementedNav = desktopNavKeys(!!store.attendance, pressable(store.actions).length > 0);
  const navItems = shownNavItems(fullNavItems(me?.nav_items), "desktop", implementedNav);
  const desktopPlaces = me?.desktop_places;
  const railOn = railShown(desktopPlaces);
  const spotOf = (key: string) => shownSpot(desktopPlaces, key);
  const placeAt = me?.desktop_places !== undefined ? (key: string, spot: Parameters<typeof withSpot>[2]) => void controller.setDesktopPlaces(withSpot(desktopPlaces, key, spot)) : undefined;
  const setRail = me?.desktop_places !== undefined ? (on: boolean) => void controller.setDesktopPlaces(withRail(desktopPlaces, on)) : undefined;
  // 2026-10-13: a rail icon or a sidebar row dragged onto another moves there in nav_items' one order (the settings'
  // list, shared with the phones); a server without nav_items keeps the default order (no dragging).
  const movePlace: PlaceMove | undefined = me && me.nav_items !== undefined ? (dragged, target, after) => {
    const next = navItemsAfterPlaceDrop(me.nav_items, implementedNav, dragged, target, after);
    if (next) void controller.setNavItems(next);
  } : undefined;
  // My own conversation is highlighted in the rail only while no page covers it.
  const pageOpen = threadsActive || activityActive || draftsActive || savedActive || filesActive || driveActive || canvasesActive || docsActive || calendarActive || tasksActive || deadlinesActive || reservationsActive || attendanceActive || actionsActive || remindersActive || timesFeedActive;
  const icon = (Icon: typeof Bell) => <Icon size={20} strokeWidth={1.9} />;
  const count = (n: number) => (n > 99 ? "99+" : String(n));
  const place = (key: string): Place | null => {
    switch (key) {
      case "threads":
        return onThreads ? {
          key, label: t("nav.threads"), icon: icon(MessagesSquare), onSelect: onThreads, active: threadsActive,
          hint: t("sidebar.threadsKey", { key: `${modKey()}+Shift+T` }),
          emphasis: store.threadSummary.unread_count > 0,
          badge: store.threadSummary.unread_count > 0 ? { text: count(store.threadSummary.unread_count), tone: store.threadSummary.mention_count > 0 ? "danger" : "neutral" } : null,
        } : null;
      case "activity":
        // M39: the same badge as the phone's activity tab (none before M39: the entry is the mentions list then).
        return onActivity ? {
          key, label: store.activity ? t("nav.activity") : t("nav.mentions"), icon: icon(store.activity ? Bell : AtSign), onSelect: onActivity, active: activityActive,
          hint: store.activity ? t("sidebar.activityTitle") : t("sidebar.mentionsTitle"),
          ariaLabel: store.activity ? (activity.count > 0 ? t("sidebar.activityUnread", { count: activity.count }) : t("nav.activity")) : t("nav.mentions"),
          emphasis: !!store.activity && activity.count > 0,
          badge: store.activity && activity.count > 0 ? { text: count(activity.count), tone: activity.mention ? "danger" : "neutral" } : null,
        } : null;
      case "drafts":
        // Where I put it, empty or not (2026-10-12); a quiet badge with the number while there are some.
        return onDrafts ? { key, label: t("nav.drafts"), icon: icon(FileText), onSelect: onDrafts, active: draftsActive, hint: t("sidebar.draftsTitle"), badge: draftCount > 0 ? { text: count(draftCount), tone: "neutral" } : null } : null;
      case "reminders":
        // Fired ones red, open ones a quiet number; there even while empty (2026-10-12).
        return onReminders ? {
          key, label: t("nav.reminders"), icon: icon(AlarmClock), onSelect: onReminders, active: remindersActive,
          emphasis: firedCount > 0, badge: firedCount > 0 ? { text: count(firedCount), tone: "danger" } : reminderCount > 0 ? { text: count(reminderCount), tone: "neutral" } : null,
        } : null;
      case "files":
        return onFiles ? { key, label: t("nav.files"), icon: icon(Files), onSelect: onFiles, active: filesActive, hint: t("sidebar.filesTitle") } : null;
      case "drive":
        return onDrive ? { key, label: t("nav.drive"), icon: icon(HardDrive), onSelect: onDrive, active: driveActive, hint: t("sidebar.driveTitle") } : null;
      case "canvases":
        return onCanvases ? { key, label: t("nav.canvases"), icon: icon(NotebookText), onSelect: onCanvases, active: canvasesActive, hint: t("sidebar.canvasesTitle") } : null;
      case "docs":
        return onDocs ? { key, label: t("nav.docs"), icon: icon(BookOpen), onSelect: onDocs, active: docsActive, hint: t("sidebar.docsTitle") } : null;
      case "calendar":
        return onCalendar ? { key, label: t("nav.calendar"), icon: icon(CalendarDays), onSelect: onCalendar, active: calendarActive, hint: t("sidebar.calendarTitle") } : null;
      case "tasks":
        return onTasks ? { key, label: t("nav.tasks"), icon: icon(ListTodo), onSelect: onTasks, active: tasksActive, hint: t("sidebar.tasksTitle") } : null;
      case "deadlines":
        return onDeadlines ? { key, label: t("nav.deadlines"), icon: icon(Timer), onSelect: onDeadlines, active: deadlinesActive, hint: t("sidebar.deadlinesTitle") } : null;
      case "reservations":
        // M112: once the server answered the pools; the number is the to-dos due in the pools I operate.
        return onReservations ? {
          key, label: t("nav.reservations"), icon: icon(Ticket), onSelect: onReservations, active: reservationsActive, hint: t("sidebar.reservationsTitle"),
          badge: reservationsCount > 0 ? { text: count(reservationsCount), tone: "danger" } : null,
        } : null;
      case "attendance":
        // M140: while the workspace has the board on; a quiet count of who is in the room.
        return onAttendance ? { key, label: t("nav.attendance"), icon: icon(DoorOpen), onSelect: onAttendance, active: attendanceActive, hint: t("sidebar.attendanceTitle"), count: attendanceCount } : null;
      case "actions":
        // M143 (docs/ACTIONS.md §9.1): while the buttons are on and I may press at least one.
        return onActions ? { key, label: t("nav.actions"), icon: icon(Zap), onSelect: onActions, active: actionsActive, hint: t("sidebar.actionsTitle") } : null;
      case "saved":
        return onSaved ? { key, label: t("nav.saved"), icon: icon(Bookmark), onSelect: onSaved, active: savedActive, hint: t("sidebar.savedTitle"), count: store.bookmarks.size } : null;
      case "times-feed":
        // MOBILE_UI.md §18.5: the Times feed, while there is a Times section.
        return onTimesFeed && channels.some((c) => !!c.times_owner_id) ? {
          key, label: t("sidebar.timesFeed"), icon: icon(Newspaper), onSelect: onTimesFeed, active: timesFeedActive, hint: t("sidebar.feedTitle"), emphasis: hasUnreadFeed(channels),
        } : null;
      case "my-times": {
        // My own times next to the feed, with its unread (as its row would show).
        if (!myTimes) return null;
        const unread = hasUnread(myTimes, me?.id ?? null) && myTimes.id !== currentId;
        const mentions = badgeCount(myTimes);
        return {
          key, label: t("places.myTimes"), icon: icon(NotebookPen), onSelect: () => onOpen(myTimes.id), active: myTimes.id === currentId && !pageOpen,
          hint: t("places.myTimesTitle"), emphasis: unread,
          badge: unread ? { text: count(mentions > 0 ? mentions : myTimes.unreadCount), tone: mentions > 0 ? "danger" : "neutral" } : null,
        };
      }
      default:
        return null; // a key this client does not draw (yet)
    }
  };
  const places = [...navItems.map((item) => item.key), ...TIMES_PLACE_KEYS].map(place).filter((entry): entry is Place => entry !== null);
  const sidebarPlaces = places.filter((entry) => spotOf(entry.key) === "sidebar");
  // With the rail hidden, 「その他」 is a sidebar row (the hidden places, showing the rail again, the settings).
  const hiddenPlaces = places.filter((entry) => spotOf(entry.key) === "hidden");

  const item = (channel: ChannelState, folded = false, order?: Reorder) => {
    const muted = isMutedChannel(channel);
    const unread = hasUnread(channel, me?.id ?? null) && channel.id !== currentId;
    // M24: someone else's times with new posts but no mention: not bold, a faint dot (SYNC_PROTOCOL.md §10.5).
    const quietUnread = !unread && channel.id !== currentId && channel.unreadCount > 0 && isQuietChannel(channel, me?.id ?? null);
    const badge = badgeCount(channel);
    const active = channel.id === currentId;
    // A DM's avatar is the other person's; my own notes (a DM with only me) show mine.
    const other = isDmChannel(channel) ? ((channel.dm_user_ids ?? []).find((id) => id !== me?.id) ?? me?.id) : undefined;
    // MOBILE_UI.md §19: in a new tab (its menu, a middle click, ⌘-click).
    const newTab = onOpenInNewTab && ((foreground: boolean) => onOpenInNewTab(channel.id, foreground));
    return (
      <ReorderRow key={channel.id} id={channel.id} order={order} folded={folded}>
        <div className="fold-inner">
        <ChannelContextMenu controller={controller} channel={channel} onAction={onChannelAction} onOpenInNewTab={newTab && (() => newTab(true))}>
        <button
          type="button"
          {...middleClickProps(newTab)}
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
          onClick={(event) => { if (!clickOrNewTab(event, newTab)) onOpen(channel.id); }}
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
              presence={presenceDotOf(store, other)}
              presenceClassName="border-sidebar"
            /> : <AtSign size={15} className="shrink-0 opacity-70" />
          ) : channel.type === "private" ? (
            <Lock size={15} className="shrink-0 opacity-70" />
          ) : (
            <Hash size={15} className="shrink-0 opacity-70" />
          )}
          <span className="flex-1 truncate">{channelTitle(channel, controller).replace(/^#/, "")}</span>
          {other && <StatusEmoji controller={controller} userId={other} className="shrink-0" bellClassName="opacity-70" />}
          {store.isDmPinned(channel.id) && <PinMark className="opacity-70" />}
          {muted && <BellOff size={12} className="shrink-0 opacity-70" />}
          {unread && badge > 0 ? <Badge tone="danger">{badge}</Badge> : unread ? <span className="h-2 w-2 shrink-0 rounded-full bg-sidebar-strong" /> : quietUnread ? <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-sidebar-strong/40" title={t("sidebar.quietUnread")} /> : null}
        </button>
        </ChannelContextMenu>
        </div>
      </ReorderRow>
    );
  };

  // 2026-10-12 (TIMES_FEED.md §7): the sections in order. My own sections keep their server order (after お気に入り, before
  // 「チャンネル」); the Times section stands where I moved it (UserMe.desktop_places.times_before, by default right above
  // 「チャンネル」), by dragging its header or its ⋯ menu's 上へ / 下へ.
  const timesShown = sections.times.length > 0 || (!!onCreateTimes && !hasMyTimes && !controller.isGuest && !unreadOnly);
  const sectionKeys = ["favorites", ...sections.custom.map(({ section }) => section.id), "channels", "dms"];
  const currentTimesAnchor = timesAnchor(desktopPlaces, sectionKeys);
  const shownSections = withTimesPlaced(sectionKeys, currentTimesAnchor).filter((key) =>
    key === "favorites" ? sections.favorites.length > 0 : key === TIMES_SECTION ? timesShown : true);
  // A server without desktop_places cannot keep it: Times stays at its default place, and the moves are not offered.
  const timesMovable = me?.desktop_places !== undefined;
  const placeTimes = (anchor: string | null) => {
    if (!timesMovable || anchor === null || anchor === currentTimesAnchor) return;
    void controller.setDesktopPlaces(withTimesBefore(desktopPlaces, anchor));
  };
  // The Times header dropped on another section lands before or after it (by the pointer's half).
  const dropTimes = timesMovable ? (target: string) => (dragged: string, after: boolean) => {
    if (dragged === TIMES_SECTION && target !== TIMES_SECTION) placeTimes(timesAnchorAt(shownSections, target, after));
  } : undefined;
  const takesTimes = (dragged: string) => timesMovable && dragged === TIMES_SECTION;
  const addChannelButton = (
    <IconButton tone="sidebar" label={t("sidebar.addChannel")} className="h-6 w-6" data-add-channel-trigger="">
      <Plus size={14} />
    </IconButton>
  );
  const blocks: Record<string, ReactNode> = {
    favorites: (
      <Section key="favorites" title={t("sidebar.favorites")} collapsed={folded.has("favorites")} onToggle={() => toggleFolded("favorites")} onDropChannel={(id) => { if (!store.isFavorite(id)) void controller.toggleFavorite(id); }}
        acceptsSection={takesTimes} onDropSection={dropTimes?.("favorites")}
        menu={sortMenu("favorites", t("sidebar.favorites"), sections.favorites)}>
        <ul className="space-y-px">{shown(sections.favorites, folded.has("favorites"), undefined, reorder({ default: "favorites" }, sections.favorites, defaultSortOf("favorites")))}</ul>
      </Section>
    ),
    channels: (
      <Section
        key="channels"
        title={t("sidebar.channels")}
        collapsed={folded.has("channels")}
        onToggle={() => toggleFolded("channels")}
        onDropChannel={backToDefault}
        acceptsSection={takesTimes}
        onDropSection={dropTimes?.("channels")}
        // 2026-10-12: one ＋ (「チャンネルを追加」: 探す / 作成) and the rest under ⋯.
        add={<AddChannelMenu guest={controller.isGuest} onBrowse={onBrowse} onCreate={onNewChannel} trigger={addChannelButton} />}
        menu={
          <DefaultSectionMenu controller={controller} target={{ default: "channels" }} title={t("sidebar.channels")} sort={defaultSortOf("channels")} shownIds={ids(sections.channels)}>
            {onReadAll && <SectionMenuItem action="read-all" icon={<CheckCheck size={14} />} onSelect={onReadAll}>{t("sidebar.markAllRead")}</SectionMenuItem>}
            <SectionMenuItem action="new-section" icon={<FolderPlus size={14} />} onSelect={() => setNewSection(true)}>{t("home.newSection")}</SectionMenuItem>
          </DefaultSectionMenu>
        }
      >
        <ul className="space-y-px">{shown(sections.channels, folded.has("channels"), undefined, reorder({ default: "channels" }, sections.channels, defaultSortOf("channels")))}</ul>
        {sections.channels.length === 0 && <Hint>{unreadOnly ? t("sidebar.noUnreadChannels") : t("sidebar.noChannels")}</Hint>}
        {/* 2026-10-08: the channels I could join are not listed in the sidebar; 2026-10-12 this last row is
            「チャンネルを追加」, the same small choice as the header's ＋ (探す / 作成), as the phones' row. */}
        {!unreadOnly && !folded.has("channels") && (
          <AddChannelMenu
            guest={controller.isGuest}
            onBrowse={onBrowse}
            onCreate={onNewChannel}
            trigger={
              <button
                type="button"
                data-add-channel-row=""
                className={cn("flex w-full items-center gap-2 rounded-lg py-[6px] text-left text-[13.5px] leading-5 opacity-80 transition-colors hover:bg-sidebar-hover hover:text-sidebar-strong hover:opacity-100 data-[state=open]:bg-sidebar-hover", SECTION_ROW_PAD)}
              >
                <Plus size={15} className="shrink-0 opacity-70" />
                <span className="flex-1 truncate">{t("sidebar.addChannel")}</span>
              </button>
            }
          />
        )}
      </Section>
    ),
    [TIMES_SECTION]: (
      <Section
        key={TIMES_SECTION}
        title="Times"
        collapsed={folded.has("times")}
        onToggle={() => toggleFolded("times")}
        onDropChannel={backToDefault}
        // Its header drags among the sections (a server without desktop_places: it stays where it is).
        sectionId={timesMovable ? TIMES_SECTION : undefined}
        add={onCreateTimes && !hasMyTimes && !controller.isGuest ? (
          <IconButton tone="sidebar" label={t("sidebar.createTimes")} className="h-6 w-6" onClick={onCreateTimes}>
            <Plus size={14} />
          </IconButton>
        ) : undefined}
        menu={(onTimesFeed || timesMovable) ? (
          <SectionMenu title="Times">
            {onTimesFeed && <SectionMenuItem action="times-feed" icon={<Newspaper size={14} />} onSelect={onTimesFeed}>{t("sidebar.timesFeed")}</SectionMenuItem>}
            {onTimesFeed && timesMovable && <SectionMenuSeparator />}
            {timesMovable && (
              <>
                <SectionMenuItem action="move-up" icon={<ArrowUp size={14} />} disabled={timesAnchorMoved(shownSections, -1) === null} onSelect={() => placeTimes(timesAnchorMoved(shownSections, -1))}>{t("common.moveUp")}</SectionMenuItem>
                <SectionMenuItem action="move-down" icon={<ArrowDown size={14} />} disabled={timesAnchorMoved(shownSections, 1) === null} onSelect={() => placeTimes(timesAnchorMoved(shownSections, 1))}>{t("common.moveDown")}</SectionMenuItem>
              </>
            )}
          </SectionMenu>
        ) : undefined}
      >
        <ul className="space-y-px">
          {onTimesFeed && (
            // L8: the posts of every times I am in, newest first (TIMES_FEED.md §7); folded away with the section.
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
          {shown(sections.times, timesFolded)}
        </ul>
        {sections.times.length === 0 && <Hint>{t("sidebar.timesEmptyHint")}</Hint>}
      </Section>
    ),
    dms: (
      <Section
        key="dms"
        title={t("sidebar.dms")}
        collapsed={folded.has("dms")}
        onToggle={() => toggleFolded("dms")}
        onDropChannel={backToDefault}
        acceptsSection={takesTimes}
        onDropSection={dropTimes?.("dms")}
        add={
          <IconButton tone="sidebar" label={t("sidebar.newDmKey", { key: `${modKey()}+Shift+K` })} className="h-6 w-6" onClick={onNewDm}>
            <Plus size={14} />
          </IconButton>
        }
        menu={
          <DefaultSectionMenu controller={controller} target={{ default: "dms" }} title={t("sidebar.dms")} sort={defaultSortOf("dms")} shownIds={ids(sections.dms)}>
            {onDirectory && <SectionMenuItem action="directory" icon={<Users size={14} />} onSelect={onDirectory}>{t("sidebar.directory")}</SectionMenuItem>}
          </DefaultSectionMenu>
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
    ),
  };
  sections.custom.forEach(({ section, channels: members }, index) => {
    blocks[section.id] = (
      <Section
        key={section.id}
        title={section.name}
        icon={<SectionIcon controller={controller} emoji={section.emoji} />}
        collapsed={section.collapsed}
        onToggle={() => void controller.setSectionCollapsed(section.id, !section.collapsed)}
        onDropChannel={(id) => { if (!section.channel_ids.includes(id)) void controller.moveToSection(id, section.id); }}
        sectionId={section.id}
        // My own sections among themselves (their server order); the Times header lands before or after one too.
        acceptsSection={(dragged) => takesTimes(dragged) || sections.custom.some((other) => other.section.id === dragged)}
        onDropSection={(dragged, after) => (dragged === TIMES_SECTION ? dropTimes?.(section.id)(dragged, after) : dropSection(dragged, index, after))}
        menu={<SectionHeaderMenu controller={controller} section={section} index={index} count={sections.custom.length} shownIds={ids(members)} />}
      >
        <ul className="space-y-px">{shown(members, section.collapsed, undefined, reorder({ section: section.id }, members, section.sort))}</ul>
        {members.length === 0 && !unreadOnly && !section.collapsed && <Hint>{t("sidebar.sectionEmptyHint")}</Hint>}
      </Section>
    );
  });

  return (
    <div data-sidebar-column="" className="flex h-full min-h-0 border-r border-sidebar-edge bg-sidebar text-sidebar-fg">
      {/* 2026-10-12 (MOBILE_UI.md §18): the menu items are a rail of icons, so the list below starts with the channels. */}
      {onThreads && railOn && (
        <PlacesRail places={places} spotOf={spotOf} onPlace={placeAt} onHideRail={setRail && (() => setRail(false))} onArrange={onArrangePlaces} onNewTab={onPlaceInNewTab} onMove={movePlace} movable={placeMovable} />
      )}
    {/* MOBILE_UI.md §18.6: right-click on the sidebar's empty space (a row's own menu wins). */}
    <SidebarContextMenu
      guest={controller.isGuest}
      onNewSection={() => setNewSection(true)}
      onNewChannel={onNewChannel}
      onBrowse={onBrowse}
      onNewDm={onNewDm}
      onReadAll={onReadAll}
      onDisplay={onArrangePlaces}
    >
    <nav data-chat-focus aria-label={t("sidebar.label")} className="flex h-full min-h-0 min-w-0 flex-1 flex-col overflow-y-auto px-2 pb-4">
      {/* Pinned: my avatar, search, 管理 and 設定 stay in view while the list scrolls. */}
      <div data-testid="sidebar-header" className="sticky top-0 z-10 -mx-2 flex items-center gap-2.5 border-b border-sidebar-line bg-sidebar px-4 py-3">
        {/* PRESENCE.md §11.6: my picture and name are one button that opens the quick status menu. */}
        {me ? (
          <MyStatusMenu controller={controller} onSettings={onSettings} onOpenAttendance={onAttendance}>
            <button
              type="button"
              data-my-status-trigger
              aria-label={t("presence.openMenu", { state: myPresenceLine(currentMe(store)) })}
              className="-my-1 -ml-1.5 flex min-w-0 flex-1 items-center gap-2.5 rounded-xl py-0.5 pl-0.5 pr-1 text-left outline-none hover:bg-sidebar-strong/10 focus-visible:ring-2 focus-visible:ring-accent/60"
            >
              <Avatar id={me.id} name={me.display_name} size={HEADER_AVATAR_SIZE} dotSize={HEADER_DOT_SIZE} className="rounded-xl" presence={store.presenceOf(me.id)} presenceClassName="border-sidebar" />
              <SidebarIdentity controller={controller} meId={me.id} name={me.display_name} status={status} presence={myHeaderLine(controller)} withAvatar={false} />
            </button>
          </MyStatusMenu>
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

      {/* MOBILE_UI.md §18.2: the places I put in the sidebar (スレッド and 下書き by default), and all of the rail's while it
          is hidden, with 「その他」 for the hidden ones then. */}
      {onThreads && (sidebarPlaces.length > 0 || !railOn) && (
        <ul data-sidebar-places="" aria-label={t("places.sidebarRows")} className="mb-1 space-y-px">
          {sidebarPlaces.map((entry) => (
            <li key={entry.key}>
              <SidebarPlaceRow place={entry} onNewTab={onPlaceInNewTab} onMove={placeMovable(entry.key) ? movePlace : undefined} />
            </li>
          ))}
          {!railOn && (
            <li>
              <Menu>
                <MenuTrigger asChild>
                  <button type="button" data-sidebar-more="" className={cn(PLACE_ROW, "hover:bg-sidebar-hover hover:text-sidebar-strong")}>
                    <Ellipsis size={15} className="shrink-0 opacity-70" />
                    <span className="flex-1 truncate">{t("places.more")}</span>
                    {hiddenPlaces.some((entry) => entry.badge) && <span className={cn("h-2 w-2 shrink-0 rounded-full", hiddenPlaces.some((entry) => entry.badge?.tone === "danger") ? "bg-rose-500" : "bg-sidebar-strong")} />}
                  </button>
                </MenuTrigger>
                <MenuContent side="bottom" align="start" className="max-h-[70vh] overflow-y-auto">
                  <MenuLabel>{t("places.more")}</MenuLabel>
                  {hiddenPlaces.length === 0 && <p className="px-2.5 py-1.5 text-sm text-muted">{t("rail.moreEmpty")}</p>}
                  <PlaceMenuItems places={hiddenPlaces} />
                  <MenuSeparator />
                  {setRail && (
                    <MenuItem data-show-rail="" onSelect={() => setRail(true)}>
                      <Eye size={14} className="text-muted" />
                      {t("places.showRail")}
                    </MenuItem>
                  )}
                  {onArrangePlaces && <MenuItem onSelect={onArrangePlaces}>{t("sidebarMenu.display")}</MenuItem>}
                </MenuContent>
              </Menu>
            </li>
          )}
        </ul>
      )}

      {shownSections.map((key) => blocks[key])}
      {newSection && <NewSectionDialog controller={controller} onClose={() => setNewSection(false)} />}
    </nav>
    </SidebarContextMenu>
    </div>
  );
}

/**
 * The rows under a section header sit one step (10 px) in from its chevron (2026-10-05: the grouping was hard to see),
 * every row's icon on the same line. Padding inside the row, so the selected and hover fill stays full width.
 */
export const SECTION_ROW_PAD = "pl-5 pr-2.5";

/** A place's row near the sidebar's top (MOBILE_UI.md §18.2): the look the menu items had before the rail. */
const PLACE_ROW = "flex w-full items-center gap-2 rounded-lg px-2.5 py-[6px] text-left text-[13.5px] leading-5 transition-colors";

function SidebarPlaceRow({ place, onNewTab, onMove }: { place: Place; onNewTab?: (key: string, foreground: boolean) => void; onMove?: PlaceMove }) {
  // MOBILE_UI.md §19: in a new tab (its menu, a middle click, ⌘-click).
  const newTab = onNewTab && ((foreground: boolean) => onNewTab(place.key, foreground));
  // 2026-10-13: dragged onto another place row it lands before or after it.
  const drag = usePlaceDrag("sidebar", place.key, onMove);
  return (
    <NewTabContextMenu onOpenInNewTab={newTab && (() => newTab(true))}>
    <button
      type="button"
      data-nav-item={place.key}
      {...middleClickProps(newTab)}
      {...drag.props}
      onClick={(event) => { if (!clickOrNewTab(event, newTab)) place.onSelect(); }}
      aria-label={place.ariaLabel}
      aria-current={place.active ? "page" : undefined}
      title={place.hint}
      className={cn(
        PLACE_ROW,
        "relative",
        drag.dragging && "opacity-50",
        place.emphasis && "font-semibold text-sidebar-strong",
        place.active ? "bg-sidebar-active text-sidebar-active-fg" : "hover:bg-sidebar-hover hover:text-sidebar-strong",
      )}
    >
      <span aria-hidden className="flex shrink-0 opacity-70 [&_svg]:h-[15px] [&_svg]:w-[15px]">{place.icon}</span>
      <span className="flex-1 truncate">{place.label}</span>
      {place.badge ? (
        <Badge tone={place.badge.tone} className={place.badge.tone === "danger" ? undefined : "bg-current/20 text-inherit"}>{place.badge.text}</Badge>
      ) : place.count ? (
        <span className="text-[11px] opacity-70">{place.count}</span>
      ) : null}
      {drag.edge && <span aria-hidden className={cn("pointer-events-none absolute inset-x-1 z-10 h-0.5 rounded-full bg-accent-solid", drag.edge === "before" ? "top-0" : "bottom-0")} />}
    </button>
    </NewTabContextMenu>
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

/** A section in 「手動」: its conversations in order, and what a drop within it does with the new order. */
interface Reorder {
  ids: string[];
  apply: (ids: string[]) => void;
}

/** The conversation row being dragged (a dragover cannot read the drag's data, only its types). */
let draggedChannel: string | null = null;
/** The section header being dragged (my own section's id, or Times), for the same reason. */
let draggedSection: string | null = null;

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
/**
 * The line under my name in the sidebar header (PRESENCE.md §11.6): my effective look, the same one my picture's dot
 * shows — 「取り込み中（〜15:30）」, 「離席中」, 「オフライン表示」, or for 自動 the look the others see (オンライン /
 * 離席中 when idle). No dot of its own (the picture has it). While the connection is down that takes the line instead,
 * in the warning colour.
 */
function myHeaderLine(controller: AppController): string {
  const store = controller.store;
  const me = currentMe(store);
  if (!me) return "";
  if (myPresenceChoice(me) !== "auto") return myPresenceLine(me);
  return presenceLabel(store.presenceOf(me.id));
}

function SidebarIdentity({ controller, meId, name, status, presence, withAvatar = true }: { controller: AppController; meId: string | null; name: string; status: string; presence?: string; withAvatar?: boolean }) {
  // `idle` is before the first connection attempt; only a real connection problem replaces my presence line.
  const connected = status === "online" || status === "idle";
  return (
    <>
      {meId && withAvatar && <Avatar id={meId} name={name} size={HEADER_AVATAR_SIZE} className="rounded-xl" />}
      <span className="block min-w-0 flex-1">
        <span className="flex min-w-0 items-center gap-1">
          <span className="truncate text-sm font-semibold text-sidebar-strong">{name}</span>
          {meId && <StatusEmoji controller={controller} userId={meId} className="shrink-0" bellClassName="opacity-70" />}
        </span>
        {presence !== undefined && connected ? (
          <span data-my-presence-line className="block truncate whitespace-nowrap text-[11px] opacity-80">{presence}</span>
        ) : (
          <span data-connection-line className={cn("flex min-w-0 items-center gap-1 text-[11px]", connected ? "opacity-80" : "text-warning")} title={statusTitle(status)}>
            {!connected && <WifiOff aria-hidden size={11} className={cn("shrink-0", status === "connecting" && "animate-pulse")} />}
            <span className="truncate whitespace-nowrap">{statusLabel(status)}</span>
          </span>
        )}
      </span>
    </>
  );
}

/**
 * A sidebar section. M26 (Slack): the header folds it (`onToggle`), with an icon before the title; a conversation row
 * dropped on it goes to `onDropChannel`.
 */
function Section({ title, icon, add, menu, children, collapsed = false, onToggle, onDropChannel, sectionId, acceptsSection: takes, onDropSection }: {
  title: string;
  icon?: ReactNode;
  /** The header's one primary action (＋), before its ⋯ `menu` (2026-10-12: both show on hover / focus, always on touch). */
  add?: ReactNode;
  menu?: ReactNode;
  children: ReactNode;
  collapsed?: boolean;
  onToggle?: () => void;
  onDropChannel?: (channelId: string) => void;
  /** One of my own sections, or Times: its header drags (SECTION_DRAG). */
  sectionId?: string;
  /** Which dragged section header may land on this one (before or after it, `onDropSection`). */
  acceptsSection?: (draggedId: string) => boolean;
  onDropSection?: (draggedId: string, after: boolean) => void;
}) {
  const [over, setOver] = useState(false);
  // Where a dragged section header would land: the line above or below this section.
  const [edge, setEdge] = useState<"before" | "after" | null>(null);
  const accepts = (event: React.DragEvent) => !!onDropChannel && event.dataTransfer.types.includes(CHANNEL_DRAG);
  // A dragover cannot read the drag's data: the header being dragged is kept aside (draggedSection).
  const acceptsSection = (event: React.DragEvent) =>
    !!onDropSection && event.dataTransfer.types.includes(SECTION_DRAG) && !!draggedSection && draggedSection !== sectionId && (takes?.(draggedSection) ?? true);
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
        if (event.dataTransfer.types.includes(SECTION_DRAG)) {
          const dragged = event.dataTransfer.getData(SECTION_DRAG);
          const ok = acceptsSection(event);
          draggedSection = null;
          event.preventDefault();
          if (ok && dragged && dragged !== sectionId) onDropSection?.(dragged, half(event) === "after");
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
          draggedSection = sectionId;
        } : undefined}
        onDragEnd={sectionId ? () => {
          draggedSection = null;
        } : undefined}
        className="group/section mb-1 flex h-7 items-center justify-between gap-1 px-2.5 text-[13px] font-semibold uppercase tracking-wider text-sidebar-muted">
        {onToggle ? (
          <button type="button" aria-expanded={!collapsed} onClick={onToggle} className="-ml-1 flex min-w-0 flex-1 items-center gap-1 rounded-md px-1 text-left uppercase hover:text-sidebar-fg">
            <ChevronDown size={14} className={cn("shrink-0 transition-transform duration-200", collapsed && "-rotate-90")} />
            {icon}
            <span className="truncate">{title}</span>
          </button>
        ) : (
          <span className="flex min-w-0 items-center gap-1 truncate">{icon}{title}</span>
        )}
        {(add || menu) && (
          // Shown while the header is hovered or has the focus, or one of its menus is open; always on a touch screen.
          <span
            data-section-actions=""
            className="flex shrink-0 items-center opacity-0 transition-opacity group-hover/section:opacity-100 group-focus-within/section:opacity-100 has-[[data-state=open]]:opacity-100 pointer-coarse:opacity-100"
          >
            {add}
            {menu}
          </span>
        )}
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
