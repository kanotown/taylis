/**
 * M140 (docs/PRESENCE.md §7): the small 「在室状況」 chip next to a name (the profile card, member lists, the directory):
 * the person's state as a small badge (its icon, else its emoji, and its name in its colour; the text emoji palette,
 * light and dark). Nothing while the board is off or the person has no state.
 */
import type { AppController } from "../state/app";
import { entryOf, sinceLabel, stateOf } from "./attendance";
import { StateBadge } from "./attendanceIcons";
import { cn } from "./primitives";

export function AttendanceChip({ controller, userId, className }: { controller: AppController; userId: string; className?: string }) {
  const board = controller.store.attendance;
  const entry = entryOf(board, userId);
  const state = stateOf(board, entry?.state_id);
  if (!entry || !state) return null;
  const title = [state.label, entry.note, sinceLabel(entry.since)].filter(Boolean).join(" · ");
  return (
    <span data-attendance-chip={state.kind} title={title} className={cn("inline-flex max-w-[10em] shrink-0", className)}>
      <StateBadge state={state} size="sm" />
    </span>
  );
}
