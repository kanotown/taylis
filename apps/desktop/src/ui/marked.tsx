import type { ReactNode } from "react";

import { highlightPieces } from "./highlight";

/**
 * `text` with the search's words marked (highlight.ts: the keywords PGroonga matched), as a result's title and excerpt
 * show them (the search page's Docs and Canvas tabs, the Docs sidebar's box).
 */
export function marked(text: string, keywords: string[]): ReactNode[] {
  return highlightPieces(text, keywords).map((piece, i) => (piece.hit ? <mark key={i} className="rounded bg-warning/35 px-0.5 text-ink">{piece.text}</mark> : <span key={i}>{piece.text}</span>));
}
