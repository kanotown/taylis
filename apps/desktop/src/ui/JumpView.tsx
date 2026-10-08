import { ArrowLeft, AtSign, Clock, Hash, Lock, Search, Users, X } from "lucide-react";
import { type KeyboardEvent, type ReactNode, useEffect, useRef, useState } from "react";

import type { ChannelOut, MessageOut, SearchHit } from "../api/types";
import type { AppController } from "../state/app";
import type { ChannelState, UserPublic } from "../sync/types";
import { AiBadge } from "./ai";
import { Avatar } from "./Avatar";
import { badgeCount, hasUnread, isDmChannel, isMutedChannel } from "./channels";
import { jumpConversations, jumpPeople } from "./home";
import { isImeKeyEvent } from "./ime";
import { LiveMessageRow, LiveStatus, useLiveSearch } from "./LiveSearch";
import { channelTitle } from "./MainScreen";
import { Badge, cn, IconButton } from "./primitives";
import { describeSearch } from "./SearchBar";
import { EMPTY_SEARCH, type SearchParams } from "./search";
import { t } from "../i18n";
import { tRich } from "../i18n/rich";

type Row =
  | { kind: "conversation"; channel: ChannelState }
  | { kind: "person"; user: UserPublic }
  | { kind: "bot"; user: UserPublic }
  | { kind: "recent-search"; params: SearchParams }
  /** A live message result (LiveSearch.tsx): the message in its conversation. */
  | { kind: "message"; hit: SearchHit }
  | { kind: "search"; q: string };

/**
 * M37, 「移動・検索」 (MOBILE_UI.md §6.2), over the whole phone screen. Empty: the recent conversations of this device and
 * the recent searches (M16b). Typing: the conversations (at most 20) and the people (at most 10) by the shared
 * jump-match rule, the few best messages as you type (live results, LiveSearch.tsx), and last 「"語" をメッセージ検索」
 * (the search results screen). Esc or ← closes it. The Enter confirming an IME conversion does nothing (ime.ts).
 */
