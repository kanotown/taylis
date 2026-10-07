import { AtSign, Bell, CheckCheck, MessagesSquare, SmilePlus } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import type { ActivityFilter, ActivityItem, MessageOut } from "../api/types";
import type { AppController } from "../state/app";
import type { MessageState, ThreadEntry } from "../sync/types";
import { ACTIVITY_FILTER_LABELS, ACTIVITY_FILTERS, activityEmptyText, activityHeadline, activityHeadlineText, activityKey, appendActivityPage, isActivityUnread, isShownActivity, newestActivityAt, type ReadPositions } from "./activity";
import { Avatar } from "./Avatar";
import { CustomEmojiImage, customEmojiName } from "./customEmoji";
import { fullTimestamp } from "./format";
import { channelTitle } from "./MainScreen";
import { plainText } from "./markdown";
import { mentionsToNames } from "./mentions";
import { MentionsView } from "./MentionsView";
import { dmTimeLabel } from "./mobileTabs";
import { Button, cn } from "./primitives";
import { ThreadsView } from "./ThreadsView";
import { EmojiText } from "./UserPopover";
import { t } from "../i18n";

export type ActivitySegment = "mentions" | "threads";

/** Rows per GET /activity page. */
export const ACTIVITY_PAGE = 50;

/**
 * The activity: the phone's アクティビティ tab and the wide layout's 「アクティビティ」 view. With a server of M39 or later
 * (bootstrap `activity`), stage B (MOBILE_UI.md §6.4): [すべて | メンション | スレッド | リアクション] over GET /activity.
 * A server before it: stage A (M34), [メンション | スレッド] over the mentions list and the followed threads.
 */
export function ActivityView({ controller, active, onOpen, onOpenMessage, onOpenThread }: {
  controller: AppController;
  /** On screen now (the selected tab's root, or the wide layout's centre view): the list loads (nothing is read by it). */
  active: boolean;
  /** Stage B: a row opens its message (in its conversation, or its thread). */
  onOpen: (item: ActivityItem) => void;
  /** Stage A: a mention opens its message, a thread row its thread. */
  onOpenMessage: (message: MessageOut) => void;
  onOpenThread: (entry: ThreadEntry, reply?: MessageState) => void;
}) {
  if (controller.store.activity === null) return <ActivityStageA controller={controller} onOpenMessage={onOpenMessage} onOpenThread={onOpenThread} />;
  return <ActivityFeed controller={controller} active={active} onOpen={onOpen} />;
}

interface ActivityList {
  items: ActivityItem[];
  cursor: string | null;
  loading: boolean;
  /** The read position the server answered with (its items' `read` flags were counted against it). */
  readAt?: string | null;
}

/**
 * Stage B (M39). Since 2026-10-07 (MOBILE_UI.md §6.4, like Slack) looking reads nothing: an item stays unread (bold,
 * a dot, counted in 「未読 n 件」 and the badge) until it is opened (a click: PUT /activity/items/read), read in its
 * conversation (a mention, a reply), done (a reservation to-do), or 「すべて既読にする」 (PUT /activity/read). New
 * activity while on screen (the badge rises) brings the first page again.
 */
