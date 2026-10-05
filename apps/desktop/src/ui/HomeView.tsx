import { AlarmClock, AtSign, BellOff, Bookmark, CalendarDays, Check, ChevronDown, ChevronRight, FileText, Files, Hash, ListTodo, Lock, MessagesSquare, MoreHorizontal, Newspaper, NotebookText, Plus, Search, SquarePen, Ticket, Timer } from "lucide-react";
import { type ReactNode, useState } from "react";

import type { AppController } from "../state/app";
import { WorkspaceIcon } from "./workspaceIcons";
import type { ChannelState } from "../sync/types";
import { Avatar } from "./Avatar";
import { badgeCount, hasUnread, isDmChannel, isMutedChannel, isQuietChannel, showsSelfNotesInDmSection } from "./channels";
import { useOpenSelfNotes } from "./DmListView";
import { homeSections } from "./home";
import { reservationTodoCount } from "./reservationPools";
import { channelTitle, myDisplayName } from "./MainScreen";
import { Badge, Button, cn, Menu, MenuCheckboxItem, MenuContent, MenuItem, MenuSeparator, MenuTrigger, Modal } from "./primitives";
import { SectionIcon } from "./SectionDialog";
import { statusLabel, statusTitle, useFoldedDefaults } from "./Sidebar";
import { ChannelContextMenu, NewSectionDialog, SectionHeaderMenu } from "./SidebarMenus";
import { StatusEmoji } from "./UserPopover";

export interface HomeViewProps {
  controller: AppController;
  /** 「未読をまとめる」 (this device's setting). */
  gatherUnread: boolean;
  onGatherUnread: (on: boolean) => void;
  onOpen: (id: string) => void;
  /** The 「移動・検索」 bar. */
  onJump: () => void;
  /** ✏️ 新しいメッセージ. */
  onCompose: () => void;
  onThreads: () => void;
  /** L8: the Times feed (a tile after 「スレッド」, TIMES_FEED.md §7). Optional (older callers). */
  onTimesFeed?: () => void;
  onDrafts: () => void;
  onSaved: () => void;
  onReminders: () => void;
  onFiles: () => void;
  /** M44: the canvases of all my conversations (a tile, MOBILE_UI.md §6.1 / §10 9.). Optional (older callers). */
  onCanvases?: () => void;
  /** M51: the calendar (a tile, CALENDAR.md §7). Optional (older callers). */
  onCalendar?: () => void;
  /** M55: 「自分のタスク」 (a tile, TASKS.md §6). Optional (older callers). */
  onTasks?: () => void;
  /** M85 「締切」. */
  onDeadlines?: () => void;
  /** M112: 「予約」 (once the server answered the pools). */
  onReservations?: () => void;
  onBrowse: () => void;
  onNewChannel: () => void;
  onDirectory: () => void;
  onCreateTimes: () => void;
  /** 「すべての DM」: the DM tab. */
  onAllDms: () => void;
}

/**
 * M37, the phone's home (MOBILE_UI.md §6.1, decision 5: a light list): the workspace's name and ⋯, the 「移動・検索」
 * bar, the tiles, the sections (with 「未読」 first while 「未読をまとめる」 is on) and ✏️ for a new message. The wide
 * layout keeps its sidebar (Sidebar.tsx).
 */
