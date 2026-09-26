import { X } from "lucide-react";
import { useEffect, useRef } from "react";

import type { AppController } from "../state/app";
import type { ChannelState } from "../sync/types";
import { Composer } from "./Composer";
import { channelTitle } from "./MainScreen";
import { IconButton } from "./primitives";
import { MessageRow } from "./Timeline";

/** The right pane: one thread (parent + replies) with its own composer. */
export function ThreadPane({ controller, channel, parentId, onClose }: { controller: AppController; channel: ChannelState; parentId: string; onClose: () => void }) {
  const store = controller.store;
  const parent = store.message(channel.id, parentId) ?? controller.messageFocus?.context.find((m) => m.id === parentId);
  const replies = store.replies(channel.id, parentId);
  const focused = useRef<string | null>(null);

  useEffect(() => {
    void controller.engine?.loadReplies(channel.id, parentId).catch((error) => controller.setError(error));
  }, [controller.engine, controller.engine?.status, channel.id, parentId]);

  useEffect(() => {
    const id = controller.messageFocus?.messageId;
    if (id && focused.current !== id) {
      const row = document.getElementById(`thread-${id}`);
      if (row) { row.scrollIntoView({ block: "center" }); focused.current = id; }
    }
  }, [parentId, controller.messageFocus?.messageId, replies.length]);

  return (
    <aside className="flex min-h-0 w-[380px] min-w-[320px] flex-col border-l border-line bg-canvas">
      <header className="flex h-[52px] items-center gap-2 border-b border-line px-4">
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold">スレッド</div>
          <div className="truncate text-xs text-muted">{channelTitle(channel, controller)}</div>
        </div>
        <IconButton label="閉じる (Esc)" onClick={onClose}>
          <X size={18} />
        </IconButton>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-2">
        {parent ? (
          <>
            <MessageRow thread message={parent} controller={controller} />
            <div className="my-2 flex items-center gap-2 text-xs text-muted">
              <span className="whitespace-nowrap">{replies.length === 0 ? "返信はまだありません" : `${replies.length} 件の返信`}</span>
              <span className="h-px flex-1 bg-line" />
            </div>
            {replies.map((reply) => (
              <MessageRow thread key={reply.id} message={reply} controller={controller} />
            ))}
          </>
        ) : (
          <div className="py-8 text-center text-sm text-muted">メッセージが見つかりません</div>
        )}
      </div>
      {parent && channel.isMember && !channel.archived && <Composer key={parentId} controller={controller} channel={channel} parentId={parentId} placeholder="スレッドに返信" />}
    </aside>
  );
}
