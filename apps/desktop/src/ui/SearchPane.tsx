import { type FormEvent, useState } from "react";

import type { MessageOut, SearchFilters, SearchHit } from "../api/types";
import type { AppController } from "../state/app";
import { highlightPieces } from "./highlight";
import { channelTitle } from "./MainScreen";

/** The right pane: full-text search across my channels; clicking a hit opens its channel (and thread). */
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

  return (
    <aside className="thread-panel open search-panel">
      <header className="channel-header">
        <strong>検索</strong>
        <button className="link" onClick={onClose}>
          閉じる
        </button>
      </header>
      <form className="search-form" onSubmit={submit}>
        <input type="search" value={query} placeholder="メッセージを検索 (Enter)" onChange={(e) => setQuery(e.target.value)} autoFocus />
        <button type="submit" disabled={busy || !query.trim()}>
          検索
        </button>
      </form>
      <div className="muted search-hint">
        絞り込み: <code>from:@名前</code> <code>in:#チャンネル</code> <code>before:2026-09-01</code> <code>after:</code> <code>on:</code>
      </div>
      <div className="timeline">
        {filters && (filters.unresolved ?? []).length > 0 && (
          <div className="error search-warning">見つからない条件があります: {(filters.unresolved ?? []).join(" ")}</div>
        )}
        {filters && (filters.from_username || filters.in_channel || filters.after || filters.before) && (
          <div className="muted search-applied">
            {filters.from_username && <span className="chip">from: @{filters.from_username}</span>}
            {filters.in_channel && <span className="chip">in: #{filters.in_channel}</span>}
            {filters.after && <span className="chip">{new Date(filters.after).toLocaleDateString()} 以降</span>}
            {filters.before && <span className="chip">{new Date(filters.before).toLocaleDateString()} より前</span>}
          </div>
        )}
        {searched && hits.length === 0 && <div className="muted">見つかりませんでした</div>}
        {hits.map((hit) => {
          const message = hit.message;
          const channel = store.getChannel(message.channel_id);
          const text = message.body || message.attachments.map((a) => a.filename).join(", ");
          return (
            <article key={message.id} className="message search-hit" onClick={() => onOpen(message)}>
              <div className="meta">
                <strong>{channel ? channelTitle(channel, controller) : "?"}</strong>
                <span>{store.users.get(message.sender_id)?.display_name ?? "?"}</span>
                {message.parent_id && <span className="muted">スレッド</span>}
                <time>{new Date(message.created_at).toLocaleString()}</time>
              </div>
              <div className="body">
                {highlightPieces(text, keywords).map((piece, i) => (piece.hit ? <mark key={i}>{piece.text}</mark> : <span key={i}>{piece.text}</span>))}
              </div>
            </article>
          );
        })}
        {hasMore && (
          <button className="secondary" onClick={() => void run(hits.length)} disabled={busy}>
            さらに読み込む
          </button>
        )}
      </div>
    </aside>
  );
}
