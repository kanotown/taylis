import { ContextMenu } from "radix-ui";
import { Link2, Plus } from "lucide-react";
import { type FormEvent, useState } from "react";

import type { ChannelLinkOut } from "../api/types";
import { openExternalLink } from "../platform/external";
import type { AppController } from "../state/app";
import type { ChannelState } from "../sync/types";
import { canPostTopLevel } from "./channels";
import { Button, cn, Input, Modal } from "./primitives";

const CONTENT = "rx-popover z-50 min-w-52 rounded-xl border border-line bg-canvas p-1 text-ink shadow-xl";
const ITEM = "flex select-none items-center gap-2 rounded-lg px-2.5 py-1.5 text-sm outline-none data-[disabled]:opacity-50 data-[highlighted]:bg-accent-soft";

/** M15f: whether I may change this conversation's links (the server says the same). */
export function canEditLinks(channel: ChannelState, controller: AppController): boolean {
  return channel.isMember && !channel.archived && !controller.isGuest && canPostTopLevel(channel, controller.isAdmin);
}

/** Only http(s) links (the server refuses the rest). */
export function validLinkUrl(url: string): boolean {
  try {
    const parsed = new URL(url.trim());
    return (parsed.protocol === "http:" || parsed.protocol === "https:") && parsed.host !== "" && !/\s/.test(url.trim());
  } catch {
    return false;
  }
}

/** M15f: the conversation's pinned links under its header (Slack's bookmarks bar). */
export function ChannelLinksBar({ controller, channel, onAdd, onEdit }: {
  controller: AppController;
  channel: ChannelState;
  onAdd: () => void;
  onEdit: (link: ChannelLinkOut) => void;
}) {
  if (controller.store.linksOf(channel.id).length === 0) return null;
  return (
    <div className="flex items-center gap-1 overflow-x-auto border-b border-line px-3 py-1" aria-label="リンク">
      <ChannelLinkChips controller={controller} channel={channel} onAdd={onAdd} onEdit={onEdit} />
    </div>
  );
}

/** The link chips and 「＋ リンク」 (for those who may edit them): in the bar, or after the tabs on a phone (M29). */
export function ChannelLinkChips({ controller, channel, onAdd, onEdit }: {
  controller: AppController;
  channel: ChannelState;
  onAdd: () => void;
  onEdit: (link: ChannelLinkOut) => void;
}) {
  const links = controller.store.linksOf(channel.id);
  const editable = canEditLinks(channel, controller);
  return (
    <>
      {links.map((link, index) => {
        const chip = (
          <a
            href={link.url}
            target="_blank"
            rel="noreferrer noopener"
            title={link.url}
            onClick={(event) => openExternalLink(event, link.url)}
            className="inline-flex max-w-[240px] shrink-0 items-center gap-1.5 rounded-md px-2 py-1 text-xs text-ink hover:bg-panel"
          >
            <Link2 size={13} className="shrink-0 text-muted" />
            <span className="truncate">{link.title}</span>
          </a>
        );
        if (!editable) return <span key={link.id}>{chip}</span>;
        return (
          <ContextMenu.Root key={link.id}>
            <ContextMenu.Trigger asChild>{chip}</ContextMenu.Trigger>
            <ContextMenu.Portal>
              <ContextMenu.Content className={CONTENT}>
                <ContextMenu.Item className={ITEM} onSelect={() => onEdit(link)}>編集…</ContextMenu.Item>
                <ContextMenu.Item className={ITEM} disabled={index === 0} onSelect={() => void controller.updateChannelLink(channel.id, link.id, { position: index - 1 })}>左へ移動</ContextMenu.Item>
                <ContextMenu.Item className={ITEM} disabled={index === links.length - 1} onSelect={() => void controller.updateChannelLink(channel.id, link.id, { position: index + 1 })}>右へ移動</ContextMenu.Item>
                <ContextMenu.Separator className="my-1 h-px bg-line" />
                <ContextMenu.Item className={cn(ITEM, "text-danger")} onSelect={() => void controller.deleteChannelLink(channel.id, link.id)}>削除</ContextMenu.Item>
              </ContextMenu.Content>
            </ContextMenu.Portal>
          </ContextMenu.Root>
        );
      })}
      {editable && (
        <button type="button" className="inline-flex shrink-0 items-center gap-1 rounded-md px-2 py-1 text-xs text-muted hover:bg-panel hover:text-ink" onClick={onAdd}>
          <Plus size={13} /> リンク
        </button>
      )}
    </>
  );
}

/** Add a link, or edit one (title and URL). */
export function ChannelLinkDialog({ controller, channel, link, onClose }: {
  controller: AppController;
  channel: ChannelState;
  link: ChannelLinkOut | null;
  onClose: () => void;
}) {
  const [title, setTitle] = useState(link?.title ?? "");
  const [url, setUrl] = useState(link?.url ?? "");
  const [busy, setBusy] = useState(false);
  const urlOk = validLinkUrl(url);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!urlOk || !title.trim()) return;
    setBusy(true);
    const ok = link
      ? await controller.updateChannelLink(channel.id, link.id, { title: title.trim(), url: url.trim() })
      : await controller.addChannelLink(channel.id, title.trim(), url.trim());
    setBusy(false);
    if (ok) onClose();
  };
  return (
    <Modal onClose={onClose} title={link ? "リンクを編集" : "リンクを追加"} className="w-[440px]">
      <form className="mt-4 space-y-3" onSubmit={(e) => void submit(e)}>
        <label className="block text-xs font-semibold text-muted">
          URL
          <Input className="mt-1" value={url} autoFocus={!link} required placeholder="https://" onChange={(e) => setUrl(e.target.value)} />
        </label>
        {url.trim() !== "" && !urlOk && <p className="text-xs text-danger">http:// か https:// で始まる URL を入れてください</p>}
        <label className="block text-xs font-semibold text-muted">
          名前
          <Input className="mt-1" value={title} maxLength={80} required placeholder="例: デザイン資料" onChange={(e) => setTitle(e.target.value)} />
        </label>
        <div className="flex justify-end gap-2 pt-1">
          <Button type="button" variant="secondary" onClick={onClose}>キャンセル</Button>
          <Button type="submit" disabled={busy || !urlOk || !title.trim()}>{link ? "保存" : "追加"}</Button>
        </div>
      </form>
    </Modal>
  );
}
