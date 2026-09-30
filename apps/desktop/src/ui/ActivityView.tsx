import { AtSign, Bell, MessagesSquare, MoreHorizontal, SmilePlus } from "lucide-react";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";

import type { ActivityFilter, ActivityItem, MessageOut } from "../api/types";
import type { AppController } from "../state/app";
import type { ThreadEntry } from "../sync/types";
import { ACTIVITY_FILTER_LABELS, ACTIVITY_FILTERS, activityEmptyText, activityHeadline, activityHeadlineText, activityKey, appendActivityPage, isActivityUnread, movesActivityRead, newestActivityAt } from "./activity";
import { Avatar } from "./Avatar";
import { CustomEmojiImage, customEmojiName } from "./customEmoji";
import { fullTimestamp } from "./format";
import { channelTitle } from "./MainScreen";
import { plainText } from "./markdown";
import { mentionsToNames } from "./mentions";
import { MentionsView } from "./MentionsView";
import { dmTimeLabel } from "./mobileTabs";
import { Button, cn, Menu, MenuContent, MenuItem, MenuTrigger } from "./primitives";
import { ThreadsView } from "./ThreadsView";

export type ActivitySegment = "mentions" | "threads";

/** Rows per GET /activity page. */
export const ACTIVITY_PAGE = 50;
/** How long the rows stay on screen before the activity counts as read up to the newest of them. */
export const ACTIVITY_READ_DELAY_MS = 1_500;

/**
 * The activity: the phone's アクティビティ tab and the wide layout's 「アクティビティ」 view. With a server of M39 or later
 * (bootstrap `activity`), stage B (MOBILE_UI.md §6.4): [すべて | メンション | スレッド | リアクション] over GET /activity.
 * A server before it: stage A (M34), [メンション | スレッド] over the mentions list and the followed threads.
 */
export function ActivityView({ controller, active, onOpen, onOpenMessage, onOpenThread }: {
  controller: AppController;
  /** On screen now (the selected tab's root, or the wide layout's centre view): the rows count as seen. */
  active: boolean;
  /** Stage B: a row opens its message (in its conversation, or its thread). */
  onOpen: (item: ActivityItem) => void;
  /** Stage A: a mention opens its message, a thread row its thread. */
  onOpenMessage: (message: MessageOut) => void;
  onOpenThread: (entry: ThreadEntry) => void;
}) {
  if (controller.store.activity === null) return <ActivityStageA controller={controller} onOpenMessage={onOpenMessage} onOpenThread={onOpenThread} />;
  return <ActivityFeed controller={controller} active={active} onOpen={onOpen} />;
}

interface ActivityList {
  items: ActivityItem[];
  cursor: string | null;
  loading: boolean;
}

/** Whether the page itself is on screen (not a background browser tab or a hidden window). */
function usePageVisible(): boolean {
  return useSyncExternalStore(
    (listener) => {
      document.addEventListener("visibilitychange", listener);
      return () => document.removeEventListener("visibilitychange", listener);
    },
    () => document.visibilityState !== "hidden",
  );
}

/**
 * Stage B (M39). The dots compare with the read position when the view came on screen, so they stay while looking;
 * the badge clears once the newest row shown has been on screen for a moment (PUT /activity/read). New activity while
 * on screen (the badge rises) brings the first page again.
 */
