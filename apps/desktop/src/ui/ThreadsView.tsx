import { MessagesSquare } from "lucide-react";
import { useEffect } from "react";

import type { AppController } from "../state/app";
import type { ThreadEntry, ThreadFilter } from "../sync/types";
import { Avatar } from "./Avatar";
import { dateLabel, fullTimestamp, timeLabel } from "./format";
import { channelTitle } from "./MainScreen";
import { plainText } from "./markdown";
import { mentionsToNames } from "./mentions";
import { Badge, Button, cn } from "./primitives";

/**
 * The centre column of the threads view (THREADS.md §5): the threads I follow, newest reply first.
 * Rows are the parent message with the channel, the reply count and the unread badge; a row opens
 * the thread in the right pane.
 */
export function ThreadsView({ controller, selectedId, onOpen }: { controller: AppController; selectedId: string | null; onOpen: (entry: ThreadEntry) => void }) {
  const store = controller.store;
  const engine = controller.engine;
  const filter = store.threadsFilter;
  const rows = store.threadList(filter);
  const summary = store.threadSummary;

  useEffect(() => {
    void engine?.loadThreads(store.threadsFilter).catch((error) => controller.setError(error));
  }, [engine, engine?.status]);

  const setFilter = (next: ThreadFilter) => {
    if (next === filter && store.threadsLoaded) return;
    void engine?.loadThreads(next).catch((error) => controller.setError(error));
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex h-[52px] items-center gap-3 border-b border-line px-4">
        <span className="text-muted">
          <MessagesSquare size={18} />
        </span>
        <strong className="text-[15px]">スレッド</strong>
        <span className="text-xs text-muted">{summary.unread_count > 0 ? `未読 ${summary.unread_count} 件` : "フォロー中のスレッド"}</span>
        <div className="ml-auto flex rounded-lg bg-panel p-0.5 text-xs font-medium" role="tablist" aria-label="表示">
          {(["all", "unread"] as const).map((value) => (
            <button
              key={value}
              type="button"
              role="tab"
              aria-selected={filter === value}
              onClick={() => setFilter(value)}
              className={cn("rounded-md px-2.5 py-1 transition-colors", filter === value ? "bg-canvas text-ink shadow-sm" : "text-muted hover:text-ink")}
            >
              {value === "all" ? "すべて" : "未読"}
            </button>
          ))}
        </div>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {rows.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
            <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-accent-soft text-accent">
              <MessagesSquare size={22} />
            </span>
            <strong className="text-sm">{!store.threadsLoaded ? "読み込んでいます…" : filter === "unread" ? "未読のスレッドはありません" : "フォロー中のスレッドはありません"}</strong>
            <span className="text-xs text-muted">自分が投稿・返信・メンションされたスレッドはここに集まります。</span>
          </div>
        ) : (
          <ul className="divide-y divide-line">
            {rows.map((entry) => (
              <ThreadRow key={entry.parent.id} entry={entry} controller={controller} selected={entry.parent.id === selectedId} onOpen={() => onOpen(entry)} />
            ))}
          </ul>
        )}
        {rows.length > 0 && store.threadsHasMore && (
          <div className="flex justify-center py-3">
            <Button variant="secondary" size="sm" onClick={() => void engine?.loadThreads(filter, { more: true }).catch((error) => controller.setError(error))}>
              さらに表示
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}

function ThreadRow({ entry, controller, selected, onOpen }: { entry: ThreadEntry; controller: AppController; selected: boolean; onOpen: () => void }) {
  const store = controller.store;
  const { parent, state } = entry;
  const channel = store.getChannel(state.channel_id);
  const author = store.users.get(parent.sender_id);
  const unread = state.unread_count > 0;
  const last = state.last_reply_at ?? parent.created_at;
  const excerpt = plainText(mentionsToNames(parent.body, store.users, store.groups), 200) || (parent.attachments?.length ? "(添付ファイル)" : "");
  const others = state.participant_ids.filter((id) => id !== parent.sender_id).slice(0, 3);
  return (
    <li>
      <button
        type="button"
        onClick={onOpen}
        aria-current={selected ? "true" : undefined}
        className={cn(
          "flex w-full gap-3 px-4 py-3 text-left transition-colors hover:bg-panel",
          selected && "bg-accent-soft/60 hover:bg-accent-soft/60",
        )}
      >
        <Avatar id={parent.sender_id} name={author?.display_name ?? "?"} size={36} className="mt-0.5 rounded-lg" />
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2 text-xs text-muted">
            <span className="truncate font-medium text-ink/80">{channel ? channelTitle(channel, controller) : ""}</span>
            <span className="ml-auto whitespace-nowrap" title={fullTimestamp(last)}>
              {dateLabel(last)} {timeLabel(last)}
            </span>
          </div>
          <div className={cn("mt-0.5 flex items-baseline gap-2 text-sm", unread ? "font-semibold" : "font-medium")}>
            <span className="truncate">{author?.display_name ?? "…"}</span>
          </div>
          <p className={cn("mt-0.5 line-clamp-2 text-[13px] leading-5", unread ? "text-ink" : "text-muted")}>{excerpt}</p>
          <div className="mt-1.5 flex items-center gap-2 text-xs">
            <span className="flex -space-x-1.5">
              {others.map((id) => (
                <Avatar key={id} id={id} name={store.users.get(id)?.display_name ?? "?"} size={18} className="rounded-md text-[9px] ring-2 ring-canvas" />
              ))}
            </span>
            <span className={cn(unread ? "font-semibold text-accent" : "text-muted")}>{state.reply_count} 件の返信</span>
            {unread && <span className="text-muted">· 未読 {state.unread_count} 件</span>}
            {unread && <Badge tone={state.mention_count > 0 ? "danger" : "accent"} className="ml-auto">{state.mention_count > 0 ? `@${state.mention_count}` : state.unread_count}</Badge>}
          </div>
        </div>
      </button>
    </li>
  );
}
