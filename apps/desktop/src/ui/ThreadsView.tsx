import { MessagesSquare } from "lucide-react";
import { useEffect } from "react";

import type { AppController } from "../state/app";
import type { ThreadEntry, ThreadFilter } from "../sync/types";
import { Avatar } from "./Avatar";
import { dateLabel, fullTimestamp, timeLabel } from "./format";
import { channelTitle } from "./MainScreen";
import { attachmentText, plainText } from "./markdown";
import { mentionsToNames } from "./mentions";
import { BackButton } from "./compact";
import { Badge, Button, cn } from "./primitives";
import { EmojiText } from "./UserPopover";
import { t } from "../i18n";

/**
 * The centre column of the threads view (THREADS.md §5): the threads I follow, newest reply first.
 * Rows are the parent message with the channel, the reply count and the unread badge; a row opens
 * the thread in the right pane.
 */
export function ThreadsView({ controller, selectedId, onOpen, embedded = false }: {
  controller: AppController;
  selectedId: string | null;
  onOpen: (entry: ThreadEntry) => void;
  /** M34: inside the phone's activity tab, which has its own header: only the filter is left here. */
  embedded?: boolean;
}) {
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
      <header className={cn("flex items-center gap-3 border-b border-line px-4", embedded ? "h-11" : "h-[52px]")}>
        {!embedded && (
          <>
            <BackButton />
            <span className="text-muted max-md:hidden">
              <MessagesSquare size={18} />
            </span>
            <strong className="shrink-0 whitespace-nowrap text-[15px]">{t("nav.threads")}</strong>
          </>
        )}
        <span className="min-w-0 truncate text-xs text-muted">{summary.unread_count > 0 ? t("format.unreadCount", { count: summary.unread_count }) : t("threads.following")}</span>
        <div className="ml-auto flex shrink-0 rounded-lg bg-panel p-0.5 text-xs font-medium" role="tablist" aria-label={t("activity.show")}>
          {(["all", "unread"] as const).map((value) => (
            <button
              key={value}
              type="button"
              role="tab"
              aria-selected={filter === value}
              onClick={() => setFilter(value)}
              className={cn("whitespace-nowrap rounded-md px-2.5 py-1 transition-colors", filter === value ? "bg-canvas text-ink shadow-sm" : "text-muted hover:text-ink")}
            >
              {value === "all" ? t("admin.users.filter.all") : t("sidebar.unread")}
            </button>
          ))}
        </div>
      </header>
      <div data-scroll-memory className="min-h-0 flex-1 overflow-y-auto">
        {rows.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
            <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-accent-soft text-accent">
              <MessagesSquare size={22} />
            </span>
            <strong className="text-sm">{!store.threadsLoaded ? t("common.loading") : filter === "unread" ? t("threads.noUnread") : t("threads.none")}</strong>
            <span className="text-xs text-muted">{t("threads.hint")}</span>
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
              {t("canvasSearch.more")}
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
  const excerpt = plainText(mentionsToNames(parent.body, store.users, store.groups), 200) || attachmentText(parent.attachments);
  const others = state.participant_ids.filter((id) => id !== parent.sender_id).slice(0, 3);
  return (
    <li data-row-key={parent.id}>
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
          <p className={cn("mt-0.5 line-clamp-2 text-[13px] leading-5", unread ? "text-ink" : "text-muted")}><EmojiText controller={controller} text={excerpt} /></p>
          <div className="mt-1.5 flex items-center gap-2 text-xs">
            <span className="flex -space-x-1.5">
              {others.map((id) => (
                <Avatar key={id} id={id} name={store.users.get(id)?.display_name ?? "?"} size={18} className="rounded-md text-[9px] ring-2 ring-canvas" />
              ))}
            </span>
            <span className={cn(unread ? "font-semibold text-accent" : "text-muted")}>{t("timeline.replyCount", { count: state.reply_count })}</span>
            {unread && <span className="text-muted">· {t("format.unreadCount", { count: state.unread_count })}</span>}
            {unread && <Badge tone={state.mention_count > 0 ? "danger" : "accent"} className="ml-auto">{state.mention_count > 0 ? `@${state.mention_count}` : state.unread_count}</Badge>}
          </div>
        </div>
      </button>
    </li>
  );
}
