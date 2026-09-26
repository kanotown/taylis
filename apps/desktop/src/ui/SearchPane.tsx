import { AlertTriangle, Search, X } from "lucide-react";
import { type FormEvent, useState } from "react";

import type { MessageOut, SearchFilters, SearchHit } from "../api/types";
import type { AppController } from "../state/app";
import { Avatar } from "./Avatar";
import { fullTimestamp } from "./format";
import { highlightPieces } from "./highlight";
import { channelTitle } from "./MainScreen";
import { Badge, Button, IconButton, Input } from "./primitives";

/** The right pane: full-text search across my channels; clicking a hit reveals it in its conversation. */
export function SearchPane({ controller, onOpen, onClose }: { controller: AppController; onOpen: (message: MessageOut) => void; onClose: () => void }) {
  const store = controller.store;
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [keywords, setKeywords] = useState<string[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [searched, setSearched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [filters, setFilters] = useState<SearchFilters | null>(null);

  const run = async (offset = 0) => {
    const q = query.trim();
    if (!q || !controller.api) return;
    setBusy(true);
    try {
      const result = await controller.api.searchMessages(q, { offset });
      setHits(offset === 0 ? result.hits : [...hits, ...result.hits]);
      setKeywords(result.keywords);
      setHasMore(result.has_more);
      setFilters(result.filters);
      setSearched(true);
    } catch (error) {
      controller.setError(error);
    } finally {
      setBusy(false);
    }
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    void run(0);
  };
  const unresolved = filters?.unresolved ?? [];
  const applied = filters && (filters.from_username || filters.in_channel || filters.after || filters.before);

  return (
    <aside className="flex min-h-0 w-[400px] min-w-[340px] flex-col border-l border-line bg-canvas">
      <header className="flex h-[52px] items-center gap-2 border-b border-line px-4">
        <div className="flex-1 text-sm font-semibold">検索</div>
        <IconButton label="閉じる (Esc)" onClick={onClose}>
          <X size={18} />
        </IconButton>
      </header>
      <form className="flex items-center gap-2 px-3 pt-3" onSubmit={submit}>
        <div className="relative flex-1">
          <Search size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
          <Input type="search" value={query} placeholder="メッセージを検索" className="pl-9" onChange={(e) => setQuery(e.target.value)} autoFocus />
        </div>
        <Button type="submit" disabled={busy || !query.trim()}>
          検索
        </Button>
      </form>
      <div className="flex flex-wrap items-center gap-1 px-3 pb-2 pt-2 text-[11px] text-muted">
        絞り込み:
        {["from:@名前", "in:#チャンネル", "before:2026-09-01", "after:", "on:"].map((m) => (
          <code key={m} className="rounded bg-panel-2 px-1.5 py-0.5">{m}</code>
        ))}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-3">
        {unresolved.length > 0 && (
          <div className="mb-2 flex items-start gap-2 rounded-lg bg-danger/10 px-3 py-2 text-xs text-danger">
            <AlertTriangle size={14} className="mt-0.5 shrink-0" />
            <span>見つからない条件があります: {unresolved.join(" ")}</span>
          </div>
        )}
        {applied && filters && (
          <div className="mb-2 flex flex-wrap gap-1">
            {filters.from_username && <Badge tone="accent">from: @{filters.from_username}</Badge>}
            {filters.in_channel && <Badge tone="accent">in: #{filters.in_channel}</Badge>}
            {filters.after && <Badge tone="accent">{new Date(filters.after).toLocaleDateString()} 以降</Badge>}
            {filters.before && <Badge tone="accent">{new Date(filters.before).toLocaleDateString()} より前</Badge>}
          </div>
        )}
        {searched && hits.length === 0 && <div className="py-8 text-center text-sm text-muted">見つかりませんでした</div>}
        <div className="space-y-1">
          {hits.map((hit) => {
            const message = hit.message;
            const channel = store.getChannel(message.channel_id);
            const text = message.body || message.attachments.map((a) => a.filename).join(", ");
            const sender = store.users.get(message.sender_id)?.display_name ?? "?";
            return (
              <button
                key={message.id}
                type="button"
                className="block w-full rounded-xl border border-transparent px-3 py-2 text-left transition-colors hover:border-line hover:bg-panel"
                onClick={() => onOpen(message)}
              >
                <div className="flex items-center gap-2 text-xs text-muted">
                  <Avatar id={message.sender_id} name={sender} size={18} className="rounded-md text-[9px]" />
                  <span className="font-medium text-ink">{sender}</span>
                  <span className="truncate">{channel ? channelTitle(channel, controller) : "?"}</span>
                  {message.parent_id && <Badge>スレッド</Badge>}
                  <time className="ml-auto shrink-0">{fullTimestamp(message.created_at)}</time>
                </div>
                <div className="mt-1 line-clamp-4 text-sm text-ink">
                  {highlightPieces(text, keywords).map((piece, i) => (piece.hit ? <mark key={i}>{piece.text}</mark> : <span key={i}>{piece.text}</span>))}
                </div>
              </button>
            );
          })}
        </div>
        {hasMore && (
          <div className="py-2 text-center">
            <Button variant="secondary" size="sm" onClick={() => void run(hits.length)} disabled={busy}>
              さらに読み込む
            </Button>
          </div>
        )}
      </div>
    </aside>
  );
}
