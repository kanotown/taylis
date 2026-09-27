/** Notification keywords (M12g): where they occur in a text run, case-insensitively. */

export type KeywordPiece = string | { hit: string };

function escape(word: string): string {
  return word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function splitKeywords(text: string, keywords: readonly string[]): KeywordPiece[] {
  const words = keywords.map((k) => k.trim()).filter(Boolean);
  if (words.length === 0 || !text) return [text];
  const pattern = new RegExp(words.map(escape).sort((a, b) => b.length - a.length).join("|"), "gi");
  const pieces: KeywordPiece[] = [];
  let last = 0;
  for (const match of text.matchAll(pattern)) {
    const start = match.index ?? 0;
    if (start > last) pieces.push(text.slice(last, start));
    pieces.push({ hit: match[0] });
    last = start + match[0].length;
  }
  if (last < text.length) pieces.push(text.slice(last));
  return pieces.length > 0 ? pieces : [text];
}
