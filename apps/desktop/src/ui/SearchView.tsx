import { AlertTriangle, ArrowUpDown, AtSign, Calendar, Check, ChevronDown, FileText, Filter, Hash, Lock, MessagesSquare, Paperclip, Search, SearchX, User, X } from "lucide-react";
import { type ButtonHTMLAttributes, type KeyboardEvent, type ReactNode, type Ref, useEffect, useMemo, useRef, useState } from "react";

import type { FileItem, MessageOut, SearchHit } from "../api/types";
import type { AppController } from "../state/app";
import type { ChannelState } from "../sync/types";
import { Avatar } from "./Avatar";
import { FileRow } from "./FilesView";
import { fullTimestamp } from "./format";
import { highlightPieces } from "./highlight";
import { channelTitle } from "./MainScreen";
import { plainText } from "./markdown";
import { mentionsToNames } from "./mentions";
import { Badge, Button, cn, IconButton, Input, Menu, MenuContent, MenuRadioGroup, MenuRadioItem, MenuTrigger, PopoverContent, PopoverRoot, PopoverTrigger } from "./primitives";
import { DATE_PRESETS, dateLabel, EMPTY_SEARCH, HAS_FLAGS, HAS_LABELS, hasFilters, isEmptySearch, type SearchParams, type SearchSort, toQuery, totalLabel } from "./search";

export type SearchTab = "messages" | "files";

/** What the results looked like, so 「検索結果に戻る」 shows them again without a new request. */
export interface SearchSnapshot {
  key: string;
  hits: SearchHit[];
  keywords: string[];
  total: number;
  capped: boolean;
  hasMore: boolean;
  unresolved: string[];
  scrollTop: number;
}

const PAGE = 30;

