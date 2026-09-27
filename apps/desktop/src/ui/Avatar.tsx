import type { PresenceStatus } from "../api/types";
import { useAvatarUrl } from "./avatars";
import { avatarHue, initials } from "./format";
import { cn } from "./primitives";

/** The profile picture when the user has one (M14a), else initials on a colour derived from the id. `presence` adds the status dot. */
export function Avatar({ id, name, size = 36, className, presence }: { id: string; name: string; size?: number; className?: string; presence?: PresenceStatus }) {
  const hue = avatarHue(id);
  const dot = Math.max(8, Math.round(size * 0.3));
  const picture = useAvatarUrl(id);
  return (
    // A rounded square (Slack) unless the caller sets its own radius; the picture and initials inherit it.
    <span className={cn("relative inline-flex shrink-0 rounded-[22%]", className)} style={{ width: size, height: size }} aria-hidden="true">
      {picture ? (
        <img src={picture} alt="" className={cn("h-full w-full rounded-[inherit] object-cover", className)} style={{ width: size, height: size }} draggable={false} />
      ) : (
        <span
          className={cn("inline-flex h-full w-full select-none items-center justify-center rounded-[inherit] font-bold text-white", className)}
          style={{ fontSize: Math.round(size * 0.42), background: `hsl(${hue} 55% 45%)`, width: size, height: size }}
        >
          {initials(name)}
        </span>
      )}
      {presence && presence !== "offline" && (
        <span
          className={cn("absolute -bottom-0.5 -right-0.5 rounded-full border-2 border-canvas", presence === "online" ? "bg-success" : "bg-warning")}
          style={{ width: dot, height: dot }}
          title={presenceLabel(presence)}
        />
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