function ActivityFeed({ controller, active, onOpen }: { controller: AppController; active: boolean; onOpen: (item: ActivityItem) => void }) {
  const store = controller.store;
  const summary = store.activity;
  const [filter, setFilter] = useState<ActivityFilter>("all");
  const [lists, setLists] = useState<Partial<Record<ActivityFilter, ActivityList>>>({});
  const [failed, setFailed] = useState(false);
  /** The read position the dots compare with: taken when the view comes on screen, and by 「すべて既読」. */
  const [seenFrom, setSeenFrom] = useState<string | null>(() => summary?.read_at ?? null);
  const requests = useRef<Partial<Record<ActivityFilter, number>>>({});
  const visible = usePageVisible();
  const onScreen = active && visible;
  const list = lists[filter];
  const status = controller.engine?.status;
  const unread = summary?.unread_count ?? 0;

  const load = async (which: ActivityFilter, more = false) => {
    const api = controller.api;
    if (!api) return;
    const cursor = more ? lists[which]?.cursor ?? null : null;
    if (more && !cursor) return;
    const request = (requests.current[which] ?? 0) + 1;
    requests.current[which] = request;
    setLists((current) => ({ ...current, [which]: { items: current[which]?.items ?? [], cursor: current[which]?.cursor ?? null, loading: true } }));
    try {
      const page = await api.listActivity({ filter: which, cursor, limit: ACTIVITY_PAGE });
      if (requests.current[which] !== request) return; // a newer load of this list answers instead
      setFailed(false);
      setSeenFrom((current) => current ?? page.read_at);
      setLists((current) => ({
        ...current,
        [which]: { items: more ? appendActivityPage(current[which]?.items ?? [], page.items) : page.items, cursor: page.next_cursor ?? null, loading: false },
      }));
    } catch (error) {
      if (requests.current[which] !== request) return;
      setLists((current) => ({ ...current, [which]: { items: current[which]?.items ?? [], cursor: current[which]?.cursor ?? null, loading: false } }));
      setFailed(true);
      controller.setError(error);
    }
  };

  // On screen again: the dots start from the read position now (what was seen last time is read).
  const wasActive = useRef(false);
  useEffect(() => {
    if (active && !wasActive.current) setSeenFrom(store.activity?.read_at ?? null);
    wasActive.current = active;
  }, [active]);

  // The first page of the list on screen: when it comes on screen, on another filter and after reconnecting …
  useEffect(() => {
    if (!active || status === "connecting" || status === "offline") return;
    void load(filter);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, filter, status, controller.api]);
  // … and when new activity arrives while it is looked at (the badge rises; reading it lowers it, which loads nothing).
  const lastUnread = useRef(unread);
  useEffect(() => {
    const rose = unread > lastUnread.current;
    lastUnread.current = unread;
    if (rose && active && status === "online") void load(filter);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [unread]);

  // Being on screen reads the activity up to the newest row shown (the rows' dots stay until the view is left).
  const newest = newestActivityAt(list?.items ?? []);
  const readAt = summary?.read_at ?? null;
  useEffect(() => {
    if (!onScreen || !movesActivityRead(newest, readAt)) return;
    const timer = setTimeout(() => void controller.markActivityRead(newest!), ACTIVITY_READ_DELAY_MS);
    return () => clearTimeout(timer);
  }, [onScreen, newest, readAt, controller]);

  const markAllRead = async () => {
    const at = Math.max(Date.now(), Date.parse(newestActivityAt(Object.values(lists).flatMap((l) => l?.items ?? [])) ?? "") || 0);
    if (await controller.markActivityRead(new Date(at).toISOString())) setSeenFrom(controller.store.activity?.read_at ?? new Date(at).toISOString());
  };

  const items = list?.items ?? [];
  return (
    <section aria-label="アクティビティ" className="flex min-h-0 flex-1 flex-col bg-canvas">
      <header className="flex h-[52px] shrink-0 items-center gap-2 border-b border-line px-4 max-md:pr-2">
        <span className="text-muted max-md:hidden"><Bell size={18} /></span>
        <strong className="min-w-0 flex-1 truncate text-[17px] md:text-[15px]">アクティビティ</strong>
        <Menu>
          <MenuTrigger asChild>
            <button type="button" aria-label="アクティビティのメニュー" title="アクティビティのメニュー" className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-ink transition-colors hover:bg-ink/6">
              <MoreHorizontal size={18} />
            </button>
          </MenuTrigger>
          <MenuContent align="end">
            <MenuItem onSelect={() => void markAllRead()}>すべて既読</MenuItem>
          </MenuContent>
        </Menu>
      </header>
      <div className="shrink-0 px-3 py-2">
        <div className="mx-auto flex max-w-3xl rounded-xl bg-panel p-1 text-[13px] font-medium md:text-sm" role="radiogroup" aria-label="表示する項目">
          {ACTIVITY_FILTERS.map((value) => (
            <button
              key={value}
              type="button"
              role="radio"
              aria-checked={filter === value}
              onClick={() => setFilter(value)}
              className={cn("flex h-9 min-w-0 flex-1 items-center justify-center rounded-lg px-0.5 transition-colors", filter === value ? "bg-canvas text-ink shadow-sm" : "text-muted hover:text-ink")}
            >
              <span className="truncate">{ACTIVITY_FILTER_LABELS[value]}</span>
            </button>
          ))}
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto pb-3">
        {list === undefined || (list.loading && items.length === 0 && !failed) ? (
          <div className="py-8 text-center text-sm text-muted">読み込み中…</div>
        ) : items.length === 0 ? (
          failed ? (
            <div className="flex flex-col items-center gap-3 py-16 text-sm text-muted">
              読み込めませんでした
              <Button variant="secondary" size="sm" onClick={() => void load(filter)}>再読み込み</Button>
            </div>
          ) : (
            <div className="py-16 text-center text-sm text-muted">{activityEmptyText(filter)}</div>
          )
        ) : (
          <ul className="mx-auto max-w-3xl" aria-label={`${ACTIVITY_FILTER_LABELS[filter]}のアクティビティ`}>
            {items.map((item) => (
              <li key={activityKey(item)}>
                <ActivityRow controller={controller} item={item} unread={isActivityUnread(item, seenFrom)} onOpen={() => onOpen(item)} />
              </li>
            ))}
            {list.cursor && (
              <li className="py-2 text-center">
                <Button variant="secondary" size="sm" disabled={list.loading} onClick={() => void load(filter, true)}>さらに読み込む</Button>
              </li>
            )}
          </ul>
        )}
      </div>
    </section>
  );
}

const KIND_ICON = {
  mention: { Icon: AtSign, className: "bg-rose-500" },
  thread_reply: { Icon: MessagesSquare, className: "bg-accent" },
  reaction: { Icon: SmilePlus, className: "bg-amber-500" },
} as const;

/** One item: who (their pictures) did what, where and when, and the message's opening words. */
function ActivityRow({ controller, item, unread, onOpen }: { controller: AppController; item: ActivityItem; unread: boolean; onOpen: () => void }) {
  const store = controller.store;
  const nameOf = (id: string) => store.users.get(id)?.display_name ?? "メンバー";
  const { who, what } = activityHeadline(item, nameOf);
  const channel = store.getChannel(item.message.channel_id);
  const where = channel ? channelTitle(channel, controller) : "";
  const message = item.message;
  const excerpt = message.deleted ? "(削除されたメッセージ)" : plainText(mentionsToNames(message.body, store.users, store.groups), 200) || message.attachments.map((a) => a.filename).join(", ");
  const actors = item.actor_ids.slice(0, 3);
  const { Icon, className: iconClass } = KIND_ICON[item.kind];
  return (
    <button
      type="button"
      onClick={onOpen}
      data-activity={item.kind}
      data-unread={unread || undefined}
      aria-label={`${unread ? "未読 " : ""}${activityHeadlineText(item, nameOf)}${where ? ` · ${where}` : ""}`}
      className="flex w-full items-start gap-2 px-3 py-2.5 text-left transition-colors hover:bg-panel active:bg-panel md:rounded-xl"
    >
      <span className="flex w-2.5 shrink-0 justify-center pt-4" aria-hidden="true">
        {unread && <span className="h-2 w-2 rounded-full bg-accent" />}
      </span>
      <span className="relative shrink-0" aria-hidden="true">
        {actors.length > 1 ? (
          <span className="relative block h-10 w-10">
            {actors.slice(0, 2).map((id, index) => (
              <Avatar key={id} id={id} name={nameOf(id)} size={28} className={cn("absolute rounded-lg text-[11px] ring-2 ring-canvas", index === 0 ? "left-0 top-0" : "bottom-0 right-0")} />
            ))}
          </span>
        ) : (
          <Avatar id={actors[0] ?? message.sender_id} name={nameOf(actors[0] ?? message.sender_id)} size={40} className="rounded-xl" />
        )}
        <span className={cn("absolute -bottom-1 -right-1 flex h-[18px] w-[18px] items-center justify-center rounded-full text-white ring-2 ring-canvas", iconClass)}>
          <Icon size={11} strokeWidth={2.6} />
        </span>
      </span>
      <span className="min-w-0 flex-1 pl-1">
        <span className="flex items-baseline gap-2">
          <span className={cn("min-w-0 flex-1 truncate text-[14px]", unread ? "text-ink" : "text-ink/90")}>
            <strong className="font-semibold">{who}</strong>{what}
            {item.kind === "reaction" && (
              <span className="ml-1 inline-flex items-center gap-0.5 align-middle">
                {(item.emojis ?? []).map((emoji) => {
                  const name = customEmojiName(emoji);
                  const custom = name ? store.customEmoji.get(name) : undefined;
                  return custom ? <CustomEmojiImage key={emoji} controller={controller} emoji={custom} size={16} /> : <span key={emoji}>{emoji}</span>;
                })}
              </span>
            )}
          </span>
          <time dateTime={item.at} title={fullTimestamp(item.at)} className="shrink-0 text-xs text-muted">{dmTimeLabel(item.at)}</time>
        </span>
        {where && <span className="block truncate text-xs text-muted">{item.kind === "thread_reply" ? `${where} のスレッド` : where}</span>}
        <span className="mt-0.5 line-clamp-2 text-[13.5px] leading-snug text-ink/80">{item.kind === "reaction" ? `「${excerpt}」` : excerpt}</span>
      </span>
    </button>
  );
}

/**
 * M34, stage A (MOBILE_UI.md §6.4), for a server before M39: [メンション | スレッド] over the existing mentions list and
 * followed-threads list. A row opens its message / thread on this tab's stack (the caller's `onOpenMessage` /
 * `onOpenThread`).
 */
function ActivityStageA({ controller, onOpenMessage, onOpenThread }: {
  controller: AppController;
  onOpenMessage: (message: MessageOut) => void;
  onOpenThread: (entry: ThreadEntry) => void;
}) {
  const [segment, setSegment] = useState<ActivitySegment>("mentions");
  const [threadsShown, setThreadsShown] = useState(false);
  const summary = controller.store.threadSummary;
  return (
    <section aria-label="アクティビティ" className="flex min-h-0 flex-1 flex-col bg-canvas">
      <header className="flex h-[52px] shrink-0 items-center border-b border-line px-4">
        <strong className="truncate text-[17px]">アクティビティ</strong>
      </header>
      <div className="shrink-0 px-3 py-2">
        <div className="flex rounded-xl bg-panel p-1 text-sm font-medium" role="radiogroup" aria-label="表示する項目">
          {(["mentions", "threads"] as const).map((value) => (
            <button
              key={value}
              type="button"
              role="radio"
              aria-checked={segment === value}
              onClick={() => {
                setSegment(value);
                if (value === "threads") setThreadsShown(true);
              }}
              className={cn("flex h-9 flex-1 items-center justify-center gap-1.5 rounded-lg transition-colors", segment === value ? "bg-canvas text-ink shadow-sm" : "text-muted hover:text-ink")}
            >
              {value === "mentions" ? "メンション" : "スレッド"}
              {value === "threads" && summary.unread_count > 0 && (
                <span className={cn("rounded-full px-1.5 text-[11px] font-bold leading-4 text-white", summary.mention_count > 0 ? "bg-rose-500" : "bg-muted")}>{summary.unread_count}</span>
              )}
            </button>
          ))}
        </div>
      </div>
      {/* Both stay mounted once shown: the other segment keeps its rows and scroll position. */}
      <div className="flex min-h-0 flex-1 flex-col" hidden={segment !== "mentions"}>
        <MentionsView controller={controller} onOpen={onOpenMessage} embedded />
      </div>
      {threadsShown && (
        <div className="flex min-h-0 flex-1 flex-col" hidden={segment !== "threads"}>
          <ThreadsView controller={controller} selectedId={null} onOpen={onOpenThread} embedded />
        </div>
      )}
    </section>
  );
}
