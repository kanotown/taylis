/**
 * M44 (CANVAS.md §4.8): the search's 「キャンバス」 tab — canvases of my conversations whose title or body matches
 * (`GET /search/canvases`). The words and typed modifiers (`in:#会話`, `from:@人` = its creator or last editor,
 * `before:` / `after:` / `on:` = when it was updated) are the message search's; the chips add the same filters. A hit
 * shows the server's plain-text excerpt with the words marked, and opens the canvas in its conversation.
 */
import { AlertTriangle, FileText, SearchX } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import type { CanvasMeta, CanvasSearchHit } from "../api/types";
import type { AppController } from "../state/app";
import { taskProgress } from "./canvasText";
import { sinceLabel } from "./format";
import { highlightPieces } from "./highlight";
import { channelTitle } from "./MainScreen";
import { mentionsToNames } from "./mentions";
import { Button } from "./primitives";
import { dateRange, type SearchParams, totalLabel } from "./search";

const PAGE = 20;

/** The canvas search's parameters: the message search's words, person, conversation, dates and order. */
export function canvasQuery(params: SearchParams, now: Date = new Date()) {
  const q = params.q.trim();
  return { q, channel_id: params.channelId, from_user_id: params.fromUserId, ...dateRange(params.date, now), sort: q ? params.sort : ("newest" as const) };
}

/** The server's excerpt is the body's plain text: an image reference reads as 「[画像]」 instead of its id. */
export function readableSnippet(snippet: string): string {
  return snippet.replace(/!\[([^\]\n]*)\]\(attachment:[0-9a-fA-F-]*\)?/g, (_, alt: string) => (alt ? `[画像: ${alt}]` : "[画像]"));
}

export function CanvasResults({ controller, params, onOpen }: { controller: AppController; params: SearchParams; onOpen: (canvas: CanvasMeta) => void }) {
  const [hits, setHits] = useState<CanvasSearchHit[]>([]);
  const [keywords, setKeywords] = useState<string[]>([]);
  const [total, setTotal] = useState(0);
  const [capped, setCapped] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [unresolved, setUnresolved] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const request = useRef(0);
  const query = canvasQuery(params);
  const empty = !query.q && !query.channel_id && !query.from_user_id && !query.after && !query.before;
  const key = JSON.stringify(query);

  const run = async (offset: number) => {
    const api = controller.api;
    if (!api || empty) return;
    const id = ++request.current;
    setLoading(true);
    try {
      const result = await api.searchCanvases({ ...query, limit: PAGE, offset });
      if (id !== request.current) return;
      setHits((current) => (offset === 0 ? result.hits : [...current, ...result.hits]));
      setKeywords(result.keywords);
      setTotal(result.total ?? 0);
      setCapped(result.total_capped ?? false);
      setHasMore(result.has_more);
      setUnresolved(result.filters.unresolved ?? []);
      setLoaded(true);
    } catch (error) {
      if (id === request.current) controller.setError(error);
    } finally {
      if (id === request.current) setLoading(false);
    }
  };
  useEffect(() => {
    setHits([]);
    setLoaded(false);
    void run(0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, controller.api]);

  const store = controller.store;
  const mark = (text: string) => highlightPieces(text, keywords).map((piece, i) => (piece.hit ? <mark key={i} className="rounded bg-warning/35 px-0.5 text-ink">{piece.text}</mark> : <span key={i}>{piece.text}</span>));
  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3" aria-label="キャンバスの検索結果">
      {empty ? (
        <div className="py-16 text-center text-sm text-muted">語を入れると、キャンバスの題名と本文から探します。</div>
      ) : (
        <>
          {unresolved.length > 0 && (
            <div className="mb-3 flex max-w-3xl items-start gap-2 rounded-lg bg-danger/10 px-3 py-2 text-xs text-danger">
              <AlertTriangle size={14} className="mt-0.5 shrink-0" />
              <span>キャンバスには使えない条件があります: {unresolved.join(" ")}</span>
            </div>
          )}
          {loaded && <div className="mb-2 max-w-3xl text-xs text-muted">{totalLabel(total, capped)}</div>}
          {loaded && hits.length === 0 ? (
            <div className="mx-auto flex max-w-md flex-col items-center py-16 text-center">
              <SearchX size={40} className="text-muted/60" />
              <div className="mt-3 text-base font-semibold">キャンバスは見つかりませんでした</div>
              <p className="mt-1 text-sm text-muted">自分が参加している会話のキャンバスを、題名と本文から探します。</p>
            </div>
          ) : (
            <ul className="max-w-3xl space-y-1">
              {hits.map(({ canvas, snippet }) => {
                const channel = store.getChannel(canvas.channel_id);
                const progress = taskProgress(canvas.task_total, canvas.task_done);
                return (
                  <li key={canvas.id}>
                    <button
                      type="button"
                      data-result
                      data-canvas-hit={canvas.id}
                      className="group block w-full rounded-xl border border-transparent px-3 py-2.5 text-left transition-colors hover:border-line hover:bg-panel focus-visible:border-accent focus-visible:bg-panel focus-visible:outline-none"
                      onClick={() => onOpen(canvas)}
                    >
                      <div className="flex items-center gap-2 text-xs text-muted">
                        <span className="min-w-0 truncate font-medium">{channel ? channelTitle(channel, controller) : "会話"}</span>
                        <span className="shrink-0">· {store.users.get(canvas.updated_by)?.display_name ?? "メンバー"}</span>
                        <time className="ml-auto shrink-0">{sinceLabel(canvas.updated_at)}</time>
                      </div>
                      <div className="mt-1 flex items-start gap-2.5">
                        <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-accent-soft text-accent"><FileText size={16} /></span>
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2">
                            <span className="truncate text-sm font-semibold text-ink">{mark(canvas.title)}</span>
                            {progress && <span className="shrink-0 text-[11px] text-muted">{progress}</span>}
                          </div>
                          {snippet && <div className="line-clamp-3 whitespace-pre-wrap break-words text-sm text-ink/90">{mark(readableSnippet(mentionsToNames(snippet, store.users, store.groups)))}</div>}
                        </div>
                        <span className="self-center whitespace-nowrap text-xs text-accent opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100">キャンバスを開く</span>
                      </div>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
          {loading && <div className="py-4 text-center text-sm text-muted">{hits.length ? "続きを読み込んでいます…" : "検索しています…"}</div>}
          {hasMore && !loading && (
            <div className="max-w-3xl py-2 text-center">
              <Button variant="secondary" size="sm" onClick={() => void run(hits.length)}>さらに表示</Button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
