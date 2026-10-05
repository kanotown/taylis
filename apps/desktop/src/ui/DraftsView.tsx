import { Clock, FileText } from "lucide-react";

import { errorMessageFor } from "../api/errors";
import type { AppController } from "../state/app";
import { channelTitle } from "./MainScreen";
import { plainText } from "./markdown";
import { mentionsToNames } from "./mentions";
import { BackButton } from "./compact";
import { Button } from "./primitives";
import { scheduleLabel } from "./schedule";
import { t } from "../i18n";

/** The centre column 「下書き」 (M11h): conversations with an unsent draft; a row opens it. */
export function DraftsView({ controller, onOpen }: { controller: AppController; onOpen: (channelId: string, parentId: string | null) => void }) {
  const store = controller.store;
  const drafts = store.listDrafts().filter((d) => store.getChannel(d.channelId));
  const scheduled = store.listScheduled();
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex h-[52px] items-center gap-3 border-b border-line px-4">
        <BackButton />
        <span className="text-muted max-md:hidden"><FileText size={18} /></span>
        <strong className="shrink-0 whitespace-nowrap text-[15px]">{t("nav.drafts")}</strong>
        <span className="min-w-0 truncate text-xs text-muted">{t("common.count", { count: drafts.length + scheduled.length })}</span>
      </header>
      <div data-scroll-memory className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
        {scheduled.length > 0 && (
          <div className="mx-auto mb-4 max-w-3xl">
            <div className="mb-1.5 flex items-center gap-1.5 text-xs font-semibold text-muted"><Clock size={13} /> {t("drafts.scheduled")}</div>
            <ul className="divide-y divide-line rounded-xl border border-line">
              {scheduled.map((row) => {
                const channel = store.getChannel(row.channel_id);
                const failed = row.status === "failed";
                return (
                  <li key={row.id} data-row-key={row.id} className="flex items-start gap-3 px-3 py-2.5">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 text-xs text-muted">
                        <span className="font-medium text-ink">{channel ? channelTitle(channel, controller) : "?"}</span>
                        {row.parent_id && <span>· {t("nav.threads")}</span>}
                        {failed ? <span className="text-danger">· {t("drafts.sendFailed")}</span> : <span>· {t("drafts.sendsAt", { when: scheduleLabel(row.send_at) })}</span>}
                        {row.attachments.length > 0 && <span>· {t("drafts.attachments", { count: row.attachments.length })}</span>}
                      </div>
                      <div className="mt-0.5 line-clamp-2 text-sm text-ink">{plainText(mentionsToNames(row.body, store.users, store.groups), 200) || t("drafts.noText")}</div>
                      {/* Codex audit C3: why (e.g. the channel was archived meanwhile); the text can go back to a draft. */}
                      {failed && <div className="mt-0.5 text-xs text-danger">{errorMessageFor(row.error ?? "") ?? t("drafts.sendFailed")}</div>}
                    </div>
                    <div className="flex shrink-0 gap-1">
                      {failed ? (
                        <>
                          <Button size="sm" variant="secondary" onClick={() => void controller.cancelScheduled(row)}>{t("drafts.backToDraft")}</Button>
                          <Button size="sm" variant="ghost" onClick={() => void controller.cancelScheduled(row, false)}>{t("common.delete")}</Button>
                        </>
                      ) : (
                        <>
                          <Button size="sm" variant="secondary" onClick={() => void controller.sendScheduledNow(row)}>{t("drafts.sendNow")}</Button>
                          <Button size="sm" variant="ghost" onClick={() => void controller.cancelScheduled(row)}>{t("drafts.cancel")}</Button>
                        </>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          </div>
        )}
        {drafts.length === 0 && scheduled.length === 0 ? (
          <div className="py-16 text-center text-sm text-muted">{t("drafts.none")}</div>
        ) : drafts.length === 0 ? null : (
          <ul className="mx-auto max-w-3xl divide-y divide-line rounded-xl border border-line">
            {drafts.map(({ channelId, parentId, draft }) => {
              const channel = store.getChannel(channelId)!;
              return (
                <li key={`${channelId}:${parentId ?? ""}`} data-row-key={`${channelId}:${parentId ?? ""}`}>
                  <button type="button" className="block w-full px-3 py-2.5 text-left transition-colors hover:bg-panel" onClick={() => onOpen(channelId, parentId)}>
                    <div className="flex items-center gap-2 text-xs text-muted">
                      <span className="font-medium text-ink">{channelTitle(channel, controller)}</span>
                      {parentId && <span>· {t("nav.threads")}</span>}
                      {draft.attachments.length > 0 && <span>· {t("drafts.attachments", { count: draft.attachments.length })}</span>}
                    </div>
                    <div className="mt-0.5 line-clamp-2 text-sm text-ink">{plainText(draft.text, 200) || t("drafts.noText")}</div>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
