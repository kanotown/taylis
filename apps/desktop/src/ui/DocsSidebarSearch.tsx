/**
 * WIKI.md §29.2: the search box at the top of the Docs sidebar. Typing lists, in place of the tree, the pages and
 * database rows whose title, body or properties match (`GET /search/pages`: only pages I can read, so an unreadable
 * page's title never shows), with the words marked — the live results of the message search box, for Docs. ↑ / ↓
 * choose one, Enter opens the chosen one or else the first, Esc empties the box and the tree comes back. The last line
 * opens every result in the search's 「ドキュメント」 tab (people, period and 「探す場所」 there). The Enter or arrow that
 * confirms an IME conversion does nothing (ime.ts), and nothing is asked while a conversion is open.
 */
import { CornerDownLeft, Search, Table2, X } from "lucide-react";
import { type KeyboardEvent, type ReactNode, useEffect, useRef, useState } from "react";

import type { PageSearchHit } from "../api/types";
import type { AppController } from "../state/app";
import { readableSnippet } from "./CanvasSearch";
import { pageTitle } from "./docsActions";
import { useWikiHub } from "./DocsTree";
import { highlightPieces, leadToFirstHit } from "./highlight";
import { isImeKeyEvent } from "./ime";
import { LIVE_DEBOUNCE_MS } from "./LiveSearch";
import { plainText } from "./markdown";
import { mentionsToNames } from "./mentions";
import { PageIcon } from "./PageIcon";
import { cn } from "./primitives";
import { t } from "../i18n";

/** How many pages the box lists while typing. */
export const SIDEBAR_LIMIT = 8;

export interface LivePages {
  /** idle: nothing typed (no request); loading: asked (the previous words' hits stay meanwhile); error: it failed. */
  status: "idle" | "loading" | "done" | "error";
  /** The words the hits are for. */
  query: string;
  hits: PageSearchHit[];
  keywords: string[];
}

const IDLE: LivePages = { status: "idle", query: "", hits: [], keywords: [] };

/**
 * The best few pages for the typed words, asked once typing pauses for LIVE_DEBOUNCE_MS and never while `paused` (an
 * open IME composition). A late answer to older words is dropped; words seen before are answered from memory until
 * `version` (the tree's) changes, since a page renamed, moved or shared changes the answer.
 */
