/**
 * The composer shows `@username`; the wire format is `<@uuid>` / `<!channel>` (DATA_MODEL.md).
 * Encoding happens on send, decoding when a message is opened for editing.
 */
import type { GroupOut, UserPublic } from "../api/types";

export interface MentionCandidate {
  username: string;
  label: string;
  /** M12k: a group's members are notified; "all" is @channel / @here. */
  kind?: "user" | "group" | "all";
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
      return user ? `@${user.display_name}` : "@メンバー";
    })
    .replace(GROUP_TOKEN, (whole: string, id: string) => `@${groups.get(id)?.name ?? "グループ"}`)
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

export function mentionCandidates(query: string, users: UserPublic[], groups: GroupOut[] = [], limit = 6): MentionCandidate[] {
  const q = query.toLowerCase();
  const people: MentionCandidate[] = users
    .filter((u) => !u.deactivated_at)
    .filter((u) => u.username.toLowerCase().startsWith(q) || u.display_name.toLowerCase().includes(q))
    .sort((a, b) => a.username.localeCompare(b.username))
    .map((u) => ({ username: u.username, label: u.display_name, kind: "user" }));
  const teams: MentionCandidate[] = groups
    .filter((g) => g.name.toLowerCase().startsWith(q) || (g.description ?? "").toLowerCase().includes(q))
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((g) => ({ username: g.name, label: `グループ · ${g.member_ids.length} 人${g.description ? ` · ${g.description}` : ""}`, kind: "group" }));
  const special: MentionCandidate[] = [
    { username: "channel", label: "全員に通知", kind: "all" as const },
    { username: "here", label: "全員に通知", kind: "all" as const },
  ].filter((c) => c.username.startsWith(q));
  return [...people, ...teams, ...special].slice(0, limit);
}
