import { Eye, MessagesSquare } from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import type { AppController } from "../state/app";
import type { ChannelPreview } from "../sync/engine";
import type { ChannelState, MessageState } from "../sync/types";
import { tapClosesKeyboard } from "../platform/viewport";
import { buildTimeline, rowKey } from "./format";
import { channelTitle } from "./MainScreen";
import { useListAnchor } from "./scrollAnchor";
import { PaneBackButton, PaneCloseButton } from "./compact";
import { Button } from "./primitives";
import { ChannelIntro, MessageRow } from "./Timeline";
import { t } from "../i18n";

/**
 * A public channel read before joining (SYNC_PROTOCOL.md §7.6.1, Slack): the engine's ChannelPreview, never the store.
 * Deliberately apart from Timeline, which is about the member's read position (anchoring, the unread divider and
 * banner, read marks): none of that exists here. Rows are read-only; older pages load on scrolling up.
 */
export function PreviewTimeline({ controller, channel, onOpenThread, onJoin }: { controller: AppController; channel: ChannelState; onOpenThread?: (id: string) => void; onJoin?: (channelId: string) => Promise<unknown> }) {
  const engine = controller.engine;
  const preview = previewOf(controller, channel.id);
  // A permalink into the channel (M12b) shows the rows around the message, as in a channel of mine.
  const focus = controller.messageFocus?.channelId === channel.id ? controller.messageFocus : null;
  const messages: MessageState[] = useMemo(() => (focus ? focus.context.filter((m) => !m.deleted) : (preview?.messages ?? [])), [focus, preview?.messages]);
  const meId = controller.store.me?.id ?? null;
  const today = new Date().toDateString();
  const group = controller.groupPosts;
  const items = useMemo(() => buildTimeline(messages, { firstUnreadAfterSeq: null, meId, group }), [messages, meId, today, group]);
  const container = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const [tapHandlers] = useState(() => tapClosesKeyboard());
  /**
   * Still while content changes height, as in the timeline (scrollAnchor.ts): at the end it follows photos and cards
   * arriving until the reader scrolls up; elsewhere the topmost row on screen keeps its place, older rows put above too.
   */
  const anchor = useListAnchor(container, content, "article[id^='timeline-']");
  /** What the view last placed itself for (the channel, or the linked message in it). */
  const positioned = useRef("");
  const parents = preview?.parents;
  const parentOf = (id: string) => preview?.messages.find((m) => m.id === id) ?? parents?.get(id);
  // The rows are memoized (M21): one function for the life of the view, calling the latest prop.
  const openThreadRef = useRef(onOpenThread);
  openThreadRef.current = onOpenThread;
  const [openThread] = useState(() => (id: string) => openThreadRef.current?.(id));

  // Older rows were put above (or rows came or went): the row the reader was looking at stays where it was. By that
  // row, not by the height the list gained, which also counted photos and cards that grew meanwhile. At the end, the
  // end (new rows included).
  useLayoutEffect(() => {
    anchor.resized();
  }, [messages.length]);

  // Once per channel (or linked message): the newest row at the bottom, or the linked one in the middle.
  useLayoutEffect(() => {
    const el = container.current;
    const key = `${channel.id}:${focus?.messageId ?? ""}`;
    if (!el || messages.length === 0 || positioned.current === key) return;
    positioned.current = key;
    const target = focus ? document.getElementById(`timeline-${focus.parentId ?? focus.messageId}`) : null;
    if (target) {
      target.scrollIntoView({ block: "center" });
      anchor.placed();
    } else {
      anchor.toBottom();
    }
  }, [channel.id, focus?.messageId, messages.length]);

  const loadOlder = () => {
    if (!engine || focus || !preview?.hasOlder || preview.loading) return;
    void engine.loadPreviewOlder().catch((error) => controller.setError(error));
  };
  const onScroll = () => {
    anchor.scrolled();
    if ((container.current?.scrollTop ?? 1000) < 120) loadOlder();
  };

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      {/* Chromium's own scroll anchoring is off: the list anchors itself, the same on every engine (scrollAnchor.ts). */}
      <div data-message-list data-chat-focus tabIndex={-1} aria-label={t("timeline.list")} data-preview="" ref={container} className="flex-1 overflow-y-auto px-4 pb-2 pt-2 [overflow-anchor:none]" onScroll={onScroll} {...tapHandlers}>
        <div ref={content}>
        {focus && (
          <div className="sticky top-0 z-10 mb-2 flex items-center justify-between rounded-lg bg-accent-soft px-3 py-2 text-xs text-ink shadow-sm">
            <span>{t("timeline.aroundResult")}</span>
            <Button variant="link" size="sm" onClick={() => controller.clearMessageFocus()}>
              {t("timeline.backToLatest")}
            </Button>
          </div>
        )}
        {preview?.loading && <div className="py-2 text-center text-xs text-muted">{t("common.loading")}</div>}
        {!focus && preview?.loaded && !preview.loading && preview.hasOlder && (
          <div className="py-1 text-center">
            <Button variant="link" size="sm" onClick={loadOlder}>{t("timeline.loadOlder")}</Button>
          </div>
        )}
        {!focus && preview?.loaded && !preview.hasOlder && messages.length > 0 && <ChannelIntro controller={controller} channel={channel} />}
        {preview?.refused && !focus && <JoinToReadPanel controller={controller} channel={channel} onJoin={onJoin} />}
        {preview && !preview.loaded && !preview.loading && !preview.refused && !focus && (
          // Offline, the engine loads it once connected; online, the first page failed.
          <div className="flex flex-col items-center gap-2 px-4 py-16 text-center text-sm text-muted">
            {engine?.status === "online" ? (
              <>
                {t("preview.loadFailed")}
                <Button variant="secondary" size="sm" onClick={() => void engine.retryPreview().catch((error) => controller.setError(error))}>{t("common.reload")}</Button>
              </>
            ) : (
              t("preview.waiting")
            )}
          </div>
        )}
        {preview?.loaded && messages.length === 0 && (
          <div className="flex flex-col items-center gap-2 px-4 py-16 text-center">
            <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-accent-soft text-accent">
              <MessagesSquare size={22} />
            </span>
            <strong className="text-base">{t("timeline.empty")}</strong>
          </div>
        )}
        {items.map((item) => {
          if (item.kind === "date") {
            return (
              <div key={item.key} className="my-3 flex items-center gap-3 text-xs text-muted">
                <span className="h-px flex-1 bg-line" />
                <span className="rounded-full border border-line bg-canvas px-3 py-0.5">{item.label}</span>
                <span className="h-px flex-1 bg-line" />
              </div>
            );
          }
          if (item.kind !== "message") return null;
          const parentId = item.message.parent_id;
          return <MessageRow key={rowKey(item.message)} controller={controller} message={item.message} compact={item.compact} onOpenThread={onOpenThread ? openThread : undefined} readOnly threadParent={parentId ? parentOf(parentId) : undefined} />;
        })}
        </div>
      </div>
    </div>
  );
}

