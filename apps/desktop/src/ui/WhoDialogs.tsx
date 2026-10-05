import { BellRing } from "lucide-react";
import { useEffect, useState } from "react";

import type { AppController } from "../state/app";
import type { MessageState } from "../sync/types";
import { Avatar } from "./Avatar";
import { CustomEmojiImage, customEmojiName } from "./customEmoji";
import { fullTimestamp, sinceLabel } from "./format";
import { Button, cn, Modal } from "./primitives";
import { t } from "../i18n";

/**
 * 「リアクションした人」 (M27): every reaction of a message with the names of who added it, in the order they did. A
 * phone has no hover, so the chips' names were out of reach there; the long-press sheet opens this, and a mouse gets it
 * from the hover bar as well (the chips keep their hover names).
 */
export function ReactionsDialog({ controller, message, onClose }: { controller: AppController; message: MessageState; onClose: () => void }) {
  const store = controller.store;
  const reactions = message.reactions ?? [];
  return (
    <Modal onClose={onClose} title={t("actions.reactions")} className="w-[420px]">
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

/**
 * 「確認した人」 (M27): who acknowledged a message that asks for it, oldest first, with when; below, 「未確認 N 人」 (L4,
 * loaded when the list opens and again as acknowledgements come in), and for the author or an admin while someone is
 * pending, 「未確認の人にリマインド」 with its outcome in a line below it (a toast would sit behind the dialog). `readOnly` (a
 * channel read before joining): the acknowledgements only.
 */
export function AcksDialog({ controller, message, onClose, readOnly = false }: { controller: AppController; message: MessageState; onClose: () => void; readOnly?: boolean }) {
  const store = controller.store;
  const acks = message.acks ?? [];
  const canRemind = !readOnly && (store.me?.id === message.sender_id || controller.isAdmin);
  // null while loading, "failed" when it could not be loaded.
  const [pending, setPending] = useState<string[] | "failed" | null>(null);
  const [reload, setReload] = useState(0);
  const [reminding, setReminding] = useState(false);
  // The reminder's outcome, under its button.
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  useEffect(() => {
    if (readOnly) return;
    let current = true;
    void controller.ackPending(message).then((ids) => { if (current) setPending(ids ?? "failed"); });
    return () => { current = false; };
    // Again when someone acknowledges (or takes it back) while the list is open, and after a reminder.
  }, [controller, message.id, acks.length, reload, readOnly]);
  const remind = async () => {
    setReminding(true);
    setResult(null);
    const outcome = await controller.remindAck(message);
    setReminding(false);
    setResult(outcome);
    if (outcome.ok) setReload((n) => n + 1);
  };
  const row = (userId: string, time?: string) => {
    const name = store.users.get(userId)?.display_name ?? "?";
    return (
      <li key={userId} className="flex items-center gap-2.5 rounded-lg px-1 py-1.5">
        <Avatar id={userId} name={name} size={26} />
        <span className="min-w-0 flex-1 truncate text-sm font-medium">{name}</span>
        {time && <time className="shrink-0 text-xs text-muted" dateTime={time} title={fullTimestamp(time)}>{sinceLabel(time)}</time>}
      </li>
    );
  };
  return (
    <Modal onClose={onClose} title={t("who.acked")} description={t("who.ackedCount", { count: acks.length })} className="w-[380px]">
      <ul className="mt-3 space-y-1">{acks.map((ack) => row(ack.user_id, ack.acked_at))}</ul>
      {!readOnly && (
        <section aria-label={t("who.pending")} className="mt-4 border-t border-line pt-3">
          <div className="flex items-center justify-between gap-2">
            <h3 className="text-xs font-semibold text-muted">{Array.isArray(pending) ? t("ack.pending", { count: pending.length }) : t("who.pending")}</h3>
            {canRemind && Array.isArray(pending) && pending.length > 0 && (
              <Button size="sm" variant="secondary" disabled={reminding} onClick={() => void remind()}>
                <BellRing size={14} /> {t("who.remind")}
              </Button>
            )}
          </div>
          {result && <p role={result.ok ? "status" : "alert"} className={cn("mt-1 text-xs", result.ok ? "text-muted" : "text-danger")}>{result.text}</p>}
          {pending === null ? (
            <p className="py-2 text-sm text-muted">{t("common.loading")}</p>
          ) : pending === "failed" ? (
            <p className="py-2 text-sm text-danger">{t("common.loadFailed")}</p>
          ) : pending.length === 0 ? (
            <p className="py-2 text-sm text-muted">{t("who.allAcked")}</p>
          ) : (
            <ul className="mt-1 max-h-60 space-y-1 overflow-y-auto">{pending.map((id) => row(id))}</ul>
          )}
        </section>
      )}
    </Modal>
  );
}
