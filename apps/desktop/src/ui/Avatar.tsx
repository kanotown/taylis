import type { PresenceLook } from "../api/types";
import type { Store } from "../sync/store";
import { useAvatar } from "./avatars";
import { avatarHue, initials } from "./format";
import { cn, HoverList } from "./primitives";
import { t } from "../i18n";

/**
 * The profile picture when the user has one (M14a), else initials on a colour derived from the id. A picture never loaded
 * before shows a neutral tile of the same shape while it loads (not the initials, which would flash). `presence` adds the
 * status dot: green online, amber away, and 取り込み中 a plain red disc (docs/PRESENCE.md §11; no white bar since 2026-10-13).
 * Offline (2026-10-13, testers: 「オフラインの時は白丸で」) is a hollow grey ring (`muted`, about 2 px) wherever a dot is
 * shown; a caller that wants no dot (a bot, a webhook) passes no `presence`.
 *
 * `presenceCutout` (message rows, whose background changes under the pointer, when highlighted or selected): the dot's
 * ring is not painted but cut out of the picture (a hole a ring wider than the dot, as iOS's `badgeHole`), so whatever
 * is behind the avatar shows through it and the ring always matches the row.
 *
 * The offline ring is always cut out that way, wherever it sits: the hole shows the surface behind the avatar (a row,
 * the sidebar, a popover, light or dark) both in the gap and in the ring's centre, so it reads as one grey circle. (Before,
 * a painted gap ring around a grey ring around a `canvas` centre read as two circles on the sidebar, 「二重丸」.) Its gap
 * is 1 px on the small dots (under 12 px) so the ring keeps a centre to see, 2 px on the larger ones.
 */
export function Avatar({ id, name, size = 36, className, presence, presenceClassName, dotSize, presenceCutout = false }: { id: string; name: string; size?: number; className?: string; presence?: PresenceLook; presenceClassName?: string; dotSize?: number; presenceCutout?: boolean }) {
  const hue = avatarHue(id);
  const dot = dotSize ?? avatarDotSize(size);
  // The dot overhangs the corner by a fifth of itself (2 px for the usual 8–10 px dots, 3 px for my header's 14 px).
  const overhang = -Math.max(2, Math.round(dot * 0.2));
  const picture = useAvatar(id);
  const offline = presence === "offline";
  // The hole: a circle the dot's size (its 2 px border included) centred where the dot is.
  const centre = size - overhang - dot / 2;
  const hole = `radial-gradient(circle at ${centre}px ${centre}px, transparent ${dot / 2}px, #000 ${dot / 2 + 0.5}px)`;
  const cut = presence && (presenceCutout || offline) ? { maskImage: hole, WebkitMaskImage: hole } : undefined;
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
      {presence && (
        // Above the dot (HoverList), not a native title under the pointer.
        <HoverList content={presenceLabel(presence)}>
          {offline ? (
            // One element, one border: the grey ring, inset by the gap; around it and inside it the hole shows the surface.
            <span
              data-presence={presence}
              className="absolute box-border rounded-full border-solid border-muted bg-transparent"
              style={{ width: dot - 2 * offlineGap(dot), height: dot - 2 * offlineGap(dot), right: overhang + offlineGap(dot), bottom: overhang + offlineGap(dot), borderWidth: offlineRing(dot) }}
            />
          ) : (
            <span
              data-presence={presence}
              className={cn(
                "absolute inline-flex items-center justify-center rounded-full border-2",
                // Cut out: a transparent border the hole shows through, the colour inside it only.
                presenceCutout ? "border-transparent bg-clip-padding" : "border-canvas",
                presence === "online" ? "bg-success" : presence === "away" ? "bg-warning" : "bg-danger",
                presenceClassName,
              )}
              style={{ width: dot, height: dot, right: overhang, bottom: overhang }}
            />
          )}
        </HoverList>
      )}
    </span>
  );
}

/** The offline ring's gap to the picture: 1 px on a dot under 12 px (so the ring keeps a centre), else 2 px. */
export function offlineGap(dot: number): number {
  return dot >= 12 ? 2 : 1;
}

/** The offline ring's width: 2 px from a 10 px dot up, 1.5 px on the 8–9 px ones. */
export function offlineRing(dot: number): number {
  return dot >= 10 ? 2 : 1.5;
}

/** The dot for `userId` in a list or a card: none for a bot or a webhook's bot (they have no presence), else their look. */
export function presenceDotOf(store: Pick<Store, "users" | "presenceOf">, userId: string): PresenceLook | undefined {
  return store.users.get(userId)?.role === "bot" ? undefined : store.presenceOf(userId);
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
