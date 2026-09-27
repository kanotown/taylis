import { Pin, X } from "lucide-react";
import { useEffect, useState } from "react";

import type { MessageOut } from "../api/types";
import type { AppController } from "../state/app";
import type { ChannelState } from "../sync/types";
import { Avatar } from "./Avatar";
import { fullTimestamp } from "./format";
import { channelTitle } from "./MainScreen";
import { plainText } from "./markdown";
import { mentionsToNames } from "./mentions";
import { IconButton } from "./primitives";

/** The right pane: messages pinned in this channel (M11c), most recently pinned first; a row reveals it. */
export function PinsPane({ controller, channel, onOpen, onClose }: { controller: AppController; channel: ChannelState; onOpen: (message: MessageOut) => void; onClose: () => void }) {
  const store = controller.store;
  const [pins, setPins] = useState<MessageOut[] | null>(null);
  // Pin changes arrive as message.updated (also for old rows outside the loaded timeline); re-read the list when they move.
  const pinnedSignature = store.pinned(channel.id).map((m) => m.id).sort().join(",");
  useEffect(() => {
    if (!controller.api) return;
    void controller.api.listPins(channel.id).then(setPins, (error) => controller.setError(error));
  }, [controller.api, channel.id, pinnedSignature]);

  return (
    <aside className="flex min-h-0 w-[400px] min-w-[340px] flex-col border-l border-line bg-canvas">
      <header className="flex h-[52px] items-center gap-2 border-b border-line px-4">
        <Pin size={16} className="text-warning" />
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold">ピン留め{pins ? ` (${pins.length})` : ""}</div>
          <div className="truncate text-xs text-muted">{channelTitle(channel, controller)}</div>
        </div>
        <IconButton label="閉じる (Esc)" onClick={onClose}>
          <X size={18} />
        </IconButton>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
        {pins === null ? (
          <div className="py-8 text-center text-sm text-muted">読み込み中…</div>
        ) : pins.length === 0 ? (
          <div className="px-4 py-8 text-center text-sm text-muted">ピン留めされたメッセージはありません。メッセージのピンアイコンから追加できます。</div>
        ) : (
          <div className="space-y-1">
            {pins.map((message) => <MessageCard key={message.id} message={message} controller={controller} onOpen={() => onOpen(message)} />)}
          </div>
        )}
      </div>
    </aside>
  );
}

/** A compact message card shared by the pins pane and the saved view. */
export function MessageCard({ message, controller, onOpen, onRemove, removeLabel }: { message: MessageOut; controller: AppController; onOpen: () => void; onRemove?: () => void; removeLabel?: string }) {
  const store = controller.store;
  const channel = store.getChannel(message.channel_id);
  const sender = store.users.get(message.sender_id)?.display_name ?? "?";
  const text = plainText(mentionsToNames(message.body, store.users, store.groups), 300) || message.attachments.map((a) => a.filename).join(", ");
  return (
    <div className="group relative rounded-xl border border-transparent transition-colors hover:border-line hover:bg-panel">
      <button type="button" className="block w-full px-3 py-2 text-left" onClick={onOpen}>
        <div className="flex items-center gap-2 text-xs text-muted">
          <Avatar id={message.sender_id} name={sender} size={18} className="rounded-md text-[9px]" />
          <span className="font-medium text-ink">{sender}</span>
          <span className="truncate">{channel ? channelTitle(channel, controller) : "?"}</span>
          <time className="ml-auto shrink-0">{fullTimestamp(message.created_at)}</time>
        </div>
        <div className="mt-1 line-clamp-4 text-sm text-ink">{text}</div>
      </button>
      {onRemove && (
        <IconButton label={removeLabel ?? "外す"} className="absolute right-2 top-2 h-7 w-7 text-muted opacity-0 hover:text-ink group-hover:opacity-100" onClick={onRemove}>
          <X size={14} />
        </IconButton>
      )}
    </div>
  );
}