export function HomeView(props: HomeViewProps) {
  const { controller, gatherUnread, onOpen } = props;
  const store = controller.store;
  const me = store.me ?? controller.me;
  const meId = me?.id ?? null;
  const channels = [...store.channels.values()];
  const sections = homeSections(channels, (c) => channelTitle(c, controller), { gatherUnread, favorites: store.favorites, sections: store.sidebarSections, meId });
  const [folded, toggleFolded] = useFoldedDefaults();
  const [confirmReadAll, setConfirmReadAll] = useState(false);
  const [newSection, setNewSection] = useState(false);
  const myName = myDisplayName(controller);
  const selfPlaceholder = showsSelfNotesInDmSection(channels, meId, myName, { collapsed: folded.has("dms") });
  const { creating: creatingSelf, open: openSelfNotes } = useOpenSelfNotes(controller, meId, onOpen);
  const hasMyTimes = !!meId && channels.some((c) => c.times_owner_id === meId);

  // A folded section still shows its unread conversations (Slack); the others fold away (.fold-row).
  const rows = (list: ChannelState[], collapsed: boolean) => list.map((c) => <HomeRow key={c.id} controller={controller} channel={c} folded={collapsed && !hasUnread(c, meId)} onOpen={onOpen} />);

  return (
    <section aria-label="ホーム" className="relative flex min-h-0 flex-1 flex-col bg-canvas text-ink">
      <HomeHeader {...props} hasMyTimes={hasMyTimes} onReadAll={() => setConfirmReadAll(true)} onNewSection={() => setNewSection(true)} />
      <div className="shrink-0 px-3 pb-2 pt-1">
        <button
          type="button"
          onClick={props.onJump}
          data-jump-bar=""
          className="flex h-10 w-full items-center gap-2 rounded-xl bg-panel px-3 text-left text-[15px] text-muted transition-colors hover:bg-panel-2"
        >
          <Search size={17} className="shrink-0" />
          <span className="min-w-0 flex-1 truncate">移動・検索</span>
        </button>
      </div>
      <nav data-chat-focus aria-label="チャンネルとDM" className="min-h-0 flex-1 overflow-y-auto pb-24">
        <Tiles {...props} />
        {gatherUnread && (
          <HomeSection title="未読" sectionKey="unread">
            {sections.unread.length > 0 ? <ul>{rows(sections.unread, false)}</ul> : <Hint>未読の会話はありません</Hint>}
          </HomeSection>
        )}
        {sections.favorites.length > 0 && (
          <HomeSection title="お気に入り" sectionKey="favorites" collapsed={folded.has("favorites")} onToggle={() => toggleFolded("favorites")}>
            <ul>{rows(sections.favorites, folded.has("favorites"))}</ul>
          </HomeSection>
        )}
        {sections.custom.map(({ section, channels: members }, index) => (
          <HomeSection
            key={section.id}
            title={section.name}
            sectionKey={`custom:${section.id}`}
            icon={<SectionIcon controller={controller} emoji={section.emoji} />}
            collapsed={section.collapsed}
            onToggle={() => void controller.setSectionCollapsed(section.id, !section.collapsed)}
            action={<SectionHeaderMenu controller={controller} section={section} index={index} count={sections.custom.length} />}
          >
            <ul>{rows(members, section.collapsed)}</ul>
          </HomeSection>
        ))}
        <HomeSection title="チャンネル" sectionKey="channels" collapsed={folded.has("channels")} onToggle={() => toggleFolded("channels")}>
          <ul>
            {rows(sections.channels, folded.has("channels"))}
            {!controller.isGuest && (
              <FoldRow folded={folded.has("channels")}>
                <button type="button" onClick={props.onBrowse} className={ROW}>
                  <span className="flex w-6 shrink-0 justify-center text-muted"><Plus size={20} /></span>
                  <span className="min-w-0 flex-1 truncate text-muted">チャンネルを追加</span>
                </button>
              </FoldRow>
            )}
          </ul>
          {sections.channels.length === 0 && controller.isGuest && <Hint>まだチャンネルがありません</Hint>}
        </HomeSection>
        {sections.times.length > 0 && (
          <HomeSection title="Times" sectionKey="times" collapsed={folded.has("times")} onToggle={() => toggleFolded("times")}>
            <ul>{rows(sections.times, folded.has("times"))}</ul>
          </HomeSection>
        )}
        <HomeSection title="ダイレクトメッセージ" sectionKey="dms" collapsed={folded.has("dms")} onToggle={() => toggleFolded("dms")}>
          <ul>
            {selfPlaceholder && me && (
              <li>
                <button
                  type="button"
                  onClick={openSelfNotes}
                  disabled={creatingSelf}
                  aria-busy={creatingSelf}
                  data-self-notes-placeholder=""
                  title={myName}
                  className={cn(ROW, "disabled:opacity-60")}
                >
                  <Avatar id={me.id} name={myName} size={24} className="rounded-md text-[10px]" />
                  <span className="min-w-0 flex-1 truncate">{myName}</span>
                </button>
              </li>
            )}
            {rows(sections.dms, folded.has("dms"))}
            {sections.moreDms && (
              <FoldRow folded={folded.has("dms")}>
                <button type="button" onClick={props.onAllDms} className={ROW} data-all-dms="">
                  <span className="flex w-6 shrink-0 justify-center text-muted"><ChevronRight size={20} /></span>
                  <span className="min-w-0 flex-1 truncate text-muted">すべての DM</span>
                </button>
              </FoldRow>
            )}
          </ul>
          {sections.dms.length === 0 && !selfPlaceholder && !folded.has("dms") && <Hint>✏️ から相手を選んで開始</Hint>}
        </HomeSection>
      </nav>
      <button
        type="button"
        aria-label="新しいメッセージ"
        title="新しいメッセージ"
        onClick={props.onCompose}
        data-compose-fab=""
        className="absolute bottom-4 right-4 z-10 flex h-14 w-14 items-center justify-center rounded-2xl bg-accent-solid text-white shadow-lg shadow-black/20 transition-transform hover:brightness-110 active:scale-95"
      >
        <SquarePen size={24} />
      </button>
      {confirmReadAll && (
        <Modal onClose={() => setConfirmReadAll(false)} title="すべて既読にしますか？" className="w-[420px]">
          <p className="mt-3 text-sm text-muted">参加しているすべてのチャンネルと DM を最後まで読んだことにします。</p>
          <div className="mt-4 flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setConfirmReadAll(false)}>キャンセル</Button>
            <Button onClick={() => { setConfirmReadAll(false); void controller.markAllRead(); }}>既読にする</Button>
          </div>
        </Modal>
      )}
      {newSection && <NewSectionDialog controller={controller} onClose={() => setNewSection(false)} />}
    </section>
  );
}

