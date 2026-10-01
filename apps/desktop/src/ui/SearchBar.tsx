import { AtSign, Clock, CornerDownLeft, Hash, Lock, MessagesSquare, Search, X } from "lucide-react";
import { type KeyboardEvent, useEffect, useMemo, useRef, useState } from "react";

import type { AppController } from "../state/app";
import { Avatar } from "./Avatar";
import { channelTitle } from "./MainScreen";
import { cn, Kbd, modKey } from "./primitives";
import { dateLabel, EMPTY_SEARCH, HAS_LABELS, removeRecent, type SearchParams, type Suggestion, suggestions } from "./search";

/**
 * M16b: the search field in the top bar. Opening it shows recent searches and quick filters; typing
 * offers the words, people (→ 送信者) and conversations (→ チャンネル). Enter runs the highlighted row.
 */
export function SearchBar({ controller, current, open, onOpenChange, onSearch, recent, onRecentChange, recentKey, placeholder }: {
  controller: AppController;
  /** The search on screen, if any: the field shows its words. */
  current: SearchParams | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSearch: (params: SearchParams) => void;
  recent: SearchParams[];
  onRecentChange: (recent: SearchParams[]) => void;
  recentKey: string;
  placeholder: string;
}) {
  const store = controller.store;
  const [text, setText] = useState("");
  const [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    setText(current?.q ?? "");
    setActive(current?.q ? 0 : -1);
    requestAnimationFrame(() => input.current?.select());
  }, [open]);

  const rows = useMemo(
    () => suggestions(text, { users: store.users.values(), channels: store.channels.values(), recent, channelTitle: (c) => channelTitle(c, controller) }),
    [text, recent, store.users, store.channels],
  );

  const choose = (row: Suggestion) => {
    onOpenChange(false);
    switch (row.kind) {
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
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (rows.length === 0) return;
      setActive((i) => (i < 0 ? (event.key === "ArrowDown" ? 0 : rows.length - 1) : (i + (event.key === "ArrowDown" ? 1 : rows.length - 1)) % rows.length));
    } else if (event.key === "Enter" && !event.nativeEvent.isComposing) {
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

  return (
    <div className="relative mx-auto w-full max-w-[640px]">
      <button
        type="button"
        onClick={() => onOpenChange(true)}
        className="flex h-7 w-full items-center gap-2 rounded-md bg-white/12 px-2.5 text-left text-[13px] text-sidebar-fg transition-colors hover:bg-white/18"
      >
        <Search size={14} className="shrink-0 opacity-80" />
        <span className={cn("min-w-0 flex-1 truncate", label && "text-white")}>{label ?? placeholder}</span>
        <Kbd className="border-white/20 bg-transparent text-[10px] text-sidebar-fg/80 max-md:hidden">{modKey()} F</Kbd>
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-40" onMouseDown={() => onOpenChange(false)} />
          {/* On a phone the search takes the whole screen, with 「キャンセル」 instead of a click outside. Wider, it opens at
              the bar's top edge, keeping the bar's margin above it (it reached the window's top, tester 2026-09-30). */}
          <div role="dialog" aria-label="検索" className="rx-popover absolute left-1/2 top-0 z-50 w-[min(680px,92vw)] -translate-x-1/2 overflow-hidden rounded-xl border border-line bg-canvas text-ink shadow-2xl max-md:fixed max-md:inset-0 max-md:flex max-md:w-auto max-md:translate-x-0 max-md:flex-col max-md:rounded-none max-md:border-0">
            <div className="flex shrink-0 items-center gap-2 border-b border-line px-3">
              <Search size={16} className="shrink-0 text-muted" />
              <input
                ref={input}
                value={text}
                onChange={(e) => {
                  setText(e.target.value);
                  // Typing highlights 「〜を検索」; an empty box highlights nothing until ↓.
                  setActive(e.target.value.trim() ? 0 : -1);
                }}
                onKeyDown={onKeyDown}
                placeholder="メッセージ、人、チャンネルを検索 (from:@名前 in:#チャンネル is:times も使えます)"
                aria-label="検索語"
                enterKeyHint="search"
                aria-activedescendant={rows[active] ? `search-suggestion-${active}` : undefined}
                className="h-12 min-w-0 flex-1 bg-transparent text-[15px] outline-none placeholder:text-muted"
                autoFocus
              />
              {text && (
                <button type="button" className="rounded p-1 text-muted hover:text-ink" aria-label="入力を消す" onClick={() => { setText(""); input.current?.focus(); }}>
                  <X size={15} />
                </button>
              )}
              <button type="button" className="shrink-0 px-1 text-sm font-medium text-accent md:hidden" onClick={() => onOpenChange(false)}>
                キャンセル
              </button>
            </div>
            <ul role="listbox" className="max-h-[60vh] overflow-y-auto p-1.5 max-md:max-h-none max-md:min-h-0 max-md:flex-1">
              {rows.map((row, index) => {
                const heading = sectionHeading(rows, index, text);
                return (
                  <li key={suggestionKey(row, index)}>
                    {heading && <div className="px-2.5 pb-1 pt-2 text-[11px] font-semibold text-muted">{heading}</div>}
                    <div
                      id={`search-suggestion-${index}`}
                      role="option"
                      aria-selected={index === active}
                      onMouseEnter={() => setActive(index)}
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => choose(row)}
                      className={cn("group flex cursor-pointer items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-sm", index === active && "bg-accent-soft")}
                    >
                      <SuggestionRow controller={controller} row={row} />
                      {row.kind === "recent" && (
                        <button
                          type="button"
                          aria-label="履歴から消す"
                          className="ml-auto rounded p-0.5 text-muted opacity-0 hover:text-ink group-hover:opacity-100"
                          onClick={(e) => {
                            e.stopPropagation();
                            onRecentChange(removeRecent(recentKey, row.params));
                          }}
                        >
                          <X size={13} />
                        </button>
                      )}
                      {index === active && row.kind !== "recent" && <CornerDownLeft size={13} className="ml-auto text-muted" />}
                    </div>
                  </li>
                );
              })}
              {rows.length === 0 && <li className="px-3 py-6 text-center text-sm text-muted">入力して Enter で検索します</li>}
            </ul>
            <div className="flex items-center gap-3 border-t border-line bg-panel px-3 py-1.5 text-[11px] text-muted max-md:hidden">
              <span><Kbd>↑</Kbd> <Kbd>↓</Kbd> 選択</span>
              <span><Kbd>Enter</Kbd> 検索</span>
              <span><Kbd>Esc</Kbd> 閉じる</span>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function suggestionKey(row: Suggestion, index: number): string {
  switch (row.kind) {
    case "user":
      return `u:${row.user.id}`;
    case "channel":
      return `c:${row.channel.id}`;
    case "has":
      return `h:${row.flag}`;
    default:
      return `${row.kind}:${index}`;
  }
}

/** A small heading where the kind of row changes (最近の検索 / 絞り込み / 人 / チャンネル). */
function sectionHeading(rows: Suggestion[], index: number, text: string): string | null {
  const group = (row: Suggestion | undefined) =>
    !row ? null : row.kind === "has" || row.kind === "thread" || row.kind === "times" ? "filter" : row.kind === "recent" ? "recent" : row.kind === "search" ? "search" : row.kind;
  const here = group(rows[index]);
  if (here === group(rows[index - 1])) return null;
  switch (here) {
    case "recent":
      return text.trim() ? "最近の検索" : "最近の検索";
    case "filter":
      return "絞り込み";
    case "user":
      return "人 (この人の投稿)";
    case "channel":
      return "チャンネル (この中を検索)";
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
            「<strong>{row.q}</strong>」を検索
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
          <span>{HAS_LABELS[row.flag]}のメッセージ</span>
        </>
      );
    case "thread":
      return (
        <>
          <MessagesSquare size={15} className="shrink-0 text-muted" />
          <span>スレッド内のメッセージ</span>
        </>
      );
    case "times":
      return (
        <>
          <span className="flex h-5 shrink-0 items-center justify-center rounded bg-panel-2 px-1 text-[10px] font-bold text-muted">is:times</span>
          <span>times の投稿 (参加していない公開の times も)</span>
        </>
      );
  }
}

/** One line for a search: the words, then the filters (「設計」 · 送信者: 田中 · #general · 過去 7 日間). */
export function describeSearch(controller: AppController, params: SearchParams): string {
  const store = controller.store;
  const parts: string[] = [];
  if (params.q.trim()) parts.push(params.q.trim());
  if (params.fromUserId) parts.push(`送信者: ${store.users.get(params.fromUserId)?.display_name ?? "?"}`);
  if (params.channelId) {
    const channel = store.getChannel(params.channelId);
    parts.push(channel ? channelTitle(channel, controller) : "?");
  }
  const date = dateLabel(params.date);
  if (date) parts.push(date);
  for (const flag of params.has) parts.push(HAS_LABELS[flag]);
  if (params.isThread) parts.push("スレッド内");
  if (params.isTimes) parts.push("Times");
  return parts.join(" · ");
}
