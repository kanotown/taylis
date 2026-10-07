/**
 * 在室状況 (docs/PRESENCE.md §2.1, §7): the states' icons. A copy of apps/shared/attendance-icons.json's keys and their
 * lucide-react components (tests/attendance.test.tsx compares them with the file); iOS draws the same meanings with SF
 * Symbols and Android with Material icons. A state whose icon this client does not know (a key added later) or that
 * has none shows its emoji instead, or no picture at all.
 *
 * The badge is the one look of a state everywhere (2026-10-07): a solid rounded chip in the state's colour
 * (apps/shared/attendance-badge-colors.json, the same in light and dark) with a white icon and name.
 */
import {
  Building2,
  Circle,
  CircleMinus,
  Clock,
  DoorOpen,
  FlaskConical,
  House,
  Laptop,
  Library,
  type LucideIcon,
  MapPin,
  Plane,
  Presentation,
  Thermometer,
  TreePalm,
  Users,
  Utensils,
} from "lucide-react";
import type { CSSProperties } from "react";

import type { AttendanceStateOut } from "../api/types";
import { type MessageKey, t } from "../i18n";
import { cn } from "./primitives";
import { textEmojiColors } from "./textEmoji";

/** The catalogue in its order (the picker's): key → the lucide component (its name is the file's `lucide`). */
export const ATTENDANCE_ICONS: ReadonlyArray<{ key: string; lucide: string; Icon: LucideIcon }> = [
  { key: "in_room", lucide: "DoorOpen", Icon: DoorOpen },
  { key: "on_site", lucide: "Building2", Icon: Building2 },
  { key: "off_site", lucide: "MapPin", Icon: MapPin },
  { key: "gone", lucide: "House", Icon: House },
  { key: "meeting", lucide: "Users", Icon: Users },
  { key: "class", lucide: "Presentation", Icon: Presentation },
  { key: "remote", lucide: "Laptop", Icon: Laptop },
  { key: "lunch", lucide: "Utensils", Icon: Utensils },
  { key: "trip", lucide: "Plane", Icon: Plane },
  { key: "away", lucide: "Clock", Icon: Clock },
  { key: "busy", lucide: "CircleMinus", Icon: CircleMinus },
  { key: "sick", lucide: "Thermometer", Icon: Thermometer },
  { key: "vacation", lucide: "TreePalm", Icon: TreePalm },
  { key: "lab", lucide: "FlaskConical", Icon: FlaskConical },
  { key: "library", lucide: "Library", Icon: Library },
  { key: "other", lucide: "Circle", Icon: Circle },
];

const BY_KEY = new Map(ATTENDANCE_ICONS.map((icon) => [icon.key, icon.Icon]));

/** The lucide component of a key, or null (none, or a key this client does not know). */
export function attendanceIcon(key: string | null | undefined): LucideIcon | null {
  return (key && BY_KEY.get(key)) || null;
}

/** The icon's meaning in the UI language (the picker's tooltip and screen reader name). */
export function attendanceIconLabel(key: string): string {
  return t(`attendance.icon.${key}` as MessageKey);
}

/**
 * The solid badge palette: a copy of apps/shared/attendance-badge-colors.json (tests/attendance.test.tsx compares it
 * and checks that white on each shade meets WCAG AA). The same shades in light and dark.
 */
export const ATTENDANCE_BADGE_FG = "#FFFFFF";
export const ATTENDANCE_BADGE_COLORS: Readonly<Record<string, string>> = {
  gray: "#4B5563",
  red: "#DC2626",
  orange: "#C2410C",
  yellow: "#A16207",
  green: "#15803D",
  blue: "#2563EB",
  purple: "#7C3AED",
  pink: "#BE185D",
};

/** A colour key's solid shade (an unknown key = gray). */
export function attendanceBadgeColor(color: string | null | undefined): string {
  return ATTENDANCE_BADGE_COLORS[color ?? "gray"] ?? "#4B5563";
}

/** The solid badge's colours (the shade and white), for anything drawn as the badge. */
export function attendanceColorStyle(color: string): CSSProperties {
  return { background: attendanceBadgeColor(color), color: ATTENDANCE_BADGE_FG };
}

/**
 * Only the state's colour, for an icon on the page's background (an unselected state button): the solid shade in the
 * light theme, the text emoji palette's dark-theme foreground in the dark one (the solid shades are too dark on a dark
 * page). Goes with the `attendance-tint` class (styles.css).
 */
export function attendanceTintStyle(color: string): CSSProperties {
  return { "--at-tint": attendanceBadgeColor(color), "--at-tint-dark": textEmojiColors(color).dark.fg } as CSSProperties;
}

/** A state's picture: its icon, else its emoji, else nothing. Decorative (the name is always next to it or in a label). */
export function StateGlyph({ state, size = 14, className }: { state: Pick<AttendanceStateOut, "icon" | "emoji">; size?: number; className?: string }) {
  const Icon = attendanceIcon(state.icon);
  if (Icon) return <Icon aria-hidden size={size} strokeWidth={2.25} className={cn("shrink-0", className)} data-attendance-icon={state.icon} />;
  if (state.emoji) {
    return (
      <span aria-hidden className={cn("shrink-0 leading-none", className)} style={{ fontSize: size }} data-attendance-emoji>
        {state.emoji}
      </span>
    );
  }
  return null;
}

/**
 * The chip of a state: colour, picture and name. `size` sm = next to a name (profile card, member lists), md = the
 * board's group headers and the pill's menu.
 */
export function StateBadge({ state, size = "md", className }: { state: AttendanceStateOut; size?: "sm" | "md"; className?: string }) {
  const small = size === "sm";
  return (
    <span
      data-attendance-badge={state.kind}
      className={cn(
        "inline-flex min-w-0 max-w-full items-center rounded-md font-medium",
        small ? "h-[18px] gap-1 px-1.5 text-[11px]" : "h-6 gap-1.5 px-2 text-[13px]",
        className,
      )}
      style={attendanceColorStyle(state.color)}
    >
      <StateGlyph state={state} size={small ? 11 : 14} />
      <span className="truncate">{state.label}</span>
    </span>
  );
}
