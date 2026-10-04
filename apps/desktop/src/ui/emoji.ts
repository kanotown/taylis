import { EMOJI, EMOJI_CATEGORIES, type EmojiEntry } from "./emojiData";

export { EMOJI, EMOJI_CATEGORIES };
export type { EmojiEntry };

const BY_SHORTCODE = new Map(EMOJI.map((e) => [e.shortcode, e]));
const SHORTCODE = /:([a-z0-9_+\-]{1,30}):/g;
/**
 * ":ta" before the caret, at a word start; the query needs at least 2 characters. M100: or a Japanese word (":ありがとう",
 * "：了解"): one character is enough, it finds custom emoji by label / keyword and standard ones by their keywords.
 */
const QUERY_TAIL = /(^|[\s(（「])[:：]([a-z0-9_+\-]{2,30}|[^\s:：\x00-\x7f][^\s:：]{0,19})$/u;

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
  const folded = foldSearch(q);
  const rest = EMOJI.filter((e) => !e.shortcode.startsWith(q) && (e.shortcode.includes(q) || e.keywords.toLowerCase().includes(q) || (folded !== q && foldSearch(e.keywords).includes(folded))));
  return [...prefix, ...rest].slice(0, limit);
}

/** Folds for matching (M100): lower case, NFKC (全角 → 半角), katakana as hiragana (「アリガトウ」 finds 「ありがとう」). */
export function foldSearch(text: string): string {
  return text.normalize("NFKC").toLowerCase().replace(/[\u30a1-\u30f6]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0x60));
}

/** What a custom emoji is found by: its name, and (M100) its label and keywords. */
export type CustomEmojiSearchable = { name: string; label?: string | null; keywords?: string[] };

/**
 * Custom emoji (M12f) for a query, as picker-style entries (`glyph` is `:name:`): names starting with it first, then
 * names containing it, then (M100) labels and keywords starting with / containing it (e.g. "ありがとう" → :hpd-bow:
 * whose keywords have 「ありがとう」).
 */
export function customEmojiCandidates(query: string, custom: ReadonlyMap<string, CustomEmojiSearchable>, limit = 4): EmojiEntry[] {
  const q = foldSearch(query.trim());
  if (!q) return [];
  const rank = (emoji: CustomEmojiSearchable): number => {
    if (emoji.name.startsWith(q)) return 0;
    if (emoji.name.includes(q)) return 1;
    const words = [emoji.label ?? "", ...(emoji.keywords ?? [])].filter(Boolean).map(foldSearch);
    if (words.some((w) => w.startsWith(q))) return 2;
    if (words.some((w) => w.includes(q))) return 3;
    return -1;
  };
  const ranked: Array<[number, CustomEmojiSearchable]> = [];
  for (const emoji of custom.values()) {
    const r = rank(emoji);
    if (r >= 0) ranked.push([r, emoji]);
  }
  ranked.sort((a, b) => a[0] - b[0] || a[1].name.localeCompare(b[1].name));
  return ranked.slice(0, limit).map(([, e]) => ({ shortcode: e.name, glyph: `:${e.name}:`, category: "custom", keywords: [e.label ?? "", ...(e.keywords ?? [])].join(" ") }));
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
