import { AtSign, Clock, CornerDownLeft, Hash, Lock, MessagesSquare, Search, X } from "lucide-react";
import { type KeyboardEvent, useEffect, useMemo, useRef, useState } from "react";

import type { ChannelOut, MessageOut, SearchHit } from "../api/types";
import type { AppController } from "../state/app";
import { Avatar } from "./Avatar";
import { isImeKeyEvent } from "./ime";
import { LiveMessageRow, LiveStatus, useLiveSearch } from "./LiveSearch";
import { channelTitle } from "./MainScreen";
import { cn, Kbd, modKey } from "./primitives";
import { dateLabel, EMPTY_SEARCH, HAS_LABELS, removeRecent, type SearchParams, type Suggestion, suggestions } from "./search";
import { t } from "../i18n";
import { tRich } from "../i18n/rich";

/** A row of the box: a suggestion, or one of the live message results (opens the message). */
type Row = Suggestion | { kind: "message"; hit: SearchHit };

/**
 * M16b: the search field in the top bar. Opening it shows recent searches and quick filters. Typing offers people
 * (→ 送信者) and conversations (→ チャンネル), the few best messages as you type (live results, LiveSearch.tsx), and last
 * 「「…」のすべての結果を見る」. Nothing is highlighted until ↑ / ↓: Enter then runs the highlighted row, and with none
 * it opens all the results. The Enter that confirms an IME conversion does nothing (ime.ts).
 */
