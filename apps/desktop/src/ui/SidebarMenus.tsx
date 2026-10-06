import { ContextMenu, DropdownMenu } from "radix-ui";
import { Check, MoreHorizontal, Pin } from "lucide-react";
import { type FormEvent, type ReactNode, useState } from "react";

import type { SidebarSectionOut, SidebarSort } from "../api/types";
import type { AppController, SortTarget } from "../state/app";
import type { ChannelState } from "../sync/types";
import { isDmChannel, isTimedMuted } from "./channels";
import { SectionDialog } from "./SectionDialog";
import { Button, cn, Input, Modal } from "./primitives";
import { t, type MessageKey } from "../i18n";

const CONTENT = "rx-popover z-50 min-w-52 rounded-xl border border-line bg-canvas p-1 text-ink shadow-xl";
const ITEM = "flex select-none items-center gap-2 rounded-lg px-2.5 py-1.5 text-sm outline-none data-[disabled]:opacity-50 data-[highlighted]:bg-accent-soft";

/** Right-click on a sidebar row (M14f): star it, move it into one of my sections, mute or unmute it (M35). */
export function ChannelContextMenu({ controller, channel, children }: { controller: AppController; channel: ChannelState; children: ReactNode }) {
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
  return (
    <>
      <ContextMenu.Root>
        <ContextMenu.Trigger asChild>{children}</ContextMenu.Trigger>
        <ContextMenu.Portal>
          <ContextMenu.Content className={CONTENT}>
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
