import type { TextEmojiColor } from "../api/types";
import { TEXT_EMOJI_COLORS } from "./textEmoji";

/**
 * A section's letter badge (M114, docs/DATA_MODEL.md sidebar_sections): `letter:<text>:<colour>`, the text one or two
 * ASCII letters / digits or one Japanese character (kana, kanji, 々), the colour a text emoji palette key. The server
 * checks the same rule; apps/shared/section-icons.json holds the cases every client passes.
 */
export const LETTER_ICON_PREFIX = "letter:";
const LETTER_TEXT = /^(?:[A-Za-z0-9]{1,2}|[々ぁ-ゟ゠-ヿ㐀-䶿一-鿿])$/;

export interface LetterIcon {
  text: string;
  color: TextEmojiColor;
}

export function isLetterText(text: string): boolean {
  return LETTER_TEXT.test(text);
}

/** The badge an icon is, or null (an emoji or a custom emoji `:name:`, drawn as before). */
export function parseLetterIcon(icon: string | null | undefined): LetterIcon | null {
  if (!icon?.startsWith(LETTER_ICON_PREFIX)) return null;
  const parts = icon.slice(LETTER_ICON_PREFIX.length).split(":");
  const [text, color] = parts;
  if (parts.length !== 2 || text === undefined || color === undefined) return null;
  if (!isLetterText(text) || !Object.hasOwn(TEXT_EMOJI_COLORS, color)) return null;
  return { text, color: color as TextEmojiColor };
}

/** What the picker's input holds, made ready: full-width letters and half-width kana become their usual form. */
export function normalizeLetterInput(text: string): string {
  return text.normalize("NFKC").replace(/\s+/g, "");
}

export function letterIcon(text: string, color: TextEmojiColor): string {
  return `${LETTER_ICON_PREFIX}${text}:${color}`;
}