export function SearchBar({ controller, current, open, onOpenChange, onSearch, onOpenMessage, recent, onRecentChange, recentKey, placeholder }: {
  controller: AppController;
  /** The search on screen, if any: the field shows its words. */
  current: SearchParams | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSearch: (params: SearchParams) => void;
  /** A live result: the message in its conversation (`other`: its channel when I am not a member; `q`: the words). */
  onOpenMessage?: (message: MessageOut, other: ChannelOut | undefined, q: string) => void;
  recent: SearchParams[];
  onRecentChange: (recent: SearchParams[]) => void;
  recentKey: string;
  placeholder: string;
}) {
  const store = controller.store;
  const [text, setText] = useState("");
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const [composing, setComposing] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLUListElement>(null);

  useEffect(() => {
    if (!open) return;
    setText(current?.q ?? "");
    setActiveKey(null);
    setComposing(false);
    requestAnimationFrame(() => input.current?.select());
  }, [open]);

  const live = useLiveSearch(controller, open && onOpenMessage ? text : "", composing);
  const suggested = useMemo(
    () => suggestions(text, { users: store.users.values(), channels: store.channels.values(), recent, channelTitle: (c) => channelTitle(c, controller) }),
    [text, recent, store.users, store.channels],
  );
  const typing = !!text.trim() && !!onOpenMessage;
  // The live results go just above 「すべての結果を見る」 (the last suggestion while typing).
  const rows: Row[] = useMemo(() => {
    if (!typing) return suggested;
    const messages = live.hits.map((hit): Row => ({ kind: "message", hit }));
    return [...suggested.filter((r) => r.kind !== "search"), ...messages, ...suggested.filter((r) => r.kind === "search")];
  }, [suggested, live.hits, typing]);
  const keys = rows.map(rowKey);
  const active = activeKey === null ? -1 : keys.indexOf(activeKey);

  useEffect(() => {
    if (active >= 0) list.current?.querySelector(`#search-suggestion-${active}`)?.scrollIntoView?.({ block: "nearest" });
  }, [active]);

  const choose = (row: Row) => {
    onOpenChange(false);
    switch (row.kind) {
      case "message":
        return onOpenMessage?.(row.hit.message, live.channels[row.hit.message.channel_id], text.trim());
      case "search":
        return onSearch({ ...EMPTY_SEARCH, q: row.q });
      case "recent":
        return onSearch(row.params);
      case "user":
        return onSearch({ ...EMPTY_SEARCH, fromUserId: row.user.id, sort: "newest" });
      case "channel":
        return onSearch({ ...EMPTY_SEARCH, channelId: row.channel.id, sort: "newest" });
      case "has":
        return onSearch({ ...EMPTY_SEARCH, has: [row.flag], sort: "newest" });
      case "thread":
        return onSearch({ ...EMPTY_SEARCH, isThread: true, sort: "newest" });
      case "times":
        return onSearch({ ...EMPTY_SEARCH, isTimes: true, sort: "newest" });
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    // Keys of an IME composition (and the Enter confirming it) belong to the IME: no moving, picking or searching.
    if (isImeKeyEvent(event)) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (rows.length === 0) return;
      const next = active < 0 ? (event.key === "ArrowDown" ? 0 : rows.length - 1) : (active + (event.key === "ArrowDown" ? 1 : rows.length - 1)) % rows.length;
      setActiveKey(keys[next] ?? null);
    } else if (event.key === "Enter") {
      event.preventDefault();
      const row = rows[active] ?? (text.trim() ? ({ kind: "search", q: text.trim() } as const) : null);
      if (row) choose(row);
    } else if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      onOpenChange(false);
    }
  };

  const label = current ? describeSearch(controller, current) : null;
  const hasMessages = rows.some((r) => r.kind === "message");

  return (
    <div className="relative mx-auto w-full max-w-[640px]">
      <button
        type="button"
        onClick={() => onOpenChange(true)}
        className="flex h-7 w-full items-center gap-2 rounded-md bg-sidebar-strong/12 px-2.5 text-left text-[13px] text-sidebar-fg transition-colors hover:bg-sidebar-strong/18"
      >
        <Search size={14} className="shrink-0 opacity-80" />
        <span className={cn("min-w-0 flex-1 truncate", label && "text-sidebar-strong")}>{label ?? placeholder}</span>
        <Kbd className="border-sidebar-strong/20 bg-transparent text-[10px] text-sidebar-fg/80 max-md:hidden">{modKey()} F</Kbd>
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-40" onMouseDown={() => onOpenChange(false)} />
          {/* On a phone the search takes the whole screen, with 「キャンセル」 instead of a click outside. Wider, it opens at
              the bar's top edge, keeping the bar's margin above it (it reached the window's top, tester 2026-09-30). */}
          <div role="dialog" aria-label={t("searchBar.label")} className="rx-popover absolute left-1/2 top-0 z-50 w-[min(680px,92vw)] -translate-x-1/2 overflow-hidden rounded-xl border border-line bg-canvas text-ink shadow-2xl max-md:fixed max-md:inset-0 max-md:flex max-md:w-auto max-md:translate-x-0 max-md:flex-col max-md:rounded-none max-md:border-0">
            <div className="flex shrink-0 items-center gap-2 border-b border-line px-3">
              <Search size={16} className="shrink-0 text-muted" />
              <input
                ref={input}
                value={text}
                onChange={(e) => {
                  setText(e.target.value);
                  // Typing highlights nothing: Enter opens all the results, ↑ / ↓ pick a row first.
                  setActiveKey(null);
                }}
                onCompositionStart={() => setComposing(true)}
                onCompositionEnd={() => setComposing(false)}
                onKeyDown={onKeyDown}
                placeholder={t("searchBar.placeholder")}
                aria-label={t("searchBar.words")}
                enterKeyHint="search"
                aria-activedescendant={rows[active] ? `search-suggestion-${active}` : undefined}
                className="h-12 min-w-0 flex-1 bg-transparent text-[15px] outline-none placeholder:text-muted"
                autoFocus
              />
              {text && (
                <button type="button" className="rounded p-1 text-muted hover:text-ink" aria-label={t("searchBar.clear")} onClick={() => { setText(""); setActiveKey(null); input.current?.focus(); }}>
                  <X size={15} />
                </button>
              )}
              <button type="button" className="shrink-0 px-1 text-sm font-medium text-accent md:hidden" onClick={() => onOpenChange(false)}>
                {t("common.cancel")}
              </button>
            </div>
            <ul ref={list} role="listbox" className="max-h-[60vh] overflow-y-auto p-1.5 max-md:max-h-none max-md:min-h-0 max-md:flex-1">
              {rows.map((row, index) => {
                const heading = sectionHeading(rows, index, text);
                // Searching / nothing found / an error: a quiet line where the messages would be, above 「すべての結果を見る」.
                const status = typing && row.kind === "search" && !hasMessages && live.status !== "idle";
                return (
                  <li key={keys[index]}>
                    {status && (
                      <>
                        <div className="px-2.5 pb-1 pt-2 text-[11px] font-semibold text-muted">{t("searchBar.messages")}</div>
                        <LiveStatus live={live} />
                      </>
                    )}
                    {heading && (
                      <div className="flex items-center px-2.5 pb-1 pt-2 text-[11px] font-semibold text-muted">
                        {heading}
                        {row.kind === "message" && live.status === "loading" && <span className="ml-auto font-normal">{t("searchBar.searching")}</span>}
                      </div>
                    )}
                    <div
                      id={`search-suggestion-${index}`}
                      role="option"
                      aria-selected={index === active}
                      onMouseEnter={() => setActiveKey(keys[index] ?? null)}
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => choose(row)}
                      className={cn(
                        "group flex cursor-pointer items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-sm",
                        index === active && "bg-accent-soft",
                        row.kind === "search" && typing && "mt-1 border-t border-line pt-2",
                        row.kind === "message" && live.status === "loading" && "opacity-60",
                      )}
                    >
                      {row.kind === "message" ? (
                        <LiveMessageRow controller={controller} message={row.hit.message} keywords={live.keywords} other={live.channels[row.hit.message.channel_id]} />
                      ) : (
                        <SuggestionRow controller={controller} row={row} />
                      )}
                      {row.kind === "recent" && (
                        <button
                          type="button"
                          aria-label={t("searchBar.removeHistory")}
                          className="ml-auto rounded p-0.5 text-muted opacity-0 hover:text-ink group-hover:opacity-100"
                          onClick={(e) => {
                            e.stopPropagation();
                            onRecentChange(removeRecent(recentKey, row.params));
                          }}
                        >
                          <X size={13} />
                        </button>
                      )}
                      {/* ⏎ marks what Enter does: the highlighted row, or 「すべての結果を見る」 while none is. */}
                      {(index === active || (row.kind === "search" && active < 0)) && row.kind !== "recent" && row.kind !== "message" && <CornerDownLeft size={13} className="ml-auto shrink-0 text-muted" />}
                    </div>
                  </li>
                );
              })}
              {rows.length === 0 && <li className="px-3 py-6 text-center text-sm text-muted">{t("searchBar.hint")}</li>}
            </ul>
            <div className="flex items-center gap-3 border-t border-line bg-panel px-3 py-1.5 text-[11px] text-muted max-md:hidden">
              <span><Kbd>↑</Kbd> <Kbd>↓</Kbd> {t("searchBar.select")}</span>
              <span><Kbd>Enter</Kbd> {active < 0 && text.trim() ? t("searchBar.allResults") : t("dialogs.open")}</span>
              <span><Kbd>Esc</Kbd> {t("common.close")}</span>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function rowKey(row: Row, index: number): string {
  switch (row.kind) {
    case "message":
      return `m:${row.hit.message.id}`;
    case "user":
      return `u:${row.user.id}`;
    case "channel":
      return `c:${row.channel.id}`;
    case "has":
      return `h:${row.flag}`;
    case "recent":
      return `r:${JSON.stringify(row.params)}`;
    case "search":
      return "search";
    default:
      return `${row.kind}:${index}`;
  }
}

