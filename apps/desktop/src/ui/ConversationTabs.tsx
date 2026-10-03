import type { ChannelLinkOut } from "../api/types";
import type { AppController } from "../state/app";
import type { ChannelState } from "../sync/types";
import { canEditLinks, ChannelLinkChips } from "./ChannelLinks";
import { cn } from "./primitives";

/**
 * M29: what a conversation shows on a phone, switched by the tab row under its header. M43: 「キャンバス」 (CANVAS.md
 * §4.1), which the wide layout has too (in the header). M51: 「予定」, a channel's calendar (CALENDAR.md §7; not in a DM).
 * M55: 「タスク」, a channel's board (TASKS.md §6; not in a DM either).
 */
export type ConversationTab = "messages" | "canvas" | "events" | "tasks" | "pins" | "files";

const TABS: ReadonlyArray<readonly [ConversationTab, string]> = [
  ["messages", "メッセージ"],
  ["canvas", "キャンバス"],
  ["events", "予定"],
  ["tasks", "タスク"],
  ["pins", "ピン留め"],
  ["files", "ファイル"],
];

/** M51: 「予定」 with a subtle count of today's and tomorrow's events, when there are some. */
export function eventsTabLabel(count: number): string {
  return count > 0 ? `予定 ${count}` : "予定";
}

/**
 * M29: one horizontally scrolling row under a conversation's header on a phone: the tabs, then the conversation's links
 * (the M15f bar, which lives in this row there) and 「＋ リンク」 for those who may edit them.
 */
export function ConversationTabs({ controller, channel, tab, onTab, onAddLink, onEditLink, upcoming = 0 }: {
  controller: AppController;
  channel: ChannelState;
  tab: ConversationTab;
  /** M51: the channel's events today and tomorrow (the 「予定」 tab's count). */
  upcoming?: number;
  onTab: (tab: ConversationTab) => void;
  onAddLink: () => void;
  onEditLink: (link: ChannelLinkOut) => void;
}) {
  const hasLinks = controller.store.linksOf(channel.id).length > 0 || canEditLinks(channel, controller);
  return (
    <div className="flex shrink-0 items-center gap-1 overflow-x-auto overflow-y-hidden border-b border-line px-2 [scrollbar-width:none]">
      <div role="tablist" aria-label="会話の表示" className="flex shrink-0 items-center">
        {TABS.filter(([value]) => (value !== "events" && value !== "tasks") || channel.type === "public" || channel.type === "private").map(([value, label]) => (
          <button
            key={value}
            type="button"
            role="tab"
            aria-selected={tab === value}
            onClick={() => onTab(value)}
            className={cn(
              "relative shrink-0 whitespace-nowrap px-3 py-2.5 text-sm font-medium transition-colors",
              tab === value ? "text-ink after:absolute after:inset-x-2 after:bottom-0 after:h-0.5 after:rounded-full after:bg-accent" : "text-muted hover:text-ink",
            )}
          >
            {value === "events" ? eventsTabLabel(upcoming) : label}
          </button>
        ))}
      </div>
      {hasLinks && <span aria-hidden className="mx-1 h-4 w-px shrink-0 bg-line" />}
      <div aria-label="リンク" className="flex shrink-0 items-center gap-1">
        <ChannelLinkChips controller={controller} channel={channel} onAdd={onAddLink} onEdit={onEditLink} />
      </div>
    </div>
  );
}
