import type { AppController } from "../state/app";
import type { MessageState } from "../sync/types";
import { Avatar } from "./Avatar";
import { CustomEmojiImage, customEmojiName } from "./customEmoji";
import { fullTimestamp, sinceLabel } from "./format";
import { Modal } from "./primitives";

/**
 * 「リアクションした人」 (M27): every reaction of a message with the names of who added it, in the order they did. A
 * phone has no hover, so the chips' names were out of reach there; the long-press sheet opens this, and a mouse gets it
 * from the hover bar as well (the chips keep their hover names).
 */
export function ReactionsDialog({ controller, message, onClose }: { controller: AppController; message: MessageState; onClose: () => void }) {
  const store = controller.store;
  const reactions = message.reactions ?? [];
  return (
    <Modal onClose={onClose} title="リアクションした人" className="w-[420px]">
      <ul className="mt-3 divide-y divide-line">
        {reactions.map((reaction) => {
          const name = customEmojiName(reaction.emoji);
          const custom = name ? store.customEmoji.get(name) : undefined;
          return (
            <li key={reaction.emoji} className="flex items-start gap-3 py-2.5" data-reaction={reaction.emoji}>
              <span className="flex w-12 shrink-0 items-center gap-1.5 pt-0.5">
                <span className="flex h-6 w-6 items-center justify-center text-xl leading-none" title={reaction.emoji}>
                  {custom ? <CustomEmojiImage controller={controller} emoji={custom} size={22} /> : name ? <span className="text-xs text-muted">{reaction.emoji}</span> : reaction.emoji}
                </span>
                <span className="text-xs font-medium text-muted">{reaction.count}</span>
              </span>
              <span className="min-w-0 flex-1 text-sm leading-6">
                {reaction.user_ids.map((id) => store.users.get(id)?.display_name ?? "?").join("、")}
              </span>
            </li>
          );
        })}
      </ul>
    </Modal>
  );
}

/** 「確認した人」 (M27): who acknowledged a message that asks for it, oldest first, with when. */
export function AcksDialog({ controller, message, onClose }: { controller: AppController; message: MessageState; onClose: () => void }) {
  const store = controller.store;
  const acks = message.acks ?? [];
  return (
    <Modal onClose={onClose} title="確認した人" description={`${acks.length} 人が確認しました`} className="w-[380px]">
      <ul className="mt-3 space-y-1">
        {acks.map((ack) => {
          const name = store.users.get(ack.user_id)?.display_name ?? "?";
          return (
            <li key={ack.user_id} className="flex items-center gap-2.5 rounded-lg px-1 py-1.5">
              <Avatar id={ack.user_id} name={name} size={26} />
              <span className="min-w-0 flex-1 truncate text-sm font-medium">{name}</span>
              <time className="shrink-0 text-xs text-muted" dateTime={ack.acked_at} title={fullTimestamp(ack.acked_at)}>{sinceLabel(ack.acked_at)}</time>
            </li>
          );
        })}
      </ul>
    </Modal>
  );
}