/** A small heading where the kind of row changes (最近の検索 / 絞り込み / 人 / チャンネル / メッセージ). */
function sectionHeading(rows: Row[], index: number, text: string): string | null {
  const group = (row: Row | undefined) =>
    !row ? null : row.kind === "has" || row.kind === "thread" || row.kind === "times" ? "filter" : row.kind === "recent" ? "recent" : row.kind === "search" ? "search" : row.kind;
  const here = group(rows[index]);
  if (here === group(rows[index - 1])) return null;
  switch (here) {
    case "recent":
      return t("searchBar.recent");
    case "filter":
      return t("admin.users.filterLabel");
    case "user":
      return t("searchBar.people");
    case "channel":
      return t("searchBar.channels");
    case "message":
      return t("searchBar.messages");
    default:
      return null;
  }
}

function SuggestionRow({ controller, row }: { controller: AppController; row: Suggestion }) {
  const store = controller.store;
  switch (row.kind) {
    case "search":
      return (
        <>
          <Search size={15} className="shrink-0 text-muted" />
          <span className="min-w-0 truncate">
            {tRich("searchBar.seeAll", { b: (s) => <strong>{s}</strong> }, { q: row.q })}
          </span>
        </>
      );
    case "recent":
      return (
        <>
          <Clock size={15} className="shrink-0 text-muted" />
          <span className="min-w-0 truncate">{describeSearch(controller, row.params)}</span>
        </>
      );
    case "user":
      return (
        <>
          <Avatar id={row.user.id} name={row.user.display_name} size={20} className="rounded-md text-[9px]" presence={store.presenceOf(row.user.id)} />
          <span className="min-w-0 truncate font-medium">{row.user.display_name}</span>
          <span className="shrink-0 text-xs text-muted">@{row.user.username}</span>
        </>
      );
    case "channel": {
      const channel = row.channel;
      const Icon = channel.type === "private" ? Lock : channel.type === "public" ? Hash : AtSign;
      return (
        <>
          <Icon size={15} className="shrink-0 text-muted" />
          <span className="min-w-0 truncate">{channelTitle(channel, controller).replace(/^#/, "")}</span>
        </>
      );
    }
    case "has":
      return (
        <>
          <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded bg-panel-2 text-[10px] font-bold text-muted">has</span>
          <span>{t("searchBar.hasMessages", { label: HAS_LABELS[row.flag] })}</span>
        </>
      );
    case "thread":
      return (
        <>
          <MessagesSquare size={15} className="shrink-0 text-muted" />
          <span>{t("searchBar.inThreads")}</span>
        </>
      );
    case "times":
      return (
        <>
          <span className="flex h-5 shrink-0 items-center justify-center rounded bg-panel-2 px-1 text-[10px] font-bold text-muted">is:times</span>
          <span>{t("searchBar.times")}</span>
        </>
      );
  }
}

/** One line for a search: the words, then the filters (「設計」 · 送信者: 田中 · #general · 過去 7 日間). */
export function describeSearch(controller: AppController, params: SearchParams): string {
  const store = controller.store;
  const parts: string[] = [];
  if (params.q.trim()) parts.push(params.q.trim());
  if (params.fromUserId) parts.push(`${t("search.sender")}: ${store.users.get(params.fromUserId)?.display_name ?? "?"}`);
  if (params.channelId) {
    const channel = store.getChannel(params.channelId);
    parts.push(channel ? channelTitle(channel, controller) : "?");
  }
  const date = dateLabel(params.date);
  if (date) parts.push(date);
  for (const flag of params.has) parts.push(HAS_LABELS[flag]);
  if (params.isThread) parts.push(t("search.inThreads"));
  if (params.isTimes) parts.push("Times");
  return parts.join(" · ");
}
