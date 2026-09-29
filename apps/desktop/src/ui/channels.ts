/** Sidebar rules shared by the list, the quick switcher and keyboard navigation. */
import type { ChannelState, SidebarSectionOut, UserPublic } from "../sync/types";

export function isDmChannel(channel: ChannelState): boolean {
  return channel.type === "dm" || channel.type === "group_dm";
}

/** A conversation's name: `#name` for channels, the other members for DMs (also the notification title). */
export function conversationTitle(channel: ChannelState, users: ReadonlyMap<string, UserPublic>, meId: string | null): string {
  if (channel.type === "public" || channel.type === "private") return `#${channel.name ?? ""}`;
  const others = (channel.dm_user_ids ?? []).filter((id) => id !== meId);
  if (others.length === 0) return "自分へのメモ";
  return others.map((id) => users.get(id)?.display_name ?? "…").join(", ");
}

/** M15a: whether I may start top-level posts here; thread replies stay open to every member. */
export function canPostTopLevel(channel: ChannelState, isAdmin: boolean): boolean {
  return channel.posting_policy !== "owners" || isAdmin || channel.membership?.role === "owner";
}

/**
 * M15b / L4 (M31): private → public shows the whole history to everyone, so only an admin who is a member of the channel
 * may (SECURITY.md; the server says 403 admin_not_member otherwise).
 */
export function canMakePublic(channel: ChannelState, isAdmin: boolean): boolean {
  return channel.type === "private" && isAdmin && channel.isMember;
}

/** Level "none" or an active timed mute. */
export function isMutedChannel(channel: ChannelState, now: Date = new Date()): boolean {
  if (channel.notificationLevel === "none") return true;
  if (!channel.mutedUntil) return false;
  const until = new Date(channel.mutedUntil).getTime();
  return !Number.isNaN(until) && until > now.getTime();
}

/**
 * M24: someone else's times that I have not set to level "all" is quiet unread: unread only with a mention, a faint dot
 * otherwise (SYNC_PROTOCOL.md §10.5; the vectors in apps/shared/unread-rules.json).
 */
export function isQuietChannel(channel: ChannelState, meId: string | null, now?: Date): boolean {
  return !!channel.times_owner_id && channel.times_owner_id !== meId && channel.notificationLevel !== "all" && !isMutedChannel(channel, now);
}

/** Slack / Mattermost rule: a muted channel only counts as unread when I am mentioned; so does a quiet one (M24). */
export function hasUnread(channel: ChannelState, meId: string | null, now?: Date): boolean {
  if (!channel.isMember) return false;
  return isMutedChannel(channel, now) || isQuietChannel(channel, meId, now) ? channel.mentionCount > 0 : channel.unreadCount > 0;
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
  /** M24: times channels I am in, mine first; left out of `channels`. */
  times: ChannelState[];
  dms: ChannelState[];
  browse: ChannelState[];
}

/** The sidebar order: channels by name, DMs by recency, joinable public channels by name. */
export function sectionChannels(
  all: ChannelState[],
  title: (channel: ChannelState) => string,
  options: { unreadOnly?: boolean; currentId?: string | null; now?: Date; favorites?: ReadonlySet<string>; sections?: readonly SidebarSectionOut[]; meId?: string | null } = {},
): ChannelSections {
  const meId = options.meId ?? null;
  const byTitle = (a: ChannelState, b: ChannelState) => title(a).localeCompare(title(b), "ja");
  const byRecency = (a: ChannelState, b: ChannelState) => (b.last_message_at ?? "").localeCompare(a.last_message_at ?? "");
  const keep = (channel: ChannelState) => !options.unreadOnly || channel.id === options.currentId || hasUnread(channel, meId, options.now);
  const isTimes = (channel: ChannelState) => !!channel.times_owner_id;
  const mineFirst = (a: ChannelState, b: ChannelState) => Number(b.times_owner_id === meId) - Number(a.times_owner_id === meId) || byTitle(a, b);
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
    channels: all.filter((c) => visible(c) && !isDmChannel(c) && !isTimes(c) && loose(c)).sort(byTitle),
    times: all.filter((c) => visible(c) && isTimes(c) && loose(c)).sort(mineFirst),
    dms: all.filter((c) => c.isMember && isDmChannel(c) && keep(c) && loose(c)).sort(byRecency),
    browse: options.unreadOnly ? [] : all.filter((c) => !c.isMember && c.type === "public" && !c.archived).sort(byTitle),
  };
}

/** Alt+↑/↓ walks this order; Alt+Shift+↑/↓ walks only unread conversations. Wraps around. */
export function stepChannel(
  order: ChannelState[],
  currentId: string | null,
  delta: 1 | -1,
  options: { unreadOnly?: boolean; now?: Date; meId?: string | null } = {},
): ChannelState | undefined {
  if (order.length === 0) return undefined;
  const index = order.findIndex((c) => c.id === currentId);
  for (let step = 1; step <= order.length; step++) {
    const candidate = order[(index + delta * step + order.length * step) % order.length];
    if (!candidate || candidate.id === currentId) continue;
    if (!options.unreadOnly || hasUnread(candidate, options.meId ?? null, options.now)) return candidate;
  }
  return undefined;
}
