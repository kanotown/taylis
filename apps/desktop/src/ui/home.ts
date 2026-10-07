/**
 * M37 (MOBILE_UI.md §6.1, §6.2): the phone's home — its sections (with 「未読をまとめる」 and the short DM section), what
 * 「移動・検索」 and the new-message picker list, and the recent conversations this device keeps. Pure rules; the screens
 * are HomeView, JumpView and NewMessageView.
 */
import type { ChannelState, SidebarDefaultOut, SidebarSectionOut, UserPublic } from "../sync/types";
import { hasUnread, isDmChannel, isSelfNotes, sectionChannels } from "./channels";
import { type JumpItem, rankItems } from "./jumpMatch";

type NamedUser = Pick<UserPublic, "display_name" | "username">;

// --- names -------------------------------------------------------------------------------------

/**
 * What a conversation is found by: a channel by its name; a DM by the other members' display names and usernames; my own
 * DM by my display name and username.
 */
export function conversationNames(channel: ChannelState, users: ReadonlyMap<string, NamedUser>, meId: string | null, me?: NamedUser | null): string[] {
  if (!isDmChannel(channel)) return [channel.name ?? ""];
  const others = (channel.dm_user_ids ?? []).filter((id) => id !== meId);
  const people = others.length > 0 ? others.map((id) => users.get(id)) : [(meId ? users.get(meId) : undefined) ?? me ?? undefined];
  const names: string[] = [];
  for (const user of people) {
    if (!user) continue;
    if (user.display_name) names.push(user.display_name);
    if (user.username) names.push(user.username);
  }
  return names;
}

export interface JumpContext {
  users: ReadonlyMap<string, UserPublic>;
  meId: string | null;
  me?: NamedUser | null;
  /** The row's title (as the lists show it, without a channel's #). */
  title: (channel: ChannelState) => string;
  now?: Date;
}

/** A conversation as a jump-match item. */
export function conversationItem(channel: ChannelState, context: JumpContext): JumpItem & { channel: ChannelState } {
  return {
    id: channel.id,
    title: context.title(channel),
    names: conversationNames(channel, context.users, context.meId, context.me),
    unread: hasUnread(channel, context.meId, context.now),
    channel,
  };
}

export const JUMP_CONVERSATION_LIMIT = 20;
export const JUMP_PEOPLE_LIMIT = 10;

/** 「会話」 while typing: the conversations I am in, not archived, by the jump-match rule; at most 20. */
export function jumpConversations(query: string, channels: Iterable<ChannelState>, context: JumpContext, limit = JUMP_CONVERSATION_LIMIT): ChannelState[] {
  const items = [...channels].filter((c) => c.isMember && !c.archived).map((c) => conversationItem(c, context));
  return rankItems(query, items).slice(0, limit).map((item) => item.channel);
}

/** People ranked by the jump-match rule (display name and username). */
function rankPeople(query: string, users: UserPublic[]): UserPublic[] {
  const items = users.map((user) => ({ id: user.id, title: user.display_name || user.username, names: [user.display_name, user.username].filter(Boolean), user }));
  return rankItems(query, items).map((item) => item.user);
}

/** Who a new DM can go to, in two groups: the people, then 「ボット」. */
export interface DmCandidates {
  people: UserPublic[];
  /** AI bots only (they answer in a DM); other bots are never offered. */
  bots: UserPublic[];
}

/**
 * Who a new DM can go to (apps/shared/jump-match.json `pick`): not deactivated; a bot (role "bot": a webhook, a feed, the
 * reservation bot, …) only when it is an AI bot (`aiBotIds`, GET /ai/status), and then in its own group after the
 * people. Each group by the rule with a query, by name without. An existing DM with any bot stays in the DM lists.
 */
export function dmCandidates(query: string, users: Iterable<UserPublic>, aiBotIds: ReadonlySet<string> = new Set()): DmCandidates {
  const live = [...users].filter((u) => !u.deactivated_at);
  const order = (list: UserPublic[]) => (query.trim() ? rankPeople(query, list) : list.sort((a, b) => a.display_name.localeCompare(b.display_name, "ja")));
  return { people: order(live.filter((u) => u.role !== "bot")), bots: order(live.filter((u) => u.role === "bot" && aiBotIds.has(u.id))) };
}

/** 「人」 (and 「ボット」) while typing: as `dmCandidates` (me too: my own DM), each group at most 10. */
export function jumpPeople(query: string, users: Iterable<UserPublic>, limit = JUMP_PEOPLE_LIMIT, aiBotIds: ReadonlySet<string> = new Set()): DmCandidates {
  if (!query.trim()) return { people: [], bots: [] };
  const { people, bots } = dmCandidates(query, users, aiBotIds);
  return { people: people.slice(0, limit), bots: bots.slice(0, limit) };
}

// --- the new-message picker (§6.1 ✏️) ---------------------------------------------------------

/**
 * The picker's channels: the ones I am in first, then the public ones I can join (not archived, no DMs). An empty query
 * lists them by title; a query by the jump-match rule within each group.
 */
