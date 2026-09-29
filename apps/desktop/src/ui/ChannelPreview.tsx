import { Eye, MessagesSquare, X } from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import type { AppController } from "../state/app";
import type { ChannelPreview } from "../sync/engine";
import type { ChannelState, MessageState } from "../sync/types";
import { tapClosesKeyboard } from "../platform/viewport";
import { buildTimeline, rowKey } from "./format";
import { channelTitle } from "./MainScreen";
import { Button, IconButton } from "./primitives";
import { ChannelIntro, MessageRow } from "./Timeline";

/**
 * A public channel read before joining (SYNC_PROTOCOL.md §7.6.1, Slack): the engine's ChannelPreview, never the store.
 * Deliberately apart from Timeline, which is about the member's read position (anchoring, the unread divider and
 * banner, read marks): none of that exists here. Rows are read-only; older pages load on scrolling up.
 */
export function PreviewTimeline({ controller, channel, onOpenThread }: { controller: AppController; channel: ChannelState; onOpenThread?: (id: string) => void }) {
  const engine = controller.engine;
  const preview = previewOf(controller, channel.id);
  // A permalink into the channel (M12b) shows the rows around the message, as in a channel of mine.
  const focus = controller.messageFocus?.channelId === channel.id ? controller.messageFocus : null;
  const messages: MessageState[] = useMemo(() => (focus ? focus.context.filter((m) => !m.deleted) : (preview?.messages ?? [])), [focus, preview?.messages]);
  const meId = controller.store.me?.id ?? null;
  const today = new Date().toDateString();
  const items = useMemo(() => buildTimeline(messages, { firstUnreadAfterSeq: null, meId }), [messages, meId, today]);
  const container = useRef<HTMLDivElement>(null);
  const [tapHandlers] = useState(() => tapClosesKeyboard());
  /** Older rows were put above: the reader stays on what they were looking at. */
  const anchor = useRef<{ height: number; top: number } | null>(null);
  /** What the view last placed itself for (the channel, or the linked message in it). */
  const positioned = useRef("");
  const parents = preview?.parents;
  const parentOf = (id: string) => preview?.messages.find((m) => m.id === id) ?? parents?.get(id);
  // The rows are memoized (M21): one function for the life of the view, calling the latest prop.
  const openThreadRef = useRef(onOpenThread);
  openThreadRef.current = onOpenThread;
  const [openThread] = useState(() => (id: string) => openThreadRef.current?.(id));

  useLayoutEffect(() => {
    const el = container.current;
    if (el && anchor.current) {
      el.scrollTop = anchor.current.top + (el.scrollHeight - anchor.current.height);
      anchor.current = null;
    }
  }, [messages.length]);

  // Once per channel (or linked message): the newest row at the bottom, or the linked one in the middle.
  useLayoutEffect(() => {
    const el = container.current;
    const key = `${channel.id}:${focus?.messageId ?? ""}`;
    if (!el || messages.length === 0 || positioned.current === key) return;
    positioned.current = key;
    const target = focus ? document.getElementById(`timeline-${focus.parentId ?? focus.messageId}`) : null;
    if (target) target.scrollIntoView({ block: "center" });
    else el.scrollTop = el.scrollHeight;
  }, [channel.id, focus?.messageId, messages.length]);

  const loadOlder = () => {
    const el = container.current;
    if (!engine || focus || !preview?.hasOlder || preview.loading) return;
    if (el) anchor.current = { height: el.scrollHeight, top: el.scrollTop };
    void engine.loadPreviewOlder().catch((error) => controller.setError(error));
  };

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <div data-message-list data-chat-focus tabIndex={-1} aria-label="メッセージ一覧" data-preview="" ref={container} className="flex-1 overflow-y-auto px-4 pb-2 pt-2" onScroll={() => { if ((container.current?.scrollTop ?? 1000) < 120) loadOlder(); }} {...tapHandlers}>
        {focus && (
          <div className="sticky top-0 z-10 mb-2 flex items-center justify-between rounded-lg bg-accent-soft px-3 py-2 text-xs text-ink shadow-sm">
            <span>検索位置の前後の会話</span>
            <Button variant="link" size="sm" onClick={() => controller.clearMessageFocus()}>
              最新の会話に戻る
            </Button>
          </div>
        )}
        {preview?.loading && <div className="py-2 text-center text-xs text-muted">読み込み中…</div>}
        {!focus && preview?.loaded && !preview.loading && preview.hasOlder && (
          <div className="py-1 text-center">
            <Button variant="link" size="sm" onClick={loadOlder}>以前のメッセージを読み込む</Button>
          </div>
        )}
        {!focus && preview?.loaded && !preview.hasOlder && messages.length > 0 && <ChannelIntro controller={controller} channel={channel} />}
        {preview?.refused && !focus && (
          <div className="flex flex-col items-center gap-2 px-4 py-16 text-center text-sm text-muted">
            <Eye size={22} />
            参加するとメッセージを読めます
          </div>
        )}
        {preview && !preview.loaded && !preview.loading && !preview.refused && !focus && (
          // Offline, the engine loads it once connected; online, the first page failed.
          <div className="flex flex-col items-center gap-2 px-4 py-16 text-center text-sm text-muted">
            {engine?.status === "online" ? (
              <>
                メッセージを読み込めませんでした
                <Button variant="secondary" size="sm" onClick={() => void engine.retryPreview().catch((error) => controller.setError(error))}>再読み込み</Button>
              </>
            ) : (
              "接続を待っています…"
            )}
          </div>
        )}
        {preview?.loaded && messages.length === 0 && (
          <div className="flex flex-col items-center gap-2 px-4 py-16 text-center">
            <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-accent-soft text-accent">
              <MessagesSquare size={22} />
            </span>
            <strong className="text-base">まだメッセージはありません</strong>
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
  );
}

/** In place of the input (§7.6.1): 「#name に参加する」; the conversation then goes on as one of mine. */
export function PreviewJoinBar({ controller, channel, onJoin }: { controller: AppController; channel: ChannelState; onJoin: (channelId: string) => Promise<unknown> }) {
  const [busy, setBusy] = useState(false);
  const name = `#${channel.name ?? ""}`;
  return (
    <div className="flex shrink-0 flex-col items-center gap-2 border-t border-line bg-panel/50 px-4 pb-[max(env(safe-area-inset-bottom),12px)] pt-3 text-center">
      {channel.archived ? (
        <span className="text-sm text-muted">アーカイブされたチャンネルには参加できません</span>
      ) : (
        <>
          <span className="text-xs text-muted">{name} をプレビューしています{channel.member_count ? ` · メンバー ${channel.member_count} 人` : ""}</span>
          <Button
            disabled={busy || controller.engine?.status !== "online"}
            onClick={() => {
              setBusy(true);
              void onJoin(channel.id).finally(() => setBusy(false));
            }}
          >
            {busy ? "参加しています…" : `${name} に参加する`}
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
    if (!el || !loaded) return;
    const hit = focus ? document.getElementById(`thread-${focus.messageId}`) : null;
    if (hit) hit.scrollIntoView({ block: "center" });
    else el.scrollTop = el.scrollHeight;
  }, [parentId, loaded]);

  return (
    <aside className="flex min-h-0 w-full min-w-0 flex-col border-l border-line bg-canvas max-md:border-l-0">
      <header className="flex h-[52px] items-center gap-2 border-b border-line px-4">
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold">スレッド</div>
          <div className="truncate text-xs text-muted">{channelTitle(channel, controller)}</div>
        </div>
        <IconButton label="閉じる (Esc)" onClick={onClose}>
          <X size={18} />
        </IconButton>
      </header>
      <div data-message-list data-chat-focus tabIndex={-1} aria-label="スレッドのメッセージ一覧" ref={list} className="min-h-0 flex-1 overflow-y-auto px-3 py-2" {...tapHandlers}>
        {parent ? (
          <>
            <MessageRow thread readOnly message={parent} controller={controller} />
            <div className="my-2 flex items-center gap-2 text-xs text-muted">
              <span className="whitespace-nowrap">{replies === undefined ? "読み込み中…" : replies.length === 0 ? "返信はまだありません" : `${replies.length} 件の返信`}</span>
              <span className="h-px flex-1 bg-line" />
            </div>
            <div data-replies="">
              {(replies ?? []).map((reply) => <MessageRow key={rowKey(reply)} thread readOnly message={reply} controller={controller} />)}
            </div>
          </>
        ) : (
          <div className="py-8 text-center text-sm text-muted">{loaded ? "メッセージが見つかりません" : "読み込み中…"}</div>
        )}
      </div>
      <div className="shrink-0 border-t border-line px-4 py-3 text-center text-xs text-muted">チャンネルに参加すると返信できます</div>
    </aside>
  );
}

function previewOf(controller: AppController, channelId: string): ChannelPreview | null {
  const preview = controller.engine?.preview ?? null;
  return preview?.channelId === channelId ? preview : null;
}
