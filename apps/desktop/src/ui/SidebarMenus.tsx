import { ContextMenu, DropdownMenu } from "radix-ui";
import { Check, MoreHorizontal, Pin } from "lucide-react";
import { type FormEvent, type KeyboardEvent, type ReactNode, useState } from "react";

import type { NotificationLevel, SidebarSectionOut, SidebarSort } from "../api/types";
import type { AppController, SortTarget } from "../state/app";
import type { ChannelState } from "../sync/types";
import { FOLLOW_DEFAULT, isDmChannel, isTimedMuted, notificationChoices, overallLevel } from "./channels";
import { canManageChannelByRight } from "./roles";
import { SectionDialog } from "./SectionDialog";
import { Button, cn, Input, Modal } from "./primitives";
import { t, type MessageKey } from "../i18n";

const CONTENT = "rx-popover z-50 min-w-52 rounded-xl border border-line bg-canvas p-1 text-ink shadow-xl";
const ITEM = "flex select-none items-center gap-2 rounded-lg px-2.5 py-1.5 text-sm outline-none data-[disabled]:opacity-50 data-[highlighted]:bg-accent-soft";

/** What a conversation row's menu asks the main screen to do (it opens the conversation, then the dialog). */
export type ChannelRowAction = "details" | "rename" | "leave" | "archive";

/**
 * Shift+F10 or the context-menu key on a row (or the sidebar) opens its context menu, as a right-click does: a
 * `contextmenu` at the element's lower left, which Radix's trigger takes (and then focuses the menu).
 */
export function openContextMenuByKey(event: KeyboardEvent<HTMLElement>): void {
  if (!((event.key === "F10" && event.shiftKey) || event.key === "ContextMenu")) return;
  event.preventDefault();
  const box = event.currentTarget.getBoundingClientRect();
  event.currentTarget.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: box.left + Math.min(24, box.width / 2), clientY: box.bottom }));
}

/**
 * Right-click (or Shift+F10 / the context-menu key) on a sidebar row (M14f, 2026-10-12 richer, MOBILE_UI.md §18.7):
 * read / unread, star it, move it into one of my sections, its notifications and mute (M35), copy a link, its details,
 * rename, leave or close, archive. The rename / leave / archive / details items need `onAction` (the main screen's
 * dialogs; HomeView and the DM list leave them out); rename and archive are the channel's owners' and managers'.
 */
