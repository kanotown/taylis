import { avatarHue, initials } from "./format";

/** Initials on a colour derived from the user id; no image uploads in v1. */
export function Avatar({ id, name, size = 36 }: { id: string; name: string; size?: number }) {
  const hue = avatarHue(id);
  return (
    <span
      className="avatar"
      aria-hidden="true"
      style={{ width: size, height: size, fontSize: Math.round(size * 0.42), background: `hsl(${hue} 55% 45%)` }}
    >
      {initials(name)}
    </span>
  );
}
