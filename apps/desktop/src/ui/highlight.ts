/** Client-side keyword highlighting: the server returns the keywords PGroonga matched. */
export type HighlightPiece = { text: string; hit: boolean };

/** Sorted, non-overlapping [start, end) ranges of every case-insensitive keyword occurrence. */
export function keywordRanges(text: string, keywords: string[]): Array<[number, number]> {
  const lower = text.toLowerCase();
  const found: Array<[number, number]> = [];
  for (const keyword of keywords.map((k) => k.toLowerCase()).filter((k) => k.length > 0).sort((a, b) => b.length - a.length)) {
    let index = lower.indexOf(keyword);
    while (index >= 0) {
      found.push([index, index + keyword.length]);
      index = lower.indexOf(keyword, index + keyword.length);
    }
  }
  found.sort((a, b) => a[0] - b[0]);
  const merged: Array<[number, number]> = [];
  for (const range of found) {
    const last = merged[merged.length - 1];
    if (last && range[0] <= last[1]) {
      if (range[1] > last[1]) last[1] = range[1];
    } else merged.push([range[0], range[1]]);
  }
  return merged;
}

export function highlightPieces(text: string, keywords: string[]): HighlightPiece[] {
  const pieces: HighlightPiece[] = [];
  let cursor = 0;
  for (const [start, end] of keywordRanges(text, keywords)) {
    if (start > cursor) pieces.push({ text: text.slice(cursor, start), hit: false });
    pieces.push({ text: text.slice(start, end), hit: true });
    cursor = end;
  }
  if (cursor < text.length) pieces.push({ text: text.slice(cursor), hit: false });
  return pieces;
}