const ROW = "flex min-h-11 w-full items-center gap-3 px-4 py-1.5 text-left text-[15px] leading-5 transition-colors hover:bg-panel active:bg-panel";

function HomeHeader({ controller, gatherUnread, onGatherUnread, onBrowse, onNewChannel, onDirectory, onCreateTimes, hasMyTimes, onReadAll, onNewSection }: HomeViewProps & { hasMyTimes: boolean; onReadAll: () => void; onNewSection: () => void }) {
  const name = controller.workspaceName;
  const status = controller.engine?.status ?? "idle";
  const switchable = controller.multiWorkspace && controller.workspaces.length >= 2;
  const entry = controller.activeEntry;
  const title = <strong className="min-w-0 truncate text-[17px]">{name}</strong>;
  return (
    <header className="flex h-[52px] shrink-0 items-center gap-2 pl-4 pr-2">
      {switchable ? (
        <Menu>
          <MenuTrigger asChild>
            <button type="button" aria-label={`ワークスペース: ${name}`} className="-ml-1 flex min-w-0 items-center gap-2 rounded-lg px-1 py-1 text-left hover:bg-panel">
              <WorkspaceIcon serverUrl={entry?.serverUrl} version={entry?.iconVersion} name={name} colorKey={entry?.workspaceId ?? entry?.serverUrl ?? name} className="h-6 w-6 rounded-md text-[11px]" />
              {title}
              <ChevronDown size={16} className="shrink-0 text-muted" />
            </button>
          </MenuTrigger>
          <MenuContent align="start" className="min-w-60">
            {controller.workspaces.map((workspace) => (
              <MenuItem key={workspace.serverUrl} onSelect={() => void controller.switchWorkspace(workspace.serverUrl)}>
                <WorkspaceIcon serverUrl={workspace.serverUrl} version={workspace.iconVersion} name={workspace.name} colorKey={workspace.workspaceId ?? workspace.serverUrl} className="h-5 w-5 rounded text-[10px]" />
                <span className="min-w-0 flex-1 truncate">{workspace.name}</span>
                {workspace.serverUrl === controller.activeServer && <Check size={15} className="text-accent" />}
              </MenuItem>
            ))}
            <MenuSeparator />
            <MenuItem onSelect={() => controller.beginAddWorkspace()}>
              <Plus size={15} /> ワークスペースを追加…
            </MenuItem>
          </MenuContent>
        </Menu>
      ) : (
        title
      )}
      {status !== "online" && status !== "idle" && (
        <span className="flex shrink-0 items-center gap-1 text-[11px] text-muted" title={statusTitle(status)}>
          <span className={cn("h-2 w-2 rounded-full", status === "connecting" ? "animate-pulse bg-warning" : "bg-warning")} />
          {statusLabel(status)}
        </span>
      )}
      <span className="flex-1" />
      <Menu>
        <MenuTrigger asChild>
          <button type="button" aria-label="ホームのメニュー" title="ホームのメニュー" className="inline-flex h-11 w-11 items-center justify-center rounded-lg text-ink transition-colors hover:bg-panel">
            <MoreHorizontal size={22} />
          </button>
        </MenuTrigger>
        <MenuContent align="end" className="min-w-56">
          <MenuItem onSelect={onReadAll}>すべて既読にする…</MenuItem>
          <MenuCheckboxItem checked={gatherUnread} onCheckedChange={(on) => onGatherUnread(on === true)}>未読をまとめる</MenuCheckboxItem>
          <MenuSeparator />
          {!controller.isGuest && <MenuItem onSelect={onBrowse}>チャンネルを探す</MenuItem>}
          {!controller.isGuest && <MenuItem onSelect={onNewChannel}>チャンネルを作成</MenuItem>}
          <MenuItem onSelect={onDirectory}>メンバー一覧</MenuItem>
          <MenuItem onSelect={onNewSection}>新しいセクション…</MenuItem>
          {!hasMyTimes && !controller.isGuest && <MenuItem onSelect={onCreateTimes}>自分の times を作る</MenuItem>}
          {controller.multiWorkspace && !switchable && <MenuItem onSelect={() => controller.beginAddWorkspace()}>ワークスペースを追加…</MenuItem>}
          <MenuSeparator />
          <MenuItem onSelect={() => void controller.resync()}>再読み込み</MenuItem>
        </MenuContent>
      </Menu>
    </header>
  );
}

