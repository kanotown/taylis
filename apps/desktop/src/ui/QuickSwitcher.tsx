import { Command } from "cmdk";
import { AtSign, FileText, Hash, Lock, Search } from "lucide-react";
import { Dialog } from "radix-ui";
import { useEffect, useState } from "react";

import type { CanvasMeta } from "../api/types";
import type { AppController } from "../state/app";
import type { ChannelState } from "../sync/types";
import { Avatar } from "./Avatar";
import { badgeCount, hasUnread, isDmChannel } from "./channels";
import { jumpConversations } from "./home";
import { channelTitle } from "./MainScreen";
import { Badge, Kbd } from "./primitives";

/**
 * Cmd/Ctrl+K: jump to a channel or DM by typing part of its name. M37: filtered and ordered by the shared jump-match rule
 * (apps/shared/jump-match.json, as the phones' 「移動・検索」), not cmdk's fuzzy matching; empty, unread first, then by name.
 */
export function QuickSwitcher({ controller, onOpen, onOpenCanvas, onClose }: {
  controller: AppController;
  onOpen: (id: string) => void;
  /** M44: canvases of my conversations whose title matches follow the conversations. */
  onOpenCanvas?: (canvas: CanvasMeta) => void;
  onClose: () => void;
}) {
  const store = controller.store;
  const me = store.me?.id;
  const [query, setQuery] = useState("");
  const [canvases, setCanvases] = useState<CanvasMeta[]>([]);
  useEffect(() => {
    if (!onOpenCanvas) return;
    let live = true;
    void controller.myCanvases(null, 200).then((page) => {
      if (live && page) setCanvases(page.items);
    });
    return () => {
      live = false;
    };
  }, [controller, !!onOpenCanvas]); // eslint-disable-line react-hooks/exhaustive-deps
  const needle = query.trim().normalize("NFKC").toLowerCase();
  const canvasHits = needle && onOpenCanvas ? canvases.filter((c) => c.title.normalize("NFKC").toLowerCase().includes(needle)).slice(0, 6) : [];
  const all = [...store.channels.values()];
  const channels: ChannelState[] = query.trim()
    ? jumpConversations(query, all, { users: store.users, meId: me ?? null, me: store.me ?? controller.me, title: (c) => channelTitle(c, controller).replace(/^#/, "") }, Number.POSITIVE_INFINITY)
    : all
        .filter((c) => c.isMember && !c.archived)
        .sort((a, b) => Number(hasUnread(b, me ?? null)) - Number(hasUnread(a, me ?? null)) || channelTitle(a, controller).localeCompare(channelTitle(b, controller), "ja"));

  return (
    <Dialog.Root open onOpenChange={(open) => { if (!open) onClose(); }}>
      <Dialog.Portal>
        <Dialog.Overlay className="rx-overlay fixed inset-0 z-40 bg-black/40 backdrop-blur-[2px]" />
        <Dialog.Content className="rx-drop fixed left-1/2 top-[14vh] z-50 w-[540px] max-w-[92vw] -translate-x-1/2 overflow-hidden rounded-2xl border border-line bg-canvas text-ink shadow-2xl focus:outline-none">
          <Dialog.Title className="sr-only">チャンネルに移動</Dialog.Title>
          <Dialog.Description className="sr-only">名前を入力して Enter で開きます</Dialog.Description>
          <Command label="チャンネルに移動" loop shouldFilter={false}>
            <div className="flex items-center gap-2.5 border-b border-line px-4">
              <Search size={16} className="shrink-0 text-muted" />
              <Command.Input autoFocus value={query} onValueChange={setQuery} placeholder={onOpenCanvas ? "チャンネル・相手・キャンバスの名前で移動…" : "チャンネルや相手の名前で移動…"} className="h-12 flex-1 bg-transparent text-sm text-ink outline-none placeholder:text-muted" />
              <Kbd>Esc</Kbd>
            </div>
            <Command.List className="max-h-[52vh] overflow-y-auto p-1.5">
              <Command.Empty className="px-3 py-8 text-center text-sm text-muted">該当なし</Command.Empty>
              {channels.map((channel) => {
                const title = channelTitle(channel, controller);
                const other = isDmChannel(channel) ? (channel.dm_user_ids ?? []).find((id) => id !== me) : undefined;
                const badge = badgeCount(channel);
                return (
                  <Command.Item
                    key={channel.id}
                    value={channel.id}
                    onSelect={() => onOpen(channel.id)}
                    className="flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm"
                  >
                    {isDmChannel(channel) ? (
                      other ? <Avatar id={other} name={store.users.get(other)?.display_name ?? "?"} size={22} className="rounded-md text-[10px]" /> : <AtSign size={16} className="text-muted" />
                    ) : channel.type === "private" ? (
                      <Lock size={16} className="text-muted" />
                    ) : (
                      <Hash size={16} className="text-muted" />
                    )}
                    <span className="flex-1 truncate">{title.replace(/^#/, "")}</span>
                    {channel.topic && !isDmChannel(channel) && <span className="max-w-[40%] truncate text-xs text-muted">{channel.topic}</span>}
                    {hasUnread(channel, me ?? null) && (badge > 0 ? <Badge tone="danger">{badge}</Badge> : <span className="h-2 w-2 rounded-full bg-accent" />)}
                  </Command.Item>
                );
              })}
              {canvasHits.length > 0 && (
                <Command.Group heading="キャンバス" className="[&_[cmdk-group-heading]]:px-2.5 [&_[cmdk-group-heading]]:pb-1 [&_[cmdk-group-heading]]:pt-2 [&_[cmdk-group-heading]]:text-[11px] [&_[cmdk-group-heading]]:font-semibold [&_[cmdk-group-heading]]:text-muted">
                  {canvasHits.map((canvas) => {
                    const channel = store.getChannel(canvas.channel_id);
                    return (
                      <Command.Item key={canvas.id} value={`canvas:${canvas.id}`} onSelect={() => onOpenCanvas?.(canvas)} className="flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm">
                        <FileText size={16} className="text-accent" />
                        <span className="flex-1 truncate">{canvas.title}</span>
                        <span className="max-w-[40%] truncate text-xs text-muted">{channel ? channelTitle(channel, controller) : ""}</span>
                      </Command.Item>
                    );
                  })}
                </Command.Group>
              )}
            </Command.List>
            <div className="flex items-center gap-3 border-t border-line px-4 py-2 text-[11px] text-muted">
              <span className="flex items-center gap-1"><Kbd>↑↓</Kbd> 選択</span>
              <span className="flex items-center gap-1"><Kbd>Enter</Kbd> 開く</span>
            </div>
          </Command>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
