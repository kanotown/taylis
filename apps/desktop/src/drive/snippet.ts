/**
 * The drive search's matches inside files (docs/DRIVE.md §29): the server cuts the text around the first word found and
 * marks the words (`snippet`, pieces with `hit`), says what matched (`match`) and the PDF page (`page`). Nothing here
 * parses HTML: the pieces are plain text.
 */
import type { DriveSearchHitOut } from "../api/types";

export type SnippetPiece = { text: string; hit: boolean };

/** The marked pieces of a match inside the file, or null (a name match, an older server). */
export function snippetPieces(hit: Pick<DriveSearchHitOut, "snippet">): SnippetPiece[] | null {
  const pieces = hit.snippet;
  if (!pieces || pieces.length === 0) return null;
  return pieces.map((piece) => ({ text: piece.text, hit: !!piece.hit }));
}

/** Whether the text inside the file matched (not only its name). */
export function matchedInside(hit: Pick<DriveSearchHitOut, "match">): boolean {
  return hit.match === "content" || hit.match === "both";
}

/** The page to open the document viewer at (a match inside a PDF or an Office file's preview), else null. */
export function openPage(hit: Pick<DriveSearchHitOut, "match" | "page"> | null | undefined): number | null {
  if (!hit || !matchedInside(hit)) return null;
  return typeof hit.page === "number" && hit.page > 1 ? hit.page : null;
}
