import { ContextMenu } from "radix-ui";
import { MessagesSquare } from "lucide-react";
import { useEffect } from "react";

import type { AppController } from "../state/app";
import type { MessageState, ThreadEntry, ThreadFilter } from "../sync/types";
import { Avatar } from "./Avatar";
import { dateLabel, fullTimestamp, timeLabel } from "./format";
import { isDmChannel } from "./channels";
import { channelTitle } from "./MainScreen";
import { attachmentText, plainText } from "./markdown";
import { mentionsToNames } from "./mentions";
import { BackButton } from "./compact";
import { Badge, Button, cn } from "./primitives";
import { EmojiText } from "./UserPopover";
import { MessageBody } from "./MessageBody";
import { threadCardReplies, type ThreadCardReply } from "./threadCard";
import { t } from "../i18n";

/**
 * The centre column of the threads view (THREADS.md §5): the threads I follow, newest reply first.
 * Rows are the parent message with the channel, the reply count and the unread badge; a row opens
 * the thread in the right pane. The conversation's name on top of a row (and 「チャンネルを開く」 / 「会話を開く」 in its
 * right-click menu) opens the conversation itself at the thread's parent message (`onOpenChannel`).
 */
export function ThreadsView({ controller, selectedId, onOpen, onOpenChannel, embedded = false }: {
  controller: AppController;
  selectedId: string | null;
  /** The thread; with `reply` (a reply under the card), landing on that reply. */
  onOpen: (entry: ThreadEntry, reply?: MessageState) => void;
  /** The conversation of a row, with its parent message revealed (as a permalink lands). */
  onOpenChannel: (entry: ThreadEntry) => void;
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
              <ThreadRow key={entry.parent.id} entry={entry} controller={controller} selected={entry.parent.id === selectedId} onOpen={(reply) => onOpen(entry, reply)} onOpenChannel={() => onOpenChannel(entry)} />
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

const MENU = "rx-popover z-50 min-w-48 rounded-xl border border-line bg-canvas p-1 text-ink shadow-xl";
const MENU_ITEM = "flex select-none items-center gap-2 rounded-lg px-2.5 py-1.5 text-sm outline-none data-[highlighted]:bg-accent-soft";

function ThreadRow({ entry, controller, selected, onOpen: openAt, onOpenChannel }: {
  entry: ThreadEntry;
  controller: AppController;
  selected: boolean;
  onOpen: (reply?: MessageState) => void;
  onOpenChannel: () => void;
}) {
  const onOpen = () => openAt();
  const store = controller.store;
  const { parent, state } = entry;
  const channel = store.getChannel(state.channel_id);
  const author = store.users.get(parent.sender_id);
  const unread = state.unread_count > 0;
  const last = state.last_reply_at ?? parent.created_at;
  const excerpt = plainText(mentionsToNames(parent.body, store.users, store.groups), 200) || attachmentText(parent.attachments);
  const others = state.participant_ids.filter((id) => id !== parent.sender_id).slice(0, 3);
  const title = channel ? channelTitle(channel, controller) : "";
  const dm = channel ? isDmChannel(channel) : false;
  const openLabel = dm ? t("threads.openConversation") : t("threads.openChannel");
  const preview = threadCardReplies(entry, store.me?.id, (id) => store.isBlocked(id));
  return (
    <ContextMenu.Root>
      <ContextMenu.Trigger asChild>
        <li
          data-row-key={parent.id}
          className={cn("transition-colors hover:bg-panel", selected && "bg-accent-soft/60 hover:bg-accent-soft/60")}
        >
          {/* The conversation's line: its name opens the conversation; the rest of the line opens the thread, as the card does. */}
          <div className="flex cursor-pointer items-baseline gap-2 px-4 pt-3 text-xs text-muted" onClick={onOpen}>
            {channel && (
              <button
                type="button"
                data-thread-channel
                onClick={(event) => {
                  event.stopPropagation();
                  onOpenChannel();
                }}
                aria-label={t("timeline.openChannel", { name: title })}
                title={openLabel}
                className="min-w-0 truncate rounded font-medium text-ink/80 hover:text-accent hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
              >
                {title}
              </button>
            )}
            <span className="ml-auto whitespace-nowrap" title={fullTimestamp(last)}>
              {dateLabel(last)} {timeLabel(last)}
            </span>
          </div>
          <button type="button" onClick={onOpen} aria-current={selected ? "true" : undefined} className="flex w-full gap-3 px-4 pb-3 pt-1 text-left">
            <Avatar id={parent.sender_id} name={author?.display_name ?? "?"} size={36} className="mt-0.5 rounded-lg" />
            <div className="min-w-0 flex-1">
              <div className={cn("flex items-baseline gap-2 text-sm", unread ? "font-semibold" : "font-medium")}>
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
          {preview && preview.replies.length > 0 && (
            <div className="pb-3 pl-16 pr-4">
              {preview.more > 0 && (
                <button type="button" data-thread-more onClick={onOpen} className="mb-1 text-xs font-medium text-accent hover:underline">
                  {t("threads.moreReplies", { count: preview.more })}
                </button>
              )}
              <div className="space-y-1 border-l-2 border-line pl-3">
                {preview.replies.map((reply) => (
                  <ThreadPreviewReply key={reply.message.id} reply={reply} controller={controller} onOpen={() => openAt(reply.message)} />
                ))}
              </div>
            </div>
          )}
        </li>
      </ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Content className={MENU}>
          <ContextMenu.Item className={MENU_ITEM} onSelect={onOpen}>{t("threads.openThread")}</ContextMenu.Item>
          {channel && <ContextMenu.Item className={MENU_ITEM} onSelect={onOpenChannel}>{openLabel}</ContextMenu.Item>}
        </ContextMenu.Content>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  );
}

/** A reply under a card (THREADS.md §5): compact, the body in the message renderer clamped to four lines. */
function ThreadPreviewReply({ reply, controller, onOpen }: { reply: ThreadCardReply; controller: AppController; onOpen: () => void }) {
  const store = controller.store;
  const { message, unread } = reply;
  const author = store.users.get(message.sender_id);
  const name = author?.display_name ?? "…";
  return (
    <div
      role="button"
      tabIndex={0}
      data-thread-reply={message.id}
      aria-label={t("threads.replyFrom", { name })}
      onClick={(event) => {
        // A link in the body follows the link, not the thread.
        if ((event.target as HTMLElement).closest("a")) return;
        onOpen();
      }}
      onKeyDown={(event) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        onOpen();
      }}
      className="flex cursor-pointer gap-2 rounded-lg px-1.5 py-1 hover:bg-canvas focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
    >
      <Avatar id={message.sender_id} name={author?.display_name ?? "?"} size={24} className="mt-0.5 rounded-md text-[10px]" />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2 text-[13px]">
          <span className={cn("truncate", unread ? "font-bold" : "font-medium")}>{name}</span>
          <span className="whitespace-nowrap text-[11px] text-muted" title={fullTimestamp(message.created_at)}>{timeLabel(message.created_at)}</span>
          {unread && <span aria-label={t("sidebar.unread")} className="h-2 w-2 shrink-0 self-center rounded-full bg-accent" />}
        </div>
        {message.body.trim() ? (
          <MessageBody
            body={message.body}
            users={store.users}
            groups={store.groups}
            customEmoji={store.customEmoji}
            controller={controller}
            className={cn("max-h-20 overflow-hidden text-[13px] leading-5", unread ? "text-ink" : "text-ink/85")}
          />
        ) : (
          <p className="text-[13px] leading-5 text-muted">{attachmentText(message.attachments ?? [])}</p>
        )}
      </div>
    </div>
  );
}
