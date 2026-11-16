/**
 * The `@` and `:` completions of a text being written (M11f, M12k, MOBILE_UI.md §23 and §30), one set of rules for the
 * composer and the inline edit box (M187): what is typed before the caret is read for an `@name` (people, groups,
 * @channel / @here) or else a `:name` (the workspace's emoji first, then the standard ones, 8 in all), and a pick puts
 * its text in place of what was typed, the text after the caret left as it was. The hook and the list are in
 * CompletionList.tsx.
 */
import { customEmojiCandidates, type CustomEmojiSearchable, emojiCandidates, type EmojiEntry, emojiQuery } from "./emoji";
import { mentionQuery } from "./mentions";

/** The text the lists read: a line (or the whole text) up to the caret; `after` is what follows the caret, when known. */
export interface Typed {
  text: string;
  caret: number;
  after?: string;
}

/** Where a query starts (its `@` or `:`) and what follows it. */
export interface CompletionQuery {
  start: number;
  query: string;
}

/** How many rows a list offers. */
export const COMPLETION_LIMIT = 8;

/** The `@` query before the caret, else the `:` one (an emoji is never offered while a mention is typed). */
export function completionQueries(typed: Typed | null): { mention: CompletionQuery | null; emoji: CompletionQuery | null } {
  const mention = typed ? mentionQuery(typed.text, typed.caret) : null;
  const emoji = mention || !typed ? null : emojiQuery(typed.text, typed.caret);
  return { mention, emoji };
}

/**
 * What the open list is for: Esc closes the list for what is typed now, and typing on shows it again. `other` names the
 * owner's own list when neither is typed (the composer's `/` commands).
 */
export function completionKey(queries: { mention: CompletionQuery | null; emoji: CompletionQuery | null }, other = ""): string {
  if (queries.mention) return `@${queries.mention.start}:${queries.mention.query}`;
  if (queries.emoji) return `:${queries.emoji.start}:${queries.emoji.query}`;
  return other;
}

/** The emoji a `:query` offers: the workspace's (by name, label or keyword) before the standard ones, `limit` in all. */
export function emojiCompletions(query: string, custom: ReadonlyMap<string, CustomEmojiSearchable>, limit = COMPLETION_LIMIT): EmojiEntry[] {
  return [...customEmojiCandidates(query, custom), ...emojiCandidates(query)].slice(0, limit);
}

/** What a pick puts in place of the query: `@username ` for a person or group, the emoji and a space for an emoji. */
export const mentionInsert = (username: string): string => `@${username} `;
export const emojiInsert = (glyph: string): string => `${glyph} `;

/**
 * How many characters after the caret a pick replaces as well. With `reuseSpace` (the edit box, MOBILE_UI.md §30: no
 * second space) a space right after the caret is taken as the space the pick ends with, so the text has one space there
 * and the caret goes after it, past the completed word (left before the space, the list would read the word again and
 * open). The composer keeps adding its space.
 */
export function takenAfter(insert: string, after: string, reuseSpace: boolean): number {
  return reuseSpace && insert.endsWith(" ") && after.startsWith(" ") ? 1 : 0;
}

/** The query at `start`..`caret` replaced with `insert`, the rest of the text kept; the caret goes after the insert. */
export function completeAt(text: string, start: number, caret: number, insert: string, reuseSpace = false): { text: string; caret: number } {
  const taken = takenAfter(insert, text.slice(caret), reuseSpace);
  return { text: text.slice(0, start) + insert + text.slice(caret + taken), caret: start + insert.length };
}

/** The row an arrow key moves to in a list of `length` rows (wrapping round), or null for any other key. */
export function moveActive(key: string, active: number, length: number): number | null {
  if (length <= 0) return null;
  if (key === "ArrowDown") return (active + 1) % length;
  if (key === "ArrowUp") return (active - 1 + length) % length;
  return null;
}
