import { useState } from "react";

import type { MessageOut } from "../api/types";
import type { AppController } from "../state/app";
import type { ThreadEntry } from "../sync/types";
import { MentionsView } from "./MentionsView";
import { cn } from "./primitives";
import { ThreadsView } from "./ThreadsView";

export type ActivitySegment = "mentions" | "threads";

/**
 * M34, the phone's activity tab, stage A (MOBILE_UI.md §6.4): [メンション | スレッド] over the existing mentions list and
 * followed-threads list. A row opens its message / thread on this tab's stack (the caller's `onOpenMessage` /
 * `onOpenThread`).
 */
export function ActivityView({ controller, onOpenMessage, onOpenThread }: {
  controller: AppController;
  onOpenMessage: (message: MessageOut) => void;
  onOpenThread: (entry: ThreadEntry) => void;
}) {
  const [segment, setSegment] = useState<ActivitySegment>("mentions");
  const [threadsShown, setThreadsShown] = useState(false);
  const summary = controller.store.threadSummary;
  return (
    <section aria-label="アクティビティ" className="flex min-h-0 flex-1 flex-col bg-canvas">
      <header className="flex h-[52px] shrink-0 items-center border-b border-line px-4">
        <strong className="truncate text-[17px]">アクティビティ</strong>
      </header>
      <div className="shrink-0 px-3 py-2">
        <div className="flex rounded-xl bg-panel p-1 text-sm font-medium" role="radiogroup" aria-label="表示する項目">
          {(["mentions", "threads"] as const).map((value) => (
            <button
              key={value}
              type="button"
              role="radio"
              aria-checked={segment === value}
              onClick={() => {
                setSegment(value);
                if (value === "threads") setThreadsShown(true);
              }}
              className={cn("flex h-9 flex-1 items-center justify-center gap-1.5 rounded-lg transition-colors", segment === value ? "bg-canvas text-ink shadow-sm" : "text-muted hover:text-ink")}
            >
              {value === "mentions" ? "メンション" : "スレッド"}
              {value === "threads" && summary.unread_count > 0 && (
                <span className={cn("rounded-full px-1.5 text-[11px] font-bold leading-4 text-white", summary.mention_count > 0 ? "bg-rose-500" : "bg-muted")}>{summary.unread_count}</span>
              )}
            </button>
          ))}
        </div>
      </div>
      {/* Both stay mounted once shown: the other segment keeps its rows and scroll position. */}
      <div className="flex min-h-0 flex-1 flex-col" hidden={segment !== "mentions"}>
        <MentionsView controller={controller} onOpen={onOpenMessage} embedded />
      </div>
      {threadsShown && (
        <div className="flex min-h-0 flex-1 flex-col" hidden={segment !== "threads"}>
          <ThreadsView controller={controller} selectedId={null} onOpen={onOpenThread} embedded />
        </div>
      )}
    </section>
  );
}
