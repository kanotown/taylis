import { Phone } from "lucide-react";
import { useState } from "react";

import { ApiError, describeError } from "../api/errors";
import type { MessageCallOut } from "../api/types";
import { openExternalLink, openOutside, reserveTab } from "../platform/external";
import type { AppController } from "../state/app";
import type { ChannelState } from "../sync/types";
import { canPostTopLevel } from "./channels";
import { fullTimestamp, timeLabel } from "./format";
import { Button, IconButton, Modal } from "./primitives";
import { t } from "../i18n";

/**
 * M117 (docs/CALLS.md §7): 📞 shows when the workspace has calls on (a server before M117 never says so) and I may post
 * a top-level message here: a member, not archived, and in an announcement channel an owner or administrator.
 */
export function canStartCall(controller: AppController, channel: ChannelState): boolean {
  return controller.store.workspaceSettings.calls_enabled === true && channel.isMember && !channel.archived && canPostTopLevel(channel, controller.isAdmin);
}

/** The server's body for a call (docs/CALLS.md §5): the card says it, so an unedited body is not shown again. */
export function callHidesBody(message: { body: string; call?: MessageCallOut | null }): boolean {
  return !!message.call && message.body.trim() === `📞 通話を始めました\n${message.call.url}`;
}

/** 「📞 〇〇 さんが通話を始めました」: the card, and this app's own notification (the same words as the server's push). */
export function callStartedText(controller: AppController, call: MessageCallOut): string {
  return t("call.started", { name: controller.store.users.get(call.started_by)?.display_name ?? t("common.member") });
}

/**
 * 📞 in the conversation header: asks first, then POST /channels/{id}/calls and the room opens outside the app. The id is
 * made when the dialog opens and kept across failures, so 「通話を始める」 pressed again after a lost answer gets the same
 * call back instead of a second one.
 */
export function CallButton({ controller, channel }: { controller: AppController; channel: ChannelState }) {
  const [clientMsgId, setClientMsgId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const start = async () => {
    if (!clientMsgId || busy) return;
    const tab = reserveTab(); // during the click: a browser blocks a tab opened after the request
    setBusy(true);
    const url = await controller.startCall(channel.id, clientMsgId);
    setBusy(false);
    if (!url) {
      tab?.close();
      return;
    }
    setClientMsgId(null);
    openOutside(url, tab);
  };
  return (
    <>
      <IconButton label={t("call.start")} onClick={() => setClientMsgId(crypto.randomUUID())}>
        <Phone size={18} />
      </IconButton>
      {clientMsgId && (
        <Modal onClose={() => setClientMsgId(null)} title={t("call.confirmTitle")} description={t("call.confirmNote")} className="w-[420px]">
          <div className="mt-4 flex justify-end gap-2">
            <Button variant="secondary" size="sm" onClick={() => setClientMsgId(null)}>{t("common.cancel")}</Button>
            <Button size="sm" disabled={busy} onClick={() => void start()}>
              <Phone size={14} /> {busy ? t("call.starting") : t("call.start")}
            </Button>
          </div>
        </Modal>
      )}
    </>
  );
}

/** A call message (`message.call`): who started it, when, and 「参加する」 (the room outside the app). */
export function CallCard({ controller, call, createdAt }: { controller: AppController; call: MessageCallOut; createdAt: string }) {
  return (
    <div data-call-card="" className="mt-1 flex max-w-md items-center gap-3 rounded-xl border border-line bg-panel px-3 py-2.5">
      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-accent-soft text-accent" aria-hidden>
        <Phone size={17} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-medium text-ink">📞 {callStartedText(controller, call)}</span>
        <time className="block text-xs text-muted" title={fullTimestamp(createdAt)}>{timeLabel(createdAt)}</time>
      </span>
      <a
        href={call.url}
        target="_blank"
        rel="noreferrer noopener"
        title={t("call.joinTitle")}
        onClick={(event) => openExternalLink(event, call.url)}
        className="inline-flex h-8 shrink-0 items-center rounded-lg bg-accent-solid px-3 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-accent-solid/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50"
      >
        {t("call.join")}
      </a>
    </div>
  );
}
