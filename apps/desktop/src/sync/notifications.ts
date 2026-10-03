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
 * servers send neither flag: their `level` is then the conversation's own (as the rules took it before M35: a level
 * "none" stays muted), not muted until unmuted.
 */
export function ownNotification(pref: {
  level: NotifyLevel;
  muted_until?: string | null;
  follows_default?: boolean | null;
  muted?: boolean | null;
}): Pick<ChannelState, "notificationLevel" | "mutedUntil" | "muted"> {
  return {
    notificationLevel: (pref.follows_default ?? false) ? null : pref.level,
    mutedUntil: pref.muted_until ?? null,
    muted: pref.muted ?? false,
  };
}

/** How a message sits in its conversation for the notification rule: top-level, a reply only in its thread, or both. */
export type ReplyKind = "none" | "thread_only" | "also_in_channel";

/** One new message (not mine) as the notification rule sees it (apps/shared/notify-rules.json). */
export interface NotifyCase {
  /** The conversation's resolved level (effectiveNotificationLevel). */
  level: NotifyLevel;
  /** Muted until unmuted, a timed mute running, or its own level "none" (isMutedChannel). */
  muted?: boolean;
  reply: ReplyKind;
  /** I am in the reply's parent_thread.participant_ids (the thread's followers). */
  follower: boolean;
  /** I unfollowed the thread by hand: a reply only in it never notifies me, not even a mention. */
  unfollowed: boolean;
  /** My id is in mentioned_user_ids (by name or group). */
  mentioned: boolean;
  /** @channel / @here. */
  mentionAll: boolean;
  /** One of my notify_keywords is in the body. */
  keyword: boolean;
  /** The message's type: "system" (M88's join / leave lines) never notifies. Absent = "user". */
  type?: string | null;
}

/**
 * Whether a new message notifies me (PUSH_NOTIFICATIONS.md §4, the server's PushPlanner handle + select_recipients),
 * before the checks each side does on its own (DND, read already, looking at it now). A reply only in its thread is
 * for its followers and the people it mentions, at level "all" too; one I unfollowed by hand stays silent.
 */
export function notifies(c: NotifyCase): boolean {
  if ((c.type ?? "user") !== "user") return false; // M88 (docs/MEMBERSHIP.md §1)
  if (c.level === "none" || c.muted) return false;
  if (c.reply === "thread_only" && c.unfollowed) return false;
  // A follower of the thread counts as involved for any reply (the server's participants).
  const involved = c.mentionAll || c.mentioned || c.keyword || (c.reply !== "none" && c.follower);
  if (c.level === "mentions" && !involved) return false;
  if (c.reply === "thread_only" && !involved) return false;
  return true;
}
