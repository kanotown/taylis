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
 * a painted gap ring around a grey ring around a `canvas` centre read as two circles on the sidebar, 「二重丸」.)
 *
 * Sizes (docs/PRESENCE.md §11.9, one rule on every client): the dot is `avatarDotSize(size)` across with its ring, the
 * ring `presenceRing(dot)` wide, and it overhangs the corner by `presenceOverhang`. The offline ring uses the same width
 * for its gap and its grey stroke.
 */
export function Avatar({ id, name, size = 36, className, presence, presenceClassName, dotSize, presenceCutout = false }: { id: string; name: string; size?: number; className?: string; presence?: PresenceLook; presenceClassName?: string; dotSize?: number; presenceCutout?: boolean }) {
  const hue = avatarHue(id);
  const dot = dotSize ?? avatarDotSize(size);
  const ring = presenceRing(dot);
  const overhang = -presenceOverhang(size, dot);
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
              style={{ width: dot - 2 * ring, height: dot - 2 * ring, right: overhang + ring, bottom: overhang + ring, borderWidth: ring }}
            />
          ) : (
            <span
              data-presence={presence}
              className={cn(
                "absolute inline-flex items-center justify-center rounded-full border-solid",
                // Cut out: a transparent border the hole shows through, the colour inside it only.
                presenceCutout ? "border-transparent bg-clip-padding" : "border-canvas",
                presence === "online" ? "bg-success" : presence === "away" ? "bg-warning" : "bg-danger",
                presenceClassName,
              )}
              style={{ width: dot, height: dot, right: overhang, bottom: overhang, borderWidth: ring }}
            />
          )}
        </HoverList>
      )}
    </span>
  );
}

/** The dot for `userId` in a list or a card: none for a bot or a webhook's bot (they have no presence), else their look. */
export function presenceDotOf(store: Pick<Store, "users" | "presenceOf">, userId: string): PresenceLook | undefined {
  return store.users.get(userId)?.role === "bot" ? undefined : store.presenceOf(userId);
}

/**
 * The presence dot for a picture `size` px wide, its ring included (docs/PRESENCE.md §11.9, the same on iOS and
 * Android): about two fifths of the picture, at least 10 px (so the colour inside the ring stays readable, 7 px) and at
 * most 20 px. 18–26 px pictures get 10 px, 30 px 11, 32 px 12, 36 px 14, 40 px 15, 56 px and up 20. (Until 2026-10-23
 * it was three tenths, at least 8 px: 8 px with a 2 px ring left 4 px of colour on the sidebar's and the pickers' 18–24 px
 * pictures, 9 px in the thread pane.)
 */
export function avatarDotSize(size: number): number {
  return Math.min(20, Math.max(10, Math.round(size * 0.38)));
}

/**
 * The ring around a dot of `dot` px (the gap to the picture, and the offline ring's grey stroke): three twentieths of
 * the dot to the nearest half pixel — 1.5 px on 10–11 px dots, 2 px on 12–14, 2.5 px on 15–18, 3 px on 19–20.
 */
export function presenceRing(dot: number): number {
  return Math.round((dot * 3) / 10) / 2;
}

/**
 * How far the dot's outer edge reaches past the picture's corner: a fifth of the dot (at least 2 px). On a picture of
 * 20 px or less (the sidebar's DMs, the pickers) three tenths, so the 10 px dot keeps clear of the initials and only its
 * inner part sits on the picture's corner; it is not hidden there, as it is the only presence cue in those lists.
 */
export function presenceOverhang(size: number, dot: number): number {
  return size <= 20 ? Math.round(dot * 0.3) : Math.max(2, Math.round(dot * 0.2));
}

/**
 * My own picture in the sidebar header (2026-10-12: its dot was too small to read, 10 px with 6 px of colour inside the
 * ring): 36 px with a 14 px dot in a 2 px ring, so the colour is 10 px across. Since 2026-10-23 that is what
 * `avatarDotSize(36)` gives too; the constant stays as the header's deliberate size.
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
