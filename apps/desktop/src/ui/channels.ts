/** Sidebar rules shared by the list, the quick switcher and keyboard navigation. */
import type { ChannelState } from "../sync/types";

export function isDmChannel(channel: ChannelState): boolean {
  return channel.type === "dm" || channel.type === "group_dm";
}

/** Level "none" or an active timed mute. */
export function isMutedChannel(channel: ChannelState, now: Date = new Date()): boolean {
  if (channel.notificationLevel === "none") return true;
  if (!channel.mutedUntil) return false;
  const until = new Date(channel.mutedUntil).getTime();
  return !Number.isNaN(until) && until > now.getTime();
}

/** Slack / Mattermost rule: a muted channel only counts as unread when I am mentioned. */
export function hasUnread(channel: ChannelState, now?: Date): boolean {
  if (!channel.isMember) return false;
  return isMutedChannel(channel, now) ? channel.mentionCount > 0 : channel.unreadCount > 0;
}

/** Badge number: mentions for channels and muted conversations, every message for DMs. */
export function badgeCount(channel: ChannelState, now?: Date): number {
  if (isMutedChannel(channel, now)) return channel.mentionCount;
  return isDmChannel(channel) ? channel.unreadCount : channel.mentionCount;
}

export interface ChannelSections {
  /** Starred conversations (M12a); left out of `channels` / `dms`. */
  favorites: ChannelState[];
  channels: ChannelState[];
  dms: ChannelState[];
  browse: ChannelState[];
}

/** The sidebar order: channels by name, DMs by recency, joinable public channels by name. */
export function sectionChannels(
  all: ChannelState[],
  title: (channel: ChannelState) => string,
  options: { unreadOnly?: boolean; currentId?: string | null; now?: Date; favorites?: ReadonlySet<string> } = {},
): ChannelSections {
  const byTitle = (a: ChannelState, b: ChannelState) => title(a).localeCompare(title(b), "ja");
  const keep = (channel: ChannelState) => !options.unreadOnly || channel.id === options.currentId || hasUnread(channel, options.now);
  const starred = (channel: ChannelState) => options.favorites?.has(channel.id) ?? false;
  return {
    favorites: all
      .filter((c) => c.isMember && !c.archived && starred(c) && keep(c))
      .sort(byTitle),
    channels: all
      .filter((c) => c.isMember && !isDmChannel(c) && !c.archived && !starred(c) && keep(c))
      .sort(byTitle),
    dms: all
      .filter((c) => c.isMember && isDmChannel(c) && !starred(c) && keep(c))
      .sort((a, b) => (b.last_message_at ?? "").localeCompare(a.last_message_at ?? "")),
    browse: options.unreadOnly ? [] : all.filter((c) => !c.isMember && c.type === "public" && !c.archived).sort(byTitle),
  };
}

/** Alt+↑/↓ walks this order; Alt+Shift+↑/↓ walks only unread conversations. Wraps around. */
export function stepChannel(
  order: ChannelState[],
  currentId: string | null,
  delta: 1 | -1,
  options: { unreadOnly?: boolean; now?: Date } = {},
): ChannelState | undefined {
  if (order.length === 0) return undefined;
  const index = order.findIndex((c) => c.id === currentId);
  for (let step = 1; step <= order.length; step++) {
    const candidate = order[(index + delta * step + order.length * step) % order.length];
    if (!candidate || candidate.id === currentId) continue;
    if (!options.unreadOnly || hasUnread(candidate, options.now)) return candidate;
  }
  return undefined;
}