export function ChannelContextMenu({ controller, channel, children, onAction }: { controller: AppController; channel: ChannelState; children: ReactNode; onAction?: (channelId: string, action: ChannelRowAction) => void }) {
  const store = controller.store;
  const sections = store.sidebarSections;
  const [naming, setNaming] = useState(false);
  const starred = store.isFavorite(channel.id);
  // A starred conversation shows in お気に入り (a server before 2026-10-07 may still have it in a section too).
  const current = starred ? null : store.sectionOf(channel.id);
  const muted = !!channel.muted || isTimedMuted(channel);
  // M118: DMs and group DMs (my own DM too) pin to the top; not offered by a server before M118 (no dm_pins).
  const pinnable = isDmChannel(channel) && channel.isMember && store.dmPins !== null;
  const pinned = store.isDmPinned(channel.id);
  // M141 「会話を閉じる」: DMs and group DMs too; not offered by a server before M141 (no closed_dms).
  const closable = isDmChannel(channel) && channel.isMember && store.closedDms !== null;
  const isChannel = channel.type === "public" || channel.type === "private";
  // M142: owners, and channels.manage (administrators and managers; docs/ROLES.md §2) — the header's ⋯ menu's rule.
  // (A controller without `can`, a test's stand-in, counts as no rights.)
  const canManage = isChannel && (channel.membership?.role === "owner" || canManageChannelByRight(channel, (capability) => typeof controller.can === "function" && controller.can(capability)));
  const engine = controller.engine;
  // 既読にする while something is unread (quiet unread too); 未読にする marks the newest message unread.
  const unread = channel.unreadCount > 0 || channel.lastReadSeq < channel.lastSeq;
  const readable = channel.isMember && !!engine;
  const overall = overallLevel(store.me ?? controller.me);
  return (
    <>
      <ContextMenu.Root>
        <ContextMenu.Trigger asChild onKeyDown={openContextMenuByKey}>{children}</ContextMenu.Trigger>
        <ContextMenu.Portal>
          <ContextMenu.Content className={CONTENT} collisionPadding={8}>
            {readable && (unread ? (
              <ContextMenu.Item className={ITEM} data-row-action="read" onSelect={() => engine!.markRead(channel.id, channel.lastSeq, { force: true })}>
                {t("channelMenu.markRead")}
              </ContextMenu.Item>
            ) : channel.lastSeq > 0 ? (
              <ContextMenu.Item className={ITEM} data-row-action="unread" onSelect={() => engine!.markUnread(channel.id, channel.lastSeq)}>
                {t("channelMenu.markUnread")}
              </ContextMenu.Item>
            ) : null)}
            {pinnable && (
              <ContextMenu.Item className={ITEM} onSelect={() => void controller.toggleDmPin(channel.id)}>
                {pinned ? t("dmPin.unpin") : t("dmPin.pin")}
              </ContextMenu.Item>
            )}
            <ContextMenu.Item className={ITEM} onSelect={() => void controller.toggleFavorite(channel.id)}>
              {starred ? t("channel.unfavorite") : t("channel.favorite")}
            </ContextMenu.Item>
            <ContextMenu.Sub>
              <ContextMenu.SubTrigger className={cn(ITEM, "justify-between")}>
                {t("sections.moveTo")} <span className="text-muted">›</span>
              </ContextMenu.SubTrigger>
              <ContextMenu.Portal>
                <ContextMenu.SubContent className={CONTENT} sideOffset={4}>
                  {sections.map((section) => (
                    <ContextMenu.Item key={section.id} className={ITEM} disabled={section.id === current} onSelect={() => void controller.moveToSection(channel.id, section.id)}>
                      {section.name}
                      {section.id === current && <span className="ml-auto text-xs text-muted">{t("sections.current")}</span>}
                    </ContextMenu.Item>
                  ))}
                  {sections.length > 0 && <ContextMenu.Separator className="my-1 h-px bg-line" />}
                  <ContextMenu.Item className={ITEM} onSelect={() => setNaming(true)}>
                    {t("home.newSection")}
                  </ContextMenu.Item>
                </ContextMenu.SubContent>
              </ContextMenu.Portal>
            </ContextMenu.Sub>
            {current && (
              <ContextMenu.Item className={ITEM} onSelect={() => void controller.moveToSection(channel.id, null)}>
                {t("sections.removeFrom")}
              </ContextMenu.Item>
            )}
            <ContextMenu.Separator className="my-1 h-px bg-line" />
            {channel.isMember && (
              // M35: a level change keeps both mutes (the timed one is sent back as it is, `muted` is left out).
              <ContextMenu.Sub>
                <ContextMenu.SubTrigger className={cn(ITEM, "justify-between")} data-row-action="notifications">
                  {t("channelMenu.notifications")} <span className="text-muted">›</span>
                </ContextMenu.SubTrigger>
                <ContextMenu.Portal>
                  <ContextMenu.SubContent className={CONTENT} sideOffset={4}>
                    <ContextMenu.RadioGroup
                      value={channel.notificationLevel ?? FOLLOW_DEFAULT}
                      onValueChange={(value) => void controller.setNotification(channel.id, value === FOLLOW_DEFAULT ? null : (value as NotificationLevel), channel.mutedUntil)}
                    >
                      {notificationChoices(overall).map((choice) => (
                        <ContextMenu.RadioItem key={choice.value} value={choice.value} className={cn(ITEM, "relative pl-7")}>
                          <ContextMenu.ItemIndicator className="absolute left-2.5"><Check size={13} /></ContextMenu.ItemIndicator>
                          {choice.label}
                        </ContextMenu.RadioItem>
                      ))}
                    </ContextMenu.RadioGroup>
                  </ContextMenu.SubContent>
                </ContextMenu.Portal>
              </ContextMenu.Sub>
            )}
            {/* M35: 「ミュート」 mutes until unmuted; 「ミュート解除」 ends it and a timed mute. The own level stays. */}
            {muted ? (
              <ContextMenu.Item className={ITEM} onSelect={() => void controller.setNotification(channel.id, channel.notificationLevel, null, false)}>
                {t("sections.unmute")}
              </ContextMenu.Item>
            ) : (
              <ContextMenu.Item className={ITEM} onSelect={() => void controller.setNotification(channel.id, channel.notificationLevel, channel.mutedUntil, true)}>
                {t("channel.mute")}
              </ContextMenu.Item>
            )}
            <ContextMenu.Separator className="my-1 h-px bg-line" />
            {channel.isMember && (
              <ContextMenu.Item className={ITEM} data-row-action="copy-link" onSelect={() => void controller.copyChannelLink(channel.id)}>
                {t("channelMenu.copyLink")}
              </ContextMenu.Item>
            )}
            {onAction && channel.isMember && (
              <ContextMenu.Item className={ITEM} data-row-action="details" onSelect={() => onAction(channel.id, "details")}>
                {isChannel ? t("main.channelInfo") : t("main.conversationInfo")}
              </ContextMenu.Item>
            )}
            {onAction && canManage && !channel.archived && (
              <ContextMenu.Item className={ITEM} data-row-action="rename" onSelect={() => onAction(channel.id, "rename")}>
                {t("channel.rename")}
              </ContextMenu.Item>
            )}
            {(closable || (onAction && isChannel && channel.isMember) || (onAction && canManage && !channel.archived)) && <ContextMenu.Separator className="my-1 h-px bg-line" />}
            {closable && (
              <ContextMenu.Item className={ITEM} onSelect={() => void controller.closeDm(channel.id)}>
                {t("dmClose.close")}
              </ContextMenu.Item>
            )}
            {onAction && isChannel && channel.isMember && (
              <ContextMenu.Item className={ITEM} data-row-action="leave" onSelect={() => onAction(channel.id, "leave")}>
                {t("channel.leave")}
              </ContextMenu.Item>
            )}
            {onAction && canManage && !channel.archived && (
              <ContextMenu.Item className={cn(ITEM, "text-danger")} data-row-action="archive" onSelect={() => onAction(channel.id, "archive")}>
                {t("channel.archive")}
              </ContextMenu.Item>
            )}
          </ContextMenu.Content>
        </ContextMenu.Portal>
      </ContextMenu.Root>
      {naming && (
        <SectionDialog
          controller={controller}
          title={t("sidebar.newSection")}
          submitLabel={t("common.create")}
          pickChannels
          preselected={[channel.id]}
          onClose={() => setNaming(false)}
          onSubmit={(form) => controller.createSection(form.name, form.emoji, form.channelIds)}
        />
      )}
    </>
  );
}

