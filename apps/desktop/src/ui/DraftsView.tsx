import { Clock, FileText } from "lucide-react";

import { ERROR_MESSAGES } from "../api/errorMessages";
import type { AppController } from "../state/app";
import { channelTitle } from "./MainScreen";
import { plainText } from "./markdown";
import { mentionsToNames } from "./mentions";
import { BackButton } from "./compact";
import { Button } from "./primitives";
import { scheduleLabel } from "./schedule";

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
        <strong className="shrink-0 whitespace-nowrap text-[15px]">下書き</strong>
        <span className="min-w-0 truncate text-xs text-muted">{drafts.length + scheduled.length} 件</span>
      </header>
      <div data-scroll-memory className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
        {scheduled.length > 0 && (
          <div className="mx-auto mb-4 max-w-3xl">
            <div className="mb-1.5 flex items-center gap-1.5 text-xs font-semibold text-muted"><Clock size={13} /> 予約送信</div>
            <ul className="divide-y divide-line rounded-xl border border-line">
              {scheduled.map((row) => {
                const channel = store.getChannel(row.channel_id);
                const failed = row.status === "failed";
                return (
                  <li key={row.id} data-row-key={row.id} className="flex items-start gap-3 px-3 py-2.5">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 text-xs text-muted">
                        <span className="font-medium text-ink">{channel ? channelTitle(channel, controller) : "?"}</span>
                        {row.parent_id && <span>· スレッド</span>}
                        {failed ? <span className="text-danger">· 送信できませんでした</span> : <span>· {scheduleLabel(row.send_at)} に送信</span>}
                        {row.attachments.length > 0 && <span>· 添付 {row.attachments.length}</span>}
                      </div>
                      <div className="mt-0.5 line-clamp-2 text-sm text-ink">{plainText(mentionsToNames(row.body, store.users, store.groups), 200) || "(本文なし)"}</div>
                      {/* Codex audit C3: why (e.g. the channel was archived meanwhile); the text can go back to a draft. */}
                      {failed && <div className="mt-0.5 text-xs text-danger">{ERROR_MESSAGES[row.error ?? ""] ?? "送信できませんでした"}</div>}
                    </div>
                    <div className="flex shrink-0 gap-1">
                      {failed ? (
                        <>
                          <Button size="sm" variant="secondary" onClick={() => void controller.cancelScheduled(row)}>下書きに戻す</Button>
                          <Button size="sm" variant="ghost" onClick={() => void controller.cancelScheduled(row, false)}>削除</Button>
                        </>
                      ) : (
                        <>
                          <Button size="sm" variant="secondary" onClick={() => void controller.sendScheduledNow(row)}>今すぐ送信</Button>
                          <Button size="sm" variant="ghost" onClick={() => void controller.cancelScheduled(row)}>取り消し</Button>
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
          <div className="py-16 text-center text-sm text-muted">送信していない下書きはありません</div>
        ) : drafts.length === 0 ? null : (
          <ul className="mx-auto max-w-3xl divide-y divide-line rounded-xl border border-line">
            {drafts.map(({ channelId, parentId, draft }) => {
              const channel = store.getChannel(channelId)!;
              return (
                <li key={`${channelId}:${parentId ?? ""}`} data-row-key={`${channelId}:${parentId ?? ""}`}>
                  <button type="button" className="block w-full px-3 py-2.5 text-left transition-colors hover:bg-panel" onClick={() => onOpen(channelId, parentId)}>
                    <div className="flex items-center gap-2 text-xs text-muted">
                      <span className="font-medium text-ink">{channelTitle(channel, controller)}</span>
                      {parentId && <span>· スレッド</span>}
                      {draft.attachments.length > 0 && <span>· 添付 {draft.attachments.length}</span>}
                    </div>
                    <div className="mt-0.5 line-clamp-2 text-sm text-ink">{plainText(draft.text, 200) || "(本文なし)"}</div>
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
