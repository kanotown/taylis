/** Sidebar rules shared by the list, the quick switcher and keyboard navigation. */
import type { ChannelState, SidebarSectionOut } from "../sync/types";

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

/** What the app icon shows (M13f): the badge numbers of every conversation I am in, added up. */
export function unreadBadgeTotal(channels: Iterable<ChannelState>, now?: Date): number {
  let total = 0;
  for (const channel of channels) if (channel.isMember && !channel.archived) total += badgeCount(channel, now);
  return total;
}

export interface ChannelSections {
  /** Starred conversations (M12a); left out of every other section. */
  favorites: ChannelState[];
  /** My own sections (M14f), in order; their conversations are left out of `channels` / `dms`. */
  custom: Array<{ section: SidebarSectionOut; channels: ChannelState[] }>;
  channels: ChannelState[];
  dms: ChannelState[];
  browse: ChannelState[];
}

/** The sidebar order: channels by name, DMs by recency, joinable public channels by name. */
export function sectionChannels(
  all: ChannelState[],
  title: (channel: ChannelState) => string,
  options: { unreadOnly?: boolean; currentId?: string | null; now?: Date; favorites?: ReadonlySet<string>; sections?: readonly SidebarSectionOut[] } = {},
): ChannelSections {
  const byTitle = (a: ChannelState, b: ChannelState) => title(a).localeCompare(title(b), "ja");
  const byRecency = (a: ChannelState, b: ChannelState) => (b.last_message_at ?? "").localeCompare(a.last_message_at ?? "");
  const keep = (channel: ChannelState) => !options.unreadOnly || channel.id === options.currentId || hasUnread(channel, options.now);
  const starred = (channel: ChannelState) => options.favorites?.has(channel.id) ?? false;
  const placed = new Map<string, string>();
  for (const section of options.sections ?? []) for (const id of section.channel_ids) placed.set(id, section.id);
  const loose = (channel: ChannelState) => !starred(channel) && !placed.has(channel.id);
  const visible = (channel: ChannelState) => channel.isMember && !channel.archived && keep(channel);
  return {
    favorites: all.filter((c) => visible(c) && starred(c)).sort(byTitle),
    custom: (options.sections ?? []).map((section) => {
      const members = all.filter((c) => visible(c) && !starred(c) && placed.get(c.id) === section.id);
      return { section, channels: [...members.filter((c) => !isDmChannel(c)).sort(byTitle), ...members.filter(isDmChannel).sort(byRecency)] };
    }),
    channels: all.filter((c) => visible(c) && !isDmChannel(c) && loose(c)).sort(byTitle),
    dms: all.filter((c) => c.isMember && isDmChannel(c) && keep(c) && loose(c)).sort(byRecency),
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