/** M16b: search results in the centre column: count, tabs, filter chips, sort, endless list. */
export function SearchView({ controller, params, tab, onTabChange, onChange, onOpen, onClose, snapshot }: {
  controller: AppController;
  params: SearchParams;
  tab: SearchTab;
  onTabChange: (tab: SearchTab) => void;
  onChange: (params: SearchParams) => void;
  onOpen: (message: MessageOut) => void;
  onClose: () => void;
  snapshot: { current: SearchSnapshot | null };
}) {
  const key = JSON.stringify(params);
  const kept = snapshot.current?.key === key ? snapshot.current : null;
  const [hits, setHits] = useState<SearchHit[]>(kept?.hits ?? []);
  const [keywords, setKeywords] = useState<string[]>(kept?.keywords ?? []);
  const [total, setTotal] = useState(kept?.total ?? 0);
  const [capped, setCapped] = useState(kept?.capped ?? false);
  const [hasMore, setHasMore] = useState(kept?.hasMore ?? false);
  const [unresolved, setUnresolved] = useState<string[]>(kept?.unresolved ?? []);
  const [loading, setLoading] = useState(!kept);
  const [loaded, setLoaded] = useState(!!kept);
  const scroller = useRef<HTMLDivElement>(null);
  const sentinel = useRef<HTMLDivElement>(null);
  const request = useRef(0);

  const run = async (offset: number) => {
    const api = controller.api;
    if (!api || isEmptySearch(params)) return;
    const id = ++request.current;
    setLoading(true);
    try {
      const result = await api.search({ ...toQuery(params), limit: PAGE, offset });
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
    if (kept) {
      requestAnimationFrame(() => scroller.current?.scrollTo?.({ top: kept.scrollTop }));
      return;
    }
    setHits([]);
    setLoaded(false);
    scroller.current?.scrollTo?.({ top: 0 });
    void run(0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, controller.api]);

  // Keep what is on screen for 「検索結果に戻る」.
  useEffect(() => {
    snapshot.current = { key, hits, keywords, total, capped, hasMore, unresolved, scrollTop: scroller.current?.scrollTop ?? 0 };
  });
  const rememberScroll = () => {
    if (snapshot.current) snapshot.current.scrollTop = scroller.current?.scrollTop ?? 0;
  };

  // Endless list: the next page when the end comes into view.
  useEffect(() => {
    const target = sentinel.current;
    if (!target || tab !== "messages" || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting) && hasMore && !loading) void run(hits.length);
    }, { root: scroller.current, rootMargin: "240px" });
    observer.observe(target);
    return () => observer.disconnect();
  });

  // ↑ / ↓ move between results, Enter opens (the rows are buttons).
  const onListKey = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    const rows = [...(scroller.current?.querySelectorAll<HTMLButtonElement>("[data-result]") ?? [])];
    if (rows.length === 0) return;
    event.preventDefault();
    const index = rows.indexOf(document.activeElement as HTMLButtonElement);
    const next = index < 0 ? 0 : Math.min(rows.length - 1, Math.max(0, index + (event.key === "ArrowDown" ? 1 : -1)));
    rows[next]?.focus();
    rows[next]?.scrollIntoView?.({ block: "nearest" });
  };

  const words = params.q.trim();
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex h-[52px] shrink-0 items-center gap-3 border-b border-line px-4">
        <span className="text-muted"><Search size={18} /></span>
        <div className="min-w-0 flex-1 truncate">
          <strong className="text-[15px]">{words ? `「${words}」の検索結果` : "検索結果"}</strong>
          {tab === "messages" && loaded && <span className="ml-2 text-sm text-muted">{totalLabel(total, capped)}</span>}
        </div>
        {tab === "messages" && <SortMenu sort={words ? params.sort : "newest"} disabled={!words} onChange={(sort) => onChange({ ...params, sort })} />}
        <IconButton label="検索を閉じる (Esc)" onClick={onClose}>
          <X size={18} />
        </IconButton>
      </header>
      <div className="flex shrink-0 items-center gap-4 border-b border-line px-4">
        <TabButton active={tab === "messages"} onClick={() => onTabChange("messages")}>メッセージ</TabButton>
        <TabButton active={tab === "files"} onClick={() => onTabChange("files")}>ファイル</TabButton>
      </div>
      <FilterBar controller={controller} params={params} onChange={onChange} filesOnly={tab === "files"} />
      {tab === "files" ? (
        <FileResults controller={controller} params={params} onOpen={onOpen} />
      ) : (
        <div ref={scroller} className="min-h-0 flex-1 overflow-y-auto px-4 py-3" onKeyDown={onListKey} onScroll={rememberScroll}>
          {unresolved.length > 0 && (
            <div className="mx-auto mb-3 flex max-w-3xl items-start gap-2 rounded-lg bg-danger/10 px-3 py-2 text-xs text-danger">
              <AlertTriangle size={14} className="mt-0.5 shrink-0" />
              <span>見つからない条件は無視しました: {unresolved.join(" ")}</span>
            </div>
          )}
          {loaded && hits.length === 0 ? (
            <EmptyResults params={params} onClear={() => onChange({ ...EMPTY_SEARCH, q: params.q, sort: params.sort })} />
          ) : (
            <ul className="mx-auto max-w-3xl space-y-1">
              {hits.map((hit) => (
                <li key={hit.message.id}>
                  <ResultRow controller={controller} message={hit.message} keywords={keywords} onOpen={(m) => { rememberScroll(); onOpen(m); }} />
                </li>
              ))}
            </ul>
          )}
          <div ref={sentinel} className="h-px" />
          {loading && <div className="py-4 text-center text-sm text-muted">{hits.length ? "続きを読み込んでいます…" : "検索しています…"}</div>}
        </div>
      )}
    </div>
  );
}

function TabButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={cn("-mb-px border-b-2 px-1 py-2 text-sm font-medium transition-colors", active ? "border-accent text-ink" : "border-transparent text-muted hover:text-ink")}
    >
      {children}
    </button>
  );
}