function ActivityFeed({ controller, active, onOpen }: { controller: AppController; active: boolean; onOpen: (item: ActivityItem) => void }) {
  const store = controller.store;
  const summary = store.activity;
  const [filter, setFilter] = useState<ActivityFilter>("all");
  const [lists, setLists] = useState<Partial<Record<ActivityFilter, ActivityList>>>({});
  const [failed, setFailed] = useState(false);
  /** 「未読のみ」: the rows held, less the read ones (a row opened goes from the list). */
  const [unreadOnly, setUnreadOnly] = useState(false);
  const requests = useRef<Partial<Record<ActivityFilter, number>>>({});
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
    setLists((current) => ({ ...current, [which]: { ...current[which], items: current[which]?.items ?? [], cursor: current[which]?.cursor ?? null, loading: true } }));
    try {
      const answer = await api.listActivity({ filter: which, cursor, limit: ACTIVITY_PAGE });
      // A kind this version cannot show (a newer server) is skipped; the cursor still walks past it.
      const page = { ...answer, items: answer.items.filter(isShownActivity) };
      if (requests.current[which] !== request) return; // a newer load of this list answers instead
      setFailed(false);
      setLists((current) => ({
        ...current,
        [which]: { items: more ? appendActivityPage(current[which]?.items ?? [], page.items) : page.items, cursor: page.next_cursor ?? null, loading: false, readAt: more ? current[which]?.readAt ?? page.read_at : page.read_at },
      }));
    } catch (error) {
      if (requests.current[which] !== request) return;
      setLists((current) => ({ ...current, [which]: { ...current[which], items: current[which]?.items ?? [], cursor: current[which]?.cursor ?? null, loading: false } }));
      setFailed(true);
      controller.setError(error);
    }
  };

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

  // MOBILE_UI.md §6.4: a conversation's read position went back (「ここから未読にする」): its mentions are unread again,
  // which only the server's `read` flags say — the list loads again.
  const reloads = store.activityReloads;
  const lastReloads = useRef(reloads);
  useEffect(() => {
    const changed = reloads !== lastReloads.current;
    lastReloads.current = reloads;
    if (changed && active && status === "online") void load(filter);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reloads]);

  // 「すべて既読にする」: everything up to now (or the newest row held, should this device's clock be behind) is read.
  const markAllRead = () => {
    const at = Math.max(Date.now(), Date.parse(newestActivityAt(Object.values(lists).flatMap((l) => l?.items ?? [])) ?? "") || 0);
    void controller.markActivityRead(new Date(at).toISOString());
  };
  // A row opened is read (until it happens again), then it opens its message, canvas, page or reservations.
  const open = (item: ActivityItem) => {
    void controller.markActivityItemsRead([item]);
    onOpen(item);
  };

  // §6.4: the read position held now (「すべて既読にする」 here or on another device), the items opened (here or on
  // another device), and what I read in its conversation or thread (here or on another device) take the dot at once.
  const readAt = summary?.read_at ?? null;
  const positions: ReadPositions = { channel: (id) => store.getChannel(id)?.lastReadSeq, thread: (id) => store.threadReadSeqs.get(id) };
  const unreadOf = (item: ActivityItem) => isActivityUnread(item, readAt, { listReadAt: list?.readAt, positions, opened: store.openedActivityItems }) && !(item.reservation && (item.reservation.done || store.doneActivityItems.has(item.reservation.item_id)));
  const items = (list?.items ?? []).filter((item) => !unreadOnly || unreadOf(item));
  return (
    <section aria-label={t("nav.activity")} className="flex min-h-0 flex-1 flex-col bg-canvas">
      <header className="flex h-[52px] shrink-0 items-center gap-2 border-b border-line px-4 max-md:pr-2">
        <span className="text-muted max-md:hidden"><Bell size={18} /></span>
        <strong className="min-w-0 truncate text-[17px] md:text-[15px]">{t("nav.activity")}</strong>
        <span data-activity-unread={unread} className={cn("min-w-0 flex-1 truncate text-[13px]", unread > 0 ? "font-semibold text-accent" : "text-muted")}>
          {unread > 0 ? t("activity.unreadCount", { count: unread >= 99 ? "99+" : unread }) : t("activity.noUnread")}
        </span>
        <Button variant="secondary" size="sm" className="shrink-0" aria-label={t("activity.markAllRead")} title={t("activity.markAllRead")} disabled={unread === 0} onClick={markAllRead}>
          <CheckCheck size={14} />
          <span className="max-md:hidden">{t("activity.markAllRead")}</span>
        </Button>
      </header>
      <div className="shrink-0 px-3 py-2">
        <div className="mx-auto flex max-w-3xl rounded-xl bg-panel p-1 text-[13px] font-medium md:text-sm" role="radiogroup" aria-label={t("activity.show")}>
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
        <div className="mx-auto mt-1.5 flex max-w-3xl justify-end">
          <button
            type="button"
            aria-pressed={unreadOnly}
            onClick={() => setUnreadOnly((v) => !v)}
            className={cn("inline-flex h-7 items-center gap-1.5 rounded-full border px-2.5 text-[12.5px] font-medium transition-colors", unreadOnly ? "border-accent bg-accent-soft text-accent" : "border-line text-muted hover:text-ink")}
          >
            <span aria-hidden="true" className={cn("h-1.5 w-1.5 rounded-full", unreadOnly ? "bg-accent" : "bg-muted")} />
            {t("activity.unreadOnly")}
          </button>
        </div>
      </div>
      <div data-scroll-memory className="min-h-0 flex-1 overflow-y-auto pb-3">
        {list === undefined || (list.loading && items.length === 0 && !failed) ? (
          <div className="py-8 text-center text-sm text-muted">{t("common.loading")}</div>
        ) : items.length === 0 && !(unreadOnly && list.cursor) ? (
          failed ? (
            <div className="flex flex-col items-center gap-3 py-16 text-sm text-muted">
              {t("common.loadFailed")}
              <Button variant="secondary" size="sm" onClick={() => void load(filter)}>{t("common.reload")}</Button>
            </div>
          ) : (
            <div className="py-16 text-center text-sm text-muted">{unreadOnly ? t("activity.empty.unread") : activityEmptyText(filter)}</div>
          )
        ) : (
          <ul className="mx-auto max-w-3xl" aria-label={t("activity.listLabel", { filter: ACTIVITY_FILTER_LABELS[filter] })}>
            {items.map((item) => (
              <li key={activityKey(item)} data-row-key={activityKey(item)}>
                <ActivityRow controller={controller} item={item} unread={unreadOf(item)} onOpen={() => open(item)} />
              </li>
            ))}
            {list.cursor && (
              <li className="py-2 text-center">
                <Button variant="secondary" size="sm" disabled={list.loading} onClick={() => void load(filter, true)}>{t("canvasHistory.loadMore")}</Button>
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
  thread_reply: { Icon: MessagesSquare, className: "bg-accent-solid" },
  reaction: { Icon: SmilePlus, className: "bg-amber-500" },
} as const;

/** What a row quotes: the message's opening words, or (a canvas mention, M76) the line around the mention. */
function activityExcerpt(item: ActivityItem, controller: AppController): string {
  if (item.reservation) return item.reservation.text; // M112
  // An erased canvas revision blanks the excerpt (`activity.updated`, review v0.1.22 #3), even in a list already loaded.
  if (item.canvas) return controller.store.erasedActivityItems.has(item.canvas.item_id) ? "" : item.canvas.excerpt;
  if (item.page) return controller.store.erasedActivityItems.has(item.page.item_id) ? "" : item.page.excerpt; // M121
  const message = item.message;
  if (!message) return "";
  const store = controller.store;
  return message.deleted ? t("activity.deletedMessage") : plainText(mentionsToNames(message.body, store.users, store.groups), 200) || message.attachments.map((a) => a.filename).join(", ");
}

/**
 * One item: who (their pictures) did what, where and when, and the message's opening words. Unread (§6.4): a tinted
 * row, bold, with a dot; read: plain.
 */
function ActivityRow({ controller, item, unread, onOpen }: { controller: AppController; item: ActivityItem; unread: boolean; onOpen: () => void }) {
  const store = controller.store;
  const nameOf = (id: string) => store.users.get(id)?.display_name ?? t("common.member");
  const { who, what } = activityHeadline(item, nameOf);
  const channelId = item.message?.channel_id ?? item.canvas?.channel_id ?? "";
  const channel = store.getChannel(channelId);
  const where = channel ? channelTitle(channel, controller) : item.page ? t("nav.docs") : "";
  const excerpt = activityExcerpt(item, controller);
  const actors = item.actor_ids.slice(0, 3);
  const fallbackActor = item.message?.sender_id ?? "";
  // page_mention / page_shared (M121) and canvas mentions show a page glyph.
  const kindIcon = item.kind === "mention" || item.kind === "thread_reply" || item.kind === "reaction" ? KIND_ICON[item.kind] : null;
  // M112: a to-do another operator handled (or no longer needed) is done: greyed with 「対応済み」.
  const done = !!item.reservation && (item.reservation.done || store.doneActivityItems.has(item.reservation.item_id));
  if (item.reservation) {
    return (
      <button
        type="button"
        onClick={onOpen}
        data-activity={item.kind}
        data-unread={unread || undefined}
        data-done={done || undefined}
        aria-label={`${unread ? `${t("sidebar.unread")} ` : ""}${activityHeadlineText(item, nameOf)}${done ? ` · ${t("activity.done")}` : ""}`}
        className={cn("flex w-full items-start gap-2 px-3 py-2.5 text-left transition-colors hover:bg-panel active:bg-panel md:rounded-xl", unread && !done && "bg-accent-soft/40", done && "opacity-60")}
      >
        <span className="flex w-2.5 shrink-0 justify-center pt-4" aria-hidden="true">
          {unread && !done && <span className="h-2 w-2 rounded-full bg-accent" />}
        </span>
        <span aria-hidden="true" className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-panel-2 text-[20px]">🎫</span>
        <span className="min-w-0 flex-1 pl-1">
          <span className="flex items-baseline gap-2">
            <span className={cn("min-w-0 flex-1 truncate text-[14px]", unread && !done ? "font-semibold text-ink" : "text-ink/75")}><strong className={unread && !done ? "font-bold" : "font-medium"}>{who}</strong>{what}</span>
            {done && <span className="shrink-0 text-xs text-muted">{t("activity.done")}</span>}
            <time dateTime={item.at} title={fullTimestamp(item.at)} className="shrink-0 text-xs text-muted">{dmTimeLabel(item.at)}</time>
          </span>
          <span className={cn("mt-0.5 line-clamp-3 text-[13.5px] leading-snug", unread && !done ? "text-ink/85" : "text-muted", done && "line-through decoration-ink/30")}>{excerpt}</span>
        </span>
      </button>
    );
  }
  return (
    <button
      type="button"
      onClick={onOpen}
      data-activity={item.kind}
      data-unread={unread || undefined}
      aria-label={`${unread ? `${t("sidebar.unread")} ` : ""}${activityHeadlineText(item, nameOf)}${where ? ` · ${where}` : ""}`}
      className={cn("flex w-full items-start gap-2 px-3 py-2.5 text-left transition-colors hover:bg-panel active:bg-panel md:rounded-xl", unread && "bg-accent-soft/40")}
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
          <Avatar id={actors[0] ?? fallbackActor} name={nameOf(actors[0] ?? fallbackActor)} size={40} className="rounded-xl" />
        )}
        {kindIcon ? (
          <span className={cn("absolute -bottom-1 -right-1 flex h-[18px] w-[18px] items-center justify-center rounded-full text-white ring-2 ring-canvas", kindIcon.className)}>
            <kindIcon.Icon size={11} strokeWidth={2.6} />
          </span>
        ) : (
          <span data-kind-icon={item.page ? "page" : "canvas"} className="absolute -bottom-1 -right-1 flex h-[18px] w-[18px] items-center justify-center rounded-full bg-canvas text-[11px] leading-none ring-2 ring-canvas">{item.page ? "📄" : "📝"}</span>
        )}
      </span>
      <span className="min-w-0 flex-1 pl-1">
        <span className="flex items-baseline gap-2">
          <span className={cn("min-w-0 flex-1 truncate text-[14px]", unread ? "font-semibold text-ink" : "text-ink/75")}>
            <strong className={unread ? "font-bold" : "font-medium"}>{who}</strong>{what}
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
        {where && <span className="block truncate text-xs text-muted">{item.kind === "thread_reply" ? t("activity.threadIn", { where }) : item.kind === "canvas_mention" ? t("activity.canvasIn", { where }) : where}</span>}
        {excerpt && <span className={cn("mt-0.5 line-clamp-2 text-[13.5px] leading-snug", unread ? "text-ink/85" : "text-muted")}><EmojiText controller={controller} text={item.kind === "reaction" ? t("common.quoted", { text: excerpt }) : excerpt} /></span>}
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
  onOpenThread: (entry: ThreadEntry, reply?: MessageState) => void;
}) {
  const [segment, setSegment] = useState<ActivitySegment>("mentions");
  const [threadsShown, setThreadsShown] = useState(false);
  const summary = controller.store.threadSummary;
  return (
    <section aria-label={t("nav.activity")} className="flex min-h-0 flex-1 flex-col bg-canvas">
      <header className="flex h-[52px] shrink-0 items-center border-b border-line px-4">
        <strong className="truncate text-[17px]">{t("nav.activity")}</strong>
      </header>
      <div className="shrink-0 px-3 py-2">
        <div className="flex rounded-xl bg-panel p-1 text-sm font-medium" role="radiogroup" aria-label={t("activity.show")}>
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
              {value === "mentions" ? t("nav.mentions") : t("nav.threads")}
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
          <ThreadsView controller={controller} selectedId={null} onOpen={onOpenThread} onOpenChannel={(entry) => onOpenMessage(entry.parent)} embedded />
        </div>
      )}
    </section>
  );
}