/**
 * Right-click (or Shift+F10 / the context-menu key) on the sidebar's empty space (MOBILE_UI.md §18.6): new section,
 * create / browse channels, new DM, mark everything read, and the sidebar's display (order and placement). A row's own
 * menu wins over it (Radix's trigger skips a `contextmenu` a nested one already took).
 */
export function SidebarContextMenu({ guest, onNewSection, onNewChannel, onBrowse, onNewDm, onReadAll, onDisplay, children }: {
  guest: boolean;
  onNewSection: () => void;
  onNewChannel?: () => void;
  onBrowse?: () => void;
  onNewDm?: () => void;
  onReadAll?: () => void;
  onDisplay?: () => void;
  children: ReactNode;
}) {
  return (
    <ContextMenu.Root>
      <ContextMenu.Trigger asChild>{children}</ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Content className={CONTENT} collisionPadding={8} data-sidebar-menu="">
          <ContextMenu.Item className={ITEM} data-sidebar-action="new-section" onSelect={onNewSection}>{t("sidebar.newSection")}</ContextMenu.Item>
          {onNewChannel && !guest && <ContextMenu.Item className={ITEM} data-sidebar-action="new-channel" onSelect={onNewChannel}>{t("sidebar.createChannel")}</ContextMenu.Item>}
          {onBrowse && !guest && <ContextMenu.Item className={ITEM} data-sidebar-action="browse" onSelect={onBrowse}>{t("sidebar.browse")}</ContextMenu.Item>}
          {onNewDm && <ContextMenu.Item className={ITEM} data-sidebar-action="new-dm" onSelect={onNewDm}>{t("sidebarMenu.newDm")}</ContextMenu.Item>}
          {onReadAll && (
            <>
              <ContextMenu.Separator className="my-1 h-px bg-line" />
              <ContextMenu.Item className={ITEM} data-sidebar-action="read-all" onSelect={onReadAll}>{t("sidebar.markAllRead")}</ContextMenu.Item>
            </>
          )}
          {onDisplay && (
            <>
              <ContextMenu.Separator className="my-1 h-px bg-line" />
              <ContextMenu.Item className={ITEM} data-sidebar-action="display" onSelect={onDisplay}>{t("sidebarMenu.display")}</ContextMenu.Item>
            </>
          )}
        </ContextMenu.Content>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  );
}

/** M118: the mark on a pinned DM's row (sidebar, home, the DM tab). */
export function PinMark({ size = 12, className }: { size?: number; className?: string }) {
  return (
    <span role="img" aria-label={t("dmPin.pinned")} title={t("dmPin.pinned")} data-dm-pinned="" className={cn("inline-flex shrink-0", className)}>
      <Pin size={size} className="rotate-45" aria-hidden />
    </span>
  );
}

const SORTS: ReadonlyArray<[SidebarSort, MessageKey]> = [
  ["name", "sections.sortName"],
  ["recent", "sections.sortRecent"],
  ["manual", "sections.sortManual"],
];

/**
 * 「並べ替え」 › 名前順 / 最近の活動順 / 手動 (DATA_MODEL.md sidebar_sections, Mattermost style): kept on the server, so my
 * other devices follow. `shownIds` is the order shown now, the hand-made order's start when 「手動」 is chosen.
 */