function SortMenu({ sort, disabled, onChange }: { sort: SearchSort; disabled: boolean; onChange: (sort: SearchSort) => void }) {
  return (
    <Menu>
      <MenuTrigger asChild disabled={disabled}>
        <Button variant="ghost" size="sm" title={disabled ? "語を入れると関連度順にできます" : "並び順"}>
          <ArrowUpDown size={14} /> {sort === "relevance" ? "関連度順" : "新しい順"}
        </Button>
      </MenuTrigger>
      <MenuContent>
        <MenuRadioGroup value={sort} onValueChange={(v) => onChange(v as SearchSort)}>
          <MenuRadioItem value="relevance">関連度順</MenuRadioItem>
          <MenuRadioItem value="newest">新しい順</MenuRadioItem>
        </MenuRadioGroup>
      </MenuContent>
    </Menu>
  );
}

// ---- filters ----

function FilterBar({ controller, params, onChange, filesOnly }: { controller: AppController; params: SearchParams; onChange: (p: SearchParams) => void; filesOnly: boolean }) {
  const store = controller.store;
  const sender = params.fromUserId ? store.users.get(params.fromUserId) : undefined;
  const channel = params.channelId ? store.getChannel(params.channelId) : undefined;
  const date = dateLabel(params.date);
  return (
    <div className="flex shrink-0 flex-wrap items-center gap-1.5 border-b border-line px-4 py-2">
      <Filter size={14} className="mr-0.5 text-muted" />
      {!filesOnly && (
        <PeoplePicker controller={controller} value={params.fromUserId} onChange={(id) => onChange({ ...params, fromUserId: id })}>
          <Chip active={!!sender} icon={<User size={13} />} onClear={sender ? () => onChange({ ...params, fromUserId: null }) : undefined}>
            {sender ? `送信者: ${sender.display_name}` : "送信者"}
          </Chip>
        </PeoplePicker>
      )}
      <ChannelPicker controller={controller} value={params.channelId} onChange={(id) => onChange({ ...params, channelId: id })}>
        <Chip active={!!channel} icon={<Hash size={13} />} onClear={channel ? () => onChange({ ...params, channelId: null }) : undefined}>
          {channel ? channelTitle(channel, controller) : "チャンネル"}
        </Chip>
      </ChannelPicker>
      {!filesOnly && (
        <>
          <DatePicker value={params.date} onChange={(value) => onChange({ ...params, date: value })}>
            <Chip active={!!date} icon={<Calendar size={13} />} onClear={date ? () => onChange({ ...params, date: null }) : undefined}>
              {date ?? "期間"}
            </Chip>
          </DatePicker>
          <KindPicker value={params.has} onChange={(has) => onChange({ ...params, has })}>
            <Chip active={params.has.length > 0} icon={<Paperclip size={13} />} onClear={params.has.length ? () => onChange({ ...params, has: [] }) : undefined}>
              {params.has.length ? params.has.map((f) => HAS_LABELS[f]).join("・") : "種類"}
            </Chip>
          </KindPicker>
          <Chip toggle active={params.isThread} icon={<MessagesSquare size={13} />} onClick={() => onChange({ ...params, isThread: !params.isThread })}>
            スレッド内
          </Chip>
        </>
      )}
      {(filesOnly ? !!params.channelId : hasFilters(params)) && (
        <button type="button" className="ml-1 text-xs text-accent hover:underline" onClick={() => onChange({ ...EMPTY_SEARCH, q: params.q, sort: params.sort })}>
          条件をクリア
        </button>
      )}
    </div>
  );
}

/** A filter chip: opens its picker (menus wrap it with asChild) or toggles; × removes the filter. */
function Chip({ active, icon, children, onClear, toggle = false, className, ...props }: {
  active: boolean;
  icon: ReactNode;
  children: ReactNode;
  onClear?: () => void;
  toggle?: boolean;
} & ButtonHTMLAttributes<HTMLButtonElement> & { ref?: Ref<HTMLButtonElement> }) {
  return (
    <button
      type="button"
      aria-pressed={toggle ? active : undefined}
      {...props}
      className={cn(
        "inline-flex h-7 max-w-[260px] select-none items-center gap-1.5 rounded-full border px-2.5 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40",
        active ? "border-accent bg-accent-soft text-accent" : "border-line bg-canvas text-ink hover:bg-panel",
        className,
      )}
    >
      {icon}
      <span className="truncate">{children}</span>
      {onClear ? (
        <span
          role="button"
          aria-label="この条件を外す"
          className="-mr-1 rounded-full p-0.5 hover:bg-accent/15"
          onClick={(e) => {
            e.stopPropagation();
            e.preventDefault();
            onClear();
          }}
        >
          <X size={12} />
        </span>
      ) : !toggle ? (
        <ChevronDown size={12} className="opacity-60" />
      ) : null}
    </button>
  );
}

