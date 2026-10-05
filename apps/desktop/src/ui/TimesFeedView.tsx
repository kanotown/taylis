import { CheckCheck, Newspaper, PenLine, Plus, RotateCw } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useRef, useSyncExternalStore } from "react";

import type { AppController } from "../state/app";
import { feedRevealTarget, isFeedChannel, isNewFeedRow, type TimesFeedHub } from "../sync/timesFeed";
import type { MessageState } from "../sync/types";
import { BackButton } from "./compact";
import { channelTitle } from "./MainScreen";
import { Button, IconButton } from "./primitives";
import { MessageRow } from "./Timeline";
import { t } from "../i18n";

export function timesFeedEmpty(): string {
  return t("timesFeed.empty");
}

function useTimesFeed(controller: AppController): TimesFeedHub | null {
  const hub = controller.engine?.timesFeed ?? null;
  useSyncExternalStore(
    (listener) => (hub ? hub.subscribe(listener) : () => {}),
    () => hub?.version ?? 0,
  );
  return hub;
}

/**
 * L8 「Times フィード」 (TIMES_FEED.md §7): the top-level posts of the times I am in (and have not muted), newest at the
 * top, read like a conversation but never grouped. Reading it moves no read position (§4): only 「すべて既読にする」 does.
 * A row shows its message in its channel; 「N 件の返信」 and 「スレッドで返信」 open its thread beside the feed.
 */
