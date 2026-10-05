import type { UserPublic } from "../api/types";
import { t, intlLocale, labelled } from "../i18n";

/** A custom status (M11d) that has not expired; null otherwise. */
export function activeStatus(user: UserPublic | undefined | null, now = Date.now()): { emoji: string; text: string } | null {
  if (!user) return null;
  const emoji = user.status_emoji ?? "";
  const text = user.status_text ?? "";
  if (!emoji && !text) return null;
  if (user.status_expires_at && Date.parse(user.status_expires_at) <= now) return null;
  return { emoji, text };
}

/** Quick picks in the status editor (Slack-like). */
export const STATUS_PRESETS: Array<{ emoji: string; text: string }> = [
  { emoji: "📅", get text() { return t("status.preset.meeting"); } },
  { emoji: "🚌", get text() { return t("status.preset.commuting"); } },
  { emoji: "🤒", get text() { return t("status.preset.sick"); } },
  { emoji: "🌴", get text() { return t("status.preset.vacation"); } },
  { emoji: "🏠", get text() { return t("status.preset.home"); } },
  { emoji: "🍱", get text() { return t("status.preset.lunch"); } },
];

export type StatusExpiry = "never" | "30m" | "1h" | "4h" | "today" | "week";

export const EXPIRY_OPTIONS: Array<[StatusExpiry, string]> = [
  labelled("never", "status.expiry.never"),
  labelled("30m", "status.expiry.30m"),
  labelled("1h", "status.expiry.1h"),
  labelled("4h", "status.expiry.4h"),
  labelled("today", "status.expiry.today"),
  labelled("week", "status.expiry.week"),
];

/** ISO time when a status with this expiry should disappear; null = never. */
export function expiryAt(choice: StatusExpiry, now = new Date()): string | null {
  const at = new Date(now);
  switch (choice) {
    case "never":
      return null;
    case "30m":
      at.setMinutes(at.getMinutes() + 30);
      break;
    case "1h":
      at.setHours(at.getHours() + 1);
      break;
    case "4h":
      at.setHours(at.getHours() + 4);
      break;
    case "today":
      at.setHours(23, 59, 59, 0);
      break;
    case "week": {
      const toSunday = (7 - at.getDay()) % 7;
      at.setDate(at.getDate() + toSunday);
      at.setHours(23, 59, 59, 0);
      break;
    }
  }
  return at.toISOString();
}

/** "まで 15:30" / "まで 9月30日" for the status editor. */
export function expiryLabel(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return null;
  const sameDay = at.toDateString() === new Date().toDateString();
  return sameDay ? t("status.until", { when: `${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}` }) : t("status.until", { when: at.toLocaleDateString(intlLocale(), { month: "long", day: "numeric" }) });
}
