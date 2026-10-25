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

/** What `page` counts (§29.6): a PDF page, a slide or a sheet. An older server sends no `page_kind`: its pages are PDF pages. */
export type PageKind = "page" | "slide" | "sheet";

export function pageKind(hit: Pick<DriveSearchHitOut, "page_kind">): PageKind {
  return hit.page_kind === "slide" || hit.page_kind === "sheet" ? hit.page_kind : "page";
}

/** The label after 「中身」: 「3 ページ目」, 「12 枚目」 or 「シート 2」 (the i18n key and the number), else null. */
export function pageLabel(
  hit: Pick<DriveSearchHitOut, "page" | "page_kind">,
): { key: "search.drive.page" | "search.drive.slide" | "search.drive.sheet"; page: number } | null {
  if (typeof hit.page !== "number") return null;
  const kind = pageKind(hit);
  return { key: kind === "slide" ? "search.drive.slide" : kind === "sheet" ? "search.drive.sheet" : "search.drive.page", page: hit.page };
}

/**
 * The page to open the document viewer at (a match inside a PDF or an Office file's preview), else null. A slide or a sheet
 * (a file read from its package, §29.6) is not a page of the preview, which may not even exist: the viewer opens at its start.
 */
export function openPage(hit: Pick<DriveSearchHitOut, "match" | "page" | "page_kind"> | null | undefined): number | null {
  if (!hit || !matchedInside(hit) || pageKind(hit) !== "page") return null;
  return typeof hit.page === "number" && hit.page > 1 ? hit.page : null;
}
