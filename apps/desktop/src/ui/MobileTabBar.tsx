import { Bell, CircleUserRound, House, MessageCircle } from "lucide-react";
import type { LucideIcon } from "lucide-react";

import type { AppController } from "../state/app";
import { activityBadge, dmBadge, homeDot, MOBILE_TAB_LABELS, MOBILE_TABS, type MobileTab } from "./mobileTabs";
import { cn } from "./primitives";

const ICONS: Record<MobileTab, LucideIcon> = { home: House, dm: MessageCircle, activity: Bell, you: CircleUserRound };

/**
 * M34: the phone's bottom tabs (MOBILE_UI.md §5), on the tabs' root screens only. The badges follow §8: DM = unread
 * DMs, activity = unread followed threads + channels with a mention (red with a mention), home = a dot for an unread
 * channel.
 */
export function MobileTabBar({ controller, tab, onTab }: { controller: AppController; tab: MobileTab; onTab: (tab: MobileTab) => void }) {
  const store = controller.store;
  const meId = store.me?.id ?? controller.me?.id ?? null;
  const channels = [...store.channels.values()];
  const dms = dmBadge(channels, meId);
  const activity = activityBadge(channels, store.threadSummary);
  const dot = homeDot(channels, meId);
  return (
    <nav aria-label="タブ" className="flex shrink-0 border-t border-line bg-canvas pb-[env(safe-area-inset-bottom)]">
      {MOBILE_TABS.map((value) => {
        const Icon = ICONS[value];
        const selected = value === tab;
        const count = value === "dm" ? dms : value === "activity" ? activity.count : 0;
        const label = MOBILE_TAB_LABELS[value];
        const described = count > 0 ? `${label} (未読 ${count})` : value === "home" && dot ? `${label} (未読あり)` : label;
        return (
          <button
            key={value}
            type="button"
            aria-label={described}
            aria-current={selected ? "page" : undefined}
            data-tab={value}
            onClick={() => onTab(value)}
            className={cn("relative flex min-h-[52px] flex-1 flex-col items-center justify-center gap-0.5 pt-1.5 pb-1 text-[11px] font-medium transition-colors", selected ? "text-accent" : "text-muted hover:text-ink")}
          >
            <span className="relative">
              <Icon size={22} strokeWidth={selected ? 2.4 : 1.9} />
              {count > 0 && (
                <span
                  data-badge={value === "activity" && !activity.mention ? "neutral" : "danger"}
                  className={cn(
                    "absolute -right-2.5 -top-1.5 inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-full px-1 text-[10.5px] font-bold leading-none text-white ring-2 ring-canvas",
                    value === "activity" && !activity.mention ? "bg-muted" : "bg-rose-500",
                  )}
                >
                  {count > 99 ? "99+" : count}
                </span>
              )}
              {value === "home" && dot && <span data-badge="dot" className="absolute -right-1 -top-0.5 h-2.5 w-2.5 rounded-full bg-rose-500 ring-2 ring-canvas" />}
            </span>
            <span aria-hidden="true">{label}</span>
          </button>
        );
      })}
    </nav>
  );
}
