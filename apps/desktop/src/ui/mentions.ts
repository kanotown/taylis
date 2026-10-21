/**
 * The composer shows `@username`; the wire format is `<@uuid>` / `<!channel>` (DATA_MODEL.md).
 * Encoding happens on send, decoding when a message is opened for editing.
 */
import type { AiStatusOut } from "../api/ai";
import type { GroupOut, UserPublic } from "../api/types";
import { t } from "../i18n";

export interface MentionCandidate {
  username: string;
  label: string;
  /** M12k: a group's members are notified; "all" is @channel / @here. */
  kind?: "user" | "group" | "all";
  /** M65: an AI bot (shown with the 「AI」 badge; mentioning it asks it to answer in the thread). */
  ai?: boolean;
}

// After anything but an ASCII handle character, @ or <: 「まとめます。@kano」 is a mention, a@b.jp and <@uuid> are not.
const HANDLE = /(^|[^A-Za-z0-9._@<-])@([A-Za-z0-9._-]+)/g;
const USER_TOKEN = /<@([0-9a-f-]{36})>/g;
const ALL_TOKEN = /<!(channel|here)>/g;
const GROUP_TOKEN = /<@group:([0-9a-f-]{36})>/g;
const QUERY = /(^|[^A-Za-z0-9._@<-])@([\p{L}\p{M}\p{N}._-]*)$/u;

export function encodeMentions(text: string, users: Iterable<UserPublic>, groups: Iterable<GroupOut> = []): string {
  const byName = new Map<string, string>();
  for (const user of users) byName.set(user.username.toLowerCase(), `<@${user.id}>`);
  for (const group of groups) byName.set(group.name.toLowerCase(), `<@group:${group.id}>`); // names never collide (server)
  return text.replace(HANDLE, (whole: string, lead: string, name: string) => {
    const lower = name.toLowerCase();
    if (lower === "channel" || lower === "here") return `${lead}<!${lower}>`;
    const token = byName.get(lower);
    return token ? `${lead}${token}` : whole;
  });
}

export function decodeMentions(text: string, users: Map<string, UserPublic>, groups: ReadonlyMap<string, GroupOut> = new Map()): string {
  return text
    .replace(USER_TOKEN, (whole: string, id: string) => {
      const user = users.get(id);
      return user ? `@${user.username}` : whole;
    })
    .replace(GROUP_TOKEN, (whole: string, id: string) => {
      const group = groups.get(id);
      return group ? `@${group.name}` : whole;
    })
    .replace(ALL_TOKEN, "@$1");
}

/** Mention tokens as display names, for notifications and previews (`@Toru Kano`, `@channel`). */
export function mentionsToNames(text: string, users: ReadonlyMap<string, UserPublic>, groups: ReadonlyMap<string, GroupOut> = new Map()): string {
  return text
    .replace(USER_TOKEN, (whole: string, id: string) => {
      const user = users.get(id);
      return user ? `@${user.display_name}` : `@${t("mentions.member")}`;
    })
    .replace(GROUP_TOKEN, (whole: string, id: string) => `@${groups.get(id)?.name ?? t("composer.group")}`)
    .replace(ALL_TOKEN, "@$1");
}

/** The `@prefix` being typed just before the caret, or null. */
export function mentionQuery(text: string, caret: number): { start: number; query: string } | null {
  const before = text.slice(0, Math.max(caret, 0));
  const match = QUERY.exec(before);
  if (!match) return null;
  const query = match[2] ?? "";
  return { start: before.length - query.length - 1, query };
}

/**
 * Who the @ list offers (docs/AI.md §2.1, 2026-10-06): people (not bots, not deactivated) and the AI bots, never the other
 * bots (webhooks, feeds, reservations, imported ones: they do not answer). An AI bot is `bot_kind` "ai"; once
 * /ai/status was read (`aiBotIds` not null), only its agents' bots (a stopped or deleted agent's bot drops out, and a
 * server before `bot_kind` still offers its agents' bots).
 */
export function mentionable(user: UserPublic, aiBotIds: ReadonlySet<string> | null): boolean {
  if (user.deactivated_at) return false;
  if (user.role !== "bot") return true;
  return aiBotIds ? aiBotIds.has(user.id) : user.bot_kind === "ai";
}

/** The AI agents' bot users once /ai/status was read, else null (`bot_kind` decides then). */
export function aiBotIds(store: { aiStatus: AiStatusOut | null }): ReadonlySet<string> | null {
  return store.aiStatus ? new Set(store.aiStatus.agents.map((agent) => agent.bot_user_id)) : null;
}

/** How many of the newest messages of a thread and of the channel count as recent (apps/shared/mention-rank.json). */
export const RECENT_MESSAGES = 50;

/** What a message tells `recentSpeakers` (MessageState and MessageOut both fit). */
export interface SpokenMessage {
  sender_id: string;
  deleted?: boolean;
  type?: string;
}

/**
 * Who spoke recently here, newest first, each once (MOBILE_UI.md §23, apps/shared/mention-rank.json `recent`): the
 * thread's senders (its parent and replies, oldest first as given) before the channel's (the loaded timeline). Deleted
 * and system messages do not count; only the newest `cap` counting messages of each list.
 */
