import { ArrowLeft, AtSign, Clock, Hash, Lock, Search, Users, X } from "lucide-react";
import { type KeyboardEvent, type ReactNode, useEffect, useRef, useState } from "react";

import type { AppController } from "../state/app";
import type { ChannelState, UserPublic } from "../sync/types";
import { Avatar } from "./Avatar";
import { badgeCount, hasUnread, isDmChannel, isMutedChannel } from "./channels";
import { jumpConversations, jumpPeople } from "./home";
import { channelTitle } from "./MainScreen";
import { Badge, cn, IconButton } from "./primitives";
import { describeSearch } from "./SearchBar";
import { EMPTY_SEARCH, type SearchParams } from "./search";
import { t } from "../i18n";
import { tRich } from "../i18n/rich";

type Row =
  | { kind: "conversation"; channel: ChannelState }
  | { kind: "person"; user: UserPublic }
  | { kind: "recent-search"; params: SearchParams }
  | { kind: "search"; q: string };

/**
 * M37, 「移動・検索」 (MOBILE_UI.md §6.2), over the whole phone screen. Empty: the recent conversations of this device and
 * the recent searches (M16b). Typing: the conversations (at most 20) and the people (at most 10) by the shared
 * jump-match rule, and last 「"語" をメッセージ検索」 (the search results screen). Esc or ← closes it.
 */
export function JumpView({ controller, recentIds, recentSearches, onOpen, onOpenPerson, onSearch, onRemoveRecentSearch, onClose }: {
  controller: AppController;
  /** Recent conversation ids, newest first (home.ts). */
  recentIds: readonly string[];
  recentSearches: readonly SearchParams[];
  onOpen: (channelId: string) => void;
  /** A person: the DM with them (with me: my own DM). */
  onOpenPerson: (userId: string) => void;
  onSearch: (params: SearchParams) => void;
  onRemoveRecentSearch: (params: SearchParams) => void;
  onClose: () => void;
}) {
  const store = controller.store;
  const meId = store.me?.id ?? controller.me?.id ?? null;
  const [text, setText] = useState("");
  const [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    input.current?.focus();
  }, []);

  const query = text.trim();
  const title = (c: ChannelState) => channelTitle(c, controller).replace(/^#/, "");
  const context = { users: store.users, meId, me: store.me ?? controller.me, title };
  const conversations: ChannelState[] = query
    ? jumpConversations(query, store.channels.values(), context)
    : recentIds.map((id) => store.getChannel(id)).filter((c): c is ChannelState => !!c && c.isMember && !c.archived);
  const people = query ? jumpPeople(query, store.users.values()) : [];
  const rows: Row[] = [
    ...conversations.map((channel) => ({ kind: "conversation", channel }) as const),
    ...people.map((user) => ({ kind: "person", user }) as const),
    ...(query ? [{ kind: "search", q: query } as const] : recentSearches.map((params) => ({ kind: "recent-search", params }) as const)),
  ];
  const current = Math.min(active, rows.length - 1);

  const choose = (row: Row) => {
    switch (row.kind) {
      case "conversation":
        return onOpen(row.channel.id);
      case "person":
        return onOpenPerson(row.user.id);
      case "recent-search":
        return onSearch(row.params);
      case "search":
        return onSearch({ ...EMPTY_SEARCH, q: row.q });
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      onClose();
    } else if ((event.key === "ArrowDown" || event.key === "ArrowUp") && rows.length > 0) {
      event.preventDefault();
      setActive((i) => (Math.max(0, Math.min(i, rows.length - 1)) + (event.key === "ArrowDown" ? 1 : rows.length - 1)) % rows.length);
    } else if (event.key === "Enter" && !event.nativeEvent.isComposing) {
      event.preventDefault();
      const row = rows[current];
      if (row) choose(row);
    }
  };

  const heading = (index: number): string | null => {
    const group = (row: Row | undefined) => (!row ? null : row.kind === "conversation" ? "c" : row.kind === "person" ? "p" : row.kind === "recent-search" ? "r" : "s");
    const here = group(rows[index]);
    if (here === group(rows[index - 1])) return null;
    if (here === "c") return query ? t("ask.conversation") : t("jump.recentConversations");
    if (here === "p") return t("jump.people");
    if (here === "r") return t("searchBar.recent");
    return null;
  };

  return (
    <section role="dialog" aria-label={t("home.jumpSearch")} className="fixed inset-0 z-40 flex flex-col bg-canvas text-ink" onKeyDown={(e) => { if (e.key === "Escape") { e.stopPropagation(); onClose(); } }}>
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
            }}
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
          return (
            <li key={rowKey(row, index)}>
              {head && <div className="px-4 pb-1 pt-3 text-[12px] font-semibold text-muted">{head}</div>}
              <div className={cn("group flex items-center", index === current && "bg-accent-soft/70")} onMouseEnter={() => setActive(index)}>
                <button type="button" data-jump-row={row.kind} onClick={() => choose(row)} className="flex min-h-11 min-w-0 flex-1 items-center gap-3 px-4 py-1.5 text-left text-[15px]">
                  <JumpRowBody controller={controller} row={row} meId={meId} />
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
      return `p:${row.user.id}`;
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
      return (
        <>
          <Avatar id={row.user.id} name={row.user.display_name} size={24} className="rounded-md text-[10px]" presence={store.presenceOf(row.user.id)} presenceClassName="border border-canvas" />
          <span className="min-w-0 truncate">{row.user.display_name}</span>
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
