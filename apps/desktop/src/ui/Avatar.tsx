import type { PresenceLook } from "../api/types";
import { useAvatar } from "./avatars";
import { avatarHue, initials } from "./format";
import { cn, HoverList } from "./primitives";
import { t } from "../i18n";

/**
 * The profile picture when the user has one (M14a), else initials on a colour derived from the id. A picture never loaded
 * before shows a neutral tile of the same shape while it loads (not the initials, which would flash). `presence` adds the
 * status dot: green online, amber away, and 取り込み中 a plain red disc (docs/PRESENCE.md §11; no white bar since 2026-10-13). Offline draws
 * nothing unless `showOffline` (my own avatar in the sidebar header: a hollow ring, so オフライン表示 shows).
 *
 * `presenceCutout` (message rows, whose background changes under the pointer, when highlighted or selected): the dot's
 * ring is not painted but cut out of the picture (a hole a ring wider than the dot, as iOS's `badgeHole`), so whatever
 * is behind the avatar shows through it and the ring always matches the row.
 */
export function Avatar({ id, name, size = 36, className, presence, presenceClassName, showOffline = false, dotSize, presenceCutout = false }: { id: string; name: string; size?: number; className?: string; presence?: PresenceLook; presenceClassName?: string; showOffline?: boolean; dotSize?: number; presenceCutout?: boolean }) {
  const hue = avatarHue(id);
  const dot = dotSize ?? avatarDotSize(size);
  // The dot overhangs the corner by a fifth of itself (2 px for the usual 8–10 px dots, 3 px for my header's 14 px).
  const overhang = -Math.max(2, Math.round(dot * 0.2));
  const picture = useAvatar(id);
  const showDot = !!presence && (presence !== "offline" || showOffline);
  // The hole: a circle the dot's size (its 2 px border included) centred where the dot is.
  const centre = size - overhang - dot / 2;
  const hole = `radial-gradient(circle at ${centre}px ${centre}px, transparent ${dot / 2}px, #000 ${dot / 2 + 0.5}px)`;
  const cut = showDot && presenceCutout ? { maskImage: hole, WebkitMaskImage: hole } : undefined;
  return (
    // A rounded square (Slack) unless the caller sets its own radius; the picture and initials inherit it.
    <span className={cn("relative inline-flex shrink-0 rounded-[22%]", className)} style={{ width: size, height: size }} aria-hidden="true">
      {picture.state === "ready" ? (
        <img src={picture.url} alt="" className={cn("h-full w-full rounded-[inherit] object-cover", className)} style={{ width: size, height: size, ...cut }} draggable={false} />
      ) : picture.state === "loading" ? (
        <span data-testid="avatar-loading" className={cn("h-full w-full rounded-[inherit]", className)} style={{ background: "rgb(128 128 128 / 0.22)", width: size, height: size, ...cut }} />
      ) : (
        <span
          className={cn("inline-flex h-full w-full select-none items-center justify-center rounded-[inherit] font-bold text-white", className)}
          style={{ fontSize: Math.round(size * 0.42), background: `hsl(${hue} 55% 45%)`, width: size, height: size, ...cut }}
        >
          {initials(name)}
        </span>
      )}
      {presence && showDot && (
        // Above the dot (HoverList), not a native title under the pointer.
        <HoverList content={presenceLabel(presence)}>
          <span
            data-presence={presence}
            className={cn(
              "absolute inline-flex items-center justify-center rounded-full border-2",
              // Cut out: a transparent border the hole shows through, the colour inside it only.
              presenceCutout ? "border-transparent bg-clip-padding" : "border-canvas",
              presence === "online" ? "bg-success" : presence === "away" ? "bg-warning" : presence === "dnd" ? "bg-danger" : "bg-canvas",
              presenceClassName,
            )}
            style={{ width: dot, height: dot, right: overhang, bottom: overhang }}
          >
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
