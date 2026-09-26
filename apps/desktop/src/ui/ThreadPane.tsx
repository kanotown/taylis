import { useEffect } from "react";

import type { AppController } from "../state/app";
import type { ChannelState, MessageState } from "../sync/types";
import { AttachmentList } from "./Attachments";
import { Composer } from "./Composer";
import { MessageBody } from "./MessageBody";

/** The right pane: one thread (parent + replies) with its own composer. */
export function ThreadPane({ controller, channel, parentId, onClose }: { controller: AppController; channel: ChannelState; parentId: string; onClose: () => void }) {
  const store = controller.store;
  const parent = store.message(channel.id, parentId);
  const replies = store.replies(channel.id, parentId);

  useEffect(() => {
    void controller.engine?.loadReplies(channel.id, parentId);
  }, [controller.engine, channel.id, parentId]);

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
            <ThreadMessage message={parent} controller={controller} />
            <div className="muted thread-count">{replies.length === 0 ? "返信はまだありません" : `${replies.length} 件の返信`}</div>
            {replies.map((reply) => (
              <ThreadMessage key={reply.id} message={reply} controller={controller} />
            ))}
          </>
        ) : (
          <div className="muted">メッセージが見つかりません</div>
        )}
      </div>
      {parent && channel.isMember && !channel.archived && <Composer controller={controller} channel={channel} parentId={parentId} placeholder="スレッドに返信" />}
    </aside>
  );
}

function ThreadMessage({ message, controller }: { message: MessageState; controller: AppController }) {
  const store = controller.store;
  const sender = store.users.get(message.sender_id)?.display_name ?? store.me?.display_name ?? "?";
  return (
    <article className={`message${message.pending ? " pending" : ""}`}>
      <div className="meta">
        <strong>{sender}</strong>
      </div>
      {message.body && <MessageBody body={message.body} users={store.users} />}
      <AttachmentList attachments={message.attachments ?? []} controller={controller} />
    </article>
  );
}
