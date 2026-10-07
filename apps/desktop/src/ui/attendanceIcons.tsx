/**
 * 在室状況 (docs/PRESENCE.md §2.1, §7): the states' icons. A copy of apps/shared/attendance-icons.json's keys and their
 * lucide-react components (tests/attendance.test.tsx compares them with the file); iOS draws the same meanings with SF
 * Symbols and Android with Material icons. A state whose icon this client does not know (a key added later) or that
 * has none shows its emoji instead, or no picture at all.
 *
 * The badge is the one look of a state everywhere: a rounded chip in the state's colour (the text emoji palette, light
 * and dark) with the icon in the palette's foreground colour and the name.
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

/** The palette colours as CSS variables for `.text-emoji` (light and dark). */
export function attendanceColorStyle(color: string): CSSProperties {
  const colors = textEmojiColors(color);
  return { "--te-bg": colors.light.bg, "--te-fg": colors.light.fg, "--te-bg-dark": colors.dark.bg, "--te-fg-dark": colors.dark.fg } as CSSProperties;
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
        "text-emoji inline-flex min-w-0 max-w-full items-center rounded-md font-medium",
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
