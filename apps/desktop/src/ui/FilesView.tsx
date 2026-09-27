import { Download, FileText, Files, Search } from "lucide-react";
import { useEffect, useState } from "react";

import type { FileItem, MessageOut } from "../api/types";
import type { AppController } from "../state/app";
import { formatSize, useAttachmentUrl } from "./Attachments";
import { fullTimestamp } from "./format";
import { channelTitle } from "./MainScreen";
import { Button, IconButton, Input } from "./primitives";

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
  const channels = [...store.channels.values()].filter((c) => c.isMember).sort((a, b) => channelTitle(a, controller).localeCompare(channelTitle(b, controller)));
  const scope = channelId ? store.getChannel(channelId) : null;
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex h-[52px] items-center gap-3 border-b border-line px-4">
        <span className="text-muted"><Files size={18} /></span>
        <strong className="text-[15px]">ファイル</strong>
        <select
          aria-label="チャンネル"
          className="h-8 rounded-lg border border-line bg-panel px-2 text-sm"
          value={channelId ?? ""}
          onChange={(e) => onChannelChange(e.target.value || null)}
        >
          <option value="">すべてのチャンネル</option>
          {channels.map((c) => <option key={c.id} value={c.id}>{channelTitle(c, controller)}</option>)}
        </select>
        <div className="relative ml-auto w-64">
          <Search size={14} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted" />
          <Input value={query} placeholder="ファイル名で絞り込む" className="h-8 pl-8 text-sm" onChange={(e) => setQuery(e.target.value)} />
        </div>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
        {items === null ? (
          <div className="py-8 text-center text-sm text-muted">読み込み中…</div>
        ) : items.length === 0 ? (
          <div className="py-16 text-center text-sm text-muted">{query ? "見つかりません" : scope ? `${channelTitle(scope, controller)} にはまだファイルがありません` : "まだファイルはありません"}</div>
        ) : (
          <ul className="mx-auto max-w-3xl divide-y divide-line rounded-xl border border-line">
            {items.map((item) => <FileRow key={item.attachment.id} item={item} controller={controller} onOpen={onOpen} />)}
            {cursor && (
              <li className="py-2 text-center">
                <Button variant="secondary" size="sm" onClick={() => void load(true)}>さらに読み込む</Button>
              </li>
            )}
          </ul>
        )}
      </div>
    </div>
  );
}

export function FileRow({ item, controller, onOpen }: { item: FileItem; controller: AppController; onOpen: (message: MessageOut) => void }) {
  const store = controller.store;
  const { attachment } = item;
  const url = useAttachmentUrl(controller, attachment, "thumbnail", attachment.has_thumbnail);
  const channel = store.getChannel(item.channel_id);
  const uploader = store.users.get(item.uploader_id)?.display_name ?? "?";
  const reveal = () => onOpen({ id: item.message_id, channel_id: item.channel_id, parent_id: item.parent_id ?? null } as MessageOut);
  return (
    <li className="flex items-center gap-3 px-3 py-2.5">
      <button type="button" className="flex min-w-0 flex-1 items-center gap-3 text-left" title="メッセージを表示" onClick={reveal}>
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
      <IconButton label="ダウンロード" onClick={() => void controller.downloadAttachment(attachment)}>
        <Download size={16} />
      </IconButton>
    </li>
  );
}
