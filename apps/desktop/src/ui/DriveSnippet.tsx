/**
 * A drive search hit's text from inside the file (docs/DRIVE.md §29): 「中身 · 3 ページ目」 (「12 枚目」 for a slide, §29.6) and the words around the match,
 * the found words marked as in the message search. Nothing for a name match.
 */
import type { DriveSearchHitOut } from "../api/types";
import { pageLabel, snippetPieces } from "../drive/snippet";
import { cn } from "./primitives";
import { t } from "../i18n";

export function DriveSnippet({ hit, className }: { hit: Pick<DriveSearchHitOut, "snippet" | "page" | "page_kind" | "match">; className?: string }) {
  const pieces = snippetPieces(hit);
  const label = pageLabel(hit);
  if (!pieces) return null;
  return (
    <span className={cn("line-clamp-2 text-[12px] leading-snug text-ink/80", className)} data-drive-snippet="">
      <span className="mr-1.5 text-[11px] font-medium text-muted">
        {t("search.drive.inside")}
        {label ? ` · ${t(label.key, { page: label.page })}` : ""}
      </span>
      {pieces.map((piece, i) => (piece.hit ? <mark key={i} className="rounded bg-warning/35 px-0.5 text-ink">{piece.text}</mark> : <span key={i}>{piece.text}</span>))}
    </span>
  );
}