export function JumpView({ controller, recentIds, recentSearches, onOpen, onOpenPerson, onSearch, onOpenMessage, onRemoveRecentSearch, onClose }: {
  controller: AppController;
  /** Recent conversation ids, newest first (home.ts). */
  recentIds: readonly string[];
  recentSearches: readonly SearchParams[];
  onOpen: (channelId: string) => void;
  /** A person: the DM with them (with me: my own DM). */
  onOpenPerson: (userId: string) => void;
  onSearch: (params: SearchParams) => void;
  /** A live result: the message in its conversation (`other`: its channel when I am not a member; `q`: the words). */
  onOpenMessage?: (message: MessageOut, other: ChannelOut | undefined, q: string) => void;
  onRemoveRecentSearch: (params: SearchParams) => void;
  onClose: () => void;
}) {
  const store = controller.store;
  const meId = store.me?.id ?? controller.me?.id ?? null;
  const [text, setText] = useState("");
  const [active, setActive] = useState(0);
  const [composing, setComposing] = useState(false);
  const [moved, setMoved] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const live = useLiveSearch(controller, onOpenMessage ? text : "", composing);
  useEffect(() => {
    input.current?.focus();
  }, []);

  const query = text.trim();
  const title = (c: ChannelState) => channelTitle(c, controller).replace(/^#/, "");
  const context = { users: store.users, meId, me: store.me ?? controller.me, title };
  const conversations: ChannelState[] = query
    ? jumpConversations(query, store.channels.values(), context)
    : recentIds.map((id) => store.getChannel(id)).filter((c): c is ChannelState => !!c && c.isMember && !c.archived);
  const { people, bots } = jumpPeople(query, store.users.values(), undefined, new Set(store.aiStatus?.agents.map((a) => a.bot_user_id)));
  const rows: Row[] = [
    ...conversations.map((channel) => ({ kind: "conversation", channel }) as const),
    ...people.map((user) => ({ kind: "person", user }) as const),
    ...bots.map((user) => ({ kind: "bot", user }) as const),
    ...(query && onOpenMessage ? live.hits.map((hit) => ({ kind: "message", hit }) as const) : []),
    ...(query ? [{ kind: "search", q: query } as const] : recentSearches.map((params) => ({ kind: "recent-search", params }) as const)),
  ];
  // The first row is what Enter (Go) opens, except a live message: until ↑ / ↓ pick one, Enter searches the words.
  const first = Math.min(active, rows.length - 1);
  const current = !moved && rows[first]?.kind === "message" ? rows.findIndex((row) => row.kind === "search") : first;

  const choose = (row: Row) => {
    switch (row.kind) {
      case "conversation":
        return onOpen(row.channel.id);
      case "person":
      case "bot":
        return onOpenPerson(row.user.id);
      case "recent-search":
        return onSearch(row.params);
      case "message":
        return onOpenMessage?.(row.hit.message, live.channels[row.hit.message.channel_id], query);
      case "search":
        return onSearch({ ...EMPTY_SEARCH, q: row.q });
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (isImeKeyEvent(event)) return; // the IME's keys (and its confirming Enter): no moving or opening
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      onClose();
    } else if ((event.key === "ArrowDown" || event.key === "ArrowUp") && rows.length > 0) {
      event.preventDefault();
      setActive((Math.max(0, current) + (event.key === "ArrowDown" ? 1 : rows.length - 1)) % rows.length);
      setMoved(true);
    } else if (event.key === "Enter") {
      event.preventDefault();
      const row = rows[current];
      if (row) choose(row);
    }
  };

  const heading = (index: number): string | null => {
    const group = (row: Row | undefined) => (!row ? null : row.kind === "conversation" ? "c" : row.kind === "person" ? "p" : row.kind === "bot" ? "b" : row.kind === "recent-search" ? "r" : row.kind === "message" ? "m" : "s");
    const here = group(rows[index]);
    if (here === group(rows[index - 1])) return null;
    if (here === "m") return t("searchBar.messages");
    if (here === "c") return query ? t("ask.conversation") : t("jump.recentConversations");
    if (here === "p") return t("jump.people");
    if (here === "b") return t("jump.bots");
    if (here === "r") return t("searchBar.recent");
    return null;
  };

  return (
    <section role="dialog" aria-label={t("home.jumpSearch")} className="fixed inset-0 z-40 flex flex-col bg-canvas text-ink" onKeyDown={(e) => { if (e.key === "Escape" && !isImeKeyEvent(e)) { e.stopPropagation(); onClose(); } }}>
      <div className="flex h-[52px] shrink-0 items-center gap-1 border-b border-line pl-2 pr-3">
        <IconButton label={t("common.back")} className="h-11 w-11" onClick={onClose}>
          <ArrowLeft size={20} />
        </IconButton>
        <label className="flex h-10 min-w-0 flex-1 items-center gap-2 rounded-xl bg-panel px-3 text-muted">
          <Search size={16} className="shrink-0" />
          <input
            ref={input}
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              setActive(0);
              setMoved(false);
            }}
            onCompositionStart={() => setComposing(true)}
            onCompositionEnd={() => setComposing(false)}
            onKeyDown={onKeyDown}
            placeholder={t("jump.placeholder")}
            aria-label={t("home.jumpSearch")}
            enterKeyHint="go"
            className="min-w-0 flex-1 bg-transparent text-[15px] text-ink outline-none placeholder:text-muted"
          />
          {text && (
            <button type="button" aria-label={t("searchBar.clear")} className="rounded p-1 text-muted hover:text-ink" onClick={() => { setText(""); input.current?.focus(); }}>
              <X size={15} />
            </button>
          )}
        </label>
      </div>
      <ul className="min-h-0 flex-1 overflow-y-auto py-1">
        {rows.map((row, index) => {
          const head = heading(index);
          // Searching / nothing found / an error: a quiet line where the messages would be.
          const status = row.kind === "search" && !!onOpenMessage && live.hits.length === 0 && live.status !== "idle";
          return (
            <li key={rowKey(row, index)}>
              {status && (
                <>
                  <div className="px-4 pb-1 pt-3 text-[12px] font-semibold text-muted">{t("searchBar.messages")}</div>
                  <div className="px-2"><LiveStatus live={live} /></div>
                </>
              )}
              {head && <div className="px-4 pb-1 pt-3 text-[12px] font-semibold text-muted">{head}</div>}
              <div className={cn("group flex items-center", index === current && "bg-accent-soft/70")} onMouseEnter={() => { setActive(index); setMoved(true); }}>
                <button type="button" data-jump-row={row.kind} onClick={() => choose(row)} className="flex min-h-11 min-w-0 flex-1 items-center gap-3 px-4 py-1.5 text-left text-[15px]">
                  {row.kind === "message" ? (
                    <LiveMessageRow controller={controller} message={row.hit.message} keywords={live.keywords} other={live.channels[row.hit.message.channel_id]} />
                  ) : (
                    <JumpRowBody controller={controller} row={row} meId={meId} />
                  )}
                </button>
                {row.kind === "recent-search" && (
                  <button type="button" aria-label={t("searchBar.removeHistory")} className="mr-2 rounded p-2 text-muted hover:text-ink" onClick={() => onRemoveRecentSearch(row.params)}>
                    <X size={14} />
                  </button>
                )}
              </div>
            </li>
          );
        })}
        {rows.length === 0 && <li className="px-6 py-12 text-center text-sm text-muted">{t("jump.hint")}</li>}
      </ul>
    </section>
  );
}