export function pickerChannels(query: string, channels: Iterable<ChannelState>, context: JumpContext): { mine: ChannelState[]; joinable: ChannelState[] } {
  const all = [...channels].filter((c) => !c.archived && !isDmChannel(c));
  const order = (list: ChannelState[]) => {
    if (query.trim()) return rankItems(query, list.map((c) => conversationItem(c, context))).map((item) => item.channel);
    return list.sort((a, b) => context.title(a).localeCompare(context.title(b), "ja"));
  };
  return { mine: order(all.filter((c) => c.isMember)), joinable: order(all.filter((c) => !c.isMember && c.type === "public")) };
}

/** The picker's people and AI bots (not me: my own DM is its own row), by the rule, or by name without a query. */
export function pickerPeople(query: string, users: Iterable<UserPublic>, meId: string | null, aiBotIds: ReadonlySet<string> = new Set()): DmCandidates {
  return dmCandidates(query, [...users].filter((u) => u.id !== meId), aiBotIds);
}

// --- the home sections (§6.1) -----------------------------------------------------------------

export const HOME_DM_LIMIT = 5;

export interface HomeSections {
  /** 「未読」: only with 「未読をまとめる」 on; every unread conversation (DMs too), taken out of its own section. */
  unread: ChannelState[];
  favorites: ChannelState[];
  custom: Array<{ section: SidebarSectionOut; channels: ChannelState[] }>;
  channels: ChannelState[];
  times: ChannelState[];
  /**
   * Pinned DMs (M118) and my own DM first, then the first 5 others in the section's sort (and any other unread one); the
   * rest are on the DM tab.
   */
  dms: ChannelState[];
  /** More DMs than the section shows: it ends with 「すべての DM」. */
  moreDms: boolean;
}

export function homeSections(
  all: ChannelState[],
  options: {
    gatherUnread?: boolean;
    favorites?: ReadonlySet<string>;
    sections?: readonly SidebarSectionOut[];
    defaults?: readonly SidebarDefaultOut[];
    meId?: string | null;
    now?: Date;
    title?: (channel: ChannelState) => string;
    /** M118: my pinned DMs, oldest pin first. */
    dmPins?: readonly string[] | null;
    /** M141: the DMs I closed (hidden). */
    closedDms?: ReadonlySet<string> | null;
  } = {},
): HomeSections {
  const meId = options.meId ?? null;
  const base = sectionChannels(all, { favorites: options.favorites, sections: options.sections, defaults: options.defaults, meId, now: options.now, title: options.title, dmPins: options.dmPins, closedDms: options.closedDms });
  const unread: ChannelState[] = [];
  const pick = (list: ChannelState[]) => {
    if (!options.gatherUnread) return list;
    return list.filter((c) => {
      if (!hasUnread(c, meId, options.now)) return true;
      unread.push(c);
      return false;
    });
  };
  const favorites = pick(base.favorites);
  const custom = base.custom.map(({ section, channels }) => ({ section, channels: pick(channels) }));
  const channels = pick(base.channels);
  const times = pick(base.times);
  const allDms = pick(base.dms);
  // M118: every pinned DM stays (they are the ones I keep at hand); the limit counts the others.
  const pinned = new Set(options.dmPins ?? []);
  const kept = allDms.filter((c) => pinned.has(c.id) || isSelfNotes(c, meId));
  const others = allDms.filter((c) => !kept.includes(c));
  const dms = [...kept, ...others.filter((c, index) => index < HOME_DM_LIMIT || hasUnread(c, meId, options.now))];
  // Newest first, as on iOS and Android (M37): the conversation that just moved is on top.
  unread.sort((a, b) => (b.last_message_at ?? "").localeCompare(a.last_message_at ?? ""));
  return { unread, favorites, custom, channels, times, dms, moreDms: others.length > HOME_DM_LIMIT };
}

// --- per-device settings and the recent conversations ------------------------------------------

export const GATHER_UNREAD_KEY = "chikuwa.home.gatherUnread";

/** 「未読をまとめる」 on this device (off unless turned on). */
export function readGatherUnread(): boolean {
  try {
    return localStorage.getItem(GATHER_UNREAD_KEY) === "1";
  } catch {
    return false;
  }
}

export function writeGatherUnread(on: boolean): void {
  try {
    localStorage.setItem(GATHER_UNREAD_KEY, on ? "1" : "0");
  } catch {
    /* a per-device convenience: it holds for this session */
  }
}

export const RECENT_CONVERSATIONS_LIMIT = 10;

/** The recent conversations of one account on this device (the workspace's; the server is not asked). */
export function recentConversationsKey(account: string): string {
  return `chikuwa.jump.recent:${account}`;
}

export function readRecentConversations(key: string): string[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(key) ?? "[]");
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string").slice(0, RECENT_CONVERSATIONS_LIMIT) : [];
  } catch {
    return [];
  }
}

/** A conversation was opened: it goes first, once; at most 10 are kept. Returns the new list. */
export function pushRecentConversation(key: string, channelId: string): string[] {
  const next = [channelId, ...readRecentConversations(key).filter((id) => id !== channelId)].slice(0, RECENT_CONVERSATIONS_LIMIT);
  try {
    localStorage.setItem(key, JSON.stringify(next));
  } catch {
    /* the list is a convenience */
  }
  return next;
}
