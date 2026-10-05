import { Hash, Lock, Mail } from "lucide-react";
import { useState } from "react";

import type { AppController } from "../state/app";
import type { ChannelState, MessageState } from "../sync/types";
import { useStoreUpdates } from "./hooks";
import { Button, cn, Modal, Textarea } from "./primitives";
import { t } from "../i18n";

/** 「別のチャンネルに共有」(M13c): pick a conversation, add a comment, post the quote and permalink there. */
export function ShareDialog({ controller, message, onClose }: { controller: AppController; message: MessageState; onClose: () => void }) {
  const store = controller.store;
  useStoreUpdates(controller); // opened from a memoized row: the list of conversations follows the store itself
  const me = store.me?.id;
  const targets = [...store.channels.values()]
    .filter((c) => c.isMember && !c.archived && c.id !== message.channel_id)
    .sort((a, b) => label(a).localeCompare(label(b), "ja"));
  const [targetId, setTargetId] = useState<string | null>(targets[0]?.id ?? null);
  const [comment, setComment] = useState("");
  const [busy, setBusy] = useState(false);

  function label(channel: ChannelState): string {
    if (channel.type === "dm" || channel.type === "group_dm") {
      return (channel.dm_user_ids ?? []).filter((id) => id !== me).map((id) => store.users.get(id)?.display_name ?? "?").join(", ") || t("calendar.me");
    }
    return channel.name ?? "";
  }

  const share = async () => {
    if (!targetId) return;
    setBusy(true);
    const ok = await controller.shareMessage(message, targetId, comment);
    setBusy(false);
    if (ok) onClose();
  };

  return (
    <Modal onClose={onClose} title={t("share.title")} description={t("share.description")} className="w-[480px]">
      <div className="mt-4 space-y-3">
        <Textarea value={comment} onChange={(e) => setComment(e.target.value)} placeholder={t("share.comment")} rows={2} autoFocus />
        <ul className="max-h-64 overflow-y-auto rounded-xl border border-line">
          {targets.map((channel) => (
            <li key={channel.id}>
              <button
                type="button"
                onClick={() => setTargetId(channel.id)}
                aria-pressed={targetId === channel.id}
                className={cn("flex w-full items-center gap-2 px-3 py-2 text-left text-sm transition-colors hover:bg-panel", targetId === channel.id && "bg-accent-soft/60")}
              >
                {channel.type === "private" ? <Lock size={14} className="text-muted" /> : channel.type === "public" ? <Hash size={14} className="text-muted" /> : <Mail size={14} className="text-muted" />}
                <span className="truncate">{label(channel)}</span>
              </button>
            </li>
          ))}
          {targets.length === 0 && <li className="px-3 py-6 text-center text-sm text-muted">{t("share.noTargets")}</li>}
        </ul>
        <div className="flex justify-end gap-2">
          <Button variant="secondary" size="sm" onClick={onClose}>{t("common.cancel")}</Button>
          <Button size="sm" disabled={busy || !targetId} onClick={() => void share()}>{t("share.share")}</Button>
        </div>
      </div>
    </Modal>
  );
}
