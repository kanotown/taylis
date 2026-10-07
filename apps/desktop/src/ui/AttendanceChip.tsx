/**
 * M140 (docs/PRESENCE.md §7): the small 「在室状況」 chip next to a name (the profile card, member lists, the directory):
 * the person's state in its colour (the text emoji palette, light and dark). Nothing while the board is off or the
 * person has no state.
 */
import type { CSSProperties } from "react";

import type { AppController } from "../state/app";
import { entryOf, sinceLabel, stateOf, stateText } from "./attendance";
import { cn } from "./primitives";
import { textEmojiColors } from "./textEmoji";

export function attendanceColorStyle(color: string): CSSProperties {
  const colors = textEmojiColors(color);
  return { "--te-bg": colors.light.bg, "--te-fg": colors.light.fg, "--te-bg-dark": colors.dark.bg, "--te-fg-dark": colors.dark.fg } as CSSProperties;
}

export function AttendanceChip({ controller, userId, className }: { controller: AppController; userId: string; className?: string }) {
  const board = controller.store.attendance;
  const entry = entryOf(board, userId);
  const state = stateOf(board, entry?.state_id);
  if (!entry || !state) return null;
  const title = [stateText(state), entry.note, sinceLabel(entry.since)].filter(Boolean).join(" · ");
  return (
    <span
      data-attendance-chip={state.kind}
      title={title}
      className={cn("text-emoji inline-flex max-w-[10em] shrink-0 items-center truncate rounded px-1.5 text-[11px] font-medium leading-[18px]", className)}
      style={attendanceColorStyle(state.color)}
    >
      {stateText(state)}
    </span>
  );
}
