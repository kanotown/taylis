/**
 * The composer shows `@username`; the wire format is `<@uuid>` / `<!channel>` (DATA_MODEL.md).
 * Encoding happens on send, decoding when a message is opened for editing.
 */
import type { UserPublic } from "../api/types";

export interface MentionCandidate {
  username: string;
  label: string;
}

const HANDLE = /(^|[\s(])@([A-Za-z0-9._-]+)/g;
const USER_TOKEN = /<@([0-9a-f-]{36})>/g;
const ALL_TOKEN = /<!(channel|here)>/g;
const QUERY = /(^|[\s(])@([A-Za-z0-9._-]*)$/;

export function encodeMentions(text: string, users: Iterable<UserPublic>): string {
  const byName = new Map<string, string>();
  for (const user of users) byName.set(user.username.toLowerCase(), user.id);
  return text.replace(HANDLE, (whole: string, lead: string, name: string) => {
    const lower = name.toLowerCase();
    if (lower === "channel" || lower === "here") return `${lead}<!${lower}>`;
    const id = byName.get(lower);
    return id ? `${lead}<@${id}>` : whole;
  });
}

export function decodeMentions(text: string, users: Map<string, UserPublic>): string {
  return text
    .replace(USER_TOKEN, (whole: string, id: string) => {
      const user = users.get(id);
      return user ? `@${user.username}` : whole;
    })
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

export function mentionCandidates(query: string, users: UserPublic[], limit = 6): MentionCandidate[] {
  const q = query.toLowerCase();
  const people = users
    .filter((u) => !u.deactivated_at)
    .filter((u) => u.username.toLowerCase().startsWith(q) || u.display_name.toLowerCase().includes(q))
    .sort((a, b) => a.username.localeCompare(b.username))
    .map((u) => ({ username: u.username, label: u.display_name }));
  const special = [
    { username: "channel", label: "全員に通知" },
    { username: "here", label: "全員に通知" },
  ].filter((c) => c.username.startsWith(q));
  return [...people, ...special].slice(0, limit);
}
