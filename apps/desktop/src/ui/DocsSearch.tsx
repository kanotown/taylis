/**
 * M121 (WIKI.md §8.1): the search's 「ドキュメント」 tab — Docs pages I can read whose title or body matches
 * (`GET /search/pages`). The words and typed modifiers are the message search's (`from:@人` = its creator or last editor,
 * `before:` / `after:` / `on:` = when it was updated) plus `in:ページの題名` (that page and the pages below it); the chips
 * add the person and the period, the picker here a page to search under. A hit shows the server's excerpt with the
 * words marked and opens the page.
 */
import { AlertTriangle, SearchX } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import type { PageItem, PageSearchHit } from "../api/types";
import type { AppController } from "../state/app";
import { readableSnippet } from "./CanvasSearch";
import { pageTitle } from "./docsActions";
import { useWikiHub } from "./DocsTree";
import { sinceLabel } from "./format";
import { marked } from "./marked";
import { mentionsToNames } from "./mentions";
import { PageIcon } from "./PageIcon";
import { Button } from "./primitives";
import { dateRange, type SearchParams, totalLabel } from "./search";
import { t } from "../i18n";

const PAGE = 20;

/** The page search's parameters: the words, person, period and order of the search, and a page to search under. */
export function pageQuery(params: SearchParams, inPage: string | null, now: Date = new Date()) {
  const q = params.q.trim();
  return { q, in_page: inPage, from_user_id: params.fromUserId, ...dateRange(params.date, now), sort: q ? params.sort : ("newest" as const) };
}

export function PageResults({ controller, params, onOpen }: { controller: AppController; params: SearchParams; onOpen: (page: PageItem) => void }) {
  const hub = useWikiHub(controller);
  const [inPage, setInPage] = useState<string | null>(null);
  const [hits, setHits] = useState<PageSearchHit[]>([]);
  const [keywords, setKeywords] = useState<string[]>([]);
  const [total, setTotal] = useState(0);
  const [capped, setCapped] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [unresolved, setUnresolved] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const request = useRef(0);
  const query = pageQuery(params, inPage);
  const empty = !query.q && !query.in_page && !query.from_user_id && !query.after && !query.before;
  const key = JSON.stringify(query);

  const run = async (offset: number) => {
    const api = controller.api;
    if (!api || empty) return;
    const id = ++request.current;
    setLoading(true);
    try {
      const result = await api.searchWikiPages({ ...query, limit: PAGE, offset });
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
  const pages = hub ? [...hub.pages.values()].sort((a, b) => pageTitle(a, "").localeCompare(pageTitle(b, ""))) : [];
  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3" aria-label={t("docs.search.results")}>
      <label className="mb-3 flex max-w-3xl items-center gap-2 text-xs text-muted">
        <span className="shrink-0">{t("docs.search.under")}</span>
        <select aria-label={t("docs.search.under")} className="h-7 min-w-0 max-w-xs rounded-lg border border-line bg-canvas px-2 text-xs text-ink" value={inPage ?? ""} onChange={(event) => setInPage(event.target.value || null)}>
          <option value="">{t("docs.search.everywhere")}</option>
          {pages.map((page) => <option key={page.id} value={page.id}>{pageTitle(page, t("docs.untitled"))}</option>)}
        </select>
      </label>
      {empty ? (
        <div className="py-16 text-center text-sm text-muted">{t("docs.search.hint")}</div>
      ) : (
        <>
          {unresolved.length > 0 && (
            <div className="mb-3 flex max-w-3xl items-start gap-2 rounded-lg bg-danger/10 px-3 py-2 text-xs text-danger">
              <AlertTriangle size={14} className="mt-0.5 shrink-0" />
              <span>{t("canvasSearch.unresolved", { items: unresolved.join(" ") })}</span>
            </div>
          )}
          {loaded && <div className="mb-2 max-w-3xl text-xs text-muted">{totalLabel(total, capped)}</div>}
          {loaded && hits.length === 0 ? (
            <div className="mx-auto flex max-w-md flex-col items-center py-16 text-center">
              <SearchX size={40} className="text-muted/60" />
              <div className="mt-3 text-base font-semibold">{t("docs.search.none")}</div>
              <p className="mt-1 text-sm text-muted">{t("docs.search.scope")}</p>
            </div>
          ) : (
            <ul className="max-w-3xl space-y-1">
              {hits.map(({ page, snippet }) => (
                <li key={page.id}>
                  <button
                    type="button"
                    data-result
                    data-page-hit={page.id}
                    className="group block w-full rounded-xl border border-transparent px-3 py-2.5 text-left transition-colors hover:border-line hover:bg-panel focus-visible:border-accent focus-visible:bg-panel focus-visible:outline-none"
                    onClick={() => onOpen(page)}
                  >
                    <div className="flex items-center gap-2 text-xs text-muted">
                      <span className="min-w-0 truncate font-medium">{t("nav.docs")}</span>
                      <span className="shrink-0">· {store.users.get(page.updated_by)?.display_name ?? t("common.member")}</span>
                      <time className="ml-auto shrink-0">{sinceLabel(page.updated_at)}</time>
                    </div>
                    <div className="mt-1 flex items-start gap-2.5">
                      <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-accent-soft text-accent"><PageIcon controller={controller} icon={page.icon} size={16} className={page.icon ? undefined : "text-accent"} /></span>
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-sm font-semibold text-ink">{marked(pageTitle(page, t("docs.untitled")), keywords)}</div>
                        {snippet && <div className="line-clamp-3 whitespace-pre-wrap break-words text-sm text-ink/90">{marked(readableSnippet(mentionsToNames(snippet, store.users, store.groups)), keywords)}</div>}
                      </div>
                      <span className="self-center whitespace-nowrap text-xs text-accent opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100">{t("docs.open")}</span>
                    </div>
                  </button>
                </li>
              ))}
            </ul>
          )}
          {loading && <div className="py-4 text-center text-sm text-muted">{hits.length ? t("search.loadingMore") : t("search.searching")}</div>}
          {hasMore && !loading && (
            <div className="max-w-3xl py-2 text-center">
              <Button variant="secondary" size="sm" onClick={() => void run(hits.length)}>{t("canvasSearch.more")}</Button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
