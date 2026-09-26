import { FileText } from "lucide-react";

import type { AppController } from "../state/app";
import { channelTitle } from "./MainScreen";
import { plainText } from "./markdown";

/** The centre column 「下書き」 (M11h): conversations with an unsent draft; a row opens it. */
export function DraftsView({ controller, onOpen }: { controller: AppController; onOpen: (channelId: string, parentId: string | null) => void }) {
  const store = controller.store;
  const drafts = store.listDrafts().filter((d) => store.getChannel(d.channelId));
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex h-[52px] items-center gap-3 border-b border-line px-4">
        <span className="text-muted"><FileText size={18} /></span>
        <strong className="text-[15px]">下書き</strong>
        <span className="text-xs text-muted">{drafts.length} 件</span>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
        {drafts.length === 0 ? (
          <div className="py-16 text-center text-sm text-muted">送信していない下書きはありません</div>
        ) : (
          <ul className="mx-auto max-w-3xl divide-y divide-line rounded-xl border border-line">
            {drafts.map(({ channelId, parentId, draft }) => {
              const channel = store.getChannel(channelId)!;
              return (
                <li key={`${channelId}:${parentId ?? ""}`}>
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
