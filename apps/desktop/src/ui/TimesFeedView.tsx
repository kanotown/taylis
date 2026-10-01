import { CheckCheck, Newspaper, PenLine, Plus, RotateCw } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useRef, useSyncExternalStore } from "react";

import type { AppController } from "../state/app";
import { feedRevealTarget, isFeedChannel, isNewFeedRow, type TimesFeedHub } from "../sync/timesFeed";
import type { MessageState } from "../sync/types";
import { BackButton } from "./compact";
import { channelTitle } from "./MainScreen";
import { Button, IconButton } from "./primitives";
import { MessageRow } from "./Timeline";

export const TIMES_FEED_EMPTY = "参加している times がありません。チャンネル一覧から times に参加すると、ここに新しい投稿が並びます";

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
    body = <Notice title="このサーバは Times フィードに対応していません" text="サーバを更新すると使えるようになります。" />;
  } else if (!state?.loaded) {
    body =
      hub.status === "failed" ? (
        <Notice title="読み込めませんでした" text="接続を確かめて、もう一度試してください。" action={<Button variant="secondary" size="sm" onClick={() => void hub.refresh()}>再読み込み</Button>} />
      ) : !online && hub.status !== "loading" ? (
        <Notice title="オフラインです" text="接続が戻ると読み込みます。" />
      ) : (
        <div className="py-8 text-center text-sm text-muted">読み込み中…</div>
      );
  } else if (rows.length === 0) {
    body = <Notice title="まだ投稿がありません" text={TIMES_FEED_EMPTY} />;
  } else {
    body = (
      <div className="mx-auto max-w-3xl pb-4" role="feed" aria-busy={loadingMore || undefined} aria-label="Times フィード">
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
              <span className="text-sm text-muted">続きを読み込んでいます…</span>
            ) : (
              <Button variant="secondary" size="sm" onClick={() => void hub.loadMore()}>さらに読み込む</Button>
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
        <strong className="min-w-0 flex-1 truncate whitespace-nowrap text-[15px]">Times フィード</strong>
        {hub && hub.status !== "unsupported" && (
          <IconButton label="再読み込み" className="shrink-0 text-muted" disabled={hub.status === "loading" || !online} onClick={() => void hub.refresh()}>
            <RotateCw size={16} />
          </IconButton>
        )}
        <Button variant="secondary" size="sm" className="shrink-0" title="Times フィードの times を末尾まで既読にする" aria-label="すべて既読にする" disabled={!anyNew} onClick={() => void controller.markAllRead("times")}>
          <CheckCheck size={14} />
          <span className="max-md:hidden">すべて既読にする</span>
        </Button>
        {myTimes ? (
          <Button size="sm" className="shrink-0" aria-label="自分の times に書く" onClick={() => onOpenChannel(myTimes.id)}>
            <PenLine size={14} />
            <span className="max-md:hidden">自分の times に書く</span>
          </Button>
        ) : (
          !controller.isGuest && (
            <Button size="sm" className="shrink-0" aria-label="自分の times を作る" onClick={onCreateTimes}>
              <Plus size={14} />
              <span className="max-md:hidden">自分の times を作る</span>
            </Button>
          )
        )}
      </header>
      <div ref={scroller} className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
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
