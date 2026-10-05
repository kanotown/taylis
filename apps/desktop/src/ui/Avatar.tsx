import type { PresenceStatus } from "../api/types";
import { useAvatar } from "./avatars";
import { avatarHue, initials } from "./format";
import { cn, HoverList } from "./primitives";

/**
 * The profile picture when the user has one (M14a), else initials on a colour derived from the id. A picture never loaded
 * before shows a neutral tile of the same shape while it loads (not the initials, which would flash). `presence` adds the
 * status dot.
 */
export function Avatar({ id, name, size = 36, className, presence, presenceClassName }: { id: string; name: string; size?: number; className?: string; presence?: PresenceStatus; presenceClassName?: string }) {
  const hue = avatarHue(id);
  const dot = Math.max(8, Math.round(size * 0.3));
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
      {presence && presence !== "offline" && (
        // Above the dot (HoverList), not a native title under the pointer.
        <HoverList content={presenceLabel(presence)}>
          <span
            data-presence={presence}
            className={cn("absolute -bottom-0.5 -right-0.5 rounded-full border-2 border-canvas", presence === "online" ? "bg-success" : "bg-warning", presenceClassName)}
            style={{ width: dot, height: dot }}
          />
        </HoverList>
      )}
    </span>
  );
}

export function presenceLabel(status: PresenceStatus): string {
  switch (status) {
    case "online":
      return "オンライン";
    case "away":
      return "離席中";
    default:
      return "オフライン";
  }
}