function SortSubmenu({ controller, target, sort, shownIds }: { controller: AppController; target: SortTarget; sort: SidebarSort; shownIds: () => string[] }) {
  return (
    <DropdownMenu.Sub>
      <DropdownMenu.SubTrigger className={cn(ITEM, "justify-between")}>
        {t("sections.sort")} <span className="text-muted">›</span>
      </DropdownMenu.SubTrigger>
      <DropdownMenu.Portal>
        <DropdownMenu.SubContent className={CONTENT} sideOffset={4}>
          <DropdownMenu.RadioGroup value={sort} onValueChange={(value) => { if (value !== sort) void controller.setSectionSort(target, value as SidebarSort, shownIds()); }}>
            {SORTS.map(([value, label]) => (
              <DropdownMenu.RadioItem key={value} value={value} className={cn(ITEM, "pl-7 relative")}>
                <DropdownMenu.ItemIndicator className="absolute left-2.5"><Check size={13} /></DropdownMenu.ItemIndicator>
                {t(label)}
              </DropdownMenu.RadioItem>
            ))}
          </DropdownMenu.RadioGroup>
        </DropdownMenu.SubContent>
      </DropdownMenu.Portal>
    </DropdownMenu.Sub>
  );
}

/** The 「…」 on a default section's header (お気に入り / チャンネル / ダイレクトメッセージ): its 「並べ替え」. */
export function DefaultSectionMenu({ controller, target, title, sort, shownIds }: { controller: AppController; target: SortTarget; title: string; sort: SidebarSort; shownIds: () => string[] }) {
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button type="button" aria-label={t("sections.menu", { name: title })} className="flex h-6 w-6 items-center justify-center rounded-md opacity-70 hover:bg-white/10 hover:opacity-100">
          <MoreHorizontal size={14} />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content sideOffset={6} align="end" className={CONTENT}>
          <SortSubmenu controller={controller} target={target} sort={sort} shownIds={shownIds} />
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

/** The 「…」 on a custom section's header: name and icon, sort, move up / down, delete. */
export function SectionHeaderMenu({ controller, section, index, count, shownIds }: { controller: AppController; section: SidebarSectionOut; index: number; count: number; shownIds: () => string[] }) {
  const [renaming, setRenaming] = useState(false);
  const [creating, setCreating] = useState(false);
  return (
    <>
      <DropdownMenu.Root>
        <DropdownMenu.Trigger asChild>
          <button type="button" aria-label={t("sections.menu", { name: section.name })} className="flex h-6 w-6 items-center justify-center rounded-md opacity-70 hover:bg-white/10 hover:opacity-100">
            <MoreHorizontal size={14} />
          </button>
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content sideOffset={6} align="end" className={CONTENT}>
            <DropdownMenu.Item className={ITEM} onSelect={() => setRenaming(true)}>{t("sections.renameIcon")}</DropdownMenu.Item>
            <SortSubmenu controller={controller} target={{ section: section.id }} sort={section.sort ?? "name"} shownIds={shownIds} />
            <DropdownMenu.Item className={ITEM} disabled={index === 0} onSelect={() => void controller.moveSection(section.id, index - 1)}>{t("common.moveUp")}</DropdownMenu.Item>
            <DropdownMenu.Item className={ITEM} disabled={index === count - 1} onSelect={() => void controller.moveSection(section.id, index + 1)}>{t("common.moveDown")}</DropdownMenu.Item>
            <DropdownMenu.Item className={ITEM} onSelect={() => setCreating(true)}>{t("home.newSection")}</DropdownMenu.Item>
            <DropdownMenu.Separator className="my-1 h-px bg-line" />
            <DropdownMenu.Item className={cn(ITEM, "text-danger")} onSelect={() => void controller.deleteSection(section.id)}>
              {t("sections.delete")}
            </DropdownMenu.Item>
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>
      {renaming && (
        <SectionDialog
          controller={controller}
          title={t("sections.edit")}
          submitLabel={t("common.save")}
          initial={{ name: section.name, emoji: section.emoji ?? null }}
          pickChannels={false}
          onClose={() => setRenaming(false)}
          onSubmit={(form) => controller.editSection(section.id, form.name, form.emoji)}
        />
      )}
      {creating && <NewSectionDialog controller={controller} onClose={() => setCreating(false)} />}
    </>
  );
}

/** 「新しいセクション」 from a header or the channels' 「…」: name, icon and the conversations to put in it. */
export function NewSectionDialog({ controller, onClose }: { controller: AppController; onClose: () => void }) {
  return (
    <SectionDialog
      controller={controller}
      title={t("sidebar.newSection")}
      submitLabel={t("common.create")}
      pickChannels
      onClose={onClose}
      onSubmit={(form) => controller.createSection(form.name, form.emoji, form.channelIds)}
    />
  );
}
