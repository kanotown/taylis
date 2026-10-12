import type { PresenceLook } from "../api/types";
import { useAvatar } from "./avatars";
import { avatarHue, initials } from "./format";
import { cn, HoverList } from "./primitives";
import { t } from "../i18n";

/**
 * The profile picture when the user has one (M14a), else initials on a colour derived from the id. A picture never loaded
 * before shows a neutral tile of the same shape while it loads (not the initials, which would flash). `presence` adds the
 * status dot: green online, amber away, and 取り込み中 a red disc with a white bar (docs/PRESENCE.md §11). Offline draws
 * nothing unless `showOffline` (my own avatar in the sidebar header: a hollow ring, so オフライン表示 shows).
 */
export function Avatar({ id, name, size = 36, className, presence, presenceClassName, showOffline = false, dotSize }: { id: string; name: string; size?: number; className?: string; presence?: PresenceLook; presenceClassName?: string; showOffline?: boolean; dotSize?: number }) {
  const hue = avatarHue(id);
  const dot = dotSize ?? avatarDotSize(size);
  // The dot overhangs the corner by a fifth of itself (2 px for the usual 8–10 px dots, 3 px for my header's 14 px).
  const overhang = -Math.max(2, Math.round(dot * 0.2));
  const picture = useAvatar(id);
  return (
    // A rounded square (Slack) unless the caller sets its own radius; the picture and initials inherit it.
    <span className={cn("relative inline-flex shrink-0 rounded-[22%]", className)} style={{ width: size, height: size }} aria-hidden="true">
      {picture.state === "ready" ? (
        <img src={picture.url} alt="" className={cn("h-full w-full rounded-[inherit] object-cover", className)} style={{ width: size, height: size }} draggable={false} />
      ) : picture.state === "loading" ? (
        <span data-testid="avatar-loading" className={cn("h-full w-full rounded-[inherit]", className)} style={{ background: "rgb(128 128 128 / 0.22)", width: size, height: size }} />
      ) : (
        <span
          className={cn("inline-flex h-full w-full select-none items-center justify-center rounded-[inherit] font-bold text-white", className)}
          style={{ fontSize: Math.round(size * 0.42), background: `hsl(${hue} 55% 45%)`, width: size, height: size }}
        >
          {initials(name)}
        </span>
      )}
      {presence && (presence !== "offline" || showOffline) && (
        // Above the dot (HoverList), not a native title under the pointer.
        <HoverList content={presenceLabel(presence)}>
          <span
            data-presence={presence}
            className={cn(
              "absolute inline-flex items-center justify-center rounded-full border-2 border-canvas",
              presence === "online" ? "bg-success" : presence === "away" ? "bg-warning" : presence === "dnd" ? "bg-danger" : "bg-canvas",
              presenceClassName,
            )}
            style={{ width: dot, height: dot, right: overhang, bottom: overhang }}
          >
            {presence === "dnd" && <span data-dnd-bar className="block rounded-full bg-white" style={{ width: "62%", height: dndBarHeight(dot) }} />}
            {presence === "offline" && <span className="block h-full w-full rounded-full border-solid border-muted" style={{ borderWidth: dot >= 12 ? 2 : 1.5 }} />}
          </span>
        </HoverList>
      )}
    </span>
  );
}

/** The presence dot for a picture `size` px wide: three tenths of it, at least 8 px. */
export function avatarDotSize(size: number): number {
  return Math.max(8, Math.round(size * 0.3));
}

/**
 * My own picture in the sidebar header (2026-10-12: its dot was too small to read, 10 px with 6 px of colour inside the
 * ring): 36 px with a 14 px dot in a 2 px ring, so the colour is 10 px across.
 */
export const HEADER_AVATAR_SIZE = 36;
export const HEADER_DOT_SIZE = 14;

/**
 * The attendance board's pictures (2026-10-12, PRESENCE.md §11.6: the dot at their corner was too small, 9 px on 30 px):
 * 36 px, and a dot of about two fifths of the picture in its 2 px ring (14 px on 36 px, 15 px on 40 px, at least 12 px).
 */
export const BOARD_AVATAR_SIZE = 36;
export function boardDotSize(size: number): number {
  return Math.max(12, Math.round(size * 0.38));
}

/** 取り込み中's white bar keeps to the dot: about a fifth of it, at least 1.5 px (2 px on a 10 px dot, 3 px on 14 px). */
export function dndBarHeight(dot: number): number {
  return Math.max(1.5, Math.round(dot * 0.18));
}

export function presenceLabel(status: PresenceLook): string {
  switch (status) {
    case "online":
      return t("connection.online");
    case "away":
      return t("directory.away");
    case "dnd":
      return t("presence.choice.dnd");
    default:
      return t("connection.offline");
  }
}
