import { ContextMenu, DropdownMenu } from "radix-ui";
import { MoreHorizontal } from "lucide-react";
import { type FormEvent, type ReactNode, useState } from "react";

import type { SidebarSectionOut } from "../api/types";
import type { AppController } from "../state/app";
import type { ChannelState } from "../sync/types";
import { Button, cn, Input, Modal } from "./primitives";

const CONTENT = "rx-popover z-50 min-w-52 rounded-xl border border-line bg-canvas p-1 text-ink shadow-xl";
const ITEM = "flex select-none items-center gap-2 rounded-lg px-2.5 py-1.5 text-sm outline-none data-[disabled]:opacity-50 data-[highlighted]:bg-accent-soft";

/** Right-click on a sidebar row (M14f): star it, or move it into one of my sections. */
export function ChannelContextMenu({ controller, channel, children }: { controller: AppController; channel: ChannelState; children: ReactNode }) {
  const store = controller.store;
  const sections = store.sidebarSections;
  const current = store.sectionOf(channel.id);
  const [naming, setNaming] = useState(false);
  const starred = store.isFavorite(channel.id);
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
          </ContextMenu.Content>
        </ContextMenu.Portal>
      </ContextMenu.Root>
      {naming && (
        <SectionNameDialog
          title="新しいセクション"
          submitLabel="作成して移動"
          onClose={() => setNaming(false)}
          onSubmit={async (name) => {
            const ok = await controller.createSection(name, channel.id);
            if (ok) setNaming(false);
          }}
        />
      )}
    </>
  );
}

/** The 「…」 on a custom section's header: rename, move up / down, delete. */
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
            <DropdownMenu.Item className={ITEM} onSelect={() => setRenaming(true)}>名前を変更</DropdownMenu.Item>
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
        <SectionNameDialog
          title="セクション名を変更"
          initial={section.name}
          submitLabel="保存"
          onClose={() => setRenaming(false)}
          onSubmit={async (name) => {
            if (await controller.renameSection(section.id, name)) setRenaming(false);
          }}
        />
      )}
      {creating && (
        <SectionNameDialog
          title="新しいセクション"
          submitLabel="作成"
          onClose={() => setCreating(false)}
          onSubmit={async (name) => {
            if (await controller.createSection(name, null)) setCreating(false);
          }}
        />
      )}
    </>
  );
}

function SectionNameDialog({ title, initial = "", submitLabel, onClose, onSubmit }: { title: string; initial?: string; submitLabel: string; onClose: () => void; onSubmit: (name: string) => Promise<void> }) {
  const [name, setName] = useState(initial);
  const [busy, setBusy] = useState(false);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    await onSubmit(name.trim());
    setBusy(false);
  };
  return (
    <Modal onClose={onClose} title={title} className="w-[400px]">
      <form className="mt-4 space-y-4" onSubmit={(e) => void submit(e)}>
        <Input value={name} maxLength={40} required autoFocus placeholder="例: プロジェクト、チーム" onChange={(e) => setName(e.target.value)} />
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose}>キャンセル</Button>
          <Button type="submit" disabled={busy || !name.trim()}>{submitLabel}</Button>
        </div>
      </form>
    </Modal>
  );
}
