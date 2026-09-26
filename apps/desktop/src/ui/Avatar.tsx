import { avatarHue, initials } from "./format";
import { cn } from "./primitives";

/** Initials on a colour derived from the user id; no image uploads in v1. */
export function Avatar({ id, name, size = 36, className }: { id: string; name: string; size?: number; className?: string }) {
  const hue = avatarHue(id);
  return (
    <span
      className={cn("inline-flex shrink-0 select-none items-center justify-center rounded-lg font-bold text-white", className)}
      aria-hidden="true"
      style={{ width: size, height: size, fontSize: Math.round(size * 0.42), background: `hsl(${hue} 55% 45%)` }}
    >
      {initials(name)}
    </span>
  );
}
