import { Download, FileText, Files, Search } from "lucide-react";
import { useEffect, useState } from "react";

import type { FileItem, MessageOut } from "../api/types";
import type { AppController } from "../state/app";
import type { ChannelState } from "../sync/types";
import { formatSize, useAttachmentUrl } from "./Attachments";
import { fullTimestamp } from "./format";
import { channelTitle } from "./MainScreen";
import { BackButton } from "./compact";
import { Button, cn, IconButton, Input } from "./primitives";
import { t } from "../i18n";

/** Attachments in my channels (or one channel), newest first, filtered by file name; pages of 50. */
function useFileItems(controller: AppController, channelId: string | null, query: string) {
  const [items, setItems] = useState<FileItem[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const load = async (more = false) => {
    if (!controller.api) return;
    try {
      const page = await controller.api.listFiles({ channelId, q: query.trim() || null, cursor: more ? cursor : null, limit: 50 });
      setItems((current) => (more && current ? [...current, ...page.items] : page.items));
      setCursor(page.next_cursor ?? null);
    } catch (error) {
      controller.setError(error);
    }
  };
  useEffect(() => {
    const timer = setTimeout(() => void load(), query ? 250 : 0);
    return () => clearTimeout(timer);
  }, [controller.api, channelId, query, controller.engine?.status]);
  return { items, cursor, loadMore: () => void load(true) };
}

function FileItemsList({ controller, items, cursor, onMore, empty, onOpen }: {
  controller: AppController;
  items: FileItem[] | null;
  cursor: string | null;
  onMore: () => void;
  empty: string;
  onOpen: (message: MessageOut) => void;
}) {
  return (
    <div data-scroll-memory className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
      {items === null ? (
        <div className="py-8 text-center text-sm text-muted">{t("common.loading")}</div>
      ) : items.length === 0 ? (
        <div className="py-16 text-center text-sm text-muted">{empty}</div>
      ) : (
        <ul className="mx-auto max-w-3xl divide-y divide-line rounded-xl border border-line">
          {items.map((item) => <FileRow key={item.attachment.id} item={item} controller={controller} onOpen={onOpen} />)}
          {cursor && (
            <li className="py-2 text-center">
              <Button variant="secondary" size="sm" onClick={onMore}>{t("canvasHistory.loadMore")}</Button>
            </li>
          )}
        </ul>
      )}
    </div>
  );
}

function FileFilter({ query, onChange, className }: { query: string; onChange: (query: string) => void; className?: string }) {
  return (
    <div className={cn("relative", className)}>
      <Search size={14} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted" />
      <Input value={query} placeholder={t("files.filter")} className="h-8 pl-8 text-sm" onChange={(e) => onChange(e.target.value)} />
    </div>
  );
}

/** 「ファイル」 (M11i): attachments in my channels (or one channel), newest first; a row reveals its message. */
export function FilesView({ controller, channelId, onChannelChange, onOpen }: {
  controller: AppController;
  /** null: every channel I belong to. */
  channelId: string | null;
  onChannelChange: (channelId: string | null) => void;
  onOpen: (message: MessageOut) => void;
}) {
  const store = controller.store;
  const [query, setQuery] = useState("");
  const { items, cursor, loadMore } = useFileItems(controller, channelId, query);
  const channels = [...store.channels.values()].filter((c) => c.isMember).sort((a, b) => channelTitle(a, controller).localeCompare(channelTitle(b, controller)));
  const scope = channelId ? store.getChannel(channelId) : null;
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex h-[52px] items-center gap-3 border-b border-line px-4 max-md:h-auto max-md:flex-wrap max-md:gap-x-2 max-md:gap-y-2 max-md:py-2">
        <BackButton />
        <span className="text-muted max-md:hidden"><Files size={18} /></span>
        <strong className="shrink-0 whitespace-nowrap text-[15px]">{t("nav.files")}</strong>
        <select
          aria-label={t("search.channel")}
          className="h-8 rounded-lg border border-line bg-panel px-2 text-sm max-md:min-w-0 max-md:flex-1"
          value={channelId ?? ""}
          onChange={(e) => onChannelChange(e.target.value || null)}
        >
          <option value="">{t("files.allChannels")}</option>
          {channels.map((c) => <option key={c.id} value={c.id}>{channelTitle(c, controller)}</option>)}
        </select>
        <FileFilter query={query} onChange={setQuery} className="ml-auto w-64 max-md:ml-0 max-md:w-full" />
      </header>
      <FileItemsList
        controller={controller}
        items={items}
        cursor={cursor}
        onMore={loadMore}
        empty={query ? t("workflow.notFound") : scope ? t("files.noneIn", { name: channelTitle(scope, controller) }) : t("files.none")}
        onOpen={onOpen}
      />
    </div>
  );
}

/** M29: a conversation's 「ファイル」 tab on a phone: this channel only (no channel choice), with the name filter. */
export function ChannelFiles({ controller, channel, onOpen }: { controller: AppController; channel: ChannelState; onOpen: (message: MessageOut) => void }) {
  const [query, setQuery] = useState("");
  const { items, cursor, loadMore } = useFileItems(controller, channel.id, query);
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="shrink-0 border-b border-line px-4 py-2">
        <FileFilter query={query} onChange={setQuery} />
      </div>
      <FileItemsList
        controller={controller}
        items={items}
        cursor={cursor}
        onMore={loadMore}
        empty={query ? t("workflow.notFound") : t("files.noneIn", { name: channelTitle(channel, controller) })}
        onOpen={onOpen}
      />
    </div>
  );
}

export function FileRow({ item, controller, onOpen }: { item: FileItem; controller: AppController; onOpen: (message: MessageOut) => void }) {
  const store = controller.store;
  const { attachment } = item;
  const url = useAttachmentUrl(controller, attachment, "thumbnail", attachment.has_thumbnail || attachment.has_poster === true);
  const channel = store.getChannel(item.channel_id);
  const uploader = store.users.get(item.uploader_id)?.display_name ?? "?";
  const reveal = () => onOpen({ id: item.message_id, channel_id: item.channel_id, parent_id: item.parent_id ?? null } as MessageOut);
  return (
    <li data-row-key={attachment.id} className="flex items-center gap-3 px-3 py-2.5">
      <button type="button" className="flex min-w-0 flex-1 items-center gap-3 text-left" title={t("files.showMessage")} onClick={reveal}>
        <span className="flex h-12 w-12 shrink-0 items-center justify-center overflow-hidden rounded-lg border border-line bg-panel">
          {url ? <img src={url} alt="" className="h-full w-full object-cover" /> : <FileText size={20} className="text-muted" />}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium text-ink">{attachment.filename}</span>
          <span className="block truncate text-xs text-muted">
            {formatSize(attachment.size_bytes)} · {uploader} · {channel ? channelTitle(channel, controller) : "?"} · {fullTimestamp(item.attached_at)}
          </span>
        </span>
      </button>
      <IconButton label={t("attach.download")} onClick={() => void controller.downloadAttachment(attachment)}>
        <Download size={16} />
      </IconButton>
    </li>
  );
}
