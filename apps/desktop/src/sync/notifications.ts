/**
 * Notification level and mute of a conversation (PUSH_NOTIFICATIONS.md §4, SYNC_PROTOCOL.md §10.5, M35). Pure rules
 * shared by the unread rules and the lists (ui/channels.ts re-exports them) and by the engine's desktop notifications.
 */
import type { ChannelState } from "./types";

export type NotifyLevel = "all" | "mentions" | "none";

/** The overall setting when the server did not say (a `me` written by an older server): the server's initial value. */
export const DEFAULT_OVERALL_LEVEL: NotifyLevel = "mentions";

/** My overall setting (「通知」 in the settings), from `me`. */
export function overallLevel(me: { notification_default?: NotifyLevel | null } | null | undefined): NotifyLevel {
  return me?.notification_default ?? DEFAULT_OVERALL_LEVEL;
}

/** Only the timed mute (「8 時間ミュート」, /mute) is running. */
export function isTimedMuted(channel: Pick<ChannelState, "mutedUntil">, now: Date = new Date()): boolean {
  if (!channel.mutedUntil) return false;
  const until = new Date(channel.mutedUntil).getTime();
  return !Number.isNaN(until) && until > now.getTime();
}

/**
 * Muted (SYNC_PROTOCOL.md §10.5): the conversation's own level "none", muted until unmuted (M35) or an active timed mute.
 * The overall setting never counts: it affects notifications only, never the unread rules.
 */
export function isMutedChannel(channel: Pick<ChannelState, "notificationLevel" | "muted" | "mutedUntil">, now: Date = new Date()): boolean {
  if (channel.notificationLevel === "none" || channel.muted) return true;
  return isTimedMuted(channel, now);
}

/**
 * What a conversation notifies me of (the table in PUSH_NOTIFICATIONS.md §4): its own level if it has one; else nothing
 * when the overall setting is "none", every message of a DM or group DM, mentions in someone else's times (M24), and
 * the overall setting in any other channel. Muting is separate (isMutedChannel).
 */
export function resolveNotificationLevel(own: NotifyLevel | null, overall: NotifyLevel, kind: { dm: boolean; othersTimes: boolean }): NotifyLevel {
  if (own) return own;
  if (overall === "none") return "none";
  if (kind.dm) return "all";
  if (kind.othersTimes) return "mentions";
  return overall;
}

/** resolveNotificationLevel for one of my conversations. */
export function effectiveNotificationLevel(
  channel: Pick<ChannelState, "type" | "times_owner_id" | "notificationLevel">,
  meId: string | null,
  overall: NotifyLevel,
): NotifyLevel {
  return resolveNotificationLevel(channel.notificationLevel, overall, {
    dm: channel.type === "dm" || channel.type === "group_dm",
    othersTimes: !!channel.times_owner_id && channel.times_owner_id !== meId,
  });
}

/**
 * A preference as the server sends it (bootstrap, the PUT's response, notification_preference.updated) turned into the
 * conversation's own values: `level` there is resolved, so the own level is null while it follows the default. Older
 * servers send neither flag: following the default, not muted.
 */
export function ownNotification(pref: {
  level: NotifyLevel;
  muted_until?: string | null;
  follows_default?: boolean | null;
  muted?: boolean | null;
}): Pick<ChannelState, "notificationLevel" | "mutedUntil" | "muted"> {
  return {
    notificationLevel: (pref.follows_default ?? true) ? null : pref.level,
    mutedUntil: pref.muted_until ?? null,
    muted: pref.muted ?? false,
  };
}