function fold(value: string): string {
  return value.normalize("NFKC").toLowerCase();
}

/** A popover with a filter box and a list (people, conversations). */
function ListPicker<T>({ children, items, keyOf, render, match, onPick, placeholder, selected }: {
  children: ReactNode;
  items: T[];
  keyOf: (item: T) => string;
  render: (item: T) => ReactNode;
  match: (item: T, needle: string) => boolean;
  onPick: (item: T) => void;
  placeholder: string;
  selected: string | null;
}) {
  const [open, setOpen] = useState(false);
  const [needle, setNeedle] = useState("");
  const shown = useMemo(() => (needle ? items.filter((item) => match(item, fold(needle))) : items).slice(0, 50), [items, needle]);
  return (
    <PopoverRoot open={open} onOpenChange={(value) => { setOpen(value); if (!value) setNeedle(""); }}>
      <PopoverTrigger asChild>{children}</PopoverTrigger>
      <PopoverContent align="start" className="w-72 p-1.5">
        <Input autoFocus value={needle} placeholder={placeholder} className="h-8 text-sm" onChange={(e) => setNeedle(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && shown[0]) { onPick(shown[0]); setOpen(false); } }} />
        <ul className="mt-1 max-h-72 overflow-y-auto">
          {shown.map((item) => (
            <li key={keyOf(item)}>
              <button type="button" className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm hover:bg-accent-soft"
                onClick={() => { onPick(item); setOpen(false); }}>
                {render(item)}
                {selected === keyOf(item) && <Check size={14} className="ml-auto text-accent" />}
              </button>
            </li>
          ))}
          {shown.length === 0 && <li className="px-2 py-3 text-center text-xs text-muted">見つかりません</li>}
        </ul>
      </PopoverContent>
    </PopoverRoot>
  );
}

function PeoplePicker({ controller, value, onChange, children }: { controller: AppController; value: string | null; onChange: (id: string | null) => void; children: ReactNode }) {
  const store = controller.store;
  const people = [...store.users.values()].filter((u) => !u.deactivated_at).sort((a, b) => a.display_name.localeCompare(b.display_name, "ja"));
  return (
    <ListPicker
      items={people}
      keyOf={(u) => u.id}
      selected={value}
      placeholder="名前で絞り込む"
      match={(u, needle) => fold(u.display_name).includes(needle) || fold(u.username).includes(needle)}
      onPick={(u) => onChange(u.id === value ? null : u.id)}
      render={(u) => (
        <>
          <Avatar id={u.id} name={u.display_name} size={20} className="rounded-md text-[9px]" />
          <span className="truncate">{u.display_name}</span>
          <span className="shrink-0 text-xs text-muted">@{u.username}</span>
        </>
      )}
    >
      {children}
    </ListPicker>
  );
}