/** The tiles across the top (MOBILE_UI.md §6.1): the views the wide sidebar lists as rows. A zero is dimmed, still a tap. */
function Tiles({ controller, onThreads, onTimesFeed, onDrafts, onSaved, onReminders, onFiles, onCanvases, onCalendar, onTasks, onDeadlines, onReservations }: HomeViewProps) {
  const store = controller.store;
  const threads = store.threadSummary;
  const drafts = store.listDrafts().length + store.scheduled.size;
  const fired = store.firedReminderCount();
  const tiles: Array<{ key: string; label: string; icon: ReactNode; count: number | null; danger: boolean; onClick: () => void }> = [
    { key: "threads", label: "スレッド", icon: <MessagesSquare size={20} />, count: threads.unread_count, danger: threads.mention_count > 0, onClick: onThreads },
    ...(onTimesFeed ? [{ key: "times", label: "Times", icon: <Newspaper size={20} />, count: null, danger: false, onClick: onTimesFeed }] : []),
    { key: "drafts", label: "下書き", icon: <FileText size={20} />, count: drafts, danger: false, onClick: onDrafts },
    { key: "saved", label: "保存", icon: <Bookmark size={20} />, count: store.bookmarks.size, danger: false, onClick: onSaved },
    { key: "reminders", label: "リマインダー", icon: <AlarmClock size={20} />, count: fired, danger: fired > 0, onClick: onReminders },
    ...(onCalendar ? [{ key: "calendar", label: "カレンダー", icon: <CalendarDays size={20} />, count: null, danger: false, onClick: onCalendar }] : []),
    ...(onTasks ? [{ key: "tasks", label: "タスク", icon: <ListTodo size={20} />, count: null, danger: false, onClick: onTasks }] : []),
    ...(onDeadlines ? [{ key: "deadlines", label: "締切", icon: <Timer size={20} />, count: null, danger: false, onClick: onDeadlines }] : []),
    // M112: 「予約」 — the count is the to-dos due in the pools I operate (apps/shared/nav-items.json key "reservations").
    ...(onReservations ? [{ key: "reservations", label: "予約", icon: <Ticket size={20} />, count: store.reservationPools?.some((p) => p.can_operate) ? reservationTodoCount(store.reservationPools) : null, danger: true, onClick: onReservations }] : []),
    { key: "files", label: "ファイル", icon: <Files size={20} />, count: null, danger: false, onClick: onFiles },
    ...(onCanvases ? [{ key: "canvases", label: "キャンバス", icon: <NotebookText size={20} />, count: null, danger: false, onClick: onCanvases }] : []),
  ];
  return (
    <div className="flex gap-2 overflow-x-auto px-3 pb-2 pt-1 [scrollbar-width:none]">
      {tiles.map((tile) => {
        const empty = tile.count === 0;
        return (
          <button
            key={tile.key}
            type="button"
            data-tile={tile.key}
            data-empty={empty || undefined}
            onClick={tile.onClick}
            aria-label={tile.count ? `${tile.label} (${tile.count})` : tile.label}
            className={cn("flex h-[68px] min-w-[84px] shrink-0 flex-col justify-between rounded-xl border border-line bg-panel px-3 py-2 text-left transition-colors hover:bg-panel-2", empty && "opacity-50")}
          >
            <span className="flex items-center justify-between gap-2">
              <span className="text-muted">{tile.icon}</span>
              {tile.count !== null && tile.count > 0 && (
                <Badge tone={tile.danger ? "danger" : "neutral"}>{tile.count > 99 ? "99+" : tile.count}</Badge>
              )}
            </span>
            <span aria-hidden="true" className="text-[13px] font-medium">{tile.label}</span>
          </button>
        );
      })}
    </div>
  );
}