export function TimesFeedView({ controller, onReveal, onOpenThread, onOpenChannel, onCreateTimes }: {
  controller: AppController;
  onReveal: (message: MessageState) => void;
  onOpenThread: (channelId: string, parentId: string) => void;
  onOpenChannel: (channelId: string) => void;
  /** No times of mine yet: 「自分の times を作る」 (ensureTimes, then it opens). */
  onCreateTimes: () => void;
}) {
  const hub = useTimesFeed(controller);
  const store = controller.store;
  const me = store.me ?? controller.me;
  const meId = me?.id ?? null;
  const online = controller.engine?.status === "online";
  const scroller = useRef<HTMLDivElement>(null);
  const sentinel = useRef<HTMLDivElement>(null);

  // On screen: the first page is read (again) and new posts come in; nothing is marked read.
  useEffect(() => hub?.open(), [hub]);

  // The rows are memoized (MessageRow): the callbacks they get stay the same object.
  const latest = useRef({ onReveal, onOpenThread, onOpenChannel });
  latest.current = { onReveal, onOpenThread, onOpenChannel };
  // A reply also sent to the channel is shown as the channel's row, not in its thread (§7; 「N 件の返信」 opens threads).
  const reveal = useCallback((message: MessageState) => latest.current.onReveal(feedRevealTarget(message)), []);
  const openChannel = useCallback((channelId: string) => latest.current.onOpenChannel(channelId), []);
  const threadOpeners = useRef(new Map<string, (id: string) => void>());
  const openerFor = (channelId: string) => {
    let opener = threadOpeners.current.get(channelId);
    if (!opener) {
      opener = (id: string) => latest.current.onOpenThread(channelId, id);
      threadOpeners.current.set(channelId, opener);
    }
    return opener;
  };

  const state = hub?.state;
  const rows = state?.rows ?? [];
  const hasMore = !!state?.nextCursor;
  const loadingMore = hub?.loadingMore ?? false;

  // The next page when the end comes near.
  useEffect(() => {
    const target = sentinel.current;
    if (!target || !hub || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) void hub.loadMore();
    }, { root: scroller.current, rootMargin: "480px" });
    observer.observe(target);
    return () => observer.disconnect();
  }, [hub, rows.length, hasMore]);

  const myTimes = meId ? [...store.channels.values()].find((c) => c.times_owner_id === meId && c.isMember) : undefined;
  const anyNew = rows.some((m) => isNewFeedRow(m, store.getChannel(m.channel_id), meId)) || [...store.channels.values()].some((c) => isFeedChannel(c) && c.unreadCount > 0);

  let body: ReactNode;
  if (!hub || hub.status === "unsupported") {
    body = <Notice title={t("timesFeed.unsupported")} text={t("canvas.serverTooOldText")} />;
  } else if (!state?.loaded) {
    body =
      hub.status === "failed" ? (
        <Notice title={t("common.loadFailed")} text={t("timesFeed.checkConnection")} action={<Button variant="secondary" size="sm" onClick={() => void hub.refresh()}>{t("common.reload")}</Button>} />
      ) : !online && hub.status !== "loading" ? (
        <Notice title={t("timesFeed.offline")} text={t("timesFeed.offlineText")} />
      ) : (
        <div className="py-8 text-center text-sm text-muted">{t("common.loading")}</div>
      );
  } else if (rows.length === 0) {
    body = <Notice title={t("timesFeed.noPosts")} text={timesFeedEmpty()} />;
  } else {
    body = (
      <div className="mx-auto max-w-3xl pb-4" role="feed" aria-busy={loadingMore || undefined} aria-label={t("sidebar.timesFeed")}>
        {rows.map((message) => {
          const channel = store.getChannel(message.channel_id);
          return (
            <MessageRow
              key={message.id}
              controller={controller}
              message={message}
              onOpenThread={openerFor(message.channel_id)}
              feed={{
                channelName: channel ? channelTitle(channel, controller).replace(/^#/, "") : "times",
                isNew: isNewFeedRow(message, channel, meId),
                onOpenChannel: openChannel,
                onActivate: reveal,
              }}
            />
          );
        })}
        <div ref={sentinel} className="h-px" />
        {hasMore && (
          <div className="py-3 text-center">
            {loadingMore ? (
              <span className="text-sm text-muted">{t("search.loadingMore")}</span>
            ) : (
              <Button variant="secondary" size="sm" onClick={() => void hub.loadMore()}>{t("canvasHistory.loadMore")}</Button>
            )}
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex h-[52px] shrink-0 items-center gap-2 border-b border-line px-4 max-md:pr-2">
        <BackButton />
        <span className="text-muted max-md:hidden">
          <Newspaper size={18} />
        </span>
        <strong className="min-w-0 flex-1 truncate whitespace-nowrap text-[15px]">{t("sidebar.timesFeed")}</strong>
        {hub && hub.status !== "unsupported" && (
          <IconButton label={t("common.reload")} className="shrink-0 text-muted" disabled={hub.status === "loading" || !online} onClick={() => void hub.refresh()}>
            <RotateCw size={16} />
          </IconButton>
        )}
        <Button variant="secondary" size="sm" className="shrink-0" title={t("timesFeed.markReadTitle")} aria-label={t("sidebar.markAllRead")} disabled={!anyNew} onClick={() => void controller.markAllRead("times")}>
          <CheckCheck size={14} />
          <span className="max-md:hidden">{t("sidebar.markAllRead")}</span>
        </Button>
        {myTimes ? (
          <Button size="sm" className="shrink-0" aria-label={t("timesFeed.writeMine")} onClick={() => onOpenChannel(myTimes.id)}>
            <PenLine size={14} />
            <span className="max-md:hidden">{t("timesFeed.writeMine")}</span>
          </Button>
        ) : (
          !controller.isGuest && (
            <Button size="sm" className="shrink-0" aria-label={t("sidebar.createTimes")} onClick={onCreateTimes}>
              <Plus size={14} />
              <span className="max-md:hidden">{t("sidebar.createTimes")}</span>
            </Button>
          )
        )}
      </header>
      <div ref={scroller} data-scroll-memory className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
        {body}
      </div>
    </div>
  );
}

function Notice({ title, text, action }: { title: string; text: string; action?: ReactNode }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
      <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-accent-soft text-accent">
        <Newspaper size={22} />
      </span>
      <strong className="text-sm">{title}</strong>
      <span className="max-w-md text-xs text-muted">{text}</span>
      {action}
    </div>
  );
}
