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
export function mentionsToNames(text: string, users: Map<string, UserPublic>, groups: ReadonlyMap<string, GroupOut> = new Map()): string {
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

/** `aiBotIds` (M65): the bot users of the AI agents (GET /ai/status), marked `ai`; null while it was not read. */
export function mentionCandidates(query: string, users: UserPublic[], groups: GroupOut[] = [], limit = 6, aiBotIds: ReadonlySet<string> | null = null): MentionCandidate[] {
  const q = query.toLowerCase();
  const people: MentionCandidate[] = users
    .filter((u) => mentionable(u, aiBotIds))
    .filter((u) => u.username.toLowerCase().startsWith(q) || u.display_name.toLowerCase().includes(q))
    .sort((a, b) => a.username.localeCompare(b.username))
    .map((u) => ({ username: u.username, label: u.display_name, kind: "user", ...(u.role === "bot" ? { ai: true } : {}) }));
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
