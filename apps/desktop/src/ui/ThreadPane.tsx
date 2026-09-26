import { useEffect, useRef } from "react";

import type { AppController } from "../state/app";
import type { ChannelState } from "../sync/types";
import { Composer } from "./Composer";
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
    <aside className="thread-panel open">
      <header className="channel-header">
        <strong>スレッド</strong>
        <button className="link" onClick={onClose}>
          閉じる
        </button>
      </header>
      <div className="timeline">
        {parent ? (
          <>
            <MessageRow thread message={parent} controller={controller} />
            <div className="muted thread-count">{replies.length === 0 ? "返信はまだありません" : `${replies.length} 件の返信`}</div>
            {replies.map((reply) => (
              <MessageRow thread key={reply.id} message={reply} controller={controller} />
            ))}
          </>
        ) : (
          <div className="muted">メッセージが見つかりません</div>
        )}
      </div>
      {parent && channel.isMember && !channel.archived && <Composer key={parentId} controller={controller} channel={channel} parentId={parentId} placeholder="スレッドに返信" />}
    </aside>
  );
}