/**
 * In place of the rows when the server will not show them before joining (M88: 「参加前にチャンネルの中を見られる」 off, or a
 * server before M27): what the browser shows of the channel (purpose, topic, members) and 参加. The bar below steps aside
 * (previewRefused) so there is one button.
 */
function JoinToReadPanel({ controller, channel, onJoin }: { controller: AppController; channel: ChannelState; onJoin?: (channelId: string) => Promise<unknown> }) {
  const [busy, setBusy] = useState(false);
  const about = channel.purpose || channel.topic;
  return (
    <div data-testid="join-to-read" className="flex flex-col items-center gap-3 px-4 py-16 text-center text-sm text-muted">
      <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-accent-soft text-accent">
        <Eye size={22} />
      </span>
      <strong className="text-base text-ink">{t("preview.joinToRead")}</strong>
      {about && <p className="max-w-md whitespace-pre-wrap break-words">{about}</p>}
      {!!channel.member_count && <span className="text-xs">{t("preview.members", { count: channel.member_count })}</span>}
      {onJoin && previewCanJoin(channel) && (
        <Button
          disabled={busy || controller.engine?.status !== "online"}
          onClick={() => {
            setBusy(true);
            void onJoin(channel.id).finally(() => setBusy(false));
          }}
        >
          {busy ? t("preview.joining") : t("preview.join")}
        </Button>
      )}
    </div>
  );
}

/** Whether the open preview of this channel shows the join panel instead of rows (JoinToReadPanel has the button then). */
export function previewRefused(controller: AppController, channelId: string): boolean {
  return previewOf(controller, channelId)?.refused === true;
}

/** What the preview's bar says in place of the button when the channel is archived (joining it is refused: 409 channel_archived). */
export function archivedPreviewNote(): string {
  return t("preview.archived");
}

/** Whether the preview offers 「#name に参加する」: not for an archived channel (e.g. an archived times found by `is:times`). */
export function previewCanJoin(channel: Pick<ChannelState, "archived">): boolean {
  return !channel.archived;
}

