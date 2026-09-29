import { ContextMenu, DropdownMenu } from "radix-ui";
import { MoreHorizontal } from "lucide-react";
import { type FormEvent, type ReactNode, useState } from "react";

import type { SidebarSectionOut } from "../api/types";
import type { AppController } from "../state/app";
import type { ChannelState } from "../sync/types";
import { isTimedMuted } from "./channels";
import { SectionDialog } from "./SectionDialog";
import { Button, cn, Input, Modal } from "./primitives";

const CONTENT = "rx-popover z-50 min-w-52 rounded-xl border border-line bg-canvas p-1 text-ink shadow-xl";
const ITEM = "flex select-none items-center gap-2 rounded-lg px-2.5 py-1.5 text-sm outline-none data-[disabled]:opacity-50 data-[highlighted]:bg-accent-soft";

/** Right-click on a sidebar row (M14f): star it, move it into one of my sections, mute or unmute it (M35). */
export function ChannelContextMenu({ controller, channel, children }: { controller: AppController; channel: ChannelState; children: ReactNode }) {
  const store = controller.store;
  const sections = store.sidebarSections;
  const current = store.sectionOf(channel.id);
  const [naming, setNaming] = useState(false);
  const starred = store.isFavorite(channel.id);
  const muted = !!channel.muted || isTimedMuted(channel);
  return (
    <>
      <ContextMenu.Root>
        <ContextMenu.Trigger asChild>{children}</ContextMenu.Trigger>
        <ContextMenu.Portal>
          <ContextMenu.Content className={CONTENT}>
            <ContextMenu.Item className={ITEM} onSelect={() => void controller.toggleFavorite(channel.id)}>
              {starred ? "お気に入りから外す" : "お気に入りに追加"}
            </ContextMenu.Item>
            <ContextMenu.Sub>
              <ContextMenu.SubTrigger className={cn(ITEM, "justify-between")}>
                セクションに移動 <span className="text-muted">›</span>
              </ContextMenu.SubTrigger>
              <ContextMenu.Portal>
                <ContextMenu.SubContent className={CONTENT} sideOffset={4}>
                  {sections.map((section) => (
                    <ContextMenu.Item key={section.id} className={ITEM} disabled={section.id === current} onSelect={() => void controller.moveToSection(channel.id, section.id)}>
                      {section.name}
                      {section.id === current && <span className="ml-auto text-xs text-muted">現在</span>}
                    </ContextMenu.Item>
                  ))}
                  {sections.length > 0 && <ContextMenu.Separator className="my-1 h-px bg-line" />}
                  <ContextMenu.Item className={ITEM} onSelect={() => setNaming(true)}>
                    新しいセクション…
                  </ContextMenu.Item>
                </ContextMenu.SubContent>
              </ContextMenu.Portal>
            </ContextMenu.Sub>
            {current && (
              <ContextMenu.Item className={ITEM} onSelect={() => void controller.moveToSection(channel.id, null)}>
                セクションから外す
              </ContextMenu.Item>
            )}
            <ContextMenu.Separator className="my-1 h-px bg-line" />
            {/* M35: 「ミュート」 mutes until unmuted; 「ミュート解除」 ends it and a timed mute. The own level stays. */}
            {muted ? (
              <ContextMenu.Item className={ITEM} onSelect={() => void controller.setNotification(channel.id, channel.notificationLevel, null, false)}>
                ミュート解除
              </ContextMenu.Item>
            ) : (
              <ContextMenu.Item className={ITEM} onSelect={() => void controller.setNotification(channel.id, channel.notificationLevel, channel.mutedUntil, true)}>
                ミュート
              </ContextMenu.Item>
            )}
          </ContextMenu.Content>
        </ContextMenu.Portal>
      </ContextMenu.Root>
      {naming && (
        <SectionDialog
          controller={controller}
          title="新しいセクション"
          submitLabel="作成"
          pickChannels
          preselected={[channel.id]}
          onClose={() => setNaming(false)}
          onSubmit={(form) => controller.createSection(form.name, form.emoji, form.channelIds)}
        />
      )}
    </>
  );
}

/** The 「…」 on a custom section's header: name and icon, move up / down, delete. */
export function SectionHeaderMenu({ controller, section, index, count }: { controller: AppController; section: SidebarSectionOut; index: number; count: number }) {
  const [renaming, setRenaming] = useState(false);
  const [creating, setCreating] = useState(false);
  return (
    <>
      <DropdownMenu.Root>
        <DropdownMenu.Trigger asChild>
          <button type="button" aria-label={`${section.name} のメニュー`} className="flex h-6 w-6 items-center justify-center rounded-md opacity-70 hover:bg-white/10 hover:opacity-100">
            <MoreHorizontal size={14} />
          </button>
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content sideOffset={6} align="end" className={CONTENT}>
            <DropdownMenu.Item className={ITEM} onSelect={() => setRenaming(true)}>名前とアイコンを変更…</DropdownMenu.Item>
            <DropdownMenu.Item className={ITEM} disabled={index === 0} onSelect={() => void controller.moveSection(section.id, index - 1)}>上へ</DropdownMenu.Item>
            <DropdownMenu.Item className={ITEM} disabled={index === count - 1} onSelect={() => void controller.moveSection(section.id, index + 1)}>下へ</DropdownMenu.Item>
            <DropdownMenu.Item className={ITEM} onSelect={() => setCreating(true)}>新しいセクション…</DropdownMenu.Item>
            <DropdownMenu.Separator className="my-1 h-px bg-line" />
            <DropdownMenu.Item className={cn(ITEM, "text-danger")} onSelect={() => void controller.deleteSection(section.id)}>
              セクションを削除 (会話は元の場所へ)
            </DropdownMenu.Item>
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>
      {renaming && (
        <SectionDialog
          controller={controller}
          title="セクションを編集"
          submitLabel="保存"
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
      title="新しいセクション"
      submitLabel="作成"
      pickChannels
      onClose={onClose}
      onSubmit={(form) => controller.createSection(form.name, form.emoji, form.channelIds)}
    />
  );
}
