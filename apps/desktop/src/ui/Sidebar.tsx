import { AlarmClock, AtSign, BellOff, Bookmark, CheckCheck, Compass, Files, FileText, Hash, Lock, MessagesSquare, Plus, Search, Settings, ShieldCheck } from "lucide-react";

import type { AppController } from "../state/app";
import type { ChannelState } from "../sync/types";
import { Avatar } from "./Avatar";
import { badgeCount, hasUnread, isDmChannel, isMutedChannel, sectionChannels } from "./channels";
import { channelTitle } from "./MainScreen";
import { Badge, cn, IconButton, Kbd, modKey } from "./primitives";
import { StatusEmoji } from "./UserPopover";

interface Props {
  controller: AppController;
  channels: ChannelState[];
  currentId: string | null;
  unreadOnly: boolean;
  onToggleUnreadOnly: () => void;
  onOpen: (id: string) => void;
  onJoin: (id: string) => void;
  onNewDm: () => void;
  onNewChannel: () => void;
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
  onMentions?: () => void;
  mentionsActive?: boolean;
  onDrafts?: () => void;
  draftsActive?: boolean;
  /** M11i: files in my channels. */
  onFiles?: () => void;
  filesActive?: boolean;
  /** M12a: every channel read to its end. */
  onReadAll?: () => void;
  /** M12e: reminders; listed while any is open. */
  onReminders?: () => void;
  remindersActive?: boolean;
}

export function Sidebar({ controller, channels, currentId, unreadOnly, onToggleUnreadOnly, onOpen, onJoin, onNewDm, onNewChannel, onSearch, onSettings, onThreads, threadsActive = false, onSaved, savedActive = false, onAdmin, onBrowse, onMentions, mentionsActive = false, onDrafts, draftsActive = false, onFiles, filesActive = false, onReadAll, onReminders, remindersActive = false }: Props) {
  const store = controller.store;
  const reminderCount = store.reminders.size;
  const firedCount = store.firedReminderCount();
  const draftCount = store.listDrafts().length + store.scheduled.size;
  const me = store.me ?? controller.me;
  const sections = sectionChannels(channels, (c) => channelTitle(c, controller), { unreadOnly, currentId, favorites: store.favorites });
  const status = controller.engine?.status ?? "idle";

  const item = (channel: ChannelState) => {
    const muted = isMutedChannel(channel);
    const unread = hasUnread(channel) && channel.id !== currentId;
    const badge = badgeCount(channel);
    const active = channel.id === currentId;
    const other = isDmChannel(channel) ? (channel.dm_user_ids ?? []).find((id) => id !== me?.id) : undefined;
    return (
      <li key={channel.id}>
        <button
          type="button"
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
            other ? <Avatar id={other} name={store.users.get(other)?.display_name ?? "?"} size={18} className="rounded-md text-[9px]" presence={store.presenceOf(other)} /> : <AtSign size={15} className="shrink-0 opacity-70" />
          ) : channel.type === "private" ? (
            <Lock size={15} className="shrink-0 opacity-70" />
          ) : (
            <Hash size={15} className="shrink-0 opacity-70" />
          )}
          <span className="flex-1 truncate">{channelTitle(channel, controller).replace(/^#/, "")}</span>
          {other && <StatusEmoji controller={controller} userId={other} className="shrink-0" />}
          {muted && <BellOff size={12} className="shrink-0 opacity-70" />}
          {unread && badge > 0 ? <Badge tone="danger">{badge}</Badge> : unread ? <span className="h-2 w-2 shrink-0 rounded-full bg-white" /> : null}
        </button>
      </li>
    );
  };

  return (
    <nav className="flex h-full min-h-0 flex-col overflow-y-auto bg-sidebar px-2 pb-4 text-sidebar-fg">
      <div className="flex items-center gap-2.5 border-b border-white/10 px-2 py-3">
        {me && <Avatar id={me.id} name={me.display_name} size={34} className="rounded-xl" />}
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-semibold text-white">{me?.display_name ?? ""}</div>
          <div className="flex items-center gap-1.5 text-[11px] opacity-80">
            <span className={cn("h-2 w-2 rounded-full", status === "online" ? "bg-success" : status === "connecting" ? "animate-pulse bg-warning" : status === "offline" ? "bg-warning" : "bg-white/30")} />
            {statusLabel(status)}
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
          <Kbd className="border-white/20 bg-transparent text-sidebar-fg/80">{modKey()} K</Kbd>
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
          {onMentions && (
            <li>
              <button
                type="button"
                onClick={onMentions}
                aria-current={mentionsActive ? "page" : undefined}
                title="自分宛てのメンション"
                className={cn(
                  "flex w-full items-center gap-2 rounded-lg px-2.5 py-[6px] text-left text-[13.5px] leading-5 transition-colors",
                  mentionsActive ? "bg-sidebar-active text-white" : "hover:bg-sidebar-hover hover:text-white",
                )}
              >
                <AtSign size={15} className="shrink-0 opacity-70" />
                <span className="flex-1 truncate">メンション</span>
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
        <Section title="お気に入り">
          <ul className="space-y-px">{sections.favorites.map(item)}</ul>
        </Section>
      )}
      <Section
        title="チャンネル"
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
            {!controller.isGuest && (
              <IconButton tone="sidebar" label="チャンネルを作成" className="h-6 w-6" onClick={onNewChannel}>
                <Plus size={14} />
              </IconButton>
            )}
          </span>
        }
      >
        <ul className="space-y-px">{sections.channels.map(item)}</ul>
        {sections.channels.length === 0 && <Hint>{unreadOnly ? "未読のチャンネルはありません" : "まだチャンネルがありません"}</Hint>}
      </Section>
      <Section
        title="ダイレクトメッセージ"
        action={
          <IconButton tone="sidebar" label={`DM を開始 (${modKey()}+Shift+K)`} className="h-6 w-6" onClick={onNewDm}>
            <Plus size={14} />
          </IconButton>
        }
      >
        <ul className="space-y-px">{sections.dms.map(item)}</ul>
        {sections.dms.length === 0 && <Hint>{unreadOnly ? "未読の DM はありません" : "+ から相手を選んで開始"}</Hint>}
      </Section>
      {sections.browse.length > 0 && (
        <Section title="参加できるチャンネル">
          <ul className="space-y-px">
            {sections.browse.map((c) => (
              <li key={c.id}>
                <button
                  type="button"
                  onClick={() => onJoin(c.id)}
                  className="group flex w-full items-center gap-2 rounded-lg px-2.5 py-[6px] text-left text-[13.5px] opacity-80 hover:bg-sidebar-hover hover:text-white hover:opacity-100"
                >
                  <Hash size={15} className="shrink-0 opacity-70" />
                  <span className="flex-1 truncate">{c.name}</span>
                  <span className="text-[11px] opacity-0 transition-opacity group-hover:opacity-100">参加</span>
                </button>
              </li>
            ))}
          </ul>
        </Section>
      )}
    </nav>
  );
}

function Section({ title, action, children }: { title: string; action?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="mt-3">
      <h2 className="mb-1 flex h-6 items-center justify-between px-2.5 text-[11px] font-semibold uppercase tracking-wider text-sidebar-fg/70">
        {title}
        {action}
      </h2>
      {children}
    </section>
  );
}

function Hint({ children }: { children: React.ReactNode }) {
  return <p className="px-2.5 py-1 text-xs opacity-60">{children}</p>;
}

function statusLabel(status: string): string {
  switch (status) {
    case "online":
      return "接続中";
    case "connecting":
      return "接続しています…";
    case "offline":
      return "再接続を待っています";
    default:
      return "オフライン";
  }
}