export function useLivePages(controller: AppController, text: string, paused: boolean, version: number): LivePages {
  const q = text.trim();
  const [state, setState] = useState<LivePages>(IDLE);
  const request = useRef(0);
  const memory = useRef(new Map<string, LivePages>());
  const seen = useRef(version);
  if (seen.current !== version) {
    seen.current = version;
    memory.current.clear();
  }

  useEffect(() => {
    if (paused) return;
    const id = ++request.current;
    const api = controller.api;
    if (!q || !api) {
      setState(IDLE);
      return;
    }
    const known = memory.current.get(q);
    if (known) {
      setState(known);
      return;
    }
    setState((current) => ({ ...current, status: "loading" }));
    const timer = setTimeout(() => {
      void api.searchWikiPages({ q, limit: SIDEBAR_LIMIT, offset: 0 }).then(
        (result) => {
          const done: LivePages = { status: "done", query: q, hits: result.hits.slice(0, SIDEBAR_LIMIT), keywords: result.keywords };
          memory.current.set(q, done);
          if (id === request.current) setState(done);
        },
        () => {
          // Said in the list only (no toast): 「すべて見る」 reports its own errors.
          if (id === request.current) setState({ ...IDLE, status: "error", query: q });
        },
      );
    }, LIVE_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [q, paused, controller.api, version]);

  return state;
}

export function DocsSidebarSearch({ controller, text, onText, selectedId, onOpen, onSearchAll, children }: {
  controller: AppController;
  /** The words (kept by DocsView, so they stay while a result is open). */
  text: string;
  onText: (text: string) => void;
  /** The page on screen (marked among the results). */
  selectedId: string | null;
  onOpen: (pageId: string) => void;
  /** Every result in the search's 「ドキュメント」 tab, where this screen can open it. */
  onSearchAll?: (q: string) => void;
  /** The tree, shown while the box is empty. */
  children: ReactNode;
}) {
  const hub = useWikiHub(controller);
  const [composing, setComposing] = useState(false);
  const [active, setActive] = useState(-1);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const live = useLivePages(controller, text, composing, hub?.version ?? 0);
  const q = text.trim();
  const hits = live.hits;
  // Rows: the hits, then 「すべて見る」 (index hits.length).
  const rows = hits.length + (onSearchAll && q ? 1 : 0);
  useEffect(() => setActive(-1), [live.query]);
  useEffect(() => {
    if (active >= 0) list.current?.querySelector(`#docs-find-${active}`)?.scrollIntoView?.({ block: "nearest" });
  }, [active]);

  const choose = (index: number) => {
    const hit = hits[index];
    if (hit) onOpen(hit.page.id);
    else if (q && onSearchAll) onSearchAll(q);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (isImeKeyEvent(event)) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (rows === 0) return;
      const down = event.key === "ArrowDown";
      setActive((current) => (current < 0 ? (down ? 0 : rows - 1) : (current + (down ? 1 : rows - 1)) % rows));
    } else if (event.key === "Enter") {
      event.preventDefault();
      if (!q) return;
      if (active >= 0) choose(active);
      // No row chosen: the first page found for these words (not older words' hits still shown while asking).
      else if (hits[0] && live.query === q) choose(0);
      else if (onSearchAll && live.status !== "loading") onSearchAll(q);
    } else if (event.key === "Escape" && text) {
      // Empties the box only (the tree comes back); the screen's own Esc waits for the next one.
      event.preventDefault();
      event.stopPropagation();
      onText("");
    }
  };

  const mark = (value: string) => highlightPieces(value, live.keywords).map((piece, i) => (piece.hit ? <mark key={i} className="rounded bg-warning/35 px-0.5 text-ink">{piece.text}</mark> : <span key={i}>{piece.text}</span>));
  const store = controller.store;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="shrink-0 px-2 pt-2" data-docs-search="">
        <div className="flex h-8 items-center gap-1.5 rounded-lg border border-line bg-canvas px-2 focus-within:border-accent">
          <Search size={14} className="shrink-0 text-muted" />
          <input
            ref={input}
            value={text}
            onChange={(event) => {
              onText(event.target.value);
              setActive(-1);
            }}
            onCompositionStart={() => setComposing(true)}
            onCompositionEnd={() => setComposing(false)}
            onKeyDown={onKeyDown}
            placeholder={t("docs.find.sidebar")}
            aria-label={t("docs.find.sidebar")}
            aria-controls={q ? "docs-find-results" : undefined}
            aria-activedescendant={active >= 0 ? `docs-find-${active}` : undefined}
            enterKeyHint="search"
            className="h-full min-w-0 flex-1 bg-transparent text-[13px] outline-none placeholder:text-muted"
          />
          {text && (
            <button type="button" className="rounded p-0.5 text-muted hover:text-ink" aria-label={t("docs.find.clear")} onClick={() => { onText(""); input.current?.focus(); }}>
              <X size={13} />
            </button>
          )}
        </div>
      </div>
      {!q ? (
        children
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
          {hits.length === 0 && (
            <div className={cn("px-2 py-1.5 text-xs", live.status === "error" ? "text-danger" : "text-muted")} role="status">
              {live.status === "error" ? t("searchBar.liveError") : live.status === "done" ? t("docs.find.none") : t("searchBar.searching")}
            </div>
          )}
          <ul ref={list} id="docs-find-results" role="listbox" aria-label={t("docs.search.results")} className={cn("space-y-0.5", live.status === "loading" && hits.length > 0 && "opacity-60")}>
            {hits.map(({ page, snippet }, index) => {
              const parent = page.kind === "row" && page.parent_id ? hub?.page(page.parent_id) : null;
              // The excerpt joins its lines, so a heading's `## ` can sit mid-line, where plainText leaves it.
              const body = snippet ? leadToFirstHit(plainText(readableSnippet(mentionsToNames(snippet, store.users, store.groups)), 400).replace(/(^|\s)#{1,6}\s+/g, "$1"), live.keywords) : "";
              return (
                <li
                  key={page.id}
                  id={`docs-find-${index}`}
                  role="option"
                  aria-selected={index === active}
                  data-page-hit={page.id}
                  className={cn(
                    "flex cursor-pointer items-start gap-2 rounded-lg px-2 py-1.5 text-[13px]",
                    index === active ? "bg-accent-soft" : "hover:bg-panel-2",
                    page.id === selectedId && "font-medium",
                  )}
                  onMouseEnter={() => setActive(index)}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => choose(index)}
                >
                  <PageIcon controller={controller} icon={page.icon} kind={page.kind} size={14} className="mt-0.5 shrink-0 text-muted" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-ink">{mark(pageTitle(page, t("docs.untitled")))}</span>
                    {parent && (
                      <span className="flex items-center gap-1 truncate text-[11px] text-muted"><Table2 size={10} className="shrink-0" /> {t("docs.find.rowOf", { title: pageTitle(parent, t("docs.untitled")) })}</span>
                    )}
                    {body && <span className="line-clamp-2 break-words text-xs text-muted">{mark(body)}</span>}
                  </span>
                </li>
              );
            })}
            {onSearchAll && (
              <li
                id={`docs-find-${hits.length}`}
                role="option"
                aria-selected={active === hits.length}
                className={cn("mt-1 flex cursor-pointer items-center gap-2 rounded-lg border-t border-line px-2 py-1.5 text-xs text-accent", active === hits.length ? "bg-accent-soft" : "hover:bg-panel-2")}
                onMouseEnter={() => setActive(hits.length)}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => choose(hits.length)}
              >
                <Search size={12} className="shrink-0" />
                <span className="min-w-0 flex-1 truncate">{t("docs.find.seeAll", { q })}</span>
                {active === hits.length && <CornerDownLeft size={12} className="shrink-0" />}
              </li>
            )}
          </ul>
        </div>
      )}
    </div>
  );
}