function HomeSection({ title, sectionKey, icon, action, children, collapsed = false, onToggle }: {
  title: string;
  sectionKey: string;
  icon?: ReactNode;
  action?: ReactNode;
  children: ReactNode;
  collapsed?: boolean;
  onToggle?: () => void;
}) {
  return (
    <section data-home-section={sectionKey} className="mt-2">
      <h2 className="flex h-9 items-center justify-between gap-1 pl-3 pr-2 text-[13px] font-semibold text-muted">
        {onToggle ? (
          <button type="button" aria-expanded={!collapsed} onClick={onToggle} className="flex h-9 min-w-0 flex-1 items-center gap-1.5 rounded-md px-1 text-left hover:text-ink">
            <ChevronDown size={15} className={cn("shrink-0 transition-transform duration-200", collapsed && "-rotate-90")} />
            {icon}
            <span className="truncate">{title}</span>
          </button>
        ) : (
          <span className="flex min-w-0 items-center gap-1.5 px-1">{icon}<span className="truncate">{title}</span></span>
        )}
        {action && <span className="text-ink [&_button:hover]:bg-panel">{action}</span>}
      </h2>
      {children}
    </section>
  );
}

function FoldRow({ folded, children }: { folded: boolean; children: ReactNode }) {
  return (
    <li className={cn("fold-row", folded && "folded")} aria-hidden={folded || undefined} inert={folded}>
      <div className="fold-inner">{children}</div>
    </li>
  );
}

/** One conversation: 44 px or more, a 20–24 px glyph or picture, the name, no topic line; unread bold, mutes faded. */
function HomeRow({ controller, channel, folded, onOpen }: { controller: AppController; channel: ChannelState; folded: boolean; onOpen: (id: string) => void }) {
  const store = controller.store;
  const meId = store.me?.id ?? controller.me?.id ?? null;
  const muted = isMutedChannel(channel);
  const unread = hasUnread(channel, meId);
  const quietUnread = !unread && channel.unreadCount > 0 && isQuietChannel(channel, meId);
  const badge = badgeCount(channel);
  const title = channelTitle(channel, controller);
  const other = isDmChannel(channel) ? ((channel.dm_user_ids ?? []).find((id) => id !== meId) ?? meId ?? undefined) : undefined;
  const group = isDmChannel(channel) && (channel.dm_user_ids ?? []).filter((id) => id !== meId).length > 1;
  return (
    <FoldRow folded={folded}>
      <ChannelContextMenu controller={controller} channel={channel}>
        <button
          type="button"
          onClick={() => onOpen(channel.id)}
          title={title}
          data-unread={unread || undefined}
          className={cn(ROW, unread ? "font-bold text-ink" : "text-ink/85", muted && !unread && "opacity-55")}
        >
          <span className="flex w-6 shrink-0 justify-center text-muted">
            {isDmChannel(channel) ? (
              group ? (
                <span className="flex h-6 w-6 items-center justify-center rounded-md bg-panel-2 text-[11px] font-semibold">{(channel.dm_user_ids ?? []).length - 1}</span>
              ) : other ? (
                <Avatar id={other} name={store.users.get(other)?.display_name ?? "?"} size={24} className="rounded-md text-[10px]" presence={store.presenceOf(other)} presenceClassName="border border-canvas" />
              ) : (
                <AtSign size={20} />
              )
            ) : channel.type === "private" ? (
              <Lock size={20} />
            ) : (
              <Hash size={20} />
            )}
          </span>
          <span className="min-w-0 flex-1 truncate">{title.replace(/^#/, "")}</span>
          {other && !group && <StatusEmoji controller={controller} userId={other} className="shrink-0" />}
          {muted && <BellOff size={15} className="shrink-0 text-muted" aria-label="ミュート中" />}
          {unread && badge > 0 ? (
            <Badge tone="danger">{badge}</Badge>
          ) : unread ? (
            <span className="h-2 w-2 shrink-0 rounded-full bg-accent" aria-label="未読" />
          ) : quietUnread ? (
            <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-muted/50" title="新しい投稿があります (静かな未読)" />
          ) : null}
        </button>
      </ChannelContextMenu>
    </FoldRow>
  );
}

function Hint({ children }: { children: ReactNode }) {
  return <p className="px-4 py-1.5 text-[13px] text-muted">{children}</p>;
}