function ChannelPicker({ controller, value, onChange, children }: { controller: AppController; value: string | null; onChange: (id: string | null) => void; children: ReactNode }) {
  const title = (c: ChannelState) => channelTitle(c, controller);
  const list = [...controller.store.channels.values()].filter((c) => c.isMember).sort((a, b) => title(a).localeCompare(title(b), "ja"));
  return (
    <ListPicker
      items={list}
      keyOf={(c) => c.id}
      selected={value}
      placeholder="会話の名前で絞り込む"
      match={(c, needle) => fold(title(c)).includes(needle)}
      onPick={(c) => onChange(c.id === value ? null : c.id)}
      render={(c) => {
        const Icon = c.type === "private" ? Lock : c.type === "public" ? Hash : AtSign;
        return (
          <>
            <Icon size={14} className="shrink-0 text-muted" />
            <span className="truncate">{title(c).replace(/^#/, "")}</span>
          </>
        );
      }}
    >
      {children}
    </ListPicker>
  );
}

function DatePicker({ value, onChange, children }: { value: SearchParams["date"]; onChange: (value: SearchParams["date"]) => void; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const custom = value && !("preset" in value) ? value : null;
  const [from, setFrom] = useState(custom?.from ?? "");
  const [to, setTo] = useState(custom?.to ?? "");
  const pick = (next: SearchParams["date"]) => {
    onChange(next);
    setOpen(false);
  };
  return (
    <PopoverRoot open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>{children}</PopoverTrigger>
      <PopoverContent align="start" className="w-72 p-1.5">
        {DATE_PRESETS.map(({ preset, label }) => (
          <button key={preset} type="button" className="flex w-full items-center rounded-lg px-2 py-1.5 text-left text-sm hover:bg-accent-soft" onClick={() => pick({ preset })}>
            {label}
            {value && "preset" in value && value.preset === preset && <Check size={14} className="ml-auto text-accent" />}
          </button>
        ))}
        <div className="mt-1 border-t border-line px-2 pb-1 pt-2">
          <div className="mb-1.5 text-xs font-medium text-muted">日付を指定</div>
          <div className="flex items-center gap-1.5">
            <Input type="date" aria-label="開始日" value={from} max={to || undefined} className="h-8 px-2 text-xs" onChange={(e) => setFrom(e.target.value)} />
            <span className="text-xs text-muted">〜</span>
            <Input type="date" aria-label="終了日" value={to} min={from || undefined} className="h-8 px-2 text-xs" onChange={(e) => setTo(e.target.value)} />
          </div>
          <Button size="sm" className="mt-2 w-full" disabled={!from && !to} onClick={() => pick({ from: from || null, to: to || null })}>
            この期間で絞り込む
          </Button>
        </div>
      </PopoverContent>
    </PopoverRoot>
  );
}

function KindPicker({ value, onChange, children }: { value: SearchParams["has"]; onChange: (value: SearchParams["has"]) => void; children: ReactNode }) {
  return (
    <PopoverRoot>
      <PopoverTrigger asChild>{children}</PopoverTrigger>
      <PopoverContent align="start" className="w-56 p-1.5">
        {HAS_FLAGS.map((flag) => {
          const on = value.includes(flag);
          return (
            <label key={flag} className="flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-sm hover:bg-accent-soft">
              <input type="checkbox" className="accent-[var(--color-accent)]" checked={on} onChange={() => onChange(on ? value.filter((f) => f !== flag) : [...value, flag])} />
              {HAS_LABELS[flag]}
            </label>
          );
        })}
      </PopoverContent>
    </PopoverRoot>
  );
}

// ---- rows ----

function ResultRow({ controller, message, keywords, onOpen }: { controller: AppController; message: MessageOut; keywords: string[]; onOpen: (message: MessageOut) => void }) {
  const store = controller.store;
  const channel = store.getChannel(message.channel_id);
  const sender = store.users.get(message.sender_id)?.display_name ?? "?";
  const text = plainText(mentionsToNames(message.body, store.users, store.groups));
  const files = message.attachments.map((a) => a.filename);
  return (
    <button
      type="button"
      data-result
      className="group block w-full rounded-xl border border-transparent px-3 py-2.5 text-left transition-colors hover:border-line hover:bg-panel focus-visible:border-accent focus-visible:bg-panel focus-visible:outline-none"
      onClick={() => onOpen(message)}
    >
      <div className="flex items-center gap-2 text-xs text-muted">
        {channel && (channel.type === "private" ? <Lock size={12} /> : channel.type === "public" ? <Hash size={12} /> : <AtSign size={12} />)}
        <span className="min-w-0 truncate font-medium">{channel ? channelTitle(channel, controller).replace(/^#/, "") : "?"}</span>
        {message.parent_id && <Badge className="shrink-0 whitespace-nowrap">スレッドの返信</Badge>}
        <time className="ml-auto shrink-0">{fullTimestamp(message.created_at)}</time>
      </div>
      <div className="mt-1.5 flex gap-2.5">
        <Avatar id={message.sender_id} name={sender} size={32} className="rounded-lg text-[11px]" />
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold text-ink">{sender}</div>
          {text && (
            <div className="line-clamp-3 whitespace-pre-wrap break-words text-sm text-ink">
              {highlightPieces(text, keywords).map((piece, i) => (piece.hit ? <mark key={i} className="rounded bg-warning/35 px-0.5 text-ink">{piece.text}</mark> : <span key={i}>{piece.text}</span>))}
            </div>
          )}
          {files.length > 0 && (
            <div className="mt-1 flex flex-wrap gap-1">
              {files.map((name, i) => (
                <span key={i} className="inline-flex max-w-[240px] items-center gap-1 rounded-md border border-line bg-panel px-1.5 py-0.5 text-xs text-muted">
                  <FileText size={12} />
                  <span className="truncate">{highlightPieces(name, keywords).map((p, j) => (p.hit ? <mark key={j} className="bg-warning/35 text-ink">{p.text}</mark> : <span key={j}>{p.text}</span>))}</span>
                </span>
              ))}
            </div>
          )}
        </div>
        <span className="self-center whitespace-nowrap text-xs text-accent opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100">
          {message.parent_id ? "スレッドで表示" : "会話で表示"}
        </span>
      </div>
    </button>
  );
}

function EmptyResults({ params, onClear }: { params: SearchParams; onClear: () => void }) {
  return (
    <div className="mx-auto flex max-w-md flex-col items-center py-16 text-center">
      <SearchX size={40} className="text-muted/60" />
      <div className="mt-3 text-base font-semibold">見つかりませんでした</div>
      <p className="mt-1 text-sm text-muted">
        {hasFilters(params) ? "条件を減らすと見つかるかもしれません。" : "別の言葉や、より短い言葉で試してください。"}
      </p>
      {hasFilters(params) && (
        <Button variant="secondary" size="sm" className="mt-4" onClick={onClear}>
          条件をクリアして検索
        </Button>
      )}
    </div>
  );
}

function FileResults({ controller, params, onOpen }: { controller: AppController; params: SearchParams; onOpen: (message: MessageOut) => void }) {
  const [items, setItems] = useState<FileItem[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const load = async (more: boolean) => {
    const api = controller.api;
    if (!api) return;
    setLoading(true);
    try {
      const page = await api.listFiles({ channelId: params.channelId, q: params.q.trim() || null, cursor: more ? cursor : null, limit: 50 });
      setItems((current) => (more && current ? [...current, ...page.items] : page.items));
      setCursor(page.next_cursor ?? null);
    } catch (error) {
      controller.setError(error);
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => {
    setItems(null);
    void load(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params.q, params.channelId, controller.api]);
  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
      {items === null ? (
        <div className="py-8 text-center text-sm text-muted">検索しています…</div>
      ) : items.length === 0 ? (
        <div className="mx-auto flex max-w-md flex-col items-center py-16 text-center">
          <SearchX size={40} className="text-muted/60" />
          <div className="mt-3 text-base font-semibold">ファイルは見つかりませんでした</div>
          <p className="mt-1 text-sm text-muted">ファイル名で探します。</p>
        </div>
      ) : (
        <ul className="mx-auto max-w-3xl divide-y divide-line rounded-xl border border-line">
          {items.map((item) => <FileRow key={item.attachment.id} item={item} controller={controller} onOpen={onOpen} />)}
          {cursor && (
            <li className="py-2 text-center">
              <Button variant="secondary" size="sm" disabled={loading} onClick={() => void load(true)}>さらに読み込む</Button>
            </li>
          )}
        </ul>
      )}
    </div>
  );
}