/** In place of the input (§7.6.1): 「#name に参加する」; the conversation then goes on as one of mine. */
export function PreviewJoinBar({ controller, channel, onJoin }: { controller: AppController; channel: ChannelState; onJoin: (channelId: string) => Promise<unknown> }) {
  const [busy, setBusy] = useState(false);
  const name = `#${channel.name ?? ""}`;
  return (
    <div className="flex shrink-0 flex-col items-center gap-2 border-t border-line bg-panel/50 px-4 pb-[max(env(safe-area-inset-bottom),12px)] pt-3 text-center">
      {!previewCanJoin(channel) ? (
        <span className="text-sm text-muted">{archivedPreviewNote()}</span>
      ) : (
        <>
          <span className="text-xs text-muted">{t("preview.previewing", { name })}{channel.member_count ? ` · ${t("preview.members", { count: channel.member_count })}` : ""}</span>
          <Button
            disabled={busy || controller.engine?.status !== "online"}
            onClick={() => {
              setBusy(true);
              void onJoin(channel.id).finally(() => setBusy(false));
            }}
          >
            {busy ? t("preview.joining") : t("preview.joinName", { name })}
          </Button>
        </>
      )}
    </div>
  );
}

/** A thread opened from a preview: the parent and its replies, read-only (no input, no follow, no read position). */
export function PreviewThreadPane({ controller, channel, parentId, onClose }: { controller: AppController; channel: ChannelState; parentId: string; onClose: () => void }) {
  const engine = controller.engine;
  const preview = previewOf(controller, channel.id);
  const focus = controller.messageFocus?.parentId === parentId ? controller.messageFocus : null;
  const parent: MessageState | undefined = preview?.messages.find((m) => m.id === parentId) ?? preview?.parents.get(parentId) ?? controller.messageFocus?.context.find((m) => m.id === parentId);
  const replies = preview?.replies.get(parentId);
  const list = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  /** As in the thread pane of a member (scrollAnchor.ts). */
  const anchor = useListAnchor(list, content, "article[id^='thread-']");
  const [tapHandlers] = useState(() => tapClosesKeyboard());
  const hasPreview = !!preview;

  useEffect(() => {
    if (!hasPreview) return;
    void engine?.loadPreviewThread(parentId).catch((error) => controller.setError(error));
  }, [engine, hasPreview, parentId]);

  // Once the replies are there: the linked reply in the middle, else the newest at the bottom.
  const loaded = replies !== undefined;
  useLayoutEffect(() => {
    const el = list.current;
    if (!el) return;
    if (!loaded) {
      anchor.reset(); // another thread in the same pane
      return;
    }
    const hit = focus ? document.getElementById(`thread-${focus.messageId}`) : null;
    if (hit) {
      hit.scrollIntoView({ block: "center" });
      anchor.placed();
    } else {
      anchor.toBottom();
    }
  }, [parentId, loaded]);

  return (
    <aside className="flex min-h-0 w-full min-w-0 flex-col border-l border-line bg-canvas max-md:border-l-0">
      <header className="flex h-[52px] items-center gap-2 border-b border-line px-4">
        <PaneBackButton onClick={onClose} />
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold">{t("nav.threads")}</div>
          <div className="truncate text-xs text-muted">{channelTitle(channel, controller)}</div>
        </div>
        <PaneCloseButton onClick={onClose} />
      </header>
      <div data-message-list data-chat-focus tabIndex={-1} aria-label={t("preview.threadList")} ref={list} className="min-h-0 flex-1 overflow-y-auto px-3 py-2 [overflow-anchor:none]" onScroll={() => anchor.scrolled()} {...tapHandlers}>
        <div ref={content}>
        {parent ? (
          <>
            <MessageRow thread readOnly message={parent} controller={controller} />
            <div className="my-2 flex items-center gap-2 text-xs text-muted">
              <span className="whitespace-nowrap">{replies === undefined ? t("common.loading") : replies.length === 0 ? t("preview.noReplies") : t("timeline.replyCount", { count: replies.length })}</span>
              <span className="h-px flex-1 bg-line" />
            </div>
            <div data-replies="">
              {(replies ?? []).map((reply) => <MessageRow key={rowKey(reply)} thread readOnly message={reply} controller={controller} />)}
            </div>
          </>
        ) : (
          <div className="py-8 text-center text-sm text-muted">{loaded ? t("preview.messageMissing") : t("common.loading")}</div>
        )}
        </div>
      </div>
      <div className="shrink-0 border-t border-line px-4 py-3 text-center text-xs text-muted">{t("preview.joinToReply")}</div>
    </aside>
  );
}

function previewOf(controller: AppController, channelId: string): ChannelPreview | null {
  const preview = controller.engine?.preview ?? null;
  return preview?.channelId === channelId ? preview : null;
}