export function recentSpeakers(channel: readonly SpokenMessage[], thread: readonly SpokenMessage[] = [], cap = RECENT_MESSAGES): string[] {
  const seen = new Set<string>();
  const speakers: string[] = [];
  for (const list of [thread, channel]) {
    const counted = list.filter((m) => !m.deleted && m.type !== "system").slice(-cap);
    for (let i = counted.length - 1; i >= 0; i--) {
      const id = counted[i]!.sender_id;
      if (!seen.has(id)) {
        seen.add(id);
        speakers.push(id);
      }
    }
  }
  return speakers;
}

/** Whom the @ list puts first (MOBILE_UI.md §23): what the client holds about the conversation being written in. */
export interface MentionContext {
  /** recentSpeakers of the conversation (a thread's first), newest first. */
  recent?: readonly string[];
  /** The conversation's members as known locally (a DM / group DM: its participants). */
  members?: readonly string[];
  /** My user id: offered last. */
  me?: string | null;
}

/** What `conversationContext` reads from the store. */
interface ConversationSource {
  me: { id: string } | null;
  channels: ReadonlyMap<string, { dm_user_ids?: string[] | null }>;
  messages(channelId: string): readonly SpokenMessage[];
  replies(channelId: string, parentId: string): readonly SpokenMessage[];
  message(channelId: string, id: string): SpokenMessage | undefined;
  /** A channel's members once read (sync/channelMembers.ts); absent in stand-ins. */
  channelMembers?: { ids(channelId: string): readonly string[] | undefined };
}

/**
 * The composer's context (MOBILE_UI.md §23): the loaded messages' senders (in a thread, its own first) and the members:
 * a DM's or group DM's participants, a channel's as read for the @ list (requestChannelMembers; none until they come).
 */
export function conversationContext(store: ConversationSource, channelId: string, parentId: string | null = null): MentionContext {
  const parent = parentId ? store.message(channelId, parentId) : undefined;
  const thread = parentId ? [...(parent ? [parent] : []), ...store.replies(channelId, parentId)] : [];
  return { recent: recentSpeakers(store.messages(channelId), thread), ...documentContext(store, channelId) };
}

/** A canvas (MOBILE_UI.md §23): no conversation, only the members of its channel or DM (and me last). */
export function documentContext(store: Pick<ConversationSource, "me" | "channels" | "channelMembers">, channelId: string | null | undefined): MentionContext {
  const channel = channelId ? store.channels.get(channelId) : undefined;
  const members = channel?.dm_user_ids ?? (channelId ? store.channelMembers?.ids(channelId) : undefined) ?? [];
  return { members, me: store.me?.id ?? null };
}

const collator = new Intl.Collator("ja");

/**
 * `aiBotIds` (M65): the bot users of the AI agents (GET /ai/status), marked `ai`; null while it was not read. People
 * are ranked by `context` (MOBILE_UI.md §23): a prefix match first, then recent speakers, members, everybody else and
 * me, then by display name; the groups and @channel / @here follow as before.
 */
export function mentionCandidates(
  query: string,
  users: UserPublic[],
  groups: GroupOut[] = [],
  limit = 8,
  aiBotIds: ReadonlySet<string> | null = null,
  context: MentionContext = {},
): MentionCandidate[] {
  const q = query.toLowerCase();
  const recent = new Map<string, number>();
  for (const id of context.recent ?? []) if (!recent.has(id)) recent.set(id, recent.size);
  const members = new Set(context.members ?? []);
  const me = context.me ?? null;
  const tier = (id: string) => (id === me ? 3 : recent.has(id) ? 0 : members.has(id) ? 1 : 2);
  const match = (u: UserPublic) => (q && !u.username.toLowerCase().startsWith(q) && !u.display_name.toLowerCase().startsWith(q) ? 1 : 0);
  const people: MentionCandidate[] = users
    .filter((u) => mentionable(u, aiBotIds))
    .filter((u) => u.username.toLowerCase().startsWith(q) || u.display_name.toLowerCase().includes(q))
    .map((u) => ({ user: u, match: match(u), tier: tier(u.id), recent: recent.get(u.id) ?? 0 }))
    .sort(
      (a, b) =>
        a.match - b.match ||
        a.tier - b.tier ||
        (a.tier === 0 ? a.recent - b.recent : 0) ||
        collator.compare(a.user.display_name, b.user.display_name) ||
        (a.user.username < b.user.username ? -1 : a.user.username > b.user.username ? 1 : 0),
    )
    .map(({ user: u }) => ({ username: u.username, label: u.display_name, kind: "user", ...(u.role === "bot" ? { ai: true } : {}) }));
  const teams: MentionCandidate[] = groups
    .filter((g) => g.name.toLowerCase().startsWith(q) || (g.description ?? "").toLowerCase().includes(q))
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((g) => ({ username: g.name, label: `${t("composer.group")} · ${t("common.people", { count: g.member_ids.length })}${g.description ? ` · ${g.description}` : ""}`, kind: "group" }));
  const special: MentionCandidate[] = [
    { username: "channel", label: t("mentions.everyone"), kind: "all" as const },
    { username: "here", label: t("mentions.everyone"), kind: "all" as const },
  ].filter((c) => c.username.startsWith(q));
  return [...people, ...teams, ...special].slice(0, limit);
}
