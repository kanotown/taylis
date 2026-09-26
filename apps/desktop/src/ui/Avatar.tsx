import type { PresenceStatus } from "../api/types";
import { avatarHue, initials } from "./format";
import { cn } from "./primitives";

/** Initials on a colour derived from the user id; no image uploads in v1. `presence` adds the status dot. */
export function Avatar({ id, name, size = 36, className, presence }: { id: string; name: string; size?: number; className?: string; presence?: PresenceStatus }) {
  const hue = avatarHue(id);
  const dot = Math.max(8, Math.round(size * 0.3));
  return (
    <span className={cn("relative inline-flex shrink-0", className)} style={{ width: size, height: size }} aria-hidden="true">
      <span
        className={cn("inline-flex h-full w-full select-none items-center justify-center rounded-[inherit] font-bold text-white", className)}
        style={{ fontSize: Math.round(size * 0.42), background: `hsl(${hue} 55% 45%)`, width: size, height: size }}
      >
        {initials(name)}
      </span>
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
