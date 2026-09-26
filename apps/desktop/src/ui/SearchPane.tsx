import { type FormEvent, useState } from "react";

import type { SearchHit } from "../api/types";
import type { AppController } from "../state/app";
import { highlightPieces } from "./highlight";
import { channelTitle } from "./MainScreen";

/** The right pane: full-text search across my channels; clicking a hit opens its channel (and thread). */
export function SearchPane({ controller, onOpen, onClose }: { controller: AppController; onOpen: (channelId: string, parentId: string | null) => void; onClose: () => void }) {
  const store = controller.store;
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [keywords, setKeywords] = useState<string[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [searched, setSearched] = useState(false);
  const [busy, setBusy] = useState(false);

  const run = async (offset = 0) => {
    const q = query.trim();
    if (!q || !controller.api) return;
    setBusy(true);
    try {
      const result = await controller.api.searchMessages(q, { offset });
      setHits(offset === 0 ? result.hits : [...hits, ...result.hits]);
      setKeywords(result.keywords);
      setHasMore(result.has_more);
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
      <div className="timeline">
        {searched && hits.length === 0 && <div className="muted">見つかりませんでした</div>}
        {hits.map((hit) => {
          const message = hit.message;
          const channel = store.getChannel(message.channel_id);
          const text = message.body || message.attachments.map((a) => a.filename).join(", ");
          return (
            <article key={message.id} className="message search-hit" onClick={() => onOpen(message.channel_id, message.parent_id ?? null)}>
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
