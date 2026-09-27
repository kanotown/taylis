import { EMOJI, EMOJI_CATEGORIES, type EmojiEntry } from "./emojiData";

export { EMOJI, EMOJI_CATEGORIES };
export type { EmojiEntry };

const BY_SHORTCODE = new Map(EMOJI.map((e) => [e.shortcode, e]));
const SHORTCODE = /:([a-z0-9_+\-]{1,30}):/g;
/** ":ta" before the caret, at a word start; the query needs at least 2 characters. */
const QUERY_TAIL = /(^|[\s(（「])[:：]([a-z0-9_+\-]{2,30})$/;

/** The emoji for a `:shortcode:` (without colons), if it is in the table. */
export function emojiByShortcode(shortcode: string): EmojiEntry | undefined {
  return BY_SHORTCODE.get(shortcode);
}

/** `:tada:` → 🎉 wherever the shortcode is known; unknown ones stay as typed (M11f). */
export function replaceShortcodes(text: string): string {
  if (!text.includes(":")) return text;
  return text.replace(SHORTCODE, (match, code: string) => BY_SHORTCODE.get(code)?.glyph ?? match);
}

/** The `:query` being typed before the caret, like mentionQuery for "@". */
export function emojiQuery(text: string, caret: number): { start: number; query: string } | null {
  const head = text.slice(0, caret);
  const match = QUERY_TAIL.exec(head);
  if (!match) return null;
  return { start: caret - match[2]!.length - 1, query: match[2]!.toLowerCase() };
}

/** Matches by shortcode prefix first, then by keyword / shortcode substring. */
export function emojiCandidates(query: string, limit = 8): EmojiEntry[] {
  const q = query.toLowerCase();
  if (!q) return [];
  const prefix = EMOJI.filter((e) => e.shortcode.startsWith(q));
  const rest = EMOJI.filter((e) => !e.shortcode.startsWith(q) && (e.shortcode.includes(q) || e.keywords.toLowerCase().includes(q)));
  return [...prefix, ...rest].slice(0, limit);
}

/** Custom emoji (M12f) whose name starts with / contains the query, as picker-style entries (`glyph` is `:name:`). */
export function customEmojiCandidates(query: string, custom: ReadonlyMap<string, { name: string }>, limit = 4): EmojiEntry[] {
  const q = query.toLowerCase();
  if (!q) return [];
  const names = [...custom.keys()];
  const hits = [...names.filter((n) => n.startsWith(q)), ...names.filter((n) => !n.startsWith(q) && n.includes(q))];
  return hits.slice(0, limit).map((name) => ({ shortcode: name, glyph: `:${name}:`, category: "custom", keywords: name }));
}

/** Free-text search for the picker: empty query lists everything (by category order). */
export function searchEmoji(query: string): EmojiEntry[] {
  const q = query.trim().toLowerCase();
  if (!q) return EMOJI;
  return emojiCandidates(q, EMOJI.length);
}

/** Replace the `:query` at `start`..`caret` with the glyph and a space; returns the new text and caret. */
export function completeEmoji(text: string, start: number, caret: number, glyph: string): { text: string; caret: number } {
  const next = text.slice(0, start) + glyph + " " + text.slice(caret);
  return { text: next, caret: start + glyph.length + 1 };
}