function rowKey(row: Row, index: number): string {
  switch (row.kind) {
    case "conversation":
      return `c:${row.channel.id}`;
    case "person":
    case "bot":
      return `p:${row.user.id}`;
    case "message":
      return `m:${row.hit.message.id}`;
    default:
      return `${row.kind}:${index}`;
  }
}

function JumpRowBody({ controller, row, meId }: { controller: AppController; row: Row; meId: string | null }): ReactNode {
  const store = controller.store;
  switch (row.kind) {
    case "conversation":
      return <ConversationRowBody controller={controller} channel={row.channel} meId={meId} />;
    case "person":
    case "bot":
      return (
        <>
          <Avatar id={row.user.id} name={row.user.display_name} size={24} className="rounded-md text-[10px]" presence={row.kind === "bot" ? undefined : store.presenceOf(row.user.id)} presenceClassName="border border-canvas" />
          <span className="min-w-0 truncate">{row.user.display_name}</span>
          {row.kind === "bot" && <AiBadge />}
          <span className="min-w-0 shrink truncate text-[13px] text-muted">@{row.user.username}{row.user.id === meId ? ` ${t("tasks.dialog.me")}` : ""}</span>
        </>
      );
    case "recent-search":
      return (
        <>
          <span className="flex w-6 shrink-0 justify-center text-muted"><Clock size={18} /></span>
          <span className="min-w-0 truncate">{describeSearch(controller, row.params)}</span>
        </>
      );
    case "message":
      return null; // drawn by LiveMessageRow
    case "search":
      return (
        <>
          <span className="flex w-6 shrink-0 justify-center text-muted"><Search size={18} /></span>
          <span className="min-w-0 truncate">
            {tRich("jump.searchFor", { b: (s) => <strong>{s}</strong> }, { q: row.q })}
          </span>
        </>
      );
  }
}

/** A conversation as the jump and picker lists show it: its glyph or picture, the name, unread bold with its count. */
export function ConversationRowBody({ controller, channel, meId }: { controller: AppController; channel: ChannelState; meId: string | null }) {
  const store = controller.store;
  const unread = hasUnread(channel, meId);
  const badge = badgeCount(channel);
  const others = (channel.dm_user_ids ?? []).filter((id) => id !== meId);
  const other = isDmChannel(channel) ? (others[0] ?? meId ?? undefined) : undefined;
  return (
    <>
      <span className="flex w-6 shrink-0 justify-center text-muted">
        {isDmChannel(channel) ? (
          others.length > 1 ? <Users size={20} /> : other ? <Avatar id={other} name={store.users.get(other)?.display_name ?? "?"} size={24} className="rounded-md text-[10px]" /> : <AtSign size={20} />
        ) : channel.type === "private" ? (
          <Lock size={20} />
        ) : (
          <Hash size={20} />
        )}
      </span>
      <span className={cn("min-w-0 flex-1 truncate", unread && "font-bold", isMutedChannel(channel) && !unread && "opacity-55")}>{channelTitle(channel, controller).replace(/^#/, "")}</span>
      {unread && badge > 0 ? <Badge tone="danger">{badge}</Badge> : unread ? <span className="h-2 w-2 shrink-0 rounded-full bg-accent" aria-label={t("sidebar.unread")} /> : null}
    </>
  );
}
